import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyPatch as applyPatchResult } from "../src/core/patch-apply.ts";
import { renderRead } from "../src/core/read-renderer.ts";
const applyPatch = async params => (await applyPatchResult(params)).text;

const HEADER_RE = /^\[(.+)#([0-9A-F]{8})\]/m;
const fixture = () => mkdtemp(join(tmpdir(), "pi-nav-edit-partial-"));
function header(text) {
  const match = HEADER_RE.exec(text);
  assert.ok(match);
  return match[0];
}

test("a malformed middle same-path section does not erase valid surrounding sections", async () => {
  const cwd = await fixture();
  const path = join(cwd, "same.txt");
  await writeFile(path, "one\ntwo\nthree\n");
  const read = (await renderRead({ cwd, path: `${path}:1-1,3-3` })).text;
  const h = header(read);
  const result = await applyPatch({ cwd, patch: `${h}\nREPLACE 1:\n+ONE\n${h}\nREPLACE nope:\n+TWO\n${h}\nREPLACE 3:\n+THREE` });
  assert.match(result, /Rejected section for .*same\.txt/);
  assert.match(result, /Composed 2 same-path sections/);
  assert.equal(await readFile(path, "utf8"), "ONE\ntwo\nTHREE\n");
});

test("a malformed file section does not prevent a valid later file from landing", async () => {
  const cwd = await fixture();
  const bad = join(cwd, "bad.txt");
  const good = join(cwd, "good.txt");
  await writeFile(bad, "bad\n");
  await writeFile(good, "good\n");
  const badRead = (await renderRead({ cwd, path: `${bad}:1` })).text;
  const goodRead = (await renderRead({ cwd, path: `${good}:1` })).text;
  const result = await applyPatch({ cwd, patch: `${header(badRead)}\nREPLACE X:\n+BAD\n${header(goodRead)}\nREPLACE 1:\n+GOOD` });
  assert.match(result, /Rejected section for .*bad\.txt/);
  assert.equal(await readFile(bad, "utf8"), "bad\n");
  assert.equal(await readFile(good, "utf8"), "GOOD\n");
});

test("a malformed header-like line remains call-fatal and writes nothing", async () => {
  const cwd = await fixture();
  const path = join(cwd, "fatal.txt");
  await writeFile(path, "one\n");
  const read = (await renderRead({ cwd, path: `${path}:1` })).text;
  await assert.rejects(applyPatch({ cwd, patch: `${header(read)}\nREPLACE 1:\n+ONE\n[broken#1234]\nREPLACE 1:\n+BROKEN` }), /syntax_error.*no files were written/s);
  assert.equal(await readFile(path, "utf8"), "one\n");
});

test("an unknown same-path hash rejects only its section while the current section lands", async () => {
  const cwd = await fixture();
  const path = join(cwd, "hashes.txt");
  await writeFile(path, "one\ntwo\n");
  const read = (await renderRead({ cwd, path: `${path}:1-2` })).text;
  const result = await applyPatch({ cwd, patch: `[${path}#DEADBEEF]\nREPLACE 1:\n+STALE\n${header(read)}\nREPLACE 2:\n+TWO` });
  assert.match(result, /Rejected section for .*hashes\.txt/);
  assert.equal(await readFile(path, "utf8"), "one\nTWO\n");
});

test("same-path whole-file conflicts preserve an unrelated valid file", async () => {
  const cwd = await fixture();
  const conflicted = join(cwd, "conflicted.txt");
  const good = join(cwd, "good.txt");
  await writeFile(conflicted, "keep\n");
  await writeFile(good, "good\n");
  const conflictRead = (await renderRead({ cwd, path: `${conflicted}:1` })).text;
  const goodRead = (await renderRead({ cwd, path: `${good}:1` })).text;
  const h = header(conflictRead);
  const result = await applyPatch({ cwd, patch: `${h}\nDELETE FILE\n${h}\nREPLACE 1:\n+CHANGE\n${header(goodRead)}\nREPLACE 1:\n+GOOD` });
  assert.match(result, /whole-file operations cannot be combined/);
  assert.equal(await readFile(conflicted, "utf8"), "keep\n");
  assert.equal(await readFile(good, "utf8"), "GOOD\n");
});

test("structured partial details report only landed and refreshable paths", async () => {
  const cwd = await fixture();
  const good = join(cwd, "structured-good.txt");
  const held = join(cwd, "structured-held.txt");
  await writeFile(good, "good\n");
  await writeFile(held, "one\ntwo\n");
  const goodRead = (await renderRead({ cwd, path: `${good}:1` })).text;
  const heldRead = (await renderRead({ cwd, path: `${held}:1-1` })).text;
  const result = await applyPatchResult({ cwd, patch: `${header(goodRead)}\nREPLACE 1:\n+GOOD\n${header(heldRead)}\nREPLACE 2:\n+TWO` });
  assert.equal(result.details.status, "partial");
  assert.deepEqual(result.details.changedPaths, [good]);
  assert.deepEqual(result.details.refreshPaths, [good]);
  assert.equal(result.details.residuals.length, 0, "held-only files do not mint a retry capsule without a successful landing");
  assert.equal(result.details.files.find(file => file.path === good)?.status, "landed");
  assert.equal(result.details.files.find(file => file.path === held)?.status, "skipped");
  assert.match(result.text, /Needs attention/);
});

test("cancellation before commit lands nothing and reports exact cancelled files", async () => {
  const cwd = await fixture();
  const a = join(cwd, "cancel-a.txt");
  const b = join(cwd, "cancel-b.txt");
  await writeFile(a, "a\n");
  await writeFile(b, "b\n");
  const aRead = (await renderRead({ cwd, path: `${a}:1` })).text;
  const bRead = (await renderRead({ cwd, path: `${b}:1` })).text;
  const controller = new AbortController();
  controller.abort();
  const result = await applyPatchResult({ cwd, signal: controller.signal, patch: `${header(aRead)}\nREPLACE 1:\n+A\n${header(bRead)}\nREPLACE 1:\n+B` });
  assert.equal(result.details.cancelled, true);
  assert.equal(result.details.status, "error");
  assert.deepEqual(result.details.changedPaths, []);
  assert.deepEqual(result.details.files.map(file => file.status), ["cancelled", "cancelled"]);
  assert.equal(await readFile(a, "utf8"), "a\n");
  assert.equal(await readFile(b, "utf8"), "b\n");
});

test("a unique basename plus eight-hex session snapshot recovers one missing authored path", async () => {
  const cwd = await fixture();
  const actualDir = join(cwd, "src");
  await mkdir(actualDir);
  const actual = join(actualDir, "unique.txt");
  await writeFile(actual, "one\n");
  const read = (await renderRead({ cwd, path: `${actual}:1` })).text;
  const tag = HEADER_RE.exec(read)?.[2];
  assert.ok(tag);
  const result = await applyPatch({ cwd, patch: `[missing/unique.txt#${tag}]\nREPLACE 1:\n+ONE` });
  assert.match(result, /Recovered missing authored path missing\/unique\.txt/);
  assert.equal(await readFile(actual, "utf8"), "ONE\n");
});

test("missing-path recovery refuses ambiguous basename and tag matches", async () => {
  const cwd = await fixture();
  await mkdir(join(cwd, "a"));
  await mkdir(join(cwd, "b"));
  const first = join(cwd, "a", "same.txt");
  const second = join(cwd, "b", "same.txt");
  await writeFile(first, "same\n");
  await writeFile(second, "same\n");
  const firstRead = (await renderRead({ cwd, path: `${first}:1` })).text;
  await renderRead({ cwd, path: `${second}:1` });
  const tag = HEADER_RE.exec(firstRead)?.[2];
  assert.ok(tag);
  const result = await applyPatch({ cwd, patch: `[missing/same.txt#${tag}]\nREPLACE 1:\n+CHANGED` });
  assert.match(result, /file_not_found/);
  assert.equal(await readFile(first, "utf8"), "same\n");
  assert.equal(await readFile(second, "utf8"), "same\n");
});

test("deleting the synthetic trailing split row is a visible no-op", async () => {
  const cwd = await fixture();
  const path = join(cwd, "phantom.txt");
  await writeFile(path, "one\n");
  const read = (await renderRead({ cwd, path: `${path}:1` })).text;
  const result = await applyPatch({ cwd, patch: `${header(read)}\nDELETE 2` });
  assert.match(result, /synthetic trailing split row/);
  assert.equal(await readFile(path, "utf8"), "one\n");
});
