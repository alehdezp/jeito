import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { harnessEnvelope, nativeToolResult, referenceTokenCount as grepTokenCount } from "../core/harness-result.ts";
import { prepareExactLeads, prepareSourceAuthority } from "../core/source-authority.ts";
import { nativeSourceEvidence, nativeRecords } from "../core/pi-nav-evidence.ts";
import { callPiNav, callAnalysisNavigation, validateRankedCorpus, MAX_SOURCE_PROOF_FILES, MAX_SOURCE_PROOF_FILE_BYTES, type AnalysisProject, type NativeOutput, type NativeSourceSnapshot, type PiNavCaller } from "../core/pi-nav-native.ts";
import { canonicalProjectPath, detectProjectRoot } from "../core/project-root.ts";
import { rejectObsoleteNavigationParams, resultText } from "../core/navigation-clean.ts";
import { renderGrepCall, renderGrepResult } from "../core/tui-render.ts";
import { S } from "../core/schema.ts";
import { asToolCallValidationError, boundedInvalidToolCallResult, normalizedEnum, normalizedInteger, ToolCallValidationError, withToolCallNormalizations } from "../core/tool-call-contract.ts";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { enumerateNavigationCorpus } from "../core/navigation-corpus-policy.ts";
import { extractMarkdownFrontmatterRelationships, MARKDOWN_FRONTMATTER_BUDGET } from "../core/markdown-frontmatter.ts";
import { resolveAuthoredDocumentationReference } from "../core/frontmatter-relationships.ts";
import { normalizeToLF, splitLogicalLines, stripBom } from "../core/text-normalize.ts";
import { resolveProjectDocsContext, searchDocsWithQmd } from "../core/qmd-docs-search.ts";
import { structuredMatchContext } from "../core/structured-match-context.ts";


const GREP_MAX_TOKENS = 4_000;
// Native allocation feedback only. Acceptance always counts the complete reply.
const MATCHES_RENDER_BYTES = 16_000;

const SYNTAXES = new Set(["auto", "literal", "regex", "symbol"]);
const OUTPUTS = new Set(["ranked", "matches"]);
const CASES = new Set(["smart", "sensitive", "insensitive"]);
const VISIBILITIES = new Set(["project", "all"]);
const FOCUS_EVIDENCE = ["callers", "callees", "uses", "implementations", "documentation"];
const INITIAL_FIELDS = ["pattern", "query", "target", "paths", "syntax", "output", "case", "glob", "visibility", "contextLines", "focus"];
const CONTINUATION_FIELDS = ["cursor", "contextLines"];

// DeepSeek/Kimi-class upstreams (including opencode Zen Go gateways) require
// function parameters to have a top-level object schema. A root-level anyOf
// makes every request fail with a 400 before the model runs, so initial-search
// and cursor-continuation fields share one object schema and the two-form
// exclusivity is enforced in execute() via rejectObsoleteNavigationParams(),
// mirroring the read.ts path/paths pattern.
export const grepParams = {
  ...S.object({
    pattern: S.string("Discover code by behavior or inspect a name. Optional with target; when both are supplied, retain this question while selecting target."),
    target: S.string("Known code: preferably file:symbol (file::symbol also accepted), or a bare/qualified name. No pattern or paths required for standalone inspection."),
    query: S.string("Compatibility spelling of pattern; use pattern in new calls. Conflicting values are rejected."),
    paths: S.union([S.string(), S.array(S.string())], "Where to search: one file/directory for ranked, ordered exact targets for matches (each gets its own status line, zeros included). Omit to search the whole project root. Wildcards don't go here — use glob. ~ and ../ resolve."),
    syntax: S.string("literal = exact text (grep -F); regex = intentional pattern syntax; symbol = exact name inspection (ranked only). auto (default) respects the output and query shape: ranked questions, lowercase concepts, and identifier pipes use behavior discovery; clear names use exact symbol inspection. Explicit syntax always wins; the result reports what ran."),
    output: S.string("ranked = deep comprehension: rich live cards for an exact symbol or behavior-ranked declarations. matches = exhaustive occurrence audit with exact lines, hierarchy, counts, and cursor pages. Choose matches when every textual occurrence matters; ranked when deciding what code owns or implements something."),
    focus: S.union([S.array(S.string()), S.string(), S.object({
      target: S.string("Compatibility target spelling; prefer top-level target."),
      evidence: S.union([S.array(S.string()), S.string()]),
    }, [])], "Optional evidence priorities: ['callers','callees','uses','implementations','documentation']. Omit or use [] for the connected answer. Scalar and old nested forms are normalized; categories share one reply budget and do not discard other useful evidence."),
    case: S.string("smart (default) follows casing; sensitive = plain grep; insensitive = grep -i."),
    visibility: S.string("project (default, respects the project's ignore rules) or all (configurable ignores disabled while safety exclusions remain). Use all only when ignored content is itself the claim, or to confirm a project-scoped zero wasn't filter-caused."),
    glob: S.union([S.string(), S.array(S.string())], "Optional include/exclude glob filtering for directory candidates; exact files bypass it. Wildcards belong here, not in paths."),
    contextLines: S.number("lines around each hit, like grep -C NUM — matches only, 0-10."),
    cursor: S.string("Continue the original ranked investigation or matches audit with only this cursor. Matches alone accepts a contextLines override. Query, focus, scope and source versions are retained; changed or expired inputs require a new search."),
  }, []),
  description: "Initial grep request or cursor continuation. These forms cannot be mixed. A 'More: cursor <ID>' line means remaining evidence: call grep with ONLY cursor. Matches alone permits an optional contextLines override.",
};

