import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { repairConcreteHunks } from "../src/core/edit-repair.ts";
import { applyPatch as applyPatchResult } from "../src/core/patch-apply.ts";
import { renderRead } from "../src/core/read-renderer.ts";
const applyPatch = async params => (await applyPatchResult(params)).text;

const replace = (start, end, body) => ({ kind: "replace", start, end, body, line: 1 });

test("repair removes only proven two-sided boundary echoes", () => {
  const result = repairConcreteHunks("before\nold\nafter\n", [replace(2, 2, ["before", "new", "after"])]);
  assert.deepEqual(result.hunks[0].body, ["new"]);
  assert.match(result.warnings[0], /duplicated unchanged boundary/);
  const oneSided = repairConcreteHunks("before\nold\nafter\n", [replace(2, 2, ["before", "intended duplicate"])]);
  assert.deepEqual(oneSided.hunks[0].body, ["before", "intended duplicate"], "ambiguous one-sided content stays untouched");
  assert.deepEqual(oneSided.warnings, []);
});

test("repair fails closed when boundary normalization would silently turn REPLACE into DELETE", () => {
  assert.throws(() => repairConcreteHunks("before\nold\nafter\n", [replace(2, 2, ["before", "after"])]), /ambiguous_boundary_repair/);
});

test("repair removes a duplicated surviving closer and restores one range-owned missing closer", () => {
  const duplicate = repairConcreteHunks("function x() {\n  old();\n}\n", [replace(2, 2, ["  next();", "}"])]);
  assert.deepEqual(duplicate.hunks[0].body, ["  next();"]);
  assert.match(duplicate.warnings[0], /surviving structural closer/);

  const missing = repairConcreteHunks("function x() {\n  old();\n}\n", [replace(1, 3, ["function x() {", "  next();"])]);
  assert.deepEqual(missing.hunks[0].body, ["function x() {", "  next();", "}"]);
  assert.match(missing.warnings[0], /range-owned structural closer/);
});

test("delimiter balancing ignores braces in strings and comments", () => {
  const text = "function x() {\n  const value = '}'; // {\n}\n";
  const body = ["function x() {", "  const value = '}'; // {", "}"];
  const result = repairConcreteHunks(text, [replace(1, 3, body)]);
  assert.deepEqual(result.hunks[0].body, body);
  assert.deepEqual(result.warnings, []);
});

test("JSX surviving closers are repaired without touching intended named content", () => {
  const text = "<Panel>\n  <Old />\n</Panel>\n";
  const result = repairConcreteHunks(text, [replace(2, 2, ["  <New />", "</Panel>"])]);
  assert.deepEqual(result.hunks[0].body, ["  <New />"]);
  assert.match(result.warnings[0], /structural closer/);
});

test("repair integrates with natural edit and reports the exact repair", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-nav-edit-repair-"));
  const path = join(cwd, "repair.ts");
  await writeFile(path, "const before = 1;\nconst value = 'old';\nconst after = 2;\n");
  const read = (await renderRead({ cwd, path: `${path}:1-3` })).text;
  const header = /^\[[^\n]+#[A-F0-9]+\]/m.exec(read)?.[0];
  assert.ok(header);
  const edited = await applyPatch({ cwd, patch: `${header}\nREPLACE 2:\n+const before = 1;\n+const value = 'new';\n+const after = 2;` });
  assert.match(edited, /Auto-repaired REPLACE 2\.\.2/);
  assert.equal(await readFile(path, "utf8"), "const before = 1;\nconst value = 'new';\nconst after = 2;\n");
});

test("repair removes balance-neutral one-sided structural echoes but preserves ordinary duplicate content", () => {
  const structural = repairConcreteHunks("const fn = () =>\n  old();\nafter();\n", [replace(2, 2, ["const fn = () =>", "  next();"])]);
  assert.deepEqual(structural.hunks[0].body, ["  next();"]);
  assert.match(structural.warnings[0], /balance-neutral duplicated leading boundary|surviving structural closer/);

  const ordinary = repairConcreteHunks("before\nold\nafter\n", [replace(2, 2, ["before", "intended duplicate"])]);
  assert.deepEqual(ordinary.hunks[0].body, ["before", "intended duplicate"]);
  assert.deepEqual(ordinary.warnings, []);
});

test("whole-patch delimiter residual does not restore a closer when another hunk removes its opener", () => {
  const text = "if (ready) {\n  old();\n}\nafter();\n";
  const result = repairConcreteHunks(text, [
    replace(1, 1, ["// condition removed"]),
    replace(3, 3, ["done();"]),
  ]);
  assert.deepEqual(result.hunks[1].body, ["done();"]);
  assert.doesNotMatch(result.warnings.join("\n"), /restored.*closer/);
});

test("whole-patch repair remains inert for delimiter-like text in comments, strings, and templates", () => {
  const text = "function x() {\n  const a = '}'; // {\n  const b = `] ) }`;\n}\n";
  const body = ["function x() {", "  const a = '}'; // {", "  const b = `] ) }`;", "}"];
  const result = repairConcreteHunks(text, [replace(1, 4, body)]);
  assert.deepEqual(result.hunks[0].body, body);
  assert.deepEqual(result.warnings, []);
});

test("outward INSERT AFTER repair crosses only structural closers to the body's comparable indentation", () => {
  const text = "function x() {\n  if (ready) {\n    run();\n  }\n}\nafter();\n";
  const insert = { kind: "insert", position: "after", lineNumber: 3, body: ["next();"], line: 1 };
  const result = repairConcreteHunks(text, [insert]);
  assert.equal(result.hunks[0].lineNumber, 5);
  assert.match(result.warnings[0], /moved INSERT AFTER 3 outward across 2 structural closer/);
});

test("outward INSERT AFTER repair refuses content crossings, targeted closers, and incomparable indentation", () => {
  const insert = { kind: "insert", position: "after", lineNumber: 2, body: ["next();"], line: 1 };
  const content = repairConcreteHunks("if (ready) {\n  run();\n  content();\n}\n", [insert]);
  assert.equal(content.hunks[0].lineNumber, 2);

  const targeted = repairConcreteHunks("if (ready) {\n  run();\n}\n", [insert, { kind: "delete", start: 3, end: 3, line: 2 }]);
  assert.equal(targeted.hunks[0].lineNumber, 2);

  const mixed = repairConcreteHunks("if (ready) {\n\trun();\n}\n", [{ ...insert, body: ["  one();", "\ttwo();"] }]);
  assert.equal(mixed.hunks[0].lineNumber, 2);
});
