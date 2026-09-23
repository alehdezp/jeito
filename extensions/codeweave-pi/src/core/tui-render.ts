import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { createRequire } from "node:module";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth as tuiVisibleWidth, truncateToWidth as tuiTruncateToWidth } from "@earendil-works/pi-tui";
import { parsePatch } from "./patch-parser.ts";

const EXPAND_HINT = " • Ctrl+U to cycle view";
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const ANSI_AT_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/y;
const TAB_STOP = 8;
export type ThemeLike = Pick<Theme, "fg" | "bold">;
type FrameStatus = "pending" | "success" | "partial" | "warning" | "error";
const MAX_RENDERED_UI_LINES = 30;
const EDIT_RENDERED_UI_LINES = 50;
const DEFAULT_DIFF_COLLAPSED_ROWS = 18;
const EDIT_DIFF_COLLAPSED_ROWS = EDIT_RENDERED_UI_LINES - 5;
const WRITE_RENDERED_UI_LINES = 50;
const WRITE_SOURCE_COLLAPSED_ROWS = 40;
const WRITE_DIFF_COLLAPSED_ROWS = WRITE_RENDERED_UI_LINES - 5;
const ANSI_RESET = "\x1b[0m";
const ANSI_BG_RESET = "\x1b[49m";
const DIFF_ADD_BG = "\x1b[48;2;22;45;34m";
const DIFF_REMOVE_BG = "\x1b[48;2;55;28;34m";
const DIFF_ADD_EMPHASIS_BG = "\x1b[48;2;35;85;55m";
const DIFF_REMOVE_EMPHASIS_BG = "\x1b[48;2;95;40;50m";
const DIFF_ADD_FG = "\x1b[38;2;120;220;150m";
const DIFF_REMOVE_FG = "\x1b[38;2;245;125;145m";
const TOOL_BORDER_COLORS: Record<string, string> = {
  read: "\x1b[38;2;92;124;250m",
  write: "\x1b[38;2;126;179;66m",
  edit: "\x1b[38;2;198;120;221m",
  diff: "\x1b[38;2;229;163;77m",
  find: "\x1b[38;2;77;182;172m",
  grep: "\x1b[38;2;255;184;108m",
  explore: "\x1b[38;2;142;124;195m",
  trace: "\x1b[38;2;0;172;193m",
  docs_search: "\x1b[38;2;79;195;247m",
  default: "\x1b[38;2;139;148;158m",
};
const requireOptional = createRequire(import.meta.url);
const MAX_HL_CHARS = 80_000;
const HIGHLIGHT_CACHE_LIMIT = 128;
const FG_HL_MUTED = "\x1b[38;2;139;148;158m";
const FG_HL_COMMENT = "\x1b[38;2;106;153;85m";
const FG_HL_STRING = "\x1b[38;2;152;195;121m";
const FG_HL_KEYWORD = "\x1b[38;2;198;120;221m";
const FG_HL_NUMBER = "\x1b[38;2;209;154;102m";

type CliHighlight = {
  highlight: (code: string, options: { language: string; ignoreIllegals?: boolean }) => string;
  supportsLanguage?: (language: string) => boolean;
};

if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

let cachedCliHighlight: CliHighlight | null | undefined;
const highlightCache = new Map<string, string[]>();

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  cs: "csharp", swift: "swift", kt: "kotlin", html: "html", css: "css", scss: "scss", less: "css",
  json: "json", jsonc: "jsonc", yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown", mdx: "mdx",
  sql: "sql", sh: "bash", bash: "bash", zsh: "bash", fish: "bash", lua: "lua", php: "php", dart: "dart",
  xml: "xml", graphql: "graphql", svelte: "svelte", vue: "vue", dockerfile: "dockerfile", makefile: "make",
  zig: "zig", nim: "nim", elixir: "elixir", ex: "elixir", erb: "erb", hbs: "handlebars",
};

const HLJS_LANG_ALIAS: Record<string, string> = { tsx: "typescript", jsx: "javascript", jsonc: "json", mdx: "markdown", make: "makefile", svelte: "html", vue: "html" };

const NERD_FILE_ICONS: Record<string, string> = {
  ts: "\ue8ca", tsx: "\ue7ba", js: "\ue74e", jsx: "\ue7ba", mjs: "\ue74e", cjs: "\ue74e",
  rs: "\ue7a8", py: "\ue73c", go: "\ue724", java: "\ue738", rb: "\ue739", swift: "\ue755",
  json: "\ue60b", jsonc: "\ue60b", yaml: "\ue6a8", yml: "\ue6a8", toml: "\ue6b2",
  md: "\ue73e", mdx: "\ue73e", html: "\ue736", css: "\ue749", scss: "\ue749",
  sh: "\ue795", bash: "\ue795", zsh: "\ue795", fish: "\ue795", lua: "\ue620",
  png: "\uf1c5", jpg: "\uf1c5", jpeg: "\uf1c5", gif: "\uf1c5", svg: "\uf1c5", webp: "\uf1c5",
};
const NERD_DIRECTORY_ICON = "\uf07b";
const NERD_DEFAULT_FILE_ICON = "\uf15b";
const NERD_TOOL_ICONS: Record<string, string> = {
  read: "\uf02d", write: "\uf044", edit: "\uf044", diff: "\uf1da",
  find: "\uf1e5", grep: "\uf002", ls: "\uf07c", explore: "\uf0e8",
  trace: "\uf126", docs_search: "\uf02d", lsp_validate: "\uf00c",
};
type DisplayDensity = "ultra" | "condensed" | "normal" | "extended";
const DENSITY_LEVELS: DisplayDensity[] = ["ultra", "condensed", "normal", "extended"];
const JEITO_DENSITY_KEY = Symbol.for("pi.agent.jeitoDensity.v1");
const CONDENSED_RENDERED_UI_LINES = 8;
const EXTENDED_RENDERED_UI_LINES = 120;
/** Own jeito density — cycled only by Ctrl+U, intentionally ignores Pi's ctx.expanded (Ctrl+O). */
const JEITO_DENSITY_STATE: { level: number } = (() => {
  const g = globalThis as any;
  // Default to condensed (1) for all tool calls per user request — ultra remains 1-line, condensed is the new normal.
  return (g[JEITO_DENSITY_KEY] ??= { level: 1 });
})();
export function currentDensity(): DisplayDensity {
  return DENSITY_LEVELS[JEITO_DENSITY_STATE.level] ?? "condensed";
}
export function cycleDensity(): DisplayDensity {
  JEITO_DENSITY_STATE.level = (JEITO_DENSITY_STATE.level + 1) % DENSITY_LEVELS.length;
  return currentDensity();
}
export function resetDisplayDensityForTests(): void {
  JEITO_DENSITY_STATE.level = 0;
}
const DENSITY_BY_THEME = new WeakMap<object, DisplayDensity>();

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

function fileIcon(theme: ThemeLike, path: string, kind: string): string {
  if (!NERD_FONT_AVAILABLE) return "";
  const glyph = kind === "directory"
    ? NERD_DIRECTORY_ICON
    : NERD_FILE_ICONS[extname(path).slice(1).toLowerCase()] ?? NERD_DEFAULT_FILE_ICON;
  return `${fg(theme, kind === "directory" ? "accent" : "muted", glyph)} `;
}

function toolIcon(theme: ThemeLike, tool: string): string {
  const glyph = NERD_FONT_AVAILABLE ? NERD_TOOL_ICONS[tool] : undefined;
  return glyph ? `${fg(theme, "accent", glyph)}  ` : "";
}
function readFileIcon(theme: ThemeLike, path: string | undefined): string {
  if (!NERD_FONT_AVAILABLE) return "";
  const clean = String(path ?? "").split(":")[0];
  const glyph = NERD_FILE_ICONS[extname(clean).slice(1).toLowerCase()] ?? NERD_DEFAULT_FILE_ICON;
  return `${fg(theme, "accent", glyph)}  `;
}

function displayDensity(): DisplayDensity { return currentDensity(); }
function rememberDensity(theme: ThemeLike): DisplayDensity {
  const d = currentDensity();
  if (theme && typeof theme === "object") DENSITY_BY_THEME.set(theme as object, d);
  return d;
}
function isUltra(): boolean { return currentDensity() === "ultra"; }
function densityRank(): 0 | 1 | 2 | 3 { return currentDensity() === "ultra" ? 0 : currentDensity() === "condensed" ? 1 : currentDensity() === "normal" ? 2 : 3; }
function isExpanded(..._args: any[]): boolean { return currentDensity() === "extended"; }
function hideDetails(): boolean { return isUltra(); }
function showSome(): boolean { return densityRank() >= 1; }
function showAll(): boolean { return densityRank() >= 3; }

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

function frameStatus(result: any, options: any, context: any, text = textOf(result)): FrameStatus {
  if (context?.isError || result?.isError || /^ERROR:/m.test(text)) return "error";
  if (context?.isPartial ?? options?.isPartial) return "pending";
  if (result?.details?.status === "error") return "error";
  const native = result?.details?.native;
  const returnedEvidence = Number(native?.completeness?.returned ?? 0) > 0
    || Number(native?.data?.coverage?.occurrences ?? 0) > 0
    || Array.isArray(result?.details?.diff?.exactFiles) && result.details.diff.exactFiles.length > 0
    || ["entries", "groups", "matches", "results", "relationships", "nodes", "edges"]
      .some(key => Array.isArray(native?.data?.[key]) && native.data[key].length > 0);
  if (result?.details?.status === "partial") return returnedEvidence ? "partial" : "warning";
  const envelopeStatus = result?.details?.envelope?.status;
  if (envelopeStatus === "error") return "error";
  if (envelopeStatus === "warning") {
    return native?.completeness?.complete === false && returnedEvidence ? "partial" : "warning";
  }
  if (/^(?:WARNING|UNAVAILABLE|Read refused):/m.test(text)) return "warning";
  return "success";
}

function frameWidth(options: any, context: any): number {
  return normalizeWidth(widthOf(options, context), 100);
}

function frameTop(title: string, status: FrameStatus, theme: ThemeLike, width: number, tool = "default"): string {
  const safeTitle = clampLineToWidth(title, Math.max(1, width - 6));
  const trailing = Math.max(1, width - visibleWidth(safeTitle) - 5);
  void status;
  void theme;
  return `${toolBorder(tool, "╭──")} ${safeTitle} ${toolBorder(tool, "─".repeat(trailing))}`;
}

function frameBottom(label: string, status: FrameStatus, theme: ThemeLike, width: number, tool = "default"): string {
  const safeLabel = clampLineToWidth(label, Math.max(1, width - 6));
  const trailing = Math.max(1, width - visibleWidth(safeLabel) - 5);
  void status;
  void theme;
  return `${toolBorder(tool, "╰──")} ${safeLabel} ${toolBorder(tool, "─".repeat(trailing))}`;
}

function frameBodyLines(lines: string[], status: FrameStatus, theme: ThemeLike, width: number, tool = "default"): string[] {
  const rail = toolBorder(tool, "│");
  void status;
  return lines.map(line => {
    const bodyLine = /Ctrl\+U to show/u.test(stripAnsi(line)) && !line.includes("\x1b[") ? fg(theme, "muted", line) : line;
    return `${rail} ${clampLineToWidth(bodyLine, Math.max(1, width - 2))}`;
  });
}

class jeitoDensityBlock {
  private lines: string[];
  private label: string;
  private status: FrameStatus;
  private theme: ThemeLike;
  private width: number;
  private tool: string;
  private maxLines: number;
  constructor(lines: string[], label: string, status: FrameStatus, theme: ThemeLike, width: number, tool: string, maxLines: number) {
    this.lines = lines; this.label = label; this.status = status; this.theme = theme; this.width = width; this.tool = tool; this.maxLines = maxLines;
  }
  setText(text: string): void { this.lines = text.split("\n"); }
  invalidate(): void {}
  get bodyLines(): string[] { return this.lines; }
  get labelText(): string { return this.label; }
  get blockStatus(): FrameStatus { return this.status; }
  get budget(): number { return this.maxLines; }
  render(width: number): string[] {
    const w = normalizeWidth(width ?? this.width, 100);
    const density = currentDensity();
    const effectiveMax = density === "extended" ? EXTENDED_RENDERED_UI_LINES : density === "condensed" ? CONDENSED_RENDERED_UI_LINES : MAX_RENDERED_UI_LINES;
    const diagnostic = density === "ultra" && (this.status === "warning" || this.status === "error")
      ? this.lines.find(line => /(?:reason|failed|error|unavailable|weak anchor|requested callable|ambiguous|degraded|target:|exceptional:)/i.test(stripAnsi(line)))
      : undefined;
    const effectiveLabel = diagnostic ? `${this.label} · ${fg(this.theme, "muted", stripAnsi(diagnostic!).trim())}` : this.label;
    const sourceLines = density === "ultra" ? [] : this.lines;
    const maxBodyLines = effectiveMax - 1;
    const keep = Math.max(0, maxBodyLines - 1);
    const visibleLines = sourceLines.length > maxBodyLines
      ? [...sourceLines.slice(0, keep), fg(this.theme, "muted", `… ${sourceLines.length - keep} more UI lines hidden · Ctrl+U to show`)]
      : sourceLines;
    const body = visibleLines.length ? [...frameBodyLines(visibleLines, this.status, this.theme, w, this.tool), frameBottom(effectiveLabel, this.status, this.theme, w, this.tool)] : [frameBottom(effectiveLabel, this.status, this.theme, w, this.tool)];
    return capRenderedLines(clampLinesToWidth(body.join("\n").split("\n"), w), w, effectiveMax, toolBorder(this.tool, "│"), this.theme);
  }
}
function framed(lines: string[], label: string, status: FrameStatus, theme: ThemeLike, width: number, tool = "default", maxRenderedLines = MAX_RENDERED_UI_LINES): jeitoDensityBlock | UnifiedCardBlock | ZeroLineBlock {
  const block = new jeitoDensityBlock(lines, label, status, theme, width, tool, maxRenderedLines);
  if (activeResultCard) {
    activeResultCard.receiveBlock(block);
    const stub = ZERO_LINE_BLOCK;
    activeResultCard = undefined;
    return stub as unknown as jeitoDensityBlock;
  }
  return block;
}

function callTitleText(label: string, detail: string | undefined, theme: ThemeLike, context: any = {}, iconOverride?: string): string {
  rememberDensity(theme);
  const displayDetail = detail ? shortenDisplayText(detail, context) : undefined;
  return `${iconOverride ?? toolIcon(theme, label)}${fg(theme, "toolTitle", bold(theme, label))}${displayDetail ? ` ${fg(theme, "accent", displayDetail)}` : ""}`;
}

function framedCall(label: string, detail: string | undefined, theme: ThemeLike, context: any = {}, iconOverride?: string): TextBlock | UnifiedCardBlock {
  const title = callTitleText(label, detail, theme, context, iconOverride);
  const w = frameWidth(undefined, context);
  const card = ensureCard(context, label, theme, w, title, detail ? shortenDisplayText(detail, context) : "");
  if (card) return card;
  return new TextBlock(frameTop(title, frameStatus(undefined, undefined, context, ""), theme, w, label));
}

function labelWithStatus(status: FrameStatus, text: string, theme: ThemeLike): string {
  return `${fg(theme, statusColor(status), statusIcon(status))} ${text}`;
}

