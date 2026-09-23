import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendWorkUnit, startWorkUnit } from "../src/core/performance-telemetry.ts";

test("work-unit telemetry records attributable bounded work without normal output", async () => {
  const unit = startWorkUnit({
    subsystem: "benchmark",
    operation: "fixture",
    root: "/tmp/example",
    trigger: "test",
    generation: 7,
    fileCount: 3,
    lineCount: 20,
    byteCount: 120,
    providerCalls: 0,
  });
  await new Promise(resolve => setTimeout(resolve, 15));
  const record = unit.finish("success", undefined, { changedCount: 1 });
  assert.equal(record.subsystem, "benchmark");
  assert.equal(record.operation, "fixture");
  assert.equal(record.generation, 7);
  assert.equal(record.changedCount, 1);
  assert.equal(record.outcome, "success");
  assert.ok(record.durationMs >= 10);
  assert.ok(record.cpuUserMs >= 0);
  assert.ok(record.cpuSystemMs >= 0);
  assert.ok(record.eventLoopMaxMs >= 0);
  assert.equal(typeof record.rssDeltaBytes, "number");

  const dir = await mkdtemp(join(tmpdir(), "pi-nav-telemetry-"));
  const path = join(dir, "records.jsonl");
  await appendWorkUnit(record, path);
  const saved = JSON.parse((await readFile(path, "utf8")).trim());
  assert.equal(saved.operation, "fixture");
  assert.equal(saved.providerCalls, 0);
});

test("work-unit telemetry rejects a second finish", () => {
  const unit = startWorkUnit({ subsystem: "edit", operation: "one-shot" });
  unit.finish();
  assert.throws(() => unit.finish(), /already finished/);
});
