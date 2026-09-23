import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { applyPatch } from "../src/core/patch-apply.ts";
import { renderRead } from "../src/core/read-renderer.ts";
import { computeTag, snapshots } from "../src/core/snapshot-store.ts";
import { canonicalExistingPath } from "../src/core/path-resolve.ts";
import { executeWrite } from "../src/core/write-core.ts";
import { formatUpdatedStamp, isUpdatedFieldEligiblePath, stampUpdatedField } from "../src/core/updated-field-stamp.ts";

const NOW = new Date("2026-09-21T18:33:45Z");
const stamp = (text, create = false) => stampUpdatedField(text, NOW, create).text;
const header = text => text.match(/^\[.+#[0-9A-F]{8}\]/m)?.[0];
const tag = text => text.match(/^\[.+#([0-9A-F]{8})\]/m)?.[1];
const metadata = text => parse(text.replace(/^\ufeff/, "").split(/\r?\n---(?:\r?\n|$)/)[0].replace(/^---\r?\n/, ""));
async function fixture(t, content, name = "doc.md") {
  const cwd = await mkdtemp(join(tmpdir(), "markdown-stamp-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, name);
  await mkdir(dirname(path), { recursive: true });
  if (content !== undefined) await writeFile(path, content);
  return { cwd, path };
}
async function edit(f, patch, range = "1-") {
  const read = await renderRead({ cwd: f.cwd, path: `${f.path}:${range}` });
  return applyPatch({ cwd: f.cwd, patch: `${header(read.text)}\n${patch}` });
}
function assertLanded(result, disk) {
  assert.equal(tag(typeof result === "string" ? result : result.text), computeTag(disk));
  const updated = metadata(disk).updated;
  assert.match(updated, /^\d{4}-\d{2}-\d{2} \d{2}Z$/);
  const time = Date.parse(updated.replace(" ", "T").replace("Z", ":00:00Z"));
  assert.ok(Math.abs(Date.now() - time) < 3_600_000 + 5000);
}

test("UTC hour format and byte-preserving replacement", () => {
  assert.equal(formatUpdatedStamp(NOW), "2026-09-21 18Z");
  const original = "\ufeff---\r\ntitle: 'Keep quotes'\r\nupdated : 'old' # keep comment\r\ncreated: 2000-01-01\r\n---\r\nBody\r\n";
  assert.equal(stamp(original, true), original.replace("'old'", '"2026-09-21 18Z"'));
});

test("missing metadata is added, with created only on new files", () => {
  assert.equal(stamp("# Doc\n", true), '---\ncreated: 2026-09-21\nupdated: "2026-09-21 18Z"\n---\n# Doc\n');
  assert.equal(stamp("# Doc\n"), '---\nupdated: "2026-09-21 18Z"\n---\n# Doc\n');
  assert.equal(stamp("---\ntitle: x\n---\nBody", true), '---\ntitle: x\ncreated: 2026-09-21\nupdated: "2026-09-21 18Z"\n---\nBody');
  assert.equal(stamp("---\n---\n"), '---\nupdated: "2026-09-21 18Z"\n---\n');
  assert.equal(stamp("", true), '---\ncreated: 2026-09-21\nupdated: "2026-09-21 18Z"\n---\n');
});

test("null updated before a comment keeps its separator and stays valid YAML", () => {
  for (const doc of ["---\nupdated: # managed\n---\nBody\n", "---\nupdated:  # managed\n---\nBody\n"]) {
    const out = stamp(doc);
    assert.match(out, /^updated: +"2026-09-21 18Z" # managed$/m);
    assert.equal(metadata(out).updated, "2026-09-21 18Z");
  }
});

 test("scalar values, supplied created and nested unrelated fields", () => {
  for (const value of ["", " ", "null", "true", "42", "''", '"old"']) {
    assert.equal(metadata(stamp(`---\nupdated:${value ? ' ' + value : ''}\n---\n`)).updated, "2026-09-21 18Z");
  }
  const doc = "---\ncreated: custom-value\nmeta:\n  updated: nested\n---\n";

  assert.equal(metadata(stamp(doc, true)).created, "custom-value");
  assert.equal(metadata(stamp(doc, true)).meta.updated, "nested");
  assert.equal(metadata(stamp("---\nupdated: old\n---\n", true)).created, "2026-09-21");
});

test("BOM/CRLF are preserved when fields or frontmatter are inserted", () => {
  for (const doc of ["\ufeffBody\r\n", "\ufeff---\r\ntitle: x\r\n---\r\nBody\r\n"]) {
    const result = stamp(doc, true);
    assert.ok(result.startsWith("\ufeff"));
    assert.ok(!result.replaceAll("\r\n", "").includes("\n"));
    assert.ok(result.endsWith("Body\r\n"));
  }
});

test("ambiguous frontmatter refuses rather than corrupts YAML", () => {
  for (const doc of [
    "---\nupdated: old\n", "---\nupdated: a\nupdated: b\n---\n",
    "---\nupdated: [a]\n---\n", "---\nupdated: |\n  old\n---\n",
    "---\nupdated: &date old\n---\n", "---\n{updated: old}\n---\n",
  ]) assert.throws(() => stamp(doc), /Markdown timestamp:/);
});

test("goals and skills qualify; dependencies and pristine upstream do not", () => {
  for (const path of ["/project/.pi/goals/g/goal.md", "/project/.agents/skills/x/SKILL.md", "/tmp/docs/a.MD", "/project/a.markdown"]) {
    assert.ok(isUpdatedFieldEligiblePath(path), path);
  }
  for (const path of ["/project/vendor/a.md", "/project/node_modules/pkg/a.md", "/project/.runtime/a.md", "/project/README.upstream.md", "/project/native/pi-nav/prompts/a.md", "/project/a.ts"]) {
    assert.ok(!isUpdatedFieldEligiblePath(path), path);
  }
});

test("write creates both timestamps and returns final-byte authority", async t => {
  const f = await fixture(t, undefined, ".pi/goals/g/goal.md");
  const result = await executeWrite({ ...f, content: "# Goal\n" });
  const disk = await readFile(f.path, "utf8");
  assertLanded(result, disk);
  assert.match(metadata(disk).created, /^\d{4}-\d{2}-\d{2}$/);
});

test("write preserves supplied created; overwrite does not invent it", async t => {
  const f = await fixture(t, undefined);
  await executeWrite({ ...f, content: "---\ncreated: 1999-01-01\n---\nBody\n" });
  assert.equal(metadata(await readFile(f.path, "utf8")).created, "1999-01-01");
  const result = await executeWrite({ ...f, overwrite: true, content: "New body\n" });
  const disk = await readFile(f.path, "utf8");
  assertLanded(result, disk);
  assert.equal(metadata(disk).created, undefined);
  assert.match(await executeWrite({ ...f, overwrite: true, content: disk }), /No content changes/);
  assert.equal(await readFile(f.path, "utf8"), disk);
});

test("edit inserts metadata and remaps returned coordinates and follow-up authority", async t => {
  const f = await fixture(t, "# Goal\nBody\nUnchanged\n");
  const result = await edit(f, "REPLACE 2:\n+Changed");
  assert.equal(result.details.status, "success");
  const disk = await readFile(f.path, "utf8");
  assertLanded(result, disk);
  assert.match(result.text, /REPLACE 2\.\.2 → lines 5/);
  assert.equal(disk.split("\n")[4], "Changed");
  const follow = await applyPatch({ cwd: f.cwd, patch: `${header(result.text)}\nREPLACE 6:\n+Still authorized` });
  assert.equal(follow.details.status, "success");
});

test("edit inserts missing updated inside frontmatter without changing created", async t => {
  const f = await fixture(t, "---\ncreated: 2000-01-01\n---\nBody\n");
  const result = await edit(f, "REPLACE 4:\n+Changed");
  const disk = await readFile(f.path, "utf8");
  assertLanded(result, disk);
  assert.equal(metadata(disk).created, "2000-01-01");
  assert.match(result.text, /REPLACE 4\.\.4 → lines 5/);
});

test("existing updated replacement preserves BOM and CRLF", async t => {
  const f = await fixture(t, "\ufeff---\r\nupdated: old # comment\r\n---\r\nBody\r\n");
  const result = await edit(f, "REPLACE 4:\n+Changed");
  const disk = await readFile(f.path, "utf8");
  assertLanded(result, disk);
  assert.ok(disk.startsWith("\ufeff"));
  assert.ok(!disk.replaceAll("\r\n", "").includes("\n"));
  assert.match(disk, / # comment\r\n/);
});

test("no-op, unseen, cancelled and failed edits do not touch metadata", async t => {
  const content = "# Doc\nBody\n" + "unseen\n".repeat(50);
  const f = await fixture(t, content);
  assert.equal((await edit(f, "REPLACE 2:\n+Body")).details.files[0].status, "skipped");
  assert.equal(await readFile(f.path, "utf8"), content);
  // Use a new path and narrow read so the full read above grants no authority.
  const hidden = await fixture(t, content);
  const held = await edit(hidden, "REPLACE 40:\n+No authority", "1-2");
  assert.notEqual(held.details.status, "success");
  assert.equal(await readFile(hidden.path, "utf8"), content);
  const read = await renderRead({ cwd: f.cwd, path: f.path });
  const cancelled = await applyPatch({ cwd: f.cwd, patch: `${header(read.text)}\nREPLACE 2:\n+Changed`, signal: AbortSignal.abort() });
  assert.ok(cancelled.details.cancelled);
  assert.equal(await readFile(f.path, "utf8"), content);
  await chmod(f.path, 0o444);
  const failed = await edit(f, "REPLACE 2:\n+Changed");
  await chmod(f.path, 0o644);
  assert.equal(failed.details.status, "error");
  assert.equal(await readFile(f.path, "utf8"), content);
});

test("invalid YAML refuses only its file; ordinary writes also refuse before landing", async t => {
  const bad = "---\nupdated: a\nupdated: b\n---\nBody\n";
  const f = await fixture(t, bad);
  const result = await edit(f, "REPLACE 5:\n+Changed");
  assert.equal(result.details.status, "error");
  assert.equal(await readFile(f.path, "utf8"), bad);
  await assert.rejects(executeWrite({ ...f, overwrite: true, content: bad + "more" }), /Markdown timestamp:/);
  assert.equal(await readFile(f.path, "utf8"), bad);
});

test("dependency paths and symlink targets do not get metadata", async t => {
  const f = await fixture(t, "Body\n", "node_modules/pkg/doc.md");
  await edit(f, "REPLACE 1:\n+Changed");
  assert.equal(await readFile(f.path, "utf8"), "Changed\n");
  const alias = join(f.cwd, "alias.md");
  await symlink(f.path, alias);
  await executeWrite({ cwd: f.cwd, path: alias, content: "Rewritten\n", overwrite: true });
  assert.equal(await readFile(f.path, "utf8"), "Rewritten\n");
});

test("metadata insertion does not authorize unseen body rows", async t => {
  const f = await fixture(t, "# Doc\nBody\n" + "hidden\n".repeat(50));
  const result = await edit(f, "REPLACE 2:\n+Changed", "1-2");
  const disk = await readFile(f.path, "utf8");
  assertLanded(result, disk);
  assert.ok(!snapshots.byTag(canonicalExistingPath(f.path), tag(result.text)).seenLines.has(40));
  const held = await applyPatch({ cwd: f.cwd, patch: `${header(result.text)}\nREPLACE 40:\n+Unauthorized` });
  assert.notEqual(held.details.status, "success");
  assert.equal(await readFile(f.path, "utf8"), disk);
});

test("moving the edit preview to metadata does not authorize unseen neighbors of a distant edit", async t => {
  const f = await fixture(t, Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const result = await edit(f, "REPLACE 40:\n+Changed", "40-40");
  const state = snapshots.byTag(canonicalExistingPath(f.path), tag(result.text));
  assert.ok(state.seenLines.has(43), "the authored row moves past three metadata lines");
  assert.ok(!state.seenLines.has(44), "its unseen neighbor was not in the final preview");
  assert.match(result.text, /REPLACE 40\.\.40 → lines 43/);
});

test("same-path sections compose before metadata insertion", async t => {
  const f = await fixture(t, "one\ntwo\nthree\n");
  const read = await renderRead({ cwd: f.cwd, path: `${f.path}:1-3` });
  const h = header(read.text);
  const result = await applyPatch({ cwd: f.cwd, patch: `${h}\nREPLACE 1:\n+ONE\n${h}\nREPLACE 3:\n+THREE` });
  assert.equal(result.details.status, "success");
  const disk = await readFile(f.path, "utf8");
  assertLanded(result, disk);
  assert.ok(disk.endsWith("ONE\ntwo\nTHREE\n"));
  assert.equal(disk.match(/updated:/g).length, 1);
});

test("a held change can retry after an independent Markdown change added metadata", async t => {
  const f = await fixture(t, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const read = await renderRead({ cwd: f.cwd, path: `${f.path}:1-1` });
  const result = await applyPatch({ cwd: f.cwd, patch: `${header(read.text)}\nREPLACE 1:\n+ONE\nREPLACE 40:\n+FORTY` });
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.residuals.length, 1, result.text);
  const retried = await applyPatch({ cwd: f.cwd, patch: "RETRY" });
  assert.equal(retried.details.status, "success");
  assert.match(await readFile(f.path, "utf8"), /^FORTY$/m);
});
