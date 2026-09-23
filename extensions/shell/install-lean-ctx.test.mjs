import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { installLeanCtx } from "./scripts/install-lean-ctx.mjs";
import { inspectLeanCtxRuntime, leanCtxEnv, LEAN_CTX_VERSION, leanCtxTarget } from "./lean-ctx-runtime.mjs";

function fixtureArchive(root) {
  const source = join(root, "archive-source");
  mkdirSync(source, { recursive: true });
  const binary = join(source, "lean-ctx");
  writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "lean-ctx ${LEAN_CTX_VERSION}"; exit 0; fi\nexit 2\n`);
  chmodSync(binary, 0o755);
  const archive = join(root, "lean-ctx-test.tar.gz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", source, "lean-ctx"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  return { archive, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex") };
}

test("contained installer publishes a verified extension-local runtime without onboarding", async () => {
  const temp = mkdtempSync(join(tmpdir(), "shell-lean-ctx-install-"));
  try {
    const extensionRoot = join(temp, "extension");
    mkdirSync(extensionRoot);
    const fixture = fixtureArchive(temp);
    const target = leanCtxTarget();
    const result = await installLeanCtx({ extensionRoot, target, artifact: { file: "lean-ctx-test.tar.gz", sha256: fixture.sha256 }, archivePath: fixture.archive });
    assert.equal(result.ok, true);
    assert.deepEqual(readdirSync(extensionRoot).sort(), [".runtime"]);
    assert.equal(inspectLeanCtxRuntime(extensionRoot).ok, true);
    chmodSync(join(extensionRoot, ".runtime", "lean-ctx"), 0o644);
    assert.match(inspectLeanCtxRuntime(extensionRoot).reason, /not executable/);
    const installer = readFileSync(new URL("./scripts/install-lean-ctx.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(installer, /["'`]\s*(?:onboard|setup|wrap)\b/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("contained installer rejects an unpinned archive without publishing readiness", async () => {
  const temp = mkdtempSync(join(tmpdir(), "shell-lean-ctx-reject-"));
  try {
    const extensionRoot = join(temp, "extension");
    mkdirSync(extensionRoot);
    const fixture = fixtureArchive(temp);
    await assert.rejects(() => installLeanCtx({ extensionRoot, artifact: { file: "lean-ctx-test.tar.gz", sha256: "0".repeat(64) }, archivePath: fixture.archive }), /checksum mismatch/);
    assert.equal(inspectLeanCtxRuntime(extensionRoot).ok, false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("target selection covers the supported standalone package platforms", () => {
  assert.equal(leanCtxTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(leanCtxTarget("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(leanCtxTarget("linux", "arm64", "2.38"), "aarch64-unknown-linux-gnu");
  assert.equal(leanCtxTarget("linux", "x64", undefined), "x86_64-unknown-linux-musl");
  assert.throws(() => leanCtxTarget("win32", "x64"), /supports macOS and Linux/);
});

test("LeanCTX execution stays inside the extension and preserves bash job ownership", () => {
  const env = leanCtxEnv({ root: "/extension/.runtime" }, { HOME: "/user" });
  assert.equal(env.HOME, "/user");
  assert.equal(env.LEAN_CTX_CONFIG_DIR, "/extension/.runtime/data");
  assert.equal(env.LEAN_CTX_DATA_DIR, "/extension/.runtime/data");
  assert.equal(env.LEAN_CTX_STATE_DIR, "/extension/.runtime/data");
  assert.equal(env.LEAN_CTX_CACHE_DIR, "/extension/.runtime/data");
  assert.equal(env.LEAN_CTX_SHELL_SECURITY, "off");
  assert.equal(env.LEAN_CTX_SHELL_TIMEOUT_MS, "604800000");
});
