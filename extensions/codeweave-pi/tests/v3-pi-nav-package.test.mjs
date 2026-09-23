import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { inspectPiNavPackage } from "../scripts/navigation-doctor.mjs";
import { piNavArtifactPaths, resolvePiNavTarget, PI_NAV_GREP_CAPABILITIES } from "../src/core/pi-nav-native.ts";
import { assertAllowedPackagePath, assertCorePackageInputs, checkCore, copyPackageSources, inspectAddonAndSmoke, parsePackageOptions } from "../scripts/pi-nav-build.mjs";
import { ANALYSIS_OUTPUT_ARTIFACTS, MAINTENANCE_OUTPUT_ARTIFACTS, SEMANTIC_MODEL_DIRECTORY } from "../native/analysis/identity.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const buildScript = path.join(root, "scripts", "pi-nav-build.mjs");
const target = process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64"
  : process.platform === "darwin" && process.arch === "x64" ? "darwin-x64"
  : process.platform === "linux" && process.arch === "arm64" ? "linux-arm64"
  : process.platform === "linux" && process.arch === "x64" ? "linux-x64"
  : undefined;

function run(args, options = {}) {
  return spawnSync(process.execPath, [options.script ?? buildScript, ...args], {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function lastJson(text) {
  for (const line of String(text).trim().split(/\r?\n/).reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  return undefined;
}

test("package check refuses same-version missing Grep admission and preserves the actual error", async t => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "pi-nav-incompatible-package-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const info = { packageVersion: "0.9.0", addonApiVersion: 2, resultSchemaVersion: 1, target: resolvePiNavTarget().rustTarget,
    capabilities: ["pi_nav_search", "pi_nav_files", "pi_nav_ls", "pi_nav_read", "pi_nav_diff", "pi_nav_deps", "pi_nav_grok",
      "pi_nav_map", "pi_nav_overview", "pi_nav_savings", "pi_nav_session", "pi_nav_symbol_range", "source_proof_v1",
      ...PI_NAV_GREP_CAPABILITIES.filter(value => value !== "matches_corpus_v1")] };
  const addon = path.join(fixture, "old-addon.cjs");
  await writeFile(addon, `module.exports = { getBuildInfo: () => (${JSON.stringify(info)}), PiNavSession: class { constructor() { throw new Error('must not dispatch'); } } };`);
  await assert.rejects(inspectAddonAndSmoke(root, { addon, cli: "unused" }, resolvePiNavTarget()), error => {
    assert.equal(error.code, "missing_capability");
    assert.equal(error.message, "matches_corpus_v1", "do not report the echoed eval source instead of the actual failure");
    return true;
  });
});

test('ordinary query identity module is included in the native package source allowlist', async () => {
  const source = await readFile(buildScript, 'utf8');
  const nativeFiles = source.match(/const NATIVE_FILES = \[([\s\S]*?)\];/);
  assert.ok(nativeFiles, 'native source allowlist must be explicit');
  assert.match(nativeFiles[1], /["']native\/analysis\/identity\.mjs["']/);
  assert.ok((await readFile(path.join(root, 'native/analysis/identity.mjs'), 'utf8')).length);
  assert.match(nativeFiles[1], /["']native\/analysis\/README\.md["']/);
  assert.match(await readFile(path.join(root, 'native/analysis/README.md'), 'utf8'), /minishlab\/potion-code-16M-v2/);
});

test("Core package accepts every maintenance and code-model artifact, rejects incomplete inputs", async t => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "codeweave-pi-core-package-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const files = [...Object.values(ANALYSIS_OUTPUT_ARTIFACTS), ...Object.values(MAINTENANCE_OUTPUT_ARTIFACTS),
    ...["config.json", "tokenizer.json", "model.safetensors"].map(name => `${SEMANTIC_MODEL_DIRECTORY}/${name}`)];
  for (const name of [...files, "wasm/tree-sitter-typescript.wasm"]) {
    const relative = `native/analysis/runtime/${name}`;
    assert.doesNotThrow(() => assertAllowedPackagePath(relative, resolvePiNavTarget()));
    await mkdir(path.dirname(path.join(fixture, relative)), { recursive: true });
    await writeFile(path.join(fixture, relative), "fixture asset");
  }
  await assertCorePackageInputs(fixture); // Presence only; runtime verification is separate.
  for (const name of files) {
    const file = path.join(fixture, "native/analysis/runtime", name);
    await rm(file);
    await assert.rejects(assertCorePackageInputs(fixture), /missing|regular/i, name);
    await writeFile(file, "fixture asset");
  }
  await rm(path.join(fixture, "native/analysis/runtime/wasm"), { recursive: true });
  await assert.rejects(assertCorePackageInputs(fixture), /grammars are missing/);
  assert.throws(() => assertAllowedPackagePath("native/analysis/runtime/project.sqlite", resolvePiNavTarget()), /allowlist/);
});

test("retired code backend is not a package input or command", async () => {
  for (const relative of ["native/crg/LICENSE", "native/crg/code_review_graph/cli.py"]) {
    assert.throws(() => assertAllowedPackagePath(relative, resolvePiNavTarget()), /allowlist/);
  }
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(scripts["crg:check"], undefined);
  assert.equal(scripts["test:crg-lifecycle"], undefined);
});

test("Core is the default install gate; Python provisioning remains an explicit optional command", async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const name of ["postinstall", "nav:provision"]) {
    assert.match(scripts[name], /pi-nav-build\.mjs check-core.*&&.*qmd-model-provision\.mjs/);
    assert.doesNotMatch(scripts[name], /navigation-provision\.mjs|python|pip/);
  }
  assert.equal(scripts["nav:provision:legacy"], "node scripts/navigation-provision.mjs");
});

test("publisher Core input is explicit and unambiguous", () => {
  assert.deepEqual(parsePackageOptions(["--development", "--core-runtime", "/publisher/core", "--json"]), { development: true, coreRuntime: "/publisher/core" });
  assert.deepEqual(parsePackageOptions(["--core-runtime=/publisher/core"]), { development: false, coreRuntime: "/publisher/core" });
  for (const args of [["--core-runtime"], ["--core-runtime", "--json"], ["--core-runtime=/a", "--core-runtime=/b"], ["--unknown"]]) {
    assert.throws(() => parsePackageOptions(args), error => error.code === "usage");
  }
});

test("publisher Core input refuses relative and aliased directories before staging", async t => {
  const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), "codeweave-pi-core-input-")));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const stage = path.join(fixture, "stage");
  const assets = path.join(fixture, "assets");
  await mkdir(assets);
  const alias = path.join(fixture, "alias");
  await symlink(assets, alias);
  for (const input of ["relative", alias]) {
    await assert.rejects(copyPackageSources(stage, root, input), error => error.code === "core_runtime");
    await assert.rejects(lstat(stage), /ENOENT/);
  }
});

