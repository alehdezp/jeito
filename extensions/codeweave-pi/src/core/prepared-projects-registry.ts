// Global registry of prepared navigation projects. One machine-wide table
// (~/.pi/navigation/prepared-projects.json) that every Pi startup cheaply
// rechecks and every lane-enabling lifecycle script updates. Live tools
// (ls/find/grep/read) annotate results that touch a prepared project so
// agents discover query-ready indexes with zero extra calls.
//
// The table is an observation cache, never the source of truth: annotations
// are gated on real lane admission (resolvePreparedLane), memoized per
// process and keyed on config/state mtimes, so a stale table row can never
// advertise a lane that would fail at query time.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { canonicalNavigationPath } from "./navigation-corpus-policy.ts";
import { resolvePreparedLane, type NavigationLane } from "./navigation-config.ts";
import { detectProjectRoot } from "./project-root.ts";

export type PreparedLaneFlags = Partial<Record<NavigationLane, boolean>>;
export type PreparedProjectEntry = {
  root: string;
  firstSeen: string;
  lastSeen: string;
  lastChecked: string;
  source: string;
  lanes: PreparedLaneFlags;
};
export type PreparedProjectsTable = { version: 1; updatedAt: string; projects: Record<string, PreparedProjectEntry> };

const LANES: NavigationLane[] = ["docs", "graph"];
const LANE_GLYPH: Record<NavigationLane, string> = { docs: "docs✓", graph: "graph✓" };
const LANE_TOOLS: Record<NavigationLane, string> = {
  docs: "docs_search",
  graph: "explore map, trace path/explain",
};
const ANNOTATION_PROJECT_CAP = 3;
const LANE_TOOLS_COMPACT: Record<NavigationLane, string> = { docs: "docs_search", graph: "explore map" };

// Session-scoped announcement state: a prepared project's first appearance in
// any live-tool result gets the full footer; every later appearance gets the
// compact reminder (still scope-complete, so it survives compaction).
const announcedProjects = new Set<string>();
export const __preparedProjectsInternals = { announcedProjects, resetAnnounced: (): void => announcedProjects.clear() };

export function preparedProjectsTablePath(): string {
  return join(homedir(), ".pi", "navigation", "prepared-projects.json");
}

