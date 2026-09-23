import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { canonicalExistingPath } from "../src/core/path-resolve.ts";
import { snapshots } from "../src/core/snapshot-store.ts";
import { resolveProjectDocsContext, searchDocsWithQmd, syncQmdDocs } from "../src/core/qmd-docs-search.ts";
import { createMarkdownFrontmatterExposureState } from "../src/core/markdown-frontmatter.ts";
import { attachFirstMarkdownFrontmatter, registerDocsSearchTool } from "../src/tools/docs-search.ts";
import { registerReadTool } from "../src/tools/read.ts";
import { LlamaCpp } from "../native/qmd/runtime/llm.js";

test("QMD maintenance needs explicit model-acquisition permission and queries never inherit it", async t => {
  const root = await mkdtemp(join(tmpdir(), "qmd-acquisition-policy-"));
  await writeFile(join(root, "guide.md"), "## Local guide\n\nLocal model policy.\n");
  const observed = [];
  // Exercise the real wrapper and SDK constructor, but never invoke a model,
  // native build or download, even in the deliberately permitted control.
  for (const method of ["embed", "embedBatch", "rerank"]) {
    t.mock.method(LlamaCpp.prototype, method, async function () { throw new Error("fixture blocks model work"); });
  }
  t.mock.method(LlamaCpp.prototype, "dispose", async function () { observed.push(this.allowModelDownloads); });
  const options = { root, indexPath: join(root, ".index"), repo: "local/acquisition-policy", semanticProvider: "local", callNative: docsCensusProjection(["guide.md"]) };
  await syncQmdDocs(options);
  assert.deepEqual(observed.splice(0), [false], "automatic maintenance must not grant model acquisition");
  await syncQmdDocs({ ...options, allowModelDownloads: true });
  assert.deepEqual(observed.splice(0), [true], "explicit manual acquisition remains available");
  await searchDocsWithQmd("Local guide", { ...options, allowModelDownloads: true });
  assert.deepEqual(observed.splice(0), [false], "read-only queries override acquisition permission");
  const { freshenDocs } = await import("../scripts/navigation-freshen.mjs");
  for (const trigger of ["session_start", "first_broad_request", "stop_refresh", undefined, "manual_prepare", "manual_freshen"]) {
    await freshenDocs(root, { scope: ".", docsIndexPath: options.indexPath, docsRepo: options.repo, docsProvider: "local", callNative: options.callNative, trigger });
    const manual = trigger == null || trigger === "manual_prepare" || trigger === "manual_freshen";
    assert.deepEqual(observed.splice(0), [manual], `freshen must propagate ${trigger ?? "manual CLI"} acquisition policy`);
  }
});

test("docs frontmatter expansion does not depend on ranking score", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-frontmatter-score-independent-"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "guide.md"), "---\ntitle: Guide\ndescription: Returned metadata.\n---\n# Guide\n");
  const state = createMarkdownFrontmatterExposureState();
  const items = [{ path: "docs/guide.md", finalScore: -100, contentHash: "" }];
  const attached = await attachFirstMarkdownFrontmatter(items, root, root, state);
  assert.equal(attached.shown, 1);
  assert.equal(attached.deferred, 0);
  assert.match(items[0].frontmatter.text, /2:title: Guide/);
});

