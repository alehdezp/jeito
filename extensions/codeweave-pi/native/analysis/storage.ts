import { analysisProjectPaths, validateAnalysisProjectFiles, assertEmptyAnalysisProject } from '../../src/core/analysis-project.mjs';
import { createDatabase } from './src/db/sqlite-adapter';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion } from './src/db/migrations';

/** The isolated caller retains this receipt, not a database readiness flag. */
export interface MaintenanceStoreIdentity {
  root: string;
  directory: string;
  database: string;
  dev: number;
  ino: number;
}

type Store = ReturnType<typeof analysisProjectPaths>;
let bound: Store | undefined;

export function bindMaintenanceStore(options: { root: string; directory: string }, previous?: MaintenanceStoreIdentity): void {
  if (bound) throw new Error('One maintenance store per child');
  const store = analysisProjectPaths(options, !previous);
  if (previous) {
    if (previous.root !== store.root || previous.directory !== store.directory || previous.database !== store.database) {
      throw new Error('Maintenance store identity belongs to another root or path');
    }
    const current = validateAnalysisProjectFiles(store);
    if (current.dev !== previous.dev || current.ino !== previous.ino) throw new Error('Maintenance database identity changed');
    const { db } = createDatabase(store.database, { readOnly: true });
    try {
      if (db.prepare("SELECT value FROM project_metadata WHERE key='codeweave-pi.g1'").get()
        || getCurrentVersion(db) !== CURRENT_SCHEMA_VERSION) {
        throw new Error('Only this maintenance format may reopen; no G1 adoption or schema migration');
      }
    } finally { db.close(); }
  } else {
    assertEmptyAnalysisProject(store);
  }
  bound = store;
}

export function maintenanceStore(root: string): Store {
  if (!bound || bound.root !== root) throw new Error('Maintenance requires an explicitly bound private store for this root');
  // The shared validator checks the private directory identity before reporting
  // ENOENT for an as-yet-uncreated database during donor init.
  try { validateAnalysisProjectFiles(bound); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return bound;
}

export function maintenanceStoreIdentity(root: string): MaintenanceStoreIdentity {
  const store = maintenanceStore(root);
  const current = validateAnalysisProjectFiles(store);
  return { root: store.root, directory: store.directory, database: store.database, dev: current.dev, ino: current.ino };
}
