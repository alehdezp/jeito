import assert from "node:assert/strict";
import test from "node:test";
import { parseWriteProgram } from "../src/core/write-parser.ts";

test("single section parses path and content", () => {
  const result = parseWriteProgram("[src/a.ts]\nhello\nworld");
  assert.equal(result.sections.length, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(result.sections[0].path, "src/a.ts");
  assert.equal(result.sections[0].overwrite, false);
  assert.equal(result.sections[0].content, "hello\nworld");
  assert.equal(result.sections[0].headerLine, 1);
});

test("multiple sections with overwrite marker", () => {
  const result = parseWriteProgram("[src/a.ts]\nfile a\n\n[src/b.ts!]\nfile b");
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].path, "src/a.ts");
  assert.equal(result.sections[0].overwrite, false);
  assert.equal(result.sections[0].content, "file a");
  assert.equal(result.sections[1].path, "src/b.ts");
  assert.equal(result.sections[1].overwrite, true);
  assert.equal(result.sections[1].content, "file b");
});

test("trailing blank lines between sections are stripped", () => {
  const result = parseWriteProgram("[a.ts]\nline\n\n\n[b.ts]\nother");
  assert.equal(result.sections[0].content, "line");
  assert.equal(result.sections[1].content, "other");
});

test("empty path in header is a failure", () => {
  const result = parseWriteProgram("[!]\ncontent");
  assert.equal(result.sections.length, 0);
  assert.ok(result.failures.some(f => /Empty path/.test(f.message)));
  assert.ok(result.failures.some(f => /before first/.test(f.message)));
});

test("content before first header is a failure", () => {
  const result = parseWriteProgram("orphan text\n[a.ts]\ncontent");
  assert.equal(result.sections.length, 1);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /before first/);
});

test("no sections produces a failure", () => {
  const result = parseWriteProgram("just text, no headers");
  assert.equal(result.sections.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /before first \[path\] header/);
});

test("empty input produces a failure", () => {
  const result = parseWriteProgram("");
  assert.equal(result.sections.length, 0);
  assert.equal(result.failures.length, 1);
});

test("bracket content lines are treated as headers per the salvage model", () => {
  const result = parseWriteProgram("[src/a.ts]\nline 1\n[dependencies]\nline 2");
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[1].path, "dependencies");
  assert.equal(result.sections[1].content, "line 2");
});

test("CRLF and BOM are normalized", () => {
  const result = parseWriteProgram("\uFEFF[a.ts]\r\ncontent\r\n");
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].content, "content");
});

test("path ending with exclamation but not as last char is not overwrite", () => {
  const result = parseWriteProgram("[wow!.txt]\ncontent");
  assert.equal(result.sections[0].path, "wow!.txt");
  assert.equal(result.sections[0].overwrite, false);
});

test("overwrite marker only when ! is the last char before ]", () => {
  const result = parseWriteProgram("[wow!.txt!]\ncontent");
  assert.equal(result.sections[0].path, "wow!.txt");
  assert.equal(result.sections[0].overwrite, true);
});

test("empty content section is valid", () => {
  const result = parseWriteProgram("[a.ts]\n[b.ts]\ncontent");
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].content, "");
  assert.equal(result.sections[1].content, "content");
});
