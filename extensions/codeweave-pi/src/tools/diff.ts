import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative as relativePath } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { harnessEnvelope, nativeToolResult, referenceTokenCount, stripPrivateEvidence } from "../core/harness-result.ts";
import { nativeLocationLeads, nativeRecords } from "../core/pi-nav-evidence.ts";
import { callIndexedGraphNavigation, callPiNav, validateRankedCorpus, type NativeOutput, type PiNavCaller } from "../core/pi-nav-native.ts";
import { resolvePath } from "../core/path-resolve.ts";
import { canonicalProjectPath, detectProjectRoot } from "../core/project-root.ts";
import { requireNonNegative, requirePositive } from "../core/param-guards.ts";
import { firstChangedLine, renderSimpleDiff } from "../core/diff-renderer.ts";
import { splitLogicalLines } from "../core/text-normalize.ts";
import { S } from "../core/schema.ts";
import { renderDiffCall, renderDiffResult } from "../core/tui-render.ts";
import {
  envelopeForLeads,
  indexedGraphEvidence,
  rejectObsoleteNavigationParams,
  resultText,
  selectAuthorityLeads,
  trimText,
} from "../core/navigation-clean.ts";
import { asToolCallValidationError, boundedInvalidToolCallResult, ToolCallValidationError } from "../core/tool-call-contract.ts";
import { prepareExactLeads } from "../core/source-authority.ts";

const execFileAsync = promisify(execFile);
const VIEWS = new Set(["summary", "patch", "structure", "impact", "review"]);
const DEFAULT_BUDGET = 20_000;

function diffReplyFits(text: string, budget: number, ceiling = 8_000): boolean {
  return text.length <= budget && referenceTokenCount(text) <= ceiling;
}

type DiffView = "summary" | "patch" | "structure" | "impact" | "review";

interface ChangedLineRange { path: string; start: number; end: number }
interface ChangedSymbolEvidence { path: string; name: string; start: number; end: number; change: string; currentSource: boolean }
interface FilePair { aPath: string; bPath: string; aText?: string; bText?: string; aDigest?: string; bDigest?: string; identical: boolean; binary: boolean; aBytes: number; bBytes: number }
interface GitRun { stdout: string; stderr: string; ok: boolean; unknownSource: boolean }

interface PreparedComponent { ok: boolean; incomplete?: boolean; text: string; native?: any; diagnostics: string[]; renderImpact?: (limit: number) => PreparedComponent }
export const diffParams = S.object({
  root: S.string("Where the repo (or relative a/b files) live. Defaults to the working directory; never changes it."),
  source: S.string("What to compare against: omit/'uncommitted' = unstaged tracked changes, 'staged' = index-only, anything else = a git ref/range. Untracked files listed but excluded."),
  scope: S.string("Narrow to one repo-relative file or folder; deleted paths accepted."),
  a: S.string("First existing file for direct comparison, resolved relative to root. Requires b; direct impact/review is unsupported."),
  b: S.string("Second existing file for direct comparison, resolved relative to root. Requires a; direct impact/review is unsupported."),
  view: S.string("review (paired changes + supported context; repository default) · summary (changed files) · patch (exact text) · structure (changed symbols) · impact (planning). Direct a/b defaults to summary; impact/review are unsupported there."),
  search: S.string("Review/default and structure: case-insensitive substring selection of changed units. Review searches before/after names, paths and changed text; it is not a separate query language."),
  expand: S.number("Context lines — a/b summary/patch only."),
  budget: S.number("Approximate character cap on the output. Truncation is marked and means incomplete — narrow scope, don't trust a partial view."),
 }, []);

export function registerDiffTool(pi: ExtensionAPI, options: { callNative?: PiNavCaller } = {}): void {
  const callNative = options.callNative ?? callPiNav;
  pi.registerTool({
    name: "diff",
    label: "diff",
    renderShell: "self",
    description: "See what changed — git diff without leaving the session, plus a side-by-side file compare. It never changes files. Call it to see what you or anyone changed. Example: diff({view:'summary', source:'uncommitted'}).",
    promptGuidelines: ["Repository default/review shows paired changes before available explanatory context. Use explicit summary for a file inventory, patch for exact Git text, structure for symbols, or impact for planning. Missing graph evidence must not erase the change. Direct a/b retains its summary default."],
    parameters: diffParams,
    renderCall: renderDiffCall,
    renderResult: renderDiffResult,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      let view: DiffView;
      let root: string;
      let scope: string | undefined;
      let budget: number;
      try {
        rejectObsoleteNavigationParams("diff", params, ["root", "source", "scope", "a", "b", "view", "search", "expand", "budget"]);
        view = normalizeView(params.view ?? (params.a || params.b ? "summary" : "review"));
        root = resolvePath(ctx.cwd, params.root ?? ".");
        scope = params.scope;
        budget = params.budget ?? DEFAULT_BUDGET;
        requirePositive("diff budget", budget);
        requireNonNegative("diff expand", params.expand ?? 0);
        if (!Number.isSafeInteger(params.expand ?? 0)) throw new ToolCallValidationError("diff expand must be a safe integer count of context lines.", { received: params.expand });
        if (params.search !== undefined && (typeof params.search !== "string" || !["structure", "review"].includes(view))) throw new ToolCallValidationError("diff search is a string for structure or repository review/default only.", { received: params.search });
        if (Boolean(params.a) !== Boolean(params.b)) throw new ToolCallValidationError("diff direct comparison requires both a and b.", { received: { a: params.a, b: params.b } });
        if (params.expand !== undefined && !(params.a && params.b && (view === "patch" || view === "summary"))) throw new ToolCallValidationError("diff expand applies only to direct a/b summary or patch comparison.", { received: params.expand });
        if (params.a && (view === "impact" || view === "review")) throw new ToolCallValidationError(`diff ${view} does not support direct a/b comparison.`, { received: { a: params.a, b: params.b } });
      } catch (error) {
        return boundedInvalidToolCallResult("diff", asToolCallValidationError(error, { accepted: ["{search:'symbol'}", "{view:'summary', source:'uncommitted'}", "{view:'structure', search:'symbol'}", "{a:'before', b:'after', view:'patch'}"], received: params }));
      }

      if (params.a && params.b) {
        const pair = await resolveFilePair(root, params.a, params.b);
        if (!pair.ok) return pair.result;
        if (pair.identical) return resultText(`${view === "summary" ? "Read-only file comparison summary" : "Read-only file comparison patch"}.\nNo changes.`);
        if (pair.binary) {
          const text = `Binary files differ: ${JSON.stringify(pair.aPath)} (${pair.aBytes} bytes) ↔ ${JSON.stringify(pair.bPath)} (${pair.bBytes} bytes). No textual patch was fabricated.`;
          return diffReplyFits(text, budget) ? resultText(text) : resultText("ERROR: binary comparison identity exceeds the reply allowance. No textual patch was fabricated.", harnessEnvelope({ status: "error", summary: "Binary comparison minimum receipt cannot fit.", next_actions: [], artifacts: [] }));
        }
        if (view === "structure") return runStructuralDiff({ root, source: params.source, scope, aPath: pair.aPath, bPath: pair.bPath, search: params.search, expand: params.expand, budget, signal, callNative });
        return renderFilePairDiff(pair, params.expand ?? 3, budget, view);
      }

      if (scope) {
        const scoped = canonicalProjectPath(resolvePath(root, scope));
        const rel = relativePath(root, scoped);
        if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
          root = detectProjectRoot(scoped).root;
          scope = relativePath(root, scoped) || ".";
        }
      }

      const repo = await resolveGitRepo(root);
      if (!repo.ok) return repo.result;
      const scopeCheck = await validateDiffScope(root, scope, params.source);
      if (!scopeCheck.ok) return scopeCheck.result;

      if (view === "patch") return runPatchDiff({ root, source: params.source, scope, budget });
      if (view === "structure") return runStructuralDiff({ root, source: params.source, scope, search: params.search, expand: params.expand, budget, signal, callNative });
      if (view === "impact" || view === "review") return runPlanningDiff({ view, root, source: params.source, scope, search: params.search, budget, signal, callNative });
      return runSummaryDiff({ root, source: params.source, scope, budget, signal, callNative });
    },
  });
}

