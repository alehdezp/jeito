import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectProjectRoot, detectNearestPackageRoot, resolvePreparationRoot } from "../src/core/project-root.ts";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-nav-admission-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function git(root, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return execFileSync("git", ["-c", "init.templateDir=", "-c", "core.hooksPath=", "-C", root, ...args], { env, stdio: "pipe" });
}

test("admission and live discovery share canonical roots for subfolders and symlinks", async t => {
  const base = await fixture(t);
  const root = join(base, "repo");
  const pkg = join(root, "packages", "app");
  const nested = join(pkg, "src");
  await mkdir(nested, { recursive: true });
  await writeFile(join(pkg, "package.json"), "{}");
  git(root, "init", "--quiet");
  const alias = join(base, "alias");
  await symlink(nested, alias, process.platform === "win32" ? "junction" : "dir");
  const before = await readdir(root);
  assert.equal(detectProjectRoot(alias).root, root);
  assert.equal(detectProjectRoot(nested).root, root);
  assert.equal(detectNearestPackageRoot(alias, root), pkg);
  const admitted = await resolvePreparationRoot(alias);
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.root, root);
  assert.deepEqual(await readdir(root), before, "admission must not create config or index artifacts");
});

test("manifest-only and explicit-config projects are eligible, not their unmarked parent", async t => {
  const base = await fixture(t);
  const manifest = join(base, "manifest");
  const configured = join(base, "configured");
  await mkdir(manifest);
  await mkdir(configured);
  await writeFile(join(manifest, "Cargo.toml"), '[package]\nname = "fixture"\n');
  await writeFile(join(configured, ".pi-navigation.json"), "{}");
  assert.equal((await resolvePreparationRoot(manifest)).allowed, true);
  assert.equal((await resolvePreparationRoot(configured)).allowed, true);
  assert.equal((await resolvePreparationRoot(base)).allowed, false, "referenced child projects must not admit their container");
});

test("a Git marker at home cannot admit home or swallow a nearer bounded package", async t => {
  const base = await fixture(t);
  const home = join(base, "home");
  const pkg = join(home, "projects", "app");
  await mkdir(pkg, { recursive: true });
  git(home, "init", "--quiet");
  await writeFile(join(pkg, "package.json"), "{}");
  assert.equal((await resolvePreparationRoot(home, { home })).allowed, false);
  assert.equal((await resolvePreparationRoot(base, { home })).allowed, false);
  const admitted = await resolvePreparationRoot(pkg, { home });
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.root, pkg);
});

test("invalid Git identity, invalid config and unavailable paths cannot authorize preparation", async t => {
  const base = await fixture(t);
  await writeFile(join(base, ".git"), "gitdir: missing\n");
  assert.equal((await resolvePreparationRoot(base)).allowed, false);
  await writeFile(join(base, ".pi-navigation.json"), "{fixture-private-value");
  const invalid = await resolvePreparationRoot(base);
  assert.equal(invalid.allowed, false);
  assert.ok(!invalid.reason.includes("fixture-private-value"));
  assert.equal((await resolvePreparationRoot(join(base, "missing"))).allowed, false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolvePreparationRoot(base, { signal: controller.signal }), { name: "AbortError" });
});

test("Git worktrees with .git files keep separate corpus roots", async t => {
  const base = await fixture(t);
  const root = join(base, "repo");
  const worktree = join(base, "worktree");
  await mkdir(root);
  git(root, "init", "--quiet");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "fixture");
  git(root, "worktree", "add", "--quiet", "--detach", worktree);
  const admitted = await resolvePreparationRoot(worktree);
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.root, await realpath(worktree));
  assert.notEqual(admitted.root, root);
});
