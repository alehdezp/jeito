// ADR-002.003 owns persistent page caching, smart views, tolerant URL grouping,
// pattern search, and bounded crawl manifests.
// Cache lives indefinitely under <cwd>/.cache/web/<host>/; files stay flat per host.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { nativeMarkdownOutline } from "./pi-nav-outline.ts";

export const TOKEN_CHARS = 4; // deterministic ceil(chars/4) token estimate
export const FULL_CONTENT_TOKEN_CAP = 5_000; // universal: full body only when it fits the model-visible source budget (schema v2)
export const SECTION_EXCERPT_CHARS = 300; // ~75 estimated tokens under each section
export const SMART_VIEW_TOKEN_CAP = 2_000;
export const HEADING_CAP = 10;
export const MAX_EXPLICIT_BATCH = 10;
export const MAX_CRAWL_PAGES = 25;
export const MAX_CRAWL_BYTES = 50 * 1024 * 1024;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS);
}

// ---------------------------------------------------------------------------
// Tolerant URL input: grouped strings, escapes, query-value protection, relative
// resolution, canonicalization, dedupe, and the explicit batch cap.
// ---------------------------------------------------------------------------

const ABSOLUTE_START = /^(?:https?:\/\/|\/)/;

/** Split a grouped URL string on unescaped comma/semicolon. Once a token contains
 *  `?` or `#`, a separator only splits when the following non-space text begins
 *  with http://, https://, or /; otherwise it belongs to the query/fragment value. */
export function splitGrouped(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let escaped = false;
  let hasQueryish = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === "?" || ch === "#") hasQueryish = true;
    if (ch === "," || ch === ";") {
      if (hasQueryish) {
        let j = i + 1;
        while (j < input.length && /\s/.test(input[j]!)) j++;
        if (ABSOLUTE_START.test(input.slice(j))) {
          tokens.push(current); current = ""; hasQueryish = false; continue;
        }
        current += ch; // separator is part of the query value
        continue;
      }
      tokens.push(current); current = "";
      continue;
    }
    current += ch;
  }
  tokens.push(current);
  return tokens.map((token) => token.trim()).filter(Boolean);
}

export interface NormalizedUrls { urls: string[]; truncated: number; invalidCount: number }

/** Flatten string/array inputs, group-split each string, resolve relative tokens
 *  against the current HTTP(S) origin, canonicalize, drop fragments, dedupe, and
 *  visibly cap explicit batches at MAX_EXPLICIT_BATCH. */
export function normalizeUrls(raw: Array<string | string[]>): NormalizedUrls {
  const seen = new Set<string>();
  const urls: string[] = [];
  let origin: URL | undefined;
  let invalidCount = 0;
  for (const item of raw) {
    const group = Array.isArray(item) ? item : [item];
    for (const value of group) {
      for (const token of splitGrouped(value ?? "")) {
        let canonical: string | undefined;
        try {
          const u = /^https?:\/\//i.test(token) ? new URL(token) : origin ? new URL(token, origin) : null;
          if (u && (u.protocol === "http:" || u.protocol === "https:")) {
            u.hash = "";
            canonical = u.href;
            origin = new URL(u.origin + "/");
          }
        } catch { /* invalid token */ }
        if (canonical && !seen.has(canonical)) { seen.add(canonical); urls.push(canonical); }
        else if (!canonical) invalidCount++;
      }
    }
  }
  const truncated = Math.max(0, urls.length - MAX_EXPLICIT_BATCH);
  return { urls: urls.slice(0, MAX_EXPLICIT_BATCH), truncated, invalidCount };
}

// ---------------------------------------------------------------------------
// Secret-safe URL display/metadata.
// ---------------------------------------------------------------------------

const SECRET_QUERY_KEY = /(?:^|[_-])(?:api_?key|access_?token|refresh_?token|token|secret|credential|password|passwd|auth|authorization|signature|sig)(?:$|[_-])/i;

