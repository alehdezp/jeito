// Decision protected: version pinning, ambiguity refusal, response retention, and evidence rights stay deterministic across Context7 changes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  context7FetchDocs, context7GetLibraryDocs, context7ResolveLibraries, context7SearchLibraries, createContext7Adapter,
} from "../../src/adapters/context7.ts";
const ctx = { credential: "secret", timeoutMs: 1000, persist() {}, root: mkdtempSync(join(tmpdir(), "jeito-ctx7-")) };
const fixture = JSON.parse(await readFile(new URL("../fixtures/context7/lookup.json", import.meta.url), "utf8"));
const oneCandidate = (extra = {}) => new Response(JSON.stringify({ results: [{ id: "/t/l", title: "T", versions: [], ...extra }] }));

// Existing behavior: resolve a version-aware library then fetch docs through the adapter dispatch.
test("resolves a version-aware Context7 library then fetches docs", async () => {
  let calls = 0;
  const adapter = createContext7Adapter(async () => ++calls === 1 ? new Response(JSON.stringify(fixture)) : new Response("# API docs"));
  const result = await adapter.lookup({ operation: "lookup", source: "context7", query: "API", library: "test", version: "1.0.0", page: 1, provider: "context7" }, { timeoutMs: 1000, persist() {} });
  assert.equal(result[0].content, "# API docs");
  assert.equal(result[0].metadata.requestedVersion, "1.0.0");
  assert.equal(result[0].metadata.resolvedLibraryId, "/test/library@1.0.0");
});

// Proof 1: resolve-only request shape and candidate metadata.
test("context7ResolveLibraries sends the resolve request shape and preserves candidate metadata", async () => {
  let captured;
  const fetchImpl = async (url) => { captured = new URL(url); return new Response(JSON.stringify({
    results: [{ id: "/vercel/next.js", title: "Next.js", description: "React framework", versions: ["v15.1.8", "v14.3.0"], totalSnippets: 3629, trustScore: 10, benchmarkScore: 95.5, source: "github" }],
    searchFilterApplied: false,
  })); };
  const records = await context7ResolveLibraries({ query: "routing", library: "nextjs", fast: true }, ctx, fetchImpl);
  assert.equal(captured.origin + captured.pathname, "https://context7.com/api/v2/libs/search");
  assert.equal(captured.searchParams.get("libraryName"), "nextjs");
  assert.equal(captured.searchParams.get("query"), "routing");
  assert.equal(captured.searchParams.get("fast"), "true");
  assert.equal(records.length, 1);
  assert.equal(records[0].content, undefined); // catalog evidence, no inline content
  assert.deepEqual(records[0].metadata, { id: "/vercel/next.js", title: "Next.js", description: "React framework", versions: ["v15.1.8", "v14.3.0"], totalSnippets: 3629, trustScore: 10, benchmarkScore: 95.5, source: "github", searchFilterApplied: false, needsResolution: false, recommendedLibraryId: "/vercel/next.js" });
});

// Proof 2: exact libraryId bypasses resolution.
test("context7GetLibraryDocs with libraryId bypasses resolution", async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(new URL(url)); return new Response("# Docs body"); };
  const results = await context7GetLibraryDocs({ query: "q", libraryId: "/vercel/next.js", page: 1 }, ctx, fetchImpl);
  assert.equal(urls.length, 1); // no search call
  assert.equal(urls[0].origin + urls[0].pathname, "https://context7.com/api/v2/context");
  assert.equal(urls[0].searchParams.get("libraryId"), "/vercel/next.js");
  assert.equal(results[0].metadata.resolvedLibraryId, "/vercel/next.js");
});

test("context7GetLibraryDocs rejects malformed explicit library IDs before fetch", async () => {
  const fetchImpl = async () => { throw new Error("should not be called"); };
  await assert.rejects(() => context7GetLibraryDocs({ query: "q", libraryId: "vercel/next.js", page: 1 }, ctx, fetchImpl), { failureClass: "invalid_input" });
});

// Proof 3: safe unique name resolution followed by docs retrieval.
test("context7GetLibraryDocs auto-selects a unique candidate and fetches docs", async () => {
  let calls = 0;
  const fetchImpl = async () => (++calls === 1 ? oneCandidate() : new Response("# The docs"));
  const results = await context7GetLibraryDocs({ query: "q", library: "t", page: 1 }, ctx, fetchImpl);
  assert.equal(calls, 2); // search + docs
  assert.equal(results[0].content, "# The docs");
  assert.equal(results[0].metadata.resolvedLibraryId, "/t/l");
});

