import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile, rm } from "node:fs/promises";
import { existsSync } from 'node:fs';
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  transformBundleChunk,
  transformModularSource,
} from "./ensure-pi-registered-tool-api.mjs";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(new URL("./ensure-pi-registered-tool-api.mjs", import.meta.url));
const testTempRoot = path.resolve(path.dirname(scriptPath), "../../..", ".tmp");
const piRoot = process.env.PI_TEST_RUNTIME ??
  path.dirname(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const piVersion = JSON.parse(await readFile(path.join(piRoot, 'package.json'), 'utf8')).version;
const modularPaths = [
  "dist/core/extensions/loader.js",
  "dist/core/extensions/runner.js",
  "dist/core/agent-session.js",
];

let fixtureRoot;
let AgentSession;

async function copyPiFixture() {
  await mkdir(testTempRoot, { recursive: true });
  fixtureRoot = await mkdtemp(path.join(testTempRoot, "tooltap-runtime-api-"));
  await cp(path.join(piRoot, "dist"), path.join(fixtureRoot, "dist"), { recursive: true });
  await symlink(path.join(piRoot, "node_modules"), path.join(fixtureRoot, "node_modules"), "dir");
  const packageInfo = JSON.parse(await readFile(path.join(piRoot, "package.json"), "utf8"));
  packageInfo.type = "module";
  await writeFile(path.join(fixtureRoot, "package.json"), `${JSON.stringify(packageInfo)}\n`);
}


before(async () => {
  await copyPiFixture();
  const beforeCheck = await Promise.all(modularPaths.map(name => readFile(path.join(fixtureRoot, name), 'utf8')));
  // A source installation may already carry this patch. Check must be
  // read-only whether it reports complete (0) or missing capabilities (1).
  await execFile(process.execPath, [scriptPath, '--pi', fixtureRoot, '--check', '--quiet']).catch(error => {
    assert.equal(error.code, 1);
  });
  assert.deepEqual(await Promise.all(modularPaths.map(name => readFile(path.join(fixtureRoot, name), 'utf8'))), beforeCheck);
  await execFile(process.execPath, [scriptPath, "--pi", fixtureRoot, "--quiet"]);
  ({ AgentSession } = await import(`${pathToFileURL(path.join(fixtureRoot, "dist/core/agent-session.js"))}?runtime-api-test`));
});

after(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

test("runtime patch transforms bundled and modular Pi surfaces idempotently", async () => {
  const applied = await execFile(process.execPath, [scriptPath, "--pi", fixtureRoot, "--quiet"]);
  assert.equal(applied.stdout, "");
  const second = await execFile(process.execPath, [scriptPath, "--pi", fixtureRoot, "--quiet"]);
  assert.equal(second.stdout, "");
  const checked = await execFile(process.execPath, [scriptPath, "--pi", fixtureRoot, "--check", "--quiet"]);
  assert.equal(checked.stdout, "");

  const bundleFiles = (await readdir(path.join(fixtureRoot, "dist/bundle/chunks")))
    .filter((name) => /^chunk-.*\.js$/.test(name));
  const bundle = await Promise.all(bundleFiles.map((name) => readFile(path.join(fixtureRoot, "dist/bundle/chunks", name), "utf8")));
  const patchedBundleIndex = bundle.findIndex((source) => source.includes("setActiveToolsWithDeferred"));
  const patchedBundle = bundle[patchedBundleIndex];
  assert.ok(patchedBundle, "the CLI bundle has no deferred activation API");
  const patchedPaths = [
    ...modularPaths,
    path.join("dist/bundle/chunks", bundleFiles[patchedBundleIndex]),
  ];
  for (const relativePath of patchedPaths) {
    assert.equal(
      existsSync(path.join(fixtureRoot, `${relativePath}.pre-deferred-tools-api-${piVersion}.bak`)),
      true,
      `missing backup for ${relativePath}`,
    );
  }
  assert.match(patchedBundle, /getRegisteredTool:name=>this\.getToolDefinition\(name\)/);
  assert.match(patchedBundle, /setActiveToolsWithDeferred\(toolNames,deferredNames\)/);
  assert.match(patchedBundle, /setActiveToolsWithDeferred\(toolNames,deferredNames\)\{if\(!Array\.isArray/);
  assert.match(patchedBundle, /this\._deferredToolNames\?\.has\(name\)/);
  assert.equal(transformBundleChunk(patchedBundle), patchedBundle);

  for (const relativePath of modularPaths) {
    const source = await readFile(path.join(fixtureRoot, relativePath), "utf8");
    assert.match(source, /setActiveToolsWithDeferred/);
    assert.equal(transformModularSource(source, relativePath), source);
  }

  const loader = await readFile(path.join(fixtureRoot, modularPaths[0]), "utf8");
  const runner = await readFile(path.join(fixtureRoot, modularPaths[1]), "utf8");
  const sessionSource = await readFile(path.join(fixtureRoot, modularPaths[2]), "utf8");
  assert.match(loader, /setActiveToolsWithDeferred: notInitialized/);
  assert.match(loader, /runtime\.setActiveToolsWithDeferred\(toolNames, deferredNames\)/);
  assert.match(runner, /this\.runtime\.setActiveToolsWithDeferred = actions\.setActiveToolsWithDeferred/);
  assert.match(sessionSource, /setActiveToolsWithDeferred\(toolNames, deferredNames\)/);
  assert.match(sessionSource, /setActiveToolsWithDeferred: \(toolNames, deferredNames\)/);
  await execFile(process.execPath, ["--check", path.join(fixtureRoot, modularPaths[0])]);
  await execFile(process.execPath, ["--check", path.join(fixtureRoot, modularPaths[1])]);
  await execFile(process.execPath, ["--check", path.join(fixtureRoot, modularPaths[2])]);
  await execFile(process.execPath, ["--check", path.join(fixtureRoot, "dist/bundle/chunks", bundleFiles[0])]);
});

test("a drifted production shape fails closed before mutation", async () => {
  const source = await readFile(path.join(fixtureRoot, modularPaths[0]), 'utf8');
  assert.throws(() => transformModularSource(source + source, modularPaths[0]), /ambiguous or mixed state/);
  const current = await readFile(path.join(fixtureRoot, modularPaths[2]), 'utf8');
  const damaged = current.replace('this._deferredToolNames = previous.deferred;', 'this._deferredToolNames = previous.unrelated;');
  assert.notEqual(damaged, current);
  assert.throws(() => transformModularSource(damaged, modularPaths[2]), /existing implementation differs/);
});

test("deferred activation hides only prompt material while preserving dispatch and rebuilds", () => {
  assert.ok(AgentSession, "patched production AgentSession was not loaded");
  let append = "APPEND-ONE";
  let executed = 0;
  const ordinary = { name: "ordinary", execute: () => "ordinary" };
  const deferred = { name: "deferred", execute: () => { executed++; return "deferred"; } };
  const session = Object.create(AgentSession.prototype);
  session.agent = { state: { tools: [], systemPrompt: "" } };
  session._toolRegistry = new Map([[ordinary.name, ordinary], [deferred.name, deferred]]);
  session._toolDefinitions = new Map();
  session._toolPromptSnippets = new Map([
    [ordinary.name, "ORDINARY-SNIPPET"],
    [deferred.name, "DEFERRED-SNIPPET"],
  ]);
  session._toolPromptGuidelines = new Map([
    [ordinary.name, ["ORDINARY-GUIDELINE"]],
    [deferred.name, ["DEFERRED-GUIDELINE"]],
  ]);
  session._resourceLoader = {
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [append],
    getSkills: () => ({ skills: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
  };
  session._cwd = "/tmp/stow-runtime-api-test";
  session._systemPromptOverride = undefined;

  session.setActiveToolsWithDeferred([ordinary.name, deferred.name], [deferred.name]);
  assert.deepEqual(session.agent.state.tools, [ordinary, deferred]);
  assert.equal(session.agent.state.tools[1].execute(), "deferred");
  assert.equal(executed, 1, "deferred tools were removed from dispatch");
  assert.deepEqual(session._baseSystemPromptOptions.selectedTools, [ordinary.name]);
  assert.match(session.systemPrompt, /ORDINARY-SNIPPET/);
  assert.match(session.systemPrompt, /ORDINARY-GUIDELINE/);
  assert.doesNotMatch(session.systemPrompt, /DEFERRED-SNIPPET|DEFERRED-GUIDELINE/);

  append = "APPEND-TWO";
  session.setActiveToolsByName([ordinary.name, deferred.name]);
  assert.match(session.systemPrompt, /APPEND-TWO/);
  assert.doesNotMatch(session.systemPrompt, /DEFERRED-SNIPPET|DEFERRED-GUIDELINE/);

  const previousTools = session.agent.state.tools;
  const previousPrompt = session.systemPrompt;
  const previousDeferred = session._deferredToolNames;
  assert.throws(
    () => session.setActiveToolsWithDeferred([ordinary.name], [deferred.name]),
    /registered member of toolNames/,
  );
  assert.equal(session.agent.state.tools, previousTools);
  assert.equal(session.systemPrompt, previousPrompt);
  assert.equal(session._deferredToolNames, previousDeferred);

  session.setActiveToolsWithDeferred([ordinary.name, deferred.name], []);
  assert.deepEqual(session._baseSystemPromptOptions.selectedTools, [ordinary.name, deferred.name]);
  assert.match(session.systemPrompt, /DEFERRED-SNIPPET/);
  assert.match(session.systemPrompt, /DEFERRED-GUIDELINE/);
});


test('CLI syntax rejection leaves every runtime file unchanged', async () => {
  const file = path.join(fixtureRoot, modularPaths[2]);
  const original = await readFile(file, 'utf8');
  try {
    await writeFile(file, original + '\n{');
    const before = await Promise.all(modularPaths.map(name => readFile(path.join(fixtureRoot, name), 'utf8')));
    await assert.rejects(execFile(process.execPath, [scriptPath, '--pi', fixtureRoot, '--quiet']), /syntax validation failed/);
    const after = await Promise.all(modularPaths.map(name => readFile(path.join(fixtureRoot, name), 'utf8')));
    assert.deepEqual(after, before);
  } finally {
    await writeFile(file, original);
  }
});
