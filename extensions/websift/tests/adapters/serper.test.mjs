// Decision protected: Serper locale/request mapping, lead-only evidence, billable-call guards, cancellation, and credential redaction remain deterministic.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSerperAdapter, normalizeSerper, serperOperation, serperSearch } from "../../src/adapters/serper.ts";

const fixture = JSON.parse(await readFile(new URL("../fixtures/serper/search.json", import.meta.url), "utf8"));
const ctx = { credential: "secret", timeoutMs: 1000, persist() {} };

// Captures the parsed request body and returns a queued response (default: the grounded fixture).
function capture(response) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) }); return response ?? new Response(JSON.stringify(fixture)); };
  impl.calls = calls;
  return impl;
}

// Proof 3 (fixture): grounded organic normalization shape is unchanged.
test("normalizes the grounded Serper response shape", () => {
  assert.deepEqual(normalizeSerper(fixture, 10), [{ title: "Pi coding agent", url: "https://example.com/pi", snippet: "A coding agent.", publishedAt: "2026-07-27", sourceType: "organic" }]);
});

test("a valid zero-organic response is a successful empty search outcome", async () => {
  assert.deepEqual(normalizeSerper({ organic: [] }, 10), []);
  const full = await serperSearch({ query: "no indexed match" }, ctx, capture(new Response(JSON.stringify({ organic: [], credits: 1 }))));
  assert.deepEqual(full.results, []);
  assert.deepEqual(full.effective, { query: "no indexed match", num: 10 });
  assert.equal(full.credits, 1);
});

// Proof 1: exact request mapping with trimming and locale normalization (country->gl, language->hl).
test("maps trimmed query, integer num, country->gl, language->hl and warns on locale rewrite", async () => {
  const fetchImpl = capture();
  const full = await serperSearch({ query: "  pi coding agent  ", count: 5, country: "US", language: "EN" }, ctx, fetchImpl);
  assert.equal(fetchImpl.calls[0].url, "https://google.serper.dev/search");
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.equal(fetchImpl.calls[0].headers["X-API-KEY"], "secret");
  assert.deepEqual(fetchImpl.calls[0].body, { q: "pi coding agent", num: 5, gl: "us", hl: "en" });
  assert.deepEqual(full.effective, { query: "pi coding agent", num: 5, country: "us", language: "en" });
  assert.ok(full.warnings.some((warning) => /country normalized "US" -> "us"/.test(warning)));
  assert.ok(full.warnings.some((warning) => /language normalized "EN" -> "en"/.test(warning)));
});

// Proof 1: omitted locale fields are absent from the body; num defaults to 10.
test("omits gl/hl from the body when locale controls are absent and defaults num to 10", async () => {
  const fetchImpl = capture();
  await serperSearch({ query: "q" }, ctx, fetchImpl);
  assert.deepEqual(fetchImpl.calls[0].body, { q: "q", num: 10 });
});

// Strict count: the focused operation always sends an integer num in the grounded 1-10 range.
test("clamps num to the grounded 1-10 range and warns when the requested count exceeds it", async () => {
  const over = capture();
  const fullOver = await serperSearch({ query: "q", count: 50 }, ctx, over);
  assert.equal(over.calls[0].body.num, 10);
  assert.ok(fullOver.warnings.some((warning) => /grounded maximum is 10/.test(warning)));
  const nonFinite = capture();
  await serperSearch({ query: "q", count: Number.NaN }, ctx, nonFinite);
  assert.equal(nonFinite.calls[0].body.num, 10);
});

// Proof 1/2: blank query and blank-when-supplied locale are rejected before any network call.
test("rejects a blank query and blank-when-supplied locale before network", async () => {
  for (const controls of [{ query: "   " }, { query: "q", country: "  " }, { query: "q", language: "" }]) {
    const fetchImpl = capture();
    await assert.rejects(() => serperSearch(controls, ctx, fetchImpl), { failureClass: "invalid_input" });
    assert.equal(fetchImpl.calls.length, 0);
  }
});

// Proof 1: a malformed locale code is rejected before network.
test("rejects a malformed locale code before network", async () => {
  const fetchImpl = capture();
  await assert.rejects(() => serperSearch({ query: "q", country: "not a code!" }, ctx, fetchImpl), { failureClass: "invalid_input" });
  assert.equal(fetchImpl.calls.length, 0);
});

