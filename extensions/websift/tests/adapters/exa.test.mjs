// Decision protected: Exa request mapping, cost metadata, answer evidence state, and internal operation reachability remain deterministic.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createExaAdapter, fetchExaContents, findSimilarWithExa, normalizeExaSearch, runExaResearch } from "../../src/adapters/exa.ts";
const fixture = JSON.parse(await readFile(new URL("../fixtures/exa/search.json", import.meta.url), "utf8"));
test("normalizes Exa SDK search results", () => assert.deepEqual(normalizeExaSearch(fixture, "academic"), [{ title: "Exa result", url: "https://example.com/exa", snippet: "semantic passage", publishedAt: "2026-07-28", score: 0.9, sourceType: "academic" }]));
test("Exa valid zero provider rows are a successful scoped zero with cost retained", async () => {
  const adapter = createExaAdapter(() => ({ search: async () => ({ results: [], costDollars: { total: 0.003 } }) }));
  const results = await adapter.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 5 }, { credential: "secret", timeoutMs: 1000, persist() {} });
  assert.equal(results.length, 0);
  assert.equal(results.exa.reportedCostUsd, 0.003);
  // A malformed root/results shape is provider-contract unavailable, never a zero.
  const malformed = createExaAdapter(() => ({ search: async () => ({ nope: true }) }));
  await assert.rejects(() => malformed.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 5 }, { credential: "secret", timeoutMs: 1000, persist() {} }), { failureClass: "unavailable" });
  assert.throws(() => normalizeExaSearch({ results: [null] }, "general"), { failureClass: "unavailable" });
});
test("Exa local adjudication enforces domain forms and inclusive parseable dates only", async () => {
  const rows = [
    { title: "A", url: "https://arxiv.org/abs/2604.18580", publishedDate: "2026-07-10" },
    { title: "B", url: "https://blog.example.com/post", publishedDate: "2026-06-01" },
    { title: "C", url: "https://example.com/docs/guide", publishedDate: "not-a-date" },
    { title: "D", url: "https://other.org/x", publishedDate: "2026-07-20" },
    { title: "E", url: "https://www.example.com/docs/faq", publishedDate: "2026-07-31T23:59:00Z" },
  ];
  const adapter = createExaAdapter(() => ({ search: async () => ({ results: rows, costDollars: { total: 0.004 } }) }));
  // includeDomains mixes a plain hostname (matches the host and subdomains) and a hostname/path
  // prefix; the date window is inclusive; category and text filters are focus/hint only.
  const results = await adapter.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10, recency: { from: "2026-07-01", to: "2026-07-31" }, domains: { include: ["arxiv.org", "example.com/docs"] }, exa: { category: "publication", includeText: "needle" } }, { credential: "secret", timeoutMs: 1000, persist() {} });
  assert.deepEqual(results.map((row) => row.title), ["A", "E"]);
  assert.deepEqual(results[0].exa.adjudication, {
    providerCount: 5, qualifyingCount: 2, unverifiableCount: 1,
    rejected: [
      { reason: "domain not in includeDomains (blog.example.com)", count: 1 },
      { reason: "domain not in includeDomains (other.org)", count: 1 },
    ],
    enforced: ["includeDomains", "startPublishedDate", "endPublishedDate"],
    notEnforced: ["includeText/excludeText (full page text not retained in normalized rows)", "category (provider focus hint, not a result class)"],
  });
  assert.equal(results[0].exa.reportedCostUsd, 0.004);
});
test("Exa local adjudication honors *.wildcard subdomain controls and rejects unparseable bounds", async () => {
  const rows = [
    { title: "Sub", url: "https://a.github.io/project", publishedDate: "2026-07-05" },
    { title: "Apex", url: "https://github.io/project", publishedDate: "2026-07-05" },
  ];
  const adapter = createExaAdapter(() => ({ search: async () => ({ results: rows }) }));
  const wildcard = await adapter.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10, domains: { include: ["*.github.io"] } }, { credential: "secret", timeoutMs: 1000, persist() {} });
  assert.deepEqual(wildcard.map((row) => row.title), ["Sub"]);
  assert.deepEqual(wildcard[0].exa.adjudication.rejected, [{ reason: "domain not in includeDomains (github.io)", count: 1 }]);
  // An unparseable requested bound is reported as not enforced; rows are not filtered on it.
  const invalidBound = await adapter.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10, recency: { from: "not-a-date" } }, { credential: "secret", timeoutMs: 1000, persist() {} });
  assert.equal(invalidBound.length, 2);
  assert.match(invalidBound[0].exa.adjudication.notEnforced[0], /unparseable bound/);
  const unsupportedDomain = await adapter.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10, domains: { include: ["github.io/*/project"] } }, { credential: "secret", timeoutMs: 1000, persist() {} });
  assert.equal(unsupportedDomain.length, 2);
  assert.match(unsupportedDomain[0].exa.adjudication.notEnforced[0], /includeDomains \(unsupported control shape/);
});
test("maps current Exa search content requests", async () => {
  const calls = [];
  const adapter = createExaAdapter(() => ({ search: async (_query, value) => { calls.push(value); return fixture; } }));
  const first = await adapter.search({ operation: "search", query: "q", kind: "academic", depth: "standard", strategy: "single", fallbackOnExplicit: false, recency: { from: "2026-07-01" }, domains: { include: ["arxiv.org"] }, count: 7, exa: { searchType: "deep", category: "publication", includeText: "retrieval agent", returnFullText: true, maxCharacters: 7000, systemPrompt: "Prefer primary papers", additionalQueries: ["agentic retrieval"] } }, { credential: "secret", timeoutMs: 1000, persist() {} });
  await adapter.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 3 }, { credential: "secret", timeoutMs: 1000, persist() {} });
  assert.deepEqual(calls[0], { type: "deep", numResults: 7, includeDomains: ["arxiv.org"], excludeDomains: undefined, startPublishedDate: "2026-07-01", endPublishedDate: undefined, category: "publication", includeText: ["retrieval agent"], excludeText: undefined, userLocation: undefined, moderation: undefined, systemPrompt: "Prefer primary papers", additionalQueries: ["agentic retrieval"], flags: undefined, outputSchema: undefined, contents: { text: { maxCharacters: 7000 } } });
  assert.deepEqual(calls[1].contents, { highlights: true });
  // The fixture row (example.com, published 2026-07-28) fails the requested arxiv.org include-domain
  // hard filter, so the adapter returns a successful scoped zero with the local adjudication verdict.
  assert.equal(first.length, 0);
  assert.deepEqual(first.exa.adjudication, {
    providerCount: 1, qualifyingCount: 0, unverifiableCount: 0,
    rejected: [{ reason: "domain not in includeDomains (example.com)", count: 1 }],
    enforced: ["includeDomains", "startPublishedDate"],
    notEnforced: ["includeText/excludeText (full page text not retained in normalized rows)", "category (provider focus hint, not a result class)"],
  });
});

