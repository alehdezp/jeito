import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { computeTag } from "../core/snapshot-store.ts";
import { normalizeForSnapshot, splitLogicalLines } from "../core/text-normalize.ts";
import { applyPatch } from "../core/patch-apply.ts";
import { S } from "../core/schema.ts";
import { renderEditCall, renderEditResult } from "../core/tui-render.ts";
import { scheduleQmdDocsRefresh } from "../core/qmd-docs-refresh.ts";
import { notifyPreparedMutation } from "../core/prepared-mutation.ts";
import { rejectObsoleteNavigationParams } from "../core/navigation-clean.ts";
import { asToolCallValidationError, invalidToolCallResult, ToolCallValidationError } from "../core/tool-call-contract.ts";

export const editParams = S.object({
  input: S.string("The edit program — required. One or more [PATH#HASH] file sections, each holding operations against the original snapshot's numbers; earlier operations never renumber later anchors.\n\nLine operations (for partial changes): REPLACE N: or REPLACE N..M: plus +TEXT rows · DELETE N or DELETE N..M · INSERT BEFORE|AFTER N: or INSERT AT START|END: plus +TEXT. INSERT AFTER N auto-adjusts outward across following closing braces when the new text's indentation belongs outside them — the result note names where it landed.\n\nBlock operations (whole constructs): REPLACE BLOCK AT N:, DELETE BLOCK AT N, INSERT AFTER BLOCK AT N: — only when the read certified a block starting at N; otherwise use a concrete range.\n\nCHECK LSP validates the file after it lands; place it after that file's last operation.\n\nDELETE FILE or MOVE FILE TO destination must be the only operation in its file's section.\n\nCopy every hash and line number from the read or edit output you are working from — never guess. Each file lands as one piece, but the whole request is not all-or-nothing: an earlier file stays landed if a later one fails.\n\nWorked example — two files, four operations, validation, with every number from one read:\n\n[src/render.ts#A1B2C3D4]\nREPLACE 42..44:\n+function renderCard(item: Item): string {\n+  return frame(item.title);\n+}\nDELETE 58\nINSERT AFTER BLOCK AT 120:\n+function renderFooter(): string {\n+  return `v${VERSION}`;\n+}\nCHECK LSP\n[src/types.ts#E5F6A7B8]\nREPLACE 12:\n+  title: string;\n+  subtitle?: string;\nCHECK LSP\n\nNote what the example demonstrates: DELETE 58 targets original line 58 even though the REPLACE above changed the line count — snapshot numbers, not shifted ones; and 120 must be a certified block-opening line from the read."),
}, ["input"]);

