import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { structuredMatchContext } from "../src/core/structured-match-context.ts";
import { registerGrepTool } from "../src/tools/grep.ts";
import { referenceTokenCount } from "../src/core/harness-result.ts";
import { snapshots, computeTag } from "../src/core/snapshot-store.ts";
import { certifySourceAuthority } from "../src/core/source-authority.ts";

function matchedRows(source, needle = "needle") {
  return source.replaceAll("\r\n", "\n").split("\n").flatMap((text, index) => {
    const spans = [...text.matchAll(new RegExp(needle, "g"))].map(match => ({
      startByte: Buffer.byteLength(text.slice(0, match.index)),
      endByte: Buffer.byteLength(text.slice(0, match.index + match[0].length)),
    }));
    return spans.length ? [{ line: index + 1, text, spans }] : [];
  });
}

test("existing YAML parser supplies nested, sequence, quoted-key, scalar and multi-document context", () => {
  const source = 'server:\n  ttl: needle\nitems:\n  - "odd.key": needle\n  - body: |\n      needle\n---\nserver: {ttl: needle}\n';
  assert.deepEqual(structuredMatchContext(source, ".yaml", matchedRows(source)), [
    { line: 2, path: "document[1].server.ttl" },
    { line: 4, path: 'document[1].items[0]["odd.key"]' },
    { line: 6, path: "document[1].items[1].body" },
    { line: 8, path: "document[2].server.ttl" },
  ]);
  const alias = 'base: &base\n  ttl: needle\ncopy: *base\n';
  assert.deepEqual(structuredMatchContext(alias, ".yml", matchedRows(alias, "base")), [
    { line: 1, path: "base" }, { line: 3, path: "copy" },
  ], "aliases describe their written site, never invented inherited children");
});

test("JSON uses byte-to-UTF16 conversion, exact same-line spans, duplicate and escaped keys", () => {
  const source = '{"é💡":{"ttl":"needle"},"other":{"ttl":"needle"},"e\\u0078":"needle","dup":"needle","dup":"needle"}';
  const rows = matchedRows(source);
  assert.equal(rows[0].spans.length, 5);
  assert.deepEqual(structuredMatchContext(source, ".json", rows), [
    { line: 1, path: '["é💡"].ttl' }, { line: 1, path: "other.ttl" },
    { line: 1, path: "ex" }, { line: 1, path: "dup" },
  ]);
  assert.equal(rows[0].spans.length, 5, "context deduplication does not mutate occurrences");
});

test("invalid structure, unsupported formats and nonidentical source rows get no invented key paths", () => {
  for (const [source, extension] of [["x: [needle", ".yaml"], ["x: needle", ".json"], ['x = "needle"', ".toml"]]) {
    assert.deepEqual(structuredMatchContext(source, extension, matchedRows(source)), []);
  }
  assert.deepEqual(structuredMatchContext('x: needle\n', ".yaml", [{ line: 1, text: 'wrong: needle', spans: [{ startByte: 7, endByte: 13 }] }]), []);
  const crlf = '\ufeffparent:\r\n  ttl: needle\r\n';
  assert.deepEqual(structuredMatchContext(crlf, ".yaml", matchedRows(crlf)), [{ line: 2, path: "parent.ttl" }]);
});

function fixture(t, source, extension = ".yaml", options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-key-context-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const name = `settings${extension}`;
  const path = join(root, name);
  writeFileSync(path, source);
  const rows = matchedRows(source);
  const evidence = rows.map(row => ({ path: name, line: row.line, text: row.text,
    visibility: options.clipped ? "clipped" : "visible_complete", transformation: "verbatim" }));
  const proofText = options.changedProof ? source.replaceAll("needle", "changed") : source;
  const proof = { canonicalPath: path, text: proofText,
    rawDigest: options.badDigest ? "0".repeat(64) : createHash("sha256").update(proofText).digest("hex").toUpperCase(),
    lineEnding: proofText.includes("\r\n") ? "crlf" : "lf", bom: proofText.startsWith("\ufeff") };
  const output = { text: `Matches\n### ${name}\n${rows.map(row => `${row.line}: ${row.text}`).join("\n")}`,
    sourceRoot: root, sourceSnapshots: options.fetchProof || options.noProof ? [] : [proof],
    structured: { schemaVersion: 1, operation: "pi_nav_search", data: {
      mode: "matches", groups: [{ path: name, owner: null, outline: [], matches: rows }], sourceRows: evidence,
      coverage: { complete: true, occurrences: rows.reduce((sum, row) => sum + row.spans.length, 0), more: false },
    }, diagnostics: [], completeness: { complete: true, returned: rows.length, total: rows.length } } };
  const calls = [];
  let tool;
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async input => {
    calls.push(input.operation);
    if (options.respond) return options.respond(input, output);
    if (input.operation === "pi_nav_search") return output;
    assert.equal(input.operation, "pi_nav_source_proof", "only the existing proof seam may fetch missing snapshots");
    return { ...output, text: "", sourceSnapshots: options.noProof ? [] : [proof] };
  } });
  return { root, path, source, proof, rows, evidence, output, calls,
    run: () => tool.execute("keys", { pattern: "needle", paths: path, output: "matches", syntax: "literal" }, undefined, undefined, { cwd: root }) };
}

