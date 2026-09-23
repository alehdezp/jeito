import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectProjectRoot } from "./project-root.ts";
import { ANALYSIS_REVISION, MAINTENANCE_REVISION, MAINTENANCE_STATUS_FILE, SEMANTIC_MODEL_DIRECTORY } from "../../native/analysis/identity.mjs";

export const PI_NAV_BASE_CAPABILITIES = [
  "pi_nav_search",
  "pi_nav_files",
  "pi_nav_ls",
  "pi_nav_read",
  "pi_nav_diff",
  "pi_nav_deps",
  "pi_nav_grok",
  "pi_nav_map",
  "pi_nav_overview",
  "pi_nav_savings",
  "pi_nav_session",
  "pi_nav_symbol_range",
  "source_proof_v1",
] as const;

// Startup and package verification share the supported Grep contract. Keep it
// separate from base reads so a partial upgrade does not disable read or ls.
export const PI_NAV_GREP_CAPABILITIES = [
  "grep_cursor_owner_v1", "matches_corpus_v1", "matches_render_v1",
  "ranked_corpus_v1", "ranked_focus_v1", "ranked_cursor_v1", "ranked_render_v1",
] as const;
export const PI_NAV_ADDON_API_VERSION = 2;
const RESULT_SCHEMA_VERSION = 1;
const MAX_NATIVE_TEXT_BYTES = 128 * 1024;
const MAX_NATIVE_STRUCTURED_BYTES = 256 * 1024;
// Private proof packets, not answer-file limits. Keep in step with source_proof.rs.
export const MAX_SOURCE_PROOF_FILES = 32;
export const MAX_SOURCE_PROOF_FILE_BYTES = 8 * 1024 * 1024;
// Private semantic inputs may carry source text; this does not raise model-facing guards.
const MAX_SEMANTIC_PROJECTION_BYTES = 2 * 1024 * 1024;
const EXTENSION_ROOT = realpathSync.native(path.resolve(fileURLToPath(new URL("../..", import.meta.url))));
const STATE_SYMBOL = Symbol.for(`jeito-codeweave-pi.pi-nav-native.v1:${EXTENSION_ROOT}`);

type PiNavTarget = {
  platform: string;
  arch: string;
  releaseKey: "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";
  rustTarget:
    | "aarch64-apple-darwin"
    | "x86_64-apple-darwin"
    | "aarch64-unknown-linux-gnu"
    | "x86_64-unknown-linux-gnu";
};

type ArtifactPaths = {
  addon: string;
  cli: string;
};

type BuildInfo = {
  packageVersion: string;
  addonApiVersion: number;
  resultSchemaVersion: number;
  target: string;
  capabilities: string[];
  semanticRecipe?: string;
  semanticDimensions?: number;
};

export type NativeStructured = {
  schemaVersion: number;
  operation: string;
  data: Record<string, unknown>;
  completeness: Record<string, unknown>;
  diagnostics: string[];
  [key: string]: unknown;
};
export type NativeSourceSnapshot = {
  canonicalPath: string;
  text: string;
  rawDigest: string;
  lineEnding: "lf" | "crlf";
  bom: boolean;
};


type RankedCorpusAdmission = { root: string; files: string[]; policyDigest: string; policyFiles: { path: string; digest: string | null }[] };

type MatchesAdmission = {
  owners: { root: string; policy: Record<string, unknown>; policyDigest: string; policyFiles: { path: string; digest: string | null }[] }[];
  directories: Record<string, number>;
  explicitFiles: string[];
  allVisibility?: boolean;
};

export type NativeOutput = {
  text: string;
  structured: NativeStructured;
  sourceSnapshots?: NativeSourceSnapshot[];
  /** Single-use native collection handoff; stripped before returning an answer. */
  searchCapture?: string;
  searchCaptureUnavailable?: string;
  /** Private immutable original-progress handle for final reply fitting; never model metadata. */
  rankedRenderCursor?: string;
  rankedRenderUnavailable?: string;
  /** Private immutable Matches page origin; byte fitting never advances this handle. */
  matchesRenderCursor?: string;
  /** Bridge-owned operation root, including a cursor's original session. Not persisted metadata. */
  sourceRoot?: string;
  /** Private, non-enumerable handoff for final result refusal. Never model/persisted details. */
  readonly liveFallback?: NativeOutput;
  /** Private query admission; never serialize it into model-facing details. */
  readonly corpusAdmission?: RankedCorpusAdmission;
  readonly corpusOptions?: { metadataOnly: boolean; visibility: "project" | "all" };
  readonly matchesAdmission?: MatchesAdmission;
};

export type PiNavCaller = (input: {
  root: string;
  operation: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}) => Promise<NativeOutput>;

/** Private context, derived from the owning root and machine storage; never query activation.
 * Explicit G1 contexts remain available for retained development candidates. */
export type AnalysisProject = { root: string; directory: string; modelDirectory?: string; kind?: "indexed" };

type RankedCursorDescriptor = {
  query: string; scope: string; visibility: "project" | "all";
  focus?: { target?: string | null; evidence?: string | string[] };
  corpusRoot?: string;
  analysis?: { generation: number; captureDigest: string; interpretationRevision: string; policyDigest?: string }
    | { indexedRunId: string; interpretationRevision: typeof MAINTENANCE_REVISION; policyDigest: string; corpusDigest: string };
};

