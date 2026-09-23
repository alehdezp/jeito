// Focused graph-lane whole-reply budget tests: map (explore) and path/explain (trace)
// must fit the 4,000-token ceiling and the bounded character allowance via an
// explicit page-one restart (where existing paging allows) or a bounded fail-closed
// refusal — complete records are evaluated BEFORE any character trimming, so a
// compressible oversized identity is refused, never char-sliced into a fake success.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerCleanPi, tempProject, writeGraphifyFixture } from "./_clean-navigation-helper.mjs";
import { extensionRuntimePaths } from "../src/core/owned-runtime.ts";
import { referenceTokenCount } from "../src/core/harness-result.ts";
import { snapshots, computeTag } from "../src/core/snapshot-store.ts";

const tokens = text => referenceTokenCount(String(text ?? ""));
const callDirect = async (pi, cwd, name, params) => {
  const result = await pi.tool(name).execute(`graph-budget-${name}`, params, undefined, undefined, { cwd });
  return { text: result.content.filter(part => part.type === "text").map(part => part.text).join("\n"), details: result.details };
};

const short = "and the of a to in for on at by from with up down over under is are be it or as an this that was were has have had not yet but its our their your";
const COUNT_MARK = "graphify-run-count.txt";
// Fixture output must stay under the graphify capture byte cap (180,000) so no
// provider truncation marker pollutes the composition under test. Short lines keep
// 220 NODE+EDGE pairs (~100 KB) below the cap while both page 1 at a wide limit and
// page 2 at a reduced limit overflow the 4k/16KB gates (the character gate drives
// the restart even when the token density is modest).
function pressureScript(rowCount = 220) {
  const lines = [`#!/usr/bin/env node`, `if (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') process.exit(12);`,
    `require('node:fs').appendFileSync('${COUNT_MARK}', 'x');`];
  for (let i = 0; i < rowCount; i++) {
    const name = `${short} token ${String(i).padStart(3, "0")}`;
    const src = `src/a${i % 8}.ts`;
    lines.push(`console.log('NODE ${name} [src=${src} loc=L${(i % 7) + 1} community=${i % 5}]');`);
    lines.push(`console.log('EDGE ${name} --calls [EXTRACTED]--> ${short} peer ${(i + 1) % rowCount} @${src}:L${(i % 6) + 1}');`);
  }
  return lines.join("\n") + "\n";
}

function traceJsonPressureScript(rowCount = 220) {
  const items = Array.from({ length: rowCount }, (_unused, i) => ({
    id: `n${i}`, label: `${short} token ${String(i).padStart(3, "0")}`,
    source_file: "src/main.ts", line_start: 1, line_end: 1, kind: "function",
  }));
  const payload = JSON.stringify({ status: "ok", nodes: items, edges: [] });
  return `#!/usr/bin/env node
if (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') process.exit(12);
require('node:fs').appendFileSync('${COUNT_MARK}', 'x');
console.log(${JSON.stringify(payload)});
`;
}

async function graphProject(t, script) {
  const cwd = await tempProject("graph-budget-");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const graphify = await writeGraphifyFixture(cwd);
  writeFileSync(graphify, script);
  writeFileSync(extensionRuntimePaths().graphify, script);
  return { cwd, pi: registerCleanPi() };
}

