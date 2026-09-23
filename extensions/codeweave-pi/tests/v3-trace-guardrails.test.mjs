import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import jeitoCodeweavePiExtension from "../index.ts";
import { registerTraceTool } from "../src/tools/trace.ts";
import { extensionRuntimePaths, setExtensionRuntimeRootForTests } from "../src/core/owned-runtime.ts";

function makePi() { const tools = new Map(); return { registerTool(t) { tools.set(t.name, t); }, on() {}, getActiveTools() { return []; }, setActiveTools() {}, tool(n) { const t = tools.get(n); assert.ok(t); return t; } }; }
async function call(pi, cwd, params) { const r = await pi.tool("trace").execute("trace", params, undefined, undefined, { cwd }); return r.content.map(p => p.type === "text" ? p.text : "").join("\n"); }
async function executable(file, content) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); await chmod(file, 0o755); return file; }

test("trace schema is clean-break and rejects legacy params", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  assert.deepEqual(Object.keys(pi.tool("trace").parameters.properties).sort(), ["limit", "page", "relation", "scope", "target", "targets", "to"]);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-clean-schema-"));
  assert.match(await call(pi, cwd, { target: "main", relation: "callers", path: cwd, detail: "native", budget: 10 }), /INVALID CALL: trace[\s\S]*(?:obsolete|unknown field)/i);
  assert.match(await call(pi, cwd, { target: "main", relation: "impact", scope: cwd }), /INVALID CALL: trace[\s\S]*relation must be one of/);
  assert.match(await call(pi, cwd, { target: "main", relation: "imports", scope: cwd }), /INVALID CALL: trace[\s\S]*imports requires a concrete file path/);
  assert.match(await call(pi, cwd, { target: "src\/main.ts", relation: "callers", scope: cwd }), /INVALID CALL: trace[\s\S]*callers requires a bare or qualified symbol/);
});

test("trace callers uses bundled pi-nav when the prepared code graph is absent", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-clean-native-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "main.ts"), "export function main() {}\n");
  await writeFile(join(cwd, "src", "entry.ts"), "import { main } from './main.js';\nmain();\n");

  const text = await call(pi, cwd, { target: "main", relation: "callers", scope: cwd });
  assert.match(text, /# Callers of "main"/);
  assert.match(text, /src\/entry\.ts/);
  assert.equal(existsSync(join(cwd, ".code-review-graph", "graph.db")), false, "trace must not build a prepared graph before using bundled pi-nav");
});

// The retired prepared-graph integration left stores and `.pi-navigation.json`
// architecture bindings on disk in existing projects. None of them may be read,
// executed or repaired: the live native route answers unchanged.
test("a retired prepared-graph store is inert: no backend command runs and the native route answers", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-retired-store-"));
  await mkdir(join(cwd, ".code-review-graph"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, ".code-review-graph", "graph.db"), "retired store\n");
  await writeFile(join(cwd, "src", "main.ts"), "export function main() {}\n");
  await writeFile(join(cwd, "src", "entry.ts"), "import { main } from './main.js';\nmain();\n");
  const probe = join(cwd, "backend-was-invoked");
  // If any code path still resolved the configured prepared-graph command, this
  // executable would leave the marker behind.
  const retiredBackend = await executable(join(cwd, "bin", "retired-backend"), `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(probe)}, 'invoked\\n');\nconsole.log(JSON.stringify({ results: [] }));\n`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({
    architecture: { enabled: true, backend: "code-review-graph", command: retiredBackend, python: process.execPath,
      root: ".", indexPath: ".code-review-graph/graph.db", embeddingProvider: "local", embeddingModel: "fixture", daemon: { enabled: true } },
  }, null, 2));

  const text = await call(pi, cwd, { target: "main", relation: "callers", scope: cwd });
  assert.match(text, /# Callers of "main"/);
  assert.match(text, /src\/entry\.ts/);
  assert.equal(existsSync(probe), false, "no retired backend command may be executed");
  assert.equal(existsSync(join(cwd, ".pi", "navigation", "crg")), false, "query time must not create a retired graph store");
  assert.doesNotMatch(text, /UNAVAILABLE: native structural trace does not support/);
});

test("trace batches homogeneous targets in order and preserves per-target status", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-batch-native-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "main.ts"), "export function alpha() {}\nexport function beta() {}\n");
  await writeFile(join(cwd, "src", "entry.ts"), "import { alpha, beta } from './main.js';\nalpha();\nbeta();\n");
  const result = await pi.tool("trace").execute("trace-batch", { targets: ["alpha", "beta"], relation: "callers", scope: cwd, limit: 5 }, undefined, undefined, { cwd });
  assert.equal(result.details.status, "success");
  assert.deepEqual(result.details.queries.map(item => item.target), ["alpha", "beta"]);
  assert.equal(result.details.presentation.kind, "trace-batch");
  assert.match(result.content[0].text, /## 1\. alpha \[success\]/);
  assert.match(result.content[0].text, /## 2\. beta \[success\]/);
  assert.match(result.content[0].text, /src\/entry\.ts/);
});