export function registerGrepTool(
  pi: ExtensionAPI,
  options: { callNative?: PiNavCaller; analysisProject?: AnalysisProject } = {},
): void {
  const baseCall = options.callNative ?? callPiNav;
  // Explicit callers retain ownership of their transport. Ordinary registration
  // resolves existing indexed context without activation or per-project paths.
  const callNative: PiNavCaller = options.analysisProject
    ? request => callAnalysisNavigation(request, options.analysisProject, baseCall)
    : options.callNative ?? (request => callAnalysisNavigation(request));
  pi.registerTool({
    name: "grep",
    label: "grep",
    renderShell: "self",
    renderCall: renderGrepCall as any,
    renderResult: renderGrepResult as any,
    description: "Understand known code with target, or discover it with pattern. Prefer a returned file:symbol address when known; names also work, and pattern-only queries remain rich. Add focus:['callers','documentation'] for evidence priorities; omit it for the connected answer. Paths are optional, ranked is the default, and output:'matches' audits every eligible occurrence. Explicit literal/regex wins. Continue with cursor alone. Example: grep({target:'src/worker.ts:Worker.flush', focus:['callers','documentation']}).",
    promptGuidelines: ["Use target for known code and pattern for discovery; either is a complete request. When both appear, retain the question and exact target. Focus is an optional list, not a separate search per category. Paths constrain targets, not permitted same-project connections. Use matches for exhaustive auditing and cursor alone for retained continuation. Similarity is not binding; keep ambiguity and source/coverage limits."],
    parameters: grepParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const deadline = performance.now() + 25_000;
      const remainingBudget = () => {
        signal?.throwIfAborted();
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0) throw new Error("[pi-nav:deadline] grep request deadline exceeded");
        return remaining;
      };
      // Search, queue wait and follow-up proof calls share one cooperative budget.
      // The native bridge still owns its queue/cancellation; this never races abandoned native work.
      const callWithinDeadline: PiNavCaller = async request => {
        const output = await callNative({ ...request, timeoutMs: Math.min(request.timeoutMs ?? 25_000, remainingBudget()) });
        remainingBudget();
        return output;
      };
      const normalizations: string[] = [];
      let root: string;
      let nativeArgs: Record<string, unknown>;
      let route: string;
      let authoredPattern = "";
      // A fit retry may validate retained document bytes, but must not rerun retrieval.
      let documentationSearch: Promise<any> | undefined;
      const searchDocumentation = (sourceRoot: string, query: string, docsSignal: AbortSignal) => documentationSearch ??= (async () => {
        const context = await resolveProjectDocsContext(sourceRoot);
        if (context.status !== "ready") return { status: "unavailable", reason: context.reason, results: [] };
        const docsRoot = await realpath(context.docsRoot);
        const admittedRoot = await realpath(sourceRoot);
        const local = relative(admittedRoot, docsRoot);
        if (local === ".." || local.startsWith("../") || isAbsolute(local)) return { status: "unavailable", reason: "documentation root is outside the admitted project", results: [] };
        const found = await searchDocsWithQmd(query, { ...context.options, signal: docsSignal, callNative: callWithinDeadline });
        return { ...found, results: (found.results ?? []).map((item: any) => ({ ...item, doc_path: resolve(docsRoot, item.doc_path) })) };
      })();
      let resolvedSyntax = "";
      const continuation = typeof params.cursor === "string";
      try {
        rejectObsoleteNavigationParams("grep", params, continuation ? CONTINUATION_FIELDS : INITIAL_FIELDS);
        const normalizedRequest = continuation ? { params, targetFile: undefined, focus: undefined } : await normalizeGrepRequest(params, ctx.cwd, normalizations);
        params = normalizedRequest.params;
        const paths = params.paths;
        validatePaths(paths);
        root = grepRoot(paths ?? normalizedRequest.targetFile, ctx.cwd);
        const resolvedPaths = resolveGrepPaths(paths, ctx.cwd);
        const contextLines = params.contextLines === undefined ? undefined : normalizedInteger(params.contextLines, "grep contextLines", 0, 0, 10, normalizations);
        if (continuation) {
          const cursor = String(params.cursor ?? "").trim();
          if (!cursor) throw new ToolCallValidationError("grep cursor must not be empty.", { received: params.cursor });
          nativeArgs = compact({ cursor, contextLines });
          route = "continuation";
        } else {
          const pattern = String(params.pattern ?? "");
          if (!pattern) throw new ToolCallValidationError("grep pattern is required and must not be empty.", { received: params.pattern });
          authoredPattern = pattern;
          const syntax = normalizedEnum(params.syntax ?? "auto", "grep syntax", [...SYNTAXES], normalizations);
          resolvedSyntax = syntax;
          const output = normalizedEnum(params.output ?? "ranked", "grep output", [...OUTPUTS], normalizations);
          const caseMode = normalizedEnum(params.case ?? "smart", "grep case", [...CASES], normalizations);
          const visibility = normalizedEnum(params.visibility ?? "project", "grep visibility", [...VISIBILITIES], normalizations);
          if (output === "matches" && syntax === "symbol") throw new ToolCallValidationError("grep syntax:'symbol' is valid only with output:'ranked'.", { guidance: ["Use syntax:'literal' or 'regex' for deterministic matches output."] });
          if (output === "ranked" && contextLines !== undefined) throw new ToolCallValidationError("grep contextLines is valid only with output:'matches'.", { guidance: ["Remove contextLines or switch explicitly to output:'matches'."] });
          const focus = normalizedRequest.focus;
          if (focus && ["literal", "regex"].includes(syntax)) throw new ToolCallValidationError("grep focus selects a symbol or behavior target; it cannot override explicit literal or regex matching.");
          if (output === "matches") {
            nativeArgs = compact({ pattern, paths: resolvedPaths, syntax, output, case: caseMode, glob: params.glob, visibility, contextLines });
          } else {
            const rankedPath = rankedScope(resolvedPaths);
            nativeArgs = compact({ query: pattern, kind: syntax === "literal" ? "content" : syntax, scope: rankedPath, glob: params.glob, case: caseMode, visibility, expand: 2, focus });
          }
          route = output;
        }
      } catch (error) {
        return boundedInvalidToolCallResult("grep", asToolCallValidationError(error, {
          accepted: ["known code: {target:'src/a.ts:Name'}", "discovery: {pattern:'original question'}", "focused: {pattern:'original question', target:'src/a.ts:Name', focus:['callers','documentation']}", "audit: {pattern:'text', paths:['src/a.ts','src/b.ts'], output:'matches'}", "continuation: {cursor:'grep-…'}"],
          guidance: ["Use output:'matches' for multiple targets; ranked accepts one path.", "Use glob for wildcard filtering and keep visibility:'project' unless ignored content is the claim."],
          received: params,
        }));
      }

      try {
        if (route === "ranked" && !["literal", "regex"].includes(resolvedSyntax)
          || continuation && String(nativeArgs.cursor).startsWith("grep-ranked-")) {
          nativeArgs = { ...nativeArgs, retainRankedRender: true, rankedRenderAllowance: GREP_MAX_TOKENS };
        } else if (route === "matches" || continuation && String(nativeArgs.cursor).startsWith("grep-")) {
          nativeArgs = { ...nativeArgs, retainMatchesRender: true };
        }
        const output = await callWithinDeadline({
          root,
          operation: "pi_nav_search",
          args: nativeArgs,
          timeoutMs: 25_000,
          signal,
        });
        if (continuation) {
          route = output.structured.data.mode === "ranked" ? "ranked" : "matches";
          authoredPattern = String(output.structured.data.query ?? "");
        }
        const finish = async (output: NativeOutput, preparedUnavailable = false) => {
          const admittedOutput = output;
          await validateRankedCorpus(admittedOutput, callWithinDeadline, { signal, timeoutMs: remainingBudget() });
          const proofCall: PiNavCaller = async request => {
            await validateRankedCorpus(admittedOutput, callWithinDeadline, { signal, timeoutMs: remainingBudget() });
            return callWithinDeadline({ ...request, root: admittedOutput.sourceRoot ?? root,
              args: { ...request.args, ...(admittedOutput.corpusAdmission ? { corpusAdmission: admittedOutput.corpusAdmission } : {}) } });
          };
          remainingBudget();
          if (preparedUnavailable) {
            const diagnostic = "Prepared connections unavailable: the enriched response was refused by the output safety boundary; this result uses the saved live navigation only.";
            const { analysis: _analysis, ...data } = output.structured.data;
            output = { ...output, text: `${output.text}\n${diagnostic}`, structured: {
              ...output.structured, data, diagnostics: [...output.structured.diagnostics, diagnostic],
            } };
          }
          // Preview proof/footer first: an oversized attempt earns no source authority.
          const sourceRoot = output.sourceRoot ?? root;
          const evidence = nativeSourceEvidence(output.structured, { capability: "grep", backend: "pi-nav", route });
          const authority = await prepareSourceAuthority({
            cwd: ctx.cwd, nativeText: output.text,
            evidence: evidence.map(item => ({ ...item, path: resolve(sourceRoot, item.path) })),
            sourceSnapshots: output.sourceSnapshots, signal, callNative: proofCall,
          });
          let authorityText = authority.text;
          if (route === "ranked" && !authority.complete) {
            const { cursor, completedGroups: _completed, remainingGroups: _remaining, ...data } = output.structured.data;
            // Remove only the generated navigation receipt, never source text.
            authorityText = authorityText.split("\n").filter(line => line !== `More: cursor ${cursor}`
              && !/^\d+ retained source\/evidence group\(s\) remain; compact locators are not completed rich evidence\.$/.test(line)).join("\n");
            const diagnostic = "Continuation withheld: required source verification is incomplete. Independently certified rows remain usable; unverified context earns no continuation credit. Read the unverified ranges before restarting the original investigation.";
            authorityText += `\n${diagnostic}`;
            output = { ...output, structured: { ...output.structured, data: { ...data, cursorUnavailable: diagnostic },
              completeness: { ...output.structured.completeness, complete: false, reason: "error" },
              diagnostics: [...output.structured.diagnostics, diagnostic] } };
          }
          const completeness = output.structured.completeness ?? {};
          const returned = Number(completeness.returned ?? 0);
          const coverage = output.structured.data?.coverage as Record<string, unknown> | undefined;
          let baseText = route === "ranked"
            ? renderRankedGrepEvidence(output.structured, sourceRoot, authoredPattern, resolvedGrepInterpretation(output.text, resolvedSyntax), String(nativeArgs.scope ?? output.structured.data.scope ?? sourceRoot), authorityText)
            : clarifyMatchesCoverage(authorityText, coverage);
          if (route === "matches" && returned === 0) {
            // A correct zero needs no source-handoff jargon — pure subtraction.
            baseText = baseText.split("\n").filter(line => !line.startsWith("Source handoff:")).join("\n");
          }
          const publicBaseText = baseText;
          const fallbackLeads = route === "ranked"
            ? eligibleExactLineLeads(output.structured, output.text, String(nativeArgs.kind ?? "auto"), evidence)
            : [];
          const exactProof = fallbackLeads.length
            ? await prepareExactLeads({ cwd: ctx.cwd, nativeText: publicBaseText,
              leads: fallbackLeads.map(lead => ({ ...lead, path: resolve(sourceRoot, lead.path) })),
              signal, callNative: proofCall })
            : { text: publicBaseText, promoted: false, artifacts: [] as string[], reason: undefined, commit: () => {} };
          const coverageComplete = coverage?.complete !== false && completeness.complete !== false;
          const total = Number.isFinite(Number(completeness.total)) ? Number(completeness.total) : undefined;
          const replacementComplete = route === "matches"
            ? coverageComplete && !Boolean(coverage?.more)
            : coverageComplete && (total === undefined || returned >= total);
          const literalRegexTokenZero = returned === 0
            && (resolvedSyntax === "literal" || /Resolved:\s*literal\b/i.test(output.text))
            && regexLookingToken(authoredPattern);
          const interpretation = route === "ranked" && !authority.complete
            ? "" // The specific certification diagnostic above already explains this refusal.
            : route === "ranked" && !coverageComplete
              ? output.structured.data.cursor
                ? "\n\nRanked answer is partial; remaining retained evidence is available through the returned cursor."
                : "\n\nRanked answer is incomplete; see its source, coverage and budget diagnostics. Scoped absence is not established."
              : literalRegexTokenZero
            ? `\n\nLiteral-pattern guidance: ${JSON.stringify(authoredPattern)} contains regex-looking tokens, but Resolved: literal means they were searched as ordinary text. If alternation or grouping was intended, issue one intentional syntax:'regex' request; do not repeat the unchanged literal zero.`
            : returned === 0 && route === "ranked"
              ? `\n\nSearch interpretation: zero visible ranked matches in the executed filtered scope; inspect Resolved/Filter and completeness before changing evidence class.`
              : !coverageComplete
                ? `\n\nSearch interpretation: scan coverage is partial; returned matches remain usable, but scoped absence is not established.`
                : route === "ranked" && total !== undefined && returned < total
                  ? output.structured.data.cursor
                    ? "\n\nRanked page is partial; remaining evidence is available through the returned cursor."
                    : `\n\nRanked page is partial: ${total - returned} further result(s) were not returned; no continuation was retained. Coverage limits remain explicit.`
                  : "";
          const visibilityGuidance = returned === 0
            && replacementComplete
            && String(nativeArgs.visibility ?? output.structured.data.visibility ?? (output.structured.data.resolved as any)?.visibility ?? "project") === "project"
            ? `\n\nIgnored content was not searched. Retry explicitly with visibility:'all' only if ignored content is relevant to the claim.`
            : "";
          const text = `${exactProof.text}${interpretation}${visibilityGuidance}`;
          const status = coverageComplete && (returned > 0 || replacementComplete) ? "success" : "warning";
          const artifacts = [...authority.authorities.map(item => `[${item.path}#${item.tag}]`), ...exactProof.artifacts];
          remainingBudget();
          const envelope = harnessEnvelope({
            status,
            summary: returned > 0
              ? replacementComplete ? "Exact search completed." : "Exact search returned a stable page with continuation or bounded omissions."
              : replacementComplete ? "Exact search completed with zero matches in its reported scope." : "Exact search returned no complete replacement set.",
            next_actions: literalRegexTokenZero ? ["If regex semantics were intended, retry once with syntax:'regex'; otherwise keep the literal zero as executed evidence."] : [],
            artifacts: [...new Set(artifacts)],
            diagnostics: [...(output.structured.diagnostics ?? []), ...(literalRegexTokenZero ? ["literal_zero_contains_regex_looking_tokens"] : []), ...(exactProof.reason ? [`source_proof=${exactProof.reason}`] : [])],
          });
          const attach = !preparedUnavailable && !continuation && route === "ranked"
            && !["literal", "regex"].includes(resolvedSyntax)
            && nativeArgs.visibility !== "all"
            && !(Array.isArray(nativeArgs.glob) ? nativeArgs.glob.length : nativeArgs.glob)
            && ["symbol", "fuzzy"].includes(String(output.structured.data.kind));
          // All model-facing additions, including input repairs, precede the exact count.
          const normalized = withToolCallNormalizations({ content: [{ type: "text", text }], details: {} as Record<string, unknown> }, normalizations, true);
          const baselineText = normalized.content[0]!.text;
          const baseline = nativeToolResult(baselineText, output.structured, envelope, normalized.details);
          let result = baseline;
          const keyContext: string[] = [];
          if (route === "matches" && baseline.details.envelope.status !== "error") {
            for (const certified of authority.authorities) {
              const source = authority.sourceSnapshots.find(item => item.canonicalPath === certified.evidence.canonicalPath);
              if (!source) continue;
              const rows = nativeRecords(output.structured.data.groups)
                .filter(group => typeof group.path === "string" && [certified.evidence.path, certified.evidence.canonicalPath].includes(resolve(sourceRoot, group.path)))
                .flatMap(group => nativeRecords(group.matches))
                .flatMap(row => typeof row.text === "string" && !row.textClipped && certified.evidence.rows.some(shown => shown.line === row.line && shown.text === row.text)
                  ? [{ line: Number(row.line), text: row.text, spans: nativeRecords(row.spans).flatMap(span =>
                    typeof span.startByte === "number" && typeof span.endByte === "number" ? [{ startByte: span.startByte, endByte: span.endByte }] : []) }] : []);
              const labels = structuredMatchContext(source.text, extname(source.canonicalPath), rows);
              if (labels.length) keyContext.push(`${JSON.stringify(certified.path)}\n${labels.map(label => `  L${label.line}: ${label.path}`).join("\n")}`);
            }
            if (keyContext.length) {
              result = nativeToolResult(`${baselineText}\n\nSyntactic key context (matched rows only; aliases not expanded)\n${keyContext.join("\n")}`,
                output.structured, envelope, normalized.details);
              if (result.details.envelope.status === "error") result = nativeToolResult(`${baselineText}\n\nStructured key context withheld by the output byte guard; exact matches retained.`, output.structured, envelope, normalized.details);
            }
          }
          let commitAttachment: (() => void) | undefined;
          if (attach && baseline.details.envelope.status !== "error") {
            const optionalBudget = Math.floor(Math.max(0, deadline - performance.now()) / 2);
            const attachment = await capturedGrepReference({ ...output, sourceRoot }, { root: sourceRoot }, evidence, callWithinDeadline, optionalBudget, signal,
              docsSignal => searchDocumentation(sourceRoot, authoredPattern, docsSignal));
            const nativeFocus = output.structured.data.focus as Record<string, any> | undefined;
            const attachedStructured = attachment.kind && nativeFocus ? { ...output.structured, data: { ...output.structured.data,
              focus: { ...nativeFocus, evidenceStatus: { ...nativeFocus.evidenceStatus,
                documentation: attachment.kind === "association" ? "source-verified authored association; prose unverified" : "source-verified document lead; code association unverified" } } } } : output.structured;
            const attachedBaseline = attachment.kind ? baselineText.split("\n").filter(line => !line.startsWith("Requested documentation evidence unavailable:")).join("\n") : baselineText;
            result = nativeToolResult(`${attachedBaseline}\n\n${attachment.text}`, attachedStructured, envelope, normalized.details);
            if (result.details.envelope.status === "error") {
              const limited = nativeToolResult(`${baselineText}\n\nDocumentation attachment withheld by the final output byte guard; no documentation rows credited.`, output.structured, envelope, normalized.details);
              result = limited.details.envelope.status === "error" ? baseline : limited;
            } else if (attachment.evidence.length) {
              try {
                const prepared = await prepareSourceAuthority({ cwd: ctx.cwd, nativeText: "", evidence: attachment.evidence,
                  sourceSnapshots: attachment.sourceSnapshots, signal: attachment.signal,
                  callNative: async () => { throw new Error("Captured YAML certification cannot fetch source proof"); } });
                const certified = nativeToolResult(`${result.content[0].text}${prepared.text}`, attachedStructured, envelope, normalized.details);
                if (certified.details.envelope.status !== "error") { result = certified; commitAttachment = prepared.commit; }
              } catch {
                // Captured evidence remains useful without an edit-authority receipt.
              }
            }
          }
          const commitBaseline = async () => {
            await validateRankedCorpus(admittedOutput, callWithinDeadline, { signal, timeoutMs: remainingBudget() });
            remainingBudget();
            authority.commit();
            exactProof.commit();
          };
          const withoutOptionalContext = attach || keyContext.length ? nativeToolResult(`${baselineText}\n\n${attach
            ? "Documentation attachment not delivered within this reply's allowance. Use docs_search with the original question; the code cursor does not page this attachment."
            : "Structured key context withheld within this reply's allowance; exact matches retained."}`,
            output.structured, { ...envelope, status: "warning" }, normalized.details) : undefined;
          return { result, withoutOptionalContext, commitBaseline, commit: async () => {
            await commitBaseline();
            try { commitAttachment?.(); } catch { /* Optional authority never enlarges the checked reply. */ }
          } };
        };
        const fit = async (initial: NativeOutput, preparedUnavailable = false) => {
          let candidate = initial;
          const matches = route === "matches";
          let allowance = matches ? MATCHES_RENDER_BYTES : GREP_MAX_TOKENS;
          const origin = matches ? initial.matchesRenderCursor : initial.rankedRenderCursor;
          let codeOnly: { result: ReturnType<typeof nativeToolResult>; commit: () => Promise<void> } | undefined;
          for (let attempt = 0; attempt <= 8; attempt++) {
            const prepared = await finish(candidate, preparedUnavailable);
            const tokens = grepTokenCount(prepared.result.content.map(part => part.text).join("\n"));
            remainingBudget();
            if (prepared.withoutOptionalContext && prepared.withoutOptionalContext.details.envelope.status !== "error"
              && grepTokenCount(prepared.withoutOptionalContext.content.map(part => part.text).join("\n")) <= GREP_MAX_TOKENS) {
              codeOnly = { result: prepared.withoutOptionalContext, commit: prepared.commitBaseline };
            }
            if (tokens <= GREP_MAX_TOKENS) {
              if (codeOnly && candidate.rankedRenderUnavailable && Number(candidate.structured.completeness?.returned ?? 0) === 0) {
                await codeOnly.commit(); return codeOnly.result;
              }
              if (prepared.result.details.envelope.status !== "error") await prepared.commit();
              return prepared.result;
            }
            if (!origin || allowance === 1 || attempt === 8) break;
            // Feedback starts at rendered bytes, not unused capacity: a token-dense
            // complete page can be far below 16k bytes and still exceed 4k tokens.
            const usedAllowance = matches ? Math.min(allowance, Buffer.byteLength(candidate.text, "utf8")) : allowance;
            allowance = Math.max(1, Math.min(allowance - 1, Math.floor(usedAllowance * (GREP_MAX_TOKENS - 64) / tokens)));
            // This estimates allocation only; exact whole-reply counting still governs acceptance.
            candidate = await callWithinDeadline({ root: initial.sourceRoot ?? root, operation: "pi_nav_search",
              args: matches ? { renderMatches: origin, matchesRenderBytes: allowance }
                : { renderRanked: origin, rankedRenderAllowance: allowance,
                  ...(initial.corpusAdmission ? { corpusAdmission: initial.corpusAdmission } : {}) }, signal });
            if ((matches ? candidate.matchesRenderCursor : candidate.rankedRenderCursor) !== origin) {
              throw new Error(`[pi-nav:malformed_output] ${route} fitting changed its original progress handle`);
            }
          }
          if (codeOnly) { await codeOnly.commit(); return codeOnly.result; }
          const fitting = origin ? "Retained rendering reached its bounded fitting limit."
            : "No eligible retained rendering was available; no render-only retry was dispatched.";
          const guidance = matches ? "Restart the same audit in smaller path batches; the visible target ledger cannot be hidden to make it fit."
            : ["literal", "regex"].includes(resolvedSyntax)
              ? "Use output:'matches' for an exhaustive literal/regex audit, or narrow the requested path."
              : "Restart the original question with a more precise target or scope.";
          const label = matches ? "Matches" : "Ranked";
          return nativeToolResult(`${label} output incomplete: the fully composed page could not be delivered within the 4,000-reference-token whole-reply ceiling. ${fitting} No source rows or continuation progress from the withheld output were credited. ${guidance} No recollection was performed.`,
            { schemaVersion: 1, operation: "pi_nav_search", data: {}, diagnostics: [], completeness: { complete: false, reason: "budget", returned: 0 } },
            harnessEnvelope({ status: "error", summary: `${label} fitting could not deliver a bounded page.`, next_actions: [], artifacts: [] }));
        };
        let result = await fit(output);
        if (output.liveFallback && result.details.envelope.status === "error") result = await fit(output.liveFallback, true);
        return result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const capGuidance = /response_too_large/i.test(reason)
          ? route === "matches"
            ? "\nAudit incomplete: no exact result page was delivered. Retry the cursor with contextLines:0, or restart the same audit in smaller path batches. A ranked overview cannot replace exhaustive matches."
            : route === "continuation" ? "\nNo continuation page was delivered."
              : "\nNo ranked page was delivered; see the output safety limitation above."
          : "";
        const envelope = harnessEnvelope({ status: "error", summary: "Exact search failed; no fallback used.", next_actions: ["Use navigation-debug if this failure is unexpected."], artifacts: [] });
        const errorResult = nativeToolResult(`ERROR: exact search failed.\nReason: ${reason}${capGuidance}\nNo scanner, command, PATH, build, or navigation fallback was used.`,
          { schemaVersion: 1, operation: "pi_nav_search", data: {}, completeness: { complete: false, returned: 0 }, diagnostics: [] }, envelope);
        return grepTokenCount(errorResult.content[0].text) <= GREP_MAX_TOKENS ? errorResult
          : resultText("ERROR: exact search failed. The detailed diagnostic was withheld because it exceeds the 4,000-reference-token reply ceiling. No result page or continuation progress was delivered; no fallback was used.", envelope);
      }
    },
  });
}

