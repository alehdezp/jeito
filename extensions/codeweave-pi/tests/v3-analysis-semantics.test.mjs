import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { initializeAnalysisProject } from '../src/core/analysis-project.mjs';
import { prepareAnalysisProject } from '../src/core/native-maintenance.ts';
import { AnalysisDatabase } from '../src/core/analysis-database.ts';
import { batchSemanticInputs, projectFileSemanticInputs, rebuildSemanticBindings, semanticCompletionPlan, semanticCoverage,
  semanticSchemaAvailable, semanticVectorBuffer, validateSemanticEncode, SEMANTIC_DIMENSIONS, SEMANTIC_MAX_TEXT_BYTES,
  SEMANTIC_MAX_TEXTS, completeIndexedSemantics, indexedSemanticSchemaAvailable } from '../src/core/analysis-semantics.mjs';

const schemaPath = fileURLToPath(new URL('../native/analysis/schema.sql', import.meta.url));
const LINES = ['export class Cache {', '  get(key) {', '    return this.map.get(key);', '  }', '}',
  'export function helper() {', '  return 1;', '}'];
const TEXT = LINES.join('\n');
const classRow = (id = 'class') => ({ id, file_path: 'src/cache.ts', kind: 'class', name: 'Cache', qualified_name: 'Cache',
  signature: 'class Cache', docstring: 'A cache.', start_line: 1, start_column: 7, end_line: 5, end_column: 1 });
const methodRow = (id = 'method') => ({ id, file_path: 'src/cache.ts', kind: 'method', name: 'get', qualified_name: 'Cache::get',
  signature: 'get(key)', docstring: null, start_line: 2, start_column: 2, end_line: 4, end_column: 3 });
const helperRow = (id = 'helper') => ({ id, file_path: 'src/cache.ts', kind: 'function', name: 'helper', qualified_name: 'helper',
  signature: 'function helper()', docstring: null, start_line: 6, start_column: 7, end_line: 8, end_column: 1 });
const INFO = { recipe: 'a'.repeat(64), dimensions: 256 };
const digestOf = value => createHash('sha256').update(value).digest('hex');
// Canned native replies test this binding/protocol boundary only. These do not
// simulate a parser or worker; native source ownership has separate Rust proof.
const inputFor = (id, text) => JSON.stringify(['codeweave-pi-code-input-v1', 'src/cache.ts', id, 'function', '', '', text]);
function projection(args, info = INFO, statusFor = () => 'ok') {
  const owners = args.owners.map(owner => {
    const status = statusFor(owner);
    if (status !== 'ok') return { id: owner.id, status };
    return { id: owner.id, status, syntax: { startByte: 0, endByte: Buffer.byteLength(args.capturedSource.text), kind: 'function_declaration' },
      coverage: 'tsjs-source-owned', input: inputFor(owner.id, args.capturedSource.text) };
  });
  return { text: '', structured: { data: { basis: 'supplied', path: args.path, suppliedSourceHash: digestOf(args.capturedSource.text),
    recipe: info.recipe, dimensions: info.dimensions, representation: 'codeweave-pi-code-input-v1', complete: owners.every(owner => owner.status === 'ok'), owners } } };
}
const native = async args => projection(args);
const inputDigest = (input, info = INFO) => digestOf(info.recipe + '\0' + input);

function fixture(t) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'analysis-semantics-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'source');
  mkdirSync(root);
  const initial = initializeAnalysisProject({ root, directory: join(temporary, 'store'), schemaPath });
  const connection = new Database(initial.database);
  t.after(() => { if (connection.open) connection.close(); });
  return { root, initial, connection };
}

function insertNode(connection, row) {
  connection.prepare(`INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line,
    start_column, end_column, docstring, signature, updated_at)
    VALUES (@id, @kind, @name, @qualified_name, @file_path, 'typescript', @start_line, @end_line, @start_column, @end_column,
    @docstring, @signature, 1)`).run({ docstring: null, signature: null, ...row });
}

function insertFeature(connection, digest, vector = Buffer.alloc(1024)) {
  connection.prepare('INSERT INTO semantic_features (input_digest, vector) VALUES (?, ?)').run(digest, vector);
}

test('an empty final corpus uses supplied native metadata without dummy projection or encoding', async t => {
  const { connection } = fixture(t);
  const database = new AnalysisDatabase(connection);
  const forbidden = async () => { throw new Error('empty corpus must not invoke native projection'); };
  assert.equal(await database.publish(() => rebuildSemanticBindings(database, new Map(), INFO, forbidden), () => {}, new AbortController().signal), 0);
  assert.deepEqual(await semanticCompletionPlan(connection, new Map(), INFO, forbidden), []);
  assert.deepEqual(semanticCoverage(connection), { represented: 0, missing: 0, unsupported: 0 });
});

