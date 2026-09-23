import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ownedBackendRuntime } from "./owned-runtime.ts";

const MAX_INLINE_DOCS_HEALTH_BYTES = 1024 * 1024;
export type NavigationLane = "docs" | "graph";

type Env = Record<string, string | undefined>;

export interface NavigationConfigBundle {
  root: string;
  configPath?: string;
  statePath?: string;
  config: any;
  state: any;
  diagnostics: string[];
}

export interface PreparedLaneReady {
  ok: true;
  lane: NavigationLane;
  backend?: string;
  command?: string;
  queryCommand?: string;
  queryTransport?: string;
  indexCommand?: string;
  repo?: string;
  root: string;
  graphPath?: string;
  indexPath?: string;
  cachePath?: string;
  python?: string;
  glob?: string;
  indexedAt?: string;
  updatedAt?: string;
  desiredStateHash?: string;
  rootIdentity?: string;
  generationId?: string;
  backendVersion?: string;
  schemaVersion?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingStatus?: string;
  embeddingReason?: string;
  observedQuality?: Record<string, unknown>;
  graphMode?: string;
  graphProvider?: string;
  graphModel?: string;
  graphDeepExtractionObserved?: boolean;
  graphSemanticExtractionObserved?: boolean;
  refreshStatus?: string;
  sourceFreshnessStatus?: string;
  sourceSnapshotIdentity?: string;
  lastProbeStatus?: string;
  lastProbeAt?: string;
  representativeProbes?: Record<string, string>;
  reason: string;
  configPath?: string;
  statePath?: string;
  diagnostics: string[];
}

export interface PreparedLaneUnavailable {
  ok: false;
  lane: NavigationLane;
  reason: string;
  configPath?: string;
  statePath?: string;
  diagnostics: string[];
}

export type PreparedLaneResolution = PreparedLaneReady | PreparedLaneUnavailable;

export async function loadNavigationConfig(scope: string): Promise<NavigationConfigBundle> {
  const diagnostics: string[] = [];
  const configPath = nearestFile(scope, ".pi-navigation.json");
  const statePath = configPath ? navigationStatePath(dirname(configPath)) : nearestNavigationStatePath(scope);
  const root = configPath ? dirname(configPath) : statePath ? rootFromStatePath(statePath) : startDir(scope);
  const config = configPath ? await readJson(configPath, diagnostics) : undefined;
  const state = statePath ? await readJson(statePath, diagnostics) : undefined;
  return { root, configPath, statePath, config, state, diagnostics };
}

