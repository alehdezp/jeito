// ADR-002.005 adapter tests: the webclaw fetch lane, js-needs DB v2 routing, rule v2
// detection, vertical dispatch, and the LLM key boundary. All spawn calls are faked.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebclawAdapter } from "../src/adapters/webclaw.ts";
import { __setDestinationLookupForTest } from "../src/destination-policy.ts";
import { cacheRoot } from "../src/fetch-cache.ts";
import { __setWebclawSpawnForTest, __setWebclawVersionForTest, bodyMetrics, extractForUrl, verticalForUrl } from "../src/webclaw-spawn.ts";
import { clearJsNeed, hasJsNeed, JS_NEEDS_VERSION, jsNeedsRule, readJsNeedsDb, recordJsNeed } from "../src/js-needs.ts";
import { ProviderError } from "../src/failures.ts";
import { AdapterRegistry } from "../src/registry.ts";
import { runWithFallback } from "../src/routing.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

__setDestinationLookupForTest(async () => [{ address: "8.8.8.8", family: 4 }]);
__setWebclawVersionForTest(async () => "webclaw 0.6.16");
test.after(() => { __setDestinationLookupForTest(undefined); __setWebclawVersionForTest(undefined); });

function llmOut(url, title, body) {
  return `> URL: ${url}\n> Title: ${title}\n\n${body}`;
}

test("bodyMetrics and rule v2 separate true shells from known-good pages", () => {
  const shell = bodyMetrics(""); // algolia/qwen SPA class: 0 chars
  const thin = bodyMetrics("navigation only"); // x.com class: 0 headings, 16 textChars
  const good = bodyMetrics("# Title\n\n## Section\n\nreal content ".repeat(40));
  const tinyStatic = bodyMetrics("# Example Domain\n\nThis domain is for use in illustrative examples in documents.");
  assert.equal(jsNeedsRule(shell), true);
  assert.equal(jsNeedsRule(thin), true);
  assert.equal(jsNeedsRule(good), false);
  assert.equal(jsNeedsRule(tinyStatic), false, "tiny page WITH a heading is static content, never a shell");
  assert.equal(good.headings >= 2, true);
});

