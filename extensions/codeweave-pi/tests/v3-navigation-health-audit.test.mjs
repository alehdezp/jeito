import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendLifecycleAudit, inspectLifecycleAudit, readLifecycleAudit } from "../src/core/navigation-lifecycle-audit.ts";
import { inspectNavigation } from "../scripts/navigation-doctor.mjs";

async function fixture() { return mkdtemp(join(tmpdir(), "pi-nav-audit-")); }

test("lifecycle audit is bounded, redacted, attributable, and preserves explicit unknown causality", async () => {
  const root = await fixture();
  for (let index = 0; index < 20; index++) {
    await appendLifecycleAudit({
      root,
      lane: "docs",
      actorPid: process.pid,
      operation: "reconcile",
      trigger: "test",
      desiredStateHash: "a".repeat(64),
      result: index === 19 ? "error" : "success",
      failure: index === 19 ? "unknown actor; API_KEY=sk-test-secret-value" : undefined,
      counts: { providerCalls: 0, changed: index },
    }, { maxEvents: 10, maxBytes: 32 * 1024 });
  }
  const events = await readLifecycleAudit(root, 100);
  assert.equal(events.length, 10);
  assert.equal(events.at(-1).result, "error");
  const info = await inspectLifecycleAudit(root);
  assert.ok(info.bytes < 32 * 1024, JSON.stringify(info));
  const raw = await readFile(info.path, "utf8");
  assert.doesNotMatch(raw, /sk-test-secret/);
  assert.match(raw, /API_KEY=\[redacted\]/);
  assert.match(raw, /unknown actor/);
});
