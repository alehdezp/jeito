import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const suiteRoot = path.resolve(new URL("..", import.meta.url).pathname);
const sourceExtension = path.join(suiteRoot, "extensions", "codeweave-pi");
const supported = process.platform === "darwin" && process.arch === "arm64";
const installAuthorized = process.env.PI_NAV_TEST_INSTALL === "1";
const excluded = new Set(["node_modules", ".runtime", ".tmp", ".ua", ".pi", ".code-review-graph", "dist"]);

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000, ...options });
}

function copyFilter(source) {
  const relative = path.relative(sourceExtension, source);
  return !relative || !excluded.has(relative.split(path.sep)[0]);
}

async function seedValidatedQmdCache(target) {
  const source = process.env.PI_NAV_TEST_QMD_CACHE ?? path.join(os.homedir(), ".cache", "qmd", "models");
  if (!existsSync(source)) return false;
  const models = (await readdir(source)).filter(file => /embeddinggemma-300M-Q8_0\.gguf|qwen3-reranker-0\.6b-q8_0\.gguf/.test(file));
  if (models.length !== 2) return false;
  await mkdir(target, { recursive: true });
  for (const model of models) {
    try {
      await link(path.join(source, model), path.join(target, model));
    } catch (error) {
      if (error?.code !== "EXDEV") throw error;
      await copyFile(path.join(source, model), path.join(target, model));
    }
  }
  return true;
}

