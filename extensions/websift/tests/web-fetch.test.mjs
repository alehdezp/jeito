// Schema v2 (grill rounds 1-6, 2026-08-07): one required parameter (urls), four optional
// (mode, objective, query_terms, wait); tolerance doctrine — every combination resolves
// with a transparent note, the only hard errors are empty calls and un-inferable modes.
// Content is always shown (full <= 5K, smart view beyond); query_terms adds ranked
// snippets with read ranges (5 single / 3 per source / 2 per crawled page); the LLM fires
// only on mode:"llm_answer" or the single-URL no-quality-match rescue. Crawl enforces
// local scope, dedupe, cap-before-cache, identical-job reuse, and shutdown abort.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeGeneric } from "@blackwell-systems/gcf";
import { ProviderError } from "../src/failures.ts";
import { __setDestinationLookupForTest } from "../src/destination-policy.ts";
import { AdapterRegistry } from "../src/registry.ts";
import { __setLlmAnswerGenerationForTest, registerWebFetch } from "../src/tools/web-fetch.ts";
import { Check } from "typebox/value";
import { __setLlmKeyForTest, __setWebclawSpawnForTest, __setWebclawVersionForTest, parseLlmOutput } from "../src/webclaw-spawn.ts";
import { crawlScope, createCrawlJobManager, createLlmAnswerJobManager, parseCrawlFormat } from "../src/crawl-jobs.ts";
import { cacheRoot, estimateTokens, smartView, writeCache } from "../src/fetch-cache.ts";
import { summaryPathFor, writeSummary } from "../src/summary-file.ts";

__setDestinationLookupForTest(async () => [{ address: "8.8.8.8", family: 4 }]);
__setWebclawVersionForTest(async () => "webclaw 0.6.16");
__setLlmAnswerGenerationForTest(false);
test.after(() => { __setDestinationLookupForTest(undefined); __setWebclawVersionForTest(undefined); });

function fetchAdapter(id = "webclaw", behavior = () => [{ url: "https://example.com/demo", title: "Demo", content: "# Demo\n\n## Alpha\n\nalpha text\n", contentType: "text/markdown" }]) {
  return {
    capability: { id, operations: ["fetch"], credentials: [], strengths: [id], returns: ["content"], timeoutMs: 1000, concurrency: 1, fallbackEligible: true, provenance: "test" },
    async fetch(intent) {
      const values = behavior(intent);
      if (values && typeof values.then === "function") return values;
      if (values && values.failureClass) throw new ProviderError(values.failureClass, values.message);
      return values;
    },
  };
}

function setup(adapters, cwd = process.cwd()) {
  const tools = [];
  const events = {};
  const pi = { registerTool(tool) { tools.push(tool); }, appendEntry() {}, on(event, handler) { events[event] = handler; } };
  registerWebFetch(pi, new AdapterRegistry(adapters));
  const ctx = { cwd, sessionManager: { getBranch: () => [] } };
  return { tool: tools[0], ctx, events };
}

function seedRetainedSummary(cwd, url, objective, queryTerms, answer = "EXACT_RETAINED_ANSWER") {
  const entry = writeCache({ canonicalUrl: url, sourceUrl: url, provider: "fixture", fetchMode: "page", extract: "llm", title: "Demo", body: "# Demo\n\ncurrent page bytes" }, cacheRoot(cwd));
  const summary = writeSummary(entry.path, { body: answer, model: "fixture-model", objective, queryTerms });
  return { entry, summary };
}
function decodeEmbeddedGcf(text) {
  const start = text.indexOf("GCF profile=generic");
  assert.ok(start >= 0, "expected embedded GCF output");
  return decodeGeneric(text.slice(start));
}

function llmPage(url, title, body, description) {
  return `> URL: ${url}\n> Title: ${title}${description ? `\n> Description: ${description}` : ""}\n\n${body}`;
}

