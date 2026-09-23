import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LEAN_CTX_VERSION = "3.9.12";
export const LEAN_CTX_ARTIFACTS = Object.freeze({
  "aarch64-apple-darwin": { file: "lean-ctx-aarch64-apple-darwin.tar.gz", sha256: "ba441a98e59490a3a41826041c9f12bc18d7b4b660113031be72693f280c5861" },
  "x86_64-apple-darwin": { file: "lean-ctx-x86_64-apple-darwin.tar.gz", sha256: "77e240b7498cc51d594f1287497d2d431a6aeaf11b87e22e88c47418329338db" },
  "aarch64-unknown-linux-gnu": { file: "lean-ctx-aarch64-unknown-linux-gnu.tar.gz", sha256: "c049662abc2cb5e30db127e0ce71e2d7c4ef63d50ac23d76967c4c43603c7211" },
  "aarch64-unknown-linux-musl": { file: "lean-ctx-aarch64-unknown-linux-musl.tar.gz", sha256: "3ba2fe886e905cb3797fe69072bac1b41f30c4a8232ea14073bac462aa01527c" },
  "x86_64-unknown-linux-gnu": { file: "lean-ctx-x86_64-unknown-linux-gnu.tar.gz", sha256: "57982aa9891537ff7323f52b49c1aae2c0452bfe2f89178b6436980aa0e7a802" },
  "x86_64-unknown-linux-musl": { file: "lean-ctx-x86_64-unknown-linux-musl.tar.gz", sha256: "4f19d1f2b9522ae9629d40d73433ff38b71750d14ab0230c26a1c1a5d309c014" },
});

const DEFAULT_ROOT = dirname(fileURLToPath(import.meta.url));
let rootOverride;

export function leanCtxTarget(platform = process.platform, arch = process.arch, glibc = process.report?.getReport?.().header?.glibcVersionRuntime) {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  if (!cpu) throw new Error(`LeanCTX shell compression does not support architecture ${arch}`);
  if (platform === "darwin") return `${cpu}-apple-darwin`;
  if (platform === "linux") return `${cpu}-unknown-linux-${glibc ? "gnu" : "musl"}`;
  throw new Error(`LeanCTX shell compression supports macOS and Linux, not ${platform}`);
}

export function leanCtxPaths(extensionRoot = rootOverride ?? DEFAULT_ROOT) {
  const root = join(extensionRoot, ".runtime");
  return { root, binary: join(root, "lean-ctx"), ready: join(root, ".ready") };
}

function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

export function inspectLeanCtxRuntime(extensionRoot) {
  const paths = leanCtxPaths(extensionRoot);
  if (!existsSync(paths.binary) || !existsSync(paths.ready)) return { ok: false, reason: `LeanCTX runtime is missing; reinstall this extension to create ${paths.root}` };
  try { accessSync(paths.binary, constants.X_OK); } catch { return { ok: false, reason: "LeanCTX runtime is not executable; reinstall this extension" }; }
  try {
    const ready = JSON.parse(readFileSync(paths.ready, "utf8"));
    const target = leanCtxTarget();
    if (ready.version !== LEAN_CTX_VERSION || ready.target !== target) return { ok: false, reason: `LeanCTX runtime identity mismatch; reinstall this extension for ${target}` };
    if (ready.binarySha256 !== sha256(paths.binary)) return { ok: false, reason: "LeanCTX runtime checksum mismatch; reinstall this extension" };
    return { ok: true, root: paths.root, binary: paths.binary, version: ready.version, target };
  } catch (error) { return { ok: false, reason: `LeanCTX runtime metadata is invalid: ${error instanceof Error ? error.message : String(error)}` }; }
}

export function requireLeanCtxRuntime(extensionRoot) {
  const runtime = inspectLeanCtxRuntime(extensionRoot);
  if (!runtime.ok) throw new Error(runtime.reason);
  return runtime;
}

export function leanCtxEnv(runtime, base = process.env) {
  const dataRoot = join(runtime.root, "data");
  return {
    ...base,
    LEAN_CTX_COMPRESS: "1",
    LEAN_CTX_SAVINGS_FOOTER: "always",
    LEAN_CTX_SHELL_SECURITY: "off",
    LEAN_CTX_SHELL_TIMEOUT_MS: "604800000",
    LEAN_CTX_CONFIG_DIR: dataRoot,
    LEAN_CTX_DATA_DIR: dataRoot,
    LEAN_CTX_STATE_DIR: dataRoot,
    LEAN_CTX_CACHE_DIR: dataRoot,
  };
}


export function setLeanCtxRuntimeRootForTests(root) {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error("LeanCTX runtime override is test-only");
  rootOverride = root;
}
