#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { piNavArtifactPaths, resolvePiNavTarget, PI_NAV_BASE_CAPABILITIES, PI_NAV_GREP_CAPABILITIES } from "../src/core/pi-nav-native.ts";
import { ANALYSIS_REVISION, KERNEL_VERSION, ANALYSIS_OUTPUT_ARTIFACTS, MAINTENANCE_OUTPUT_ARTIFACTS, SEMANTIC_MODEL_DIRECTORY } from "../native/analysis/identity.mjs";

const extensionRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE_VERSION = "0.9.0";
const MANIFEST_NAME = "RELEASE-MANIFEST.json";
const MANIFEST_SCHEMA_VERSION = 1;
const REQUIRED_CAPABILITIES = [...PI_NAV_BASE_CAPABILITIES, ...PI_NAV_GREP_CAPABILITIES];
const SOURCE_FILES = [
  "index.ts",
  "package.json",
  "package-lock.json",
  "README.md",
  "AGENTS.md",
];
const SOURCE_DIRECTORIES = ["src", "scripts", "skills", "docs/upstream", "docs/decisions"];
const CANONICAL_DOCS = [
  "README.md",
  "harness-doctrine.md",
  "automatic-workflow.md",
  "evidence.md",
  "current-truth.md",
  "setup.md",
  "evaluation-workflow.md",
  "ui-rendering.md",
  "management.md",
].map((name) => `docs/${name}`);
// Ignored local tool-state mounts are not package inputs.
const EXCLUDED_SOURCE_PATHS = new Set([
  "src/.codanna", "src/.fastembed_cache", "src/graphify-out",
  "native/qmd/runtime/bench", "native/qmd/runtime/cli", "native/qmd/runtime/mcp",
  // Container/dev test harnesses are QA tooling, not runtime — never ship them.
  "scripts/test-graphify-minimax.sh",
]);
const CORE_RUNTIME_FILES = [...Object.values(ANALYSIS_OUTPUT_ARTIFACTS),
  ...Object.values(MAINTENANCE_OUTPUT_ARTIFACTS)].map(name => `native/analysis/runtime/${name}`);
const CODE_MODEL_FILES = ["config.json", "tokenizer.json", "model.safetensors"]
  .map(name => `native/analysis/runtime/${SEMANTIC_MODEL_DIRECTORY}/${name}`);
const NATIVE_FILES = [
  "native/analysis/identity.mjs",
  "native/analysis/README.md",
  ...CORE_RUNTIME_FILES,
  ...CODE_MODEL_FILES,
  "native/pi-nav/README.md",
  "native/pi-nav/ARCHITECTURE.md",
  "native/pi-nav/UPSTREAM.md",
  "native/pi-nav/AGENTS.md",
  "native/pi-nav/LICENSE",
  "native/pi-nav/artifacts.json",
  "native/qmd/LICENSE",
  "native/qmd/UPSTREAM.md",
];
const NATIVE_DIRECTORIES = ["native/pi-nav/prompts", "native/qmd/runtime", "native/analysis/runtime/wasm"];
const ALLOWED_EXECUTABLE_SOURCE_FILES = new Set([
  "scripts/navigation-tool-feel-eval.mjs",
  "scripts/navigation-freshen.mjs",
  "scripts/navigation-doctor.mjs",
]);

const ANALYSIS_SOURCE_DIR = path.join(extensionRoot, "native", "analysis");
const ANALYSIS_ENTRY = path.join(ANALYSIS_SOURCE_DIR, "entry.ts");
const ANALYSIS_KERNEL_CRATE = path.join(ANALYSIS_SOURCE_DIR, "codegraph-kernel");
const ANALYSIS_KERNEL_MANIFEST = path.join(ANALYSIS_KERNEL_CRATE, "Cargo.toml");
const ANALYSIS_SCHEMA = path.join(ANALYSIS_SOURCE_DIR, "schema.sql");
// Sealed entry contract: the bundle must export these runtime callables, and the
// sealed kernel loader resolves only the adjacent .node (no host fallback).
const ANALYSIS_REQUIRED_EXPORTS = [
  "QueryBuilder",
  "ReferenceResolver",
  "decodeExtractBuffers",
  "getKernel",
  "installSource",
  "assertSourceBoundary",
];
class PiNavPackageError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "PiNavPackageError";
    this.code = code;
    this.details = details;
  }
}

const [command, ...commandArgs] = process.argv.slice(2);
const jsonOutput = commandArgs.includes("--json");

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
try {
  let result;
  if (command === "build") result = await build();
  else if (command === "check") result = await check(extensionRoot);
  else if (command === "check-core") result = await checkCore(extensionRoot);
  else if (command === "package") result = await packageRelease(parsePackageOptions(commandArgs));
  else if (command === "analysis-build") result = await analysisBuild(commandArgs);
  else throw new PiNavPackageError("usage", "usage: node scripts/pi-nav-build.mjs <build|check|check-core|package|analysis-build> [--development] [--core-runtime <sealed directory>] [--json]");
  if (jsonOutput) console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  const failure = normalizeFailure(error);
  if (jsonOutput) console.error(JSON.stringify({ ok: false, ...failure }));
  else console.error(`[pi-nav:${failure.code}] ${failure.message}`);
  process.exitCode = failure.code === "usage" ? 2 : 1;
}
}

