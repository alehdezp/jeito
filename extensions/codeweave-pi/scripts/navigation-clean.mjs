#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

const LANES = new Set(["all", "docs", "graph", "audit", "state"]);
const CONFIG_NAME = ".pi-navigation.json";
const STATE_NAME = path.join(".pi", "navigation", "state.json");
const LEGACY_STATE_NAME = path.join(".pi", "navigation-state.json");
const AUDIT_NAME = path.join(".pi", "navigation-setup.log.jsonl");

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { path: process.cwd(), lane: "all", dryRun: false, apply: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--path" || flag === "-C") args.path = value();
    else if (flag === "--lane") args.lane = value();
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!LANES.has(args.lane)) throw new Error(`unknown lane ${JSON.stringify(args.lane)}; allowed: ${[...LANES].join(", ")}`);
  if (!args.apply) args.dryRun = true;
  if (args.apply && args.dryRun) throw new Error("choose either --dry-run or --apply, not both");
  return args;
}

export async function cleanNavigation(argv = process.argv.slice(2), options = {}) {
  const args = Array.isArray(argv) ? parseArgs(argv) : argv;
  if (args.help) return { help: true, text: helpText() };
  const root = path.resolve(args.path ?? process.cwd());
  const lane = args.lane ?? "all";
  if (!LANES.has(lane)) throw new Error(`unknown lane ${JSON.stringify(lane)}; allowed: ${[...LANES].join(", ")}`);
  const mode = args.apply ? "apply" : "dry-run";
  const candidates = await ownedArtifacts(root, lane);
  const existing = [];
  const missing = [];
  for (const item of candidates) (existsSync(item.path) ? existing : missing).push(item);
  const removed = [];
  const errors = [];

  if (args.apply) {
    for (const item of existing) {
      try {
        await rm(item.path, { recursive: item.kind === "dir", force: true });
        removed.push(item);
      } catch (error) {
        errors.push({ path: display(root, item.path), message: String(error?.message ?? error) });
      }
    }
  }

  const status = errors.length ? "error" : existing.length ? "success" : "warning";
  const summary = mode === "dry-run"
    ? `${existing.length} owned artifact${existing.length === 1 ? "" : "s"} would be removed for lane ${lane}; ${missing.length} expected artifact${missing.length === 1 ? "" : "s"} absent.`
    : `removed ${removed.length}/${existing.length} owned artifact${existing.length === 1 ? "" : "s"} for lane ${lane}.`;
  return {
    status,
    summary,
    next_actions: nextActions({ mode, lane, existing, errors }),
    artifacts: existing.map(item => display(root, item.path)),
    recovery: {
      safe_retry: `npm run nav:clean -- --path ${JSON.stringify(root)} --lane ${lane} --dry-run --json`,
      stop_conditions: ["artifact is not recorded in config/state/audit", "path resolves outside target root", "global/shared cache deletion is requested", "dry-run output includes an unexpected path"],
    },
    mode,
    root,
    lane,
    removed: removed.map(item => describe(root, item)),
    planned: existing.map(item => describe(root, item)),
    absent: missing.map(item => describe(root, item)),
    errors,
  };
}

async function ownedArtifacts(root, lane) {
  const config = await readJson(path.join(root, CONFIG_NAME));
  const state = await readJson(navigationStatePath(root));
  const audit = await readAudit(root);
  const items = [];
  const add = (item) => {
    if (!item || !inside(root, item.path)) return;
    const key = `${item.kind}:${item.path}`;
    if (!items.some(existing => `${existing.kind}:${existing.path}` === key)) items.push(item);
  };

  if (lane === "all" || lane === "state") {
    add(file(root, STATE_NAME, "navigation state is harness-owned"));
    if (existsSync(path.join(root, LEGACY_STATE_NAME))) add(file(root, LEGACY_STATE_NAME, "legacy navigation state is obsolete and harness-owned"));
  }
  if (lane === "all" || lane === "audit") add(file(root, AUDIT_NAME, "navigation setup audit log is harness-owned"));
  if (lane === "all" || lane === "docs") add(dir(root, path.join(".pi", "navigation", "qmd"), "QMD docs index directory is harness-owned"));
  if (lane === "all" || lane === "graph") {
    for (const source of [config?.graph?.graphPath, state?.indexes?.graph?.graphPath, ...auditGraphWrites(audit)]) {
      const graphDir = graphifyDir(root, source);
      if (graphDir) add({ lane: "graph", kind: "dir", path: graphDir, reason: `Graphify output recorded by config/state/audit: ${source}` });
    }
  }
  return items.sort((a, b) => display(root, a.path).localeCompare(display(root, b.path)));
}

