import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

import jeitoCodeweavePiExtension from "../index.ts";
import { registerDiffTool } from "../src/tools/diff.ts";
import { callPiNav } from "../src/core/pi-nav-native.ts";

function makePi() {
  const tools = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, { ...tool, sourceInfo: { source: "jeito-codeweave-pi-test" } }); },
    on() {},
    getActiveTools() { return []; },
    getAllTools() { return [...tools.values()]; },
    tool(name) {
      const tool = tools.get(name);
      assert.ok(tool, `missing loaded tool ${name}`);
      return tool;
    },
  };
}

async function call(tool, params, cwd) {
  const result = await tool.execute(`test-${tool.name}`, params, undefined, undefined, { cwd });
  return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}
async function callResult(tool, params, cwd) {
  return tool.execute(`test-${tool.name}`, params, undefined, undefined, { cwd });
}

function git(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
  return res.stdout;
}

/** Git-only diff fixture: real repository, real working-tree change, and no
 * prepared graph store of any kind. Review/impact therefore exercise the
 * "no published indexed planning" path with exact Git evidence. */
async function diffFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "diff-views-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export function changedSymbol() {\n  return 1;\n}\n");
  await writeFile(join(root, "src", "caller.ts"), "import { changedSymbol } from './app';\n\n\n\nexport function callerSymbol() {\n  const value = changedSymbol();\n  return value;\n}\n");

  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  await writeFile(join(root, "src", "app.ts"), options.commentOnly ? "// comment-only\nexport function changedSymbol() {\n  return 1;\n}\n" : "export function changedSymbol() {\n  return 2;\n}\n");
  return root;
}

// Exercise the adapter's temporal boundary without requiring a replacement of
// the installed addon. Existing tests below still exercise its real diff path.
function nativeDiffFixture({ role = "changed_symbol", change = "body_changed" } = {}) {
  return async ({ operation }) => {
    assert.equal(operation, "pi_nav_diff");
    const symbol = { name: "changedSymbol", change, location: { path: "src/app.ts", start: 1, end: 3, role } };
    return {
      text: "# Diff: src/app.ts — changedSymbol\n",
      structured: { data: { files: [{ path: "src/app.ts", change: "modified" }], symbols: [symbol], locations: role === "changed_symbol" ? [symbol.location] : [] }, completeness: { complete: true }, diagnostics: [] },
    };
  };
}

test("diff review reports unavailable changed ranges while preserving independent evidence", async t => {
  const root = await diffFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  // Real Git name-only succeeds, but the patch exceeds runGitDiff's maxBuffer.
  // The changed declaration still has the fixture's valid three-line range.
  await writeFile(join(root, "src", "app.ts"), `export function changedSymbol() {\n  return 2; // ${"x".repeat(1_100_000)}\n}\n`);
  assert.equal(git(root, "diff", "--name-only", "--", "src/app.ts").trim(), "src/app.ts");
  for (const structuralFails of [false, true]) {
    let nativeCalls = 0;
    const pi = makePi();
    registerDiffTool(pi, { callNative: async request => {
      if (request.operation === "pi_nav_search") throw new Error("no indexed owner may be queried for planning");
      nativeCalls += 1;
      if (structuralFails) throw new Error("independent structural failure");
      return callPiNav(request);
    } });
    const result = await callResult(pi.tool("diff"), { root, scope: "src/app.ts", view: "review", budget: 12000 }, root);
    const text = result.content[0].text;
    assert.equal(nativeCalls, 1);
    assert.equal(result.details.status, "partial");
    assert.equal(result.details.envelope.status, "warning");
    // The exact Git receipt survives even when the ranged patch capture fails;
    // a missing range is unavailable, never an empty one.
    assert.deepEqual(result.details.diff.exactFiles, ["src/app.ts"]);
    assert.equal(result.details.diff.exactRangesStatus, "unavailable");
    assert.equal(Object.hasOwn(result.details.diff, "exactRanges"), false, "failure cannot manufacture an empty range array");
    assert.match(result.details.diff.exactRangesDiagnostics.join("\n"), /maxBuffer/);
    assert.match(result.details.envelope.diagnostics.join("\n"), /maxBuffer/);
    if (structuralFails) {
      assert.match(text, /independent structural failure/);
      assert.equal(result.details.native, undefined);
    } else {
      // The oversized ranged capture fails, so the independent Git comparison
      // check (which needs the same capture) is what withholds optional support;
      // that precedence is reported rather than hidden behind a graph reason.
      assert.match(text, /Explanatory support withheld: the independent Git comparison check failed/);
    }
    // Unavailable changed ranges must not suppress the change itself: the paired
    // before/after unit still comes from the independently captured Git patch.
    assert.match(text, /Exact before\/after patch|src\/app\.ts/);
    assert.doesNotMatch(text, /Risk score|Test gaps|Affected flows|Connecting edges/);
  }
});

