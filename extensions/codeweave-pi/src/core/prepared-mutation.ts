import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";

import { graphLaneMaintenanceProblems } from "./navigation-config.ts";
import { canonicalProjectPath, detectProjectRoot } from "./project-root.ts";

// Process-local candidate choice only. Keeping the selection after stop prevents
// a queued shutdown/refresh callback from resuming prepared work.
const indexedRoots = new Set<string>();

/** Code maintenance owner for this process: the package-owned indexed Core, or
 * nothing. Retired CRG stores and bindings are neither evidence of ownership nor
 * a reason to refuse one; they are never read, adopted, migrated or deleted. */
export function codeMaintenanceOwner(root: string): "unowned" | "indexed" {
  return indexedRoots.has(canonicalProjectPath(root)) ? "indexed" : "unowned";
}

/** Strict first-read boundary for the candidate's two project metadata files.
 * Missing is allowed; malformed, aliased or oversized is never missing. Existing
 * readJson consumers deliberately retain their permissive behavior below. */
export function readCandidateMetadata(root: string, name: ".pi-navigation.json" | ".pi/navigation/state.json"): any {
  const refused = () => new Error("Candidate metadata is invalid, aliased, oversized or changed; automatic selection refused");
  if (realpathSync(root) !== root || ![".pi-navigation.json", ".pi/navigation/state.json"].includes(name)) throw refused();
  const limit = 1_048_576;
  const parts = name.split("/");
  let path = root;
  let selected: Stats | undefined;
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]);
    try { selected = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw refused();
    }
    if (selected.isSymbolicLink() || realpathSync(path) !== path) throw refused();
    if (index < parts.length - 1 && !selected.isDirectory()) throw refused();
  }
  const regular = (stat: Stats) => stat.isFile() && stat.nlink === 1 && stat.size <= limit;
  if (!selected || !regular(selected)) throw refused();
  const same = (stat: Stats) => regular(stat) && stat.dev === selected.dev && stat.ino === selected.ino
    && stat.size === selected.size && stat.mtimeMs === selected.mtimeMs && stat.ctimeMs === selected.ctimeMs;
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw refused(); }
  try {
    // Check the opened object and canonical path before reading even one byte.
    if (!same(fstatSync(descriptor)) || realpathSync(path) !== path || !same(lstatSync(path))) throw refused();
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit || !same(fstatSync(descriptor)) || realpathSync(path) !== path || !same(lstatSync(path))) throw refused();
    const raw = bytes.subarray(0, length);
    const text = raw.toString("utf8");
    if (!Buffer.from(text).equals(raw)) throw refused();
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw refused();
    return value;
  } catch { throw refused(); }
  finally { closeSync(descriptor); }
}

/** Inspect without reserving ownership. Invalid metadata throws; it is never
 * treated as an absent configuration. Retired CRG/CodeGraph stores are
 * deliberately not inspected: the indexed directory is independent, and reading
 * an old store would imply an ownership decision that was never taken. */
export function inspectCodeMaintenanceOwner(root: string): { owner: "unowned" | "indexed" } {
  root = realpathSync(root);
  readCandidateMetadata(root, ".pi-navigation.json");
  readCandidateMetadata(root, ".pi/navigation/state.json");
  return { owner: indexedRoots.has(root) ? "indexed" : "unowned" };
}

export function selectCandidateCodeOwner(root: string): void {
  root = realpathSync(root);
  // Validate before reserving: an unreadable binding is not a missing one.
  inspectCodeMaintenanceOwner(root);
  indexedRoots.add(root);
}

export function notifyPreparedMutation(options: { cwd: string; paths: string[]; trigger: "edit" | "write" }): string | undefined {
  const root = detectProjectRoot(options.cwd).root;
  return markGraphifyRefreshPending(root, options.paths, options.trigger);
}

function markGraphifyRefreshPending(root: string, changedPaths: string[], trigger: "edit" | "write"): string | undefined {
  const statePath = join(root, ".pi", "navigation", "state.json");
  const state = readJson(statePath);
  const graph = state?.indexes?.graph;
  if (!graph || typeof graph !== "object") return undefined;
  graph.refreshStatus = "ready";
  graph.sourceFreshnessStatus = "refresh_pending";
  graph.lastProbeStatus = "ready";
  graph.dirtySince = new Date().toISOString();
  graph.dirtyTrigger = trigger;
  graph.dirtyPaths = [...new Set(changedPaths.map(String).filter(Boolean))].slice(0, 20);
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    const temporary = `${statePath}.tmp.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, statePath);
    return undefined;
  } catch (error) {
    return `Graphify freshness could not be invalidated after ${trigger}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function dirtyPreparedBackends(root: string, now = Date.now()): string[] {
  const state = readJson(join(root, ".pi", "navigation", "state.json"));
  if (!state) return [];
  const graph = state?.indexes?.graph;
  const graphStatus = String(graph?.sourceFreshnessStatus ?? graph?.refreshStatus ?? "");
  const retryAfter = Date.parse(String(graph?.lastRefreshFailure?.retryAfter ?? ""));
  const recoveryDecision = String(graph?.lastRefreshFailure?.recoveryDecision ?? "");
  const retryEligible = recoveryDecision === "retry_next_lifecycle" && Number.isFinite(retryAfter) && retryAfter <= now;
  const retryBlocked = recoveryDecision === "retry_next_lifecycle" && (!Number.isFinite(retryAfter) || retryAfter > now);
  const terminalFailure = recoveryDecision === "fail_closed";
  const sourceOrIdentityDrift = graphLaneMaintenanceProblems(root, graph).length > 0;
  return graphStatus === "dirty" || graphStatus === "refresh_pending" || graphStatus === "refreshing" || retryEligible || (sourceOrIdentityDrift && !retryBlocked && !terminalFailure) ? ["graphify"] : [];
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return undefined; }
}
