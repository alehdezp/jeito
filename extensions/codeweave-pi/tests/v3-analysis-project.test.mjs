import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { deriveAnalysisProject, initializeAnalysisProject, readAnalysisProject } from '../src/core/analysis-project.mjs';
import { ANALYSIS_REVISION, KERNEL_VERSION, MAINTENANCE_REVISION, MAINTENANCE_STATUS_FILE } from '../native/analysis/identity.mjs';
import { analysisSemanticModelDirectory, callAnalysisNavigation, callIndexedGraphNavigation, validateRankedCorpus } from '../src/core/pi-nav-native.ts';
import { registerTraceTool } from '../src/tools/trace.ts';
import { registerGrepTool } from '../src/tools/grep.ts';
import { registerExploreTool } from '../src/tools/explore.ts';
import { harnessEnvelope, nativeToolResult } from '../src/core/harness-result.ts';

const schemaPath = fileURLToPath(new URL('../native/analysis/schema.sql', import.meta.url));
function fixture(t) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'analysis-project-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'source');
  mkdirSync(root);
  return { temporary, root, directory: join(temporary, 'store'), schemaPath };
}
const receipt = database => ({ bytes: readFileSync(database), inode: statSync(database).ino, mtime: statSync(database).mtimeMs });
const refused = operation => assert.throws(operation, /Explicit maintenance is required/);

test('Matches mixed-owner policy packets need no graph and re-admit authority without binary sampling', async t => {
  const options = fixture(t);
  const other = join(options.temporary, 'other');
  for (const root of [options.root, other]) {
    mkdirSync(join(root, 'src/private'), { recursive: true });
    writeFileSync(join(root, '.pi-navigation.json'), '{"scope":{"exclude":["src/private"]}}');
    writeFileSync(join(root, 'src/allowed.ts'), 'TOKEN\n');
    writeFileSync(join(root, 'src/data.lock'), 'TOKEN\n');
    writeFileSync(join(root, 'src/binary.dat'), Buffer.from('TOKEN\0'));
    writeFileSync(join(root, 'src/private/explicit.ts'), 'TOKEN\n');
  }
  const selectors = [join(options.root, 'src'), join(other, 'src'), join(options.root, 'src/private/explicit.ts')];
  const calls = [];
  let packet;
  let revoked = false;
  const baseline = { text: 'TOKEN', structured: { schemaVersion: 1, operation: 'pi_nav_search',
    data: { mode: 'matches' }, completeness: { complete: true }, diagnostics: [] },
    sourceSnapshots: [join(options.root, 'src/data.lock'), join(other, 'src/allowed.ts'), selectors[2]].map(canonicalPath => ({ canonicalPath })) };
  const native = async request => {
    calls.push(request);
    if (request.operation === 'pi_nav_grep_cursor_owner') return { ...baseline, sourceRoot: options.root,
      structured: { ...baseline.structured, data: { ownsCursor: true, matchesCursor: true, matchesAdmission: packet } } };
    if (request.operation === 'pi_nav_files') return { ...baseline, structured: { ...baseline.structured,
      data: { corpusPolicyVersion: 1, corpusVisibility: request.args.visibility, root: request.root, files: revoked ? [] : ['src/allowed.ts', 'src/data.lock', 'src/binary.dat'], directories: ['', 'src'] } } };
    assert.equal(request.operation, 'pi_nav_search', 'no preparation, binary sampling, or source-read helper is allowed');
    if (request.args.matchesAdmission) {
      packet = request.args.matchesAdmission;
      assert.deepEqual(request.args.paths, selectors);
      assert.deepEqual(packet.owners.map(owner => owner.root), [options.root, other]);
      assert.deepEqual(packet.explicitFiles, [selectors[2]]);
      assert.deepEqual(packet.directories, { [selectors[0]]: 0, [selectors[1]]: 1 });
      assert.ok(packet.owners.every(owner => owner.policy.excludedPrefixes.includes('src/private')));
    }
    return baseline;
  };
  for (const syntax of ['literal', 'regex']) {
    const output = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search',
      args: { pattern: 'TOKEN', syntax, paths: selectors, output: 'matches' } }, undefined, native);
    assert.equal(calls[0].operation, 'pi_nav_search', 'compiled policy reaches scan before any preparation census');
    assert.equal(output.text, 'TOKEN');
    assert.ok(!Object.keys(output).includes('matchesAdmission'));
    assert.equal(existsSync(options.directory), false);
    await validateRankedCorpus(output, native);
    const continued = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { cursor: 'grep-protected' } }, undefined, native);
    const refitted = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { renderMatches: 'grep-origin', matchesRenderBytes: 4000 } }, undefined, native);
    assert.deepEqual(continued.matchesAdmission, packet);
    assert.deepEqual(refitted.matchesAdmission, packet);
    revoked = true;
    await assert.rejects(validateRankedCorpus(output, native), /source admission was revoked/);
    revoked = false;
    writeFileSync(join(other, '.pi-navigation.json'), '{"scope":{"exclude":["src"]}}');
    await assert.rejects(validateRankedCorpus(output, native), /Matches policy changed/);
    writeFileSync(join(other, '.pi-navigation.json'), '{"scope":{"exclude":["src/private"]}}');
  }
  const all = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { output: 'matches', visibility: 'all', paths: selectors, pattern: 'TOKEN' } }, undefined, native);
  assert.equal(all.text, baseline.text);
  assert.equal(all.matchesAdmission.allVisibility, true);
  assert.equal(calls.filter(call => call.operation === 'pi_nav_search').at(-1).args.matchesAdmission.allVisibility, true);
});

test('ranked automatic live collection retains corpus admission when no store exists', async t => {
  const options = fixture(t);
  writeFileSync(join(options.root, '.pi-navigation.json'), '{"scope":{"exclude":["private"]}}');
  writeFileSync(join(options.root, 'ready.ts'), 'export function Ready() {}\n');
  const calls = [];
  const native = async request => {
    calls.push(request);
    return { text: '', structured: { schemaVersion: 1, operation: request.operation, diagnostics: [], completeness: { complete: true },
      data: request.operation === 'pi_nav_files' ? { root: options.root, corpusPolicyVersion: 1, files: ['ready.ts'], directories: [''] } : { mode: 'ranked' } } };
  };
  const output = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { kind: 'symbol', query: 'Ready' } }, undefined, native);
  assert.deepEqual(output.corpusAdmission.files, ['ready.ts']);
  assert.ok(calls.filter(call => call.operation === 'pi_nav_search').every(call => call.args.corpusAdmission?.files[0] === 'ready.ts'));
  assert.equal(existsSync(options.directory), false);
  const alias = join(options.temporary, 'alias');
  symlinkSync(options.root, alias, 'dir');
  const focus = { target: `${join(alias, 'ready.ts')}::Ready` };
  await callAnalysisNavigation({ root: alias, operation: 'pi_nav_search', args: { kind: 'symbol', query: 'Ready', scope: alias, focus } }, undefined, native);
  const focused = calls.filter(call => call.operation === 'pi_nav_search').at(-1);
  assert.equal(focused.root, options.root);
  assert.equal(focused.args.scope, options.root);
  assert.equal(focused.args.focus.target, `${join(options.root, 'ready.ts')}::Ready`, 'focused paths must share the canonical admission namespace');
  assert.equal(focus.target, `${join(alias, 'ready.ts')}::Ready`, 'normalization must not mutate caller input');
});

test('relation fallback preserves namespace identity and complete file-qualified tails', async t => {
  const options = fixture(t);
  writeFileSync(join(options.root, 'ready.ts'), 'export function Ready() {}\n');
  const calls = [];
  const native = async request => {
    calls.push(request);
    return { text: 'live source', structured: { schemaVersion: 1, operation: request.operation, diagnostics: [], completeness: { complete: true },
      data: request.operation === 'pi_nav_files' ? { root: options.root, corpusPolicyVersion: 1, files: ['ready.ts'], directories: [''] } : { mode: 'ranked' } } };
  };
  for (const [query, expected, scope] of [
    ['Widget::render', 'Widget::render', options.root],
    ['std::io::Read', 'std::io::Read', options.root],
    ['ready.ts::Ready', 'Ready', join(options.root, 'ready.ts')],
    ['ready.ts::Namespace::Ready', 'Namespace::Ready', join(options.root, 'ready.ts')],
  ]) {
    calls.length = 0;
    await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { analysisRelation: 'callers', kind: 'symbol', query } }, undefined, native);
    const searches = calls.filter(call => call.operation === 'pi_nav_search');
    assert.equal(searches.length, 1);
    assert.equal(searches[0].args.query, expected);
    assert.equal(searches[0].args.scope, scope);
  }
  for (const query of ['Widget::', 'ready.ts::', 'src/gone.ts::fn', 'src/gone.scala::Worker.run']) {
    calls.length = 0;
    await assert.rejects(callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { analysisRelation: 'callers', kind: 'symbol', query } }, undefined, native), /qualified relation target/);
    assert.equal(calls.length, 0, 'invalid identity must fail before dispatch');
  }
});

test('unconfigured text and all-visibility queries keep metadata admission; older all censuses refuse before source', async t => {
  const options = fixture(t);
  writeFileSync(join(options.root, 'text.zip'), 'Ready is searchable text\n');
  writeFileSync(join(options.root, 'binary.dat'), Buffer.from('Ready\0'));
  const files = ['binary.dat', 'text.zip'];
  const calls = [];
  let acknowledgeAll = true;
  const native = async request => {
    calls.push(request);
    assert.equal(request.args.analysisDatabase, undefined);
    const data = request.operation === 'pi_nav_files'
      ? { root: options.root, corpusPolicyVersion: 1, corpusVisibility: acknowledgeAll ? request.args.visibility : undefined, files, directories: [''] }
      : { mode: 'ranked' };
    return { text: 'live text', structured: { schemaVersion: 1, operation: request.operation, data, completeness: { complete: true }, diagnostics: [] } };
  };
  for (const args of [{ query: 'Ready', kind: 'content' }, { query: 'Ready', kind: 'regex' }, { query: 'Ready', visibility: 'all' }]) {
    calls.length = 0;
    const output = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args }, undefined, native);
    assert.equal(calls[0].operation, 'pi_nav_files', 'unmarked roots are not an unrestricted fallback');
    assert.deepEqual(calls.find(call => call.operation === 'pi_nav_search').args.corpusAdmission.files, files);
    assert.equal(output.corpusOptions.metadataOnly, true);
    assert.equal(Object.keys(output).includes('corpusOptions'), false);
    await validateRankedCorpus(output, native);
    assert.equal(existsSync(options.directory), false);
  }
  calls.length = 0;
  acknowledgeAll = false;
  await assert.rejects(callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { query: 'Ready', visibility: 'all' } }, undefined, native), /complete policy-aware corpus census/);
  assert.ok(calls.every(call => call.operation === 'pi_nav_files'), 'no source dispatch before an acknowledged ownership census');
});

