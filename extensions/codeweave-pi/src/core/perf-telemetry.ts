import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { redactJson } from "./redaction.ts";

export interface PerfTelemetryEvent {
  kind: string;
  root?: string;
  cwd?: string;
  tool?: string;
  trigger?: string;
  backend?: string;
  lane?: string;
  mode?: string;
  status?: string;
  command?: string;
  args?: string[];
  pid?: number;
  childCount?: number;
  durationMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  resourceSamples?: number;
  peakProcessCount?: number;
  peakRssKb?: number;
  peakCpuPct?: number;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  aborted?: boolean;
  error?: string;
  [key: string]: unknown;
}

export function perfTelemetryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = String(env.PI_NAV_PERF_TELEMETRY ?? "").trim().toLowerCase();
  return Boolean(env.PI_NAV_PERF_LOG) || flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

export function perfTelemetryPath(root: string, env: Record<string, string | undefined> = process.env): string {
  const configured = env.PI_NAV_PERF_LOG?.trim();
  return configured || join(root, ".pi", "navigation", "perf.jsonl");
}

export function commandFamily(command: string | undefined): string | undefined {
  if (!command) return undefined;
  return basename(command).replace(/(?:\.exe|\.cmd|\.bat)$/i, "");
}

export function recordPerfEvent(event: PerfTelemetryEvent, options: { root?: string; env?: Record<string, string | undefined> } = {}): void {
  const env = options.env ?? process.env;
  if (!perfTelemetryEnabled(env)) return;
  const root = options.root ?? event.root ?? event.cwd ?? process.cwd();
  const logPath = perfTelemetryPath(root, env);
  const record = redactJson({
    time: new Date().toISOString(),
    version: 1,
    ...event,
    root,
    commandFamily: commandFamily(event.command),
    childCount: event.childCount ?? event.peakProcessCount ?? (event.command ? 1 : 0),
  }, { env });
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    rotatePerfLogIfNeeded(logPath, env);
    appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch {
    // Telemetry must never affect navigation behavior or public tool output.
  }
}

export function byteLength(value: string | undefined): number {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function rotatePerfLogIfNeeded(logPath: string, env: Record<string, string | undefined>): void {
  const maxBytes = perfLogMaxBytes(env);
  if (maxBytes <= 0) return;
  try {
    const size = statSync(logPath).size;
    if (size < maxBytes) return;
    const rotated = `${logPath}.1`;
    try { rmSync(rotated, { force: true }); } catch {}
    renameSync(logPath, rotated);
  } catch (error: any) {
    // Missing logs or rotation failures must never affect navigation output.
    if (error?.code === "ENOENT") return;
  }
}

function perfLogMaxBytes(env: Record<string, string | undefined>): number {
  const value = Number(env.PI_NAV_PERF_MAX_BYTES);
  if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  return 5 * 1024 * 1024;
}
