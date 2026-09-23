// Decision protected: SkillsMP catalog filters, bounds, evidence metadata, cancellation, and credential redaction remain deterministic.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSkillsMpAdapter, normalizeSkillsMp, skillsMpSearch } from "../../src/adapters/skillsmp.ts";

const ctx = { credential: "secret", timeoutMs: 1000, persist() {} };
const fixture = JSON.parse(await readFile(new URL("../fixtures/skillsmp/lookup.json", import.meta.url), "utf8"));
const ok = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers });
const oneSkill = () => ok({ skills: [{ name: "x" }] });
// Captures the requested URL and returns a queued response (default: one skill).
const capture = (response = oneSkill()) => { const calls = []; return { calls, fetchImpl: async (url) => { calls.push(new URL(url)); return response; } }; };
const params = (url) => Object.fromEntries(url.searchParams);

// Proof 6 (fixture): grounded record normalization with metadata only where present.
test("normalizes the SkillsMP catalog fixture", () => {
  assert.deepEqual(normalizeSkillsMp(fixture), [{ title: "Test skill", url: "https://github.com/example/skill", description: "Does a task", metadata: { stars: 42 } }]);
});

// Proof 6: record metadata preserves stars, category, occupation, and a stable identifier where present.
test("preserves stars, category, occupation, and a stable identifier where present", () => {
  const result = normalizeSkillsMp({ skills: [{ title: "Reviewer", githubUrl: "https://github.com/x/r", description: "reviews", stars: 7, category: "devops", occupation: "software-developers", id: "skill-123" }] });
  assert.deepEqual(result, [{ title: "Reviewer", url: "https://github.com/x/r", description: "reviews", metadata: { stars: 7, category: "devops", occupation: "software-developers", id: "skill-123" } }]);
});

// Proof 5: every supported response-list envelope normalizes through the same boundary.
test("normalizes every supported response-list envelope through one boundary", () => {
  const expected = [{ title: "S", url: undefined, description: undefined, metadata: {} }];
  for (const body of [
    { skills: [{ name: "S" }] },
    { results: [{ name: "S" }] },
    { items: [{ name: "S" }] },
    { data: [{ name: "S" }] },
    { data: { skills: [{ name: "S" }] } },
    [{ name: "S" }],
  ]) assert.deepEqual(normalizeSkillsMp(body), expected, JSON.stringify(body));
});

// Proof 7: malformed records are skipped only while valid siblings remain.
test("skips malformed records but keeps valid siblings", () => {
  const result = normalizeSkillsMp({ skills: [{ noTitle: true }, 42, { name: "Good", stars: 1 }] });
  assert.deepEqual(result, [{ title: "Good", url: undefined, description: undefined, metadata: { stars: 1 } }]);
});

// Proof 1: complete request mapping with trimming.
test("maps every grounded filter to exact trimmed query parameters", async () => {
  const { calls, fetchImpl } = capture();
  await skillsMpSearch({ query: " code review ", page: 3, limit: 50, sortBy: "recent", category: " devops ", occupation: " software-developers ", language: " en " }, ctx, fetchImpl);
  assert.equal(calls[0].origin + calls[0].pathname, "https://skillsmp.com/api/v1/skills/search");
  assert.deepEqual(params(calls[0]), { q: "code review", page: "3", limit: "50", sortBy: "recent", category: "devops", occupation: "software-developers", language: "en" });
});

// Proof 2: defaults page=1, limit=20, sortBy=stars; absent category/occupation are not sent.
test("defaults page=1, limit=20, sortBy=stars and omits absent filters", async () => {
  const { calls, fetchImpl } = capture();
  await skillsMpSearch({ query: "x" }, ctx, fetchImpl);
  assert.deepEqual(params(calls[0]), { q: "x", page: "1", limit: "20", sortBy: "stars" });
});

