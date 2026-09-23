import assert from "node:assert/strict";
import test from "node:test";

import {
  backendCapability,
  decideAutomationPolicy,
  listBackendCapabilities,
  recommendedPrepareMode,
} from "../src/core/backend-registry.ts";

test("backend capability registry is the clean-break navigation stack", () => {
  const capabilities = listBackendCapabilities();
  assert.deepEqual(capabilities.map(capability => capability.id).sort(), ["graphify", "qmd"]);
  assert.equal(backendCapability("crg"), undefined, "the retired CRG backend must not reappear");

  for (const capability of capabilities) {
    assert.ok(capability.name, `${capability.id} should have a display name`);
    assert.ok(capability.userPurpose, `${capability.id} should explain user purpose`);
    assert.ok(capability.evidence.docs.length + capability.evidence.commandHelp.length + capability.evidence.smokeLogs.length > 0, `${capability.id} should cite evidence`);
    assert.match(capability.evidence.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(capability.prepareModes[capability.defaults.recommendedMode], `${capability.id} recommended mode should exist`);
    assert.ok(capability.undo.length > 0, `${capability.id} should include undo guidance`);
  }
});

test("registry encodes settled lifecycle facts", () => {
  const jdoc = backendCapability("qmd");
  assert.equal(jdoc.defaults.recommendedMode, "hybridDocs");
  assert.equal(jdoc.prepareModes.hybridDocs.usesEmbeddings, true);
  assert.equal(jdoc.prepareModes.hybridDocs.usesLLM, false);
  assert.deepEqual(jdoc.prepareModes.hybridDocs.providers, ["local", "zeroentropy", "voyage", "openrouter"]);
  assert.equal(jdoc.prepareModes.lexicalDocs.localOnly, true);
  assert.deepEqual(jdoc.evidence.docs, ["docs/evidence.md", "native/qmd/UPSTREAM.md"]);
  assert.deepEqual(jdoc.prepareModes.hybridDocs.command.slice(0, 4), ["node", "scripts/navigation-freshen.mjs", "docs", "--path"]);
  assert.equal(jdoc.prepareModes.hybridDocs.command.includes("tools/call:index_local"), false);

  const graphify = backendCapability("graphify");
  assert.equal(graphify.defaults.recommendedMode, "deepExtract");
  assert.equal(graphify.prepareModes.deepExtract.usesLLM, true);
  assert.ok(graphify.install.notes.some(item => /GRAPHIFY_QUERY_LOG_DISABLE=1/.test(item)));
  assert.equal(graphify.install.notes.some(item => /CRG|code-review-graph/.test(item)), false, "Graphify install guidance must not name the retired CRG runtime");
});
test("automation decisions gate provider and visible-write risk", () => {
  const allowFullStack = { allowCloud: true, allowEmbeddings: true, allowLLM: true, allowLocalModelDownloads: true, allowVisibleProjectDirs: true };

  assert.equal(decideAutomationPolicy(backendCapability("qmd"), "hybridDocs", allowFullStack).policy, "auto_logged");
  assert.equal(decideAutomationPolicy(backendCapability("graphify"), "deepExtract", allowFullStack).policy, "auto_logged");

  const qmdLocal = decideAutomationPolicy(backendCapability("qmd"), "hybridDocs", {});
  assert.equal(qmdLocal.policy, "ask_first");
  assert.ok(qmdLocal.reasons.some(reason => /visible project/.test(reason)));
  assert.equal(qmdLocal.reasons.some(reason => /allowCloud|allowEmbeddings/.test(reason)), false);

  const graphRich = decideAutomationPolicy(backendCapability("graphify"), "deepExtract", {});
  assert.equal(graphRich.policy, "ask_first");
  assert.ok(graphRich.reasons.some(reason => /allowCloud/.test(reason)));
  assert.ok(graphRich.reasons.some(reason => /allowLLM/.test(reason)));
});

test("recommended prepare mode is explicit for every backend", () => {
  for (const capability of listBackendCapabilities()) {
    const mode = recommendedPrepareMode(capability);
    assert.equal(mode, capability.prepareModes[capability.defaults.recommendedMode]);
    assert.ok(mode.command.length > 0);
    assert.ok(mode.qualityGates.length > 0);
  }
});
