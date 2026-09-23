import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { prepareNavigation, renderText } from "../scripts/navigation-prepare.mjs";
import { inspectNavigation } from "../scripts/navigation-doctor.mjs";
import { GRAPHIFY_PIN } from "../src/core/backend-registry.ts";
import { FULL_STACK_NAVIGATION_AUTOMATION_CONFIG } from "../src/core/navigation-automation-config.ts";
import { extensionRuntimePaths, setExtensionRuntimeRootForTests } from "../src/core/owned-runtime.ts";

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-prepare-"));
}

async function touch(path, content = "x") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function fakeCodannaBin(root) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const file = join(bin, "codanna");
  const script = [
    "#!/usr/bin/env node",
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('codanna test'); process.exit(0); }",
    "if (args[0] === 'init') { mkdirSync('.codanna', { recursive: true }); writeFileSync('.codanna/settings.toml', 'fake'); console.log('init ok'); process.exit(0); }",
    "if (args[0] === 'index') { mkdirSync('.codanna', { recursive: true }); writeFileSync('.codanna/index-ready', 'ok'); console.log('index ok'); process.exit(0); }",
    "if (args[0] === 'retrieve') { console.log(JSON.stringify({ data: [{ symbol: { name: 'main', kind: 'Function', file_path: 'main.ts', range: { start_line: 1, end_line: 1 }, signature: 'function main()', language_id: 'typescript' } }] })); process.exit(0); }",
    "process.exit(2);",
    "",
  ].join("\n");
  await writeFile(file, script);
  await chmod(file, 0o755);
  return bin;
}

async function fakeBin(root, name) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const file = join(bin, name);
  await writeFile(file, "#!/usr/bin/env sh\nexit 0\n");
  await chmod(file, 0o755);
  return bin;
}
async function fakeGraphifyBin(root) {
  const runtime = join(root, ".runtime");
  setExtensionRuntimeRootForTests(runtime);
  const paths = extensionRuntimePaths();
  const bin = join(runtime, "bin");
  await mkdir(bin, { recursive: true });
  const file = paths.graphify;
  const script = [
    "#!/usr/bin/env node",
    "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'extract' || args[0] === 'update') {",
    "  const out = args[0] === 'update' && process.env.GRAPHIFY_OUT ? join(process.env.GRAPHIFY_OUT, '..') : (args.includes('--out') ? args[args.indexOf('--out') + 1] : (args[1] || process.cwd()));",
    "  mkdirSync(join(out, 'graphify-out'), { recursive: true });",
    "  writeFileSync(join(out, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: ['main'], links: [{ source: 'main', target: 'docs', confidence: args[0] === 'update' ? 'STRUCTURAL' : 'INFERRED' }] }));",
    "  writeFileSync(join(out, args[0] === 'update' ? '.graphify-update-args.json' : '.graphify-extract-args.json'), JSON.stringify(args));",
    "  console.log(args[0] === 'update' ? '[graphify update] local graph refreshed' : '[graphify extract] semantic extraction on 1 files via deepseek');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'query') {",
    "  const graph = args[args.indexOf('--graph') + 1];",
    "  if (!existsSync(graph)) { console.error('missing graph'); process.exit(2); }",
    "  console.log('NODE main [src=src/main.ts loc=L1]');",
    "  process.exit(0);",
    "}",
    "console.error('unknown graphify ' + args[0]);",
    "process.exit(2);",
    "",
  ].join("\n");
  await writeFile(file, script);
  await chmod(file, 0o755);
  // The owned runtime carries Graphify and the Python probe only: the retired
  // CRG executable is deliberately absent (see the retired-backend contract test).
  await writeFile(paths.python, "");
  await writeFile(paths.ready, "ready\n");
  return bin;
}

/** Pins the opt-in Graphify lane so these fixtures resolve provider availability
 * from their own policy instead of the developer's ~/.pi/agent/navigation.yaml. */
async function graphProviderEnv(root) {
  const automation = structuredClone(FULL_STACK_NAVIGATION_AUTOMATION_CONFIG);
  const path = join(root, "automation.json");
  await writeFile(path, JSON.stringify(automation));
  return { PI_NAV_AUTOMATION_CONFIG: path, DEEPSEEK_API_KEY: "set" };
}

