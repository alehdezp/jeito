// Decision protected: web_search is one explicit Serper lexical method with a closed schema, one no-fallback attempt, lead-only output, and preserved Serper metadata.
import assert from "node:assert/strict";
import test from "node:test";
import { decodeGeneric } from "@blackwell-systems/gcf";
import { Check } from "typebox/value";
import { ProviderError } from "../src/failures.ts";
import { AdapterRegistry } from "../src/registry.ts";
import { registerWebSearch } from "../src/tools/web-search.ts";

function serperAdapter(search) {
  return {
    capability: { id: "serper", operations: ["search"], credentials: [], strengths: ["general"], returns: ["leads"], timeoutMs: 1000, concurrency: 1, fallbackEligible: true, provenance: "test" },
    search,
  };
}

function register(registry) {
  const tools = [];
  registerWebSearch({ registerTool(tool) { tools.push(tool); } }, registry);
  assert.equal(tools.length, 1);
  return tools[0];
}

test("web_search exposes only the Serper lexical contract", () => {
  const tool = register(new AdapterRegistry([]));
  assert.equal(Check(tool.parameters, { query: 'site:example.com "exact phrase"', country: "in" }), true);
  assert.equal(Check(tool.parameters, { query: "q", limit: 10 }), false);
  assert.equal(Check(tool.parameters, { query: "q", freshness: "week" }), true);
  assert.equal(Check(tool.parameters, { query: "q", freshness: "fortnight" }), false);
  assert.equal(Check(tool.parameters, { query: "q", language: "hi" }), false);
  assert.equal(Check(tool.parameters, { query: "q", provider: "exa" }), false);
  assert.equal(Check(tool.parameters, { requests: [{ query: "q", route: { provider: "serper" } }] }), false);
  assert.equal(tool.promptGuidelines.length, 1);
  assert.match(tool.promptGuidelines[0], /Advanced combos are expected/);
  assert.match(tool.parameters.properties.query.description, /Operators combine freely and stack/);
});

test("web_search dispatches once to Serper and preserves lead plus provider metadata", async () => {
  let captured;
  const tool = register(new AdapterRegistry([serperAdapter(async (intent) => {
    captured = intent;
    return [{
      title: "Official result", url: "https://example.com/official", snippet: "candidate",
      serper: { effective: { query: intent.query, num: intent.count, country: "in" }, answerBox: { answer: "candidate" }, warnings: ["answer lead"] },
    }];
  })]));

  const result = await tool.execute("id", { query: 'site:example.com "exact phrase"', country: "in" });
  assert.equal(captured.provider, "serper");
  assert.equal(captured.fallbackOnExplicit, false);
  assert.equal(captured.count, 10);
  assert.deepEqual(captured.serper, { country: "in", tbs: "qdr:m" });
  assert.equal(result.details.provider, "serper");
  assert.equal(result.details.attempts.length, 1);
  assert.equal(result.details.fallbackOccurred, false);
  assert.equal(result.details.sources[0].evidenceStatus, "lead");
  assert.deepEqual(result.details.serper.answerBox, { answer: "candidate" });
  assert.equal(decodeGeneric(result.content[0].text).records[0].title, "Official result");
});

test("web_search leaves country normalization and receipts to the Serper adapter", async () => {
  let captured;
  const tool = register(new AdapterRegistry([serperAdapter(async (intent) => {
    captured = intent;
    return [{ title: "Result", url: "https://example.com", snippet: "lead", serper: { effective: { query: intent.query, num: 10, country: "us" }, warnings: ['Serper country normalized " US " -> "us"'] } }];
  })]));
  const result = await tool.execute("id", { query: "q", country: " US " });
  assert.equal(captured.serper.country, " US ");
  assert.ok(result.details.warnings.some((warning) => /Serper country normalized/.test(warning)));
});


test("web_search rejects a blank query before provider dispatch", async () => {
  let calls = 0;
  const tool = register(new AdapterRegistry([serperAdapter(async () => { calls += 1; return []; })]));
  const blank = await tool.execute("id", { query: "   " });
  assert.equal(blank.details.failureClass, "invalid_input");
  assert.equal(calls, 0);
});

test("web_search reports zero matches as a successful search outcome with one useful mutation", async () => {
  const empty = [];
  empty.serper = { effective: { query: "provider query", num: 10 }, answerBox: { answer: "candidate" }, warnings: ["candidate only"] };
  const tool = register(new AdapterRegistry([serperAdapter(async () => empty)]));

  const narrow = await tool.execute("narrow", { query: 'site:docs.exa.ai "includeText" "startPublishedDate"' });
  assert.match(narrow.content[0].text, /^Search completed: 0 organic results/);
  assert.match(narrow.content[0].text, /Query: "site:docs\.exa\.ai/);
  assert.match(narrow.content[0].text, /Remove one site:.*quoted phrase/);
  assert.equal(narrow.details.query, 'site:docs.exa.ai "includeText" "startPublishedDate"');
  assert.equal(narrow.details.resultCount, 0);
  assert.equal(narrow.details.failureClass, undefined);
  assert.equal(narrow.details.attempts[0].status, "ok");
  assert.deepEqual(narrow.details.serper.answerBox, { answer: "candidate" });
  assert.ok(narrow.details.warnings.includes("candidate only"));

  const broad = await tool.execute("broad", { query: "exa search filters" });
  assert.match(broad.content[0].text, /add exactly one site:.*quoted identity/i);
  assert.doesNotMatch(broad.content[0].text, /failed/i);
  assert.match(tool.promptGuidelines[0], /freshness.*default month/);
});

test("web_search never falls back after a Serper failure", async () => {
  let otherCalls = 0;
  const other = {
    capability: { id: "exa", operations: ["search"], credentials: [], strengths: ["general"], returns: ["leads"], timeoutMs: 1000, concurrency: 1, fallbackEligible: true, provenance: "test" },
    async search() { otherCalls += 1; return [{ title: "wrong", url: "https://exa.example", snippet: "wrong" }]; },
  };
  const tool = register(new AdapterRegistry([
    serperAdapter(async () => { throw new ProviderError("network", "down"); }),
    other,
  ]));
  const result = await tool.execute("id", { query: "q" });
  assert.equal(result.details.failureClass, "network");
  assert.equal(result.details.attempts.length, 1);
  assert.equal(result.details.attempts[0].provider, "serper");
  assert.equal(result.details.fallbackOccurred, false);
  assert.equal(otherCalls, 0);
});
