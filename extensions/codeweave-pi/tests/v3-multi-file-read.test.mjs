import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import jeitoCodeweavePiExtension from "../index.ts";
import { certifyExactLeads } from "../src/core/source-authority.ts";
import { renderRead, renderReadBatch } from "../src/core/read-renderer.ts";
import { canonicalExistingPath } from "../src/core/path-resolve.ts";
import { computeTag, snapshots } from "../src/core/snapshot-store.ts";
import { readParams } from "../src/tools/read.ts";

const HEADER_RE = /^\[(.+)#([0-9A-F]{8})\]$/gm;

function makePi() {
  const tools = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    getActiveTools() { return []; },
    getAllTools() { return [...tools.values()]; },
    tool(name) {
      const tool = tools.get(name);
      assert.ok(tool, `missing tool ${name}`);
      return tool;
    },
  };
}

async function execute(tool, params, cwd, signal) {
  return tool.execute(`p6-${tool.name}`, params, signal, undefined, { cwd, mode: "print", hasUI: false, ui: { notify() {} } });
}

function textOf(result) {
  return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

function headerMap(text) {
  const result = new Map();
  for (const match of text.matchAll(HEADER_RE)) result.set(match[1], match[2]);
  return result;
}

test("read schema and execute enforce closed path branches before filesystem work", async () => {
  assert.equal(readParams.type, "object");
  assert.deepEqual(Object.keys(readParams.properties), ["path", "paths"]);
  assert.equal(readParams.additionalProperties, false);
  assert.equal(readParams.properties.paths.minItems, 1);
  assert.equal(readParams.properties.paths.maxItems, 8);
  assert.equal(readParams.properties.paths.items.maxLength, 4096);

  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const tool = pi.tool("read");
  const cwd = await mkdtemp(join(tmpdir(), "p6-schema-"));
  const sparse = new Array(2);
  sparse[0] = "a.ts";
  for (const params of [
    {},
    { paths: [] },
    { paths: Array.from({ length: 9 }, (_, index) => `${index}.ts`) },
    { paths: ["a.ts", 2] },
    { paths: sparse },
    { paths: ["x".repeat(4097)] },
    { paths: ["a.ts"], extra: true },
  ]) assert.match(textOf(await execute(tool, params, cwd)), /INVALID CALL: read[\s\S]*Read refused:[\s\S]*nothing ran/i);
});

test("read merges path and paths into one batch when both are supplied", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "p6-merge-"));
  await writeFile(join(cwd, "a.ts"), "alpha\n");
  await writeFile(join(cwd, "b.ts"), "beta\n");
  const result = await execute(pi.tool("read"), { path: "a.ts", paths: ["b.ts"] }, cwd);
  const text = textOf(result);
  assert.doesNotMatch(text, /INVALID CALL/);
  assert.deepEqual(headerMap(text).size >= 2, true, "both files read in one batch");
  assert.match(text, /alpha/);
  assert.match(text, /beta/);
});

test("Markdown section reads accept explicit files outside the session root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "p6-read-root-"));
  const outside = await mkdtemp(join(tmpdir(), "p6-read-outside-"));
  const guide = join(outside, "guide.md");
  await writeFile(guide, "# Intro\nfirst\n## Install\nsecond\n");
  const result = await renderRead({ cwd, path: `${guide}:intro/install#2` });
  assert.match(result.text, /## Install/);
  assert.match(result.text, /second/);
  assert.doesNotMatch(result.text, /root_escape|path escapes session root/);
});

