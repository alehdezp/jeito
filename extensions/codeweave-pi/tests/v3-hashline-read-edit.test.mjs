import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { applyPatch as applyPatchResult } from "../src/core/patch-apply.ts";
import { renderRead } from "../src/core/read-renderer.ts";
import { normalizeSummaryResult } from "../src/core/summary-normalize.ts";
import { renderSmartSummaryWithMetadata } from "../src/core/summary-renderer.ts";
import { canonicalExistingPath } from "../src/core/path-resolve.ts";
import { computeTag, SnapshotStore, snapshots } from "../src/core/snapshot-store.ts";
import { editParams } from "../src/tools/edit.ts";
import { executeWrite } from "../src/core/write-core.ts";
import { withLocalFileMutationQueues } from "../src/core/mutation-queue.ts";
const applyPatch = async params => (await applyPatchResult(params)).text;

const HEADER_RE = /^\[(.+)#([0-9A-F]{8})\]/m;
const execFileP = promisify(execFile);

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-hashline-"));
}

function header(text) {
  const match = HEADER_RE.exec(text);
  assert.ok(match, `missing hashline header:\n${text}`);
  return match[0];
}

test("edit exposes only the current hashline input contract", () => {
  assert.deepEqual(Object.keys(editParams.properties), ["input"]);
});

test("public edit hashes use exactly eight hex digits and reject four-hex legacy input", async () => {
  const cwd = await fixture();
  const path = join(cwd, "eight.txt");
  await writeFile(path, "one\n");
  const read = (await renderRead({ cwd, path: `${path}:1-1` })).text;
  assert.match(read, HEADER_RE);
  await assert.rejects(applyPatch({ cwd, patch: `[${path}#${header(read).slice(-5, -1)}]\nREPLACE 1:\n+ONE` }), /eight-hex hash/);
});


test("eight-hex collisions fail closed and relocation preserves one exact digest", () => {
  const store = new SnapshotStore({ maxVersionsPerPath: 4 });
  const first = store.record("/tmp/collision.txt", "collision-64285\n", [1]);
  const second = store.record("/tmp/collision.txt", "collision-112346\n", [1]);
  assert.equal(first.tag, "EEC82692");
  assert.equal(second.tag, first.tag);
  assert.equal(store.byTag("/tmp/collision.txt", first.tag), undefined);
  assert.equal(store.findByTag(first.tag).length, 2);
  const destination = store.record("/tmp/destination.txt", "occupied\n", [1]);
  assert.equal(store.relocate("/tmp/collision.txt", "/tmp/destination.txt", first.digest), false);
  store.invalidate(destination.canonicalPath);
  assert.equal(store.relocate("/tmp/collision.txt", "/tmp/moved.txt", first.digest), true);
  assert.equal(store.byTag("/tmp/collision.txt", first.tag), undefined);
  assert.equal(store.byTag("/tmp/moved.txt", first.tag)?.digest, first.digest);
});

