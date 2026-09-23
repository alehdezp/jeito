import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dirtyPreparedBackends, notifyPreparedMutation } from "../src/core/prepared-mutation.ts";
import { resolvePreparedLane } from "../src/core/navigation-config.ts";

test("source mutations invalidate Graphify and schedule no retired code-index work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-dirty-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, ".pi", "navigation", "graphify", "generations", "g1"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "graphify", "generations", "g1", "graph.json"), "{}\n");
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, graphPath: ".pi/navigation/graphify/generations/g1/graph.json", refreshStatus: "ready" } }));
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: {
    graph: { graphPath: ".pi/navigation/graphify/generations/g1/graph.json", desiredStateHash: "a".repeat(64), rootIdentity: "b".repeat(64), generationId: "g1", backendIdentity: { version: "1", schemaVersion: "1" }, lastProbeStatus: "ready", refreshStatus: "ready" },
  } }));

  assert.equal(notifyPreparedMutation({ cwd: root, paths: ["src/changed.ts"], trigger: "edit" }), undefined);
  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(state.indexes.graph.refreshStatus, "ready");
  assert.equal(state.indexes.graph.sourceFreshnessStatus, "refresh_pending");
  assert.equal(state.indexes.graph.lastProbeStatus, "ready");
  assert.deepEqual(dirtyPreparedBackends(root), ["graphify"]);
  const mutationSource = await readFile(new URL("../src/core/prepared-mutation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(mutationSource, /sqlite|PI_NAV_CRG_QUERY_DB|sourcePolicy|reconcile_paths|require-embeddings/i, "mutation hooks must not repair index state themselves");
  assert.doesNotMatch(mutationSource, /child_process|spawn\(|setTimeout\(|inspectOwnedCrgRuntime|CrgMaintenance|CrgReconciliations/, "an edit/write hook must not schedule or spawn retired code-index work");

  const lane = await resolvePreparedLane(root, "graph", { env: { PATH: process.env.PATH } });
  assert.equal(lane.ok, true, JSON.stringify(lane));
  assert.equal(lane.refreshStatus, "ready");
  assert.equal(lane.sourceFreshnessStatus, "refreshing");
  assert.ok(lane.diagnostics.some(value => /graph_refresh_scheduled=/.test(value)), JSON.stringify(lane.diagnostics));
});


test("automatic refresh retries only transient Graphify failures after their backoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-dirty-retry-"));
  await mkdir(join(root, ".pi", "navigation"), { recursive: true });
  const statePath = join(root, ".pi", "navigation", "state.json");
  const retryAfter = Date.now() + 60_000;
  await writeFile(statePath, JSON.stringify({ indexes: { graph: { refreshStatus: "unavailable", lastRefreshFailure: { recoveryDecision: "retry_next_lifecycle", retryAfter: new Date(retryAfter).toISOString() } } } }));
  assert.deepEqual(dirtyPreparedBackends(root, retryAfter - 1), []);
  assert.deepEqual(dirtyPreparedBackends(root, retryAfter), ["graphify"]);
  await writeFile(statePath, JSON.stringify({ indexes: { graph: { refreshStatus: "unavailable", lastRefreshFailure: { recoveryDecision: "fail_closed" } } } }));
  assert.deepEqual(dirtyPreparedBackends(root, retryAfter + 1), []);
});

