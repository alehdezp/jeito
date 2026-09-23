import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth as tuiTruncateToWidth, visibleWidth as tuiVisibleWidth } from "@earendil-works/pi-tui";

type ThemeLike = Pick<Theme, "fg" | "bold">;
type DisplayDensity = "ultra" | "condensed" | "normal" | "extended";
type FrameStatus = "pending" | "success" | "partial" | "warning" | "error";
const MAX_RENDERED_UI_LINES = 30;
const CONDENSED_RENDERED_UI_LINES = 8;
const EXTENDED_RENDERED_UI_LINES = 120;
const DENSITY_LEVELS: DisplayDensity[] = ["ultra", "condensed", "normal", "extended"];
const JEITO_DENSITY_KEY = Symbol.for("pi.agent.jeitoDensity.v1");
// Shared own density — cycled only by Ctrl+U, ignores Pi's ctx.expanded (Ctrl+O).
const JEITO_DENSITY_STATE: { level: number } = (() => { const g = globalThis as any; return (g[JEITO_DENSITY_KEY] ??= { level: 1 }); })();
export function currentDensity(): DisplayDensity { return DENSITY_LEVELS[JEITO_DENSITY_STATE.level] ?? "condensed"; }
export function cycleDensity(): DisplayDensity { JEITO_DENSITY_STATE.level = (JEITO_DENSITY_STATE.level + 1) % DENSITY_LEVELS.length; return currentDensity(); }
export function resetDisplayDensityForTests(): void { JEITO_DENSITY_STATE.level = 0; }
const EXPAND_HINT = " • Ctrl+U to cycle view";
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const ANSI_AT_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/y;
const TAB_STOP = 8;
const ANSI_RESET = "\x1b[0m";
const TOOL_BORDER_COLORS: Record<string, string> = {
  web_search: "\x1b[38;2;92;124;250m",
  web_search_exa: "\x1b[38;2;92;124;250m",
  web_search_x: "\x1b[38;2;92;124;250m",
  web_search_tavily: "\x1b[38;2;92;124;250m",
  web_fetch: "\x1b[38;2;77;182;172m",
  web_lookup: "\x1b[38;2;79;195;247m",
  web_answer: "\x1b[38;2;79;195;247m",
  context7: "\x1b[38;2;148;226;213m",
  web_answer_exa: "\x1b[38;2;79;195;247m",
  web_answer_linkup: "\x1b[38;2;79;195;247m",
  default: "\x1b[38;2;139;148;158m",
};
const NERD_TOOL_ICONS: Record<string, string> = {
  web_search: "\uf002", web_search_exa: "\uf002", web_search_x: "\uf002", web_search_tavily: "\uf002",
  web_fetch: "\uf0ac", web_lookup: "\uf02d", context7: "\uf02d", web_answer: "\uf059", web_answer_exa: "\uf059", web_answer_linkup: "\uf059", default: "\uf15b",
};
function rememberDensity(_theme?: any, _options?: any, _ctx?: any): void { }

export function configuredNerdFont(env: Record<string, string | undefined> = process.env, home = homedir()): boolean {
  const override = String(env.PI_NAV_NERD_FONT ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(override)) return true;
  if (["0", "false", "no", "off"].includes(override)) return false;
  const terminal = String(env.TERM_PROGRAM ?? "").toLowerCase();
  const candidates = terminal.includes("ghostty")
    ? [join(home, ".config", "ghostty", "config")]
    : env.KITTY_WINDOW_ID
      ? [join(env.KITTY_CONFIG_DIRECTORY ?? join(home, ".config", "kitty"), "kitty.conf")]
      : terminal.includes("wezterm")
        ? [join(home, ".wezterm.lua"), join(home, ".config", "wezterm", "wezterm.lua")]
        : [];
  for (const path of candidates) {
    try {
      if (/nerd\s*font/i.test(readFileSync(path, "utf8"))) return true;
    } catch {
      // Unknown or unreadable terminal configuration means no decorative icon.
    }
  }
  return false;
}

const NERD_FONT_AVAILABLE = configuredNerdFont();

function toolIcon(theme: ThemeLike, tool: string): string {
  const glyph = NERD_FONT_AVAILABLE ? NERD_TOOL_ICONS[tool] : undefined;
  return glyph ? `${fg(theme, "accent", glyph)}  ` : "";
}

