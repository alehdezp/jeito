import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { summarizeNavigationAudit } from "../scripts/navigation-audit.mjs";

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-audit-"));
}

async function writeAudit(root, records) {
  const log = join(root, ".pi", "navigation-setup.log.jsonl");
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(log, records.join("\n") + "\n");
  return log;
}

function record(overrides = {}) {
  return JSON.stringify({
    time: "2026-06-18T12:00:00.000Z",
    target: "/repo",
    trigger: "manual_prepare",
    backend: "graphify",
    lane: "graph",
    mode: "update",
    policy: "auto",
    status: "completed",
    command: ["node", "scripts/navigation-freshen.mjs", "graph"],
    writes: ["graphify-out/graph.json"],
    undo: ["Set graph.enabled=false"],
    verification: { passed: true, reason: "ok" },
    enabledLane: true,
    ...overrides,
  });
}

test("navigation audit summarizes valid, malformed, failed, guided, and blocked records without mutating log", async () => {
  const root = await fixture();
  const log = await writeAudit(root, [
    record(),
    record({ backend: "qmd", lane: "docs", status: "failed", verification: { passed: false, reason: "search failed" }, enabledLane: false }),
    record({ backend: "crg", lane: "architecture", policy: "guided", status: "skipped", enabledLane: false, verification: { passed: false, reason: "action was not automatic" } }),
    "{ malformed",
    JSON.stringify({ time: "2026-06-18T12:00:00.000Z", backend: "codanna", lane: "semantic", policy: "blocked", status: "skipped", enabledLane: false }),
  ]);
  const before = await readFile(log, "utf8");

  const result = await summarizeNavigationAudit(["--path", root]);
  const after = await readFile(log, "utf8");

  assert.equal(after, before);
  assert.equal(result.status, "warning");
  assert.equal(result.counts.byStatus.completed, 1);
  assert.equal(result.counts.byStatus.failed, 1);
  assert.equal(result.counts.byStatus.skipped, 2);
  assert.equal(result.counts.byPolicy.guided, 1);
  assert.equal(result.counts.byPolicy.blocked, 1);
  assert.deepEqual(result.enabled_lanes, ["graph:graphify"]);
  assert.deepEqual(result.failed_lanes, ["docs:qmd"]);
  assert.deepEqual(result.malformed_lines.map(item => item.line), [4]);
  assert.deepEqual(result.validation_errors.map(item => `${item.line}:${item.field}`), ["5:undo", "5:verification", "5:writes", "5:command"]);
  assert.match(result.summary, /completed 1, failed 1, skipped 2, guided 1, blocked 1/);
  assert.ok(result.next_actions.some(action => /malformed JSONL/.test(action)));
  assert.ok(result.recovery.stop_conditions.includes("records lack undo/verification/writes/command"));
});

test("navigation audit supports --since and CLI JSON output", async () => {
  const root = await fixture();
  const oldSecret = "old-audit-token-value-123456789";
  await writeAudit(root, [
    record({ time: "2026-06-17T11:00:00.000Z", backend: "old", lane: "graph", stdout: oldSecret }),
    record({ time: "2026-06-18T11:00:00.000Z", backend: "new", lane: "docs" }),
  ]);

  const result = await summarizeNavigationAudit(["--path", root, "--since", "24h"], {
    now: new Date("2026-06-18T12:00:00.000Z"),
    env: { PI_NAV_TEST_TOKEN: oldSecret },
  });
  assert.equal(result.counts.byStatus.completed, 1);
  assert.deepEqual(result.enabled_lanes, ["docs:new"]);
  assert.equal(result.since.cutoffIso, "2026-06-17T12:00:00.000Z");
  assert.deepEqual(result.privacy_findings, []);

  const run = spawnSync(process.execPath, ["scripts/navigation-audit.mjs", "--path", root, "--json"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.status, "success");
  assert.equal(parsed.counts.byStatus.completed, 2);
  assert.deepEqual(parsed.artifacts, [".pi/navigation-setup.log.jsonl"]);
});

test("navigation audit reports missing log as recoverable warning", async () => {
  const root = await fixture();
  const result = await summarizeNavigationAudit(["--path", root]);

  assert.equal(result.status, "warning");
  assert.match(result.summary, /No navigation audit log found/);
  assert.deepEqual(result.counts.byStatus.completed, 0);
  assert.ok(result.next_actions[0].includes("nav:prepare"));
});

test("package scripts expose nav:audit", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["nav:audit"], "node scripts/navigation-audit.mjs");
});