// Proof 4: ambiguous resolution returns candidates and performs no docs request.
test("context7GetLibraryDocs returns candidates and skips docs on ambiguous resolution", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify({ results: [
    { id: "/a/alpha", title: "Zeta", versions: [] },
    { id: "/b/beta", title: "Zeta", versions: [] },
  ] })); };
  const results = await context7GetLibraryDocs({ query: "q", library: "nomatch", page: 1 }, ctx, fetchImpl);
  assert.equal(calls, 1); // search only, no docs request
  assert.equal(results.length, 2);
  assert.ok(results.every((record) => record.metadata.needsResolution === true && record.content === undefined));
});

test("context7GetLibraryDocs selects one unique exact name but never guesses from provider scores", async () => {
  let calls = 0;
  const exactFetch = async () => ++calls === 1
    ? new Response(JSON.stringify({ results: [{ id: "/a/other", title: "Other", benchmarkScore: 100 }, { id: "/b/react", title: "React", benchmarkScore: 1 }] }))
    : new Response("exact docs");
  const exact = await context7GetLibraryDocs({ query: "q", library: "react", page: 1 }, ctx, exactFetch);
  assert.equal(exact[0].metadata.resolvedLibraryId, "/b/react");

  let scoreCalls = 0;
  const scoresOnly = async () => { scoreCalls += 1; return new Response(JSON.stringify({ results: [{ id: "/a/one", title: "One", benchmarkScore: 100 }, { id: "/b/two", title: "Two", benchmarkScore: 1 }] })); };
  const ambiguous = await context7GetLibraryDocs({ query: "q", library: "nomatch", page: 1 }, ctx, scoresOnly);
  assert.equal(scoreCalls, 1);
  assert.ok(ambiguous.every((record) => record.metadata.needsResolution === true));
});

// Proof 5: requested version pins the resolved ID, or fails safely without fetching unversioned docs.
test("context7GetLibraryDocs pins the resolved ID to a matched version", async () => {
  let calls = 0;
  const urls = [];
  const fetchImpl = async (url) => { urls.push(new URL(url)); return ++calls === 1 ? new Response(JSON.stringify({ results: [{ id: "/vercel/next.js", title: "Next.js", versions: ["v15.1.8", "v14.3.0"] }] })) : new Response("# versioned docs"); };
  const results = await context7GetLibraryDocs({ query: "q", library: "nextjs", version: "14.3.0", page: 1 }, ctx, fetchImpl);
  assert.equal(results[0].metadata.resolvedLibraryId, "/vercel/next.js@v14.3.0");
  assert.equal(results[0].metadata.requestedVersion, "14.3.0");
  assert.equal(urls[1].searchParams.get("libraryId"), "/vercel/next.js@v14.3.0");
});

test("context7GetLibraryDocs fails safely when no candidate advertises the requested version", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify({ results: [{ id: "/vercel/next.js", title: "Next.js", versions: ["v15.1.8"] }] })); };
  const results = await context7GetLibraryDocs({ query: "q", library: "nextjs", version: "9.9.9", page: 1 }, ctx, fetchImpl);
  assert.equal(calls, 1); // search only; never fetch unversioned docs
  assert.equal(results[0].metadata.versionNotFound, "9.9.9");
  assert.equal(results[0].metadata.needsResolution, true);
  assert.equal(results[0].content, undefined);
});

test("context7ResolveLibraries applies requested versions instead of silently ignoring them", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ results: [
    { id: "/vercel/next.js", title: "Next.js", versions: ["v15.1.8", "v14.3.0"] },
    { id: "/other/next.js", title: "Next.js", versions: ["v13.0.0"] },
  ] }));
  const records = await context7ResolveLibraries({ query: "q", library: "next.js", version: "14.3.0" }, ctx, fetchImpl);
  assert.equal(records.length, 1);
  assert.equal(records[0].metadata.requestedVersion, "14.3.0");
  assert.equal(records[0].metadata.recommendedLibraryId, "/vercel/next.js");
});

test("context7ResolveLibraries marks a missing requested version as unresolved", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ results: [{ id: "/vercel/next.js", title: "Next.js", versions: ["v15.1.8"] }] }));
  const records = await context7ResolveLibraries({ query: "q", library: "next.js", version: "14.3.0" }, ctx, fetchImpl);
  assert.equal(records[0].metadata.versionNotFound, "14.3.0");
  assert.equal(records[0].metadata.needsResolution, true);
  assert.equal(records[0].metadata.recommendedLibraryId, undefined);
});

