// Decision protected: generic web_answer is one provisional Exa attempt; research stays skill-owned.
import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { ProviderError } from "../src/failures.ts";
import { AdapterRegistry } from "../src/registry.ts";
import { registerWebAnswer } from "../src/tools/web-answer.ts";

const capability = (id, credentials = []) => ({ id, operations: ["answer"], credentials, strengths: ["general"], returns: ["answers"], timeoutMs: 1000, concurrency: 1, fallbackEligible: true, provenance: "test" });

function register(registry) {
  let tool;
  registerWebAnswer({ registerTool(value) { tool = value; } }, registry);
  return tool;
}

process.env.EXA_API_KEY = "present";
process.env.LINKUP_API_KEY = "present";

test("web_answer makes one disclosed Exa attempt and labels its prose provisional", async () => {
  let exaCalls = 0;
  const tool = register(new AdapterRegistry([
    { capability: capability("exa", ["EXA_API_KEY"]), async answer(intent) {
      exaCalls += 1;
      assert.equal(intent.provider, "exa");
      return { answer: "Synthesized answer", sources: [{ title: "Source", url: "https://example.com", passage: "provider passage", fetched: false, evidenceStatus: "provider-citation", provider: "exa" }], model: "fake", reportedCostUsd: 0.005, nativeResult: { answer: "Synthesized answer" } };
    } },
  ]));

  const result = await tool.execute("id", { question: "What is Pi?" });
  assert.equal(exaCalls, 1);
  assert.equal(result.details.provider, "exa");
  assert.equal(result.details.attempts.length, 1);
  assert.equal(result.details.fallbackOccurred, false);
  assert.equal(result.details.reportedCostUsd, 0.005);
  assert.deepEqual(result.details.nativeResult, { answer: "Synthesized answer" });
  assert.match(result.content[0].text, /^Provisional provider answer/);
});

test("web_answer never falls back to Linkup when Exa fails", async () => {
  let linkupCalls = 0;
  const tool = register(new AdapterRegistry([
    { capability: capability("exa", ["EXA_API_KEY"]), async answer() { throw new ProviderError("network", "exa unavailable"); } },
    { capability: capability("linkup", ["LINKUP_API_KEY"]), async answer() { linkupCalls += 1; return { answer: "wrong fallback", sources: [] }; } },
  ]));

  const result = await tool.execute("id", { question: "What is Pi?" });
  assert.equal(result.details.failureClass, "network");
  assert.equal(result.details.attempts.length, 1);
  assert.equal(result.details.attempts[0].provider, "exa");
  assert.equal(result.details.fallbackOccurred, false);
  assert.equal(linkupCalls, 0);
});


