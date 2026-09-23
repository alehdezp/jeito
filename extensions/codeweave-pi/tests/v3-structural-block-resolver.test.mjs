import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { resolveStructuralBlocks, shutdownStructuralBlockResolver, supportedStructuralLanguages } from "../src/core/structural-block-resolver.ts";
import { renderSmartSummaryWithMetadata } from "../src/core/summary-renderer.ts";

const fixtures = [
  ["demo.ts", "export function work() {\n  return 1;\n}\n", "function"],
  ["demo.tsx", "export function View() {\n  return <Panel />;\n}\n", "function"],
  ["demo.js", "class Service {\n  run() { return 1; }\n}\n", "class"],
  ["demo.py", "def work():\n    return 1\n", "function"],
  ["demo.go", "package demo\nfunc work() int {\n return 1\n}\n", "function"],
  ["demo.rs", "fn work() -> i32 {\n  1\n}\n", "function"],
  ["Demo.java", "class Demo {\n  int work() { return 1; }\n}\n", "class"],
  ["Demo.kt", "class Demo {\n  fun work(): Int = 1\n}\n", "class"],
  ["guide.md", "# Guide\nbody\n## Child\nchild body\n# Next\nnext body\n", "heading"],
];

test("tree-sitter WASM worker provides the declared multi-language matrix and cache", async t => {
  t.after(() => shutdownStructuralBlockResolver());
  assert.deepEqual(supportedStructuralLanguages(), ["go", "java", "javascript", "kotlin", "markdown", "python", "rust", "tsx", "typescript"]);
  for (const [path, text, kind] of fixtures) {
    const result = await resolveStructuralBlocks({ path, text, timeoutMs: 5_000 });
    assert.ok(result, path);
    assert.ok(result.blocks.some(block => block.kind === kind && block.end > block.start && block.parser === "tree-sitter-wasm"), `${path}: ${JSON.stringify(result.blocks)}`);
  }
  const first = await resolveStructuralBlocks({ path: "cached.ts", text: fixtures[0][1], timeoutMs: 5_000 });
  const second = await resolveStructuralBlocks({ path: "cached.ts", text: fixtures[0][1], timeoutMs: 5_000 });
  assert.ok(first);
  assert.equal(second?.cache, "hit");
  if (process.platform === "darwin" && first?.workerPid) {
    const niceness = Number(execFileSync("/bin/ps", ["-o", "ni=", "-p", String(first.workerPid)], { encoding: "utf8" }).trim());
    assert.ok(niceness >= 15, `structural worker niceness=${niceness}`);
  }
});

test("tree-sitter block metadata is additive to unchanged summary source text", async t => {
  t.after(() => shutdownStructuralBlockResolver());
  const lines = ["export function work() {", "  return 1;", "}"];
  const provider = { name: "fixture", priority: 1, canHandle: () => true, async summarize() { return { title: "native fixture summary", totalLines: 3, entries: [{ start: 1, end: 3, kind: "function", label: "heuristic", confidence: "high" }] }; } };
  const rendered = await renderSmartSummaryWithMetadata({ cwd: "/tmp", absolutePath: "/tmp/demo.ts", displayPath: "demo.ts", normalized: `${lines.join("\n")}\n`, lines, kind: "file" }, { providers: [provider], timeoutMs: 5_000 });
  const sourceText = (rendered?.text ?? "").split("\n\n[Certified whole-block anchors:")[0];
  assert.equal(sourceText, "3 lines. Structural source summary; every complete N:TEXT row is immediately editable under the file hash above.\n\n1:export function work() {\n2:  return 1;\n3:}");
  assert.equal(rendered?.blocks[0]?.parser, "tree-sitter-wasm");
  assert.equal(rendered?.blocks[0]?.grammar, "typescript");
});

test("unsupported structural languages fail closed without starting a parser result", async () => {
  assert.equal(await resolveStructuralBlocks({ path: "data.xyz", text: "function fake() {}" }), undefined);
});
