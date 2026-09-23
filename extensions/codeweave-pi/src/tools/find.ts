import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { harnessEnvelope, nativeToolResult } from "../core/harness-result.ts";
import { callPiNav, type PiNavCaller } from "../core/pi-nav-native.ts";
import { canonicalProjectPath, detectProjectRoot } from "../core/project-root.ts";
import { rejectObsoleteNavigationParams, resolveNavigationScope, resultText } from "../core/navigation-clean.ts";
import { renderFindCall, renderFindResult } from "../core/tui-render.ts";
import { S } from "../core/schema.ts";
import { asToolCallValidationError, invalidToolCallResult, normalizedEnum, normalizedInteger, ToolCallValidationError, withToolCallNormalizations } from "../core/tool-call-contract.ts";

export const findParams = S.object({
  pattern: S.string("A name fragment or glob — README.md, *.ts, src/**/*.ts, or **/*.{ts,tsx}. A plain word is a name prefix; a dotted name is an exact basename; a slash shapes an exact path; glob characters become a pattern."),
  patterns: S.array(S.string(), "A small batch of independent patterns instead of pattern; each reports its own matches and zeros."),
  scope: S.string("Directory to search under, or a path that picks the subproject. Defaults to the working directory."),
  type: S.string("Entry type: any, file, or directory. Defaults to any — filter early rather than after."),
  visibility: S.string("project (default, respects ignore rules) or all. A project-scoped zero can be filter-caused — confirm with all when absence matters."),
  sort: S.string("path for a stable hierarchy view, mtime for what changed recently. Defaults to mtime."),
  budget: S.number("Cap on how much comes back; raise only after an explicit truncation."),
}, []);

export function registerFindTool(
  pi: ExtensionAPI,
  options: { callNative?: PiNavCaller } = {},
): void {
  const callNative = options.callNative ?? callPiNav;
  pi.registerTool({
    name: "find",
    label: "find",
    renderShell: "self",
    renderCall: renderFindCall,
    renderResult: renderFindResult,
    description: "Find files and folders by name or glob — find(1) for the project. Use it when you know part of a path but not where it lives. Returns paths with size hints, never contents. A project-scoped zero is complete only under project ignore rules; retry explicitly with visibility:'all' only when ignored content matters. Example: find({pattern:'src/tools/*.ts', scope:'extensions/codeweave-pi', type:'file'}).",
    parameters: findParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const normalizations: string[] = [];
      let request: any;
      try {
        rejectObsoleteNavigationParams("find", params, ["pattern", "patterns", "scope", "type", "visibility", "sort", "budget"]);
        const pattern = typeof params.pattern === "string" ? params.pattern.trim() : "";
        const patterns = Array.isArray(params.patterns) ? params.patterns.map((item: unknown) => typeof item === "string" ? item.trim() : "") : undefined;
        if (Boolean(pattern) === Boolean(patterns?.length)) throw new ToolCallValidationError("find requires exactly one of pattern or non-empty patterns.", { received: { pattern: params.pattern, patterns: params.patterns } });
        if (patterns?.some((item: string) => !item)) throw new ToolCallValidationError("find patterns must contain only non-empty strings.", { received: params.patterns });
        const type = normalizedEnum(params.type ?? "any", "find type", ["any", "file", "directory"], normalizations);
        const visibility = normalizedEnum(params.visibility ?? "project", "find visibility", ["project", "all"], normalizations);
        const sort = normalizedEnum(params.sort ?? "mtime", "find sort", ["mtime", "path"], normalizations);
        const budget = params.budget === undefined ? undefined : normalizedInteger(params.budget, "find budget", 1, 1, 1_000_000, normalizations);
        request = { ...params, pattern: pattern || undefined, patterns, type, visibility, sort, budget };
      } catch (error) {
        return invalidToolCallResult("find", asToolCallValidationError(error, { accepted: ["{pattern:'README.md', scope:'.'}", "{patterns:['*.test.mjs','docs/**/*.md'], scope:'.'}"], guidance: ["Supply pattern or patterns, never both."], received: params }));
      }
      const resolved = await resolveNavigationScope(ctx.cwd, request.scope);
      if (!resolved.ok) return resultText(resolved.text, resolved.envelope);
      if (resolved.isFile) return invalidToolCallResult("find", new ToolCallValidationError("find scope must be a directory.", { received: params.scope, guidance: ["Use read directly when the file path is already known."] }));
      const root = detectProjectRoot(resolved.scope).root;
      try {
        const nativeArgs = compact({
          pattern: request.pattern,
          patterns: request.patterns,
          scope: canonicalProjectPath(resolved.scope),
          type: request.type,
          visibility: request.visibility,
          sort: request.sort,
          budget: request.budget,
        });
        const output = await callNative({
          root,
          operation: "pi_nav_files",
          args: nativeArgs,
          timeoutMs: 20_000,
          signal,
        });
        // Filtered scans are complete only within their filters — say so where it counts.
        const text = request.visibility === "project" ? output.text.replace("— complete", "— complete under project ignore rules") : output.text;
        const completeness = output.structured.completeness;
        const complete = completeness.complete !== false;
        const returned = Number(completeness.returned ?? 0);
        const interpretation = returned === 0
          ? `\n\nDiscovery interpretation: zero matches for the executed scope, visibility=${String(request.visibility)}, and native pattern normalization; this is not an exact known-path existence check.${request.visibility === "project" ? " Retry explicitly with visibility:'all' only if ignored content is relevant to the claim." : ""}`
          : !complete ? `\n\nDiscovery interpretation: scan incomplete (${String(completeness.reason ?? "unknown")}); returned candidates are usable but absence is not established.` : "";
        const patternOutcomes = renderPatternOutcomes(output.structured);
        return withToolCallNormalizations(nativeToolResult(`${text}${patternOutcomes}${interpretation}`, output.structured, harnessEnvelope({
          status: complete ? "success" : "warning",
          summary: complete ? "Path discovery completed." : "Path discovery returned an honest partial result.",
          next_actions: [],
          artifacts: [],
          diagnostics: output.structured.diagnostics ?? [],
        })), normalizations);
      } catch (error) {
        return resultText(
          `ERROR: path discovery failed.\nReason: ${error instanceof Error ? error.message : String(error)}\nNo scanner, command, PATH, build, or navigation fallback was used.`,
          harnessEnvelope({ status: "error", summary: "Path discovery failed; no fallback used.", next_actions: ["Use navigation-debug if this failure is unexpected."], artifacts: [] }),
        );
      }
    },
  });
}

function renderPatternOutcomes(native: any): string {
  const patterns = Array.isArray(native?.data?.patterns) ? native.data.patterns : [];
  if (patterns.length < 2) return "";
  const entries = Array.isArray(native?.data?.entries) ? native.data.entries : [];
  const counts = patterns.map((pattern: any) => {
    const input = String(pattern?.input ?? pattern?.normalized ?? "pattern");
    const count = entries.filter((entry: any) => Array.isArray(entry?.matchedPatterns) && entry.matchedPatterns.includes(input)).length;
    return `${JSON.stringify(input)}=${count}`;
  });
  return `\nPattern outcomes: ${counts.join(" · ")}`;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
