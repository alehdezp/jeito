import { createReadStream, realpathSync, type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { validateFrontmatterRelationships } from "./frontmatter-relationships.ts";
import { canonicalExistingPath, displayPath, resolvePath } from "./path-resolve.ts";
import { detectProjectRoot } from "./project-root.ts";
import { computeTag, snapshots, type SnapshotBlock } from "./snapshot-store.ts";
import { DEFAULT_TAGGED_READ_BYTES, IMAGE_EXTENSIONS, formatBytes, readTextFileSafely, readTextSampleSafely } from "./scan-policy.ts";
import { renderSmartSummaryWithMetadata } from "./summary-renderer.ts";
import { isSectionSelectorChunk } from "./docs-section-ref.ts";
import { normalizeToLF, splitLogicalLines, stripBom } from "./text-normalize.ts";
import { resolveStructuralBlocks } from "./structural-block-resolver.ts";
import { cloneMarkdownFrontmatterExposureState, commitMarkdownFrontmatterExposure, createMarkdownFrontmatterExposureState, selectMarkdownFrontmatter, type MarkdownFrontmatterExposureState, type MarkdownFrontmatterSelection } from "./markdown-frontmatter.ts";
import { EXPLICIT_SELECTOR_OUTPUT_BUDGET, mergeSourceIntervals, parseLineRanges, resolveSourceSelector, splitSourceReference } from "./source-selector.ts";

const DEFAULT_EXACT_LINES = 120;
const DEFAULT_EXACT_BUDGET = 24_000;

const DEFAULT_EXPLICIT_SELECTOR_BUDGET = EXPLICIT_SELECTOR_OUTPUT_BUDGET;

export interface Interval {
  start: number;
  end: number;
}


export interface ReadExactResult {
  text: string;
  image?: { data: string; mimeType: string };
  tag?: string;
  canonicalPath?: string;
  displayPath?: string;
  intervals?: Interval[];
}

export interface ParsedReadPath {
  filePath: string;
  selector?: string;
  raw: boolean;
  explicitSelector: boolean;
}

export interface PreparedReadResult extends ReadExactResult {
  authority?: { text: string; seenLines: number[]; blocks: SnapshotBlock[] };
  frontmatter?: { canonicalPath: string; status: MarkdownFrontmatterSelection["status"]; inspected: boolean; digest?: string };
}

export interface ReadPreflight {
  requestedPath: string;
  target: ParsedReadPath;
  absolutePath: string;
  canonicalPath: string;
  displayPath: string;
  info: Stats;
  extension: string;
}

export type BatchReadStatus = "shown" | "shown_no_authority" | "error" | "omitted";

export interface BatchReadFileDetail {
  requestIndexes: number[];
  selectors: string[];
  retrySelector: string;
  status: BatchReadStatus;
  mergedRequestCount: number;
  canonicalPath?: string;
  path?: string;
  tag?: string;
  intervals?: Interval[];
  reason?: string;
}

export interface BatchReadResult {
  text: string;
  files: BatchReadFileDetail[];
  counts: { requested: number; groups: number; shown: number; errors: number; omitted: number };
  complete: boolean;
  reason?: string;
}

const FENCE_OPEN_RE = /^(`{3,}(?!.*`)|~{3,}).*$/;
const ATX_HEADING_RE = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/;
const SETEXT_H1_RE = /^=+\s*$/;
const SETEXT_H2_RE = /^-+\s*$/;
const RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;
const LIST_ITEM_RE = /^\s*([-*+]|\d{1,9}[.)])\s+/;
const BLOCKQUOTE_RE = /^\s*>/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

export function formatHeader(path: string, tag: string): string {
  return `[${path}#${tag}]`;
}

export function formatNumberedLines(lines: string[], startLine: number): string {
  return lines.map((line, index) => `${startLine + index}:${line}`).join("\n");
}

function lineNumbersFromIntervals(intervals: Interval[]): number[] {
  const lines: number[] = [];
  for (const interval of intervals) for (let line = interval.start; line <= interval.end; line++) lines.push(line);
  return lines;
}

function seenLinesFromNumberedBody(body: string): number[] {
  const seen = new Set<number>();
  for (const row of body.split("\n")) {
    const match = /^(\d+):/.exec(row);
    if (match) seen.add(Number(match[1]));
  }
  return [...seen].sort((a, b) => a - b);
}

