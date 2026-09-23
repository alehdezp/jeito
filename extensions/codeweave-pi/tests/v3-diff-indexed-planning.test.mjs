// Focused controls for the indexed Diff planning adapter: one file-seeded
// projection feeds impact and review, exact Git/structural evidence survives an
// unavailable plan, comparison-only positions never become current/historical
// graph identities, deleted paths never seed planning, a revoked corpus
// admission withholds the plan, and an indexed refusal never falls back to the
// legacy graph query.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import { snapshots } from "../src/core/snapshot-store.ts";
import { registerDiffTool } from "../src/tools/diff.ts";
import { deriveAnalysisProject } from "../src/core/analysis-project.mjs";
import { MAINTENANCE_REVISION, MAINTENANCE_STATUS_FILE } from "../native/analysis/identity.mjs";

const APP_BASE = "export function changedSymbol() {\n  return 1;\n}\n";
const APP_CHANGED = "export function changedSymbol() {\n  return 2;\n}\n";

function makePi() {
  const tools = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, { ...tool, sourceInfo: { source: "jeito-codeweave-pi-test" } }); },
    on() {}, getActiveTools() { return []; }, getAllTools() { return [...tools.values()]; },
    tool(name) { const tool = tools.get(name); assert.ok(tool, `missing loaded tool ${name}`); return tool; },
  };
}
async function callResult(tool, params, cwd) {
  return tool.execute(`test-${tool.name}`, params, undefined, undefined, { cwd });
}
function textOf(result) {
  return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}