test('native bytes are opaque and recipe-domain bound; graph display fields do not enter projection', async () => {
  let request;
  const raw = String.raw`["codeweave-pi-code-input-v1","src/cache.ts","helper","function","","","\u03bb"]`;
  const rows = [{ ...helperRow(), name: '', qualified_name: '', signature: 'WRONG', docstring: 'WRONG' }];
  const project = async args => { request = args; const reply = projection(args); reply.structured.data.owners[0].input = raw; return reply; };
  const entries = await projectFileSemanticInputs('src/cache.ts', TEXT, rows, INFO, project);
  assert.deepEqual(Object.keys(request.owners[0]).sort(), ['endColumn', 'endLine', 'id', 'kind', 'startColumn', 'startLine']);
  assert.equal(request.owners[0].id, 'helper', 'an empty graph name cannot veto a source-addressable owner');
  assert.equal(entries.get('helper').text, raw);
  assert.equal(entries.get('helper').digest, inputDigest(raw));
  assert.notEqual(entries.get('helper').digest, inputDigest(JSON.stringify(JSON.parse(raw))));
  const other = { ...INFO, recipe: 'b'.repeat(64) };
  const rebound = await projectFileSemanticInputs('src/cache.ts', TEXT, rows, other, async args => {
    const reply = projection(args, other); reply.structured.data.owners[0].input = raw; return reply;
  });
  assert.equal(rebound.get('helper').text, raw);
  assert.notEqual(rebound.get('helper').digest, entries.get('helper').digest);
});

test('projection batches sixteen owners and filters only impossible wire shapes/resources', async () => {
  const calls = [];
  const rows = Array.from({ length: 33 }, (_, i) => ({ ...helperRow(String(i)), name: '' }));
  rows.push({ ...helperRow('too-long'), id: 'x'.repeat(257) }, { ...helperRow('bad-coordinate'), start_line: -1 });
  const entries = await projectFileSemanticInputs('src/cache.ts', TEXT, rows, INFO, async args => { calls.push(args); return projection(args); });
  assert.deepEqual(calls.map(args => args.owners.length), [16, 16, 1]);
  assert.equal(entries.size, 33);
  let called = false;
  const forbidden = async () => { called = true; throw new Error('must not project'); };
  assert.equal((await projectFileSemanticInputs('src/cache.ts', 'x'.repeat(8 * 1024 * 1024 + 1), [helperRow()], INFO, forbidden)).size, 0);
  assert.equal((await projectFileSemanticInputs('external.ts', undefined, [{ ...helperRow(), file_path: 'external.ts' }], INFO, forbidden)).size, 0);
  assert.equal(called, false);
});

test('every native unavailable status leaves the owner unbound without inventing text', async () => {
  for (const status of ['unsupported', 'ambiguous', 'invalid_extent', 'invalid_syntax', 'kind_mismatch', 'oversized', 'output_limit']) {
    const entries = await projectFileSemanticInputs('src/cache.ts', TEXT, [helperRow()], INFO, async args => projection(args, INFO, () => status));
    assert.equal(entries.size, 0, status);
  }
});

test('native provenance, correlation, syntax, completeness and byte limits fail closed', async () => {
  const faults = [
    d => { d.recipe = 'b'.repeat(64); }, d => { d.dimensions = 384; }, d => { d.basis = 'current'; },
    d => { d.path = 'other.ts'; }, d => { d.suppliedSourceHash = '0'.repeat(64); },
    d => { d.owners = []; }, d => { d.owners[0].id = 'foreign'; },
    d => { d.owners[1].id = d.owners[0].id; }, d => { d.owners[0].status = 'guessed'; },
    d => { delete d.owners[0].input; }, d => { delete d.owners[0].syntax; },
    d => { d.owners[0].syntax.endByte = Buffer.byteLength(TEXT) + 1; },
    d => { d.owners[0].coverage = 'guessed'; }, d => { d.complete = false; },
    d => { d.owners[0].input = 'x'.repeat(SEMANTIC_MAX_TEXT_BYTES + 1); },
    d => { d.owners[0].status = 'unsupported'; d.complete = false; },
    d => { d.sourceHash = 'pretend-current'; }, d => { d.owners[0].extra = true; },
  ];
  for (const fault of faults) {
    await assert.rejects(projectFileSemanticInputs('src/cache.ts', TEXT, [helperRow(), methodRow()], INFO, async args => {
      const reply = projection(args); fault(reply.structured.data); return reply;
    }), /native semantic/i);
  }
  await assert.rejects(projectFileSemanticInputs('src/cache.ts', TEXT, [helperRow()], INFO,
    async args => ({ ...projection(args), padding: 'x'.repeat(2 * 1024 * 1024) })), /oversized/);
});