function intervalsFromLineNumbers(lineNumbers: number[]): Interval[] {
  if (lineNumbers.length === 0) return [];
  const intervals: Interval[] = [];
  let start = lineNumbers[0]!;
  let end = start;
  for (const line of lineNumbers.slice(1)) {
    if (line === end + 1) end = line;
    else {
      intervals.push({ start, end });
      start = end = line;
    }
  }
  intervals.push({ start, end });
  return intervals;
}
export function splitPathSelector(rawPath: string): ParsedReadPath {
  return splitSourceReference(rawPath);
}


// splitPathSelector consumes valid selectors/raw from the end. If we reach a
// missing-path error with no explicit selector but a colon still present, the
// suffix was unrecognized: when the prefix is an existing file, report an
// invalid selector instead of "file not found".
async function invalidSelectorSuffixHint(cwd: string, target: ParsedReadPath): Promise<string | undefined> {
  if (target.explicitSelector || !target.filePath.includes(":")) return undefined;
  const doubleColon = target.filePath.lastIndexOf("::");
  const separator = doubleColon > 0 ? doubleColon : target.filePath.lastIndexOf(":");
  const width = doubleColon > 0 ? 2 : 1;
  const filePart = target.filePath.slice(0, separator);
  const suffixPart = target.filePath.slice(separator + width);
  const partInfo = await stat(resolvePath(cwd, filePart)).catch(() => undefined);
  if (partInfo?.isFile()) {
    return `Read refused: ${filePart} exists but ${JSON.stringify(target.filePath.slice(separator, separator + width) + suffixPart)} is not a valid selector. Use :START, :START-END, :START+COUNT, :symbol, :section/path#LEVEL, :raw, or comma-separated selectors.`;
  }
  return undefined;
}

export async function preflightRead(params: { cwd: string; path: string; signal?: AbortSignal }): Promise<ReadPreflight> {
  if (params.signal?.aborted) throw new Error("Read aborted before completion.");
  let target: ParsedReadPath = { filePath: params.path, raw: false, explicitSelector: false };
  let absolutePath = resolvePath(params.cwd, params.path);
  let info = await stat(absolutePath).catch((error: any) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) {
    target = splitPathSelector(params.path);
    absolutePath = resolvePath(params.cwd, target.filePath);
    try {
      info = await stat(absolutePath);
    } catch (error: any) {
      if (error?.code === "ENOENT") throw new Error(await invalidSelectorSuffixHint(params.cwd, target) ?? `Read refused: file not found: ${target.filePath}`);
      throw error;
    }
  }
  if (info.isDirectory()) throw new Error(`Read refused: ${target.filePath} is a directory. Use ls for directory listing.`);
  if (!info.isFile()) throw new Error(`Read refused: ${target.filePath} is not a regular file.`);
  return {
    requestedPath: params.path,
    target,
    absolutePath,
    canonicalPath: canonicalExistingPath(absolutePath),
    displayPath: displayPath(params.cwd, absolutePath, target.filePath),
    info,
    extension: extname(absolutePath).toLowerCase(),
  };
}

