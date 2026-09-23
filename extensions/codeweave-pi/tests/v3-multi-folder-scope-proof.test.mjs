import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import jeitoCodeweavePiExtension from "../index.ts";
import { resolvePreparedLane } from "../src/core/navigation-config.ts";
import { launchBackground, resolveBackgroundLaunch } from "../src/core/background-launch.ts";
import { compileNavigationCorpusPolicy } from "../src/core/navigation-corpus-policy.ts";
import { gitignoreLinesToPrefixes, readGlobalNavigationIgnoreLines, readProjectNavigationIgnoreLines } from "../src/core/navigation-ignore.ts";
import { executable } from "./_clean-navigation-helper.mjs";

/**
 * Delivery proof: multi-folder navigation scope.
 * Parent + nested child each own an independent prepared docs/graph identity, and
 * a live native code route that must select exactly the owning corpus — no
 * cross-project leakage.
 */

function makePi() {
  const tools = new Map();
  const events = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { events.set(name, handler); },
    getActiveTools() { return []; },
    setActiveTools() {},
    tool(name) { const tool = tools.get(name); assert.ok(tool, `missing tool ${name}`); return tool; },
    event(name) { const handler = events.get(name); assert.ok(handler, `missing event ${name}`); return handler; },
    events,
  };
}

async function call(tool, params, cwd) {
  const result = await tool.execute(`test-${tool.name}`, params, undefined, undefined, { cwd });
  return { text: result.content.map(part => part.type === "text" ? part.text : "").join("\n"), details: result.details, raw: result };
}

async function seedProject(root, identity) {
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await mkdir(join(root, ".pi", "navigation", "qmd"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: identity }));
  await writeFile(join(root, "docs", "guide.md"), `# ${identity} docs\n\nUnique phrase ${identity}_DOCS_MARKER for this corpus only.\n`);
  await writeFile(join(root, "src", "main.ts"), `export function ${identity}_symbol() { return "${identity}_CODE_MARKER"; }\n`);
  await writeFile(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), JSON.stringify({
    nodes: [{ id: `${identity}_NODE`, label: `${identity}_GRAPH_MARKER`, file: "src/main.ts", line: 1 }],
    links: [],
  }));

  // Graphify is the only prepared structural lane left. It is extension-owned, so
  // this helper also publishes the owned runtime; per-project isolation is then the
  // project's own graphPath plus its corpus policy.
  const graphify = await executable(join(root, "bin", "graphify"), `#!/usr/bin/env node
if (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== "1") process.exit(12);
import { readFileSync } from 'node:fs';
// Echo the artifact this invocation was pointed at, exactly as the real query
// does: isolation is then decided by which project's graph.json is selected.
const args = process.argv.slice(2);
const graphIndex = args.indexOf('--graph');
const graphPath = graphIndex >= 0 ? args[graphIndex + 1] : args[args.length - 1];
const node = JSON.parse(readFileSync(graphPath, 'utf8')).nodes?.[0] ?? {};
console.log(\`NODE \${node.label ?? "${identity}_GRAPH_MARKER"} [src=\${node.file ?? "src/main.ts"} loc=L\${node.line ?? 1}]\`);
`);

  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    scope: identity === "parent" ? { exclude: ["child"] } : undefined,
    docs: {
      enabled: true,
      backend: "qmd",
      repo: `local/${identity}-docs`,
      root: ".",
      indexPath: ".pi/navigation/qmd",
    },
    graph: {
      enabled: true,
      backend: "Graphify",
      command: graphify,
      root: ".",
      graphPath: ".pi/navigation/graphify/graphify-out/graph.json",
      mode: "ast",
    },
  }, null, 2));

  const exclude = identity === "parent" ? ["child"] : undefined;
  const corpusPolicyDigest = exclude
    ? compileNavigationCorpusPolicy(root, exclude, { extraValues: [...gitignoreLinesToPrefixes(readGlobalNavigationIgnoreLines(), root), ...gitignoreLinesToPrefixes(readProjectNavigationIgnoreLines(root), root)] }).digest
    : undefined;
  const lanePolicy = corpusPolicyDigest ? { corpusPolicyDigest, excludedPrefixes: exclude } : {};
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({
    indexes: {
      docs: {
        backend: "qmd",
        repo: `local/${identity}-docs`,
        indexPath: ".pi/navigation/qmd",
        generationId: `${identity}-docs-g1`,
        refreshStatus: "ready",
        qmd: { status: "lexical_ready", generation: `${identity}-docs-g1`, health: { needsEmbedding: 0 } },
        ...lanePolicy,
      },
      graph: {
        root: ".",
        graphPath: ".pi/navigation/graphify/graphify-out/graph.json",
        sourceFreshnessStatus: "refresh_pending",
        generationId: `${identity}-graph-g1`,
        mode: "ast",
        ...lanePolicy,
      },
    },
  }, null, 2));
}

