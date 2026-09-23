/**
 * tooltap — keep Pi's initial tool surface lean while additional tools
 * remain available on demand.
 *
 * Goals:
 *  - let models enable useful additional tools without treating them as obscure
 *  - let the user decide what is always available, discoverable, exact-only, or excluded
 *  - let the user override how active tools are described in Pi's prompt
 *  - let the user override the compact `tools` control manifest description
 *
 * Settings live at ~/.pi/agent/tool.yaml. Legacy fallback remains
 * ~/.pi/agent/settings.json under "toolSearch".
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "node:crypto";
import { join } from "path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

type StringMap = Record<string, string>;
type StringArrayMap = Record<string, string[]>;

type ToolGroup = {
  description: string;
  tools: string[];
};

type GroupMap = Record<string, ToolGroup>;

type ToolPatch = {
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  manifestBlurb?: string;
};

type ToolPolicy = {
  /** Minimal full-schema tools available from session start. */
  core?: string[];
  /** Additional full-schema tools available from session start. */
  startup?: string[];
  /** Omit from catalogs while retaining provider-specific discovery/callability. */
  unlisted?: string[];
  /** Expose no individual metadata until explicit ##tool or #group activation. */
  explicitOnly?: string[];
  /** Remove from every model-facing and execution route. */
  excluded?: string[];
  /** Stable order for startup-visible tools; does not activate tools. */
  order?: string[];

  // Legacy aliases. blocked/neverEnable migrate safely to excluded.
  active?: string[];
  alwaysEnabled?: string[];
  defaultCoreTools?: string[];
  blocked?: string[];
  neverEnable?: string[];
  hidden?: string[];
  neverSuggest?: string[];
  noDiscover?: string[];
  neverInject?: string[];
  activeOrder?: string[];
};

type RoutingStrategy = "native" | "direct" | "proxy";
type ModelIdentity = { provider: string; api: string; id: string };

type ModelRoutePattern = {
  strategy: RoutingStrategy;
  raw: string;
  value: string;
  prefix: boolean;
  qualified: boolean;
};

type ResolvedRoute = {
  name: string;
  strategy: RoutingStrategy;
  configuredStrategy: RoutingStrategy;
  capabilityMatched: boolean;
  matchedPattern?: string;
  conflict?: string;
};

type CapabilityResolution =
  | { kind: "none"; suggestions: any[] }
  | { kind: "confident"; selected: any; suggestions: any[] }
  | { kind: "ambiguous"; suggestions: any[] };

interface UserConfig {
  active: string[];
  blocked: Set<string>;
  hidden: Set<string>;
  noDiscover: Set<string>;
  excluded: Set<string>;
  groups: GroupMap;
  activeOrder: string[];
  manifestBlurbs: StringMap;
  descriptions: StringMap;
  labels: StringMap;
  promptSnippets: StringMap;
  promptGuidelines: StringArrayMap;
  toolOverrides: Record<string, ToolPatch>;
  trustedDescriptionSources: Set<string>;
  controlLabel: string;
  controlPromptSnippet: string;
  controlIntro: string;
  proxyNormalize: boolean;
  routes: ModelRoutePattern[];
  routingWarnings: string[];
  showActiveToolsInManifest: boolean;
  showHiddenToolsInManifest: boolean;
  showFooterStatus: boolean;
  footerStatusId: string;
  notifyOnSessionStart: boolean;
  hashToolActivation: boolean;
  registerToolCommand: boolean;
  logPayloads: boolean;
  configHealthCheck: boolean;
}

const DEFAULT_CORE_TOOLS = ["write", "edit", "bash"];
const DEFAULT_CONTROL_INTRO = "Additional tools are available on demand. They are omitted initially only to keep the model's callable schema surface focused—not because they are unsafe or discouraged. Use this control whenever a useful capability may exist: request an exact tool, a configured group, or describe what you need.";
const DEFAULT_CONTROL_SNIPPET = "Enable additional tools whenever they fit the task; their schemas are omitted initially only to avoid carrying rarely needed context.";
const CONTROL_NAME = "tools";
const ENABLED_STATE_ENTRY = "tooltap-enabled-v1";
const ENABLED_STATE_ENTRY_V2 = "tooltap-enabled-v2";
const OWN_SOURCE_PATH = fileURLToPath(import.meta.url);

const UI_MAX_LINES = 30;
const UI_CONDENSED_LINES = 8;
const UI_EXTENDED_LINES = 120;
const JEITO_DENSITY_KEY = Symbol.for("pi.agent.jeitoDensity.v1");
const JEITO_DENSITY_STATE: { level: number } = (() => { const g = globalThis as any; return (g[JEITO_DENSITY_KEY] ??= { level: 1 }); })();
function currentDensity(): "ultra" | "condensed" | "normal" | "extended" { return (["ultra","condensed","normal","extended"] as const)[JEITO_DENSITY_STATE.level] ?? "condensed"; }
function cycleDensity(): "ultra" | "condensed" | "normal" | "extended" { JEITO_DENSITY_STATE.level = (JEITO_DENSITY_STATE.level + 1) % 4; return currentDensity(); }
export function resetDisplayDensityForTests(): void { JEITO_DENSITY_STATE.level = 0; }
const SEARCH_RESULT_LIMIT = 3;
const SEARCH_CONFIDENCE_RATIO = 1.8;
const SEARCH_MIN_CONFIDENT_SCORE = 1.5;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "another", "by", "call", "description", "enabled", "find", "for", "hidden",
  "load", "name", "need", "not", "of", "or", "please", "search", "the", "to", "tool", "tools", "use",
]);

const UI_RST = "\x1b[0m";
const UI_ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const UI_ANSI_AT_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/y;
const UI_TAB_STOP = 8;
const UI_TOOL_COLOR = "\x1b[38;2;180;190;254m";
const UI_THEME_COLORS: Record<string, string> = {
  toolTitle: "\x1b[38;2;205;214;244m",
  accent: "\x1b[38;2;137;220;235m",
  success: "\x1b[38;2;166;227;161m",
  warning: "\x1b[38;2;249;226;175m",
  error: "\x1b[38;2;243;139;168m",
  muted: "\x1b[38;2;166;173;200m",
};
const UI_BOLD = "\x1b[1m";

type ThemeLike = { fg?: (style: any, text: string) => string; bold?: (text: string) => string };

class TextBlock {
  text: string;
  constructor(text = "") { this.text = text; }
  setText(text: string) { this.text = text; }
  wantsLeadingSpacer() { return currentDensity() !== "ultra"; }
  invalidate() {}
  render(width?: number) { return capUi(this.text.split("\n").map(line => clampUi(line, width)), width); }
}

function normalizeUiWidth(width: unknown, fallback = 100): number {
  return typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width) : fallback;
}

function stripUiAnsi(text: string): string { return String(text ?? "").replace(UI_ANSI_RE, ""); }

function uiCharWidth(code: number): number {
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code === 0x200d || code === 0xfe0e || code === 0xfe0f) return 0;
  if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x1ab0 && code <= 0x1aff) || (code >= 0x1dc0 && code <= 0x1dff) || (code >= 0x20d0 && code <= 0x20ff) || (code >= 0xfe20 && code <= 0xfe2f)) return 0;
  if ((code >= 0x1100 && code <= 0x115f) || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff)) return 2;
  return 1;
}

