import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { envWithNavigationProviders, loadNavigationAutomationConfig } from "./src/core/navigation-automation-config.ts";
import { createMarkdownFrontmatterExposureState } from "./src/core/markdown-frontmatter.ts";
import { compactNavigationLaneStatus } from "./src/core/navigation-lane-status.ts";
import { recordPerfEvent } from "./src/core/perf-telemetry.ts";
import { codeMaintenanceOwner, readCandidateMetadata, selectCandidateCodeOwner, dirtyPreparedBackends } from "./src/core/prepared-mutation.ts";
import { shutdownQmdDocsRefreshes } from "./src/core/qmd-docs-refresh.ts";
import { shutdownStructuralBlockResolver } from "./src/core/structural-block-resolver.ts";
import { shutdownLspValidation } from "./src/core/lsp-validation.ts";
import { detectProjectRoot, resolvePreparationRoot } from "./src/core/project-root.ts";
import { recordToolCall } from "./src/core/tool-call-ledger.ts";
import { EXTENSION_ROOT, loadedRuntimeIdentity, ownedRuntimeReady, type LoadedRuntimeIdentity } from "./src/core/owned-runtime.ts";
import { registerDiffTool } from "./src/tools/diff.ts";
import { registerEditTool } from "./src/tools/edit.ts";
import { registerDocsSearchTool } from "./src/tools/docs-search.ts";
import { registerExploreTool } from "./src/tools/explore.ts";
import { registerFindTool } from "./src/tools/find.ts";
import { registerGrepTool } from "./src/tools/grep.ts";
import { registerLsTool } from "./src/tools/ls.ts";
import { registerLspValidateTool } from "./src/tools/lsp-validate.ts";
import { registerReadTool } from "./src/tools/read.ts";
import { registerTraceTool } from "./src/tools/trace.ts";
import { registerWriteTool } from "./src/tools/write.ts";
import { createAnalysisLifecycle, runAdmittedMaintenance, assertPackagedMaintenanceAvailable } from "./src/core/native-maintenance.ts";
import { deriveAnalysisProject, ensureAnalysisProjectParent, analysisProjectPaths, readMaintenanceStatus, assertEmptyAnalysisProject } from "./src/core/analysis-project.mjs";
import { enumerateNavigationCorpus } from "./src/core/navigation-corpus-policy.ts";
import { preflightNavigationTarget } from "./src/core/navigation-preflight.ts";
import { planNavigationScope } from "./src/core/scope-planner.ts";
import { analysisSemanticModelDirectory, assertPiNavGrepAvailable, callPiNav, piNavArtifactPaths, resolvePiNavTarget } from "./src/core/pi-nav-native.ts";

const PUBLIC_TOOLS = ["explore", "trace", "docs_search", "grep", "find", "ls", "read", "edit", "write", "diff", "lsp_validate"];

const READ_NUDGE =
  "Shell output is reduced, not the file: lines are dropped and repeats collapsed before you see them. Read the bytes with `read({path: \"FILE\"})` — whole file, numbered, hash-certified — or `read({path: \"FILE:120-180\"})` for a range.";
// The tool-result handler matches this prefix for idempotency; keep the two in sync.
const READ_NUDGE_SENTINEL = "Shell output is reduced, not the file";
const CAT_READ_NUDGE = READ_NUDGE;
const WRITE_NUDGE =
  "Prefer `write`/`edit` over `bash cat >` for file writes — `write`/`edit` are hash-certified, create parent directories, and avoid heredoc/redirection pitfalls. Use `write({path: \"FILE\", content: \"...\"})` or `edit({path: \"FILE\", ...})` instead of `bash({command: \"cat > FILE <<'EOF'\\n...\"})`.";

function splitRootSegments(command: string): string[] {
  // Split by command separators that start a new command: ; && || & newline
  // Pipe `|` is NOT a separator here — commands after `|` are piped input and ignored.
  const sequences = String(command ?? "").split(/\s*(?:;|\n|\r\n|&&|\|\|)\s*|\s*&\s*/);
  const roots: string[] = [];
  for (const seq of sequences) {
    const trimmed = String(seq).trim();
    if (!trimmed) continue;
    // Only the first pipe segment is at root; segments after `|` are piped.
    const firstPipe = trimmed.split(/\s*\|\s*/)[0]?.trim() ?? "";
    if (firstPipe) roots.push(firstPipe);
  }
  return roots;
}
// Shell reads of project text. The nudge is about source bytes, so a target that is plainly
// not project text (logs, archives, binaries, databases) never fires it, and a segment that
// redirects elsewhere is a write. A missed nudge costs less than a wrong one.
const SOURCE_READ = /^\s*(?:cat|head|tail|nl|bat)\b/;
const NON_SOURCE_TARGET = /\.(?:log|out|err|txt|csv|tsv|dat|bin|gz|tgz|zip|tar|dmg|pdf|png|jpe?g|gif|webp|ico|mp4|mov|sqlite\d*|db|lock)$/i;

