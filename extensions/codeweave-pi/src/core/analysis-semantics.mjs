// Bind exact native-projected inputs to the final published graph rows.
// Source interpretation and recipe ownership remain native; this adapter only
// checks the private protocol, hashes opaque input bytes and maintains store rows.
import { createHash } from "node:crypto";
import { INDEXED_SEMANTIC_KEY } from '../../native/analysis/identity.mjs';

export const SEMANTIC_DIMENSIONS = 256;
/** One native encode call accepts at most this many inputs... */
export const SEMANTIC_MAX_TEXTS = 16;
/** ...and at most this many UTF-8 bytes per input. */
export const SEMANTIC_MAX_TEXT_BYTES = 65_536;
export const SEMANTIC_VECTOR_BYTES = SEMANTIC_DIMENSIONS * 4;
// Match the native recipe's squared-norm boundary on the F32 values we store;
// applying this tolerance to the norm instead would admit incompatible vectors.
const NORMALIZATION_TOLERANCE = 1e-3;

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_PROJECTION_BYTES = 2 * 1024 * 1024;
const UNAVAILABLE = new Set(["unsupported", "ambiguous", "invalid_extent", "invalid_syntax", "kind_mismatch", "oversized", "output_limit"]);
const COVERAGE = new Set(["tsjs-source-owned", "legacy-outline-owned"]);
const hash = text => createHash("sha256").update(text).digest("hex");

// The store's own schema owns these objects: `nodes.semantic_input_digest` is a
// nullable TEXT binding and `semantic_features(input_digest PRIMARY KEY, vector
// BLOB)` carries a fixed-width CHECK. A store that predates them is never
// migrated here, so completion refuses it instead of guessing a shape.
const NODE_COLUMNS = "n.id, n.file_path, n.kind,"
  + " n.start_line, n.end_line, n.start_column, n.end_column";
// The completion plan must compare each rebuilt input against the binding it is
// about to satisfy, so the recorded digest travels with the row.
const MISSING_COLUMNS = `${NODE_COLUMNS}, n.semantic_input_digest`;

/** Whether this store was initialized with the semantic objects at all. */
export function semanticSchemaAvailable(database) {
  const column = database.prepare(
    "SELECT count(*) AS n FROM pragma_table_info('nodes') WHERE name = 'semantic_input_digest'").get();
  const table = database.prepare(
    "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'semantic_features'").get();
  return column.n === 1 && table.n === 1;
}

function pushRow(map, key, row) {
  const rows = map.get(key);
  if (rows) rows.push(row);
  else map.set(key, [row]);
}

function validInfo(info) {
  if (!info || typeof info.recipe !== "string" || !/^[a-f0-9]{64}$/.test(info.recipe) || info.dimensions !== SEMANTIC_DIMENSIONS) {
    throw new Error("Native semantic recipe metadata is invalid");
  }
}

const boundedString = (value, maximum) => typeof value === "string" && value.length > 0
  && value.isWellFormed() && Buffer.byteLength(value) <= maximum && !/\p{Cc}/u.test(value);
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
const fieldsOnly = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every(key => fields.includes(key));

/** Project one admitted file; graph display names never supply or veto text.
 * `project` is the existing native operation transport, not an encoder.
 * Impossible wire shapes stay unbound; protocol failures reject publication.
 */