test("smart view preserves complete navigation and spends the 2K budget on top-of-section excerpts", () => {
  const body = ["# Demo", ...Array.from({ length: 30 }, (_, index) => `## Section ${index + 1}\nFACT_${index + 1} ${"detail ".repeat(80)}\n### Child ${index + 1}\nCHILD_${index + 1} ${"context ".repeat(40)}`)].join("\n\n");
  const view = smartView({ title: "Demo", url: "https://example.com/demo", path: "/tmp/demo.md", status: "fresh", tokens: estimateTokens(body), body, bodyStartLine: 2 });
  assert.ok(Math.ceil(view.length / 4) <= 2_000);
  assert.match(view, /## Section 1/);
  assert.match(view, /FACT_1/);
  assert.match(view, /## Section 30/);
  assert.match(view, /### Child 30/);
  assert.doesNotMatch(view, /CHILD_30/, "the 2K budget spends on top-of-section excerpts, not deep content");
});

test("web_fetch exposes structured JSON pages as lossless GCF", async () => {
  const structured = { items: [{ id: 1, label: "one" }], meta: { current: true } };
  const adapter = fetchAdapter("webclaw", (intent) => [{ url: intent.url, title: "JSON API", content: JSON.stringify(structured), contentType: "application/json" }]);
  const { tool, ctx } = setup([adapter]);
  const result = await tool.execute("id", { urls: "https://example.com/data.json" }, undefined, undefined, ctx);
  assert.deepEqual(decodeGeneric(result.content[0].text).records[0].data, structured);
});

test("web_fetch attributes redirected evidence to the effective URL and keeps requested cache identity", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-redirect-attribution-"));
  const requested = "https://example.com/start";
  const effective = "https://cdn.example.com/final";
  const adapter = fetchAdapter("webclaw", () => [{ url: effective, title: "Final", content: "# Final\n\nredirected body", contentType: "text/markdown" }]);
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const result = await tool.execute("id", { urls: requested }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /Source: https:\/\/cdn\.example\.com\/final/);
    assert.match(result.content[0].text, /Requested: https:\/\/example\.com\/start/);
    assert.deepEqual(result.details.sources[0], { url: effective, requestedUrl: requested, title: "Final", passage: "# Final\n\nredirected body", fetched: true, evidenceStatus: "fetched", provider: "webclaw" });
    const cached = readFileSync(result.details.cache[0].path, "utf8");
    assert.match(cached, /source_url: https:\/\/cdn\.example\.com\/final/);
    assert.match(cached, /canonical_url: https:\/\/example\.com\/start/);
    const reused = await tool.execute("id-2", { urls: requested }, undefined, undefined, ctx);
    assert.match(reused.content[0].text, /Source: https:\/\/cdn\.example\.com\/final/);
    assert.match(reused.content[0].text, /Requested: https:\/\/example\.com\/start/);
    assert.equal(reused.details.sources[0].url, effective);
    assert.equal(reused.details.sources[0].requestedUrl, requested);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch map deduplicates and caps before writing the scoped cache", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-map-"));
  const spawnCalls = [];
  __setWebclawSpawnForTest(async (args) => {
    spawnCalls.push(args);
    const urls = [...Array.from({ length: 30 }, (_, index) => `https://example.com/docs/p-${index}`), "https://example.com/docs/p-0", "https://example.com/docs/deeper/child", "https://example.com/docs2/outside", "https://other.example/outside"].join("\n");
    return { ok: true, ms: 10, stdout: `${urls}\n`, stderr: "discovered URLs\n" };
  });
  try {
    const { tool, ctx } = setup([fetchAdapter("tavily", async () => { throw new ProviderError("network", "must not be called"); })], cwd);
    const result = await tool.execute("id", { urls: "https://example.com/docs/*", mode: "map" }, undefined, undefined, ctx);
    assert.equal(spawnCalls.length, 1);
    assert.ok(spawnCalls[0].includes("--map"));
    const output = decodeEmbeddedGcf(result.content[0].text);
    assert.equal(output.totalRecords, 25, "siteMapCap applies after dedupe and scope filtering");
    assert.ok(output.records.every((record) => /^https:\/\/example\.com\/docs\/p-\d+$/.test(record.url)));
    const cached = readFileSync(result.details.cache[0].path, "utf8");
    assert.equal((cached.match(/^https:\/\//gm) ?? []).length, 25, "only bounded rows are cached");
    assert.doesNotMatch(cached, /p-25|deeper\/child|docs2\/outside/);
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch map distinguishes literal prefixes, one-segment globs, recursive globs, and exclusions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-map-scope-"));
  const rows = ["https://example.com/docs", "https://example.com/docs/", "https://example.com/docs/a", "https://example.com/docs/a/b", "https://example.com/docs/private/x", "https://example.com/docs2/x", "https://example.com/docs/a", "https://other.example/docs/a"].join("\n");
  __setWebclawSpawnForTest(async () => ({ ok: true, ms: 5, stdout: `${rows}\n`, stderr: "" }));
  try {
    const { tool, ctx } = setup([fetchAdapter()], cwd);
    const call = async (urls) => tool.execute("id", { urls, mode: "map" }, undefined, undefined, ctx);
    const literal = await call("https://example.com/docs/");
    const one = await call("https://example.com/docs/*");
    const recursive = await call("https://example.com/docs/**");
    const excluded = await call("https://example.com/+[docs/**]-[docs/private/**]");
    assert.deepEqual(decodeEmbeddedGcf(literal.content[0].text).records.map((record) => record.url), ["https://example.com/docs", "https://example.com/docs/", "https://example.com/docs/a", "https://example.com/docs/a/b", "https://example.com/docs/private/x"]);
    assert.deepEqual(decodeEmbeddedGcf(one.content[0].text).records.map((record) => record.url), ["https://example.com/docs/", "https://example.com/docs/a"]);
    assert.deepEqual(decodeEmbeddedGcf(recursive.content[0].text).records.map((record) => record.url), ["https://example.com/docs/", "https://example.com/docs/a", "https://example.com/docs/a/b", "https://example.com/docs/private/x"]);
    assert.deepEqual(decodeEmbeddedGcf(excluded.content[0].text).records.map((record) => record.url), ["https://example.com/docs/", "https://example.com/docs/a", "https://example.com/docs/a/b"]);
    assert.equal(new Set([literal, one, recursive, excluded].map((result) => result.details.cache[0].path)).size, 4, "each requested scope has a separate cache identity");
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});


test("web_fetch map survives hostile spawn output without leaking TypeErrors", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-map-hostile-"));
  try {
    const undefinedStdout = async () => ({ ok: true, ms: 5, stdout: undefined, stderr: "ok" });
    __setWebclawSpawnForTest(undefinedStdout);
    const { tool, ctx } = setup([fetchAdapter()], cwd);
    const empty = await tool.execute("id", { urls: "https://example.com", mode: "map" }, undefined, undefined, ctx);
    assert.doesNotThrow(() => JSON.stringify(empty), "undefined stdout must not crash map");
    assert.match(empty.content[0].text, /Map returned no valid same-origin URLs inside the requested scope/, "clean scoped failure, not a TypeError");
    __setWebclawSpawnForTest(async () => ({ ok: true, ms: 5, stdout: "\u001b[2mWARN\u001b[0m page failed url=https://x/a depth=2 error=boom\nhttps://example.com/a\nhttps://example.com/b\n", stderr: "warns" }));
    const ansi = await tool.execute("id", { urls: "https://example.com", mode: "map" }, undefined, undefined, ctx);
    const decoded = decodeEmbeddedGcf(ansi.content[0].text);
    assert.equal(decoded.totalRecords, 2, "ANSI/junk rows are ignored; real URLs survive");
    assert.ok(decoded.records.every((record) => record.url.startsWith("https://example.com/")), "no junk rows leak into the map");
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch map keeps valid URLs when webclaw exits non-zero with partial stdout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-map-partial-"));
  __setWebclawSpawnForTest(async () => ({ ok: false, ms: 500, stdout: "https://example.com/a\nhttps://example.com/b\n", stderr: "Fetched 2 URLs (2 ok, 0 errors) in 0.3s\n", code: 1 }));
  try {
    const { tool, ctx } = setup([fetchAdapter()], cwd);
    const result = await tool.execute("id", { urls: "https://example.com", mode: "map" }, undefined, undefined, ctx);
    const decoded = decodeEmbeddedGcf(result.content[0].text);
    assert.equal(decoded.totalRecords, 2, "exit 1 with valid stdout must not discard the URLs");
    assert.match(result.content[0].text, /partial results shown/, "the partial nature is reported");
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch map with a live onUpdate emits progress without crashing and reports the cap", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-map-onupdate-"));
  __setWebclawSpawnForTest(async () => {
    const urls = [...Array.from({ length: 30 }, (_, index) => `https://example.com/docs/p-${index}`)].join("\n");
    return { ok: true, ms: 10, stdout: `${urls}\n`, stderr: "discovered 30 URLs\n" };
  });
  try {
    const { tool, ctx } = setup([fetchAdapter()], cwd);
    const updates = [];
    const result = await tool.execute("id", { urls: "https://example.com/docs/*", mode: "map" }, undefined, (update) => updates.push(update), ctx);
    assert.ok(updates.length >= 1, "progress updates are emitted with a live onUpdate");
    assert.match(result.content[0].text, /showing and caching 25 \(siteMapCap/, "cap truncation is reported, not silent");
    assert.equal(result.details.operation, "map", "details carry the mode that ran");
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("web_fetch routes map shorthand only when mode is omitted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-map-shorthand-"));
  const spawnCalls = [];
  __setWebclawSpawnForTest(async (args) => {
    spawnCalls.push(args);
    return { ok: true, ms: 10, stdout: ["https://example.com/docs/a", "https://example.com/docs/b", "https://other.example/x"].join("\n") + "\n", stderr: "" };
  });
  try {
    const { tool, ctx } = setup([fetchAdapter()], cwd);
    const shorthand = await tool.execute("id", { urls: "https://example.com/docs/*" }, undefined, undefined, ctx);
    assert.match(shorthand.content[0].text, /normalized to map/);
    assert.match(shorthand.content[0].text, /https:\/\/example\.com\/docs\/a/);
    assert.doesNotMatch(shorthand.content[0].text, /other\.example/);
    const explicitPage = await tool.execute("id", { urls: "https://example.com/docs/*", mode: "page" }, undefined, undefined, ctx);
    assert.match(explicitPage.content[0].text, /Alpha/);
    assert.equal(spawnCalls.length, 1, "explicit page mode never spawns a map");
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch smart-saves large pages, reuses cache, and always prints the cache path", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-"));
  let calls = 0;
  const body = Array.from({ length: 30 }, (_, index) => `## Section ${index}\n${`detail-${index} `.repeat(90)}`).join("\n") + "\nUNSEEN_FULL_TAIL";
  const adapter = fetchAdapter("webclaw", () => { calls++; return [{ url: "https://example.com/large", title: "Large page", content: body, contentType: "text/markdown" }]; });
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const first = await tool.execute("id", { urls: "https://example.com/large" }, undefined, undefined, ctx);
    assert.equal(calls, 1);
    assert.match(first.content[0].text, /## Section 0 \(cache line/, "pages over 5K get the smart view");
    assert.match(first.content[0].text, /fresh fetch/, "a new snapshot identifies its network origin");
    assert.doesNotMatch(first.content[0].text, /UNSEEN_FULL_TAIL/, "the tail is not in the smart view");
    const cachePath = first.details.cache[0].path;
    assert.ok(cachePath, "cache path is always printed");
    assert.equal(readFileSync(cachePath, "utf8").includes("UNSEEN_FULL_TAIL"), true, "the full body is on disk");
    const second = await tool.execute("id", { urls: "https://example.com/large" }, undefined, undefined, ctx);
    assert.equal(calls, 1, "exact cache hit");
    assert.match(second.content[0].text, /cache hit — download to refresh/);
    assert.match(second.content[0].text, /fetched \d{4}-\d{2}-\d{2}/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch query_terms on a small page returns the full page with focus markers and read ranges", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-"));
  const body = "# Demo\n\n## Alpha section\n\nalpha detail text\n\n## Beta section\n\nbeta detail text with UNIQUE_FACT\n";
  const adapter = fetchAdapter("webclaw", () => [{ url: "https://example.com/demo", title: "Demo", content: body, contentType: "text/markdown" }]);
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const result = await tool.execute("id", { urls: "https://example.com/demo", query_terms: "unique fact" }, undefined, undefined, ctx);
    assert.equal(result.details.failureClass, undefined);
    const text = result.content[0].text;
    assert.match(text, /Focus \(query "unique fact"\)/);
    const focusRange = /★ focus #1 — read lines (\d+)-(\d+)/.exec(text);
    assert.ok(focusRange, "focus marker carries a dereferenceable cache range");
    const cacheLines = readFileSync(result.details.cache[0].path, "utf8").split("\n");
    const focusedCacheText = cacheLines.slice(Number(focusRange[1]) - 1, Number(focusRange[2])).join("\n");
    assert.match(focusedCacheText, /UNIQUE_FACT/, "the printed range resolves to the labelled cached passage");
    assert.match(text, /UNIQUE_FACT/, "the full page content is still shown (ranking is an addition)");
    assert.match(text, /alpha detail text/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch query_terms on a page over 5K returns ranked snippets with ranges plus the smart view", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-"));
  const filler = "plain text without matches ".repeat(1400); // ~30K chars ≈ 7.6K tokens > 5K
  const body = `# Big\n\n## Token section\n\n${filler}\ntoken refresh detail here\n\n## Other section\n\n${filler}\n`;
  const adapter = fetchAdapter("webclaw", () => [{ url: "https://example.com/big", title: "Big", content: body, contentType: "text/markdown" }]);
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const result = await tool.execute("id", { urls: "https://example.com/big", query_terms: "token refresh" }, undefined, undefined, ctx);
    assert.equal(result.details.failureClass, undefined);
    const text = result.content[0].text;
    assert.match(text, /### Token section \(score \d+\.\d+ · read lines \d+-\d+\)/, "snippet block carries the read range");
    assert.match(text, /token refresh detail here/);
    assert.match(text, /## Other section \(cache line/, "the pi-nav smart view follows the ranking");
    assert.doesNotMatch(text, /★ focus/, "no full-page focus markers beyond 5K");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch query_terms returns a not-found note on small pages and never triggers the LLM", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-"));
  const adapter = fetchAdapter("webclaw", () => [{ url: "https://example.com/demo", title: "Demo", content: "# Demo\n\n## Alpha\n\nalpha beta gamma\n", contentType: "text/markdown" }]);
  let llmCalls = 0;
  __setWebclawSpawnForTest(async (args) => { llmCalls++; return { ok: true, ms: 10, stdout: "should not fire", stderr: "" }; });
  __setLlmKeyForTest("test-key");
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const result = await tool.execute("id", { urls: "https://example.com/demo", query_terms: "quantum entanglement" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /No section matched any query term/);
    assert.match(result.content[0].text, /Cache: /);
    assert.equal(llmCalls, 0, "the fallback fires only on pages over 5K");
  } finally {
    __setWebclawSpawnForTest(undefined);
    __setLlmKeyForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch single-URL no-quality-match rescue fires the LLM only on pages over 5K", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-"));
  const filler = "unrelated vocabulary ".repeat(1800); // ~39K chars ≈ 9.8K tokens > 5K
  const body = `# Big page\n\n${filler}\n`;
  const adapter = fetchAdapter("webclaw", () => [{ url: "https://example.com/big", title: "Big", content: body, contentType: "text/markdown" }]);
  __setLlmKeyForTest("test-key");
  let llmCalls = 0;
  __setWebclawSpawnForTest(async (args) => {
    if (!args.includes("--extract-prompt")) return { ok: true, ms: 10, stdout: "page", stderr: "" };
    llmCalls++;
    return { ok: true, ms: 10, stdout: "the page discusses token refresh in section X", stderr: "" };
  });
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const result = await tool.execute("id", { urls: "https://example.com/big", query_terms: "token refresh", objective: "Where are token refreshes explained?" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /No section matched any query term/, "the deterministic verdict stays first");
    assert.match(result.content[0].text, /LLM fallback read/);
    assert.match(result.content[0].text, /token refresh in section X/);
    assert.equal(llmCalls, 1);
  } finally {
    __setWebclawSpawnForTest(undefined);
    __setLlmKeyForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch multi-source query_terms orders by relevance and shows file handles for no-match sources", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-"));
  const adapter = fetchAdapter("webclaw", (intent) => {
    if (intent.url === "https://example.com/strong") return [{ url: intent.url, title: "Strong", content: "# S\n\n## Auth tokens\n\ntoken refresh rotation details here\n", contentType: "text/markdown" }];
    if (intent.url === "https://example.com/weak") return [{ url: intent.url, title: "Weak", content: "# W\n\ntoken mention only\n", contentType: "text/markdown" }];
    return [{ url: intent.url, title: "None", content: "# N\n\nnothing about the topic\n", contentType: "text/markdown" }];
  });
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const result = await tool.execute("id", { urls: ["https://example.com/weak", "https://example.com/strong", "https://example.com/none"], query_terms: "token refresh" }, undefined, undefined, ctx);
    assert.equal(result.details.failureClass, undefined);
    const text = result.content[0].text;
    assert.ok(text.indexOf("https://example.com/strong") < text.indexOf("https://example.com/weak"), "best match first");
    assert.ok(text.indexOf("https://example.com/weak") < text.indexOf("https://example.com/none"), "no-match sources last");
    assert.match(text, /3 sources requested · 3 succeeded · 0 failed/);
    assert.match(text, /None \(https:\/\/example\.com\/none\) -> .* — no quality match \(best score \d+\.\d+\); read or grep the file/);
    assert.match(text, /top-3 of \d+ units/, "multi-source ranking uses 3 per source");
    assert.match(text, /### Auth tokens \(score \d+\.\d+ · read lines \d+-\d+\)/, "compact card plus ranked snippet with read range on batch sources");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch download always refreshes, preserves created, and redacts URL secrets", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-"));
  let calls = 0;
  const adapter = fetchAdapter("webclaw", () => { calls++; return [{ url: "https://example.com/data", title: "Data", content: `# Body\nversion ${calls}`, contentType: "text/markdown" }]; });
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const url = "https://user:pass@example.com/data?token=hunter2&client_secret=deeper&x=1";
    const downloaded = await tool.execute("id", { urls: url, mode: "download" }, undefined, undefined, ctx);
    const cachePath = downloaded.details.cache[0].path;
    const first = readFileSync(cachePath, "utf8");
    const created = /^created: (.+)$/m.exec(first)?.[1];
    assert.ok(created);
    assert.doesNotMatch(first, /user:pass|hunter2|deeper/);
    assert.match(first, /token=%5Bredacted%5D.*client_secret=%5Bredacted%5D/);
    assert.doesNotMatch(cachePath, /hunter2/);
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(cachePath)).mode & 0o777, 0o700);
    assert.match(downloaded.content[0].text, /version 1/, "download shows the per-source content view");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const refreshed = await tool.execute("id", { urls: url, mode: ["download", "refresh"] }, undefined, undefined, ctx);
    const second = readFileSync(cachePath, "utf8");
    assert.equal(calls, 2, "download always fetches fresh even on a cache hit");
    assert.match(refreshed.content[0].text, /merged into download/);
    assert.equal(/^created: (.+)$/m.exec(second)?.[1], created);
    assert.notEqual(/^updated: (.+)$/m.exec(second)?.[1], /^updated: (.+)$/m.exec(first)?.[1]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch crawl starts one scoped job, rejects off-scope output, and bypasses fetch providers", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-crawl-public-"));
  let spawnCalls = 0;
  let providerCalls = 0;
  __setWebclawSpawnForTest(async () => {
    spawnCalls += 1;
    return { ok: true, ms: 1, stderr: "", code: 0, stdout: [
      "> URL: https://example.com/docs/a\n> TITLE: A\n\n# A\nbody",
      "> URL: https://example.com/\n> TITLE: Root\n\n# Root\nbody",
    ].join("\n---\n") };
  });
  const adapter = fetchAdapter("webclaw", (intent) => { providerCalls += 1; return [{ url: intent.url, title: "Page", content: "# Page\nbody", contentType: "text/markdown" }]; });
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const result = await tool.execute("id", { urls: "https://example.com/docs/*", mode: "crawl", wait: 1 }, undefined, undefined, ctx);
    assert.equal(result.details.failureClass, undefined);
    assert.equal(result.details.operation, "crawl");
    assert.equal(result.details.crawlStatus, "completed");
    assert.match(result.content[0].text, /1 page\(s\)/);
    assert.match(result.content[0].text, /https:\/\/example\.com\/docs\/a/);
    assert.doesNotMatch(result.content[0].text, /\(https:\/\/example\.com\/\)/);
    assert.match(result.content[0].text, /1 off-scope.*rejected locally/);
    assert.equal(spawnCalls, 1);
    assert.equal(providerCalls, 0);
    assert.equal(existsSync(join(cwd, ".cache", "web")), true);
    const next = await tool.execute("next", { urls: "https://example.com/next" }, undefined, undefined, ctx);
    assert.equal(providerCalls, 1);
    assert.doesNotMatch(next.content[0].text, /crawl:1 completed/, "a start+wait completion is not delivered twice");
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("crawl format parses brackets, bare globs, bare-path subtrees, recursion, and exclusions", () => {
  const bracketed = parseCrawlFormat("https://example.org/+[test/*,other/*/*]-[thispathistoignore/,this_onetoo/]");
  assert.deepEqual(bracketed, { seed: "https://example.org", include: ["test/*", "other/*/*"], exclude: ["thispathistoignore/", "this_onetoo/"], depth: 2 });
  assert.deepEqual(parseCrawlFormat("https://example.org/*"), { seed: "https://example.org", include: ["/*"], exclude: [], depth: 1 });
  assert.deepEqual(parseCrawlFormat("https://example.org/*/*"), { seed: "https://example.org", include: ["/*/*"], exclude: [], depth: 2 });
  assert.deepEqual(parseCrawlFormat("https://example.org/**"), { seed: "https://example.org", include: ["/**"], exclude: [], depth: 25 });
  assert.deepEqual(parseCrawlFormat("https://example.org/test/*"), { seed: "https://example.org", include: ["/test/*"], exclude: [], depth: 1 });
  assert.deepEqual(parseCrawlFormat("https://example.org/*-[c/*]"), { seed: "https://example.org", include: ["/*"], exclude: ["c/*"], depth: 1 });
  assert.deepEqual(parseCrawlFormat("https://example.org/test/*-[c/*]"), { seed: "https://example.org", include: ["/test/*"], exclude: ["c/*"], depth: 1 });
  assert.equal(parseCrawlFormat("https://example.org/test"), undefined, "bare paths are page URLs until mode:\"crawl\"");
  assert.deepEqual(crawlScope("https://example.org/"), { seed: "https://example.org", include: ["/*"], exclude: [], depth: 1 });
  assert.deepEqual(crawlScope("https://example.org/test/*-[private/**]"), { seed: "https://example.org/test", include: ["/test/*"], exclude: ["private/**"], depth: 1 });
  assert.deepEqual(crawlScope("https://example.org/test"), { seed: "https://example.org/test", include: ["/test/*"], exclude: [], depth: 1 });
  assert.deepEqual(crawlScope("https://example.org/test/*"), { seed: "https://example.org/test", include: ["/test/*"], exclude: [], depth: 1 });
});

test("crawl worker enforces local scope, dedupe, cap, and shutdown abort before cache writes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-crawl-worker-"));
  const events = {};
  const pi = { on(event, handler) { events[event] = handler; } };
  let spawnCalls = 0;
  const page = (url, title = url) => `> URL: ${url}\n> TITLE: ${title}\n\n# ${title}\nbody`;
  const stdout = [
    page("https://example.com/docs/a"),
    page("https://example.com/docs/a", "duplicate"),
    page("https://example.com/docs/b"),
    page("https://example.com/docs/c"),
    page("https://example.com/docs/private/secret"),
    page("https://other.example/docs/off-origin"),
    "# missing URL header\nbody",
  ].join("\n---\n");
  const manager = createCrawlJobManager(pi, async () => {
    spawnCalls += 1;
    return { ok: true, ms: 1, stdout, stderr: "", code: 0 };
  });
  const request = {
    seed: "https://example.com/docs",
    include: ["/docs/**"],
    exclude: ["/docs/private/**"],
    depth: 25,
    maxPages: 2,
    root: cacheRoot(cwd),
    destinationPolicy: { allowPrivateHosts: [] },
  };
  try {
    const job = manager.start(request);
    assert.equal(manager.start(request).id, job.id, "identical running crawls share one subprocess");
    await manager.wait(job, 1);
    assert.equal(job.status, "completed", job.error);
    assert.equal(spawnCalls, 1);
    assert.deepEqual(job.pages.map((entry) => entry.url), ["https://example.com/docs/a", "https://example.com/docs/b"]);
    assert.match(job.note, /page\(s\) rejected locally/);
    assert.equal(job.pages.every((entry) => existsSync(entry.path)), true);
    assert.equal(manager.drainCompletions()[0].id, job.id);

    let aborted = false;
    const blocking = createCrawlJobManager(pi, async (_args, options) => new Promise((resolve) => {
      options.signal.addEventListener("abort", () => {
        aborted = true;
        resolve({ ok: false, ms: 1, stdout: "", stderr: "aborted", code: 1 });
      }, { once: true });
    }));

    const otherScope = manager.start({ ...request, include: ["/other/**"] });
    await manager.wait(otherScope, 1);
    assert.notEqual(otherScope.manifestPath, job.manifestPath, "crawl manifests are keyed by the full requested scope");

    let releaseLookup;
    let markLookupStarted;
    const lookupStarted = new Promise((resolve) => { markLookupStarted = resolve; });
    __setDestinationLookupForTest(async () => {
      markLookupStarted();
      await new Promise((resolve) => { releaseLookup = resolve; });
      return [{ address: "8.8.8.8", family: 4 }];
    });
    const finalizing = createCrawlJobManager(pi, async () => ({ ok: true, ms: 1, stdout: page("https://example.com/docs/late"), stderr: "", code: 0 }));
    const late = finalizing.start({ ...request, maxPages: 1 });
    await lookupStarted;
    finalizing.stopAll();
    releaseLookup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(late.status, "cancelled");
    assert.equal(late.pages, undefined, "shutdown during finalization cannot publish or cache a completed job");
    __setDestinationLookupForTest(async () => [{ address: "8.8.8.8", family: 4 }]);
    const pending = blocking.start({ ...request, seed: "https://example.com/other", include: ["/other/**"] });
    blocking.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(aborted, true);
    assert.equal(pending.status, "cancelled");
  } finally {
    __setDestinationLookupForTest(async () => [{ address: "8.8.8.8", family: 4 }]);
    rmSync(cwd, { recursive: true, force: true });
  }
});


