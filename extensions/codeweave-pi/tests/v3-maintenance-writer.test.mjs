import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { compileLaneCorpusPolicy } from '../src/core/navigation-corpus-policy.ts';
import { fileURLToPath } from 'node:url';
import { runAdmittedMaintenance } from '../src/core/native-maintenance.ts';
import { spawnSupervisedProcess } from '../src/core/process-supervisor.ts';
import { ANALYSIS_OUTPUT_ARTIFACTS, MAINTENANCE_OUTPUT_ARTIFACTS, MAINTENANCE_REVISION, MAINTENANCE_STATUS_FILE } from '../native/analysis/identity.mjs';
import { DatabaseSync } from 'node:sqlite';
import { analysisProjectPaths, readMaintenanceStatus, maintenanceCorpusDigest } from '../src/core/analysis-project.mjs';

// Explicit isolated-build input; never load or rebuild installed artifacts.
const runtime = process.env.DEEPFIELD_MAINTENANCE_RUNTIME;
const kernel = process.env.DEEPFIELD_TEST_ANALYSIS_KERNEL ?? (runtime && path.join(runtime, ANALYSIS_OUTPUT_ARTIFACTS.kernel));
test('maintenance kernel holds OS writer ownership until the actual child exits', {
  skip: kernel ? false : 'Set DEEPFIELD_TEST_ANALYSIS_KERNEL to the isolated built kernel', timeout: 15_000,
}, async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'analysis-writer-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lock = path.join(directory, 'writer.lock');
  fs.writeFileSync(lock, 'stable lock inode', { flag: 'wx', mode: 0o600 });
  const before = fs.statSync(lock);
  const load = `const kernel = require(${JSON.stringify(fs.realpathSync(kernel))});`;
  const acquire = `kernel.acquireMaintenanceWriter(${JSON.stringify(lock)})`;
  const owner = spawn(process.execPath, ['-e', `${load}
    const held = ${acquire};
    let reentryRefused = false;
    try { ${acquire}; } catch { reentryRefused = true; }
    console.log(JSON.stringify({ held, reentryRefused }));
    process.stdin.resume();
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); });
  const exited = once(owner, 'exit');
  const lines = createInterface({ input: owner.stdout });
  const [first] = await once(lines, 'line');
  lines.close();
  assert.deepEqual(JSON.parse(first), { held: true, reentryRefused: true });
  function invoke(source) {
    const child = spawnSync(process.execPath, ['-e', load + source], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr + String(child.error ?? ''));
    return child.stdout.trim();
  }
  assert.equal(invoke(`console.log(JSON.stringify(${acquire}));`), 'false', 'second process must not own maintenance');
  const otherLock = path.join(directory, 'other-project.lock');
  fs.writeFileSync(otherLock, '', { flag: 'wx', mode: 0o600 });
  assert.equal(invoke(`console.log(JSON.stringify(kernel.acquireMaintenanceWriter(${JSON.stringify(otherLock)})));`), 'true', 'another project lock remains independent while the first writer is alive');
  owner.kill('SIGKILL');
  await exited;
  assert.equal(invoke(`console.log(JSON.stringify(${acquire}));`), 'true', 'crash releases ownership without deleting the file');
  const after = fs.statSync(lock);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'stable lock inode');
  const alias = path.join(directory, 'alias.lock');
  fs.symlinkSync(lock, alias);
  assert.equal(invoke(`try { kernel.acquireMaintenanceWriter(${JSON.stringify(alias)}); console.log('accepted'); } catch { console.log('refused'); }`), 'refused');
  const missing = path.join(directory, 'missing.lock');
  assert.equal(invoke(`try { kernel.acquireMaintenanceWriter(${JSON.stringify(missing)}); console.log('accepted'); } catch { console.log('refused'); }`), 'refused');
  assert.equal(fs.existsSync(missing), false, 'the lock capability does not create storage');
});

test('supervised admitted maintenance indexes and updates through the staged runtime', {
  skip: runtime ? false : 'Set DEEPFIELD_MAINTENANCE_RUNTIME to the actual builder output', timeout: 30_000,
}, async t => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'supervised-maintenance-')));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const request = fixture(work);
  const signal = new AbortController().signal;
  const first = await runAdmittedMaintenance(request, signal, runtime);
  assert.equal(first.status, 'finished');
  assert.equal(first.counts.filesIndexed, 2);
  const store = analysisProjectPaths(request, false);
  const initialStatus = readMaintenanceStatus(store);
  assert.equal(initialStatus.state, 'ready');
  assert.equal(initialStatus.runId, first.runId);
  assert.equal(initialStatus.policyDigest, request.admission.policyDigest);
  assert.equal(initialStatus.corpusDigest, maintenanceCorpusDigest([...request.admission.files].reverse()));
  assert.equal(initialStatus.counts.filesDiscovered, 2);
  const statusPath = path.join(request.directory, MAINTENANCE_STATUS_FILE);
  const readyBytes = fs.readFileSync(statusPath);
  const incompatible = JSON.stringify({ ...initialStatus, futureContract: true });
  fs.writeFileSync(statusPath, incompatible);
  await assert.rejects(runAdmittedMaintenance(request, signal, runtime), /invalid or incompatible maintenance status/);
  assert.equal(fs.readFileSync(statusPath, 'utf8'), incompatible, 'unknown formats are not rewritten');
  fs.writeFileSync(statusPath, readyBytes);
  fs.writeFileSync(path.join(request.root, 'caller.ts'), "import { second } from './targets';\nexport function Caller() { return second(); }\n");
  const updated = await runAdmittedMaintenance(request, signal, runtime); // stored ownership survives the caller
  assert.equal(updated.status, 'finished');
  assert.equal(updated.counts.filesModified, 1);
  assert.notEqual(updated.runId, first.runId);
  assert.equal(readMaintenanceStatus(store).runId, updated.runId);
  const database = new DatabaseSync(updated.store.database, { readOnly: true });
  try {
    const callees = database.prepare("SELECT t.name FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='calls' AND s.name='Caller'").all();
    assert.deepEqual(callees.map(row => row.name), ['second']);
  } finally { database.close(); }
  assert.equal(fs.existsSync(path.join(request.root, '.codegraph')), false);
  const currentStatus = fs.readFileSync(statusPath);
  const receiptWorker = path.join(work, 'receipt-only.mjs');
  fs.writeFileSync(receiptWorker, `process.stdin.once('data', () => { process.stdout.write(${JSON.stringify(JSON.stringify(updated) + '\n')}, () => process.exit(0)); });`);
  for (const change of [{ state: 'building' }, { state: 'failed' }, { runId: first.runId },
    { policyDigest: 'f'.repeat(64) }, { corpusDigest: 'e'.repeat(64) }]) {
    fs.writeFileSync(statusPath, JSON.stringify({ ...JSON.parse(currentStatus), ...change }));
    const unchanged = fs.readFileSync(statusPath);
    await assert.rejects(runAdmittedMaintenance(request, signal, runtime, receiptWorker), /Completed maintenance run is no longer ready/);
    assert.deepEqual(fs.readFileSync(statusPath), unchanged, 'receipt validation must not repair or rewrite status');
  }
  fs.writeFileSync(statusPath, currentStatus);
  const donorLock = path.join(request.directory, 'codegraph.lock');
  fs.writeFileSync(donorLock, String(process.pid), { mode: 0o600 });
  try {
    await assert.rejects(runAdmittedMaintenance(request, signal, runtime), /sync could not acquire the donor file lock/);
    assert.equal(readMaintenanceStatus(store).state, 'failed', 'a skipped sync is not a completed run');
  } finally { fs.unlinkSync(donorLock); }
  await assert.rejects(runAdmittedMaintenance(request, signal, runtime), /Interrupted maintenance remains unavailable/);
});

test('busy worker avoids maintenance; parent-pipe loss leaves an interrupted update ineligible', {
  skip: runtime ? false : 'Set DEEPFIELD_MAINTENANCE_RUNTIME to the actual builder output', timeout: 30_000,
}, async t => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'maintenance-parent-')));
  const request = fixture(work);
  const initial = await runAdmittedMaintenance(request, new AbortController().signal, runtime);
  assert.equal(initial.status, 'finished');
  const blockedRuntime = path.join(work, 'blocked-runtime');
  fs.mkdirSync(blockedRuntime);
  fs.copyFileSync(kernel, path.join(blockedRuntime, ANALYSIS_OUTPUT_ARTIFACTS.kernel));
  const entry = path.join(blockedRuntime, MAINTENANCE_OUTPUT_ARTIFACTS.entry);
  fs.writeFileSync(entry, `exports.MAINTENANCE_REVISION = ${JSON.stringify(MAINTENANCE_REVISION)}; exports.assertSourceBoundary = () => {}; exports.maintainAdmittedProject = async () => { require('node:fs').writeSync(2, 'ENTERED\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };\n`);
  const workerPath = fileURLToPath(new URL('../src/core/analysis-maintenance-worker.mjs', import.meta.url));
  const worker = spawnSupervisedProcess(process.execPath, [workerPath, blockedRuntime], { cwd: request.root, timeoutMs: 15_000 });
  t.after(async () => { worker.terminate(); await worker.done; fs.rmSync(work, { recursive: true, force: true }); });
  let stdout = '';
  worker.child.stdout.on('data', chunk => { stdout += chunk; });
  const lines = createInterface({ input: worker.child.stderr });
  worker.child.stdin.write(JSON.stringify(request) + '\n');
  let entered = false;
  for await (const line of lines) { if (line === 'ENTERED') { entered = true; break; } }
  assert.equal(entered, true, 'controlled worker reached blocked maintenance while owning the lock');
  const statusPath = path.join(request.directory, MAINTENANCE_STATUS_FILE);
  const building = fs.readFileSync(statusPath, 'utf8');
  assert.equal(JSON.parse(building).state, 'building');
  assert.notEqual(JSON.parse(building).runId, initial.runId);
  assert.equal(JSON.parse(building).databaseIno, initial.store.ino);
  fs.unlinkSync(entry); // A losing contender cannot load even this missing entry.
  const busy = await runAdmittedMaintenance(request, new AbortController().signal, blockedRuntime);
  assert.equal(busy.status, 'busy');
  assert.equal(fs.readFileSync(statusPath, 'utf8'), building, 'busy contender must not change status');
  worker.child.stdin.end();
  const exit = await worker.done;
  assert.equal(exit.signal, 'SIGKILL');
  assert.equal(stdout, '', 'interrupted work must not return a successful receipt');
  assert.equal(fs.readFileSync(statusPath, 'utf8'), building, 'killed run remains ineligible');
  // Reaching this refusal, rather than returning busy, also proves OS ownership
  // was released. Existing interrupted data is not silently repaired or adopted.
  await assert.rejects(runAdmittedMaintenance(request, new AbortController().signal, runtime), /Interrupted maintenance remains unavailable/);
});

function fixture(work) {
  const root = path.join(work, 'project');
  fs.mkdirSync(root, { mode: 0o700 });
  const policy = path.join(root, '.pi-navigation.json');
  fs.writeFileSync(policy, '{}');
  fs.writeFileSync(path.join(root, 'targets.ts'), 'export function first() { return 1; }\nexport function second() { return 2; }\n');
  fs.writeFileSync(path.join(root, 'caller.ts'), "import { first } from './targets';\nexport function Caller() { return first(); }\n");
  const snapshot = compileLaneCorpusPolicy(root, undefined, 'code', { home: work });
  return { root, directory: path.join(work, 'store'), timeoutMs: 20_000,
    admission: { root, files: ['targets.ts', 'caller.ts'], policyDigest: snapshot.digest, policyFiles: snapshot.policyFiles } };
}
