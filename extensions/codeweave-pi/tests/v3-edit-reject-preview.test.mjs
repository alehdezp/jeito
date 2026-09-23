import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyPatch } from "../src/core/patch-apply.ts";
import { renderRead } from "../src/core/read-renderer.ts";

const HEADER_RE = /^\[(.+)#([0-9A-F]{8})\]/m;
const fixture = () => mkdtemp(join(tmpdir(), "pi-edit-reject-preview-"));

async function certify(cwd, path) {
  const read = (await renderRead({ cwd, path: `${path}:1-3` })).text;
  return HEADER_RE.exec(read)[0];
}

test("stale unremappable edits are HELDED with live lines, never silently applied", async () => {
  const cwd = await fixture();
  const path = join(cwd, "doc.txt");
  await writeFile(path, "one\ntwo\nthree\n");
  const header = await certify(cwd, path);
  await writeFile(path, "one\nTWO-changed\nthree\n");
  const result = await applyPatch({ cwd, patch: `${header}\nREPLACE 2:\n+REPLACED`, sessionId: "stale-hold" });
  const message = String(result.text);
  console.log("STALE-MSG>>>", JSON.stringify(message));
  assert.match(message, /could not be remapped safely/);
  assert.match(message, /2:TWO-changed/);
  const after = await readFile(path, "utf8");
  assert.equal(after, "one\nTWO-changed\nthree\n", "stale edit must not apply");
});

test("restart-style matching tags auto-re-authorize and apply", async () => {
  const cwd = await fixture();
  const path = join(cwd, "doc.txt");
  const content = "one\ntwo\nthree\n";
  await writeFile(path, content);
  // Post-restart simulation: tag minted from bytes, no session snapshot recorded.
  const { computeTag } = await import("../src/core/snapshot-store.ts");
  const { normalizeForSnapshot } = await import("../src/core/text-normalize.ts");
  const header = `[${path}#${computeTag(normalizeForSnapshot(content))}]`;
  const result = await applyPatch({ cwd, patch: `${header}\nREPLACE 2:\n+TWO`, sessionId: "reject-restart" });
  assert.equal(result.details.status, "success");
  assert.match(String(result.text), /Re-authorized .* after session reload/);
  assert.equal(await readFile(path, "utf8"), "one\nTWO\nthree\n");
});
test("unknown hash rejection embeds live preview and remedy in the result text", async () => {
  const cwd = await fixture();
  const path = join(cwd, "doc.txt");
  await writeFile(path, "one\ntwo\nthree\n");
  const result = await applyPatch({ cwd, patch: `[${path}#deadbeef]\nREPLACE 2:\n+TWO`, sessionId: "reject-unknown" });
  assert.equal(result.details.status, "error");
  const message = String(result.text);
  assert.match(message, /unknown_hash/);
  assert.match(message, /was not created for this path in this session/);
  assert.match(message, /Live content at the lines your patch targets:/);
  assert.match(message, /2:two/);
  assert.match(message, /read\(\{path:".*doc\.txt:2"\}\) to re-certify these ranges/);
});