test("web_fetch crawl handle mixed with URLs is ignored and the URLs are fetched", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-"));
  const called = [];
  const adapter = fetchAdapter("webclaw", (intent) => {
    called.push(intent.url);
    return [{ url: intent.url, title: intent.url, content: `# ${intent.url}\n\nbody`, contentType: "text/markdown" }];
  });
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const result = await tool.execute("id", { urls: ["crawl:99", "https://example.com/a"] }, undefined, undefined, ctx);
    assert.deepEqual(called, ["https://example.com/a"]);
    assert.match(result.content[0].text, /crawl handle crawl:99 ignored in a batch/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});


test("web_fetch llm_answer reuses only an exact retained summary without credentials or new work", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-llm-retained-"));
  const url = "https://example.com/demo";
  let spawnCalls = 0;
  let providerCalls = 0;
  __setLlmKeyForTest(undefined);
  __setWebclawSpawnForTest(async () => { spawnCalls += 1; throw new Error("LLM spawn must remain unreachable"); });
  const adapter = fetchAdapter("webclaw", () => { providerCalls += 1; throw new Error("page fetch must remain unreachable"); });
  try {
    const { entry, summary } = seedRetainedSummary(cwd, url, "What is the answer?", "alpha");
    const legacyPath = `${entry.path}.summary.md`;
    renameSync(summary.path, legacyPath);
    const { tool, ctx } = setup([adapter], cwd);
    const result = await tool.execute("id", { urls: url, mode: "llm_answer", objective: "What is the answer?", query_terms: "alpha" }, undefined, undefined, ctx);
    assert.equal(result.details.failureClass, undefined);
    assert.equal(result.details.provider, "local-summary");
    assert.equal(result.details.cached, true);
    assert.deepEqual(result.details.attempts, []);
    assert.deepEqual(result.details.summary, [{ url, path: legacyPath }]);
    assert.equal(spawnCalls, 0);
    assert.equal(providerCalls, 0);
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch llm_answer blocks missing, intent-mismatched, and stale summaries before new work", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-llm-blocked-"));
  const retainedUrl = "https://example.com/retained";
  const missingUrl = "https://example.com/missing";
  let spawnCalls = 0;
  let providerCalls = 0;
  __setWebclawSpawnForTest(async () => { spawnCalls += 1; throw new Error("LLM spawn must remain unreachable"); });
  const adapter = fetchAdapter("webclaw", () => { providerCalls += 1; throw new Error("page fetch must remain unreachable"); });
  try {
    const { entry, summary } = seedRetainedSummary(cwd, retainedUrl, "q", undefined, "RETAINED_Q");
    const { tool, ctx } = setup([adapter], cwd);
    const partial = await tool.execute("partial", { urls: [retainedUrl, missingUrl], mode: "llm_answer", objective: "q" }, undefined, undefined, ctx);
    assert.equal(partial.details.failureClass, undefined);
    assert.match(partial.content[0].text, /1 retained answer\(s\) reused · 1 generation blocked/);
    assert.match(partial.content[0].text, /RETAINED_Q/);

    const intentMismatch = await tool.execute("intent", { urls: retainedUrl, mode: "llm_answer", objective: "different" }, undefined, undefined, ctx);
    assert.equal(intentMismatch.details.failureClass, "policy");

    writeCache({ canonicalUrl: retainedUrl, sourceUrl: retainedUrl, provider: "fixture", fetchMode: "download", extract: "llm", title: "Demo", body: "# Demo\n\nchanged page bytes" }, cacheRoot(cwd));
    const stale = await tool.execute("stale", { urls: retainedUrl, mode: "llm_answer", objective: "q" }, undefined, undefined, ctx);
    assert.equal(stale.details.failureClass, "policy");
    assert.doesNotMatch(stale.content[0].text, /RETAINED_Q/);
    assert.equal(readFileSync(summary.path, "utf8").includes("content_hash:"), true);
    assert.equal(spawnCalls, 0);
    assert.equal(providerCalls, 0);
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch llm_answer deduplicates async generation, retains separate immutable intents, waits, and reports completion once", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-llm-async-"));
  const url = "https://example.com/async";
  let spawnCalls = 0;
  let providerCalls = 0;
  const modelArgs = [];
  __setLlmAnswerGenerationForTest(true);
  __setLlmKeyForTest("test-key");
  __setWebclawSpawnForTest(async (args) => {
    spawnCalls += 1;
    modelArgs.push([...args]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return args.join(" ").includes("Return ONLY a JSON object")
      ? { ok: true, ms: 20, stdout: '{"Alpha":"summary"}', stderr: "", code: 0 }
      : { ok: true, ms: 20, stdout: "ASYNC_ANSWER", stderr: "", code: 0 };
  });
  const adapter = fetchAdapter("webclaw", (intent) => {
    providerCalls += 1;
    return [{ url: intent.url, title: "Async", content: "# Async\n\n## Alpha\n\nsource bytes", contentType: "text/markdown" }];
  });
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const first = await tool.execute("first", { urls: url, mode: "llm_answer", objective: "answer it" }, undefined, undefined, ctx);
    const duplicate = await tool.execute("duplicate", { urls: url, mode: "llm_answer", objective: "answer it" }, undefined, undefined, ctx);
    assert.match(first.content[0].text, /1 generating/);
    assert.match(duplicate.content[0].text, /1 generating/);
    assert.equal(providerCalls, 1, "the duplicate reuses the page cache");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(spawnCalls, 2, "one summary and one answer call run for the shared job");
    assert.equal(modelArgs.every((args) => args[0] === "--file" && !args.includes(url)), true, "the model reads exact retained cache bytes instead of refetching the URL");

    __setLlmKeyForTest(undefined);
    const retained = await tool.execute("retained", { urls: url, mode: "llm_answer", objective: "answer it", wait: 1 }, undefined, undefined, ctx);
    assert.match(retained.content[0].text, /ASYNC_ANSWER/);
    assert.match(retained.content[0].text, /llm_answer llm-answer-1 completed/);
    assert.equal(spawnCalls, 2, "exact retained reuse needs no credential or new model call");
    const noDuplicateReceipt = await tool.execute("retained-again", { urls: url, mode: "llm_answer", objective: "answer it" }, undefined, undefined, ctx);
    assert.doesNotMatch(noDuplicateReceipt.content[0].text, /llm-answer-1 completed/);

    __setLlmKeyForTest("test-key");
    const secondIntent = await tool.execute("second-intent", { urls: url, mode: "llm_answer", objective: "different intent", wait: 1 }, undefined, undefined, ctx);
    assert.match(secondIntent.content[0].text, /ASYNC_ANSWER/);
    assert.equal(spawnCalls, 4, "a distinct intent receives its own immutable summary+answer job");
    assert.notEqual(secondIntent.details.summary[0].path, retained.details.summary[0].path);
    assert.equal(existsSync(secondIntent.details.summary[0].path), true);
    assert.equal(existsSync(retained.details.summary[0].path), true);

    const waited = await tool.execute("waited", { urls: "https://example.com/waited", mode: "llm_answer", objective: "wait for it", wait: 1 }, undefined, undefined, ctx);
    assert.match(waited.content[0].text, /ASYNC_ANSWER/);
    assert.doesNotMatch(waited.content[0].text, /being generated/);
    assert.equal(spawnCalls, 6, "wait returns the one completed summary+answer job");

    const guarded = writeCache({ canonicalUrl: "https://example.com/guarded", sourceUrl: "https://example.com/guarded", provider: "fixture", fetchMode: "page", extract: "llm", title: "Guarded", body: "# Guarded\nold" }, cacheRoot(cwd));
    assert.throws(() => writeSummary(guarded.path, { body: "answer", model: "fixture", expectedContentHash: "different" }), /Cache content changed during summary generation/);
    assert.equal(existsSync(summaryPathFor(guarded.path, guarded.meta.contentHash, undefined, undefined)), false);

    const events = {};
    const manager = createLlmAnswerJobManager({ on(event, handler) { events[event] = handler; } });
    const pending = manager.start({ url, summaryPath: "pending.summary.md" });
    assert.equal(manager.start({ url, summaryPath: "pending.summary.md" }).id, pending.id, "one summary path owns one running LLM job");
    let aborted = false;
    pending.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    events.session_shutdown();
    assert.equal(aborted, true);
    assert.equal(pending.status, "failed");
    assert.match(pending.error, /session shutdown/);
  } finally {
    __setLlmAnswerGenerationForTest(false);
    __setLlmKeyForTest(undefined);
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch map classifies spawn failures with the same vocabulary as the fetch lane", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-map-taxonomy-"));
  __setWebclawSpawnForTest(async () => ({ ok: false, ms: 5, stdout: "", stderr: "failed to resolve host: example.com", code: 1 }));
  try {
    const { tool, ctx } = setup([fetchAdapter()], cwd);
    const result = await tool.execute("id", { urls: "https://example.com", mode: "map" }, undefined, undefined, ctx);
    assert.equal(result.details.failureClass, "timeout", "a DNS failure is timeout in map too, matching the fetch lane");
    assert.equal(result.details.operation, "map", "failures carry the mode that was attempted");
    assert.match(result.content[0].text, /web_fetch failed: timeout/);
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});


