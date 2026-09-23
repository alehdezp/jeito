import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { registerGrepTool } from "../src/tools/grep.ts";
import { getEncoding } from "js-tiktoken";
import { snapshots } from "../src/core/snapshot-store.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";

test("oversized matches retain their audit contract and never issue an unscoped ranked retry", async () => {
  for (const params of [
    { pattern: "needle", paths: ["src/a.ts", "docs/policy.md"], output: "matches", syntax: "literal", visibility: "all" },
    { cursor: "grep-existing-page", contextLines: 0 },
  ]) {
    const calls = [];
    let tool;
    registerGrepTool({ registerTool: (t) => { tool = t; } }, {
      callNative: async (input) => {
        calls.push(input);
        throw new Error("[pi-nav:response_too_large] native text exceeded 131072 bytes; payload withheld");
      },
    });
    const result = await tool.execute("id", params, undefined, undefined, { cwd: "/tmp" });
    const text = result.content[0].text;
    assert.equal(calls.length, 1, "failure cannot silently change route or widen scope");
    assert.equal(calls[0].operation, "pi_nav_search");
    if (params.cursor) assert.equal(calls[0].args.cursor, params.cursor);
    else {
      assert.deepEqual(calls[0].args.paths, ["/tmp/src/a.ts", "/tmp/docs/policy.md"]);
      assert.equal(calls[0].args.output, "matches");
      assert.equal(calls[0].args.visibility, "all");
    }
    assert.match(text, /ERROR: exact search failed/);
    if (params.cursor) assert.match(text, /No continuation page was delivered/);
    else {
      assert.match(text, /Audit incomplete: no exact result page was delivered/);
      assert.match(text, /A ranked overview cannot replace exhaustive matches/);
    }
    assert.doesNotMatch(JSON.stringify(result), /matches_cap_fallback=|ranked overview follows/);
  }
});

test("non-cap errors keep the enriched error contract", async () => {
  let tool;
  registerGrepTool({ registerTool: (t) => { tool = t; } }, {
    callNative: async () => { throw new Error("backend exploded"); },
  });
  const result = await tool.execute("id", { pattern: "x", output: "matches" }, undefined, undefined, { cwd: "/tmp" });
  assert.match(result.content[0].text, /ERROR: exact search failed/);
  assert.doesNotMatch(result.content[0].text, /Recover: scope paths/);
});

test("Matches recovers unambiguous spelling but refuses conflicting intent and scope guessing", async () => {
  const calls = [];
  let tool;
  registerGrepTool({ registerTool: value => { tool = value; } }, { callNative: async input => {
    calls.push(input);
    return { text: "No matches.", structured: { schemaVersion: 1, operation: input.operation,
      data: { mode: "matches", coverage: { complete: true } },
      completeness: { returned: 0, total: 0, complete: true }, diagnostics: [] } };
  } });
  const run = params => tool.execute("compatibility-control", params, undefined, undefined, { cwd: "/tmp" });
  const recovered = await run({ query: "needle", syntax: " LITERAL ", output: " MATCHES ", paths: "/tmp/a.ts" });
  assert.notEqual(recovered.details?.envelope?.status, "error", recovered.content[0].text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.pattern, "needle");
  assert.equal(calls[0].args.output, "matches");
  assert.equal(calls[0].args.syntax, "literal");
  assert.equal(calls[0].args.paths, "/tmp/a.ts", "the explicit scope must remain unchanged");
  for (const params of [
    { pattern: "needle", query: "other", output: "matches" },
    { cursor: "grep-retained", pattern: "needle" },
    { pattern: "needle", root: "/", output: "matches" },
  ]) {
    const refused = await run(params);
    assert.equal(refused.details?.envelope?.status, "error", refused.content[0].text);
    assert.doesNotMatch(refused.content[0].text, /incompatible_addon/);
    assert.equal(calls.length, 1, "ambiguous intent and a private root override must not reach native search");
  }
});

test("grep shares one cooperative deadline with source proof and rejects late results", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-deadline-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "a.ts");
  const source = "const needle = 1;\n";
  writeFileSync(path, source);
  let now = 0;
  t.mock.method(performance, "now", () => now);
  for (const [searchFinished, proofFinished, succeeds] of [[20_000, 24_000, true], [20_000, 26_000, false], [25_001, 26_000, false]]) {
    now = 0;
    const calls = [];
    let tool;
    registerGrepTool({ registerTool: value => { tool = value; } }, {
      callNative: async input => {
        calls.push(input);
        const proof = input.operation === "pi_nav_source_proof";
        now = proof ? proofFinished : searchFinished;
        return {
          text: proof ? "" : "1: const needle = 1;",
          structured: {
            schemaVersion: 1, operation: input.operation,
            data: { sourceRows: [{ path, line: 1, text: "const needle = 1;", visibility: "visible_complete", transformation: "verbatim" }], coverage: { complete: true } },
            completeness: { returned: 1, total: 1, complete: true }, diagnostics: [],
          },
          ...(proof ? { sourceSnapshots: [{ canonicalPath: path, text: source, rawDigest: createHash("sha256").update(source).digest("hex").toUpperCase(), bom: false, lineEnding: "lf" }] } : {}),
        };
      },
    });
    const result = await tool.execute("id", { pattern: "needle", paths: path, syntax: "literal", output: "matches" }, undefined, undefined, { cwd: root });
    if (searchFinished < 25_000) {
      assert.equal(calls.length, 2);
      assert.equal(calls[1].operation, "pi_nav_source_proof");
      assert.equal(calls[1].timeoutMs, 5_000, "proof cannot reset the search's 25-second allowance");
    } else assert.equal(calls.length, 1, "late search results cannot start proof work");
    if (succeeds) assert.match(result.content[0].text, /Live source authority/);
    else {
      assert.match(result.content[0].text, /ERROR: exact search failed[\s\S]*grep request deadline exceeded/);
      assert.doesNotMatch(result.content[0].text, /Live source authority/);
    }
  }
});

