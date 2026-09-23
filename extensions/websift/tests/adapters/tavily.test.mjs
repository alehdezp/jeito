// Decision protected: Tavily request mapping, exact-date guards, usage credits, cancellation, and credential redaction remain deterministic.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createTavilyAdapter, tavilySearch, tavilyExtract, tavilyMap, tavilyCrawl, runTavilyResearch, tavilyGetUsage } from "../../src/adapters/tavily.ts";
const searchFixture = JSON.parse(await readFile(new URL("../fixtures/tavily/search.json", import.meta.url), "utf8"));

const context = { credential: "secret-tavily-test-key", timeoutMs: 1000, persist() {} };

// --- Adapter-level: common public behavior ---

test("normalizes Tavily search results", async () => {
  const adapter = createTavilyAdapter(() => ({ search: async () => searchFixture }));
  const result = await adapter.search({ operation: "search", query: "news", kind: "news", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10 }, context);
  assert.deepEqual(result, [{ title: "Tavily result", url: "https://example.com/tavily", snippet: "news passage", publishedAt: "2026-07-28", score: 0.8, sourceType: "news", tavily: { usageCredits: undefined, responseTime: 0.2, requestId: undefined } }]);
});
test("Tavily valid zero results are a successful scoped zero with usage metadata retained", async () => {
  const adapter = createTavilyAdapter(() => ({ search: async () => ({ query: "q", responseTime: 0.1, images: [], results: [], usage: { credits: 2 }, requestId: "req-zero" }) }));
  const results = await adapter.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10 }, context);
  assert.equal(results.length, 0);
  assert.deepEqual(results.tavily, { usageCredits: 2, responseTime: 0.1, requestId: "req-zero" });
});

test("Tavily keeps valid siblings with a malformed omission count and fails all-malformed rows", async () => {
  const partial = createTavilyAdapter(() => ({ search: async () => ({ query: "q", responseTime: 0.1, images: [], results: [{ title: "ok", url: "https://a.example", content: "c", score: 1, publishedDate: "d" }, { title: "bad" }], usage: { credits: 1 }, requestId: "req-1" }) }));
  const results = await partial.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10 }, context);
  assert.equal(results.length, 1);
  assert.equal(results[0].tavily.malformedOmissionCount, 1);
  const allBad = createTavilyAdapter(() => ({ search: async () => ({ query: "q", responseTime: 0.1, images: [], results: [null, { title: "only" }], usage: { credits: 1 }, requestId: "req-2" }) }));
  await assert.rejects(() => allBad.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10 }, context), { failureClass: "unavailable" });
});

test("normalizes Tavily extract results", async () => {
  const adapter = createTavilyAdapter(() => ({ extract: async () => ({ results: [{ url: "https://example.com", rawContent: "content" }], failedResults: [], responseTime: 0.1 }) }));
  const result = await adapter.fetch({ operation: "fetch", url: "https://example.com", mode: "page", extract: "readable" }, context);
  assert.deepEqual(result, [{ url: "https://example.com", title: "https://example.com", content: "content", tavily: { usageCredits: undefined, responseTime: 0.1, requestId: undefined } }]);
});

test("normalizes Tavily map URLs as bounded leads", async () => {
  let body;
  const adapter = createTavilyAdapter(undefined, async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ results: ["https://example.com/a", "https://example.com/b"] }), { headers: { "content-type": "application/json" } });
  });
  const [result] = await adapter.fetch({ operation: "fetch", url: "https://example.com", mode: "map", extract: "readable" }, context);
  assert.equal(body.limit, 25);
  assert.equal(body.allow_external, false);
  assert.equal(result.content, "https://example.com/a\nhttps://example.com/b");
  assert.equal(result.contentType, "text/uri-list");
});

// --- Focused operations: complete provider contract ---

