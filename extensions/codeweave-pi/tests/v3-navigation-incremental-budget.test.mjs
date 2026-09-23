import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectNavigation } from "../scripts/navigation-doctor.mjs";
import { prepareNavigation, shouldSkipAlreadyReadyAction } from "../scripts/navigation-prepare.mjs";
import { GRAPHIFY_PIN } from "../src/core/backend-registry.ts";
import { FULL_STACK_NAVIGATION_AUTOMATION_CONFIG } from "../src/core/navigation-automation-config.ts";

async function fixture() { return mkdtemp(join(tmpdir(), "pi-nav-incremental-budget-")); }

test("no-change first-broad reconciliation reuses a verified generation without provider or rebuild work", async () => {
  const root = await fixture();
  const bin = join(root, "bin");
  const marker = join(root, "graphify-called");
  const graphPath = join(root, ".pi", "navigation", "graphify", "generations", "g1", "graph.json");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".pi", "navigation", "graphify", "generations", "g1"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "export const main = true;\n");
  await writeFile(graphPath, JSON.stringify({ nodes: [{ id: "main" }], edges: [] }));
  // The published generation is the verified artifact; the working out dir is the
  // incremental set a lifecycle `update` needs, so a real owned lane carries both.
  const workingDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(workingDir, { recursive: true });
  await writeFile(join(workingDir, "graph.json"), JSON.stringify({ nodes: [{ id: "main" }], edges: [] }));
  await writeFile(join(workingDir, "manifest.json"), JSON.stringify({ "src/main.ts": { mtime: 1, ast_hash: "a", semantic_hash: "a" } }));
  const graphify = join(bin, "graphify");
  await writeFile(graphify, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`);
  await chmod(graphify, 0o755);
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, graphPath: ".pi/navigation/graphify/generations/g1/graph.json", root: "src", mode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash", semanticExtractionObserved: true } }));
  // Pin the opt-in Graphify policy: provider availability must come from this
  // fixture's own consent, not from the developer's ~/.pi/agent/navigation.yaml.
  const automationPath = join(root, "automation.json");
  await writeFile(automationPath, JSON.stringify(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG));
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: process.env.HOME, DEEPSEEK_API_KEY: "configured", PI_NAV_AUTOMATION_CONFIG: automationPath };
  const desired = inspectNavigation(root, { env });
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { graph: { graphPath: ".pi/navigation/graphify/generations/g1/graph.json", root: "src", mode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash", semanticExtractionObserved: true, updatedAt: new Date().toISOString(), desiredStateHash: desired.desiredState.laneHashes.graph, rootIdentity: desired.desiredState.rootIdentity, generationId: "g1", artifactGeneration: { id: "g1", lane: "graph", artifactPath: join(root, ".pi", "navigation", "graphify", "generations", "g1") }, lastProbeStatus: "ready", lastProbeAt: new Date().toISOString(), backendIdentity: { name: "graphify", version: GRAPHIFY_PIN, schemaVersion: "1" } } } }));
  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const result = await prepareNavigation(["--path", root, "--auto", "--trigger", "first_broad_request", "--backend", "graphify"], { env });
  const elapsed = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const rssGrowth = Math.max(0, process.memoryUsage().rss - rssBefore);
  assert.equal(result.execution[0].status, "already_ready", JSON.stringify(result.execution[0]));
  assert.ok(elapsed < 2_000, `no-change reconciliation took ${elapsed.toFixed(1)}ms`);
  assert.ok((cpu.user + cpu.system) / 1_000 < 2_000, `no-change reconciliation used ${(cpu.user + cpu.system) / 1_000}ms CPU`);
  assert.ok(rssGrowth < 32 * 1024 * 1024, `no-change reconciliation grew RSS by ${rssGrowth} bytes`);
  await assert.rejects(access(marker));
});
test("automatic checkpoints reuse a ready lane instead of forcing a publication", () => {
  assert.equal(shouldSkipAlreadyReadyAction("session_start", { backend: "graphify" }), true);
  assert.equal(shouldSkipAlreadyReadyAction("first_broad_request", { backend: "graphify" }), true);
  assert.equal(shouldSkipAlreadyReadyAction("session_start", { backend: "qmd" }), false);
  assert.equal(shouldSkipAlreadyReadyAction("first_broad_request", { backend: "qmd" }), false);
  assert.equal(shouldSkipAlreadyReadyAction("stop_refresh", { backend: "graphify" }), false);
  assert.equal(shouldSkipAlreadyReadyAction("stop_refresh", { backend: "qmd" }), false);
});
