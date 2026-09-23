// Decision protected: provider selection and fallback honor accepted host policy, failure taxonomy, eligibility, and no-hidden-call boundaries.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { ProviderError } from "../src/failures.ts";
import { AdapterRegistry } from "../src/registry.ts";
import { resetRoutingState, runWithFallback, selectProviders } from "../src/routing.ts";

const intent = { operation: "search", query: "pi", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10 };
const config = structuredClone(DEFAULT_CONFIG);
config.providers = { first: { enabled: true, apiKey: "present" }, second: { enabled: true, apiKey: "present" } };
config.priority.search = ["first", "second"];

function fake(id, behavior) {
  return { capability: { id, operations: ["search"], credentials: ["TEST_KEY"], strengths: ["general"], returns: ["leads"], timeoutMs: 1000, concurrency: 1, fallbackEligible: true, provenance: "test" }, search: behavior };
}

function context() { return { timeoutMs: 1000, persist() {} }; }

function fetchFake(id, behavior) {
  return { capability: { id, operations: ["fetch"], credentials: id === "tavily" ? ["TAVILY_API_KEY"] : [], strengths: ["page"], modes: ["page"], returns: ["content"], timeoutMs: 1000, concurrency: 1, fallbackEligible: true, provenance: "test" }, fetch: behavior };
}

test("fetch routing applies accepted host evidence and preserves bounded webclaw recovery", async () => {
  resetRoutingState();
  const fetchConfig = structuredClone(DEFAULT_CONFIG);
  fetchConfig.providers.tavily = { enabled: true, apiKey: "present" };
  const calls = [];
  let nativeFailure;
  const registry = new AdapterRegistry([
    fetchFake("webclaw", async (request) => {
      calls.push(`webclaw:${request.url}`);
      if (nativeFailure) throw new ProviderError(nativeFailure, nativeFailure);
      return [{ url: request.url, title: "webclaw", content: "webclaw" }];
    }),
    fetchFake("tavily", async (request) => {
      calls.push(`tavily:${request.url}`);
      return [{ url: request.url, title: "tavily", content: "tavily" }];
    }),
  ]);

  const tavilyPreferredUrls = [
    "https://openai.com/news/example", "https://openai.com/index/example", "https://anthropic.com/news/example", "https://huggingface.co/papers", "https://techcrunch.com/category/artificial-intelligence/", "https://linkedin.com/company/anthropicresearch/posts/", "https://juejin.cn/post/123", "https://36kr.com/", "https://yourstory.com/ai-story/example", "https://wsj.com/tech/ai/example", "https://arstechnica.com/ai/example", "https://github.com/trending", "https://bloomberg.com/technology", "https://bilibili.com/", "https://inc42.com/", "https://tech.economictimes.indiatimes.com/news/technology/example",
  ];
  for (const url of tavilyPreferredUrls)
    assert.deepEqual(selectProviders(registry, { operation: "fetch", mode: "page", url, extract: "readable" }, fetchConfig).map(({ capability }) => capability.id), ["tavily", "webclaw"], url);
  for (const url of ["https://openai.com/research/", "https://huggingface.co/datasets", "https://linkedin.com/company/anthropicresearch/about/", "https://github.com/org/repo", "https://bilibili.com/video/BV1"])
    assert.deepEqual(selectProviders(registry, { operation: "fetch", mode: "page", url, extract: "readable" }, fetchConfig).map(({ capability }) => capability.id), ["webclaw", "tavily"], url);

  const preferred = await runWithFallback(registry, { operation: "fetch", mode: "page", url: "https://openai.com/news/example", extract: "readable" }, fetchConfig, context());
  assert.equal(preferred.provider, "tavily");

  nativeFailure = "empty";
  const recoveredEmpty = await runWithFallback(registry, { operation: "fetch", mode: "page", url: "https://example.com/list", extract: "readable" }, fetchConfig, context());
  assert.deepEqual(recoveredEmpty.attempts.map(({ provider, failureClass }) => [provider, failureClass]), [["webclaw", "empty"], ["tavily", undefined]]);

  nativeFailure = "auth";
  await runWithFallback(registry, { operation: "fetch", mode: "page", url: "https://example.com/blocked", extract: "readable" }, fetchConfig, context());
  nativeFailure = undefined;
  const webclawStillEligible = await runWithFallback(registry, { operation: "fetch", mode: "page", url: "https://example.com/article", extract: "readable" }, fetchConfig, context());
  assert.equal(webclawStillEligible.provider, "webclaw");
  assert.deepEqual(calls.map((call) => call.split(":")[0]), ["tavily", "webclaw", "tavily", "webclaw", "tavily", "webclaw"]);
});