test("prepared checkout installs Core plus local QMD without Python and registers only codeweave-pi", { skip: !supported || !installAuthorized }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codeweave-pi-checkout-install-"));
  if (!process.env.PI_NAV_KEEP_RELEASE_FIXTURE) t.after(() => rm(temp, { recursive: true, force: true }));
  else console.error(`checkout install fixture retained at ${temp}`);

  const checkout = path.join(temp, "checkout");
  const extension = path.join(checkout, "extensions", "codeweave-pi");
  await mkdir(path.dirname(extension), { recursive: true });
  await cp(sourceExtension, extension, { recursive: true, filter: copyFilter });
  await cp(path.join(suiteRoot, "package.json"), path.join(checkout, "package.json"));

  const home = path.join(temp, "home");
  const agentDir = path.join(home, "agent");
  const project = path.join(temp, "consumer");
  const modelCache = path.join(home, ".cache", "qmd", "models");
  if (await seedValidatedQmdCache(modelCache)) t.diagnostic("reused validated QMD GGUF files; clean acquisition is owned by qmd:model-provision");
  const decoys = path.join(temp, "decoys");
  await mkdir(project);
  await mkdir(path.join(project, ".git"));
  await writeFile(path.join(project, "README.md"), "# Installed codeweave-pi\n\nautomatic local semantic readiness\n");
  await mkdir(decoys);
  for (const backend of ["python", "python3", "pip", "pip3", "code-review-graph", "graphify", "qmd"]) {
    const file = path.join(decoys, backend);
    await writeFile(file, `#!/bin/sh\ntouch ${JSON.stringify(path.join(temp, `${backend}.used`))}\nexit 99\n`);
    await chmod(file, 0o755);
  }

  const pi = run("which", ["pi"]).stdout.trim();
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    npm_config_cache: path.join(temp, "npm-cache"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    PATH: [decoys, path.dirname(pi), path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
  };
  delete env.PI_NAV_PYTHON;
  delete env.ZEROENTROPY_API_KEY;
  delete env.VOYAGE_API_KEY;
  const installed = run("npm", ["run", "install:codeweave-pi"], { cwd: checkout, env });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /automatic Core code and QMD/);
  assert.match(installed.stdout, /nav:provision:legacy/);

  assert.equal(existsSync(path.join(checkout, "node_modules")), false, "root workspace must not be installed");
  for (const required of [
    "native/analysis/runtime/codegraph-kernel.node",
    "native/analysis/runtime/core.cjs",
    "native/analysis/runtime/schema.sql",
    "native/analysis/runtime/maintenance.cjs",
    "native/analysis/runtime/parse-worker.js",
    "native/analysis/runtime/store-worker.js",
    "native/analysis/runtime/maintenance-schema.sql",
    "native/analysis/runtime/package.json",
    "native/analysis/runtime/semantic-model/config.json",
    "native/analysis/runtime/semantic-model/tokenizer.json",
    "native/analysis/runtime/semantic-model/model.safetensors",
    "node_modules/node-llama-cpp/package.json",
    "native/qmd/runtime/index.js",
    "skills/deep-navigation-onboard/SKILL.md",
    "skills/navigation-setup/SKILL.md",
  ]) assert.equal(existsSync(path.join(extension, required)), true, `missing ${required}`);
  assert.equal(existsSync(path.join(extension, ".runtime")), false, "default install must not provision optional Python");
  const modelFiles = await readdir(modelCache);
  assert.equal(modelFiles.some(file => file.includes("embeddinggemma-300M-Q8_0.gguf")), true);
  assert.equal(modelFiles.some(file => file.includes("qwen3-reranker-0.6b-q8_0.gguf")), true);
  for (const backend of ["python", "python3", "pip", "pip3", "code-review-graph", "graphify", "qmd"]) assert.equal(existsSync(path.join(temp, `${backend}.used`)), false);

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.equal(settings.packages.length, 1);
  const configuredSource = typeof settings.packages[0] === "string" ? settings.packages[0] : settings.packages[0].source;
  assert.equal(await realpath(path.resolve(agentDir, configuredSource)), await realpath(extension));

  const prepared = run(process.execPath, ["scripts/navigation-freshen.mjs", "docs", "--path", project, "--json"], { cwd: extension, env });
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const preparedReport = JSON.parse(prepared.stdout.trim());
  assert.equal(preparedReport.qmd.status, "ready", prepared.stdout);
  assert.equal(preparedReport.qmd.semantic_provider, "local", prepared.stdout);

  const piPackageRoot = path.dirname(path.dirname(await realpath(pi)));
  const priorNoAutoSetup = process.env.PI_NAV_NO_AUTO_SETUP;
  const priorXdgCacheHome = process.env.XDG_CACHE_HOME;
  const priorZeroEntropy = process.env.ZEROENTROPY_API_KEY;
  const priorVoyage = process.env.VOYAGE_API_KEY;
  process.env.PI_NAV_NO_AUTO_SETUP = "1";
  process.env.XDG_CACHE_HOME = env.XDG_CACHE_HOME;
  delete process.env.ZEROENTROPY_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  const realPi = await import(pathToFileURL(path.join(piPackageRoot, "dist", "index.js")).href);
  const { session } = await realPi.createAgentSession({ cwd: project, agentDir, noTools: "builtin", tools: ["docs_search"] });
  try {
    assert.ok(session.getToolDefinition("docs_search"));
    const loadedSource = session.getAllTools().find(tool => tool.name === "docs_search")?.sourceInfo?.path;
    assert.ok(loadedSource);
    assert.equal(await realpath(loadedSource), await realpath(path.join(extension, "index.ts")));
    const searched = await session.getToolDefinition("docs_search").execute("checkout-local-docs", { query: "automatic local semantic readiness", scope: project }, undefined, undefined, { cwd: project, mode: "print", hasUI: false, ui: { notify() {} } });
    const text = searched.content.map(part => part.text ?? "").join("\n");
    assert.match(text, /Search mode: hybrid/);
    assert.match(text, /privacy=local_index_local_inference/);
  } finally {
    session.dispose();
    if (priorNoAutoSetup === undefined) delete process.env.PI_NAV_NO_AUTO_SETUP; else process.env.PI_NAV_NO_AUTO_SETUP = priorNoAutoSetup;
    if (priorXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = priorXdgCacheHome;
    if (priorZeroEntropy === undefined) delete process.env.ZEROENTROPY_API_KEY; else process.env.ZEROENTROPY_API_KEY = priorZeroEntropy;
    if (priorVoyage === undefined) delete process.env.VOYAGE_API_KEY; else process.env.VOYAGE_API_KEY = priorVoyage;
  }
});