async function fakeGraphifyPython(root) {
  const file = extensionRuntimePaths().python;
  await mkdir(join(file, ".."), { recursive: true });
  const script = [
    "#!/usr/bin/env node",
    "import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';",
    "import { createHash } from 'node:crypto';",
    "import { join } from 'node:path';",
    "const args = process.argv.slice(2);",
    "if (!args[0]?.endsWith('graphify-rich-update.py')) { console.error('unexpected python helper ' + args[0]); process.exit(11); }",
    "const graphOut = args[3];",
    "const graphDir = join(graphOut, 'graphify-out');",
    "mkdirSync(graphDir, { recursive: true });",
    "writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({ nodes: [{ source_file: 'src/main.ts' }], edges: [] }));",
    "const source = join(args[1], 'src/main.ts'); const hash = createHash('md5').update(readFileSync(source)).digest('hex'); const mtime = statSync(source).mtimeMs / 1000;",
    "writeFileSync(join(graphDir, 'manifest.json'), JSON.stringify({ 'src/main.ts': { mtime, ast_hash: hash, semantic_hash: hash } }));",
    "writeFileSync(join(graphDir, 'rich-args.json'), JSON.stringify({ argv: args }));",
    "const payload = { status: 'success', operation: 'rich_incremental', changed_total: 1, semantic_file_count: 0, code_file_count: 1, deleted_count: 0, input_tokens: 0, output_tokens: 0, duration_ms: 19, llm_richness: 'local_ast_only', nodes: 1, edges: 0, semantic_extraction_observed: false, report_path: join(graphDir, 'rich-update-report.json'), history_path: join(graphDir, 'rich-update-history.jsonl') };",
    "writeFileSync(payload.report_path, JSON.stringify(payload, null, 2));",
    "appendFileSync(payload.history_path, JSON.stringify(payload) + '\\n');",
    "console.log(JSON.stringify(payload));",
  ].join("\n");
  await writeFile(file, script);
  await chmod(file, 0o755);
  return file;
}





test("navigation prepare dry-run plans without writing audit log", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  const result = await prepareNavigation(["--path", root, "--backend", "graphify"], { env: { PATH: process.env.PATH } });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.dryRun, true);
  assert.equal(result.root, await realpath(root));
  assert.equal(result.plan.actions.length, 1);
  assert.equal(result.plan.actions[0].backend, "graphify");
  assert.equal(existsSync(join(root, ".pi", "navigation-setup.log.jsonl")), false);
});

test("navigation prepare rejects the obsolete Tilth backend without creating setup state", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  await assert.rejects(
    () => prepareNavigation(["--path", root, "--auto", "--backend", "tilth"], { env: { PATH: process.env.PATH } }),
    /unknown backend: tilth/i,
  );
  assert.equal(existsSync(join(root, ".pi", "navigation-setup.log.jsonl")), false);
});


test("navigation prepare auto skips rebuild for already-ready prepared lanes", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  await mkdir(join(root, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), JSON.stringify({ nodes: ["ready"], edges: [] }));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const graphify = join(bin, "graphify");
  const marker = join(root, "graphify-ran.txt");
  await writeFile(graphify, `#!/usr/bin/env sh\necho ran > ${JSON.stringify(marker)}\nexit 0\n`);
  await chmod(graphify, 0o755);
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    graph: { enabled: true, backend: "Graphify", command: graphify, graphPath: ".pi/navigation/graphify/graphify-out/graph.json", root: ".", mode: "deepExtract", provider: "deepseek", semanticExtractionObserved: true },
  }, null, 2));
  const statePath = join(root, ".pi", "navigation", "state.json");
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: process.env.HOME, ...(await graphProviderEnv(root)) };
  const desired = inspectNavigation(root, { env });
  await touch(statePath, JSON.stringify({
    indexes: { graph: { graphPath: ".pi/navigation/graphify/graphify-out/graph.json", root: ".", updatedAt: new Date().toISOString(), mode: "deepExtract", provider: "deepseek", semanticExtractionObserved: true, desiredStateHash: desired.desiredState.laneHashes.graph, rootIdentity: desired.desiredState.rootIdentity, generationId: "fixture-g1", lastProbeStatus: "ready", backendIdentity: { name: "graphify", version: GRAPHIFY_PIN, schemaVersion: "1" } } },
  }));
  assert.equal(inspectNavigation(root, { env }).lanes.find(lane => lane.name === "graph")?.status, "ready", JSON.stringify(inspectNavigation(root, { env }).lanes.find(lane => lane.name === "graph")));

  const result = await prepareNavigation(["--path", root, "--auto", "--backend", "graphify"], { env });

  assert.equal(result.status, "success", JSON.stringify(result, null, 2));
  assert.equal(result.execution.length, 1);
  assert.equal(result.execution[0].status, "already_ready");
  assert.equal(result.execution[0].enabledLane, true);
  assert.equal(existsSync(marker), false, "already-ready graph lane must not run Graphify/freshen again");
});