test("auth disables a provider for the session and falls back", async () => {
  resetRoutingState();
  const registry = new AdapterRegistry([fake("first", async () => { throw new ProviderError("auth", "bad key"); }), fake("second", async () => [{ title: "ok", url: "https://example.com", snippet: "ok" }])]);
  const result = await runWithFallback(registry, intent, config, context());
  assert.deepEqual(result.attempts.map(({ provider, failureClass }) => [provider, failureClass]), [["first", "auth"], ["second", undefined]]);
  assert.deepEqual(selectProviders(registry, intent, config).map((adapter) => adapter.capability.id), ["second"]);
});

for (const failureClass of ["invalid_input", "aborted", "policy"]) {
  test(`${failureClass} never falls back`, async () => {
    resetRoutingState();
    let secondCalls = 0;
    const registry = new AdapterRegistry([fake("first", async () => { throw new ProviderError(failureClass, "stop"); }), fake("second", async () => { secondCalls += 1; return []; })]);
    await assert.rejects(() => runWithFallback(registry, intent, config, context()), (error) => error.failureClass === failureClass);
    assert.equal(secondCalls, 0);
  });
}

test("structural empty falls back only for deep or compare", async () => {
  resetRoutingState();
  let secondCalls = 0;
  const registry = new AdapterRegistry([fake("first", async () => { throw new ProviderError("empty", "none"); }), fake("second", async () => { secondCalls += 1; return [{ title: "ok", url: "https://example.com", snippet: "" }]; })]);
  await assert.rejects(() => runWithFallback(registry, intent, config, context()), (error) => error.failureClass === "empty");
  assert.equal(secondCalls, 0);
  await runWithFallback(registry, { ...intent, depth: "deep" }, config, context());
  assert.equal(secondCalls, 1);
});

test("quota falls back and cools the dead lane down for the session", async () => {
  resetRoutingState();
  let firstCalls = 0;
  let secondCalls = 0;
  const registry = new AdapterRegistry([
    fake("first", async () => { firstCalls += 1; throw new ProviderError("quota", "not enough credits"); }),
    fake("second", async () => { secondCalls += 1; return [{ title: "ok", url: "https://example.com", snippet: "" }]; }),
  ]);
  const first = await runWithFallback(registry, intent, config, context());
  assert.deepEqual(first.attempts.map(({ provider, failureClass }) => [provider, failureClass]), [["first", "quota"], ["second", undefined]]);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
  // The cooled-down provider is skipped for the next call; only the funded lane runs.
  const second = await runWithFallback(registry, intent, config, context());
  assert.deepEqual(second.attempts.map(({ provider }) => provider), ["second"]);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 2);
});

test("a low nonzero yield is success, never fallback", async () => {
  resetRoutingState();
  let secondCalls = 0;
  const registry = new AdapterRegistry([fake("first", async () => [{ title: "one", url: "https://example.com", snippet: "" }]), fake("second", async () => { secondCalls += 1; return []; })]);
  const result = await runWithFallback(registry, { ...intent, depth: "deep" }, config, context());
  assert.equal(result.value.length, 1);
  assert.equal(secondCalls, 0);
});

test("forced fallback appends only eligible providers, not every registered one", async () => {
  resetRoutingState();
  const noCredConfig = structuredClone(DEFAULT_CONFIG);
  noCredConfig.providers = { first: { enabled: true, apiKey: "present" }, second: { enabled: true } };
  noCredConfig.priority.search = ["first", "second"];
  let secondCalls = 0;
  const registry = new AdapterRegistry([
    fake("first", async () => { throw new ProviderError("network", "down"); }),
    fake("second", async () => { secondCalls += 1; return [{ title: "ok", url: "https://example.com", snippet: "" }]; }),
  ]);
  await assert.rejects(
    () => runWithFallback(registry, { ...intent, provider: "first", fallbackOnExplicit: true }, noCredConfig, context()),
    (error) => error.attempts.length === 1 && error.attempts[0].provider === "first",
  );
  assert.equal(secondCalls, 0);
});