export async function prepareRead(params: { cwd: string; path: string; signal?: AbortSignal; preflight?: ReadPreflight; frontmatterExposureState?: MarkdownFrontmatterExposureState; frontmatterMaxBytes?: number }): Promise<PreparedReadResult> {
  const preflight = params.preflight ?? await preflightRead(params);
  const { target, absolutePath, canonicalPath, displayPath: display, info, extension: ext } = preflight;
  if (IMAGE_EXTENSIONS.has(ext)) {
    const mimeType = ext === ".jpg" ? "image/jpeg" : `image/${ext.slice(1)}`;
    const raw = await readFile(absolutePath);
    return { text: `[${display}]`, image: { data: raw.toString("base64"), mimeType }, displayPath: display };
  }
  const safe = await readTextFileSafely(absolutePath, { maxBytes: DEFAULT_TAGGED_READ_BYTES, signal: params.signal });
  if (!safe.ok) return await renderUnsafeOrLargeRead({ absolutePath, display, target, sizeBytes: info.size, reason: safe.reason, signal: params.signal });

  const { text } = stripBom(safe.text);
  const normalized = normalizeToLF(text);
  const { lines } = splitLogicalLines(normalized);
  const lineCount = lines.length;
  const resolvedSelector = target.selector ? await resolveSourceSelector({ selector: target.selector, lines, display, cwd: params.cwd, absolutePath, sourceText: safe.text, signal: params.signal }) : undefined;
  let intervals = resolvedSelector?.intervals ?? defaultExactIntervals(lines, normalized);
  const frontmatter = params.frontmatterExposureState && params.frontmatterMaxBytes
    ? selectMarkdownFrontmatter({
        path: display,
        lines,
        canonicalPath,
        exposureState: params.frontmatterExposureState,
        maxBytes: params.frontmatterMaxBytes,
        visibleIntervals: intervals ?? [],
        raw: target.raw && !target.selector,
      })
    : undefined;
  if (frontmatter?.relationships.length) {
    const validation = await validateFrontmatterRelationships({ projectRoot: detectProjectRoot(canonicalPath).root, ownerPath: canonicalPath, relationships: frontmatter.relationships, signal: params.signal });
    frontmatter.relationshipEvidence = validation?.text;
  }

  if (!target.selector && !target.raw && intervals === undefined) {
    const summary = await renderSmartSummaryWithMetadata({ cwd: params.cwd, displayPath: display, absolutePath, normalized, lines, kind: "file", sizeBytes: info.size }, { signal: params.signal });
    if (!summary) return withFrontmatter({ text: fallbackSummary(display, lines), displayPath: display }, canonicalPath, frontmatter);
    const body = [frontmatter?.text, summary.text].filter(Boolean).join("\n");
    const seenLines = [...new Set([...lineNumbersFromIntervals(frontmatter?.intervals ?? []), ...seenLinesFromNumberedBody(summary.text)])].sort((a, b) => a - b);
    if (seenLines.length === 0) return withFrontmatter({ text: summary.text, displayPath: display }, canonicalPath, frontmatter);
    return preparedAuthority(display, canonicalPath, normalized, body, seenLines, summary.blocks, intervalsFromLineNumbers(seenLines), frontmatter);
  }

  if (target.raw) {
    const rawIntervals = intervals ?? [{ start: 1, end: lineCount }];
    const rawText = renderRaw(normalized, lines, intervals ?? [], target.selector !== undefined, display);
    if (frontmatter?.text) {
      const prepared = preparedAuthority(display, canonicalPath, normalized, frontmatter.text, lineNumbersFromIntervals(frontmatter.intervals), [], frontmatter.intervals, frontmatter);
      prepared.text = `${prepared.text}\n\n${rawText}`;
      return prepared;
    }
    return withFrontmatter({ text: rawText, canonicalPath, displayPath: display, intervals: rawIntervals }, canonicalPath, frontmatter);
  }

  if (frontmatter?.intervals.length) intervals = mergeSourceIntervals([...(intervals ?? []), ...frontmatter.intervals]);
  const exactIntervals = intervals ?? [];
  const blocks = exactIntervals.map(interval => formatNumberedLines(lines.slice(interval.start - 1, interval.end), interval.start));
  const sourceBody = blocks.join("\n…\n");
  const context = resolvedSelector?.context.map(value => `Within: ${value}`).join("\n") ?? "";
  const body = [context, sourceBody].filter(Boolean).join("\n");
  const previewOutput = body ? `${formatHeader(display, "0000")}\n${body}` : formatHeader(display, "0000");
  const exactBudget = target.explicitSelector ? DEFAULT_EXPLICIT_SELECTOR_BUDGET : DEFAULT_EXACT_BUDGET;
  if (previewOutput.length > exactBudget && !target.explicitSelector) {
    const summary = await renderSmartSummaryWithMetadata({ cwd: params.cwd, displayPath: display, absolutePath, normalized, lines, kind: "file", sizeBytes: info.size }, { signal: params.signal });
    if (!summary) return withFrontmatter({ text: fallbackSummary(display, lines), displayPath: display }, canonicalPath, frontmatter);
    const summaryBody = [frontmatter?.text, summary.text].filter(Boolean).join("\n");
    const seenLines = [...new Set([...lineNumbersFromIntervals(frontmatter?.intervals ?? []), ...seenLinesFromNumberedBody(summary.text)])].sort((a, b) => a - b);
    if (seenLines.length === 0) return withFrontmatter({ text: summary.text, displayPath: display }, canonicalPath, frontmatter);
    return preparedAuthority(display, canonicalPath, normalized, summaryBody, seenLines, summary.blocks, intervalsFromLineNumbers(seenLines), frontmatter);
  }
  if (previewOutput.length > exactBudget && target.explicitSelector) {
    return { text: `Read refused: exact selector output for ${display} exceeds budget (${formatBytes(Buffer.byteLength(previewOutput, "utf8"))} > ${formatBytes(exactBudget)}). Narrow the selector, e.g. ${display}:120-180.\nNo edit hash was created.`, displayPath: display };
  }

  const exactSeenLines = lineNumbersFromIntervals(exactIntervals);
  const exactSeen = new Set(exactSeenLines);
  const structural = await resolveStructuralBlocks({ path: absolutePath, text: normalized, timeoutMs: 2_000, signal: params.signal });
  const exactBlocks = (structural?.blocks ?? []).filter(block => exactSeen.has(block.start) && exactSeen.has(block.end));
  return preparedAuthority(display, canonicalPath, normalized, body, exactSeenLines, exactBlocks, exactIntervals, frontmatter);
}