test('final-node awaited publication tolerates unsupported owners and rolls back protocol faults', async t => {
  const { connection } = fixture(t);
  const database = new AnalysisDatabase(connection);
  const sources = new Map([['src/cache.ts', TEXT]]);
  await database.publish(async () => {
    insertNode(connection, helperRow());
    // A resolver-generated final row is not assumed absent or projected from an extraction bundle.
    insertNode(connection, { ...methodRow('resolver-final'), name: '' });
    insertNode(connection, { ...classRow('unsupported'), kind: 'file' });
    await rebuildSemanticBindings(database, sources, INFO, async args => {
      assert.equal(connection.inTransaction, true);
      assert.ok(args.owners.some(owner => owner.id === 'resolver-final'));
      await Promise.resolve();
      return projection(args, INFO, owner => owner.id === 'unsupported' ? 'unsupported' : 'ok');
    });
  }, () => {}, new AbortController().signal);
  assert.deepEqual(semanticCoverage(connection), { represented: 0, missing: 2, unsupported: 1 });
  const before = connection.prepare('SELECT id, semantic_input_digest FROM nodes ORDER BY id').all();
  await assert.rejects(database.publish(async () => {
    connection.exec('DELETE FROM nodes'); insertNode(connection, helperRow('replacement'));
    await rebuildSemanticBindings(database, sources, INFO, async args => {
      const reply = projection(args); reply.structured.data.suppliedSourceHash = '0'.repeat(64); return reply;
    });
  }, () => {}, new AbortController().signal), /provenance/);
  assert.deepEqual(connection.prepare('SELECT id, semantic_input_digest FROM nodes ORDER BY id').all(), before);
});

test('bindings reuse compatible features and retire changed, unsupported and foreign-recipe inputs', async t => {
  const { connection } = fixture(t);
  const database = new AnalysisDatabase(connection);
  const sources = new Map([['src/cache.ts', TEXT]]);
  insertNode(connection, helperRow()); insertNode(connection, methodRow()); insertNode(connection, classRow());
  const rebuild = (capture = sources, info = INFO, project = native) => database.publish(
    () => rebuildSemanticBindings(database, capture, info, project), () => {}, new AbortController().signal);
  assert.equal(await rebuild(), 3);
  const helperDigest = connection.prepare("SELECT semantic_input_digest AS d FROM nodes WHERE id = 'helper'").get().d;
  insertFeature(connection, helperDigest);
  assert.deepEqual(semanticCoverage(connection), { represented: 1, missing: 2, unsupported: 0 });
  await rebuild();
  assert.equal(connection.prepare('SELECT count(*) AS n FROM semantic_features').get().n, 1);
  await database.publish(async () => {
    connection.exec('DELETE FROM nodes');
    for (const row of [helperRow(), methodRow(), classRow()]) insertNode(connection, row);
    await rebuildSemanticBindings(database, sources, INFO, native);
  }, () => {}, new AbortController().signal);
  assert.equal(connection.prepare('SELECT count(*) AS n FROM semantic_features').get().n, 1, 'feature survives whole-row replacement');
  await rebuild(sources, INFO, async args => projection(args, INFO, owner => owner.id === 'helper' ? 'unsupported' : 'ok'));
  assert.equal(connection.prepare('SELECT count(*) AS n FROM semantic_features').get().n, 0);
  assert.equal(connection.prepare("SELECT semantic_input_digest AS d FROM nodes WHERE id = 'helper'").get().d, null);
  await rebuild(); insertFeature(connection, helperDigest);
  await rebuild(new Map([['src/cache.ts', TEXT.replace('return 1', 'return 2')]]));
  assert.equal(connection.prepare('SELECT count(*) AS n FROM semantic_features').get().n, 0);
  await rebuild(); insertFeature(connection, helperDigest);
  const changedRecipe = { ...INFO, recipe: 'b'.repeat(64) };
  await rebuild(sources, changedRecipe, async args => projection(args, changedRecipe));
  assert.equal(connection.prepare('SELECT count(*) AS n FROM semantic_features').get().n, 0);
});

