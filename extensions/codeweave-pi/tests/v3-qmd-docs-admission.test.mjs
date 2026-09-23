// Focused QMD docs admission controls: the policy census owns discovery, exact
// paths never bypass it, excluded cached documents are retired or withheld
// without opening their source, and QMD still answers for admitted documents.
// QMD identities stay relative to the configured docs root.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { createStore } from "../native/qmd/runtime/index.js";

import { searchDocsWithQmd, syncQmdDocs } from "../src/core/qmd-docs-search.ts";

const digest = value => createHash("sha256").update(value).digest("hex");
const slugify = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Deterministic census + supplied-source projection double with an optional
 *  hook that fires after the census reply (mid-pass policy change control). */
function docsCallNative(files, { independent = [], onCensus } = {}) {
  const reads = [];
  const census = { roots: [], files: [] };
  const callNative = async ({ root: nativeRoot, operation, args }) => {
    if (operation === "pi_nav_files") {
      const excluded = Array.isArray(args?.corpusPolicy?.excludedPrefixes) ? args.corpusPolicy.excludedPrefixes : [];
      const admitted = files.filter(file => !excluded.some(prefix => file === prefix || file.startsWith(`${prefix}/`))
        && !independent.some(prefix => file.startsWith(`${prefix}/`)));
      census.roots.push(nativeRoot);
      census.files.push(admitted);
      onCensus?.();
      return { structured: { data: { corpusPolicyVersion: 1, root: nativeRoot, files: admitted, directories: [] }, completeness: { complete: true } } };
    }
    assert.equal(operation, "pi_nav_read");
    assert.ok(args.capturedSource && typeof args.capturedSource.text === "string", "projection must use admitted supplied source");
    const text = args.capturedSource.text;
    reads.push({ path: String(args.path), text });
    const heading = text.match(/^(#{1,6})\s+(.+)$/m);
    const sections = heading ? [{
      selector: `${slugify(heading[2])}#${heading[1].length}`,
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
  return Object.assign(callNative, { reads, census });
}

/** Local-inference double that records every text it is asked to embed/rerank. */
function recordingLlm() {
  const embedded = [];
  const reranked = [];
  return {
    embedded, reranked,
    embedModelName: "admission-embed",
    generateModelName: "admission-generate",
    rerankModelName: "admission-rerank",
    async embed(text) { embedded.push(String(text)); return { embedding: [1, 0, 0], model: this.embedModelName }; },
    async embedBatch(texts) { for (const text of texts) embedded.push(String(text)); return texts.map(() => ({ embedding: [1, 0, 0], model: this.embedModelName })); },
    async generate() { return null; },
    async expandQuery() { return []; },
    async rerank(query, documents) { reranked.push({ query, documents: documents.map(document => String(document.text ?? document)) }); return { model: this.rerankModelName, results: documents.map((document, index) => ({ file: document.file, index, score: index === 0 ? 0.95 : 0.7 })) }; },
    async modelExists(model) { return { name: model, exists: true }; },
    async dispose() {},
  };
}

// Project-root-relative file locations and docs-root-relative QMD identities.
const PROJECT = { public: "docs/public.md", secret: "docs/private/secret.md", child: "docs/nested/child.md", plan: "docs/plan/impl.md" };
const DOC = { public: "public.md", secret: "private/secret.md", child: "nested/child.md", plan: "plan/impl.md" };
const BODY = {
  public: "## Portable answer\n\npublic-marker-body\n",
  secret: "## Hidden answer\n\nsecret-marker-body\n",
  child: "## Nested answer\n\nchild-marker-body\n",
  plan: "## Historical answer\n\nplan-marker-body\n",
};

function fixture({ exclude = ["docs/private"] } = {}) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "qmd-admission-")));
  const docsRoot = join(projectRoot, "docs");
  mkdirSync(join(docsRoot, "private"), { recursive: true });
  mkdirSync(join(docsRoot, "nested"), { recursive: true });
  mkdirSync(join(docsRoot, "plan"), { recursive: true });
  for (const name of ["public", "secret", "child", "plan"]) writeFileSync(join(projectRoot, PROJECT[name]), BODY[name]);
  writeFileSync(join(docsRoot, "nested", ".pi-navigation.json"), '{"architecture":false}\n');
  const writePolicy = excluded => writeFileSync(join(projectRoot, ".pi-navigation.json"), JSON.stringify({
    docs: { enabled: true, backend: "qmd", repo: "local/admission", root: "docs", indexPath: ".pi/navigation/qmd" },
    ...(excluded ? { scope: { exclude: excluded } } : {}),
  }));
  writePolicy(exclude);
  const indexPath = join(projectRoot, ".pi", "navigation", "qmd");
  const repo = "local/admission";
  const indexFile = join(indexPath, `${digest(repo).slice(0, 20)}.sqlite`);
  const files = [PROJECT.public, PROJECT.secret, PROJECT.child, PROJECT.plan];
  const options = (callNative, llm = recordingLlm()) => ({ root: docsRoot, projectRoot, indexPath, repo, callNative, semanticProvider: "local", llm });
  return { projectRoot, docsRoot, indexPath, indexFile, files, writePolicy, options,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

function forbidSourceOpens(t, paths) {
  const original = fs.openSync;
  let attempts = 0;
  fs.openSync = (path, ...args) => {
    if (paths.includes(String(path))) { attempts++; throw new Error('Excluded source was opened'); }
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.openSync = original; syncBuiltinESMExports(); assert.equal(attempts, 0); });
}

test("docs admission roots discovery at the owning project and excludes private/independent-child documents", async t => {
  const f = fixture();
  try {
    const callNative = docsCallNative(f.files, { independent: ["docs/nested"] });
    forbidSourceOpens(t, [PROJECT.secret, PROJECT.child].map(path => join(f.projectRoot, path)));
    const synced = await syncQmdDocs(f.options(callNative));
    assert.equal(synced.files, 2, "only public.md and plan/impl.md are admitted");
    assert.equal(callNative.census.roots[0], f.projectRoot, "census must use the owning project root, not the docs subfolder");
    assert.deepEqual([...new Set(callNative.reads.map(read => read.path))].sort(), [DOC.plan, DOC.public]);
    assert.ok(callNative.reads.every(read => read.text.length > 0));

    const llm = recordingLlm();
    const secrets = await searchDocsWithQmd("secret marker body", f.options(callNative, llm));
    assert.equal(secrets.results.some(result => result.doc_path === DOC.secret), false, "excluded documents must not be retrievable");
    assert.equal(secrets.results.some(result => `${result.title ?? ""} ${result.section_id ?? ""}`.includes("Hidden")), false);
    assert.ok(llm.embedded.every(text => !text.includes("secret-marker-body")));
    assert.ok(!callNative.reads.some(read => read.path === DOC.secret), "a query must not open excluded source either");

    const publicAnswer = await searchDocsWithQmd("public marker body", f.options(callNative));
    assert.equal(publicAnswer.results[0].doc_path, DOC.public);
    assert.equal(publicAnswer.results[0].project_navigation.qmd.read_selector, `${DOC.public}:portable-answer#2`);
    assert.equal(publicAnswer.results[0].content_hash, digest(Buffer.from(BODY.public, "utf8")));
  } finally { f.cleanup(); }
});

test("exact refresh retires excluded cached sections without opening their source", async t => {
  const f = fixture();
  try {
    const first = docsCallNative(f.files, { independent: ["docs/nested"] });
    assert.equal((await syncQmdDocs(f.options(first))).files, 2);
    const indexed = await searchDocsWithQmd("plan marker body", f.options(first));
    assert.equal(indexed.results[0].doc_path, DOC.plan);

    f.writePolicy(["docs/private", "docs/plan"]);
    forbidSourceOpens(t, [join(f.projectRoot, PROJECT.plan)]);
    const exact = docsCallNative(f.files, { independent: ["docs/nested"] });
    const refreshed = await syncQmdDocs({ ...f.options(exact), paths: [DOC.plan] });
    assert.ok(Number(refreshed.removed) >= 1, "exact refresh must retire the newly excluded document");
    assert.ok(!exact.reads.some(read => read.path === DOC.plan), "retirement must not open excluded source");

    const retired = await searchDocsWithQmd("plan marker body", f.options(exact));
    assert.equal(retired.results.some(result => result.doc_path === DOC.plan), false, "retired documents must not be retrievable");
    const publicAnswer = await searchDocsWithQmd("public marker body", f.options(exact));
    assert.equal(publicAnswer.results[0].doc_path, DOC.public, "admitted documents keep working after retirement");
  } finally { f.cleanup(); }
});

test("query withholds QMD before excluded cached bodies reach inference, leaving the store unchanged", async () => {
  const f = fixture();
  try {
    assert.equal((await syncQmdDocs(f.options(docsCallNative(f.files, { independent: ["docs/nested"] })))).files, 2);
    const before = statSync(f.indexFile, { bigint: true });
    const beforeHash = digest(readFileSync(f.indexFile));
    f.writePolicy(["docs/private", "docs/plan"]);
    const llm = recordingLlm();
    const callNative = docsCallNative(f.files, { independent: ["docs/nested"] });
    const withheld = await searchDocsWithQmd("plan marker body", f.options(callNative, llm));
    assert.equal(withheld.status, "unavailable");
    assert.equal(withheld.reason, "qmd_docs_refresh_required");
    assert.equal(withheld.results.length, 0);
    assert.equal(llm.embedded.length + llm.reranked.length, 0, "no inference may run before the admission check");
    assert.ok(!callNative.reads.some(read => read.path === DOC.plan));
    const after = statSync(f.indexFile, { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs, "a withheld query must not write the store");
    assert.equal(after.size, before.size);
    assert.equal(digest(readFileSync(f.indexFile)), beforeHash);
  } finally { f.cleanup(); }
});

test("a policy change during a maintenance pass refuses before publication", async () => {
  const f = fixture();
  try {
    const changed = docsCallNative(f.files, {
      independent: ["docs/nested"],
      onCensus: () => f.writePolicy(["docs/private", "docs/plan"]),
    });
    await assert.rejects(() => syncQmdDocs(f.options(changed)), /policy changed/i);
    assert.equal(existsSync(f.indexFile), false, "a refused pass must not publish a store");
    const recovered = await syncQmdDocs(f.options(docsCallNative(f.files, { independent: ["docs/nested"] })));
    assert.equal(recovered.files, 1, "recovery with current admission excludes the newly excluded document");
    const answer = await searchDocsWithQmd("public marker body", f.options(docsCallNative(f.files, { independent: ["docs/nested"] })));
    assert.equal(answer.results[0].doc_path, DOC.public);
    assert.equal(answer.results.some(result => result.doc_path === DOC.plan), false);
  } finally { f.cleanup(); }
});

test('policy change during embedding cannot report maintenance ready', async () => {
  const f = fixture();
  try {
    const native = docsCallNative(f.files, { independent: ['docs/nested'] });
    const llm = recordingLlm();
    const embed = llm.embedBatch.bind(llm);
    let changed = false;
    llm.embedBatch = async texts => {
      changed = true;
      f.writePolicy(['docs/private', 'docs/plan']);
      return embed(texts);
    };
    await assert.rejects(() => syncQmdDocs(f.options(native, llm)), /policy changed/i);
    assert.equal(changed, true);
  } finally { f.cleanup(); }
});

test("changed source bytes are not served from a stale admitted projection", async () => {
  const f = fixture();
  try {
    const callNative = docsCallNative(f.files, { independent: ["docs/nested"] });
    await syncQmdDocs(f.options(callNative));
    writeFileSync(join(f.projectRoot, PROJECT.public), "# Public\n\n## Portable answer\n\nchanged-body-marker\n");
    const stale = await searchDocsWithQmd("public marker body", f.options(callNative));
    assert.equal(stale.results.some(result => result.doc_path === DOC.public), false, "indexed section must not survive changed bytes");
    assert.ok(readFileSync(join(f.projectRoot, PROJECT.public), "utf8").includes("changed-body-marker"));
  } finally { f.cleanup(); }
});

for (const stage of ['embedBatch', 'dispose']) test(`policy revocation during ${stage} withholds the reply without mutating the store`, async () => {
  const f = fixture();
  try {
    const native = docsCallNative(f.files, { independent: ['docs/nested'] });
    await syncQmdDocs(f.options(native));
    native.reads.length = 0;
    const before = digest(readFileSync(f.indexFile));
    const llm = recordingLlm();
    const invoke = llm[stage].bind(llm);
    let revoked = false;
    llm[stage] = async (...args) => {
      revoked = true;
      f.writePolicy(['docs/private', 'docs/plan']);
      return invoke(...args);
    };
    const answer = await searchDocsWithQmd('zqxwv', f.options(native, llm));
    assert.equal(revoked, true);
    assert.equal(answer.reason, 'qmd_docs_refresh_required');
    assert.deepEqual(answer.results, []);
    if (stage === 'embedBatch') assert.ok(!native.reads.some(read => read.path === DOC.plan));
    assert.equal(digest(readFileSync(f.indexFile)), before);
  } finally { f.cleanup(); }
});

test("query admission and provider retrieval share one SQLite snapshot", async () => {
  const f = fixture();
  try {
    const native = docsCallNative(f.files, { independent: ["docs/nested"] });
    await syncQmdDocs(f.options(native));
    const llm = recordingLlm();
    const originalEmbed = llm.embedBatch.bind(llm);
    const originalRerank = llm.rerank.bind(llm);
    let inserted = false;
    const providerPaths = [];
    llm.embedBatch = async texts => {
      if (!inserted) {
        inserted = true;
        const writer = await createStore({ dbPath: f.indexFile, llm: recordingLlm() });
        try {
          const now = new Date().toISOString();
          const body = 'File: private/secret.md\nAuthority role: current_authority\nSection: Hidden answer\n\nsecret-marker-body';
          const hash = digest(body);
          writer.internal.insertContent(hash, body, now);
          writer.internal.insertDocument('docs', 'sections/private%2Fsecret.md@hidden-answer%232.md', 'Hidden answer', hash, now, now);
          await writer.embed({ collection: 'docs', chunkStrategy: 'regex' });
          assert.equal(writer.internal.db.prepare('SELECT count(*) AS n FROM content_vectors WHERE hash=?').get(hash).n, 1);
        } finally { await writer.close(); }
      }
      return originalEmbed(texts);
    };
    llm.rerank = async (query, documents) => {
      providerPaths.push(...documents.map(document => document.file));
      return originalRerank(query, documents);
    };
    const answer = await searchDocsWithQmd('zqxwv', f.options(native, llm));
    assert.equal(inserted, true, 'concurrent writer control must execute');
    assert.ok(providerPaths.length > 0, 'provider must receive the admitted snapshot');
    assert.ok(providerPaths.every(path => !/private|secret/i.test(path)));
    assert.ok(answer.results.some(result => result.doc_path === DOC.public));
    const next = await searchDocsWithQmd('public marker body', f.options(native));
    assert.equal(next.reason, 'qmd_docs_refresh_required', 'a new query sees and refuses the changed store');
  } finally { f.cleanup(); }
});