/** Strip URL userinfo and replace recognized secret query values with [redacted]. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    for (const key of [...u.searchParams.keys()]) if (SECRET_QUERY_KEY.test(key)) u.searchParams.set(key, "[redacted]");
    return u.href;
  } catch {
    return url;
  }
}

function redactTitle(title: string): string {
  try { new URL(title); return redactUrl(title); } catch { return title; }
}

// ---------------------------------------------------------------------------
// Persistent cache: identity (canonical URL + extraction mode), flat per-host
// files with a short SHA-256 suffix, atomic 0600 writes, YAML frontmatter.
// ---------------------------------------------------------------------------

export interface CacheMeta {
  sourceUrl: string;
  canonicalUrl: string;
  created: string;
  updated: string;
  fetchedAt: string;
  provider: string;
  fetchMode: string;
  contentHash: string;
  estimatedTokens: number;
  extract: string;
  title: string;
  pattern?: string;
  crawlSeed?: string;
  description?: string;
  author?: string;
  language?: string;
  wordCount?: number;
}

export interface CacheEntry { path: string; meta: CacheMeta; body: string; bodyStartLine: number }

export function cacheRoot(cwd: string): string {
  return join(cwd, ".cache", "web");
}

export function cachePath(canonicalUrl: string, extract: string, root: string): string {
  const u = new URL(canonicalUrl);
  const segments = u.pathname.split("/").filter(Boolean);
  const base = (segments.length ? segments.join("_") : "index").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "index";
  const digest = createHash("sha256").update(`${canonicalUrl}::${extract}`).digest("hex").slice(0, 8);
  return join(root, u.host, `${base}_${digest}.md`);
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* temp may already have been renamed */ }
    throw error;
  }
}

function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string; bodyStartLine: number } | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n");
  if (end < 0) return undefined;
  let meta: unknown;
  try { meta = parse(text.slice(4, end)); } catch { return undefined; }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const bodyOffset = end + 5;
  return { meta: meta as Record<string, unknown>, body: text.slice(bodyOffset), bodyStartLine: text.slice(0, bodyOffset).split("\n").length };
}

function cacheMeta(raw: Record<string, unknown>): CacheMeta | undefined {
  const requiredStrings = ["source_url", "canonical_url", "created", "updated", "fetched_at", "provider", "fetch_mode", "content_hash", "extract", "title"] as const;
  if (requiredStrings.some((key) => typeof raw[key] !== "string") || typeof raw.estimated_tokens !== "number") return undefined;
  return {
    sourceUrl: raw.source_url as string,
    canonicalUrl: raw.canonical_url as string,
    created: raw.created as string,
    updated: raw.updated as string,
    fetchedAt: raw.fetched_at as string,
    provider: raw.provider as string,
    fetchMode: raw.fetch_mode as string,
    contentHash: raw.content_hash as string,
    estimatedTokens: raw.estimated_tokens as number,
    extract: raw.extract as string,
    title: raw.title as string,
    ...(typeof raw.pattern === "string" ? { pattern: raw.pattern } : {}),
    ...(typeof raw.crawl_seed === "string" ? { crawlSeed: raw.crawl_seed } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.author === "string" ? { author: raw.author } : {}),
    ...(typeof raw.language === "string" ? { language: raw.language } : {}),
    ...(typeof raw.word_count === "number" ? { wordCount: raw.word_count as number } : {}),
  };
}

export function readCachePath(path: string): CacheEntry | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; }
  const parsed = parseFrontmatter(text);
  if (!parsed) return undefined;
  const meta = cacheMeta(parsed.meta);
  if (!meta || createHash("sha256").update(parsed.body).digest("hex") !== meta.contentHash) return undefined;
  return { path, meta, body: parsed.body, bodyStartLine: parsed.bodyStartLine };
}

export function readCache(canonicalUrl: string, extract: string, root: string): CacheEntry | undefined {
  const entry = readCachePath(cachePath(canonicalUrl, extract, root));
  if (!entry || entry.meta.canonicalUrl !== redactUrl(canonicalUrl) || entry.meta.extract !== extract) return undefined;
  return entry;
}