export async function projectFileSemanticInputs(path, text, rows, info, project) {
  validInfo(info);
  const entries = new Map();
  if (!boundedString(path, 4096) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")
    || typeof text !== "string" || !text.isWellFormed() || Buffer.byteLength(text) > MAX_SOURCE_BYTES) return entries;
  const bytes = Buffer.from(text);
  const owners = [];
  const requested = new Set();
  for (const row of rows) {
    if (row.file_path !== path) throw new Error("Semantic owner belongs to a different captured file");
    if (!boundedString(row.id, 256) || !boundedString(row.kind, 64)
      || ![row.start_line, row.start_column, row.end_line, row.end_column].every(uint32)) continue;
    if (requested.has(row.id)) throw new Error("Duplicate semantic owner identity");
    requested.add(row.id);
    owners.push({ id: row.id, kind: row.kind, startLine: row.start_line, startColumn: row.start_column,
      endLine: row.end_line, endColumn: row.end_column });
  }
  for (const batch of batchSemanticInputs(owners)) {
    const output = await project({ path, capturedSource: { text }, owners: batch });
    if (!output || Buffer.byteLength(JSON.stringify(output)) > MAX_PROJECTION_BYTES || output.text !== "") {
      throw new Error("Invalid or oversized native semantic projection envelope");
    }
    const data = output.structured?.data;
    if (!fieldsOnly(data, ["basis", "path", "suppliedSourceHash", "recipe", "dimensions", "representation", "complete", "owners"])
      || data.basis !== "supplied" || data.path !== path || data.suppliedSourceHash !== hash(bytes)
      || data.recipe !== info.recipe || data.dimensions !== info.dimensions || !boundedString(data.representation, 256)
      || typeof data.complete !== "boolean" || !Array.isArray(data.owners) || data.owners.length !== batch.length) {
      throw new Error("Native semantic projection provenance or owner count does not match the capture");
    }
    const pending = new Set(batch.map(owner => owner.id));
    const accepted = new Map();
    for (const owner of data.owners) {
      if (!fieldsOnly(owner, ["id", "status", "syntax", "coverage", "input"]) || !pending.delete(owner.id)
        || (owner.status !== "ok" && !UNAVAILABLE.has(owner.status))) throw new Error("Invalid native semantic owner correlation or status");
      if (owner.syntax !== undefined) {
        const syntax = owner.syntax;
        const boundary = offset => Number.isSafeInteger(offset) && offset >= 0 && offset <= bytes.length
          && (offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80);
        if (!fieldsOnly(syntax, ["startByte", "endByte", "kind"]) || !boundary(syntax.startByte) || !boundary(syntax.endByte)
          || syntax.startByte >= syntax.endByte || !boundedString(syntax.kind, 256)) throw new Error("Invalid native semantic syntax identity");
      }
      if (owner.coverage !== undefined && !COVERAGE.has(owner.coverage)) throw new Error("Unknown native semantic coverage");
      if (owner.status !== "ok") {
        if (Object.hasOwn(owner, "input")) throw new Error("Unavailable native semantic owner supplied an input");
        continue;
      }
      if (!owner.syntax || !COVERAGE.has(owner.coverage) || typeof owner.input !== "string" || !owner.input.length
        || !owner.input.isWellFormed() || Buffer.byteLength(owner.input) > SEMANTIC_MAX_TEXT_BYTES) {
        throw new Error("Invalid or oversized native semantic input");
      }
      // Never parse/re-serialize: native owns the exact input representation.
      accepted.set(owner.id, { digest: createHash("sha256").update(info.recipe).update("\0").update(owner.input).digest("hex"), text: owner.input });
    }
    if (pending.size || data.complete !== data.owners.every(owner => owner.status === "ok")) throw new Error("Inconsistent native semantic completeness");
    for (const [id, entry] of accepted) entries.set(id, entry);
  }
  return entries;
}

function rowsByFile(database) {
  const rows = database.prepare(`SELECT ${NODE_COLUMNS} FROM nodes n ORDER BY n.file_path, n.start_line, n.start_column, n.id`).all();
  const grouped = new Map();
  for (const row of rows) pushRow(grouped, row.file_path, row);
  return grouped;
}

/** Code pass: rebuild one digest binding per addressable owner and keep only the
 * features those bindings reference. Unchanged owners keep their exact digest
 * (and therefore their vector); a recipe change moves every digest, so
 * incompatible values become unreferenced and are pruned here.
 */
export async function rebuildSemanticBindings(database, sources, info, project) {
  validInfo(info);
  // Caller owns the awaited publication transaction. Unsupported final nodes
  // must not retain an old binding when a helper is reused without row replacement.
  database.prepare("UPDATE nodes SET semantic_input_digest = NULL").run();
  const bind = database.prepare("UPDATE nodes SET semantic_input_digest = ? WHERE id = ?");
  let bound = 0;
  for (const [path, rows] of rowsByFile(database)) {
    const entries = await projectFileSemanticInputs(path, sources.get(path), rows, info, project);
    for (const [id, entry] of entries) bound += bind.run(entry.digest, id).changes;
  }
  database.prepare("DELETE FROM semantic_features WHERE input_digest NOT IN"
    + " (SELECT semantic_input_digest FROM nodes WHERE semantic_input_digest IS NOT NULL)").run();
  return bound;
}

/** Node-level coverage: unbound final nodes are explicitly unsupported, while
 * bound nodes lacking a vector are missing, not falsely ready.
 */