export class TextBlock {
  private text: string;
  private readonly maxRenderedLines: number;
  constructor(text = "", maxRenderedLines = MAX_RENDERED_UI_LINES) { this.text = text; this.maxRenderedLines = maxRenderedLines; }
  setText(text: string): void { this.text = text; }
  invalidate(): void {}
  render(width: number): string[] {
    return capRenderedLines(clampLinesToWidth(this.text.split("\n"), width), width, this.maxRenderedLines);
  }
}
let activeResultCard: UnifiedCardBlock | undefined;
function bindResultCard(context: any): void {
  const maybe = (context as any)?.state?.card;
  activeResultCard = maybe instanceof UnifiedCardBlock ? maybe : undefined;
}
function ensureCard(context: any, tool: string, theme: ThemeLike, width: number, titleText: string, target: string): UnifiedCardBlock | undefined {
  const state = (context as any)?.state;
  if (!state || typeof state !== "object") return undefined;
  if (!(state as any).card || !((state as any).card instanceof UnifiedCardBlock)) {
    (state as any).card = new UnifiedCardBlock(tool, theme, width, titleText, target);
  } else {
    // Refresh title/target on re-invocations (args streaming, density-aware title may have changed width)
    const existing: UnifiedCardBlock = (state as any).card;
    existing.refreshCall(titleText, target, theme, width);
  }
  return (state as any).card as UnifiedCardBlock;
}
export class ZeroLineBlock {
  invalidate(): void {}
  render(_width: number): string[] { return []; }
}
const ZERO_LINE_BLOCK = new ZeroLineBlock();
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
  const metricPart = metricText ? ` ${fg(theme, "muted", "·")} ${fg(theme, "muted", metricText)}` : "";
  return clampLineToWidth(`${head}${targetPart}${metricPart}`, width);
}
function compactUltraMetric(tool: string, label: string): string {
  if (tool !== "read" && tool !== "edit" && tool !== "write") return label;
  const segments = label.split(/\s*[•·]\s*/u).map(segment => segment.trim()).filter(Boolean);
  const hashIndex = segments.findIndex(segment => /^hash\s+/i.test(segment));
  const hash = hashIndex >= 0 ? segments.splice(hashIndex, 1)[0] : "";
  if (tool === "read" && /[/\\]|\.[A-Za-z0-9]+$/u.test(segments[0] ?? "")) segments.shift();
  if (tool === "write" && /^created\s+/i.test(segments[0] ?? "")) segments.shift();
  if (tool === "edit") {
    const counts = /([+-]\d+\s+[+-]\d+)$/u.exec(segments[0] ?? "")?.[1];
    if (counts) segments[0] = counts;
  }
  return [hash, ...segments].filter(Boolean).join(" • ");
}
export class UnifiedCardBlock {
  private tool: string;
  private theme: ThemeLike;
  private width: number;
  private titleText: string;
  private target: string;
  private block: jeitoDensityBlock | undefined;
  constructor(tool: string, theme: ThemeLike, width: number, titleText: string, target: string) {
    this.tool = tool;
    this.theme = theme;
    this.width = width;
    this.titleText = titleText;
    this.target = target;
  }
  refreshCall(titleText: string, target: string, theme: ThemeLike, width: number): void {
    this.titleText = titleText;
    this.target = target;
    this.theme = theme;
    this.width = width;
  }
  wantsLeadingSpacer(): boolean { return currentDensity() !== "ultra"; }
  receiveBlock(block: jeitoDensityBlock): void { this.block = block; }
  setText(_text: string): void {}
  invalidate(): void {}
  private ultraTool(): string {
    return fg(this.theme, "toolTitle", bold(this.theme, this.tool));
  }
  private ultraPending(w: number): string {
    const head = labelWithStatus("pending", this.ultraTool(), this.theme);
    return ultraHierarchyLine(head, this.target, "", this.theme, w);
  }
  private firstDiagnostic(lines: string[] | undefined): string | undefined {
    if (!lines) return undefined;
    const hit = lines.find(line => /(?:reason|failed|error|unavailable|weak anchor|requested callable|ambiguous|degraded|target:|exceptional:)/i.test(stripAnsi(line)));
    if (!hit) return undefined;
    const clean = stripAnsi(hit).trim().slice(0, 88);
    return clean || undefined;
  }
  private ultraLine(block: jeitoDensityBlock, w: number): string {
    const status = block.blockStatus;
    let plainLabel = stripAnsi(block.labelText).replace(/^[✓✗⚠◐…]\s*/u, "").trim();
    if (this.target && plainLabel.startsWith(this.target)) plainLabel = plainLabel.slice(this.target.length).replace(/^[\s·•—-]+/u, "").trim();
    const targetPart = this.target;
    const head = labelWithStatus(status, this.ultraTool(), this.theme);
    const diag = (status === "warning" || status === "error" || status === "partial") ? this.firstDiagnostic(block.bodyLines) : undefined;
    const metric = [compactUltraMetric(this.tool, plainLabel), diag].filter(Boolean).join(" · ");
    return ultraHierarchyLine(head, targetPart, metric, this.theme, w);
  }
  render(width: number): string[] {
    const w = normalizeWidth(width ?? this.width, 100);
    const density = currentDensity();
    const block = this.block;
    if (!block) {
      if (density === "ultra") return [this.ultraPending(w)];
      if (density === "condensed") {
        const pendingLabel = labelWithStatus("pending", `pending ${this.tool}`, this.theme);
        const lines = [frameTop(this.titleText, "pending" as FrameStatus, this.theme, w, this.tool), frameBottom(pendingLabel, "pending" as FrameStatus, this.theme, w, this.tool)];
        return capRenderedLines(clampLinesToWidth(lines.join("\n").split("\n"), w), w, CONDENSED_RENDERED_UI_LINES, toolBorder(this.tool, "│"), this.theme);
      }
      const pendingLabel = labelWithStatus("pending", `pending ${this.tool}`, this.theme);
      const lines = [frameTop(this.titleText, "pending" as FrameStatus, this.theme, w, this.tool), frameBottom(pendingLabel, "pending" as FrameStatus, this.theme, w, this.tool)];
      return capRenderedLines(clampLinesToWidth(lines.join("\n").split("\n"), w), w, MAX_RENDERED_UI_LINES, toolBorder(this.tool, "│"), this.theme);
    }
    if (density === "ultra") return [this.ultraLine(block, w)];
    if (density === "condensed") {
      const top = frameTop(this.titleText, block.blockStatus, this.theme, w, this.tool);
      const body = block.render(w);
      return capRenderedLines(clampLinesToWidth([top, ...body].join("\n").split("\n"), w), w, CONDENSED_RENDERED_UI_LINES, toolBorder(this.tool, "│"), this.theme);
    }
    // Normal and extended use one fleet-wide total budget, including header and footer.
    const top = frameTop(this.titleText, block.blockStatus, this.theme, w, this.tool);
    const body = block.render(w);
    const effectiveMax = density === "extended" ? EXTENDED_RENDERED_UI_LINES : MAX_RENDERED_UI_LINES;
    return capRenderedLines(clampLinesToWidth([top, ...body].join("\n").split("\n"), w), w, effectiveMax, toolBorder(this.tool, "│"), this.theme);
  }
}
export function renderToolLabel(theme: ThemeLike, label: string): string {
  const bold = typeof theme.bold === "function" ? theme.bold.bind(theme) : (text: string) => text;
  const fg = typeof theme.fg === "function" ? theme.fg.bind(theme) : (_style: ThemeColor, text: string) => text;
  return fg("toolTitle", bold(label));
}

export function summaryLine(summary: string, options: { hidden?: boolean } = {}): string {
  return `↳ ${summary}${options.hidden ? EXPAND_HINT : ""}`;
}

export function clampLinesToWidth(lines: string[], width: unknown): string[] {
  const normalized = normalizeWidth(width);
  return lines.map(line => clampLineToWidth(line, normalized));
}
function capRenderedLines(lines: string[], width: unknown, maxRenderedLines = MAX_RENDERED_UI_LINES, rail = "│", theme?: ThemeLike): string[] {
  if (lines.length <= maxRenderedLines) return lines;
  const bottom = lines[lines.length - 1] ?? "";
  const message = `… UI truncated to ${maxRenderedLines} lines · Ctrl+U to show`;
  const mutedMessage = theme
    ? fg(theme, "muted", message)
    : `\x1b[38;2;139;148;158m${message}\x1b[0m`;
  const footer = clampLineToWidth(`${rail} ${mutedMessage}`, width);
  if (stripAnsi(bottom).startsWith("╰")) return [...lines.slice(0, maxRenderedLines - 2), footer, bottom];
  return [...lines.slice(0, maxRenderedLines - 1), footer];
}

export function clampLineToWidth(line: string, width: unknown): string {
  const normalized = normalizeWidth(width);
  const terminalSafe = normalizeTerminalControls(line);
  if (visibleWidth(terminalSafe) <= normalized) return terminalSafe;
  // Preserve complete ANSI SGR sequences while truncating. Stripping all ANSI
  // here made live narrow panes render monochrome whenever a prebuilt 100-col
  // frame was clamped down to the actual terminal width.
  return truncateAnsiToWidth(terminalSafe, normalized);
}

function normalizeWidth(width: unknown, fallback = 80): number {
  return typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width) : fallback;
}

function visibleWidth(text: string): number {
  return tuiVisibleWidth(text);
}

function truncateAnsiToWidth(text: string, width: number): string {
  // ponytail: delegate to pi-tui's authoritative width math — our per-codepoint
  // charWidth undercounted emoji/EAW glyphs (e.g. ⌚ U+231A, VS16 sequences),
  // letting clampLineToWidth pass lines the TUI rejected as over-width.
  return tuiTruncateToWidth(text, width, "…");
}

function normalizeTerminalControls(text: string): string {
  let out = "";
  let column = 0;
  for (let index = 0; index < text.length;) {
    ANSI_AT_RE.lastIndex = index;
    const ansi = ANSI_AT_RE.exec(text);
    if (ansi) {
      out += ansi[0];
      index = ANSI_AT_RE.lastIndex;
      continue;
    }

    const code = text.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(code);
    index += char.length;
    if (char === "\t") {
      const spaces = TAB_STOP - (column % TAB_STOP || 0);
      out += " ".repeat(spaces);
      column += spaces;
      continue;
    }
    if (code < 32 || (code >= 0x7f && code < 0xa0)) {
      out += " ";
      column += 1;
      continue;
    }
    out += char;
    column += charWidth(code);
  }
  return out;
}

function charWidth(code: number): number {
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code === 0x200d || code === 0xfe0e || code === 0xfe0f) return 0;
  if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x1ab0 && code <= 0x1aff) || (code >= 0x1dc0 && code <= 0x1dff) || (code >= 0x20d0 && code <= 0x20ff) || (code >= 0xfe20 && code <= 0xfe2f)) return 0;
  // Match terminal/TUI wcwidth behavior for emoji and symbol glyphs. The
  // previous CJK-only wide check counted symbols such as ✅ (U+2705) as width
  // 1, so our clamp accepted a 90-col line that Pi measured as 91 and crashed.
  if ((code >= 0x2600 && code <= 0x27bf) || (code >= 0x1f000 && code <= 0x1faff)) return 2;
  if ((code >= 0x1100 && code <= 0x115f) || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)) return 2;
  return 1;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function textOf(result: any): string {
  return result?.content?.filter((item: any) => item?.type === "text").map((item: any) => item.text ?? "").join("\n") ?? "";
}

// (removed duplicate isExpanded — density is own ctrl+u, not Pi ctx)

function widthOf(options: any, context: any): number | undefined {
  return context?.width ?? options?.width;
}
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortenDisplayText(value: string, context: any = {}): string {
  let out = String(value ?? "");
  const roots = [context?.cwd, process.cwd?.()].filter((item): item is string => typeof item === "string" && item.startsWith("/"));
  for (const root of [...new Set(roots)].sort((a, b) => b.length - a.length)) {
    const normalized = root.replace(/\/+$/, "");
    if (!normalized || normalized === "/") continue;
    out = out.split(`${normalized}/`).join("");
    out = out.replace(new RegExp(`${escapeRegExp(normalized)}(?=[:\"'\\s),]|$)`, "g"), ".");
  }
  const home = process.env.HOME;
  if (home) out = out.split(`${home}/`).join("~/").replace(new RegExp(`${escapeRegExp(home)}(?=[:\"'\\s),]|$)`, "g"), "~");
  return out;
}


function firstLine(text: string, fallback: string): string {
  return text.split("\n").find(line => line.trim()) ?? fallback;
}