test('completion reproduces exact bound native inputs and refuses missing or changed projections', async t => {
  const { connection } = fixture(t);
  const database = new AnalysisDatabase(connection);
  const sources = new Map([['src/cache.ts', TEXT]]);
  for (const row of [helperRow(), methodRow(), classRow()]) insertNode(connection, row);
  await database.publish(() => rebuildSemanticBindings(database, sources, INFO, native), () => {}, new AbortController().signal);
  const plan = await semanticCompletionPlan(connection, sources, INFO, native);
  assert.equal(plan.length, 3);
  for (const entry of plan) { assert.equal(entry.text, inputFor(entry.id, TEXT)); assert.equal(entry.digest, inputDigest(entry.text)); }
  insertFeature(connection, plan[0].digest);
  assert.equal((await semanticCompletionPlan(connection, sources, INFO, native)).length, 2);
  await assert.rejects(semanticCompletionPlan(connection, new Map(), INFO, native), /cannot be reproduced/);
  await assert.rejects(semanticCompletionPlan(connection, sources, INFO, async args => projection(args, INFO, () => 'unsupported')), /cannot be reproduced/);
  await assert.rejects(semanticCompletionPlan(connection, sources, INFO, async args => {
    const reply = projection(args); reply.structured.data.owners[0].input += ' '; return reply;
  }), /no longer matches/);
  connection.prepare("UPDATE nodes SET semantic_input_digest = 'tampered' WHERE id = 'method'").run();
  await assert.rejects(semanticCompletionPlan(connection, sources, INFO, native), /no longer matches/);
});

test('vectors are fixed-width F32 little-endian and the native reply is validated against the recipe', t => {
  const { connection } = fixture(t);
  assert.equal(SEMANTIC_DIMENSIONS * 4, 1024, 'the store CHECK owns the vector width');
  const vector = Array.from({ length: SEMANTIC_DIMENSIONS }, (_, index) => index === 0 ? 1 : 0);
  const buffer = semanticVectorBuffer(vector);
  assert.equal(buffer.length, 1024);
  assert.equal(buffer.readFloatLE(0), 1);
  // The schema refuses any other width, so the helper cannot store a shape a
  // reader would misread.
  const digest = digestOf('owner');
  connection.prepare('INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at, semantic_input_digest) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0, 5, 1, ?)')
    .run('owner', 'function', 'owner', 'owner', 'a.ts', 'typescript', digest);
  connection.prepare('INSERT INTO semantic_features (input_digest, vector) VALUES (?, ?)').run(digest, buffer);
  assert.deepEqual(connection.prepare('SELECT vector FROM semantic_features').get().vector, buffer);
  assert.throws(() => insertFeature(connection, 'short', Buffer.alloc(1023)), /CHECK constraint/);
  const accepted = validateSemanticEncode({ recipe: INFO.recipe, dimensions: SEMANTIC_DIMENSIONS, vectors: [vector] }, 1, INFO);
  assert.deepEqual(accepted, [vector]);
  const normalized = Array.from({ length: SEMANTIC_DIMENSIONS }, (_, index) => index === 0 ? 1 : 0);
  const baseline = { recipe: INFO.recipe, dimensions: SEMANTIC_DIMENSIONS, vectors: [normalized] };
  assert.throws(() => validateSemanticEncode({ ...baseline, recipe: 'other' }, 1, INFO), /does not match the pinned native recipe/);
  assert.throws(() => validateSemanticEncode({ ...baseline, dimensions: 384 }, 1, INFO), /expected 256/);
  assert.throws(() => validateSemanticEncode({ ...baseline, vectors: [] }, 1, INFO), /for 1 inputs/);
  assert.throws(() => validateSemanticEncode(baseline, 2, INFO), /for 2 inputs/);
  assert.throws(() => validateSemanticEncode({ ...baseline, vectors: [normalized.slice(1)] }, 1, INFO), /256 components/);
  const broken = normalized.slice();
  broken[1] = Number.NaN;
  assert.throws(() => validateSemanticEncode({ ...baseline, vectors: [broken] }, 1, INFO), /not finite/);
  const unnormalized = normalized.map(value => value * 2);
  assert.throws(() => validateSemanticEncode({ ...baseline, vectors: [unnormalized] }, 1, INFO), /not normalized/);
  // Norm error is below 0.001, but the native recipe checks squared-norm error.
  const betweenContracts = normalized.map(value => Math.fround(value * Math.sqrt(1.0015)));
  assert.throws(() => validateSemanticEncode({ ...baseline, vectors: [betweenContracts] }, 1, INFO), /not normalized/);
  assert.throws(() => validateSemanticEncode(undefined, 1, INFO), /no structured data/);
  assert.equal(semanticSchemaAvailable(connection), true);
  connection.exec('DROP TABLE semantic_features; ALTER TABLE nodes DROP COLUMN semantic_input_digest');
  assert.equal(semanticSchemaAvailable(connection), false);
});

test('encode batches respect the native input bound', () => {
  const plan = Array.from({ length: 33 }, (_, index) => ({ id: String(index), digest: digestOf(String(index)), text: 'x' }));
  assert.deepEqual(batchSemanticInputs(plan).map(batch => batch.length), [16, 16, 1]);
  assert.equal(SEMANTIC_MAX_TEXTS, 16);
  assert.deepEqual(batchSemanticInputs([]), []);
});