test("ranked focus preserves the question and continuation renders the returned ranked page", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-focus-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "worker.ts");
  const source = "export function Flush() { return true; }\n";
  writeFileSync(target, source);
  const calls = [];
  const question = "sync failure retry callbacks";
  let tool;
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async request => {
    calls.push(request);
    return { text: "worker.ts\n1: export function Flush() { return true; }\nMore: cursor ranked-next", structured: {
      schemaVersion: 1, operation: "pi_nav_search", data: {
        mode: "ranked", kind: "fuzzy", query: question, scope: target, visibility: "project", cursor: "ranked-next",
        focus: { target: `${target}::Flush`, evidence: "callers", status: "exact" },
        sourceRows: [{ path: target, line: 1, text: source.trimEnd(), visibility: "visible_complete", transformation: "verbatim" }],
      }, completeness: { complete: false, total: 2, returned: 1, reason: "budget" }, diagnostics: [],
    }, sourceSnapshots: [{ canonicalPath: target, text: source, rawDigest: createHash("sha256").update(source).digest("hex").toUpperCase(), bom: false, lineEnding: "lf" }] };
  } });
  const focused = await tool.execute("focus", { pattern: question, paths: "worker.ts", output: "ranked", focus: { target: "worker.ts::Flush", evidence: "callers" } }, undefined, undefined, { cwd: root });
  assert.notEqual(focused.details.envelope.status, "error", focused.content[0].text);
  assert.equal(calls[0].args.query, question);
  assert.equal(calls[0].args.scope, target);
  assert.deepEqual(calls[0].args.focus, { target: `${target}::Flush`, evidence: ["callers"] });
  const next = await tool.execute("next", { cursor: "ranked-next" }, undefined, undefined, { cwd: root });
  assert.notEqual(next.details.envelope.status, "error", next.content[0].text);
  assert.deepEqual(calls.at(-1).args, { cursor: "ranked-next" });
  assert.match(next.content[0].text, /sync failure retry callbacks/);
  assert.match(next.content[0].text, /More: cursor ranked-next/);
  assert.match(next.content[0].text, /Live source authority/);
  assert.doesNotMatch(next.content[0].text, /No native rows were returned|No matches/);
  const beforeInvalid = calls.length;
  for (const params of [
    { pattern: question, focus: { target: "worker.ts::Flush", wrong: true } },
    { cursor: "ranked-next", focus: { target: "worker.ts::Flush" } },
  ]) {
    const rejected = await tool.execute("invalid", params, undefined, undefined, { cwd: root });
    assert.equal(rejected.details.envelope.status, "error");
  }
  assert.equal(calls.length, beforeInvalid, "invalid focus/continuation combinations never reach native search");
});

test("ranked fitting counts the complete ordinary-text reply and grants only accepted source authority", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-fit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "work.ts");
  const rows = ['export function Withheld() { return "<|endoftext|>"; }', 'export function Accepted() { return "ok"; }'];
  const source = rows.join("\n") + "\n";
  writeFileSync(path, source);
  const proof = { canonicalPath: path, text: source, rawDigest: createHash("sha256").update(source).digest("hex").toUpperCase(), bom: false, lineEnding: "lf" };
  const ruler = getEncoding("o200k_base");
  const count = text => ruler.encode(text, [], []).length;
  // Native text fits alone; wrapper, proof footer and normalization take it over.
  let preview = `1:${rows[0]}\n` + "<|endoftext|> ".repeat(500);
  while (count(preview) < 3_980) preview += " pad";
  assert.ok(count(preview) <= 4_000);
  const origin = "grep-ranked-original-progress", next = "grep-ranked-accepted-progress";
  const output = (text, line, cursor, handle) => ({ text, rankedRenderCursor: handle, sourceRoot: root, sourceSnapshots: [proof], structured: {
    schemaVersion: 1, operation: "pi_nav_search", data: { mode: "ranked", kind: "symbol", query: "Accepted", scope: root,
      ...(cursor ? { cursor } : {}), sourceRows: [{ path, line, text: rows[line - 1], visibility: "visible_complete", transformation: "verbatim" }] },
    completeness: { complete: !cursor, returned: 1, total: cursor ? 2 : 1 }, diagnostics: [],
  } });
  const calls = [];
  let tool;
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async request => {
    calls.push(request);
    assert.equal(request.operation, "pi_nav_search", "supplied proof avoids any source rediscovery");
    if (request.args.renderRanked) {
      assert.equal(request.args.renderRanked, origin, "never refit the rejected preview's next cursor");
      assert.ok(request.args.rankedRenderAllowance < 4_000);
      assert.equal(snapshots.head(path), undefined, "oversized preview is not edit authority");
      return output(`2:${rows[1]}\nMore: cursor ${next}`, 2, next, origin);
    }
    if (request.args.cursor) {
      assert.equal(request.args.cursor, next);
      return output(`1:${rows[0]}`, 1, undefined, next);
    }
    assert.equal(request.args.retainRankedRender, true);
    return output(preview + "\nMore: cursor grep-ranked-rejected-progress", 1, "grep-ranked-rejected-progress", origin);
  } });
  const first = await tool.execute("first", { pattern: "Accepted", output: "RANKED" }, undefined, undefined, { cwd: root });
  assert.notEqual(first.details.envelope.status, "error", first.content[0].text);
  assert.equal(calls.length, 2);
  assert.ok(count(first.content[0].text) <= 4_000);
  assert.match(first.content[0].text, /Live source authority[\s\S]*Call normalization/);
  assert.deepEqual([...snapshots.head(path).seenLines], [2]);
  assert.equal(first.details.native.data.cursor, next);
  assert.doesNotMatch(JSON.stringify(first), /rankedRender|grep-ranked-original-progress|grep-ranked-rejected-progress/);
  const page = await tool.execute("page", { cursor: next }, undefined, undefined, { cwd: root });
  const replay = await tool.execute("replay", { cursor: next }, undefined, undefined, { cwd: root });
  assert.equal(page.content[0].text, replay.content[0].text);
  assert.ok(count(page.content[0].text) <= 4_000);
  assert.deepEqual([...snapshots.head(path).seenLines].sort(), [1, 2], "withheld rows can arrive on a later accepted page");
});

test("ranked fitting refuses an unfit preview without granting its rows or exposing its next cursor", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-unfit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "work.ts"), source = "export const value = 1;\n";
  writeFileSync(path, source);
  let tool;
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async () => ({
    text: "<|endoftext|> ".repeat(1_000),
    sourceSnapshots: [{ canonicalPath: path, text: source, rawDigest: createHash("sha256").update(source).digest("hex").toUpperCase(), bom: false, lineEnding: "lf" }],
    rankedRenderUnavailable: "controlled retention refusal", structured: { schemaVersion: 1, operation: "pi_nav_search",
      data: { kind: "symbol", cursor: "grep-ranked-withheld", sourceRows: [{ path, line: 1, text: source.trimEnd(), visibility: "visible_complete", transformation: "verbatim" }] },
      completeness: { complete: false, returned: 1, total: 2 }, diagnostics: [] },
  }) });
  const result = await tool.execute("unfit", { pattern: "value" }, undefined, undefined, { cwd: root });
  assert.equal(result.details.envelope.status, "error");
  assert.equal(snapshots.head(path), undefined);
  assert.doesNotMatch(JSON.stringify(result), /grep-ranked-withheld|Live source authority/);
  assert.match(result.content[0].text, /No source rows or continuation progress/);
});

