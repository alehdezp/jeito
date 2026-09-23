import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import jeitoCodeweavePiExtension from "../index.ts";

function makePi() {
  const tools = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    getActiveTools() { return []; },
    setActiveTools() {},
    tool(name) { const tool = tools.get(name); assert.ok(tool, `missing ${name}`); return tool; },
  };
}

async function call(pi, cwd, name, params) {
  const result = await pi.tool(name).execute(`scan-${name}`, params, undefined, undefined, { cwd });
  return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

async function executable(file, content) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  await chmod(file, 0o755);
  return file;
}

test("clean-break navigation rejects lexical/path fallback fields", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-nav-scan-clean-"));
  await writeFile(join(cwd, "README.md"), "# Fixture\n");

  assert.match(await call(pi, cwd, "explore", { query: "overview", path: cwd, detail: "diagnostic" }), /INVALID CALL: explore[\s\S]*nothing ran/i);
  assert.match(await call(pi, cwd, "trace", { target: "x", relation: "callers", path: cwd, budget: 5 }), /INVALID CALL: trace[\s\S]*nothing ran/i);
  const text = await call(pi, cwd, "explore", { query: "overview", view: "map", scope: cwd });
  assert.match(text, /UNAVAILABLE: graph map unavailable/);
  assert.doesNotMatch(text, /README\.md/);
  assert.match(text, /No query-time setup|no fallback/i);
});

test("public documentation boundary exposes docs_search without legacy actions", () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const tool = pi.tool("docs_search");
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["glob", "limit", "page", "path", "query", "scope"]);
  assert.equal(Object.hasOwn(tool.parameters.properties, "action"), false);
  assert.throws(() => pi.tool("docs"), /missing docs/);
});

test("Graphify trace disables query logging and preserves native signal", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-nav-graph-clean-"));
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node\nif (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') process.exit(9);\nconsole.log('EDGE A -> B [src=src/a.ts loc=L1]');\n`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));
  await mkdir(join(cwd, ".pi", "navigation"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { graph: { root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json", updatedAt: new Date().toISOString() } } }));

  const text = await call(pi, cwd, "trace", { target: "A", relation: "explain", scope: cwd });
  assert.match(text, /Graph explain/);
  assert.match(text, /EDGE A -> B/);
});

test("trace callers uses bundled pi-nav when CRG is unavailable", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-nav-native-clean-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "main.ts"), "export function main() {}\n");
  await writeFile(join(cwd, "src", "entry.ts"), "import { main } from './main.js';\nmain();\n");

  const text = await call(pi, cwd, "trace", { target: "main", relation: "callers", scope: cwd });
  assert.match(text, /# Callers of "main"/);
  assert.match(text, /src\/entry\.ts/);
  assert.doesNotMatch(text, /grep\(|find\(/i);
});
