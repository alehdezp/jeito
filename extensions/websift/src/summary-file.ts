// ADR-002.003 + ADR-002.005: llm_answer summary persistence.
// Each immutable sidecar is keyed by cache bytes + objective + query_terms:
//   <cachePath>.summary-<16 hex>.md
// Legacy <cachePath>.summary.md files remain exact-match readable but are never rewritten.
// YAML frontmatter binds source, cache path, content hash, intent, generation time, and
// model. Writes are atomic 0600 like the cache itself.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";

export interface SummaryMeta {
  sourceUrl: string;
  cachePath: string;
  contentHash: string;
  generated: string;
  model: string;
  objective?: string;
  queryTerms?: string;
}

export interface SummaryArtifact {
  path: string;
  text: string;
  meta: SummaryMeta;
}

/** Deterministic reuse key: source cache path + page bytes + objective + query_terms. */
export function summaryKey(cachePath: string, contentHash: string, objective: string | undefined, queryTerms: string | undefined): string {
  return createHash("sha256").update(`${cachePath}\x00${contentHash}\x00${objective ?? ""}\x00${queryTerms ?? ""}`).digest("hex");
}

export function summaryPathFor(cachePath: string, contentHash: string, objective: string | undefined, queryTerms: string | undefined): string {
  return `${cachePath}.summary-${summaryKey(cachePath, contentHash, objective, queryTerms).slice(0, 16)}.md`;
}

function legacySummaryPathFor(cachePath: string): string {
  return `${cachePath}.summary.md`;
}

export function readSummary(cachePath: string, objective: string | undefined, queryTerms: string | undefined): SummaryArtifact | undefined {
  const cache = readCacheIdentity(cachePath);
  if (!cache) return undefined;
  const expectedKey = summaryKey(cachePath, cache.contentHash, objective, queryTerms);
  for (const path of [summaryPathFor(cachePath, cache.contentHash, objective, queryTerms), legacySummaryPathFor(cachePath)]) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      const parsed = parseSummaryFile(text);
      if (!parsed || parsed.meta.contentHash !== cache.contentHash) continue;
      if (expectedKey !== summaryKey(parsed.meta.cachePath, parsed.meta.contentHash, parsed.meta.objective, parsed.meta.queryTerms)) continue;
      return { path, text, meta: parsed.meta };
    } catch { /* unreadable or malformed candidate is not reusable */ }
  }
  return undefined;
}

export function writeSummary(cachePath: string, input: { body: string; model: string; objective?: string; queryTerms?: string; expectedContentHash?: string }): SummaryArtifact {
  const cache = readCacheIdentity(cachePath);
  if (!cache) throw new Error(`Cannot write summary without a readable cache entry: ${cachePath}`);
  if (input.expectedContentHash !== undefined && cache.contentHash !== input.expectedContentHash) throw new Error(`Cache content changed during summary generation: ${cachePath}`);
  const path = summaryPathFor(cachePath, cache.contentHash, input.objective, input.queryTerms);
  if (readSummary(cachePath, input.objective, input.queryTerms)) throw new Error(`Retained summary already exists for this intent: ${path}`);
  const meta: SummaryMeta = {
    sourceUrl: cache.sourceUrl,
    cachePath,
    contentHash: cache.contentHash,
    generated: new Date().toISOString(),
    model: input.model,
    ...(input.objective !== undefined ? { objective: input.objective } : {}),
    ...(input.queryTerms !== undefined ? { queryTerms: input.queryTerms } : {}),
  };
  const diskMeta = {
    source_url: meta.sourceUrl, cache_path: meta.cachePath, content_hash: meta.contentHash, generated: meta.generated, model: meta.model,
    ...(meta.objective !== undefined ? { objective: meta.objective } : {}),
    ...(meta.queryTerms !== undefined ? { query_terms: meta.queryTerms } : {}),
  };
  const prefix = `---\n${stringify(diskMeta)}---\n`;
  atomicWrite(path, prefix + input.body + "\n");
  return { path, text: prefix + input.body + "\n", meta };
}

function parseSummaryFile(text: string): { meta: SummaryMeta } | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n");
  if (end < 0) return undefined;
  let meta: unknown;
  try { meta = parse(text.slice(4, end)); } catch { return undefined; }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const raw = meta as Record<string, unknown>;
  if (typeof raw.source_url !== "string" || typeof raw.cache_path !== "string" || typeof raw.content_hash !== "string" || typeof raw.generated !== "string" || typeof raw.model !== "string") return undefined;
  return {
    meta: {
      sourceUrl: raw.source_url,
      cachePath: raw.cache_path,
      contentHash: raw.content_hash,
      generated: raw.generated,
      model: raw.model,
      ...(typeof raw.objective === "string" ? { objective: raw.objective } : {}),
      ...(typeof raw.query_terms === "string" ? { queryTerms: raw.query_terms } : {}),
    },
  };
}

function readCacheIdentity(cachePath: string): { sourceUrl: string; contentHash: string } | undefined {
  try {
    const text = readFileSync(cachePath, "utf8");
    const parsed = parse(text.replace(/^---\n/, "").split("\n---\n")[0] ?? "{}");
    if (parsed && typeof parsed === "object") {
      const raw = parsed as Record<string, unknown>;
      if (typeof raw.source_url === "string" && typeof raw.content_hash === "string") return { sourceUrl: raw.source_url, contentHash: raw.content_hash };
    }
  } catch { /* unreadable cache is not reusable */ }
  return undefined;
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 8)}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* temp may already have been renamed */ }
    throw error;
  }
}
