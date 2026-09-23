import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { automationPolicyInput, type NavigationAutomationConfig } from "./navigation-automation-config.ts";
import { backendCapability, decideAutomationPolicy, type BackendCapability, type BackendPrepareMode, type NavigationBackendId, type SetupPolicy } from "./backend-registry.ts";
import type { NavigationPreflightReport } from "./navigation-preflight.ts";
import { planNavigationScope, type ProjectScopeOverride, type ScopePlan } from "./scope-planner.ts";
import { planGraphifyScope } from "./graphify-scope-policy.ts";
import { decideProviderPolicy } from "./provider-registry.ts";

export type SetupActionPolicy = "auto" | "guided" | "blocked";
export type SetupTrigger = "session_start" | "first_broad_request" | "manual_prepare" | "stop_refresh";

export interface NavigationSetupPlannerOptions {
  query?: string;
  trigger?: SetupTrigger;
  fullStack?: boolean;
  startupSafe?: boolean;
  env?: Record<string, string | undefined>;
  requestedBackends?: NavigationBackendId[];
  installedBackends?: Partial<Record<NavigationBackendId, boolean>>;
  projectScope?: ProjectScopeOverride;
  allowAutoPrepare?: boolean;
  disabledBackends?: NavigationBackendId[];
  graphifyBin?: string;
  docsMaxFiles?: number | "all";
}

export interface NavigationSetupAction {
  backend: NavigationBackendId;
  lane: string;
  modeName: string;
  policy: SetupActionPolicy;
  setupPolicy: SetupPolicy;
  command?: string[];
  backendCommand?: string[];
  writes: string[];
  qualityGates: string[];
  undo: string[];
  evidence: string[];
  reason: string;
  reasons: string[];
  scope?: string;
  providers?: string[];
  installed?: boolean;
}

export interface NavigationSetupPlan {
  root: string;
  trigger: SetupTrigger;
  policy: SetupActionPolicy;
  scopePlan: ScopePlan;
  actions: NavigationSetupAction[];
  summary: {
    automatic: number;
    guided: number;
    blocked: number;
  };
  nextMessages: string[];
  confirmationPrompt: string;
}

export function planNavigationSetup(preflight: NavigationPreflightReport, config: NavigationAutomationConfig, options: NavigationSetupPlannerOptions = {}): NavigationSetupPlan {
  const trigger = options.trigger ?? "manual_prepare";
  const scopePlan = planNavigationScope(preflight, { query: options.query, projectScope: options.projectScope, config });
  const requested = options.requestedBackends ?? ["qmd", "graphify"];
  const actions = requested.map(backend => planBackendAction(backend, preflight, config, scopePlan, options));
  const summary = {
    automatic: actions.filter(action => action.policy === "auto").length,
    guided: actions.filter(action => action.policy === "guided").length,
    blocked: actions.filter(action => action.policy === "blocked").length,
  };
  const policy: SetupActionPolicy = summary.blocked > 0 ? summary.automatic > 0 || summary.guided > 0 ? "guided" : "blocked" : summary.guided > 0 ? "guided" : "auto";
  return {
    root: preflight.root,
    trigger,
    policy,
    scopePlan,
    actions,
    summary,
    nextMessages: nextMessages(actions, scopePlan),
    confirmationPrompt: confirmationPrompt(preflight.root, actions, scopePlan),
  };
}

/** Prepared backend to the existing machine lane key that owns its policy. */
const MACHINE_LANE: Record<NavigationBackendId, string> = { qmd: "docs", graphify: "graph" };

/** Machine-level lane policy from the navigation config, which is where prepared
 * lanes are opt-in. `false`/`enabled:false` is a prohibition for this lane;
 * `autoPrepare:false` withdraws only automation. Absent keys impose nothing. The
 * `architecture` lane keeps its own consent for Core code maintenance and is not
 * consulted here because no prepared backend owns it. */
function machineLanePolicy(config: NavigationAutomationConfig, backendId: NavigationBackendId): "off" | "manual" | undefined {
  const lane = config.backends?.[MACHINE_LANE[backendId]];
  if (lane === false || lane?.enabled === false) return "off";
  return lane?.autoPrepare === false ? "manual" : undefined;
}

