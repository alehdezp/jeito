#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piNavArtifactPaths, resolvePiNavTarget } from "../src/core/pi-nav-native.ts";
import { loadNavigationAutomationConfig } from "../src/core/navigation-automation-config.ts";
import { compileNavigationDesiredState, desiredLaneStateHash } from "../src/core/navigation-desired-state.ts";
import { graphifyReinstallCommand, ownedGraphifyBinIfPresent, GRAPHIFY_PIN } from "../src/core/backend-registry.ts";
import { extensionRuntimePaths } from "../src/core/owned-runtime.ts";

const CONFIG_NAME = ".pi-navigation.json";
const STATE_NAME = path.join(".pi", "navigation", "state.json");
const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRESHEN_SCRIPT = path.join(EXTENSION_ROOT, "scripts", "navigation-freshen.mjs");
const PI_NAV_CHECK_CACHE = new Map();

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { path: process.cwd(), scope: undefined, write: false, force: false, json: false, command: "doctor" };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("--")) args.command = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = () => {
      const next = rest[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--path" || flag === "-C") args.path = value();
    else if (flag === "--scope") args.scope = value();
    else if (flag === "--write") args.write = true;
    else if (flag === "--force") args.force = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}
export function detectProjectRoot(startPath = process.cwd()) {
  let start = path.resolve(startPath);
  try {
    if (existsSync(start) && !statSync(start).isDirectory()) start = path.dirname(start);
  } catch {}
  const chain = ancestorChain(start);
  const configured = chain.find(dir => existsSync(path.join(dir, CONFIG_NAME)));
  if (configured) return configured;
  const vcs = chain.find(dir => existsSync(path.join(dir, ".git")) || existsSync(path.join(dir, ".svn")));
  if (vcs) return vcs;
  return chain.find(isProjectRoot) ?? start;
}

function ancestorChain(start) {
  const chain = [];
  for (let current = start; ; current = path.dirname(current)) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) return chain;
  }
}

export function inspectNavigation(startPath = process.cwd(), options = {}) {
  const env = options.env ?? process.env;
  const root = detectProjectRoot(startPath);
  const configPath = path.join(root, CONFIG_NAME);
  const statePath = navigationStatePath(root);
  const config = readJsonIfExists(configPath);
  const state = readJsonIfExists(statePath);
  const targetRoot = resolveInspectionTargetRoot(root, startPath, options);
  const requestedPath = normalizeStartPath(startPath);
  const tools = inspectTooling(env);
  const automation = loadNavigationAutomationConfig({ env, home: options.home ?? (options.env && !("HOME" in options.env) ? root : undefined) });
  const desired = compileNavigationDesiredState({
    root,
    automation: automation.config,
    projectConfig: config.value,
    projectState: state.value,
    trigger: "query",
    backendIdentities: {
      docs: { available: tools.pi_nav.available && Boolean(config.value?.docs?.repo), compatible: tools.pi_nav.available, version: "qmd-2.5.3", schemaVersion: "sections-v2" },
      graph: { available: tools.graphify.available || Boolean(config.value?.graph?.command && commandAvailable(config.value.graph.command, env)), compatible: true, version: env.PI_NAV_GRAPHIFY_VERSION ?? GRAPHIFY_PIN, schemaVersion: "1" },
    },
    providerAvailable: {
      docs: providerConfigured("docs", automation.config, env),
      graph: providerConfigured("graph", automation.config, env),
    },
  });
  const lanes = inspectLanes({ root, targetRoot, config: config.value, state: state.value, tools, env, now: options.now ? new Date(options.now) : new Date(), desired });
  const ready = lanes.filter(lane => lane.status === "ready").map(lane => lane.name);
  const blocked = lanes.filter(lane => lane.status === "blocked").map(lane => lane.name);
  const disabled = lanes.filter(lane => lane.status === "disabled").map(lane => lane.name);
  const warnings = [...nestedConfigWarnings(root, targetRoot), ...legacyArtifactWarnings(root, config.value, state.value), ...globalConfigDriftWarnings(env), ...lanes.flatMap(lane => lane.warnings ?? [])];
  const nextActions = buildNextActions({ root, targetRoot, config, state, lanes, warnings });
  const status = blocked.length || warnings.length ? "warning" : ready.length ? "success" : "warning";
  const warningSummary = warnings.length ? `, ${warnings.length} warning(s)` : "";
  return {
    status,
    summary: `${ready.length} ready lane(s), ${blocked.length} blocked lane(s), ${disabled.length} disabled lane(s)${warningSummary}`,
    root,
    requestedPath,
    targetRoot,
    targetRootRel: relativeDisplay(root, targetRoot),
    configPath,
    statePath,
    config: { exists: config.exists, error: config.error },
    state: { exists: state.exists, error: state.error },
    exactSearchPolicy: inspectExactSearchPolicy(root),
    tools,
    desiredState: { version: desired.version, hash: desired.desiredStateHash, rootIdentity: desired.rootIdentity, globalPolicyIdentity: desired.globalPolicyIdentity, projectOverrideIdentity: desired.projectOverrideIdentity, laneHashes: { docs: desiredLaneStateHash(desired, "docs"), graph: desiredLaneStateHash(desired, "graph") }, lanes: desired.lanes },
    lanes,
    warnings,
    next_actions: nextActions,
  };
}

