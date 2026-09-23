// Two ordinary registered codeweave-pi sessions sharing one disposable project and
// one machine index root. Proves the second session derives its refresh receipt
// from the shared published status (no `maintain`/`callNative`/`previous`
// injection), refreshes incrementally in its own process, and that both
// sessions' queries then consult that refreshed run.
//
// Env-gated: set DEEPFIELD_ORDINARY_CANDIDATE to a restaged analysis-candidate
// root whose native/analysis/runtime is populated. A skipped run is not
// acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_NAVIGATION_AUTOMATION_CONFIG } from '../src/core/navigation-automation-config.ts';
import { analysisProjectPaths, deriveAnalysisProject } from '../src/core/analysis-project.mjs';
import { MAINTENANCE_STATUS_FILE } from '../native/analysis/identity.mjs';

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidate = process.env.DEEPFIELD_ORDINARY_CANDIDATE;
const childFixture = path.join(extension, 'tests', 'fixtures', 'ordinary-session-child.mjs');
const TARGET_BEFORE = 'export function Wanted() { return 1; }\n';
const TARGET_AFTER = 'export function Wanted() { return 2; }\n';
const CALLER = "import { Wanted } from './target';\nexport function Caller() { return Wanted(); }\n";
const BETA = 'export function Beta() { return 3; }\n';
const CORPUS_SOURCES = ['beta.ts', 'caller.ts', 'target.ts'];

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tail = value => String(value ?? '').slice(-2000);

/** Candidate and checkout bytes must both match the candidate's own build record. */
function digestSnapshot() {
  const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'BUILD-INPUTS.json'), 'utf8'));
  assert.equal(path.resolve(manifest.source), extension, 'candidate BUILD-INPUTS.json must name this checkout as its source');
  return Object.entries(manifest.inputs).map(([relative, recorded]) => [
    relative,
    sha256(path.join(extension, relative)),
    sha256(path.join(candidate, relative)),
    recorded,
  ].join(':'));
}