test("pi-nav sections are the only QMD records and stale selectors reconcile incrementally", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-docs-"));
  const currentPath = "docs/harness-doctrine.md";
  const planPath = "docs/plan/implementation.md";
  await mkdir(join(root, "docs", "plan"), { recursive: true });
  await writeFile(join(root, currentPath), "## Current authority\n\nCurrent behavior and safe handoff.\n");
  await writeFile(join(root, planPath), "## Historical plan\n\nPlanned behavior and migration notes.\n");

  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (url.endsWith("/models/embed")) return response({ results: body.input.map((text, index) => ({ index, embedding: body.input_type === "query" && /zqxwv|rescue/i.test(text) ? [0, 0, 1] : /current|safe|renamed/i.test(text) ? [1, 0, 0] : [0, 1, 0] })) });
    if (url.endsWith("/models/rerank")) return response({ results: body.documents.map((text, index) => ({ index, relevance_score: /rescue/i.test(String(body.query ?? "")) ? 0.85 : /zqxwv/i.test(String(body.query ?? "")) ? 0.79 : /orbital/i.test(String(body.query ?? "")) ? 0.2 : /current|safe|renamed/i.test(text) ? 0.95 : 0.7 })) });
    return new Response("unexpected managed endpoint", { status: 500 });
  };
  const callNative = docsCensusProjection([currentPath, planPath]);

  const options = { root, indexPath: join(root, "unused"), repo: "local/repo", apiKey: "test", fetchImpl, callNative };
  const synced = await syncQmdDocs(options);
  assert.equal(synced.status, "ready");
  assert.equal(synced.format_migrated, true);
  assert.equal(synced.sections, 2);
  assert.equal(synced.files, 2);
  assert.ok(requests.some(request => request.url.endsWith("/models/embed") && request.body.input_type === "document"));
  assert.ok(requests.every(request => !request.url.includes("/collections/") && !request.url.includes("/queries/top-pages")));
  const indexFile = join(options.indexPath, `${digest(options.repo).slice(0, 20)}.sqlite`);
  const beforeQuery = await stat(indexFile, { bigint: true });
  const searched = await searchDocsWithQmd("How does the current safe handoff work?", options);
  const afterQuery = await stat(indexFile, { bigint: true });
  assert.equal(afterQuery.mtimeNs, beforeQuery.mtimeNs, "docs_search must open QMD read-only and must not persist query caches");
  assert.equal(afterQuery.size, beforeQuery.size);
  assert.equal(searched.status, "ready");
  assert.equal(searched.results[0].section_id, `${currentPath}:current-authority#2`);
  assert.equal(searched.results[0].project_navigation.docs_authority_role, "current_authority");
  assert.match(searched.results[0].project_navigation.qmd.snippet, /safe handoff/);
  assert.equal(searched.results[0].project_navigation.qmd.qmd_score, 0.95, "zerank relevance must own final semantic ordering rather than RRF position");
  assert.equal(searched.results[0].project_navigation.qmd.read_selector, `${currentPath}:current-authority#2`);
  assert.ok(requests.some(request => request.url.endsWith("/models/embed") && request.body.input_type === "query"));
  assert.ok(requests.some(request => request.url.endsWith("/models/rerank") && request.body.model === "zerank-2"));
  const exactTitle = await searchDocsWithQmd("Current authority", options);
  assert.equal(exactTitle.results[0].section_id, `${currentPath}:current-authority#2`);
  assert.equal(exactTitle.results[0].project_navigation.qmd.title_prior, 0.55, "exact heading identity must restore the pre-removal title relevance signal");
  const exactPlanTitle = await searchDocsWithQmd("Historical plan", options);
  assert.equal(exactPlanTitle.results[0].section_id, `${planPath}:historical-plan#2`, "an explicit exact heading must not be demoted by the ordinary current-authority prior");
  assert.equal(exactPlanTitle.results[0].project_navigation.qmd.title_prior, 0.55);
  assert.equal(exactPlanTitle.results[0].project_navigation.qmd.authority_prior, 0);
  const noAnswer = await searchDocsWithQmd("orbital banana quantum warranty", options);
  assert.ok(noAnswer.results.length > 0, "current candidates must remain available as weak leads instead of becoming a false zero");
  assert.ok(noAnswer.results.every(result => result.project_navigation.qmd.answerability.status === "weak_lead"));
  assert.equal(noAnswer.answerability.status, "weak_leads_only");
  assert.equal(noAnswer.answerability.answer_bearing_count, 0);
  assert.equal(noAnswer.answerability.weak_lead_count, noAnswer.results.length);
  assert.ok(noAnswer.answerability.low_rerank_weak >= 2);
  const weakVector = await searchDocsWithQmd("zqxwv flurbnaught qqq", options);
  assert.ok(weakVector.results.length > 0, "vector-noise candidates remain inspectable but must not be represented as answers");
  assert.ok(weakVector.results.every(result => result.project_navigation.qmd.answerability.status === "weak_lead"));
  assert.ok(weakVector.answerability.weak_vector_weak >= 1);
  const strongRerankRescue = await searchDocsWithQmd("semantic rescue phrase", options);
  assert.ok(strongRerankRescue.results.length > 0, "a strong reranker signal must preserve a lexically distant answer below the ordinary vector floor");
  assert.equal(strongRerankRescue.results[0].project_navigation.qmd.answerability.status, "answer_bearing");
  const degradedQuery = await searchDocsWithQmd("current safe handoff", {
    ...options,
    fetchImpl: async () => new Response("provider unavailable", { status: 503 }),
  });
  assert.equal(degradedQuery.status, "lexical_ready");
  assert.equal(degradedQuery.semantic.status, "degraded");
  assert.match(degradedQuery.semantic.reason, /provider_query_failed/);
  assert.equal(degradedQuery.results[0].section_id, `${currentPath}:current-authority#2`);

  await writeFile(join(root, currentPath), "## Renamed authority\n\nCurrent behavior and safe handoff.\n");
  const stale = await searchDocsWithQmd("current safe handoff", options);
  assert.equal(stale.results.some(result => result.doc_path === currentPath), false, "a stale selector must not survive live pi-nav resolution");

  const incremental = await syncQmdDocs({ ...options, paths: [currentPath] });
  assert.equal(incremental.files, 2);
  assert.ok(Number(incremental.changed) >= 1);
  assert.ok(Number(incremental.removed) >= 1);
  assert.ok(Number(incremental.cleanup?.orphanedVectors) >= 1, "reconciliation must remove stale vectors before they can crowd out active semantic candidates");
  assert.ok(Number(incremental.cleanup?.inactiveDocuments) >= 1);
  const repaired = await searchDocsWithQmd("renamed safe handoff", options);
  assert.equal(repaired.results[0].section_id, `${currentPath}:renamed-authority#2`);
  assert.equal(repaired.results.some(result => result.section_id === `${currentPath}:current-authority#2`), false);

  const warmRequestCount = requests.length;
  const warm = await syncQmdDocs({ ...options, paths: [currentPath] });
  assert.equal(warm.unchanged, 1);
  assert.equal(warm.format_migrated, false);
  assert.equal(requests.length, warmRequestCount, "unchanged exact-path refresh must not call the embedding provider");
  assert.equal(basename(currentPath), "harness-doctrine.md");
});

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Deterministic docs census + supplied-source projection double. Native owns
 * ignore/policy semantics; this double applies only the compiled excluded
 * prefixes so admission plumbing is exercised without loading the addon. */
