import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import jeitoCodeweavePiExtension from "../index.ts";
import { parseFileBackedLeadsFromJson, runCommand } from "../src/core/navigation-clean.ts";
import { harnessEnvelope, nativeToolResult } from "../src/core/harness-result.ts";
import { extensionRuntimePaths, setExtensionRuntimeRootForTests } from "../src/core/owned-runtime.ts";

async function seedR2DocsState(root) {
  await mkdir(join(root, ".pi", "navigation"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { docs: { backend: "qmd", repo: "local/docs", indexPath: ".pi/navigation/qmd", generationId: "fixture-g1", refreshStatus: "ready", qmd: { status: "lexical_ready", generation: "fixture-g1", health: { needsEmbedding: 0 } } } } }));
}

function makePi() {
  const tools = new Map();
  const events = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, { ...tool, sourceInfo: { source: "jeito-codeweave-pi-test" } }); },
    on(name, handler) { events.set(name, handler); },
    getActiveTools() { return []; },
    getAllTools() { return [...tools.values()]; },
    setActiveTools() {},
    event(name) {
      const handler = events.get(name);
      assert.ok(handler, `missing event ${name}`);
      return handler;
    },
    tool(name) {
      const tool = tools.get(name);
      assert.ok(tool, `missing loaded tool ${name}`);
      return tool;
    },
    events,
  };
}

async function call(tool, params, cwd) {
  const result = await tool.execute(`test-${tool.name}`, params, undefined, undefined, { cwd });
  return { text: result.content.map(part => part.type === "text" ? part.text : "").join("\n"), details: result.details };
}

async function executable(path, content) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
  return path;
}


test("public navigation schemas are clean-break only", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  assert.deepEqual(Object.keys(pi.tool("explore").parameters.properties).sort(), ["anchor", "depth", "kind", "limit", "operation", "page", "query", "scope", "view"]);
  assert.equal(pi.getAllTools().some(tool => tool.name === "context"), false, "context must not remain as an advertised compatibility alias");
  assert.equal(pi.events.has("tool_execution_start"), false, "docs no longer uses a tool-cadence scheduler");
  assert.equal(pi.getAllTools().some(tool => tool.name === "code_context"), false, "unproven synthesis is internal, not public");
  assert.deepEqual(Object.keys(pi.tool("trace").parameters.properties).sort(), ["limit", "page", "relation", "scope", "target", "targets", "to"]);
  assert.deepEqual(Object.keys(pi.tool("docs_search").parameters.properties).sort(), ["glob", "limit", "page", "path", "query", "scope"]);
  const grepSchema = pi.tool("grep").parameters;
  assert.equal(grepSchema.type, "object", "grep must keep a top-level object schema; a root-level anyOf is rejected with a 400 by DeepSeek/Kimi-class upstreams (e.g. opencode Zen Go)");
  assert.deepEqual(Object.keys(grepSchema.properties).sort(), ["case", "contextLines", "cursor", "focus", "glob", "output", "paths", "pattern", "query", "syntax", "target", "visibility"]);
  assert.match(grepSchema.properties.paths.description, /one file\/directory for ranked.*ordered exact targets for matches/is);
  const focusBranches = grepSchema.properties.focus.anyOf;
  assert.deepEqual(focusBranches.map(branch => branch.type), ["array", "string", "object"], "focus accepts a string, a string array, or the recovered {target,evidence} object");
  assert.deepEqual(focusBranches[0].items, { type: "string" });
  assert.equal(focusBranches[2].properties.target.type, "string");
  assert.deepEqual(focusBranches[2].properties.evidence.anyOf.map(branch => branch.type), ["array", "string"]);
  assert.deepEqual(Object.keys(pi.tool("find").parameters.properties).sort(), ["budget", "pattern", "patterns", "scope", "sort", "type", "visibility"]);

  assert.deepEqual(Object.keys(pi.tool("ls").parameters.properties).sort(), ["budget", "depth", "glob", "path", "sort", "view", "visibility"]);
  for (const toolName of ["explore", "trace", "docs_search"]) {
    const properties = pi.tool(toolName).parameters.properties;
    const obsoleteFields = toolName === "docs_search" ? ["action", "maxTokens", "detail", "source", "mode", "output", "content", "backend", "doc", "ref", "section"] : toolName === "explore" ? ["path", "detail", "source", "output", "content", "backend", "focus"] : ["path", "detail", "source", "mode", "output", "content", "backend"];
    for (const old of obsoleteFields) assert.equal(Object.hasOwn(properties, old), false, `${toolName} leaked old field ${old}`);
  }
  assert.equal(Object.hasOwn(grepSchema.properties, "query"), true, "query remains the documented compatibility spelling of pattern");
  assert.match(grepSchema.properties.query.description, /Compatibility spelling of pattern/);
  assert.equal(Object.hasOwn(grepSchema.properties, "kind") || Object.hasOwn(grepSchema.properties, "scope"), false, "grep leaked obsolete public fields");
  assert.equal(Object.hasOwn(pi.tool("find").parameters.properties, "maxDepth"), false, "find must not preserve scanner maxDepth param");
});

