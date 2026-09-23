import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_NAV_ADDON_API_VERSION } from "./pi-nav-native.ts";

export const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_RUNTIME_ROOT = join(EXTENSION_ROOT, ".runtime");
let runtimeRoot = process.env.NODE_TEST_CONTEXT && process.env.PI_NAV_TEST_RUNTIME_ROOT
  ? resolve(process.env.PI_NAV_TEST_RUNTIME_ROOT)
  : DEFAULT_RUNTIME_ROOT;

type LoadedPackageMetadata = {
  packageName?: string;
  packageVersion?: string;
  packageDigest?: string;
  indexDigest?: string;
  artifacts?: any;
};

const loadedMetadataByRoot = new Map<string, LoadedPackageMetadata>();
let loadedExtensionRoot = EXTENSION_ROOT;
loadedMetadataByRoot.set(EXTENSION_ROOT, readLoadedPackageMetadata(EXTENSION_ROOT));

export type LoadedRuntimeIdentity = {
  packageRoot: string;
  packageName?: string;
  packageVersion?: string;
  packageDigest?: string;
  sourceExists: boolean;
  sourceMatchesLoaded: boolean;
  stale: boolean;
  runtimeRoot: string;
  runtimeReady: boolean;
  nativeTarget: string;
  nativeArtifactDeclared: boolean;
  nativeAddonApiVersion: number;
};

export function setLoadedExtensionRootForTests(root?: string): void {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error("loaded extension root override is test-only");
  loadedExtensionRoot = root ? resolve(root) : EXTENSION_ROOT;
  if (root) loadedMetadataByRoot.set(loadedExtensionRoot, readLoadedPackageMetadata(loadedExtensionRoot));
}

export function loadedRuntimeIdentity(root = loadedExtensionRoot): LoadedRuntimeIdentity {
  const packageRoot = resolve(root);
  const loaded = loadedMetadataByRoot.get(packageRoot) ?? readLoadedPackageMetadata(packageRoot);
  loadedMetadataByRoot.set(packageRoot, loaded);
  const packagePath = join(packageRoot, "package.json");
  const indexPath = join(packageRoot, "index.ts");
  const sourceExists = existsSync(packagePath) && existsSync(indexPath);
  const currentPackageDigest = fileDigest(packagePath);
  const currentIndexDigest = fileDigest(indexPath);
  const sourceMatchesLoaded = sourceExists
    && currentPackageDigest === loaded.packageDigest
    && currentIndexDigest === loaded.indexDigest;
  const nativeTarget = `${process.platform}-${process.arch}`;
  return {
    packageRoot,
    packageName: loaded.packageName,
    packageVersion: loaded.packageVersion,
    packageDigest: loaded.packageDigest,
    sourceExists,
    sourceMatchesLoaded,
    stale: !sourceExists || !sourceMatchesLoaded,
    runtimeRoot,
    runtimeReady: ownedRuntimeReady(),
    nativeTarget,
    nativeArtifactDeclared: Boolean(loaded.artifacts?.targets?.[nativeTarget]),
    nativeAddonApiVersion: PI_NAV_ADDON_API_VERSION,
  };
}

function readLoadedPackageMetadata(root: string): LoadedPackageMetadata {
  const packagePath = join(root, "package.json");
  const artifactsPath = join(root, "native", "pi-nav", "artifacts.json");
  let packageJson: any;
  let artifacts: any;
  try { packageJson = JSON.parse(readFileSync(packagePath, "utf8")); } catch {}
  try { artifacts = JSON.parse(readFileSync(artifactsPath, "utf8")); } catch {}
  return {
    packageName: packageJson?.name,
    packageVersion: packageJson?.version,
    packageDigest: fileDigest(packagePath),
    indexDigest: fileDigest(join(root, "index.ts")),
    artifacts,
  };
}

function fileDigest(path: string): string | undefined {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return undefined; }
}

export type OwnedBackendRuntime = {
  root: string;
  python: string;
  command: string;
  version: string;
};

export function setExtensionRuntimeRootForTests(root?: string): void {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error("runtime root override is test-only");
  runtimeRoot = root ? resolve(root) : DEFAULT_RUNTIME_ROOT;
}

export function extensionRuntimePaths(root = runtimeRoot) {
  const bin = join(root, "bin");
  return {
    root,
    ready: join(root, ".ready"),
    python: join(bin, "python"),
    graphify: join(bin, "graphify"),
  };
}

export function ownedRuntimeReady(root = runtimeRoot): boolean {
  const paths = extensionRuntimePaths(root);
  return [paths.ready, paths.python, paths.graphify].every(existsSync);
}

export function ownedBackendRuntime(backend: "graphify", root = runtimeRoot): OwnedBackendRuntime | undefined {
  if (!ownedRuntimeReady(root)) return undefined;
  const paths = extensionRuntimePaths(root);
  return { root, python: paths.python, command: paths[backend], version: "0.9.23" };
}
