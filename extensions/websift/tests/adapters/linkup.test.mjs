// Decision protected: Linkup request modes, local billable-call guards, evidence mapping, cancellation, and credential redaction remain deterministic.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createLinkupAdapter, normalizeLinkupSearch } from "../../src/adapters/linkup.ts";
const fixture = JSON.parse(await readFile(new URL("../fixtures/linkup/search.json", import.meta.url), "utf8"));
test("normalizes Linkup HTTP search results", () => assert.deepEqual(normalizeLinkupSearch(fixture), [{ title: "Linkup result", url: "https://example.com/linkup", snippet: "source passage", sourceType: "organic" }]));
test("normalizeLinkupSearch returns a scoped zero for a valid empty list and unavailable for all-malformed rows", () => {
  assert.deepEqual(normalizeLinkupSearch({ results: [] }), []);
  assert.throws(() => normalizeLinkupSearch({ results: [{ name: "x" }] }), { failureClass: "unavailable" });
  assert.throws(() => normalizeLinkupSearch({ results: [null] }), { failureClass: "unavailable" });
});
test("maps Linkup sourced-answer controls and retains provider-citation evidence", async () => {
  let captured;
  const nativeResult = { answer: "answer", sources: [{ name: "Source", url: "https://example.com", snippet: "lead" }] };
  const adapter = createLinkupAdapter(async (_url, options) => { captured = JSON.parse(options.body); return new Response(JSON.stringify(nativeResult)); });
  const result = await adapter.answer({ operation: "answer", question: "q", mode: "answer", linkup: { depth: "deep", fromDate: "2026-07-01", toDate: "2026-07-31", includeDomains: ["example.com"], excludeDomains: ["spam.example"], includeInlineCitations: false } }, { credential: "secret", timeoutMs: 1000, persist() {} });
  assert.deepEqual(captured, { q: "q", depth: "deep", outputType: "sourcedAnswer", includeDomains: ["example.com"], excludeDomains: ["spam.example"], fromDate: "2026-07-01", toDate: "2026-07-31", includeInlineCitations: false });
  assert.equal(result.sources[0].fetched, false);
  assert.equal(result.sources[0].evidenceStatus, "provider-citation");
  assert.deepEqual(result.nativeResult, nativeResult);
  assert.throws(() => normalizeLinkupSourcedAnswer({ answer: "answer", sources: [null] }), { failureClass: "unavailable" });
});

// --- Phase 5A: Linkup focused functions (internal operations) ---

import { linkupSearch, linkupSourcedAnswer, linkupStructuredSearch, linkupFetch, linkupGetBalance, runLinkupResearch, normalizeLinkupSourcedAnswer, normalizeLinkupFetch } from "../../src/adapters/linkup.ts";

const ctx = { credential: "test-key", timeoutMs: 1000, persist() {} };

test("linkupSearch sends correct request body and normalizes complete response", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ results: [{ name: "Result", url: "https://example.com", content: "snippet" }] }));
  };
  const response = await linkupSearch({ query: "test query", depth: "deep", maxResults: 5, includeDomains: ["example.com"], excludeDomains: ["spam.example"], fromDate: "2026-07-01", toDate: "2026-07-31", includeImages: true }, ctx, fetchImpl);
  assert.equal(captured.url, "https://api.linkup.so/v1/search");
  assert.deepEqual(captured.body, { q: "test query", depth: "deep", outputType: "searchResults", maxResults: 5, includeDomains: ["example.com"], excludeDomains: ["spam.example"], fromDate: "2026-07-01", toDate: "2026-07-31", includeImages: true });
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].name, "Result");
});

test("linkupSourcedAnswer maps depth and normalizes provider-citation sources", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ answer: "The answer", sources: [{ name: "Source 1", url: "https://example.com", snippet: "passage" }] }));
  };
  const response = await linkupSourcedAnswer({ query: "question", depth: "standard", includeInlineCitations: true }, ctx, fetchImpl);
  assert.equal(captured.outputType, "sourcedAnswer");
  assert.equal(captured.depth, "standard");
  assert.equal(captured.includeInlineCitations, true);
  const normalized = normalizeLinkupSourcedAnswer(response);
  assert.equal(normalized.answer, "The answer");
  assert.equal(normalized.sources.length, 1);
  assert.equal(normalized.sources[0].fetched, false);
  assert.equal(normalized.sources[0].evidenceStatus, "provider-citation");
  assert.equal(normalized.nativeResult, response);
});