function fg(theme: ThemeLike, style: ThemeColor, text: string): string {
  return typeof theme.fg === "function" ? theme.fg(style, text) : text;
}
function bold(theme: ThemeLike, text: string): string {
  return typeof theme.bold === "function" ? theme.bold(text) : text;
}
function statusColor(status: FrameStatus): ThemeColor {
  if (status === "error") return "error";
  if (status === "partial" || status === "warning" || status === "pending") return "warning";
  return "success";
}
function statusIcon(status: FrameStatus): string {
  if (status === "error") return "✗";
  if (status === "warning") return "⚠";
  if (status === "partial") return "◐";
  if (status === "pending") return "…";
  return "✓";
}
function toolBorder(tool: string, text: string): string {
  return `${TOOL_BORDER_COLORS[tool] ?? TOOL_BORDER_COLORS.default}${text}${ANSI_RESET}`;
}
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
function visibleWidth(s: string): number {
  return tuiVisibleWidth(s);
}
function clampLineToWidth(line: string, width: unknown): string {
  const w = typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width as number) : 80;
  const safe = normalizeTerminalControls(line);
  return visibleWidth(safe) <= w ? safe : tuiTruncateToWidth(safe, w, "…");
}
function normalizeTerminalControls(text: string): string {
  let out = "";
  let column = 0;
  for (let i = 0; i < text.length;) {
    ANSI_AT_RE.lastIndex = i;
    const m = ANSI_AT_RE.exec(text);
    if (m) {
      out += m[0];
      i = ANSI_AT_RE.lastIndex;
      continue;
    }
    const code = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(code);
    i += ch.length;
    if (ch === "\t") {
      const sp = 8 - (column % 8 || 0);
      out += " ".repeat(sp);
      column += sp;
      continue;
    }
    if (code < 32 || (code >= 0x7f && code < 0xa0)) {
      out += " ";
      column += 1;
      continue;
    }
    out += ch;
    column += 1;
  }
  return out;
}
function frameTop(title: string, _status: FrameStatus, theme: ThemeLike, width: number, tool = "default"): string {
  void _status;
  void theme;
  const safe = clampLineToWidth(title, Math.max(1, width - 6));
  return `${toolBorder(tool, "╭──")} ${safe} ${toolBorder(tool, "─".repeat(Math.max(1, width - visibleWidth(safe) - 5)))}`;
}
function frameBottom(label: string, _status: FrameStatus, theme: ThemeLike, width: number, tool = "default"): string {
  void _status;
  void theme;
  const safe = clampLineToWidth(label, Math.max(1, width - 6));
  return `${toolBorder(tool, "╰──")} ${safe} ${toolBorder(tool, "─".repeat(Math.max(1, width - visibleWidth(safe) - 5)))}`;
}
class jeitoDensityBlock {
  private lines: string[]; private label: string; private status: FrameStatus; private theme: ThemeLike; private width: number; private tool: string; private maxLines: number;
  constructor(lines: string[], label: string, status: FrameStatus, theme: ThemeLike, width: number, tool: string, maxLines: number) {
    this.lines = lines; this.label = label; this.status = status; this.theme = theme; this.width = width; this.tool = tool; this.maxLines = maxLines;
  }
  setText(text: string): void { this.lines = text.split("\n"); }
  invalidate(): void { }
  wantsLeadingSpacer() { return currentDensity() !== "ultra"; }
  // Read accessors for the unified card (mirrors codeweave-pi's block getters).
  get labelText(): string { return this.label; }
  get blockStatus(): FrameStatus { return this.status; }
  get bodyLines(): string[] { return this.lines; }
  render(width: number): string[] {
    const w = typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width) : 100;
    const density = currentDensity();
    const effectiveMax = density === "extended" ? Math.max(this.maxLines, EXTENDED_RENDERED_UI_LINES) : density === "condensed" ? CONDENSED_RENDERED_UI_LINES : this.maxLines;
    const diagnostic = density === "ultra" && (this.status === "warning" || this.status === "error")
      ? this.lines.find(line => /(?:reason|failed|error|unavailable|weak anchor|requested callable|ambiguous|degraded|target:|exceptional:)/i.test(stripAnsi(line)))
      : undefined;
    const effectiveLabel = diagnostic ? `${this.label} \u00b7 ${fg(this.theme, "muted", stripAnsi(diagnostic!).trim())}` : this.label;
    const source = density === "ultra" ? [] : this.lines;
    const visible = source.length > effectiveMax - 1
      ? [...source.slice(0, effectiveMax - 2), fg(this.theme, "muted", `\u2026 ${source.length - (effectiveMax - 2)} more lines hidden · Ctrl+U to show`)]
      : source;
    const rail = toolBorder(this.tool, "\u2502");
    const body = visible.length
      ? [...visible.map(l => `${rail} ${clampLineToWidth(l, Math.max(1, w - 2))}`), frameBottom(effectiveLabel, this.status, this.theme, w, this.tool)]
      : [frameBottom(effectiveLabel, this.status, this.theme, w, this.tool)];
    const lines = body.join("\n").split("\n").map(l => clampLineToWidth(l, w));
    if (lines.length <= effectiveMax) return lines;
    const bottom = lines[lines.length - 1] ?? "";
    const note = clampLineToWidth(`${toolBorder(this.tool, "│")} ${fg(this.theme, "muted", `… UI truncated to ${effectiveMax} lines · Ctrl+U to show`)}`, w);
    return stripAnsi(bottom).startsWith("╰") ? [...lines.slice(0, effectiveMax - 2), note, bottom] : [...lines.slice(0, effectiveMax - 1), note];
  }
}
let activeWebCard: WebUnifiedBlock | undefined;
function bindWebResultCard(ctx: any) { activeWebCard = ctx?.state?.card instanceof WebUnifiedBlock ? ctx.state.card : undefined; }
function ensureWebCard(ctx: any, tool: string, theme: any, width: number, title: string): WebUnifiedBlock | undefined {
  const state = ctx?.state;
  if (!state || typeof state !== "object") return undefined;
  if (!(state as any).card || !((state as any).card instanceof WebUnifiedBlock)) {
    (state as any).card = new WebUnifiedBlock(tool, theme, width, title);
  } else {
    (state as any).card.refreshCall(title, theme, width);
  }
  return (state as any).card as WebUnifiedBlock;
}
function ultraHierarchyLine(head: string, target: string, metric: string, theme: ThemeLike, width: number): string {
  const available = Math.max(0, width - visibleWidth(head));
  let targetBudget = target ? Math.max(0, available - 1) : 0;
  if (target && metric) {
    const metricReserve = Math.min(24, Math.max(8, Math.floor(available * 0.38)));
    targetBudget = Math.max(0, available - metricReserve - 4);
  }
  const targetText = targetBudget > 0 ? tuiTruncateToWidth(normalizeTerminalControls(target), targetBudget, "…") : "";
  const targetPart = targetText ? ` ${fg(theme, "accent", targetText)}` : "";
  const metricBudget = metric ? Math.max(0, width - visibleWidth(head) - visibleWidth(targetPart) - 3) : 0;
  const metricText = metricBudget > 0 ? tuiTruncateToWidth(normalizeTerminalControls(metric), metricBudget, "…") : "";
  const metricPart = metricText ? `${fg(theme, "muted", " · ")}${fg(theme, "muted", metricText)}` : "";
  return clampLineToWidth(`${head}${targetPart}${metricPart}`, width);
}
function webTitleDetail(title: string, tool: string): string {
  const plain = stripAnsi(title).replace(/\s+/g, " ").trim();
  const start = plain.indexOf(tool);
  return start < 0 ? "" : plain.slice(start + tool.length).trim();
}
class WebUnifiedBlock {
  tool: string; theme: any; width: number; title: string; block: jeitoDensityBlock | undefined;
  constructor(tool: string, theme: any, width: number, title: string) { this.tool = tool; this.theme = theme; this.width = width; this.title = title; }
  refreshCall(title: string, theme: any, width: number) { this.title = title; this.theme = theme; this.width = width; }
  wantsLeadingSpacer() { return currentDensity() !== "ultra"; }
  receiveBlock(block: jeitoDensityBlock) { this.block = block; }
  setText() { }
  invalidate() { }
  render(width: number): string[] {
    const w = typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width) : 100;
    const density = currentDensity();
    const block: any = this.block;
    const detail = webTitleDetail(this.title, this.tool);
    const ultraTool = fg(this.theme, "toolTitle", bold(this.theme, this.tool));
    if (!block) {
      if (density === "ultra") return [ultraHierarchyLine(labelWithStatus("pending", ultraTool, this.theme), detail, "", this.theme, w)];
      const pending = labelWithStatus("pending", `pending ${this.tool}`, this.theme);
      return [frameTop(this.title, "pending", this.theme, w, this.tool), frameBottom(pending, "pending", this.theme, w, this.tool)].map(line => clampLineToWidth(line, w));
    }
    if (density === "ultra") {
      let plainLabel = stripAnsi(block.labelText).replace(/^[✓✗…◐⚠]\s*/, "").trim();
      if (plainLabel === this.tool) plainLabel = "";
      else if (plainLabel.startsWith(`${this.tool} `)) plainLabel = plainLabel.slice(this.tool.length + 1).trim();
      const target = detail && !plainLabel.startsWith(detail) ? detail : "";
      const head = labelWithStatus(block.blockStatus, ultraTool, this.theme);
      return [ultraHierarchyLine(head, target, plainLabel, this.theme, w)];
    }
    const top = frameTop(this.title, block.blockStatus, this.theme, w, this.tool);
    const body: string[] = block?.render?.(w) ?? [];
    const max = density === "condensed" ? CONDENSED_RENDERED_UI_LINES : density === "extended" ? EXTENDED_RENDERED_UI_LINES : MAX_RENDERED_UI_LINES;
    const merged = [top, ...(Array.isArray(body) ? body : [])].join("\n").split("\n").map(line => clampLineToWidth(line, w));
    if (merged.length <= max) return merged;
    const bottom = merged[merged.length - 1] ?? "";
    const note = clampLineToWidth(`${toolBorder(this.tool, "│")} ${fg(this.theme, "muted", `… UI truncated to ${max} lines · Ctrl+U to show`)}`, w);
    return stripAnsi(bottom).startsWith("╰") ? [...merged.slice(0, max - 2), note, bottom] : [...merged.slice(0, max - 1), note];
  }
}
function framed(lines: string[], label: string, status: FrameStatus, theme: ThemeLike, width: number, tool = "default", maxLines = MAX_RENDERED_UI_LINES): jeitoDensityBlock {
  const block = new jeitoDensityBlock(lines, label, status, theme, width, tool, maxLines);
  if (activeWebCard) { activeWebCard.receiveBlock(block); return { render: () => [], invalidate() { }, wantsLeadingSpacer() { return activeWebCard!.wantsLeadingSpacer(); } } as any; }
  return block;
}