function planBackendAction(backendId: NavigationBackendId, preflight: NavigationPreflightReport, config: NavigationAutomationConfig, scopePlan: ScopePlan, options: NavigationSetupPlannerOptions): NavigationSetupAction {
  const capability = backendCapability(backendId);
  const modeName = selectModeName(capability, config, options.fullStack, options.startupSafe, options.trigger === "first_broad_request", options.trigger === "stop_refresh");
  const mode = capability.prepareModes[modeName] ?? capability.prepareModes[capability.defaults.recommendedMode];
  const backendDecision = decideAutomationPolicy(capability, modeName, automationPolicyInput(config));
  const reasons = [...backendDecision.reasons];
  const installed = options.installedBackends?.[backendId];
  if (installed === false) reasons.push(`${capability.name} is not installed; package preparation must complete before project setup can use it`);
  if (options.allowAutoPrepare === false) reasons.push("project automation disables automatic prepare");
  if (options.disabledBackends?.includes(backendId)) reasons.push(`${capability.name} automatic prepare is disabled by project config`);
  // Machine policy is decided before the lane action is built: an owned graph
  // artifact or an inferred scope must not re-enable a lane the config withdrew.
  const machinePolicy = machineLanePolicy(config, backendId);
  if (machinePolicy === "off") reasons.unshift(`${capability.name} is disabled by machine navigation config: backends.${MACHINE_LANE[backendId]} is false or enabled: false`);
  else if (machinePolicy === "manual") reasons.unshift(`${capability.name} automatic prepare is disabled by machine navigation config: backends.${MACHINE_LANE[backendId]}.autoPrepare is false`);
  const setupPolicy: SetupPolicy = machinePolicy === "off" ? "never_auto" : backendDecision.policy;

  // Startup-safe means UI-safe/background. QMD embedding is bounded lifecycle
  // work; Graphify provider-backed extraction remains deferred from startup.
  if (options.startupSafe && mode.usesLLM && backendId !== "qmd") {
    reasons.push(`startup-safe: ${capability.name} ${modeName} is deferred (LLM work needs guided/manual or non-startup prepare)`);
  }

  if (capability.defaults.requiresScopePreflight) {
    if (scopePlan.mode === "blocked") reasons.push(scopePlan.reason);
    else if (scopePlan.mode === "guided" && backendId !== "qmd") reasons.push(scopePlan.reason);
  }

  if (backendId === "graphify") return graphifyAction(capability, modeName, mode, preflight, config, scopePlan, options, setupPolicy, reasons, installed);
  if (backendId === "qmd") return docsAction(capability, modeName, mode, preflight, config, scopePlan, options, setupPolicy, reasons, installed);
  throw new Error(`unsupported prepared backend: ${backendId}`);
}
function graphifyAction(capability: BackendCapability, modeName: string, mode: BackendPrepareMode, preflight: NavigationPreflightReport, config: NavigationAutomationConfig, scopePlan: ScopePlan, options: NavigationSetupPlannerOptions, setupPolicy: SetupPolicy, reasons: string[], installed: boolean | undefined): NavigationSetupAction {
  const graphify = planGraphifyScope(preflight, scopePlan, { mode: modeName === "update" ? "update" : "deepExtract", graphifyBin: options.graphifyBin, config, provider: config.backends.graph?.provider ?? config.providers.defaultLLMProvider, env: options.env });
  reasons.push(...graphify.blockers, ...graphify.warnings);
  if ((isLifecycleTrigger(options.trigger) || options.startupSafe) && (modeName === "update" || modeName === "richUpdate") && !hasExistingGraphifyArtifact(preflight.root)) {
    reasons.unshift("Graphify lifecycle refresh requires an existing owned graph artifact; fresh folders should leave Graphify unavailable until explicit/manual graph setup");
  }
  const command = ["node", "scripts/navigation-freshen.mjs", "graph", "--path", preflight.root];
  command.push("--graphify-mode", modeName === "deepExtract" ? "deep" : modeName === "richUpdate" ? "rich-update" : "update");
  if (graphify.scope && graphify.scope !== ".") command.push("--scope", graphify.scope);
  if (options.graphifyBin) command.push("--graphify-bin", options.graphifyBin);
  if ((modeName === "deepExtract" || modeName === "richUpdate") && graphify.provider) command.push("--graphify-provider", graphify.provider);
  const modelIndex = graphify.command?.indexOf("--model") ?? -1;
  const graphifyModel = modelIndex >= 0 ? graphify.command?.[modelIndex + 1] : undefined;
  if ((modeName === "deepExtract" || modeName === "richUpdate") && graphifyModel) command.push("--graphify-model", graphifyModel);
  const graphOut = ".pi/navigation/graphify/graphify-out";
  const writes = [`${graphOut}/graph.json`, `${graphOut}/GRAPH_REPORT.md`, `${graphOut}/graph.html`, ".pi-navigation.json lane updates", ".pi/navigation/state.json"];
  const backendCommand = modeName === "richUpdate" ? ["python", "scripts/graphify-rich-update.py", preflight.root, graphify.scope || ".", ".pi/navigation/graphify", graphify.provider ?? "<provider>", graphifyModel ?? "<model>", "0"] : graphify.command;
  return action({ capability, modeName, mode, setupPolicy, command, backendCommand, writes, reasons, scope: graphify.scope, providers: graphify.provider ? [graphify.provider] : [], installed });
}

