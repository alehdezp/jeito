import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import jeitoCodeweavePiExtension from "../index.ts";
import { extensionRuntimePaths, loadedRuntimeIdentity, setExtensionRuntimeRootForTests, setLoadedExtensionRootForTests } from "../src/core/owned-runtime.ts";
import { PI_NAV_GREP_CAPABILITIES, piNavArtifactPaths, resolvePiNavTarget } from "../src/core/pi-nav-native.ts";

function makePi() {
  const tools = new Map();
  const handlers = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, { ...tool, sourceInfo: { source: "jeito-codeweave-pi-test" } }); },
    on(event, handler) { handlers.set(event, handler); },
    getActiveTools() { return [...tools.values()]; },
    getAllTools() { return [...tools.values()]; },
    setActiveTools() {},
    tool(name) { const tool = tools.get(name); assert.ok(tool, `missing ${name}`); return tool; },
    handler(name) { const handler = handlers.get(name); assert.ok(handler, `missing handler ${name}`); return handler; },
  };
}

async function waitForFile(file, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(file)) return readFile(file, "utf8");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${file}`);
}

test("loaded tools expose descriptions/parameters with at most one promptGuidelines string", () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const names = pi.getAllTools().map(tool => tool.name).sort();
  for (const name of ["explore", "trace", "docs_search", "read", "edit", "write", "diff", "grep", "find", "lsp_validate"]) {
    assert.ok(names.includes(name), `${name} should load`);
    const tool = pi.tool(name);
    assert.ok(tool.description, `${name} should keep schema/tool description`);
    assert.ok(tool.parameters, `${name} should keep parameter schema`);
    assert.ok(tool.promptSnippet === undefined, `${name} should not inject promptSnippet usage guidance`);
    const guidelines = tool.promptGuidelines;
    assert.ok(guidelines === undefined || Array.isArray(guidelines) && guidelines.length === 1 && typeof guidelines[0] === "string" && guidelines[0].trim().length > 0, `${name} promptGuidelines must be one non-empty string in an array, or absent`);
    if (name === "docs_search") {
      assert.equal(typeof tool.renderCall, "function", "docs_search must use the canonical colored call renderer");
      assert.equal(typeof tool.renderResult, "function", "docs_search must use the canonical structured result renderer");
    }
  }
  assert.equal(names.includes("context"), false);
  assert.equal(names.includes("code_context"), false, "unproven synthesis must remain internal rather than consume public tool surface");
  assert.equal(names.includes("docs"), false, "legacy docs action tool must remain absent");
  assert.match(pi.tool("explore").description, /find the code behind a behavior/);
  assert.match(pi.tool("trace").description, /one wiring question/);
  assert.match(pi.tool("docs_search").description, /search the project's documentation by meaning/i);
  assert.match(pi.tool("explore").parameters.properties.query.description, /packet of exact things/);
  assert.match(pi.tool("trace").parameters.properties.target.description, /exactly as the project knows it/);
  assert.match(pi.tool("lsp_validate").description, /LSP diagnostics/i);
  assert.match(pi.tool("read").description, /cat, plus selectors/i);
  assert.ok(pi.tool("explore").promptGuidelines, "explore should carry non-obvious guidelines");
  assert.ok(pi.tool("trace").promptGuidelines, "trace should carry non-obvious guidelines");
  assert.ok(pi.tool("docs_search").promptGuidelines, "docs_search should carry non-obvious guidelines");
  assert.ok(pi.tool("grep").promptGuidelines, "grep should carry non-obvious guidelines");
  assert.ok(pi.tool("read").promptGuidelines, "read should carry non-obvious guidelines");
  assert.ok(pi.tool("lsp_validate").promptGuidelines, "lsp_validate should carry non-obvious guidelines");
  assert.ok(pi.tool("edit").promptGuidelines, "edit should carry non-obvious guidelines");
  assert.equal(pi.tool("find").promptGuidelines, undefined, "find approves with no guidelines");
  assert.equal(pi.tool("ls").promptGuidelines, undefined, "ls approves with no guidelines");
  assert.equal(pi.tool("write").promptGuidelines, undefined, "write approves with no guidelines");
});

test("doctrine models compound reliability as evolving evidence, not single-tool routing", async () => {
  const doctrine = await readFile(new URL("../docs/harness-doctrine.md", import.meta.url), "utf8");
  assert.match(doctrine, /Authority is per observation and claim, not per whole user request/);
  assert.match(doctrine, /Which dimensions matter must emerge from the repository and each knowledge delta/);
  assert.match(doctrine, /cannot silently impersonate the complete answer/);
  assert.doesNotMatch(doctrine, /Claim or boundary risk\s*\|\s*Evidence authority/);
});

test("startup reports same-version native mismatch before Grep use without setup or losing other tools", async t => {
  const packageRoot = loadedRuntimeIdentity().packageRoot;
  const key = Symbol.for(`jeito-codeweave-pi.pi-nav-native.v1:${packageRoot}`);
  const previous = globalThis[key];
  const addon = createRequire(import.meta.url)(piNavArtifactPaths(packageRoot, resolvePiNavTarget()).addon);
  const build = addon.getBuildInfo();
  build.capabilities = [...new Set([...build.capabilities, ...PI_NAV_GREP_CAPABILITIES])].filter(value => value !== "matches_corpus_v1");
  globalThis[key] = { roots: new Map(), loadPromise: Promise.resolve({ target: resolvePiNavTarget(), addon: {
    getBuildInfo: () => build,
    PiNavSession: class { constructor() { throw new Error("startup must not create a source session"); } },
  } }) };
  t.after(() => { if (previous) globalThis[key] = previous; else delete globalThis[key]; });
  const root = await mkdtemp(join(tmpdir(), "pi-nav-startup-compat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notices = [];
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const ctx = { cwd: root, readOnly: true, ui: { notify(message) { notices.push(message); } } };
  await pi.handler("session_start")({ readOnly: true }, ctx);
  assert.ok(notices.some(message => /Grep is unavailable.*matches_corpus_v1/.test(message)));
  const event = { systemPrompt: "base", prompt: "fix a typo", systemPromptOptions: { selectedTools: ["grep"] } };
  assert.match((await pi.handler("before_agent_start")(event, ctx)).systemPrompt, /matches_corpus_v1/);
  assert.equal(await pi.handler("before_agent_start")({ ...event, systemPromptOptions: { selectedTools: ["read"] } }, ctx), undefined);
  assert.ok(pi.tool("read"));
  build.capabilities.push("matches_corpus_v1");
  await pi.handler("session_start")({ readOnly: true }, ctx);
  assert.equal(await pi.handler("before_agent_start")(event, ctx), undefined);
  assert.equal(existsSync(join(root, ".pi")), false, "metadata checking does not prepare or write a project");
});

test("before_agent_start leaves host doctrine ownership intact while adding only runtime setup status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-host-guidance-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "host-guidance" }));
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);

  const suppressed = await pi.handler("before_agent_start")({ systemPrompt: "base", prompt: "what is this repo about? read-only, no setup", systemPromptOptions: { selectedTools: ["explore", "trace", "docs_search"] } }, { cwd: root });
  assert.match(suppressed.systemPrompt, /^base/);
  assert.match(suppressed.systemPrompt, /Navigation setup notice:/);
  assert.match(suppressed.systemPrompt, /registered prepared capabilities remain directly callable/);
  assert.doesNotMatch(suppressed.systemPrompt, /unavailable prepared capabilities|readiness preflight/i);
  assert.doesNotMatch(suppressed.systemPrompt, /Evidence Navigation Guidelines/);

  const quiet = await pi.handler("before_agent_start")({ systemPrompt: "base", prompt: "fix the typo in foo.ts", systemPromptOptions: { selectedTools: ["explore"] } }, { cwd: root });
  assert.equal(quiet, undefined);

  const globalDoctrine = await pi.handler("before_agent_start")({ systemPrompt: "base\nPi Evidence Navigation Model", prompt: "fix the typo in foo.ts", systemPromptOptions: { selectedTools: ["explore"] } }, { cwd: root });
  assert.equal(globalDoctrine, undefined);
  const noTools = await pi.handler("before_agent_start")({ systemPrompt: "base", prompt: "what is this repo about?", systemPromptOptions: { selectedTools: [] } }, { cwd: root });
  assert.equal(noTools, undefined);
});

test("a loaded package root that disappears is reported on the next prompt and cannot self-repair in process", async () => {
  const loadedRoot = await mkdtemp(join(tmpdir(), "pi-nav-loaded-root-"));
  await mkdir(join(loadedRoot, "native", "pi-nav"), { recursive: true });
  await writeFile(join(loadedRoot, "package.json"), JSON.stringify({ name: "fixture-codeweave-pi", version: "9.9.9" }));
  await writeFile(join(loadedRoot, "index.ts"), "export default function fixture() {}\n");
  await writeFile(join(loadedRoot, "native", "pi-nav", "artifacts.json"), JSON.stringify({ schemaVersion: 1, packageVersion: "9.9.9", targets: {} }));
  setLoadedExtensionRootForTests(loadedRoot);
  try {
    const beforeMove = loadedRuntimeIdentity();
    assert.equal(beforeMove.sourceExists, true);
    assert.equal(beforeMove.packageVersion, "9.9.9");
    await rm(loadedRoot, { recursive: true, force: true });
    const afterMove = loadedRuntimeIdentity();
    assert.equal(afterMove.sourceExists, false);
    assert.equal(afterMove.packageVersion, "9.9.9", "loaded metadata remains identifiable after its source path moves");

    const pi = makePi();
    jeitoCodeweavePiExtension(pi);
    const prompt = await pi.handler("before_agent_start")({ systemPrompt: "base", prompt: "inspect this code", systemPromptOptions: { selectedTools: ["explore"] } }, { cwd: process.cwd() });
    assert.match(prompt.systemPrompt, /loaded codeweave-pi package root no longer exists/);
    assert.match(prompt.systemPrompt, /stop Pi.*repair registration.*restart/i);
    const session = await pi.handler("session_start")({}, { cwd: process.cwd() });
    assert.equal(session.status, "loaded-runtime-stale");
  } finally {
    setLoadedExtensionRootForTests();
  }
});


test("session-start respects explicit host no-setup flags before auto prepare", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-session-no-setup-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "no-setup" }));
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);

  const result = await pi.handler("session_start")({ noSetup: true }, { cwd: root });

  assert.equal(result.status, "suppressed");
  assert.equal(existsSync(join(root, ".pi-navigation.json")), false);
  assert.equal(existsSync(join(root, ".pi", "navigation")), false);
});

test("aggressive session start remains startup-safe while first prompt cannot launch a duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-session-single-"));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "README.md"), "# Demo\n");
  const runtime = join(root, ".runtime");
  setExtensionRuntimeRootForTests(runtime);
  const runtimePaths = extensionRuntimePaths();
  await mkdir(join(runtime, "bin"), { recursive: true });
  for (const file of [runtimePaths.python, runtimePaths.graphify]) await writeFile(file, "");
  await writeFile(runtimePaths.ready, "ready\n");
  const configPath = join(root, "nav-config.json");
  const perfPath = join(root, "perf.jsonl");
  await writeFile(configPath, JSON.stringify({ automation: { mode: "aggressive", autoPrepareOnSessionStart: true, autoPrepareOnFirstBroadRequest: true } }));
  const oldConfig = process.env.PI_NAV_AUTOMATION_CONFIG;
  const oldPerf = process.env.PI_NAV_PERF_LOG;
  const oldTelemetry = process.env.PI_NAV_PERF_TELEMETRY;
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
  process.env.PI_NAV_PERF_LOG = perfPath;
  process.env.PI_NAV_PERF_TELEMETRY = "1";
  let started;
  try {
    const pi = makePi();
    jeitoCodeweavePiExtension(pi);
    started = await pi.handler("session_start")({}, { cwd: root });
    assert.equal(started.status, "started", JSON.stringify(started));
    const broad = await pi.handler("before_agent_start")({ systemPrompt: "base", prompt: "what is this project about?", systemPromptOptions: { selectedTools: ["explore"] } }, { cwd: root });
    assert.match(broad.systemPrompt, /prepare already running.*session_start/i);
    const events = (await readFile(perfPath, "utf8")).trim().split("\n").map(JSON.parse);
    const launch = events.find(event => event.kind === "lifecycle_launch" && event.trigger === "session_start");
    assert.ok(launch);
    assert.equal(launch.args.includes("--full-stack"), false, "session startup must not launch unbounded provider work before the first prompt");
    assert.equal(launch.args.includes("--startup-safe"), true);
    assert.deepEqual(launch.args.slice(launch.args.indexOf("--backend"), launch.args.indexOf("--backend") + 2), ["--backend", "qmd"], "session startup must prepare docs independently of architecture readiness");
  } finally {
    if (started?.pid) { try { process.kill(-started.pid, "SIGTERM"); } catch {} }
    if (oldConfig === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG; else process.env.PI_NAV_AUTOMATION_CONFIG = oldConfig;
    if (oldPerf === undefined) delete process.env.PI_NAV_PERF_LOG; else process.env.PI_NAV_PERF_LOG = oldPerf;
    if (oldTelemetry === undefined) delete process.env.PI_NAV_PERF_TELEMETRY; else process.env.PI_NAV_PERF_TELEMETRY = oldTelemetry;
    setExtensionRuntimeRootForTests();
  }
});

test("loaded explore/trace return actionable invalid-call evidence after repeated registration", async () => {
  for (let i = 0; i < 3; i++) {
    const pi = makePi();
    jeitoCodeweavePiExtension(pi);
    const explore = await pi.tool("explore").execute("x", { query: "q", path: ".", detail: "native" }, undefined, undefined, { cwd: process.cwd() });
    const trace = await pi.tool("trace").execute("x", { target: "x", relation: "callers", path: ".", budget: 1 }, undefined, undefined, { cwd: process.cwd() });
    assert.match(explore.content[0].text, /INVALID CALL: explore[\s\S]*(?:obsolete|unknown field)/i);
    assert.match(trace.content[0].text, /INVALID CALL: trace[\s\S]*(?:obsolete|unknown field)/i);
    assert.equal(explore.details.validation.kind, "tool-call-validation");
    assert.equal(trace.details.validation.kind, "tool-call-validation");
  }
});

test("first broad request starts bounded lifecycle prepare in the background", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-first-broad-hook-"));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "README.md"), "# Demo\n");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "export const main = 1;\n");
  const configPath = join(root, "nav-config.json");
  await writeFile(configPath, JSON.stringify({ automation: { mode: "auto-local", autoPrepareOnFirstBroadRequest: true } }));

  const oldConfig = process.env.PI_NAV_AUTOMATION_CONFIG;
  const oldPath = process.env.PATH;
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
  process.env.PATH = "";
  try {
    const pi = makePi();
    jeitoCodeweavePiExtension(pi);
    const result = await pi.handler("before_agent_start")({ systemPrompt: "base", prompt: "what is this project about?", systemPromptOptions: { selectedTools: ["explore"] } }, { cwd: root });
    assert.match(result.systemPrompt, /Navigation first-prompt readiness before local prepare: Nav:/);
    assert.match(result.systemPrompt, /Navigation lifecycle prepare: started by first_broad_request and not awaited for this turn/);
    assert.match(result.systemPrompt, /Audit log:/);
  } finally {
    if (oldConfig === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG;
    else process.env.PI_NAV_AUTOMATION_CONFIG = oldConfig;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test("ten-tool cadence completes QMD preparation with the backend identity accepted by the lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-qmd-cadence-"));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "README.md"), "# Cadence\n\nLexical lifecycle marker.\n");
  const automationPath = join(root, "navigation.json");
  await writeFile(automationPath, JSON.stringify({ automation: { mode: "auto-local" }, providers: { allowCloud: false, allowEmbeddings: false } }));
  const oldConfig = process.env.PI_NAV_AUTOMATION_CONFIG;
  process.env.PI_NAV_AUTOMATION_CONFIG = automationPath;
  try {
    const pi = makePi();
    jeitoCodeweavePiExtension(pi);
    let launched;
    for (let index = 0; index < 10; index++) launched = await pi.handler("tool_result")({}, { cwd: root });
    assert.equal(launched.status, "started");
    const config = JSON.parse(await waitForFile(join(root, ".pi-navigation.json"), 20_000));
    assert.equal(config.docs.backend, "qmd");
    assert.equal(config.docs.indexPath, ".pi/navigation/qmd");
    const statePath = join(root, ".pi", "navigation", "state.json");
    const initialState = JSON.parse(await waitForFile(statePath, 20_000));
    const initialGeneration = initialState.indexes.docs.qmd.generation;
    await writeFile(join(root, "README.md"), "# Cadence\n\nLexical lifecycle marker.\n\nExternally changed cadence marker.\n");
    for (let index = 0; index < 10; index++) await pi.handler("tool_result")({}, { cwd: root });
    const refreshStarted = Date.now();
    let refreshedState;
    while (Date.now() - refreshStarted < 20_000) {
      refreshedState = JSON.parse(await readFile(statePath, "utf8"));
      if (refreshedState.indexes.docs.qmd.generation !== initialGeneration) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.notEqual(refreshedState.indexes.docs.qmd.generation, initialGeneration, "ten-tool cadence must reconcile external Markdown changes even when the QMD lane was already ready");
    assert.equal(refreshedState.indexes.docs.qmd.semantic.status, "unavailable");
    assert.equal(refreshedState.indexes.docs.qmd.embedding.mode, "lexical");
    const errors = existsSync(join(root, ".pi", "navigation-prepare-err.log"))
      ? await readFile(join(root, ".pi", "navigation-prepare-err.log"), "utf8")
      : "";
    assert.doesNotMatch(errors, /unknown backend: docs/);
  } finally {
    if (oldConfig === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG;
    else process.env.PI_NAV_AUTOMATION_CONFIG = oldConfig;
  }
});

test("loaded lsp_validate emits bounded agent-facing progress", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-nav-loaded-lsp-progress-"));
  const file = join(cwd, "plain.txt");
  await writeFile(file, "plain\n");
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  assert.equal(pi.tool("lsp_validate").renderShell, "self");
  assert.equal(typeof pi.tool("lsp_validate").renderCall, "function");
  assert.equal(typeof pi.tool("lsp_validate").renderResult, "function");
  const updates = [];
  const result = await pi.tool("lsp_validate").execute("progress", { paths: [file] }, undefined, update => updates.push(update), { cwd });
  assert.match(result.content[0].text, /Unsupported/);
  assert.ok(updates.length >= 1);
  const text = updates.map(update => update.content?.[0]?.text ?? "").join("\n");
  assert.match(text, /detecting or installing configured primary servers/);
  assert.doesNotMatch(text, /npm|pnpm|yarn|node_modules/);
});