test("web_fetch map keeps query_terms and objective out of lead output with notes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-"));
  __setWebclawSpawnForTest(async () => ({ ok: true, ms: 10, stdout: "https://example.com/a\nhttps://example.com/b\n", stderr: "" }));
  try {
    const { tool, ctx } = setup([fetchAdapter()], cwd);
    const result = await tool.execute("id", { urls: "https://example.com/", mode: "map", query_terms: "seed feature", objective: "find it" }, undefined, undefined, ctx);
    assert.equal(result.details.failureClass, undefined);
    const text = result.content[0].text;
    assert.match(text, /https:\/\/example\.com\/a/);
    assert.doesNotMatch(text, /UNIQUE_SEED_FACT/, "map must not add an implicit seed-page fetch");
    assert.match(text, /query_terms does not rank discovery lists/);
    assert.match(text, /objective is dormant on map output/);
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch tolerance accepts scheme-less hosts, aliases, and mode arrays with notes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-"));
  const called = [];
  const adapter = fetchAdapter("webclaw", (intent) => {
    called.push(intent.url);
    return [{ url: intent.url, title: intent.url, content: `# ${intent.url}\n\nbody`, contentType: "text/markdown" }];
  });
  __setWebclawSpawnForTest(async () => ({ ok: true, ms: 10, stdout: "https://example.com/a\n", stderr: "" }));
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const schemeLess = await tool.execute("id", { urls: "example.com/docs" }, undefined, undefined, ctx);
    assert.deepEqual(called, ["https://example.com/docs"], "scheme-less host gets https://");
    const downloadOverMap = await tool.execute("id", { urls: "https://example.com/a", mode: ["download", "map"] }, undefined, undefined, ctx);
    assert.match(downloadOverMap.content[0].text, /download wins over map/);
    const siteAlias = await tool.execute("id", { urls: "https://example.com/*", mode: ["site"] }, undefined, undefined, ctx);
    assert.match(siteAlias.content[0].text, /site.*normalized to map/, "array-form site alias still tolerated with a note");
    const scalarSite = await tool.execute("id", { urls: "https://example.com/*", mode: "site" }, undefined, undefined, ctx);
    assert.match(scalarSite.content[0].text, /Mode "site" is removed/, "scalar site is no longer a valid mode");
    const scalarRefresh = await tool.execute("id", { urls: "https://example.com/a", mode: "refresh" }, undefined, undefined, ctx);
    assert.match(scalarRefresh.content[0].text, /Mode "refresh" is removed/, "scalar refresh is no longer a valid mode");
    const refreshAlias = await tool.execute("id", { urls: "https://example.com/a", mode: ["refresh"] }, undefined, undefined, ctx);
    assert.match(refreshAlias.content[0].text, /refresh.*merged into download/, "array-form refresh alias still tolerated with a note");
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});