function file(root, rel, reason) {
  return { lane: laneFor(rel), kind: "file", path: path.join(root, rel), reason };
}

function dir(root, rel, reason) {
  return { lane: laneFor(rel), kind: "dir", path: path.join(root, rel), reason };
}

function laneFor(rel) {
  if (rel.includes("/qmd") || rel.endsWith("qmd")) return "docs";
  if (rel.includes("graphify")) return "graph";
  if (rel.includes("setup.log")) return "audit";
  return "state";
}

function graphifyDir(root, value) {
  if (typeof value !== "string" || !value.includes("graphify-out")) return undefined;
  const parts = value.split(/[\\/]/);
  const index = parts.lastIndexOf("graphify-out");
  if (index < 0) return undefined;
  return safeJoin(root, parts.slice(0, index + 1).join(path.sep));
}

function auditGraphWrites(records) {
  const writes = [];
  for (const record of records) {
    if (record?.backend !== "graphify" && record?.lane !== "graph") continue;
    for (const item of Array.isArray(record.writes) ? record.writes : []) if (typeof item === "string" && item.includes("graphify-out")) writes.push(item);
    for (const item of Array.isArray(record.command) ? record.command : []) if (typeof item === "string" && item.includes("graphify-out")) writes.push(item);
  }
  return writes;
}

async function readAudit(root) {
  const text = await readFile(path.join(root, AUDIT_NAME), "utf8").catch(() => "");
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return undefined; }
}

function navigationStatePath(root) {
  return path.join(root, STATE_NAME);
}

function safeJoin(root, rel) {
  const resolved = path.resolve(root, rel);
  return inside(root, resolved) ? resolved : undefined;
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function display(root, target) {
  return path.relative(root, target).replace(/\\/g, "/") || ".";
}

function describe(root, item) {
  return { lane: item.lane, kind: item.kind, path: display(root, item.path), reason: item.reason };
}

function nextActions({ mode, lane, existing, errors }) {
  if (errors.length) return ["Inspect errors, fix permissions/path ownership, then rerun dry-run before apply."];
  if (mode === "dry-run" && existing.length) return [`Review planned paths, then rerun with --lane ${lane} --apply only if every path is expected.`];
  if (mode === "dry-run") return ["Nothing to remove; choose another lane or inspect .pi-navigation.json/.pi/navigation/state.json/audit records."];
  return ["Run nav:doctor or nav:prepare --dry-run to verify lanes are disabled/missing before relying on prepared intelligence."];
}

function helpText() {
  return `Usage: node scripts/navigation-clean.mjs [--path DIR] [--lane all|docs|graph|audit|state] [--dry-run|--apply] [--json]\n\nRemoves only project-local navigation artifacts owned by this harness. Dry-run is the default. Shared/global caches, Core stores and retired code stores are never removed.`;
}

function renderText(result) {
  if (result.help) return result.text;
  const lines = [`Navigation clean ${result.mode}: ${result.status}`, result.summary];
  for (const item of result.planned) lines.push(`- ${item.kind} ${item.path} (${item.reason})`);
  if (result.errors.length) for (const error of result.errors) lines.push(`ERROR ${error.path}: ${error.message}`);
  lines.push(`Next: ${result.next_actions.join("; ")}`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (args.help) console.log(helpText());
  else cleanNavigation(args).then(result => {
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
    if (result.status === "error") process.exitCode = 2;
  }).catch(error => {
    console.error(`ERROR: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
