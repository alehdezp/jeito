import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { createStore, OpenRouterProvider, VoyageProvider, ZeroEntropyProvider, type LLM } from "../../native/qmd/runtime/index.js";
import { LlamaCpp } from "../../native/qmd/runtime/llm.js";
import { createAdmittedAnalysisFileSystem } from "./analysis-source.ts";
import { envWithNavigationProviders, loadNavigationAutomationConfig } from "./navigation-automation-config.ts";
import { enumerateNavigationCorpus } from "./navigation-corpus-policy.ts";
import { callPiNav, type PiNavCaller } from "./pi-nav-native.ts";

const FORMAT = "pi-qmd-sections-v3";
const COLLECTION = "docs";
const PREAMBLE = "@preamble";
const MIN_SEMANTIC_RERANK_SCORE = 0.6;
const MIN_SEMANTIC_VECTOR_SCORE = 0.55;
const MIN_VECTOR_RESCUE_RERANK_SCORE = 0.8;
const EXACT_TITLE_PRIOR = 0.55;

export interface QmdDocsOptions {
  root: string;
  /** Owning project root when `root` is a docs subfolder; never inferred from a query. */
  projectRoot?: string;
  indexPath: string;
  repo: string;
  apiKey?: string;
  semanticProvider?: "local" | "zeroentropy" | "voyage" | "openrouter";
  embeddingModel?: string;
  /** Explicit manual maintenance only; automatic work and queries never acquire assets. */
  allowModelDownloads?: boolean;
  llm?: LLM;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  paths?: string[];
  pathHints?: string[];
  callNative?: PiNavCaller;
}

export type ProjectDocsUnavailableReason =
  | "docs_lane_disabled"
  | "obsolete_docs_backend"
  | "obsolete_docs_query_configuration"
  | "qmd_repository_identity_missing";

export interface ProjectDocsUnavailable {
  status: "unavailable";
  reason: ProjectDocsUnavailableReason;
  summary: string;
  message: string;
}

export interface ProjectDocsReady {
  status: "ready";
  projectRoot: string;
  docsRoot: string;
  options: Pick<QmdDocsOptions, "root" | "projectRoot" | "indexPath" | "repo" | "semanticProvider" | "apiKey" | "embeddingModel">;
}

export type ProjectDocsContext = ProjectDocsUnavailable | ProjectDocsReady;

/**
 * One shared owner for QMD docs config/provider policy (two public consumers:
 * docs_search and ranked Grep). Reads only `.pi-navigation.json`,
 * `.pi/navigation/state.json` and provider env; never opens the index, runs
 * inference, or acquires models. Caller adds `signal`/`pathHints` (and any
 * `llm`/`fetchImpl`/`callNative` test seam) before `searchDocsWithQmd`.
 */
