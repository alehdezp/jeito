import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deriveAnalysisProject } from "../src/core/analysis-project.mjs";
import { MAINTENANCE_REVISION, MAINTENANCE_STATUS_FILE } from "../native/analysis/identity.mjs";
import { registerExploreTool } from "../src/tools/explore.ts";
import { callTool, executable, registerCleanPi, tempProject, writeGraphifyFixture } from "./_clean-navigation-helper.mjs";
import { renderExploreResult, currentDensity, cycleDensity } from "../src/core/tui-render.ts";

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const plain = value => String(value).replace(ANSI_RE, "");

const runId = "99999999-9999-4999-8999-999999999999";
const statusDigest = "b".repeat(64);

/** Read-only prepared indexed graph fixture. The store mirrors what the native
 * maintenance reader publishes; these tests only prove the explore adapter reads
 * it through the injected callNative without building, adopting or repairing
 * anything. The retired prepared code graph is never consulted. */
function indexedExploreFixture(t, { files = [], store = true } = {}) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "explore-indexed-")));
  t.after(() => { try { rmSync(temporary, { recursive: true, force: true }); } catch {} });
  const root = join(temporary, "source");
  mkdirSync(root, { recursive: true });
  const indexRoot = join(temporary, "indexes");
  if (store) {
    const project = deriveAnalysisProject(root, indexRoot);
    mkdirSync(project.directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(project.directory, "graph.sqlite"), "fixture native reader owns validation", { mode: 0o600 });
    writeFileSync(join(project.directory, MAINTENANCE_STATUS_FILE), "routing hint; native stub owns validation", { mode: 0o600 });
  }
  writeFileSync(join(root, "package.json"), "{}");
  for (const path of files) {
    mkdirSync(join(root, path.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(root, path), `// fixture: ${path}\nexport const fixture = true;\n`);
  }
  const configPath = join(temporary, "automation.json");
  writeFileSync(configPath, JSON.stringify({ storage: { indexRoot } }));
  const previous = process.env.PI_NAV_AUTOMATION_CONFIG;
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
  t.after(() => { if (previous === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG; else process.env.PI_NAV_AUTOMATION_CONFIG = previous; });
  return { root, indexRoot, temporary, files };
}

function indexedNode({ id, kind = "function", name, qualifiedName, filePath, startLine = 1, endLine = 1, depth = 0, isTestFile = false }) {
  return { id, kind, name, qualifiedName, filePath, startLine, endLine, depth, isTestFile };
}

/** Injected callNative serving a prepared census plus one projection per request.
 * The stub echoes the census policy digest exactly as the shared reader expects. */
function indexedNative({ files, payload, semanticStatus = "unavailable" }) {
  const calls = [];
  const callNative = async request => {
    calls.push(request);
    if (request.operation === "pi_nav_files") {
      return { text: "", structured: { schemaVersion: 1, operation: "pi_nav_files",
        data: { root: request.root, corpusPolicyVersion: 1, files, directories: [""] }, completeness: { complete: true }, diagnostics: [] } };
    }
    assert.equal(request.operation, "pi_nav_search");
    const data = {
      mode: "analysis_projection",
      operation: request.args.analysisProjection.operation,
      query: request.args.query,
      status: payload.status ?? "ok",
      nodes: payload.nodes ?? [],
      edges: payload.edges ?? [],
      candidates: payload.candidates ?? [],
      roots: payload.roots ?? [],
      coverage: payload.coverage ?? { complete: true },
      ...(payload.selection ? { selection: payload.selection } : {}),
      analysis: { indexedRunId: runId, indexedStatusDigest: statusDigest, interpretationRevision: MAINTENANCE_REVISION,
        policyDigest: request.args.analysisPolicyDigest, scope: "project", semanticStatus: payload.semanticStatus ?? semanticStatus },
    };
    return { text: "bounded indexed projection", structured: { schemaVersion: 1, operation: "pi_nav_search", data, completeness: { complete: true }, diagnostics: [] }, sourceSnapshots: [] };
  };
  return { calls, callNative };
}

function makePi() {
  const tools = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    getActiveTools() { return []; },
    setActiveTools() {},
    tool(name) { const tool = tools.get(name); assert.ok(tool, `missing loaded tool ${name}`); return tool; },
  };
}

async function callExplore(pi, cwd, params) {
  const result = await pi.tool("explore").execute("test-explore", params, undefined, undefined, { cwd });
  return result;
}