function preparedAuthority(display: string, canonicalPath: string, normalized: string, body: string, seenLines: number[], blocks: SnapshotBlock[], intervals: Interval[], frontmatter?: MarkdownFrontmatterSelection): PreparedReadResult {
  const tag = computeTag(normalized);
  return withFrontmatter({
    text: body ? `${formatHeader(display, tag)}\n${body}` : formatHeader(display, tag),
    tag,
    canonicalPath,
    displayPath: display,
    intervals,
    authority: { text: normalized, seenLines, blocks },
  }, canonicalPath, frontmatter);
}

function withFrontmatter(prepared: PreparedReadResult, canonicalPath: string, frontmatter?: MarkdownFrontmatterSelection): PreparedReadResult {
  if (frontmatter?.relationshipEvidence) prepared.text = `${prepared.text}\n\n${frontmatter.relationshipEvidence}`;
  if (frontmatter) prepared.frontmatter = { canonicalPath, status: frontmatter.status, inspected: frontmatter.inspected, digest: frontmatter.digest };
  return prepared;
}

export function commitPreparedRead(prepared: PreparedReadResult, frontmatterExposureState?: MarkdownFrontmatterExposureState): ReadExactResult {
  if (prepared.authority && prepared.canonicalPath) {
    const snapshot = snapshots.record(prepared.canonicalPath, prepared.authority.text, prepared.authority.seenLines, prepared.authority.blocks);
    if (prepared.tag && snapshot.tag !== prepared.tag) throw new Error("Read refused: prepared source identity changed before authority commit.");
  }
  if (prepared.frontmatter?.inspected && frontmatterExposureState) commitMarkdownFrontmatterExposure(frontmatterExposureState, prepared.frontmatter.canonicalPath, prepared.frontmatter.digest);
  const { authority: _authority, frontmatter: _frontmatter, ...result } = prepared;
  return result;
}

export async function renderRead(params: { cwd: string; path: string; signal?: AbortSignal; frontmatterExposureState?: MarkdownFrontmatterExposureState; frontmatterMaxBytes?: number }): Promise<ReadExactResult> {
  return commitPreparedRead(await prepareRead(params), params.frontmatterExposureState);
}

interface BatchGroupPlan {
  requestIndexes: number[];
  selectors: string[];
  retrySelector: string;
  preflight?: ReadPreflight;
  image?: boolean;
  error?: string;
}

interface PreparedBatchGroup extends BatchGroupPlan {
  prepared?: PreparedReadResult;
  text: string;
}

interface BatchFilePlan {
  firstIndex: number;
  preflight: ReadPreflight;
  buckets: Map<string, BatchGroupPlan & { selectorChunks: string[] }>;
}

export async function renderReadBatch(params: {
  cwd: string;
  paths: string[];
  signal?: AbortSignal;
  maxBytes?: number;
  maxLines?: number;
  strictAuthority?: boolean;
  proofRoot?: string;
  frontmatterExposureState?: MarkdownFrontmatterExposureState;
  frontmatterMaxBytes?: number;
}): Promise<BatchReadResult> {
  const plannedFrontmatterState = cloneMarkdownFrontmatterExposureState(params.frontmatterExposureState ?? createMarkdownFrontmatterExposureState());
  const plans = await planBatchGroups(params);
  const groups: PreparedBatchGroup[] = [];
  for (const plan of plans) {
    if (params.signal?.aborted) throw new Error("Read aborted before completion.");
    if (plan.error) {
      groups.push({ ...plan, text: `[${boundedSelector(plan.retrySelector)}]\nRead failed: ${boundedReason(plan.error)}` });
      continue;
    }
    if (plan.image) {
      groups.push({ ...plan, text: `[${plan.preflight?.displayPath ?? boundedSelector(plan.retrySelector)}]\nRead batch skipped image/media input. Retry this item with single-file read({ path: ${JSON.stringify(plan.retrySelector)} }).` });
      continue;
    }
    try {
      const prepared = await prepareRead({ cwd: params.cwd, path: plan.retrySelector, signal: params.signal, frontmatterExposureState: plannedFrontmatterState, frontmatterMaxBytes: params.frontmatterMaxBytes });
      if (prepared.frontmatter?.inspected) commitMarkdownFrontmatterExposure(plannedFrontmatterState, prepared.frontmatter.canonicalPath, prepared.frontmatter.digest);
      groups.push({ ...plan, prepared, text: prepared.text });
    } catch (error: any) {
      if (params.signal?.aborted || /aborted/i.test(String(error?.message ?? error))) throw new Error("Read aborted before completion.");
      groups.push({ ...plan, error: String(error?.message ?? error), text: `[${boundedSelector(plan.retrySelector)}]\nRead failed: ${boundedReason(error?.message ?? error)}` });
    }
  }
  if (params.signal?.aborted) throw new Error("Read aborted before completion.");

  if (params.strictAuthority) return finishStrictBatch(params, groups);
  return finishPublicBatch(params.paths.length, groups, params.maxBytes ?? 96 * 1024, params.frontmatterExposureState);
}

