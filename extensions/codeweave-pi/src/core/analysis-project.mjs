import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ANALYSIS_REVISION, KERNEL_VERSION, MAINTENANCE_REVISION, MAINTENANCE_STATUS_FILE } from '../../native/analysis/identity.mjs';

const metadataKey = 'codeweave-pi.g1';
const maintenance = reason => new Error(`Analysis project unavailable: ${reason}. Explicit maintenance is required: inspect the existing store or select a new private directory; no automatic reset or migration is performed.`);

function statIfPresent(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function canonical(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw maintenance('paths must be absolute and canonical, without aliases');
  }
}

function privateOwned(stat) {
  return typeof process.getuid === 'function' && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}

/** Derive one machine-local namespace without creating directories or adopting a store.
 * The caller supplies the existing host storage.indexRoot, never a project DB path. */
export function deriveAnalysisProject(root, indexRoot) {
  canonical(root);
  if (typeof indexRoot !== 'string' || !isAbsolute(indexRoot) || indexRoot.includes('\0') || resolve(indexRoot) !== indexRoot) {
    throw maintenance('machine index root must be an absolute normalized path');
  }
  const key = createHash('sha256').update(root).digest('hex');
  return { root, directory: join(indexRoot, 'codegraph', key), kind: 'indexed' };
}

/** Allocate missing machine parents only; never chmod or adopt existing state.
 * The graph directory itself is still created by the lock-owning child. */
export function ensureAnalysisProjectParent(project) {
  canonical(project.root);
  const parent = dirname(project.directory);
  const outside = relative(project.root, parent);
  if (!isAbsolute(parent) || resolve(parent) !== parent || !(outside === '..' || outside.startsWith('../'))) {
    throw maintenance('machine parent must be normalized and outside source');
  }
  const missing = [];
  let current = parent;
  while (!statIfPresent(current)) {
    missing.unshift(current);
    current = dirname(current);
  }
  canonical(current); // Reject every symlink ancestor, not only the last segment.
  for (const path of [dirname(parent), parent]) {
    const stat = statIfPresent(path);
    if (stat) {
      canonical(path);
      if (!stat.isDirectory() || !privateOwned(stat)) throw maintenance('machine index parents must be private and owned');
    }
  }
  if (!lstatSync(current).isDirectory()) throw maintenance('machine parent is not a directory');
  for (const path of missing) {
    canonical(dirname(path));
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    canonical(path);
    if (!lstatSync(path).isDirectory() || !privateOwned(lstatSync(path))) throw maintenance('machine parent must be private and owned');
  }
  // Existing namespace parents are validated, never repaired in place.
  for (const path of [dirname(parent), parent]) {
    canonical(path);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || !privateOwned(stat)) throw maintenance('machine index parents must be private and owned');
  }
}

function paths({ directory, root }, createDirectory) {
  canonical(root);
  if (!lstatSync(root).isDirectory()) throw maintenance('source root is not a directory');
  if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) !== directory) {
    throw maintenance('store directory must be an absolute canonical path');
  }
  const outside = relative(root, directory);
  if (!(outside === '..' || outside.startsWith('../'))) throw maintenance('store directory must be outside captured source');
  if (!statIfPresent(directory)) {
    if (!createDirectory) throw Object.assign(maintenance('store directory is missing; initialize it explicitly'), { code: 'ENOENT' });
    // Do not create ancestor trees or silently follow an aliased parent.
    canonical(dirname(directory));
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  canonical(directory);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || !privateOwned(stat)) throw maintenance('store directory must be private and owned by the current user');
  return { directory, root, database: join(directory, 'graph.sqlite'), directoryIdentity: stat };
}