test("extension wires heavy stop refresh only to session_shutdown", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);

  assert.equal(pi.events.has("agent_end"), false, "interactive agent completion must not launch CRG/Graphify refresh");
  assert.ok(pi.events.has("session_shutdown"));
});

test("session_shutdown honors the host no-setup contract and does not launch stop refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stop-refresh-suppressed-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "suppressed-fixture" }));
  const configPath = join(root, "navigation-config.json");
  const perfPath = join(root, "perf.jsonl");
  await writeFile(configPath, JSON.stringify({ version: 1, automation: { mode: "auto-local", autoRefreshOnStop: "enabled-local-only" } }));
  const previousConfig = process.env.PI_NAV_AUTOMATION_CONFIG;
  const previousNoSetup = process.env.PI_NAV_NO_AUTO_SETUP;
  const previousPerfLog = process.env.PI_NAV_PERF_LOG;
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
  process.env.PI_NAV_NO_AUTO_SETUP = "1";
  process.env.PI_NAV_PERF_LOG = perfPath;
  try {
    const pi = makePi();
    jeitoCodeweavePiExtension(pi);
    const result = await pi.event("session_shutdown")({}, { cwd: root });
    assert.equal(result.status, "suppressed");
    assert.equal(result.root, await realpath(root));
    assert.match(result.reason, /read-only or no setup/);
    assert.equal(existsSync(perfPath), false, "suppressed shutdown must not launch CRG/Graphify telemetry");
  } finally {
    if (previousConfig === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG;
    else process.env.PI_NAV_AUTOMATION_CONFIG = previousConfig;
    if (previousNoSetup === undefined) delete process.env.PI_NAV_NO_AUTO_SETUP;
    else process.env.PI_NAV_NO_AUTO_SETUP = previousNoSetup;
    if (previousPerfLog === undefined) delete process.env.PI_NAV_PERF_LOG;
    else process.env.PI_NAV_PERF_LOG = previousPerfLog;
  }
});

