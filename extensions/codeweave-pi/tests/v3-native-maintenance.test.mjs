import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

import { updateNativeEvidence, runCapturedAnalysis, prepareAnalysisProject } from "../src/core/native-maintenance.ts";
import { callPiNav, piNavArtifactPaths, resolvePiNavTarget } from "../src/core/pi-nav-native.ts";

const extensionRoot = fileURLToPath(new URL("../", import.meta.url));
const executable = process.env.PI_NAV_TEST_CLI ?? piNavArtifactPaths(extensionRoot, resolvePiNavTarget()).cli;

test("native maintenance protocol keeps Unicode roots, aborts without publication and leaves live N-API usable", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pi-native-maintenance-")));
  let db;
  t.after(async () => { db?.close(); await rm(base, { recursive: true, force: true }); });
  const root = join(base, "project-é");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.rs"), "pub fn Kept() {}\n");
  const request = {
    root, database: join(base, "cache", "evidence.sqlite"), maxEntries: 100,
    maxBytes: 1_000_000, timeoutMs: 30_000, policyFiles: [],
  };
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(updateNativeEvidence(request, cancelled.signal, executable), { name: "AbortError" });
  const first = await updateNativeEvidence(request, new AbortController().signal, executable);
  assert.equal(first.root, root);
  assert.equal(first.generation, 1);
  assert.equal(first.files, 1);
  assert.deepEqual(first.watchDirectories, ["", "src"]);

  db = new Database(request.database);
  db.exec("BEGIN IMMEDIATE");
  const controller = new AbortController();
  const maintenance = updateNativeEvidence(request, controller.signal, executable);
  const aborted = assert.rejects(maintenance, { name: "AbortError" });
  const live = callPiNav({ root, operation: "pi_nav_search", args: { query: "Kept", kind: "symbol", scope: root, expand: 0 }, timeoutMs: 5000 });
  controller.abort();
  try {
    const [, output] = await Promise.all([aborted, live]);
    assert.match(output.text, /Kept/);
    assert.equal(db.prepare("SELECT generation FROM metadata").pluck().get(), 1);
  } finally {
    db.exec("ROLLBACK");
  }
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
});

test("captured maintenance validates child-selected and caller-pinned base generations", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "analysis-receipt-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = join(root, "receipt-worker.mjs");
  await writeFile(worker, `let input = ''; process.stdin.on('data', chunk => {
    input += chunk; if (!input.endsWith('\\n')) return;
    const request = JSON.parse(input);
    console.log(JSON.stringify({root: request.root, corpus: 'explicit-capture', ...JSON.parse(request.files[0].text)}));
    process.exit(0);
  });`);
  for (const [baseGeneration, response, error] of [
    [3, {baseGeneration: 3, generation: 4, status: 'published'}],
    [3, {baseGeneration: 4, generation: 4, status: 'published'}, /base generation/],
    [undefined, {baseGeneration: 6, generation: 7, status: 'published'}],
    [undefined, {generation: 7, status: 'published'}, /base generation/],
    [undefined, {baseGeneration: 6, generation: 6, status: 'unchanged'}],
    [undefined, {baseGeneration: Number.MAX_SAFE_INTEGER, generation: Number.MAX_SAFE_INTEGER, status: 'unchanged'}, /base generation/],
    [undefined, {baseGeneration: 6, generation: 8, status: 'published'}, /mismatched publication/],
  ]) {
    const result = runCapturedAnalysis({ root, database: join(root, 'unused.sqlite'), baseGeneration,
      files: [{path: 'fixture.ts', text: JSON.stringify(response), language: 'typescript'}], timeoutMs: 5_000 }, new AbortController().signal, worker);
    if (error) await assert.rejects(result, error);
    else assert.equal((await result).generation, response.generation);
  }
});

test("semantic completion refuses a missing store before initialization or model use", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "semantic-missing-store-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'), directory = join(base, 'store'), modelDirectory = join(base, 'empty-model');
  await mkdir(root); await mkdir(modelDirectory);
  await writeFile(join(root, 'package.json'), '{"private":true}\n');
  await writeFile(join(root, 'owner.ts'), 'export function Owner() {}\n');
  await assert.rejects(prepareAnalysisProject({ root, directory, phase: 'semantic', modelDirectory,
    files: [{ path: 'owner.ts', language: 'typescript' }] }, new AbortController().signal), /store directory is missing/);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