test("navigation prepare stop-refresh updates already-ready graph lanes instead of skipping", async t => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export function main() { return 1; }\n");
  const bin = await fakeGraphifyBin(root);
  t.after(() => setExtensionRuntimeRootForTests());
  await fakeGraphifyPython(root);
  await mkdir(join(root, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), JSON.stringify({ nodes: ["ready"], edges: [] }));
  await writeFile(join(root, ".pi", "navigation", "graphify", "graphify-out", "manifest.json"), JSON.stringify({ "src/main.ts": { mtime: 1, ast_hash: "old", semantic_hash: "old" } }));
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    graph: { enabled: true, backend: "Graphify", command: join(bin, "graphify"), graphPath: ".pi/navigation/graphify/graphify-out/graph.json", root: "src", mode: "deepExtract", provider: "deepseek", semanticExtractionObserved: true },
  }, null, 2));
  await touch(join(root, ".pi", "navigation", "state.json"), JSON.stringify({
    indexes: { graph: { graphPath: ".pi/navigation/graphify/graphify-out/graph.json", root: "src", updatedAt: "2026-01-01T00:00:00.000Z", mode: "deepExtract", provider: "deepseek", semanticExtractionObserved: true } },
  }));

  const result = await prepareNavigation(["--path", root, "--auto", "--backend", "graphify", "--trigger", "stop_refresh", "--full-stack"], { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, PI_NAV_TEST_RUNTIME_ROOT: join(root, ".runtime"), OPENAI_API_KEY: "test-key", ...(await graphProviderEnv(root)) } });

  assert.equal(result.status, "success", JSON.stringify(result, null, 2));
  assert.equal(result.execution.length, 1);
  assert.equal(result.execution[0].status, "completed", "stop_refresh should run the rich incremental command even when the lane is already ready");
  assert.equal(result.execution[0].mode, "richUpdate");
  const richReport = JSON.parse(await readFile(join(root, ".pi", "navigation", "graphify", "graphify-out", "rich-update-report.json"), "utf8"));
  assert.equal(richReport.llm_richness, "local_ast_only");
  assert.equal(richReport.duration_ms, 19);
  assert.equal(existsSync(join(root, ".pi", "navigation", "graphify", ".graphify-update-args.json")), false, "aggressive stop_refresh must not fall back to local update when richUpdate is planned");
});


test("navigation prepare auto graphify freshens config/state to doctor-ready lane", async t => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export function main() { return 1; }\n");
  const bin = await fakeGraphifyBin(root);
  t.after(() => setExtensionRuntimeRootForTests());
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, PI_NAV_TEST_RUNTIME_ROOT: join(root, ".runtime"), ...(await graphProviderEnv(root)) };
  const result = await prepareNavigation(["--path", root, "--auto", "--backend", "graphify"], { env });

  assert.equal(result.status, "success", JSON.stringify(result, null, 2));
  assert.equal(result.execution[0].status, "completed");
  assert.equal(existsSync(join(root, ".pi-navigation.json")), true);
  assert.equal(existsSync(join(root, ".pi", "navigation", "state.json")), true);
  const doctor = inspectNavigation(root, { env });
  const graph = doctor.lanes.find(lane => lane.name === "graph");
  assert.equal(graph?.status, "ready", JSON.stringify(graph));
});


test("navigation prepare CLI emits JSON dry-run output", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  const run = spawnSync(process.execPath, ["scripts/navigation-prepare.mjs", "--path", root, "--dry-run", "--backend", "graphify", "--json"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.mode, "dry-run");
  assert.equal(parsed.root, await realpath(root));
  assert.equal(parsed.plan.actions[0].backend, "graphify");
});

