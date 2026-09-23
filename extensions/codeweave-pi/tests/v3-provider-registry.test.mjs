import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalProviderId,
  defaultModelForProvider,
  decideProviderPolicy,
  listProviderRecords,
  providerForBackend,
  providerRecord,
} from "../src/core/provider-registry.ts";
import {
  DEFAULT_NAVIGATION_AUTOMATION_CONFIG,
  FULL_STACK_NAVIGATION_AUTOMATION_CONFIG,
  mergeAutomationConfig,
} from "../src/core/navigation-automation-config.ts";

test("provider registry records cloud/local behavior with evidence and undo", () => {
  const records = listProviderRecords();
  assert.deepEqual(records.map(record => record.id).sort(), ["anthropic", "deepseek", "google", "kimi", "minimax", "ollama", "openai", "openai-compatible", "openrouter", "voyage", "zeroentropy"]);
  for (const record of records) {
    assert.ok(record.displayName);
    assert.ok(record.aliases.length > 0);
    assert.ok(record.capabilities.length > 0);
    assert.ok(record.evidence.length > 0, `${record.id} should cite evidence`);
    assert.ok(record.undo.length > 0, `${record.id} should include undo guidance`);
  }

  const google = providerRecord("gemini");
  assert.equal(google?.id, "google");
  assert.equal(google?.contentLeavesMachine, true);
  assert.deepEqual(google?.requiredEnv, ["GOOGLE_API_KEY"]);

  const voyage = providerRecord("voyage-ai");
  assert.equal(voyage?.id, "voyage");
  assert.equal(voyage?.contentLeavesMachine, true);
  assert.deepEqual(voyage?.requiredEnv, ["VOYAGE_API_KEY"]);

  const zeroentropy = providerRecord("zeroentropy");
  assert.equal(zeroentropy?.id, "zeroentropy");
  assert.equal(zeroentropy?.contentLeavesMachine, true);
  assert.deepEqual(zeroentropy?.requiredEnv, ["ZEROENTROPY_API_KEY"]);
  const openrouter = providerRecord("open-router");
  assert.equal(openrouter?.id, "openrouter");
  assert.deepEqual(openrouter?.requiredEnv, ["OPENROUTER_API_KEY"]);
  assert.deepEqual(openrouter?.backends, ["qmd"]);

});

test("provider aliases and backend-specific names are normalized", () => {
  assert.equal(canonicalProviderId("gemini"), "google");
  assert.equal(canonicalProviderId("claude"), "anthropic");
  assert.equal(providerForBackend("google", "graphify"), "gemini");
  assert.equal(providerForBackend("anthropic", "graphify"), "claude");
  assert.equal(providerForBackend("openai", "graphify"), "openai");
});

test("provider model catalog exposes advisory defaults and passes custom models through", () => {
  // First catalog entry is the recommended default; advisory only, never a gate.
  // Populated from each provider's authoritative docs (verified 2026-07).
  assert.equal(defaultModelForProvider("minimax"), "MiniMax-M3");
  assert.equal(defaultModelForProvider("deepseek"), "deepseek-v4");
  assert.equal(defaultModelForProvider("openai"), "gpt-5.6-sol");
  assert.equal(defaultModelForProvider("google"), "gemini-3.6-flash");
  assert.equal(defaultModelForProvider("kimi"), "kimi-k3");
  assert.equal(defaultModelForProvider("voyage"), "voyage-4-large");
  assert.equal(defaultModelForProvider("openrouter"), "nvidia/nemotron-3-embed-1b:free");
  // Alias resolves to the same catalog.
  assert.equal(defaultModelForProvider("minimax-m3"), "MiniMax-M3");
  assert.equal(defaultModelForProvider("gemini"), "gemini-3.6-flash");
  // Providers without a catalog yield undefined so graphify uses its backend default.
  assert.equal(defaultModelForProvider("zeroentropy"), undefined);
  assert.equal(defaultModelForProvider("does-not-exist"), undefined);
});

