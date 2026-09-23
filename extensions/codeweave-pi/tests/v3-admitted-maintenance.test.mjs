import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ANALYSIS_OUTPUT_ARTIFACTS, MAINTENANCE_OUTPUT_ARTIFACTS } from '../native/analysis/identity.mjs';

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('intact admitted maintenance uses private storage, refuses policy drift, and retires exclusions on reopen', { timeout: 120_000 }, async t => {
  const runtime = process.env.DEEPFIELD_MAINTENANCE_RUNTIME;
  assert.ok(runtime && path.isAbsolute(runtime), 'set DEEPFIELD_MAINTENANCE_RUNTIME to an actual analysis-build --maintenance-grammars output');
  for (const name of [...Object.values(ANALYSIS_OUTPUT_ARTIFACTS), ...Object.values(MAINTENANCE_OUTPUT_ARTIFACTS)]) {
    assert.ok(fs.statSync(path.join(runtime, name)).isFile(), name);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, MAINTENANCE_OUTPUT_ARTIFACTS.package), 'utf8')).type, 'commonjs');
  assert.deepEqual(fs.readFileSync(path.join(runtime, ANALYSIS_OUTPUT_ARTIFACTS.schema)), fs.readFileSync(path.join(extension, 'native/analysis/schema.sql')));
  assert.deepEqual(fs.readFileSync(path.join(runtime, MAINTENANCE_OUTPUT_ARTIFACTS.schema)), fs.readFileSync(path.join(extension, 'native/analysis/src/db/schema.sql')));
  const kernelPath = path.join(runtime, ANALYSIS_OUTPUT_ARTIFACTS.kernel);
  const kernelBefore = fs.statSync(kernelPath);
  t.after(() => assert.equal(fs.statSync(kernelPath).ino, kernelBefore.ino, 'maintenance must not replace the shared kernel'));
  fs.mkdirSync(path.join(extension, '.tmp'), { recursive: true });
  const work = fs.realpathSync(fs.mkdtempSync(path.join(extension, '.tmp/admitted-maintenance-')));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const root = path.join(work, 'project');
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, '.pi-navigation.json'), '{}');
  fs.writeFileSync(path.join(root, 'target.ts'), 'export function Wanted() { return 7; }\n');
  fs.writeFileSync(path.join(root, 'caller.ts'), "import { Wanted } from './target';\nimport { Hidden } from './private';\nexport function Caller() { return Wanted() + Hidden(); }\n");
  fs.writeFileSync(path.join(root, 'private.ts'), 'export function Hidden() { return 99; }\n');
  // Donor inclusion rules cannot override the authoritative supplied census.
  fs.writeFileSync(path.join(root, 'codegraph.json'), '{"include":["private.ts"]}');
  const directory = path.join(work, 'store');
  const admission = files => ({ root, files, policyFiles: [{ path: path.join(root, '.pi-navigation.json'),
    digest: createHash('sha256').update(fs.readFileSync(path.join(root, '.pi-navigation.json'))).digest('hex') }] });
  let invocation = 0;
  function run(options) {
    const input = path.join(work, `input-${++invocation}.json`);
    fs.writeFileSync(input, JSON.stringify(options));
    const child = spawnSync(process.execPath, [path.join(extension, 'tests/fixtures/admitted-maintenance-child.ts'), input, path.join(runtime, MAINTENANCE_OUTPUT_ARTIFACTS.entry)], { encoding: 'utf8', timeout: 40_000,
      env: { ...process.env, CODEGRAPH_PARSE_WORKERS: '1', NODE_COMPILE_CACHE: path.join(work, 'compile-cache') } });
    const packet = child.stdout.split('\n').find(line => line.startsWith('MAINTENANCE_PROBE '));
    assert.ok(packet, child.stderr + child.stdout + String(child.error ?? ''));
    const result = JSON.parse(packet.slice('MAINTENANCE_PROBE '.length));
    assert.ok(!result.attempts.includes('private.ts'), JSON.stringify(result));
    assert.equal(result.gitAttempts, 0, 'admitted census must bypass Git enumeration');
    assert.equal(fs.existsSync(path.join(root, '.codegraph')), false);
    return { status: child.status, ...result };
  }
  const first = run({ root, directory, admission: admission(['target.ts', 'caller.ts', 'codegraph.json']) });
  assert.equal(first.status, 0, JSON.stringify(first));
  assert.equal(first.output.result.success, true, JSON.stringify(first));
  assert.equal(first.output.result.filesIndexed, 2);
  assert.ok(first.workerMessages.some(message => message.script === MAINTENANCE_OUTPUT_ARTIFACTS.parseWorker && message.type === 'parse-result'), 'actual packaged parse worker returns results');
  assert.ok(first.workerMessages.some(message => message.script === MAINTENANCE_OUTPUT_ARTIFACTS.storeWorker && message.type === 'ack'), 'actual packaged store worker persists bundles');
  assert.equal(first.output.store.database, path.join(directory, 'graph.sqlite'));
  const rows = () => {
    const database = new DatabaseSync(first.output.store.database, { readOnly: true });
    try {
      assert.equal(database.prepare("SELECT count(*) AS n FROM project_metadata WHERE key='codeweave-pi.g1'").get().n, 0);
      return database.prepare('SELECT path FROM files ORDER BY path').all().map(row => row.path);
    } finally { database.close(); }
  };
  assert.deepEqual(rows(), ['caller.ts', 'target.ts']);
  fs.writeFileSync(path.join(root, '.pi-navigation.json'), '{"scope":{"exclude":["target.ts","private.ts"]}}');
  const updated = run({ root, directory, previous: first.output.store, admission: admission(['caller.ts', 'codegraph.json']) });
  assert.equal(updated.status, 0, JSON.stringify(updated));
  assert.equal(updated.output.result.filesRemoved, 1);
  assert.ok(!updated.attempts.includes('target.ts'), JSON.stringify(updated));
  assert.deepEqual(rows(), ['caller.ts']);
  // Reopen is caller-bound, never merely "a SQLite file exists".
  const foreign = run({ root, directory, previous: { ...first.output.store, ino: first.output.store.ino + 1 }, admission: admission(['caller.ts']) });
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.error, /identity changed/);
  const adoption = run({ root, directory, admission: admission(['caller.ts']) });
  assert.notEqual(adoption.status, 0);
  assert.match(adoption.error, /no store adoption/);
  const legacy = new DatabaseSync(first.output.store.database);
  legacy.prepare("INSERT INTO project_metadata(key,value,updated_at) VALUES ('codeweave-pi.g1','{}',0)").run();
  legacy.close();
  const wrongFormat = run({ root, directory, previous: first.output.store, admission: admission(['caller.ts']) });
  assert.notEqual(wrongFormat.status, 0);
  assert.match(wrongFormat.error, /no G1 adoption or schema migration/);
  fs.writeFileSync(path.join(root, '.pi-navigation.json'), '{}');
  const drift = run({ root, directory: path.join(work, 'drift-store'), drift: true, admission: admission(['target.ts', 'caller.ts']) });
  assert.notEqual(drift.status, 0, JSON.stringify(drift));
  assert.deepEqual(drift.driftChecks, [true, true, true]);
  assert.match(drift.error, /policy changed|Analysis helper failed/);
});