/** @returns {import('node:fs').Stats} The required primary-file identity, after sidecar validation. */
function validateFiles(store) {
  canonical(store.directory);
  const directory = lstatSync(store.directory);
  if (!directory.isDirectory() || !privateOwned(directory)
    || directory.dev !== store.directoryIdentity.dev || directory.ino !== store.directoryIdentity.ino) {
    throw maintenance('store directory identity or permissions changed');
  }
  let database;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = store.database + suffix;
    const stat = statIfPresent(path);
    if (!stat) {
      if (!suffix) throw Object.assign(maintenance('graph.sqlite is missing; initialize it explicitly'), { code: 'ENOENT' });
      continue;
    }
    canonical(path);
    if (!stat.isFile() || stat.nlink !== 1 || !privateOwned(stat)) {
      throw maintenance('database and SQLite sidecars must be private, owned, regular single-link files');
    }
    if (!suffix) database = stat;
  }
  return database;
}

function metadataFrom(connection, root) {
  const row = connection.prepare('SELECT value FROM project_metadata WHERE key = ? AND length(value) <= 8388608').get(metadataKey);
  const metadata = row && JSON.parse(row.value);
  if (!metadata || metadata.root !== root || !Number.isSafeInteger(metadata.generation) || metadata.generation < 0
    || metadata.interpretationRevision !== ANALYSIS_REVISION || metadata.kernelVersion !== KERNEL_VERSION) {
    throw maintenance('foreign root, invalid generation, or incompatible analysis interpretation');
  }
  // Identity alone must not admit an incomplete initialization or a metadata-only database.
  const tables = new Set(connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name));
  for (const name of ['schema_versions', 'nodes', 'edges', 'files', 'unresolved_refs', 'nodes_fts', 'name_segment_vocab']) {
    if (!tables.has(name)) throw maintenance(`incomplete analysis schema (missing ${name})`);
  }
  return metadata;
}

// Query/preparation parents use filesystem validation only. Opening a second
// SQLite implementation beside the native reader can invalidate its WAL mapping.
export { paths as analysisProjectPaths, validateFiles as validateAnalysisProjectFiles };

/** Maintenance-child/test reader, not a query-process metadata preflight.
 * No application initialization, repair, schema changes or retained connection.
 * SQLite may create its normal WAL/SHM sidecars; a missing graph stays missing.
 */
export function readAnalysisProject(options) {
  let connection;
  try {
    const store = paths(options, false);
    const before = validateFiles(store);
    connection = new Database(store.database, { readonly: true, fileMustExist: true });
    connection.exec('BEGIN');
    const metadata = metadataFrom(connection, store.root);
    const after = validateFiles(store);
    if (before.dev !== after.dev || before.ino !== after.ino) throw maintenance('database identity changed during read');
    return { database: store.database, metadata };
  } catch (error) {
    if (error.message.startsWith('Analysis project unavailable:')) throw error;
    throw maintenance(error.message);
  } finally { connection?.close(); }
}

/** Initialize only a previously absent graph.sqlite; never repurpose or migrate an existing file. */
export function initializeAnalysisProject({ directory, root, schemaPath }) {
  let connection;
  try {
    const store = paths({ directory, root }, true);
    if (statIfPresent(store.database)) return readAnalysisProject({ directory, root });
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (statIfPresent(store.database + suffix)) throw maintenance('orphaned SQLite sidecars exist');
    }
    const schema = readFileSync(schemaPath, 'utf8');
    // Exclusive creation reserves only our file. A failed/crashed initialization
    // remains invalid and requires explicit attention; never delete a competing file.
    closeSync(openSync(store.database, 'wx', 0o600));
    const before = validateFiles(store);
    connection = new Database(store.database, { fileMustExist: true });
    connection.transaction(() => {
      connection.exec(schema);
      connection.prepare('INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)').run(metadataKey,
        JSON.stringify({ root, generation: 0, kernelVersion: KERNEL_VERSION, interpretationRevision: ANALYSIS_REVISION }), Date.now());
      metadataFrom(connection, root);
      const after = validateFiles(store);
      if (before.dev !== after.dev || before.ino !== after.ino) throw maintenance('database identity changed during initialization');
    })();
    connection.close();
    connection = undefined;
    return readAnalysisProject({ directory, root });
  } catch (error) {
    if (error.message.startsWith('Analysis project unavailable:')) throw error;
    throw maintenance(error.message);
  } finally { connection?.close(); }
}