export function registerEditTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit",
    label: "edit",
    renderShell: "self",
    description: "Make precise changes to files you have seen, using a small program: file sections with their [path#hash], then line operations against the numbers you saw. Use it when you know which lines change; use write for new files or whole-file replacement. The engine repairs small mistakes — duplicated boundary lines, inserts that land inside closing braces — and holds changes it can't apply safely. Any tool that showed you a hash — read, grep, explore, trace — has already authorized those exact lines for this session, so nothing needs re-reading first. A hash alone does not authorize unseen rows. Example: edit({input:'[src/a.ts#HASH]\\nREPLACE 10:\\n+new text'}). Content-changing Markdown edits also add or refresh YAML updated in UTC as \"YYYY-MM-DD HHZ\", adding frontmatter if missing. No-op edits, moves and dependency material are not stamped. Invalid or complex timestamp metadata is refused. This managed field is the only automatic metadata exception to row authority; final hashes and coordinates include it.",
    promptGuidelines: ["### Read the result — inspect every file's outcome: landed, skipped (no change — don't resend the same program), failed, or cancelled. Warnings starting 'Auto-repaired' mean the engine corrected duplicated boundary lines or a misplaced insert and still landed the change — read them to learn what it adjusted. A held outcome means the file changed under you; the result offers RETRY, RETRY N, or RETRY ALL for exactly those held changes. After success, continue from the fresh hashes and coordinates the result returns — the old ones are dead. An edit touching project docs may append a WARNING that navigation data is stale; refresh when it says so.\n\n### Recover — a rejection names its reason and the input line: bounds errors report the file's real line count, so re-read and rebuild with real numbers; ambiguous_boundary_repair means the replacement text is already there, so use DELETE explicitly; conflict means another change overlaps yours. RETRY errors are precise: no_retry_available means nothing was held (rebuild from a read), retry_selection_required means several changes remain and you must pick one, and retry_selection_invalid means that number doesn't exist. A generic failure offers nothing — re-read the file and rebuild the program. For a coherent multi-file checkpoint, lsp_validate after landing covers the set.\n\n### Stop — every intended file landed and the validation you asked for ran, or you can state exactly which file did not and why."],
    parameters: editParams,
    renderCall: renderEditCall,
    renderResult: renderEditResult,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      try {
        rejectObsoleteNavigationParams("edit", params, ["input"]);
        if (typeof params?.input !== "string" || !params.input.trim()) throw new ToolCallValidationError("edit input is required and must contain at least one hash-anchored operation.", { received: params?.input });
      } catch (error) {
        return invalidToolCallResult("edit", asToolCallValidationError(error, { accepted: ["{input:'[src/file.ts#A1B2C3D4]\\nREPLACE 10:\\n+new text'}"], guidance: ["Copy the whole-file hash and current coordinates from read or a prior edit result."], received: params }));
      }
      const result = await applyPatch({
        cwd: ctx.cwd, patch: params.input, signal, sessionId: ctx.sessionManager?.getSessionId?.() ?? ctx.cwd,
        recoverAuthority: (path, text) => recoverReadRows(ctx.sessionManager?.getBranch?.() ?? [], ctx.sessionManager?.getCwd?.() ?? ctx.cwd, path, text),
      });
      if (result.details.refreshPaths.length > 0) {
        scheduleQmdDocsRefresh({ cwd: ctx.cwd, paths: result.details.refreshPaths, trigger: "edit" });
        const warning = notifyPreparedMutation({ cwd: ctx.cwd, paths: result.details.refreshPaths, trigger: "edit" });
        if (warning) result.text = `${result.text}\n\nWARNING: ${warning}`;
      }
      return { content: [{ type: "text", text: result.text }], details: result.details };
    }
  });
}

// Pi already retains delivered read results on the active branch. Reuse them
// on a cache miss; compaction does not undo an observation, and sibling
// branches must not lend authority. No second persisted proof store is needed.
function recoverReadRows(entries: readonly any[], cwd: string, path: string, text: string): Set<number> | undefined {
  const tag = computeTag(text);
  const source = splitLogicalLines(normalizeForSnapshot(text)).lines;
  const seen = new Set<number>();
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index]?.type === "message" ? entries[index].message : undefined;
    if (message?.role !== "toolResult" || message.toolName !== "read" || message.isError || !Array.isArray(message.content)) continue;
    const files = Array.isArray(message.details?.files) ? message.details.files : [message.details];
    const rendered = normalizeForSnapshot(message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n")).split("\n");
    for (const file of files) {
      if (file?.tag !== tag || typeof file.path !== "string" || !Array.isArray(file.intervals)) continue;
      if (file.status !== undefined && file.status !== "shown") continue;
      let canonical: string;
      try { canonical = realpathSync(file.canonicalPath ?? resolve(cwd, file.path)); } catch { continue; }
      if (canonical !== path) continue;
      const header = rendered.indexOf(`[${file.path}#${tag}]`);
      if (header < 0) continue;
      for (let row = header + 1; row < rendered.length; row++) {
        if (/^\[.+#[0-9A-F]{8}\]$/.test(rendered[row]!)) break;
        const match = /^(\d+):(.*)$/.exec(rendered[row]!);
        if (!match) continue;
        const line = Number(match[1]);
        if (line < 1 || line > source.length || source[line - 1] !== match[2]) continue;
        if (file.intervals.some((range: any) => range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start <= line && line <= range.end)) seen.add(line);
      }
    }
  }
  return seen.size ? seen : undefined;
}
