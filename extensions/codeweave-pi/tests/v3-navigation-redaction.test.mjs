import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { prepareNavigation } from "../scripts/navigation-prepare.mjs";
import { summarizeNavigationAudit } from "../scripts/navigation-audit.mjs";
import { redactJson, redactText, scanTextForSecrets } from "../src/core/redaction.ts";
import { extensionRuntimePaths, setExtensionRuntimeRootForTests } from "../src/core/owned-runtime.ts";

const NODE = process.execPath;
const FAKE_ENV_SECRET = ["redact", "env", "value", "123456789"].join("-");
const FAKE_BEARER = ["bearer", "value", "123456789abcdef"].join("-");
const FAKE_ASSIGNMENT = ["assign", "value", "123456789"].join("-");

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-redaction-"));
}

async function touch(file, content = "x") {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function writeExecutable(file, content) {
  await touch(file, content);
  await chmod(file, 0o755);
  return file;
}

async function fakeGraphify(bin) {
  await mkdir(bin, { recursive: true });
  return writeExecutable(join(bin, "graphify"), `#!${NODE}\nimport { existsSync, mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nif (args[0] === 'update' || args[0] === 'extract') {\n  mkdirSync(join(args[1], 'graphify-out'), { recursive: true });\n  writeFileSync(join(args[1], 'graphify-out', 'graph.json'), JSON.stringify({ nodes: ['A'], links: [{ source: 'A', target: 'B', confidence: 'INFERRED' }] }));\n  console.log('[graphify extract] semantic extraction on 1 files via deepseek token=' + process.env.PI_NAV_TEST_TOKEN);\n} else if (args[0] === 'query') {\n  const graph = args[args.indexOf('--graph') + 1];\n  if (!existsSync(graph)) process.exit(3);\n  console.log('query Authorization: Bearer ${FAKE_BEARER}');\n} else {\n  process.exit(4);\n}\n`);
}

test("redaction replaces env values, bearer tokens, and assignments without reporting raw values", () => {
  const text = `env ${FAKE_ENV_SECRET} header Bearer ${FAKE_BEARER} api_token=${FAKE_ASSIGNMENT}`;
  const redacted = redactText(text, { env: { PI_NAV_TEST_TOKEN: FAKE_ENV_SECRET } });

  assert.equal(redacted.includes(FAKE_ENV_SECRET), false);
  assert.equal(redacted.includes(FAKE_BEARER), false);
  assert.equal(redacted.includes(FAKE_ASSIGNMENT), false);
  assert.match(redacted, /PI_NAV_TEST_TOKEN/);
  assert.match(redacted, /Bearer \[REDACTED/);
  assert.match(redacted, /api_token=\[REDACTED/);
  assert.deepEqual(scanTextForSecrets(redacted, { env: { PI_NAV_TEST_TOKEN: FAKE_ENV_SECRET } }), []);

  const object = redactJson({ stdout: text, nested: [text] }, { env: { PI_NAV_TEST_TOKEN: FAKE_ENV_SECRET } });
  assert.equal(JSON.stringify(object).includes(FAKE_ENV_SECRET), false);
});

test("redaction ignores exact shell path env names without ignoring password abbreviations", () => {
  const cwd = "/Users/example/jeito-codeweave-pi";
  const dbPwd = "database-password-value-123456789";

  assert.deepEqual(scanTextForSecrets(`cwd ${cwd}`, { env: { PWD: cwd, OLDPWD: cwd } }), []);

  const findings = scanTextForSecrets(`db ${dbPwd}`, { env: { DB_PWD: dbPwd } });
  assert.equal(findings.some(item => item.kind === "env_value" && item.name === "DB_PWD"), true);
});

test("navigation prepare redacts third-party CLI output before writing audit records", async t => {
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await touch(join(root, "src", "main.ts"), "export const value = 1;\n");
  const runtime = join(root, ".runtime");
  setExtensionRuntimeRootForTests(runtime);
  t.after(() => setExtensionRuntimeRootForTests());
  const paths = extensionRuntimePaths();
  await fakeGraphify(dirname(paths.graphify));
  await touch(paths.python);
  await writeFile(paths.ready, "ready\n");

  const env = { PATH: process.env.PATH ?? "", PI_NAV_TEST_RUNTIME_ROOT: runtime, PI_NAV_TEST_TOKEN: FAKE_ENV_SECRET, DEEPSEEK_API_KEY: "test-key" };
  const result = await prepareNavigation(["--path", root, "--auto", "--backend", "graphify", "--query", "router"], { env });

  assert.ok(["success", "warning"].includes(result.status), JSON.stringify(result));
  const logPath = join(root, ".pi", "navigation-setup.log.jsonl");
  assert.equal(existsSync(logPath), true);
  const log = await readFile(logPath, "utf8");
  assert.equal(log.includes(FAKE_ENV_SECRET), false);
  assert.equal(log.includes(FAKE_BEARER), false);
  assert.match(log, /\[REDACTED/);
  assert.equal(scanTextForSecrets(log, { env }).length, 0);
});

test("navigation audit fails unsafe evidence when legacy logs contain unredacted findings", async () => {
  const root = await fixture();
  await mkdir(join(root, ".pi"), { recursive: true });
  const record = {
    time: "2026-06-18T12:00:00.000Z",
    backend: "graphify",
    lane: "graph",
    policy: "auto",
    status: "completed",
    command: ["graphify", "update"],
    writes: ["graphify-out/graph.json"],
    undo: ["disable graph"],
    verification: { passed: true, reason: "ok" },
    enabledLane: true,
    stdout: `raw ${FAKE_ENV_SECRET}`,
  };
  await writeFile(join(root, ".pi", "navigation-setup.log.jsonl"), `${JSON.stringify(record)}\n`);

  const result = await summarizeNavigationAudit(["--path", root], { env: { PI_NAV_TEST_TOKEN: FAKE_ENV_SECRET } });
  const rendered = JSON.stringify(result);

  assert.equal(result.status, "error");
  assert.equal(result.privacy_findings.some(item => item.kind === "env_value" && item.name === "PI_NAV_TEST_TOKEN"), true);
  assert.equal(rendered.includes(FAKE_ENV_SECRET), false);
  assert.ok(result.next_actions.some(action => /unsafe evidence/.test(action)));
  assert.ok(result.recovery.stop_conditions.includes("unredacted secret findings remain"));
});