function docsCensusProjection(files) {
  const reads = [];
  const censusRoots = [];
  const callNative = async ({ root: nativeRoot, operation, args }) => {
    if (operation === "pi_nav_files") {
      censusRoots.push(nativeRoot);
      const excluded = Array.isArray(args?.corpusPolicy?.excludedPrefixes) ? args.corpusPolicy.excludedPrefixes : [];
      const admitted = files.filter(file => !excluded.some(prefix => file === prefix || file.startsWith(`${prefix}/`)));
      return { structured: { data: { corpusPolicyVersion: 1, root: nativeRoot, files: admitted, directories: [] }, completeness: { complete: true } } };
    }
    assert.equal(operation, "pi_nav_read");
    assert.equal(args.markdownStructure, true);
    assert.equal(args.includeSections, true);
    assert.ok(args.capturedSource && typeof args.capturedSource.text === "string", "projection must use admitted supplied source");
    const text = args.capturedSource.text;
    reads.push({ path: String(args.path), text });
    const heading = text.match(/^(#{1,6})\s+(.+)$/m);
    const sections = heading ? [{
      selector: `${slug(heading[2])}#${heading[1].length}`,
      title: heading[2],
      level: heading[1].length,
      parent: null,
      children: [],
      headingStartByte: Buffer.byteLength(text.slice(0, heading.index)),
      headingEndByte: Buffer.byteLength(text.slice(0, heading.index + heading[0].length)),
      headingStartLine: 1,
      headingEndLine: 1,
      ownEndByte: Buffer.byteLength(text),
      ownEndLine: text.trimEnd().split("\n").length,
      subtreeEndByte: Buffer.byteLength(text),
      subtreeEndLine: text.trimEnd().split("\n").length,
    }] : [];
    return { structured: { data: { basis: "supplied", path: args.path, suppliedSourceHash: digest(text),
      files: [{ path: args.path, totalLines: text.split("\n").length, codeBlockCount: 0, owner: null, sections }] } } };
  };
  return Object.assign(callNative, { reads, censusRoots });
}


function fakeLocalLlm() {
  return {
    embedModelName: "local-test-embed",
    generateModelName: "local-test-generate",
    rerankModelName: "local-test-rerank",
    async embed() { return { embedding: [1, 0, 0], model: this.embedModelName }; },
    async embedBatch(texts) { return texts.map(() => ({ embedding: [1, 0, 0], model: this.embedModelName })); },
    async generate() { return null; },
    async expandQuery() { return []; },
    async rerank(_query, documents) { return { model: this.rerankModelName, results: documents.map((document, index) => ({ file: document.file, index, score: index === 0 ? 0.95 : 0.75 })) }; },
    async modelExists(model) { return { name: model, exists: true }; },
    async dispose() {},
  };
}

test("owned local QMD inference provides hybrid docs retrieval without an external key", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-docs-local-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n\n## Portable local inference\n\ncodeweave-pi works without a global QMD install.\n");
  const options = { root, indexPath: join(root, "prepared-qmd"), repo: "local/local-models", semanticProvider: "local", llm: fakeLocalLlm() };
  const synced = await syncQmdDocs(options);
  assert.equal(synced.status, "ready");
  assert.equal(synced.semantic_provider, "local");
  assert.equal(synced.privacy, "local_index_local_inference");
  const searched = await searchDocsWithQmd("portable local inference", { ...options, llm: fakeLocalLlm() });
  assert.equal(searched.status, "ready");
  assert.equal(searched.provider, "qmd-local-models");
  assert.equal(searched.semantic_provider, "local");
  assert.equal(searched.results[0].project_navigation.qmd.read_selector, "docs/guide.md:guide/portable-local-inference#2");
});

test("packaged pi-nav projects current Markdown into lexical QMD without a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-docs-native-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n\n## Exact lifecycle\n\nDeterministic lifecycle answer.\n");
  const options = { root, indexPath: join(root, "unused"), repo: "local/native" };
  const synced = await syncQmdDocs(options);
  assert.equal(synced.status, "lexical_ready");
  assert.equal(synced.sections, 2);
  assert.equal(synced.semantic.status, "unavailable");
  const searched = await searchDocsWithQmd("deterministic lifecycle answer", options);
  assert.equal(searched.status, "lexical_ready");
  assert.equal(searched.results[0].project_navigation.qmd.read_selector, "docs/guide.md:guide/exact-lifecycle#2");
  assert.equal(searched.semantic.status, "unavailable");
});

