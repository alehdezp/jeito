import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface WorkUnitInput {
  subsystem: "edit" | "blocks" | "source_authority" | "qmd" | "benchmark";
  operation: string;
  root?: string;
  trigger?: string;
  generation?: number;
  mode?: string;
  fileCount?: number;
  lineCount?: number;
  byteCount?: number;
  changedCount?: number;
  discoveredCount?: number;
  deletedCount?: number;
  cache?: "hit" | "miss" | "bypass";
  workerPid?: number;
  priority?: string;
  providerCalls?: number;
  metadata?: Record<string, unknown>;
}

export interface WorkUnitRecord extends WorkUnitInput {
  startedAt: string;
  durationMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  eventLoopMaxMs: number;
  rssStartBytes: number;
  rssEndBytes: number;
  rssDeltaBytes: number;
  outcome: "success" | "error" | "cancelled" | "refused";
  error?: string;
}

export interface WorkUnit {
  finish(outcome?: WorkUnitRecord["outcome"], error?: unknown, extra?: Partial<WorkUnitInput>): WorkUnitRecord;
}

/**
 * Debug/evaluation telemetry for one attributable work unit. It is deliberately
 * opt-in and never rendered in normal tool output.
 */
export function startWorkUnit(input: WorkUnitInput): WorkUnit {
  const startedAt = new Date().toISOString();
  const wallStart = performance.now();
  const cpuStart = process.cpuUsage();
  const rssStartBytes = process.memoryUsage().rss;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  let finished = false;
  return {
    finish(outcome = "success", error, extra = {}) {
      if (finished) throw new Error(`work unit already finished: ${input.subsystem}/${input.operation}`);
      finished = true;
      eventLoop.disable();
      const cpu = process.cpuUsage(cpuStart);
      const rssEndBytes = process.memoryUsage().rss;
      const record: WorkUnitRecord = {
        ...input,
        ...extra,
        startedAt,
        durationMs: round(performance.now() - wallStart),
        cpuUserMs: round(cpu.user / 1000),
        cpuSystemMs: round(cpu.system / 1000),
        eventLoopMaxMs: round(Number.isFinite(eventLoop.max) ? eventLoop.max / 1e6 : 0),
        rssStartBytes,
        rssEndBytes,
        rssDeltaBytes: rssEndBytes - rssStartBytes,
        outcome,
        ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
      };
      return record;
    },
  };
}

export async function appendWorkUnit(record: WorkUnitRecord, path = process.env.PI_NAV_PERF_TELEMETRY_PATH): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
