import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireLaneTransaction, inspectLaneOwner, transactionRecordPath } from "../src/core/navigation-lane-transaction.ts";
import { cleanupOwnedStage, createGenerationStage, generationLaneRoot, publishExistingArtifactGenerationSync, publishGeneration, quarantineGeneration, readGenerationPointer } from "../src/core/navigation-generation.ts";

async function fixture() { return mkdtemp(join(tmpdir(), "pi-nav-generation-")); }

test("lane transaction is token-safe, heartbeat-verified, and never releases a newer owner", async () => {
  const root = await fixture();
  const owner = await acquireLaneTransaction({ root, lane: "docs", desiredStateHash: "a".repeat(64), extensionVersion: "0.9.0", backendVersion: "1.92.0", operation: "test", timeoutMs: 200 });
  const path = transactionRecordPath(root, "docs");
  const inspected = await inspectLaneOwner(path);
  assert.equal(inspected.live, true, JSON.stringify(inspected));
  assert.equal(await owner.heartbeat(), true);
  const replacement = { ...owner.record, token: "newer-token" };
  await writeFile(path, `${JSON.stringify(replacement)}\n`);
  assert.equal(await owner.release(), false);
  assert.equal(JSON.parse(await readFile(path, "utf8")).token, "newer-token");
});

test("a live long-running lifecycle owner is never reclaimed only because its heartbeat is old", async () => {
  const root = await fixture();
  const owner = await acquireLaneTransaction({ root, lane: "graph", desiredStateHash: "d".repeat(64), extensionVersion: "0.9.0", operation: "long-refresh", timeoutMs: 200 });
  const inspected = await inspectLaneOwner(transactionRecordPath(root, "graph"), { staleMs: 1, now: Date.now() + 60_000 });
  assert.equal(inspected.live, true, JSON.stringify(inspected));
  assert.equal(inspected.reclaimable, false, JSON.stringify(inspected));
  assert.equal(inspected.reason, "heartbeat_stale_owner_live");
  await owner.release();
});

test("stale or dead owner can be reclaimed without killing the recorded process", async () => {
  const root = await fixture();
  const path = transactionRecordPath(root, "docs");
  await mkdir(join(root, ".pi", "navigation", "transactions"), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, lane: "docs", root, pid: 99999999, processStartIdentity: "99999999:old", token: "stale", desiredStateHash: "b".repeat(64), extensionVersion: "0.9.0", operation: "old", createdAt: "2020-01-01T00:00:00.000Z", heartbeatAt: "2020-01-01T00:00:00.000Z" }));
  const owner = await acquireLaneTransaction({ root, lane: "docs", desiredStateHash: "c".repeat(64), extensionVersion: "0.9.0", operation: "takeover", timeoutMs: 300 });
  assert.notEqual(owner.record.token, "stale");
  await owner.release();
});

test("generation publication is staged, verified, atomic, idempotent, and preserves last-good", async () => {
  const root = await fixture();
  const first = await createGenerationStage(root, "docs", "g1");
  await writeFile(join(first.stagingPath, "index.json"), "one\n");
  const p1 = await publishGeneration({ stage: first, desiredStateHash: "1".repeat(64), rootIdentity: "2".repeat(64), backendVersion: "1.92.0", verify: async stage => stat(join(stage, "index.json")) });
  assert.equal(p1.predecessor, "absent");
  assert.equal((await readGenerationPointer(generationLaneRoot(root, "docs"), "current.json")).id, "g1");

  const second = await createGenerationStage(root, "docs", "g2");
  await writeFile(join(second.stagingPath, "index.json"), "two\n");
  const p2 = await publishGeneration({ stage: second, desiredStateHash: "3".repeat(64), rootIdentity: "2".repeat(64), backendVersion: "1.92.0", verify: async stage => stat(join(stage, "index.json")) });
  assert.equal(p2.predecessor, "g1");
  assert.equal((await readGenerationPointer(generationLaneRoot(root, "docs"), "last-good.json")).id, "g1");
  assert.equal(await readFile(join(generationLaneRoot(root, "docs"), "generations", "g1", "index.json"), "utf8"), "one\n");
});