test("navigation prepare dry-run does not substitute project include for an explicit sibling path", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  const configuredScope = "agent/extensions/codeweave-pi";
  const requestedScope = "agent/extensions/time-context";
  await touch(join(root, configuredScope, "README.md"), "# Configured scope\n");
  await touch(join(root, requestedScope, "README.md"), "# Explicitly requested sibling scope\n");
  await touch(join(root, ".pi-navigation.json"), JSON.stringify({
    scope: { include: [configuredScope] },
  }));
  const result = await prepareNavigation(["--path", join(root, requestedScope), "--dry-run", "--backend", "qmd"], { env: { PATH: process.env.PATH ?? "" } });
  const action = result.plan.actions.find(item => item.backend === "qmd");
  assert.ok(action, JSON.stringify(result.plan.actions, null, 2));
  assert.equal(result.root, await realpath(root));
  assert.equal(result.plan.scopePlan.mode, "guided");
  assert.deepEqual(result.plan.scopePlan.selectedScopes, [requestedScope]);
  assert.match(result.plan.scopePlan.reason, /outside project scope override/);
  assert.equal(action.scope, requestedScope);
  assert.notEqual(action.policy, "blocked");
  assert.notEqual(action.command.indexOf("--scope"), -1, JSON.stringify(action.command));
  assert.equal(action.command[action.command.indexOf("--scope") + 1], requestedScope);
  assert.ok(!action.command.includes(configuredScope), JSON.stringify(action.command));
});




test("navigation prepare startup-safe leaves fresh Graphify unavailable instead of creating it", async t => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  const configPath = join(root, "automation.json");
  await touch(configPath, JSON.stringify({ providers: { allowCloud: true, allowLLM: true, defaultLLMProvider: "deepseek", openaiCompatible: { deepseek: { apiKeyEnv: "DEEPSEEK_API_KEY" } } }, storage: { allowVisibleProjectDirs: true, allowBackendNativeDirs: true } }));
  const bin = await fakeGraphifyBin(root);
  t.after(() => setExtensionRuntimeRootForTests());

  const result = await prepareNavigation(["--path", root, "--auto", "--startup-safe", "--full-stack", "--backend", "graphify", "--config", configPath], { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, PI_NAV_TEST_RUNTIME_ROOT: join(root, ".runtime"), DEEPSEEK_API_KEY: "set" } });

  assert.equal(result.status, "success");
  assert.equal(result.execution.length, 1);
  assert.equal(result.execution[0].backend, "graphify");
  assert.equal(result.execution[0].status, "skipped");
  assert.match(result.execution[0].verification.reason, /action was not automatic/);
  assert.equal(existsSync(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json")), false, "startup-safe prepare must not create a fresh Graphify graph");
});




test("navigation prepare rejects the retired CRG backend and never needs a retired runtime", async t => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "README.md"), "# Overview\n\nretired backend contract\n");
  await assert.rejects(
    () => prepareNavigation(["--path", root, "--auto", "--backend", "crg"], { env: { PATH: process.env.PATH ?? "" } }),
    error => /crg/i.test(error.message) && /unknown backend|retired/i.test(error.message),
  );
  assert.equal(existsSync(join(root, ".pi")), false, "a retired backend must be rejected before any setup state exists");

  const bin = await fakeGraphifyBin(root);
  t.after(() => setExtensionRuntimeRootForTests());
  const runtime = extensionRuntimePaths();
  assert.equal(existsSync(join(runtime.root, "bin", "code-review-graph")), false, "the owned runtime carries no retired CRG executable");
  const result = await prepareNavigation(["--path", root, "--dry-run", "--backend", "qmd"],
    { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, PI_NAV_TEST_RUNTIME_ROOT: runtime.root } });
  assert.equal(result.plan.actions.some(item => item.backend === "crg"), false);
  assert.equal(result.plan.actions[0].backend, "qmd", JSON.stringify(result.plan.actions, null, 2));
  assert.match(result.plan.actions[0].command.join(" "), /navigation-freshen\.mjs docs/);
});


