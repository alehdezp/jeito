import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { callTool, executable, registerCleanPi, tempProject, writeGraphifyFixture } from "./_clean-navigation-helper.mjs";
import { GRAPHIFY_MAP_TIMEOUT_MS } from "../src/tools/explore.ts";
import { sanitizeGraphifyResult } from "../src/core/navigation-clean.ts";
import { recordToolCall, resetToolCallLedger } from "../src/core/tool-call-ledger.ts";

test("explore map has a bounded 20s query timeout", () => {
  assert.equal(GRAPHIFY_MAP_TIMEOUT_MS, 20_000);
});

test("Graphify hygiene removes only stale file nodes and preserves concepts plus inferred edges", async () => {
  const cwd = await tempProject("pi-graphify-hygiene-");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "current.ts"), "export const current = true;\n");
  const result = sanitizeGraphifyResult({
    nodes: [
      { id: "current", kind: "File", label: "Current file", source_file: "src/current.ts" },
      { id: "deleted", kind: "File", label: "Deleted file", source_file: "src/deleted.ts" },
      { id: "policy", kind: "Concept", label: "Rollout policy", source_file: "src/deleted.ts", provenance: "INFERRED" },
    ],
    edges: [{ source: "policy", target: "current", provenance: "INFERRED" }],
  }, cwd);
  const value = result.value;
  assert.deepEqual(value.nodes.map(node => node.id), ["current", "policy"]);
  assert.equal(value.edges.length, 1);
  assert.equal(value.edges[0].provenance, "INFERRED");
  assert.equal(value.project_navigation.graphify_hygiene.stale_file_node_count, 1);
  assert.deepEqual(value.project_navigation.graphify_hygiene.stale_file_sample, ["src/deleted.ts"]);
  assert.match(result.diagnostics.join("\n"), /graphify_stale_file_nodes=1/);
});

test("explore returns typed invalid-call evidence for the removed entrypoints alias", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-code-entrypoints-removed-");
  assert.match(await callTool(pi, cwd, "explore", { view: "code", operation: "entrypoints", scope: cwd }), /INVALID CALL: explore[\s\S]*operation must be one of/);
});

test("explore success copy stays compact while rejecting old output/detail knobs", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-copy-clean-");
  await writeGraphifyFixture(cwd);
  assert.match(await callTool(pi, cwd, "explore", { query: "overview", output: "gcf", detail: "compact", scope: cwd }), /INVALID CALL: explore[\s\S]*(?:obsolete|output|detail)/i);
  const text = await callTool(pi, cwd, "explore", { query: "overview", view: "map", scope: cwd });
  assert.match(text, /★?fixture src\/main\.ts:1/);
  assert.doesNotMatch(text, /Leads only|read for proof|edit authority/i);
});

test("explore map exposes native-text-only anchoring and actual starts in the compact result summary", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-map-native-text-");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node
console.log("Traversal: BFS depth=2 | Start: ['RetryCapsule', 'retryCapsules', 'RetryCapsule'] | 3 nodes found");
console.log('NODE RetryCapsule [src=src/core/edit-retry.ts loc=L12 community=1]');
`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));

  const result = await pi.tool("explore").execute("test-explore", { query: "checkout timeout retry policy", view: "map", scope: cwd }, undefined, undefined, { cwd });
  const text = result.content.map(part => part.type === "text" ? part.text : "").join("\n");
  assert.match(text, /Seed diagnostics: query_anchoring=native-text-only/);
  assert.match(result.details.envelope.summary, /native-text-only/);
  assert.match(result.details.envelope.summary, /starts RetryCapsule ×2, retryCapsules/);
});

test("explore preserves native graph text without success-time tutorial boilerplate", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-copy-graph-");
  await writeGraphifyFixture(cwd);
  const text = await callTool(pi, cwd, "explore", { query: "fixture", view: "map", scope: cwd });
  assert.match(text, /★?fixture src\/main\.ts:1/);
  assert.doesNotMatch(text, /Leads only|read for proof|edit authority/i);
});

test("explore map suppresses broad file-start handoffs when native graph nodes already carry source paths", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-copy-no-broad-handoff-");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "main.ts"), "export function fixture() { return 1; }\n");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node\nconsole.log('NODE fixture() [src=src/main.ts loc=L1 community=1]');\nconsole.log('EDGE fixture() --contains [EXTRACTED]--> main.ts');\n`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));
  const text = await callTool(pi, cwd, "explore", { query: "fixture", view: "map", scope: cwd, limit: 5 });
  assert.match(text, /fixture\(\) src\/main\.ts:1/);
  assert.match(text, /fixture\(\) contains→ main\.ts/);
  assert.doesNotMatch(text, /Handoff identities[\s\S]*src\/main\.ts:1-80/);
});

