import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { callTool, registerCleanPi, tempProject } from "./_clean-navigation-helper.mjs";
import {
  artifactLaneFlags,
  owningPreparedRoot,
  preparedProjectsAnnotation,
  readPreparedProjectsTable,
  recheckPreparedProjectsTable,
  scopeLiteral,
  upsertPreparedProject,
} from "../src/core/prepared-projects-registry.ts";
import { canonicalNavigationPath } from "../src/core/navigation-corpus-policy.ts";

// The global prepared-projects table is an observation cache: annotations it
// feeds are gated on real lane admission, so a broken project must stay
// silent everywhere, and unprepared fixtures must never grow a footer.

async function tempHome() {
  return mkdir(join(tmpdir(), `prepared-registry-${Math.random().toString(36).slice(2)}`), { recursive: true });
}

test("registry upsert, artifact flags, and recheck removal", async () => {
  const home = await tempHome();
  const tablePath = join(home, "prepared-projects.json");
  const project = join(home, "proj");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, ".pi-navigation.json"), JSON.stringify({ architecture: { enabled: true }, docs: { enabled: true } }));

  upsertPreparedProject(project, "test:upsert", tablePath);
  let table = readPreparedProjectsTable(tablePath);
  const key = Object.keys(table.projects)[0];
  assert.equal(Object.keys(table.projects).length, 1);
  assert.deepEqual(table.projects[key].lanes, { docs: false, graph: false }, "declared lanes without artifacts are not ready in the cache");

  await mkdir(join(project, ".code-review-graph"), { recursive: true });
  await writeFile(join(project, ".code-review-graph", "graph.db"), "");
  assert.equal(artifactLaneFlags(project).architecture, undefined, "retired store presence cannot advertise code readiness");

  upsertPreparedProject(project, "test:refresh", tablePath);
  table = readPreparedProjectsTable(tablePath);
  assert.equal(table.projects[key].lanes.architecture, undefined);
  assert.equal(table.projects[key].source, "test:refresh");

  await rm(join(project, ".pi-navigation.json"));
  const { removed, checked } = recheckPreparedProjectsTable(tablePath);
  assert.equal(removed, 1, "vanished configs are dropped by the startup recheck");
  assert.equal(checked, 0);
});

test("owningPreparedRoot walks to the nearest own config and scopeLiteral picks relative form", async () => {
  const home = await tempHome();
  const project = join(home, "proj");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, ".pi-navigation.json"), "{}");
  assert.equal(owningPreparedRoot(join(project, "src", "a.ts")), canonicalNavigationPath(project));
  assert.equal(owningPreparedRoot(join(home, "elsewhere", "b.ts")), undefined, "no own config anywhere means no owning project");
  assert.equal(scopeLiteral(project, home), "proj");
  assert.equal(scopeLiteral(project, join(home, "other")), project, "paths outside cwd stay absolute");
});

test("annotation stays silent for a project with no admitted lane", async () => {
  const home = await tempHome();
  const tablePath = join(home, "prepared-projects.json");
  const project = join(home, "proj");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, ".pi-navigation.json"), "{}");
  const cwd = join(home, "work");
  await mkdir(cwd, { recursive: true });
  const annotation = await preparedProjectsAnnotation([join(project, "src", "a.ts")], cwd, "result", tablePath);
  assert.equal(annotation, "", "config without any ready lane must not be advertised");
});

test("annotation advertises a ready docs lane with its scope and tool", async () => {
  const home = await tempHome();
  const tablePath = join(home, "prepared-projects.json");
  const project = join(home, "proj");
  await mkdir(join(project, ".pi", "navigation", "qmd"), { recursive: true });
  await writeFile(join(project, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { docs: { enabled: true, backend: "qmd", status: "ready", indexPath: ".pi/navigation/qmd" } } }));
  await writeFile(join(project, ".pi-navigation.json"), JSON.stringify({ docs: { enabled: true, backend: "qmd", repo: "local/proj", indexPath: ".pi/navigation/qmd" } }));
  const cwd = join(home, "work");
  await mkdir(cwd, { recursive: true });
  upsertPreparedProject(project, "test:ready", tablePath);
  const annotation = await preparedProjectsAnnotation([join(project, "docs", "guide.md")], cwd, "result", tablePath);
  assert.match(annotation, /Other queryable project\(s\) in this result/);
  assert.match(annotation, /docs✓/);
  assert.match(annotation, /query with scope:/);
  assert.match(annotation, /docs_search/);
});

test("live tools stay silent on unprepared fixtures", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("prepared-registry-silence-");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "a.ts"), "target\n");
  for (const [tool, params] of [
    ["ls", {}],
    ["find", { pattern: "*.ts" }],
    ["grep", { pattern: "target", paths: "src" }],
    ["read", { path: join(cwd, "src", "a.ts") }],
  ]) {
    const text = await callTool(pi, cwd, tool, params);
    assert.doesNotMatch(text, /Other queryable project/, `${tool} must not annotate unprepared fixtures`);
  }
});