// Proof 6: topic and page are encoded into the effective query, not sent as server params.
test("context7GetLibraryDocs encodes topic and page into the effective query only", async () => {
  let calls = 0;
  let docsUrl;
  const fetchImpl = async (url) => { if (++calls === 2) docsUrl = new URL(url); return calls === 1 ? oneCandidate() : new Response("docs"); };
  await context7GetLibraryDocs({ query: "hooks", library: "t", topic: "state management", page: 3 }, ctx, fetchImpl);
  const effective = docsUrl.searchParams.get("query");
  assert.match(effective, /hooks/);
  assert.match(effective, /Focus: state management/);
  assert.match(effective, /Requested page: 3/);
  assert.equal(docsUrl.searchParams.get("topic"), null); // not an independent server param
  assert.equal(docsUrl.searchParams.get("page"), null);
});

// Proof 7: fast and responseType map exactly to the official parameters (and are omitted when unset).
test("context7GetLibraryDocs maps fast and responseType to the official parameters", async () => {
  let calls = 0;
  let docsUrl;
  const fetchImpl = async (url) => { if (++calls === 2) docsUrl = new URL(url); return calls === 1 ? oneCandidate() : new Response(JSON.stringify({ codeSnippets: [], infoSnippets: [] })); };
  await context7GetLibraryDocs({ query: "q", library: "t", page: 1, fast: true, responseType: "json" }, ctx, fetchImpl);
  assert.equal(docsUrl.searchParams.get("type"), "json");
  assert.equal(docsUrl.searchParams.get("fast"), "true");
});

test("context7GetLibraryDocs omits fast and type when unset", async () => {
  let calls = 0;
  let docsUrl;
  const fetchImpl = async (url) => { if (++calls === 2) docsUrl = new URL(url); return calls === 1 ? oneCandidate() : new Response("txt docs"); };
  await context7GetLibraryDocs({ query: "q", library: "t", page: 1 }, ctx, fetchImpl);
  assert.equal(docsUrl.searchParams.get("type"), null);
  assert.equal(docsUrl.searchParams.get("fast"), null);
});

// Proof 8: txt normalization (bounded inline) and complete raw-body retention.
test("context7GetLibraryDocs retains the complete txt body as a file and inlines a bounded excerpt", async () => {
  let calls = 0;
  const longBody = "x".repeat(7000); // exceeds the 6000-char inline bound
  const fetchImpl = async () => (++calls === 1 ? oneCandidate() : new Response(longBody));
  const results = await context7GetLibraryDocs({ query: "q", library: "t", page: 1 }, ctx, fetchImpl);
  assert.ok(results[0].content.length < longBody.length);
  assert.match(results[0].content, /excerpt truncated/);
  const docsPath = results[0].metadata.docsPath;
  assert.equal(typeof docsPath, "string");
  assert.match(docsPath, /docs\/t_l\/full\.md$/);
  assert.equal(await readFile(docsPath, "utf8"), longBody); // complete raw body retained as a file
});