async function planBatchGroups(params: { cwd: string; paths: string[]; signal?: AbortSignal }): Promise<BatchGroupPlan[]> {
  const ordered: Array<{ firstIndex: number; file?: BatchFilePlan; error?: BatchGroupPlan }> = [];
  const files = new Map<string, BatchFilePlan>();
  for (let index = 0; index < params.paths.length; index++) {
    if (params.signal?.aborted) throw new Error("Read aborted before completion.");
    const requested = params.paths[index]!;
    let preflight: ReadPreflight;
    try {
      preflight = await preflightRead({ cwd: params.cwd, path: requested, signal: params.signal });
    } catch (error: any) {
      if (params.signal?.aborted || /aborted/i.test(String(error?.message ?? error))) throw new Error("Read aborted before completion.");
      ordered.push({ firstIndex: index, error: { requestIndexes: [index], selectors: [requested], retrySelector: requested, error: String(error?.message ?? error) } });
      continue;
    }
    let file = files.get(preflight.canonicalPath);
    if (!file) {
      file = { firstIndex: index, preflight, buckets: new Map() };
      files.set(preflight.canonicalPath, file);
      ordered.push({ firstIndex: index, file });
    }
    const image = IMAGE_EXTENSIONS.has(preflight.extension);
    const key = image ? "image" : `${preflight.target.raw ? "raw" : "text"}:${preflight.target.selector ? "explicit" : "bare"}`;
    let bucket = file.buckets.get(key);
    if (!bucket) {
      bucket = { requestIndexes: [], selectors: [], retrySelector: requested, preflight, image, selectorChunks: [] };
      file.buckets.set(key, bucket);
    }
    bucket.requestIndexes.push(index);
    bucket.selectors.push(requested);
    if (preflight.target.selector && !bucket.selectorChunks.includes(preflight.target.selector)) bucket.selectorChunks.push(preflight.target.selector);
  }

  const plans: BatchGroupPlan[] = [];
  for (const item of ordered.sort((a, b) => a.firstIndex - b.firstIndex)) {
    if (item.error) {
      plans.push(item.error);
      continue;
    }
    for (const bucket of item.file!.buckets.values()) {
      const target = bucket.preflight!.target;
      const selector = bucket.selectorChunks.length ? `:${bucket.selectorChunks.join(",")}` : "";
      bucket.retrySelector = `${target.filePath}${selector}${target.raw ? ":raw" : ""}`;
      plans.push(bucket);
    }
  }
  return plans;
}