test('real reconciliation reprojects edited owners but preserves unchanged file bindings', { timeout: 120_000 }, t => {
  const runtime = process.env.DEEPFIELD_MAINTENANCE_RUNTIME;
  assert.ok(runtime && path.isAbsolute(runtime));
  const work = fs.realpathSync(fs.mkdtempSync(path.join(extension, '.tmp/semantic-incremental-')));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const root = path.join(work, 'source'); fs.mkdirSync(root);
  const policy = path.join(root, '.pi-navigation.json'); fs.writeFileSync(policy, '{}');
  fs.writeFileSync(path.join(root, 'stable.ts'), 'export function Stable() { return 7; }\n');
  fs.writeFileSync(path.join(root, 'edited.ts'), 'export function Edited() { return 1; }\n');
  const admission = { root, files: ['stable.ts', 'edited.ts'], policyFiles: [{ path: policy,
    digest: createHash('sha256').update('{}').digest('hex') }] };
  let previous;
  for (let step = 1; step <= 3; step++) {
    if (step === 3) fs.writeFileSync(path.join(root, 'edited.ts'), 'export function Edited() { return 2; }\n');
    const input = path.join(work, `${step}.json`);
    const runId = `${step}1111111-1111-4111-8111-111111111111`;
    fs.writeFileSync(input, JSON.stringify({ root, directory: path.join(work, 'store'), admission, previous, semanticProbe: runId }));
    const child = spawnSync(process.execPath, [path.join(extension, 'tests/fixtures/admitted-maintenance-child.ts'), input,
      path.join(runtime, MAINTENANCE_OUTPUT_ARTIFACTS.entry)], { encoding: 'utf8', timeout: 40_000,
      env: { ...process.env, CODEGRAPH_PARSE_WORKERS: '1' } });
    const line = child.stdout.split('\n').find(value => value.startsWith('MAINTENANCE_PROBE '));
    assert.ok(line, child.stderr + child.stdout);
    const packet = JSON.parse(line.slice('MAINTENANCE_PROBE '.length));
    assert.equal(child.status, 0, JSON.stringify(packet)); previous = packet.output.store;
    if (step === 1) assert.deepEqual([...new Set(packet.semanticOwners.map(value => value.split(':')[0]))].sort(), ['edited.ts', 'stable.ts']);
    if (step === 2) { assert.deepEqual(packet.semanticOwners, []); assert.equal(packet.output.result.filesModified, 0); }
    if (step === 3) {
      assert.ok(packet.semanticOwners.length > 0);
      assert.ok(packet.semanticOwners.every(value => value.startsWith('edited.ts:')));
      assert.equal(packet.output.result.filesModified, 1);
    }
    const database = new DatabaseSync(previous.database, { readOnly: true });
    try {
      const metadata = JSON.parse(database.prepare("SELECT value FROM project_metadata WHERE key='codeweave-pi.indexed-semantic.1'").get().value);
      assert.equal(metadata.status, 'available'); assert.equal(metadata.runId, runId);
    } finally { database.close(); }
  }
});