export class TextBlock {
  private text: string;
  private readonly maxLines: number;
  constructor(text = "", maxLines = MAX_RENDERED_UI_LINES) {
    this.text = text;
    this.maxLines = maxLines;
  }
  setText(t: string): void {
    this.text = t;
  }
  wantsLeadingSpacer() { return currentDensity() !== "ultra"; }
  invalidate(): void { }
  render(width: number): string[] {
    const lines = this.text.split("\n").map((l) => clampLineToWidth(l, width));
    if (lines.length <= this.maxLines) return lines;
    const bottom = lines[lines.length - 1] ?? "";
    const note = clampLineToWidth(`│ … UI truncated to ${this.maxLines} lines · Ctrl+U to show`, width);
    return stripAnsi(bottom).startsWith("╰") ? [...lines.slice(0, this.maxLines - 2), note, bottom] : [...lines.slice(0, this.maxLines - 1), note];
  }
}

function textOf(result: any): string {
  return result?.content?.filter((x: any) => x?.type === "text").map((x: any) => x.text ?? "").join("\n") ?? "";
}
function widthOf(options: any, context: any): number {
  return typeof context?.width === "number" && context.width > 0 ? context.width : typeof options?.width === "number" && options.width > 0 ? options.width : 100;
}
function frameStatus(result: any, options: any, context: any, text = textOf(result)): FrameStatus {
  if (context?.isError || result?.isError || /^ERROR:/m.test(text)) return "error";
  if (result?.details?.failureClass) return "error";
  if (context?.isPartial ?? options?.isPartial) return "pending";
  const crawlStatus = result?.details?.crawlStatus;
  if (crawlStatus === "running") return "pending";
  if (result?.details?.status === "partial") return "partial";
  if (result?.details?.envelope?.status === "error") return "error";
  if (result?.details?.envelope?.status === "warning") return "warning";
  if (/^(?:WARNING|UNAVAILABLE|Read refused):/m.test(text)) return "warning";
  // Zero-result is not error but warning if explicitly 0 results with no failure
  if (result?.details?.resultCount === 0) return "warning";
  if (Array.isArray(result?.details?.results) && result.details.results.length === 0 && result?.details?.provider) {
    // Check if this was a successful zero rather than failure — keep warning
    if (!result?.details?.failureClass) return "warning";
  }
  if (Array.isArray(result?.details?.records) && result.details.records.length === 0 && !result?.details?.failureClass) return "warning";
  return "success";
}
function labelWithStatus(status: FrameStatus, text: string, theme: ThemeLike): string {
  return `${fg(theme, statusColor(status), statusIcon(status))} ${text}`;
}
function shorten(text: string, max = 80): string {
  const s = String(text ?? "").trim().replace(/\s+/g, " ");
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
function countLabel(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

// ---- Per-tool detail helpers ----

function attemptsCount(details: any): number {
  return Array.isArray(details?.attempts) ? details.attempts.length : 0;
}
function sourcesCount(details: any): number {
  return Array.isArray(details?.sources) ? details.sources.length : 0;
}

function webSearchLabel(result: any, theme: ThemeLike): string {
  const d = result?.details ?? {};
  const status = frameStatus(result, undefined, undefined);
  if (d.failureClass) return labelWithStatus(status, `${d.provider ?? "serper"} failed • ${d.failureClass}`, theme);
  const count = typeof d.resultCount === "number" ? d.resultCount : Array.isArray(d.results) ? d.results.length : sourcesCount(d);
  const provider = d.provider ?? "serper";
  const attempts = attemptsCount(d);
  const base = count === 0 ? `0 results • ${provider}` : `${countLabel(count, "result", "results")} • ${provider}`;
  const attemptSuffix = attempts > 1 ? ` • ${attempts} attempts` : "";
  const warningSuffix = d.warnings?.length ? ` • ${d.warnings.length} warning${d.warnings.length === 1 ? "" : "s"}` : "";
  // Include serper envelope cost if present? serper reports credits
  const credits = d.serper?.credits !== undefined ? ` • ${d.serper.credits} credits` : "";
  return labelWithStatus(status, `${base}${attemptSuffix}${credits}${warningSuffix}`, theme);
}

function specialistSearchLabel(provider: string, result: any, theme: ThemeLike): string {
  const d = result?.details ?? {};
  const status = frameStatus(result, undefined, undefined);
  if (d.failureClass) return labelWithStatus(status, `${provider} failed • ${d.failureClass}`, theme);
  const count = Array.isArray(d.results) ? d.results.length : sourcesCount(d);
  const attempts = attemptsCount(d);
  // Include synthesis for xsearch
  const hasSynthesis = d.results?.some?.((r: any) => r?.xsearch);
  const synth = hasSynthesis ? " • synthesis" : "";
  const attemptSuffix = attempts > 1 ? ` • ${attempts} attempts` : "";
  const cost = d.reportedCostUsd !== undefined ? ` • $${d.reportedCostUsd.toFixed(4)}` : "";
  // Exa adjudication
  const adj = (d as any)?.exaAdjudication ?? (d.results as any)?.exa?.adjudication;
  const adjSuffix = adj ? ` • ${adj.qualifyingCount}/${adj.providerCount} qualifying` : "";
  const base = count === 0 ? `0 results • ${provider}${synth}` : `${countLabel(count, "result", "results")} • ${provider}${synth}`;
  return labelWithStatus(status, `${base}${attemptSuffix}${cost}${adjSuffix}`, theme);
}

function webFetchLabel(result: any, theme: ThemeLike): string {
  const d = result?.details ?? {};
  const status = frameStatus(result, undefined, undefined);
  if (d.failureClass) {
    const provider = d.provider ?? "fetch";
    return labelWithStatus(status, `${provider} failed • ${d.failureClass}`, theme);
  }
  // Crawl
  if (d.crawlStatus !== undefined) {
    const crawlStatus = d.crawlStatus as string;
    if (crawlStatus === "running") return labelWithStatus("pending" as FrameStatus, `crawl:${d.crawlId ?? "?"} running • webclaw`, theme);
    return labelWithStatus(status, `crawl:${d.crawlId ?? "?"} ${crawlStatus} • webclaw`, theme);
  }
  // Map
  if (d.operation === "map" || (Array.isArray(d.cache) && d.cache[0]?.status === "fresh" && d.sources?.[0]?.url?.includes("Site map"))) {
    const count = Array.isArray(d.sources) ? d.sources.length : 0;
    const discovered = count || (typeof d.sources?.length === "number" ? d.sources.length : 0);
    // Try to get bounded count from text fallback
    const provider = d.provider ?? "webclaw";
    const urls = discovered ? `${countLabel(discovered, "URL", "URLs")} • ${provider} map` : `${provider} map`;
    return labelWithStatus(status, urls, theme);
  }
  // Page/download multi or single
  const cache = Array.isArray(d.cache) ? d.cache : [];
  const sources = Array.isArray(d.sources) ? d.sources : [];
  const total = cache.length || sources.length;
  const fetched = sources.filter((s: any) => s.fetched).length || cache.filter((c: any) => c.status !== "error").length;
  const failed = cache.filter((c: any) => c.status === "error").length;
  const provider = d.provider ?? (total > 0 ? "cache" : "webclaw");
  const cachedAll = d.cached ? " • cached" : "";
  const tokens = cache[0]?.estimatedTokens !== undefined ? ` • ~${cache[0].estimatedTokens} tokens` : "";
  if (total <= 1) {
    const singleStatus = cache[0]?.status ?? (sources[0]?.fetched ? "fetched" : "lead");
    return labelWithStatus(status, `${fetched ? "fetched" : singleStatus} • ${provider}${tokens}${cachedAll}`, theme);
  }
  const failedSuffix = failed ? ` • ${failed} failed` : "";
  return labelWithStatus(status, `${fetched}/${total} fetched • ${provider}${failedSuffix}${cachedAll}`, theme);
}

function webLookupLabel(result: any, theme: ThemeLike): string {
  const d = result?.details ?? {};
  const status = frameStatus(result, undefined, undefined);
  if (d.failureClass) return labelWithStatus(status, `${d.provider ?? "lookup"} failed • ${d.failureClass}`, theme);
  const count = Array.isArray(d.records) ? d.records.length : sourcesCount(d);
  const provider = d.provider ?? "lookup";
  const evidence = count > 0 && d.records?.[0]?.content ? "fetched" : count > 0 ? "catalog" : "0 records";
  const docsPath = d.docsPath ? ` • ${shorten(d.docsPath, 40)}` : "";
  if (count === 0) return labelWithStatus(status, `0 records • ${provider}`, theme);
  return labelWithStatus(status, `${countLabel(count, "record", "records")} • ${provider} • ${evidence}${docsPath}`, theme);
}

function webAnswerLabel(result: any, theme: ThemeLike): string {
  const d = result?.details ?? {};
  const status = frameStatus(result, undefined, undefined);
  if (d.failureClass) return labelWithStatus(status, `${d.provider ?? "answer"} failed • ${d.failureClass}`, theme);
  const provider = d.provider ?? "exa";
  const sources = sourcesCount(d);
  const cost = d.reportedCostUsd !== undefined ? ` • $${d.reportedCostUsd.toFixed(4)}` : "";
  const model = d.model ? ` • ${shorten(String(d.model), 20)}` : "";
  const structured = d.structuredData !== undefined ? " • structured" : "";
  const srcLabel = sources === 0 ? "0 sources" : countLabel(sources, "source", "sources");
  return labelWithStatus(status, `answer • ${provider} • ${srcLabel}${cost}${model}${structured}`, theme);
}
function webFetchBodyLines(result: any, theme: ThemeLike): string[] {
  const d = result?.details ?? {};
  const cache = Array.isArray(d.cache) ? d.cache : [];
  const sources = Array.isArray(d.sources) ? d.sources : [];
  // Use structured preview only when we have web_fetch-like details; otherwise fall back to generic text.
  if (cache.length === 0 && sources.length === 0) return buildBodyLines(result, theme);
  const lines: string[] = [];
  const entries = cache.length ? cache : sources;
  for (const entry of entries.slice(0, 5)) {
    const url = String(entry?.url ?? entry?.canonical ?? "");
    const status = String(entry?.status ?? entry?.fetched ? "fetched" : "lead");
    const path = String(entry?.path ?? "");
    const tokens = entry?.estimatedTokens !== undefined ? ` • ~${entry.estimatedTokens} tokens` : "";
    const color: ThemeColor = status === "error" ? "error" : status === "fetched" || status === "fresh" || status === "cache_hit" ? "success" : "muted";
    const icon = status === "error" ? "✗" : status === "fetched" || status === "fresh" ? "✓" : "•";
    const line = `${fg(theme, color, icon)} ${fg(theme, "toolOutput", shorten(url, 60))} ${fg(theme, "muted", `• ${status}`)}${path ? ` ${fg(theme, "accent", path)}` : ""}${tokens}`;
    lines.push(line);
  }
  if (entries.length > 5) lines.push(fg(theme, "muted", `… ${entries.length - 5} more sources hidden · Ctrl+U to show`));
  // Append any llm_answer sidecar paths if present (they are in cache with llm_ prefix)
  const sidecars = cache.filter((c: any) => String(c?.path ?? "").includes("llm_"));
  for (const sc of sidecars.slice(0, 2)) {
    lines.push(fg(theme, "accent", `↳ llm_answer sidecar: ${String(sc.path).slice(0, 60)}`));
  }
  // Fall back to generic text preview if structured was empty but text exists (e.g., error message)
  if (lines.length === 0) return buildBodyLines(result, theme);
  return lines;
}

function buildBodyLines(result: any, theme: ThemeLike): string[] {
  const text = textOf(result);
  if (!text) return ["(no output)"];
  // Keep raw text lines but apply muted tint to warnings in body for scannability
  return text.split("\n").map((line) => {
    if (/^\s*(warning|warn)\b/i.test(line)) return fg(theme, "warning", line);
    if (/\b(error|fail|fatal|panic|exception)\b/i.test(line)) return fg(theme, "error", line);
    return line;
  });
}

// ---- Exported per-tool renderers ----
export function renderWebSearchCall(args: any, theme: ThemeLike, context: any = {}): any {
  const query = shorten(String(args?.query ?? args?.q ?? args?.term ?? ""), 80);
  const country = args?.country ? ` • ${String(args.country).toLowerCase()}` : "";
  const detail = query ? `${fg(theme, "accent", query + country)}` : "";
  const title = `${toolIcon(theme, "web_search")}${fg(theme, "toolTitle", bold(theme, "web_search"))}${detail ? ` ${detail}` : ""}`;
  const w = widthOf(undefined, context);
  const card = ensureWebCard(context, "web_search", theme, w, title);
  if (card) return card as any;
  rememberDensity(theme, undefined, context);
  return new TextBlock(frameTop(title, "pending", theme, w, "web_search"));
}
export function renderWebSearchResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindWebResultCard(context);
  rememberDensity(theme, options, context);
  const status = frameStatus(result, options, context);
  const width = widthOf(options, context);
  const body = buildBodyLines(result, theme);
  const label = webSearchLabel(result, theme);
  return framed(body, label, status, theme, width, "web_search");
}

export function renderWebSearchExaCall(args: any, theme: ThemeLike, context: any = {}): any {
  const query = shorten(String(args?.query ?? ""), 80);
  const type = args?.searchType ? ` • ${String(args.searchType)}` : "";
  const detail = query ? `${fg(theme, "accent", query + type)}` : "";
  const title = `${toolIcon(theme, "web_search_exa")}${fg(theme, "toolTitle", bold(theme, "web_search_exa"))}${detail ? ` ${detail}` : ""}`;
  const w = widthOf(undefined, context);
  const card = ensureWebCard(context, "web_search_exa", theme, w, title);
  if (card) return card as any;
  rememberDensity(theme, undefined, context);
  return new TextBlock(frameTop(title, "pending", theme, w, "web_search_exa"));
}
export function renderWebSearchExaResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindWebResultCard(context);
  rememberDensity(theme, options, context);
  const status = frameStatus(result, options, context);
  const width = widthOf(options, context);
  return framed(buildBodyLines(result, theme), specialistSearchLabel("exa", result, theme), status, theme, width, "web_search_exa");
}

