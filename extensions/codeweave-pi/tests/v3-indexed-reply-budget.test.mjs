import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import { deriveAnalysisProject } from "../src/core/analysis-project.mjs";
import { MAINTENANCE_REVISION, MAINTENANCE_STATUS_FILE } from "../native/analysis/identity.mjs";
import { snapshots } from "../src/core/snapshot-store.ts";
import { registerTraceTool } from "../src/tools/trace.ts";
import { registerExploreTool } from "../src/tools/explore.ts";

const ruler = new Tiktoken(o200kBase);
const tokens = text => ruler.encode(text, [], []).length;
const sha = text => createHash("sha256").update(text).digest("hex").toUpperCase();
const targets = ["AlphaTarget", "BetaTarget", "GammaTarget", "DeltaTarget"];

// This proves registered composition, not native graph extraction. Unlike the
// disposable pressure specimen, each query owns different real declarations,
// exact call sites and matching source versions.
function fixture(t, count = 160) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "indexed-reply-budget-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, "source"), indexRoot = join(temporary, "indexes");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), "{}");
  const project = deriveAnalysisProject(root, indexRoot);
  mkdirSync(project.directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(project.directory, "graph.sqlite"), "fixture reader owns validation", { mode: 0o600 });
  writeFileSync(join(project.directory, MAINTENANCE_STATUS_FILE), "fixture routing hint", { mode: 0o600 });
  const config = join(temporary, "automation.json");
  writeFileSync(config, JSON.stringify({ storage: { indexRoot } }));
  const previous = process.env.PI_NAV_AUTOMATION_CONFIG;
  process.env.PI_NAV_AUTOMATION_CONFIG = config;
  t.after(() => { if (previous === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG; else process.env.PI_NAV_AUTOMATION_CONFIG = previous; });
  const texts = new Map(), projections = new Map(), paths = new Map();
  const add = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    texts.set(path, text);
  };
  for (const target of targets) {
    const targetPath = `targets/${target}.ts`;
    add(targetPath, `export function ${target}() { return 1; }\n`);
    const nodes = [{ id: target, kind: "function", name: target, qualifiedName: `${targetPath}::${target}`, filePath: targetPath, startLine: 1, endLine: 1 }];
    const edges = [], callers = [];
    for (let i = 0; i < count; i++) {
      const name = `${target}ScheduledHeartbeatCaller${String(i).padStart(3, "0")}`;
      const path = `packages/core/src/services/heartbeat/scheduler/orchestration/retry/${name}.ts`;
      const module = relative(dirname(path), targetPath).replace(/\.ts$/, "");
      const reference = i % 7 === 0;
      add(path, `import { ${target} } from '${module}';\nexport function ${name}() {\n  return ${target}${reference ? "" : "()"};\n}\n`);
      nodes.push({ id: name, kind: "function", name, qualifiedName: `${path}::${name}`, filePath: path, startLine: 2, endLine: 4 });
      edges.push({ id: i, source: name, target, kind: "call", file_path: path, line: 3, column: 9, functionReference: reference });
      callers.push(path);
    }
    paths.set(target, callers);
    projections.set(target, { nodes, edges, roots: [target] });
  }
  const calls = [], tools = new Map();
  let before = new Map(), revoke = false, revokeAfterProof = false, failedTarget, proofCalls = 0, failProofAfter = Infinity;
  const currentAuthority = path => [...(snapshots.head(join(root, path))?.seenLines ?? [])].sort((a, b) => a - b);
  const callNative = async request => {
    calls.push(request);
    if (request.operation === "pi_nav_files") return { text: "", structured: { schemaVersion: 1, operation: request.operation,
      data: { root: request.root, corpusPolicyVersion: 1, files: revoke ? [] : [...texts.keys()], directories: [""] }, completeness: { complete: true }, diagnostics: [] } };
    if (request.operation === "pi_nav_source_proof") {
      for (const path of texts.keys()) assert.deepEqual(currentAuthority(path), before.get(path) ?? [], "no authority may land while composing/retrying");
      if (++proofCalls > failProofAfter) throw new Error("controlled source proof failure");
      const sourceSnapshots = request.args.paths.map(path => {
        const rel = isAbsolute(path) ? relative(root, path) : path;
        const text = texts.get(rel);
        assert.equal(typeof text, "string", `unexpected proof path ${path}`);
        return { canonicalPath: join(root, rel), text, rawDigest: sha(text), bom: false, lineEnding: "lf" };
      });
      if (revokeAfterProof) revoke = true;
      return { text: "", structured: { schemaVersion: 1, operation: request.operation, data: { files: [] }, completeness: { complete: true }, diagnostics: [] }, sourceSnapshots };
    }
    assert.equal(request.operation, "pi_nav_search");
    if (request.args.query === failedTarget) throw new Error("controlled unavailable target");
    const projection = projections.get(request.args.query);
    assert.ok(projection, "each target must select its own projection");
    const data = { ...projection, mode: "analysis_projection", operation: request.args.analysisProjection.operation,
      query: request.args.query, status: "ok", candidates: [], coverage: { complete: true },
      source_claims: projection.nodes.map(node => ({ path: node.filePath, raw_digest: sha(texts.get(node.filePath)) })),
      analysis: { indexedRunId: "99999999-9999-4999-8999-999999999999", indexedStatusDigest: "b".repeat(64), interpretationRevision: MAINTENANCE_REVISION,
        policyDigest: request.args.analysisPolicyDigest, scope: "project", semanticStatus: "unavailable" } };
    return { text: "indexed projection", structured: { schemaVersion: 1, operation: request.operation, data, completeness: { complete: true }, diagnostics: [] }, sourceSnapshots: [] };
  };
  const pi = { registerTool(tool) { tools.set(tool.name, tool); }, on() {}, getActiveTools() { return []; }, setActiveTools() {} };
  registerTraceTool(pi, { callNative }); registerExploreTool(pi, { callNative });
  return { root, texts, paths, calls, projections, revokeOnProof() { revokeAfterProof = true; }, failTarget(target) { failedTarget = target; }, failProofAfter(count) { failProofAfter = count; }, async call(name, params) {
    before = new Map([...texts.keys()].map(path => [path, currentAuthority(path)]));
    const start = calls.length;
    const result = await tools.get(name).execute(name, { scope: root, ...params }, undefined, undefined, { cwd: root });
    const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    assert.ok(tokens(text) <= 4_000, `${name}: ${tokens(text)} tokens`);
    assert.doesNotMatch(JSON.stringify(result), /source_claims|raw_digest/);
    // Check exact model-visible source, and certify no row hidden in a rejected
    // larger page, metadata, or earlier batch item.
    const visible = new Map(); let path;
    for (const line of text.split("\n")) {
      const header = /^\[([^\]]+)#[A-F0-9]{8}\]$/.exec(line);
      if (header) { path = isAbsolute(header[1]) ? relative(root, header[1]) : header[1]; continue; }
      const row = /^(\d+):(.*)$/.exec(line);
      if (!row || !path) continue;
      assert.equal(row[2], texts.get(path)?.split("\n")[Number(row[1]) - 1], `source mismatch ${path}:${row[1]}`);
      if (!visible.has(path)) visible.set(path, new Set());
      visible.get(path).add(Number(row[1]));
    }
    for (const path of texts.keys()) {
      const expected = [...new Set([...(before.get(path) ?? []), ...(visible.get(path) ?? [])])].sort((a, b) => a - b);
      assert.deepEqual(currentAuthority(path), expected, `undisplayed source authority: ${path}`);
    }
    return { ...result, text, visible, requests: calls.slice(start) };
  } };
}