/** A bounded source-validated authored association, optionally discovered through QMD. */
async function capturedGrepReference(
  output: NativeOutput, project: Pick<AnalysisProject, "root">, visible: ReturnType<typeof nativeSourceEvidence>,
  callNative: PiNavCaller, budgetMs: number, parentSignal?: AbortSignal,
  searchDocumentation?: (signal: AbortSignal) => Promise<any>,
): Promise<{ text: string; kind?: "association" | "lead"; evidence: ReturnType<typeof nativeSourceEvidence>; sourceSnapshots: NativeSourceSnapshot[]; signal: AbortSignal }> {
  const signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(Math.max(1, budgetMs))]);
  const deadline = performance.now() + budgetMs;
  const remaining = () => {
    signal.throwIfAborted();
    const time = Math.floor(deadline - performance.now());
    if (time <= 0) throw new Error("optional documentation deadline exceeded");
    return time;
  };
  let retrievalNote = "QMD retrieval not exercised.";
  const limited = (reason: string) => ({ text: `Authored references limited: ${reason}; not a documentation-absence claim. ${retrievalNote}`, evidence: [], sourceSnapshots: [], signal });
  const call: PiNavCaller = async request => {
    const result = await callNative({ ...request, signal, timeoutMs: Math.min(request.timeoutMs ?? remaining(), remaining()) });
    remaining();
    return result;
  };
  try {
    remaining();
    const root = await realpath(project.root);
    if (await realpath(output.sourceRoot ?? project.root) !== root) return limited("search and candidate project roots differ");
    const local = (path: string) => relative(root, path).replaceAll("\\", "/");
    const inside = (path: string) => { const value = local(path); return value !== "" && value !== ".." && !value.startsWith("../") && !isAbsolute(value); };
    const definitions = new Set<string>();
    const documents = new Set<string>();
    const matches = Array.isArray(output.structured.data.matches) ? output.structured.data.matches : [];
    for (const match of matches as any[]) {
      if (typeof match?.location?.path !== "string") continue;
      const path = resolve(root, match.location.path);
      if (!inside(path)) continue;
      if (/\.md$/i.test(path)) documents.add(path);
      else if (match.role === "definition") definitions.add(path);
    }
    if (!definitions.size) return limited("no code definition was returned");
    const docsCensus = await enumerateNavigationCorpus(root, "docs", call, { signal, timeoutMs: remaining() });
    const codeCensus = await enumerateNavigationCorpus(root, "code", call, { signal, timeoutMs: remaining() });
    const docsAllowed = new Set(docsCensus.files.map(path => resolve(root, path)));
    const codeAllowed = new Set(codeCensus.files.map(path => resolve(root, path)));
    const retrievedSections = new Map<string, { start: number; end: number; selector: string; hash: string; hasExplanation: boolean }>();
    const extraSnapshots: NativeSourceSnapshot[] = [];
    if (searchDocumentation) {
      const found = await searchDocumentation(signal).catch(() => ({ status: "unavailable", reason: "optional QMD query failed", results: [] }));
      remaining();
      retrievalNote = `QMD: ${found.status ?? "unavailable"}; semantics=${found.semantic?.status ?? "unavailable"}; privacy=${found.privacy ?? "local_index"}; generation=${found.generation ?? "unavailable"}; omitted=${Number(found.omissions?.count ?? 0)}. ${found.reason ?? "Similarity supplies leads, not a code binding."}`;
      for (const item of (found.results ?? []).slice(0, 3)) {
        const path = resolve(root, String(item.doc_path ?? ""));
        // Keep QMD's ranking, but do not let a metadata-only hit hide an
        // explanatory section of that same document. QMD already strips
        // frontmatter/headings from its display snippet; no second parser.
        const hasExplanation = item.selector !== "@preamble" && Boolean(item.project_navigation?.qmd?.snippet?.trim());
        const previous = retrievedSections.get(path);
        if (previous && (previous.hasExplanation || !hasExplanation)) continue;
        if (!inside(path) || !docsAllowed.has(path) || await realpath(path) !== path) continue;
        if (!Number.isSafeInteger(item.start_line) || !Number.isSafeInteger(item.end_line) || item.start_line < 1 || item.end_line < item.start_line) continue;
        const cached = extraSnapshots.find(source => source.canonicalPath === path);
        const candidates = cached ? [cached] : (await call({ root, operation: "pi_nav_source_proof", args: { paths: [path] } })).sourceSnapshots;
        const snapshot = candidates?.find(source => source.canonicalPath === path && source.rawDigest.toUpperCase() === String(item.content_hash).toUpperCase());
        if (!snapshot) continue;
        documents.add(path);
        if (!cached) extraSnapshots.push(snapshot);
        retrievedSections.set(path, { start: item.start_line, end: item.end_line, selector: `${local(path)}:${item.selector === "@preamble" ? `${item.start_line}-${item.end_line}` : item.selector}`, hash: snapshot.rawDigest, hasExplanation });
      }
    }
    if (!documents.size) return limited("no admitted current documentation candidate");
    const snapshots = new Map<string, NativeSourceSnapshot>();
    const duplicates = new Set<string>();
    for (const source of [...extraSnapshots, ...(output.sourceSnapshots ?? []).filter(source => !retrievedSections.has(source.canonicalPath))].slice(0, MAX_SOURCE_PROOF_FILES)) {
      remaining();
      const path = source.canonicalPath;
      if (!isAbsolute(path) || !inside(path) || (!documents.has(path) && !definitions.has(path))) continue;
      if (snapshots.has(path)) { duplicates.add(path); continue; }
      if (Buffer.byteLength(source.text, "utf8") > MAX_SOURCE_PROOF_FILE_BYTES
        || createHash("sha256").update(source.text).digest("hex").toUpperCase() !== source.rawDigest
        || source.bom !== source.text.startsWith("\ufeff") || source.lineEnding !== (source.text.includes("\r\n") ? "crlf" : "lf")
        || await realpath(path) !== path) continue;
      snapshots.set(path, source);
    }
    for (const path of duplicates) snapshots.delete(path);
    const code = new Map([...snapshots].filter(([path]) => definitions.has(path)));
    const docs = [...snapshots].filter(([path]) => documents.has(path));
    if (!code.size || !docs.length) return limited("required same-output snapshots are missing or invalid");
    let unboundSection: { path: string; snapshot: NativeSourceSnapshot; text: string; rows: ReturnType<typeof nativeSourceEvidence>[number]["rows"] } | undefined;
    let reason = "no verified association within the returned captured candidates";
    let attempts = 0;
    for (const [path, snapshot] of docs) {
      remaining();
      if (!docsAllowed.has(path)) { reason = "returned documentation is not admitted"; continue; }
      const { lines } = splitLogicalLines(normalizeToLF(stripBom(snapshot.text).text));
      const section = retrievedSections.get(path);
      const sectionRows = section && section.end <= lines.length
        ? lines.slice(section.start - 1, section.end).map((text, index) => ({ line: section.start + index, text, visibility: "visible_complete" as const, transformation: "verbatim" as const })) : [];
      const sectionText = sectionRows.map(row => `${row.line}:${row.text}`).join("\n");
      const sectionFits = Buffer.byteLength(sectionText, "utf8") <= MARKDOWN_FRONTMATTER_BUDGET;
      if (!unboundSection && section && sectionFits && sectionRows.length) {
        const text = `QMD document lead: ${section.selector}\nSimilarity is not a code association; authored claims are unverified.\nDocument SHA-256: ${snapshot.rawDigest}\n${sectionText}\n${retrievalNote}`;
        if (Buffer.byteLength(text, "utf8") <= MARKDOWN_FRONTMATTER_BUDGET) unboundSection = { path, snapshot, text, rows: sectionRows };
      }
      for (const authored of extractMarkdownFrontmatterRelationships(lines)) {
        remaining();
        if (++attempts > MAX_SOURCE_PROOF_FILES) return limited("captured-reference inspection bound reached");
        const rows = lines.slice(authored.interval.start - 1, authored.interval.end).map((text, index) => ({ line: authored.interval.start + index, text, visibility: "visible_complete" as const, transformation: "verbatim" as const }));
        if (Buffer.byteLength(rows.map(row => `${row.line}:${row.text}`).join("\n"), "utf8") > MARKDOWN_FRONTMATTER_BUDGET) { reason = "complete authored rows exceed the existing frontmatter allowance"; continue; }
        const resolution = await resolveAuthoredDocumentationReference({ projectRoot: root,
          reference: { form: "frontmatter", field: authored.field, value: authored.value,
            site: { path, sourceHash: snapshot.rawDigest, interval: authored.interval, startOffset: authored.startOffset, endOffset: authored.endOffset } },
          signal, callNative: call,
          admit: request => request.role === "document"
            ? request.path === path && docsAllowed.has(request.path) && docsAllowed.has(request.requestedPath)
            : code.has(request.path) && codeAllowed.has(request.path) && codeAllowed.has(request.requestedPath),
        });
        remaining();
        if (resolution.status !== "valid" || !resolution.target) { reason = "authored target was unmatched, excluded or unresolved"; continue; }
        const target = resolution.target;
        if (target.sourceHash.toUpperCase() !== code.get(target.path)?.rawDigest) { reason = "resolved target differs from its returned code snapshot"; continue; }
        if (target.kind === "selection" && !matches.some((match: any) => match.role === "definition"
          && resolve(root, match.location?.path ?? "") === target.path
          && target.intervals.some(interval => interval.start <= Number(match.location?.end ?? match.location?.start) && interval.end >= Number(match.location?.start)))) {
          reason = "authored selector does not select a returned definition";
          continue;
        }
        const alreadyShown = new Map(visible.filter(item => resolve(root, item.path) === path).flatMap(item => item.rows).map(row => [row.line, row]));
        const shownRows = [...new Map([...rows, ...(sectionFits ? sectionRows : [])].map(row => [row.line, row])).values()].sort((a, b) => a.line - b.line);
        const newRows = shownRows.filter(row => {
          const prior = alreadyShown.get(row.line);
          return !prior || prior.text !== row.text || prior.visibility !== "visible_complete" || prior.transformation !== "verbatim";
        });
        const range = `${authored.interval.start}-${authored.interval.end}`;
        const targetLabel = target.kind === "file" ? "File mention" : "Resolved selection in returned file (not graph/symbol binding)";
        const text = ["Authored references in captured source; prose unverified",
          `${local(path)}:${range} · ${authored.field}: ${JSON.stringify(authored.value)}`,
          section ? `Retrieved section: ${section.selector} · ${section.start}-${section.end}${sectionFits ? "" : " (section withheld: use this read selector)"}` : "Captured document candidate",
          `Document SHA-256: ${snapshot.rawDigest}`,
          newRows.length ? newRows.map(row => `${row.line}:${row.text}`).join("\n") : "YAML site already shown in this reply.",
          `${targetLabel}: ${local(target.path)}${target.kind === "selection" ? `:${target.intervals.map(interval => `${interval.start}-${interval.end}`).join(",")}` : ""}`,
          `Target SHA-256: ${target.sourceHash}`,
          `Coverage: first eligible authored association; other associations unassessed. ${retrievalNote}`,
        ].join("\n");
        if (Buffer.byteLength(text, "utf8") > MARKDOWN_FRONTMATTER_BUDGET) { reason = "attachment exceeds the existing frontmatter allowance"; continue; }
        // The digest covers explicit policy files, not every nested .gitignore: repeat the native census.
        const finalDocs = await enumerateNavigationCorpus(root, "docs", call, { signal, timeoutMs: remaining() });
        const finalCode = await enumerateNavigationCorpus(root, "code", call, { signal, timeoutMs: remaining() });
        if (finalDocs.digest !== docsCensus.digest || finalCode.digest !== codeCensus.digest
          || !finalDocs.files.includes(local(path)) || !finalCode.files.includes(local(target.path))
          || await realpath(path) !== path || await realpath(target.path) !== target.path) return limited("admission changed during attachment");
        remaining();
        if (retrievedSections.has(path)) {
          const currentDoc = await call({ root, operation: "pi_nav_source_proof", args: { paths: [path] } });
          if (!currentDoc.sourceSnapshots?.some(source => source.canonicalPath === path && source.rawDigest === snapshot.rawDigest)) return limited("document source changed during attachment");
        }
        return { text, kind: "association", signal, sourceSnapshots: [snapshot], evidence: newRows.length ? [{ path, rows: newRows, provenance: { capability: "grep", backend: "pi-nav", route: "captured-authored-reference" } }] : [] };
      }
    }
    if (unboundSection) {
      const finalDocs = await enumerateNavigationCorpus(root, "docs", call, { signal, timeoutMs: remaining() });
      const proof = await call({ root, operation: "pi_nav_source_proof", args: { paths: [unboundSection.path] } });
      if (finalDocs.digest !== docsCensus.digest || !finalDocs.files.includes(local(unboundSection.path))
        || !proof.sourceSnapshots?.some(source => source.canonicalPath === unboundSection.path && source.rawDigest === unboundSection.snapshot.rawDigest)) return limited("document source or admission changed");
      return { text: `${unboundSection.text}\nCode association unavailable: ${reason}.`, kind: "lead", signal,
        sourceSnapshots: [unboundSection.snapshot], evidence: [{ path: unboundSection.path, rows: unboundSection.rows,
          provenance: { capability: "grep", backend: "qmd", route: "document-section-lead" } }] };
    }
    return limited(reason);
  } catch {
    return limited("admission, captured-source validation or optional deadline unavailable");
  }
}