test("multi-file read groups canonical aliases, keeps modes adjacent, and returns bounded per-file failures", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "p6-groups-"));
  await writeFile(join(cwd, "a.ts"), "alpha\nbeta\ngamma\n");
  await writeFile(join(cwd, "guide.md"), "# Intro\nfirst\n## Install\nsecond\nthird\n");
  await symlink(join(cwd, "a.ts"), join(cwd, "alias.ts"));
  await mkdir(join(cwd, "folder"));
  await writeFile(join(cwd, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(cwd, "data.bin"), Buffer.from([0, 1, 2, 3]));

  const result = await execute(pi.tool("read"), {
    paths: [
      "a.ts:1-1",
      "guide.md:intro/install#2",
      "alias.ts:3-3",
      "a.ts:raw",
      "missing.ts:1-2",
      "folder",
      "pixel.png",
      "data.bin",
    ],
  }, cwd);
  const text = textOf(result);
  const files = result.details.files;
  assert.deepEqual(files.map(file => file.requestIndexes), [[0, 2], [3], [1], [4], [5], [6], [7]]);
  assert.deepEqual(files.map(file => file.status), ["shown", "shown_no_authority", "shown", "error", "error", "shown_no_authority", "shown_no_authority"]);
  assert.deepEqual(files[0].selectors, ["a.ts:1-1", "alias.ts:3-3"]);
  assert.equal(files[0].mergedRequestCount, 2);
  assert.equal(files[0].retrySelector, "a.ts:1-1,3-3");
  assert.ok(files[0].tag);
  assert.deepEqual(files[0].intervals, [{ start: 1, end: 1 }, { start: 3, end: 3 }]);
  assert.equal(files[1].tag, undefined);
  assert.equal(files[1].intervals, undefined);
  assert.match(text, /1:alpha\n…\n3:gamma/);
  assert.ok(text.indexOf("raw · no edit hash") < text.indexOf("## Install"), "same-file raw group must stay adjacent to exact group");
  assert.match(text, /Read failed: Read refused: file not found: missing\.ts/);
  assert.match(text, /is a directory\. Use ls/);
  assert.match(text, /Read batch skipped image\/media input/);
  assert.match(text, /looks like binary\/media or non-text data/);
  assert.equal(result.details.complete, false);
  assert.deepEqual(result.details.counts, { requested: 8, groups: 7, shown: 7, errors: 2, omitted: 0 });
});

test("batch selectors preserve separate-read bytes, markdown/code ranges, absolute/home aliases, and edit continuation", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "p6-parity-"));
  const code = join(cwd, "code.ts");
  const doc = join(cwd, "README.md");
  const blocks = join(cwd, "blocks.ts");
  const blocksText = "function alpha() {\n  return 1;\n}\n";
  await writeFile(code, "one\ntwo\nthree\nfour\n");
  await writeFile(doc, "# Intro\nintro body\n## Install\nstep one\nstep two\n");
  await writeFile(blocks, blocksText);

  const batch = await execute(pi.tool("read"), { paths: [`${code}:1-2,4-4`, "README.md:intro/install#2", "blocks.ts:1-3"] }, cwd);
  const separateCode = await renderRead({ cwd, path: `${code}:1-2,4-4` });
  const separateDoc = await renderRead({ cwd, path: "README.md:intro/install#2" });
  const separateBlocks = await renderRead({ cwd, path: "blocks.ts:1-3" });
  assert.equal(textOf(batch), `${separateCode.text}\n\n${separateDoc.text}\n\n${separateBlocks.text}`);
  assert.deepEqual(batch.details.files[0].intervals, separateCode.intervals);
  assert.deepEqual(batch.details.files[1].intervals, separateDoc.intervals);
  const blockSnapshot = snapshots.byTag(canonicalExistingPath(blocks), computeTag(blocksText));
  assert.ok(blockSnapshot?.blocks?.some(block => block.start === 1 && block.end === 3), "complete structural blocks must survive batch authority commit");
  assert.ok(isAbsolute(batch.details.files[0].path));

  const headers = headerMap(textOf(batch));
  const codeTag = headers.get(code);
  const docTag = headers.get("README.md");
  assert.ok(codeTag && docTag);
  await execute(pi.tool("edit"), {
    input: `[${code}#${codeTag}]\nREPLACE 1:\n+ONE\n\n[README.md#${docTag}]\nREPLACE 4:\n+STEP ONE`,
  }, cwd);
  assert.equal(await readFile(code, "utf8"), "ONE\ntwo\nthree\nfour\n");
  assert.equal(await readFile(doc, "utf8"), "# Intro\nintro body\n## Install\nSTEP ONE\nstep two\n");

  const oldHome = process.env.HOME;
  process.env.HOME = cwd;
  try {
    const homeBatch = await renderReadBatch({ cwd, paths: ["~/code.ts:2-2", "code.ts:3-3"] });
    assert.equal(homeBatch.files.length, 1);
    assert.deepEqual(homeBatch.files[0].requestIndexes, [0, 1]);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("aggregate budgeting omits whole groups and commits authority only for complete shown groups", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "p6-budget-"));
  const first = join(cwd, "first.ts");
  const second = join(cwd, "second.ts");
  const rows = Array.from({ length: 40 }, (_, index) => `${index + 1}-${"x".repeat(55)}`).join("\n") + "\n";
  await writeFile(first, rows);
  await writeFile(second, rows.replaceAll("x", "y"));
  const firstCanonical = canonicalExistingPath(first);
  const secondCanonical = canonicalExistingPath(second);
  snapshots.invalidate(firstCanonical);
  snapshots.invalidate(secondCanonical);

  const result = await renderReadBatch({ cwd, paths: ["first.ts:1-40", "second.ts:1-40"], maxBytes: 3_600 });
  assert.deepEqual(result.files.map(file => file.status), ["shown", "omitted"]);
  assert.equal(result.counts.omitted, 1);
  assert.match(result.text, /Omitted groups — retry separately:\n- second\.ts:1-40/);
  assert.ok(snapshots.byTag(firstCanonical, computeTag(rows)));
  assert.equal(snapshots.byTag(secondCanonical, computeTag(rows.replaceAll("x", "y"))), undefined);
});