// Proof 3: organic normalization enforces strict count, skips malformed siblings while valid remain,
// and preserves bounded answerBox/knowledgeGraph candidates with a lead-only presence warning.
test("normalizes organic leads, enforces strict count, and preserves bounded candidates", async () => {
  const response = new Response(JSON.stringify({
    organic: [
      { title: "A", link: "https://a.example", snippet: "aa", date: "2026-01-01" },
      { noLink: true },
      { title: "B", link: "https://b.example", snippet: "bb" },
      { title: "C", link: "https://c.example" },
    ],
    answerBox: { answer: "42", title: "Meaning" },
    knowledgeGraph: { title: "KG", description: "graph" },
  }));
  const full = await serperSearch({ query: "q", count: 3 }, ctx, capture(response));
  assert.equal(full.results.length, 2); // malformed sibling skipped; never exceeds effective num
  assert.deepEqual(full.results[0], { title: "A", url: "https://a.example", snippet: "aa", publishedAt: "2026-01-01", sourceType: "organic" });
  assert.deepEqual(full.results[1], { title: "B", url: "https://b.example", snippet: "bb", publishedAt: undefined, sourceType: "organic" });
  assert.deepEqual(full.answerBox, { answer: "42", title: "Meaning" });
  assert.deepEqual(full.knowledgeGraph, { title: "KG", description: "graph" });
  assert.ok(full.warnings.some((warning) => /answerBox candidate present/.test(warning)));
  assert.ok(full.warnings.some((warning) => /knowledgeGraph candidate present/.test(warning)));
  assert.equal(full.credits, undefined);
});

test("current specialist Serper endpoints remain callable through one focused internal boundary", async () => {
  const cases = [
    [{ endpoint: "images", query: "diagram", count: 100, country: "US" }, "https://google.serper.dev/images", { images: [], credits: 2 }, { q: "diagram", num: 100, gl: "us" }],
    [{ endpoint: "maps", query: "OpenAI" }, "https://google.serper.dev/maps", { places: [], credits: 3 }, { q: "OpenAI" }],
    [{ endpoint: "reviews", cid: "123" }, "https://google.serper.dev/reviews", { reviews: [], credits: 1 }, { cid: "123" }],
    [{ endpoint: "lens", url: "https://example.com/image.png" }, "https://google.serper.dev/lens", { organic: [], credits: 3 }, { url: "https://example.com/image.png" }],
    [{ endpoint: "webpage", url: "https://example.com", includeMarkdown: true }, "https://scrape.serper.dev", { text: "page", markdown: "# page", credits: 2 }, { url: "https://example.com", includeMarkdown: true }],
  ];
  for (const [controls, expectedUrl, response, expectedBody] of cases) {
    const fetchImpl = capture(new Response(JSON.stringify(response)));
    const result = await serperOperation(controls, ctx, fetchImpl);
    assert.equal(fetchImpl.calls[0].url, expectedUrl);
    assert.deepEqual(fetchImpl.calls[0].body, expectedBody);
    assert.equal(result.credits, response.credits);
  }
});

test("specialist Serper endpoints reject unsafe or unsupported controls before network", async () => {
  for (const controls of [
    { endpoint: "images", query: "q", count: 5 },
    { endpoint: "maps" },
    { endpoint: "reviews" },
    { endpoint: "lens", url: "file:///tmp/image.png" },
    { endpoint: "webpage", url: "javascript:alert(1)" },
  ]) {
    const fetchImpl = capture();
    await assert.rejects(() => serperOperation(controls, ctx, fetchImpl), { failureClass: "invalid_input" });
    assert.equal(fetchImpl.calls.length, 0);
  }
});

// Proof 3: malformed root/organic/JSON shapes are provider-contract failures, never search zeros.
test("classifies malformed root, organic, or JSON shapes as provider-contract unavailable", async () => {
  await assert.rejects(() => serperSearch({ query: "q" }, ctx, capture(new Response("not json"))), (error) => error.failureClass === "unavailable" && /not valid JSON/.test(error.message));
  await assert.rejects(() => serperSearch({ query: "q" }, ctx, capture(new Response(JSON.stringify({ noOrganic: true })))), { failureClass: "unavailable" });
  await assert.rejects(() => serperSearch({ query: "q" }, ctx, capture(new Response(JSON.stringify({ organic: [{ noLink: true }] })))), { failureClass: "unavailable" });
});