function normalizeView(value: unknown): DiffView {
  const view = String(value ?? "summary").trim().toLowerCase();
  if (!VIEWS.has(view)) throw new Error(`diff view must be one of summary, patch, structure, impact, review; got ${JSON.stringify(value)}.`);
  return view as DiffView;
}


async function resolveFilePair(cwd: string, a: string, b: string): Promise<{ ok: true } & FilePair | { ok: false; result: any }> {
  const aPath = resolvePath(cwd, a);
  const bPath = resolvePath(cwd, b);
  const [aInfo, bInfo] = await Promise.all([stat(aPath).catch(() => undefined), stat(bPath).catch(() => undefined)]);
  if (!aInfo?.isFile() || !bInfo?.isFile()) {
    const missing = [!aInfo?.isFile() ? a : undefined, !bInfo?.isFile() ? b : undefined].filter(Boolean).map(value => trimText(value!, 200)).join(", ");
    const text = `ERROR: diff file-to-file path not found or not a file: ${missing}.\nRoot cause: diff({ a, b }) compares two existing files.\nSafe retry: choose two existing files, then retry diff with both a and b.\nStop condition: do not interpret this as a successful file comparison.`;
    return { ok: false, result: resultText(text) };
  }
  const [aBuffer, bBuffer] = await Promise.all([readFile(aPath), readFile(bPath)]);
  const identical = aBuffer.equals(bBuffer);
  if (identical) return { ok: true, aPath, bPath, identical: true, binary: false, aBytes: aBuffer.length, bBytes: bBuffer.length };
  if (aBuffer.includes(0) || bBuffer.includes(0)) {
    return { ok: true, aPath, bPath, identical: false, binary: true, aBytes: aBuffer.length, bBytes: bBuffer.length };
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return { ok: true, aPath, bPath, aText: decoder.decode(aBuffer), bText: decoder.decode(bBuffer), aDigest: createHash("sha256").update(aBuffer).digest("hex"), bDigest: createHash("sha256").update(bBuffer).digest("hex"), identical: false, binary: false, aBytes: aBuffer.length, bBytes: bBuffer.length };
  } catch {
    return { ok: true, aPath, bPath, identical: false, binary: true, aBytes: aBuffer.length, bBytes: bBuffer.length };
  }
}


function renderFilePairDiff(pair: FilePair, expand: number, budget: number, view: DiffView) {
  const header = view === "summary" ? "Read-only file comparison summary. No files were changed by this tool." : "Read-only file comparison patch. No files were changed by this tool.";
  let context = expand;
  for (let attempt = 0; attempt < 9; attempt++) {
    if (attempt === 8) context = 0;
    const notice = context < expand ? `\n[Output incomplete: comparison context reduced to ${context} line(s) to fit the complete reply.]` : "";
    const text = `${header}\n${renderSimpleDiff(pair.aText!, pair.bText!, context)}${notice}`;
    if (diffReplyFits(text, budget)) return resultText(text, notice ? harnessEnvelope({ status: "warning", summary: "Paired first-change source retained with reduced context.", next_actions: [], artifacts: [] }) : undefined);
    if (context === 0) break;
    context = Math.floor(context / 2);
  }
  // Even the changed line pair is too large. Keep the exact captured versions,
  // not a sliced line or a promise that a later read is the same comparison.
  const line = firstChangedLine(pair.aText!, pair.bText!) ?? 1;
  const sides = [
    { side: "A", path: pair.aPath, text: pair.aText!, digest: pair.aDigest },
    { side: "B", path: pair.bPath, text: pair.bText!, digest: pair.bDigest },
  ].map(side => `${side.side}: ${JSON.stringify(side.path)} · captured raw SHA-256 ${side.digest}\n${line <= splitLogicalLines(side.text).lines.length ? `read(${JSON.stringify({ path: `${side.path}:${line}-${line}` })})` : `Compared side ends before line ${line}; no source row exists there.`}`);
  const withheld = `${header}\nPaired source withheld: the first changed line pair cannot fit the 8,000-token ceiling and requested character allowance. No comparison source was delivered.\n${sides.join("\n")}\nRead handoffs inspect current files; verify the captured digests before treating them as these compared versions. A later changed file cannot recover the captured bytes.`;
  if (!diffReplyFits(withheld, budget)) return resultText("ERROR: direct Diff budget cannot hold comparison identity and required status. No source delivered; increase the character budget without exceeding the 8,000-token ceiling.", harnessEnvelope({ status: "error", summary: "Direct comparison minimum receipt cannot fit.", next_actions: [], artifacts: [] }));
  return resultText(withheld, harnessEnvelope({ status: "warning", summary: "Paired source withheld with exact compared-file identities.", next_actions: [], artifacts: [] }));
}

async function resolveGitRepo(root: string): Promise<{ ok: true; topLevel: string } | { ok: false; result: any }> {
  let stdout = "";
  // Invalid cwd can throw synchronously before execFile's custom promise exists.
  try { stdout = String((await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: root })).stdout); } catch { /* Returned below as an explicit failed lookup. */ }
  if (!stdout) {
    const text = `ERROR: no git repository found at ${trimText(root, 200)}.\nRoot cause: diff without a/b requires a Git repository root.\nSafe retry: set root to a git repo, set scope within that repo, or compare two files with diff({ a, b, view:"patch" }).\nStop condition: do not treat this as a repository diff until root resolves inside a Git checkout.`;
    return { ok: false, result: resultText(text) };
  }
  return { ok: true, topLevel: stdout.trim() };
}

async function validateDiffScope(root: string, scope?: string, source?: string): Promise<{ ok: true } | { ok: false; result: any }> {
  if (!scope) return { ok: true };
  const scoped = resolvePath(root, scope);
  if (await stat(scoped).catch(() => undefined)) return { ok: true };
  const changed = await runGitDiff(root, gitDiffArgs({ source, scope }, "name-only"), DEFAULT_BUDGET);
  if (changed.ok && changed.stdout.length > 0) return { ok: true };
  const text = `ERROR: diff scope not found: ${trimText(scope, 200)}.\nRoot cause: the path neither exists nor appears in the selected Git change set.\nSafe retry: choose an existing or changed path, remove scope, or set root/source to the intended repository.\nStop condition: do not interpret this as "No changes" for the requested path.`;
  return { ok: false, result: resultText(text) };
}