test("session_shutdown refresh launches only Graphify at background priority", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stop-refresh-graphify-only-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "graphify-only-fixture" }));
  await mkdir(join(root, ".pi", "navigation"), { recursive: true });
  const configPath = join(root, "navigation-config.json");
  const perfPath = join(root, "perf.jsonl");
  await writeFile(configPath, JSON.stringify({ version: 1, automation: { mode: "auto-local", autoRefreshOnStop: "enabled-local-only" } }));
  const previousConfig = process.env.PI_NAV_AUTOMATION_CONFIG;
  const previousPerfLog = process.env.PI_NAV_PERF_LOG;
  const previousTelemetry = process.env.PI_NAV_PERF_TELEMETRY;
  const previousInterval = process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS;
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
  process.env.PI_NAV_PERF_LOG = perfPath;
  process.env.PI_NAV_PERF_TELEMETRY = "1";
  process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS = "0";
  try {
    const pi = makePi();
    jeitoCodeweavePiExtension(pi);
    const result = await pi.event("session_shutdown")({}, { cwd: root });
    assert.equal(result.status, "started", JSON.stringify(result, null, 2));
    assert.equal(result.trigger, "stop_refresh");
    assert.equal(result.event, "session_shutdown");
    const records = (await readFile(perfPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    const launch = records.find(record => record.kind === "lifecycle_launch" && record.trigger === "stop_refresh");
    assert.ok(launch, JSON.stringify(records, null, 2));
    const backends = launch.args.flatMap((arg, index, args) => arg === "--backend" ? [args[index + 1]] : []);
    assert.deepEqual(backends, ["graphify"]);
    assert.equal(launch.args.includes("--full-stack"), false, "session shutdown must not request full-stack prepare");
    assert.equal(launch.args.includes("--startup-safe"), false, "session shutdown is not session-start prepare");
    if (process.platform === "darwin") {
      assert.equal(launch.command, "/usr/sbin/taskpolicy");
      assert.deepEqual(launch.args.slice(0, 5), ["-b", "/usr/bin/nice", "-n", "15", process.execPath]);
    }
  } finally {
    if (previousConfig === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG;
    else process.env.PI_NAV_AUTOMATION_CONFIG = previousConfig;
    if (previousPerfLog === undefined) delete process.env.PI_NAV_PERF_LOG;
    else process.env.PI_NAV_PERF_LOG = previousPerfLog;
    if (previousTelemetry === undefined) delete process.env.PI_NAV_PERF_TELEMETRY;
    else process.env.PI_NAV_PERF_TELEMETRY = previousTelemetry;
    if (previousInterval === undefined) delete process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS;
    else process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS = previousInterval;
  }
});

test("session_shutdown refresh is throttled after a recent refresh marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stop-refresh-throttle-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "throttle-fixture" }));
  await mkdir(join(root, ".pi", "navigation", "locks"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "locks", "prepare-stop_refresh.last.json"), JSON.stringify({ root, trigger: "stop_refresh", startedAt: new Date().toISOString() }));
  const configPath = join(root, "navigation-config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, automation: { mode: "auto-local", autoRefreshOnStop: "enabled-local-only" } }));
  const previousConfig = process.env.PI_NAV_AUTOMATION_CONFIG;
  const previousInterval = process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS;
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
  process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS = "600000";
  try {
    const pi = makePi();
    jeitoCodeweavePiExtension(pi);
    const result = await pi.event("session_shutdown")({}, { cwd: root });
    assert.equal(result.status, "throttled");
    assert.equal(result.trigger, "stop_refresh");
    assert.match(result.summary, /skipped because stop_refresh ran recently/);
    assert.equal(existsSync(join(root, ".pi", "navigation", "locks", "prepare-stop_refresh.lock.json")), false);
  } finally {
    if (previousConfig === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG;
    else process.env.PI_NAV_AUTOMATION_CONFIG = previousConfig;
    if (previousInterval === undefined) delete process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS;
    else process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS = previousInterval;
  }
});

test("session_shutdown refresh does not queue behind an existing live lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stop-refresh-live-lock-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "live-lock-fixture" }));
  await mkdir(join(root, ".pi", "navigation", "locks"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "locks", "prepare-stop_refresh.lock.json"), JSON.stringify({ root, trigger: "stop_refresh", pid: process.pid, status: "running", startedAt: new Date().toISOString() }));
  const configPath = join(root, "navigation-config.json");
  const perfPath = join(root, "perf.jsonl");
  await writeFile(configPath, JSON.stringify({ version: 1, automation: { mode: "auto-local", autoRefreshOnStop: "enabled-local-only" } }));
  const previousConfig = process.env.PI_NAV_AUTOMATION_CONFIG;
  const previousPerfLog = process.env.PI_NAV_PERF_LOG;
  const previousTelemetry = process.env.PI_NAV_PERF_TELEMETRY;
  const previousInterval = process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS;
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
  process.env.PI_NAV_PERF_LOG = perfPath;
  process.env.PI_NAV_PERF_TELEMETRY = "1";
  process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS = "0";
  try {
    const pi = makePi();
    jeitoCodeweavePiExtension(pi);
    const result = await pi.event("session_shutdown")({}, { cwd: root });
    assert.equal(result.status, "already_running", JSON.stringify(result, null, 2));
    assert.equal(result.pendingQueued, false);
    assert.match(result.summary, /already running/);
    assert.equal(existsSync(perfPath), false, "a second live stop-refresh must not launch CRG/Graphify telemetry");
    assert.equal(existsSync(join(root, ".pi", "navigation", "locks", "prepare-stop_refresh.pending.json")), false, "shutdown must not queue a redundant pass");
  } finally {
    if (previousConfig === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG;
    else process.env.PI_NAV_AUTOMATION_CONFIG = previousConfig;
    if (previousPerfLog === undefined) delete process.env.PI_NAV_PERF_LOG;
    else process.env.PI_NAV_PERF_LOG = previousPerfLog;
    if (previousTelemetry === undefined) delete process.env.PI_NAV_PERF_TELEMETRY;
    else process.env.PI_NAV_PERF_TELEMETRY = previousTelemetry;
    if (previousInterval === undefined) delete process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS;
    else process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS = previousInterval;
  }
});

test("query-time navigation rejects old fields and fails closed without lexical fallback", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-break-"));
  await writeFile(join(cwd, "README.md"), "# Fixture\n");

  assert.match((await call(pi.tool("explore"), { query: "overview", view: "code", path: cwd }, cwd)).text, /INVALID CALL: explore[\s\S]*(?:path|obsolete|unknown field)/i);
  assert.match((await call(pi.tool("trace"), { target: "x", relation: "callers", source: "graph" }, cwd)).text, /INVALID CALL: trace[\s\S]*(?:source|obsolete|unknown field)/i);
  assert.match((await call(pi.tool("docs_search"), { query: "fixture", mode: "multi-source" }, cwd)).text, /INVALID CALL: docs_search[\s\S]*(?:mode|obsolete|unknown field)/i);

  const { text } = await call(pi.tool("explore"), { query: "overview", view: "map", scope: cwd }, cwd);
  assert.match(text, /UNAVAILABLE: graph map unavailable/);
  assert.doesNotMatch(text, /README\.md/);
  assert.match(text, /No query-time setup|no fallback/i);
});

test("Graphify path/explain uses query-log-disable env and preserves native output", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-graph-"));
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const runtime = join(cwd, ".runtime");
  setExtensionRuntimeRootForTests(runtime);
  const paths = extensionRuntimePaths();
  const fakeGraphify = await executable(paths.graphify, `#!/usr/bin/env node\nif (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') { console.error('missing disable'); process.exit(2); }\nconsole.log('native graph output src/a.ts:1-1');\n`);
  await executable(paths.python, "#!/bin/sh\nexit 0\n");
  await writeFile(paths.ready, "ready\n");
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", graphPath: ".pi/navigation/graphify/graphify-out/graph.json", root: "." } }, null, 2));

  try {
    const { text, details } = await call(pi.tool("trace"), { target: "A", relation: "explain", scope: cwd }, cwd);
    assert.match(text, /native graph output/);
    assert.match(text, /src\/a\.ts:1-1/);
    assert.equal(details.envelope.diagnostics, undefined, "normal result diagnostics must not expose backend debug details");
    assert.deepEqual(details.envelope.next_actions, [], "normal success envelope must not repeat read-this-next workflow boilerplate");
  } finally {
    setExtensionRuntimeRootForTests();
  }
});