test('initialize creates generation zero once and reuses a published generation without needing schema again', t => {
  const options = fixture(t);
  const initial = initializeAnalysisProject(options);
  assert.equal(initial.database, join(options.directory, 'graph.sqlite'));
  assert.deepEqual(initial.metadata, { root: options.root, generation: 0, kernelVersion: KERNEL_VERSION, interpretationRevision: ANALYSIS_REVISION });
  assert.equal(statSync(options.directory).mode & 0o077, 0);
  assert.equal(statSync(initial.database).mode & 0o077, 0);
  const source = 'export const retained = true;\n';
  writeFileSync(join(options.root, 'retained.ts'), source);
  const connection = new Database(initial.database);
  const published = { ...initial.metadata, generation: 7, preserved: 'caller publication' };
  try {
    connection.pragma('journal_mode = WAL');
    connection.prepare("UPDATE project_metadata SET value = ? WHERE key = 'codeweave-pi.g1'").run(JSON.stringify(published));
    connection.prepare('INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('retained.ts', 'retained-content', 'typescript', Buffer.byteLength(source), 1, 1);
  } finally { connection.close(); }
  const before = receipt(initial.database);
  assert.deepEqual(initializeAnalysisProject({ ...options, schemaPath: '/does/not/exist' }), { database: initial.database, metadata: published });
  assert.deepEqual(readAnalysisProject(options), { database: initial.database, metadata: published });
  assert.deepEqual(receipt(initial.database), before);
  assert.equal(readFileSync(join(options.root, 'retained.ts'), 'utf8'), source);
  // Ordinary SQLite coordination is allowed; no new application state is.
  const entries = readdirSync(options.directory);
  assert.ok(entries.includes('graph.sqlite'));
  assert.ok(entries.every(name => ['graph.sqlite', 'graph.sqlite-wal', 'graph.sqlite-shm'].includes(name)));
  const reader = new Database(initial.database, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(reader.prepare('SELECT path, content_hash FROM files').all(), [{ path: 'retained.ts', content_hash: 'retained-content' }]);
    assert.equal(reader.pragma('journal_mode', { simple: true }), 'wal');
  } finally { reader.close(); }
});

test('fresh semantic schema permits pending bindings and reusable fixed-width feature rows', t => {
  const options = fixture(t);
  const initialized = initializeAnalysisProject(options);
  const connection = new Database(initialized.database);
  try {
    const insert = connection.prepare(`INSERT INTO nodes
      (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at, semantic_input_digest)
      VALUES (?, 'function', 'owner', 'owner', 'owner.ts', 'typescript', 1, 1, 0, 30, 1, ?)`);
    insert.run('pending', 'compatible-input');
    insert.run('unsupported', null);
    assert.equal(connection.prepare('SELECT count(*) AS total FROM semantic_features').get().total, 0);
    assert.equal(connection.prepare("SELECT semantic_input_digest FROM nodes WHERE id='pending'").get().semantic_input_digest, 'compatible-input');
    assert.equal(connection.prepare("SELECT semantic_input_digest FROM nodes WHERE id='unsupported'").get().semantic_input_digest, null);
    const feature = connection.prepare('INSERT INTO semantic_features VALUES (?, ?)');
    assert.throws(() => feature.run('short', Buffer.alloc(4)), /CHECK constraint/);
    assert.throws(() => feature.run('text', 'x'.repeat(1024)), /CHECK constraint/);
    const vector = Buffer.alloc(256 * 4);
    vector.writeFloatLE(1, 0);
    feature.run('compatible-input', vector);
    connection.exec('DELETE FROM nodes');
    assert.deepEqual(connection.prepare('SELECT vector FROM semantic_features').get().vector, vector);
  } finally { connection.close(); }
});

test('existing code-only stores are read without semantic schema migration', t => {
  const options = fixture(t);
  const initialized = initializeAnalysisProject(options);
  const connection = new Database(initialized.database);
  try {
    connection.exec('DROP TABLE semantic_features; ALTER TABLE nodes DROP COLUMN semantic_input_digest');
  } finally { connection.close(); }
  const before = receipt(initialized.database);
  assert.deepEqual(initializeAnalysisProject({ ...options, schemaPath: '/must/not/be/read' }), initialized);
  assert.deepEqual(readAnalysisProject(options), initialized);
  assert.deepEqual(receipt(initialized.database), before);
});

test('read of a missing directory or missing database creates nothing', t => {
  const options = fixture(t);
  refused(() => readAnalysisProject(options));
  assert.equal(existsSync(options.directory), false);
  mkdirSync(options.directory, { mode: 0o700 });
  refused(() => readAnalysisProject(options));
  assert.deepEqual(readdirSync(options.directory), []);
});

test('wrong root and incompatible interpretation refuse without changing stored bytes', t => {
  const options = fixture(t);
  const initial = initializeAnalysisProject(options);
  const otherRoot = join(options.temporary, 'other-source');
  mkdirSync(otherRoot);
  let before = receipt(initial.database);
  refused(() => initializeAnalysisProject({ ...options, root: otherRoot }));
  refused(() => readAnalysisProject({ ...options, root: otherRoot }));
  assert.deepEqual(receipt(initial.database), before);
  const connection = new Database(initial.database);
  try {
    connection.prepare("UPDATE project_metadata SET value = ? WHERE key = 'codeweave-pi.g1'").run(JSON.stringify({ ...initial.metadata, interpretationRevision: 'foreign' }));
  } finally { connection.close(); }
  before = receipt(initial.database);
  refused(() => initializeAnalysisProject(options));
  refused(() => readAnalysisProject(options));
  assert.deepEqual(receipt(initial.database), before);
});

test('foreign SQLite and incomplete initialization are not repaired or adopted', t => {
  const options = fixture(t);
  mkdirSync(options.directory, { mode: 0o700 });
  const database = join(options.directory, 'graph.sqlite');
  const connection = new Database(database);
  try { connection.exec("CREATE TABLE foreign_data (value TEXT); INSERT INTO foreign_data VALUES ('keep')"); }
  finally { connection.close(); }
  chmodSync(database, 0o600);
  const before = receipt(database);
  refused(() => initializeAnalysisProject(options));
  refused(() => readAnalysisProject(options));
  assert.deepEqual(receipt(database), before);

  const partial = { ...options, directory: join(options.temporary, 'partial') };
  const brokenSchema = join(options.temporary, 'broken.sql');
  writeFileSync(brokenSchema, readFileSync(schemaPath, 'utf8') + '\nINVALID SQL;');
  refused(() => initializeAnalysisProject({ ...partial, schemaPath: brokenSchema }));
  const partialDatabase = join(partial.directory, 'graph.sqlite');
  const partialBefore = receipt(partialDatabase);
  refused(() => readAnalysisProject(partial));
  refused(() => initializeAnalysisProject(partial));
  assert.deepEqual(receipt(partialDatabase), partialBefore);
});

test('source-local stores, nonprivate directories, directory aliases and database links are refused', t => {
  const options = fixture(t);
  refused(() => initializeAnalysisProject({ ...options, directory: join(options.root, 'store') }));
  assert.equal(existsSync(join(options.root, 'store')), false);
  mkdirSync(options.directory, { mode: 0o755 });
  chmodSync(options.directory, 0o755);
  refused(() => initializeAnalysisProject(options));
  assert.deepEqual(readdirSync(options.directory), []);
  chmodSync(options.directory, 0o700);
  const initialized = initializeAnalysisProject(options);
  const before = receipt(initialized.database);
  const alias = join(options.temporary, 'alias');
  symlinkSync(options.directory, alias);
  refused(() => initializeAnalysisProject({ ...options, directory: alias }));
  refused(() => readAnalysisProject({ ...options, directory: alias }));
  const linkedDirectory = join(options.temporary, 'linked');
  mkdirSync(linkedDirectory, { mode: 0o700 });
  symlinkSync(initialized.database, join(linkedDirectory, 'graph.sqlite'));
  refused(() => initializeAnalysisProject({ ...options, directory: linkedDirectory }));
  const hardlink = join(options.temporary, 'hardlink');
  linkSync(initialized.database, hardlink);
  refused(() => readAnalysisProject(options));
  refused(() => initializeAnalysisProject(options));
  rmSync(hardlink);
  assert.deepEqual(receipt(initialized.database), before);
});

test('live routes survive missing or unusable analysis without creating a store or claiming prepared evidence', async t => {
  const options = fixture(t);
  const calls = [];
  let kind = 'symbol';
  const callNative = async request => {
    calls.push(request);
    if (request.operation === 'pi_nav_files') return { text: '', structured: { schemaVersion: 1, operation: request.operation, data: { root: options.root, corpusPolicyVersion: 1, files: [], directories: [''] }, completeness: { complete: true }, diagnostics: [] } };
    return { text: 'live result', structured: { schemaVersion: 1, operation: 'pi_nav_search', data: { kind }, completeness: {}, diagnostics: [] } };
  };
  const request = { root: options.root, operation: 'pi_nav_search', args: { query: 'Ready', kind: 'symbol' } };
  const missing = await callAnalysisNavigation(request, options, callNative);
  assert.match(missing.text, /has not been prepared/);
  assert.equal(existsSync(options.directory), false);
  assert.equal(calls[0].args.analysisDatabase, undefined);
  mkdirSync(options.directory, { mode: 0o700 });
  const database = join(options.directory, 'graph.sqlite');
  writeFileSync(database, 'invalid database', { mode: 0o600 });
  const before = receipt(database);
  const literal = await callAnalysisNavigation({ ...request, args: { query: 'Ready', kind: 'content' } }, options, callNative);
  assert.match(literal.text, /live result/);
  kind = 'fuzzy'; // Native owns automatic routing; this stub tests only the adapter.
  const discovery = await callAnalysisNavigation({ ...request, args: { query: 'find behavior', kind: 'auto' } }, options, callNative);
  assert.match(discovery.text, /live navigation only/);
  kind = 'symbol';
  const exact = await callAnalysisNavigation(request, options, callNative);
  assert.match(exact.text, /live result/);
  assert.match(exact.text, /Prepared connections unavailable/);
  assert.equal(exact.structured.data.analysis, undefined);
  assert.equal(calls.filter(call => call.args.analysisDatabase).length, 2, 'SQL validity is delegated to native; the adapter never opens even this invalid database');
  assert.deepEqual(receipt(database), before);
  assert.deepEqual(readdirSync(options.directory), ['graph.sqlite']);
});

test('native classification precedes analysis; lexical-miss discovery may enrich while literal routes never inspect a store', async t => {
  const { root } = fixture(t);
  let inspected = 0;
  const project = { root, get directory() { inspected++; throw new Error('analysis must not gate discovery'); } };
  for (const kind of ['content', 'regex']) {
    const calls = [];
    const output = await callAnalysisNavigation({ root, operation: 'pi_nav_search', args: { query: 'find behavior', kind: 'auto' } }, project, async request => {
      calls.push(request);
      if (request.operation === 'pi_nav_files') return { text: '', structured: { schemaVersion: 1, operation: request.operation, data: { root, corpusPolicyVersion: 1, files: [], directories: [''] }, completeness: { complete: true }, diagnostics: [] } };
      assert.equal(inspected, 0, 'the live call runs before any graph access');
      return { text: `live ${kind}`, structured: { schemaVersion: 1, operation: 'pi_nav_search', data: { kind, definitions: 0 }, completeness: {}, diagnostics: [] } };
    });
    assert.match(output.text, new RegExp(`live ${kind}`));
    assert.equal(calls.filter(call => call.operation === 'pi_nav_search').length, 1);
    assert.equal(calls[0].args.analysisDatabase, undefined);
    assert.equal(inspected, 0, 'no graph inspection for a native-classified live route');
  }
  const calls = [];
  const discovery = await callAnalysisNavigation({ root, operation: 'pi_nav_search', args: { query: 'find behavior', kind: 'auto' } }, project, async request => {
    calls.push(request);
    if (request.operation === 'pi_nav_files') return { text: '', structured: { schemaVersion: 1, operation: request.operation, data: { root, corpusPolicyVersion: 1, files: [], directories: [''] }, completeness: { complete: true }, diagnostics: [] } };
    assert.equal(inspected, 0, 'the lexical-miss answer exists before semantic admission');
    return { text: 'live fuzzy', structured: { schemaVersion: 1, operation: 'pi_nav_search', data: { kind: 'fuzzy', definitions: 0 }, completeness: {}, diagnostics: [] } };
  });
  assert.equal(inspected, 1, 'zero lexical declarations must not suppress required semantic discovery');
  assert.equal(calls.filter(call => call.operation === 'pi_nav_search').length, 1);
  assert.equal(calls[0].args.analysisDatabase, undefined);
  assert.match(discovery.text, /live fuzzy/);
  assert.match(discovery.text, /Prepared connections unavailable/);
});

test('prepared enrichment preserves live evidence on failure, remains usable on success, and never swallows abort', async t => {
  const options = fixture(t);
  const initial = initializeAnalysisProject(options);
  const connection = new Database(initial.database);
  try {
    connection.prepare("UPDATE project_metadata SET value = ? WHERE key = 'codeweave-pi.g1'")
      .run(JSON.stringify({ ...initial.metadata, generation: 1 }));
  } finally { connection.close(); }
  const before = receipt(initial.database);
  const live = { text: 'complete live declaration', sourceSnapshots: [], structured: {
    schemaVersion: 1, operation: 'pi_nav_search', data: { kind: 'symbol' }, completeness: { complete: true }, diagnostics: [],
  } };
  const census = { text: '', structured: { ...live.structured, data: { root: options.root, corpusPolicyVersion: 1, files: [], directories: [''] } } };
  const request = { root: options.root, operation: 'pi_nav_search', args: { query: 'Ready', kind: 'symbol' } };
  const calls = [];
  const unavailable = await callAnalysisNavigation(request, options, async call => {
    calls.push(call);
    if (call.operation === 'pi_nav_files') return census;
    if (call.args.analysisDatabase) throw new Error('known-stale source');
    return live;
  });
  assert.equal(calls.filter(call => call.operation === 'pi_nav_search').length, 2);
  assert.equal(calls[0].operation, 'pi_nav_files');
  assert.equal(calls.find(call => call.args.analysisDatabase).args.analysisDatabase, initial.database);
  assert.match(unavailable.text, /complete live declaration/);
  assert.match(unavailable.text, /Prepared connections unavailable/);
  assert.equal(unavailable.structured.data, live.structured.data);
  assert.equal(unavailable.sourceSnapshots, live.sourceSnapshots);
  assert.equal(unavailable.structured.data.analysis, undefined);

  const prepared = { ...live, text: 'live declaration with validated connections', structured: {
    ...live.structured, data: { kind: 'symbol', analysis: { generation: 1 } },
  } };
  const enriched = await callAnalysisNavigation(request, options, async call => call.operation === 'pi_nav_files' ? census : call.args.analysisDatabase ? prepared : live);
  assert.deepEqual(enriched, prepared, 'the private handoff must not change the enumerable output');
  assert.equal(enriched.structured, prepared.structured);
  assert.equal(enriched.sourceSnapshots, prepared.sourceSnapshots);
  assert.deepEqual(enriched.liveFallback, live);
  assert.equal(Object.hasOwn(prepared, 'liveFallback'), false, 'the native response itself is not mutated');

  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const timedCalls = [];
  const timedOut = await callAnalysisNavigation({ ...request, timeoutMs: 100 }, options, async call => {
    timedCalls.push(call);
    if (call.operation === 'pi_nav_files') return census;
    if (call.args.analysisDatabase) {
      now += call.timeoutMs + 1;
      throw new Error('[pi-nav:deadline] optional native query timed out');
    }
    now = 20;
    return live;
  });
  assert.equal(timedOut.structured.data, live.structured.data);
  assert.equal(timedCalls.filter(call => call.operation === 'pi_nav_search').length, 2);
  const optional = timedCalls.find(call => call.args.analysisDatabase);
  assert.ok(optional.timeoutMs > 0 && optional.timeoutMs < 80, 'optional query leaves certification time inside the original allowance');
  assert.match(timedOut.text, /optional native query timed out/);

  const abort = new AbortController();
  const reason = new Error('caller cancelled');
  await assert.rejects(callAnalysisNavigation(request, options, async call => {
    if (call.operation === 'pi_nav_files') return census;
    if (call.args.analysisDatabase) {
      writeFileSync(join(options.root, '.pi-navigation.json'), '{"scope":{"exclude":["secret"]}}');
      return prepared;
    }
    return live;
  }), /ranked corpus changed/);
  rmSync(join(options.root, '.pi-navigation.json'));
  await assert.rejects(callAnalysisNavigation({ ...request, signal: abort.signal }, options, async call => {
    if (call.operation === 'pi_nav_files') return census;
    if (call.args.analysisDatabase) { abort.abort(reason); throw reason; }
    return live;
  }), error => error === reason);
  assert.deepEqual(receipt(initial.database), before);
});

test('prepared filesystem identity and permissions survive the awaited native boundary', async t => {
  for (const change of ['replacement', 'permissions']) {
    const options = fixture(t);
    const store = initializeAnalysisProject(options);
    const baseline = { text: 'retained live answer', structured: { schemaVersion: 1, operation: 'pi_nav_search',
      data: { kind: 'symbol' }, completeness: { complete: true }, diagnostics: [] } };
    const result = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { query: 'Ready', kind: 'symbol' } }, options, async request => {
      if (request.operation === 'pi_nav_files') return { ...baseline, structured: { ...baseline.structured, operation: request.operation,
        data: { root: options.root, corpusPolicyVersion: 1, files: [], directories: [''] } } };
      if (!request.args.analysisDatabase) return baseline;
      if (change === 'replacement') {
        const bytes = readFileSync(store.database);
        renameSync(store.database, store.database + '.previous');
        writeFileSync(store.database, bytes, { mode: 0o600 });
      } else chmodSync(store.database, 0o644);
      return { ...baseline, structured: { ...baseline.structured, data: { kind: 'symbol', analysis: { generation: 1 } } } };
    });
    assert.match(result.text, /retained live answer/);
    assert.match(result.text, change === 'replacement' ? /identity changed/ : /private/);
    assert.equal(result.structured.data.analysis, undefined, 'untrusted prepared reply never survives the filesystem check');
  }
});