function git(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

/** File-seeded indexed projection double. `symbols` shape the structural diff
 *  reply, `projection` corrupts the indexed reply to force a refusal,
 *  `coverage`/`status`/`unseededFiles` shape native partial evidence, and
 *  `revokeCensusOn` changes the admitted corpus on that `pi_nav_files` call. */
function projectionCallNative(options = {}) {
  const { symbols = [{ name: "changedSymbol", change: "body_changed", role: "changed_symbol" }],
    projection, coverage, status = "ok", unseededFiles = [], revokeCensusOn = 0 } = options;
  const calls = [];
  let censusCalls = 0;
  const callNative = async ({ root: nativeRoot, operation, args }) => {
    calls.push({ operation, args });
    const digest = text => createHash("sha256").update(text).digest("hex");
    if (operation === "pi_nav_source_proof") {
      const sourceSnapshots = await Promise.all(args.paths.map(async path => {
        const canonicalPath = join(nativeRoot, path), text = await readFile(canonicalPath, "utf8");
        return { canonicalPath, text, rawDigest: digest(text).toUpperCase(), lineEnding: text.includes("\r\n") ? "crlf" : "lf", bom: text.startsWith("\ufeff") };
      }));
      return { sourceSnapshots, structured: { data: {}, completeness: { complete: true }, diagnostics: [] } };
    }
    if (operation === "pi_nav_diff" && args.review) {
      const source = args.source === "staged" ? "index" : "working_tree";
      const after = await readFile(join(nativeRoot, "src/app.ts"), "utf8");
      const side = text => ({ path: "src/app.ts", start: 1, end: 3, name: "changedSymbol", parent: null,
        fileDigest: digest(text), declaration: [{ line: 1, content: "export function changedSymbol() {" }] });
      const patch = git(nativeRoot, "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", ...(source === "index" ? ["--cached"] : []));
      return { structured: { data: { comparison: { afterSource: source, patchDigest: digest(patch) }, changes: [{ path: "src/app.ts", name: "changedSymbol", kind: "body_changed",
        old: side(APP_BASE), new: side(after), lines: [
          { kind: "context", content: "export function changedSymbol() {", oldLine: 1, newLine: 1 },
          { kind: "removed", content: "  return 1;", oldLine: 2, newLine: null },
          { kind: "added", content: "  return 2;", oldLine: null, newLine: 2 },
          { kind: "context", content: "}", oldLine: 3, newLine: 3 },
        ] }], changesCompleteness: { complete: true, omitted: 0 } }, completeness: { complete: true }, diagnostics: [] } };
    }
    if (operation === "pi_nav_diff") {
      return { text: "# Diff: src/app.ts — changedSymbol\n", structured: { data: {
        files: [{ path: "src/app.ts", change: "modified" }],
        symbols: symbols.map(symbol => ({ name: symbol.name, change: symbol.change, location: { path: symbol.path ?? "src/app.ts", start: 1, end: 3, role: symbol.role } })),
        locations: [],
      }, completeness: { complete: true }, diagnostics: [] } };
    }
    if (operation === "pi_nav_files") {
      censusCalls += 1;
      const files = revokeCensusOn && censusCalls >= revokeCensusOn ? ["src/app.ts"] : ["src/app.ts", "src/caller.ts"];
      return { structured: { data: { corpusPolicyVersion: 1, root: nativeRoot, files, directories: [] }, completeness: { complete: true } } };
    }
    if (operation === "pi_nav_search") {
      assert.ok(args.analysisProjection && typeof args.analysisProjection === "object", "indexed projection must carry analysisProjection");
      const files = args.analysisProjection.files ?? [];
      if (!files.length) throw new Error("indexed projection unavailable: impact requires 1..128 current relative files");
      assert.equal(args.query, "current-file impact", "the bridge canonicalizes the impact query");
      const nodes = [
        { id: "1", kind: "Function", name: "changedSymbol", qualifiedName: "src/app.ts::changedSymbol", filePath: "src/app.ts", startLine: 1, endLine: 3, endColumn: 1, depth: 0, isTestFile: false },
        { id: "2", kind: "Function", name: "callerSymbol", qualifiedName: "src/caller.ts::callerSymbol", filePath: "src/caller.ts", startLine: 3, endLine: 3, endColumn: 1, depth: 1, isTestFile: false },
      ];
      const edges = [{ id: 7, source: "2", target: "1", kind: "CALLS", line: 3, column: 0 }];
      const data = { mode: "analysis_projection", operation: args.analysisProjection.operation, query: args.query, status,
        nodes, candidates: [], edges, roots: ["1"],
        analysis: { interpretationRevision: MAINTENANCE_REVISION, policyDigest: args.analysisPolicyDigest,
          indexedRunId: randomUUID(), indexedStatusDigest: "a".repeat(64), scope: "code", semanticStatus: "unavailable" },
        coverage: coverage ?? { complete: true, returned: nodes.length, total: nodes.length, reasons: [] },
        selection: { testOnly: false, files: [...files].sort(), unseededFiles } };
      data.source_claims = await Promise.all(["src/app.ts", "src/caller.ts"].map(async path => ({ path, raw_digest: digest(await readFile(join(nativeRoot, path), "utf8")) })));
      return { structured: { data: projection ? projection(data) : data, completeness: { complete: true }, diagnostics: [] } };
    }
    throw new Error(`unexpected native operation ${operation}`);
  };
  return Object.assign(callNative, { calls, censusCalls: () => censusCalls });
}

async function indexedFixture(options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "diff-indexed-")));
  const root = join(base, "project");
  const indexRoot = join(base, "machine-indexes");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
  await writeFile(join(root, "src", "app.ts"), APP_BASE);
  await writeFile(join(root, "src", "caller.ts"), "import { changedSymbol } from './app';\n\nexport function callerSymbol() { return changedSymbol(); }\n");
  await writeFile(join(root, "src", "gone.ts"), "export function goneSymbol() {\n  return 0;\n}\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "add", "."); git(root, "commit", "-q", "-m", "base");
  await writeFile(join(root, "src", "app.ts"), APP_CHANGED);
  if (options.deletion === "mixed" || options.deletion === "only") await rm(join(root, "src", "gone.ts"));
  if (options.deletion === "only") await writeFile(join(root, "src", "app.ts"), APP_BASE);
  const automation = join(base, "automation.json");
  await writeFile(automation, JSON.stringify({ storage: { indexRoot }, providers: { allowCloud: false },
    automation: { mode: "aggressive", autoPrepareOnSessionStart: true, autoPrepareOnFirstBroadRequest: false, autoRefreshOnStop: false } }));
  if (options.withStore !== false) {
    const project = deriveAnalysisProject(root, indexRoot);
    await mkdir(project.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(project.directory, "graph.sqlite"), "", { mode: 0o600 });
    await writeFile(join(project.directory, MAINTENANCE_STATUS_FILE), JSON.stringify({ format: "codeweave-pi.maintenance.1", state: "ready", runId: randomUUID() }), { mode: 0o600 });
  }
  const { symbols, projection, coverage, status, unseededFiles, revokeCensusOn } = options;
  return { base, root, automation, callNative: projectionCallNative({ symbols, projection, coverage, status, unseededFiles, revokeCensusOn }) };
}

/** Point the tool at this fixture for the duration of one test, restoring the
 *  real prior environment and removing the disposable tree afterwards. */
function useFixture(t, fixture) {
  const previous = process.env.PI_NAV_AUTOMATION_CONFIG;
  process.env.PI_NAV_AUTOMATION_CONFIG = fixture.automation;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG;
    else process.env.PI_NAV_AUTOMATION_CONFIG = previous;
    await rm(fixture.base, { recursive: true, force: true });
  });
}