async function build() {
  const target = resolvePiNavTarget();
  const artifacts = piNavArtifactPaths(extensionRoot, target);
  await mkdir(path.join(extensionRoot, ".tmp"), { recursive: true });
  const tempRoot = await mkdtemp(path.join(extensionRoot, ".tmp", "pi-nav-build-"));
  try {
    const outputDir = path.join(tempRoot, "addon");
    const targetDir = path.join(extensionRoot, ".tmp", "pi-nav-cargo", "addon");
    await mkdir(outputDir, { recursive: true });
    // Build the host artifact directly: NapiCli's unfiltered metadata request needs
    // unrelated platform dependencies even when the selected target is cached offline.
    const output = await capture(process.env.CARGO ?? "cargo", [
      "build", "--locked", "--manifest-path", path.join(extensionRoot, "native", "pi-nav", "Cargo.toml"),
      "--package", "pi-nav", "--lib", "--features", "napi-addon", "--release",
      "--target", target.rustTarget, "--target-dir", targetDir, "--message-format=json",
    ]);
    const nativeOutputs = output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
      .filter(message => message.reason === "compiler-artifact" && message.target.name === "pi_nav"
        && message.target.crate_types.includes("cdylib"))
      .flatMap(message => message.filenames).filter(file => /\.(dylib|so|dll)$/.test(file));
    if (nativeOutputs.length !== 1) throw new PiNavPackageError("build_output", `expected one pi-nav shared library, received ${nativeOutputs.length}`);
    // Signing and publication must never mutate Cargo's cached shared library.
    const builtAddon = path.join(outputDir, path.basename(artifacts.addon));
    await copyFile(nativeOutputs[0], builtAddon);
    await normalizeDarwinInstallName(target, builtAddon);
    await signDarwinDevelopmentArtifact(target, builtAddon);

    const cliTargetDir = path.join(extensionRoot, ".tmp", "pi-nav-cargo", "cli");
    await run("cargo", [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      path.join(extensionRoot, "native", "pi-nav", "Cargo.toml"),
      "--bin",
      "pi-nav",
      "--target",
      target.rustTarget,
      "--target-dir",
      cliTargetDir,
    ]);
    // Preserve Cargo's cached executable; signing and publication use a staged copy.
    const builtCli = path.join(tempRoot, target.platform === "win32" ? "pi-nav.exe" : "pi-nav");
    await copyFile(path.join(cliTargetDir, target.rustTarget, "release", path.basename(builtCli)), builtCli);
    if (target.platform !== "win32") await chmod(builtCli, 0o755);
    await signDarwinDevelopmentArtifact(target, builtCli);
    const staged = { addon: builtAddon, cli: builtCli };
    await verifyNativeCompatibility(target, staged);
    await inspectAddonAndSmoke(extensionRoot, staged, target);
    await mkdir(path.dirname(artifacts.addon), { recursive: true });
    await mkdir(path.dirname(artifacts.cli), { recursive: true });
    // Never truncate a loaded addon or running CLI inode. Finish and check both candidates
    // before replacement; rename is atomic per file, not a two-file release transaction.
    await rename(builtAddon, artifacts.addon);
    await rename(builtCli, artifacts.cli);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  const checked = await check(extensionRoot);
  if (!jsonOutput) console.log(`pi-nav build ok (${target.releaseKey}, ${target.rustTarget})`);
  return { command: "build", target: target.releaseKey, check: checked };
}

// Isolated analysis build. Bundles native/analysis/entry.ts to core.cjs using the
// extension's declared dev dependencies, stages the codegraph-kernel artifact from
// the crate's persistent dev target dir adjacent as codegraph-kernel.node, and
// copies schema.sql — all into one explicit output directory. Never writes
// installed native/runtime paths and never rebuilds the pi-nav addon/CLI: the
// kernel comes from an incremental dev `cargo build` (no --release, no --target).
async function analysisBuild(commandArgs) {
  const { ANALYSIS_OUTPUT_ARTIFACTS, MAINTENANCE_OUTPUT_ARTIFACTS } = await import(new URL('../native/analysis/identity.mjs', import.meta.url));
  const { outputDir, maintenanceGrammars, semanticModel } = parseAnalysisBuildOptions(commandArgs);
  // Explicit existing input only: no cache discovery, downloads or grammar swaps.
  let grammarNames = [];
  if (maintenanceGrammars !== undefined) {
    if (!path.isAbsolute(maintenanceGrammars) || await realpath(maintenanceGrammars) !== maintenanceGrammars
      || !(await lstat(maintenanceGrammars)).isDirectory()) {
      throw new PiNavPackageError('analysis_grammars', '--maintenance-grammars requires a canonical existing directory');
    }
    grammarNames = (await readdir(maintenanceGrammars)).filter(name => /^tree-sitter-[\w-]+\.wasm$/.test(name)).sort();
    if (!grammarNames.length) throw new PiNavPackageError('analysis_grammars', 'maintenance grammar directory contains no tree-sitter WASM files');
    for (const name of grammarNames) await assertRegularFile(path.join(maintenanceGrammars, name), 'analysis_grammar');
  }
  const modelNames = semanticModel === undefined ? [] : ["config.json", "tokenizer.json", "model.safetensors"];
  if (semanticModel !== undefined) {
    if (!maintenanceGrammars || !path.isAbsolute(semanticModel) || await realpath(semanticModel) !== semanticModel
      || !(await lstat(semanticModel)).isDirectory()) throw new PiNavPackageError('analysis_model', '--semantic-model requires a canonical existing directory and --maintenance-grammars');
    for (const name of modelNames) await assertRegularFile(path.join(semanticModel, name), 'analysis_model');
  }
  let existingParent = path.resolve(outputDir);
  while (!(await stat(existingParent).catch(error => { if (error.code === "ENOENT") return null; throw error; }))) existingParent = path.dirname(existingParent);
  const resolvedOutput = path.join(await realpath(existingParent), path.relative(existingParent, path.resolve(outputDir)));
  const localOutput = path.relative(await realpath(extensionRoot), resolvedOutput);
  if (!localOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(localOutput) && !localOutput.startsWith(`.tmp${path.sep}`)) {
    throw new PiNavPackageError("analysis_output", "analysis-build requires an isolated directory, not installed source/runtime paths");
  }
  await assertRegularFile(ANALYSIS_ENTRY, "analysis_entry");
  await assertRegularFile(ANALYSIS_KERNEL_MANIFEST, "analysis_cargo");
  await assertRegularFile(ANALYSIS_SCHEMA, "analysis_schema");
  const crateVersion = await readAnalysisCrateVersion(ANALYSIS_KERNEL_MANIFEST);
  await mkdir(resolvedOutput, { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(resolvedOutput), ".analysis-build-"));
  const staged = Object.values(ANALYSIS_OUTPUT_ARTIFACTS).map(name => path.join(staging, name));
  let checked;
  let kernelPreserved = false;
  const maintenanceFiles = maintenanceGrammars === undefined ? [] : Object.values(MAINTENANCE_OUTPUT_ARTIFACTS);
  const grammarFiles = grammarNames.map(name => path.join('wasm', name));
  try {
    await bundleAnalysisEntry(staged[0]);
    await buildAnalysisKernel(staged[1]);
    await copyFile(ANALYSIS_SCHEMA, staged[2]);
    const noticeFiles = ["LICENSE", "KOTLIN-NOTICE", "codegraph-kernel/grammars/dart/LICENSE", "codegraph-kernel/grammars/lua/LICENSE", "codegraph-kernel/grammars/scala/LICENSE"];
    const notices = [];
    for (const name of noticeFiles) {
      const source = path.join(ANALYSIS_SOURCE_DIR, name);
      await assertRegularFile(source, "analysis_notice");
      notices.push(`${name}\n\n${await readFile(source, "utf8")}`);
    }
    await writeFile(staged[3], notices.join("\n\n"));
    if (maintenanceGrammars !== undefined) {
      const entries = {
        entry: 'maintenance.ts',
        parseWorker: 'src/extraction/parse-worker.ts',
        storeWorker: 'src/extraction/store-worker.ts',
      };
      for (const [key, source] of Object.entries(entries)) {
        await bundleAnalysisEntry(path.join(staging, MAINTENANCE_OUTPUT_ARTIFACTS[key]), path.join(ANALYSIS_SOURCE_DIR, source));
      }
      await copyFile(path.join(ANALYSIS_SOURCE_DIR, 'src/db/schema.sql'), path.join(staging, MAINTENANCE_OUTPUT_ARTIFACTS.schema));
      await writeFile(path.join(staging, MAINTENANCE_OUTPUT_ARTIFACTS.package), JSON.stringify({ type: 'commonjs' }) + '\n');
      await mkdir(path.join(staging, 'wasm'));
      for (const name of grammarNames) await copyFile(path.join(maintenanceGrammars, name), path.join(staging, 'wasm', name));
      const kernelDestination = path.join(resolvedOutput, ANALYSIS_OUTPUT_ARTIFACTS.kernel);
      if (await pathExists(kernelDestination)) {
        await assertRegularFile(kernelDestination, 'analysis_kernel');
        if (await sha256File(kernelDestination) !== await sha256File(staged[1])) {
          throw new PiNavPackageError('analysis_kernel_identity', 'maintenance staging will not replace an existing kernel; use a fresh isolated output directory');
        }
        kernelPreserved = true;
      }
      for (const directory of ['wasm', SEMANTIC_MODEL_DIRECTORY]) {
        const destination = path.join(resolvedOutput, directory);
        if (await pathExists(destination) && (!(await lstat(destination)).isDirectory() || await realpath(destination) !== destination)) {
          throw new PiNavPackageError('analysis_output', 'asset output must be a real directory, not an alias');
        }
      }
      await verifyMaintenanceRuntime(staging, MAINTENANCE_OUTPUT_ARTIFACTS);
    }
    if (modelNames.length) {
      await mkdir(path.join(staging, SEMANTIC_MODEL_DIRECTORY));
      for (const name of modelNames) await copyFile(path.join(semanticModel, name), path.join(staging, SEMANTIC_MODEL_DIRECTORY, name));
    }
    checked = await verifyAnalysisRuntime(staging, crateVersion, ANALYSIS_OUTPUT_ARTIFACTS);
    // Each artifact lands by same-directory rename so a consumer never observes a
    // truncated inode; staged leftovers are removed on any failure.
    const artifactNames = [...Object.values(ANALYSIS_OUTPUT_ARTIFACTS), ...maintenanceFiles, ...grammarFiles,
      ...modelNames.map(name => path.join(SEMANTIC_MODEL_DIRECTORY, name))];
    if (grammarFiles.length) await mkdir(path.join(resolvedOutput, 'wasm'), { recursive: true });
    if (modelNames.length) await mkdir(path.join(resolvedOutput, SEMANTIC_MODEL_DIRECTORY), { recursive: true });
    for (const name of artifactNames) {
      if (kernelPreserved && name === ANALYSIS_OUTPUT_ARTIFACTS.kernel) continue;
      // Publish individual grammar files, never replace the runtime/wasm directory.
      await rename(path.join(staging, name), path.join(resolvedOutput, name));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if (!jsonOutput) console.log(`analysis build ok (kernel ${crateVersion}, ${resolvedOutput})`);
  return { command: 'analysis-build', outputDir: resolvedOutput, artifacts: ANALYSIS_OUTPUT_ARTIFACTS, kernel: checked,
    ...(maintenanceGrammars === undefined ? {} : { maintenanceArtifacts: MAINTENANCE_OUTPUT_ARTIFACTS,
      maintenance: { grammarDirectory: maintenanceGrammars, grammarFiles, kernelPreserved } }) };
}

function parseAnalysisBuildOptions(commandArgs) {
  let outputDir, maintenanceGrammars, semanticModel;
  for (let index = 0; index < commandArgs.length; index++) {
    const argument = commandArgs[index];
    if (argument === "--json") continue;
    if (argument === '--maintenance-grammars' || argument.startsWith('--maintenance-grammars=')) {
      if (maintenanceGrammars !== undefined) throw new PiNavPackageError('usage', 'analysis-build: --maintenance-grammars given more than once');
      const value = argument === '--maintenance-grammars' ? commandArgs[++index] : argument.slice('--maintenance-grammars='.length);
      if (!value || value.startsWith('--')) throw new PiNavPackageError('usage', 'analysis-build: --maintenance-grammars requires a directory path');
      maintenanceGrammars = value;
      continue;
    }
    if (argument === '--semantic-model' || argument.startsWith('--semantic-model=')) {
      if (semanticModel !== undefined) throw new PiNavPackageError('usage', 'analysis-build: --semantic-model given more than once');
      const value = argument === '--semantic-model' ? commandArgs[++index] : argument.slice('--semantic-model='.length);
      if (!value || value.startsWith('--')) throw new PiNavPackageError('usage', 'analysis-build: --semantic-model requires a directory path');
      semanticModel = value;
      continue;
    }
    if (argument === "--output-dir" || argument.startsWith("--output-dir=")) {
      if (outputDir !== undefined) throw new PiNavPackageError("usage", "analysis-build: --output-dir given more than once");
      const value = argument === "--output-dir" ? commandArgs[++index] : argument.slice("--output-dir=".length);
      if (!value || value.startsWith("--")) throw new PiNavPackageError("usage", "analysis-build: --output-dir requires a directory path");
      outputDir = value;
      continue;
    }
    throw new PiNavPackageError("usage", `analysis-build: unknown argument ${argument}`);
  }
  if (outputDir === undefined) {
    throw new PiNavPackageError('usage', 'usage: node scripts/pi-nav-build.mjs analysis-build --output-dir <directory> [--maintenance-grammars <canonical directory> --semantic-model <canonical directory>] [--json]');
  }
  return { outputDir, maintenanceGrammars, semanticModel };
}

async function bundleAnalysisEntry(outfile, entry = ANALYSIS_ENTRY) {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch (error) {
    throw new PiNavPackageError("analysis_esbuild", `esbuild is not resolvable from the extension; install its devDependencies first: ${error?.message ?? error}`);
  }
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    // Package deps must resolve to their module build: jsonc-parser's UMD build
    // bundles silently without the exports the retained code calls.
    mainFields: ["module", "main"],
    // Match Node's explicit dependency search path in isolated contributor builds.
    nodePaths: (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean),
    external: entry === ANALYSIS_ENTRY ? [] : ['better-sqlite3', 'web-tree-sitter'],
    outfile,
    write: true,
    logLevel: "silent",
  });
  if (result.errors.length) {
    const detail = result.errors.map((error) => error.text ?? String(error)).join("; ");
    throw new PiNavPackageError('analysis_bundle', `esbuild bundle of ${entry} failed: ${detail}`);
  }
}

async function verifyMaintenanceRuntime(outputDir, artifacts) {
  const { MAINTENANCE_REVISION } = await import(new URL('../native/analysis/identity.mjs', import.meta.url));
  for (const key of ['parseWorker', 'storeWorker']) {
    await capture(process.execPath, ['--check', path.join(outputDir, artifacts[key])], { cwd: outputDir, timeoutMs: 30_000 });
  }
  await capture(process.execPath, ['--input-type=commonjs', '--eval', `
    const maintenance = require(${JSON.stringify(path.join(outputDir, artifacts.entry))});
    if (maintenance.MAINTENANCE_REVISION !== ${JSON.stringify(MAINTENANCE_REVISION)}
      || typeof maintenance.assertSourceBoundary !== 'function'
      || typeof maintenance.maintainAdmittedProject !== 'function' || !maintenance.getKernel()) {
      throw new Error('maintenance entry or adjacent kernel is unavailable');
    }
  `], { cwd: outputDir, timeoutMs: 30_000 });
}

async function buildAnalysisKernel(stagedKernel) {
  let output;
  try {
    output = await capture("cargo", ["build", "--locked", "--manifest-path", ANALYSIS_KERNEL_MANIFEST, "--message-format=json"], { timeoutMs: 1_200_000 });
  } catch (error) {
    throw new PiNavPackageError("analysis_cargo", `cargo dev build of the analysis kernel failed: ${error?.message ?? error}`);
  }
  // Cargo reports the actual artifact even with a configured target/target-dir.
  // Guessing target/debug can otherwise select a stale artifact from another build.
  const artifacts = output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    .filter(message => message.reason === "compiler-artifact" && message.target.name === "codegraph_kernel")
    .flatMap(message => message.filenames).filter(file => /\.(dylib|so|dll)$/.test(file));
  if (artifacts.length !== 1) throw new PiNavPackageError("analysis_kernel_artifact", "Cargo did not report exactly one analysis shared library");
  await copyFile(artifacts[0], stagedKernel);
  if (process.platform === "darwin") await run("codesign", ["--sign", "-", "--force", stagedKernel]);
}

async function readAnalysisCrateVersion(manifestPath) {
  const manifest = await readFile(manifestPath, "utf8");
  const version = /^version\s*=\s*"([^"]+)"/m.exec(manifest)?.[1];
  if (!version) throw new PiNavPackageError("analysis_cargo", `analysis kernel manifest has no version: ${manifestPath}`);
  return version;
}

