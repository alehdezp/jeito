import os from "node:os";
import { readFile, stat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { walkFiles } from "./walk.ts";
import { type HarnessEnvelope } from "./harness-result.ts";

export interface LspFileResult {
  path: string;
  status: "diagnostics" | "clean" | "unconfirmed" | "unsupported" | "unavailable" | "skipped";
  diagnostics: Array<{ severity?: number; message?: string; range?: unknown; source?: string; code?: unknown }>;
  note?: string;
}
export interface LspValidationResult { root: string; files: LspFileResult[]; text: string; envelope?: HarnessEnvelope; }
export interface LspProgress { phase: "detecting" | "warming" | "checking"; completed: number; total: number; }

interface LspServiceLike {
  supportsLSP(path: string): boolean;
  touchFile(path: string, content: string, options: Record<string, unknown>): Promise<any[] | undefined>;
  shutdown(): Promise<unknown>;
}
interface ServerGroup { id?: string; files: string[]; multiServer?: boolean; }
export interface LspDependencies {
  initConfig(root: string): Promise<unknown>;
  getService(): LspServiceLike;
  groupFiles(paths: string[]): ServerGroup[];
  runGroups(groups: ServerGroup[], concurrency: number, worker: (group: ServerGroup) => Promise<void>, signal?: AbortSignal): Promise<void>;
  resetService(): void;
}

const OWNER = Symbol.for("jeito-codeweave-pi.lsp.v1");
const globals = globalThis as typeof globalThis & { [OWNER]?: { service: LspServiceLike; resetService: () => void } };
const DEFAULT_DEADLINE_MS = 30_000;

export async function validateLspPaths(input: {
  cwd: string;
  paths: string[];
  root?: string;
  limit?: number;
  includeWarnings?: boolean;
  signal?: AbortSignal;
  deadlineMs?: number;
  onProgress?: (progress: LspProgress) => void;
  dependencies?: LspDependencies;
}): Promise<LspValidationResult> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 100));
  if (!Array.isArray(input.paths) || input.paths.length === 0) throw new Error("lsp_validate requires at least one path.");
  const rootInput = resolve(input.cwd, input.root ?? ".");
  const root = await realpath(rootInput);
  const requested = await collectRequestedFiles(root, input.paths, limit, input.signal);
  const dependencies = input.dependencies ?? await loadDefaultDependencies();
  const deadlineMs = boundedDeadline(input.deadlineMs);

  input.onProgress?.({ phase: "detecting", completed: 0, total: requested.length });
  await dependencies.initConfig(root);
  let owner = globals[OWNER];
  if (!owner) {
    owner = { service: dependencies.getService(), resetService: dependencies.resetService };
    globals[OWNER] = owner;
  }
  const service = owner.service;

  const byPath = new Map<string, LspFileResult>();
  const supported: string[] = [];
  for (const item of requested) {
    if (item.note) byPath.set(item.path, { path: item.path, status: "skipped", diagnostics: [], note: item.note });
    else if (!service.supportsLSP(item.path)) byPath.set(item.path, { path: item.path, status: "unsupported", diagnostics: [], note: "No primary language server candidate." });
    else supported.push(item.path);
  }

  const startedAt = Date.now();
  const groups = dependencies.groupFiles(supported);
  let warmed = 0;
  let checked = 0;
  await dependencies.runGroups(groups, Math.max(1, groups.length), async group => {
    if (input.signal?.aborted) {
      for (const path of group.files) byPath.set(path, cancelled(path));
      return;
    }
    input.onProgress?.({ phase: "warming", completed: warmed, total: groups.length });
    for (const [groupIndex, path] of group.files.entries()) {
      if (input.signal?.aborted) { byPath.set(path, cancelled(path)); continue; }
      input.onProgress?.({ phase: "checking", completed: checked, total: supported.length });
      try {
        const content = await readFile(path, "utf8");
        const touched = await runBounded(signal => service.touchFile(path, content, {
          collectDiagnostics: true,
          diagnostics: "document",
          clientScope: "primary",
          source: "jeito-codeweave-pi:lsp_validate",
          ...(groupIndex === 0 ? { maxClientWaitMs: deadlineMs, maxDiagnosticsWaitMs: deadlineMs } : {}),
          signal,
        }), input.signal, deadlineMs);
        if (touched.status === "aborted") byPath.set(path, cancelled(path));
        else if (touched.status === "timeout") byPath.set(path, { path, status: "unconfirmed", diagnostics: [], note: "Diagnostics timed out before confirmation." });
        else if (touched.status === "error") byPath.set(path, { path, status: "unavailable", diagnostics: [], note: errorText(touched.error) });
        else {
          const diagnostics = touched.value;
          if (!diagnostics) {
            const failure = await readLaunchFailure(startedAt);
            byPath.set(path, { path, status: "unavailable", diagnostics: [], note: failure ?? "Primary server candidate did not become available." });
          } else if ((diagnostics as any).inconclusive === true) byPath.set(path, { path, status: "unconfirmed", diagnostics: [], note: "Diagnostics timed out or were otherwise unconfirmed." });
          else {
            const maxSeverity = input.includeWarnings ? 2 : 1;
            const filtered = diagnostics.filter((diagnostic: any) => Number(diagnostic.severity ?? 1) <= maxSeverity);
            byPath.set(path, { path, status: filtered.length ? "diagnostics" : "clean", diagnostics: filtered });
          }
        }
      } catch (error) {
        byPath.set(path, { path, status: "unavailable", diagnostics: [], note: errorText(error) });
      } finally {
        if (groupIndex === 0) {
          warmed++;
          input.onProgress?.({ phase: "warming", completed: warmed, total: groups.length });
        }
        checked++;
        input.onProgress?.({ phase: "checking", completed: checked, total: supported.length });
      }
    }
  }, input.signal);

  const files = requested.map(item => byPath.get(item.path) ?? { path: item.path, status: "unconfirmed" as const, diagnostics: [], note: "Validation did not complete." });
  return { root, files, text: renderLspResults(files), envelope: lspEnvelope(files) };
}

