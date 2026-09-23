import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { deriveAnalysisProject } from "../src/core/analysis-project.mjs";
import { MAINTENANCE_REVISION, MAINTENANCE_STATUS_FILE } from "../native/analysis/identity.mjs";
import { nativeToolResult, stripPrivateEvidence } from "../src/core/harness-result.ts";
import { isCertifiableLiveSourceRow } from "../src/core/live-source-evidence.ts";
import { renderNativeResult, selectAuthorityLeads } from "../src/core/navigation-clean.ts";
import { certifyExactLeads, certifySourceAuthority, prepareExactLeads, prepareSourceAuthority } from "../src/core/source-authority.ts";
import { applyPatch as applyPatchResult } from "../src/core/patch-apply.ts";
import { renderRead } from "../src/core/read-renderer.ts";
import { snapshots } from "../src/core/snapshot-store.ts";
import { registerGrepTool } from "../src/tools/grep.ts";
import { registerTraceTool } from "../src/tools/trace.ts";
const applyPatch = async params => (await applyPatchResult(params)).text;

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-edit-ready-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "sample.ts"), [
    "export function first() {",
    "  return 'one';",
    "}",
    "",
    "export function second() {",
    "  return 'two';",
    "}",
    "",
  ].join("\n"));
  return cwd;
}
function nativeOutput(operation, text, data, completeness = { complete: true, returned: 1, total: 1, omitted: 0 }, sourceSnapshots) {
  return { text, structured: { schemaVersion: 1, operation, data, completeness, diagnostics: [] }, sourceSnapshots };
}
async function sourceSnapshot(cwd, relativePath) {
  const canonicalPath = await realpath(join(cwd, relativePath));
  const text = await readFile(canonicalPath, "utf8");
  return {
    canonicalPath,
    text,
    rawDigest: createHash("sha256").update(text).digest("hex").toUpperCase(),
    lineEnding: text.includes("\r\n") ? "crlf" : "lf",
    bom: text.startsWith("\ufeff"),
  };
}


test("R3 evidence-shape fixture distinguishes displayed rows, locators, stale/transformed content, and private proof", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/r3-prepared-evidence-cases.json", import.meta.url), "utf8"));
  const shapes = new Map(fixture.sourceShapes.map(item => [item.name, item]));
  assert.equal(isCertifiableLiveSourceRow(shapes.get("displayed_current")), true);
  assert.equal(isCertifiableLiveSourceRow(shapes.get("transformed")), false);
  assert.equal(isCertifiableLiveSourceRow(shapes.get("clipped")), false);
  for (const name of ["pure_location", "stale_index", "historical_removal", "unsupported_binary", "external_location", "private_proof"]) {
    assert.equal(isCertifiableLiveSourceRow(shapes.get(name)), false, name);
  }
});

test("private proof fields are recursively absent from model text and persisted native details", () => {
  const native = {
    summary: "safe",
    nested: {
      relationship_edges: [{ kind: "CALLS", raw_digest: "A".repeat(64), file_hash: "b".repeat(64) }],
      source_claims: [{ path: "src/a.ts", raw_digest: "C".repeat(64) }],
      sourceSnapshots: [{ text: "secret proof bytes", rawDigest: "D".repeat(64) }],
      future_native_metadata: { retained: true },
      future_source_blob: { source_snippet: "future private source", proof_payload: "future proof bytes" },
    },
  };
  const safe = stripPrivateEvidence(native);
  const serialized = JSON.stringify(safe);
  assert.match(serialized, /relationship_edges|CALLS|safe|future_native_metadata|retained/);
  assert.doesNotMatch(serialized, /source_claims|sourceSnapshots|raw_digest|file_hash|source_snippet|proof_payload|future private source|future proof bytes|secret proof bytes|[A-D]{64}/);

  const rendered = renderNativeResult("Prepared", native, []);
  assert.match(rendered, /relationship_edges|CALLS|safe|future_native_metadata|retained/);
  assert.doesNotMatch(rendered, /source_claims|sourceSnapshots|raw_digest|file_hash|source_snippet|proof_payload|future private source|future proof bytes|secret proof bytes|[A-D]{64}/);

  const result = nativeToolResult("safe model text", native, { status: "success", summary: "ok", next_actions: [], artifacts: [] }, { nested: native });
  const persisted = JSON.stringify(result.details);
  assert.match(persisted, /relationship_edges|CALLS|safe|future_native_metadata|retained/);
  assert.doesNotMatch(persisted, /source_claims|sourceSnapshots|raw_digest|file_hash|source_snippet|proof_payload|future private source|future proof bytes|secret proof bytes|[A-D]{64}/);
});
test("typed live-source evidence certifies only visible verbatim rows and preserves native bytes", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const nativeText = "NATIVE OUTPUT\nrank=1 score=0.99";
  const evidence = [{
    path: "src/sample.ts",
    provenance: { capability: "fixture", backend: "native", route: "typed" },
    rows: [
      { line: 1, text: "export function first() {", visibility: "visible_complete", transformation: "verbatim" },
      { line: 2, text: "  return 'one';", visibility: "visible_complete", transformation: "transformed" },
      { line: 3, text: "}", visibility: "hidden", transformation: "verbatim" },
      { line: 5, text: "export function second() {", visibility: "clipped", transformation: "verbatim" },
    ],
  }, {
    path: "./src/sample.ts",
    provenance: { capability: "fixture", backend: "native", route: "alias" },
    rows: [{ line: 5, text: "export function second() {", visibility: "visible_complete", transformation: "verbatim" }],
  }];
  const result = await certifySourceAuthority({ cwd, nativeText, evidence, sourceSnapshots: [await sourceSnapshot(cwd, "src/sample.ts")] });
  assert.ok(result.text.startsWith(`${nativeText}\n\nLive source authority\n`));
  assert.match(result.text, /\[src\/sample\.ts#[0-9A-F]{8}\] lines 1,5[\s\S]*Source handoff: partial authority/);
  assert.equal(result.rejectedRows, 3);
  assert.equal(result.authorities.length, 1, "canonical path aliases must share one file read/hash authority");
  assert.equal(result.authorities[0].evidence.provenance.capability, "fixture");
  assert.match(result.authorities[0].evidence.wholeFileDigest, /^[0-9A-F]{64}$/);
  assert.ok(result.authorities[0].evidence.canonicalPath.endsWith("/src/sample.ts"));
  const tag = result.authorities[0].tag;
  assert.match(await applyPatch({ cwd, patch: `[src/sample.ts#${tag}]\nREPLACE 2:\n+  return 'changed';` }), /Held remaining change/);
});
test("source authority uses one native proof call per file set and reuses attached snapshots", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const proof = await sourceSnapshot(cwd, "src/sample.ts");
  const evidence = [{ path: "src/sample.ts", provenance: { capability: "fixture", backend: "native" }, rows: [{ line: 1, text: "export function first() {", visibility: "visible_complete", transformation: "verbatim" }] }];
  let calls = 0;
  const callNative = async input => {
    calls++;
    assert.equal(input.operation, "pi_nav_source_proof");
    return nativeOutput("pi_nav_source_proof", "", { files: [{ path: "src/sample.ts", status: "proven" }] }, undefined, [proof]);
  };
  const fetched = await certifySourceAuthority({ cwd, nativeText: "native", evidence, callNative });
  assert.equal(fetched.certified, true);
  assert.equal(calls, 1);
  const reused = await certifySourceAuthority({ cwd, nativeText: "native", evidence, sourceSnapshots: [proof], callNative: async () => { throw new Error("unexpected reread"); } });
  assert.equal(reused.certified, true);
  assert.equal(calls, 1);
  assert.throws(() => snapshots.recordTrustedProof(proof.canonicalPath, proof.text, "0".repeat(64), [1]), /digest mismatch/);
});