test("retired architecture config cannot resurrect a code graph at query time", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-retired-architecture-"));
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({
    architecture: { enabled: true, backend: "code-review-graph", indexPath: ".code-review-graph/graph.db", root: "." },
  }, null, 2));

  const { text } = await call(pi.tool("explore"), { view: "code", operation: "search", anchor: "missing graph identity", scope: cwd }, cwd);
  assert.match(text, /UNAVAILABLE|not available|missing/i);
  assert.equal(existsSync(join(cwd, ".code-review-graph", "graph.db")), false, "query-time must not create/fall back to a default graph");
  assert.equal(existsSync(join(cwd, ".pi", "navigation", "crg", "graph.db")), false, "query-time must not build the intended graph");
});

test("find normalizes bare filenames and preserves typed native path metadata", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-find-normalize-"));
  await mkdir(join(cwd, "docs"), { recursive: true });
  await writeFile(join(cwd, "README.md"), "# Root\n");
  await writeFile(join(cwd, "docs", "README.md"), "# Docs\n");

  const result = await call(pi.tool("find"), { pattern: "README.md", scope: cwd, sort: "path" }, cwd);
  assert.match(result.text, /# Files: 1 pattern\(s\), 2 matches/);
  assert.match(result.text, /README\.md/);
  assert.match(result.text, /docs\/README\.md/);
  assert.equal(result.details.native.operation, "pi_nav_files");
  assert.equal(result.details.native.completeness.total, 2);
});