test('Go incremental method edits and removals refresh derived interfaces without reindexing unchanged files', { timeout: 120_000 }, async t => {
  const runtime = process.env.DEEPFIELD_MAINTENANCE_RUNTIME;
  assert.ok(runtime && path.isAbsolute(runtime), 'set DEEPFIELD_MAINTENANCE_RUNTIME to the current isolated build');
  fs.mkdirSync(path.join(extension, '.tmp'), { recursive: true });
  const work = fs.realpathSync(fs.mkdtempSync(path.join(extension, '.tmp/go-incremental-')));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const root = path.join(work, 'source'); fs.mkdirSync(root, { mode: 0o700 });
  const directory = path.join(work, 'store');
  fs.writeFileSync(path.join(root, '.pi-navigation.json'), '{}');
  fs.writeFileSync(path.join(root, 'go.mod'), 'module sample\n\ngo 1.22\n');
  fs.writeFileSync(path.join(root, 'types.go'), 'package sample\ntype IntFlusher interface { Flush(int) }\ntype StringFlusher interface { Flush(string) }\ntype Good struct{}\ntype Bad struct{}\n');
  fs.writeFileSync(path.join(root, 'other.ts'), 'export function Other() { return 1; }\nexport function Peer() { return Other(); }\n');
  const methods = type => `package sample\nfunc (Good) Flush(value ${type}) {}\nfunc (Bad) Flush(value string) {}\n`;
  fs.writeFileSync(path.join(root, 'methods.go'), methods('int'));
  let previous;
  let invocation = 0;
  const inspect = operation => {
    const database = new DatabaseSync(previous.database);
    try { return operation(database); } finally { database.close(); }
  };
  function run(files = ['.pi-navigation.json', 'go.mod', 'types.go', 'methods.go', 'other.ts']) {
    const input = path.join(work, `input-${++invocation}.json`);
    const admission = { root, files, policyFiles: [{ path: path.join(root, '.pi-navigation.json'), digest: createHash('sha256').update('{}').digest('hex') }] };
    fs.writeFileSync(input, JSON.stringify({ root, directory, admission, previous }));
    const child = spawnSync(process.execPath, [path.join(extension, 'tests/fixtures/admitted-maintenance-child.ts'), input, path.join(runtime, MAINTENANCE_OUTPUT_ARTIFACTS.entry)], {
      encoding: 'utf8', timeout: 40_000, env: { ...process.env, CODEGRAPH_PARSE_WORKERS: '1', NODE_COMPILE_CACHE: path.join(work, 'compile-cache') },
    });
    const packet = child.stdout.split('\n').find(line => line.startsWith('MAINTENANCE_PROBE '));
    assert.ok(packet, child.stderr + child.stdout + String(child.error ?? ''));
    const result = JSON.parse(packet.slice('MAINTENANCE_PROBE '.length));
    assert.equal(child.status, 0, JSON.stringify(result));
    previous = result.output.store;
    return result.output.result;
  }
  const implementations = () => inspect(db => db.prepare("SELECT s.name AS source,t.name AS target FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='implements' ORDER BY source,target").all().map(row => [row.source, row.target]));
  const dispatches = () => inspect(db => db.prepare("SELECT s.qualified_name AS source,t.qualified_name AS target FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='calls' AND s.language='go' AND json_extract(e.metadata,'$.synthesizedBy')='interface-impl' ORDER BY source,target").all().map(row => [row.source, row.target]));
  const unchanged = () => inspect(db => db.prepare("SELECT path,indexed_at,content_hash FROM files WHERE path IN ('types.go','other.ts') ORDER BY path").all());
  assert.equal(run().filesIndexed, 3);
  assert.deepEqual(implementations(), [['Bad', 'StringFlusher'], ['Good', 'IntFlusher']]);
  const baseline = unchanged();
  // A same-tag non-Go edge is not owned by the Go refresh pass.
  inspect(db => db.prepare("INSERT INTO edges(source,target,kind,provenance,metadata) SELECT a.id,b.id,'references','heuristic','{\"synthesizedBy\":\"interface-impl\"}' FROM nodes a,nodes b WHERE a.name='Other' AND b.name='Peer'").run());
  assert.equal(run().filesModified, 0);
  assert.deepEqual(unchanged(), baseline);
  fs.writeFileSync(path.join(root, 'methods.go'), methods('string'));
  assert.equal(run().filesModified, 1);
  assert.deepEqual(implementations(), [['Bad', 'StringFlusher'], ['Good', 'StringFlusher']]);
  assert.deepEqual(dispatches(), [['StringFlusher::Flush', 'Bad::Flush'], ['StringFlusher::Flush', 'Good::Flush']]);
  assert.deepEqual(unchanged(), baseline);
  fs.unlinkSync(path.join(root, 'methods.go'));
  assert.equal(run(['.pi-navigation.json', 'go.mod', 'types.go', 'other.ts']).filesRemoved, 1);
  assert.deepEqual(implementations(), []);
  assert.deepEqual(dispatches(), []);
  assert.deepEqual(unchanged(), baseline);
  assert.equal(inspect(db => db.prepare("SELECT count(*) AS n FROM edges e JOIN nodes s ON s.id=e.source WHERE s.language='typescript' AND json_extract(e.metadata,'$.synthesizedBy')='interface-impl'").get().n), 1);
});
