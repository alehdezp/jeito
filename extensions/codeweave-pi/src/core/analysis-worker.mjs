// Manually invoked maintenance child; project mode rechecks the shared census.
// The caller supplies captured bytes and a private database location outside source.
// Resolution reads only that capture; publication revalidates bytes and admission.
// One request is one pass: code extraction/publication (default) or semantic
// completion of an already published code generation.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, relative } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AnalysisDatabase } from './analysis-database.ts';
import { ANALYSIS_REVISION, KERNEL_VERSION } from '../../native/analysis/identity.mjs';
import { enumerateNavigationCorpus } from './navigation-corpus-policy.ts';
import { callPiNav, getPiNavSemanticInfo } from './pi-nav-native.ts';
import { resolvePreparationRoot } from './project-root.ts';
import { batchSemanticInputs, rebuildSemanticBindings, semanticCompletionPlan, semanticCoverage, semanticSchemaAvailable,
  semanticVectorBuffer, validateSemanticEncode, SEMANTIC_DIMENSIONS } from './analysis-semantics.mjs';
import { initializeAnalysisProject, readAnalysisProject } from './analysis-project.mjs';

const require = createRequire(import.meta.url);
const started = performance.now();
let stage = "request";
const pipe = new Worker(new URL('./analysis-parent-pipe.mjs', import.meta.url), { execArgv: [] });
pipe.on("error", () => fail(new Error("Analysis request worker failed")));
pipe.on("messageerror", () => fail(new Error("Analysis request could not be delivered")));
pipe.once("message", request => run(request).then(result => {
  writeSync(1, JSON.stringify(result) + "\n");
  process.exit(0);
}, fail));

function fail(error) {
  writeSync(2, JSON.stringify({ status: "failed", stage, message: String(error?.message ?? "Analysis failed").slice(0, 500) }) + "\n");
  process.exit(1);
}
const hash = value => createHash("sha256").update(value).digest("hex");

/** A commit that represented nothing new is not a publication. Thrown inside the
 * writer transaction so the pass reports the validated generation instead. */
const noSemanticWork = Symbol("analysis.semantic.no-work");

function localDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  try { return realpathSync(path) === path && statSync(path).isDirectory(); }
  catch { return false; }
}