test('ranked reuse preserves prepared availability when capture is unsupported and never recollects after a failed resume', async t => {
  const project = fixture(t);
  const initialized = initializeAnalysisProject(project);
  const database = new Database(initialized.database);
  try { database.prepare("UPDATE project_metadata SET value = ? WHERE key = 'codeweave-pi.g1'").run(JSON.stringify({ ...initialized.metadata, generation: 1 })); }
  finally { database.close(); }
  const original = { kind: 'auto', scope: project.root, case: 'sensitive', expand: 2, budget: 4000 };
  const structured = { schemaVersion: 1, operation: 'pi_nav_search', data: { kind: 'fuzzy', definitions: 1 }, completeness: { complete: true }, diagnostics: [] };
  for (const outcome of ['ready', 'stale', 'retention refused']) {
    const calls = [];
    const outputs = await Promise.all(['First behavior', 'Second behavior'].map(query => callAnalysisNavigation({
      root: project.root, operation: 'pi_nav_search', timeoutMs: 25_000, args: { ...original, query },
    }, project, async request => {
      calls.push(request);
      if (request.operation === 'pi_nav_files') return { text: '', structured: { ...structured, operation: request.operation,
        data: { root: project.root, corpusPolicyVersion: 1, files: [], directories: [''] } } };
      if (request.args.analysisDatabase) {
        assert.equal(request.args.captureRanked, undefined);
        assert.equal(request.args.resumeRanked, outcome === 'retention refused' ? undefined : `private:${request.args.query}`);
        assert.equal(request.args.analysisDatabase, initialized.database);
        assert.equal(request.args.analysisRevision, ANALYSIS_REVISION);
        for (const [key, value] of Object.entries(original)) assert.equal(request.args[key], value);
        if (outcome === 'stale') throw new Error('retained source changed; no recollection');
        return { text: `connected ${request.args.query}`, structured: { ...structured, data: { ...structured.data, analysis: { generation: 1 } } } };
      }
      assert.equal(request.args.analysisDatabase, undefined);
      assert.equal(request.args.captureRanked, true);
      return { text: `live ${request.args.query}`, structured, sourceSnapshots: [], ...(outcome === 'retention refused'
        ? { searchCaptureUnavailable: 'retained-source byte limit exceeded' }
        : { searchCapture: `private:${request.args.query}` }) };
    })));
    assert.equal(calls.filter(call => call.operation === 'pi_nav_search' && !call.args.analysisDatabase).length, 2);
    assert.equal(calls.filter(call => call.args.analysisDatabase).length, 2);
    assert.equal(calls.filter(call => call.args.resumeRanked).length, outcome === 'retention refused' ? 0 : 2);
    for (const [index, query] of ['First behavior', 'Second behavior'].entries()) {
      const result = outputs[index];
      assert.match(result.text, new RegExp(`${outcome === 'stale' ? 'live' : 'connected'} ${query}`));
      assert.equal(result.searchCapture, undefined);
      assert.equal(result.searchCaptureUnavailable, undefined);
      assert.equal(result.liveFallback?.searchCapture, undefined);
      assert.ok(!JSON.stringify(result).includes('private:'));
      if (outcome === 'stale') {
        assert.equal(result.structured.data, structured.data);
        assert.match(result.text, /Prepared connections unavailable/);
        assert.equal(result.sourceSnapshots === undefined, outcome === 'stale', 'resume refusal requires fresh source certification');
      }
    }
  }
});

