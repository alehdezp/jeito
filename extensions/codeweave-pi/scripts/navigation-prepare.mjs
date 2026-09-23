#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inspectNavigation } from "./navigation-doctor.mjs";
import { envWithNavigationProviders, FULL_STACK_NAVIGATION_AUTOMATION_CONFIG, loadNavigationAutomationConfig, mergeAutomationConfig } from "../src/core/navigation-automation-config.ts";
import { preflightNavigationTarget } from "../src/core/navigation-preflight.ts";
import { planNavigationSetup } from "../src/core/navigation-setup-planner.ts";
import { canonicalProjectPath } from "../src/core/project-root.ts";
import { byteLength, recordPerfEvent } from "../src/core/perf-telemetry.ts";
import { redactJson } from "../src/core/redaction.ts";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALID_BACKENDS = new Set(["qmd", "graphify"]);

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { path: process.cwd(), query: undefined, trigger: undefined, dryRun: false, auto: false, guided: false, fullStack: false, startupSafe: false, startupBudgetMs: undefined, actionTimeoutMs: undefined, docsMaxFiles: undefined, json: false, config: undefined, backends: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--path" || flag === "-C") args.path = value();
    else if (flag === "--query") args.query = value();
    else if (flag === "--config") args.config = value();
    else if (flag === "--trigger") args.trigger = value();
    else if (flag === "--backend") {
      const backend = value();
      if (!VALID_BACKENDS.has(backend)) throw new Error(`unknown backend: ${backend}`);
      args.backends.push(backend);
    } else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--auto") args.auto = true;
    else if (flag === "--guided") args.guided = true;
    else if (flag === "--full-stack") args.fullStack = true;
    else if (flag === "--startup-safe") args.startupSafe = true;
    else if (flag === "--startup-budget-ms") args.startupBudgetMs = Number(value());
    else if (flag === "--action-timeout-ms") args.actionTimeoutMs = Number(value());
    else if (flag === "--docs-max-files") args.docsMaxFiles = value();
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.auto && !args.guided && !args.dryRun) args.dryRun = true;
  return args;
}

export async function prepareNavigation(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  if (args.help) return { help: true, text: helpText() };
  const target = path.resolve(args.path);
  const loadedConfig = loadNavigationAutomationConfig({ path: args.config, env: options.env ?? process.env });
  const providerEnvBase = envWithNavigationProviders(loadedConfig, options.env ?? process.env);
  const config = args.fullStack ? mergeAutomationConfig(loadedConfig.config, FULL_STACK_NAVIGATION_AUTOMATION_CONFIG) : loadedConfig.config;
  const preflight = await preflightNavigationTarget(target);
  const projectConfig = readProjectConfig(preflight.config.path);
  const trigger = options.trigger ?? args.trigger ?? "manual_prepare";
  const providerEnv = loadedConfig.path ? { ...providerEnvBase, PI_NAV_AUTOMATION_CONFIG: loadedConfig.path } : providerEnvBase;
  const projectScope = projectConfig?.scope && typeof projectConfig.scope === "object" ? { include: asStringArray(projectConfig.scope.include), exclude: asStringArray(projectConfig.scope.exclude) } : undefined;
  const allowAutoPrepare = projectConfig?.automation?.allowAutoPrepare === false ? false : undefined;
  const disabledBackends = disabledBackendsFromProjectConfig(projectConfig);
  const docsMaxFiles = normalizeDocsFileLimit(args.docsMaxFiles ?? projectConfig?.docs?.maxFiles);
  const doctor = inspectNavigation(target, { env: providerEnv });
  const installedBackends = installedBackendsFromDoctor(doctor);
  const startupSafe = args.startupSafe || (trigger === "session_start" && config.automation.autoPrepareOnSessionStart === "quick-local");
  const requestedBackends = args.backends.length ? args.backends : trigger === "stop_refresh" ? ["graphify"] : undefined;
  const plan = planNavigationSetup(preflight, config, {
    query: args.query,
    trigger,
    fullStack: args.fullStack,
    startupSafe,
    env: providerEnv,
    requestedBackends,
    installedBackends,
    projectScope,
    allowAutoPrepare,
    disabledBackends,
    docsMaxFiles,
  });
  const mode = args.dryRun ? "dry-run" : args.auto ? "auto" : "guided";
  const result = {
    status: plan.policy === "blocked" ? "blocked" : "planned",
    mode,
    dryRun: args.dryRun,
    root: preflight.root,
    config: { path: loadedConfig.path, exists: loadedConfig.exists, diagnostics: loadedConfig.diagnostics, projectPath: preflight.config.path, projectScope, allowAutoPrepare },
    preflight: preflightSummary(preflight),
    plan,
    execution: undefined,
    executionSummary: undefined,
  };

  if (args.auto && !args.dryRun) {
    result.execution = executeAutoActions(plan, { env: providerEnv, doctor, startupSafe, startupBudgetMs: args.startupBudgetMs, actionTimeoutMs: args.actionTimeoutMs });
    result.executionSummary = summarizeExecution(result.execution);
    result.status = result.execution.some(item => item.status === "failed") ? "warning" : "success";
  }
  return result;
}

