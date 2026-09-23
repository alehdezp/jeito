import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  DEFAULT_NAVIGATION_AUTOMATION_CONFIG,
  FULL_STACK_NAVIGATION_AUTOMATION_CONFIG,
  mergeAutomationConfig,
} from "../src/core/navigation-automation-config.ts";
import { preflightNavigationTarget } from "../src/core/navigation-preflight.ts";
import { planNavigationSetup } from "../src/core/navigation-setup-planner.ts";

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-setup-plan-"));
}

async function touch(path, content = "x") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

function byBackend(plan, backend) {
  return plan.actions.find(action => action.backend === backend);
}

test("setup planner makes verified local lanes automatic under default auto-local config", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  await touch(join(root, "docs", "overview.md"), "# Overview\n");
  const preflight = await preflightNavigationTarget(root);
  // Selected policy A: Graphify is opt-in, so the machine lane is named explicitly.
  const config = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    backends: { graph: { primary: "graphify", mode: "deepExtract", deepMode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash" } },
  });
  const plan = planNavigationSetup(preflight, config, {
    query: "Help me understand this repo",
    installedBackends: { qmd: true, graphify: true },
    env: {},
  });

  assert.equal(plan.policy, "guided", "Graphify remains guided until its provider acceptance is configured");
  assert.equal(byBackend(plan, "qmd").modeName, "hybridDocs");
  assert.equal(byBackend(plan, "qmd").policy, "auto");
  assert.equal(byBackend(plan, "qmd").scope, "docs");
  assert.deepEqual(byBackend(plan, "qmd").backendCommand, byBackend(plan, "qmd").command);
  assert.equal(byBackend(plan, "graphify").modeName, "deepExtract");
  assert.equal(byBackend(plan, "graphify").policy, "guided");
  assert.ok(plan.nextMessages.some(message => /Can run automatically/.test(message)));
});


test("setup planner points docs lane at root README instead of generic source scope", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  await touch(join(root, "README.md"), "# Demo\n");
  const preflight = await preflightNavigationTarget(root);

  const plan = planNavigationSetup(preflight, DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    query: "Help me understand this repo",
    requestedBackends: ["qmd"],
    installedBackends: { qmd: true },
    env: {},
  });
  const docs = byBackend(plan, "qmd");

  assert.equal(plan.scopePlan.selectedScopes[0], "src", "generic code scope should still be source-oriented");
  assert.equal(docs.policy, "auto");
  assert.equal(docs.modeName, "hybridDocs");
  assert.equal(docs.scope, ".");
  assert.deepEqual(docs.command.slice(0, 5), ["node", "scripts/navigation-freshen.mjs", "docs", "--path", preflight.root]);
  assert.equal(docs.backendCommand[docs.backendCommand.indexOf("--path") + 1], preflight.root);
  assert.doesNotMatch(JSON.stringify(docs.command), /--scope","src|--scope src/, "docs lane must not inherit source-only scope");
});

test("setup planner confirmation prompt names scope writes risks gates undo and retry", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  await touch(join(root, "README.md"), "# Demo\n");
  const preflight = await preflightNavigationTarget(root);
  const config = mergeAutomationConfig(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG, {
    providers: { defaultLLMProvider: "openai", defaultEmbeddingProvider: "openai" },
  });

  const plan = planNavigationSetup(preflight, config, {
    fullStack: true,
    installedBackends: { graphify: true, qmd: true },
    requestedBackends: ["graphify", "qmd"],
    env: { OPENAI_API_KEY: "set", ZEROENTROPY_API_KEY: "set" },
  });

  assert.equal(typeof plan.confirmationPrompt, "string");
  assert.match(plan.confirmationPrompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), plan.confirmationPrompt);
  assert.match(plan.confirmationPrompt, /Scope:/);
  assert.match(plan.confirmationPrompt, /Expected writes:/);
  assert.match(plan.confirmationPrompt, /Audit log: .*\.pi\/navigation-setup\.log\.jsonl/);
  assert.match(plan.confirmationPrompt, /Provider\/model\/network risk:/);
  assert.match(plan.confirmationPrompt, /openai|provider|model|network/i);
  assert.match(plan.confirmationPrompt, /Quality gates:/);
  assert.match(plan.confirmationPrompt, /Undo\/retry:/);
});

