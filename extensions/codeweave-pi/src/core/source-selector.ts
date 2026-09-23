import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";

import { isSectionSelectorChunk } from "./docs-section-ref.ts";
import { callPiNav, type PiNavCaller } from "./pi-nav-native.ts";
import { detectProjectRoot } from "./project-root.ts";

export interface SourceInterval {
  start: number;
  end: number;
}

export interface ResolvedSourceSelector {
  intervals: SourceInterval[];
  context: string[];
}

export interface ParsedSourceReference {
  filePath: string;
  selector?: string;
  raw: boolean;
  explicitSelector: boolean;
}

export const EXPLICIT_SELECTOR_OUTPUT_BUDGET = 64_000;

const RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

export function normalizeMarkdownSelectorChunk(chunk: string): string {
  return chunk.trim().replace(/\/#(\d+)$/, "#$1");
}

export function splitSourceReference(rawPath: string): ParsedSourceReference {
  let candidate = rawPath;
  let raw = false;
  const rawSuffixLength = candidate.toLowerCase().endsWith("::raw") ? 5 : candidate.toLowerCase().endsWith(":raw") ? 4 : 0;
  if (rawSuffixLength) {
    raw = true;
    candidate = candidate.slice(0, -rawSuffixLength);
  }
  const doubleColon = candidate.lastIndexOf("::");
  if (doubleColon > 0) {
    const selector = candidate.slice(doubleColon + 2).trim();
    if (isSourceSelectorToken(selector)) return { filePath: candidate.slice(0, doubleColon), selector, raw, explicitSelector: true };
  }
  const colon = candidate.lastIndexOf(":");
  if (colon > 0) {
    const selector = candidate.slice(colon + 1).trim();
    if (isSourceSelectorToken(selector)) return { filePath: candidate.slice(0, colon), selector, raw, explicitSelector: true };
  }
  if (raw) return { filePath: candidate, raw, explicitSelector: true };
  return { filePath: rawPath, raw: false, explicitSelector: false };
}

export function isSourceSelectorToken(token: string): boolean {
  if (!token) return false;
  return token.split(",").every(rawChunk => {
    const chunk = rawChunk.trim();
    return isRangeSelectorChunk(chunk)
      || isSectionSelectorChunk(normalizeMarkdownSelectorChunk(chunk))
      || isCodeSymbolChunk(chunk);
  });
}

export function parseLineRanges(selector: string, lineCount: number): SourceInterval[] {
  const chunks = selector.split(",").map(chunk => chunk.trim()).filter(Boolean);
  if (chunks.length === 0) throw new Error("Read refused: empty line selector.");
  return mergeSourceIntervals(chunks.map(chunk => parseLineRangeChunk(chunk, lineCount)));
}

export async function resolveSourceSelector(params: {
  selector: string;
  lines: string[];
  display: string;
  cwd: string;
  absolutePath: string;
  sourceText: string;
  signal?: AbortSignal;
  callNative?: PiNavCaller;
  /** Explicit supplied-source parsing; sourceText alone never enables this mode. */
  capturedSourceRoot?: string;
}): Promise<ResolvedSourceSelector> {
  const chunks = params.selector.split(",").map(chunk => chunk.trim()).filter(Boolean);
  if (chunks.length === 0) throw new Error("Read refused: empty selector.");
  const markdown = /\.md$/i.test(params.display);
  if (markdown) return resolveMarkdownSelector(params, chunks);

  const captured = params.capturedSourceRoot !== undefined;
  const root = params.capturedSourceRoot ?? detectProjectRoot(params.cwd).root;
  const path = captured ? relative(root, params.absolutePath).split(sep).join("/") : params.absolutePath;
  if (captured && (!isAbsolute(root) || !path || path === ".." || path.startsWith("../") || isAbsolute(path))) throw new Error("Read refused: supplied-source selector unavailable outside its admitted root.");
  const expectedHash = createHash("sha256").update(params.sourceText).digest("hex");
  const contexts: string[] = [];
  const intervals: SourceInterval[] = [];
  const symbolResults = new Map<string, Record<string, unknown>>();
  for (const chunk of chunks) {
    if (isRangeSelectorChunk(chunk)) {
      intervals.push(parseLineRangeChunk(chunk, params.lines.length));
      continue;
    }
    if (!isCodeSymbolChunk(chunk)) throw unsupportedSelector(params.display, chunk);
    let data = symbolResults.get(chunk);
    if (!data) {
      const args = captured ? { path, capturedSource: { text: params.sourceText }, name: chunk } : { path: params.absolutePath, name: chunk };
      const output = await (params.callNative ?? callPiNav)({ root, operation: "pi_nav_symbol_range", args, timeoutMs: 10_000, signal: params.signal });
      data = (output.structured.data ?? {}) as Record<string, unknown>;
      symbolResults.set(chunk, data);
    }
    let definition = data;
    if (captured) {
      if (data.basis !== "supplied" || data.suppliedSourceHash !== expectedHash || data.path !== path) throw new Error("Read refused: supplied-source symbol response unavailable (basis, hash or label mismatch).");
      if (data.status === "ambiguous") {
        const candidates = Array.isArray(data.candidates)
          ? data.candidates.slice(0, 8).map(candidate => `${Number((candidate as any).bodyStart)}-${Number((candidate as any).bodyEnd)}`).join(", ")
          : "multiple supplied ranges";
        throw new Error(`Read refused: symbol selector ${JSON.stringify(chunk)} is ambiguous in supplied source for ${params.display}. Matches: ${candidates}. Use an explicit line range.`);
      }
      if (data.status === "absent") throw new Error(`Read refused: symbol ${JSON.stringify(chunk)} was not found in supplied source.`);
      if (data.status !== "found" || !data.definition || typeof data.definition !== "object" || Array.isArray(data.definition)) throw new Error("Read refused: supplied-source symbol selectors are unavailable for this response.");
      definition = data.definition as Record<string, unknown>;
    } else {
      if (data.verified === false) throw new Error(`Read refused: structural symbol selectors are unavailable for ${params.display}. Use an explicit line range.`);
      const sourceHash = typeof data.sourceHash === "string" ? data.sourceHash.toLowerCase() : "";
      if (!sourceHash || sourceHash !== expectedHash) throw new Error(`Read refused: ${params.display} changed while resolving symbol ${JSON.stringify(chunk)}; retry the read.`);
      if (data.found !== true) throw new Error(`Read refused: symbol ${JSON.stringify(chunk)} was not found in current source.`);
      if (data.ambiguous === true) {
        const candidates = Array.isArray(data.all)
          ? data.all.slice(0, 8).map(candidate => `${Number((candidate as any).bodyStart)}-${Number((candidate as any).bodyEnd)}`).join(", ")
          : "multiple current ranges";
        throw new Error(`Read refused: symbol selector ${JSON.stringify(chunk)} is ambiguous in ${params.display}. Matches: ${candidates}. Use an explicit line range.`);
      }
    }
    const start = Number(definition.bodyStart);
    const end = Number(definition.bodyEnd);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > params.lines.length) {
      throw new Error(`Read refused: native symbol range for ${JSON.stringify(chunk)} is invalid in ${params.display}.`);
    }
    intervals.push({ start, end });
    const kind = typeof definition.kind === "string" ? definition.kind : "symbol";
    const name = typeof definition.name === "string" ? definition.name : chunk;
    contexts.push(`${kind} ${name}`);
  }
  return { intervals: mergeSourceIntervals(intervals), context: [...new Set(contexts)] };
}