test("navigation prepare never plans the retired CRG backend in a non-git folder without explicit project settings", async () => {
  const root = await fixture();
  await touch(join(root, "src", "main.ts"), "export function main() { return 1; }\n");
  const result = await prepareNavigation(["--path", root, "--dry-run", "--trigger", "session_start"], { env: { PATH: process.env.PATH ?? "" } });
  assert.deepEqual(result.plan.actions.filter(item => item.backend === "crg"), [], JSON.stringify(result.plan.actions, null, 2));
  assert.ok(result.plan.actions.every(item => ["qmd", "graphify"].includes(item.backend)),
    JSON.stringify(result.plan.actions.map(item => item.backend)));
  assert.equal(existsSync(join(root, ".pi", "navigation", "crg")), false);
});



test("navigation prepare startup-safe still records already-ready lanes without rebuilding", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  await mkdir(join(root, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), JSON.stringify({ nodes: ["ready"], edges: [] }));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const graphify = join(bin, "graphify");
  const marker = join(root, "graphify-ran-startup.txt");
  await writeFile(graphify, `#!/usr/bin/env sh\necho ran > ${JSON.stringify(marker)}\nexit 0\n`);
  await chmod(graphify, 0o755);
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, graphPath: ".pi/navigation/graphify/graphify-out/graph.json", root: ".", mode: "deepExtract", semanticExtractionObserved: true } }));
  const statePath = join(root, ".pi", "navigation", "state.json");
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: process.env.HOME, ...(await graphProviderEnv(root)) };
  const desired = inspectNavigation(root, { env });
  await touch(statePath, JSON.stringify({ indexes: { graph: { graphPath: ".pi/navigation/graphify/graphify-out/graph.json", root: ".", mode: "deepExtract", semanticExtractionObserved: true, updatedAt: new Date().toISOString(), desiredStateHash: desired.desiredState.laneHashes.graph, rootIdentity: desired.desiredState.rootIdentity, generationId: "fixture-g1", lastProbeStatus: "ready", backendIdentity: { name: "graphify", version: GRAPHIFY_PIN, schemaVersion: "1" } } } }));

  const result = await prepareNavigation(["--path", root, "--auto", "--startup-safe", "--backend", "graphify"], { env });

  assert.equal(result.execution[0].status, "already_ready");
  assert.equal(existsSync(marker), false, "startup-safe already-ready graph lane must not run Graphify/freshen again");
});


test("navigation prepare CLI text includes controlled setup confirmation prompt", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export {};\n");
  const run = spawnSync(process.execPath, ["scripts/navigation-prepare.mjs", "--path", root, "--dry-run", "--backend", "graphify"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Confirm navigation setup before anything is written/);
  assert.match(run.stdout, /Scope:/);
  assert.match(run.stdout, /Expected writes:/);
  assert.match(run.stdout, /Audit log: .*\.pi\/navigation-setup\.log\.jsonl/);
  assert.match(run.stdout, /Provider\/model\/network risk:/);
  assert.match(run.stdout, /Quality gates:/);
  assert.match(run.stdout, /Undo\/retry:/);
});

test("navigation prepare honors project scope and automation overrides", async () => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, ".pi-navigation.json"), JSON.stringify({
    scope: { include: ["packages/core"], exclude: ["fixtures/noisy"] },
    automation: { allowAutoPrepare: false },
  }));
  await touch(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await touch(join(root, "packages", "core", "package.json"), JSON.stringify({ name: "core" }));
  await touch(join(root, "packages", "core", "src", "main.ts"), "export {};\n");
  await touch(join(root, "packages", "api", "package.json"), JSON.stringify({ name: "api" }));
  await touch(join(root, "packages", "api", "src", "server.ts"), "export {};\n");
  const bin = await fakeBin(root, "graphify");
  const result = await prepareNavigation(["--path", root, "--dry-run", "--backend", "graphify", "--query", "Help me understand this repo"], { env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  assert.deepEqual(result.config.projectScope.include, ["packages/core"]);
  assert.deepEqual(result.config.projectScope.exclude, ["fixtures/noisy"]);
  assert.equal(result.config.allowAutoPrepare, false);
  assert.deepEqual(result.plan.scopePlan.selectedScopes, ["packages/core"]);
  assert.equal(result.plan.actions[0].policy, "guided");
  assert.ok(result.plan.actions[0].reasons.some(reason => /disables automatic prepare/.test(reason)));
});

test("package scripts expose nav:prepare", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["nav:prepare"], "node scripts/navigation-prepare.mjs");
});