async function verifyAnalysisRuntime(outputDir, crateVersion, artifacts) {
  const corePath = path.join(outputDir, artifacts.core);
  const childSource = String.raw`
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    let core;
    try { core = require(${JSON.stringify(corePath)}); }
    catch (error) { throw new Error('[pi-nav:analysis_load] ' + (error?.message ?? error)); }
    const required = ${JSON.stringify(ANALYSIS_REQUIRED_EXPORTS)};
    const missing = required.filter(name => typeof core[name] !== 'function');
    if (missing.length) throw new Error('[pi-nav:analysis_exports] sealed core is missing exports: ' + missing.join(','));
    if (core.ANALYSIS_REVISION !== ${JSON.stringify(ANALYSIS_REVISION)} || core.KERNEL_VERSION !== ${JSON.stringify(KERNEL_VERSION)}) {
      throw new Error('[pi-nav:analysis_identity] sealed core interpretation does not match this package');
    }
    // Sealed loader contract: the adjacent kernel is the only source; getKernel()
    // returns null when the addon is absent or fails its own contract verification.
    const kernel = core.getKernel();
    if (!kernel) throw new Error('[pi-nav:analysis_kernel] sealed loader could not load the adjacent kernel');
    const info = kernel.contractInfo();
    if (!info || info.kernelVersion !== ${JSON.stringify(crateVersion)}) {
      throw new Error('[pi-nav:analysis_kernel_version] kernel version mismatch, expected ${JSON.stringify(crateVersion)}');
    }
    console.log(JSON.stringify({ kernelVersion: info.kernelVersion, languages: Array.isArray(info.languages) ? info.languages.length : 0 }));
  `;
  let output;
  try {
    output = await capture(process.execPath, ["--input-type=module", "--eval", childSource], { cwd: outputDir, timeoutMs: 30_000 });
  } catch (error) {
    const message = String(error?.message ?? error);
    const tagged = /\[pi-nav:([a-z_]+)\]\s*([^\n]*)/.exec(message);
    throw new PiNavPackageError(tagged?.[1] ?? "analysis_check", tagged?.[2] || message);
  }
  try {
    return JSON.parse(output.trim().split("\n").at(-1));
  } catch {
    throw new PiNavPackageError("analysis_check", "sealed analysis core returned malformed kernel info");
  }
}