for (const [name, args] of [
  ["explore", { view: "map", query: "HeartbeatCoordinator" }],
  ["trace", { relation: "explain", target: "HeartbeatCoordinator" }],
]) {
  test(`${name} graph lane ordinary control stays unchanged and under the 4,000-token ceiling`, async t => {
    const { cwd, pi } = await graphProject(t, `#!/usr/bin/env node
if (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') process.exit(12);
console.log('NODE HeartbeatCoordinator [src=src/main.ts loc=L1 community=1]');
console.log('EDGE HeartbeatCoordinator --calls [EXTRACTED]--> QueueProcessor @src/main.ts:L2');
`);
    const { text, details } = await callDirect(pi, cwd, name, { ...args, scope: cwd });
    assert.equal(details.budgetRestart, undefined, "ordinary control must not restart");
    assert.notEqual(details.envelope.status, "error", text);
    assert.ok(tokens(text) <= 4000, `${name} ordinary: ${tokens(text)} tokens`);
    assert.doesNotMatch(text, /restarted at page 1|reply withheld|\[truncated/);
    assert.doesNotMatch(JSON.stringify(details), /rawDigest|sourceSnapshots/);
  });

  test(`${name} graph lane pressure restarts oversized pages (pages 1 and 2) with a reduced limit and runs the backend once`, async t => {
    const script = name === "trace" ? traceJsonPressureScript() : pressureScript();
    for (const [page, limit] of [[1, name === "explore" ? 300 : 200], [2, 100]]) {
      const { cwd, pi } = await graphProject(t, script);
      const { text, details } = await callDirect(pi, cwd, name, { ...args, page, limit, scope: cwd });
      const restart = details.budgetRestart;
      assert.ok(restart && restart.limit < limit, `pressure page ${page} must exercise a real restart (${JSON.stringify(restart)}) tokens=${tokens(text)}`);
      assert.equal(restart.requestedPage, page);
      assert.equal(restart.page, 1);
      assert.match(text, new RegExp(`requested page ${page}, limit \\d+; restarted at page 1`));
      assert.match(text, /no generation is pinned/);
      assert.equal(details.envelope.status, "warning");
      assert.equal(details.status, "partial");
      assert.ok(tokens(text) <= 4000, `${name} pressure page ${page}: ${tokens(text)} tokens`);
      assert.doesNotMatch(text, /\[truncated/, `${name} pressure must not carry compose-level slicer markers (text ${text.length} chars)`);
      const windows = details.presentation?.pageWindows ?? [];
      for (const window of windows) {
        assert.equal(window.page, 1);
        assert.equal(window.page_size, restart.limit);
        assert.equal(window.omitted_before, 0);
      }
      const runs = readFileSync(join(cwd, COUNT_MARK), "utf8");
      assert.equal(runs, "x", `${name} graphify must run exactly once per execute; the fit recomposes from the captured output`);
      assert.doesNotMatch(JSON.stringify(details), /rawDigest|sourceSnapshots/);
    }
  });

  test(`${name} graph lane indivisible oversized identity fails closed with guidance and no oversized bytes or authority`, async t => {
    const huge = "S".repeat(20_000);
    const { cwd, pi } = await graphProject(t, `#!/usr/bin/env node
if (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') process.exit(12);
console.log('NODE ${huge} [src=src/main.ts loc=L1]');
`);
    const { text, details } = await callDirect(pi, cwd, name, { ...args, scope: cwd });
    assert.match(text, /reply withheld/);
    assert.match(text, /4,000-token/);
    assert.equal(details.envelope.status, "warning");
    assert.ok(tokens(text) <= 4000, `${name} indivisible: ${tokens(text)} tokens`);
    assert.doesNotMatch(JSON.stringify(details), /rawDigest|sourceSnapshots/);
  });

  test(`${name} graph lane compressible oversized identity is refused, never char-sliced into a success`, async t => {
    const compressible = "needleX ".repeat(6000);
    const { cwd, pi } = await graphProject(t, `#!/usr/bin/env node
if (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') process.exit(12);
console.log('NODE ${compressible} [src=src/main.ts loc=L1]');
`);
    const { text, details } = await callDirect(pi, cwd, name, { ...args, scope: cwd });
    assert.match(text, /reply withheld/);
    assert.equal(details.envelope.status, "warning");
    assert.ok(tokens(text) <= 4000, `${name} compressible: ${tokens(text)} tokens`);
    assert.doesNotMatch(text, /\[truncated|needleX needleX {2,}/, "no sliced identity or falsely delivered page");
    assert.doesNotMatch(JSON.stringify(details), /rawDigest|sourceSnapshots/);
  });
}

for (const [name, args] of [
  ["explore", { view: "map", query: "records" }],
  ["trace", { relation: "path", target: "start", to: "end" }],
]) test(`${name} refuses truncated backend capture before presenting a reconstructed graph page`, async t => {
  const { cwd, pi } = await graphProject(t, `#!/usr/bin/env node
if (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') process.exit(12);
for (let i = 0; i < 10000; i++) console.log('NODE record_' + i + ' [src=src/main.ts loc=L1 community=1]');
`);
  const { text, details } = await callDirect(pi, cwd, name, { ...args, scope: cwd });
  assert.match(text, /capture.*truncated/i);
  assert.equal(details.envelope.status, "warning");
  assert.ok(tokens(text) <= 4000);
  assert.doesNotMatch(text, /record_\d|\[truncated/);
  assert.deepEqual(details.envelope.artifacts, []);
});

test("map JSON-mode refunds source authority on refusal: staged rows are never committed", async t => {
  const cwd = await tempProject("graph-map-json-refusal-");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "src"), { recursive: true });
  const source = "export const main = 1;\n";
  writeFileSync(join(cwd, "src", "main.ts"), source);
  const compressible = "needleX ".repeat(6000);
  const graphify = await writeGraphifyFixture(cwd);
  const script = `#!/usr/bin/env node
if (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') process.exit(12);
console.log(${JSON.stringify(JSON.stringify({ nodes: [{ path: "src/main.ts", line: 1, label: compressible }],
  sourceRows: [{ path: "src/main.ts", line: 1, text: "export const main = 1;", visibility: "visible_complete", transformation: "verbatim" }] }))});
`;
  writeFileSync(extensionRuntimePaths().graphify, script);
  writeFileSync(graphify, script);
  const pi = registerCleanPi();
  const { text, details } = await callDirect(pi, cwd, "explore", { view: "map", query: "main", scope: cwd });
  assert.match(text, /reply withheld/);
  assert.ok(tokens(text) <= 4000, `map json refusal: ${tokens(text)} tokens`);
  const key = realpathSync(join(cwd, "src", "main.ts"));
  assert.equal(snapshots.byTag(key, computeTag(source)), undefined, "rejected map JSON must not commit staged source authority");
  assert.doesNotMatch(JSON.stringify(details), /rawDigest|sourceSnapshots/);
  // The same rows must actually be certifiable; checking a noncanonical cache
  // key or an unsupported evidence shape would let premature commits pass.
  const ordinary = script.replaceAll(compressible, "main");
  writeFileSync(extensionRuntimePaths().graphify, ordinary);
  writeFileSync(graphify, ordinary);
  const accepted = await callDirect(pi, cwd, "explore", { view: "map", query: "main", scope: cwd });
  assert.doesNotMatch(accepted.text, /reply withheld/);
  assert.ok(snapshots.byTag(key, computeTag(source)), "a delivered control must grant authority for these same source rows");
});