/** The file a root segment acts on: its last shell word, unquoted. */
function targetWord(seg: string): string {
  const words = seg.trim().split(/\s+/);
  return String(words[words.length - 1] ?? "").replace(/^["']|["']$/g, "");
}

function readsSourceAtRoot(command: string): boolean {
  for (const seg of splitRootSegments(command)) {
    if (!SOURCE_READ.test(seg)) continue;
    if (/>/.test(seg)) continue;
    if (NON_SOURCE_TARGET.test(targetWord(seg))) continue;
    return true;
  }
  return false;
}

/** `sed` at root: `-i`/`--in-place` in its flags rewrites the file; otherwise it prints. */
function sedUsage(command: string): { read: boolean; write: boolean } {
  const usage = { read: false, write: false };
  for (const seg of splitRootSegments(command)) {
    if (!/^\s*sed\b/.test(seg)) continue;
    if (/(?:^|\s)-[A-Za-z]*i[A-Za-z0-9._-]*(?=\s|$)|\s--in-place(?=\s|=|$)/.test(seg)) usage.write = true;
    else usage.read = true;
  }
  return usage;
}
function hasCatWriteAtRoot(command: string): boolean {
  for (const seg of splitRootSegments(command)) if (/^\s*cat\s*>>?\s*/.test(seg)) return true;
  return false;
}

const broadAutoPrepared = new Set<string>();
const sessionStartPrepared = new Set<string>();

/**
 * C1 (git-only auto-setup gate, minimal): automatic install/prepare is allowed
 * only when the project root is explicitly opted-in (`.pi-navigation.json` present)
 * OR under git control (`.git` at root or any ancestor). Non-git folders with no
 * navigation artifacts do NOT auto-install; they get a `/navigation-setup` notice.
 * Auto-refresh still works once `.pi-navigation.json` exists. Local on purpose (D4).
 */
function autoSetupAllowed(root: string): boolean {
  if (existsSync(join(root, ".pi-navigation.json"))) return true;
  for (let current = root; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
  }
}

function normalizedPrompt(prompt: string): string {
  return String(prompt ?? "").toLowerCase().replace(/[“”]/g, '"').replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
}

function isBroadNavigationPrompt(prompt: string): boolean {
  const text = normalizedPrompt(prompt);
  if (!text) return false;
  const metaMaintenance = /\b(agent instructions|coding assistant instructions|tool[- ]routing|prompt(?:ing)? rules|system prompt|append_system|navigation instructions)\b/.test(text);
  if (metaMaintenance && /\b(architecture docs?|docs? wording|instructions?)\b/.test(text)) return false;
  if (/\b(update|edit|improve|rewrite|review|fix|polish|document|write)\b.{0,120}\b(architecture docs?|docs? wording|agent instructions|tool[- ]routing|system prompt|prompt rules)\b/.test(text)) return false;
  if (/\b(help me understand|understand (this|the|current) (repo|repository|codebase|project|folder)|explain (this|the|current) (repo|repository|codebase|project|folder)|what is (this|the|current) (repo|repository|codebase|project|folder) about|repo overview|repository overview|codebase overview|project overview|folder overview|where should i start|first files to open|5-minute (repo |repository |codebase |project )?orientation)\b/.test(text)) return true;
  if (/\b(walk me through|explain|understand|overview of|map)\b.{0,60}\b(architecture|subsystems?|responsibilities)\b/.test(text)) return true;
  if (/\b(architecture|subsystem) overview\b/.test(text)) return true;
  if (/\bwhere does [^?]{2,120}\b(start|begin|enter)\b/.test(text)) return true;
  if (/\bhow do [^?]{2,120}\b(connect|fit together|interact|relate)\b/.test(text)) return true;
  if (/\bmap [^?]{2,120}\bresponsibilities\b/.test(text)) return true;
  return false;
}

function setupSummary(prefix: string, result: any): string {
  const summary = result?.plan?.summary;
  if (!summary) return `${prefix}: unavailable`;
  const audit = result?.dryRun || result?.mode === "dry-run"
    ? "Audit log: not written in dry-run; it is written only when automatic setup executes."
    : `Audit log: ${result.root}/.pi/navigation-setup.log.jsonl`;
  return `${prefix}: ${result.status}; automatic=${summary.automatic}, guided=${summary.guided}, blocked=${summary.blocked}. ${audit}`;
}
function notifyNavigation(ctx: any, message: string, type: "info" | "warning" | "error" = "info"): void {
  try {
    ctx?.ui?.notify?.(message, type);
  } catch {
    // Notifications are best-effort; stderr fallback below is the user-visible safety net.
  }
  if (process.env.PI_NAV_SUPPRESS_STDERR_NOTICE !== "1") {
    try { process.stderr.write(`[jeito-codeweave-pi] ${message}\n`); } catch {}
  }
}

function setupNotification(result: any): { message: string; type: "info" | "warning" } {
  const summary = result?.plan?.summary;
  const automatic = summary?.automatic ?? 0;
  const guided = summary?.guided ?? 0;
  const blocked = summary?.blocked ?? 0;
  const root = result?.root ?? "this folder";
  const audit = result?.auditLog ?? `${root}/.pi/navigation-setup.log.jsonl`;
  if (result?.status === "started") {
    return { message: `Project navigation: preparing ${root} in background. Ordinary small projects should get local docs and code orientation indexes; monorepos may record guided/skipped scope decisions in the audit. Audit: ${audit}. If this does not finish, use navigation-debug for diagnosis.`, type: "warning" };
  }
  if (result?.status === "already_running") {
    return { message: `Project navigation: prepare already running for ${root}; not starting another background job. ${result.reason ?? ""} Audit: ${audit}.`, type: "info" };
  }
  if (automatic > 0 || result?.execution?.length) {
    const followup = guided || blocked ? " Ask: prepare this folder for better navigation." : "";
    return { message: `Project navigation checked ${root}: ${result?.status ?? "planned"}; automatic=${automatic}, guided=${guided}, blocked=${blocked}.${followup} Audit: ${audit}.`, type: blocked || guided ? "warning" : "info" };
  }
  return { message: `Project navigation is not fully prepared for ${root}: automatic=${automatic}, guided=${guided}, blocked=${blocked}. Ask: prepare this folder for better navigation. Audit: ${audit}.`, type: "warning" };
}




function staleLoadedRuntimeMessage(identity: LoadedRuntimeIdentity): string {
  const cause = identity.sourceExists
    ? "the loaded codeweave-pi source changed after this Pi process imported it"
    : "the loaded codeweave-pi package root no longer exists";
  return `Loaded codeweave-pi runtime is stale: ${cause} at ${identity.packageRoot}. In-process reload or filesystem search would risk mixing package versions. Stop Pi, use jeito-setup from the current checkout to inspect and repair registration, then restart Pi and verify the loaded package identity.`;
}

function prepareLockPath(root: string, trigger: string): string {
  return join(root, ".pi", "navigation", "locks", `prepare-${trigger}.lock.json`);
}

function preparePendingPath(root: string, trigger: string): string {
  return join(root, ".pi", "navigation", "locks", `prepare-${trigger}.pending.json`);
}

function markPreparePending(root: string, trigger: string, reason: string): void {
  const pendingPath = preparePendingPath(root, trigger);
  mkdirSync(dirname(pendingPath), { recursive: true });
  try { writeFileSync(pendingPath, `${JSON.stringify({ root, trigger, reason, requestedAt: new Date().toISOString() }, null, 2)}\n`); } catch {}
}

function consumePreparePending(root: string, trigger: string): any | undefined {
  const pendingPath = preparePendingPath(root, trigger);
  const pending = readPrepareLock(pendingPath);
  if (pending) {
    try { rmSync(pendingPath, { force: true }); } catch {}
  }
  return pending;
}

function readPrepareLock(lockPath: string): any | undefined {
  try { return JSON.parse(readFileSync(lockPath, "utf8")); } catch { return undefined; }
}

function pidIsAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function activePrepareAcrossTriggers(root: string, exceptTrigger?: string): { trigger: string; lockPath: string; existing: any } | undefined {
  for (const trigger of ["session_start", "first_broad_request", "stop_refresh"]) {
    if (trigger === exceptTrigger) continue;
    const lockPath = prepareLockPath(root, trigger);
    const existing = readPrepareLock(lockPath);
    if (existing && pidIsAlive(existing.pid)) return { trigger, lockPath, existing };
  }
  return undefined;
}

function acquirePrepareLock(root: string, trigger: string, ttlMs = 30 * 60 * 1000): { acquired: true; lockPath: string } | { acquired: false; lockPath: string; existing: any; reason: string } {
  const lockPath = prepareLockPath(root, trigger);
  mkdirSync(dirname(lockPath), { recursive: true });
  const existing = readPrepareLock(lockPath);
  const age = existing?.startedAt ? Date.now() - Date.parse(existing.startedAt) : Number.POSITIVE_INFINITY;
  if (existing && age < ttlMs && pidIsAlive(existing.pid)) {
    return { acquired: false, lockPath, existing, reason: `prepare already running for ${root} (${trigger}) as pid ${existing.pid}` };
  }
  if (existing && age < ttlMs && existing.status === "starting") {
    return { acquired: false, lockPath, existing, reason: `prepare recently started for ${root} (${trigger})` };
  }
  writeFileSync(lockPath, `${JSON.stringify({ root, trigger, pid: process.pid, status: "starting", startedAt: new Date().toISOString() }, null, 2)}\n`);
  return { acquired: true, lockPath };
}

function writePrepareLockStarted(lockPath: string, record: any): void {
  try { writeFileSync(lockPath, `${JSON.stringify({ ...record, status: "running", startedAt: new Date().toISOString() }, null, 2)}\n`); } catch {}
}

function releasePrepareLock(lockPath: string, pid: number | undefined): void {
  const current = readPrepareLock(lockPath);
  if (!current || current.pid === pid) {
    try { rmSync(lockPath, { force: true }); } catch {}
  }
}

const DEFAULT_STOP_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

function stopRefreshRecentPath(root: string): string {
  return join(root, ".pi", "navigation", "locks", "prepare-stop_refresh.last.json");
}

function stopRefreshMinIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = String(env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS ?? "").trim();
  if (!raw) return DEFAULT_STOP_REFRESH_MIN_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_STOP_REFRESH_MIN_INTERVAL_MS;
  return Math.floor(value);
}

function activeStopRefreshLock(root: string): boolean {
  const existing = readPrepareLock(prepareLockPath(root, "stop_refresh"));
  return Boolean(existing && pidIsAlive(existing.pid));
}

function recentStopRefresh(root: string, env: Record<string, string | undefined> = process.env): { status: "throttled"; reason: string; root: string; auditLog: string; trigger: "stop_refresh"; recentPath: string; minIntervalMs: number } | undefined {
  const minIntervalMs = stopRefreshMinIntervalMs(env);
  if (minIntervalMs <= 0) return undefined;
  const recentPath = stopRefreshRecentPath(root);
  const recent = readPrepareLock(recentPath);
  const startedAt = typeof recent?.startedAt === "string" ? Date.parse(recent.startedAt) : Number.NaN;
  if (!Number.isFinite(startedAt)) return undefined;
  const age = Date.now() - startedAt;
  if (age < minIntervalMs) {
    const seconds = Math.ceil((minIntervalMs - age) / 1000);
    return { status: "throttled", root, trigger: "stop_refresh", auditLog: join(root, ".pi", "navigation-setup.log.jsonl"), recentPath, minIntervalMs, reason: `stop_refresh ran recently; next automatic refresh allowed in ~${seconds}s` };
  }
  return undefined;
}

function markStopRefreshStarted(root: string, record: any): void {
  const recentPath = stopRefreshRecentPath(root);
  mkdirSync(dirname(recentPath), { recursive: true });
  try { writeFileSync(recentPath, `${JSON.stringify({ root, trigger: "stop_refresh", pid: record.pid, auditLog: record.auditLog, startedAt: new Date().toISOString() }, null, 2)}\n`); } catch {}
}

export function startBackgroundPrepare(cwd: string, loaded: any, options: { trigger: "session_start" | "first_broad_request" | "stop_refresh"; query?: string; startupSafe?: boolean; fullStack?: boolean; queueIfRunning?: boolean; backends?: string[] }): { status: string; summary: string; root: string; auditLog: string; trigger: string; pid?: number; lockPath?: string; reason?: string; pendingQueued?: boolean } {
  const auditLog = join(cwd, ".pi", "navigation-setup.log.jsonl");
  const backends = options.backends ?? (options.trigger === "stop_refresh" ? ["graphify"] : ["qmd", "graphify"]);
  // An empty list MUST NOT reach the CLI, where an empty list means every backend.
  if (!backends.length) return { status: "suppressed", summary: "No backend requested; refusing to launch prepare", reason: "an empty backend list would select every prepare backend", root: cwd, auditLog, trigger: options.trigger };
  const active = activePrepareAcrossTriggers(cwd, options.trigger);
  if (active) {
    const reason = `prepare already running for ${cwd} (${active.trigger}) as pid ${active.existing.pid}`;
    if (options.queueIfRunning) markPreparePending(cwd, options.trigger, reason);
    return { status: "already_running", summary: reason, root: cwd, auditLog, trigger: options.trigger, pid: active.existing.pid, lockPath: active.lockPath, reason, pendingQueued: Boolean(options.queueIfRunning) };
  }
  const lock = acquirePrepareLock(cwd, options.trigger);
  if (!lock.acquired) {
    if (options.queueIfRunning) markPreparePending(cwd, options.trigger, lock.reason);
    return { status: "already_running", summary: lock.reason, root: cwd, auditLog, trigger: options.trigger, pid: lock.existing?.pid, lockPath: lock.lockPath, reason: lock.reason, pendingQueued: Boolean(options.queueIfRunning) };
  }
  // Preparation is detached from the UI. One bounded 20-minute ceiling lets
  // legitimate embedding/docs builds finish while still killing stuck work.
  const fullStack = options.fullStack ?? (loaded.config.automation.mode === "aggressive");
  const startupSafe = options.startupSafe ?? options.trigger === "session_start";
  const configuredBudget = Number(loaded.config.automation.startupAutoPrepareBudgetMs);
  const configuredTimeout = Number(loaded.config.automation.startupAutoPrepareActionTimeoutMs);
  const fallback = 20 * 60_000;
  const budgetValue = Number.isFinite(configuredBudget) && configuredBudget > 0 ? configuredBudget : fallback;
  const timeoutValue = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : fallback;
  const budget = String(Math.max(fallback, budgetValue));
  const timeout = String(Math.max(fallback, timeoutValue));
  const script = fileURLToPath(new URL("./scripts/navigation-prepare.mjs", import.meta.url));
  const args = [script, "--path", cwd, "--auto", "--startup-budget-ms", budget, "--action-timeout-ms", timeout, "--trigger", options.trigger, "--json"];
  if (startupSafe) args.push("--startup-safe");
  if (fullStack) args.push("--full-stack");
  if (options.query) args.push("--query", options.query.length > 4000 ? `${options.query.slice(0, 4000)}…` : options.query);
  for (const backend of backends) args.push("--backend", backend);
  const errLog = join(cwd, ".pi", "navigation-prepare-err.log");
  mkdirSync(dirname(errLog), { recursive: true });
  let errFd: number | "ignore" = "ignore";
  try { errFd = openSync(errLog, "a"); } catch {}
  const childEnv = envWithNavigationProviders(loaded, process.env);
  const backgroundPolicy = process.platform === "darwin" && existsSync("/usr/sbin/taskpolicy") && existsSync("/usr/bin/nice");
  const launchCommand = backgroundPolicy ? "/usr/sbin/taskpolicy" : process.execPath;
  const launchArgs = backgroundPolicy ? ["-b", "/usr/bin/nice", "-n", "15", process.execPath, ...args] : args;
  const spawnOptions: SpawnOptions = {
    cwd,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "ignore", errFd],
  };
  let child;
  try { child = spawn(launchCommand, launchArgs, spawnOptions); }
  catch (error) {
    if (typeof errFd === "number") closeSync(errFd);
    releasePrepareLock(lock.lockPath, process.pid);
    throw error;
  }
  const record = { status: "started", summary: `background prepare started for ${cwd}`, root: cwd, auditLog, trigger: options.trigger, pid: child.pid, lockPath: lock.lockPath };
  writePrepareLockStarted(lock.lockPath, record);
  if (options.trigger === "stop_refresh") markStopRefreshStarted(cwd, record);
  recordPerfEvent({ kind: "lifecycle_launch", root: cwd, trigger: options.trigger, status: "started", command: launchCommand, args: launchArgs, pid: child.pid, timeoutMs: Number(timeout), childCount: 1, backgroundPolicy }, { root: cwd, env: childEnv });
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (typeof errFd === "number") { try { closeSync(errFd); } catch {} }
    releasePrepareLock(lock.lockPath, child.pid);
    if (options.queueIfRunning && consumePreparePending(cwd, options.trigger)) {
      startBackgroundPrepare(cwd, loaded, options);
    }
  };
  child.on("close", finalize);
  child.on("error", finalize);
  child.unref();
  return record;
}