export async function shutdownLspValidation(): Promise<void> {
  const owner = globals[OWNER];
  if (!owner) return;
  await owner.service.shutdown().catch(() => {});
  delete globals[OWNER];
  owner.resetService();
}

async function loadDefaultDependencies(): Promise<LspDependencies> {
  const [{ initLSPConfig }, module] = await Promise.all([
    import("pi-lens/dist/clients/lsp/config.js"),
    import("pi-lens/dist/clients/lsp/index.js"),
  ]);
  return {
    initConfig: initLSPConfig,
    getService: module.getLSPService,
    groupFiles: module.groupFilesByPrimaryServer,
    runGroups: module.runPerServerGroups,
    resetService: () => module.resetLSPService(),
  };
}

async function collectRequestedFiles(root: string, paths: string[], limit: number, signal?: AbortSignal): Promise<Array<{ path: string; note?: string }>> {
  const ordered: Array<{ path: string; note?: string }> = [];
  const seen = new Set<string>();
  for (const authored of paths) {
    if (signal?.aborted) break;
    const candidate = isAbsolute(authored) ? authored : resolve(root, authored);
    const canonical = await realpath(candidate).catch(() => undefined);
    if (!canonical) { ordered.push({ path: candidate, note: "Path does not exist." }); continue; }
    const info = await stat(canonical);
    const found: string[] = [];
    if (info.isFile()) found.push(canonical);
    else if (info.isDirectory()) for await (const file of walkFiles(canonical, limit + 1, { signal })) found.push(await realpath(file));
    else { ordered.push({ path: canonical, note: "Path is not a regular file or directory." }); continue; }
    found.sort((a, b) => a.localeCompare(b));
    for (const file of found) {
      if (seen.has(file)) continue;
      if (seen.size >= limit) throw new Error(`lsp_validate resolved more than ${limit} files; narrow paths or raise limit up to 100.`);
      seen.add(file);
      ordered.push({ path: file });
    }
  }
  return ordered;
}

function cancelled(path: string): LspFileResult { return { path, status: "unconfirmed", diagnostics: [], note: "Cancelled before confirmation." }; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function boundedDeadline(value?: number): number { return Number.isFinite(value) && Number(value) > 0 ? Math.min(120_000, Math.floor(Number(value))) : DEFAULT_DEADLINE_MS; }

type Bounded<T> = { status: "value"; value: T } | { status: "timeout" } | { status: "aborted" } | { status: "error"; error: unknown };
async function runBounded<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal | undefined, timeoutMs: number): Promise<Bounded<T>> {
  if (parent?.aborted) return { status: "aborted" };
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let parentAbort: (() => void) | undefined;
  const timeout = new Promise<Bounded<T>>(resolveResult => {
    timer = setTimeout(() => { controller.abort(); resolveResult({ status: "timeout" }); }, timeoutMs);
    timer.unref?.();
  });
  const aborted = parent ? new Promise<Bounded<T>>(resolveResult => {
    parentAbort = () => { controller.abort(); resolveResult({ status: "aborted" }); };
    parent.addEventListener("abort", parentAbort, { once: true });
  }) : new Promise<Bounded<T>>(() => {});
  const value = Promise.resolve().then(() => operation(controller.signal)).then(result => ({ status: "value", value: result } as const), error => controller.signal.aborted ? ({ status: parent?.aborted ? "aborted" : "timeout" } as const) : ({ status: "error", error } as const));
  try { return await Promise.race([value, timeout, aborted]); }
  finally { if (timer) clearTimeout(timer); if (parentAbort) parent?.removeEventListener("abort", parentAbort); }
}