function normalizeUiControls(text: unknown): string {
  let out = "";
  let column = 0;
  const input = String(text ?? "");
  for (let index = 0; index < input.length;) {
    UI_ANSI_AT_RE.lastIndex = index;
    const ansi = UI_ANSI_AT_RE.exec(input);
    if (ansi) { out += ansi[0]; index = UI_ANSI_AT_RE.lastIndex; continue; }
    const code = input.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(code);
    index += char.length;
    if (char === "\t") {
      const spaces = UI_TAB_STOP - (column % UI_TAB_STOP || 0);
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
    column += uiCharWidth(code);
  }
  return out;
}

function uiWidth(text: unknown): number {
  let width = 0;
  for (const ch of stripUiAnsi(normalizeUiControls(text))) width += uiCharWidth(ch.codePointAt(0) ?? 0);
  return width;
}

function truncateUiAnsi(text: unknown, width: number): string {
  if (width <= 1) return "…";
  let out = "";
  let used = 0;
  let sawAnsi = false;
  const input = normalizeUiControls(text);
  for (let index = 0; index < input.length;) {
    UI_ANSI_AT_RE.lastIndex = index;
    const ansi = UI_ANSI_AT_RE.exec(input);
    if (ansi) { out += ansi[0]; sawAnsi = true; index = UI_ANSI_AT_RE.lastIndex; continue; }
    const code = input.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(code);
    const next = uiCharWidth(code);
    if (used + next + 1 > width) break;
    out += char;
    used += next;
    index += char.length;
  }
  return `${out}${sawAnsi ? UI_RST : ""}…`;
}

function clampUi(text: unknown, width?: number): string {
  const w = normalizeUiWidth(width);
  const safe = normalizeUiControls(text);
  return uiWidth(safe) <= w ? safe : truncateUiAnsi(safe, w);
}

function capUi(lines: string[], width?: number, maxLines = UI_MAX_LINES, theme?: ThemeLike): string[] {
  if (lines.length <= maxLines) return lines;
  const bottom = lines[lines.length - 1] || "";
  const note = clampUi(`${toolColor("│")} ${themeFg(theme, "muted", `… UI truncated to ${maxLines} lines · Ctrl+U to show`)}`, width);
  return stripUiAnsi(bottom).startsWith("╰") ? [...lines.slice(0, maxLines - 2), note, bottom] : [...lines.slice(0, maxLines - 1), note];
}

function toolColor(text: string): string { return `${UI_TOOL_COLOR}${text}${UI_RST}`; }
function themeFg(theme: ThemeLike | undefined, style: string, text: string): string {
  if (theme?.fg) return theme.fg(style, text);
  const color = UI_THEME_COLORS[style];
  return color ? `${color}${text}${UI_RST}` : text;
}
function themeBold(theme: ThemeLike | undefined, text: string): string { return theme?.bold ? theme.bold(text) : `${UI_BOLD}${text}${UI_RST}`; }
function ultraHierarchyLine(head: string, target: string, metric: string, theme: ThemeLike | undefined, width: number): string {
  const available = Math.max(0, width - uiWidth(head));
  let targetBudget = target ? Math.max(0, available - 1) : 0;
  if (target && metric) {
    const metricReserve = Math.min(24, Math.max(8, Math.floor(available * 0.38)));
    targetBudget = Math.max(0, available - metricReserve - 4);
  }
  const targetText = targetBudget > 0 ? (uiWidth(target) <= targetBudget ? normalizeUiControls(target) : truncateUiAnsi(target, targetBudget)) : "";
  const targetPart = targetText ? ` ${themeFg(theme, "accent", targetText)}` : "";
  const metricBudget = metric ? Math.max(0, width - uiWidth(head) - uiWidth(targetPart) - 3) : 0;
  const metricText = metricBudget > 0 ? (uiWidth(metric) <= metricBudget ? normalizeUiControls(metric) : truncateUiAnsi(metric, metricBudget)) : "";
  const metricPart = metricText ? `${themeFg(theme, "muted", " · ")}${themeFg(theme, "muted", metricText)}` : "";
  return clampUi(`${head}${targetPart}${metricPart}`, width);
}
function widthOf(options: any, context: any): number { return normalizeUiWidth(context?.width ?? options?.width, 100); }
function textOf(result: any): string { return result?.content?.filter((x: any) => x?.type === "text").map((x: any) => x.text || "").join("\n") || ""; }

function frameTop(title: string, width = 100): string {
  const t = clampUi(title, Math.max(1, width - 6));
  return `${toolColor("╭──")} ${t} ${toolColor("─".repeat(Math.max(1, width - uiWidth(t) - 5)))}`;
}

function frameBottom(label: string, width = 100): string {
  const t = clampUi(label, Math.max(1, width - 6));
  return `${toolColor("╰──")} ${t} ${toolColor("─".repeat(Math.max(1, width - uiWidth(t) - 5)))}`;
}

class StowDensityBlock {
  body: string[]; label: string; width: number; theme: ThemeLike | undefined;
  constructor(body: string[], label: string, width: number, theme?: ThemeLike) { this.body = body; this.label = label; this.width = width; this.theme = theme; }
  setText(text: string) { this.body = text.split("\n"); }
  wantsLeadingSpacer() { return currentDensity() !== "ultra"; }
  invalidate() {}
  render(width?: number) {
    const w = normalizeUiWidth(width ?? this.width, 100);
    const density = currentDensity();
    if (density === "ultra") return [frameBottom(this.label, w)];
    const effectiveMax = density === "extended" ? UI_EXTENDED_LINES : density === "condensed" ? UI_CONDENSED_LINES : UI_MAX_LINES;
    const maxBody = effectiveMax - 1;
    const shown = this.body.length > maxBody ? [...this.body.slice(0, maxBody - 1), themeFg(this.theme, "muted", `… ${this.body.length - maxBody + 1} more lines hidden · Ctrl+U to show`)] : this.body;
    const rail = toolColor("│");
    return [...shown.map(line => `${rail} ${clampUi(line, Math.max(1, w - 2))}`), frameBottom(this.label, w)].join("\n").split("\n").map(l => clampUi(l, w));
  }
}
let activeStowCard: StowUnifiedBlock | undefined;
function bindStowResultCard(ctx: any) { activeStowCard = ctx?.state?.card instanceof StowUnifiedBlock ? ctx.state.card : undefined; }
function ensureStowCard(ctx: any, width: number, title: string, theme?: ThemeLike): StowUnifiedBlock | undefined {
  const state = ctx?.state;
  if (!state || typeof state !== "object") return undefined;
  if (!(state as any).card || !((state as any).card instanceof StowUnifiedBlock)) {
    (state as any).card = new StowUnifiedBlock(width, title, theme);
  } else {
    (state as any).card.refreshCall(title, width, theme);
  }
  return (state as any).card as StowUnifiedBlock;
}
class StowUnifiedBlock {
  width: number; title: string; theme: ThemeLike | undefined; block: StowDensityBlock | undefined;
  constructor(width: number, title: string, theme?: ThemeLike) { this.width = width; this.title = title; this.theme = theme; }
  refreshCall(title: string, width: number, theme?: ThemeLike) { this.title = title; this.width = width; this.theme = theme ?? this.theme; }
  wantsLeadingSpacer() { return currentDensity() !== "ultra"; }
  receiveBlock(block: StowDensityBlock) { this.block = block; }
  setText() {}
  invalidate() {}
  render(width?: number) {
    const w = normalizeUiWidth(width ?? this.width, 100);
    const density = currentDensity();
    const block: any = this.block;
    const plainTitle = stripUiAnsi(this.title).replace(/\s+/g, " ").trim();
    const start = plainTitle.indexOf(CONTROL_NAME);
    const detail = start < 0 ? "" : plainTitle.slice(start + CONTROL_NAME.length).trim();
    const ultraTool = themeFg(this.theme, "toolTitle", themeBold(this.theme, CONTROL_NAME));
    if (!block) {
      if (density === "ultra") return [ultraHierarchyLine(`${themeFg(this.theme, "warning", "…")} ${ultraTool}`, detail, "", this.theme, w)];
      const max = density === "condensed" ? UI_CONDENSED_LINES : density === "extended" ? UI_EXTENDED_LINES : UI_MAX_LINES;
      return capUi([frameTop(this.title, w), frameBottom(`${themeFg(this.theme, "warning", "…")} pending ${CONTROL_NAME}`, w)].map(line => clampUi(line, w)), w, max, this.theme);
    }
    if (density === "ultra") {
      const plain = stripUiAnsi(block.label);
      const glyph = plain.match(/^[✓✗…◐⚠]/)?.[0] || "✓";
      const style = glyph === "✗" ? "error" : glyph === "✓" ? "success" : "warning";
      let plainLabel = plain.replace(/^[✓✗…◐⚠]\s*/, "").trim();
      if (plainLabel === CONTROL_NAME) plainLabel = "";
      else if (plainLabel.startsWith(`${CONTROL_NAME} `)) plainLabel = plainLabel.slice(CONTROL_NAME.length + 1).trim();
      plainLabel = plainLabel.replace(/^[\s·•—-]+/u, "");
      const target = detail && !plainLabel.includes(detail) ? detail : "";
      const head = `${themeFg(this.theme, style, glyph)} ${ultraTool}`;
      return [ultraHierarchyLine(head, target, plainLabel, this.theme, w)];
    }
    const top = frameTop(this.title, w);
    const body: string[] = block?.render?.(w) ?? [];
    const max = density === "condensed" ? UI_CONDENSED_LINES : density === "extended" ? UI_EXTENDED_LINES : UI_MAX_LINES;
    return capUi([top, ...(Array.isArray(body) ? body : [])].join("\n").split("\n").map(line => clampUi(line, w)), w, max, this.theme);
  }
}
function frame(body: string[], label: string, width = 100, theme?: ThemeLike): StowDensityBlock {
  const _prev = activeStowCard;
  const block = new StowDensityBlock(body, label, width, theme);
  if (_prev) { _prev.receiveBlock(block); return { render: () => [], invalidate() {}, wantsLeadingSpacer() { return _prev.wantsLeadingSpacer(); } } as any; }
  return block;
}

function statusIcon(style: "success" | "warning" | "error", theme?: ThemeLike): string {
  const icon = style === "success" ? "✓" : style === "warning" ? "⚠" : "✗";
  return themeFg(theme, style, icon);
}

function truncateSelector(selector: string): string {
  return selector.length > 60 ? `${selector.slice(0, 57)}…` : selector;
}

export function renderToolsCall(args: any, theme?: ThemeLike, context: any = {}): any {
  const request = typeof args?.request === "string" ? args.request.trim() : "";
  const executing = args && typeof args === "object" && args.arguments !== undefined;
  const detail = !request ? "request" : executing ? `execute ${truncateSelector(request)}` : `enable ${truncateSelector(request)}`;
  const title = `${themeFg(theme, "toolTitle", themeBold(theme, CONTROL_NAME))} ${themeFg(theme, "accent", detail)}`;
  const w = widthOf(undefined, context);
  const card = ensureStowCard(context, w, title, theme);
  if (card) return card as any;
  return new TextBlock(frameTop(title, w));
}

export function renderToolsResult(result: any, options: any, theme?: ThemeLike, context: any = {}): any {
  bindStowResultCard(context);
  const details = result?.details ?? {};
  const executed = typeof details.executedTool === "string" ? details.executedTool : "";
  const enabled = Array.isArray(details.enabled) ? details.enabled : [];
  const failed = Array.isArray(details.activationFailed) ? details.activationFailed : [];
  const already = Array.isArray(details.alreadyActive) ? details.alreadyActive : [];
  const blocked = Array.isArray(details.blocked) ? details.blocked : [];
  const unknown = Array.isArray(details.unknown) ? details.unknown : [];
  const body = textOf(result).split("\n").filter(Boolean);
  if (!body.length) body.push(executed ? "Execution completed." : "Nothing changed.");
  if (executed) {
    return frame(body, `${statusIcon("success", theme)} ${CONTROL_NAME} → ${executed}`, widthOf(options, context), theme);
  }
  const style = failed.length ? "error" : blocked.length || unknown.length ? "warning" : "success";
  const label = `${statusIcon(style, theme)} ${CONTROL_NAME}${enabled.length ? ` +${enabled.length}` : ""}${failed.length ? ` • ${failed.length} failed` : ""}${already.length ? ` • ${already.length} active` : ""}${blocked.length || unknown.length ? " • warnings" : ""}`;
  return frame(body, label, widthOf(options, context), theme);
}


function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.trim().length > 0))];
}

function normalizeSelector(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? uniq(value) : [];
}

function strMap(value: unknown): StringMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: StringMap = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function strArrayMap(value: unknown): StringArrayMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: StringArrayMap = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const arr = strArray(v);
    if (arr.length) out[k] = arr;
  }
  return out;
}

function toolPatchMap(value: unknown): Record<string, ToolPatch> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, ToolPatch> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const patch: ToolPatch = {};
    if (typeof r.label === "string") patch.label = r.label;
    if (typeof r.description === "string") patch.description = r.description;
    if (typeof r.promptSnippet === "string") patch.promptSnippet = r.promptSnippet;
    const guidelines = strArray(r.promptGuidelines);
    if (guidelines.length) patch.promptGuidelines = guidelines;
    if (typeof r.manifestBlurb === "string") patch.manifestBlurb = r.manifestBlurb;
    if (Object.keys(patch).length) out[name] = patch;
  }
  return out;
}

function groupMap(value: unknown): GroupMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: GroupMap = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const tools = strArray(record.tools);
    if (!tools.length) continue;
    out[name] = {
      description: typeof record.description === "string" ? record.description.trim() : "",
      tools,
    };
  }
  return out;
}

function requirementRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function parseModelRoutes(value: unknown): { routes: ModelRoutePattern[]; warnings: string[] } {
  const record = requirementRecord(value);
  const routes: ModelRoutePattern[] = [];
  const warnings: string[] = [];
  const supported = new Set(["native", "direct", "proxy"]);
  for (const key of Object.keys(record)) {
    if (!supported.has(key)) warnings.push(`routing.${key} is ignored; use only native, direct, or proxy model groups`);
  }
  for (const strategy of ["native", "direct", "proxy"] as const) {
    const rawGroup = record[strategy];
    const entries = typeof rawGroup === "string" ? [rawGroup] : strArray(rawGroup);
    if (rawGroup !== undefined && typeof rawGroup !== "string" && !Array.isArray(rawGroup)) {
      warnings.push(`routing.${strategy} must be a model-name list`);
    }
    for (const entry of entries) {
      const raw = entry.trim();
      const prefix = raw.endsWith("^");
      const normalized = (prefix ? raw.slice(0, -1) : raw).trim().toLowerCase();
      if (!normalized || normalized.includes("^")) {
        warnings.push(`routing.${strategy} contains invalid model pattern ${JSON.stringify(raw)}`);
        continue;
      }
      routes.push({ strategy, raw, value: normalized, prefix, qualified: normalized.includes("/") });
    }
  }
  return { routes, warnings };
}