test("indexed impact issues one file-seeded projection and reports planning candidates", async t => {
  const fixture = await indexedFixture();
  useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "impact", budget: 12_000 }, fixture.root);
  const text = textOf(result);
  assert.match(text, /Diff impact/);
  assert.match(text, /Exact changed files \(1\): src\/app\.ts/);
  assert.match(text, /PREPARED PLANNING — stored graph evidence/);
  assert.match(text, /Prepared blast radius: 1 impacted node\(s\) across 1 additional file\(s\)\./);
  assert.match(text, /Impacted nodes \(1\)/);
  assert.match(text, /- src\/caller\.ts::callerSymbol \[node 2\] · src\/caller\.ts:3/);
  assert.match(text, /Impacted files: src\/caller\.ts/);
  assert.match(text, /Planning evidence not provided by the indexed graph \(explicit, not a zero result\): test coverage\/test gaps, risk scoring, affected flows\./);
  assert.equal(result.details.envelope.status, "success");
  assert.equal(result.details.status, "success");
  assert.equal(result.details.prepared.impact.planning.coverage_complete, true);
  const projections = fixture.callNative.calls.filter(call => call.operation === "pi_nav_search");
  assert.equal(projections.length, 1, "impact must issue exactly one indexed projection");
  assert.deepEqual(projections[0].args.analysisProjection, { operation: "impact", files: ["src/app.ts"] });
});

test("impact fits whole planning identities under 4k without losing exact changes or uncertainty", async t => {
  const names = Array.from({ length: 7 }, (_, i) => `${"候補".repeat(600)}_${i}`);
  const fixture = await indexedFixture({ projection(data) {
    for (const [i, name] of names.entries()) {
      const id = String(i + 3), line = i + 4;
      data.nodes.push({ ...data.nodes[1], id, name, qualifiedName: `src/caller.ts::${name}`, startLine: line, endLine: line });
      data.edges.push({ id: i + 8, source: id, target: "1", kind: "CALLS", line, column: 0 });
    }
    return data;
  } });
  useFixture(t, fixture);
  await writeFile(join(fixture.root, "src/caller.ts"),
    "import { changedSymbol } from './app';\n\nexport function callerSymbol() { return changedSymbol(); }\n" +
    names.map(name => `export function ${name}() { return changedSymbol(); }`).join("\n") + "\n");
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, view: "impact" }, fixture.root);
  const text = textOf(result);
  assert.ok(new Tiktoken(o200kBase).encode(text, [], []).length <= 4_000, "complete impact reply must fit 4k, not the 8k review allowance");
  assert.match(text, /Exact changed files.*src\/app\.ts.*src\/caller\.ts/);
  assert.match(text, /callerSymbol/);
  assert.match(text, /freshness and binding are not established/);
  assert.match(text, /test coverage\/test gaps, risk scoring, affected flows/);
  assert.match(text, /omitted/);
  assert.equal(result.details.status, "partial");
  // Every delivered long identity is whole; no clipped name passes as a lead.
  for (const row of text.split("\n").filter(row => row.startsWith("- ") && row.includes("候補"))) {
    assert.ok(names.some(name => row.includes(`::${name} [node `)), "partial identity leaked");
  }
  assert.equal(fixture.callNative.calls.filter(call => call.operation === "pi_nav_search").length, 1);
});

test("indexed review displays the paired change before certified explanatory consumer source", async t => {
  const fixture = await indexedFixture();
  useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "review", budget: 12_000 }, fixture.root);
  const text = textOf(result);
  assert.match(text, /- old:2 new:—   return 1;/);
  assert.match(text, /\+ old:— new:2   return 2;/);
  assert.match(text, /UNCHANGED CONSUMER SOURCE — src\/caller.ts/);
  assert.match(text, /Reason: src\/caller.ts::callerSymbol —CALLS→ src\/app.ts::changedSymbol at src\/caller.ts:3/);
  assert.match(text, /3:export function callerSymbol\(\) \{ return changedSymbol\(\); \}/);
  assert.match(text, /\[src\/caller.ts#[A-F0-9]{8}\]/);
  assert.ok(text.indexOf("return 2") < text.indexOf("UNCHANGED CONSUMER"));
  assert.doesNotMatch(text, /Impacted nodes|File-scope graph seeds|Structurally changed symbols/);
  assert.equal(result.details.envelope.status, "success");
});