test("explore map enriches seed nodes with live signature and body range", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-copy-seed-enrich-");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "main.ts"), "export function fixture() {\n  return 1;\n}\n");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node
console.log("Traversal: BFS depth=1 | Start: ['fixture()'] | 1 nodes found");
console.log('NODE fixture() [src=src/main.ts loc=L1 community=1]');
`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));
  const text = await callTool(pi, cwd, "explore", { query: "fixture", view: "map", scope: cwd, limit: 5 });
  // Enriched seed line: the live signature leads (starred), then `. file:defLine:[bodyStart-bodyEnd]`.
  assert.match(text, /★[^★\n]*fixture\(\)/, "seed line carries the live signature, starred");
  assert.match(text, /\. src\/main\.ts:1:\[1-\d+\]/, "seed line carries location + live body range");
  assert.doesNotMatch(text, /★fixture\(\) src\/main\.ts:1 c/, "seed is enriched, not the bare compact form");
});

test("explore map enriches edge call-sites with the enclosing body range", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-copy-edge-block-");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "main.ts"), "export function fixture() {\n  return helper();\n}\n\nexport function helper() {\n  return 1;\n}\n");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node
console.log("Traversal: BFS depth=1 | Start: ['fixture()'] | 2 nodes found");
console.log('NODE fixture() [src=src/main.ts loc=L1 community=1]');
console.log('NODE helper() [src=src/main.ts loc=L5 community=1]');
console.log('EDGE fixture() --calls [EXTRACTED context=call]--> helper() at=src/main.ts:L2');
`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));
  const text = await callTool(pi, cwd, "explore", { query: "fixture", view: "map", scope: cwd, limit: 5 });
  // The edge call-site carries the enclosing body range, so the agent reads the
  // calling block directly instead of re-grepping the line.
  assert.match(text, /calls:call→ helper\(\) @src\/main\.ts:2:\[\d+-\d+\]/, "edge call-site carries an enclosing body range");
});

