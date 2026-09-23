import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { prepareNavigation } from "../scripts/navigation-prepare.mjs";

async function fixture(prefix = "pi-nav-prepare-e2e-") { return mkdtemp(join(tmpdir(), prefix)); }
async function touch(file, content = "x") { await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); }
async function fakeTools(root, names = ["graphify"]) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of names) { const file = join(bin, name); await writeFile(file, "#!/usr/bin/env sh\nexit 0\n"); await chmod(file, 0o755); }
  return { PATH: `${bin}:${process.env.PATH ?? ""}`, PI_NAV_AUTOMATION_CONFIG: join(root, "missing-navigation-config.json") };
}
function byBackend(result, backend) { return result.plan.actions.find(action => action.backend === backend); }

test("normal prompt plans clean-break local lanes only", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export function main() {}\n");
  await touch(join(root, "docs", "overview.md"), "# Overview\n");
  const env = await fakeTools(root);
  const result = await prepareNavigation(["--path", root, "--dry-run", "--query", "Help me understand this repo"], { env });
  assert.equal(result.mode, "dry-run");
  const planned = result.plan.actions.map(action => action.backend);
  for (const backend of ["qmd", "graphify"]) assert.ok(byBackend(result, backend), backend);
  for (const retired of ["crg", "semble", "tilth", "codanna"]) assert.equal(planned.includes(retired), false, `${retired} must not be planned`);
  assert.equal(byBackend(result, "semble"), undefined);
  assert.equal(byBackend(result, "tilth"), undefined);
  assert.equal(byBackend(result, "codanna"), undefined);
  assert.equal(existsSync(join(root, ".pi", "navigation-setup.log.jsonl")), false);
});

test("full-stack dry-run prefers Graphify deep and QMD hybrid when policy allows", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "impl.ts"), "export const impl = true;\n");
  await touch(join(root, "README.md"), "# Demo\nImplementation lives in src.\n");
  const env = { ...(await fakeTools(root)), ZEROENTROPY_API_KEY: "set", DEEPSEEK_API_KEY: "set" };
  const result = await prepareNavigation(["--path", root, "--full-stack", "--dry-run", "--query", "How do docs connect to implementation?"], { env });
  assert.equal(byBackend(result, "qmd").modeName, "hybridDocs");
  assert.equal(byBackend(result, "graphify").modeName, "deepExtract");
});

test("impact-like prompt does not add trace impact execution to prepare plan", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "worker.ts"), "export function applyPatch() { return true; }\n");
  const env = await fakeTools(root, ["graphify"]);
  const result = await prepareNavigation(["--path", root, "--dry-run", "--backend", "graphify", "--query", "What changes if applyPatch changes?"], { env });
  const graphify = byBackend(result, "graphify");
  assert.ok(graphify);
  assert.doesNotMatch(JSON.stringify(graphify), /trace\(relation:?['"]impact/);
});
