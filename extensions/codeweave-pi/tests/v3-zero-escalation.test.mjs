import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import test from "node:test";

import { probeZeroVisibility, shouldProbeZero } from "../src/core/zero-visibility-probe.ts";
import { registerFindTool } from "../src/tools/find.ts";
import { registerGrepTool } from "../src/tools/grep.ts";
import { registerLsTool, __lsInternals } from "../src/tools/ls.ts";

const { condenseListEntries, LS_INLINE_ENTRY_CAP } = __lsInternals;

test("shouldProbeZero fires only on complete project-scoped zeros", () => {
  assert.equal(shouldProbeZero({ returned: 0, complete: true, visibility: "project" }), true);
  assert.equal(shouldProbeZero({ returned: 3, complete: true, visibility: "project" }), false);
  assert.equal(shouldProbeZero({ returned: 0, complete: false, visibility: "project" }), false);
  assert.equal(shouldProbeZero({ returned: 0, complete: true, visibility: "all" }), false);
  assert.equal(shouldProbeZero({ returned: 0, complete: true, visibility: "project", isContinuation: true }), false);
});

function nativeOutput(overrides = {}) {
  return {
    text: "native",
    structured: {
      schemaVersion: 1,
      operation: "probe",
      data: {},
      completeness: { returned: 0, complete: true },
      diagnostics: [],
      ...overrides,
    },
  };
}

test("probeZeroVisibility reports filter-caused zeros with sample paths", async () => {
  const calls = [];
  const callNative = async (input) => {
    calls.push(input);
    return nativeOutput({
      data: { entries: [{ path: "agent/npm/node_modules/pi-blackhole/index.js" }, { path: "agent/npm/node_modules/pi-blackhole/dist/x.js" }] },
      completeness: { returned: 2, complete: true },
    });
  };
  const probe = await probeZeroVisibility({ callNative, root: "/r", operation: "pi_nav_files", args: { pattern: "index.ts", visibility: "project" }, timeoutMs: 1000 });
  assert.equal(probe.kind, "hits");
  assert.match(probe.text, /2 match\(es\) exist with configurable ignores disabled/);
  assert.match(probe.text, /filter-caused, not absence/);
  assert.match(probe.text, /pi-blackhole\/index\.js/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.visibility, "all");
  assert.equal(calls[0].args.pattern, "index.ts");
});

test("probeZeroVisibility verifies absence when the unfiltered scan is also empty", async () => {
  const probe = await probeZeroVisibility({ callNative: async () => nativeOutput(), root: "/r", operation: "pi_nav_ls", args: {}, timeoutMs: 1000 });
  assert.equal(probe.kind, "verified-zero");
  assert.match(probe.text, /absence is verified across both filtered and unfiltered scopes/);
});

test("probeZeroVisibility degrades to a retry hint on backend failure", async () => {
  const probe = await probeZeroVisibility({ callNative: async () => { throw new Error("deadline exceeded"); }, root: "/r", operation: "pi_nav_ls", args: {}, timeoutMs: 1000 });
  assert.equal(probe.kind, "failed");
  assert.match(probe.text, /auto-probe failed \(deadline exceeded\)/);
  assert.match(probe.text, /visibility:'all' to confirm/);
});

function captureTool(register, options) {
  let tool;
  register({ registerTool: (t) => { tool = t; } }, options);
  return tool;
}

test("find execute keeps a complete project zero to one native scan", async () => {
  const root = mkdtempSync(join(tmpdir(), "find-zero-"));
  const calls = [];
  const callNative = async (input) => {
    calls.push(input);
    return nativeOutput();
  };
  const tool = captureTool(registerFindTool, { callNative });
  const result = await tool.execute("id", { pattern: "index.ts", scope: root }, undefined, undefined, { cwd: root });
  const text = result.content[0].text;
  assert.equal(calls.length, 1, "project zero must not trigger an implicit all-visibility scan");
  assert.equal(calls[0].args.visibility, "project");
  assert.match(text, /Retry explicitly with visibility:'all' only if ignored content is relevant/);
  assert.doesNotMatch(JSON.stringify(result), /zero_visibility_probe=/);
});

