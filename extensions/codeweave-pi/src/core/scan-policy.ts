import { open, readFile, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { VALUE_EXCLUDE_DIR_NAMES, VALUE_EXCLUDE_FILE_PATHS, VALUE_EXCLUDE_PATHS } from "./navigation-value-policy.ts";

export const DEFAULT_BROAD_TEXT_FILE_BYTES = envBytes("PI_NAV_GREP_BUFFERED_FILE_BYTES", 32 * 1024 * 1024);
export const DEFAULT_EXPLICIT_TEXT_FILE_BYTES = envBytes("PI_NAV_GREP_EXPLICIT_FILE_BYTES", 64 * 1024 * 1024);
export const DEFAULT_GREP_STREAM_FILE_BYTES = envBytes("PI_NAV_GREP_MAX_FILE_BYTES", 1024 * 1024 * 1024);
export const DEFAULT_SAMPLE_BYTES = envBytes("PI_NAV_SAMPLE_BYTES", 64 * 1024);
export const DEFAULT_TAGGED_READ_BYTES = envBytes("PI_NAV_TAGGED_READ_BYTES", 16 * 1024 * 1024);
export const DEFAULT_GRAPH_INDEX_BYTES = envBytes("PI_NAV_GRAPH_INDEX_BYTES", 256 * 1024 * 1024);
export const DEFAULT_GREP_CONTENT_BYTES = envBytes("PI_NAV_GREP_CONTENT_BYTES", 1024 * 1024 * 1024);
export const DEFAULT_EXPLORE_SAMPLE_BYTES_TOTAL = envBytes("PI_NAV_EXPLORE_SAMPLE_BYTES_TOTAL", 128 * 1024 * 1024);
export const DEFAULT_EXPLORE_MAX_SAMPLE_FILE_BYTES = envBytes("PI_NAV_EXPLORE_MAX_SAMPLE_FILE_BYTES", 1024 * 1024 * 1024);

function envBytes(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const match = /^(\d+(?:\.\d+)?)([kmgt]?i?b?)?$/i.exec(raw);
  if (!match) return fallback;
  const value = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit.startsWith("t") ? 1024 ** 4 : unit.startsWith("g") ? 1024 ** 3 : unit.startsWith("m") ? 1024 ** 2 : unit.startsWith("k") ? 1024 : 1;
  const bytes = Math.floor(value * multiplier);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : fallback;
}

const DEFAULT_SKIP_DIR_NAMES = new Set([
  ...VALUE_EXCLUDE_DIR_NAMES,
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".parcel-cache",
  ".turbo",
  ".tmp",
  "tmp",
  "temp",
  ".swarmvault",
  ".atlas-status",
  ".sage",
  ".pluck",
  ".rtfm",
]);

const DEFAULT_SKIP_DIR_PATHS = [...VALUE_EXCLUDE_PATHS];
const DEFAULT_SKIP_FILE_PATHS = [...VALUE_EXCLUDE_FILE_PATHS];

export const IMAGE_EXTENSIONS = new Set([".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp", ".bmp", ".avif", ".heic"]);

const BINARY_OR_HEAVY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".avi",
  ".avif",
  ".bin",
  ".bmp",
  ".bz2",
  ".class",
  ".db",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".heic",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".p12",
  ".pfx",
  ".ppt",
  ".pptx",
  ".pyc",
  ".rar",
  ".rlib",
  ".sqlite",
  ".sqlite3",
  ".so",
  ".tar",
  ".tgz",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".xz",
  ".zip",
  ".zst",
]);

const NAVIGATION_IGNORE_FILE = ".pi-navigation-ignore";

export interface ScanStats {
  filesYielded: number;
  dirsVisited: number;
  dirsSkipped: number;
  filesSkipped: number;
  skippedByDefault: number;
  skippedByIgnore: number;
  skippedByExtension: number;
  skippedLarge: number;
  skippedBinary: number;
  skippedByBudget: number;
  readErrors: number;
  bytesRead: number;
  truncated: boolean;
}

export interface ScanPolicy {
  root: string;
  ignoreRules: IgnoreRule[];
}

interface IgnoreRule {
  source: string;
  pattern: string;
  directoryOnly: boolean;
  hasSlash: boolean;
  basenameOnly: boolean;
  regex?: RegExp;
}

export interface TextReadOk {
  ok: true;
  text: string;
  size: number;
}