async function runPatchDiff(input: { root: string; source?: string; scope?: string; budget: number }) {
  // Only this raw-patch presentation requests full blob identities. Review's
  // independent comparison digest continues to use its original Git capture.
  const run = await runGitDiff(input.root, gitDiffArgs({ ...input, fullIndex: true }, "patch"), input.budget);
  if (!run.ok) return gitFailureResult(run, input.source);
  let untracked = await untrackedSummary(input.root, input.scope);
  const prefix = () => `Read-only ${sourceLabel(input.source)} patch${scopeLabel(input.scope)}. ${untracked}\n`;
  const fullText = prefix() + (run.stdout || "No changes.");
  if (diffReplyFits(fullText, input.budget)) return resultText(fullText);
  if (untracked.includes(": ")) {
    untracked = untracked.replace(/: [\s\S]*$/, ": names withheld for budget.");
    const reduced = prefix() + (run.stdout || "No changes.");
    if (diffReplyFits(reduced, input.budget)) return resultText(reduced, harnessEnvelope({ status: "warning", summary: "Complete captured patch retained; untracked filename detail withheld.", next_actions: [], artifacts: [] }));
  }
  const starts = [...run.stdout.matchAll(/^diff --(?:git|cc|combined) /gm)].map(match => match.index!);
  const blocks = starts[0] === 0 ? starts.map((start, index) => run.stdout.slice(start, starts[index + 1] ?? run.stdout.length)) : [];
  const partial = new Map<number, { header: string; hunks: string[]; selected: Set<number> }>();
  const receipt = (index: number) => {
    const lines = blocks[index].split("\n");
    const part = partial.get(index);
    const missingHunk = part ? part.hunks.find((_, hunk) => !part.selected.has(hunk))?.split("\n", 1)[0] : lines.find(line => line.startsWith("@@ "));
    return [lines[0], lines.find(line => line.startsWith("index ")), missingHunk].filter(Boolean).join("\n");
  };
  const shown = new Set<number>();
  let receiptLimit = Math.min(4, blocks.length);
  const compose = () => {
    const omitted = blocks.map((_, index) => index).filter(index => !shown.has(index) && (!partial.has(index) || partial.get(index)!.selected.size < partial.get(index)!.hunks.length));
    const source = blocks.flatMap((block, index) => {
      if (shown.has(index)) return [block];
      const part = partial.get(index);
      return part?.selected.size ? [part.header + part.hunks.filter((_, hunk) => part.selected.has(hunk)).join("")] : [];
    });
    return [prefix(), ...source,
      omitted.length ? `Patch incomplete: ${omitted.length} captured file patch(es) withheld in whole or part for the 8,000-token ceiling or character allowance. Displayed hunks are complete; this is not an exhaustive patch.` : blocks.length ? "All captured file patches displayed; ancillary filename detail withheld for budget." : "Patch source withheld; complete Git file boundaries unavailable.",
      ...(omitted.length ? ["Withheld file identities / captured Git blob IDs / first missing hunk locators (not patch source):", ...omitted.slice(0, receiptLimit).map(receipt), ...(omitted.length > receiptLimit ? [`${omitted.length - receiptLimit} additional file receipt(s) omitted; narrow scope.`] : [])] : []),
      ...(!blocks.length ? ["Complete Git file boundaries unavailable; no empty comparison is inferred."] : []),
      "Narrow scope, or use review/search for changed-unit selection within a file. This starts a new comparison. Index hashes identify full captured Git blobs, not raw SHA-256 or an applied subset; a working-tree after object may not exist in Git. Changed current bytes cannot recover a withheld version.",
    ].join("\n");
  };
  const fit = () => {
    let text = compose();
    while (!diffReplyFits(text, input.budget) && receiptLimit > 0) { receiptLimit--; text = compose(); }
    return diffReplyFits(text, input.budget);
  };
  if (!fit()) return resultText("ERROR: patch budget cannot hold comparison identity and omission/status evidence. No patch source delivered; increase the character budget within the 8,000-token ceiling.", harnessEnvelope({ status: "error", summary: "Patch minimum receipt cannot fit.", next_actions: [], artifacts: [] }));
  for (let index = 0; index < blocks.length; index++) {
    const previousLimit = receiptLimit;
    shown.add(index);
    if (fit()) continue;
    shown.delete(index); receiptLimit = previousLimit;
    // Reuse captured unified-hunk boundaries rather than treating a whole file
    // as indivisible. Other Git formats retain whole-record fitting above.
    const positions = [...blocks[index].matchAll(/^@@ /gm)].map(match => match.index!);
    if (positions.length < 2) continue;
    const part = { header: blocks[index].slice(0, positions[0]), hunks: positions.map((start, hunk) => blocks[index].slice(start, positions[hunk + 1] ?? blocks[index].length)), selected: new Set<number>() };
    partial.set(index, part);
    for (let hunk = 0; hunk < part.hunks.length; hunk++) {
      const previousHunkLimit = receiptLimit;
      part.selected.add(hunk);
      if (!fit()) { part.selected.delete(hunk); receiptLimit = previousHunkLimit; }
    }
    if (!part.selected.size) partial.delete(index);
  }
  return resultText(compose(), harnessEnvelope({ status: "warning", summary: "Complete captured patches/hunks retained with explicit omissions and version locators.", next_actions: [], artifacts: [] }));
}

async function runSummaryDiff(input: { root: string; source?: string; scope?: string; budget: number; signal?: AbortSignal; callNative: PiNavCaller }) {
  const run = await runGitDiff(input.root, gitDiffArgs(input, "name-status"), input.budget);
  if (!run.ok) return gitFailureResult(run, input.source);
  const changed = parseNameStatus(run.stdout);
  let untracked = await untrackedSummary(input.root, input.scope);
  const structural = changed.length ? await structuralDiffOutput(input, Math.min(input.budget, 8000)) : undefined;
  let showStructure = !!structural;
  let shown = Math.min(changed.length, 80);
  let withheldUntracked = false;
  const compose = () => [
    `Read-only ${sourceLabel(input.source)} summary${scopeLabel(input.scope)}.`, untracked, "",
    changed.length ? `Changed files (${changed.length})` : "No tracked changed files detected.",
    ...changed.slice(0, shown).map(item => `- ${item.status} ${item.path}`),
    ...(shown < changed.length ? [`... ${changed.length - shown} more changed file(s) omitted; narrow scope. The complete reply remains limited to 4,000 tokens.`] : []),
    ...(showStructure && structural ? ["", "Changed-symbol structure", structural.ok ? compactStructuralSummary(structural.output.structured) : structural.message]
      : structural ? [structural.ok ? "Changed-symbol detail withheld for budget; use view:'structure' with a narrower scope." : "Changed-symbol structure unavailable; diagnostic detail withheld for budget."] : []),
  ].join("\n");
  let text = compose();
  if (!diffReplyFits(text, input.budget, 4000) && showStructure) { showStructure = false; text = compose(); }
  if (!diffReplyFits(text, input.budget, 4000) && untracked.includes(": ")) {
    untracked = untracked.replace(/: [\s\S]*$/, ": names withheld for budget."); withheldUntracked = true; text = compose();
  }
  while (!diffReplyFits(text, input.budget, 4000) && shown > 0) { shown--; text = compose(); }
  if (!diffReplyFits(text, input.budget, 4000)) return resultText("ERROR: Diff summary budget cannot hold comparison identity and omission/status evidence. No inventory delivered; increase the character budget within the 4,000-token ceiling.", harnessEnvelope({ status: "error", summary: "Summary minimum receipt cannot fit.", next_actions: [], artifacts: [] }));
  const incomplete = shown < changed.length || withheldUntracked || !!structural && (!showStructure || !structural.ok || structural.output.structured.completeness?.complete === false);
  const envelope = harnessEnvelope({ status: incomplete ? "warning" : "success", summary: incomplete ? "Diff summary returned partial current-change evidence with visible omissions." : "Diff summary returned the current Git file inventory.", next_actions: [], artifacts: [], diagnostics: structural && !structural.ok && showStructure ? [structural.message] : [] });
  if (structural?.ok && showStructure) {
    const result = nativeToolResult(text, structural.output.structured, envelope);
    // Optional sidecar pressure cannot erase the independently captured Git list.
    if (result.content[0].text === text) return result;
    return resultText(text, harnessEnvelope({ status: "warning", summary: "Visible file inventory and structural summary retained; oversized native metadata withheld.", next_actions: [], artifacts: [] }));
  }
  return { content: [{ type: "text" as const, text }], details: { status: incomplete ? "partial" : "complete", envelope, diff: { exactFiles: changed.map(item => item.path), displayedFileCount: shown } } };
}

function compactStructuralSummary(structured: NativeOutput["structured"], limit = 12): string {
  const data = structured?.data as any;
  const symbols = Array.isArray(data?.symbols) ? data.symbols.filter((symbol: any) => symbol?.change !== "unchanged") : [];
  if (!symbols.length) return "No changed symbols returned by the structural diff.";
  const shown = symbols.slice(0, limit);
  const lines = shown.map((symbol: any) => {
    const location = symbol?.location ?? {};
    const range = `${location.path ?? "?"}:${location.start ?? "?"}-${location.end ?? location.start ?? "?"}`;
    return `- ${String(symbol?.change ?? "changed").replaceAll("_", " ")} · ${range} · ${symbol?.name ?? location.label ?? "symbol"}`;
  });
  if (symbols.length > shown.length) lines.push(`... ${symbols.length - shown.length} more changed symbol(s); use view:'structure' for the bounded structural detail.`);
  return lines.join("\n");
}

