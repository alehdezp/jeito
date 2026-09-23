// jeito Shell: compressed bash commands, reusable scripts, and background jobs. Soft waits never kill.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { dirname, join } from "node:path";
import { leanCtxEnv, requireLeanCtxRuntime } from "./lean-ctx-runtime.mjs";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const LOG = "/tmp/jeito-shell";
const SCR = `${LOG}/scripts`;
const DEF_WAIT = 10;
const UI_SUMMARY_MAX_CHARS = 8000;
const MODEL_OUTPUT_PREVIEW_MAX_BYTES = 16_000;
const COMPLETION_PREVIEW_MAX_BYTES = 4_000;
const LOG_READ_CHUNK_BYTES = 64 * 1024;
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const ERR_RE = /error|fail|fatal|panic|segfault|exception/i;
const PATH_RE = /(?:^|\s)(?:\/[^\s:]+|\.{1,2}\/[^\s:]+|(?:src|lib|test|app|dist|build|node_modules)\/[^\s:]+):\d+/;
const URL_RE = /https?:\/\/[^\s)]+/;
const UI_MAX_LINES = 30;
const UI_CONDENSED_LINES = 8;
const UI_RST = "\x1b[0m";
const UI_ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const UI_ANSI_AT_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/y;
const UI_COLORS = { bash: "\x1b[38;2;249;199;79m", jobs: "\x1b[38;2;255;107;107m" };
const UI_THEME_COLORS = { toolTitle: "\x1b[38;2;205;214;244m", accent: "\x1b[38;2;137;220;235m", success: "\x1b[38;2;166;227;161m", warning: "\x1b[38;2;249;226;175m", error: "\x1b[38;2;243;139;168m", muted: "\x1b[38;2;139;148;158m" };
const UI_BOLD = "\x1b[1m";
const UI_EXTENDED_LINES = 120;
const UI_TOOL_ICONS = { bash: "\uf120", jobs: "\uf085" };
function configuredNerdFont(env = process.env, home = homedir()): boolean {
  const override = String((env as any).PI_NAV_NERD_FONT ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(override)) return true;
  if (["0", "false", "no", "off"].includes(override)) return false;
  const terminal = String((env as any).TERM_PROGRAM ?? "").toLowerCase();
  const candidates = terminal.includes("ghostty") ? [join(home, ".config", "ghostty", "config")]
    : (env as any).KITTY_WINDOW_ID ? [join((env as any).KITTY_CONFIG_DIRECTORY ?? join(home, ".config", "kitty"), "kitty.conf")]
    : terminal.includes("wezterm") ? [join(home, ".wezterm.lua"), join(home, ".config", "wezterm", "wezterm.lua")] : [];
  for (const path of candidates) { try { if (/nerd\s*font/i.test(readFileSync(path, "utf8"))) return true; } catch {} }
  return false;
}
const UI_NERD_FONT = configuredNerdFont();
const JEITO_DENSITY_KEY = Symbol.for("pi.agent.jeitoDensity.v1");
const JEITO_DENSITY_STATE: { level: number } = (globalThis as any)[JEITO_DENSITY_KEY] ??= { level: 1 };
export function currentDensity(): "ultra" | "condensed" | "normal" | "extended" { return (["ultra","condensed","normal","extended"] as const)[JEITO_DENSITY_STATE.level] ?? "condensed"; }
export function cycleDensity(): "ultra" | "condensed" | "normal" | "extended" { JEITO_DENSITY_STATE.level = (JEITO_DENSITY_STATE.level + 1) % 4; return currentDensity(); }
export function resetUiDensityForTests() { JEITO_DENSITY_STATE.level = 0; }
function rememberDensity() {}
class TextBlock {
  constructor(text = "", maxLines = UI_MAX_LINES) { this.text = text; this.maxLines = maxLines; }
  setText(text) { this.text = text; }
  wantsLeadingSpacer() { return currentDensity() !== "ultra"; }
  invalidate() {}
  render(width) { return capUi(this.text.split("\n").map(line => clampUi(line, width)), width, this.maxLines); }
}
function normalizeUiWidth(width, fallback = 100) { return Number.isFinite(width) && width > 0 ? Math.floor(width) : fallback; }
function stripUiAnsi(text) { return String(text ?? "").replace(UI_ANSI_RE, ""); }
function normalizeUiControls(text) {
  let out = "";
  for (let index = 0, input = String(text ?? ""); index < input.length;) {
    UI_ANSI_AT_RE.lastIndex = index;
    const ansi = UI_ANSI_AT_RE.exec(input);
    if (ansi) { out += ansi[0]; index = UI_ANSI_AT_RE.lastIndex; continue; }
    const code = input.codePointAt(index) ?? 0, char = String.fromCodePoint(code);
    index += char.length;
    if (char === "\t") { out += "   "; continue; }
    if (code < 32 || (code >= 0x7f && code < 0xa0)) { out += " "; continue; }
    out += char;
  }
  return out;
}
function uiWidth(text) { return visibleWidth(normalizeUiControls(text)); }
function clampUi(text, width = 100) { const w = normalizeUiWidth(width); const safe = normalizeUiControls(text); return visibleWidth(safe) <= w ? safe : truncateToWidth(safe, w, "…"); }
function capUi(lines, width, maxLines = UI_MAX_LINES, rail = "│", theme = undefined) { if (lines.length <= maxLines) return lines; const bottom = lines[lines.length - 1] || ""; const note = clampUi(`${rail} ${themeFg(theme, "muted", `… UI truncated to ${maxLines} lines · Ctrl+U to show`)}`, width); return stripUiAnsi(bottom).startsWith("╰") ? [...lines.slice(0, maxLines - 2), note, bottom] : [...lines.slice(0, maxLines - 1), note]; }
function uiColor(tool, text) { return `${UI_COLORS[tool] || UI_COLORS.bash}${text}${UI_RST}`; }
function themeFg(theme, style, text) { if (theme?.fg) return theme.fg(style, text); const color = UI_THEME_COLORS[style]; return color ? `${color}${text}${UI_RST}` : text; }
function themeBold(theme, text) { return theme?.bold ? theme.bold(text) : `${UI_BOLD}${text}${UI_RST}`; }
function colorStatusLabel(label, theme) { const m = /^([✗…✓◐⚠])(?:\s+)?(.*)$/.exec(String(label || "")); if (!m) return label; const style = m[1] === "✗" ? "error" : m[1] === "✓" ? "success" : "warning"; return `${themeFg(theme, style, m[1])}${m[2] ? ` ${m[2]}` : ""}`; }
function toolIcon(tool, theme) { const glyph = UI_NERD_FONT ? UI_TOOL_ICONS[tool] : ""; return glyph ? `${themeFg(theme, "accent", glyph)}  ` : ""; }
function toolTitle(tool, detail, theme) { return `${toolIcon(tool, theme)}${themeFg(theme, "toolTitle", themeBold(theme, tool))}${detail ? ` ${themeFg(theme, "accent", detail)}` : ""}`; }
function ultraTitleDetail(title, tool) {
  const plain = stripUiAnsi(title).replace(/\s+/g, " ").trim();
  const start = plain.indexOf(tool);
  return start < 0 ? "" : plain.slice(start + tool.length).trim();
}
function ultraMetric(label, tool) {
  let plain = stripUiAnsi(label).replace(/^[✓✗…◐⚠]\s*/u, "").trim();
  if (plain === tool) return "";
  if (plain.startsWith(`${tool} `)) plain = plain.slice(tool.length + 1).trim();
  return plain.replace(/^[\s·•—-]+/u, "");
}
function ultraHierarchyLine(head, target, metric, theme, width) {
  const available = Math.max(0, width - uiWidth(head));
  let targetBudget = target ? Math.max(0, available - 1) : 0;
  if (target && metric) {
    const metricReserve = Math.min(24, Math.max(8, Math.floor(available * 0.38)));
    targetBudget = Math.max(0, available - metricReserve - 4);
  }
  const targetText = targetBudget > 0 ? truncateToWidth(normalizeUiControls(target), targetBudget, "…") : "";
  const targetPart = targetText ? ` ${themeFg(theme, "accent", targetText)}` : "";
  const metricBudget = metric ? Math.max(0, width - uiWidth(head) - uiWidth(targetPart) - 3) : 0;
  const metricText = metricBudget > 0 ? truncateToWidth(normalizeUiControls(metric), metricBudget, "…") : "";
  const metricPart = metricText ? `${themeFg(theme, "muted", " · ")}${themeFg(theme, "muted", metricText)}` : "";
  return clampUi(`${head}${targetPart}${metricPart}`, width);
}
function frameTop(tool, title, width = 100) { const t = clampUi(title, Math.max(1, width - 6)); return `${uiColor(tool, "╭──")} ${t} ${uiColor(tool, "─".repeat(Math.max(1, width - uiWidth(t) - 5)))}`; }
function statusStyle(label) { const plain = stripUiAnsi(String(label || "")); return plain.startsWith("✗") ? "error" : plain.startsWith("✓") ? "success" : "warning"; }
function statusBorder(label, theme, text) { return themeFg(theme, statusStyle(label), text); }
function statusFrameTop(title, label, theme, width = 100) { const t = clampUi(title, Math.max(1, width - 6)); return `${statusBorder(label, theme, "╭──")} ${t} ${statusBorder(label, theme, "─".repeat(Math.max(1, width - uiWidth(t) - 5)))}`; }
function frameBottom(label, theme, width = 100) { const t = clampUi(label, Math.max(1, width - 6)); return `${statusBorder(label, theme, "╰──")} ${t} ${statusBorder(label, theme, "─".repeat(Math.max(1, width - uiWidth(t) - 5)))}`; }
class ShellDensityBlock {
  body: string; label: string; theme: any; width: number; tool: string;
  constructor(body, label, theme, width, tool) { this.body = body; this.label = label; this.theme = theme; this.width = width; this.tool = tool; }
  setText(text) { this.body = text; }
  wantsLeadingSpacer() { return currentDensity() !== "ultra"; }
  invalidate() {}
  render(width) {
    const w = normalizeUiWidth(width ?? this.width, 100);
    const density = currentDensity();
    if (density === "ultra") return [frameBottom(this.label, this.theme, w)];
    const effectiveMax = density === "extended" ? UI_EXTENDED_LINES : density === "condensed" ? UI_CONDENSED_LINES : 30;
    const source = String(this.body || "").split("\n").filter(l => l.length);
    const maxBody = effectiveMax - 1;
    const hiddenText = themeFg(this.theme, "muted", `… ${source.length - maxBody + 1} more lines hidden · Ctrl+U to show`);
    const shown = source.length > maxBody ? [...source.slice(0, maxBody - 1), hiddenText] : source;
    const rail = statusBorder(this.label, this.theme, "│");
    const joined = [...shown.map(l => `${rail} ${clampUi(l, Math.max(1, w - 2))}`), frameBottom(this.label, this.theme, w)].join("\n");
    return capUi(joined.split("\n").map(l => clampUi(l, w)), w, effectiveMax, rail, this.theme);
  }
}
let activeShellCard: ShellUnifiedBlock | undefined;
function bindShellResultCard(ctx: any) { activeShellCard = ctx?.state?.card instanceof ShellUnifiedBlock ? ctx.state.card : undefined; }
function ensureShellCard(ctx: any, tool: string, theme: any, width: number, title: string): ShellUnifiedBlock | undefined {
  const state = ctx?.state;
  if (!state || typeof state !== "object") return undefined;
  if (!(state as any).card || !((state as any).card instanceof ShellUnifiedBlock)) {
    (state as any).card = new ShellUnifiedBlock(width, title, tool, theme);
  } else {
    (state as any).card.refreshCall(title, width, theme);
  }
  return (state as any).card as ShellUnifiedBlock;
}
class ShellUnifiedBlock {
  tool: string; theme: any; width: number; title: string; block: any | undefined;
  constructor(width, title, tool, theme) { this.width = width; this.title = title; this.tool = tool; this.theme = theme; this.block = undefined; }
  refreshCall(title, width, theme) { this.title = title; this.width = width; this.theme = theme || this.theme; }
  wantsLeadingSpacer() { return currentDensity() !== "ultra"; }
  receiveBlock(block) { this.block = block; }
  setText() {}
  invalidate() {}
  render(width) {
    const w = normalizeUiWidth(width ?? this.width, 100), density = currentDensity(), block = this.block;
    const titleDetail = ultraTitleDetail(this.title, this.tool);
    const ultraTarget = this.tool === "jobs" ? titleDetail.split(/\s+/, 1)[0] : titleDetail;
    const ultraTool = themeFg(this.theme, "toolTitle", themeBold(this.theme, this.tool));
    if (!block) {
      if (density === "ultra") {
        const head = `${themeFg(this.theme, "warning", "…")} ${ultraTool}`;
        return [ultraHierarchyLine(head, ultraTarget, "", this.theme, w)];
      }
      const rawLabel = `… pending ${this.tool}`;
      const label = colorStatusLabel(rawLabel, this.theme);
      const lines = [statusFrameTop(this.title, rawLabel, this.theme, w), frameBottom(label, this.theme, w)];
      const max = density === "condensed" ? UI_CONDENSED_LINES : density === "extended" ? UI_EXTENDED_LINES : UI_MAX_LINES;
      return capUi(lines.map(line => clampUi(line, w)), w, max, statusBorder(rawLabel, this.theme, "│"), this.theme);
    }
    if (density === "ultra") {
      const plain = stripUiAnsi(block.label);
      const glyph = plain.match(/^[✓✗…◐⚠]/)?.[0] || "✓";
      const style = glyph === "✗" ? "error" : glyph === "✓" ? "success" : "warning";
      let plainLabel = ultraMetric(block.label, this.tool);
      if (ultraTarget && plainLabel.startsWith(ultraTarget)) plainLabel = plainLabel.slice(ultraTarget.length).replace(/^[\s·•—-]+/u, "").trim();
      const head = `${themeFg(this.theme, style, glyph)} ${ultraTool}`;
      return [ultraHierarchyLine(head, ultraTarget, plainLabel, this.theme, w)];
    }
    const status = block.status || "success";
    const top = statusFrameTop(this.title, block.label, this.theme, w);
    const body = block.render(w);
    const max = density === "condensed" ? UI_CONDENSED_LINES : density === "extended" ? UI_EXTENDED_LINES : UI_MAX_LINES;
    return capUi([top, ...(Array.isArray(body) ? body : [])].join("\n").split("\n").map(line => clampUi(line, w)), w, max, statusBorder(block.label, this.theme, "│"), this.theme);
  }
}
function frame(tool, body, label, theme, width = 100) { const _prev = activeShellCard; const block = new ShellDensityBlock(body, label, theme, width, tool); if (_prev) { _prev.receiveBlock(block); return { render: () => [], invalidate() {}, wantsLeadingSpacer() { return _prev.wantsLeadingSpacer(); } } as any; } return block; }
function textOf(result) { return result?.content?.filter(x => x?.type === "text").map(x => x?.text ?? "").join("\n") ?? ""; }
function widthOf(opt, ctx) { return typeof ctx?.width === "number" && ctx.width > 0 ? ctx.width : typeof opt?.width === "number" && opt.width > 0 ? opt.width : 100; }
function icon(status) { return status === "error" ? "✗" : status === "running" || status === "pending" ? "…" : "✓"; }
function firstNonEmpty(text, fallback) { return String(text || "").split("\n").find(line => line.trim()) || fallback; }
function countOutputLines(text) { const value = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n$/, ""); return !value || value === "(no output)" || value === "(no output yet)" ? 0 : value.split("\n").length; }
function bashOutputLineCount(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let marker = -1;
  for (let index = 0; index < lines.length; index++) if (/^[^|\n]+\s+\|\s*/.test(lines[index])) marker = index;
  if (marker < 0) return countOutputLines(text);
  const first = lines[marker].replace(/^[^|\n]+\s+\|\s*/, "").replace(/^EXIT\s+\d+\s*/, "");
  return countOutputLines((first ? [first, ...lines.slice(marker + 1)] : lines.slice(marker + 1)).join("\n"));
}
function jobsOutputLineCount(text) { const value = String(text ?? ""); const split = value.indexOf("\n\n"); return split >= 0 ? countOutputLines(value.slice(split + 2)) : 0; }
function outputCountLabel(count) { return `${count} output ${count === 1 ? "line" : "lines"}`; }
function bashDetail(p = {}) { const actions = Array.isArray(p.action) ? p.action : []; const raw = p.raw ? " · raw" : ""; if (actions.includes("list")) return p.id ? `list ${p.id}` : "list saved cells"; if (p.command) { const lines = String(p.command).trim().split("\n"); return `${lines.length > 1 ? `${lines[0]} … (${lines.length} lines)` : lines[0]}${raw}`; } const verb = actions.includes("show") ? "show" : actions.includes("run") ? "run" : actions.includes("clone") ? "clone" : "script"; return `${verb} ${p.id || ""}${raw}`.trim(); }
function jobsDetail(p = {}) { return p.id ? `${p.id}${p.wait ? ` wait ${p.wait}s` : ""}${p.delta ? " delta" : ""}${p.filter ? ` filter ${p.filter}` : ""}${p.signal ? ` ${p.signal}` : ""}` : "active jobs"; }
function bashLabel(text, result) { const d = result?.details, outputLines = Number.isInteger(d?.outputLines) ? d.outputLines : bashOutputLineCount(text); if (result?.isError) return `✗ ${d?.bodyId || "bash"} exit ${d?.exitCode || 1} • ${outputCountLabel(outputLines)}`; if (d?.backgrounded === true) { const m = /(sh-[\w.-]+|bash) → (job-\d+) running/.exec(text); return m ? `… ${m[1]} → ${m[2]} timed out • ${outputCountLabel(outputLines)}` : "… timed out"; } if (d?.jobId && d?.exitCode === undefined) { const m = /(sh-[\w.-]+|bash) → (job-\d+) running/.exec(text); return m ? `… ${m[1]} → ${m[2]} background` : "… background"; } let m = /^([^\n|]+) \| EXIT (\d+)/m.exec(text); if (m) return `✗ ${m[1].trim()} exit ${m[2]} • ${outputCountLabel(outputLines)}`; m = /(sh-[\w.-]+|bash) → (job-\d+) running/.exec(text); if (m) return `… ${m[1]} → ${m[2]} running`; if (/\bcreated \(/.test(text)) return "✓ created"; if (/\bcloned from\b/.test(text)) return "✓ cloned"; if (/^No saved bash scripts|\[completed\]|\[failed\]|\d+ lines?/m.test(text) && !/\|/.test(text)) return "✓ saved cells"; m = /^([^\n|]+) \|/m.exec(text); return m ? `✓ ${m[1].trim()} exit 0 • ${outputCountLabel(outputLines)}` : `✓ bash • ${outputCountLabel(outputLines)}`; }
function jobsLabel(text) { const m = /(job-\d+) \[(running|stopped|completed|failed)\]/.exec(text); if (m) { const reported = /• (\d+) output lines?/.exec(text.split("\n", 1)[0]), count = reported ? Number(reported[1]) : jobsOutputLineCount(text), suffix = m[2] === "completed" || m[2] === "failed" ? ` • ${outputCountLabel(count)}` : ""; return `${icon(m[2] === "failed" ? "error" : m[2] === "running" || m[2] === "stopped" ? "running" : "success")} ${m[1]} ${m[2]}${suffix}`; } if (/No active jobs/.test(text)) return "✓ no active jobs"; if (/sent SIG/.test(text)) return "✓ signal sent"; return "✓ jobs"; }
function renderJobsBody(text, theme) {
  const value = String(text ?? "");
  if (/^No active jobs\.?$/.test(value.trim())) return [];
  const split = value.indexOf("\n\n");
  const header = split < 0 ? value : value.slice(0, split);
  const output = split < 0 ? "" : value.slice(split + 2);
  const match = /^(job-\d+) \[(running|stopped|completed|failed)\] (.*?) — ([^—•\n]+?)(?: — ([^•\n]+?))?(?: • (\d+) output lines?)?$/.exec(header.trim());
  if (!match) return value.split("\n").filter(Boolean).map(line => tintOutputLine(line, theme));
  const summary = [match[4].trim(), match[3].trim(), match[6] ? outputCountLabel(Number(match[6])) : "", match[5]?.trim() || ""].filter(Boolean).join(" · ");
  const outputLines = output.trim() && output.trim() !== "(no output)" ? splitBody(output) : [];
  return [themeFg(theme, "muted", summary), ...outputLines.map(line => tintOutputLine(line, theme))];
}
// Parse the flat execute() text into structured sections for hierarchical rendering.
// The model-facing text contract is unchanged; this is a UI-only projection.
function parseBashSections(text) {
  const raw = String(text ?? "");
  const sections = { cellHeader: "", scriptPreview: [], output: "", running: "" };
  // Backgrounded: "sh-1 → job-3 running\n\n<partial>"
  let m = /^(bash|sh-[\w.-]+) → (job-\d+) running(?:\n\n([\s\S]*))?$/.exec(raw);
  if (m) { sections.running = `${m[1]} → ${m[2]} running`; sections.output = m[3] || ""; return sections; }
  // Split cell-overview prefix (created/cloned/show) from the run output.
  // The run output begins at a line matching "^(bash|sh-N) \| (EXIT \d+)?\s*".
  const lines = raw.split("\n");
  let splitAt = -1;
  for (let i = 0; i < lines.length; i++) if (/^(bash|sh-[\w.-]+)\s+\|\s*(EXIT\s+\d+\s*)?/.test(lines[i])) { splitAt = i; break; }
  if (splitAt > 0) {
    const prefix = lines.slice(0, splitAt).join("\n");
    const runLine = lines[splitAt];
    const body = lines.slice(splitAt + 1).join("\n");
    // First prefix line is the summary (e.g. "sh-1 created (5 lines) — subtitle"); following "n| ..." lines are the script preview.
    const prefixLines = prefix.split("\n");
    sections.cellHeader = prefixLines[0] || "";
    sections.scriptPreview = prefixLines.slice(1).filter(l => /^\d+\|\s/.test(l) || l === "...");
    const exitm = /^\S+\s+\|\s*EXIT\s+(\d+)\s*$/.exec(runLine);
    sections.output = exitm ? body : `${runLine.replace(/^\S+\s+\|\s*/, "")}\n${body}`.replace(/\n$/, "");
    return sections;
  }
  // Bare run with no prefix: "bash | <out>" or pure output.
  m = /^([^\n|]+)\s+\|\s*(EXIT\s+\d+\s*)?([\s\S]*)$/.exec(raw);
  if (m && !raw.includes("\n\n") || /^(bash|sh-[\w.-]+)\s+\|/.test(raw)) {
    const exitm = /^\S+\s+\|\s*EXIT\s+(\d+)\s*$/.exec(raw.split("\n")[0]);
    if (exitm) { sections.output = raw.split("\n").slice(1).join("\n").replace(/\n$/, ""); return sections; }
    sections.output = raw.replace(/^[^\n|]+\s+\|\s*/, "").replace(/\n$/, "");
    return sections;
  }
  // List / show / pure text: no transformation.
  sections.output = raw;
  return sections;
}
function tintOutputLine(line, theme) {
  // Keep command output mostly plain (per DESIGN.md), but tint lines that look like
  // errors/warnings so failures are scannable. Matches the bounded-output ERR_RE policy.
  const s = String(line ?? "");
  if (!s.trim()) return s;
  if (/\b(error|fail|fatal|panic|segfault|exception|traceback)/i.test(s)) return themeFg(theme, "error", s);
  if (/^\s*(warning|warn)\b/i.test(s)) return themeFg(theme, "warning", s);
  return s;
}
function renderBashBody(text, theme) {
  const sections = parseBashSections(text);
  const out = [];
  const dim = s => themeFg(theme, "toolTitle", s);
  if (sections.running) {
    out.push(dim(`${sections.running}`));
    if (sections.output && sections.output !== "(no output yet)") out.push(...sections.output.split("\n").filter(l=>l.length).map(l => tintOutputLine(l, theme)));
    return out;
  }
  if (sections.cellHeader) {
    // "sh-1 created (5 lines) — subtitle" → "sh-1 created · 5 lines · subtitle"
    const h = sections.cellHeader
      .replace(/^(\S+)\s+(created|cloned from \S+|saved|show)\s+\((\d+)\s+lines?\)(?:\s+—\s+(.*))?$/, (_, id, verb, n, sub) => {
        const parts = [`${id} ${verb}`, `${n} lines`];
        if (sub) parts.push(sub);
        return parts.join(" · ");
      });
    out.push(dim(h === sections.cellHeader ? sections.cellHeader : h));
    for (const previewLine of sections.scriptPreview) out.push(themeFg(theme, "toolTitle", previewLine.replace(/^(\d+)\|/, "$1 │")));
  }
  if (sections.output) {
    if (out.length) out.push(themeFg(theme, "toolTitle", "─".repeat(2)));
    out.push(...sections.output.split("\n").map(l => tintOutputLine(l, theme)));
  } else if (!out.length) {
    out.push("(no output)");
  }
  return out;
}
function renderBashCall(args, theme, ctx = {}) {
  const title = toolTitle("bash", bashDetail(args), theme);
  const w = widthOf(undefined, ctx);
  const card = ensureShellCard(ctx, "bash", theme, w, title);
  if (card) return card as any;
  return new TextBlock(frameTop("bash", title, w));
}
function renderBashResult(result, opt, theme, ctx = {}) { bindShellResultCard(ctx); const text = textOf(result); return frame("bash", renderBashBody(text, theme).join("\n") || "(no output)", colorStatusLabel(bashLabel(text, result), theme), theme, widthOf(opt, ctx)); }
function renderJobsCall(args, theme, ctx = {}) {
  const title = toolTitle("jobs", jobsDetail(args), theme);
  const w = widthOf(undefined, ctx);
  const card = ensureShellCard(ctx, "jobs", theme, w, title);
  if (card) return card as any;
  return new TextBlock(frameTop("jobs", title, w));
}
function renderJobsResult(result, opt, theme, ctx = {}) { bindShellResultCard(ctx); const text = textOf(result); const label = result?.isError ? "✗ jobs failed" : jobsLabel(text); const body = renderJobsBody(text, theme).join("\n"); return frame("jobs", body, colorStatusLabel(label, theme), theme, widthOf(opt, ctx)); }
function completionPreviewLines(data, theme, budget) {
  if (budget <= 0) return [];
  const raw = String(data.preview || "").trim();
  if (!raw || raw === "(no output)") return [];
  const lines = splitBody(raw).map(line => tintOutputLine(line, theme));
  if (lines.length <= budget) return lines;
  if (budget === 1) return [themeFg(theme, "muted", `… ${lines.length} output lines hidden · Ctrl+U to show`)];
  return [themeFg(theme, "muted", `… ${lines.length - budget + 1} earlier output lines hidden · Ctrl+U to show`), ...lines.slice(-(budget - 1))];
}
class JobDoneBlock {
  constructor(data, _expanded, theme) { this.data = data; this.theme = theme; }
  invalidate() {}
  wantsLeadingSpacer() { return currentDensity() !== "ultra"; }
  render(width) {
    const w = normalizeUiWidth(width, 100), density = currentDensity(), d = this.data;
    const failed = d.status === "failed" || (Number.isInteger(d.exitCode) && d.exitCode !== 0);
    const style = failed ? "error" : "success", glyph = failed ? "✗" : "✓", state = failed ? "failed" : "completed";
    const tool = themeFg(this.theme, "toolTitle", themeBold(this.theme, "jobs"));
    const target = String(d.jobId || "job");
    const outputLines = Number.isInteger(d.outputLines) ? d.outputLines : countOutputLines(String(d.preview || ""));
    const metrics = [state, failed && Number.isInteger(d.exitCode) ? `exit ${d.exitCode}` : "", d.elapsed, outputCountLabel(outputLines), d.compressed ? "LeanCTX" : "raw"].filter(Boolean).join(" · ");
    if (density === "ultra") return [ultraHierarchyLine(`${themeFg(this.theme, style, glyph)} ${tool}`, target, metrics, this.theme, w)];

    const max = density === "condensed" ? UI_CONDENSED_LINES : density === "extended" ? UI_EXTENDED_LINES : UI_MAX_LINES;
    const summary = themeFg(this.theme, "muted", [d.bodyId, d.elapsed, outputCountLabel(outputLines), d.compressed ? "LeanCTX" : "raw"].filter(Boolean).join(" · "));
    const prefix = [summary];
    if (failed) prefix.push(themeFg(this.theme, "accent", `Inspect: jobs({ id: "${d.jobId}", delta: true })`));
    const body = [...prefix, ...completionPreviewLines(d, this.theme, Math.max(0, max - 2 - prefix.length))];
    const rawLabel = `${glyph} ${d.jobId} ${state}${failed && Number.isInteger(d.exitCode) ? ` · exit ${d.exitCode}` : ""}`;
    const rail = statusBorder(rawLabel, this.theme, "│");
    const title = toolTitle("jobs", d.jobId, this.theme);
    const label = colorStatusLabel(rawLabel, this.theme);
    return [statusFrameTop(title, rawLabel, this.theme, w), ...body.map(line => `${rail} ${clampUi(line, Math.max(1, w - 2))}`), frameBottom(label, this.theme, w)].map(line => clampUi(line, w));
  }
}
function renderJobDoneEntry(entry, { expanded } = {}, theme) { return new JobDoneBlock(entry?.data, !!expanded, theme); }

export const __jeitoShellUi = { renderBashCall, renderBashResult, renderJobsCall, renderJobsResult, renderJobDoneEntry, resetUiDensityForTests, currentDensity, cycleDensity, countOutputLines, bashOutputLineCount, jobsOutputLineCount, readLogSlice };
let bodyN = 0, jobN = 0;
const bodies = new Map(), jobs = new Map(), lastRead = new Map(), logPaths = new Set();

function delay(ms) { return new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); }); }
function elapsed(ms) { const s = Math.floor(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`; }
function bodyPath(id) { return `${SCR}/${process.pid}-${id}.sh`; }
function tempBodyPath() { return `${SCR}/${process.pid}-inline-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`; }
function logPath(id) { return `${LOG}/${id}.log`; }
function isBodyId(id) { return /^sh-[A-Za-z0-9_.-]+$/.test(String(id || "")); }
function isJobId(id) { return /^job-\d+$/.test(String(id || "")); }
function sig(name) { return ({ term: "SIGTERM", kill: "SIGKILL", stop: "SIGSTOP", cont: "SIGCONT" })[name] || name; }
// LeanCTX isolates its Bash child; signal descendant groups or the command survives its job.
function processDescendants(pid) {
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (ps.status !== 0) return [];
  const children = new Map();
  for (const line of String(ps.stdout || "").split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    const siblings = children.get(parent) || [];
    siblings.push(child); children.set(parent, siblings);
  }
  const found = [], visit = parent => { for (const child of children.get(parent) || []) { found.push(child); visit(child); } };
  visit(pid);
  return found;
}
function signalProcessGroup(pid, signal) { try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} } }
function killGroup(pid, signal) {
  const descendants = processDescendants(pid);
  signalProcessGroup(pid, signal);
  for (const child of descendants.reverse()) signalProcessGroup(child, signal);
}
function completionPreview(path) {
  try { return boundOutput(readLogSlice(path, 0, COMPLETION_PREVIEW_MAX_BYTES).text, COMPLETION_PREVIEW_MAX_BYTES); }
  catch (error) { return `[Output preview unavailable: ${error instanceof Error ? error.message : String(error)}]`; }
}

function splitBody(text) { return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n"); }
function numbered(text) { return splitBody(text).map((line, i) => `${i + 1}| ${line}`).join("\n"); }
function lineCount(body) { return splitBody(body.body).length; }
function cleanSubtitle(text) { return String(text || "").replace(/\s+/g, " ").trim().slice(0, 90); }
function extractSubtitle(text) {
  const lines = splitBody(String(text || "")).slice(0, 14);
  let sawHeredocWrapper = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#!")) continue;
    if (t.startsWith("#")) return cleanSubtitle(t.replace(/^#+\s*/, ""));
    if (t.startsWith("//")) return cleanSubtitle(t.replace(/^\/\/+\s*/, ""));
    if (t.includes("<<")) { sawHeredocWrapper = true; continue; }
    if (!sawHeredocWrapper) break;
  }
  return "";
}
function bodySuffix(body) { return body.subtitle ? ` — ${body.subtitle}` : ""; }
function summaryLine(body, verb) { const n = lineCount(body); return `${body.id} ${verb} (${n} line${n === 1 ? "" : "s"})${bodySuffix(body)}`; }
function listBodies() {
  const all = Array.from(bodies.values());
  if (!all.length) return "No saved bash scripts.";
  return all.map(b => {
    const n = lineCount(b), status = b.lastStatus ? ` [${b.lastStatus}]` : "", from = b.clonedFrom ? ` from ${b.clonedFrom}` : "";
    return `${b.id} ${n} line${n === 1 ? "" : "s"}${status}${from}${bodySuffix(b)}`;
  }).join("\n");
}
function markBodyRun(bodyId, status, exitCode) { const b = bodies.get(bodyId); if (b) { b.lastStatus = status; b.lastExitCode = exitCode; b.lastRun = Date.now(); bodies.set(bodyId, b); } }
function overview(body, verb) {
  const lines = splitBody(body.body), n = lines.length;
  const view = n <= 5 ? lines.map((l, i) => `${i + 1}| ${l}`) : [`1| ${lines[0]}`, `2| ${lines[1]}`, "...", `${n - 1}| ${lines[n - 2]}`, `${n}| ${lines[n - 1]}`];
  return `${summaryLine(body, verb)}\n${view.join("\n")}`;
}

function boundOutput(raw, max = UI_SUMMARY_MAX_CHARS) {
  if (!raw) return "(no output)";
  const s = raw.replace(ANSI_RE, "").replace(/\r\n?/g, "\n").trim();
  if (s.length <= 2000) return s || "(no output)";
  const lines = s.split("\n"), seen = new Set(), sigs = [];
  for (const line of lines) { const t = line.trim(); if (t && !seen.has(t) && (ERR_RE.test(t) || PATH_RE.test(t) || URL_RE.test(t))) { sigs.push(t); seen.add(t); } }
  let out = sigs.length ? `${sigs.slice(0, 20).join("\n")}\n\n` : "";
  const budget = max - out.length - 30;
  out += s.length <= budget ? s : lines.length > 50 ? `${lines.slice(0, 3).join("\n")}\n... [${lines.length - 28} lines] ...\n${lines.slice(-25).join("\n")}` : s.slice(-budget);
  return out.length > max ? `${out.slice(0, max - 30)}\n...[truncated]...` : out;
}

function nextBodyId() { let id; do { id = `sh-${++bodyN}`; } while (bodies.has(id)); return id; }
function getBody(id) {
  if (!isBodyId(id) || !bodies.has(id)) throw new Error(`Unknown bash script ${id}`);
  return bodies.get(id);
}
function makeBody(command, opts = {}) {
  const text = String(command || "").trim();
  if (!text) throw new Error("command required");
  const body = `${text}\n`, save = !!opts.save, id = opts.id || (save ? nextBodyId() : "bash");
  const path = save ? bodyPath(id) : tempBodyPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o700 });
  const record = { id, path, body, created: Date.now(), saved: save, subtitle: extractSubtitle(body) };
  if (save) {
    bodies.set(id, record);
    while (bodies.size > 20) { const old = bodies.keys().next().value; try { unlinkSync(bodies.get(old).path); } catch {} bodies.delete(old); }
  }
  return record;
}
function saveBody(command) { return makeBody(command, { save: true }); }
function cloneBody(fromId, toId) {
  if (!isBodyId(toId)) throw new Error(`Invalid clone target ${toId}; use an id like sh-name`);
  if (bodies.has(toId)) throw new Error(`Clone target already exists: ${toId}`);
  const from = getBody(fromId), path = bodyPath(toId), body = from.body;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o700 });
  const record = { id: toId, path, body, created: Date.now(), saved: true, clonedFrom: fromId, subtitle: from.subtitle || extractSubtitle(body) };
  bodies.set(toId, record);
  return record;
}


function alignUtf8Start(buffer) {
  let offset = 0;
  while (offset < Math.min(3, buffer.length) && (buffer[offset] & 0xc0) === 0x80) offset++;
  return { buffer: buffer.subarray(offset), offset };
}

function readLogSlice(path, start = 0, maxBytes = MODEL_OUTPUT_PREVIEW_MAX_BYTES) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const requestedStart = size < start ? 0 : Math.max(0, start);
    const candidateStart = Math.max(requestedStart, size - maxBytes);
    const buffer = Buffer.alloc(Math.max(0, size - candidateStart));
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, candidateStart + read);
      if (!count) break;
      read += count;
    }
    const aligned = alignUtf8Start(buffer.subarray(0, read));
    const snapshotStart = candidateStart + aligned.offset;
    const shownBytes = aligned.buffer.length;
    const omittedBytes = Math.max(0, snapshotStart - requestedStart);
    return {
      text: aligned.buffer.toString("utf8"),
      size,
      outputBytes: size,
      requestedStart,
      snapshotStart,
      snapshotEnd: size,
      shownBytes,
      omitted: omittedBytes,
      omittedBytes,
      truncated: omittedBytes > 0,
    };
  } catch (error) {
    throw new Error(`Unable to read shell output log ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

function appendBoundedBuffer(retained, piece, maxBytes) {
  if (piece.length >= maxBytes) return Buffer.from(piece.subarray(piece.length - maxBytes));
  const combined = retained.length ? Buffer.concat([retained, piece]) : piece;
  return combined.length <= maxBytes ? combined : Buffer.from(combined.subarray(combined.length - maxBytes));
}

function readFilteredLogSlice(path, pattern, start = 0, maxBytes = MODEL_OUTPUT_PREVIEW_MAX_BYTES) {
  let regex;
  try { regex = new RegExp(pattern, "i"); }
  catch (error) { throw new Error(`Invalid jobs filter regex: ${error instanceof Error ? error.message : String(error)}`); }

  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const requestedStart = size < start ? 0 : Math.max(0, start);
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(LOG_READ_CHUNK_BYTES);
    let position = requestedStart, carry = "", retained = Buffer.alloc(0), matchedBytes = 0, matchedLines = 0;
    const retainMatch = line => {
      const piece = Buffer.from(`${matchedLines ? "\n" : ""}${line}`);
      matchedLines++;
      matchedBytes += piece.length;
      retained = appendBoundedBuffer(retained, piece, maxBytes);
    };
    const consume = (text, final = false) => {
      carry += text;
      const lines = carry.split("\n");
      if (!final) carry = lines.pop() ?? "";
      else carry = "";
      for (const line of lines) if (regex.test(line)) retainMatch(line);
    };

    // ponytail: arbitrary JavaScript regexes require one complete line; memory is bounded by the longest line, not the whole log.
    while (position < size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
      if (!count) break;
      position += count;
      consume(decoder.write(chunk.subarray(0, count)));
    }
    consume(decoder.end(), true);
    const aligned = alignUtf8Start(retained);
    const shownBytes = aligned.buffer.length;
    const omittedBytes = Math.max(0, matchedBytes - shownBytes);
    return {
      text: aligned.buffer.toString("utf8"),
      size,
      outputBytes: size,
      requestedStart,
      snapshotStart: requestedStart,
      snapshotEnd: size,
      shownBytes,
      omittedBytes,
      matchedBytes,
      truncated: omittedBytes > 0,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid jobs filter regex:")) throw error;
    throw new Error(`Unable to read shell output log ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

function logViewDetails(view) {
  return {
    truncated: view.truncated,
    outputBytes: view.outputBytes,
    shownBytes: view.shownBytes,
    omittedBytes: view.omittedBytes,
    snapshotStart: view.snapshotStart,
    snapshotEnd: view.snapshotEnd,
    ...(Number.isInteger(view.matchedBytes) ? { matchedBytes: view.matchedBytes } : {}),
    ...(Number.isInteger(view.requestedLines) ? { requestedLines: view.requestedLines, shownLines: view.shownLines } : {}),
  };
}

function limitLogViewLines(view, requestedLines) {
  if (!Number.isInteger(requestedLines)) return view;
  const trailingNewline = view.text.endsWith("\n");
  const lines = view.text ? view.text.split("\n") : [];
  if (trailingNewline) lines.pop();
  const selected = lines.slice(-requestedLines);
  const text = `${selected.join("\n")}${trailingNewline && selected.length ? "\n" : ""}`;
  const shownBytes = Buffer.byteLength(text);
  const droppedBytes = view.shownBytes - shownBytes;
  return {
    ...view,
    text,
    shownBytes,
    omittedBytes: view.omittedBytes + droppedBytes,
    snapshotStart: Number.isInteger(view.matchedBytes) ? view.snapshotStart : view.snapshotStart + droppedBytes,
    truncated: view.truncated || droppedBytes > 0,
    requestedLines,
    shownLines: countOutputLines(text),
  };
}

function formatLogView(view, path, { delta = false, filter = false, lines } = {}) {
  const output = view.text || "(no output)";
  if (!view.truncated) return output;
  const label = Number.isInteger(lines)
    ? `${filter ? "Filtered " : ""}${delta ? "delta " : ""}line-tail preview`.replace(/^./, character => character.toUpperCase())
    : filter ? delta ? "Filtered delta preview" : "Filtered output preview" : delta ? "Delta preview" : "Output preview";
  const totalBytes = filter ? view.matchedBytes : view.outputBytes - view.requestedStart;
  const shown = Number.isInteger(lines) ? `the final ${view.shownLines} lines, ${view.shownBytes}` : `the final ${view.shownBytes}`;
  const omittedKind = filter ? "matching bytes" : "earlier bytes";
  const cursor = delta ? ` Cursor advanced to byte ${view.snapshotEnd}.` : "";
  const exact = filter ? "complete unfiltered session log" : "exact session log";
  return `[${label}: showing ${shown} of ${totalBytes} bytes; ${view.omittedBytes} ${omittedKind} omitted.${cursor}\nFull ${exact}: ${path} (available until session shutdown).\nUse read/search or a targeted Bash command on that path before making claims that depend on omitted output.]\n\n${output}`;
}

function createOutputLineCounter() { return { breaks: 0, pendingCarriageReturn: false, sawNonBreak: false, lastWasBreak: false }; }
function countOutputChunk(counter, chunk) {
  for (const byte of chunk) {
    if (counter.pendingCarriageReturn) {
      counter.breaks++;
      counter.lastWasBreak = true;
      counter.pendingCarriageReturn = false;
      if (byte === 0x0a) continue;
    }
    if (byte === 0x0d) { counter.pendingCarriageReturn = true; continue; }
    if (byte === 0x0a) { counter.breaks++; counter.lastWasBreak = true; continue; }
    counter.sawNonBreak = true;
    counter.lastWasBreak = false;
  }
}
function finishOutputLineCount(counter) {
  if (counter.pendingCarriageReturn) { counter.breaks++; counter.lastWasBreak = true; counter.pendingCarriageReturn = false; }
  if (!counter.sawNonBreak && counter.breaks <= 1) return 0;
  return counter.breaks + (counter.lastWasBreak ? 0 : 1);
}
function scheduleCompletion(job, pi) {
  if (!job.exposed || job.status === "running" || job.status === "stopped" || job.waiting || job.notified || job.completionScheduled) return;
  job.completionScheduled = true;
  const t = setTimeout(() => {
    job.completionScheduled = false;
    if (!job.exposed || job.waiting || job.notified) return;
    job.notified = true;
    const outputLines = Number.isInteger(job.outputLines) ? job.outputLines : 0;
    pi.appendEntry?.("job-done", {
      jobId: job.id,
      bodyId: job.bodyId,
      status: job.status,
      elapsed: elapsed(Date.now() - job.startTime),
      outputLines,
      exitCode: job.exitCode,
      signal: job.signal,
      compressed: !job.raw,
      preview: completionPreview(job.logPath),
    });
  }, 1500);
  t.unref?.();
}
function expose(job, pi) { if (!job.id) job.id = `job-${++jobN}`; job.exposed = true; jobs.set(job.id, job); scheduleCompletion(job, pi); return job; }
function start(body, raw, ctx, pi, leanCtx) {
  writeFileSync(body.path, body.body, { mode: 0o700 });
  const log = logPath(`tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  logPaths.add(log);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "w");
  const bash = existsSync("/bin/bash") ? "/bin/bash" : existsSync("/usr/bin/bash") ? "/usr/bin/bash" : "bash";
  const command = raw ? bash : leanCtx.binary;
  const args = raw ? [body.path] : ["-c", body.body];
  const env = raw ? { ...process.env } : leanCtxEnv(leanCtx, { ...process.env, LEAN_CTX_SHELL: bash });
  // LeanCTX treats regular-file stdout as redirected data and intentionally bypasses compression.
  const proc = spawn(command, args, { cwd: ctx.cwd, detached: true, env, stdio: ["pipe", "pipe", "pipe"] });
  let fdOpen = true;
  const lineCounter = createOutputLineCounter();
  const append = chunk => {
    if (!fdOpen) return;
    writeSync(fd, chunk);
    countOutputChunk(lineCounter, chunk);
  };
  proc.stdout.on("data", append); proc.stderr.on("data", append); proc.stdin.end();
  if (!proc.pid) { proc.once("error", () => {}); fdOpen = false; closeSync(fd); throw new Error(`spawn failed for ${body.id}`); }
  const job = { id: "", bodyId: body.id, body, raw, proc, pid: proc.pid, logPath: log, status: "running", startTime: Date.now(), waiting: 0, notified: false, exposed: false, completionScheduled: false };
  job.done = new Promise(resolve => {
    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      if (fdOpen) { fdOpen = false; closeSync(fd); }
      const signaled = typeof signal === "string" && signal.length > 0;
      job.status = code === 0 && !signaled ? "completed" : "failed";
      job.exitCode = typeof code === "number" ? code : signaled ? signalExitCode(signal) : 1;
      job.signal = signaled ? signal : undefined;
      job.outputLines = finishOutputLineCount(lineCounter);
      delete job.proc; markBodyRun(job.bodyId, job.status, job.exitCode); resolve(job.exitCode); scheduleCompletion(job, pi);
    };
    proc.on("close", (code, signal) => finish(code, signal)); proc.on("error", () => finish(1, undefined));
  });
  return job;
}
async function runBody(body, waitSecs, background, raw, ctx, pi, leanCtx) {
  const job = start(body, raw, ctx, pi, leanCtx);
  if (background) { expose(job, pi); return { content: [{ type: "text", text: `${body.id} → ${job.id} running` }], details: { bodyId: body.id, jobId: job.id, logPath: job.logPath, compressed: !raw } }; }
  const result = await Promise.race([job.done.then(() => "done"), delay(Math.max(0, waitSecs) * 1000).then(() => "wait")]);
  if (result === "done") {
    let view;
    try { view = readLogSlice(job.logPath); }
    catch (error) { throw new Error(`${body.id} exited ${job.exitCode}; ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    const out = formatLogView(view, job.logPath);
    const text = job.exitCode ? `${body.id} | EXIT ${job.exitCode}\n${out}` : `${body.id} | ${out}`;
    return { content: [{ type: "text", text }], details: { bodyId: body.id, exitCode: job.exitCode, logPath: job.logPath, outputLines: job.outputLines, compressed: !raw, ...logViewDetails(view) }, isError: !!job.exitCode };
  }
  expose(job, pi);
  try {
    const view = readLogSlice(job.logPath);
    const part = view.outputBytes ? formatLogView(view, job.logPath) : "";
    return { content: [{ type: "text", text: `${body.id} → ${job.id} running${part ? `\n\n${part}` : ""}` }], details: { bodyId: body.id, jobId: job.id, logPath: job.logPath, backgrounded: true, compressed: !raw, ...logViewDetails(view) } };
  } catch (error) {
    return { content: [{ type: "text", text: `${body.id} → ${job.id} running\n\n[Output preview unavailable: ${error instanceof Error ? error.message : String(error)}]` }], details: { bodyId: body.id, jobId: job.id, logPath: job.logPath, backgrounded: true, compressed: !raw, retrievalError: true } };
  }
}
function signalExitCode(signal) { return ({ SIGTERM: 143, SIGKILL: 137, SIGSTOP: 147, SIGCONT: 146 })[signal] || 1; }
function jobOutput(job, opts = {}) {
  const start = opts.delta ? lastRead.get(job.id) || 0 : 0;
  let view = opts.filter ? readFilteredLogSlice(job.logPath, opts.filter, start) : readLogSlice(job.logPath, start);
  view = limitLogViewLines(view, opts.lines);
  if (opts.delta) lastRead.set(job.id, view.snapshotEnd);
  const output = formatLogView(view, job.logPath, { delta: !!opts.delta, filter: !!opts.filter, lines: opts.lines });
  const total = Number.isInteger(job.outputLines) ? ` • ${outputCountLabel(job.outputLines)}` : "";
  const text = `${job.id} [${job.status}] ${elapsed(Date.now() - job.startTime)} — ${job.bodyId}${job.signal ? ` — ${job.signal}` : ""}${total}\n\n${output}`;
  return { text, details: logViewDetails(view) };
}

export default function(pi) {
  mkdirSync(LOG, { recursive: true, mode: 0o700 }); mkdirSync(SCR, { recursive: true, mode: 0o700 });
  const leanCtx = requireLeanCtxRuntime();
  pi.registerEntryRenderer?.("job-done", renderJobDoneEntry);

  pi.registerTool({
    name: "bash",
    label: "bash",
    renderShell: "self",
    renderCall: renderBashCall,
    renderResult: renderBashResult,
    description: "Run shell commands through extension-owned LeanCTX output handling. Output is protected verbatim or passthrough when fidelity requires it and command-aware compression otherwise; raw:true bypasses LeanCTX. Large model-facing results become bounded previews that name the exact session log. Soft waits never kill the process, and non-gating work can continue through jobs.",
    promptSnippet: "default: bash({command}); exact capture: bash({command,raw:true}); non-gating: bash({command,background:true}) then jobs({id,wait:30,delta:true}); rerun: bash({id:'sh-1',action:['run']})",
    promptGuidelines: [
      "Shell execution is LeanCTX-managed by default. Keep the default; use raw only when exact unmodified output is the claim or an external consumer must parse it. Raw bypasses LeanCTX, not the model-view bound; oversized exact output remains in the named session log.",
      "A fresh multiline command becomes a reusable sh-N cell; a first comment near the top becomes its scanning subtitle.",
      "Reuse a recent sh-N unchanged when it preserves known-good structure. Use list/show only when the cell id or content is uncertain; clone creates a separately named copy.",
      "wait is a soft foreground window, never a kill timeout. Foreground work that gates the next safe action; otherwise use background:true when useful independent work remains. A command that outlives wait also returns job-N.",
      "Poll a job before the first dependent action or completion claim. If concurrent work changed an input or shared state the job exercised, treat its result as stale. Completion cards are TUI-only status and never trigger or inform the model.",
      "A preview marker identifies omitted bytes and the exact session log. Inspect that path with read/search or a targeted Bash command before making a claim that depends on omitted output.",
      "Prefer runner-native quiet or concise test/build output in addition to LeanCTX handling; preserve exit status and failure diagnostics.",
      "Poll job-N with jobs({id,wait,delta:true}); filter narrows output and signal controls the whole process group."
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "Fresh command/script to run. Best for one-liners, genuinely new scripts, tiny throwaways, first versions, or broad rewrites. Before resending a similar multiline command, check whether a recent sh-N is a better starting point."
        },
        id: {
          type: "string",
          description: "Saved scratch-cell id like sh-1, or clone form old:new such as sh-1:sh-copy. Use for unchanged reruns, source display, or a separately named copy."
        },
        action: {
          type: "array",
          items: { type: "string", enum: ["run", "show", "clone", "list"] },
          description: "Actions for saved scripts. 'list' shows saved scratch cells. 'run' executes unchanged; 'show' prints numbered source and never runs; 'clone' copies old:new before an optional run. run and show are mutually exclusive."
        },
        background: {
          type: "boolean",
          description: "Run as job immediately. With saved scripts, requires action:['run']."
        },
        wait: {
          type: "number",
          description: "Soft foreground seconds before returning job-N (default 10); never kills. With saved scripts, requires action:['run']."
        },
        raw: {
          type: "boolean",
          description: "Bypass LeanCTX for exact uncompressed capture. Oversized model-facing text is still a bounded preview with the exact session-log path."
        },
      }
    },
    async execute(_tid, p, _s, _u, ctx) {
    const hasCommand = typeof p.command === "string", hasId = typeof p.id === "string", actions = Array.isArray(p.action) ? [...new Set(p.action)] : [];
    const wantsList = actions.includes("list");
    if (p.raw && wantsList) throw new Error("raw cannot be combined with action:['list']");
    if (hasCommand && hasId) throw new Error("Provide command for a new run or id for a saved script, not both");
    for (const a of actions) if (!["run", "show", "clone", "list"].includes(a)) throw new Error(`Unknown bash action ${a}`);
    if (wantsList) {
      if (hasCommand) throw new Error("action:['list'] cannot be combined with command");
      if (actions.length > 1) throw new Error("action:['list'] cannot be combined with run/show/clone");
      return { content: [{ type: "text", text: hasId ? summaryLine(getBody(p.id), "saved") : listBodies() }], details: hasId ? { bodyId: p.id } : undefined };
    }
    if (!hasCommand && !hasId) throw new Error("Provide command or id");
    if (actions.includes("run") && actions.includes("show")) throw new Error("action cannot include both run and show; show never runs");
    if (hasCommand) {
      if (actions.some(a => a !== "run")) throw new Error("with command, only action:['run'] is accepted and it is optional");
      const isMultiline = String(p.command).replace(/\r\n?/g, "\n").trim().includes("\n");
      const body = isMultiline ? saveBody(p.command) : makeBody(p.command);
      const prefix = body.saved ? `${overview(body, "created")}\n\n` : "";
      const r = await runBody(body, typeof p.wait === "number" ? p.wait : DEF_WAIT, !!p.background, !!p.raw, ctx, pi, leanCtx);
      r.content[0].text = prefix + r.content[0].text;
      return r;
    }
    if (p.background && !actions.includes("run")) throw new Error(`background requires action:['run']; retry with action:['run'] if you meant to execute ${p.id}.`);
    if (p.wait !== undefined && !actions.includes("run")) throw new Error(`wait requires action:['run']; retry with action:['run'] if you meant to execute ${p.id}.`);
    if (p.raw && !actions.includes("run")) throw new Error(`raw requires action:['run']; retry with action:['run'] if you meant to execute ${p.id}.`);
    const cloneSpec = String(p.id).split(":");
    if (actions.includes("clone") !== (cloneSpec.length === 2)) throw new Error("clone requires id:'old:new' and action:['clone']");
    if (cloneSpec.length > 2) throw new Error("Invalid id; clone form is old:new");
    let body = actions.includes("clone") ? cloneBody(cloneSpec[0], cloneSpec[1]) : getBody(p.id);
    let verb = actions.includes("clone") ? `cloned from ${cloneSpec[0]}` : "";
    let prefix = verb ? `${overview(body, verb)}\n\n` : "";
    if (actions.includes("show")) return { content: [{ type: "text", text: `${verb ? `${summaryLine(body, verb)}\n` : ""}${body.id} (${splitBody(body.body).length} lines)\n${numbered(body.body)}` }], details: { bodyId: body.id } };
    if (actions.includes("run")) { const r = await runBody(body, typeof p.wait === "number" ? p.wait : DEF_WAIT, !!p.background, !!p.raw, ctx, pi, leanCtx); r.content[0].text = prefix + r.content[0].text; return r; }
    if (actions.includes("clone")) return { content: [{ type: "text", text: prefix.trimEnd() }], details: { bodyId: body.id } };
    throw new Error("id requires action:['run'] or action:['show']");
  } });

  pi.registerTool({ name: "jobs", label: "jobs", renderShell: "self", renderCall: renderJobsCall, renderResult: renderJobsResult, description: "Inspect or control session-local background jobs. Poll with wait/delta/filter/lines; oversized views are bounded and name the exact session log. Delta advances to the reported snapshot end, and signal targets the whole process group. Completion cards are TUI-only and never trigger an agent turn.", promptSnippet: "jobs({id?, wait?, delta?, filter?, lines?, signal?})", promptGuidelines: ["Call jobs({}) to list running or stopped jobs.", "If a job gates the current task, poll it before claiming completion; a completion card is status for the human, not model evidence.", "Use jobs({id:'job-1', wait:30, delta:true}) to wait softly and return only output added since the previous delta poll. If a bounded delta omits unread bytes, its cursor still advances to the reported snapshot end; recover them from the named log.", "Use lines to retain only the final output lines when recent progress or the terminal summary is enough. Combine lines with delta and filter to reduce repeated input without changing the exact session log.", "Add filter for focused regex-matching lines. A bounded filtered preview names the complete unfiltered log. Use signal for term/kill/stop/cont on the complete process group; then poll once for the terminal status."], parameters: { type: "object", additionalProperties: false, properties: { id: { type: "string", description: "Job id, e.g. job-1. Omit to show active jobs." }, wait: { type: "number", description: "Wait up to N seconds for this job before returning status/output" }, delta: { type: "boolean", description: "Only output since the previous delta read; bounded previews advance through the reported snapshot." }, filter: { type: "string", description: "Regex filter for output lines; bounded matches retain the complete unfiltered log path." }, lines: { type: "number", minimum: 1, description: "Return only the final N output lines after delta and filter selection; the byte bound still applies." }, signal: { type: "string", enum: ["term", "kill", "stop", "cont"], description: "Signal the job process group" } } }, async execute(_tid, p) {
    if (p.lines !== undefined && (!Number.isInteger(p.lines) || p.lines < 1)) throw new Error("lines must be a positive integer");
    if (!p.id && p.lines !== undefined) throw new Error("lines requires a job id");
    if (!p.id) { const active = Array.from(jobs.values()).filter(j => j.status === "running" || j.status === "stopped"); return { content: [{ type: "text", text: active.length ? active.map(j => `${j.id} [${j.status}] ${elapsed(Date.now() - j.startTime)} — ${j.bodyId}`).join("\n") : "No active jobs." }] }; }
    if (!isJobId(p.id) || !jobs.has(p.id)) throw new Error(`Unknown job ${p.id}`);
    const job = jobs.get(p.id); job.notified = true;
    if (p.signal) { if (job.proc?.pid) killGroup(job.proc.pid, sig(p.signal)); if (p.signal === "stop") job.status = "stopped"; if (p.signal === "cont") job.status = "running"; return { content: [{ type: "text", text: `${job.id} sent ${sig(p.signal)}` }], details: { jobId: job.id } }; }
    if (typeof p.wait === "number" && job.status === "running") { job.waiting++; await Promise.race([job.done, delay(Math.max(0, p.wait) * 1000)]); job.waiting--; if (job.status !== "running") job.notified = true; }
    try {
      const output = jobOutput(job, p);
      return { content: [{ type: "text", text: output.text }], details: { jobId: job.id, status: job.status, logPath: job.logPath, exitCode: job.exitCode, signal: job.signal, ...output.details } };
    } catch (error) {
      throw new Error(`${job.id} [${job.status}]; ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  } });
  pi.on("session_shutdown", () => { try { for (const j of jobs.values()) { j.notified = true; if (j.status === "running" && j.proc?.pid) killGroup(j.proc.pid, "SIGTERM"); } for (const path of logPaths) { try { unlinkSync(path); } catch {} } for (const b of bodies.values()) { try { unlinkSync(b.path); } catch {} } for (const f of readdirSync(SCR)) { try { unlinkSync(`${SCR}/${f}`); } catch {} } jobs.clear(); bodies.clear(); lastRead.clear(); logPaths.clear(); } catch {} });
}
