// Decision protected: doctor reports provider readiness and configuration faults without exposing credential values.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDoctorReport } from "../src/doctor.ts";
import { AdapterRegistry } from "../src/registry.ts";

function capability(id, operations, credentials = []) {
  return { id, operations, credentials, strengths: ["general"], returns: ["leads"], timeoutMs: 1000, concurrency: 1, fallbackEligible: true, provenance: "test" };
}

test("web doctor reports secret-safe provider and operation readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websift-doctor-"));
  const path = join(root, "web.yaml");
  const secret = "must-not-appear-in-doctor";
  try {
    writeFileSync(path, `providers:\n  serper: { apiKey: ${secret} }\n`);
    chmodSync(path, 0o644);
    const registry = new AdapterRegistry([
      { capability: capability("serper", ["search"], ["SERPER_API_KEY"]) },
      { capability: capability("webclaw", ["fetch"]) },
    ]);
    const report = await buildDoctorReport(registry, path);
    assert.deepEqual(report.operations.search, ["serper"]);
    assert.deepEqual(report.operations.fetch, ["webclaw"]);
    assert.ok(report.warnings.includes("config_permissions_too_open"));
    assert.match(report.text, /inline credential/);
    assert.doesNotMatch(report.text, new RegExp(secret));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("web doctor makes malformed config actionable without throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websift-doctor-invalid-"));
  const path = join(root, "web.yaml");
  try {
    writeFileSync(path, "providers: [unterminated");
    const report = await buildDoctorReport(new AdapterRegistry([{ capability: capability("webclaw", ["fetch"]) }]), path);
    assert.ok(report.warnings.includes("config_parse_error"));
    assert.match(report.text, /invalid YAML; defaults active/);
    assert.match(report.text, /Fix .*web\.yaml/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("web doctor reports a missing config as defaults, not loaded", async () => {
  const path = join(tmpdir(), `jeito-websift-missing-${Date.now()}`, "web.yaml");
  const report = await buildDoctorReport(new AdapterRegistry([{ capability: capability("webclaw", ["fetch"]) }]), path);
  assert.match(report.text, /missing; defaults active/);
});