function summarizeExecution(records) {
  const summary = { readyNow: [], needsAttention: [], guidedByPolicy: [] };
  for (const record of records ?? []) {
    const label = `${record.backend}:${record.mode}`;
    const reason = record.verification?.reason || record.reason || record.status;
    if (record.enabledLane && ["completed", "already_ready", "ready_no_prepare"].includes(record.status)) {
      summary.readyNow.push(`${label} (${record.status})`);
    } else if (record.status === "failed" || record.policy === "blocked") {
      summary.needsAttention.push(`${label} (${reason})`);
    } else {
      summary.guidedByPolicy.push(`${label} (${reason})`);
    }
  }
  return summary;
}

function executeAutoActions(plan, options = {}) {
  const logPath = path.join(plan.root, ".pi", "navigation-setup.log.jsonl");
  mkdirSync(path.dirname(logPath), { recursive: true });
  const redactionEnv = { ...process.env, ...(options.env ?? {}) };
  const budgetMs = options.startupBudgetMs === undefined ? 20 * 60_000 : positiveNumber(options.startupBudgetMs, 0);
  const actionTimeoutMs = options.actionTimeoutMs === undefined ? 20 * 60_000 : positiveNumber(options.actionTimeoutMs, 20 * 60_000);
  const budgetStarted = Date.now();
  const records = [];
  for (const action of orderedActionsForExecution(plan.actions, plan, options)) {
    const started = Date.now();
    const base = {
      time: new Date(started).toISOString(),
      target: plan.root,
      trigger: plan.trigger,
      backend: action.backend,
      lane: action.lane,
      mode: action.modeName,
      policy: action.policy,
      reason: action.reason,
      command: action.command,
      writes: action.writes,
      providers: action.providers ?? [],
      qualityGates: action.qualityGates,
      undo: action.undo,
    };
    let record;
    let plannedTimeoutMs;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    if (actionAlreadyReady(action, options.doctor, plan) && shouldSkipAlreadyReadyAction(plan.trigger, action)) {
      record = { ...base, status: "already_ready", runtimeMs: 0, enabledLane: true, verification: { passed: true, reason: `${action.lane} ${action.modeName} already ready; skipped rebuild/freshen` } };
    } else if (action.policy !== "auto") {
      record = { ...base, status: "skipped", runtimeMs: 0, enabledLane: false, verification: { passed: false, reason: "action was not automatic" } };
    } else if (options.startupSafe && !isStartupSafeAction(action, plan)) {
      record = { ...base, status: "skipped", runtimeMs: 0, enabledLane: false, verification: { passed: false, reason: "not startup-safe: requires first-broad-request or guided/manual prepare" } };
    } else if (budgetMs > 0 && Date.now() - budgetStarted >= budgetMs) {
      const label = options.startupSafe ? "startup" : "background";
      record = { ...base, status: "skipped", runtimeMs: 0, enabledLane: false, verification: { passed: false, reason: `${label} budget exhausted (${budgetMs}ms)` } };
    } else if (!action.command?.length) {
      record = { ...base, status: "skipped", runtimeMs: 0, enabledLane: false, verification: { passed: false, reason: "no command planned" } };
    } else {
      plannedTimeoutMs = actionTimeoutFor(action, options, budgetMs, actionTimeoutMs, budgetStarted);
      const command = commandWithInnerTimeout(action.command, plannedTimeoutMs);
      const run = spawnSync(command[0], command.slice(1), {
        cwd: commandCwd(command, plan.root),
        env: redactionEnv,
        encoding: "utf8",
        timeout: plannedTimeoutMs,
        maxBuffer: 20 * 1024 * 1024,
      });
      stdoutBytes = byteLength(run.stdout);
      stderrBytes = byteLength(run.stderr || run.error?.message);
      const commandOk = !run.error && run.status === 0;
      const failure = commandOk ? undefined : actionFailureDetails(run, plannedTimeoutMs);
      const laneReady = commandOk ? verifyLaneReady(plan.root, action.lane, redactionEnv) : { ready: false, reason: failure?.reason ?? "command failed or did not start" };
      record = {
        ...base,
        status: commandOk && laneReady.ready ? "completed" : "failed",
        runtimeMs: Date.now() - started,
        exitCode: run.status,
        signal: run.signal,
        timedOut: failure?.timedOut ?? false,
        failureKind: failure?.kind,
        timeoutMs: plannedTimeoutMs,
        stdout: trim(run.stdout),
        stderr: trim(run.stderr || run.error?.message),
        enabledLane: commandOk && laneReady.ready,
        verification: { passed: commandOk && laneReady.ready, reason: commandOk ? laneReady.reason : failure?.reason ?? "command failed or did not start" },
      };
    }
    const safeRecord = redactJson(record, { env: redactionEnv });
    appendFileSync(logPath, `${JSON.stringify(safeRecord)}\n`);
    records.push({ ...safeRecord, auditLog: logPath });
    recordPerfEvent({
      kind: "lifecycle_action",
      root: plan.root,
      trigger: plan.trigger,
      backend: action.backend,
      lane: action.lane,
      mode: action.modeName,
      status: record.status,
      command: Array.isArray(action.command) ? action.command[0] : undefined,
      args: Array.isArray(action.command) ? action.command.slice(1) : undefined,
      durationMs: record.runtimeMs,
      timeoutMs: plannedTimeoutMs,
      stdoutBytes,
      stderrBytes,
      exitCode: record.exitCode,
      error: record.verification?.reason,
      childCount: plannedTimeoutMs === undefined ? 0 : 1,
    }, { root: plan.root, env: redactionEnv });
  }
  return records;
}