test("diff review keeps successful empty changed ranges distinct from failure", async t => {
  const root = await diffFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "checkout", "--", "src/app.ts");
  // A genuine mode-only Git patch has a changed file but no textual hunks.
  await chmod(join(root, "src", "app.ts"), 0o755);
  assert.match(git(root, "diff", "--", "src/app.ts"), /new mode 100755/);
  const pi = makePi();
  registerDiffTool(pi, { callNative: async request => {
    if (request.operation === "pi_nav_search") throw new Error("no indexed owner may be queried for planning");
    return callPiNav(request);
  } });
  const result = await callResult(pi.tool("diff"), { root, scope: "src/app.ts", view: "review", budget: 12000 }, root);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.envelope.status, "warning");
  assert.equal(result.details.diff.exactRangesStatus, "success");
  assert.deepEqual(result.details.diff.exactRanges, [], "a mode-only change has a successful empty range set");
  assert.equal(result.details.diff.exactRangesDiagnostics, undefined);
  assert.match(result.content[0].text, /no published indexed code graph may be read for this scope/);
  assert.doesNotMatch(result.content[0].text, /Risk score|Test gaps/);
});

test("diff impact and review without indexed planning report it unavailable instead of a fabricated zero", async t => {
  const root = await diffFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const projections = [];
  const pi = makePi();
  registerDiffTool(pi, { callNative: async request => {
    if (request.operation === "pi_nav_search") {
      projections.push(request.args.analysisProjection);
      throw new Error("an absent indexed owner must not be queried for planning");
    }
    return callPiNav(request);
  } });

  const impact = await callResult(pi.tool("diff"), { root, scope: "src/app.ts", view: "impact", budget: 8000 }, root);
  const impactText = impact.content[0].text;
  assert.match(impactText, /Diff impact/);
  assert.match(impactText, /Exact changed files \(1\): src\/app\.ts/);
  assert.match(impactText, /WARNING: indexed planning evidence unavailable for diff impact/);
  assert.match(impactText, /no published indexed code graph may be read for this scope/);
  assert.match(impactText, /no legacy graph query was issued/);
  assert.doesNotMatch(impactText, /0 impacted node|Prepared blast radius/);
  assert.equal(impact.details.envelope.status, "warning");

  const review = await callResult(pi.tool("diff"), { root, scope: "src/app.ts", view: "review", budget: 12000 }, root);
  const reviewText = review.content[0].text;
  assert.match(reviewText, /Diff review/);
  assert.match(reviewText, /no published indexed code graph may be read for this scope/);
  assert.doesNotMatch(reviewText, /Risk score|Test gaps|Affected flows|Impacted nodes/);
  assert.equal(review.details.envelope.status, "warning");

  assert.deepEqual(projections, [], "an absent indexed owner must not be queried for planning");
});

test("diff view:structure preserves typed pi-nav changed-symbol evidence", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const root = await diffFixture();

  const out = await call(pi.tool("diff"), { root, scope: "src/app.ts", view: "structure", search: "changed", budget: 6000 }, root);
  assert.match(out, /# Diff: src\/app\.ts/);
  assert.match(out, /changedSymbol/);
  assert.match(out, /L1-3|src\/app\.ts:1-3/);
  assert.doesNotMatch(out, /Handoff identities/);
  assert.doesNotMatch(out, /grep|scanner|fallback navigation/i);
});