export function readPreparedProjectsTable(tablePath = preparedProjectsTablePath()): PreparedProjectsTable {
  try {
    const parsed = JSON.parse(readFileSync(tablePath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.projects && typeof parsed.projects === "object") {
      return { version: 1, updatedAt: String(parsed.updatedAt ?? ""), projects: parsed.projects };
    }
  } catch { /* a missing or unreadable table is an empty registry */ }
  return { version: 1, updatedAt: "", projects: {} };
}

function writePreparedProjectsTable(table: PreparedProjectsTable, tablePath = preparedProjectsTablePath()): void {
  try {
    mkdirSync(dirname(tablePath), { recursive: true });
    const tmp = `${tablePath}.tmp-${process.pid}`;
    table.updatedAt = new Date().toISOString();
    writeFileSync(tmp, JSON.stringify(table, null, 1));
    renameSync(tmp, tablePath);
  } catch { /* registry writes never break a tool call */ }
}

/** Cheap lane flags from config declarations plus artifact presence (table content, not admission). */
export function artifactLaneFlags(root: string): PreparedLaneFlags {
  const flags: PreparedLaneFlags = {};
  try {
    const config = JSON.parse(readFileSync(join(root, ".pi-navigation.json"), "utf8"));
    const declared = (lane: NavigationLane): boolean => config?.[lane] === true || Boolean(config?.[lane]?.enabled);
    flags.docs = declared("docs") && existsSync(join(root, ".pi", "navigation", "qmd"));
    flags.graph = declared("graph") && existsSync(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"));
  } catch { /* no readable config means no flags */ }
  return flags;
}

/** Register or refresh one prepared project in the global table. No-op without a config. */
export function upsertPreparedProject(root: string, source: string, tablePath = preparedProjectsTablePath()): void {
  const canonical = canonicalNavigationPath(root);
  if (!existsSync(join(canonical, ".pi-navigation.json"))) return;
  const table = readPreparedProjectsTable(tablePath);
  const now = new Date().toISOString();
  const existing = table.projects[canonical];
  table.projects[canonical] = {
    root: canonical,
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
    lastChecked: now,
    source,
    lanes: artifactLaneFlags(canonical),
  };
  writePreparedProjectsTable(table, tablePath);
}

/** Startup recheck: drop vanished configs, refresh lane flags, persist once. */
export function recheckPreparedProjectsTable(tablePath = preparedProjectsTablePath()): { checked: number; removed: number } {
  const table = readPreparedProjectsTable(tablePath);
  let removed = 0;
  const now = new Date().toISOString();
  for (const [key, entry] of Object.entries(table.projects)) {
    if (!entry?.root || !existsSync(join(entry.root, ".pi-navigation.json"))) {
      delete table.projects[key];
      removed += 1;
      continue;
    }
    entry.lanes = artifactLaneFlags(entry.root);
    entry.lastChecked = now;
  }
  if (removed > 0 || Object.keys(table.projects).length > 0) writePreparedProjectsTable(table, tablePath);
  return { checked: Object.keys(table.projects).length, removed };
}

// Honest readiness: real lane admission, memoized per process by config/state mtime.
const admissionMemo = new Map<string, { key: string; lanes: PreparedLaneFlags }>();

export async function admittedLaneReadiness(root: string): Promise<PreparedLaneFlags> {
  let key = "missing";
  try {
    const configMtime = statSync(join(root, ".pi-navigation.json")).mtimeMs;
    let stateMtime = 0;
    try { stateMtime = statSync(join(root, ".pi", "navigation", "state.json")).mtimeMs; } catch { /* state is optional for the key */ }
    key = `${configMtime}:${stateMtime}`;
  } catch { /* missing config keeps the "missing" key */ }
  const memo = admissionMemo.get(root);
  if (memo && memo.key === key) return memo.lanes;
  const lanes: PreparedLaneFlags = {};
  for (const lane of LANES) {
    try { lanes[lane] = (await resolvePreparedLane(root, lane)).ok; } catch { lanes[lane] = false; }
  }
  admissionMemo.set(root, { key, lanes });
  return lanes;
}

/** Nearest folder on the walk-up that carries its own .pi-navigation.json (never inherited). */
export function owningPreparedRoot(absPath: string): string | undefined {
  let dir = absPath;
  try { if (statSync(dir).isFile()) dir = dirname(dir); } catch { /* nonexistent paths walk up as given */ }
  for (;;) {
    if (existsSync(join(dir, ".pi-navigation.json"))) return canonicalNavigationPath(dir);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The exact scope literal to query with: cwd-relative when possible, otherwise absolute. */
export function scopeLiteral(projectRoot: string, cwd: string): string {
  const rel = relative(cwd, projectRoot);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split("\\").join("/");
  return projectRoot;
}

/**
 * Neutral footer naming every query-ready prepared project touched by the
 * given paths, excluding the session's own project. First appearance of a
 * project in this session renders the full form; repeats render one compact
 * line. Empty string when nothing ready is touched — silence is the default.
 */
export async function preparedProjectsAnnotation(paths: string[], cwd: string, label: string, tablePath?: string): Promise<string> {
  if (!paths.length) return "";
  const sessionRoot = detectProjectRoot(cwd).root;
  const canonicalSession = sessionRoot ? canonicalNavigationPath(sessionRoot) : undefined;
  const roots = [...new Set(
    paths
      .map(path => owningPreparedRoot(isAbsolute(path) ? path : resolve(cwd, path)))
      .filter((root): root is string => Boolean(root) && root !== canonicalSession),
  )];
  const fullLines: string[] = [];
  const compactLines: string[] = [];
  const overflowNames: string[] = [];
  for (const root of roots) {
    try { upsertPreparedProject(root, `observation:${label}`, tablePath); } catch { /* observation never breaks the result */ }
    if (fullLines.length + compactLines.length >= ANNOTATION_PROJECT_CAP) {
      overflowNames.push(scopeLiteral(root, cwd)); // ponytail: scopes are free — name overflow projects instead of hiding them
      continue;
    }
    const lanes = await admittedLaneReadiness(root);
    const ready = LANES.filter(lane => lanes[lane]);
    if (!ready.length) continue;
    const scope = scopeLiteral(root, cwd);
    if (announcedProjects.has(root)) {
      compactLines.push(`queryable project (${ready.map(lane => LANE_TOOLS_COMPACT[lane]).join(", ")}) — scope:${JSON.stringify(scope)}`);
    } else {
      fullLines.push(`- ${scope} — ${ready.map(lane => LANE_GLYPH[lane]).join(" ")} — ${ready.map(lane => LANE_TOOLS[lane]).join("; ")} — query with scope:${JSON.stringify(scope)}`);
    }
    announcedProjects.add(root); // ponytail: mark only rendered roots, so a not-yet-ready project keeps its first-encounter slot
  }
  if (!fullLines.length && !compactLines.length) return "";
  const parts: string[] = [];
  if (fullLines.length) {
    const overflow = overflowNames.length ? `\n- …and ${overflowNames.length} more: ${overflowNames.map(name => `scope:${JSON.stringify(name)}`).join(", ")}` : "";
    parts.push(`Other queryable project(s) in this ${label} — navigation available:\n${fullLines.join("\n")}${overflow}\nLegend: code✓=code graph · docs✓=docs search · graph✓=graph map; each line names its exact query scope.`);
  }
  if (compactLines.length) parts.push(`Navigation: ${compactLines.join(" · ")}`);
  return `\n\n${parts.join("\n")}`;
}

/** Annotation for direct directory children that are themselves prepared roots (ls). */
export async function preparedProjectsInListing(dir: string, cwd: string, tablePath?: string): Promise<string> {
  let children: string[] = [];
  try {
    children = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(dir, entry.name))
      .filter(child => existsSync(join(child, ".pi-navigation.json")));
  } catch { return ""; }
  return preparedProjectsAnnotation(children, cwd, "listing", tablePath);
}