test('policy census failure refuses before collection and success forwards the current allowed corpus', async t => {
  const options = fixture(t);
  writeFileSync(join(options.root, 'ready.ts'), 'export function Ready() {}\n');
  const { compileLaneCorpusPolicy } = await import('../src/core/navigation-corpus-policy.ts');
  const policy = compileLaneCorpusPolicy(options.root, undefined, 'code');
  const initial = initializeAnalysisProject(options);
  const connection = new Database(initial.database);
  try {
    connection.prepare("UPDATE project_metadata SET value = ? WHERE key = 'codeweave-pi.g1'")
      .run(JSON.stringify({ ...initial.metadata, generation: 1, policyDigest: policy.digest }));
  } finally { connection.close(); }
  const before = receipt(initial.database);
  const baseline = { text: 'live declaration', structured: { schemaVersion: 1, operation: 'pi_nav_search', data: { kind: 'symbol' }, completeness: {}, diagnostics: [] } };
  for (const complete of [false, true]) {
    const calls = [];
    const pending = callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { query: 'Ready', kind: 'symbol' } }, options, async call => {
      calls.push(call);
      if (call.operation === 'pi_nav_files') return { text: '', structured: { schemaVersion: 1, operation: call.operation,
        data: { root: options.root, corpusPolicyVersion: 1, files: ['ready.ts'], directories: [''] }, completeness: { complete }, diagnostics: [],
      } };
      if (call.args.analysisDatabase) {
        // Policy travels with admission; SQL publication validation is native-owned.
        assert.equal(call.args.corpusAdmission.policyDigest, policy.digest);
        assert.equal(call.args.analysisPolicyDigest, undefined);
        assert.deepEqual(call.args.analysisCorpusFiles, ['ready.ts']);
        return { ...baseline, structured: { ...baseline.structured, data: { kind: 'symbol', analysis: { generation: 1 } } } };
      }
      return baseline;
    });
    if (complete) {
      const output = await pending;
      assert.equal(output.structured.data.analysis.generation, 1);
      assert.equal(calls.filter(call => call.operation === 'pi_nav_search').length, 2);
    } else {
      await assert.rejects(pending, /complete policy-aware corpus census/);
      assert.deepEqual(calls.map(call => call.operation), ['pi_nav_files']);
    }
    assert.equal(calls[0].args.analysisDatabase, undefined);
  }
  assert.deepEqual(receipt(initial.database), before);
});

test('live-only routes bypass selected state; native validation owns generation-zero refusal', async t => {
  const options = fixture(t);
  initializeAnalysisProject(options);
  const base = { query: 'Ready', kind: 'symbol' };
  const baseline = { text: 'live result', structured: { schemaVersion: 1, operation: 'pi_nav_search', data: { kind: 'symbol' }, completeness: {}, diagnostics: [] } };
  const { compileLaneCorpusPolicy } = await import('../src/core/navigation-corpus-policy.ts');
  const snapshot = compileLaneCorpusPolicy(options.root, undefined, 'code', { allowDisabledCode: true });
  const matchesAdmission = { owners: [{ root: options.root, policy: snapshot.policy, policyDigest: snapshot.digest, policyFiles: snapshot.policyFiles }], directories: { [options.root]: 0 }, explicitFiles: [] };
  for (const args of [base, { ...base, visibility: 'all' }, { ...base, glob: '*.ts' }, { output: 'matches', pattern: 'Ready' }, { cursor: 'grep-test' }]) {
    const calls = [];
    const output = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args }, options, async call => {
      calls.push(call);
      if (call.operation === 'pi_nav_files') return { text: '', structured: { ...baseline.structured, data: { root: options.root, corpusPolicyVersion: 1, corpusVisibility: call.args.visibility, files: [], directories: [''] }, completeness: { complete: true } } };
      return call.operation === 'pi_nav_grep_cursor_owner'
        ? { text: '', structured: { ...baseline.structured, operation: call.operation, data: { ownsCursor: true, matchesCursor: true, matchesAdmission } } }
        : baseline;
    });
    const preparedAttempt = !args.cursor && args.output !== 'matches' && args.visibility !== 'all' && !args.glob;
    // The parent must not open SQLite merely to discover generation zero. The
    // native refusal returns this unchanged live baseline with no prepared rows.
    assert.deepEqual(calls.filter(call => call.operation !== 'pi_nav_files').map(call => call.operation),
      args.cursor ? ['pi_nav_grep_cursor_owner', 'pi_nav_search'] : preparedAttempt ? ['pi_nav_search', 'pi_nav_search'] : ['pi_nav_search']);
    assert.equal(calls.some(call => call.args.analysisDatabase !== undefined), preparedAttempt);
    assert.match(output.text, /live result/);
    if (args.output === 'matches' || args.cursor) assert.ok(output.matchesAdmission, 'live audit admission is independent of selected state');
    else if (args.visibility === 'all') {
      assert.ok(output.corpusAdmission, 'all visibility retains ownership admission');
      assert.deepEqual(output.corpusOptions, { metadataOnly: true, visibility: 'all' });
    } else assert.match(output.text, /live navigation only/);
  }
});

for (const renderOnly of [false, true]) test(`prepared ranked ${renderOnly ? 'render-only fitting' : 'continuation'} rechecks admission and delegates publication checks without recollection`, async t => {
  const options = fixture(t);
  const source = 'export function Ready() {}\n';
  writeFileSync(join(options.root, 'ready.ts'), source);
  const { compileLaneCorpusPolicy } = await import('../src/core/navigation-corpus-policy.ts');
  const policy = compileLaneCorpusPolicy(options.root, undefined, 'code');
  const initial = initializeAnalysisProject(options);
  const captured = {
    ...initial.metadata, generation: 1, captureDigest: 'a'.repeat(64), policyDigest: policy.digest, corpus: 'project-capture',
    sources: [{ path: 'ready.ts', digest: createHash('sha256').update(source).digest('hex'), bytes: Buffer.byteLength(source) }],
  };
  const publishMetadata = metadata => {
    const database = new Database(initial.database);
    try { database.prepare("UPDATE project_metadata SET value = ? WHERE key = 'codeweave-pi.g1'").run(JSON.stringify(metadata)); }
    finally { database.close(); }
  };
  publishMetadata(captured);
  const baseline = { text: 'frozen connected page', sourceRoot: options.root, structured: { schemaVersion: 1, operation: 'pi_nav_search',
    data: { mode: 'ranked', kind: 'fuzzy', query: 'original question', scope: options.root, analysis: {
      generation: 1, captureDigest: captured.captureDigest, interpretationRevision: ANALYSIS_REVISION, policyDigest: policy.digest,
    } }, completeness: { complete: true }, diagnostics: [] } };
  const description = { text: '', sourceRoot: options.root, structured: { ...baseline.structured, operation: 'pi_nav_grep_cursor_owner',
    data: { ownsCursor: true, rankedCursor: { query: 'original question', scope: options.root, visibility: 'project',
      corpusRoot: options.root, focus: { target: `${join(options.root, 'ready.ts')}::Ready`, evidence: ['callers', 'callees'] },
      analysis: { ...baseline.structured.data.analysis, policyDigest: policy.digest } } } } };
  const calls = [];
  let files = ['ready.ts'];
  let overflow = false;
  let refusalCursor;
  let nativeFailure;
  const callNative = async request => {
    calls.push(request);
    if (request.operation === 'pi_nav_grep_cursor_owner') { assert.deepEqual(request.args, { cursor: 'grep-ranked-original' }); return description; }
    if (request.operation === 'pi_nav_files') return { text: '', structured: { schemaVersion: 1, operation: request.operation,
      data: { root: options.root, corpusPolicyVersion: 1, files, directories: [''] }, completeness: { complete: true }, diagnostics: [] } };
    assert.ok(request.args.corpusAdmission);
    const { corpusAdmission, ...remainingArgs } = request.args;
    assert.deepEqual(remainingArgs, { ...retainedArgs, analysisDatabase: initial.database,
      analysisRevision: ANALYSIS_REVISION, analysisCorpusFiles: files });
    if (nativeFailure) throw new Error(nativeFailure);
    if (refusalCursor) return { text: 'Required context cannot fit this allowance; no progress was credited.',
      rankedRenderCursor: refusalCursor, rankedRenderUnavailable: 'no coherent source unit fits',
      structured: { ...baseline.structured, data: { mode: 'ranked', sourceRows: [] },
        completeness: { complete: false, returned: 0, reason: 'budget' } } };
    return overflow ? { ...baseline, text: 'detail '.repeat(4050) } : baseline;
  };
  // The continuation root is recovered from its native owner, not the new cwd.
  const retainedArgs = renderOnly ? { renderRanked: 'grep-ranked-original', rankedRenderAllowance: 2500 }
    : { cursor: 'grep-ranked-original', retainRankedRender: true, rankedRenderAllowance: 4000 };
  const request = { root: options.temporary, operation: 'pi_nav_search', args: retainedArgs };
  const accepted = await callAnalysisNavigation(request, options, callNative);
  assert.deepEqual(accepted, baseline);
  assert.equal(accepted.liveFallback, undefined, 'cursor-owner metadata is not a saved live answer');
  assert.deepEqual(calls.filter(call => call.operation !== 'pi_nav_files').map(call => call.operation), ['pi_nav_grep_cursor_owner', 'pi_nav_search']);
  if (!renderOnly) {
    const { registerGrepTool } = await import('../src/tools/grep.ts');
    let tool;
    registerGrepTool({ registerTool(value) { tool = value; } }, { analysisProject: options, callNative });
    overflow = true;
    const refused = await tool.execute('overflow', { cursor: 'grep-ranked-original' }, undefined, undefined, { cwd: options.root });
    assert.equal(refused.details.envelope.status, 'error');
    assert.doesNotMatch(JSON.stringify(refused), /saved live navigation|ownsCursor|rankedCursor/);
    overflow = false;
  }
  refusalCursor = 'grep-ranked-original';
  const previousAllowance = retainedArgs.rankedRenderAllowance;
  retainedArgs.rankedRenderAllowance = 1;
  const empty = await callAnalysisNavigation(request, options, callNative);
  assert.equal(empty.rankedRenderCursor, refusalCursor);
  assert.equal(empty.rankedRenderUnavailable, 'no coherent source unit fits');
  assert.equal(empty.structured.completeness.complete, false);
  assert.deepEqual(empty.structured.data.sourceRows, []);
  assert.equal(empty.structured.data.cursor, undefined);
  assert.equal(empty.structured.data.analysis, undefined);
  assert.equal(empty.liveFallback, undefined);
  refusalCursor = 'grep-ranked-wrong-origin';
  await assert.rejects(callAnalysisNavigation(request, options, callNative), /refusal changed the original progress handle/);
  refusalCursor = undefined;
  retainedArgs.rankedRenderAllowance = previousAllowance;
  description.structured.data.rankedCursor.analysis.policyDigest = 'b'.repeat(64);
  await assert.rejects(callAnalysisNavigation(request, options, callNative), /ranked continuation.*frozen investigation/);
  description.structured.data.rankedCursor.analysis.policyDigest = policy.digest;
  baseline.structured.data.analysis.generation = 2;
  await assert.rejects(callAnalysisNavigation(request, options, callNative), /ranked continuation.*frozen investigation/);
  baseline.structured.data.analysis.generation = 1;
  // Native owns the SQL gates. This adapter proof checks refusal propagation;
  // real publication/membership rejection is exercised by the native/joined tests.
  for (const reason of ['publication changed', 'membership changed']) {
    nativeFailure = reason;
    await assert.rejects(callAnalysisNavigation(request, options, callNative), new RegExp(`ranked continuation.*${reason}`));
  }
  nativeFailure = undefined;
  const callsBeforeDisabled = calls.length;
  writeFileSync(join(options.root, '.pi-navigation.json'), '{"architecture":false}');
  await assert.rejects(callAnalysisNavigation(request, options, callNative), /ranked continuation.*disabled/);
  assert.ok(calls.slice(callsBeforeDisabled).every(call => call.operation !== 'pi_nav_search'), 'disabled preparation never reaches native publication validation');
  assert.ok(calls.filter(call => call.operation === 'pi_nav_search').every(call => call.args.cursor || call.args.renderRanked), 'no new collection or fallback graph');
  assert.deepEqual(readAnalysisProject(options).metadata, captured, 'queries never publish or repair');
});