test("explicit diff summary includes changed files and structural symbols without planning work", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const root = await diffFixture();

  const out = await call(pi.tool("diff"), { root, scope: "src/app.ts", view: "summary", budget: 6000 }, root);
  assert.match(out, /Read-only unstaged working-tree summary under src\/app\.ts/);
  assert.match(out, /Changed files \(1\)/);
  assert.match(out, /src\/app\.ts/);
  assert.match(out, /Changed-symbol structure/);
  assert.match(out, /changedSymbol/);
  assert.doesNotMatch(out, /risk_score|review_priorities|Review context|Impacted nodes/);
});

test("diff automatically follows an explicit scope into another repository", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const root = await diffFixture();
  const externalRoot = await diffFixture();

  const external = await call(pi.tool("diff"), { root, scope: join(externalRoot, "src", "app.ts"), view: "patch", budget: 6000 }, root);
  assert.match(external, /Read-only unstaged working-tree patch/);
  assert.match(external, /src\/app\.ts/);

  const rootScope = await call(pi.tool("diff"), { root, scope: ".", view: "summary", budget: 6000 }, root);
  assert.match(rootScope, /Read-only unstaged working-tree summary under \./);
  assert.match(rootScope, /src\/app\.ts/);
});

test("diff ignores obsolete Tilth configuration and keeps the bundled native route", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const root = await diffFixture();
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    tilth: { enabled: true, command: join(root, "missing-tilth") },
  }, null, 2));

  const out = await call(pi.tool("diff"), { root, scope: "src/app.ts", view: "structure", budget: 4000 }, root);
  assert.match(out, /# Diff: src\/app\.ts/);
  assert.match(out, /changedSymbol/);
  assert.doesNotMatch(out, /grep\(|find\(|read\(|bash\(/i);
});

test("diff keeps default exact and structural evidence on the same unstaged source", async () => {
  const root = await mkdtemp(join(tmpdir(), "diff-source-alignment-"));
  await writeFile(join(root, "staged.ts"), "export function stagedFn(){ return 1; }\n");
  await writeFile(join(root, "unstaged.ts"), "export function unstagedFn(){ return 1; }\n");
  git(root, "init", "-q"); git(root, "config", "user.email", "test@example.com"); git(root, "config", "user.name", "Test"); git(root, "add", "."); git(root, "commit", "-q", "-m", "base");
  await writeFile(join(root, "staged.ts"), "export function stagedFn(){ return 2; }\n"); git(root, "add", "staged.ts");
  await writeFile(join(root, "unstaged.ts"), "export function unstagedFn(){ return 2; }\n");
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const result = await callResult(pi.tool("diff"), { root, view: "summary", budget: 5000 }, root);
  const text = result.content[0].text;
  assert.match(text, /Changed files \(1\)/);
  assert.match(text, /unstaged\.ts/);
  assert.doesNotMatch(text, /\bstagedFn\b|^- M staged\.ts/m);
  assert.deepEqual(result.details.native.data.files.map(file => file.path), ["unstaged.ts"]);
});

test("diff file pairs resolve relative to root and detect NUL or invalid UTF-8 before text rendering", async () => {
  const root = await mkdtemp(join(tmpdir(), "diff-binary-pair-"));
  const callerCwd = await mkdtemp(join(tmpdir(), "diff-binary-caller-"));
  await writeFile(join(root, "a.bin"), Buffer.from([0x00, 0x41]));
  await writeFile(join(root, "b.bin"), Buffer.from([0x00, 0x42]));
  const pi = makePi(); registerDiffTool(pi);
  const nul = await call(pi.tool("diff"), { root, a: "a.bin", b: "b.bin", view: "patch" }, callerCwd);
  assert.match(nul, /Binary files differ/);
  assert.doesNotMatch(nul, /No changes|\u0000/);
  await writeFile(join(root, "a.bin"), Buffer.from([0xff]));
  await writeFile(join(root, "b.bin"), Buffer.from([0xfe]));
  const invalidUtf8 = await call(pi.tool("diff"), { root, a: "a.bin", b: "b.bin", view: "patch" }, callerCwd);
  assert.match(invalidUtf8, /Binary files differ/);
});

test("diff preserves spaces in staged rename paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "diff-rename-space-"));
  await writeFile(join(root, "old name.ts"), "export const value = 1;\n");
  git(root, "init", "-q"); git(root, "config", "user.email", "test@example.com"); git(root, "config", "user.name", "Test"); git(root, "add", "."); git(root, "commit", "-q", "-m", "base");
  await rename(join(root, "old name.ts"), join(root, "new name.ts")); git(root, "add", "-A");
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const out = await call(pi.tool("diff"), { root, source: "staged", view: "summary" }, root);
  assert.match(out, /old name\.ts → new name\.ts/);
  assert.doesNotMatch(out, /old → name/);
});

test("diff review preserves deleted-file change evidence without inventing consumers", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const root = await diffFixture();
  await rm(join(root, "src", "app.ts"));
  const out = await call(pi.tool("diff"), { root, scope: "src/app.ts", view: "review", budget: 8000 }, root);
  assert.match(out, /Diff review/);
  assert.match(out, /src\/app\.ts/);
  assert.match(out, /- old:1,3 new:—|return 1;/);
  assert.match(out, /no published indexed code graph may be read for this scope/);
  assert.doesNotMatch(out, /UNCHANGED CONSUMER SOURCE|callerSymbol\(\)/);
});

test("diff summary keeps exact files and warning status when native structure fails", async () => {
  const root = await diffFixture();
  const pi = makePi(); registerDiffTool(pi, { callNative: async () => { throw new Error("synthetic unavailable"); } });
  const result = await callResult(pi.tool("diff"), { root, view: "summary" }, root);
  assert.match(result.content[0].text, /Changed files \(1\)/);
  assert.match(result.content[0].text, /synthetic unavailable/);
  assert.equal(result.details.envelope.status, "warning");
  assert.equal(result.details.status, "partial");
});

test('direct Diff bounds whole replies and hands off oversized paired lines with raw version identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'diff-direct-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createHash } = await import('node:crypto');
  const dense = Array.from({ length: 6000 }, (_, i) => String.fromCharCode(0x4e00 + i)).join(' ');
  const before = `\ufeffbefore ${dense}\r\n`, after = `\ufeffafter ${dense}\r\n`;
  await writeFile(join(root, 'before.txt'), before);
  await writeFile(join(root, 'after.txt'), after);
  const pi = makePi(); let nativeCalls = 0;
  registerDiffTool(pi, { callNative: async () => { nativeCalls++; throw new Error('direct text comparison must not call native'); } });
  const tokenizer = new Tiktoken(o200kBase);
  for (const view of ['summary', 'patch']) {
    const result = await callResult(pi.tool('diff'), { a: 'before.txt', b: 'after.txt', view }, root);
    const text = result.content.map(part => part.text ?? '').join('\n');
    assert.ok(tokenizer.encode(text, [], []).length <= 8000);
    assert.equal(result.details.envelope.status, 'warning');
    assert.match(text, /Paired source withheld/);
    assert.ok(!text.includes(dense.slice(0, 40)), 'no broken source line may survive');
    for (const [name, source] of [['before.txt', before], ['after.txt', after]]) {
      assert.ok(text.includes(createHash('sha256').update(source).digest('hex')), 'digest must cover raw BOM/CRLF bytes, not decoded text');
      assert.ok(text.includes(JSON.stringify({ path: `${join(root, name)}:1-1` })));
    }
    assert.match(text, /verify the captured digests/);
    const tiny = await callResult(pi.tool('diff'), { a: 'before.txt', b: 'after.txt', view, budget: 1 }, root);
    assert.equal(tiny.details.envelope.status, 'error');
    assert.ok(tokenizer.encode(tiny.content[0].text, [], []).length <= 8000);
  }
  assert.equal(nativeCalls, 0);
});

