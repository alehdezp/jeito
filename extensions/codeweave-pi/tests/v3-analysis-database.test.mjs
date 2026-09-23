import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { AnalysisDatabase } from "../src/core/analysis-database.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "analysis-publication-"));
  const path = join(root, "graph.sqlite");
  const writer = new AnalysisDatabase(new Database(path));
  writer.pragma("journal_mode = WAL");
  writer.exec("CREATE TABLE facts (value TEXT); INSERT INTO facts VALUES ('last-good')");
  const reader = new Database(path, { readonly: true });
  t.after(() => { writer.close(); reader.close(); rmSync(root, { recursive: true, force: true }); });
  const values = () => reader.prepare("SELECT value FROM facts ORDER BY rowid").all().map(row => row.value);
  return { writer, reader, values };
}

function barrier() {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  return { wait, release };
}

test("publication awaits all passes and validation while helpers see intermediate facts and readers see last-good", async t => {
  const { writer, values } = fixture(t);
  const analysis = barrier();
  const validation = barrier();
  const controller = new AbortController();
  const publication = writer.publish(async () => {
    writer.transaction(() => {
      writer.prepare("INSERT INTO facts VALUES (?)").run("declaration");
      writer.transaction(() => writer.prepare("INSERT INTO facts VALUES (?)").run("relationship"))();
    })();
    assert.deepEqual([...writer.prepare("SELECT value FROM facts ORDER BY rowid").iterate()].map(row => row.value),
      ["last-good", "declaration", "relationship"]);
    await analysis.wait;
    return "complete";
  }, () => validation.wait, controller.signal);
  assert.deepEqual(values(), ["last-good"]);
  await assert.rejects(writer.publish(async () => {}, () => {}, controller.signal), /already owns/);
  analysis.release();
  await Promise.resolve();
  assert.deepEqual(values(), ["last-good"]);
  validation.release();
  assert.equal(await publication, "complete");
  assert.deepEqual(values(), ["last-good", "declaration", "relationship"]);
});

test("failed pass, source validation and cancellation each retain the previous facts and allow a later job", async t => {
  const { writer, values } = fixture(t);
  for (const failure of ["pass", "validation", "abort", "caught-helper"]) {
    const controller = new AbortController();
    const publication = writer.publish(async () => {
      writer.prepare("INSERT INTO facts VALUES (?)").run(failure);
      if (failure === "caught-helper") {
        try {
          writer.transaction(() => {
            writer.prepare("INSERT INTO facts VALUES (?)").run("partial helper write");
            throw new Error("helper failed");
          })();
        } catch { /* A donor pass may swallow this; publication must still fail. */ }
      }
      await Promise.resolve();
      if (failure === "pass") throw new Error("pass failed");
      if (failure === "abort") controller.abort();
    }, () => { if (failure === "validation") throw new Error("source changed"); }, controller.signal);
    await assert.rejects(publication, failure === "abort" ? { name: "AbortError" } : /pass failed|source changed|helper failed/);
    assert.deepEqual(values(), ["last-good"]);
  }
  const aborted = AbortSignal.abort();
  let called = false;
  await assert.rejects(writer.publish(async () => { called = true; }, () => {}, aborted), { name: "AbortError" });
  assert.equal(called, false);
  await writer.publish(async () => { writer.prepare("INSERT INTO facts VALUES (?)").run("next-good"); }, () => {}, new AbortController().signal);
  assert.deepEqual(values(), ["last-good", "next-good"]);
});

test("an accidentally async synchronous helper cannot publish early or write later after rejection", async t => {
  const { writer, values } = fixture(t);
  const gate = barrier();
  let continuation;
  const insert = writer.prepare("INSERT INTO facts VALUES (?)");
  assert.throws(writer.transaction(() => {
    continuation = (async () => {
      insert.run("before-await");
      await gate.wait;
      insert.run("after-await");
    })();
    return continuation;
  }), /must use publish/);
  assert.deepEqual(values(), ["last-good"]);
  gate.release();
  await assert.rejects(continuation, /closed|not open|finalized/);
  assert.deepEqual(values(), ["last-good"]);
  assert.equal(writer.open, false);
});