test("Linkup structured search and Research keep non-public current contracts callable", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method, body });
    if (url.endsWith("/search")) return new Response(JSON.stringify({ data: { value: 1 }, sources: [] }));
    if (options.method === "POST") return new Response(JSON.stringify({ id: "research-1", status: "pending", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", input: { q: "q" }, output: null, error: null }));
    return new Response(JSON.stringify({ id: "research-1", status: "completed", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:01Z", input: { q: "q" }, output: { answer: "done", sources: [{ name: "Source", url: "https://example.com", snippet: "lead" }] }, error: null }));
  };
  const structured = await linkupStructuredSearch({ query: "q", depth: "standard", structuredOutputSchema: { type: "object", properties: { value: { type: "number" } } }, includeSources: true }, ctx, fetchImpl);
  assert.deepEqual(structured.data, { value: 1 });
  assert.equal(typeof calls[0].body.structuredOutputSchema, "string");
  const research = await runLinkupResearch({ query: "q", outputType: "sourcedAnswer", mode: "answer", reasoningDepth: "S", maxWaitMs: 2000, pollIntervalMs: 1 }, ctx, fetchImpl);
  assert.equal(research.status, "completed");
  assert.equal(research.output.answer, "done");
  assert.equal(calls[1].body.reasoningDepth, "S");
});

test("linkupFetch with renderJs:false requests static fetch and returns markdown", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ markdown: "# Heading\n\nContent", rawContent: "<html>raw</html>", contentType: "html", images: [{ alt: "diagram", url: "https://example.com/img.png" }] }));
  };
  const response = await linkupFetch({ url: "https://example.com", renderJs: false, includeRawContent: true, extractImages: true }, ctx, fetchImpl);
  assert.equal(captured.url, "https://example.com");
  assert.equal(captured.renderJs, false);
  assert.equal(response.markdown, "# Heading\n\nContent");
  assert.equal(captured.includeRawContent, true);
  assert.equal(captured.extractImages, true);
  assert.equal(response.rawContent, "<html>raw</html>");
  assert.equal(normalizeLinkupFetch("https://example.com", response, true)[0].content, "<html>raw</html>");
  const normalized = normalizeLinkupFetch("https://example.com", response);
  assert.equal(normalized[0].content, "# Heading\n\nContent");
  assert.equal(normalized[0].contentType, "text/markdown");
});

test("linkupFetch with renderJs:true requests JavaScript rendering", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ markdown: "rendered" }));
  };
  await linkupFetch({ url: "https://example.com", renderJs: true }, ctx, fetchImpl);
  assert.equal(captured.renderJs, true);
});

test("linkupGetBalance returns typed numeric balance", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, method: options.method };
    return new Response(JSON.stringify({ balance: 42.5 }));
  };
  const response = await linkupGetBalance(ctx, fetchImpl);
  assert.equal(captured.url, "https://api.linkup.so/v1/credits/balance");
  assert.equal(captured.method, "GET");
  assert.equal(response.balance, 42.5);
});

test("linkupSearch rejects empty query before fetch", async () => {
  const fetchImpl = async () => { throw new Error("should not be called"); };
  await assert.rejects(
    () => linkupSearch({ query: "", depth: "fast" }, ctx, fetchImpl),
    { failureClass: "invalid_input" },
  );
});

test("linkupSearch rejects invalid maxResults before fetch", async () => {
  const fetchImpl = async () => { throw new Error("should not be called"); };
  await assert.rejects(
    () => linkupSearch({ query: "test", depth: "fast", maxResults: 0 }, ctx, fetchImpl),
    { failureClass: "invalid_input" },
  );
});

test("Linkup rejects equal or reversed exact-date bounds before fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("should not be called"); };
  for (const controls of [
    { fromDate: "2026-07-29", toDate: "2026-07-29" },
    { fromDate: "2026-07-30", toDate: "2026-07-29" },
  ]) {
    await assert.rejects(
      () => linkupSourcedAnswer({ query: "test", depth: "standard", ...controls }, ctx, fetchImpl),
      (error) => {
        assert.equal(error.failureClass, "invalid_input");
        assert.match(error.message, /fromDate must be before toDate/);
        return true;
      },
    );
  }
  assert.equal(calls, 0);
});