/** One child session; one `SESSION_PROBE <json>` receipt per command. */
function startSession(label, inputPath, work) {
  const child = spawn(process.execPath, [childFixture, inputPath], {
    cwd: extension,
    env: { ...process.env, HOME: work, CODEGRAPH_PARSE_WORKERS: '1', NODE_COMPILE_CACHE: path.join(work, `compile-cache-${label}`) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const queued = [];
  const waiters = [];
  child.stdout.on('data', chunk => {
    stdout += chunk;
    let index;
    while ((index = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      if (!line.startsWith('SESSION_PROBE ')) continue;
      const receipt = JSON.parse(line.slice('SESSION_PROBE '.length));
      const waiter = waiters.shift();
      if (waiter) waiter(receipt);
      else queued.push(receipt);
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise(resolve => child.on('exit', (code, signal) => {
    for (const waiter of waiters.splice(0)) waiter({ error: `${label} exited: ${code ?? signal}`, stderr: tail(stderr) });
    resolve({ code, signal });
  }));
  return {
    label,
    diagnostics: () => `${label} stderr tail:\n${tail(stderr)}`,
    send(command, deadlineMs = 240_000) {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ error: `${label} already exited`, stderr: tail(stderr) });
      const receipt = queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label}: no receipt for '${command}' within ${deadlineMs}ms\n${tail(stderr)}`)), deadlineMs);
        waiters.push(value => { clearTimeout(timer); resolve(value); });
      });
      child.stdin.write(`${command}\n`);
      return receipt;
    },
    exit,
    async stopProcess() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      let timer;
      const ended = await Promise.race([exit.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
      clearTimeout(timer);
      if (!ended) { child.kill('SIGKILL'); await exit; }
    },
  };
}

test('two ordinary sessions share one disposable store and the second refresh is incremental', {
  skip: candidate ? false : 'Set DEEPFIELD_ORDINARY_CANDIDATE to a restaged analysis-candidate root; a skipped run is not acceptance',
  timeout: 900_000,
}, async t => {
  // 1. Candidate and checkout bytes match the candidate's build record.
  const digestsBefore = digestSnapshot();
  for (const row of digestsBefore) {
    const [relative, source, staged, recorded] = row.split(':');
    assert.equal(staged, recorded, `candidate copy diverged from BUILD-INPUTS.json: ${relative}`);
    assert.equal(source, recorded, `checkout source diverged from BUILD-INPUTS.json: ${relative}`);
  }

  // 2. Disposable project and machine policy: no project config file, docs off,
  // cloud/embedding/downloads off, graph false by default.
  fs.mkdirSync(path.join(extension, '.tmp'), { recursive: true });
  const work = fs.realpathSync(fs.mkdtempSync(path.join(extension, '.tmp', 'ordinary-two-session-')));
  const root = path.join(work, 'project');
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'target.ts'), TARGET_BEFORE);
  fs.writeFileSync(path.join(root, 'caller.ts'), CALLER);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const indexRoot = path.join(work, 'machine', 'indexes');
  const config = structuredClone(DEFAULT_NAVIGATION_AUTOMATION_CONFIG);
  config.storage.indexRoot = indexRoot;
  config.providers.allowCloud = false;
  config.providers.allowEmbeddings = false;
  config.providers.allowLocalModelDownloads = false;
  config.backends.docs = false;
  const configPath = path.join(work, 'automation.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const inputPath = path.join(work, 'session-input.json');
  fs.writeFileSync(inputPath, JSON.stringify({ root, candidateRoot: candidate, configPath, home: work }));

  const project = deriveAnalysisProject(root, indexRoot);

  const a = startSession('A', inputPath, work);
  const b = startSession('B', inputPath, work);
  t.after(async () => { await Promise.all([a.stopProcess(), b.stopProcess()]); fs.rmSync(work, { recursive: true, force: true }); });

  // 3. Session A: default registration, ordinary session_start, stays alive.
  const startA = await a.send('start');
  assert.equal(startA.state, 'ready', `session A did not reach ready: ${JSON.stringify(startA)}\n${a.diagnostics()}`);
  assert.equal(startA.disposition, 'indexed');
  assert.equal(startA.project.directory, project.directory, 'session A must select the machine store for this root');
  // The store exists only after the first run; reading its paths before that is
  // refused by design, so resolve them here.
  const store = analysisProjectPaths(project, false);
  const statusPath = path.join(store.directory, MAINTENANCE_STATUS_FILE);
  const readStatus = () => JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const hashStore = () => `${sha256(statusPath)}:${sha256(store.database)}`;
  const statusA = readStatus();
  const fileRows = () => {
    const database = new DatabaseSync(store.database, { readOnly: true });
    try { return database.prepare('SELECT path,indexed_at,content_hash FROM files ORDER BY path').all(); }
    finally { database.close(); }
  };
  const callerBefore = fileRows().find(row => row.path === 'caller.ts');
  const databaseBefore = fs.statSync(store.database);
  const firstQuery = await a.send('query');
  assert.match(firstQuery.grepRanked.text, /return 1/);
  assert.equal(firstQuery.grepRanked.analysis?.indexedRunId, statusA.runId,
    'A must open its query-side state before the other session refreshes it');

  // 4. The edit under test: target.ts changes, beta.ts appears, caller.ts is untouched.
  fs.writeFileSync(path.join(root, 'target.ts'), TARGET_AFTER);
  fs.writeFileSync(path.join(root, 'beta.ts'), BETA);

  // 5. Session B: new process, no injection; derives `previous` from the shared status.
  const startB = await b.send('start');
  assert.equal(startB.state, 'ready', `session B did not reach ready: ${JSON.stringify(startB)}\n${b.diagnostics()}`);
  const statusB = readStatus();
  assert.equal(statusB.state, 'ready');
  assert.notEqual(statusB.runId, statusA.runId, 'session B must publish its own run');
  const databaseAfter = fs.statSync(store.database);
  assert.equal(databaseAfter.ino, databaseBefore.ino, 'an incremental refresh must reuse the same database inode');
  assert.equal(statusB.databaseIno, databaseAfter.ino, 'session B receipt must name the live database inode');
  assert.equal(path.dirname(statusPath), store.directory, 'both sessions must share one store directory');
  const counts = statusB.counts ?? {};
  assert.equal(counts.filesAdded, 1, 'only beta.ts is added');
  assert.equal(counts.filesModified, 1, 'only target.ts is modified');
  assert.equal(counts.filesRemoved, 0);
  const refreshedFiles = fileRows();
  assert.deepEqual(refreshedFiles.map(row => row.path), CORPUS_SOURCES);
  assert.deepEqual(refreshedFiles.find(row => row.path === 'caller.ts'), callerBefore,
    'the unchanged caller retains its hash and indexing timestamp');

  // 6. Queries in both sessions after B published. No lifecycle event is emitted
  //    for either query, so this observes the shared store only.
  const storeBeforeQueries = hashStore();
  const queryB = await b.send('query');
  const queryA = await a.send('query');
  const storeAfterQueries = hashStore();
  t.diagnostic(JSON.stringify({ runs: [statusA.runId, statusB.runId], counts,
    readers: [queryA, queryB].map(receipt => ({ wantedRun: receipt.grepRanked.analysis?.indexedRunId, betaRun: receipt.grepBeta.analysis?.indexedRunId })) }));

  for (const [label, receipt] of [['B', queryB], ['A', queryA]]) {
    assert.match(receipt.grepRanked.text, /return 2/, `session ${label}: ranked grep must show the current source`);
    assert.match(receipt.grepMatches.text, /return 2/, `session ${label}: matches grep must show the current source`);
    assert.match(receipt.grepBeta.text, /export function Beta\(\).*return 3/,
      `session ${label}: the added symbol must deliver current source`);
    assert.equal(receipt.grepBeta.analysis?.indexedRunId, statusB.runId,
      `session ${label}: the newly added symbol must come from the refreshed indexed run`);
    assert.equal(receipt.grepRanked.analysis?.indexedRunId, statusB.runId,
      `session ${label}: ranked grep indexed identity must match the refreshed run`);
  }
  assert.equal(storeAfterQueries, storeBeforeQueries, 'queries must not change store or status bytes');

  // 7. The indexed lane writes nothing into the project.
  for (const relative of ['.code-review-graph', '.codegraph', '.pi/navigation']) {
    assert.equal(fs.existsSync(path.join(root, relative)), false, `${relative} must not exist in the project`);
  }

  // 8. Stop only after both sessions are ready and queried.
  assert.equal((await a.send('stop')).state, 'inactive');
  assert.equal((await b.send('stop')).state, 'inactive');
  assert.deepEqual(await a.exit, { code: 0, signal: null }, a.diagnostics());
  assert.deepEqual(await b.exit, { code: 0, signal: null }, b.diagnostics());

  // 9. The run must not have written to the candidate or the checkout source.
  assert.deepEqual(digestSnapshot(), digestsBefore, 'candidate and checkout source bytes must be unchanged by the run');
});