test('the semantic phase needs an explicit canonical model directory and a code pass refuses one', async t => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'analysis-phase-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'source');
  mkdirSync(root);
  const directory = join(temporary, 'store');
  const signal = new AbortController().signal;
  const file = join(temporary, 'not-a-directory');
  writeFileSync(file, 'model assets\n');
  // No model location is guessed, defaulted or looked up, and no store is created
  // for a request this module cannot honour.
  await assert.rejects(prepareAnalysisProject({ root, directory, phase: 'semantic' }, signal),
    /explicit canonical local model directory/);
  await assert.rejects(prepareAnalysisProject({ root, directory, phase: 'semantic', modelDirectory: join(temporary, 'absent') }, signal),
    /explicit canonical local model directory/);
  await assert.rejects(prepareAnalysisProject({ root, directory, phase: 'semantic', modelDirectory: file }, signal),
    /explicit canonical local model directory/);
  await assert.rejects(prepareAnalysisProject({ root, directory, modelDirectory: temporary }, signal),
    /only valid for semantic completion/);
  await assert.rejects(prepareAnalysisProject({ root, directory, phase: 'fuzzy' }, signal), /Invalid preparation phase/);
  assert.equal(existsSync(directory), false);
});

const RUN = '11111111-1111-4111-8111-111111111111';
const INDEXED_KEY = 'codeweave-pi.indexed-semantic.1';
function indexedFixture(t, count = 33) {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(readFileSync(new URL('../native/analysis/src/db/schema.sql', import.meta.url), 'utf8'));
  database.prepare('INSERT INTO files(path,content_hash,language,size,modified_at,indexed_at) VALUES (?,?,?,?,?,?)')
    .run('src/cache.ts', digestOf(TEXT), 'typescript', Buffer.byteLength(TEXT), 1, 1);
  for (let i = 0; i < count; i++) insertNode(database, helperRow(`owner-${String(i).padStart(3, '0')}`));
  const vector = Array(256).fill(0); vector[0] = 1;
  const batches = [];
  const options = { runId: RUN, info: INFO, project: async args => {
    assert.ok(args.owners.length <= 16); return projection(args);
  }, encode: async texts => {
    assert.equal(database.inTransaction, false, 'native awaits cannot occur in a synchronous transaction');
    assert.ok(texts.length <= 16); batches.push(texts.length);
    return { ...INFO, vectors: texts.map(() => vector) };
  }, readSource: path => { assert.equal(path, 'src/cache.ts'); return TEXT; }, validate: () => {}, remaining: () => 1000 };
  return { database, options, batches };
}

test('fresh indexed semantics streams bounded owners, reuses exact vectors and pins its run without G1', async t => {
  const { database, options, batches } = indexedFixture(t);
  assert.equal(indexedSemanticSchemaAvailable(database), true);
  const metadata = await completeIndexedSemantics(database, options);
  assert.deepEqual(batches, [16, 16, 1]);
  assert.equal(metadata.status, 'available'); assert.equal(metadata.represented, 33);
  assert.equal(metadata.examined, 33); assert.equal(metadata.unexamined, 0);
  assert.equal(metadata.runId, RUN);
  assert.equal(database.prepare("SELECT 1 FROM project_metadata WHERE key='codeweave-pi.g1'").get(), undefined);
  const nextRun = '22222222-2222-4222-8222-222222222222';
  let sourceReads = 0;
  const reused = await completeIndexedSemantics(database, { ...options, runId: nextRun,
    readSource: path => { sourceReads++; return options.readSource(path); },
    project: async () => assert.fail('unchanged certified bindings must not be reprojected'),
    encode: async () => assert.fail('identical exact-input vectors must be reused') });
  assert.equal(sourceReads, 1, 'reuse still verifies the current file bytes');
  assert.equal(reused.represented, 33); assert.equal(reused.runId, nextRun);
  assert.deepEqual(JSON.parse(database.prepare('SELECT value FROM project_metadata WHERE key=?').get(INDEXED_KEY).value), reused);
});

