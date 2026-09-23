import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import jeitoCodeweavePiExtension from "../index.ts";
import { commitMarkdownFrontmatterExposure, createMarkdownFrontmatterExposureState, extractMarkdownFrontmatterRelationships, selectMarkdownFrontmatter } from "../src/core/markdown-frontmatter.ts";

const TAG_RE = /^\[(.+)#([0-9A-F]{4,})\]/m;

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

test("read reports invalid selector (not missing file) when the file exists", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-sel-"));
  await writeFile(join(cwd, "README.md"), "line one\nline two\nline three\n");

  await assert.rejects(
    () => call(pi.tool("read"), { path: "README.md:abc" }, cwd),
    (err) => {
      assert.match(err.message, /unsupported selector :abc for README\.md/);
      assert.doesNotMatch(err.message, /file not found/, "must not claim the file is missing when it exists");
      assert.match(err.message, /:START-END|:START\+COUNT|:raw/);
      return true;
    },
  );
});

test("read valid selectors still work and mint hashes only for shown source", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-sel-ok-"));
  await writeFile(join(cwd, "README.md"), "line one\nline two\nline three\n");

  const ranged = await call(pi.tool("read"), { path: "README.md:1-2" }, cwd);
  assert.match(ranged, TAG_RE);
  assert.match(ranged, /line one/);
  assert.match(ranged, /line two/);
  assert.doesNotMatch(ranged, /line three/);

  const raw = await call(pi.tool("read"), { path: "README.md:raw" }, cwd);
  assert.match(raw, /\[README\.md · raw · no edit hash\]/);
  assert.match(raw, /Raw text shown for inspection only/);
  assert.doesNotMatch(raw, TAG_RE);
  assert.match(raw, /line three/);
  const doubleColonRaw = await call(pi.tool("read"), { path: "README.md::raw" }, cwd);
  assert.equal(doubleColonRaw, raw);
});

test("read resolves code symbols with single or double colon and preserves exact-file precedence", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-code-symbol-"));
  await writeFile(join(cwd, "service.ts"), "export function test_func() {\n  return 1;\n}\n\nexport const arrow_func = () => 2;\n");
  await writeFile(join(cwd, "literal:target"), "literal colon filename\n");

  const single = await call(pi.tool("read"), { path: "service.ts:test_func" }, cwd);
  const double = await call(pi.tool("read"), { path: "service.ts::test_func" }, cwd);
  assert.match(single, /1:export function test_func\(\)/);
  assert.match(single, /3:}/);
  assert.doesNotMatch(single, /arrow_func/);
  assert.equal(single.replace(/#[0-9A-F]{8}/, "#TAG"), double.replace(/#[0-9A-F]{8}/, "#TAG"));

  const arrow = await call(pi.tool("read"), { path: "service.ts::arrow_func" }, cwd);
  assert.match(arrow, /5:export const arrow_func/);
  const literal = await call(pi.tool("read"), { path: "literal:target" }, cwd);
  assert.match(literal, /literal colon filename/);
});

test("read accepts permissive Markdown double-colon selectors and mixed ranges", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-markdown-alias-"));
  await writeFile(join(cwd, "guide.md"), "# Root\nintro\n## Child\nanswer\n# Other\nend\n");

  const output = await call(pi.tool("read"), { path: "guide.md::root/child/#2,6-6" }, cwd);
  assert.match(output, /3:## Child\n4:answer/);
  assert.match(output, /6:end/);
  assert.doesNotMatch(output, /5:# Other/);
});

test("read refuses ambiguous code symbols with current candidate ranges", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-code-ambiguous-"));
  await writeFile(join(cwd, "service.ts"), "class A { run() { return 1; } }\nclass B { run() { return 2; } }\n");
  await assert.rejects(
    () => call(pi.tool("read"), { path: "service.ts::run" }, cwd),
    /symbol selector "run" is ambiguous.*Matches: 1-1, 2-2/,
  );
});