test('all-visibility ranked fitting and continuation retain ownership without prepared enrichment', async t => {
  const options = fixture(t);
  const calls = [];
  let visibility = 'all';
  let focus = { target: null, evidence: ['uses', 'documentation'] };
  let corpusRoot = options.root;
  const native = async request => {
    calls.push(request);
    if (request.operation === 'pi_nav_grep_cursor_owner') return { text: '', sourceRoot: options.root, structured: {
      schemaVersion: 1, operation: request.operation, data: { ownsCursor: true, rankedCursor: { query: 'Ready', scope: options.root, visibility, focus, corpusRoot } },
      completeness: { complete: true }, diagnostics: [] } };
    if (request.operation === 'pi_nav_files') return { text: '', structured: { schemaVersion: 1, operation: request.operation,
      data: { root: options.root, corpusPolicyVersion: 1, corpusVisibility: request.args.visibility, files: [], directories: [''] }, completeness: { complete: true }, diagnostics: [] } };
    assert.equal(request.operation, 'pi_nav_search');
    assert.deepEqual(request.args.corpusAdmission.files, []);
    assert.equal(request.args.analysisDatabase, undefined);
    return { text: 'retained Ready source', structured: { schemaVersion: 1, operation: request.operation,
      data: { mode: 'ranked', query: 'Ready', visibility }, completeness: { complete: true }, diagnostics: [] } };
  };
  for (const args of [{ renderRanked: 'grep-ranked-all', rankedRenderAllowance: 2000 }, { cursor: 'grep-ranked-all', retainRankedRender: true, rankedRenderAllowance: 4000 }]) {
    const result = await callAnalysisNavigation({ root: options.temporary, operation: 'pi_nav_search', args }, options, native);
    assert.equal(result.text, 'retained Ready source');
    const resumed = calls.filter(call => call.operation === 'pi_nav_search').at(-1);
    assert.deepEqual(Object.fromEntries(Object.entries(resumed.args).filter(([key]) => key !== 'corpusAdmission')), args);
    assert.equal(resumed.root, options.root);
    assert.deepEqual(result.corpusOptions, { metadataOnly: true, visibility: 'all' });
  }
  assert.deepEqual(calls.filter(call => call.operation !== 'pi_nav_files').map(call => call.operation), ['pi_nav_grep_cursor_owner', 'pi_nav_search', 'pi_nav_grep_cursor_owner', 'pi_nav_search']);
  for (const evidence of [['unknown'], [17], 'unknown']) {
    focus = { evidence };
    await assert.rejects(callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { cursor: 'grep-ranked-all' } }, options, native), /cursor descriptor is invalid/);
  }
  focus = { evidence: ['uses'] };
  visibility = 'project';
  corpusRoot = undefined;
  await assert.rejects(callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { cursor: 'grep-ranked-all' } }, options, native), /lacks corpus admission/);
});

test('root removal invalidates corpus admission and total deadline still fails closed', async t => {
  const options = fixture(t);
  const baseline = { text: 'captured live result', structured: { schemaVersion: 1, operation: 'pi_nav_search', data: { kind: 'symbol' }, completeness: {}, diagnostics: [] } };
  const request = { root: options.root, operation: 'pi_nav_search', args: { query: 'Ready', kind: 'symbol' } };
  await assert.rejects(callAnalysisNavigation(request, options, async call => {
    if (call.operation === 'pi_nav_files') return { text: '', structured: { ...baseline.structured, data: { root: options.root, corpusPolicyVersion: 1, files: [], directories: [''] }, completeness: { complete: true } } };
    rmSync(options.root, { recursive: true }); return baseline;
  }), /owning|corpus|ENOENT/);
  mkdirSync(options.root);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  await assert.rejects(callAnalysisNavigation({ ...request, timeoutMs: 10 }, options, async () => { now = 11; return { text: '', structured: { ...baseline.structured, data: { root: options.root, corpusPolicyVersion: 1, files: [], directories: [''] }, completeness: { complete: true } } }; }), /deadline/i);
});

test('ranked corpus admission preserves disabled and independent live navigation without opening an ancestor graph', async t => {
  const options = fixture(t);
  writeFileSync(join(options.root, 'ready.ts'), 'export function Ready() {}\n');
  const baseline = { text: 'live source', structured: { schemaVersion: 1, operation: 'pi_nav_search', data: { kind: 'symbol' }, completeness: { complete: true }, diagnostics: [] } };
  let inspected = 0;
  const calls = [];
  const project = { root: options.root, get directory() { inspected++; throw new Error('must not open graph'); } };
  const native = async request => {
    calls.push(request);
    if (request.operation === 'pi_nav_files') return { text: '', structured: { ...baseline.structured,
      data: { root: request.root, corpusPolicyVersion: 1, files: ['ready.ts'], directories: [''] } } };
    assert.deepEqual(request.args.corpusAdmission.files, ['ready.ts']);
    assert.equal(request.args.analysisDatabase, undefined);
    return baseline;
  };
  for (const config of ['{"architecture":false}', '{"architecture":{"enabled":false}}']) {
    writeFileSync(join(options.root, '.pi-navigation.json'), config);
    const output = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { query: 'Ready', kind: 'symbol' } }, project, native);
    assert.match(output.text, /live source/);
    assert.match(output.text, /disabled/);
    assert.equal(inspected, 0);
    assert.equal(calls[0].operation, 'pi_nav_files', 'admission must precede live collection');
  }
  const child = join(options.root, 'independent');
  mkdirSync(child);
  writeFileSync(join(child, '.pi-navigation.json'), '{"architecture":false}');
  writeFileSync(join(child, 'ready.ts'), 'export function Ready() {}\n');
  const output = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { query: 'Ready', kind: 'symbol', scope: child } }, project, native);
  assert.match(output.text, /another project/);
  assert.equal(output.corpusAdmission.root, child);
  assert.equal(inspected, 0);
});

test('ranked corpus malformed policy refuses before any collection', async t => {
  const options = fixture(t);
  writeFileSync(join(options.root, '.pi-navigation.json'), '{');
  let calls = 0;
  await assert.rejects(callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { query: 'Ready', kind: 'symbol' } }, options,
    async () => { calls++; throw new Error('must not collect'); }), /Invalid navigation scope configuration/);
  assert.equal(calls, 0);
});

test('ranked corpus missing preparation and globs keep admitted live output; explicit audits stay distinct', async t => {
  const options = fixture(t);
  writeFileSync(join(options.root, 'ready.ts'), 'export function Ready() {}\n');
  writeFileSync(join(options.root, 'text.zip'), 'Ready is ordinary text despite its suffix\n');
  writeFileSync(join(options.root, '.pi-navigation.json'), '{"scope":{"exclude":["private"]}}');
  const baseline = { text: 'live source', structured: { schemaVersion: 1, operation: 'pi_nav_search', data: { kind: 'symbol' }, completeness: { complete: true }, diagnostics: [] } };
  const calls = [];
  const native = async request => {
    calls.push(request);
    if (request.operation === 'pi_nav_files') {
      assert.deepEqual(request.args.corpusPolicy.excludedPrefixes, ['private']);
      return { text: '', structured: { ...baseline.structured, data: { root: options.root, corpusPolicyVersion: 1, corpusVisibility: request.args.visibility, files: ['ready.ts', 'text.zip'], directories: [''] } } };
    }
    return baseline;
  };
  for (const extra of [{}, { glob: '*.ts' }]) {
    calls.length = 0;
    const output = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { query: 'Ready', kind: 'symbol', ...extra } }, options, native);
    assert.match(output.text, /live source/);
    assert.deepEqual(calls.find(call => call.operation === 'pi_nav_search').args.corpusAdmission.files, ['ready.ts']);
    assert.equal(existsSync(options.directory), false);
  }
  const matches = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { output: 'matches', pattern: 'Ready' } }, options, native);
  assert.equal(matches.text, baseline.text);
  assert.deepEqual(matches.matchesAdmission.owners[0].policy.excludedPrefixes, ['private']);
  assert.equal(Object.keys(matches).includes('matchesAdmission'), false);
  for (const args of [{ query: 'Ready', kind: 'content' }, { query: 'Ready', kind: 'regex' }, { query: 'Ready', visibility: 'all' }]) {
    calls.length = 0;
    const output = await callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args }, options, native);
    assert.equal(output.text, baseline.text);
    assert.deepEqual(calls.filter(call => call.operation === 'pi_nav_search').map(call => call.args.corpusAdmission.files), [['ready.ts', 'text.zip']], 'text eligibility must not inherit preparation suffix filtering');
    assert.equal(calls.some(call => call.args.analysisDatabase), false);
    await validateRankedCorpus(output, native);
  }
});

test('ranked corpus policy drift cannot return a saved baseline', async t => {
  const options = fixture(t);
  writeFileSync(join(options.root, 'ready.ts'), 'export function Ready() {}\n');
  const baseline = { text: 'must not escape', structured: { schemaVersion: 1, operation: 'pi_nav_search', data: { kind: 'symbol' }, completeness: { complete: true }, diagnostics: [] } };
  await assert.rejects(callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { query: 'Ready', kind: 'symbol' } }, options, async request => {
    if (request.operation === 'pi_nav_files') return { text: '', structured: { ...baseline.structured, data: { root: options.root, corpusPolicyVersion: 1, files: ['ready.ts'], directories: [''] } } };
    writeFileSync(join(options.root, '.pi-navigation.json'), '{"scope":{"exclude":["ready.ts"]}}');
    return baseline;
  }), /ranked corpus changed/);
});