test("aborted batches commit no authority while explicit external rows certify independently", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "p6-authority-"));
  const outside = await mkdtemp(join(tmpdir(), "p6-outside-"));
  const insidePath = join(cwd, "inside.ts");
  const outsidePath = join(outside, "outside.ts");
  const insideText = "inside\nvalue\n";
  const outsideText = "outside\nvalue\n";
  await writeFile(insidePath, insideText);
  await writeFile(outsidePath, outsideText);
  const insideCanonical = canonicalExistingPath(insidePath);
  const outsideCanonical = canonicalExistingPath(outsidePath);
  snapshots.invalidate(insideCanonical);
  snapshots.invalidate(outsideCanonical);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => renderReadBatch({ cwd, paths: ["inside.ts:1-1"], signal: controller.signal }), /aborted/);
  assert.equal(snapshots.byTag(insideCanonical, computeTag(insideText)), undefined);

  const expansion = await certifyExactLeads({ cwd, nativeText: "Native", leads: [{ path: "inside.ts", start: 1, end: 1, label: "inside" }, { path: outsidePath, start: 1, end: 1, label: "outside" }] });
  assert.equal(expansion.promoted, true, "valid local selectors promote independently across roots");
  assert.equal(expansion.reason, undefined);
  assert.ok(snapshots.byTag(insideCanonical, computeTag(insideText)));
  assert.ok(snapshots.byTag(outsideCanonical, computeTag(outsideText)));

  const manyPath = join(cwd, "many.ts");
  const manyText = Array.from({ length: 401 }, (_, index) => `line-${index + 1}`).join("\n") + "\n";
  await writeFile(manyPath, manyText);
  const manyCanonical = canonicalExistingPath(manyPath);
  snapshots.invalidate(manyCanonical);
  const tooMany = await certifyExactLeads({ cwd, nativeText: "Native", leads: [{ path: "many.ts", start: 1, end: 401, label: "many" }] });
  assert.equal(tooMany.promoted, false);
  assert.match(tooMany.reason, /400-line/);
  assert.equal(snapshots.byTag(manyCanonical, computeTag(manyText)), undefined);

  const widePath = join(cwd, "wide.ts");
  const wideText = Array.from({ length: 160 }, (_, index) => `${index + 1}-${"z".repeat(680)}`).join("\n") + "\n";
  await writeFile(widePath, wideText);
  const wideCanonical = canonicalExistingPath(widePath);
  snapshots.invalidate(wideCanonical);
  const tooWide = await certifyExactLeads({ cwd, nativeText: "Native", leads: [{ path: "wide.ts", start: 1, end: 160, label: "wide" }] });
  assert.equal(tooWide.promoted, false);
  assert.match(tooWide.reason, /96-KiB/);
  assert.equal(snapshots.byTag(wideCanonical, computeTag(wideText)), undefined);

  snapshots.invalidate(insideCanonical);
  const bare = await certifyExactLeads({ cwd, nativeText: "Native", leads: [] });
  assert.equal(bare.promoted, false);
  assert.match(bare.reason, /no exact source selector/);
  assert.equal(snapshots.byTag(insideCanonical, computeTag(insideText)), undefined);

  const tooManyDirectRanges = await certifyExactLeads({
    cwd,
    nativeText: "Native",
    leads: Array.from({ length: 13 }, (_, index) => ({ path: "many.ts", start: index + 1, end: index + 1, label: `row-${index}` })),
  });
  assert.equal(tooManyDirectRanges.promoted, true);
  assert.match(tooManyDirectRanges.reason, /were rejected.*visible proof limit/i);
  assert.ok(snapshots.byTag(manyCanonical, computeTag(manyText)));
});
