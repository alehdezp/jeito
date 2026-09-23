import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { PreparedLaneName } from "./navigation-desired-state.ts";

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_EVENTS = 2_000;

export interface NavigationLifecycleEvent {
  timestamp?: string;
  root: string;
  lane: PreparedLaneName;
  actorPid?: number;
  processStartIdentity?: string;
  sessionNonce?: string;
  operation: "prepare" | "freshen" | "reconcile" | "quarantine" | "publish" | "cleanup" | "stop" | "probe";
  trigger: string;
  token?: string;
  desiredStateHash?: string;
  oldArtifactId?: string;
  newArtifactId?: string;
  approval?: "automatic_safe" | "explicit_non_destructive" | "explicit_destructive";
  result: "started" | "success" | "error" | "cancelled" | "skipped";
  failure?: string;
  timings?: Record<string, number>;
  counts?: Record<string, number>;
}

export async function appendLifecycleAudit(event: NavigationLifecycleEvent, options: { maxBytes?: number; maxEvents?: number } = {}): Promise<void> {
  const path = lifecycleAuditPath(event.root);
  const safe = sanitizeEvent(event);
  await mkdir(dirname(path), { recursive: true });
  let lines: string[] = [];
  try { lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean); } catch {}
  lines.push(JSON.stringify(safe));
  const maxEvents = bounded(options.maxEvents, DEFAULT_MAX_EVENTS, 10, 20_000);
  if (lines.length > maxEvents) lines = lines.slice(-maxEvents);
  const maxBytes = bounded(options.maxBytes, DEFAULT_MAX_BYTES, 16 * 1024, 5 * 1024 * 1024);
  while (Buffer.byteLength(`${lines.join("\n")}\n`) > maxBytes && lines.length > 1) lines.shift();
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function appendLifecycleAuditSync(event: NavigationLifecycleEvent, options: { maxBytes?: number; maxEvents?: number } = {}): void {
  const path = lifecycleAuditPath(event.root);
  const safe = sanitizeEvent(event);
  mkdirSync(dirname(path), { recursive: true });
  let lines: string[] = [];
  try { lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean); } catch {}
  lines.push(JSON.stringify(safe));
  const maxEvents = bounded(options.maxEvents, DEFAULT_MAX_EVENTS, 10, 20_000);
  if (lines.length > maxEvents) lines = lines.slice(-maxEvents);
  const maxBytes = bounded(options.maxBytes, DEFAULT_MAX_BYTES, 16 * 1024, 5 * 1024 * 1024);
  while (Buffer.byteLength(`${lines.join("\n")}\n`) > maxBytes && lines.length > 1) lines.shift();
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function readLifecycleAudit(root: string, limit = 100): Promise<NavigationLifecycleEvent[]> {
  try {
    const lines = (await readFile(lifecycleAuditPath(root), "utf8")).split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(limit, 1_000))).flatMap(line => {
      try { return [JSON.parse(line) as NavigationLifecycleEvent]; } catch { return []; }
    });
  } catch { return []; }
}

export async function inspectLifecycleAudit(root: string): Promise<{ path: string; bytes: number; events: number }> {
  const path = lifecycleAuditPath(root);
  const info = await stat(path).catch(() => undefined);
  const events = info ? (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).length : 0;
  return { path, bytes: info?.size ?? 0, events };
}

export function lifecycleAuditPath(root: string): string {
  return join(resolve(root), ".pi", "navigation", "lifecycle-audit.jsonl");
}

function sanitizeEvent(event: NavigationLifecycleEvent): NavigationLifecycleEvent {
  const json = JSON.stringify({ ...event, timestamp: event.timestamp ?? new Date().toISOString(), root: resolve(event.root) }, (key, value) => {
    if (/secret|token_value|api.?key|credential|prompt|query/i.test(key)) return undefined;
    if (typeof value === "string") return value
      .replace(/(?:sk-|AIza|ghp_|xox[baprs]-)[A-Za-z0-9_-]{8,}/g, "[redacted]")
      .replace(/(API_KEY\s*=\s*)[^\s;,]+/gi, "$1[redacted]");
    return value;
  });
  const parsed = JSON.parse(json);
  if (parsed.failure) parsed.failure = String(parsed.failure).slice(0, 500);
  return parsed;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Number(value))) : fallback;
}
