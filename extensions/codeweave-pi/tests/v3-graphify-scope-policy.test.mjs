import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FULL_STACK_NAVIGATION_AUTOMATION_CONFIG, mergeAutomationConfig, DEFAULT_NAVIGATION_AUTOMATION_CONFIG } from "../src/core/navigation-automation-config.ts";
import { preflightNavigationTarget } from "../src/core/navigation-preflight.ts";
import { planGraphifyScope } from "../src/core/graphify-scope-policy.ts";
import { planNavigationScope } from "../src/core/scope-planner.ts";

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-graphify-policy-"));
}

async function touch(path, content = "x") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

test("Graphify update remains automatic for a concrete clear local scope when explicitly selected", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  const preflight = await preflightNavigationTarget(root);
  const scopePlan = planNavigationScope(preflight);
  const policy = planGraphifyScope(preflight, scopePlan, { mode: "update", graphifyBin: "/bin/graphify" });
  assert.equal(policy.ok, true);
  assert.equal(policy.policy, "auto");
  assert.equal(policy.mode, "update");
  assert.deepEqual(policy.command, ["/bin/graphify", "update", "src"]);
  assert.equal(policy.outDir, join(preflight.root, ".pi", "navigation", "graphify"));
  assert.equal(policy.cwd, preflight.root);
  assert.ok(policy.writes.some(write => write.endsWith(".pi/navigation/graphify/graphify-out/graph.json")));
  assert.ok(policy.qualityGates.some(gate => /top leads/.test(gate)));
});

test("Graphify update asks for one package when monorepo scope is ambiguous", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await touch(join(root, "packages", "core", "package.json"), JSON.stringify({ name: "core" }));
  await touch(join(root, "packages", "core", "src", "index.ts"), "export {};\n");
  await touch(join(root, "packages", "api", "package.json"), JSON.stringify({ name: "api" }));
  await touch(join(root, "packages", "api", "src", "index.ts"), "export {};\n");
  const preflight = await preflightNavigationTarget(root);
  const scopePlan = planNavigationScope(preflight, { query: "Help me understand this repo" });
  const policy = planGraphifyScope(preflight, scopePlan, { mode: "update", graphifyBin: "/owned/graphify" });
  assert.equal(policy.policy, "guided");
  assert.ok(policy.warnings.some(message => /monorepo scope is ambiguous|choose a package scope/i.test(message)));
});

test("Graphify update follows query-inferred monorepo package scope", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await touch(join(root, "packages", "core", "package.json"), JSON.stringify({ name: "core" }));
  await touch(join(root, "packages", "core", "src", "read.ts"), "export {};\n");
  await touch(join(root, "packages", "api", "package.json"), JSON.stringify({ name: "api" }));
  await touch(join(root, "packages", "api", "src", "server.ts"), "export {};\n");
  const preflight = await preflightNavigationTarget(root);
  const scopePlan = planNavigationScope(preflight, { query: "Where does core file reading start?" });
  const policy = planGraphifyScope(preflight, scopePlan, { mode: "update", graphifyBin: "/owned/graphify" });
  assert.equal(policy.policy, "auto");
  assert.deepEqual(policy.command, ["/owned/graphify", "update", "packages/core"]);
  assert.equal(policy.outDir, join(preflight.root, ".pi", "navigation", "graphify"));
});

test("Graphify update blocks when native visible output is disallowed", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  const preflight = await preflightNavigationTarget(root);
  const scopePlan = planNavigationScope(preflight);
  const config = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, { storage: { allowVisibleProjectDirs: false, allowBackendNativeDirs: false } });
  const policy = planGraphifyScope(preflight, scopePlan, { mode: "update", config });
  assert.equal(policy.policy, "blocked");
  assert.ok(policy.blockers.some(message => /\.pi\/navigation\/graphify|graphify-out/.test(message)));
});

test("Graphify deep extraction requires configured LLM/provider policy", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  const preflight = await preflightNavigationTarget(root);
  const scopePlan = planNavigationScope(preflight);

  // Deep extraction must be blocked when LLM is explicitly disabled, even though
  // the bundled default enables semantic providers. Test with an explicit allowLLM:false config.
  const noLlmConfig = { ...DEFAULT_NAVIGATION_AUTOMATION_CONFIG, providers: { ...DEFAULT_NAVIGATION_AUTOMATION_CONFIG.providers, allowLLM: false } };
  const blocked = planGraphifyScope(preflight, scopePlan, { mode: "deepExtract", config: noLlmConfig, provider: "openai" });
  assert.equal(blocked.policy, "blocked");
  assert.ok(blocked.blockers.some(message => /allowLLM/.test(message)));

  const allowed = planGraphifyScope(preflight, scopePlan, { mode: "deepExtract", config: FULL_STACK_NAVIGATION_AUTOMATION_CONFIG, provider: "openai", env: { OPENAI_API_KEY: "set" }, graphifyBin: "/owned/graphify" });
  assert.equal(allowed.policy, "auto");
  assert.equal(allowed.provider, "openai");
  assert.deepEqual(allowed.command?.slice(0, 7), ["/owned/graphify", "extract", "src", "--mode", "deep", "--backend", "openai"]);
  assert.ok(allowed.command?.includes("--out"));
  assert.ok(allowed.outDir?.endsWith(join(".pi", "navigation", "graphify")));
  assert.ok(allowed.writes.some(write => write.endsWith("graphify-out/graph.json")));
});

test("Graphify deep extraction expands clean single-package src scope to include root docs", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "package.json"), JSON.stringify({ name: "with-docs" }));
  await touch(join(root, "README.md"), "# With Docs\n\nRoot docs should enrich Graphify deep extraction.\n");
  await touch(join(root, "src", "main.ts"), "export {};\n");
  const preflight = await preflightNavigationTarget(root);
  const scopePlan = planNavigationScope(preflight);

  const policy = planGraphifyScope(preflight, scopePlan, { mode: "deepExtract", config: FULL_STACK_NAVIGATION_AUTOMATION_CONFIG, provider: "deepseek", env: { DEEPSEEK_API_KEY: "set" }, graphifyBin: "/owned/graphify" });
  assert.equal(policy.policy, "auto");
  assert.equal(policy.scope, ".");
  assert.deepEqual(policy.command?.slice(0, 7), ["/owned/graphify", "extract", ".", "--mode", "deep", "--backend", "deepseek"]);
  const modelIndex = policy.command?.indexOf("--model") ?? -1;
  assert.ok(modelIndex >= 0, "the bundled DeepSeek default must select its provider-specific model");
  assert.equal(policy.command?.[modelIndex + 1], "deepseek-v4-flash");
  assert.equal(policy.command?.includes("gpt-4o"), false, "DeepSeek must not inherit an OpenAI model");
});