async function runStructuralDiff(input: { root: string; source?: string; scope?: string; aPath?: string; bPath?: string; search?: string; expand?: number; budget: number; signal?: AbortSignal; callNative: PiNavCaller }) {
  const structural = await structuralDiffOutput(input, input.budget);
  if (!structural.ok) return resultText(structural.message);
  const leads = nativeLocationLeads(structural.output.structured).slice(0, 12);
  const authorityLeads = selectAuthorityLeads(leads, 12);
  const proof = authorityLeads.length
    ? await prepareExactLeads({ cwd: input.root, nativeText: structural.output.text, leads: authorityLeads, signal: input.signal, callNative: input.callNative })
    : undefined;
  const text = proof?.text ?? structural.output.text;
  const incomplete = structural.output.structured.completeness?.complete === false;
  const result = nativeToolResult(
    text,
    structural.output.structured,
    incomplete
      ? harnessEnvelope({ status: "warning", summary: "Structural diff returned partial evidence with explicit omissions.", next_actions: [], artifacts: [], diagnostics: structural.output.structured.diagnostics })
      : envelopeForLeads("Structural diff returned changed-symbol evidence.", leads),
  );
  // Transport refusal also enters the locator fallback, without tokenizing the
  // rejected payload or granting authority to its undelivered proof rows.
  if (result.content[0].text !== text || !diffReplyFits(text, input.budget)) {
    const nativeOnly = `${structural.output.text}\nCurrent-source handoff withheld for output limits; no edit authority granted.${incomplete ? " Native comparison is incomplete." : ""}`;
    const nativeReceipt = nativeToolResult(nativeOnly, { ...structural.output.structured, data: {}, diagnostics: [] }, result.details.envelope);
    if (nativeReceipt.content[0].text === nativeOnly && diffReplyFits(nativeOnly, input.budget)) return resultText(nativeOnly, harnessEnvelope({ status: "warning", summary: "Captured comparison retained without the withheld current-source handoff or metadata.", next_actions: [], artifacts: [] }));
    const data = structural.output.structured.data as any;
    const files: string[] | undefined = Array.isArray(data?.files) ? data.files.flatMap((file: any) => typeof file?.path === "string" ? [file.path] : []) : undefined;
    const identity = input.aPath && input.bPath ? `A ${JSON.stringify(input.aPath)} ↔ B ${JSON.stringify(input.bPath)}` : sourceLabel(input.source);
    let limit = 12;
    const compose = () => [
      `Read-only structural comparison: ${identity}${scopeLabel(input.scope)}.`,
      "Comparison source withheld for output limits. No source authority granted.",
      ...(files ? [`Changed files reported (${files.length}): ${formatList(files, limit)}`] : ["Changed-file inventory unavailable; no zero change set is inferred."]),
      "Changed-symbol locators, not displayed comparison source:", compactStructuralSummary(structural.output.structured, limit),
      "Use a narrower scope/search for a new structural comparison. These locators do not retain historical bytes; current-file reads are not the withheld comparison.",
    ].join("\n");
    let bounded = compose();
    while (!diffReplyFits(bounded, input.budget) && limit > 0) { limit--; bounded = compose(); }
    if (!diffReplyFits(bounded, input.budget)) return resultText("ERROR: structural Diff budget cannot hold comparison identity and omission/status evidence. No source delivered; increase the character budget within the 8,000-token ceiling.", harnessEnvelope({ status: "error", summary: "Structural comparison minimum receipt cannot fit.", next_actions: [], artifacts: [] }));
    return resultText(bounded, harnessEnvelope({ status: "warning", summary: "Structural source withheld; bounded comparison locators retained.", next_actions: [], artifacts: [] }));
  }
  if (proof && result.content[0].text === proof.text) proof.commit();
  return result;
}

async function structuralDiffOutput(
  input: { root: string; source?: string; scope?: string; aPath?: string; bPath?: string; search?: string; expand?: number; review?: boolean; budget: number; signal?: AbortSignal; callNative: PiNavCaller },
  budget: number,
): Promise<{ ok: true; output: NativeOutput } | { ok: false; message: string }> {
  try {
    const output = await input.callNative({
      root: input.root,
      operation: "pi_nav_diff",
      args: compact({
        source: input.aPath && input.bPath ? undefined : diffSourceForNative(input.source),
        scope: input.scope,
        a: input.aPath,
        b: input.bPath,
        search: input.search,
        expand: input.expand,
        review: input.review,
        budget: Math.max(1000, Math.floor(budget)),
      }),
      timeoutMs: 25_000,
      signal: input.signal,
    });
    return { ok: true, output };
  } catch (error) {
    input.signal?.throwIfAborted();
    return { ok: false, message: ["ERROR: structural diff failed; no fallback navigation was used.", `Reason: ${error instanceof Error ? error.message : String(error)}`, "Query-time diff never builds, indexes, calls providers, or mutates state."].join("\n") };
  }
}

function reviewSelectionUnavailable() {
  return resultText("Diff review selection unavailable: paired change units could not be verified; search was not ignored. Use view:'patch' for the unfiltered comparison or retry when structured selection is available.",
    harnessEnvelope({ status: "error", summary: "Changed-unit selection unavailable, not a zero match.", next_actions: [], artifacts: [] }));
}

// ---------------------------------------------------------------------------
// Indexed planning adapter (impact/review)
//
// One current file-seeded indexed projection feeds both views. When no indexed
// owner published planning, the reader reports `undefined` and the view keeps
// its exact Git and paired native evidence with planning explicitly unavailable;
// no other graph backend is queried and no coverage/risk/flow verdict is
// fabricated.
// planning candidates: no source authority is minted from graph coordinates
// and no coverage/risk/flow verdict is fabricated.
const INDEXED_PLANNING_UNSUPPORTED = "Planning evidence not provided by the indexed graph (explicit, not a zero result): test coverage/test gaps, risk scoring, affected flows.";
const INDEXED_PLANNING_QUERY = "current-file impact";

/** Seeds must be current files: the indexed graph refuses deleted, stale or
 *  non-admitted identities, while exact Git evidence keeps the full change set. */
function planningSeeds(root: string, files: string[]): { seeds: string[]; excluded: string[] } {
  const seeds: string[] = [], excluded: string[] = [];
  for (const file of files) {
    let current = false;
    try { current = statSync(resolvePath(root, file)).isFile(); } catch { current = false; }
    (current ? seeds : excluded).push(file);
  }
  return { seeds, excluded };
}

interface IndexedPlanning { kind: "absent" | "refused" | "ready"; reason?: string; evidence?: any; output?: NativeOutput }

async function readIndexedPlanning(input: { root: string; files: string[]; signal?: AbortSignal; callNative: PiNavCaller }): Promise<IndexedPlanning> {
  let output: NativeOutput | undefined;
  try {
    output = await callIndexedGraphNavigation({
      root: input.root,
      query: INDEXED_PLANNING_QUERY,
      projection: { operation: "impact", files: input.files },
      signal: input.signal,
    }, input.callNative);
  } catch (error) {
    input.signal?.throwIfAborted();
    return { kind: "refused", reason: trimText(error instanceof Error ? error.message : String(error), 500) };
  }
  if (!output) return { kind: "absent" };
  try {
    return { kind: "ready", evidence: indexedGraphEvidence(output), output };
  } catch (error) {
    return { kind: "refused", reason: trimText(error instanceof Error ? error.message : String(error), 500) };
  }
}

/** Re-admit the ranked corpus after the later async evidence work and before
 *  the result. A revoked admission withholds planning; exact Git evidence from
 *  the same query is never withdrawn. */
async function refencePlanning(planning: IndexedPlanning, input: { callNative: PiNavCaller; signal?: AbortSignal }): Promise<IndexedPlanning> {
  if (planning.kind !== "ready" || !planning.output) return planning;
  try {
    await validateRankedCorpus(planning.output, input.callNative, { signal: input.signal });
    return planning;
  } catch (error) {
    input.signal?.throwIfAborted();
    return { kind: "refused", reason: trimText(error instanceof Error ? error.message : String(error), 500) };
  }
}

function indexedPlanningNotice(evidence: any, excluded: string[]): string {
  const lines = [INDEXED_PLANNING_UNSUPPORTED];
  const selection = evidence.selection ?? {};
  const unseeded = arrayOf(selection.unseededFiles).filter((file: unknown): file is string => typeof file === "string");
  const requested = arrayOf(selection.files).filter((file: unknown): file is string => typeof file === "string");
  if (unseeded.length) lines.push(`Planning seeded from ${requested.length} current file(s); ${unseeded.length} of them have no indexed declaration, so these counts are not an absence claim for them: ${formatList(unseeded, 8)}.`);
  if (excluded.length) lines.push(`${excluded.length} exact changed path(s) are deleted or missing at query time and cannot seed the indexed graph; no relationship is claimed for them: ${formatList(excluded, 8)}.`);
  const reasons = arrayOf(evidence.coverage?.reasons).filter((reason: unknown): reason is string => typeof reason === "string");
  if (reasons.length) lines.push(`Indexed coverage reasons: ${formatList(reasons, 8)} (bounded selection; not whole-project completeness or absence proof).`);
  return lines.join("\n");
}