function finishStrictBatch(params: { paths: string[]; maxBytes?: number; maxLines?: number; proofRoot?: string }, groups: PreparedBatchGroup[]): BatchReadResult {
  const failure = groups.find(group => group.error || group.image || !group.prepared?.authority);
  if (failure) return failedStrictBatch(params.paths.length, groups, failure.error ?? (failure.image ? "image/media inputs require single-file read" : "live read returned no edit hash"));
  if (params.proofRoot) {
    for (const group of groups) {
      const invalid = validateCompleteNumberedProof(params.proofRoot, group.prepared!);
      if (invalid) return failedStrictBatch(params.paths.length, groups, invalid);
    }
  }
  const lineCount = groups.reduce((total, group) => total + intervalLineCount(group.prepared?.intervals ?? []), 0);
  if (params.maxLines !== undefined && lineCount > params.maxLines) return failedStrictBatch(params.paths.length, groups, `expanded source would display ${lineCount} lines; limit is ${params.maxLines}`);
  const text = groups.map(group => group.text).join("\n\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (params.maxBytes !== undefined && bytes > params.maxBytes) return failedStrictBatch(params.paths.length, groups, `expanded source would use ${bytes} bytes; limit is ${params.maxBytes}`);
  const files = groups.map(group => detailForGroup(group, "shown", commitPreparedRead(group.prepared!)));
  return { text, files, counts: { requested: params.paths.length, groups: groups.length, shown: groups.length, errors: 0, omitted: 0 }, complete: true };
}

function failedStrictBatch(requested: number, groups: PreparedBatchGroup[], reason: string): BatchReadResult {
  return {
    text: "",
    files: groups.map(group => detailForGroup(group, group.error ? "error" : "omitted")),
    counts: { requested, groups: groups.length, shown: 0, errors: groups.filter(group => group.error).length, omitted: groups.length },
    complete: false,
    reason,
  };
}

function finishPublicBatch(requested: number, groups: PreparedBatchGroup[], maxBytes: number, frontmatterExposureState?: MarkdownFrontmatterExposureState): BatchReadResult {
  const errors = groups.filter(group => group.error).length;
  let shown = groups.length;
  let text = "";
  while (shown >= 0) {
    text = publicBatchText(groups, shown, requested, errors);
    if (Buffer.byteLength(text, "utf8") <= maxBytes || shown === 0) break;
    shown--;
  }
  const details: BatchReadFileDetail[] = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    if (index >= shown) {
      details.push(detailForGroup(group, "omitted", undefined, `aggregate ${formatBytes(maxBytes)} batch budget`));
    } else if (group.error) {
      details.push(detailForGroup(group, "error", undefined, group.error));
    } else if (group.prepared?.authority) {
      details.push(detailForGroup(group, "shown", commitPreparedRead(group.prepared, frontmatterExposureState)));
    } else if (group.prepared) {
      details.push(detailForGroup(group, "shown_no_authority", commitPreparedRead(group.prepared, frontmatterExposureState), group.image ? "image/media inputs require single-file read" : "displayed output does not grant edit authority"));
    } else {
      details.push(detailForGroup(group, "shown_no_authority", undefined, group.image ? "image/media inputs require single-file read" : "displayed output does not grant edit authority"));
    }
  }
  const omitted = groups.length - shown;
  return { text, files: details, counts: { requested, groups: groups.length, shown, errors, omitted }, complete: errors === 0 && omitted === 0 };
}

function publicBatchText(groups: PreparedBatchGroup[], shown: number, requested: number, errors: number): string {
  const visible = groups.slice(0, shown).map(group => group.text);
  const omitted = groups.slice(shown);
  if (errors || omitted.length) {
    const lines = [`Read batch incomplete: requested=${requested} groups=${groups.length} shown=${shown} errors=${errors} omitted=${omitted.length}.`];
    if (omitted.length) {
      lines.push("Omitted groups — retry separately:");
      for (const group of omitted) lines.push(`- ${boundedSelector(group.retrySelector)}`);
    }
    visible.push(lines.join("\n"));
  }
  return visible.join("\n\n");
}

function detailForGroup(group: PreparedBatchGroup, status: BatchReadStatus, result?: ReadExactResult, reason?: string): BatchReadFileDetail {
  return {
    requestIndexes: group.requestIndexes,
    selectors: group.selectors,
    retrySelector: group.retrySelector,
    status,
    mergedRequestCount: group.requestIndexes.length,
    canonicalPath: group.preflight?.canonicalPath,
    path: result?.displayPath ?? group.preflight?.displayPath,
    tag: status === "shown" ? result?.tag : undefined,
    intervals: status === "shown" ? result?.intervals : undefined,
    reason: reason ? boundedReason(reason) : undefined,
  };
}

export function validateCompleteNumberedProof(rootPath: string, read: ReadExactResult): string | undefined {
  if (!read.tag || !read.canonicalPath || !read.intervals?.length) return "live read returned no edit hash";
  let root = resolve(rootPath);
  try { root = realpathSync(root); } catch {}
  const rel = relative(root, resolve(read.canonicalPath));
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) return "proof target is outside the requested project root";
  const rows = new Set<number>();
  for (const line of read.text.split("\n")) {
    const match = /^(\d+):/.exec(line);
    if (match) rows.add(Number(match[1]));
  }
  for (const interval of read.intervals) {
    for (let line = interval.start; line <= interval.end; line++) if (!rows.has(line)) return `live proof did not display complete line ${line}`;
  }
  return undefined;
}

function intervalLineCount(intervals: Interval[]): number {
  return intervals.reduce((total, interval) => total + Math.max(0, interval.end - interval.start + 1), 0);
}

function boundedSelector(selector: string): string {
  return selector.length <= 240 ? selector : `${selector.slice(0, 237)}...`;
}

function boundedReason(reason: unknown): string {
  const text = String(reason ?? "unknown read failure").replace(/\s+/g, " ").trim();
  return text.length <= 400 ? text : `${text.slice(0, 397)}...`;
}

