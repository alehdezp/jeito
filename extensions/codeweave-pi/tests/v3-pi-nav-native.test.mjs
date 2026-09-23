import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import {
  callPiNav,
  getPiNavSemanticInfo,
  assertPiNavGrepAvailable,
  PI_NAV_GREP_CAPABILITIES,
  piNavArtifactPaths,
  resolvePiNavTarget,
} from "../src/core/pi-nav-native.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const stateSymbol = Symbol.for(`jeito-codeweave-pi.pi-nav-native.v1:${root}`);

function resetState() {
  delete globalThis[stateSymbol];
}

function currentBuildInfo() {
  const target = resolvePiNavTarget();
  return {
    packageVersion: "0.9.0",
    addonApiVersion: 2,
    resultSchemaVersion: 1,
    target: target.rustTarget,
    capabilities: [
      "pi_nav_search", "pi_nav_files", "pi_nav_ls", "pi_nav_read", "pi_nav_diff",
      "pi_nav_deps", "pi_nav_grok", "pi_nav_map", "pi_nav_overview",
      "pi_nav_savings", "pi_nav_session", "pi_nav_symbol_range", "source_proof_v1", "grep_cursor_owner_v1",
      "matches_corpus_v1",
    ],
  };
}

async function scratch() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-nav-napi-"));
  await writeFile(
    path.join(directory, "sample.js"),
    "export function value() { return 1; }\nconsole.log(value());\n",
  );
  return directory;
}

async function call(rootPath, operation, args = {}, options = {}) {
  return callPiNav({ root: rootPath, operation, args, ...options });
}

test("Matches admission refuses an older addon before source dispatch", async t => {
  resetState();
  const directory = await realpath(await scratch());
  t.after(async () => { resetState(); await rm(directory, { recursive: true, force: true }); });
  const build = currentBuildInfo();
  build.capabilities = build.capabilities.filter(value => value !== "matches_corpus_v1");
  const calls = [];
  globalThis[stateSymbol] = { roots: new Map(), loadPromise: Promise.resolve({ target: resolvePiNavTarget(), addon: {
    getBuildInfo: () => build,
    PiNavSession: class { async call(operation, args) { calls.push({ operation, args }); return { text: "", structured: {
      schemaVersion: 1, operation, data: { mode: "matches" }, completeness: { complete: true }, diagnostics: [],
    } }; } },
  } }) };
  const args = { output: "matches", pattern: "needle", paths: [directory], matchesAdmission: { owners: [], directories: {}, explicitFiles: [] } };
  await assert.rejects(call(directory, "pi_nav_search", args), error => {
    assert.match(error.message, /\[pi-nav:incompatible_addon\].*Matches corpus admission is unavailable/);
    assert.match(error.message, /lacks matches_corpus_v1/);
    assert.match(error.message, /not a pattern or paths formatting error/);
    assert.match(error.message, /With approval, stop Pi/);
    assert.match(error.message, /No unrestricted fallback is allowed; no repair was attempted/);
    return true;
  });
  await assert.rejects(call(directory, "pi_nav_search", { cursor: "grep-old-page" }), /Matches corpus admission is unavailable/);
  assert.equal(calls.length, 0, "an ignored private policy must never reach a source reader");
  build.capabilities.push("matches_corpus_v1");
  await call(directory, "pi_nav_search", args);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.matchesAdmission, args.matchesAdmission);
  await assert.rejects(call(directory, "pi_nav_read", args), /\[pi-nav:invalid_argument\].*Matches admission/);
  assert.equal(calls.length, 1, "wrong-operation admission cannot reach any source reader even on a compatible addon");
});

test("Grep readiness rejects same-version missing capabilities without creating a source session", async t => {
  resetState();
  t.after(resetState);
  const build = currentBuildInfo();
  build.capabilities = [...new Set([...build.capabilities, ...PI_NAV_GREP_CAPABILITIES])];
  let sessions = 0;
  globalThis[stateSymbol] = { roots: new Map(), loadPromise: Promise.resolve({ target: resolvePiNavTarget(), addon: {
    getBuildInfo: () => build,
    PiNavSession: class { constructor() { sessions++; } },
  } }) };
  await assertPiNavGrepAvailable();
  for (const capability of ["matches_corpus_v1", "matches_render_v1", "grep_cursor_owner_v1", "ranked_corpus_v1", "ranked_focus_v1", "ranked_cursor_v1", "ranked_render_v1"]) {
    build.capabilities = build.capabilities.filter(value => value !== capability);
    await assert.rejects(assertPiNavGrepAvailable(), error => {
      assert.match(error.message, /\[pi-nav:incompatible_addon\] Grep is unavailable/);
      assert.ok(error.message.includes(capability));
      return true;
    });
    build.capabilities.push(capability);
  }
  assert.equal(sessions, 0, "startup readiness must not scan, create sessions or prepare a project");
});

test("pi-nav target and artifact mapping is exact and import-safe", () => {
  assert.deepEqual(resolvePiNavTarget("darwin", "arm64"), {
    platform: "darwin",
    arch: "arm64",
    releaseKey: "darwin-arm64",
    rustTarget: "aarch64-apple-darwin",
  });
  assert.equal(resolvePiNavTarget("linux", "x64").rustTarget, "x86_64-unknown-linux-gnu");
  assert.throws(() => resolvePiNavTarget("win32", "x64"), /unsupported_target/);
  const target = resolvePiNavTarget();
  const paths = piNavArtifactPaths(root, target);
  assert.match(paths.addon, new RegExp(`pi_nav\\.${target.releaseKey}\\.node$`));
  assert.equal(paths.cli, path.join(root, "native", "pi-nav", "bin", target.rustTarget, "pi-nav"));
});

