import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { detectProjectRoot, inspectNavigation, writeBootstrap } from "../scripts/navigation-doctor.mjs";

const execFileP = promisify(execFile);
const DOCTOR = new URL("../scripts/navigation-doctor.mjs", import.meta.url);
async function fixture() { return mkdtemp(join(tmpdir(), "pi-nav-doctor-")); }

test("navigation doctor detects project root and clean-break lanes", async () => {
  const root = await fixture();
  await writeFile(join(root, "Cargo.toml"), "[package]\nname='demo'\n");
  await mkdir(join(root, "src", "nested"), { recursive: true });
  assert.equal(detectProjectRoot(join(root, "src", "nested")), root);
  const report = inspectNavigation(join(root, "src", "nested"), { env: { PATH: "" } });
  assert.equal(report.root, root);
  for (const lane of ["docs", "graph"]) assert.ok(report.lanes.some(item => item.name === lane), lane);
  assert.equal(report.lanes.some(item => item.name === "semantic" || item.name === "codanna"), false);
  assert.equal(report.lanes.some(item => item.name === "tilth"), false);
});

test("navigation doctor distinguishes stale configured commands from current extension-owned commands", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "moved-runtime" }));
  const staleGraph = join(root, "old-install", "graphify");
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    graph: { enabled: false, command: staleGraph },
  }));
  const report = inspectNavigation(root, { env: { ...process.env } });
  const graph = report.lanes.find(lane => lane.name === "graph");
  assert.equal(graph.commandIdentity.configured, staleGraph);
  assert.notEqual(graph.commandIdentity.effective, staleGraph);
  assert.equal(graph.commandIdentity.staleConfiguredIgnored, true);
  assert.ok(report.warnings.some(warning => /stale configured graph command.*ignored/i.test(warning)));
});


test("navigation doctor accepts a current QMD lexical docs lane without external commands", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo" }));
  await mkdir(join(root, ".pi", "navigation", "qmd"), { recursive: true });
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ docs: { enabled: true, backend: "qmd", indexPath: ".pi/navigation/qmd", repo: "local/docs", root: "." } }));
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { docs: { backend: "qmd", repo: "local/docs", indexPath: ".pi/navigation/qmd", generationId: "g1", refreshStatus: "ready", qmd: { status: "lexical_ready", semantic: { status: "degraded", reason: "vectors_incomplete" }, generation: "g1", health: { needsEmbedding: 2 } } } } }));
  const report = inspectNavigation(root, { env: { PATH: "" } });
  const docs = report.lanes.find(lane => lane.name === "docs");
  assert.equal(docs.status, "ready", JSON.stringify(docs.problems));
  assert.equal(docs.backend, "qmd");
  assert.equal(docs.queryCommand, undefined);
});

test("navigation doctor rejects contradictory QMD hybrid readiness", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo" }));
  await mkdir(join(root, ".pi", "navigation", "qmd"), { recursive: true });
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ docs: { enabled: true, backend: "qmd", indexPath: ".pi/navigation/qmd", repo: "local/docs", root: "." } }));
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { docs: { backend: "qmd", repo: "local/docs", indexPath: ".pi/navigation/qmd", generationId: "g1", refreshStatus: "ready", qmd: { status: "ready", generation: "g1", health: { needsEmbedding: 2 } } } } }));
  const report = inspectNavigation(root, { env: { PATH: "" } });
  const docs = report.lanes.find(lane => lane.name === "docs");
  assert.notEqual(docs.status, "ready");
  assert.ok(docs.problems.some(problem => /needing vectors/.test(problem)), JSON.stringify(docs.problems));
});

test("navigation doctor reports obsolete semantic/Semble/Codanna global config drift", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo" }));
  const globalConfig = join(root, "global-config.json");
  await writeFile(globalConfig, JSON.stringify({ backends: { semantic: { primary: "semble", fallback: "codanna" } } }));

  const report = inspectNavigation(root, { env: { PATH: "", PI_NAV_CONFIG: globalConfig } });

  assert.ok(report.warnings.some(warning => /obsolete semantic\/Semble\/Codanna/.test(warning)), JSON.stringify(report.warnings));
});

test("navigation doctor does not warn when parent and child configs point at the same canonical lanes", async () => {
  const root = await fixture();
  const child = join(root, "agent", "extensions", "jeito-codeweave-pi");
  await mkdir(join(child, ".pi", "navigation", "qmd"), { recursive: true });
  await mkdir(join(child, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(child, "package.json"), JSON.stringify({ name: "jeito-codeweave-pi" }));
  await writeFile(join(child, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), JSON.stringify({ nodes: [], edges: [] }));
  const now = new Date().toISOString();
  await writeFile(join(child, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { docs: { indexedAt: now }, graph: { updatedAt: now } } }));
  const childConfig = {
    docs: { enabled: true, backend: "qmd", root: ".", indexPath: ".pi/navigation/qmd/index.sqlite" },
    graph: { enabled: true, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" },
  };
  await writeFile(join(child, ".pi-navigation.json"), JSON.stringify(childConfig));
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    docs: { ...childConfig.docs, root: "agent/extensions/codeweave-pi", indexPath: "agent/extensions/codeweave-pi/.pi/navigation/qmd/index.sqlite" },
    graph: { ...childConfig.graph, root: "agent/extensions/codeweave-pi", graphPath: "agent/extensions/codeweave-pi/.pi/navigation/graphify/graphify-out/graph.json" },
  }));

  const report = inspectNavigation(child, { env: { PATH: "" } });

  assert.ok(!report.warnings.some(warning => /nested navigation config/.test(warning)), JSON.stringify(report.warnings));
});