const LARGE_RANGE_MAX_LINES = 240;
const LARGE_RANGE_SCAN_BYTES = 32 * 1024 * 1024;

async function renderUnsafeOrLargeRead(params: { absolutePath: string; display: string; target: ParsedReadPath; sizeBytes: number; reason: string; signal?: AbortSignal }): Promise<ReadExactResult> {
  if (params.reason === "aborted") throw new Error("Read aborted before completion.");
  if (params.reason === "extension" || params.reason === "binary") {
    return {
      text: `Read refused: ${params.display} looks like binary/media or non-text data. No edit hash was created.\nNext: use a purpose-built media/database/archive tool, or inspect a text export instead.`,
      displayPath: params.display,
    };
  }
  if (params.reason !== "large") {
    return {
      text: `Read refused: could not safely read ${params.display}. No edit hash was created.\nNext: check the path and permissions, or use a narrower known text file.`,
      displayPath: params.display,
    };
  }

  if (params.target.selector?.split(",").some(chunk => isSectionSelectorChunk(chunk.trim()))) {
    return {
      text: `Read refused: markdown section selectors for ${params.display} require a safely snapshotable live file. ${formatBytes(params.sizeBytes)} exceeds the hash-snapshot cap. No edit hash was created.\nNext: use a bounded numeric range for inspection, or narrow the file before editing.`,
      displayPath: params.display,
    };
  }

  const sniff = await readTextSampleSafely(params.absolutePath, { maxFileBytes: Number.MAX_SAFE_INTEGER, sampleBytes: 8192, signal: params.signal });
  if (!sniff.ok && sniff.reason !== "large") {
    return {
      text: `Read refused: ${params.display} is ${formatBytes(params.sizeBytes)} and does not look safely text-readable (${sniff.reason}). No edit hash was created.`,
      displayPath: params.display,
    };
  }
  if (!params.target.selector) {
    return {
      text: largeFileSummary(params.display, params.sizeBytes, params.target.raw),
      displayPath: params.display,
    };
  }
  const text = await renderLargeRangeNoTag(params.absolutePath, params.display, params.target.selector, params.target.raw, params.sizeBytes, params.signal);
  return { text, displayPath: params.display };
}

function largeFileSummary(display: string, sizeBytes: number, raw: boolean): string {
  if (raw) {
    return `Read refused: raw whole-file read for ${display} is ${formatBytes(sizeBytes)}, above the ${formatBytes(DEFAULT_TAGGED_READ_BYTES)} snapshot cap. No edit hash was created.\nNext: use a bounded selector (e.g. ${display}:1-80:raw) for no-hash inspection.`;
  }
  return `[${display} · large file · no edit hash]\n${formatBytes(sizeBytes)} exceeds the ${formatBytes(DEFAULT_TAGGED_READ_BYTES)} hash-snapshot cap; whole-file decode was skipped to protect CPU/RAM.\nNext: use a bounded selector (e.g. ${display}:1-80) for no-hash inspection. Hash edit authority is disabled above this cap.`;
}

async function renderLargeRangeNoTag(absolutePath: string, display: string, selector: string, raw: boolean, sizeBytes: number, signal?: AbortSignal): Promise<string> {
  const intervals = parseBoundedLargeLineRanges(selector);
  const maxEnd = Math.max(...intervals.map(interval => interval.end));
  const minStart = Math.min(...intervals.map(interval => interval.start));
  const rows: { line: number; text: string }[] = [];
  let currentLine = 0;
  let bytesSeen = 0;
  let carry = "";
  let scanCapped = false;

  const stream = createReadStream(absolutePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw new Error("Read aborted before completion.");
      const text = String(chunk);
      bytesSeen += Buffer.byteLength(text, "utf8");
      if (bytesSeen > LARGE_RANGE_SCAN_BYTES) {
        scanCapped = true;
        break;
      }
      const parts = `${carry}${text}`.split("\n");
      carry = parts.pop() ?? "";
      for (const part of parts) {
        currentLine++;
        maybeCollectLargeLine(rows, currentLine, part.replace(/\r$/, ""), intervals);
        if (currentLine >= maxEnd) break;
      }
      if (currentLine >= maxEnd || scanCapped) break;
    }
    if (!scanCapped && currentLine < maxEnd && carry.length > 0) {
      currentLine++;
      maybeCollectLargeLine(rows, currentLine, carry.replace(/\r$/, ""), intervals);
    }
  } finally {
    stream.destroy();
  }

  if (scanCapped && currentLine < maxEnd) {
    return `Read refused: ${display}:${selector} would require scanning beyond the ${formatBytes(LARGE_RANGE_SCAN_BYTES)} large-file range cap (${formatBytes(sizeBytes)} file). No edit hash was created.\nNext: choose an earlier bounded range or use grep with a narrow glob/path.`;
  }
  if (currentLine < minStart) {
    return `Read refused: line ${minStart} is beyond end of file (${currentLine} lines scanned). No edit hash was created.`;
  }

  const body = raw ? rows.map(row => row.text).join("\n") : renderLargeRows(rows);
  if (Buffer.byteLength(body, "utf8") > DEFAULT_EXACT_BUDGET) {
    return `Read refused: exact selector output for ${display} exceeds budget. Narrow the selector, e.g. ${display}:${intervals[0]?.start}-${Math.min(intervals[0]?.start ?? 1, intervals[0]?.end ?? 1)}.\nNo edit hash was created.`;
  }
  if (raw) return `[${display} · raw range · no edit hash]\nLarge file ${formatBytes(sizeBytes)}; raw bounded range shown for inspection only. Re-read exact numbered ranges before claims or edits.\n${body}`;
  return `[${display} · range · no edit hash]\nLarge file ${formatBytes(sizeBytes)}; bounded range shown without edit authority.\n${body}\nNo edit hash was created. Use this for inspection only; edits require a fresh [path#HASH] from a safely snapshotable file.`;
}