function indexedPlanningSummary(evidence: any, excluded: string[], partial: boolean) {
  const selection = evidence.selection ?? {};
  return {
    status: partial ? "partial" : "ok",
    coverage_complete: evidence.coverage?.complete === true,
    coverage_reasons: arrayOf(evidence.coverage?.reasons),
    seeded_files: arrayOf(selection.files),
    unseeded_files: arrayOf(selection.unseededFiles),
    excluded_seeds: excluded,
    graph_generation_identity: evidence.project_navigation?.graph_generation_identity,
  };
}

function indexedPlanningShape(evidence: any): { impactedNodes: any[]; impactedFiles: string[]; partial: boolean } {
  const rootIds = new Set<string>(evidence.roots.map((node: any) => node.id));
  const impactedNodes = evidence.nodes.filter((node: any) => !rootIds.has(node.id));
  const seedFiles = new Set<string>(evidence.roots.map((node: any) => node.file_path));
  const impactedFiles = [...new Set<string>(impactedNodes.map((node: any) => node.file_path).filter((file: string) => !seedFiles.has(file)))];
  return { impactedNodes, impactedFiles, partial: evidence.status !== "ok" || evidence.truncated === true };
}

function indexedImpactComponent(evidence: any, excluded: string[], root: string): PreparedComponent {
  const { impactedNodes, impactedFiles, partial } = indexedPlanningShape(evidence);
  const payload = { status: partial ? "partial" : "ok", truncated: evidence.truncated === true,
    impacted_nodes: impactedNodes, impacted_files: impactedFiles, total_impacted: impactedNodes.length };
  const render = (limit: number): PreparedComponent => {
    const rendered = compactPreparedResult("Diff impact", payload, root, limit);
    return { ok: true, incomplete: rendered.incomplete,
      text: `${rendered.text}\n${indexedPlanningNotice(evidence, excluded)}`,
      native: { ...compactPreparedSidecar(payload, limit < 10 ? limit : 20), planning: indexedPlanningSummary(evidence, excluded, partial) },
      diagnostics: rendered.incomplete ? ["indexed impact planning has explicit omissions or a partial graph result."] : [],
      renderImpact: render };
  };
  return render(10);
}


function indexedPlanningFailure(view: "impact" | "review", reason?: string): PreparedComponent {
  const text = [`WARNING: indexed planning evidence unavailable for diff ${view}.`,
    `Reason: ${reason ?? "indexed graph projection was not available"}`,
    "Exact change evidence above is unaffected; no legacy graph query was issued."].join("\n");
  return { ok: false, text, diagnostics: [`indexed ${view} planning: ${reason ?? "unavailable"}`] };
}

async function runPlanningDiff(input: { view: "impact" | "review"; root: string; source?: string; scope?: string; search?: string; budget: number; signal?: AbortSignal; callNative: PiNavCaller }) {
  const changed = await changedFilesForDiff(input.root, input.source, input.scope);
  if (!changed.ok) return changed.result;
  if (!changed.files.length) return noTrackedChangesResult(input.view, input);
  const { seeds, excluded } = planningSeeds(input.root, changed.files);
  // A seedless probe asks only whether an indexed owner published planning; the
  // indexed reader never receives an empty seed list as a query.
  const planning = await readIndexedPlanning({ root: input.root, files: seeds, signal: input.signal, callNative: input.callNative });
  if (planning.kind === "absent") {
    // No published indexed graph for this root. Exact Git and paired native change
    // evidence are unaffected; graph planning is reported unavailable rather than
    // fabricated, and no other graph backend is queried.
    const reason = "no published indexed code graph may be read for this scope";
    return input.view === "impact"
      ? finishImpactDiff(input, changed.files, indexedPlanningFailure("impact", reason))
      : indexedReviewDiff(input, changed.files, excluded, planning, reason);
  }
  const seedlessReason = seeds.length ? undefined : `no current file to seed indexed planning; all ${excluded.length} changed path(s) are deleted or missing at query time`;
  const fallback = planning.kind === "ready" ? undefined : seeds.length ? planning.reason : seedlessReason;
  if (input.view === "impact") {
    const component = planning.kind === "ready" && planning.evidence
      ? indexedImpactComponent(planning.evidence, excluded, input.root)
      : indexedPlanningFailure("impact", fallback);
    return finishImpactDiff(input, changed.files, component);
  }
  return indexedReviewDiff(input, changed.files, excluded, planning, fallback);
}

function finishImpactDiff(input: { budget: number }, files: string[], original: PreparedComponent) {
  let countedText: string | undefined;
  let countedFit = false;
  const fits = (text: string) => {
    // Adjacent row limits can render identically; count each composed text once.
    if (text === countedText) return countedFit;
    countedText = text;
    return countedFit = diffReplyFits(text, input.budget, 4_000);
  };
  let fileLimit = Math.min(files.length, 12);
  const header = () => `Diff impact\nExact changed files (${files.length}): ${fileLimit ? formatList(files, fileLimit) : "all paths omitted from display"}`;
  let component = original;
  let text = `${header()}\n\n${component.text}`;
  let displayOmitted = files.length > fileLimit;
  // Recompose whole graph records from this capture; never rerun the provider
  // or truncate a name/source identity after it has been selected.
  for (let limit = 9; !fits(text) && limit >= 0 && original.renderImpact; limit--) {
    component = original.renderImpact(limit);
    text = `${header()}\n\n${component.text}`;
    displayOmitted = true;
  }
  if (!fits(text)) {
    component = { ok: original.ok, incomplete: true,
      text: "Planning evidence omitted: no complete planning block fits this reply's budget. Narrow scope or request less detail.", diagnostics: original.diagnostics };
    text = `${header()}\n\n${component.text}`;
    displayOmitted = true;
    while (!fits(text) && fileLimit > 0) { fileLimit--; text = `${header()}\n\n${component.text}`; }
    if (!fits(text)) text = "Diff impact: no complete evidence unit fits the requested budget. Narrow scope or increase budget.";
  }
  const complete = component.ok && !component.incomplete && !displayOmitted;
  const envelope = harnessEnvelope({ status: complete ? "success" : "warning",
    summary: complete ? "Diff impact returned exact changed files with planning evidence." : "Diff impact is incomplete; inspect the displayed evidence and omissions.",
    next_actions: [], artifacts: [], diagnostics: [...component.diagnostics, ...(displayOmitted ? ["Impact evidence omitted coherently by budget."] : [])] });
  return { content: [{ type: "text" as const, text }], details: { status: complete ? "success" : "partial", envelope,
    prepared: stripPrivateEvidence({ impact: component.native }), diff: { exactFiles: files, displayedFileCount: fileLimit } } };
}