export async function resolvePreparedLane(scope: string, lane: NavigationLane, options: { env?: Env; now?: Date } = {}): Promise<PreparedLaneResolution> {
  if (lane !== "docs" && lane !== "graph") throw new Error("Unknown prepared lane; code navigation uses Core maintenance");
  const env = options.env ?? process.env;
  const bundles = await loadNavigationConfigChain(scope);
  const fallbackBundle = bundles[0] ?? await loadNavigationConfig(scope);
  for (const bundle of bundles) {
    if (bundle.configPath && bundle.diagnostics.length && lane !== "graph") return unavailable(bundle, lane, `navigation config error: ${bundle.diagnostics[0]}`);
    let configLane = laneConfig(bundle.config, lane);
    let stateLane = laneState(bundle.state, lane);
    const diagnostics = [...bundle.diagnostics];
    if (lane === "graph") {
      const reconciled = reconcileGraphLaneIdentity(bundle.root, configLane, stateLane);
      configLane = reconciled.configLane;
      stateLane = reconciled.stateLane;
      diagnostics.push(...reconciled.diagnostics);
    }
    const explicitDisabled = configLane === false || configLane?.enabled === false;
    if (explicitDisabled) return unavailable(bundle, lane, `${lane} disabled by .pi-navigation.json`);

    const envEnabled = envEnablesLane(env, lane);
    const enabled = configLane === true || configLane?.enabled === true || Boolean(envEnabled) || Boolean(stateLane?.enabled === true) || (lane === "graph" && Boolean(stateLane?.graphPath));
    if (!enabled) continue;

    let normalized = normalizeLane(bundle, lane, configLane, stateLane, env);
    const unhealthy = laneHealthProblem(lane, configLane, stateLane);
    if (unhealthy) return unavailable(bundle, lane, unhealthy);
    if (lane === "graph") {
      const maintenance = graphLaneMaintenanceProblems(bundle.root, stateLane);
      const recordedFreshness = firstString(stateLane?.sourceFreshnessStatus, configLane?.sourceFreshnessStatus);
      const refreshPending = maintenance.length > 0 || (normalized.refreshStatus && normalized.refreshStatus !== "ready") || (recordedFreshness && recordedFreshness !== "current");
      diagnostics.push(...maintenance.map(problem => `graph_refresh_pending=${problem}`));
      if (refreshPending) diagnostics.push(`graph_refresh_scheduled=${recordedFreshness ?? normalized.refreshStatus ?? "source_change"}`);
      // Availability describes the verified artifact, not whether a newer
      // atomic generation is currently being prepared.
      normalized = { ...normalized, refreshStatus: "ready", sourceFreshnessStatus: refreshPending ? "refreshing" : "current" };
    }


    if (lane === "docs" && !normalized.repo) return unavailable(bundle, lane, "docs lane configured without docs repo id");
    if (lane === "docs") {
      if (!normalized.indexPath) return unavailable(bundle, lane, "docs lane configured without QMD indexPath");
      if (!existsSync(normalized.indexPath)) return unavailable(bundle, lane, `QMD docs indexPath missing at ${normalized.indexPath}`);
      if (normalized.queryTransport || normalized.queryCommand) return unavailable(bundle, lane, "obsolete docs query command/transport remains configured; run QMD docs freshen");
    }
    if (lane === "graph" && !normalized.graphPath) return unavailable(bundle, lane, "graph lane configured without graphPath");
    if (lane === "graph" && !existsSync(normalized.graphPath!)) return unavailable(bundle, lane, `graph artifact missing at ${normalized.graphPath}`);
    if (lane === "graph" && !normalized.command) return unavailable(bundle, lane, "extension-owned Graphify runtime is not provisioned; run /navigation-setup");
    return {
      ok: true,
      lane,
      ...normalized,
      reason: readyReason(lane, normalized, bundle),
      configPath: bundle.configPath,
      statePath: bundle.statePath,
      diagnostics,
    };
  }
  const legacy = legacyPreparedHints(scope);
  const legacySuffix = legacy.length ? `; legacy artifacts found but not used: ${legacy.join(", ")}. Run approved nav:prepare/nav:freshen to write canonical .pi-navigation.json and .pi/navigation/state.json.` : "";
  return unavailable(fallbackBundle, lane, `${lane} lane not configured; hooks/config must declare prepared intelligence before query-time use${legacySuffix}`);
}

async function loadNavigationConfigChain(scope: string): Promise<NavigationConfigBundle[]> {
  const bundles: NavigationConfigBundle[] = [];
  for (let current = startDir(scope); ; current = dirname(current)) {
    const configPath = existing(join(current, ".pi-navigation.json"));
    if (configPath) {
      const diagnostics: string[] = [];
      const statePath = navigationStatePath(current);
      const config = await readJson(configPath, diagnostics);
      const state = statePath ? await readJson(statePath, diagnostics) : undefined;
      bundles.push({ root: current, configPath, statePath, config, state, diagnostics });
    }
    const parent = dirname(current);
    if (parent === current) break;
  }
  if (bundles.length) return bundles;
  return [await loadNavigationConfig(scope)];
}

export function nearestFile(path: string, relativeFile: string): string | undefined {
  for (let current = startDir(path); ; current = dirname(current)) {
    const candidate = join(current, relativeFile);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
  }
}

export function canonicalNavigationStatePath(root: string): string {
  return join(root, ".pi", "navigation", "state.json");
}


function navigationStatePath(root: string): string | undefined {
  return existing(canonicalNavigationStatePath(root));
}

function nearestNavigationStatePath(scope: string): string | undefined {
  for (let current = startDir(scope); ; current = dirname(current)) {
    const candidate = navigationStatePath(current);
    if (candidate) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
  }
}

function legacyPreparedHints(scope: string): string[] {
  const hints: string[] = [];
  for (let current = startDir(scope); ; current = dirname(current)) {
    if (existsSync(join(current, ".pi", "navigation-state.json"))) hints.push(`${join(current, ".pi", "navigation-state.json")} (old state path)`);
    if (hints.length) return hints;
    const parent = dirname(current);
    if (parent === current) return hints;
  }
}

function rootFromStatePath(statePath: string): string {
  return dirname(dirname(dirname(statePath)));
}

function startDir(path: string): string {
  try {
    return statSync(path).isDirectory() ? path : dirname(path);
  } catch {
    return path;
  }
}