test("setup planner uses full-stack rich docs and Graphify deep mode when provider policy allows", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  await touch(join(root, "README.md"), "# Demo\n");
  const preflight = await preflightNavigationTarget(root);
  const config = mergeAutomationConfig(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG, {
    providers: { defaultLLMProvider: "openai", defaultEmbeddingProvider: "openai" },
  });
  const plan = planNavigationSetup(preflight, config, {
    fullStack: true,
    installedBackends: { qmd: true, graphify: true },
    env: { OPENAI_API_KEY: "set", ZEROENTROPY_API_KEY: "set", DEEPSEEK_API_KEY: "set" },
  });

  const docs = byBackend(plan, "qmd");
  assert.equal(docs.modeName, "hybridDocs");
  assert.equal(docs.policy, "auto");
  assert.deepEqual(docs.command.slice(0, 4), ["node", "scripts/navigation-freshen.mjs", "docs", "--path"]);
  assert.deepEqual(docs.backendCommand, docs.command, "direct MCP setup must be represented by its real lifecycle command rather than a fabricated shell tools/call command");
  assert.equal(docs.backendCommand.includes("tools/call:index_local"), false);
  assert.ok(docs.providers.includes("zeroentropy"));

  const graph = byBackend(plan, "graphify");
  assert.equal(graph.modeName, "deepExtract");
  assert.equal(graph.policy, "auto");
  assert.deepEqual(graph.command.slice(0, 5), ["node", "scripts/navigation-freshen.mjs", "graph", "--path", preflight.root]);
  assert.equal(graph.command.includes("--scope"), false, "root-expanded Graphify freshen should not pass a redundant --scope");
  assert.equal(basename(graph.backendCommand[0]), "graphify");
  assert.deepEqual(graph.backendCommand.slice(1, 7), ["extract", ".", "--mode", "deep", "--backend", "deepseek"]);
  assert.equal(graph.command[graph.command.indexOf("--graphify-mode") + 1], "deep");
  assert.equal(graph.command[graph.command.indexOf("--graphify-provider") + 1], "deepseek");
  assert.equal(graph.command[graph.command.indexOf("--graphify-model") + 1], "deepseek-v4-flash");
  assert.ok(graph.writes.some(write => write.includes("graphify-out/graph.json")));

});

test("setup planner supports docs embeddings without LLM summaries", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "README.md"), "# Demo\n");
  const preflight = await preflightNavigationTarget(root);
  const config = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    automation: { mode: "aggressive", autoRefreshOnStop: "aggressive" },
    providers: { allowCloud: true, allowEmbeddings: true, allowLLM: false, defaultEmbeddingProvider: "openai" },
    backends: { docs: { mode: "hybridDocs", embeddingProvider: "zeroentropy", aiSummaries: false } },
  });

  const plan = planNavigationSetup(preflight, config, {
    trigger: "stop_refresh",
    requestedBackends: ["qmd"],
    installedBackends: { qmd: true },
    env: { OPENAI_API_KEY: "set", ZEROENTROPY_API_KEY: "set" },
  });

  const docs = byBackend(plan, "qmd");
  assert.equal(docs.modeName, "hybridDocs");
  assert.equal(docs.policy, "auto", JSON.stringify(docs.reasons));
  assert.deepEqual(docs.backendCommand, docs.command);
  assert.equal(docs.providers.includes("zeroentropy"), true);
});

test("session lifecycle automatically degrades QMD preparation to lexical when semantic provider policy rejects ZeroEntropy", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "README.md"), "# Demo\n");
  const preflight = await preflightNavigationTarget(root);
  const config = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    automation: { mode: "aggressive" },
    providers: { allowCloud: true, allowEmbeddings: true, allowed: ["openai"] },
    backends: { docs: { mode: "hybridDocs", embeddingProvider: "zeroentropy" } },
  });

  const plan = planNavigationSetup(preflight, config, {
    trigger: "session_start",
    requestedBackends: ["qmd"],
    installedBackends: { qmd: true },
    env: { ZEROENTROPY_API_KEY: "present-but-disallowed" },
  });
  const docs = byBackend(plan, "qmd");
  assert.equal(docs.modeName, "lexicalDocs");
  assert.equal(docs.policy, "auto", JSON.stringify(docs.reasons));
  assert.deepEqual(docs.providers, []);
  assert.deepEqual(docs.command.slice(docs.command.indexOf("--use-embeddings"), docs.command.indexOf("--use-embeddings") + 2), ["--use-embeddings", "false"]);
});