async function run(request) {
  if (!request || typeof request.root !== "string" || !isAbsolute(request.root)
    || realpathSync(request.root) !== request.root || typeof request.database !== "string"
    || !isAbsolute(request.database) || (request.baseGeneration !== undefined
      && (!Number.isSafeInteger(request.baseGeneration) || request.baseGeneration < 0 || request.baseGeneration >= Number.MAX_SAFE_INTEGER))
    || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 1_200_000
    || (request.policyDigest !== undefined && (typeof request.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(request.policyDigest)))
    || (request.captureMode !== undefined && request.captureMode !== 'project')
    || (request.captureMode === 'project' && request.policyDigest === undefined)
    || !Array.isArray(request.files) || (!request.files.length && request.captureMode !== 'project') || request.files.length > 10_000) {
    throw new Error("Invalid captured-analysis request");
  }
  const semanticRequest = request.phase === "semantic";
  if (request.phase !== undefined && request.phase !== "code" && !semanticRequest) throw new Error("Invalid captured-analysis request");
  if (semanticRequest) {
    // Completion never guesses a model location and never looks one up.
    if (!localDirectory(request.modelDirectory) || (request.recipe !== undefined && (typeof request.recipe !== 'string' || !/^[a-f0-9]{64}$/.test(request.recipe)))) {
      throw new Error("Invalid captured-analysis semantic request");
    }
  } else if (request.modelDirectory !== undefined || request.recipe !== undefined) {
    throw new Error("Invalid captured-analysis request");
  }
  const outside = relative(request.root, request.database);
  if (!(outside === ".." || outside.startsWith("../"))) throw new Error("Candidate database must be outside captured source");
  if (request.baseGeneration === undefined) {
    // Initialization and metadata reads stay with this process's sole graph SQL
    // owner. Lower-level callers may still require a particular existing base.
    if (basename(request.database) !== 'graph.sqlite') throw new Error('Invalid analysis database location');
    const options = { root: request.root, directory: dirname(request.database) };
    const store = semanticRequest ? readAnalysisProject(options) : initializeAnalysisProject({ ...options,
      schemaPath: fileURLToPath(new URL('../../native/analysis/runtime/schema.sql', import.meta.url)) });
    if (store.database !== request.database || store.metadata.generation >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid analysis database or base generation');
    }
    request = { ...request, baseGeneration: store.metadata.generation };
  }
  // A lexically outside path can still alias a database inside the source tree.
  // Keep the initialized file identity through extraction and publication.
  const databaseIdentity = statSync(request.database);
  const validateDatabase = () => {
    const current = statSync(request.database);
    if (realpathSync(request.database) !== request.database || !current.isFile() || current.nlink !== 1
      || current.dev !== databaseIdentity.dev || current.ino !== databaseIdentity.ino) {
      throw new Error('Analysis database must remain a canonical single-link regular file');
    }
  };
  validateDatabase();
  const sources = new Map();
  for (const file of request.files) {
    if (!file || typeof file.path !== "string" || typeof file.text !== "string"
      || !(file.language === null || typeof file.language === "string") || sources.has(file.path)) {
      throw new Error("Invalid or duplicate captured source");
    }
    sources.set(file.path, file.text);
  }
  const checkDeadline = () => {
    if (performance.now() - started >= request.timeoutMs) throw new Error("Analysis deadline exceeded");
  };
  stage = "semantic recipe";
  // Build metadata requires neither model assets nor a dummy captured/encode call.
  const semanticInfo = await getPiNavSemanticInfo();
  const recipe = semanticInfo.recipe;
  checkDeadline();
  if (request.recipe !== undefined && request.recipe !== recipe) throw new Error("Requested semantic recipe is incompatible with the native runtime");
  const projectInputs = async args => {
    checkDeadline();
    const output = await callPiNav({ root: request.root, operation: 'pi_nav_semantic_inputs', args,
      timeoutMs: Math.max(1, Math.floor(request.timeoutMs - (performance.now() - started))) });
    checkDeadline();
    return output;
  };
  /** The stored record is the only authority for the published root, base
   * generation and producer interpretation. */
  const storedValue = connection => {
    const row = connection.prepare("SELECT value FROM project_metadata WHERE key = 'codeweave-pi.g1'").get();
    const value = row && JSON.parse(row.value);
    if (!value || value.root !== request.root || value.kernelVersion !== KERNEL_VERSION
      || value.generation !== request.baseGeneration
      || (value.interpretationRevision !== ANALYSIS_REVISION
        && !(value.generation === 0 && value.interpretationRevision === undefined))) {
      throw new Error('Analysis identity or base generation changed');
    }
    return value;
  };
  const publicationReceipt = value => {
    // The native reader consumes the manifest from this same committed record.
    // No maintained caller needs a second copy in the worker's status reply.
    const { sources: _manifest, semantic: _descriptor, ...rest } = value;
    return { ...rest, baseGeneration: request.baseGeneration };
  };
  const assertCapturedBytes = () => {
    checkDeadline();
    validateDatabase();
    for (const [name, text] of sources) {
      const path = resolve(request.root, name);
      if (realpathSync(path) !== path || !readFileSync(path).equals(Buffer.from(text))) {
        throw new Error("Captured source changed before publication");
      }
      checkDeadline();
    }
  };
  const validateAdmission = async () => {
    if (request.policyDigest === undefined) return;
    checkDeadline();
    const admission = await resolvePreparationRoot(request.root);
    if (!admission.allowed || admission.root !== request.root) throw new Error('Captured root is not admitted for preparation');
    const census = await enumerateNavigationCorpus(request.root, 'code', callPiNav, { timeoutMs: Math.max(1, Math.floor(request.timeoutMs - (performance.now() - started))) });
    const allowed = new Set(census.files);
    if (census.digest !== request.policyDigest || request.files.some(file => !allowed.has(file.path))
      || (request.captureMode === 'project' && allowed.size !== sources.size)) {
      throw new Error('Captured source is excluded, incomplete, or corpus policy changed');
    }
    checkDeadline();
  };
  // Capture-side admission and bytes are shared by both passes; only the code
  // pass additionally needs the extraction runtime and its captured filesystem.
  const validateCapturedBytes = () => { checkDeadline(); validateDatabase(); assertCapturedBytes(); };

  const core = require('../../native/analysis/runtime/core.cjs');
  if (core.ANALYSIS_REVISION !== ANALYSIS_REVISION || core.KERNEL_VERSION !== KERNEL_VERSION) {
    throw new Error('Analysis runtime interpretation does not match worker');
  }
  core.installSource(request.root, sources); // Validates normalized, in-root capture paths.
  const kernel = core.getKernel();
  if (!kernel || kernel.contractInfo().kernelVersion !== KERNEL_VERSION) throw new Error('Required owned kernel unavailable');
  const languages = new Set(kernel.contractInfo().languages);
  if (request.captureMode === 'project') {
    for (const file of request.files) {
      const language = core.detectLanguage(file.path, file.text);
      file.language = languages.has(language) ? language : null;
    }
  }
  const validateSource = () => { checkDeadline(); validateDatabase(); core.assertSourceBoundary(); assertCapturedBytes(); };
  const manifest = () => {
    const sourceManifest = request.files.map(file => ({ path: file.path, language: file.language, digest: hash(file.text) }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { sourceManifest, captureDigest: hash(JSON.stringify(sourceManifest.map(file => [file.path, file.language, file.digest]))) };
  };
  const semanticValue = connection => {
    const value = storedValue(connection);
    if (value.semantic?.recipe !== recipe || value.semantic?.dimensions !== SEMANTIC_DIMENSIONS) {
      throw new Error('Published semantic representation does not match the native recipe; publish code again before completing semantics');
    }
    if (value.captureDigest !== manifest().captureDigest
      || value.corpus !== (request.captureMode === 'project' ? 'project-capture' : 'explicit-capture')
      || (value.policyDigest ?? undefined) !== (request.policyDigest ?? undefined)) {
      throw new Error('Semantic completion requires the whole published capture and policy identity');
    }
    return value;
  };
  /** Repeat preparation of a capture this store already published has no work to
   * do: same bytes, same producer interpretation, same corpus policy and the same
   * representation recipe already describe the stored generation. Reporting that
   * honestly is not a commit, and it keeps the semantic follow-up cheap. */
  const unchangedPublication = captureDigest => {
    const connection = new Database(request.database, { readonly: true, fileMustExist: true, timeout: Math.min(request.timeoutMs, 5000) });
    try {
      if (!semanticSchemaAvailable(connection)) return undefined;
      const value = storedValue(connection);
      const semantic = value.semantic;
      if (value.captureDigest !== captureDigest
        || value.corpus !== (request.captureMode === 'project' ? 'project-capture' : 'explicit-capture')
        || (value.policyDigest ?? undefined) !== (request.policyDigest ?? undefined)
        || !semantic || semantic.recipe !== recipe || semantic.dimensions !== SEMANTIC_DIMENSIONS) return undefined;
      return { ...value, semantic: { ...semantic, ...semanticCoverage(connection), stored: 0 } };
    } finally { connection.close(); }
  };
  /** Pin the complete committed capture through semanticValue's manifest digest,
   * mode and policy checks. The files table contains extracted code bundles only;
   * language:null configuration sources still belong to the full capture. */
  const semanticPin = async () => {
    const connection = new Database(request.database, { readonly: true, fileMustExist: true, timeout: Math.min(request.timeoutMs, 5000) });
    try {
      if (!semanticSchemaAvailable(connection)) {
        throw new Error('Semantic features are unavailable: this store predates the semantic schema and is never migrated; initialize a fresh private store');
      }
      const value = semanticValue(connection);
      const coverage = semanticCoverage(connection);
      const plan = coverage.missing === 0 ? [] : await semanticCompletionPlan(connection, sources, semanticInfo, projectInputs);
      await validateAdmission();
      validateCapturedBytes();
      semanticValue(connection); // Recheck after awaited projections/admission, before encoding or no-work.
      return { value, coverage, plan };
    } finally { connection.close(); }
  };
  /** Semantic-only pass: encode the owners this generation still misses and
   * publish one generation for the vectors that arrived. Code rows are never
   * touched and no inference happens inside the writer transaction. */
  async function completeSemantics() {
    stage = "semantic capture";
    const pinned = await semanticPin();
    if (!pinned.plan.length) {
      stage = "semantic receipt";
      return { ...publicationReceipt(pinned.value), status: "unchanged", semantic: { ...pinned.value.semantic, ...pinned.coverage, stored: 0 } };
    }
    stage = "semantic encode";
    // Encoding must leave a publication window behind: a pass that spent the
    // whole deadline could never commit the vectors it validly produced.
    const publicationReserve = Math.min(5_000, Math.max(250, Math.floor(request.timeoutMs / 10)));
    const encodeBudget = () => {
      const budget = request.timeoutMs - publicationReserve - (performance.now() - started);
      return budget > 0 ? Math.floor(budget) : undefined;
    };
    const vectors = new Map();
    let failures = 0;
    let failure;
    for (const batch of batchSemanticInputs(pinned.plan)) {
      const budget = encodeBudget();
      if (budget === undefined) { failures += 1; failure = "semantic encode did not fit the preparation deadline"; break; }
      try {
        const output = await callPiNav({ root: request.root, operation: 'pi_nav_semantic_encode',
          args: { modelDirectory: request.modelDirectory, texts: batch.map(entry => entry.text) }, timeoutMs: budget });
        const decoded = validateSemanticEncode(output.structured.data, batch.length, semanticInfo);
        batch.forEach((entry, index) => vectors.set(entry.digest, semanticVectorBuffer(decoded[index])));
      } catch (error) {
        // Keep what already validated; a systematically broken model directory
        // must not consume the rest of the deadline batch by batch.
        failures += 1;
        failure = String(error?.message ?? error).slice(0, 300);
        break;
      }
    }
    if (!vectors.size) throw new Error(`Semantic completion produced no valid vectors: ${failure ?? "no encodable inputs"}`);
    stage = "semantic publication";
    const connection = new Database(request.database, { fileMustExist: true, timeout: Math.min(request.timeoutMs, 5000) });
    const database = new AnalysisDatabase(connection);
    try {
      storedValue(database); // Reject foreign state before changing connection/journal settings.
      database.pragma("foreign_keys = ON");
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      const diagnose = semantic => failures ? { ...semantic, failures, failure } : semantic;
      try {
        return await database.publish(async () => {
          const current = semanticValue(database); // Writer-held generation, recipe and whole-capture identity.
          checkDeadline();
          const before = semanticCoverage(database);
          if (before.missing === 0) throw noSemanticWork;
          const insert = database.prepare('INSERT OR IGNORE INTO semantic_features (input_digest, vector) VALUES (?, ?)');
          let stored = 0;
          for (const [digest, vector] of vectors) stored += insert.run(digest, vector).changes;
          const coverage = semanticCoverage(database);
          if (coverage.represented === before.represented) throw noSemanticWork;
          const semantic = { recipe, dimensions: SEMANTIC_DIMENSIONS, ...coverage };
          const metadata = { ...current, generation: request.baseGeneration + 1, semantic };
          const receipt = { ...publicationReceipt(metadata), status: "published", semantic: diagnose({ ...semantic, stored }) };
          if (Buffer.byteLength(JSON.stringify(receipt)) + 1 > 65_536) throw new Error('Analysis publication exceeds its response boundary');
          database.prepare("UPDATE project_metadata SET value = ?, updated_at = ? WHERE key = 'codeweave-pi.g1'")
            .run(JSON.stringify(metadata), Date.now());
          return receipt;
        }, async () => { await validateAdmission(); validateCapturedBytes(); }, new AbortController().signal);
      } catch (error) {
        if (error !== noSemanticWork) throw error;
        // Nothing was written and nothing remains missing: report the validated
        // same generation instead of inventing a commit.
        await validateAdmission();
        validateCapturedBytes();
        const current = semanticValue(database);
        if (current.generation !== request.baseGeneration) throw new Error('Analysis generation advanced during semantic completion');
        return { ...publicationReceipt(current), status: "unchanged", semantic: diagnose({ ...current.semantic, ...semanticCoverage(database), stored: 0 }) };
      }
    } finally { database.close(); }
  }

  // Both passes use the runtime/capture initialization above. Only the code pass
  // extracts and resolves graph rows; semantic inference runs outside publication.
  if (semanticRequest) {
    stage = "semantic admission";
    await validateAdmission();
    stage = "semantic source validation";
    validateCapturedBytes();
    return await completeSemantics();
  }

  stage = "corpus admission";
  await validateAdmission();
  stage = "source validation";
  validateSource();
  const { sourceManifest, captureDigest } = manifest();
  stage = "publication probe";
  const unchanged = unchangedPublication(captureDigest);
  if (unchanged) {
    const { stored, ...descriptor } = unchanged.semantic;
    return { ...publicationReceipt(unchanged), status: "unchanged", semantic: { ...descriptor, stored } };
  }
  stage = "extraction";
  const bundles = [];
  for (const file of request.files) {
    checkDeadline();
    if (file.language === null) continue;
    if (!languages.has(file.language)) throw new Error("Captured language is unavailable in this kernel");
    const extracted = core.decodeExtractBuffers(kernel.extractFile(file.path, file.text, file.language), file.path, file.language);
    // Only this explicit coverage gap may publish: its call/reference site is
    // retained as a file diagnostic, never attached to an invented caller.
    // Parse failures and every other diagnostic still reject the publication.
    if (extracted.errors.some(error => error.severity !== 'warning' || error.code !== 'unrepresented_reference_origin')) {
      throw new Error("Captured source extraction was incomplete");
    }
    if (new Set(extracted.nodes.map(node => node.id)).size !== extracted.nodes.length) throw new Error("Extraction returned duplicate identities");
    bundles.push({
      nodes: extracted.nodes, edges: extracted.edges,
      refs: extracted.unresolvedReferences.map(ref => ({ ...ref, filePath: file.path, language: file.language })),
      file: { path: file.path, contentHash: hash(file.text), language: file.language, size: Buffer.byteLength(file.text),
        modifiedAt: statSync(resolve(request.root, file.path)).mtimeMs, indexedAt: Date.now(), nodeCount: extracted.nodes.length,
        ...(extracted.errors.length ? { errors: extracted.errors } : {}) },
    });
  }
  stage = "publication";
  validateDatabase();
  const connection = new Database(request.database, { fileMustExist: true, timeout: Math.min(request.timeoutMs, 5000) });
  const database = new AnalysisDatabase(connection);
  try {
    storedValue(database); // Reject foreign state before changing connection/journal settings.
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    const queries = new core.QueryBuilder(database);
    return await database.publish(async () => {
      storedValue(database); // The writer lock, not the preflight read, protects the base.
      checkDeadline();
      database.exec("DELETE FROM edges; DELETE FROM unresolved_refs; DELETE FROM nodes; DELETE FROM files; DELETE FROM name_segment_vocab;");
      for (const bundle of bundles) { checkDeadline(); queries.storeFileBundle(bundle); }
      const resolver = new core.ReferenceResolver(request.root, queries);
      resolver.initialize();
      resolver.runPostExtract();
      // No resolver pool: every pass must see this connection's uncommitted facts.
      await resolver.resolveAndPersistBatched(checkDeadline, 5000, checkDeadline);
      // Resolve first: these are the FINAL rows, including resolver-generated
      // nodes. Await pure source projection under the existing writer boundary;
      // protocol faults roll back last-good state, unsupported owners stay NULL.
      // This extends lock duration but never loads a model or performs inference.
      let semantic;
      if (semanticSchemaAvailable(database)) {
        checkDeadline();
        await rebuildSemanticBindings(database, sources, semanticInfo, projectInputs);
        checkDeadline();
        semantic = { recipe, dimensions: SEMANTIC_DIMENSIONS, ...semanticCoverage(database) };
      }
      const metadata = {
        root: request.root, generation: request.baseGeneration + 1, kernelVersion: KERNEL_VERSION, captureDigest,
        interpretationRevision: ANALYSIS_REVISION,
        ...(request.policyDigest === undefined ? {} : { policyDigest: request.policyDigest }),
        corpus: request.captureMode === 'project' ? 'project-capture' : 'explicit-capture', codeFiles: bundles.length, capturedFiles: sources.size,
        ...(semantic ? { semantic } : {}),
        sources: sourceManifest,
        nodes: database.prepare("SELECT count(*) AS n FROM nodes").get().n,
        unresolvedReferences: database.prepare("SELECT count(*) AS n FROM unresolved_refs").get().n,
      };
      const receipt = { ...publicationReceipt(metadata), status: "published", ...(semantic ? { semantic: { ...semantic, stored: 0 } } : {}) };
      if (Buffer.byteLength(JSON.stringify(receipt)) + 1 > 65_536) throw new Error('Analysis publication exceeds its response boundary');
      database.prepare("UPDATE project_metadata SET value = ?, updated_at = ? WHERE key = 'codeweave-pi.g1'")
        .run(JSON.stringify(metadata), Date.now());
      return receipt;
    }, async () => { await validateAdmission(); validateSource(); }, new AbortController().signal);
  } finally { database.close(); }
}