async function indexedReviewDiff(input: { root: string; source?: string; scope?: string; search?: string; budget: number; signal?: AbortSignal; callNative: PiNavCaller }, files: string[], excluded: string[], planning: IndexedPlanning, fallbackReason?: string) {
  const structural = await structuralDiffOutput({ ...input, review: true }, Math.min(input.budget, 12_000));
  const patch = await runGitDiff(input.root, gitDiffArgs(input, "patch"), input.budget);
  // The exact Git receipt stays independent of planning availability: it names
  // the changed files and the changed line ranges even when no graph planning
  // evidence exists, so a missing index can never look like a missing change.
  const changedRanges = await changedLineRangesForDiff(input.root, input.source, input.scope);
  const rangeFailure = changedRanges.ok ? undefined : changedRanges.result.content.map(part => part.text).join("\n");
  const rangeDiagnostics = rangeFailure ? [rangeFailure] : [];
  const diffEvidence = { exactFiles: files, exactRangesStatus: changedRanges.ok ? "success" : "unavailable",
    ...(changedRanges.ok ? { exactRanges: changedRanges.ranges } : { exactRangesDiagnostics: rangeDiagnostics }) };
  const notices: string[] = patch.ok ? [] : ["Exact Git comparison check unavailable: " + trimText(patch.stderr, 500)];
  let data = structural.ok ? structural.output.structured.data as any : undefined;
  let changes: ReviewChangeUnit[];
  try { changes = reviewChangeUnits(data, patch.ok ? patch.stdout : ""); }
  catch (error) {
    data = undefined;
    changes = reviewChangeUnits(undefined, patch.ok ? patch.stdout : "");
    notices.push(`Paired-source transport rejected: ${trimText(String(error), 300)}. Exact Git patch retained.`);
  }
  if (!patch.ok && !Array.isArray(data?.changes)) { changes = []; notices.push(`Paired change source unavailable; exact changed files (${files.length}): ${formatList(files, 12)}. No empty comparison is inferred.`); }
  if (input.search && !Array.isArray(data?.changes)) return reviewSelectionUnavailable();
  if (input.search && !changes.length && data?.changesCompleteness?.complete !== false) return resultText("Diff review: no changed units matched the search in the selected comparison. No consumer context was attached.");
  const comparison = data?.comparison;
  const header = `Diff review — ${sourceLabel(input.source)}${scopeLabel(input.scope)}\nBefore/after rows are comparison evidence, not current edit authority.`
    + (comparison?.patchDigest ? `\nCaptured comparison: ${comparison.resolvedSource ?? sourceLabel(input.source)} · SHA-256 ${comparison.patchDigest}` : "");
  const shown: typeof changes = [];
  if (data?.changesCompleteness?.complete === false) notices.push(`Selected changes not transported: ${data.changesCompleteness.omitted} whole unit(s); narrow scope. The comparison is partial.`);
  if (planning.evidence && (planning.evidence.status !== "ok" || planning.evidence.truncated || planning.evidence.coverage?.complete === false)) notices.push("Related-source selection is incomplete; displayed support is not an exhaustive consumer list.");
  let comparisonBeforeSupport: string | undefined;
  let trackedBeforeSupport: string | undefined;
  const support: Array<Awaited<ReturnType<typeof prepareExactLeads>>> = [];
  let omittedSupport = 0;
  const compose = () => [header, ...shown.map(unit => unit.text), ...support.map(proof => proof.text), ...notices,
    ...(shown.length < changes.length ? [`Selected changes not displayed: ${changes.length - shown.length} coherent unit(s); narrow scope or search. No omitted delta is claimed delivered.`] : []),
    ...(omittedSupport ? [`Related source not displayed: ${omittedSupport} group(s); the change evidence above is independent.`] : []),
  ].join("\n\n");
  // Fit changes before collecting optional support. A whole paired unit survives
  // or remains explicitly undisplayed; never slice a delta or its declaration.
  for (const unit of changes) {
    shown.push(unit);
    if (!diffReplyFits(compose(), input.budget)) shown.pop();
  }
  const afterIsWorktree = data?.comparison?.afterSource === "working_tree" && (!input.source || input.source === "uncommitted");
  if (!structural.ok || !data?.comparison) {
    notices.push(`Explanatory support unavailable: ${!structural.ok ? structural.message : "paired comparison identity unavailable"}. Exact changes are retained.`);
  } else if (!patch.ok) {
    notices.push("Explanatory support withheld: the independent Git comparison check failed. Captured paired changes remain usable.");
  } else if (!afterIsWorktree) {
    notices.push("After-side connections unavailable: this comparison is not the captured working-tree after-state. Current graph/source is not attached to a staged or revision comparison.");
  } else if (planning.kind !== "ready" || !planning.evidence) {
    notices.push(`Explanatory support unavailable: ${planning.reason ?? fallbackReason ?? "no admitted indexed evidence"}. Exact changes are retained.`);
  } else {
    const allChanged = await changedFilesForDiff(input.root, input.source);
    const baseline = await runGitDiff(input.root, gitDiffArgs({ source: input.source }, "patch"), input.budget);
    const tracked = await runGitDiff(input.root, ["ls-files", "--cached", "-z"], input.budget);
    if (!allChanged.ok || !baseline.ok) notices.push("Supporting-file comparison status unavailable; no source was labeled unchanged.");
    else if (comparison.patchDigest?.toLowerCase() !== createHash("sha256").update(baseline.stdout).digest("hex")) notices.push("Explanatory support withheld: captured comparison no longer matches Git. Captured exact changes remain comparison evidence.");
    else {
      comparisonBeforeSupport = baseline.stdout;
      trackedBeforeSupport = tracked.ok ? tracked.stdout : undefined;
      const { groups, unexpanded } = reviewSupportGroups(planning.evidence, shown, allChanged.files, new Set(tracked.ok ? tracked.stdout.split("\0").filter(Boolean) : []));
      if (!groups.length) notices.push("No direct source support could be associated with the displayed after-side changes; this is not proof of no consumers.");
      if (unexpanded) notices.push(`${unexpanded} file/import relationship(s) not expanded: no complete declaration range supports a consumer-body claim.`);
      for (const group of groups) {
        input.signal?.throwIfAborted();
        try {
          const proof = await prepareExactLeads({ cwd: input.root, nativeText: group.reason, leads: group.leads,
            expectedRawDigests: group.digests, requireVersion: true, signal: input.signal, callNative: input.callNative });
          if (!proof.promoted || proof.reason) { omittedSupport++; continue; }
          support.push(proof);
          if (!diffReplyFits(compose(), input.budget)) { support.pop(); omittedSupport++; }
        } catch (error) {
          input.signal?.throwIfAborted();
          omittedSupport++;
        }
      }
    }
  }
  if (support.length) {
    const refenced = await refencePlanning(planning, { callNative: input.callNative, signal: input.signal });
    // Re-read the comparison, not only the source proof: staged/worktree changes
    // during enrichment must not inherit an obsolete "unchanged" label.
    const afterPatch = await runGitDiff(input.root, gitDiffArgs({ source: input.source }, "patch"), input.budget);
    const beforeScoped = input.scope ? await runGitDiff(input.root, gitDiffArgs(input, "patch"), input.budget) : afterPatch;
    const tracked = trackedBeforeSupport !== undefined ? await runGitDiff(input.root, ["ls-files", "--cached", "-z"], input.budget) : undefined;
    if (refenced.kind !== "ready" || !afterPatch.ok || afterPatch.stdout !== comparisonBeforeSupport || !beforeScoped.ok || beforeScoped.stdout !== patch.stdout || (tracked && (!tracked.ok || tracked.stdout !== trackedBeforeSupport))) {
      omittedSupport += support.length; support.length = 0;
      notices.push("Explanatory support withheld after comparison/admission drift; captured exact changes remain comparison evidence.");
    }
  }
  // Diagnostics also consume the final budget. Remove optional source before
  // changes and commit authority only for the complete reply that survives.
  while (!diffReplyFits(compose(), input.budget) && support.length) { support.pop(); omittedSupport++; }
  while (!diffReplyFits(compose(), input.budget) && shown.length) shown.pop();
  const text = compose();
  if (!diffReplyFits(text, input.budget)) return resultText("ERROR: diff review budget cannot hold comparison identity and required omission/status evidence. Use a larger character budget; the 8,000-token maximum still applies.", harnessEnvelope({ status: "error", summary: "Review budget cannot hold a complete minimum receipt.", next_actions: [], artifacts: [] }));
  for (const proof of support) proof.commit();
  const partial = shown.length < changes.length || omittedSupport > 0 || notices.length > 0 || !changedRanges.ok;
  const envelope = harnessEnvelope({ status: partial ? "warning" : "success",
    summary: `${shown.length} paired change unit(s), ${support.length} explanatory source group(s)${partial ? "; explicit limitations" : ""}.`,
    next_actions: [], artifacts: support.flatMap(proof => proof.artifacts),
    diagnostics: [...rangeDiagnostics, ...notices] });
  const result = resultText(text, envelope);
  return { ...result, details: { ...result.details, status: partial ? "partial" : "success", diff: diffEvidence } };
}

interface ReviewChangeUnit { path: string; name?: string; afterDigest?: string; after?: { start: number; end: number; name: string; parent?: string }; text: string }