test("whole-file write authorship supports a natural follow-up edit without rereading", async () => {
  const cwd = await fixture();
  const path = join(cwd, "written.txt");
  const content = `${Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
  const written = await executeWrite({ cwd, path, content });
  const edited = await applyPatch({ cwd, patch: `${header(written)}\nREPLACE 50:\n+LINE 50` });
  assert.match(edited, HEADER_RE);
  assert.match(await readFile(path, "utf8"), /^LINE 50$/m);
});

test("one multi-range read authorizes distant same-file operations in one edit", async () => {
  const cwd = await fixture();
  const path = join(cwd, "multi.txt");
  await writeFile(path, "one\ntwo\nthree\nfour\nfive\nsix\n");

  const read = (await renderRead({ cwd, path: `${path}:1-2,5-6` })).text;
  assert.match(read, /^\[.*#\w{8}\]\n1:one\n2:two\n…\n5:five\n6:six/m);
  const edited = await applyPatch({ cwd, patch: `${header(read)}\nREPLACE 2:\n+TWO\nINSERT AFTER 5:\n+five-and-a-half` });

  assert.match(edited, HEADER_RE);
  assert.match(edited, /Next edit: use this hash with current coordinates/);
  assert.match(edited, /earlier in-session hash with that snapshot's original coordinates/);
  assert.equal(await readFile(path, "utf8"), "one\nTWO\nthree\nfour\nfive\nfive-and-a-half\nsix\n");
});

test("multi-file validation holds an invalid operation while a valid file still lands", async () => {
  const cwd = await fixture();
  const a = join(cwd, "a.txt");
  const b = join(cwd, "b.txt");
  await writeFile(a, "a1\na2\n");
  await writeFile(b, "b1\nb2\n");
  const aRead = (await renderRead({ cwd, path: `${a}:1-2` })).text;
  const bRead = (await renderRead({ cwd, path: `${b}:1-2` })).text;

  const result = await applyPatch({ cwd, patch: `${header(aRead)}\nREPLACE 1:\n+A1\n${header(bRead)}\nREPLACE 99:\n+B99` });
  assert.match(result, /outside the current source bounds/);
  assert.equal(await readFile(a, "utf8"), "A1\na2\n");
  assert.equal(await readFile(b, "utf8"), "b1\nb2\n");
});

test("multi-file commit failure preserves an earlier independently landed file", async () => {
  const cwd = await fixture();
  const a = join(cwd, "rollback-a.txt");
  const b = join(cwd, "rollback-b.txt");
  await writeFile(a, "a1\n");
  await writeFile(b, "b1\n");
  const aRead = (await renderRead({ cwd, path: `${a}:1` })).text;
  const bRead = (await renderRead({ cwd, path: `${b}:1` })).text;
  await chmod(b, 0o444);
  let result;
  try {
    result = await applyPatch({ cwd, patch: `${header(aRead)}\nREPLACE 1:\n+A1\n${header(bRead)}\nREPLACE 1:\n+B1` });
  } finally {
    await chmod(b, 0o644);
  }
  assert.match(result, /Needs attention/);
  assert.match(result, /commit_failed/);
  assert.equal(await readFile(a, "utf8"), "A1\n");
  assert.equal(await readFile(b, "utf8"), "b1\n");
});

test("atomic content replacement preserves mode and macOS extended attributes without staging debris", { skip: process.platform !== "darwin" }, async () => {
  const cwd = await fixture();
  const path = join(cwd, "metadata.txt");
  await writeFile(path, "before\n");
  await chmod(path, 0o640);
  await execFileP("/usr/bin/xattr", ["-w", "com.pi.navigation-test", "preserved", path]);
  const read = (await renderRead({ cwd, path: `${path}:1-1` })).text;
  await applyPatch({ cwd, patch: `${header(read)}\nREPLACE 1:\n+after` });
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  const attribute = await execFileP("/usr/bin/xattr", ["-p", "com.pi.navigation-test", path]);
  assert.equal(attribute.stdout.trim(), "preserved");
  assert.deepEqual((await readdir(cwd)).filter(name => name.includes(".pi-edit-")), []);
});

test("DELETE FILE requires an exact current hash and removes the snapshot", async () => {
  const cwd = await fixture();
  const path = join(cwd, "delete-me.txt");
  await writeFile(path, "one\ntwo\n");
  const read = (await renderRead({ cwd, path: `${path}:1-1` })).text;
  const result = await applyPatch({ cwd, patch: `${header(read)}\nDELETE FILE` });
  assert.match(result, /Deleted file .*delete-me\.txt \(verified hash #[0-9A-F]{8}\)/);
  await assert.rejects(access(path), /ENOENT/);
  await writeFile(path, "replacement\n");
  assert.match(await applyPatch({ cwd, patch: `${header(read)}\nDELETE FILE` }), /unknown_hash|whole-file operations require the exact current hash/);
  assert.equal(await readFile(path, "utf8"), "replacement\n");
});

test("MOVE FILE preserves bytes, hash authority, and supports an immediate edit at the destination", async () => {
  const cwd = await fixture();
  await mkdir(join(cwd, "moved"));
  const source = join(cwd, "source.txt");
  const destination = join(cwd, "moved", "destination.txt");
  await writeFile(source, "one\ntwo\n");
  const read = (await renderRead({ cwd, path: `${source}:1-2` })).text;
  const originalHash = HEADER_RE.exec(read)?.[2];
  const moved = await applyPatch({ cwd, patch: `${header(read)}\nMOVE FILE TO moved/destination.txt` });
  assert.match(moved, new RegExp(`^\\[moved/destination\\.txt#${originalHash}\\]`, "m"));
  await assert.rejects(access(source), /ENOENT/);
  assert.equal(await readFile(destination, "utf8"), "one\ntwo\n");
  const edited = await applyPatch({ cwd, patch: `${header(moved)}\nREPLACE 2:\n+TWO` });
  assert.match(edited, HEADER_RE);
  assert.equal(await readFile(destination, "utf8"), "one\nTWO\n");
});

test("whole-file operations reject destination, symlink, and mixed-operation hazards", async () => {
  const cwd = await fixture();
  const source = join(cwd, "hazard.txt");
  const existing = join(cwd, "EXISTING.txt");
  await writeFile(source, "safe\n");
  await writeFile(existing, "occupied\n");
  const read = (await renderRead({ cwd, path: `${source}:1` })).text;
  assert.match(await applyPatch({ cwd, patch: `${header(read)}\nMOVE FILE TO existing.txt` }), /casefold_collision|destination_exists/);
  assert.match(await applyPatch({ cwd, patch: `${header(read)}\nDELETE FILE\nREPLACE 1:\n+unsafe` }), /whole-file operation must be the only operation|must be the only operation/);
  const link = join(cwd, "link.txt");
  await symlink(source, link);
  const linkRead = (await renderRead({ cwd, path: `${link}:1` })).text;
  assert.match(await applyPatch({ cwd, patch: `${header(linkRead)}\nDELETE FILE` }), /symlink_source/);
  assert.equal(await readFile(source, "utf8"), "safe\n");
});

test("MOVE FILE accepts an explicit destination outside the session root", async () => {
  const cwd = await fixture();
  const source = join(cwd, "external-move.txt");
  const destination = join(cwd, "..", `external-move-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  await writeFile(source, "outside\n");
  const read = (await renderRead({ cwd, path: `${source}:1` })).text;
  const moved = await applyPatch({ cwd, patch: `${header(read)}\nMOVE FILE TO ${destination}` });
  assert.match(moved, /Moved/);
  assert.equal(await readFile(destination, "utf8"), "outside\n");
  await rm(destination, { force: true });
});

test("mixed DELETE FILE and content commit failure keeps the independent deletion landed", async () => {
  const cwd = await fixture();
  const deleted = join(cwd, "rollback-delete.txt");
  const blocked = join(cwd, "rollback-blocked.txt");
  await writeFile(deleted, "restore me\n");
  await writeFile(blocked, "blocked\n");
  const deleteRead = (await renderRead({ cwd, path: `${deleted}:1` })).text;
  const blockedRead = (await renderRead({ cwd, path: `${blocked}:1` })).text;
  await chmod(blocked, 0o444);
  let result;
  try {
    result = await applyPatch({ cwd, patch: `${header(deleteRead)}\nDELETE FILE\n${header(blockedRead)}\nREPLACE 1:\n+BLOCKED` });
  } finally {
    await chmod(blocked, 0o644);
  }
  assert.match(result, /Needs attention/);
  await assert.rejects(access(deleted), /ENOENT/);
  assert.equal(await readFile(blocked, "utf8"), "blocked\n");
});

test("overlapping multi-path mutation queues serialize without path-order deadlock", async () => {
  const events = [];
  const first = withLocalFileMutationQueues(["/tmp/b", "/tmp/a"], async () => {
    events.push("first:start");
    await new Promise(resolve => setTimeout(resolve, 25));
    events.push("first:end");
  });
  const second = withLocalFileMutationQueues(["/tmp/a", "/tmp/b"], async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("unseen anchors reveal bounded full lines and a straight retry succeeds", async () => {
  const cwd = await fixture();
  const path = join(cwd, "seen.txt");
  await writeFile(path, "l1\nl2\nl3\nl4\nl5\n");
  const read = (await renderRead({ cwd, path: `${path}:1-2` })).text;
  const input = `${header(read)}\nREPLACE 4:\n+L4`;

  const held = await applyPatch({ cwd, patch: input });
  assert.match(held, /Held remaining change/);
  assert.match(held, /Actual file content at those lines:/);
  assert.match(held, /4:l4/);
  assert.equal(await readFile(path, "utf8"), "l1\nl2\nl3\nl4\nl5\n");
  const retried = await applyPatch({ cwd, patch: input });
  assert.match(retried, HEADER_RE);
  assert.equal(await readFile(path, "utf8"), "l1\nl2\nl3\nL4\nl5\n");
});

test("stale same-line anchors recover when an earlier edit changed another region", async () => {
  const cwd = await fixture();
  const path = join(cwd, "chain.txt");
  await writeFile(path, "l1\nl2\nl3\nl4\nl5\nl6\n");
  const read = (await renderRead({ cwd, path: `${path}:1-6` })).text;
  const oldHeader = header(read);
  await applyPatch({ cwd, patch: `${oldHeader}\nREPLACE 2:\n+L2` });

  const recovered = await applyPatch({ cwd, patch: `${oldHeader}\nREPLACE 5:\n+L5` });
  assert.match(recovered, /Recovered .*three-way merge|Recovered .*session-chain replay|Recovered the stale hash because every edited anchor/);
  assert.equal(await readFile(path, "utf8"), "l1\nL2\nl3\nl4\nL5\nl6\n");
});

test("stale original insert anchor remaps after an earlier insert shifts the observed line", async () => {
  const cwd = await fixture();
  const path = join(cwd, "insert-shift.txt");
  await writeFile(path, "l1\nl2\nl3\nl4\nl5\nl6\n");
  const read = (await renderRead({ cwd, path: `${path}:1-6` })).text;
  const oldHeader = header(read);
  await applyPatch({ cwd, patch: `${oldHeader}\nINSERT BEFORE 1:\n+prepended` });

  const recovered = await applyPatch({ cwd, patch: `${oldHeader}\nINSERT AFTER 5:\n+after-l5` });
  assert.match(recovered, /Recovered .*three-way merge|Recovered .*session-chain replay|unchanged-line remapping with one uniform \+1 line offset/);
  assert.equal(await readFile(path, "utf8"), "prepended\nl1\nl2\nl3\nl4\nl5\nafter-l5\nl6\n");
});

test("stale anchors remap one proven uniform line shift", async () => {
  const cwd = await fixture();
  const path = join(cwd, "shift.txt");
  await writeFile(path, "l1\nl2\nl3\nl4\nl5\nl6\n");
  const read = (await renderRead({ cwd, path: `${path}:1-6` })).text;
  const oldHeader = header(read);
  await applyPatch({ cwd, patch: `${oldHeader}\nINSERT AFTER 2:\n+inserted` });

  const recovered = await applyPatch({ cwd, patch: `${oldHeader}\nREPLACE 5:\n+L5` });
  assert.match(recovered, /Recovered external file drift by exact-context three-way merge|unchanged-line remapping with one uniform \+1 line offset/);
  assert.equal(await readFile(path, "utf8"), "l1\nl2\ninserted\nl3\nl4\nL5\nl6\n");
});
test("stale recovery does not carry shifted historical seen-line coordinates into the fresh hash", async () => {
  const cwd = await fixture();
  const path = join(cwd, "shifted-provenance.txt");
  const original = `${Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
  await writeFile(path, original);
  const read = (await renderRead({ cwd, path: `${path}:80-80,90-90` })).text;
  const oldHeader = header(read);
  await writeFile(path, `external header\n${original}`);

  const recovered = await applyPatch({ cwd, patch: `${oldHeader}\nREPLACE 90:\n+LINE 90` });
  assert.match(recovered, /Recovered external file drift by exact-context three-way merge|unchanged-line remapping with one uniform \+1 line offset/);
  const wrongShiftedCoordinate = `${header(recovered)}\nREPLACE 80:\n+WRONG`;
  const held = await applyPatch({ cwd, patch: wrongShiftedCoordinate });
  assert.match(held, /Held remaining change/);
  assert.match(await readFile(path, "utf8"), /^line 79$/m);
});


test("stale recovery refuses an anchor changed by an earlier edit", async () => {
  const cwd = await fixture();
  const path = join(cwd, "conflict.txt");
  await writeFile(path, "l1\nl2\nl3\n");
  const read = (await renderRead({ cwd, path: `${path}:1-3` })).text;
  const oldHeader = header(read);
  await applyPatch({ cwd, patch: `${oldHeader}\nREPLACE 2:\n+FIRST` });
  const held = await applyPatch({ cwd, patch: `${oldHeader}\nREPLACE 2:\n+SECOND` });
  assert.match(held, /stale source could not be remapped safely/);
  assert.equal(await readFile(path, "utf8"), "l1\nFIRST\nl3\n");
});

test("structural summaries preserve source rows, elisions, and grouped range guidance", () => {
  const lines = Array.from({ length: 40 }, (_, index) => index === 4 ? "export function work() {" : index === 29 ? "}" : `line ${index + 1}`);
  const text = normalizeSummaryResult({ cwd: "/tmp", absolutePath: "/tmp/demo.ts", displayPath: "demo.ts", kind: "file", lines, text: lines.join("\n"), extension: ".ts" }, {
    title: "source summary",
    totalLines: 40,
    entries: [{ label: "function work", start: 5, end: 30, kind: "function" }],
  });
  assert.match(text, /1:line 1/);
  assert.match(text, /5:export function work/);
  assert.match(text, /30:}/);
  assert.match(text, /…/);
  assert.match(text, /demo\.ts:\d+-\d+(?:,\d+-\d+)?/);
});

test("fresh edit output supports a shifted follow-up edit without another read", async () => {
  const cwd = await fixture();
  const path = join(cwd, "follow-up.txt");
  await writeFile(path, "l1\nl2\nl3\nl4\nl5\nl6\n");
  const read = (await renderRead({ cwd, path: `${path}:1-6` })).text;
  const first = await applyPatch({ cwd, patch: `${header(read)}\nINSERT AFTER 2:\n+inserted` });
  assert.match(first, /6:l5/, "edit response should show the renumbered downstream line");

  const second = await applyPatch({ cwd, patch: `${header(first)}\nREPLACE 6:\n+L5` });
  assert.match(second, HEADER_RE);
  assert.equal(await readFile(path, "utf8"), "l1\nl2\ninserted\nl3\nl4\nL5\nl6\n");
});

test("multi-hunk edit results expose every post-edit coordinate for reread-free continuation", async () => {
  const cwd = await fixture();
  const path = join(cwd, "post-coordinates.txt");
  await writeFile(path, "one\ntwo\nthree\nfour\nfive\nsix\n");
  const read = (await renderRead({ cwd, path: `${path}:1-6` })).text;
  const first = await applyPatch({ cwd, patch: `${header(read)}\nINSERT AFTER 2:\n+inserted\nREPLACE 5:\n+FIVE\nDELETE 3..4` });
  assert.match(first, /INSERT AFTER 2 → lines 3/);
  assert.match(first, /REPLACE 5\.\.5 → lines 4/);
  assert.match(first, /DELETE 3\.\.4 → removed/);
  await applyPatch({ cwd, patch: `${header(first)}\nREPLACE 4:\n+FIVE AGAIN` });
  assert.equal(await readFile(path, "utf8"), "one\ntwo\ninserted\nFIVE AGAIN\nsix\n");
});

test("fresh edit hashes preserve displayed provenance instead of authorizing the whole file", async () => {
  const cwd = await fixture();
  const path = join(cwd, "post-edit-unseen.txt");
  await writeFile(path, `${Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n")}\n`);
  const read = (await renderRead({ cwd, path: `${path}:1-3` })).text;
  const first = await applyPatch({ cwd, patch: `${header(read)}\nREPLACE 2:\n+LINE 2` });
  const secondInput = `${header(first)}\nREPLACE 50:\n+LINE 50`;

  const held = await applyPatch({ cwd, patch: secondInput });
  assert.match(held, /Held remaining change/);
  assert.match(held, /50:line 50/);
  await applyPatch({ cwd, patch: secondInput });
  assert.match(await readFile(path, "utf8"), /^LINE 50$/m);
});

test("current DELETE and INSERT edge operations compose under one original-line hash", async () => {
  const cwd = await fixture();
  const path = join(cwd, "ops.txt");
  await writeFile(path, "one\ntwo\nthree\nfour\n");
  const read = (await renderRead({ cwd, path: `${path}:1-4` })).text;
  await applyPatch({ cwd, patch: `${header(read)}\nINSERT AT START:\n+zero\nDELETE 2..3\nINSERT AT END:\n+five` });
  assert.equal(await readFile(path, "utf8"), "zero\none\nfour\nfive\n");
});

test("repeated same-path sections compose when their hashes agree", async () => {
  const cwd = await fixture();
  const path = join(cwd, "merged.txt");
  await writeFile(path, "one\ntwo\nthree\n");
  const read = (await renderRead({ cwd, path: `${path}:1-3` })).text;
  const h = header(read);
  const edited = await applyPatch({ cwd, patch: `${h}\nREPLACE 1:\n+ONE\n${h}\nREPLACE 3:\n+THREE` });
  assert.match(edited, /Composed 2 same-path sections/);
  assert.equal(await readFile(path, "utf8"), "ONE\ntwo\nTHREE\n");
});

test("over-cap unseen reveals stay closed across retries", async () => {
  const cwd = await fixture();
  const path = join(cwd, "wide-unseen.txt");
  await writeFile(path, `${Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n")}\n`);
  const read = (await renderRead({ cwd, path: `${path}:1-1` })).text;
  const deletes = Array.from({ length: 41 }, (_, index) => `DELETE ${50 + index}`).join("\n");
  const input = `${header(read)}\n${deletes}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const held = await applyPatch({ cwd, patch: input });
    assert.match(held, /Held remaining change/);
    assert.match(held, /50:line 50/);
    assert.doesNotMatch(held, /90:line 90/);
    assert.match(held, /Read the complete held range/);
  }
  assert.match(await readFile(path, "utf8"), /line 90/);
});

test("raw inspection does not mint hidden hash authority", async () => {
  const cwd = await fixture();
  const path = join(cwd, "raw-only.txt");
  const text = "one\ntwo\nthree\n";
  await writeFile(path, text);
  const canonical = canonicalExistingPath(path);
  snapshots.invalidate(canonical);
  const raw = (await renderRead({ cwd, path: `${path}:raw` })).text;
  assert.doesNotMatch(raw, HEADER_RE);
  assert.equal(snapshots.byTag(canonical, computeTag(text)), undefined);
});

test("oh-my-pi operation syntax is rejected in favor of the single natural language", async () => {
  const cwd = await fixture();
  const path = join(cwd, "canonical.txt");
  await writeFile(path, "one\n");
  const read = (await renderRead({ cwd, path: `${path}:1` })).text;
  assert.match(await applyPatch({ cwd, patch: `${header(read)}\nSWAP 1.=1:\n+ONE` }), /SWAP\/DEL\/INS syntax is not supported/);
  assert.match(await applyPatch({ cwd, patch: `${header(read)}\nDEL 1` }), /SWAP\/DEL\/INS syntax is not supported/);
  assert.match(await applyPatch({ cwd, patch: `${header(read)}\nINS.POST 1:\n+ONE` }), /SWAP\/DEL\/INS syntax is not supported/);
});

test("body-row recovery is explicit in the successful edit result", async () => {
  const cwd = await fixture();
  const path = join(cwd, "body-recovery.txt");
  await writeFile(path, "one\ntwo\n");
  const read = (await renderRead({ cwd, path: `${path}:1-2` })).text;
  const numbered = await applyPatch({ cwd, patch: `${header(read)}\nREPLACE 1:\n1:ONE` });
  assert.match(numbered, /Normalized 1 pasted LINE:TEXT body row/);
  const bare = await applyPatch({ cwd, patch: `${header(numbered)}\nREPLACE 2:\nTWO` });
  assert.match(bare, /Accepted 1 body row\(s\) without the canonical \+TEXT prefix/);
  assert.equal(await readFile(path, "utf8"), "ONE\nTWO\n");
});

test("validated structural summaries retain exact snapshot block spans", async () => {
  const cwd = await fixture();
  const path = join(cwd, "blocks.ts");
  const lines = Array.from({ length: 130 }, (_, index) => index === 9 ? "export function work() {" : index === 119 ? "}" : `// line ${index + 1}`);
  const provider = {
    name: "fixture-structural",
    priority: 1,
    canHandle: () => true,
    async summarize() {
      return { title: "source summary", totalLines: lines.length, entries: [{ start: 10, end: 120, label: "fn work()", kind: "function", confidence: "medium" }] };
    },
  };
  const rendered = await renderSmartSummaryWithMetadata({ cwd, absolutePath: path, displayPath: path, normalized: `${lines.join("\n")}\n`, lines, kind: "file" }, { providers: [provider] });
  assert.deepEqual(rendered?.blocks, [{ start: 10, end: 120, kind: "function", label: "function work", parser: "tree-sitter-wasm", grammar: "typescript", grammarVersion: "0.26" }]);
  assert.match(rendered?.text ?? "", /Certified whole-block anchors: line 10 function work → 10\.\.120/);
});

test("tree-sitter certification replaces an incorrect heuristic span with the exact syntax boundary", async () => {
  const cwd = await fixture();
  const path = join(cwd, "bad-block.ts");
  const lines = ["// before", "function bad() {", "  return 1;", "}", "// not part of function", "// claimed end"];
  const provider = {
    name: "fixture-bad-structural",
    priority: 1,
    canHandle: () => true,
    async summarize() {
      return { title: "source summary", totalLines: lines.length, entries: [{ start: 2, end: 6, label: "fn bad()", kind: "function", confidence: "high" }] };
    },
  };
  const rendered = await renderSmartSummaryWithMetadata({ cwd, absolutePath: path, displayPath: path, normalized: `${lines.join("\n")}\n`, lines, kind: "file" }, { providers: [provider] });
  assert.deepEqual(rendered?.blocks, [{ start: 2, end: 4, kind: "function", label: "function bad", parser: "tree-sitter-wasm", grammar: "typescript", grammarVersion: "0.26" }]);
});

test("full exact code reads certify deterministic blocks without a structural reread", async () => {
  const cwd = await fixture();
  const path = join(cwd, "exact-block.ts");
  await writeFile(path, "const before = 1;\nfunction work() {\n  return 1;\n}\nconst after = 2;\n");
  const read = await renderRead({ cwd, path: "exact-block.ts" });
  const tag = HEADER_RE.exec(read.text)?.[2];
  assert.ok(tag);
  const result = await applyPatch({ cwd, patch: `[exact-block.ts#${tag}]\nDELETE BLOCK AT 2` });
  assert.match(result, /Resolved DELETE BLOCK AT 2 to original lines 2\.\.4/);
  assert.equal(await readFile(path, "utf8"), "const before = 1;\nconst after = 2;\n");
});

test("natural block operations resolve only from exact snapshot metadata", async () => {
  const cwd = await fixture();
  const path = join(cwd, "block-ops.ts");
  const text = "function one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}\n";
  await writeFile(path, text);
  const canonical = canonicalExistingPath(path);
  const snapshot = snapshots.record(canonical, text, [1, 3, 5, 7], [
    { start: 1, end: 3, kind: "function", label: "fn one()" },
    { start: 5, end: 7, kind: "function", label: "fn two()" },
  ]);
  const result = await applyPatch({ cwd, patch: `[${path}#${snapshot.tag}]\nREPLACE BLOCK AT 1:\n+function one() { return 10; }\nINSERT AFTER BLOCK AT 5:\n+const afterTwo = true;` });
  assert.match(result, /Resolved REPLACE BLOCK AT 1 to original lines 1\.\.3/);
  assert.match(result, /Resolved INSERT AFTER BLOCK AT 5 to original lines 5\.\.7/);
  assert.equal(await readFile(path, "utf8"), "function one() { return 10; }\n\nfunction two() {\n  return 2;\n}\nconst afterTwo = true;\n");
});

test("fresh edit hashes retain unaffected certified blocks at their shifted coordinates", async () => {
  const cwd = await fixture();
  const path = join(cwd, "block-continuation.ts");
  const text = "function one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}\n";
  await writeFile(path, text);
  const canonical = canonicalExistingPath(path);
  const snapshot = snapshots.record(canonical, text, [1, 3, 5, 7], [
    { start: 1, end: 3, kind: "function", label: "fn one()" },
    { start: 5, end: 7, kind: "function", label: "fn two()" },
  ]);
  const first = await applyPatch({ cwd, patch: `[${path}#${snapshot.tag}]\nINSERT AT START:\n+// banner` });
  const second = await applyPatch({ cwd, patch: `${header(first)}\nDELETE BLOCK AT 6` });
  assert.match(second, /Resolved DELETE BLOCK AT 6 to original lines 6\.\.8/);
  assert.equal(await readFile(path, "utf8"), "// banner\nfunction one() {\n  return 1;\n}\n\n");
});

test("DELETE BLOCK AT removes one certified whole construct without reading its interior", async () => {
  const cwd = await fixture();
  const path = join(cwd, "delete-block.ts");
  const text = "const before = 1;\nfunction legacy() {\n  const hidden = 1;\n  return hidden;\n}\nconst after = 2;\n";
  await writeFile(path, text);
  const canonical = canonicalExistingPath(path);
  const snapshot = snapshots.record(canonical, text, [1, 2, 5, 6], [{ start: 2, end: 5, kind: "function", label: "fn legacy()" }]);
  const result = await applyPatch({ cwd, patch: `[${path}#${snapshot.tag}]\nDELETE BLOCK AT 2` });
  assert.match(result, /Resolved DELETE BLOCK AT 2 to original lines 2\.\.5/);
  assert.equal(await readFile(path, "utf8"), "const before = 1;\nconst after = 2;\n");
});

test("block operations fail closed when the hash has no certified span", async () => {
  const cwd = await fixture();
  const path = join(cwd, "no-block.ts");
  await writeFile(path, "function maybe() {\n  return 1;\n}\n");
  const read = (await renderRead({ cwd, path: `${path}:1-2` })).text;
  assert.match(await applyPatch({ cwd, patch: `${header(read)}\nDELETE BLOCK AT 1` }), /block_unavailable/);
  assert.match(await readFile(path, "utf8"), /function maybe/);
});

function numberedFixtureLines(count) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

test("edit-enhancement baseline: unchanged unseen rows already permit a broad equal-length replacement", async () => {
  const cwd = await fixture();
  const path = join(cwd, "broad-unchanged.txt");
  const lines = numberedFixtureLines(100);
  await writeFile(path, `${lines.join("\n")}\n`);
  const read = (await renderRead({ cwd, path: `${path}:1-1,100-100` })).text;
  const desired = [...lines];
  desired[0] = "LINE 1";
  desired[99] = "LINE 100";
  await applyPatch({ cwd, patch: `${header(read)}\nREPLACE 1..100:\n${desired.map(line => `+${line}`).join("\n")}` });
  assert.equal(await readFile(path, "utf8"), `${desired.join("\n")}\n`);
});

test("edit-enhancement baseline: a broad replacement holds a changed unseen middle row", async () => {
  const cwd = await fixture();
  const path = join(cwd, "broad-unsafe.txt");
  const lines = numberedFixtureLines(100);
  await writeFile(path, `${lines.join("\n")}\n`);
  const read = (await renderRead({ cwd, path: `${path}:1-1,100-100` })).text;
  const desired = [...lines];
  desired[0] = "LINE 1";
  desired[49] = "UNSEEN CHANGED";
  desired[99] = "LINE 100";
  const edited = await applyPatch({ cwd, patch: `${header(read)}\nREPLACE 1..100:\n${desired.map(line => `+${line}`).join("\n")}` });
  assert.match(edited, /Held remaining change/);
  const landed = [...lines];
  landed[0] = "LINE 1";
  landed[99] = "LINE 100";
  assert.equal(await readFile(path, "utf8"), `${landed.join("\n")}\n`);
});

test("edit-enhancement baseline: 98 authorized operations land while two unseen siblings are held", async () => {
  const cwd = await fixture();
  const path = join(cwd, "many-operations.txt");
  const lines = numberedFixtureLines(100);
  await writeFile(path, `${lines.join("\n")}\n`);
  const read = (await renderRead({ cwd, path: `${path}:1-98` })).text;
  const operations = lines.map((_, index) => `REPLACE ${index + 1}:\n+LINE ${index + 1}`).join("\n");
  const edited = await applyPatch({ cwd, patch: `${header(read)}\n${operations}` });
  assert.match(edited, /Held remaining change/);
  const landed = lines.map((line, index) => index < 98 ? `LINE ${index + 1}` : line);
  assert.equal(await readFile(path, "utf8"), `${landed.join("\n")}\n`);
});

test("edit-enhancement baseline: separated equal-length changes reach the exact authored target", async () => {
  const cwd = await fixture();
  const path = join(cwd, "separated.txt");
  const lines = numberedFixtureLines(12);
  await writeFile(path, `${lines.join("\n")}\n`);
  const read = (await renderRead({ cwd, path: `${path}:1-12` })).text;
  const desired = [...lines];
  desired[1] = "TWO";
  desired[6] = "SEVEN";
  desired[10] = "ELEVEN";
  await applyPatch({ cwd, patch: `${header(read)}\nREPLACE 1..12:\n${desired.map(line => `+${line}`).join("\n")}` });
  assert.equal(await readFile(path, "utf8"), `${desired.join("\n")}\n`);
});

test("edit-enhancement baseline: changed-length unique anchors currently apply as one broad replacement", async () => {
  const cwd = await fixture();
  const path = join(cwd, "changed-length-unique.txt");
  const lines = ["start", "alpha", "middle", "omega", "end"];
  await writeFile(path, `${lines.join("\n")}\n`);
  const read = (await renderRead({ cwd, path: `${path}:1-1,5-5` })).text;
  const desired = ["START", "alpha", "inserted", "middle", "omega", "END"];
  await applyPatch({ cwd, patch: `${header(read)}\nREPLACE 1..5:\n${desired.map(line => `+${line}`).join("\n")}` });
  assert.equal(await readFile(path, "utf8"), `${desired.join("\n")}\n`);
});

test("edit-enhancement baseline: duplicate and crossing changed-length bodies remain protected", async () => {
  for (const [name, lines, desired] of [
    ["duplicate", ["start", "same", "middle", "same", "end"], ["START", "same", "inserted", "middle", "same", "END"]],
    ["crossing", ["start", "alpha", "middle", "omega", "end"], ["START", "omega", "middle", "alpha", "END"]],
  ]) {
    const cwd = await fixture();
    const path = join(cwd, `${name}-anchors.txt`);
    await writeFile(path, `${lines.join("\n")}\n`);
    const read = (await renderRead({ cwd, path: `${path}:1-1,5-5` })).text;
    const held = await applyPatch({ cwd, patch: `${header(read)}\nREPLACE 1..5:\n${desired.map(line => `+${line}`).join("\n")}` });
    assert.match(held, /Held remaining change/);
    assert.equal(await readFile(path, "utf8"), `${lines.join("\n")}\n`);
  }
});

test("edit-enhancement baseline: an unsafe middle same-path section currently lands with its valid siblings", async () => {
  const cwd = await fixture();
  const path = join(cwd, "same-path-partial.txt");
  await writeFile(path, "one\ntwo\nthree\n");
  const read = (await renderRead({ cwd, path: `${path}:1-1,3-3` })).text;
  const h = header(read);
  const input = `${h}\nREPLACE 1:\n+ONE\n${h}\nREPLACE 2:\n+TWO\n${h}\nREPLACE 3:\n+THREE`;
  const partial = await applyPatch({ cwd, patch: input });
  assert.match(partial, /Held remaining change/);
  assert.equal(await readFile(path, "utf8"), "ONE\ntwo\nTHREE\n");
});

test("edit-enhancement baseline: repeating an insert after a lost response converges without duplication", async () => {
  const cwd = await fixture();
  const path = join(cwd, "lost-response.txt");
  await writeFile(path, "one\ntwo\n");
  const read = (await renderRead({ cwd, path: `${path}:1-2` })).text;
  const first = await applyPatch({ cwd, patch: `${header(read)}\nINSERT AFTER 2:\n+tail` });
  await applyPatch({ cwd, patch: `${header(first)}\nINSERT AFTER 2:\n+tail` });
  assert.equal(await readFile(path, "utf8"), "one\ntwo\ntail\n");
});

test("edit-enhancement no-op guard stops a third identical already-satisfied attempt", async () => {
  const cwd = await fixture();
  const path = join(cwd, "no-op-loop.txt");
  await writeFile(path, "one\n");
  const read = (await renderRead({ cwd, path: `${path}:1` })).text;
  const input = `${header(read)}\nREPLACE 1:\n+one`;
  assert.match(await applyPatch({ cwd, patch: input }), /already matches the requested target/);
  assert.match(await applyPatch({ cwd, patch: input }), /already matches the requested target/);
  await assert.rejects(applyPatch({ cwd, patch: input }), /repeated_no_change/);
});

test("edit-enhancement conflict groups reject every overlapping member and preserve unrelated islands", async () => {
  const cwd = await fixture();
  const path = join(cwd, "island-conflict.txt");
  await writeFile(path, "one\ntwo\nthree\nfour\n");
  const read = (await renderRead({ cwd, path: `${path}:1-4` })).text;
  const result = await applyPatch({ cwd, patch: `${header(read)}\nREPLACE 1..2:\n+ONE\n+TWO-A\nREPLACE 2..3:\n+TWO-B\n+THREE\nREPLACE 4:\n+FOUR` });
  assert.match(result, /Rejected conflicting changes/);
  assert.equal(await readFile(path, "utf8"), "one\ntwo\nthree\nFOUR\n");
});

test("edit-enhancement bounds rejection preserves a valid sibling operation", async () => {
  const cwd = await fixture();
  const path = join(cwd, "bounds-sibling.txt");
  await writeFile(path, "one\ntwo\n");
  const read = (await renderRead({ cwd, path: `${path}:1-2` })).text;
  const result = await applyPatch({ cwd, patch: `${header(read)}\nREPLACE 1:\n+ONE\nREPLACE 99:\n+OUTSIDE` });
  assert.match(result, /outside the current source bounds/);
  assert.equal(await readFile(path, "utf8"), "ONE\ntwo\n");
});

test("edit-enhancement ambiguous repair rejects one operation without erasing a valid sibling", async () => {
  const cwd = await fixture();
  const path = join(cwd, "repair-sibling.txt");
  await writeFile(path, "before\nold\nafter\n");
  const read = (await renderRead({ cwd, path: `${path}:1-3` })).text;
  const result = await applyPatch({ cwd, patch: `${header(read)}\nREPLACE 1:\n+BEFORE\nREPLACE 2:\n+before\n+after` });
  assert.match(result, /deterministic repair was ambiguous/);
  assert.equal(await readFile(path, "utf8"), "BEFORE\nold\nafter\n");
});