test("addon reuses canonical-root state across aliases and module reloads while isolating roots", async () => {
  resetState();
  const first = await scratch();
  const second = await scratch();
  const alias = `${first}-alias`;
  await symlink(first, alias);
  try {
    const read = await call(first, "pi_nav_read", { path: "sample.js", mode: "full", budget: 4000 });
    assert.equal(read.structured.operation, "pi_nav_read");
    assert.equal(read.structured.schemaVersion, 1);

    const reloaded = await import(`../src/core/pi-nav-native.ts?reload=${Date.now()}`);
    const same = await reloaded.callPiNav({ root: alias, operation: "pi_nav_session", args: {} });
    assert.ok(same.structured.data.reads >= 1, JSON.stringify(same.structured.data));

    const isolated = await call(second, "pi_nav_session", {});
    assert.equal(isolated.structured.data.reads, 0);
    assert.notEqual(await realpath(first), await realpath(second));
  } finally {
    await rm(alias, { force: true });
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("module reload fails explicitly when preserved global state holds an older addon major", async () => {
  resetState();
  const directory = await scratch();
  const target = resolvePiNavTarget();
  globalThis[stateSymbol] = {
    roots: new Map(),
    loadPromise: Promise.resolve({
      target,
      addon: {
        getBuildInfo: () => ({
          packageVersion: "0.9.0",
          addonApiVersion: 1,
          resultSchemaVersion: 1,
          target: target.rustTarget,
          capabilities: [
            "pi_nav_search", "pi_nav_files", "pi_nav_ls", "pi_nav_read", "pi_nav_diff",
            "pi_nav_deps", "pi_nav_grok", "pi_nav_map", "pi_nav_overview",
            "pi_nav_savings", "pi_nav_session", "source_proof_v1",
          ],
        }),
        PiNavSession: class {},
      },
    }),
  };
  try {
    await assert.rejects(
      callPiNav({ root: directory, operation: "pi_nav_session", args: {} }),
      /schema major.*restart Pi|expected 2.*got 1/i,
    );
  } finally {
    resetState();
    await rm(directory, { recursive: true, force: true });
  }
});
test("ranked corpus admission refuses old addons before search or proof; ordinary navigation remains available", async () => {
  resetState();
  const directory = await scratch();
  const build = currentBuildInfo();
  const calls = [];
  globalThis[stateSymbol] = { roots: new Map(), loadPromise: Promise.resolve({ target: resolvePiNavTarget(), addon: {
    getBuildInfo: () => build,
    PiNavSession: class { async call(operation, args) { calls.push({ operation, args }); return { text: "", structured: { schemaVersion: 1, operation, data: {}, completeness: {}, diagnostics: [] } }; } },
  } }) };
  try {
    for (const operation of ["pi_nav_search", "pi_nav_source_proof"]) {
      await assert.rejects(call(directory, operation, { corpusAdmission: {} }), /no unrestricted fallback/);
    }
    assert.equal(calls.length, 0);
    await call(directory, "pi_nav_search", { query: "Ready" });
    assert.equal(calls.length, 1);
    build.capabilities.push("ranked_corpus_v1");
    const admission = { root: directory, files: ["sample.js"] };
    await call(directory, "pi_nav_search", { query: "Ready", corpusAdmission: admission });
    assert.equal(calls.at(-1).args.corpusAdmission, admission);
  } finally { resetState(); await rm(directory, { recursive: true, force: true }); }
});

test("ranked focus fails explicitly on old addons; collection handoff stays optional and private", async () => {
  resetState();
  const directory = await scratch();
  const build = currentBuildInfo();
  const calls = [];
  let payload = { text: "live source", structured: { schemaVersion: 1, operation: "pi_nav_search", data: {}, completeness: {}, diagnostics: [] } };
  globalThis[stateSymbol] = { roots: new Map(), loadPromise: Promise.resolve({ target: resolvePiNavTarget(), addon: {
    getBuildInfo: () => build,
    PiNavSession: class { async call(operation, args) { calls.push({ operation, args }); return payload; } },
  } }) };
  try {
    const args = { query: "Ready", captureRanked: true };
    await call(directory, "pi_nav_search", args);
    assert.equal(calls[0].args.captureRanked, undefined, "old addons retain their ordinary live query");
    assert.equal(args.captureRanked, true, "do not mutate the caller's request");
    await assert.rejects(call(directory, "pi_nav_search", { query: "Ready", resumeRanked: "private-id" }), /handoff is unavailable/);
    await assert.rejects(call(directory, "pi_nav_search", { query: "original question", focus: { target: `${directory}/sample.js::value` } }), /focus was not ignored/);
    await assert.rejects(call(directory, "pi_nav_search", { query: "Ready", retainRankedRender: true }), /retained ranked rendering is unavailable/);
    assert.equal(calls.length, 1);
    build.capabilities.push("ranked_capture_v1");
    build.capabilities.push("ranked_focus_v1");
    build.capabilities.push("ranked_render_v1");
    const focusedArgs = { query: "original question", focus: { target: `${directory}/sample.js::value`, evidence: "callers" } };
    await call(directory, "pi_nav_search", focusedArgs);
    assert.deepEqual(calls.at(-1).args.focus, focusedArgs.focus);
    assert.equal(calls.at(-1).args.query, "original question");
    const ordinary = payload;
    payload = { ...ordinary, searchCapture: "ranked-private-id" };
    const captured = await call(directory, "pi_nav_search", args);
    assert.equal(calls.at(-1).args.captureRanked, true);
    assert.equal(captured.searchCapture, "ranked-private-id");
    assert.equal(captured.structured, ordinary.structured);
    assert.ok(!JSON.stringify(captured.structured).includes("ranked-private-id"));
    payload = { ...ordinary, rankedRenderCursor: "grep-ranked-original" };
    const render = await call(directory, "pi_nav_search", { query: "Ready", retainRankedRender: true });
    assert.equal(render.rankedRenderCursor, "grep-ranked-original");
    assert.ok(!JSON.stringify(render.structured).includes("grep-ranked-original"));
    payload = { ...ordinary, rankedRenderCursor: "grep-ranked-original", rankedRenderUnavailable: "No coherent group fits",
      structured: { ...ordinary.structured, data: { mode: "ranked", sourceRows: [] }, completeness: { complete: false, returned: 0 } } };
    const blocked = await call(directory, "pi_nav_search", { query: "Ready", retainRankedRender: true });
    assert.equal(blocked.rankedRenderCursor, "grep-ranked-original");
    assert.equal(blocked.structured.data.cursor, undefined);
    for (const invalid of [
      { searchCapture: "" }, { searchCapture: "x".repeat(1025) },
      { searchCapture: "id", searchCaptureUnavailable: "refused" },
      { structured: { ...ordinary.structured, data: { searchCapture: "ranked-private-id" } } },
      { rankedRenderCursor: "" }, { rankedRenderCursor: "x".repeat(1025) },
      { rankedRenderCursor: "id", rankedRenderUnavailable: "refused" },
      { rankedRenderUnavailable: "é".repeat(513) },
      { structured: { ...ordinary.structured, data: { rankedRenderCursor: "id" } } },
    ]) {
      payload = { ...ordinary, ...invalid };
      await assert.rejects(call(directory, "pi_nav_search", args), /malformed_output/);
    }
  } finally {
    resetState();
    await rm(directory, { recursive: true, force: true });
  }
});

test("semantic build metadata is native-owned and does not require a source session or model", async () => {
  resetState();
  const build = currentBuildInfo();
  let sessions = 0;
  globalThis[stateSymbol] = { roots: new Map(), loadPromise: Promise.resolve({ target: resolvePiNavTarget(), addon: {
    getBuildInfo: () => build,
    PiNavSession: class { constructor() { sessions++; } },
  } }) };
  try {
    await assert.rejects(getPiNavSemanticInfo(), /no compatible semantic input recipe/);
    build.capabilities.push("semantic_encode_v1", "semantic_inputs_v1");
    build.semanticRecipe = "a".repeat(64);
    build.semanticDimensions = 256;
    assert.deepEqual(await getPiNavSemanticInfo(), { recipe: build.semanticRecipe, dimensions: 256 });
    for (const invalid of ["display-name", "a".repeat(63), "g".repeat(64)]) {
      build.semanticRecipe = invalid;
      await assert.rejects(getPiNavSemanticInfo(), /no compatible semantic input recipe/);
    }
    build.semanticRecipe = "a".repeat(64);
    build.semanticDimensions = 128;
    await assert.rejects(getPiNavSemanticInfo(), /no compatible semantic input recipe/);
    assert.equal(sessions, 0);
  } finally { resetState(); }
});

test("supplied-source replies cannot gain current-file authority or raise ordinary output limits", async () => {
  resetState();
  const directory = await scratch();
  const build = currentBuildInfo();
  const calls = [];
  const supplied = { basis: "supplied", suppliedSourceHash: "a".repeat(64), owners: Array.from({ length: 8 }, (_, id) => ({ id: String(id), input: "x".repeat(40 * 1024) })) };
  let payload = { text: "", structured: { schemaVersion: 1, operation: "pi_nav_semantic_inputs", data: supplied, completeness: {}, diagnostics: [] } };
  globalThis[stateSymbol] = { roots: new Map(), loadPromise: Promise.resolve({ target: resolvePiNavTarget(), addon: {
    getBuildInfo: () => build,
    PiNavSession: class { async call(operation, args) { calls.push({ operation, args }); return payload; } },
  } }) };
  const args = { path: "not-on-disk.ts", capturedSource: { text: "supplied" }, owners: [] };
  try {
    await assert.rejects(call(directory, "pi_nav_semantic_inputs", args), /semantic source projection is unavailable/);
    await assert.rejects(call(directory, "pi_nav_symbol_range", { ...args, capturedSource: null }), /no pathname fallback/);
    assert.equal(calls.length, 0, "old addons must not silently ignore the supplied-source form");
    for (const operation of ["pi_nav_search", "pi_nav_files", "pi_nav_source_proof", "pi_nav_semantic_encode"]) {
      await assert.rejects(call(directory, operation, args), /does not support this operation or a cursor/);
    }
    await assert.rejects(call(directory, "pi_nav_symbol_range", { ...args, cursor: "old-cursor" }), /does not support this operation or a cursor/);
    assert.equal(calls.length, 0);
    build.capabilities.push("semantic_encode_v1", "semantic_inputs_v1", "captured_source_v1");
    build.semanticRecipe = "a".repeat(64);
    build.semanticDimensions = 256;
    for (const fields of [{ semanticRecipe: "display-name" }, { semanticDimensions: 128 }]) {
      Object.assign(build, fields);
      await assert.rejects(call(directory, "pi_nav_semantic_inputs", args), /no compatible semantic input recipe/);
      await assert.rejects(call(directory, "pi_nav_semantic_encode", { modelDirectory: directory, texts: ["source"] }), /no compatible semantic input recipe/);
      await assert.rejects(call(directory, "pi_nav_search", { query: "question", analysisModelDirectory: directory }), /no compatible semantic input recipe/);
      build.semanticRecipe = "a".repeat(64);
      build.semanticDimensions = 256;
    }
    assert.equal(calls.length, 0, "bad semantic metadata is refused before native work");
    supplied.owners[0].input = '{"sourceHash":"authored text","verified":true}' + supplied.owners[0].input;
    const privateReply = await call(directory, "pi_nav_semantic_inputs", args);
    assert.equal(privateReply.structured.data, supplied, "private projection alone can exceed 256 KiB");
    assert.equal(calls[0].args.capturedSource, args.capturedSource);
    const ordinary = payload;
    for (const invalid of [
      { text: "supplied text is not model output" },
      { sourceSnapshots: [] },
      ...[{ basis: "current" }, { sourceHash: "a".repeat(64) }, { verified: false }, { suppliedSourceHash: "not-a-hash" },
        { files: [{ sourceHash: "a".repeat(64) }] }, { owners: [{ verified: true }] }, { nested: { sourceSnapshots: [] } }]
        .map(fields => ({ structured: { ...ordinary.structured, data: { ...supplied, ...fields } } })),
    ]) {
      payload = { ...ordinary, ...invalid };
      await assert.rejects(call(directory, "pi_nav_semantic_inputs", args), /must not return current-file authority/);
    }
    payload = { ...ordinary, structured: { ...ordinary.structured, data: { ...supplied, extra: "x".repeat(2 * 1024 * 1024) } } };
    await assert.rejects(call(directory, "pi_nav_semantic_inputs", args), /response_too_large/);
    payload = { text: "", structured: { ...ordinary.structured, operation: "pi_nav_read", data: {
      basis: "supplied", suppliedSourceHash: "a".repeat(64), files: [{ path: "doc.md", sourceHash: "a".repeat(64), sections: [] }],
    } } };
    await assert.rejects(call(directory, "pi_nav_read", args), /must not return current-file authority/);
    payload = { ...ordinary, structured: { ...ordinary.structured, operation: "pi_nav_read" } };
    await assert.rejects(call(directory, "pi_nav_read", { path: "sample.js" }), /exceeded 262144 bytes/);
    await assert.rejects(call(directory, "pi_nav_read", args), /exceeded 262144 bytes/);
    build.semanticRecipe = "malformed optional metadata";
    payload = { text: "ordinary live response", structured: { ...ordinary.structured, operation: "pi_nav_read", data: {} } };
    assert.equal((await call(directory, "pi_nav_read", { path: "sample.js" })).text, "ordinary live response");
    payload = { text: "", structured: { ...ordinary.structured, operation: "pi_nav_symbol_range", data: {
      basis: "supplied", suppliedSourceHash: "a".repeat(64), status: "absent",
    } } };
    assert.equal((await call(directory, "pi_nav_symbol_range", args)).structured.data.status, "absent",
      "supplied symbol parsing does not depend on encoder metadata");
  } finally {
    resetState();
    await rm(directory, { recursive: true, force: true });
  }
});

test("source proof snapshots stay top-level, bounded, current, and absent from structured persistence", async () => {
  resetState();
  const directory = await scratch();
  const crlf = "\ufefffirst  \r\nsecond\r\n";
  await writeFile(path.join(directory, "crlf.txt"), crlf);
  try {
    const read = await call(directory, "pi_nav_read", { path: "crlf.txt", mode: "full", budget: 4000 });
    assert.equal(read.sourceSnapshots.length, 1);
    assert.equal(read.sourceSnapshots[0].text, crlf);
    assert.equal(read.sourceSnapshots[0].lineEnding, "crlf");
    assert.equal(read.sourceSnapshots[0].bom, true);
    assert.match(read.sourceSnapshots[0].rawDigest, /^[A-F0-9]{64}$/);
    assert.equal(Object.hasOwn(read.structured, "sourceSnapshots"), false);
    assert.equal(JSON.stringify(read.structured).includes("rawDigest"), false, "snapshot payload must not enter structured metadata");
    const proof = await call(directory, "pi_nav_source_proof", { paths: ["crlf.txt", "missing.txt"] });
    assert.equal(proof.text, "");
    assert.equal(proof.sourceSnapshots.length, 1);
    assert.equal(proof.structured.completeness.complete, false);
    assert.deepEqual(proof.structured.data.files.map(file => file.status), ["proven", "rejected"]);
    assert.equal(Object.hasOwn(proof.structured, "sourceSnapshots"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("relative operation paths stay rooted while explicit parent and absolute paths are accepted", async () => {
  resetState();
  const directory = await scratch();
  const outsideName = `pi-nav-outside-${path.basename(directory)}.md`;
  const outsidePath = path.join(directory, "..", outsideName);
  await writeFile(path.join(directory, "other.js"), "export const other = 2;\n");
  await writeFile(outsidePath, "# Outside\nexternal content\n");
  try {
    const map = await call(directory, "pi_nav_map", { scope: ".", depth: 2, budget: 6000 });
    assert.equal(map.structured.operation, "pi_nav_map");
    assert.ok(map.structured.data.entries.some((entry) => entry.path === "sample.js"));

    const grok = await call(directory, "pi_nav_grok", { target: "sample.js:1", full: false });
    assert.equal(grok.structured.operation, "pi_nav_grok");

    const parentRead = await call(directory, "pi_nav_read", { path: `../${outsideName}`, markdownStructure: true, includeSections: true });
    assert.equal(parentRead.structured.operation, "pi_nav_read");
    assert.ok(parentRead.structured.data.files.some(file => String(file.path).includes(outsideName)));
    const absoluteRead = await call(directory, "pi_nav_read", { path: outsidePath, markdownStructure: true, includeSections: true });
    assert.equal(absoluteRead.structured.operation, "pi_nav_read");
    const matches = await call(directory, "pi_nav_search", { pattern: "external content", paths: [outsidePath], syntax: "literal", output: "matches", case: "smart", visibility: "project" });
    assert.equal(matches.structured.operation, "pi_nav_search");
    assert.match(matches.text, /external content/);
  } finally {
    await rm(outsidePath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("abort forwarding preserves caller signal behavior, removes listeners, and does not poison FIFO", async () => {
  resetState();
  const directory = await scratch();
  try {
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      callPiNav({ root: directory, operation: "pi_nav_session", args: {}, signal: preAborted.signal }),
      { name: "AbortError" },
    );

    const normal = new AbortController();
    let added = 0;
    let removed = 0;
    const originalAdd = normal.signal.addEventListener.bind(normal.signal);
    const originalRemove = normal.signal.removeEventListener.bind(normal.signal);
    normal.signal.addEventListener = (...args) => {
      added += 1;
      return originalAdd(...args);
    };
    normal.signal.removeEventListener = (...args) => {
      removed += 1;
      return originalRemove(...args);
    };
    await callPiNav({ root: directory, operation: "pi_nav_session", args: {}, signal: normal.signal });
    assert.equal(added, 1);
    assert.equal(removed, 1);

    const queued = new AbortController();
    let propertyCalls = 0;
    const propertyHandler = () => {
      propertyCalls += 1;
    };
    queued.signal.onabort = propertyHandler;
    const first = call(directory, "pi_nav_map", { depth: 8, budget: 24000 });
    const reloaded = await import(`../src/core/pi-nav-native.ts?fifo=${Date.now()}`);
    const second = reloaded.callPiNav({
      root: directory,
      operation: "pi_nav_session",
      args: {},
      signal: queued.signal,
    });
    queued.abort();
    await first;
    await assert.rejects(second, { name: "AbortError" });
    assert.equal(propertyCalls, 1);
    assert.equal(queued.signal.onabort, propertyHandler);

    const after = await call(directory, "pi_nav_session", {});
    assert.equal(after.structured.operation, "pi_nav_session");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued timeout consumes the original budget and never dispatches expired work", async () => {
  resetState();
  const directory = await scratch();
  let releaseFirst;
  let markStarted;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });
  const calls = [];
  class QueueSession {
    async call(operation, _args, timeoutMs) {
      calls.push({ operation, timeoutMs });
      if (calls.length === 1) {
        markStarted();
        await firstReleased;
      }
      return {
        text: "ok",
        structured: {
          schemaVersion: 1,
          operation,
          data: {},
          completeness: { complete: true, returned: 0, total: 0 },
          diagnostics: [],
        },
      };
    }
  }
  globalThis[stateSymbol] = {
    loadPromise: Promise.resolve({ addon: { getBuildInfo: currentBuildInfo, PiNavSession: QueueSession }, target: resolvePiNavTarget() }),
    roots: new Map(),
  };
  try {
    const first = callPiNav({ root: directory, operation: "pi_nav_session", args: {} });
    await firstStarted;
    const expired = callPiNav({ root: directory, operation: "pi_nav_session", args: {}, timeoutMs: 0 });
    releaseFirst();
    await first;
    await assert.rejects(expired, /deadline exceeded while queued/);
    assert.equal(calls.length, 1, "expired queued work must not reach the native session");

    const after = await callPiNav({ root: directory, operation: "pi_nav_session", args: {} });
    assert.equal(after.structured.operation, "pi_nav_session");
    assert.equal(calls.length, 2, "an expired follower must not poison the FIFO");
  } finally {
    resetState();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native work stays off the JavaScript event loop and deadline work remains usable", async () => {
  resetState();
  const directory = await scratch();
  const files = path.join(directory, "many");
  await mkdir(files);
  await Promise.all(
    Array.from({ length: 400 }, (_, index) =>
      writeFile(path.join(files, `file-${index}.js`), `export const value${index} = ${index};\n`),
    ),
  );
  try {
    let nativeSettled = false;
    const native = call(directory, "pi_nav_map", { depth: 3, budget: 24000 }, { timeoutMs: 10_000 });
    native.finally(() => {
      nativeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(nativeSettled, false, "native work resolved before the event loop advanced");
    const output = await native;
    assert.equal(output.structured.operation, "pi_nav_map");

    await assert.rejects(
      call(directory, "pi_nav_overview", {}, { timeoutMs: 0 }),
      /deadline|cancelled/i,
    );
    const after = await call(directory, "pi_nav_session", {});
    assert.equal(after.structured.operation, "pi_nav_session");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("in-flight walker cancellation resolves as an honest partial", async () => {
  resetState();
  const directory = await scratch();
  const files = path.join(directory, "many");
  await mkdir(files);
  await Promise.all(
    Array.from({ length: 1000 }, (_, index) =>
      writeFile(path.join(files, `file-${index}.js`), `export const value${index} = ${index};\n`),
    ),
  );
  try {
    const controller = new AbortController();
    const pending = callPiNav({
      root: directory,
      operation: "pi_nav_map",
      args: { depth: 3, budget: 24000 },
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);
    const output = await pending;
    assert.equal(output.structured.completeness.complete, false);
    assert.equal(output.structured.completeness.reason, "cancelled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("build-info validation rejects every incompatible identity and write capability", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "pi-nav-validation-"));
  const loaderDir = path.join(fixture, "src", "core");
  await mkdir(loaderDir, { recursive: true });
  await mkdir(path.join(fixture, "native", "analysis"), { recursive: true });
  await copyFile(path.join(root, "native", "analysis", "identity.mjs"), path.join(fixture, "native", "analysis", "identity.mjs"));
  const productionSource = await readFile(path.join(root, "src", "core", "pi-nav-native.ts"), "utf8");
  const instrumented = productionSource.replace(
    "function validateBuildInfo(",
    "export function validateBuildInfo(",
  );
  assert.notEqual(instrumented, productionSource, "validation instrumentation anchor must match");
  await writeFile(path.join(loaderDir, "pi-nav-native.ts"), instrumented);
  await copyFile(path.join(root, "src", "core", "project-root.ts"), path.join(loaderDir, "project-root.ts"));
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ version: "0.9.0", type: "module" }));
  try {
    const moduleUrl = pathToFileURL(path.join(loaderDir, "pi-nav-native.ts")).href;
    const module = await import(`${moduleUrl}?validation=${Date.now()}`);
    const target = module.resolvePiNavTarget();
    const valid = {
      packageVersion: "0.9.0",
      addonApiVersion: 2,
      resultSchemaVersion: 1,
      target: target.rustTarget,
      capabilities: [
        "pi_nav_search", "pi_nav_files", "pi_nav_ls", "pi_nav_read", "pi_nav_diff",
        "pi_nav_deps", "pi_nav_grok", "pi_nav_map", "pi_nav_overview",
        "pi_nav_savings", "pi_nav_session", "pi_nav_symbol_range", "source_proof_v1", "pi_nav_future_read_only",
      ],
    };
    assert.doesNotThrow(() => module.validateBuildInfo(valid, "0.9.0", target));
    for (const [change, pattern] of [
      [{ packageVersion: "9.9.9" }, /package version/],
      [{
        target: target.rustTarget === "x86_64-unknown-linux-gnu"
          ? "aarch64-unknown-linux-gnu"
          : "x86_64-unknown-linux-gnu",
      }, /wrong_target/],
      [{ addonApiVersion: 1 }, /schema major/],
      [{ resultSchemaVersion: 2 }, /schema major/],
      [{ capabilities: valid.capabilities.filter((name) => name !== "pi_nav_read") }, /missing required capability/],
      [{ capabilities: [...valid.capabilities, "pi_nav_write"] }, /write_capability/],
      [{ capabilities: [42] }, /string array/],
    ]) {
      assert.throws(() => module.validateBuildInfo({ ...valid, ...change }, "0.9.0", target), pattern);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});


test("GC-capable isolated child stress exits without leaked active native work", async () => {
  const loaderUrl = pathToFileURL(path.join(root, "src", "core", "pi-nav-native.ts")).href;
  const source = String.raw`
    import { callPiNav } from ${JSON.stringify(loaderUrl)};
    for (let index = 0; index < 50; index += 1) {
      await callPiNav({ root: process.env.PI_NAV_STRESS_ROOT, operation: 'pi_nav_session', args: {} });
    }
    global.gc();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const active = process.getActiveResourcesInfo().filter((name) => /worker|async/i.test(name));
    if (active.length !== 0) throw new Error('active native work remained: ' + active.join(','));
    console.log('stress-ok');
  `;
  const result = await execFileAsync(
    process.execPath,
    ["--expose-gc", "--input-type=module", "--eval", source],
    { cwd: root, env: { ...process.env, PI_NAV_STRESS_ROOT: root }, timeout: 10_000 },
  );
  assert.match(result.stdout, /stress-ok/);
});

test("malformed native output is rejected while additive structured fields are tolerated", async () => {
  class FakeSession {
    constructor() {}
    async call(operation) {
      return FakeSession.output(operation);
    }
    static output = (operation) => ({
      text: "ok",
      structured: {
        schemaVersion: 1,
        operation,
        data: {},
        completeness: { complete: true, returned: 0, total: 0 },
        diagnostics: [],
        additive: { future: true },
      },
    });
  }
  globalThis[stateSymbol] = {
    loadPromise: Promise.resolve({ addon: { getBuildInfo: currentBuildInfo, PiNavSession: FakeSession }, target: resolvePiNavTarget() }),
    roots: new Map(),
  };
  const accepted = await call(root, "pi_nav_session", {});
  assert.equal(accepted.structured.additive.future, true);

  resetState();
  FakeSession.output = () => ({ text: "bad", structured: { schemaVersion: 1 } });
  globalThis[stateSymbol] = {
    loadPromise: Promise.resolve({ addon: { getBuildInfo: currentBuildInfo, PiNavSession: FakeSession }, target: resolvePiNavTarget() }),
    roots: new Map(),
  };
  await assert.rejects(call(root, "pi_nav_session", {}), /malformed_output/);
  resetState();
});

test("native loader rejects API-threatening output before returning it", async () => {
  class OversizedSession {
    async call(operation) {
      return {
        text: "x".repeat(512 * 1024),
        structured: {
          schemaVersion: 1,
          operation,
          data: {},
          completeness: { complete: true, returned: 1, total: 1 },
          diagnostics: [],
        },
      };
    }
  }
  resetState();
  globalThis[stateSymbol] = {
    loadPromise: Promise.resolve({ addon: { getBuildInfo: currentBuildInfo, PiNavSession: OversizedSession }, target: resolvePiNavTarget() }),
    roots: new Map(),
  };
  try {
    await assert.rejects(call(root, "pi_nav_search", {}), /response_too_large.*131072.*payload withheld/i);
  } finally {
    resetState();
  }
});

test("isolated copied loader diagnoses missing and corrupt addon without fallback", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "pi-nav-loader-"));
  const fixtureCanonical = await realpath(fixture);
  const loaderDir = path.join(fixture, "src", "core");
  await mkdir(loaderDir, { recursive: true });
  await mkdir(path.join(fixture, "native", "pi-nav"), { recursive: true });
  await mkdir(path.join(fixture, "native", "analysis"), { recursive: true });
  await copyFile(path.join(root, "native", "analysis", "identity.mjs"), path.join(fixture, "native", "analysis", "identity.mjs"));
  await writeFile(path.join(fixture, "native", "pi-nav", "Cargo.toml"), "[package]\nname='fixture'\n");
  await copyFile(path.join(root, "src", "core", "pi-nav-native.ts"), path.join(loaderDir, "pi-nav-native.ts"));
  await copyFile(path.join(root, "src", "core", "project-root.ts"), path.join(loaderDir, "project-root.ts"));
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ version: "0.9.0", type: "module" }));
  const moduleUrl = pathToFileURL(path.join(loaderDir, "pi-nav-native.ts")).href;
  try {
    const copied = await import(`${moduleUrl}?missing=${Date.now()}`);
    await assert.rejects(
      copied.callPiNav({ root: fixture, operation: "pi_nav_session", args: {} }),
      /missing_addon.*pi-nav:build/,
    );

    const target = copied.resolvePiNavTarget();
    const artifacts = copied.piNavArtifactPaths(fixture, target);
    await mkdir(path.dirname(artifacts.addon), { recursive: true });
    await writeFile(artifacts.addon, "not a native addon");
    delete globalThis[Symbol.for(`jeito-codeweave-pi.pi-nav-native.v1:${fixtureCanonical}`)];
    const corrupt = await import(`${moduleUrl}?corrupt=${Date.now()}`);
    await assert.rejects(
      corrupt.callPiNav({ root: fixture, operation: "pi_nav_session", args: {} }),
      /load_failed/,
    );
  } finally {
    resetState();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("N-API write operation is unreachable", async () => {
  resetState();
  await assert.rejects(call(root, "pi_nav_write", {}), /unknown_operation/);
});

test("grep cursor routing keeps its native owner, FIFO, token and source root", async () => {
  const first = await realpath(await scratch());
  const second = await realpath(await scratch());
  const cursor = "grep-0123456789abcdef01234567";
  const calls = [];
  const owners = new Set([first]);
  let info = currentBuildInfo();
  let afterProbe = () => {};
  let descriptor;
  class CursorSession {
    constructor(root) { this.root = root; }
    async call(operation, args, timeoutMs, signal) {
      calls.push({ root: this.root, operation, args, timeoutMs, signal });
      const lookup = operation === "pi_nav_grep_cursor_owner";
      if (lookup) afterProbe();
      return {
        text: lookup ? "" : "unchanged native result",
        structured: {
          schemaVersion: 1, operation,
          data: lookup ? { ownsCursor: owners.has(this.root) && args.cursor === cursor,
            ...(owners.has(this.root) && descriptor ? { rankedCursor: descriptor } : {}) } : { retained: true },
          completeness: { complete: true, returned: 0, total: 0 }, diagnostics: [],
        },
      };
    }
  }
  resetState();
  globalThis[stateSymbol] = {
    roots: new Map(),
    loadPromise: Promise.resolve({ addon: { getBuildInfo: () => info, PiNavSession: CursorSession }, target: resolvePiNavTarget() }),
  };
  try {
    await call(first, "pi_nav_session");
    await call(second, "pi_nav_session");
    const state = globalThis[stateSymbol];
    const foreign = path.join(first, "not-a-directory");
    descriptor = { query: 'original retry question', scope: first, visibility: 'project',
      focus: { target: `${first}/worker.ts::Worker`, evidence: 'callers' },
      analysis: { generation: 1, captureDigest: 'a'.repeat(64), interpretationRevision: 'test.1' } };
    calls.length = 0;
    const described = await call(foreign, 'pi_nav_grep_cursor_owner', { cursor });
    assert.deepEqual(described.structured.data.rankedCursor, descriptor);
    assert.equal(described.sourceRoot, first);
    assert.deepEqual(calls.map(call => call.operation), ['pi_nav_grep_cursor_owner', 'pi_nav_grep_cursor_owner']);
    assert.equal(state.roots.size, 2, 'describing a cursor never creates the supplied root or renders a page');
    info.capabilities.push("ranked_render_v1");
    calls.length = 0;
    const fitted = await call(foreign, "pi_nav_search", { renderRanked: cursor, rankedRenderAllowance: 2_500 });
    assert.equal(fitted.sourceRoot, first, "private fitting uses the retained owner, not the supplied root");
    assert.deepEqual(calls.at(-1).args, { renderRanked: cursor, rankedRenderAllowance: 2_500 });
    assert.equal(calls.at(-1).root, first);
    assert.equal(state.roots.size, 2, "fitting never initializes a new root");
    descriptor.scope = 'relative';
    await assert.rejects(call(foreign, 'pi_nav_grep_cursor_owner', { cursor }), /malformed_output.*descriptor/);
    descriptor.scope = first;
    descriptor.analysis.captureDigest = 'not a source version';
    await assert.rejects(call(foreign, 'pi_nav_grep_cursor_owner', { cursor }), /malformed_output.*descriptor/);
    descriptor = undefined;
    calls.length = 0;
    let releaseOther;
    state.roots.get(second).tail = new Promise(resolve => { releaseOther = resolve; });
    const pending = call(foreign, "pi_nav_search", { cursor, contextLines: 0 });
    pending.catch(() => {});
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(calls.some(row => row.operation === "pi_nav_search"), "unrelated FIFO must not gate memory-only ownership lookup");
    } finally { releaseOther(); }
    const output = await pending;
    assert.equal(output.sourceRoot, first);
    assert.equal(output.text, "unchanged native result");
    assert.deepEqual(output.structured.data, { retained: true });
    assert.deepEqual(calls.at(-1).args, { cursor, contextLines: 0 });
    assert.equal(calls.at(-1).root, first);
    assert.equal(state.roots.size, 2, "continuation must not canonicalize or create the foreign root");

    calls.length = 0;
    let releaseOwner;
    state.roots.get(first).tail = new Promise(resolve => { releaseOwner = resolve; });
    const queued = call(foreign, "pi_nav_search", { cursor });
    queued.catch(() => {});
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.filter(row => row.operation === "pi_nav_search").length, 0, "actual continuation stays behind the owner's FIFO");
    } finally { releaseOwner(); }
    await queued;

    for (const allowed of [[], [first, second]]) {
      owners.clear(); for (const owner of allowed) owners.add(owner);
      calls.length = 0;
      await assert.rejects(call(foreign, "pi_nav_search", { cursor }), /unknown|ambiguous/);
      assert.equal(calls.filter(row => row.operation === "pi_nav_search").length, 0);
      assert.equal(state.roots.size, 2);
    }
    owners.clear(); owners.add(first);
    assert.equal((await call(foreign, "pi_nav_search", { cursor })).sourceRoot, first);

    info = { ...info, capabilities: info.capabilities.filter(value => value !== "grep_cursor_owner_v1") };
    calls.length = 0;
    await assert.rejects(call(foreign, "pi_nav_search", { cursor }), /incompatible_addon.*grep_cursor_owner_v1.*restart/);
    assert.equal(calls.length, 0, "an older addon must not fall back to cwd");
    info = currentBuildInfo();
    const controller = new AbortController();
    afterProbe = () => controller.abort();
    calls.length = 0;
    await assert.rejects(call(foreign, "pi_nav_search", { cursor }, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls.filter(row => row.operation === "pi_nav_search").length, 0);
  } finally {
    resetState();
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("grep cursor owner lookups consume the original total deadline", async t => {
  const directory = await realpath(await scratch());
  const cursor = "grep-0123456789abcdef01234567";
  let clock = 0;
  const budgets = [];
  const native = [];
  const fake = { async call(operation, args, timeoutMs) {
    native.push(operation);
    budgets.push(timeoutMs);
    clock += 60;
    return { text: "", structured: {
      schemaVersion: 1, operation, data: { ownsCursor: true },
      completeness: { complete: true, returned: 0, total: 0 }, diagnostics: [],
    } };
  } };
  resetState();
  globalThis[stateSymbol] = {
    roots: new Map([[directory, { session: fake, tail: Promise.resolve() }], [directory + "-other", { session: fake, tail: Promise.resolve() }]]),
    loadPromise: Promise.resolve({ addon: { getBuildInfo: currentBuildInfo }, target: resolvePiNavTarget() }),
  };
  t.mock.method(performance, "now", () => clock);
  try {
    await assert.rejects(call("/must-not-resolve", "pi_nav_search", { cursor }, { timeoutMs: 100 }), /pi-nav:deadline/);
    assert.deepEqual(budgets, [100, 40]);
    assert.deepEqual(native, ["pi_nav_grep_cursor_owner", "pi_nav_grep_cursor_owner"]);
  } finally {
    resetState();
    t.mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  }
});
test("matches retained rendering is capability-gated, search-only and private to the bridge", async () => {
  resetState();
  const directory = await realpath(await scratch());
  const build = currentBuildInfo();
  const calls = [];
  let payload = { text: "live matches page", structured: { schemaVersion: 1, operation: "pi_nav_search", data: { mode: "matches" }, completeness: { complete: true, returned: 0, total: 0 }, diagnostics: [] } };
  globalThis[stateSymbol] = { roots: new Map(), loadPromise: Promise.resolve({ target: resolvePiNavTarget(), addon: {
    getBuildInfo: () => build,
    PiNavSession: class { async call(operation, args) {
      calls.push({ operation, args });
      if (operation === "pi_nav_grep_cursor_owner") {
        return { text: "", structured: { schemaVersion: 1, operation, data: { ownsCursor: true }, completeness: {}, diagnostics: [] } };
      }
      return payload;
    } },
  } }) };
  try {
    const args = { pattern: "needle", paths: [path.join(directory, "sample.js")], output: "matches", retainMatchesRender: true };
    await assert.rejects(call(directory, "pi_nav_search", args), /retained Matches rendering is unavailable; no rescan fallback is allowed/);
    await assert.rejects(call(directory, "pi_nav_search", { renderMatches: "grep-original", matchesRenderBytes: 12_000 }), /retained Matches rendering is unavailable/);
    assert.equal(calls.length, 0, "missing matches_render_v1 refusal never reaches native");
    build.capabilities.push("matches_render_v1");
    const initial = await call(directory, "pi_nav_search", args);
    assert.equal(calls[0].args.retainMatchesRender, true);
    assert.equal(calls[0].args.output, "matches");
    assert.equal(initial.matchesRenderCursor, undefined);
    assert.equal(JSON.stringify(initial.structured).includes("matchesRenderCursor"), false);
    payload = { ...payload, matchesRenderCursor: "grep-matches-original" };
    const retained = await call(directory, "pi_nav_search", args);
    assert.equal(retained.matchesRenderCursor, "grep-matches-original");
    assert.equal(JSON.stringify(retained.structured).includes("grep-matches-original"), false, "private origin never enters structured metadata");
    const refit = await call(directory, "pi_nav_search", { renderMatches: "grep-matches-original", matchesRenderBytes: 8_000 });
    assert.equal(refit.sourceRoot, directory);
    assert.equal(calls.at(-1).operation, "pi_nav_search");
    assert.deepEqual(calls.at(-1).args, { renderMatches: "grep-matches-original", matchesRenderBytes: 8_000 }, "refit args reach the owning session unchanged");
    await assert.rejects(call(directory, "pi_nav_session", { retainMatchesRender: true }), /retained Matches rendering is unavailable/, "retained matches args are bounded to search");
    payload = { text: "x", matchesRenderCursor: "grep-x", structured: { schemaVersion: 1, operation: "pi_nav_session", data: {}, completeness: {}, diagnostics: [] } };
    await assert.rejects(call(directory, "pi_nav_session", {}), /malformed_output[\s\S]*matchesRenderCursor/, "the private handle is search-only on the way out too");
    payload = { text: "live matches page", matchesRenderCursor: "grep-original", structured: { schemaVersion: 1, operation: "pi_nav_search", data: { mode: "matches" }, completeness: { complete: true, returned: 0, total: 0 }, diagnostics: [] } };
    for (const invalid of [
      { matchesRenderCursor: "" },
      { matchesRenderCursor: "x".repeat(1025) },
      { structured: { schemaVersion: 1, operation: "pi_nav_search", data: { mode: "matches", matchesRenderCursor: "grep-x" }, completeness: {}, diagnostics: [] } },
    ]) {
      payload = { ...payload, ...invalid };
      await assert.rejects(call(directory, "pi_nav_search", args), /malformed_output/);
    }
  } finally {
    resetState();
    await rm(directory, { recursive: true, force: true });
  }
});
