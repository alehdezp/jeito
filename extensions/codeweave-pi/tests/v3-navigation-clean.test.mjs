import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { cleanNavigation } from "../scripts/navigation-clean.mjs";

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-clean-"));
}

async function touch(file, content = "x") {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function makeRepo() {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { graph: { graphPath: "packages/core/graphify-out/graph.json" } } }));
  await touch(join(root, ".pi", "navigation-setup.log.jsonl"), `${JSON.stringify({ backend: "graphify", lane: "graph", writes: ["packages/core/graphify-out/graph.json"], command: ["graphify", "update", "packages/core"] })}\n`);
  await touch(join(root, ".pi", "navigation", "crg", "graph.db"));
  await touch(join(root, ".pi", "navigation", "qmd", "index.sqlite"), "{}\n");
  await touch(join(root, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, graphPath: "packages/core/graphify-out/graph.json" } }));
  await touch(join(root, "packages", "core", "graphify-out", "graph.json"));
  await touch(join(root, "unrecorded", "graphify-out", "graph.json"));
  await touch(join(root, "global-cache", "semble", "index.json"));
  return root;
}

test("navigation clean dry-run lists exact owned artifacts without deleting", async () => {
  const root = await makeRepo();
  const result = await cleanNavigation(["--path", root, "--dry-run"]);
  const paths = result.planned.map(item => item.path).sort();

  assert.equal(result.mode, "dry-run");
  assert.deepEqual(paths, [
    ".pi/navigation-setup.log.jsonl",
    ".pi/navigation/qmd",
    ".pi/navigation/state.json",
    "packages/core/graphify-out",
  ]);
  assert.equal(existsSync(join(root, "packages", "core", "graphify-out", "graph.json")), true);
  assert.equal(existsSync(join(root, "unrecorded", "graphify-out", "graph.json")), true);
  assert.equal(existsSync(join(root, "global-cache", "semble", "index.json")), true);
});

test("navigation clean apply removes only recorded harness-owned artifacts", async () => {
  const root = await makeRepo();
  const result = await cleanNavigation(["--path", root, "--apply"]);

  assert.equal(result.status, "success");
  assert.equal(existsSync(join(root, ".pi", "navigation", "state.json")), false);
  assert.equal(existsSync(join(root, ".pi", "navigation-setup.log.jsonl")), false);
  assert.equal(await readFile(join(root, ".pi", "navigation", "crg", "graph.db"), "utf8"), "x", "retirement never deletes existing code stores");
  assert.equal(existsSync(join(root, ".pi", "navigation", "qmd")), false);
  assert.equal(existsSync(join(root, "packages", "core", "graphify-out")), false);
  assert.equal(existsSync(join(root, "unrecorded", "graphify-out", "graph.json")), true);
  assert.equal(existsSync(join(root, "global-cache", "semble", "index.json")), true);
  assert.equal(existsSync(join(root, ".pi-navigation.json")), true);
});

test("navigation clean lane graph only removes recorded graphify-out", async () => {
  const root = await makeRepo();
  const result = await cleanNavigation(["--path", root, "--lane", "graph", "--apply"]);

  assert.deepEqual(result.removed.map(item => item.path), ["packages/core/graphify-out"]);
  assert.equal(existsSync(join(root, "packages", "core", "graphify-out")), false);
  assert.equal(existsSync(join(root, ".pi", "navigation", "state.json")), true);
  assert.equal(existsSync(join(root, ".pi", "navigation-setup.log.jsonl")), true);
  assert.equal(existsSync(join(root, "unrecorded", "graphify-out", "graph.json")), true);
});

test("navigation clean cannot remove immutable Graphify generations or current pointers", async () => {
  const root = await makeRepo();
  const generation = join(root, ".pi", "navigation", "graphify", "generations", "verified-one");
  await touch(join(generation, "graph.json"), JSON.stringify({ nodes: [], edges: [] }));
  await touch(join(generation, "manifest.json"), JSON.stringify({}));
  await touch(join(root, ".pi", "navigation", "graphify", "current.json"), JSON.stringify({ id: "verified-one", artifactPath: generation }));
  const result = await cleanNavigation(["--path", root, "--lane", "graph", "--apply"]);
  assert.deepEqual(result.removed.map(item => item.path), ["packages/core/graphify-out"]);
  assert.equal(existsSync(join(generation, "graph.json")), true);
  assert.equal(existsSync(join(generation, "manifest.json")), true);
  assert.equal(existsSync(join(root, ".pi", "navigation", "graphify", "current.json")), true);
});

test("navigation clean CLI emits JSON and package script exists", async () => {
  const root = await makeRepo();
  const run = spawnSync(process.execPath, ["scripts/navigation-clean.mjs", "--path", root, "--lane", "graph", "--dry-run", "--json"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.mode, "dry-run");
  assert.deepEqual(parsed.artifacts, ["packages/core/graphify-out"]);

  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["nav:clean"], "node scripts/navigation-clean.mjs");
});

test("retired architecture cleanup is refused before filesystem mutation", async () => {
  const root = await makeRepo();
  await assert.rejects(cleanNavigation(["--path", root, "--lane", "architecture", "--apply"]), /unknown lane/);
  await assert.rejects(cleanNavigation({ path: root, lane: "architecture", apply: true }), /unknown lane/);
  assert.equal(await readFile(join(root, ".pi", "navigation", "crg", "graph.db"), "utf8"), "x");
});