test('all maintained node writer paths invalidate only their changed semantic bindings', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'semantic-writer-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const outfile = join(temporary, 'queries.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../native/analysis/src/db/queries.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile });
  const { QueryBuilder } = createRequire(import.meta.url)(outfile);
  const { database, options } = indexedFixture(t, 4);
  await completeIndexedSemantics(database, options);
  const queries = new QueryBuilder(database);
  const before = queries.getNodeById('owner-000');
  queries.updateNode({ ...before, startLine: 2 });
  queries.insertNode(queries.getNodeById('owner-001'));
  queries.insertNodes([queries.getNodeById('owner-002')]);
  assert.deepEqual(database.prepare('SELECT id FROM nodes WHERE semantic_input_digest IS NULL ORDER BY id').all().map(row => row.id),
    ['owner-000', 'owner-001', 'owner-002']);
  const projected = [];
  const result = await completeIndexedSemantics(database, { ...options, project: async args => {
    projected.push(...args.owners.map(owner => owner.id)); return options.project(args);
  } });
  assert.deepEqual(projected, ['owner-000', 'owner-001', 'owner-002']);
  assert.equal(result.represented, 4);
});

test('recipe changes reproject all owners and a failed transition cannot reuse an older receipt', async t => {
  const { database, options } = indexedFixture(t, 2);
  await completeIndexedSemantics(database, options);
  const next = { ...INFO, recipe: 'b'.repeat(64) };
  let projected = 0;
  await assert.rejects(completeIndexedSemantics(database, { ...options, info: next,
    project: async args => { projected += args.owners.length; return projection(args, next); },
    encode: async () => { throw new Error('transition failed'); } }), /transition failed/);
  assert.equal(projected, 2);
  assert.equal(database.prepare('SELECT 1 FROM project_metadata WHERE key=?').get(INDEXED_KEY), undefined);
  projected = 0;
  const restored = await completeIndexedSemantics(database, { ...options,
    project: async args => { projected += args.owners.length; return options.project(args); } });
  assert.equal(projected, 2, 'failed mixed bindings need reprojection even when returning to the old recipe');
  assert.equal(restored.represented, 2);
  projected = 0;
  const changed = await completeIndexedSemantics(database, { ...options, info: next,
    project: async args => { projected += args.owners.length; return projection(args, next); },
    encode: async texts => ({ ...await options.encode(texts), ...next }) });
  assert.equal(projected, 2); assert.equal(changed.recipe, next.recipe); assert.equal(changed.represented, 2);
});

test('warm reuse still refuses changed source and withholds an unexamined budget tail', async t => {
  const { database, options } = indexedFixture(t);
  await completeIndexedSemantics(database, options);
  let budget = 1000;
  const partial = await completeIndexedSemantics(database, { ...options, remaining: () => budget,
    readSource: path => { budget = 0; return options.readSource(path); },
    project: async () => assert.fail('cached prefix must not project') });
  assert.equal(partial.represented, 16); assert.equal(partial.unexamined, 17);
  assert.equal(partial.status, 'partial'); assert.equal(partial.reason, 'budget');
  const projected = [];
  const resumed = await completeIndexedSemantics(database, { ...options, project: async args => {
    projected.push(...args.owners.map(owner => owner.id)); return options.project(args);
  } });
  assert.equal(projected.length, 17); assert.equal(resumed.represented, 33);
  await assert.rejects(completeIndexedSemantics(database, { ...options, readSource: () => 'changed',
    project: async () => assert.fail('stale source must refuse before projection') }), /source changed/);
  assert.equal(database.prepare('SELECT 1 FROM project_metadata WHERE key=?').get(INDEXED_KEY), undefined);
});

test('unavailable source or newly unsupported owners cannot keep an old binding', async t => {
  const { database, options } = indexedFixture(t, 2);
  await completeIndexedSemantics(database, options);
  database.prepare("UPDATE nodes SET semantic_input_digest=NULL WHERE id='owner-000'").run();
  const partial = await completeIndexedSemantics(database, { ...options,
    project: async args => { assert.deepEqual(args.owners.map(owner => owner.id), ['owner-000']); return projection(args, INFO, () => 'unsupported'); } });
  assert.equal(partial.represented, 1); assert.equal(partial.unrepresented, 1);
  const unavailable = await completeIndexedSemantics(database, { ...options, readSource: () => undefined,
    project: async () => assert.fail('unavailable source has no projection') });
  assert.equal(unavailable.represented, 0); assert.equal(unavailable.unrepresented, 2);
});

