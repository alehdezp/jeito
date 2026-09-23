// Decision protected: xAI handle/date bounds, request-cost metadata, no-winner evidence state, cancellation, and credential redaction remain deterministic.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createXSearchAdapter, isValidCalendarDate, normalizeXSearch, normalizeXSearchHandles, xSearchResponses,
} from "../../src/adapters/xsearch.ts";

const fixture = JSON.parse(await readFile(new URL("../fixtures/xsearch/search.json", import.meta.url), "utf8"));
const complete = JSON.parse(await readFile(new URL("../fixtures/xsearch/complete.json", import.meta.url), "utf8"));
const ctx = { credential: "secret", timeoutMs: 1000, persist() {} };

test("normalizes xAI citations into social leads", () => assert.deepEqual(normalizeXSearch(fixture), [{ title: "X source 1", url: "https://x.com/example/status/1", snippet: "Current X discussion", sourceType: "social" }]));

// Proof 1: complete request body with dates, handles, model, image/video flags.
test("xSearchResponses builds the complete x_search request body", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, method: options.method, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ citations: ["https://x.com/x/status/1"] }));
  };
  await xSearchResponses({
    query: "  grok launch  ", allowedHandles: ["@elonmusk", " xai "], fromDate: "2026-01-01", toDate: "2026-01-31",
    model: "grok-4.3", enableImageUnderstanding: true, enableVideoUnderstanding: true, maxTurns: 1, parallelToolCalls: false, maxOutputTokens: 2000,
  }, ctx, fetchImpl);
  assert.equal(captured.url, "https://api.x.ai/v1/responses");
  assert.equal(captured.method, "POST");
  assert.equal(captured.headers["User-Agent"], "jeito-websift/0.1.0 (@alehdezp/websift)");
  assert.match(captured.headers.Authorization, /^Bearer /);
  assert.equal(captured.body.model, "grok-4.3");
  assert.deepEqual(captured.body.input, [{ role: "user", content: "grok launch" }]);
  assert.equal(captured.body.max_turns, 1);
  assert.equal(captured.body.parallel_tool_calls, false);
  assert.equal(captured.body.max_output_tokens, 2000);
  assert.deepEqual(captured.body.tools, [{
    type: "x_search", allowed_x_handles: ["elonmusk", "xai"],
    from_date: "2026-01-01", to_date: "2026-01-31",
    enable_image_understanding: true, enable_video_understanding: true,
  }]);
});

test("xSearchResponses defaults to the grounded non-reasoning model and omits absent controls", async () => {
  let captured;
  const fetchImpl = async (_url, options) => { captured = JSON.parse(options.body); return new Response(JSON.stringify({ citations: ["https://x.com/x/status/1"] })); };
  await xSearchResponses({ query: "q" }, ctx, fetchImpl);
  assert.equal(captured.model, "grok-4-1-fast-non-reasoning");
  assert.deepEqual(captured, { model: "grok-4-1-fast-non-reasoning", input: [{ role: "user", content: "q" }], tools: [{ type: "x_search" }] });
});

// Proof 2: handle normalization, mutual exclusion, official max 20, and visible warning ownership.
test("normalizeXSearchHandles trims, strips leading @, discards empties, and warns for every rewrite", () => {
  const { handles, warnings } = normalizeXSearchHandles(["@elonmusk", "  xai  ", "@@", "  "], "allowedHandles");
  assert.deepEqual(handles, ["elonmusk", "xai"]);
  assert.equal(warnings.length, 4);
  assert.ok(warnings.every((warning) => warning.includes("allowedHandles")));
  assert.ok(warnings.some((warning) => warning.includes("discarded")));
});

test("normalizeXSearchHandles leaves already-clean handles unwarned", () => {
  const { handles, warnings } = normalizeXSearchHandles(["elonmusk", "xai"], "excludedHandles");
  assert.deepEqual(handles, ["elonmusk", "xai"]);
  assert.deepEqual(warnings, []);
});

test("normalizeXSearchHandles enforces the official max-20 bound", () => {
  const twentyOne = Array.from({ length: 21 }, (_, i) => `handle${i}`);
  assert.throws(() => normalizeXSearchHandles(twentyOne, "allowedHandles"), { failureClass: "invalid_input" });
});

test("xSearchResponses rejects allowed and excluded handles together before network", async () => {
  const fetchImpl = async () => { throw new Error("should not be called"); };
  await assert.rejects(
    () => xSearchResponses({ query: "q", allowedHandles: ["a"], excludedHandles: ["b"] }, ctx, fetchImpl),
    { failureClass: "invalid_input" },
  );
});

