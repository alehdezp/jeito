import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { __grepInternals } from "../src/tools/grep.ts";

const { resolveGrepPaths, renderRankedGrepEvidence, clarifyMatchesCoverage } = __grepInternals;

test("resolveGrepPaths resolves parent-relative and sibling paths against cwd", () => {
  const cwd = "/Users/example/.pi/agent/extensions/codeweave-pi";
  // The reported bug: ../sibling escaped the wrong base and returned ENOENT.
  assert.equal(resolveGrepPaths("../lean-bash/index.ts", cwd), "/Users/example/.pi/agent/extensions/lean-bash/index.ts");
  assert.equal(resolveGrepPaths("../lean-bash", cwd), "/Users/example/.pi/agent/extensions/lean-bash");
});

test("resolveGrepPaths leaves absolute paths untouched", () => {
  const cwd = "/some/cwd";
  const abs = "/Users/x/project/file.ts";
  assert.equal(resolveGrepPaths(abs, cwd), abs);
});

test("resolveGrepPaths expands ~ against home, matching resolveNavigationScope", () => {
  const home = homedir();
  assert.equal(resolveGrepPaths("~/project/file.ts", "/cwd"), `${home}/project/file.ts`);
  assert.equal(resolveGrepPaths("~root/x", "/cwd"), join(home, "root/x"));
});

test("resolveGrepPaths resolves in-project relative paths and preserves array order", () => {
  const cwd = "/Users/x/project";
  assert.equal(resolveGrepPaths("src/a.ts", cwd), "/Users/x/project/src/a.ts");
  // matches-mode ordered multi-target: order and per-target resolution preserved.
  const arr = resolveGrepPaths(["../sib/one.ts", "src/two.ts", "/abs/three.ts"], cwd);
  assert.deepEqual(arr, ["/Users/x/sib/one.ts", "/Users/x/project/src/two.ts", "/abs/three.ts"]);
});

test("resolveGrepPaths returns undefined for the default whole-project search", () => {
  assert.equal(resolveGrepPaths(undefined, "/cwd"), undefined);
});

test("ranked grep rendering keeps one compact scope header and bounded high-value rows", () => {
  const root = "/tmp/project";
  const matches = Array.from({ length: 13 }, (_, index) => ({
    name: index === 0 ? "registerGrepTool" : `usage${index}`,
    role: index === 0 ? "definition" : "usage",
    qualified_name: `${root}/src/grep.ts::${index === 0 ? "registerGrepTool" : `usage${index}`}`,
    location: { path: `${root}/src/grep.ts`, start: index + 1, end: index + 1 },
  }));
  const text = renderRankedGrepEvidence({
    data: { matches, coverage: { complete: true }, noisy_backend_metadata: { duplicate: true } },
    completeness: { returned: 13, total: 13, complete: true },
  }, root, "registerGrepTool", "auto→symbol", `${root}/src`);

  assert.match(text, /^Ranked exact search: "registerGrepTool"/);
  assert.match(text, /Scope: src · Resolved: auto→symbol · Coverage: 13\/13 result\(s\) · complete/);
  assert.match(text, /Definitions and usages[\s\S]*registerGrepTool · definition · src\/grep\.ts:1/);
  assert.match(text, /1 more ranked row\(s\) omitted from public text/);
  assert.equal((text.match(/^Scope:/gm) ?? []).length, 1);
  assert.doesNotMatch(text, /\/tmp\/project|noisy_backend_metadata|duplicate/);
});


test("certified ranked rendering preserves rich native fuzzy cards instead of rebuilding locators", () => {
  const native = "Route: behavior discovery\n\n## scheduleTokenRenewal — src/retry.ts [2-4]:\n2: export function scheduleTokenRenewal() {\n3:   return retryAfterExpiry();\n4: }\n\nLive source authority\n[src/retry.ts#A1B2C3D4] lines 2-4";
  const text = renderRankedGrepEvidence({
    data: { kind: "fuzzy", matches: [{ symbol: "scheduleTokenRenewal" }] },
    completeness: { returned: 1, total: 1, complete: true },
  }, "/tmp/project", "token expiry backoff", "auto→fuzzy", "/tmp/project/src", native);

  assert.match(text, /^Ranked behavior search: "token expiry backoff"/);
  assert.match(text, /Scope: src · Resolved: auto→fuzzy/);
  assert.match(text, /## scheduleTokenRenewal[\s\S]*3:   return retryAfterExpiry\(\);/);
  assert.equal(text.match(/^## scheduleTokenRenewal/gm)?.length, 1);
  assert.doesNotMatch(text, /Definitions and usages/);
});
test("matches coverage separates complete scanning from an incomplete cursor page", () => {
  const native = "Coverage: complete · 240 occurrences · 7 match lines on this page\nMore: cursor grep-abc";
  const text = clarifyMatchesCoverage(native, { complete: true, more: true });
  assert.match(text, /Coverage: scan complete · result page incomplete · 240 occurrences/);
  assert.match(text, /More: cursor grep-abc/);
  assert.equal(clarifyMatchesCoverage("Coverage: complete · 0 occurrences", { complete: true, more: false }), "Coverage: complete · 0 occurrences");
});