export interface TextReadSkip {
  ok: false;
  reason: "large" | "binary" | "extension" | "budget" | "error" | "aborted";
  size?: number;
  detail?: string;
}

export function createScanStats(): ScanStats {
  return {
    filesYielded: 0,
    dirsVisited: 0,
    dirsSkipped: 0,
    filesSkipped: 0,
    skippedByDefault: 0,
    skippedByIgnore: 0,
    skippedByExtension: 0,
    skippedLarge: 0,
    skippedBinary: 0,
    skippedByBudget: 0,
    readErrors: 0,
    bytesRead: 0,
    truncated: false,
  };
}

export async function createScanPolicy(root: string): Promise<ScanPolicy> {
  const base = await nearestProjectRoot(root).catch(() => root);
  const roots = uniquePaths([base, root]);
  const ignoreRules: IgnoreRule[] = [];

  for (const path of navigationIgnoreFiles()) {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (!text) continue;
    ignoreRules.push(...parseIgnoreRules(text, base, path));
  }

  for (const ignoreRoot of roots) {
    const path = join(ignoreRoot, NAVIGATION_IGNORE_FILE);
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (!text) continue;
    ignoreRules.push(...parseIgnoreRules(text, ignoreRoot, NAVIGATION_IGNORE_FILE));
  }
  return { root: base, ignoreRules };
}

function navigationIgnoreFiles(): string[] {
  const files: string[] = [];
  const configured = process.env.PI_NAV_IGNORE?.split(delimiter).map(item => item.trim()).filter(Boolean) ?? [];
  files.push(...configured);
  if (process.env.PI_AGENT_DIR) files.push(join(process.env.PI_AGENT_DIR, NAVIGATION_IGNORE_FILE));
  files.push(join(dirname(fileURLToPath(import.meta.url)), "../../../..", NAVIGATION_IGNORE_FILE));
  return uniquePaths(files);
}