test("tavilySearch captures complete advanced search shape and preserves answer/images/raw internally", async () => {
  let captured;
  const mockClient = {
    search: async (query, options) => {
      captured = options;
      return { answer: "Synthesized answer", query, responseTime: 0.5,
        images: [{ url: "https://example.com/diagram.png", description: "architecture" }],
        usage: { credits: 2 }, requestId: "req-search-1", autoParameters: { searchDepth: "advanced" },
        results: [{ title: "Result", url: "https://example.com/r", content: "summary", rawContent: "full text", score: 0.95, publishedDate: "2026-07-28" }] };
    },
  };
  const response = await tavilySearch("key", "quantum", {
    searchDepth: "advanced", topic: "finance", includeAnswer: "advanced", includeImages: true,
    includeImageDescriptions: true, includeRawContent: "markdown", timeRange: "week",
    maxResults: 5, chunksPerSource: 3, maxTokens: 1000, days: 7,
    includeDomains: ["finance.example"], excludeDomains: ["spam.example"], country: "united states",
    startDate: "2026-07-01", endDate: "2026-07-31", autoParameters: false, exactMatch: true, timeout: 60,
  }, context, () => mockClient);
  assert.equal(captured.searchDepth, "advanced");
  assert.equal(captured.topic, "finance");
  assert.equal(captured.includeAnswer, "advanced");
  assert.equal(captured.includeImages, true);
  assert.equal(captured.includeImageDescriptions, true);
  assert.equal(captured.includeRawContent, "markdown");
  assert.equal(captured.timeRange, "week");
  assert.equal(captured.maxResults, 5);
  assert.equal(captured.chunksPerSource, 3);
  assert.equal(captured.maxTokens, 1000);
  assert.equal(captured.days, 7);
  assert.deepEqual(captured.includeDomains, ["finance.example"]);
  assert.deepEqual(captured.excludeDomains, ["spam.example"]);
  assert.equal(captured.timeout, 60);
  assert.equal(captured.country, "united states");
  assert.equal(captured.startDate, "2026-07-01");
  assert.equal(captured.endDate, "2026-07-31");
  assert.equal(captured.autoParameters, false);
  assert.equal(captured.exactMatch, true);
  assert.equal(captured.includeUsage, true);
  assert.equal(response.answer, "Synthesized answer");
  assert.equal(response.images[0].url, "https://example.com/diagram.png");
  assert.equal(response.images[0].description, "architecture");
  assert.equal(response.results[0].rawContent, "full text");
  assert.equal(response.responseTime, 0.5);
  assert.equal(response.usageCredits, 2);
  assert.equal(response.requestId, "req-search-1");
  assert.equal(response.autoParameters.searchDepth, "advanced");
});

test("tavilySearch rejects equal or reversed exact-date bounds before the SDK call", async () => {
  let called = false;
  const clientFactory = () => {
    called = true;
    return { search: async () => ({}) };
  };
  for (const controls of [
    { startDate: "2026-07-29", endDate: "2026-07-29" },
    { startDate: "2026-07-30", endDate: "2026-07-29" },
  ]) {
    await assert.rejects(
      tavilySearch("key", "query", controls, context, clientFactory),
      (error) => {
        assert.equal(error.failureClass, "invalid_input");
        assert.match(error.message, /startDate must be before endDate/);
        return true;
      },
    );
  }
  assert.equal(called, false, "invalid date bounds must not spend a provider call");
});

test("tavilyExtract preserves mixed success/failedResults and rejects URL bound", async () => {
  const tooMany = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
  let called = false;
  await assert.rejects(
    tavilyExtract("key", tooMany, {}, context, () => { called = true; return { extract: async () => ({}) }; }),
    /1-20/,
  );
  assert.equal(called, false, "SDK extract must not be called after URL bound rejection");
  let captured;
  const mockClient = {
    extract: async (_urls, options) => {
      captured = options;
      return {
        results: [{ url: "https://ok.com", rawContent: "good", images: ["https://ok.com/img.png"] }],
        failedResults: [{ url: "https://bad.com", error: "timeout" }],
        responseTime: 0.5,
      };
    },
  };
  const response = await tavilyExtract("key", ["https://ok.com", "https://bad.com"], { extractDepth: "advanced", includeImages: true, timeout: 60 }, context, () => mockClient);
  assert.equal(captured.extractDepth, "advanced");
  assert.equal(captured.includeImages, true);
  assert.equal(captured.timeout, 60);
  assert.equal(response.results[0].rawContent, "good");
  assert.deepEqual(response.results[0].images, ["https://ok.com/img.png"]);
  assert.equal(response.failedResults[0].url, "https://bad.com");
  assert.equal(response.failedResults[0].error, "timeout");
  assert.equal(response.responseTime, 0.5);
});

