import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { perfTelemetryEnabled } from "./perf-telemetry.ts";

export interface SupervisedProcessOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
}

export interface SupervisedExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  error?: string;
}

export interface SupervisedProcessHandle {
  child: ChildProcessWithoutNullStreams;
  done: Promise<SupervisedExit>;
  terminate(reason?: "manual" | "timeout" | "aborted"): void;
}

export interface SupervisedCommandResult extends SupervisedExit {
  ok: boolean;
  stdout: string;
  stderr: string;
  pid?: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  resourceSamples?: number;
  peakProcessCount?: number;
  peakRssKb?: number;
  peakCpuPct?: number;
}

export interface SupervisedCommandOptions extends SupervisedProcessOptions {
  input?: string;
  maxBytes?: number;
}

export function spawnSupervisedProcess(command: string, args: string[], options: SupervisedProcessOptions): SupervisedProcessHandle {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const killGraceMs = Math.max(50, options.killGraceMs ?? 1_500);
  let settled = false;
  let timedOut = false;
  let aborted = false;
  let errorMessage: string | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let resolveDone!: (exit: SupervisedExit) => void;
  const done = new Promise<SupervisedExit>(resolve => { resolveDone = resolve; });

  const clearAllTimers = () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    timeoutTimer = undefined;
    killTimer = undefined;
  };

  const settle = (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true;
    clearAllTimers();
    options.signal?.removeEventListener("abort", onAbort);
    resolveDone({ code, signal, timedOut, aborted, error: errorMessage });
  };

  const terminate = (reason: "manual" | "timeout" | "aborted" = "manual") => {
    if (settled) return;
    if (reason === "timeout") timedOut = true;
    if (reason === "aborted") aborted = true;
    terminateProcessGroup(child, "SIGTERM");
    if (!killTimer) {
      killTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), killGraceMs);
    }
  };

  const onAbort = () => terminate("aborted");

  child.on("error", error => {
    errorMessage = error.message;
  });
  child.on("close", (code, signal) => settle(code, signal));

  if (options.timeoutMs && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => terminate("timeout"), options.timeoutMs);
  }
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  return { child, done, terminate };
}

export async function runSupervisedCommand(command: string, args: string[], options: SupervisedCommandOptions): Promise<SupervisedCommandResult> {
  const handle = spawnSupervisedProcess(command, args, options);
  const maxBytes = options.maxBytes ?? 256_000;
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const sampler = startResourceSampler(handle.child.pid, options.env);
  const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]` : value;
  handle.child.stdout.on("data", chunk => {
    const text = chunk.toString("utf8");
    stdoutBytes += Buffer.byteLength(text, "utf8");
    const next = stdout + text;
    stdoutTruncated = stdoutTruncated || next.length > maxBytes;
    stdout = clip(next, maxBytes);
  });
  handle.child.stderr.on("data", chunk => {
    const text = chunk.toString("utf8");
    stderrBytes += Buffer.byteLength(text, "utf8");
    const next = stderr + text;
    stderrTruncated = stderrTruncated || next.length > maxBytes;
    stderr = clip(next, maxBytes);
  });
  if (options.input !== undefined) handle.child.stdin.end(options.input);
  else handle.child.stdin.end();
  const exit = await handle.done;
  const resources = sampler?.stop() ?? {};
  const timeoutError = exit.timedOut ? `command timed out after ${options.timeoutMs}ms` : undefined;
  const abortError = exit.aborted ? "command aborted" : undefined;
  return {
    ...exit,
    ok: !exit.error && !exit.timedOut && !exit.aborted && exit.code === 0,
    stdout,
    stderr,
    pid: handle.child.pid,
    stdoutBytes,
    stderrBytes,
    stdoutTruncated,
    stderrTruncated,
    ...resources,
    error: exit.error ?? timeoutError ?? abortError,
  };
}

interface ResourceSnapshot {
  processCount: number;
  rssKb: number;
  cpuPct: number;
}

interface ResourceSamplerState {
  samples: number;
  peakProcessCount: number;
  peakRssKb: number;
  peakCpuPct: number;
}

function startResourceSampler(pid: number | undefined, env: Record<string, string | undefined> | undefined): { stop(): Partial<SupervisedCommandResult> } | undefined {
  if (!pid || process.platform === "win32" || !perfTelemetryEnabled(env ?? process.env)) return undefined;
  const intervalMs = resourceSampleIntervalMs(env ?? process.env);
  const state: ResourceSamplerState = { samples: 0, peakProcessCount: 0, peakRssKb: 0, peakCpuPct: 0 };
  const sample = () => updateResourceState(state, sampleProcessTree(pid));
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      sample();
      return state.samples > 0 ? {
        resourceSamples: state.samples,
        peakProcessCount: state.peakProcessCount,
        peakRssKb: state.peakRssKb,
        peakCpuPct: Number(state.peakCpuPct.toFixed(2)),
      } : { resourceSamples: 0 };
    },
  };
}

function resourceSampleIntervalMs(env: Record<string, string | undefined>): number {
  const value = Number(env.PI_NAV_PERF_SAMPLE_MS);
  if (!Number.isFinite(value) || value <= 0) return 250;
  return Math.max(50, Math.min(5000, Math.floor(value)));
}

function updateResourceState(state: ResourceSamplerState, snapshot: ResourceSnapshot | undefined): void {
  if (!snapshot) return;
  state.samples++;
  state.peakProcessCount = Math.max(state.peakProcessCount, snapshot.processCount);
  state.peakRssKb = Math.max(state.peakRssKb, snapshot.rssKb);
  state.peakCpuPct = Math.max(state.peakCpuPct, snapshot.cpuPct);
}

function sampleProcessTree(rootPid: number): ResourceSnapshot | undefined {
  const run = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,pcpu="], { encoding: "utf8", timeout: 1000, maxBuffer: 2 * 1024 * 1024 });
  if (run.error || run.status !== 0) return undefined;
  const processes = parsePsRows(run.stdout);
  if (!processes.has(rootPid)) return undefined;
  const children = new Map<number, number[]>();
  for (const proc of processes.values()) {
    const list = children.get(proc.ppid) ?? [];
    list.push(proc.pid);
    children.set(proc.ppid, list);
  }
  const stack = [rootPid];
  const seen = new Set<number>();
  let rssKb = 0;
  let cpuPct = 0;
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const proc = processes.get(pid);
    if (proc) {
      rssKb += proc.rssKb;
      cpuPct += proc.cpuPct;
    }
    for (const childPid of children.get(pid) ?? []) stack.push(childPid);
  }
  return { processCount: seen.size, rssKb, cpuPct };
}

function parsePsRows(text: string): Map<number, { pid: number; ppid: number; rssKb: number; cpuPct: number }> {
  const out = new Map<number, { pid: number; ppid: number; rssKb: number; cpuPct: number }>();
  for (const line of String(text ?? "").split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKb = Number(match[3]);
    const cpuPct = Number(match[4]);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) out.set(pid, { pid, ppid, rssKb: Number.isFinite(rssKb) ? rssKb : 0, cpuPct: Number.isFinite(cpuPct) ? cpuPct : 0 });
  }
  return out;
}

export function terminateProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error: any) {
      if (error?.code === "ESRCH") return;
      // Fall through to direct-child signal as a best-effort safety net.
    }
  }
  try { child.kill(signal); } catch {}
}