// Grounded sorting/category/occupation/language filters reach the exact query parameters.
test("sends recent sort and all catalog filters exactly", async () => {
  const { calls, fetchImpl } = capture();
  await skillsMpSearch({ query: "x", sortBy: "recent", category: "data-ai", occupation: "data-scientists", language: "mul" }, ctx, fetchImpl);
  assert.deepEqual(params(calls[0]), { q: "x", page: "1", limit: "20", sortBy: "recent", category: "data-ai", occupation: "data-scientists", language: "mul" });
});

// Proof 3: bounded integers before the request, and blank-input rejection before any network call.
test("clamps page/limit to bounded integers and rejects blank input before network", async () => {
  const clamped = capture();
  await skillsMpSearch({ query: "x", page: 0, limit: 500 }, ctx, clamped.fetchImpl);
  assert.deepEqual(params(clamped.calls[0]), { q: "x", page: "1", limit: "100", sortBy: "stars" });
  const nonFinite = capture();
  await skillsMpSearch({ query: "x", page: Number.NaN, limit: Number.POSITIVE_INFINITY }, ctx, nonFinite.fetchImpl);
  assert.deepEqual(params(nonFinite.calls[0]), { q: "x", page: "1", limit: "20", sortBy: "stars" });
  for (const controls of [{ query: "   " }, { query: "x", category: "  " }, { query: "x", occupation: "" }, { query: "x", language: " " }]) {
    const spy = capture();
    await assert.rejects(() => skillsMpSearch(controls, ctx, spy.fetchImpl), { failureClass: "invalid_input" });
    assert.equal(spy.calls.length, 0);
  }
});

// Proof 8 (adapter-level): grounded rate-limit headers parse into the focused full result once.
test("parses grounded rate-limit headers into the focused full result", async () => {
  const response = ok({ skills: [{ name: "x" }] }, { "x-ratelimit-daily-limit": "500", "x-ratelimit-daily-remaining": "499", "x-ratelimit-minute-limit": "30", "x-ratelimit-minute-remaining": "29", "x-ratelimit-bogus": "1" });
  const full = await skillsMpSearch({ query: "x" }, ctx, capture(response).fetchImpl);
  assert.deepEqual(full.rateLimits, { dailyLimit: 500, dailyRemaining: 499, minuteLimit: 30, minuteRemaining: 29 });
  assert.equal((await skillsMpSearch({ query: "x" }, ctx, capture().fetchImpl)).rateLimits, undefined);
});


// Proof 7: a provider-valid empty catalog is a scoped zero; malformed JSON, changed shapes, and
// all-malformed rows are provider-contract failures.
test("treats a valid empty catalog as a scoped zero and malformed responses as unavailable", async () => {
  const zero = await skillsMpSearch({ query: "x" }, ctx, capture(ok({ skills: [] })).fetchImpl);
  assert.deepEqual(zero.records, []);
  assert.deepEqual(zero.effective, { query: "x", page: 1, limit: 20, sortBy: "stars" });
  await assert.rejects(() => skillsMpSearch({ query: "x" }, ctx, capture(new Response("not json", { status: 200 })).fetchImpl), (error) => error.failureClass === "unavailable" && /not valid JSON/.test(error.message));
  await assert.rejects(() => skillsMpSearch({ query: "x" }, ctx, capture(new Response('"just a string"', { status: 200 })).fetchImpl), { failureClass: "unavailable" });
  await assert.rejects(() => skillsMpSearch({ query: "x" }, ctx, capture(ok({ skills: [{ noTitle: true }] })).fetchImpl), { failureClass: "unavailable" });
  await assert.rejects(() => skillsMpSearch({ query: "x" }, ctx, capture(ok({})).fetchImpl), { failureClass: "unavailable" });
});

// Proof 9: pre-abort, local timeout (headers and body consumption) through the shared taxonomy.
test("rejects a pre-aborted caller before fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  const spy = capture();
  await assert.rejects(() => skillsMpSearch({ query: "x" }, { ...ctx, signal: controller.signal }, spy.fetchImpl), { failureClass: "aborted" });
  assert.equal(spy.calls.length, 0);
});