// Candidate-only responses are successful zero-organic outcomes. Candidates stay bounded and
// lead-only; they never become a fabricated URL-bearing web source.
test("preserves candidate-only metadata without fabricating a web source", async () => {
  const response = new Response(JSON.stringify({ organic: [], answerBox: { answer: "42" }, knowledgeGraph: { title: "KG" } }));
  const full = await serperSearch({ query: "q" }, ctx, capture(response));
  assert.deepEqual(full.results, []);
  assert.deepEqual(full.answerBox, { answer: "42" });
  assert.deepEqual(full.knowledgeGraph, { title: "KG" });
  const adapter = createSerperAdapter(capture(new Response(JSON.stringify({ organic: [], answerBox: { answer: "42" } }))));
  const rows = await adapter.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10 }, ctx);
  assert.equal(rows.length, 0);
  assert.deepEqual(rows.serper.answerBox, { answer: "42" });
});

// Proof 4: a pre-aborted caller performs zero provider calls.
test("rejects a pre-aborted caller before any provider call", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = capture();
  await assert.rejects(() => serperSearch({ query: "q" }, { ...ctx, signal: controller.signal }, fetchImpl), { failureClass: "aborted" });
  assert.equal(fetchImpl.calls.length, 0);
});

// Proof 4: the local timeout stays active through response-body consumption.
test("local timeout covers response body consumption", async () => {
  const fetchImpl = async (_url, init) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(JSON.stringify(fixture)), 2000);
      init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
    }),
  });
  await assert.rejects(() => serperSearch({ query: "q" }, { ...ctx, timeoutMs: 30 }, fetchImpl), { failureClass: "timeout" });
});

// Proof 4: the credential is redacted from a transport error that contains it.
test("redacts the credential from a transport error that contains it", async () => {
  const credential = "serper-super-secret-key";
  const fetchImpl = async () => { throw new Error(`connect ECONNREFUSED with key ${credential}`); };
  let caught;
  try { await serperSearch({ query: "q" }, { ...ctx, credential }, fetchImpl); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.failureClass, "network");
  assert.doesNotMatch(caught.message, new RegExp(credential));
  assert.match(caught.message, /\[redacted\]/);
});

// Proof 4: HTTP auth/rate-limit/server classification (with Retry-After) remains correct.
test("classifies HTTP auth/rate-limit/server failures and preserves Retry-After", async () => {
  for (const [status, failureClass] of [[401, "auth"], [403, "auth"], [429, "rate_limited"], [500, "network"], [400, "invalid_input"]]) {
    await assert.rejects(() => serperSearch({ query: "q" }, ctx, capture(new Response("", { status }))), { failureClass });
  }
  await assert.rejects(
    () => serperSearch({ query: "q" }, ctx, capture(new Response("", { status: 429, headers: { "retry-after": "2" } }))),
    (error) => error.failureClass === "rate_limited" && error.retryAfterMs === 2000,
  );
});

// Bridge: the adapter attaches the namespaced envelope to the first result only.
test("adapter search attaches the namespaced envelope to the first result only", async () => {
  const response = new Response(JSON.stringify({
    organic: [{ title: "A", link: "https://a.example", snippet: "aa" }, { title: "B", link: "https://b.example", snippet: "bb" }],
    answerBox: { answer: "42" },
  }));
  const adapter = createSerperAdapter(capture(response));
  const results = await adapter.search({ operation: "search", query: "q", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 5, serper: { country: "us" } }, ctx);
  assert.equal(results.length, 2);
  assert.equal(results[0].serper.effective.num, 5);
  assert.equal(results[0].serper.effective.country, "us");
  assert.deepEqual(results[0].serper.answerBox, { answer: "42" });
  assert.ok(results[0].serper.warnings.some((warning) => /answerBox candidate present/.test(warning)));
  assert.equal(results[1].serper, undefined);
});

// Regression: existing cancellation behavior (mid-flight abort bills exactly one request).
test("cancellation aborts the only billable request", async () => {
  let calls = 0;
  const controller = new AbortController();
  const adapter = createSerperAdapter((_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  });
  const promise = adapter.search({ operation: "search", query: "pi", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10 }, { credential: "present", signal: controller.signal, timeoutMs: 1000, persist() {} });
  controller.abort();
  await assert.rejects(promise, (error) => error.failureClass === "aborted");
  assert.equal(calls, 1);
});
