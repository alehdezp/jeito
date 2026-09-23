import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import { backendCapability, decideAutomationPolicy } from "../src/core/backend-registry.ts";
import {
  automationPolicyInput,
  defaultAgentNavigationConfigPath,
  DEFAULT_NAVIGATION_AUTOMATION_CONFIG,
  FULL_STACK_NAVIGATION_AUTOMATION_CONFIG,
  loadNavigationAutomationConfig,
  envWithNavigationProviders,
  mergeAutomationConfig,
} from "../src/core/navigation-automation-config.ts";

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-auto-config-"));
}

test("bundled automation defaults grant aggressive consent without selecting an external prepared code backend", async () => {
  const home = await fixture();
  const loaded = loadNavigationAutomationConfig({ home, env: {} });
  assert.equal(loaded.exists, false);
  assert.equal(loaded.path, defaultAgentNavigationConfigPath(home));
  // Selected policy: the bundled default is the Core + QMD stack. It selects no
  // external prepared code runtime: `architecture` keeps only the host-owned Core
  // consent surface and carries no preparation knobs, and `graph` is the value false
  // rather than an object, so an explicit host `graph` object replaces it instead of
  // deep-merging into a default disable.
  assert.equal(loaded.config.backends.graph, false, "the bundled default selects no Graphify lane");
  assert.deepEqual(loaded.config.backends.architecture, {}, "the architecture lane is Core consent only; it carries no CRG preparation knobs");
  assert.equal(loaded.config.backends.crg, undefined, "the retired CRG backend id must not reappear in the bundled backends");
  assert.equal(loaded.config.automation.mode, "aggressive");
  assert.equal(loaded.config.automation.autoPrepareOnFirstBroadRequest, true);
  assert.equal(loaded.config.automation.autoPrepareOnSessionStart, true);
  assert.equal(loaded.config.automation.startupAutoPrepareBudgetMs, 20 * 60_000);
  assert.equal(loaded.config.automation.startupAutoPrepareActionTimeoutMs, 20 * 60_000);
  assert.equal(loaded.config.installs.allowNetworkInstalls, true);
  assert.equal(loaded.config.providers.allowCloud, true);
  assert.equal(loaded.config.providers.allowEmbeddings, true);
  assert.equal(loaded.config.providers.allowLLM, true);
  assert.equal(loaded.config.providers.defaultEmbeddingProvider, "openai");
  assert.equal(loaded.config.providers.secondaryEmbeddingProvider, "voyage");
  assert.equal(loaded.config.providers.defaultLLMProvider, "deepseek");
  assert.deepEqual(Object.keys(loaded.config.backends).sort(), ["architecture", "docs", "graph"]);
  assert.equal(loaded.config.backends.docs.maxAutomaticFiles, 300);
  assert.equal(loaded.config.backends.docs.primary, "qmd", "QMD stays a bundled default lane");
  assert.equal(loaded.config.storage.allowVisibleProjectDirs, true);
  assert.equal(loaded.config.storage.indexRoot, join(home, ".pi", "navigation", "indexes"));

  const policy = automationPolicyInput(loaded.config);
  assert.equal(decideAutomationPolicy(backendCapability("qmd"), "lexicalDocs", policy).policy, "auto_logged");
  assert.equal(decideAutomationPolicy(backendCapability("graphify"), "update", policy).policy, "auto_logged");
});

test("the opt-in full-stack preset still selects Graphify deep extraction", () => {
  const policy = automationPolicyInput(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG);
  assert.equal(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG.automation.mode, "aggressive");
  assert.equal(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG.backends.architecture.primary, undefined, "the retired CRG code owner must not return through the full-stack preset");
  assert.equal(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG.backends.docs.mode, "hybridDocs");
  assert.equal(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG.backends.graph.deepMode, "deepExtract");
  assert.notEqual(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG.backends.graph, DEFAULT_NAVIGATION_AUTOMATION_CONFIG.backends.graph,
    "the full-stack preset must not be the bundled default any more");
  assert.equal(decideAutomationPolicy(backendCapability("qmd"), "hybridDocs", policy).policy, "auto_logged");
  assert.equal(decideAutomationPolicy(backendCapability("graphify"), "deepExtract", policy).policy, "auto_logged");
});