test("navigation doctor preserves Graphify quality evidence while legacy identity remains warming", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "graph-quality" }));
  await mkdir(join(root, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), JSON.stringify({ nodes: [{ id: "A" }], edges: [] }));
  const now = new Date().toISOString();
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    graph: { enabled: true, command: process.execPath, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json", mode: "deepExtract", semanticExtractionObserved: true },
  }));
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: {
    graph: { root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json", updatedAt: now, mode: "deepExtract", semanticExtractionObserved: true },
  } }));

  const report = inspectNavigation(root, { env: { PATH: "" }, now });
  const graph = report.lanes.find(lane => lane.name === "graph");

  assert.equal(graph.status, "warming", JSON.stringify(graph));
  assert.equal(graph.semanticExtractionObserved, true);
  assert.equal(graph.semanticAnswerQualityCertified, false);
  assert.equal(graph.semanticQuality, "semantic_extraction_observed_answer_quality_uncertified");
});

test("navigation doctor still warns when parent config would supply a missing local lane", async () => {
  const root = await fixture();
  const child = join(root, "agent", "extensions", "jeito-codeweave-pi");
  await mkdir(child, { recursive: true });
  await writeFile(join(child, "package.json"), JSON.stringify({ name: "jeito-codeweave-pi" }));
  await writeFile(join(child, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: false, root: "." } }));
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ docs: { enabled: true, root: ".", backend: "qmd", repo: "local/docs", indexPath: ".pi/navigation/qmd" } }));

  const report = inspectNavigation(child, { env: { PATH: "" } });

  assert.ok(report.warnings.some(warning => /nested navigation config/.test(warning) && /docs/.test(warning)), JSON.stringify(report.warnings));
});


test("navigation doctor reports legacy navigation state without treating it ready", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo" }));
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation-state.json"), JSON.stringify({ indexes: { docs: { repo: "local/old" } } }));

  const report = inspectNavigation(root, { env: { PATH: "" } });

  assert.ok(report.warnings.some(warning => /legacy navigation state .*\.pi\/navigation-state\.json/.test(warning)), JSON.stringify(report.warnings));
  assert.ok(report.next_actions.some(action => /not used as a ready lane.*canonical/.test(action)), JSON.stringify(report.next_actions));
  assert.deepEqual(report.lanes.map(lane => lane.name), ["docs", "graph"]);
});

test("navigation doctor reports obsolete Tilth config/state once and reports bundled pi-nav separately", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo" }));
  await mkdir(join(root, ".pi", "navigation"), { recursive: true });
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ tilth: { enabled: true } }));
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { tilth: { ready: true } } }));

  const report = inspectNavigation(root, { env: { PATH: "" } });
  const obsolete = report.warnings.filter(warning => /obsolete per-project tilth config\/state/i.test(warning));
  assert.equal(obsolete.length, 1, JSON.stringify(report.warnings));
  assert.deepEqual(report.lanes.map(lane => lane.name), ["docs", "graph"]);
  assert.equal(report.tools.pi_nav.available, true, JSON.stringify(report.tools.pi_nav));
  assert.match(report.tools.pi_nav.addon, /pi_nav\.(?:darwin|linux)-(?:arm64|x64)\.node$/);
});
test("navigation doctor writes safe clean-break config/state skeleton", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo" }));
  const report = writeBootstrap(root, { env: { PATH: "" } });
  assert.ok(existsSync(join(root, ".pi-navigation.json")));
  assert.ok(existsSync(join(root, ".pi", "navigation", "state.json")));
  assert.ok(report.writes.some(file => file.endsWith(".pi-navigation.json")));
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  assert.equal(config.architecture, undefined, "scaffolding external lanes must not invent a Core consent override");
  assert.equal(config.docs.enabled, false);
  assert.equal(config.docs.backend, "qmd");
  assert.equal(config.docs.queryTransport, undefined);
  assert.equal(config.docs.command, undefined);
  assert.equal(config.graph.enabled, false);
  assert.equal(config.semantic, undefined);
  assert.equal(config.codanna, undefined);
});

test("navigation doctor CLI emits JSON and supports init alias", async () => {
  const root = await fixture();
  await writeFile(join(root, "pyproject.toml"), "[project]\nname='demo'\n");
  const { stdout } = await execFileP(process.execPath, [DOCTOR.pathname, "init", "--path", root, "--json"], {
    env: { ...process.env, PATH: "" },
    timeout: 10_000,
  });
  const report = JSON.parse(stdout);
  assert.equal(report.root, root);
  assert.equal(report.config.exists, true);
  assert.ok(report.writes.some(file => file.endsWith(".pi-navigation.json")));
});

test("navigation doctor reports custom exact-search policy without creating it", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"), { recursive: true });
  const before = inspectNavigation(root, { env: { PATH: "" } });
  assert.equal(before.exactSearchPolicy.source, "gitignore");
  assert.equal(before.exactSearchPolicy.customOverride, false);
  assert.equal(existsSync(join(root, ".pi", "navigation", "ignore")), false);
  await mkdir(join(root, ".pi", "navigation"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "ignore"), "dist/\n");
  const after = inspectNavigation(root, { env: { PATH: "" } });
  assert.equal(after.exactSearchPolicy.source, "custom_navigation_ignore");
  assert.equal(after.exactSearchPolicy.customOverride, true);
  assert.equal(after.exactSearchPolicy.gitIgnoreSuppressed, true);
  assert.equal(after.exactSearchPolicy.counts, "query_result_only");
});