for (const name of ["trace", "explore"]) {
  test(`${name} preserves fitting pages, explicitly restarts oversized later pages, and never credits discarded source`, async t => {
    const f = fixture(t);
    const request = name === "trace" ? { target: targets[0], relation: "CALLERS" } : { view: "CODE", operation: "search", anchor: targets[0] };
    const small = await f.call(name, { ...request, page: 1, limit: 2 });
    assert.equal(small.details.budgetRestart, undefined);
    assert.equal(small.details.envelope.status, "success");
    assert.ok(small.visible.size > 0, "a cap-only empty answer is not accepted");
    assert.match(small.text, /Call normalization/);
    assert.equal(small.requests.filter(r => r.operation === "pi_nav_search").length, 1);
    const large = await f.call(name, { ...request, page: 2, limit: 80 });
    const restart = large.details.budgetRestart;
    assert.ok(restart && restart.limit < 80, "pressure must exercise a real restart");
    assert.equal(restart.requestedPage, 2); assert.equal(restart.page, 1);
    assert.match(large.text, /requested page 2, limit 80; restarted at page 1/);
    assert.match(large.text, /no generation is pinned/);
    assert.equal(large.details.envelope.status, "warning");
    assert.equal(large.requests.filter(r => r.operation === "pi_nav_search").length, 1, "refits do not recollect");
    const windows = large.details.presentation.pageWindows;
    assert.ok(windows.length);
    for (const window of windows) { assert.equal(window.page, 1); assert.equal(window.page_size, restart.limit); assert.equal(window.omitted_before, 0); }
    assert.equal(snapshots.head(join(f.root, f.paths.get(targets[0])[85])), undefined, "the rejected page-two source stayed uncredited");
    const next = await f.call(name, { ...request, page: 2, limit: restart.limit });
    assert.equal(next.details.budgetRestart, undefined, "the smaller page size must make progress");
    for (const window of next.details.presentation.pageWindows) assert.equal(window.omitted_before, Math.min(window.total_count, restart.limit));
  });
}

