import type { SummaryEntry, SummaryInput, SummaryResult } from "./smart-summary-provider.ts";
import { MARKDOWN_EXTENSIONS } from "../providers/local-provider-utils.ts";

const SUMMARY_ENTRY_LIMIT = 80;
const PUBLIC_TERM_LEAK_RE = /\b(?:backend|tree-sitter|provider|lsp)\b/i;
const PUBLIC_TERM_LEAK_GLOBAL_RE = /\b(?:backend|tree-sitter|provider|lsp)\b/gi;

interface RenderableRangeEntry extends SummaryEntry {
  start: number;
  end: number;
}

export function normalizeSummaryResult(input: SummaryInput, result: SummaryResult | null | undefined): string | undefined {
  if (!result) return undefined;
  return normalizeOutlineResult(input, result);
}

function normalizeOutlineResult(input: SummaryInput, result: SummaryResult): string | undefined {
  const totalLines = result.totalLines ?? input.lines?.length;
  const allEntries = sanitizeRangeEntries(result.entries ?? [], totalLines);
  const lines = input.lines;
  if (!lines || typeof totalLines !== "number" || totalLines === 0 || allEntries.length === 0) return undefined;

  const visible = sourceSummaryLineNumbers(allEntries, totalLines, lines, MARKDOWN_EXTENSIONS.has(input.extension ?? ""));
  if (visible.length === 0) return undefined;
  const out = [`${totalLines} lines. Structural source summary; every complete N:TEXT row is immediately editable under the file hash above.`, ""];
  let previous = 0;
  let completeCount = 0;
  for (const lineNumber of visible) {
    if (previous > 0 && lineNumber > previous + 1) out.push("…");
    const source = lines[lineNumber - 1] ?? "";
    if (source.length <= 512) {
      out.push(`${lineNumber}:${source}`);
      completeCount++;
    } else {
      out.push(`${lineNumber}|${source.slice(0, 512)}… [clipped; ranged read required before editing this line]`);
    }
    previous = lineNumber;
  }

  const hiddenRanges = complementRanges(visible, totalLines);
  const hiddenLines = Math.max(0, totalLines - visible.length);
  if (hiddenRanges.length > 0) {
    const selector = hiddenRanges.slice(0, 2).map(range => `${range.start}-${range.end}`).join(",");
    out.push("", `[…${hiddenLines} lines elided; read all needed distant regions at once with ${input.displayPath}:${selector}]`);
  }
  if (result.truncated || allEntries.length > SUMMARY_ENTRY_LIMIT) out.push("[Structural outline was capped; use one comma-separated ranged read for any additional regions needed.] ");
  if (completeCount === 0) out.push("[No complete source row fit the display cap; use a ranged read before editing.] ");
  return out.join("\n").trimEnd();
}

function sourceSummaryLineNumbers(entries: RenderableRangeEntry[], totalLines: number, lines?: string[], isMarkdown = false): number[] {
  const selected = new Set<number>();
  for (let line = 1; line <= Math.min(4, totalLines); line++) selected.add(line);
  for (const entry of entries) {
    const span = entry.end - entry.start + 1;
    if (span <= 8) {
      for (let line = entry.start; line <= entry.end; line++) selected.add(line);
    } else if (isMarkdown && entry.kind === "heading" && lines) {
      selected.add(entry.start);
      const prose = firstProseLineAfter(lines, entry.start, entry.end);
      if (prose !== undefined) selected.add(prose);
    } else {
      selected.add(entry.start);
      if (entry.start + 1 <= entry.end) selected.add(entry.start + 1);
      selected.add(entry.end);
    }
    if (selected.size >= 120) break;
  }
  return [...selected].filter(line => line >= 1 && line <= totalLines).sort((a, b) => a - b).slice(0, 120);
}

/** First non-blank, non-fence, non-heading line after a markdown heading. */
function firstProseLineAfter(lines: string[], headingLine: number, sectionEnd: number): number | undefined {
  for (let i = headingLine; i < sectionEnd && i < lines.length; i++) {
    const text = (lines[i] ?? "").trim();
    if (!text || /^(`{3,}|~{3,})/.test(text) || /^#{1,6}\s/.test(text)) continue;
    return i + 1;
  }
  return undefined;
}

function complementRanges(visible: number[], totalLines: number): Array<{ start: number; end: number }> {
  const shown = new Set(visible);
  const ranges: Array<{ start: number; end: number }> = [];
  let start: number | undefined;
  for (let line = 1; line <= totalLines + 1; line++) {
    if (line <= totalLines && !shown.has(line)) {
      start ??= line;
      continue;
    }
    if (start !== undefined) {
      ranges.push({ start, end: line - 1 });
      start = undefined;
    }
  }
  return ranges;
}

function sanitizeRangeEntries(entries: SummaryEntry[], totalLines?: number): RenderableRangeEntry[] {
  const out: RenderableRangeEntry[] = [];
  const visit = (entry: SummaryEntry, prefix = "") => {
    const start = integerLine(entry.start);
    const rawEnd = integerLine(entry.end ?? entry.start);
    const label = cleanLabel(`${prefix}${entry.label}`);
    if (start !== undefined && rawEnd !== undefined && label) {
      const end = normalizeEnd(rawEnd, totalLines);
      if (start >= 1 && end >= start && (totalLines === undefined || start <= totalLines)) {
        out.push({ ...entry, start, end, label });
      }
    }
    for (const child of entry.children ?? []) visit(child, `${prefix}  `);
  };
  for (const entry of entries) visit(entry);
  return dedupeEntries(out);
}

function integerLine(value: unknown): number | undefined {
  return Number.isInteger(value) ? value as number : undefined;
}

function normalizeEnd(end: number, totalLines?: number): number {
  return typeof totalLines === "number" ? Math.min(end, totalLines) : end;
}
function publicTitle(title: string, input: SummaryInput): string {
  if (PUBLIC_TERM_LEAK_RE.test(title)) return input.extension && sourceLike(input.extension) ? "source summary" : "summary";
  const clean = cleanLabel(title);
  if (!clean) return input.extension && sourceLike(input.extension) ? "source summary" : "summary";
  return clean;
}


function sourceLike(ext: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|scala|rb|php|cs|cpp?|hpp?|swift|dart|vue|svelte)$/i.test(ext);
}

function dedupeEntries(entries: RenderableRangeEntry[]): RenderableRangeEntry[] {
  const seen = new Set<string>();
  const out: RenderableRangeEntry[] = [];
  for (const entry of entries.sort((a, b) => a.start - b.start || a.end - b.end || a.label.localeCompare(b.label))) {
    const key = `${entry.start}:${entry.end}:${entry.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function cleanLabel(value: string): string {
  return value.replace(PUBLIC_TERM_LEAK_GLOBAL_RE, "").replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
