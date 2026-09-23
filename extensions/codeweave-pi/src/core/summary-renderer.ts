import { extname } from "node:path";
import { normalizeSummaryResult } from "./summary-normalize.ts";
import { runSummaryProvider, type SmartSummaryProvider, type SummaryEntry, type SummaryInput, type SummaryResult } from "./smart-summary-provider.ts";
import type { SnapshotBlock } from "./snapshot-store.ts";
import { resolveStructuralBlocks } from "./structural-block-resolver.ts";
import { localConfigTextProvider } from "../providers/local-config-text-provider.ts";
import { localMarkdownProvider } from "../providers/local-markdown-provider.ts";
import { localSourceHeuristicProvider } from "../providers/local-source-heuristic-provider.ts";
import { piNavSmartSummaryProvider } from "../providers/pi-nav-smart-summary-provider.ts";

export interface SummaryParams {
  cwd: string;
  displayPath: string;
  absolutePath: string;
  normalized?: string;
  lines?: string[];
  kind?: "file" | "directory";
  sizeBytes?: number;
}

export interface RenderSmartSummaryOptions {
  providers?: SmartSummaryProvider[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RenderedSmartSummary {
  text: string;
  blocks: SnapshotBlock[];
}

export const DEFAULT_SUMMARY_PROVIDERS: SmartSummaryProvider[] = [
  piNavSmartSummaryProvider,
  localMarkdownProvider,
  localSourceHeuristicProvider,
  localConfigTextProvider,
];



export async function renderSmartSummary(params: SummaryParams, options: RenderSmartSummaryOptions = {}): Promise<string | undefined> {
  return (await renderSmartSummaryWithMetadata(params, options))?.text;
}

export async function renderSmartSummaryWithMetadata(params: SummaryParams, options: RenderSmartSummaryOptions = {}): Promise<RenderedSmartSummary | undefined> {
  const input: SummaryInput = {
    cwd: params.cwd,
    absolutePath: params.absolutePath,
    displayPath: params.displayPath,
    kind: params.kind ?? "file",
    text: params.normalized,
    lines: params.lines,
    sizeBytes: params.sizeBytes ?? params.normalized?.length,
    extension: extname(params.absolutePath).toLowerCase(),
  };

  const render = async (result: SummaryResult | null): Promise<RenderedSmartSummary | undefined> => {
    const text = normalizeSummaryResult(input, result);
    if (!text) return undefined;
    const structural = await resolveStructuralBlocks({ path: input.absolutePath, text: input.text ?? "", timeoutMs: options.timeoutMs ?? 2_000, signal: options.signal });
    const blocks = structural ? visibleStructuralBlocks(structural.blocks, text, input.lines) : editableBlocks(result?.entries ?? [], text, input.lines);
    return { text: blocks.length ? `${text}\n\n${formatBlockHint(blocks)}` : text, blocks };
  };

  const providers = [...(options.providers ?? DEFAULT_SUMMARY_PROVIDERS)].sort((a, b) => a.priority - b.priority);
  const native = providers.find(provider => provider.name === "native-smart-read" && provider.canHandle(input));
  if (native) {
    const rendered = await render(await runSummaryProvider(native, input, { signal: options.signal, timeoutMs: options.timeoutMs }));
    if (rendered) return rendered;
  }
  // Read summarization is a presentation optimization, not prepared project
  // intelligence. A bounded local structural provider is preferable to forcing
  // a second range read when the native summarizer is temporarily unavailable.
  for (const provider of providers) {
    if (provider === native || !provider.canHandle(input)) continue;
    const rendered = await render(await runSummaryProvider(provider, input, { signal: options.signal, timeoutMs: options.timeoutMs }));
    if (rendered) return rendered;
  }
  return native ? { text: nativeSmartReadUnavailable(input), blocks: [] } : undefined;
}

function visibleStructuralBlocks(blocks: SnapshotBlock[], rendered: string, lines?: string[]): SnapshotBlock[] {
  const completeRows = completeRenderedRows(rendered);
  return blocks.filter(block => block.start >= 1 && block.end > block.start && (lines === undefined || block.end <= lines.length) && completeRows.has(block.start) && completeRows.has(block.end));
}

function completeRenderedRows(rendered: string): Set<number> {
  return new Set(rendered.split("\n").flatMap(row => {
    const match = /^(\d+):/.exec(row);
    return match ? [Number(match[1])] : [];
  }));
}

function editableBlocks(entries: SummaryEntry[], rendered: string, lines?: string[]): SnapshotBlock[] {
  const completeRows = completeRenderedRows(rendered);
  const blocks: SnapshotBlock[] = [];
  const visit = (entry: SummaryEntry) => {
    const start = entry.start;
    const end = entry.end;
    if ((entry.confidence === "high" || entry.confidence === "medium") && (entry.kind === "function" || entry.kind === "class" || entry.kind === "heading") && typeof start === "number" && typeof end === "number" && Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end > start && (lines === undefined || end <= lines.length) && completeRows.has(start) && completeRows.has(end) && blockBoundaryLooksSafe(entry.kind, start, end, lines)) {
      blocks.push({ start, end, kind: entry.kind, label: entry.label, parser: "deterministic-local" });
    }
    for (const child of entry.children ?? []) visit(child);
  };
  for (const entry of entries) visit(entry);
  return blocks;
}

function formatBlockHint(blocks: SnapshotBlock[]): string {
  const shown = blocks.slice(0, 4).map(block => `line ${block.start} ${block.label} → ${block.start}..${block.end}`).join("; ");
  const extra = blocks.length > 4 ? `; … ${blocks.length - 4} more` : "";
  return `[Certified whole-block anchors: ${shown}${extra}. Use REPLACE/DELETE BLOCK AT N or INSERT AFTER BLOCK AT N only for these opening lines.]`;
}

function blockBoundaryLooksSafe(kind: SnapshotBlock["kind"], start: number, end: number, lines?: string[]): boolean {
  if (!lines) return false;
  const opening = (lines[start - 1] ?? "").trim();
  const closing = (lines[end - 1] ?? "").trim();
  if (kind === "heading") return /^#{1,6}\s+\S/.test(opening);
  if (!/\b(?:function|class|interface|struct|impl|trait|object|fn|func)\b/.test(opening)) return false;
  if (!/^}[;,)\]]*(?:\s*\/\/.*)?$/.test(closing)) return false;
  return braceSpanIsExact(lines, start, end);
}

