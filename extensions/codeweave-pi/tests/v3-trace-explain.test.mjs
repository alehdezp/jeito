import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import jeitoCodeweavePiExtension from "../index.ts";
import { publishOwnedGraphifyFixture } from "./_clean-navigation-helper.mjs";

function makePi() { const tools = new Map(); return { registerTool(t) { tools.set(t.name, t); }, on() {}, getActiveTools() { return []; }, setActiveTools() {}, tool(n) { const t = tools.get(n); assert.ok(t); return t; } }; }
async function call(pi, cwd, params) { const r = await pi.tool("trace").execute("trace", params, undefined, undefined, { cwd }); return r.content.map(p => p.type === "text" ? p.text : "").join("\n"); }
async function executable(file, content) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); await chmod(file, 0o755); if (basename(file).startsWith("graphify")) await publishOwnedGraphifyFixture(dirname(dirname(file)), file); return file; }

test("trace explain rejects legacy shape and fails closed without graph", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-explain-clean-"));
  const invalidText = await call(pi, cwd, { target: "Node", relation: "explain", path: cwd, budget: 10 });
  assert.match(invalidText, /INVALID CALL|obsolete|path|budget/i, "legacy fields should be rejected");
  const text = await call(pi, cwd, { target: "Node", relation: "explain", scope: cwd });
  assert.match(text, /UNAVAILABLE: graph trace unavailable/);
  assert.match(text, /No query-time setup|no fallback/i);
});

test("trace explain uses configured Graphify graph with query logging disabled", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-explain-graph-"));
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await mkdir(join(cwd, "docs"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  await writeFile(join(cwd, "docs", "node.md"), ["# Node", "", "body"].join("\n"));
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node\nif (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') process.exit(8);\nconsole.log('Node: Node\\n  Source: docs/node.md L3');\n`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));
  const text = await call(pi, cwd, { target: "Node", relation: "explain", scope: cwd });
  assert.match(text, /Graph explain/);
  assert.match(text, /Source: docs\/node\.md L3/);
  assert.match(text, /Exact follow-up selectors[\s\S]*docs\/node\.md:3/);
});

test("trace path preserves bare file nodes in native graph context without broad file-start handoffs", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-path-handoffs-"));
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  await writeFile(join(cwd, "AGENTS.md"), "# Agent notes\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node\nconsole.log('Shortest path (2 hops):\\n  trace <--references-- AGENTS.md --references--> docs');\n`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));
  const text = await call(pi, cwd, { target: "trace", relation: "path", to: "docs", scope: cwd });
  assert.match(text, /Graph path/);
  assert.match(text, /AGENTS\.md/);
  assert.doesNotMatch(text, /Handoff identities[\s\S]*AGENTS\.md:1/, "bare file nodes in graph paths should stay native graph context, not broad read handoffs");
});

test("trace path reports an unresolved graph path as warning evidence without a synthetic file lead", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-path-missing-"));
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await mkdir(join(cwd, "docs"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  await writeFile(join(cwd, "docs", "setup.md"), "# Setup\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node
console.error('warning: target match was ambiguous');
console.log("No path found between 'A' and 'docs/setup.md'.");
`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));
  const result = await pi.tool("trace").execute("trace", { target: "A", relation: "path", to: "docs/setup.md", scope: cwd }, undefined, undefined, { cwd });
  assert.equal(result.details.envelope.status, "warning");
  assert.match(result.details.envelope.summary, /no relationship found/);
  assert.deepEqual(result.details.presentation.rows, []);
  assert.deepEqual(result.details.envelope.artifacts, []);
  assert.doesNotMatch(result.content.map(part => part.text ?? "").join("\n"), /Exact follow-up selectors/);
});