test("staged review preserves paired changes without borrowing current consumer source", async t => {
  const fixture = await indexedFixture();
  useFixture(t, fixture);
  git(fixture.root, "add", "src/app.ts");
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", source: "staged", view: "review" }, fixture.root);
  const text = textOf(result);
  assert.match(text, /return 1;/); assert.match(text, /return 2;/);
  assert.match(text, /After-side connections unavailable/);
  assert.doesNotMatch(text, /CONSUMER SOURCE|callerSymbol\(\)/);
  assert.equal(fixture.callNative.calls.filter(call => call.operation === "pi_nav_source_proof").length, 0);
});

test("an indexed refusal keeps exact evidence and never falls back to the legacy graph query", async t => {
  const fixture = await indexedFixture({ projection: data => { data.analysis.indexedRunId = "not-a-uuid"; return data; } });
  useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "impact", budget: 12_000 }, fixture.root);
  const text = textOf(result);
  assert.match(text, /Diff impact/);
  assert.match(text, /Exact changed files \(1\): src\/app\.ts/);
  assert.match(text, /WARNING: indexed planning evidence unavailable for diff impact\./);
  assert.match(text, /indexed graph projection or completed-run identity is unavailable/);
  assert.match(text, /no legacy graph query was issued/);
  assert.equal(result.details.envelope.status, "warning");
  assert.equal(result.details.status, "partial");
  assert.equal(fixture.callNative.calls.filter(call => call.operation === "pi_nav_search").length, 1, "a refusal must not retry or reroute");
});

test("a revoked corpus admission withholds planning but keeps exact evidence", async t => {
  const fixture = await indexedFixture({ revokeCensusOn: 3 });
  useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "review", budget: 12_000 }, fixture.root);
  const text = textOf(result);
  assert.ok(fixture.callNative.censusCalls() >= 3, "the review fence must re-admit after the async structural work");
  assert.match(text, /return 1;/); assert.match(text, /return 2;/);
  assert.match(text, /support withheld after comparison\/admission drift/);
  assert.doesNotMatch(text, /callerSymbol\(\)/);
  assert.deepEqual(result.details.envelope.artifacts, []);
  assert.equal(result.details.envelope.status, "warning");
  assert.deepEqual(fixture.callNative.calls.filter(call => call.operation === "pi_nav_search").length, 1);
});

test("partial indexed coverage keeps success out of details and envelope", async t => {
  const fixture = await indexedFixture({ status: "incomplete", coverage: { complete: false, reasons: ["node_cap"], returned: 2, total: 2 } });
  useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "impact", budget: 12_000 }, fixture.root);
  const text = textOf(result);
  assert.match(text, /Indexed coverage reasons: node_cap/);
  assert.match(text, /Prepared backend output was truncated; counts above retain native limits\./);
  assert.match(text, /Prepared backend reported partial evidence\./);
  assert.equal(result.details.envelope.status, "warning");
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.prepared.impact.planning.status, "partial");
  assert.equal(result.details.prepared.impact.planning.coverage_complete, false);
  assert.deepEqual(result.details.prepared.impact.planning.coverage_reasons, ["node_cap"]);
});

test("a tiny impact budget preserves exact files and coherently withholds planning instead of clipping it", async t => {
  const fixture = await indexedFixture();
  useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "impact", budget: 200 }, fixture.root);
  const text = textOf(result);
  assert.match(text, /Planning evidence omitted/);
  assert.ok(text.length <= 200);
  assert.doesNotMatch(text, /Output truncated|PREPARED PLANNING/);
  assert.match(text, /Exact changed files \(1\): src\/app\.ts/);
  assert.equal(result.details.envelope.status, "warning");
  assert.equal(result.details.status, "partial");
  assert.deepEqual(result.details.envelope.diagnostics, ["Impact evidence omitted coherently by budget."]);
  assert.equal(result.details.prepared.impact, undefined, "withheld planning is not returned through details instead");
});

test("deleted paths are excluded from planning seeds while exact files stay complete", async t => {
  const fixture = await indexedFixture({ deletion: "mixed" });
  useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, view: "impact", budget: 12_000 }, fixture.root);
  const text = textOf(result);
  assert.match(text, /Exact changed files \(2\): src\/app\.ts, src\/gone\.ts/);
  assert.match(text, /1 exact changed path\(s\) are deleted or missing at query time and cannot seed the indexed graph/);
  assert.match(text, /src\/gone\.ts/);
  const projections = fixture.callNative.calls.filter(call => call.operation === "pi_nav_search");
  assert.equal(projections.length, 1);
  assert.deepEqual(projections[0].args.analysisProjection.files, ["src/app.ts"], "deleted paths never seed the indexed graph");
  assert.deepEqual(result.details.prepared.impact.planning.excluded_seeds, ["src/gone.ts"]);
  assert.equal(result.details.envelope.status, "success");
});

