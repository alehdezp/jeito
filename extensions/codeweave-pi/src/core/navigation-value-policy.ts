// Shared value-selection defaults for aggressive local navigation setup.
// Aggressive means indexing useful first-party signal, not dependency/cache/archive noise.

export const VALUE_EXCLUDE_DIR_NAMES = [
  // Package managers, build outputs, generated assets.
  "node_modules",
  "npm",
  ".pnpm-store",
  ".yarn",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  // VCS, virtualenvs, language/tool caches.
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "env",
  "vendor",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".tmp",
  // Hidden/local agent and project state. Hidden folders are excluded from code graphs by default;
  // explicitly allowlist a hidden first-party source folder in project setup before indexing it.
  ".pi",
  ".agents",
  ".agent",
  ".claude",
  ".codex",
  ".research",
  ".rtfm",
  ".gsd",
  // Logs, archives, historical snapshots, and runtime/session state.
  "logs",
  "log",
  "archive",
  "archives",
  ".archive",
  "old",
  "sessions",
  // Navigation/index/model/cache outputs — prefer setup-owned .pi/navigation/ artifacts.
  ".navi",
  "graphify-out",
  ".codanna",
  ".code-review-graph",
  ".codescope",
  ".codedb-mcp",
  ".codesearch.db",
  ".trace-mcp",
  ".semble",
  ".fastembed_cache",
];

export const VALUE_EXCLUDE_PATHS = [
  ".yarn/cache",
  "navigation/indexes",
  ".pi/navigation",
  ".pi/crg",
  "agent/sessions",
  "agent/state",
  "agent/vstack",
  "agent/remote",
  "agent/local-packages",
  "agent/intercom",
  "agent/extensions/archive",
  "agent/extensions/atlas-memory-gate",
  ".pi/goal-monitor",
  ".gsd/activity",
  ".gsd/journal",
];

export const VALUE_EXCLUDE_FILE_PATHS = [
  ".pi/navigation-setup.log.jsonl",
  ".pi/navigation-audit.jsonl",
  ".pi/session.log",
];

export const VALUE_INCLUDE_DESCRIPTION = "source, tests, first-party docs, runbooks, architecture notes, ADRs, scripts, schemas, config templates, examples, and package/workspace manifests";
