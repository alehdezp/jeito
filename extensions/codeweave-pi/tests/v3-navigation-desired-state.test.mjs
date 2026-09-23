import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_NAVIGATION_AUTOMATION_CONFIG, mergeAutomationConfig } from "../src/core/navigation-automation-config.ts";
import { compileNavigationDesiredState, desiredStateMatches } from "../src/core/navigation-desired-state.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-desired-state-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "README.md"), "# Demo\n");
  return root;
}

function richPolicy() {
  return mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
    providers: { allowCloud: true, allowEmbeddings: true, allowLLM: true },
    backends: { docs: { primary: "qmd", mode: "hybridDocs", embeddings: "if-provider-allowed", embeddingProvider: "zeroentropy", aiSummaries: false } },
  });
}

const identities = {
  docs: { available: true, compatible: true, version: "owned", schemaVersion: "1" },
  graph: { available: true, compatible: true, version: "0.8.44", schemaVersion: "1" },
};

test("desired state is pure, deterministic, redacted, and records finalized backend identities", async () => {
  const root = await fixture();
  const input = {
    root,
    automation: richPolicy(),
    projectConfig: { docs: { enabled: true, root: "." } },
    backendIdentities: identities,
    providerAvailable: { docs: true, graph: true },
    trigger: "session_start",
  };
  const first = compileNavigationDesiredState(input);
  const second = compileNavigationDesiredState(input);
  assert.deepEqual(second, first);
  assert.match(first.desiredStateHash, /^[0-9a-f]{64}$/);
  assert.match(first.rootIdentity, /^[0-9a-f]{64}$/);
  assert.equal(first.lanes.docs.backendVersion, "owned");
  assert.deepEqual(Object.keys(first.lanes).sort(), ["docs", "graph"], "Core has its own maintenance identity, not an external prepared lane");
  assert.equal(first.lanes.docs.requested.embeddings, "auto");
  assert.equal(first.lanes.docs.requested.aiSummaries, false);
  assert.equal(desiredStateMatches({ desiredStateHash: first.desiredStateHash, rootIdentity: first.rootIdentity }, first), true);
  assert.doesNotMatch(JSON.stringify(first), /API_KEY|test-secret|providerEnv/i);
});

test("default docs desired state keeps provider selection automatic", async () => {
  const root = await fixture();
  const desired = compileNavigationDesiredState({
    root,
    automation: DEFAULT_NAVIGATION_AUTOMATION_CONFIG,
    projectConfig: { docs: { enabled: true } },
    backendIdentities: identities,
  });
  assert.equal(desired.lanes.docs.requested.provider, "auto");
});

test("omitted one-run quality inherits global policy while transient overrides do not change durable project identity", async () => {
  const root = await fixture();
  const base = compileNavigationDesiredState({
    root,
    automation: richPolicy(),
    projectConfig: { docs: { enabled: true } },
    backendIdentities: identities,
    providerAvailable: { docs: true },
  });
  const transient = compileNavigationDesiredState({
    root,
    automation: richPolicy(),
    projectConfig: { docs: { enabled: true } },
    oneRun: { docs: { embeddings: false, aiSummaries: false } },
    backendIdentities: identities,
    providerAvailable: { docs: true },
  });
  assert.equal(base.lanes.docs.effective.embeddings, "auto");
  assert.equal(base.lanes.docs.effective.aiSummaries, false);
  assert.equal(transient.lanes.docs.effective.embeddings, false);
  assert.equal(transient.projectOverrideIdentity, base.projectOverrideIdentity);
  assert.equal(transient.desiredStateHash, base.desiredStateHash, "one-run quality must not change the durable desired-state identity");
});

test("explicit project downgrade is durable and distinguishable from global rich policy", async () => {
  const root = await fixture();
  const desired = compileNavigationDesiredState({
    root,
    automation: richPolicy(),
    projectConfig: { docs: { enabled: true, quality: { embeddings: false, aiSummaries: false } } },
    backendIdentities: identities,
    providerAvailable: { docs: true },
  });
  assert.equal(desired.lanes.docs.requested.embeddings, false);
  assert.equal(desired.lanes.docs.requested.aiSummaries, false);
  assert.match(desired.projectOverrideIdentity, /^[0-9a-f]{64}$/);
});

test("root moves, scope changes, stale state, provider absence, and incompatible backends cannot match ready identity", async () => {
  const root = await fixture();
  const moved = await fixture();
  const first = compileNavigationDesiredState({ root, automation: richPolicy(), projectConfig: { docs: { enabled: true, root: "." } }, backendIdentities: identities, providerAvailable: { docs: true } });
  const second = compileNavigationDesiredState({ root: moved, automation: richPolicy(), projectConfig: { docs: { enabled: true, root: "docs" } }, backendIdentities: { ...identities, docs: { available: true, compatible: false, version: "1.91.0" } }, providerAvailable: { docs: false } });
  assert.notEqual(first.rootIdentity, second.rootIdentity);
  assert.notEqual(first.lanes.docs.scopeDigest, second.lanes.docs.scopeDigest);
  assert.equal(second.lanes.docs.capability, "incompatible");
  assert.ok(second.lanes.docs.diagnostics.includes("docs_backend_incompatible"));
  assert.ok(second.lanes.docs.diagnostics.includes("docs_provider_missing"));
  assert.equal(desiredStateMatches({ desiredStateHash: first.desiredStateHash, rootIdentity: first.rootIdentity }, second), false);
});