test("js-needs DB v2: record, route, expire by re-verify window, clear on success", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-jsneeds-"));
  try {
    assert.deepEqual(readJsNeedsDb(cacheRoot(root)), { version: JS_NEEDS_VERSION, records: [] });
    recordJsNeed("https://qwen.ai/blog?id=x", { chars: 0, tokens: 0, headings: 0, links: 0, fences: 0, tables: 0, textChars: 0 }, cacheRoot(root));
    assert.equal(hasJsNeed("https://qwen.ai/blog?id=y", cacheRoot(root)), true, "path-prefix match");
    assert.equal(hasJsNeed("https://other.example/x", cacheRoot(root)), false);
    assert.equal(existsSync(join(cacheRoot(root), "js-needs.json")), true);
    // A rich success clears the record (self-heal path).
    clearJsNeed("https://qwen.ai/blog?id=y", cacheRoot(root));
    assert.equal(hasJsNeed("https://qwen.ai/blog?id=x", root), false);
    // A stale record (older than the re-verify window) does not route.
    recordJsNeed("https://stale.example/a", { chars: 0, tokens: 0, headings: 0, links: 0, fences: 0, tables: 0, textChars: 0 }, cacheRoot(root));
    const dbPath = join(cacheRoot(root), "js-needs.json");
    const raw = JSON.parse(readFileSync(dbPath, "utf8"));
    raw.records = raw.records.filter((record) => record.host !== "stale.example");
    raw.records.push({ host: "stale.example", pathPrefix: "/", detectedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), evidence: { chars: 0, tokens: 0, headings: 0, links: 0, fences: 0, tables: 0, textChars: 0 } });
    writeFileSync(dbPath, JSON.stringify(raw, null, 2) + "\n");
    assert.equal(hasJsNeed("https://stale.example/a", cacheRoot(root)), false, "stale records expire");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v1 records are ignored by the version gate (wipe at cutover)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-jsneeds-v1-"));
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(cacheRoot(root), { recursive: true });
    writeFileSync(join(cacheRoot(root), "js-needs.json"), JSON.stringify({ version: 1, records: [{ host: "docs.tavily.com", pathPrefix: "/documentation", detectedAt: new Date().toISOString() }] }));
    assert.equal(readJsNeedsDb(cacheRoot(root)).records.length, 0, "v1 records never route");
    assert.equal(hasJsNeed("https://docs.tavily.com/documentation/x", cacheRoot(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verticalForUrl and extractForUrl key the 8 proven shapes and the native class", () => {
  assert.equal(verticalForUrl("https://www.npmjs.com/package/express"), "npm");
  assert.equal(verticalForUrl("https://pypi.org/project/requests/"), "pypi");
  assert.equal(verticalForUrl("https://crates.io/crates/serde"), "crates_io");
  assert.equal(verticalForUrl("https://hub.docker.com/_/redis"), "docker_hub");
  assert.equal(verticalForUrl("https://arxiv.org/abs/2501.16214"), "arxiv");
  assert.equal(verticalForUrl("https://huggingface.co/deepseek-ai/DeepSeek-V3"), "huggingface_model");
  assert.equal(verticalForUrl("https://huggingface.co/datasets/x/y"), "huggingface_dataset");
  assert.equal(verticalForUrl("https://huggingface.co/papers"), undefined, "reserved HF routes are not model pages");
  assert.equal(verticalForUrl("https://stackoverflow.com/questions/11227809/x"), "stackoverflow");
  assert.equal(verticalForUrl("https://news.ycombinator.com/item?id=45000000"), "hackernews");
  assert.equal(verticalForUrl("https://www.reddit.com/r/x/comments/1"), undefined, "unproven shapes get no dispatch");
  assert.equal(verticalForUrl("https://github.com/tobi/qmd"), undefined, "github shape belongs to the native handler");
  assert.equal(extractForUrl("https://example.com/a.pdf"), "native");
  assert.equal(extractForUrl("https://github.com/tobi/qmd"), "native");
  assert.equal(extractForUrl("https://www.npmjs.com/package/express"), "vertical");
  assert.equal(extractForUrl("https://example.com/article"), "llm");
});

test("webclaw adapter: rich llm success returns header metadata and clears stale records", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websiftclaw-ok-"));
  try {
    // A stale record (past the re-verify window) does not block webclaw; rich success clears it.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(cacheRoot(root), { recursive: true });
    writeFileSync(join(cacheRoot(root), "js-needs.json"), JSON.stringify({
      version: JS_NEEDS_VERSION,
      records: [{ host: "stale.example", pathPrefix: "/", detectedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), evidence: { chars: 0, tokens: 0, headings: 0, links: 0, fences: 0, tables: 0, textChars: 0 } }],
    }));
    __setWebclawSpawnForTest(async () => ({ ok: true, ms: 10, stdout: llmOut("https://final.example/a", "Final Title", "# Heading\n\nrich content ".repeat(30)), stderr: "" }));
    const adapter = createWebclawAdapter();
    const [value] = await adapter.fetch({ operation: "fetch", url: "https://stale.example/a", mode: "page" }, { timeoutMs: 5000, persist() {}, root: cacheRoot(root) });
    assert.equal(value.title, "Final Title");
    assert.match(value.content, /rich content/);
    assert.equal(hasJsNeed("https://stale.example/a", cacheRoot(root)), false, "rich success self-heals");
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("webclaw adapter rejects an internal effective URL before attribution or caching", async () => {
  let spawnCalls = 0;
  __setWebclawSpawnForTest(async () => {
    spawnCalls += 1;
    return { ok: true, ms: 10, stdout: llmOut("http://127.0.0.1/admin", "Internal", "# Heading\n\nrich content ".repeat(30)), stderr: "" };
  });
  try {
    const adapter = createWebclawAdapter();
    await assert.rejects(() => adapter.fetch({ operation: "fetch", url: "https://public.example/start", mode: "page" }, { timeoutMs: 5000, persist() {} }), { failureClass: "policy" });
    assert.equal(spawnCalls, 1);
  } finally {
    __setWebclawSpawnForTest(undefined);
  }
});

test("webclaw adapter: rule v2 detection writes the DB and throws so tavily escalates", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websiftclaw-thin-"));
  __setWebclawSpawnForTest(async () => ({ ok: true, ms: 10, stdout: llmOut("https://shell.example/", "Shell", "nav link text"), stderr: "" }));
  try {
    const adapter = createWebclawAdapter();
    await assert.rejects(
      () => adapter.fetch({ operation: "fetch", url: "https://shell.example/", mode: "page" }, { timeoutMs: 5000, persist() {}, root: cacheRoot(root) }),
      (error) => error instanceof ProviderError && error.failureClass === "unavailable",
    );
    assert.equal(hasJsNeed("https://shell.example/other", cacheRoot(root)), true, "detection writes the DB");
    const config = structuredClone(DEFAULT_CONFIG);
    config.providers.tavily = { enabled: true, apiKey: "present" };
    const calls = [];
    const tavily = { capability: { id: "tavily", operations: ["fetch"], credentials: ["TAVILY_API_KEY"], strengths: ["page"], modes: ["page"], returns: ["content"], timeoutMs: 1000, concurrency: 1, fallbackEligible: true, provenance: "test" }, async fetch(intent) { calls.push(intent.url); return [{ url: intent.url, title: "Rendered", content: "full js content" }]; } };
    const routed = await runWithFallback(new AdapterRegistry([adapter, tavily]), { operation: "fetch", url: "https://shell.example/", mode: "page" }, config, { timeoutMs: 5000, persist() {}, root: cacheRoot(root) });
    assert.equal(routed.provider, "tavily");
    assert.deepEqual(routed.attempts.map((attempt) => [attempt.provider, attempt.failureClass]), [["webclaw", "unavailable"], ["tavily", undefined]]);
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("webclaw adapter: DB-first routing sends recorded hosts straight to tavily", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websiftclaw-dbfirst-"));
  recordJsNeed("https://js.example/a", { chars: 0, tokens: 0, headings: 0, links: 0, fences: 0, tables: 0, textChars: 0 }, cacheRoot(root));
  let spawnCalls = 0;
  __setWebclawSpawnForTest(async () => { spawnCalls++; return { ok: true, ms: 10, stdout: llmOut("https://js.example/a", "X", "# X\n\ncontent"), stderr: "" }; });
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.providers.tavily = { enabled: true, apiKey: "present" };
    const adapter = createWebclawAdapter();
    const tavily = { capability: { id: "tavily", operations: ["fetch"], credentials: ["TAVILY_API_KEY"], strengths: ["page"], modes: ["page"], returns: ["content"], timeoutMs: 1000, concurrency: 1, fallbackEligible: true, provenance: "test" }, async fetch(intent) { return [{ url: intent.url, title: "Rendered", content: "full js content" }]; } };
    const routed = await runWithFallback(new AdapterRegistry([adapter, tavily]), { operation: "fetch", url: "https://js.example/a", mode: "page" }, config, { timeoutMs: 5000, persist() {}, root: cacheRoot(root) });
    assert.equal(routed.provider, "tavily");
    assert.equal(spawnCalls, 0, "DB hit never spawns webclaw");
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("webclaw adapter: an aborted signal stops the fetch with an aborted failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websiftclaw-abort-"));
  let spawnCalls = 0;
  __setWebclawSpawnForTest(async () => { spawnCalls++; return { ok: true, ms: 10, stdout: llmOut("https://abort.example/", "X", "# X\n\ncontent"), stderr: "" }; });
  try {
    const adapter = createWebclawAdapter();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => adapter.fetch({ operation: "fetch", url: "https://abort.example/", mode: "page" }, { timeoutMs: 5000, persist() {}, root: cacheRoot(root), signal: controller.signal }),
      (error) => error instanceof ProviderError && error.failureClass === "aborted",
    );
    assert.equal(spawnCalls, 0, "a pre-aborted signal never spawns webclaw");
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("webclaw adapter: missing binary is policy (no tavily fallback) with install guidance", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websiftclaw-enoent-"));
  __setWebclawSpawnForTest(async () => ({ ok: false, ms: 1, stdout: "", stderr: "spawn webclaw ENOENT", code: "ENOENT" }));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.providers.tavily = { enabled: true, apiKey: "present" };
    let tavilyCalls = 0;
    const adapter = createWebclawAdapter();
    const tavily = { capability: { id: "tavily", operations: ["fetch"], credentials: ["TAVILY_API_KEY"], strengths: ["page"], modes: ["page"], returns: ["content"], timeoutMs: 1000, concurrency: 1, fallbackEligible: true, provenance: "test" }, async fetch() { tavilyCalls++; return []; } };
    await assert.rejects(
      () => runWithFallback(new AdapterRegistry([adapter, tavily]), { operation: "fetch", url: "https://example.com/x", mode: "page" }, config, { timeoutMs: 5000, persist() {}, root: cacheRoot(root) }),
      (error) => error.failureClass === "policy" && /brew install 0xmassi\/webclaw/.test(error.message),
    );
    assert.equal(tavilyCalls, 0, "an environment problem must not burn paid escalation");
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("webclaw adapter: empty stdout is empty (escalates) and never cached as success", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websiftclaw-empty-"));
  __setWebclawSpawnForTest(async () => ({ ok: true, ms: 10, stdout: "", stderr: "" }));
  try {
    const adapter = createWebclawAdapter();
    await assert.rejects(
      () => adapter.fetch({ operation: "fetch", url: "https://spa.example/", mode: "page" }, { timeoutMs: 5000, persist() {}, root: cacheRoot(root) }),
      (error) => error instanceof ProviderError && error.failureClass === "empty",
    );
    assert.equal(hasJsNeed("https://spa.example/", cacheRoot(root)), true, "empty success is the JS-shell class and records");
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("webclaw adapter: vertical dispatch returns typed JSON and falls back to llm on failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websiftclaw-vertical-"));
  const calls = [];
  __setWebclawSpawnForTest(async (args) => {
    calls.push(args);
    if (args[0] === "vertical" && args[1] === "npm") return { ok: true, ms: 10, stdout: '{"name":"express","latest_version":"5.0.0"}', stderr: "" };
    return { ok: true, ms: 10, stdout: llmOut("https://www.npmjs.com/package/express", "express", "# express\n\nmarkdown fallback"), stderr: "" };
  });
  try {
    const adapter = createWebclawAdapter();
    const [ok] = await adapter.fetch({ operation: "fetch", url: "https://www.npmjs.com/package/express", mode: "page" }, { timeoutMs: 5000, persist() {}, root: cacheRoot(root) });
    assert.equal(ok.contentType, "application/json");
    assert.match(ok.content, /express/);
    // Second URL: vertical fails -> generic llm fallback in the same attempt.
    __setWebclawSpawnForTest(async (args) => {
      calls.push(args);
      if (args[0] === "vertical") return { ok: false, ms: 10, stdout: "", stderr: "vertical failed" };
      return { ok: true, ms: 10, stdout: llmOut("https://pypi.org/project/requests/", "requests", "# requests\n\nmarkdown fallback ".repeat(30)), stderr: "" };
    });
    const [fallback] = await adapter.fetch({ operation: "fetch", url: "https://pypi.org/project/requests/", mode: "page" }, { timeoutMs: 5000, persist() {}, root: cacheRoot(root) });
    assert.match(fallback.content, /markdown fallback/);
  } finally {
    __setWebclawSpawnForTest(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
