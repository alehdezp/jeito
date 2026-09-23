// Decision protected: shared failure taxonomy preserves caller aborts, normalizes transport failures, and gives secret-safe recovery.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { classifyHttpFailure, mapFetchFailure, mayFallback, ProviderError, recoveryAdvice } from "../src/failures.ts";

test("shared fetch failure mapping distinguishes outer abort from timeout", () => {
  const outer = new AbortController();
  outer.abort();
  assert.equal(mapFetchFailure(new DOMException("aborted", "AbortError"), outer.signal).failureClass, "aborted");
  assert.equal(mapFetchFailure(new ProviderError("policy", "late policy"), outer.signal).failureClass, "aborted");
  assert.equal(mapFetchFailure(new DOMException("aborted", "AbortError")).failureClass, "timeout");
});

test("shared fetch failure mapping preserves typed failures and normalizes network errors", () => {
  const typed = new ProviderError("policy", "blocked");
  assert.equal(mapFetchFailure(typed), typed);
  const network = mapFetchFailure(new Error("offline"));
  assert.equal(network.failureClass, "network");
  assert.equal(network.message, "offline");
});

test("HTTP 404/410 are not-found source failures rather than schema errors", () => {
  assert.equal(classifyHttpFailure(404).failureClass, "not_found");
  assert.equal(classifyHttpFailure(410).failureClass, "not_found");
  assert.equal(classifyHttpFailure(422).failureClass, "invalid_input");
});

test("HTTP 4xx with credit/quota wording classifies as quota, not invalid_input", () => {
  const quota = classifyHttpFailure(400, null, '{"message":"Not enough credits","statusCode":400}');
  assert.equal(quota.failureClass, "quota");
  assert.match(quota.message, /Not enough credits/);
  assert.equal(classifyHttpFailure(400, null, "page not found").failureClass, "invalid_input");
  assert.equal(classifyHttpFailure(422, null, "invalid parameter").failureClass, "invalid_input");
  assert.equal(classifyHttpFailure(401, null, "not enough credits").failureClass, "auth");
  assert.equal(classifyHttpFailure(429, null, "quota exceeded").failureClass, "rate_limited");
});

test("quota is fallbackable with top-up recovery advice", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const advice = recoveryAdvice(new ProviderError("quota", "credits exhausted"), "serper", config);
  assert.equal(advice.retryable, false);
  assert.match(advice.action, /out of credits/);
  assert.match(advice.action, /serper/);
  assert.equal(mayFallback("quota", false), true);
});

test("quota carries Retry-After into the cooldown signal without promising a retry", () => {
  const quota = classifyHttpFailure(400, "120", '{"message":"Not enough credits"}');
  assert.equal(quota.failureClass, "quota");
  assert.equal(quota.retryAfterMs, 120_000);
  const config = structuredClone(DEFAULT_CONFIG);
  const advice = recoveryAdvice(quota, "serper", config);
  assert.doesNotMatch(advice.action, /Retry after|seconds/);
});

test("empty recovery is tool-aware and never names nonexistent knobs", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const search = recoveryAdvice(new ProviderError("empty", "empty"), "serper", config, "search");
  assert.match(search.action, /changed lexical constraint/);
  assert.doesNotMatch(search.action, /depth|strategy/);
  const answer = recoveryAdvice(new ProviderError("empty", "empty"), "exa", config, "answer");
  assert.match(answer.action, /Reformulate the question/);
});

test("fixed-count recovery is scoped to Serper search", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const error = new ProviderError("invalid_input", "count is not supported");
  assert.match(recoveryAdvice(error, "serper", config, "search").action, /fixed at 10/);
  assert.doesNotMatch(recoveryAdvice(error, "tavily", config, "search").action, /fixed at 10/);
  assert.doesNotMatch(recoveryAdvice(error, "serper", config, "fetch").action, /fixed at 10/);
});

test("fetch recovery is operation-aware", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const missing = recoveryAdvice(new ProviderError("not_found", "missing"), "native", config, "fetch");
  assert.equal(missing.retryable, false);
  assert.match(missing.action, /Verify the source URL/);
  const empty = recoveryAdvice(new ProviderError("empty", "empty"), "native", config, "fetch");
  assert.match(empty.action, /extraction mode|another source/);
  assert.doesNotMatch(empty.action, /strategy/);
});

test("failure recovery gives credential and retry guidance without secret values", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const missing = recoveryAdvice(new ProviderError("missing_credential", "missing"), "exa", config);
  assert.equal(missing.retryable, false);
  assert.match(missing.action, /EXA_API_KEY/);
  const limited = recoveryAdvice(new ProviderError("rate_limited", "limited", 2500), "exa", config);
  assert.equal(limited.retryable, true);
  assert.equal(limited.retryAfterMs, 2500);
  assert.match(limited.action, /3 seconds/);
});

test("recovery never promises hidden fallback on one-provider tools", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  for (const error of [new ProviderError("rate_limited", "limited"), new ProviderError("timeout", "slow"), new ProviderError("network", "offline")]) {
    const advice = recoveryAdvice(error, "exa", config, "search");
    assert.doesNotMatch(advice.action, /allow fallback|fallback remains bounded|another eligible provider/i);
  }
});

test("site-owned advice overrides the generic class action; classes without advice keep it", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const owned = recoveryAdvice(new ProviderError("policy", "webclaw 0.6.15 is below the supported floor", undefined, "Align the binary, then retry the same call."), "webclaw", config, "fetch");
  assert.equal(owned.retryable, false);
  assert.equal(owned.action, "Align the binary, then retry the same call.");
  const generic = recoveryAdvice(new ProviderError("policy", "Blocked private or internal destination: host"), "webclaw", config, "fetch");
  assert.match(generic.action, /Change the requested input/);
});