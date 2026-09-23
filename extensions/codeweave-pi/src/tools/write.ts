import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { S } from "../core/schema.ts";
import { executeWrite } from "../core/write-core.ts";
import { renderWriteCall, renderWriteResult } from "../core/tui-render.ts";
import { scheduleQmdDocsRefresh } from "../core/qmd-docs-refresh.ts";
import { notifyPreparedMutation } from "../core/prepared-mutation.ts";
import { rejectObsoleteNavigationParams } from "../core/navigation-clean.ts";
import { asToolCallValidationError, invalidToolCallResult, ToolCallValidationError } from "../core/tool-call-contract.ts";

export const writeParams = S.object({
  path: S.string("Where to create; parent directories are made as needed. If the file exists, write refuses unless overwrite:true."),
  content: S.string("The complete file."),
  overwrite: S.boolean("Required, exactly true, to replace an existing file. Omit to create."),
}, ["path", "content"]);

export function registerWriteTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "write",
    label: "write",
    renderShell: "self",
    description: "Create a new file, or replace one whole file on purpose — the counterpart to edit, which changes files in place. Use write only for a new file or a deliberate full rewrite; use read + edit for targeted changes. Example: write({path:'src/new.ts', content:'the whole file'}). Markdown writes add or refresh YAML updated in UTC as \"YYYY-MM-DD HHZ\"; new files also receive created (YYYY-MM-DD) if absent. Missing frontmatter is added. Unchanged overwrites and dependency material are not stamped. Invalid or complex timestamp metadata is refused rather than rewritten ambiguously. Returned hashes describe the final bytes.",
    parameters: writeParams,
    renderCall: renderWriteCall,
    renderResult: renderWriteResult,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      try {
        rejectObsoleteNavigationParams("write", params, ["path", "content", "overwrite"]);
        if (typeof params?.path !== "string" || !params.path.trim()) throw new ToolCallValidationError("write path is required and must be non-empty.", { received: params?.path });
        if (typeof params?.content !== "string") throw new ToolCallValidationError("write content is required and must be a string; an empty string is valid.", { received: typeof params?.content });
        if (params.overwrite !== undefined && params.overwrite !== true) throw new ToolCallValidationError("write overwrite must be omitted or exactly true.", { received: params.overwrite, guidance: ["Omit overwrite when creating a new file; use overwrite:true only for an intentional whole-file replacement."] });
      } catch (error) {
        return invalidToolCallResult("write", asToolCallValidationError(error, { accepted: ["create: {path:'new/file.ts', content:'complete content'}", "replace: {path:'existing.ts', content:'complete content', overwrite:true}"], received: params }));
      }
      let text = await executeWrite({ cwd: ctx.cwd, path: params.path, content: params.content, overwrite: params.overwrite, signal });
      scheduleQmdDocsRefresh({ cwd: ctx.cwd, paths: [params.path], trigger: "write" });
      const warning = notifyPreparedMutation({ cwd: ctx.cwd, paths: [params.path], trigger: "write" });
      if (warning) text = `${text}\n\nWARNING: ${warning}`;
      return { content: [{ type: "text", text }], details: {} };
    }
  });
}