export interface CacheWriteInput {
  canonicalUrl: string;
  sourceUrl: string;
  provider: string;
  fetchMode: string;
  extract: string;
  title: string;
  body: string;
  createdAt?: string; // preserve `created` on refresh
  pattern?: string;
  crawlSeed?: string;
  description?: string;
  author?: string;
  language?: string;
  wordCount?: number;
}
export function writeCache(input: CacheWriteInput, root: string): CacheEntry {
  const existing = readCache(input.canonicalUrl, input.extract, root);
  const now = new Date().toISOString();
  const created = existing?.meta.created ?? input.createdAt ?? now;
  const meta: CacheMeta = {
    sourceUrl: redactUrl(input.sourceUrl),
    canonicalUrl: redactUrl(input.canonicalUrl),
    created,
    updated: now,
    fetchedAt: now,
    provider: input.provider,
    fetchMode: input.fetchMode,
    contentHash: createHash("sha256").update(input.body).digest("hex"),
    estimatedTokens: estimateTokens(input.body),
    extract: input.extract,
    title: redactTitle(input.title),
    ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
    ...(input.crawlSeed !== undefined ? { crawlSeed: redactUrl(input.crawlSeed) } : {}),
    ...(input.description !== undefined ? { description: input.description }: {}),
    ...(input.author !== undefined ? { author: input.author } : {}),
    ...(input.language !== undefined ? { language: input.language } : {}),
    ...(input.wordCount !== undefined ? { wordCount: input.wordCount } : {}),
  };
  const diskMeta = {
    source_url: meta.sourceUrl, canonical_url: meta.canonicalUrl, created: meta.created, updated: meta.updated,
    fetched_at: meta.fetchedAt, provider: meta.provider, fetch_mode: meta.fetchMode, content_hash: meta.contentHash,
    estimated_tokens: meta.estimatedTokens, extract: meta.extract, title: meta.title,
    ...(meta.pattern !== undefined ? { pattern: meta.pattern } : {}),
    ...(meta.crawlSeed !== undefined ? { crawl_seed: meta.crawlSeed } : {}),
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    ...(meta.author !== undefined ? { author: meta.author } : {}),
    ...(meta.language !== undefined ? { language: meta.language } : {}),
    ...(meta.wordCount !== undefined ? { word_count: meta.wordCount } : {}),
  };
  const path = cachePath(input.canonicalUrl, input.extract, root);
  const prefix = `---\n${stringify(diskMeta)}---\n`;
  atomicWrite(path, prefix + input.body);
  return { path, meta, body: input.body, bodyStartLine: prefix.split("\n").length };
}

// ---------------------------------------------------------------------------
// Smart view: source card, complete ##-##### hierarchy with cache lines,
// and bounded top-of-section excerpts. No separate link inventory.
// ---------------------------------------------------------------------------

interface Section { heading: string; text: string; headingLine?: number }

function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  const lines = body.split("\n");
  let inFence = false;
  let fenceChar = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fenceMatch = line.match(/^(\s*)(```|~~~)/);
    if (fenceMatch) {
      const marker = fenceMatch[2]!;
      if (!inFence) { inFence = true; fenceChar = marker; }
      else if (marker === fenceChar) { inFence = false; fenceChar = ""; }
      if (current) current.text += line + "\n";
      continue;
    }
    if (inFence) {
      if (current) current.text += line + "\n";
      continue;
    }
    // ATX heading level 2-6
    if (/^#{2,6}\s+/.test(line)) {
      if (current) sections.push(current);
      current = { heading: line, headingLine: index + 1, text: "" };
      continue;
    }
    // Setext heading (level 1 `===` or level 2 `---` underline)
    const next = lines[index + 1];
    if (next !== undefined && line.trim() && /^(=+|-+)\s*$/.test(next)) {
      const level = next.trim().startsWith("=") ? 1 : 2;
      const heading = `${"#".repeat(level)} ${line.trim()}`;
      if (level >= 2 && level <= 6) {
        if (current) sections.push(current);
        current = { heading, headingLine: index + 1, text: "" };
      } else {
        // H1 setext: treat as preamble, not a section (mirrors native H1 filter)
        if (current) current.text += line + "\n" + next + "\n";
        else {
          // no current section yet: preamble content before first H2, preserve for excerpt fallback
        }
      }
      index++; // consume underline
      continue;
    }
    if (current) current.text += line + "\n";
  }
  if (current) sections.push(current);
  return sections;
}

function excerpt(text: string, chars: number): string {
  const t = text.replace(/^\s+/, "").replace(/\s+$/, "");
  if (t.length <= chars) return t;
  const cut = t.slice(0, chars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > chars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + " …";
}


export interface SmartViewOptions {
  title: string;
  url: string;
  requestedUrl?: string;
  path: string;
  status: string;
  tokens: number;
  body: string;
  bodyStartLine: number;
  fetchedAt?: string;
  description?: string;
  author?: string;
  language?: string;
  wordCount?: number;
}

function cacheStatusText(status: string): string {
  switch (status.replace(/_/g, " ").toLowerCase()) {
    case "cache hit":
      return "cache hit — download to refresh";
    case "fresh":
      return "fresh fetch";
    case "refresh":
      return "refreshed";
    default:
      return status;
  }
}

export function smartViewHead(opts: SmartViewOptions): string[] {
  const meta: string[] = [];
  if (opts.author) meta.push(`Author: ${opts.author}`);
  if (opts.language) meta.push(`Language: ${opts.language}`);
  if (opts.wordCount !== undefined && Number.isFinite(opts.wordCount)) meta.push(`Words: ${opts.wordCount.toLocaleString()}`);
  return [
    `# ${opts.title}`,
    "",
    ...(opts.description ? [`> ${opts.description.replace(/\s*\n+\s*/g, " ").trim()}`] : []),
    ...(meta.length ? [meta.join(" · ")] : []),
    `Source: ${opts.url}`,
    ...(opts.requestedUrl && opts.requestedUrl !== opts.url ? [`Requested: ${opts.requestedUrl}`] : []),
    `Cache: ${opts.path} · ~${opts.tokens} tokens · ${cacheStatusText(opts.status)}${opts.fetchedAt ? ` · fetched ${opts.fetchedAt.slice(0, 10)}` : ""}`,
    "",
  ];
}

