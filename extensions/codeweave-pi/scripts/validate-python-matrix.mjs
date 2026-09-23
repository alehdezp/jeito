#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const archive = process.env.PI_NAV_RELEASE_ARCHIVE ? path.resolve(process.env.PI_NAV_RELEASE_ARCHIVE) : "";
const minors = ["3.10", "3.11", "3.12", "3.13", "3.14"];
if (!archive || !existsSync(archive) || !["darwin", "linux"].includes(mode)) throw new Error("Usage: PI_NAV_RELEASE_ARCHIVE=/absolute/archive node scripts/validate-python-matrix.mjs darwin|linux");

function execute(command, args, label, options = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd: options.cwd ?? root, stdio: "inherit", env: options.env ?? process.env });
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? (console.log(`[release-matrix] ${label} passed in ${((performance.now() - started) / 1000).toFixed(1)}s`), resolve())
      : reject(new Error(`${label} exited ${code}`)));
  });
}

async function inPairs(work) {
  for (let index = 0; index < minors.length; index += 2) await Promise.all(minors.slice(index, index + 2).map((minor, offset) => work(minor, index + offset)));
}

function darwinPython(minor) {
  const configured = process.env[`PI_NAV_PYTHON_${minor.replace(".", "")}`];
  if (configured) return configured;
  const found = spawnSync("which", [`python${minor}`], { encoding: "utf8" }).stdout.trim();
  if (found) return found;
  throw new Error(`Missing Python ${minor}; set PI_NAV_PYTHON_${minor.replace(".", "")}=/absolute/path/to/python${minor}`);
}

async function validateDarwin(minor, index) {
  const temp = await mkdtemp(path.join(os.tmpdir(), `jeito-codeweave-pi-py${minor.replace(".", "")}-`));
  try {
    await execute("tar", ["-xzf", archive, "-C", temp], `extract Darwin Python ${minor}`);
    const cwd = path.join(temp, "jeito-codeweave-pi");
    const env = { ...process.env, PI_NAV_PYTHON: darwinPython(minor), ...(index === 0 ? { PIP_NO_CACHE_DIR: "1" } : {}) };
    await execute(process.execPath, ["scripts/navigation-provision.mjs", "--json"], `Darwin arm64 Python ${minor} install/import/CLI`, { env, cwd });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function validateLinux(minor, index) {
  const digits = minor.replace(".", "");
  const image = `jeito-codeweave-pi-release-py${digits}`;
  await execute("container", ["build", "-t", image, "-f", "containers/Containerfile.release-runtime", "--build-arg", `PYTHON_VERSION=${minor}`, "."], `build Linux Python ${minor} image`);
  const releaseDir = path.dirname(archive);
  const releaseFile = path.basename(archive);
  const install = `export PIP_NO_CACHE_DIR=1; mkdir -p /tmp/release; tar -xzf /release/${releaseFile} -C /tmp/release; cd /tmp/release/jeito-codeweave-pi; PI_NAV_PYTHON=$(command -v python) node scripts/navigation-provision.mjs --json`;
  await execute("container", ["run", "--rm", "--memory", "3G", "--mount", `type=bind,source=${releaseDir},target=/release,readonly`, "--mount", `type=bind,source=${path.join(root, ".tmp", "release-validation", "pip-cache")},target=/root/.cache/pip`, image, "sh", "-lc", install], `Linux arm64 Python ${minor} install/import/CLI`);
}

async function validateLinuxBehavior() {
  const image = "jeito-codeweave-pi-release-py312";
  const script = [
    "set -eu",
    "export PIP_NO_CACHE_DIR=1",
    "mkdir -p /tmp/project",
    "(cd /ext && tar --exclude='./.git' --exclude='./.runtime' --exclude='./.tmp' --exclude='./.ua' --exclude='./.pi' --exclude='./.pi-navigation.json' --exclude='./.code-review-graph' --exclude='./node_modules' --exclude='*/node_modules' --exclude='./dist' -cf - .) | tar -xf - -C /tmp/project",
    "cd /tmp/project",
    "npm ci --no-audit --no-fund >/dev/null",
    "! command -v qmd",
    "node scripts/qmd-local-runtime-smoke.mjs",
    "node scripts/pi-nav-build.mjs check-core --json",
    "node --test --test-concurrency=1 tests/v3-clean-break-navigation.test.mjs tests/v3-qmd-docs-search.test.mjs tests/v3-qmd-docs-refresh.test.mjs tests/v3-graphify-shrink-recovery.test.mjs tests/v3-query-time-non-mutation.test.mjs",
  ].join("; ");
  await execute("container", ["run", "--rm", "--memory", "6G", "--mount", `type=bind,source=${root},target=/ext,readonly`, "--mount", `type=bind,source=${path.join(root, ".tmp", "release-validation", "pip-cache")},target=/root/.cache/pip`, "--mount", `type=bind,source=${path.join(root, ".tmp", "release-validation", "qmd-cache", "qmd")},target=/root/.cache/qmd`, image, "sh", "-lc", script], "Linux arm64 full Core/Graphify/QMD behavior");
}

await mkdir(path.join(root, ".tmp", "release-validation", "pip-cache"), { recursive: true });
if (mode === "darwin") await inPairs(validateDarwin);
else {
  await inPairs(validateLinux);
  await validateLinuxBehavior();
}