test("public docs_search exposes progress, ranking evidence, filters, paging, and current selector handoffs", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-docs-public-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "guide.md"), "---\ntitle: Guide metadata\ndescription: Shared context for this file.\ntags: [guide]\ncode:\n  - target.ts::work\nrelated:\n  - docs/related.md::related/#1\n  - docs/missing.md\n---\n# Guide\n\n## Alpha\n\nShared paging marker alpha.\n\n## Beta\n\nShared paging marker beta.\n");
  await writeFile(join(root, "docs", "large.md"), `---\ntitle: Large guide\ndescription: Compact QMD fallback.\nfiller: "${"x".repeat(9_000)}"\ncode: [missing.ts::hidden]\n---\n# Large\n\n## Target\nLarge marker answer.\n`);
  await writeFile(join(root, "docs", "other.md"), "# Other\n\n## Noise\n\nShared paging marker noise.\n");
  await writeFile(join(root, "target.ts"), "export function work() { return 1; }\n");
  await writeFile(join(root, "docs", "related.md"), "# Related\nCurrent relation.\n");
  const indexPath = join(root, ".pi", "navigation", "qmd");
  await syncQmdDocs({ root, indexPath, repo: "local/public" });
  await writeFile(join(root, ".pi-navigation.json"), `${JSON.stringify({ docs: { enabled: true, backend: "qmd", repo: "local/public", root: ".", indexPath: ".pi/navigation/qmd" } }, null, 2)}\n`);
  const tools = new Map();
  const frontmatterExposureState = createMarkdownFrontmatterExposureState();
  const api = { registerTool(value) { tools.set(value.name, value); } };
  registerDocsSearchTool(api, frontmatterExposureState);
  registerReadTool(api, frontmatterExposureState);
  const tool = tools.get("docs_search");
  const readTool = tools.get("read");
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
  const updates = [];
  const first = await tool.execute("docs-public", { query: "shared paging marker", path: "docs/guide.md", glob: "docs/**/*.md", page: 1, limit: 1 }, undefined, update => updates.push(update), { cwd: root });
  assert.equal(updates[0].details.presentation.phase, "searching");
  assert.equal(first.details.presentation.kind, "docs-search");
  assert.equal(first.details.presentation.items.length, 1);
  assert.equal(first.details.presentation.items[0].path, "docs/guide.md");
  assert.match(first.details.presentation.items[0].readSelector, /^docs\/guide\.md:/);
  assert.equal(first.details.presentation.pageWindows[0].complete, false);
  assert.equal(first.details.presentation.pageWindows[0].next_page, 2);
  assert.match(first.content[0].text, /Search mode: lexical · current document-section evidence active/);
  assert.doesNotMatch(first.content[0].text, /semantic=(?:unavailable|degraded)|Readiness:/i);
  assert.match(first.content[0].text, /Ranking: lexical ranking \+ title\/authority priors · current Markdown selectors/);
  assert.doesNotMatch(first.content[0].text, /qmd-local|zembed|zerank|pi-nav/i);
  assert.match(first.content[0].text, /Generation: [a-f0-9]{64}/);
  assert.match(first.content[0].text, /score=.*retrieval=.*title=.*authority=/);
  assert.match(first.content[0].text, /1:---\n2:title: Guide metadata\n3:description: Shared context for this file\.\n4:tags: \[guide\]\n5:code:\n6:  - target\.ts::work\n7:related:\n8:  - docs\/related\.md::related\/#1\n9:  - docs\/missing\.md\n10:---/);
  assert.match(first.content[0].text, /Relationship selectors: valid=2 · invalid=1 · ambiguous=0 · unverified=0/);
  const frontmatterTag = /\[docs\/guide\.md#([0-9A-F]{8})\]/.exec(first.content[0].text)?.[1];
  assert.ok(frontmatterTag);
  const frontmatterSnapshot = snapshots.byTag(canonicalExistingPath(join(root, "docs", "guide.md")), frontmatterTag);
  assert.deepEqual([...frontmatterSnapshot.seenLines].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(frontmatterExposureState.seenPaths.size, 1);
  const second = await tool.execute("docs-public-2", { query: "shared paging marker", path: "docs/guide.md", page: 2, limit: 1 }, undefined, undefined, { cwd: root });
  assert.equal(second.details.presentation.items[0].rank, 2);
  assert.equal(second.details.presentation.pageWindows[0].omitted_before, 1);
  assert.doesNotMatch(second.content[0].text, /title: Guide metadata|description: Shared context for this file/);
  assert.equal(frontmatterExposureState.seenPaths.size, 1, "unchanged frontmatter remains committed once across result pages");
  const readAfterSearch = await readTool.execute("docs-public-read", { path: "docs/guide.md:guide/beta#2" }, undefined, undefined, { cwd: root });
  assert.doesNotMatch(readAfterSearch.content[0].text, /title: Guide metadata|description: Shared context for this file/);
  await writeFile(join(root, "docs", "guide.md"), "---\ntitle: Guide metadata changed\ndescription: Shared context for this file.\ntags: [guide]\ncode:\n  - target.ts::work\nrelated:\n  - docs/related.md::related/#1\n  - docs/missing.md\n---\n# Guide\n\n## Alpha\n\nShared paging marker alpha.\n\n## Beta\n\nShared paging marker beta.\n");
  const readAfterMetadataChange = await readTool.execute("docs-public-read-changed", { path: "docs/guide.md:guide/beta#2" }, undefined, undefined, { cwd: root });
  assert.match(readAfterMetadataChange.content[0].text, /2:title: Guide metadata changed/);
  const large = await tool.execute("docs-public-large", { query: "large marker answer", path: "docs/large.md", limit: 1 }, undefined, undefined, { cwd: root });
  assert.match(large.content[0].text, /2:title: Large guide\n3:description: Compact QMD fallback\./);
  assert.doesNotMatch(large.content[0].text, /filler:/);
  assert.doesNotMatch(large.content[0].text, /Relationship selectors:/);
});

test("QMD projection uses pi-nav byte offsets and emits clean Unicode section snippets", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-docs-unicode-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), "# Préface 🚀\n\nUnicode introduction.\n\n## Query purity\n\nNavigation queries never mutate prepared indexes.\n");
  const options = { root, indexPath: join(root, "prepared-qmd"), repo: "local/unicode" };
  await syncQmdDocs(options);
  const searched = await searchDocsWithQmd("Query purity", options);
  assert.equal(searched.results[0].project_navigation.qmd.read_selector, "docs/guide.md:préface/query-purity#2");
  assert.match(searched.results[0].project_navigation.qmd.snippet, /^Navigation queries never mutate prepared indexes\./);
  assert.doesNotMatch(searched.results[0].project_navigation.qmd.snippet, /introduction|�/i);
});