export function renderedSourceSelectionLength(display: string, lines: string[], intervals: SourceInterval[], context: string[] = []): number {
  const source = intervals.map(interval => lines.slice(interval.start - 1, interval.end).map((line, index) => `${interval.start + index}:${line}`).join("\n")).join("\n…\n");
  const within = context.length ? `Within: ${context.join(" · ")}` : "";
  const body = [within, source].filter(Boolean).join("\n");
  return `[${display}#0000]${body ? `\n${body}` : ""}`.length;
}

export function mergeSourceIntervals(intervals: SourceInterval[]): SourceInterval[] {
  const ordered = [...intervals].sort((a, b) => a.start - b.start);
  const merged: SourceInterval[] = [];
  for (const interval of ordered) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end + 1) merged.push({ ...interval });
    else previous.end = Math.max(previous.end, interval.end);
  }
  return merged;
}

function isRangeSelectorChunk(chunk: string): boolean {
  return RANGE_CHUNK_RE.test(chunk.trim());
}

function isCodeSymbolChunk(chunk: string): boolean {
  return Boolean(chunk) && chunk !== "raw" && !/[,\s:]/.test(chunk);
}

async function resolveMarkdownSelector(
  params: Parameters<typeof resolveSourceSelector>[0],
  rawChunks: string[],
): Promise<ResolvedSourceSelector> {
  const chunks = rawChunks.map(chunk => isRangeSelectorChunk(chunk) ? chunk : normalizeMarkdownSelectorChunk(chunk));
  if (chunks.some(chunk => !isRangeSelectorChunk(chunk) && !isSectionSelectorChunk(chunk))) {
    const invalid = chunks.find(chunk => !isRangeSelectorChunk(chunk) && !isSectionSelectorChunk(chunk))!;
    throw unsupportedSelector(params.display, invalid);
  }

  const captured = params.capturedSourceRoot !== undefined;
  const root = params.capturedSourceRoot ?? detectProjectRoot(params.cwd).root;
  const path = captured ? relative(root, params.absolutePath).split(sep).join("/") : params.absolutePath;
  if (captured && (!isAbsolute(root) || !path || path === ".." || path.startsWith("../") || isAbsolute(path))) throw new Error("Read refused: supplied-source selector unavailable outside its admitted root.");
  const output = await (params.callNative ?? callPiNav)({
    root,
    operation: "pi_nav_read",
    args: captured
      ? { path, capturedSource: { text: params.sourceText }, markdownStructure: true, includeSections: true }
      : { path: params.absolutePath, markdownStructure: true, includeSections: true },
    timeoutMs: 10_000,
    signal: params.signal,
  });
  const data = output.structured.data as any;
  const file = data?.files?.[0];
  const expectedHash = createHash("sha256").update(params.sourceText).digest("hex");
  if (captured) {
    if (data?.basis !== "supplied" || data?.suppliedSourceHash !== expectedHash || file?.path !== path || !Array.isArray(file?.sections)) throw new Error("Read refused: supplied-source Markdown response unavailable (basis, hash, label or sections mismatch).");
  } else if (String(file?.sourceHash ?? "").toLowerCase() !== expectedHash) throw new Error(`Read refused: ${params.display} changed while resolving its Markdown selector; retry the read.`);
  const sections = Array.isArray(file?.sections) ? file.sections : [];
  const bySelector = new Map<string, any>(sections.map((section: any) => [String(section.selector), section]));
  const lineage = (section: any, includeSelf: boolean): string => {
    const titles: string[] = [];
    let current = includeSelf ? section : bySelector.get(String(section?.parent ?? ""));
    const seen = new Set<string>();
    while (current && !seen.has(String(current.selector))) {
      seen.add(String(current.selector));
      titles.unshift(String(current.title));
      current = bySelector.get(String(current.parent ?? ""));
    }
    return titles.join(" > ");
  };
  const ownerAtLine = (line: number): any => sections
    .filter((section: any) => Number(section.headingStartLine) <= line && line <= Number(section.subtreeEndLine))
    .sort((a: any, b: any) => Number(b.level) - Number(a.level))[0];

  const contexts: string[] = [];
  const intervals = chunks.map(chunk => {
    if (isSectionSelectorChunk(chunk)) {
      const section = bySelector.get(chunk);
      if (!section) throw new Error(`Read refused: Markdown section ${chunk} was not found in current source.`);
      const parentLineage = lineage(section, true);
      if (parentLineage) contexts.push(parentLineage);
      return { start: Number(section.headingStartLine), end: Number(section.subtreeEndLine) };
    }
    const interval = parseLineRangeChunk(chunk, params.lines.length);
    const ownerLineage = lineage(ownerAtLine(interval.start), true);
    if (ownerLineage) contexts.push(ownerLineage);
    return interval;
  });
  if (captured && intervals.some(interval => !Number.isSafeInteger(interval.start) || !Number.isSafeInteger(interval.end) || interval.start < 1 || interval.end < interval.start || interval.end > params.lines.length)) throw new Error("Read refused: supplied-source Markdown range is unavailable or invalid.");
  return { intervals: mergeSourceIntervals(intervals), context: [...new Set(contexts)] };
}