/** Recover only request shapes whose meaning is explicit; identity and scope stay strict. */
async function normalizeGrepRequest(input: any, cwd: string, notices: string[]): Promise<{
  params: any; targetFile?: string; focus?: { target?: string; evidence?: string[] };
}> {
  const params = { ...input };
  if (params.query !== undefined) {
    if (params.pattern !== undefined && params.pattern !== params.query) throw new ToolCallValidationError("grep pattern and query disagree; supply the intended question once.");
    params.pattern = params.query;
    delete params.query;
    notices.push("query → pattern");
  }
  const nested = params.focus && typeof params.focus === "object" && !Array.isArray(params.focus) ? params.focus : undefined;
  if (nested) {
    rejectObsoleteNavigationParams("grep focus", nested, ["target", "evidence"]);
    if (params.target !== undefined && nested.target !== undefined && params.target !== nested.target) throw new ToolCallValidationError("grep target and nested focus.target disagree; choose one target.");
    params.target ??= nested.target;
    notices.push("nested focus → target and evidence list");
  }
  for (const field of ["pattern", "target"]) {
    if (params[field] !== undefined && (typeof params[field] !== "string" || !params[field].trim() || params[field].includes("\0"))) {
      throw new ToolCallValidationError(`grep ${field} must be a non-empty string without NUL.`);
    }
  }
  const rawFocus = nested ? nested.evidence : params.focus;
  const entries = rawFocus === undefined ? [] : Array.isArray(rawFocus) ? rawFocus : typeof rawFocus === "string" ? rawFocus.split(",") : undefined;
  if (!entries || entries.some(value => typeof value !== "string")) throw new ToolCallValidationError("grep focus must be evidence names or a list of names.");
  const evidence: string[] = [];
  for (const entry of entries) {
    const value = entry.trim().toLowerCase();
    if (!FOCUS_EVIDENCE.includes(value)) { notices.push(`unknown focus ${JSON.stringify(entry)} was not fulfilled`); continue; }
    if (!evidence.includes(value)) evidence.push(value);
  }
  if (rawFocus !== undefined && JSON.stringify(rawFocus) !== JSON.stringify(evidence)) notices.push(`focus normalized to ${JSON.stringify(evidence)}`);
  const output = normalizedEnum(params.output ?? "ranked", "grep output", [...OUTPUTS], notices);
  const syntax = normalizedEnum(params.syntax ?? "auto", "grep syntax", [...SYNTAXES], notices);
  params.output = output;
  params.syntax = syntax;
  if (output === "matches" || ["literal", "regex"].includes(syntax)) {
    if (params.focus !== undefined) notices.push("ranked focus not applied to explicit text matching");
    if (params.target !== undefined && params.pattern !== undefined && !nested) throw new ToolCallValidationError("An exact code target cannot change explicit text matching. Use pattern and paths for the audit, or omit explicit text matching for target inspection.");
    if (params.pattern === undefined && params.target !== undefined) {
      params.pattern = params.target;
      notices.push("target text used as the explicit matching pattern");
    }
    return { params };
  }
  let targetFile: string | undefined;
  let target = params.target as string | undefined;
  let targetName = target;
  if (target) {
    const addressed = await grepTargetAddress(target, cwd);
    if (addressed) {
      targetFile = addressed.path;
      targetName = addressed.name;
      target = `${addressed.path}::${addressed.name}`;
    } else if (/\s/.test(target.trim())) {
      if (params.pattern !== undefined) throw new ToolCallValidationError("grep target must select code when pattern supplies a question; clarify the target.");
      target = undefined;
      notices.push("behavior prose in target used as pattern");
    }
    if (params.pattern === undefined) {
      params.pattern = targetName;
      if (target && syntax === "auto") params.syntax = "symbol";
    }
  }
  if (!params.pattern) throw new ToolCallValidationError("grep needs a pattern or target; focus alone does not identify a subject.");
  return { params, targetFile, ...((target || evidence.length) ? { focus: { ...(target ? { target } : {}), ...(evidence.length ? { evidence } : {}) } } : {}) };
}