function reviewChangeUnits(data: any, patch: string): ReviewChangeUnit[] {
  if (!Array.isArray(data?.changes)) return [{ path: "", text: patch ? `Exact before/after patch\n${patch}` : "No tracked changes." }];
  return data.changes.flatMap((change: any) => {
    if (typeof change?.path !== "string" || !Array.isArray(change.lines)) throw new Error("Malformed paired Diff change");
    if (change.lines.some((row: any) => typeof row.content !== "string" || !["context", "added", "removed"].includes(row.kind)
      || [row.oldLine, row.newLine].some(line => line != null && (!Number.isSafeInteger(line) || line < 1)))) throw new Error("Malformed paired Diff source rows");
    const lines = [`CHANGE ${change.oldPath && change.oldPath !== change.path ? `${change.oldPath} → ` : ""}${change.path}${change.name ? `::${change.name}` : ""}`];
    for (const [label, side] of [["BEFORE", change.old], ["AFTER", change.new]] as const) {
      if (!side) continue;
      lines.push(`${label}: ${side.path}${side.name ? `::${side.parent ? `${side.parent}::` : ""}${side.name}` : ""} [${side.start}-${side.end}]`);
      for (const row of side.declaration ?? []) {
        if (!change.lines.some((line: any) => (label === "BEFORE" ? line.oldLine : line.newLine) === row.line)) lines.push(`${label.toLowerCase()}:${row.line}: ${row.content}`);
      }
    }
    lines.push(...change.lines.map((row: any) => `${row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "} old:${row.oldLine ?? "—"} new:${row.newLine ?? "—"} ${row.content}`));
    if (change.note) lines.push(change.note);
    return [{ path: change.path, name: change.name, afterDigest: change.new?.fileDigest, after: change.new, text: lines.join("\n") }];
  });
}

function reviewSupportGroups(evidence: any, units: ReviewChangeUnit[], changedFiles: string[], trackedFiles: Set<string>) {
  const digests: Record<string, string> = Object.fromEntries((evidence.source_claims ?? []).map((claim: any) => [claim.path, claim.raw_digest]));
  const targets = new Set<string>();
  for (const unit of units) {
    if (!unit.after || !unit.afterDigest || unit.afterDigest.toLowerCase() !== digests[unit.path]?.toLowerCase()) continue;
    const symbol = unit.after;
    if (typeof symbol.name !== "string") continue;
    const name = symbol.parent ? `${symbol.parent}::${symbol.name}` : symbol.name;
    const selected = evidence.nodes.filter((node: any) => node.file_path === unit.path && node.line_start === symbol.start && node.line_end === symbol.end
      && (node.qualified_name === `${unit.path}::${name}`));
    if (selected.length === 1) targets.add(selected[0].id);
  }
  const nodes = new Map<string, any>(evidence.nodes.map((node: any) => [node.id, node]));
  const groups = new Map<string, { reason: string; leads: Array<{ path: string; start: number; end: number; label: string }>; digests: Record<string, string> }>();
  let unexpanded = 0;
  for (const edge of evidence.edges) {
    if (!targets.has(edge.target_id) || targets.has(edge.source_id) || !["calls", "references", "implements", "inherits", "imports"].includes(edge.kind.toLowerCase())) continue;
    const caller = nodes.get(edge.source_id);
    if (!caller || edge.file_path !== caller.file_path || !Number.isInteger(edge.line) || edge.line < caller.line_start || edge.line > caller.line_end || !digests[caller.file_path]) continue;
    if (caller.kind?.toLowerCase() === "file" || edge.kind.toLowerCase() === "imports") { unexpanded++; continue; }
    const key = `${caller.id}:${caller.line_start}-${caller.line_end}`;
    const unchanged = trackedFiles.has(caller.file_path) && !changedFiles.includes(caller.file_path);
    const group = groups.get(key) ?? { reason: `${unchanged ? "UNCHANGED CONSUMER SOURCE" : "SUPPORTING AFTER-SOURCE"} — ${caller.file_path}${!trackedFiles.has(caller.file_path) ? " (comparison membership not established)" : ""}\nIndexed relationship candidates; current source verified, binding/coverage not proved.`, leads: [], digests: { [caller.file_path]: digests[caller.file_path] } };
    group.reason += `\nReason: ${edge.source} —${edge.functionReference ? "function reference" : edge.kind}→ ${edge.target} at ${edge.file_path}:${edge.line}${edge.column != null ? ` col0=${edge.column}` : ""}.`;
    group.leads.push({ path: caller.file_path, start: caller.line_start, end: caller.line_end, label: caller.qualified_name });
    groups.set(key, group);
  }
  return { groups: [...groups.values()], unexpanded };
}

function preparedComponentDetails(component: PreparedComponent): Record<string, unknown> {
  return { status: component.ok ? component.incomplete ? "partial" : "success" : "unavailable", evidence: component.native, diagnostics: component.diagnostics };
}

function compactPreparedResult(title: string, native: any, root: string, impactLimit = 10): { text: string; incomplete: boolean } {
  const lines = [title, "PREPARED PLANNING — stored graph evidence; freshness and binding are not established here. This is not historical relationship or breakage proof."];
  let incomplete = native.truncated === true || native.status === "partial";
  const impacted = firstArray(native.impacted_nodes, native.impact?.impacted_nodes);
  const files = firstArray(native.impacted_files, native.impact?.impacted_files);
  lines.push(`Prepared blast radius: ${impacted.length} impacted node(s) across ${files.length} additional file(s).`);
  incomplete = appendRows(lines, "Impacted nodes", impacted, Math.min(8, impactLimit), root) || files.length > impactLimit || incomplete;
  if (files.length) lines.push(impactLimit ? `Impacted files: ${formatList(files.map((item: any) => compactDiffPath(typeof item === "string" ? item : item.path ?? item.file_path ?? String(item), root)), impactLimit)}` : `Impacted files: ${files.length} paths omitted from display.`);
  const savings = native.context_savings;
  if (savings?.saved_tokens) lines.push(`Context savings: ${savings.saved_tokens} tokens.`);
  if (native.truncated) lines.push("Prepared backend output was truncated; counts above retain native limits.");
  if (native.status === "partial") lines.push("Prepared backend reported partial evidence.");
  return { text: lines.join("\n"), incomplete };
}

function appendRows(lines: string[], label: string, rows: any[], limit: number, root: string): boolean {
  if (!rows.length) return false;
  lines.push(`${label} (${rows.length})`);
  for (const row of rows.slice(0, limit)) {
    const path = compactDiffPath(row.path ?? row.file_path ?? row.file ?? "?", root);
    const name = row.qualified_name ?? row.name ?? row.label ?? "item";
    const start = row.line_start ?? row.start ?? row.line;
    lines.push(`- ${name}${row.id !== undefined ? ` [node ${row.id}]` : ""} · ${path}${start ? `:${start}` : ""}`);
  }
  if (rows.length > limit) lines.push(`… ${rows.length - limit} more ${label.toLowerCase()} omitted`);
  return rows.length > limit;
}

function compactDiffPath(value: string, root: string): string {
  if (!isAbsolute(value)) return value.replace(/\\/g, "/");
  const rel = relativePath(canonicalProjectPath(root), canonicalProjectPath(value)).replace(/\\/g, "/");
  return rel && !rel.startsWith("../") ? rel : value.replace(/\\/g, "/");
}

// Impact is the only prepared planning payload the indexed graph provides. This
// sidecar therefore carries native counts and identities alone: test coverage,
// risk scoring and affected-flow facets have no owner here and are not rendered.
function compactPreparedSidecar(native: any, impactLimit = 20): any {
  return {
    summary: native.summary,
    impacted_nodes: firstArray(native.impacted_nodes, native.impact?.impacted_nodes).slice(0, Math.min(20, impactLimit)),
    impacted_files: firstArray(native.impacted_files, native.impact?.impacted_files).slice(0, Math.min(20, impactLimit)),
    total_impacted: native.total_impacted ?? native.impact?.total_impacted,
    truncated: native.truncated,
    context_savings: native.context_savings ?? native.impact?.context_savings,
  };
}