test("publisher supplied Core assets stage without deploying into the source checkout", { skip: !process.env.PI_NAV_TEST_CORE_RUNTIME }, async t => {
  const assets = process.env.PI_NAV_TEST_CORE_RUNTIME;
  // Match the publisher's staging location so offline checks reuse the checkout's
  // dependency ancestry, including workspace-hoisted modules; this is not installation.
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const fixture = await realpath(await mkdtemp(path.join(root, ".tmp", "codeweave-pi-core-staging-")));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const destination = path.join(fixture, "package");
  await copyPackageSources(destination, root, assets);
  const names = [...Object.values(ANALYSIS_OUTPUT_ARTIFACTS), ...Object.values(MAINTENANCE_OUTPUT_ARTIFACTS),
    ...["config.json", "tokenizer.json", "model.safetensors"].map(name => `${SEMANTIC_MODEL_DIRECTORY}/${name}`),
    ...(await readdir(path.join(assets, "wasm"))).map(name => `wasm/${name}`)];
  for (const name of new Set(names)) {
    assert.deepEqual(await readFile(path.join(destination, "native/analysis/runtime", name)), await readFile(path.join(assets, name)), name);
  }
  await assert.rejects(lstat(path.join(destination, "native/crg")), /ENOENT/);
  await assert.rejects(lstat(path.join(destination, "scripts/crg-adapter.py")), /ENOENT/);
  const installed = piNavArtifactPaths(root, resolvePiNavTarget());
  const staged = piNavArtifactPaths(destination, resolvePiNavTarget());
  await mkdir(path.dirname(staged.addon), { recursive: true });
  await copyFile(installed.addon, staged.addon);
  await mkdir(path.dirname(staged.cli), { recursive: true });
  await copyFile(installed.cli, staged.cli);
  assert.equal((await checkCore(destination)).codeSemantics, true);
  const core = path.join(destination, "native/analysis/runtime", ANALYSIS_OUTPUT_ARTIFACTS.core);
  const original = await readFile(core, "utf8");
  for (const [mutation, code] of [
    ['module.exports = {...module.exports, ANALYSIS_REVISION: "stale"};', "analysis_identity"],
    ['module.exports = {...module.exports, getKernel: () => ({ contractInfo: () => ({kernelVersion: "stale"}) })};', "analysis_kernel_version"],
    ['module.exports = {...module.exports, QueryBuilder: undefined};', "analysis_exports"],
  ]) {
    await writeFile(core, `${original}\n${mutation}\n`);
    await assert.rejects(checkCore(destination), error => error.code === code, code);
  }
  await writeFile(core, original);
  const model = path.join(destination, "native/analysis/runtime", SEMANTIC_MODEL_DIRECTORY);
  const movedModel = path.join(fixture, "model");
  await rename(model, movedModel);
  await symlink(movedModel, model, "dir");
  await assert.rejects(copyPackageSources(path.join(fixture, "aliased"), root, path.join(destination, "native/analysis/runtime")), error => error.code === "source_link");
  await rm(model);
  await rename(movedModel, model);
  await writeFile(path.join(destination, "native/analysis/runtime/wasm/private.log"), "must not ship");
  await assert.rejects(copyPackageSources(path.join(fixture, "unexpected"), root, path.join(destination, "native/analysis/runtime")), error => error.code === "allowlist_path");
});

async function extract(archive) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-nav-package-test-"));
  const child = spawnSync("tar", ["-xzf", archive, "-C", directory], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return { directory, packageRoot: path.join(directory, "jeito-codeweave-pi") };
}

