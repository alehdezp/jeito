import { extensionRuntimePaths, ownedBackendRuntime } from "./owned-runtime.ts";

export type NavigationBackendId = "qmd" | "graphify";
export type NavigationBackendLane = "docs" | "graph";
export type SetupPolicy = "safe_auto" | "auto_logged" | "ask_first" | "never_auto";
export type EvidenceStatus = "verified" | "provisional";
export type RuntimeClass = "fast" | "medium" | "slow" | "unknown";
export type PreferredIndexLocation = "target" | "global-cache" | "configurable";
export type IndexKind = "code" | "docs" | "config" | "mixed";

export interface BackendEvidence { docs: string[]; commandHelp: string[]; smokeLogs: string[]; lastVerifiedAt: string; status: EvidenceStatus; gaps?: string[]; }
export interface BackendInstallCapability { commands: string[]; writesGlobal: string[]; writesProject: string[]; networkRequired: boolean; modelDownloads: boolean; cloudPossible: boolean; defaultPolicy: SetupPolicy; notes: string[]; }
export interface BackendPrepareMode { command: string[]; writes: string[]; indexes: IndexKind; localOnly: boolean; usesLLM: boolean; usesEmbeddings: boolean; providers: string[]; deterministic: boolean; defaultScopes: string[]; expectedRuntimeClass: RuntimeClass; defaultPolicy: SetupPolicy; qualityGates: string[]; notes: string[]; }
export interface BackendDefaults { recommendedMode: string; autoWhenGloballyAllowed: boolean; requiresScopePreflight: boolean; preferredIndexLocation: PreferredIndexLocation; }
export interface BackendCapability { id: NavigationBackendId; name: string; lane: NavigationBackendLane; userPurpose: string; evidence: BackendEvidence; install: BackendInstallCapability; prepareModes: Record<string, BackendPrepareMode>; defaults: BackendDefaults; undo: string[]; }
export interface AutomationPolicyInput { allowNetworkInstalls?: boolean; allowCloud?: boolean; allowEmbeddings?: boolean; allowLLM?: boolean; allowLocalModelDownloads?: boolean; allowVisibleProjectDirs?: boolean; allowUnverifiedBackends?: boolean; }
export interface AutomationDecision { policy: SetupPolicy; reasons: string[]; }

// Runtime installation is owned by scripts/navigation-provision.mjs. Runtime consumers
// resolve only the atomically published state and never inspect PATH or a user venv.
export function ownedBackendRoot(): string {
  return extensionRuntimePaths().root;
}

export function ownedGraphifyDir(): string {
  return ownedBackendRuntime("graphify")?.root ?? "";
}
export function ownedGraphifyBin(): string {
  return ownedBackendRuntime("graphify")?.command ?? "";
}
export function ownedGraphifyBinIfPresent(): string | undefined {
  return ownedBackendRuntime("graphify")?.command;
}
export const GRAPHIFY_PIN = "0.9.23";
export const GRAPHIFY_EXTRAS = "openai";