function renderLspResults(files: LspFileResult[]): string {
  if (files.length === 0) return "LSP validation: no files resolved.";
  const rows = ["LSP validation:"];
  for (const file of files) {
    rows.push(`${file.status === "diagnostics" ? "Diagnostics" : file.status[0]!.toUpperCase() + file.status.slice(1)}: ${file.path}${file.note ? ` — ${file.note}` : ""}`);
    for (const diagnostic of file.diagnostics) rows.push(`  severity ${diagnostic.severity ?? "?"}: ${diagnostic.message ?? "diagnostic"}`);
  }
  if (files.some(file => file.status === "unconfirmed")) rows.push("Retry guidance: do not rerun the unchanged validation. Change the diagnostic hypothesis, server/setup state, scope, or input; otherwise retain the result as unconfirmed and use a distinct owning check.");
  return rows.join("\n");
}

const LSP_LOG_TAIL_LINES = 200;

/**
 * When a language server fails to launch, pi-lens logs the real error
 * (process stderr, spawn failure reason) to ~/.pi-lens/sessionstart.log but
 * does not return it from touchFile. This reads the log tail and extracts
 * the most recent launch failure since `sinceMs`, so the agent sees the
 * actionable cause instead of a generic "did not become available."
 */
async function readLaunchFailure(sinceMs: number): Promise<string | undefined> {
  const piLensHome = process.env.PI_LENS_HOME?.trim() || join(os.homedir(), ".pi-lens");
  let content: string;
  try {
    content = await readFile(join(piLensHome, "sessionstart.log"), "utf8");
  } catch {
    return undefined;
  }
  const tail = content.split("\n").slice(-LSP_LOG_TAIL_LINES);
  let bestStderr: { ts: number; msg: string } | undefined;
  let bestSpawnErr: { ts: number; msg: string } | undefined;
  for (const line of tail) {
    const tsMatch = /^\[(.+?)\]/.exec(line);
    if (!tsMatch) continue;
    const ts = Date.parse(tsMatch[1]!);
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    // Prefer process-exit stderr (the actual toolchain/runtime error).
    const closedMatch = /lsp process .+?: closed code=\d+.*?stderr=(.+)$/.exec(line);
    if (closedMatch?.[1]?.trim()) {
      if (!bestStderr || ts > bestStderr.ts) bestStderr = { ts, msg: closedMatch[1]!.trim() };
      continue;
    }
    // Fall back to pi-lens's own spawn-failure wrapper message.
    const spawnMatch = /lsp spawn .+?: failed\b.*?error=(.+)$/.exec(line);
    if (spawnMatch?.[1]?.trim()) {
      if (!bestSpawnErr || ts > bestSpawnErr.ts) bestSpawnErr = { ts, msg: spawnMatch[1]!.trim() };
    }
  }
  return bestStderr?.msg ?? bestSpawnErr?.msg;
}

function lspEnvelope(files: LspFileResult[]): HarnessEnvelope | undefined {
  if (files.length === 0) return undefined;
  const statuses = new Set(files.map(f => f.status));
  const hasUnavailable = statuses.has("unavailable");
  const hasUnconfirmed = statuses.has("unconfirmed");
  const hasUnsupported = statuses.has("unsupported");
  if (!hasUnavailable && !hasUnconfirmed && !hasUnsupported) return undefined;
  const next_actions = new Set<string>();
  let summary: string;
  let status: "success" | "warning" | "error";
  if (hasUnavailable) {
    summary = "One or more language servers could not be launched; diagnostics are unavailable for those files.";
    status = "warning";
    next_actions.add("Use navigation-debug to diagnose the language server launch; check ~/.pi-lens/sessionstart.log for the actual stderr.");
  } else if (hasUnconfirmed) {
    summary = "One or more checks timed out before confirmation; treat those files as not verified.";
    status = "warning";
    next_actions.add("Do not retry the unchanged validation; change the server/setup state, scope, input, or diagnostic hypothesis, or retain the result as unconfirmed and use a distinct owning check.");
  } else {
    summary = "One or more files have no configured primary language server candidate.";
    status = "warning";
    next_actions.add("Use navigation-debug if this extension should have a server for these files.");
  }
  const diagnostics: string[] = [];
  for (const f of files) {
    if (f.status === "unavailable" || f.status === "unconfirmed" || f.status === "unsupported") {
      diagnostics.push(`file=${f.path} status=${f.status}${f.note ? ` note=${f.note}` : ""}`);
    }
  }
  return { status, summary, next_actions: [...next_actions], artifacts: [], diagnostics };
}
