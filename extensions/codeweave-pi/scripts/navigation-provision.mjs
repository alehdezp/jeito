#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GRAPHIFY_EXTRAS, GRAPHIFY_PIN } from "../src/core/backend-registry.ts";
import { EXTENSION_ROOT, extensionRuntimePaths } from "../src/core/owned-runtime.ts";

const SUPPORTED_PYTHON_MINORS = ["3.10", "3.11", "3.12", "3.13", "3.14"];
const COMMAND_TIMEOUT_MS = 20 * 60_000;

export async function provisionNavigationRuntime(options = {}) {
  const env = options.env ?? process.env;
  const extensionRoot = path.resolve(options.extensionRoot ?? EXTENSION_ROOT);
  const paths = extensionRuntimePaths(path.join(extensionRoot, ".runtime"));
  rmSync(paths.ready, { force: true });
  const python = resolveCompatiblePython(env);
  rmSync(paths.root, { recursive: true, force: true });
  run(python.command, ["-m", "venv", paths.root], extensionRoot, env, "venv creation");
  run(paths.python, ["-m", "pip", "install", `graphifyy[${GRAPHIFY_EXTRAS}]==${GRAPHIFY_PIN}`], extensionRoot, { ...env, PYTHONNOUSERSITE: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" }, "pip install");
  verifyRuntime(paths, extensionRoot, env);
  writeFileSync(paths.ready, `graphifyy=${GRAPHIFY_PIN}\n`, { mode: 0o600 });
  return { status: "installed", root: paths.root, python: python.version };
}

export function resolveCompatiblePython(env = process.env) {
  const configured = env.PI_NAV_PYTHON?.trim();
  const commands = configured ? [configured] : ["python3", ...[...SUPPORTED_PYTHON_MINORS].reverse().map(minor => `python${minor}`), "python"];
  const detected = [];
  for (const command of new Set(commands)) {
    const probe = spawnSync(command, ["-c", "import json,sys; print(json.dumps({'version':f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}','minor':f'{sys.version_info.major}.{sys.version_info.minor}'}))"], { encoding: "utf8", env, timeout: 10_000 });
    if (probe.status !== 0) continue;
    const info = JSON.parse(probe.stdout.trim());
    detected.push(`${command}=${info.version}`);
    if (!SUPPORTED_PYTHON_MINORS.includes(info.minor)) continue;
    if (spawnSync(command, ["-m", "venv", "--help"], { encoding: "utf8", env, timeout: 10_000 }).status === 0) return { command, version: info.version, minor: info.minor };
    detected.push(`${command}:venv-unavailable`);
  }
  throw new Error(`No compatible Python 3.10–3.14 interpreter with venv was found. Detected: ${detected.join(", ") || "none on PATH"}. Set PI_NAV_PYTHON=/absolute/path/to/python3.x and rerun npm run nav:provision:legacy.`);
}

function verifyRuntime(paths, extensionRoot, env) {
  const verify = [
    "import importlib.metadata as m, graphify",
    `assert m.version('graphifyy') == '${GRAPHIFY_PIN}'`,
  ].join("; ");
  const childEnv = { ...env, PYTHONNOUSERSITE: "1" };
  run(paths.python, ["-c", verify], extensionRoot, childEnv, "runtime verification");
  run(paths.graphify, ["--help"], extensionRoot, childEnv, "Graphify CLI verification");
}

function run(command, args, cwd, env, label) {
  const child = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  if (child.status === 0 && !child.error) return;
  const detail = String(child.stderr || child.stdout || child.error?.message || `exit ${child.status}`).trim().slice(-4000);
  throw new Error(`${label} failed: ${detail}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg !== "--json")) throw new Error(`Unknown provisioning argument: ${process.argv.slice(2).join(" ")}`);
    console.log(JSON.stringify({ ok: true, ...await provisionNavigationRuntime() }));
  } catch (error) {
    console.error(`[jeito-codeweave-pi:provision] ${error?.message ?? error}`);
    console.error("Stop Pi, correct the prerequisite, rerun npm run nav:provision:legacy, then restart Pi.");
    process.exitCode = 1;
  }
}