test("web_fetch objective is dormant on ordinary page calls with a note", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-"));
  const adapter = fetchAdapter("webclaw", () => [{ url: "https://example.com/demo", title: "Demo", content: "# Demo\n\nbody", contentType: "text/markdown" }]);
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const result = await tool.execute("id", { urls: "https://example.com/demo", objective: "What is the answer?" }, undefined, undefined, ctx);
    assert.equal(result.details.failureClass, undefined);
    assert.match(result.content[0].text, /objective is dormant here/);
    assert.doesNotMatch(result.content[0].text, /The answer is/, "no LLM was invoked");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch hard-fails only for empty calls, unknown modes, and impossible contracts", async () => {
  const { tool, ctx } = setup([fetchAdapter()]);
  for (const params of [
    {},
    { mode: "crawl" },
    { urls: "   " },
    { urls: "https://example.com", mode: "craawl" },
    { urls: "https://example.com", query_terms: "   " },
    { urls: "https://example.com", objective: "   " },
    { urls: "https://example.com", wait: 61 },
    { urls: "crawl:missing" },
  ]) {
    const result = await tool.execute("id", params, undefined, undefined, ctx);
    assert.equal(result.details.failureClass, "invalid_input", `expected rejection for ${JSON.stringify(params)}`);
  }
});