test("partial ranked source verification preserves good evidence but cannot publish continuation credit", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-partial-proof-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "work.ts"), source = "export const Good = 1;\nexport const Bad = 2;\n";
  writeFileSync(path, source);
  let tool;
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async () => ({
    text: "1:export const Good = 1;\n2:export const Bad = 9;\n1 retained source/evidence group(s) remain; compact locators are not completed rich evidence.\nMore: cursor grep-ranked-unverified",
    sourceSnapshots: [{ canonicalPath: path, text: source, rawDigest: createHash("sha256").update(source).digest("hex").toUpperCase(), bom: false, lineEnding: "lf" }],
    structured: { schemaVersion: 1, operation: "pi_nav_search", data: { mode: "ranked", kind: "symbol", cursor: "grep-ranked-unverified", completedGroups: 1, remainingGroups: 1,
      sourceRows: ["export const Good = 1;", "export const Bad = 9;"].map((text, index) => ({ path, line: index + 1, text, visibility: "visible_complete", transformation: "verbatim" })) },
      completeness: { complete: false, returned: 1, total: 2 }, diagnostics: [] },
  }) });
  const result = await tool.execute("partial", { pattern: "Good" }, undefined, undefined, { cwd: root });
  assert.equal(result.details.envelope.status, "warning");
  assert.match(result.content[0].text, /Good = 1[\s\S]*Live source authority[\s\S]*Continuation withheld/);
  assert.doesNotMatch(result.content[0].text, /More: cursor|group\(s\) remain|scan coverage is partial/);
  assert.equal(result.details.native.data.cursor, undefined);
  assert.equal(result.details.native.data.completedGroups, undefined);
  assert.deepEqual([...snapshots.head(path).seenLines], [1]);
});

test("oversized literal and regex ranked replies identify unavailable fitting without claiming retries", async () => {
  for (const syntax of ["literal", "regex"]) {
    let tool, calls = 0;
    registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async request => {
      calls++;
      assert.equal(request.args.retainRankedRender, undefined);
      return { text: "pressure ".repeat(4050), structured: { schemaVersion: 1, operation: "pi_nav_search",
        data: { mode: "ranked", kind: syntax === "literal" ? "content" : "regex", sourceRows: [] },
        completeness: { complete: true, returned: 1 }, diagnostics: [] } };
    } });
    const result = await tool.execute("unfit-audit", { pattern: "needle", syntax }, undefined, undefined, { cwd: process.cwd() });
    assert.equal(calls, 1);
    assert.equal(result.details.envelope.status, "error");
    assert.match(result.content[0].text, /no render-only retry was dispatched[\s\S]*output:'matches'/);
    assert.doesNotMatch(result.content[0].text, /reached its bounded fitting limit/);
    assert.ok(getEncoding("o200k_base").encode(result.content[0].text, [], []).length <= 4000);
  }
});

test("ranked fitting evaluates its last dispatched refit before declaring attempt exhaustion", async () => {
  let tool, refits = 0;
  const origin = "grep-ranked-stable-origin";
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async request => {
    if (request.args.renderRanked) { assert.equal(request.args.renderRanked, origin); refits++; }
    return { text: refits === 8 ? "accepted final composition" : "pressure ".repeat(4050), rankedRenderCursor: origin,
      structured: { schemaVersion: 1, operation: "pi_nav_search", data: { mode: "ranked", kind: "fuzzy", sourceRows: [] },
        completeness: { complete: true, returned: 0 }, diagnostics: [] } };
  } });
  const result = await tool.execute("last-fit", { pattern: "where does this operation happen" }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(refits, 8);
  assert.notEqual(result.details.envelope.status, "error", result.content[0].text);
  assert.match(result.content[0].text, /accepted final composition/);
});

test("ranked backend failure diagnostics obey the whole-reply ceiling too", async () => {
  let tool;
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async () => { throw new Error("failure detail ".repeat(3_000)); } });
  const result = await tool.execute("failure", { pattern: "Accepted" }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(result.details.envelope.status, "error");
  assert.match(result.content[0].text, /detailed diagnostic was withheld/);
  assert.ok(getEncoding("o200k_base").encode(result.content[0].text, [], []).length <= 4_000);
});