export function renderWebSearchXCall(args: any, theme: ThemeLike, context: any = {}): any {
  const query = shorten(String(args?.query ?? ""), 80);
  const detail = query ? ` ${fg(theme, "accent", query)}` : "";
  const title = `${toolIcon(theme, "web_search_x")}${fg(theme, "toolTitle", bold(theme, "web_search_x"))}${detail}`;
  const w = widthOf(undefined, context);
  const card = ensureWebCard(context, "web_search_x", theme, w, title);
  if (card) return card as any;
  rememberDensity(theme, undefined, context);
  return new TextBlock(frameTop(title, "pending", theme, w, "web_search_x"));
}
export function renderWebSearchXResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindWebResultCard(context);
  rememberDensity(theme, options, context);
  const status = frameStatus(result, options, context);
  const width = widthOf(options, context);
  return framed(buildBodyLines(result, theme), specialistSearchLabel("xsearch", result, theme), status, theme, width, "web_search_x");
}

export function renderWebSearchTavilyCall(args: any, theme: ThemeLike, context: any = {}): any {
  const query = shorten(String(args?.query ?? ""), 80);
  const country = args?.country ? ` • ${String(args.country)}` : "";
  const detail = query ? ` ${fg(theme, "accent", query + country)}` : "";
  const title = `${toolIcon(theme, "web_search_tavily")}${fg(theme, "toolTitle", bold(theme, "web_search_tavily"))}${detail}`;
  const w = widthOf(undefined, context);
  const card = ensureWebCard(context, "web_search_tavily", theme, w, title);
  if (card) return card as any;
  rememberDensity(theme, undefined, context);
  return new TextBlock(frameTop(title, "pending", theme, w, "web_search_tavily"));
}
export function renderWebSearchTavilyResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindWebResultCard(context);
  rememberDensity(theme, options, context);
  const status = frameStatus(result, options, context);
  const width = widthOf(options, context);
  return framed(buildBodyLines(result, theme), specialistSearchLabel("tavily", result, theme), status, theme, width, "web_search_tavily");
}