export function writeBootstrap(root, options = {}) {
  const force = Boolean(options.force);
  const report = inspectNavigation(root, options);
  const configPath = path.join(report.root, CONFIG_NAME);
  const statePath = path.join(report.root, STATE_NAME);
  const writes = [];
  const warnings = [];
  if (existsSync(configPath) && !force) {
    warnings.push(`${CONFIG_NAME} exists; not overwriting without --force`);
  } else {
    writeJson(configPath, skeletonConfig(report));
    writes.push(configPath);
  }
  if (existsSync(statePath) && !force) {
    warnings.push(`${STATE_NAME} exists; not overwriting without --force`);
  } else {
    writeJson(statePath, { indexes: {} });
    writes.push(statePath);
  }
  return { ...inspectNavigation(report.root, options), writes, warnings };
}

function inspectExactSearchPolicy(root) {
  const customPath = path.join(root, ".pi", "navigation", "ignore");
  if (existsSync(customPath) && statSync(customPath).isFile()) {
    return {
      visibility: "project",
      source: "custom_navigation_ignore",
      path: customPath,
      customOverride: true,
      gitIgnoreSuppressed: true,
      counts: "query_result_only",
    };
  }
  if (existsSync(path.join(root, ".git"))) {
    return {
      visibility: "project",
      source: "gitignore",
      path: root,
      customOverride: false,
      gitIgnoreSuppressed: false,
      counts: "query_result_only",
    };
  }
  return {
    visibility: "project",
    source: "none",
    path: null,
    customOverride: false,
    gitIgnoreSuppressed: false,
    counts: "query_result_only",
  };
}
function isProjectRoot(dir) {
  return [
    ".git", ".svn", CONFIG_NAME, "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "Gemfile", "pom.xml", "build.gradle", "flake.nix",
  ].some(marker => existsSync(path.join(dir, marker)));
}

function navigationStatePath(root) {
  return path.join(root, STATE_NAME);
}

function stateDisplayName(root) {
  return relativeDisplay(root, navigationStatePath(root));
}

function inspectTooling(env) {
  const piNav = inspectPiNavPackage(EXTENSION_ROOT, env);
  return {
    graphify: commandInfo(ownedGraphifyBinIfPresent() || "", env),
    pi_nav: piNav,
  };
}

export function inspectPiNavPackage(packageRoot, env = process.env) {
  let target;
  let artifacts;
  try {
    target = resolvePiNavTarget();
    artifacts = piNavArtifactPaths(packageRoot, target);
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error) };
  }
  const missing = [!existsSync(artifacts.addon) ? artifacts.addon : undefined, !existsSync(artifacts.cli) ? artifacts.cli : undefined].filter(Boolean);
  const packaged = existsSync(path.join(packageRoot, "RELEASE-MANIFEST.json"));
  const recovery = packaged ? "reinstall the verified matching release container while Pi is stopped" : "source checkout: npm run pi-nav:build";
  if (missing.length) return { available: false, checked: false, target: target.releaseKey, ...artifacts, reason: `bundled pi-nav artifact missing: ${missing.join(", ")}; ${recovery}` };
  const cacheKey = piNavCheckCacheKey(packageRoot, target, artifacts);
  const cached = PI_NAV_CHECK_CACHE.get(cacheKey);
  if (cached) return cached;
  const child = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "pi-nav-build.mjs"), "check", "--json"], {
    cwd: packageRoot,
    env: { ...env, PATH: process.env.PATH ?? env.PATH },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const payload = parseLastJson(child.status === 0 ? child.stdout : child.stderr || child.stdout);
  const available = child.status === 0 && payload?.ok === true;
  const result = {
    available,
    checked: true,
    target: target.releaseKey,
    ...artifacts,
    ...(payload ? { check: payload } : {}),
    ...(!available ? { reason: `bundled pi-nav check failed: ${payload?.code ?? child.error?.code ?? `exit_${child.status ?? "unknown"}`} — ${payload?.message ?? child.error?.message ?? String(child.stderr || child.stdout || "no diagnostic").trim()}; ${recovery}` } : {}),
  };
  PI_NAV_CHECK_CACHE.clear();
  PI_NAV_CHECK_CACHE.set(cacheKey, result);
  return result;
}

function piNavCheckCacheKey(packageRoot, target, artifacts) {
  const values = [packageRoot, target.releaseKey, process.execPath];
  for (const file of [artifacts.addon, artifacts.cli, path.join(packageRoot, "RELEASE-MANIFEST.json")]) {
    try {
      const info = statSync(file);
      values.push(file, String(info.size), String(info.mtimeMs));
    } catch {
      values.push(file, "missing");
    }
  }
  return values.join("|");
}