function readRawConfig(override?: Record<string, unknown>): Record<string, unknown> {
  if (override && typeof override === "object" && !Array.isArray(override)) return override;
  const agentDir = getAgentDir();
  const yamlPath = join(agentDir, "tool.yaml");
  if (existsSync(yamlPath)) {
    const parsed = parseYaml(readFileSync(yamlPath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  }

  const settingsPath = join(agentDir, "settings.json");
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw)?.toolSearch;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  return {};
}

function readUserConfig(overrides?: Record<string, unknown>): UserConfig {
  try {
    const s = readRawConfig(overrides);
    const policy: ToolPolicy = typeof s.policy === "object" && s.policy ? s.policy as ToolPolicy : s as ToolPolicy;

    const core = Array.isArray(policy.core)
      ? strArray(policy.core)
      : Array.isArray(policy.defaultCoreTools) ? strArray(policy.defaultCoreTools) : DEFAULT_CORE_TOOLS;
    const startup = Array.isArray(policy.startup)
      ? strArray(policy.startup)
      : strArray(policy.alwaysEnabled ?? s.alwaysEnabled);
    const legacyActive = strArray(policy.active);
    const active = uniq([...core, ...startup, ...legacyActive]);

    const excluded = new Set(uniq([
      ...strArray(policy.excluded),
      ...strArray(policy.neverInject),
      // The removed blocked state is migrated fail-closed: legacy entries
      // become fully excluded rather than unexpectedly executable.
      ...strArray(policy.blocked),
      ...strArray(policy.neverEnable),
    ]));
    const hidden = new Set(uniq([
      ...(Array.isArray(policy.unlisted) ? strArray(policy.unlisted) : strArray(policy.hidden ?? policy.neverSuggest)),
      ...excluded,
    ]));
    const noDiscover = new Set(uniq([
      ...(Array.isArray(policy.explicitOnly) ? strArray(policy.explicitOnly) : strArray(policy.noDiscover)),
      ...excluded,
    ]));
    const blocked = new Set(excluded);

    const toolOverrides = toolPatchMap(s.toolOverrides);
    const descriptions = { ...strMap(s.descriptions) };
    const labels = { ...strMap(s.labels) };
    const promptSnippets = { ...strMap(s.promptSnippets) };
    const promptGuidelines = { ...strArrayMap(s.promptGuidelines) };
    const manifestBlurbs = { ...strMap(s.manifestBlurbs) };
    for (const [name, patch] of Object.entries(toolOverrides)) {
      if (patch.label !== undefined) labels[name] = patch.label;
      if (patch.description !== undefined) descriptions[name] = patch.description;
      if (patch.promptSnippet !== undefined) promptSnippets[name] = patch.promptSnippet;
      if (patch.promptGuidelines !== undefined) promptGuidelines[name] = patch.promptGuidelines;
      if (patch.manifestBlurb !== undefined) manifestBlurbs[name] = patch.manifestBlurb;
    }
    const routing = parseModelRoutes(s.routing);

    return {
      active,
      blocked,
      hidden,
      noDiscover,
      excluded,
      groups: groupMap(s.groups),
      activeOrder: Array.isArray(policy.order) ? strArray(policy.order) : strArray(policy.activeOrder),
      manifestBlurbs,
      descriptions,
      labels,
      promptSnippets,
      promptGuidelines,
      toolOverrides,
      trustedDescriptionSources: new Set(strArray(s.trustedDescriptionSources)),
      controlLabel: typeof s.label === "string" ? s.label : "Tools",
      controlPromptSnippet: typeof s.promptSnippet === "string" ? s.promptSnippet : DEFAULT_CONTROL_SNIPPET,
      controlIntro: typeof s.intro === "string" ? s.intro : DEFAULT_CONTROL_INTRO,
      proxyNormalize: s.proxyNormalize === true,
      routes: routing.routes,
      routingWarnings: routing.warnings,
      showActiveToolsInManifest: s.showActiveToolsInManifest !== false,
      showHiddenToolsInManifest: s.showHiddenToolsInManifest !== false,
      showFooterStatus: s.showToolSearchFooterStatus !== false && s.showFooterStatus !== false && s.showStatus !== false,
      footerStatusId: typeof s.footerStatusId === "string" ? s.footerStatusId : "tool-search",
      notifyOnSessionStart: s.notifyOnSessionStart !== false,
      hashToolActivation: s.hashToolActivation !== false,
      registerToolCommand: s.registerToolCommand !== false,
      logPayloads: s.logPayloads === true,
      configHealthCheck: s.configHealthCheck !== false,
    };
  } catch {}
  return {
    active: [...DEFAULT_CORE_TOOLS],
    blocked: new Set(),
    hidden: new Set(),
    noDiscover: new Set(),
    excluded: new Set(),
    groups: {},
    activeOrder: [],
    manifestBlurbs: {},
    descriptions: {},
    labels: {},
    promptSnippets: {},
    promptGuidelines: {},
    toolOverrides: {},
    trustedDescriptionSources: new Set(),
    controlLabel: "Tools",
    controlPromptSnippet: DEFAULT_CONTROL_SNIPPET,
    controlIntro: DEFAULT_CONTROL_INTRO,
    proxyNormalize: false,
    routes: [],
    routingWarnings: [],
    showActiveToolsInManifest: true,
    showHiddenToolsInManifest: true,
    showFooterStatus: true,
    footerStatusId: "tool-search",
    notifyOnSessionStart: true,
    hashToolActivation: true,
    registerToolCommand: true,
    logPayloads: false,
    configHealthCheck: true,
};
}
function modelRouteMatch(pattern: ModelRoutePattern, model: any): boolean {
  const provider = String(model?.provider ?? "").toLowerCase();
  const id = String(model?.id ?? "").toLowerCase();
  const basename = id.split("/").pop() ?? id;
  const values = pattern.qualified
    ? uniq([id, provider && `${provider}/${basename}`, provider && `${provider}/${id}`].filter(Boolean))
    : [basename];
  return values.some(value => pattern.prefix ? value.startsWith(pattern.value) : value === pattern.value);
}

function routeSpecificity(pattern: ModelRoutePattern): number {
  return (pattern.qualified ? 1_000_000 : 0) + (pattern.prefix ? 0 : 100_000) + pattern.value.length;
}

function configuredModelRoute(routes: ModelRoutePattern[], model: any): { pattern?: ModelRoutePattern; conflict?: string } {
  const matches = routes.filter(route => modelRouteMatch(route, model));
  if (!matches.length) return {};
  const topScore = Math.max(...matches.map(routeSpecificity));
  const top = matches.filter(pattern => routeSpecificity(pattern) === topScore);
  const strategies = uniq(top.map(pattern => pattern.strategy));
  if (strategies.length > 1) {
    return { conflict: top.map(pattern => `${pattern.strategy}:${pattern.raw}`).join(", ") };
  }
  return { pattern: top[0] };
}

function modelSupportsNativeDeferred(model: any): boolean {
  const compat = model?.compat;
  return compat?.supportsAdditionalTools === true
    || compat?.supportsToolSearch === true
    || (typeof compat?.deferredToolsMode === "string" && compat.deferredToolsMode.length > 0);
}

function modelIdentityOf(model: any): ModelIdentity | null {
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  const api = typeof model?.api === "string" ? model.api.trim() : "";
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  if (!provider || !api || !id) return null;
  return { provider, api, id };
}

function sameModelIdentity(left: ModelIdentity | null, right: ModelIdentity | null): boolean {
  if (!left || !right) return false;
  return left.provider === right.provider && left.api === right.api && left.id === right.id;
}
function firstSentence(text: string | undefined): string {
  return (text ?? "").split(/[.\n]/)[0].trim().slice(0, 80);
}

type AutocompleteItemLike = { value: string; label?: string; detail?: string; _stowGroup?: boolean; _stowEnabled?: boolean };
type AutocompleteResultLike = { items: AutocompleteItemLike[]; prefix: string };
type AutocompleteProviderLike = {
  getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: unknown): Promise<AutocompleteResultLike | null> | AutocompleteResultLike | null;
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItemLike, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?: (lines: string[], cursorLine: number, cursorCol: number) => boolean;
  getForceFileSuggestions?: (lines: string[], cursorLine: number, cursorCol: number) => AutocompleteResultLike | null;
};