export function renderWebFetchCall(args: any, theme: ThemeLike, context: any = {}): any {
  const rawUrls = args?.urls ?? args?.url ?? args?.link ?? args?.sources ?? "";
  const first = Array.isArray(rawUrls) ? String(rawUrls[0] ?? "") : String(rawUrls).split(/[,;]/)[0] ?? "";
  const urlsCount = Array.isArray(rawUrls) ? rawUrls.length : String(rawUrls).split(/[,;]/).filter(Boolean).length;
  const mode = args?.mode ? ` • ${Array.isArray(args.mode) ? args.mode.join("+") : String(args.mode)}` : "";
  const detail = first ? `${fg(theme, "accent", shorten(first, 60) + (urlsCount > 1 ? ` +${urlsCount - 1}` : "") + mode)}` : "";
  const title = `${toolIcon(theme, "web_fetch")}${fg(theme, "toolTitle", bold(theme, "web_fetch"))}${detail ? ` ${detail}` : ""}`;
  const w = widthOf(undefined, context);
  const card = ensureWebCard(context, "web_fetch", theme, w, title);
  if (card) return card as any;
  rememberDensity(theme, undefined, context);
  return new TextBlock(frameTop(title, "pending", theme, w, "web_fetch"));
}
export function renderWebFetchResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindWebResultCard(context);
  rememberDensity(theme, options, context);
  const status = frameStatus(result, options, context);
  const width = widthOf(options, context);
  // TUI-only structured preview: reuses webFetchBodyLines (URL • status • cache path • tokens + sidecar) without touching model text.
  const lines = webFetchBodyLines(result, theme);
  return framed(lines, webFetchLabel(result, theme), status, theme, width, "web_fetch");
}