function actionFailureDetails(run, timeoutMs) {
  const output = [run?.stdout, run?.stderr, run?.error?.message].filter(Boolean).join("\n");
  const timedOut = run?.error?.code === "ETIMEDOUT" || /timed out|timeout/i.test(output);
  if (timedOut) return { kind: "timeout", timedOut: true, reason: `command timed out after ${timeoutMs}ms${/qmd/i.test(output) ? "; QMD did not complete indexing before the deadline" : ""}` };
  if (run?.error) return { kind: "start_error", timedOut: false, reason: `command failed to start: ${String(run.error.message ?? run.error).split(/\r?\n/, 1)[0]}` };
  return { kind: "exit", timedOut: false, reason: `command exited with status ${run?.status ?? "unknown"} before the lane became ready` };
}

export function shouldSkipAlreadyReadyAction(trigger, action) {
  // A lifecycle checkpoint must not force a rebuild merely to reconfirm a lane that
  // already reports ready. Stop-refresh deliberately re-verifies prepared lanes, and
  // QMD lifecycle work is bounded local indexing a startup or opening checkpoint is
  // expected to run, so neither is skipped here.
  if (trigger === "stop_refresh") return false;
  if ((trigger === "session_start" || trigger === "first_broad_request") && action.backend === "qmd") return false;
  return true;
}

