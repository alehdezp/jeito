import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SUITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PI = process.env.PI_TEST_BIN || "pi";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

function assertSucceeded(result, label) {
  assert.equal(result.status, 0, `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function writePackage(root, name, { failPostinstall = false } = {}) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.ts"), "export default function fixtureExtension() {}\n");
  writeFileSync(join(root, "postinstall.mjs"), failPostinstall
    ? "process.exit(17);\n"
    : "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./.postinstall-ran', import.meta.url), 'yes');\n");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name,
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { postinstall: "node postinstall.mjs" },
    pi: { extensions: ["./index.ts"] },
  }, null, 2)}\n`);
}

function createWorkspaceFixture() {
  const root = mkdtempSync(join(tmpdir(), "jeito-install-contract-"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ private: true, workspaces: ["extensions/*"] }, null, 2)}\n`);
  writePackage(join(root, "extensions", "a"), "fixture-a");
  writePackage(join(root, "extensions", "b"), "fixture-b");
  return root;
}

function npmInstall(cwd, workspace) {
  const args = ["install", "--omit=dev", "--no-audit", "--no-fund"];
  if (workspace) args.push("--workspace", workspace, "--include-workspace-root=false");
  return run("npm", args, { cwd });
}

test("Pi local-path registration does not run package lifecycle scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-local-registration-"));
  const packageRoot = join(root, "extension");
  const agentRoot = join(root, "agent");
  try {
    writePackage(packageRoot, "fixture-local");
    const result = run(PI, ["install", packageRoot], { env: { PI_CODING_AGENT_DIR: agentRoot } });
    assertSucceeded(result, "pi install local fixture");
    assert.equal(existsSync(join(packageRoot, ".postinstall-ran")), false);
    const settings = JSON.parse(readFileSync(join(agentRoot, "settings.json"), "utf8"));
    assert.equal(resolve(agentRoot, settings.packages[0]), packageRoot);
    assertSucceeded(run(PI, ["remove", packageRoot], { env: { PI_CODING_AGENT_DIR: agentRoot } }), "pi remove local fixture");
    const removedSettings = JSON.parse(readFileSync(join(agentRoot, "settings.json"), "utf8"));
    assert.deepEqual(removedSettings.packages, []);
    assert.equal(existsSync(packageRoot), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi keeps a missing moved registration until the stopped-process install-then-remove transaction replaces it", () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-moved-registration-"));
  const pathA = join(root, "former-name");
  const pathB = join(root, "current-name");
  const agentRoot = join(root, "agent");
  try {
    writePackage(pathA, "fixture-moved");
    assertSucceeded(run(PI, ["install", pathA], { env: { PI_CODING_AGENT_DIR: agentRoot } }), "register path A");
    renameSync(pathA, pathB);
    const listed = run(PI, ["list"], { env: { PI_CODING_AGENT_DIR: agentRoot } });
    assertSucceeded(listed, "list moved registration");
    assert.match(listed.stdout, /former-name/);
    assert.doesNotMatch(listed.stdout, /missing|stale|not found/i, "pi list does not diagnose the missing local path");
    assertSucceeded(run(PI, ["install", pathB], { env: { PI_CODING_AGENT_DIR: agentRoot } }), "register path B");
    let settings = JSON.parse(readFileSync(join(agentRoot, "settings.json"), "utf8"));
    assert.deepEqual(settings.packages.map(source => resolve(agentRoot, typeof source === "string" ? source : source.source)).sort(), [pathA, pathB].sort());
    assertSucceeded(run(PI, ["remove", pathA], { env: { PI_CODING_AGENT_DIR: agentRoot } }), "remove missing path A");
    settings = JSON.parse(readFileSync(join(agentRoot, "settings.json"), "utf8"));
    assert.deepEqual(settings.packages.map(source => resolve(agentRoot, typeof source === "string" ? source : source.source)), [pathB]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm workspace preparation runs only the selected workspace lifecycle", () => {
  const root = createWorkspaceFixture();
  try {
    assertSucceeded(npmInstall(root, "fixture-a"), "selected workspace install");
    assert.equal(existsSync(join(root, "extensions", "a", ".postinstall-ran")), true);
    assert.equal(existsSync(join(root, "extensions", "b", ".postinstall-ran")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm invoked from an extension root prepares only that implicit workspace", () => {
  const root = createWorkspaceFixture();
  try {
    assertSucceeded(npmInstall(join(root, "extensions", "a")), "extension-root workspace install");
    assert.equal(existsSync(join(root, "extensions", "a", ".postinstall-ran")), true);
    assert.equal(existsSync(join(root, "extensions", "b", ".postinstall-ran")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed preparation prevents the local path from being registered", () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-failed-preparation-"));
  const packageRoot = join(root, "extension");
  const agentRoot = join(root, "agent");
  try {
    writePackage(packageRoot, "fixture-failure", { failPostinstall: true });
    const prepared = npmInstall(packageRoot);
    assert.notEqual(prepared.status, 0);
    if (prepared.status === 0) run(PI, ["install", packageRoot], { env: { PI_CODING_AGENT_DIR: agentRoot } });
    assert.equal(existsSync(join(agentRoot, "settings.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("full local aggregate prepares every workspace before one root registration", () => {
  const root = createWorkspaceFixture();
  const agentRoot = join(root, ".agent");
  try {
    assertSucceeded(npmInstall(root), "aggregate workspace install");
    assert.equal(existsSync(join(root, "extensions", "a", ".postinstall-ran")), true);
    assert.equal(existsSync(join(root, "extensions", "b", ".postinstall-ran")), true);
    assertSucceeded(run(PI, ["install", root], { env: { PI_CODING_AGENT_DIR: agentRoot } }), "aggregate Pi registration");
    const settings = JSON.parse(readFileSync(join(agentRoot, "settings.json"), "utf8"));
    assert.equal(resolve(agentRoot, settings.packages[0]), root);
    assert.equal(settings.packages.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project-local registration writes only the consumer project settings", () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-project-registration-"));
  const packageRoot = join(root, "extension");
  const projectRoot = join(root, "consumer");
  const agentRoot = join(root, "agent");
  try {
    writePackage(packageRoot, "fixture-project-local");
    mkdirSync(projectRoot);
    assertSucceeded(npmInstall(packageRoot), "project-local package preparation");
    assertSucceeded(run(PI, ["install", packageRoot, "-l", "--approve"], { cwd: projectRoot, env: { PI_CODING_AGENT_DIR: agentRoot } }), "project-local Pi registration");
    assert.equal(existsSync(join(agentRoot, "settings.json")), false);
    const settingsPath = join(projectRoot, ".pi", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(resolve(projectRoot, settings.packages[0]), packageRoot);
    assertSucceeded(run(PI, ["remove", packageRoot, "-l", "--approve"], { cwd: projectRoot, env: { PI_CODING_AGENT_DIR: agentRoot } }), "project-local Pi removal");
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).packages, []);
    assert.equal(existsSync(packageRoot), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every contained extension documents its executable local installation path", () => {
  const rootPackage = JSON.parse(readFileSync(join(SUITE_ROOT, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(join(SUITE_ROOT, "package-lock.json"), "utf8"));
  for (const entry of readdirSync(join(SUITE_ROOT, "extensions"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const extensionRoot = join(SUITE_ROOT, "extensions", entry.name);
    const packagePath = join(extensionRoot, "package.json");
    if (!existsSync(packagePath)) continue;
    const extensionPackage = JSON.parse(readFileSync(packagePath, "utf8"));
    const readme = readFileSync(join(extensionRoot, "README.md"), "utf8");
    if (entry.name === "guidepin") {
      assert.deepEqual(extensionPackage.pi, { extensions: [], skills: [] }, "guidepin must not register outside the suite");
      assert.ok(rootPackage.pi.extensions.includes("./extensions/guidepin/index.ts"));
      assert.match(readme, /## Install with jeito/);
      continue;
    }
    const specializedScript = `install:${entry.name}`;
    if (extensionPackage.scripts?.postinstall) {
      assert.equal(packageLock.packages?.[`extensions/${entry.name}`]?.hasInstallScript, true, `${entry.name} postinstall is missing from package-lock metadata`);
    }
    if (rootPackage.scripts?.[specializedScript]) {
      assert.ok(readme.includes(`npm run ${specializedScript}`), `${entry.name} README omits its specialized installer`);
      continue;
    }
    assert.match(readme, /npm install --omit=dev/);
    assert.ok(readme.includes(`--workspace ${extensionPackage.name}`), `${entry.name} README has stale workspace name`);
    assert.ok(readme.includes(`pi install \"$PWD/extensions/${entry.name}\"`), `${entry.name} README has stale Pi package path`);
  }
});
