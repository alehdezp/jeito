import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAnalysisLifecycle } from "../src/core/native-maintenance.ts";

function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "analysis-lifecycle-")));
  const selected = { root, directory: join(root, "unused-store") };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return selected;
}

test("creating or denying a lifecycle starts no preparation or watcher", async t => {
  const selected = project(t);
  let calls = 0;
  const lifecycle = createAnalysisLifecycle(selected, () => false, async () => { calls++; });
  await lifecycle.start();
  lifecycle.invalidate();
  await lifecycle.stop();
  assert.equal(calls, 0);
  assert.equal(lifecycle.status().watching, 0);
  assert.equal(existsSync(selected.directory), false);
});

test("an admitted directory change requests reconciliation and stop closes subscriptions", async t => {
  const selected = project(t);
  let calls = 0;
  let timeout;
  let observed;
  const changed = new Promise((resolve, reject) => {
    observed = resolve;
    timeout = setTimeout(() => reject(new Error("filesystem hint did not request reconciliation")), 3000);
  });
  const lifecycle = createAnalysisLifecycle(selected, () => true, async request => {
    request.onCorpus([""]);
    if (++calls === 2) { clearTimeout(timeout); observed(); }
  });
  t.after(async () => { clearTimeout(timeout); await lifecycle.stop(); });
  await lifecycle.start();
  assert.equal(lifecycle.status().watching, 1);
  writeFileSync(join(selected.root, "new.ts"), "export const added = 1;\n");
  await changed;
  await lifecycle.stop();
  assert.equal(lifecycle.status().watching, 0);
  assert.equal(lifecycle.status().state, "inactive");
  const stoppedCalls = calls;
  lifecycle.invalidate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, stoppedCalls);
});

test("shutdown aborts running work, drops dirty follow-up and permits a later activation", async t => {
  const selected = project(t);
  let permitted = true;
  let calls = 0;
  let aborted = false;
  const lifecycle = createAnalysisLifecycle(selected, () => permitted, async (request, signal) => {
    request.onCorpus([""]);
    if (++calls === 1) await new Promise((_, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    });
  });
  t.after(() => lifecycle.stop());
  const initial = lifecycle.start();
  await new Promise(resolve => setImmediate(resolve));
  lifecycle.invalidate();
  lifecycle.invalidate();
  permitted = false;
  await lifecycle.stop();
  await initial;
  assert.equal(aborted, true);
  assert.equal(calls, 1);
  assert.equal(lifecycle.status().watching, 0);
  permitted = true;
  await lifecycle.start();
  assert.equal(calls, 2);
  assert.equal(lifecycle.status().state, "ready");
  await lifecycle.stop();
});

test("watch failure is visible without turning successful reconciliation into failure", async t => {
  const selected = project(t);
  const lifecycle = createAnalysisLifecycle(selected, () => true, async request => request.onCorpus(["../outside"]));
  t.after(() => lifecycle.stop());
  await lifecycle.start();
  assert.equal(lifecycle.status().state, "ready");
  assert.equal(lifecycle.status().watching, 0);
  assert.match(lifecycle.status().watchError, /escaped the admitted root/);
  await lifecycle.stop();
});

test("late busy receipt cannot turn a stopped lifecycle available again", async t => {
  const selected = project(t);
  let finish;
  const lifecycle = createAnalysisLifecycle(selected, () => true, () => new Promise(resolve => { finish = resolve; }));
  const started = lifecycle.start();
  await new Promise(resolve => setImmediate(resolve));
  const stopped = lifecycle.stop();
  finish({ status: "busy", ...selected });
  await stopped;
  await started;
  assert.equal(lifecycle.status().state, "inactive");
});

const modelDirectory = t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "analysis-model-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const waitFor = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("lifecycle did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const completion = (missing, stored) => ({ status: "published",
  semantic: { recipe: "recipe", dimensions: 256, represented: stored, missing, unsupported: 0, stored } });

test("an explicit model directory adds semantic completion after the code pass", async t => {
  const selected = project(t);
  const model = modelDirectory(t);
  const requests = [];
  const lifecycle = createAnalysisLifecycle({ ...selected, modelDirectory: model }, () => true, async request => {
    requests.push(request);
    return request.phase === "semantic" ? completion(0, 2) : { status: "published" };
  });
  t.after(() => lifecycle.stop());
  await lifecycle.start();
  assert.deepEqual(requests.map(request => request.phase ?? "code"), ["code", "semantic"]);
  // The code pass must not receive a model directory it has no use for, and the
  // completion pass keeps the same admission seam and explicit model choice.
  assert.equal(requests[0].modelDirectory, undefined);
  assert.equal(requests[1].modelDirectory, model);
  assert.equal(typeof requests[1].onCorpus, "function");
  assert.equal(lifecycle.status().state, "ready");
});

test("semantic completion never runs without an explicit model directory", async t => {
  const selected = project(t);
  const phases = [];
  const lifecycle = createAnalysisLifecycle(selected, () => true, async request => {
    phases.push(request.phase ?? "code");
    return { status: "published" };
  });
  t.after(() => lifecycle.stop());
  await lifecycle.start();
  assert.deepEqual(phases, ["code"]);
});

test("partial semantic progress schedules the remaining owners and then stops", async t => {
  const selected = project(t);
  const model = modelDirectory(t);
  let completions = 0;
  const lifecycle = createAnalysisLifecycle({ ...selected, modelDirectory: model }, () => true, async request => {
    if (request.phase !== "semantic") return { status: "published" };
    completions++;
    return completion(2 - completions, 1);
  });
  t.after(() => lifecycle.stop());
  await lifecycle.start();
  await waitFor(() => lifecycle.status().state === "ready");
  assert.equal(completions, 2);
});

test("a failed semantic pass is reported once and is not retried", async t => {
  const selected = project(t);
  const model = modelDirectory(t);
  let completions = 0;
  const lifecycle = createAnalysisLifecycle({ ...selected, modelDirectory: model }, () => true, async request => {
    if (request.phase !== "semantic") return { status: "published" };
    completions++;
    throw new Error("model assets unavailable");
  });
  t.after(() => lifecycle.stop());
  await lifecycle.start();
  assert.equal(lifecycle.status().state, "failed");
  assert.match(lifecycle.status().error, /model assets unavailable/);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(completions, 1);
});

test("an admitted change cancels a running semantic pass and reconciles again", async t => {
  const selected = project(t);
  const model = modelDirectory(t);
  let completions = 0;
  let cancelled = false;
  const lifecycle = createAnalysisLifecycle({ ...selected, modelDirectory: model }, () => true, async (request, signal) => {
    if (request.phase !== "semantic") return { status: "published" };
    if (++completions === 1) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true }));
    }
    return completion(0, 1);
  });
  t.after(() => lifecycle.stop());
  const initial = lifecycle.start();
  await waitFor(() => completions === 1);
  lifecycle.invalidate();
  await initial;
  assert.equal(cancelled, true);
  await waitFor(() => lifecycle.status().state === "ready");
  assert.equal(completions, 2);
});
