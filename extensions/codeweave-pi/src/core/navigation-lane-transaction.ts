import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { PreparedLaneName } from "./navigation-desired-state.ts";

export const NAVIGATION_TRANSACTION_VERSION = 1 as const;
export type NavigationTransactionLane = PreparedLaneName | "prepared";
const INITIALIZATION_GRACE_MS = 1_000;

export interface LaneOwnerRecord {
  version: typeof NAVIGATION_TRANSACTION_VERSION;
  lane: NavigationTransactionLane;
  root: string;
  pid: number;
  processStartIdentity: string;
  token: string;
  desiredStateHash: string;
  extensionVersion: string;
  backendVersion?: string;
  endpoint?: string;
  operation: string;
  createdAt: string;
  heartbeatAt: string;
}

export interface LaneTransaction {
  record: LaneOwnerRecord;
  heartbeat(): Promise<boolean>;
  release(): Promise<boolean>;
}

export interface AcquireLaneTransactionOptions {
  root: string;
  lane: NavigationTransactionLane;
  desiredStateHash: string;
  extensionVersion: string;
  backendVersion?: string;
  endpoint?: string;
  operation: string;
  timeoutMs?: number;
  staleMs?: number;
  now?: () => number;
}

export async function acquireLaneTransaction(options: AcquireLaneTransactionOptions): Promise<LaneTransaction> {
  const root = resolve(options.root);
  const lockPath = transactionRecordPath(root, options.lane);
  const timeoutMs = bounded(options.timeoutMs, 5_000, 100, 120_000);
  const staleMs = bounded(options.staleMs, 30_000, 1_000, 10 * 60_000);
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    const record = makeRecord(options, root, now());
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      return transactionHandle(lockPath, record, now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await inspectLaneOwner(lockPath, { staleMs, now: now() });
      if (!owner.live && owner.reclaimable) {
        await removeIfToken(lockPath, owner.record?.token);
        continue;
      }
      if (now() >= deadline) throw new Error(`navigation ${options.lane} transaction timed out after ${timeoutMs}ms; owner=${owner.record?.token ?? "initializing"}`);
      await delay(25);
    }
  }
}

