#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelCache = path.resolve(process.env.PI_NAV_TEST_QMD_CACHE ?? path.join(os.homedir(), ".cache", "qmd", "models"));
const npmCache = path.join(root, ".tmp", "release-validation", "npm-cache");
const image = process.env.PI_NAV_QMD_CONTAINER_IMAGE ?? "jeito-codeweave-pi-release-py312";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("validate:qmd:linux uses Apple container and requires a Darwin ARM64 host");
if (!existsSync(modelCache)) throw new Error(`Verified QMD model cache missing at ${modelCache}; run npm run qmd:model-provision first`);
mkdirSync(npmCache, { recursive: true });

const script = [
  "set -eu",
  "mkdir -p /tmp/project",
  "(cd /ext && tar --exclude='./node_modules' --exclude='./.runtime' --exclude='./.tmp' --exclude='./dist' -cf - .) | tar -xf - -C /tmp/project",
  "cd /tmp/project",
  "npm ci --ignore-scripts --no-audit --no-fund >/dev/null",
  "! command -v qmd",
  "node scripts/qmd-model-provision.mjs --verify-only",
].join("; ");

const child = spawnSync("container", [
  "run", "--rm", "--memory", "6G",
  "--mount", `type=bind,source=${root},target=/ext,readonly`,
  "--mount", `type=bind,source=${modelCache},target=/root/.cache/qmd/models,readonly`,
  "--mount", `type=bind,source=${npmCache},target=/root/.npm`,
  image, "sh", "-lc", script,
], { cwd: root, stdio: "inherit", timeout: 10 * 60_000 });

if (child.status !== 0 || child.error) throw new Error(`Linux ARM64 QMD container verification failed${child.error ? `: ${child.error.message}` : ` with exit ${child.status}`}. Build ${image} from containers/Containerfile.release-runtime if it is missing.`);