test("read explicit bounded selectors above default summary budget still mint hashes when safely bounded", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-sel-wide-"));
  const wideLine = `${"x".repeat(150)}\n`;
  await writeFile(join(cwd, "wide.md"), wideLine.repeat(180));

  const output = await call(pi.tool("read"), { path: "wide.md:1-180" }, cwd);
  assert.match(output, TAG_RE);
  assert.match(output, /1:xxx/);
  assert.match(output, /180:xxx/);
  assert.doesNotMatch(output, /exceeds budget/);
});

test("read explicit bounded selectors still refuse truly oversized output without a hash", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-sel-too-wide-"));
  const veryWideLine = `${"y".repeat(500)}\n`;
  await writeFile(join(cwd, "too-wide.md"), veryWideLine.repeat(180));

  const output = await call(pi.tool("read"), { path: "too-wide.md:1-180" }, cwd);
  assert.match(output, /Read refused: exact selector output for too-wide\.md exceeds budget/);
  assert.match(output, /No edit hash was created/);
  assert.doesNotMatch(output, TAG_RE);
});

test("read exposes Markdown frontmatter once per session and falls back to title and description", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-frontmatter-"));
  await writeFile(join(cwd, "README.md"), "---\ntitle: Demo\ndescription: First exposure context.\ntags: [demo]\n---\n# Demo\n\n## Install\nRun it.\n");

  const first = await call(pi.tool("read"), { path: "README.md:demo/install#2" }, cwd);
  assert.match(first, /1:---\n2:title: Demo\n3:description: First exposure context\.\n4:tags: \[demo\]\n5:---/);
  assert.match(first, /8:## Install/);

  const second = await call(pi.tool("read"), { path: "README.md:demo#1" }, cwd);
  assert.doesNotMatch(second, /title: Demo|description: First exposure context|tags: \[demo\]/);

  await writeFile(join(cwd, "large.md"), `---\ntitle: Large metadata\ndescription: Keep only these fields.\nfiller: "${"x".repeat(9_000)}"\n---\n# Large\n\n## Target\nBody.\n`);
  const fallback = await call(pi.tool("read"), { path: "large.md:large/target#2" }, cwd);
  assert.match(fallback, /2:title: Large metadata\n3:description: Keep only these fields\./);
  assert.doesNotMatch(fallback, /filler:/);
  assert.match(fallback, /8:## Target/);
});

test("read re-exposes frontmatter only when its digest changes", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-frontmatter-digest-"));
  const path = join(cwd, "guide.md");
  await writeFile(path, "---\ntitle: Version one\ndescription: Stable metadata.\n---\n# Guide\nBody one.\n");

  assert.match(await call(pi.tool("read"), { path: "guide.md:guide#1" }, cwd), /2:title: Version one/);
  assert.doesNotMatch(await call(pi.tool("read"), { path: "guide.md:guide#1" }, cwd), /title: Version one/);
  await writeFile(path, "---\ntitle: Version one\ndescription: Stable metadata.\n---\n# Guide\nBody two.\n");
  assert.doesNotMatch(await call(pi.tool("read"), { path: "guide.md:guide#1" }, cwd), /title: Version one/);
  await writeFile(path, "---\ntitle: Version two\ndescription: Stable metadata.\n---\n# Guide\nBody two.\n");
  assert.match(await call(pi.tool("read"), { path: "guide.md:guide#1" }, cwd), /2:title: Version two/);
  assert.doesNotMatch(await call(pi.tool("read"), { path: "guide.md:guide#1" }, cwd), /title: Version two/);
});

test("multi-file read gives every Markdown file its own 300-token metadata allowance", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-frontmatter-fair-"));
  const paths = [];
  for (let index = 1; index <= 8; index++) {
    const path = `guide-${index}.md`;
    paths.push(`${path}:guide-${index}#1`);
    await writeFile(join(cwd, path), `---\ntitle: Guide ${index}\ndescription: ${String(index).repeat(1_080)}\n---\n# Guide ${index}\nBody.\n`);
  }

  const output = await call(pi.tool("read"), { paths }, cwd);
  for (let index = 1; index <= 8; index++) assert.match(output, new RegExp(`2:title: Guide ${index}\\n3:description: ${index}{1080}`));
});