// Proof 3: calendar-valid dates and from/to ordering.
test("isValidCalendarDate accepts real dates and rejects shape and calendar violations", () => {
  assert.equal(isValidCalendarDate("2026-01-31"), true);
  assert.equal(isValidCalendarDate("2024-02-29"), true); // leap day
  assert.equal(isValidCalendarDate("2026-02-30"), false); // invalid calendar day
  assert.equal(isValidCalendarDate("2026-13-01"), false); // invalid month
  assert.equal(isValidCalendarDate("2026-1-1"), false); // wrong shape
  assert.equal(isValidCalendarDate("not-a-date"), false);
});

test("xSearchResponses rejects invalid calendar dates and reversed ranges before network", async () => {
  const fetchImpl = async () => { throw new Error("should not be called"); };
  await assert.rejects(() => xSearchResponses({ query: "q", fromDate: "2026-02-30" }, ctx, fetchImpl), { failureClass: "invalid_input" });
  await assert.rejects(() => xSearchResponses({ query: "q", fromDate: "2026-01-31", toDate: "2026-01-01" }, ctx, fetchImpl), { failureClass: "invalid_input" });
});

test("xSearchResponses rejects invalid request bounds before network", async () => {
  const fetchImpl = async () => { throw new Error("should not be called"); };
  await assert.rejects(() => xSearchResponses({ query: "q", maxTurns: 0 }, ctx, fetchImpl), { failureClass: "invalid_input" });
  await assert.rejects(() => xSearchResponses({ query: "q", maxOutputTokens: 0 }, ctx, fetchImpl), { failureClass: "invalid_input" });
});
// Proof 4: full response metadata preservation (text, citations, model, usage, tool-call counts).
test("xSearchResponses preserves synthesized text, citations, model, and usage metadata", async () => {
  const fetchImpl = async () => new Response(JSON.stringify(complete));
  const full = await xSearchResponses({ query: "q", model: "grok-4.3" }, ctx, fetchImpl);
  assert.equal(full.text, "Grok synthesized summary, part one.\n\nGrok synthesized summary, part two.");
  assert.deepEqual(full.citations, ["https://x.com/example/status/1", "https://x.com/example/status/2", "https://x.com/example/status/3", "https://x.com/example/status/4"]);
  assert.equal(full.model, "grok-4.3");
  assert.deepEqual(full.usage, { inputTokens: 100, outputTokens: 50, totalTokens: 150, xSearchCalls: 2, webSearchCalls: 1 });
});

// Proof 5: citation dedup/order and local count bound.
test("normalizeXSearch dedups citations, preserves first-seen order, and bounds by count", () => {
  const all = normalizeXSearch(complete);
  assert.deepEqual(all.map((result) => result.url), [
    "https://x.com/example/status/1", "https://x.com/example/status/2",
    "https://x.com/example/status/3", "https://x.com/example/status/4",
  ]);
  const bounded = normalizeXSearch(complete, 2);
  assert.equal(bounded.length, 2);
  assert.deepEqual(bounded.map((result) => result.url), ["https://x.com/example/status/1", "https://x.com/example/status/2"]);
});

test("adapter.search threads specialist controls and applies intent.count only to returned leads", async () => {
  let captured;
  const adapter = createXSearchAdapter(async (_url, options) => { captured = JSON.parse(options.body); return new Response(JSON.stringify(complete)); });
  const results = await adapter.search({ operation: "search", query: "q", kind: "social", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 2, recency: { from: "2026-07-01", to: "2026-07-31" }, xsearch: { allowedHandles: ["xai"], maxTurns: 2, maxOutputTokens: 800, parallelToolCalls: false, enableImageUnderstanding: true } }, ctx);
  assert.equal(results.length, 2);
  assert.deepEqual(captured.tools, [{ type: "x_search", allowed_x_handles: ["xai"], from_date: "2026-07-01", to_date: "2026-07-31", enable_image_understanding: true }]);
  assert.equal(captured.max_turns, 2);
  assert.equal(captured.max_output_tokens, 800);
  assert.equal(captured.parallel_tool_calls, false);
});

// Proof 6: synthesized text is a lead-only snippet, never fetched evidence; no fabricated post fields.
test("normalizeXSearch keeps synthesized text as a snippet and never fabricates post metadata", () => {
  for (const result of normalizeXSearch(complete)) {
    assert.equal(result.sourceType, "social");
    assert.equal(result.snippet, "Grok synthesized summary, part one.\n\nGrok synthesized summary, part two.");
    assert.match(result.title, /^X source \d+$/);
    for (const forbidden of ["publishedAt", "score", "author", "handle"]) assert.equal(result[forbidden], undefined);
  }
});