test("web_fetch schema v2: urls is the only required parameter; legacy params are rejected", async () => {
  const { tool, ctx, events } = setup([fetchAdapter()]);
  assert.equal(Check(tool.parameters, {}), true, "schema allows empty but execute rejects missing urls/url aliases");
  assert.equal((await tool.execute("missing-urls", {}, undefined, undefined, ctx)).details.failureClass, "invalid_input");
  assert.equal(Check(tool.parameters, { urls: "https://example.com" }), true);
  assert.equal(Check(tool.parameters, { urls: ["https://example.com/a", "https://example.com/b"], query_terms: "x", objective: "y", mode: "download", wait: 10 }), true);
  assert.equal(Check(tool.parameters, { urls: "https://example.com", query_terms: 42 }), false);
  for (const legacy of ["extract", "linkup", "llm_rich", "summary_id", "context", "pattern", "top", "question", "responseId", "crawl_id"]) {
    assert.equal(Check(tool.parameters, { urls: "https://example.com", [legacy]: legacy === "linkup" ? { renderJs: false } : "x" }), false, `${legacy} is removed`);
  }
  assert.equal(Check(tool.parameters, { urls: "https://example.com", mode: ["download", "llm_answer"] }), true, "mode arrays are accepted");
  assert.equal(Check(tool.parameters, { urls: "https://example.com", urls2: "x" }), false);
  assert.match(tool.parameters.properties.urls.description, /Required: one URL string or a batch array/);
  assert.match(tool.parameters.properties.query_terms.description, /exact line ranges/);
  assert.match(tool.parameters.properties.wait.description, /Seconds to wait for background jobs/);
  assert.doesNotMatch(tool.promptGuidelines[0], /webclaw|enforced locally/); // enforcement is invisible to callers by design
  assert.match(tool.promptGuidelines[0], /Cache: \.cache\/web/);
  assert.match(tool.promptGuidelines[0], /grep that path/);
});