const HASH_TOOL_PREFIX_PATTERN = /(?:^|[\s])(##[A-Za-z0-9_.:-]*|#group[:/][A-Za-z0-9_.:-]*|#tool[:/][A-Za-z0-9_.:-]*|#[A-Za-z0-9_.:-]*)$/;

function getHashToolPrefix(textBeforeCursor: string): string | undefined {
  return textBeforeCursor.match(HASH_TOOL_PREFIX_PATTERN)?.[1];
}

function applyHashToolCompletion(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: AutocompleteItemLike,
  prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const currentLine = lines[cursorLine] ?? "";
  const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
  const afterCursor = currentLine.slice(cursorCol);
  const newText = item._stowGroup
    ? `#${item.value} `
    : prefix.startsWith("##") ? `##${item.value} ` : `#tool:${item.value} `;
  const newLines = [...lines];
  newLines[cursorLine] = `${beforePrefix}${newText}${afterCursor}`;
  return { lines: newLines, cursorLine, cursorCol: beforePrefix.length + newText.length };
}

function orderHashDiscoveryItems(items: AutocompleteItemLike[]): AutocompleteItemLike[] {
  return [...items].sort((left, right) =>
    Number(Boolean(left._stowEnabled)) - Number(Boolean(right._stowEnabled))
    || Number(!left._stowGroup) - Number(!right._stowGroup)
    || left.value.localeCompare(right.value));
}

function wrapAutocompleteProviderWithHashToolSupport(
  provider: AutocompleteProviderLike,
  getGroups: () => GroupMap = () => ({}),
  getEnabledNames: () => Set<string> = () => new Set(),
): AutocompleteProviderLike {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      const hashPrefix = getHashToolPrefix(textBeforeCursor);
      if (!hashPrefix) return provider.getSuggestions(lines, cursorLine, cursorCol, options);

      const groupMode = hashPrefix.startsWith("#group:") || hashPrefix.startsWith("#group/");
      const toolMode = hashPrefix.startsWith("##") || hashPrefix.startsWith("#tool:") || hashPrefix.startsWith("#tool/");
      const raw = hashPrefix.replace(/^##/, "").replace(/^#group[:/]?/, "").replace(/^#tool[:/]?/, "").replace(/^#/, "").toLowerCase();
      const enabledNames = getEnabledNames();
      const groupItems = Object.entries(getGroups())
        .filter(([name]) => name.toLowerCase().includes(raw))
        .map(([name, group]) => {
          const enabled = group.tools.length > 0 && group.tools.every(tool => enabledNames.has(tool));
          return { value: name, label: `#${name}`, detail: `${enabled ? "Enabled" : "Not enabled"} · ${group.description}`, _stowGroup: true, _stowEnabled: enabled };
        });
      if (groupMode) return groupItems.length ? { items: orderHashDiscoveryItems(groupItems), prefix: hashPrefix } : null;
      const syntheticPrefix = `/tool ${raw}`;
      const suggestions = await provider.getSuggestions([syntheticPrefix], 0, syntheticPrefix.length, options);
      const toolItems = (suggestions?.items ?? []).map(item => ({ ...item, _stowEnabled: enabledNames.has(item.value) }));
      const items = orderHashDiscoveryItems(toolMode ? toolItems : [...groupItems, ...toolItems]);
      return items.length ? { items, prefix: hashPrefix } : null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (prefix.startsWith("#")) return applyHashToolCompletion(lines, cursorLine, cursorCol, item, prefix);
      return provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      if (getHashToolPrefix(textBeforeCursor)) return true;
      return provider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
    getForceFileSuggestions(lines, cursorLine, cursorCol) {
      return provider.getForceFileSuggestions?.(lines, cursorLine, cursorCol) ?? null;
    },
  };
}

export default function toolSearchExtension(pi: ExtensionAPI, options?: { userConfigOverride?: Record<string, unknown> }) {
  type ManifestTool = { name: string; blurb: string; curated: boolean; active: boolean; hidden: boolean; noDiscover: boolean; blocked: boolean };

  let manifest: ManifestTool[] = [];
  const unlocked = new Set<string>();
  const nativeEnabled = new Set<string>();
  const dispatchEnabled = new Set<string>();
  const proxyEnabled = new Set<string>();
  const epochBaseline = new Set<string>();
  const epochLate = new Set<string>();
  let epochIdentity: ModelIdentity | null = null;
  let restoredEpochMode: "v2-same" | "v2-rebased" | "conservative" | "none" = "none";
  let restoredEpochIssue: string | null = null;
  let config = readUserConfig(options?.userConfigOverride);
  let currentRoute: ResolvedRoute = {
    name: "default",
    strategy: "proxy",
    configuredStrategy: "proxy",
    capabilityMatched: true,
  };
  let frozenConfigHash = "";
  let toolCommandRegistered = false;
  let currentProviderSessionIdHash: string | null = null;
  let registeredControl = false;
  let controlDeclarationKey: string | null = null;
  let ownedControlExecute: Function | undefined;
  let controlRegistrationConflict = false;
  const staleContracts = new Set<string>();
  const ownedControlNames = new Set<string>();
  const quarantinedTools = new Set<string>();
  const selectorOwners = new Map<string, { kind: "tool" | "group"; name: string }>();
  let startupNamespaceConflicts: string[] = [];
  const notifiedNamespaceConflicts = new Set<string>();
  const notifiedQuarantinedTools = new Set<string>();
  let latestProviderSnapshot: {
    capturedAt: string;
    model: string;
    provider: string;
    api: string;
    strategy: string;
    inputAudit: ProviderAudit;
    outputAudit: ProviderAudit;
    payload: unknown;
  } | null = null;
  type ProviderAudit = {
    bodyWithoutInputHash: string;
    instructionsHash: string | null;
    toolsHash: string | null;
    promptCacheKeyHash: string | null;
    reasoningHash: string | null;
    toolCount: number | null;
  };

  function runtimeSupports(strategy: RoutingStrategy): boolean {
    if (strategy === "direct") return typeof (pi as any).getDispatchTools === "function" && typeof (pi as any).setDispatchTools === "function";
    if (strategy === "proxy") return typeof (pi as any).getRegisteredTool === "function";
    return typeof (pi as any).setActiveToolsWithDeferred === "function"
      && typeof (pi as any).getRegisteredTool === "function";
  }

  function resolveRoute(model: any): ResolvedRoute {
    const configured = configuredModelRoute(config.routes, model);
    const requested = configured.conflict ? "proxy" : configured.pattern?.strategy ?? "proxy";
    const capabilityMatched = runtimeSupports(requested)
      && (requested !== "native" || modelSupportsNativeDeferred(model));
    const strategy = capabilityMatched ? requested : "proxy";
    return {
      name: configured.pattern ? `${configured.pattern.strategy}:${configured.pattern.raw}` : "default",
      configuredStrategy: requested,
      strategy,
      capabilityMatched,
      matchedPattern: configured.pattern?.raw,
      conflict: configured.conflict,
    };
  }

  function projectLateToRoute(): void {
    nativeEnabled.clear();
    dispatchEnabled.clear();
    proxyEnabled.clear();
    const target = currentRoute.strategy === "native" ? nativeEnabled : currentRoute.strategy === "direct" ? dispatchEnabled : proxyEnabled;
    for (const name of epochLate) target.add(name);
  }

  function isEligibleUnlockName(name: string): boolean {
    if (name === CONTROL_NAME || ownedControlNames.has(name)) return false;
    const known = pi.getAllTools().some((tool: any) => tool.name === name);
    return known && !quarantinedTools.has(name) && !config.excluded.has(name);
  }

  function eligiblePersistedNames(values: unknown): string[] {
    return strArray(values).filter(isEligibleUnlockName);
  }

  function epochSplit(names: string[]): { baseline: string[]; late: string[] } {
    return {
      baseline: names.filter(name => epochBaseline.has(name)),
      late: names.filter(name => epochLate.has(name)),
    };
  }

  /** A genuine provider/api/model identity change opens a new model epoch:
   *  every currently eligible unlocked tool freezes into the ordinary
   *  baseline for the whole epoch, and late-binding restarts empty. */
  function beginModelEpoch(identity: ModelIdentity): void {
    epochIdentity = identity;
    epochBaseline.clear();
    epochLate.clear();
    staleContracts.clear();
    for (const name of unlocked) if (isEligibleUnlockName(name)) epochBaseline.add(name);
    projectLateToRoute();
    persistEnabledState();
    logDiagnostic("model_epoch_begin", {
      provider: identity.provider,
      api: identity.api,
      model: identity.id,
      baseline: [...epochBaseline],
    });
  }

  /** Classify unlocked names recovered by restore. A same-model resume keeps
   *  the stored disjoint classification and files unclassified leftovers as
   *  late; a stored identity that differs rebases everything into the
   *  baseline. Underdetermined (legacy/unknown-identity) state stays
   *  conservative: everything late until the next genuine switch. */
  function finalizeRestoredEpoch(ctx: any, contextRestoredCount: number): void {
    for (const name of [...unlocked]) {
      if (epochBaseline.has(name) || epochLate.has(name)) continue;
      if (restoredEpochMode === "v2-rebased") epochBaseline.add(name);
      else {
        epochLate.add(name);
        staleContracts.add(name);
      }
    }
    for (const name of [...unlocked]) {
      if (isEligibleUnlockName(name)) continue;
      unlocked.delete(name);
      epochBaseline.delete(name);
      epochLate.delete(name);
      staleContracts.delete(name);
    }
    const total = unlocked.size;
    if (restoredEpochMode === "conservative") {
      persistEnabledState();
      const issue = restoredEpochIssue ?? "underdetermined enabled state";
      const kind = issue.startsWith("malformed") ? "warning" : "info";
      ctx?.ui?.notify?.(`tooltap: ${issue} migrated conservatively to model-epoch v2; ${total} tool(s) restored as late-bound until the next model switch`, kind);
      return;
    }
    if (!total) {
      restoredEpochMode = "none";
      return;
    }
    if (restoredEpochMode === "v2-rebased") {
      persistEnabledState();
      ctx?.ui?.notify?.(`tooltap: model changed since the stored epoch; ${total} enabled tool(s) promoted into the ordinary baseline for this epoch`, "info");
    } else if (restoredEpochMode === "v2-same" && contextRestoredCount > 0) {
      persistEnabledState();
    }
  }

  function selectModelRoute(model: any): void {
    currentRoute = resolveRoute(model ?? {});
    projectLateToRoute();
  }

  function selectRoute(ctx: any): void {
    selectModelRoute(ctx?.model);
  }

  function notifyRouteResolution(ctx: any): void {
    if (currentRoute.conflict) {
      ctx.ui.notify(`tooltap: conflicting routing groups at equal specificity (${currentRoute.conflict}); using proxy`, "error");
    } else if (currentRoute.strategy === "proxy" && !runtimeSupports("proxy")) {
      // The default proxy route silently absorbs a missing capability, so a
      // Pi upgrade that drops the additive API would otherwise surface only
      // as "Registered tool … unavailable for execution" on later wrapper
      // calls. Name the cause and the remedy at startup instead.
      const patchScript = new URL("../patches/ensure-pi-registered-tool-api.mjs", import.meta.url).pathname;
      ctx.ui.notify(`tooltap: runtime lacks pi.getRegisteredTool — enabled gateway-late tools can be enabled but never executed. Run: node ${patchScript}`, "error");
    } else if (!currentRoute.capabilityMatched && currentRoute.configuredStrategy !== currentRoute.strategy) {
      const missingRuntime = currentRoute.configuredStrategy === "native" && !runtimeSupports("native")
        ? " (native requires cache-safe pi.setActiveToolsWithDeferred and pi.getRegisteredTool)" : "";
      ctx.ui.notify(`tooltap: route ${currentRoute.name} requires unavailable capabilities${missingRuntime}; using ${currentRoute.strategy}`, "warning");
    }
  }

  function hashValue(value: unknown): string {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return createHash("sha256").update(text ?? "undefined").digest("hex").slice(0, 16);
  }

  function stripProviderInputFields(payload: unknown): Record<string, any> | undefined {
    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, any> : undefined;
    if (!record) return undefined;
    const { input: _input, previous_response_id: _previousResponseId, ...withoutInput } = record;
    return structuredClone(withoutInput);
  }

  function providerAudit(payload: unknown): ProviderAudit {
    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, any> : {};
    const withoutInput = stripProviderInputFields(record) ?? {};
    const promptCacheKey = typeof record.prompt_cache_key === "string"
      ? record.prompt_cache_key
      : typeof record.promptCacheKey === "string" ? record.promptCacheKey : undefined;
    return {
      bodyWithoutInputHash: hashValue(withoutInput),
      instructionsHash: typeof record.instructions === "string" ? hashValue(record.instructions) : null,
      toolsHash: Array.isArray(record.tools) ? hashValue(record.tools) : null,
      promptCacheKeyHash: promptCacheKey ? hashValue(promptCacheKey) : null,
      reasoningHash: record.reasoning === undefined ? null : hashValue(record.reasoning),
      toolCount: Array.isArray(record.tools) ? record.tools.length : null,
    };
  }

  function cloneForDiagnostic(value: unknown): unknown {
    try { return structuredClone(value); } catch {}
    try { return JSON.parse(JSON.stringify(value)); } catch {}
    return { unavailable: "Payload could not be cloned for diagnostics." };
  }

  function rememberProviderSnapshot(input: unknown, output: unknown, ctx?: any): void {
    latestProviderSnapshot = {
      capturedAt: new Date().toISOString(),
      model: String((output as any)?.model ?? (input as any)?.model ?? ctx?.model?.id ?? ""),
      provider: String(ctx?.model?.provider ?? ""),
      api: String(ctx?.model?.api ?? ""),
      strategy: currentRoute.strategy,
      inputAudit: providerAudit(input),
      outputAudit: providerAudit(output),
      payload: cloneForDiagnostic(output),
    };
  }


  function sourceDescriptionIsTrusted(tool: any): boolean {
    const source = typeof tool?.sourceInfo?.source === "string" ? tool.sourceInfo.source.trim() : "";
    return Boolean(source) && config.trustedDescriptionSources.has(source);
  }

  function discoveryMetadata(tool: any): { blurb: string; curated: boolean } {
    const configured = config.manifestBlurbs[tool.name]?.trim();
    if (configured) return { blurb: configured, curated: true };
    const description = String(config.descriptions[tool.name] ?? tool.description ?? "").trim();
    const sourceOwned = sourceDescriptionIsTrusted(tool);
    return { blurb: sourceOwned ? description : firstSentence(description), curated: sourceOwned };
  }

  function buildManifest() {
    refreshLateRegisteredTools();
    const activeNames = new Set(pi.getActiveTools());
    const all = pi.getAllTools().filter(t => t.name !== CONTROL_NAME && !ownedControlNames.has(t.name) && !quarantinedTools.has(t.name) && !config.excluded.has(t.name));
    manifest = all.map(t => {
      const noDiscover = config.noDiscover.has(t.name);
      const hidden = noDiscover || config.hidden.has(t.name);
      const blocked = config.blocked.has(t.name);
      const discovery = noDiscover ? { blurb: "", curated: false } : discoveryMetadata(t);
      return { name: t.name, ...discovery, active: activeNames.has(t.name), hidden, noDiscover, blocked };
    });
  }

  function manifestLines(tools: ManifestTool[]): string {
    return tools.map(t => `  ${t.name}: ${t.blurb}`).join("\n");
  }

  function groupLines(): string {
    return Object.entries(config.groups)
      .map(([name, group]) => `  ${name}: ${group.description || "Configured tool group."}`)
      .join("\n");
  }

  function routeSafeText(value: string, fallback: string): string {
    return /search_tools|tool_proxy|\bproxy\b/i.test(value) ? fallback : value;
  }

  function defaultWorkflow(): string {
    if (currentRoute.strategy === "proxy") return "Tools already listed in your tool surface are ordinary tools—call them directly by exact name. Enable an additional tool here with a plain request; during the current model epoch, execute it through this same control by repeating its exact name with its complete arguments. The next model switch makes it ordinary too.";
    if (currentRoute.strategy === "direct") return "Enable an additional tool here, then emit an ordinary tool call using its exact name even though its schema was omitted from the initial tool surface.";
    return "Enabled additional tools become directly callable through Pi's provider-native deferred-tool path.";
  }

  function routePromptSnippet(): string {
    if (currentRoute.strategy === "proxy") return "Enable an additional tool with a plain request, then execute it by repeating the exact request with its complete arguments; tools already present in your tool surface are called directly by exact name.";
    if (currentRoute.strategy === "direct") return "Enable an additional tool, then call its exact name directly; the runtime permits enabled names whose schemas were omitted initially.";
    return "Enable additional tools natively, then call them directly by exact name.";
  }

  function buildDescription(): string {
    const ordinaryActiveNames = new Set(orderedActiveTools());
    const visible = manifest.filter(t => !t.hidden && !t.noDiscover && !t.blocked);
    const active = visible.filter(t => ordinaryActiveNames.has(t.name));
    const discoverable = visible.filter(t => !ordinaryActiveNames.has(t.name));

    const parts: string[] = [routeSafeText(config.controlIntro, DEFAULT_CONTROL_INTRO)];

    if (config.showActiveToolsInManifest && active.length) parts.push(`Already directly enabled and callable: ${active.map(tool => tool.name).join(", ")}.`);
    if (config.showHiddenToolsInManifest && discoverable.length) parts.push(`Additional tools available on demand:\n${manifestLines(discoverable)}`);
    if (Object.keys(config.groups).length) parts.push(`Available groups (request by exact group name; members enable together):\n${groupLines()}`);
    parts.push(defaultWorkflow());
    parts.push("Pass one request: an exact tool name, an exact configured group name, or a concise capability description. Exact names resolve before capability search. Tools marked explicitOnly expose no individual metadata until named exactly, activated with an exact ##tool marker, an explicit user /tool command, or a configured group.");
    return parts.join("\n\n");
  }
  function orderedActiveTools(): string[] {
    const allNames = new Set(pi.getAllTools().map(t => t.name));
    const active = new Set<string>(config.active.filter(name => name !== CONTROL_NAME && !ownedControlNames.has(name) && !quarantinedTools.has(name)));
    // The one public control remains visible even when a route capability is
    // degraded or another extension owns the name; never erase a registered
    // tools control from the session while reporting the underlying problem.
    if (allNames.has(CONTROL_NAME)) active.add(CONTROL_NAME);
    if (currentRoute.strategy === "native") nativeEnabled.forEach(name => active.add(name));
    for (const name of epochBaseline) active.add(name);
    for (const name of [...active]) {
      const control = name === CONTROL_NAME;
      if (!allNames.has(name) || (!control && (quarantinedTools.has(name) || config.blocked.has(name) || config.excluded.has(name)))) active.delete(name);
    }
    const ordered: string[] = [];
    for (const name of config.activeOrder) if (active.delete(name)) ordered.push(name);
    return [...ordered, ...active];
  }

  function refreshActiveTools(ctx?: any): string[] {
    (pi as any).setToolPromptOverrides?.(config.toolOverrides);
    buildManifest();
    registerToolsControl();
    if (config.registerToolCommand && !toolCommandRegistered) {
      registerToolCommand();
      toolCommandRegistered = true;
    }
    if (typeof (pi as any).setActiveToolsWithDeferred === "function") {
      (pi as any).setActiveToolsWithDeferred(orderedActiveTools(), currentRoute.strategy === "native" ? [...nativeEnabled] : []);
    } else {
      // Missing native capability resolves to the gateway before this point.
      pi.setActiveTools(orderedActiveTools());
    }
    const actualActiveTools = pi.getActiveTools();
    if (typeof (pi as any).setDispatchTools === "function") {
      const dispatch = currentRoute.strategy === "direct" ? uniq([...actualActiveTools, ...dispatchEnabled]) : actualActiveTools;
      (pi as any).setDispatchTools(dispatch);
    }
    buildManifest();

    if (!ctx) return actualActiveTools;
    if (config.showFooterStatus) {
      const activeCount = actualActiveTools.length;
      const totalCount = manifest.length + 1;
      const visibleCount = manifest.filter(t => !t.hidden && !t.noDiscover && !t.blocked).length + 1;
      ctx.ui.setStatus(config.footerStatusId, `${activeCount} / ${totalCount} tools (${visibleCount} discoverable; ${currentRoute.strategy})`);
    } else ctx.ui.setStatus(config.footerStatusId, undefined);
    return actualActiveTools;
  }

  function classifyEnableRequest(names: string[], allowNoDiscover = false) {
    if (startupNamespaceConflicts.length) return { valid: [], invalid: uniq(names), already: [], blocked: [] };
    const allNames = new Set(manifest.map(t => t.name));
    const activeNames = new Set(pi.getActiveTools());
    const valid: string[] = [];
    const invalid: string[] = [];
    const already: string[] = [];
    const blocked: string[] = [];
    for (const name of uniq(names)) {
      const item = manifest.find(tool => tool.name === name);
      if (!allNames.has(name) || quarantinedTools.has(name) || config.excluded.has(name)) invalid.push(name);
      else if (!allowNoDiscover && item?.noDiscover) invalid.push(name);
      else if (activeNames.has(name) || unlocked.has(name)) already.push(name);
      else valid.push(name);
    }
    return { valid, invalid, already, blocked };
  }

  function persistEnabledState(): void {
    const names = [...unlocked];
    // v1 dual-write keeps downgrade rollback able to restore plain names.
    (pi as any).appendEntry?.(ENABLED_STATE_ENTRY, { names });
    (pi as any).appendEntry?.(ENABLED_STATE_ENTRY_V2, {
      version: 2,
      model: epochIdentity ? { ...epochIdentity } : null,
      unlocked: names,
      epochBaseline: [...epochBaseline].filter(name => unlocked.has(name)),
      epochLate: [...epochLate].filter(name => unlocked.has(name)),
    });
  }

  function restorePersistedEnabledState(ctx: any): string[] {
    const branch = ctx?.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) {
      restoredEpochMode = "none";
      return [];
    }
    const restoreConservatively = (names: string[], issue: string): string[] => {
      for (const name of uniq(names)) {
        unlocked.add(name);
        epochLate.add(name);
        staleContracts.add(name);
      }
      restoredEpochMode = "conservative";
      restoredEpochIssue = issue;
      return uniq(names);
    };
    const malformedNames: string[] = [];
    const legacyFallbackNames: string[] = [];
    let sawMalformedV2 = false;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type !== "custom") continue;
      if (entry?.customType === ENABLED_STATE_ENTRY_V2) {
        const data = entry?.data ?? {};
        const unlockedNames = uniq(eligiblePersistedNames(data?.unlocked));
        const baselineNames = uniq(eligiblePersistedNames(data?.epochBaseline));
        const lateNames = uniq(eligiblePersistedNames(data?.epochLate));
        const allMentioned = uniq([...unlockedNames, ...baselineNames, ...lateNames]);
        const unlockedSet = new Set(unlockedNames);
        const baselineSet = new Set(baselineNames);
        const storedIdentity = modelIdentityOf(data?.model);
        const arraysPresent = Array.isArray(data?.unlocked) && Array.isArray(data?.epochBaseline) && Array.isArray(data?.epochLate);
        const disjoint = lateNames.every(name => !baselineSet.has(name));
        const complete = baselineNames.every(name => unlockedSet.has(name))
          && lateNames.every(name => unlockedSet.has(name))
          && unlockedNames.every(name => baselineSet.has(name) || lateNames.includes(name));
        const valid = data?.version === 2 && arraysPresent && Boolean(storedIdentity) && disjoint && complete;
        if (!valid) {
          sawMalformedV2 = true;
          malformedNames.push(...allMentioned);
          continue;
        }
        if (sawMalformedV2) {
          return restoreConservatively([...malformedNames, ...legacyFallbackNames, ...unlockedNames], "malformed newest model-epoch v2 state");
        }
        unlockedNames.forEach(name => unlocked.add(name));
        if (!epochIdentity) {
          return restoreConservatively(unlockedNames, "current model identity is incomplete");
        }
        if (sameModelIdentity(storedIdentity, epochIdentity)) {
          baselineNames.forEach(name => epochBaseline.add(name));
          lateNames.forEach(name => {
            epochLate.add(name);
            staleContracts.add(name);
          });
          restoredEpochMode = "v2-same";
        } else {
          unlockedNames.forEach(name => epochBaseline.add(name));
          restoredEpochMode = "v2-rebased";
        }
        return unlockedNames;
      }
      if (entry?.customType === ENABLED_STATE_ENTRY) {
        const legacyNames = eligiblePersistedNames(entry?.data?.names);
        if (sawMalformedV2) {
          legacyFallbackNames.push(...legacyNames);
          continue;
        }
        return restoreConservatively(legacyNames, "legacy names-only enabled state");
      }
    }
    if (sawMalformedV2) return restoreConservatively([...malformedNames, ...legacyFallbackNames], "malformed newest model-epoch v2 state");
    restoredEpochMode = "none";
    return [];
  }

  function requestEnable(names: string[], allowNoDiscover = false) {
    const result = classifyEnableRequest(names, allowNoDiscover);
    if (result.valid.length && currentRoute.strategy === "native") {
      // Activate before persisting permission: a rejected runtime operation
      // must not leave a tool recorded as enabled. Keep late prompt guidance
      // in the activation contract, not the epoch's earlier system prefix.
      (pi as any).setActiveToolsWithDeferred(
        uniq([...pi.getActiveTools(), ...result.valid]),
        uniq([...nativeEnabled, ...result.valid]),
      );
    }
    for (const name of result.valid) {
      unlocked.add(name);
      epochLate.add(name);
    }
    if (result.valid.length) {
      projectLateToRoute();
      persistEnabledState();
    }
    // Proxy deliberately stops before active-tool mutation: its late target must
    // stay absent from the provider declaration and execute through tools.
    if (result.valid.length && currentRoute.strategy === "direct" && typeof (pi as any).setDispatchTools === "function") {
      (pi as any).setDispatchTools(uniq([...(pi as any).getDispatchTools(), ...result.valid]));
    }
    buildManifest();
    return { ...result, strategy: currentRoute.strategy };
  }

  function initializeSelectorNamespace(): void {
    quarantinedTools.clear();
    selectorOwners.clear();
    startupNamespaceConflicts = [];
    const claim = (kind: "tool" | "group", name: string) => {
      const key = normalizeSelector(name);
      const prior = selectorOwners.get(key);
      if (prior && (prior.kind !== kind || prior.name !== name)) {
        startupNamespaceConflicts.push(`${prior.kind} "${prior.name}" conflicts with ${kind} "${name}"`);
        return;
      }
      selectorOwners.set(key, { kind, name });
    };
    for (const tool of pi.getAllTools()) {
      if (ownedControlNames.has(tool.name) || tool.name === CONTROL_NAME) continue;
      claim("tool", String(tool.name));
    }
    for (const groupName of Object.keys(config.groups)) claim("group", groupName);
  }

  function refreshLateRegisteredTools(): void {
    if (startupNamespaceConflicts.length) return;
    for (const tool of pi.getAllTools()) {
      const name = String(tool.name);
      if (ownedControlNames.has(name) || name === CONTROL_NAME || quarantinedTools.has(name)) continue;
      const key = normalizeSelector(name);
      const prior = selectorOwners.get(key);
      if (!prior) {
        selectorOwners.set(key, { kind: "tool", name });
        continue;
      }
      if (prior.kind === "tool" && prior.name === name) continue;
      quarantinedTools.add(name);
    }
  }

  function exactToolForRequest(request: string): any | undefined {
    const key = normalizeSelector(request);
    const matches = pi.getAllTools().filter((tool: any) =>
      normalizeSelector(String(tool.name)) === key
      && !ownedControlNames.has(tool.name)
      && tool.name !== CONTROL_NAME
      && !quarantinedTools.has(tool.name)
      && !config.excluded.has(tool.name));
    return matches.length === 1 ? matches[0] : undefined;
  }

  function exactGroupForRequest(request: string): string | undefined {
    const key = normalizeSelector(request);
    return Object.keys(config.groups).find(name => normalizeSelector(name) === key);
  }

  function expandGroups(groups: string[]): { names: string[]; unknownGroups: string[] } {
    const names: string[] = [];
    const unknownGroups: string[] = [];
    for (const requested of uniq(groups)) {
      const groupName = exactGroupForRequest(requested);
      if (!groupName) unknownGroups.push(requested);
      else names.push(...config.groups[groupName].tools);
    }
    return { names: uniq(names), unknownGroups };
  }

  function restoreLoadedToolsFromSession(ctx: any): string[] {
    const rawMessages = ctx?.sessionManager?.buildSessionContext?.().messages;
    if (!Array.isArray(rawMessages)) return [];
    // Legacy permission is recovered only after complete call/result validation.
    // Current one-control sessions own permission in v1/v2 custom state; never
    // trust arbitrary underlying execution-result metadata as enablement.
    const messages = rewriteCompletedLegacyControlPairs(rawMessages);
    const known = new Set(pi.getAllTools().map((tool: any) => tool.name));
    const restored: string[] = [];
    const restoreNames = (values: unknown) => {
      if (!Array.isArray(values)) return;
      for (const name of values) {
        if (typeof name !== "string" || !known.has(name) || quarantinedTools.has(name) || config.excluded.has(name)) continue;
        if (!unlocked.has(name)) restored.push(name);
        unlocked.add(name);
      }
    };
    for (const message of messages) {
      if (message?.role !== "toolResult" || typeof message?.toolCallId !== "string") continue;
      if (message?.toolName !== "search_tools" && message?.toolName !== "tool_search") continue;
      restoreNames(message.addedToolNames);
      restoreNames(message?.details?.enabled);
      restoreNames(message?.details?.proxyEnabled);
      restoreNames(message?.details?.enabledDirect);
      restoreNames(message?.details?.dispatchEnabled);
      restoreNames(message?.details?.enabledProxy);
    }
    return uniq(restored);
  }

  function parseActivationMarkers(text: string | undefined): { tools: string[]; groups: string[] } {
    if (!config.hashToolActivation || !text) return { tools: [], groups: [] };
    const tools: string[] = [];
    const groups: string[] = [];
    const knownTools = new Map(manifest.map(t => [normalizeSelector(t.name), t.name]));
    const knownGroups = new Map(Object.keys(config.groups).map(name => [normalizeSelector(name), name]));
    const tokens = text.match(/(?:^|\s)(##[A-Za-z0-9_.:-]+|#group[:/][A-Za-z0-9_.:-]+|#tool[:/][A-Za-z0-9_.:-]+)/g) ?? [];
    for (const token of tokens) {
      const marker = token.trim();
      if (marker.startsWith("##")) {
        const name = marker.slice(2);
        const canonical = knownTools.get(normalizeSelector(name));
        if (canonical) tools.push(canonical);
      } else if (marker.startsWith("#group:") || marker.startsWith("#group/")) {
        const name = marker.slice(7);
        const canonical = knownGroups.get(normalizeSelector(name));
        if (canonical) groups.push(canonical);
      } else {
        const name = marker.slice(6);
        const canonical = knownTools.get(normalizeSelector(name));
        if (canonical) tools.push(canonical);
      }
    }
    // Exact #group-name is accepted only when it resolves to a configured group,
    // which avoids treating ordinary Markdown headings as activations.
    for (const match of text.matchAll(/(?:^|\s)#([A-Za-z0-9_.:-]+)/g)) {
      const name = match[1];
      const canonical = knownGroups.get(normalizeSelector(name));
      if (canonical) groups.push(canonical);
    }
    // Exact substring fallback handles prompt-expansion wrappers that can place
    // markers next to punctuation or XML delimiters without whitespace.
    for (const name of knownTools.values()) {
      if (text.includes(`##${name}`) || text.includes(`#tool:${name}`) || text.includes(`#tool/${name}`)) tools.push(name);
    }
    for (const name of knownGroups.values()) {
      if (text.includes(`#${name}`) || text.includes(`#group:${name}`) || text.includes(`#group/${name}`)) groups.push(name);
    }
    return { tools: uniq(tools), groups: uniq(groups) };
  }

  function diagnoseConfig(ctx: { ui: { notify(message: string, type?: "warning" | "error" | "info"): void } }): void {
    for (const conflict of startupNamespaceConflicts) {
      if (notifiedNamespaceConflicts.has(conflict)) continue;
      notifiedNamespaceConflicts.add(conflict);
      ctx.ui.notify(`tooltap: invalid selector namespace — ${conflict}; tools remains available but enablement fails closed until the conflict is resolved`, "error");
    }
    for (const name of quarantinedTools) {
      if (notifiedQuarantinedTools.has(name)) continue;
      notifiedQuarantinedTools.add(name);
      ctx.ui.notify(`tooltap: late registered tool "${name}" quarantined because its normalized selector collides with an existing tool or group`, "warning");
    }
    if (controlRegistrationConflict && !notifiedNamespaceConflicts.has(CONTROL_NAME)) {
      notifiedNamespaceConflicts.add(CONTROL_NAME);
      ctx.ui.notify(`tooltap: another extension already owns public control "${CONTROL_NAME}"; tooltap dynamic tool loading is unavailable this session`, "error");
    }
    if (!config.configHealthCheck) return;
    const registered = new Set(pi.getAllTools().map((t: any) => String(t.name)));
    const ghostGroups: string[] = [];
    for (const [groupName, group] of Object.entries(config.groups)) {
      const ghost = group.tools.filter(name => !registered.has(name));
      if (ghost.length) ghostGroups.push(`${groupName}: ${ghost.join(", ")}`);
    }
    if (ghostGroups.length) {
      ctx.ui.notify(`tooltap: ${ghostGroups.length} group(s) reference unregistered tools (ghost groups) — ${ghostGroups.join("; ")}. Remove them or install the owning extension.`, "warning");
    }
    const staleOverrides = Object.keys(config.toolOverrides).filter(name => !registered.has(name));
    if (staleOverrides.length) {
      ctx.ui.notify(`tooltap: toolOverrides for unregistered tool(s): ${staleOverrides.join(", ")}. These overrides have no effect and can be removed.`, "warning");
    }
    const controlPolicy = [CONTROL_NAME].filter(name => config.active.includes(name) || config.excluded.has(name));
    const registeredSources = new Set(pi.getAllTools().map((tool: any) => String(tool?.sourceInfo?.source ?? "")).filter(Boolean));
    const staleTrustedSources = [...config.trustedDescriptionSources].filter(source => !registeredSources.has(source));
    if (staleTrustedSources.length) {
      ctx.ui.notify(`tooltap: trustedDescriptionSources not present in the registered inventory: ${staleTrustedSources.join(", ")}. Their descriptions remain suggestion-only until the exact loader source is present.`, "warning");
    }
    if (controlPolicy.length) ctx.ui.notify(`tooltap: control name in policy is ignored and governed by routing: ${uniq(controlPolicy).join(", ")}`, "warning");
    for (const warning of config.routingWarnings) ctx.ui.notify(`tooltap: ${warning}`, "warning");
  }

  function registerContextDumpCommand() {
    (pi as any).registerCommand?.("stow-dump-context", {
      description: "Dump the latest provider payload observed by tooltap without modifying it.",
      handler: async (args: string, ctx: any) => {
        if (!latestProviderSnapshot) {
          ctx.ui.notify("tooltap: no provider request has been observed yet", "warning");
          return;
        }
        const label = (args.trim() || "manual").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const directory = join(getAgentDir(), "context-dumps");
        const path = join(directory, `${timestamp}_tooltap_${label}.json`);
        const registeredInventory = pi.getAllTools().map((tool: any) => ({
          name: tool.name,
          active: (pi as any).getActiveTools?.().includes(tool.name) ?? false,
          sourceInfo: tool.sourceInfo,
        }));
        const dump = {
          format: "tooltap-provider-context-v1",
          authority: "providerSnapshot.payload is the payload tooltap observed and returned unchanged. Later handlers may still replace it.",
          warning: "registryInventory is Pi registration metadata, not schemas sent to the model.",
          dumpedAt: new Date().toISOString(),
          sessionIdHash: currentProviderSessionIdHash,
          frozenConfigHash,
          activeTools: (pi as any).getActiveTools?.() ?? [],
          registryInventory: registeredInventory,
          systemPrompt: ctx.getSystemPrompt?.(),
          systemPromptOptions: ctx.getSystemPromptOptions?.(),
          providerSnapshot: latestProviderSnapshot,
        };
        mkdirSync(directory, { recursive: true });
        writeFileSync(path, JSON.stringify(dump, null, 2), "utf8");
        ctx.ui.notify(`tooltap provider dump: ${path}`, "info");
      },
    });
  }

  function toolUsageContract(name: string): Record<string, unknown> | undefined {
    const tool: any = pi.getAllTools().find((candidate: any) => candidate.name === name);
    if (!tool) return undefined;
    const registered = (pi as any).getRegisteredTool?.(name);
    return {
      name,
      description: config.descriptions[name] ?? tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {}, additionalProperties: false },
      promptSnippet: config.promptSnippets[name] ?? tool.promptSnippet ?? registered?.promptSnippet,
      promptGuidelines: config.promptGuidelines[name] ?? tool.promptGuidelines ?? registered?.promptGuidelines,
    };
  }

  function activationMessage(names: string[], source: string): string {
    const contracts = names.map(toolUsageContract).filter(Boolean);
    if (currentRoute.strategy === "proxy") {
      const { baseline, late } = epochSplit(names);
      const parts: string[] = [];
      if (baseline.length) {
        parts.push(`Enabled by ${source}: ${baseline.join(", ")}. ${baseline.length === 1 ? "This is" : "These are"} now an ordinary tool${baseline.length === 1 ? "" : "s"} in your tool surface — call ${baseline.length === 1 ? "it" : "them"} directly by exact name; do not send ${baseline.length === 1 ? "it" : "them"} through ${CONTROL_NAME}.`);
      }
      if (late.length) {
        parts.push(`Enabled by ${source}: ${late.join(", ")}. Execute through this control with exactly { request: "<exact tool>", arguments: <that tool's complete parameter object> }; arguments require one exact already-enabled tool.`);
      }
      return `${parts.join("\n\n")}\n\nComplete contracts:\n${JSON.stringify(contracts)}`;
    }
    return `Enabled by ${source}: ${names.join(", ")}. Call ${names.length === 1 ? "it" : "them"} directly by exact name${currentRoute.strategy === "direct" ? ", even though the schema was omitted from the initial tool surface" : ""}.\n\nComplete contracts:\n${JSON.stringify(contracts)}`;
  }

  function validateSchema(schema: any, value: any): string[] {
    try {
      if (Check(schema, value)) return [];
      return [...Errors(schema, value)].slice(0, 12).map((error: any) => `${error.path || "$"} ${error.message}`.trim());
    } catch (error) {
      return [`schema validation failed: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  function normalizeArguments(schema: any, args: any): { value: any; changes: string[] } {
    const changes: string[] = [];
    if (!schema || typeof schema !== "object" || !args || typeof args !== "object" || Array.isArray(args)) return { value: args, changes };
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const value: Record<string, unknown> = { ...args };
    for (const [key, raw] of Object.entries(properties)) {
      const prop: any = raw;
      if (!(key in value) && prop && "default" in prop && prop.default !== undefined) {
        value[key] = prop.default;
        changes.push(`defaulted ${key}`);
      }
    }
    for (const [key, rawValue] of Object.entries(value)) {
      const prop: any = properties[key];
      if (!prop || typeof rawValue !== "string") continue;
      const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
      const trimmed = rawValue.trim();
      if (types.includes("integer") && /^-?\d+$/.test(trimmed)) { value[key] = parseInt(trimmed, 10); changes.push(`coerced ${key} to integer`); }
      else if (types.includes("number") && trimmed !== "" && !Number.isNaN(Number(trimmed))) { value[key] = Number(trimmed); changes.push(`coerced ${key} to number`); }
      else if (types.includes("boolean") && (trimmed === "true" || trimmed === "false")) { value[key] = trimmed === "true"; changes.push(`coerced ${key} to boolean`); }
      else if (types.includes("string") && trimmed !== rawValue) { value[key] = trimmed; changes.push(`trimmed ${key}`); }
    }
    return { value, changes };
  }

  function routeParametersSchema(): any {
    const request = Type.String({ description: "One selector: an exact tool name, an exact configured group name, or a concise capability request.", minLength: 1 });
    if (currentRoute.strategy === "proxy") {
      return Type.Object({
        request,
        arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
          description: "Strict two-step: only after enablement. The complete parameter object of one exact already-enabled tool.",
        })),
      }, { additionalProperties: false });
    }
    return Type.Object({ request }, { additionalProperties: false });
  }

  function resolveExecutionTarget(request: string): { name: string } | { error: string } {
    refreshLateRegisteredTools();
    const candidate = exactToolForRequest(request);
    if (!candidate) {
      return { error: `"${request}" is not one exact registered tool. Enablement happens without arguments; arguments execute exactly one already-enabled tool.` };
    }
    const name = candidate.name;
    if ((!proxyEnabled.has(name) && !epochBaseline.has(name)) || !unlocked.has(name)) {
      return { error: `"${name}" is not enabled yet. Strict two-step: request enablement without arguments first, then repeat this request with its complete arguments.` };
    }
    return { name };
  }

  async function executeThroughControl(request: string, args: unknown, toolCallId: string, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
    if (currentRoute.strategy !== "proxy") {
      throw new Error(`arguments is not part of the ${currentRoute.strategy} route contract; call the enabled tool directly by its exact name.`);
    }
    const resolved = resolveExecutionTarget(request);
    if ("error" in resolved) throw new Error(resolved.error);
    const name = resolved.name;
    // Registry metadata supplies the contract, but only getRegisteredTool owns
    // the executable definition. Never fall back to setActiveTools here: that
    // would make execution pass by violating the gateway cache invariant.
    const metadata: any = pi.getAllTools().find((candidate: any) => candidate.name === name);
    const target: any = (pi as any).getRegisteredTool?.(name);
    if (!metadata || !target || typeof target.execute !== "function") {
      // Distinguish "this tool is broken" from "the runtime cannot execute
      // any wrapper target" so a wiped host patch is diagnosable on sight.
      const runtimeCause = typeof (pi as any).getRegisteredTool !== "function"
        ? " The runtime lacks pi.getRegisteredTool, so no gateway-late tool can execute here; run the tooltap ensure-pi-registered-tool-api patch."
        : "";
      throw new Error(`Registered tool ${name} is unavailable for execution.${runtimeCause}`);
    }
    const schema = metadata.parameters ?? target.parameters ?? { type: "object" };
    const provided = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const normalized = config.proxyNormalize ? normalizeArguments(schema, provided) : { value: provided, changes: [] };
    const errors = validateSchema(schema, normalized.value);
    if (errors.length) throw new Error(`Invalid arguments for ${name}: ${errors.join("; ")}. No execution was attempted.`);
    logDiagnostic("control_execute", { tool: name, route: currentRoute.name });
    const result: any = await target.execute(`${toolCallId}:${name}`, normalized.value, signal, onUpdate, ctx);
    if (!result || typeof result !== "object") return result;
    return {
      ...result,
      details: {
        ...(result.details ?? {}),
        executedVia: CONTROL_NAME,
        executedTool: name,
        ...(normalized.changes.length ? { normalizedArguments: normalized.changes } : {}),
      },
    };
  }

  function duplicateOnlyMessage(already: string[]): string {
    if (currentRoute.strategy === "proxy") {
      const { baseline, late } = epochSplit(already);
      const parts: string[] = [];
      if (baseline.length) {
        parts.push(`Already active as ordinary tools: ${baseline.join(", ")}. Call ${baseline.length === 1 ? "it" : "them"} directly by exact name; do not call ${CONTROL_NAME} again for ${baseline.length === 1 ? "it" : "them"}.`);
      }
      if (late.length) {
        parts.push(`Already enabled: ${late.join(", ")}. Schemas were already delivered; pass arguments with request "${late[0]}" to execute.`);
      }
      return parts.join("\n");
    }
    return `Already enabled: ${already.join(", ")}. Call ${already.length === 1 ? already[0] : "them"} directly by exact name; do not call ${CONTROL_NAME} for ${already.length === 1 ? "it" : "them"} again.`;
  }

  function refreshLostContract(already: string[]): string | undefined {
    // Stale-contract refresh is a late-bound concern only: baseline
    // contracts are redelivered in the ordinary tool surface every turn.
    const stale = already.filter(name => staleContracts.has(name) && epochLate.has(name));
    if (!stale.length) return undefined;
    stale.forEach(name => staleContracts.delete(name));
    return `Contract restored after compaction (one-time refresh): ${stale.join(", ")}. ${currentRoute.strategy === "proxy"
      ? 'Execute through this control with { request: "<exact tool>", arguments: <complete parameter object> }.'
      : "Call each tool directly by exact name."}\n\nComplete contracts:\n${JSON.stringify(stale.map(toolUsageContract).filter(Boolean))}`;
  }

  // epochLate is deliberately absent: gateway enablement must not change the
  // control declaration. Only a genuine model epoch or route boundary may.
  function currentControlDeclarationKey(): string {
    return JSON.stringify({
      epochIdentity,
      route: currentRoute.name,
      strategy: currentRoute.strategy,
      baseline: [...epochBaseline].sort(),
    });
  }

  function registerToolsControl(): void {
    const existing = pi.getAllTools().find((tool: any) => tool.name === CONTROL_NAME);
    const registered = (pi as any).getRegisteredTool?.(CONTROL_NAME);
    const sourceOwned = existing?.sourceInfo?.path === OWN_SOURCE_PATH;
    const executeOwned = Boolean(registered && registered.execute === ownedControlExecute);
    const declarationKey = currentControlDeclarationKey();
    if (existing && (sourceOwned || executeOwned) && registeredControl && declarationKey === controlDeclarationKey) {
      controlRegistrationConflict = false;
      return;
    }
    if (existing && !sourceOwned && !executeOwned) {
      controlRegistrationConflict = true;
      return;
    }
    const definition = {
      name: CONTROL_NAME,
      label: config.controlLabel,
      description: buildDescription(),
      promptSnippet: [routeSafeText(config.controlPromptSnippet, ""), routePromptSnippet()].filter(Boolean).join("\n"),
      renderShell: "self",
      renderCall: renderToolsCall,
      renderResult: renderToolsResult,
      parameters: routeParametersSchema(),
      async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
        const request = typeof params?.request === "string" ? params.request.trim() : "";
        if (!request) throw new Error("request must be a nonempty selector: an exact tool name, an exact configured group, or a concise capability request.");
        if (params && typeof params === "object" && params.arguments !== undefined) {
          return executeThroughControl(request, params.arguments, toolCallId, signal, onUpdate, ctx);
        }

        // One selector resolves tiers in order: exact unique tool, exact
        // configured group, then — only when neither matches — a natural
        // capability request. Canonical spelling is always preserved.
        refreshLateRegisteredTools();
        const exactTool = exactToolForRequest(request);
        const exactGroup = !exactTool ? exactGroupForRequest(request) : undefined;
        const capability = !exactTool && !exactGroup
          ? resolveCapabilityRequest(request)
          : { kind: "none", suggestions: [] } as CapabilityResolution;
        const requested = uniq([
          ...(exactTool ? [exactTool.name] : []),
          ...(exactGroup ? config.groups[exactGroup].tools : []),
          ...(capability.kind === "confident" ? [capability.selected.name] : []),
        ]);
        const allowExplicitOnly = Boolean(exactTool) || Boolean(exactGroup);
        const { valid, invalid, already, blocked } = requestEnable(requested, allowExplicitOnly);
        const enabledSet = currentRoute.strategy === "native" ? nativeEnabled : currentRoute.strategy === "direct" ? dispatchEnabled : proxyEnabled;
        const enabled = valid.filter(name => enabledSet.has(name));
        const activationFailed = valid.filter(name => !enabledSet.has(name));
        logDiagnostic("tool_activated", {
          source: CONTROL_NAME,
          route: currentRoute.name,
          requested,
          enabled,
          already,
          unknown: invalid,
          suggestions: capability.suggestions.map((tool: any) => tool.name),
          activeCount: pi.getActiveTools().length,
        });

        const parts: string[] = [];
        if (enabled.length) parts.push(activationMessage(enabled, CONTROL_NAME));
        if (already.length) {
          const refreshed = refreshLostContract(already);
          if (refreshed) {
            parts.unshift(refreshed);
          } else {
            const duplicateMessage = duplicateOnlyMessage(already);
            const duplicateOnly = !enabled.length && !activationFailed.length && !invalid.length;
            if (duplicateOnly) throw new Error(duplicateMessage);
            parts.push(`Already enabled: ${already.join(", ")}.`);
          }
        }
        if (activationFailed.length) parts.push(`Activation failed: ${activationFailed.join(", ")}.`);
        if (invalid.length) parts.push(`Unknown, excluded, or not discoverable: ${invalid.join(", ")}.`);
        if (capability.kind === "ambiguous") {
          const suggestions = capability.suggestions.map((tool: any) => `${tool.name} — ${config.manifestBlurbs[tool.name] ?? firstSentence(config.descriptions[tool.name] ?? tool.description ?? "")}`);
          parts.push(`Possible additional tools:\n${suggestions.join("\n")}\nCall ${CONTROL_NAME} again with one exact tool name to enable it.`);
        }
        if (!requested.length && capability.kind !== "ambiguous") parts.push("No matching registered tools found.");
        return {
          content: [{ type: "text", text: parts.join("\n") }],
        details: {
            enabled,
            epochBaseline: enabled.filter(name => epochBaseline.has(name)),
            epochLate: enabled.filter(name => epochLate.has(name)),
            strategy: currentRoute.strategy,
            route: currentRoute.name,
            groups: exactGroup ? [exactGroup] : [],
            unknownGroups: [],
            activationFailed,
            alreadyActive: already,
            blocked,
            unknown: invalid,
            suggestions: capability.suggestions.map((tool: any) => tool.name),
            activeTools: pi.getActiveTools(),
            proxyEnabled: currentRoute.strategy === "proxy" ? enabled : [],
            dispatchEnabled: currentRoute.strategy === "direct" ? enabled : [],
            visibleSuggestions: manifest.filter(t => !t.hidden && !t.noDiscover && !t.blocked).map(t => t.name),
          },
        };
      },
    } as any;
    ownedControlExecute = definition.execute;
    pi.registerTool(definition);
    registeredControl = true;
    ownedControlNames.add(CONTROL_NAME);
    controlRegistrationConflict = false;
    controlDeclarationKey = declarationKey;
  }
  function registerToolCommand() {
    (pi as any).registerCommand?.("tool", {
      description: "Enable additional tools by exact name. Supports autocomplete. Example: /tool fetch_content ctx_shell",
      getArgumentCompletions: (prefix: string) => {
        const used = new Set(prefix.trim().split(/\s+/).filter(Boolean));
        const current = (prefix.split(/\s+/).pop() ?? "").toLowerCase();
        const enabledNames = new Set([...pi.getActiveTools(), ...unlocked]);
        const items = manifest
          .filter(t => !t.blocked && !t.hidden && !used.has(t.name) && t.name.toLowerCase().includes(current))
          .map(t => {
            const enabled = enabledNames.has(t.name);
            return { value: t.name, label: t.name, detail: `${enabled ? "Enabled" : "Not enabled"} · ${t.blurb}`, _stowEnabled: enabled };
          });
        const ordered = orderHashDiscoveryItems(items);
        return ordered.length ? ordered : null;
      },
      handler: async (args: string, ctx: { ui: { notify(content: string, kind: "info" | "warning" | "error"): void } }) => {
        const requested = args.trim().split(/\s+/).filter(Boolean);
        if (currentRoute.strategy === "native") {
          const result = classifyEnableRequest(requested, true);
          if (result.valid.length) {
            pi.sendMessage({
              customType: "tooltap-command-native-request",
              content: `Explicit /tool request detected for ${result.valid.join(", ")}. Call ${CONTROL_NAME} with these exact names so Pi can attach the provider-native deferred definitions without mutating the initial tool surface.`,
              display: false,
              details: { requested: result.valid, strategy: "native", route: currentRoute.name },
            }, { deliverAs: "nextTurn", triggerTurn: false });
          }
          const parts = [
            result.valid.length ? `queued ${result.valid.join(", ")} for ${CONTROL_NAME}` : "",
            result.already.length ? `already active ${result.already.join(", ")}` : "",
            result.invalid.length ? `unknown ${result.invalid.join(", ")}` : "",
          ].filter(Boolean);
          ctx.ui.notify(parts.join("; ") || "no tools requested", result.valid.length ? "info" : "warning");
          return;
        }
        const result = requestEnable(requested, true);
        refreshActiveTools();
        if (result.valid.length) {
          pi.sendMessage({
            customType: "tooltap-command-activation",
            content: activationMessage(result.valid, "/tool"),
            display: false,
            details: { enabled: result.valid, strategy: currentRoute.strategy, route: currentRoute.name },
          }, { deliverAs: "nextTurn", triggerTurn: false });
        }
        const parts: string[] = [];
        if (result.valid.length) parts.push(`enabled ${result.valid.join(", ")} via ${currentRoute.strategy}`);
        if (result.already.length) parts.push(`already active ${result.already.join(", ")}`);
        if (result.blocked.length) parts.push(`blocked ${result.blocked.join(", ")}`);
        if (result.invalid.length) parts.push(`unknown ${result.invalid.join(", ")}`);
        ctx.ui.notify(parts.join("; ") || "no tools requested", result.valid.length ? "info" : "warning");
      },
    });
  }


  function capabilityTerms(value: string): string[] {
    return normalizeSelector(value).split(/[^a-z0-9_.:-]+/).filter(term => term && !SEARCH_STOP_WORDS.has(term));
  }

  function resolveCapabilityRequest(goal: string): CapabilityResolution {
    const normalizedGoal = normalizeSelector(goal);
    const allTerms = normalizedGoal.split(/[^a-z0-9_.:-]+/).filter(Boolean);
    const queryTerms = capabilityTerms(goal);
    const startupActive = new Set(orderedActiveTools());
    const eligible = pi.getAllTools().filter((tool: any) => tool.name !== CONTROL_NAME && !ownedControlNames.has(tool.name)
      && !quarantinedTools.has(tool.name)
      && !config.excluded.has(tool.name)
      && !config.blocked.has(tool.name)
      && !config.noDiscover.has(tool.name)
      && !startupActive.has(tool.name)
      && !unlocked.has(tool.name));

    // An explicitly written eligible name remains authoritative inside a
    // capability phrase. Several names are ambiguous rather than permission to
    // enable several tools from one fuzzy request.
    const exactMatches = eligible.filter((tool: any) => {
      const name = String(tool.name).toLowerCase();
      return normalizedGoal === name || allTerms.includes(name);
    });
    if (exactMatches.length === 1) return { kind: "confident", selected: exactMatches[0], suggestions: [] };
    if (exactMatches.length > 1) return { kind: "ambiguous", suggestions: exactMatches.slice(0, SEARCH_RESULT_LIMIT) };
    if (!queryTerms.length || !eligible.length) return { kind: "none", suggestions: [] };

    const manifestByName = new Map(manifest.map(item => [item.name, item]));
    const documents = eligible.map((tool: any) => ({
      tool,
      terms: capabilityTerms(`${String(tool.name).replaceAll("_", " ")} ${manifestByName.get(tool.name)?.blurb ?? discoveryMetadata(tool).blurb}`),
    }));
    const averageLength = Math.max(1, documents.reduce((sum, document) => sum + document.terms.length, 0) / documents.length);
    const documentFrequency = new Map<string, number>();
    for (const term of new Set(queryTerms)) {
      documentFrequency.set(term, documents.filter(document => document.terms.includes(term)).length);
    }
    const scored = documents.map(document => {
      const frequencies = new Map<string, number>();
      for (const term of document.terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      let score = 0;
      for (const term of queryTerms) {
        const frequency = frequencies.get(term) ?? 0;
        if (!frequency) continue;
        const containing = documentFrequency.get(term) ?? 0;
        const inverseDocumentFrequency = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
        const lengthNormalization = frequency + BM25_K1 * (1 - BM25_B + BM25_B * document.terms.length / averageLength);
        score += inverseDocumentFrequency * (frequency * (BM25_K1 + 1)) / lengthNormalization;
      }
      return { tool: document.tool, score };
    }).filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || String(a.tool.name).localeCompare(String(b.tool.name)));
    if (!scored.length) return { kind: "none", suggestions: [] };

    const top = scored[0];
    const second = scored[1];
    // Permission-changing fuzzy resolution requires an explicit authority:
    // either a host-authored blurb or a registered description from an exact
    // source provenance the host trusts. Untrusted implementation prose may
    // rank suggestions but cannot authorize mutation.
    const curatedForAutoEnable = manifestByName.get(top.tool.name)?.curated === true;
    const confident = curatedForAutoEnable && top.score >= SEARCH_MIN_CONFIDENT_SCORE
      && (!second || top.score / second.score >= SEARCH_CONFIDENCE_RATIO);
    if (confident) return { kind: "confident", selected: top.tool, suggestions: [] };
    return { kind: "ambiguous", suggestions: scored.slice(0, SEARCH_RESULT_LIMIT).map(entry => entry.tool) };
  }



  function logDiagnostic(event: string, fields: Record<string, unknown>) {
    if (!config.logPayloads) return;
    try {
      appendFileSync(join(getAgentDir(), "tooltap.log.jsonl"), JSON.stringify({
        ts: new Date().toISOString(), event, sessionIdHash: currentProviderSessionIdHash,
        strategy: currentRoute.strategy, route: currentRoute.name, frozenConfigHash, ...fields,
      }) + "\n");
    } catch {}
  }

  function activateFromMarkers(text: string | undefined): any {
    const markers = parseActivationMarkers(text);
    const expanded = expandGroups(markers.groups);
    const requested = uniq([...markers.tools, ...expanded.names]);
    logDiagnostic("marker_parse", {
      promptHash: hashValue(text ?? ""),
      tools: markers.tools,
      groups: markers.groups,
      expanded: expanded.names,
    });
    if (!requested.length) return undefined;
    if (currentRoute.strategy === "native") {
      const classified = classifyEnableRequest(requested, true);
      if (!classified.valid.length) return undefined;
      return {
        message: {
          customType: "tooltap-marker-native-request",
          content: `Explicit tool request detected for ${classified.valid.join(", ")}. Call ${CONTROL_NAME} with these exact names so Pi can attach the provider-native deferred definitions without mutating the initial tool surface.`,
          display: false,
          details: {
            requested: classified.valid,
            groups: markers.groups,
            skippedAlreadyActive: classified.already,
            unknown: classified.invalid,
            unknownGroups: expanded.unknownGroups,
            strategy: "native",
            route: currentRoute.name,
          },
        },
      };
    }
    const result = requestEnable(requested, true);
    const enabledSet = currentRoute.strategy === "direct" ? dispatchEnabled : proxyEnabled;
    const enabled = result.valid.filter(name => enabledSet.has(name));
    const activationFailed = result.valid.filter(name => !enabledSet.has(name));
    logDiagnostic("marker_activation", {
      requested,
      enabled,
      already: result.already,
      unknown: result.invalid,
      route: currentRoute.name,
    });
    if (!enabled.length) return undefined;
    return {
      message: {
        customType: "tooltap-marker-activation",
        content: activationMessage(enabled, "explicit marker"),
        display: false,
        details: {
          enabled,
          strategy: currentRoute.strategy,
          route: currentRoute.name,
          groups: markers.groups,
          skippedAlreadyActive: result.already,
          activationFailed,
          unknown: result.invalid,
          unknownGroups: expanded.unknownGroups,
        },
      },
    };
  }

  registerContextDumpCommand();

  pi.on("before_provider_request", (event: { payload?: unknown }, ctx) => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    currentProviderSessionIdHash = typeof sessionId === "string" ? hashValue(sessionId) : null;
    rememberProviderSnapshot(event.payload, event.payload, ctx);
  });
  pi.on("session_compact", () => {
    // Baseline contracts stay in the ordinary tool surface across
    // compaction; only late-bound tools lose their delivered contract.
    epochLate.forEach(name => staleContracts.add(name));
  });

  function rewriteStowMessageForRoute(message: any): any {
    if (message?.role === "toolResult" && message?.toolName === CONTROL_NAME && typeof message?.details?.executedTool === "string") return message;
    const isLoaderResult = message?.role === "toolResult" && (message.toolName === CONTROL_NAME || message.toolName === "search_tools" || message.toolName === "tool_search");
    const isStowCustom = message?.role === "custom" && String(message.customType ?? "").startsWith("tooltap-");
    if (!isLoaderResult && !isStowCustom) return message;
    const known = new Set(pi.getAllTools().map((tool: any) => String(tool.name)));
    const eligible = (values: unknown) => strArray(values).filter(name => known.has(name) && !quarantinedTools.has(name) && !config.excluded.has(name) && name !== CONTROL_NAME && !ownedControlNames.has(name));
    const enabled = eligible(uniq([
      ...strArray(message?.details?.enabled),
      ...strArray(message?.details?.proxyEnabled),
      ...strArray(message?.details?.enabledProxy),
      ...strArray(message?.details?.enabledDirect),
      ...strArray(message?.details?.dispatchEnabled),
    ]));
    const requested = eligible(message?.details?.requested);
    const warningLines: string[] = [];
    const unknown = strArray(message?.details?.unknown).filter(name => !config.excluded.has(name));
    const unknownGroups = strArray(message?.details?.unknownGroups);
    const activationFailed = eligible(message?.details?.activationFailed);
    if (activationFailed.length) warningLines.push(`Activation failed: ${activationFailed.join(", ")}.`);
    if (unknown.length) warningLines.push(`Unknown or not discoverable: ${unknown.join(", ")}.`);
    if (unknownGroups.length) warningLines.push(`Unknown groups: ${unknownGroups.join(", ")}.`);
    let text: string;
    if (enabled.length) text = [activationMessage(enabled, "session context"), ...warningLines].join("\n");
    else if (requested.length) {
      const settled = requested.filter(name => epochBaseline.has(name));
      const outstanding = requested.filter(name => !epochBaseline.has(name));
      const bits: string[] = [];
      if (outstanding.length) bits.push(`Historical explicit request for ${outstanding.join(", ")}. Call ${CONTROL_NAME} with these exact names to enable them through this control on the current route.`);
      if (settled.length) bits.push(`Already ordinary tools, call directly by exact name: ${settled.join(", ")}.`);
      text = bits.join("\n");
    }
    else text = warningLines.join("\n") || "No eligible additional tools were restored from this historical tooltap message.";
    return {
      ...message,
      ...(isLoaderResult ? { toolName: CONTROL_NAME } : {}),
      content: isLoaderResult ? [{ type: "text", text }] : text,
      details: {
        ...(message.details ?? {}),
        enabled,
        requested,
        strategy: currentRoute.strategy,
        route: currentRoute.name,
        proxyEnabled: currentRoute.strategy === "proxy" ? enabled : [],
        dispatchEnabled: currentRoute.strategy === "direct" ? enabled : [],
        activationFailed,
        unknown,
        enabledProxy: currentRoute.strategy === "proxy" ? enabled : [],
        enabledDirect: currentRoute.strategy === "proxy" ? [] : enabled,
        unknownGroups,
      },
    };
  }

  function rewriteCompletedLegacyControlPairs(messages: any[]): any[] {
    const legacyNames = new Set(["search_tools", "tool_search", "tool_proxy"]);
    const loaderRequest = (args: any): string => {
      const lanes: Array<{ kind: "text" | "exact"; values: string[] }> = [];
      for (const value of [args?.goal, args?.query]) {
        if (typeof value === "string" && value.trim()) lanes.push({ kind: "text", values: [value.trim()] });
      }
      const names = strArray(args?.names);
      const groups = strArray(args?.groups);
      if (names.length) lanes.push({ kind: "exact", values: names });
      if (groups.length) lanes.push({ kind: "exact", values: groups });
      if (lanes.length !== 1 || lanes[0].values.length !== 1) {
        throw new Error("Cannot safely migrate a legacy loader call with zero or multiple selector lanes into one tools request.");
      }
      return lanes[0].values[0];
    };
    const calls = new Map<string, any[]>();
    const results = new Map<string, any[]>();
    for (const message of messages) {
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item?.type !== "toolCall" || !legacyNames.has(item?.name) || typeof item?.id !== "string") continue;
          const list = calls.get(item.id) ?? [];
          list.push(item);
          calls.set(item.id, list);
        }
      }
      if (message?.role === "toolResult" && legacyNames.has(message?.toolName) && typeof message?.toolCallId === "string") {
        const list = results.get(message.toolCallId) ?? [];
        list.push(message);
        results.set(message.toolCallId, list);
      }
    }
    for (const [id, callList] of calls) {
      const resultList = results.get(id) ?? [];
      if (callList.length !== 1 || resultList.length !== 1) {
        throw new Error(`Cannot safely migrate legacy control history ${id}: expected one call and one result; start a new session or resume with the previous tooltap version.`);
      }
      const call = callList[0];
      const result = resultList[0];
      if (call.name !== result.toolName) {
        throw new Error(`Cannot safely migrate legacy control history ${id}: call/result tool names disagree.`);
      }
      if (call.name === "tool_proxy") {
        const callTarget = String(call?.arguments?.name ?? "");
        const resultTarget = String(result?.details?.underlyingTool ?? callTarget);
        if (!callTarget || callTarget !== resultTarget) {
          throw new Error(`Cannot safely migrate legacy tool_proxy history ${id}: execution target disagreement.`);
        }
        continue;
      }
      const selector = loaderRequest(call.arguments);
      const enabled = uniq([
        ...strArray(result?.details?.enabled),
        ...strArray(result?.details?.proxyEnabled),
        ...strArray(result?.details?.enabledDirect),
        ...strArray(result?.details?.dispatchEnabled),
        ...strArray(result?.details?.enabledProxy),
      ]);
      const exactTool = exactToolForRequest(selector);
      const exactGroup = exactTool ? undefined : exactGroupForRequest(selector);
      const allowed = exactTool
        ? new Set([exactTool.name])
        : exactGroup ? new Set(config.groups[exactGroup].tools) : undefined;
      if (allowed && enabled.some(name => !allowed.has(name))) {
        throw new Error(`Cannot safely migrate legacy loader history ${id}: selector/result target disagreement.`);
      }
      const resultRequested = strArray(result?.details?.requested);
      if (resultRequested.length && !resultRequested.some(name => normalizeSelector(name) === normalizeSelector(selector))) {
        throw new Error(`Cannot safely migrate legacy loader history ${id}: requested selector disagreement.`);
      }
    }
    for (const [id] of results) {
      if (!calls.has(id)) {
        throw new Error(`Cannot safely migrate unmatched legacy control result ${id}; start a new session or resume with the previous tooltap version.`);
      }
    }

    return messages.map(message => {
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        return {
          ...message,
          content: message.content.map((item: any) => {
            if (item?.type !== "toolCall" || !legacyNames.has(item?.name)) return item;
            if (item.name === "tool_proxy") {
              return {
                ...item,
                name: CONTROL_NAME,
                arguments: { request: String(item?.arguments?.name ?? ""), arguments: item?.arguments?.args ?? {} },
              };
            }
            return { ...item, name: CONTROL_NAME, arguments: { request: loaderRequest(item.arguments) } };
          }),
        };
      }
      if (message?.role === "toolResult" && message?.toolName === "tool_proxy") {
        const details = { ...(message.details ?? {}) };
        delete details.proxiedBy;
        const executedTool = String(details.underlyingTool ?? "");
        delete details.underlyingTool;
        return { ...message, toolName: CONTROL_NAME, details: { ...details, executedVia: CONTROL_NAME, executedTool, migratedLegacyExecution: true } };
      }
      return message;
    });
  }

  // Pi's deferred-tool adapters classify transcript-loaded schemas from
  // historical addedToolNames. Once a validated name joins the new epoch's
  // baseline, remove only that marker so setActiveTools becomes ordinary.
  function rewriteEpochBaselineDeferralMetadata(messages: any[]): any[] {
    if (!epochBaseline.size) return messages;
    return messages.map(message => {
      if (message?.role !== "toolResult" || !Array.isArray(message.addedToolNames)) return message;
      const addedToolNames = message.addedToolNames.filter((name: unknown) => typeof name !== "string" || !epochBaseline.has(name));
      if (addedToolNames.length === message.addedToolNames.length) return message;
      const rewritten = { ...message };
      if (addedToolNames.length) rewritten.addedToolNames = addedToolNames;
      else delete rewritten.addedToolNames;
      return rewritten;
    });
  }

  pi.on("context", (event: { messages?: any[] }) => {
    if (!Array.isArray(event.messages)) return undefined;
    const migrated = rewriteCompletedLegacyControlPairs(event.messages);
    const rebased = rewriteEpochBaselineDeferralMetadata(migrated);
    return { messages: rebased.map(rewriteStowMessageForRoute) };
  });

  pi.on("session_start", (_event, ctx) => {
    (ctx.ui as any).addAutocompleteProvider?.((provider: AutocompleteProviderLike) =>
      wrapAutocompleteProviderWithHashToolSupport(
        provider,
        () => config.groups,
        () => new Set([...pi.getActiveTools(), ...unlocked]),
      ),
    );
    toolCommandRegistered = false;
    controlDeclarationKey = null;
    currentProviderSessionIdHash = null;
    latestProviderSnapshot = null;
    unlocked.clear();
    nativeEnabled.clear();
    dispatchEnabled.clear();
    notifiedNamespaceConflicts.clear();
    notifiedQuarantinedTools.clear();
    proxyEnabled.clear();
    epochBaseline.clear();
    epochLate.clear();
    epochIdentity = null;
    restoredEpochMode = "none";
    restoredEpochIssue = null;
    config = readUserConfig(options?.userConfigOverride);
    selectRoute(ctx);
    initializeSelectorNamespace();
    staleContracts.clear();
    epochIdentity = modelIdentityOf(ctx?.model);
    frozenConfigHash = hashValue({
      active: config.active,
      hidden: [...config.hidden],
      noDiscover: [...config.noDiscover],
      excluded: [...config.excluded],
      groups: config.groups,
      trustedDescriptionSources: [...config.trustedDescriptionSources],
      routing: config.routes,
    });
    const persisted = restorePersistedEnabledState(ctx);
    const restored = restoreLoadedToolsFromSession(ctx);
    finalizeRestoredEpoch(ctx, restored.length);
    projectLateToRoute();
    refreshActiveTools(ctx);
    diagnoseConfig(ctx);
    notifyRouteResolution(ctx);
    if (config.notifyOnSessionStart) {
      const restoredCount = uniq([...persisted, ...restored]).length;
      const epochSuffix = epochBaseline.size ? `; ${epochBaseline.size} in model baseline` : "";
      const suffix = `${restoredCount ? `; restored ${restoredCount}` : ""}${epochSuffix}`;
      ctx.ui.notify(`tooltap: ${pi.getActiveTools().length} tools active; route ${currentRoute.name}/${currentRoute.strategy}${suffix}`, "info");
    }
  });

  pi.on("model_select", (event: { model?: any }, ctx) => {
    selectModelRoute(event.model);
    const identity = modelIdentityOf(event.model);
    // A genuine provider/api/model identity change opens a new epoch. A
    // runtime or session restart is not a switch: same-identity reselects
    // keep the exact classification.
    if (identity && !sameModelIdentity(identity, epochIdentity)) beginModelEpoch(identity);
    refreshActiveTools(ctx);
    diagnoseConfig(ctx);
    notifyRouteResolution(ctx);
  });

  pi.on("before_agent_start", (event: { prompt?: string }, ctx) => {
    buildManifest();
    const result = activateFromMarkers(event.prompt);
    if (result) refreshActiveTools(ctx);
    diagnoseConfig(ctx);
    return result;
  });

}