export async function withLaneTransaction<T>(options: AcquireLaneTransactionOptions, operation: () => Promise<T>): Promise<T> {
  const transaction = await acquireLaneTransaction(options);
  const heartbeat = setInterval(() => { void transaction.heartbeat(); }, 5_000);
  heartbeat.unref?.();
  try { return await operation(); }
  finally {
    clearInterval(heartbeat);
    await transaction.release();
  }
}
export function withLaneTransactionSync<T>(options: AcquireLaneTransactionOptions, operation: () => T): T {
  const root = resolve(options.root);
  const lockPath = transactionRecordPath(root, options.lane);
  const timeoutMs = bounded(options.timeoutMs, 5_000, 100, 120_000);
  const staleMs = bounded(options.staleMs, 30_000, 1_000, 10 * 60_000);
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  mkdirSync(dirname(lockPath), { recursive: true });
  let record: LaneOwnerRecord | undefined;
  for (;;) {
    record = makeRecord(options, root, now());
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try { writeFileSync(fd, `${JSON.stringify(record)}\n`); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = inspectLaneOwnerSync(lockPath, staleMs, now());
      if (!owner.live && owner.reclaimable) {
        if (!owner.record || readRecordSync(lockPath)?.token === owner.record.token) rmSync(lockPath, { force: true });
        continue;
      }
      if (now() >= deadline) throw new Error(`navigation ${options.lane} transaction timed out after ${timeoutMs}ms; owner=${owner.record?.token ?? "initializing"}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return operation(); }
  finally { if (readRecordSync(lockPath)?.token === record.token) rmSync(lockPath, { force: true }); }
}

function inspectLaneOwnerSync(lockPath: string, staleMs: number, now: number): { live: boolean; reclaimable: boolean; record?: LaneOwnerRecord } {
  const record = readRecordSync(lockPath);
  if (!record) {
    try { return { live: false, reclaimable: now - statSync(lockPath).mtimeMs > INITIALIZATION_GRACE_MS } as const; }
    catch { return { live: false, reclaimable: true } as const; }
  }
  const sameProcess = pidAlive(record.pid) && processIdentity(record.pid) === record.processStartIdentity;
  return { live: sameProcess, reclaimable: !sameProcess, record };
}

function readRecordSync(lockPath: string): LaneOwnerRecord | undefined {
  try { const value = JSON.parse(readFileSync(lockPath, "utf8")); return validRecord(value) ? value : undefined; } catch { return undefined; }
}

export async function inspectLaneOwner(pathOrRoot: string, options: { lane?: NavigationTransactionLane; staleMs?: number; now?: number } = {}): Promise<{ live: boolean; reclaimable: boolean; reason: string; record?: LaneOwnerRecord }> {
  const lockPath = options.lane ? transactionRecordPath(resolve(pathOrRoot), options.lane) : pathOrRoot;
  let record: LaneOwnerRecord | undefined;
  try { record = JSON.parse(await readFile(lockPath, "utf8")); }
  catch {
    try {
      const age = (options.now ?? Date.now()) - (await stat(lockPath)).mtimeMs;
      return { live: age < INITIALIZATION_GRACE_MS, reclaimable: age >= INITIALIZATION_GRACE_MS, reason: age < INITIALIZATION_GRACE_MS ? "initializing" : "unreadable_stale" };
    } catch { return { live: false, reclaimable: true, reason: "missing" }; }
  }
  if (!validRecord(record)) return { live: false, reclaimable: true, reason: "invalid", record };
  const heartbeatAge = (options.now ?? Date.now()) - Date.parse(record.heartbeatAt);
  const stale = heartbeatAge > (options.staleMs ?? 30_000);
  const livePid = pidAlive(record.pid);
  const sameProcess = livePid && processIdentity(record.pid) === record.processStartIdentity;
  return {
    live: sameProcess,
    reclaimable: !sameProcess,
    reason: !livePid ? "pid_dead" : !sameProcess ? "process_identity_changed" : stale ? "heartbeat_stale_owner_live" : "healthy",
    record,
  };
}

export function transactionRecordPath(root: string, lane: NavigationTransactionLane): string {
  return join(root, ".pi", "navigation", "transactions", `${lane}.json`);
}

export function currentProcessStartIdentity(): string {
  return processIdentity(process.pid);
}

function transactionHandle(lockPath: string, record: LaneOwnerRecord, now: () => number): LaneTransaction {
  return {
    record,
    heartbeat: async () => {
      const current = await readRecord(lockPath);
      if (current?.token !== record.token) return false;
      record.heartbeatAt = new Date(now()).toISOString();
      await atomicWrite(lockPath, record);
      return true;
    },
    release: () => removeIfToken(lockPath, record.token),
  };
}

function makeRecord(options: AcquireLaneTransactionOptions, root: string, now: number): LaneOwnerRecord {
  const timestamp = new Date(now).toISOString();
  return {
    version: NAVIGATION_TRANSACTION_VERSION,
    lane: options.lane,
    root,
    pid: process.pid,
    processStartIdentity: currentProcessStartIdentity(),
    token: randomUUID(),
    desiredStateHash: options.desiredStateHash,
    extensionVersion: options.extensionVersion,
    backendVersion: options.backendVersion,
    endpoint: options.endpoint,
    operation: options.operation,
    createdAt: timestamp,
    heartbeatAt: timestamp,
  };
}

function processIdentity(pid: number): string {
  for (const command of ["/bin/ps", "/usr/bin/ps", "ps"]) {
    try {
      const value = String(execFileSync(command, ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 })).trim();
      if (value) return `${pid}:${value}`;
    } catch {}
  }
  return `${pid}:unknown`;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function removeIfToken(lockPath: string, token?: string): Promise<boolean> {
  const current = await readRecord(lockPath);
  if (!current || (token && current.token !== token)) return false;
  await rm(lockPath, { force: true });
  return true;
}

async function readRecord(lockPath: string): Promise<LaneOwnerRecord | undefined> {
  try { return JSON.parse(await readFile(lockPath, "utf8")); } catch { return undefined; }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function validRecord(value: any): value is LaneOwnerRecord {
  return value?.version === NAVIGATION_TRANSACTION_VERSION && typeof value?.token === "string" && Number.isInteger(value?.pid) && typeof value?.processStartIdentity === "string" && typeof value?.heartbeatAt === "string";
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Number(value))) : fallback;
}

function delay(ms: number): Promise<void> { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)); }
