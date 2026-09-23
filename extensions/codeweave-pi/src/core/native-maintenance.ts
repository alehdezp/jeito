import { readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { callPiNav, piNavArtifactPaths, resolvePiNavTarget } from "./pi-nav-native.ts";
import { spawnSupervisedProcess } from "./process-supervisor.ts";
import { detectProjectRoot, resolvePreparationRoot } from "./project-root.ts";
import { enumerateNavigationCorpus } from "./navigation-corpus-policy.ts";
import { analysisProjectPaths, maintenanceCorpusDigest, readMaintenanceStatus } from "./analysis-project.mjs";
import type { AnalysisAdmission } from "./analysis-source.ts";
import type { MaintenanceStoreIdentity } from "../../native/analysis/storage.ts";
import { ANALYSIS_OUTPUT_ARTIFACTS, MAINTENANCE_OUTPUT_ARTIFACTS } from "../../native/analysis/identity.mjs";

/** Availability only: never load the addon, provision assets or allocate a store.
 * Semantic models are optional; the worker still owns compatibility validation. */
export function assertPackagedMaintenanceAvailable(
  runtimeDirectory = fileURLToPath(new URL("../../native/analysis/runtime", import.meta.url)),
): string {
  try {
    const runtime = realpathSync(runtimeDirectory);
    for (const name of [ANALYSIS_OUTPUT_ARTIFACTS.kernel, ...Object.values(MAINTENANCE_OUTPUT_ARTIFACTS)]) {
      const file = statSync(resolve(runtime, name));
      if (!file.isFile() || file.size === 0) throw new Error(`Missing maintenance artifact: ${name}`);
    }
    return runtime;
  } catch (error) {
    throw new Error(`Packaged indexed maintenance is unavailable; no automatic repair: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface NativeMaintenanceRequest {
  root: string;
  database: string;
  maxEntries: number;
  maxBytes: number;
  timeoutMs: number;
  policyFiles: { path: string; digest: string | null }[];
}

export interface NativeEvidenceStatus {
  root: string;
  generation: number;
  corpusDigest: string;
  files: number;
  symbols: number;
  unavailableFiles: number;
  evidence: string;
  watchDirectories: string[];
}

/** Explicit lifecycle job only. Its caller owns admission and the runtime-wide queue.
 * The optional executable is a process-boundary test seam, never project configuration.
 */
export async function updateNativeEvidence(
  request: NativeMaintenanceRequest,
  signal: AbortSignal,
  executable = piNavArtifactPaths(fileURLToPath(new URL("../../", import.meta.url)), resolvePiNavTarget()).cli,
): Promise<NativeEvidenceStatus> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 1_200_000) {
    throw new Error("Native maintenance requires a finite deadline of at most 20 minutes");
  }
  const root = realpathSync.native(request.root);
  const input = JSON.stringify({
    root, database: request.database, max_entries: request.maxEntries,
    max_bytes: request.maxBytes, timeout_ms: request.timeoutMs, policy_files: request.policyFiles,
  }) + "\n";
  if (Buffer.byteLength(input) > 65_536) throw new Error("Native maintenance request exceeds its protocol bound");
  const process = spawnSupervisedProcess(executable, ["update-index"], {
    cwd: root, signal, timeoutMs: request.timeoutMs,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let errorBytes = 0;
  let overflow = false;
  process.child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes <= 4 * 1024 * 1024) stdout.push(chunk);
    else { overflow = true; process.terminate(); }
  });
  process.child.stderr.on("data", (chunk: Buffer) => {
    if (errorBytes < 8192) stderr.push(chunk.subarray(0, 8192 - errorBytes));
    errorBytes += chunk.length;
  });
  process.child.stdin.on("error", () => process.terminate());
  // Do not end stdin after the request: EOF is the native child's parent-death signal.
  process.child.stdin.write(input);
  const exit = await process.done;
  process.child.stdin.destroy();
  signal.throwIfAborted();
  if (overflow) throw new Error("Native maintenance response exceeded its protocol bound");
  if (exit.code !== 0 || exit.error || exit.timedOut) {
    const reason = exit.timedOut ? "deadline exceeded" : exit.error ?? (Buffer.concat(stderr).toString("utf8").trim() || `exit ${exit.code ?? exit.signal}`);
    throw new Error(`Native maintenance failed: ${reason}`);
  }
  const result: NativeEvidenceStatus = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  if (!result || result.root !== root || !/^[A-F0-9]{64}$/.test(result.corpusDigest)
    || ![result.generation, result.files, result.symbols, result.unavailableFiles].every(value => Number.isSafeInteger(value) && value >= 0)
    || result.generation < 1 || result.unavailableFiles > result.files || typeof result.evidence !== "string"
    || !Array.isArray(result.watchDirectories) || result.watchDirectories.length > request.maxEntries
    || !result.watchDirectories.every(value => typeof value === "string" && !value.includes("\0") && !isAbsolute(value) && !value.split("/").includes(".."))) {
    throw new Error("Native maintenance returned an invalid or mismatched result");
  }
  return result;
}

export interface AdmittedMaintenanceRequest {
  root: string;
  directory: string;
  admission: AnalysisAdmission & { policyDigest: string };
  previous?: MaintenanceStoreIdentity;
  timeoutMs: number;
}

export type AdmittedMaintenanceResult =
  | { status: "busy"; root: string; directory: string }
  | { status: "finished"; root: string; directory: string; store: MaintenanceStoreIdentity; runId: string; counts: Record<string, number> };

/** Explicit isolated maintenance, not automatic activation. Native queries must
 * independently validate the completed-run status and their current admission.
 * The child owns the OS lock before loading the donor. Runtime/worker overrides
 * are internal process-boundary test seams, never repository configuration. */
export async function runAdmittedMaintenance(
  request: AdmittedMaintenanceRequest,
  signal: AbortSignal,
  runtimeDirectory = fileURLToPath(new URL("../../native/analysis/runtime", import.meta.url)),
  workerPath = fileURLToPath(new URL("./analysis-maintenance-worker.mjs", import.meta.url)),
): Promise<AdmittedMaintenanceResult> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 1_200_000) {
    throw new Error("Admitted maintenance requires a finite deadline of at most 20 minutes");
  }
  const input = JSON.stringify(request) + "\n";
  if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw new Error("Maintenance census exceeds its request bound");
  const worker = spawnSupervisedProcess(process.execPath, [workerPath, realpathSync(runtimeDirectory)], {
    cwd: request.root, signal, timeoutMs: request.timeoutMs,
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let errors = Buffer.alloc(0);
  let overflow = false;
  worker.child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 65_536) chunks.push(chunk);
    else { overflow = true; worker.terminate(); }
  });
  worker.child.stderr.on("data", (chunk: Buffer) => { errors = Buffer.concat([errors, chunk]).subarray(-8192); });
  worker.child.stdin.on("error", () => worker.terminate());
  try {
    // Reuse the existing worker-thread parent watchdog, including blocked-main
    // termination. Ending this pipe would revoke ownership, not finish input.
    worker.child.stdin.write(input);
    const exit = await worker.done;
    signal.throwIfAborted();
    if (overflow) throw new Error("Maintenance receipt exceeded its output bound");
    if (exit.code !== 0 || exit.error || exit.timedOut) {
      throw new Error(`Admitted maintenance failed: ${exit.timedOut ? "deadline exceeded" : errors.toString("utf8").trim() || exit.error || exit.signal || exit.code}`);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (result?.root !== request.root || result.directory !== request.directory) throw new Error("Maintenance returned a mismatched project");
    if (result.status === "busy") return result;
    if (result.status !== "finished" || result.store?.root !== request.root || result.store.directory !== request.directory
      || result.store.database !== resolve(request.directory, "graph.sqlite")
      || typeof result.runId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result.runId)
      || ![result.store.dev, result.store.ino].every(value => Number.isSafeInteger(value) && value >= 0)
      || !result.counts || typeof result.counts !== "object" || Array.isArray(result.counts)
      || !Object.values(result.counts).every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
      throw new Error("Maintenance returned an invalid receipt");
    }
    // A child's success receipt is not cross-process readiness: another writer
    // may already have replaced it. Queries independently pin this same record.
    const status = readMaintenanceStatus(analysisProjectPaths(request, false));
    if (!status || status.state !== "ready" || status.runId !== result.runId
      || status.policyDigest !== request.admission.policyDigest
      || status.corpusDigest !== maintenanceCorpusDigest(request.admission.files)
      || status.databaseDev !== result.store.dev || status.databaseIno !== result.store.ino) {
      throw new Error("Completed maintenance run is no longer ready for this project and corpus");
    }
    return result;
  } finally {
    worker.child.stdin.destroy();
    if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.terminate(); await worker.done; }
  }
}

export interface CapturedAnalysisRequest {
  root: string;
  database: string;
  /** Omit only for explicit preparation: the child initializes/inspects and pins the base. */
  baseGeneration?: number;
  timeoutMs: number;
  /** Opt-in shared-corpus admission for the manually invoked candidate. */
  policyDigest?: string;
  /** Require the capture to equal the admitted project, including empty retirement. */
  captureMode?: "project";
  files: { path: string; text: string; language: string | null }[];
  /** One request is one pass: code publication (default) or semantic completion. */
  phase?: "code" | "semantic";
  /** Explicit private local model directory. Required for, and only valid with, the semantic phase. */
  modelDirectory?: string;
  /** Expected representation identity; the semantic phase pins it against the store and the native reply. */
  recipe?: string;
}

/** Node-level semantic coverage of one published generation. */
export interface CapturedAnalysisSemanticCoverage {
  recipe: string;
  dimensions: number;
  represented: number;
  missing: number;
  unsupported: number;
}

export interface CapturedAnalysisResult {
  root: string;
  generation: number;
  /** The child-selected base when the parent deliberately omitted it. Not persisted metadata. */
  baseGeneration?: number;
  kernelVersion: string;
  interpretationRevision: string;
  captureDigest: string;
  policyDigest?: string;
  corpus: "explicit-capture" | "project-capture";
  codeFiles: number;
  capturedFiles: number;
  nodes: number;
  unresolvedReferences: number;
  /** `published` advanced the generation; `unchanged` validated the same one. */
  status: "published" | "unchanged";
  /** Present for a generation whose store carries the semantic schema. `stored`
   * counts the vectors this pass committed and is receipt-only. */
  semantic?: CapturedAnalysisSemanticCoverage & { stored: number; failures?: number; failure?: string };
}

/** Runs one admitted capture; admission and the runtime-wide queue remain caller-owned.
 * Resolve the default worker beside this module so assembled candidates stay isolated.
 */
export async function runCapturedAnalysis(
  request: CapturedAnalysisRequest,
  signal: AbortSignal,
  workerPath = fileURLToPath(new URL("./analysis-worker.mjs", import.meta.url)),
): Promise<CapturedAnalysisResult> {
  signal.throwIfAborted();
  const input = JSON.stringify(request) + "\n";
  if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw new Error("Encoded capture exceeds the 8 MiB candidate request boundary");
  const worker = spawnSupervisedProcess(process.execPath, [workerPath], { cwd: request.root, signal, timeoutMs: request.timeoutMs });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let total = 0;
  let overflow = false;
  for (const [stream, chunks] of [[worker.child.stdout, stdout], [worker.child.stderr, stderr]] as const) {
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total <= 65_536) chunks.push(chunk);
      else { overflow = true; worker.terminate(); }
    });
  }
  worker.child.stdin.on("error", () => worker.terminate());
  try {
    // Keep open: EOF tells the worker that its parent died.
    worker.child.stdin.write(input);
    const exit = await worker.done;
    signal.throwIfAborted();
    if (overflow) throw new Error("Analysis worker output exceeded its boundary");
    if (exit.code !== 0 || exit.error || exit.timedOut) throw new Error(`Analysis failed: ${Buffer.concat(stderr).toString("utf8").trim() || exit.error || exit.signal || exit.code}`);
    const result: CapturedAnalysisResult = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    // A pass either advanced the generation or validated the same one; both are
    // real answers, but neither may claim the other's generation.
    const base = request.baseGeneration ?? result?.baseGeneration;
    if (typeof base !== "number" || !Number.isSafeInteger(base) || base < 0 || base >= Number.MAX_SAFE_INTEGER
      || result?.baseGeneration !== undefined && result.baseGeneration !== base) {
      throw new Error("Analysis returned an invalid base generation");
    }
    const expectedGeneration = result?.status === "published" ? base + 1
      : result?.status === "unchanged" ? base : undefined;
    if (!result || expectedGeneration === undefined || result.root !== request.root
      || result.generation !== expectedGeneration
      || result.policyDigest !== request.policyDigest
      || result.corpus !== (request.captureMode === "project" ? "project-capture" : "explicit-capture")) {
      throw new Error("Analysis returned a mismatched publication");
    }
    if (result.semantic !== undefined) {
      if (!Number.isSafeInteger(result.semantic.dimensions) || result.semantic.dimensions < 1
        || typeof result.semantic.recipe !== "string" || result.semantic.recipe.length === 0) {
        throw new Error("Analysis returned invalid semantic coverage");
      }
      for (const key of ["represented", "missing", "unsupported", "stored"] as const) {
        const value = result.semantic[key];
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("Analysis returned invalid semantic coverage");
      }
    }
    return result;
  } finally {
    worker.child.stdin.destroy();
    if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.terminate(); await worker.done; }
  }
}

/** An explicit local model directory: absolute, canonical and actually present.
 * A model is never located, downloaded or defaulted to by this module. */
function localDirectory(path: string | undefined): path is string {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  try { return realpathSync(path) === path && statSync(path).isDirectory(); }
  catch { return false; }
}

/** Explicit maintenance only. Omitted files means a complete policy-bound project
 * capture; supplied files retain the development candidate's explicit capture.
 * No build, query-time work, retained SQLite connection or automatic activation.
 */
export async function prepareAnalysisProject(
  request: { root: string; directory: string; files?: { path: string; language: string | null }[]; respectPolicy?: boolean; timeoutMs?: number; onCorpus?: (directories: readonly string[]) => void;
    /** Code publication (default) or semantic completion of an existing publication. */
    phase?: "code" | "semantic";
    /** Private explicit model choice; no default lookup or activation happens. Required for the semantic phase. */
    modelDirectory?: string },
  signal: AbortSignal,
): Promise<CapturedAnalysisResult> {
  const semantic = request.phase === "semantic";
  if (request.phase !== undefined && request.phase !== "code" && !semantic) throw new Error("Invalid preparation phase");
  if (semantic) {
    if (!localDirectory(request.modelDirectory)) throw new Error("Semantic completion requires an explicit canonical local model directory");
  } else if (request.modelDirectory !== undefined) {
    throw new Error("A model directory is only valid for semantic completion");
  }
  const timeoutMs = request.timeoutMs ?? 25_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_200_000) throw new Error("Invalid preparation deadline");
  signal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    signal.throwIfAborted();
    const timeout = Math.floor(deadline - performance.now());
    if (timeout <= 0) throw new Error("Project preparation deadline exceeded");
    return timeout;
  };
  // Separate from the foreground native queue; survive module reload without
  // starting overlapping maintenance children in one Pi runtime.
  const key = Symbol.for("jeito.analysisPreparation.v1");
  const queue = ((globalThis as any)[key] ??= { tail: Promise.resolve() }) as { tail: Promise<void> };
  let started = false;
  const pending = queue.tail.then(async () => {
    started = true;
    remaining();
    const root = detectProjectRoot(request.root).root;
    const project = request.files === undefined;
    if (project && request.root !== root) throw new Error(`Project preparation requires the exact project root: ${root}`);
    if (project || request.respectPolicy) {
      const admission = await resolvePreparationRoot(request.root, { signal });
      if (!admission.allowed || admission.root !== root) throw new Error(`Project preparation root is unavailable: ${admission.reason}`);
    }
    const census = project || request.respectPolicy
      ? await enumerateNavigationCorpus(root, "code", callPiNav, { signal, timeoutMs: remaining() })
      : undefined;
    if (census) request.onCorpus?.(census.directories);
    const allowed = census && new Set(census.files);
    const selected = request.files ?? census!.files.map(path => ({ path, language: null }));
    if (!project && !selected.length) throw new Error("Explicit capture requires at least one file");
    const seen = new Set<string>();
    let bytes = 0;
    const files = selected.map(file => {
      remaining();
      const absolute = resolve(request.root, file.path);
      const local = relative(request.root, absolute);
      if (!local || local === ".." || local.startsWith(`..${sep}`) || realpathSync(absolute) !== absolute || !statSync(absolute).isFile()) throw new Error(`Capture requires an in-root regular, non-symlink file: ${file.path}`);
      const path = relative(root, absolute).split(sep).join("/");
      if (allowed && !allowed.has(path)) throw new Error(`Requested capture is outside the admitted code corpus: ${file.path}`);
      if (seen.has(path)) throw new Error(`Duplicate captured file: ${file.path}`);
      seen.add(path);
      const size = statSync(absolute).size;
      if (bytes + size > 8 * 1024 * 1024) throw new Error("Capture exceeds the 8 MiB boundary");
      const raw = readFileSync(absolute);
      bytes += raw.length;
      if (bytes > 8 * 1024 * 1024) throw new Error("Capture exceeds the 8 MiB boundary");
      const text = raw.toString("utf8");
      if (!raw.equals(Buffer.from(text))) throw new Error(`Capture is not UTF-8: ${file.path}`);
      return { path, text, language: file.language };
    });
    remaining();
    // Only the existing supervised child opens SQLite. The foreground reader
    // uses a different SQLite library, whose WAL state cannot share this process.
    const store = analysisProjectPaths({ root, directory: request.directory }, !semantic);
    return runCapturedAnalysis({ root, database: store.database,
      files, timeoutMs: remaining(), ...(census ? { policyDigest: census.digest } : {}),
      ...(project ? { captureMode: "project" as const } : {}),
      ...(semantic ? { phase: "semantic" as const, modelDirectory: request.modelDirectory! } : {}) }, signal);
  });
  queue.tail = pending.then(() => undefined, () => undefined);
  // A queued caller can stop waiting immediately. Once running, wait for the
  // supervised child to close; rejecting early must not orphan maintenance.
  return new Promise((resolve, reject) => {
    const cancelWaiting = () => { if (!started) reject(signal.reason); };
    signal.addEventListener("abort", cancelWaiting, { once: true });
    if (signal.aborted) cancelWaiting();
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancelWaiting));
  });
}

/** Active-project lifecycle used after ordinary registration admits a project.
 * Nothing runs until start(); watch events are only hints, and preparation and
 * queries still verify the authoritative corpus and bytes. The optional
 * preparer is a coordination-test seam, not project configuration.
 */
export function createAnalysisLifecycle(
  project: { root: string; directory: string; modelDirectory?: string },
  allowed: () => boolean,
  prepare: (request: Parameters<typeof prepareAnalysisProject>[0], signal: AbortSignal) => Promise<CapturedAnalysisResult | AdmittedMaintenanceResult | void> = prepareAnalysisProject,
) {
  let active = false;
  let activation = 0;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let completion: AbortController | undefined;
  let abort = new AbortController();
  let state = "inactive";
  let error: string | undefined;
  let watchError: string | undefined;
  const watchers = new Map<string, { watcher: FSWatcher; dev: number; ino: number }>();
  const closeWatchers = () => { for (const item of watchers.values()) item.watcher.close(); watchers.clear(); };
  const cancelTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };

  function updateWatchers(directories: readonly string[]) {
    if (!active || abort.signal.aborted) return;
    if (!allowed()) { void stop(); return; }
    const wanted = new Set(directories.map(directory => resolve(project.root, directory)));
    for (const [path, item] of watchers) {
      if (!wanted.has(path)) { item.watcher.close(); watchers.delete(path); }
    }
    try {
      for (const path of wanted) {
        const local = relative(project.root, path);
        if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)
            || realpathSync(path) !== path) throw new Error("Watch directory changed or escaped the admitted root");
        const identity = statSync(path);
        if (!identity.isDirectory()) throw new Error("Watch path is no longer a directory");
        const previous = watchers.get(path);
        if (previous?.dev === identity.dev && previous.ino === identity.ino) continue;
        previous?.watcher.close();
        watchers.delete(path);
        // Shallow subscriptions use the admitted directory census on every OS;
        // excluded and nested-project subtrees are not recursively watched.
        const watcher = watch(path, { persistent: false }, () => invalidate());
        watcher.on("error", failure => {
          if (watchers.get(path)?.watcher !== watcher) return;
          watchError = String(failure.message);
          closeWatchers();
        });
        watchers.set(path, { watcher, dev: identity.dev, ino: identity.ino });
      }
      watchError = undefined;
    } catch (failure) {
      watchError = failure instanceof Error ? failure.message : String(failure);
      closeWatchers();
      // Resource failure degrades watching, not explicit reconciliation or the
      // query's source/policy/corpus guards. A later checkpoint retries watches.
    }
  }

  function invalidate() {
    if (!active) return;
    if (!allowed()) { void stop(); return; }
    dirty = true;
    state = "pending";
    // A change supersedes an in-flight semantic pass, so it is cancelled at this
    // owner; the code pass keeps its existing dirty-follow-up behavior.
    if (running) { completion?.abort(new Error("Analysis project changed during semantic completion")); return; }
    cancelTimer();
    timer = setTimeout(() => { timer = undefined; void run(); }, 400);
    timer.unref?.();
  }

  function run(): Promise<void> {
    if (running) return running;
    if (!active || !allowed()) return stop();
    dirty = false;
    state = "preparing";
    error = undefined;
    const signal = abort.signal;
    // An explicit model directory is the only authority to complete semantics,
    // and a capture already dirty behind us is about to be replaced anyway.
    const { modelDirectory, ...base } = project;
    running = prepare({ ...base, onCorpus: updateWatchers }, signal)
      .then(async result => {
        if (!active || signal.aborted) return;
        if (result?.status === "busy") {
          dirty = false;
          state = "unavailable";
          error = "Analysis maintenance is busy; live evidence remains available";
          return;
        }
        if (!active || signal.aborted || modelDirectory === undefined || dirty) return;
        const controller = new AbortController();
        completion = controller;
        try {
          const result = await prepare({ ...base, onCorpus: updateWatchers, phase: "semantic", modelDirectory },
            AbortSignal.any([signal, controller.signal]));
          if (!active || signal.aborted || controller.signal.aborted) return;
          // Partial progress schedules the remaining owners through this same
          // lifecycle; a pass that stored nothing fails instead of spinning.
          const semantic = (result as CapturedAnalysisResult | undefined)?.semantic;
          if (semantic && semantic.stored > 0 && semantic.missing > 0) invalidate();
        } catch (failure) {
          if (controller.signal.aborted || signal.aborted) return;
          throw failure;
        } finally {
          if (completion === controller) completion = undefined;
        }
      })
      .then(() => { if (active && !signal.aborted && state !== "unavailable") state = dirty ? "pending" : "ready"; })
      .catch(failure => { if (active && !signal.aborted) { state = "failed"; error = failure instanceof Error ? failure.message : String(failure); } })
      .finally(() => { running = undefined; if (active && dirty) invalidate(); });
    return running;
  }

  async function stop() {
    activation++;
    active = false;
    dirty = false;
    state = "inactive";
    cancelTimer();
    closeWatchers();
    completion?.abort(new Error("Analysis project deactivated"));
    abort.abort(new Error("Analysis project deactivated"));
    await running;
  }

  return {
    async start(): Promise<void> {
      if (!allowed()) return stop();
      if (active) return running;
      const requested = activation;
      await running;
      if (requested !== activation || !allowed()) return;
      if (active) return running;
      active = true;
      abort = new AbortController();
      return run();
    },
    invalidate,
    stop,
    status: () => ({ state, watching: watchers.size, error, watchError }),
  };
}
