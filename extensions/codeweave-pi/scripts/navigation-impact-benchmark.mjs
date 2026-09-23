#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = ".tmp/navigation-impact-evidence/latest.json";
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php)$/i;
const UNSAFE_SEGMENTS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "vendor", ".git", ".pi", ".codanna", ".codedb-mcp", ".codescope", ".trace-mcp", "graphify-out"]);
const THRESHOLDS = {
  knownFixturePassRate: 0.9,
  generatedVendorCacheTopHits: 0,
  resultPathExistenceRate: 1,
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

export async function runImpactBenchmark(options = {}) {
  const fixture = options.fixture ?? "synthetic";
  if (fixture !== "synthetic") throw new Error(`unsupported fixture: ${fixture}`);

  const workspace = await mkdtemp(join(tmpdir(), "pi-nav-impact-"));
  const root = join(workspace, "repo");
  await createSyntheticRepo(root);
  const sourceFiles = await listSourceFiles(root);
  const cases = impactCases();
  const evaluated = [];
  for (const testCase of cases) evaluated.push(await evaluateCase(testCase, { root, sourceFiles }));
  const metrics = summarize(evaluated);
  const thresholds = evaluateThresholds(metrics);
  const promote = Object.values(thresholds).every(item => item.passed) && metrics.unsupported_cases === 0;
  const outPath = options.out ? resolve(EXTENSION_ROOT, options.out) : undefined;
  const result = {
    status: promote ? "success" : "warning",
    summary: promote
      ? `Impact proof passed ${metrics.passed_cases}/${metrics.total_cases} cases; code_context({ purpose:'impact' }) can use this code-graph contract after product integration review.`
      : `Impact proof did not promote impact code_context: ${metrics.passed_cases}/${metrics.total_cases} cases passed, fixture pass rate ${percent(metrics.known_fixture_pass_rate)}, false negative rate ${percent(metrics.false_negative_rate)}.` ,
    next_actions: promote
      ? ["Keep trace(relation:'impact') rejected; route impact through code_context({ purpose:'impact' }) with tests."]
      : ["Keep trace(relation:'impact') unsupported.", "Use trace callers/callees/imports/importers/tests/file_summary as relationship seeds, then live read paths before making impact claims."],
    artifacts: outPath ? [relativePath(EXTENSION_ROOT, outPath), ".tmp/navigation-impact-evidence/README.md"] : ["stdout", ".tmp/navigation-impact-evidence/README.md"],
    recovery: {
      safe_retry: `npm run nav:impact-benchmark -- --fixture synthetic --json --out ${DEFAULT_OUT}`,
      stop_conditions: ["known fixture pass rate below 90%", "any generated/vendor/cache top hit", "missing live result path", "dynamic/framework reachability not explicitly unsupported"],
    },
    fixture,
    promotion: {
      expose_trace_impact: promote,
      reason: promote ? "synthetic thresholds passed, but trace integration still needs a dedicated product slice" : "thresholds did not pass; unsupported status remains the honest product behavior",
    },
    backend_candidates: backendCandidates(),
    thresholds,
    metrics,
    cases: evaluated,
  };

  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

async function createSyntheticRepo(root) {
  await mkdir(join(root, ".git"), { recursive: true });
  await touch(root, "package.json", JSON.stringify({ name: "impact-fixture", type: "module" }));
  await touch(root, "src/core.ts", [
    "export function calculateTotal(lines: number[]) {",
    "  return lines.reduce((sum, value) => sum + value, 0);",
    "}",
    "export function createInvoice(lines: number[]) {",
    "  return { total: calculateTotal(lines) };",
    "}",
    "export const handlers = {",
    "  invoice: () => createInvoice([1, 2, 3]),",
    "};",
    "",
  ].join("\n"));
  await touch(root, "src/app.ts", "import { createInvoice } from './core';\nexport function renderApp() { return createInvoice([5]); }\n");
  await touch(root, "src/api.ts", "import { createInvoice } from './core';\nexport function apiInvoice() { return createInvoice([8]); }\n");
  await touch(root, "src/dynamic.ts", "import { handlers } from './core';\nexport function invoke(name: keyof typeof handlers) { return handlers[name](); }\n");
  await touch(root, "tests/core.test.ts", "import { calculateTotal } from '../src/core';\nexport const observed = calculateTotal([1, 2]);\n");
  await touch(root, "dist/generated.ts", "import { createInvoice } from '../src/core';\nexport const generated = createInvoice([999]);\n");
  await touch(root, "node_modules/pkg/noise.ts", "import { calculateTotal } from '../../src/core';\nexport const noise = calculateTotal([0]);\n");
  await touch(root, ".codanna/index/cache.ts", "export const cache = 'createInvoice';\n");
  await touch(root, "docs/impact.md", "# Impact notes\ncalculateTotal appears in docs but is not a caller.\n");
}

function impactCases() {
  return [
    {
      name: "symbol-callers-createInvoice",
      target: "createInvoice",
      relation_seed: "callers",
      expectation: "direct symbol callers only",
      expected_paths: ["src/app.ts", "src/api.ts", "src/core.ts"],
      expected_unsupported: false,
    },
    {
      name: "symbol-callers-calculateTotal",
      target: "calculateTotal",
      relation_seed: "callers",
      expectation: "direct symbol callers only",
      expected_paths: ["src/core.ts", "tests/core.test.ts"],
      expected_unsupported: false,
    },
    {
      name: "file-blast-radius-core",
      target: "src/core.ts",
      relation_seed: "file_summary",
      expectation: "file summary is a weak seed, not directional blast radius",
      expected_paths: ["src/app.ts", "src/api.ts", "src/dynamic.ts", "tests/core.test.ts"],
      expected_unsupported: false,
    },
    {
      name: "dynamic-dispatch-handler",
      target: "handlers.invoice",
      relation_seed: "unsupported_dynamic_dispatch",
      expectation: "dynamic/framework reachability is explicitly unsupported",
      expected_paths: [],
      expected_unsupported: true,
    },
  ];
}

async function evaluateCase(testCase, ctx) {
  const candidate = await candidateFor(testCase, ctx);
  const actual = candidate.paths;
  const missing = testCase.expected_paths.filter(path => !actual.includes(path));
  const extra = actual.filter(path => !testCase.expected_paths.includes(path));
  const generatedVendorCacheTopHits = actual.filter(isUnsafePath);
  const resultPathsExist = [];
  for (const resultPath of actual) resultPathsExist.push({ path: resultPath, exists: existsSync(join(ctx.root, resultPath)) });
  const unsupportedOk = testCase.expected_unsupported ? candidate.status === "unsupported" : candidate.status !== "unsupported";
  const passed = unsupportedOk && missing.length === 0 && extra.length === 0 && generatedVendorCacheTopHits.length === 0 && resultPathsExist.every(item => item.exists);
  return {
    name: testCase.name,
    target: testCase.target,
    relation_seed: testCase.relation_seed,
    expectation: testCase.expectation,
    expected_paths: testCase.expected_paths,
    expected_unsupported: testCase.expected_unsupported,
    actual: candidate,
    passed,
    confidence: candidate.confidence,
    false_negatives: missing,
    false_positives: extra,
    generated_vendor_cache_top_hits: generatedVendorCacheTopHits,
    result_paths_exist: resultPathsExist,
  };
}

async function candidateFor(testCase, ctx) {
  if (testCase.relation_seed === "unsupported_dynamic_dispatch") {
    return {
      status: "unsupported",
      confidence: "none",
      paths: [],
      reason: "dynamic dispatch/framework reachability is outside the current trace relationship contract",
      next_reads: [],
    };
  }
  if (testCase.relation_seed === "file_summary") {
    return {
      status: "unsupported",
      confidence: "low",
      paths: [],
      reason: "file_summary is a weak relationship seed, not a directional blast-radius proof",
      next_reads: [],
    };
  }

  const paths = [];
  const needle = new RegExp(`\\b${escapeRegExp(testCase.target)}\\s*\\(`);
  const declaration = new RegExp(`\\b(?:export\\s+)?(?:function|const|let|var|class|interface|type)\\s+${escapeRegExp(testCase.target)}\\b`);
  for (const file of ctx.sourceFiles) {
    const text = await readFile(file, "utf8");
    const withoutDeclarationOnly = text.split(/\r?\n/).filter(line => !declaration.test(line)).join("\n");
    if (needle.test(withoutDeclarationOnly)) paths.push(relativePath(ctx.root, file));
  }
  const uniquePaths = [...new Set(paths)].sort();
  return {
    status: "relationship_seed",
    confidence: "medium",
    paths: uniquePaths,
    reason: "static direct-call scan approximates trace callers/usages seed behavior; it is not a complete impact proof",
    next_reads: uniquePaths.map(path => `${path}:1`),
  };
}

function summarize(cases) {
  const passed = cases.filter(testCase => testCase.passed).length;
  const supported = cases.filter(testCase => !testCase.expected_unsupported);
  const expectedEdges = supported.reduce((sum, testCase) => sum + testCase.expected_paths.length, 0);
  const falseNegatives = supported.reduce((sum, testCase) => sum + testCase.false_negatives.length, 0);
  const resultPathChecks = cases.flatMap(testCase => testCase.result_paths_exist);
  const existingResultPaths = resultPathChecks.filter(item => item.exists).length;
  return {
    total_cases: cases.length,
    passed_cases: passed,
    failed_cases: cases.length - passed,
    known_fixture_pass_rate: cases.length ? passed / cases.length : 0,
    expected_supported_edges: expectedEdges,
    false_negative_count: falseNegatives,
    false_negative_rate: expectedEdges ? falseNegatives / expectedEdges : 0,
    false_positive_count: cases.reduce((sum, testCase) => sum + testCase.false_positives.length, 0),
    unsupported_cases: cases.filter(testCase => testCase.actual.status === "unsupported").length,
    unsupported_expected_cases: cases.filter(testCase => testCase.expected_unsupported).length,
    generated_vendor_cache_top_hits: cases.reduce((sum, testCase) => sum + testCase.generated_vendor_cache_top_hits.length, 0),
    result_path_existence_rate: resultPathChecks.length ? existingResultPaths / resultPathChecks.length : 1,
    confidence_levels: Object.fromEntries(cases.map(testCase => [testCase.name, testCase.confidence])),
  };
}

function evaluateThresholds(metrics) {
  return {
    known_fixture_pass_rate: { value: round(metrics.known_fixture_pass_rate), target: THRESHOLDS.knownFixturePassRate, passed: metrics.known_fixture_pass_rate >= THRESHOLDS.knownFixturePassRate },
    false_negative_rate_documented: { value: round(metrics.false_negative_rate), target: "documented", passed: Number.isFinite(metrics.false_negative_rate) },
    result_paths_exist: { value: round(metrics.result_path_existence_rate), target: THRESHOLDS.resultPathExistenceRate, passed: metrics.result_path_existence_rate >= THRESHOLDS.resultPathExistenceRate },
    generated_vendor_cache_top_hits: { value: metrics.generated_vendor_cache_top_hits, target: THRESHOLDS.generatedVendorCacheTopHits, passed: metrics.generated_vendor_cache_top_hits === THRESHOLDS.generatedVendorCacheTopHits },
    confidence_level_explicit: { value: Object.keys(metrics.confidence_levels).length, target: metrics.total_cases, passed: Object.values(metrics.confidence_levels).every(Boolean) },
    unsupported_cases_labeled: { value: metrics.unsupported_cases, target: metrics.unsupported_expected_cases, passed: metrics.unsupported_cases >= metrics.unsupported_expected_cases },
  };
}

function backendCandidates() {
  return [
    { backend: "pi-nav", status: "bundled", policy: "read-only live query; no prepared index or command lookup", used_in_harness: false, reason: "proof harness uses deterministic fixture truth instead of depending on native artifact execution" },
    { backend: "graphify", status: "skipped", policy: "only when existing graph is usable; never build at query time", used_in_harness: false, reason: "path/explain graph relationships do not prove directional blast radius here" },
  ];
}

async function listSourceFiles(root) {
  const files = [];
  await walk(root, files, root);
  return files.sort();
}

async function walk(dir, files, root) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relativePath(root, abs);
    if (isUnsafePath(rel)) continue;
    if (entry.isDirectory()) await walk(abs, files, root);
    else if (entry.isFile() && SOURCE_EXT.test(entry.name)) files.push(abs);
  }
}

async function touch(root, rel, content) {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

function isUnsafePath(path) {
  return path.split(/[\\/]+/).some(part => UNSAFE_SEGMENTS.has(part));
}

function relativePath(root, file) {
  return relative(root, file).replace(/\\/g, "/") || ".";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function helpText() {
  return `Usage: node scripts/navigation-impact-benchmark.mjs [--fixture synthetic] [--json] [--out PATH]\n\nRuns the offline impact/blast-radius proof harness for code_context({ purpose:'impact' }). trace(relation:'impact') remains unsupported in the clean-break surface.`;
}

function renderText(result) {
  if (result.help) return result.text;
  return [
    `Navigation impact benchmark: ${result.status}`,
    result.summary,
    `Expose trace impact: ${result.promotion.expose_trace_impact}`,
    `Next: ${result.next_actions.join("; ")}`,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (args.help) console.log(helpText());
  else runImpactBenchmark(args).then(result => {
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
  }).catch(error => {
    console.error(`ERROR: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