async function readJson(path: string, diagnostics: string[]): Promise<any> {
  const text = await readFile(path, "utf8").catch(error => {
    diagnostics.push(`${path}: ${error?.message ?? error}`);
    return undefined;
  });
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (error: any) {
    diagnostics.push(`${path}: invalid JSON (${error?.message ?? error})`);
    return undefined;
  }
}

function existing(path: string): string | undefined {
  return existsSync(path) ? path : undefined;
}

function unavailable(bundle: NavigationConfigBundle, lane: NavigationLane, reason: string): PreparedLaneUnavailable {
  return { ok: false, lane, reason, configPath: bundle.configPath, statePath: bundle.statePath, diagnostics: bundle.diagnostics };
}

function laneConfig(config: any, lane: NavigationLane): any {
  if (lane === "docs") return config?.docs;
  if (lane === "graph") return config?.graph;
  return undefined;
}

function laneState(state: any, lane: NavigationLane): any {
  const indexes = state?.indexes;
  if (lane === "docs") return indexes?.docs;
  if (lane === "graph") return indexes?.graph;
  return undefined;
}

type GraphGenerationPointer = { id: string; artifactPath: string; desiredStateHash?: string; rootIdentity?: string; backendVersion?: string };

function readGraphGenerationPointer(root: string, file: "current.json" | "last-good.json"): GraphGenerationPointer | undefined {
  try {
    const value = JSON.parse(readFileSync(join(root, ".pi", "navigation", "graphify", file), "utf8"));
    if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.artifactPath !== "string") return undefined;
    const expected = resolve(root, ".pi", "navigation", "graphify", "generations", value.id);
    if (resolve(value.artifactPath) !== expected || !existsSync(join(expected, "graph.json"))) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function graphGenerationFromPath(root: string, graphPath: string): string | undefined {
  const generations = resolve(root, ".pi", "navigation", "graphify", "generations");
  const artifactDirectory = resolve(dirname(graphPath));
  if (dirname(artifactDirectory) !== generations) return undefined;
  const id = artifactDirectory.slice(generations.length + 1);
  return id && /^[A-Za-z0-9._-]+$/.test(id) ? id : undefined;
}

function reconcileGraphLaneIdentity(root: string, configLane: any, stateLane: any): { configLane: any; stateLane: any; diagnostics: string[] } {
  const configObject = configLane === true ? { enabled: true } : configLane && typeof configLane === "object" ? { ...configLane } : {};
  const stateObject = stateLane === true ? { enabled: true } : stateLane && typeof stateLane === "object" ? { ...stateLane } : {};
  const diagnostics: string[] = [];
  const current = readGraphGenerationPointer(root, "current.json");
  const configuredCandidates = [configObject.graphPath, stateObject.graphPath, stateObject.path]
    .map(value => absoluteMaybe(root, firstString(value)))
    .filter((value): value is string => Boolean(value && existsSync(value)));
  const selectedGraphPath = current ? join(current.artifactPath, "graph.json") : configuredCandidates[0];
  if (!selectedGraphPath) return { configLane, stateLane, diagnostics };

  const selectedGeneration = current?.id ?? graphGenerationFromPath(root, selectedGraphPath);
  const recordedGeneration = firstString(stateObject.generationId, stateObject.artifactGeneration?.id);
  if (selectedGeneration && recordedGeneration !== selectedGeneration) diagnostics.push(`graph_generation_reconciled=${recordedGeneration ?? "missing"}->${selectedGeneration}`);
  if (configuredCandidates[0] && resolve(configuredCandidates[0]) !== resolve(selectedGraphPath)) diagnostics.push(`graph_path_reconciled=${configuredCandidates[0]}->${selectedGraphPath}`);

  configObject.graphPath = selectedGraphPath;
  stateObject.graphPath = selectedGraphPath;
  const manifestPath = join(dirname(selectedGraphPath), "manifest.json");
  if (existsSync(manifestPath)) {
    configObject.sourceManifestPath = manifestPath;
    stateObject.sourceManifestPath = manifestPath;
  }
  if (selectedGeneration) {
    stateObject.generationId = selectedGeneration;
    stateObject.artifactGeneration = current && current.id === selectedGeneration
      ? { ...(stateObject.artifactGeneration ?? {}), ...current }
      : { ...(stateObject.artifactGeneration ?? {}), id: selectedGeneration, artifactPath: dirname(selectedGraphPath) };
  }
  if (current?.desiredStateHash) stateObject.desiredStateHash = current.desiredStateHash;
  if (current?.rootIdentity) stateObject.rootIdentity = current.rootIdentity;
  if (current?.backendVersion) stateObject.backendIdentity = { ...(stateObject.backendIdentity ?? {}), version: current.backendVersion };
  return { configLane: configObject, stateLane: stateObject, diagnostics };
}

function envEnablesLane(env: Env, lane: NavigationLane): boolean {
  if (lane === "docs") return Boolean(env.PI_NAV_DOC_REPO?.trim());
  return false;
}

function normalizeLane(bundle: NavigationConfigBundle, lane: NavigationLane, configLane: any, stateLane: any, env: Env): Omit<PreparedLaneReady, "ok" | "lane" | "reason" | "configPath" | "statePath" | "diagnostics"> {
  const configObject = configLane && typeof configLane === "object" ? configLane : {};
  const stateObject = stateLane && typeof stateLane === "object" ? stateLane : {};
  const root = absoluteMaybe(bundle.root, firstString(configObject.root, stateObject.root)) ?? bundle.root;
  const graphPath = absoluteMaybe(bundle.root, firstString(configObject.graphPath, stateObject.graphPath, stateObject.path));
  const indexPath = absoluteMaybe(bundle.root, firstString(configObject.indexPath, stateObject.indexPath, stateObject.path));
  const cachePath = absoluteMaybe(bundle.root, firstString(configObject.cachePath, stateObject.cachePath));
  const docsQueryCommand = lane === "docs" ? firstString(configObject.queryCommand, stateObject.queryCommand, env.PI_NAV_DOC_QUERY_COMMAND) : undefined;
  return {
    backend: firstString(configObject.backend, stateObject.backend, defaultBackend(lane)),
    command: lane === "graph" ? ownedBackendRuntime("graphify")?.command : undefined,
    queryCommand: docsQueryCommand,
    queryTransport: lane === "docs" ? firstString(configObject.queryTransport, stateObject.queryTransport) : undefined,
    indexCommand: lane === "docs" ? firstString(configObject.indexCommand, stateObject.indexCommand) : undefined,
    repo: lane === "docs" ? firstString(configObject.repo, stateObject.repo, env.PI_NAV_DOC_REPO) : firstString(configObject.repo, stateObject.repo),
    root,
    graphPath,
    indexPath,
    cachePath,
    python: firstString(configObject.python, stateObject.python),
    glob: firstString(configObject.glob, stateObject.glob),
    indexedAt: firstString(stateObject.indexedAt, configObject.indexedAt),
    updatedAt: firstString(stateObject.updatedAt, stateObject.generatedAt, configObject.updatedAt),
    desiredStateHash: firstString(stateObject.desiredStateHash, configObject.desiredStateHash),
    rootIdentity: firstString(stateObject.rootIdentity, configObject.rootIdentity),
    generationId: firstString(stateObject.generationId, configObject.generationId),
    backendVersion: firstString(stateObject.backendIdentity?.version, configObject.backendIdentity?.version),
    schemaVersion: firstString(stateObject.backendIdentity?.schemaVersion, configObject.backendIdentity?.schemaVersion),
    embeddingProvider: firstString(configObject.embeddingProvider, stateObject.embeddingProvider),
    embeddingModel: firstString(configObject.embeddingModel, stateObject.embeddingModel),
    embeddingStatus: firstString(stateObject.embeddingStatus),
    embeddingReason: firstString(stateObject.embeddingReason),
    observedQuality: stateObject.observedQuality && typeof stateObject.observedQuality === "object" ? stateObject.observedQuality : undefined,
    graphMode: firstString(stateObject.mode, configObject.mode),
    graphProvider: firstString(stateObject.provider, configObject.provider),
    graphModel: firstString(stateObject.model, configObject.model),
    graphDeepExtractionObserved: typeof stateObject.deepExtractionObserved === "boolean" ? stateObject.deepExtractionObserved : undefined,
    graphSemanticExtractionObserved: typeof stateObject.semanticExtractionObserved === "boolean" ? stateObject.semanticExtractionObserved : undefined,
    refreshStatus: firstString(stateObject.refreshStatus, configObject.refreshStatus),
    lastProbeStatus: firstString(stateObject.lastProbeStatus, configObject.lastProbeStatus),
    lastProbeAt: firstString(stateObject.lastProbeAt, configObject.lastProbeAt),
    sourceFreshnessStatus: firstString(stateObject.sourceFreshnessStatus, configObject.sourceFreshnessStatus),
    sourceSnapshotIdentity: firstString(stateObject.sourceSnapshotIdentity, configObject.sourceSnapshotIdentity),
  };
}

function laneHealthProblem(lane: NavigationLane, configLane: any, stateLane: any): string | undefined {
  const configObject = configLane && typeof configLane === "object" ? configLane : {};
  const stateObject = stateLane && typeof stateLane === "object" ? stateLane : {};
  const qmdDocs = lane === "docs" && firstString(configObject.backend, stateObject.backend, "qmd") === "qmd";
  // A verified Graphify artifact remains queryable while automatic refresh is
  // pending or retrying. Refresh work is reported separately and must not turn
  // source drift or a backend retry into map unavailability.
  const status = firstString(configObject.status, stateObject.status);
  if (status && /^(error|failed|disabled)$/i.test(status)) return `lane marked unhealthy in navigation state/config: status=${status}`;
  const disabledAt = firstString(configObject.disabledAt, stateObject.disabledAt);
  if (disabledAt) return `lane disabled after failed setup at ${disabledAt}`;
  const lastError = firstString(configObject.lastError, stateObject.lastError);
  if (lastError) return `lane has unresolved setup error: ${lastError}`;
  return undefined;
}

export function graphManifestFreshnessProblem(root: string, state: any): string | undefined {
  const manifestValue = firstString(state?.sourceManifestPath);
  if (!manifestValue) return state?.mode === "richUpdate" ? "current rich generation lacks source-manifest freshness identity" : undefined;
  const manifestPath = absoluteMaybe(root, manifestValue);
  if (!manifestPath || !existsSync(manifestPath)) return "source manifest is missing";
  let manifest: Record<string, any>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return `source manifest is unreadable (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return "source manifest is structurally invalid";
  const resolvedRoot = resolve(root);
  for (const [relativePath, recorded] of Object.entries(manifest)) {
    const sourcePath = resolve(root, relativePath);
    if (!sourcePath.startsWith(`${resolvedRoot}/`) && sourcePath !== resolvedRoot) return `source manifest path escapes root (${relativePath})`;
    try {
      const currentMtime = statSync(sourcePath).mtimeMs / 1000;
      const recordedMtime = Number(recorded?.mtime);
      if (!Number.isFinite(recordedMtime) || Math.abs(currentMtime - recordedMtime) > 0.001) {
        const digest = createHash("md5").update(readFileSync(sourcePath)).digest("hex");
        if (digest !== recorded?.ast_hash && digest !== recorded?.semantic_hash) return `source changed after graph publication (${relativePath})`;
      }
    } catch {
      return `indexed source is missing (${relativePath})`;
    }
  }
  return undefined;
}

export function graphLaneMaintenanceProblems(root: string, state: any): string[] {
  const problems: string[] = [];
  const freshness = graphManifestFreshnessProblem(root, state);
  if (freshness) problems.push(freshness);
  const graphPath = absoluteMaybe(root, firstString(state?.graphPath, state?.path));
  const pathGeneration = graphPath ? graphGenerationFromPath(root, graphPath) : undefined;
  const recordedGeneration = firstString(state?.generationId, state?.artifactGeneration?.id);
  if (pathGeneration && recordedGeneration && pathGeneration !== recordedGeneration) problems.push(`graph generation identity mismatch (artifact=${pathGeneration}, state=${recordedGeneration})`);
  const current = readGraphGenerationPointer(root, "current.json");
  if (current && pathGeneration && current.id !== pathGeneration) problems.push(`published pointer differs from query artifact (current=${current.id}, artifact=${pathGeneration})`);
  return problems;
}

function nonNegativeNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
}

function stringArray(...values: unknown[]): string[] | undefined {
  for (const value of values) if (Array.isArray(value)) return value.map(String);
  return undefined;
}




function defaultBackend(lane: NavigationLane): string | undefined {
  if (lane === "docs") return "qmd";
  if (lane === "graph") return "Graphify";
  return undefined;
}

function firstString(...values: any[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function absoluteMaybe(root: string, value?: string): string | undefined {
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(root, value);
}




function readyReason(lane: NavigationLane, normalized: Omit<PreparedLaneReady, "ok" | "lane" | "reason" | "configPath" | "statePath" | "diagnostics">, bundle: NavigationConfigBundle): string {
  const source = bundle.statePath ? "config+state" : bundle.configPath ? "config" : "env";
  if (lane === "docs") return `${normalized.backend ?? "docs"} repo ${normalized.repo} (${source})`;
  if (lane === "graph") return `${normalized.backend ?? "graph"} graph ${normalized.graphPath} (${source})`;
  return `${normalized.backend ?? lane} enabled (${source})`;
}
