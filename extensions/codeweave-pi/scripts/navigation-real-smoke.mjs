#!/usr/bin/env node
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { inspectNavigation } from "./navigation-doctor.mjs";
import { prepareNavigation } from "./navigation-prepare.mjs";
import { summarizeNavigationAudit } from "./navigation-audit.mjs";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = ".tmp/navigation-real-backend-matrix/latest.json";
const BACKENDS = ["qmd", "graphify"];
const LOCAL_RUNNERS = {
  qmd: { fixture: "docs-only", expected: [".pi/navigation/state.json", ".pi-navigation.json"] },
  graphify: { fixture: "tiny-code", expected: [".graphifyignore", ".pi/navigation/graphify/graphify-out/graph.json", ".pi/navigation/state.json", ".pi-navigation.json"] },
};
const UNSAFE_SEGMENTS = new Set(["node_modules", "vendor", "dist", "build", "target", "coverage", ".codanna", ".codedb-mcp", ".codescope", ".trace-mcp", "graphify-out", ".pi"]);

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { fixture: "synthetic", json: false, out: undefined, runLocal: false, toolDir: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--fixture") args.fixture = value();
    else if (flag === "--out") args.out = value();
    else if (flag === "--tool-dir") args.toolDir = value();
    else if (flag === "--run-local") args.runLocal = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

export async function runRealBackendMatrix(options = {}) {
  const fixture = options.fixture ?? "synthetic";
  if (fixture !== "synthetic") throw new Error(`unsupported fixture: ${fixture}`);

  const workspace = await mkdtemp(join(tmpdir(), "pi-nav-real-matrix-"));
  const fixtures = await createFixtures(workspace);
  const env = await offlineEnv(options, workspace);
  const installed = detectInstalled(fixtures[0].root, env);
  const repos = [];

  for (const item of fixtures) repos.push(await dryRunRepo(item, env));

  const backendRows = [];
  for (const backend of BACKENDS) backendRows.push(await backendRow(backend, { fixtures, installed, env, runLocal: Boolean(options.runLocal) }));

  const failures = [
    ...repos.flatMap(repo => repo.failures.map(failure => `${repo.name}: ${failure}`)),
    ...backendRows.flatMap(row => row.failures.map(failure => `${row.backend}: ${failure}`)),
  ];
  const skippedLocal = backendRows.filter(row => row.local_smoke.status === "skipped").length;
  const status = failures.length ? "error" : skippedLocal ? "warning" : "success";
  const summary = `${repos.length} validation repos dry-ran with ${sum(repos.map(repo => repo.dry_run_mutations))} dry-run mutations; ${backendRows.filter(row => row.installed).length}/${backendRows.length} backends detected; ${backendRows.filter(row => row.local_smoke.status === "passed").length} local smokes passed, ${skippedLocal} skipped.`;
  const outPath = options.out ? resolve(EXTENSION_ROOT, options.out) : undefined;
  const result = {
    status,
    summary,
    next_actions: nextActions({ failures, skippedLocal, runLocal: Boolean(options.runLocal) }),
    artifacts: outPath ? [relativePath(EXTENSION_ROOT, outPath)] : ["stdout"],
    recovery: {
      safe_retry: `node scripts/navigation-real-smoke.mjs --fixture synthetic --json --out ${DEFAULT_OUT}`,
      stop_conditions: ["network/cloud/model download would be required", "dry-run mutation detected", "audit contains unredacted secret findings", "local backend smoke fails"],
    },
    offline: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", providers: "not used", network_installs: "not allowed" },
    run_local: Boolean(options.runLocal),
    fixtures: repos,
    backends: backendRows,
    failures,
  };

  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

async function dryRunRepo(item, env) {
  const before = await snapshotTree(item.root);
  const prepare = await prepareNavigation(["--path", item.root, "--dry-run", "--query", item.query, ...BACKENDS.flatMap(backend => ["--backend", backend])], { env });
  const after = await snapshotTree(item.root);
  const mutations = diffSnapshots(before, after);
  const unsafeScopes = prepare.plan.scopePlan.selectedScopes.filter(scope => !safeScope(scope));
  const failures = [];
  if (mutations.length) failures.push(`dry-run mutated ${mutations.join(", ")}`);
  if (unsafeScopes.length) failures.push(`unsafe selected scope ${unsafeScopes.join(", ")}`);
  return {
    name: item.name,
    kind: item.kind,
    query: item.query,
    policy: prepare.plan.policy,
    selected_scopes: prepare.plan.scopePlan.selectedScopes,
    dry_run_mutations: mutations.length,
    unsafe_scopes: unsafeScopes,
    failures,
  };
}

async function backendRow(backend, ctx) {
  const installed = Boolean(ctx.installed[backend]);
  const reasons = [];
  const failures = [];
  let local_smoke = { status: "skipped", reason: "not requested; pass --run-local to execute allowed local/offline backend smokes" };

  if (!installed) reasons.push("backend command not detected on PATH/current runtime");
  else if (!LOCAL_RUNNERS[backend]) reasons.push("backend is detection-only in this slice because local/offline write/model behavior is not safe enough for automatic real smoke");

  if (ctx.runLocal && installed && LOCAL_RUNNERS[backend]) {
    local_smoke = await runLocalSmoke(backend, LOCAL_RUNNERS[backend], ctx.fixtures, ctx.env);
    if (local_smoke.status !== "passed") failures.push(local_smoke.reason ?? "local smoke failed");
  } else if (ctx.runLocal && !installed) {
    local_smoke = { status: "skipped", reason: "backend missing" };
  } else if (ctx.runLocal && !LOCAL_RUNNERS[backend]) {
    local_smoke = { status: "skipped", reason: reasons.at(-1) };
  }

  return { backend, installed, detection: ctx.installed.details[backend], local_smoke, policy_notes: reasons, failures };
}

async function runLocalSmoke(backend, runner, fixtures, env) {
  const fixture = fixtures.find(item => item.name === runner.fixture);
  if (!fixture) return { status: "failed", reason: `fixture ${runner.fixture} missing` };
  if (backend === "graphify") await touch(join(fixture.root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), JSON.stringify({ seeded: true }));
  const before = await snapshotTree(fixture.root);
  const result = await prepareNavigation(["--path", fixture.root, "--auto", "--trigger", "first_broad_request", "--backend", backend, "--query", fixture.query], { env });
  const audit = await summarizeNavigationAudit(["--path", fixture.root], { env });
  const missing = runner.expected.filter(file => !existsSync(join(fixture.root, file)));
  const after = await snapshotTree(fixture.root);
  const writes = diffSnapshots(before, after);
  const unsafeWrites = writes.filter(write => !expectedSmokeWrite(write));
  const failures = [];
  if (result.status !== "success") failures.push(`prepare status ${result.status}`);
  if (audit.status === "error") failures.push("audit has unredacted secret findings");
  if (missing.length) failures.push(`missing expected files ${missing.join(", ")}`);
  if (unsafeWrites.length) failures.push(`unexpected unsafe writes ${unsafeWrites.join(", ")}`);
  return {
    status: failures.length ? "failed" : "passed",
    reason: failures.join("; ") || "prepare --auto completed, audit parsed, expected files exist, and writes stayed within owned artifacts",
    fixture: fixture.name,
    audit_status: audit.status,
    expected_files: runner.expected,
    writes,
  };
}

function detectInstalled(root, env) {
  const report = inspectNavigation(root, { env });
  const tools = report.tools ?? {};
  const details = {
    qmd: tools.pi_nav,
    graphify: tools.graphify,
    pi_nav: tools.pi_nav,
  };
  return {
    qmd: Boolean(tools.pi_nav?.available),
    graphify: Boolean(tools.graphify?.available),
    details,
  };
}

async function createFixtures(workspace) {
  const fixtures = [
    { name: "tiny-code", kind: "tiny code", query: "understand read subsystem", setup: tinyCode },
    { name: "docs-only", kind: "docs-only", query: "read setup documentation", setup: docsOnly },
    { name: "source-only", kind: "source-only", query: "trace source entrypoint", setup: sourceOnly },
    { name: "monorepo", kind: "monorepo", query: "trace api router", setup: monorepo },
    { name: "noisy-generated", kind: "noisy generated repo", query: "understand app code", setup: noisyGenerated },
  ];
  for (const item of fixtures) {
    item.root = join(workspace, item.name);
    await item.setup(item.root);
  }
  return fixtures;
}

async function tinyCode(root) {
  await baseRepo(root);
  await touch(join(root, "src", "read.ts"), "export function readSubsystem() { return 'ok'; }\n");
  await touch(join(root, "README.md"), "# Tiny code\n");
}

async function docsOnly(root) {
  await mkdir(join(root, ".git"), { recursive: true });
  await touch(join(root, "README.md"), "# Docs only\nsetup documentation\n");
  await touch(join(root, "docs", "setup.md"), "# Setup\nread setup documentation\n");
}

async function sourceOnly(root) {
  await baseRepo(root);
  await touch(join(root, "src", "main.ts"), "export const main = 1;\n");
}

async function monorepo(root) {
  await mkdir(join(root, ".git"), { recursive: true });
  await touch(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await touch(join(root, "packages", "api", "package.json"), JSON.stringify({ name: "api" }));
  await touch(join(root, "packages", "api", "src", "router.ts"), "export const router = 'api';\n");
  await touch(join(root, "packages", "web", "package.json"), JSON.stringify({ name: "web" }));
  await touch(join(root, "packages", "web", "src", "router.ts"), "export const router = 'web';\n");
  await touch(join(root, "docs", "architecture.md"), "# Architecture\n");
}

async function noisyGenerated(root) {
  await baseRepo(root);
  await touch(join(root, "src", "app.ts"), "export const app = true;\n");
  await touch(join(root, "docs", "app.md"), "# App\n");
  for (let i = 0; i < 30; i++) await touch(join(root, "node_modules", `pkg${i}`, "index.ts"), "export const noise = true;\n");
}

async function baseRepo(root) {
  await mkdir(join(root, ".git"), { recursive: true });
  await touch(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
}

async function offlineEnv(options, workspace) {
  const base = options.env ?? process.env;
  const env = { ...base, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PI_NAV_REAL_SMOKE: "1" };
  if (options.toolDir) env.PATH = [resolve(options.toolDir), base.PATH, dirname(process.execPath)].filter(Boolean).join(delimiter);
  if (options.runLocal && !env.PI_NAV_AUTOMATION_CONFIG) {
    const configPath = join(workspace, "local-offline-navigation-config.json");
    await writeFile(configPath, `${JSON.stringify({ providers: { allowLLM: false, allowCloud: false }, backends: { graph: { mode: "update", deepMode: "disabled" }, docs: { mode: "lexicalDocs", embeddings: false, aiSummaries: false } } }, null, 2)}\n`);
    env.PI_NAV_AUTOMATION_CONFIG = configPath;
  }
  return env;
}

async function snapshotTree(root) {
  const output = new Map();
  async function visit(abs) {
    for (const entry of await readdir(abs, { withFileTypes: true }).catch(() => [])) {
      const child = join(abs, entry.name);
      const rel = relativePath(root, child);
      if (entry.isDirectory()) {
        output.set(`${rel}/`, "dir");
        await visit(child);
      } else if (entry.isFile()) {
        output.set(rel, createHash("sha256").update(await readFile(child)).digest("hex"));
      }
    }
  }
  await visit(root);
  return output;
}

function diffSnapshots(before, after) {
  const changed = [];
  for (const [file, hash] of after) if (before.get(file) !== hash) changed.push(file);
  for (const file of before.keys()) if (!after.has(file)) changed.push(file);
  return [...new Set(changed)].sort();
}

async function touch(file, content = "x") {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

function safeScope(scope) {
  return String(scope).split(/[\\/]/).every(part => !UNSAFE_SEGMENTS.has(part));
}

function expectedSmokeWrite(file) {
  return file === ".pi-navigation.json" || file === ".graphifyignore" || file.startsWith(".pi/");
}

function relativePath(root, file) {
  return relative(root, file).replace(/\\/g, "/") || ".";
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function nextActions({ failures, skippedLocal, runLocal }) {
  if (failures.length) return ["Inspect failures[] and rerun after fixing backend install/config/scope issues."];
  if (!runLocal) return ["Review installed backend detection, then rerun with --run-local only where local/offline backend writes are allowed."];
  if (skippedLocal) return ["Install or explicitly defer missing/non-local backends; only promote lanes with passed local smokes."];
  return ["Matrix smokes passed for allowed local backends; keep provider/model/network-backed modes blocked until separately approved."];
}

function helpText() {
  return `Usage: node scripts/navigation-real-smoke.mjs [--fixture synthetic] [--run-local] [--tool-dir DIR] [--json] [--out PATH]\n\nBuilds representative local fixtures, verifies nav:prepare dry-run non-mutation, detects real backend availability, and optionally runs allowed local/offline backend smokes. It never installs packages, calls cloud providers, or downloads models.`;
}

function renderText(result) {
  const lines = [`Navigation real-backend matrix: ${result.status}`, result.summary, `Artifacts: ${result.artifacts.join(", ")}`];
  for (const row of result.backends) lines.push(`- ${row.backend}: ${row.installed ? "installed" : "missing"}; local ${row.local_smoke.status}`);
  lines.push(`Next: ${result.next_actions.join("; ")}`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (args.help) console.log(helpText());
  else runRealBackendMatrix(args).then(result => {
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
    if (result.status === "error") process.exitCode = 2;
  }).catch(error => {
    console.error(`ERROR: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