test("manual keyless QMD setup uses the models installed with codeweave-pi without a download prompt", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "README.md"), "# Demo\n");
  const preflight = await preflightNavigationTarget(root);
  const plan = planNavigationSetup(preflight, DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    trigger: "manual_prepare",
    requestedBackends: ["qmd"],
    installedBackends: { qmd: true },
    env: {},
  });
  const docs = byBackend(plan, "qmd");
  assert.equal(docs.policy, "auto");
  assert.deepEqual(docs.providers, ["local"]);
  assert.deepEqual(docs.command.slice(docs.command.indexOf("--docs-provider"), docs.command.indexOf("--docs-provider") + 2), ["--docs-provider", "local"]);
  assert.doesNotMatch(plan.confirmationPrompt, /928 MiB|model download/i);
  assert.match(docs.reasons.join(" "), /installed local embedding and reranker models/i);
});

test("keyless session startup uses installed local QMD even when further local downloads are disabled", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "README.md"), "# Demo\n");
  const preflight = await preflightNavigationTarget(root);
  const config = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, { providers: { allowLocalModelDownloads: false } });
  const plan = planNavigationSetup(preflight, config, {
    trigger: "session_start",
    requestedBackends: ["qmd"],
    installedBackends: { qmd: true },
    env: {},
  });
  const docs = byBackend(plan, "qmd");
  assert.equal(docs.modeName, "hybridDocs");
  assert.equal(docs.policy, "auto", JSON.stringify(docs.reasons));
  assert.deepEqual(docs.providers, ["local"]);
  assert.deepEqual(docs.command.slice(docs.command.indexOf("--docs-provider"), docs.command.indexOf("--docs-provider") + 2), ["--docs-provider", "local"]);
});

test("session startup selects Voyage when it is the only configured QMD API credential", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "README.md"), "# Demo\n");
  const preflight = await preflightNavigationTarget(root);
  const plan = planNavigationSetup(preflight, DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    trigger: "session_start",
    requestedBackends: ["qmd"],
    installedBackends: { qmd: true },
    env: { VOYAGE_API_KEY: "configured" },
  });
  const docs = byBackend(plan, "qmd");
  assert.equal(docs.modeName, "hybridDocs");
  assert.equal(docs.policy, "auto", JSON.stringify(docs.reasons));
  assert.deepEqual(docs.providers, ["voyage"]);
});

test("persisted OpenRouter QMD choice uses the configured OpenRouter credential", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "README.md"), "# Demo\n");
  await touch(join(root, ".pi-navigation.json"), JSON.stringify({ docs: { embeddingProvider: "openrouter" } }));
  const preflight = await preflightNavigationTarget(root);
  const plan = planNavigationSetup(preflight, DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    trigger: "session_start",
    requestedBackends: ["qmd"],
    installedBackends: { qmd: true },
    env: { OPENROUTER_API_KEY: "configured" },
  });
  const docs = byBackend(plan, "qmd");
  assert.equal(docs.policy, "auto", JSON.stringify(docs.reasons));
  assert.deepEqual(docs.providers, ["openrouter"]);
  assert.deepEqual(docs.command.slice(docs.command.indexOf("--docs-provider"), docs.command.indexOf("--docs-provider") + 2), ["--docs-provider", "openrouter"]);
});

test("a persisted local QMD choice remains semantic during credential-free lifecycle refresh", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "README.md"), "# Demo\n");
  await touch(join(root, ".pi-navigation.json"), JSON.stringify({ docs: { embeddingProvider: "local" } }));
  const preflight = await preflightNavigationTarget(root);
  const plan = planNavigationSetup(preflight, DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    trigger: "session_start",
    requestedBackends: ["qmd"],
    installedBackends: { qmd: true },
    env: {},
  });
  const docs = byBackend(plan, "qmd");
  assert.equal(docs.modeName, "hybridDocs");
  assert.equal(docs.policy, "auto", JSON.stringify(docs.reasons));
  assert.deepEqual(docs.providers, ["local"]);
  assert.deepEqual(docs.command.slice(docs.command.indexOf("--docs-provider"), docs.command.indexOf("--docs-provider") + 2), ["--docs-provider", "local"]);
});