test("a deleted-only change set refuses planning without a seedless query", async t => {
  const fixture = await indexedFixture({ deletion: "only" });
  useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, view: "impact", budget: 12_000 }, fixture.root);
  const text = textOf(result);
  assert.match(text, /Exact changed files \(1\): src\/gone\.ts/);
  assert.match(text, /WARNING: indexed planning evidence unavailable for diff impact\./);
  assert.match(text, /no current file to seed indexed planning; all 1 changed path\(s\) are deleted or missing at query time/);
  assert.match(text, /no legacy graph query was issued/);
  assert.equal(result.details.envelope.status, "warning");
  assert.equal(result.details.status, "partial");
  const projections = fixture.callNative.calls.filter(call => call.operation === "pi_nav_search");
  assert.equal(projections.length, 0, "ownership routing refuses empty indexed seeds before a native query");
});

test("unseeded indexed files are disclosed instead of implying absent impact", async t => {
  const fixture = await indexedFixture({ unseededFiles: ["src/caller.ts"], status: "incomplete" });
  useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "impact", budget: 12_000 }, fixture.root);
  const text = textOf(result);
  assert.match(text, /Planning seeded from 1 current file\(s\); 1 of them have no indexed declaration, so these counts are not an absence claim for them: src\/caller\.ts\./);
  assert.equal(result.details.envelope.status, "warning");
  assert.equal(result.details.status, "partial");
  assert.deepEqual(result.details.prepared.impact.planning.unseeded_files, ["src/caller.ts"]);
});

test("no indexed publication reports planning unavailable with exact evidence and no indexed read", async t => {
  const fixture = await indexedFixture({ withStore: false });
  useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "impact", budget: 12_000 }, fixture.root);
  const text = textOf(result);
  assert.match(text, /Diff impact/);
  assert.match(text, /Exact changed files \(1\): src\/app\.ts/);
  assert.match(text, /WARNING: indexed planning evidence unavailable for diff impact/);
  assert.match(text, /no published indexed code graph may be read for this scope/);
  assert.match(text, /no legacy graph query was issued/);
  assert.doesNotMatch(text, /Prepared blast radius|0 impacted node/, "a missing index is not an empty impact claim");
  assert.equal(result.details.envelope.status, "warning");
  assert.equal(result.details.diff.exactRangesStatus !== "unavailable" || result.details.diff.exactFiles.length === 1, true, "the exact Git receipt survives without planning");
  assert.equal(fixture.callNative.calls.filter(call => call.operation === "pi_nav_search").length, 0, "absent index must not be read for planning");
  assert.equal(fixture.callNative.censusCalls(), 0, "absent index must not even enumerate a corpus");
});

test("changed consumer outside target scope is not labeled unchanged", async t => {
  const fixture = await indexedFixture(); useFixture(t, fixture);
  await writeFile(join(fixture.root, "src/caller.ts"), "import { changedSymbol } from './app';\n// also changed\nexport function callerSymbol() { return changedSymbol(); }\n");
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const text = textOf(await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "review" }, fixture.root));
  assert.match(text, /SUPPORTING AFTER-SOURCE — src\/caller.ts/);
  assert.doesNotMatch(text, /UNCHANGED CONSUMER/);
});

test("wrong after digest withholds consumer source while preserving the change", async t => {
  const fixture = await indexedFixture({ projection: data => { data.source_claims[0].raw_digest = "f".repeat(64); return data; } });
  useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const text = textOf(await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "review" }, fixture.root));
  assert.match(text, /return 1;/); assert.match(text, /return 2;/);
  assert.match(text, /No direct source support could be associated/);
  assert.doesNotMatch(text, /callerSymbol\(\)/);
});

test("structural refusal leaves the actual Git change, not only a changed-file count", async t => {
  const fixture = await indexedFixture(); useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: request => {
    if (request.operation === "pi_nav_diff") throw new Error("structural unavailable");
    return fixture.callNative(request);
  } });
  const text = textOf(await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "review" }, fixture.root));
  assert.match(text, /Exact before\/after patch/);
  assert.match(text, /-  return 1;/); assert.match(text, /\+  return 2;/);
  assert.doesNotMatch(text, /File-scope graph seeds/);
});

test("comparison drift withholds support even when after-file digests still agree", async t => {
  const fixture = await indexedFixture(); useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: async request => {
    const output = await fixture.callNative(request);
    if (request.operation === "pi_nav_diff") output.structured.data.comparison.patchDigest = "0".repeat(64);
    return output;
  } });
  const text = textOf(await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "review" }, fixture.root));
  assert.match(text, /captured comparison no longer matches Git/);
  assert.match(text, /return 1;/); assert.match(text, /return 2;/);
  assert.doesNotMatch(text, /callerSymbol\(\)/);
  assert.equal(snapshots.head(join(fixture.root, "src/caller.ts")), undefined);
});

