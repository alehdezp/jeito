import assert from "node:assert/strict";
import test from "node:test";

import { cloneConcreteHunks, recoverEdit, recoverEditAsync, recoveryBudget, recoveryDeadline, validateRecoveryRequest } from "../src/core/edit-recovery.ts";

function request(overrides = {}) {
  return {
    previousText: "one\ntwo\n",
    currentText: "zero\none\ntwo\n",
    hunks: [{ kind: "replace", start: 2, end: 2, body: ["TWO"], line: 1 }],
    authorizedLines: new Set([2]),
    ...overrides,
  };
}

test("recovery substrate is pure, bounded, and cancellation-aware", () => {
  assert.equal(validateRecoveryRequest(request()), undefined);
  assert.equal(validateRecoveryRequest(request({ budget: { maxBytes: 2 } }))?.reason, "budget_exceeded");
  assert.equal(validateRecoveryRequest(request({ budget: { maxLines: 2 } }))?.reason, "budget_exceeded");
  const controller = new AbortController();
  controller.abort();
  assert.equal(validateRecoveryRequest(request({ signal: controller.signal }))?.reason, "cancelled");
});

test("recovery deadline uses a deterministic injectable clock", () => {
  let now = 100;
  const deadline = recoveryDeadline(request({ now: () => now, budget: { deadlineMs: 10 } }));
  assert.equal(deadline.checkpoint(), undefined);
  now = 111;
  assert.equal(deadline.expired(), true);
  assert.equal(deadline.checkpoint()?.reason, "budget_exceeded");
});

test("recovery hunk cloning never aliases mutable replacement bodies", () => {
  const original = request().hunks;
  const cloned = cloneConcreteHunks(original);
  cloned[0].body[0] = "CHANGED";
  assert.equal(original[0].body[0], "TWO");
  assert.deepEqual(recoveryBudget({ maxBytes: -1, maxLines: 10, deadlineMs: 20 }), { maxBytes: 16 * 1024 * 1024, maxLines: 10, deadlineMs: 20 });
});

test("three-stage recovery selects exact-context merge, unchanged-line remap, and guarded session replay", () => {
  const hunk = [{ kind: "replace", start: 5, end: 5, body: ["TARGET!"], line: 1 }];
  const previousText = ["a", "b", "c", "d", "target", "e", "f", "g", "h", ""].join("\n");
  const merged = recoverEdit({ previousText, currentText: `external\n${previousText}`, hunks: hunk, authorizedLines: new Set([5]), isHeadSnapshot: true });
  assert.equal(merged.ok && merged.method, "three_way");
  assert.match(merged.ok ? merged.text : "", /external[\s\S]*TARGET!/);

  const remappedText = ["X", "a", "B", "c", "d", "target", "e", "f", "g", "h", ""].join("\n");
  const remapped = recoverEdit({ previousText, currentText: remappedText, hunks: hunk, authorizedLines: new Set([5]), isHeadSnapshot: true });
  assert.equal(remapped.ok && remapped.method, "line_remap");
  assert.equal(remapped.ok && remapped.hunks[0].start, 6);

  const replayText = ["A", "B", "C", "D", "target", "E", "F", "G", "H", ""].join("\n");
  const replay = recoverEdit({ previousText, currentText: replayText, hunks: hunk, authorizedLines: new Set([5]), isHeadSnapshot: false });
  assert.equal(replay.ok && replay.method, "session_replay");
});

test("recovery refuses changed or ambiguous duplicate anchors and preserves strict provenance", () => {
  const previousText = ["before", "same", "middle", "same", "after", ""].join("\n");
  const ambiguous = recoverEdit({ previousText, currentText: ["same", "before", "middle", "same", "after", ""].join("\n"), hunks: [{ kind: "replace", start: 2, end: 2, body: ["SAME"], line: 1 }], authorizedLines: new Set([2, 5]), isHeadSnapshot: true });
  assert.equal(ambiguous.ok, false);

  const changed = recoverEdit({ previousText: "a\ntarget\nc\n", currentText: "a\nchanged\nc\n", hunks: [{ kind: "replace", start: 2, end: 2, body: ["TARGET"], line: 1 }], authorizedLines: new Set([2]), isHeadSnapshot: true });
  assert.equal(changed.ok, false);

  const shifted = recoverEdit({ previousText: "one\ntwo\nthree\n", currentText: "header\none\ntwo\nthree\n", hunks: [{ kind: "replace", start: 2, end: 2, body: ["TWO"], line: 1 }], authorizedLines: new Set([1, 2, 3]), isHeadSnapshot: true });
  assert.equal(shifted.ok, true);
  if (shifted.ok) {
    assert.equal(shifted.authorizedAfterLines.has(1), false, "shifted historical coordinates are not carried as seen");
    assert.equal([...shifted.authorizedAfterLines].some(line => shifted.text.split("\n")[line - 1] === "TWO"), true, "authored replacement is seen");
  }
});

test("stale start/end-only inserts recover without remapping a historical line", () => {
  const result = recoverEdit({ previousText: "one\n", currentText: "external\none\n", hunks: [{ kind: "insert", position: "tail", body: ["tail"], line: 1 }], authorizedLines: new Set(), isHeadSnapshot: true });
  assert.equal(result.ok && result.method, "head_tail_drift");
  assert.equal(result.ok && result.text, "external\none\ntail\n");
});

test("large recovery can execute in a worker without changing recovery semantics", async t => {
  const previous = process.env.PI_NAV_RECOVERY_WORKER_LINES;
  process.env.PI_NAV_RECOVERY_WORKER_LINES = "1";
  t.after(() => previous === undefined ? delete process.env.PI_NAV_RECOVERY_WORKER_LINES : process.env.PI_NAV_RECOVERY_WORKER_LINES = previous);
  const result = await recoverEditAsync({ previousText: "a\ntarget\nc\n", currentText: "header\na\ntarget\nc\n", hunks: [{ kind: "replace", start: 2, end: 2, body: ["TARGET"], line: 1 }], authorizedLines: new Set([2]), isHeadSnapshot: true, budget: { deadlineMs: 2_000 } });
  assert.equal(result.ok, true);
  assert.match(result.ok ? result.text : "", /header\na\nTARGET\nc/);
});