export function renderWebLookupCall(args: any, theme: ThemeLike, context: any = {}): any {
  const source = args?.source ? String(args.source) : "";
  const query = shorten(String(args?.query ?? args?.q ?? args?.term ?? ""), 60);
  const lib = args?.library ?? args?.context7?.libraryId ?? "";
  const detailParts = [source, query, lib && shorten(String(lib), 30)].filter(Boolean);
  const detail = detailParts.length ? ` ${fg(theme, "accent", detailParts.join(" • "))}` : "";
  const title = `${toolIcon(theme, "web_lookup")}${fg(theme, "toolTitle", bold(theme, "web_lookup"))}${detail}`;
  const w = widthOf(undefined, context);
  const card = ensureWebCard(context, "web_lookup", theme, w, title);
  if (card) return card as any;
  rememberDensity(theme, undefined, context);
  return new TextBlock(frameTop(title, "pending", theme, w, "web_lookup"));
}
export function renderWebLookupResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindWebResultCard(context);
  rememberDensity(theme, options, context);
  const status = frameStatus(result, options, context);
  const width = widthOf(options, context);
  return framed(buildBodyLines(result, theme), webLookupLabel(result, theme), status, theme, width, "web_lookup");
}

export function renderContext7Call(args: any, theme: ThemeLike, context: any = {}): any {
  const library = shorten(String(args?.libraryId ?? args?.library ?? ""), 36);
  const query = shorten(String(args?.query ?? args?.topic ?? ""), 54);
  const version = args?.version ? `@${String(args.version)}` : "";
  const mode = args?.mode && args.mode !== "docs" ? ` • ${String(args.mode)}` : "";
  const detailText = [library && `${library}${version}`, query].filter(Boolean).join(" • ") + mode;
  const title = `${toolIcon(theme, "context7")}${fg(theme, "toolTitle", bold(theme, "context7"))}${detailText ? ` ${fg(theme, "accent", detailText)}` : ""}`;
  const width = widthOf(undefined, context);
  const card = ensureWebCard(context, "context7", theme, width, title);
  if (card) return card as any;
  return new TextBlock(frameTop(title, "pending", theme, width, "context7"));
}
export function renderContext7Result(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindWebResultCard(context);
  const status = frameStatus(result, options, context);
  const width = widthOf(options, context);
  return framed(buildBodyLines(result, theme), webLookupLabel(result, theme), status, theme, width, "context7");
}
export function renderWebAnswerCall(args: any, theme: ThemeLike, context: any = {}): any {
  const question = shorten(String(args?.question ?? args?.q ?? args?.query ?? ""), 80);
  const detail = question ? ` ${fg(theme, "accent", question)}` : "";
  const title = `${toolIcon(theme, "web_answer")}${fg(theme, "toolTitle", bold(theme, "web_answer"))}${detail}`;
  const w = widthOf(undefined, context);
  const card = ensureWebCard(context, "web_answer", theme, w, title);
  if (card) return card as any;
  rememberDensity(theme, undefined, context);
  return new TextBlock(frameTop(title, "pending", theme, w, "web_answer"));
}
export function renderWebAnswerResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindWebResultCard(context);
  rememberDensity(theme, options, context);
  const status = frameStatus(result, options, context);
  const width = widthOf(options, context);
  return framed(buildBodyLines(result, theme), webAnswerLabel(result, theme), status, theme, width, "web_answer");
}