function braceSpanIsExact(lines: string[], start: number, end: number): boolean {
  let depth = 0;
  let sawOpening = false;
  let blockComment = false;
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (let lineNumber = start; lineNumber <= end; lineNumber++) {
    const line = lines[lineNumber - 1] ?? "";
    for (let index = 0; index < line.length; index++) {
      const char = line[index]!;
      const next = line[index + 1];
      if (blockComment) {
        if (char === "*" && next === "/") { blockComment = false; index++; }
        continue;
      }
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char === quote) quote = undefined;
        continue;
      }
      if (char === "/" && next === "/") break;
      if (char === "/" && next === "*") { blockComment = true; index++; continue; }
      if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
      if (char === "{") { depth++; sawOpening = true; continue; }
      if (char !== "}") continue;
      depth--;
      if (depth < 0 || (depth === 0 && lineNumber < end)) return false;
    }
    if (quote !== "`") { quote = undefined; escaped = false; }
  }
  return sawOpening && depth === 0 && !blockComment && quote === undefined;
}

function nativeSmartReadUnavailable(input: SummaryInput): string {
  const lineText = typeof input.lines?.length === "number" ? `${input.lines.length} lines. ` : "";
  return `[${input.displayPath} · smart read unavailable · no edit hash]\n${lineText}No structural provider returned a usable summary. Use a grouped exact selector (e.g. ${input.displayPath}:1-80) for proof/edit authority.`;
}