/** Split only a recognizable file boundary, never the colons in a qualified name. */
async function grepTargetAddress(target: string, cwd: string): Promise<{ path: string; name: string } | undefined> {
  const candidates: Array<{ path: string; name: string; exists: boolean }> = [];
  for (const match of target.matchAll(/:+/g)) {
    const prefix = target.slice(0, match.index);
    if (!prefix) continue;
    const recognizablePath = /[\\/]/.test(prefix) || /\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|[ch]|cc|cpp|hpp|php|kts?|zig|swift|exs?|rb|md)$/i.test(prefix);
    const name = target.slice(match.index! + match[0].length).trim();
    if (!name) throw new ToolCallValidationError("grep file target is missing its symbol name.");
    const path = resolveGrepTarget(prefix, cwd);
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    // Existing file identity outranks suffix hints: language priorities must
    // not hide native-supported or extensionless files. Keep hints only for
    // missing-file diagnostics, and leave non-file qualified names intact.
    if (!info?.isFile() && !recognizablePath) continue;
    candidates.push({ path, name, exists: Boolean(info?.isFile()) });
  }
  const existing = candidates.filter(candidate => candidate.exists);
  if (existing.length > 1 || (!existing.length && candidates.length > 1)) throw new ToolCallValidationError("grep target has an ambiguous file/symbol separator; use an unambiguous existing file address.");
  return existing[0] ?? candidates[0];
}

