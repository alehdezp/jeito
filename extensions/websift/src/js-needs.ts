// ADR-002.005: JS-needs DB v2 + rule v2, calibrated on webclaw `-f llm` output (which has
// NO links, so rule v1's linkMax component is dead). Owner decision: DB wiped at cutover
// (v1 records are ignored by version gate; first v2 write replaces the file) and re-learned
// under rule v2. Records are positive-only, keyed by host + one-segment path prefix, and
// expire after JS_NEEDS_REVERIFY_MS so a site that started serving static HTML self-heals
// (webclaw success then clears the record).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot } from "./fetch-cache.ts";
import type { BodyMetrics } from "./webclaw-spawn.ts";

export const JS_NEEDS_VERSION = 2;
export const JS_NEEDS_REVERIFY_MS = 7 * 24 * 60 * 60 * 1000;
/** Rule v2 (16-page experiment: 3 true shells caught, zero false positives on 8 known-good
 *  pages). Calibration correction 2026-08-07: both clauses require a HEADINGLESS body —
 *  every measured shell (algolia 0 chars, qwen 0 chars, x.com 303 chars) is headingless,
 *  while a tiny page WITH a heading (example.com, 117 chars, 1 heading) is static content
 *  that must be shown, not escalated to the paid lane. Tunable constants, as-measured. */
export function jsNeedsRule(metrics: BodyMetrics): boolean {
  return metrics.headings === 0 && metrics.textChars < 2000;
}

export interface JsNeedsRecord {
  host: string;
  pathPrefix: string;
  detectedAt: string;
  evidence: BodyMetrics;
  renderOutcome?: { ok: boolean; tokens: number; headings: number; textChars: number };
}
export interface JsNeedsDb { version: number; records: JsNeedsRecord[] }

function dbPath(root: string): string { return join(root, "js-needs.json"); }

export function readJsNeedsDb(root: string): JsNeedsDb {
  try {
    const raw = JSON.parse(readFileSync(dbPath(root), "utf8")) as Partial<JsNeedsDb>;
    if (raw?.version === JS_NEEDS_VERSION && Array.isArray(raw.records)) return raw as JsNeedsDb;
  } catch { /* missing/corrupt/v1 = empty; first write replaces the file (wipe at cutover) */ }
  return { version: JS_NEEDS_VERSION, records: [] };
}

function writeJsNeedsDb(db: JsNeedsDb, root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(dbPath(root), JSON.stringify(db, null, 2) + "\n", { mode: 0o600 });
}

function recordKey(url: URL): { host: string; pathPrefix: string } {
  const segment = url.pathname.split("/").filter(Boolean)[0];
  return { host: url.host, pathPrefix: segment ? `/${segment}` : "/" };
}

/** DB-first routing consult. Stale records (older than the re-verify window) do NOT route —
 *  webclaw is retried so a site that changed can self-heal. */
export function hasJsNeed(rawUrl: string, root: string): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  const now = Date.now();
  return readJsNeedsDb(root).records.some(
    (record) => record.host === url.host && url.pathname.startsWith(record.pathPrefix) && now - Date.parse(record.detectedAt) < JS_NEEDS_REVERIFY_MS,
  );
}

export function recordJsNeed(rawUrl: string, evidence: BodyMetrics, root: string): void {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return; }
  const db = readJsNeedsDb(root);
  const { host, pathPrefix } = recordKey(url);
  const existing = db.records.find((record) => record.host === host && record.pathPrefix === pathPrefix);
  const record: JsNeedsRecord = { host, pathPrefix, detectedAt: new Date().toISOString(), evidence };
  if (existing) Object.assign(existing, record);
  else db.records.push(record);
  writeJsNeedsDb(db, root);
}

export function clearJsNeed(rawUrl: string, root: string): void {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return; }
  const db = readJsNeedsDb(root);
  const before = db.records.length;
  db.records = db.records.filter((record) => !(record.host === url.host && url.pathname.startsWith(record.pathPrefix)));
  if (db.records.length !== before) writeJsNeedsDb(db, root);
}
