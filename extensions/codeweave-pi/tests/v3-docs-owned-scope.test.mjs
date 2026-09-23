import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveFreshenRoot } from "../scripts/navigation-freshen.mjs";


test("freshen root recognizes a git-only repository under a configured parent", async t => {
  const parent = await mkdtemp(join(tmpdir(), "pi-parent-config-"));
  const child = join(parent, "workspace", "git-only");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(join(child, ".git"), { recursive: true });
  await writeFile(join(parent, ".pi-navigation.json"), JSON.stringify({ docs: { enabled: true } }));
  assert.equal(resolveFreshenRoot(child), child);
});