test("registered Matches appends verified key paths without new source authority, transport or private bytes", async t => {
  for (const fetchProof of [false, true]) {
    const item = fixture(t, 'server:\n  ttl: needle\n  unrelated: UNSEEN_VALUE\n', ".yaml", { fetchProof });
    const result = await item.run();
    assert.match(result.content[0].text, /Syntactic key context[\s\S]*L2: server\.ttl/);
    assert.deepEqual(item.calls, fetchProof ? ["pi_nav_search", "pi_nav_source_proof"] : ["pi_nav_search"]);
    assert.deepEqual([...snapshots.byTag(item.path, computeTag(item.source)).seenLines], [2]);
    assert.deepEqual(result.details.native.data.groups, item.output.structured.data.groups);
    assert.doesNotMatch(JSON.stringify(result), /UNSEEN_VALUE|sourceSnapshots|rawDigest/);
    assert.ok(referenceTokenCount(result.content[0].text) <= 4000);
    const publicProof = await certifySourceAuthority({ cwd: item.root, nativeText: "", evidence: [{ path: item.path,
      rows: item.evidence, provenance: { capability: "test", backend: "fixture", route: "matches" } }], sourceSnapshots: [item.proof] });
    assert.equal("sourceSnapshots" in publicProof, false, "convenience API cannot expose operation-local raw bytes");
  }
});

test("uncertified and clipped rows keep their occurrences but receive neither key labels nor source authority", async t => {
  for (const options of [{ noProof: true }, { badDigest: true }, { changedProof: true }, { clipped: true }]) {
    const item = fixture(t, 'server:\n  ttl: needle\n', ".yaml", options);
    const result = await item.run();
    assert.match(result.content[0].text, /ttl: needle/);
    assert.doesNotMatch(result.content[0].text, /Syntactic key context|L2: server\.ttl/);
    assert.equal(snapshots.byTag(item.path, computeTag(item.source)), undefined);
    assert.deepEqual(result.details.native.data.groups, item.output.structured.data.groups);
  }
});

test("an indivisible huge key path cannot make an otherwise deliverable match disappear", async t => {
  const item = fixture(t, `? ${"long_ancestor_".repeat(5000)}\n: \n  ttl: needle\n`);
  const result = await item.run();
  assert.match(result.content[0].text, /ttl: needle/);
  assert.match(result.content[0].text, /Structured key context withheld/);
  assert.ok(referenceTokenCount(result.content[0].text) <= 4000);
  assert.deepEqual([...snapshots.byTag(item.path, computeTag(item.source)).seenLines], [3]);
});

test("key-context pressure refits the retained page before granting any rejected rows authority", async t => {
  const ancestor = "a_".repeat(200);
  const source = `${ancestor}:\n` + Array.from({ length: 32 }, (_, index) => `  leaf_${index}: needle\n`).join("");
  let refits = 0;
  const item = fixture(t, source, ".yaml", { respond(input, output) {
    if (!input.args.renderMatches) return output;
    refits++;
    assert.equal(input.args.renderMatches, "context-origin");
    assert.equal(snapshots.byTag(item.path, computeTag(source)), undefined, "oversized annotated preview must not commit");
    const rows = output.structured.data.groups[0].matches.slice(0, 8);
    return { ...output, text: `Matches\n${rows.map(row => `${row.line}: ${row.text}`).join("\n")}\nMore: cursor grep-context-next`,
      structured: { ...output.structured, data: { ...output.structured.data,
        groups: [{ ...output.structured.data.groups[0], matches: rows }],
        sourceRows: output.structured.data.sourceRows.slice(0, 8), cursor: "grep-context-next",
        coverage: { complete: true, occurrences: 32, more: true },
      }, completeness: { complete: true, returned: 8, total: 32 } } };
  } });
  item.output.matchesRenderCursor = "context-origin";
  const result = await item.run();
  assert.equal(refits, 1, "key paths, not just native text, must trigger the existing fitter");
  assert.ok(referenceTokenCount(result.content[0].text) <= 4000);
  assert.match(result.content[0].text, /Syntactic key context/);
  assert.doesNotMatch(result.content[0].text, /leaf_8|Structured key context withheld/);
  assert.equal(result.details.native.data.cursor, "grep-context-next");
  assert.equal(result.details.native.data.coverage.occurrences, 32);
  assert.deepEqual([...snapshots.byTag(item.path, computeTag(source)).seenLines], Array.from({ length: 8 }, (_, index) => index + 2));
});