export async function resolveProjectDocsContext(
  projectRoot: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Promise<ProjectDocsContext> {
  const root = projectRoot;
  const config = await readDocsContextJson(resolve(root, ".pi-navigation.json"));
  if (config?.docs?.enabled !== true) {
    return { status: "unavailable", reason: "docs_lane_disabled", summary: "Docs search disabled.", message: "Docs search is not enabled for this project." };
  }
  if (String(config.docs.backend ?? "qmd").toLowerCase() !== "qmd") {
    return { status: "unavailable", reason: "obsolete_docs_backend", summary: "Obsolete docs backend configuration.", message: "obsolete docs backend remains configured; run docs freshen." };
  }
  if (String(config.docs.queryCommand ?? "").trim() || String(config.docs.queryTransport ?? "").trim()) {
    return { status: "unavailable", reason: "obsolete_docs_query_configuration", summary: "Obsolete docs query configuration.", message: "obsolete docs query command/transport remains configured; run docs freshen." };
  }
  const repo = String(config.docs.repo ?? "").replace(/^local\//, "");
  if (!repo) {
    return { status: "unavailable", reason: "qmd_repository_identity_missing", summary: "Repository identity missing.", message: "Docs search has no repository identity." };
  }
  const docsRoot = resolve(root, String(config.docs.root ?? "."));
  const automation = loadNavigationAutomationConfig({ env: baseEnv });
  const state = await readDocsContextJson(resolve(root, ".pi/navigation/state.json"));
  const semanticStatus = String(state?.indexes?.docs?.qmd?.semantic?.status ?? "unavailable");
  const semanticProviderName = semanticStatus === "ready" || semanticStatus === "degraded"
    ? String(state?.indexes?.docs?.qmd?.semantic_provider ?? "")
    : "";
  const env = envWithNavigationProviders(automation, baseEnv);
  const semanticProvider = (["local", "zeroentropy", "voyage", "openrouter"] as const).includes(semanticProviderName as "local") ? semanticProviderName as QmdDocsOptions["semanticProvider"] : undefined;
  return {
    status: "ready",
    projectRoot: root,
    docsRoot,
    options: {
      root: docsRoot,
      projectRoot: root,
      indexPath: resolve(root, String(config.docs.indexPath ?? ".pi/navigation/qmd")),
      repo: `local/${repo}`,
      semanticProvider,
      apiKey: semanticProviderName === "zeroentropy" ? env.ZEROENTROPY_API_KEY : semanticProviderName === "voyage" ? env.VOYAGE_API_KEY : semanticProviderName === "openrouter" ? env.OPENROUTER_API_KEY : undefined,
      embeddingModel: semanticProviderName === "voyage" ? env.VOYAGE_EMBEDDING_MODEL : undefined,
    },
  };
}

async function readDocsContextJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

interface NativeSection {
  selector: string;
  title: string;
  level: number;
  parent?: string;
  children?: string[];
  headingStartByte: number;
  headingEndByte: number;
  headingStartLine: number;
  headingEndLine: number;
  ownEndByte: number;
  ownEndLine: number;
  subtreeEndByte: number;
  subtreeEndLine: number;
}

interface ProjectedSection {
  virtualPath: string;
  selector: string;
  docPath: string;
  title: string;
  level: number;
  parent?: string;
  startLine: number;
  endLine: number;
  sourceHash: string;
  retrievalText: string;
  retrievalHash: string;
  authorityRole: string;
}

interface CurrentProjection {
  sections: Map<string, ProjectedSection>;
  error?: string;
}

interface QmdInference {
  name?: "local" | "zeroentropy" | "voyage" | "openrouter";
  llm?: LLM;
  reason?: string;
}

function qmdInference(options: QmdDocsOptions, readOnly: boolean): QmdInference {
  const name = options.semanticProvider ?? (options.apiKey ? "zeroentropy" : undefined);
  if (options.llm) return { name: name ?? "local", llm: options.llm };
  if (name === "local") {
    return {
      name,
      llm: new LlamaCpp({ allowModelDownloads: !readOnly && options.allowModelDownloads === true, inactivityTimeoutMs: 5 * 60_000, disposeModelsOnInactivity: true }),
    };
  }
  if (name === "zeroentropy") {
    if (!options.apiKey) return { name, reason: "zeroentropy_api_key_missing" };
    return { name, llm: new ZeroEntropyProvider({ apiKey: options.apiKey, latency: "fast", signal: options.signal, fetchImpl: options.fetchImpl }) };
  }
  if (name === "voyage") {
    if (!options.apiKey) return { name, reason: "voyage_api_key_missing" };
    return { name, llm: new VoyageProvider({ apiKey: options.apiKey, model: options.embeddingModel, signal: options.signal, fetchImpl: options.fetchImpl }) };
  }
  if (name === "openrouter") {
    if (!options.apiKey) return { name, reason: "openrouter_api_key_missing" };
    return { name, llm: new OpenRouterProvider({ apiKey: options.apiKey, signal: options.signal, fetchImpl: options.fetchImpl }) };
  }
  return { reason: "provider_not_configured" };
}

/** One admitted docs scope from the existing policy census. Nothing here walks
 * or reads source; the returned filesystem is the only source door. */
interface AdmittedDocs {
  ownerRoot: string;
  docsRoot: string;
  /** Admitted Markdown paths relative to `docsRoot`; the only QMD identities. */
  admitted: Set<string>;
  files: string[];
  filesystem: ReturnType<typeof createAdmittedAnalysisFileSystem>;
}

function canonicalDirectory(path: string): string {
  const canonical = realpathSync(resolve(path));
  if (!statSync(canonical).isDirectory()) throw new Error("Docs scope must be a directory");
  return canonical;
}

async function admitDocsScope(options: QmdDocsOptions, callNative: PiNavCaller): Promise<AdmittedDocs> {
  const docsRoot = canonicalDirectory(options.root);
  const ownerRoot = canonicalDirectory(options.projectRoot ?? options.root);
  if (!inside(ownerRoot, docsRoot)) throw new Error("Docs root must stay inside its owning project root");
  const snapshot = await enumerateNavigationCorpus(ownerRoot, "docs", callNative, { signal: options.signal });
  const prefix = relative(ownerRoot, docsRoot).split(/[\\/]/).filter(Boolean).join("/");
  const admitted = new Set<string>();
  for (const file of snapshot.files) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    const local = prefix ? (file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : undefined) : file;
    if (local) admitted.add(local);
  }
  return {
    ownerRoot, docsRoot, admitted, files: [...admitted].sort(),
    filesystem: createAdmittedAnalysisFileSystem({ root: ownerRoot, files: snapshot.files, policyFiles: snapshot.policyFiles }),
  };
}

/** Bounded generic refusal: the store may still hold documents the current
 * policy no longer admits, so QMD is withheld until maintenance reconciles. */
function docsAdmissionUnavailable(): any {
  const reason = "qmd_docs_refresh_required";
  return { status: "unavailable", semantic: { status: "unavailable", reason }, reason, results: [] };
}
export async function syncQmdDocs(options: QmdDocsOptions): Promise<Record<string, unknown>> {
  const callNative = options.callNative ?? callPiNav;
  const admitted = await admitDocsScope(options, callNative);
  const root = admitted.docsRoot;
  const { dbPath } = qmdPaths(options);
  await mkdir(dirname(dbPath), { recursive: true });
  const inference = qmdInference(options, false);
  const provider = inference.llm;
  const store = await createStore({
    dbPath,
    config: { collections: { [COLLECTION]: { path: root, pattern: "__pi_qmd_sections_only__" } } },
    llm: provider ?? new LlamaCpp({ allowModelDownloads: false }),
  });
  const db = store.internal.db;
  const formatChanged = getStoreConfig(db, "pi_docs_format") !== FORMAT;
  ensureDocsState(db);
  const now = new Date().toISOString();
  let changed = 0;
  let removed = 0;
  let unchanged = 0;
  try {
    const requested = options.paths?.length ? normalizeRequestedPaths(root, options.paths) : undefined;
    // Exact paths are intersected with admission, never a bypass. The full pass
    // uses exactly the admitted census.
    const currentPaths = (requested ? requested.filter(path => admitted.admitted.has(path)) : admitted.files).slice().sort();
    const ledger = fileLedger(db);

    // Retire every active/ledger document that is no longer admitted. Exact
    // refreshes retire excluded documents too, without opening their source.
    for (const activePath of store.internal.getActiveDocumentPaths(COLLECTION)) {
      const identity = decodeVirtualSectionPath(activePath);
      if (identity && admitted.admitted.has(identity.docPath)) continue;
      store.internal.deactivateDocument(COLLECTION, activePath);
      removed++;
    }
    for (const oldPath of ledger.keys()) {
      if (admitted.admitted.has(oldPath)) continue;
      removed += deactivateSourceDocuments(store, oldPath);
      db.prepare("DELETE FROM pi_docs_files WHERE path = ?").run(oldPath);
    }

    for (const docPath of currentPaths) {
      const absolute = resolve(root, docPath);
      if (!inside(root, absolute)) continue;
      let bytes: Buffer;
      let info;
      try {
        bytes = Buffer.from(admitted.filesystem.readFileSync(absolute, "utf8") as string, "utf8");
        info = admitted.filesystem.statSync(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        removed += deactivateSourceDocuments(store, docPath);
        db.prepare("DELETE FROM pi_docs_files WHERE path = ?").run(docPath);
        continue;
      }
      const sourceHash = digest(bytes);
      const prior = ledger.get(docPath);
      if (!formatChanged && prior?.sourceHash === sourceHash) {
        unchanged++;
        continue;
      }
      const projected = await projectMarkdown(admitted, docPath, bytes, sourceHash, callNative, options.signal);
      // Preserve the old double-read refusal: source must not change mid-projection.
      if (digest(admitted.filesystem.readFileSync(absolute, "utf8") as string) !== sourceHash) {
        throw new Error(`Markdown changed while projecting QMD sections: ${docPath}`);
      }
      const active = new Set(projected.map(section => section.virtualPath));
      for (const section of projected) {
        store.internal.insertContent(section.retrievalHash, section.retrievalText, now);
        const existing = store.internal.findActiveDocument(COLLECTION, section.virtualPath);
        if (existing) {
          if (existing.hash !== section.retrievalHash || existing.title !== section.title) {
            store.internal.updateDocument(existing.id, section.title, section.retrievalHash, now);
            changed++;
          }
        } else {
          store.internal.insertDocument(COLLECTION, section.virtualPath, section.title, section.retrievalHash, now, now);
          changed++;
        }
      }
      for (const activePath of store.internal.getActiveDocumentPaths(COLLECTION)) {
        const identity = decodeVirtualSectionPath(activePath);
        if (identity?.docPath === docPath && !active.has(activePath)) {
          store.internal.deactivateDocument(COLLECTION, activePath);
          removed++;
        }
      }
      db.prepare(`INSERT INTO pi_docs_files(path, source_hash, size, mtime_ms, refreshed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET source_hash = excluded.source_hash, size = excluded.size, mtime_ms = excluded.mtime_ms, refreshed_at = excluded.refreshed_at`)
        .run(docPath, sourceHash, bytes.length, info.mtimeMs, now);
    }
    admitted.filesystem.assertCurrent();

    const cleanup = {
      orphanedVectors: store.internal.cleanupOrphanedVectors(),
      inactiveDocuments: store.internal.deleteInactiveDocuments(),
      orphanedContent: store.internal.cleanupOrphanedContent(),
    };

    const generation = ledgerGeneration(db);
    setStoreConfig(db, "pi_docs_format", FORMAT);
    setStoreConfig(db, "pi_docs_generation", generation);
    setStoreConfig(db, "pi_docs_indexed_at", now);
    let embedding: any = { updated: 0, mode: "lexical" };
    let semantic: { status: "ready" | "degraded" | "unavailable"; reason?: string } = provider
      ? { status: "degraded", reason: "vectors_incomplete" }
      : { status: "unavailable", reason: inference.reason ?? "provider_not_configured" };
    if (provider) {
      try {
        const priorModel = getStoreConfig(db, "pi_docs_embedding_model");
        embedding = await store.embed({ force: Boolean(priorModel && priorModel !== provider.embedModelName), collection: COLLECTION, chunkStrategy: "regex", maxDocsPerBatch: 64, maxBatchBytes: 4_000_000 });
      } catch (error) {
        embedding = { errors: 1, failures: [{ reason: boundedReason(error) }], mode: "semantic" };
        semantic = { status: "degraded", reason: "provider_embedding_failed" };
      }
    }
    const health = await store.getIndexHealth();
    if (provider && semantic.reason !== "provider_embedding_failed") {
      semantic = Number(health.needsEmbedding ?? 0) === 0 && Number(embedding?.errors ?? 0) === 0
        ? { status: "ready" }
        : { status: "degraded", reason: "vectors_incomplete" };
    }
    if (semantic.status === "ready" && inference.name && provider) {
      setStoreConfig(db, "pi_docs_semantic_provider", inference.name);
      setStoreConfig(db, "pi_docs_embedding_model", provider.embedModelName);
      setStoreConfig(db, "pi_docs_reranker_model", provider.rerankModelName);
    }
    return {
      status: semantic.status === "ready" ? "ready" : "lexical_ready",
      semantic,
      semantic_provider: inference.name,
      provider: semantic.status === "ready" ? (inference.name === "local" ? "qmd-local-models" : inference.name === "openrouter" ? "qmd-local+openrouter" : inference.name === "voyage" ? "qmd-local+voyage" : "qmd-local+zeroentropy") : "qmd-local",
      embedding_model: provider?.embedModelName,
      reranker_model: provider?.rerankModelName,
      privacy: semantic.status === "ready" ? (inference.name === "local" ? "local_index_local_inference" : "local_index_cloud_inference") : "local_index",
      generation,
      sections: store.internal.getActiveDocumentPaths(COLLECTION).length,
      files: Number((db.prepare("SELECT COUNT(*) AS count FROM pi_docs_files").get() as { count?: number } | undefined)?.count ?? 0),
      changed,
      format_migrated: formatChanged,
      removed,
      unchanged,
      embedding,
      cleanup,
      health,
    };
  } finally {
    await store.close();
    // Embedding and close both await; do not report readiness under revoked policy.
    admitted.filesystem.assertCurrent();
  }
}

export async function searchDocsWithQmd(query: string, options: QmdDocsOptions): Promise<any> {
  const { dbPath } = qmdPaths(options);
  try {
    const info = await stat(dbPath);
    if (!info.isFile()) return { status: "unavailable", semantic: { status: "unavailable", reason: "qmd_section_index_missing" }, reason: "qmd_section_index_missing", results: [] };
  } catch {
    return { status: "unavailable", semantic: { status: "unavailable", reason: "qmd_section_index_missing" }, reason: "qmd_section_index_missing", results: [] };
  }
  let admitted: AdmittedDocs;
  try { admitted = await admitDocsScope(options, options.callNative ?? callPiNav); }
  catch { return docsAdmissionUnavailable(); }
  const inference = qmdInference(options, true);
  const provider = inference.llm;
  const store = await createStore({ dbPath, llm: provider ?? new LlamaCpp({ allowModelDownloads: false }), readOnly: true });
  const db = store.internal.db;
  let snapshot = false;
  try {
    // Pin ownership, admission metadata and retrieval to the same read-only view.
    db.exec("BEGIN");
    snapshot = true;
    if (getStoreConfig(db, "pi_docs_format") !== FORMAT) return { status: "unavailable", semantic: { status: "unavailable", reason: "qmd_section_index_missing_or_stale" }, reason: "qmd_section_index_missing_or_stale", results: [] };
    const binding = db.prepare("SELECT path FROM store_collections WHERE name = ?").get(COLLECTION) as { path?: string } | undefined;
    if (!binding?.path || canonicalDirectory(binding.path) !== admitted.docsRoot) return docsAdmissionUnavailable();
    for (const activePath of store.internal.getActiveDocumentPaths(COLLECTION)) {
      const identity = decodeVirtualSectionPath(activePath);
      if (!identity || !admitted.admitted.has(identity.docPath)) return docsAdmissionUnavailable();
    }
    admitted.filesystem.assertCurrent();
    const health = await store.getIndexHealth();
    const started = performance.now();
    const asksForPlan = /\b(plan|planned|history|historical|roadmap|future|phase|workstream)\b/i.test(query);
    const rankingIntent = asksForPlan ? "The question explicitly asks for planning or historical material; rank it normally." : "Prefer current authoritative documentation over implementation or historical plans when both answer the question. Preserve exact technical identities and negation.";
    const lexical = lexicalSearches(query, options.pathHints);
    const hybridLexical = [{ type: "lex" as const, query }, ...pathHintSearches(options.pathHints)];
    const storedProvider = getStoreConfig(db, "pi_docs_semantic_provider");
    const storedModel = getStoreConfig(db, "pi_docs_embedding_model");
    const providerMatchesIndex = Boolean(provider && (!storedProvider || storedProvider === inference.name) && (!storedModel || storedModel === provider.embedModelName));
    const hybridEligible = providerMatchesIndex && Number(health.needsEmbedding ?? 0) === 0;
    const runSearch = (hybrid: boolean) => store.search({
      queries: hybrid ? [...hybridLexical, { type: "vec", query }] : lexical,
      intent: rankingIntent,
      collections: [COLLECTION],
      limit: 40,
      candidateLimit: 40,
      explain: true,
      rerank: hybrid,
      chunkStrategy: "regex",
    });
    let semantic: { status: "ready" | "degraded" | "unavailable"; reason?: string } = provider
      ? { status: "degraded", reason: hybridEligible ? "provider_query_failed" : "vectors_incomplete_or_provider_mismatch" }
      : { status: "unavailable", reason: inference.reason ?? "provider_not_configured" };
    let raw: any[];
    if (hybridEligible) {
      try {
        raw = await runSearch(true);
        semantic = { status: "ready" };
      } catch (error) {
        raw = await runSearch(false);
        semantic = { status: "degraded", reason: `provider_query_failed: ${boundedReason(error)}` };
      }
    } else {
      raw = await runSearch(false);
    }
    const projectionCache = new Map<string, Promise<CurrentProjection>>();
    let lowRerankWeak = 0;
    let weakVectorWeak = 0;
    let maxRerankScore: number | undefined;
    const omitted = new Map<string, string>();
    const results = (await Promise.all(raw.map(async (result: any) => {
      const storedPath = String(result.file).replace(/^qmd:\/\/docs\//, "");
      const identity = decodeVirtualSectionPath(storedPath);
      const ftsScores = Array.isArray(result.explain?.ftsScores) ? result.explain.ftsScores.map(Number).filter(Number.isFinite) : [];
      const vectorScores = Array.isArray(result.explain?.vectorScores) ? result.explain.vectorScores.map(Number).filter(Number.isFinite) : [];
      const rerankScore = Number(result.explain?.rerankScore);
      if (Number.isFinite(rerankScore)) maxRerankScore = maxRerankScore === undefined ? rerankScore : Math.max(maxRerankScore, rerankScore);
      const weakReasons: string[] = [];
      if (!identity) return undefined;
      let projectedPromise = projectionCache.get(identity.docPath);
      if (!projectedPromise) {
        projectedPromise = currentProjection(admitted, options, identity.docPath);
        projectionCache.set(identity.docPath, projectedPromise);
      }
      const projection = await projectedPromise;
      const current = projection.sections.get(identity.selector);
      if (projection.error || !current) {
        omitted.set(identity.docPath, projection.error ? `projection_failed: ${projection.error}` : "selector_missing_from_current_source");
        return undefined;
      }
      const indexed = store.internal.findActiveDocument(COLLECTION, storedPath);
      if (!indexed || indexed.hash !== current.retrievalHash) {
        omitted.set(identity.docPath, indexed ? "indexed_section_stale" : "index_record_missing");
        return undefined;
      }
      const role = current.authorityRole;
      const titlePrior = titleRelevancePrior(query, current.title);
      if (semantic.status === "ready" && (!Number.isFinite(rerankScore) || rerankScore < MIN_SEMANTIC_RERANK_SCORE)) {
        lowRerankWeak++;
        weakReasons.push("low_reranker_signal");
      }
      if (semantic.status === "ready" && titlePrior !== EXACT_TITLE_PRIOR && ftsScores.length === 0 && (!vectorScores.length || Math.max(...vectorScores) < MIN_SEMANTIC_VECTOR_SCORE) && rerankScore < MIN_VECTOR_RESCUE_RERANK_SCORE) {
        weakVectorWeak++;
        weakReasons.push("weak_vector_signal");
      }
      const retrievalScore = semantic.status === "ready" && Number.isFinite(rerankScore) ? rerankScore : (ftsScores.length ? Math.max(...ftsScores) : Number(result.score));
      const authorityPrior = asksForPlan || titlePrior === EXACT_TITLE_PRIOR ? 0 : rolePrior(role);
      const finalScore = retrievalScore + authorityPrior + titlePrior;
      return {
        id: current.virtualPath,
        section_id: `${current.docPath}:${current.selector}`,
        doc_path: current.docPath,
        title: current.title,
        level: current.level,
        parent_id: current.parent,
        start_line: current.startLine,
        end_line: current.endLine,
        content_hash: current.sourceHash,
        authority_role: role,
        selector: current.selector,
        _score: finalScore,
        project_navigation: {
          docs_authority_role: role,
          qmd: {
            rank: 0,
            qmd_score: retrievalScore,
            native_score: Number(result.score),
            authority_prior: authorityPrior,
            title_prior: titlePrior,
            final_score: finalScore,
            snippet: displaySnippet(result.bestChunk),
            read_selector: current.selector === PREAMBLE ? `${current.docPath}:${current.startLine}-${current.endLine}` : `${current.docPath}:${current.selector}`,
            explain: result.explain,
            answerability: semantic.status !== "ready"
              ? { status: "ranked_lead", reasons: ["semantic_answerability_not_assessed"] }
              : weakReasons.length
                ? { status: "weak_lead", reasons: [...new Set(weakReasons)] }
                : { status: "answer_bearing", reasons: [] },
          },
        },
      };
    }))).filter(Boolean).sort((a: any, b: any) => b._score - a._score);
    results.forEach((item: any, index: number) => { item.project_navigation.qmd.rank = index + 1; });
    const answerBearingCount = results.filter((item: any) => item.project_navigation.qmd.answerability.status === "answer_bearing").length;
    const weakLeadCount = results.filter((item: any) => item.project_navigation.qmd.answerability.status === "weak_lead").length;
    return {
      status: semantic.status === "ready" ? "ready" : "lexical_ready",
      semantic,
      provider: semantic.status === "ready" ? (inference.name === "local" ? "qmd-local-models" : inference.name === "openrouter" ? "qmd-local+openrouter" : inference.name === "voyage" ? "qmd-local+voyage" : "qmd-local+zeroentropy") : "qmd-local",
      semantic_provider: inference.name,
      embedding_model: provider?.embedModelName,
      reranker_model: provider?.rerankModelName,
      privacy: semantic.status === "ready" ? (inference.name === "local" ? "local_index_local_inference" : "local_index_cloud_inference") : "local_index",
      generation: getStoreConfig(db, "pi_docs_generation"),
      latency_ms: Math.round(performance.now() - started),
      health,
      candidate_window: { limit: 40, returned: raw.length, saturated: raw.length >= 40 },
      omissions: { count: omitted.size, paths: [...omitted].slice(0, 20).map(([path, reason]) => ({ path, reason })) },
      results,
      answerability: {
        status: semantic.status !== "ready" ? "not_assessed" : weakLeadCount > 0 && answerBearingCount === 0 ? "weak_leads_only" : "answer_bearing",
        answer_bearing_count: answerBearingCount,
        weak_lead_count: weakLeadCount,
        signals: semantic.status === "ready" ? { rerank: MIN_SEMANTIC_RERANK_SCORE, vector: MIN_SEMANTIC_VECTOR_SCORE, vector_rescue_rerank: MIN_VECTOR_RESCUE_RERANK_SCORE } : undefined,
        low_rerank_weak: lowRerankWeak,
        weak_vector_weak: weakVectorWeak,
        max_rerank_score: maxRerankScore,
      },
    };
  } finally {
    try { if (snapshot) db.exec("ROLLBACK"); }
    finally { await store.close(); }
    // Provider disposal also awaits; this is the last gate before the reply escapes.
    try { admitted.filesystem.assertCurrent(); } catch { return docsAdmissionUnavailable(); }
  }
}

function boundedReason(error: unknown): string {
  const value = String(error instanceof Error ? error.message : error).replace(/ze_[A-Za-z0-9]+/g, "<redacted>");
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}

async function currentProjection(admitted: AdmittedDocs, options: QmdDocsOptions, docPath: string): Promise<CurrentProjection> {
  try {
    if (!admitted.admitted.has(docPath)) throw new Error(`Document is outside the admitted docs scope: ${docPath}`);
    const absolute = resolve(admitted.docsRoot, docPath);
    const bytes = Buffer.from(admitted.filesystem.readFileSync(absolute, "utf8") as string, "utf8");
    const sourceHash = digest(bytes);
    const sections = await projectMarkdown(admitted, docPath, bytes, sourceHash, options.callNative ?? callPiNav, options.signal);
    if (digest(admitted.filesystem.readFileSync(absolute, "utf8") as string) !== sourceHash) {
      throw new Error(`Markdown changed while projecting QMD sections: ${docPath}`);
    }
    return { sections: new Map(sections.map(section => [section.selector, section])) };
  } catch (error) {
    return { sections: new Map(), error: boundedReason(error) };
  }
}

async function projectMarkdown(admitted: AdmittedDocs, docPath: string, bytes: Buffer, sourceHash: string, callNative: PiNavCaller, signal?: AbortSignal): Promise<ProjectedSection[]> {
  const output = await callNative({ root: admitted.ownerRoot, operation: "pi_nav_read",
    args: { path: docPath, markdownStructure: true, includeSections: true, capturedSource: { text: bytes.toString("utf8") } },
    timeoutMs: 10_000, signal });
  const data = (output.structured.data ?? {}) as any;
  const file = data?.files?.[0];
  if (data?.basis !== "supplied") throw new Error(`Markdown projection did not accept admitted supplied source: ${docPath}`);
  if (String(data?.suppliedSourceHash ?? "").toLowerCase() !== sourceHash) throw new Error(`Markdown changed while projecting QMD sections: ${docPath}`);
  if (file?.sourceHash !== undefined) throw new Error(`Supplied Markdown projection must not mint current source authority: ${docPath}`);
  const sections: NativeSection[] = Array.isArray(file?.sections) ? file.sections : [];
  const bySelector = new Map(sections.map(section => [section.selector, section]));
  const projected: ProjectedSection[] = [];
  const firstHeadingByte = sections[0]?.headingStartByte ?? bytes.length;
  const preamble = bytes.subarray(0, firstHeadingByte).toString("utf8");
  if (preamble.trim()) projected.push(makeProjected(docPath, PREAMBLE, basename(docPath), 0, undefined, 1, Math.max(1, preamble.split("\n").length), preamble, sourceHash, []));
  for (const section of sections) {
    const hierarchy: string[] = [section.title];
    let parent = section.parent ? bySelector.get(section.parent) : undefined;
    while (parent) {
      hierarchy.unshift(parent.title);
      parent = parent.parent ? bySelector.get(parent.parent) : undefined;
    }
    const body = bytes.subarray(section.headingStartByte, section.ownEndByte).toString("utf8");
    if (!body.trim()) continue;
    projected.push(makeProjected(docPath, section.selector, section.title, section.level, section.parent, section.headingStartLine, section.ownEndLine, body, sourceHash, hierarchy));
  }
  return projected;
}

function makeProjected(docPath: string, selector: string, title: string, level: number, parent: string | undefined, startLine: number, endLine: number, body: string, sourceHash: string, hierarchy: string[]): ProjectedSection {
  const role = authorityRole(docPath);
  const sectionLabel = hierarchy.length ? hierarchy.join(" > ") : title;
  const retrievalText = `File: ${docPath}\nAuthority role: ${role}\nSection: ${sectionLabel}\n\n${body}`;
  return { virtualPath: virtualSectionPath(docPath, selector), selector, docPath, title, level, parent, startLine, endLine, sourceHash, retrievalText, retrievalHash: digest(retrievalText), authorityRole: role };
}

// Discovery is the admitted policy census (enumerateNavigationCorpus); there is
// no second walker and exact paths are intersected with that admission.

function normalizeRequestedPaths(root: string, paths: string[]): string[] {
  return [...new Set(paths.map(value => relative(root, resolve(root, String(value).replace(/:\d+(?:[-+]\d+)?(?:,.*)?$/, ""))).replace(/\\/g, "/")).filter(path => path && path !== ".." && !path.startsWith("../") && path.toLowerCase().endsWith(".md")))].sort();
}

function deactivateSourceDocuments(store: any, docPath: string): number {
  let removed = 0;
  for (const activePath of store.internal.getActiveDocumentPaths(COLLECTION)) {
    if (decodeVirtualSectionPath(activePath)?.docPath !== docPath) continue;
    store.internal.deactivateDocument(COLLECTION, activePath);
    removed++;
  }
  return removed;
}

function ensureDocsState(db: any): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pi_docs_files (
    path TEXT PRIMARY KEY,
    source_hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    refreshed_at TEXT NOT NULL
  )`);
}

function fileLedger(db: any): Map<string, { sourceHash: string }> {
  ensureDocsState(db);
  const rows = db.prepare("SELECT path, source_hash FROM pi_docs_files").all() as Array<{ path: string; source_hash: string }>;
  return new Map(rows.map(row => [row.path, { sourceHash: row.source_hash }]));
}

function ledgerGeneration(db: any): string {
  const rows = db.prepare("SELECT path, source_hash FROM pi_docs_files ORDER BY path").all();
  return digest(JSON.stringify({ format: FORMAT, files: rows }));
}

function setStoreConfig(db: any, key: string, value: string): void {
  db.prepare("INSERT INTO store_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function getStoreConfig(db: any, key: string): string | undefined {
  return db.prepare("SELECT value FROM store_config WHERE key = ?").get(key)?.value;
}

function authorityRole(path: string): string {
  if (path === "AGENTS.md" || /^docs\/(README|harness-doctrine|automatic-workflow|evidence|current-truth|setup|evaluation-workflow|ui-rendering|tool-operating-reference|management)\.md$/.test(path) || path.startsWith("docs/decisions/") || /^native\/[^/]+\/(ARCHITECTURE|README)\.md$/.test(path)) return "current_authority";
  if (path.includes("/prompts/")) return "generated_or_prompt";
  if (path.startsWith("docs/plan/")) return "implementation_or_historical_plan";
  if (path.startsWith("skills/")) return "operator_runbook";
  return "supporting_documentation";
}

function rolePrior(role: string): number {
  if (role === "current_authority") return 0.35;
  if (role === "operator_runbook") return 0.10;
  if (role === "implementation_or_historical_plan") return -0.35;
  if (role === "generated_or_prompt") return -0.40;
  return 0;
}

function titleRelevancePrior(query: string, title: string): number {
  const normalizedQuery = normalizeTitle(query);
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedQuery || !normalizedTitle) return 0;
  if (normalizedQuery === normalizedTitle) return EXACT_TITLE_PRIOR;
  if (normalizedTitle.length >= 8 && normalizedQuery.includes(normalizedTitle)) return 0.08;
  const queryTerms = new Set(normalizedQuery.split(" ").filter(term => term.length > 2));
  const titleTerms = normalizedTitle.split(" ").filter(term => term.length > 2);
  const overlap = titleTerms.filter(term => queryTerms.has(term)).length;
  return overlap >= 2 && overlap / Math.max(1, titleTerms.length) >= 0.75 ? 0.05 : 0;
}

function normalizeTitle(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
function lexicalSearches(query: string, pathHints: string[] = []): Array<{ type: "lex"; query: string }> {
  const searches = [{ type: "lex" as const, query }];
  const stop = new Set(["about", "after", "again", "against", "also", "and", "answering", "are", "become", "before", "being", "between", "can", "could", "does", "during", "each", "from", "have", "how", "into", "itself", "next", "that", "the", "their", "then", "there", "these", "they", "this", "those", "through", "under", "what", "when", "where", "which", "while", "who", "why", "with", "without", "would"]);
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []).filter(term => term.length > 2 && !stop.has(term)))].slice(0, 6);
  if (terms.length >= 4) {
    for (let left = 0; left < terms.length && searches.length < 9; left++) {
      for (let middle = left + 1; middle < terms.length && searches.length < 9; middle++) {
        for (let right = middle + 1; right < terms.length && searches.length < 9; right++) searches.push({ type: "lex", query: `${terms[left]} ${terms[middle]} ${terms[right]}` });
      }
    }
  }
  searches.push(...pathHintSearches(pathHints, 10 - searches.length));
  return searches;
}

function pathHintSearches(pathHints: string[] = [], limit = 2): Array<{ type: "lex"; query: string }> {
  const searches: Array<{ type: "lex"; query: string }> = [];
  for (const hint of pathHints) {
    const pathTerms = String(hint).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
    if (pathTerms.length > 1 && searches.length < limit) searches.push({ type: "lex", query: pathTerms.join(" ") });
  }
  return searches;
}

function displaySnippet(value: unknown): string { return String(value ?? "").replace(/^File:[^\n]*\nAuthority role:[^\n]*\nSection:[^\n]*\n+/i, "").replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").replace(/^#{1,6}\s+[^\n]+\n+/, "").trim().replace(/\s+/g, " ").slice(0, 300); }
function virtualSectionPath(docPath: string, selector: string): string { return `sections/${encodeURIComponent(docPath)}@${encodeURIComponent(selector)}.md`; }
function decodeVirtualSectionPath(value: string): { docPath: string; selector: string } | undefined {
  const path = value.replace(/^qmd:\/\/docs\//, "");
  if (!path.startsWith("sections/") || !path.endsWith(".md")) return undefined;
  const encoded = path.slice("sections/".length, -3);
  const split = encoded.lastIndexOf("@");
  if (split < 1) return undefined;
  try { return { docPath: decodeURIComponent(encoded.slice(0, split)), selector: decodeURIComponent(encoded.slice(split + 1)) }; } catch { return undefined; }
}
function qmdPaths(options: QmdDocsOptions) {
  const configured = resolve(options.root, options.indexPath);
  return { dbPath: extname(configured) === ".sqlite" ? configured : join(configured, `${digest(options.repo).slice(0, 20)}.sqlite`) };
}
function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function inside(root: string, value: string): boolean { const rel = relative(root, value); return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\")); }