test("discarded support grants no authority and leaves the coherent paired change", async t => {
  const fixture = await indexedFixture(); useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "review", budget: 700 }, fixture.root);
  const text = textOf(result);
  assert.match(text, /return 1;/); assert.match(text, /return 2;/);
  assert.match(text, /Related source not displayed/);
  assert.doesNotMatch(text, /callerSymbol\(\)|\[src\/caller.ts#/);
  assert.ok(text.length <= 700);
  assert.equal(snapshots.head(join(fixture.root, "src/caller.ts")), undefined);
  assert.equal(snapshots.head(join(fixture.root, "src/app.ts")), undefined, "comparison rows are not current edit authority");
});

for (const withStore of [true, false]) test(`selected whole change units obey the 8000-token complete-reply cap (indexed=${withStore})`, async t => {
  const fixture = await indexedFixture({ withStore }); useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: async request => {
    const output = await fixture.callNative(request);
    if (request.operation === "pi_nav_diff") {
      const unit = output.structured.data.changes[0];
      output.structured.data.changes = Array.from({ length: 256 }, (_, i) => ({ ...unit, path: `src/owner${i}.ts`, name: `Owner${i}` }));
    }
    return output;
  } });
  const text = textOf(await callResult(pi.tool("diff"), { root: fixture.root, view: "review", budget: 1000000 }, fixture.root));
  assert.ok(new Tiktoken(o200kBase).encode(text, [], []).length <= 8000);
  assert.match(text, /Selected changes not displayed/);
  assert.equal((text.match(/return 1;/g) ?? []).length, (text.match(/return 2;/g) ?? []).length, "never display only one delta side");
  assert.ok(text.includes("CHANGE src/owner0.ts"));
});

test("malformed paired transport preserves Git changes rather than crashing review", async t => {
  const fixture = await indexedFixture(); useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: async request => {
    const output = await fixture.callNative(request);
    if (request.operation === "pi_nav_diff") output.structured.data.changes[0].lines[0].kind = "invented";
    return output;
  } });
  const text = textOf(await callResult(pi.tool("diff"), { root: fixture.root, view: "review" }, fixture.root));
  assert.match(text, /Paired-source transport rejected/);
  assert.match(text, /-  return 1;/); assert.match(text, /\+  return 2;/);
  assert.doesNotMatch(text, /callerSymbol\(\)/);
});

test("an untracked consumer is after-source, not an unchanged comparison participant", async t => {
  const fixture = await indexedFixture(); useFixture(t, fixture);
  git(fixture.root, "rm", "--cached", "src/caller.ts");
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const text = textOf(await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "review" }, fixture.root));
  assert.match(text, /SUPPORTING AFTER-SOURCE — src\/caller.ts \(comparison membership not established\)/);
  assert.match(text, /return changedSymbol\(\)/);
  assert.doesNotMatch(text, /UNCHANGED CONSUMER/);
});

test("file import edges do not expand unrelated file bodies as consumers", async t => {
  const fixture = await indexedFixture({ projection: data => {
    data.nodes[1].kind = "File"; data.nodes[1].startLine = 1;
    data.edges[0].kind = "IMPORTS"; data.edges[0].line = 1;
    return data;
  } }); useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const text = textOf(await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts", view: "review" }, fixture.root));
  assert.match(text, /1 file\/import relationship\(s\) not expanded/);
  assert.doesNotMatch(text, /callerSymbol\(\)|CONSUMER SOURCE/);
  assert.match(text, /return 1;/); assert.match(text, /return 2;/);
});

test("NUL-delimited changed paths retain trailing whitespace", async t => {
  const fixture = await indexedFixture({ withStore: false }); useFixture(t, fixture);
  const path = "src/ spaced.ts ";
  await writeFile(join(fixture.root, path), "export const before = 1;\n");
  git(fixture.root, "add", "--", path); git(fixture.root, "commit", "-qm", "spaced baseline");
  await writeFile(join(fixture.root, path), "export const before = 2;\n");
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const text = textOf(await callResult(pi.tool("diff"), { root: fixture.root, scope: path, view: "impact" }, fixture.root));
  assert.ok(text.includes(`Exact changed files (1): ${path}\n`), text);
});

for (const withStore of [true, false]) test(`repository default delivers paired source (indexed=${withStore}); direct default stays summary`, async t => {
  const fixture = await indexedFixture({ withStore });
  useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, scope: "src/app.ts" }, fixture.root);
  const text = textOf(result);
  assert.match(text, /- old:2 new:—   return 1;/, `before source must survive graph availability=${withStore}`);
  assert.match(text, /\+ old:— new:2   return 2;/);
  assert.ok(fixture.callNative.calls.some(call => call.operation === "pi_nav_diff" && call.args.review === true));
  const direct = await callResult(pi.tool("diff"), { a: "src/app.ts", b: "src/caller.ts" }, fixture.root);
  assert.match(textOf(direct), /Read-only file comparison summary/);
});