function backgroundPrepareSummary(result: { status?: string; root: string; auditLog: string; trigger?: string; reason?: string }): string {
  if (result.status === "suppressed") return `Navigation lifecycle prepare: suppressed. ${result.reason ?? "no backend was requested"}`;
  if (result.status === "already_running") return `Navigation lifecycle prepare: not started because a prepare is already running for this folder. ${result.reason ?? ""} Audit log: ${result.auditLog}`;
  if (result.status === "throttled") return `Navigation lifecycle prepare: skipped because ${result.reason ?? "a recent refresh already ran"}. Audit log: ${result.auditLog}`;
  return `Navigation lifecycle prepare: started by ${result.trigger ?? "lifecycle"} and not awaited for this turn. It may create project-local navigation config/state or local index folders if policy allows. Query-time navigation remains non-mutating; complete live hash-certified rows from any capability are edit authority, and read supplies missing source authority. Audit log: ${result.auditLog}`;
}

function promptForbidsNavigationSetup(prompt: string): boolean {
  return /\b(read[- ]only|no writes?|without writing|don['’]?t write|do not write|don['’]?t mutate|do not mutate|no mutation|don['’]?t run setup|do not run setup|without setup|no setup|don['’]?t build (?:indexes?|indices)|do not build (?:indexes?|indices)|don['’]?t index|do not index|without indexing|no indexing|don['’]?t download|do not download|no downloads?|don['’]?t download models?|do not download models?|don['’]?t call providers?|do not call providers?|metered hotspot)\b/i.test(prompt);
}