test("explore map preserves stored source-to-target direction around an exact anchor", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-map-direction-");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "billing.ts"), "export function calculateInvoice() { return normalize(); }\nexport function normalize() { return 1; }\n");
  await writeFile(join(cwd, "src", "checkout.ts"), "import { calculateInvoice } from './billing.js';\nexport function checkout() { return calculateInvoice(); }\n");
  const graphPath = join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(graphPath, JSON.stringify({ directed: false, nodes: [
    { id: "billing", label: "billing.ts", source_file: "src/billing.ts", source_location: "L1" },
    { id: "calculate", label: "calculateInvoice()", source_file: "src/billing.ts", source_location: "L1" },
    { id: "normalize", label: "normalize()", source_file: "src/billing.ts", source_location: "L2" },
    { id: "checkout_file", label: "checkout.ts", source_file: "src/checkout.ts", source_location: "L1" },
    { id: "checkout", label: "checkout()", source_file: "src/checkout.ts", source_location: "L2" },
  ], links: [
    { source: "billing", target: "calculate", relation: "contains", confidence: "EXTRACTED", source_file: "src/billing.ts", source_location: "L1" },
    { source: "checkout_file", target: "calculate", relation: "imports", confidence: "EXTRACTED", source_file: "src/checkout.ts", source_location: "L1" },
    { source: "checkout", target: "calculate", relation: "calls", confidence: "EXTRACTED", source_file: "src/checkout.ts", source_location: "L2" },
    { source: "calculate", target: "normalize", relation: "calls", confidence: "EXTRACTED", source_file: "src/billing.ts", source_location: "L1" },
  ] }));
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'explain') {
  console.log('Node: calculateInvoice()');
  console.log('  ID:        calculate');
  console.log('  Source:    src/billing.ts L1');
} else {
  console.log("Traversal: BFS depth=2 | Start: ['calculateInvoice()'] | 5 nodes found");
  console.log('NODE calculateInvoice() [src=src/billing.ts loc=L1 community=1]');
  console.log('NODE billing.ts [src=src/billing.ts loc=L1 community=1]');
  console.log('NODE normalize() [src=src/billing.ts loc=L2 community=1]');
  console.log('NODE checkout.ts [src=src/checkout.ts loc=L1 community=1]');
  console.log('NODE checkout() [src=src/checkout.ts loc=L2 community=1]');
  console.log('EDGE calculateInvoice() --contains [EXTRACTED]--> billing.ts at=src/billing.ts:L1');
  console.log('EDGE calculateInvoice() --imports [EXTRACTED]--> checkout.ts at=src/checkout.ts:L1');
  console.log('EDGE calculateInvoice() --calls [EXTRACTED]--> checkout() at=src/checkout.ts:L2');
  console.log('EDGE calculateInvoice() --calls [EXTRACTED]--> normalize() at=src/billing.ts:L1');
}
`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));

  const result = await pi.tool("explore").execute("map-direction", { query: "src/billing.ts::calculateInvoice", view: "map", scope: cwd }, undefined, undefined, { cwd });
  const text = result.content[0].text;
  assert.match(text, /billing\.ts contains→ calculateInvoice\(\)/);
  assert.match(text, /checkout\.ts imports→ calculateInvoice\(\)/);
  assert.match(text, /checkout\(\) calls→ calculateInvoice\(\)/);
  assert.match(text, /calculateInvoice\(\) calls→ normalize\(\)/, "already-correct outgoing edges are not reversed");
  assert.doesNotMatch(text, /calculateInvoice\(\) (?:contains→ billing\.ts|imports→ checkout\.ts|calls→ checkout\(\))/);
  assert.deepEqual(result.details.presentation.edges.map(edge => edge.split(" @")[0]), [
    "billing.ts contains→ calculateInvoice()",
    "checkout.ts imports→ calculateInvoice()",
    "checkout() calls→ calculateInvoice()",
    "calculateInvoice() calls→ normalize()",
  ]);
});

test("explore map shows the legend on first call, suppresses repeats, and re-shows after 20 other-tool calls", async () => {
  resetToolCallLedger();
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-copy-legend-gate-");
  await writeGraphifyFixture(cwd);
  const first = await callTool(pi, cwd, "explore", { query: "fixture", view: "map", scope: cwd });
  assert.match(first, /Legend: ★=query seed/, "first explore call shows the legend");
  const second = await callTool(pi, cwd, "explore", { query: "fixture", view: "map", scope: cwd });
  assert.doesNotMatch(second, /Legend: ★=query seed/, "repeat explore call suppresses the legend");
  for (let i = 0; i < 20; i++) recordToolCall("read");
  const third = await callTool(pi, cwd, "explore", { query: "fixture", view: "map", scope: cwd });
  assert.match(third, /Legend: ★=query seed/, "legend re-appears after 20 other-tool calls");
});

test("explore map leaves file seed nodes as files instead of falsely marking them stale symbols", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-copy-file-seed-");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "main.ts"), "export const main = 1;\n");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node
console.log("Traversal: BFS depth=1 | Start: ['main.ts'] | 1 nodes found");
console.log('NODE main.ts [src=src/main.ts loc=L1 community=1]');
`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));
  const text = await callTool(pi, cwd, "explore", { query: "main.ts", view: "map", scope: cwd, limit: 5 });
  assert.match(text, /★main\.ts src\/main\.ts:1 c1/);
  assert.doesNotMatch(text, /main\.ts.*stale — name no longer defined/);
});

test("explore map preserves a measured native neighborhood in one bounded response", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-copy-native-neighborhood-");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node
for (let i = 0; i < 240; i++) console.log('NODE n' + i + ' [src=src/file' + i + '.ts loc=L1 community=1]');
console.log('EDGE lateSource --calls [EXTRACTED context=call]--> lateTarget');
`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));
  const first = await pi.tool("explore").execute("native-neighborhood", { query: "late edge preservation", view: "map", scope: cwd, limit: 3 }, undefined, undefined, { cwd });
  const tail = await pi.tool("explore").execute("native-neighborhood-tail", { query: "late edge preservation", view: "map", scope: cwd, page: 80, limit: 3 }, undefined, undefined, { cwd });
  const text = first.content[0].text;
  const tailText = tail.content[0].text;
  assert.match(text, /n0 src\/file0\.ts:1/);
  assert.doesNotMatch(text, /n239 src\//);
  assert.match(text, /lateSource calls:call→ lateTarget/);
  assert.match(text, /Page: page=1 · nodes=3\/240 · edges=1\/1 · next_page=2/);
  assert.match(tailText, /n239 src\//);
  assert.doesNotMatch(tailText, /n0 src\//);
  assert.equal(first.details.presentation.nodes.length, 3);
  assert.equal(first.details.presentation.edges.length, 1);
  assert.equal(tail.details.presentation.nodes.length, 3);
  assert.equal(tail.details.presentation.edges.length, 0);
});

test("explore map sends unseeded concept queries to Graphify unchanged", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-map-native-query-");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const argsLog = join(cwd, "graphify-args.json");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(process.argv[3]);\nconsole.log('NODE fixture [src=src/main.ts loc=L1 community=1]');\n`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));

  const text = await callTool(pi, cwd, "explore", { query: "release readiness blockers", view: "map", scope: cwd });
  const args = JSON.parse(await readFile(argsLog, "utf8"));

  assert.equal(args[0], "query");
  assert.equal(args[1], "release readiness blockers");
  assert.match(text, /fixture src\/main\.ts:1/);
  assert.match(text, /release readiness blockers/);
  assert.doesNotMatch(text, /Graphify query intent:/);
});