test("tavilyMap sends full request body, preserves metadata, and passes outer signal to fetch", async () => {
  let body, signal;
  const controller = new AbortController();
  const ctx = { credential: "key", timeoutMs: 20_000, persist() {}, signal: controller.signal };
  const mockFetch = async (_url, init) => {
    body = JSON.parse(init.body);
    signal = init.signal;
    return new Response(JSON.stringify({
      base_url: "https://docs.example.com",
      results: ["https://docs.example.com/a", "https://docs.example.com/b"],
      response_time: 2.0, usage: { credits: 3 }, request_id: "req-map-1",
    }), { headers: { "content-type": "application/json" } });
  };
  const result = await tavilyMap("key", {
    url: "https://docs.example.com", instructions: "find api docs",
    maxDepth: 2, maxBreadth: 30, limit: 50,
    selectPaths: ["/docs/.*"], selectDomains: ["^docs\\.example\\.com$"],
    excludePaths: ["/private/.*"], excludeDomains: ["^private\\.example\\.com$"],
    allowExternal: false, timeout: 60,
  }, ctx, mockFetch);
  assert.equal(body.url, "https://docs.example.com");
  assert.equal(body.instructions, "find api docs");
  assert.equal(body.max_depth, 2);
  assert.equal(body.max_breadth, 30);
  assert.equal(body.limit, 50);
  assert.deepEqual(body.select_paths, ["/docs/.*"]);
  assert.deepEqual(body.exclude_paths, ["/private/.*"]);
  assert.deepEqual(body.select_domains, ["^docs\\.example\\.com$"]);
  assert.deepEqual(body.exclude_domains, ["^private\\.example\\.com$"]);
  assert.equal(body.allow_external, false);
  assert.equal(body.timeout, 60);
  assert.ok(signal instanceof AbortSignal, "combined outer/timeout signal must be passed to fetch");
  controller.abort();
  assert.equal(signal.aborted, true, "outer abort must propagate to the HTTP signal");
  assert.equal(result.baseUrl, "https://docs.example.com");
  assert.deepEqual(result.results, ["https://docs.example.com/a", "https://docs.example.com/b"]);
  assert.equal(result.responseTime, 2.0);
  assert.equal(result.usageCredits, 3);
  assert.equal(result.requestId, "req-map-1");
});

test("tavilyCrawl sends bounded body and preserves page content, favicon, and metadata", async () => {
  let body;
  const ctx = { credential: "key", timeoutMs: 1000, persist() {} };
  const mockFetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      base_url: "https://docs.example.com",
      results: [{ url: "https://docs.example.com/guide", raw_content: "# Guide\ncontent", favicon: "https://docs.example.com/fav.ico" }],
      response_time: 1.5, usage: { credits: 5 }, request_id: "req-123",
    }), { headers: { "content-type": "application/json" } });
  };
  const result = await tavilyCrawl("key", {
    url: "https://docs.example.com", instructions: "crawl api docs", limit: 10,
    maxDepth: 2, maxBreadth: 30,
    selectPaths: ["/docs/.*"], selectDomains: ["^docs\\.example\\.com$"],
    excludePaths: ["/private/.*"], excludeDomains: ["^private\\.example\\.com$"],
    allowExternal: true, includeImages: true, extractDepth: "advanced", format: "markdown", timeout: 60,
  }, ctx, mockFetch);
  assert.equal(body.url, "https://docs.example.com");
  assert.equal(body.limit, 10);
  assert.equal(body.max_depth, 2);
  assert.equal(body.extract_depth, "advanced");
  assert.equal(body.format, "markdown");
  assert.equal(body.instructions, "crawl api docs");
  assert.equal(body.max_breadth, 30);
  assert.deepEqual(body.select_paths, ["/docs/.*"]);
  assert.deepEqual(body.select_domains, ["^docs\\.example\\.com$"]);
  assert.deepEqual(body.exclude_paths, ["/private/.*"]);
  assert.deepEqual(body.exclude_domains, ["^private\\.example\\.com$"]);
  assert.equal(body.allow_external, true);
  assert.equal(body.include_images, true);
  assert.equal(body.timeout, 60);
  assert.equal(result.baseUrl, "https://docs.example.com");
  assert.equal(result.results[0].url, "https://docs.example.com/guide");
  assert.equal(result.results[0].rawContent, "# Guide\ncontent");
  assert.equal(result.results[0].favicon, "https://docs.example.com/fav.ico");
  assert.equal(result.usageCredits, 5);
  assert.equal(result.requestId, "req-123");
});