test("failed verification never publishes and cleanup is scoped to the actor stage", async () => {
  const root = await fixture();
  const stage = await createGenerationStage(root, "graph", "bad");
  await assert.rejects(() => publishGeneration({ stage, desiredStateHash: "4".repeat(64), rootIdentity: "5".repeat(64), verify: () => { throw new Error("probe failed"); } }), /probe failed/);
  assert.equal(await readGenerationPointer(generationLaneRoot(root, "graph"), "current.json"), undefined);
  await cleanupOwnedStage(stage);
  await assert.rejects(() => stat(stage.stagingPath), /ENOENT/);
});

test("quarantine requires explicit approval and never removes current pointer implicitly", async () => {
  const root = await fixture();
  const stage = await createGenerationStage(root, "graph", "g1");
  await writeFile(join(stage.stagingPath, "graph.db"), "graph");
  await publishGeneration({ stage, desiredStateHash: "6".repeat(64), rootIdentity: "7".repeat(64), verify: async value => stat(join(value, "graph.db")) });
  await assert.rejects(() => quarantineGeneration(root, "graph", "g1", false), /explicit approval/);
  const quarantined = await quarantineGeneration(root, "graph", "g1", true);
  assert.equal(await readFile(join(quarantined, "graph.db"), "utf8"), "graph");
  assert.equal((await readGenerationPointer(generationLaneRoot(root, "graph"), "current.json")).id, "g1");
});

test("retired architecture publication cannot redirect into a surviving lane", async () => {
  const root = await fixture();
  const source = join(root, "existing.db");
  await writeFile(source, "existing user store");
  assert.throws(() => generationLaneRoot(root, "architecture"), /Unknown prepared lane/);
  await assert.rejects(createGenerationStage(root, "architecture"), /Unknown prepared lane/);
  assert.throws(() => publishExistingArtifactGenerationSync({ root, lane: "architecture", sourcePath: source }), /Unknown prepared lane/);
  assert.equal(await readFile(source, "utf8"), "existing user store");
  await assert.rejects(stat(join(root, ".pi")), /ENOENT/, "refusal occurs before publication writes");
});

test("graph publication retains only current and last-good generations", async () => {
  const root = await fixture();
  const laneRoot = generationLaneRoot(root, "graph");
  const source = join(root, "source.db");
  await writeFile(source, "fixture graph");
  const publish = id => publishExistingArtifactGenerationSync({ root, lane: "graph", sourcePath: source, sourceRelative: "graph.db", desiredStateHash: id.repeat(32), rootIdentity: "a".repeat(64), id });
  publish("g1");
  publish("g2");
  const third = publish("g3");
  assert.deepEqual((await readdir(join(laneRoot, "generations"))).sort(), ["g2", "g3"]);
  assert.deepEqual(third.cleanup.removed, ["g1"]);
  assert.equal((await readGenerationPointer(laneRoot, "current.json")).id, "g3");
  assert.equal((await readGenerationPointer(laneRoot, "last-good.json")).id, "g2");
});

test("graph retention refuses a superseded generation outside the owned lane", async () => {
  const root = await fixture();
  const laneRoot = generationLaneRoot(root, "graph");
  const source = join(root, "source.db");
  const outside = join(root, "outside-generation");
  await writeFile(source, "fixture graph");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "sentinel"), "keep");
  const publish = id => publishExistingArtifactGenerationSync({ root, lane: "graph", sourcePath: source, sourceRelative: "graph.db", desiredStateHash: id.repeat(32), rootIdentity: "b".repeat(64), id });
  publish("g1");
  publish("g2");
  await writeFile(join(laneRoot, "last-good.json"), JSON.stringify({ version: 1, lane: "graph", id: "outside", desiredStateHash: "c".repeat(64), rootIdentity: "b".repeat(64), artifactPath: outside, publishedAt: new Date().toISOString(), predecessor: "absent", actorToken: "fixture" }));
  const third = publish("g3");
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "keep");
  assert.match(third.cleanup.warnings.join("\n"), /outside owned path/);
});