test("setup planner uses Graphify rich incremental update on aggressive stop-refresh when provider policy allows and an owned graph exists", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  await touch(join(root, "README.md"), "# Demo\n");
  await mkdir(join(root, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await touch(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), JSON.stringify({ nodes: [], edges: [] }));
  const preflight = await preflightNavigationTarget(root);
  const config = mergeAutomationConfig(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG, {
    automation: { mode: "aggressive", autoRefreshOnStop: "aggressive" },
    providers: { defaultLLMProvider: "deepseek", defaultEmbeddingProvider: "openai" },
    backends: {
      docs: { mode: "hybridDocs", aiSummaries: "auto", embeddingProvider: "zeroentropy", summarizerProvider: "openai" },
      graph: { mode: "deepExtract", deepMode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash" },
    },
  });

  const plan = planNavigationSetup(preflight, config, {
    trigger: "stop_refresh",
    fullStack: true,
    installedBackends: { qmd: true, graphify: true },
    env: { OPENAI_API_KEY: "set", ZEROENTROPY_API_KEY: "set", DEEPSEEK_API_KEY: "set" },
  });

  const graph = byBackend(plan, "graphify");
  assert.equal(graph.modeName, "richUpdate");
  assert.equal(graph.policy, "auto", JSON.stringify(graph.reasons));
  assert.equal(graph.command[graph.command.indexOf("--graphify-mode") + 1], "rich-update");
  assert.equal(graph.command[graph.command.indexOf("--graphify-provider") + 1], "deepseek");
  assert.equal(graph.command[graph.command.indexOf("--graphify-model") + 1], "deepseek-v4-flash");
  assert.deepEqual(graph.backendCommand.slice(0, 2), ["python", "scripts/graphify-rich-update.py"]);
  assert.deepEqual(graph.providers, ["deepseek"]);

  const docs = byBackend(plan, "qmd");
  assert.equal(docs.modeName, "hybridDocs", "aggressive stop-refresh may keep rich docs quality because QMD index_local is incremental");

});

test("setup planner keeps local-only stop-refresh Graphify update-only", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  const preflight = await preflightNavigationTarget(root);
  const config = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    automation: { mode: "auto-local", autoRefreshOnStop: "enabled-local-only" },
    backends: { graph: { mode: "deepExtract", deepMode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash" } },
  });

  const plan = planNavigationSetup(preflight, config, {
    trigger: "stop_refresh",
    installedBackends: { graphify: true },
    requestedBackends: ["graphify"],
    env: { DEEPSEEK_API_KEY: "set" },
  });

  const graph = byBackend(plan, "graphify");
  assert.equal(graph.modeName, "update");
  assert.equal(graph.command[graph.command.indexOf("--graphify-mode") + 1], "update");
  assert.equal(graph.command.includes("--graphify-provider"), false);
  assert.deepEqual(graph.providers, []);
});

test("setup planner uses startup-safe QMD rich docs when LLM summaries are configured", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "README.md"), "# Demo\n");
  const preflight = await preflightNavigationTarget(root);
  const config = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    providers: { defaultEmbeddingProvider: "openai", allowCloud: true, allowEmbeddings: true, allowLLM: true },
    backends: { docs: { mode: "hybridDocs", embeddingProvider: "zeroentropy", aiSummaries: true, summarizerProvider: "openai" } },
  });

  const plan = planNavigationSetup(preflight, config, { requestedBackends: ["qmd"], installedBackends: { qmd: true }, startupSafe: true, env: { OPENAI_API_KEY: "set", ZEROENTROPY_API_KEY: "set" } });
  const docs = byBackend(plan, "qmd");

  assert.equal(docs.modeName, "hybridDocs");
  assert.equal(docs.policy, "auto");
});