function parseReadBody(text: string): { tagged: boolean; bodyLines: string[]; sourceLineCount: number; tag?: string; path?: string } {
  const lines = text.split("\n");
  const header = /^\[([^#\]\r\n]+)#([0-9A-Fa-f]{4,16})\]$/.exec(lines[0]?.trim() ?? "");
  const bodyLines = header ? lines.slice(1) : lines;
  const sourceLineCount = bodyLines.filter(line => /^\d+:/.test(line)).length;
  return { tagged: Boolean(header), bodyLines, sourceLineCount, path: header?.[1], tag: header?.[2]?.toUpperCase() };
}

function hasExplicitReadSelector(path: unknown): boolean {
  if (typeof path !== "string") return false;
  const parts = path.split(":");
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1]?.toLowerCase();
  if (last === "raw") return true;
  return /^(?:L?\d+)(?:(?:\.\.|[-+])L?\d*)?(?:,(?:L?\d+)(?:(?:\.\.|[-+])L?\d*)?)*$/i.test(last ?? "");
}

function summarizeReadPath(path: unknown, context: any = {}): string {
  return typeof path === "string" && path ? shortenDisplayText(path, context) : "...";
}

export function renderReadCall(args: any, theme: ThemeLike, context: any = {}): any {
  if (Array.isArray(args?.paths) && args.paths.length >= 2) {
    const basenames = args.paths.map((s: unknown) => String(s).split("/").pop()?.split(":")[0] ?? String(s));
    const detail = basenames.slice(0, 3).join(" · ");
    const extra = args.paths.length > 3 ? ` · +${args.paths.length - 3}` : "";
    const icon = readFileIcon(theme, String(args.paths[0]));
    return framedCall("read", `${args.paths.length} files · ${detail}${extra}`, theme, context, icon);
  }
  if (Array.isArray(args?.paths)) {
    const first = args.paths.length ? shortenDisplayText(String(args.paths[0]), context) : "...";
    const icon = args.paths.length ? readFileIcon(theme, String(args.paths[0])) : toolIcon(theme, "read");
    return framedCall("read", `${args.paths.length} files • ${first}`, theme, context, icon);
  }
  return framedCall("read", summarizeReadPath(args?.path, context), theme, context, readFileIcon(theme, args?.path));
}

function readLanguage(filePath: string | undefined): string | undefined {
  const base = String(filePath ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "make";
  if (base === ".env" || base === ".envrc") return "bash";
  const ext = /\.([a-z0-9]+)$/i.exec(base)?.[1]?.toLowerCase();
  return ext ? EXT_LANG[ext] : undefined;
}

function forceChalkColor(): void {
  if (process.env.NO_COLOR !== undefined) return;
  try {
    const chalk = requireOptional("chalk");
    const instance = chalk?.default ?? chalk;
    if (instance && typeof instance.level === "number" && instance.level < 3) instance.level = 3;
  } catch {
    // Optional dependency for cli-highlight; fallback highlighter still colors reads.
  }
}

function cliHighlight(): CliHighlight | null {
  if (cachedCliHighlight !== undefined) return cachedCliHighlight;
  try {
    forceChalkColor();
    const module = requireOptional("cli-highlight") as Partial<CliHighlight> & { default?: Partial<CliHighlight> };
    const highlight = module.highlight ?? module.default?.highlight;
    if (typeof highlight !== "function") return (cachedCliHighlight = null);
    cachedCliHighlight = { highlight, supportsLanguage: module.supportsLanguage ?? module.default?.supportsLanguage };
  } catch {
    cachedCliHighlight = null;
  }
  return cachedCliHighlight;
}

const ANSI_CAPTURE_RE = /\x1b\[([0-9;]*)m/g;

function normalizeHighlightContrast(ansi: string): string {
  return ansi.replace(ANSI_CAPTURE_RE, (seq, params: string) => {
    if (params === "30" || params === "90" || params === "38;5;0" || params === "38;5;8") return FG_HL_MUTED;
    if (!params.startsWith("38;2;")) return seq;
    const parts = params.split(";").map(Number);
    if (parts.length !== 5 || parts.some(value => !Number.isFinite(value))) return seq;
    const [, , r, g, b] = parts;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 72 ? FG_HL_MUTED : seq;
  });
}

function cacheHighlight(key: string, value: string[]): string[] {
  highlightCache.delete(key);
  highlightCache.set(key, value);
  while (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const first = highlightCache.keys().next().value;
    if (first === undefined) break;
    highlightCache.delete(first);
  }
  return value;
}

function fallbackHighlightLine(line: string, language: string | undefined): string {
  if (!language || !line.trim()) return line;
  const commentMatch = language !== "json" && language !== "jsonc" ? /(?:\/\/|#).*$/.exec(line) : null;
  const head = commentMatch?.index !== undefined ? line.slice(0, commentMatch.index) : line;
  const tail = commentMatch ? `${FG_HL_COMMENT}${line.slice(commentMatch.index)}${ANSI_RESET}` : "";
  const keyworded = head.replace(/(["'`])(?:\\.|(?!\1).)*\1|\b(?:const|let|var|function|return|if|else|for|while|class|interface|type|import|from|export|async|await|try|catch|throw|new|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b/g, match => {
    if (/^["'`]/.test(match)) return `${FG_HL_STRING}${match}${ANSI_RESET}`;
    if (/^\d/.test(match)) return `${FG_HL_NUMBER}${match}${ANSI_RESET}`;
    return `${FG_HL_KEYWORD}${match}${ANSI_RESET}`;
  });
  return `${keyworded}${tail}`;
}

function highlightReadCodeBlock(code: string, language: string | undefined): string[] {
  if (!code || !language || code.length > MAX_HL_CHARS) return code.split("\n");
  const lang = HLJS_LANG_ALIAS[language] ?? language;
  const key = `${lang}\0${code}`;
  const hit = highlightCache.get(key);
  if (hit) return cacheHighlight(key, hit);
  const cli = cliHighlight();
  if (cli && (!cli.supportsLanguage || cli.supportsLanguage(lang))) {
    try {
      const ansi = normalizeHighlightContrast(cli.highlight(code, { language: lang, ignoreIllegals: true }));
      return cacheHighlight(key, (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n"));
    } catch {
      // Fall through to the tiny local highlighter below.
    }
  }
  return cacheHighlight(key, code.split("\n").map(line => fallbackHighlightLine(line, language)));
}
function renderReadSourceLines(theme: ThemeLike, lines: string[], filePath: string | undefined): string[] {
  const source = lines.map(line => /^(\d+):(.*)$/.exec(line));
  const highlighted = highlightReadCodeBlock(source.filter(Boolean).map(match => match?.[2] ?? "").join("\n"), readLanguage(filePath));
  let index = 0;
  return lines.map((line, offset) => {
    const match = source[offset];
    if (!match) return line;
    const code = highlighted[index++] ?? match[2] ?? "";
    return `${fg(theme, "dim", match[1]!.padStart(4, " "))} ${fg(theme, "muted", "│")} ${code}${ANSI_RESET}`;
  });
}

function tintSourceLine(theme: ThemeLike, line: string): string {
  const match = /^(\d+):(.*)$/.exec(line);
  if (!match) return line;
  return `${fg(theme, "dim", match[1]!.padStart(4, " "))} ${fg(theme, "muted", "│")} ${match[2] ?? ""}`;
}

interface ReadBatchBlock {
  path?: string;
  tag?: string;
  selector?: string;
  bodyLines: string[];
}

function splitReadBatchText(text: string): ReadBatchBlock[] {
  const blocks: ReadBatchBlock[] = [];
  let current: ReadBatchBlock | null = null;
  for (const raw of String(text ?? "").split("\n")) {
    if (raw.length === 0) continue;
    const tagged = /^\[([^#\]\r\n]+)#([0-9A-Fa-f]{4,16})\]$/.exec(raw);
    if (tagged) {
      current = { path: tagged[1], tag: tagged[2]!.toUpperCase(), bodyLines: [] };
      blocks.push(current);
      continue;
    }
    const bare = /^\[([^\]\r\n]+)\]$/.exec(raw);
    if (bare) {
      current = { selector: bare[1], bodyLines: [] };
      blocks.push(current);
      continue;
    }
    if (!current) {
      current = { bodyLines: [] };
      blocks.push(current);
    }
    current.bodyLines.push(raw);
  }
  return blocks;
}

function formatReadIntervals(intervals: { start: number; end: number }[] | undefined): string {
  if (!Array.isArray(intervals) || !intervals.length) return "";
  return intervals
    .map(interval => (interval.start === interval.end ? `[${interval.start}]` : `[${interval.start}-${interval.end}]`))
    .join(",");
}
function rangeGapMarker(theme: ThemeLike, interval: { start: number; end: number }): string {
  const seg = interval.start === interval.end ? `[${interval.start}]` : `[${interval.start}-${interval.end}]`;
  return fg(theme, "accent", seg);
}

function readBatchFileHeader(theme: ThemeLike, file: any, context: any): string {
  const path = String(file.path ?? file.retrySelector ?? "…");
  const icon = fileIcon(theme, path, "file");
  const segments = [`${icon}${fg(theme, "toolOutput", shortenDisplayText(path, context))}`];
  const ranges = formatReadIntervals(file.intervals);
  if (ranges) segments.push(fg(theme, "accent", ranges));
  segments.push(file.tag ? fg(theme, "muted", `#${file.tag}`) : fg(theme, "muted", "no edit hash"));
  return segments.join("  ");
}

export function renderReadResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindResultCard(context);
  const expanded = isExpanded(options, context, theme);
  const text = textOf(result);
  const status = frameStatus(result, options, context, text);
  const width = frameWidth(options, context);
  if (status === "pending") return framed([], labelWithStatus(status, "pending read", theme), status, theme, width, "read");
  if (status === "error") return framed(previewBody(text || "read failed", expanded, 18), labelWithStatus(status, "read failed", theme), status, theme, width, "read");

  if (Array.isArray(result?.details?.files)) {
    const files = result.details.files;
    const counts = result.details.counts ?? {};
    const groups = Number(counts.groups ?? files.length);
    const successful = files.filter((file: any) => file.status === "shown" || file.status === "shown_no_authority");
    const failures = files.filter((file: any) => file.status === "error");
    const hashes = successful.filter((file: any) => file.status === "shown" && file.tag).length;
    const effectiveStatus: FrameStatus = failures.length ? (successful.length ? "partial" : "warning") : status;

    // Render each file as its own highlighted block (path · ranges · hash) so the
    // batch view shows what was actually read instead of a flat raw-text dump.
    const blocks = splitReadBatchText(text);
    const blockByPath = new Map<string, ReadBatchBlock>();
    for (const block of blocks) if (block.path && !blockByPath.has(block.path)) blockByPath.set(block.path, block);

    // Minimal height: fit all ranges until cap. Headers always visible (8-item bound).
    // No equal perFile split — collect all file bodies then let framed cap at 30/120.
    // Only when total exceeds maxBody do we slice per-file proportionally.
    const maxBody = (expanded ? EXTENDED_RENDERED_UI_LINES : MAX_RENDERED_UI_LINES) - 1;

    // Build per-file bodies then fit minimally: headers + first range of each file guaranteed
    type FileBody = { header: string; withGaps: string[] };
    const fileBodies: FileBody[] = [];
    for (const file of files) {
      if (file.status === "shown" || file.status === "shown_no_authority") {
        const header = readBatchFileHeader(theme, file, context);
        const block = file.path ? blockByPath.get(file.path) : undefined;
        if (file.status === "shown" && block) {
          const rawIntervals: { start: number; end: number }[] | undefined = Array.isArray(file.intervals) ? file.intervals : undefined;
          const rendered = renderReadSourceLines(theme, block.bodyLines, file.path);
          const withGaps: string[] = [];
          if (Array.isArray(rawIntervals) && rawIntervals.length > 1) {
            const renderedNums: (number | undefined)[] = block.bodyLines.map(l => { const m = /^(\d+):/.exec(l); return m ? Number(m[1]) : undefined; });
            let cursor = 0;
            for (let ri = 0; ri < rawIntervals.length; ri++) {
              const iv = rawIntervals[ri];
              if (ri > 0) withGaps.push(rangeGapMarker(theme, iv));
              const chunk: string[] = [];
              while (cursor < rendered.length) {
                const ln = renderedNums[cursor];
                if (ln !== undefined && ln >= iv.start && ln <= iv.end) { chunk.push(rendered[cursor]!); cursor++; }
                else if (ln !== undefined && ln > iv.end) break;
                else if (ln === undefined) { chunk.push(rendered[cursor]!); cursor++; break; }
                else { break; }
              }
              withGaps.push(...chunk);
            }
            if (cursor < rendered.length) withGaps.push(...rendered.slice(cursor));
          } else {
            withGaps.push(...rendered);
          }
          fileBodies.push({ header, withGaps });
        } else {
          const note = file.reason ?? block?.bodyLines[0];
          fileBodies.push({ header, withGaps: note ? [fg(theme, "muted", note)] : [] });
        }
      } else if (file.status === "error") {
        const selector = file.retrySelector ?? file.selectors?.[0] ?? `request ${Number(file.requestIndexes?.[0] ?? 0) + 1}`;
        fileBodies.push({ header: fg(theme, "error", `Failed: ${shortenDisplayText(selector, context)} · ${file.reason ?? "read failed"}`), withGaps: [] });
      } else {
        const selector = file.retrySelector ?? file.selectors?.[0] ?? `request ${Number(file.requestIndexes?.[0] ?? 0) + 1}`;
        fileBodies.push({ header: fg(theme, "muted", `Omitted: ${shortenDisplayText(selector, context)}${file.reason ? ` · ${file.reason}` : ""}`), withGaps: [] });
      }
    }
    // Minimal height: fit all when possible; when overflow, guarantee each file's header + first range
    const totalBody = fileBodies.reduce((s, fb) => s + 1 + fb.withGaps.length, 0);
    const body: string[] = [];
    if (totalBody <= maxBody) {
      for (const fb of fileBodies) { body.push(fb.header, ...fb.withGaps); }
    } else {
      // Overflow: headers + first range balanced — each file gets share of remaining budget
      let remaining = maxBody;
      for (const fb of fileBodies) { body.push(fb.header); remaining--; }
      const share = Math.max(1, Math.floor(remaining / Math.max(1, fileBodies.length)));
      let insertOffset = 0;
      let leftover = remaining;
      const takes: number[] = [];
      for (const fb of fileBodies) {
        const gapIdx = fb.withGaps.findIndex(l => stripAnsi(l).trim().startsWith("["));
        const firstChunk = gapIdx >= 0 ? fb.withGaps.slice(0, gapIdx) : fb.withGaps;
        const take = Math.min(firstChunk.length, share, leftover);
        takes.push(take);
        leftover -= take;
      }
      // distribute leftover round-robin
      let idx = 0;
      while (leftover > 0) {
        const fb = fileBodies[idx % fileBodies.length];
        const gapIdx = fb.withGaps.findIndex(l => stripAnsi(l).trim().startsWith("["));
        const firstChunk = gapIdx >= 0 ? fb.withGaps.slice(0, gapIdx) : fb.withGaps;
        if (takes[idx % takes.length] < firstChunk.length) { takes[idx % takes.length]++; leftover--; }
        idx++;
        if (idx > fileBodies.length * 10) break;
      }
      for (let fi = 0; fi < fileBodies.length; fi++) {
        const fb = fileBodies[fi];
        if (!fb.withGaps.length) { insertOffset += 1; continue; }
        const gapIdx = fb.withGaps.findIndex(l => stripAnsi(l).trim().startsWith("["));
        const firstChunk = gapIdx >= 0 ? fb.withGaps.slice(0, gapIdx) : fb.withGaps;
        const take = takes[fi] ?? 0;
        const headerPos = fi + insertOffset;
        body.splice(headerPos + 1, 0, ...firstChunk.slice(0, take));
        insertOffset += take;
      }
    }
    const labelParts = [`${successful.length}/${groups} shown`];
    if (failures.length) labelParts.push(`${failures.length} failed`);
    if (Number(counts.omitted) > 0) labelParts.push(`${counts.omitted} omitted`);
    labelParts.push(`${hashes} ${hashes === 1 ? "hash" : "hashes"}`);
    return framed(body, labelWithStatus(effectiveStatus, labelParts.join(" • "), theme), effectiveStatus, theme, width, "read");
  }

  const parsed = parseReadBody(text);
  const explicitSelector = hasExplicitReadSelector(context?.args?.path);
  const lines = parsed.bodyLines;
  const visibleCount = parsed.sourceLineCount || Math.max(0, lines.filter(Boolean).length);
  const shouldShowAllRange = parsed.tagged && explicitSelector;
  let shownRaw: string[];
  let shouldInterleaveGaps = false;
  if (expanded || shouldShowAllRange) { shownRaw = lines; }
  else {
    // Normal density: show first chunk, then gap marker, then next chunk — not \u2026 blindly
    // Detect gaps by line numbers so [1-15,30-45] renders \u2502 [30-45]
    const nums = lines.map(l => Number(/^(\d+):/.exec(l)?.[1] ?? NaN));
    let gapAt = -1;
    let gapInterval: { start:number; end:number } | undefined;
    for (let i = 1; i < nums.length; i++) {
      const a = nums[i-1]!, b = nums[i]!;
      if (Number.isFinite(a) && Number.isFinite(b) && b > a + 1) {
        // Find next contiguous block end to build [start-end]
        let end = b;
        for (let j = i+1; j < nums.length && Number.isFinite(nums[j]!) && nums[j]! === end + 1; j++) end = nums[j]!;
        gapInterval = { start: b, end };
        gapAt = i;
        break;
      }
    }
    if (gapInterval && gapAt >= 0) {
      const firstChunk = lines.slice(0, gapAt);
      // Next interval markers derived from actual gap
      const seg = gapInterval.start === gapInterval.end ? `[${gapInterval.start}]` : `[${gapInterval.start}-${gapInterval.end}]`;
      const gapLine = `${fg(theme, "muted", "\u2502")} ${fg(theme, "accent", seg)}`;
      // Render each chunk through highlighter separately so gap is a separate body line
      const firstRendered = renderReadSourceLines(theme, firstChunk, parsed.path ?? (typeof context?.args?.path === "string" ? context.args.path : undefined));
      const rest = lines.slice(gapAt);
      const restRendered = renderReadSourceLines(theme, rest.slice(0, Math.max(0, 10 - firstRendered.length - 1)), parsed.path ?? (typeof context?.args?.path === "string" ? context.args.path : undefined));
      const body2 = [...firstRendered, gapLine, ...restRendered];
      const omitted2 = Math.max(0, lines.length - firstChunk.length - restRendered.length);
      if (omitted2 > 0) body2.push(fg(theme, "muted", `… ${omitted2} more UI lines hidden · Ctrl+U to show`));
      const pathPart2 = parsed.path ? `${shortenDisplayText(parsed.path, context)} · ` : "";
      const tagPart2 = parsed.tag ? ` · hash ${parsed.tag}` : " · no edit hash";
      const label2 = labelWithStatus(status, `${pathPart2}${visibleCount} ${visibleCount === 1 ? "line" : "lines"}${tagPart2}`, theme);
      return framed(body2, label2, status, theme, width, "read");
    }
    shownRaw = lines.slice(0, 10);
  }
  const body = renderReadSourceLines(theme, shownRaw, parsed.path ?? (typeof context?.args?.path === "string" ? context.args.path : undefined));
  const omitted = Math.max(0, lines.length - shownRaw.length);
  const pathPart = parsed.path ? `${shortenDisplayText(parsed.path, context)} • ` : "";
  const tagPart = parsed.tag ? ` • hash ${parsed.tag}` : " • no edit hash";
  if (omitted > 0) body.push(fg(theme, "muted", `… ${omitted} more UI lines hidden · Ctrl+U to show`));
  const label = labelWithStatus(status, `${pathPart}${visibleCount} ${visibleCount === 1 ? "line" : "lines"}${tagPart}`, theme);
  return framed(body, label, status, theme, width, "read");
}

function patchCallSummary(patch: unknown): { path?: string; hunks?: number; files?: number } {
  if (typeof patch !== "string") return {};
  try {
    const parsed = parsePatch(patch);
    return {
      path: parsed.sections[0]?.path,
      files: parsed.sections.length,
      hunks: parsed.sections.reduce((sum, section) => sum + section.hunks.length, 0),
    };
  } catch {
    const header = /^\[([^#\]\r\n]+)#/m.exec(patch);
    return { path: header?.[1] };
  }
}

export function renderEditCall(args: any, theme: ThemeLike, context: any = {}): any {
  const summary = patchCallSummary(args?.input);
  const suffix = summary.hunks ? ` (${summary.hunks} ${summary.hunks === 1 ? "operation" : "operations"}${summary.files && summary.files > 1 ? ` • ${summary.files} files` : ""})` : "";
  return framedCall("edit", `${summary.path ?? "hashline edit"}${suffix}`, theme, context);
}

interface DiffRow { kind: "add" | "remove" | "context" | "meta"; line?: number; text: string }

function extractDiff(text: string): string {
  const standaloneIndex = text.indexOf("\nDiff:\n");
  if (standaloneIndex >= 0) return text.slice(standaloneIndex + 1);
  const inlineIndex = text.search(/\nDiff:/);
  if (inlineIndex >= 0) return text.slice(inlineIndex + 1);
  if (text.startsWith("Diff:")) return text;
  return "";
}

function parseSimpleDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of diff.split("\n")) {
    if (!line || line === "Diff:") continue;
    const match = /^([ +\-])(\d+):(.*)$/.exec(line);
    if (!match) { rows.push({ kind: "meta", text: line }); continue; }
    const marker = match[1];
    rows.push({
      kind: marker === "+" ? "add" : marker === "-" ? "remove" : "context",
      line: Number(match[2]),
      text: match[3] ?? "",
    });
  }
  return rows;
}

function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); rows.push({ kind: "meta", text: line }); continue; }
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff --git") || line.startsWith("index ")) { rows.push({ kind: "meta", text: line }); continue; }
    if (line.startsWith("-") && oldLine > 0) rows.push({ kind: "remove", line: oldLine++, text: line.slice(1) });
    else if (line.startsWith("+") && newLine > 0) rows.push({ kind: "add", line: newLine++, text: line.slice(1) });
    else if (line.startsWith(" ") && oldLine > 0 && newLine > 0) { rows.push({ kind: "context", line: newLine++, text: line.slice(1) }); oldLine++; }
    else if (line.trim()) rows.push({ kind: "meta", text: line });
  }
  return rows;
}

function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added++;
    else if (row.kind === "remove") removed++;
  }
  return { added, removed };
}

interface DiffSpan { start: number; end: number }

function diffKindColor(theme: ThemeLike, kind: DiffRow["kind"], text: string): string {
  if (kind === "add") return `${DIFF_ADD_FG}${text}${ANSI_RESET}`;
  if (kind === "remove") return `${DIFF_REMOVE_FG}${text}${ANSI_RESET}`;
  if (kind === "meta") return fg(theme, "muted", text);
  return fg(theme, "toolOutput", text);
}

function diffRowBackground(kind: DiffRow["kind"]): string | undefined {
  if (kind === "add") return DIFF_ADD_BG;
  if (kind === "remove") return DIFF_REMOVE_BG;
  return undefined;
}

function diffEmphasisBackground(kind: DiffRow["kind"]): string | undefined {
  if (kind === "add") return DIFF_ADD_EMPHASIS_BG;
  if (kind === "remove") return DIFF_REMOVE_EMPHASIS_BG;
  return undefined;
}

function keepBackgroundAcrossResets(text: string, rowBg: string): string {
  return text.replace(ANSI_CAPTURE_RE, (sequence, params: string) => {
    const values = params.split(";").filter(Boolean).map(Number);
    if (params === "" || values.includes(0) || values.includes(49)) return `${sequence}${rowBg}`;
    return sequence;
  });
}

function padAnsiToWidth(text: string, width: number): string {
  const gap = Math.max(0, width - visibleWidth(text));
  return gap ? `${text}${" ".repeat(gap)}` : text;
}

function paintDiffRow(text: string, rowBg: string | undefined, width: number): string {
  if (!rowBg) return text;
  const padded = padAnsiToWidth(text, width);
  return `${rowBg}${keepBackgroundAcrossResets(padded, rowBg)}${ANSI_BG_RESET}${ANSI_RESET}`;
}

function cleanDiffMeta(text: string): string {
  if (/^Diff:/i.test(text)) return "first changed region";
  return text.replace(/^@@\s+/, "hunk ").trim();
}

function lineNumberWidth(rows: DiffRow[]): number {
  return Math.max(2, ...rows.filter(row => row.kind !== "meta" && row.line !== undefined).map(row => String(row.line).length));
}

function highlightedDiffCode(text: string, filePath: string | undefined): string {
  const language = readLanguage(filePath);
  return highlightReadCodeBlock(text, language)[0] ?? text;
}

function changedSpan(left: string, right: string): { left?: DiffSpan; right?: DiffSpan } {
  if (left === right) return {};
  const a = [...left];
  const b = [...right];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd--; }
  while (start < aEnd && /\s/.test(a[start] ?? "")) start++;
  while (start < bEnd && /\s/.test(b[start] ?? "")) start++;
  return {
    left: aEnd > start ? { start, end: aEnd } : undefined,
    right: bEnd > start ? { start, end: bEnd } : undefined,
  };
}

function applyBackgroundToVisibleRange(text: string, span: DiffSpan | undefined, background: string | undefined, restoreBackground: string | undefined): string {
  if (!span || !background || span.end <= span.start) return text;
  let out = "";
  let visible = 0;
  let active = false;
  for (let index = 0; index < text.length;) {
    ANSI_AT_RE.lastIndex = index;
    const ansi = ANSI_AT_RE.exec(text);
    if (ansi) {
      out += ansi[0];
      index = ANSI_AT_RE.lastIndex;
      continue;
    }
    if (!active && visible === span.start) { out += background; active = true; }
    if (active && visible === span.end) { out += restoreBackground ?? ANSI_BG_RESET; active = false; }
    const code = text.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(code);
    out += char;
    index += char.length;
    visible++;
  }
  if (active) out += restoreBackground ?? ANSI_BG_RESET;
  return out;
}

function inlineSpanMap(rows: DiffRow[]): Map<number, DiffSpan> {
  const spans = new Map<number, DiffSpan>();
  for (let index = 0; index < rows.length - 1; index++) {
    const left = rows[index];
    const right = rows[index + 1];
    if (left?.kind !== "remove" || right?.kind !== "add") continue;
    const span = changedSpan(left.text, right.text);
    if (span.left) spans.set(index, span.left);
    if (span.right) spans.set(index + 1, span.right);
  }
  return spans;
}

function renderPrettyDiffRows(rows: DiffRow[], theme: ThemeLike, expanded: boolean, width: number, maxCollapsedRows = DEFAULT_DIFF_COLLAPSED_ROWS, filePath?: string, headerLabel = "diff"): string[] {
  const contentWidth = Math.max(24, width - 2);
  const stats = diffStats(rows);
  const usefulRows = rows.filter(row => row.kind !== "meta" || !/^Diff:/i.test(row.text));
  const maxRows = expanded ? usefulRows.length : maxCollapsedRows;
  const shown = usefulRows.slice(0, maxRows);
  const numberWidth = lineNumberWidth(usefulRows);
  const spans = inlineSpanMap(usefulRows);
  const header = [
    fg(theme, "toolOutput", bold(theme, headerLabel)),
    diffKindColor(theme, "add", `+${stats.added}`),
    diffKindColor(theme, "remove", `-${stats.removed}`),
  ].join(" ");
  const rendered = [header, fg(theme, "muted", "─".repeat(Math.min(contentWidth, 72)))];
  for (let index = 0; index < shown.length; index++) {
    const row = shown[index]!;
    if (row.kind === "meta") {
      rendered.push(fg(theme, "muted", `… ${cleanDiffMeta(row.text)}`));
      continue;
    }
    const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
    const marker = row.kind === "context" ? " " : diffKindColor(theme, row.kind, "▌");
    const number = `${sign}${String(row.line ?? "").padStart(numberWidth, " ")}`;
    const gutter = diffKindColor(theme, row.kind, number);
    const divider = fg(theme, "muted", "│");
    const rowBg = diffRowBackground(row.kind);
    const emphasisBg = diffEmphasisBackground(row.kind);
    const code = applyBackgroundToVisibleRange(highlightedDiffCode(row.text, filePath), spans.get(index), emphasisBg, rowBg ?? ANSI_BG_RESET);
    rendered.push(paintDiffRow(`${marker} ${gutter} ${divider} ${code}`, rowBg, contentWidth));
  }
  if (usefulRows.length > shown.length) rendered.push(fg(theme, "muted", `… ${usefulRows.length - shown.length} more diff rows hidden · Ctrl+U to show`));
  return rendered;
}

function renderDiffRows(rows: DiffRow[], theme: ThemeLike, expanded: boolean, width: number, _split = false, maxCollapsedRows = DEFAULT_DIFF_COLLAPSED_ROWS, filePath?: string, headerLabel = "diff"): string[] {
  return renderPrettyDiffRows(rows, theme, expanded, width, maxCollapsedRows, filePath, headerLabel);
}

function sourceRowsToAddedDiffRows(sourceRows: string[]): DiffRow[] {
  return sourceRows.map((line, index) => {
    const match = /^(\d+):(.*)$/.exec(line);
    return { kind: "add", line: match ? Number(match[1]) : index + 1, text: match?.[2] ?? line };
  });
}

export function renderEditResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindResultCard(context);
  const expanded = isExpanded(options, context, theme);
  const text = textOf(result);
  const status = frameStatus(result, options, context, text);
  const width = frameWidth(options, context);
  if (status === "pending") return framed([], labelWithStatus(status, "pending edit", theme), status, theme, width, "edit");
  if (status === "error") return framed(previewBody(text || "edit failed", expanded, 18), labelWithStatus(status, "edit failed", theme), status, theme, width, "edit");
  const parsed = parseReadBody(text);
  const pathLabel = parsed.path ? shortenDisplayText(parsed.path, context) : undefined;
  const rows = parseSimpleDiff(extractDiff(text));
  const stats = diffStats(rows);
  const body = rows.length ? renderDiffRows(rows, theme, expanded, width, false, EDIT_DIFF_COLLAPSED_ROWS, parsed.path, "edit diff") : previewBody(firstLine(text, "Edited."), true, 1);
  const label = `edited${pathLabel ? ` ${pathLabel}` : ""} +${stats.added} -${stats.removed}${parsed.tag ? ` • hash ${parsed.tag}` : ""}`;
  return framed(body, labelWithStatus(status, label, theme), status, theme, width, "edit", EDIT_RENDERED_UI_LINES);
}

export function renderWriteCall(args: any, theme: ThemeLike, context: any = {}): any {
  const path = typeof args?.path === "string" ? args.path : "...";
  const content = typeof args?.content === "string" ? args.content : "";
  const lineCount = content ? content.split("\n").length : 0;
  const bytes = Buffer.byteLength(content, "utf8");
  const suffix = content ? ` (${lineCount} ${lineCount === 1 ? "line" : "lines"} • ${bytes} B${args?.overwrite ? " • overwrite" : ""})` : "";
  return framedCall("write", `${args?.overwrite ? "overwrite" : "create"} ${path}${suffix}`, theme, context);
}

function writeStateFromText(text: string): "created" | "overwritten" | "error" | "unknown" {
  if (/^Write refused:/m.test(text) || /^ERROR:/m.test(text)) return "error";
  if (/^Created\s/m.test(text) || /\nCreated\s/m.test(text)) return "created";
  if (/^Overwrote\s/m.test(text) || /\nOverwrote\s/m.test(text)) return "overwritten";
  return "unknown";
}

export function renderWriteResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindResultCard(context);
  const expanded = isExpanded(options, context, theme);
  const text = textOf(result);
  const state = writeStateFromText(text);
  const status: FrameStatus = state === "error" ? "error" : frameStatus(result, options, context, text);
  const width = frameWidth(options, context);
  if (status === "pending") return framed([], labelWithStatus(status, "pending write", theme), status, theme, width, "write");
  if (status === "error") return framed(previewBody(text || "write failed", expanded, 18), labelWithStatus(status, "write failed", theme), status, theme, width, "write");

  const parsed = parseReadBody(text);
  const pathLabel = parsed.path ? shortenDisplayText(parsed.path, context) : undefined;

  if (state === "overwritten") {
    const rows = parseSimpleDiff(extractDiff(text));
    const stats = diffStats(rows);
    const label = `overwritten${pathLabel ? ` ${pathLabel}` : ""} +${stats.added} -${stats.removed}${parsed.tag ? ` • hash ${parsed.tag}` : ""}`;
    return framed(renderDiffRows(rows, theme, expanded, width, false, WRITE_DIFF_COLLAPSED_ROWS, parsed.path, "overwrite diff"), labelWithStatus(status, label, theme), status, theme, width, "write", WRITE_RENDERED_UI_LINES);
  }

  const bodyLines = parsed.bodyLines;
  const sourceRows = bodyLines.filter(line => /^\d+:/.test(line));
  const addedRows = sourceRowsToAddedDiffRows(sourceRows);
  const body = addedRows.length ? renderDiffRows(addedRows, theme, expanded, width, false, WRITE_SOURCE_COLLAPSED_ROWS, parsed.path, "created file") : previewBody(text, expanded, 18);
  if (!expanded && sourceRows.length > WRITE_SOURCE_COLLAPSED_ROWS) body.push(fg(theme, "muted", `… ${sourceRows.length - WRITE_SOURCE_COLLAPSED_ROWS} more written lines hidden · Ctrl+U to show`));
  const label = state === "created" ? `created${pathLabel ? ` ${pathLabel}` : ""}${sourceRows.length ? ` • ${sourceRows.length} ${sourceRows.length === 1 ? "line" : "lines"}` : ""}${parsed.tag ? ` • hash ${parsed.tag}` : ""}` : firstLine(text, "wrote file");
  return framed(body, labelWithStatus(status, label, theme), status, theme, width, "write", WRITE_RENDERED_UI_LINES);
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").filter(line => line.length > 0).length;
}

function previewBody(text: string, expanded: boolean, maxCollapsed = 12): string[] {
  const lines = String(text ?? "").split("\n").filter(line => line.length > 0);
  const shown = expanded ? lines : lines.slice(0, maxCollapsed);
  const out = [...shown];
  if (!expanded && lines.length > shown.length) out.push(`… ${lines.length - shown.length} more UI lines hidden · Ctrl+U to show`);
  return out;
}
function renderToolCallValidation(result: any, theme: ThemeLike, context: any, tool: string): any | undefined {
  const validation = result?.details?.validation;
  if (validation?.kind !== "tool-call-validation") return undefined;
  const width = frameWidth({}, context);
  const lines = [
    `${fg(theme, "warning", "Issue:")} ${String(validation.issue ?? "invalid parameters")}`,
    validation.received ? `${fg(theme, "muted", "Received:")} ${String(validation.received)}` : "",
    ...(Array.isArray(validation.accepted) && validation.accepted.length ? [fg(theme, "accent", "Accepted forms:"), ...validation.accepted.map((item: unknown) => `  • ${String(item)}`)] : []),
    ...(Array.isArray(validation.guidance) && validation.guidance.length ? [fg(theme, "accent", "Guidance:"), ...validation.guidance.map((item: unknown) => `  • ${String(item)}`)] : []),
    fg(theme, "muted", "Nothing executed; no project evidence was produced."),
  ].filter(Boolean);
  return framed(lines, labelWithStatus("error", `${tool} invalid call`, theme), "error", theme, width, tool);
}

function callNormalizationLines(result: any, theme: ThemeLike): string[] {
  const items = Array.isArray(result?.details?.callNormalizations) ? result.details.callNormalizations : [];
  return items.length ? [fg(theme, "muted", `Normalized call: ${items.join("; ")}`)] : [];
}

export function renderSimpleCall(label: string, detail: string | undefined, theme: ThemeLike, context: any = {}): any {
  return framedCall(label, detail, theme, context);
}

export function renderLspValidateCall(args: any, theme: ThemeLike, context: any = {}): any {
  const paths = typeof args?.paths === "string" ? [args.paths] : Array.isArray(args?.paths) ? args.paths : [];
  const target = paths.length === 1 ? String(paths[0]) : `${paths.length} paths${paths.length ? ` • ${paths[0]}` : ""}`;
  const root = typeof args?.root === "string" ? ` in ${args.root}` : "";
  const semantics = [args?.includeWarnings ? "errors + warnings" : "errors only", `limit ${args?.limit ?? 100}`].join(" · ");
  return framedCall("lsp_validate", `${target || "missing paths"}${root} · ${semantics}`, theme, context);
}

function lspDiagnosticLabel(diagnostic: any): string {
  const start = diagnostic?.range?.start;
  const location = Number.isInteger(start?.line)
    ? `L${Number(start.line) + 1}${Number.isInteger(start?.character) ? `:${Number(start.character) + 1}` : ""} `
    : "";
  const source = [diagnostic?.source, diagnostic?.code].filter(value => value !== undefined && value !== "").join("/");
  return `${location}${String(diagnostic?.message ?? "diagnostic")}${source ? ` [${source}]` : ""}`;
}

export function renderLspValidateResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindResultCard(context);
  const validation = renderToolCallValidation(result, theme, context, "lsp_validate");
  if (validation) return validation;
  const expanded = isExpanded(options, context, theme);
  const text = textOf(result);
  const baseStatus = frameStatus(result, options, context, text);
  const width = frameWidth(options, context);
  const files = Array.isArray(result?.details?.files) ? result.details.files : [];
  if (!files.length) {
    const progress = result?.details?.progress;
    const label = progress ? `${progress.phase} ${Number(progress.completed ?? 0)}/${Number(progress.total ?? 0)}` : firstLine(text, "LSP validation");
    return framed(previewBody(text, expanded, 18), labelWithStatus(baseStatus, label, theme), baseStatus, theme, width, "lsp_validate");
  }

  const counts = new Map<string, number>();
  for (const file of files) counts.set(String(file?.status ?? "unconfirmed"), (counts.get(String(file?.status ?? "unconfirmed")) ?? 0) + 1);
  const diagnostics = counts.get("diagnostics") ?? 0;
  const clean = counts.get("clean") ?? 0;
  const unconfirmed = counts.get("unconfirmed") ?? 0;
  const unsupported = counts.get("unsupported") ?? 0;
  const unavailable = counts.get("unavailable") ?? 0;
  const skipped = counts.get("skipped") ?? 0;
  const uncertain = unconfirmed + unsupported + unavailable + skipped;
  const status: FrameStatus = baseStatus === "error" || baseStatus === "pending"
    ? baseStatus
    : diagnostics > 0
      ? "warning"
      : uncertain > 0 && clean > 0
        ? "partial"
        : uncertain > 0
          ? "warning"
          : "success";
  const fileLimit = expanded ? files.length : Math.min(files.length, 12);
  const lines: string[] = [...callNormalizationLines(result, theme)];
  for (const file of files.slice(0, fileLimit)) {
    const fileStatus = String(file?.status ?? "unconfirmed");
    const count = Array.isArray(file?.diagnostics) ? file.diagnostics.length : 0;
    const color: ThemeColor = fileStatus === "clean" ? "success" : fileStatus === "diagnostics" ? "warning" : "muted";
    lines.push(`${fg(theme, color, fileStatus[0]?.toUpperCase() + fileStatus.slice(1))}: ${fg(theme, "toolOutput", String(file?.path ?? ""))}${count ? ` · ${count} ${count === 1 ? "diagnostic" : "diagnostics"}` : ""}${file?.note ? ` · ${file.note}` : ""}`);
    const diagnosticLimit = expanded ? count : Math.min(count, 2);
    for (const diagnostic of (file?.diagnostics ?? []).slice(0, diagnosticLimit)) lines.push(`  ${fg(theme, "warning", "→")} ${lspDiagnosticLabel(diagnostic)}`);
    if (!expanded && count > diagnosticLimit) lines.push(`  … ${count - diagnosticLimit} more diagnostics hidden · Ctrl+U to show`);
  }
  if (!expanded && files.length > fileLimit) lines.push(`… ${files.length - fileLimit} more files hidden · Ctrl+U to show`);
  const summary = [
    diagnostics ? `${diagnostics} ${diagnostics === 1 ? "diagnostic file" : "diagnostic files"}` : "",
    clean ? `${clean} clean` : "",
    unconfirmed ? `${unconfirmed} unconfirmed` : "",
    unsupported ? `${unsupported} unsupported` : "",
    unavailable ? `${unavailable} unavailable` : "",
    skipped ? `${skipped} skipped` : "",
  ].filter(Boolean).join(" • ") || `${files.length} files`;
  return framed(lines, labelWithStatus(status, summary, theme), status, theme, width, "lsp_validate");
}

export function renderFindCall(args: any, theme: ThemeLike, context: any = {}): any {
  const patterns = Array.isArray(args?.patterns) && args.patterns.length ? args.patterns.join(", ") : typeof args?.pattern === "string" ? args.pattern : "*";
  const scope = typeof args?.scope === "string" && args.scope !== "." ? ` in ${args.scope}` : "";
  const semantics = [args?.type ?? "any", args?.visibility ?? "project", args?.sort ?? "mtime"].join(" · ");
  return framedCall("find", `${patterns}${scope} · ${semantics}`, theme, context);
}

function nativeDataRecords(result: any, key: string): any[] {
  const value = result?.details?.native?.data?.[key];
  return Array.isArray(value) ? value : [];
}

function nativeReturned(result: any): number | undefined {
  const value = result?.details?.native?.completeness?.returned;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function pathCandidateCount(text: string): number {
  if (/No path candidates parsed|No matches\./i.test(text)) return 0;
  const match = /# Path candidates — (\d+) file/.exec(text)
    ?? /^# Glob:.*—\s*(\d+)\s+files?\b/m.exec(text);
  if (match) return Number(match[1]);
  return Math.max(0, countLines(text) - 3);
}

function pathSearchPreview(text: string, expanded: boolean): string[] {
  return previewBody(text, expanded, expanded ? 80 : 22);
}

function structuredFindPreview(result: any, expanded: boolean, theme: ThemeLike): string[] | undefined {
  const data = result?.details?.native?.data;
  if (!Array.isArray(data?.entries) || !Array.isArray(data?.patterns)) return undefined;
  const lines: string[] = [];
  const patterns = data.patterns.map((pattern: any) => String(pattern?.input ?? pattern?.normalized ?? "*"));
  if (patterns.length === 1) {
    const count = data.entries.filter((entry: any) => Array.isArray(entry?.matchedPatterns) && entry.matchedPatterns.includes(patterns[0])).length;
    lines.push(`${fg(theme, "accent", patterns[0]!)} ${fg(theme, "muted", "·")} ${count} ${count === 1 ? "file" : "files"}`);
  } else if (patterns.length > 1) {
    const parts = patterns.map(pat => {
      const c = data.entries.filter((entry: any) => Array.isArray(entry?.matchedPatterns) && entry.matchedPatterns.includes(pat)).length;
      return `${fg(theme, "accent", pat)}${fg(theme, "muted", ` (${c})`)}`;
    });
    lines.push(parts.join(` ${fg(theme, "muted", "·")} `));
  }
  const entryLimit = expanded ? data.entries.length : Math.min(data.entries.length, Math.max(8, 21 - patterns.length));
  for (const entry of data.entries.slice(0, entryLimit)) {
    const attribution = Array.isArray(entry?.matchedPatterns) && entry.matchedPatterns.length > 1
      ? ` · ${entry.matchedPatterns.join(", ")}`
      : "";
    const tokens = Number(entry?.tokenEstimate) > 0 ? `  ${fg(theme, "muted", `~${entry.tokenEstimate} tokens`)}` : "";
    lines.push(`${fileIcon(theme, String(entry?.path ?? ""), String(entry?.kind ?? "file"))}${fg(theme, "toolOutput", String(entry?.path ?? ""))}${tokens}${attribution}`);
  }
  if (!expanded && data.entries.length > entryLimit) lines.push(`… ${data.entries.length - entryLimit} more paths hidden · Ctrl+U to show`);
  return lines;
}

function structuredLsPreview(result: any, expanded: boolean, theme: ThemeLike, context: any): string[] | undefined {
  const entries = nativeDataRecords(result, "entries");
  if (!entries.length) return undefined;
  const view = String(context?.args?.view ?? "list");
  const limit = expanded ? entries.length : Math.min(entries.length, 24);
  const shown = entries.slice(0, limit);
  const decorate = (entry: any, name: string) => {
    const path = String(entry?.path ?? "");
    const kind = String(entry?.kind ?? "file");
    const tokens = kind === "file" && Number(entry?.tokenEstimate) > 0 ? `${fg(theme, "muted", ` · ~${entry.tokenEstimate}`)}` : "";
    return `${fileIcon(theme, path, kind)}${fg(theme, kind === "directory" ? "accent" : "toolOutput", name)}${tokens}`;
  };
  let lines: string[];
  if (view === "tree") {
    const laterSibling = new Array(entries.length).fill(false);
    const seenAtDepth: boolean[] = [];
    for (let index = entries.length - 1; index >= 0; index--) {
      const depth = Math.max(1, Number(entries[index]?.depth ?? 1));
      laterSibling[index] = Boolean(seenAtDepth[depth]);
      seenAtDepth[depth] = true;
      seenAtDepth.length = depth + 1;
    }
    const ancestors: number[] = [];
    lines = shown.map((entry: any, index: number) => {
      const depth = Math.max(1, Number(entry?.depth ?? 1));
      const prefix: string[] = [];
      for (let level = 1; level < depth; level++) {
        const ancestor = ancestors[level];
        prefix.push(ancestor !== undefined && laterSibling[ancestor] ? "│  " : "   ");
      }
      prefix.push(laterSibling[index] ? "├─ " : "└─ ");
      ancestors[depth] = index;
      ancestors.length = depth + 1;
      return `${fg(theme, "muted", prefix.join(""))}${decorate(entry, basename(String(entry?.path ?? "")) || String(entry?.path ?? ""))}`;
    });
  } else {
    lines = shown.map((entry: any) => decorate(entry, basename(String(entry?.path ?? "")) || String(entry?.path ?? "")));
  }
  if (!expanded && entries.length > limit) lines.push(`… ${entries.length - limit} more entries hidden · Ctrl+U to show`);
  return lines;
}

export function renderFindResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindResultCard(context);
  const expanded = isExpanded(options, context, theme);
  const text = textOf(result);
  const status = frameStatus(result, options, context, text);
  const width = frameWidth(options, context);
  if (status === "pending") return framed([], labelWithStatus(status, "pending path search", theme), status, theme, width, "find");
  if (status === "error") return framed(previewBody(text || "find failed", expanded, 18), labelWithStatus(status, "path search failed", theme), status, theme, width, "find");
  const paths = nativeReturned(result) ?? pathCandidateCount(text);
  return framed(structuredFindPreview(result, expanded, theme) ?? pathSearchPreview(text, expanded), labelWithStatus(status, `${paths} ${paths === 1 ? "file" : "files"}`, theme), status, theme, width, "find");
}

export function renderLsCall(args: any, theme: ThemeLike, context: any = {}): any {
  const target = typeof args?.path === "string" ? args.path : ".";
  const view = typeof args?.view === "string" ? args.view : "list";
  const depth = view === "tree" && Number.isInteger(args?.depth) ? ` depth ${args.depth}` : "";
  const semantics = [args?.glob ? `glob ${args.glob}` : "", args?.visibility ?? "project", args?.sort ?? (view === "tree" ? "path" : "mtime")].filter(Boolean).join(" · ");
  return framedCall("ls", `${target} · ${view}${depth}${semantics ? ` · ${semantics}` : ""}`, theme, context);
}

export function renderLsResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindResultCard(context);
  const expanded = isExpanded(options, context, theme);
  const text = textOf(result);
  const status = frameStatus(result, options, context, text);
  const width = frameWidth(options, context);
  if (status === "pending") return framed([], labelWithStatus(status, "pending directory shape", theme), status, theme, width, "ls");
  if (status === "error") return framed(previewBody(text || "ls failed", expanded, 18), labelWithStatus(status, "directory listing failed", theme), status, theme, width, "ls");
  const entries = nativeDataRecords(result, "entries");
  const files = entries.filter(entry => entry?.kind === "file").length;
  const directories = entries.filter(entry => entry?.kind === "directory").length;
  return framed(structuredLsPreview(result, expanded, theme, context) ?? previewBody(text, expanded, expanded ? 100 : 24), labelWithStatus(status, `${files} ${files === 1 ? "file" : "files"} • ${directories} ${directories === 1 ? "directory" : "directories"}`, theme), status, theme, width, "ls");
}

export function renderGrepCall(args: any, theme: ThemeLike, context: any = {}): any {
  if (typeof args?.cursor === "string") return framedCall("grep", `continue ${args.cursor}${args?.contextLines !== undefined ? ` · C${args.contextLines}` : ""}`, theme, context);
  const subject = args?.pattern ?? args?.query ?? args?.target ?? args?.focus?.target;
  const pattern = typeof subject === "string" ? JSON.stringify(subject) : "\"\"";
  const output = typeof args?.output === "string" ? args.output : "ranked";
  const paths = Array.isArray(args?.paths) ? `${args.paths.length} targets` : typeof args?.paths === "string" ? args.paths : ".";
  const semantics = [args?.syntax ?? "auto", args?.case ?? "smart", args?.visibility ?? "project", args?.contextLines !== undefined ? `C${args.contextLines}` : "", args?.glob ? `glob ${args.glob}` : ""].filter(Boolean).join(" · ");
  return framedCall("grep", `${output} ${pattern} in ${paths} · ${semantics}`, theme, context);
}

function grepCounts(text: string): { matches: number; files: number } {
  const match = /# Search:[^\n]*—\s*(\d+)\s+matches/.exec(text) ?? /(\d+) returned matches? in (\d+) matched files?/.exec(text);
  const matches = match ? Number(match[1]) : 0;
  const files = match?.[2] ? Number(match[2]) : (text.match(/^###\s+/gm) ?? []).length;
  return { matches, files };
}

function grepPreview(text: string, expanded: boolean): string[] {
  if (expanded) return previewBody(text, true, 100);
  const lines = text.split("\n");
  const keep = lines.filter(line => /^(Exact search|Scope:|Glob:|# Search:|###\s+|Live source authority|\[[^\]]+#[0-9A-F]{8}\] lines\s|\s*→|\s*\d+\s*[│|]|```)/.test(line));
  const shown = keep.slice(0, 22);
  if (keep.length > shown.length) shown.push(`… ${keep.length - shown.length} more match rows hidden · Ctrl+U to show`);
  return shown;
}

function compactOutline(outline: any[], expanded: boolean, groupCount: number): any[] {
  if (!Array.isArray(outline) || !outline.length) return [];
  if (expanded) return outline;
  const selected = Math.max(0, outline.findIndex(item => item?.selected));
  const radius = groupCount === 1 ? 2 : groupCount === 2 ? 1 : 0;
  return outline.slice(Math.max(0, selected - radius), Math.min(outline.length, selected + radius + 1));
}

function compactLineRanges(lines: number[]): string {
  const sorted = [...new Set(lines.filter(Number.isInteger))].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let index = 0; index < sorted.length;) {
    const start = sorted[index]!;
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) end = sorted[++index]!;
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    index++;
  }
  return ranges.join(",");
}

function highlightedEvidenceRow(theme: ThemeLike, path: string, line: number, text: string, matched: boolean): string {
  const code = highlightReadCodeBlock(text, readLanguage(path))[0] ?? text;
  const marker = matched ? fg(theme, "accent", "→") : " ";
  const gutter = `${fg(theme, "dim", String(line).padStart(4, " "))} ${fg(theme, "muted", matched ? "│" : "┆")}`;
  return `${marker} ${gutter} ${matched ? bold(theme, code) : code}${ANSI_RESET}`;
}
function coverageReasonSuffix(completeness: unknown): string {
  if (!completeness || typeof completeness !== "object") return "";
  const record = completeness as Record<string, unknown>;
  if (record.complete !== false) return "";
  const labels: Record<string, string> = {
    candidate_cap: "candidate-cap",
    budget: "budget",
    deadline: "deadline",
    cancelled: "cancelled",
    error: "error",
  };
  const label = labels[String(record.reason ?? "")];
  return label ? ` · incomplete: ${label}` : " · incomplete: unspecified";
}

function structuredMatchesPreview(result: any, expanded: boolean, theme: ThemeLike): string[] | undefined {
  const data = result?.details?.native?.data;
  if (data?.mode !== "matches" || !Array.isArray(data.groups)) return undefined;
  const lines: string[] = [];
  const resolved = data.resolved ?? {};
  const resolvedSyntax = String(resolved.syntax ?? "matches");
  const filters = Array.isArray(data.filter) ? data.filter : [];
  // Compact single header: syntax · filter — no Resolved:/Filter: two-liner
  const filterLabel = filters.some((filter: any) => filter?.customOverride) ? "custom nav"
    : filters.some((filter: any) => filter?.source === "gitignore") ? "gitignore"
    : "explicit";
  lines.push(`${fg(theme, "muted", resolvedSyntax)} ${fg(theme, "muted", "·")} ${fg(theme, "muted", filterLabel)} ${Number(resolved.contextLines ?? 0) ? fg(theme, "muted", `C${Number(resolved.contextLines)}`) : ""}`.trim());

  const sourceRows = Array.isArray(data.sourceRows) ? data.sourceRows : [];
  const groupLimit = expanded ? data.groups.length : Math.min(data.groups.length, 4);
  const rowLimit = expanded ? Number.POSITIVE_INFINITY : data.groups.length === 1 ? 9 : data.groups.length === 2 ? 5 : 3;
  for (const group of data.groups.slice(0, groupLimit)) {
    const owner = group?.owner;
    const start = owner?.start ?? group?.matches?.[0]?.line ?? 1;
    const end = owner?.end ?? group?.matches?.at?.(-1)?.line ?? start;
    const label = owner ? `${owner.kind} ${owner.name}` : "exact lines";
    lines.push(`${fg(theme, "toolOutput", `${group.path}:${start}-${end}`)} ${fg(theme, "accent", `[${label}]`)}`);
    for (const item of compactOutline(group?.outline ?? [], expanded, data.groups.length)) {
      const marker = item?.selected ? fg(theme, "accent", "→") : fg(theme, "muted", "·");
      const itemName = String(item?.name ?? "");
      const outlineLabel = String(item?.kind ?? "") === "import" && itemName.startsWith("import ") ? itemName : `${item?.kind} ${itemName}`;
      lines.push(`${marker} ${fg(theme, "muted", `[${item?.start}-${item?.end}]`)} ${outlineLabel}`);
    }
    const matchLines = new Set((group?.matches ?? []).map((match: any) => Number(match?.line)));
    const context = Number(resolved.contextLines ?? 0);
    const bounds = (group?.matches ?? []).reduce((value: { low: number; high: number }, match: any) => ({
      low: Math.min(value.low, Math.max(1, Number(match?.line ?? 1) - context)),
      high: Math.max(value.high, Number(match?.line ?? 1) + context),
    }), { low: Number.POSITIVE_INFINITY, high: 0 });
    const allRows = sourceRows
      .filter((row: any) => row?.path === group?.path && Number(row?.line) >= bounds.low && Number(row?.line) <= bounds.high);
    const rows = (expanded ? allRows : [...allRows]
      .sort((left: any, right: any) => {
        const distance = (row: any) => Math.min(...[...matchLines].map(line => Math.abs(Number(row?.line) - Number(line))));
        return distance(left) - distance(right) || Number(left?.line) - Number(right?.line);
      })
      .slice(0, rowLimit))
      .sort((left: any, right: any) => Number(left?.line) - Number(right?.line));
    for (const row of rows) lines.push(highlightedEvidenceRow(theme, group.path, Number(row.line), String(row.text ?? ""), matchLines.has(Number(row.line))));
    if (!rows.length) {
      for (const match of (group?.matches ?? []).slice(0, rowLimit)) lines.push(highlightedEvidenceRow(theme, group.path, Number(match.line), String(match.text ?? ""), true));
    } else if (!expanded && data.groups.length <= 2 && allRows.length > rows.length) {
      lines.push(`  … ${allRows.length - rows.length} more context ${allRows.length - rows.length === 1 ? "row" : "rows"} hidden`);
    }
  }

  for (const exception of Array.isArray(data.exceptions) ? data.exceptions : []) {
    lines.push(`${fg(theme, "warning", "Exceptional:")} ${exception?.path} · ${String(exception?.outcome ?? "exception").toLowerCase()} · ${exception?.reason ?? "unspecified"}`);
  }
  const targets = Array.isArray(data.targets) ? data.targets : [];
  if (targets.length > 1) {
    const completed = targets.filter((target: any) => ["searched", "zero"].includes(String(target?.outcome).toLowerCase())).length;
    lines.push(`Targets: ${completed} completed · ${targets.length - completed} exceptional`);
  }
  for (const target of targets) {
    const outcome = String(target?.outcome ?? "").toLowerCase();
    if (outcome !== "searched" || Number(target?.occurrences ?? 0) === 0) {
      const reasons = Array.isArray(target?.reasons) && target.reasons.length ? ` · ${target.reasons.join("; ")}` : "";
      lines.push(`${fg(theme, outcome === "error" ? "error" : "warning", "Target:")} ${target?.requested} · ${outcome}${reasons}`);
    }
  }
  const coverage = data.coverage ?? {};
  const clipped = Number(coverage.clippedSourceLines ?? 0);
  if (clipped > 0) {
    lines.push(`Presentation: ${clipped} oversized source ${clipped === 1 ? "line" : "lines"} clipped · exact spans preserved`);
    lines.push(fg(theme, "warning", "Authority: clipped source rows are not certified"));
  }
  const artifacts = Array.isArray(result?.details?.envelope?.artifacts) ? result.details.envelope.artifacts : [];
  for (const artifact of artifacts) {
    const match = /^\[([^#\]]+)#([0-9A-F]{8})\]$/.exec(String(artifact));
    if (!match) continue;
    const authorityLines = sourceRows.filter((row: any) => row?.path === match[1]).map((row: any) => Number(row.line));
    const rangeText = compactLineRanges(authorityLines);
    lines.push(fg(theme, "success", rangeText ? `[${match[1]}#${match[2]}] lines ${rangeText}` : `[${match[1]}#${match[2]}] live authority`));
  }
  const occurrenceCount = Number(coverage.occurrences ?? 0);
  lines.push(`${fg(theme, "muted", "◉")} ${occurrenceCount} ${occurrenceCount === 1 ? "occurrence" : "occurrences"}${fg(theme, "muted", coverage.complete === false ? " · partial" : "")}${coverageReasonSuffix(result?.details?.native?.completeness)}`);
  if (typeof data.cursor === "string") lines.push(`More matches: continue with grep({cursor:"${data.cursor}", contextLines:N}) — cursor only, no other fields`);
  if (!expanded && data.groups.length > groupLimit) lines.push(`… ${data.groups.length - groupLimit} more blocks hidden · Ctrl+U to show`);
  return lines;
}
function structuredRankedPreview(result: any, expanded: boolean, theme: ThemeLike): string[] | undefined {
  const data = result?.details?.native?.data;
  if (data?.mode === "matches" || !Array.isArray(data?.matches)) return undefined;
  const lines: string[] = [];
  const definitions = Number(data.definitions ?? data.matches.filter((match: any) => match?.role === "definition").length);
  const usages = Number(data.usages ?? data.matches.filter((match: any) => match?.role !== "definition").length);
  const facets = data.facetTotals ?? {};
  const primarySymbol = String(data.matches[0]?.symbol ?? data.query ?? data.kind ?? "ranked");
  const headerParts = [
    `${definitions} def`,
    `${usages} use`,
    Number(facets.tests ?? 0) ? `${facets.tests} test${Number(facets.tests)===1?"":"s"}` : "",
    Number(facets.implementations ?? 0) ? `${facets.implementations} impl` : "",
  ].filter(Boolean).join(` ${fg(theme, "muted", "·")} `);
  lines.push(`${fg(theme, "accent", "◉")} ${fg(theme, "toolOutput", primarySymbol)} ${fg(theme, "muted", "—")} ${headerParts}`);
  const sourceRows = Array.isArray(data.sourceRows) ? data.sourceRows : [];
  const shownRows: Array<{ path: string; line: number }> = [];
  const limit = expanded ? data.matches.length : Math.min(data.matches.length, 6);
  for (const match of data.matches.slice(0, limit)) {
    const location = match?.location ?? {};
    const path = String(location.path ?? "");
    const start = Number(location.start ?? 1);
    const end = Number(location.end ?? start);
    const label = [match?.role, match?.symbol].filter(Boolean).join(" ") || "ranked match";
    const row = sourceRows.find((candidate: any) => candidate?.path === path && Number(candidate?.line) === start)
      ?? sourceRows.find((candidate: any) => candidate?.path === path && Number(candidate?.line) >= start && Number(candidate?.line) <= end);
    if (row) {
      shownRows.push({ path, line: Number(row.line) });
      const code = highlightReadCodeBlock(String(row.text ?? ""), readLanguage(path))[0] ?? String(row.text ?? "");
      const roleTag = fg(theme, "muted", ` [${label.split(" ").pop() ?? label}]`);
      lines.push(`${fg(theme, "accent", "→")} ${fg(theme, "toolOutput", `${path}:${start}`)} ${fg(theme, "muted", "│")} ${code}${roleTag}${ANSI_RESET}`);
    } else {
      lines.push(`${fg(theme, "toolOutput", `${path}:${start}-${end}`)} ${fg(theme, "accent", `[${label}]`)}`);
    }
  }
  if (!expanded && data.matches.length > limit) lines.push(`… ${data.matches.length - limit} more ranked matches hidden · Ctrl+U to show`);
  const artifacts = Array.isArray(result?.details?.envelope?.artifacts) ? result.details.envelope.artifacts : [];
  for (const artifact of artifacts) {
    const parsed = /^\[([^#\]]+)#([0-9A-F]{8})\]$/.exec(String(artifact));
    if (!parsed) continue;
    const visible = shownRows.filter(row => row.path === parsed[1]).map(row => row.line);
    if (visible.length) lines.push(fg(theme, "success", `[${parsed[1]}#${parsed[2]}] lines ${compactLineRanges(visible)}`));
  }
  const total = Number(data.totalFound ?? result?.details?.native?.completeness?.total ?? data.matches.length);
  lines.push(`Coverage: ranked page · ${data.matches.length}/${total} structured matches shown${coverageReasonSuffix(result?.details?.native?.completeness)}`);
  return lines;
}

export function renderGrepResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindResultCard(context);
  const validation = renderToolCallValidation(result, theme, context, "grep");
  if (validation) return validation;
  const expanded = isExpanded(options, context, theme);
  const text = textOf(result);
  const status = frameStatus(result, options, context, text);
  const width = frameWidth(options, context);
  if (status === "pending") return framed([], labelWithStatus(status, "pending exact search", theme), status, theme, width, "grep");
  if (status === "error") return framed(previewBody(text || "grep failed", expanded, 18), labelWithStatus(status, "exact search failed", theme), status, theme, width, "grep");
  const structured = structuredMatchesPreview(result, expanded, theme) ?? structuredRankedPreview(result, expanded, theme);
  const fallback = grepCounts(text);
  const coverage = result?.details?.native?.data?.coverage;
  const matches = Number.isInteger(coverage?.occurrences) ? coverage.occurrences : (nativeReturned(result) ?? fallback.matches);
  const nativeMatches = nativeDataRecords(result, "matches");
  const groups = nativeDataRecords(result, "groups");
  const files = groups.length
    ? new Set(groups.map(group => group?.path).filter(Boolean)).size
    : nativeMatches.length
      ? new Set(nativeMatches.map(match => match?.location?.path).filter(Boolean)).size
      : fallback.files;
  const exceptionCount = Math.max(
    nativeDataRecords(result, "exceptions").length,
    nativeDataRecords(result, "targets").filter(target => !["searched", "zero"].includes(String(target?.outcome ?? "").toLowerCase())).length,
  );
  const body = structured ? [...callNormalizationLines(result, theme), ...structured] : grepPreview(text, expanded);
  return framed(body, labelWithStatus(status, `${matches} ${matches === 1 ? "match" : "matches"}${files ? ` • ${files} ${files === 1 ? "file" : "files"}` : ""}${exceptionCount ? ` • ${exceptionCount} ${exceptionCount === 1 ? "exception" : "exceptions"}` : ""}`, theme), status, theme, width, "grep");
}

export function renderExploreCall(args: any, theme: ThemeLike, context: any = {}): any {
  const view = typeof args?.view === "string" ? `${args.view}` : "code";
  const operation = view === "code" && typeof args?.operation === "string" ? ` · ${args.operation}` : "";
  const identityValue = view === "map" ? args?.query : args?.anchor;
  const identity = (typeof identityValue === "string" && identityValue) || typeof identityValue === "number" ? ` · ${JSON.stringify(identityValue)}` : "";
  const scope = typeof args?.scope === "string" ? ` in ${args.scope}` : "";
  const incompatible = view === "code" && args?.query !== undefined
    ? `supplied query ${JSON.stringify(args.query)}`
    : view === "map" && args?.anchor !== undefined
      ? `supplied anchor ${JSON.stringify(args.anchor)}`
      : "";
  const semantics = [incompatible, args?.kind, args?.depth ? `depth ${args.depth}` : "", `page ${args?.page ?? 1}`, `limit ${args?.limit ?? 5}`].filter(Boolean).join(" · ");
  return framedCall("explore", `${view}${operation}${identity}${scope} · ${semantics}`, theme, context);
}


function navigationPreview(text: string, expanded: boolean): string[] {
  if (expanded) return previewBody(text, true, 120);
  const lines = text.split("\n");
  // Keep the natural first-page preview, then surface compact live authority
  // even when a long native relationship result places it at the end.
  const nonEmpty = lines.filter(line => line.trim() !== "");
  const shown = nonEmpty.slice(0, 22);
  const authority = nonEmpty.filter(line => line === "Live source authority" || /^\[[^\]]+#[0-9A-F]{8}\] lines\s/.test(line));
  for (const line of authority) if (!shown.includes(line)) shown.push(line);
  if (nonEmpty.length > shown.length) shown.push(`… more navigation context hidden · Ctrl+U to show`);
  return shown;
}

function structuredExplorePreview(result: any, expanded: boolean, theme: ThemeLike): { body: string[]; summary: string; status?: FrameStatus } | undefined {
  const presentation = result?.details?.presentation;
  if (presentation?.kind !== "explore") return undefined;
  const body: string[] = [];
  if (presentation.view === "code") {
    body.push(`Operation: ${presentation.operation} · Identity: ${presentation.identity}`);
    const nativeStatus = String(presentation.status ?? "ok");
    const nonSuccess = ["not_found", "ambiguous", "unavailable", "error"].includes(nativeStatus);
    const generation = typeof presentation.generation === "string" ? presentation.generation.slice(0, 8) : undefined;
    const windows = Array.isArray(presentation.pageWindows) ? presentation.pageWindows : [];
    const primaryPath = presentation.operation === "search" ? "results" : "traversal";
    const window = windows.find((item: any) => item?.path === primaryPath);
    const fetch = presentation.backendFetch ?? {};
    const pageLine = [
      `page ${window?.page ?? 1}`,
      `${window?.returned_count ?? 0} shown`,
      `${fetch.fetched_count ?? window?.total_count ?? 0}${fetch.lower_bound ? "+ fetched lower-bound" : " fetched"}`,
      presentation.nextPage ? `next ${presentation.nextPage}` : "",
      generation ? `generation ${generation}` : "",
      fetch.native_truncated ? "native truncated" : "",
    ].filter(Boolean).join(" · ");
    const ambiguity = Array.isArray(presentation.ambiguityCandidates) ? presentation.ambiguityCandidates : [];
    const appendAmbiguity = () => {
      if (!ambiguity.length) return;
      body.push(fg(theme, "warning", "Ambiguous identities:"));
      const ambiguityLimit = expanded ? ambiguity.length : Math.min(ambiguity.length, 6);
      for (const row of ambiguity.slice(0, ambiguityLimit)) {
        const range = row?.path ? `${row.path}${row.start ? `:${row.start}${row.end && row.end !== row.start ? `-${row.end}` : ""}` : ""}` : "unknown location";
        body.push(`  ${row?.kind ?? "Node"} ${row?.name ?? "candidate"} · ${fg(theme, "toolOutput", range)}`);
      }
    };

    if (presentation.operation === "search") {
      const candidates = Array.isArray(presentation.candidates) ? presentation.candidates : Array.isArray(presentation.results) ? presentation.results : [];
      const semanticApplicable = presentation.semanticApplicable !== false && presentation.semanticStatus !== "not_applicable";
      const lexicalOnly = semanticApplicable && (nativeStatus === "degraded" || presentation.semanticStatus === "unavailable" || presentation.semanticStatus === "degraded");
      if (!semanticApplicable) {
        body.push(`Search mode: ${presentation.searchMode ?? "keyword"} · lexical File identity evidence active`);
      } else {
        const readiness = presentation.semanticReadiness ?? {};
        body.push(`Search mode: ${presentation.searchMode ?? "unknown"} · ${lexicalOnly ? "lexical code evidence active" : "semantic + lexical code evidence active"}`);
        if (expanded && (readiness.provider || readiness.model || readiness.privacy)) body.push(`Search implementation: ${readiness.provider ?? "unknown"}/${readiness.model ?? "unknown"} · ${readiness.privacy ?? "unknown"}`);
        if (expanded && Number.isFinite(readiness.currentNodes) && Number.isFinite(readiness.vectorCount)) body.push(`Index coverage: ${readiness.vectorCount}/${readiness.currentNodes} vectors`);
      }
      appendAmbiguity();
      const limit = expanded ? candidates.length : Math.min(candidates.length, 8);
      for (const row of candidates.slice(0, limit)) {
        const range = row?.path ? `${row.path}${row.start ? `:${row.start}${row.end && row.end !== row.start ? `-${row.end}` : ""}` : ""}` : "";
        body.push(`${fg(theme, "accent", String(row?.kind ?? "result"))} ${row?.name ?? "result"}${range ? ` · ${fg(theme, "toolOutput", range)}` : ""}`);
        const signals = [row?.score !== undefined ? `retrieval-rank=${Number(row.score).toFixed(3)}` : "", row?.provenance].filter(Boolean);
        if (signals.length) body.push(`  ${signals.join(" · ")}`);
        if (expanded && row?.signature) body.push(`  ${fg(theme, "muted", String(row.signature).replace(/\s+/g, " ").slice(0, 240))}`);
      }
      if (!expanded && candidates.length > limit) body.push(`… ${candidates.length - limit} more ranked identities hidden · Ctrl+U to show`);
      body.push(pageLine);
      if (presentation.nextPage) body.push("Restart at page 1 if the generation differs from the prior page.");
      const authority = Array.isArray(presentation.authority) ? presentation.authority : [];
      body.push(authority.length ? `Current source authority: ${authority.length} hash-certified ${authority.length === 1 ? "range" : "ranges"}` : "Ranges: locators; no current source rows certified in this view.");
      const status: FrameStatus | undefined = nativeStatus === "error" ? "error" : nonSuccess ? "warning" : undefined;
      const summary = nativeStatus === "not_found" ? "no code identity found" : nativeStatus === "ambiguous" ? `ambiguous code identity · ${ambiguity.length} candidates` : `${candidates.length} ranked code ${candidates.length === 1 ? "identity" : "identities"} · ${presentation.searchMode ?? "search"}`;
      return { body, summary, status };
    }

    const topology = presentation.traversal ?? {};
    const nodes = Array.isArray(topology.nodes) ? topology.nodes : [];
    const edges = Array.isArray(topology.edges) ? topology.edges : [];
    appendAmbiguity();
    body.push(`Start: ${topology.startNode ?? "unresolved"} · ${topology.mode ?? "bfs"} depth ${topology.maxDepth ?? "?"}${topology.truncated ? " · native truncated" : ""}`);
    const nodeLimit = expanded ? nodes.length : Math.min(nodes.length, 6);
    const edgeLimit = expanded ? edges.length : Math.min(edges.length, 6);
    for (const row of nodes.slice(0, nodeLimit)) {
      const range = row?.path ? `${row.path}${row.start ? `:${row.start}${row.end && row.end !== row.start ? `-${row.end}` : ""}` : ""}` : "unknown location";
      body.push(`${fg(theme, "accent", "NODE")} d${row?.depth ?? "?"} ${row?.kind ?? "Node"} ${row?.name ?? "node"} · ${fg(theme, "toolOutput", range)}`);
    }
    for (const row of edges.slice(0, edgeLimit)) {
      const site = row?.path ? `${row.path}${row.line ? `:${row.line}` : ""}` : "unknown site";
      const quality = [row?.provenance, row?.confidence !== undefined ? `confidence=${row.confidence}` : ""].filter(Boolean).join(" · ");
      body.push(`${fg(theme, "muted", "EDGE")} ${row?.source ?? "?"} --${row?.kind ?? "EDGE"}${quality ? ` [${quality}]` : ""}--> ${row?.target ?? "?"} · ${site}`);
    }
    if (!expanded && nodes.length + edges.length > nodeLimit + edgeLimit) body.push(`… ${nodes.length + edges.length - nodeLimit - edgeLimit} more topology rows hidden · Ctrl+U to show`);
    body.push(pageLine);
    if (presentation.nextPage) body.push("Restart at page 1 if the generation differs from the prior page.");
    const authority = Array.isArray(presentation.authority) ? presentation.authority : [];
    body.push(authority.length ? `Current source authority: ${authority.length} hash-certified ${authority.length === 1 ? "range" : "ranges"}` : "Topology ranges are locators; no current source rows certified in this view.");
    const status: FrameStatus | undefined = nativeStatus === "error" ? "error" : nonSuccess ? "warning" : topology.truncated || presentation.nextPage ? "partial" : undefined;
    const summary = nativeStatus === "not_found" ? "topology start not found" : nativeStatus === "ambiguous" ? `ambiguous topology start · ${ambiguity.length} candidates` : `${nodes.length} topology ${nodes.length === 1 ? "node" : "nodes"} • ${edges.length} ${edges.length === 1 ? "edge" : "edges"}`;
    return { body, summary, status };
  }
  if (presentation.view === "map") {
    body.push(`Anchoring: ${presentation.anchoring ?? "native"}`);
    const starts = Array.isArray(presentation.starts) ? presentation.starts : [];
    body.push(`Starts: ${starts.length ? starts.join(", ") : "none reported"}`);
    const query = String(presentation.query ?? "");
    const callable = query.match(/\b([A-Za-z_$][\w$]*)\(\)/)?.[1];
    const requestedPath = query.match(/(?:^|\s)([^\s]+\/[^\s]*\.[A-Za-z0-9]{1,10})(?=\s|$)/)?.[1]?.replace(/^\.\//, "");
    const requestedBase = requestedPath?.split("/").pop();
    const missedCallable = Boolean(callable) && !starts.some((start: string) => start.replace(/\(\)$/, "") === callable);
    const missedPath = Boolean(requestedPath) && !starts.some((start: string) => start === requestedPath || start === requestedBase);
    if (missedCallable) body.push(fg(theme, "warning", `Requested callable ${callable}() was not selected as a graph start`));
    if (missedPath) body.push(fg(theme, "warning", `Requested path ${requestedPath} was not retained as a graph start`));
    const nodes = Array.isArray(presentation.nodes) ? presentation.nodes : [];
    const edges = Array.isArray(presentation.edges) ? presentation.edges : [];
    const nodeLimit = expanded ? nodes.length : Math.min(nodes.length, 6);
    const edgeLimit = expanded ? edges.length : Math.min(edges.length, 6);
    for (const node of nodes.slice(0, nodeLimit)) body.push(`${fg(theme, "accent", "NODE")} ${String(node).replace(/^NODE\s+/, "")}`);
    for (const edge of edges.slice(0, edgeLimit)) body.push(`${fg(theme, "muted", "EDGE")} ${String(edge).replace(/^EDGE\s+/, "")}`);
    if (!expanded && nodes.length + edges.length > nodeLimit + edgeLimit) body.push(`… ${nodes.length + edges.length - nodeLimit - edgeLimit} more graph rows hidden · Ctrl+U to show`);
    const windows = Array.isArray(presentation.pageWindows) ? presentation.pageWindows : [];
    const nodeWindow = windows.find((item: any) => item?.path === "nodes");
    const edgeWindow = windows.find((item: any) => item?.path === "edges");
    if (nodeWindow || edgeWindow) body.push(`Page ${nodeWindow?.page ?? edgeWindow?.page ?? 1}/${Math.max(Number(nodeWindow?.total_pages ?? 1), Number(edgeWindow?.total_pages ?? 1))} · nodes ${nodeWindow?.returned_count ?? nodes.length}/${nodeWindow?.total_count ?? nodes.length} · edges ${edgeWindow?.returned_count ?? edges.length}/${edgeWindow?.total_count ?? edges.length}${presentation.nextPage ? ` · next ${presentation.nextPage}` : ""}`);
    const weakStart = missedCallable || missedPath;
    return { body, summary: `${nodes.length} nodes • ${edges.length} edges`, status: weakStart ? "warning" : presentation.nextPage ? "partial" : undefined };
  }
  return undefined;
}

function structuredTracePreview(result: any, expanded: boolean, theme: ThemeLike): { body: string[]; summary: string } | undefined {
  const presentation = result?.details?.presentation;
  if (presentation?.kind === "trace-batch" && Array.isArray(presentation.items)) {
    const body: string[] = [`${presentation.relation} · ${presentation.items.length} ordered targets`];
    for (const item of presentation.items) {
      const rows = Array.isArray(item?.presentation?.rows) ? item.presentation.rows : [];
      body.push(`${item?.status === "success" ? "✓" : item?.status === "error" ? "✗" : "◐"} ${String(item?.target ?? "target")} · ${rows.length} ${rows.length === 1 ? "row" : "rows"}`);
      const shown = expanded ? rows.slice(0, 6) : rows.slice(0, 2);
      for (const row of shown) {
        const start = Number(row?.start ?? 0) || undefined;
        body.push(`  ${fg(theme, "toolOutput", `${row?.path}${start ? `:${start}` : ""}`)}`);
      }
      if (rows.length > shown.length) body.push(`  … ${rows.length - shown.length} more rows`);
    }
    const artifacts = (Array.isArray(result?.details?.envelope?.artifacts) ? result.details.envelope.artifacts : [])
      .filter((artifact: unknown) => /^\[[^\]]+#[0-9A-F]{8}\]$/.test(String(artifact)));
    for (const artifact of artifacts.slice(0, expanded ? artifacts.length : 4)) body.push(fg(theme, "success", `${artifact} live authority`));
    return { body, summary: `${presentation.items.length} trace queries` };
  }
  if (presentation?.kind !== "trace" || !Array.isArray(presentation.rows)) return undefined;
  if (presentation.relation === "path" || presentation.relation === "explain") return undefined;
  const body: string[] = [];
  const direct = presentation.rows.filter((row: any) => row?.origin === "tests_for" || row?.isTest);
  const supplemental = presentation.rows.filter((row: any) => !direct.includes(row));
  if (presentation.relation === "tests") body.push(`Tests: ${direct.length} direct · ${supplemental.length} supplemental candidates`);
  if (!presentation.rows.length) {
    const summaries = [result?.details?.envelope?.summary, presentation.summary].filter((value: unknown, index: number, values: unknown[]) => value && values.indexOf(value) === index);
    for (const summary of summaries.length ? summaries : ["No structural relationship rows returned."]) body.push(String(summary));
  }
  const rows = expanded ? presentation.rows : presentation.rows.slice(0, 8);
  for (const row of rows) {
    const start = Number(row?.start ?? 0) || undefined;
    const end = Number(row?.end ?? start ?? 0) || start;
    const location = `${row?.path}${start ? `:${start}${end && end !== start ? `-${end}` : ""}` : ""}`;
    const origin = row?.origin === "tests_for" ? "direct test" : row?.origin === "callers_of" ? "caller candidate" : String(row?.origin ?? presentation.relation);
    body.push(`${fg(theme, "toolOutput", location)} ${fg(theme, row?.origin === "callers_of" ? "muted" : "accent", `[${origin}]`)}`);
    if (row?.label && row.label !== presentation.relation) body.push(`  ${String(row.label)}`);
  }
  if (!expanded && presentation.rows.length > rows.length) body.push(`… ${presentation.rows.length - rows.length} more relationship rows hidden · Ctrl+U to show`);
  const artifacts = (Array.isArray(result?.details?.envelope?.artifacts) ? result.details.envelope.artifacts : [])
    .filter((artifact: unknown) => /^\[[^\]]+#[0-9A-F]{8}\]$/.test(String(artifact)));
  for (const artifact of artifacts) body.push(fg(theme, "success", `${artifact} live authority`));
  const windows = Array.isArray(presentation.pageWindows) ? presentation.pageWindows : [];
  const pageWindow = windows.find((window: any) => window?.path === "results") ?? windows[0];
  if (pageWindow) body.push(`Page ${pageWindow.page ?? 1}/${pageWindow.total_pages ?? pageWindow.totalPages ?? 1} · ${pageWindow.complete === false ? "partial" : "complete"}`);
  return { body, summary: `${presentation.rows.length} ${presentation.rows.length === 1 ? "relationship row" : "relationship rows"}` };
}


function structuredDocsSearchPreview(result: any, expanded: boolean, theme: ThemeLike): { body: string[]; summary: string; status?: FrameStatus } | undefined {
  const presentation = result?.details?.presentation;
  if (presentation?.kind !== "docs-search" || !Array.isArray(presentation.items)) return undefined;
  const body: string[] = [];
  const semantic = presentation.semantic ?? { status: "unknown" };
  const ranking = presentation.ranking ?? {};
  const counts = presentation.counts ?? {};
  const omissions = presentation.omissions ?? { count: 0, paths: [] };
  const candidateWindow = presentation.candidateWindow ?? {};
  const filters = presentation.filters ?? {};
  const mode = ranking.mode === "hybrid" ? "hybrid" : "lexical";
  if (presentation.status === "unavailable") body.push(`Search result: unavailable for this request${semantic.reason ? ` · ${String(semantic.reason)}` : ""}`);
  else body.push(`Search mode: ${fg(theme, "toolOutput", mode)} · current document-section evidence active`);
  const rankingLabel = mode === "hybrid"
    ? "lexical + vector + reranker + title/authority priors"
    : "lexical ranking + title/authority priors";
  body.push(`Ranking: ${fg(theme, "toolOutput", rankingLabel)} · current Markdown selectors`);
  const filterParts = [filters.path ? `path ${filters.path}` : undefined, filters.glob ? `glob ${filters.glob}` : undefined, filters.scope ? `scope ${filters.scope}` : undefined].filter(Boolean);
  if (filterParts.length) body.push(`Filters: ${filterParts.join(" · ")}`);
  if (presentation.generation) body.push(`Generation: ${fg(theme, "muted", String(presentation.generation))} · current selectors${presentation.latencyMs !== undefined ? ` · ${presentation.latencyMs}ms` : ""}`);
  if (expanded && presentation.privacy) body.push(`Privacy: ${presentation.privacy}`);
  if (expanded && presentation.health) body.push(`Index coverage: ${Number(presentation.health.totalDocs ?? 0) - Number(presentation.health.needsEmbedding ?? 0)}/${Number(presentation.health.totalDocs ?? 0)} section vectors`);
  if (candidateWindow.saturated) body.push(`Candidate window: ${candidateWindow.returned}/${candidateWindow.limit} · lower bound; additional candidates omitted before paging`);
  if (presentation.answerability && presentation.answerability.status !== "not_assessed" && (expanded || Number(presentation.answerability.weak_lead_count ?? 0) > 0)) {
    body.push(`Answerability: ${Number(presentation.answerability.answer_bearing_count ?? 0)} answer-bearing · ${Number(presentation.answerability.weak_lead_count ?? 0)} weak lead(s) · scores rank candidates, not confidence probabilities`);
    if (presentation.answerability.status === "weak_leads_only") body.push("Weak leads only: inspect the ranked sections, but do not treat them as an answer or universal absence.");
  }
  const itemLimit = expanded ? presentation.items.length : Math.min(presentation.items.length, 8);
  for (const item of presentation.items.slice(0, itemLimit)) {
    const role = docsAuthorityLabel(item.authorityRole);
    const range = item.startLine && item.endLine ? ` · L${item.startLine}-${item.endLine}` : "";
    const retrievalRank = Number.isFinite(item.retrievalRank) ? ` · retrieval #${item.retrievalRank}` : "";
    const strength = item.answerability?.status === "weak_lead" ? ` · ${fg(theme, "warning", "weak lead")}` : "";
    body.push(`${fg(theme, "accent", `${item.rank}.`)} ${bold(theme, docsHeadingLabel(item.label))}${role ? ` · ${role}` : ""}${retrievalRank}${strength}`);
    body.push(`   ${fg(theme, "muted", "↳")} read ${fg(theme, "toolOutput", String(item.readSelector ?? item.ref ?? item.path ?? ""))}${range}`);
    if (item.snippet) body.push(`   ${docsSnippet(item.snippet, expanded ? 420 : 260)}`);
    if (expanded && Number.isFinite(item.finalScore)) body.push(`   Retrieval score ${numberScore(item.retrievalScore)} · title ${signedScore(item.titlePrior)} · authority ${signedScore(item.authorityPrior)} · final ${numberScore(item.finalScore)}${Number.isFinite(item.nativeScore) ? ` · native ${numberScore(item.nativeScore)}` : ""}`);
    if (expanded) {
      const explain = docsExplain(item.explain);
      if (explain) body.push(`   Provenance: ${explain}`);
    }
  }
  if (!presentation.items.length) {
    if (presentation.status === "unavailable") body.push("No document index answered this request; the diagnostic above is specific to this call.");
    else if ((filters.path || filters.glob) && Number(counts.candidates ?? 0) > 0 && Number(counts.filtered ?? 0) === 0) body.push("No current candidates survived the requested path/glob filter.");
    else body.push("No current matching Markdown sections.");
  }
  if (!expanded && presentation.items.length > itemLimit) body.push(`… ${presentation.items.length - itemLimit} more sections hidden · Ctrl+U to show`);
  if (Number(omissions.count ?? 0) > 0) {
    body.push(`Selector omissions: ${omissions.count}`);
    for (const omission of (omissions.paths ?? []).slice(0, expanded ? 10 : 3)) body.push(`   ${fg(theme, "warning", String(omission.path ?? "unknown"))} · ${String(omission.reason ?? "omitted")}`);
  }
  for (const diagnostic of (presentation.diagnostics ?? []).filter(Boolean).slice(0, expanded ? 8 : 2)) if (diagnostic !== semantic.reason) body.push(`Diagnostic: ${diagnostic}`);
  const windows = Array.isArray(presentation.pageWindows) ? presentation.pageWindows : [];
  const pageWindow = windows.find((window: any) => window?.path === "results") ?? windows[0];
  if (pageWindow) body.push(`Page ${pageWindow.page ?? 1}/${pageWindow.total_pages ?? pageWindow.totalPages ?? 1} · ${pageWindow.returned_count ?? presentation.items.length}/${pageWindow.total_count ?? presentation.items.length} shown${pageWindow.complete === false ? ` · next ${pageWindow.next_page ?? "available"}` : " · complete"} · omitted ${pageWindow.omitted_before ?? 0}/${pageWindow.omitted_after ?? 0}`);
  let status: FrameStatus | undefined;
  if (presentation.status === "error") status = "error";
  else if (presentation.status === "unavailable") status = "warning";
  else if (presentation.answerability?.status === "weak_leads_only" || Number(omissions.count ?? 0) > 0 || candidateWindow.saturated) status = presentation.items.length ? "partial" : "warning";
  return { body, summary: `${presentation.items.length} ${presentation.items.length === 1 ? "ranked section" : "ranked sections"} · ${mode}`, status };
}

function docsHeadingLabel(value: unknown): string {
  return String(value ?? "Untitled section").replace(/^\d+(?:\.\d+)*[.)]\s+/, "");
}

function docsAuthorityLabel(role: unknown): string | undefined {
  return ({ current_authority: "current authority", operator_runbook: "runbook", implementation_or_historical_plan: "plan/history", generated_or_prompt: "generated/prompt", supporting_documentation: "supporting" } as Record<string, string>)[String(role ?? "")];
}

function docsSnippet(value: unknown, limit: number): string { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; }
function numberScore(value: unknown): string { return Number.isFinite(Number(value)) ? Number(value).toFixed(4) : "unknown"; }
function signedScore(value: unknown): string { const number = Number(value); return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(4)}` : "unknown"; }
function docsExplain(value: any): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fts = Array.isArray(value.ftsScores) && value.ftsScores.length ? `BM25 ${numberScore(Math.max(...value.ftsScores.map(Number)))}` : undefined;
  const vector = Array.isArray(value.vectorScores) && value.vectorScores.length ? `vector ${numberScore(Math.max(...value.vectorScores.map(Number)))}` : undefined;
  const rerank = Number.isFinite(Number(value.rerankScore)) && Number(value.rerankScore) !== 0 ? `rerank ${numberScore(value.rerankScore)}` : undefined;
  const lists = Array.isArray(value.rrf?.contributions) ? `RRF ${value.rrf.contributions.length} ${value.rrf.contributions.length === 1 ? "list" : "lists"}` : undefined;
  return [fts, vector, rerank, lists].filter(Boolean).join(" · ") || undefined;
}

function renderNavigationResult(kind: string, result: any, options: any, theme: ThemeLike, context: any = {}, tool = kind): any {
  const expanded = isExpanded(options, context, theme);
  const text = textOf(result);
  const status = frameStatus(result, options, context, text);
  const width = frameWidth(options, context);
  if (status === "pending") return framed([], labelWithStatus(status, `pending ${kind}`, theme), status, theme, width, tool);
  const summary = result?.details?.envelope?.summary ?? firstLine(text, `${kind} complete`);
  return framed(navigationPreview(text, expanded), labelWithStatus(status, summary, theme), status, theme, width, tool);
}

export function renderExploreResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindResultCard(context);
  const validation = renderToolCallValidation(result, theme, context, "explore");
  if (validation) return validation;
  const expanded = isExpanded(options, context, theme);
  const text = textOf(result);
  const baseStatus = frameStatus(result, options, context, text);
  const width = frameWidth(options, context);
  const structured = structuredExplorePreview(result, expanded, theme);
  if (structured) {
    const status = structured.status ?? baseStatus;
    return framed([...callNormalizationLines(result, theme), ...structured.body], labelWithStatus(status, structured.summary, theme), status, theme, width, "explore");
  }
  return renderNavigationResult("explore", result, options, theme, context, "explore");
}

export function renderTraceCall(args: any, theme: ThemeLike, context: any = {}): any {
  const targets = Array.isArray(args?.targets) ? args.targets : typeof args?.targets === "string" ? [args.targets] : undefined;
  const target = targets ? `${targets.length} target${targets.length === 1 ? "" : "s"}${targets[0] ? ` · ${targets[0]}` : ""}` : typeof args?.target === "string" ? args.target : "missing target";
  const relation = typeof args?.relation === "string" ? args.relation : "missing relation";
  const to = typeof args?.to === "string" ? ` → ${args.to}` : "";
  const scope = typeof args?.scope === "string" ? ` in ${args.scope}` : "";
  return framedCall("trace", `${relation} · ${target}${to}${scope} · page ${args?.page ?? 1} · limit ${args?.limit ?? 5}`, theme, context);
}

export function renderTraceResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindResultCard(context);
  const validation = renderToolCallValidation(result, theme, context, "trace");
  if (validation) return validation;
  const expanded = isExpanded(options, context, theme);
  const text = textOf(result);
  const status = frameStatus(result, options, context, text);
  const width = frameWidth(options, context);
  const structured = structuredTracePreview(result, expanded, theme);
  if (structured) return framed([...callNormalizationLines(result, theme), ...structured.body], labelWithStatus(status, structured.summary, theme), status, theme, width, "trace");
  return renderNavigationResult("trace", result, options, theme, context, "trace");
}

export function renderDocsSearchCall(args: any, theme: ThemeLike, context: any = {}): any {
  const query = typeof args?.query === "string" ? JSON.stringify(args.query) : "query";
  const filters = [args?.path ? `path ${args.path}` : undefined, args?.glob ? `glob ${args.glob}` : undefined, args?.scope ? `scope ${args.scope}` : undefined].filter(Boolean).join(" · ");
  return framedCall("docs_search", `${query}${filters ? ` · ${filters}` : ""} · page ${args?.page ?? 1} · limit ${args?.limit ?? 5}`, theme, context);
}

export function renderDocsSearchResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindResultCard(context);
  const expanded = isExpanded(options, context, theme);
  const text = textOf(result);
  const status = frameStatus(result, options, context, text);
  const width = frameWidth(options, context);
  const presentation = result?.details?.presentation;
  if (status === "pending") {
    const filters = presentation?.filters ?? {};
    const body = [presentation?.query ? `Query: ${fg(theme, "toolOutput", JSON.stringify(presentation.query))}` : "", filters.path ? `Path: ${filters.path}` : "", filters.glob ? `Glob: ${filters.glob}` : ""].filter(Boolean);
     return framed(body, labelWithStatus("pending", "searching document sections", theme), "pending", theme, width, "docs_search");
  }
  const structured = structuredDocsSearchPreview(result, expanded, theme);
  if (structured) {
    const renderedStatus = structured.status ?? status;
    return framed(structured.body, labelWithStatus(renderedStatus, structured.summary, theme), renderedStatus, theme, width, "docs_search");
  }
  return renderNavigationResult("docs_search", result, options, theme, context, "docs_search");
}


export function renderDiffCall(args: any, theme: ThemeLike, context: any = {}): any {
  const view = typeof args?.view === "string" ? args.view : "summary";
  const target = args?.a && args?.b ? `${args.a} ↔ ${args.b}` : typeof args?.scope === "string" ? args.scope : typeof args?.root === "string" ? args.root : "working tree";
  const semantics = [args?.source ?? "uncommitted", args?.search ? `search ${args.search}` : "", args?.expand !== undefined ? `expand ${args.expand}` : ""].filter(Boolean).join(" · ");
  return framedCall("diff", `${view}: ${target} · ${semantics}`, theme, context);
}

function structuredDiffPreview(result: any, expanded: boolean, theme: ThemeLike): { body: string[]; label: string } | undefined {
  const native = result?.details?.native;
  const data = native?.data;
  if (!Array.isArray(data?.symbols) || !Array.isArray(data?.files)) return undefined;
  const changed = data.symbols.filter((symbol: any) => symbol?.change !== "unchanged");
  const contextual = data.symbols.filter((symbol: any) => symbol?.change === "unchanged");
  const rows = expanded ? [...changed, ...contextual] : changed.slice(0, 14);
  const body = rows.map((symbol: any) => {
    const location = symbol?.location ?? {};
    const range = `${location.path ?? "?"}:${location.start ?? "?"}-${location.end ?? location.start ?? "?"}`;
    const change = String(symbol?.change ?? "changed").replaceAll("_", " ");
    const color: ThemeColor = symbol?.change === "deleted" ? "error" : symbol?.change === "unchanged" ? "muted" : "accent";
    return `${fg(theme, color, change)} · ${fg(theme, "toolOutput", range)} · ${symbol?.name ?? location.label ?? "symbol"}`;
  });
  if (!body.length) body.push(...data.files.slice(0, expanded ? 30 : 14).map((file: any) => `${fg(theme, "accent", String(file?.change ?? "changed"))} · ${fg(theme, "toolOutput", file?.path ?? "?")}`));
  if (!expanded && changed.length > rows.length) body.push(`… ${changed.length - rows.length} more changed symbols hidden · Ctrl+U to show`);
  const completeness = native?.completeness;
  if (completeness?.complete === false) body.push(`… ${completeness.omitted ?? "some"} ${completeness.unit ?? "items"} omitted (${completeness.reason ?? "incomplete"})`);
  const total = Number(completeness?.total ?? data.files.length);
  return { body, label: `${total} ${total === 1 ? "file" : "files"} • ${changed.length} changed ${changed.length === 1 ? "symbol" : "symbols"}` };
}

function preparedDiffPreview(result: any, view: string, expanded: boolean, theme: ThemeLike): { body: string[]; label: string } | undefined {
  const prepared = result?.details?.prepared;
  if (!prepared || (view !== "impact" && view !== "review")) return undefined;
  const values = view === "impact" ? [prepared.impact] : [prepared.detect, prepared.context];
  const body: string[] = [];
  for (const value of values.filter(Boolean)) {
    const review = value?.review ?? value?.review_context ?? value?.context ?? value;
    const rows = value?.impacted_nodes ?? review?.impacted_nodes ?? value?.changed_functions ?? review?.changed_functions ?? value?.review_priorities ?? review?.review_priorities ?? [];
    for (const row of rows.slice(0, expanded ? 20 : 8)) {
      const path = row?.path ?? row?.file_path ?? row?.file ?? "?";
      const name = row?.name ?? row?.qualified_name ?? row?.label ?? "item";
      body.push(`${fg(theme, "accent", name)} · ${fg(theme, "toolOutput", path)}`);
    }
  }
  return body.length ? { body, label: view === "impact" ? "diff impact" : "diff review" } : undefined;
}

export function renderDiffResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindResultCard(context);
  const expanded = isExpanded(options, context, theme);
  const text = textOf(result);
  let status = frameStatus(result, options, context, text);
  const width = frameWidth(options, context);
  if (status === "pending") return framed([], labelWithStatus(status, "pending diff", theme), status, theme, width, "diff");
  if (status === "error") return framed(previewBody(text || "diff failed", expanded, 18), labelWithStatus(status, "diff failed", theme), status, theme, width, "diff");
  if (/^No changes\.?$/m.test(text.trim())) return framed([], labelWithStatus(status, "no changes", theme), status, theme, width, "diff");
  const view = String(context?.args?.view ?? "summary");
  const structured = view === "summary" || view === "structure" ? structuredDiffPreview(result, expanded, theme) : preparedDiffPreview(result, view, expanded, theme);
  if (structured) return framed(structured.body, labelWithStatus(status, structured.label, theme), status, theme, width, "diff");
  if (!looksLikePatchDiff(text)) {
    const label = semanticDiffLabel(text);
    return framed(previewBody(text, expanded, 24), labelWithStatus(status, label, theme), status, theme, width, "diff");
  }
  const rows = text.startsWith("Diff:") ? parseSimpleDiff(text) : parseUnifiedDiff(text);
  const stats = diffStats(rows);
  const body = rows.length ? renderDiffRows(rows, theme, expanded, width) : previewBody(text, expanded, 18);
  if (text.includes("[Output truncated")) {
    status = "partial";
    body.push("… output truncated; narrow scope or raise budget");
  }
  return framed(body, labelWithStatus(status, `diff +${stats.added} -${stats.removed}`, theme), status, theme, width, "diff");
}

function looksLikePatchDiff(text: string): boolean {
  return /^Diff:/m.test(text) || /^diff --git\b/m.test(text) || /^@@\s/m.test(text) || /^[-+]\d+:/m.test(text);
}

function semanticDiffLabel(text: string): string {
  if (/^Diff review\b|^Diff review —/m.test(text)) return "diff review";
  if (/^Diff impact\b/m.test(text)) return "diff impact";
  if (/^Structural diff\b/m.test(text)) return "diff structure";
  if (/^Diff summary\b/m.test(text)) return "diff summary";
  if (/^Read-only file comparison summary\b/m.test(text)) return "diff summary";
  return "diff evidence";
}
