import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// F1: audit must not warn forever about historically-failed lanes that were later
// repaired (a later completed record supersedes the failure). We exercise the
// summarize logic by constructing an audit JSONL and running the audit CLI.

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-audit-f1-"));
}

function rec(status, lane, extra = {}) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    trigger: "manual",
    target: lane,
    lane,
    backend: "Graphify",
    mode: "update",
    policyReason: "auto",
    status,
    command: "graphify update",
    writes: [],
    verification: status === "completed" ? { passed: true } : { passed: false },
    undoGuidance: "rerun",
    ...extra,
  });
}

test("F1: a lane that failed then completed is resolved (not in failed_lanes)", async () => {
  const root = await fixture();
  const log = join(root, ".pi", "navigation-setup.log.jsonl");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, ".pi"), { recursive: true });
  // chronologically: fail, then completed (repaired)
  await writeFile(log, [rec("failed", "graph"), rec("completed", "graph")].join("\n") + "\n");

  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(process.execPath, ["scripts/navigation-audit.mjs", "--path", root, "--json"], { encoding: "utf8" });
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.failed_lanes, [], `expected no current failures: ${JSON.stringify(out.failed_lanes)}`);
  assert.deepEqual(out.resolved_failed_lanes, ["graph:Graphify"]);
  assert.match(out.summary, /now resolved/);
  await rm(root, { recursive: true, force: true });
});

test("F1: a lane whose last record is still failed remains a current failure", async () => {
  const root = await fixture();
  const log = join(root, ".pi", "navigation-setup.log.jsonl");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, ".pi"), { recursive: true });
  // chronologically: completed, then failed (still broken)
  await writeFile(log, [rec("completed", "graph"), rec("failed", "graph")].join("\n") + "\n");

  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(process.execPath, ["scripts/navigation-audit.mjs", "--path", root, "--json"], { encoding: "utf8" });
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.failed_lanes, ["graph:Graphify"]);
  assert.deepEqual(out.resolved_failed_lanes, []);
  await rm(root, { recursive: true, force: true });
});