function rankedScope(paths: unknown): string | undefined {
  if (paths === undefined) return undefined;
  if (typeof paths === "string") return paths;
  if (Array.isArray(paths) && paths.length === 1) return String(paths[0]);
  if (Array.isArray(paths) && paths.length > 1) {
    throw new ToolCallValidationError("grep output:'ranked' accepts one path, but multiple targets were supplied.", { received: paths, guidance: ["Use output:'matches' for an ordered multi-target audit, or choose one ranked discovery scope."] });
  }
  return undefined;
}

function validatePaths(paths: unknown): void {
  if (paths === undefined || typeof paths === "string" && paths.length > 0) return;
  if (!Array.isArray(paths) || paths.length === 0 || paths.some(path => typeof path !== "string" || !path)) {
    throw new ToolCallValidationError("grep paths must be a non-empty string or array of non-empty strings.", { received: paths });
  }
}
// ponytail: root follows the search location (mirrors find.ts:38 + resolveNavigationScope)
// so an explicitly supplied out-of-root path is confined to its own tree instead of
// rejected. Relative paths anchor to the tool cwd (NOT process.cwd, which broke temp-cwd
// tests); no paths => whole-project scan against the session project root (unchanged).
function grepRoot(paths: unknown, cwd: string): string {
  const raw = typeof paths === "string" ? paths
    : Array.isArray(paths) && paths.length ? String(paths[0])
    : undefined;
  if (!raw) return detectProjectRoot(cwd).root;
  return detectProjectRoot(resolveGrepTarget(raw, cwd)).root;
}