test("find keeps each batched pattern outcome visible in model text", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-find-pattern-outcomes-"));
  await writeFile(join(cwd, "one.ts"), "export const one = 1;\n");
  const result = await call(pi.tool("find"), { patterns: ["*.ts", "*.missing"], scope: cwd, sort: "path" }, cwd);
  assert.match(result.text, /Pattern outcomes: "\*\.ts"=1 · "\*\.missing"=0/);
});

test("find normalizes bare fragments and preserves paths with spaces and extensionless files", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-find-fragment-"));
  await mkdir(join(cwd, "dir with space"), { recursive: true });
  await mkdir(join(cwd, "bin"), { recursive: true });
  await writeFile(join(cwd, "dir with space", "client file.ts"), "export const client = 1;\n");
  await writeFile(join(cwd, "bin", "client"), "client\n");

  const { text } = await call(pi.tool("find"), { pattern: "client", scope: cwd, sort: "path" }, cwd);
  assert.match(text, /dir with space\/client file\.ts/);
  assert.match(text, /bin\/client/);
});

test("find project and all both retain generated navigation-state safety exclusion", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-find-native-paths-"));
  await mkdir(join(cwd, ".pi", "navigation", "cache"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "cache", "a.ts"), "export const generated = 1;\n");
  await writeFile(join(cwd, "src", "graphify-scope-policy.ts"), "export const source = 1;\n");

  const project = await call(pi.tool("find"), { pattern: "*.ts", scope: cwd, visibility: "project", sort: "path" }, cwd);
  assert.doesNotMatch(project.text, /\.pi\/navigation\/cache\/a\.ts/);
  assert.match(project.text, /src\/graphify-scope-policy\.ts/);
  const all = await call(pi.tool("find"), { pattern: "*.ts", scope: cwd, visibility: "all", sort: "path" }, cwd);
  assert.doesNotMatch(all.text, /\.pi\/navigation\/cache\/a\.ts/, "all retains query-state safety exclusions");
});

test("grep returns typed guidance for incompatible ranked multi-target calls", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-grep-invalid-call-"));
  const result = await pi.tool("grep").execute("grep-invalid", { pattern: "x", paths: ["a.ts", "b.ts"], output: "RANKED" }, undefined, undefined, { cwd });
  assert.equal(result.details.validation.kind, "tool-call-validation");
  assert.match(result.content[0].text, /INVALID CALL: grep[\s\S]*ranked.*multiple targets[\s\S]*output:'matches'/i);
});