test('direct Diff refits captured context without splitting the changed line pair', async t => {
  const root = await mkdtemp(join(tmpdir(), 'diff-direct-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const row = Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x4e00 + i)).join(' ');
  const before = Array.from({ length: 120 }, (_, i) => `${i}: ${row}`);
  const after = [...before]; after[50] += ' CHANGED';
  await writeFile(join(root, 'a.txt'), before.join('\n'));
  await writeFile(join(root, 'b.txt'), after.join('\n'));
  const pi = makePi(); registerDiffTool(pi);
  const result = await callResult(pi.tool('diff'), { a: 'a.txt', b: 'b.txt', expand: 120 }, root);
  const text = result.content[0].text;
  assert.ok(new Tiktoken(o200kBase).encode(text, [], []).length <= 8000);
  assert.equal(result.details.envelope.status, 'warning');
  assert.match(text, /context reduced/);
  assert.ok(text.includes(`-51:${before[50]}`));
  assert.ok(text.includes(`+51:${after[50]}`));
  assert.doesNotMatch(text, /Paired source withheld/);
});

test('repository summary fits complete file identities rather than clipping a dense inventory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'diff-summary-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  const names = Array.from({ length: 80 }, (_, i) => `${i}-${Array.from({ length: 50 }, (_, j) => String.fromCharCode(0x4e00 + i * 50 + j)).join('')}.txt`);
  for (const name of names) await writeFile(join(root, name), 'before\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  for (const name of names) await writeFile(join(root, name), 'after\n');
  const pi = makePi(); registerDiffTool(pi, { callNative: async () => { throw new Error('fixture structural enrichment unavailable'); } });
  const result = await callResult(pi.tool('diff'), { view: 'summary' }, root);
  const text = result.content[0].text;
  assert.ok(new Tiktoken(o200kBase).encode(text, [], []).length <= 4000, 'repository inventory has a 4000-token ceiling');
  const shown = text.split('\n').filter(line => line.startsWith('- M ')).map(line => line.slice(4));
  assert.ok(shown.length > 0, 'a bounded refusal is not useful file-inventory delivery');
  assert.ok(shown.every(name => names.includes(name)), 'every shown file identity must remain complete');
  assert.match(text, /omitted/);
  assert.equal(result.details.envelope.status, 'warning');
  assert.deepEqual(new Set(result.details.diff.exactFiles), new Set(names));
  assert.equal(result.details.diff.displayedFileCount, shown.length);
});

test('direct Diff rejects fractional context instead of fabricating fractional source rows', async () => {
  const pi = makePi(); let nativeCalls = 0;
  registerDiffTool(pi, { callNative: async () => { nativeCalls++; throw new Error('invalid context must not dispatch'); } });
  const result = await callResult(pi.tool('diff'), { a: 'a.txt', b: 'b.txt', expand: 0.5 }, tmpdir());
  assert.equal(result.details.envelope.status, 'error');
  assert.match(result.content[0].text, /integer count of context lines/);
  assert.equal(nativeCalls, 0);
});

test('Diff runtime failure echoes stay bounded without presenting a successful empty comparison', async t => {
  const root = await mkdtemp(join(tmpdir(), 'diff-error-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  const huge = '界 '.repeat(10000);
  const pi = makePi(); let nativeCalls = 0;
  registerDiffTool(pi, { callNative: async () => { nativeCalls++; throw new Error('invalid Git/path requests must not dispatch'); } });
  for (const params of [{ root: huge }, { a: huge, b: huge }, { scope: huge }, { source: huge, view: 'patch' }]) {
    const result = await callResult(pi.tool('diff'), params, root);
    const text = result.content[0].text;
    assert.match(text, /^ERROR:/);
    assert.ok(new Tiktoken(o200kBase).encode(text, [], []).length <= 4000);
    assert.doesNotMatch(JSON.stringify(result), /(?:界 ){500}/);
  }
  assert.equal(nativeCalls, 0);
});

test('repository patch preserves complete small file patches and version locators for oversized siblings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'diff-patch-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  for (const name of ['a-small.txt', 'b-big.txt', 'z-small.txt']) await writeFile(join(root, name), 'before\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  const dense = Array.from({ length: 6000 }, (_, i) => String.fromCharCode(0x4e00 + i)).join(' ');
  await writeFile(join(root, 'b-big.txt'), `${dense}\n`);
  for (const name of ['a-small.txt', 'z-small.txt']) await writeFile(join(root, name), 'after with trailing spaces  \n');
  const beforeBlob = git(root, 'rev-parse', 'HEAD:b-big.txt').trim();
  const afterBlob = git(root, 'hash-object', 'b-big.txt').trim();
  const pi = makePi(); let nativeCalls = 0;
  registerDiffTool(pi, { callNative: async () => { nativeCalls++; throw new Error('raw patch must not call native'); } });
  const result = await callResult(pi.tool('diff'), { view: 'patch', budget: 200000 }, root);
  const text = result.content[0].text;
  assert.ok(new Tiktoken(o200kBase).encode(text, [], []).length <= 8000, 'raised character allowance cannot bypass the token ceiling');
  for (const name of ['a-small.txt', 'z-small.txt']) {
    const patch = git(root, '-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '--full-index', '--', name);
    assert.ok(text.includes(patch), `complete captured source and trailing spaces retained for ${name}`);
  }
  assert.match(text, /1 captured file patch\(es\) withheld/);
  assert.match(text, /diff --git a\/b-big\.txt b\/b-big\.txt/);
  assert.ok(text.includes(`index ${beforeBlob}..${afterBlob}`));
  assert.ok(text.includes('@@ -1 +1 @@'));
  assert.ok(!text.includes(dense.slice(0, 30)), 'no broken prefix of the oversized source line survives');
  assert.equal(result.details.envelope.status, 'warning');
  assert.equal(nativeCalls, 0);
});

test('binary aliases and empty-comparison identities cannot bypass final reply ceilings', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'diff-identity-budget-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  await writeFile(join(root, 'a.bin'), Buffer.from([0, 1]));
  await writeFile(join(root, 'b.bin'), Buffer.from([0, 2]));
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, ':literal.txt'), 'before\n');
  git(root, 'add', '--', './:literal.txt'); git(root, 'commit', '-qm', 'baseline');
  await writeFile(join(root, ':literal.txt'), 'after\n');
  const alias = './'.repeat(10000);
  const pi = makePi(); let nativeCalls = 0;
  registerDiffTool(pi, { callNative: async () => { nativeCalls++; throw new Error('no native evidence requested'); } });
  const binary = await callResult(pi.tool('diff'), { a: `${alias}a.bin`, b: `${alias}b.bin`, budget: 200000 }, root);
  assert.match(binary.content[0].text, /Binary files differ:/);
  assert.ok(binary.content[0].text.includes(join(root, 'a.bin')));
  assert.ok(new Tiktoken(o200kBase).encode(binary.content[0].text, [], []).length <= 8000);
  for (const view of ['impact', 'review']) {
    const result = await callResult(pi.tool('diff'), { view, scope: `${alias}a.bin`, budget: 200000 }, root);
    assert.match(result.content[0].text, /no tracked changed files detected.*under \.\/a\.bin/);
    const tiny = await callResult(pi.tool('diff'), { view, scope: 'a.bin', budget: 1 }, root);
    assert.equal(tiny.details.envelope.status, 'error');
    assert.ok(new Tiktoken(o200kBase).encode(result.content[0].text, [], []).length <= 4000);
  }
  const literal = await callResult(pi.tool('diff'), { view: 'patch', scope: `${alias}:literal.txt` }, root);
  assert.match(literal.content[0].text, /under \.\/:literal\.txt/);
  assert.match(literal.content[0].text, /\+after/);
  assert.equal(nativeCalls, 0);
});

test('repository patch retains a complete affordable hunk inside an oversized file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'diff-hunk-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  const lines = Array.from({ length: 30 }, (_, i) => `stable ${i}`);
  await writeFile(join(root, 'mixed.txt'), lines.join('\n') + '\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  const dense = Array.from({ length: 6000 }, (_, i) => String.fromCharCode(0x4e00 + i)).join(' ');
  lines[0] = dense; lines[20] = 'small after  ';
  await writeFile(join(root, 'mixed.txt'), lines.join('\n') + '\n');
  const raw = git(root, 'diff', '--no-color', '--full-index', '--', 'mixed.txt');
  const hunks = [...raw.matchAll(/^@@ /gm)].map(match => match.index);
  assert.equal(hunks.length, 2, 'independent hunk discriminator');
  const pi = makePi(); registerDiffTool(pi, { callNative: async () => { throw new Error('raw patch must not collect native evidence'); } });
  const result = await callResult(pi.tool('diff'), { view: 'patch', budget: 200000 }, root);
  const text = result.content[0].text;
  assert.ok(text.includes(raw.slice(0, hunks[0]) + raw.slice(hunks[1])), 'captured file header and complete second hunk survive together');
  assert.ok(!text.includes(dense.slice(0, 30)));
  assert.match(text, /withheld in whole or part/);
  assert.match(text, /first missing hunk locators/);
  assert.equal(result.details.envelope.status, 'warning');
  assert.ok(new Tiktoken(o200kBase).encode(text, [], []).length <= 8000);
});