test("candidate Grep attaches only admitted same-output YAML and certifies it after the final guard", t => {
  const scratch = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(scratch, "grep-captured-docs-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Controlled handler tests: bypass prepared-worker orchestration, not the real admission/certification owners.
  const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import * as fs from 'node:fs';
    import * as fsp from 'node:fs/promises';
    import { createHash } from 'node:crypto';
    import { join } from 'node:path';
    const directory = ${JSON.stringify(directory)};
    process.env.HOME = join(directory, 'home');
    fs.mkdirSync(process.env.HOME);
    const bridgeURL = ${JSON.stringify(new URL("../src/core/pi-nav-native.ts", import.meta.url).href)};
    const actualBridge = await import(bridgeURL);
    mock.module(bridgeURL, { namedExports: { ...actualBridge,
      callAnalysisNavigation: (request, project, call) => call(request),
      callPiNav: () => { throw Error('POISON default native transport'); },
    } });
    let target, asyncTargetReads = 0, syncTargetReads = 0;
    const { default: ignoredFs, ...fsExports } = fs;
    const { default: ignoredFsp, ...fspExports } = fsp;
    mock.module('node:fs', { namedExports: { ...fsExports, openSync(path, ...rest) { if (path === target) syncTargetReads++; return fs.openSync(path, ...rest); } } });
    mock.module('node:fs/promises', { namedExports: { ...fspExports, open(path, ...rest) { if (path === target) asyncTargetReads++; return fsp.open(path, ...rest); } } });
    let certificationUnavailable = false;
    const authorityURL = ${JSON.stringify(new URL("../src/core/source-authority.ts", import.meta.url).href)};
    const actualAuthority = await import(authorityURL);
    mock.module(authorityURL, { namedExports: { ...actualAuthority, prepareSourceAuthority: options => {
      if (certificationUnavailable && options.nativeText === '') throw Error('controlled optional certification unavailable');
      return actualAuthority.prepareSourceAuthority(options);
    } } });
    const { registerGrepTool } = await import(${JSON.stringify(new URL("../src/tools/grep.ts", import.meta.url).href)});
    const { snapshots, computeTag } = await import(${JSON.stringify(new URL("../src/core/snapshot-store.ts", import.meta.url).href)});
    let now = 0;
    mock.method(performance, 'now', () => now);
    const hash = text => createHash('sha256').update(text).digest('hex').toUpperCase();
    const codeText = 'export function Queue() { return true; }\\n';
    const evidenceRow = (path, line, text) => ({ path, line, text, visibility: 'visible_complete', transformation: 'verbatim' });
    const snapshot = (path, text) => ({ canonicalPath: path, text, rawDigest: hash(text), lineEnding: 'lf', bom: false });
    const setup = (name, options = {}) => {
      const root = join(directory, name);
      fs.mkdirSync(root);
      fs.mkdirSync(join(root, '.git'));
      fs.writeFileSync(join(root, 'work.ts'), codeText);
      fs.writeFileSync(join(root, 'other.ts'), 'export const other = 1;\\n');
      const docText = '---\\ntitle: Queue policy\\ncode: ' + (options.unmatched ? 'other.ts' : 'work.ts') + '\\n---\\n# Queue policy\\nRetry retains queued work.\\n';
      fs.writeFileSync(join(root, 'guide.md'), docText);
      if (options.wrongHash) fs.writeFileSync(join(root, 'work.ts'), 'export function Queue() { return false; }\\n');
      return { root, docText, options };
    };
    const run = async (fixture, overrides = {}) => {
      now = 0;
      const { root, docText } = fixture;
      const options = { ...fixture.options, ...overrides };
      certificationUnavailable = Boolean(options.certificationFailure);
      const doc = join(root, 'guide.md');
      target = join(root, 'work.ts');
      asyncTargetReads = syncTargetReads = 0;
      let corpusCalls = 0;
      const operations = [];
      const rows = options.missingCodeSnapshot ? [] : [evidenceRow('work.ts', 1, codeText.trimEnd())];
      if (!options.missingDocSnapshot) rows.push(evidenceRow('guide.md', 5, '# Queue policy'));
      if (options.shownYaml) rows.push(evidenceRow('guide.md', 3, 'code: work.ts'));
      const nativeText = (options.padding ?? '') + 'work.ts\\n1:' + codeText.trimEnd() + '\\nguide.md\\n5:# Queue policy' + (options.shownYaml ? '\\n3:code: work.ts' : '');
      const output = { text: nativeText, sourceRoot: root, structured: {
        schemaVersion: 1, operation: 'pi_nav_search', data: {
          kind: options.kind ?? 'fuzzy', mode: 'ranked', query: 'queued work', scope: root,
          matches: [{ role: 'definition', symbol: 'Queue', location: { path: 'work.ts', start: 1, end: 1 } },
            { role: 'definition', symbol: 'Queue policy', location: { path: 'guide.md', start: 5, end: 6 } }],
          sourceRows: rows, ...(options.structuredOverflow ? { padding: 'x'.repeat(256 * 1024) } : {}),
        }, completeness: { complete: true, returned: 2, total: 2 }, diagnostics: [],
      }, sourceSnapshots: [...(!options.missingCodeSnapshot ? [snapshot(target, codeText)] : []), ...(!options.missingDocSnapshot ? [snapshot(doc, docText)] : [])] };
      if (options.badDocDigest) output.sourceSnapshots[1].rawDigest = '0'.repeat(64);
      let tool;
      registerGrepTool({ registerTool(value) { tool = value; } }, {
        ...(options.optIn === false ? {} : { analysisProject: { root, directory: join(root, 'unused-store') } }),
        callNative: async request => {
          operations.push(request.operation);
          if (request.operation === 'pi_nav_search') return output;
          assert.equal(request.operation, 'pi_nav_files', 'no attachment document read, source-proof fetch or selector transport is needed for this file mention');
          assert.equal(request.root, root);
          assert.equal(request.args.corpusPolicy.version, 1);
          assert.ok(request.timeoutMs <= 12500, 'optional work cannot take more than half the remaining deadline');
          assert.ok(request.signal);
          corpusCalls++;
          if (options.optionalFailure) throw Error('controlled admission unavailable');
          if (options.optionalExpiry) now = 13000;
          const files = ['guide.md', 'work.ts', 'other.ts'].filter(path => !(options.excluded && path === 'work.ts') && !(options.finalPolicyChange && corpusCalls >= 3 && path === 'guide.md'));
          return { text: '', structured: { schemaVersion: 1, operation: 'pi_nav_files', data: { corpusPolicyVersion: 1, root, files, directories: [''] }, completeness: { complete: true }, diagnostics: [] } };
        },
      });
      const result = await tool.execute('controlled', options.params ?? { pattern: 'queued work', paths: root, output: 'ranked' }, undefined, undefined, { cwd: root });
      const text = result.content[0].text;
      const seen = snapshots.byTag(doc, computeTag(docText))?.seenLines ?? new Set();
      return { result, text, seen, operations, corpusCalls, asyncTargetReads, syncTargetReads };
    };

    const good = setup('good');
    const attached = await run(good, { params: { pattern: 'queued work', paths: good.root, output: 'RANKED' } });
    assert.match(attached.text, /Authored references in captured source; prose unverified/);
    assert.match(attached.text, /guide\\.md:3-3.*code: "work\\.ts"/);
    assert.match(attached.text, /3:code: work\\.ts/);
    assert.match(attached.text, /File mention: work\\.ts/);
    assert.ok(attached.text.includes(hash(good.docText)));
    assert.ok(attached.text.includes(hash(codeText).toLowerCase()));
    assert.match(attached.text, /QMD: unavailable.*docs_lane_disabled/);
    assert.doesNotMatch(attached.text, /implements|complies/);
    assert.deepEqual([...attached.seen].sort(), [3, 5], 'only original heading plus newly displayed YAML item receive authority');
    assert.equal(attached.corpusCalls, 4, 'repeat both existing lane censuses before acceptance');
    assert.equal((attached.text.match(/Call normalization:/g) ?? []).length, 1, 'normalization is final before certification');

    const already = await run(setup('already'), { shownYaml: true });
    assert.equal((already.text.match(/^3:code: work\\.ts$/gm) ?? []).length, 1);
    assert.match(already.text, /YAML site already shown in this reply/);
    const uncertified = await run(setup('uncertified'), { certificationFailure: true });
    assert.match(uncertified.text, /Authored references in captured source; prose unverified/);
    assert.match(uncertified.text, /3:code: work\\.ts/);
    assert.equal(uncertified.seen.has(3), false, 'captured evidence survives certification refusal without false edit authority');
    for (const [name, options] of Object.entries({ missing: { missingDocSnapshot: true }, missingCode: { missingCodeSnapshot: true }, invalid: { badDocDigest: true }, unmatched: { unmatched: true }, stale: { wrongHash: true }, excluded: { excluded: true }, failure: { optionalFailure: true }, expiry: { optionalExpiry: true }, policy: { finalPolicyChange: true } })) {
      const check = await run(setup(name, options));
      assert.match(check.text, /export function Queue/);
      assert.match(check.text, /Authored references limited/);
      assert.match(check.text, /not a documentation-absence claim/);
      assert.equal(check.seen.has(3), false, name + ': discarded YAML must not be certified');
      if (name === 'excluded') {
        assert.equal(check.asyncTargetReads, 0, 'excluded target cannot reach the resolver content reader');
        assert.equal(check.syncTargetReads, 0, 'excluded target cannot be sampled by the code census');
      }
      if (name === 'unmatched') assert.equal(check.asyncTargetReads, 0, 'non-returned target cannot be automatically resolved');
    }
    const ordinary = await run(setup('ordinary'), { optIn: false });
    assert.match(ordinary.text, /Authored references in captured source/);
    for (const [name, options] of Object.entries({ literal: { params: { pattern: 'queued work', syntax: 'literal' } }, regex: { params: { pattern: 'queued.*work', syntax: 'regex' } }, matches: { params: { pattern: 'queued work', output: 'matches' } }, cursor: { params: { cursor: 'retained-ranked-cursor' } }, content: { kind: 'content' }, glob: { params: { pattern: 'queued work', glob: '*.ts' } }, all: { params: { pattern: 'queued work', visibility: 'all' } } })) {
      const check = await run(setup(name), options);
      assert.equal(check.corpusCalls, 0, name);
      assert.equal(check.seen.has(3), false, name);
      assert.doesNotMatch(check.text, /Authored references|QMD retrieval/);
    }

    const textGuard = setup('text-guard');
    // A 128-KiB baseline is no longer a valid ranked answer under the 4k contract.
    // Exercise transport refusal before tokenization; fitting pressure is tested above.
    const padding = 'x'.repeat(128 * 1024);
    const refused = await run(textGuard, { padding });
    assert.equal(refused.result.details.envelope.status, 'error');
    assert.match(refused.text, /response was withheld by the model-facing output safety ceiling/);
    assert.equal(refused.seen.has(3), false, 'final text rejection cannot certify new YAML');
    assert.equal(refused.seen.has(5), false, 'final text rejection cannot certify withheld code either');
    const structured = await run(setup('structured-guard'), { structuredOverflow: true });
    assert.equal(structured.result.details.envelope.status, 'error');
    assert.equal(structured.seen.has(3), false, 'final structured rejection cannot certify new YAML');
    assert.equal(structured.seen.has(5), false, 'final structured rejection cannot certify withheld code either');
    console.log('captured association, admission, snapshots, scope gates, failure retention and final-guard authority verified');
  `], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /final-guard authority verified/);
});

test("registered Grep accepts target-only, list focus and bounded shape recovery without changing matching", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-requests-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  const path = join(root, "work.rs");
  writeFileSync(path, "pub fn flush() {}\n");
  let tool;
  const calls = [];
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async request => {
    calls.push(request);
    return { text: "No matches.", structured: { schemaVersion: 1, operation: "pi_nav_search", data: { mode: request.args.output ?? "ranked", kind: "symbol", matches: [] }, completeness: { complete: true, returned: 0, total: 0 }, diagnostics: [] } };
  } });
  const run = async args => {
    const validated = validateToolArguments(tool, { id: "request", name: "grep", arguments: args });
    return tool.execute("request", validated, undefined, undefined, { cwd: root });
  };
  await run({ target: "work.rs:flush", focus: ["CALLERS", "callers", "documentation", "unknown"] });
  assert.equal(calls[0].root, root);
  assert.equal(calls[0].args.query, "flush");
  assert.equal(calls[0].args.kind, "symbol");
  assert.deepEqual(calls[0].args.focus, { target: `${path}::flush`, evidence: ["callers", "documentation"] });
  const repaired = await run({ query: "retry work", target: "work.rs::flush", focus: "callees, documentation" });
  assert.equal(calls.at(-1).args.query, "retry work");
  assert.deepEqual(calls.at(-1).args.focus.evidence, ["callees", "documentation"]);
  assert.match(repaired.content[0].text, /query → pattern/);
  await run({ target: "Worker.flush", focus: [] });
  assert.deepEqual(calls.at(-1).args.focus, { target: "Worker.flush" });
  await run({ target: "retry queued work" });
  assert.equal(calls.at(-1).args.query, "retry queued work");
  assert.equal(calls.at(-1).args.focus, undefined);
  await run({ pattern: "retry|flush", syntax: "literal", output: "matches", focus: ["callers"] });
  assert.equal(calls.at(-1).args.pattern, "retry|flush");
  assert.equal(calls.at(-1).args.syntax, "literal");
  assert.equal(calls.at(-1).args.focus, undefined);
  for (const name of ["Worker.scala", "worker.sc", "deploy.sh", "script.bats", "plainfile", "settings.oddformat"]) {
    const file = join(root, name);
    writeFileSync(file, "fixture source\n");
    await run({ target: `${name}::entry` });
    assert.equal(calls.at(-1).args.query, "entry", `${name}: file recognition must not use a language allowlist`);
    assert.equal(calls.at(-1).args.focus.target, `${file}::entry`);
  }
  await run({ target: "Namespace::Type" });
  assert.equal(calls.at(-1).args.focus.target, "Namespace::Type", "non-file qualification stays intact");
  await run({ target: "missing.rs::entry" });
  assert.equal(calls.at(-1).args.focus.target, `${join(root, "missing.rs")}::entry`, "missing recognizable paths retain existing diagnostics routing");
  const before = calls.length;
  for (const request of [{ target: "A", focus: { target: "B" } }, { pattern: "a", query: "b" }, { focus: ["callers"] }]) {
    assert.equal((await run(request)).details.envelope.status, "error");
  }
  assert.equal(calls.length, before, "conflicting requests do not reach native search");
});

test("ranked Grep prefers explanatory QMD content over a same-document metadata hit and refuses stale sections", async t => {
  const { syncQmdDocs } = await import("../src/core/qmd-docs-search.ts");
  const { readFile } = await import("node:fs/promises");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-qmd-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "docs"));
  const code = "export function Flush() { return true; }\n";
  const document = "---\ntitle: Flush policy\ncode: work.ts\n---\n# Lifecycle\n\n## Failure handling\n\nFlush preserves pending work on failure.\n";
  const path = join(root, "work.ts"), docPath = join(root, "docs/policy.md");
  writeFileSync(path, code); writeFileSync(docPath, document);
  writeFileSync(join(root, ".pi-navigation.json"), JSON.stringify({ docs: { enabled: true, backend: "qmd", root: "docs", repo: "contract", indexPath: ".pi/qmd" } }));
  const hash = text => createHash("sha256").update(text).digest("hex").toUpperCase();
  const snapshot = (path, text) => ({ canonicalPath: path, text, rawDigest: hash(text), lineEnding: "lf", bom: false });
  const callNative = async request => {
    if (request.operation === "pi_nav_read") {
      const text = request.args.capturedSource.text;
      const heading = text.indexOf("# Lifecycle"), child = text.indexOf("## Failure handling");
      return { text: "", structured: { data: { basis: "supplied", suppliedSourceHash: hash(text).toLowerCase(), files: [{ sections: [
        { selector: "lifecycle#1", title: "Lifecycle", level: 1, parent: null, children: ["lifecycle/failure-handling#2"], headingStartByte: heading, headingEndByte: heading + 11, headingStartLine: 5, headingEndLine: 5, ownEndByte: child, ownEndLine: 6, subtreeEndByte: Buffer.byteLength(text), subtreeEndLine: 9 },
        { selector: "lifecycle/failure-handling#2", title: "Failure handling", level: 2, parent: "lifecycle#1", children: [], headingStartByte: child, headingEndByte: child + 19, headingStartLine: 7, headingEndLine: 7, ownEndByte: Buffer.byteLength(text), ownEndLine: 9, subtreeEndByte: Buffer.byteLength(text), subtreeEndLine: 9 },
      ] }] } } };
    }
    if (request.operation === "pi_nav_files") return { text: "", structured: { schemaVersion: 1, operation: request.operation, data: { corpusPolicyVersion: 1, root, files: ["work.ts", "docs/policy.md"], directories: ["", "docs"] }, completeness: { complete: true }, diagnostics: [] } };
    if (request.operation === "pi_nav_source_proof") return { text: "", structured: { schemaVersion: 1, operation: request.operation, data: {}, completeness: { complete: true }, diagnostics: [] }, sourceSnapshots: [snapshot(docPath, await readFile(docPath, "utf8"))] };
    assert.equal(request.operation, "pi_nav_search");
    return { text: `work.ts\n1:${code.trimEnd()}`, sourceRoot: root, structured: { schemaVersion: 1, operation: request.operation, data: { kind: "symbol", mode: "ranked", matches: [{ role: "definition", symbol: "Flush", location: { path: "work.ts", start: 1, end: 1 } }], sourceRows: [{ path: "work.ts", line: 1, text: code.trimEnd(), visibility: "visible_complete", transformation: "verbatim" }] }, completeness: { complete: true, returned: 1, total: 1 }, diagnostics: [] }, sourceSnapshots: [snapshot(path, code)] };
  };
  // Fresh disposable local index only; no model/provider or repository preparation.
  await syncQmdDocs({ root: join(root, "docs"), projectRoot: root, indexPath: join(root, ".pi/qmd"), repo: "local/contract", paths: ["policy.md"], callNative });
  let tool;
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative });
  const request = { target: "Flush" };
  const invoke = () => tool.execute("qmd-contract", validateToolArguments(tool, { name: "grep", id: "qmd-contract", arguments: request }), undefined, undefined, { cwd: root });
  const first = await invoke();
  assert.match(first.content[0].text, /Retrieved section: docs\/policy\.md:lifecycle\/failure-handling#2/);
  assert.match(first.content[0].text, /9:Flush preserves pending work on failure/);
  assert.match(first.content[0].text, /File mention: work\.ts/);
  assert.ok(getEncoding("o200k_base").encode(first.content[0].text, [], []).length <= 4000);
  writeFileSync(docPath, document.replace("preserves pending", "drops pending"));
  const stale = await invoke();
  assert.doesNotMatch(stale.content[0].text, /9:Flush (?:preserves|drops) pending/);
  assert.match(stale.content[0].text, /omitted=1/, "the stale section is withheld; unchanged preamble evidence may remain");
  assert.match(stale.content[0].text, /export function Flush/);
  writeFileSync(docPath, document.replace("code: work.ts", "tags: [queue]"));
  await syncQmdDocs({ root: join(root, "docs"), projectRoot: root, indexPath: join(root, ".pi/qmd"), repo: "local/contract", paths: ["policy.md"], callNative });
  const lead = await invoke();
  assert.match(lead.content[0].text, /QMD document lead/);
  assert.match(lead.content[0].text, /Similarity is not a code association/);
  assert.match(lead.content[0].text, /9:Flush preserves pending work/);
  assert.doesNotMatch(lead.content[0].text, /File mention: work/);
});
test("matches retained-page refit counts the complete composed reply and grants only accepted source authority", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-matches-fit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "audit.ts");
  const rows = ['export function Withheld() { return "<|endoftext|>"; }', 'export function Accepted() { return "ok"; }'];
  const source = rows.join("\n") + "\n";
  writeFileSync(path, source);
  const proof = { canonicalPath: path, text: source, rawDigest: createHash("sha256").update(source).digest("hex").toUpperCase(), bom: false, lineEnding: "lf" };
  const ruler = getEncoding("o200k_base");
  const count = text => ruler.encode(text, [], []).length;
  // Premise: the FULL native preview, cursor line included, fits the whole-reply
  // ceiling alone; only the composed reply (authority footer + normalization
  // wrapper) breaks it. A native-only counter would accept this page untouched,
  // so the refit below can only be explained by composed counting.
  const origin = "grep-matches-original-progress", rejected = "grep-matches-rejected-progress", next = "grep-matches-accepted-progress";
  const cursorLine = `More: cursor ${rejected}`;
  let native = `1:${rows[0]}\n2:${rows[1]}\n` + "<|endoftext|> ".repeat(500);
  while (count(`${native}\n${cursorLine}`) < 3_985) native += " pad";
  const nativeTokens = count(`${native}\n${cursorLine}`);
  assert.ok(nativeTokens <= 4_000, `full native preview alone fits the ceiling (${nativeTokens})`);
  const composedTokens = count(`${native}\n${cursorLine}\n\nLive source authority\n[audit.ts#ABCDEF01] lines 1\n\nCall normalization: grep output "MATCHES" → "matches".`);
  assert.ok(composedTokens > 4_000, `only the composed reply breaks the ceiling (${composedTokens})`);
  const groupFor = line => ({ path: "audit.ts", owner: { kind: "function", name: "Accepted", start: 2, end: 2 }, outline: [],
    matches: [{ path: "audit.ts", line, text: rows[line - 1], spans: [{ startByte: 0, endByte: 8, startColumn: 0, endColumn: 8 }], role: "usage", enrichment: "complete" }] });
  const output = (text, line, cursor, handle) => ({ text, matchesRenderCursor: handle, sourceRoot: root, sourceSnapshots: [proof], structured: {
    schemaVersion: 1, operation: "pi_nav_search", data: { mode: "matches", pattern: "Accepted",
      ...(cursor ? { cursor } : {}), coverage: { complete: true, more: Boolean(cursor) },
      groups: [groupFor(line)],
      sourceRows: [{ path, line, text: rows[line - 1], visibility: "visible_complete", transformation: "verbatim" }] },
    completeness: { complete: true, returned: 1, total: cursor ? 2 : 1 }, diagnostics: [],
  } });
  const calls = [];
  let tool;
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async request => {
    calls.push(request);
    assert.equal(request.operation, "pi_nav_search", "supplied proof avoids any source rediscovery");
    if (request.args.renderMatches) {
      assert.equal(request.args.renderMatches, origin, "never refit the rejected preview's next cursor");
      assert.ok(Number.isInteger(request.args.matchesRenderBytes) && request.args.matchesRenderBytes > 0 && request.args.matchesRenderBytes < 16_000,
        `refit bytes narrow the native page wall (${request.args.matchesRenderBytes})`);
      assert.equal(snapshots.head(path), undefined, "oversized preview is not edit authority");
      // A real byte fitter cannot shrink this page until its allowance is below
      // the bytes already rendered. Unused 16k capacity is not rendered evidence.
      if (request.args.matchesRenderBytes >= Buffer.byteLength(`${native}\n${cursorLine}`)) {
        return output(`${native}\n${cursorLine}`, 1, rejected, origin);
      }
      return output(`2:${rows[1]}\nMore: cursor ${next}`, 2, next, origin);
    }
    if (request.args.cursor) {
      assert.equal(request.args.cursor, next);
      assert.equal(request.args.retainMatchesRender, true, "matches continuation keeps the retained flag");
      return output(`1:${rows[0]}`, 1, undefined, undefined);
    }
    assert.equal(request.args.retainMatchesRender, true);
    return output(`${native}\n${cursorLine}`, 1, rejected, origin);
  } });
  const first = await tool.execute("first", { pattern: "Accepted", paths: path, output: "MATCHES", syntax: "literal" }, undefined, undefined, { cwd: root });
  assert.notEqual(first.details.envelope.status, "error", first.content[0].text);
  assert.equal(first.details.envelope.status, "success");
  assert.equal(calls.length, 2, "initial retained page plus one byte-refit");
  assert.ok(count(first.content[0].text) <= 4_000, `complete composed reply fits (${count(first.content[0].text)} tokens)`);
  assert.match(first.content[0].text, /Call normalization:/, "the normalization notice is inside the counted reply");
  assert.match(first.content[0].text, /2:export function Accepted\(\) \{ return "ok"; \}/);
  assert.match(first.content[0].text, /Live source authority[\s\S]*\[audit\.ts#[A-F0-9]{8}\] lines 2/);
  assert.doesNotMatch(first.content[0].text, /grep-matches-rejected-progress|grep-matches-original-progress/);
  assert.deepEqual(first.details.callNormalizations, ['grep output "MATCHES" → "matches"']);
  assert.equal(first.details.native.data.cursor, next, "the accepted page's cursor is coherent with the delivered source");
  assert.equal(first.details.native.data.mode, "matches");
  assert.equal(first.details.native.data.groups.length, 1);
  assert.equal(first.details.native.data.groups[0].path, "audit.ts");
  assert.equal(first.details.native.data.groups[0].matches[0].line, 2, "delivered groups stay on the accepted refit page");
  assert.equal(first.details.native.data.sourceRows[0].line, 2, "groups and sourceRows stay coherent on the same accepted page");
  assert.deepEqual([...snapshots.head(path).seenLines], [2], "only the accepted refit page receives source authority");
  assert.doesNotMatch(JSON.stringify(first), /matchesRenderCursor|renderMatches|retainMatchesRender|grep-matches-original-progress|grep-matches-rejected-progress/);
  const page = await tool.execute("page", { cursor: next, contextLines: 1 }, undefined, undefined, { cwd: root });
  const replay = await tool.execute("replay", { cursor: next, contextLines: 1 }, undefined, undefined, { cwd: root });
  assert.equal(page.content[0].text, replay.content[0].text, "the accepted cursor is replayable and never rejected");
  assert.ok(count(page.content[0].text) <= 4_000);
  assert.equal(calls.at(-1).args.cursor, next);
  assert.equal(calls.at(-1).args.contextLines, 1, "contextLines are forwarded on the matches continuation");
  assert.deepEqual([...snapshots.head(path).seenLines].sort(), [1, 2], "withheld rows can arrive on the accepted continuation page");
});
test("oversized unknown grep parameters are rejected early with a bounded reply and no native work", async () => {
  let tool, calls = 0;
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async () => { calls++; throw new Error("POISON native"); } });
  const unknown = "unknown ".repeat(5000);
  const result = await tool.execute("unknown-cap", { pattern: "needle", [unknown]: "x" }, undefined, undefined, { cwd: "/tmp" });
  assert.equal(calls, 0, "early validation rejects before any native execution");
  assert.equal(result.details.envelope.status, "error");
  assert.ok(getEncoding("o200k_base").encode(result.content[0].text, [], []).length <= 4_000, "the rejection reply stays under the whole-reply ceiling");
  assert.doesNotMatch(result.content[0].text, /ERROR: exact search failed/, "this is an early validation refusal, not a runtime failure");
});