// Proof 7: pre-abort, local timeout, HTTP classes, malformed JSON/shape.
test("xSearchResponses rejects a pre-aborted caller before fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = async () => { throw new Error("should not be called"); };
  await assert.rejects(() => xSearchResponses({ query: "q" }, { ...ctx, signal: controller.signal }, fetchImpl), { failureClass: "aborted" });
});

test("xSearchResponses enforces a local timeout through the shared taxonomy", async () => {
  const fetchImpl = (_url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({ citations: ["https://x.com/x/status/1"] }))), 2000);
    options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("The operation was aborted", "AbortError")); }, { once: true });
  });
  await assert.rejects(() => xSearchResponses({ query: "q" }, { ...ctx, timeoutMs: 30 }, fetchImpl), { failureClass: "timeout" });
});

test("xSearchResponses classifies HTTP auth/rate-limit/server failures", async () => {
  for (const [status, failureClass] of [[401, "auth"], [429, "rate_limited"], [500, "network"]]) {
    const fetchImpl = async () => new Response("", { status });
    await assert.rejects(() => xSearchResponses({ query: "q" }, ctx, fetchImpl), { failureClass });
  }
});

test("xSearchResponses classifies malformed JSON and malformed shape as provider-contract unavailable", async () => {
  await assert.rejects(() => xSearchResponses({ query: "q" }, ctx, async () => new Response("{not json")), { failureClass: "unavailable" });
  await assert.rejects(() => xSearchResponses({ query: "q" }, ctx, async () => new Response(JSON.stringify({ output: "wrong", citations: ["https://x.com/x/status/1"] }))), { failureClass: "unavailable" });
  await assert.rejects(() => xSearchResponses({ query: "q" }, ctx, async () => new Response(JSON.stringify({ citations: "wrong" }))), { failureClass: "unavailable" });
  await assert.rejects(() => xSearchResponses({ query: "q" }, ctx, async () => new Response("{}")), { failureClass: "unavailable" });
});

test("xSearchResponses returns citation-free completion as a scoped zero preserving synthesis and work", async () => {
  const response = { output: [{ content: [{ text: "No matching posts in the requested window.", annotations: [] }] }], usage: { total_tokens: 123, server_side_tool_usage_details: { x_search_calls: 3 } } };
  const full = await xSearchResponses({ query: "q" }, ctx, async () => new Response(JSON.stringify(response)));
  assert.deepEqual(full.results, []);
  assert.deepEqual(full.citations, []);
  assert.equal(full.text, "No matching posts in the requested window.");
  assert.equal(full.usage.totalTokens, 123);
  assert.equal(full.usage.xSearchCalls, 3);
  // normalizeXSearch on the same provider-valid zero stays a successful empty lead set.
  assert.deepEqual(normalizeXSearch(response), []);
});
test("adapter.search returns a scoped zero with the xsearch envelope when no citations are returned", async () => {
  const adapter = createXSearchAdapter(async () => new Response(JSON.stringify({ output: [{ content: [{ text: "no matching posts", annotations: [] }] }], usage: { total_tokens: 50, server_side_tool_usage_details: { x_search_calls: 1 } } })));
  const results = await adapter.search({ operation: "search", query: "q", kind: "social", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10 }, ctx);
  assert.equal(results.length, 0);
  assert.equal(results.xsearch.usage.xSearchCalls, 1);
});

// Proof 8: credential redaction — the key never reaches error text or output.
test("xSearchResponses never exposes the credential in errors or output", async () => {
  const credential = "xai-super-secret-key";
  let output;
  try {
    await xSearchResponses({ query: "q" }, { ...ctx, credential }, async () => new Response(`unauthorized ${credential}`, { status: 401 }));
  } catch (error) {
    assert.doesNotMatch(JSON.stringify(error), new RegExp(credential));
  }
  output = await xSearchResponses({ query: "q" }, { ...ctx, credential }, async () => new Response(JSON.stringify({ citations: ["https://x.com/x/status/1"] })));
  assert.doesNotMatch(JSON.stringify(output), new RegExp(credential));
});

test("xSearchResponses redacts credentials embedded in transport errors", async () => {
  const credential = "xai-transport-secret";
  await assert.rejects(
    () => xSearchResponses({ query: "q" }, { ...ctx, credential }, async () => { throw new Error(`transport failed for ${credential}`); }),
    (error) => error.failureClass === "network" && !error.message.includes(credential) && error.message.includes("[redacted]"),
  );
});

test("xSearchResponses rejects an empty query and a missing credential before network", async () => {
  const fetchImpl = async () => { throw new Error("should not be called"); };
  await assert.rejects(() => xSearchResponses({ query: "   " }, ctx, fetchImpl), { failureClass: "invalid_input" });
  await assert.rejects(() => xSearchResponses({ query: "q" }, { timeoutMs: 1000, persist() {} }, fetchImpl), { failureClass: "missing_credential" });
});