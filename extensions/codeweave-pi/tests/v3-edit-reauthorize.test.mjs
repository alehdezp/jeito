import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPatch } from "../src/core/patch-apply.ts";
import { computeTag, snapshots, SnapshotStore } from "../src/core/snapshot-store.ts";
import { renderRead } from "../src/core/read-renderer.ts";
import { registerReadTool } from "../src/tools/read.ts";
import { registerEditTool } from "../src/tools/edit.ts";

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-edit-reauth-")));
  t.after(async () => { snapshots.clear(); await rm(cwd, { recursive: true, force: true }); });
  return cwd;
}

function pressure(cwd) {
  for (let i = 0; i < 205; i++) snapshots.record(join(cwd, `cache-${i}`), "other\n", [1]);
}

test("cache eviction preserves editable delivered rows but never authorizes unseen rows", async t => {
  const cwd = await fixture(t);
  const path = join(cwd, "doc.txt");
  await writeFile(path, "one\ntwo\nthree\n");
  const read = await renderRead({ cwd, path: `${path}:1-1` });
  assert.deepEqual([...snapshots.byTag(path, read.tag).seenLines], [1]);
  pressure(cwd);
  assert.equal(snapshots.byTag(path, read.tag), undefined, "full text really was evicted");
  const held = await applyPatch({ cwd, patch: `[${path}#${read.tag}]\nREPLACE 2:\n+UNSEEN` });
  assert.ok(held.details.files.some(file => file.changes.some(change => change.reason === "unseen")));
  assert.equal(await readFile(path, "utf8"), "one\ntwo\nthree\n");
  const applied = await applyPatch({ cwd, patch: `[${path}#${read.tag}]\nREPLACE 1:\n+ONE` });
  assert.equal(applied.details.status, "success");
  assert.equal(await readFile(path, "utf8"), "ONE\ntwo\nthree\n");
});

test("compact authority survives text-byte eviction, respects full digest, and invalidates with its owner", () => {
  const store = new SnapshotStore({ maxPaths: 1, maxBytes: 4096 });
  const content = `first\n${"x".repeat(5000)}\nlast\n`;
  const blocks = [{ start: 1, end: 3, kind: "function", label: "fixture" }];
  const before = store.record("/fixture/a", content, [1, 3], blocks);
  store.record("/fixture/b", "second\n", [1]);
  assert.equal(store.byTag("/fixture/a", before.tag), undefined);
  assert.equal(store.restore("/fixture/a", "changed\n"), undefined);
  const restored = store.restore("/fixture/a", content);
  assert.deepEqual([...restored.seenLines], [1, 3]);
  assert.deepEqual(restored.blocks, blocks);
  store.record("/fixture/b", "second\n", [1]);
  const reread = store.record("/fixture/a", content, [2]);
  assert.deepEqual([...reread.seenLines].sort(), [1, 2, 3], "a partial reread must union, not erase, retained authority");
  assert.deepEqual(reread.blocks, blocks);
  store.invalidate("/fixture/a");
  assert.equal(store.restore("/fixture/a", content), undefined);
  store.clear();
  assert.equal(store.restore("/fixture/b", "second\n"), undefined);
});

test("existing active-branch read receipts recover authority without another read after memory loss", async t => {
  const cwd = await fixture(t);
  const path = join(cwd, "doc.txt");
  await writeFile(path, "one\ntwo\nthree\n");
  const tools = new Map();
  const pi = { registerTool(tool) { tools.set(tool.name, tool); } };
  registerReadTool(pi);
  registerEditTool(pi);
  const entries = [];
  const ctx = { cwd, sessionManager: { getSessionId: () => "same-session", getCwd: () => cwd, getBranch: () => entries, buildContextEntries: () => [] } };
  const read = await tools.get("read").execute("read-1", { path: "doc.txt:2-2" }, undefined, undefined, ctx);
  entries.push({ type: "message", message: { role: "toolResult", toolName: "read", content: read.content, details: read.details, isError: false } });
  // Deliberately discard all in-memory proof. The delivered transcript remains.
  snapshots.clear();
  const result = await tools.get("edit").execute("edit-1", { input: `[doc.txt#${read.details.tag}]\nREPLACE 2:\n+TWO` }, undefined, undefined, ctx);
  assert.equal(result.details.status, "success");
  assert.equal(await readFile(path, "utf8"), "one\nTWO\nthree\n");
  assert.match(result.content[0].text, /no additional read required/);
});

test("a matching tag without any delivered evidence does not invent authority", async t => {
  const cwd = await fixture(t);
  const path = join(cwd, "doc.txt");
  const text = "one\ntwo\n";
  await writeFile(path, text);
  const result = await applyPatch({ cwd, patch: `[${path}#${computeTag(text)}]\nREPLACE 2:\n+UNSEEN` });
  assert.ok(result.details.files.some(file => file.changes.some(change => change.reason === "unseen")));
  assert.equal(await readFile(path, "utf8"), text);
});

test("mismatched bytes still reject without changing the file", async t => {
  const cwd = await fixture(t);
  const path = join(cwd, "doc.txt");
  await writeFile(path, "one\ntwo\n");
  const result = await applyPatch({ cwd, patch: `[${path}#DEADBEEF]\nREPLACE 2:\n+NOPE` });
  assert.equal(result.details.status, "error");
  assert.equal(await readFile(path, "utf8"), "one\ntwo\n");
});

test("batch recovery uses delivered rows from the matching file, not its neighbor", async t => {
  const cwd = await fixture(t);
  for (const name of ["one.txt", "two.txt"]) await writeFile(join(cwd, name), "one\ntwo\n");
  const tools = new Map();
  const pi = { registerTool(tool) { tools.set(tool.name, tool); } };
  registerReadTool(pi);
  registerEditTool(pi);
  const entries = [];
  const ctx = { cwd, sessionManager: { getSessionId: () => "batch-session", getCwd: () => cwd, getBranch: () => entries } };
  const read = await tools.get("read").execute("read-batch", { paths: ["one.txt:1-2", "two.txt:1-2"] }, undefined, undefined, ctx);
  const delivered = read.content[0].text.replace("2:two\n", "");
  assert.notEqual(delivered, read.content[0].text, "simulate a final-delivery transform hiding only the first file's row");
  entries.push({ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: delivered }], details: read.details, isError: false } });
  snapshots.clear();
  const result = await tools.get("edit").execute("edit-batch", { input: `[one.txt#${read.details.files[0].tag}]\nREPLACE 2:\n+UNSEEN` }, undefined, undefined, ctx);
  assert.ok(result.details.files.some(file => file.changes.some(change => change.reason === "unseen")));
  assert.equal(await readFile(join(cwd, "one.txt"), "utf8"), "one\ntwo\n");
});