test("matches refit fails closed on a missing or changing origin and grants no source authority", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-matches-fail-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "audit.ts");
  const source = "export function Only() { return 1; }\n";
  writeFileSync(path, source);
  const proof = { canonicalPath: path, text: source, rawDigest: createHash("sha256").update(source).digest("hex").toUpperCase(), bom: false, lineEnding: "lf" };
  const pressure = "<|endoftext|> ".repeat(1_000);
  const page = (cursor, handle) => ({ text: pressure + (cursor ? `\nMore: cursor ${cursor}` : ""), ...(handle ? { matchesRenderCursor: handle } : {}), sourceRoot: root, sourceSnapshots: [proof],
    structured: { schemaVersion: 1, operation: "pi_nav_search", data: { mode: "matches", pattern: "Only",
      ...(cursor ? { cursor } : {}), coverage: { complete: true, more: Boolean(cursor) },
      sourceRows: [{ path, line: 1, text: source.trimEnd(), visibility: "visible_complete", transformation: "verbatim" }] },
      completeness: { complete: true, returned: 1, total: 2 }, diagnostics: [] } });

  // Missing origin: an oversized page without a private handle can never refit.
  {
    let tool, calls = 0;
    registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async request => {
      calls++;
      assert.equal(request.args.retainMatchesRender, true);
      return page("grep-matches-unlisted");
    } });
    const result = await tool.execute("missing", { pattern: "Only", paths: path, output: "matches", syntax: "literal" }, undefined, undefined, { cwd: root });
    assert.equal(calls, 1, "no refit is dispatched without an origin handle");
    assert.equal(result.details.envelope.status, "error");
    assert.match(result.content[0].text, /Matches output incomplete[\s\S]*No eligible retained rendering was available; no render-only retry was dispatched/);
    assert.match(result.content[0].text, /Restart the same audit in smaller path batches; the visible target ledger cannot be hidden to make it fit/);
    assert.match(result.content[0].text, /No source rows or continuation progress from the withheld output were credited/);
    assert.equal(snapshots.head(path), undefined, "missing origin grants no source authority");
    assert.doesNotMatch(JSON.stringify(result), /grep-matches-unlisted/);
  }

  // Changing origin: a refit that returns a different handle aborts before certification.
  {
    const origin = "grep-matches-stable-origin";
    let tool, calls = [];
    registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async request => {
      calls.push(request.args);
      if (request.args.renderMatches) {
        assert.equal(request.args.renderMatches, origin);
        assert.equal(snapshots.head(path), undefined, "a refused refit certifies nothing");
        return page("grep-matches-changed", "grep-matches-changed-handle");
      }
      return page("grep-matches-pending", origin);
    } });
    const result = await tool.execute("changed", { pattern: "Only", paths: path, output: "matches", syntax: "literal" }, undefined, undefined, { cwd: root });
    assert.equal(calls.length, 2, "initial retained page plus one refit that must abort");
    assert.equal(result.details.envelope.status, "error");
    assert.match(result.content[0].text, /ERROR: exact search failed[\s\S]*changed its original progress handle/);
    assert.equal(snapshots.head(path), undefined, "changed origin grants no source authority");
  }
});