test("QMD discovery honors project visibility instead of indexing ignored repository copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-docs-visibility-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "docs"));
  await mkdir(join(root, "ignored-copy"));
  await writeFile(join(root, ".gitignore"), "ignored-copy/\n");
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n\nCurrent project guidance.\n");
  await writeFile(join(root, "ignored-copy", "noise.md"), "# Noise\n\nIgnored upstream changelog noise.\n");
  const options = { root, indexPath: join(root, "prepared-qmd"), repo: "local/visibility" };
  const synced = await syncQmdDocs(options);
  assert.equal(synced.files, 1);
  const noise = await searchDocsWithQmd("ignored upstream changelog noise", options);
  assert.equal(noise.results.length, 0);
});

test("lexical QMD relaxes natural questions and ranks current authority above historical plans", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-docs-ranking-"));
  await mkdir(join(root, "docs", "plan"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "# Project notes\n\n## Required architecture\n\nPi-nav owns live Markdown parsing and current section authority.\n");
  await writeFile(join(root, "docs", "harness-doctrine.md"), "# Doctrine\n\n## Query-time purity and lifecycle ownership\n\nNavigation queries consume prepared evidence. They never rebuild indexes while answering a query.\n");
  await writeFile(join(root, "docs", "plan", "implementation.md"), "# Historical plan\n\n## Parser migration\n\nA plan once discussed who owns live Markdown parsing and current section authority.\n");
  const options = { root, indexPath: join(root, "prepared-qmd"), repo: "local/ranking" };
  await syncQmdDocs(options);
  const natural = await searchDocsWithQmd("Can navigation update an index while answering a query?", options);
  assert.equal(natural.results[0].project_navigation.qmd.read_selector, "docs/harness-doctrine.md:doctrine/query-time-purity-and-lifecycle-ownership#2");
  const ownership = await searchDocsWithQmd("who owns live Markdown parsing and current section authority?", options);
  assert.equal(ownership.results[0].doc_path, "AGENTS.md");
  assert.equal(ownership.results[0].authority_role, "current_authority");
  assert.ok(ownership.results[0].project_navigation.qmd.authority_prior > 0);
});