function navigationSetupSuppressedByHost(event: any, ctx: any, env: Record<string, string | undefined> = process.env): boolean {
  if ([env.PI_NAV_NO_AUTO_SETUP, env.PI_NAV_READ_ONLY].some(value => /^(1|true|yes)$/i.test(String(value ?? "")))) return true;
  const values = [
    event?.readOnly, event?.readonly, event?.noSetup, event?.disableSetup, event?.disableNavigationSetup,
    event?.navigation?.readOnly, event?.navigation?.noSetup, event?.navigation?.disableSetup,
    ctx?.readOnly, ctx?.readonly, ctx?.noSetup, ctx?.disableSetup, ctx?.disableNavigationSetup,
    ctx?.navigation?.readOnly, ctx?.navigation?.noSetup, ctx?.navigation?.disableSetup,
  ];
  if (values.some(value => value === true || value === "true" || value === "1")) return true;
  return promptForbidsNavigationSetup(String(event?.prompt ?? ctx?.prompt ?? ""));
}

function setupSuppressedSummary(root: string): string {
  return `Navigation setup notice: no setup/indexing/writes started for this first prompt. Query-time navigation remains non-mutating; registered prepared capabilities remain directly callable and report active mode plus any request-specific diagnostic in their own result; complete live hash-certified rows are directly editable, and read supplies only missing source authority. Target: ${root}`;
}



