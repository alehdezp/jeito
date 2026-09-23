import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyPatch } from "../src/core/patch-apply.ts";
import { clearEditSession, retryCapsuleForTests } from "../src/core/edit-retry.ts";
import { renderRead } from "../src/core/read-renderer.ts";

const HEADER_RE = /^\[(.+)#([0-9A-F]{8})\]/m;
const fixture = () => mkdtemp(join(tmpdir(), "pi-nav-edit-retry-"));
function header(text) {
  const match = HEADER_RE.exec(text);
  assert.ok(match);
  return match[0];
}

async function partialFixture(name = "retry.txt") {
  const cwd = await fixture();
  const path = join(cwd, name);
  await writeFile(path, "one\ntwo\nthree\n");
  const read = (await renderRead({ cwd, path: `${path}:1-1,3-3` })).text;
  return { cwd, path, input: `${header(read)}\nREPLACE 1:\n+ONE\nREPLACE 2:\n+TWO\nREPLACE 3:\n+THREE` };
}

test("RETRY reapplies one exact residual and returns ordinary edit output", async () => {
  const { cwd, path, input } = await partialFixture();
  const sessionId = "retry-one";
  const partial = await applyPatch({ cwd, patch: input, sessionId });
  assert.equal(partial.details.status, "partial");
  assert.equal(partial.details.residuals.length, 1);
  assert.match(partial.text, /Remaining change 1/);
  assert.match(partial.text, /edit\(\{ input: "RETRY" \}\)/);
  assert.equal(await readFile(path, "utf8"), "ONE\ntwo\nTHREE\n");

  const retried = await applyPatch({ cwd, patch: "RETRY", sessionId });
  assert.equal(retried.details.status, "success");
  assert.match(retried.text, HEADER_RE);
  assert.match(retried.text, /Post-edit coordinates/);
  assert.doesNotMatch(retried.text, /Remaining change/);
  assert.equal(await readFile(path, "utf8"), "ONE\nTWO\nTHREE\n");

  const followUp = await applyPatch({ cwd, patch: `${header(retried.text)}\nREPLACE 2:\n+TWO AGAIN`, sessionId });
  assert.equal(followUp.details.status, "success");
  assert.equal(await readFile(path, "utf8"), "ONE\nTWO AGAIN\nTHREE\n");
});

test("RETRY N retains unselected work and RETRY ALL applies all selected residuals", async () => {
  const cwd = await fixture();
  const path = join(cwd, "many.txt");
  await writeFile(path, "one\ntwo\nthree\nfour\n");
  const read = (await renderRead({ cwd, path: `${path}:1-1,4-4` })).text;
  const input = `${header(read)}\nREPLACE 1:\n+ONE\nREPLACE 2:\n+TWO\nREPLACE 3:\n+THREE\nREPLACE 4:\n+FOUR`;

  const numberedSession = "retry-numbered";
  const partial = await applyPatch({ cwd, patch: input, sessionId: numberedSession });
  assert.equal(partial.details.residuals.length, 2);
  await assert.rejects(applyPatch({ cwd, patch: "RETRY", sessionId: numberedSession }), /retry_selection_required/);
  await assert.rejects(applyPatch({ cwd, patch: "RETRY 9", sessionId: numberedSession }), /retry_selection_invalid/);
  await applyPatch({ cwd, patch: "RETRY 1", sessionId: numberedSession });
  assert.equal(retryCapsuleForTests(numberedSession)?.length, 1);
  await applyPatch({ cwd, patch: "RETRY", sessionId: numberedSession });
  assert.equal(await readFile(path, "utf8"), "ONE\nTWO\nTHREE\nFOUR\n");

  const allPath = join(cwd, "all.txt");
  await writeFile(allPath, "one\ntwo\nthree\nfour\n");
  const fresh = (await renderRead({ cwd, path: `${allPath}:1-1,4-4` })).text;
  const allSession = "retry-all";
  await applyPatch({ cwd, patch: `${header(fresh)}\nREPLACE 1:\n+ONE\nREPLACE 2:\n+TWO\nREPLACE 3:\n+THREE\nREPLACE 4:\n+FOUR`, sessionId: allSession });
  await applyPatch({ cwd, patch: "RETRY ALL", sessionId: allSession });
  assert.equal(await readFile(allPath, "utf8"), "ONE\nTWO\nTHREE\nFOUR\n");
});

test("retry capsules are session-local, absent after clear, and refuse oversized sets", async () => {
  const { cwd, input } = await partialFixture("sessions.txt");
  await applyPatch({ cwd, patch: input, sessionId: "session-a" });
  await assert.rejects(applyPatch({ cwd, patch: "RETRY", sessionId: "session-b" }), /no_retry_available/);
  clearEditSession("session-a");
  await assert.rejects(applyPatch({ cwd, patch: "RETRY", sessionId: "session-a" }), /no_retry_available/);

  const largePath = join(cwd, "large.txt");
  const lines = Array.from({ length: 66 }, (_, index) => `line ${index + 1}`);
  await writeFile(largePath, `${lines.join("\n")}\n`);
  const read = (await renderRead({ cwd, path: `${largePath}:1-1` })).text;
  const operations = lines.map((_, index) => `REPLACE ${index + 1}:\n+LINE ${index + 1}`).join("\n");
  const large = await applyPatch({ cwd, patch: `${header(read)}\n${operations}`, sessionId: "large-session" });
  assert.match(large.text, /Retry unavailable: retry capsule refused/);
  assert.equal(retryCapsuleForTests("large-session"), undefined);
});

test("retry never bypasses stale safety after an external change", async () => {
  const { cwd, path, input } = await partialFixture("stale.txt");
  const sessionId = "retry-stale";
  await applyPatch({ cwd, patch: input, sessionId });
  await writeFile(path, "ONE\nexternally changed\nTHREE\n");
  const retried = await applyPatch({ cwd, patch: "RETRY", sessionId });
  assert.equal(retried.details.status, "error");
  assert.match(retried.text, /stale source could not be remapped safely|Needs attention/);
  assert.equal(await readFile(path, "utf8"), "ONE\nexternally changed\nTHREE\n");
});