test("Linkup focused operations reject invalid depth before fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("should not be called"); };
  await assert.rejects(() => linkupSearch({ query: "test", depth: "invalid" }, ctx, fetchImpl), { failureClass: "invalid_input" });
  await assert.rejects(() => linkupSourcedAnswer({ query: "test", depth: "invalid" }, ctx, fetchImpl), { failureClass: "invalid_input" });
  assert.equal(calls, 0);
});

test("linkupFetch rejects non-HTTP(S) URL before fetch", async () => {
  const fetchImpl = async () => { throw new Error("should not be called"); };
  await assert.rejects(
    () => linkupFetch({ url: "ftp://example.com", renderJs: false }, ctx, fetchImpl),
    { failureClass: "invalid_input" },
  );
});

test("linkupFetch rejects missing renderJs before fetch", async () => {
  const fetchImpl = async () => { throw new Error("should not be called"); };
  await assert.rejects(
    () => linkupFetch({ url: "https://example.com" }, ctx, fetchImpl),
    { failureClass: "invalid_input" },
  );
});

test("Linkup adapter maps caller abort through shared taxonomy", async () => {
  const controller = new AbortController();
  const fetchImpl = async () => {
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  };
  const adapter = createLinkupAdapter(fetchImpl);
  await assert.rejects(
    () => adapter.search({ operation: "search", query: "test", kind: "general", depth: "fast", strategy: "single", fallbackOnExplicit: false, count: 10 }, { ...ctx, signal: controller.signal }),
    { failureClass: "aborted" },
  );
});

test("Linkup rejects a pre-aborted caller before fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    () => linkupSearch({ query: "test", depth: "fast" }, { ...ctx, signal: controller.signal }, async () => { calls += 1; throw new Error("should not be called"); }),
    { failureClass: "aborted" },
  );
  assert.equal(calls, 0);
});

test("Linkup adapter enforces local timeout through shared taxonomy", async () => {
  const fetchImpl = (_url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({ results: [] }))), 2000);
    options.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    }, { once: true });
  });
  const adapter = createLinkupAdapter(fetchImpl);
  await assert.rejects(
    () => adapter.search({ operation: "search", query: "test", kind: "general", depth: "fast", strategy: "single", fallbackOnExplicit: false, count: 10 }, { ...ctx, timeoutMs: 100 }),
    { failureClass: "timeout" },
  );
});

test("Linkup adapter maps HTTP 429 to rate_limited", async () => {
  const fetchImpl = async () => new Response("", { status: 429 });
  const adapter = createLinkupAdapter(fetchImpl);
  await assert.rejects(
    () => adapter.search({ operation: "search", query: "test", kind: "general", depth: "fast", strategy: "single", fallbackOnExplicit: false, count: 10 }, ctx),
    { failureClass: "rate_limited" },
  );
});

test("Linkup adapter maps HTTP 500 to network failure", async () => {
  const fetchImpl = async () => new Response("", { status: 500 });
  const adapter = createLinkupAdapter(fetchImpl);
  await assert.rejects(
    () => adapter.search({ operation: "search", query: "test", kind: "general", depth: "fast", strategy: "single", fallbackOnExplicit: false, count: 10 }, ctx),
    { failureClass: "network" },
  );
});

test("linkupGetBalance classifies non-finite response values as provider-contract unavailable", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ balance: Infinity }), headers: new Headers() });
  await assert.rejects(() => linkupGetBalance(ctx, fetchImpl), { failureClass: "unavailable" });
});

test("Linkup credential never appears in errors or results", async () => {
  const secret = "super-secret-key-12345";
  const fetchImpl = async () => new Response(JSON.stringify({ results: [{ name: "test", url: "https://example.com", content: "data" }] }));
  const adapter = createLinkupAdapter(fetchImpl);
  const result = await adapter.search({ operation: "search", query: "test", kind: "general", depth: "fast", strategy: "single", fallbackOnExplicit: false, count: 10 }, { credential: secret, timeoutMs: 1000, persist() {} });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(secret));
});