test("grep compacts ranked output without rewriting exact source tokens", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-grep-fidelity-"));
  await mkdir(join(cwd, "src", "core"), { recursive: true });
  await writeFile(join(cwd, "src", "core", "graphify-scope-policy.ts"), "export const message = 'Graphify and Tilth are exact source tokens here';\n");

  const { text } = await call(pi.tool("grep"), { pattern: "Graphify", syntax: "literal", paths: cwd }, cwd);
  assert.match(text, /Graphify and Tilth are exact source tokens here/);
  assert.match(text, /src\/core\/graphify-scope-policy\.ts/);
  assert.doesNotMatch(text, /graph map|live utility|graph map-scope-policy/);
});

test("supervised query commands kill child process groups on timeout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-supervisor-"));
  const pidFile = join(cwd, "grandchild.pid");
  const code = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' }); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(()=>{}, 1000);`;
  const run = await runCommand(process.execPath, ["-e", code], { cwd, timeoutMs: 300 });
  assert.equal(run.ok, false);
  assert.equal(run.timedOut, true);
  const pid = Number(await readFile(pidFile, "utf8"));
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(pidAlive(pid), false, `grandchild ${pid} survived supervised timeout`);
});

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("pi-nav exact utilities use bundled read-only operations and preserve typed metadata", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-native-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, ".pi", "navigation", "cache"), { recursive: true });
  await writeFile(join(cwd, "src", "a.ts"), "export function target() { return 1; }\nexport const literal = 'context({';\n");
  await writeFile(join(cwd, ".pi", "navigation", "cache", "a.ts"), "export const generated = true;\n");

  const grepOut = await call(pi.tool("grep"), { pattern: "target", syntax: "symbol", paths: cwd }, cwd);
  assert.match(grepOut.text, /Ranked exact search:[\s\S]*export function target/);
  assert.match(grepOut.text, /Live source authority[\s\S]*src\/a\.ts/);
  const fuzzyOut = await call(pi.tool("grep"), { pattern: "target function", paths: cwd }, cwd);
  assert.match(fuzzyOut.text, /Ranked behavior search:[\s\S]*Route: behavior discovery/);
  assert.match(fuzzyOut.text, /# target — src\/a\.ts #[A-F0-9]{8} :1[\s\S]*1: export function target/);
  const literalOut = await call(pi.tool("grep"), { pattern: "context({", syntax: "literal", paths: cwd }, cwd);
  assert.match(literalOut.text, /context\(\{/);
  const projectFind = await call(pi.tool("find"), { pattern: "*.ts", scope: cwd, visibility: "project", sort: "path" }, cwd);
  assert.match(projectFind.text, /src\/a\.ts/);
  assert.doesNotMatch(projectFind.text, /\.pi\/navigation\/cache\/a\.ts/);
  const allFind = await call(pi.tool("find"), { pattern: "*.ts", scope: cwd, visibility: "all", sort: "path" }, cwd);
  assert.doesNotMatch(allFind.text, /\.pi\/navigation\/cache\/a\.ts/, "all retains query-state safety exclusions");
  assert.equal(grepOut.details.native.operation, "pi_nav_search");
  assert.equal(projectFind.details.native.operation, "pi_nav_files");
  assert.deepEqual(grepOut.details.envelope.next_actions, []);
  assert.deepEqual(projectFind.details.envelope.next_actions, []);
});

test("file-backed lead normalization does not render docs byte offsets as line selectors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-leads-"));
  await writeFile(join(cwd, "guide.md"), Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));
  const leads = parseFileBackedLeadsFromJson({ results: [{ doc_path: "guide.md", title: "Guide", start: 1878, end: 3198 }] }, cwd, 4);
  assert.deepEqual(leads.map(lead => `${lead.path}:${lead.start}-${lead.end}`), ["guide.md:1-12"]);
});