test("setup planner first broad request uses local docs mode", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  await touch(join(root, "README.md"), "# Demo\n");
  const preflight = await preflightNavigationTarget(root);

  const config = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    automation: { mode: "aggressive" },
    providers: { defaultEmbeddingProvider: "openai", allowCloud: true, allowEmbeddings: true, allowLLM: true },
    backends: { docs: { mode: "hybridDocs", aiSummaries: false } },
  });
  const plan = planNavigationSetup(preflight, config, {
    trigger: "first_broad_request",
    query: "what is this project about?",
    requestedBackends: ["qmd"],
    installedBackends: { qmd: true },
    env: { OPENAI_API_KEY: "set", ZEROENTROPY_API_KEY: "set" },
  });

  const docs = byBackend(plan, "qmd");
  assert.equal(docs.modeName, "hybridDocs");
  assert.equal(docs.policy, "auto");
  assert.equal(docs.scope, ".");
  assert.ok(docs.reasons.some(reason => /hybridDocs allowed/.test(reason)), JSON.stringify(docs.reasons));
});

test("setup planner allows source-only folders without git markers when scope is clear", async () => {
  const root = await fixture();
  await touch(join(root, "src", "main.ts"), "export {};\n");
  const preflight = await preflightNavigationTarget(root);
  const config = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    backends: { graph: { primary: "graphify", mode: "deepExtract", deepMode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash" } },
  });

  const plan = planNavigationSetup(preflight, config, {
    trigger: "session_start",
    requestedBackends: ["graphify"],
    installedBackends: { graphify: true },
    env: { DEEPSEEK_API_KEY: "set" },
  });

  assert.equal(preflight.rootConfidence, "low");
  assert.equal(plan.scopePlan.mode, "auto");
  assert.equal(plan.scopePlan.selectedScopes[0], "src");
  const graph = byBackend(plan, "graphify");
  assert.equal(graph.policy, "auto", JSON.stringify(graph.reasons));
  assert.equal(graph.scope, "src");
});


// REGRESSION GUARD: true ambiguous monorepo roots should not auto-build a Graphify
// graph until scope is inferred or chosen. Root README/docs can still be indexed,
// but code graph/map lanes need a concrete package/workspace to avoid misleading
// broad root graphs. If this test fails with Graphify policy === "auto", check the
// planBackendAction scope gate: scope-ambiguity reasons should apply to Graphify,
// but not to safe root docs.
//
test("setup planner downgrades ambiguous monorepos until scope is inferred or chosen", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await touch(join(root, "README.md"), "# Monorepo\n");
  await touch(join(root, "packages", "core", "package.json"), JSON.stringify({ name: "core" }));
  await touch(join(root, "packages", "core", "src", "read.ts"), "export {};\n");
  await touch(join(root, "packages", "api", "package.json"), JSON.stringify({ name: "api" }));
  await touch(join(root, "packages", "api", "src", "server.ts"), "export {};\n");
  const preflight = await preflightNavigationTarget(root);
  const config = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    backends: { graph: { primary: "graphify", mode: "deepExtract", deepMode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash" } },
  });
  const ambiguous = planNavigationSetup(preflight, config, {
    trigger: "session_start",
    startupSafe: true,
    query: "Help me understand this repo",
    installedBackends: { qmd: true, graphify: true },
    env: {},
  });
  assert.equal(ambiguous.scopePlan.mode, "guided");
  assert.equal(byBackend(ambiguous, "graphify").policy, "guided");
  assert.equal(byBackend(ambiguous, "qmd").modeName, "hybridDocs");
  assert.deepEqual(byBackend(ambiguous, "qmd").providers, ["local"]);
  assert.equal(byBackend(ambiguous, "qmd").policy, "auto", "root README docs are safe to index even when monorepo code scope is ambiguous");
  assert.equal(byBackend(ambiguous, "qmd").scope, ".");
  assert.ok(!byBackend(ambiguous, "qmd").reasons.some(reason => /monorepo scope is ambiguous/i.test(reason)));
  const inferred = planNavigationSetup(preflight, config, {
    query: "Where does core file reading start?",
    installedBackends: { qmd: true, graphify: true },
    env: {},
  });
  assert.equal(inferred.scopePlan.mode, "auto");
  assert.equal(byBackend(inferred, "graphify").policy, "guided", "configured deep extraction remains guided until its provider is available");
  const graphCommand = byBackend(inferred, "graphify").command;
  assert.equal(graphCommand[graphCommand.indexOf("--graphify-mode") + 1], "deep");
  assert.equal(graphCommand[graphCommand.indexOf("--scope") + 1], "packages/core");
  assert.ok(!byBackend(inferred, "graphify").reasons.some(reason => /monorepo scope is ambiguous/i.test(reason)));
});