test("enforces a local timeout through the shared taxonomy", async () => {
  const fetchImpl = (_url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(oneSkill()), 2000);
    options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("The operation was aborted", "AbortError")); }, { once: true });
  });
  await assert.rejects(() => skillsMpSearch({ query: "x" }, { ...ctx, timeoutMs: 30 }, fetchImpl), { failureClass: "timeout" });
});

test("timeout covers response body consumption, not only response headers", async () => {
  const fetchImpl = async (_url, options) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(JSON.stringify({ skills: [{ name: "x" }] })), 2000);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("The operation was aborted", "AbortError")); }, { once: true });
    }),
  });
  await assert.rejects(() => skillsMpSearch({ query: "x" }, { ...ctx, timeoutMs: 30 }, fetchImpl), { failureClass: "timeout" });
});

// Proof 10: HTTP auth/rate-limit/server classification with Retry-After preserved.
test("classifies HTTP auth/rate-limit/server failures and preserves Retry-After", async () => {
  for (const [status, failureClass] of [[401, "auth"], [403, "auth"], [429, "rate_limited"], [500, "network"], [400, "invalid_input"]]) {
    await assert.rejects(() => skillsMpSearch({ query: "x" }, ctx, async () => new Response("", { status })), { failureClass });
  }
  await assert.rejects(
    () => skillsMpSearch({ query: "x" }, ctx, async () => new Response("", { status: 429, headers: { "retry-after": "7" } })),
    (error) => error.failureClass === "rate_limited" && error.retryAfterMs === 7000,
  );
});

// Proof 11: credential redaction, including a transport error that contains the key.
test("redacts the credential from transport errors that contain it", async () => {
  const credential = "sk_live_super_secret_value";
  const fetchImpl = async () => { throw new Error(`fetch failed connecting with ${credential}`); };
  let caught;
  try { await skillsMpSearch({ query: "x" }, { ...ctx, credential }, fetchImpl); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.failureClass, "network");
  assert.doesNotMatch(caught.message, new RegExp(credential));
  assert.match(caught.message, /\[redacted\]/);
});

test("fails missing_credential before fetch when SKILLSMP_API_KEY is absent", async () => {
  const spy = capture();
  await assert.rejects(() => skillsMpSearch({ query: "x" }, { ...ctx, credential: undefined }, spy.fetchImpl), { failureClass: "missing_credential" });
  assert.equal(spy.calls.length, 0);
});

// Bridge: the adapter attaches the effective/rate-limit envelope to the first record only.
test("adapter lookup attaches the SkillsMP envelope to the first record only", async () => {
  const response = ok({ skills: [{ name: "a", stars: 1 }, { name: "b", stars: 2 }] }, { "x-ratelimit-daily-remaining": "5" });
  const adapter = createSkillsMpAdapter(capture(response).fetchImpl);
  const results = await adapter.lookup({ operation: "lookup", source: "skillsmp", query: "x", page: 1, language: "und", provider: "skillsmp" }, ctx);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0].metadata.skillsmp.rateLimits, { dailyRemaining: 5 });
  assert.deepEqual(results[0].metadata.skillsmp.effective, { query: "x", page: 1, limit: 20, sortBy: "stars", language: "und" });
  assert.equal(results[1].metadata.skillsmp, undefined);
});
test("adapter lookup carries the SkillsMP envelope on a valid zero catalog", async () => {
  const response = ok({ skills: [] }, { "x-ratelimit-daily-remaining": "9" });
  const adapter = createSkillsMpAdapter(capture(response).fetchImpl);
  const results = await adapter.lookup({ operation: "lookup", source: "skillsmp", query: "x", page: 1, provider: "skillsmp" }, ctx);
  assert.equal(results.length, 0);
  assert.deepEqual(results.skillsmp.rateLimits, { dailyRemaining: 9 });
  assert.deepEqual(results.skillsmp.effective, { query: "x", page: 1, limit: 20, sortBy: "stars" });
});