test("automation config loads global JSON via explicit path or environment override", async () => {
  const root = await fixture();
  const configPath = join(root, "navigation-config.json");
  await writeFile(configPath, JSON.stringify({
    automation: { mode: "aggressive", autoPrepareOnSessionStart: true },
    providers: { allowCloud: true, allowEmbeddings: true, allowLLM: true, defaultEmbeddingProvider: "openai" },
    storage: { indexRoot: "~/custom-indexes", allowVisibleProjectDirs: false },
    backends: { docs: { mode: "hybridDocs" } },
  }, null, 2));

  const loaded = loadNavigationAutomationConfig({ env: { PI_NAV_AUTOMATION_CONFIG: configPath }, home: root });
  assert.equal(loaded.exists, true);
  assert.equal(loaded.path, configPath);
  assert.equal(loaded.config.automation.mode, "aggressive");
  assert.equal(loaded.config.automation.autoPrepareOnFirstBroadRequest, true, "first-request auto-prepare is a product default");
  assert.equal(loaded.config.providers.allowCloud, true);
  assert.equal(loaded.config.providers.defaultEmbeddingProvider, "openai");
  assert.equal(loaded.config.storage.indexRoot, join(root, "custom-indexes"));
  assert.equal(loaded.config.storage.allowVisibleProjectDirs, false);
  assert.equal(loaded.config.backends.docs.mode, "hybridDocs");

  const policy = automationPolicyInput(loaded.config);
  assert.equal(decideAutomationPolicy(backendCapability("graphify"), "update", policy).policy, "ask_first", "visible graphify-out writes require policy when disabled");
});

test("automation config tilde paths expand against OS home option, not config file directory", async () => {
  const root = await fixture();
  const configDir = join(root, "nested", "config-dir");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "navigation-config.json");
  await writeFile(configPath, JSON.stringify({ storage: { indexRoot: "~/nav-indexes" } }, null, 2));

  const loaded = loadNavigationAutomationConfig({ path: configPath, home: root, env: {} });

  assert.equal(loaded.config.storage.indexRoot, join(root, "nav-indexes"));
});


test("automation config invalid JSON falls back to defaults with diagnostics", async () => {
  const root = await fixture();
  const configPath = join(root, "bad.json");
  await writeFile(configPath, "{ nope");
  const loaded = loadNavigationAutomationConfig({ path: configPath, home: root, env: {} });
  assert.equal(loaded.exists, true);
  assert.equal(loaded.config.automation.mode, DEFAULT_NAVIGATION_AUTOMATION_CONFIG.automation.mode);
  assert.ok(loaded.diagnostics.some(item => /navigation automation config error/.test(item)));
});

test("mergeAutomationConfig preserves defaults while allowing project or global overrides", () => {
  const merged = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    automation: { mode: "guided" },
    scoping: { maxAutoFiles: 123 },
    backends: { graph: { mode: "deepExtract" } },
  });
  assert.equal(merged.automation.mode, "guided");
  assert.equal(merged.automation.autoPrepareOnFirstBroadRequest, true);
  assert.equal(merged.scoping.maxAutoFiles, 123);
  assert.equal(merged.scoping.monorepoMode, DEFAULT_NAVIGATION_AUTOMATION_CONFIG.scoping.monorepoMode);
  assert.deepEqual(merged.backends.graph, { mode: "deepExtract" },
    "an explicit host graph object replaces the bundled false wholesale: no inherited default disable");
  assert.deepEqual(merged.backends.architecture, {}, "merging a host graph must not reintroduce a CRG preparation default");
});

