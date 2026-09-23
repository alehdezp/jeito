import { createHash } from "node:crypto";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

export interface MarkdownLineInterval {
  start: number;
  end: number;
}

export const MARKDOWN_FRONTMATTER_TOKEN_BUDGET = 300;
export const MARKDOWN_FRONTMATTER_BUDGET = MARKDOWN_FRONTMATTER_TOKEN_BUDGET * 4;

export type MarkdownFrontmatterStatus = "full" | "summary" | "absent" | "already_seen" | "deferred" | "omitted";

export interface MarkdownFrontmatterRelationship {
  field: "code" | "related";
  value: string;
}

export interface MarkdownFrontmatterReference extends MarkdownFrontmatterRelationship {
  interval: MarkdownLineInterval;
  /** Zero-based, end-exclusive UTF-16 offsets in lines.join("\n"), including YAML quotes. */
  startOffset: number;
  endOffset: number;
}

export interface MarkdownFrontmatterSelection {
  status: MarkdownFrontmatterStatus;
  intervals: MarkdownLineInterval[];
  text: string;
  inspected: boolean;
  relationships: MarkdownFrontmatterRelationship[];
  relationshipEvidence?: string;
  digest?: string;
}

interface ParsedMarkdownRelationship extends MarkdownFrontmatterRelationship {
  interval: MarkdownLineInterval;
  site: Omit<MarkdownFrontmatterReference, "field" | "value">;
}

interface MarkdownFrontmatter {
  full: MarkdownLineInterval;
  title?: MarkdownLineInterval;
  description?: MarkdownLineInterval;
  relationships: ParsedMarkdownRelationship[];
}

export interface MarkdownFrontmatterExposureState {
  seenPaths: Set<string>;
  digestByPath: Map<string, string>;
}

export function createMarkdownFrontmatterExposureState(): MarkdownFrontmatterExposureState {
  return { seenPaths: new Set(), digestByPath: new Map() };
}

export function commitMarkdownFrontmatterExposure(state: MarkdownFrontmatterExposureState, canonicalPath: string, digest?: string): void {
  state.seenPaths.add(canonicalPath);
  if (digest) state.digestByPath.set(canonicalPath, digest);
}

export function cloneMarkdownFrontmatterExposureState(state: MarkdownFrontmatterExposureState): MarkdownFrontmatterExposureState {
  return { seenPaths: new Set(state.seenPaths), digestByPath: new Map(state.digestByPath) };
}

export function selectMarkdownFrontmatter(params: {
  path: string;
  lines: string[];
  canonicalPath: string;
  exposureState: MarkdownFrontmatterExposureState;
  maxBytes: number;
  visibleIntervals?: MarkdownLineInterval[];
  raw?: boolean;
}): MarkdownFrontmatterSelection {
  if (!/\.md$/i.test(params.path)) return empty("absent", false);
  const digest = markdownFrontmatterDigest(params.lines);
  if (markdownFrontmatterExposureSeen(params.exposureState, params.canonicalPath, digest)) return empty("already_seen", false, [], digest);

  const frontmatter = parseMarkdownFrontmatter(params.lines);
  if (!frontmatter) return empty("absent", true, [], digest);
  if (params.raw || intervalCovered(frontmatter.full, params.visibleIntervals ?? [])) {
    return empty("already_seen", true, visibleRelationships(frontmatter.relationships, [frontmatter.full]), digest);
  }

  const full = renderIntervals(params.lines, [frontmatter.full]);
  if (byteLength(full) <= params.maxBytes) return selected("full", [frontmatter.full], full, frontmatter.relationships, digest);

  const summaryIntervals = [frontmatter.title, frontmatter.description].filter((value): value is MarkdownLineInterval => Boolean(value));
  const summary = renderIntervals(params.lines, summaryIntervals);
  if (summary) return selected("summary", summaryIntervals, summary, frontmatter.relationships, digest);

  return empty("omitted", true, [], digest);
}

function markdownFrontmatterExposureSeen(state: MarkdownFrontmatterExposureState, canonicalPath: string, digest: string): boolean {
  if (!state.seenPaths.has(canonicalPath)) return false;
  const previous = state.digestByPath.get(canonicalPath);
  return previous === undefined || previous === digest;
}