export default function jeitoCodeweavePiExtension(pi: ExtensionAPI) {
  // jeito Ctrl+U density — one shortcut, one shared level, Pi's Ctrl+O untouched.
  // shell/websift/tooltap renderers read Symbol.for("pi.agent.jeitoDensity.v1") directly.
  // Single registration here; shell/websift/tooltap do NOT register another ctrl+u.
  try {
    (pi as any).registerShortcut?.("ctrl+u", {
      description: "Cycle jeito density ultra → normal → extended",
      handler: async () => {
        try {
          const { cycleDensity } = await import("./src/core/tui-render.ts");
          const d = cycleDensity();
          // appendEntry always triggers a TUI reflow — renderers re-derive from the shared global.
          (pi as any).appendEntry?.("jeito-density", { density: d });
        } catch {}
      },
    });
  } catch {}

  // Pi's runtime emits lifecycle/tool events that the currently published
  // ExtensionAPI declaration narrows to input-only. Keep that mismatch at one boundary.
  const markdownFrontmatterExposureState = createMarkdownFrontmatterExposureState();
  let grepRuntimeProblem: string | undefined;
  const on = pi.on.bind(pi) as (event: string, handler: (event: any, ctx: any) => any) => void;
  registerExploreTool(pi);
  registerTraceTool(pi);
  registerDocsSearchTool(pi, markdownFrontmatterExposureState);
  registerFindTool(pi);
  registerGrepTool(pi);
  registerLsTool(pi);
  registerReadTool(pi, markdownFrontmatterExposureState);
  registerEditTool(pi);
  registerWriteTool(pi);
  registerLspValidateTool(pi);
  registerDiffTool(pi);
  // Register the indexed owner first; its synchronous hooks reserve ownership
  // before the retained lifecycle handlers can launch background work.
  const indexedLifecycle = registerCandidateAnalysisLifecycle(pi);
  const setupSuppressed = (event: any, ctx: any): boolean => {
    if (indexedLifecycle.status().automaticSetupSuppressed || navigationSetupSuppressedByHost(event, ctx)) return true;
    try { return readCandidateMetadata(detectProjectRoot(ctx?.cwd ?? process.cwd()).root, ".pi-navigation.json")?.automation?.allowAutoPrepare === false; }
    catch { return true; }
  };
  if (typeof (pi as any).registerCommand === "function") (pi as any).registerCommand("navigation-setup", {
    description: "Show codeweave-pi runtime status plus repair and QMD model verification commands",
    handler: (_args: string, ctx: any) => {
      const identity = loadedRuntimeIdentity();
      if (identity.stale) {
        const message = staleLoadedRuntimeMessage(identity);
        notifyNavigation(ctx, message, "warning");
        return { status: "loaded-runtime-stale", identity, documentation: "docs/setup.md" };
      }
      const command = `cd ${JSON.stringify(EXTENSION_ROOT)} && npm run nav:provision`;
      const qmdVerification = `cd ${JSON.stringify(EXTENSION_ROOT)} && npm run qmd:model-provision -- --verify-only`;
      let assetsPresent = false;
      try {
        assertPackagedMaintenanceAvailable();
        const native = piNavArtifactPaths(EXTENSION_ROOT, resolvePiNavTarget());
        assetsPresent = Object.values(native).every(existsSync)
          && ["config.json", "tokenizer.json", "model.safetensors"].every(name => existsSync(join(analysisSemanticModelDirectory(), name)));
      } catch { /* Report absent Core assets; never install or select another writer. */ }
      const legacyCommand = `cd ${JSON.stringify(EXTENSION_ROOT)} && npm run nav:provision:legacy`;
      const message = `${assetsPresent ? "Core maintenance and code-semantic assets are present (not yet verified by this status check)." : "Required Core assets are missing; use a complete prepared codeweave-pi package."} Stop Pi and verify Core plus QMD with: ${command}. QMD-only verification: ${qmdVerification}. Graphify is optional${ownedRuntimeReady() ? " and already provisioned" : ""}: ${legacyCommand}. Existing stores are not migrated. See docs/setup.md.`;
      notifyNavigation(ctx, message, assetsPresent ? "info" : "warning");
      return { status: assetsPresent ? "assets-present" : "runtime-unavailable", command, legacyCommand, qmdVerification, documentation: "docs/setup.md" };
    },
  });
  const docsCadenceCounts = new Map<string, number>();

  on("session_start", async (event: any, ctx: any) => {
    const active = pi.getActiveTools();
    const next = [...active];
    for (const name of PUBLIC_TOOLS) {
      if (!next.includes(name)) next.push(name);
    }
    pi.setActiveTools(next);
    const identity = loadedRuntimeIdentity();
    const cwd = ctx?.cwd ?? process.cwd();
    const root = detectProjectRoot(cwd).root;
    if (identity.stale) {
      const message = staleLoadedRuntimeMessage(identity);
      notifyNavigation(ctx, message, "warning");
      return { status: "loaded-runtime-stale", root, identity, reason: message };
    }
    // Check the actual loaded addon even when project setup is disabled. This
    // reads metadata only, and must not install, scan or disable unrelated tools.
    try { await assertPiNavGrepAvailable(); grepRuntimeProblem = undefined; }
    catch (error) {
      grepRuntimeProblem = error instanceof Error ? error.message : String(error);
      notifyNavigation(ctx, grepRuntimeProblem, "warning");
    }
    if (setupSuppressed(event, ctx)) {
      const message = setupSuppressedSummary(root);
      notifyNavigation(ctx, message, "info");
      return { status: "suppressed", root, reason: "host/session requested read-only or no setup" };
    }
    const loaded = loadNavigationAutomationConfig();
    const setting = loaded.config.automation.autoPrepareOnSessionStart;
    // Automatic code preparation is Core-owned: no legacy runtime readiness
    // probe, no host configuration seeding and no retained-owner branch.
    if (loaded.loadFailed || loaded.config.automation.mode !== "aggressive" || setting !== true) return { status: "suppressed", root, reason: "automatic preparation permission unavailable" };
    const state = indexedLifecycle.status();
    const reason = state.reason ?? (state as any).error;
    notifyNavigation(ctx, `Indexed code preparation: ${reason ?? state.state}.`, reason ? "warning" : "info");
    const local = readCandidateMetadata(root, ".pi-navigation.json");
    const docs = loaded.config.backends.docs;
    if (docs === false || docs?.enabled === false || docs?.autoPrepare === false
      || local?.docs === false || local?.docs?.enabled === false || local?.docs?.autoPrepare === false) {
      return { status: state.state, root, reason, docs: "disabled" };
    }
    const admitted = await resolvePreparationRoot(root);
    if (!admitted.allowed || admitted.root !== root) return { status: "suppressed", root, reason: admitted.reason };
    if (sessionStartPrepared.has(root)) return undefined;
    sessionStartPrepared.add(root);
    try {
      // Docs preparation runs detached and is bounded by the configured
      // 20-minute stale-process ceiling, not a short UI budget. Code preparation
      // belongs to the indexed lifecycle above, never to this CLI.
      const result = startBackgroundPrepare(root, loaded, { trigger: "session_start", startupSafe: true, fullStack: false, backends: ["qmd"] });
      const notice = setupNotification(result);
      notifyNavigation(ctx, notice.message, notice.type);
      return result;
    } catch (error) {
      const errorMessage = `navigation session-start prepare failed: ${error instanceof Error ? error.message : String(error)}`;
      notifyNavigation(ctx, errorMessage, "warning");
      return { status: "warning", error: errorMessage };
    }
  });



  on("tool_result", async (_event: any, ctx: any) => {
    recordToolCall(String(_event?.toolName ?? ""));
    const root = detectProjectRoot(ctx?.cwd ?? process.cwd()).root;
    const maintenanceAllowed = autoSetupAllowed(root) && !setupSuppressed(_event, ctx);
    if (maintenanceAllowed) {
      const loaded = loadNavigationAutomationConfig();
      if (loaded.config.automation.mode !== "disabled") {
        const dirtyBackends = dirtyPreparedBackends(root);
        if (dirtyBackends.length > 0) {
          try {
            startBackgroundPrepare(root, loaded, { trigger: "stop_refresh", startupSafe: false, fullStack: false, queueIfRunning: false, backends: dirtyBackends });
          } catch {}
        }
      }
    }

    // Nudge: owned by codeweave-pi so policy travels with navigation harness.
    // - `cat`/`head`/`tail`/`nl`/`bat` at root, and a non-mutating `sed`, on project text → hint to use `read`
    // - `cat >` / `cat >>` at root, and `sed -i`/`--in-place`, → hint to use `write`/`edit`
    // Detection respects command boundaries (`;`, `&&`, `||`, `&`, newline) and
    // ignores `cat`/`sed` after a pipe (`|`) — e.g., `echo hi | cat` is ignored,
    // but `echo hi; cat file` triggers as a new root command.
    let catResult: any | undefined;
    if (_event?.toolName === "bash") {
      const input: any = _event?.input ?? {};
      const actions: string[] = Array.isArray(input.action) ? input.action : [];
      const isIntrospectionOnly =
        actions.includes("list") ||
        (actions.includes("show") && !actions.includes("run")) ||
        (actions.includes("clone") && !actions.includes("run"));
      if (!isIntrospectionOnly) {
        const cmd = typeof input.command === "string" ? input.command : "";
        if (cmd) {
          const content: any[] = Array.isArray(_event?.content) ? _event.content : [];
          const sed = sedUsage(cmd);
          const hasRead = readsSourceAtRoot(cmd) || sed.read;
          const hasWrite = hasCatWriteAtRoot(cmd) || sed.write;
          const hints: string[] = [];
          if (hasRead && !content.some((c: any) => typeof c?.text === "string" && c.text.includes(READ_NUDGE_SENTINEL))) {
            hints.push(`[jeito hint] ${READ_NUDGE}`);
          }
          if (hasWrite && !content.some((c: any) => typeof c?.text === "string" && c.text.includes("Prefer `write`/`edit` over `bash cat >`"))) {
            hints.push(`[jeito hint] ${WRITE_NUDGE}`);
          }
          if (hints.length) {
            const hintText = hints.join("\n\n");
            catResult = { content: [...content, { type: "text", text: `\n\n${hintText}` }] };
          }
        }
      }
    }


    const count = (docsCadenceCounts.get(root) ?? 0) + 1;
    docsCadenceCounts.set(root, count);
    let navigationResult: any | undefined;
    if (count % 10 === 0 && maintenanceAllowed) {
      const loaded = loadNavigationAutomationConfig();
      if (loaded.config.automation.mode !== "disabled") {
        try {
          navigationResult = startBackgroundPrepare(root, loaded, {
            trigger: "first_broad_request",
            fullStack: false,
            queueIfRunning: true,
            backends: ["qmd", "graphify"],
          });
        } catch {
          navigationResult = undefined;
        }
      }
    }

    if (catResult && navigationResult) return { ...navigationResult, ...catResult };
    if (catResult) return catResult;
    return navigationResult;
  });

  on("before_agent_start", async (event: any, ctx: any) => {
    const rawSelected = event.systemPromptOptions?.selectedTools ?? pi.getActiveTools();
    const selected = new Set((Array.isArray(rawSelected) ? rawSelected : []).map((tool: any) => typeof tool === "string" ? tool : tool?.name).filter(Boolean));
    if (!PUBLIC_TOOLS.some(name => selected.has(name))) return undefined;
    const identity = loadedRuntimeIdentity();
    if (identity.stale) return { systemPrompt: `${event.systemPrompt}\n\n${staleLoadedRuntimeMessage(identity)}` };
    const systemPrompt = event.systemPrompt;
    let extra = "";
    const prompt = String(event.prompt ?? "");
    const cwd = ctx?.cwd ?? process.cwd();
    const root = detectProjectRoot(cwd).root;
    const loaded = loadNavigationAutomationConfig();
    if (root && isBroadNavigationPrompt(prompt)) {
      const autoAllowed = autoSetupAllowed(root);
      if (setupSuppressed(event, ctx) || promptForbidsNavigationSetup(prompt) || !loaded.config.automation.autoPrepareOnFirstBroadRequest || loaded.config.automation.mode === "disabled" || !autoAllowed) {
        extra = `\n\n${setupSuppressedSummary(root)}${!autoAllowed ? ` Note: this folder is not under git control and has no .pi-navigation.json; auto-setup is off for non-git folders. Run /navigation-setup to configure it explicitly.` : ""}`;
      } else {
        const readiness = await compactNavigationLaneStatus(root).catch((error: any) => `Nav readiness unavailable: ${error?.message ?? error}`);
        const key = `${root}\0${normalizedPrompt(prompt).slice(0, 240)}`;
        let prepareSummary = "First-broad-request prepare was already attempted for this prompt/folder.";
        if (!broadAutoPrepared.has(key)) {
          const prepared = startBackgroundPrepare(root, loaded, { trigger: "first_broad_request", query: prompt, backends: ["qmd", "graphify"] });
          broadAutoPrepared.add(key);
          prepareSummary = backgroundPrepareSummary(prepared);
        }
        extra = `\n\nNavigation first-prompt readiness before local prepare: ${readiness}. ${prepareSummary}`;
      }
    }

    if (selected.has("grep") && grepRuntimeProblem) extra += `\n\n${grepRuntimeProblem}`;
    if (systemPrompt === event.systemPrompt && !extra) return undefined;
    return { systemPrompt: `${systemPrompt}${extra}` };
  });

  function startStopRefresh(eventName: "agent_end" | "session_shutdown", ctx: any) {
    const loaded = loadNavigationAutomationConfig();
    const refresh = loaded.config.automation.autoRefreshOnStop;
    if (!refresh || refresh === "off" || loaded.config.automation.mode === "disabled") return undefined;
    const cwd = ctx?.cwd ?? process.cwd();
    const root = detectProjectRoot(cwd).root;
    try {
      if (!activeStopRefreshLock(root)) {
        const recent = recentStopRefresh(root);
        if (recent) return { ...recent, event: eventName, summary: backgroundPrepareSummary(recent) };
      }
      const result = startBackgroundPrepare(root, loaded, { trigger: "stop_refresh", startupSafe: false, fullStack: false, queueIfRunning: eventName === "agent_end", backends: ["graphify"] });
      return { ...result, event: eventName, summary: backgroundPrepareSummary(result) };
    } catch (error: any) {
      return { status: "warning", event: eventName, error: `navigation stop-refresh failed: ${error?.message ?? error}` };
    }
  }


  on("session_shutdown", async (event: any, ctx: any) => {
    await shutdownQmdDocsRefreshes();
    await shutdownStructuralBlockResolver();
    await shutdownLspValidation();
    if (setupSuppressed(event, ctx)) {
      return { status: "suppressed", root: detectProjectRoot(ctx?.cwd ?? process.cwd()).root, reason: "host/session requested read-only or no setup" };
    }
    return startStopRefresh("session_shutdown", ctx);
  });
  return indexedLifecycle;
}

