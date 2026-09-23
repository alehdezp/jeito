#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { inspectLeanCtxRuntime, leanCtxEnv, LEAN_CTX_ARTIFACTS, LEAN_CTX_VERSION, leanCtxPaths, leanCtxTarget } from "../lean-ctx-runtime.mjs";

export const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_BASE = `https://github.com/yvgude/lean-ctx/releases/download/v${LEAN_CTX_VERSION}`;

function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function findBinary(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) { const found = findBinary(path); if (found) return found; }
    else if (entry.name === "lean-ctx") return path;
  }
}
async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "jeito-shell-installer" } });
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

export async function installLeanCtx({ extensionRoot = EXTENSION_ROOT, target = leanCtxTarget(), artifact = LEAN_CTX_ARTIFACTS[target], archivePath, releaseBase = RELEASE_BASE } = {}) {
  if (!artifact) throw new Error(`no pinned LeanCTX ${LEAN_CTX_VERSION} artifact for ${target}`);
  const paths = leanCtxPaths(extensionRoot);
  if (!archivePath) {
    const current = inspectLeanCtxRuntime(extensionRoot);
    if (current.ok) return { ok: true, reused: true, version: LEAN_CTX_VERSION, target, root: paths.root };
  }
  const work = join(extensionRoot, `.lean-ctx-install-${process.pid}-${Date.now()}`);
  const archive = join(work, artifact.file);
  const extracted = join(work, "extracted");
  const candidate = join(extensionRoot, `.runtime-candidate-${process.pid}-${Date.now()}`);
  rmSync(work, { recursive: true, force: true }); rmSync(candidate, { recursive: true, force: true });
  mkdirSync(extracted, { recursive: true }); mkdirSync(candidate, { recursive: true });
  try {
    if (archivePath) copyFileSync(archivePath, archive); else await download(`${releaseBase}/${artifact.file}`, archive);
    const archiveHash = sha256(archive);
    if (archiveHash !== artifact.sha256) throw new Error(`LeanCTX archive checksum mismatch: expected ${artifact.sha256}, got ${archiveHash}`);
    const unpacked = spawnSync("tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8" });
    if (unpacked.status !== 0) throw new Error(`LeanCTX extraction failed: ${(unpacked.stderr || unpacked.stdout).trim()}`);
    const source = findBinary(extracted);
    if (!source) throw new Error("LeanCTX archive does not contain lean-ctx");
    copyFileSync(source, join(candidate, "lean-ctx")); chmodSync(join(candidate, "lean-ctx"), 0o755);
    const version = spawnSync(join(candidate, "lean-ctx"), ["--version"], { encoding: "utf8", env: { ...leanCtxEnv({ root: candidate }), LEAN_CTX_NO_ONBOARD: "1" } });
    if (version.status !== 0 || !`${version.stdout}\n${version.stderr}`.includes(LEAN_CTX_VERSION)) throw new Error(`LeanCTX version check failed: ${(version.stderr || version.stdout).trim()}`);
    writeFileSync(join(candidate, ".ready"), `${JSON.stringify({ version: LEAN_CTX_VERSION, target, archiveSha256: archiveHash, binarySha256: sha256(join(candidate, "lean-ctx")) })}\n`, { mode: 0o600 });
    rmSync(paths.root, { recursive: true, force: true }); renameSync(candidate, paths.root);
    return { ok: true, version: LEAN_CTX_VERSION, target, root: paths.root };
  } finally { rmSync(work, { recursive: true, force: true }); rmSync(candidate, { recursive: true, force: true }); }
}

async function main() { console.log(JSON.stringify(await installLeanCtx())); }
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`LeanCTX shell installation failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