test("review and omitted-view search reach native paired selection; explicit summary remains distinct", async t => {
  const fixture = await indexedFixture(); useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: fixture.callNative });
  for (const view of [undefined, "review"]) {
    const result = await callResult(pi.tool("diff"), { root: fixture.root, view, search: "CHANGEDsymbol" }, fixture.root);
    assert.match(textOf(result), /CHANGE src\/app.ts::changedSymbol/);
    assert.ok(fixture.callNative.calls.some(call => call.operation === "pi_nav_diff" && call.args.review === true && call.args.search === "CHANGEDsymbol"));
  }
  const summary = await callResult(pi.tool("diff"), { root: fixture.root, view: "summary" }, fixture.root);
  assert.match(textOf(summary), /Read-only unstaged working-tree summary/);
  assert.doesNotMatch(textOf(summary), /old:2|CONSUMER SOURCE/);
  const invalid = await callResult(pi.tool("diff"), { root: fixture.root, view: "summary", search: "changed" }, fixture.root);
  assert.equal(invalid.details.envelope.status, "error");
});

for (const withStore of [true, false]) test(`review selection distinguishes zero from unavailable (indexed=${withStore})`, async t => {
  const fixture = await indexedFixture({ withStore }); useFixture(t, fixture);
  const pi = makePi();
  registerDiffTool(pi, { callNative: async request => {
    if (request.operation === "pi_nav_diff" && request.args.review && request.args.search === "unavailable") throw new Error("paired selection unavailable");
    const output = await fixture.callNative(request);
    if (request.operation === "pi_nav_diff" && request.args.review) {
      if (request.args.search === "missing") output.structured.data.changes = [];
      if (request.args.search === "malformed") output.structured.data.changes = [{ path: "src/app.ts", lines: "not source rows" }];
    }
    return output;
  } });
  const zero = await callResult(pi.tool("diff"), { root: fixture.root, search: "missing" }, fixture.root);
  assert.match(textOf(zero), /no changed units matched/);
  assert.doesNotMatch(textOf(zero), /return 1;|return 2;|callerSymbol/);
  for (const search of ["unavailable", "malformed"]) {
    const result = await callResult(pi.tool("diff"), { root: fixture.root, search }, fixture.root);
    assert.equal(result.details.envelope.status, "error");
    assert.match(textOf(result), /selection unavailable.*search was not ignored/);
    assert.doesNotMatch(textOf(result), /no changed units matched|return 1;|return 2;|callerSymbol/);
  }
  assert.equal(snapshots.head(join(fixture.root, "src/caller.ts")), undefined, "selection refusals grant no consumer-source authority");
});

for (const overflow of ["text", "metadata", "none"]) test(`structure grants authority only after the complete reply survives delivery (${overflow})`, async t => {
  const fixture = await indexedFixture({ withStore: false }); useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: async request => {
    const output = await fixture.callNative(request);
    if (request.operation === "pi_nav_diff") {
      output.text = overflow === "text" ? "X".repeat(130 * 1024) : "Changed symbol: changedSymbol";
      output.structured.data.locations = [{ path: "src/app.ts", start: 1, end: 3, label: "changedSymbol", role: "changed_symbol" }];
      if (overflow === "metadata") output.structured.data.largeRecord = "X".repeat(260 * 1024);
    }
    return output;
  } });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, view: "structure", budget: 200000 }, fixture.root);
  assert.ok(fixture.callNative.calls.some(call => call.operation === "pi_nav_source_proof"), "the withheld-preview test must actually prepare a source proof");
  if (overflow === "none") {
    assert.match(textOf(result), /return 2;/);
    assert.ok(snapshots.head(join(fixture.root, "src/app.ts")), "delivered current source keeps its authority");
  } else {
    assert.match(textOf(result), /withheld/i);
    assert.equal(result.details.envelope.status, "warning");
    assert.equal(snapshots.head(join(fixture.root, "src/app.ts")), undefined, "withheld source cannot authorize an edit");
  }
});