/** Private retained-state metadata is an admission input, never a freshness claim. */
function rankedCursorDescriptor(output: NativeOutput): RankedCursorDescriptor | undefined {
  const value = output.structured.data.rankedCursor;
  if (value === undefined || value === null) return undefined;
  const object = value as RankedCursorDescriptor;
  const record = (item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item);
  const digest = (item: unknown) => typeof item === "string" && /^[0-9a-f]{64}$/i.test(item);
  const evidenceCategory = (item: unknown) => typeof item === "string" && ["callers", "callees", "uses", "implementations", "documentation"].includes(item);
  if (!record(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024
    || typeof object.query !== "string" || !object.query
    || typeof object.scope !== "string" || !path.isAbsolute(object.scope) || object.scope.includes("\0")
    || !["project", "all"].includes(object.visibility)
    || object.corpusRoot != null && (typeof object.corpusRoot !== "string" || !path.isAbsolute(object.corpusRoot) || object.corpusRoot.includes("\0"))
    || object.focus != null && (!record(object.focus)
      || object.focus.target != null && (typeof object.focus.target !== "string" || !object.focus.target || object.focus.target.includes("\0") || object.focus.target.length > 16_384)
      || object.focus.evidence !== undefined && !(Array.isArray(object.focus.evidence)
        ? object.focus.evidence.length <= 32 && object.focus.evidence.every(evidenceCategory)
        : evidenceCategory(object.focus.evidence)))
    || object.analysis != null && (!record(object.analysis)
      || typeof object.analysis.interpretationRevision !== "string" || !object.analysis.interpretationRevision
      || ("indexedRunId" in object.analysis
        ? typeof object.analysis.indexedRunId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(object.analysis.indexedRunId)
          || object.analysis.interpretationRevision !== MAINTENANCE_REVISION
          || typeof object.analysis.policyDigest !== "string" || typeof object.analysis.corpusDigest !== "string"
          || !/^[a-f0-9]{64}$/.test(object.analysis.policyDigest) || !/^[a-f0-9]{64}$/.test(object.analysis.corpusDigest)
          || "generation" in object.analysis || "captureDigest" in object.analysis
        : !Number.isSafeInteger(object.analysis.generation) || object.analysis.generation < 1
          || !digest(object.analysis.captureDigest) || object.analysis.interpretationRevision === MAINTENANCE_REVISION
          || object.analysis.policyDigest != null && !digest(object.analysis.policyDigest)))) {
    throw new Error("[pi-nav:malformed_output] ranked cursor descriptor is invalid or oversized");
  }
  return object;
}

export type IndexedGraphProjection = { nodeKinds?: string[] } & (
  | { operation: "search"; testOnly?: boolean }
  | { operation: "traverse"; depth?: number }
  | { operation: "callers"; depth?: number }
  | { operation: "callees" }
  | { operation: "impact"; files: string[]; depth?: number }
);

/** Read an existing indexed graph for retained consumers. Missing preparation
 * is not permission to create it, and explicit legacy ownership never changes.
 * Numbered slicing stays with pagePreparedEvidence, not this reader. */
export async function callIndexedGraphNavigation(
  request: { root: string; query: string; projection: IndexedGraphProjection; signal?: AbortSignal; timeoutMs?: number; runId?: string },
  callNative: PiNavCaller = callPiNav,
): Promise<NativeOutput | undefined> {
  const started = performance.now();
  const remaining = () => {
    request.signal?.throwIfAborted();
    const timeout = Math.floor((request.timeoutMs ?? 25_000) - (performance.now() - started));
    if (timeout <= 0) throw new Error("[pi-nav:deadline] indexed graph query deadline exceeded");
    return timeout;
  };
  remaining();
  const root = realpathSync(request.root);
  const owner = detectProjectRoot(root);
  if (owner.confidence === "low" || realpathSync(owner.root) !== root) return undefined;
  // Metadata validation before any indexed read: malformed, aliased or oversized
  // candidate metadata refuses here instead of being treated as absent.
  const { inspectCodeMaintenanceOwner } = await import("./prepared-mutation.ts");
  inspectCodeMaintenanceOwner(root);
  const { loadNavigationAutomationConfig } = await import("./navigation-automation-config.ts");
  const loaded = loadNavigationAutomationConfig();
  if (loaded.loadFailed) throw new Error("Machine indexed storage configuration is unavailable");
  const { deriveAnalysisProject, analysisProjectPaths, validateAnalysisProjectFiles } = await import("./analysis-project.mjs");
  const project = deriveAnalysisProject(root, loaded.config.storage.indexRoot);
  if (!existsSync(path.join(project.directory, MAINTENANCE_STATUS_FILE))) return undefined;
  // Resolve ownership first so deleted-only legacy reviews keep their path, but
  // do not send an invalid empty impact query to the indexed reader.
  if (request.projection.operation === "impact" && (!Array.isArray(request.projection.files)
    || request.projection.files.length < 1 || request.projection.files.length > 128)) {
    throw new Error("Indexed impact requires 1–128 current file seeds");
  }
  const { compileLaneCorpusPolicy, enumerateNavigationCorpus } = await import("./navigation-corpus-policy.ts");
  compileLaneCorpusPolicy(root, undefined, "code");
  const census = await enumerateNavigationCorpus(root, "code", callNative, { signal: request.signal, timeoutMs: remaining() });
  const admission: RankedCorpusAdmission = { root, files: census.files, policyDigest: census.digest, policyFiles: census.policyFiles };
  const selected = analysisProjectPaths(project, false);
  const before = validateAnalysisProjectFiles(selected);
  const query = request.projection.operation === "impact" ? "current-file impact" : request.query;
  const output = await callNative({ root, operation: "pi_nav_search", signal: request.signal, timeoutMs: remaining(), args: {
    query, scope: root, analysisProjection: request.projection,
    analysisDatabase: selected.database, analysisRevision: MAINTENANCE_REVISION,
    analysisCorpusFiles: census.files, analysisPolicyDigest: census.digest, corpusAdmission: admission,
    ...(request.runId ? { analysisRunId: request.runId } : {}),
    ...(request.projection.operation === "search" ? { analysisModelDirectory: analysisSemanticModelDirectory() } : {}),
  } });
  const after = validateAnalysisProjectFiles(selected);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Indexed graph identity changed during read");
  await validateRankedCorpus({ corpusAdmission: admission }, callNative, { signal: request.signal, timeoutMs: remaining() });
  const data = output.structured.data;
  const analysis = data.analysis as Record<string, unknown> | undefined;
  if (data.mode !== "analysis_projection" || data.operation !== request.projection.operation
    || data.query !== query || !["ok", "not_found", "ambiguous", "incomplete"].includes(String(data.status))
    || ![data.nodes, data.edges, data.candidates, data.roots].every(Array.isArray)
    || !analysis || analysis.interpretationRevision !== MAINTENANCE_REVISION || analysis.policyDigest !== census.digest
    || typeof analysis.indexedRunId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(analysis.indexedRunId)
    || typeof analysis.indexedStatusDigest !== "string" || !/^[a-f0-9]{64}$/i.test(analysis.indexedStatusDigest)
    || request.runId !== undefined && analysis.indexedRunId !== request.runId) {
    throw new Error("[pi-nav:malformed_output] indexed graph projection or completed-run identity is unavailable");
  }
  return Object.defineProperty({ ...output, sourceRoot: root }, "corpusAdmission", { value: admission });
}

/** Project directory Matches needs policy, not preparation's sampled file eligibility. */
async function callAdmittedMatches(request: Parameters<PiNavCaller>[0], callNative: PiNavCaller): Promise<NativeOutput> {
  const deadline = performance.now() + (request.timeoutMs ?? 25_000);
  const remaining = () => { request.signal?.throwIfAborted(); const left = Math.floor(deadline - performance.now());
    if (left <= 0) throw new Error("[pi-nav:deadline] Matches admission deadline exceeded"); return left; };
  const cursor = request.args.renderMatches ?? request.args.cursor;
  let admission: MatchesAdmission | undefined;
  let root = request.root;
  if (typeof cursor === "string") {
    const owner = await callNative({ ...request, operation: "pi_nav_grep_cursor_owner", args: { cursor }, timeoutMs: remaining() });
    if (owner.structured.data.ownsCursor !== true) throw new Error("[pi-nav:domain] Matches cursor is unavailable; restart the audit");
    admission = owner.structured.data.matchesAdmission as MatchesAdmission | undefined;
    if (!admission) throw new Error("[pi-nav:domain] Matches cursor lacks ownership admission; restart the audit");
    root = owner.sourceRoot ?? root;
  } else {
    const selectors = request.args.paths;
    const paths = Array.isArray(selectors) ? selectors : [selectors ?? request.args.scope ?? "."];
    admission = { owners: [], directories: {}, explicitFiles: [], ...(request.args.visibility === "all" ? { allVisibility: true } : {}) };
    const { compileLaneCorpusPolicy } = await import("./navigation-corpus-policy.ts");
    for (const selector of paths) {
      remaining();
      if (typeof selector !== "string") throw new Error("[pi-nav:invalid_argument] invalid Matches selector");
      let canonical: string;
      try { canonical = realpathSync(path.resolve(root, selector)); }
      catch (error: any) { if (["ENOENT", "ENOTDIR"].includes(error?.code)) continue; throw error; }
      const kind = statSync(canonical);
      if (kind.isFile()) { admission.explicitFiles.push(canonical); continue; }
      if (!kind.isDirectory()) continue;
      const ownerRoot = realpathSync(detectProjectRoot(canonical).root);
      let index = admission.owners.findIndex(owner => owner.root === ownerRoot);
      if (index < 0) {
        const snapshot = compileLaneCorpusPolicy(ownerRoot, undefined, "code", { allowDisabledCode: true });
        index = admission.owners.length;
        admission.owners.push({ root: snapshot.root, policy: snapshot.policy as unknown as Record<string, unknown>,
          policyDigest: snapshot.digest, policyFiles: snapshot.policyFiles });
      }
      admission.directories[canonical] = index;
    }
    admission.explicitFiles = [...new Set(admission.explicitFiles)];
    if (Buffer.byteLength(JSON.stringify(admission)) > 128 * 1024) throw new Error("[pi-nav:domain] Matches policy metadata exceeds the private bound");
  }
  if (admission && typeof cursor === "string") await validateMatchesCorpus({ matchesAdmission: admission }, callNative,
    { signal: request.signal, timeoutMs: remaining() });
  const output = await callNative({ ...request, root, timeoutMs: remaining(),
    args: { ...request.args, ...(admission && typeof cursor !== "string" ? { matchesAdmission: admission } : {}) } });
  if (!admission) return output;
  const sealed = Object.defineProperty({ ...output }, "matchesAdmission", { value: admission });
  await validateRankedCorpus(sealed, callNative, { signal: request.signal, timeoutMs: remaining() });
  return sealed;
}

async function validateMatchesCorpus(output: Pick<NativeOutput, "matchesAdmission" | "sourceSnapshots">, callNative: PiNavCaller,
  options: { signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
  const admission = output.matchesAdmission;
  if (!admission) return;
  const { compileLaneCorpusPolicy, enumerateNavigationCorpus } = await import("./navigation-corpus-policy.ts");
  const deadline = performance.now() + (options.timeoutMs ?? 25_000);
  const allowed = new Set(admission.explicitFiles);
  for (let index = 0; index < admission.owners.length; index++) {
    options.signal?.throwIfAborted();
    const owner = admission.owners[index];
    const current = compileLaneCorpusPolicy(owner.root, undefined, "code", { allowDisabledCode: true });
    if (current.root !== owner.root || current.digest !== owner.policyDigest) throw new Error("[pi-nav:domain] Matches policy changed; restart the audit");
    const timeoutMs = Math.floor(deadline - performance.now());
    if (timeoutMs <= 0) throw new Error("[pi-nav:deadline] Matches readmission deadline exceeded");
    const census = await enumerateNavigationCorpus(owner.root, "code", callNative,
      { ...options, timeoutMs, allowDisabledCode: true, metadataOnly: true, visibility: admission.allVisibility ? "all" : "project" });
    if (census.digest !== owner.policyDigest) throw new Error("[pi-nav:domain] Matches policy changed during readmission");
    const directories = Object.entries(admission.directories).filter(([, ownerIndex]) => ownerIndex === index).map(([directory]) => directory);
    for (const directory of directories) if (realpathSync(directory) !== directory || realpathSync(detectProjectRoot(directory).root) !== owner.root) {
      throw new Error("[pi-nav:domain] Matches directory owner changed; restart the audit");
    }
    for (const relative of census.files) {
      const file = path.join(owner.root, relative);
      if (directories.some(directory => file.startsWith(`${directory}${path.sep}`))) allowed.add(file);
    }
    if (compileLaneCorpusPolicy(owner.root, undefined, "code", { allowDisabledCode: true }).digest !== owner.policyDigest) {
      throw new Error("[pi-nav:domain] Matches policy changed during readmission");
    }
  }
  if (output.sourceSnapshots?.some(source => !allowed.has(source.canonicalPath))) throw new Error("[pi-nav:domain] Matches source admission was revoked; restart the audit");
}

/** Live navigation is independent; selected prepared evidence may enrich it, never gate it. */
export async function callAnalysisNavigation(
  request: Parameters<PiNavCaller>[0],
  project: AnalysisProject | undefined = undefined,
  callNative: PiNavCaller = callPiNav,
): Promise<NativeOutput> {
  if (request.operation === "pi_nav_search" && (request.args.output === "matches" || typeof request.args.renderMatches === "string"
    || typeof request.args.cursor === "string" && request.args.cursor.startsWith("grep-") && !request.args.cursor.startsWith("grep-ranked-"))) return callAdmittedMatches(request, callNative);
  if (request.operation !== "pi_nav_search") return callNative(request);
  const automatic = project === undefined;
  const renderOnly = typeof request.args.renderRanked === "string";
  const cursorId = renderOnly ? request.args.renderRanked : request.args.cursor;
  const continuation = typeof cursorId === "string";
  const started = performance.now();
  const remaining = () => {
    request.signal?.throwIfAborted();
    const timeout = Math.floor((request.timeoutMs ?? 25_000) - (performance.now() - started));
    if (timeout <= 0) throw new Error("[pi-nav:deadline] navigation query deadline exceeded");
    return timeout;
  };
  const { analysisRelation: relation, ...liveArgs } = request.args;
  for (const key of Object.keys(liveArgs)) {
    if (key.startsWith("analysis") || ["captureRanked", "resumeRanked", "corpusAdmission"].includes(key)) delete liveArgs[key];
  }
  if (relation && typeof liveArgs.query === "string" && liveArgs.query.includes("::")) {
    const separator = liveArgs.query.indexOf("::");
    const head = liveArgs.query.slice(0, separator);
    const symbol = liveArgs.query.slice(separator + 2);
    if (!symbol.trim()) throw new Error("[pi-nav:invalid_argument] qualified relation target requires a nonempty symbol");
    const namedPath = path.resolve(request.root, head);
    const fileExists = existsSync(namedPath) && statSync(namedPath).isFile();
    // Namespace qualification is identity, not permission to search its last token.
    const fileLike = fileExists || /[\\/]/.test(head);
    if (fileLike) {
      if (!fileExists) throw new Error("[pi-nav:domain] qualified relation target file is unavailable; no live identity was approximated");
      liveArgs.query = symbol;
      liveArgs.scope = namedPath;
    }
  }
  const description = continuation ? await callNative({ ...request, operation: "pi_nav_grep_cursor_owner",
    args: { cursor: cursorId }, timeoutMs: remaining() }) : undefined;
  if (description && description.structured.data.ownsCursor !== true) throw new Error("[pi-nav:domain] cursor is unknown, expired, or evicted; restart the search");
  const cursor = description ? rankedCursorDescriptor(description) : undefined;
  if (cursor && request.args.contextLines !== undefined) throw new Error("[pi-nav:invalid_argument] contextLines is valid only for Matches continuation");
  // All visibility relaxes ignores, never project ownership. It has no prepared
  // enrichment, but retained captures still require the original admission.
  if (cursor?.visibility === "all" && cursor.analysis) throw new Error("[pi-nav:malformed_output] all-visibility cursor has conflicting prepared evidence");
  if (description && !cursor?.corpusRoot) throw new Error("[pi-nav:domain] ranked cursor lacks corpus admission; restart the query");
  const allVisibility = (cursor?.visibility ?? liveArgs.visibility) === "all";
  const textSearch = ["content", "regex"].includes(String(liveArgs.kind));
  const corpusOptions = { metadataOnly: textSearch || allVisibility, visibility: allVisibility ? "all" as const : "project" as const };

  // Privacy admission precedes all live source collection. Prepared readiness
  // is a separate, optional decision and cannot authorize a wider baseline.
  const requestedPath = realpathSync(path.resolve(request.root, String(cursor?.scope ?? liveArgs.scope ?? ".")));
  // An exact text-file selector is deliberate, not a directory-policy bypass.
  // Keep its existing exemption while directory scans remain admitted below.
  if (textSearch && statSync(requestedPath).isFile()) {
    return callNative({ ...request, args: { ...liveArgs, scope: requestedPath }, timeoutMs: remaining() });
  }
  const owner = detectProjectRoot(requestedPath);
  let selectedRoot = project ? realpathSync(project.root) : undefined;
  const withinSelected = selectedRoot !== undefined && (requestedPath === selectedRoot || requestedPath.startsWith(`${selectedRoot}${path.sep}`));
  // A query may inspect an explicitly selected unconfigured folder; admitting
  // that fallback root does not activate it or authorize background preparation.
  const admittedRoot = owner.confidence === "low" && withinSelected ? selectedRoot! : realpathSync(owner.root);
  if (cursor?.corpusRoot && cursor.corpusRoot !== admittedRoot) throw new Error("[pi-nav:domain] owning project changed; restart within the intended project");
  const { compileLaneCorpusPolicy, enumerateNavigationCorpus } = await import("./navigation-corpus-policy.ts");
  const census = await enumerateNavigationCorpus(admittedRoot, "code", callNative,
    { ...corpusOptions, allowDisabledCode: true, signal: request.signal, timeoutMs: remaining() });
  const local = path.relative(admittedRoot, requestedPath).split(path.sep).join("/");
  if (local && !census.files.some(file => file === local || file.startsWith(`${local}/`))) throw new Error("[pi-nav:domain] requested path is outside the admitted text corpus");
  const admission: RankedCorpusAdmission = { root: admittedRoot, files: census.files, policyDigest: census.digest, policyFiles: census.policyFiles };
  const seal = (output: NativeOutput): NativeOutput => Object.defineProperties({ ...output }, {
    corpusAdmission: { value: admission }, corpusOptions: { value: corpusOptions },
  });
  const assertCurrent = () => validateRankedCorpus({ corpusAdmission: admission, corpusOptions }, callNative, { signal: request.signal, timeoutMs: remaining() });
  const transport = { ...request, root: admittedRoot };
  if (!continuation) {
    liveArgs.scope = requestedPath;
    // Admission and focus must use the same path namespace (e.g. /var aliases
    // /private/var on macOS). Native still enforces scope and corpus membership.
    const focus = liveArgs.focus;
    if (focus && typeof focus === "object" && !Array.isArray(focus)) {
      const target = (focus as Record<string, unknown>).target;
      if (typeof target === "string") {
        const separator = target.indexOf("::");
        const file = target.slice(0, separator);
        if (separator > 0 && path.isAbsolute(file) && !file.split(/[\\/]/).includes("..")) {
          try { liveArgs.focus = { ...focus, target: `${realpathSync(file)}${target.slice(separator)}` }; }
          catch (error: any) { if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error; }
        }
      }
    }
  }
  liveArgs.corpusAdmission = admission;
  if (textSearch || allVisibility) {
    const output = await callNative({ ...transport, args: liveArgs, timeoutMs: remaining() });
    await assertCurrent();
    return seal(output);
  }
  if (!project) {
    try {
      const { loadNavigationAutomationConfig } = await import("./navigation-automation-config.ts");
      const loaded = loadNavigationAutomationConfig();
      if (loaded.loadFailed) throw new Error("Invalid machine storage configuration");
      const { deriveAnalysisProject } = await import("./analysis-project.mjs");
      const derived = deriveAnalysisProject(admittedRoot, loaded.config.storage.indexRoot);
      project = { root: derived.root, directory: derived.directory, kind: "indexed" };
      selectedRoot = admittedRoot;
    } catch {
      if (cursor?.corpusRoot) throw new Error("[pi-nav:domain] machine storage configuration is unavailable; restart after correcting it");
      const output = await callNative({ ...transport, args: liveArgs, timeoutMs: remaining() });
      await assertCurrent();
      const diagnostic = "Prepared connections unavailable: machine storage configuration is unavailable; using live navigation.";
      return seal({ ...output, text: `${output.text}\n${diagnostic}`,
        structured: { ...output.structured, diagnostics: [...output.structured.diagnostics, diagnostic] } });
    }
    // Presence is only a routing hint. Native owns ready-run, identity and corpus
    // validation. Missing data never triggers query-time creation or repair.
    if (!cursor?.corpusRoot && !existsSync(path.join(project.directory, MAINTENANCE_STATUS_FILE))) {
      const output = await callNative({ ...transport, args: liveArgs, timeoutMs: remaining() });
      await assertCurrent();
      return seal(output);
    }
  }
  if (continuation && !cursor?.analysis) {
    const output = await callNative({ ...transport, args: liveArgs, timeoutMs: remaining() });
    await assertCurrent();
    const diagnostic = "Prepared connections unavailable in this retained live capture; no new search or enrichment was run.";
    return seal({ ...output, text: `${output.text}\n${diagnostic}`,
      structured: { ...output.structured, diagnostics: [...output.structured.diagnostics, diagnostic] } });
  }
  const filtered = Array.isArray(liveArgs.glob) ? liveArgs.glob.length > 0 : Boolean(liveArgs.glob);
  const capture = !continuation && !relation && !filtered;
  const collected = description ?? await callNative({ ...transport, args: { ...liveArgs, ...(capture ? { captureRanked: true } : {}) }, timeoutMs: remaining() });
  await assertCurrent();
  const { searchCapture, searchCaptureUnavailable: _unavailable, ...cleanBaseline } = collected;
  const baseline = seal(cleanBaseline);
  let resumeAttempted = false;
  const live = async (reason: string): Promise<NativeOutput> => {
    await assertCurrent();
    if (continuation) throw new Error(`[pi-nav:domain] ranked continuation is no longer valid: ${reason}; restart the query`);
    const diagnostic = `Prepared connections unavailable: ${reason}; this result uses policy-admitted live navigation only.`;
    return seal({ ...baseline, ...(resumeAttempted ? { sourceSnapshots: undefined } : {}), text: `${baseline.text}\n${diagnostic}`,
      structured: { ...baseline.structured, diagnostics: [...baseline.structured.diagnostics, diagnostic] } });
  };
  const rankedIntent = baseline.structured.data.kind === "symbol" || baseline.structured.data.kind === "fuzzy";
  if (!continuation && !rankedIntent) return live("this request has no eligible ranked intent");
  if (filtered) return live("this request uses filtered search");
  if (admittedRoot !== selectedRoot) return live("requested path belongs to another project; no ancestor graph was opened");
  try {
    // The default compiler still enforces preparation-disabled for every existing
    // preparation caller. Only live admission explicitly bypasses that readiness gate.
    compileLaneCorpusPolicy(admittedRoot, undefined, "code");
    // The native transaction owns SQL identity/schema/publication validation.
    // A better-sqlite3 metadata read here races its independent WAL bookkeeping.
    const { analysisProjectPaths, validateAnalysisProjectFiles } = await import("./analysis-project.mjs");
    const selected = analysisProjectPaths(project, false);
    const before = validateAnalysisProjectFiles(selected);
    resumeAttempted = searchCapture !== undefined;
    const output = await callNative({ ...transport, timeoutMs: Math.max(1, Math.floor(remaining() / 2)), args: {
      ...(continuation ? liveArgs : searchCapture ? { ...liveArgs, resumeRanked: searchCapture } : { ...request.args, scope: requestedPath }),
      corpusAdmission: admission,
      analysisDatabase: selected.database, analysisRevision: project.kind === "indexed" ? MAINTENANCE_REVISION : ANALYSIS_REVISION,
      analysisCorpusFiles: census.files,
      ...(project.kind === "indexed" ? { analysisPolicyDigest: census.digest } : {}),
      ...(!continuation && (project.kind === "indexed" ? request.args.kind !== "symbol" : !!project.modelDirectory)
        ? { analysisModelDirectory: project.kind === "indexed" ? analysisSemanticModelDirectory() : project.modelDirectory } : {}),
    } });
    const after = validateAnalysisProjectFiles(selected);
    if (before.dev !== after.dev || before.ino !== after.ino) return live("database identity changed during read");
    await assertCurrent();
    // Transport permits both private fields only for an empty, incomplete refusal.
    // It carries no prepared rows; publication/admission were checked above.
    if (continuation && output.rankedRenderCursor && output.rankedRenderUnavailable) {
      if (output.rankedRenderCursor !== cursorId) return live("returned refusal changed the original progress handle");
      return seal(output);
    }
    const evidence = output.structured.data.analysis as Record<string, unknown> | undefined;
    if (!evidence || relation && evidence.relation !== relation) return live("no supported prepared response for this request");
    if (continuation) {
      const pinned = cursor!.analysis!;
      const sameRun = "indexedRunId" in pinned
        ? evidence.indexedRunId === pinned.indexedRunId && evidence.corpusDigest === pinned.corpusDigest
          && !Object.hasOwn(evidence, "generation") && !Object.hasOwn(evidence, "captureDigest")
        : evidence.generation === pinned.generation && evidence.captureDigest === pinned.captureDigest
          && !Object.hasOwn(evidence, "indexedRunId");
      if (!sameRun || output.structured.data.mode !== "ranked" || output.structured.data.query !== cursor!.query
        || evidence.interpretationRevision !== pinned.interpretationRevision
        || (evidence.policyDigest ?? null) !== (pinned.policyDigest ?? null)) return live("returned page does not match the frozen investigation");
    }
    return continuation ? seal(output) : Object.defineProperty(seal(output), "liveFallback", { value: baseline });
  } catch (error: any) {
    return live(error?.code === "ENOENT" ? "project has not been prepared" : error instanceof Error ? error.message : "selected evidence could not be validated");
  }
}

/** Re-admit before certification/fallback; this never opens a graph or prepares data. */
export async function validateRankedCorpus(output: Pick<NativeOutput, "corpusAdmission" | "corpusOptions" | "matchesAdmission" | "sourceSnapshots">, callNative: PiNavCaller, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  await validateMatchesCorpus(output, callNative, options);
  const admission = output.corpusAdmission;
  if (!admission) return;
  if (realpathSync(admission.root) !== admission.root) throw new Error("[pi-nav:domain] ranked corpus root changed");
  const { enumerateNavigationCorpus } = await import("./navigation-corpus-policy.ts");
  const current = await enumerateNavigationCorpus(admission.root, "code", callNative, { ...options, ...output.corpusOptions, allowDisabledCode: true });
  if (current.digest !== admission.policyDigest || JSON.stringify(current.files) !== JSON.stringify(admission.files)) {
    throw new Error("[pi-nav:domain] ranked corpus changed; restart the query without reusing the old baseline");
  }
}

type NativeSession = {
  call(
    operation: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

type NativeAddon = {
  getBuildInfo(): unknown;
  PiNavSession: new (root: string) => NativeSession;
};

type RootState = {
  session: NativeSession;
  tail: Promise<void>;
};

type GlobalState = {
  loadPromise?: Promise<{ addon: NativeAddon; target: PiNavTarget }>;
  roots: Map<string, RootState>;
};

export function resolvePiNavTarget(
  platform = process.platform,
  arch = process.arch,
): PiNavTarget {
  if (platform === "darwin" && arch === "arm64") {
    return { platform, arch, releaseKey: "darwin-arm64", rustTarget: "aarch64-apple-darwin" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { platform, arch, releaseKey: "darwin-x64", rustTarget: "x86_64-apple-darwin" };
  }
  if (platform === "linux" && arch === "arm64") {
    return { platform, arch, releaseKey: "linux-arm64", rustTarget: "aarch64-unknown-linux-gnu" };
  }
  if (platform === "linux" && arch === "x64") {
    return { platform, arch, releaseKey: "linux-x64", rustTarget: "x86_64-unknown-linux-gnu" };
  }
  throw new Error(`[pi-nav:unsupported_target] unsupported platform/architecture: ${platform}/${arch}`);
}

export function piNavArtifactPaths(extensionRoot: string, target: PiNavTarget): ArtifactPaths {
  return {
    addon: path.join(
      extensionRoot,
      "native",
      "pi-nav",
      "native",
      `pi_nav.${target.releaseKey}.node`,
    ),
    cli: path.join(extensionRoot, "native", "pi-nav", "bin", target.rustTarget, executableName(target)),
  };
}

/** One package-owned location shared by indexed producer and query. No lookup,
 * provisioning or repository configuration is performed here. */
export function analysisSemanticModelDirectory(): string {
  return path.join(EXTENSION_ROOT, "native", "analysis", "runtime", SEMANTIC_MODEL_DIRECTORY);
}

/** Native owns the recipe; code preparation needs it even for an empty corpus.
 * Reading build metadata creates no source session and loads no model assets. */
export async function getPiNavSemanticInfo(): Promise<{ recipe: string; dimensions: 256 }> {
  const state = globalState();
  state.loadPromise ??= loadAddon();
  const { addon } = await state.loadPromise;
  const info = validateBuildInfo(addon.getBuildInfo(), packageVersion(), resolvePiNavTarget(), true);
  return { recipe: info.semanticRecipe!, dimensions: 256 };
}

/** Metadata-only readiness: no project session, scan, model load or repair. */
export async function assertPiNavGrepAvailable(): Promise<void> {
  const state = globalState();
  state.loadPromise ??= loadAddon();
  const { addon } = await state.loadPromise;
  const info = validateBuildInfo(addon.getBuildInfo(), packageVersion(), resolvePiNavTarget());
  const missing = PI_NAV_GREP_CAPABILITIES.filter(capability => !info.capabilities.includes(capability));
  if (missing.length) {
    throw new Error(`[pi-nav:incompatible_addon] Grep is unavailable: the loaded native addon lacks ${missing.join(", ")}. `
      + "Replace the matching addon/CLI through the package build or delivery flow, then fully restart Pi. "
      + "Restarting unchanged binaries or changing search arguments cannot fix this. No automatic repair or unrestricted fallback was attempted.");
  }
}

export async function callPiNav({
  root,
  operation,
  args,
  timeoutMs,
  signal,
}: {
  root: string;
  operation: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<NativeOutput> {
  if (signal?.aborted) throw abortError(signal.reason);
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("[pi-nav:invalid_argument] arguments must be an object");
  }
  if (Object.hasOwn(args, "root")) {
    throw new TypeError("[pi-nav:invalid_argument] caller-supplied root is not allowed");
  }
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 0xffff_ffff)) {
    throw new TypeError("[pi-nav:invalid_argument] timeoutMs must be an unsigned 32-bit integer");
  }

  if (Object.hasOwn(args, "capturedSource")
    && (!["pi_nav_symbol_range", "pi_nav_read", "pi_nav_semantic_inputs"].includes(operation) || Object.hasOwn(args, "cursor"))) {
    throw new Error("[pi-nav:invalid_argument] supplied-source parsing does not support this operation or a cursor");
  }
  const absoluteDeadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;

  const state = globalState();
  state.loadPromise ??= loadAddon();
  const { addon } = await state.loadPromise;
  // Extension reloads preserve this global state and Node cannot unload an already
  // dlopen'd addon safely. Revalidate on every call so a rebuilt/stale major fails
  // explicitly and directs the operator to restart Pi instead of misrouting args.
  const buildInfo = addon.getBuildInfo();
  validateBuildInfo(buildInfo, packageVersion(), resolvePiNavTarget());
  if (Object.hasOwn(args, "matchesAdmission") || typeof args.renderMatches === "string"
      || typeof args.cursor === "string" && args.cursor.startsWith("grep-") && !args.cursor.startsWith("grep-ranked-")) {
    if (operation !== "pi_nav_search" && operation !== "pi_nav_grep_cursor_owner") {
      throw new TypeError("[pi-nav:invalid_argument] Matches admission and continuation require a Matches search or cursor-owner operation");
    }
    if (!(buildInfo as BuildInfo).capabilities.includes("matches_corpus_v1")) {
      throw new Error("[pi-nav:incompatible_addon] Matches corpus admission is unavailable: the loaded native addon lacks matches_corpus_v1. "
        + "This is a source/addon compatibility mismatch, not a pattern or paths formatting error. "
        + "Reloading unchanged binaries or rewriting the request cannot repair it. "
        + "With approval, stop Pi, replace the installed pi-nav addon/CLI with matching verified artifacts, then restart Pi. "
        + "No unrestricted fallback is allowed; no repair was attempted.");
    }
  }
  if (Object.hasOwn(args, "corpusAdmission") && (!(buildInfo as BuildInfo).capabilities.includes("ranked_corpus_v1")
    || !["pi_nav_search", "pi_nav_source_proof"].includes(operation))) {
    throw new Error("[pi-nav:incompatible_addon] ranked corpus admission is unavailable; no unrestricted fallback is allowed");
  }
  if ((operation === "pi_nav_semantic_encode" || args.analysisModelDirectory !== undefined)
    && !(buildInfo as BuildInfo).capabilities.includes("semantic_encode_v1")) {
    throw new Error("[pi-nav:incompatible_addon] local semantic encoding is unavailable in the loaded addon");
  }
  if (operation === "pi_nav_semantic_inputs" && !(buildInfo as BuildInfo).capabilities.includes("semantic_inputs_v1")) {
    throw new Error("[pi-nav:incompatible_addon] semantic source projection is unavailable in the loaded addon");
  }
  if (Object.hasOwn(args, "capturedSource") && !(buildInfo as BuildInfo).capabilities.includes("captured_source_v1")) {
    throw new Error("[pi-nav:incompatible_addon] supplied-source parsing is unavailable; no pathname fallback is allowed");
  }
  if (operation === "pi_nav_semantic_inputs" || operation === "pi_nav_semantic_encode" || args.analysisModelDirectory !== undefined) {
    validateBuildInfo(buildInfo, packageVersion(), resolvePiNavTarget(), true);
  }
  if (operation === "pi_nav_search" && args.focus !== undefined && !(buildInfo as BuildInfo).capabilities.includes("ranked_focus_v1")) {
    throw new Error("[pi-nav:incompatible_addon] focused ranked navigation is unavailable in the loaded addon; focus was not ignored");
  }
  if (["retainRankedRender", "renderRanked", "rankedRenderAllowance"].some(key => Object.hasOwn(args, key))
    && (operation !== "pi_nav_search" || !(buildInfo as BuildInfo).capabilities.includes("ranked_render_v1"))) {
    throw new Error("[pi-nav:incompatible_addon] retained ranked rendering is unavailable; no recollection fallback is allowed");
  }
  if (["retainMatchesRender", "renderMatches", "matchesRenderBytes"].some(key => Object.hasOwn(args, key))
    && (operation !== "pi_nav_search" || !(buildInfo as BuildInfo).capabilities.includes("matches_render_v1"))) {
    throw new Error("[pi-nav:incompatible_addon] retained Matches rendering is unavailable; no rescan fallback is allowed");
  }
  if (args.resumeRanked !== undefined && !(buildInfo as BuildInfo).capabilities.includes("ranked_capture_v1")) {
    throw new Error("[pi-nav:incompatible_addon] ranked collection handoff is unavailable in the loaded addon");
  }
  // Older loaded addons keep their existing live/prepared path. The private
  // capture flag is optional and does not change normal compatibility gates.
  if (args.captureRanked !== undefined && !(buildInfo as BuildInfo).capabilities.includes("ranked_capture_v1")) {
    const { captureRanked: _capture, ...ordinaryArgs } = args;
    args = ordinaryArgs;
  }

  const invoke = async (owner: RootState, nativeOperation: string, nativeArgs: Record<string, unknown>) => {
    if (signal?.aborted) throw abortError(signal.reason);
    const remainingTimeoutMs = absoluteDeadline === undefined
      ? undefined
      : Math.ceil(absoluteDeadline - performance.now());
    if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
      throw new Error("[pi-nav:deadline] operation deadline exceeded while queued or locating a cursor");
    }
    const controller = signal ? new AbortController() : undefined;
    const forwardAbort = () => controller?.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      const output = await owner.session.call(nativeOperation, nativeArgs, remainingTimeoutMs, controller?.signal);
      return validateOutput(output, nativeOperation, Object.hasOwn(nativeArgs, "capturedSource"));
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
    }
  };

  let canonicalRoot: string;
  let rootState: RootState;
  const cursorId = typeof args.renderRanked === "string" ? args.renderRanked
    : typeof args.renderMatches === "string" ? args.renderMatches : args.cursor;
  if (operation === "pi_nav_grep_cursor_owner" || operation === "pi_nav_search" && typeof cursorId === "string") {
    if (!(buildInfo as BuildInfo).capabilities.includes("grep_cursor_owner_v1")) {
      throw new Error("[pi-nav:incompatible_addon] cursor routing requires grep_cursor_owner_v1; restart Pi after installing or rebuilding the matching addon");
    }
    let owner: [string, RootState] | undefined;
    let ownerDescription: NativeOutput | undefined;
    for (const entry of [...state.roots]) {
      // A read-only metadata lookup bypasses unrelated roots' query queues, not
      // the owning root's continuation queue. Rust alone owns cursor lifetime.
      const probe = await invoke(entry[1], "pi_nav_grep_cursor_owner", { cursor: cursorId });
      if (signal?.aborted) throw abortError(signal.reason);
      if (absoluteDeadline !== undefined && performance.now() >= absoluteDeadline) {
        throw new Error("[pi-nav:deadline] operation deadline exceeded while locating a cursor");
      }
      const owns = probe.structured.data.ownsCursor;
      if (typeof owns !== "boolean") throw new Error("[pi-nav:malformed_output] cursor ownership must be a boolean");
      const descriptor = rankedCursorDescriptor(probe);
      if (descriptor && !owns) throw new Error("[pi-nav:malformed_output] ranked descriptor has no cursor owner");
      if (owns) {
        if (owner) throw new Error("[pi-nav:domain] cursor ownership is ambiguous; restart the search");
        owner = entry;
        ownerDescription = probe;
      }
    }
    if (!owner) throw new Error("[pi-nav:domain] cursor is unknown, expired, or evicted; restart the search");
    [canonicalRoot, rootState] = owner;
    if (operation === "pi_nav_grep_cursor_owner") return { ...ownerDescription!, sourceRoot: canonicalRoot };
  } else {
    canonicalRoot = realpathSync.native(root);
    const existing = state.roots.get(canonicalRoot);
    rootState = existing ?? { session: new addon.PiNavSession(canonicalRoot), tail: Promise.resolve() };
    if (!existing) state.roots.set(canonicalRoot, rootState);
  }

  const run = rootState.tail.catch(() => undefined).then(async () => ({
    ...await invoke(rootState, operation, args), sourceRoot: canonicalRoot,
  }));
  rootState.tail = run.then(() => undefined, () => undefined);
  return run;
}

function executableName(target: PiNavTarget): string {
  return target.platform === "win32" ? "pi-nav.exe" : "pi-nav";
}

function globalState(): GlobalState {
  const globals = globalThis as typeof globalThis & { [STATE_SYMBOL]?: GlobalState };
  globals[STATE_SYMBOL] ??= { roots: new Map() };
  return globals[STATE_SYMBOL];
}

async function loadAddon(): Promise<{ addon: NativeAddon; target: PiNavTarget }> {
  const target = resolvePiNavTarget();
  const artifacts = piNavArtifactPaths(EXTENSION_ROOT, target);
  if (!existsSync(artifacts.addon)) {
    const sourceCheckout = existsSync(path.join(EXTENSION_ROOT, "native", "pi-nav", "Cargo.toml"));
    const guidance = sourceCheckout
      ? "run `npm run pi-nav:build` from the extension root"
      : "reinstall the verified jeito-codeweave-pi archive for this platform";
    throw new Error(`[pi-nav:missing_addon] missing ${artifacts.addon}; ${guidance}`);
  }
  const require = createRequire(import.meta.url);
  let loaded: unknown;
  try {
    loaded = require(artifacts.addon);
  } catch (error) {
    throw new Error(`[pi-nav:load_failed] failed to load ${artifacts.addon}: ${errorMessage(error)}`);
  }
  if (!loaded || typeof loaded !== "object") {
    throw new Error("[pi-nav:invalid_addon] native module did not export an object");
  }
  const addon = loaded as Partial<NativeAddon>;
  if (typeof addon.getBuildInfo !== "function" || typeof addon.PiNavSession !== "function") {
    throw new Error("[pi-nav:invalid_addon] required getBuildInfo/PiNavSession exports are missing");
  }
  const expectedVersion = packageVersion();
  validateBuildInfo(addon.getBuildInfo(), expectedVersion, target);
  return { addon: addon as NativeAddon, target };
}

function packageVersion(): string {
  const packagePath = path.join(EXTENSION_ROOT, "package.json");
  const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error("[pi-nav:package] package.json version is missing");
  }
  return parsed.version;
}

function validateBuildInfo(raw: unknown, expectedVersion: string, target: PiNavTarget, semanticRequired = false): BuildInfo {
  if (!raw || typeof raw !== "object") {
    throw new Error("[pi-nav:incompatible_addon] build info must be an object");
  }
  const info = raw as Partial<BuildInfo>;
  if (info.packageVersion !== expectedVersion) {
    throw new Error(
      `[pi-nav:incompatible_addon] package version ${String(info.packageVersion)} does not match ${expectedVersion}`,
    );
  }
  if (info.target !== target.rustTarget) {
    throw new Error(
      `[pi-nav:wrong_target] addon target ${String(info.target)} does not match ${target.rustTarget}`,
    );
  }
  if (info.addonApiVersion !== PI_NAV_ADDON_API_VERSION || info.resultSchemaVersion !== RESULT_SCHEMA_VERSION) {
    throw new Error(
      `[pi-nav:incompatible_addon] addon/result schema major is incompatible (expected ${PI_NAV_ADDON_API_VERSION}/${RESULT_SCHEMA_VERSION}, got ${String(info.addonApiVersion)}/${String(info.resultSchemaVersion)}); restart Pi after installing or rebuilding the matching addon`,
    );
  }
  if (!Array.isArray(info.capabilities) || !info.capabilities.every((item) => typeof item === "string")) {
    throw new Error("[pi-nav:incompatible_addon] capabilities must be a string array");
  }
  for (const required of PI_NAV_BASE_CAPABILITIES) {
    if (!info.capabilities.includes(required)) {
      throw new Error(`[pi-nav:incompatible_addon] missing required capability ${required}`);
    }
  }
  if (info.capabilities.includes("pi_nav_write")) {
    throw new Error("[pi-nav:write_capability] N-API addon must not expose pi_nav_write");
  }
  // Optional semantic metadata cannot gate ordinary live or supplied-source parsing.
  if (semanticRequired && (!info.capabilities.includes("semantic_encode_v1") || !info.capabilities.includes("semantic_inputs_v1")
    || typeof info.semanticRecipe !== "string" || !/^[a-f0-9]{64}$/.test(info.semanticRecipe)
    || info.semanticDimensions !== 256)) {
    throw new Error("[pi-nav:incompatible_addon] the loaded addon has no compatible semantic input recipe");
  }
  return info as BuildInfo;
}

function validateOutput(raw: unknown, operation: string, suppliedSource = false): NativeOutput {
  if (!raw || typeof raw !== "object") {
    throw new Error("[pi-nav:malformed_output] native result must be an object");
  }
  const output = raw as Partial<NativeOutput>;
  if (typeof output.text !== "string" || !output.structured || typeof output.structured !== "object") {
    throw new Error("[pi-nav:malformed_output] native result requires text and structured object");
  }
  const textBytes = new TextEncoder().encode(output.text).byteLength;
  if (textBytes > MAX_NATIVE_TEXT_BYTES) {
    throw new Error(`[pi-nav:response_too_large] native text exceeded ${MAX_NATIVE_TEXT_BYTES} bytes (got ${textBytes}); payload withheld`);
  }
  const supplied = suppliedSource || operation === "pi_nav_semantic_inputs";
  let currentAuthority = false;
  const structuredBytes = new TextEncoder().encode(JSON.stringify(output.structured, (key, value) => {
    // Inspect metadata fields, not matching words inside captured source strings.
    if (supplied && ["sourceHash", "verified", "sourceSnapshots"].includes(key)) currentAuthority = true;
    return value;
  })).byteLength;
  const structuredLimit = operation === "pi_nav_semantic_inputs" ? MAX_SEMANTIC_PROJECTION_BYTES : MAX_NATIVE_STRUCTURED_BYTES;
  if (structuredBytes > structuredLimit) {
    throw new Error(`[pi-nav:response_too_large] native structured output exceeded ${structuredLimit} bytes (got ${structuredBytes}); payload withheld`);
  }
  const structured = output.structured;
  if (structured.schemaVersion !== RESULT_SCHEMA_VERSION || structured.operation !== operation) {
    throw new Error("[pi-nav:malformed_output] structured schema/operation mismatch");
  }
  if (!structured.completeness || typeof structured.completeness !== "object") {
    throw new Error("[pi-nav:malformed_output] completeness must be an object");
  }
  for (const key of ["returned", "total", "omitted"]) {
    const value = structured.completeness[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
      throw new Error(`[pi-nav:malformed_output] completeness.${key} must be a safe non-negative integer`);
    }
  }
  if (!Array.isArray(structured.diagnostics) || !structured.diagnostics.every((item) => typeof item === "string")) {
    throw new Error("[pi-nav:malformed_output] diagnostics must be a string array");
  }
  if (supplied) {
    const data = structured.data;
    if (output.text !== "" || output.sourceSnapshots !== undefined
      || !data || typeof data !== "object" || Array.isArray(data) || data.basis !== "supplied"
      || typeof data.suppliedSourceHash !== "string" || !/^[a-f0-9]{64}$/i.test(data.suppliedSourceHash)
      || currentAuthority) {
      throw new Error("[pi-nav:malformed_output] supplied-source parsing must not return current-file authority");
    }
  }
  if (output.sourceSnapshots !== undefined) {
    if (!Array.isArray(output.sourceSnapshots) || !output.sourceSnapshots.every(isNativeSourceSnapshot)) {
      throw new Error("[pi-nav:malformed_output] sourceSnapshots must contain bounded source-proof records");
    }
    if (output.sourceSnapshots.length > MAX_SOURCE_PROOF_FILES) {
      throw new Error(`[pi-nav:malformed_output] sourceSnapshots exceeds the ${MAX_SOURCE_PROOF_FILES}-file limit`);
    }
    if (operation === "pi_nav_search" && output.sourceSnapshots.some(snapshot => Buffer.byteLength(snapshot.text, "utf8") > MAX_SOURCE_PROOF_FILE_BYTES)) {
      throw new Error(`[pi-nav:malformed_output] search sourceSnapshots exceeds the ${MAX_SOURCE_PROOF_FILE_BYTES}-byte per-file limit`);
    }
  }
  for (const key of ["searchCapture", "searchCaptureUnavailable", "rankedRenderCursor", "rankedRenderUnavailable", "matchesRenderCursor"] as const) {
    const value = output[key];
    if (value !== undefined && (operation !== "pi_nav_search" || typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 1024)) {
      throw new Error(`[pi-nav:malformed_output] ${key} must be a bounded private search string`);
    }
    if (Object.hasOwn(structured, key) || Object.hasOwn(structured.data ?? {}, key)) {
      throw new Error(`[pi-nav:malformed_output] ${key} must not enter structured metadata`);
    }
  }
  if (output.searchCapture !== undefined && output.searchCaptureUnavailable !== undefined) {
    throw new Error("[pi-nav:malformed_output] retained and refused search captures are mutually exclusive");
  }
  // A retained origin can survive an empty, refused projection. That is not a
  // retained/refused collection contradiction: no public progress is offered.
  if (output.rankedRenderCursor !== undefined && output.rankedRenderUnavailable !== undefined
    && (structured.completeness?.complete !== false || structured.completeness?.returned !== 0
      || !Array.isArray(structured.data?.sourceRows) || structured.data.sourceRows.length !== 0
      || structured.data?.cursor != null)) {
    throw new Error("[pi-nav:malformed_output] a retained refused render must be an empty incomplete page without a public cursor");
  }
  if (Object.prototype.hasOwnProperty.call(structured, "sourceSnapshots")) {
    throw new Error("[pi-nav:malformed_output] sourceSnapshots must not enter schema-v1 structured metadata");
  }
  return output as NativeOutput;
}

function isNativeSourceSnapshot(value: unknown): value is NativeSourceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<NativeSourceSnapshot>;
  return typeof snapshot.canonicalPath === "string"
    && typeof snapshot.text === "string"
    && /^[A-F0-9]{64}$/.test(String(snapshot.rawDigest ?? ""))
    && (snapshot.lineEnding === "lf" || snapshot.lineEnding === "crlf")
    && typeof snapshot.bom === "boolean";
}

function abortError(reason: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : "operation aborted");
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