async function nearestProjectRoot(path: string): Promise<string> {
  const startInfo = await stat(path).catch(() => undefined);
  let current = startInfo?.isFile() ? dirname(path) : path;
  for (;;) {
    for (const marker of [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", ".pi-navigation-ignore"]) {
      if (await stat(join(current, marker)).then(() => true, () => false)) return current;
    }
    const parent = dirname(current);
    if (parent === current) return path;
    current = parent;
  }
}

function parseIgnoreRules(text: string, root: string, sourceName: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    let pattern = trimmed.replace(/^\/+/, "");
    const directoryOnly = pattern.endsWith("/");
    pattern = pattern.replace(/\/+$/, "");
    if (!pattern) continue;
    const hasSlash = pattern.includes("/");
    const basenameOnly = !hasSlash && !/[?*\[]/.test(pattern);
    rules.push({
      source: isAbsolute(sourceName) ? sourceName : join(root, sourceName),
      pattern,
      directoryOnly,
      hasSlash,
      basenameOnly,
      regex: basenameOnly ? undefined : ignorePatternToRegExp(pattern, directoryOnly, hasSlash),
    });
  }
  return rules;
}

export function shouldSkipDirectory(path: string, name: string, policy: ScanPolicy, stats?: ScanStats, options: { allowDefaultNames?: Set<string> } = {}): boolean {
  if (DEFAULT_SKIP_DIR_NAMES.has(name) && !options.allowDefaultNames?.has(name)) {
    recordDirSkip(stats, "default");
    return true;
  }
  const rel = normalizeRelative(policy.root, path);
  if (DEFAULT_SKIP_DIR_PATHS.some(pattern => rel === pattern || rel.startsWith(`${pattern}/`) || rel.endsWith(`/${pattern}`))) {
    recordDirSkip(stats, "default");
    return true;
  }
  if (matchesIgnore(path, true, policy)) {
    recordDirSkip(stats, "ignore");
    return true;
  }
  return false;
}

// True for well-known generated/vendor/cache directory names (node_modules,
// dist, build, .git, etc.). Used by shallow directory overviews to show these
// as "skipped" rather than ordinary browsable entries.
export function isDefaultSkippedDirName(name: string): boolean {
  return DEFAULT_SKIP_DIR_NAMES.has(name);
}

export function shouldSkipFilePath(path: string, policy: ScanPolicy, stats?: ScanStats): boolean {
  if (isBinaryOrHeavyExtension(path)) {
    recordFileSkip(stats, "extension");
    return true;
  }
  const rel = normalizeRelative(policy.root, path);
  if (DEFAULT_SKIP_FILE_PATHS.some(pattern => rel === pattern || rel.endsWith(`/${pattern}`))) {
    recordFileSkip(stats, "ignore");
    return true;
  }
  if (matchesIgnore(path, false, policy)) {
    recordFileSkip(stats, "ignore");
    return true;
  }
  return false;
}

export function isBinaryOrHeavyExtension(path: string): boolean {
  const match = /\.[^./\\]+$/.exec(path.toLowerCase());
  return Boolean(match && BINARY_OR_HEAVY_EXTENSIONS.has(match[0]));
}

export async function readTextFileSafely(path: string, options: { maxBytes?: number; byteBudget?: number; signal?: AbortSignal; stats?: ScanStats } = {}): Promise<TextReadOk | TextReadSkip> {
  if (options.signal?.aborted) return { ok: false, reason: "aborted" };
  if (isBinaryOrHeavyExtension(path)) {
    recordFileSkip(options.stats, "extension");
    return { ok: false, reason: "extension" };
  }
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    recordReadError(options.stats);
    return { ok: false, reason: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_BROAD_TEXT_FILE_BYTES;
  if (info.size > maxBytes) {
    recordFileSkip(options.stats, "large");
    return { ok: false, reason: "large", size: info.size, detail: `>${formatBytes(maxBytes)}` };
  }
  if (options.stats && options.byteBudget !== undefined && options.stats.bytesRead + info.size > options.byteBudget) {
    recordFileSkip(options.stats, "budget");
    options.stats.truncated = true;
    return { ok: false, reason: "budget", size: info.size, detail: `content budget ${formatBytes(options.byteBudget)} reached` };
  }
  try {
    const buffer = await readFile(path);
    if (options.stats) options.stats.bytesRead += buffer.length;
    if (options.signal?.aborted) return { ok: false, reason: "aborted" };
    if (looksBinary(buffer)) {
      recordFileSkip(options.stats, "binary");
      return { ok: false, reason: "binary", size: info.size };
    }
    return { ok: true, text: buffer.toString("utf8"), size: info.size };
  } catch (error) {
    recordReadError(options.stats);
    return { ok: false, reason: "error", size: info.size, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function readTextSampleSafely(path: string, options: { maxFileBytes?: number; sampleBytes?: number; byteBudget?: number; signal?: AbortSignal; stats?: ScanStats } = {}): Promise<TextReadOk | TextReadSkip> {
  if (options.signal?.aborted) return { ok: false, reason: "aborted" };
  if (isBinaryOrHeavyExtension(path)) {
    recordFileSkip(options.stats, "extension");
    return { ok: false, reason: "extension" };
  }
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    recordReadError(options.stats);
    return { ok: false, reason: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_BROAD_TEXT_FILE_BYTES;
  if (info.size > maxFileBytes) {
    recordFileSkip(options.stats, "large");
    return { ok: false, reason: "large", size: info.size, detail: `>${formatBytes(maxFileBytes)}` };
  }
  const sampleBytes = Math.min(options.sampleBytes ?? DEFAULT_SAMPLE_BYTES, Math.max(0, info.size));
  if (options.stats && options.byteBudget !== undefined && options.stats.bytesRead + sampleBytes > options.byteBudget) {
    recordFileSkip(options.stats, "budget");
    options.stats.truncated = true;
    return { ok: false, reason: "budget", size: info.size, detail: `sample budget ${formatBytes(options.byteBudget)} reached` };
  }
  const handle = await open(path, "r").catch((error) => {
    recordReadError(options.stats);
    return { error } as const;
  });
  if ("error" in handle) return { ok: false, reason: "error", size: info.size, detail: handle.error instanceof Error ? handle.error.message : String(handle.error) };
  try {
    const buffer = Buffer.alloc(sampleBytes);
    const { bytesRead } = await handle.read(buffer, 0, sampleBytes, 0);
    if (options.stats) options.stats.bytesRead += bytesRead;
    const sample = buffer.subarray(0, bytesRead);
    if (looksBinary(sample)) {
      recordFileSkip(options.stats, "binary");
      return { ok: false, reason: "binary", size: info.size };
    }
    return { ok: true, text: sample.toString("utf8"), size: info.size };
  } catch (error) {
    recordReadError(options.stats);
    return { ok: false, reason: "error", size: info.size, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.08;
}

export function recordFileSkip(stats: ScanStats | undefined, reason: "default" | "ignore" | "extension" | "large" | "binary" | "budget"): void {
  if (!stats) return;
  stats.filesSkipped++;
  if (reason === "default") stats.skippedByDefault++;
  else if (reason === "ignore") stats.skippedByIgnore++;
  else if (reason === "extension") stats.skippedByExtension++;
  else if (reason === "large") stats.skippedLarge++;
  else if (reason === "binary") stats.skippedBinary++;
  else if (reason === "budget") stats.skippedByBudget++;
}

export function recordReadError(stats: ScanStats | undefined): void {
  if (!stats) return;
  stats.readErrors++;
}

function recordDirSkip(stats: ScanStats | undefined, reason: "default" | "ignore"): void {
  if (!stats) return;
  stats.dirsSkipped++;
  if (reason === "default") stats.skippedByDefault++;
  else stats.skippedByIgnore++;
}

function matchesIgnore(path: string, directory: boolean, policy: ScanPolicy): boolean {
  if (!policy.ignoreRules.length) return false;
  const rel = normalizeRelative(policy.root, path);
  const base = basename(path);
  const segments = rel.split("/").filter(Boolean);
  for (const rule of policy.ignoreRules) {
    if (rule.directoryOnly && !directory) continue;
    if (rule.basenameOnly) {
      if (base === rule.pattern || (directory && segments.includes(rule.pattern))) return true;
      continue;
    }
    if (rule.regex?.test(rel)) return true;
  }
  return false;
}

function normalizeRelative(root: string, path: string): string {
  const rel = relative(root, path).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : path.replace(/\\/g, "/");
}

function ignorePatternToRegExp(pattern: string, directoryOnly: boolean, hasSlash: boolean): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
  const source = globToRegexSource(normalized);
  if (!hasSlash) return new RegExp(`(^|/)${source}${directoryOnly ? "(/|$)" : "($|/)"}`);
  return new RegExp(`(^|/)${source}${directoryOnly ? "(/|$)" : "($|/)"}`);
}

function globToRegexSource(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length; index++) {
    const ch = glob[index];
    if (ch === "*") {
      if (glob[index + 1] === "*") {
        out += ".*";
        index++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return out;
}

function uniquePaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const path of paths) if (!out.includes(path)) out.push(path);
  return out;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(2)} GiB`;
}

export function formatScanSkipSummary(stats: ScanStats): string {
  const skipped: string[] = [];
  if (stats.dirsSkipped) skipped.push(`${stats.dirsSkipped} dirs`);
  if (stats.skippedLarge) skipped.push(`${stats.skippedLarge} large`);
  if (stats.skippedBinary) skipped.push(`${stats.skippedBinary} binary`);
  if (stats.skippedByExtension) skipped.push(`${stats.skippedByExtension} binary/media`);
  if (stats.skippedByIgnore) skipped.push(`${stats.skippedByIgnore} ignored`);
  if (stats.skippedByDefault) skipped.push(`${stats.skippedByDefault} generated/vendor`);
  if (stats.skippedByBudget) skipped.push(`${stats.skippedByBudget} over size budget`);
  if (stats.readErrors) skipped.push(`${stats.readErrors} unreadable`);

  const parts: string[] = [];
  if (stats.bytesRead) parts.push(`Read ${formatBytes(stats.bytesRead)}.`);
  if (skipped.length) parts.push(`Skipped ${skipped.join(", ")}.`);
  if (stats.truncated) parts.push(stats.skippedByBudget ? "Scan limit or size budget reached." : "Scan limit reached.");
  return parts.join(" ");
}

// True when the scan did not examine every candidate file (capped, or files were
// skipped by policy/budget/errors). Used so tools can warn that a no-match result
// is not proof of absence.
export function scanWasIncomplete(stats: ScanStats): boolean {
  return stats.truncated
    || stats.dirsSkipped > 0
    || stats.skippedLarge > 0
    || stats.skippedBinary > 0
    || stats.skippedByExtension > 0
    || stats.skippedByIgnore > 0
    || stats.skippedByDefault > 0
    || stats.skippedByBudget > 0
    || stats.readErrors > 0;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new Error("Operation aborted before scan completed.");
}
