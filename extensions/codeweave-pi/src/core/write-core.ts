import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withLocalFileMutationQueue } from "./mutation-queue.ts";
import { renderSimpleDiff, firstChangedLine } from "./diff-renderer.ts";
import { canonicalMutationPath, displayPath, resolvePath } from "./path-resolve.ts";
import { formatHeader, formatNumberedLines } from "./read-renderer.ts";
import { snapshots } from "./snapshot-store.ts";
import { assertTextLike, normalizeForSnapshot, splitLogicalLines } from "./text-normalize.ts";
import { validateLandedSyntax, type SyntaxDiagnosticsResolver } from "./syntax-validation.ts";
import { isUpdatedFieldEligiblePath, stampUpdatedField } from "./updated-field-stamp.ts";

export async function executeWrite(params: { cwd: string; path: string; content: string; overwrite?: boolean; signal?: AbortSignal; syntaxResolver?: SyntaxDiagnosticsResolver }): Promise<string> {
  if (params.content.includes("\u0000")) throw new Error(`Write refused: ${params.path} looks like binary content.`);
  const absolutePath = resolvePath(params.cwd, params.path);
  const display = displayPath(params.cwd, absolutePath, params.path);
  const queuePath = canonicalMutationPath(absolutePath);
  return withLocalFileMutationQueue(queuePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    const existed = await stat(absolutePath).then(s => {
      if (s.isDirectory()) throw new Error(`Write refused: ${params.path} is a directory, not a file.`);
      return s.isFile();
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (existed && params.overwrite !== true) {
      throw new Error(`Write refused: ${display} already exists. No files were written.\nNext: use read plus edit for targeted changes, or retry write with overwrite:true for an intentional whole-file replacement.`);
    }
    const before = existed ? await readFile(absolutePath, "utf8") : "";
    if (existed) assertTextLike(params.path, before);
    // Stamp before writing so hashes, diffs and byte counts describe landed content.
    let content = params.content;
    if (isUpdatedFieldEligiblePath(canonicalMutationPath(absolutePath)) && (!existed || before !== content)) {
      content = stampUpdatedField(content, new Date(), !existed).text;
    }
    await writeFile(absolutePath, content, "utf8");
    const canonicalPath = canonicalMutationPath(absolutePath);
    const normalized = normalizeForSnapshot(content);
    const { lines } = splitLogicalLines(normalized);
    const snapshot = snapshots.record(canonicalPath, normalized, lines.map((_, index) => index + 1));
    const header = formatHeader(display, snapshot.tag);
    const byteCount = Buffer.byteLength(content, "utf8");
    const linePreview = formatNumberedLines(lines.slice(0, Math.min(lines.length, 40)), 1);
    const syntax = await validateLandedSyntax({ path: absolutePath, before: normalizeForSnapshot(before), after: normalized, signal: params.signal, resolveDiagnostics: params.syntaxResolver });
    if (!existed) {
      const result = `${header}\nCreated ${display} (${byteCount} bytes).${linePreview ? `\n\n${linePreview}` : ""}`;
      return syntax ? `${result}\n\n${syntax.text}` : result;
    }
    const beforeNormalized = normalizeForSnapshot(before);
    const first = firstChangedLine(beforeNormalized, normalized);
    const summary = first === undefined ? `Overwrote ${display} (${byteCount} bytes). No content changes.` : `Overwrote ${display} (${byteCount} bytes). First changed line: ${first}.`;
    const result = `${header}\n${summary}\n\n${renderSimpleDiff(beforeNormalized, normalized)}`;
    return syntax ? `${result}\n\n${syntax.text}` : result;
  });
}
