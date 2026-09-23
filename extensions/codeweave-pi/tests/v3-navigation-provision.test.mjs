import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import jeitoCodeweavePiExtension from "../index.ts";
import { envForNavigationBackend } from "../src/core/navigation-automation-config.ts";
import * as ownedRuntime from "../src/core/owned-runtime.ts";
import { provisionNavigationRuntime, resolveCompatiblePython } from "../scripts/navigation-provision.mjs";

const fixture = () => mkdtemp(join(tmpdir(), "pi-nav-runtime-"));

async function fakePython(root) {
  const command = join(root, "python3");
  const script = `#!${process.execPath}
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (process.env.FAKE_PYTHON_LOG) appendFileSync(process.env.FAKE_PYTHON_LOG, JSON.stringify(args) + "\\n");
if (args.some(arg => /code_review_graph|code-review-graph|native\\/crg/.test(arg))) {
  console.error("fake python refuses retired CRG provisioning requests");
  process.exit(6);
}
if (args[0] === "-c" && args[1].includes("sys.version_info")) {
  const version = process.env.FAKE_PYTHON_VERSION || "3.14.5";
  console.log(JSON.stringify({ version, minor: version.split(".").slice(0, 2).join("."), cacheTag: "cpython-314" }));
} else if (args[0] === "-m" && args[1] === "venv") {
  if (!args.includes("--help")) {
    const bin = join(args.at(-1), "bin");
    mkdirSync(bin, { recursive: true });
    copyFileSync(process.argv[1], join(bin, "python"));
    chmodSync(join(bin, "python"), 0o755);
  }
} else if (args[0] === "-m" && args[1] === "pip") {
  if (process.env.FAKE_FAIL_PIP === "1") process.exit(9);
  writeFileSync(join(dirname(process.argv[1]), "graphify"), "#!${process.execPath}\\nprocess.exit(0);\\n", { mode: 0o755 });
} else if (args[0] === "-c") {
  if (process.env.FAKE_FAIL_VERIFY === "1") process.exit(8);
  if (args[1].includes("m.version('graphifyy')")) console.log("0.9.23");
}
`;
  await writeFile(command, script, { mode: 0o755 });
  await chmod(command, 0o755);
  return command;
}

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    registerTool() {},
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, handler); },
    getActiveTools() { return []; },
    setActiveTools() {},
    handler(name) { return handlers.get(name); },
    command(name) { return commands.get(name); },
  };
}

function provisionEnv(root, python, extra = {}) {
  return { ...process.env, HOME: root, PI_NAV_PYTHON: python, FAKE_PYTHON_LOG: join(root, "python.jsonl"), ...extra };
}

test("one extension-local runtime becomes visible only after the owned Graphify CLI exists", async t => {
  assert.equal(typeof ownedRuntime.setExtensionRuntimeRootForTests, "function");
  const root = join(await fixture(), ".runtime");
  ownedRuntime.setExtensionRuntimeRootForTests(root);
  t.after(() => ownedRuntime.setExtensionRuntimeRootForTests());
  const paths = ownedRuntime.extensionRuntimePaths();
  assert.deepEqual(Object.keys(paths).sort(), ["graphify", "python", "ready", "root"], "the owned runtime must expose no retired CRG path");
  await mkdir(dirname(paths.python), { recursive: true });
  for (const file of [paths.python, paths.graphify]) await writeFile(file, "");
  assert.equal(ownedRuntime.ownedRuntimeReady(), false);
  await writeFile(paths.ready, "ready\n");
  assert.equal(ownedRuntime.ownedRuntimeReady(), true);
  assert.equal(ownedRuntime.ownedBackendRuntime("graphify")?.root, root);
});

