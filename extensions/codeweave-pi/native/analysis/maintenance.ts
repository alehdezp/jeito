import { CodeGraph, type IndexProgress } from './src/index';
import { installAdmittedSource, assertSourceBoundary, readFileSync, statSync } from './capture';
import { bindMaintenanceStore, maintenanceStoreIdentity, type MaintenanceStoreIdentity } from './storage';
import type { AnalysisAdmission } from '../../src/core/analysis-source.ts';
import { join } from 'node:path';
import { completeIndexedSemantics } from '../../src/core/analysis-semantics.mjs';

// The builder verifies the same sealed loader used by this maintenance bundle.
export { getKernel } from './src/extraction/kernel/loader';
export { MAINTENANCE_REVISION } from './identity.mjs';
export { assertSourceBoundary } from './capture';

/** Separate entry for one isolated, single-owner maintenance child. No watcher,
 * production readiness, query access, existing-store adoption or G1 publication.
 * A fresh child consumes the prior caller-retained store identity to reopen.
 */
export async function maintainAdmittedProject(options: {
  root: string;
  directory: string;
  admission: AnalysisAdmission;
  previous?: MaintenanceStoreIdentity;
  semantics?: {
    runId: string;
    info?: { recipe: string; dimensions: 256 };
    project: (args: unknown) => Promise<unknown>;
    encode?: (texts: string[]) => Promise<unknown>;
    remaining: () => number;
  };
  // Internal observers receive the actual owner, not a second resolver/module
  // instance. This is not a tool argument or a production readiness interface.
  onProgress?: (progress: IndexProgress, graph: CodeGraph) => void;
}) {
  if (options.admission.root !== options.root) throw new Error('Maintenance admission root mismatch');
  installAdmittedSource(options.admission);
  assertSourceBoundary();
  bindMaintenanceStore(options, options.previous);
  const oldUmask = process.umask(0o077);
  const oldParallel = process.env.CODEGRAPH_NO_PARALLEL_RESOLVE;
  process.env.CODEGRAPH_NO_PARALLEL_RESOLVE = '1';
  let graph: CodeGraph | undefined;
  try {
    graph = options.previous
      ? await CodeGraph.open(options.root, { sync: false })
      : await CodeGraph.init(options.root, { index: false });
    const onProgress = (progress: IndexProgress) => options.onProgress?.(progress, graph!);
    const result = options.previous
      ? await graph.sync({ onProgress })
      : await graph.indexAll({ onProgress });
    if ('success' in result && result.success === false) throw new Error('Donor maintenance reported an unsuccessful index');
    if (options.semantics) {
      const before = maintenanceStoreIdentity(options.root);
      await completeIndexedSemantics(graph.getMaintenanceDatabase(), {
        ...options.semantics,
        readSource: (path: string) => {
          const absolute = join(options.root, path);
          if (statSync(absolute).size > 8 * 1024 * 1024) return undefined;
          return readFileSync(absolute, 'utf8');
        },
        validate: () => {
          assertSourceBoundary();
          const current = maintenanceStoreIdentity(options.root);
          if (current.dev !== before.dev || current.ino !== before.ino) throw new Error('Maintenance database identity changed during semantics');
        },
      });
    }
    assertSourceBoundary();
    graph.close();
    graph = undefined;
    const store = maintenanceStoreIdentity(options.root);
    if (options.previous && (store.dev !== options.previous.dev || store.ino !== options.previous.ino)) {
      throw new Error('Maintenance database identity changed during work');
    }
    return { result, store };
  } finally {
    try { graph?.close(); }
    finally {
      process.umask(oldUmask);
      if (oldParallel === undefined) delete process.env.CODEGRAPH_NO_PARALLEL_RESOLVE;
      else process.env.CODEGRAPH_NO_PARALLEL_RESOLVE = oldParallel;
    }
  }
}
