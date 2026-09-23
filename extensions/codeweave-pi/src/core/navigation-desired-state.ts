import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { NavigationAutomationConfig } from "./navigation-automation-config.ts";

export const NAVIGATION_DESIRED_STATE_VERSION = 1 as const;

export type PreparedLaneName = "docs" | "graph";
export type NavigationTriggerClass = "session_start" | "first_broad_request" | "manual_prepare" | "manual_freshen" | "stop_refresh" | "query";

export interface DesiredQuality {
  embeddings: "auto" | false;
  aiSummaries: boolean;
  mode?: string;
  provider?: string;
  model?: string;
}

export interface DesiredLaneState {
  enabled: boolean;
  root: string;
  rootRelative: string;
  scopeDigest: string;
  requested: DesiredQuality;
  effective: DesiredQuality;
  capability: "available" | "missing" | "incompatible";
  backend: string;
  backendVersion?: string;
  schemaVersion?: string;
  diagnostics: string[];
}

export interface NavigationDesiredState {
  version: typeof NAVIGATION_DESIRED_STATE_VERSION;
  canonicalRoot: string;
  rootIdentity: string;
  globalPolicyIdentity: string;
  projectOverrideIdentity: string;
  trigger: NavigationTriggerClass;
  lanes: Record<PreparedLaneName, DesiredLaneState>;
  desiredStateHash: string;
}

export interface CompileNavigationDesiredStateInput {
  root: string;
  automation: NavigationAutomationConfig;
  projectConfig?: any;
  projectState?: any;
  oneRun?: Partial<Record<PreparedLaneName, Partial<DesiredQuality>>>;
  trigger?: NavigationTriggerClass;
  backendIdentities?: Partial<Record<PreparedLaneName, { available: boolean; compatible?: boolean; version?: string; schemaVersion?: string }>>;
  providerAvailable?: Partial<Record<PreparedLaneName, boolean>>;
}

/** Pure, redacted policy compiler. Secrets and transient process identity never enter its hash. */
export function compileNavigationDesiredState(input: CompileNavigationDesiredStateInput): NavigationDesiredState {
  const canonicalRoot = canonicalPath(input.root);
  const projectConfig = object(input.projectConfig);
  const globalPolicy = redactedGlobalPolicy(input.automation);
  const globalPolicyIdentity = digest(stableStringify(globalPolicy));
  const projectOverrides = explicitProjectOverrides(projectConfig);
  const projectOverrideIdentity = digest(stableStringify(projectOverrides));

  const lanes = {
    docs: compileLane("docs", canonicalRoot, input, projectOverrides),
    graph: compileLane("graph", canonicalRoot, input, projectOverrides),
  } satisfies Record<PreparedLaneName, DesiredLaneState>;

  const rootIdentity = digest(canonicalRoot);
  const trigger = input.trigger ?? "manual_freshen";
  const hashLanes = Object.fromEntries(Object.entries(lanes).map(([name, lane]) => [name, {
    enabled: lane.enabled,
    root: lane.root,
    rootRelative: lane.rootRelative,
    scopeDigest: lane.scopeDigest,
    requested: lane.requested,
    backend: lane.backend,
  }]));
  const hashPayload = { version: NAVIGATION_DESIRED_STATE_VERSION, canonicalRoot, rootIdentity, globalPolicyIdentity, lanes: hashLanes };
  return { version: NAVIGATION_DESIRED_STATE_VERSION, canonicalRoot, rootIdentity, globalPolicyIdentity, projectOverrideIdentity, trigger, lanes, desiredStateHash: digest(stableStringify(hashPayload)) };
}

export function desiredLaneStateHash(desired: NavigationDesiredState, lane: PreparedLaneName): string {
  const value = desired.lanes[lane];
  return digest(stableStringify({
    version: desired.version,
    canonicalRoot: desired.canonicalRoot,
    rootIdentity: desired.rootIdentity,
    lane,
    desired: { enabled: value.enabled, root: value.root, rootRelative: value.rootRelative, scopeDigest: value.scopeDigest, requested: value.requested, backend: value.backend },
  }));
}

export function desiredStateMatches(recorded: any, desired: NavigationDesiredState): boolean {
  return recorded?.desiredStateHash === desired.desiredStateHash && recorded?.rootIdentity === desired.rootIdentity;
}


