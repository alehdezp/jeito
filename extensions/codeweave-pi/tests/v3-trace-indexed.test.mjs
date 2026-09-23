import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deriveAnalysisProject } from "../src/core/analysis-project.mjs";
import { MAINTENANCE_REVISION, MAINTENANCE_STATUS_FILE } from "../native/analysis/identity.mjs";
import { registerTraceTool } from "../src/tools/trace.ts";

function makePi() {
  const tools = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    getActiveTools() { return []; },
    setActiveTools() {},
    tool(name) { const found = tools.get(name); assert.ok(found); return found; },
  };
}

async function call(pi, cwd, params) {
  const result = await pi.tool("trace").execute("trace", params, undefined, undefined, { cwd });
  return {
    text: result.content.map(part => part.type === "text" ? part.text : "").join("\n"),
    details: result.details,
  };
}

// Read-only prepared indexed graph fixture. The store mirrors what the native
// maintenance reader publishes; this test only proves the trace adapter reads
// it (and the injected callNative) without mutating or adopting anything.
function fixture(t, { files, store = true } = {}) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-trace-indexed-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
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
  for (const path of files ?? []) {
    const absolute = join(root, path);
    mkdirSync(join(root, path.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(absolute, `// fixture: ${path}\nexport const fixture = true;\n`);
  }
  const configPath = join(temporary, "automation.json");
  writeFileSync(configPath, JSON.stringify({ storage: { indexRoot } }));
  const previous = process.env.PI_NAV_AUTOMATION_CONFIG;
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
  t.after(() => { if (previous === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG; else process.env.PI_NAV_AUTOMATION_CONFIG = previous; });
  return { root, indexRoot, temporary };
}

const runId = "99999999-9999-4999-8999-999999999999";
const statusDigest = "b".repeat(64);

function n({ id, kind = "function", name, qualifiedName, filePath, startLine = 1, endLine = 1, isTestFile = false }) {
  return { id, kind, name, qualifiedName, filePath, startLine, endLine, depth: 1, isTestFile };
}

// Injected callNative serving a prepared census plus a caller/callees/tests
// projection. The native reads the fixture database identity back from the
// request and echoes the census policy digest exactly as the shared reader
// expects, mirroring the analysis-project bridge fixture.
function indexedNative({ files, projectionByOperation, status = "ok" }) {
  const calls = [];
  const callNative = async request => {
    calls.push(request);
    if (request.operation === "pi_nav_files") {
      return { text: "", structured: { schemaVersion: 1, operation: "pi_nav_files",
        data: { root: request.root, corpusPolicyVersion: 1, files, directories: [""] }, completeness: { complete: true }, diagnostics: [] } };
    }
    assert.equal(request.operation, "pi_nav_search");
    const requested = request.args.analysisProjection;
    const projection = projectionByOperation(requested);
    assert.deepEqual(requested, projection.projection);
    const data = {
      mode: "analysis_projection",
      operation: requested.operation,
      query: request.args.query,
      status,
      nodes: projection.nodes ?? [],
      edges: projection.edges ?? [],
      candidates: projection.candidates ?? [],
      roots: projection.roots ?? [],
      coverage: { complete: true },
      analysis: {
        indexedRunId: runId,
        indexedStatusDigest: statusDigest,
        interpretationRevision: MAINTENANCE_REVISION,
        policyDigest: request.args.analysisPolicyDigest,
        scope: "project",
        semanticStatus: "unavailable",
      },
    };
    return { text: "bounded indexed projection", structured: { schemaVersion: 1, operation: "pi_nav_search", data, completeness: { complete: true }, diagnostics: [] }, sourceSnapshots: [] };
  };
  return { calls, callNative };
}

test("indexed callers renders caller rows, excludes the queried root, and labels invocations vs function references", async t => {
  const pi = makePi();
  const { root } = fixture(t, { files: ["src/lib.ts", "src/a.ts", "src/b.ts"] });
  const target = n({ id: "n0", name: "Target", qualifiedName: "src/lib.ts::Target", filePath: "src/lib.ts" });
  const callerA = n({ id: "n1", name: "A", qualifiedName: "src/a.ts::A", filePath: "src/a.ts", startLine: 2, endLine: 5 });
  const callerB = n({ id: "n2", name: "B", qualifiedName: "src/b.ts::B", filePath: "src/b.ts", startLine: 2, endLine: 2 });
  const { calls, callNative } = indexedNative({
    files: ["src/lib.ts", "src/a.ts", "src/b.ts"],
    projectionByOperation: () => ({
      projection: { operation: "callers" },
      operation: "callers",
      nodes: [target, callerA, callerB],
      roots: ["n0"],
      edges: [
        { id: 1, source: "n1", target: "n0", kind: "call", file_path: "src/a.ts", line: 2, column: 1, functionReference: false },
        // two parallel edges on the same line: one invocation, one function reference
        { id: 2, source: "n1", target: "n0", kind: "call", file_path: "src/a.ts", line: 3, column: 1, functionReference: false },
        { id: 3, source: "n1", target: "n0", kind: "call", file_path: "src/a.ts", line: 3, column: 9, functionReference: true },
        { id: 5, source: "n1", target: "n0", kind: "calls", line: 3, column: 17, functionReference: false },
        { id: 4, source: "n2", target: "n0", kind: "call", file_path: "src/b.ts", line: 2, column: 1, functionReference: false },
      ],
    }),
  });
  registerTraceTool(pi, { callNative });
  const { text, details } = await call(pi, root, { target: "Target", relation: "callers", scope: root });
  assert.equal(details.envelope.status, "success");
  // The queried root is excluded from the result rows.
  assert.doesNotMatch(text, /src\/lib\.ts::Target/);
  assert.match(text, /src\/a\.ts:3/);
  assert.match(text, /src\/b\.ts:2/);
  // Function reference and invocation labels are preserved alongside the
  // same-line parallel edges (src/a.ts:3 appears twice, distinctly labelled).
  assert.match(text, /function reference/);
  assert.match(text, /invocation/);
  assert.match(text, /src\/a\.ts:3 col0=1/);
  assert.match(text, /src\/a\.ts:3 col0=17/, "two invocations on one line remain distinct");
  assert.match(text, new RegExp(`Generation: ${runId}:${statusDigest}`));
  assert.ok(calls.some(call => call.operation === "pi_nav_search"));
});

test("indexed trace with a missing store falls through to the existing native route without fabricating an indexed answer", async t => {
  // No maintenance status file and no graph.sqlite: callIndexedGraphNavigation
  // returns undefined, so runCodeTrace must keep the ordinary CRG/native path.
  const pi = makePi();
  const { root } = fixture(t, { store: false, files: ["src/lib.ts"] });
  let searchCalls = 0;
  registerTraceTool(pi, { callNative: async request => {
    if (request.operation === "pi_nav_files") throw new Error("indexed census must not run for a missing store");
    searchCalls++;
    return {
      text: "live native answer",
      structured: { status: "ok", summary: "live", data: { locations: [{ path: "src/lib.ts", start: 1, end: 1, role: "usage" }] }, diagnostics: [], completeness: { complete: true } },
      sourceSnapshots: [],
    };
  } });
  const { text, details } = await call(pi, root, { target: "Target", relation: "callers", scope: root });
  // The result is the live native route, not a fabricated indexed projection.
  assert.match(details.envelope.summary, /Native code callers|callers returned relationship context/i);
  assert.ok(searchCalls >= 1);
});

test("indexed trace reports ambiguous projections as qualification-required, not fabricated rows", async t => {
  const pi = makePi();
  const { root } = fixture(t, { files: ["src/lib.ts", "src/a.ts"] });
  const target = n({ id: "n0", name: "Target", qualifiedName: "src/lib.ts::Target", filePath: "src/lib.ts" });
  const { callNative } = indexedNative({
    files: ["src/lib.ts", "src/a.ts"],
    status: "ambiguous",
    projectionByOperation: () => ({
      projection: { operation: "callers" },
      nodes: [target, n({ id: "n1", name: "SameName", qualifiedName: "src/a.ts::SameName", filePath: "src/a.ts", startLine: 1, endLine: 1 })],
      candidates: [
        { ...target, retry_target: "src/lib.ts::Target" },
        { id: "c2", kind: "function", name: "SameName", qualifiedName: "src/a.ts::SameName", filePath: "src/a.ts", startLine: 1, endLine: 1,
          file_path: "src/a.ts", line_start: 1, line_end: 1, retry_target: "src/a.ts::SameName" },
      ],
      roots: ["n0"],
    }),
  });
  registerTraceTool(pi, { callNative });
  const { text, details } = await call(pi, root, { target: "Target", relation: "callers", scope: root });
  assert.equal(details.envelope.status, "warning");
  assert.match(text, /qualification required|exact qualified identity/i);
  // No fabricated relation rows are claimed for an ambiguous identity.
  assert.doesNotMatch(text, /function reference|invocation/);
});

test("indexed callers page 2 emits slicing windows and the runId:statusDigest generation label", async t => {
  const pi = makePi();
  const { root } = fixture(t, { files: ["src/lib.ts", "src/a.ts", "src/b.ts", "src/c.ts"] });
  const target = n({ id: "n0", name: "Target", qualifiedName: "src/lib.ts::Target", filePath: "src/lib.ts" });
  const callerA = n({ id: "n1", name: "A", qualifiedName: "src/a.ts::A", filePath: "src/a.ts", startLine: 2, endLine: 2 });
  const callerB = n({ id: "n2", name: "B", qualifiedName: "src/b.ts::B", filePath: "src/b.ts", startLine: 2, endLine: 2 });
  const callerC = n({ id: "n3", name: "C", qualifiedName: "src/c.ts::C", filePath: "src/c.ts", startLine: 2, endLine: 2 });
  const { callNative } = indexedNative({
    files: ["src/lib.ts", "src/a.ts", "src/b.ts", "src/c.ts"],
    projectionByOperation: () => ({
      projection: { operation: "callers" },
      nodes: [target, callerA, callerB, callerC],
      roots: ["n0"],
      edges: [
        { id: 1, source: "n1", target: "n0", kind: "call", file_path: "src/a.ts", line: 2, column: 1, functionReference: false },
        { id: 2, source: "n2", target: "n0", kind: "call", file_path: "src/b.ts", line: 2, column: 1, functionReference: false },
        { id: 3, source: "n3", target: "n0", kind: "call", file_path: "src/c.ts", line: 2, column: 1, functionReference: false },
      ],
    }),
  });
  registerTraceTool(pi, { callNative });
  // limit 1 page 2 -> only the second caller row is sliced onto this page.
  const { text, details } = await call(pi, root, { target: "Target", relation: "callers", scope: root, page: 2, limit: 1 });
  assert.equal(details.envelope.status, "success");
  assert.match(text, /page 2/);
  assert.match(text, new RegExp(`Generation: ${runId}:${statusDigest}`));
  const windows = details.presentation.pageWindows ?? [];
  assert.ok(windows.length > 0);
  const primary = windows.find((window) => window && window.path === "edges" || window && window.path === "results") ?? windows[0];
  assert.equal(primary.page, 2);
  assert.ok(primary.omitted_before > 0, "page 2 must report the rows omitted on earlier pages");
  assert.doesNotMatch(text, /page 1/);
});

test("indexed tests request one indirect caller hop and filter native test-file candidates, not coverage", async t => {
  const pi = makePi();
  const { root } = fixture(t, { files: ["src/lib.ts", "src/lib.test.ts", "src/other.ts"] });
  const target = n({ id: "n0", name: "Target", qualifiedName: "src/lib.ts::Target", filePath: "src/lib.ts" });
  const testFile = n({ id: "n1", name: "Behavior", qualifiedName: "src/lib.test.ts::Behavior", filePath: "src/lib.test.ts", startLine: 4, endLine: 6, isTestFile: true });
  const other = n({ id: "n2", name: "Other", qualifiedName: "src/other.ts::Other", filePath: "src/other.ts", startLine: 2, endLine: 2 });
  const { callNative } = indexedNative({
    files: ["src/lib.ts", "src/lib.test.ts", "src/other.ts"],
    projectionByOperation: () => ({
      projection: { operation: "callers", depth: 2 },
      nodes: [target, testFile, other],
      roots: ["n0"],
      edges: [
        { id: 1, source: "n1", target: "n2", kind: "calls", file_path: "src/lib.test.ts", line: 5, column: 1, functionReference: false },
        { id: 2, source: "n2", target: "n0", kind: "call", file_path: "src/other.ts", line: 2, column: 1, functionReference: false },
      ],
    }),
  });
  registerTraceTool(pi, { callNative });
  const { text, details } = await call(pi, root, { target: "Target", relation: "tests", scope: root });
  assert.equal(details.envelope.status, "success");
  // A test calling the helper is retained; the non-test helper is not a test.
  assert.match(text, /src\/lib\.test\.ts/);
  assert.match(text, /Test file candidates|test-file candidate/i);
  // A non-test caller (src/other.ts) is not reported as a test candidate.
  assert.doesNotMatch(text, /src\/other\.ts/);
});