export function semanticCoverage(database) {
  const row = database.prepare(`SELECT
      (SELECT count(*) FROM nodes WHERE semantic_input_digest IS NOT NULL) AS bound,
      (SELECT count(*) FROM nodes WHERE semantic_input_digest IS NULL) AS unsupported,
      (SELECT count(*) FROM nodes n JOIN semantic_features f ON f.input_digest = n.semantic_input_digest) AS represented`).get();
  return { represented: row.represented, missing: row.bound - row.represented, unsupported: row.unsupported };
}

/** Semantic pass: the bound owners that still need a vector, each with the input
 * its digest promises. Rebuilding the input from the published rows and the
 * pinned capture is what proves the vector will belong to the recorded owner; a
 * mismatch is refused instead of stored under a stale digest.
 */
export async function semanticCompletionPlan(database, sources, info, project) {
  validInfo(info);
  const missing = database.prepare(`SELECT ${MISSING_COLUMNS} FROM nodes n
    LEFT JOIN semantic_features f ON f.input_digest = n.semantic_input_digest
    WHERE n.semantic_input_digest IS NOT NULL AND f.input_digest IS NULL
    ORDER BY n.file_path, n.start_line, n.start_column, n.id`).all();
  if (!missing.length) return [];
  const byFile = new Map();
  for (const row of missing) pushRow(byFile, row.file_path, row);
  const plan = [];
  for (const [path, rows] of byFile) {
    const entries = await projectFileSemanticInputs(path, sources.get(path), rows, info, project);
    for (const row of rows) {
      const entry = entries.get(row.id);
      if (!entry) throw new Error("Bound semantic input cannot be reproduced from the published capture");
      if (entry.digest !== row.semantic_input_digest) throw new Error("Semantic input no longer matches its published digest");
      plan.push({ id: row.id, digest: entry.digest, text: entry.text });
    }
  }
  return plan;
}

export function batchSemanticInputs(plan) {
  const batches = [];
  for (let index = 0; index < plan.length; index += SEMANTIC_MAX_TEXTS) batches.push(plan.slice(index, index + SEMANTIC_MAX_TEXTS));
  return batches;
}

export function semanticVectorBuffer(vector) {
  const buffer = Buffer.allocUnsafe(SEMANTIC_VECTOR_BYTES);
  for (let index = 0; index < SEMANTIC_DIMENSIONS; index++) buffer.writeFloatLE(vector[index], index * 4);
  return buffer;
}

/** Reject a native reply that cannot belong to this representation. A recipe or
 * dimension mismatch is an interface change, not a tolerable variation: storing
 * those vectors would corrupt reuse for every later pass.
 */