test('missing model retains verified cached owners, including siblings after a missing vector', async t => {
  const { database, options } = indexedFixture(t, 33);
  await completeIndexedSemantics(database, options);
  const warm = await completeIndexedSemantics(database, { ...options, encode: undefined,
    project: async () => assert.fail('verifying retained vectors needs no model or projection') });
  assert.equal(warm.represented, 33); assert.equal(warm.examined, 33);
  assert.equal(warm.status, 'partial'); assert.equal(warm.reason, 'model-unavailable');
  database.prepare("UPDATE nodes SET semantic_input_digest=NULL WHERE id='owner-000'").run();
  const projected = [];
  const changed = await completeIndexedSemantics(database, { ...options, encode: undefined,
    project: async args => { projected.push(...args.owners.map(owner => owner.id)); return options.project(args); } });
  assert.deepEqual(projected, ['owner-000']);
  assert.equal(changed.represented, 33, 'the unchanged exact input may reuse its already stored vector');
  database.prepare("DELETE FROM semantic_features WHERE input_digest=(SELECT semantic_input_digest FROM nodes WHERE id='owner-000')").run();
  const missing = await completeIndexedSemantics(database, { ...options, encode: undefined });
  assert.equal(missing.represented, 32); assert.equal(missing.missing, 1);
  assert.equal(missing.examined, 33); assert.equal(missing.unexamined, 0);
  assert.equal(missing.reason, 'model-unavailable');
  let encodeCalls = 0;
  const vanished = await completeIndexedSemantics(database, { ...options, encode: async () => {
    encodeCalls++; throw new Error('[pi-nav:domain] local model config.json: missing');
  } });
  assert.equal(encodeCalls, 1, 'known model absence must not trigger repeated encode attempts');
  assert.equal(vanished.represented, 32); assert.equal(vanished.examined, 33);
  assert.equal(vanished.reason, 'model-unavailable');
});

test('indexed semantic budget stop retains useful prefix and discloses the unexamined tail', async t => {
  const { database, options } = indexedFixture(t);
  let budget = 1000;
  const metadata = await completeIndexedSemantics(database, { ...options, remaining: () => budget,
    encode: async texts => { const result = await options.encode(texts); budget = 0; return result; } });
  assert.equal(metadata.status, 'partial'); assert.equal(metadata.reason, 'budget');
  assert.equal(metadata.represented, 16); assert.equal(metadata.examined, 16); assert.equal(metadata.unexamined, 17);
  assert.equal(metadata.unrepresented, 17); assert.equal(metadata.missing, 0);
  assert.equal(database.prepare('SELECT count(*) AS n FROM nodes').get().n, 33, 'structural rows remain usable');
});

test('indexed semantic projection deadline is a partial stop, not structural failure', async t => {
  const { database, options } = indexedFixture(t, 1);
  let budget = 100;
  const metadata = await completeIndexedSemantics(database, { ...options, remaining: () => budget,
    project: async () => { budget = 0; throw new Error('[pi-nav:deadline] operation deadline exceeded'); } });
  assert.equal(metadata.reason, 'budget'); assert.equal(metadata.unexamined, 1);
  assert.equal(database.prepare('SELECT count(*) AS n FROM nodes').get().n, 1);
});

test('missing model/native capability preserves structure and reports unavailable rather than complete', async t => {
  for (const override of [{ encode: undefined }, { info: undefined }, { encode: async () => { throw new Error('[pi-nav:domain] local model config.json: missing'); } }]) {
    const { database, options } = indexedFixture(t, 1);
    const metadata = await completeIndexedSemantics(database, { ...options, ...override });
    assert.equal(metadata.status, 'unavailable'); assert.equal(metadata.represented, 0);
    assert.ok(['model-unavailable', 'native-unavailable'].includes(metadata.reason));
    assert.equal(database.prepare('SELECT count(*) AS n FROM nodes').get().n, 1);
  }
});

test('missing or incompatible indexed semantic schema is never repaired', async t => {
  for (const incompatible of ['missing-table', 'wrong-type', 'missing-binding', 'nonunique', 'composite-key']) {
    const { database, options } = indexedFixture(t, 1);
    if (incompatible === 'missing-binding') database.exec('ALTER TABLE nodes DROP COLUMN semantic_input_digest');
    else {
      database.exec('DROP TABLE semantic_features');
      if (incompatible === 'wrong-type') database.exec('CREATE TABLE semantic_features(input_digest TEXT PRIMARY KEY, vector TEXT NOT NULL)');
      if (incompatible === 'nonunique') database.exec('CREATE TABLE semantic_features(input_digest TEXT NOT NULL, vector BLOB NOT NULL)');
      if (incompatible === 'composite-key') database.exec('CREATE TABLE semantic_features(input_digest TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(input_digest,vector))');
    }
    const before = database.prepare('SELECT sql FROM sqlite_schema ORDER BY name').all();
    const result = await completeIndexedSemantics(database, { ...options, project: async () => assert.fail('incompatible schema must not project') });
    assert.deepEqual(result, { status: 'unavailable', reason: 'schema-unavailable' });
    assert.deepEqual(database.prepare('SELECT sql FROM sqlite_schema ORDER BY name').all(), before);
    assert.equal(database.prepare('SELECT 1 FROM project_metadata WHERE key=?').get(INDEXED_KEY), undefined);
  }
});