test("selected policy: an explicit host backend selection is preserved without inheriting a default disable", async () => {
  const home = await fixture();
  const configPath = join(home, "navigation-config.json");
  await writeFile(configPath, JSON.stringify({
    backends: {
      architecture: { primary: "crg", mode: "embeddings" },
      graph: { primary: "graphify", mode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash" },
    },
  }, null, 2));

  const loaded = loadNavigationAutomationConfig({ path: configPath, home, env: {} });
  assert.equal(loaded.config.backends.graph.mode, "deepExtract");
  assert.equal(loaded.config.backends.graph.provider, "deepseek");
  assert.equal(loaded.config.backends.graph.model, "deepseek-v4-flash");
  assert.equal(loaded.config.backends.graph.enabled, undefined, "an opted-in Graphify lane must not inherit an enabled:false default");
  assert.deepEqual(loaded.config.backends.architecture, { primary: "crg", mode: "embeddings" }, "a host architecture entry is preserved verbatim; retired CRG keys stay inert host data");
  assert.equal(loaded.config.backends.architecture.autoPrepare, undefined, "an opted-in architecture lane must not inherit autoPrepare:false");
  assert.equal(loaded.config.backends.docs.primary, "qmd", "unmentioned lanes keep following the bundled defaults");
});

test("selected policy: explicit disables survive the lean defaults", async () => {
  const home = await fixture();
  const configPath = join(home, "navigation-config.json");
  await writeFile(configPath, JSON.stringify({
    backends: { architecture: { enabled: false, autoPrepare: false }, docs: { enabled: false }, graph: false },
  }, null, 2));

  const loaded = loadNavigationAutomationConfig({ path: configPath, home, env: {} });
  assert.equal(loaded.config.backends.architecture.enabled, false);
  assert.equal(loaded.config.backends.architecture.autoPrepare, false);
  assert.equal(loaded.config.backends.docs.enabled, false);
  assert.equal(loaded.config.backends.graph, false);

  const wholePath = join(home, "whole-lane.json");
  await writeFile(wholePath, JSON.stringify({ backends: { architecture: false } }));
  const whole = loadNavigationAutomationConfig({ path: wholePath, home, env: {} });
  assert.equal(whole.config.backends.architecture, false, "a whole-lane false stays a whole-lane false");
});

test("selected policy: unrelated host keys keep the lean bundled defaults", async () => {
  const home = await fixture();
  const configPath = join(home, "navigation-config.json");
  await writeFile(configPath, JSON.stringify({ providers: { allowed: ["openai"] } }, null, 2));

  const loaded = loadNavigationAutomationConfig({ path: configPath, home, env: {} });
  assert.deepEqual(loaded.config.providers.allowed, ["openai"]);
  assert.equal(loaded.config.backends.graph, false);
  assert.equal("primary" in loaded.config.backends.architecture, false);
});

test("automation config loads friendly private YAML and injects provider env without putting secrets in config", async () => {
  const home = await fixture();
  const agentDir = join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  const configPath = defaultAgentNavigationConfigPath(home);
  await writeFile(configPath, `
profile: max-quality
automation:
  session_start: quick-local
  first_broad_request: auto
providers:
  allow_cloud: "false"
  allow_llm: true
  allow_embeddings: true
  allowed: openai,deepseek
  defaults:
    llm: deepseek
    embedding: openai
  openai:
    api_key: yaml-openai-secret
    embedding_model: text-embedding-3-small
  deepseek:
    api_key: yaml-deepseek-secret
  minimax:
    api_key: yaml-minimax-secret
  kimi:
    api_key: yaml-kimi-secret
backends:
  docs:
    mode: hybridDocs
    embeddings: auto
    aiSummaries: false
    embedding_provider: openai
  graph:
    mode: deepExtract
  tilth:
    mode: structuralLookup
  structural:
    primary: pi-nav
    mode: liveQuery
`);

  const loaded = loadNavigationAutomationConfig({ home, env: {} });
  assert.equal(loaded.path, configPath);
  assert.equal(loaded.exists, true);
  assert.equal(loaded.config.automation.mode, "aggressive");
  assert.equal(loaded.config.automation.autoPrepareOnSessionStart, "quick-local");
  assert.equal(loaded.config.automation.autoPrepareOnFirstBroadRequest, true);
  assert.equal(loaded.config.providers.allowCloud, false, "quoted false must not become true");
  assert.equal(loaded.config.providers.allowLLM, true);
  assert.equal(loaded.config.providers.defaultLLMProvider, "deepseek");
  assert.equal(loaded.config.backends.graph.mode, "deepExtract");
  assert.equal(loaded.config.backends.docs.embeddingProvider, "openai");
  assert.equal("tilth" in loaded.config.backends, false);
  assert.equal("structural" in loaded.config.backends, false);
  assert.match(loaded.diagnostics.join("\n"), /obsolete backends\.tilth ignored/);
  assert.match(loaded.diagnostics.join("\n"), /backends\.structural ignored/);
  assert.doesNotMatch(JSON.stringify(loaded.config), /yaml-(?:openai|deepseek|minimax|kimi)-secret/);
  assert.doesNotMatch(loaded.diagnostics.join("\n"), /yaml-(?:openai|deepseek|minimax|kimi)-secret/);

  const env = envWithNavigationProviders(loaded, { EXISTING: "1" });
  assert.equal(env.EXISTING, "1");
  assert.equal(env.OPENAI_API_KEY, "yaml-openai-secret");
  assert.equal(env.DEEPSEEK_API_KEY, "yaml-deepseek-secret");
  assert.equal(env.MINIMAX_API_KEY, "yaml-minimax-secret");
  assert.equal(env.KIMI_API_KEY, "yaml-kimi-secret");
  assert.equal(env.CRG_ACCEPT_CLOUD_EMBEDDINGS, undefined, "the retired CRG cloud-embedding acceptance knob is no longer injected");
});

test("friendly YAML preserves explicit lane disables the lifecycle honors", async () => {
  const home = await fixture();
  const agentDir = join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(defaultAgentNavigationConfigPath(home), `
automation:
  mode: aggressive
backends:
  architecture:
    enabled: false
    autoPrepare: false
  graph: false
  docs:
    mode: hybridDocs
    enabled: false
    autoPrepare: "false"
`);

  const loaded = loadNavigationAutomationConfig({ home, env: {} });
  assert.equal(loaded.config.backends.architecture.enabled, false, "explicit YAML architecture disable must survive load");
  assert.equal(loaded.config.backends.architecture.autoPrepare, false);
  assert.deepEqual(loaded.config.backends.architecture, { enabled: false, autoPrepare: false }, "the architecture lane carries Core consent only; no CRG preparation default is inherited");
  assert.equal(loaded.config.backends.graph, false, "whole-lane graph false must survive load");
  assert.equal(loaded.config.backends.docs.enabled, false);
  assert.equal(loaded.config.backends.docs.autoPrepare, false, "quoted false is a disable, not a truthy string");
  assert.equal(loaded.config.backends.docs.mode, "hybridDocs");
});

test("friendly YAML does not invent lane flags the file did not set", async () => {
  const home = await fixture();
  const agentDir = join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(defaultAgentNavigationConfigPath(home), `
backends:
  docs:
    mode: hybridDocs
`);

  const loaded = loadNavigationAutomationConfig({ home, env: {} });
  assert.equal("enabled" in loaded.config.backends.architecture, false);
  assert.equal("autoPrepare" in loaded.config.backends.architecture, false);
  assert.equal("enabled" in loaded.config.backends.docs, false);
  assert.equal("autoPrepare" in loaded.config.backends.docs, false);
  assert.equal(loaded.config.backends.graph, false, "an unmentioned graph lane keeps the bundled lean default");
});

test("friendly YAML whole-lane false for architecture and docs is a disable, not an omission", async () => {
  const home = await fixture();
  const agentDir = join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(defaultAgentNavigationConfigPath(home), `
backends:
  architecture: false
  docs: false
`);

  const loaded = loadNavigationAutomationConfig({ home, env: {} });
  assert.equal(loaded.config.backends.architecture, false);
  assert.equal(loaded.config.backends.docs, false);
});

test("obsolete richDocs automation policy migrates in memory to the owned QMD provider", async () => {
  const home = await fixture();
  const agentDir = join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(defaultAgentNavigationConfigPath(home), `
profile: legacy-docs
providers:
  allow_cloud: true
  allow_embeddings: true
  allowed: openai,deepseek
backends:
  docs:
    primary: qmd
    mode: richDocs
    embeddings: auto
    embedding_provider: openai
`);
  const loaded = loadNavigationAutomationConfig({ home, env: {} });
  assert.equal(loaded.config.backends.docs.mode, "hybridDocs");
  assert.equal(loaded.config.backends.docs.embeddingProvider, "auto");
  assert.equal(loaded.config.backends.docs.aiSummaries, false);
  assert.ok(loaded.config.providers.allowed.includes("zeroentropy"));
  assert.match(loaded.diagnostics.join("\n"), /richDocs migrated in memory/);
});

test("automation env adds common fish/backend tool paths without overriding explicit empty PATH", async () => {
  const home = await fixture();
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await mkdir(join(home, ".local", "share", "mise", "shims"), { recursive: true });
  const loaded = loadNavigationAutomationConfig({ home, env: {} });

  const env = envWithNavigationProviders(loaded, { PATH: "/usr/bin" }, home);
  const parts = env.PATH.split(delimiter);
  assert.ok(parts.includes("/usr/bin"));
  assert.ok(parts.includes(dirname(process.execPath)), "node executable dir should remain discoverable for lifecycle children");
  assert.ok(parts.includes(join(home, ".local", "bin")), "fish-added user bin should be discoverable for backend tools");
  assert.ok(parts.includes(join(home, ".local", "share", "mise", "shims")), "mise shims should be discoverable for backend tools");

  const isolated = envWithNavigationProviders(loaded, { PATH: "" }, home);
  assert.equal(isolated.PATH, "", "tests and explicit isolated runs can still use PATH='' to prove no fallback command discovery");
});