function actionAlreadyReady(action, doctor, plan) {
  if (plan?.root && doctor?.root && canonicalProjectPath(doctor.root) !== canonicalProjectPath(plan.root)) return false;
  const lane = doctor?.lanes?.find(item => item?.name === action.lane);
  if (lane?.status !== "ready") return false;
  if (action.backend === "qmd" && action.modeName === "hybridDocs") return lane.qmd?.status === "ready" && Number(lane.qmd?.health?.needsEmbedding ?? 0) === 0;
  if (action.backend === "graphify" && action.modeName === "deepExtract") {
    return /deep/i.test(String(lane.mode ?? "")) && lane.semanticExtractionObserved !== false;
  }
  return true;
}

function orderedActionsForExecution(actions, plan, options = {}) {
  if (plan.trigger !== "first_broad_request" || options.startupSafe) return actions;
  const priority = action => {
    if (action.policy !== "auto") return 80;
    if (action.backend === "qmd") return 10;
    if (action.backend === "graphify") return 50;
    return 60;
  };
  return [...actions].sort((left, right) => priority(left) - priority(right));
}
function verifyLaneReady(root, laneName, env) {
  const doctor = inspectNavigation(root, { env });
  const doctorLaneName = laneName;
  const lane = doctor.lanes?.find(item => item?.name === doctorLaneName);
  if (lane?.status === "ready") return { ready: true, reason: `${doctorLaneName} lane ready after prepare` };
  return { ready: false, reason: lane ? `${doctorLaneName} lane not ready after prepare: ${(lane.problems ?? []).join("; ") || lane.status}` : `${doctorLaneName} lane not found after prepare` };
}


function readyLaneNames(doctor) {
  const names = new Set();
  for (const lane of doctor?.lanes ?? []) {
    if (lane?.status === "ready" && typeof lane.name === "string") names.add(lane.name);
  }
  return names;
}

function commandCwd(command, root) {
  if (command[0] === "node" && command[1]?.startsWith("scripts/")) return EXTENSION_ROOT;
  return root;
}

function installedBackendsFromDoctor(doctor) {
  const tools = doctor.tools ?? {};
  return {
    qmd: Boolean(tools.pi_nav?.available),
    graphify: Boolean(tools.graphify?.available),
  };
}

function preflightSummary(preflight) {
  return {
    root: preflight.root,
    rootConfidence: preflight.rootConfidence,
    projectShape: preflight.projectShape,
    sourceFiles: preflight.source.files,
    docsFiles: preflight.docs.files,
    risks: preflight.risks,
    recommendedScopes: preflight.recommendedScopes,
  };
}

function readProjectConfig(configPath) {
  if (!configPath || !existsSync(configPath)) return undefined;
  try { return JSON.parse(readFileSync(configPath, "utf8")); } catch { return undefined; }
}

function disabledBackendsFromProjectConfig(config) {
  const pairs = [
    ["qmd", "docs"],
    ["graphify", "graph"],
  ];
  return pairs.filter(([, lane]) => config?.[lane]?.autoPrepare === false).map(([backend]) => backend);
}
function actionTimeoutFor(action, options, budgetMs, actionTimeoutMs, budgetStarted) {
  const remaining = budgetMs > 0 ? Math.max(1000, Math.min(actionTimeoutMs, budgetMs - (Date.now() - budgetStarted))) : Math.max(1000, actionTimeoutMs);
  const explicit = action.backend === "qmd" ? options.qmdStartupTimeoutMs : undefined;
  return explicit === undefined ? remaining : Math.max(1000, Math.min(remaining, Number(explicit)));
}
function commandWithInnerTimeout(command, timeoutMs) {
  if (command[0] !== "node" || command[1] !== "scripts/navigation-freshen.mjs" || command.includes("--timeout-ms")) return command;
  return [...command, "--timeout-ms", String(Math.max(100, timeoutMs - 250))];
}




// REGRESSION GUARD — startup-safe means UI-safe/background, not local-only.
// QMD changed-section embeddings may run when provider policy/credentials allow;
// Graphify provider-backed extraction remains outside startup-safe preparation.
function isStartupSafeAction(action, plan) {
  if (action.backend === "qmd" && ["lexicalDocs", "hybridDocs"].includes(action.modeName) && action.policy === "auto" && isDocsStartupScope(action.scope, plan.root)) return true;
  if (plan.scopePlan?.mode !== "auto" || plan.scopePlan?.confidence !== "high") return false;
  if (action.backend === "graphify" && action.modeName === "update" && isConcreteNarrowScope(action.scope, plan.root)) return true;
  return false;
}

