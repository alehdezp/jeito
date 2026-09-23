#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tier = process.argv[2] ?? "inner";
const valid = ["inner", "qmd", "checkpoint", "release"];
if (!valid.includes(tier)) throw new Error(`Usage: node scripts/validate-release.mjs ${valid.join("|")}`);
const releaseStarted = performance.now();
const releaseDeadlineMs = 60 * 60_000;
const activeProcessGroups = new Set();

function terminateActive() {
  for (const pid of activeProcessGroups) {
    try { process.kill(-pid, "SIGTERM"); } catch {}
  }
  activeProcessGroups.clear();
}

function run(label, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const requestedTimeout = options.timeoutMs ?? 30 * 60_000;
    const remaining = releaseDeadlineMs - (performance.now() - releaseStarted);
    const timeoutMs = tier === "release" ? Math.max(1, Math.min(requestedTimeout, remaining)) : requestedTimeout;
    const child = spawn(command, args, { cwd: options.cwd ?? root, env: options.env ?? process.env, stdio: "inherit", detached: true });
    activeProcessGroups.add(child.pid);
    const timer = setTimeout(() => {
      terminateActive();
      reject(new Error(`${label} exceeded the ${Math.round(timeoutMs / 1000)}s remaining budget`));
    }, timeoutMs);
    child.once("error", error => {
      clearTimeout(timer);
      activeProcessGroups.delete(child.pid);
      terminateActive();
      reject(error);
    });
    child.once("exit", code => {
      clearTimeout(timer);
      activeProcessGroups.delete(child.pid);
      if (code !== 0) {
        terminateActive();
        return reject(new Error(`${label} exited ${code}`));
      }
      console.log(`[validate:${tier}] ${label} passed in ${((performance.now() - started) / 1000).toFixed(1)}s`);
      resolve();
    });
  });
}

function buildPackage() {
  const timeout = tier === "release" ? Math.max(1, Math.min(10 * 60_000, releaseDeadlineMs - (performance.now() - releaseStarted))) : 10 * 60_000;
  const result = spawnSync(process.execPath, ["scripts/pi-nav-build.mjs", "package", "--development", "--json"], { cwd: root, env: process.env, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`package build failed: ${result.stderr || result.stdout}`);
  const artifact = result.stdout.trim().split(/\r?\n/).reverse().map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(Boolean);
  if (!artifact?.archive) throw new Error("package build returned no archive");
  console.log(`[validate:${tier}] package built once: ${artifact.archive}`);
  return artifact.archive;
}

await run("installer syntax", process.execPath, ["--check", "scripts/navigation-provision.mjs"]);
await run("QMD model installer syntax", process.execPath, ["--check", "scripts/qmd-model-provision.mjs"]);
await run("inner contracts", process.execPath, ["--test", "--test-concurrency=1",
  "tests/v3-navigation-provision.test.mjs",
  "tests/v3-backend-registry.test.mjs",
  "tests/v3-navigation-redaction.test.mjs",
  "tests/v3-graphify-scope-policy.test.mjs",
  "tests/v3-qmd-model-provision.test.mjs",
]);
if (tier === "inner") process.exit(0);

if (tier === "qmd") {
  await run("QMD provider, indexing, and startup contracts", process.execPath, ["--test", "--test-concurrency=1",
    "tests/v3-navigation-setup-planner.test.mjs",
    "tests/v3-navigation-freshen.test.mjs",
    "tests/v3-qmd-docs-search.test.mjs",
    "tests/v3-qmd-docs-refresh.test.mjs",
    "tests/v3-voyage-provider.test.mjs",
    "tests/v3-openrouter-provider.test.mjs",
  ]);
  await run("cached QMD embedding and reranker load", process.execPath, ["scripts/qmd-model-provision.mjs", "--verify-only"]);
  process.exit(0);
}

if (tier === "release" && (process.platform !== "darwin" || process.arch !== "arm64")) throw new Error("Release orchestration requires the declared darwin-arm64 host.");
if (tier === "release" && !process.env.PI_NAV_TEST_PYTHON) throw new Error("Set PI_NAV_TEST_PYTHON=/absolute/path/to/python3 for the real Pi Git lifecycle.");
const sharedQmdCache = tier === "release" ? path.join(root, ".tmp", "release-validation", "qmd-cache") : undefined;
const hostValidationEnv = {
  ...process.env,
  ...(process.env.PI_NAV_TEST_PYTHON ? { PI_NAV_PYTHON: process.env.PI_NAV_TEST_PYTHON } : {}),
  ...(sharedQmdCache ? { XDG_CACHE_HOME: sharedQmdCache, PI_NAV_TEST_QMD_CACHE: path.join(sharedQmdCache, "qmd", "models") } : {}),
};
if (sharedQmdCache) await run("shared QMD embedding and reranker cache", process.execPath, ["scripts/qmd-model-provision.mjs"], { env: hostValidationEnv, timeoutMs: 30 * 60_000 });

await run("real host runtime install", process.execPath, ["scripts/navigation-provision.mjs", "--json"], { env: hostValidationEnv });
await run("cached QMD embedding and reranker load", process.execPath, ["scripts/qmd-model-provision.mjs", "--verify-only"], { env: hostValidationEnv });
await run("affected backend contracts", process.execPath, ["--test", "--test-concurrency=1",
  "tests/v3-navigation-first-open-package.test.mjs",
  "tests/v3-loaded-tools.test.mjs",
  "tests/v3-navigation-prepare.test.mjs",
  "tests/v3-navigation-freshen.test.mjs",
  "tests/v3-clean-break-navigation.test.mjs",
  "tests/v3-qmd-docs-search.test.mjs",
  "tests/v3-qmd-docs-refresh.test.mjs",
  "tests/v3-graphify-shrink-recovery.test.mjs",
  "tests/v3-query-time-non-mutation.test.mjs",
]);
await run("host Core package identity", process.execPath, ["scripts/pi-nav-build.mjs", "check-core", "--json"]);
if (tier === "checkpoint") process.exit(0);

await run("Apple container service", "container", ["system", "status"], { timeoutMs: 30_000 });
const archive = buildPackage();
const releaseEnv = { ...hostValidationEnv, PI_NAV_RELEASE_ARCHIVE: archive };
await Promise.all([
  run("package lifecycle", process.execPath, ["--test", "--test-concurrency=1", "tests/v3-pi-nav-package.test.mjs", "tests/v3-production-readiness-release.test.mjs"], { env: releaseEnv, timeoutMs: 45 * 60_000 }),
  run("pinned standalone and root Pi Git lifecycles", process.execPath, ["--test", "--test-concurrency=1", "tests/v3-release-git-install.test.mjs", "tests/v3-root-aggregate-git-install.test.mjs"], { env: releaseEnv, timeoutMs: 55 * 60_000 }),
  run("Darwin Python 3.10–3.14", process.execPath, ["scripts/validate-python-matrix.mjs", "darwin"], { env: releaseEnv, timeoutMs: 45 * 60_000 }),
  run("Linux arm64 Python and behavior", process.execPath, ["scripts/validate-python-matrix.mjs", "linux"], { env: releaseEnv, timeoutMs: 55 * 60_000 }),
]);
const totalMinutes = (performance.now() - releaseStarted) / 60_000;
if (totalMinutes > 60) throw new Error(`release gate exceeded 60 minutes: ${totalMinutes.toFixed(1)}`);
console.log(`[validate:release] complete in ${totalMinutes.toFixed(1)} minutes`);