test("provider policy allows the permissive bundled default and blocks only when gates are disabled", () => {
  // The bundled default IS the full semantic stack (permissive; see
  // FULL_STACK_NAVIGATION_AUTOMATION_CONFIG = structuredClone(DEFAULT...)). With the
  // key present, cloud embedding and local LLM are allowed, not gated behind ask_first.
  const openaiEmbedding = decideProviderPolicy({
    config: DEFAULT_NAVIGATION_AUTOMATION_CONFIG,
    provider: "openai",
    capability: "embedding",
    env: { OPENAI_API_KEY: "set" },
  });
  assert.equal(openaiEmbedding.policy, "allowed");
  assert.equal(openaiEmbedding.reasons.length, 0);
  assert.equal(openaiEmbedding.contentLeavesMachine, true);

  const ollamaLLM = decideProviderPolicy({
    config: DEFAULT_NAVIGATION_AUTOMATION_CONFIG,
    provider: "ollama",
    capability: "llm",
    env: {},
  });
  assert.equal(ollamaLLM.policy, "allowed");
  assert.equal(ollamaLLM.reasons.length, 0);
  assert.equal(ollamaLLM.contentLeavesMachine, false);

  // Blocking still works: a locked-down config surfaces the exact gate reasons.
  const locked = structuredClone(DEFAULT_NAVIGATION_AUTOMATION_CONFIG);
  locked.providers.allowCloud = false;
  locked.providers.allowEmbeddings = false;
  locked.providers.allowLLM = false;
  locked.providers.allowLocalModelDownloads = false;

  const blockedEmbedding = decideProviderPolicy({
    config: locked,
    provider: "openai",
    capability: "embedding",
    env: { OPENAI_API_KEY: "set" },
  });
  assert.equal(blockedEmbedding.policy, "ask_first");
  assert.ok(blockedEmbedding.reasons.some(reason => /allowEmbeddings/.test(reason)));
  assert.ok(blockedEmbedding.reasons.some(reason => /allowCloud/.test(reason)));

  const blockedOllama = decideProviderPolicy({
    config: locked,
    provider: "ollama",
    capability: "llm",
    env: {},
  });
  assert.equal(blockedOllama.policy, "ask_first");
  assert.ok(blockedOllama.reasons.some(reason => /allowLLM/.test(reason)));
  assert.ok(blockedOllama.reasons.some(reason => /allowLocalModelDownloads/.test(reason)));
});

test("full-stack provider policy allows configured providers when env requirements are met", () => {
  const openaiLLM = decideProviderPolicy({
    config: FULL_STACK_NAVIGATION_AUTOMATION_CONFIG,
    provider: "openai",
    capability: "llm",
    env: { OPENAI_API_KEY: "set" },
  });
  assert.equal(openaiLLM.policy, "allowed");
  assert.deepEqual(openaiLLM.missingEnv, []);

  const googleEmbedding = decideProviderPolicy({
    config: FULL_STACK_NAVIGATION_AUTOMATION_CONFIG,
    provider: "gemini",
    capability: "embedding",
    env: { GOOGLE_API_KEY: "set" },
  });
  assert.equal(googleEmbedding.policy, "allowed");
  assert.equal(googleEmbedding.canonicalProvider, "google");

  const openRouterEmbedding = decideProviderPolicy({
    config: FULL_STACK_NAVIGATION_AUTOMATION_CONFIG,
    provider: "openrouter",
    capability: "embedding",
    env: { OPENROUTER_API_KEY: "set" },
  });
  assert.equal(openRouterEmbedding.policy, "allowed");
  assert.deepEqual(openRouterEmbedding.missingEnv, []);
});

test("provider policy surfaces missing env vars and disallowed providers without secret values", () => {
  const missing = decideProviderPolicy({
    config: FULL_STACK_NAVIGATION_AUTOMATION_CONFIG,
    provider: "anthropic",
    capability: "llm",
    env: {},
  });
  assert.equal(missing.policy, "ask_first");
  assert.deepEqual(missing.missingEnv, ["ANTHROPIC_API_KEY"]);
  assert.ok(missing.reasons.some(reason => reason.includes("ANTHROPIC_API_KEY")));
  assert.ok(!missing.reasons.join(" ").includes("set"));

  const restrictedConfig = mergeAutomationConfig(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG, {
    providers: { allowed: ["ollama"], defaultLLMProvider: "ollama" },
  });
  const blocked = decideProviderPolicy({
    config: restrictedConfig,
    provider: "openai",
    capability: "llm",
    env: { OPENAI_API_KEY: "set" },
  });
  assert.equal(blocked.policy, "blocked");
  assert.ok(blocked.reasons.some(reason => /not listed/.test(reason)));
});

test("provider policy honors configured openai-compatible apiKeyEnv names", () => {
  const config = mergeAutomationConfig(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG, {
    providers: {
      defaultLLMProvider: "deepseek",
      openaiCompatible: {
        deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKeyEnv: "PI_TEST_DEEPSEEK_KEY" },
      },
    },
  });

  const missing = decideProviderPolicy({ config, provider: "deepseek", capability: "llm", env: {} });
  assert.equal(missing.policy, "ask_first");
  assert.deepEqual(missing.requiredEnv, ["PI_TEST_DEEPSEEK_KEY"]);
  assert.deepEqual(missing.missingEnv, ["PI_TEST_DEEPSEEK_KEY"]);

  const allowed = decideProviderPolicy({ config, provider: "deepseek", capability: "llm", env: { PI_TEST_DEEPSEEK_KEY: "set" } });
  assert.equal(allowed.policy, "allowed");
  assert.deepEqual(allowed.missingEnv, []);
});

test("provider policy can skip env checking for dry-run planning", () => {
  const decision = decideProviderPolicy({
    config: FULL_STACK_NAVIGATION_AUTOMATION_CONFIG,
    provider: "openai",
    capability: "embedding",
    env: {},
    requireEnv: false,
  });
  assert.equal(decision.policy, "allowed");
  assert.deepEqual(decision.missingEnv, []);
});
