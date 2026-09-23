// Bump when producer interpretation changes; source capture hashes do not identify semantics.
export const ANALYSIS_REVISION = "codeweave-pi.analysis.5";
export const KERNEL_VERSION = "0.1.0-codeweave-pi.5";
// Indexed-run status is distinct from retained G1 capture interpretation.
export const MAINTENANCE_REVISION = "codeweave-pi.maintenance.1";
export const MAINTENANCE_STATUS_FILE = "maintenance-status.json";
export const INDEXED_SEMANTIC_KEY = "codeweave-pi.indexed-semantic.1";
// Package-owned candidate assets; never a repository setting or search path.
export const SEMANTIC_MODEL_DIRECTORY = "semantic-model";

// The build owner and candidate assembly share this private artifact declaration.
export const ANALYSIS_OUTPUT_ARTIFACTS = {
  core: "core.cjs",
  kernel: "codegraph-kernel.node",
  schema: "schema.sql",
  notices: "THIRD-PARTY-NOTICES",
};

// Optional developer maintenance build, sharing the core's adjacent kernel.
// Its donor schema must never replace the G1 schema above.
export const MAINTENANCE_OUTPUT_ARTIFACTS = {
  entry: "maintenance.cjs",
  parseWorker: "parse-worker.js",
  storeWorker: "store-worker.js",
  schema: "maintenance-schema.sql",
  package: "package.json",
};