async function normalizeDarwinInstallName(target, artifact) {
  if (target.platform !== "darwin") return;
  await run("install_name_tool", ["-id", `@rpath/${path.basename(artifact)}`, artifact]);
}

async function verifyNativeCompatibility(target, artifacts) {
  if (target.platform === "darwin") {
    for (const artifact of [artifacts.addon, artifacts.cli]) {
      const identity = await capture("file", [artifact]);
      const expectedArch = target.arch === "arm64" ? "arm64" : "x86_64";
      if (!identity.includes(expectedArch)) throw new PiNavPackageError("artifact_arch", `artifact architecture mismatch: ${artifact}`);
      const loads = await capture("otool", ["-L", artifact]);
      const linked = loads.split(/\r?\n/).slice(1).map(line => line.trim().split(" ")[0]).filter(Boolean);
      const dependencies = artifact === artifacts.addon ? linked.slice(1) : linked;
      const unsafe = dependencies.filter(name => name.startsWith("/") && !name.startsWith("/usr/lib/") && !name.startsWith("/System/Library/"));
      if (unsafe.length) throw new PiNavPackageError("artifact_dependency", `artifact has non-system absolute dependencies: ${unsafe.join(", ")}`);
      const commands = await capture("otool", ["-l", artifact]);
      const versions = [...commands.matchAll(/\bminos\s+(\d+)\.(\d+)(?:\.(\d+))?/g)].map(match => [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]);
      if (!versions.length || versions.some(version => version[0] > 11 || (version[0] === 11 && version[1] > 0))) {
        throw new PiNavPackageError("artifact_macos_floor", `artifact does not satisfy the macOS 11.0 deployment floor: ${artifact}`);
      }
      await run("codesign", ["--verify", "--strict", artifact]);
    }
    const dylibId = await capture("otool", ["-D", artifacts.addon]);
    const id = dylibId.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(1);
    if (!id?.startsWith("@rpath/")) throw new PiNavPackageError("artifact_install_name", `addon install name is not relocatable: ${id ?? "missing"}`);
    return;
  }
  if (target.platform === "linux") {
    const expectedMachine = target.arch === "arm64" ? /AArch64/ : /X86-64|Advanced Micro Devices X86-64/;
    for (const artifact of [artifacts.addon, artifacts.cli]) {
      const header = await capture("readelf", ["-h", artifact]);
      if (!expectedMachine.test(header)) throw new PiNavPackageError("artifact_arch", `artifact architecture mismatch: ${artifact}`);
      const dynamic = await capture("readelf", ["-d", artifact]);
      const runtimePaths = [...dynamic.matchAll(/\((?:RPATH|RUNPATH)\).*\[([^\]]*)\]/g)].flatMap(match => match[1].split(":"));
      const unsafePath = runtimePaths.find(value => value.startsWith("/"));
      if (unsafePath) throw new PiNavPackageError("artifact_dependency", `artifact contains an absolute runtime search path (${unsafePath}): ${artifact}`);
      const versions = await capture("readelf", ["--version-info", artifact]);
      const glibc = [...versions.matchAll(/GLIBC_(\d+)\.(\d+)/g)].map(match => [Number(match[1]), Number(match[2])]);
      if (glibc.some(([major, minor]) => major > 2 || (major === 2 && minor > 28))) {
        throw new PiNavPackageError("artifact_glibc_floor", `artifact requires glibc newer than 2.28: ${artifact}`);
      }
    }
  }
}

async function signDarwinDevelopmentArtifact(target, artifact) {
  if (target.platform !== "darwin") return;
  await run("codesign", ["--sign", "-", "--force", artifact]);
}

async function check(root) {
  const target = resolvePiNavTarget();
  const artifacts = piNavArtifactPaths(root, target);
  await assertRegularFile(artifacts.addon, "missing_addon");
  await assertRegularFile(artifacts.cli, "missing_cli");
  await verifyNativeCompatibility(target, artifacts);
  const manifestPath = path.join(root, MANIFEST_NAME);
  const manifest = await readJsonIfExists(manifestPath);
  if (manifest) await verifyReleaseManifest(root, manifest, target, artifacts);

  const addonInfo = await inspectAddonAndSmoke(root, artifacts, target);
  if (manifest) verifyManifestRuntime(manifest, addonInfo, target);
  const version = await capture(artifacts.cli, ["--version"], { cwd: root });
  if (!version.trim().startsWith(`pi-nav ${PACKAGE_VERSION}`)) {
    throw new PiNavPackageError("cli_identity", `unexpected CLI identity: ${version.trim()}`);
  }
  if (!jsonOutput) console.log(`pi-nav check ok (${target.releaseKey}, ${target.rustTarget})`);
  return {
    command: "check",
    target: target.releaseKey,
    rustTarget: target.rustTarget,
    packageVersion: addonInfo.packageVersion,
    manifest: Boolean(manifest),
    smoke: true,
  };
}

/** Default-install contract: check shipped assets, never fetch, build or repair. */
export async function checkCore(root = extensionRoot) {
  await assertCorePackageInputs(root);
  const native = await check(root);
  const runtime = path.join(root, "native/analysis/runtime");
  await verifyMaintenanceRuntime(runtime, MAINTENANCE_OUTPUT_ARTIFACTS);
  await verifyAnalysisRuntime(runtime, KERNEL_VERSION, ANALYSIS_OUTPUT_ARTIFACTS);
  // Native encoding owns the exact model hashes and dimensions. A file-presence
  // check alone could bless unrelated weights or a structural-only package.
  const loader = pathToFileURL(path.join(root, "src/core/pi-nav-native.ts")).href;
  await capture(process.execPath, ["--input-type=module", "--eval", `
    import { callPiNav } from ${JSON.stringify(loader)};
    const result = await callPiNav({ root: ${JSON.stringify(root)}, operation: 'pi_nav_semantic_encode',
      args: { modelDirectory: ${JSON.stringify(path.join(runtime, SEMANTIC_MODEL_DIRECTORY))}, texts: ['code navigation'] }, timeoutMs: 30000 });
    const data = result.structured.data;
    if (data.dimensions !== 256 || data.vectors?.length !== 1 || data.vectors[0].length !== 256)
      throw new Error('Pinned code semantic model did not produce the required vector');
  `], { cwd: root, timeoutMs: 30_000 });
  return { ...native, command: "check-core", maintenance: true, codeSemantics: true };
}

