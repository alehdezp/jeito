import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { harnessEnvelope, nativeToolResult } from "../core/harness-result.ts";
import { callPiNav, type PiNavCaller } from "../core/pi-nav-native.ts";
import { canonicalProjectPath, detectProjectRoot } from "../core/project-root.ts";
import { rejectObsoleteNavigationParams, resolveNavigationScope, resultText } from "../core/navigation-clean.ts";
import { S } from "../core/schema.ts";
import { renderLsCall, renderLsResult } from "../core/tui-render.ts";
import { asToolCallValidationError, invalidToolCallResult, normalizedEnum, normalizedInteger, ToolCallValidationError, withToolCallNormalizations } from "../core/tool-call-contract.ts";
import { probeZeroVisibility, shouldProbeZero } from "../core/zero-visibility-probe.ts";

export const lsParams = S.object({
  path: S.string("Directory to list; defaults to the working directory."),
  view: S.string("list (flat children) or tree (hierarchy with depth). Defaults to list."),
  depth: S.number("Tree only, 1-8, default 2."),
  glob: S.string("One naming slice to narrow the listing."),
  visibility: S.string("project (default, respects ignore rules) or all. A project-scoped zero can be filter-caused — confirm with all when absence matters."),
  sort: S.string("mtime (list default) or path (tree default)."),
  budget: S.number("Cap on output; raise only after truncation."),
}, []);

export function registerLsTool(
  pi: ExtensionAPI,
  options: { callNative?: PiNavCaller } = {},
): void {
  const callNative = options.callNative ?? callPiNav;
  pi.registerTool({
    name: "ls",
    label: "ls",
    renderShell: "self",
    renderCall: renderLsCall,
    renderResult: renderLsResult,
    description: "See what's in a folder — ls, plus tree for the hierarchy. Use it to orient before searching, or to see a folder's shape. Returns names, types, and sizes, never contents. Large list views are condensed by default to the first 50 entries — narrow with glob or use find for the rest. A complete zero under project ignore rules triggers one automatic all-visibility probe, so an ignored folder is reported instead of silently emptied. Example: ls({path:'src/tools', view:'list'}).",
    parameters: lsParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const normalizations: string[] = [];
      let request: any;
      try {
        rejectObsoleteNavigationParams("ls", params, ["path", "view", "depth", "glob", "visibility", "sort", "budget"]);
        if (params.path !== undefined && typeof params.path !== "string") throw new ToolCallValidationError("ls path must be a single directory string.", { received: params.path, guidance: ["Use one directory path per ls call."] });
        const view = normalizedEnum(params.view ?? "list", "ls view", ["list", "tree"], normalizations);
        if (params.depth !== undefined && view !== "tree") throw new ToolCallValidationError("ls depth applies only to view:'tree'.", { received: params.depth, guidance: ["Remove depth or set view:'tree'."] });
        const depth = view === "tree" ? normalizedInteger(params.depth, "ls depth", 2, 1, 8, normalizations) : undefined;
        const visibility = normalizedEnum(params.visibility ?? "project", "ls visibility", ["project", "all"], normalizations);
        const sort = normalizedEnum(params.sort ?? (view === "tree" ? "path" : "mtime"), "ls sort", ["mtime", "path"], normalizations);
        const budget = params.budget === undefined ? undefined : normalizedInteger(params.budget, "ls budget", 1, 1, 1_000_000, normalizations);
        request = { ...params, view, depth, visibility, sort, budget };
      } catch (error) {
        return invalidToolCallResult("ls", asToolCallValidationError(error, { accepted: ["{path:'src', view:'list'}", "{path:'src', view:'tree', depth:3}"], received: params }));
      }
      const resolved = await resolveNavigationScope(ctx.cwd, request.path);
      if (!resolved.ok) return resultText(resolved.text, resolved.envelope);
      if (resolved.isFile) return invalidToolCallResult("ls", new ToolCallValidationError("ls path must be a directory.", { received: params.path, guidance: ["Use read for a known file."] }));
      const root = detectProjectRoot(resolved.scope).root;
      try {
        const nativeArgs = compact({
          path: canonicalProjectPath(resolved.scope),
          view: request.view,
          depth: request.depth,
          glob: request.glob,
          visibility: request.visibility,
          sort: request.sort,
          budget: request.budget,
        });
        const output = await callNative({
          root,
          operation: "pi_nav_ls",
          args: nativeArgs,
          timeoutMs: 20_000,
          signal,
        });
        const completeness = output.structured.completeness;
        const complete = completeness.complete !== false;
        const returned = Number(completeness.returned ?? 0);
        let text = request.visibility === "project" ? output.text.replace("— live filesystem, complete", "— live filesystem, complete under project ignore rules") : output.text;
        let condensedDiagnostic: string | undefined;
        if (request.view === "list") {
          const condensed = condenseListEntries(text, LS_INLINE_ENTRY_CAP);
          if (condensed) {
            text = condensed.text;
            condensedDiagnostic = `ls_condensed=shown_${condensed.shown}_of_${condensed.total}`;
          }
        }
        let escalationText = "";
        let escalationDiagnostic: string | undefined;
        if (shouldProbeZero({ returned, complete, visibility: request.visibility })) {
          const probe = await probeZeroVisibility({ callNative, root, operation: "pi_nav_ls", args: nativeArgs, timeoutMs: 20_000, signal });
          escalationText = probe.text;
          escalationDiagnostic = probe.diagnostic;
        }
        return withToolCallNormalizations(nativeToolResult(`${text}${escalationText}`, output.structured, harnessEnvelope({
          status: complete ? "success" : "warning",
          summary: complete ? "Directory shape completed." : "Directory shape returned an honest partial result.",
          next_actions: [],
          artifacts: [],
          diagnostics: [...(output.structured.diagnostics ?? []), ...(condensedDiagnostic ? [condensedDiagnostic] : []), ...(escalationDiagnostic ? [escalationDiagnostic] : [])],
        })), normalizations);
      } catch (error) {
        return resultText(
          `ERROR: directory listing failed.\nReason: ${error instanceof Error ? error.message : String(error)}\nNo command, PATH, build, or filesystem fallback was used.`,
          harnessEnvelope({ status: "error", summary: "Directory listing failed; no fallback used.", next_actions: ["Use navigation-debug if this failure is unexpected."], artifacts: [] }),
        );
      }
    },
  });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