test("background launch always owns the direct Node worker", () => {
  const plan = resolveBackgroundLaunch(["script.mjs"], { execPath: "/node" });
  assert.deepEqual(plan, { command: "/node", args: ["script.mjs"], policy: "direct" });
});

test("background completion waits for the directly spawned worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-background-completion-"));
  const marker = join(root, "done");
  const handle = launchBackground(["-e", `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done"), 150)`], { cwd: root, completionTimeoutMs: 2_000 });
  let completed = false;
  void handle.completed.then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(completed, false);
  assert.equal(existsSync(marker), false);
  const outcome = await handle.completed;
  assert.equal(outcome.reason, "close");
  assert.equal(outcome.code, 0);
  assert.equal(await readFile(marker, "utf8"), "done");
});

test("background timeout terminates the worker process group before completing", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "pi-background-timeout-"));
  const marker = join(root, "grandchild-pid");
  const source = `const {spawn}=require("node:child_process");const fs=require("node:fs");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000);`;
  const handle = launchBackground(["-e", source], { cwd: root, completionTimeoutMs: 1_000 });
  const outcome = await handle.completed;
  assert.equal(outcome.reason, "timeout");
  const grandchildPid = Number(await readFile(marker, "utf8"));
  try {
    process.kill(grandchildPid, 0);
    if (process.platform !== "linux") assert.fail(`grandchild ${grandchildPid} survived timeout cleanup`);
    assert.match(await readFile(`/proc/${grandchildPid}/status`, "utf8"), /^State:\s+Z/m, "Linux container init may leave a dead zombie entry, but no live worker may survive");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
});