export async function assertCorePackageInputs(root) {
  for (const relative of [...CORE_RUNTIME_FILES, ...CODE_MODEL_FILES]) {
    await assertRegularFile(path.join(root, relative), "missing_core_asset");
    if ((await stat(path.join(root, relative))).size === 0) throw new PiNavPackageError("empty_core_asset", `Empty Core asset: ${relative}`);
  }
  const grammars = path.join(root, "native/analysis/runtime/wasm");
  const info = await lstat(grammars).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()
      || !(await readdir(grammars)).some(name => /^tree-sitter-[\w-]+\.wasm$/.test(name))) {
    throw new PiNavPackageError("missing_core_grammars", "Packaged maintenance grammars are missing; prepare the release assets before installation");
  }
}

export async function inspectAddonAndSmoke(root, artifacts, target) {
  const loaderUrl = pathToFileURL(path.join(root, "src", "core", "pi-nav-native.ts")).href;
  const childSource = String.raw`
    import { createRequire } from 'node:module';
    import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { registerGrepTool } from ${JSON.stringify(pathToFileURL(path.join(root, 'src/tools/grep.ts')).href)};
    import { callPiNav } from ${JSON.stringify(loaderUrl)};
    import { enumerateNavigationCorpus } from ${JSON.stringify(pathToFileURL(path.join(root, 'src/core/navigation-corpus-policy.ts')).href)};
    const require = createRequire(import.meta.url);
    let addon;
    try { addon = require(process.env.PI_NAV_CHECK_ADDON); }
    catch (error) { throw new Error('[pi-nav:corrupt_addon] ' + (error?.message ?? error)); }
    const info = addon.getBuildInfo();
    if (info.packageVersion !== ${JSON.stringify(PACKAGE_VERSION)}) throw new Error('[pi-nav:package_mismatch] package version mismatch');
    if (info.target !== process.env.PI_NAV_CHECK_TARGET) throw new Error('[pi-nav:target_mismatch] target mismatch');
    if (info.addonApiVersion !== 2 || info.resultSchemaVersion !== 1) throw new Error('[pi-nav:schema_mismatch] schema mismatch');
    const required = ${JSON.stringify(REQUIRED_CAPABILITIES)};
    const missing = required.filter(value => !info.capabilities.includes(value));
    if (missing.length) throw new Error('[pi-nav:missing_capability] ' + missing.join(','));
    if (info.capabilities.includes('pi_nav_write')) throw new Error('[pi-nav:write_capability] write capability exposed');
    if ('piNavWrite' in addon || 'write' in addon) throw new Error('[pi-nav:write_export] write export exposed');
    const request = {
      root: process.env.PI_NAV_CHECK_ROOT,
      operation: 'pi_nav_files',
      args: { patterns: ['package.json'], type: 'file', sort: 'path', budget: 2000 },
      timeoutMs: 10_000,
    };
    const session = new addon.PiNavSession(request.root);
    const output = await session.call(request.operation, request.args, request.timeoutMs);
    if (output.structured.operation !== 'pi_nav_files') throw new Error('[pi-nav:smoke_operation] smoke operation mismatch');
    const ownership = await session.call('pi_nav_grep_cursor_owner', { cursor: 'unknown' }, 10_000);
    if (ownership.structured.data.ownsCursor !== false) throw new Error('[pi-nav:smoke_cursor] empty session claimed a cursor');
    let rejected = false;
    try { await session.call('pi_nav_write', {}, 10_000); }
    catch (error) { rejected = String(error).includes('unknown_operation'); }
    if (!rejected) throw new Error('[pi-nav:write_dispatch] write dispatch was not rejected');
    if (process.env.PI_NAV_CHECK_PACKAGED === '1') {
      const wrapped = await callPiNav(request);
      if (wrapped.structured.operation !== request.operation) throw new Error('[pi-nav:smoke_operation] packaged loader operation mismatch');
      rejected = false;
      try { await callPiNav({ root: request.root, operation: 'pi_nav_write', args: {} }); }
      catch (error) { rejected = String(error).includes('unknown_operation'); }
      if (!rejected) throw new Error('[pi-nav:write_dispatch] packaged loader write dispatch was not rejected');
    }
    // Exercise the public Matches bridge, not merely a file-listing operation.
    // Staged builds use their checked addon only inside this disposable child.
    let stagedCalls = 0;
    if (process.env.PI_NAV_CHECK_PACKAGED !== '1') {
      const countedAddon = { getBuildInfo: () => addon.getBuildInfo(), PiNavSession: class {
        constructor(...args) { this.session = new addon.PiNavSession(...args); }
        call(...args) { stagedCalls++; return this.session.call(...args); }
      } };
      globalThis[Symbol.for('jeito-codeweave-pi.pi-nav-native.v1:' + realpathSync(process.env.PI_NAV_CHECK_ROOT))] = {
        roots: new Map(), loadPromise: Promise.resolve({ addon: countedAddon, target: ${JSON.stringify(target)} }),
      };
    }
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'pi-nav-matches-smoke-')));
    try {
      const file = join(fixture, 'sample.ts');
      writeFileSync(file, 'export const PI_NAV_MATCHES_SMOKE = 1;\n');
      mkdirSync(join(fixture, '.git'));
      mkdirSync(join(fixture, 'child', '.git'), { recursive: true });
      writeFileSync(join(fixture, 'child', 'private.ts'), 'export const PI_NAV_MATCHES_SMOKE = "PRIVATE_CHILD_SENTINEL";\n');
      let grep;
      registerGrepTool({ registerTool(tool) { grep = tool; } });
      const request = { pattern: 'PI_NAV_MATCHES_SMOKE', paths: fixture, syntax: 'literal', output: 'matches' };
      const invoke = args => grep.execute('native-package-smoke', args, undefined, undefined, { cwd: fixture });
      const matches = await invoke(request);
      if (matches.details?.envelope?.status === 'error' || !Array.isArray(matches.content) || !matches.content.some(part => part.text?.includes('export const PI_NAV_MATCHES_SMOKE = 1;')))
        throw new Error('[pi-nav:smoke_matches] admitted Matches failed: ' + JSON.stringify(matches.content));
      if (matches.content.some(part => part.text?.includes('PRIVATE_CHILD_SENTINEL')))
        throw new Error('[pi-nav:smoke_matches] independent child source escaped admission');
      const corpus = await enumerateNavigationCorpus(fixture, 'code', callPiNav, { timeoutMs: 10_000, metadataOnly: true });
      if (!corpus.files.includes('sample.ts') || corpus.files.some(file => file.startsWith('child/')))
        throw new Error('[pi-nav:smoke_corpus] policy-aware census lost allowed source or admitted an independent child');
      if (process.env.PI_NAV_CHECK_PACKAGED !== '1' && stagedCalls === 0)
        throw new Error('[pi-nav:smoke_matches] staged addon was not exercised by registered Matches');
      const ambiguous = await invoke({ ...request, query: 'different intent' });
      if (ambiguous.details?.envelope?.status !== 'error') throw new Error('[pi-nav:smoke_matches] conflicting query aliases were accepted');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
    console.log(JSON.stringify(info));
  `;
  let output;
  try {
    output = await capture(process.execPath, ["--input-type=module", "--eval", childSource], {
      cwd: root,
      env: {
        PI_NAV_CHECK_ADDON: artifacts.addon,
        PI_NAV_CHECK_TARGET: target.rustTarget,
        PI_NAV_CHECK_ROOT: root,
        PI_NAV_CHECK_PACKAGED: artifacts.addon === piNavArtifactPaths(root, target).addon ? "1" : "0",
      },
      timeoutMs: 90_000,
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    // Node echoes failing eval source before its Error line; extract the error,
    // not a [pi-nav:...] string literal from that source.
    const tagged = /(?:^|\n)(?:\w*Error:\s*)?\[pi-nav:([a-z_]+)\]\s*([^\n]*)/.exec(message);
    throw new PiNavPackageError(tagged?.[1] ?? (error?.code === "command_timeout" ? "command_timeout" : "addon_check"), tagged?.[2] || message);
  }
  try {
    return JSON.parse(output.trim().split("\n").at(-1));
  } catch {
    throw new PiNavPackageError("addon_check", "isolated addon check returned malformed build info");
  }
}

export function parsePackageOptions(args) {
  let coreRuntime;
  let development = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--json") continue;
    if (argument === "--development") { development = true; continue; }
    if (argument === "--core-runtime" || argument.startsWith("--core-runtime=")) {
      if (coreRuntime !== undefined) throw new PiNavPackageError("usage", "package: --core-runtime given more than once");
      const value = argument === "--core-runtime" ? args[++index] : argument.slice("--core-runtime=".length);
      if (!value || value.startsWith("--")) throw new PiNavPackageError("usage", "package: --core-runtime requires a directory path");
      coreRuntime = value;
      continue;
    }
    throw new PiNavPackageError("usage", `package: unknown argument ${argument}`);
  }
  return { development, coreRuntime };
}

async function packageRelease({ development, coreRuntime }) {
  const target = resolvePiNavTarget();
  const artifacts = piNavArtifactPaths(extensionRoot, target);
  await assertRegularFile(artifacts.addon, "missing_addon");
  await assertRegularFile(artifacts.cli, "missing_cli");
  // Publisher input is an already sealed analysis-build output, never an
  // install-time download or a deployment into this checkout's runtime.
  if (coreRuntime === undefined) await assertCorePackageInputs(extensionRoot);

  let signing;
  if (target.platform === "darwin" && !development) {
    const identity = String(process.env.PI_NAV_APPLE_SIGNING_IDENTITY ?? "").trim();
    const profile = String(process.env.PI_NAV_APPLE_NOTARY_PROFILE ?? "").trim();
    if (!identity || !profile) {
      throw new PiNavPackageError(
        "macos_credentials",
        "production macOS packaging requires PI_NAV_APPLE_SIGNING_IDENTITY and PI_NAV_APPLE_NOTARY_PROFILE keychain selectors; use --development only for non-release tests",
      );
    }
    signing = { identity, profile };
  }
  let notarization;

  await mkdir(path.join(extensionRoot, ".tmp"), { recursive: true });
  const tempParent = await mkdtemp(path.join(extensionRoot, ".tmp", "jeito-codeweave-pi-package-"));
  const stagedRoot = path.join(tempParent, "jeito-codeweave-pi");
  const mode = development ? "development" : "release";
  try {
    await mkdir(stagedRoot, { recursive: true });
    await copyPackageSources(stagedRoot, extensionRoot, coreRuntime);
    const stagedArtifacts = piNavArtifactPaths(stagedRoot, target);
    await mkdir(path.dirname(stagedArtifacts.addon), { recursive: true });
    await mkdir(path.dirname(stagedArtifacts.cli), { recursive: true });
    await copyFile(artifacts.addon, stagedArtifacts.addon);
    await copyFile(artifacts.cli, stagedArtifacts.cli);
    if (target.platform !== "win32") await chmod(stagedArtifacts.cli, 0o755);
    // Reject incomplete/wrong-target inputs before npm staging or signing.
    await checkCore(stagedRoot);
    const lockPath = path.join(stagedRoot, "package-lock.json");
    const lockBefore = await sha256File(lockPath);
    await capture("npm", ["ci", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stagedRoot, timeoutMs: 5 * 60_000 });
    // Runtime imports do not use npm command shims. npm creates .bin symlink
    // directories at every nested dependency level, so remove all of them before
    // enforcing the link-free archive contract.
    await removeNpmCommandShims(path.join(stagedRoot, "node_modules"));
    // npm ci --ignore-scripts skips the native build; copy the host-built binary from
    // either a standalone or workspace-hoisted dependency resolution.
    const betterSqliteBin = path.join(stagedRoot, "node_modules/better-sqlite3/build/Release/better_sqlite3.node");
    const installedBetterSqliteBin = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("better-sqlite3"))), "../build/Release/better_sqlite3.node");
    await mkdir(path.dirname(betterSqliteBin), { recursive: true });
    await copyFile(installedBetterSqliteBin, betterSqliteBin);
    const lockAfter = await sha256File(lockPath);
    if (lockAfter !== lockBefore) throw new PiNavPackageError("lock_mutated", "npm ci changed package-lock.json in staging");
    await assertProductionTree(stagedRoot);


    if (signing) notarization = await signAndNotarizeDarwin(stagedRoot, target, stagedArtifacts, signing);

    const addonInfo = await inspectAddonAndSmoke(stagedRoot, stagedArtifacts, target);
    const manifest = await createReleaseManifest(stagedRoot, target, addonInfo, mode, notarization);
    await writeFile(path.join(stagedRoot, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await checkCore(stagedRoot);

    const dist = path.join(extensionRoot, "dist");
    await mkdir(dist, { recursive: true });
    const suffix = development ? "-development" : "";
    const baseName = `jeito-codeweave-pi-${PACKAGE_VERSION}-${target.releaseKey}${suffix}.tar.gz`;
    const finalArchive = path.join(dist, baseName);
    const finalSidecar = `${finalArchive}.sha256`;
    const tempArchive = path.join(dist, `.${baseName}.${process.pid}.tmp`);
    const tempSidecar = `${tempArchive}.sha256`;
    try {
      await run("tar", ["--no-xattrs", "-czf", tempArchive, "-C", tempParent, "jeito-codeweave-pi"], {
        env: { COPYFILE_DISABLE: "1" },
      });
      await verifyArchiveTable(tempArchive, manifest);
      const digest = await sha256File(tempArchive);
      await writeFile(tempSidecar, `${digest}  ${baseName}\n`, "utf8");
      await rm(finalArchive, { force: true });
      await rm(finalSidecar, { force: true });
      await rename(tempArchive, finalArchive);
      await rename(tempSidecar, finalSidecar);
    } finally {
      await rm(tempArchive, { force: true });
      await rm(tempSidecar, { force: true });
    }
    const result = {
      command: "package",
      mode,
      target: target.releaseKey,
      archive: finalArchive,
      sidecar: finalSidecar,
      manifestFiles: manifest.files.length,
      notarization: notarization?.status,
    };
    if (!jsonOutput) console.log(`pi-nav package ok (${mode}, ${target.releaseKey}): ${finalArchive}`);
    return result;
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
}


async function signAndNotarizeDarwin(root, target, artifacts, { identity, profile }) {
  const signatures = [];
  const kernel = path.join(root, 'native/analysis/runtime', ANALYSIS_OUTPUT_ARTIFACTS.kernel);
  for (const artifact of [artifacts.addon, artifacts.cli, kernel]) {
    await run("codesign", ["--force", "--sign", identity, "--options", "runtime", "--timestamp", artifact]);
    await run("codesign", ["--verify", "--strict", "--verbose=2", artifact]);
    signatures.push(await inspectDarwinDistributionSignature(artifact));
  }
  if (new Set(signatures.map(signature => signature.teamIdentifier)).size !== 1) throw new PiNavPackageError("macos_signature", "Core native artifacts use different Developer ID teams");
  // The signed bytes must load before they are submitted and before manifest hashing.
  await checkCore(root);
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-nav-notary-"));
  try {
    const payload = path.join(temp, "pi-nav-notary");
    await mkdir(path.join(payload, "native"), { recursive: true });
    await mkdir(path.join(payload, "bin"), { recursive: true });
    await copyFile(artifacts.addon, path.join(payload, "native", path.basename(artifacts.addon)));
    await copyFile(artifacts.cli, path.join(payload, "bin", path.basename(artifacts.cli)));
    await copyFile(kernel, path.join(payload, "native", path.basename(kernel)));
    const zip = path.join(temp, `pi-nav-${target.releaseKey}.zip`);
    await run("ditto", ["-c", "-k", "--keepParent", payload, zip]);
    const text = await capture("xcrun", ["notarytool", "submit", zip, "--keychain-profile", profile, "--wait", "--output-format", "json"], { timeoutMs: 30 * 60_000 });
    let response;
    try { response = JSON.parse(text); }
    catch { throw new PiNavPackageError("notary_response", "notarytool returned malformed JSON"); }
    if (String(response.status).toLowerCase() !== "accepted") {
      throw new PiNavPackageError("notary_rejected", `notary submission was not accepted: ${response.status ?? "unknown"}`, { id: response.id });
    }
    return { status: "Accepted", id: response.id, signingAuthority: signatures[0].authority, teamIdentifier: signatures[0].teamIdentifier, hardenedRuntime: true, secureTimestamp: true };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function inspectDarwinDistributionSignature(artifact) {
  const text = await capture("codesign", ["-d", "--verbose=4", artifact], { combined: true });
  const authority = /^Authority=(.+)$/m.exec(text)?.[1]?.trim();
  const teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim();
  const runtime = /flags=.*\bruntime\b/.test(text);
  const timestamp = /^(?:Timestamp|Signed Time)=/m.test(text);
  if (!authority?.startsWith("Developer ID Application:") || !teamIdentifier || teamIdentifier === "not set" || !runtime || !timestamp) {
    throw new PiNavPackageError("macos_signature", `artifact lacks Developer ID Application authority, team, hardened runtime, or secure timestamp: ${artifact}`);
  }
  return { authority, teamIdentifier };
}

export async function copyPackageSources(stagedRoot, sourceRoot = extensionRoot, coreRuntime) {
  if (coreRuntime !== undefined && (!path.isAbsolute(coreRuntime)
      || await realpath(coreRuntime) !== coreRuntime || !(await lstat(coreRuntime)).isDirectory())) {
    throw new PiNavPackageError("core_runtime", "--core-runtime requires a canonical existing directory from analysis-build");
  }
  for (const relative of [...SOURCE_FILES, ...CANONICAL_DOCS, ...NATIVE_FILES, ...SOURCE_DIRECTORIES, ...NATIVE_DIRECTORIES]) {
    const override = coreRuntime !== undefined && relative.startsWith("native/analysis/runtime/")
      ? path.join(coreRuntime, relative.slice("native/analysis/runtime/".length)) : undefined;
    await copyRelative(relative, stagedRoot, sourceRoot, override);
  }
  await assertCorePackageInputs(stagedRoot);
}

async function copyRelative(relative, stagedRoot, sourceRoot, sourceOverride) {
  const source = sourceOverride ?? path.join(sourceRoot, relative);
  const destination = path.join(stagedRoot, relative);
  const info = await lstat(source).catch(() => undefined);
  if (!info) throw new PiNavPackageError("allowlist_missing", `required package source is missing: ${relative}`);
  if (info.isSymbolicLink()) throw new PiNavPackageError("source_link", `package source may not be a symlink: ${relative}`);
  if (sourceOverride !== undefined && await realpath(source) !== source) {
    throw new PiNavPackageError("source_link", `publisher Core asset may not traverse a symlink: ${relative}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  if (info.isDirectory()) await copySourceDirectory(source, destination, relative);
  else if (info.isFile()) await copyFile(source, destination);
  else throw new PiNavPackageError("source_type", `unsupported package source type: ${relative}`);
}

async function copySourceDirectory(source, destination, relativeRoot) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relative = posixPath(path.join(relativeRoot, entry.name));
    if (relativeRoot === "native/analysis/runtime/wasm" && (!entry.isFile() || !/^tree-sitter-[\w-]+\.wasm$/.test(entry.name))) {
      throw new PiNavPackageError("allowlist_path", `Core grammar payload contains an undeclared file: ${relative}`);
    }
    if (EXCLUDED_SOURCE_PATHS.has(relative) || entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new PiNavPackageError("source_link", `package source may not contain a symlink: ${relative}`);
    if (entry.isDirectory()) await copySourceDirectory(from, to, relative);
    else if (entry.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
      const info = await stat(from);
      await chmod(to, info.mode & 0o777);
    } else throw new PiNavPackageError("source_type", `unsupported package source type: ${relative}`);
  }
}

async function assertProductionTree(stagedRoot) {
  for (const forbidden of [
    "node_modules/@napi-rs/cli",
    "node_modules/@earendil-works/pi-coding-agent",
  ]) {
    if (await pathExists(path.join(stagedRoot, forbidden))) throw new PiNavPackageError("dependency_omission", `forbidden staged dependency present: ${forbidden}`);
  }
  const packageJson = JSON.parse(await readFile(path.join(stagedRoot, "package.json"), "utf8"));
  const imports = Object.keys(packageJson.dependencies ?? {});
  const importSource = `for (const name of ${JSON.stringify(imports)}) await import(name); console.log('production imports ok');`;
  await capture(process.execPath, ["--input-type=module", "--eval", importSource], { cwd: stagedRoot, timeoutMs: 30_000 });
  await walkRegularFiles(stagedRoot, { rejectLinks: true });
}

async function createReleaseManifest(stagedRoot, target, addonInfo, mode, notarization) {
  const files = await inventoryFiles(stagedRoot, target);
  const sourceRevision = (await captureOptional("git", ["rev-parse", "HEAD"], { cwd: extensionRoot }))?.trim() || null;
  const npmVersion = (await captureOptional("npm", ["--version"], { cwd: extensionRoot }))?.trim() || null;
  const rustcVersion = (await captureOptional("rustc", ["--version"], { cwd: extensionRoot }))?.trim() || null;
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    releaseMode: mode,
    packageVersion: PACKAGE_VERSION,
    sourceRevision,
    releaseKey: target.releaseKey,
    rustTarget: target.rustTarget,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    npmVersion,
    rustcVersion,
    addonApiVersion: addonInfo.addonApiVersion,
    resultSchemaVersion: addonInfo.resultSchemaVersion,
    capabilities: [...addonInfo.capabilities].sort(),
    packageLockSha256: await sha256File(path.join(stagedRoot, "package-lock.json")),
    ...(notarization ? { notarization } : {}),
    files,
  };
}

async function inventoryFiles(root, target) {
  const rows = await walkRegularFiles(root, { rejectLinks: true });
  const files = [];
  for (const row of rows) {
    const relative = posixRelative(root, row.path);
    if (relative === MANIFEST_NAME) continue;
    assertAllowedPackagePath(relative, target);
    const executable = Boolean(row.mode & 0o111);
    if (executable && !relative.startsWith("node_modules/") && !isAllowedExecutable(relative, target)) {
      throw new PiNavPackageError("unexpected_executable", `unexpected executable package file: ${relative}`);
    }
    files.push({
      path: relative,
      size: row.size,
      executable,
      sha256: await sha256File(row.path),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function isAllowedExecutable(relative, target) {
  const artifacts = piNavArtifactPaths("", target);
  // The shared library can carry executable mode on the publisher's platform.
  return relative === posixPath(artifacts.addon) || relative === posixPath(artifacts.cli)
    || relative === `native/analysis/runtime/${ANALYSIS_OUTPUT_ARTIFACTS.kernel}` || ALLOWED_EXECUTABLE_SOURCE_FILES.has(relative);
}

export function assertAllowedPackagePath(relative, target) {
  if (!relative || relative.startsWith("/") || relative.split("/").includes("..")) throw new PiNavPackageError("manifest_path", `unsafe package path: ${relative}`);
  const artifacts = piNavArtifactPaths("", target);
  const exact = new Set([
    ...SOURCE_FILES,
    ...CANONICAL_DOCS,
    ...NATIVE_FILES,
    posixPath(artifacts.addon),
    posixPath(artifacts.cli),
  ]);
  if (exact.has(relative)) return;
  if (relative.startsWith("native/analysis/runtime/wasm/") && !/^native\/analysis\/runtime\/wasm\/tree-sitter-[\w-]+\.wasm$/.test(relative)) {
    throw new PiNavPackageError("allowlist_path", `Core grammar path is outside the release allowlist: ${relative}`);
  }
  const prefixes = [...SOURCE_DIRECTORIES, ...NATIVE_DIRECTORIES, "node_modules"].map((value) => `${value}/`);
  if (prefixes.some((prefix) => relative.startsWith(prefix))) return;
  throw new PiNavPackageError("allowlist_path", `package path is outside the release allowlist: ${relative}`);
}

async function verifyReleaseManifest(root, manifest, target, artifacts) {
  if (!manifest || manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) throw new PiNavPackageError("manifest_schema", "missing or incompatible release manifest schema");
  if (manifest.packageVersion !== PACKAGE_VERSION) throw new PiNavPackageError("manifest_package", "release manifest package version mismatch");
  if (manifest.releaseKey !== target.releaseKey || manifest.rustTarget !== target.rustTarget) throw new PiNavPackageError("manifest_target", "release manifest target mismatch");
  if (!["release", "development"].includes(manifest.releaseMode)) throw new PiNavPackageError("manifest_mode", "release manifest mode is invalid");
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new PiNavPackageError("manifest_files", "release manifest has no file inventory");
  const paths = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || paths.has(entry.path)) throw new PiNavPackageError("manifest_files", "release manifest contains an invalid or duplicate path");
    paths.add(entry.path);
    assertAllowedPackagePath(entry.path, target);
    const absolute = path.join(root, entry.path);
    const info = await lstat(absolute).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) throw new PiNavPackageError("manifest_missing", `manifest file missing or wrong type: ${entry.path}`);
    if (info.size !== entry.size) throw new PiNavPackageError("manifest_size", `manifest size mismatch: ${entry.path}`);
    if (Boolean(info.mode & 0o111) !== Boolean(entry.executable)) throw new PiNavPackageError("manifest_mode", `manifest executable-mode mismatch: ${entry.path}`);
    if (await sha256File(absolute) !== entry.sha256) throw new PiNavPackageError("manifest_checksum", `manifest checksum mismatch: ${entry.path}`);
  }
  const actual = await inventoryFiles(root, target);
  const expected = manifest.files.map((entry) => entry.path);
  const actualPaths = actual.map((entry) => entry.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expected)) throw new PiNavPackageError("manifest_inventory", "installed package inventory differs from release manifest");
  if (manifest.packageLockSha256 !== await sha256File(path.join(root, "package-lock.json"))) throw new PiNavPackageError("manifest_lock", "package-lock checksum differs from release manifest");
  if (!paths.has(posixRelative(root, artifacts.addon)) || !paths.has(posixRelative(root, artifacts.cli))) throw new PiNavPackageError("manifest_artifacts", "release manifest omits native artifacts");
}
function verifyManifestRuntime(manifest, addonInfo, target) {
  if (manifest.platform !== target.platform || manifest.arch !== target.arch) throw new PiNavPackageError("manifest_host", "release manifest host identity mismatch");
  if (manifest.addonApiVersion !== addonInfo.addonApiVersion) throw new PiNavPackageError("manifest_addon_major", "release manifest addon API major mismatch");
  if (manifest.resultSchemaVersion !== addonInfo.resultSchemaVersion) throw new PiNavPackageError("manifest_result_major", "release manifest result schema major mismatch");
  const manifestCapabilities = Array.isArray(manifest.capabilities) ? [...manifest.capabilities].sort() : [];
  const addonCapabilities = [...addonInfo.capabilities].sort();
  if (manifestCapabilities.includes("pi_nav_write")) throw new PiNavPackageError("manifest_write", "release manifest exposes forbidden write capability");
  if (JSON.stringify(manifestCapabilities) !== JSON.stringify(addonCapabilities)) throw new PiNavPackageError("manifest_capabilities", "release manifest capability inventory differs from the addon");
}


async function verifyArchiveTable(archive, manifest) {
  const output = await capture("tar", ["-tzf", archive], { timeoutMs: 30_000 });
  const entries = output.split(/\r?\n/).filter(Boolean);
  if (!entries.length || !entries.every((entry) => entry === "jeito-codeweave-pi/" || entry.startsWith("jeito-codeweave-pi/"))) {
    throw new PiNavPackageError("archive_root", "archive must contain exactly one jeito-codeweave-pi/ root");
  }
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/, "");
    if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) throw new PiNavPackageError("archive_path", `unsafe archive entry: ${entry}`);
  }
  const files = new Set(entries.filter((entry) => !entry.endsWith("/")));
  const expected = new Set([
    `jeito-codeweave-pi/${MANIFEST_NAME}`,
    ...manifest.files.map((entry) => `jeito-codeweave-pi/${entry.path}`),
  ]);
  if (files.size !== expected.size || [...expected].some((entry) => !files.has(entry))) {
    throw new PiNavPackageError("archive_inventory", "archive file table differs from release manifest");
  }
}

async function removeNpmCommandShims(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.name === ".bin") await rm(absolute, { recursive: true, force: true });
    else await removeNpmCommandShims(absolute);
  }
}

async function walkRegularFiles(root, { rejectLinks }) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (rejectLinks) throw new PiNavPackageError("package_link", `package tree contains a symlink: ${posixRelative(root, absolute)}`);
        continue;
      }
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const info = await stat(absolute);
        if (rejectLinks && info.nlink > 1) throw new PiNavPackageError("package_link", `package tree contains a hardlink: ${posixRelative(root, absolute)}`);
        files.push({ path: absolute, size: info.size, mode: info.mode });
      } else throw new PiNavPackageError("package_type", `package tree contains unsupported file type: ${posixRelative(root, absolute)}`);
    }
  }
  await visit(root);
  return files;
}

async function assertRegularFile(file, code) {
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new PiNavPackageError(code, `required regular file is missing: ${file}`);
}

async function readJsonIfExists(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new PiNavPackageError("manifest_json", `invalid JSON in ${file}`);
    throw error;
  }
}

async function pathExists(file) {
  return Boolean(await lstat(file).catch(() => undefined));
}

async function sha256File(file) {
  const data = await readFile(file);
  return createHash("sha256").update(data).digest("hex");
}

function posixRelative(root, file) {
  return posixPath(path.relative(root, file));
}

function posixPath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function normalizeFailure(error) {
  if (error instanceof PiNavPackageError) return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  return { code: "unexpected", message: String(error?.message ?? error) };
}

function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd ?? extensionRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: "inherit",
    });
    let timer;
    if (options.timeoutMs) timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new PiNavPackageError("command_failed", `${program} exited with ${code ?? signal}`));
    });
  });
}

function capture(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd ?? extensionRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    let timedOut = false;
    let timer;
    if (options.timeoutMs) timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(options.combined ? `${stdout}${stderr}` : stdout);
      else reject(new PiNavPackageError(timedOut ? "command_timeout" : "command_failed", `${program} exited with ${code ?? signal}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function captureOptional(program, args, options = {}) {
  try { return await capture(program, args, options); }
  catch { return undefined; }
}