export function graphifyInstallCommands(): string[] {
  return ["npm run nav:provision:legacy"];
}
export function graphifyReinstallCommand(): string {
  return "Stop Pi, run npm run nav:provision:legacy from the installed jeito-codeweave-pi clone, then restart Pi.";
}
export const BACKEND_CAPABILITIES: Record<NavigationBackendId, BackendCapability> = {
  qmd: {
    id: "qmd",
    name: "QMD Markdown Sections",
    lane: "docs",
    userPurpose: "Local Markdown-section FTS/vector retrieval with compact current pi-nav selector handoffs.",
    evidence: {
      docs: ["docs/evidence.md", "native/qmd/UPSTREAM.md"],
      commandHelp: ["packaged QMD runtime; lifecycle-owned section projection through pi-nav"],
      smokeLogs: ["focused pi-nav section projection, QMD lexical/vector/rerank, stale-selector, and incremental refresh tests"],
      lastVerifiedAt: "2026-07-17",
      status: "verified",
      gaps: ["Local semantic setup downloads the packaged QMD embedding and reranker models after explicit approval; ZeroEntropy, Voyage, and OpenRouter remain the external options."],
    },
    install: { commands: [], writesGlobal: [], writesProject: [".pi/navigation/qmd/*.sqlite", ".pi/navigation/state.json"], networkRequired: false, modelDownloads: false, cloudPossible: true, defaultPolicy: "auto_logged", notes: ["The owned QMD runtime and node-llama-cpp platform package install with codeweave-pi; no global QMD command is used.", "GGUF models are lifecycle downloads, never package-install or query-time downloads."] },
    prepareModes: {
      hybridDocs: { command: ["node", "scripts/navigation-freshen.mjs", "docs", "--path", "<root>"], writes: [".pi/navigation/qmd/*.sqlite", ".pi/navigation/state.json", ".pi-navigation.json docs lane", "~/.cache/qmd/models (local choice only)"], indexes: "docs", localOnly: false, usesLLM: false, usesEmbeddings: true, providers: ["local", "zeroentropy", "voyage", "openrouter"], deterministic: false, defaultScopes: ["**/*.md"], expectedRuntimeClass: "medium", defaultPolicy: "auto_logged", qualityGates: ["pi-nav section projection succeeds", "FTS probe succeeds", "all current changed section hashes have vectors", "configured local or cloud reranker probe succeeds", "current selector resolves through read"], notes: ["Local is the credential-free recommendation (~928 MiB for the two models codeweave-pi uses); ZeroEntropy, Voyage, and OpenRouter are external options. QMD stores section documents/vectors; current bytes and hierarchy remain pi-nav/read authority."] },
      lexicalDocs: { command: ["node", "scripts/navigation-freshen.mjs", "docs", "--path", "<root>"], writes: [".pi/navigation/qmd/*.sqlite", ".pi/navigation/state.json", ".pi-navigation.json docs lane"], indexes: "docs", localOnly: true, usesLLM: false, usesEmbeddings: false, providers: [], deterministic: true, defaultScopes: ["**/*.md"], expectedRuntimeClass: "fast", defaultPolicy: "auto_logged", qualityGates: ["pi-nav section projection succeeds", "FTS probe succeeds", "current selector resolves through read"], notes: ["Credential-free lexical mode remains available when semantic setup has not been approved."] },
    },
    defaults: { recommendedMode: "hybridDocs", autoWhenGloballyAllowed: true, requiresScopePreflight: true, preferredIndexLocation: "target" },
    undo: ["Set docs.enabled=false in .pi-navigation.json", "Remove setup-owned .pi/navigation/qmd only after confirming ownership"],
  },
  graphify: {
    id: "graphify",
    name: "Graphify",
    lane: "graph",
    userPurpose: "Graph-native map/concept/path/explain relationships, communities, hubs, provenance/confidence, and report context.",
    evidence: { docs: ["docs/upstream/graphify-official-docs-digest.md", "docs/evidence.md"], commandHelp: ["graphify query/path/explain over existing graph; extract/update/setup are mutating"], smokeLogs: [], lastVerifiedAt: "2026-06-22", status: "verified", gaps: ["Graphify affected needs more targeted probes."] },
    install: { commands: graphifyInstallCommands(), writesGlobal: ["<installed-extension>/.runtime"], writesProject: [".pi/navigation/graphify/graphify-out/**"], networkRequired: true, modelDownloads: false, cloudPossible: true, defaultPolicy: "ask_first", notes: ["npm postinstall installs graphifyy[openai]==0.9.23 into one extension-local virtualenv.", "Every invocation uses the extension-relative verified executable; PATH, GRAPHIFY_BIN, and user-installed Graphify are ignored.", "The [openai] extra is required by scripts/graphify-rich-update.py.", "Query/path/explain set GRAPHIFY_QUERY_LOG_DISABLE=1."] },
    prepareModes: {
      deepExtract: { command: ["graphify", "extract", "<scope>", "--mode", "deep", "--backend", "<provider>", "--out", ".pi/navigation/graphify"], writes: [".pi/navigation/graphify/graphify-out/graph.json", ".pi/navigation/graphify/graphify-out/GRAPH_REPORT.md", ".pi/navigation/state.json", "setup-owned .graphifyignore material when needed"], indexes: "mixed", localOnly: false, usesLLM: true, usesEmbeddings: false, providers: ["deepseek", "openai", "minimax", "gemini", "anthropic", "ollama", "kimi"], deterministic: false, defaultScopes: ["first-party source/docs"], expectedRuntimeClass: "slow", defaultPolicy: "auto_logged", qualityGates: ["provider policy satisfied", "graph.json exists", "report generated", "query/path/explain verify with query log disabled"], notes: ["Full rich build for initial setup or strict repair when no usable owned graph can be updated."] },
      richUpdate: { command: ["node", "scripts/navigation-freshen.mjs", "graph", "--path", "<root>", "--graphify-mode", "rich-update", "--graphify-provider", "<provider>"], writes: [".pi/navigation/graphify/graphify-out/graph.json", ".pi/navigation/graphify/graphify-out/manifest.json", ".pi/navigation/state.json", "setup-owned .graphifyignore material when needed"], indexes: "mixed", localOnly: false, usesLLM: true, usesEmbeddings: false, providers: ["deepseek", "openai", "minimax", "gemini", "anthropic", "ollama", "kimi"], deterministic: false, defaultScopes: ["same scoped graph root as existing graph"], expectedRuntimeClass: "medium", defaultPolicy: "auto_logged", qualityGates: ["existing owned graph exists unless strict repair is needed", "provider policy satisfied", "detect_incremental identifies changed files", "semantic extraction runs only for changed non-code files", "build_merge preserves unchanged source files", "query verifies"], notes: ["Provider-backed incremental refresh: changed code uses AST only; changed docs/papers/images use LLM semantic extraction with deep_mode; unchanged graph content is preserved."] },
      update: { command: ["graphify", "update", "<scope>", "--out", ".pi/navigation/graphify"], writes: [".pi/navigation/graphify/graphify-out/graph.json", ".pi/navigation/state.json"], indexes: "code", localOnly: true, usesLLM: false, usesEmbeddings: false, providers: [], deterministic: true, defaultScopes: ["clear first-party code scope"], expectedRuntimeClass: "medium", defaultPolicy: "auto_logged", qualityGates: ["graph.json exists", "query verifies"], notes: ["Local baseline when deep extraction policy is not available."] },
    },
    defaults: { recommendedMode: "deepExtract", autoWhenGloballyAllowed: true, requiresScopePreflight: true, preferredIndexLocation: "configurable" },
    undo: ["Set graph.enabled=false in .pi-navigation.json", "Remove .pi/navigation/graphify if setup-owned"],
  },
};