test("explore clean-break schema exposes graph/docs/code views and rejects legacy routing", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-clean-schema-");
  const props = Object.keys(pi.tool("explore").parameters.properties).sort();
  assert.deepEqual(props, ["anchor", "depth", "kind", "limit", "operation", "page", "query", "scope", "view"]);
  assert.match(await callTool(pi, cwd, "explore", { query: "overview", path: cwd, source: "files", detail: "native" }), /INVALID CALL.*explore[\s\S]*obsolete|unknown field/i);
});

test("explore code operations reject mixed identities and return actionable invalid-call evidence before backend execution", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-operation-validation-");
  assert.match(await callTool(pi, cwd, "explore", { view: "code", operation: "search", query: "runTrace", depth: 2 }), /INVALID CALL: explore[\s\S]*uses anchor, not query/);
  assert.match(await callTool(pi, cwd, "explore", { view: "map", query: "runTrace", operation: "search" }), /INVALID CALL: explore[\s\S]*map does not accept operation[\s\S]*nothing ran/i);
  assert.match(await callTool(pi, cwd, "explore", { view: "code", operation: "search" }), /INVALID CALL: explore[\s\S]*search requires behavior vocabulary/);
  assert.match(await callTool(pi, cwd, "explore", { view: "code", operation: "architecture", anchor: "runTrace" }), /INVALID CALL: explore[\s\S]*operation must be one of/);
  assert.match(await callTool(pi, cwd, "explore", { view: "code", operation: "traverse", anchor: "runTrace", depth: 9 }), /INVALID CALL: explore[\s\S]*depth must be an integer from 1 to 6/);
  assert.match(await callTool(pi, cwd, "explore", { view: "code", operation: "analysis" }), /INVALID CALL: explore[\s\S]*operation must be one of/);
  assert.match(await callTool(pi, cwd, "explore", { view: "code", operation: "community", communityId: 7 }), /INVALID CALL: explore[\s\S]*obsolete|unknown field/i);
  assert.match(await callTool(pi, cwd, "explore", { view: "code", operation: "traverse", anchor: "runTrace", depth: 2 }), /INVALID CALL: explore[\s\S]*exact qualified symbol or exact File identity/);
  assert.match(await callTool(pi, cwd, "explore", { view: "map", anchor: "src\/tools\/explore.ts" }), /INVALID CALL: explore[\s\S]*map does not accept anchor/);
  assert.match(await callTool(pi, cwd, "explore", { view: "map", query: "runTrace", page: 0 }), /INVALID CALL: explore[\s\S]*page must be an integer from 1/);
});

test("explore code fails honestly, and calls no backend, when no indexed graph is published", async t => {
  const { root } = indexedExploreFixture(t, { store: false, files: ["src/main.ts"] });
  const { calls, callNative } = indexedNative({ files: ["src/main.ts"], payload: {} });
  const pi = makePi();
  registerExploreTool(pi, { callNative });
  const result = await callExplore(pi, root, { view: "code", operation: "search", anchor: "main", scope: root, limit: 5 });
  const text = result.content[0].text;
  assert.match(text, /UNAVAILABLE: code exploration is unavailable for this scope/);
  assert.match(text, /no published indexed code graph may be read here/);
  assert.match(text, /Use the grep tool for lexical and semantic code discovery/);
  assert.match(text, /No query-time setup, provider call, mutation or fallback navigation was used/);
  assert.equal(result.details.envelope.status, "warning");
  assert.deepEqual(calls, [], "an absent index must not issue a projection or a census");
  assert.equal(existsSync(join(root, ".pi", "navigation", "crg")), false, "query time must not create a retired graph store");
});