test("explore map default calls can run in parallel without serializing", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-map-default-parallel-");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const callsLog = join(cwd, "graphify-parallel-calls.log");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const query = process.argv[3] || '';
const head = query.split('\\n')[0];
appendFileSync(${JSON.stringify(callsLog)}, Date.now() + ' start ' + head + '\\n');
await new Promise(resolve => setTimeout(resolve, 250));
appendFileSync(${JSON.stringify(callsLog)}, Date.now() + ' end ' + head + '\\n');
for (let i = 0; i < 160; i++) console.log('NODE ' + head.replace(/\\s+/g, '_') + '_' + i + ' [src=src/file' + i + '.ts loc=L1 community=1]');
console.log('EDGE ' + head.replace(/\\s+/g, '_') + ' --relates [EXTRACTED]--> target');
`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));

  const outputs = await Promise.all(["alpha", "beta", "gamma", "delta"].map(query => callTool(pi, cwd, "explore", { query, view: "map", scope: cwd })));
  const log = await readFile(callsLog, "utf8");
  const firstEnd = log.indexOf(" end ");
  const startsBeforeFirstEnd = log.slice(0, firstEnd).split("\n").filter(line => line.includes(" start ")).length;

  assert.equal(outputs.length, 4);
  for (const text of outputs) assert.match(text, /Graph map|NODE/);
  assert.equal(startsBeforeFirstEnd, 4, `expected all graphify subprocesses to start before the first one ended; log:\n${log}`);
  const timestamps = log.trim().split("\n").map(line => Number(line.split(" ", 1)[0])).filter(Number.isFinite);
  const subprocessSpan = Math.max(...timestamps) - Math.min(...timestamps);
  assert.ok(subprocessSpan < 1200, `parallel graph subprocess window should stay bounded; span=${subprocessSpan}ms log:\n${log}`);
});

test("explore map falls back to the explicit path query when native exact resolution returns no node", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-map-seeds-");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const argsLog = join(cwd, "graphify-args.json");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('NODE fixture [src=src/main.ts loc=L1 community=1]');\n`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));

  const text = await callTool(pi, cwd, "explore", { query: "how does exploreMap render graphify output near normalizeDocParam in src/tools/explore.ts", view: "map", scope: cwd });
  const args = JSON.parse(await readFile(argsLog, "utf8"));

  assert.equal(args[1], "src/tools/explore.ts", "the unresolved exact path must remain the native fallback query");
  assert.doesNotMatch(args[1], /Graphify seeds:/, "inferred symbols must not replace the authored path start");
  assert.match(text, /Seed diagnostics: query_anchoring=explicit-seeded; .*symbol_seeds=.*exploreMap/);
  assert.match(text, /Seed diagnostics: .*path_seeds=.*src\/tools\/explore\.ts[^;]*; path_anchor=src\/tools\/explore\.ts/);
  assert.match(text, /fixture src\/main\.ts:1/);
  assert.doesNotMatch(text, /Graphify seeds:/, "seed boilerplate should be stripped from user-visible output");
  assert.doesNotMatch(text, /Graphify query intent:/, "intent boilerplate should be stripped from user-visible output");
});