function parseBoundedLargeLineRanges(selector: string): Interval[] {
  const chunks = selector.split(",").map(chunk => chunk.trim()).filter(Boolean);
  if (!chunks.length) throw new Error("Read refused: empty line selector.");
  const intervals = chunks.map(chunk => {
    const match = RANGE_CHUNK_RE.exec(chunk);
    if (!match) throw new Error(`Read refused: unsupported selector :${chunk}. Use bounded :START-END or :START+COUNT for large files.`);
    const start = Number.parseInt(match[1]!, 10);
    const sep = match[2] === ".." ? "-" : match[2];
    const rhs = match[3] ? Number.parseInt(match[3], 10) : undefined;
    if (start < 1) throw new Error("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
    if (!sep || (sep === "-" && rhs === undefined)) throw new Error(`Read refused: open-ended selector :${chunk} is unsafe for large files. Use bounded :START-END or :START+COUNT.`);
    const end = sep === "+" ? start + (rhs ?? 0) - 1 : rhs ?? start;
    if (sep === "+" && (!rhs || rhs < 1)) throw new Error(`Invalid range ${chunk}: count must be >= 1.`);
    if (end < start) throw new Error(`Invalid range ${chunk}: end must be >= start.`);
    return { start, end };
  });
  const total = intervals.reduce((sum, interval) => sum + interval.end - interval.start + 1, 0);
  if (total > LARGE_RANGE_MAX_LINES) throw new Error(`Read refused: selector spans ${total} lines in a large file. Limit large-file inspection to ${LARGE_RANGE_MAX_LINES} lines or fewer.`);
  intervals.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.start > previous.end + 1) merged.push({ ...interval });
    else previous.end = Math.max(previous.end, interval.end);
  }
  return merged;
}

function maybeCollectLargeLine(rows: { line: number; text: string }[], line: number, text: string, intervals: Interval[]): void {
  if (intervals.some(interval => line >= interval.start && line <= interval.end)) rows.push({ line, text });
}

function renderLargeRows(rows: { line: number; text: string }[]): string {
  const out: string[] = [];
  let previous = 0;
  for (const row of rows) {
    if (previous && row.line > previous + 1) out.push("…");
    out.push(`${row.line}:${row.text}`);
    previous = row.line;
  }
  return out.join("\n");
}

function defaultExactIntervals(lines: string[], normalized: string): Interval[] | undefined {
  if (lines.length === 0) return [];
  const wouldRender = normalized.length + lines.length * 8;
  if (lines.length <= DEFAULT_EXACT_LINES && wouldRender <= DEFAULT_EXACT_BUDGET) return [{ start: 1, end: lines.length }];
  return undefined;
}

function fallbackSummary(path: string, lines: string[]): string {
  return `[${path} · summary · no edit hash]\n${lines.length} lines. Use exact selectors before editing.`;
}

function renderRaw(normalized: string, lines: string[], intervals: Interval[], ranged: boolean, display = "file"): string {
  const body = !ranged ? normalized : intervals.map(interval => lines.slice(interval.start - 1, interval.end).join("\n")).join("\n");
  return `[${display} · raw · no edit hash]\nRaw text shown for inspection only; re-read exact numbered ranges before claims or edits.\n${body}`;
}