function markdownFrontmatterDigest(lines: string[]): string {
  let end = 0;
  if (lines[0]?.trim() === "---") {
    const closingIndex = lines.slice(1).findIndex(line => line.trim() === "---");
    end = closingIndex < 0 ? lines.length : closingIndex + 2;
  }
  const source = end ? lines.slice(0, end).join("\n") : "<no-leading-frontmatter>";
  return createHash("sha256").update(source).digest("hex");
}

/** Association evidence is independent of frontmatter display budgets and exposure history. */
export function extractMarkdownFrontmatterRelationships(lines: string[]): MarkdownFrontmatterReference[] {
  return (parseMarkdownFrontmatter(lines)?.relationships ?? []).map(({ field, value, site }) => ({ field, value, ...site }));
}

function parseMarkdownFrontmatter(lines: string[]): MarkdownFrontmatter | undefined {
  if (lines[0]?.trim() !== "---") return undefined;
  const closingIndex = lines.slice(1).findIndex(line => line.trim() === "---");
  if (closingIndex < 0) return undefined;
  const closingLineIndex = closingIndex + 1;
  const body = lines.slice(1, closingLineIndex).join("\n");
  const document = parseDocument(body);
  if (document.errors.length || !isMap(document.contents)) return undefined;

  const result: MarkdownFrontmatter = { full: { start: 1, end: closingLineIndex + 1 }, relationships: [] };
  for (const pair of document.contents.items) {
    const key = isScalar(pair.key) ? String(pair.key.value ?? "") : "";
    if (!pair.key?.range || !pair.value?.range) continue;
    const interval = {
      start: sourceLine(body, pair.key.range[0]),
      end: sourceLine(body, Math.max(pair.value.range[0], pair.value.range[1] - 1)),
    };
    if (key === "title" || key === "description") {
      if (!isScalar(pair.value) || typeof pair.value.value !== "string") continue;
      if (key === "title") result.title = interval;
      else result.description = interval;
      continue;
    }
    if (key !== "code" && key !== "related") continue;
    const values = isSeq(pair.value) ? pair.value.items : [pair.value];
    for (const item of values) {
      if (!isScalar(item) || typeof item.value !== "string") continue;
      const range = item.range ?? pair.value.range;
      const bodyOffset = lines[0]!.length + 1;
      result.relationships.push({ field: key, value: item.value, interval, site: {
        interval: { start: sourceLine(body, range[0]), end: sourceLine(body, Math.max(range[0], range[1] - 1)) },
        startOffset: bodyOffset + range[0], endOffset: bodyOffset + range[1],
      } });
    }
  }
  return result;
}

function sourceLine(body: string, offset: number): number {
  let line = 2;
  for (let index = 0; index < Math.min(offset, body.length); index++) if (body.charCodeAt(index) === 10) line++;
  return line;
}

function intervalCovered(target: MarkdownLineInterval, intervals: MarkdownLineInterval[]): boolean {
  return intervals.some(interval => interval.start <= target.start && interval.end >= target.end);
}

function renderIntervals(lines: string[], intervals: MarkdownLineInterval[]): string {
  const merged: MarkdownLineInterval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end + 1) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged.map(interval => lines.slice(interval.start - 1, interval.end).map((line, index) => `${interval.start + index}:${line}`).join("\n")).join("\n…\n");
}

function visibleRelationships(relationships: ParsedMarkdownRelationship[], intervals: MarkdownLineInterval[]): MarkdownFrontmatterRelationship[] {
  return relationships.filter(relationship => intervalCovered(relationship.interval, intervals)).map(({ field, value }) => ({ field, value }));
}

function selected(status: "full" | "summary", intervals: MarkdownLineInterval[], text: string, relationships: ParsedMarkdownRelationship[], digest: string): MarkdownFrontmatterSelection {
  return { status, intervals, text, inspected: true, relationships: visibleRelationships(relationships, intervals), digest };
}

function empty(status: MarkdownFrontmatterStatus, inspected: boolean, relationships: MarkdownFrontmatterRelationship[] = [], digest?: string): MarkdownFrontmatterSelection {
  return { status, intervals: [], text: "", inspected, relationships, digest };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