function parseLineRangeChunk(chunk: string, lineCount: number): SourceInterval {
  const match = RANGE_CHUNK_RE.exec(chunk);
  if (!match) throw unsupportedSelector("file", chunk);
  const start = Number.parseInt(match[1]!, 10);
  const separator = match[2] === ".." ? "-" : match[2];
  const right = match[3] ? Number.parseInt(match[3], 10) : undefined;
  if (separator === "-" && right !== undefined && right < start) throw new Error(`Invalid range ${chunk}: end must be >= start.`);
  if (start < 1) throw new Error("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
  if (lineCount === 0) throw new Error("Line 1 is beyond end of file (0 lines total). The file is empty.");
  if (start > lineCount) throw new Error(`Line ${start} is beyond end of file (${lineCount} lines total). Use :1 to read from the start, or :${lineCount} to read the last line.`);

  let end: number;
  if (separator === "+") {
    if (right === undefined || right < 1) throw new Error(`Invalid range ${chunk}: count must be >= 1.`);
    end = start + right - 1;
  } else if (separator === "-") {
    end = right ?? lineCount;
  } else {
    end = lineCount;
  }
  return { start, end: Math.min(end, lineCount) };
}

function unsupportedSelector(display: string, chunk: string): Error {
  return new Error(`Read refused: unsupported selector :${chunk} for ${display}. Use :START, :START-END, :START+COUNT, :symbol, :section/path#LEVEL, :raw, or comma-separated selectors.`);
}