test("retains provider-reported Exa search cost without changing normalized leads", async () => {
  const adapter = createExaAdapter(() => ({ search: async () => ({ ...fixture, costDollars: { total: 0.007 } }) }));
  const results = await adapter.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 5 }, { credential: "secret", timeoutMs: 1000, persist() {} });
  assert.equal(results[0].exa.reportedCostUsd, 0.007);
});

test("maps Exa answer controls while retaining structured native output and citation evidence", async () => {
  const captured = [];
  const nativeResult = { answer: { verdict: "candidate" }, citations: [{ title: "Provider citation", url: "https://example.com/source", text: "provider-returned passage" }] };
  const adapter = createExaAdapter(() => ({ answer: async (_question, options) => { captured.push(options); return nativeResult; } }));
  const result = await adapter.answer({ operation: "answer", question: "q", mode: "answer" }, { credential: "secret", timeoutMs: 1000, persist() {} });
  await adapter.answer({ operation: "answer", question: "q", mode: "answer", exa: { text: true, systemPrompt: "Be exact", userLocation: "JP", outputSchema: { type: "object" } } }, { credential: "secret", timeoutMs: 1000, persist() {} });
  assert.equal(captured[0].text, false);
  assert.deepEqual(captured[1], { text: true, systemPrompt: "Be exact", userLocation: "JP", outputSchema: { type: "object" } });
  assert.equal(result.answer, "");
  assert.deepEqual(result.structuredData, { verdict: "candidate" });
  assert.equal(result.nativeResult, nativeResult);
  assert.deepEqual(result.sources[0], { title: "Provider citation", url: "https://example.com/source", passage: "provider-returned passage", fetched: false, evidenceStatus: "provider-citation", provider: "exa" });
  const malformed = createExaAdapter(() => ({ answer: async () => ({ answer: "candidate", citations: {} }) }));
  await assert.rejects(() => malformed.answer({ operation: "answer", question: "q", mode: "answer" }, { credential: "secret", timeoutMs: 1000, persist() {} }), { failureClass: "unavailable" });
  const malformedRows = createExaAdapter(() => ({ answer: async () => ({ answer: "candidate", citations: [null] }) }));
  await assert.rejects(() => malformedRows.answer({ operation: "answer", question: "q", mode: "answer" }, { credential: "secret", timeoutMs: 1000, persist() {} }), { failureClass: "unavailable" });
});
test("keeps Exa content, similarity, and research callable without registering tools", async () => {
  const calls = { content: [] };
  const client = {
    async getContents(_urls, options) { calls.content.push(options); return { results: [{ url: "https://example.com/doc", title: "Doc", highlights: ["source passage"] }], statuses: [{ id: "https://example.com/doc", status: "success", source: "cached" }, { id: "https://example.com/missing", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } }], costDollars: { total: 0.002, contents: { highlights: 0.002 } } }; },
    async findSimilar(_url, options) { calls.similar = options; return fixture; },
    research: {
      async create(params) { calls.research = params; return { id: "research-1" }; },
      async pollUntilFinished() { return { status: "completed", output: "result" }; },
    },
  };
  const content = await fetchExaContents(client, { urls: ["https://example.com/doc"], mode: "highlights", query: "method and result", maxCharacters: 1200, maxAgeHours: 24, livecrawlTimeout: 12_000, filterEmptyResults: false, subpages: 2 });
  await fetchExaContents(client, { urls: ["https://example.com/doc"], mode: "text", textOptions: { verbosity: "compact", includeSections: ["body"] } });
  const similar = await findSimilarWithExa(client, { url: "https://example.com/source", count: 3, excludeSourceDomain: true });
  const research = await runExaResearch(client, { instructions: "compare evidence", model: "exa-research-fast", maxWaitMs: 1000 });
  assert.deepEqual([content.values[0].content, content.statuses[1].errorTag, content.statuses[1].httpStatusCode, content.cost?.total, similar[0].url, research.id, research.status], ["source passage", "CRAWL_NOT_FOUND", 404, 0.002, "https://example.com/exa", "research-1", "completed"]);
  assert.deepEqual(calls, { content: [{ highlights: { query: "method and result", maxCharacters: 1200 }, maxAgeHours: 24, livecrawlTimeout: 12_000, filterEmptyResults: false, subpages: 2, subpageTarget: undefined, extras: undefined }, { text: { maxCharacters: 5000, verbosity: "compact", includeSections: ["body"] }, maxAgeHours: 0, livecrawlTimeout: undefined, filterEmptyResults: undefined, subpages: undefined, subpageTarget: undefined, extras: undefined }], similar: { numResults: 3, excludeSourceDomain: true, contents: { highlights: true } }, research: { instructions: "compare evidence", model: "exa-research-fast", outputSchema: undefined } });
});

test("maps Exa SDK auth failures", async () => {
  const adapter = createExaAdapter(() => ({ search: async () => { throw Object.assign(new Error("bad"), { statusCode: 401 }); } }));
  await assert.rejects(() => adapter.search({ operation: "search", query: "x", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10 }, { credential: "secret", timeoutMs: 1000, persist() {} }), (error) => error.failureClass === "auth");
});