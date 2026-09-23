// Decision protected: provider specialists keep their accepted schemas, one-attempt dispatch, evidence rights, and cost/work metadata.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { decodeGeneric } from "@blackwell-systems/gcf";
import { Check } from "typebox/value";
import { ProviderError } from "../src/failures.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createExaAdapter } from "../src/adapters/exa.ts";
import { createTavilyAdapter } from "../src/adapters/tavily.ts";
import { createXSearchAdapter } from "../src/adapters/xsearch.ts";
import { selectProviders } from "../src/routing.ts";
import { AdapterRegistry } from "../src/registry.ts";
import { registerWebAnswerSpecialists } from "../src/tools/web-answer-specialists.ts";
import { registerWebSearchSpecialists } from "../src/tools/web-search-specialists.ts";

const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "jeito-websift-specialists-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

function capability(id, operations) {
  return { id, operations, credentials: [], strengths: id === "xsearch" ? ["social"] : id === "tavily" ? ["general", "news"] : ["general"], returns: ["leads", "answers"], filters: ["recency", "domains"], timeoutMs: 1000, concurrency: 1, fallbackEligible: true, provenance: "test" };
}

const captured = {};
const registry = new AdapterRegistry([
  {
    capability: capability("exa", ["search", "answer"]),
    async search(intent) { captured.exaSearch = intent; return [{ title: "Paper", url: "https://example.com/paper", snippet: "candidate", exa: { reportedCostUsd: 0.007 } }]; },
    async answer(intent) { captured.exaAnswer = intent; return { answer: "", structuredData: { verdict: "candidate" }, sources: [{ title: "Citation", url: "https://example.com/source", passage: "provider passage", fetched: false, evidenceStatus: "provider-citation", provider: "exa" }], model: "exa", reportedCostUsd: 0.005, nativeResult: { answer: { verdict: "candidate" } } }; },
  },
  {
    capability: capability("xsearch", ["search"]),
    async search(intent) { captured.xSearch = intent; return [{ title: "X source 1", url: "https://x.com/x/status/1", snippet: "bounded synthesis", sourceType: "social", xsearch: { model: "grok", usage: { totalTokens: 120, xSearchCalls: 3 } } }]; },
  },
  {
    capability: capability("tavily", ["search"]),
    async search(intent) { captured.tavilySearch = intent; return [{ title: "Thai source", url: "https://example.th/source", snippet: "candidate", tavily: { usageCredits: 1, responseTime: 120, requestId: "tv-1" } }]; },
  },
  {
    capability: capability("linkup", ["answer"]),
    async answer(intent) { captured.linkupAnswer = intent; return { answer: "candidate answer", sources: [{ title: "Citation", url: "https://example.com/linkup", fetched: false, evidenceStatus: "provider-citation", provider: "linkup" }], model: "linkup", nativeResult: { answer: "candidate answer" } }; },
  },
]);

const tools = new Map();
const pi = { registerTool(tool) { tools.set(tool.name, tool); } };
registerWebSearchSpecialists(pi, registry);
registerWebAnswerSpecialists(pi, registry);

test("specialist schemas and tool-local guidance expose only accepted behavior", () => {
  assert.deepEqual([...tools.keys()], ["web_search_exa", "web_search_x", "web_search_tavily", "web_answer_exa", "web_answer_linkup"]);
  assert.equal(Check(tools.get("web_search_exa").parameters, { query: "q", searchType: "deep-reasoning", additionalQueries: ["q2"] }), true);
  assert.equal(Check(tools.get("web_search_exa").parameters, { query: "q", searchType: "deep", additionalQueries: [] }), false);
  assert.equal(Check(tools.get("web_search_exa").parameters, { query: "q", userLocation: "USA" }), false);
  assert.equal(Check(tools.get("web_search_exa").parameters, { query: "q", outputSchema: { type: "object" } }), false);
  assert.equal(Check(tools.get("web_search_x").parameters, { query: "q", maxTurns: 2, maxOutputTokens: 800, parallelToolCalls: false, enableImageUnderstanding: true }), true);
  assert.equal(Check(tools.get("web_search_x").parameters, { query: "q", model: "grok", enableVideoUnderstanding: true }), false);
  assert.equal(Check(tools.get("web_search_tavily").parameters, { query: "q", country: "india" }), true);
  assert.equal(Check(tools.get("web_search_tavily").parameters, { query: "q", searchDepth: "advanced" }), false);
  assert.equal(Check(tools.get("web_search_tavily").parameters, { query: "q", exactMatch: true }), false);
  assert.equal(Check(tools.get("web_answer_exa").parameters, { question: "q", text: false, outputSchema: { type: "object", properties: { verdict: { type: "string" } } } }), true);
  assert.equal(Check(tools.get("web_answer_linkup").parameters, { question: "q", depth: "deep", includeInlineCitations: true }), true);
  assert.equal(Check(tools.get("web_answer_linkup").parameters, { question: "q", structuredOutputSchema: { type: "object" } }), false);
  for (const tool of tools.values()) {
    assert.ok(tool.promptSnippet.length > 0);
    assert.equal(tool.promptGuidelines.length, 1);
    assert.ok(tool.promptGuidelines[0].length > 0);
  }
});

