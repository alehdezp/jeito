import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateLspPaths, type LspProgress } from "../core/lsp-validation.ts";
import { S } from "../core/schema.ts";
import { renderLspValidateCall, renderLspValidateResult } from "../core/tui-render.ts";
import { harnessEnvelope } from "../core/harness-result.ts";
import { asToolCallValidationError, invalidToolCallResult, normalizedInteger, ToolCallValidationError, withToolCallNormalizations } from "../core/tool-call-contract.ts";

export const lspValidateParams = S.object({
  paths: S.union([S.string(), S.array(S.string())], "The files or folders to check. Point it at the files you just changed and the files that use them. A folder checks every file inside it; '.' checks the whole project. Prefer naming the files — smaller and faster. A scalar is normalized to a one-item array; explicit external paths are accepted."),
  root: S.string("Where the project lives, so the right language server is used. Defaults to the working directory; it is not a subtree filter and explicit paths may be outside it."),
  limit: S.number("Most files to check in one call (1-100, default 100). A folder bigger than this reports the overflow instead of silently checking only some."),
  includeWarnings: S.boolean("true to also report warnings; default reports errors only."),
}, ["paths"]);

export function registerLspValidateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "lsp_validate",
    label: "lsp_validate",
    renderShell: "self",
    renderCall: renderLspValidateCall,
    renderResult: renderLspValidateResult,
    description: "Run LSP diagnostics on the files you name and report what the language server finds — type errors, unresolved names, warnings — with each message and where it points. Use it right after a batch of edits, before you build or run, to catch mistakes cheaply without compiling. It checks files and never modifies or runs them. Example: lsp_validate({paths:['src/tools/write.ts']}).",
    promptGuidelines: ["Read the per-file verdict. Clean means the language server found nothing wrong in that file — and nothing more. Diagnostics means it found errors, and it lists each message and where it points. Unconfirmed, Unsupported, Skipped, or Unavailable all mean not verified: treat those files as unchecked, never as clean. A single-file check belongs inside edit (CHECK LSP); run lsp_validate after a batch of edits."],
    parameters: lspValidateParams,
    async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
      const normalizations: string[] = [];
      let paths: string[];
      let limit: number;
      let includeWarnings: boolean;
      try {
        const authored = typeof params.paths === "string" ? [params.paths] : Array.isArray(params.paths) ? params.paths : [];
        if (typeof params.paths === "string") normalizations.push("scalar paths → one-item paths array");
        const trimmed: string[] = authored.map((item: unknown) => String(item).trim()).filter((item: string) => item.length > 0);
        paths = [...new Set(trimmed)];
        if (paths.length !== trimmed.length) normalizations.push("removed duplicate paths");
        if (!paths.length) throw new ToolCallValidationError("lsp_validate requires at least one non-empty file or directory path.", { received: params.paths });
        limit = normalizedInteger(params.limit, "lsp_validate limit", 100, 1, 100, normalizations);
        if (params.includeWarnings !== undefined && typeof params.includeWarnings !== "boolean") throw new ToolCallValidationError("lsp_validate includeWarnings must be boolean.", { received: params.includeWarnings });
        includeWarnings = params.includeWarnings === true;
      } catch (error) {
        return invalidToolCallResult("lsp_validate", asToolCallValidationError(error, {
          accepted: ["focused files: {paths:['src/a.ts','src/b.ts']}", "bounded directory: {paths:['src/tools'], limit:100}", "explicit broad check: {paths:['.']}"],
          guidance: ["Validate coherent edited files or direct consumers; use '.' only when project-wide semantic readiness is the claim.", "Use includeWarnings:true only when severity 2 warnings matter."],
          received: params,
        }));
      }
      const progress = (event: LspProgress) => onUpdate?.({ content: [{ type: "text", text: renderProgress(event) }], details: { progress: event } });
      try {
        const result = await validateLspPaths({ cwd: ctx.cwd, paths, root: params.root, limit, includeWarnings, signal, onProgress: progress });
        return withToolCallNormalizations({ content: [{ type: "text" as const, text: result.text }], details: { root: result.root, files: result.files, envelope: result.envelope } }, normalizations);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `LSP validation could not start.\nReason: ${reason}\nNo file was reported clean.` }],
          details: { failure: { kind: "lsp-start-failure", reason }, envelope: harnessEnvelope({ status: "error", summary: "LSP validation did not start.", next_actions: ["Correct the root/path or narrow an over-limit directory, then retry the same focused validation."], artifacts: [], diagnostics: [reason] }) },
        };
      }
    },
  });
}

function renderProgress(progress: LspProgress): string {
  if (progress.phase === "detecting") return `LSP validation: detecting or installing configured primary servers for ${progress.total} requested ${progress.total === 1 ? "entry" : "entries"}.`;
  if (progress.phase === "warming") return `LSP validation: warming primary servers (${progress.completed}/${progress.total}).`;
  return `LSP validation: checking files (${progress.completed}/${progress.total}).`;
}