function parseLastJson(text) {
  const lines = String(text ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  return undefined;
}


function inspectLanes({ root, targetRoot, config, state, tools, env, now, desired }) {
  return [
    inspectDocsLane(root, config, config?.docs, state?.indexes?.docs, tools, env, now, desired.lanes.docs, desired),
    inspectGraphLane(root, targetRoot, config, config?.graph, state?.indexes?.graph, tools, env, now, desired.lanes.graph, desired),
  ];
}

function inspectDocsLane(root, _config, configLane, stateLane, tools, _env, _now, _desiredLane, _desired) {
  const enabled = configLane?.enabled === true || stateLane?.enabled === true;
  const repo = firstString(configLane?.repo, stateLane?.repo);
  const indexPath = absoluteMaybe(root, firstString(configLane?.indexPath, stateLane?.indexPath)) ?? path.join(root, ".pi", "navigation", "qmd");
  const problems = [];
  const health = laneHealthProblem(configLane, stateLane);
  if (health) problems.push(health);
  if (!repo) problems.push("docs repo id missing");
  if (enabled && String(configLane?.backend ?? "").toLowerCase() !== "qmd") problems.push("obsolete docs backend configuration remains; automatic QMD migration has not completed");
  if (configLane?.queryCommand || configLane?.queryTransport || configLane?.indexCommand) problems.push("obsolete docs command/transport configuration remains; rerun QMD docs freshen");
  if (!tools.pi_nav.available) problems.push(`packaged pi-nav unavailable: ${tools.pi_nav.reason ?? "unknown"}`);
  if (!existsSync(indexPath)) problems.push(`QMD index directory missing at ${relativeDisplay(root, indexPath)}`);
  const qmd = stateLane?.qmd;
  if (!qmd) problems.push("QMD lifecycle status missing");
  else if (qmd.status === "degraded") problems.push(String(qmd.reason ?? "QMD status degraded"));
  else if (Number(qmd.health?.needsEmbedding ?? 0) > 0 && qmd.status === "ready") problems.push(`QMD claims ready with ${qmd.health.needsEmbedding} section document(s) needing vectors`);
  return lane("docs", enabled, problems, {
    backend: "qmd",
    repo,
    indexPath: relativeDisplay(root, indexPath),
    qmd,
    generationId: stateLane?.generationId ?? qmd?.generation,
    setup: `node ${shellQuote(FRESHEN_SCRIPT)} docs --path ${shellQuote(root)}`,
  });
}

function inspectGraphLane(root, targetRoot, config, configLane, stateLane, tools, env, now, desiredLane, desired) {
  const enabled = configLane?.enabled === true || stateLane?.enabled === true;
  const graphPath = absoluteMaybe(root, firstString(configLane?.graphPath, stateLane?.graphPath, stateLane?.path, ".pi/navigation/graphify/graphify-out/graph.json"));
  const laneRoot = absoluteMaybe(root, firstString(configLane?.root, stateLane?.root, ".")) ?? root;
  const mode = firstString(configLane?.mode, stateLane?.mode);
  const provider = firstString(configLane?.provider, stateLane?.provider);
  const model = firstString(configLane?.model, stateLane?.model);
  const effectiveCommand = tools.graphify.path ?? extensionRuntimePaths().graphify;
  const commandIdentity = inspectCommandIdentity("graph", firstString(configLane?.command, stateLane?.command), effectiveCommand, env);
  const semanticExtractionObserved = firstBoolean(configLane?.semanticExtractionObserved, stateLane?.semanticExtractionObserved);
  const semanticAnswerQualityCertified = firstBoolean(configLane?.semanticAnswerQualityCertified, stateLane?.semanticAnswerQualityCertified) === true;
  const semanticQuality = semanticQualitySummary({ mode, semanticExtractionObserved, semanticAnswerQualityCertified });
  const problems = outOfScopeProblems(laneRoot, targetRoot, "Graphify graph");
  if (!tools.graphify.available && !configLane?.command) problems.push("Graphify command not found/configured");
  if (!existsSync(graphPath)) problems.push(`Graphify graph missing at ${relativeDisplay(root, graphPath)}`);
  if (mode && /deep/i.test(mode) && semanticExtractionObserved === false) problems.push("Graphify deep extraction recorded AST-only quality (semanticExtractionObserved=false)");
  // F2: provider-key discovery for "any user computer" reliability. When semantic/deep
  // graph mode is configured, the corresponding provider key must be present or rich
  // extraction will fail with a confusing auth error. Maps provider -> key env var.
  if (provider && /deep|rich/i.test(String(mode))) {
    const keyVar = providerKeyEnv(provider);
    if (keyVar && !env[keyVar]) problems.push(`Graphify ${mode} mode needs ${keyVar} for provider "${provider}" (semantic/LLM extraction); set it in ~/.pi/agent/navigation.yaml or your shell environment`);
  }
  // F3: for OpenAI-compatible graph providers (currently minimax), the rich-update
  // helper drives extraction through the OpenAI SDK. If the graphify runtime lacks
  // the openai package, semantic extraction silently hollows (0 tokens) and the graph
  // shrinks. Detect this early so fresh machines get an actionable install hint.
  if (provider && /deep|rich/i.test(String(mode)) && String(provider).toLowerCase() === "minimax" && tools.graphify.available) {
    const graphifyDir = path.dirname(tools.graphify.path);
    const graphifyPython = [path.join(graphifyDir, "python"), path.join(graphifyDir, "python3")].find(p => existsSync(p));
    if (graphifyPython) {
      const probe = spawnSync(graphifyPython, ["-c", "import openai"], { encoding: "utf8", timeout: 10_000, env: { ...env, PYTHONNOUSERSITE: "1" } });
      if (probe.error || probe.status !== 0) {
        problems.push(`Graphify provider "${provider}" needs the openai SDK for rich semantic extraction; reinstall it into the owned runtime: ${graphifyReinstallCommand(env)}`);
      }
    }
  }
  const richReportPath = path.join(path.dirname(graphPath), "rich-update-report.json");
  const richReport = readJsonIfExists(richReportPath).value;
  const reportFailure = richReport && String(richReport.status) === "error" ? { rootCause: richReport.root_cause, summary: richReport.summary, reportPath: relativeDisplay(root, richReportPath) } : undefined;
  const refreshStatus = firstString(stateLane?.refreshStatus, configLane?.refreshStatus, reportFailure ? "unavailable" : undefined);
  const refreshFailure = stateLane?.lastRefreshFailure ?? configLane?.lastRefreshFailure ?? reportFailure;
  const warnings = commandIdentity.warning ? [commandIdentity.warning] : [];
  if (refreshStatus && refreshStatus !== "ready") {
    const detail = firstString(refreshFailure?.rootCause, refreshFailure?.summary);
    problems.push(`Graphify refresh ${refreshStatus}; current map queries are unavailable${detail ? `: ${detail}` : ""}`);
  }
  problems.push(...desiredStateProblems(stateLane, desiredLane, desired));
  return lane("graph", enabled, problems, {
    backend: "Graphify",
    graphPath: relativeDisplay(root, graphPath),
    commandIdentity,
    mode,
    provider,
    model,
    semanticExtractionObserved,
    semanticAnswerQualityCertified,
    semanticQuality,
    refreshStatus,
    lastRefreshFailure: refreshFailure,
    warnings,
    setup: `node ${shellQuote(FRESHEN_SCRIPT)} graph --path ${shellQuote(root)}`,
  });
}


function lane(name, enabled, problems, details) {
  const status = !enabled ? "disabled" : classifyLaneStatus(problems);
  return { name, status, enabled, problems, ...details };
}

function classifyLaneStatus(problems) {
  if (!problems.length) return "ready";
  if (problems.some(problem => /command (?:missing|not found)|executable|queryTransport|repo id missing|indexPath missing|graph missing|refresh (?:dirty|degraded|failed|unavailable)|capability (?:missing|incompatible)|backend (?:missing|incompatible)/i.test(problem))) return "blocked";
  if (problems.some(problem => /desired-state mismatch|root identity mismatch|generation.*missing at|index stale|stale:/i.test(problem))) return "stale";
  if (problems.some(problem => /provider missing|claimed embeddings|title fallback|semantic.*AST-only/i.test(problem))) return "degraded";
  if (problems.some(problem => /desired-state identity missing|root identity missing|generation identity missing|probe status missing/i.test(problem))) return "warming";
  return "blocked";
}

function desiredStateProblems(stateLane, desiredLane, desired) {
  const problems = [];
  const lane = desiredLane.backend === "qmd" ? "docs" : "graph";
  const expectedHash = desiredLaneStateHash(desired, lane);
  if (!stateLane?.desiredStateHash) problems.push("desired-state identity missing");
  else if (stateLane.desiredStateHash !== expectedHash) problems.push("desired-state mismatch");
  if (!stateLane?.rootIdentity) problems.push("root identity missing");
  else if (stateLane.rootIdentity !== desired.rootIdentity) problems.push("root identity mismatch");
  if (!stateLane?.generationId) problems.push("generation identity missing");
  if (stateLane?.lastProbeStatus !== "ready") problems.push(`probe status missing or unhealthy: ${stateLane?.lastProbeStatus ?? "missing"}`);
  if (desiredLane.capability !== "available") problems.push(`${desiredLane.backend} capability ${desiredLane.capability}`);
  if (stateLane?.backendIdentity?.name && stateLane.backendIdentity.name !== desiredLane.backend) problems.push("backend identity mismatch");
  if (stateLane?.backendIdentity?.version && desiredLane.backendVersion && stateLane.backendIdentity.version !== desiredLane.backendVersion) problems.push("backend version mismatch");
  if (stateLane?.backendIdentity?.schemaVersion && desiredLane.schemaVersion && stateLane.backendIdentity.schemaVersion !== desiredLane.schemaVersion) problems.push("backend schema mismatch");
  problems.push(...desiredLane.diagnostics.map(value => value.replace(/_/g, " ")));
  return problems;
}

function buildNextActions({ root, targetRoot, config, state, lanes, warnings = [] }) {
  const actions = [];
  if (!config.exists) actions.push(`Run: navigation-doctor --path ${shellQuote(root)} --write`);
  if (warnings.some(warning => /legacy navigation state/.test(warning))) actions.push("Legacy navigation state was found but is not used as a ready lane; run approved nav:prepare/nav:freshen to write canonical .pi/navigation/state.json.");
  if (warnings.some(warning => /nested navigation config/.test(warning))) actions.push("Resolve nested navigation config overlap: run nav:doctor on the parent path named in warnings, or align child and parent prepared-lane roots/state.");
  const outOfScope = lanes.some(item => item.status === "blocked" && item.problems.some(isOutOfScopeProblem));
  if (outOfScope && targetRoot && targetRoot !== root) {
    actions.push(`Requested path is outside configured prepared-lane scope; run: navigation-prepare --path ${shellQuote(targetRoot)} --dry-run --json`);
  }
  for (const item of lanes) {
    const itemOutOfScope = item.problems.some(isOutOfScopeProblem);
    if ((item.name === "docs" || item.name === "graph") && item.status === "blocked" && item.setup && !itemOutOfScope) {
      actions.push(item.setup);
    }
    if (item.status === "blocked") actions.push(`Fix ${item.name}: ${item.problems.join("; ")}`);
  }
  if (!state.exists) actions.push(`Create/freshen ${stateDisplayName(root)} after indexes are built`);
  return [...new Set(actions)].slice(0, 10);
}

function isOutOfScopeProblem(problem) {
  return /does not cover requested target/.test(problem);
}

// Scaffold external prepared lanes only. Core inherits its existing machine and
// project consent; initialization must not invent a new code-lane opt-out.
function skeletonConfig(report) {
  return {
    docs: { enabled: false, backend: "qmd", repo: "", indexPath: ".pi/navigation/qmd", root: "." },
    graph: { enabled: false, backend: "Graphify", command: report.tools.graphify.path ?? "", graphPath: ".pi/navigation/graphify/graphify-out/graph.json", root: "." },
  };
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return { exists: false, value: undefined, error: undefined };
  try {
    return { exists: true, value: JSON.parse(readFileSync(file, "utf8")), error: undefined };
  } catch (error) {
    return { exists: true, value: undefined, error: String(error?.message ?? error) };
  }
}

function nestedConfigWarnings(root, targetRoot) {
  const localConfig = path.join(root, CONFIG_NAME);
  if (!existsSync(localConfig)) return [];
  const localParsed = readJsonIfExists(localConfig);
  const warnings = [];
  for (let current = path.dirname(root); ; current = path.dirname(current)) {
    const parentConfig = path.join(current, CONFIG_NAME);
    if (existsSync(parentConfig)) {
      const parsed = readJsonIfExists(parentConfig);
      const overlapping = coveringLaneNames(current, parsed.value, targetRoot).filter(name => !localLaneOwnsTarget({ laneName: name, localRoot: root, localConfig: localParsed.value, targetRoot }));
      const misaligned = overlapping.filter(name => !laneConfigsAlign({ laneName: name, parentRoot: current, parentConfig: parsed.value, localRoot: root, localConfig: localParsed.value }));
      if (misaligned.length) {
        warnings.push(`nested navigation config ${localConfig} overlaps parent ${parentConfig}; query tools may inherit/resolve parent lane(s): ${misaligned.join(", ")}. Keep child and parent lane roots in sync or run doctor on the intended scope.`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
  }
  return warnings;
}

function laneConfigsAlign({ laneName, parentRoot, parentConfig, localRoot, localConfig }) {
  const parentLane = parentConfig?.[laneName];
  const localLane = localConfig?.[laneName];
  if (!parentLane || !localLane || parentLane.enabled === false || localLane.enabled === false) return false;
  const parentSig = laneSignature(laneName, parentRoot, parentLane);
  const localSig = laneSignature(laneName, localRoot, localLane);
  return parentSig.every((value, index) => value === localSig[index]);
}

function localLaneOwnsTarget({ laneName, localRoot, localConfig, targetRoot }) {
  const localLane = localConfig?.[laneName];
  if (!localLane || localLane.enabled === false) return false;
  const laneRoot = absoluteMaybe(localRoot, firstString(localLane.root, ".")) ?? localRoot;
  return pathCovers(laneRoot, targetRoot) || pathCovers(targetRoot, laneRoot);
}

function laneSignature(laneName, configRoot, laneConfig) {
  const laneRoot = path.resolve(absoluteMaybe(configRoot, firstString(laneConfig.root, ".")) ?? configRoot);
  if (laneName === "docs") return [laneRoot, path.resolve(absoluteMaybe(configRoot, firstString(laneConfig.indexPath)) ?? path.join(laneRoot, ".pi", "navigation", "qmd"))];
  if (laneName === "graph") return [laneRoot, path.resolve(absoluteMaybe(configRoot, firstString(laneConfig.graphPath, laneConfig.indexPath)) ?? path.join(laneRoot, ".pi", "navigation", "graphify", "graphify-out", "graph.json"))];
  return [laneRoot];
}

function legacyArtifactWarnings(root, config, state) {
  const warnings = [];
  const oldState = path.join(root, ".pi", "navigation-state.json");
  if (existsSync(oldState)) warnings.push(`legacy navigation state ${relativeDisplay(root, oldState)} exists but is not canonical; current tools use ${stateDisplayName(root)}`);
  if (config?.tilth || state?.indexes?.tilth) warnings.push("obsolete per-project tilth config/state is ignored; bundled pi-nav live queries require no prepared lane or migration");
  return warnings;
}

function coveringLaneNames(configRoot, config, targetRoot) {
  if (!config || typeof config !== "object") return [];
  const lanes = [];
  for (const name of ["docs", "graph"]) {
    const laneConfig = config[name];
    if (!laneConfig || laneConfig.enabled === false) continue;
    const laneRoot = absoluteMaybe(configRoot, firstString(laneConfig.root, ".")) ?? configRoot;
    if (pathCovers(laneRoot, targetRoot) || pathCovers(targetRoot, laneRoot)) lanes.push(name);
  }
  return lanes;
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}


function resolveInspectionTargetRoot(root, startPath, options = {}) {
  if (options.scope) return path.resolve(root, options.scope);
  const start = normalizeStartPath(startPath);
  return nearestNestedProjectRoot(start, root) ?? start;
}

function normalizeStartPath(startPath) {
  let start = path.resolve(startPath);
  try {
    if (existsSync(start) && !statSync(start).isDirectory()) start = path.dirname(start);
  } catch {}
  return start;
}

function outOfScopeProblems(laneRoot, targetRoot, label) {
  const compatible = pathCovers(laneRoot, targetRoot) || pathCovers(targetRoot, laneRoot);
  return compatible ? [] : [`${label} root ${laneRoot} does not cover requested target ${targetRoot}`];
}

function pathCovers(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !rel || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function globalConfigDriftWarnings(env) {
  const configPath = env.PI_NAV_CONFIG || env.PI_NAVIGATION_CONFIG || env.PI_NAV_AUTOMATION_CONFIG;
  if (!configPath) return [];
  const config = readJsonIfExists(configPath);
  if (!config.exists || config.error || !config.value || typeof config.value !== "object") return [];
  const backends = config.value.backends;
  const warnings = [];
  if (backends?.semantic || /semble|codanna/i.test(JSON.stringify(backends ?? {}))) {
    warnings.push(`global navigation config ${configPath} still contains obsolete semantic/Semble/Codanna backend drift; clean-break navigation ignores those lanes`);
  }
  return warnings;
}

function nearestNestedProjectRoot(startPath, configRoot) {
  let current = path.resolve(startPath);
  try {
    if (existsSync(current) && !statSync(current).isDirectory()) current = path.dirname(current);
  } catch {}
  const stop = path.resolve(configRoot);
  for (;;) {
    if (current !== stop && hasProjectMarker(current)) return current;
    if (current === stop) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function hasProjectMarker(dir) {
  return ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "Gemfile", "pom.xml", "build.gradle", "flake.nix"].some(marker => existsSync(path.join(dir, marker)));
}


function commandAvailable(command, env = process.env) {
  if (!command) return false;
  return Boolean(findCommand(command, env));
}

function laneHealthProblem(configLane, stateLane) {
  const status = firstString(configLane?.status, stateLane?.status);
  if (status && /^(error|failed|disabled)$/i.test(status)) return `lane marked unhealthy in navigation state/config: status=${status}`;
  const disabledAt = firstString(configLane?.disabledAt, stateLane?.disabledAt);
  if (disabledAt) return `lane disabled after failed setup at ${disabledAt}`;
  const lastError = firstString(configLane?.lastError, stateLane?.lastError);
  if (lastError) return `lane has unresolved setup error: ${lastError}`;
  return undefined;
}

function docsIndexStalenessProblem(configRoot, docsRoot, indexPath, repo) {
  if (!repo) return undefined;
  const indexFile = path.join(indexPath, ...String(repo).split("/")) + ".json";
  if (!existsSync(indexFile)) return `docs index file missing for repo ${repo} at ${relativeDisplay(configRoot, indexFile)}`;
  let json;
  try { json = JSON.parse(readFileSync(indexFile, "utf8")); }
  catch (error) { return `docs index file is unreadable for repo ${repo}: ${error?.message ?? error}`; }
  const docPaths = collectDocsIndexPaths(json);
  const missing = docPaths.filter(pathValue => !docsPathExists(docsRoot, pathValue));
  if (!missing.length) return undefined;
  return `docs index stale: ${missing.length} indexed doc path(s) missing from live tree (${missing.slice(0, 3).join(", ")})`;
}

function collectDocsIndexPaths(json) {
  const out = new Set();
  const add = value => { if (typeof value === "string" && value.trim()) out.add(value.trim()); };
  if (Array.isArray(json?.doc_paths)) for (const item of json.doc_paths) add(item);
  if (Array.isArray(json?.files)) for (const item of json.files) add(item);
  if (Array.isArray(json?.sections)) for (const section of json.sections) add(section?.doc_path ?? section?.path ?? section?.file_path);
  return [...out].filter(value => !/^[a-z]+:\/\//i.test(value));
}

function docsPathExists(root, pathValue) {
  const abs = path.isAbsolute(pathValue) ? pathValue : path.join(root, pathValue);
  try { return statSync(abs).isFile(); } catch { return false; }
}

function docsQuality(configLane, stateLane) {
  return {
    embeddings: firstString(stateLane?.quality?.embeddings, configLane?.quality?.embeddings, "off"),
    aiSummaries: firstBoolean(stateLane?.quality?.aiSummaries, configLane?.quality?.aiSummaries) === true,
  };
}

function docsQualityProblem(indexPath, repo, quality) {
  if (!quality || quality.embeddings === "off" && !quality.aiSummaries) return undefined;
  const indexFile = path.join(indexPath, ...String(repo).split("/")) + ".json";
  if (!existsSync(indexFile)) return undefined;
  let json;
  try { json = JSON.parse(readFileSync(indexFile, "utf8")); } catch { return undefined; }
  const sections = Array.isArray(json?.sections) ? json.sections : [];
  if (quality.embeddings !== "off") {
    const vectors = sections.filter(section => Array.isArray(section?.embedding) && section.embedding.length > 0);
    const dimensions = new Set(vectors.map(section => section.embedding.length));
    if (vectors.length !== sections.length || sections.length === 0) return `docs rich quality claims embeddings but only ${vectors.length}/${sections.length} sections have vectors`;
    if (dimensions.size !== 1 || [...dimensions][0] <= 0) return `docs rich quality claims embeddings but vector dimensions are inconsistent: ${[...dimensions].join(", ") || "none"}`;
  }
  if (quality.aiSummaries) {
    if (!sections.some(section => typeof section?.summary === "string" && section.summary.trim())) return "obsolete docs summary quality claim has no generated summaries";
    const summaryStats = docsAiSummaryStats(sections);
    if (summaryStats.eligible > 0 && summaryStats.nonTitle === 0) return "docs rich quality claims AI summaries but summaries appear to be heading/title fallback only; no non-title summaries found for content-bearing short-title sections";
  }
  return undefined;
}

function docsAiSummaryStats(sections) {
  let eligible = 0;
  let nonTitle = 0;
  for (const section of sections) {
    const title = String(section?.title ?? section?.heading ?? "").trim();
    const summary = String(section?.summary ?? "").trim();
    const hasContentRange = Number(section?.byte_end ?? 0) > Number(section?.byte_start ?? 0);
    if (title.length < 20 && hasContentRange) eligible += 1;
    if (summary && !isTitleSummary(summary, title, section?.level)) nonTitle += 1;
  }
  return { eligible, nonTitle };
}

function isTitleSummary(summary, title, level) {
  const s = normalizeSummaryText(summary);
  const t = normalizeSummaryText(title);
  if (!s || !t) return false;
  if (s === t) return true;
  const levelLabel = ({ 0: "root", 1: "section", 2: "subsection" })[Number(level)] ?? "section";
  return s === `${levelLabel}: ${t}`;
}

function normalizeSummaryText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}


function semanticQualitySummary({ mode, semanticExtractionObserved, semanticAnswerQualityCertified }) {
  if (!mode || !/deep/i.test(String(mode))) return "not_applicable";
  if (semanticExtractionObserved === false) return "ast_only_no_semantic_extraction";
  if (semanticExtractionObserved === true && semanticAnswerQualityCertified === true) return "semantic_answer_quality_certified";
  if (semanticExtractionObserved === true) return "semantic_extraction_observed_answer_quality_uncertified";
  return "semantic_extraction_unknown";
}
function firstBoolean(...values) {
  for (const value of values) if (typeof value === "boolean") return value;
  return undefined;
}

// F2: map a configured provider to the env var holding its API key, for discovery.
function providerKeyEnv(provider) {
  const p = String(provider ?? "").toLowerCase();
  if (p === "deepseek") return "DEEPSEEK_API_KEY";
  if (p === "openai") return "OPENAI_API_KEY";
  if (p === "minimax" || p === "minimax-m3") return "MINIMAX_API_KEY";
  if (p === "anthropic") return "ANTHROPIC_API_KEY";
  if (p === "google" || p === "gemini") return "GOOGLE_API_KEY";
  return undefined; // unknown/custom providers: don't false-warn
}

function providerConfigured(lane, config, env) {
  if (lane === "docs") {
    const docs = config?.backends?.docs ?? {};
    const needsEmbedding = config?.providers?.allowEmbeddings === true && docs.embeddings !== false && docs.embeddings !== "none";
    const needsSummary = config?.providers?.allowLLM === true && (docs.aiSummaries === true || docs.aiSummaries === "auto");
    const embeddingKey = providerKeyEnv(docs.embeddingProvider ?? config?.providers?.defaultEmbeddingProvider);
    const summaryKey = providerKeyEnv(docs.summarizerProvider ?? config?.providers?.defaultLLMProvider);
    return (!needsEmbedding || (embeddingKey ? Boolean(env[embeddingKey]) : false)) && (!needsSummary || (summaryKey ? Boolean(env[summaryKey]) : false));
  }
  const graph = config?.backends?.graph ?? {};
  if (!/deep|rich/i.test(String(graph.mode ?? graph.deepMode ?? ""))) return true;
  const key = providerKeyEnv(graph.provider);
  return key ? Boolean(env[key]) : false;
}

function unsafeDocsCommandFileReason(command, env = process.env) {
  const resolved = findCommand(command, env);
  if (!resolved) return undefined;
  let text = "";
  try { text = readFileSync(resolved, "utf8").slice(0, 4096); } catch { return undefined; }
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (/^#!.*\b(?:sh|bash|zsh|fish)\b/i.test(firstLine)) return "obsolete docs queryCommand points at a shell wrapper; remove command-based docs configuration";
  if (/\bmcp2cli\b|\buv\s+tool\s+uvx\b|\buvx\b|\bnpx\b|\bdlx\b/i.test(text)) return "obsolete docs queryCommand points at a package runner; remove command-based docs configuration";
  return undefined;
}

function firstString(...values) {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function absoluteMaybe(root, value) {
  if (!value) return undefined;
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function relativeDisplay(root, file) {
  if (!file) return undefined;
  const rel = path.relative(root, file).replace(/\\/g, "/");
  return rel === "" ? "." : rel && !rel.startsWith("../") ? rel : file;
}


function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function inspectCommandIdentity(lane, configured, effective, env = process.env) {
  const configuredValue = typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
  const effectiveValue = typeof effective === "string" && effective.trim() ? effective.trim() : undefined;
  const configuredResolved = configuredValue ? findCommand(configuredValue, env) : undefined;
  const same = Boolean(configuredValue && effectiveValue && path.resolve(configuredResolved ?? configuredValue) === path.resolve(effectiveValue));
  const configuredIgnored = Boolean(configuredValue && effectiveValue && !same);
  const staleConfiguredIgnored = Boolean(configuredIgnored && !configuredResolved);
  const warning = staleConfiguredIgnored
    ? `stale configured ${lane} command ${configuredValue} was ignored; effective extension-owned command is ${effectiveValue}`
    : undefined;
  return { configured: configuredValue, effective: effectiveValue, configuredAvailable: Boolean(configuredResolved), configuredIgnored, staleConfiguredIgnored, warning };
}

function commandInfo(command, env = process.env) {
  const found = findCommand(command, env);
  return found ? { available: true, path: found } : { available: false, command: command ? String(command) : undefined };
}


function findCommand(command, env = process.env) {
  if (typeof command !== "string" || !command.trim()) return undefined;
  if (command.includes(path.sep)) return existsSync(command) ? command : undefined;
  const pathEnv = env.PATH || "";
  const exts = process.platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function render(report) {
  const lines = [];
  lines.push(`${report.status.toUpperCase()}: ${report.summary}`);
  lines.push(`Root: ${report.root}`);
  if (report.targetRoot && report.targetRoot !== report.root) lines.push(`Target root: ${report.targetRoot}`);
  lines.push(`Config: ${report.config.exists ? "present" : "missing"}${report.config.error ? ` (${report.config.error})` : ""}`);
  lines.push(`State: ${report.state.exists ? "present" : "missing"}${report.state.error ? ` (${report.state.error})` : ""}`);
  lines.push("");
  lines.push("Lanes:");
  for (const item of report.lanes) {
    lines.push(`- ${item.name}: ${item.status}${item.enabled ? "" : " (disabled)"}`);
    for (const problem of item.problems) lines.push(`  - ${problem}`);
  }
  if (report.next_actions.length) {
    lines.push("");
    lines.push("Next actions:");
    for (const action of report.next_actions) lines.push(`- ${action}`);
  }
  if (report.writes?.length || report.warnings?.length) {
    lines.push("");
    if (report.writes?.length) lines.push(`Wrote: ${report.writes.join(", ")}`);
    for (const warning of report.warnings ?? []) lines.push(`Warning: ${warning}`);
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: navigation-doctor.mjs [doctor|init] --path <folder> [--scope relative/path] [--write] [--force] [--json]\n\nDiagnoses Pi jeito-codeweave-pi readiness for any folder. --scope lets a parent .pi-navigation.json target a nested project. --write creates safe config/state skeletons; it never installs packages or builds indexes.");
    return 0;
  }
  if (!["doctor", "init"].includes(args.command)) throw new Error(`unsupported command: ${args.command}`);
  const report = args.write || args.command === "init" ? writeBootstrap(args.path, args) : inspectNavigation(args.path, args);
  console.log(args.json ? JSON.stringify(report, null, 2) : render(report));
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => process.exitCode = code).catch(error => {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}