export function renderWebAnswerExaCall(args: any, theme: ThemeLike, context: any = {}): any {
  const question = shorten(String(args?.question ?? ""), 80);
  const detail = question ? ` ${fg(theme, "accent", question)}` : "";
  const title = `${toolIcon(theme, "web_answer_exa")}${fg(theme, "toolTitle", bold(theme, "web_answer_exa"))}${detail}`;
  const w = widthOf(undefined, context);
  const card = ensureWebCard(context, "web_answer_exa", theme, w, title);
  if (card) return card as any;
  rememberDensity(theme, undefined, context);
  return new TextBlock(frameTop(title, "pending", theme, w, "web_answer_exa"));
}
export function renderWebAnswerExaResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindWebResultCard(context);
  rememberDensity(theme, options, context);
  const status = frameStatus(result, options, context);
  const width = widthOf(options, context);
  return framed(buildBodyLines(result, theme), webAnswerLabel(result, theme), status, theme, width, "web_answer_exa");
}

export function renderWebAnswerLinkupCall(args: any, theme: ThemeLike, context: any = {}): any {
  const question = shorten(String(args?.question ?? ""), 80);
  const depth = args?.depth ? ` • ${String(args.depth)}` : "";
  const detail = question ? ` ${fg(theme, "accent", question + depth)}` : "";
  const title = `${toolIcon(theme, "web_answer_linkup")}${fg(theme, "toolTitle", bold(theme, "web_answer_linkup"))}${detail}`;
  const w = widthOf(undefined, context);
  const card = ensureWebCard(context, "web_answer_linkup", theme, w, title);
  if (card) return card as any;
  rememberDensity(theme, undefined, context);
  return new TextBlock(frameTop(title, "pending", theme, w, "web_answer_linkup"));
}
export function renderWebAnswerLinkupResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindWebResultCard(context);
  rememberDensity(theme, options, context);
  const status = frameStatus(result, options, context);
  const width = widthOf(options, context);
  return framed(buildBodyLines(result, theme), webAnswerLabel(result, theme), status, theme, width, "web_answer_linkup");
}