test("Trace 2-4 target joins share one budget and commit only each final target's source", async t => {
  const f = fixture(t);
  for (const size of [2, 3, 4]) {
    const selected = targets.slice(0, size);
    const result = await f.call("trace", { targets: selected, relation: "callers", limit: 15 });
    assert.equal(result.requests.filter(r => r.operation === "pi_nav_search").length, size);
    assert.ok(result.visible.size >= size, "every target retains source meaning");
    for (const target of selected) assert.match(result.text, new RegExp(`return ${target}`));
    assert.match(result.text, /function reference/);
    assert.match(result.text, /invocation/);
    if (result.details.budgetRestart) {
      assert.equal(result.details.status, "partial");
      const limit = result.details.budgetRestart.limit;
      for (const query of result.details.queries) for (const window of query.details.presentation.pageWindows) assert.equal(window.page_size, limit);
    }
    if (size === 4) assert.ok(result.details.budgetRestart, "the four-target join exercises fitting, not just per-item checks");
  }
});

for (const name of ["trace", "explore"]) {
  test(`${name} omits oversized normalization echoes while retaining useful source`, async t => {
    const f = fixture(t, 4);
    const padding = " ".repeat(40_000);
    const params = name === "trace" ? { target: targets[0], relation: `${padding}CALLERS`, limit: 2 }
      : { view: `${padding}CODE`, operation: "search", anchor: targets[0], limit: 2 };
    const result = await f.call(name, params);
    assert.match(result.text, /Oversized normalization detail omitted; canonical arguments used/);
    assert.ok(result.visible.size > 0);
    assert.equal(result.details.envelope.status, "success");
    assert.deepEqual(result.details.callNormalizations, ["Oversized normalization detail omitted; canonical arguments used"]);
    assert.equal(result.requests.filter(r => r.operation === "pi_nav_search").length, 1);
  });
}

test("a failed Trace batch item does not prevent fitting useful siblings", async t => {
  const f = fixture(t);
  f.failTarget(targets[3]);
  const result = await f.call("trace", { targets, relation: "callers", limit: 15 });
  assert.equal(result.requests.filter(r => r.operation === "pi_nav_search").length, 4);
  assert.deepEqual(result.details.budgetRestart?.items, [1, 2, 3]);
  assert.match(result.text, /Only batch items 1, 2, 3 restarted; other entries are unchanged/);
  assert.match(result.text, /controlled unavailable target/);
  for (const target of targets.slice(0, 3)) assert.match(result.text, new RegExp(`return ${target}`));
  assert.equal(result.details.queries[3].status, "warning");
});

for (const name of ["trace", "explore"]) {
  test(`${name} revalidates admission after proof preparation, before any authority commit`, async t => {
    const f = fixture(t, 4);
    f.revokeOnProof();
    const params = name === "trace" ? { target: targets[0], relation: "callers", limit: 2 }
      : { view: "code", operation: "search", anchor: targets[0], limit: 2 };
    const result = await f.call(name, params);
    assert.match(result.text, /corpus admission changed before delivery/);
    assert.equal(result.visible.size, 0);
    assert.ok(result.requests.some(r => r.operation === "pi_nav_source_proof"), "this must exercise the post-proof race, not initial refusal");
    assert.equal(result.requests.at(-1).operation, "pi_nav_files");
  });

  test(`${name} refuses an indivisible oversized identity without granting source`, async t => {
    const f = fixture(t, 4);
    const identity = `AlphaTarget ${Array.from({ length: 2_500 }, (_, i) => `part${i}`).join("_")}`;
    assert.ok(tokens(identity) > 4_000);
    f.projections.set(identity, f.projections.get(targets[0]));
    const params = name === "trace" ? { target: identity, relation: "callers", limit: 2 }
      : { view: "code", operation: "search", anchor: identity, limit: 2 };
    const result = await f.call(name, params);
    assert.match(result.text, /withheld.*4,000-token/);
    assert.equal(result.visible.size, 0);
    assert.equal(result.requests.filter(r => r.operation === "pi_nav_search").length, 1);
    assert.equal(result.details.presentation, undefined, "withheld rows cannot escape through details");
  });
}

for (const name of ["trace", "explore"]) {
  test(`${name} retains useful captured locators when source proof fails during refit`, async t => {
    const f = fixture(t);
    f.failProofAfter(1);
    const params = name === "trace" ? { target: targets[0], relation: "callers", page: 2, limit: 80 }
      : { view: "code", operation: "search", anchor: targets[0], page: 2, limit: 80 };
    const result = await f.call(name, params);
    assert.match(result.text, /Source handoff: locator-only; exact source proof unavailable/);
    assert.match(result.text, /AlphaTargetScheduledHeartbeatCaller000/);
    assert.equal(result.visible.size, 0);
    assert.equal(result.details.envelope.status, "warning");
    assert.ok(result.requests.filter(r => r.operation === "pi_nav_source_proof").length >= 2);
    assert.equal(result.requests.filter(r => r.operation === "pi_nav_search").length, 1);
  });
}
