import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { detectProjectRoot, inspectNavigation, writeBootstrap } from "../scripts/navigation-doctor.mjs";

async function fixture(prefix = "pi-nav-enterprise-") {
  return mkdtemp(join(tmpdir(), prefix));
}

test("enterprise matrix: monorepo nested invocation prefers VCS/config root over package marker", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "monorepo" }));
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: false } }));
  await mkdir(join(root, "packages", "app", "src"), { recursive: true });
  await writeFile(join(root, "packages", "app", "package.json"), JSON.stringify({ name: "app" }));

  assert.equal(detectProjectRoot(join(root, "packages", "app", "src")), root);
  const report = inspectNavigation(join(root, "packages", "app", "src"), { env: { PATH: "" } });
  assert.equal(report.root, root);
  assert.equal(report.config.exists, true);
});

test("enterprise matrix: no-git/no-marker folder is diagnosed without config writes unless requested", async () => {
  const root = await fixture();
  await mkdir(join(root, "scratch"), { recursive: true });
  const report = inspectNavigation(join(root, "scratch"), { env: { PATH: "" } });
  assert.equal(report.root, join(root, "scratch"));
  assert.equal(report.config.exists, false);
  assert.ok(report.next_actions.some(action => action.includes("navigation-doctor")));
  assert.equal(existsSync(join(root, "scratch", ".pi-navigation.json")), false);
});

test("enterprise matrix: symlinked repo roots remain diagnosable", async () => {
  const parent = await fixture();
  const realRoot = join(parent, "real-repo");
  const linkRoot = join(parent, "link-repo");
  await mkdir(join(realRoot, ".git"), { recursive: true });
  await mkdir(join(realRoot, "src"), { recursive: true });
  await writeFile(join(realRoot, "README.md"), "# Symlink Repo\n");
  await symlink(realRoot, linkRoot, "dir");

  const report = inspectNavigation(join(linkRoot, "src"), { env: { PATH: "" } });
  assert.equal(report.root, linkRoot);
  assert.equal(report.config.exists, false);
  assert.ok(report.lanes.some(lane => lane.name === "docs"));
});

test("enterprise matrix: bootstrap preserves lane disablement when tools/indexes are missing", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "README.md"), "# Bootstrap Missing Tools\n");
  const report = writeBootstrap(root, { env: { PATH: "" } });
  assert.equal(report.status, "warning");
  assert.equal(report.lanes.some(lane => lane.name === "architecture"), false, "the retired architecture lane must not be reported");
  const docs = report.lanes.find(lane => lane.name === "docs");
  const graph = report.lanes.find(lane => lane.name === "graph");
  assert.equal(docs.status, "disabled");
  assert.equal(graph.status, "disabled");
  assert.ok(report.writes.some(file => file.endsWith(".pi-navigation.json")));
});