test("source proof batches preserve supplied evidence, isolate rejected files and abort before granting authority", async t => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  for (const abort of [false, true]) {
    const cwd = await fixture();
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const paths = Array.from({ length: 65 }, (_, index) => `src/proof-${index}.ts`);
    await Promise.all(paths.map(path => writeFile(join(cwd, path), "export const value = 1;\n")));
    const proofs = await Promise.all(paths.map(path => sourceSnapshot(cwd, path)));
    const evidence = paths.map(path => ({ path, provenance: { capability: "fixture", backend: "native" },
      rows: [{ line: 1, text: "export const value = 1;", visibility: "visible_complete", transformation: "verbatim" }] }));
    if (!abort) {
      await writeFile(join(cwd, paths[63]), "export const value = 2;\n");
      proofs[63] = await sourceSnapshot(cwd, paths[63]);
    }
    const controller = new AbortController(), calls = [];
    const pending = certifySourceAuthority({ cwd, nativeText: "all 65 source rows remain live", evidence,
      sourceSnapshots: proofs.slice(0, 32), signal: controller.signal,
      callNative: async request => {
        calls.push(request);
        assert.equal(request.operation, "pi_nav_source_proof");
        assert.ok(request.args.paths.length <= 32);
        assert.ok(request.args.paths.every(path => !proofs.slice(0, 32).some(proof => proof.canonicalPath === path)), "supplied snapshots must not be reread");
        clock += 5_000;
        if (abort) controller.abort();
        return nativeOutput("pi_nav_source_proof", "", {}, undefined,
          proofs.filter((proof, index) => request.args.paths.includes(proof.canonicalPath) && index !== 64));
      },
    });
    if (abort) {
      await assert.rejects(pending, { name: "AbortError" });
      assert.equal(calls.length, 1, "an aborted proof must not request the next batch");
      assert.ok(proofs.every(proof => snapshots.head(proof.canonicalPath) === undefined), "unfinished proof must not grant supplied or first-batch authority");
    } else {
      const result = await pending;
      assert.deepEqual(calls.map(call => call.args.paths.length), [32, 1]);
      assert.deepEqual(calls.map(call => call.timeoutMs), [25_000, 20_000]);
      assert.equal(result.authorities.length, 63);
      assert.equal(result.rejectedRows, 2, "changed row and unavailable file remain uncertified");
      assert.ok(result.text.startsWith("all 65 source rows remain live\n"));
      assert.ok(proofs.slice(0, 63).every(proof => snapshots.head(proof.canonicalPath)?.seenLines.has(1)));
      assert.ok(proofs.slice(63).every(proof => snapshots.head(proof.canonicalPath) === undefined));
    }
  }
});

