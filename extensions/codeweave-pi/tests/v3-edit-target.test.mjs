import assert from "node:assert/strict";
import test from "node:test";

import { applyTargetIslands, compileTarget, compileTextTarget, serializeTargetIsland } from "../src/core/edit-target.ts";

const origin = { sectionIndex: 2, operationIndex: 3, inputOrder: 5, operationLine: 17 };
const replace = (start, end, body) => ({ kind: "replace", start, end, body, line: origin.operationLine });

function assertTarget(source, hunk) {
  const compiled = compileTarget(source, hunk, origin);
  assert.deepEqual(applyTargetIslands(source, compiled.islands), compiled.desired);
  for (const island of compiled.islands) {
    assert.equal(island.sectionIndex, origin.sectionIndex);
    assert.equal(island.operationIndex, origin.operationIndex);
    assert.equal(island.inputOrder, origin.inputOrder);
    assert.equal(island.operationLine, origin.operationLine);
  }
  return compiled;
}

test("equal-length replacements split only contiguous positional differences", () => {
  const source = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  const body = [...source];
  body[1] = "TWO";
  body[6] = "SEVEN";
  body[10] = "ELEVEN";
  const compiled = assertTarget(source, replace(1, 12, body));
  assert.deepEqual(compiled.islands.map(change => [change.sourceStartIndex, change.sourceEndIndex, change.requiredRows]), [
    [1, 2, [2]],
    [6, 7, [7]],
    [10, 11, [11]],
  ]);
});

test("unchanged positional rows need no authority while a changed unseen row remains isolated", () => {
  const source = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
  const safeBody = [...source];
  safeBody[0] = "LINE 1";
  safeBody[99] = "LINE 100";
  const safe = assertTarget(source, replace(1, 100, safeBody));
  assert.deepEqual(safe.islands.flatMap(change => change.requiredRows), [1, 100]);

  const unsafeBody = [...safeBody];
  unsafeBody[49] = "UNSEEN CHANGED";
  const unsafe = assertTarget(source, replace(1, 100, unsafeBody));
  assert.deepEqual(unsafe.islands.flatMap(change => change.requiredRows), [1, 50, 100]);
});

test("changed-length replacements use only unique strictly monotonic anchors", () => {
  const source = ["start", "alpha", "middle", "omega", "end"];
  const desired = ["START", "alpha", "inserted", "middle", "omega", "END"];
  const compiled = assertTarget(source, replace(1, 5, desired));
  assert.deepEqual(compiled.islands.map(change => [change.kind, change.sourceStartIndex, change.sourceEndIndex, change.body]), [
    ["replace", 0, 1, ["START"]],
    ["insert", 2, 2, ["inserted"]],
    ["replace", 4, 5, ["END"]],
  ]);

  const duplicate = assertTarget(["start", "same", "middle", "same", "end"], replace(1, 5, ["START", "same", "inserted", "middle", "same", "END"]));
  assert.equal(duplicate.islands.length, 2, "duplicated lines are excluded while other unique monotonic anchors remain usable");

  const crossing = assertTarget(source, replace(1, 5, ["START", "omega", "extra", "middle", "alpha", "END"]));
  assert.equal(crossing.islands.length, 1, "crossing unique pairs protect the entire unresolved middle");
  assert.deepEqual(crossing.islands[0].requiredRows, [1, 2, 3, 4, 5]);
});

test("delete and insert targets preserve their exact authority boundary", () => {
  const deleted = assertTarget(["one", "two", "three"], { kind: "delete", start: 2, end: 3, line: 9 });
  assert.deepEqual(deleted.desired, ["one"]);
  assert.deepEqual(deleted.islands[0].requiredRows, [2, 3]);

  const inserted = assertTarget(["one", "two"], { kind: "insert", position: "after", lineNumber: 2, body: ["tail"], line: 10 });
  assert.deepEqual(inserted.desired, ["one", "two", "tail"]);
  assert.deepEqual(inserted.islands[0].requiredRows, [2]);
  assert.equal(serializeTargetIsland(inserted.islands[0], 2), "INSERT AT END:\n+tail");
});

test("replaying an insert whose exact target is already adjacent converges without duplication", () => {
  const compiled = compileTarget(["one", "two", "tail"], { kind: "insert", position: "after", lineNumber: 2, body: ["tail"], line: 10 }, origin);
  assert.equal(compiled.converged, true);
  assert.deepEqual(compiled.islands, []);
  assert.deepEqual(compiled.desired, ["one", "two", "tail"]);
});

test("accepted islands plus a freshly compiled residual converge to the exact desired target", () => {
  const source = ["a", "b", "c", "d", "e", "f"];
  const initial = compileTarget(source, replace(1, 6, ["A", "b", "C", "d", "E", "f"]), origin);
  const accepted = initial.islands.filter((_, index) => index !== 1);
  const landed = applyTargetIslands(source, accepted);
  assert.deepEqual(landed, ["A", "b", "c", "d", "E", "f"]);
  assert.equal(landed[2], source[2], "held source rows stay unchanged");
  const residual = compileTextTarget(landed, initial.desired, origin);
  assert.deepEqual(applyTargetIslands(landed, residual.islands), initial.desired);
  assert.equal(serializeTargetIsland(residual.islands[0], landed.length), "REPLACE 3:\n+C");
});

test("seeded randomized equal-length targets preserve compiler invariants", () => {
  let state = 0x5eed1234;
  const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 0x100000000;
  for (let iteration = 0; iteration < 250; iteration++) {
    const length = 1 + Math.floor(random() * 80);
    const source = Array.from({ length }, (_, index) => `row:${iteration}:${index}`);
    const desired = [...source];
    for (let index = 0; index < length; index++) if (random() < 0.22) desired[index] = `changed:${iteration}:${index}`;
    const compiled = compileTextTarget(source, desired, { ...origin, inputOrder: iteration });
    assert.deepEqual(applyTargetIslands(source, compiled.islands), desired);
    const accepted = compiled.islands.filter((_, index) => index % 2 === 0);
    const landed = applyTargetIslands(source, accepted);
    const residual = compileTextTarget(landed, desired, { ...origin, inputOrder: iteration });
    assert.deepEqual(applyTargetIslands(landed, residual.islands), desired);
    for (const held of compiled.islands.filter((_, index) => index % 2 === 1)) {
      assert.deepEqual(landed.slice(held.sourceStartIndex, held.sourceEndIndex), source.slice(held.sourceStartIndex, held.sourceEndIndex));
    }
  }
});