test('indexed semantic source and admission failures cannot become model-unavailable success', async t => {
  const first = indexedFixture(t, 1);
  await assert.rejects(completeIndexedSemantics(first.database, { ...first.options, readSource: () => 'changed' }), /source changed/);
  const second = indexedFixture(t, 1);
  let changed = false;
  await assert.rejects(completeIndexedSemantics(second.database, { ...second.options,
    readSource: () => changed ? 'changed' : TEXT,
    encode: async texts => { changed = true; return second.options.encode(texts); } }), /source changed/);
  const third = indexedFixture(t, 1);
  let denied = false;
  await assert.rejects(completeIndexedSemantics(third.database, { ...third.options,
    validate: () => { if (denied) throw new Error('policy drift'); },
    encode: async () => { denied = true; throw new Error('model error must not mask policy drift'); } }), /policy drift/);
  for (const { database } of [first, second, third]) {
    assert.equal(database.prepare('SELECT 1 FROM project_metadata WHERE key=?').get(INDEXED_KEY), undefined);
    assert.equal(database.prepare('SELECT count(*) AS n FROM semantic_features').get().n, 0);
  }
});

test('indexed semantic protocol corruption remains fail-closed and unsupported coverage stays explicit', async t => {
  const { database, options } = indexedFixture(t, 2);
  await assert.rejects(completeIndexedSemantics(database, { ...options,
    encode: async texts => ({ ...INFO, recipe: 'b'.repeat(64), vectors: texts.map(() => []) }) }), /pinned native recipe/);
  const result = await completeIndexedSemantics(database, { ...options,
    project: async args => projection(args, INFO, () => 'unsupported') });
  assert.equal(result.unrepresented, 2); assert.equal(result.unexamined, 0); assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'coverage');
});

test('invalid cached vectors are missing, not represented, when replacement encoding is unavailable', async t => {
  const { database, options } = indexedFixture(t, 1);
  await completeIndexedSemantics(database, options);
  database.prepare('UPDATE semantic_features SET vector=?').run(Buffer.alloc(1024));
  const result = await completeIndexedSemantics(database, { ...options, encode: async () => { throw new Error('[pi-nav:domain] local model config.json: missing'); } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'model-unavailable');
  assert.equal(result.represented, 0); assert.equal(result.missing, 1);
  assert.equal(database.prepare('SELECT count(*) AS n FROM semantic_features').get().n, 0);
});

test('deadline exhaustion never conceals a protocol fault or cancellation', async t => {
  const first = indexedFixture(t, 1);
  let budget = 100;
  await assert.rejects(completeIndexedSemantics(first.database, { ...first.options, remaining: () => budget,
    project: async args => { budget = 0; const result = projection(args); result.structured.data.recipe = 'b'.repeat(64); return result; }
  }), /provenance/);
  const second = indexedFixture(t, 1);
  await assert.rejects(completeIndexedSemantics(second.database, { ...second.options,
    encode: async () => { throw new Error('[pi-nav:cancelled] operation cancelled'); }
  }), /cancelled/);
  for (const { database } of [first, second]) assert.equal(database.prepare('SELECT 1 FROM project_metadata WHERE key=?').get(INDEXED_KEY), undefined);
});

test('encoder rejection cannot hide native envelope or programming faults behind budget/model fallback', async t => {
  for (const exhausted of [false, true]) for (const message of [
    '[pi-nav:malformed_output] structured schema/operation mismatch',
    '[pi-nav:invalid_argument] texts must be an array',
    '[pi-nav:domain] local encoding requires an absolute asset directory, 1-16 inputs and at most 64 KiB per input',
    '[pi-nav:cancelled] operation cancelled',
    'unexpected programming fault',
  ]) {
    const { database, options } = indexedFixture(t, 1);
    let budget = 100;
    await assert.rejects(completeIndexedSemantics(database, { ...options, remaining: () => budget,
      encode: async () => { if (exhausted) budget = 0; throw new Error(message); },
    }), error => error.message === message);
    assert.equal(database.prepare('SELECT 1 FROM project_metadata WHERE key=?').get(INDEXED_KEY), undefined);
  }
});

test('indexed semantic SQL failures escape instead of publishing unavailable success', async t => {
  const { database, options } = indexedFixture(t, 1);
  database.exec("CREATE TRIGGER refuse_features BEFORE INSERT ON semantic_features BEGIN SELECT RAISE(ABORT, 'storage refused'); END");
  await assert.rejects(completeIndexedSemantics(database, options), /storage refused/);
  assert.equal(database.prepare('SELECT 1 FROM project_metadata WHERE key=?').get(INDEXED_KEY), undefined);
  assert.equal(database.prepare('SELECT count(*) AS n FROM semantic_features').get().n, 0);
});