test("web_fetch tolerates a JSON-array string passed as urls (double-encoded batch)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-json-"));
  const adapter = fetchAdapter("webclaw", (intent) => [{ url: intent.url ?? (intent.urls?.[0] ?? ""), title: "T", content: "# body\n\ncontent here", contentType: "text/markdown" }]);
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const result = await tool.execute("id", { urls: '["https://example.com/a", "https://example.com/b"]' }, undefined, undefined, ctx);
    assert.equal(result.details.failureClass, undefined, "double-encoded batch must not fail normalization");
    assert.match(result.content[0].text, /2 sources requested · 2 succeeded/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch multi-source page returns every source independently with live cumulative progress", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-websift-fetch-"));
  const adapter = fetchAdapter("webclaw", (intent) => {
    if (intent.url === "https://example.com/failed") return { failureClass: "network", message: "fixture unavailable" };
    const fact = intent.url.includes("coffee") ? "BULK_TOOL_FACT" : "BULK_CHANGE_FACT";
    return [{ url: intent.url, title: intent.url, content: `# ${intent.url}\n\n${fact} ${"detail ".repeat(40)}`, contentType: "text/markdown" }];
  });
  try {
    const { tool, ctx } = setup([adapter], cwd);
    const updates = [];
    const onUpdate = (update) => updates.push(update);
    const result = await tool.execute("id", { urls: ["https://example.com/coffee", "https://example.com/change", "https://example.com/failed", "https://example.com/tea"] }, undefined, onUpdate, ctx);
    assert.equal(result.details.failureClass, undefined);
    assert.match(result.content[0].text, /4 sources requested · 3 succeeded · 1 failed/);
    assert.match(result.content[0].text, /fresh fetch/, "batch cards identify network-fetched snapshots");
    assert.equal(updates.length, 4, "one cumulative update is emitted for every settled source");
    assert.match(updates.at(-1).content[0].text, /\[4\/4\]/);
    assert.match(updates.at(-1).content[0].text, /BULK_TOOL_FACT/);
    assert.match(updates.at(-1).content[0].text, /BULK_CHANGE_FACT/);
    assert.match(updates.at(-1).content[0].text, /https:\/\/example\.com\/failed \[failed\]/);
    assert.equal(result.details.cache.filter((entry) => entry.path).length, 3, "every fetched source prints a cache path");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("parseLlmOutput keeps body-level blockquote metadata out of the header", () => {
  const out = `> URL: https://example.com/\n> Title: T\n\nbody line\n> Author: https://example.com/x\n`;
  const { header, body } = parseLlmOutput(out);
  assert.equal(header.title, "T");
  assert.match(body, /> Author:/, "tweet-style trailing metadata stays in the body");
});