test("runTavilyResearch creates and bounded-polls the current research contract", async () => {
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === "POST") return new Response(JSON.stringify({ request_id: "research-1", created_at: "2026-07-31T00:00:00Z", status: "pending", input: "task", model: "mini", response_time: 0.1 }));
    return new Response(JSON.stringify({ request_id: "research-1", created_at: "2026-07-31T00:00:00Z", status: "completed", content: "Report [1]", sources: [{ title: "Primary", url: "https://example.com/primary" }], response_time: 1.2 }));
  };
  const result = await runTavilyResearch("key", {
    input: "task", model: "mini", citationFormat: "numbered", includeDomains: ["example.com"],
    excludeDomains: ["spam.example"], outputLength: "short", maxWaitMs: 100, pollIntervalMs: 1,
  }, context, mockFetch);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.tavily.com/research");
  assert.deepEqual(calls[0].body, { input: "task", model: "mini", citation_format: "numbered", include_domains: ["example.com"], exclude_domains: ["spam.example"], output_length: "short" });
  assert.equal(calls[1].url, "https://api.tavily.com/research/research-1");
  assert.equal(result.status, "completed");
  assert.equal(result.content, "Report [1]");
  assert.deepEqual(result.sources, [{ title: "Primary", url: "https://example.com/primary" }]);
});

test("tavilyCrawl rejects invalid bounds and root URLs before fetch", async () => {
  const ctx = { credential: "key", timeoutMs: 1000, persist() {} };
  let fetchCalled = false;
  const mockFetch = async () => { fetchCalled = true; return new Response("{}", { headers: { "content-type": "application/json" } }); };
  for (const controls of [
    { url: "https://example.com", limit: 10, maxDepth: 10 },
    { url: "https://example.com", limit: 0 },
    { url: "ftp://example.com", limit: 10 },
  ]) await assert.rejects(tavilyCrawl("key", controls, ctx, mockFetch), /maxDepth|limit|HTTP\(S\)/);
  assert.equal(fetchCalled, false, "fetch must not be called after invalid input");
});

// --- Cancellation and failure ---

test("tavilySearch rejects pre-aborted signal without calling the SDK", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const ctx = { ...context, signal: controller.signal };
  await assert.rejects(
    tavilySearch("key", "query", { maxResults: 5 }, ctx, () => { called = true; return { search: async () => ({}) }; }),
    /aborted/i,
  );
  assert.equal(called, false, "SDK search must not be called after pre-abort");
});

test("tavilySearch checks signal after SDK call completes", async () => {
  const controller = new AbortController();
  const ctx = { ...context, signal: controller.signal };
  const mockClient = {
    search: async () => {
      controller.abort();
      return { query: "q", responseTime: 0.1, images: [], results: [{ title: "t", url: "u", content: "c", score: 1, publishedDate: "d" }] };
    },
  };
  await assert.rejects(
    tavilySearch("key", "query", { maxResults: 5 }, ctx, () => mockClient),
    /aborted/i,
  );
});