function jsSmartViewFallback(opts: SmartViewOptions): string {
  const head = smartViewHead(opts);
  const sections = splitSections(opts.body);
  if (!sections.length) {
    const available = Math.max(0, SMART_VIEW_TOKEN_CAP * TOKEN_CHARS - head.join("\n").length);
    return [...head, excerpt(opts.body, Math.min(SECTION_EXCERPT_CHARS, available))].join("\n");
  }
  const headings = sections.map((section) => `${section.heading} (cache line ${opts.bodyStartLine - 1 + section.headingLine!})`);
  const fixed = [...head, ...headings].join("\n");
  let available = Math.max(0, SMART_VIEW_TOKEN_CAP * TOKEN_CHARS - fixed.length - 1);
  const body: string[] = [...head];
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index]!;
    body.push(headings[index]!);
    if (available <= 3 || !section.text.trim()) continue;
    const part = excerpt(section.text, Math.min(SECTION_EXCERPT_CHARS, available - 2));
    if (!part) continue;
    body.push(part);
    available -= part.length + 1;
  }
  if (estimateTokens(fixed) > SMART_VIEW_TOKEN_CAP)
    body.push(`Heading hierarchy alone exceeds the normal ~${SMART_VIEW_TOKEN_CAP.toLocaleString()}-token smart-view ceiling; headings were preserved.`);
  return body.join("\n");
}

/** Synchronous smart view (JS fallback only). Used by downloadText/tests. For native outline use smartViewAsync. */
export function smartView(opts: SmartViewOptions): string {
  return jsSmartViewFallback(opts);
}