test("unavailable paired and patch source retain a bounded changed-file receipt", async t => {
  const fixture = await indexedFixture(); useFixture(t, fixture);
  const files = Array.from({ length: 30 }, (_, i) => `changed-${"n".repeat(80)}-${i}.txt`);
  for (const file of files) await writeFile(join(fixture.root, file), "before\n");
  git(fixture.root, "add", "--", ...files); git(fixture.root, "commit", "-qm", "wide baseline");
  for (const [i, file] of files.entries()) await writeFile(join(fixture.root, file), i === 0 ? "x".repeat(1_100_000) : "after\n");
  const pi = makePi(); registerDiffTool(pi, { callNative: request => {
    if (request.operation === "pi_nav_diff") throw new Error("paired source unavailable");
    return fixture.callNative(request);
  } });
  const result = await callResult(pi.tool("diff"), { root: fixture.root, budget: 2200 }, fixture.root);
  const text = textOf(result);
  assert.equal(result.details.envelope.status, "warning");
  assert.match(text, /exact changed files \(31\)/);
  assert.match(text, /… 19 more/);
  assert.match(text, /No empty comparison is inferred/);
  assert.ok(text.length <= 2200);
});

test("oversized invalid Diff diagnostics stay bounded before any native execution", async () => {
  let calls = 0;
  const pi = makePi(); registerDiffTool(pi, { callNative: async () => { calls++; throw new Error("unexpected native call"); } });
  const result = await callResult(pi.tool("diff"), { view: "invalid_" + "界 ".repeat(6000) }, process.cwd());
  assert.equal(calls, 0);
  assert.equal(result.details.envelope.status, "error");
  assert.ok(new Tiktoken(o200kBase).encode(textOf(result), [], []).length <= 4000, "invalid input cannot create an oversized diagnostic");
  assert.doesNotMatch(JSON.stringify(result.details), /(?:界 ){100}/, "withheld input cannot escape through details");
});

test('structure counts the source-proof footer before granting authority and retains bounded locators', async t => {
  const fixture = await indexedFixture({ withStore: false }); useFixture(t, fixture);
  const nativeText = 'change '.repeat(7990);
  const tokenizer = new Tiktoken(o200kBase);
  assert.ok(tokenizer.encode(nativeText, [], []).length < 8000, 'native body alone must fit');
  const pi = makePi(); registerDiffTool(pi, { callNative: async request => {
    const output = await fixture.callNative(request);
    if (request.operation === 'pi_nav_diff') {
      output.text = nativeText;
      output.structured.data.files = [{ path: 'src/app.ts', change: 'modified' }];
      const location = { path: 'src/app.ts', start: 1, end: 3, label: 'changedSymbol', role: 'changed_symbol' };
      output.structured.data.locations = [location];
      output.structured.data.symbols = [{ name: 'changedSymbol', change: 'body_changed', location }];
    }
    return output;
  } });
  const result = await callResult(pi.tool('diff'), { root: fixture.root, view: 'structure', budget: 100000 }, fixture.root);
  const text = textOf(result);
  assert.ok(tokenizer.encode(text, [], []).length <= 8000);
  assert.match(text, /Comparison source withheld/);
  assert.match(text, /src\/app\.ts:1-3.*changedSymbol/);
  assert.doesNotMatch(text, /return 2;|change change change/);
  assert.equal(result.details.envelope.status, 'warning');
  assert.equal(snapshots.head(join(fixture.root, 'src/app.ts')), undefined, 'rejected source proof cannot authorize edits');
  assert.equal(fixture.callNative.calls.filter(call => call.operation === 'pi_nav_diff').length, 1, 'fitting cannot recapture a different comparison');
  assert.ok(fixture.callNative.calls.some(call => call.operation === 'pi_nav_source_proof'));
});

test('oversized structure without file metadata preserves unavailable rather than inventing zero', async t => {
  const fixture = await indexedFixture({ withStore: false }); useFixture(t, fixture);
  const pi = makePi(); registerDiffTool(pi, { callNative: async request => {
    const output = await fixture.callNative(request);
    if (request.operation === 'pi_nav_diff') {
      output.text = 'X'.repeat(130 * 1024);
      delete output.structured.data.files;
    }
    return output;
  } });
  const result = await callResult(pi.tool('diff'), { root: fixture.root, view: 'structure' }, fixture.root);
  assert.match(textOf(result), /Changed-file inventory unavailable/);
  assert.doesNotMatch(textOf(result), /Changed files.*\(0\)/);
  assert.equal(result.details.envelope.status, 'warning');
  assert.ok(new Tiktoken(o200kBase).encode(textOf(result), [], []).length <= 8000);
  assert.equal(snapshots.head(join(fixture.root, 'src/app.ts')), undefined);
});