test("grep execute keeps a complete project zero to one native scan", async () => {
  const root = mkdtempSync(join(tmpdir(), "grep-zero-"));
  const calls = [];
  const callNative = async (input) => {
    calls.push(input);
    return nativeOutput({
      operation: "pi_nav_search",
      data: { matches: [], coverage: { complete: true } },
      completeness: { returned: 0, total: 0, complete: true },
    });
  };
  const tool = captureTool(registerGrepTool, { callNative });
  const result = await tool.execute("id", { pattern: "absent", output: "ranked", syntax: "literal" }, undefined, undefined, { cwd: root });
  const text = result.content[0].text;
  assert.equal(calls.length, 1, "project zero must not trigger an implicit all-visibility scan");
  assert.equal(calls[0].args.visibility, "project");
  assert.match(text, /Retry explicitly with visibility:'all' only if ignored content is relevant/);
  assert.doesNotMatch(JSON.stringify(result), /zero_visibility_probe=/);
});

test("find execute never probes on hits or explicit all visibility", async () => {
  const root = mkdtempSync(join(tmpdir(), "find-noprobe-"));
  writeFileSync(join(root, "seen.ts"), "x");
  const calls = [];
  const callNative = async (input) => {
    calls.push(input);
    return nativeOutput({ completeness: { returned: 1, complete: true } });
  };
  const tool = captureTool(registerFindTool, { callNative });
  await tool.execute("id", { pattern: "seen.ts", scope: root }, undefined, undefined, { cwd: root });
  assert.equal(calls.length, 1, "hit result must not probe");
  await tool.execute("id", { pattern: "gone.ts", scope: root, visibility: "all" }, undefined, undefined, { cwd: root });
  assert.equal(calls.length, 2, "explicit all visibility must not probe");
});

test("condenseListEntries keeps header and first cap verbatim, marks the omission", () => {
  const entries = Array.from({ length: 120 }, (_, i) => `entry-${i}.ts  ~3 tokens`);
  const text = `# Directory: /big — live filesystem, complete\nFilter: project · no project ignore file · 0 excluded\n# 0 files, 120 directories — sorted by path\n\n${entries.join("\n")}\n`;
  const condensed = condenseListEntries(text, 50);
  assert.ok(condensed, "expected condensation above cap");
  assert.equal(condensed.total, 120);
  assert.equal(condensed.shown, 50);
  assert.match(condensed.text, /^# Directory: \/big/);
  assert.match(condensed.text, /entry-49\.ts/);
  assert.doesNotMatch(condensed.text, /entry-50\.ts/);
  assert.match(condensed.text, /70 more entries omitted by default condensation \(cap 50\)/);
  // Near-miss: at or below cap the text passes through untouched.
  assert.equal(condenseListEntries(text.replace("120 directories", "40 directories").split("\n").filter(l => !l.startsWith("entry-5") && !l.startsWith("entry-6") && !l.startsWith("entry-7") && !l.startsWith("entry-8") && !l.startsWith("entry-9") && !l.startsWith("entry-10") && !l.startsWith("entry-11")).join("\n"), 50), undefined);
});

test("condenseListEntries preserves a backend truncation note below the condensation marker", () => {
  const entries = Array.from({ length: 80 }, (_, i) => `entry-${i}.ts  ~3 tokens`);
  const text = `# Directory: /big — live filesystem, complete\nFilter: project · no project ignore file · 0 excluded\n# 0 files, 80 directories — sorted by path\n\n${entries.join("\n")}\n… truncated (20 entries omitted, budget: 4000)\n`;
  const condensed = condenseListEntries(text, 50);
  assert.ok(condensed);
  const omission = condensed.text.indexOf("more entries omitted by default condensation");
  const truncated = condensed.text.indexOf("… truncated (20 entries omitted");
  assert.ok(omission > 0 && truncated > omission, "condensation marker precedes backend truncation note");
});