test("provisioning uses one normal pip invocation and writes the readiness sentinel", async () => {
  const root = await fixture();
  const python = await fakePython(root);
  const result = await provisionNavigationRuntime({ extensionRoot: root, env: provisionEnv(root, python) });
  const calls = (await readFile(join(root, "python.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const pip = calls.filter(args => args[0] === "-m" && args[1] === "pip");
  assert.equal(pip.length, 1);
  assert.deepEqual(pip[0].slice(pip[0].indexOf("install") + 1), ["graphifyy[openai]==0.9.23"], "Graphify must be the only installed requirement");
  assert.equal(pip[0].some(arg => /require-hashes|only-binary|find-links/.test(arg)), false);
  assert.equal(existsSync(join(root, ".runtime", "bin", "graphify")), true);
  assert.equal(existsSync(join(root, ".runtime", "bin", "code-review-graph")), false, "provisioning must not create a CRG executable");
  assert.equal(await readFile(join(root, ".runtime", ".ready"), "utf8"), "graphifyy=0.9.23\n");
  assert.equal(result.root, join(root, ".runtime"));
});

test("failed package installation never publishes readiness", async () => {
  const root = await fixture();
  const python = await fakePython(root);
  await assert.rejects(provisionNavigationRuntime({ extensionRoot: root, env: provisionEnv(root, python, { FAKE_FAIL_PIP: "1" }) }), /(?:pip install|locked dependencies) failed/);
  assert.equal(existsSync(join(root, ".runtime", ".ready")), false);
});

test("missing-runtime session start and navigation-setup never launch the installer", async t => {
  const root = await fixture();
  const python = await fakePython(root);
  const old = Object.fromEntries(["HOME", "PI_NAV_PYTHON", "FAKE_PYTHON_LOG"].map(name => [name, process.env[name]]));
  Object.assign(process.env, provisionEnv(root, python));
  if (ownedRuntime.setExtensionRuntimeRootForTests) ownedRuntime.setExtensionRuntimeRootForTests(join(root, "missing-runtime"));
  t.after(() => {
    ownedRuntime.setExtensionRuntimeRootForTests?.();
    for (const [name, value] of Object.entries(old)) value === undefined ? delete process.env[name] : process.env[name] = value;
  });
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const started = await pi.handler("session_start")({}, { cwd: root, ui: { notify() {} } });
  assert.equal(started.status, "suppressed", "an unselected optional Python runtime must not block the lean default");
  assert.equal(existsSync(join(root, "python.jsonl")), false);
  const setup = await pi.command("navigation-setup").handler("", { ui: { notify() {} } });
  assert.match(setup.command, /npm run nav:provision/);
  assert.match(setup.qmdVerification, /qmd:model-provision -- --verify-only/);
  assert.match(setup.legacyCommand, /npm run nav:provision:legacy$/);
  assert.equal(setup.status, "runtime-unavailable", "presence of a Python fixture cannot certify Core assets");
  assert.equal(existsSync(join(root, "python.jsonl")), false);
});

test("backend child environments redact unrelated secrets", () => {
  const loaded = { exists: true, config: { providers: { allowCloud: true, allowEmbeddings: true } }, diagnostics: [], providerEnv: { OPENAI_API_KEY: "configured-openai" } };
  const child = envForNavigationBackend("graphify", loaded, { PATH: "/bin", UNRELATED_API_KEY: "must-not-leak", OPENAI_API_KEY: "shell-openai" });
  assert.equal(child.UNRELATED_API_KEY, undefined);
  assert.equal(child.OPENAI_API_KEY, "configured-openai");
});

test("Python discovery accepts 3.14 and rejects an explicit unsupported interpreter", async () => {
  const root = await fixture();
  const python = await fakePython(root);
  assert.equal(resolveCompatiblePython({ ...process.env, PI_NAV_PYTHON: python }).minor, "3.14");
  assert.throws(() => resolveCompatiblePython({ ...process.env, PI_NAV_PYTHON: python, FAKE_PYTHON_VERSION: "3.9.19" }), /3\.10.*3\.14/);
});

test("ready and missing runtime session-start checks stay below 100 ms p95", async t => {
  const root = await fixture();
  const config = join(root, "automation.json");
  await writeFile(config, JSON.stringify({ automation: { mode: "disabled" } }));
  const oldConfig = process.env.PI_NAV_AUTOMATION_CONFIG;
  process.env.PI_NAV_AUTOMATION_CONFIG = config;
  t.after(() => {
    ownedRuntime.setExtensionRuntimeRootForTests();
    oldConfig === undefined ? delete process.env.PI_NAV_AUTOMATION_CONFIG : process.env.PI_NAV_AUTOMATION_CONFIG = oldConfig;
  });
  const measure = async runtime => {
    ownedRuntime.setExtensionRuntimeRootForTests(runtime);
    const durations = [];
    for (let count = 0; count < 20; count++) {
      const pi = makePi();
      jeitoCodeweavePiExtension(pi);
      const started = performance.now();
      await pi.handler("session_start")({}, { cwd: root, ui: { notify() {} } });
      durations.push(performance.now() - started);
    }
    return durations.sort((a, b) => a - b)[18];
  };
  const missingP95 = await measure(join(root, "missing"));
  const ready = join(root, "ready-runtime");
  ownedRuntime.setExtensionRuntimeRootForTests(ready);
  const paths = ownedRuntime.extensionRuntimePaths();
  await mkdir(dirname(paths.python), { recursive: true });
  for (const file of [paths.python, paths.graphify, paths.ready]) await writeFile(file, "ready\n");
  const readyP95 = await measure(ready);
  assert.ok(missingP95 < 100, `missing runtime p95 ${missingP95.toFixed(1)}ms`);
  assert.ok(readyP95 < 100, `ready runtime p95 ${readyP95.toFixed(1)}ms`);
});
