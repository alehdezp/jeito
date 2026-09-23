import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderRead } from "../src/core/read-renderer.ts";

const TAG_RE = /^\[(.+)#([0-9A-F]{4,})\]/m;

test("directory read refuses and points to ls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dir-read-1-"));
  const dir = join(cwd, "overview");
  await mkdir(dir);
  await writeFile(join(dir, "index.ts"), "export const value = 1\n");

  await assert.rejects(
    () => renderRead({ cwd, path: dir }),
    /is a directory\. Use ls for directory listing\./,
    "directory read must refuse with a clear error pointing to ls",
  );
});

test("directory read does not affect exact file reads", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dir-read-4-"));
  const dir = join(cwd, "overview");
  await mkdir(dir);
  await writeFile(join(dir, "index.ts"), "line one\nline two\n");
  const exact = (await renderRead({ cwd, path: `${join(dir, "index.ts")}:1-2` })).text;
  assert.match(exact, TAG_RE);
  assert.match(exact, /line one/);
  assert.match(exact, /line two/);
});
