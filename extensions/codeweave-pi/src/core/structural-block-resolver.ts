import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeDigest, type SnapshotBlock } from "./snapshot-store.ts";

export interface StructuralBlockResult { blocks: SnapshotBlock[]; cache: "hit" | "miss"; parseMs: number; workerPid?: number; }
export interface SyntaxDiagnostic { line: number; column: number; endLine: number; endColumn: number; kind: "ERROR" | "MISSING"; nodeType: string; }
export interface StructuralSyntaxResult { diagnostics: SyntaxDiagnostic[]; parseMs: number; workerPid?: number; }
interface Pending { resolve: (value: StructuralBlockResult | StructuralSyntaxResult | undefined) => void; timer: NodeJS.Timeout; mode: "blocks" | "syntax"; }

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/structural-block-worker.mjs");
const EXTENSIONS = new Map([
  [".ts", "typescript"], [".mts", "typescript"], [".cts", "typescript"], [".tsx", "tsx"],
  [".js", "javascript"], [".mjs", "javascript"], [".cjs", "javascript"], [".jsx", "tsx"],
  [".py", "python"], [".go", "go"], [".rs", "rust"], [".java", "java"], [".kt", "kotlin"], [".kts", "kotlin"],
  [".md", "markdown"], [".mdx", "markdown"], [".markdown", "markdown"],
]);
const cache = new Map<string, { result: StructuralBlockResult; bytes: number }>();
const lastByPath = new Map<string, { text: string; result: StructuralBlockResult }>();
let cacheBytes = 0;
let child: ChildProcessWithoutNullStreams | undefined;
let nextId = 1;
let idleTimer: NodeJS.Timeout | undefined;
const pending = new Map<number, Pending>();

export function structuralLanguage(path: string): string | undefined { return EXTENSIONS.get(extname(path).toLowerCase()); }
export function supportedStructuralLanguages(): string[] { return [...new Set(EXTENSIONS.values())].sort(); }

export async function resolveStructuralBlocks(input: { path: string; text: string; timeoutMs?: number; signal?: AbortSignal }): Promise<StructuralBlockResult | undefined> {
  const language = structuralLanguage(input.path);
  if (!language || !input.text) return undefined;
  const last = lastByPath.get(input.path);
  if (last?.text === input.text) return { ...last.result, cache: "hit" };
  const digest = computeDigest(input.text);
  const key = `${digest}:${language}:0.26`;
  const existing = cache.get(key);
  if (existing) { touch(key, existing); return { ...existing.result, cache: "hit" }; }
  if (input.signal?.aborted) return undefined;
  const worker = ensureWorker();
  const id = nextId++;
  return await new Promise(resolveResult => {
    const finish = (value: StructuralBlockResult | undefined) => {
      const item = pending.get(id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(id);
      input.signal?.removeEventListener("abort", abort);
      if (value) { putCache(key, value, Buffer.byteLength(input.text, "utf8")); lastByPath.set(input.path, { text: input.text, result: value }); }
      scheduleIdleShutdown();
      resolveResult(value);
    };
    const abort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), boundedTimeout(input.timeoutMs));
    pending.set(id, { resolve: value => finish(value as StructuralBlockResult | undefined), timer, mode: "blocks" });
    input.signal?.addEventListener("abort", abort, { once: true });
    worker.stdin.write(`${JSON.stringify({ id, input: { path: input.path, text: input.text, digest, language } })}\n`);
  });
}

