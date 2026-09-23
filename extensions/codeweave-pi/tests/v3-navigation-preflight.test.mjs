import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { preflightNavigationTarget } from "../src/core/navigation-preflight.ts";

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-preflight-"));
}

async function touch(path, content = "x") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

test("preflight detects a normal repo without requiring writes", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "package.json"), JSON.stringify({ name: "demo" }));
  await touch(join(root, "src", "main.ts"), "export const value = 1;\n");
  await touch(join(root, "README.md"), "# Demo\n");
  await touch(join(root, ".pi-navigation.json"), JSON.stringify({ preparedIntelligence: {} }));

  const report = await preflightNavigationTarget(join(root, "src"));
  assert.equal(report.root, await realpath(root));
  assert.equal(report.rootConfidence, "high");
  assert.equal(report.projectShape, "single-package");
  assert.equal(report.config.exists, true);
  assert.equal(report.config.valid, true);
  assert.equal(report.source.files, 1);
  assert.equal(report.docs.files, 1);
  assert.ok(report.source.likelyRoots.includes("src"));
  assert.ok(report.docs.likelyRoots.includes("README.md"));
  assert.deepEqual(report.risks.filter(risk => risk.severity === "blocker"), []);
});

test("preflight prefers VCS root over nested package markers and flags monorepo ambiguity", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await touch(join(root, "packages", "one", "package.json"), JSON.stringify({ name: "one" }));
  await touch(join(root, "packages", "one", "src", "index.ts"), "export const one = 1;\n");
  await touch(join(root, "packages", "two", "package.json"), JSON.stringify({ name: "two" }));
  await touch(join(root, "packages", "two", "src", "index.ts"), "export const two = 2;\n");
  await touch(join(root, "docs", "overview.md"), "# Overview\n");

  const report = await preflightNavigationTarget(join(root, "packages", "one", "src"));
  assert.equal(report.root, await realpath(root));
  assert.equal(report.projectShape, "monorepo");
  assert.ok(report.monorepo.workspaceHints.includes("package.json workspaces"));
  assert.deepEqual(report.monorepo.packageRoots, ["packages/one", "packages/two"]);
  assert.ok(report.risks.some(risk => risk.kind === "ambiguous_scope"));
  assert.deepEqual(report.recommendedScopes, ["packages/one", "packages/two"]);
});

test("preflight gives a nested Git repository its own high-confidence root", async () => {
  const outer = await fixture();
  const nested = join(outer, "vendor", "nested-app");
  await mkdir(join(outer, ".git"));
  await touch(join(outer, "src", "outer.ts"), "export const outer = true;\n");
  await mkdir(join(nested, ".git"), { recursive: true });
  await touch(join(nested, "package.json"), JSON.stringify({ name: "nested-app" }));
  await touch(join(nested, "src", "nested.ts"), "export const nested = true;\n");

  const nestedReport = await preflightNavigationTarget(join(nested, "src"));
  const outerReport = await preflightNavigationTarget(join(outer, "src"));

  assert.equal(nestedReport.root, await realpath(nested));
  assert.equal(nestedReport.rootConfidence, "high");
  assert.equal(outerReport.root, await realpath(outer));
  assert.notEqual(nestedReport.root, outerReport.root);
});

test("preflight treats agent extensions as package-like scopes", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "agent", "extensions", "jeito-codeweave-pi", "package.json"), JSON.stringify({ name: "jeito-codeweave-pi" }));
  await touch(join(root, "agent", "extensions", "jeito-codeweave-pi", "src", "index.ts"), "export const nav = true;\n");
  await touch(join(root, "agent", "extensions", "other", "README.md"), "# Other\n");

  const report = await preflightNavigationTarget(root);

  assert.ok(report.monorepo.packageRoots.includes("agent/extensions/codeweave-pi"));
  assert.ok(report.recommendedScopes.includes("agent/extensions/codeweave-pi"));
});


test("preflight diagnoses docs-only and no-marker folders without mutation", async () => {
  const root = await fixture();
  await touch(join(root, "docs", "guide.md"), "# Guide\n");
  const report = await preflightNavigationTarget(root);
  assert.equal(report.root, await realpath(root));
  assert.equal(report.rootConfidence, "low");
  assert.equal(report.projectShape, "docs-only");
  assert.equal(report.source.files, 0);
  assert.equal(report.docs.files, 1);
  assert.ok(report.risks.some(risk => risk.kind === "no_project_root"));
  assert.ok(report.risks.some(risk => risk.kind === "no_source"));
  assert.ok(report.recommendedScopes.includes("docs"));
});

test("preflight blocks invalid project navigation config", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, ".pi-navigation.json"), "{ nope");
  await touch(join(root, "src", "main.ts"), "export {};\n");

  const report = await preflightNavigationTarget(root);
  assert.equal(report.config.exists, true);
  assert.equal(report.config.valid, false);
  assert.ok(report.risks.some(risk => risk.kind === "invalid_config" && risk.severity === "blocker"));
});

test("preflight flags large/noisy repos for scoped setup", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  for (let i = 0; i < 120; i++) await touch(join(root, "node_modules", `pkg${i}`, "noise.ts"), "export const noise = true;\n");

  const report = await preflightNavigationTarget(root, { maxSampleFiles: 10 });
  assert.ok(report.scan.skippedByDefault >= 1);
  assert.ok(report.generatedNoiseRatio > 0);
  assert.ok(report.risks.some(risk => risk.kind === "no_docs"));
});
