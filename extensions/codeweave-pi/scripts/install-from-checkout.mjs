#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suiteRoot = path.resolve(extensionRoot, "../..");
const supportedTargets = new Set(["darwin-arm64", "linux-arm64"]);
const commandTimeoutMs = 20 * 60_000;

function run(command, args, cwd, label, { capture = false } = {}) {
  const child = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    timeout: commandTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.status === 0 && !child.error) return capture ? child.stdout.trim() : "";
  const detail = String(child.stderr || child.stdout || child.error?.message || `exit ${child.status}`).trim().slice(-4000);
  throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
}

function assertPrerequisites() {
  const target = `${process.platform}-${process.arch}`;
  if (!supportedTargets.has(target)) throw new Error(`Unsupported target ${target}; supported targets are darwin-arm64 and linux-arm64.`);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error(`Node 22.19+ is required; found ${process.versions.node}.`);
  const piVersion = run("pi", ["--version"], suiteRoot, "Pi version check", { capture: true });
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(piVersion);
  const [piMajor, piMinor, piPatch] = match ? match.slice(1).map(Number) : [];
  const piSupported = piMajor > 0 || piMajor === 0 && (piMinor > 82 || piMinor === 82 && piPatch >= 1);
  if (!piSupported) throw new Error(`Pi 0.82.1+ is required; found ${piVersion || "unknown"}.`);
}

function assertInstalledRuntime() {
  const required = [
    "native/qmd/runtime/index.js",
    "node_modules/node-llama-cpp/package.json",
  ];
  for (const relative of required) {
    if (!existsSync(path.join(extensionRoot, relative))) throw new Error(`codeweave-pi installation is incomplete: missing ${relative}.`);
  }
}

try {
  if (process.argv.length > 2) throw new Error("install:codeweave-pi accepts no arguments. Python is only needed for optional Graphify setup.");
  assertPrerequisites();
  console.log("Installing only jeito codeweave-pi from this checkout…");
  run("npm", ["ci", "--omit=dev", "--workspaces=false", "--no-audit", "--no-fund"], extensionRoot, "codeweave-pi npm installation");
  assertInstalledRuntime();
  run(process.execPath, ["scripts/pi-nav-build.mjs", "check-core", "--json"], extensionRoot, "Core runtime and code-semantic verification");
  run("pi", ["install", extensionRoot], suiteRoot, "Pi local-path registration");
  console.log(`\njeito codeweave-pi is installed from ${extensionRoot}`);
  console.log("Keep this checkout at the same path. Restart Pi; eligible projects use automatic Core code and QMD document preparation under the configured consent policy.");
  console.log("Graphify cross-domain maps are optional: npm run nav:provision:legacy. Existing stores are not migrated.");
} catch (error) {
  console.error(`[jeito-codeweave-pi:checkout-install] ${error instanceof Error ? error.message : String(error)}`);
  console.error("codeweave-pi was not registered unless every installation and runtime check completed first.");
  process.exitCode = 1;
}