export function validateSemanticEncode(data, expected, info) {
  validInfo(info);
  if (!data || typeof data !== "object") throw new Error("Semantic encode returned no structured data");
  if (data.recipe !== info.recipe) throw new Error("Semantic encode does not match the pinned native recipe");
  if (data.dimensions !== SEMANTIC_DIMENSIONS) throw new Error(`Semantic encode returned ${String(data.dimensions)} dimensions; expected ${SEMANTIC_DIMENSIONS}`);
  if (!Array.isArray(data.vectors) || data.vectors.length !== expected) {
    throw new Error(`Semantic encode returned ${Array.isArray(data.vectors) ? data.vectors.length : "no"} vectors for ${expected} inputs`);
  }
  return data.vectors.map((vector, index) => {
    if (!Array.isArray(vector) || vector.length !== SEMANTIC_DIMENSIONS) {
      throw new Error(`Semantic encode vector ${index} does not carry ${SEMANTIC_DIMENSIONS} components`);
    }
    let squared = 0;
    for (const value of vector) {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Semantic encode vector ${index} is not finite`);
      const component = Math.fround(value);
      squared += component * component;
    }
    if (!(Math.abs(squared - 1) < NORMALIZATION_TOLERANCE)) {
      throw new Error(`Semantic encode vector ${index} is not normalized (sum squares ${squared.toFixed(6)})`);
    }
    return vector;
  });
}

/** Read compatibility only: existing stores are never repaired or migrated. */
export function indexedSemanticSchemaAvailable(database) {
  if (!semanticSchemaAvailable(database)) return false;
  const node = database.prepare("PRAGMA table_info(nodes)").all().find(column => column.name === 'semantic_input_digest');
  const features = database.prepare("PRAGMA table_info(semantic_features)").all();
  return node.type.toUpperCase() === 'TEXT' && node.notnull === 0 && features.length === 2
    && features.some(column => column.name === 'input_digest' && column.type.toUpperCase() === 'TEXT' && column.pk === 1)
    && features.some(column => column.name === 'vector' && column.type.toUpperCase() === 'BLOB' && column.notnull === 1 && column.pk === 0);
}

/** One child-owned, bounded pass on the donor's already-open connection.
 * No corpus capture, accumulated encoding plan, asynchronous transaction or
 * backfill scheduler. A partial pass deliberately does not certify its tail. */
export async function completeIndexedSemantics(database, { runId, info, project, encode, readSource, validate, remaining }) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId)) throw new Error('Invalid semantic maintenance run');
  validate();
  if (!indexedSemanticSchemaAvailable(database)) return { status: 'unavailable', reason: 'schema-unavailable' };
  if (info) validInfo(info);
  if (database.prepare('SELECT 1 FROM nodes n LEFT JOIN files f ON f.path=n.file_path WHERE f.path IS NULL LIMIT 1').get()) {
    throw new Error('Semantic owner has no indexed source');
  }
  const total = database.prepare('SELECT count(*) AS total FROM nodes').get().total;
  const previousValue = database.prepare('SELECT value FROM project_metadata WHERE key=?').get(INDEXED_SEMANTIC_KEY)?.value;
  let previous;
  try { previous = JSON.parse(previousValue); }
  catch { /* Missing or malformed completion metadata cannot authorize binding reuse. */ }
  const keepBindings = info && previous?.format === INDEXED_SEMANTIC_KEY
    && previous.recipe === info.recipe && previous.dimensions === info.dimensions;
  // Revoke the old receipt before touching bindings: a failed recipe transition
  // must not let its mixed intermediate rows inherit the previous recipe.
  database.prepare('DELETE FROM project_metadata WHERE key=?').run(INDEXED_SEMANTIC_KEY);
  if (!keepBindings) database.prepare('UPDATE nodes SET semantic_input_digest=NULL').run();
  const nextFile = database.prepare('SELECT path,content_hash FROM files WHERE path > ? ORDER BY path LIMIT 1');
  const page = database.prepare(`SELECT ${MISSING_COLUMNS} FROM nodes n WHERE n.file_path=? AND n.id>? ORDER BY n.id LIMIT ${SEMANTIC_MAX_TEXTS}`);
  const bind = database.prepare('UPDATE nodes SET semantic_input_digest=? WHERE id=?');
  const feature = database.prepare('SELECT vector FROM semantic_features WHERE input_digest=?');
  const store = database.prepare('INSERT OR REPLACE INTO semantic_features(input_digest,vector) VALUES (?,?)');
  const discardFeature = database.prepare('DELETE FROM semantic_features WHERE input_digest=?');
  let examined = 0;
  let examinedFile = '', examinedId = '';
  let reason = !info ? 'native-unavailable' : !encode ? 'model-unavailable' : 'coverage';
  let fileAfter = '';
  const currentSource = file => {
    validate();
    const text = readSource(file.path);
    if (text === undefined) return undefined; // bounded oversized-file refusal
    if (typeof text !== 'string' || !text.isWellFormed() || hash(text) !== file.content_hash) {
      throw new Error('Indexed semantic source changed during preparation');
    }
    return text;
  };
  const reusable = digest => {
    const bytes = feature.get(digest)?.vector;
    if (!bytes) return false;
    let valid = false;
    if (ArrayBuffer.isView(bytes) && bytes.byteLength === SEMANTIC_VECTOR_BYTES) {
      const buffer = Buffer.from(bytes);
      const vector = Array.from({ length: SEMANTIC_DIMENSIONS }, (_, index) => buffer.readFloatLE(index * 4));
      try { validateSemanticEncode({ ...info, vectors: [vector] }, 1, info); valid = true; }
      catch { /* Invalid cached features are missing work, never represented coverage. */ }
    }
    if (!valid) discardFeature.run(digest);
    return valid;
  };
  work: while (info) {
    validate();
    if (remaining() <= 0) { reason = 'budget'; break; }
    const file = nextFile.get(fileAfter);
    if (!file) break;
    fileAfter = file.path;
    let after = '';
    let text;
    let loaded = false;
    while (true) {
      validate();
      if (remaining() <= 0) { reason = 'budget'; break work; }
      const rows = page.all(file.path, after);
      if (!rows.length) break;
      after = rows.at(-1).id;
      if (!loaded) { text = currentSource(file); loaded = true; }
      // CodeGraph's node writers clear changed owners. The current source hash
      // and a valid vector still have to agree before an unchanged binding wins.
      const pending = rows.filter(row => text === undefined || !row.semantic_input_digest || !reusable(row.semantic_input_digest));
      if (!pending.length) {
        examined += rows.length; examinedFile = file.path; examinedId = after;
        continue;
      }
      database.transaction(() => { for (const row of pending) bind.run(null, row.id); })();
      let entries;
      try { entries = await projectFileSemanticInputs(file.path, text, pending, info, project); }
      catch (error) {
        validate();
        if (text !== undefined && currentSource(file) !== text) throw new Error('Indexed semantic source changed during projection');
        if (remaining() <= 0 && /^\[pi-nav:(?:domain\] \[pi-nav:)?deadline\]/.test(String(error?.message))) {
          reason = 'budget'; break work;
        }
        throw error;
      }
      validate();
      if (text !== undefined && currentSource(file) !== text) throw new Error('Indexed semantic source changed during projection');
      database.transaction(() => { for (const [id, entry] of entries) bind.run(entry.digest, id); })();
      examined += rows.length; examinedFile = file.path; examinedId = after;
      const missing = [...entries.values()].filter(entry => !reusable(entry.digest));
      if (!missing.length) continue;
      // Missing model assets prevent new encoding, not source/vector checks.
      // Continue checking later owners rather than discarding cached siblings.
      if (!encode) continue;
      if (remaining() <= 0) { reason = 'budget'; break work; }
      let encoded;
      try { encoded = await encode(missing.map(entry => entry.text)); }
      catch (error) {
        validate();
        if (currentSource(file) !== text) throw new Error('Indexed semantic source changed during encoding');
        const message = String(error?.message);
        const deadline = remaining() <= 0 && /^\[pi-nav:(?:domain\] \[pi-nav:)?deadline\]/.test(message);
        // Only recognized optional-runtime/asset failures may degrade. In
        // particular the outer native envelope validator can reject before
        // validateSemanticEncode ever sees a result.
        const unavailable = /^\[pi-nav:incompatible_addon\]/.test(message)
          || /^\[pi-nav:domain\] local model /.test(message);
        if (!deadline && !unavailable) throw error;
        reason = deadline ? 'budget' : 'model-unavailable';
        if (deadline) break work;
        encode = undefined;
        continue;
      }
      const vectors = validateSemanticEncode(encoded, missing.length, info);
      validate();
      if (currentSource(file) !== text) throw new Error('Indexed semantic source changed during encoding');
      database.transaction(() => {
        missing.forEach((entry, index) => store.run(entry.digest, semanticVectorBuffer(vectors[index])));
      })();
    }
  }
  validate();
  // Preserve the existing bounded-pass contract: old tail bindings were not
  // checked this run and cannot count as represented coverage in its receipt.
  if (examined < total) database.prepare(`UPDATE nodes SET semantic_input_digest=NULL
    WHERE file_path > ? OR (file_path = ? AND id > ?)`).run(examinedFile, examinedFile, examinedId);
  database.prepare('DELETE FROM semantic_features WHERE input_digest NOT IN (SELECT semantic_input_digest FROM nodes WHERE semantic_input_digest IS NOT NULL)').run();
  const coverage = semanticCoverage(database);
  const unexamined = total - examined;
  const complete = !!info && !!encode && reason === 'coverage' && unexamined === 0 && coverage.missing === 0 && coverage.unsupported === 0;
  const metadata = { format: INDEXED_SEMANTIC_KEY, runId, recipe: info?.recipe ?? null, dimensions: SEMANTIC_DIMENSIONS,
    status: complete ? 'available' : coverage.represented > 0 ? 'partial' : 'unavailable',
    reason: complete ? 'complete' : reason, examined, unexamined, represented: coverage.represented,
    missing: coverage.missing, unrepresented: coverage.unsupported };
  database.prepare('INSERT OR REPLACE INTO project_metadata(key,value,updated_at) VALUES (?,?,?)')
    .run(INDEXED_SEMANTIC_KEY, JSON.stringify(metadata), Date.now());
  return metadata;
}