/** Async smart view: native pi-nav Markdown outline when available, JS fallback otherwise. */
export async function smartViewAsync(opts: SmartViewOptions): Promise<string> {
  const head = smartViewHead(opts);
  const native = await nativeMarkdownOutline(opts.body);
  if (native && native.trim()) {
    const rawLines = native.split("\n").filter(Boolean);
    // Filter H1: the card already shows `# title`, so level-1 headings are redundant.
    // Also keep omission notes ("(… code blocks)" / "outline truncated") verbatim.
    const filtered = rawLines.filter((line) => {
      const m = line.match(/^\s*\[(\d+)-(\d+)\]\s*(.*)$/);
      if (!m) return true;
      const title = (m[3] ?? "").trimStart();
      const level = (title.match(/^#+/)?.[0].length ?? 0);
      if (level === 1) return false;
      if (title.replace(/^#+\s+/, "").trim() === opts.title.trim()) return false;
      return true;
    });
    const outlineLines = filtered.map((line) => {
      const m = line.match(/^\s*\[(\d+)-(\d+)\]\s*(.*)$/);
      if (!m) return line;
      const start = Number(m[1]);
      const title = m[3] ?? "";
      const cacheLine = opts.bodyStartLine - 1 + start;
      return `${title} (cache line ${cacheLine})`;
    });
    const fixed = [...head, ...outlineLines].join("\n");
    if (estimateTokens(fixed) > SMART_VIEW_TOKEN_CAP) {
      return [...head, ...outlineLines, `Heading hierarchy alone exceeds the normal ~${SMART_VIEW_TOKEN_CAP.toLocaleString()}-token smart-view ceiling; headings were preserved.`].join("\n");
    }
    // Excerpts: map native heading -> JS section text by normalized title.
    // Native truncates titles at 80 chars with "…"; normalize both sides to avoid map misses.
    const normalize = (s: string) => s.replace(/^#+\s+/, "").replace(/\s+/g, " ").trim().toLowerCase();
    const nativeTitle = (line: string) => line.replace(/\s*\(cache line.*/, "").trim();
    const sections = splitSections(opts.body);
    const sectionByTitle = new Map<string, typeof sections[number]>();
    for (const s of sections) {
      const key = normalize(s.heading);
      if (!sectionByTitle.has(key)) sectionByTitle.set(key, s);
    }
    // For truncated native titles, also index by truncated prefix
    const sectionByTruncated = new Map<string, typeof sections[number]>();
    for (const s of sections) {
      const norm = normalize(s.heading);
      const truncated = norm.length > 77 ? norm.slice(0, 77) : norm;
      if (!sectionByTruncated.has(truncated)) sectionByTruncated.set(truncated, s);
    }
    let available = Math.max(0, SMART_VIEW_TOKEN_CAP * TOKEN_CHARS - fixed.length - 1);
    const body: string[] = [...head];
    const used = new Set<typeof sections[number]>();
    for (const outlineLine of outlineLines) {
      body.push(outlineLine);
      if (available <= 3) continue;
      if (!outlineLine.includes("cache line")) continue; // omission notes have no excerpt
      const key = normalize(nativeTitle(outlineLine));
      let sec = sectionByTitle.get(key);
      if (!sec) {
        // Native truncates long titles: try truncated prefix lookup
        const truncatedKey = key.length > 77 ? key.slice(0, 77) : key;
        sec = sectionByTruncated.get(truncatedKey);
      }
      if (!sec) {
        // Fallback: prefix match (native "X..." vs full "XXXX...")
        const stripped = key.replace(/\.\.\.$/, "").trim();
        if (stripped.length >= 20) {
          for (const [k, v] of sectionByTitle) {
            if (k.startsWith(stripped) || stripped.startsWith(k)) { sec = v; break; }
          }
        }
      }
      if (!sec || used.has(sec) || !sec.text.trim()) continue;
      used.add(sec);
      const part = excerpt(sec.text, Math.min(SECTION_EXCERPT_CHARS, available - 2));
      if (!part) continue;
      body.push(part);
      available -= part.length + 1;
    }
    return body.join("\n");
  }
  return jsSmartViewFallback(opts);
}
export function leadingHeadings(body: string, limit = HEADING_CAP): string[] {
  return splitSections(body).map(s => s.heading).slice(0, limit);
}
// ---------------------------------------------------------------------------
// Crawl manifest (JSON, flat in the host folder).
// ---------------------------------------------------------------------------

/** Compact batch card: title + description + url + cache path, then only `##`
 *  headings with the cache-line range to read each. Keeps multi-source results
 *  scannable instead of repeating full smart views. */
export function smartViewIndex(opts: SmartViewOptions): string {
  const sections = splitSections(opts.body);
  const h2 = sections.filter((s) => /^##\s+/.test(s.heading));
  const offset = opts.bodyStartLine - 1;
  const bodyLineCount = opts.body.split("\n").length;
  const lines: string[] = [
    `### ${opts.title}`,
    ...(opts.description ? [`> ${opts.description.replace(/\s*\n+\s*/g, " ").trim()}`] : []),
    `Source: ${opts.url}`,
    ...(opts.requestedUrl && opts.requestedUrl !== opts.url ? [`Requested: ${opts.requestedUrl}`] : []),
    `Cache: ${opts.path} · ~${opts.tokens} tokens · ${cacheStatusText(opts.status)}${opts.fetchedAt ? ` · fetched ${opts.fetchedAt.slice(0, 10)}` : ""}`,
  ];
  if (!h2.length) {
    lines.push("(no ## sections)");
    return lines.join("\n");
  }
  for (let i = 0; i < h2.length; i++) {
    const s = h2[i]!;
    const start = offset + s.headingLine!;
    const end = i + 1 < h2.length ? offset + h2[i + 1]!.headingLine! - 1 : offset + bodyLineCount;
    const text = s.heading.replace(/^##\s+/, "");
    lines.push(`## ${text} (read ${start}-${end})`);
  }
  return lines.join("\n");
}

export function writeCrawlManifest(host: string, seed: string, data: unknown, root: string): string {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const path = join(root, host, `_crawl_${digest}.json`);
  atomicWrite(path, JSON.stringify(data, null, 2) + "\n");
  return path;
}
