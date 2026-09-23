import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyPatch } from "../src/core/patch-apply.ts";
import { renderRead } from "../src/core/read-renderer.ts";
import { resolveSyntaxDiagnostics, shutdownStructuralBlockResolver } from "../src/core/structural-block-resolver.ts";
import { SYNTAX_PARSE_BUDGET_BYTES, validateLandedSyntax } from "../src/core/syntax-validation.ts";
import { executeWrite } from "../src/core/write-core.ts";

const HEADER_RE = /^\[([^\]\n]+)#([A-F0-9]{8})\]$/m;

async function fixture() { return mkdtemp(join(tmpdir(), "pi-nav-syntax-")); }

test.after(async () => { await shutdownStructuralBlockResolver(); });

function cleanResult() { return { diagnostics: [], parseMs: 0 }; }
function diagnostic(line = 1, kind = "ERROR") { return { line, column: 1, endLine: line, endColumn: 2, kind, nodeType: kind }; }
async function readHeader(cwd, path, selector = "1") {
  const text = (await renderRead({ cwd, path: `${path}:${selector}` })).text;
  const match = HEADER_RE.exec(text);
  assert.ok(match, text);
  return `[${match[1]}#${match[2]}]`;
}

test("syntax comparison reports only newly introduced or worsened grammar failures", async () => {
  const clean = "export const value: number = 1;\n";
  const broken = "export const value: number = ;\n";
  const introduced = await validateLandedSyntax({ path: "sample.ts", before: clean, after: broken });
  assert.equal(introduced?.status, "worsened");
  assert.match(introduced?.text ?? "", /mutation remains landed/);
  assert.ok((introduced?.diagnostics.length ?? 0) > 0);

  assert.equal(await validateLandedSyntax({ path: "sample.ts", before: broken, after: broken }), undefined);
  assert.equal(await validateLandedSyntax({ path: "sample.ts", before: broken, after: clean }), undefined);
});

test("non-code text stays silent while unsupported code-like extensions report availability", async () => {
  assert.equal(await validateLandedSyntax({ path: "notes.txt", before: "", after: "{" }), undefined);
  assert.equal(await validateLandedSyntax({ path: "README", before: "", after: "{" }), undefined);
  const unsupported = await validateLandedSyntax({ path: "source.swift", before: "", after: "let x =" });
  assert.equal(unsupported?.status, "unavailable");
  assert.match(unsupported?.text ?? "", /\.swift/);
});

test("write lands malformed code and appends advisory syntax diagnostics", async () => {
  const cwd = await fixture();
  const path = join(cwd, "broken.ts");
  const result = await executeWrite({ cwd, path, content: "export const value = ;\n" });
  assert.match(result, /Created/);
  assert.match(result, /Syntax check found/);
  assert.equal(await readFile(path, "utf8"), "export const value = ;\n");
});

test("edit validates a landed file once and never rolls it back for syntax", async () => {
  const cwd = await fixture();
  const path = join(cwd, "edited.ts");
  await writeFile(path, "export const value = 1;\n");
  const read = (await renderRead({ cwd, path: `${path}:1` })).text;
  const match = HEADER_RE.exec(read);
  assert.ok(match);
  const result = await applyPatch({ cwd, patch: `[${match[1]}#${match[2]}]\nREPLACE 1:\n+export const value = ;` });
  assert.equal(result.details.status, "success");
  assert.match(result.text, /Syntax check found/);
  assert.equal(await readFile(path, "utf8"), "export const value = ;\n");
});

test("post-commit cancellation reports unavailable without changing landed bytes", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await validateLandedSyntax({ path: "sample.ts", before: "const x = 1;\n", after: "const x = ;\n", signal: controller.signal });
  assert.equal(result?.status, "unavailable");
  assert.match(result?.text ?? "", /cancelled/);
});

test("syntax budget is inclusive at 256 KiB and rejects one byte over without invoking the worker", async () => {
  for (const [bytes, expectedCalls, status] of [[SYNTAX_PARSE_BUDGET_BYTES, 2, undefined], [SYNTAX_PARSE_BUDGET_BYTES + 1, 0, "unavailable"]]) {
    let calls = 0;
    const resolver = async () => { calls++; return cleanResult(); };
    const text = " ".repeat(bytes);
    const result = await validateLandedSyntax({ path: "boundary.ts", before: text, after: text, resolveDiagnostics: resolver });
    assert.equal(calls, expectedCalls);
    assert.equal(result?.status, status);
  }
});

test("timeout and grammar failure remain unavailable after write lands", async () => {
  const cwd = await fixture();
  for (const name of ["timeout.ts", "grammar.ts"]) {
    const path = join(cwd, name);
    const result = await executeWrite({ cwd, path, content: "export const broken = ;\n", syntaxResolver: async () => undefined });
    assert.match(result, /worker timeout or grammar load failure/);
    assert.equal(await readFile(path, "utf8"), "export const broken = ;\n");
  }
});

