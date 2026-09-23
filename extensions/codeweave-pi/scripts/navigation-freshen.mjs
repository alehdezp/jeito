#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { detectProjectRoot } from "./navigation-doctor.mjs";
import { envForNavigationBackend, envWithNavigationProviders, loadNavigationAutomationConfig } from "../src/core/navigation-automation-config.ts";
import { compileNavigationDesiredState, desiredLaneStateHash } from "../src/core/navigation-desired-state.ts";
import { publishExistingArtifactGenerationSync } from "../src/core/navigation-generation.ts";
import { VALUE_EXCLUDE_DIR_NAMES } from "../src/core/navigation-value-policy.ts";
import { withLaneTransaction, withLaneTransactionSync } from "../src/core/navigation-lane-transaction.ts";
import { appendLifecycleAuditSync } from "../src/core/navigation-lifecycle-audit.ts";
import { syncQmdDocs } from "../src/core/qmd-docs-search.ts";
import { ownedGraphifyBinIfPresent } from "../src/core/backend-registry.ts";
import { defaultModelForProvider } from "../src/core/provider-registry.ts";
import { ownedBackendRuntime } from "../src/core/owned-runtime.ts";


const CONFIG_NAME = ".pi-navigation.json";
const STATE_NAME = path.join(".pi", "navigation", "state.json");
const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Prepared builds run detached. Twenty minutes is long enough for large rich
// indexes while still bounding a genuinely stuck backend process.
const DEFAULT_PREPARED_BUILD_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_DOCS_INDEX_TIMEOUT_MS = DEFAULT_PREPARED_BUILD_TIMEOUT_MS;
const DOC_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc", ".asciidoc", ".asc", ".ipynb", ".html", ".htm"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".kt", ".kts", ".rb", ".php", ".cs", ".c", ".h", ".cpp", ".hpp", ".swift", ".scala", ".sh", ".bash", ".zsh", ".fish"]);
const DOC_SKIP_DIRS = new Set([".git", ".svn", "node_modules", "vendor", "dist", "build", "target", "coverage", ".tmp", ".pi", ".research", ".code-review-graph", "graphify-out", ".codanna", ".codedb-mcp", ".codescope", ".codesearch.db", ".rtfm", ".venv", "venv", ".cache"]);
const DOC_IGNORE_PATTERNS = [
  ".git/", ".svn/", ".tmp/", ".pi/", ".research/", ".cache/", ".venv/", "venv/", "node_modules/", "vendor/", "dist/", "build/", "target/", "coverage/", ".code-review-graph/", "graphify-out/", ".codanna/", ".codedb-mcp/", ".codescope/", ".codesearch.db/", ".rtfm/",
  "**/node_modules/**", "**/.git/**", "**/.svn/**", "**/.tmp/**", "**/.cache/**", "**/.venv/**", "**/venv/**", "**/dist/**", "**/build/**", "**/target/**", "**/coverage/**", "**/vendor/**",
  "**/.pi/**", "**/.research/**", "**/.code-review-graph/**", "**/graphify-out/**", "**/.codanna/**", "**/.codedb-mcp/**", "**/.codescope/**", "**/.codesearch.db/**", "**/.rtfm/**",
  "**/*.log", "**/*.lock", "**/*.jsonl", "**/*.svg", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.pdf",
];