// Resolve user paths (including ../, ~, and in-project relative) against cwd
// before handing them to the native scanner. The native receives `root`
// (detected project root, often an ancestor of cwd) and treats relative paths as
// resolvable against that root, so a raw "../sibling" or "~/x" target escapes
// the wrong base and returns ENOENT. find/ls resolve via resolveNavigationScope
// (same ~ expansion + cwd join); grep keeps the same intent with its own
// multi-target-aware resolver. Existence is the native's job (per-target status).
function resolveGrepTarget(path: string, cwd: string): string {
  if (path.startsWith("~")) return join(homedir(), path.startsWith("~/") ? path.slice(2) : path.slice(1));
  return isAbsolute(path) ? path : resolve(cwd, path);
}
function resolveGrepPaths(paths: unknown, cwd: string): string | string[] | undefined {
  if (paths === undefined) return undefined;
  if (typeof paths === "string") return resolveGrepTarget(paths, cwd);
  if (Array.isArray(paths)) return paths.map((path) => resolveGrepTarget(String(path), cwd));
  return undefined;
}


function eligibleExactLineLeads(structured: any, nativeText: string, kind: string, evidence: ReturnType<typeof nativeSourceEvidence>): any[] {
  const completeness = structured?.completeness ?? {};
  const returned = Number(completeness.returned ?? 0);
  const total = Number.isFinite(Number(completeness.total)) ? Number(completeness.total) : undefined;
  if (completeness.complete === false || completeness.reason === "candidate_cap" || (total !== undefined && returned < total)) return [];
  const alreadyVisible = new Set(evidence.flatMap(item => item.rows.map(row => `${item.path}:${row.line}`)));
  const matches = Array.isArray(structured?.data?.matches) ? structured.data.matches : [];
  const candidates: Array<{ path: string; start: number; end: number; label: string }> = [];
  const observedShapes = new Set<string>();
  for (const match of matches) {
    const location = match?.location;
    const path = typeof location?.path === "string" ? location.path : undefined;
    const start = Number(location?.start);
    const end = Number(location?.end ?? start);
    const role = String(match?.role ?? location?.role ?? "");
    if (!path || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) continue;
    if (alreadyVisible.has(`${path}:${start}`)) continue;
    const signature = kind === "symbol" && /definition|implementation|test/i.test(role) && end - start <= 3;
    const exactLine = (kind === "content" || kind === "regex" || kind === "auto") && start === end;
    if (!signature && !exactLine) continue;
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const visible = new RegExp(`${escapedPath}:${start}(?:\\b|-)`).test(nativeText)
      || new RegExp(`\\[${start}\\]`).test(nativeText) && nativeText.includes(path);
    if (!visible) continue;
    observedShapes.add(`${/definition|implementation|test/i.test(role) ? "symbol" : "match"}:${end - start}`);
    candidates.push({ path, start, end, label: `${role || kind} exact search match` });
  }
  const shapes = new Set(candidates.map(item => `${item.start === item.end ? "line" : "signature"}:${item.end - item.start}`));
  return observedShapes.size <= 1 && shapes.size <= 1 ? candidates.slice(0, 8) : [];
}