test("native tool results with oversized text or metadata are withheld before model context", () => {
  const envelope = harnessEnvelope({ status: "success", summary: "fixture", next_actions: [], artifacts: [] });
  const native = {
    schemaVersion: 1,
    operation: "pi_nav_search",
    data: {},
    completeness: { complete: true, returned: 1, total: 1 },
    diagnostics: [],
  };

  const oversizedText = nativeToolResult("x".repeat(512 * 1024), native, envelope);
  assert.ok(Buffer.byteLength(oversizedText.content[0].text) < 2_000);
  assert.match(oversizedText.content[0].text, /payload was returned|response was withheld/i);
  assert.equal(oversizedText.details.envelope.status, "error");

  const oversizedMetadata = nativeToolResult("small", {
    ...native,
    data: { rows: Array.from({ length: 300 }, () => "x".repeat(2_000)) },
  }, envelope);
  assert.ok(Buffer.byteLength(oversizedMetadata.content[0].text) < 2_000);
  assert.match(oversizedMetadata.content[0].text, /response was withheld/i);
  assert.equal(Object.hasOwn(oversizedMetadata.details.native, "data"), false);
});

test("grep matches exposes enriched exact targets, spans, skips, authority, and immutable continuation", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-grep-matches-"));
  await mkdir(join(cwd, ".git"), { recursive: true });
  await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
  await writeFile(join(cwd, "many.txt"), Array.from({ length: 200 }, (_, index) => `hello ${index} ${"x".repeat(200)} goodbye`).join("\n") + "\n");
  await writeFile(join(cwd, "ignored.txt"), "hello|goodbye\n");
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0x68, 0x69, 0x00, 0x78]));

  const first = await call(pi.tool("grep"), {
    pattern: "hello|goodbye",
    syntax: "auto",
    output: "matches",
    paths: ["many.txt", "ignored.txt", "binary.dat", "missing.txt"],
    contextLines: 0,
  }, cwd);
  assert.match(first.text, /Resolved: auto→regex/);
  assert.match(first.text, /ignored\.txt/);
  assert.match(first.text, /binary_nul/);
  assert.match(first.text, /path not found/);
  assert.match(first.text, /\[many\.txt#[0-9A-F]{8}\]/);
  assert.equal(first.details.native.data.groups[0].matches[0].spans.length, 2);
  const cursor = first.details.native.data.cursor;
  assert.equal(typeof cursor, "string");
  const second = await call(pi.tool("grep"), { cursor, contextLines: 1 }, cwd);
  const repeated = await call(pi.tool("grep"), { cursor, contextLines: 1 }, cwd);
  assert.equal(second.text, repeated.text);
  assert.equal(second.details.native.data.resolved.contextLines, 1);
  const firstLines = new Set(first.details.native.data.groups.flatMap(group => group.matches.map(match => `${match.path}:${match.line}`)));
  const secondLines = second.details.native.data.groups.flatMap(group => group.matches.map(match => `${match.path}:${match.line}`));
  assert.ok(secondLines.every(line => !firstLines.has(line)), "continuation repeated a match identity");

  const literalPipe = await call(pi.tool("grep"), { pattern: "hello|goodbye", syntax: "literal", output: "matches", paths: "ignored.txt" }, cwd);
  assert.match(literalPipe.text, /1 occurrence/);
});
test("grep matches skips files exceeding the 4 MiB size limit and surfaces partial coverage", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-clean-grep-oversized-"));
  await mkdir(join(cwd, ".git"), { recursive: true });
  await writeFile(join(cwd, "small.txt"), "hello world\n");
  // 4 MiB + 1 byte — exceeds MAX_FILE_BYTES; pattern present but must be skipped by size
  await writeFile(join(cwd, "huge.txt"), "hello\n" + "x".repeat(4 * 1024 * 1024));

  const result = await call(pi.tool("grep"), {
    pattern: "hello",
    syntax: "literal",
    output: "matches",
    paths: ["small.txt", "huge.txt"],
    contextLines: 0,
  }, cwd);

  assert.match(result.text, /small\.txt/);   // small file matched
  assert.match(result.text, /oversized/);    // huge file skipped as oversized
  assert.match(result.text, /partial/);      // coverage surfaces as partial, not silent
});
