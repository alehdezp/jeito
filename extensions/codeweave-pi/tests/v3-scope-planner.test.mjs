import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { preflightNavigationTarget } from "../src/core/navigation-preflight.ts";
import { planNavigationScope } from "../src/core/scope-planner.ts";

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-scope-"));
}

async function touch(path, content = "x") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

test("scope planner auto-selects clear single-package source roots", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "read.ts"), "export function read() {}\n");
  await touch(join(root, "docs", "overview.md"), "# Overview\n");

  const preflight = await preflightNavigationTarget(root);
  const plan = planNavigationScope(preflight, { query: "Where does file reading start?" });
  assert.equal(plan.root, preflight.root);
  assert.equal(plan.mode, "auto");
  assert.equal(plan.confidence, "high");
  assert.ok(plan.selectedScopes.includes("src"));
  assert.ok(plan.excluded.includes("node_modules"));
  assert.ok(plan.excluded.includes("graphify-out"));
  assert.equal(plan.blockers.length, 0);
});

test("scope planner auto-selects docs roots for docs lane", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "README.md"), "# Demo\n");
  await touch(join(root, "docs", "guide.md"), "# Guide\n");

  const preflight = await preflightNavigationTarget(root);
  const plan = planNavigationScope(preflight, { lane: "docs", query: "How do docs connect?" });
  assert.equal(plan.mode, "auto");
  assert.equal(plan.confidence, "high");
  assert.ok(plan.selectedScopes.includes("README.md"));
  assert.ok(plan.selectedScopes.includes("docs"));
});

test("scope planner uses explicit project includes and excludes", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "packages", "core", "src", "main.ts"), "export {};\n");

  const preflight = await preflightNavigationTarget(root);
  const plan = planNavigationScope(preflight, {
    projectScope: { include: ["packages/core", "docs"], exclude: ["fixtures/noisy"] },
  });
  assert.equal(plan.mode, "auto");
  assert.equal(plan.confidence, "high");
  assert.deepEqual(plan.selectedScopes, ["packages/core", "docs"]);
  assert.ok(plan.excluded.includes("fixtures/noisy"));
  assert.ok(plan.excluded.includes("target"));
});

test("scope planner does not substitute project include when explicit path is outside override", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "agent", "extensions", "jeito-codeweave-pi", "src", "main.ts"), "export {};\n");
  await touch(join(root, "agent", "extensions", "time-context", "index.ts"), "export {};\n");

  const preflight = await preflightNavigationTarget(join(root, "agent", "extensions", "time-context"));
  const plan = planNavigationScope(preflight, {
    projectScope: { include: ["agent/extensions/codeweave-pi"] },
  });

  assert.equal(plan.mode, "guided");
  assert.equal(plan.confidence, "medium");
  assert.deepEqual(plan.selectedScopes, ["agent/extensions/time-context"]);
  assert.match(plan.reason, /outside project scope override/);
});


test("scope planner infers monorepo package from normal human query", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await touch(join(root, "packages", "core", "package.json"), JSON.stringify({ name: "core" }));
  await touch(join(root, "packages", "core", "src", "read.ts"), "export function read() {}\n");
  await touch(join(root, "packages", "api", "package.json"), JSON.stringify({ name: "api" }));
  await touch(join(root, "packages", "api", "src", "server.ts"), "export function serve() {}\n");

  const preflight = await preflightNavigationTarget(root);
  const plan = planNavigationScope(preflight, { query: "Help me understand packages/core file reading" });
  assert.equal(plan.mode, "auto");
  assert.equal(plan.confidence, "high");
  assert.deepEqual(plan.selectedScopes, ["packages/core"]);
  assert.equal(plan.queryMatchedScope, "packages/core");
});

test("scope planner asks for ambiguous monorepo scope unless policy allows whole repo", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
  await touch(join(root, "apps", "web", "package.json"), JSON.stringify({ name: "web" }));
  await touch(join(root, "apps", "web", "src", "app.ts"), "export {};\n");
  await touch(join(root, "packages", "core", "package.json"), JSON.stringify({ name: "core" }));
  await touch(join(root, "packages", "core", "src", "core.ts"), "export {};\n");

  const preflight = await preflightNavigationTarget(root);
  const guided = planNavigationScope(preflight, { query: "Help me understand this repo" });
  assert.equal(guided.mode, "guided");
  assert.equal(guided.confidence, "low");
  assert.ok(guided.reason.includes("ambiguous"));
  assert.deepEqual(guided.selectedScopes, ["apps/web", "packages/core"]);

  const wholeRepo = planNavigationScope(preflight, { monorepoMode: "whole-repo" });
  assert.equal(wholeRepo.mode, "auto");
  assert.deepEqual(wholeRepo.selectedScopes, ["."]);
});

test("scope planner blocks invalid config and allows clear no-marker code folders", async () => {
  const invalid = await fixture();
  await mkdir(join(invalid, ".git"));
  await touch(join(invalid, ".pi-navigation.json"), "{ nope");
  await touch(join(invalid, "src", "main.ts"), "export {};\n");
  const invalidPlan = planNavigationScope(await preflightNavigationTarget(invalid));
  assert.equal(invalidPlan.mode, "blocked");
  assert.ok(invalidPlan.blockers.some(message => /invalid/.test(message)));

  const loose = await fixture();
  await touch(join(loose, "src", "main.ts"), "export {};\n");
  const loosePlan = planNavigationScope(await preflightNavigationTarget(loose));
  assert.equal(loosePlan.mode, "auto");
  assert.equal(loosePlan.confidence, "high");
  assert.deepEqual(loosePlan.selectedScopes, ["src"]);
});