test('registered selected trace preserves direction, identity, paging and unavailable sibling results', async t => {
  const project = fixture(t);
  const initialized = initializeAnalysisProject(project);
  const database = new Database(initialized.database);
  try { database.prepare("UPDATE project_metadata SET value = ? WHERE key = 'codeweave-pi.g1'").run(JSON.stringify({ ...initialized.metadata, generation: 1 })); }
  finally { database.close(); }
  writeFileSync(join(project.root, 'ready.ts'), 'export function Ready() {}\n');
  const calls = [];
  let unavailable = false;
  let tool;
  const callNative = async request => {
    calls.push(request);
    const structured = { schemaVersion: 1, operation: request.operation, data: { kind: 'symbol' }, completeness: { complete: true }, diagnostics: [] };
    if (request.operation === 'pi_nav_files') return { text: '', structured: { ...structured, data: { root: project.root, corpusPolicyVersion: 1, files: ['ready.ts'], directories: [''] } } };
    if (!request.args.analysisDatabase) {
      assert.equal(request.args.analysisRelation, undefined, 'the live baseline is not a graph request');
      assert.equal(request.args.captureRanked, undefined, 'qualified transitional requests do not weaken capture identity');
      return { text: 'live source baseline', structured };
    }
    if (request.args.query === 'Legacy') return { text: 'undirected prepared overview', structured: { ...structured, data: { analysis: { status: 'ok' } } } };
    if (unavailable || request.args.query === 'Missing') throw new Error('prepared source changed');
    return { text: `directed ${request.args.analysisRelation} page ${request.args.page}`, structured: { ...structured, data: { analysis: {
      status: 'ok', relation: request.args.analysisRelation, targetId: 'function:ready', generation: 1,
      page: request.args.page, limit: request.args.limit, totalConnections: 4, connections: [],
    } } } };
  };
  registerTraceTool({ registerTool(value) { tool = value; } }, { analysisProject: project, callNative });
  for (const relation of ['callers', 'callees']) {
    const result = await tool.execute('trace', { target: 'ready.ts::Ready', relation, page: 2, limit: 3 }, undefined, undefined, { cwd: project.root });
    assert.match(result.content[0].text, new RegExp(`directed ${relation} page 2`));
    const searches = calls.filter(call => call.operation === 'pi_nav_search');
    const last = searches.at(-1);
    assert.equal(last.args.query, 'ready.ts::Ready', 'prepared lookup keeps the exact requested identity');
    assert.equal(searches.at(-2).args.query, 'Ready', 'only the explicitly unbound live fallback searches the symbol spelling');
    assert.equal(searches.at(-2).args.scope, join(project.root, 'ready.ts'));
    assert.equal(last.args.analysisRelation, relation);
    assert.equal(last.args.page, 2);
    assert.equal(last.args.limit, 3);
    assert.equal(result.details.native.data.analysis.targetId, 'function:ready');
  }
  const legacy = await tool.execute('trace', { target: 'Legacy', relation: 'callees' }, undefined, undefined, { cwd: project.root });
  assert.match(legacy.content[0].text, /UNAVAILABLE[\s\S]*live source baseline/);
  assert.doesNotMatch(legacy.content[0].text, /undirected prepared overview/);
  assert.equal(legacy.details.native.data.analysis, undefined);
  const batch = await tool.execute('batch', { targets: ['Ready', 'Missing'], relation: 'callees' }, undefined, undefined, { cwd: project.root });
  assert.deepEqual(batch.details.queries.map(item => [item.target, item.status]), [['Ready', 'success'], ['Missing', 'warning']]);
  assert.match(batch.content[0].text, /live source baseline/);
  unavailable = true;
  const missing = await tool.execute('trace', { target: 'Ready', relation: 'callees' }, undefined, undefined, { cwd: project.root });
  assert.match(missing.content[0].text, /UNAVAILABLE[\s\S]*not a completed directed relation[\s\S]*live source baseline/);
  assert.equal(missing.details.envelope.status, 'warning');
  assert.equal(missing.details.native.data.analysis, undefined);
  assert.ok(calls.every(request => ['pi_nav_search', 'pi_nav_files'].includes(request.operation)));
});

test('registered prepared transport retains certified live source when the actual result boundary refuses enrichment', async t => {
  const project = fixture(t);
  const initialized = initializeAnalysisProject(project);
  const database = new Database(initialized.database);
  try { database.prepare("UPDATE project_metadata SET value = ? WHERE key = 'codeweave-pi.g1'").run(JSON.stringify({ ...initialized.metadata, generation: 1 })); }
  finally { database.close(); }
  writeFileSync(join(project.root, '.pi-navigation.json'), '{}');
  const cwd = join(project.root, 'client');
  mkdirSync(cwd);
  const file = join(project.root, 'ready.ts');
  const lines = ['export function Ready() {}', 'export function Connected() {}'];
  const source = `${lines.join('\n')}\n`;
  writeFileSync(file, source);
  const snapshot = { canonicalPath: file, text: source, rawDigest: createHash('sha256').update(source).digest('hex').toUpperCase(), lineEnding: 'lf', bom: false };
  const sourceOutput = line => ({
    text: `ready.ts\n${line}: ${lines[line - 1]}`,
    sourceRoot: project.root,
    structured: { schemaVersion: 1, operation: 'pi_nav_search',
      data: { kind: 'symbol', sourceRows: [{ path: 'ready.ts', line, text: lines[line - 1], visibility: 'visible_complete', transformation: 'verbatim' }] },
      completeness: { returned: 1, total: 1, complete: true }, diagnostics: [],
    },
  });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const relation of ['grep', 'callers', 'callees']) {
    for (const mode of ['fits', 'metadata', 'text', 'snapshots', 'baseline-refused', 'deadline', 'cancelled']) {
      await t.test(`${relation}: ${mode}`, async () => {
        now = 0;
        const baseline = sourceOutput(1);
        const prepared = sourceOutput(2);
        const analysis = { status: 'ok', generation: 1, relation, targetId: 'function:ready', page: 2, limit: 200,
          connections: Array.from({ length: mode === 'fits' || mode === 'text' ? 2 : 400 }, (_, edgeId) => ({
            edgeId, kind: 'calls', fromNodeId: 'function:ready', toNodeId: `function:connected:${edgeId}`,
            target: { qualifiedName: 'Connected', description: 'stored connection identity context '.repeat(40) },
          })),
        };
        prepared.structured.data.analysis = analysis;
        if (mode === 'text') prepared.text += `\n${'Optional prepared context. '.repeat(10_000)}`;
        if (mode === 'baseline-refused') baseline.structured.data.unsafeLivePayload = 'UNSAFE_BASELINE '.repeat(40_000);
        if (mode === 'snapshots') baseline.sourceSnapshots = [snapshot];
        // Exercise the actual refusal contract; no local copy of either safety limit.
        const boundary = nativeToolResult(prepared.text, prepared.structured, harnessEnvelope({ status: 'success', summary: 'probe', next_actions: [], artifacts: [] }));
        assert.equal(boundary.details.envelope.status, mode === 'fits' ? 'success' : 'error');
        const calls = [];
        const abort = new AbortController();
        const reason = new Error('cancelled during saved-live certification');
        const callNative = async request => {
          calls.push(request);
          const workCalls = calls.filter(call => call.operation !== 'pi_nav_files');
          now = [1_000, 3_000, 20_000, mode === 'deadline' ? 26_000 : 24_000][workCalls.length - 1] ?? now;
          if (request.operation === 'pi_nav_files') return { text: '', structured: { ...baseline.structured,
            operation: request.operation, data: { root: project.root, corpusPolicyVersion: 1, files: ['ready.ts'], directories: [''] },
          } };
          if (request.operation === 'pi_nav_source_proof') {
            assert.equal(request.root, project.root, 'certification keeps the captured source root, not the agent cwd');
            assert.deepEqual(request.args.paths, [file]);
            if (mode === 'cancelled' && workCalls.length === 4) abort.abort(reason);
            return { text: '', structured: { ...baseline.structured, operation: request.operation, data: {} }, sourceSnapshots: [snapshot] };
          }
          assert.equal(request.operation, 'pi_nav_search', 'no provider hook or extra operation');
          if (request.args.analysisDatabase) return prepared;
          assert.equal(request.args.analysisRelation, undefined);
          return baseline;
        };
        if (relation === 'grep' && mode === 'fits') {
          const output = await callAnalysisNavigation({ root: project.root, operation: 'pi_nav_search', args: { query: 'Ready', kind: 'symbol' } }, project, callNative);
          assert.deepEqual(output.liveFallback, baseline);
          assert.equal(output.structured, prepared.structured, 'fitting metadata is not copied, trimmed or rewritten');
          assert.equal(Object.getOwnPropertyDescriptor(output, 'liveFallback').enumerable, false);
          assert.equal(Object.hasOwn({ ...output }, 'liveFallback'), false);
          assert.doesNotMatch(JSON.stringify(output), /liveFallback|export function Ready/);
          calls.length = 0;
          now = 0;
        }
        let tool;
        (relation === 'grep' ? registerGrepTool : registerTraceTool)({ registerTool(value) { tool = value; } }, { analysisProject: project, callNative });
        const params = relation === 'grep'
          ? { pattern: 'Ready', paths: file, syntax: 'symbol', output: 'ranked' }
          : { target: 'ready.ts::Ready', scope: project.root, relation, page: 2, limit: 200 };
        const execute = tool.execute('transport', params, abort.signal, undefined, { cwd });
        let result;
        if (mode === 'cancelled' && relation !== 'grep') await assert.rejects(execute, error => error === reason);
        else result = await execute;
        const needsLiveProof = mode !== 'fits' && mode !== 'snapshots';
        const workCalls = calls.filter(call => call.operation !== 'pi_nav_files');
        assert.deepEqual(workCalls.map(call => call.operation), ['pi_nav_search', 'pi_nav_search', 'pi_nav_source_proof', ...(needsLiveProof ? ['pi_nav_source_proof'] : [])]);
        assert.equal(workCalls[2].timeoutMs, 22_000);
        if (needsLiveProof) assert.equal(workCalls[3].timeoutMs, 5_000, 'saved-live certification shares the original deadline');
        assert.equal(prepared.structured.data.analysis, analysis, 'refusal never mutates the original graph identity');
        assert.equal(baseline.structured.data.analysis, undefined);
        assert.deepEqual(baseline.structured.diagnostics, [], 'fallback wording does not mutate the saved output');
        if (!result) return;
        assert.doesNotMatch(JSON.stringify(result), /liveFallback|sourceSnapshots|rawDigest|UNSAFE_BASELINE/);
        if (['baseline-refused', 'deadline', 'cancelled'].includes(mode)) {
          assert.equal(result.details.envelope.status, 'error');
          assert.doesNotMatch(result.content[0].text, /Live source authority/);
          return;
        }
        // Existing authority presentation uses absolute paths outside the agent cwd.
        assert.ok(result.content[0].text.includes(`Live source authority\n[${file}#`));
        assert.match(result.content[0].text, new RegExp(`\\] lines ${mode === 'fits' ? 2 : 1}$`, 'm'));
        assert.ok(result.details.envelope.artifacts.some(artifact => artifact.startsWith(`[${file}#`)));
        if (mode === 'fits') {
          assert.equal(result.details.envelope.status, 'success');
          assert.deepEqual(result.details.native.data.analysis, analysis, 'all fitting graph metadata survives final assembly');
          assert.match(result.content[0].text, /export function Connected/);
          assert.doesNotMatch(result.content[0].text, /Prepared connections unavailable|export function Ready/);
        } else {
          assert.match(result.content[0].text, /export function Ready/);
          assert.match(result.content[0].text, /Prepared connections unavailable/);
          assert.doesNotMatch(result.content[0].text, /export function Connected|Optional prepared context/);
          assert.equal(result.details.native.data.analysis, undefined);
          assert.deepEqual(result.details.native.data.sourceRows, baseline.structured.data.sourceRows);
          assert.doesNotMatch(JSON.stringify(result), /stored connection identity context|function:connected/);
          if (relation !== 'grep') {
            assert.equal(result.details.envelope.status, 'warning');
            assert.match(result.content[0].text, new RegExp(`UNAVAILABLE: prepared ${relation}[\\s\\S]*not a completed directed relation`));
            assert.match(result.details.envelope.summary, /unavailable; live source retained/);
          }
        }
      });
    }
  }
});

