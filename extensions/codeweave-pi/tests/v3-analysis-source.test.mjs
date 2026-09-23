import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, realpathSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createAnalysisFileSystem, createAdmittedAnalysisFileSystem } from "../src/core/analysis-source.ts";

test("resolver reads captured admitted files and config, never later disk bytes or excluded files", t => {
  const root = mkdtempSync(join(tmpdir(), "analysis-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const admitted = new Map([["source.ts", "export const value = 1;"], ["tsconfig.json", '{"compilerOptions":{}}']]);
  const source = createAnalysisFileSystem(root, admitted);
  writeFileSync(join(root, "source.ts"), "export const value = 2;");
  writeFileSync(join(root, "private.ts"), "not admitted");
  admitted.set("private.ts", "late mutation");
  assert.equal(source.readFileSync(join(root, "source.ts"), "utf8"), "export const value = 1;");
  assert.equal(source.readFileSync("tsconfig.json", "utf-8"), '{"compilerOptions":{}}');
  assert.equal(source.existsSync(join(root, "private.ts")), false);
  assert.throws(() => source.readFileSync("private.ts", "utf8"), { code: "ENOENT" });
  assert.equal(source.existsSync("../outside.ts"), false);
  assert.throws(() => source.readFileSync("../outside.ts", "utf8"), { code: "EACCES" });
});

test("workspace and include-directory discovery see only captured hierarchy, with consistent file kinds", () => {
  const root = join(tmpdir(), "analysis-virtual-root");
  const source = createAnalysisFileSystem(root, new Map([
    ["packages/β/src/main.ts", "export {};"],
    ["packages/β/package.json", '{"name":"beta"}'],
    ["go.mod", "module example"],
  ]));
  assert.deepEqual(source.readdirSync(root), ["go.mod", "packages"]);
  assert.deepEqual(source.readdirSync("packages/β", { withFileTypes: true }).map(entry => [entry.name, entry.isFile(), entry.isDirectory()]),
    [["package.json", true, false], ["src", false, true]]);
  assert.equal(source.existsSync("packages/β/src"), true);
  assert.equal(source.existsSync("packages/unseen"), false);
  assert.throws(() => source.readFileSync("packages", "utf8"), { code: "EISDIR" });
  assert.throws(() => source.readdirSync("go.mod"), { code: "ENOTDIR" });
  assert.throws(() => source.readdirSync("../outside"), { code: "EACCES" });
  for (const name of ["../escape", "/absolute", "a/../escape", "a\\b", "a\0b", "a/"]) {
    assert.throws(() => createAnalysisFileSystem(root, new Map([[name, ""]])), /project-relative/);
  }
  for (const entries of [[["a", ""], ["a/b", ""]], [["a/b", ""], ["a", ""]]]) {
    assert.throws(() => createAnalysisFileSystem(root, new Map(entries)), /collision/);
  }
});

test("admitted live source keeps denied files absent, validates aliases, and latches policy drift", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "analysis-admission-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/main.ts"), "first");
  writeFileSync(join(root, "private.ts"), "secret");
  writeFileSync(join(root, ".pi-navigation.json"), "{}");
  const admission = { root, files: ["src/main.ts"], policyFiles: [{ path: join(root, ".pi-navigation.json"), digest: createHash("sha256").update("{}").digest("hex") }] };
  const source = createAdmittedAnalysisFileSystem(admission);
  admission.files.push("private.ts");
  assert.equal(source.existsSync("private.ts"), false);
  assert.throws(() => source.readFileSync("private.ts", "utf8"), { code: "ENOENT" });
  assert.deepEqual(source.readdirSync(root), ["src"]);
  assert.equal(source.readFileSync("src/main.ts", "utf8"), "first");
  writeFileSync(join(root, "src/main.ts"), "second");
  assert.equal(source.readFileSync("src/main.ts", "utf8"), "second");
  rmSync(join(root, "src/main.ts"));
  symlinkSync(join(root, "private.ts"), join(root, "src/main.ts"));
  assert.throws(() => source.readFileSync("src/main.ts", "utf8"), /path changed/);
  writeFileSync(join(root, ".pi-navigation.json"), '{"scope":{"exclude":["src"]}}');
  assert.throws(() => source.existsSync("src/main.ts"), /policy changed/);
  writeFileSync(join(root, ".pi-navigation.json"), "{}");
  assert.throws(() => source.assertCurrent(), /policy changed/, "restoring policy cannot revive a failed run");
});

test("admitted source rejects a substituted open handle before reading content", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "analysis-handle-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "allowed.ts"), "allowed");
  writeFileSync(join(root, "private.ts"), "secret!");
  const source = createAdmittedAnalysisFileSystem({ root, files: ["allowed.ts"], policyFiles: [{ path: join(root, ".pi-navigation.json"), digest: null }] });
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  let substituted, forbiddenReads = 0;
  fs.openSync = (file, ...args) => {
    if (file !== join(root, "allowed.ts")) return originalOpen(file, ...args);
    substituted = originalOpen(join(root, "private.ts"), ...args);
    return substituted;
  };
  fs.readSync = (descriptor, ...args) => {
    if (descriptor === substituted) forbiddenReads++;
    return originalRead(descriptor, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => source.readFileSync("allowed.ts", "utf8"), /handle changed before read/);
    assert.equal(forbiddenReads, 0);
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    syncBuiltinESMExports();
  }
});