test("explore map resolves an exact path to the native graph node before traversal", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-map-exact-anchor-");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  await mkdir(join(cwd, "src", "core"), { recursive: true });
  await writeFile(join(cwd, "src", "core", "navigation-clean.ts"), "export const fixture = true;\n");
  const callsLog = join(cwd, "graphify-exact-calls.jsonl");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'explain') {
  console.log('Node: navigation-clean.ts');
  console.log('  ID:        core_navigation_clean');
  console.log('  Source:    src/core/navigation-clean.ts L1');
} else {
  console.log("Traversal: BFS depth=2 | Start: ['navigation-clean.ts'] | 1 nodes found");
  console.log('NODE navigation-clean.ts [src=src/core/navigation-clean.ts loc=L1 community=1]');
}
`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));

  const result = await pi.tool("explore").execute("test-exact-anchor", { query: "src/core/navigation-clean.ts", view: "map", scope: cwd }, undefined, undefined, { cwd });
  const calls = (await readFile(callsLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [["explain", "src/core/navigation-clean.ts"], ["query", "core_navigation_clean"]]);
  assert.equal(result.details.envelope.status, "success");
  assert.equal(result.details.presentation.anchorRetention, "retained");
  assert.deepEqual(result.details.presentation.starts, ["navigation-clean.ts"]);
  assert.ok(result.details.envelope.diagnostics.includes("exact_anchor_status=retained"));
});

test("explore map warns when an exact requested path is not retained as a start", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-map-rejected-anchor-");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  await mkdir(join(cwd, "src", "core"), { recursive: true });
  await writeFile(join(cwd, "src", "core", "navigation-clean.ts"), "export const fixture = true;\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'explain') {
  console.log('Node: navigation-clean.mjs');
  console.log('  ID:        scripts_navigation_clean');
  console.log('  Source:    scripts/navigation-clean.mjs L1');
} else {
  console.log("Traversal: BFS depth=2 | Start: ['navigation-clean.mjs'] | 1 nodes found");
  console.log('NODE navigation-clean.mjs [src=scripts/navigation-clean.mjs loc=L1 community=1]');
}
`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));

  const result = await pi.tool("explore").execute("test-rejected-anchor", { query: "src/core/navigation-clean.ts", view: "map", scope: cwd }, undefined, undefined, { cwd });
  assert.equal(result.details.envelope.status, "warning");
  assert.match(result.details.envelope.summary, /requested exact anchor was not retained/);
  assert.equal(result.details.presentation.anchorRetention, "rejected");
  assert.ok(result.details.envelope.diagnostics.includes("exact_anchor_status=rejected"));
});

test("explore map pages NODE and EDGE rows independently with stable continuation", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-map-pages-");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node
console.log("Traversal: BFS depth=2 | Start: ['src/tools/explore.ts'] | 3 nodes found");
console.log('NODE one [src=src/one.ts loc=L1 community=1]');
console.log('NODE two [src=src/two.ts loc=L2 community=1]');
console.log('NODE three [src=src/three.ts loc=L3 community=1]');
console.log('EDGE one --calls [EXTRACTED]--> two');
console.log('EDGE two --calls [EXTRACTED]--> three');
`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));

  const page1 = await callTool(pi, cwd, "explore", { query: "src/tools/explore.ts", view: "map", scope: cwd, page: 1, limit: 1 });
  const page2 = await callTool(pi, cwd, "explore", { query: "src/tools/explore.ts", view: "map", scope: cwd, page: 2, limit: 1 });
  assert.match(page1, /Page: page=1 · nodes=1\/3 · edges=1\/2 · next_page=2/);
  assert.match(page1, /one src\/one\.ts:1/);
  assert.doesNotMatch(page1, /two src\//);
  assert.match(page1, /one calls→ two/);
  assert.doesNotMatch(page1, /two calls→ three/);
  assert.match(page2, /Page: page=2 · nodes=1\/3 · edges=1\/2 · next_page=3/);
  assert.match(page2, /two src\/two\.ts:2/);
  assert.doesNotMatch(page2, /one src\//);
  assert.match(page2, /two calls→ three/);
  assert.doesNotMatch(page2, /one calls→ two/);
});

test("explore map keeps a path-only fallback when native exact resolution returns no node", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-map-path-node-seeds-");
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), JSON.stringify({ nodes: [
    { label: "explore.ts", source_file: "src/tools/explore.ts" },
    { label: "shapeGraphifyMapQuery()", source_file: "src/tools/explore.ts" },
    { label: "exploreMap()", source_file: "src/tools/explore.ts" },
  ] }));
  const argsLog = join(cwd, "graphify-path-args.json");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('NODE exploreMap() [src=src/tools/explore.ts loc=L176 community=1]');\n`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));

  const text = await callTool(pi, cwd, "explore", { query: "src/tools/explore.ts", view: "map", scope: cwd });
  const args = JSON.parse(await readFile(argsLog, "utf8"));
  assert.equal(args[1], "src/tools/explore.ts");
  assert.doesNotMatch(args[1], /Graphify seeds:/);
  assert.match(text, /Seed diagnostics: .*path_anchor=src\/tools\/explore\.ts/);
  assert.doesNotMatch(text, /graph_path_node_seeds=/);
});
