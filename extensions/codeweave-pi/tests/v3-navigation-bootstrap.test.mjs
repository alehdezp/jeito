import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { bootstrapNavigation } from "../scripts/navigation-bootstrap.mjs";

const SECRET = ["bootstrap", "secret", "value", "123456789"].join("-");

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-bootstrap-"));
}

async function touch(file, content = "x") {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function makeRepo() {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export const value = 1;\n");
  await touch(join(root, "README.md"), "# Demo\n");
  return root;
}

test("navigation bootstrap dry-run validates config/tools/prepare without writing", async () => {
  const root = await makeRepo();
  const result = await bootstrapNavigation(["--path", root, "--dry-run"], { env: { PATH: "", CRG_PYTHON: "/missing/python" } });

  assert.equal(result.mode, "dry-run");
  assert.equal(result.prepare.dry_run_mutations.length, 0);
  assert.equal(result.writes.length, 0);
  assert.equal(existsSync(join(root, ".pi-navigation.json")), false);
  assert.equal(existsSync(join(root, ".pi", "navigation", "state.json")), false);
  assert.ok(result.global_config.storage.indexRoot.startsWith("/"));
  assert.deepEqual(result.global_config.errors, []);
  assert.ok(result.recovery.stop_conditions.includes("prepare dry-run mutates files"));
});

test("navigation bootstrap write-config writes safe skeleton only when explicit", async () => {
  const root = await makeRepo();
  const result = await bootstrapNavigation(["--path", root, "--write-config"], { env: { PATH: "", CRG_PYTHON: "/missing/python" } });

  assert.equal(result.mode, "write-config");
  assert.ok(result.writes.includes(".pi-navigation.json"));
  assert.ok(result.writes.includes(".pi/navigation/state.json"));
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  assert.equal(config.architecture.enabled, false);
  assert.equal(config.docs.enabled, false);
  assert.equal(config.graph.enabled, false);
  assert.equal(existsSync(join(root, "node_modules")), false);
  assert.equal(existsSync(join(root, "graphify-out")), false);
});

test("navigation bootstrap reports provider env var names without secret values", async () => {
  const root = await makeRepo();
  const configPath = join(root, "nav-config.json");
  await writeFile(configPath, JSON.stringify({
    providers: {
      allowCloud: true,
      allowLLM: true,
      allowEmbeddings: true,
      defaultLLMProvider: "openai",
      defaultEmbeddingProvider: "openai",
    },
  }));

  const result = await bootstrapNavigation(["--path", root, "--config", configPath, "--dry-run"], { env: { PATH: "", CRG_PYTHON: "/missing/python", OPENAI_API_KEY: SECRET } });
  const rendered = JSON.stringify(result);

  assert.equal(result.global_config.providers.length, 2);
  assert.ok(result.global_config.providers.every(item => item.required_env.includes("OPENAI_API_KEY")));
  assert.equal(rendered.includes(SECRET), false);
});

test("navigation bootstrap CLI emits JSON and package script exists", async () => {
  const root = await makeRepo();
  const run = spawnSync(process.execPath, ["scripts/navigation-bootstrap.mjs", "--path", root, "--dry-run", "--json"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PATH: process.env.PATH ?? "", CRG_PYTHON: "/missing/python" },
    encoding: "utf8",
  });
  assert.ok([0, 2].includes(run.status), run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.mode, "dry-run");
  assert.equal(parsed.prepare.dry_run_mutations.length, 0);

  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["nav:bootstrap"], "node scripts/navigation-bootstrap.mjs");
});