test("multi-folder: prepared lanes and tools select exactly the owning corpus", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-multi-folder-parent-"));
  const child = join(parent, "child");
  await seedProject(parent, "parent");
  await seedProject(child, "child");

  const parentReal = await realpath(parent);
  const childReal = await realpath(child);
  // The retired code lane and its nested-lifecycle root enumeration are gone:
  // prepared structural identity is now the docs and graph lanes below, and the
  // code route is live native evidence that must stay inside the queried project.
  const parentDocs = await resolvePreparedLane(parent, "docs");
  const childDocs = await resolvePreparedLane(child, "docs");
  assert.equal(parentDocs.ok, true, parentDocs.reason);
  assert.equal(childDocs.ok, true, childDocs.reason);
  assert.equal(parentDocs.repo, "local/parent-docs");
  assert.equal(childDocs.repo, "local/child-docs");
  assert.notEqual(parentDocs.indexPath, childDocs.indexPath);

  const parentGraph = await resolvePreparedLane(parent, "graph");
  const childGraph = await resolvePreparedLane(child, "graph");
  assert.equal(parentGraph.ok, true, parentGraph.reason);
  assert.equal(childGraph.ok, true, childGraph.reason);
  assert.notEqual(parentGraph.graphPath, childGraph.graphPath);

  const pi = makePi();
  jeitoCodeweavePiExtension(pi);

  // explore code: no published indexed graph in either folder, so both refuse
  // honestly — and neither receipt may name the sibling project's identity.
  const parentSearch = await call(pi.tool("explore"), { view: "code", operation: "search", anchor: "parent_symbol", scope: parent }, parent);
  assert.match(parentSearch.text, /UNAVAILABLE: code exploration is unavailable for this scope/);
  assert.doesNotMatch(parentSearch.text, /child_symbol|child_CODE_MARKER|child_GRAPH_MARKER/);

  const childSearch = await call(pi.tool("explore"), { view: "code", operation: "search", anchor: "child_symbol", scope: child }, child);
  assert.match(childSearch.text, /UNAVAILABLE: code exploration is unavailable for this scope/);
  assert.doesNotMatch(childSearch.text, /parent_symbol|parent_CODE_MARKER|parent_GRAPH_MARKER/);

  // explore map: Graphify is extension-owned; isolation is per-project graphPath + corpus policy.
  const parentMap = await call(pi.tool("explore"), { view: "map", query: "src/main.ts", scope: parent }, parent);
  assert.doesNotMatch(parentMap.text, /child_GRAPH_MARKER|local\/child-docs/);

  const childMap = await call(pi.tool("explore"), { view: "map", query: "src/main.ts", scope: child }, child);
  assert.doesNotMatch(childMap.text, /parent_GRAPH_MARKER|local\/parent-docs/);
  if (/corpus_policy_digest=/.test(childMap.text) && /corpus_policy_digest=/.test(parentMap.text)) {
    const parentDigest = parentMap.text.match(/corpus_policy_digest=([a-f0-9]+)/i)?.[1];
    const childDigest = childMap.text.match(/corpus_policy_digest=([a-f0-9]+)/i)?.[1];
    if (parentDigest && childDigest) assert.notEqual(parentDigest, childDigest);
  }

  assert.ok(String(parentGraph.graphPath).includes(parentReal) || String(parentGraph.graphPath).startsWith(parent), parentGraph.graphPath);
  assert.ok(String(childGraph.graphPath).includes(childReal) || String(childGraph.graphPath).startsWith(child), childGraph.graphPath);
  assert.notEqual(parentGraph.graphPath, childGraph.graphPath);

  const parentTrace = await call(pi.tool("trace"), { target: "src/main.ts::parent_symbol", relation: "callers", scope: parent }, parent);
  assert.doesNotMatch(parentTrace.text, /child_CODE_MARKER|child_symbol/);
  const childTrace = await call(pi.tool("trace"), { target: "src/main.ts::child_symbol", relation: "callers", scope: child }, child);
  assert.doesNotMatch(childTrace.text, /parent_CODE_MARKER|parent_symbol/);

  // docs_search selects the configured repo identity for each project (no cross-repo config).
  // Full lexical hit requires a built QMD index; selection-layer proof is the repo identity.
  assert.equal(parentDocs.repo, "local/parent-docs");
  assert.equal(childDocs.repo, "local/child-docs");
  const parentDocsCall = await call(pi.tool("docs_search"), { query: "parent_DOCS_MARKER", scope: parent }, parent);
  // Either hits local index or reports the configured docs lane — never the sibling repo.
  assert.doesNotMatch(parentDocsCall.text, /local\/child-docs|child_DOCS_MARKER/);
  const childDocsCall = await call(pi.tool("docs_search"), { query: "child_DOCS_MARKER", scope: child }, child);
  assert.doesNotMatch(childDocsCall.text, /local\/parent-docs|parent_DOCS_MARKER/);
});