test("required title and description rows remain exact when they exceed the metadata allowance", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-frontmatter-required-"));
  const description = "z".repeat(1_500);
  await writeFile(join(cwd, "guide.md"), `---\ntitle: Oversized required metadata\ndescription: ${description}\nfiller: hidden\n---\n# Guide\nBody.\n`);

  const output = await call(pi.tool("read"), { path: "guide.md:guide#1" }, cwd);
  assert.match(output, new RegExp(`2:title: Oversized required metadata\\n3:description: z{1500}`));
  assert.doesNotMatch(output, /filler: hidden/);
});

test("read validates visible frontmatter selectors through the same direct-read contract", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-frontmatter-relations-"));
  await writeFile(join(cwd, "target.ts"), "export function work() {\n  return 1;\n}\n");
  await writeFile(join(cwd, "ambiguous.ts"), "class A { run() {} }\nclass B { run() {} }\n");
  await writeFile(join(cwd, "guide.md"), "# Root\n\n## Child\nAnswer.\n");
  await writeFile(join(cwd, "README.md"), `---\ntitle: Relations\ndescription: Selector validation.\ncode:\n  - target.ts::work\n  - target.ts::missing\n  - ambiguous.ts::run\nrelated:\n  - guide.md::root/child/#2\n  - https://example.com/policy\n---\n# Relations\n\n## Target\nBody.\n`);

  const output = await call(pi.tool("read"), { path: "README.md:relations/target#2" }, cwd);
  assert.match(output, /code:\n5:  - target\.ts::work/);
  assert.match(output, /Relationship selectors: valid=2 · invalid=1 · ambiguous=1 · unverified=1/);
  assert.match(output, /target\.ts::missing .*symbol "missing" was not found/);
  assert.match(output, /ambiguous\.ts::run .*ambiguous/);

  const direct = await call(pi.tool("read"), { path: "target.ts::work" }, cwd);
  assert.match(direct, /1:export function work/);
  const repeated = await call(pi.tool("read"), { path: "README.md:relations#1" }, cwd);
  assert.doesNotMatch(repeated, /Relationship selectors:/);
});

test("frontmatter relationships resolve from the nearest nested package root", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-frontmatter-package-root-"));
  const packageRoot = join(cwd, "extensions", "feature");
  await mkdir(join(packageRoot, "docs"), { recursive: true });
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), '{"name":"feature"}\n');
  await writeFile(join(packageRoot, "src", "target.ts"), "export function work() { return 1; }\n");
  await writeFile(join(packageRoot, "docs", "guide.md"), "---\ntitle: Nested package\ndescription: Package-relative relationship.\ncode:\n  - src/target.ts::work\n---\n# Guide\n");

  const output = await call(pi.tool("read"), { path: "extensions/feature/docs/guide.md:guide#1" }, cwd);
  assert.match(output, /Relationship selectors: valid=1 · invalid=0 · ambiguous=0 · unverified=0/);
});

test("read missing file with a valid selector still reports file not found", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-sel-missing-"));
  await assert.rejects(() => call(pi.tool("read"), { path: "ghost.ts:1-2" }, cwd), /file not found: ghost\.ts/);
});

test("read missing file with an invalid suffix reports file not found, not a selector error", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "read-sel-missing2-"));
  // neither "ghost.ts" nor any prefix exists, so this is genuinely missing
  await assert.rejects(
    () => call(pi.tool("read"), { path: "ghost.ts:abc" }, cwd),
    (err) => {
      assert.match(err.message, /file not found: ghost\.ts/);
      assert.doesNotMatch(err.message, /not a valid selector/);
      return true;
    },
  );
});

