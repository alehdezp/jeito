import { extname } from "node:path";
import { resolveSyntaxDiagnostics, structuralLanguage, type StructuralSyntaxResult, type SyntaxDiagnostic } from "./structural-block-resolver.ts";
import { splitLogicalLines } from "./text-normalize.ts";

const SILENT_EXTENSIONS = new Set(["", ".txt", ".log"]);
const DISPLAY_LIMIT = 5;
export const SYNTAX_PARSE_BUDGET_BYTES = 256 * 1024;

export interface SyntaxValidationNote {
  status: "worsened" | "unavailable";
  text: string;
  diagnostics: SyntaxDiagnostic[];
}

export type SyntaxDiagnosticsResolver = (input: { path: string; text: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<StructuralSyntaxResult | undefined>;

/** Advisory post-commit syntax comparison. It never mutates or gates the landed file. */
export async function validateLandedSyntax(input: { path: string; before: string; after: string; signal?: AbortSignal; timeoutMs?: number; resolveDiagnostics?: SyntaxDiagnosticsResolver }): Promise<SyntaxValidationNote | undefined> {
  const extension = extname(input.path).toLowerCase();
  if (SILENT_EXTENSIONS.has(extension)) return undefined;
  const language = structuralLanguage(input.path);
  if (!language) return { status: "unavailable", text: `Syntax check unavailable for ${extension || "this file type"}; the mutation remains landed.`, diagnostics: [] };
  if (input.signal?.aborted) return { status: "unavailable", text: "Syntax check cancelled after the mutation landed.", diagnostics: [] };
  const byteLength = Math.max(Buffer.byteLength(input.before, "utf8"), Buffer.byteLength(input.after, "utf8"));
  if (byteLength > SYNTAX_PARSE_BUDGET_BYTES) return { status: "unavailable", text: `Syntax check unavailable: ${byteLength} bytes exceeds the bounded ${SYNTAX_PARSE_BUDGET_BYTES}-byte parse budget; the mutation remains landed.`, diagnostics: [] };

  const resolver = input.resolveDiagnostics ?? resolveSyntaxDiagnostics;
  const [before, after] = await Promise.all([
    resolver({ path: input.path, text: input.before, timeoutMs: input.timeoutMs, signal: input.signal }),
    resolver({ path: input.path, text: input.after, timeoutMs: input.timeoutMs, signal: input.signal }),
  ]);
  if (input.signal?.aborted) return { status: "unavailable", text: "Syntax check cancelled after the mutation landed.", diagnostics: [] };
  if (!before || !after) return { status: "unavailable", text: `Syntax check unavailable for ${language} (worker timeout or grammar load failure); the mutation remains landed.`, diagnostics: [] };
  if (after.diagnostics.length <= before.diagnostics.length) return undefined;

  const range = changedOutputRange(input.before, input.after);
  const attributable = after.diagnostics.filter(diagnostic => diagnostic.endLine >= range.start - 2 && diagnostic.line <= range.end + 2);
  if (before.diagnostics.length > 0 && attributable.length === 0) {
    return { status: "worsened", text: `Syntax problems increased from ${before.diagnostics.length} to ${after.diagnostics.length}, but none intersect the changed output range; the mutation remains landed.`, diagnostics: after.diagnostics };
  }
  const shown = (before.diagnostics.length === 0 ? after.diagnostics : attributable).slice(0, DISPLAY_LIMIT);
  const rows = shown.map(diagnostic => `  ${input.path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.kind}${diagnostic.kind === "MISSING" ? ` ${diagnostic.nodeType}` : ""}`);
  const omitted = Math.max(0, (before.diagnostics.length === 0 ? after.diagnostics.length : attributable.length) - shown.length);
  return {
    status: "worsened",
    text: `Syntax check found ${after.diagnostics.length - before.diagnostics.length} newly introduced or worsened grammar problem(s); the mutation remains landed:\n${rows.join("\n")}${omitted ? `\n  … ${omitted} more` : ""}`,
    diagnostics: after.diagnostics,
  };
}

function changedOutputRange(before: string, after: string): { start: number; end: number } {
  const left = splitLogicalLines(before).lines;
  const right = splitLogicalLines(after).lines;
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  return { start: prefix + 1, end: Math.max(prefix + 1, right.length - suffix) };
}
