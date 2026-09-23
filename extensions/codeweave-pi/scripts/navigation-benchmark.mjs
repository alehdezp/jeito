#!/usr/bin/env node
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { preflightNavigationTarget } from "../src/core/navigation-preflight.ts";
import { prepareNavigation } from "./navigation-prepare.mjs";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = ".tmp/navigation-production-benchmarks/latest.json";
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|rb|php|ex|exs)$/i;
const DOC_EXT = /\.(?:md|mdx|markdown|txt|rst)$/i;
const CONFIG_EXT = /(?:^|[/\\])(?:package|tsconfig|jsconfig|vite|webpack|rollup|eslint|prettier|biome|tailwind|app|config)[^/\\]*\.(?:json|ya?ml|toml|ini|env|js|cjs|mjs|ts)$/i;
const UNSAFE_SEGMENTS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", ".git", ".hg", ".svn", "vendor", "graphify-out", ".codanna", ".codedb-mcp", ".codescope", ".trace-mcp", ".pi"]);

const THRESHOLD_TARGETS = {
  routeCorrectRate: 1,
  setupDecisionCorrectRate: 0.95,
  queryTimeMutations: 0,
  falseLeadNoiseCount: 0,
  usefulFirstLeadRate: 0.9,
  p95PreflightMs: 2_000,
  p95PrepareDryRunMs: 5_000,
};

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { fixture: "synthetic", json: false, out: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--fixture") args.fixture = value();
    else if (flag === "--out") args.out = value();
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

export async function runNavigationBenchmark(options = {}) {
  const fixture = options.fixture ?? "synthetic";
  if (fixture !== "synthetic") throw new Error(`unsupported fixture: ${fixture}`);

  const workspace = await mkdtemp(join(tmpdir(), "pi-nav-benchmark-"));
  const bin = join(workspace, "bin");
  await mkdir(bin, { recursive: true });
  for (const tool of ["graphify", "qmd", "python3"]) await fakeTool(bin, tool);
  const env = {
    ...process.env,
    PATH: `${bin}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
  };

  const scenarios = options.scenarios ?? syntheticScenarios();
  const cases = [];
  for (const scenario of scenarios) cases.push(await runScenario(scenario, { workspace, env }));

  const metrics = summarizeCases(cases);
  const thresholds = evaluateThresholds(metrics);
  const passed = Object.values(thresholds).every(item => item.passed);
  const status = passed ? "success" : "error";
  const summary = `${passed ? "passed" : "failed"} ${cases.length} fixture cases; route ${metrics.route_correct.passed}/${metrics.route_correct.total}, setup ${metrics.setup_decision_correct.passed}/${metrics.setup_decision_correct.total}, mutations ${metrics.query_time_mutations}, useful-first-lead ${percent(metrics.useful_first_lead.rate)}.`;
  const outPath = options.out ? resolve(EXTENSION_ROOT, options.out) : undefined;

  const result = {
    status,
    summary,
    next_actions: passed
      ? ["Use this fixture baseline before production-readiness claims.", "Next smallest slice: audit log summarizer."]
      : ["Inspect failing benchmark cases in cases[].failures.", "Fix benchmarked behavior or lower only a documented, justified threshold."],
    artifacts: outPath ? [relativePath(EXTENSION_ROOT, outPath)] : ["stdout"],
    recovery: {
      safe_retry: `node scripts/navigation-benchmark.mjs --fixture synthetic --json --out ${DEFAULT_OUT}`,
      stop_conditions: ["network/provider/model download required", "query-time mutation count above 0", "benchmark thresholds fail"],
    },
    fixture,
    offline: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", providers: "not used" },
    thresholds,
    metrics,
    cases,
  };

  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  }

  return result;
}

async function runScenario(scenario, ctx) {
  const root = join(ctx.workspace, scenario.name);
  await scenario.setup(root);
  const before = await snapshotTree(root);

  const preflightStarted = performance.now();
  const preflight = await preflightNavigationTarget(root, { maxSampleFiles: 5_000 });
  const preflightMs = performance.now() - preflightStarted;

  const prepareStarted = performance.now();
  const result = await prepareNavigation([
    "--path", root,
    "--dry-run",
    "--query", scenario.query,
    "--config", join(ctx.workspace, "missing-navigation-config.json"),
    ...scenario.backends.flatMap(backend => ["--backend", backend]),
  ], { env: ctx.env });
  const prepareDryRunMs = performance.now() - prepareStarted;

  const after = await snapshotTree(root);
  const mutations = diffSnapshots(before, after);
  const leadReport = await firstReadLeads(root, preflight, result.plan, scenario.query);
  const leads = leadReport.emitted;
  const firstLead = leads[0];

  const actualBackends = result.plan.actions.map(action => action.backend);
  const actualActionPolicies = Object.fromEntries(result.plan.actions.map(action => [action.backend, action.policy]));
  const routeOk = sameArray(actualBackends, scenario.backends);
  const setupOk = result.plan.policy === scenario.expect.planPolicy
    && objectContains(actualActionPolicies, scenario.expect.actionPolicies)
    && (!scenario.expect.selectedScopes || sameArray(result.plan.scopePlan.selectedScopes, scenario.expect.selectedScopes));
  const noSafeLeadMessage = firstLead ? undefined : "No safe first-read lead found; narrow scope or add readable source/docs/config files.";
  const usefulFirstLeadOk = scenario.expect.firstRead
    ? firstLead?.path === scenario.expect.firstRead
    : scenario.expect.noSafeLead
      ? Boolean(noSafeLeadMessage)
      : undefined;
  const noisyTopCandidates = leadReport.topCandidates.filter(lead => !lead.safe);
  const failures = [];
  if (!routeOk) failures.push(`route backends ${JSON.stringify(actualBackends)} !== ${JSON.stringify(scenario.backends)}`);
  if (!setupOk) failures.push("setup policy/scope mismatch");
  if (mutations.length) failures.push(`${mutations.length} query-time mutations`);
  if (scenario.expect.firstRead && usefulFirstLeadOk === false) failures.push(`first safe lead ${firstLead?.path ?? "<none>"} !== ${scenario.expect.firstRead}`);
  if (scenario.expect.noSafeLead && firstLead) failures.push(`expected no safe lead but got ${firstLead.path}`);
  if (scenario.expect.noSafeLead && !noSafeLeadMessage) failures.push("missing no-safe-lead explanation");
  if (noisyTopCandidates.length) failures.push(`top candidates include noisy paths ${noisyTopCandidates.map(lead => lead.path).join(", ")}`);

  return {
    name: scenario.name,
    query: scenario.query,
    expected: scenario.expect,
    actual: {
      backends: actualBackends,
      planPolicy: result.plan.policy,
      actionPolicies: actualActionPolicies,
      selectedScopes: result.plan.scopePlan.selectedScopes,
      scopeMode: result.plan.scopePlan.mode,
      firstReadLeads: leads.map(lead => lead.path),
      topCandidateLeads: leadReport.topCandidates.map(({ path, safe }) => ({ path, safe })),
      noSafeLeadMessage,
    },
    route_correct: routeOk,
    setup_decision_correct: setupOk,
    query_time_mutations: mutations.length,
    lead_count: leads.length,
    raw_candidate_count: leadReport.rawCount,
    top_candidate_count: leadReport.topCandidates.length,
    safe_first_read: Boolean(firstLead),
    useful_first_lead: usefulFirstLeadOk,
    false_lead_noise_count: noisyTopCandidates.length,
    runtime_ms: { preflight: round(preflightMs), prepare_dry_run: round(prepareDryRunMs), total: round(preflightMs + prepareDryRunMs) },
    failures,
  };
}

function syntheticScenarios() {
  return [
    {
      name: "docs-lane-routes-to-qmd",
      query: "Where are the navigation routing docs?",
      backends: ["qmd"],
      async setup(root) {
        await baseRepo(root);
        await touch(join(root, "src", "router.ts"), "export function routeNavigation() { return 'docs'; }\n");
        await touch(join(root, "docs", "navigation.md"), "# Navigation routing\nStart here for routing docs.\n");
        await touch(join(root, "README.md"), "# Fixture\n");
        await touch(join(root, "node_modules", "noise", "navigation.md"), "# Noise\n");
      },
      expect: { planPolicy: "auto", actionPolicies: { qmd: "auto" }, firstRead: "docs/navigation.md" },
    },
    {
      name: "graphify-monorepo-infers-api-scope",
      query: "Trace the api router flow",
      backends: ["graphify"],
      async setup(root) {
        await monorepo(root);
        await touch(join(root, "packages", "api", "src", "router.ts"), "export function apiRouter() { return 'api'; }\n");
        await touch(join(root, "packages", "web", "src", "router.ts"), "export function webRouter() { return 'web'; }\n");
        await touch(join(root, "docs", "architecture.md"), "# Architecture\n");
      },
      expect: { planPolicy: "auto", actionPolicies: { graphify: "auto" }, selectedScopes: ["packages/api"], firstRead: "packages/api/src/router.ts" },
    },
    {
      name: "graphify-monorepo-stays-guided-when-ambiguous",
      query: "Trace the router flow",
      backends: ["graphify"],
      async setup(root) {
        await monorepo(root);
        await touch(join(root, "packages", "api", "src", "router.ts"), "export function apiRouter() {}\n");
        await touch(join(root, "packages", "web", "src", "router.ts"), "export function webRouter() {}\n");
      },
      expect: { planPolicy: "guided", actionPolicies: { graphify: "guided" }, selectedScopes: ["packages/api", "packages/web"] },
    },
    {
      name: "config-first-lead-unprepared-repo",
      query: "Where is the project config?",
      backends: ["graphify"],
      async setup(root) {
        await baseRepo(root);
        await touch(join(root, "config", "app.json"), "{\"enabled\":true}\n");
        await touch(join(root, "src", "app.ts"), "export const app = true;\n");
      },
      expect: { planPolicy: "auto", actionPolicies: { graphify: "auto" }, firstRead: "config/app.json" },
    },
    {
      name: "noisy-unprepared-repo-keeps-safe-source-lead",
      query: "understand the app entry point",
      backends: ["graphify"],
      async setup(root) {
        await baseRepo(root);
        await touch(join(root, "src", "app.ts"), "export const app = true;\n");
        await touch(join(root, "node_modules", "pkg", "app.ts"), "export const noise = true;\n");
        await touch(join(root, "dist", "cache", "app.ts"), "export const cacheNoise = true;\n");
      },
      expect: { planPolicy: "auto", actionPolicies: { graphify: "auto" }, selectedScopes: ["src"], firstRead: "src/app.ts" },
    },
    {
      name: "no-safe-first-lead-says-so",
      query: "help me understand this repo",
      backends: ["graphify"],
      async setup(root) {
        await baseRepo(root);
        await touch(join(root, "assets", "logo.png"), "not really a png\n");
      },
      expect: { planPolicy: "auto", actionPolicies: { graphify: "auto" }, selectedScopes: ["."], noSafeLead: true },
    },
    {
      name: "invalid-config-blocks-prepared-graph-setup",
      query: "Build graph navigation",
      backends: ["graphify"],
      async setup(root) {
        await baseRepo(root);
        await touch(join(root, ".pi-navigation.json"), "{ invalid json");
        await touch(join(root, "src", "main.ts"), "export const value = 1;\n");
      },
      expect: { planPolicy: "blocked", actionPolicies: { graphify: "blocked" }, selectedScopes: ["src"] },
    },
  ];
}

async function baseRepo(root) {
  await mkdir(join(root, ".git"), { recursive: true });
  await touch(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
}

async function monorepo(root) {
  await mkdir(join(root, ".git"), { recursive: true });
  await touch(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await touch(join(root, "packages", "api", "package.json"), JSON.stringify({ name: "api" }));
  await touch(join(root, "packages", "web", "package.json"), JSON.stringify({ name: "web" }));
}

async function firstReadLeads(root, preflight, plan, query) {
  const docsQuery = /\b(docs?|documentation|readme|guide|manual|how[- ]to)\b/i.test(query);
  const configQuery = /\b(config|configuration|settings?|env|package\.json|tsconfig|setup)\b/i.test(query);
  const configRoots = ["config", ".github"].filter(scope => existsSync(join(root, scope)));
  const roots = docsQuery && preflight.docs.likelyRoots.length
    ? preflight.docs.likelyRoots
    : configQuery && configRoots.length
      ? configRoots
      : plan.scopePlan.selectedScopes;
  const candidates = [];
  for (const scope of roots.length ? roots : preflight.recommendedScopes) {
    const abs = join(root, scope);
    if (!existsSync(abs)) continue;
    candidates.push(...await candidateFiles(root, abs, { docsQuery, configQuery }));
  }
  const ranked = candidates
    .map(path => ({ path, safe: isSafeLead(path), score: scoreLead(path, query, { docsQuery, configQuery }) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    rawCount: ranked.length,
    topCandidates: ranked.slice(0, 5).map(({ path, safe }) => ({ path, safe })),
    emitted: ranked.filter(lead => lead.safe).slice(0, 5).map(({ path, safe }) => ({ path, safe })),
  };
}

async function candidateFiles(root, abs, queryKind) {
  const info = await stat(abs).catch(() => undefined);
  if (!info) return [];
  if (info.isFile()) return fileMatches(abs, queryKind) ? [relativePath(root, abs)] : [];
  if (!info.isDirectory()) return [];
  const found = [];
  for (const entry of await readdir(abs, { withFileTypes: true }).catch(() => [])) {
    const child = join(abs, entry.name);
    if (entry.isDirectory()) {
      found.push(...await candidateFiles(root, child, queryKind));
    } else if (entry.isFile() && fileMatches(child, queryKind)) {
      found.push(relativePath(root, child));
    }
  }
  return found;
}

function fileMatches(path, queryKind) {
  if (queryKind.docsQuery) return DOC_EXT.test(path) || /(^|[/\\])README(\.|$)/i.test(path);
  if (queryKind.configQuery) return CONFIG_EXT.test(path);
  return SOURCE_EXT.test(path);
}

function scoreLead(path, query, queryKind) {
  const lower = path.toLowerCase();
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 3);
  let score = queryKind.docsQuery && DOC_EXT.test(path) ? 10 : queryKind.configQuery && CONFIG_EXT.test(path) ? 10 : SOURCE_EXT.test(path) ? 8 : 0;
  for (const token of tokens) if (lower.includes(token)) score += 2;
  if (/readme\.md$/i.test(path)) score -= 1;
  return score;
}

function summarizeCases(cases) {
  const useful = cases.filter(item => item.useful_first_lead !== undefined);
  const preflight = cases.map(item => item.runtime_ms.preflight);
  const prepare = cases.map(item => item.runtime_ms.prepare_dry_run);
  return {
    route_correct: rate(cases.filter(item => item.route_correct).length, cases.length),
    setup_decision_correct: rate(cases.filter(item => item.setup_decision_correct).length, cases.length),
    query_time_mutations: sum(cases.map(item => item.query_time_mutations)),
    lead_count: sum(cases.map(item => item.lead_count)),
    safe_first_read_count: cases.filter(item => item.safe_first_read).length,
    useful_first_lead: rate(useful.filter(item => item.useful_first_lead).length, useful.length),
    false_lead_noise_count: sum(cases.map(item => item.false_lead_noise_count)),
    runtime_ms: { p50: p50(cases.map(item => item.runtime_ms.total)), p95: p95(cases.map(item => item.runtime_ms.total)) },
    preflight_runtime_ms: { p50: p50(preflight), p95: p95(preflight) },
    prepare_dry_run_runtime_ms: { p50: p50(prepare), p95: p95(prepare) },
  };
}

function evaluateThresholds(metrics) {
  return {
    route_correct_rate: atLeast(metrics.route_correct.rate, THRESHOLD_TARGETS.routeCorrectRate),
    setup_policy_classification_rate: atLeast(metrics.setup_decision_correct.rate, THRESHOLD_TARGETS.setupDecisionCorrectRate),
    query_time_mutations: equals(metrics.query_time_mutations, THRESHOLD_TARGETS.queryTimeMutations),
    false_lead_noise_count: equals(metrics.false_lead_noise_count, THRESHOLD_TARGETS.falseLeadNoiseCount),
    useful_first_lead_rate: atLeast(metrics.useful_first_lead.rate, THRESHOLD_TARGETS.usefulFirstLeadRate),
    p95_preflight_ms: atMost(metrics.preflight_runtime_ms.p95, THRESHOLD_TARGETS.p95PreflightMs),
    p95_prepare_dry_run_ms: atMost(metrics.prepare_dry_run_runtime_ms.p95, THRESHOLD_TARGETS.p95PrepareDryRunMs),
  };
}

function atLeast(actual, target) { return { actual, operator: ">=", target, passed: actual >= target }; }
function atMost(actual, target) { return { actual, operator: "<=", target, passed: actual <= target }; }
function equals(actual, target) { return { actual, operator: "==", target, passed: actual === target }; }
function rate(passed, total) { return { passed, total, rate: total ? round(passed / total, 4) : 1 }; }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function p50(values) { return percentile(values, 0.5); }
function p95(values) { return percentile(values, 0.95); }
function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}
function percent(value) { return `${Math.round(value * 100)}%`; }
function round(value, places = 2) { return Number(value.toFixed(places)); }

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
  for (const [path, hash] of after) if (before.get(path) !== hash) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  return [...new Set(changed)].sort();
}

async function fakeTool(bin, name) {
  const file = join(bin, name);
  await writeFile(file, "#!/usr/bin/env sh\nexit 0\n");
  await chmod(file, 0o755);
}

async function touch(path, content = "x") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function isSafeLead(path) {
  return path.split(/[\\/]/).every(part => !UNSAFE_SEGMENTS.has(part));
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function objectContains(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function relativePath(root, path) {
  return relative(root, path).replace(/\\/g, "/") || ".";
}

function helpText() {
  return `Usage: node scripts/navigation-benchmark.mjs [--fixture synthetic] [--json] [--out PATH]\n\nRuns the offline production-navigation fixture benchmark. The harness creates local fixtures, uses fake tools, blocks provider/model downloads via offline env flags, and fails when thresholds fail.`;
}

function renderText(result) {
  const lines = [`Navigation benchmark: ${result.status}`, result.summary, "Thresholds:"];
  for (const [name, item] of Object.entries(result.thresholds)) lines.push(`- ${name}: ${item.actual} ${item.operator} ${item.target} ${item.passed ? "PASS" : "FAIL"}`);
  lines.push(`Artifacts: ${result.artifacts.join(", ")}`);
  lines.push(`Next: ${result.next_actions.join("; ")}`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (args.help) {
    console.log(helpText());
  } else {
    runNavigationBenchmark({ fixture: args.fixture, out: args.out }).then(result => {
      console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
      if (result.status !== "success") process.exitCode = 2;
    }).catch(error => {
      console.error(`ERROR: ${error?.message ?? error}`);
      process.exitCode = 1;
    });
  }
}