test("explore traverses an exact root-level File identity and preserves typed topology", async t => {
  const { root } = indexedExploreFixture(t, { files: ["index.ts"] });
  const fileNode = indexedNode({ id: "f0", kind: "file", name: "index.ts", qualifiedName: "index.ts", filePath: "index.ts", depth: 0 });
  const startNode = indexedNode({ id: "n1", name: "start", qualifiedName: "index.ts::start", filePath: "index.ts", depth: 1 });
  const { calls, callNative } = indexedNative({
    files: ["index.ts"],
    payload: {
      nodes: [fileNode, startNode], roots: ["f0"],
      edges: [{ id: 1, source: "f0", target: "n1", kind: "contains", file_path: "index.ts", line: 1, column: 1, functionReference: false }],
    },
  });
  const pi = makePi();
  registerExploreTool(pi, { callNative });
  const result = await callExplore(pi, root, { view: "code", operation: "traverse", anchor: "index.ts", depth: 1, scope: root, limit: 5 });
  const text = result.content[0].text;
  assert.match(text, /Traversal: start=index\.ts/);
  assert.match(text, /NODE depth=1 · function index\.ts::start/);
  assert.match(text, /EDGE index\.ts --contains--> index\.ts::start/);
  assert.equal(result.details.presentation.traversal.startNode, "index.ts");
  assert.equal(result.details.presentation.traversal.nodes.length, 2);
  assert.equal(result.details.native.project_navigation.backend, "indexed");
  assert.equal(result.details.native.project_navigation.generation_identity, `${runId}:${statusDigest}`);
  assert.equal((text.match(/--contains/g) ?? []).length, 1, "additive sidecars stay structured without duplicating model evidence");
  assert.deepEqual(calls.filter(call => call.operation === "pi_nav_search").map(call => call.args.analysisProjection),
    [{ operation: "traverse", depth: 1 }], "traverse must ask the indexed graph for one typed projection");
  const tui = plain(renderExploreResult(result, { expanded: false }, {}, { args: { view: "code", operation: "traverse", anchor: "index.ts" } }).render(160).join("\n"));
  assert.match(tui, /NODE d1 function index\.ts::start/);
  assert.match(tui, /EDGE index\.ts --contains--> index\.ts::start/);
});