test("tavilyMap maps the local HTTP deadline to timeout", async () => {
  const ctx = { credential: "key", timeoutMs: 5, persist() {} };
  const mockFetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
  });
  await assert.rejects(
    tavilyMap("key", { url: "https://example.com" }, ctx, mockFetch),
    (error) => { assert.equal(error.failureClass, "timeout"); return true; },
  );
});

test("tavilyMap classifies HTTP failure status", async () => {
  const ctx = { credential: "key", timeoutMs: 1000, persist() {} };
  const mockFetch = async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } });
  await assert.rejects(
    tavilyMap("key", { url: "https://example.com" }, ctx, mockFetch),
    (err) => { assert.equal(err.failureClass, "rate_limited"); assert.equal(err.retryAfterMs, 30000); return true; },
  );
});

// --- Focused usage operation (GET /usage; internal maintenance, not a tool) ---

const usageContext = { credential: "secret-tavily-test-key", timeoutMs: 1000, persist() {} };

test("tavilyGetUsage sends an authenticated GET /usage and normalizes documented fields, ignoring additive ones", async () => {
  let capturedUrl;
  let capturedInit;
  const body = {
    key: { usage: 42, limit: null, search_usage: 40, extract_usage: 2, bogus_field: "ignored" },
    account: { current_plan: "free", plan_usage: 42, plan_limit: 1000, extra: 1 },
    something_new: { whatever: true },
  };
  const mockFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const result = await tavilyGetUsage("secret-tavily-test-key", usageContext, mockFetch);
  assert.equal(capturedUrl, "https://api.tavily.com/usage");
  assert.equal(capturedInit.method, "GET");
  assert.equal(capturedInit.headers.Authorization, "Bearer secret-tavily-test-key");
  assert.equal(result.key.usage, 42);
  assert.equal(result.key.limit, null);
  assert.equal(result.key.searchUsage, 40);
  assert.equal(result.key.extractUsage, 2);
  assert.equal(result.key.bogusField, undefined);
  assert.equal(result.account.currentPlan, "free");
  assert.equal(result.account.planUsage, 42);
  assert.equal(result.account.planLimit, 1000);
});

test("tavilyGetUsage treats malformed or unrecognized bodies as provider-contract unavailable and a body-read abort as timeout", async () => {
  for (const raw of ["<html>not json</html>", "[]", "\"str\"", "{\"unrelated\":1}"]) {
    const mockFetch = async () => new Response(raw, { status: 200 });
    await assert.rejects(
      tavilyGetUsage("k", usageContext, mockFetch),
      (error) => { assert.equal(error.failureClass, "unavailable"); return true; },
    );
  }
  // Headers arrive immediately; the body stream only errors once the deadline fires, so the failure
  // happens during body consumption (response.text) and is classified timeout, not empty.
  const bodyAbort = async (_url, init) => {
    const body = new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    });
    return new Response(body, { status: 200 });
  };
  await assert.rejects(
    tavilyGetUsage("k", { credential: "k", timeoutMs: 5, persist() {} }, bodyAbort),
    (error) => { assert.equal(error.failureClass, "timeout"); return true; },
  );
});

test("tavilyGetUsage classifies HTTP failures and redacts a credential echoed by a transport error", async () => {
  const hanging = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
  });
  await assert.rejects(
    tavilyGetUsage("k", { credential: "k", timeoutMs: 5, persist() {} }, hanging),
    (error) => { assert.equal(error.failureClass, "timeout"); return true; },
  );
  const unauthorized = async () => new Response("{}", { status: 401 });
  await assert.rejects(
    tavilyGetUsage("k", usageContext, unauthorized),
    (error) => { assert.equal(error.failureClass, "auth"); return true; },
  );
  const secret = "secret-tavily-test-key";
  const echoing = async () => { throw new Error(`connect failed for ${secret}`); };
  let captured;
  try { await tavilyGetUsage(secret, usageContext, echoing); } catch (error) { captured = error; }
  assert.ok(captured, "expected a thrown error");
  assert.doesNotMatch(captured.message, new RegExp(secret));
  assert.match(captured.message, /\[redacted\]/);
});
