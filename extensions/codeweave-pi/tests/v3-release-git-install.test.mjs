import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const supported = process.platform === "darwin" && process.arch === "arm64";
const python = process.env.PI_NAV_TEST_PYTHON;

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000, ...options });
}
function jsonLine(text) {
  for (const line of String(text).trim().split(/\r?\n/).reverse()) try { return JSON.parse(line); } catch {}
}
function git(cwd, ...args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runtimePaths(installedRoot) {
  const runtime = path.join(installedRoot, ".runtime");
  return { runtime, ready: path.join(runtime, ".ready"), crg: path.join(runtime, "bin", "code-review-graph"), graphify: path.join(runtime, "bin", "graphify") };
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

test("pinned Pi Git install, missing-runtime recovery, stopped update, and restart use one extension-local runtime", { skip: !supported || !python }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "jeito-codeweave-pi-git-release-"));
  let daemon;
  t.after(async () => {
    if (daemon && daemon.exitCode === null) {
      const exited = new Promise(resolve => daemon.once("exit", resolve));
      daemon.kill("SIGTERM");
      await exited;
    }
    if (!process.env.PI_NAV_KEEP_RELEASE_FIXTURE) await rm(temp, { recursive: true, force: true });
    else console.error(`release fixture retained at ${temp}`);
  });

  const providedArchive = process.env.PI_NAV_RELEASE_ARCHIVE;
  let archive = providedArchive ? path.resolve(providedArchive) : undefined;
  if (!archive) {
    const packaged = run(process.execPath, ["scripts/pi-nav-build.mjs", "package", "--development", "--json"], { cwd: root });
    assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
    archive = jsonLine(packaged.stdout)?.archive;
    t.after(() => Promise.all([archive, `${archive}.sha256`].map(file => rm(file, { force: true }))));
  }
  assert.ok(archive);
  const sourceParent = path.join(temp, "source");
  await mkdir(sourceParent);
  assert.equal(run("tar", ["-xzf", archive, "-C", sourceParent]).status, 0);
  const source = path.join(sourceParent, "jeito-codeweave-pi");
  await rm(path.join(source, "node_modules"), { recursive: true, force: true });
  await rm(path.join(source, "RELEASE-MANIFEST.json"), { force: true });
  git(source, "init", "-q");
  git(source, "config", "user.email", "release-test@example.invalid");
  git(source, "config", "user.name", "release test");
  git(source, "add", "-f", ".");
  git(source, "commit", "-qm", "release a");
  git(source, "tag", "release-a");

  const gitRoot = path.join(temp, "git");
  const bare = path.join(gitRoot, "project", "navigation.git");
  await mkdir(path.dirname(bare), { recursive: true });
  git(temp, "clone", "-q", "--bare", source, bare);
  const port = 19419;
  daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", `--base-path=${gitRoot}`, "--listen=127.0.0.1", `--port=${port}`, gitRoot], { stdio: "ignore" });
  await new Promise(resolve => setTimeout(resolve, 300));

  const home = path.join(temp, "home");
  const agentDir = path.join(home, "agent");
  const project = path.join(temp, "consumer");
  const decoys = path.join(temp, "decoys");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(decoys);
  await writeFile(path.join(project, ".pi-navigation.json"), JSON.stringify({ architecture: { enabled: false }, docs: { enabled: false }, graph: { enabled: false } }));
  await writeFile(path.join(project, "src", "alpha.ts"), "export const alpha = 1;\n");
  for (const backend of ["code-review-graph", "graphify", "qmd"]) {
    const file = path.join(decoys, backend);
    await writeFile(file, `#!/bin/sh\ntouch ${JSON.stringify(path.join(temp, `${backend}.used`))}\nexit 99\n`);
    await chmod(file, 0o755);
  }
  const pi = run("which", ["pi"]).stdout.trim();
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_NAV_PYTHON: python, PATH: [decoys, path.dirname(pi), path.dirname(process.execPath), path.dirname(python), "/usr/bin", "/bin"].join(path.delimiter) };
  const sourceA = `git:git://localhost:${port}/project/navigation.git@release-a`;
  const first = run(pi, ["install", sourceA], { cwd: project, env });
  assert.equal(first.status, 0, first.stderr || first.stdout);

  const installedRoot = path.join(agentDir, "git", "localhost", "project", "navigation");
  const runtimeA = runtimePaths(installedRoot);
  for (const file of [runtimeA.ready, runtimeA.crg, runtimeA.graphify]) assert.equal(existsSync(file), true, `missing installed runtime file: ${file}`);
  assert.equal(run(runtimeA.crg, ["--version"], { env }).status, 0);
  assert.equal(run(runtimeA.graphify, ["--help"], { env }).status, 0);
  assert.equal(existsSync(path.join(temp, "code-review-graph.used")), false);
  assert.equal(existsSync(path.join(temp, "graphify.used")), false);
  assert.equal(existsSync(path.join(temp, "qmd.used")), false);

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.equal(settings.packages.length, 1);
  const piPackageRoot = path.dirname(path.dirname(await realpath(pi)));
  const realPi = await import(pathToFileURL(path.join(piPackageRoot, "dist", "index.js")).href);
  const { session } = await realPi.createAgentSession({ cwd: project, agentDir, noTools: "builtin", tools: ["ls"] });
  try {
    assert.ok(session.getToolDefinition("ls"));
    assert.equal(existsSync(path.join(installedRoot, "node_modules", "@napi-rs", "cli")), false);
    assert.equal(existsSync(path.join(installedRoot, "node_modules", "better-sqlite3")), true);
    assert.equal(existsSync(path.join(installedRoot, "node_modules", "node-llama-cpp")), true);
    const localRuntime = run(process.execPath, ["scripts/qmd-local-runtime-smoke.mjs"], { cwd: installedRoot, env });
    assert.equal(localRuntime.status, 0, localRuntime.stderr || localRuntime.stdout);
    const result = await session.getToolDefinition("ls").execute("release-ls", { path: "src", view: "list", visibility: "project", sort: "path" }, undefined, undefined, { cwd: project, mode: "print", hasUI: false, ui: { notify() {} } });
    assert.match(result.content.map(part => part.text ?? "").join("\n"), /alpha\.ts/);
  } finally { session.dispose(); }
  const disabledHome = path.join(temp, "disabled-home");
  const disabledAgent = path.join(disabledHome, "agent");
  await mkdir(disabledAgent, { recursive: true });
  await writeFile(path.join(disabledAgent, "settings.json"), '{"packages":[]}\n');
  const disabledEnv = { ...env, HOME: disabledHome, PI_CODING_AGENT_DIR: disabledAgent };
  const enabledDurations = [];
  const disabledDurations = [];
  for (let index = 0; index < 20; index += 1) {
    for (const [durations, runEnv, label] of [[disabledDurations, disabledEnv, "disabled"], [enabledDurations, env, "enabled"]]) {
      const started = performance.now();
      const rpc = run(pi, ["--mode", "rpc", "--no-session", "--offline", "--approve"], { cwd: project, env: runEnv, input: `{"id":"${label}-${index}","type":"get_state"}\n`, timeout: 30_000 });
      assert.equal(rpc.status, 0, rpc.stderr || rpc.stdout);
      durations.push(performance.now() - started);
    }
  }
  const startup = { enabledP95Ms: p95(enabledDurations), disabledP95Ms: p95(disabledDurations) };
  assert.ok(startup.enabledP95Ms - startup.disabledP95Ms < 500, JSON.stringify(startup));
  console.log(`[release-startup] ${JSON.stringify(startup)}`);

  await rm(runtimeA.runtime, { recursive: true, force: true });
  const skippedPostinstall = run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: installedRoot, env });
  assert.equal(skippedPostinstall.status, 0, skippedPostinstall.stderr || skippedPostinstall.stdout);
  assert.equal(existsSync(runtimeA.ready), false);
  const missingStarted = performance.now();
  const missing = run(pi, ["--mode", "rpc", "--no-session", "--offline", "--approve"], { cwd: project, env, input: '{"id":"missing","type":"get_state"}\n', timeout: 30_000 });
  assert.equal(missing.status, 0, missing.stderr || missing.stdout);
  assert.ok(performance.now() - missingStarted < 30_000);
  assert.equal(existsSync(runtimeA.ready), false);
  const repaired = run("npm", ["run", "nav:provision"], { cwd: installedRoot, env });
  assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
  assert.equal(existsSync(runtimeA.ready), true);

  await writeFile(path.join(runtimeA.runtime, "old-revision-marker"), "remove on update\n");
  const packageJsonPath = path.join(source, "package.json");
  const packageLockPath = path.join(source, "package-lock.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const packageLock = JSON.parse(await readFile(packageLockPath, "utf8"));
  packageJson.version = packageLock.version = packageLock.packages[""].version = "0.9.1";
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
  git(source, "add", "package.json", "package-lock.json");
  git(source, "commit", "-qm", "release b");
  git(source, "tag", "release-b");
  git(source, "push", "-q", bare, "release-b");

  const second = run(pi, ["install", `git:git://localhost:${port}/project/navigation.git@release-b`], { cwd: project, env });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(existsSync(path.join(runtimeA.runtime, "old-revision-marker")), false);
  assert.equal(existsSync(runtimeA.ready), true);
  assert.equal(run(runtimeA.crg, ["--version"], { env }).status, 0);
  assert.equal(run(pi, ["--mode", "rpc", "--no-session", "--offline", "--approve"], { cwd: project, env, input: '{"id":"updated","type":"get_state"}\n', timeout: 30_000 }).status, 0);
});