const QUALITY_UNSAFE_SEGMENTS = new Set([
  ...VALUE_EXCLUDE_DIR_NAMES,
  "node_modules", "npm", ".pnpm-store", ".yarn", "dist", "build", "out", "target", "coverage", "vendor",
  "logs", "log", "archive", "archives", ".archive", "old", "sessions", "graphify-out", ".tmp", ".pi",
  ".agents", ".agent", ".claude", ".codex", ".research", ".rtfm", ".gsd",
  ".codanna", ".code-review-graph", ".codescope", ".codedb-mcp", ".codesearch.db", ".trace-mcp", ".semble", ".fastembed_cache",
]);
const DEFAULT_GRAPH_QUALITY_BYTES = 64 * 1024 * 1024;

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { lane: undefined, path: process.cwd(), json: false, trigger: undefined, graphifyBin: undefined, graphifyPython: undefined, graphifyMode: undefined, graphifyProvider: undefined, graphifyModel: undefined, graphifyFallbackProvider: undefined, graphifyFallbackModel: undefined, docsRepo: undefined, docsIndexPath: undefined, docsProvider: undefined, query: undefined, scope: undefined, semanticCache: undefined, timeoutMs: undefined };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("--")) args.lane = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = () => {
      const next = rest[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--path" || flag === "-C") args.path = value();
    else if (flag === "--json") args.json = true;
    else if (flag === "--trigger") args.trigger = value();
    else if (flag === "--graphify-mode") args.graphifyMode = value();
    else if (flag === "--graphify-provider") args.graphifyProvider = value();
    else if (flag === "--graphify-model") args.graphifyModel = value();
    else if (flag === "--docs-repo") args.docsRepo = value();
    else if (flag === "--docs-index-path") args.docsIndexPath = value();
    else if (flag === "--docs-provider") args.docsProvider = value();
    else if (flag === "--max-files") args.maxFiles = value();
    else if (flag === "--query") args.query = value();
    else if (flag === "--scope") args.scope = value();
    else if (flag === "--semantic-cache") args.semanticCache = value();
    else if (flag === "--use-embeddings") args.useEmbeddings = value();
    else if (flag === "--use-ai-summaries") args.useAiSummaries = true;
    else if (flag === "--no-ai-summaries") args.useAiSummaries = false;
    else if (flag === "--force-reindex") args.forceReindex = true;
    else if (flag === "--cleanup-legacy-docs") args.cleanupLegacyDocs = true;
    else if (flag === "--timeout-ms") args.timeoutMs = Number(value());
    else if (flag === "--verify-timeout-ms") args.verifyTimeoutMs = Number(value());
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}
function withFreshenTransaction(lane, root, options, operation) {
  const trigger = options.trigger ?? "manual_freshen";
  return withLaneTransactionSync({ root, lane, desiredStateHash: "compiling", extensionVersion: "0.9.0", operation: `freshen:${lane}`, timeoutMs: Number(options.transactionTimeoutMs ?? 10 * 60_000), staleMs: 10 * 60_000 }, () => {
    appendLifecycleAuditSync({ root, lane, actorPid: process.pid, operation: "freshen", trigger, approval: trigger === "manual_freshen" ? "explicit_non_destructive" : "automatic_safe", result: "started" });
    try {
      const result = operation();
      appendLifecycleAuditSync({ root, lane, actorPid: process.pid, operation: "freshen", trigger, desiredStateHash: result?.diagnostics?.find?.(value => String(value).startsWith("desired_state_hash="))?.split("=")[1], newArtifactId: result?.diagnostics?.find?.(value => /_generation=/.test(String(value)))?.split("=")[1], result: result?.status === "success" ? "success" : "error", failure: result?.status === "success" ? undefined : result?.root_cause ?? result?.summary ?? "unknown failure" });
      return result;
    } catch (error) {
      appendLifecycleAuditSync({ root, lane, actorPid: process.pid, operation: "freshen", trigger, result: "error", failure: String(error?.message ?? error) });
      throw error;
    }
  });
}


export async function freshenDocs(startPath = process.cwd(), options = {}) {
  const root = resolveFreshenRoot(startPath);
  return withLaneTransaction({
    root,
    lane: "docs",
    desiredStateHash: "qmd-sections-v3",
    extensionVersion: "0.9.0",
    backendVersion: "qmd-2.5.3",
    operation: "qmd_section_reconcile",
    timeoutMs: 120_000,
    staleMs: 60_000,
  }, () => freshenDocsUnlocked(startPath, options));
}

async function freshenDocsUnlocked(startPath = process.cwd(), options = {}) {
  const env = options.env ?? lifecycleFreshenEnv(process.env);
  const root = resolveFreshenRoot(startPath);
  const scopeRel = options.scope ? relativeDisplay(root, path.resolve(root, options.scope)) : ".";
  const docsRoot = scopeRel === "." ? root : path.resolve(root, scopeRel);
  const configPath = path.join(root, CONFIG_NAME);
  const statePath = path.join(root, STATE_NAME);
  const config = readJson(configPath) ?? {};
  const existingDocs = typeof config.docs === "object" ? config.docs : {};
  const repoName = options.docsRepo || env.PI_NAV_DOC_REPO?.replace(/^local\//, "") || String(existingDocs.repo ?? "").replace(/^local\//, "") || currentDocsRepoName(root);
  const repo = repoName.startsWith("local/") ? repoName : `local/${repoName}`;
  const existingIsQmd = String(existingDocs.backend ?? "").toLowerCase() === "qmd"
    && !String(existingDocs.queryCommand ?? "").trim()
    && !String(existingDocs.queryTransport ?? "").trim()
    && !String(existingDocs.indexCommand ?? "").trim();
  const existingQmdIndexPath = existingIsQmd ? existingDocs.indexPath : undefined;
  const docsIndexPath = path.resolve(root, String(options.docsIndexPath ?? existingQmdIndexPath ?? path.join(".pi", "navigation", "qmd")));
  const docsIndexPathRel = relativeDisplay(root, docsIndexPath);
  const automation = loadNavigationAutomationConfig({ env, home: options.home ?? (options.env && !("HOME" in options.env) ? root : undefined) });
  const docsEnv = envWithNavigationProviders(automation, env);
  console.error(`[navigation-freshen] Reconciling QMD Markdown sections for ${scopeRel}…`);
  let qmd;
  let requestedProvider = "lexical";
  try {
    const configuredProvider = String(options.docsProvider ?? existingDocs.embeddingProvider ?? existingDocs.embedding_provider ?? automation.config.backends.docs?.embeddingProvider ?? "auto").trim().toLowerCase();
    requestedProvider = options.useEmbeddings === false || options.useEmbeddings === "false" ? "lexical" : configuredProvider;
    if (!["auto", "local", "zeroentropy", "voyage", "openrouter", "lexical"].includes(requestedProvider)) throw new Error(`Unsupported QMD docs provider: ${requestedProvider}. Use auto, local, zeroentropy, voyage, openrouter, or lexical.`);
    const zeroEntropyAllowed = automation.config.providers.allowCloud && automation.config.providers.allowEmbeddings && automation.config.providers.allowed.includes("zeroentropy");
    const localAllowed = automation.config.providers.allowEmbeddings;
    if (requestedProvider === "local" && !localAllowed) throw new Error("QMD local inference is disabled by providers.allow_embeddings.");
    if (requestedProvider === "zeroentropy" && !zeroEntropyAllowed) throw new Error("ZeroEntropy docs inference is disabled by provider policy.");
    const voyageAllowed = automation.config.providers.allowCloud && automation.config.providers.allowEmbeddings && automation.config.providers.allowed.includes("voyage");
    if (requestedProvider === "voyage" && !voyageAllowed) throw new Error("Voyage docs inference is disabled by provider policy.");
    const openRouterAllowed = automation.config.providers.allowCloud && automation.config.providers.allowEmbeddings && automation.config.providers.allowed.includes("openrouter");
    if (requestedProvider === "openrouter" && !openRouterAllowed) throw new Error("OpenRouter docs inference is disabled by provider policy.");
    const semanticProvider = requestedProvider === "local"
      ? "local"
      : requestedProvider === "zeroentropy"
        ? "zeroentropy"
        : requestedProvider === "voyage"
          ? "voyage"
          : requestedProvider === "openrouter"
            ? "openrouter"
            : requestedProvider === "auto" && zeroEntropyAllowed && docsEnv.ZEROENTROPY_API_KEY
              ? "zeroentropy"
              : requestedProvider === "auto" && voyageAllowed && docsEnv.VOYAGE_API_KEY
                ? "voyage"
                : requestedProvider === "auto" && localAllowed
                  ? "local"
                  : undefined;
    const apiKey = semanticProvider === "zeroentropy" ? docsEnv.ZEROENTROPY_API_KEY : semanticProvider === "voyage" ? docsEnv.VOYAGE_API_KEY : semanticProvider === "openrouter" ? docsEnv.OPENROUTER_API_KEY : undefined;
    // Manual freshen retains its documented interrupted-download recovery;
    // startup, broad-request and cadence work may use only installed assets.
    const allowModelDownloads = options.trigger == null || options.trigger === "manual_prepare" || options.trigger === "manual_freshen";
    qmd = await syncQmdDocs({ root: docsRoot, projectRoot: root, indexPath: docsIndexPath, repo, semanticProvider, apiKey, llm: options.qmdLlm, fetchImpl: options.providerFetch ?? options.zeroEntropyFetch, callNative: options.callNative, signal: options.signal, paths: options.paths, allowModelDownloads });
  } catch (error) {
    return errorReport({
      summary: "QMD section reconciliation failed",
      root,
      root_cause: String(error?.message ?? error).replace(/ze_[A-Za-z0-9]+/g, "<redacted>"),
      safe_retry: "Fix the reported QMD/pi-nav/filesystem failure and rerun incremental docs freshen.",
      stop_condition: "Do not report current docs readiness from a failed reconciliation.",
      diagnostics: ["qmd_docs_reconcile_failed=true"],
    });
  }
  if (!["ready", "lexical_ready"].includes(String(qmd.status))) return errorReport({
    summary: "QMD section reconciliation is degraded",
    root,
    root_cause: String(qmd.reason ?? `status=${qmd.status}`),
    safe_retry: "Inspect QMD vector health/provider diagnostics; lexical data may still be current.",
    stop_condition: "Do not claim hybrid readiness while changed sections lack current vectors.",
    diagnostics: ["qmd_docs_degraded=true"],
  });
  config.docs = {
    ...existingDocs,
    enabled: true,
    backend: "qmd",
    repo,
    root: scopeRel,
    indexPath: docsIndexPathRel,
    embeddingProvider: requestedProvider,
  };
  for (const key of ["queryCommand", "queryTransport", "indexCommand", "quality", "aiSummaries", "summaryProvider", "summaryModel", "useEmbeddings", "useAiSummaries"]) delete config.docs[key];
  const state = readJson(statePath) ?? {};
  state.indexes ??= {};
  state.indexes.docs = {
    ...(typeof state.indexes.docs === "object" ? state.indexes.docs : {}),
    backend: "qmd",
    repo,
    root: scopeRel,
    indexPath: docsIndexPathRel,
    indexedAt: new Date().toISOString(),
    generationId: qmd.generation,
    refreshStatus: "ready",
    qmd,
  };
  for (const key of ["queryCommand", "queryTransport", "indexCommand", "quality", "observedQuality", "nativeVerification", "effectiveQuality", "requestedQuality", "backendIdentity", "broker", "workerLease", "eligibleFiles", "selectedFiles", "lastIncrementalProviderQuality", "lastIncrementalMode", "lastIncrementalChanged"]) delete state.indexes.docs[key];
  writeJson(statePath, state);
  writeJson(configPath, config);
  return {
    status: "success",
    summary: "docs lane freshened with QMD section indexing",
    root,
    configPath,
    statePath,
    repo,
    scope: scopeRel,
    qmd,
    next_actions: [`docs_search({ query:"${escapeForAction(options.query || "project documentation")}", scope:"${escapeForAction(root)}" })`],
    diagnostics: ["query_time_full_rebuild=false", "freshened_lane=docs", "docs_backend=qmd-sections", `qmd_docs=${qmd.status}`, `qmd_semantic=${qmd.semantic?.status ?? "unknown"}`, `qmd_provider=${qmd.semantic_provider ?? "lexical"}`, `docs_scope=${scopeRel}`, `qmd_generation=${qmd.generation}`, `qmd_changed=${qmd.changed}`, `qmd_removed=${qmd.removed}`],
  };
}



export function freshenGraph(startPath = process.cwd(), options = {}) {
  const lockRoot = detectProjectRoot(startPath);
  return withFreshenTransaction("graph", lockRoot, options, () => freshenGraphUnlocked(startPath, options));
}

function freshenGraphUnlocked(startPath = process.cwd(), options = {}) {
  let env = options.env ?? lifecycleFreshenEnv(process.env);
  const root = resolveFreshenRoot(startPath);
  const command = options.graphifyBin || ownedGraphifyBinIfPresent();
  if (!command) {
    return errorReport({
      summary: "Extension-owned Graphify runtime is unavailable",
      root,
      root_cause: "The verified extension-owned Graphify executable is not provisioned.",
      safe_retry: "Run /navigation-setup in Pi, then retry graph preparation.",
      stop_condition: "Do not enable the graph lane until /navigation-setup verifies Graphify 0.9.23.",
      next_actions: ["Run /navigation-setup in Pi."],
      diagnostics: ["missing_graphify_bin=true"],
    });
  }

  const updateTarget = options.scope ? path.resolve(root, options.scope) : root;
  const graphOutDir = path.join(root, ".pi", "navigation", "graphify");
  const graphPath = path.join(graphOutDir, "graphify-out", "graph.json");
  const graphManifestPath = path.join(graphOutDir, "graphify-out", "manifest.json");
  const graphPathRel = relativeDisplay(root, graphPath);
  const scopeRel = path.resolve(updateTarget) === path.resolve(root) ? "." : relativeDisplay(root, updateTarget);
  const configPath = path.join(root, CONFIG_NAME);
  const statePath = path.join(root, STATE_NAME);
  const graphifySettings = graphifyExtractionSettings(options, env);
  // MiniMax (and any OpenAI-compatible graph provider) rides graphify's built-in
  // openai backend via a scoped env, so the extension needs no machine-local
  // ~/.graphify/providers.json and never clobbers the global OPENAI_* the QMD lane
  // may use. See graphifyProviderEnv below + docs/graphify/upgrade-0.9.23.md (D3).
  const automation = loadNavigationAutomationConfig({ env, home: options.home ?? (options.env && !("HOME" in options.env) ? root : undefined) });
  env = { ...envForNavigationBackend("graphify", automation, env), ...graphifyProviderEnv(graphifySettings.primary.backend, env) };
  const existingConfig = readJson(configPath) ?? {};
  const existingState = readJson(statePath) ?? {};
  // Local updates never select a provider. Do not hash inferred cloud defaults
  // that this path deliberately omits from the persisted graph configuration.
  const desiredProvider = graphifySettings.mode === "update" ? {} : {
    provider: graphifySettings.primary.backend,
    ...(graphifySettings.primary.model ? { model: graphifySettings.primary.model } : {}),
  };
  const desired = compileNavigationDesiredState({
    root,
    automation: automation.config,
    projectConfig: { ...existingConfig, graph: { ...(typeof existingConfig.graph === "object" ? existingConfig.graph : {}), enabled: true, root: scopeRel, mode: graphifySettings.mode, ...desiredProvider } },
    oneRun: options.graphifyMode ? { graph: { mode: graphifySettings.mode, aiSummaries: /deep|rich/i.test(graphifySettings.mode), ...desiredProvider } } : undefined,
    trigger: options.trigger ?? "manual_freshen",
    backendIdentities: { graph: { available: true, compatible: true, version: options.graphifyVersion ?? env.PI_NAV_GRAPHIFY_VERSION ?? "0.9.23", schemaVersion: "1" } },
    providerAvailable: { graph: graphifyProviderAvailable(graphifySettings.mode, graphifySettings.primary.backend, env) },
  });
  const desiredGraph = desired.lanes.graph;
  const graphDesiredHash = desiredLaneStateHash(desired, "graph");
  desired.desiredStateHash = graphDesiredHash;
  const graphifyIgnore = ensureGraphifyIgnoreDefaults(root);
  const baselineRestore = restoreVerifiedGraphifyWorkingBaseline({ root, graphPath, graphManifestPath, config: existingConfig, state: existingState });
  let preservedGeneration;
  if (existsSync(graphPath)) {
    try {
      preservedGeneration = preserveExistingGraphForQueries({ root, graphPath, graphManifestPath, configPath, statePath, command, scopeRel, desired, desiredGraph });
    } catch (error) {
      return errorReport({
        summary: "Graphify refresh refused to risk the existing graph",
        root,
        root_cause: `The existing graph could not be published as an immutable fallback before refresh: ${String(error?.message ?? error)}`,
        safe_retry: "Repair or verify the existing graph, then rerun the explicit Graphify refresh.",
        stop_condition: "Do not remove or overwrite graphify-out until a verified fallback generation is queryable.",
        diagnostics: ["graphify_existing_generation_preserve_failed=true"],
      });
    }
  }
  const graphFailure = report => {
    const failure = errorReport(report);
    if (preservedGeneration) recordGraphRefreshUnavailable({ root, configPath, statePath, failure });
    return failure;
  };
  const initialGraphSanitize = sanitizeExternalGraphSourceFiles({ root, graphPath });
  const preclean = inspectGraphRepairNeed({ root, graphPath, scopeRel, configPath, statePath });
  const ignorePolicyChanged = graphifyIgnorePolicyNewerThanGraph({ root, updateTarget, graphPath });
  const rebuildDiagnostics = [...graphifyIgnore.diagnostics, ...baselineRestore.diagnostics, ...initialGraphSanitize.diagnostics, ...(preservedGeneration ? [`graphify_existing_generation_preserved=${preservedGeneration.id}`] : []), ...preclean.diagnostics, ...(ignorePolicyChanged ? ["graphify_ignore_policy_changed=true"] : [])];
  if (graphifySettings.mode === "rich-update") {
    const scopeRepairReason = (preclean.reasons ?? []).find(reason => reason.startsWith("scope_changed:"));
    const graphQualityBeforeUpdate = verifyGraphIndexQuality(graphPath);
    const baselineRebuildReason = !existsSync(graphPath)
      ? "existing graph is missing"
      : !validGraphifyManifest(graphManifestPath)
        ? existsSync(graphManifestPath) ? "incremental manifest is structurally invalid" : "incremental manifest is missing"
        : graphQualityBeforeUpdate.status !== "success" && !(graphQualityBeforeUpdate.diagnostics ?? []).includes("graph_unsafe_path=true")
          ? "existing graph is structurally unreadable"
          : scopeRepairReason;
    let rich;
    if (baselineRebuildReason) {
      const recovery = runGraphifyBaselineRebuild({ root, updateTarget, graphPath, graphManifestPath, graphOutDir, command, settings: graphifySettings.primary, options, env, repairDiagnostics: [`graphify_full_rebuild_reason=${baselineRebuildReason}`, ...rebuildDiagnostics] });
      if (recovery.status !== "success") {
        recordGraphRefreshUnavailable({ root, configPath, statePath, failure: recovery });
        return errorReport({ summary: recovery.summary, root, root_cause: recovery.root_cause, safe_retry: recovery.safe_retry, stop_condition: preservedGeneration ? "The verified graph remains query-ready while automatic lifecycle retry is pending." : "Graph map remains unavailable until the unusable baseline is rebuilt and verified.", stdout: recovery.stdout, stderr: recovery.stderr, next_actions: recovery.next_actions, diagnostics: recovery.diagnostics });
      }
      rich = recovery;
    } else {
      rich = runGraphifyIncrementalCandidate({ root, updateTarget, graphPath, graphManifestPath, graphOutDir, command, settings: graphifySettings.primary, options, env, repairDiagnostics: rebuildDiagnostics });
      if (rich.status !== "success") {
        recordGraphRefreshUnavailable({ root, configPath, statePath, failure: rich });
        return errorReport({ summary: rich.summary, root, root_cause: rich.root_cause, safe_retry: rich.safe_retry, stop_condition: preservedGeneration ? "The verified graph remains query-ready; automatic mode retries the refresh after backoff." : "Graph map remains unavailable until the specific incremental failure is repaired or an explicit baseline rebuild is justified.", stdout: rich.stdout, stderr: rich.stderr, next_actions: rich.next_actions, diagnostics: ["graphify_full_rebuild_skipped=incremental_failure", ...rich.diagnostics] });
      }
    }
    // The source tree may change while a long rich extraction is running. Do
    // not publish that already-stale candidate: incrementally catch up against
    // the just-written manifest until one atomic snapshot matches live mtimes.
    let convergenceAttempts = 0;
    for (;;) {
      const drift = graphifyManifestDrift(root, graphManifestPath);
      if (!drift) break;
      if (convergenceAttempts >= 2) {
        return graphFailure({
          summary: "Graphify source kept changing during refresh",
          root,
          root_cause: `The candidate manifest changed again before publication (${drift}).`,
          safe_retry: "Automatic lifecycle will retry after source activity settles.",
          stop_condition: "The verified graph remains query-ready; no stale candidate was published.",
          failureClass: "source_churn",
          recoveryDecision: "retry_next_lifecycle",
          diagnostics: ["graphify_convergence_retry_exhausted=true", `graphify_convergence_last_drift=${drift}`],
        });
      }
      convergenceAttempts += 1;
      rich = runGraphifyIncrementalCandidate({ root, updateTarget, graphPath, graphManifestPath, graphOutDir, command, settings: graphifySettings.primary, options, env, repairDiagnostics: [...rebuildDiagnostics, `graphify_convergence_retry=${convergenceAttempts}`, `graphify_convergence_drift=${drift}`] });
      if (rich.status !== "success") {
        recordGraphRefreshUnavailable({ root, configPath, statePath, failure: rich });
        return errorReport({ summary: rich.summary, root, root_cause: rich.root_cause, safe_retry: rich.safe_retry, stop_condition: "The verified graph remains query-ready; automatic mode retries the refresh after backoff.", stdout: rich.stdout, stderr: rich.stderr, next_actions: rich.next_actions, diagnostics: ["graphify_convergence_retry_failed=true", ...rich.diagnostics] });
      }
    }
    if (!existsSync(graphPath)) {
      return graphFailure({ summary: "Graphify rich update completed but graph.json was not created", root, root_cause: `Graphify rich update reported success, but ${graphPath} does not exist.`, safe_retry: "Inspect rich update output and rerun navigation-freshen graph.", stop_condition: "Do not enable the graph lane until graphify-out/graph.json exists.", stdout: rich.stdout, stderr: rich.stderr, diagnostics: ["graphify_graph_missing_after_rich_update=true", ...rich.diagnostics] });
    }
    const richGraphSanitize = sanitizeExternalGraphSourceFiles({ root, graphPath });
    const graphQuality = verifyGraphIndexQuality(graphPath);
    if (graphQuality.status !== "success") {
      return graphFailure({ summary: "Graphify rich update produced a graph but quality verification failed", root, root_cause: graphQuality.root_cause, safe_retry: graphQuality.safe_retry, stop_condition: "Do not enable the graph lane until graph paths exclude generated/vendor/cache/archive noise.", stdout: rich.stdout, stderr: rich.stderr, next_actions: ["Fix .graphifyignore/scope selection, clean graph artifacts, then rerun navigation-freshen graph."], diagnostics: ["graphify_quality_verify_failed=true", ...(graphQuality.diagnostics ?? []), ...richGraphSanitize.diagnostics, ...rich.diagnostics] });
    }
    const verify = verifyGraphifyQuery({ root, command, graphPath, env, query: options.query || "project structure", timeoutMs: options.verifyTimeoutMs ?? 60_000 });
    if (verify.status !== "success") {
      return graphFailure({ summary: "Graphify rich update produced a graph but query verification failed", root, root_cause: verify.root_cause, safe_retry: verify.safe_retry, stop_condition: "Do not enable the graph lane until Graphify query can read the refreshed graph.", stdout: rich.stdout, stderr: verify.stderr, next_actions: ["Fix Graphify graph/query issues, then rerun navigation-freshen graph."], diagnostics: ["graphify_query_verify_failed=true", ...(verify.diagnostics ?? []), ...rich.diagnostics] });
    }
    const freshenedAt = new Date().toISOString();
    const graphMtime = statSync(graphPath).mtime.toISOString();
    const config = readJson(configPath) ?? {};
    const state = readJson(statePath) ?? {};
    state.indexes = state.indexes ?? {};
    const semanticExtractionObserved = rich.semanticExtractionObserved || firstBoolean(config?.graph?.semanticExtractionObserved, state?.indexes?.graph?.semanticExtractionObserved) === true;
    const lastRichUpdate = rich.metrics ? {
      operation: rich.metrics.operation,
      changedFiles: rich.metrics.changedFiles,
      codeFiles: rich.metrics.codeFiles,
      semanticFiles: rich.metrics.semanticFiles,
      deletedFiles: rich.metrics.deletedFiles,
      inputTokens: rich.metrics.inputTokens,
      outputTokens: rich.metrics.outputTokens,
      durationMs: rich.metrics.durationMs,
      llmRichness: rich.metrics.llmRichness,
      nodes: rich.metrics.nodes,
      edges: rich.metrics.edges,
      ...(rich.metrics.identityCollisionRemaps ? { identityCollisionRemaps: rich.metrics.identityCollisionRemaps } : {}),
      ...(rich.metrics.skippedEdgeCollisions ? { skippedEdgeCollisions: rich.metrics.skippedEdgeCollisions } : {}),
      reportPath: rich.metrics.reportPath,
      historyPath: rich.metrics.historyPath,
      ...(rich.metrics.shrinkRecovery ? { shrinkRecovery: rich.metrics.shrinkRecovery } : {}),
    } : undefined;
    const providerFields = { provider: graphifySettings.primary.backend, ...(graphifySettings.primary.model ? { model: graphifySettings.primary.model } : {}) };
    const sourceSnapshotIdentity = existsSync(graphManifestPath) ? createHash("sha256").update(readFileSync(graphManifestPath)).digest("hex") : undefined;
    const generation = publishGraphifyGeneration(root, graphPath, graphManifestPath, desired, desiredGraph);
    const publishedGraphPath = path.join(generation.artifactPath, "graph.json");
    const publishedManifestPath = path.join(generation.artifactPath, "manifest.json");
    const sourceManifestPath = existsSync(publishedManifestPath) ? relativeDisplay(root, publishedManifestPath) : undefined;
    const publishedGraphPathRel = relativeDisplay(root, publishedGraphPath);
    const graphConfig = { ...(typeof config.graph === "object" ? config.graph : {}), enabled: true, backend: "Graphify", command, graphPath: publishedGraphPathRel, root: scopeRel, mode: "richUpdate", semanticExtractionObserved, updatedAt: freshenedAt, graphMtime, sourceSnapshotIdentity, sourceManifestPath, ...(lastRichUpdate ? { lastRichUpdate } : {}), ...providerFields, refreshStatus: "ready", sourceFreshnessStatus: "current" };
    const graphState = { ...(typeof state.indexes.graph === "object" ? state.indexes.graph : {}), graphPath: publishedGraphPathRel, root: scopeRel, updatedAt: freshenedAt, graphMtime, mode: "richUpdate", semanticExtractionObserved, sourceSnapshotIdentity, sourceManifestPath, ...(lastRichUpdate ? { lastRichUpdate } : {}), ...providerFields, desiredStateHash: desired.desiredStateHash, rootIdentity: desired.rootIdentity, ownedScopeDigest: desiredGraph.scopeDigest, requestedQuality: desiredGraph.requested, effectiveQuality: desiredGraph.effective, backendIdentity: { name: desiredGraph.backend, version: desiredGraph.backendVersion, schemaVersion: desiredGraph.schemaVersion }, generationId: generation.id, artifactGeneration: generation, lastProbeStatus: "ready", lastProbeAt: new Date().toISOString(), refreshStatus: "ready", sourceFreshnessStatus: "current" };
    for (const value of [graphConfig, graphState]) {
      delete value.lastRefreshFailure;
      delete value.dirtySince;
      delete value.dirtyTrigger;
      delete value.dirtyPaths;
    }
    config.graph = graphConfig;
    state.indexes = state.indexes ?? {};
    state.indexes.graph = graphState;
    writeJson(configPath, config);
    writeJson(statePath, state);
    return { status: "success", summary: rich.summary, root, configPath, statePath, graphPath: publishedGraphPath, graphPathRel: publishedGraphPathRel, scope: scopeRel, stdout: rich.stdout, stderr: rich.stderr, verify: { summary: verify.summary, outputBytes: verify.outputBytes, semanticExtractionObserved, lastRichUpdate }, next_actions: [`explore({ view:"map", query:"${escapeForAction(options.query || "project structure")}", scope:"${escapeForAction(root)}" })`], diagnostics: ["query_time_rebuild=false", "freshened_lane=graph", "graphify_mode=richUpdate", `desired_state_hash=${desired.desiredStateHash}`, `graphify_generation=${generation.id}`, `graphify_backend=${graphifySettings.primary.backend}`, ...(graphifySettings.primary.model ? [`graphify_model=${graphifySettings.primary.model}`] : []), semanticExtractionObserved ? "graphify_semantic_extraction_observed=true" : "graphify_semantic_extraction_observed=preserved_or_not_needed", `graph_scope=${scopeRel}`, `verified_output_bytes=${verify.outputBytes}`, ...richGraphSanitize.diagnostics, ...rich.diagnostics] };
  }
  if (preclean.needsRepair) {
    const scopeChanged = (preclean.reasons ?? []).some(reason => reason.startsWith("scope_changed:"));
    return graphFailure({ summary: scopeChanged ? "Graphify baseline scope changed" : "Graphify working graph requires incremental source cleanup", root, root_cause: `The existing graph requires repair (${(preclean.reasons ?? []).join(", ")}); deleting it before refresh is not allowed.`, safe_retry: scopeChanged ? "Use rich-update so the scope transition is handled by a staged baseline rebuild." : "Use rich-update so stale generated/vendor provenance is pruned incrementally with provenance verification.", stop_condition: "Do not delete or replace the working graph before a verified candidate is available.", failureClass: scopeChanged ? "baseline_scope_incompatible" : "source_policy_reconciliation_required", recoveryDecision: scopeChanged ? "baseline_rebuild_allowed" : "fail_closed", diagnostics: ["graphify_destructive_preclean_skipped=true", ...rebuildDiagnostics] });
  }
  const primaryArgs = graphifyExtractArgs(updateTarget, graphOutDir, graphifySettings.primary, graphifySettings.mode);
  const graphifyEnv = graphifySettings.mode === "update" ? graphifyUpdateEnv(env, graphOutDir) : { ...env, GRAPHIFY_FORCE: "1" };
  let update = spawnSync(command, primaryArgs, {
    cwd: root,
    env: graphifyEnv,
    encoding: "utf8",
    timeout: Number(options.timeoutMs ?? 600_000),
    maxBuffer: 20 * 1024 * 1024,
  });
  let graphifyRun = graphifySettings.primary;
  let graphifyArgs = primaryArgs;
  let fallbackAttempt;
  if ((update.error || update.status !== 0) && graphifySettings.fallback) {
    const fallbackArgs = graphifyExtractArgs(updateTarget, graphOutDir, graphifySettings.fallback, graphifySettings.mode);
    fallbackAttempt = { status: update.status, stderr: trim(update.stderr || update.error?.message), stdout: trim(update.stdout) };
    update = spawnSync(command, fallbackArgs, {
      cwd: root,
      env: graphifyEnv,
      encoding: "utf8",
      timeout: Number(options.timeoutMs ?? 600_000),
      maxBuffer: 20 * 1024 * 1024,
    });
    graphifyRun = graphifySettings.fallback;
    graphifyArgs = fallbackArgs;
  }

  const graphifyOperation = graphifySettings.mode === "update" ? "Graphify update" : "Graphify deep extract";
  const graphifyFailureCause = graphifySettings.mode === "update"
    ? "The explicit Graphify update command returned a non-zero status or failed to start."
    : "The explicit Graphify extract --mode deep command returned a non-zero status or failed to start.";
  const graphifyRetry = graphifySettings.mode === "update"
    ? "Inspect Graphify stdout/stderr and rerun navigation-freshen graph with --graphify-mode update."
    : "Inspect Graphify stderr/stdout, provider API keys/model names, and rerun navigation-freshen graph.";

  if (update.error || update.status !== 0) {
    return graphFailure({
      summary: `${graphifyOperation} failed${update.status === null ? "" : ` (${update.status})`}`,
      root,
      root_cause: graphifyFailureCause,
      safe_retry: graphifyRetry,
      stop_condition: "Do not enable the graph lane from this run; graphify-out/graph.json was not refreshed successfully.",
      stdout: trim(update.stdout),
      stderr: trim(update.stderr || update.error?.message),
      next_actions: [graphifySettings.mode === "update" ? "Inspect Graphify update output, then rerun local graph update." : "Inspect Graphify extract output, provider configuration, and model name, then rerun navigation-freshen graph."],
      diagnostics: [graphifySettings.mode === "update" ? "graphify_update_failed=true" : "graphify_extract_failed=true", ...(graphifySettings.mode === "update" ? [] : [`graphify_backend=${graphifyRun.backend}`, ...(graphifyRun.model ? [`graphify_model=${graphifyRun.model}`] : [])]), ...(fallbackAttempt ? ["graphify_fallback_attempted=true", `graphify_primary_status=${fallbackAttempt.status}`] : []), ...rebuildDiagnostics],
    });
  }

  if (!existsSync(graphPath)) {
    return graphFailure({
      summary: "Graphify refresh completed but graph.json was not created",
      root,
      root_cause: `Graphify exited successfully, but ${graphPath} does not exist.`,
      safe_retry: "Check Graphify version/output directory handling and rerun navigation-freshen graph.",
      stop_condition: "Do not enable the graph lane until graphify-out/graph.json exists.",
      stdout: trim(update.stdout),
      stderr: trim(update.stderr),
      next_actions: [graphifySettings.mode === "update" ? "Run graphify update directly to inspect output paths." : "Run Graphify deep extraction directly to inspect output paths."],
      diagnostics: ["graphify_graph_missing_after_update=true"],
    });
  }

  const graphSanitize = sanitizeExternalGraphSourceFiles({ root, graphPath });
  const graphQuality = verifyGraphIndexQuality(graphPath);
  if (graphQuality.status !== "success") {
    return graphFailure({
      summary: "Graphify graph refreshed but quality verification failed",
      root,
      root_cause: graphQuality.root_cause,
      safe_retry: graphQuality.safe_retry,
      stop_condition: "Do not enable the graph lane until graph paths exclude generated/vendor/cache/archive noise.",
      stdout: trim(update.stdout),
      stderr: trim(update.stderr),
      next_actions: ["Fix .graphifyignore/scope selection, clean graph artifacts, then rerun navigation-freshen graph."],
      diagnostics: ["graphify_quality_verify_failed=true", ...(graphQuality.diagnostics ?? []), ...graphSanitize.diagnostics, ...rebuildDiagnostics],
    });
  }

  const verify = verifyGraphifyQuery({ root, command, graphPath, env, query: options.query || "project structure", timeoutMs: options.verifyTimeoutMs ?? 60_000 });
  if (verify.status !== "success") {
    return graphFailure({
      summary: "Graphify graph refreshed but query verification failed",
      root,
      root_cause: verify.root_cause,
      safe_retry: verify.safe_retry,
      stop_condition: "Do not enable the graph lane until Graphify query can read the refreshed graph.",
      stdout: trim(update.stdout),
      stderr: verify.stderr,
      next_actions: ["Fix Graphify graph/query issues, then rerun navigation-freshen graph."],
      diagnostics: ["graphify_query_verify_failed=true", ...(verify.diagnostics ?? []), ...graphSanitize.diagnostics, ...rebuildDiagnostics],
    });
  }

  const semanticExtractionObserved = graphifySettings.mode === "deep" && graphifySemanticExtractionObserved(update.stdout, graphifyRun.backend);
  const recordedMode = graphifySettings.mode === "update" ? "update" : semanticExtractionObserved ? "deepExtract" : "deepExtractAstOnly";
  const semanticDiagnostics = graphifySettings.mode === "update"
    ? ["graphify_local_update=true"]
    : semanticExtractionObserved
      ? ["graphify_semantic_extraction_observed=true"]
      : ["graphify_semantic_extraction_observed=false", "graphify_degraded=ast_only_no_semantic_llm_output"];

  const freshenedAt = new Date().toISOString();
  const graphMtime = statSync(graphPath).mtime.toISOString();
  const config = readJson(configPath) ?? {};
  const state = readJson(statePath) ?? {};
  const providerFields = recordedMode === "update" ? {} : { provider: graphifyRun.backend, ...(graphifyRun.model ? { model: graphifyRun.model } : {}) };
  let generation;
  try { generation = publishGraphifyGeneration(root, graphPath, undefined, desired, desiredGraph); }
  catch (error) { return graphFailure({ summary: "Graphify graph verified but generation publication failed", root, root_cause: String(error?.message ?? error), safe_retry: "Rerun approved Graphify freshen; the prior published generation remains last-good.", stop_condition: "Do not mark the new Graphify generation ready until staged verification and atomic publication succeed.", diagnostics: ["graphify_generation_publish_failed=true"] }); }
  const publishedGraphPath = path.join(generation.artifactPath, "graph.json");
  const publishedGraphPathRel = relativeDisplay(root, publishedGraphPath);
  config.graph = { ...(typeof config.graph === "object" ? config.graph : {}), enabled: true, backend: "Graphify", command, graphPath: publishedGraphPathRel, root: scopeRel, mode: recordedMode, semanticExtractionObserved, updatedAt: freshenedAt, graphMtime, ...providerFields, sourceFreshnessStatus: "current" };
  state.indexes = state.indexes ?? {};
  state.indexes.graph = { ...(typeof state.indexes.graph === "object" ? state.indexes.graph : {}), graphPath: publishedGraphPathRel, root: scopeRel, updatedAt: freshenedAt, graphMtime, mode: recordedMode, semanticExtractionObserved, ...providerFields, desiredStateHash: desired.desiredStateHash, rootIdentity: desired.rootIdentity, ownedScopeDigest: desiredGraph.scopeDigest, requestedQuality: desiredGraph.requested, effectiveQuality: desiredGraph.effective, backendIdentity: { name: desiredGraph.backend, version: desiredGraph.backendVersion, schemaVersion: desiredGraph.schemaVersion }, generationId: generation.id, artifactGeneration: generation, lastProbeStatus: "ready", lastProbeAt: new Date().toISOString(), sourceFreshnessStatus: "current" };
  for (const laneState of [config.graph, state.indexes.graph]) {
    laneState.refreshStatus = "ready";
    delete laneState.lastRefreshFailure;
    delete laneState.lastRichUpdate;
    delete laneState.dirtySince;
    delete laneState.dirtyTrigger;
    delete laneState.dirtyPaths;
  }
  writeJson(configPath, config);
  writeJson(statePath, state);

  return {
    status: "success",
    summary: recordedMode === "update" ? "graph lane freshened with Graphify local update" : semanticExtractionObserved ? "graph lane freshened with Graphify deep extract" : "graph lane freshened with Graphify deep mode (AST-only; no semantic LLM extraction observed)",
    root,
    configPath,
    statePath,
    graphPath: publishedGraphPath,
    graphPathRel: publishedGraphPathRel,
    scope: scopeRel,
    stdout: graphifySettings.mode === "update" ? sanitizeLocalGraphifyUpdateOutput(update.stdout) : trim(update.stdout),
    stderr: graphifySettings.mode === "update" ? sanitizeLocalGraphifyUpdateOutput(update.stderr) : trim(update.stderr),
    verify: { summary: verify.summary, outputBytes: verify.outputBytes, semanticExtractionObserved },
    next_actions: [`explore({ view:"map", query:"${escapeForAction(options.query || "project structure")}", scope:"${escapeForAction(root)}" })`],
    diagnostics: ["query_time_rebuild=false", "freshened_lane=graph", `graphify_mode=${recordedMode}`, ...(recordedMode === "update" ? [] : [`graphify_backend=${graphifyRun.backend}`, ...(graphifyRun.model ? [`graphify_model=${graphifyRun.model}`] : [])]), `desired_state_hash=${desired.desiredStateHash}`, `graphify_generation=${generation.id}`, ...semanticDiagnostics, `graph_scope=${scopeRel}`, `verified_output_bytes=${verify.outputBytes}`, ...(fallbackAttempt ? ["graphify_fallback_used=true"] : []), ...graphSanitize.diagnostics, ...rebuildDiagnostics],
  };
}

function sanitizeLocalGraphifyUpdateOutput(value) {
  return trim(String(value ?? "").split(/\r?\n/).filter(line => !/\/(?:graphify)\b|\b(?:provider|model)\s*[:=]/i.test(line)).join("\n"));
}

function graphifyProviderAvailable(mode, provider, env) {
  if (mode === "update") return true;
  const keys = { openai: "OPENAI_API_KEY", deepseek: "DEEPSEEK_API_KEY", minimax: "MINIMAX_API_KEY", google: "GOOGLE_API_KEY", gemini: "GOOGLE_API_KEY", anthropic: "ANTHROPIC_API_KEY", kimi: "KIMI_API_KEY" };
  const key = keys[String(provider ?? "").toLowerCase()];
  return key ? Boolean(env[key]) : false;
}

function absoluteMaybe(root, value) {
  return typeof value === "string" && value.trim() ? (path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value)) : undefined;
}

function restoreVerifiedGraphifyWorkingBaseline({ root, graphPath, graphManifestPath, config, state }) {
  const current = readJson(path.join(root, ".pi", "navigation", "graphify", "current.json"));
  const candidates = [
    current?.artifactPath ? [path.join(current.artifactPath, "graph.json"), path.join(current.artifactPath, "manifest.json"), "current_pointer"] : undefined,
    [absoluteMaybe(root, config?.graph?.graphPath), absoluteMaybe(root, config?.graph?.sourceManifestPath), "config"],
    [absoluteMaybe(root, state?.indexes?.graph?.graphPath), absoluteMaybe(root, state?.indexes?.graph?.sourceManifestPath), "state"],
  ].filter(Boolean);
  let selected;
  const generationsRoot = path.resolve(root, ".pi", "navigation", "graphify", "generations");
  for (const [candidateGraph, candidateManifest, source] of candidates) {
    if (!candidateGraph || !candidateManifest || path.dirname(candidateGraph) !== path.dirname(candidateManifest)) continue;
    const relativeGenerationPath = path.relative(generationsRoot, path.resolve(candidateGraph));
    if (relativeGenerationPath.startsWith("..") || path.isAbsolute(relativeGenerationPath) || path.basename(candidateGraph) !== "graph.json") continue;
    if (verifyGraphIndexQuality(candidateGraph).status !== "success" || !validGraphifyManifest(candidateManifest)) continue;
    selected = { publishedGraph: candidateGraph, publishedManifest: candidateManifest, source };
    break;
  }
  if (!selected) return { restored: false, diagnostics: candidates.length ? ["graphify_verified_baseline_restore_skipped=no_valid_published_pair"] : [] };
  const { publishedGraph, publishedManifest, source } = selected;
  if (sameFileDigest(graphPath, publishedGraph) && sameFileDigest(graphManifestPath, publishedManifest)) return { restored: false, diagnostics: [] };
  mkdirSync(path.dirname(graphPath), { recursive: true });
  for (const [from, target] of [[publishedGraph, graphPath], [publishedManifest, graphManifestPath]]) {
    const temporary = `${target}.restore.${process.pid}`;
    copyFileSync(from, temporary);
    renameSync(temporary, target);
  }
  return { restored: true, diagnostics: [`graphify_working_baseline_restored=${source}`] };
}

function sameFileDigest(left, right) {
  if (!existsSync(left) || !existsSync(right)) return false;
  return createHash("sha256").update(readFileSync(left)).digest("hex") === createHash("sha256").update(readFileSync(right)).digest("hex");
}

function publishGraphifyGeneration(root, graphPath, manifestPath, desired, desiredGraph) {
  const bundle = path.join(path.dirname(path.dirname(graphPath)), `.publication-${process.pid}-${Date.now()}`);
  mkdirSync(bundle, { recursive: true });
  try {
    copyFileSync(graphPath, path.join(bundle, "graph.json"));
    if (manifestPath && existsSync(manifestPath)) copyFileSync(manifestPath, path.join(bundle, "manifest.json"));
    return publishExistingArtifactGenerationSync({
      root,
      lane: "graph",
      sourcePath: bundle,
      desiredStateHash: desired.desiredStateHash,
      rootIdentity: desired.rootIdentity,
      backendVersion: desiredGraph.backendVersion,
      verify: stagedPath => {
        const quality = verifyGraphIndexQuality(path.join(stagedPath, "graph.json"));
        if (quality.status !== "success") throw new Error(quality.root_cause ?? "staged Graphify generation verification failed");
        if (manifestPath && !validGraphifyManifest(path.join(stagedPath, "manifest.json"))) throw new Error("staged Graphify generation manifest is missing or structurally invalid");
      },
    });
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
}

function preserveExistingGraphForQueries({ root, graphPath, graphManifestPath, configPath, statePath, command, scopeRel, desired, desiredGraph }) {
  if (existsSync(graphManifestPath) && !validGraphifyManifest(graphManifestPath)) return undefined;
  if (verifyGraphIndexQuality(graphPath).status !== "success") return undefined;
  const config = readJson(configPath) ?? {};
  const state = readJson(statePath) ?? {};
  const configuredPath = firstString(config?.graph?.graphPath, state?.indexes?.graph?.graphPath);
  if (configuredPath) {
    const resolved = path.resolve(root, configuredPath);
    if (resolved !== path.resolve(graphPath) && existsSync(resolved)) return undefined;
  }
  const generation = publishGraphifyGeneration(root, graphPath, existsSync(graphManifestPath) ? graphManifestPath : undefined, desired, desiredGraph);
  const publishedGraphPathRel = relativeDisplay(root, path.join(generation.artifactPath, "graph.json"));
  const publishedManifestPath = path.join(generation.artifactPath, "manifest.json");
  const publishedManifestPathRel = existsSync(publishedManifestPath) ? relativeDisplay(root, publishedManifestPath) : undefined;
  config.graph = { ...(typeof config.graph === "object" ? config.graph : {}), enabled: true, backend: "Graphify", command, graphPath: publishedGraphPathRel, ...(publishedManifestPathRel ? { sourceManifestPath: publishedManifestPathRel } : {}), ...(!config?.graph?.root ? { root: scopeRel } : {}) };
  state.indexes = state.indexes ?? {};
  state.indexes.graph = { ...(typeof state.indexes.graph === "object" ? state.indexes.graph : {}), graphPath: publishedGraphPathRel, ...(publishedManifestPathRel ? { sourceManifestPath: publishedManifestPathRel } : {}), ...(!state?.indexes?.graph?.root ? { root: scopeRel } : {}), desiredStateHash: desired.desiredStateHash, rootIdentity: desired.rootIdentity, generationId: generation.id, artifactGeneration: generation };
  writeJson(configPath, config);
  writeJson(statePath, state);
  return generation;
}

function graphifySemanticExtractionObserved(stdout, backend) {
  const text = String(stdout ?? "");
  const escaped = String(backend ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (escaped && new RegExp(`semantic extraction on .* via ${escaped}`, "i").test(text)) return true;
  return /semantic extraction on .* via /i.test(text);
}


function verifyGraphifyQuery({ root, command, graphPath, env, query, timeoutMs }) {
  const child = spawnSync(command, ["query", query, "--graph", graphPath, "--budget", "500"], { cwd: root, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  if (child.error || child.status !== 0) return { status: "error", root_cause: `Graphify query exited ${child.status ?? "before completion"}: ${trim(child.stderr || child.error?.message)}`, safe_retry: "Check the Graphify command and graph.json, then rerun navigation-freshen graph.", stderr: trim(child.stderr || child.error?.message), diagnostics: ["graphify_query_nonzero=true"] };
  const text = trim(child.stdout);
  return { status: "success", summary: text ? "graph query verified" : "graph query verified with an empty result", outputBytes: Buffer.byteLength(text), stdout: text, stderr: trim(child.stderr), diagnostics: text ? [] : ["graphify_query_empty_result=true"] };
}

export function freshenSemantic(startPath = process.cwd(), options = {}) {
  const env = options.env ?? process.env;
  const root = resolveFreshenRoot(startPath);
  const command = options.sembleBin || env.PI_SEMBLE_BIN || env.SEMBLE_BIN || findCommand("semble", env);
  if (!command) {
    return errorReport({
      summary: "Semble executable not found",
      root,
      root_cause: "No semble executable was found on PATH, PI_SEMBLE_BIN, SEMBLE_BIN, or --semble-bin.",
      safe_retry: "Install/configure Semble explicitly or rerun with --semble-bin /path/to/semble.",
      stop_condition: "Do not enable the semantic lane until Semble can search this repo and emit JSON results.",
      next_actions: ["Ask/confirm before installing Semble or downloading any embedding/model dependencies.", "Or rerun with --semble-bin /path/to/semble"],
      diagnostics: ["missing_semble_bin=true"],
    });
  }
  const query = options.query || "project structure";
  const scopeRel = options.scope ? relativeDisplay(root, path.resolve(root, options.scope)) : ".";
  const searchRoot = scopeRel === "." ? root : path.resolve(root, scopeRel);
  const semanticCache = options.semanticCache || env.SEMBLE_CACHE_LOCATION;
  if (options.semanticCache && !path.isAbsolute(options.semanticCache)) {
    return errorReport({
      summary: "Semble cache path must be absolute",
      root,
      root_cause: `--semantic-cache must be an absolute path: ${options.semanticCache}`,
      safe_retry: "Pass an absolute cache directory under the configured navigation index root.",
      stop_condition: "Do not enable the semantic lane with an ambiguous or backend-default cache location.",
      diagnostics: ["semble_cache_relative=true"],
    });
  }
  const verifyEnv = semanticCache ? { ...env, SEMBLE_CACHE_LOCATION: semanticCache } : env;
  const verify = verifySembleSearch({ root: searchRoot, command, env: verifyEnv, query, timeoutMs: options.verifyTimeoutMs ?? 120_000 });
  if (verify.status !== "success") {
    return errorReport({
      summary: "Semble search verification failed",
      root,
      root_cause: verify.root_cause,
      safe_retry: verify.safe_retry,
      stop_condition: "Do not enable the semantic lane until Semble search succeeds with JSON results for this repo.",
      stderr: verify.stderr,
      next_actions: ["Fix Semble install/configuration or choose a repo/query with indexable code, then rerun navigation-freshen semantic."],
      diagnostics: ["semble_verify_failed=true", ...(verify.diagnostics ?? [])],
    });
  }
  const markerDir = path.join(root, ".semble");
  const markerPath = path.join(markerDir, "navigation-ready.json");
  const verifiedAt = new Date().toISOString();
  mkdirSync(markerDir, { recursive: true });
  writeJson(markerPath, { backend: "Semble", command, query, verifiedAt, resultCount: verify.resultCount, root: scopeRel, cachePath: semanticCache });
  const configPath = path.join(root, CONFIG_NAME);
  const statePath = path.join(root, STATE_NAME);
  const config = readJson(configPath) ?? {};
  const state = readJson(statePath) ?? {};
  config.semantic = { ...(typeof config.semantic === "object" ? config.semantic : {}), enabled: true, backend: "Semble", command, indexPath: ".semble", root: scopeRel, cachePath: semanticCache };
  state.indexes = state.indexes ?? {};
  state.indexes.semantic = { ...(typeof state.indexes.semantic === "object" ? state.indexes.semantic : {}), indexPath: ".semble", root: scopeRel, cachePath: semanticCache, updatedAt: verifiedAt };
  writeJson(configPath, config);
  writeJson(statePath, state);
  return {
    status: "success",
    summary: "semantic lane freshened with Semble",
    root,
    configPath,
    statePath,
    indexPath: markerDir,
    searchRoot,
    scope: scopeRel,
    cachePath: semanticCache,
    stdout: verify.stdout,
    stderr: verify.stderr,
    verify: { summary: verify.summary, resultCount: verify.resultCount },
    next_actions: [`grep({ query:"${escapeForAction(query)}", kind:"content", scope:"${escapeForAction(root)}" })`],
    diagnostics: ["query_time_rebuild=false", "freshened_lane=semantic", `verified_results=${verify.resultCount}`, ...(semanticCache ? [`semantic_cache=${semanticCache}`] : [])],
  };
}

function verifySembleSearch({ root, command, env, query, timeoutMs }) {
  const child = spawnSync(command, ["search", query, root, "--content", "code", "docs", "config", "--top-k", "1"], { cwd: root, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  if (child.error || child.status !== 0) return { status: "error", root_cause: `Semble search exited ${child.status ?? "before completion"}: ${trim(child.stderr || child.error?.message)}`, safe_retry: "Check the Semble command, repo root, and whether model/index setup is allowed, then rerun navigation-freshen semantic.", stderr: trim(child.stderr || child.error?.message), diagnostics: ["semble_search_nonzero=true"] };
  let parsed;
  try { parsed = JSON.parse(child.stdout); } catch (error) { return { status: "error", root_cause: `Semble search returned non-JSON output: ${String(error?.message ?? error)}`, safe_retry: "Run semble search directly and ensure it emits JSON on stdout only.", stderr: trim(child.stderr), diagnostics: ["semble_search_non_json=true"] }; }
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const resultCount = results.length;
  if (!resultCount) return { status: "error", root_cause: "Semble search returned zero results during readiness verification.", safe_retry: "Use a repo/query with indexable code or leave the semantic lane disabled.", stderr: trim(child.stderr), diagnostics: ["semble_zero_results=true"] };
  const unsafe = firstUnsafeSembleResult(results);
  if (unsafe) return { status: "error", root_cause: `Semble top result points at generated/vendor/cache/archive path: ${unsafe}`, safe_retry: "Tighten .sembleignore or choose a narrower scope/cache, then rerun navigation-freshen semantic.", stderr: trim(child.stderr), diagnostics: ["semble_unsafe_top_result=true", `unsafe_path=${unsafe}`] };
  return { status: "success", summary: String(parsed?.summary ?? "semantic search verified"), resultCount, stdout: trim(child.stdout), stderr: trim(child.stderr), diagnostics: [] };
}

export function freshenCodanna(startPath = process.cwd(), options = {}) {
  const env = options.env ?? process.env;
  const root = resolveFreshenRoot(startPath);
  const command = options.codannaBin || env.CODANNA_BIN || findCommand("codanna", env);
  if (!command) {
    return errorReport({
      summary: "Codanna executable not found",
      root,
      root_cause: "No codanna executable was found on PATH, CODANNA_BIN, or --codanna-bin.",
      safe_retry: "Install/configure Codanna explicitly or rerun with --codanna-bin /path/to/codanna.",
      stop_condition: "Do not enable the Codanna trace lane until Codanna can index and retrieve known symbols.",
      next_actions: ["Install/configure Codanna explicitly, then rerun navigation-freshen codanna.", "Or rerun with --codanna-bin /path/to/codanna"],
      diagnostics: ["missing_codanna_bin=true"],
    });
  }
  const scopeRel = options.scope ? relativeDisplay(root, path.resolve(root, options.scope)) : ".";
  if (!scopeRel || scopeRel === "." || path.isAbsolute(scopeRel) || scopeRel.startsWith("..") || isUnsafeNavigationPath(scopeRel)) {
    return errorReport({
      summary: "Codanna needs one narrow safe scope",
      root,
      root_cause: `Codanna automatic preparation requires --scope to be a concrete non-root source/project folder inside ${root}; got ${scopeRel}.`,
      safe_retry: "Pass --scope for a specific package/source folder, e.g. agent/extensions/codeweave-pi, src, packages/core, or another first-party code scope.",
      stop_condition: "Do not run Codanna over the broad project root or generated/vendor/cache folders.",
      next_actions: ["Choose a narrow first-party code scope, then rerun navigation-freshen codanna --scope <scope>."],
      diagnostics: ["codanna_scope_invalid=true", `codanna_scope=${scopeRel}`],
    });
  }
  const codeRoot = path.resolve(root, scopeRel);
  if (!existsSync(codeRoot) || !safeStat(codeRoot)?.isDirectory()) {
    return errorReport({
      summary: "Codanna scope not found",
      root,
      root_cause: `Codanna scope does not exist or is not a directory: ${scopeRel}`,
      safe_retry: "Choose an existing first-party code directory.",
      stop_condition: "Do not enable Codanna until the selected scope exists.",
      diagnostics: ["codanna_scope_missing=true", `codanna_scope=${scopeRel}`],
    });
  }
  const indexedPaths = codannaIndexPaths(codeRoot);
  if (!indexedPaths.length) {
    return errorReport({
      summary: "Codanna found no safe code paths to index",
      root,
      root_cause: `No preferred first-party code paths were found under ${scopeRel}; automatic Codanna indexing refuses to fall back to a broad/noisy root scan.`,
      safe_retry: "Choose a scope with src/lib/app/scripts/tests/cmd/internal code paths, or prepare Codanna manually after reviewing scope noise.",
      stop_condition: "Do not enable Codanna automatically for a scope without safe code roots.",
      diagnostics: ["codanna_no_index_paths=true", `codanna_scope=${scopeRel}`],
    });
  }

  const version = spawnSync(command, ["--version"], { cwd: codeRoot, env, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  const init = spawnSync(command, ["init", "--force", "--info"], { cwd: codeRoot, env, encoding: "utf8", timeout: Number(options.initTimeoutMs ?? 30_000), maxBuffer: 20 * 1024 * 1024 });
  if (init.error || init.status !== 0) return codannaCommandError({ root, codeRoot, scopeRel, stage: "init", run: init });
  const indexArgs = ["index", ...indexedPaths, "--max-files", String(options.maxFiles ?? 50000), "--threads", String(options.threads ?? 4), "--no-progress", "--info"];
  const index = spawnSync(command, indexArgs, { cwd: codeRoot, env, encoding: "utf8", timeout: Number(options.timeoutMs ?? 180_000), maxBuffer: 20 * 1024 * 1024 });
  if (index.error || index.status !== 0) return codannaCommandError({ root, codeRoot, scopeRel, stage: "index", run: index });

  const benchmark = options.query || findCodannaBenchmarkSymbol(codeRoot, indexedPaths);
  const verify = verifyCodannaReady({ command, codeRoot, env, benchmark, timeoutMs: options.verifyTimeoutMs ?? 30_000 });
  if (verify.status !== "success") {
    return errorReport({
      summary: "Codanna index built but quality verification failed",
      root,
      root_cause: verify.root_cause,
      safe_retry: verify.safe_retry,
      stop_condition: "Do not enable Codanna until symbol retrieval returns valid JSON paths inside the selected scope.",
      stdout: trim(index.stdout),
      stderr: verify.stderr,
      next_actions: ["Tighten scope/ignores or inspect Codanna output, then rerun navigation-freshen codanna."],
      diagnostics: ["codanna_verify_failed=true", `codanna_scope=${scopeRel}`, ...(verify.diagnostics ?? [])],
    });
  }

  const markerDir = path.join(codeRoot, ".codanna");
  const markerPath = path.join(markerDir, "navigation-ready.json");
  const marker = {
    backend: "Codanna",
    version: trim(version.stdout || version.stderr || "unknown"),
    command,
    scope: scopeRel,
    indexedPaths,
    updatedAt: new Date().toISOString(),
    qualityGates: verify.qualityGates,
    knownWritePaths: [".codanna/settings.toml", ".codanna/navigation-ready.json", ".codanna/index/**", ".codannaignore", ".fastembed_cache", "~/.codanna/projects.json", "~/.codanna/providers.json", "~/.codanna/models/**"],
    modelCacheNote: "Codanna semantic/local embedding cache may use ~/.codanna/models via .fastembed_cache; this lane is for trace known-symbol queries only.",
  };
  writeJson(markerPath, marker);

  const configPath = path.join(root, CONFIG_NAME);
  const statePath = path.join(root, STATE_NAME);
  const config = readJson(configPath) ?? {};
  const state = readJson(statePath) ?? {};
  config.codanna = { ...(typeof config.codanna === "object" ? config.codanna : {}), enabled: true, backend: "Codanna", command, indexPath: relativeDisplay(root, markerPath), root: scopeRel };
  state.indexes = state.indexes ?? {};
  state.indexes.codanna = { ...(typeof state.indexes.codanna === "object" ? state.indexes.codanna : {}), indexPath: relativeDisplay(root, markerPath), root: scopeRel, indexedPaths, updatedAt: marker.updatedAt };
  writeJson(configPath, config);
  writeJson(statePath, state);

  return {
    status: "success",
    summary: "Codanna symbol trace lane freshened",
    root,
    configPath,
    statePath,
    indexPath: markerPath,
    scope: scopeRel,
    indexedPaths,
    stdout: trim(index.stdout),
    stderr: trim(index.stderr),
    verify: { summary: verify.summary, benchmark, symbolPath: verify.symbolPath },
    next_actions: [`trace({ target:"${escapeForAction(benchmark)}", relation:"callers", path:"${escapeForAction(codeRoot)}" })`],
    diagnostics: ["query_time_rebuild=false", "freshened_lane=codanna", `codanna_scope=${scopeRel}`, `codanna_indexed_paths=${indexedPaths.join(",")}`, `codanna_benchmark=${benchmark}`],
  };
}

function codannaCommandError({ root, codeRoot, scopeRel, stage, run }) {
  return errorReport({
    summary: `Codanna ${stage} failed${run.status === null ? "" : ` (${run.status})`}`,
    root,
    root_cause: `The explicit Codanna ${stage} command returned a non-zero status or failed to start for ${scopeRel}.`,
    safe_retry: "Inspect Codanna stderr/stdout, fix install/configuration/model-cache issues, then rerun navigation-freshen codanna.",
    stop_condition: "Do not enable the Codanna lane from this run; readiness marker was not written.",
    stdout: trim(run.stdout),
    stderr: trim(run.stderr || run.error?.message),
    next_actions: ["Inspect Codanna output, then rerun navigation-freshen codanna on a narrow scope."],
    diagnostics: [`codanna_${stage}_failed=true`, `codanna_scope=${scopeRel}`, `codanna_cwd=${codeRoot}`],
  });
}

function codannaIndexPaths(codeRoot) {
  const preferred = ["src", "lib", "app", "scripts", "tests", "test", "cmd", "internal", "crates"];
  const found = preferred.filter(item => existsSync(path.join(codeRoot, item)) && safeStat(path.join(codeRoot, item))?.isDirectory() && !isUnsafeNavigationPath(item));
  if (found.length) return found;
  return scopeHasSourceFiles(codeRoot) ? ["."] : [];
}

function scopeHasSourceFiles(dir, cap = 300, seen = { count: 0 }) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (seen.count >= cap) return false;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isUnsafeNavigationPath(entry.name)) continue;
      if (scopeHasSourceFiles(full, cap, seen)) return true;
    } else if (entry.isFile()) {
      seen.count++;
      if (/\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go)$/i.test(entry.name)) return true;
    }
  }
  return false;
}

function findCodannaBenchmarkSymbol(codeRoot, indexedPaths) {
  for (const relRoot of indexedPaths) {
    const found = findFirstDeclaredSymbol(path.join(codeRoot, relRoot), codeRoot, 300);
    if (found) return found;
  }
  return "main";
}

function findFirstDeclaredSymbol(dir, codeRoot, cap, seen = { count: 0 }) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const entry of entries) {
    if (seen.count >= cap) return undefined;
    const full = path.join(dir, entry.name);
    const rel = relativeDisplay(codeRoot, full);
    if (entry.isDirectory()) {
      if (isUnsafeNavigationPath(rel)) continue;
      const nested = findFirstDeclaredSymbol(full, codeRoot, cap, seen);
      if (nested) return nested;
    } else if (entry.isFile() && /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go)$/i.test(entry.name)) {
      seen.count++;
      const text = readFileSync(full, "utf8");
      const match = /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|\b(?:pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(|\bdef\s+([A-Za-z_][\w]*)\s*\(/.exec(text);
      if (match) return match.slice(1).find(Boolean);
    }
  }
  return undefined;
}

function verifyCodannaReady({ command, codeRoot, env, benchmark, timeoutMs }) {
  const symbol = codannaJson(command, ["retrieve", "symbol", benchmark, "--json"], codeRoot, env, timeoutMs);
  if (symbol.status !== "success") return symbol;
  const symbols = codannaRows(symbol.parsed).map(row => row.symbol ?? row).filter(Boolean);
  const first = symbols.find(item => validCodannaSymbolPath(codeRoot, item));
  if (!first) return { status: "error", root_cause: `Codanna symbol query for ${benchmark} returned no safe existing source path.`, safe_retry: "Choose a scope with first-party symbols and rerun Codanna freshen.", stderr: symbol.stderr, diagnostics: ["codanna_symbol_no_safe_path=true"] };
  const callers = codannaJson(command, ["retrieve", "callers", benchmark, "--json"], codeRoot, env, timeoutMs);
  const calls = codannaJson(command, ["retrieve", "calls", benchmark, "--json"], codeRoot, env, timeoutMs);
  const unsafe = firstUnsafeStringPath(symbol.parsed)
    || (callers.status === "success" ? firstUnsafeStringPath(callers.parsed) : undefined)
    || (calls.status === "success" ? firstUnsafeStringPath(calls.parsed) : undefined);
  if (unsafe) return { status: "error", root_cause: `Codanna verification returned generated/vendor/cache path: ${unsafe}`, safe_retry: "Tighten scope/ignores before enabling Codanna.", stderr: "", diagnostics: ["codanna_unsafe_path=true", `unsafe_path=${unsafe}`] };
  return {
    status: "success",
    summary: callers.status === "success" && calls.status === "success" ? "Codanna symbol/callers/calls JSON verified" : "Codanna symbol JSON verified; callers/calls will fall back per query if unavailable",
    symbolPath: first.file_path,
    qualityGates: { commandFound: true, symbolJson: true, symbolPathExists: true, callersJson: callers.status === "success", callsJson: calls.status === "success", callersReason: callers.status === "success" ? undefined : callers.root_cause, callsReason: calls.status === "success" ? undefined : calls.root_cause, unsafePathsRejected: true, benchmark },
    diagnostics: [],
  };
}

function codannaJson(command, args, cwd, env, timeoutMs) {
  const child = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  if (child.error || child.status !== 0) return { status: "error", root_cause: `Codanna ${args.slice(0, 3).join(" ")} exited ${child.status ?? "before completion"}: ${trim(child.stderr || child.error?.message)}`, safe_retry: "Check Codanna readiness and selected scope, then rerun navigation-freshen codanna.", stderr: trim(child.stderr || child.error?.message), diagnostics: ["codanna_retrieve_nonzero=true"] };
  try { return { status: "success", parsed: JSON.parse(child.stdout), stderr: trim(child.stderr) }; }
  catch (error) { return { status: "error", root_cause: `Codanna returned non-JSON output: ${String(error?.message ?? error)}`, safe_retry: "Run Codanna retrieve directly and ensure --json emits JSON on stdout.", stderr: trim(child.stderr), diagnostics: ["codanna_retrieve_non_json=true"] }; }
}

function codannaRows(parsed) {
  return Array.isArray(parsed?.data) ? parsed.data : [];
}

function validCodannaSymbolPath(codeRoot, symbol) {
  if (!symbol?.file_path || isUnsafeNavigationPath(symbol.file_path)) return false;
  const absolute = path.resolve(codeRoot, symbol.file_path);
  const rel = relativeDisplay(codeRoot, absolute);
  return rel && !rel.startsWith("..") && existsSync(absolute);
}

const PREPARED_DEFAULT_IGNORE_PATTERNS = [
  "# Generated navigation state and tool caches",
  ".tmp/", "**/.tmp/", ".ua/", "**/.ua/", ".pi/navigation/", "**/.pi/navigation/", ".cache/", "**/.cache/", ".rtfm/", "**/.rtfm/", ".codanna/", "**/.codanna/", ".codedb-mcp/", "**/.codedb-mcp/", ".codescope/", "**/.codescope/", ".codesearch.db/", "**/.codesearch.db/", ".trace-mcp/", "**/.trace-mcp/", ".fastembed_cache/", "**/.fastembed_cache/", ".semble/", "**/.semble/",
  "# Nested VCS metadata",
  ".git/", "**/.git/", ".svn/", "**/.svn/", ".hg/", "**/.hg/",
  "# Dependencies, caches, and generated output",
  "node_modules/", "**/node_modules/", ".venv/", "**/.venv/", "venv/", "**/venv/", "vendor/", "**/vendor/", "__pycache__/", "**/__pycache__/", "*.pyc", "dist/", "**/dist/", "build/", "**/build/", "out/", "**/out/", "target/", "**/target/", "coverage/", "**/coverage/",
  "*.min.js", "*.min.css", "*.map", "*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Cargo.lock",
  "*.db", "*.sqlite", "*.sqlite3", "*.db-journal", "logs/", "**/logs/", "*.log", "graphify-out/", "**/graphify-out/",
];
const GRAPHIFY_IGNORE_BLOCK_START = "# >>> jeito-codeweave-pi default Graphify ignores";
const GRAPHIFY_IGNORE_BLOCK_END = "# <<< jeito-codeweave-pi default Graphify ignores";
const GRAPHIFY_DEFAULT_IGNORE_PATTERNS = PREPARED_DEFAULT_IGNORE_PATTERNS;
function ensureGraphifyIgnoreDefaults(root) {
  return ensureIgnoreDefaults({
    root,
    filename: ".graphifyignore",
    startMarker: GRAPHIFY_IGNORE_BLOCK_START,
    endMarker: GRAPHIFY_IGNORE_BLOCK_END,
    patterns: GRAPHIFY_DEFAULT_IGNORE_PATTERNS,
    diagnosticPrefix: "graphify_ignore_defaults",
  });
}


function ensureIgnoreDefaults({ root, filename, startMarker, endMarker, patterns, diagnosticPrefix }) {
  const ignorePath = path.join(root, filename);
  const block = [startMarker, ...patterns, endMarker, ""].join("\n");
  try {
    const current = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
    const start = current.indexOf(startMarker);
    const end = current.indexOf(endMarker);
    if (start >= 0 && end >= start) {
      const afterEnd = end + endMarker.length;
      const next = `${current.slice(0, start)}${block}${current.slice(afterEnd).replace(/^\r?\n/, "")}`;
      if (next === current) return { diagnostics: [`${diagnosticPrefix}=present`] };
      writeFileSync(ignorePath, next);
      return { diagnostics: [`${diagnosticPrefix}=updated`] };
    }
    writeFileSync(ignorePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${block}`);
    return { diagnostics: [current ? `${diagnosticPrefix}=appended` : `${diagnosticPrefix}=created`] };
  } catch (error) {
    return { diagnostics: [`${diagnosticPrefix}_failed=true`, `${diagnosticPrefix}_error=${String(error?.message ?? error).slice(0, 160)}`] };
  }
}




function sanitizeDiagnostic(value) {
  return String(value ?? "").replace(/\s+/g, " ").slice(0, 180);
}

function runGraphifyRichUpdate({ root, updateTarget, graphOutDir, command, settings, options, env, strictRepair, repairDiagnostics = [] }) {
  const python = resolveGraphifyPython({ command, options, env });
  if (!python) {
    return {
      status: "error",
      summary: "Graphify rich update could not find a Graphify Python environment",
      root_cause: "No --graphify-python, PI_NAV_GRAPHIFY_PYTHON/GRAPHIFY_PYTHON, Graphify CLI Python shebang, or python3 candidate was available.",
      safe_retry: "Pass --graphify-python pointing at the Python interpreter that has the graphify package installed, or rerun manual Graphify setup first.",
      stdout: "",
      stderr: "",
      next_actions: ["Set --graphify-python /path/to/graphify/python for rich incremental lifecycle refresh."],
      diagnostics: ["graphify_rich_python_missing=true", ...repairDiagnostics],
    };
  }
  const helper = path.join(EXTENSION_ROOT, "scripts", "graphify-rich-update.py");
  const repairReason = strictRepair ? repairDiagnostics.find(item => item.startsWith("graphify_full_rebuild_reason=")) || "baseline_unusable" : "incremental";
  const child = spawnSync(python, [helper, root, updateTarget, graphOutDir, graphifyCliBackend(settings.backend) || "deepseek", settings.model || "", strictRepair ? "1" : "0", repairReason], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 10 * 60_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = parseJsonFromStdout(child.stdout);
  const acceptedStatus = parsed?.status === "success";
  if (child.error || child.status !== 0 || !parsed || !acceptedStatus) {
    const diagnostics = [
      "graphify_rich_update_failed=true",
      `graphify_rich_exit_status=${child.status ?? "error"}`,
      `graphify_rich_python=${python}`,
      ...repairDiagnostics,
      ...(Array.isArray(parsed?.diagnostics) ? parsed.diagnostics : []),
    ];
    const reportPath = typeof parsed?.report_path === "string" ? relativeDisplay(root, parsed.report_path) : undefined;
    const historyPath = typeof parsed?.history_path === "string" ? relativeDisplay(root, parsed.history_path) : undefined;
    if (reportPath) diagnostics.push(`graphify_rich_report=${reportPath}`);
    if (historyPath) diagnostics.push(`graphify_rich_history=${historyPath}`);
    if (parsed?.duration_ms != null) diagnostics.push(`graphify_rich_duration_ms=${Number(parsed.duration_ms)}`);
    if (parsed?.llm_richness) diagnostics.push(`graphify_rich_llm_richness=${String(parsed.llm_richness)}`);
    const failureClass = String(parsed?.failure_class || "incremental_failure");
    const recoveryDecision = String(parsed?.recovery_decision || "retry_next_lifecycle");
    diagnostics.push(`graphify_failure_class=${failureClass}`, `graphify_recovery_decision=${recoveryDecision}`);
    if (parsed?.provenance) {
      diagnostics.push(`graphify_provenance_attributed_drops=${Number(parsed.provenance.attributed_drop_count ?? 0)}`, `graphify_provenance_unexplained_drops=${Number(parsed.provenance.unexplained_drop_count ?? 0)}`, `graphify_provenance_attributed_sample_omitted=${Number(parsed.provenance.attributed_sample_omitted ?? 0)}`, `graphify_provenance_unexplained_sample_omitted=${Number(parsed.provenance.unexplained_sample_omitted ?? 0)}`);
    }
    return {
      status: "error",
      summary: parsed?.summary || "Graphify rich incremental update failed",
      root_cause: parsed?.root_cause || trim(child.stderr || child.error?.message || "Graphify rich update returned non-JSON or unsuccessful output."),
      safe_retry: parsed?.safe_retry || "Inspect Graphify rich update stderr and rerun navigation-freshen graph after fixing the provider/input issue.",
      failureClass,
      recoveryDecision,
      provenance: parsed?.provenance,
      stdout: trim(child.stdout, 20_000),
      stderr: trim(child.stderr || child.error?.message, 20_000),
      next_actions: parsed?.next_actions || ["If this is first setup, run explicit/manual Graphify setup before lifecycle rich update.", "For media/video changes, run guided Graphify update until media support is wired here."],
      diagnostics,
    };
  }
  const changed = Number(parsed.changed_total ?? 0);
  const semanticCount = Number(parsed.semantic_file_count ?? 0);
  const codeCount = Number(parsed.code_file_count ?? 0);
  const deletedCount = Number(parsed.deleted_count ?? 0);
  const inputTokens = Number(parsed.input_tokens ?? 0);
  const outputTokens = Number(parsed.output_tokens ?? 0);
  const durationMs = Number(parsed.duration_ms ?? 0);
  const operation = String(parsed.operation || "rich_incremental");
  const llmRichness = String(parsed.llm_richness || (operation === "rich_noop" ? "unchanged_noop" : semanticCount > 0 ? "llm_semantic_extraction" : codeCount > 0 ? "local_ast_only" : deletedCount > 0 ? "delete_prune_only" : "no_llm_observed"));
  const reportPath = typeof parsed.report_path === "string" ? relativeDisplay(root, parsed.report_path) : undefined;
  const historyPath = typeof parsed.history_path === "string" ? relativeDisplay(root, parsed.history_path) : undefined;
  const degraded = parsed.status === "degraded";
  const summary = degraded
    ? "Graphify rich refresh failed; existing graph preserved"
    : operation === "rich_noop"
      ? "Graphify rich incremental update found no changed files"
      : `Graphify ${operation} updated ${changed} changed file(s), ${deletedCount} deletion(s)`;
  return {
    status: "success",
    refreshStatus: degraded ? "degraded" : "ready",
    refreshFailure: degraded ? { rootCause: parsed.root_cause, safeRetry: parsed.safe_retry, reportPath, historyPath } : undefined,
    summary,
    stdout: trim(child.stdout, 20_000),
    stderr: trim(child.stderr, 20_000),
    semanticExtractionObserved: parsed.semantic_extraction_observed === true,
    metrics: degraded ? undefined : { operation, changedFiles: changed, codeFiles: codeCount, semanticFiles: semanticCount, deletedFiles: deletedCount, inputTokens, outputTokens, durationMs, llmRichness, nodes: parsed.nodes ?? undefined, edges: parsed.edges ?? undefined, reportPath, historyPath, shrinkRecovery: parsed.shrink_recovery ?? undefined, identityCollisionRemaps: Number(parsed.identity_collision_remaps ?? 0), skippedEdgeCollisions: Number(parsed.skipped_edge_collisions ?? 0) },
    diagnostics: [
      ...(degraded ? ["graphify_rich_refresh_degraded=true"] : []),
      ...repairDiagnostics,
      `graphify_rich_python=${python}`,
      `graphify_rich_operation=${operation}`,
      `graphify_rich_changed_files=${changed}`,
      `graphify_rich_code_files=${codeCount}`,
      `graphify_rich_semantic_files=${semanticCount}`,
      `graphify_rich_deleted_files=${deletedCount}`,
      `graphify_rich_input_tokens=${inputTokens}`,
      `graphify_rich_output_tokens=${outputTokens}`,
      `graphify_rich_duration_ms=${durationMs}`,
      `graphify_rich_llm_richness=${llmRichness}`,
      ...(parsed.shrink_recovery?.mode === "baseline_full_rebuild" ? [
        "graphify_rich_recovery=baseline_full_rebuild",
      ] : parsed.shrink_recovery?.forced === true ? [
        "graphify_rich_shrink=accepted_current_snapshot",
        `graphify_rich_shrink_attributed_drops=${Number(parsed.shrink_recovery.attributed_drop_count ?? 0)}`,
        `graphify_rich_shrink_unexplained_drops=${Number(parsed.shrink_recovery.unexplained_drop_count ?? 0)}`,
      ] : []),
      `graphify_rich_identity_collision_remaps=${Number(parsed.identity_collision_remaps ?? 0)}`,
      `graphify_rich_skipped_edge_collisions=${Number(parsed.skipped_edge_collisions ?? 0)}`,
      ...(reportPath ? [`graphify_rich_report=${reportPath}`] : []),
      ...(historyPath ? [`graphify_rich_history=${historyPath}`] : []),
      parsed.nodes != null ? `graphify_rich_nodes=${parsed.nodes}` : "graphify_rich_nodes=unchanged",
      parsed.edges != null ? `graphify_rich_edges=${parsed.edges}` : "graphify_rich_edges=unchanged",
    ],
  };
}

function runGraphifyIncrementalCandidate({ root, updateTarget, graphPath, graphManifestPath, graphOutDir, command, settings, options, env, repairDiagnostics = [] }) {
  const stageRoot = path.join(graphOutDir, `.incremental-${process.pid}-${Date.now()}`);
  const candidateDir = path.join(stageRoot, "graphify-out");
  mkdirSync(candidateDir, { recursive: true });
  copyFileSync(graphPath, path.join(candidateDir, "graph.json"));
  copyFileSync(graphManifestPath, path.join(candidateDir, "manifest.json"));
  try {
    const result = runGraphifyRichUpdate({ root, updateTarget, graphPath: path.join(candidateDir, "graph.json"), graphOutDir: stageRoot, command, settings, options, env, strictRepair: false, repairDiagnostics });
    const stableDiagnostics = (result.diagnostics ?? []).filter(item => !/^graphify_rich_(?:report|history)=/.test(item));
    if (result.status !== "success") return { ...result, diagnostics: stableDiagnostics };
    const candidateGraph = path.join(candidateDir, "graph.json");
    const candidateManifest = path.join(candidateDir, "manifest.json");
    if (!existsSync(candidateGraph) || !validGraphifyManifest(candidateManifest)) {
      const graphExists = existsSync(candidateGraph);
      const manifestExists = existsSync(candidateManifest);
      const manifestValid = manifestExists && validGraphifyManifest(candidateManifest);
      return { status: "error", summary: "Graphify incremental candidate is incomplete", root_cause: `Incremental refresh candidate graph exists=${graphExists}; manifest exists=${manifestExists}; manifest valid=${manifestValid}.`, safe_retry: "Automatic lifecycle will retry the candidate; inspect Graphify output if it recurs.", failureClass: "malformed_candidate", recoveryDecision: "retry_next_lifecycle", diagnostics: ["graphify_incremental_candidate_invalid=true", `graphify_incremental_candidate_graph_exists=${graphExists}`, `graphify_incremental_candidate_manifest_exists=${manifestExists}`, `graphify_incremental_candidate_manifest_valid=${manifestValid}`, ...stableDiagnostics] };
    }
    const sanitized = sanitizeExternalGraphSourceFiles({ root, graphPath: candidateGraph });
    const quality = verifyGraphIndexQuality(candidateGraph);
    if (quality.status !== "success") return { ...quality, status: "error", summary: "Graphify incremental candidate failed quality verification", failureClass: "candidate_quality_failure", recoveryDecision: "retry_next_lifecycle", diagnostics: ["graphify_incremental_candidate_quality_failed=true", ...sanitized.diagnostics, ...(quality.diagnostics ?? []), ...stableDiagnostics] };
    const verify = verifyGraphifyQuery({ root, command, graphPath: candidateGraph, env, query: options.query || "project structure", timeoutMs: options.verifyTimeoutMs ?? 60_000 });
    if (verify.status !== "success") return { ...verify, status: "error", summary: "Graphify incremental candidate failed query verification", failureClass: "candidate_query_failure", recoveryDecision: "retry_next_lifecycle", diagnostics: ["graphify_incremental_candidate_query_failed=true", ...(verify.diagnostics ?? []), ...stableDiagnostics] };
    for (const [source, target] of [[candidateGraph, graphPath], [candidateManifest, graphManifestPath]]) {
      const temporary = `${target}.candidate.${process.pid}`;
      copyFileSync(source, temporary);
      renameSync(temporary, target);
    }
    const realReport = path.join(graphOutDir, "graphify-out", "rich-update-report.json");
    const realHistory = path.join(graphOutDir, "graphify-out", "rich-update-history.jsonl");
    const stageReport = path.join(candidateDir, "rich-update-report.json");
    const stageHistory = path.join(candidateDir, "rich-update-history.jsonl");
    if (existsSync(stageReport)) copyFileSync(stageReport, realReport);
    if (existsSync(stageHistory)) writeFileSync(realHistory, readFileSync(stageHistory), { flag: "a" });
    return { ...result, metrics: result.metrics ? { ...result.metrics, reportPath: existsSync(realReport) ? relativeDisplay(root, realReport) : undefined, historyPath: existsSync(realHistory) ? relativeDisplay(root, realHistory) : undefined } : result.metrics, diagnostics: ["graphify_incremental_staged=true", ...sanitized.diagnostics, ...stableDiagnostics, ...(existsSync(realReport) ? [`graphify_rich_report=${relativeDisplay(root, realReport)}`] : []), ...(existsSync(realHistory) ? [`graphify_rich_history=${relativeDisplay(root, realHistory)}`] : [])] };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

function runGraphifyBaselineRebuild({ root, updateTarget, graphPath, graphManifestPath, graphOutDir, command, settings, options, env, repairDiagnostics = [] }) {
  const stageRoot = path.join(graphOutDir, `.baseline-rebuild-${process.pid}-${Date.now()}`);
  mkdirSync(stageRoot, { recursive: true });
  try {
    const rebuilt = runGraphifyRichUpdate({ root, updateTarget, graphOutDir: stageRoot, command, settings, options, env, strictRepair: true, repairDiagnostics: [...repairDiagnostics, "graphify_baseline_full_rebuild=true"] });
    const stableDiagnostics = (rebuilt.diagnostics ?? []).filter(item => !/^graphify_rich_(?:report|history)=/.test(item));
    if (rebuilt.status !== "success") return { ...rebuilt, diagnostics: stableDiagnostics };
    const candidateDir = path.join(stageRoot, "graphify-out");
    const candidateGraph = path.join(candidateDir, "graph.json");
    const candidateManifest = path.join(candidateDir, "manifest.json");
    if (!existsSync(candidateGraph) || !validGraphifyManifest(candidateManifest)) return { status: "error", summary: "Graphify baseline rebuild produced an incomplete candidate", root_cause: "The staged baseline rebuild did not produce a valid graph/manifest pair.", safe_retry: "Automatic lifecycle will retry; inspect the Graphify runtime/provider if it recurs.", failureClass: "malformed_baseline_candidate", recoveryDecision: "retry_next_lifecycle", diagnostics: ["graphify_baseline_rebuild_incomplete=true", ...stableDiagnostics] };
    const sanitized = sanitizeExternalGraphSourceFiles({ root, graphPath: candidateGraph });
    const quality = verifyGraphIndexQuality(candidateGraph);
    if (quality.status !== "success") return { ...quality, status: "error", summary: "Graphify baseline rebuild failed quality verification", failureClass: "candidate_quality_failure", recoveryDecision: "retry_next_lifecycle", diagnostics: ["graphify_baseline_rebuild_quality_failed=true", ...sanitized.diagnostics, ...(quality.diagnostics ?? []), ...stableDiagnostics] };
    const verify = verifyGraphifyQuery({ root, command, graphPath: candidateGraph, env, query: options.query || "project structure", timeoutMs: options.verifyTimeoutMs ?? 60_000 });
    if (verify.status !== "success") return { ...verify, status: "error", summary: "Graphify baseline rebuild failed query verification", failureClass: "candidate_query_failure", recoveryDecision: "retry_next_lifecycle", diagnostics: ["graphify_baseline_rebuild_query_failed=true", ...(verify.diagnostics ?? []), ...stableDiagnostics] };
    mkdirSync(path.dirname(graphPath), { recursive: true });
    for (const [source, target] of [[candidateManifest, graphManifestPath], [candidateGraph, graphPath]]) {
      const temporary = `${target}.tmp.${process.pid}`;
      copyFileSync(source, temporary);
      renameSync(temporary, target);
    }
    return { ...rebuilt, refreshStatus: "ready", summary: "Graphify baseline was unusable; a staged full rebuild published a verified current graph", metrics: rebuilt.metrics ? { ...rebuilt.metrics, reportPath: undefined, historyPath: undefined } : rebuilt.metrics, diagnostics: ["graphify_baseline_full_rebuild=true", ...sanitized.diagnostics, ...stableDiagnostics] };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

function recordGraphRefreshUnavailable({ root, configPath, statePath, failure }) {
  const failedAt = new Date().toISOString();
  const config = readJson(configPath) ?? {};
  const state = readJson(statePath) ?? {};
  const generationIdentity = firstString(state?.indexes?.graph?.generationId, config?.graph?.artifactGeneration?.id, state?.indexes?.graph?.artifactGeneration?.id);
  const priorFailure = state?.indexes?.graph?.lastRefreshFailure ?? config?.graph?.lastRefreshFailure;
  const sameFailure = priorFailure?.failureClass === failure.failureClass && priorFailure?.rootCause === (failure.root_cause ?? failure.summary);
  const retryAttempt = sameFailure ? Number(priorFailure?.retryAttempt ?? 1) + 1 : 1;
  const retryDelayMs = Math.min(60 * 60_000, 5 * 60_000 * (2 ** Math.min(4, retryAttempt - 1)));
  const retryAfter = failure.recoveryDecision === "retry_next_lifecycle" ? new Date(Date.now() + retryDelayMs).toISOString() : undefined;
  const refreshFailure = { rootCause: failure.root_cause ?? failure.summary, safeRetry: failure.safe_retry, failedAt, ...(generationIdentity ? { generationIdentity } : {}), ...(failure.failureClass ? { failureClass: failure.failureClass } : {}), ...(failure.recoveryDecision ? { recoveryDecision: failure.recoveryDecision } : {}), ...(retryAfter ? { retryAttempt, retryAfter } : {}), ...(failure.provenance ? { provenance: failure.provenance } : {}) };
  const freshnessStatus = failure.recoveryDecision === "retry_next_lifecycle" ? "retry_pending" : "blocked";
  if (config.graph && typeof config.graph === "object") {
    config.graph.refreshStatus = "ready";
    config.graph.sourceFreshnessStatus = freshnessStatus;
    config.graph.lastRefreshFailure = refreshFailure;
  }
  if (state?.indexes?.graph && typeof state.indexes.graph === "object") {
    state.indexes.graph.refreshStatus = "ready";
    state.indexes.graph.sourceFreshnessStatus = freshnessStatus;
    state.indexes.graph.lastProbeStatus = "ready";
    state.indexes.graph.lastRefreshFailure = refreshFailure;
  }
  writeJson(configPath, config);
  writeJson(statePath, state);
}

function resolveGraphifyPython({ options, env }) {
  if (typeof options.graphifyPython === "string" && options.graphifyPython.trim() && existsSync(options.graphifyPython)) return options.graphifyPython;
  return ownedBackendRuntime("graphify")?.python;
}


function parseJsonFromStdout(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch {}
  for (const line of text.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try { return JSON.parse(trimmed); } catch {}
  }
  return undefined;
}

function inspectGraphRepairNeed({ root, graphPath, scopeRel, configPath, statePath }) {
  if (!existsSync(graphPath) || !ownedGraphArtifact(root, graphPath)) return { removed: false, needsRepair: false, reasons: [], diagnostics: [] };
  const diagnostics = [];
  const reasons = [];
  const quality = verifyGraphIndexQuality(graphPath);
  if (quality.status !== "success" && (quality.diagnostics ?? []).includes("graph_unsafe_path=true")) {
    reasons.push("unsafe_existing_graph");
    diagnostics.push(...(quality.diagnostics ?? []).filter(item => item.startsWith("unsafe_path=")).map(item => `graph_existing_${item}`));
  }
  const config = readJson(configPath) ?? {};
  const state = readJson(statePath) ?? {};
  const priorRoot = firstString(config?.graph?.root, state?.indexes?.graph?.root);
  if (priorRoot && priorRoot !== scopeRel) reasons.push(`scope_changed:${priorRoot}->${scopeRel}`);
  if (!reasons.length) return { removed: false, needsRepair: false, reasons: [], diagnostics };
  return { removed: false, needsRepair: true, reasons, diagnostics: [`graph_existing_needs_repair=${reasons.join(",")}`, ...diagnostics] };
}


function ownedGraphArtifact(root, graphPath) {
  const rel = path.relative(root, graphPath).replace(/\\/g, "/");
  return rel === ".pi/navigation/graphify/graphify-out/graph.json";
}

function graphifyIgnorePolicyNewerThanGraph({ root, updateTarget, graphPath }) {
  if (!existsSync(graphPath)) return false;
  const graphInfo = safeStat(graphPath);
  if (!graphInfo) return false;
  const ignoreFiles = [path.join(root, ".graphifyignore"), path.join(updateTarget, ".graphifyignore")];
  return ignoreFiles.some(file => {
    const info = safeStat(file);
    return info && info.mtimeMs > graphInfo.mtimeMs;
  });
}

function sanitizeExternalGraphSourceFiles({ root, graphPath }) {
  if (!existsSync(graphPath)) return { count: 0, diagnostics: [] };
  const info = safeStat(graphPath);
  if (!info || info.size > DEFAULT_GRAPH_QUALITY_BYTES) return { count: 0, diagnostics: [] };
  let parsed;
  try { parsed = JSON.parse(readFileSync(graphPath, "utf8")); } catch { return { count: 0, diagnostics: [] }; }
  let count = 0;
  const samples = [];
  const visit = (value, seen = new Set()) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, seen);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === "source_file" && typeof item === "string" && isExternalGraphSourceFile(item, root)) {
        if (samples.length < 3) samples.push(item.replace(/\s+/g, " ").slice(0, 160));
        value[key] = null;
        count += 1;
        continue;
      }
      visit(item, seen);
    }
  };
  visit(parsed);
  if (!count) return { count: 0, diagnostics: [] };
  writeJson(graphPath, parsed);
  return { count, diagnostics: [`graph_external_source_file_sanitized=${count}`, ...samples.map(sample => `graph_external_source_file_sample=${sanitizeDiagnostic(sample)}`)] };
}

function isExternalGraphSourceFile(value, root) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (text.startsWith("~/")) return true;
  if (!path.isAbsolute(text)) return false;
  const rel = path.relative(root, text);
  return rel.startsWith("..") || path.isAbsolute(rel);
}


function validGraphifyManifest(manifestPath) {
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
    return Object.entries(manifest).every(([source, value]) => typeof source === "string" && source.length > 0 && value && typeof value === "object" && Number.isFinite(Number(value.mtime)) && typeof value.ast_hash === "string" && typeof value.semantic_hash === "string");
  } catch {
    return false;
  }
}

function graphifyManifestDrift(root, manifestPath) {
  if (!existsSync(manifestPath)) return "manifest missing";
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch (error) { return `manifest unreadable: ${String(error?.message ?? error)}`; }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return "manifest structurally invalid";
  const resolvedRoot = path.resolve(root);
  for (const [relativePath, recorded] of Object.entries(manifest)) {
    const sourcePath = path.resolve(root, relativePath);
    if (sourcePath !== resolvedRoot && !sourcePath.startsWith(`${resolvedRoot}${path.sep}`)) return `path escapes root: ${relativePath}`;
    try {
      const currentMtime = statSync(sourcePath).mtimeMs / 1000;
      const recordedMtime = Number(recorded?.mtime);
      if (!Number.isFinite(recordedMtime) || Math.abs(currentMtime - recordedMtime) > 0.001) {
        const digest = createHash("md5").update(readFileSync(sourcePath)).digest("hex");
        if (digest !== recorded?.ast_hash && digest !== recorded?.semantic_hash) return `source changed: ${relativePath}`;
      }
    } catch {
      return `source missing: ${relativePath}`;
    }
  }
  return undefined;
}

function verifyGraphIndexQuality(graphPath) {
  const info = safeStat(graphPath);
  if (!info) return { status: "error", root_cause: "graph.json is unreadable after Graphify update.", safe_retry: "Rerun navigation-freshen graph after fixing Graphify output permissions.", diagnostics: ["graph_quality_unreadable=true"] };
  if (info.size > DEFAULT_GRAPH_QUALITY_BYTES) return { status: "success", diagnostics: ["graph_quality_scan_skipped=too_large"] };
  let parsed;
  try { parsed = JSON.parse(readFileSync(graphPath, "utf8")); } catch (error) { return { status: "error", root_cause: `graph.json is not valid JSON: ${String(error?.message ?? error)}`, safe_retry: "Fix Graphify output or rerun navigation-freshen graph.", diagnostics: ["graph_quality_non_json=true"] }; }
  const unsafe = firstUnsafeGraphPath(parsed);
  if (unsafe) return { status: "error", root_cause: `Graphify graph contains generated/vendor/cache/archive path: ${unsafe}`, safe_retry: "Tighten .graphifyignore or choose a narrower scope, clean graph artifacts, then rerun navigation-freshen graph.", diagnostics: ["graph_unsafe_path=true", `unsafe_path=${unsafe}`] };
  return { status: "success", diagnostics: [] };
}

function firstUnsafeSembleResult(results) {
  const top = results[0];
  const candidate = top?.chunk?.file_path ?? top?.chunk?.path ?? top?.file_path ?? top?.path ?? top?.location;
  return typeof candidate === "string" && isUnsafeNavigationPath(candidate) ? candidate : undefined;
}

function firstUnsafeGraphPath(value, seen = new Set(), pathContext = false) {
  if (typeof value === "string") return pathContext && looksPathLike(value) && isUnsafeNavigationPath(value) ? value : undefined;
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUnsafeGraphPath(item, seen, pathContext);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    const nextPathContext = pathContext || /(path|file|source|target|location|module)/i.test(key);
    const found = firstUnsafeGraphPath(item, seen, nextPathContext);
    if (found) return found;
  }
  return undefined;
}

function looksPathLike(value) {
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,8}(:\d+)?$/.test(value);
}

function isUnsafeNavigationPath(value) {
  const normalized = String(value).replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  return segments.some(segment => QUALITY_UNSAFE_SEGMENTS.has(segment));
}

function safeStat(file) {
  try { return statSync(file); } catch { return undefined; }
}


function findIndexableSource(root) {
  const found = [];
  walkSource(root, root, found, 500);
  return found;
}

function walkSource(root, dir, found, cap) {
  if (found.length >= cap) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (found.length >= cap) return;
    if (entry.name.startsWith(".") && DOC_SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DOC_SKIP_DIRS.has(entry.name)) continue;
      walkSource(root, full, found, cap);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      found.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  }
}


function firstBoolean(...values) {
  for (const value of values) if (typeof value === "boolean") return value;
  return undefined;
}

function currentDocsRepoName(root) {
  const safeBase = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 8);
  return `${safeBase}-docs-${hash}`;
}

export function resolveFreshenRoot(startPath) {
  const configRoot = detectProjectRoot(startPath);
  return nearestNestedProjectRoot(startPath, configRoot) ?? configRoot;
}

function nearestNestedProjectRoot(startPath, configRoot) {
  let current = path.resolve(startPath);
  const info = safeStat(current);
  if (info && !info.isDirectory()) current = path.dirname(current);
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
  return [".git", ".pi-navigation.json", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "Gemfile", "pom.xml", "build.gradle", "flake.nix"].some(marker => existsSync(path.join(dir, marker)));
}

function lifecycleFreshenEnv(env = process.env) {
  const loaded = loadNavigationAutomationConfig({ env, home: env.HOME });
  return loaded.exists ? envWithNavigationProviders(loaded, env, env.HOME) : env;
}

function graphifyExtractionSettings(options = {}, env = process.env) {
  const loaded = loadNavigationAutomationConfig({ env, home: env.HOME });
  const config = loaded.config ?? {};
  const configuredProvider = firstString(config?.providers?.defaultLLMProvider, config?.backends?.graph?.provider);
  const provider = firstString(options.graphifyProvider, configuredProvider, "deepseek");
  const providerModel = config?.providers?.openaiCompatible?.[provider]?.model;
  const configuredModel = config?.backends?.graph?.model;
  const model = firstString(options.graphifyModel, configuredModel, providerModel, defaultModelForProvider(provider));
  const rawMode = String(options.graphifyMode ?? env.PI_NAV_GRAPHIFY_MODE ?? "deep").trim().toLowerCase();
  const mode = ["update", "local", "local-update"].includes(rawMode) ? "update" : ["rich-update", "rich", "semantic-update", "incremental-rich"].includes(rawMode) ? "rich-update" : "deep";
  return {
    mode,
    primary: { backend: provider, model },
    fallback: undefined,
  };
}

function graphifyExtractArgs(target, outDir, settings, mode = "deep") {
  if (mode === "update") return ["update", "--force", target];
  const args = ["extract", target, "--mode", "deep", "--backend", graphifyCliBackend(settings.backend), "--out", outDir];
  if (settings.model) args.push("--model", settings.model);
  return args;
}

function graphifyUpdateEnv(env, outDir) {
  // Installed graphify update accepts [--force] [--no-cluster] [path] and
  // chooses its output directory from GRAPHIFY_OUT. Force is supplied in argv
  // so legitimate shrink never strands the local-only automatic path.
  return { ...env, GRAPHIFY_OUT: path.join(outDir, "graphify-out"), GRAPHIFY_FORCE: "1" };
}

// MiniMax has no native graphify backend. Reach its OpenAI-compatible endpoint
// through graphify's built-in openai backend with a scoped env (injected into the
// graphify child only): OPENAI_BASE_URL + OPENAI_API_KEY carry routing; the model
// arrives via --model (resolved from the provider catalog in graphifyExtractionSettings),
// so OPENAI_MODEL is deliberately NOT set here — graphify honors --model first.
// A generous output budget lets the reasoning model finish thinking AND emit the JSON
// graphify parses. graphifyCliBackend maps the logical provider to the backend name
// graphify understands. ponytail: minimax base_url hardcoded; move to navigation.yaml
// openaiCompatible config if a second OpenAI-compatible graph provider is ever needed.
const MINIMAX_OPENAI_BASE_URL = "https://api.minimax.io/v1";
function graphifyCliBackend(backend) {
  return String(backend ?? "").toLowerCase() === "minimax" ? "openai" : backend;
}
function graphifyProviderEnv(backend, env) {
  if (String(backend ?? "").toLowerCase() !== "minimax") return {};
  return {
    OPENAI_BASE_URL: MINIMAX_OPENAI_BASE_URL,
    OPENAI_API_KEY: env.MINIMAX_API_KEY ?? "",
    GRAPHIFY_MAX_OUTPUT_TOKENS: env.GRAPHIFY_MAX_OUTPUT_TOKENS || "20000",
  };
}

function relativeDisplay(root, target) {
  const rel = path.relative(root, target).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : target;
}

function errorReport(report) { return { status: "error", ...report }; }
function readJson(file) { if (!existsSync(file)) return undefined; try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } }
// F5: atomic JSON write (temp + rename). A crash never leaves .pi-navigation.json
// or state.json half-written/poisoned; the target is either the prior content or
// the complete new content. renameSync is atomic on POSIX when src/dst share a FS.
function writeJson(file, value) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}
function findCommand(command, env = process.env) {
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
function firstString(...values) {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}
function trim(value, max = 4000) { const text = String(value ?? "").trim(); return text.length <= max ? text : `${text.slice(0, max)}…`; }
function escapeForAction(value) { return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\""); }


function render(report) {
  const lines = [];
  lines.push(`${report.status.toUpperCase()}: ${report.summary}`);
  lines.push(`Root: ${report.root}`);
  if (report.repo) lines.push(`Repo: ${report.repo}`);
  if (report.indexPath) lines.push(`Index: ${report.indexPath}`);
  if (report.graphPath) lines.push(`Graph: ${report.graphPath}`);
  if (report.configPath) lines.push(`Config: ${report.configPath}`);
  if (report.statePath) lines.push(`State: ${report.statePath}`);
  if (report.stdout) lines.push(`stdout: ${report.stdout}`);
  if (report.stderr) lines.push(`stderr: ${report.stderr}`);
  if (report.root_cause) lines.push(`Root cause: ${report.root_cause}`);
  if (report.safe_retry) lines.push(`Safe retry: ${report.safe_retry}`);
  if (report.stop_condition) lines.push(`Stop condition: ${report.stop_condition}`);
  if (report.next_actions?.length) {
    lines.push("Next actions:");
    for (const action of report.next_actions) lines.push(`- ${action}`);
  }
  return lines.join("\n");
}

function mergeReports(reports) {
  const failed = reports.find(report => report.status !== "success");
  return {
    status: failed ? "error" : "success",
    summary: reports.map(report => `${report.summary} [${report.status}]`).join("; "),
    root: reports[0]?.root,
    reports,
    next_actions: reports.flatMap(report => report.next_actions ?? []),
    diagnostics: reports.flatMap(report => report.diagnostics ?? []),
    root_cause: failed?.root_cause,
    safe_retry: failed?.safe_retry,
    stop_condition: failed?.stop_condition,
  };
}

export async function main(argv = process.argv.slice(2), signal) {
  const args = { ...parseArgs(argv), signal };
  if (args.help) {
    console.log("Usage: navigation-freshen.mjs <docs|graph|all> --path <repo> [--scope relative/path] [--trigger session_start|first_broad_request|manual_freshen|stop_refresh] [--timeout-ms ms] [--graphify-mode update|deep|rich-update] [--json]\n\nBuilds/freshens prepared navigation indexes outside query-time use and updates .pi/navigation/state.json. Graphify resolves only the extension-owned runtime installed by npm postinstall or /navigation-setup. Provider/model settings come from ~/.pi/agent/navigation.yaml. This command never installs missing backends and query tools never repair indexes. Code navigation is not prepared here: it comes from Core maintenance.");
    return 0;
  }
  if (args.lane === "architecture") throw new Error("the architecture lane was retired with the CRG runtime; code navigation comes from Core maintenance, so freshen docs or graph instead");
  if (!["docs", "graph", "all"].includes(args.lane)) throw new Error(`unsupported lane: ${args.lane ?? "(none)"}; expected docs, graph or all`);
  const report = args.lane === "docs"
    ? await freshenDocs(args.path, { ...args, query: args.query ?? "docs" })
    : args.lane === "graph"
      ? freshenGraph(args.path, { ...args, query: args.query ?? "project structure" })
      : mergeReports([
        await freshenDocs(args.path, { ...args, query: args.query ?? "docs" }),
        freshenGraph(args.path, { ...args, query: args.query ?? "project structure" }),
      ]);
  console.log(args.json ? JSON.stringify(report, null, 2) : render(report));
  return report.status === "success" ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  main(process.argv.slice(2), abort.signal).then(code => process.exitCode = code).catch(error => {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }).finally(() => {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  });
}