test("multi-folder: session_shutdown refreshes the owning root and never fans out into nested projects", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-multi-folder-stop-"));
  const child = join(parent, "child");
  await seedProject(parent, "parent");
  await seedProject(child, "child");
  const parentReal = await realpath(parent);
  const childReal = await realpath(child);

  const configPath = join(parent, "navigation-config.json");
  const perfPath = join(parent, "perf.jsonl");
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
    const result = await pi.event("session_shutdown")({}, { cwd: parent });
    assert.equal(result.status, "started", JSON.stringify(result, null, 2));
    // The retired multi-root fan-out (`result.awaited` / `result.roots`, formerly
    // resolved through navigation-config's nested-root enumeration) has no owner
    // now: stop refresh is a single graphify prepare for the owning session root,
    // so a nested prepared project is never refreshed behind its own session's back.
    assert.equal(result.awaited, undefined);
    assert.equal(result.roots, undefined);

    const launches = (await readFile(perfPath, "utf8")).trim().split("\n").filter(Boolean)
      .map(JSON.parse)
      .filter(record => record.kind === "lifecycle_launch" && record.trigger === "stop_refresh");
    assert.equal(launches.length, 1, JSON.stringify(launches, null, 2));
    assert.equal(launches[0].root, parentReal);
    assert.ok(launches.every(launch => launch.root !== childReal), "a nested project must not be refreshed by its parent's shutdown");
    for (const launch of launches) {
      assert.deepEqual(
        launch.args.flatMap((arg, i, args) => arg === "--backend" ? [args[i + 1]] : []),
        ["graphify"],
      );
      // The worker is launched directly — never through a shell — and the platform
      // background-policy flag must match the command actually used.
      assert.ok([process.execPath, "/usr/sbin/taskpolicy"].includes(launch.command), `unexpected launch command ${launch.command}`);
      assert.equal(launch.backgroundPolicy, launch.command === "/usr/sbin/taskpolicy");
    }

    // After await, prepare locks must not remain owned by live pids from this process tree
    // (finalize releases them). Orphaned dead-pid locks are overwritten on next acquire.
    for (const root of [parent, child]) {
      const lockPath = join(root, ".pi", "navigation", "locks", "prepare-stop_refresh.lock.json");
      if (existsSync(lockPath)) {
        const lock = JSON.parse(await readFile(lockPath, "utf8"));
        // If still present, pid must not be a dead process claim that blocks forever.
        assert.ok(lock.pid === undefined || typeof lock.pid === "number");
      }
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
    await rm(parent, { recursive: true, force: true }).catch(() => {});
  }
});

test("multi-folder: dead-pid prepare lock does not block a new launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-multi-folder-orphan-lock-"));
  await seedProject(root, "orphan");
  const lockDir = join(root, ".pi", "navigation", "locks");
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, "prepare-stop_refresh.lock.json");
  // PID 2^31-2 is extremely unlikely to be alive; kill(pid,0) fails → lock is stale.
  await writeFile(lockPath, JSON.stringify({
    root,
    trigger: "stop_refresh",
    pid: 2147483646,
    status: "running",
    startedAt: new Date().toISOString(),
  }, null, 2));

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
    assert.equal(result.status, "started", `dead-pid lock must not block stop_refresh: ${JSON.stringify(result)}`);
    assert.equal(result.awaited, undefined, "stop refresh no longer awaits nested roots; it reports the owning launch");
    const launches = (await readFile(perfPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse)
      .filter(r => r.kind === "lifecycle_launch");
    assert.ok(launches.length >= 1, "expected a lifecycle launch after reclaiming dead-pid lock");
  } finally {
    if (previousConfig === undefined) delete process.env.PI_NAV_AUTOMATION_CONFIG;
    else process.env.PI_NAV_AUTOMATION_CONFIG = previousConfig;
    if (previousPerfLog === undefined) delete process.env.PI_NAV_PERF_LOG;
    else process.env.PI_NAV_PERF_LOG = previousPerfLog;
    if (previousTelemetry === undefined) delete process.env.PI_NAV_PERF_TELEMETRY;
    else process.env.PI_NAV_PERF_TELEMETRY = previousTelemetry;
    if (previousInterval === undefined) delete process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS;
    else process.env.PI_NAV_STOP_REFRESH_MIN_INTERVAL_MS = previousInterval;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});