test("trace rejects malformed or duplicate batches without executing implicit work", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-strict-batch-"));
  for (const params of [
    { targets: ["alpha"], relation: "callers", scope: cwd },
    { targets: ["alpha", "alpha", "beta"], relation: "callers", scope: cwd },
    { targets: "alpha", relation: "callers", scope: cwd },
  ]) assert.match(await call(pi, cwd, params), /INVALID CALL: trace/);
});

test("trace batch keeps successful siblings when one target fails", async () => {
  const pi = makePi();
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-batch-partial-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "entry.ts"), "alpha();\n");
  registerTraceTool(pi, { callNative: async request => {
    if (request.args.query === "beta") throw new Error("synthetic beta failure");
    return {
      text: "alpha relationship",
      structured: { status: "ok", summary: "alpha result", data: { locations: [{ path: "src/entry.ts", start: 1, end: 1, role: "usage" }] }, diagnostics: [], completeness: { complete: true } },
      sourceSnapshots: [],
    };
  } });
  const result = await pi.tool("trace").execute("trace-batch-partial", { targets: ["alpha", "beta"], relation: "callers", scope: cwd }, undefined, undefined, { cwd });
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.envelope.status, "warning");
  assert.deepEqual(result.details.queries.map(item => item.status), ["success", "error"]);
  assert.match(result.content[0].text, /alpha relationship/);
  assert.match(result.content[0].text, /synthetic beta failure/);
});

test("trace uses only native routes that provide the requested structural evidence", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-clean-native-shapes-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "main.ts"), "export function main() {}\n");
  await writeFile(join(cwd, "src", "entry.ts"), "import { main } from './main.js';\nmain();\n");

  const callers = await call(pi, cwd, { target: "main", relation: "callers", scope: cwd });
  const callees = await call(pi, cwd, { target: "main", relation: "callees", scope: cwd });
  const imports = await call(pi, cwd, { target: "src/main.ts", relation: "imports", scope: cwd });
  const importers = await call(pi, cwd, { target: "src/main.ts", relation: "importers", scope: cwd });
  const tests = await call(pi, cwd, { target: "main", relation: "tests", scope: cwd });

  assert.match(callers, /src\/entry\.ts/);
  assert.match(await call(pi, cwd, { target: join(cwd, "src", "main.ts"), relation: "file_summary", scope: cwd }), /INVALID CALL: trace[\s\S]*relation must be one of/);
  assert.match(callees, /does not support relation "callees"/);
  assert.match(imports, /Selected native imports|typed_dependency_direction=imports/);
  assert.match(importers, /src\/entry\.ts|typed_dependency_direction=importers/);
  assert.match(tests, /Selected native tests|typed_test_candidates=test_like_paths_only/);
  assert.doesNotMatch([callers, callees, imports, importers, tests].join("\n"), /install|--edit/);
});

test("explore removes architecture and inventory operations from the public entry surface", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-explore-internal-ops-"));
  for (const operation of ["architecture", "communities", "flows", "analysis"]) {
    const result = await pi.tool("explore").execute("x", { view: "code", operation, scope: cwd }, undefined, undefined, { cwd });
    assert.match(result.content[0].text, /INVALID CALL: explore[\s\S]*operation must be one of/);
  }
});

test("trace removes file_summary from the public relation surface", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-filesummary-removed-"));
  assert.match(await call(pi, cwd, { target: "src/main.ts", relation: "file_summary", scope: cwd }), /INVALID CALL: trace[\s\S]*relation must be one of/);
});

test("code_context is absent from the public tool surface", () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  assert.throws(() => pi.tool("code_context"));
});

test("trace path/explain uses the extension-owned Graphify runtime and disables query logging", async t => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-clean-graph-"));
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  setExtensionRuntimeRootForTests(join(cwd, ".runtime"));
  t.after(() => setExtensionRuntimeRootForTests());
  const paths = extensionRuntimePaths();
  await executable(paths.graphify, `#!/usr/bin/env node\nif (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') process.exit(5);\nconsole.log('PATH A -> B [src=src/main.ts loc=L1]');\n`);
  await executable(paths.python, "#!/bin/sh\nexit 0\n");
  await writeFile(paths.ready, "ready\n");
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));

  const text = await call(pi, cwd, { target: "A", relation: "path", to: "B", scope: cwd });
  assert.match(text, /Graph path/);
  assert.match(text, /PATH A -> B/);
});

test("trace path preserves native graph ambiguity warnings on successful output", async t => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-graph-warning-"));
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  setExtensionRuntimeRootForTests(join(cwd, ".runtime"));
  t.after(() => setExtensionRuntimeRootForTests());
  const paths = extensionRuntimePaths();
  await executable(paths.graphify, `#!/usr/bin/env node\nconsole.error('warning: source match was ambiguous');\nconsole.log('Shortest path (1 hop): A --rel--> B [src=src/main.ts loc=L1]');\n`);
  await executable(paths.python, "#!/bin/sh\nexit 0\n");
  await writeFile(paths.ready, "ready\n");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "main.ts"), "export const main = true;\n");
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));

  const text = await call(pi, cwd, { target: "A", relation: "path", to: "B", scope: cwd });
  assert.match(text, /warning: source match was ambiguous/);
  assert.match(text, /Shortest path/);
  assert.match(text, /src\/main\.ts/);
});