test("authored frontmatter extraction preserves item sites independently of old display exposure", () => {
  const source = '---\ncode:\n  - "src/a.ts::work"\n  - src/b.ts\nrelated: [docs/one.md, "docs/two.md"]\n---\n# Guide';
  const lines = source.split("\n");
  const state = createMarkdownFrontmatterExposureState();
  const params = { path: "guide.md", lines, canonicalPath: "/guide.md", exposureState: state, maxBytes: 10_000 };
  const first = selectMarkdownFrontmatter(params);
  const references = extractMarkdownFrontmatterRelationships(lines);
  assert.equal(first.status, "full");
  assert.deepEqual(first.relationships, references.map(({ field, value }) => ({ field, value })));
  assert.deepEqual(references.map(item => item.interval), [{ start: 3, end: 3 }, { start: 4, end: 4 }, { start: 5, end: 5 }, { start: 5, end: 5 }]);
  assert.deepEqual(references.map(item => source.slice(item.startOffset, item.endOffset)), ['"src/a.ts::work"', 'src/b.ts', 'docs/one.md', '"docs/two.md"']);
  commitMarkdownFrontmatterExposure(state, params.canonicalPath, first.digest);
  assert.equal(selectMarkdownFrontmatter(params).status, "already_seen");
  assert.deepEqual(selectMarkdownFrontmatter(params).relationships, [], "protected display behavior remains unchanged");
  assert.deepEqual(extractMarkdownFrontmatterRelationships(lines), references);
});