test("graph lane detects an externally modified manifest source before querying", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-manifest-freshness-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".pi", "navigation", "graphify", "generations", "g1"), { recursive: true });
  await mkdir(join(root, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  const source = join(root, "src", "main.ts");
  await writeFile(source, "export const value = 1;\n");
  const mtime = (await stat(source)).mtimeMs / 1000;
  const digest = createHash("md5").update(await readFile(source)).digest("hex");
  await writeFile(join(root, ".pi", "navigation", "graphify", "graphify-out", "manifest.json"), JSON.stringify({ "src/main.ts": { mtime, ast_hash: digest, semantic_hash: digest } }));
  await writeFile(join(root, ".pi", "navigation", "graphify", "generations", "g1", "graph.json"), "{}\n");
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, graphPath: ".pi/navigation/graphify/generations/g1/graph.json", refreshStatus: "ready" } }));
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { graph: { graphPath: ".pi/navigation/graphify/generations/g1/graph.json", sourceManifestPath: ".pi/navigation/graphify/graphify-out/manifest.json", desiredStateHash: "a".repeat(64), rootIdentity: "b".repeat(64), generationId: "g1", backendIdentity: { version: "1", schemaVersion: "1" }, lastProbeStatus: "ready", refreshStatus: "ready" } } }));

  const touchedAt = new Date(Date.now() + 30_000);
  await utimes(source, touchedAt, touchedAt);
  const touched = await resolvePreparedLane(root, "graph", { env: { PATH: process.env.PATH } });
  assert.equal(touched.ok, true, JSON.stringify(touched));
  assert.equal(touched.sourceFreshnessStatus, "current", "mtime-only touch must not make an unchanged graph stale");
  assert.deepEqual(dirtyPreparedBackends(root), []);
  const ready = await resolvePreparedLane(root, "graph", { env: { PATH: process.env.PATH } });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  await new Promise(resolve => setTimeout(resolve, 5));
  await writeFile(source, "export const value = 2;\n");
  const stale = await resolvePreparedLane(root, "graph", { env: { PATH: process.env.PATH } });
  assert.equal(stale.ok, true, JSON.stringify(stale));
  assert.equal(stale.refreshStatus, "ready");
  assert.equal(stale.sourceFreshnessStatus, "refreshing");
  assert.ok(stale.diagnostics.some(value => /graph_refresh_pending=.*source changed after graph publication/.test(value)), JSON.stringify(stale.diagnostics));
  assert.deepEqual(dirtyPreparedBackends(root), ["graphify"], "external source drift must schedule automatic Graphify refresh");
});

test("graph lane reconciles a partial publication identity and schedules repair without breaking map queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-partial-graph-publication-"));
  await mkdir(join(root, ".git"));
  const generation = "g-new";
  const generationDir = join(root, ".pi", "navigation", "graphify", "generations", generation);
  await mkdir(generationDir, { recursive: true });
  await writeFile(join(generationDir, "graph.json"), "{}\n");
  await writeFile(join(generationDir, "manifest.json"), "{}\n");
  const graphPath = `.pi/navigation/graphify/generations/${generation}/graph.json`;
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, graphPath, mode: "richUpdate", refreshStatus: "ready" } }));
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { graph: { graphPath, sourceManifestPath: `.pi/navigation/graphify/generations/${generation}/manifest.json`, generationId: "g-cleaned-up", artifactGeneration: { id: "g-cleaned-up", artifactPath: join(root, ".pi", "navigation", "graphify", "generations", "g-cleaned-up") }, mode: "richUpdate", refreshStatus: "ready" } } }));

  const lane = await resolvePreparedLane(root, "graph", { env: { PATH: process.env.PATH } });
  assert.equal(lane.ok, true, JSON.stringify(lane));
  assert.equal(lane.generationId, generation);
  assert.ok(lane.diagnostics.some(value => value === `graph_generation_reconciled=g-cleaned-up->${generation}`), JSON.stringify(lane.diagnostics));
  assert.deepEqual(dirtyPreparedBackends(root), ["graphify"], "partial publication state must be repaired by automatic lifecycle");
});

test("graph lane survives malformed config when a verified state artifact exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-malformed-config-graph-"));
  const generationDir = join(root, ".pi", "navigation", "graphify", "generations", "g1");
  await mkdir(generationDir, { recursive: true });
  await writeFile(join(generationDir, "graph.json"), "{}\n");
  await writeFile(join(root, ".pi-navigation.json"), "{ invalid json");
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { graph: { graphPath: ".pi/navigation/graphify/generations/g1/graph.json", generationId: "g1", refreshStatus: "ready" } } }));
  const lane = await resolvePreparedLane(root, "graph", { env: { PATH: process.env.PATH } });
  assert.equal(lane.ok, true, JSON.stringify(lane));
  assert.equal(lane.refreshStatus, "ready");
  assert.ok(lane.diagnostics.some(value => /invalid JSON/.test(value)), JSON.stringify(lane.diagnostics));
});

test("a project with no navigation state reports clean without creating any state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-dirty-absent-"));
  assert.deepEqual(dirtyPreparedBackends(root), [], "absent state is not drift");
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true } }));
  const before = (await readdir(root)).sort();
  assert.deepEqual(dirtyPreparedBackends(root), [], "config without recorded state is not drift");
  assert.deepEqual((await readdir(root)).sort(), before, "dirty detection must not create navigation state");
});