// Proof 9: json validation, normalized inline representation, and exact raw-json retention.
test("context7GetLibraryDocs validates json, normalizes inline, and retains exact raw json", async () => {
  let calls = 0;
  const rawJson = JSON.stringify({ codeSnippets: [{ codeTitle: "Example", codeLanguage: "ts", pageTitle: "Guide", codeDescription: "desc", codeList: [{ language: "ts", code: "const x = 1;" }] }], infoSnippets: [{ breadcrumb: "Docs > Intro", content: "Intro text" }] });
  const fetchImpl = async () => (++calls === 1 ? oneCandidate() : new Response(rawJson));
  const results = await context7GetLibraryDocs({ query: "q", library: "t", page: 1, responseType: "json" }, ctx, fetchImpl);
  assert.match(results[0].content, /### Example/);
  assert.match(results[0].content, /const x = 1;/);
  assert.match(results[0].content, /## Docs > Intro/);
  const docsPath = results[0].metadata.docsPath;
  assert.match(docsPath, /full\.json$/);
  assert.equal(await readFile(docsPath, "utf8"), rawJson); // exact raw JSON retained as a file
});

test("context7GetLibraryDocs classifies a malformed json response as provider-contract unavailable", async () => {
  let calls = 0;
  const fetchImpl = async () => (++calls === 1 ? oneCandidate() : new Response("{not json"));
  await assert.rejects(() => context7GetLibraryDocs({ query: "q", library: "t", page: 1, responseType: "json" }, ctx, fetchImpl), { failureClass: "unavailable" });
});
test("context7 zero candidate resolve and docs mode are successful scoped zeros", async () => {
  const empty = async () => new Response(JSON.stringify({ results: [] }));
  const resolveRecords = await context7ResolveLibraries({ query: "q", library: "none" }, ctx, empty);
  assert.deepEqual(resolveRecords, []);
  const docsRecords = await context7GetLibraryDocs({ query: "q", library: "none", page: 1 }, ctx, empty);
  assert.deepEqual(docsRecords, []);
});

// Proof 10 / 12: docs results carry a docsPath (fetched); resolve/catalog results do not.
test("context7 docs results carry a docsPath; resolve results stay catalog without one", async () => {
  let calls = 0;
  const fetchImpl = async () => (++calls === 1 ? oneCandidate() : new Response("docs"));
  const docs = await context7GetLibraryDocs({ query: "q", library: "t", page: 1 }, ctx, fetchImpl);
  assert.equal(typeof docs[0].metadata.docsPath, "string");
  const catalog = await context7ResolveLibraries({ query: "q", library: "t" }, ctx, async () => oneCandidate());
  assert.equal(catalog[0].metadata.docsPath, undefined);
  assert.equal(catalog[0].content, undefined);
});

test("context7 resolve mode rejects docs-only controls instead of ignoring them", async () => {
  const adapter = createContext7Adapter(async () => { throw new Error("should not be called"); });
  await assert.rejects(
    () => adapter.lookup({ operation: "lookup", source: "context7", query: "q", library: "next", page: 1, context7: { mode: "resolve", topic: "routing" } }, ctx),
    { failureClass: "invalid_input" },
  );
});

// Proof 13: pre-abort, local timeout, HTTP classes, malformed JSON/text shape.
test("context7 focused operations reject a pre-aborted caller before fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = async () => { throw new Error("should not be called"); };
  await assert.rejects(() => context7SearchLibraries({ query: "q", library: "x" }, { ...ctx, signal: controller.signal }, fetchImpl), { failureClass: "aborted" });
});

test("context7 enforces a local timeout through the shared taxonomy", async () => {
  const fetchImpl = (_url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({ results: [] }))), 2000);
    options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("The operation was aborted", "AbortError")); }, { once: true });
  });
  await assert.rejects(() => context7SearchLibraries({ query: "q", library: "x" }, { ...ctx, timeoutMs: 30 }, fetchImpl), { failureClass: "timeout" });
});

test("context7 timeout covers response body consumption, not only response headers", async () => {
  const fetchImpl = async (_url, options) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(JSON.stringify({ results: [] })), 2000);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("The operation was aborted", "AbortError")); }, { once: true });
    }),
  });
  await assert.rejects(() => context7SearchLibraries({ query: "q", library: "x" }, { ...ctx, timeoutMs: 30 }, fetchImpl), { failureClass: "timeout" });
});

test("context7 classifies HTTP auth/rate-limit/server failures", async () => {
  for (const [status, failureClass] of [[401, "auth"], [429, "rate_limited"], [500, "network"]]) {
    const fetchImpl = async () => new Response("", { status });
    await assert.rejects(() => context7SearchLibraries({ query: "q", library: "x" }, ctx, fetchImpl), { failureClass });
  }
});

test("context7 classifies malformed search/docs JSON and shape as unavailable while empty docs text stays a content failure", async () => {
  await assert.rejects(() => context7SearchLibraries({ query: "q", library: "x" }, ctx, async () => new Response("{bad")), { failureClass: "unavailable" });
  await assert.rejects(() => context7SearchLibraries({ query: "q", library: "x" }, ctx, async () => new Response(JSON.stringify({ nope: true }))), { failureClass: "unavailable" });
  await assert.rejects(() => context7GetLibraryDocs({ query: "q", libraryId: "/x/y", page: 1, responseType: "json" }, ctx, async () => new Response(JSON.stringify({ codeSnippets: [] }))), { failureClass: "unavailable" });
  await assert.rejects(() => context7FetchDocs({ libraryId: "/x/y", query: "q" }, ctx, async () => new Response("   ")), { failureClass: "empty" });
});

// Proof 14: credential redaction, including transport errors that contain the key.
test("context7 redacts the credential from transport errors that contain it", async () => {
  const credential = "ctx7sk-super-secret";
  const fetchImpl = async () => { throw new Error(`fetch failed connecting with ${credential}`); };
  let caught;
  try { await context7SearchLibraries({ query: "q", library: "x" }, { ...ctx, credential }, fetchImpl); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.doesNotMatch(caught.message, new RegExp(credential));
  assert.match(caught.message, /\[redacted\]/);
});