test("setup planner respects explicitly requested nested package path", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "package.json"), JSON.stringify({ name: "workspace" }));
  await touch(join(root, "README.md"), "# Workspace\n");
  await touch(join(root, "packages", "core", "package.json"), JSON.stringify({ name: "core" }));
  await touch(join(root, "packages", "core", "README.md"), "# Core\n");
  await touch(join(root, "packages", "core", "src", "main.ts"), "export const core = 1;\n");

  const preflight = await preflightNavigationTarget(join(root, "packages", "core"));
  const config = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    backends: { graph: { primary: "graphify", mode: "deepExtract", deepMode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash" } },
  });
  const plan = planNavigationSetup(preflight, config, {
    trigger: "session_start",
    startupSafe: true,
    installedBackends: { qmd: true, graphify: true },
  });

  assert.equal(preflight.root, plan.root);
  assert.equal(plan.scopePlan.mode, "auto");
  assert.deepEqual(plan.scopePlan.selectedScopes, ["packages/core"]);
  assert.equal(byBackend(plan, "graphify").scope, "packages/core");
});
test("setup planner blocks invalid config and asks for missing installs when installs are not allowed", async () => {
  const invalid = await fixture();
  await mkdir(join(invalid, ".git"));
  await touch(join(invalid, ".pi-navigation.json"), "{ nope");
  await touch(join(invalid, "src", "main.ts"), "export {};\n");
  const graphOptIn = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    backends: { graph: { primary: "graphify", mode: "deepExtract", deepMode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash" } },
  });
  const invalidPlan = planNavigationSetup(await preflightNavigationTarget(invalid), graphOptIn, {
    installedBackends: { graphify: true },
    requestedBackends: ["graphify"],
  });
  assert.equal(invalidPlan.scopePlan.mode, "blocked");
  assert.equal(byBackend(invalidPlan, "graphify").policy, "blocked");
  assert.ok(byBackend(invalidPlan, "graphify").reasons.some(reason => /invalid config|Existing \.pi-navigation\.json is invalid/i.test(reason)),
    "the invalid project config, not a machine disable, must be the blocking reason here");

  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  const noNetworkInstalls = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, { installs: { allowNetworkInstalls: false } });
  const missingInstall = planNavigationSetup(await preflightNavigationTarget(root), noNetworkInstalls, {
    requestedBackends: ["qmd"],
    installedBackends: { qmd: false },
  });
  assert.equal(byBackend(missingInstall, "qmd").policy, "guided");
  assert.ok(byBackend(missingInstall, "qmd").reasons.some(reason => /not installed/.test(reason)));
});

test("setup planner gives explicit project include scope to QMD instead of broad root docs", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "README.md"), "# Root\n");
  await touch(join(root, "packages", "docs-app", "guide.md"), "# Guide\n");
  const preflight = await preflightNavigationTarget(root);
  const plan = planNavigationSetup(preflight, DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    query: "understand the configured package",
    requestedBackends: ["qmd"],
    installedBackends: { qmd: true },
    projectScope: { include: ["packages/docs-app"], exclude: [] },
  });
  const docs = byBackend(plan, "qmd");
  assert.equal(docs.scope, "packages/docs-app");
  assert.equal(docs.command[docs.command.indexOf("--scope") + 1], "packages/docs-app");
  assert.deepEqual(docs.backendCommand, docs.command);
});