async function rewriteManifest(packageRoot, mutate) {
  const manifestPath = path.join(packageRoot, "RELEASE-MANIFEST.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await mutate(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function refreshManifestFile(packageRoot, manifest, relative) {
  const absolute = path.join(packageRoot, relative);
  const info = await lstat(absolute);
  const entry = manifest.files.find((candidate) => candidate.path === relative);
  assert.ok(entry, `manifest entry missing: ${relative}`);
  entry.size = info.size;
  entry.executable = Boolean(info.mode & 0o111);
  entry.sha256 = createHash("sha256").update(await readFile(absolute)).digest("hex");
}

async function collectLinks(directory, rootPath = directory) {
  const links = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) links.push(path.relative(rootPath, absolute));
    else if (entry.isDirectory()) links.push(...await collectLinks(absolute, rootPath));
  }
  return links;
}

function toolText(result) {
  return result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

async function executeLoadedTool(session, project, name, args) {
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `packaged jeito-codeweave-pi ${name} was not loaded`);
  return await tool.execute(`package-native-${name}`, args, undefined, undefined, {
    cwd: project,
    mode: "print",
    hasUI: false,
    ui: { notify() {} },
  });
}

async function assertPiInstallRestart(piBin, archive, t) {
  const extracted = await extract(archive);
  t.after(() => rm(extracted.directory, { recursive: true, force: true }));
  const project = path.join(extracted.directory, "consumer-project");
  const isolatedHome = path.join(extracted.directory, "home");
  await mkdir(project, { recursive: true });
  await mkdir(isolatedHome, { recursive: true });
  await writeFile(path.join(project, ".pi-navigation.json"), JSON.stringify({ architecture: { enabled: false }, docs: { enabled: false }, graph: { enabled: false } }));
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "src", "alpha.ts"), "export function alpha() { return 1; }\n");
  await writeFile(path.join(project, "src", "beta.ts"), "import { alpha } from './alpha.ts';\nexport const beta = alpha();\n");
  await writeFile(path.join(project, "src", "large.ts"), Array.from({ length: 180 }, (_, index) => `export function item${index}() { return ${index}; }`).join("\n") + "\n");
  for (const args of [["init", "-q"], ["config", "user.email", "pi-nav@example.invalid"], ["config", "user.name", "pi-nav package test"], ["add", "."], ["commit", "-qm", "fixture"]]) {
    const git = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }
  await writeFile(path.join(project, "src", "alpha.ts"), "export function alpha() { return 2; }\n");
  const discoveredBin = path.isAbsolute(piBin) ? piBin : spawnSync("which", [piBin], { encoding: "utf8" }).stdout.trim();
  const minimalPath = [...new Set([path.dirname(discoveredBin), path.dirname(process.execPath), "/usr/bin", "/bin"])].join(path.delimiter);
  const env = { ...process.env, HOME: isolatedHome, PI_CODING_AGENT_DIR: path.join(isolatedHome, "agent"), PI_OFFLINE: "1", PATH: minimalPath };
  const manifestBeforeInstall = await readFile(path.join(extracted.packageRoot, "RELEASE-MANIFEST.json"), "utf8");
  const installed = spawnSync(discoveredBin, ["install", extracted.packageRoot, "-l", "--approve"], {
    cwd: project,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const settings = JSON.parse(await readFile(path.join(project, ".pi", "settings.json"), "utf8"));
  assert.equal(settings.packages.length, 1);
  assert.match(settings.packages[0], /jeito-codeweave-pi$/);
  assert.equal(await readFile(path.join(extracted.packageRoot, "RELEASE-MANIFEST.json"), "utf8"), manifestBeforeInstall);
  const cliPath = await realpath(discoveredBin);
  const piPackageRoot = path.dirname(path.dirname(cliPath));
  const { createAgentSession } = await import(pathToFileURL(path.join(piPackageRoot, "dist", "index.js")).href);
  const publicPiNavTools = ["ls", "find", "grep", "read", "trace", "diff", "docs_search"];
  const { session } = await createAgentSession({ cwd: project, agentDir: env.PI_CODING_AGENT_DIR, noTools: "builtin", tools: publicPiNavTools });
  try {
    for (const name of publicPiNavTools) {
      const loaded = session.getToolDefinition(name);
      const loadedInfo = session.getAllTools().find(tool => tool.name === name);
      assert.ok(loaded, `packaged jeito-codeweave-pi ${name} was not loaded`);
      assert.ok(loadedInfo?.sourceInfo?.path, `packaged ${name} source identity was not recorded`);
      assert.equal(path.resolve(loadedInfo.sourceInfo.path), path.join(extracted.packageRoot, "index.ts"));
    }
    const loadedLs = session.getToolDefinition("ls");
    assert.deepEqual(Object.keys(loadedLs.parameters.properties).sort(), ["budget", "depth", "glob", "path", "sort", "view", "visibility"]);
    assert.equal(Object.hasOwn(loadedLs.parameters.properties, "limit"), false);

    const lsResult = await executeLoadedTool(session, project, "ls", { path: "src", view: "list", visibility: "project", sort: "path" });
    assert.equal(lsResult.details?.native?.operation, "pi_nav_ls");
    assert.match(toolText(lsResult), /alpha\.ts/);

    const findResult = await executeLoadedTool(session, project, "find", { pattern: "alpha.ts", scope: ".", visibility: "project", sort: "path" });
    assert.equal(findResult.details?.native?.operation, "pi_nav_files");
    assert.match(toolText(findResult), /src\/alpha\.ts/);

      const grepResult = await executeLoadedTool(session, project, "grep", { pattern: "alpha", syntax: "symbol", paths: "src", visibility: "project" });
    assert.equal(grepResult.details?.native?.operation, "pi_nav_search");
    assert.match(toolText(grepResult), /src\/alpha\.ts/);

    const batchRead = await executeLoadedTool(session, project, "read", { paths: ["src/alpha.ts:1", "src/beta.ts:1-2"] });
    assert.equal(batchRead.details?.files?.length, 2);
    assert.match(toolText(batchRead), /src\/alpha\.ts/);
    assert.match(toolText(batchRead), /src\/beta\.ts/);

    const smartRead = await executeLoadedTool(session, project, "read", { path: "src/large.ts" });
    assert.doesNotMatch(toolText(smartRead), /summary · no edit hash/);
    assert.match(toolText(smartRead), /item0|item1/);

    const traceResult = await executeLoadedTool(session, project, "trace", { target: "src/alpha.ts", relation: "importers", scope: ".", limit: 4 });
    assert.equal(traceResult.details?.native?.operation, "pi_nav_deps");
    assert.match(toolText(traceResult), /beta\.ts/);

    const diffResult = await executeLoadedTool(session, project, "diff", { view: "structure", scope: "src/alpha.ts" });
    assert.equal(diffResult.details?.native?.operation, "pi_nav_diff");
    assert.match(toolText(diffResult), /alpha/);
  } finally {
    session.dispose();
  }
  const rpc = spawnSync(discoveredBin, ["--mode", "rpc", "--no-session", "--offline", "--approve"], {
    cwd: project,
    env,
    input: '{"id":"package-restart","type":"get_state"}\n',
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(rpc.status, 0, rpc.stderr || rpc.stdout);
  const messages = rpc.stdout.split(/\r?\n/).map(lastJson).filter(Boolean);
  assert.ok(messages.some(message => message.id === "package-restart" && message.success === true));
  assert.doesNotMatch(rpc.stderr, /(?:jeito-codeweave-pi|index\.ts).*(?:failed|error|cannot find|not found)/i);
}

test("production staging failure cannot sign or replace checkout native artifacts", {
  skip: process.platform !== "darwin" ? "Darwin signing boundary" : !process.env.PI_NAV_TEST_CORE_RUNTIME && "requires explicit sealed Core fixture",
}, async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "pi-nav-signing-boundary-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const bin = path.join(fixture, "bin");
  await mkdir(bin);
  const signingLog = path.join(fixture, "signing.log");
  await writeFile(path.join(bin, "codesign"), '#!/bin/sh\ncase "$1" in --verify|-d) exec /usr/bin/codesign "$@";; esac\nprintf "blocked signing\\n" >> "$PI_NAV_TEST_SIGN_LOG"\nexit 97\n', { mode: 0o755 });
  await writeFile(path.join(bin, "xcrun"), '#!/bin/sh\nprintf "blocked notary\\n" >> "$PI_NAV_TEST_SIGN_LOG"\nexit 97\n', { mode: 0o755 });
  await writeFile(path.join(bin, "npm"), '#!/bin/sh\necho "intentional staged dependency failure" >&2\nexit 37\n', { mode: 0o755 });
  const artifacts = piNavArtifactPaths(root, resolvePiNavTarget());
  const before = await Promise.all([readFile(artifacts.addon), readFile(artifacts.cli)]);
  const env = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    PI_NAV_TEST_SIGN_LOG: signingLog,
    PI_NAV_APPLE_SIGNING_IDENTITY: "test-only-unused-selector",
    PI_NAV_APPLE_NOTARY_PROFILE: "test-only-unused-selector",
  };
  const result = run(["package", "--core-runtime", process.env.PI_NAV_TEST_CORE_RUNTIME, "--json"], { env });
  assert.notEqual(result.status, 0);
  assert.match(lastJson(result.stderr)?.message ?? result.stderr, /intentional staged dependency failure/);
  await assert.rejects(readFile(signingLog), { code: "ENOENT" });
  assert.deepEqual(await readFile(artifacts.addon), before[0]);
  assert.deepEqual(await readFile(artifacts.cli), before[1]);
});

// Archive creation stages npm dependencies; later controls launch isolated Pi.
// Neither operation belongs to an unqualified source-test invocation.
test("P5 development package is self-contained, manifested, offline-checkable, and fail-closed", {
  skip: !target || (!process.env.PI_NAV_RELEASE_ARCHIVE && process.env.PI_NAV_TEST_PACKAGE !== "1" && "requires explicit package/install verification opt-in"),
}, async (t) => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["pi-nav:package"], "node scripts/pi-nav-build.mjs package");
  assert.deepEqual(packageJson.peerDependencies, { "@earendil-works/pi-coding-agent": ">=0.82.1" });
  assert.deepEqual(packageJson.peerDependenciesMeta, { "@earendil-works/pi-coding-agent": { optional: true } });

  const providedArchive = process.env.PI_NAV_RELEASE_ARCHIVE;
  let result;
  if (providedArchive) {
    result = { ok: true, mode: "development", target, archive: path.resolve(providedArchive), sidecar: `${path.resolve(providedArchive)}.sha256` };
  } else {
    const coreArgs = process.env.PI_NAV_TEST_CORE_RUNTIME ? ["--core-runtime", process.env.PI_NAV_TEST_CORE_RUNTIME] : [];
    const packageRun = run(["package", "--development", ...coreArgs, "--json"]);
    assert.equal(packageRun.status, 0, packageRun.stderr || packageRun.stdout);
    result = lastJson(packageRun.stdout);
  }
  assert.equal(result?.ok, true);
  assert.equal(result.mode, "development");
  assert.equal(result.target, target);

  const archive = result.archive;
  const sidecar = result.sidecar;
  if (!providedArchive) t.after(async () => {
    await rm(archive, { force: true });
    await rm(sidecar, { force: true });
  });

  await t.test("archive checksum, root, allowlist, manifest ordering, modes, and dependency omissions are exact", async () => {
    const bytes = await readFile(archive);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const sidecarText = await readFile(sidecar, "utf8");
    assert.equal(sidecarText, `${digest}  ${path.basename(archive)}\n`);

    const table = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(table.status, 0, table.stderr || `tar exited abnormally: ${String(table.error?.message ?? table.error ?? table.signal ?? "unknown")}`);
    const entries = table.stdout.trim().split(/\r?\n/);
    assert.ok(entries.every((entry) => entry === "jeito-codeweave-pi/" || entry.startsWith("jeito-codeweave-pi/")));
    assert.ok(!entries.some((entry) => entry.includes("../") || entry.startsWith("/")));
    assert.ok(!entries.some((entry) => /^(?:jeito-codeweave-pi\/)?(?:docs\/plan|tests|vendor)(?:\/|$)/.test(entry)));

    const extracted = await extract(archive);
    t.after(() => rm(extracted.directory, { recursive: true, force: true }));
    const manifest = JSON.parse(await readFile(path.join(extracted.packageRoot, "RELEASE-MANIFEST.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.releaseMode, "development");
    assert.equal(manifest.releaseKey, target);
    assert.deepEqual(manifest.files.map((entry) => entry.path), [...manifest.files.map((entry) => entry.path)].sort((a, b) => a.localeCompare(b)));
    assert.equal(new Set(manifest.files.map((entry) => entry.path)).size, manifest.files.length);
    assert.ok(manifest.files.some((entry) => entry.path.endsWith(`/pi-nav`) && entry.executable));
    assert.ok(manifest.files.some((entry) => entry.path.endsWith(`pi_nav.${target}.node`)));
    assert.ok(!manifest.files.some((entry) => entry.path.startsWith("docs/plan/") || entry.path.startsWith("tests/") || entry.path.startsWith("vendor/") || entry.path.startsWith("python/") || entry.path.startsWith(".runtime/") || entry.path.startsWith("src/graphify-out/")));
    for (const required of new Set([...Object.values(ANALYSIS_OUTPUT_ARTIFACTS), ...Object.values(MAINTENANCE_OUTPUT_ARTIFACTS),
      ...["config.json", "tokenizer.json", "model.safetensors"].map(name => `${SEMANTIC_MODEL_DIRECTORY}/${name}`)])) {
      assert.ok(manifest.files.some(entry => entry.path === `native/analysis/runtime/${required}`), `missing packaged Core asset: ${required}`);
    }
    assert.ok(!manifest.files.some(entry => /^(?:native\/crg\/|scripts\/crg[-.]|src\/core\/crg[-.])/.test(entry.path)));
    assert.ok(!manifest.files.some(entry => entry.path.includes("/__pycache__/") || entry.path.endsWith(".pyc")));
    for (const required of ["native/qmd/LICENSE", "native/qmd/UPSTREAM.md", "native/qmd/runtime/index.js", "native/qmd/runtime/store.js", "native/qmd/runtime/zeroentropy.js"]) {
      assert.ok(manifest.files.some((entry) => entry.path === required), `missing packaged QMD runtime file: ${required}`);
    }
    assert.ok(!manifest.files.some((entry) => /^native\/qmd\/runtime\/(?:bench|cli|mcp)\//.test(entry.path)));
    assert.equal(await collectLinks(extracted.packageRoot).then((links) => links.length), 0);
    assert.equal(await lstat(path.join(extracted.packageRoot, "node_modules", "@napi-rs", "cli")).then(() => true, () => false), false);
    assert.equal(await lstat(path.join(extracted.packageRoot, "node_modules", "@earendil-works", "pi-coding-agent")).then(() => true, () => false), false);
  });

  await t.test("extracted package validates and smokes without install, source checkout, or network", async () => {
    const extracted = await extract(archive);
    t.after(() => rm(extracted.directory, { recursive: true, force: true }));
    const minimalPath = [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter);
    const checked = run(["check-core", "--json"], {
      script: path.join(extracted.packageRoot, "scripts", "pi-nav-build.mjs"),
      cwd: extracted.packageRoot,
      env: { ...process.env, PATH: minimalPath, npm_config_offline: "true" },
    });
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.deepEqual(lastJson(checked.stdout), {
      ok: true,
      command: "check-core",
      target,
      rustTarget: process.platform === "darwin" ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin") : (process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"),
      packageVersion: "0.9.0",
      manifest: true,
      smoke: true,
      maintenance: true,
      codeSemantics: true,
    });
  });

  await t.test("doctor reports package health and stopped-reinstall recovery for packaged failures", async () => {
    const healthy = await extract(archive);
    t.after(() => rm(healthy.directory, { recursive: true, force: true }));
    const healthyResult = inspectPiNavPackage(healthy.packageRoot);
    assert.equal(healthyResult.available, true);
    assert.equal(healthyResult.checked, true);
    assert.equal(healthyResult.check?.manifest, true);

    const missing = await extract(archive);
    t.after(() => rm(missing.directory, { recursive: true, force: true }));
    const manifest = JSON.parse(await readFile(path.join(missing.packageRoot, "RELEASE-MANIFEST.json"), "utf8"));
    const cliEntry = manifest.files.find((entry) => entry.path.endsWith("/pi-nav"));
    assert.ok(cliEntry);
    await rm(path.join(missing.packageRoot, cliEntry.path));
    const missingResult = inspectPiNavPackage(missing.packageRoot);
    assert.equal(missingResult.available, false);
    assert.equal(missingResult.checked, false);
    assert.match(missingResult.reason, /artifact missing/);
    assert.match(missingResult.reason, /while Pi is stopped/);
  });

  await t.test("Pi 0.82.1 executes every pi-nav-backed public tool and restarts the durable extracted package", { skip: spawnSync("pi", ["--version"], { encoding: "utf8" }).status !== 0 }, async () => {
    const version = spawnSync("pi", ["--version"], { encoding: "utf8" });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^0\.82\.1\s*$/);
    await assertPiInstallRestart("pi", archive, t);
  });


  await t.test("stopped upgrade and checksum-gated repair preserve old/failed directories and restart from the same durable path", { skip: spawnSync("pi", ["--version"], { encoding: "utf8" }).status !== 0 }, async () => {
    const oldCandidate = await extract(archive);
    const newCandidate = await extract(archive);
    const repairCandidate = await extract(archive);
    t.after(() => Promise.all([oldCandidate.directory, newCandidate.directory, repairCandidate.directory].map(directory => rm(directory, { recursive: true, force: true }))));
    await rewriteManifest(oldCandidate.packageRoot, async (manifest) => {
      const readme = path.join(oldCandidate.packageRoot, "README.md");
      await writeFile(readme, `${await readFile(readme, "utf8")}\nFixture prior release.\n`);
      await refreshManifestFile(oldCandidate.packageRoot, manifest, "README.md");
      manifest.sourceRevision = "fixture-prior-release";
    });
    const oldCheck = run(["check", "--json"], { script: path.join(oldCandidate.packageRoot, "scripts", "pi-nav-build.mjs"), cwd: oldCandidate.packageRoot });
    assert.equal(oldCheck.status, 0, oldCheck.stderr);

    const lifecycleRoot = await mkdtemp(path.join(os.tmpdir(), "pi-nav-lifecycle-"));
    t.after(() => rm(lifecycleRoot, { recursive: true, force: true }));
    const durable = path.join(lifecycleRoot, "jeito-codeweave-pi");
    const previous = path.join(lifecycleRoot, "jeito-codeweave-pi.previous");
    const failed = path.join(lifecycleRoot, "jeito-codeweave-pi.failed");
    const project = path.join(lifecycleRoot, "consumer");
    const home = path.join(lifecycleRoot, "home");
    await mkdir(project, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(path.join(project, ".pi-navigation.json"), JSON.stringify({ architecture: { enabled: false }, docs: { enabled: false }, graph: { enabled: false } }));
    await rename(oldCandidate.packageRoot, durable);
    const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent"), PI_OFFLINE: "1", PI_NAV_NO_AUTO_SETUP: "1" };
    const installed = spawnSync("pi", ["install", durable, "-l", "--approve"], { cwd: project, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(installed.status, 0, installed.stderr);
    const restart = () => spawnSync("pi", ["--mode", "rpc", "--no-session", "--offline", "--approve"], {
      cwd: project,
      env,
      input: '{"id":"lifecycle","type":"get_state"}\n',
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const priorRestart = restart();
    assert.equal(priorRestart.status, 0, `prior package did not load before stopped replacement\nstdout:\n${priorRestart.stdout}\nstderr:\n${priorRestart.stderr}\nsignal: ${priorRestart.signal}`);

    await rename(durable, previous);
    await rename(newCandidate.packageRoot, durable);
    const upgraded = run(["check", "--json"], { script: path.join(durable, "scripts", "pi-nav-build.mjs"), cwd: durable });
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.notEqual(JSON.parse(await readFile(path.join(durable, "RELEASE-MANIFEST.json"), "utf8")).sourceRevision, "fixture-prior-release");
    assert.equal(restart().status, 0, "upgraded package did not load after restart");
    assert.equal((await lstat(previous)).isDirectory(), true);

    const damagedReadme = path.join(durable, "README.md");
    await writeFile(damagedReadme, "corrupt\n");
    const damaged = run(["check", "--json"], { script: path.join(durable, "scripts", "pi-nav-build.mjs"), cwd: durable });
    assert.notEqual(damaged.status, 0);
    await rename(durable, failed);
    await rename(repairCandidate.packageRoot, durable);
    const repaired = run(["check", "--json"], { script: path.join(durable, "scripts", "pi-nav-build.mjs"), cwd: durable });
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(restart().status, 0, "repaired package did not load after restart");
    assert.equal((await lstat(failed)).isDirectory(), true);
  });
  await t.test("manifest detects byte tampering", async () => {
    const extracted = await extract(archive);
    t.after(() => rm(extracted.directory, { recursive: true, force: true }));
    const readme = path.join(extracted.packageRoot, "README.md");
    const bytes = await readFile(readme);
    bytes[0] ^= 1;
    await writeFile(readme, bytes);
    const checked = run(["check", "--json"], { script: path.join(extracted.packageRoot, "scripts", "pi-nav-build.mjs"), cwd: extracted.packageRoot });
    assert.notEqual(checked.status, 0);
    assert.equal(lastJson(checked.stderr)?.code, "manifest_checksum");
  });

  await t.test("manifest rejects unexpected package files", async () => {
    const extracted = await extract(archive);
    t.after(() => rm(extracted.directory, { recursive: true, force: true }));
    await writeFile(path.join(extracted.packageRoot, "unexpected.txt"), "not allowlisted\n");
    const checked = run(["check", "--json"], { script: path.join(extracted.packageRoot, "scripts", "pi-nav-build.mjs"), cwd: extracted.packageRoot });
    assert.notEqual(checked.status, 0);
    assert.equal(lastJson(checked.stderr)?.code, "allowlist_path");
  });

  await t.test("manifest/runtime identity failures have distinct machine-readable reasons", async () => {
    const cases = [
      ["manifest_addon_major", (manifest) => { manifest.addonApiVersion += 1; }],
      ["manifest_result_major", (manifest) => { manifest.resultSchemaVersion += 1; }],
      ["manifest_capabilities", (manifest) => { manifest.capabilities = manifest.capabilities.slice(1); }],
      ["manifest_write", (manifest) => { manifest.capabilities.push("pi_nav_write"); }],
      ["manifest_target", (manifest) => { manifest.releaseKey = "wrong-target"; }],
      ["manifest_package", (manifest) => { manifest.packageVersion = "9.9.9"; }],
      ["manifest_host", (manifest) => { manifest.arch = manifest.arch === "arm64" ? "x64" : "arm64"; }],
      ["manifest_path", (manifest) => { manifest.files[0].path = "../escape"; }],
      ["manifest_files", (manifest) => { manifest.files.push({ ...manifest.files[0] }); }],
    ];
    for (const [code, mutate] of cases) {
      const extracted = await extract(archive);
      try {
        await rewriteManifest(extracted.packageRoot, mutate);
        const checked = run(["check", "--json"], { script: path.join(extracted.packageRoot, "scripts", "pi-nav-build.mjs"), cwd: extracted.packageRoot });
        assert.notEqual(checked.status, 0, code);
        assert.equal(lastJson(checked.stderr)?.code, code);
      } finally {
        await rm(extracted.directory, { recursive: true, force: true });
      }
    }
  });

  await t.test("CLI identity mismatch is diagnosed after compatible artifact bytes pass manifest checks", async () => {
    const extracted = await extract(archive);
    t.after(() => rm(extracted.directory, { recursive: true, force: true }));
    const manifest = JSON.parse(await readFile(path.join(extracted.packageRoot, "RELEASE-MANIFEST.json"), "utf8"));
    const cliEntry = manifest.files.find((entry) => entry.path.endsWith("/pi-nav"));
    assert.ok(cliEntry);
    const cli = path.join(extracted.packageRoot, cliEntry.path);
    const bytes = await readFile(cli);
    const needle = Buffer.from("0.9.0");
    let offset = bytes.indexOf(needle);
    assert.ok(offset >= 0, "CLI version string was not found");
    while (offset >= 0) {
      Buffer.from("9.9.9").copy(bytes, offset);
      offset = bytes.indexOf(needle, offset + needle.length);
    }
    await writeFile(cli, bytes);
    if (process.platform === "darwin") {
      const signed = spawnSync("codesign", ["--sign", "-", "--force", cli], { encoding: "utf8" });
      assert.equal(signed.status, 0, signed.stderr);
    }
    await refreshManifestFile(extracted.packageRoot, manifest, cliEntry.path);
    await writeFile(path.join(extracted.packageRoot, "RELEASE-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const checked = run(["check", "--json"], { script: path.join(extracted.packageRoot, "scripts", "pi-nav-build.mjs"), cwd: extracted.packageRoot });
    assert.notEqual(checked.status, 0);
    assert.equal(lastJson(checked.stderr)?.code, "cli_identity");
  });

  await t.test("symlinks and failed staging are rejected and temporary staging is cleaned", async () => {
    const extracted = await extract(archive);
    t.after(() => rm(extracted.directory, { recursive: true, force: true }));
    await symlink("README.md", path.join(extracted.packageRoot, "linked-readme"));
    const linked = run(["check", "--json"], { script: path.join(extracted.packageRoot, "scripts", "pi-nav-build.mjs"), cwd: extracted.packageRoot });
    assert.notEqual(linked.status, 0);
    assert.equal(lastJson(linked.stderr)?.code, "package_link");
    await rm(path.join(extracted.packageRoot, "linked-readme"));
    await link(path.join(extracted.packageRoot, "README.md"), path.join(extracted.packageRoot, "hard-readme"));
    const hardlinked = run(["check", "--json"], { script: path.join(extracted.packageRoot, "scripts", "pi-nav-build.mjs"), cwd: extracted.packageRoot });
    assert.notEqual(hardlinked.status, 0);
    assert.equal(lastJson(hardlinked.stderr)?.code, "package_link");

    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), "pi-nav-npm-failure-"));
    t.after(() => rm(fakeRoot, { recursive: true, force: true }));
    const npm = path.join(fakeRoot, "npm");
    await writeFile(npm, "#!/bin/sh\nexit 19\n");
    await chmod(npm, 0o755);
    const failed = run(["package", "--development", "--json"], { env: { ...process.env, PATH: `${fakeRoot}${path.delimiter}${process.env.PATH}` } });
    assert.notEqual(failed.status, 0);
    const leftovers = (await readdir(path.join(root, ".tmp"))).filter(name => name.startsWith("jeito-codeweave-pi-package-"));
    assert.deepEqual(leftovers, []);
  });

  await t.test("production macOS rejects ad-hoc signature metadata even when selectors are supplied", { skip: process.platform !== "darwin" }, async () => {
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), "pi-nav-adhoc-fake-"));
    t.after(() => rm(fakeRoot, { recursive: true, force: true }));
    const codesign = path.join(fakeRoot, "codesign");
    const xcrun = path.join(fakeRoot, "xcrun");
    await writeFile(codesign, '#!/bin/sh\nif [ "$1" = "--verify" ] || [ "$1" = "-d" ]; then exec /usr/bin/codesign "$@"; fi\nfor last; do :; done\nexec /usr/bin/codesign --sign - --force "$last"\n');
    await writeFile(xcrun, "#!/bin/sh\nexit 99\n");
    await chmod(codesign, 0o755);
    await chmod(xcrun, 0o755);
    const rejected = run(["package", "--json"], { env: {
      ...process.env,
      PATH: `${fakeRoot}${path.delimiter}${process.env.PATH}`,
      PI_NAV_APPLE_SIGNING_IDENTITY: "test-only-identity",
      PI_NAV_APPLE_NOTARY_PROFILE: "test-only-profile",
    } });
    assert.notEqual(rejected.status, 0);
    assert.equal(lastJson(rejected.stderr)?.code, "macos_signature");
  });

  await t.test("a rejected macOS notarization response fails closed before archive publication", { skip: process.platform !== "darwin" }, async () => {
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), "pi-nav-notary-fake-"));
    t.after(() => rm(fakeRoot, { recursive: true, force: true }));
    const codesign = path.join(fakeRoot, "codesign");
    const xcrun = path.join(fakeRoot, "xcrun");
    await writeFile(codesign, '#!/bin/sh\nif [ "$1" = "--verify" ]; then exec /usr/bin/codesign "$@"; fi\nif [ "$1" = "-d" ]; then printf \'%s\\n\' \'Authority=Developer ID Application: Test (TESTTEAM123)\' \'TeamIdentifier=TESTTEAM123\' \'Timestamp=Jul 14, 2026 at 12:00:00\' \'CodeDirectory v=20500 size=1 flags=0x10000(runtime)\' >&2; exit 0; fi\nfor last; do :; done\nexec /usr/bin/codesign --sign - --force "$last"\n');
    await writeFile(xcrun, '#!/bin/sh\nprintf \'%s\\n\' \'{"id":"rejected-test","status":"Invalid"}\'\n');
    await chmod(codesign, 0o755);
    await chmod(xcrun, 0o755);
    const env = {
      ...process.env,
      PATH: `${fakeRoot}${path.delimiter}${process.env.PATH}`,
      PI_NAV_APPLE_SIGNING_IDENTITY: "test-only-identity",
      PI_NAV_APPLE_NOTARY_PROFILE: "test-only-profile",
    };
    const rejected = run(["package", "--json"], { env });
    assert.notEqual(rejected.status, 0);
    assert.equal(lastJson(rejected.stderr)?.code, "notary_rejected");
    const productionArchive = path.join(root, "dist", `jeito-codeweave-pi-0.9.0-${target}.tar.gz`);
    assert.equal(await lstat(productionArchive).then(() => true, () => false), false);
  });

  await t.test("production macOS packaging refuses missing keychain selectors rather than publishing ad-hoc bytes", { skip: process.platform !== "darwin" }, () => {
    const env = { ...process.env };
    delete env.PI_NAV_APPLE_SIGNING_IDENTITY;
    delete env.PI_NAV_APPLE_NOTARY_PROFILE;
    const production = run(["package", "--json"], { env });
    assert.notEqual(production.status, 0);
    assert.equal(lastJson(production.stderr)?.code, "macos_credentials");
  });
});