function isDocsStartupScope(scope, root) {
  return scope === "." || scope === root || isConcreteNarrowScope(scope, root);
}

function isConcreteNarrowScope(scope, root) {
  if (typeof scope !== "string" || !scope.trim()) return false;
  if (scope === "." || scope === root || scope.includes(",")) return false;
  return true;
}

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : undefined;
}
function normalizeDocsFileLimit(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (String(value).trim().toLowerCase() === "all") return "all";
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`docs max files must be a positive integer or all; got ${JSON.stringify(value)}`);
  return number;
}


function trim(value, limit = 8000) {
  const text = String(value ?? "").trim();
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]` : text;
}

function helpText() {
  return `Usage: node scripts/navigation-prepare.mjs [--path DIR] [--dry-run|--auto|--guided] [--startup-safe] [--startup-budget-ms N] [--action-timeout-ms N] [--docs-max-files N|all] [--full-stack] [--backend qmd|graphify] [--query TEXT] [--json]\n\nPlans controlled automatic setup for the two prepared backends only. Bundled pi-nav live queries require no prepare action, and code navigation comes from Core maintenance rather than this script. --dry-run is the default and never writes. --auto executes only actions classified automatic and writes .pi/navigation-setup.log.jsonl. Prepared builds are bounded to 20 minutes by default. Automatic QMD discovery defaults to 300 ranked, non-ignored files; --docs-max-files or docs.maxFiles may set a positive limit or all.`;
}

export function renderText(result) {
  if (result.help) return result.text;
  const lines = [];
  lines.push(`Navigation prepare ${result.mode}: ${result.status}`);
  lines.push(`Root: ${result.root}`);
  lines.push(`Scope: ${result.plan.scopePlan.mode} (${result.plan.scopePlan.reason})`);
  if (result.plan.actions.length) {
    for (const action of result.plan.actions) lines.push(`- ${action.backend}:${action.modeName} ${action.policy} — ${action.reason}`);
  } else {
    lines.push("- No setup actions were planned for this request.");
  }
  if (result.plan.nextMessages?.length) lines.push("", "Plan summary:", ...result.plan.nextMessages.map(message => `- ${message}`));
  if (result.executionSummary) {
    lines.push(
      "",
      "Setup summary:",
      `Ready now: ${formatSummaryItems(result.executionSummary.readyNow)}`,
      `Needs attention: ${formatSummaryItems(result.executionSummary.needsAttention)}`,
      `Guided by policy: ${formatSummaryItems(result.executionSummary.guidedByPolicy)}`,
    );
  }
  if (result.execution?.length) {
    lines.push("", "Execution outcomes:");
    for (const record of result.execution) {
      const reason = record.verification?.reason || record.reason || record.status;
      const timing = record.timeoutMs ? `; timeout=${record.timeoutMs}ms` : "";
      lines.push(`- ${record.backend}:${record.mode} ${record.status} — ${reason}${timing}`);
    }
  }
  if (result.plan.confirmationPrompt && !result.execution) lines.push("", result.plan.confirmationPrompt);
  if (result.execution) lines.push(`Audit log: ${result.execution[0]?.auditLog ?? path.join(result.root, ".pi", "navigation-setup.log.jsonl")}`);
  return lines.join("\n");
}

function formatSummaryItems(items) {
  return items?.length ? items.join(", ") : "none";
}

if (process.argv[1] && import.meta.url === pathToFileURL(canonicalProjectPath(process.argv[1])).href) {
  prepareNavigation().then(result => {
    if (result.help) {
      console.log(result.text);
      return;
    }
    if (parseArgs(process.argv.slice(2)).json) console.log(JSON.stringify(result, null, 2));
    else console.log(renderText(result));
    if (result.status === "blocked") process.exitCode = 2;
  }).catch(error => {
    console.error(`ERROR: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