// Maintenance records certify one completed process run, not instantaneous
// repository truth or power-loss durability of the donor's database.
const maintenanceCounts = new Set(['filesDiscovered', 'filesIndexed', 'filesSkipped', 'filesErrored', 'filesChecked',
  'filesAdded', 'filesModified', 'filesRemoved', 'nodesCreated', 'edgesCreated', 'nodesUpdated', 'durationMs']);

export function assertEmptyAnalysisProject(store) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (statIfPresent(store.database + suffix)) throw maintenance('initialization requires an absent database and sidecars; no store adoption');
  }
}

/** Set identity only: UTF-8 byte ordering and a NUL after each admitted path. */
export function maintenanceCorpusDigest(files) {
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].map(file => Buffer.from(file)).sort(Buffer.compare)) hash.update(file).update('\0');
  return hash.digest('hex');
}

export function maintenanceStatusIdentity(store) {
  const current = paths(store, false);
  if (current.directoryIdentity.dev !== store.directoryIdentity.dev || current.directoryIdentity.ino !== store.directoryIdentity.ino) {
    throw maintenance('maintenance directory identity changed');
  }
  const root = lstatSync(store.root);
  return { root: store.root, rootDev: root.dev, rootIno: root.ino,
    directoryDev: current.directoryIdentity.dev, directoryIno: current.directoryIdentity.ino };
}

function validateMaintenanceStatus(store, record) {
  if (!record || Object.keys(record).length !== 14 || record.format !== MAINTENANCE_REVISION || record.kernelVersion !== KERNEL_VERSION
    || !['building', 'failed', 'ready'].includes(record.state)
    || typeof record.runId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.runId)
    || typeof record.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.policyDigest)
    || typeof record.corpusDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.corpusDigest)
    || !record.counts || typeof record.counts !== 'object' || Array.isArray(record.counts)
    || Object.entries(record.counts).some(([key, value]) => !maintenanceCounts.has(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw maintenance('invalid or incompatible maintenance status');
  }
  for (const [key, value] of Object.entries(maintenanceStatusIdentity(store))) {
    if (record[key] !== value) throw maintenance('maintenance status belongs to another root or directory');
  }
  if (![record.rootDev, record.rootIno, record.directoryDev, record.directoryIno].every(value => Number.isSafeInteger(value) && value >= 0)
    || (record.databaseDev === null) !== (record.databaseIno === null)
    || (record.databaseDev === null ? record.state === 'ready'
      : ![record.databaseDev, record.databaseIno].every(value => Number.isSafeInteger(value) && value >= 0))) {
    throw maintenance('invalid maintenance filesystem identity');
  }
  if (record.databaseDev !== null) {
    const database = validateFiles(store);
    if (database.dev !== record.databaseDev || database.ino !== record.databaseIno) throw maintenance('maintenance database identity changed');
  }
  return record;
}

export function readMaintenanceStatus(store) {
  const path = join(store.directory, MAINTENANCE_STATUS_FILE);
  const stat = statIfPresent(path);
  if (!stat) return undefined;
  canonical(path);
  if (!stat.isFile() || stat.nlink !== 1 || !privateOwned(stat) || stat.size > 16_384) throw maintenance('unsafe maintenance status file');
  const descriptor = openSync(path, 'r');
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw maintenance('maintenance status changed while opening');
    const bytes = readFileSync(descriptor);
    if (bytes.length > 16_384) throw maintenance('maintenance status exceeds its bound');
    return validateMaintenanceStatus(store, JSON.parse(bytes.toString('utf8')));
  } finally { closeSync(descriptor); }
}

/** Only the OS-lock-owning maintenance child may publish these records. */
export function writeMaintenanceStatus(store, record) {
  validateMaintenanceStatus(store, record);
  const bytes = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(bytes) > 16_384) throw maintenance('maintenance status exceeds its bound');
  const temporary = join(store.directory, `.maintenance-status-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(temporary, join(store.directory, MAINTENANCE_STATUS_FILE));
    const directory = openSync(store.directory, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