test("matches under-cap output is accepted without a private handle and certifies its shown rows", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-matches-small-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "small.ts");
  const lines = ["const a = 1;", "const b = 2;", "const c = 3;"];
  const source = lines.join("\n") + "\n";
  writeFileSync(path, source);
  const proof = { canonicalPath: path, text: source, rawDigest: createHash("sha256").update(source).digest("hex").toUpperCase(), bom: false, lineEnding: "lf" };
  const ruler = getEncoding("o200k_base");
  let tool, calls = 0;
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async request => {
    calls++;
    assert.equal(request.args.retainMatchesRender, true, "matches keeps the retained flag even when it fits");
    assert.equal(request.args.renderMatches, undefined, "no refit is requested for a fitting page");
    return { text: lines.map((text, index) => `${index + 1}:${text}`).join("\n"),
      sourceRoot: root, sourceSnapshots: [proof], structured: {
      schemaVersion: 1, operation: "pi_nav_search", data: { mode: "matches", pattern: "const",
        coverage: { complete: true, more: false },
        sourceRows: lines.map((text, index) => ({ path, line: index + 1, text, visibility: "visible_complete", transformation: "verbatim" })) },
      completeness: { complete: true, returned: 3, total: 3 }, diagnostics: [] } };
  } });
  const result = await tool.execute("small", { pattern: "const", paths: path, output: "matches", syntax: "literal" }, undefined, undefined, { cwd: root });
  assert.equal(calls, 1, "an under-cap page never needs a private handle or a refit");
  assert.equal(result.details.envelope.status, "success");
  assert.ok(ruler.encode(result.content[0].text, [], []).length <= 4_000);
  assert.match(result.content[0].text, /1:const a = 1/);
  assert.match(result.content[0].text, /Live source authority/);
  assert.deepEqual([...snapshots.head(path).seenLines].sort(), [1, 2, 3]);
  assert.equal(result.details.native.data.mode, "matches");
  assert.equal(result.details.native.data.cursor, undefined);
});