test("authored references gate content reads and use only the injected selector transport", async (t) => {
  const scratch = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  const root = await realpath(await mkdtemp(join(scratch, "authored-references-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "feature");
  await mkdir(join(packageRoot, "docs"), { recursive: true });
  await mkdir(join(packageRoot, "src"));
  await mkdir(join(root, "foreign"));
  await writeFile(join(packageRoot, "package.json"), '{"name":"feature"}');
  await writeFile(join(packageRoot, "src/target.ts"), "export function work() {\n  return 1;\n}\n");
  await writeFile(join(packageRoot, "src/large.ts"), "export function large() {\n" + "  // current source padding\n".repeat(3000) + "}\n");
  await writeFile(join(packageRoot, "docs/guide.md"), "# Guide\nAn authored reference.\n");
  await writeFile(join(root, "foreign/secret.ts"), "excluded content\n");
  // A subprocess confines module poisoning to this test; existing default-read tests stay real.
  const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import * as fs from 'node:fs/promises';
    import { createHash } from 'node:crypto';
    import { join } from 'node:path';
    const root = ${JSON.stringify(root)};
    const owner = join(root, 'feature/docs/guide.md');
    const target = join(root, 'feature/src/target.ts');
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const ownerHash = digest(await fs.readFile(owner));
    const targetHash = digest(await fs.readFile(target));
    const largePath = join(root, 'feature/src/large.ts');
    const largeHash = digest(await fs.readFile(largePath));
    let opens = 0, defaultCalls = 0;
    const calls = [];
    const { default: ignoredDefault, ...fsExports } = fs;
    let boundedMode, boundedReads = 0, boundedBytes = 0, boundedCapacity = 0, boundedSize = 0;
    mock.module('node:fs/promises', { namedExports: { ...fsExports, async open(...args) {
      opens++;
      const handle = await fs.open(...args);
      if (args[0] === target && boundedMode) {
        const read = handle.read.bind(handle);
        handle.readFile = () => { throw Error('POISON: unbounded target readFile'); };
        handle.read = async (buffer, offset, length, position) => {
          assert.equal(buffer.length, boundedSize + 1, 'allocation must stay at admitted size plus one sentinel');
          assert.equal(position, boundedBytes, 'short reads must advance by actual bytes read');
          boundedCapacity = Math.max(boundedCapacity, buffer.length);
          if (boundedReads++ === 0) {
            if (boundedMode === 'grow') await fs.appendFile(target, 'x'.repeat(1024 * 1024));
            if (boundedMode === 'truncate') await fs.truncate(target, 1);
          }
          const result = await read(buffer, offset, Math.min(length, 3), position);
          boundedBytes += result.bytesRead;
          return result;
        };
      }
      return handle;
    } } });
    mock.module(${JSON.stringify(new URL("../src/core/pi-nav-native.ts", import.meta.url).href)}, { namedExports: {
      callPiNav() { defaultCalls++; throw Error('POISON: installed/default transport reached'); },
    } });
    const { resolveAuthoredDocumentationReference: resolveReference } = await import(${JSON.stringify(new URL("../src/core/frontmatter-relationships.ts", import.meta.url).href)});
    const { resolveSourceSelector } = await import(${JSON.stringify(new URL("../src/core/source-selector.ts", import.meta.url).href)});
    const site = { path: owner, sourceHash: ownerHash, interval: { start: 2, end: 2 } };
    let mode = 'valid';
    const callNative = async request => {
      calls.push(request);
      assert.equal(request.root, root, 'captured root must be the admitted project, not the nested reference package');
      assert.ok(request.args.path.startsWith('feature/'), 'captured labels must be project-relative');
      assert.deepEqual(Object.keys(request.args.capturedSource), ['text']);
      const capturedHash = digest(request.args.capturedSource.text);
      if (mode === 'cancel') { controller.abort(); }
      if (mode === 'unavailable') throw Error('captured_source_v1 unavailable');
      const proof = { basis: mode === 'basis' ? 'current' : 'supplied', suppliedSourceHash: mode === 'stale' ? '0'.repeat(64) : capturedHash };
      if (request.operation === 'pi_nav_read') {
        assert.equal(request.args.path, 'feature/docs/guide.md');
        assert.equal(capturedHash, ownerHash);
        const file = { path: request.args.path, totalLines: 2, sections: [{ selector: 'guide#1', title: 'Guide', level: 1, headingStartLine: 1, subtreeEndLine: 2 }] };
        return { structured: { data: mode === 'legacy' ? { files: [{ ...file, sourceHash: ownerHash }] } : { ...proof, files: [file] } } };
      }
      assert.equal(request.operation, 'pi_nav_symbol_range');
      assert.equal('symbol' in request.args, false, 'native symbol parameter is name');
      if (mode === 'mutate') await fs.writeFile(target, 'export function work() { return 2; }\\n');
      if (mode === 'swap') { await fs.unlink(target); await fs.symlink(join(root, 'foreign/secret.ts'), target); }
      const definition = { bodyStart: 1, bodyEnd: request.args.path === 'feature/src/large.ts' ? 3002 : 3, kind: 'function', name: request.args.name };
      if (mode === 'legacy') return { structured: { data: { sourceHash: capturedHash, verified: true, found: true, ...definition } } };
      return { structured: { data: { ...proof, path: request.args.path,
        status: ['ambiguous', 'absent', 'unsupported'].includes(mode) ? mode : 'found', definition,
        candidates: [{ bodyStart: 1, bodyEnd: 3 }, { bodyStart: 7, bodyEnd: 9 }],
      } } };
    };
    const base = { projectRoot: root, admit: () => true, callNative };
    const run = (value, form = 'frontmatter', extra = {}) => resolveReference({ ...base, reference: { value, form, site }, ...extra });
    const fileMention = await run('src/target.ts');
    assert.equal(fileMention.status, 'valid');
    assert.equal(fileMention.target.kind, 'file');
    assert.equal(fileMention.target.path, target);
    assert.equal(fileMention.target.sourceHash, targetHash);
    assert.equal(fileMention.claim, 'unverified');
    assert.deepEqual(fileMention.reference.site, site);
    assert.deepEqual((await run('../src/target.ts', 'markdown')).target, fileMention.target);
    assert.equal((await run('src/target.ts', 'markdown')).status, 'invalid', 'URL base must not silently become package root');
    assert.equal((await run('#guide', 'markdown')).status, 'unverified', 'standard fragments are not hierarchical selectors');
    const selected = await run('src/target.ts::work', 'project');
    assert.equal(selected.status, 'valid');
    assert.equal(selected.target.kind, 'selection');
    assert.deepEqual(selected.target.intervals, [{ start: 1, end: 3 }]);
    assert.equal(calls.at(-1).args.path, 'feature/src/target.ts');
    assert.equal(calls.at(-1).args.capturedSource.text, await fs.readFile(target, 'utf8'));
    assert.equal(calls.at(-1).args.name, 'work');
    const markdown = await run('docs/guide.md::guide#1');
    assert.equal(markdown.status, 'valid');
    assert.deepEqual(markdown.target.intervals, [{ start: 1, end: 2 }]);
    assert.equal(calls.at(-1).operation, 'pi_nav_read');
    const large = await run('src/large.ts::large');
    assert.equal(large.status, 'valid', 'rendered size is not resolution validity');
    assert.deepEqual(large.target.intervals, [{ start: 1, end: 3002 }]);
    assert.ok((await fs.stat(largePath)).size > 64000);

    await fs.mkdir(join(root, '.git')); // Existing detection prefers Git roots over nested package markers.
    const selectorParams = { selector: 'work', lines: (await fs.readFile(target, 'utf8')).trimEnd().split('\\n'), display: target, cwd: join(root, 'feature'), absolutePath: target, sourceText: await fs.readFile(target, 'utf8') };
    const defaultRequests = [];
    await resolveSourceSelector({ ...selectorParams, callNative: async request => {
      defaultRequests.push(request);
      return { structured: { data: { sourceHash: targetHash, verified: true, found: true, bodyStart: 1, bodyEnd: 3, name: 'work', kind: 'function' } } };
    } });
    assert.deepEqual(defaultRequests[0].args, { path: target, name: 'work' }, 'sourceText presence must not opt normal reads into captured mode');
    assert.equal(defaultRequests[0].root, root);
    await resolveSourceSelector({ ...selectorParams, selector: 'guide#1', lines: ['# Guide', 'An authored reference.'], display: owner, absolutePath: owner, sourceText: await fs.readFile(owner, 'utf8'), callNative: async request => {
      defaultRequests.push(request);
      return { structured: { data: { files: [{ sourceHash: ownerHash, sections: [{ selector: 'guide#1', title: 'Guide', level: 1, headingStartLine: 1, subtreeEndLine: 2 }] }] } } };
    } });
    assert.deepEqual(defaultRequests[1].args, { path: owner, markdownStructure: true, includeSections: true });
    assert.deepEqual(await resolveSourceSelector({ ...selectorParams, selector: '2-3', capturedSourceRoot: root, callNative: () => { throw Error('line ranges must not invoke native'); } }), { intervals: [{ start: 2, end: 3 }], context: [] });
    for (const failure of ['basis', 'stale', 'legacy', 'unavailable']) {
      mode = failure;
      for (const reference of ['src/target.ts::work', 'docs/guide.md::guide#1']) {
        const previousCalls = calls.length;
        const refused = await run(reference);
        assert.equal(refused.status, 'unverified', failure + ': ' + reference);
        assert.equal(refused.target, undefined);
        assert.equal(refused.reference.value, reference);
        assert.equal(calls.length, previousCalls + 1, 'captured refusal must never retry path-backed');
      }
    }
    mode = 'absent';
    assert.equal((await run('src/target.ts::missing')).status, 'invalid');
    mode = 'unsupported';
    assert.equal((await run('src/target.ts::work')).status, 'unverified');
    mode = 'valid';

    // One bounded-read scenario: short-read control, growth sentinel, then premature EOF.
    const originalTarget = await fs.readFile(target);
    boundedSize = originalTarget.length;
    for (const reading of ['short', 'grow', 'truncate']) {
      boundedMode = reading;
      boundedReads = boundedBytes = boundedCapacity = 0;
      const nativeCallsBefore = calls.length;
      const result = await run('src/target.ts');
      assert.equal(boundedCapacity, boundedSize + 1);
      assert.ok(boundedReads > 1, 'legal short reads must be looped, not mistaken for EOF');
      assert.equal(calls.length, nativeCallsBefore);
      if (reading === 'short') {
        assert.equal(result.status, 'valid');
        assert.equal(result.target.sourceHash, targetHash, 'whole-file hash requires the complete short-read loop');
        assert.equal(boundedBytes, boundedSize);
      } else {
        assert.equal(result.status, 'unverified');
        assert.equal(result.target, undefined, 'changed content must not receive a whole-file hash');
        assert.match(result.reason, /changed while reading/);
        assert.equal(boundedBytes, reading === 'grow' ? boundedSize + 1 : 1);
      }
      boundedMode = undefined;
      await fs.writeFile(target, originalTarget);
    }

    const noRead = async action => {
      const previousOpens = opens, previousCalls = calls.length;
      const result = await action();
      assert.notEqual(result.status, 'valid');
      assert.equal(opens, previousOpens, 'blocked target must not be opened for content');
      assert.equal(calls.length, previousCalls, 'blocked target must not reach native resolution');
      return result;
    };
    const denied = await noRead(() => run('src/target.ts::work', 'project', { admit: request => request.role === 'document' }));
    assert.match(denied.reason, /not admitted/);
    await noRead(() => run('../foreign/secret.ts', 'project', { admit: request => !request.path.includes('/foreign/') }));
    await fs.symlink(join(root, 'foreign/secret.ts'), join(root, 'feature/src/foreign.ts'));
    await noRead(() => run('src/foreign.ts::secret', 'project', { admit: request => !request.path.includes('/foreign/') }));
    await fs.symlink('/etc/hosts', join(root, 'feature/src/escape.ts'));
    assert.match((await noRead(() => run('src/escape.ts'))).reason, /escapes/);
    await noRead(() => run('src/target.ts::work', 'project', { admit: () => false }));
    await fs.writeFile(join(root, 'feature/src/race.ts'), 'admitted before swap');
    await noRead(() => run('src/race.ts::work', 'project', { admit: async request => {
      if (request.role === 'target') { await fs.unlink(request.path); await fs.symlink(join(root, 'foreign/secret.ts'), request.path); }
      return true;
    } }));

    mode = 'ambiguous';
    assert.equal((await run('src/target.ts::work')).status, 'ambiguous');
    mode = 'stale';
    const stale = await run('src/target.ts::work');
    assert.equal(stale.status, 'unverified');
    assert.equal(stale.target, undefined);
    mode = 'mutate';
    assert.equal((await run('src/target.ts::work')).status, 'unverified');
    await fs.writeFile(target, 'export function work() {\\n  return 1;\\n}\\n');
    mode = 'swap';
    const beforeSwapCalls = calls.length;
    const swapped = await run('src/target.ts::work');
    assert.equal(swapped.status, 'unverified');
    assert.equal(swapped.target, undefined);
    assert.equal(calls.length, beforeSwapCalls + 1);
    assert.equal(digest(calls.at(-1).args.capturedSource.text), targetHash, 'request carries pinned bytes, not replacement pathname content');
    await fs.unlink(target);
    await fs.writeFile(target, 'export function work() {\\n  return 1;\\n}\\n');
    const controller = new AbortController();
    mode = 'cancel';
    await assert.rejects(() => run('src/target.ts::work', 'project', { signal: controller.signal }), { name: 'AbortError' });
    const previousOpens = opens;
    await assert.rejects(() => run('src/target.ts', 'project', { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(opens, previousOpens);
    assert.equal(defaultCalls, 0, 'neither code nor Markdown selector branch may hit the poisoned default');
    assert.deepEqual(new Set(calls.map(item => item.operation)), new Set(['pi_nav_symbol_range', 'pi_nav_read']));
    console.log('association admission, bases, identity, both injected branches, large range, drift and cancellation verified');
  `], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /association admission, bases, identity/);
});
