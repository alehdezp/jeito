// One admitted maintenance job. Only this OS-lock-owning child publishes
// indexed-run eligibility; ordinary query activation remains separate.
import { closeSync, existsSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { analysisProjectPaths, assertEmptyAnalysisProject, maintenanceCorpusDigest, maintenanceStatusIdentity,
  readMaintenanceStatus, writeMaintenanceStatus } from './analysis-project.mjs';
import { ANALYSIS_OUTPUT_ARTIFACTS, MAINTENANCE_OUTPUT_ARTIFACTS, KERNEL_VERSION, MAINTENANCE_REVISION } from '../../native/analysis/identity.mjs';
import { analysisSemanticModelDirectory, callPiNav, getPiNavSemanticInfo } from './pi-nav-native.ts';

const require = createRequire(import.meta.url);
const pipe = new Worker(new URL('./analysis-parent-pipe.mjs', import.meta.url), { execArgv: [] });
pipe.on('error', () => fail(new Error('Maintenance parent pipe failed')));
pipe.on('messageerror', () => fail(new Error('Maintenance request could not be delivered')));
pipe.once('message', request => run(request).then(result => {
  writeSync(1, JSON.stringify(result) + '\n');
  process.exit(0);
}, fail));
// Donor diagnostics must not contaminate the bounded JSON result channel.
console.log = console.info = console.debug = (...values) => console.error(...values);

function fail(error) {
  writeSync(2, String(error?.message ?? 'Maintenance failed').slice(0, 500) + '\n');
  process.exit(1);
}

async function run(request) {
  const started = performance.now();
  if (!request || typeof request.root !== 'string' || typeof request.directory !== 'string'
    || request.admission?.root !== request.root || !Number.isSafeInteger(request.timeoutMs)
    || request.timeoutMs < 1 || request.timeoutMs > 1_200_000 || !Array.isArray(request.admission.files)
    || typeof request.admission.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(request.admission.policyDigest)) throw new Error('Invalid maintenance request');
  const runtime = process.argv[2];
  if (!runtime || !isAbsolute(runtime) || realpathSync(runtime) !== runtime) throw new Error('Maintenance runtime must be canonical');
  const store = analysisProjectPaths(request, !request.previous);
  const lock = join(store.directory, 'writer.lock');
  try { closeSync(openSync(lock, 'wx', 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const identity = lstatSync(lock);
  if (realpathSync(lock) !== lock || !identity.isFile() || identity.nlink !== 1
    || identity.uid !== process.getuid() || (identity.mode & 0o077) !== 0) throw new Error('Maintenance lock must remain private and owned');
  const kernel = require(join(runtime, ANALYSIS_OUTPUT_ARTIFACTS.kernel));
  if (kernel.contractInfo?.().kernelVersion !== KERNEL_VERSION || typeof kernel.acquireMaintenanceWriter !== 'function') {
    throw new Error('Maintenance runtime has no compatible native writer lock');
  }
  if (!kernel.acquireMaintenanceWriter(lock)) return { status: 'busy', root: store.root, directory: store.directory };
  const existing = readMaintenanceStatus(store);
  let previous;
  if (existing?.databaseDev != null) {
    if (existing.state !== 'ready') throw new Error('Interrupted maintenance remains unavailable; no automatic reset or recovery is authorized');
    previous = { root: store.root, directory: store.directory, database: store.database,
      dev: existing.databaseDev, ino: existing.databaseIno };
  } else {
    // A marker without a database identity cannot adopt files created before a
    // killed initialization, nor any foreign/legacy database or sidecars.
    assertEmptyAnalysisProject(store);
  }
  if (request.previous && (!previous || Object.keys(previous).some(key => previous[key] !== request.previous[key]))) {
    throw new Error('Maintenance caller receipt does not match the stored run');
  }
  const record = { format: MAINTENANCE_REVISION, kernelVersion: KERNEL_VERSION, state: 'building', runId: randomUUID(),
    ...maintenanceStatusIdentity(store), databaseDev: previous?.dev ?? null, databaseIno: previous?.ino ?? null,
    policyDigest: request.admission.policyDigest, corpusDigest: maintenanceCorpusDigest(request.admission.files), counts: {} };
  writeMaintenanceStatus(store, record);
  try {
    // Load the donor only after this child owns the lock and graph eligibility
    // is revoked. Neither GC nor a parent release can end ownership early.
    const maintenance = require(join(runtime, MAINTENANCE_OUTPUT_ARTIFACTS.entry));
    if (maintenance.MAINTENANCE_REVISION !== MAINTENANCE_REVISION || typeof maintenance.assertSourceBoundary !== 'function') {
      throw new Error('Maintenance runtime interpretation is incompatible');
    }
    const reserve = Math.min(5_000, Math.max(250, Math.floor(request.timeoutMs / 10)));
    const remaining = () => Math.max(0, Math.floor(request.timeoutMs - reserve - (performance.now() - started)));
    let info;
    try { info = await getPiNavSemanticInfo(); } catch { /* structural maintenance does not require the semantic addon */ }
    const modelDirectory = analysisSemanticModelDirectory();
    const modelPresent = ['config.json', 'tokenizer.json', 'model.safetensors'].every(name => existsSync(join(modelDirectory, name)));
    const output = await maintenance.maintainAdmittedProject({ ...request, previous, semantics: {
      runId: record.runId, info, remaining,
      project: args => callPiNav({ root: request.root, operation: 'pi_nav_semantic_inputs', args, timeoutMs: Math.max(1, remaining()) }),
      encode: modelPresent ? async texts => {
        const result = await callPiNav({ root: request.root, operation: 'pi_nav_semantic_encode',
          args: { modelDirectory, texts }, timeoutMs: Math.max(1, remaining()) });
        return result.structured.data;
      } : undefined,
    } });
    if (output.result.success === false) throw new Error('Donor maintenance reported an unsuccessful index');
    const counts = {};
    for (const key of ['filesDiscovered', 'filesIndexed', 'filesSkipped', 'filesErrored', 'filesChecked',
      'filesAdded', 'filesModified', 'filesRemoved', 'nodesCreated', 'edgesCreated', 'nodesUpdated', 'durationMs']) {
      if (typeof output.result[key] === 'number') counts[key] = output.result[key];
    }
    maintenance.assertSourceBoundary();
    writeMaintenanceStatus(store, { ...record, state: 'ready', databaseDev: output.store.dev, databaseIno: output.store.ino, counts });
    return { status: 'finished', root: store.root, directory: store.directory, store: output.store, runId: record.runId, counts };
  } catch (error) {
    try { writeMaintenanceStatus(store, { ...record, state: 'failed' }); }
    catch (statusError) { throw new AggregateError([error, statusError], 'Maintenance failed; failure status could not be persisted'); }
    throw error;
  }
}