test("continuation prefixes keep matches on the retained matches page and ranked on ranked without guessing custom cursors", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-prefix-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "work.ts");
  const source = "export const value = 1;\n";
  writeFileSync(path, source);
  const proof = { canonicalPath: path, text: source, rawDigest: createHash("sha256").update(source).digest("hex").toUpperCase(), bom: false, lineEnding: "lf" };
  const row = { path, line: 1, text: source.trimEnd(), visibility: "visible_complete", transformation: "verbatim" };
  const calls = [];
  let tool;
  registerGrepTool({ registerTool(value) { tool = value; } }, { callNative: async request => {
    calls.push(request.args);
    const cursor = request.args.cursor;
    const ranked = String(cursor ?? "").startsWith("grep-ranked-");
    return { text: `1:${source.trimEnd()}\nMore: cursor ${cursor}\n`,
      sourceRoot: root, sourceSnapshots: [proof], structured: {
      schemaVersion: 1, operation: "pi_nav_search", data: {
        mode: ranked ? "ranked" : "matches",
        ...(ranked ? { kind: "symbol" } : {}),
        cursor, coverage: { complete: true, more: !ranked }, sourceRows: [row],
      }, completeness: { complete: true, returned: 1, total: 1 }, diagnostics: [] } };
  } });
  await tool.execute("ranked-cursor", { cursor: "grep-ranked-next" }, undefined, undefined, { cwd: root });
  assert.equal(calls.at(-1).retainRankedRender, true, "grep-ranked- continuation stays ranked");
  assert.equal(calls.at(-1).rankedRenderAllowance, 4_000);
  assert.equal(calls.at(-1).retainMatchesRender, undefined);
  await tool.execute("matches-cursor", { cursor: "grep-matches-next" }, undefined, undefined, { cwd: root });
  assert.equal(calls.at(-1).retainMatchesRender, true, "native grep- continuation is matched");
  assert.equal(calls.at(-1).retainRankedRender, undefined);
  await tool.execute("custom-cursor", { cursor: "custom-next" }, undefined, undefined, { cwd: root });
  assert.equal(calls.at(-1).retainMatchesRender, undefined, "a fake custom cursor is never assumed to be matches");
  assert.equal(calls.at(-1).retainRankedRender, undefined);
});