export function listBackendCapabilities(): BackendCapability[] { return Object.values(BACKEND_CAPABILITIES); }
export function backendCapability(id: NavigationBackendId): BackendCapability { return BACKEND_CAPABILITIES[id]; }
export function recommendedPrepareMode(capability: BackendCapability): BackendPrepareMode {
  const mode = capability.prepareModes[capability.defaults.recommendedMode];
  if (!mode) throw new Error(`backend ${capability.id} missing recommended mode ${capability.defaults.recommendedMode}`);
  return mode;
}

export function decideAutomationPolicy(capability: BackendCapability, modeName: string, policy: AutomationPolicyInput = {}): AutomationDecision {
  const mode = capability.prepareModes[modeName];
  if (!mode) return { policy: "never_auto", reasons: [`unknown prepare mode ${modeName}`] };
  const reasons: string[] = [];
  let decision: SetupPolicy = mode.defaultPolicy;
  if (mode.defaultPolicy === "never_auto") return { policy: "never_auto", reasons: [`${capability.id}:${modeName} is never automatic`] };
  if (capability.evidence.status !== "verified" && !policy.allowUnverifiedBackends) {
    decision = maxPolicy(decision, "ask_first");
    reasons.push(`${capability.id} capability evidence is provisional`);
  }
  // A mode with a local provider option degrades to local (e.g. QMD's packaged
  // embedding and reranker models) and never *requires* cloud, so cloud/embeddings
  // consent must not block its automatic prepare. Cloud is used only when configured
  // and keyed.
  const hasLocalOption = mode.providers.includes("local") || mode.providers.includes("sentence-transformers");
  if (!mode.localOnly && mode.providers.length && !hasLocalOption && !policy.allowCloud) { decision = maxPolicy(decision, "ask_first"); reasons.push("provider/cloud capability needs global allowCloud policy"); }
  if (mode.usesEmbeddings && !hasLocalOption && !policy.allowEmbeddings) { decision = maxPolicy(decision, "ask_first"); reasons.push("embedding mode needs global allowEmbeddings policy"); }
  if (mode.usesLLM && !policy.allowLLM) { decision = maxPolicy(decision, "ask_first"); reasons.push("LLM mode needs global allowLLM policy"); }
  if (writesVisibleProjectDir(mode) && !policy.allowVisibleProjectDirs) { decision = maxPolicy(decision, "ask_first"); reasons.push("mode writes visible project index/cache directories"); }
  if (!reasons.length) reasons.push(mode.defaultPolicy === "ask_first" ? `${capability.id}:${modeName} requires explicit operator confirmation by backend policy` : `${capability.id}:${modeName} allowed by backend defaults and supplied policy`);
  return { policy: decision, reasons };
}

function writesVisibleProjectDir(mode: BackendPrepareMode): boolean {
  return mode.writes.some(item => /(^|\b)(\.pi\/navigation|graphify-out)(\b|\/)/.test(item));
}
function maxPolicy(current: SetupPolicy, next: SetupPolicy): SetupPolicy {
  const rank: Record<SetupPolicy, number> = { safe_auto: 0, auto_logged: 1, ask_first: 2, never_auto: 3 };
  return rank[next] > rank[current] ? next : current;
}
