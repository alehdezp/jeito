import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { prepareNavigation } from "../scripts/navigation-prepare.mjs";
import { setExtensionRuntimeRootForTests } from "../src/core/owned-runtime.ts";

async function fixture() { return mkdtemp(join(tmpdir(), "pi-nav-first-open-")); }

test("project preparation refuses a retired backend before any store mutation or command", async (t) => {
  const root = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => { process.env.HOME = previousHome; });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "main.ts"), "export const ready = true;\n");
  const runtime = join(root, "missing-runtime");
  setExtensionRuntimeRootForTests(runtime);
  t.after(() => setExtensionRuntimeRootForTests());
  const decoy = join(root, "bin", "code-review-graph");
  const decoyLog = join(root, "decoy-called");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(decoy, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(decoyLog)}, 'called');\n`);
  await chmod(decoy, 0o755);
  await assert.rejects(
    prepareNavigation(["--path", root, "--auto", "--trigger", "session_start", "--backend", "crg"], { env: { ...process.env, HOME: root, PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`, PI_NAV_TEST_RUNTIME_ROOT: runtime } }),
    /unknown backend: crg/,
  );
  assert.equal(existsSync(decoyLog), false, "project preparation must never execute a retired backend's PATH decoy");
  assert.equal(existsSync(join(root, ".pi", "navigation-setup.log.jsonl")), false, "a refused preparation must not write an audit record");
});
