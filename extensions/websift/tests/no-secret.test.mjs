// Decision protected: no adapter output or failure may expose a resolved provider credential.
import assert from "node:assert/strict";
import test from "node:test";
import { createContext7Adapter } from "../src/adapters/context7.ts";
import { createExaAdapter } from "../src/adapters/exa.ts";
import { createLinkupAdapter } from "../src/adapters/linkup.ts";
import { createPiPackagesAdapter } from "../src/adapters/pi-packages.ts";
import { createSerperAdapter } from "../src/adapters/serper.ts";
import { createSkillsMpAdapter } from "../src/adapters/skillsmp.ts";
import { createTavilyAdapter } from "../src/adapters/tavily.ts";
import { createXSearchAdapter } from "../src/adapters/xsearch.ts";

const secret = "shared-no-secret-gate-value";

test("adapter errors do not expose resolved credentials", async () => {
  const adapter = createSerperAdapter(async () => new Response("upstream body might contain diagnostics", { status: 500 }));
  let captured;
  try {
    await adapter.search({ operation: "search", query: "x", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10 }, { credential: secret, timeoutMs: 1000, persist() {} });
  } catch (error) {
    captured = error;
  }
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(secret));
});

test("Tavily adapter output excludes resolved credentials", async () => {
  const adapter = createTavilyAdapter(() => ({ extract: async () => ({ results: [{ url: "https://example.com", rawContent: "content" }], failedResults: [], responseTime: 0 }) }));
  const output = await adapter.fetch({ operation: "fetch", url: "https://example.com", mode: "page", extract: "readable" }, { credential: secret, timeoutMs: 1000, persist() {} });
  assert.doesNotMatch(JSON.stringify(output), new RegExp(secret));
});

test("Linkup fetch output excludes resolved credentials", async () => {
  const adapter = createLinkupAdapter(async () => new Response(JSON.stringify({ markdown: "# content" })));
  const output = await adapter.fetch({ operation: "fetch", url: "https://example.com", mode: "page", extract: "markdown", linkup: { renderJs: false } }, { credential: secret, timeoutMs: 1000, persist() {} });
  assert.doesNotMatch(JSON.stringify(output), new RegExp(secret));
});

test("remaining search adapter outputs exclude resolved credentials", async () => {
  const intent = { operation: "search", query: "x", kind: "general", depth: "standard", strategy: "single", fallbackOnExplicit: false, count: 10 };
  const context = { credential: secret, timeoutMs: 1000, persist() {} };
  const exa = createExaAdapter(() => ({ search: async () => ({ results: [{ title: "x", url: "https://example.com", highlights: ["x"] }] }) }));
  const linkup = createLinkupAdapter(async () => new Response(JSON.stringify({ results: [{ name: "x", url: "https://example.com", content: "x" }] })));
  const xsearch = createXSearchAdapter(async () => new Response(JSON.stringify({ citations: ["https://x.com/x/status/1"] })));
  for (const adapter of [exa, linkup, xsearch]) {
    const output = await adapter.search({ ...intent, kind: adapter.capability.id === "xsearch" ? "social" : "general" }, context);
    assert.doesNotMatch(JSON.stringify(output), new RegExp(secret));
  }
});

test("lookup adapter outputs exclude resolved credentials", async () => {
  const context = { credential: secret, timeoutMs: 1000, persist() {} };
  let contextCalls = 0;
  const context7 = createContext7Adapter(async () => ++contextCalls === 1 ? new Response(JSON.stringify({ results: [{ id: "/x/y", title: "x" }] })) : new Response("docs"));
  const skillsmp = createSkillsMpAdapter(async () => new Response(JSON.stringify({ skills: [{ name: "x" }] })));
  const packages = createPiPackagesAdapter(async () => new Response(JSON.stringify({ objects: [{ package: { name: "x" } }] })));
  const intents = [
    { operation: "lookup", source: "context7", query: "x", library: "x", page: 1, provider: "context7" },
    { operation: "lookup", source: "skillsmp", query: "x", page: 1, provider: "skillsmp" },
    { operation: "lookup", source: "pi-packages", query: "x", page: 1, provider: "pi-packages" },
  ];
  for (const [index, adapter] of [context7, skillsmp, packages].entries()) {
    const output = await adapter.lookup(intents[index], context);
    assert.doesNotMatch(JSON.stringify(output), new RegExp(secret));
  }
});

test("answer adapter outputs exclude resolved credentials", async () => {
  const context = { credential: secret, timeoutMs: 1000, persist() {} };
  const intent = { operation: "answer", question: "q", mode: "answer" };
  const exa = createExaAdapter(() => ({ answer: async () => ({ answer: "a", citations: [] }) }));
  const linkup = createLinkupAdapter(async () => new Response(JSON.stringify({ answer: "a", sources: [] })));
  for (const adapter of [exa, linkup]) {
    const output = await adapter.answer(intent, context);
    assert.doesNotMatch(JSON.stringify(output), new RegExp(secret));
  }
});