test("ranked fitting stages source and exact-lead authority until the accepted composition commits", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "src/sample.ts");
  // Preview and commit must retain the existing normalized hash meaning.
  await writeFile(path, "\ufeff" + (await readFile(path, "utf8")).replaceAll("\n", "\r\n"));
  const proof = await sourceSnapshot(cwd, "src/sample.ts");
  const evidence = [{ path: "src/sample.ts", provenance: { capability: "fixture", backend: "native" },
    rows: [{ line: 1, text: "export function first() {", visibility: "visible_complete", transformation: "verbatim" }] }];
  const discarded = await prepareSourceAuthority({ cwd, nativeText: "discarded", evidence, sourceSnapshots: [proof] });
  assert.equal(discarded.certified, true);
  assert.equal(snapshots.head(proof.canonicalPath), undefined, "preview must not authorize withheld rows");
  const accepted = await prepareSourceAuthority({ cwd, nativeText: "accepted", evidence: [{ ...evidence[0],
    rows: [{ line: 5, text: "export function second() {", visibility: "visible_complete", transformation: "verbatim" }] }], sourceSnapshots: [proof] });
  accepted.commit();
  assert.deepEqual([...snapshots.head(proof.canonicalPath).seenLines], [5]);
  assert.equal(accepted.authorities[0].tag, snapshots.head(proof.canonicalPath).tag);
  assert.equal(discarded.authorities[0].tag, accepted.authorities[0].tag);
  const exact = await prepareExactLeads({ cwd, nativeText: "candidate", leads: [{ path: "src/sample.ts", start: 1, end: 3 }],
    callNative: async () => nativeOutput("pi_nav_source_proof", "", {}, undefined, [proof]) });
  assert.ok(exact.promoted);
  assert.deepEqual([...snapshots.head(proof.canonicalPath).seenLines], [5], "expanded preview must not authorize withheld rows");
  exact.commit();
  assert.deepEqual([...snapshots.head(proof.canonicalPath).seenLines].sort(), [1, 2, 3, 5]);
  const controller = new AbortController();
  const aborted = await prepareSourceAuthority({ cwd, nativeText: "aborted", evidence: [{ ...evidence[0],
    rows: [{ line: 6, text: "  return 'two';", visibility: "visible_complete", transformation: "verbatim" }] }],
    sourceSnapshots: [proof], signal: controller.signal });
  controller.abort();
  assert.throws(() => aborted.commit(), { name: "AbortError" });
  assert.equal(snapshots.head(proof.canonicalPath).seenLines.has(6), false);
});

test("native proof expansion preserves native output and mints standalone read authority", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const nativeText = "Native relationship rows\nscore=0.92";
  const promoted = await certifyExactLeads({
    cwd,
    nativeText,
    leads: [
      { path: "src/sample.ts", start: 1, end: 3, label: "first" },
      { path: "src/sample.ts", start: 5, end: 7, label: "second" },
    ],
  });
  assert.equal(promoted.promoted, true, promoted.text);
  assert.ok(promoted.text.startsWith(`${nativeText}\n\nExpanded live source\n`));
  assert.deepEqual(promoted.selectors, ["src/sample.ts:1-3,5-7"]);

  const standalone = await renderRead({ cwd, path: "src/sample.ts:1-3,5-7" });
  const tag = /#([0-9A-F]{8})\]/.exec(promoted.artifacts[0])?.[1];
  assert.equal(tag, standalone.tag);
  assert.ok(tag);
  await applyPatch({ cwd, patch: `[src/sample.ts#${tag}]\nREPLACE 2:\n+  return 'ONE';` });
  assert.match(await readFile(join(cwd, "src", "sample.ts"), "utf8"), /return 'ONE'/);
});