test('ranked corpus live continuation is re-admitted without a database; legacy unbound ranked cursors refuse', async t => {
  const options = fixture(t);
  writeFileSync(join(options.root, 'ready.ts'), 'export function Ready() {}\n');
  for (const admitted of [false, true]) {
    const calls = [];
    const native = async request => {
      calls.push(request);
      const data = request.operation === 'pi_nav_grep_cursor_owner'
        ? { ownsCursor: true, rankedCursor: { query: 'Ready', scope: options.root, visibility: 'project', ...(admitted ? { corpusRoot: options.root } : {}) } }
        : request.operation === 'pi_nav_files' ? { root: options.root, corpusPolicyVersion: 1, files: ['ready.ts'], directories: [''] }
        : { kind: 'symbol', mode: 'ranked', query: 'Ready' };
      return { text: 'Ready source', structured: { schemaVersion: 1, operation: request.operation, data, completeness: { complete: true }, diagnostics: [] } };
    };
    const result = callAnalysisNavigation({ root: options.root, operation: 'pi_nav_search', args: { cursor: 'grep-ranked-test' } }, options, native);
    if (!admitted) {
      await assert.rejects(result, /ranked cursor lacks corpus admission/);
      assert.deepEqual(calls.map(call => call.operation), ['pi_nav_grep_cursor_owner']);
    } else {
      const completed = await result;
      assert.match(completed.text, /Ready source/);
      assert.match(completed.text, /Prepared connections unavailable in this retained live capture/);
      assert.deepEqual(calls.map(call => call.operation), ['pi_nav_grep_cursor_owner', 'pi_nav_files', 'pi_nav_search', 'pi_nav_files']);
      assert.deepEqual(calls[2].args.corpusAdmission.files, ['ready.ts']);
      assert.ok(calls.every(call => call.args.analysisDatabase === undefined));
    }
  }
});

test('machine-local indexed paths are deterministic, root-isolated and read-only', t => {
  const { temporary, root } = fixture(t);
  const indexRoot = join(temporary, 'indexes');
  const first = deriveAnalysisProject(root, indexRoot);
  assert.deepEqual(first, deriveAnalysisProject(root, indexRoot));
  assert.equal(first.kind, 'indexed');
  assert.match(first.directory, /codegraph\/[a-f0-9]{64}$/);
  const other = join(temporary, 'other'); mkdirSync(other);
  assert.notEqual(first.directory, deriveAnalysisProject(other, indexRoot).directory);
  assert.equal(existsSync(indexRoot), false);
  assert.throws(() => deriveAnalysisProject(root, 'relative'), /absolute normalized/);
});

test('indexed consumer bridge keeps legacy roots and missing stores unchanged and validates projection identity', async t => {
  const { temporary, root } = fixture(t);
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'ready.ts'), 'export function Ready() {}\n');
  const indexRoot = join(temporary, 'indexes'), configPath = join(temporary, 'automation.json');
  writeFileSync(configPath, JSON.stringify({ storage: { indexRoot }, backends: { docs: { mode: 'richDocs' } } }));
  const previous = process.env.PI_NAV_AUTOMATION_CONFIG;
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
  t.after(() => { if (previous === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG; else process.env.PI_NAV_AUTOMATION_CONFIG = previous; });
  const project = deriveAnalysisProject(root, indexRoot);
  const calls = [];
  const runId = '11111111-1111-4111-8111-111111111111';
  let wrongMode = false, revoke = false;
  const native = async request => {
    calls.push(request);
    const envelope = { schemaVersion: 1, operation: request.operation, completeness: { complete: true }, diagnostics: [] };
    if (request.operation === 'pi_nav_files') return { text: '', structured: { ...envelope,
      data: { root, corpusPolicyVersion: 1, files: ['ready.ts'], directories: [''] } } };
    assert.equal(request.operation, 'pi_nav_search');
    assert.equal(request.args.analysisDatabase, join(project.directory, 'graph.sqlite'));
    assert.equal(request.args.analysisRevision, MAINTENANCE_REVISION);
    assert.deepEqual(request.args.analysisProjection, { operation: 'search', nodeKinds: ['function'] });
    assert.deepEqual(request.args.corpusAdmission.files, ['ready.ts']);
    assert.equal(request.args.analysisModelDirectory, analysisSemanticModelDirectory());
    for (const field of ['page', 'limit', 'analysisRelation', 'captureRanked', 'resumeRanked']) assert.equal(request.args[field], undefined);
    if (revoke) writeFileSync(join(root, '.pi-navigation.json'), JSON.stringify({ scope: { exclude: ['ready.ts'] } }));
    return { text: 'bounded projection', structured: { ...envelope, data: {
      mode: wrongMode ? 'ranked' : 'analysis_projection', operation: 'search', query: 'Ready', status: 'ok',
      nodes: [], edges: [], candidates: [], roots: [], analysis: {
        indexedRunId: runId, indexedStatusDigest: 'a'.repeat(64), interpretationRevision: MAINTENANCE_REVISION,
        policyDigest: request.args.analysisPolicyDigest,
      },
    } } };
  };
  const request = { root, query: 'Ready', projection: { operation: 'search', nodeKinds: ['function'] } };
  assert.equal(await callIndexedGraphNavigation(request, native), undefined);
  assert.equal(calls.length, 0); assert.equal(existsSync(indexRoot), false);
  mkdirSync(project.directory, { recursive: true, mode: 0o700 });
  const database = join(project.directory, 'graph.sqlite');
  writeFileSync(database, 'fixture native reader owns readiness validation', { mode: 0o600 });
  const before = receipt(database);
  assert.equal(await callIndexedGraphNavigation(request, native), undefined, 'unmarked stores are not adopted');
  writeFileSync(join(project.directory, MAINTENANCE_STATUS_FILE), 'routing hint; native stub owns validation', { mode: 0o600 });
  const output = await callIndexedGraphNavigation(request, native);
  assert.equal(output.structured.data.analysis.indexedRunId, runId);
  assert.equal(JSON.stringify(output).includes('corpusAdmission'), false, 'admission remains a private handoff');
  wrongMode = true;
  await assert.rejects(callIndexedGraphNavigation(request, native), /projection or completed-run identity/);
  wrongMode = false;
  await assert.rejects(callIndexedGraphNavigation({ ...request, runId: '22222222-2222-4222-8222-222222222222' }, native), /completed-run identity/);
  revoke = true;
  await assert.rejects(callIndexedGraphNavigation(request, native), /admission|policy|changed|excluded/i);
  revoke = false;
  writeFileSync(join(root, '.pi-navigation.json'), JSON.stringify({ architecture: { backend: 'crg' } }));
  calls.length = 0;
  assert.equal(await callIndexedGraphNavigation(request, native), undefined, 'explicit legacy ownership never switches query backends');
  assert.equal(calls.length, 0); assert.deepEqual(receipt(database), before);
});

test('indexed Explore reuses registered search, traversal, ambiguity and numbered pages without legacy execution', async t => {
  const { temporary, root } = fixture(t);
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'ready.ts'), 'export function Ready() { return Other(); }\nexport function Other() {}\n');
  const indexRoot = join(temporary, 'indexes'), configPath = join(temporary, 'automation.json');
  writeFileSync(configPath, JSON.stringify({ storage: { indexRoot } }));
  const previous = process.env.PI_NAV_AUTOMATION_CONFIG;
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
  t.after(() => { if (previous === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG; else process.env.PI_NAV_AUTOMATION_CONFIG = previous; });
  const project = deriveAnalysisProject(root, indexRoot);
  mkdirSync(project.directory, { recursive: true, mode: 0o700 });
  const database = join(project.directory, 'graph.sqlite');
  writeFileSync(database, 'fixture native reader owns readiness validation', { mode: 0o600 });
  writeFileSync(join(project.directory, MAINTENANCE_STATUS_FILE), 'routing hint', { mode: 0o600 });
  const before = receipt(database), calls = [];
  const nodes = ['Ready', 'Other'].map((name, index) => ({ id: name, name, qualifiedName: name, kind: 'function',
    filePath: 'ready.ts', startLine: index + 1, endLine: index + 1, startColumn: 0, endColumn: 24, depth: index, isTestFile: false }));
  let ambiguous = false, badEndpoint = false, partial = false, revokeOnFinal = false, admissionReads = 0;
  const callNative = async request => {
    calls.push(request);
    const envelope = { schemaVersion: 1, operation: request.operation, completeness: { complete: true }, diagnostics: [] };
    if (request.operation === 'pi_nav_files') {
      if (++admissionReads === 3 && revokeOnFinal) writeFileSync(join(root, '.pi-navigation.json'), JSON.stringify({ scope: { exclude: ['ready.ts'] } }));
      return { text: '', structured: { ...envelope, data: { root, corpusPolicyVersion: 1, files: ['ready.ts'], directories: [''] } } };
    }
    assert.equal(request.operation, 'pi_nav_search');
    const projection = request.args.analysisProjection, search = projection.operation === 'search';
    const selected = projection.testOnly ? [] : nodes;
    return { text: 'projection', structured: { ...envelope, data: {
      mode: 'analysis_projection', query: request.args.query, operation: projection.operation, status: ambiguous ? 'ambiguous' : 'ok',
      nodes: ambiguous ? [] : selected, candidates: ambiguous ? nodes : [], roots: ambiguous || search ? [] : ['Ready'],
      edges: ambiguous || search ? [] : [
        { id: 1, source: 'Ready', target: badEndpoint ? 'missing' : 'Other', kind: 'calls', line: 1, column: 32, functionReference: false },
        { id: 2, source: 'Ready', target: 'Other', kind: 'calls', line: 1, column: 40, functionReference: false },
        { id: 3, source: 'Ready', target: 'Other', kind: 'references', line: 1, column: 48, functionReference: true }],
      coverage: { complete: !partial, reasons: partial ? ['node_cap'] : [] }, analysis: { indexedRunId: '11111111-1111-4111-8111-111111111111',
        indexedStatusDigest: 'a'.repeat(64), interpretationRevision: MAINTENANCE_REVISION, policyDigest: request.args.analysisPolicyDigest,
        semanticStatus: 'unavailable', scope: 'best-effort indexed relationships; not current binding or absence proof' },
    } } };
  };
  let tool; registerExploreTool({ registerTool: value => { tool = value; } }, { callNative });
  const query = args => tool.execute('indexed-explore', { view: 'code', scope: root, ...args }, undefined, undefined, { cwd: root });
  const first = await query({ operation: 'search', anchor: 'ready behavior', kind: 'Function', limit: 1 });
  assert.match(first.content[0].text, /ready.ts::Ready/);
  assert.match(first.content[0].text, /locator-only/);
  assert.match(first.content[0].text, /next_page=2/);
  const second = await query({ operation: 'search', anchor: 'ready behavior', kind: 'Function', limit: 1, page: 2 });
  assert.match(second.content[0].text, /ready.ts::Other/);
  assert.equal(first.details.native.project_navigation.generation_identity, second.details.native.project_navigation.generation_identity);
  const traversal = await query({ operation: 'traverse', anchor: 'ready.ts::Ready', depth: 1 });
  assert.match(traversal.content[0].text, /NODE depth=0.*ready.ts::Ready/);
  assert.match(traversal.content[0].text, /col0=32/); assert.match(traversal.content[0].text, /col0=40/);
  assert.match(traversal.content[0].text, /function value, not invocation/);
  assert.deepEqual(traversal.details.native.edges.map(row => row.id), [1, 2, 3]);
  ambiguous = true;
  const choices = await query({ operation: 'traverse', anchor: 'ready.ts::Ready' });
  assert.match(choices.content[0].text, /Ambiguity candidates:[\s\S]*ready.ts::Ready[\s\S]*ready.ts::Other/);
  ambiguous = false; await query({ operation: 'search', anchor: 'tests', kind: 'Test' });
  assert.ok(calls.some(request => request.args.analysisProjection?.testOnly === true));
  partial = true;
  const incomplete = await query({ operation: 'search', anchor: 'ready behavior' });
  assert.equal(incomplete.details.envelope.status, 'warning'); assert.match(incomplete.content[0].text, /Status: incomplete/);
  partial = false;
  badEndpoint = true;
  const refused = await query({ operation: 'traverse', anchor: 'ready.ts::Ready' });
  assert.match(refused.content[0].text, /invalid edge or missing endpoint/);
  badEndpoint = false; revokeOnFinal = true; admissionReads = 0;
  const revoked = await query({ operation: 'traverse', anchor: 'ready.ts::Ready' });
  assert.match(revoked.content[0].text, /changed|admission|policy/);
  assert.doesNotMatch(revoked.content[0].text, /NODE depth=|--calls/);
  assert.deepEqual(receipt(database), before);
  assert.equal(existsSync(join(root, '.code-review-graph')), false);
});