// Bulk discovery of a huge flat folder belongs in glob/find queries, not one
// inline dump. Header and the first N entry lines stay verbatim (native signal
// preserved); list view only — tree groups are hierarchy-bearing and
// token-budgeted by the backend already.
export const LS_INLINE_ENTRY_CAP = 50;

export function condenseListEntries(text: string, cap: number): { text: string; shown: number; total: number } | undefined {
  const lines = text.split("\n");
  const countsIndex = lines.findIndex(line => /^# \d+ files,/.test(line));
  if (countsIndex < 0) return undefined;
  let entryStart = countsIndex + 1;
  while (entryStart < lines.length && lines[entryStart] === "") entryStart += 1;
  let entryEnd = entryStart;
  while (entryEnd < lines.length && lines[entryEnd] !== "" && !lines[entryEnd].startsWith("… ")) entryEnd += 1;
  const entryLines = lines.slice(entryStart, entryEnd);
  if (entryLines.length <= cap) return undefined;
  const tail = entryEnd < lines.length ? ["", ...lines.slice(entryEnd)] : [];
  const condensedText = [
    ...lines.slice(0, entryStart),
    ...entryLines.slice(0, cap),
    "",
    `… ${entryLines.length - cap} more entries omitted by default condensation (cap ${cap}) — narrow with glob, target names with find, or raise budget.`,
    ...tail,
  ].join("\n");
  return { text: condensedText, shown: cap, total: entryLines.length };
}

export const __lsInternals = { condenseListEntries, LS_INLINE_ENTRY_CAP };