function formatList(items: string[], limit: number): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown}, … ${items.length - limit} more` : shown;
}

function arrayOf(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function firstArray(...values: unknown[]): any[] {
  for (const value of values) if (Array.isArray(value)) return value;
  return [];
}

async function changedLineRangesForDiff(root: string, source?: string, scope?: string): Promise<{ ok: true; ranges: ChangedLineRange[] } | { ok: false; result: ReturnType<typeof gitFailureResult> }> {
  const args = gitDiffArgs({ source, scope }, "patch");
  args.splice(args.indexOf("--no-color") + 1, 0, "--unified=0");
  const run = await runGitDiff(root, args, DEFAULT_BUDGET);
  if (!run.ok) return { ok: false, result: gitFailureResult(run, source) };
  const ranges: ChangedLineRange[] = [];
  let oldPath = "";
  let newPath = "";
  for (const line of run.stdout.split(/\r?\n/)) {
    const oldFile = /^---\s+(?:a\/)?(.+)$/.exec(line);
    if (oldFile) { oldPath = oldFile[1] === "/dev/null" ? "" : normalizeDiffPath(oldFile[1]); continue; }
    const newFile = /^\+\+\+\s+(?:b\/)?(.+)$/.exec(line);
    if (newFile) { newPath = newFile[1] === "/dev/null" ? "" : normalizeDiffPath(newFile[1]); continue; }
    const hunk = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (!hunk) continue;
    const deleted = !newPath;
    const path = deleted ? oldPath : newPath;
    if (!path) continue;
    const start = Math.max(1, Number(deleted ? hunk[1] : hunk[3]));
    const countText = deleted ? hunk[2] : hunk[4];
    const count = countText === undefined ? 1 : Number(countText);
    ranges.push({ path, start, end: count > 0 ? start + count - 1 : start });
  }
  return { ok: true, ranges };
}

function changedSymbolsFromNative(structured: NativeOutput["structured"], root: string, source?: string): ChangedSymbolEvidence[] {
  const data = structured.data as any;
  const symbols = Array.isArray(data.symbols) ? data.symbols : nativeRecords(data.changes).flatMap((change: any) => {
    const side = change.new ?? change.old;
    if (!side?.name) return [];
    return [{ name: side.name, change: change.kind, location: { path: side.path, start: side.start, end: side.end,
      role: change.new && data.comparison?.afterSource === "working_tree" ? "changed_symbol" : "comparison_symbol_not_current_source" } }];
  });
  return nativeRecords(symbols).flatMap(symbol => {
    if (symbol.change === "unchanged") return [];
    const location = symbol.location && typeof symbol.location === "object"
      ? symbol.location as Record<string, unknown>
      : undefined;
    if (!location || typeof location.path !== "string" || typeof symbol.name !== "string") return [];
    const start = Number(location.start);
    const end = Number(location.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return [];
    const worktreeAfter = !source || source === "uncommitted" || (source !== "staged" && !source.includes(".."));
    return [{ path: canonicalProjectPath(resolvePath(root, location.path)), name: symbol.name, start, end, change: typeof symbol.change === "string" ? symbol.change : "changed", currentSource: worktreeAfter && symbol.change !== "deleted" && location.role === "changed_symbol" }];
  });
}


function normalizeDiffPath(value: string): string {
  return value.trim().replace(/^"|"$/g, "").replace(/^\.\//, "").replace(/\\/g, "/");
}

function formatChangedRanges(ranges: ChangedLineRange[]): string {
  if (!ranges.length) return "none";
  const shown = ranges.slice(0, 20).map(range => `${range.path}:${range.start}-${range.end}`).join(", ");
  return ranges.length > 20 ? `${shown}, … ${ranges.length - 20} more range(s) omitted` : shown;
}

async function changedFilesForDiff(root: string, source?: string, scope?: string): Promise<{ ok: true; files: string[] } | { ok: false; result: any }> {
  const run = await runGitDiff(root, gitDiffArgs({ source, scope }, "name-only"), DEFAULT_BUDGET);
  if (!run.ok) return { ok: false, result: gitFailureResult(run, source) };
  const files = run.stdout.split("\0").filter(Boolean).filter(path => !path.startsWith("../"));
  return { ok: true, files: [...new Set(files)] };
}

async function runGitDiff(root: string, args: string[], budget: number): Promise<GitRun> {
  try {
    const result = await execFileAsync("git", args, { cwd: root, maxBuffer: Math.max(1_000_000, budget * 4) });
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), ok: true, unknownSource: false };
  } catch (error: any) {
    const stderr = String(error.stderr || error.message || error);
    return { stdout: String(error.stdout ?? ""), stderr, ok: false, unknownSource: isUnknownDiffSource(stderr) };
  }
}

function gitDiffArgs(input: { source?: string; scope?: string; fullIndex?: boolean }, view: "patch" | "name-status" | "name-only"): string[] {
  const args = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"];
  if (view === "patch" && input.fullIndex) args.push("--full-index");
  if (view === "name-status") args.push("--name-status", "-z");
  if (view === "name-only") args.push("--name-only", "-z");
  if (input.source === "staged") args.push("--cached");
  else if (input.source && input.source !== "uncommitted") args.push("--end-of-options", input.source);
  if (input.scope) args.push("--", input.scope);
  return args;
}

function parseNameStatus(stdout: string): Array<{ status: string; path: string }> {
  const fields = stdout.split("\0");
  const out: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const first = fields[index++] ?? "";
    if (/^[RC]/.test(status)) {
      const second = fields[index++] ?? "";
      out.push({ status, path: `${first} → ${second}` });
    } else out.push({ status, path: first });
  }
  return out;
}

function isUnknownDiffSource(stderr: string): boolean {
  return /ambiguous argument|unknown revision|bad revision|Needed a single revision/i.test(stderr);
}

function gitFailureResult(run: GitRun, source?: string) {
  if (run.unknownSource) return unknownSourceResult(source);
  const reason = trimText(run.stderr.trim().split(/\r?\n/, 1)[0] || "git diff failed", 500);
  return resultText(`ERROR: git diff failed for ${trimText(sourceLabel(source), 200)}.\nReason: ${reason}\nStop condition: do not interpret this as a successful or empty diff.`);
}

function unknownSourceResult(source?: string) {
  const text = `ERROR: unknown diff source/ref ${JSON.stringify(source === undefined ? source : trimText(source, 200))}.\nRoot cause: git did not recognize the requested diff source/ref.\nSafe retry: use source:"uncommitted", source:"staged", a valid git ref/range, or omit source.\nStop condition: do not treat this as a successful diff.`;
  return resultText(text);
}

function diffSourceForNative(source?: string): string {
  return source && source !== "uncommitted" ? source : "uncommitted";
}

function sourceLabel(source?: string): string {
  return source === "staged" ? "staged/index" : source && source !== "uncommitted" ? `git source/ref ${source}` : "unstaged working-tree";
}

function scopeLabel(scope?: string): string {
  // Display only: retain one ./ so a literal colon prefix cannot look like Git
  // pathspec magic. The captured query keeps the caller's original scope.
  return scope ? ` under ${scope.replace(/^(?:\.\/)+/, "./")}` : "";
}

function noTrackedChangesResult(view: "impact" | "review", input: { source?: string; scope?: string; budget: number }) {
  const text = `Diff ${view}: no tracked changed files detected for ${sourceLabel(input.source)}${scopeLabel(input.scope)}. No graph query was run.`;
  return diffReplyFits(text, input.budget, view === "impact" ? 4000 : 8000) ? resultText(text) : resultText("ERROR: selected comparison identity exceeds the empty-result reply allowance. No complete comparison receipt delivered; no graph query was run.", harnessEnvelope({ status: "error", summary: "Empty comparison minimum receipt cannot fit.", next_actions: [], artifacts: [] }));
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function untrackedSummary(root: string, scope?: string): Promise<string> {
  const args = ["ls-files", "--others", "--exclude-standard", "-z"];
  if (scope) args.push("--", scope);
  const result = await execFileAsync("git", args, { cwd: root, maxBuffer: 1_000_000 }).catch(() => ({ stdout: "" }));
  const paths = String(result.stdout || "").split("\0").filter(Boolean);
  return paths.length ? `Untracked files excluded (${paths.length}): ${formatList(paths, 5)}.` : "No untracked files detected.";
}