test('automatic indexed routing derives storage, preserves live fallback and never adopts or repairs a store', async t => {
  const { temporary, root } = fixture(t);
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'ready.ts'), 'export function Ready() {}\n');
  const indexRoot = join(temporary, 'indexes');
  const configPath = join(temporary, 'automation.json');
  writeFileSync(configPath, JSON.stringify({ storage: { indexRoot } }));
  const previous = process.env.PI_NAV_AUTOMATION_CONFIG;
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
  t.after(() => { if (previous === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG; else process.env.PI_NAV_AUTOMATION_CONFIG = previous; });
  const project = deriveAnalysisProject(root, indexRoot);
  const calls = [];
  const live = { text: 'Ready live', structured: { schemaVersion: 1, operation: 'pi_nav_search', data: { kind: 'symbol' }, completeness: { complete: true }, diagnostics: [] } };
  const native = async request => {
    calls.push(request);
    if (request.operation === 'pi_nav_files') return { text: '', structured: { ...live.structured, operation: request.operation,
      data: { root: request.root, corpusPolicyVersion: 1, files: ['ready.ts'], directories: [''] } } };
    if (request.args.analysisDatabase) {
      assert.equal(request.args.analysisDatabase, join(project.directory, 'graph.sqlite'));
      assert.equal(request.args.analysisRevision, MAINTENANCE_REVISION);
      assert.equal(request.args.analysisModelDirectory, request.args.kind === 'symbol' ? undefined : analysisSemanticModelDirectory());
      assert.deepEqual(request.args.corpusAdmission.files, ['ready.ts']);
      throw new Error('native ready-status validation refused');
    }
    return live;
  };
  const request = { root, operation: 'pi_nav_search', args: { query: 'Ready', kind: 'symbol' } };
  assert.deepEqual(await callAnalysisNavigation(request, undefined, native), live);
  assert.equal(calls.filter(call => call.operation === 'pi_nav_search').length, 1);
  assert.deepEqual(calls.find(call => call.operation === 'pi_nav_search').args.corpusAdmission.files, ['ready.ts']);
  assert.equal(existsSync(indexRoot), false, 'query must not create machine storage');
  mkdirSync(project.directory, { recursive: true, mode: 0o700 });
  const database = join(project.directory, 'graph.sqlite');
  writeFileSync(database, 'foreign bytes', { mode: 0o600 });
  const before = receipt(database);
  calls.length = 0;
  assert.deepEqual(await callAnalysisNavigation(request, undefined, native), live);
  assert.equal(calls.filter(call => call.operation === 'pi_nav_search').length, 1, 'an unmarked database is not adopted');
  const status = join(project.directory, MAINTENANCE_STATUS_FILE);
  writeFileSync(status, 'invalid status is only a routing hint', { mode: 0o600 });
  calls.length = 0;
  const fallback = await callAnalysisNavigation(request, undefined, native);
  assert.match(fallback.text, /Ready live[\s\S]*native ready-status validation refused/);
  assert.equal(calls.filter(call => call.args.analysisDatabase).length, 1);
  assert.deepEqual(receipt(database), before);
  assert.equal(readFileSync(status, 'utf8'), 'invalid status is only a routing hint');
  const assetsExisted = existsSync(analysisSemanticModelDirectory());
  await callAnalysisNavigation({ ...request, args: { query: 'persist data', kind: 'auto' } }, undefined, native);
  const semantic = calls.find(call => call.args.analysisDatabase && call.args.query === 'persist data');
  assert.equal(semantic.args.analysisModelDirectory, fileURLToPath(new URL('../native/analysis/runtime/semantic-model', import.meta.url)));
  assert.equal(existsSync(semantic.args.analysisModelDirectory), assetsExisted, 'routing never provisions assets');
  const child = join(root, 'independent'); mkdirSync(child);
  writeFileSync(join(child, 'package.json'), '{}');
  writeFileSync(join(child, 'ready.ts'), 'export function Ready() {}\n');
  calls.length = 0;
  assert.deepEqual(await callAnalysisNavigation({ ...request, args: { ...request.args, scope: child } }, undefined, native), live);
  assert.equal(calls.filter(call => call.operation === 'pi_nav_search').length, 1, 'an independent child must not borrow its ancestor graph');
  assert.equal(calls.find(call => call.operation === 'pi_nav_search').args.corpusAdmission.root, child);
  writeFileSync(configPath, JSON.stringify({ storage: { indexRoot: 'invalid\0storage' } }));
  calls.length = 0;
  const invalidStorage = await callAnalysisNavigation(request, undefined, native);
  assert.match(invalidStorage.text, /Ready live[\s\S]*machine storage configuration is unavailable/);
  assert.equal(calls.filter(call => call.operation === 'pi_nav_search').length, 1, 'invalid optional storage must not erase useful live evidence');
  assert.deepEqual(invalidStorage.corpusAdmission.files, ['ready.ts'], 'unavailable enrichment must not erase privacy');
});

test('automatic indexed cursors retain their owning root and reject mixed or changed run identities', async t => {
  const { temporary, root } = fixture(t);
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'ready.ts'), 'export function Ready() {}\n');
  const indexRoot = join(temporary, 'indexes');
  const configPath = join(temporary, 'automation.json');
  writeFileSync(configPath, JSON.stringify({ storage: { indexRoot } }));
  const previous = process.env.PI_NAV_AUTOMATION_CONFIG;
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
  t.after(() => { if (previous === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG; else process.env.PI_NAV_AUTOMATION_CONFIG = previous; });
  const project = deriveAnalysisProject(root, indexRoot);
  mkdirSync(project.directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(project.directory, 'graph.sqlite'), 'native owns SQL validation', { mode: 0o600 });
  const { compileLaneCorpusPolicy } = await import('../src/core/navigation-corpus-policy.ts');
  const policy = compileLaneCorpusPolicy(root, undefined, 'code');
  const identity = { indexedRunId: '11111111-1111-4111-8111-111111111111', interpretationRevision: MAINTENANCE_REVISION,
    policyDigest: policy.digest, corpusDigest: 'c'.repeat(64) };
  let descriptor = { ...identity };
  let response = { ...identity, indexedStatusDigest: 'd'.repeat(64) };
  const calls = [];
  const native = async request => {
    calls.push(request);
    const structured = { schemaVersion: 1, operation: request.operation, completeness: { complete: true }, diagnostics: [] };
    if (request.operation === 'pi_nav_grep_cursor_owner') return { text: '', sourceRoot: root, structured: { ...structured,
      data: { ownsCursor: true, rankedCursor: { query: 'Ready', scope: root, visibility: 'project', corpusRoot: root, analysis: descriptor } } } };
    if (request.operation === 'pi_nav_files') return { text: '', structured: { ...structured,
      data: { root, corpusPolicyVersion: 1, files: ['ready.ts'], directories: [''] } } };
    assert.equal(request.root, root, 'continuation follows its owner, not the new cwd');
    assert.equal(request.args.analysisRevision, MAINTENANCE_REVISION);
    assert.equal(request.args.analysisDatabase, join(project.directory, 'graph.sqlite'));
    assert.equal(request.args.analysisPolicyDigest, policy.digest);
    assert.deepEqual(request.args.analysisCorpusFiles, ['ready.ts']);
    assert.ok(request.args.cursor || request.args.renderRanked, 'no new collection');
    assert.equal(request.args.analysisModelDirectory, undefined, 'retained rendering never re-encodes the query');
    return { text: 'retained indexed Ready', structured: { ...structured, data: { mode: 'ranked', kind: 'symbol', query: 'Ready', analysis: response } } };
  };
  const request = { root: temporary, operation: 'pi_nav_search', args: { cursor: 'grep-ranked-indexed' } };
  for (const args of [request.args, { renderRanked: 'grep-ranked-indexed', rankedRenderAllowance: 1200 }]) {
    assert.equal((await callAnalysisNavigation({ ...request, args }, undefined, native)).text, 'retained indexed Ready');
  }
  assert.equal(existsSync(join(project.directory, MAINTENANCE_STATUS_FILE)), false, 'native alone owns status validation; the bridge does not fabricate it');
  for (const change of [{ indexedRunId: '22222222-2222-4222-8222-222222222222' }, { corpusDigest: 'e'.repeat(64) }, { generation: 1 }]) {
    response = { ...identity, ...change };
    await assert.rejects(callAnalysisNavigation(request, undefined, native), /frozen investigation/);
  }
  response = { ...identity };
  for (const change of [{ generation: 1 }, { captureDigest: 'a'.repeat(64) }, { interpretationRevision: ANALYSIS_REVISION },
    { corpusDigest: undefined }, { policyDigest: [policy.digest] }]) {
    descriptor = { ...identity, ...change };
    const before = calls.length;
    await assert.rejects(callAnalysisNavigation(request, undefined, native), /cursor descriptor is invalid/);
    assert.deepEqual(calls.slice(before).map(call => call.operation), ['pi_nav_grep_cursor_owner']);
  }
});