test("cancellation during worker execution is unavailable and does not alter landed bytes", async () => {
  const cwd = await fixture();
  const path = join(cwd, "cancelled.ts");
  const controller = new AbortController();
  let started = 0;
  const resolver = ({ signal }) => new Promise(resolve => {
    started++;
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
    if (started === 2) queueMicrotask(() => controller.abort());
  });
  const result = await executeWrite({ cwd, path, content: "export const broken = ;\n", signal: controller.signal, syntaxResolver: resolver });
  assert.equal(started, 2);
  assert.match(result, /cancelled/);
  assert.equal(await readFile(path, "utf8"), "export const broken = ;\n");
});

test("diagnostic rendering caps at five while structured details retain bounded worker diagnostics", async () => {
  let call = 0;
  const diagnostics = Array.from({ length: 10 }, (_, index) => diagnostic(index + 1));
  const result = await validateLandedSyntax({
    path: "many.ts",
    before: "const ok = 1;\n",
    after: "const broken = ;\n",
    resolveDiagnostics: async () => call++ === 0 ? cleanResult() : { diagnostics, parseMs: 0 },
  });
  assert.equal(result?.diagnostics.length, 10);
  assert.equal((result?.text.match(/many\.ts:/g) ?? []).length, 5);
  assert.match(result?.text ?? "", /5 more/);
});

test("worsened diagnostics outside the changed output are reported without false attribution", async () => {
  let call = 0;
  const before = { diagnostics: [diagnostic(20)], parseMs: 0 };
  const after = { diagnostics: [diagnostic(20), diagnostic(30)], parseMs: 0 };
  const result = await validateLandedSyntax({ path: "far.ts", before: "const a = 1;\n", after: "const a = 2;\n", resolveDiagnostics: async () => call++ === 0 ? before : after });
  assert.equal(result?.status, "worsened");
  assert.match(result?.text ?? "", /none intersect/);
});

test("edit and write validate once per final landed path", async () => {
  const cwd = await fixture();
  const resolverCalls = [];
  const resolver = async input => { resolverCalls.push(input.path); return cleanResult(); };

  const composed = join(cwd, "composed.ts");
  await writeFile(composed, "const a = 1;\nconst b = 2;\n");
  const composedHeader = await readHeader(cwd, composed, "1-2");
  await applyPatch({ cwd, patch: `${composedHeader}\nREPLACE 1:\n+const a = 3;\n${composedHeader}\nREPLACE 2:\n+const b = 4;`, syntaxResolver: resolver });
  assert.equal(resolverCalls.splice(0).length, 2, "same-file composition performs one before/after syntax comparison");

  const multi = await readHeader(cwd, composed, "1-2");
  await applyPatch({ cwd, patch: `${multi}\nREPLACE 1:\n+const a = 5;\nREPLACE 2:\n+const b = 6;`, syntaxResolver: resolver });
  assert.equal(resolverCalls.splice(0).length, 2, "multi-operation edit validates once");

  await executeWrite({ cwd, path: composed, content: "const a = 7;\n", overwrite: true, syntaxResolver: resolver });
  assert.equal(resolverCalls.splice(0).length, 2, "overwrite validates once");

  const moveHeader = await readHeader(cwd, composed, "1");
  await applyPatch({ cwd, patch: `${moveHeader}\nMOVE FILE TO moved.ts`, syntaxResolver: resolver });
  assert.equal(resolverCalls.splice(0).length, 2, "move destination validates once");
});

test("partial calls validate only landed paths", async () => {
  const cwd = await fixture();
  const good = join(cwd, "good.ts");
  const bad = join(cwd, "bad.ts");
  await writeFile(good, "const good = 1;\n");
  await writeFile(bad, "const bad = 1;\n");
  const goodHeader = await readHeader(cwd, good);
  let calls = 0;
  const result = await applyPatch({ cwd, patch: `${goodHeader}\nREPLACE 1:\n+const good = 2;\n[${bad}#DEADBEEF]\nREPLACE 1:\n+const bad = 2;`, syntaxResolver: async () => { calls++; return cleanResult(); } });
  assert.equal(result.details.status, "partial");
  assert.equal(calls, 2);
  assert.equal(await readFile(good, "utf8"), "const good = 2;\n");
  assert.equal(await readFile(bad, "utf8"), "const bad = 1;\n");
});

test("bundled syntax worker cold/warm probe stays local and reuses one worker", async t => {
  await shutdownStructuralBlockResolver();
  const text = "export const value: number = 1;\n";
  const coldStarted = performance.now();
  const cold = await resolveSyntaxDiagnostics({ path: "probe.ts", text });
  const coldWallMs = performance.now() - coldStarted;
  const warmStarted = performance.now();
  const warm = await resolveSyntaxDiagnostics({ path: "probe.ts", text });
  const warmWallMs = performance.now() - warmStarted;
  assert.ok(cold && warm);
  assert.equal(warm.workerPid, cold.workerPid);
  assert.deepEqual(cold.diagnostics, []);
  assert.deepEqual(warm.diagnostics, []);
  t.diagnostic(`bundled syntax cold=${coldWallMs.toFixed(3)}ms warm=${warmWallMs.toFixed(3)}ms worker=${cold.workerPid}`);
});