export async function resolveSyntaxDiagnostics(input: { path: string; text: string; timeoutMs?: number; signal?: AbortSignal }): Promise<StructuralSyntaxResult | undefined> {
  const language = structuralLanguage(input.path);
  if (!language) return undefined;
  if (input.signal?.aborted) return undefined;
  const worker = ensureWorker();
  const id = nextId++;
  return await new Promise(resolveResult => {
    const finish = (value: StructuralSyntaxResult | undefined) => {
      const item = pending.get(id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(id);
      input.signal?.removeEventListener("abort", abort);
      scheduleIdleShutdown();
      resolveResult(value);
    };
    const abort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), boundedTimeout(input.timeoutMs));
    pending.set(id, { resolve: value => finish(value as StructuralSyntaxResult | undefined), timer, mode: "syntax" });
    input.signal?.addEventListener("abort", abort, { once: true });
    worker.stdin.write(`${JSON.stringify({ id, input: { mode: "syntax", path: input.path, text: input.text, language } })}\n`);
  });
}

export async function shutdownStructuralBlockResolver(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  const running = child;
  child = undefined;
  for (const [id, item] of pending) { clearTimeout(item.timer); item.resolve(undefined); pending.delete(id); }
  if (!running || running.killed) return;
  running.kill("SIGTERM");
  await new Promise(resolveDone => { const timer = setTimeout(() => { running.kill("SIGKILL"); resolveDone(undefined); }, 500); running.once("exit", () => { clearTimeout(timer); resolveDone(undefined); }); });
}

function ensureWorker(): ChildProcessWithoutNullStreams {
  if (child && !child.killed) return child;
  const background = process.platform === "darwin" && existsSync("/usr/sbin/taskpolicy") && existsSync("/usr/bin/nice");
  const command = background ? "/usr/sbin/taskpolicy" : process.execPath;
  const args = background ? ["-b", "/usr/bin/nice", "-n", "15", process.execPath, WORKER] : [WORKER];
  child = spawn(command, args, { cwd: resolve(dirname(WORKER), ".."), stdio: ["pipe", "pipe", "pipe"] });
  const active = child;
  createInterface({ input: active.stdout }).on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const item = pending.get(Number(message.id));
    if (!item) return;
    if (!message.ok) { item.resolve(undefined); return; }
    item.resolve(item.mode === "syntax"
      ? { diagnostics: message.diagnostics ?? [], parseMs: Number(message.parseMs ?? 0), workerPid: active.pid }
      : { blocks: message.blocks ?? [], cache: message.cache === "hit" ? "hit" : "miss", parseMs: Number(message.parseMs ?? 0), workerPid: active.pid });
  });
  active.stderr.on("data", () => {});
  active.once("exit", () => { if (child === active) child = undefined; failPending(); });
  active.once("error", () => { if (child === active) child = undefined; failPending(); });
  active.unref();
  active.stdin.unref?.();
  active.stdout.unref?.();
  active.stderr.unref?.();
  return active;
}
function failPending(): void { for (const item of pending.values()) item.resolve(undefined); }
function scheduleIdleShutdown(): void { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => { void shutdownStructuralBlockResolver(); }, idleMs()); idleTimer.unref?.(); }
function idleMs(): number { const value = Number(process.env.PI_NAV_BLOCK_WORKER_IDLE_MS ?? 60_000); return Number.isFinite(value) && value >= 100 ? Math.min(value, 10 * 60_000) : 60_000; }
function boundedTimeout(value?: number): number { return Number.isFinite(value) && Number(value) > 0 ? Math.min(Math.floor(Number(value)), 10_000) : 2_000; }
function putCache(key: string, result: StructuralBlockResult, bytes: number): void { cache.set(key, { result, bytes }); cacheBytes += bytes; while (cacheBytes > cacheLimit() && cache.size > 1) { const oldest = cache.keys().next().value; const removed = cache.get(oldest); cache.delete(oldest); cacheBytes -= removed?.bytes ?? 0; } }
function touch(key: string, value: { result: StructuralBlockResult; bytes: number }): void { cache.delete(key); cache.set(key, value); }
function cacheLimit(): number { const value = Number(process.env.PI_NAV_BLOCK_CACHE_BYTES ?? 32 * 1024 * 1024); return Number.isFinite(value) && value > 0 ? Math.floor(value) : 32 * 1024 * 1024; }