test("native proof expansion groups duplicate ranges, enforces caps, and preserves independent file success", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const grouped = await certifyExactLeads({
    cwd,
    nativeText: "native",
    leads: [
      { path: "src/sample.ts", start: 1, end: 2, label: "first" },
      { path: "src/sample.ts", start: 2, end: 3, label: "first" },
    ],
  });
  assert.equal(grouped.promoted, true);
  assert.deepEqual(grouped.selectors, ["src/sample.ts:1-3"]);
  await writeFile(join(cwd, "src", "sample.ts"), Array.from({ length: 13 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");

  const over = await certifyExactLeads({
    cwd,
    nativeText: "native",
    leads: Array.from({ length: 13 }, (_, index) => ({ path: "src/sample.ts", start: index + 1, end: index + 1, label: `row-${index}` })),
  });
  assert.equal(over.promoted, true);
  assert.match(over.reason, /1 exact source claim.*12-range visible proof limit/i);
  assert.match(over.text, /\[src\/sample\.ts#[A-F0-9]{8}\]/);
  assert.match(over.text, /12:line 12/);
  assert.doesNotMatch(over.text, /13:line 13/);

  await writeFile(join(cwd, "src", "valid.ts"), "export const valid = true;\n");
  await writeFile(join(cwd, "src", "stale.ts"), "export const stale = true;\n");
  const validSnapshot = await sourceSnapshot(cwd, "src/valid.ts");
  const partial = await certifyExactLeads({
    cwd,
    nativeText: "prepared relationship evidence remains",
    leads: [
      { path: "src/valid.ts", start: 1, end: 1, label: "direct target" },
      { path: "src/stale.ts", start: 1, end: 1, label: "stale target" },
    ],
    expectedRawDigests: {
      "src/valid.ts": validSnapshot.rawDigest,
      "src/stale.ts": "A".repeat(64),
    },
    requireVersion: true,
  });
  assert.equal(partial.promoted, true);
  assert.match(partial.text, /^prepared relationship evidence remains/);
  assert.match(partial.text, /\[src\/valid\.ts#[A-F0-9]{8}\]/);
  assert.doesNotMatch(partial.text, /\[src\/stale\.ts#[A-F0-9]{8}\]/);
  assert.match(partial.reason, /1 exact source claim.*rejected/i);
});

test("visible authority selection excludes range-free locators and survives presentation truncation", () => {
  const rangeFree = selectAuthorityLeads([{ path: "src/sample.ts", start: 1, end: 80, label: "File", reason: "result referenced this file without exact range" }]);
  assert.deepEqual(rangeFree, []);
  const leads = Array.from({ length: 13 }, (_, index) => ({ path: "src/sample.ts", start: index + 1, end: index + 1, label: `row-${index + 1}` }));
  const selected = selectAuthorityLeads(leads);
  assert.equal(selected.length, 12);
  const rendered = renderNativeResult("Prepared", {
    results: leads.map(lead => ({ ...lead, summary: "x".repeat(100) })),
    project_navigation: { page_windows: [{ path: "results", page: 1, page_size: 13, total_count: 13, returned_count: 13 }] },
  }, selected, { maxNativeChars: 120, followUpSelectors: true });
  assert.match(rendered, /presentation truncated/);
  assert.match(rendered, /Exact follow-up selectors/);
  assert.match(rendered, /src\/sample\.ts:12(?:\n|$)/);
  assert.doesNotMatch(rendered, /src\/sample\.ts:13(?:\n|$)/);
});

test("native proof expansion rejects broad generic candidates and certifies explicit external rows", async t => {
  const cwd = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "pi-edit-ready-outside-"));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(outside, "outside.ts"), "export const outside = true;\n");

  const broad = await certifyExactLeads({ cwd, nativeText: "native", leads: [{ path: "src/sample.ts", start: 1, end: 80, label: "File" }] });
  assert.equal(broad.promoted, false);
  assert.match(broad.reason, /no exact source selector/);

  const external = await certifyExactLeads({ cwd, nativeText: "native", leads: [{ path: join(outside, "outside.ts"), start: 1, end: 1, label: "outside" }] });
  assert.equal(external.promoted, true);
  assert.match(external.text, /Expanded live source/);
});

test("prepared source claims fail closed when the indexed raw digest is stale", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const stale = await certifyExactLeads({
    cwd,
    nativeText: "prepared relationships remain authoritative",
    leads: [{ path: "src/sample.ts", start: 1, end: 3, label: "first" }],
    expectedRawDigests: { "src/sample.ts": "A".repeat(64) },
  });
  assert.equal(stale.promoted, false);
  assert.match(stale.reason, /indexed version is stale|could not be proven/);
  assert.equal(stale.text, "prepared relationships remain authoritative");
});

test("promoted hashes retain unseen-line rejection and conservative stale recovery", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const proof = await certifyExactLeads({ cwd, nativeText: "Native", leads: [{ path: "src/sample.ts", start: 1, end: 1, label: "first" }] });
  assert.deepEqual(proof.selectors, ["src/sample.ts:1-1"]);
  assert.doesNotMatch(proof.text, /2:  return 'one'/);
  const tag = /\[src\/sample\.ts#([0-9A-F]{8})\]/.exec(proof.text)?.[1];
  assert.ok(tag);
  assert.match(await applyPatch({ cwd, patch: `[src/sample.ts#${tag}]\nREPLACE 5:\n+export const unseen = true;` }), /Held remaining change/);
  const file = join(cwd, "src", "sample.ts");
  await writeFile(file, `// external header\n${await readFile(file, "utf8")}`);
  const recovered = await applyPatch({ cwd, patch: `[src/sample.ts#${tag}]\nREPLACE 1:\n+export function renamed() {` });
  assert.match(recovered, /Recovered external file drift by exact-context three-way merge with fuzz 0/);
  assert.match(await readFile(file, "utf8"), /^\/\/ external header\nexport function renamed\(\) \{/);
});

test("promoted delivered rows remain editable after full-text snapshot eviction", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let firstTag;
  for (let index = 0; index < 205; index++) {
    const path = `src/evict-${index}.ts`;
    await writeFile(join(cwd, path), `export const value${index} = ${index};\n`);
    const proof = await certifyExactLeads({ cwd, nativeText: "Native", leads: [{ path, start: 1, end: 1, label: `value${index}` }] });
    if (index === 0) firstTag = /#([0-9A-F]{8})\]/.exec(proof.artifacts[0] ?? "")?.[1];
  }
  assert.ok(firstTag);
  assert.equal(snapshots.byTag(await realpath(join(cwd, "src", "evict-0.ts")), firstTag), undefined);
  const result = await applyPatch({ cwd, patch: `[src/evict-0.ts#${firstTag}]\nREPLACE 1:\n+export const value0 = 99;` });
  assert.match(result, /Re-authorized .*previously delivered unchanged source/i);
  assert.equal(await readFile(join(cwd, "src", "evict-0.ts"), "utf8"), "export const value0 = 99;\n");
});

test("grep automatically certifies only complete typed pi-nav rows without duplicating source", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const proof = await sourceSnapshot(cwd, "src/sample.ts");
  const callNative = async () => nativeOutput("pi_nav_search", [
    "# Search: first — 1 match",
    "",
    "### src/sample.ts:1-3 [definition]",
    "   1 | export function first() {",
    "   3 | }",
  ].join("\n"), {
    sourceRows: [
      { path: "src/sample.ts", line: 1, text: "export function first() {", visibility: "visible_complete", transformation: "verbatim" },
      { path: "src/sample.ts", line: 3, text: "}", visibility: "visible_complete", transformation: "verbatim" },
    ],
    locations: [{ path: "src/sample.ts", start: 1, end: 3, role: "definition" }],
  }, undefined, [proof]);
  let registered;
  registerGrepTool({ registerTool(tool) { registered = tool; } }, { callNative });
  const execute = params => registered.execute("call", params, undefined, undefined, { cwd });
  const normalText = (await execute({ pattern: "first", syntax: "symbol", paths: cwd })).content[0].text;
  assert.match(normalText, /Live source authority\n\[src\/sample\.ts#([0-9A-F]{8})\] lines 1,3/);
  assert.equal((normalText.match(/export function first/g) ?? []).length, 1, "authority must not duplicate source already displayed by pi-nav");
  const tag = /\[src\/sample\.ts#([0-9A-F]{8})\]/.exec(normalText)?.[1];
  assert.ok(tag);
  await applyPatch({ cwd, patch: `[src/sample.ts#${tag}]\nREPLACE 1:\n+export function primary() {` });
  assert.match(await applyPatch({ cwd, patch: `[src/sample.ts#${tag}]\nREPLACE 2:\n+  return 'changed';` }), /Held remaining change|stale source could not be remapped safely/);
  assert.match((await execute({ pattern: "first", syntax: "symbol", paths: cwd, includeLiveSource: true })).content[0].text, /INVALID CALL: grep[\s\S]*(?:obsolete|includeLiveSource)/i);
});

test("external grep authority paths select the original file from the agent cwd", async t => {
  const cwd = await fixture();
  const origin = await realpath(await fixture());
  t.after(async () => { await rm(cwd, { recursive: true, force: true }); await rm(origin, { recursive: true, force: true }); });
  await writeFile(join(cwd, "src/sample.ts"), "wrong cwd file\n");
  const proof = await sourceSnapshot(origin, "src/sample.ts");
  for (const typed of [true, false]) {
    let proofCalls = 0;
    const callNative = async request => {
      assert.equal(request.root, origin, "proof must retain the original native session");
      if (request.operation === "pi_nav_source_proof") {
        proofCalls++;
        assert.equal(await realpath(resolve(request.root, request.args.paths[0])), proof.canonicalPath);
        return nativeOutput(request.operation, "", {}, undefined, [proof]);
      }
      const output = nativeOutput("pi_nav_search", "src/sample.ts:1 [definition]\n1:export function first() {", {
        matches: [{ location: { path: "src/sample.ts", start: 1, end: 1 }, role: "definition" }],
        ...(typed ? { sourceRows: [{ path: "src/sample.ts", line: 1, text: "export function first() {", visibility: "visible_complete", transformation: "verbatim" }] } : {}),
      });
      return { ...output, sourceRoot: origin };
    };
    let tool;
    registerGrepTool({ registerTool(value) { tool = value; } }, { callNative });
    const result = await tool.execute("external", { pattern: "first", syntax: "symbol", paths: origin }, undefined, undefined, { cwd });
    assert.equal(result.details.envelope.status, "success", result.content[0].text);
    assert.equal(proofCalls, 1);
    const path = /^\[(.+)#[0-9A-F]{8}\]$/.exec(result.details.envelope.artifacts[0])?.[1];
    assert.ok(path, "typed rows and exact-lead expansion must both return copyable authority");
    assert.equal(await realpath(resolve(cwd, path)), proof.canonicalPath);
    assert.equal(await readFile(resolve(cwd, path), "utf8"), proof.text);
  }
});

test("grep never certifies typed rows hidden by presentation truncation", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const proof = await sourceSnapshot(cwd, "src/sample.ts");
  const callNative = async () => nativeOutput("pi_nav_search", "### src/sample.ts:1-1 [visible]\n   1 | export function first() {\n...[truncated]", {
    sourceRows: [
      { path: "src/sample.ts", line: 1, text: "export function first() {", visibility: "visible_complete", transformation: "verbatim" },
      { path: "src/sample.ts", line: 5, text: "export function second() {", visibility: "hidden", transformation: "verbatim" },
    ],
  }, { complete: false, returned: 1, total: 2, omitted: 1, reason: "budget" }, [proof]);
  let registered;
  registerGrepTool({ registerTool(tool) { registered = tool; } }, { callNative });
  const text = (await registered.execute("call", { pattern: "functions", syntax: "symbol", paths: cwd }, undefined, undefined, { cwd })).content[0].text;
  assert.match(text, /Live source authority\n\[src\/sample\.ts#[0-9A-F]{8}\] lines 1/);
  assert.doesNotMatch(text, /lines [^\n]*5/);
});

test("grep removes includeLiveSource and automatically certifies real multi-file content rows", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "dir with space"), { recursive: true });
  await writeFile(join(cwd, "dir with space", "file name.ts"), "export const spaced = 'AUTO_PROOF_MULTI';\n");
  await writeFile(join(cwd, "src", "second.ts"), "export const second = 'AUTO_PROOF_MULTI';\n");
  let registered;
  registerGrepTool({ registerTool(tool) { registered = tool; } });
  const execute = params => registered.execute("call", params, undefined, undefined, { cwd });
  const content = await execute({ pattern: "AUTO_PROOF_MULTI", syntax: "literal", paths: cwd, output: "matches" });
  assert.match(content.content[0].text, /\[dir with space\/file name\.ts#[0-9A-F]{8}\]/);
  assert.match(content.content[0].text, /\[src\/second\.ts#[0-9A-F]{8}\]/);
  assert.equal(Object.hasOwn(content.details.native, "sourceSnapshots"), false, "proof payload must not persist in details.native");
  const firstTag = /\[dir with space\/file name\.ts#([0-9A-F]{8})\]/.exec(content.content[0].text)?.[1];
  const secondTag = /\[src\/second\.ts#([0-9A-F]{8})\]/.exec(content.content[0].text)?.[1];
  assert.ok(firstTag && secondTag);
  await applyPatch({
    cwd,
    patch: `[dir with space/file name.ts#${firstTag}]\nREPLACE 1:\n+export const spaced = 'BATCH_EDITED';\n\n[src/second.ts#${secondTag}]\nREPLACE 1:\n+export const second = 'BATCH_EDITED';`,
  });
  assert.match(await readFile(join(cwd, "dir with space", "file name.ts"), "utf8"), /BATCH_EDITED/);
  assert.match(await readFile(join(cwd, "src", "second.ts"), "utf8"), /BATCH_EDITED/);
  assert.match((await execute({ pattern: "AUTO_PROOF_MULTI", syntax: "literal", paths: cwd, output: "matches", includeLiveSource: true })).content[0].text, /INVALID CALL: grep[\s\S]*(?:obsolete|includeLiveSource)/i);
});



test("exact-lead coordinator canonicalizes aliases before file caps and hidden proof", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await symlink("sample.ts", join(cwd, "src", "sample-link.ts"));
  const proof = await sourceSnapshot(cwd, "src/sample.ts");
  let proofPaths;
  const result = await certifyExactLeads({
    cwd,
    nativeText: "aliases",
    leads: [
      { path: "src/sample.ts", start: 1, end: 1 },
      { path: "src/sample-link.ts", start: 2, end: 2 },
      { path: "./src/sample.ts", start: 3, end: 3 },
      { path: join(cwd, "src", "sample.ts"), start: 5, end: 5 },
    ],
    callNative: async request => {
      proofPaths = request.args.paths;
      return nativeOutput("pi_nav_source_proof", "", { files: [{ path: "src/sample.ts", status: "proven" }] }, undefined, [proof]);
    },
  });
  assert.equal(result.promoted, true);
  assert.equal(proofPaths.length, 1, "canonical aliases must use one hidden proof input");
  assert.equal(result.artifacts.length, 1, "canonical aliases must mint one authority identity");
  assert.equal((result.text.match(/\[src\/sample\.ts#[0-9A-F]{8}\]/g) ?? []).length, 1);
});
test("source-proof line and byte ceilings reject oversized promotion without hidden authority", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "src", "many.ts"), Array.from({ length: 401 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
  await writeFile(join(cwd, "src", "long.ts"), `${"x".repeat(97 * 1024)}\n`);
  let calls = 0;
  const tooMany = await certifyExactLeads({
    cwd,
    nativeText: "many",
    leads: [{ path: "src/many.ts", start: 1, end: 401 }],
    callNative: async () => { calls += 1; throw new Error("must not call proof beyond line ceiling"); },
  });
  assert.equal(tooMany.promoted, false);
  assert.equal(calls, 0);
  const longProof = await sourceSnapshot(cwd, "src/long.ts");
  const tooWide = await certifyExactLeads({
    cwd,
    nativeText: "long",
    leads: [{ path: "src/long.ts", start: 1, end: 1 }],
    callNative: async () => { calls += 1; return nativeOutput("pi_nav_source_proof", "", { files: [{ path: "src/long.ts", status: "proven" }] }, undefined, [longProof]); },
  });
  assert.equal(tooWide.promoted, false);
  assert.match(tooWide.reason ?? "", /96-KiB proof budget/i);
  assert.equal(snapshots.head(longProof.canonicalPath), undefined);
});

test("authority fails closed when a symlink target is replaced after proof", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "src", "target-a.ts"), "export const value = 'a';\n");
  await writeFile(join(cwd, "src", "target-b.ts"), "export const value = 'b';\n");
  await symlink("target-a.ts", join(cwd, "src", "current.ts"));
  const proof = await sourceSnapshot(cwd, "src/current.ts");
  const certified = await certifyExactLeads({
    cwd,
    nativeText: "prepared lead",
    leads: [{ path: "src/current.ts", start: 1, end: 1 }],
    callNative: async () => nativeOutput("pi_nav_source_proof", "", { files: [{ path: "src/current.ts", status: "proven" }] }, undefined, [proof]),
  });
  assert.equal(certified.promoted, true);
  const tag = snapshots.head(proof.canonicalPath)?.tag;
  assert.ok(tag);
  await unlink(join(cwd, "src", "current.ts"));
  await symlink("target-b.ts", join(cwd, "src", "current.ts"));
  const result = await applyPatch({ cwd, patch: `[src/current.ts#${tag}]\nREPLACE 1:\n+export const value = 'changed';` });
  assert.match(result, /snapshot|hash|stale|seen|Needs attention/i);
  assert.equal(await readFile(join(cwd, "src", "target-b.ts"), "utf8"), "export const value = 'b';\n");
});


test("grep refuses hidden proof for heterogeneous match shapes instead of dumping source", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let calls = 0;
  const callNative = async (_root, operation) => {
    calls += 1;
    assert.equal(operation, "pi_nav_search", "heterogeneous results must not trigger hidden source proof");
    return nativeOutput("pi_nav_search", "### src/sample.ts:1 [usage]\n### src/sample.ts:1-3 [definition]", {
      matches: [
        { location: { path: "src/sample.ts", start: 1, end: 1, role: "usage" }, role: "usage" },
        { location: { path: "src/sample.ts", start: 1, end: 3, role: "definition" }, role: "definition" },
      ],
      sourceRows: [],
    }, { complete: true, returned: 2, total: 2, omitted: 0 });
  };
  let registered;
  registerGrepTool({ registerTool(tool) { registered = tool; } }, { callNative });
  const result = await registered.execute("call", { pattern: "first", syntax: "auto", paths: cwd }, undefined, undefined, { cwd });
  assert.equal(calls, 1);
  assert.doesNotMatch(result.content[0].text, /Live source authority|Expanded live source/);
});
test("typed pi-nav trace rows receive zero-copy authority without a confirmation read", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const proof = await sourceSnapshot(cwd, "src/sample.ts");
  const calls = [];
  const callNative = async request => {
    calls.push(request.operation);
    return nativeOutput("pi_nav_search", "### src/sample.ts:1-1 [caller]\n   1 | export function first() {", {
      sourceRows: [{ path: "src/sample.ts", line: 1, text: "export function first() {", visibility: "visible_complete", transformation: "verbatim" }],
      locations: [{ path: "src/sample.ts", start: 1, end: 1, role: "caller" }],
    }, undefined, [proof]);
  };
  let registered;
  registerTraceTool({ registerTool(tool) { registered = tool; } }, { callNative });
  const result = await registered.execute("call", { target: "first", relation: "callers", scope: cwd }, undefined, undefined, { cwd });
  const text = result.content[0].text;
  assert.match(text, /Live source authority\n\[src\/sample\.ts#([0-9A-F]{8})\] lines 1/);
  assert.equal((text.match(/export function first/g) ?? []).length, 1);
  assert.equal(result.details.envelope.status, "success");
  // Zero-copy: the attached snapshot authorizes the tag, so exactly one native
  // relationship call happens and no confirmation read or proof request follows.
  assert.deepEqual(calls, ["pi_nav_search"]);
  const tag = /\[src\/sample\.ts#([0-9A-F]{8})\]/.exec(text)?.[1];
  assert.ok(tag);
  await applyPatch({ cwd, patch: `[src/sample.ts#${tag}]\nREPLACE 1:\n+export function traced() {` });
  assert.match(await readFile(join(cwd, "src/sample.ts"), "utf8"), /^export function traced/);
});


test("native trace preserves typed relationship evidence and bounded native-proven source across relations", async t => {
  const cwd = await fixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "tests"), { recursive: true });
  await writeFile(join(cwd, "src", "dep.ts"), "export const dep = 1;\n");
  await writeFile(join(cwd, "src", "importer.ts"), "import { first } from './sample.js';\n");
  await writeFile(join(cwd, "tests", "sample.test.ts"), "test('first', () => first());\n");

  // Typed native evidence only: locations + verbatim sourceRows, plus the same
  // attached snapshot packets the addon returns. No graph provider payload, no
  // provider-supplied hash enters model-facing relationship text.
  const calls = [];
  // `pi_nav_deps` carries only the target path, so the fixture recalls which
  // dependency direction the test asked for.
  let depsDirection = "imports";
  const callNative = async ({ root, operation, args }) => {
    calls.push(operation);
    if (operation === "pi_nav_source_proof") {
      const sourceSnapshots = await Promise.all(args.paths.map(async path => {
        const canonicalPath = isAbsolute(path) ? path : join(root, path);
        const text = await readFile(canonicalPath, "utf8");
        return { canonicalPath, text, rawDigest: createHash("sha256").update(text).digest("hex").toUpperCase(), lineEnding: "lf", bom: false };
      }));
      return { sourceSnapshots, structured: { data: {}, completeness: { complete: true }, diagnostics: [] } };
    }
    if (operation === "pi_nav_deps") {
      const dependent = depsDirection === "importers";
      const path = dependent ? "src/importer.ts" : "src/dep.ts";
      const line = dependent ? "import { first } from './sample.js';" : "export const dep = 1;";
      return { text: `### ${path}:1-1 [${dependent ? "dependent" : "dependency"}]\n   1 | ${line}`,
        structured: { data: {
          locations: [{ path: "src/sample.ts", start: 1, end: 6, role: "target" }, { path, start: 1, end: 1, role: dependent ? "dependent" : "dependency" }],
          relationships: [{ from: { path: "src/sample.ts" }, to: { path: "src/dep.ts" }, kind: "IMPORTS_FROM" }],
          sourceRows: [{ path, line: 1, text: line, visibility: "visible_complete", transformation: "verbatim" }],
        }, completeness: { complete: true }, diagnostics: [] } };
    }
    assert.equal(operation, "pi_nav_search");
    if (args.kind === "callers") {
      return { text: "### src/importer.ts:1-1 [caller]\n   1 | import { first } from './sample.js';",
        structured: { data: {
          locations: [{ path: "src/importer.ts", start: 1, end: 1, role: "caller" }],
          sourceRows: [{ path: "src/importer.ts", line: 1, text: "import { first } from './sample.js';", visibility: "visible_complete", transformation: "verbatim" }],
        }, completeness: { complete: true }, diagnostics: [] } };
    }
    return { text: "### tests/sample.test.ts:1-1 [file]\n   1 | test('first', () => first());",
      structured: { data: {
        locations: [{ path: "tests/sample.test.ts", start: 1, end: 1, role: "usage" }],
        sourceRows: [{ path: "tests/sample.test.ts", line: 1, text: "test('first', () => first());", visibility: "visible_complete", transformation: "verbatim" }],
      }, completeness: { complete: true }, diagnostics: [] } };
  };
  let registered;
  registerTraceTool({ registerTool(tool) { registered = tool; } }, { callNative });
  const execute = params => registered.execute("call", { ...params, scope: cwd }, undefined, undefined, { cwd });

  const callerText = (await execute({ target: "first", relation: "callers" })).content[0].text;
  assert.match(callerText, /Live source authority\n\[src\/importer\.ts#[0-9A-F]{8}\]/);

  depsDirection = "imports";
  const importsText = (await execute({ target: "src/sample.ts", relation: "imports" })).content[0].text;
  assert.match(importsText, /Selected native imports/);
  assert.match(importsText, /typed_dependency_direction=imports/, "preserve the typed dependency direction, not a provider payload shape");
  assert.match(importsText, /src\/dep\.ts:1/);
  assert.match(importsText, /Live source authority\n\[src\/dep\.ts#[0-9A-F]{8}\]/);

  depsDirection = "importers";
  const importersText = (await execute({ target: "src/sample.ts", relation: "importers" })).content[0].text;
  assert.match(importersText, /Selected native importers/);
  assert.match(importersText, /typed_dependency_direction=importers/);
  assert.match(importersText, /Live source authority\n\[src\/importer\.ts#[0-9A-F]{8}\]/);

  const testsText = (await execute({ target: "first", relation: "tests" })).content[0].text;
  assert.match(testsText, /Selected native tests/);
  assert.match(testsText, /typed_test_candidates=test_like_paths_only/);
  assert.match(testsText, /Live source authority\n\[tests\/sample\.test\.ts#[0-9A-F]{8}\]/);

  for (const text of [callerText, importsText, importersText, testsText]) {
    assert.doesNotMatch(text, /source_claims|raw_digest|[A-F0-9]{64}/, "provider hashes must not enter model-facing relationship text");
  }

  // Callees has no live structural owner: the honest answer is an explicit
  // unavailable, and it must not touch any backend to produce a zero.
  calls.length = 0;
  const calleesText = (await execute({ target: "first", relation: "callees" })).content[0].text;
  assert.match(calleesText, /UNAVAILABLE: native structural trace does not support relation "callees"/);
  assert.deepEqual(calls, [], "an unsupported relation must not query a backend");

  assert.match((await execute({ target: "first", relation: "callers", includeLiveSource: true })).content[0].text, /INVALID CALL: trace[\s\S]*(?:obsolete|includeLiveSource)/i);
});

test("indexed trace proves only the displayed page while hidden rows cannot exhaust authority", async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "pi-trace-paged-authority-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "source");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), "{}");
  const runId = "99999999-9999-4999-8999-999999999999";
  const statusDigest = "b".repeat(64);
  const nodes = [], edges = [], claims = [], files = [];
  for (let index = 1; index <= 15; index++) {
    const path = `src/visible-${index}.ts`;
    const text = `export const value${index} = ${index};\n`;
    await writeFile(join(root, path), text);
    files.push(path);
    nodes.push({ id: `n${index}`, kind: "function", name: `value${index}`, qualifiedName: path, filePath: path, startLine: 1, endLine: 1, depth: 1, isTestFile: false });
    edges.push({ id: index, source: `n${index}`, target: "n0", kind: "call", file_path: path, line: 1, column: 1, functionReference: false });
    claims.push({ path, raw_digest: createHash("sha256").update(text).digest("hex") });
  }
  await writeFile(join(root, "src", "target.ts"), "export function target() {}\n");
  files.push("src/target.ts");
  nodes.unshift({ id: "n0", kind: "function", name: "target", qualifiedName: "src/target.ts::target", filePath: "src/target.ts", startLine: 1, endLine: 1, depth: 0, isTestFile: false });

  const indexRoot = join(temporary, "indexes");
  const project = deriveAnalysisProject(root, indexRoot);
  await mkdir(project.directory, { recursive: true, mode: 0o700 });
  await writeFile(join(project.directory, "graph.sqlite"), "fixture reader owns validation", { mode: 0o600 });
  await writeFile(join(project.directory, MAINTENANCE_STATUS_FILE), "fixture reader owns validation", { mode: 0o600 });
  const automation = join(temporary, "automation.json");
  await writeFile(automation, JSON.stringify({ storage: { indexRoot } }));
  const previous = process.env.PI_NAV_AUTOMATION_CONFIG;
  process.env.PI_NAV_AUTOMATION_CONFIG = automation;
  t.after(() => { if (previous === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG; else process.env.PI_NAV_AUTOMATION_CONFIG = previous; });

  const callNative = async ({ root: nativeRoot, operation, args }) => {
    if (operation === "pi_nav_source_proof") {
      const sourceSnapshots = await Promise.all(args.paths.map(async rawPath => {
        const canonicalPath = isAbsolute(rawPath) ? rawPath : join(nativeRoot, rawPath);
        const text = await readFile(canonicalPath, "utf8");
        return { canonicalPath, text, rawDigest: createHash("sha256").update(text).digest("hex").toUpperCase(), lineEnding: "lf", bom: false };
      }));
      return { sourceSnapshots, structured: { data: {}, completeness: { complete: true }, diagnostics: [] } };
    }
    if (operation === "pi_nav_files") {
      return { text: "", structured: { schemaVersion: 1, operation: "pi_nav_files", data: { root: nativeRoot, corpusPolicyVersion: 1, files, directories: [""] }, completeness: { complete: true }, diagnostics: [] } };
    }
    assert.equal(operation, "pi_nav_search");
    return { text: "bounded indexed projection", structured: { schemaVersion: 1, operation: "pi_nav_search", data: {
      mode: "analysis_projection", operation: args.analysisProjection.operation, query: args.query, status: "ok",
      nodes, edges, candidates: [], roots: ["n0"], source_claims: claims, coverage: { complete: true },
      analysis: { indexedRunId: runId, indexedStatusDigest: statusDigest, interpretationRevision: MAINTENANCE_REVISION, policyDigest: args.analysisPolicyDigest, scope: "project", semanticStatus: "unavailable" },
    }, completeness: { complete: true }, diagnostics: [] }, sourceSnapshots: [] };
  };
  let registered;
  registerTraceTool({ registerTool(tool) { registered = tool; } }, { callNative });
  const result = await registered.execute("call", { target: "src/target.ts::target", relation: "callers", scope: root, page: 1, limit: 5 }, undefined, undefined, { cwd: root });
  const text = result.content[0].text;
  const tagged = text.match(/\[src\/visible-\d+\.ts#[0-9A-F]{8}\]/g) ?? [];
  assert.equal(tagged.length, 5, `only the displayed page may earn authority: ${text}`);
  for (let index = 1; index <= 5; index++) assert.match(text, new RegExp(`\\[src/visible-${index}\\.ts#[0-9A-F]{8}\\]`));
  assert.doesNotMatch(text, /\[src\/visible-(?:6|7|8|9|1[0-5])\.ts#[0-9A-F]{8}\]/);
  assert.doesNotMatch(text, /proof has \d+ ranges|limit is \d+/, "internal proof/limit vocabulary must not leak");
  assert.equal(result.details.envelope.artifacts.length, 5);
});