function compileLane(name: PreparedLaneName, canonicalRoot: string, input: CompileNavigationDesiredStateInput, overrides: any): DesiredLaneState {
  const project = object(overrides[name]);
  const globalLane = object(input.automation.backends?.[name]);
  const transient = object(input.oneRun?.[name]);
  const rootValue = string(project.root) ?? ".";
  const laneRoot = canonicalPath(isAbsolute(rootValue) ? rootValue : resolve(canonicalRoot, rootValue));
  const rootRelative = relative(canonicalRoot, laneRoot).replace(/\\/g, "/") || ".";
  const requested = requestedQuality(name, input.automation, globalLane, project);
  const effective = { ...requested, ...transient };
  const backendIdentity = input.backendIdentities?.[name];
  const available = backendIdentity?.available ?? false;
  const compatible = backendIdentity?.compatible !== false;
  const providerAvailable = input.providerAvailable?.[name] ?? !qualityNeedsProvider(effective);
  const diagnostics: string[] = [];
  if (!available) diagnostics.push(`${name}_backend_missing`);
  else if (!compatible) diagnostics.push(`${name}_backend_incompatible`);
  if (!providerAvailable && qualityNeedsProvider(effective)) diagnostics.push(`${name}_provider_missing`);
  const capability = !available ? "missing" : !compatible ? "incompatible" : "available";

  return {
    enabled: project.enabled === false ? false : project.enabled === true || Boolean(globalLane.primary),
    root: laneRoot,
    rootRelative,
    scopeDigest: digest(stableStringify({ root: laneRoot, include: project.refreshRoots ?? project.refreshFiles ?? project.scope ?? [] })),
    requested,
    effective,
    capability,
    backend: normalizeBackend(name, string(project.backend) ?? string(globalLane.primary) ?? defaultBackend(name)),
    backendVersion: backendIdentity?.version,
    schemaVersion: backendIdentity?.schemaVersion,
    diagnostics,
  };
}

function requestedQuality(name: PreparedLaneName, automation: NavigationAutomationConfig, globalLane: any, project: any): DesiredQuality {
  if (name === "docs") {
    const projectQuality = object(project.quality);
    const embeddingValue = firstDefined(projectQuality.embeddings, project.embeddings, globalLane.embeddings);
    return {
      embeddings: normalizeEmbeddings(embeddingValue, automation.providers.allowEmbeddings),
      aiSummaries: false,
      mode: string(project.mode) ?? string(globalLane.mode),
      provider: string(projectQuality.embeddingProvider) ?? string(project.embeddingProvider) ?? string(globalLane.embeddingProvider) ?? "auto",
    };
  }
  const configuredMode = string(project.mode) ?? string(globalLane.mode) ?? "update";
  const mode = configuredMode === "deep" || configuredMode === "deep-extract" ? "deepExtract" : configuredMode === "rich" || configuredMode === "rich-update" ? "richUpdate" : configuredMode;
  return {
    embeddings: false,
    aiSummaries: /deep|rich/i.test(mode),
    mode,
    provider: string(project.provider) ?? string(globalLane.provider),
    model: string(project.model) ?? string(globalLane.model),
  };
}

function normalizeBackend(lane: PreparedLaneName, value: string): string {
  const normalized = value.toLowerCase();
  if (lane === "docs" && normalized === "qmd") return "qmd";
  if (lane === "graph" && normalized === "graphify") return "graphify";
  return normalized;
}

function explicitProjectOverrides(config: any): any {
  return {
    docs: object(config.docs),
    graph: object(config.graph),
  };
}

function redactedGlobalPolicy(config: NavigationAutomationConfig): any {
  return {
    version: config.version,
    automation: config.automation,
    installs: config.installs,
    providers: {
      allowCloud: config.providers.allowCloud,
      allowed: [...config.providers.allowed].sort(),
      defaultEmbeddingProvider: config.providers.defaultEmbeddingProvider,
      secondaryEmbeddingProvider: config.providers.secondaryEmbeddingProvider,
      defaultLLMProvider: config.providers.defaultLLMProvider,
      allowEmbeddings: config.providers.allowEmbeddings,
      allowLLM: config.providers.allowLLM,
      allowLocalModelDownloads: config.providers.allowLocalModelDownloads,
    },
    storage: config.storage,
    scoping: config.scoping,
    backends: config.backends,
  };
}

function qualityNeedsProvider(quality: DesiredQuality): boolean {
  return quality.embeddings === "auto" || quality.aiSummaries;
}

function normalizeEmbeddings(value: unknown, allowed: boolean): "auto" | false {
  if (value === false || value === "false" || value === "off" || value === "none" || value === 0) return false;
  if (value === true || value === "true" || value === "on" || value === "auto" || value === "if-provider-allowed") return allowed ? "auto" : false;
  return allowed ? "auto" : false;
}

function normalizeBoolean(value: unknown, allowed: boolean): boolean {
  if (value === false || value === "false" || value === "off" || value === "none" || value === 0) return false;
  if (value === true || value === "true" || value === "on" || value === "auto" || value === 1) return allowed;
  return false;
}

function canonicalPath(value: string): string {
  const absolute = resolve(value);
  try { return realpathSync(absolute); } catch { return absolute; }
}

function defaultBackend(name: PreparedLaneName): string {
  return name === "docs" ? "qmd" : "Graphify";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as any).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as any)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function object(value: any): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find(value => value !== undefined);
}