test("explore search preserves active-mode evidence, structured sidecars, and honest locator handoff", async t => {
  const { root } = indexedExploreFixture(t, { files: ["src/matches.ts"] });
  const { callNative } = indexedNative({
    files: ["src/matches.ts"],
    payload: { nodes: [indexedNode({ id: "n9", kind: "type", name: "MatchCursorState", qualifiedName: "src/matches.ts::MatchCursorState", filePath: "src/matches.ts", startLine: 10, endLine: 24 })], semanticStatus: "available" },
  });
  const pi = makePi();
  registerExploreTool(pi, { callNative });
  const args = { view: "code", operation: "search", anchor: "cursor paging", scope: root, limit: 5 };
  const result = await callExplore(pi, root, args);
  const text = result.content[0].text;
  assert.match(text, /Search mode: hybrid · semantic \+ lexical code evidence active/);
  assert.doesNotMatch(text, /Readiness:|semantic limited|stale=/i);
  assert.doesNotMatch(text, /retrieval-rank/, "compacted agent text drops any rank float; relevance order is the signal");
  assert.match(text, /1\. type src\/matches\.ts::MatchCursorState · src\/matches\.ts:10-24/);
  assert.equal(result.details.presentation.candidates[0].start, 10);
  assert.equal(result.details.presentation.searchMode, "hybrid");
  assert.ok(result.details.native.project_navigation.page_windows.length > 0, "structured paging sidecars stay available");
  // Indexed rows are locators: the handoff must not claim current-source authority.
  assert.match(text, /Source handoff: locator-only/);
  assert.doesNotMatch(text, /\[src\/matches\.ts#[A-F0-9]{8}\]/);
});

test("explore code search excludes test candidates by default, keeps the implementation, and offers kind:\"Test\" opt-in", async t => {
  const { root } = indexedExploreFixture(t, { files: ["src/owner.ts", "tests/owner.test.ts"] });
  const implementation = indexedNode({ id: "n0", name: "owner", qualifiedName: "src/owner.ts::owner", filePath: "src/owner.ts" });
  const testCandidate = indexedNode({ id: "n1", name: "owner behavior test", qualifiedName: "tests/owner.test.ts::owner behavior test", filePath: "tests/owner.test.ts", depth: 1, isTestFile: true });
  const files = ["src/owner.ts", "tests/owner.test.ts"];
  const excluded = indexedNative({ files, payload: { nodes: [testCandidate, implementation], roots: ["n0"] } });
  const pi = makePi();
  registerExploreTool(pi, { callNative: excluded.callNative });
  const result = await callExplore(pi, root, { view: "code", operation: "search", anchor: "owner behavior", scope: root, limit: 5 });
  assert.deepEqual(result.details.presentation.candidates.map(item => item.kind), ["function"]);
  assert.match(result.content[0].text, /1\. function .*owner/);
  assert.doesNotMatch(result.content[0].text, /\d+\. function .*owner behavior test/);
  assert.match(result.content[0].text, /1 test candidate\(s\) excluded from the default retrieve/);
  assert.match(result.content[0].text, /pass kind:"Test" to include/);
  // kind:"Test" opts back in and the test candidate returns.
  const optedIn = await callExplore(pi, root, { view: "code", operation: "search", anchor: "owner behavior", scope: root, limit: 5, kind: "Test" });
  assert.deepEqual(optedIn.details.presentation.candidates.map(item => item.kind), ["function", "function"]);
  assert.match(optedIn.content[0].text, /1\. function tests\/owner\.test\.ts::owner behavior test/);
  assert.doesNotMatch(optedIn.content[0].text, /excluded from the default retrieve/);
});

test("explore code search does not advertise an excluded test as a visible continuation page", async t => {
  const implementations = Array.from({ length: 8 }, (_, index) => indexedNode({
    id: `n${index}`, name: `owner${index}`, qualifiedName: `src/owner-${index}.ts::owner${index}`, filePath: `src/owner-${index}.ts`,
  }));
  const files = [...implementations.map(node => node.filePath), "tests/owner.test.ts"];
  const { root } = indexedExploreFixture(t, { files });
  const testCandidate = indexedNode({ id: "t0", name: "owner test", qualifiedName: "tests/owner.test.ts::owner test", filePath: "tests/owner.test.ts", depth: 1, isTestFile: true });
  const { callNative } = indexedNative({ files, payload: { nodes: [testCandidate, ...implementations], roots: ["n0"] } });
  const pi = makePi();
  registerExploreTool(pi, { callNative });

  const first = await callExplore(pi, root, { view: "code", operation: "search", anchor: "owner", scope: root, limit: 8 });
  assert.equal(first.details.presentation.candidates.length, 8);
  assert.equal(first.details.presentation.nextPage, undefined);
  assert.doesNotMatch(first.content[0].text, /page for more|next_page=2/);

  const empty = await callExplore(pi, root, { view: "code", operation: "search", anchor: "owner", scope: root, limit: 8, page: 2 });
  assert.equal(empty.details.presentation.candidates.length, 0);
  assert.doesNotMatch(empty.content[0].text, /Expanded live source|\[[^\]#]+#[A-F0-9]{8}\]/);
});

test("explore code search retains test-only results as disclosed subsystem evidence", async t => {
  const files = ["tests/owner.test.ts"];
  const { root } = indexedExploreFixture(t, { files });
  const first = indexedNode({ id: "t1", name: "owner behavior test", qualifiedName: "tests/owner.test.ts::owner behavior test", filePath: "tests/owner.test.ts", isTestFile: true });
  const second = indexedNode({ id: "t2", name: "owner edge test", qualifiedName: "tests/owner.test.ts::owner edge test", filePath: "tests/owner.test.ts", isTestFile: true });
  const { callNative } = indexedNative({ files, payload: { nodes: [first, second], roots: ["t1"] } });
  const pi = makePi();
  registerExploreTool(pi, { callNative });
  const result = await callExplore(pi, root, { view: "code", operation: "search", anchor: "owner behavior", scope: root, limit: 5 });
  assert.deepEqual(result.details.presentation.candidates.map(item => item.kind), ["function", "function"]);
  assert.equal(result.details.native.project_navigation.test_only_results_retained, true);
  assert.match(result.content[0].text, /retained because no non-test implementation candidate was returned/);
  assert.match(result.content[0].text, /refine with returned vocabulary before treating a test as the owner/);
});

test("explore traversal orders edges by relevance to the exact start identity", async t => {
  const files = ["src/owner.ts", "src/caller.ts", "src/remote.ts"];
  const { root } = indexedExploreFixture(t, { files });
  const owner = indexedNode({ id: "n0", name: "owner", qualifiedName: "src/owner.ts::owner", filePath: "src/owner.ts", depth: 0 });
  const caller = indexedNode({ id: "n1", name: "caller", qualifiedName: "src/caller.ts::caller", filePath: "src/caller.ts", depth: 1 });
  const remote = indexedNode({ id: "n2", name: "remote", qualifiedName: "src/remote.ts::remote", filePath: "src/remote.ts", depth: 2 });
  const { callNative } = indexedNative({
    files,
    payload: {
      nodes: [owner, caller, remote], roots: ["n0"],
      edges: [
        { id: 1, source: "n2", target: "n1", kind: "call", file_path: "src/remote.ts", line: 3, column: 1, functionReference: false },
        { id: 2, source: "n0", target: "n1", kind: "call", file_path: "src/owner.ts", line: 1, column: 1, functionReference: false },
      ],
    },
  });
  const pi = makePi();
  registerExploreTool(pi, { callNative });
  const result = await callExplore(pi, root, { view: "code", operation: "traverse", anchor: "src/owner.ts::owner", depth: 2, scope: root, limit: 5 });
  assert.equal(result.details.presentation.traversal.edges[0].source, "src/owner.ts::owner");
  assert.equal(result.details.presentation.traversal.edges[0].target, "src/caller.ts::caller");
  assert.equal(result.details.native.project_navigation.edge_order, "traversal_relevance");
});

test("explore lexical mode remains successful prepared evidence without readiness deterrents", async t => {
  const files = ["src/refresh.ts"];
  const { root } = indexedExploreFixture(t, { files });
  const { callNative } = indexedNative({
    files,
    payload: { nodes: [indexedNode({ id: "n0", name: "refreshOwner", qualifiedName: "src/refresh.ts::refreshOwner", filePath: "src/refresh.ts", startLine: 3, endLine: 8 })], roots: ["n0"], semanticStatus: "unavailable" },
  });
  const pi = makePi();
  registerExploreTool(pi, { callNative });
  const args = { view: "code", operation: "search", anchor: "refresh owner", scope: root, limit: 5 };
  const result = await callExplore(pi, root, args);
  assert.equal(result.details.envelope.status, "success");
  assert.match(result.content[0].text, /Status: ok/);
  assert.match(result.content[0].text, /Search mode: lexical · lexical code evidence active/);
  assert.doesNotMatch(result.content[0].text, /Status: degraded|Readiness:|semantic limited|stale=/i);
  const normal = plain(renderExploreResult(result, { expanded: false }, {}, { args }).render(180).join("\n"));
  assert.match(normal, /refreshOwner/);
});

test("explore map uses Graphify with query logging disabled and no lexical fallback", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-clean-graph-");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "main.ts"), "export const main = 1;\n");
  await writeGraphifyFixture(cwd);
  const text = await callTool(pi, cwd, "explore", { query: "fixture", view: "map", scope: cwd });
  assert.match(text, /Graph map|★?fixture src\/main\.ts:1/);
  assert.match(text, /★?fixture src\/main\.ts:1/);
  assert.doesNotMatch(text, /grep|find/i);
  assert.doesNotMatch(text, /Live source authority|\[src\/main\.ts#[0-9A-F]{8}\]/, "graph nodes remain locators and never trigger a source dump");
});

test("explore promotes genuinely emitted top-level exact source rows but not broad graph nodes", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-exact-row-");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "main.ts"), "export const main = 1;\n");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node\nconsole.log(JSON.stringify({ nodes:[{path:'src/main.ts',line:1,label:'main'}], sourceRows:[{path:'src/main.ts',line:1,text:'export const main = 1;',visibility:'visible_complete',transformation:'verbatim'}] }));\n`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));
  const text = await callTool(pi, cwd, "explore", { query: "main", view: "map", scope: cwd });
  assert.match(text, /Live source authority[\s\S]*\[src\/main\.ts#[0-9A-F]{8}\]/);
});

test("written-project questions use docs_search, not explore view aliases", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-clean-docs-");
  assert.match(await callTool(pi, cwd, "explore", { query: "fixture", view: "docs", scope: cwd }), /INVALID CALL: explore[\s\S]*view must be one of/);
  const text = await callTool(pi, cwd, "docs_search", { query: "fixture", scope: cwd });
  assert.match(text, /UNAVAILABLE|QMD|docs/i);
});

test("explore fails closed when the requested prepared lane is missing", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-clean-missing-");
  const text = await callTool(pi, cwd, "explore", { query: "anything", view: "map", scope: cwd });
  assert.match(text, /UNAVAILABLE: graph map unavailable/);
  assert.match(text, /No query-time setup|no fallback/i);
});

test("explore density cycling does not change the indexed candidate meaning", async t => {
  const files = ["src/owner.ts"];
  const { root } = indexedExploreFixture(t, { files });
  const { callNative } = indexedNative({ files, payload: { nodes: [indexedNode({ id: "n0", name: "owner", qualifiedName: "src/owner.ts::owner", filePath: "src/owner.ts" })], roots: ["n0"] } });
  const pi = makePi();
  registerExploreTool(pi, { callNative });
  const args = { view: "code", operation: "search", anchor: "owner", scope: root, limit: 5 };
  const result = await callExplore(pi, root, args);
  const priorDensity = currentDensity();
  t.after(() => { for (let i = 0; i < 4 && currentDensity() !== priorDensity; i++) cycleDensity(); });
  for (const density of ["normal", "extended"]) {
    for (let i = 0; i < 4 && currentDensity() !== density; i++) cycleDensity();
    const rendered = plain(renderExploreResult(result, { expanded: false }, {}, { args }).render(180).join("\n"));
    assert.match(rendered, /owner/, density);
  }
});