function renderRankedGrepEvidence(structured: any, root: string, pattern: string, interpretation: string, scope = root, certifiedNativeText?: string): string {
  const data = structured?.data ?? {};
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const completeness = structured?.completeness ?? {};
  const coverage = data.coverage ?? {};
  const returned = Number.isFinite(Number(completeness.returned)) ? Number(completeness.returned) : matches.length;
  const total = Number.isFinite(Number(completeness.total)) ? Number(completeness.total) : undefined;
  const omitted = Number(completeness.omitted ?? 0) || Math.max(0, (total ?? returned) - returned);
  const complete = completeness.complete !== false && coverage.complete !== false && omitted === 0 && (total === undefined || returned >= total);
  const searchKind = String(data.kind ?? "");
  const label = searchKind === "fuzzy" ? "Ranked behavior search" : "Ranked exact search";
  const lines = [
    `${label}: ${JSON.stringify(pattern)}`,
    `Scope: ${compactGrepPath(scope, root)} · Resolved: ${interpretation || "auto"} · Coverage: ${returned}${total === undefined ? "" : `/${total}`} result(s)${omitted ? ` · ${omitted} omitted` : ""} · ${complete ? "complete" : "partial"}`,
  ];
  if (certifiedNativeText) return [...lines, "", certifiedNativeText].join("\n");
  if (!matches.length) return [...lines, "", "No ranked matches."].join("\n");
  lines.push("", "Definitions and usages");
  for (const [index, match] of matches.slice(0, 12).entries()) {
    const location = match?.location ?? {};
    const path = compactGrepPath(String(location.path ?? match?.path ?? "?"), root);
    const start = Number(location.start ?? match?.start ?? 0) || undefined;
    const end = Number(location.end ?? match?.end ?? start ?? 0) || start;
    const site = `${path}${start ? `:${start}${end && end !== start ? `-${end}` : ""}` : ""}`;
    const name = String(match?.symbol ?? match?.name ?? location.label ?? match?.qualified_name ?? match?.qualifiedName ?? match?.role ?? "match");
    const role = String(match?.role ?? location.role ?? match?.kind ?? "match");
    const qualified = String(match?.qualified_name ?? match?.qualifiedName ?? "");
    const roleText = role === name ? "" : ` · ${role}`;
    lines.push(`${index + 1}. ${name}${roleText} · ${site}${qualified && qualified !== name ? ` · ${compactGrepPath(qualified, root)}` : ""}`);
  }
  if (matches.length > 12) lines.push(`… ${matches.length - 12} more ranked row(s) omitted from public text; structured details retain them.`);
  return lines.join("\n");
}

function renderRankedCertifiedSource(authorities: Array<{ path: string; tag: string; evidence: { rows: Array<{ line: number; text: string }> } }>): string {
  const lines: string[] = [];
  let remaining = 12;
  for (const authority of authorities) {
    const rows = authority.evidence.rows.slice(0, remaining);
    if (!rows.length) continue;
    lines.push("", `[${authority.path}#${authority.tag}]`, ...rows.map(row => `${row.line}:${row.text}`));
    remaining -= rows.length;
    if (remaining === 0) break;
  }
  return lines.length ? `\n\nCertified current source${lines.join("\n")}` : "";
}

function clarifyMatchesCoverage(text: string, coverage: any): string {
  const hasMore = Boolean(coverage?.more) || /^More: cursor\s+/m.test(text);
  if (!hasMore) return text;
  return text.replace(/^Coverage:\s*complete\s*·/m, "Coverage: scan complete · result page incomplete ·");
}

function resolvedGrepInterpretation(nativeText: string, fallback: string): string {
  return nativeText.match(/^Resolved:\s*(.+)$/mi)?.[1]?.trim() || fallback;
}

function compactGrepPath(value: string, root: string): string {
  if (!value) return value;
  const normalized = value.replace(/\\/g, "/");
  const rootNormalized = root.replace(/\\/g, "/").replace(/\/$/, "");
  const canonicalRoot = canonicalProjectPath(root).replace(/\\/g, "/").replace(/\/$/, "");
  const canonicalValue = isAbsolute(value) ? canonicalProjectPath(value).replace(/\\/g, "/") : normalized;
  for (const prefix of new Set([rootNormalized, canonicalRoot])) {
    if (canonicalValue === prefix || normalized === prefix) return ".";
    if (canonicalValue.startsWith(`${prefix}/`)) return canonicalValue.slice(prefix.length + 1);
    if (normalized.startsWith(`${prefix}/`)) return normalized.slice(prefix.length + 1);
  }
  if (isAbsolute(value)) {
    const rel = relative(canonicalRoot, canonicalValue).replace(/\\/g, "/");
    if (rel && !rel.startsWith("../")) return rel;
  }
  return normalized;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function regexLookingToken(pattern: string): boolean {
  return /(?:\||\(|\[[^\]]*\]|\.\*|\.\+|\{\d+(?:,\d*)?\}|\^|\$)/.test(pattern);
}

// Internal export for focused unit tests (path resolution contract). Not a public API.
export const __grepInternals = { resolveGrepPaths, renderRankedGrepEvidence, renderRankedCertifiedSource, clarifyMatchesCoverage };