/** Shared indexed lifecycle, registered before the retained lifecycle handlers
 * by the ordinary extension. It claims eligible roots and owns code maintenance;
 * retired stores or bindings are not an exception. The exported entry also
 * supports isolated source-build proofs; injections are test seams, never
 * repository configuration. */
export function registerCandidateAnalysisLifecycle(
  pi: ExtensionAPI,
  options: {
    maintain?: typeof import("./src/core/native-maintenance.ts").runAdmittedMaintenance;
    callNative?: import("./src/core/pi-nav-native.ts").PiNavCaller;
  } = {},
) {
  let project: { root: string; directory: string } | undefined;
  let lifecycle: ReturnType<typeof createAnalysisLifecycle> | undefined;
  let permitted = false;
  let forbiddenBySession = false;
  let closed = false;
  let revision = 0;
  let admissionCheck = new AbortController();
  let currentEvent: any;
  let currentContext: any;
  let reason: string | undefined;
  let disposition: "inactive" | "indexed" | "refused" = "inactive";
  const on = pi.on.bind(pi) as (event: string, handler: (event: any, ctx: any) => any) => void;

  function permission(requireOwner = true) {
    const identity = loadedRuntimeIdentity();
    if (identity.stale) throw new Error(staleLoadedRuntimeMessage(identity));
    if (closed || forbiddenBySession || navigationSetupSuppressedByHost(currentEvent, currentContext)) throw new Error("Host or prompt forbids automatic preparation");
    const root = detectProjectRoot(currentContext?.cwd ?? process.cwd()).root;
    const loaded = loadNavigationAutomationConfig();
    const config = loaded.config;
    if (loaded.loadFailed) throw new Error("Indexed preparation requires a readable machine automation configuration");
    if (config.automation.mode !== "aggressive" || config.automation.autoPrepareOnSessionStart !== true) {
      throw new Error("Indexed candidate requires aggressive automatic startup permission; guided/detect-only are not consent");
    }
    const local = readCandidateMetadata(root, ".pi-navigation.json") ?? {};
    if (local.automation?.allowAutoPrepare === false || local.architecture === false
        || local.architecture?.enabled === false || local.architecture?.autoPrepare === false
        || config.backends.architecture === false || config.backends.architecture?.enabled === false
        || config.backends.architecture?.autoPrepare === false || config.backends.crg?.enabled === false) {
      throw new Error("Project or backend policy disables automatic code preparation");
    }
    // The existing census is root-wide with exclusions. Do not silently widen
    // an explicit narrower setup scope that it cannot represent.
    if (local.architecture?.root && local.architecture.root !== "."
        || local.scope?.include !== undefined && (!Array.isArray(local.scope.include)
          || local.scope.include.length !== 1 || local.scope.include[0] !== ".")) {
      throw new Error("Indexed candidate cannot widen an explicit narrower setup scope");
    }
    const selected = deriveAnalysisProject(root, config.storage.indexRoot);
    if (project && (project.root !== selected.root || project.directory !== selected.directory)) throw new Error("Candidate root or machine storage selection changed");
    if (requireOwner && codeMaintenanceOwner(root) !== "indexed") throw new Error("Indexed candidate does not own code maintenance");
    return { root, config, local, selected };
  }

  function automaticPreparationAllowed() {
    if (!permitted || closed) return false;
    // Watch hints can arrive without a Pi checkpoint after external revocation.
    try { permission(); return true; }
    catch (error) {
      permitted = false;
      reason = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async function prepare(request: { onCorpus?: (directories: readonly string[]) => void }, signal: AbortSignal) {
    const initial = permission();
    signal.throwIfAborted();
    const admitted = await resolvePreparationRoot(initial.root, { signal });
    if (!admitted.allowed || admitted.root !== initial.root) throw new Error(admitted.reason);
    const preflight = await preflightNavigationTarget(initial.root);
    signal.throwIfAborted();
    let policy = permission();
    const checkScope = () => {
      const scope = planNavigationScope(preflight, { config: policy.config, projectScope: policy.local.scope });
      if (preflight.root !== policy.root || scope.mode !== "auto") throw new Error(`Automatic code scope unavailable: ${scope.reason}`);
    };
    checkScope();
    const timeoutMs = Math.min(1_200_000, policy.config.automation.startupAutoPrepareActionTimeoutMs);
    const corpus = await enumerateNavigationCorpus(initial.root, "code", options.callNative ?? callPiNav,
      { signal, timeoutMs, maxEntries: Math.min(100_000, policy.config.scoping.maxAutoFiles) });
    policy = permission();
    checkScope();
    signal.throwIfAborted();
    // Subscribe before maintenance so edits during capture queue another pass.
    // Reuse shallow admitted-directory watches, never a second donor watcher.
    request.onCorpus?.(corpus.directories);
    // Refuse building, failed or foreign state before allocation or child launch.
    // child still owns the lock and independently rechecks status and identity.
    let previous;
    if (existsSync(policy.selected.directory)) {
      const store = analysisProjectPaths(policy.selected, false);
      const status = readMaintenanceStatus(store);
      if (status) {
        if (status.state !== "ready") throw new Error("Building or interrupted/failed maintenance is unavailable; no automatic recovery");
        previous = { root: store.root, directory: store.directory, database: store.database, dev: status.databaseDev, ino: status.databaseIno };
      } else { assertEmptyAnalysisProject(store); }
    }
    if (!options.maintain) assertPackagedMaintenanceAvailable();
    ensureAnalysisProjectParent(policy.selected);
    signal.throwIfAborted();
    return (options.maintain ?? runAdmittedMaintenance)({ ...policy.selected, previous, timeoutMs,
      admission: { root: corpus.root, files: corpus.files, policyFiles: corpus.policyFiles, policyDigest: corpus.digest } }, signal);
  }

  async function checkpoint(event: any, ctx: any, changed = false) {
    const requested = ++revision;
    admissionCheck.abort(); admissionCheck = new AbortController();
    currentEvent = event; currentContext = ctx;
    disposition = project ? "indexed" : "refused";
    if (navigationSetupSuppressedByHost(event, ctx)) forbiddenBySession = true;
    permitted = false;
    try {
      if (closed) return;
      const root = detectProjectRoot(ctx?.cwd ?? process.cwd()).root;
      if (codeMaintenanceOwner(root) === "indexed") disposition = "indexed";
      if (project && project.root !== root) throw new Error("Candidate root changed; stop the prior lifecycle before selecting another project");
      // Consent and installed assets precede initial ownership changes. Reserve
      // synchronously before asynchronous admission, and keep the reservation
      // after later revocation so revoked prepared work cannot resume.
      const policy = permission(false);
      if (!options.maintain) assertPackagedMaintenanceAvailable();
      if (codeMaintenanceOwner(root) !== "indexed") {
        if (activePrepareAcrossTriggers(root)) throw new Error("Background preparation is already running; candidate selection refused");
      }
      selectCandidateCodeOwner(root);
      disposition = "indexed";
      const admitted = await resolvePreparationRoot(root, { signal: admissionCheck.signal });
      if (requested !== revision || closed) return;
      if (!admitted.allowed || admitted.root !== root) throw new Error(admitted.reason);
      permission();
      project ??= policy.selected;
      lifecycle ??= createAnalysisLifecycle(project, automaticPreparationAllowed, prepare);
      permitted = true; reason = undefined;
      if (changed) lifecycle.invalidate();
      void lifecycle.start();
    } catch (error) {
      if (requested === revision) reason = error instanceof Error ? error.message : String(error);
    } finally {
      if (requested === revision && !permitted) await lifecycle?.stop();
    }
  }

  async function stop() {
    closed = true; permitted = false; revision++;
    admissionCheck.abort();
    await lifecycle?.stop();
  }
  on("session_start", (event, ctx) => checkpoint(event, ctx));
  on("input", (event, ctx) => checkpoint({ ...event, prompt: event?.text ?? event?.prompt }, ctx));
  on("before_agent_start", (event, ctx) => checkpoint(event, ctx, true));
  on("tool_result", (event, ctx) => checkpoint(event, ctx, ["edit", "write", "bash"].includes(String(event?.toolName))));
  on("session_shutdown", stop);
  return { stop, status: () => ({ ...(lifecycle?.status() ?? { state: "inactive", watching: 0 }), project, reason, disposition, automaticSetupSuppressed: forbiddenBySession }) };
}