test("specialists dispatch once and preserve lead/citation plus cost/work metadata", async () => {
  const exaSearch = await tools.get("web_search_exa").execute("id", { query: "paper", searchType: "deep", additionalQueries: ["implementation"], startPublishedDate: "2026-01-01", includeDomains: ["arxiv.org"] });
  assert.equal(captured.exaSearch.provider, "exa");
  assert.deepEqual(captured.exaSearch.exa.additionalQueries, ["implementation"]);
  assert.equal(exaSearch.details.attempts.length, 1);
  assert.equal(exaSearch.details.fallbackOccurred, false);
  assert.equal(exaSearch.details.sources[0].evidenceStatus, "lead");
  assert.equal(exaSearch.details.reportedCostUsd, 0.007);
  assert.equal(decodeGeneric(exaSearch.content[0].text).records[0].title, "Paper");

  const invalidExa = await tools.get("web_search_exa").execute("id", { query: "paper", searchType: "auto", additionalQueries: ["not allowed"] });
  assert.equal(invalidExa.details.failureClass, "invalid_input");
  assert.equal(invalidExa.details.attempts.length, 0);
  for (const params of [
    { query: "company", category: "company", startPublishedDate: "2026-01-01" },
    { query: "person", category: "people", excludeDomains: ["example.com"] },
  ]) {
    const incompatibleExa = await tools.get("web_search_exa").execute("id", params);
    assert.equal(incompatibleExa.details.failureClass, "invalid_input");
    assert.equal(incompatibleExa.details.attempts.length, 0);
    assert.match(incompatibleExa.content[0].text, /cannot combine with publication bounds or excludeDomains/);
  }

  const xSearch = await tools.get("web_search_x").execute("id", { query: "discussion", count: 3, allowedHandles: ["xai"], fromDate: "2026-07-01", toDate: "2026-07-31", maxTurns: 2, maxOutputTokens: 800, enableImageUnderstanding: true });
  assert.equal(captured.xSearch.provider, "xsearch");
  assert.equal(captured.xSearch.xsearch.maxTurns, 2);
  assert.equal(xSearch.details.xsearch.usage.xSearchCalls, 3);
  assert.equal(xSearch.details.sources[0].evidenceStatus, "lead");

  const tavilySearch = await tools.get("web_search_tavily").execute("id", { query: "India AI safety implementation", country: "india" });
  assert.equal(captured.tavilySearch.provider, "tavily");
  assert.equal(captured.tavilySearch.fallbackOnExplicit, false);
  assert.equal(captured.tavilySearch.count, 10);
  assert.equal(captured.tavilySearch.kind, "general");
  assert.deepEqual(captured.tavilySearch.tavily, { searchDepth: "basic", country: "india" });
  assert.equal(tavilySearch.details.reportedUsageCredits, 1);
  assert.equal(tavilySearch.details.sources[0].evidenceStatus, "lead");


  const realCapabilities = new AdapterRegistry([createExaAdapter(), createXSearchAdapter(), createTavilyAdapter()]);
  assert.equal(selectProviders(realCapabilities, captured.exaSearch, DEFAULT_CONFIG)[0].capability.id, "exa");
  assert.equal(selectProviders(realCapabilities, captured.xSearch, DEFAULT_CONFIG)[0].capability.id, "xsearch");
  assert.equal(selectProviders(realCapabilities, captured.tavilySearch, DEFAULT_CONFIG)[0].capability.id, "tavily");

  const exaAnswer = await tools.get("web_answer_exa").execute("id", { question: "Which candidate?", text: false, systemPrompt: "Do not infer", outputSchema: { type: "object" } });
  assert.equal(captured.exaAnswer.provider, "exa");
  assert.equal(captured.exaAnswer.exa.text, false);
  assert.equal(exaAnswer.details.sources[0].evidenceStatus, "provider-citation");
  assert.equal(exaAnswer.details.reportedCostUsd, 0.005);
  assert.deepEqual(decodeGeneric(exaAnswer.content[0].text).records[0].data, { verdict: "candidate" });

  const linkupAnswer = await tools.get("web_answer_linkup").execute("id", { question: "What changed?", depth: "deep", fromDate: "2026-07-01", toDate: "2026-07-31", includeDomains: ["example.com"], includeInlineCitations: false });
  assert.equal(captured.linkupAnswer.provider, "linkup");
  assert.deepEqual(captured.linkupAnswer.linkup, { depth: "deep", fromDate: "2026-07-01", toDate: "2026-07-31", includeDomains: ["example.com"], excludeDomains: undefined, includeInlineCitations: false });
  assert.equal(linkupAnswer.details.attempts.length, 1);
  assert.equal(linkupAnswer.details.fallbackOccurred, false);
  assert.equal(linkupAnswer.details.sources[0].evidenceStatus, "provider-citation");
});
test("specialist zeros are successful scoped outcomes with controls, metadata, and one mutation", async () => {
  const zeroExa = [];
  zeroExa.exa = { reportedCostUsd: 0.001, adjudication: { providerCount: 2, qualifyingCount: 0, unverifiableCount: 1, rejected: [{ reason: "domain not in includeDomains (example.com)", count: 1 }], enforced: ["includeDomains"], notEnforced: [] } };
  const zeroX = [];
  zeroX.xsearch = { model: "grok", synthesis: "No cited post was retrieved for the requested window.", usage: { totalTokens: 60, xSearchCalls: 1 } };
  const zeroTavily = [];
  zeroTavily.tavily = { usageCredits: 1, responseTime: 80, requestId: "tv-zero" };
  const local = new AdapterRegistry([
    { capability: capability("exa", ["search", "answer"]), async search() { return zeroExa; } },
    { capability: capability("xsearch", ["search"]), async search() { return zeroX; } },
    { capability: capability("tavily", ["search"]), async search() { return zeroTavily; } },
  ]);
  const localTools = new Map();
  registerWebSearchSpecialists({ registerTool(tool) { localTools.set(tool.name, tool); } }, local);

  const exaZero = await localTools.get("web_search_exa").execute("id", { query: "identity", includeDomains: ["arxiv.org"] });
  assert.equal(exaZero.details.failureClass, undefined);
  assert.equal(exaZero.details.attempts[0].status, "ok");
  assert.equal(exaZero.details.resultCount, 0);
  assert.equal(exaZero.details.reportedCostUsd, 0.001);
  assert.deepEqual(exaZero.details.exaAdjudication.rejected, [{ reason: "domain not in includeDomains (example.com)", count: 1 }]);
  assert.match(exaZero.content[0].text, /^Search completed: 0 qualifying results/);
  assert.match(exaZero.content[0].text, /simplify an overloaded exact-identity query/);

  const xZero = await localTools.get("web_search_x").execute("id", { query: "discussion", fromDate: "2026-07-01", toDate: "2026-07-31" });
  assert.equal(xZero.details.failureClass, undefined);
  assert.equal(xZero.details.attempts[0].status, "ok");
  assert.equal(xZero.details.resultCount, 0);
  assert.equal(xZero.details.xsearch.usage.xSearchCalls, 1);
  assert.match(xZero.content[0].text, /0 cited X posts/);
  assert.match(xZero.content[0].text, /not absence of a post or event/);
  assert.match(xZero.content[0].text, /Provider synthesis: No cited post was retrieved/);
  assert.match(xZero.content[0].text, /Widen the event window or authority scope once/);

  const tavilyZero = await localTools.get("web_search_tavily").execute("id", { query: "guide", country: "india" });
  assert.equal(tavilyZero.details.failureClass, undefined);
  assert.equal(tavilyZero.details.attempts[0].status, "ok");
  assert.equal(tavilyZero.details.resultCount, 0);
  assert.equal(tavilyZero.details.reportedUsageCredits, 1);
  assert.equal(tavilyZero.details.tavily.requestId, "tv-zero");
  assert.match(tavilyZero.content[0].text, /^Search completed: 0 results/);
  assert.match(tavilyZero.content[0].text, /Change one regional, source-language, or independent-guide hypothesis/);
});

test("specialist failure recovery is operation-aware", async () => {
  const searchRegistry = new AdapterRegistry([
    { capability: capability("exa", ["search"]), async search() { throw new ProviderError("empty", "no content"); } },
  ]);
  const searchTools = new Map();
  registerWebSearchSpecialists({ registerTool(tool) { searchTools.set(tool.name, tool); } }, searchRegistry);
  const searchFailure = await searchTools.get("web_search_exa").execute("id", { query: "q" });
  assert.equal(searchFailure.details.failureClass, "empty");
  assert.match(searchFailure.content[0].text, /one changed lexical constraint/);

  const answerRegistry = new AdapterRegistry([
    { capability: capability("exa", ["answer"]), async answer() { throw new ProviderError("empty", "no answer"); } },
  ]);
  const answerTools = new Map();
  registerWebAnswerSpecialists({ registerTool(tool) { answerTools.set(tool.name, tool); } }, answerRegistry);
  const answerFailure = await answerTools.get("web_answer_exa").execute("id", { question: "q" });
  assert.equal(answerFailure.details.failureClass, "empty");
  assert.match(answerFailure.content[0].text, /Reformulate the question or fetch decisive sources/);
});