test("setup planner applies machine lane policy before any lane action", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  await touch(join(root, "README.md"), "# Demo\n");
  const preflight = await preflightNavigationTarget(root);
  const options = { installedBackends: { qmd: true, graphify: true }, env: { OPENAI_API_KEY: "set", DEEPSEEK_API_KEY: "set" } };

  // Selected policy A: the bundled machine config selects no Graphify lane.
  const lean = planNavigationSetup(preflight, DEFAULT_NAVIGATION_AUTOMATION_CONFIG, options);
  const leanGraph = byBackend(lean, "graphify");
  assert.equal(leanGraph.policy, "blocked", "a machine lane that is false must block the backend before any action");
  assert.equal(leanGraph.setupPolicy, "never_auto");
  assert.equal(leanGraph.command, undefined, "a blocked lane must not hand back a runnable command");
  assert.ok(leanGraph.reasons.some(reason => /backends\.graph is false or enabled: false/.test(reason)), JSON.stringify(leanGraph.reasons));
  assert.equal(byBackend(lean, "qmd").policy, "auto");

  // A machine `architecture` disable is Core code-maintenance consent, not a prepared
  // lane, so it must not block or guide the prepared lanes.
  const architectureOff = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    backends: {
      architecture: { enabled: false, autoPrepare: false },
      graph: { primary: "graphify", mode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash" },
    },
  });
  const architectureOffPlan = planNavigationSetup(preflight, architectureOff, options);
  assert.equal(byBackend(architectureOffPlan, "qmd").policy, "auto", "the docs lane must not inherit the architecture disable");
  assert.equal(byBackend(architectureOffPlan, "graphify").policy, "auto", "the graph lane must not inherit the architecture disable");

  const docsOff = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    backends: {
      docs: { enabled: false },
      graph: { primary: "graphify", mode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash" },
    },
  });
  const docsPlan = planNavigationSetup(preflight, docsOff, options);
  assert.equal(byBackend(docsPlan, "qmd").policy, "blocked");
  assert.ok(byBackend(docsPlan, "qmd").reasons.some(reason => /backends\.docs is false or enabled: false/.test(reason)));
});

test("setup planner withdraws automation without disabling a lane whose machine autoPrepare is false", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  await touch(join(root, "README.md"), "# Demo\n");
  const preflight = await preflightNavigationTarget(root);
  const config = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    backends: { graph: { primary: "graphify", mode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash", autoPrepare: false } },
  });

  const plan = planNavigationSetup(preflight, config, {
    installedBackends: { qmd: true, graphify: true },
    env: { DEEPSEEK_API_KEY: "set" },
  });
  const graph = byBackend(plan, "graphify");
  assert.equal(graph.policy, "guided", "autoPrepare:false withdraws automation, not the lane");
  assert.ok(graph.reasons.some(reason => /backends\.graph\.autoPrepare is false/.test(reason)), JSON.stringify(graph.reasons));
  assert.ok(graph.command, "a guided lane keeps its command for explicit use");
});

test("an owned graph artifact does not bypass a machine lane disable", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  await mkdir(join(root, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await touch(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), JSON.stringify({ nodes: [], edges: [] }));
  const preflight = await preflightNavigationTarget(root);

  const disabled = planNavigationSetup(preflight, DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    trigger: "stop_refresh",
    installedBackends: { graphify: true },
    requestedBackends: ["graphify"],
    env: { DEEPSEEK_API_KEY: "set" },
  });
  const blockedGraph = byBackend(disabled, "graphify");
  assert.equal(blockedGraph.policy, "blocked", "the lean machine default must not be re-enabled by an existing artifact");
  assert.equal(blockedGraph.command, undefined);
  assert.equal(disabled.policy, "blocked");

  const optedIn = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    automation: { autoRefreshOnStop: "aggressive" },
    backends: { graph: { primary: "graphify", mode: "deepExtract", deepMode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash" } },
  });
  const enabled = planNavigationSetup(preflight, optedIn, {
    trigger: "stop_refresh",
    installedBackends: { graphify: true },
    requestedBackends: ["graphify"],
    env: { DEEPSEEK_API_KEY: "set" },
  });
  const rich = byBackend(enabled, "graphify");
  assert.notEqual(rich.policy, "blocked", "an explicit machine Graphify object opts the lane back in");
  assert.equal(rich.modeName, "richUpdate");
  assert.equal(rich.command[rich.command.indexOf("--graphify-mode") + 1], "rich-update");
});