function hasExistingGraphifyArtifact(root: string): boolean {
  return existsSync(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"))
    || existsSync(join(root, "graphify-out", "graph.json"));
}

function docsAction(capability: BackendCapability, modeName: string, mode: BackendPrepareMode, preflight: NavigationPreflightReport, config: NavigationAutomationConfig, scopePlan: ScopePlan, options: NavigationSetupPlannerOptions, setupPolicy: SetupPolicy, reasons: string[], installed: boolean | undefined): NavigationSetupAction {
  const providers: string[] = [];
  const command = ["node", "scripts/navigation-freshen.mjs", "docs", "--path", preflight.root];
  let effectiveModeName = modeName;
  let effectiveMode = mode;
  let effectiveReasons = [...reasons];
  if (options.trigger) command.push("--trigger", options.trigger);
  const configuredProvider = projectDocsProvider(preflight.root) ?? String(config.backends.docs?.embeddingProvider ?? "auto").toLowerCase();
  if (mode.usesEmbeddings) {
    const zeroEntropy = decideProviderPolicy({ config, provider: "zeroentropy", capability: "embedding", env: options.env });
    const voyage = decideProviderPolicy({ config, provider: "voyage", capability: "embedding", env: options.env });
    const openrouter = decideProviderPolicy({ config, provider: "openrouter", capability: "embedding", env: options.env });
    const localAllowed = config.providers.allowEmbeddings;
    if (configuredProvider === "local" && localAllowed) {
      providers.push("local");
      command.push("--docs-provider", "local");
      effectiveReasons.push("QMD local inference uses the embedding and reranker models installed with codeweave-pi");
    } else if (configuredProvider === "zeroentropy" && zeroEntropy.policy === "allowed") {
      providers.push("zeroentropy");
      command.push("--docs-provider", "zeroentropy");
    } else if (configuredProvider === "voyage" && voyage.policy === "allowed") {
      providers.push("voyage");
      command.push("--docs-provider", "voyage");
    } else if (configuredProvider === "openrouter" && openrouter.policy === "allowed") {
      providers.push("openrouter");
      command.push("--docs-provider", "openrouter");
    } else if (configuredProvider === "auto" && zeroEntropy.policy === "allowed") {
      providers.push("zeroentropy");
    } else if (configuredProvider === "auto" && voyage.policy === "allowed") {
      providers.push("voyage");
    } else if (configuredProvider === "auto" && localAllowed) {
      providers.push("local");
      command.push("--docs-provider", "local");
      effectiveReasons.push("QMD defaults to installed local embedding and reranker models when no configured API credential is available");
    } else if (isLifecycleTrigger(options.trigger)) {
      effectiveModeName = "lexicalDocs";
      effectiveMode = capability.prepareModes.lexicalDocs;
      effectiveReasons = effectiveReasons.filter(reason => !reason.includes(`${capability.id}:${modeName}`));
      effectiveReasons.push("QMD lifecycle stays lexical because local embeddings are disabled and no allowed API credential is configured");
    } else {
      effectiveReasons.push(...(configuredProvider === "local" ? ["QMD local inference needs providers.allow_embeddings"] : configuredProvider === "openrouter" ? openrouter.reasons : [...zeroEntropy.reasons, ...voyage.reasons]));
    }
  }
  const docsScope = selectDocsPrepareScope(preflight, scopePlan, options.projectScope);
  if (!docsScope) effectiveReasons.push("QMD automatic prepare needs one concrete Markdown scope");
  if (effectiveModeName === "lexicalDocs") command.push("--use-embeddings", "false");
  if (docsScope && docsScope !== ".") command.push("--scope", docsScope);
  const docsReasons = effectiveModeName === "lexicalDocs" && docsScope ? effectiveReasons.filter(reason => !/monorepo scope is ambiguous|monorepo policy requires choosing a package scope/i.test(reason)) : effectiveReasons;
  return action({ capability, modeName: effectiveModeName, mode: effectiveMode, setupPolicy, command, backendCommand: [...command], writes: effectiveMode.writes, reasons: docsReasons, scope: docsScope ?? preflight.root, providers, installed });
}

function projectDocsProvider(root: string): string | undefined {
  try {
    const config = JSON.parse(readFileSync(join(root, ".pi-navigation.json"), "utf8"));
    const provider = String(config?.docs?.embeddingProvider ?? config?.docs?.embedding_provider ?? "").trim().toLowerCase();
    return ["auto", "local", "zeroentropy", "voyage", "openrouter", "lexical"].includes(provider) ? provider : undefined;
  } catch {
    return undefined;
  }
}

function selectDocsPrepareScope(preflight: NavigationPreflightReport, scopePlan: ScopePlan, projectScope?: { include?: string[]; exclude?: string[] }): string | undefined {
  const selected = scopePlan.selectedScopes.length === 1 ? scopePlan.selectedScopes[0] : undefined;
  const explicitOutsideOverride = /outside project scope override/.test(scopePlan.reason);
  if (explicitOutsideOverride && selected && selected !== ".") return selected;
  const configured = projectScope?.include?.filter(scope => typeof scope === "string" && scope.trim());
  if (configured?.length === 1 && configured[0] !== ".") return configured[0];
  const docRoots = preflight.docs.likelyRoots;
  if (!docRoots.length) return explicitOutsideOverride ? selected : undefined;
  if (docRoots.some(isRootDocsFileScope)) return ".";

  if (docRoots.includes("docs")) return "docs";
  if (docRoots.includes("doc")) return "doc";
  const directoryRoot = docRoots.find(scope => !isDocsFileScope(scope));
  if (directoryRoot) return directoryRoot;

  return docRoots.some(isDocsFileScope) ? "." : undefined;
}

function isDocsFileScope(scope: string): boolean {
  return /\.(md|mdx|markdown|txt|rst)$/i.test(scope);
}

function isRootDocsFileScope(scope: string): boolean {
  return !scope.includes("/") && isDocsFileScope(scope);
}


function action(input: { capability: BackendCapability; modeName: string; mode: BackendPrepareMode; setupPolicy: SetupPolicy; command?: string[]; backendCommand?: string[]; writes: string[]; reasons: string[]; scope?: string; providers?: string[]; installed?: boolean | undefined }): NavigationSetupAction {
  const policy = classifyPolicy(input.setupPolicy, input.reasons);
  return {
    backend: input.capability.id,
    lane: input.capability.lane,
    modeName: input.modeName,
    policy,
    setupPolicy: input.setupPolicy,
    command: policy === "blocked" ? undefined : input.command,
    backendCommand: policy === "blocked" ? undefined : input.backendCommand,
    writes: input.writes,
    qualityGates: input.mode.qualityGates,
    undo: input.capability.undo,
    evidence: [...input.capability.evidence.docs, ...input.capability.evidence.commandHelp, ...input.capability.evidence.smokeLogs],
    reason: input.reasons[0] ?? `${input.capability.id}:${input.modeName} can be prepared`,
    reasons: input.reasons,
    scope: input.scope,
    providers: input.providers,
    installed: input.installed,
  };
}

function classifyPolicy(setupPolicy: SetupPolicy, reasons: string[]): SetupActionPolicy {
  if (setupPolicy === "never_auto") return "blocked";
  if (reasons.some(reason => /invalid config|Existing \.pi-navigation\.json is invalid|blocked by/i.test(reason))) return "blocked";
  if (reasons.some(reason => /requires one concrete scope|not installed|not listed|does not support/i.test(reason))) return "guided";
  if (setupPolicy === "ask_first" && reasons.length > 0) return "guided";
  if (reasons.some(reason => /startup-safe|deferred|needs?|requires|missing|not configured|confirmation-worthy|ambiguous|outside project scope override|no project root|provisional|disables automatic prepare|automatic prepare is disabled|needs global allow|providers\.allow|allow[A-Z][A-Za-z]+ is false/i.test(reason))) return "guided";
  return "auto";
}


function selectModeName(capability: BackendCapability, config: NavigationAutomationConfig, fullStack = false, startupSafe = false, firstBroad = false, stopRefresh = false): string {
  const aggressive = fullStack || config.automation.mode === "aggressive";
  const lifecycle = startupSafe || firstBroad || stopRefresh;
  if (capability.id === "qmd" && lifecycle) return lifecycleDocsMode(config);
  if (capability.id === "graphify") {
    const configured = graphifyConfiguredMode(config, capability, aggressive);
    if (startupSafe || firstBroad) return "update";
    if (stopRefresh) return config.automation.autoRefreshOnStop === "aggressive" && configured === "deepExtract" ? "richUpdate" : "update";
    return configured;
  }
  return capability.defaults.recommendedMode;
}

function isLifecycleTrigger(trigger: NavigationSetupPlannerOptions["trigger"]): boolean {
  return trigger === "session_start" || trigger === "first_broad_request" || trigger === "stop_refresh";
}

function graphifyConfiguredMode(config: NavigationAutomationConfig, capability: BackendCapability, aggressive: boolean): string {
  const raw = aggressive && config.backends.graph?.deepMode ? String(config.backends.graph.deepMode) : String(config.backends.graph?.mode ?? capability.defaults.recommendedMode);
  if (/^(deep|deepextract|preferred-if-provider-allowed)$/i.test(raw)) return "deepExtract";
  if (/^(update|local|local-update)$/i.test(raw)) return "update";
  return capability.defaults.recommendedMode;
}

function lifecycleDocsMode(config: NavigationAutomationConfig): string {
  const docs = config.backends.docs ?? {};
  const requested = String(docs.mode ?? "");
  if (requested === "lexicalDocs" || docs.embeddings === false || docs.embeddings === "false") return "lexicalDocs";
  return config.providers.allowEmbeddings && (config.providers.allowCloud || config.providers.allowLocalModelDownloads) ? "hybridDocs" : "lexicalDocs";
}

function substitute(command: string[], root: string, scopes: string[]): string[] {
  return command.flatMap(part => {
    if (part === "<root>") return [root];
    if (part === "<scope>") return [scopes[0] ?? "."];
    if (part === "<scopes>") return scopes.length ? scopes : ["."];
    return [part];
  });
}


function nextMessages(actions: NavigationSetupAction[], scopePlan: ScopePlan): string[] {
  const messages: string[] = [];
  if (scopePlan.mode !== "auto") messages.push(`Scope needs attention: ${scopePlan.reason}`);
  const automatic = actions.filter(action => action.policy === "auto");
  const guided = actions.filter(action => action.policy === "guided");
  const blocked = actions.filter(action => action.policy === "blocked");
  if (automatic.length) messages.push(`Can run automatically: ${automatic.map(action => `${action.backend}:${action.modeName}`).join(", ")}`);
  if (guided.length) messages.push(`Guided by policy: ${guided.map(action => `${action.backend}:${action.modeName}`).join(", ")}`);
  if (blocked.length) messages.push(`Needs attention: ${blocked.map(action => `${action.backend}:${action.modeName}`).join(", ")}`);
  return messages;
}

function confirmationPrompt(root: string, actions: NavigationSetupAction[], scopePlan: ScopePlan): string {
  const runnable = actions.filter(action => action.policy !== "blocked");
  const considered = runnable.length ? runnable : actions;
  const writes = unique(considered.flatMap(action => action.writes)).slice(0, 8);
  const gates = unique(considered.flatMap(action => action.qualityGates)).slice(0, 8);
  const undo = unique(considered.flatMap(action => action.undo)).slice(0, 6);
  const providers = unique(considered.flatMap(action => action.providers ?? []).filter(Boolean));
  const riskReasons = unique(considered.flatMap(action => action.reasons).filter(reason => /network|provider|cloud|embedding|model|LLM|install/i.test(reason))).slice(0, 4);
  const selected = scopePlan.selectedScopes.length ? scopePlan.selectedScopes.join(", ") : ".";
  return [
    "Confirm navigation setup before anything is written.",
    `Scope: root ${root}; selected ${selected}; scope decision ${scopePlan.mode} (${scopePlan.reason}).`,
    `Expected writes: ${writes.length ? writes.join("; ") : "no project writes declared for selected actions"}.`,
    `Audit log: ${join(root, ".pi", "navigation-setup.log.jsonl")}.`,
    `Provider/model/network risk: ${providers.length ? `providers ${providers.join(", ")}; ` : ""}${riskReasons.length ? riskReasons.join("; ") : "no provider/model/network risk declared by selected actions"}.`,
    `Quality gates: ${gates.length ? gates.join("; ") : "no gates declared"}.`,
    `Undo/retry: ${undo.length ? undo.join("; ") : "disable prepared lanes or remove declared writes"}; retry dry-run with nav:prepare -- --path ${JSON.stringify(root)} --dry-run --json.`,
  ].join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