test("provider embedding degradation preserves lexical QMD retrieval", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-docs-provider-degraded-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n\n## Lexical fallback\n\nProvider-independent answer marker.\n");
  const options = {
    root,
    indexPath: join(root, "prepared-qmd"),
    repo: "local/degraded",
    apiKey: "test",
    fetchImpl: async () => new Response("provider unavailable", { status: 503 }),
  };

  const synced = await syncQmdDocs(options);
  assert.equal(synced.status, "lexical_ready");
  assert.equal(synced.semantic.status, "degraded");
  assert.ok(Number(synced.health.needsEmbedding) > 0);

  const searched = await searchDocsWithQmd("provider independent answer marker", options);
  assert.equal(searched.status, "lexical_ready");
  assert.equal(searched.semantic.status, "degraded");
  assert.equal(searched.results[0].project_navigation.qmd.read_selector, "docs/guide.md:guide/lexical-fallback#2");
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function response(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

test("QMD search never creates a missing index at query time", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-docs-missing-"));
  const indexPath = join(root, "prepared-qmd");
  const result = await searchDocsWithQmd("anything", { root, indexPath, repo: "local/missing" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.semantic.status, "unavailable");
  assert.equal(result.reason, "qmd_section_index_missing");
  assert.equal(existsSync(indexPath), false);
});

test("resolveProjectDocsContext shares docs_search config/provider policy without opening the index", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-docs-context-"));
  const writeConfig = (docs) => writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ docs }));
  // Disabled lane preserves error classification.
  await writeConfig({ enabled: false, backend: "qmd", repo: "local/x", root: ".", indexPath: ".pi/navigation/qmd" });
  assert.equal((await resolveProjectDocsContext(root, {})).reason, "docs_lane_disabled");
  // Obsolete backend / transport preserve classification.
  await writeConfig({ enabled: true, backend: "other", repo: "local/x", root: ".", indexPath: ".pi/navigation/qmd" });
  assert.equal((await resolveProjectDocsContext(root, {})).reason, "obsolete_docs_backend");
  await writeConfig({ enabled: true, backend: "qmd", repo: "local/x", root: ".", indexPath: ".pi/navigation/qmd", queryCommand: "qmd" });
  assert.equal((await resolveProjectDocsContext(root, {})).reason, "obsolete_docs_query_configuration");
  // Missing identity preserves classification.
  await writeConfig({ enabled: true, backend: "qmd", root: ".", indexPath: ".pi/navigation/qmd" });
  assert.equal((await resolveProjectDocsContext(root, {})).reason, "qmd_repository_identity_missing");
  // Ready context carries docsRoot + QMD options minus signal/pathHints, no index creation.
  await writeConfig({ enabled: true, backend: "qmd", repo: "local/ctx", root: "docs-root", indexPath: ".pi/navigation/qmd" });
  const ready = await resolveProjectDocsContext(root, {});
  assert.equal(ready.status, "ready");
  assert.equal(ready.docsRoot, join(root, "docs-root"));
  assert.equal(ready.options.root, join(root, "docs-root"));
  assert.equal(ready.options.repo, "local/ctx");
  assert.equal(ready.options.semanticProvider, undefined);
  assert.equal(existsSync(join(root, ".pi", "navigation", "qmd")), false);
  // local/ prefix is normalized exactly once.
  await writeConfig({ enabled: true, backend: "qmd", repo: "ctx2", root: ".", indexPath: ".pi/navigation/qmd" });
  assert.equal((await resolveProjectDocsContext(root, {})).options.repo, "local/ctx2");
});
