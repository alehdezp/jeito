import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A3: the /navigation-setup globals-edit track writes a minimal OpenAI-key YAML,
// then validates by reloading + projecting provider selection into env. This test
// pins that contract so the skill's documented procedure is real, not aspirational.

import { loadNavigationAutomationConfig, envWithNavigationProviders } from "../src/core/navigation-automation-config.ts";

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-a3-globals-"));
}

const MINIMAL_OPENAI_YAML = `# ~/.pi/agent/navigation.yaml — minimal OpenAI-key path
automation:
  mode: auto-local
  session_start: quick-local
  first_broad_request: true
  stop_refresh: enabled-local-only
providers:
  allow_cloud: true
  allow_embeddings: true
  allow_llm: false
  openai:
    api_key: "sk-test-redacted-do-not-print"
    embedding_model: text-embedding-3-small
backends:
  # Retired CRG preparation keys: the loader must not project a code lane from them.
  architecture:
    mode: embeddings
    primaryEmbeddingProvider: openai
  docs:
    mode: richDocs
    embeddings: auto
    embedding_provider: openai
    aiSummaries: false
`;

test("A3: minimal OpenAI-key YAML loads with embeddings enabled and llm off", async () => {
  const home = await fixture();
  const configPath = join(home, ".pi", "agent", "navigation.yaml");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(configPath, MINIMAL_OPENAI_YAML);

  const loaded = loadNavigationAutomationConfig({ home, env: {} });
  assert.equal(loaded.exists, true);
  assert.equal(loaded.config.providers.allowCloud, true);
  assert.equal(loaded.config.providers.allowEmbeddings, true);
  assert.equal(loaded.config.providers.allowLLM, false);
  assert.equal(loaded.config.backends.architecture?.mode, undefined, "the retired architecture lane must not project a preparation mode");
  assert.equal(loaded.config.backends.architecture?.primaryEmbeddingProvider, undefined, "retired embedding-provider keys must not project");
  assert.equal(loaded.config.backends.docs.embeddingProvider ?? loaded.config.backends.docs.embedding_provider, "auto");
  await rm(home, { recursive: true, force: true });
});

test("A3: provider selection projects OPENAI_API_KEY into child env (key value present)", async () => {
  const home = await fixture();
  const configPath = join(home, ".pi", "agent", "navigation.yaml");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(configPath, MINIMAL_OPENAI_YAML);

  const loaded = loadNavigationAutomationConfig({ home, env: {} });
  const env = envWithNavigationProviders(loaded, {}, home);
  assert.equal(env.OPENAI_API_KEY, "sk-test-redacted-do-not-print");
  assert.equal(env.OPENAI_EMBEDDING_MODEL, "text-embedding-3-small");
  await rm(home, { recursive: true, force: true });
});

test("A3: \${ENV_VAR} literal is NOT expanded — the footgun must keep failing loudly", async () => {
  const home = await fixture();
  const configPath = join(home, ".pi", "agent", "navigation.yaml");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(configPath, `providers:\n  allow_cloud: true\n  openai:\n    api_key: "\${OPENAI_API_KEY}"\n    embedding_model: text-embedding-3-small\nbackends:\n  architecture:\n    mode: embeddings\n    primaryEmbeddingProvider: openai\n`);
  const loaded = loadNavigationAutomationConfig({ home, env: { OPENAI_API_KEY: "sk-real-from-env" } });
  // The literal string is stored, NOT expanded to the env value — proving no expansion.
  // This is the documented footgun; it must keep failing loudly (D2).
  assert.equal(loaded.providerEnv?.OPENAI_API_KEY, "${OPENAI_API_KEY}");
  await rm(home, { recursive: true, force: true });
});
