import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const suiteRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const supported = process.platform === "darwin" && process.arch === "arm64";
const python = process.env.PI_NAV_TEST_PYTHON;

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000, ...options });
}

function git(cwd, ...args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("pinned root Git install loads the suite and provisions codeweave-pi without global backends", { skip: !supported || !python }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "jeito-suite-git-release-"));
  let daemon;
  t.after(async () => {
    if (daemon && daemon.exitCode === null) {
      const exited = new Promise(resolve => daemon.once("exit", resolve));
      daemon.kill("SIGTERM");
      await exited;
    }
    if (!process.env.PI_NAV_KEEP_RELEASE_FIXTURE) await rm(temp, { recursive: true, force: true });
    else console.error(`root release fixture retained at ${temp}`);
  });

  const archive = path.join(temp, "suite.tar");
  const snapshotResult = run("git", ["stash", "create"], { cwd: suiteRoot });
  assert.equal(snapshotResult.status, 0, snapshotResult.stderr || snapshotResult.stdout);
  const snapshot = snapshotResult.stdout.trim() || "HEAD";
  const untrackedResult = run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: suiteRoot });
  assert.equal(untrackedResult.status, 0, untrackedResult.stderr || untrackedResult.stdout);
  const untrackedArchiveArgs = untrackedResult.stdout.split("\0").filter(Boolean).flatMap(file => {
    const directory = path.dirname(file);
    return [`--prefix=${directory === "." ? "" : `${directory}/`}`, `--add-file=${file}`];
  });
  const archived = run("git", ["archive", "--format=tar", "-o", archive, ...untrackedArchiveArgs, "--prefix=", snapshot], { cwd: suiteRoot });
  assert.equal(archived.status, 0, archived.stderr || archived.stdout);
  const source = path.join(temp, "source");
  await mkdir(source);
  const extracted = run("tar", ["-xf", archive, "-C", source]);
  assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
  git(source, "init", "-q");
  git(source, "config", "user.email", "release-test@example.invalid");
  git(source, "config", "user.name", "release test");
  git(source, "add", "-f", ".");
  git(source, "commit", "-qm", "suite release");
  git(source, "tag", "suite-release");

  const gitRoot = path.join(temp, "git");
  const bare = path.join(gitRoot, "project", "codeweave-pi.git");
  await mkdir(path.dirname(bare), { recursive: true });
  git(temp, "clone", "-q", "--bare", source, bare);
  const port = 19420;
  daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", `--base-path=${gitRoot}`, "--listen=127.0.0.1", `--port=${port}`, gitRoot], { stdio: "ignore" });
  await new Promise(resolve => setTimeout(resolve, 300));

  const home = path.join(temp, "home");
  const agentDir = path.join(home, "agent");
  const project = path.join(temp, "consumer");
  const decoys = path.join(temp, "decoys");
  await mkdir(project);
  await mkdir(decoys);
  await mkdir(path.join(project, ".git"));
  await writeFile(path.join(project, ".pi-navigation.json"), JSON.stringify({ architecture: { enabled: false }, docs: { enabled: false }, graph: { enabled: false } }));
  for (const backend of ["code-review-graph", "graphify", "qmd"]) {
    const file = path.join(decoys, backend);
    await writeFile(file, `#!/bin/sh\ntouch ${JSON.stringify(path.join(temp, `${backend}.used`))}\nexit 99\n`);
    await chmod(file, 0o755);
  }
  const pi = run("which", ["pi"]).stdout.trim();
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_NAV_PYTHON: python, PATH: [decoys, path.dirname(pi), path.dirname(process.execPath), path.dirname(python), "/usr/bin", "/bin"].join(path.delimiter) };
  const installed = run(pi, ["install", `git:git://localhost:${port}/project/codeweave-pi.git@suite-release`], { cwd: project, env });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);

  const installedRoot = path.join(agentDir, "git", "localhost", "project", "jeito");
  const codeweave-pi = path.join(installedRoot, "extensions", "codeweave-pi");
  assert.equal(existsSync(path.join(codeweave-pi, ".runtime", ".ready")), true);
  assert.equal(existsSync(path.join(installedRoot, "node_modules", "node-llama-cpp")), true);
  const localRuntime = run(process.execPath, ["extensions/codeweave-pi/scripts/qmd-local-runtime-smoke.mjs"], { cwd: installedRoot, env });
  assert.equal(localRuntime.status, 0, localRuntime.stderr || localRuntime.stdout);
  for (const backend of ["code-review-graph", "graphify", "qmd"]) assert.equal(existsSync(path.join(temp, `${backend}.used`)), false);

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.equal(settings.packages.length, 1);
  const piPackageRoot = path.dirname(path.dirname(await realpath(pi)));
  const realPi = await import(pathToFileURL(path.join(piPackageRoot, "dist", "index.js")).href);
  const expectedTools = ["bash", "jobs", "tools", "web_search", "web_fetch", "web_lookup", "docs_search"];
  const priorNoAutoSetup = process.env.PI_NAV_NO_AUTO_SETUP;
  process.env.PI_NAV_NO_AUTO_SETUP = "1";
  const { session } = await realPi.createAgentSession({ cwd: project, agentDir, noTools: "builtin", tools: expectedTools });
  try {
    const loadedSkills = session.resourceLoader.getSkills();
    assert.equal(loadedSkills.diagnostics.filter(diagnostic => diagnostic.path?.startsWith(installedRoot)).length, 0);
    assert.equal(loadedSkills.skills.find(skill => skill.name === "jeito-setup")?.filePath, path.join(installedRoot, ".agents", "skills", "jeito-setup", "SKILL.md"));
    assert.equal(loadedSkills.skills.find(skill => skill.name === "deep-navigation-onboard")?.filePath, path.join(codeweave-pi, "skills", "deep-navigation-onboard", "SKILL.md"));
    const promptSidequestCommand = session.extensionRunner.getRegisteredCommands().find(command => command.name === "draft-lift");
    assert.ok(promptSidequestCommand?.sourceInfo?.path.endsWith("extensions/draft-lift/index.ts"), "root aggregate did not load /prompt-sidequest from its packaged owner");
    await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    const expectedSources = {
      bash: "extensions/shell/index.ts",
      jobs: "extensions/shell/index.ts",
      tools: "extensions/tooltap/extensions/index.ts",
      web_search: "extensions/websift/index.ts",
      web_fetch: "extensions/websift/index.ts",
      web_lookup: "extensions/websift/index.ts",
      docs_search: "extensions/codeweave-pi/index.ts",
    };
    for (const name of expectedTools) {
      const tool = session.getToolDefinition(name);
      assert.ok(tool, `root aggregate did not load ${name}`);
      assert.ok(session.getAllTools().find(candidate => candidate.name === name)?.sourceInfo?.path.endsWith(expectedSources[name]), `root aggregate loaded ${name} from the wrong owner`);
    }
  } finally {
    session.dispose();
    if (priorNoAutoSetup === undefined) delete process.env.PI_NAV_NO_AUTO_SETUP;
    else process.env.PI_NAV_NO_AUTO_SETUP = priorNoAutoSetup;
  }
});
