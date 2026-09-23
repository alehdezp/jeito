import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { statSync, existsSync, rmSync, mkdirSync } from "node:fs";
import test from "node:test";

import { ensureDefaultNavigationConfig } from "../src/core/navigation-config-seed.ts";
import { defaultAgentNavigationConfigPath, loadNavigationAutomationConfig } from "../src/core/navigation-automation-config.ts";

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-seed-"));
}

test("ensureDefaultNavigationConfig seeds a max-quality navigation.yaml when absent", async () => {
  const home = await fixture();
  const path = defaultAgentNavigationConfigPath(home);
  assert.equal(existsSync(path), false);

  const result = ensureDefaultNavigationConfig({ home });
  assert.equal(result.created, true);
  assert.equal(existsSync(path), true);
});

test("seeded file is 0600 and dir is 0700", async () => {
  const home = await fixture();
  ensureDefaultNavigationConfig({ home });
  const path = defaultAgentNavigationConfigPath(home);
  const fileMode = statSync(path).mode & 0o777;
  const dirMode = statSync(dirname(path)).mode & 0o777;
  assert.equal(fileMode, 0o600, `expected 0600 got ${fileMode.toString(8)}`);
  assert.equal(dirMode, 0o700, `expected 0700 got ${dirMode.toString(8)}`);
});

test("seed is idempotent: existing file is left untouched", async () => {
  const home = await fixture();
  const path = defaultAgentNavigationConfigPath(home);
  // Pre-create a user file with a marker that proves it is not overwritten.
  mkdirSync(dirname(path), { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, "profile: my-custom-profile\nautomation:\n  mode: aggressive\n", { mode: 0o600 });

  const result = ensureDefaultNavigationConfig({ home });
  assert.equal(result.created, false);
  const loaded = loadNavigationAutomationConfig({ home, env: {} });
  assert.equal(loaded.config.automation.mode, "aggressive");
  assert.equal(loaded.exists, true);
});

test("seeded template loads the keyless aggressive semantic defaults", async () => {
  const home = await fixture();
  ensureDefaultNavigationConfig({ home });
  const loaded = loadNavigationAutomationConfig({ home, env: {} });
  assert.equal(loaded.exists, true);
  assert.equal(loaded.config.providers.allowCloud, true);
  assert.equal(loaded.config.providers.allowEmbeddings, true);
  assert.equal(loaded.config.providers.allowLLM, true);
  assert.equal(loaded.config.automation.mode, "aggressive");
  assert.equal(loaded.config.backends.architecture.primaryEmbeddingProvider, "local");
  assert.equal(loaded.config.backends.docs.embeddingProvider, "auto");
  assert.equal(loaded.config.backends.graph.provider, "deepseek");
  assert.equal(loaded.config.backends.graph.model, "deepseek-v4-flash");
  assert.equal(loaded.config.providers.defaultEmbeddingProvider, "local");
  assert.equal(loaded.config.providers.defaultLLMProvider, "deepseek");
});

test("seeded template contains provider choices but no secret values", async () => {
  const home = await fixture();
  ensureDefaultNavigationConfig({ home });
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(defaultAgentNavigationConfigPath(home), "utf8");
  assert.match(text, /Provider choices are bundled defaults/);
  assert.equal(/\$\{/.test(text), false, "no literal environment placeholder is stored as a key");
  assert.equal(/\b(sk-[A-Za-z0-9]{10,})\b/.test(text), false, "no leaked secret-looking tokens");
});

test("ensureDefaultNavigationConfig never throws: degrades to a diagnostic on failure", async () => {
  const result = ensureDefaultNavigationConfig({ home: "/nonexistent-root-xyz/does/not/exist" });
  assert.equal(result.created, false);
  assert.match(result.reason, /skipped/i);
});

// Cleanup is automatic via tmpdir; tests are independent.
void rmSync;
