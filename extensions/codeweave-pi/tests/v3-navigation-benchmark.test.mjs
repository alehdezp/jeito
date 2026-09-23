import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runNavigationBenchmark } from "../scripts/navigation-benchmark.mjs";

test("navigation benchmark remains harness-shaped and query-time non-mutating", async () => {
  const result = await runNavigationBenchmark({ fixture: "synthetic" });
  assert.ok(["success", "warning", "error"].includes(result.status));
  assert.equal(result.metrics.query_time_mutations, 0);
  assert.ok(result.thresholds.query_time_mutations);
  assert.ok(result.recovery.safe_retry.includes("navigation-benchmark.mjs"));
});

test("navigation benchmark CLI writes JSON artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-benchmark-test-"));
  const out = join(root, "result.json");
  const run = spawnSync(process.execPath, ["scripts/navigation-benchmark.mjs", "--fixture", "synthetic", "--json", "--out", out], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  assert.ok(run.status === 0 || run.status === 2, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.metrics.query_time_mutations, 0);
  assert.equal(existsSync(out), true);
  const artifact = JSON.parse(await readFile(out, "utf8"));
  assert.equal(artifact.metrics.query_time_mutations, 0);
});
