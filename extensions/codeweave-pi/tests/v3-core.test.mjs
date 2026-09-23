import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { visibleWidth as tuiVisibleWidth } from "@earendil-works/pi-tui";

import { applyPatch as applyPatchResult } from "../src/core/patch-apply.ts";
import { renderRead } from "../src/core/read-renderer.ts";
import { renderSmartSummary } from "../src/core/summary-renderer.ts";
import { configuredNerdFont, cycleDensity, renderDiffResult, renderDocsSearchCall, renderDocsSearchResult, renderEditCall, renderEditResult, renderExploreCall, renderExploreResult, renderFindResult, renderGrepCall, renderGrepResult, renderLspValidateCall, renderLspValidateResult, renderLsResult, renderReadResult, renderTraceResult, renderWriteResult, resetDisplayDensityForTests } from "../src/core/tui-render.ts";
import { loadNavigationConfig, resolvePreparedLane } from "../src/core/navigation-config.ts";
import { executeWrite } from "../src/core/write-core.ts";
const applyPatch = async params => (await applyPatchResult(params)).text;
import { computeDigest, computeTag, SnapshotStore } from "../src/core/snapshot-store.ts";
// Density isolation: the level is a global shared across surfaces, so land every
// test on `normal` (body-visible) unless it opts into another level explicitly
// via setDensityLevel(). Shape/transition claims live in the matrix test.
const DENSITY_LEVELS = ["ultra", "condensed", "normal", "extended"];
function setDensityLevel(name) {
  const state = (globalThis[Symbol.for("pi.agent.jeitoDensity.v1")] ??= { level: 1 });
  const index = DENSITY_LEVELS.indexOf(name);
  assert.ok(index >= 0, `unknown density level: ${name}`);
  state.level = index;
}
afterEach(() => {
  resetDisplayDensityForTests();
  cycleDensity();
  cycleDensity();
});
import { scheduleQmdDocsRefresh } from "../src/core/qmd-docs-refresh.ts";
import { renderNativeResult, runCommand } from "../src/core/navigation-clean.ts";
import { recordPerfEvent } from "../src/core/perf-telemetry.ts";
import { localSourceHeuristicProvider } from "../src/providers/local-source-heuristic-provider.ts";
import { createPiNavSmartSummaryProvider, summaryFromNative } from "../src/providers/pi-nav-smart-summary-provider.ts";
import { editParams } from "../src/tools/edit.ts";
import { readParams } from "../src/tools/read.ts";
import { writeParams } from "../src/tools/write.ts";

const TAG_RE = /^\[(.+)#([0-9A-F]{8})\]/m;
const ANSI_RE = /\x1b\[[0-9;]*m/;
const FULL_ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

const LEGACY_OR_BACKEND_RE = /range:|\bsections?\b|intent|oldText|newText|files\[\]|\b(?:Tilth|Graphify|Semble|backend|provider)\b/i;

function tagOf(text) {
  const match = TAG_RE.exec(text);
  assert.ok(match, `missing tag in:\n${text}`);
  return { header: match[0], path: match[1], tag: match[2] };
}
function stripAnsi(text) {
  return String(text).replace(FULL_ANSI_RE, "");
}
function docsStateFixture(overrides = {}) {
  const envelopeStatus = overrides.envelopeStatus ?? (overrides.status === "error" ? "error" : overrides.status === "unavailable" ? "warning" : "success");
  const presentation = {
    kind: "docs-search", phase: "complete", status: "ready", query: "fixture", filters: {}, semantic: { status: "ready" },
    generation: "fixture-generation", ranking: { mode: "lexical", currentSelectors: true }, counts: { candidates: 0, filtered: 0, returned: 0 },
    candidateWindow: { limit: 40, returned: 0, saturated: false }, omissions: { count: 0, paths: [] }, diagnostics: [], items: [],
    pageWindows: [{ path: "results", page: 1, total_pages: 1, returned_count: 0, total_count: 0, omitted_before: 0, omitted_after: 0, complete: true }],
    ...overrides,
  };
  delete presentation.envelopeStatus;
  return { content: [{ type: "text", text: "docs fixture" }], details: { envelope: { status: envelopeStatus, summary: "docs fixture", artifacts: [] }, presentation } };
}
function nativeReadOutput(file) {
  return {
    text: "Native smart read",
    structured: {
      schemaVersion: 1,
      operation: "pi_nav_read",
      data: { files: [file] },
      completeness: { complete: true, returned: 1, total: 1, omitted: 0 },
      diagnostics: [],
    },
  };
}



async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-v3-core-"));
}

test("snapshot store evicts old full-text snapshots by byte budget", () => {
  const store = new SnapshotStore({ maxPaths: 10, maxVersionsPerPath: 2, maxBytes: 20 });
  const first = store.record("/tmp/a.txt", "a".repeat(15));
  const second = store.record("/tmp/b.txt", "b".repeat(15));

  assert.equal(store.byTag("/tmp/a.txt", first.tag), undefined);
  assert.equal(store.byTag("/tmp/b.txt", second.tag)?.digest, second.digest);
  assert.ok(store.totalBytes() <= 20);
});

test("TypeScript edit identity normalization covers BOM, line endings, trailing whitespace, final newline, and UTF-8", () => {
  assert.equal(computeDigest(""), computeDigest("\ufeff"), "empty and BOM-only normalize identically");
  const normalized = computeDigest("a\n");
  for (const value of ["a\r\n", "a\r", "\ufeffa   \r\n", "a\t\t\n"]) assert.equal(computeDigest(value), normalized);
  assert.notEqual(computeDigest("a"), normalized, "final newline remains part of edit identity");
  assert.equal(computeDigest("héllo 世界\r\n"), computeDigest("héllo 世界\n"));
});

test("snapshot tags fail closed on an eight-hex collision for one path", () => {
  const firstText = "collision-55045";
  const secondText = "collision-70885";
  assert.equal(computeTag(firstText), computeTag(secondText));
  const store = new SnapshotStore({ maxVersionsPerPath: 4 });
  const first = store.record("/tmp/collision.txt", firstText);
  store.record("/tmp/collision.txt", secondText);
  assert.equal(store.byTag("/tmp/collision.txt", first.tag), undefined);
});

test("QMD live refresh hook only schedules configured Markdown paths", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "live-index-fixture" }));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n");

  assert.deepEqual(scheduleQmdDocsRefresh({ cwd: root, paths: ["docs/guide.md"], env: { PATH: "" } }), {
    scheduled: 0,
    skipped: 1,
    reason: "docs lane not enabled",
  });

  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    docs: { enabled: true, backend: "qmd", repo: "local/live-index", indexPath: ".pi/navigation/qmd" },
  }));

  assert.deepEqual(scheduleQmdDocsRefresh({ cwd: root, paths: ["package.json"], env: { PATH: "" } }), {
    scheduled: 0,
    skipped: 1,
    reason: "no indexable docs changed",
  });
  const scheduled = scheduleQmdDocsRefresh({ cwd: root, paths: ["docs/guide.md"], env: { PATH: "" } });
  assert.equal(scheduled.scheduled, 1);
  assert.equal(scheduled.skipped, 0);
  const scheduledDelete = scheduleQmdDocsRefresh({ cwd: root, paths: ["docs/deleted.md"], env: { PATH: "" } });
  assert.equal(scheduledDelete.scheduled, 1, "deleted docs paths should schedule incremental reconciliation so QMD can prune them");
  assert.equal(scheduledDelete.skipped, 0);
});

test("opt-in perf telemetry records redacted query command metrics without changing output", async () => {
  const root = await fixture();
  const logPath = join(root, "perf.jsonl");
  const secret = "super-secret-token-value";
  const script = "setTimeout(() => console.log('visible-output'), 250)";
  const result = await runCommand(process.execPath, ["-e", script, secret], {
    cwd: root,
    timeoutMs: 10_000,
    env: { PI_NAV_PERF_LOG: logPath, SECRET_API_KEY: secret },
    telemetry: { tool: "grep", backend: "tilth", lane: "tilth", mode: "content" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "visible-output\n");
  assert.equal(result.stderr, "");

  const raw = await readFile(logPath, "utf8");
  assert.doesNotMatch(raw, new RegExp(secret));
  const event = JSON.parse(raw.trim());
  assert.equal(event.kind, "query_command");
  assert.equal(event.tool, "grep");
  assert.equal(event.backend, "tilth");
  assert.equal(event.status, "success");
  assert.equal(event.childCount, 1);
  assert.equal(event.commandFamily, process.platform === "win32" ? "node" : "node");
  assert.equal(event.stdoutBytes, Buffer.byteLength("visible-output\n"));
  assert.equal(event.stderrBytes, 0);
  assert.match(raw, /REDACTED/);
  assert.equal(typeof event.durationMs, "number");
  if (process.platform !== "win32") {
    assert.ok(event.resourceSamples >= 1, JSON.stringify(event));
    assert.ok(event.peakProcessCount >= 1, JSON.stringify(event));
    assert.ok(event.peakRssKb > 0, JSON.stringify(event));
  }
});

test("perf telemetry rotates bounded JSONL logs without affecting callers", async () => {
  const root = await fixture();
  const logPath = join(root, "perf-rotate.jsonl");
  const env = { PI_NAV_PERF_LOG: logPath, PI_NAV_PERF_MAX_BYTES: "1" };

  recordPerfEvent({ kind: "unit", command: "first" }, { root, env });
  recordPerfEvent({ kind: "unit", command: "second" }, { root, env });

  const current = await readFile(logPath, "utf8");
  const rotated = await readFile(`${logPath}.1`, "utf8");
  assert.match(current, /second/);
  assert.match(rotated, /first/);
});
async function readyDocsFixture(root, _repo, docsRootRel = "docs") {
  await mkdir(join(root, docsRootRel), { recursive: true });
  await mkdir(join(root, ".pi", "navigation", "qmd"), { recursive: true });
  await writeFile(join(root, docsRootRel, "README.md"), "# Docs\n");
  return { backend: "qmd", indexPath: ".pi/navigation/qmd" };
}

function r2DocsState() {
  return { backend: "qmd", generationId: "fixture-g1", refreshStatus: "ready", qmd: { status: "lexical_ready", generation: "fixture-g1", health: { needsEmbedding: 0 } } };
}

async function readyArchitectureFixture(root, rootRel) {
  const architectureRoot = join(root, ...rootRel.split("/"));
  const graph = join(architectureRoot, ".code-review-graph", "graph.db");
  const wrapper = join(root, "crg-wrapper.mjs");
  const python = join(root, "crg-python");
  const command = join(root, "owned-crg");
  const alias = `fixture-${rootRel.replace(/[^A-Za-z0-9]+/g, "-")}`;
  await mkdir(join(graph, ".."), { recursive: true });
  await writeFile(graph, "fake graph");
  await writeFile(wrapper, "#!/usr/bin/env node\n");
  await writeFile(python, "#!/bin/sh\nexit 0\n");
  await writeFile(command, `#!${process.execPath}\nprocess.exit(0);\n`);
  await Promise.all([chmod(wrapper, 0o755), chmod(python, 0o755), chmod(command, 0o755)]);
  return {
    config: { enabled: true, backend: "code-review-graph", root: rootRel, indexPath: `${rootRel}/.code-review-graph/graph.db`, command: wrapper, python, embeddingProvider: "local", embeddingModel: "fixture", daemon: { enabled: true, alias } },
    state: { root: rootRel, indexPath: `${rootRel}/.code-review-graph/graph.db`, embeddingReadiness: { ready: true, status: "ready", providerIdentity: "local:fixture", provider: "local", model: "fixture", dimension: 3, graphRevision: "r1", embeddingRevision: "r1", currentNodeCount: 1, currentVectorCount: 1, orphanCount: 0 } },
    env: { CRG_BIN: command, PATH: "" },
  };
}


function assertNavigationSummary(text, label) {
  assert.match(text, TAG_RE, `${label} structural summary should mint one whole-file hash:\n${text}`);
  assert.doesNotMatch(text, ANSI_RE, `${label} leaked ANSI`);
  assert.doesNotMatch(text, LEGACY_OR_BACKEND_RE, `${label} leaked legacy/backend term:\n${text}`);
  assert.match(text, /Structural source summary/, `${label} should identify the source summary`);
  assert.match(text, /^\d+:/m, `${label} should expose complete editable source rows`);
  assert.match(text, /read all needed distant regions at once with .*:\d+-\d+/, `${label} should teach one grouped range read:\n${text}`);
}

// Measure rendered lines with the SAME width function the TUI's over-width crash
// guard uses (pi-tui visibleWidth). The previous hand-rolled ruler disagreed with
// the terminal on glyphs like ✓/⚠ (counted 2 vs the terminal's 1), so it both
// false-failed safe output and could not catch the real over-width crash class.
function testDisplayWidth(text) {
  return tuiVisibleWidth(text);
}

test("custom TUI renderers clamp ANSI, tabs, and CJK output to narrow terminal width", () => {
  const width = 52;
  const crashShape = "\x1b[48;2;24;33;27m20:\treturn readJsonFile(join(home, \".pi\", \"agent\", \"settings.json\"));\x1b[49m\x1b[0m\x1b]8;;\x07";
  const cjkShape = "\x1b[48;2;24;33;27m344:- **경로 정규화** — 22개 이상의 파일에서 통합 `normalizePath` 처리\x1b[49m\x1b[0m\x1b]8;;\x07";
  const emojiBoundaryShape = `${"x".repeat(49)}✅`;
  const editEmojiBoundaryShape = `${"x".repeat(42)}✅`;
  const blocks = [
    renderReadResult({ content: [{ type: "text", text: `[src/a.md#ABCD1234]\n${crashShape}\n${cjkShape}\n${emojiBoundaryShape}` }] }, { expanded: true }, {}, {}),
    renderEditResult({ content: [{ type: "text", text: `[src/a.ts#ABCD1234]\nEdited src/a.ts: 1 hunk, first changed line 1.\n\nDiff: first changed region only.\n-1:${editEmojiBoundaryShape}\n+1:${editEmojiBoundaryShape}` }] }, { expanded: true }, {}, {}),
    renderFindResult({ content: [{ type: "text", text: `OK: 1 path from live filesystem. Paths only, not edit authority.\n${crashShape}` }] }, { expanded: true }, {}, {}),
    renderGrepResult({ content: [{ type: "text", text: `1 returned matches in 1 matched files.\n${crashShape}` }] }, { expanded: true }, {}, {}),
    renderExploreResult({ content: [{ type: "text", text: `OK: 1 safe first-read lead; 0 unsafe leads demoted. Leads only, not edit authority.\nSources: semantic used (${crashShape})\n\n${crashShape}` }] }, { expanded: true }, {}, {}),
    renderTraceResult({ content: [{ type: "text", text: `OK: trace complete. Leads only, not edit authority.\nSources: graph used (${crashShape}).\n\n${crashShape}` }] }, { expanded: true }, {}, {}),
    renderWriteResult({ content: [{ type: "text", text: `[src/a.md#ABCD1234]\n${crashShape}` }] }, { expanded: true }, {}, {}),
    renderDiffResult({ content: [{ type: "text", text: `diff --git a/a b/a\n+${crashShape}` }] }, { expanded: true }, {}, {}),
  ];
  for (const block of blocks) {
    for (const line of block.render(width)) {
      assert.ok(testDisplayWidth(line) <= width, `line width ${testDisplayWidth(line)} > ${width}: ${line}`);
      assert.doesNotMatch(line, /\x1b\]/, `OSC escape should not survive clamped overlong lines: ${line}`);
    }
  }
  const coloredNarrow = renderEditResult({ content: [{ type: "text", text: `[src/a.ts#ABCD1234]\nEdited src/a.ts: 1 hunk, first changed line 1.\n\nDiff: first changed region only.\n-1:${"old ".repeat(40)}\n+1:${"new ".repeat(40)}` }] }, { expanded: false }, {}, {}).render(width).join("\n");
  assert.match(coloredNarrow, /\x1b\[[0-9;]*m/, `narrow clamping should preserve SGR colors:\n${coloredNarrow}`);
});

test("diff TUI renders semantic diff evidence without fake +0 -0 patch stats", () => {
  const rendered = renderDiffResult({ content: [{ type: "text", text: "Diff review\nsummary=Analyzed 1 changed file(s)\nrisk_score=0.91\nreview_priorities[1]: changedSymbol" }] }, { expanded: false }, {}, {}).render(160).join("\n");
  const plain = stripAnsi(rendered);
  assert.match(plain, /diff review/);
  assert.doesNotMatch(plain, /diff \+0 -0/);
  assert.match(plain, /risk_score=0\.91/);
});

test("find TUI uses native Tilth result totals instead of counting wrapper lines", () => {
  const noMatches = stripAnsi(renderFindResult({ content: [{ type: "text", text: "Path search\nScope: docs\nPattern: guidance → **/*guidance*\n# Glob: \"**/*guidance*\" in /tmp/project/docs — 0 files\n\nNo matches. Available extensions in scope: json, md" }] }, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(noMatches, /0 files/);
  assert.doesNotMatch(noMatches, /2 files/);
  assert.match(noMatches, /No matches\./);

  const matches = stripAnsi(renderFindResult({ content: [{ type: "text", text: "Path search\nScope: .\nPattern: *.ts\n# Glob: \"*.ts\" in /tmp/project — 12 files\n\nProject files\n  src/a.ts" }] }, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(matches, /12 files/);
});

test("find TUI groups structured pattern buckets and keeps zero buckets visible", () => {
  const result = {
    content: [{ type: "text", text: "native find output" }],
    details: { native: { completeness: { returned: 2 }, data: {
      patterns: [{ input: "*navigation*.ts" }, { input: "*grep*.ts" }, { input: "*.mjs" }],
      entries: [
        { path: "src/core/navigation-clean.ts", kind: "file", tokenEstimate: 7845, matchedPatterns: ["*navigation*.ts"] },
        { path: "src/tools/grep.ts", kind: "file", tokenEstimate: 817, matchedPatterns: ["*grep*.ts"] },
      ],
    } } },
  };
  const plain = stripAnsi(renderFindResult(result, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(plain, /\*navigation\*\.ts \(1\)/);
  assert.match(plain, /\*grep\*\.ts \(1\)/);
  assert.match(plain, /\*\.mjs \(0\)/);
  assert.match(plain, /src\/core\/navigation-clean\.ts/);
  assert.match(plain, /navigation-clean\.ts  ~7845 tokens/);
  assert.match(plain, /grep\.ts  ~817 tokens/);
  assert.doesNotMatch(plain, /navigation-clean\.ts.*\[\*navigation/);
});

test("ls tree uses typed colored connectors and entry decoration instead of raw native prose", () => {
  const result = {
    content: [{ type: "text", text: "# Directory: /tmp/project\nraw uncolored tree" }],
    details: { native: { completeness: { complete: true, returned: 4 }, data: { entries: [
      { path: "docs", kind: "directory", depth: 1, tokenEstimate: 0 },
      { path: "docs/guide.md", kind: "file", depth: 2, tokenEstimate: 12 },
      { path: "src", kind: "directory", depth: 1, tokenEstimate: 0 },
      { path: "src/main.ts", kind: "file", depth: 2, tokenEstimate: 20 },
    ] } } },
  };
  const theme = { fg: (_style, text) => `\x1b[38;5;45m${text}\x1b[0m`, bold: text => text };
  const rendered = renderLsResult(result, { expanded: false }, theme, { args: { view: "tree" } }).render(120).join("\n");
  const plain = stripAnsi(rendered);
  assert.match(rendered, /\x1b\[/);
  assert.match(plain, /├─ .*docs/);
  assert.match(plain, /guide\.md.*~12/);
  assert.match(plain, /└─ .*src/);
  assert.match(plain, /main\.ts.*~20/);
  assert.doesNotMatch(plain, /# Directory:|raw uncolored tree/);
});

test("Nerd Font decoration is frontend-only and fails closed when the terminal font is unknown", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-tui-font-"));
  await mkdir(join(home, ".config", "ghostty"), { recursive: true });
  await writeFile(join(home, ".config", "ghostty", "config"), "font-family = JetBrains Mono Nerd Font\n");
  assert.equal(configuredNerdFont({ TERM_PROGRAM: "ghostty" }, home), true);
  assert.equal(configuredNerdFont({ TERM_PROGRAM: "unknown" }, home), false);
  assert.equal(configuredNerdFont({ PI_NAV_NERD_FONT: "off", TERM_PROGRAM: "ghostty" }, home), false);
});

test("partial results with useful evidence use a partial marker instead of a warning triangle", () => {
  const result = {
    content: [{ type: "text", text: "partial native listing" }],
    details: {
      envelope: { status: "warning" },
      native: {
        completeness: { complete: false, returned: 1 },
        data: { patterns: [{ input: "*.ts" }], entries: [{ path: "src/a.ts", kind: "file", matchedPatterns: ["*.ts"] }] },
      },
    },
  };
  const plain = stripAnsi(renderFindResult(result, { expanded: false }, {}, {}).render(120).join("\n"));
  assert.match(plain, /╰── ◐ 1 file/);
  assert.doesNotMatch(plain, /⚠/);

  const ls = stripAnsi(renderLsResult({ content: [{ type: "text", text: "empty partial" }], details: { envelope: { status: "warning" }, native: { completeness: { complete: false, returned: 0 }, data: { entries: [] } } } }, { expanded: false }, {}, { args: { view: "list" } }).render(120).join("\n"));
  assert.match(ls, /⚠/);
});

test("lsp_validate renders shared colored frames with typed per-file statuses", () => {
  const args = { paths: ["src/a.ts", "notes.txt"], includeWarnings: false, limit: 20 };
  const result = {
    content: [{ type: "text", text: "LSP validation\nClean: src/a.ts\nUnsupported: notes.txt" }],
    details: { files: [
      { path: "src/a.ts", status: "clean", diagnostics: [] },
      { path: "notes.txt", status: "unsupported", diagnostics: [], note: "No primary server." },
    ], envelope: { status: "warning" } },
  };
  const theme = { fg: (_style, text) => `\x1b[38;5;45m${text}\x1b[0m`, bold: text => `\x1b[1m${text}\x1b[22m` };
  const normal = renderLspValidateResult(result, { expanded: false }, theme, { args }).render(120).join("\n");
  const plain = stripAnsi(normal);
  assert.match(normal, /\x1b\[/);
  assert.match(plain, /Clean: src\/a\.ts/);
  assert.match(plain, /Unsupported: notes\.txt · No primary server\./);
  assert.match(plain, /◐ 1 clean • 1 unsupported/);
});

test("density levels preserve typed evidence ordering and ignore ctx.expanded", () => {
  // Shape claims (one-line ultra, header/footer at wider levels, spacer matrix,
  // no-throw transitions) are owned by tests/jeito-density-matrix.test.mjs.
  // This test owns what the matrix cannot: codeweave-pi's CONTENT ordering across
  // levels and that Pi's ctx.expanded never advances jeito density.
  setDensityLevel("ultra");
  const args = { pattern: "needle", paths: "src", syntax: "literal", output: "matches", case: "smart", visibility: "project", contextLines: 10 };
  const sourceRows = Array.from({ length: 40 }, (_, index) => ({ path: "src/a.ts", line: index + 1, text: index === 19 ? "const needle = true;" : `const row${index + 1} = ${index + 1};` }));
  const result = {
    content: [{ type: "text", text: "native matches result" }],
    details: {
      envelope: { status: "success", artifacts: ["[src/a.ts#ABCD1234] lines 1-40"] },
      native: { completeness: { complete: true, returned: 1 }, data: {
        mode: "matches",
        resolved: { syntax: "literal", output: "matches", requestedCase: "smart", effectiveCase: "sensitive", contextLines: 10 },
        coverage: { complete: true, occurrences: 1, groups: 1, returnedGroups: 1, more: false },
        groups: [{ path: "src/a.ts", range: { start: 1, end: 40 }, owner: { kind: "function", name: "run", start: 1, end: 40 }, matches: [{ line: 20, text: "const needle = true;" }] }],
        sourceRows,
        targets: [{ requested: "src", outcome: "searched", occurrences: 1 }],
      } },
    },
  };
  const theme = { fg: (_style, text) => `\x1b[38;5;45m${text}\x1b[0m`, bold: text => `\x1b[1m${text}\x1b[22m` };
  const contextA = { args, state: {}, expanded: false, cwd: "/tmp/project" };
  const render = context => {
    const call = renderGrepCall(args, theme, context);
    renderGrepResult(result, { expanded: context.expanded }, theme, context);
    return call.render(100);
  };

  setDensityLevel("condensed");
  const condensedA = render(contextA);
  setDensityLevel("normal");
  const normalA = render(contextA);
  const freshToolCtx = { args, state: {}, expanded: false, cwd: "/tmp/project" };
  const newToolAtNormal = render(freshToolCtx);
  // Toggling Pi's ctx.expanded must NOT advance jeito density — only Ctrl+U does.
  freshToolCtx.expanded = true;
  const stillNormal = render(freshToolCtx);
  setDensityLevel("extended");
  const extendedA = render(contextA);

  assert.ok(condensedA.length > 1, `condensed shows header+preview, not bare chrome: ${condensedA.length}`);
  assert.ok(normalA.length > condensedA.length, `normal should show more typed evidence than condensed: ${normalA.length} <= ${condensedA.length}`);
  assert.match(stripAnsi(normalA.join("\n")), /function run/, "normal should preserve typed owner evidence");
  assert.equal(newToolAtNormal.length, normalA.length, "a new tool inherits the current global level");
  assert.equal(stillNormal.length, normalA.length, "toggling ctx.expanded (Ctrl+O) must not advance jeito density");
  assert.ok(extendedA.length >= normalA.length, `extended should show at least as much as normal: ${extendedA.length} < ${normalA.length}`);
  const targetArgs = { target: "src/worker.ts:Worker.flush", focus: ["callers", "documentation"] };
  const targetCall = renderGrepCall(targetArgs, theme, { args: targetArgs, state: {}, cwd: "/tmp/project" });
  assert.match(stripAnsi(targetCall.render(100).join("\n")), /Worker\.flush/, "target-only requests must not render as an empty pattern");
});

test("batch read TUI pins failed groups and marks usable partial evidence", () => {
  const result = {
    content: [{ type: "text", text: "[src/a.ts#ABCD1234]\n1:alpha\n\n[missing.ts:1-2]\nRead failed: file not found" }],
    details: {
      counts: { groups: 2, shown: 2, errors: 1 },
      files: [
        { status: "shown", path: "src/a.ts", tag: "ABCD1234" },
        { status: "error", retrySelector: "missing.ts:1-2", reason: "Read refused: file not found: missing.ts" },
      ],
    },
  };
  const plain = stripAnsi(renderReadResult(result, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(plain, /Failed: missing\.ts:1-2 · Read refused: file not found: missing\.ts/);
  assert.match(plain, /◐ 1\/2 shown • 1 failed • 1 hash/);
  assert.doesNotMatch(plain, /✓ 2\/2/);
});

test("batch read TUI renders per-file headers, ranges and highlighted source for every file", () => {
  const longBody = Array.from({ length: 24 }, (_value, index) => `${index + 1}:line ${index + 1}`).join("\n");
  const result = {
    content: [{ type: "text", text: `[src/a.ts#AAAA1111]\n${longBody}\n\n[src/b.ts#BBBB2222]\n5:beta\n6:gamma\n\n[docs/c.md#CCCC3333]\n3:# heading` }],
    details: {
      counts: { groups: 3, shown: 3, errors: 0, omitted: 0 },
      files: [
        { status: "shown", path: "src/a.ts", tag: "AAAA1111", intervals: [{ start: 1, end: 24 }] },
        { status: "shown", path: "src/b.ts", tag: "BBBB2222", intervals: [{ start: 5, end: 6 }] },
        { status: "shown", path: "docs/c.md", tag: "CCCC3333", intervals: [{ start: 3, end: 3 }] },
      ],
    },
  };
  const collapsed = stripAnsi(renderReadResult(result, { expanded: false }, {}, {}).render(160).join("\n"));
  // Every file keeps its own header (path + ranges + hash) instead of a flat dump.
  for (const path of ["src/a.ts", "src/b.ts", "docs/c.md"]) assert.match(collapsed, new RegExp(path.replace(/\//g, "\\/")));
  // Ranges render as bracket spans: [1-24] for multi-line, [3] for a single line.
  assert.match(collapsed, /\[1-24\]/);
  assert.match(collapsed, /\[5-6\]/);
  assert.match(collapsed, /\[3\]/);
  assert.match(collapsed, /#AAAA1111/);
  assert.match(collapsed, /#CCCC3333/);
  // Highlighted source rows render with the read gutter, and a long file is
  // Highlighted source rows render with the read gutter, and a long file is
  // truncated per file rather than hiding the later files entirely.
  assert.match(collapsed, /│/);
  assert.doesNotMatch(collapsed, /line 24/);
  assert.match(collapsed, /line 19/);
  assert.match(collapsed, /✓ 3\/3 shown • 3 hashes/);
  // Extended mode reveals the full long file.
  setDensityLevel("extended");
  const extended = stripAnsi(renderReadResult(result, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(extended, /line 24/);
});

test("diff summary TUI renders typed changed-symbol units instead of expanding function bodies", () => {
  const result = {
    content: [{ type: "text", text: "# Diff: src/a.ts — 2 symbols touched\nlarge body that should not drive the summary" }],
    details: { native: { data: {
      files: [{ path: "src/a.ts", change: "modified" }],
      symbols: [
        { name: "run", change: "signature_changed", location: { path: "src/a.ts", start: 10, end: 30 } },
        { name: "helper", change: "added", location: { path: "src/a.ts", start: 32, end: 38 } },
        { name: "import x", change: "unchanged", location: { path: "src/a.ts", start: 1, end: 1 } },
      ],
    } } },
  };
  const plain = stripAnsi(renderDiffResult(result, { expanded: false }, {}, { args: { view: "summary" } }).render(160).join("\n"));
  assert.match(plain, /signature changed · src\/a\.ts:10-30 · run/);
  assert.match(plain, /added · src\/a\.ts:32-38 · helper/);
  assert.match(plain, /1 file • 2 changed symbols/);
  assert.doesNotMatch(plain, /large body/);
  assert.doesNotMatch(plain, /import x/);
});

test("ranked grep TUI uses typed owner ranges and bounded source instead of slicing the full body", () => {
  const result = {
    content: [{ type: "text", text: "# Search: registerGrepTool\nlarge function body\n-- calls --\nmany repeated relationships" }],
    details: {
      envelope: { status: "success", artifacts: ["[src/tools/grep.ts#A38A03BB]"] },
      native: {
        completeness: { returned: 1, total: 2 },
        data: {
          kind: "symbol", case: "sensitive", totalFound: 2, definitions: 2, usages: 0,
          facetTotals: { definitions: 2, implementations: 0, tests: 0 },
          matches: [{ role: "definition", symbol: "registerGrepTool", location: { path: "src/tools/grep.ts", start: 38, end: 162 } }],
          sourceRows: [{ path: "src/tools/grep.ts", line: 38, text: "export function registerGrepTool(" }],
        },
      },
    },
  };
  const rendered = renderGrepResult(result, { expanded: false }, {}, {}).render(160).join("\n");
  assert.match(rendered, /\x1b\[/, "ranked grep source should retain syntax highlighting");
  const plain = stripAnsi(rendered);
  assert.match(plain, /registerGrepTool — 2 def · 0 use/);
  assert.match(plain, /src\/tools\/grep\.ts:38/);
  assert.match(plain, /38 │ export function registerGrepTool/);
  assert.match(plain, /\[src\/tools\/grep\.ts#A38A03BB\] lines 38/);
  assert.match(plain, /Coverage: ranked page · 1\/2 structured matches shown/);
  assert.doesNotMatch(plain, /large function body|many repeated relationships/);
});

test("ranked grep TUI surfaces truncation cause when completeness.reason marks the response incomplete", () => {
  const result = {
    content: [{ type: "text", text: "# Search: error" }],
    details: {
      envelope: { status: "success", artifacts: ["[src/core/tui-render.ts#91AA62C3]"] },
      native: {
        completeness: { complete: false, returned: 10, total: 31, omitted: 21, reason: "candidate_cap" },
        data: {
          kind: "literal", case: "insensitive", totalFound: 31, definitions: 0, usages: 10,
          facetTotals: { definitions: 0, implementations: 0, tests: 0 },
          matches: Array.from({ length: 10 }, (_, index) => ({
            role: "usage", symbol: "error", location: { path: "src/core/tui-render.ts", start: index + 1, end: index + 1 },
          })),
          sourceRows: [],
        },
      },
    },
  };
  const plain = stripAnsi(renderGrepResult(result, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(plain, /Coverage: ranked page · 10\/31 structured matches shown · incomplete: candidate-cap/);
});

test("ranked grep TUI stays silent when completeness.complete is true even when some matches were dropped", () => {
  const result = {
    content: [{ type: "text", text: "# Search: registerGrepTool" }],
    details: {
      envelope: { status: "success", artifacts: ["[src/tools/grep.ts#A38A03BB]"] },
      native: {
        completeness: { complete: true, returned: 1, total: 2 },
        data: {
          kind: "symbol", case: "sensitive", totalFound: 2, definitions: 2, usages: 0,
          facetTotals: { definitions: 2, implementations: 0, tests: 0 },
          matches: [{ role: "definition", symbol: "registerGrepTool", location: { path: "src/tools/grep.ts", start: 38, end: 162 } }],
          sourceRows: [{ path: "src/tools/grep.ts", line: 38, text: "export function registerGrepTool(" }],
        },
      },
    },
  };
  const plain = stripAnsi(renderGrepResult(result, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(plain, /Coverage: ranked page · 1\/2 structured matches shown$/m);
  assert.doesNotMatch(plain, /incomplete:/);
});


test("grep TUI preserves structured exceptions, clipping, cursor, filter, and authority evidence", () => {
  setDensityLevel("extended");
  const result = {
    content: [{ type: "text", text: "native matches output" }],
    details: {
      envelope: { status: "warning", artifacts: ["[src/a.ts#ABCD1234]"] },
      native: {
        completeness: { returned: 1 },
        data: {
          mode: "matches",
          resolved: { syntax: "literal", case: "smart", effectiveCase: "sensitive", contextLines: 1 },
          filter: [{ customOverride: true, excluded: 3 }],
          groups: [{
            path: "src/a.ts",
            owner: { kind: "function", name: "run", start: 2, end: 8 },
            outline: [
              { kind: "function", name: "before", start: 1, end: 1, selected: false },
              { kind: "function", name: "run", start: 2, end: 8, selected: true },
              { kind: "function", name: "after", start: 9, end: 9, selected: false },
            ],
            matches: [{ line: 4, text: "needle", textClipped: false }],
          }],
          sourceRows: [
            { path: "src/a.ts", line: 3, text: "const before = 1;" },
            { path: "src/a.ts", line: 4, text: "const needle = true;" },
            { path: "src/a.ts", line: 5, text: "return needle;" },
          ],
          exceptions: [{ path: "binary.dat", outcome: "skipped", reason: "binary_nul" }],
          targets: [{ requested: ".", outcome: "partial", reasons: ["binary.dat: binary_nul"] }],
          coverage: { complete: false, occurrences: 7, clippedSourceLines: 1 },
          cursor: "grep-next",
      },
    },
    },
  };
  const plain = stripAnsi(renderGrepResult(result, { expanded: true }, {}, {}).render(160).join("\n"));
  assert.match(plain, /custom nav/);
  assert.match(plain, /src\/a\.ts:2-8 \[function run\]/);
  assert.match(plain, /\[1-1\] function before/);
  assert.match(plain, /→ \[2-8\] function run/);
  assert.match(plain, /3 ┆ const before = 1/);
  assert.match(plain, /4 │ const needle = true/);
  assert.match(plain, /Exceptional: binary\.dat · skipped · binary_nul/);
  assert.match(plain, /Target: \. · partial · binary\.dat: binary_nul/);
  assert.match(plain, /oversized source line clipped · exact spans preserved/);
  assert.match(plain, /Authority: clipped source rows are not certified/);
  assert.match(plain, /\[src\/a\.ts#ABCD1234\] lines 3-5/);
  assert.match(plain, /7 occurrences · partial/);
  assert.match(plain, /More matches: continue with grep\(\{cursor:"grep-next"/);
  assert.match(plain, /1 exception/);
  for (const line of renderGrepResult(result, { expanded: false }, {}, {}).render(52)) {
    assert.ok(testDisplayWidth(line) <= 52, `line width ${testDisplayWidth(line)} > 52: ${line}`);
  }
});

test("grep TUI does not label a complete zero target as an exception", () => {
  const result = { content: [{ type: "text", text: "zero" }], details: { envelope: { status: "success", summary: "complete zero", artifacts: [] }, native: { completeness: { returned: 0, total: 0, complete: true }, data: { mode: "matches", resolved: { syntax: "literal", case: "smart", effectiveCase: "sensitive", contextLines: 0 }, groups: [], exceptions: [], targets: [{ requested: "src", outcome: "zero", occurrences: 0, reasons: [] }], coverage: { complete: true, occurrences: 0 }, sourceRows: [] } } } };
  const plain = stripAnsi(renderGrepResult(result, { expanded: false }, {}, {}).render(120).join("\n"));
  assert.match(plain, /0 matches/);
  assert.doesNotMatch(plain, /exception/);
});


test("edit TUI renders inline diff output and gives edits a 50-line preview budget", () => {
  const editText = [
    "[src/a.ts#ABCD1234]",
    "Edited src/a.ts: 1 hunk, first changed line 10.",
    "",
    "10:const answer = 42;",
    "",
    "Diff: first changed region only; increase expand or use git diff for a full file comparison.",
    " 8:const before = 1;",
    "-9:const answer = 41;",
    "+9:const answer = 42;",
    ...Array.from({ length: 80 }, (_, index) => ` ${index + 10}:context ${index}`),
  ].join("\n");
  const rendered = renderEditResult({ content: [{ type: "text", text: editText }] }, { expanded: false }, {}, {}).render(160);
  const plain = stripAnsi(rendered.join("\n"));
  assert.match(plain, /edit diff \+1 -1/);
  assert.match(plain, /-\s*9\s+│ const answer = 41/);
  assert.match(plain, /\+\s*9\s+│ const answer = 42/);
  assert.match(plain, /╰── ✓ edited src\/a\.ts \+1 -1 • hash ABCD1234/);
  assert.ok(rendered.length <= 50, plain);
});

test("write TUI shows written file preview with inferable compressed path", () => {
  const writeText = [
    "[/Users/example/work/project/src/generated/demo.ts#BEEF5678]",
    "Created /Users/example/work/project/src/generated/demo.ts (500 bytes).",
    "",
    ...Array.from({ length: 40 }, (_, index) => `${index + 1}:export const value${index + 1} = ${index + 1};`),
  ].join("\n");
  const normal = renderWriteResult({ content: [{ type: "text", text: writeText }] }, { expanded: false }, {}, { cwd: "/Users/example/work/project" }).render(180);
  const normalPlain = stripAnsi(normal.join("\n"));
  assert.match(normalPlain, /1\s+│ export const value1 = 1;/);
  assert.match(normalPlain, /14 more UI lines hidden/);
  assert.doesNotMatch(normalPlain, /40\s+│ export const value40 = 40;/);
  assert.match(normalPlain, /╰── ✓ created src\/generated\/demo\.ts • 40 lines • hash BEEF5678/);
  assert.ok(normal.length <= 30, normalPlain);

  setDensityLevel("extended");
  const extended = renderWriteResult({ content: [{ type: "text", text: writeText }] }, { expanded: false }, {}, { cwd: "/Users/example/work/project" }).render(180);
  const extendedPlain = stripAnsi(extended.join("\n"));
  assert.match(extendedPlain, /40\s+│ export const value40 = 40;/);
  assert.doesNotMatch(extendedPlain, /more UI lines hidden/);
  assert.ok(extended.length > normal.length && extended.length <= 120, extendedPlain);
});

test("native navigation rendering does not append handoff identities", () => {
  const text = renderNativeResult("Code map", { results: [{ path: "src/a.ts", start: 1, end: 80, summary: "native row" }] }, [{ path: "src/a.ts", start: 1, end: 80, label: "a" }], { contextLabel: "Code structure" });
  assert.match(text, /Code structure[\s\S]*## results/);
  assert.doesNotMatch(text, /Handoff identities/);
  assert.doesNotMatch(text, /^\d+\.\s+src\/a\.ts/m);
});

test("trace TUI renders typed relationship rows once with origin, range, page, and authority", () => {
  const result = {
    content: [{ type: "text", text: "raw trace metadata that should not drive the collapsed TUI\n## results\n## edges\n## metadata" }],
    details: {
      envelope: { status: "success", summary: "verbose trace summary", artifacts: ["[tests/a.test.ts#ABCD1234]"] },
      presentation: {
        kind: "trace",
        relation: "tests",
        target: "src/a.ts::run",
        rows: [
          { origin: "tests_for", path: "tests/a.test.ts", start: 10, end: 18, label: "run rejects stale input", isTest: true },
          { origin: "callers_of", path: "index.ts", start: 20, end: 20, label: "projectExtension" },
        ],
        pageWindows: [{ path: "results", page: 1, total_pages: 1, complete: true }],
      },
    },
  };
  const plain = stripAnsi(renderTraceResult(result, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(plain, /Tests: 1 direct · 1 supplemental candidate/);
  assert.match(plain, /tests\/a\.test\.ts:10-18 \[direct test\]/);
  assert.match(plain, /index\.ts:20 \[caller candidate\]/);
  assert.match(plain, /\[tests\/a\.test\.ts#ABCD1234\] live authority/);
  assert.match(plain, /Page 1\/1 · complete/);
  assert.doesNotMatch(plain, /## metadata/);
});

test("trace graph TUI preserves path and explain evidence instead of reducing it to source rows", () => {
  for (const relation of ["path", "explain"]) {
    const text = relation === "path"
      ? "Graph path: A -> B\n\nGraph context\nShortest path (1 hops):\n  A --calls [EXTRACTED]--> B"
      : "Graph explain: A\n\nGraph context\nNode: A\n  ID: node_a\n\nConnections (1):\n  --> B [calls] [EXTRACTED] src/a.ts:L7";
    const result = { content: [{ type: "text", text }], details: { envelope: { status: "success", summary: `Graph ${relation}: evidence`, artifacts: [] }, presentation: { kind: "trace", relation, target: "A", rows: [], pageWindows: [] } } };
    const plain = stripAnsi(renderTraceResult(result, { expanded: true }, {}, {}).render(180).join("\n"));
    assert.match(plain, relation === "path" ? /Shortest path \(1 hops\)/ : /Connections \(1\)/);
    assert.doesNotMatch(plain, /0 relationship rows/);
  }
});

test("trace TUI surfaces the reason when a focused relation returns no rows", () => {
  const result = { content: [{ type: "text", text: "empty trace" }], details: { envelope: { status: "warning", summary: "Code callers: no leads found", artifacts: [] }, presentation: { kind: "trace", relation: "callers", target: "push", rows: [], summary: "'push' is a common builtin — callers_of skipped to avoid noise.", pageWindows: [] } } };
  const plain = stripAnsi(renderTraceResult(result, { expanded: false }, {}, {}).render(180).join("\n"));
  assert.match(plain, /Code callers: no leads found/);
  assert.match(plain, /common builtin — callers_of skipped to avoid noise/);
});

test("trace batch TUI preserves ordered target statuses and compact exact rows", () => {
  const result = {
    content: [{ type: "text", text: "large batch model output" }],
    details: {
      envelope: { status: "warning", artifacts: ["[src/a.ts#ABCD1234]"] },
      presentation: {
        kind: "trace-batch", relation: "callers", items: [
          { target: "alpha", status: "success", presentation: { rows: [{ path: "src/entry.ts", start: 8 }] } },
          { target: "beta", status: "warning", presentation: { rows: [] } },
        ],
      },
    },
  };
  const plain = stripAnsi(renderTraceResult(result, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(plain, /2 trace queries/);
  assert.match(plain, /alpha · 1 row/);
  assert.match(plain, /src\/entry\.ts:8/);
  assert.match(plain, /beta · 0 rows/);
  assert.match(plain, /\[src\/a\.ts#ABCD1234\] live authority/);
});

test("docs_search TUI presents active ranking, provenance, selectors, snippets, validity, and paging", () => {
  setDensityLevel("extended");
  const result = {
    content: [{ type: "text", text: "model-visible docs evidence" }],
    details: {
      envelope: { status: "success", summary: "Returned 2 current QMD section leads.", artifacts: [] },
      presentation: {
        kind: "docs-search", phase: "complete", status: "ready", query: "displayed source safely editable",
        filters: { glob: "docs/**/*.md" }, provider: "qmd-local+zeroentropy", semantic: { status: "ready" },
        generation: "ABCDEF0123456789", privacy: "local_index_cloud_inference", latencyMs: 734,
        health: { totalDocs: 900, needsEmbedding: 0 }, ranking: { mode: "hybrid", embeddingModel: "zeroentropy/zembed-1", rerankerModel: "zeroentropy/zerank-2", currentSelectors: true },
        counts: { candidates: 12, filtered: 7, returned: 2 }, candidateWindow: { limit: 40, returned: 12, saturated: false }, omissions: { count: 0, paths: [] }, diagnostics: [],
        items: [
          { rank: 1, retrievalRank: 2, label: "Unified source authority", authorityRole: "current_authority", readSelector: "docs/automatic-workflow.md:implemented-runtime-flows/3-unified-source-authority#2", startLine: 67, endLine: 81, snippet: "Complete displayed current rows become editable under one whole-file hash.", retrievalScore: 0.82, nativeScore: 0.77, titlePrior: 0, authorityPrior: 0.35, finalScore: 1.17, explain: { ftsScores: [0.82], vectorScores: [0.71], rerankScore: 0.93, rrf: { contributions: [{}, {}] } } },
          { rank: 2, retrievalRank: 4, label: "2. Live-source authority", authorityRole: "current_authority", readSelector: "docs/evidence.md:current-evidence-map/live-source-authority#2", startLine: 51, endLine: 59, snippet: "Locator-only evidence remains non-editable until current bytes are certified.", retrievalScore: 0.74, nativeScore: 0.69, titlePrior: 0, authorityPrior: 0.35, finalScore: 1.09, explain: { ftsScores: [0.74], vectorScores: [0.67], rerankScore: 0.88, rrf: { contributions: [{}] } } },
        ],
        pageWindows: [{ path: "results", page: 1, total_pages: 4, returned_count: 2, total_count: 7, omitted_before: 0, omitted_after: 5, complete: false, next_page: 2 }],
      },
    },
  };
  const plain = stripAnsi(renderDocsSearchResult(result, { expanded: false }, {}, {}).render(180).join("\n"));
  assert.match(plain, /Search mode: hybrid · current document-section evidence active/);
  assert.match(plain, /lexical \+ vector \+ reranker \+ title\/authority priors · current Markdown selectors/);
  assert.match(plain, /Generation: ABCDEF0123456789 · current selectors · 734ms/);
  assert.match(plain, /1\. Unified source authority · current authority · retrieval #2/);
  assert.match(plain, /2\. Live-source authority/);
  assert.doesNotMatch(plain, /2\. 2\. Live-source authority/);
  assert.match(plain, /read docs\/automatic-workflow\.md:implemented-runtime-flows\/3-unified-source-authority#2/);
  assert.match(plain, /Complete displayed current rows become editable/);
  assert.match(plain, /Page 1\/4 · 2\/7 shown · next 2 · omitted 0\/5/);
  assert.match(plain, /2 ranked sections · hybrid/);
  const expanded = stripAnsi(renderDocsSearchResult(result, { expanded: true }, {}, {}).render(200).join("\n"));
  assert.match(expanded, /Retrieval score 0\.8200 · title \+0\.0000 · authority \+0\.3500 · final 1\.1700 · native 0\.7700/);
  assert.match(expanded, /Provenance: BM25 0\.8200 · vector 0\.7100 · rerank 0\.9300 · RRF 2 lists/);
  assert.match(expanded, /Privacy: local_index_cloud_inference/);
  assert.doesNotMatch(expanded, /qmd-local|zembed|zerank|pi-nav/i);
  assert.match(expanded, /Index coverage: 900\/900 section vectors/);
});

test("docs_search TUI covers active lexical and hybrid modes plus zero, filtered, partial, unavailable, and error results", () => {
  setDensityLevel("extended");
  const call = renderDocsSearchCall({ query: "query purity", path: "docs/harness-doctrine.md", page: 2, limit: 3 }, {}, { width: 140 }).render(140).join("\n");
  assert.match(call, /\x1b\[38;2;79;195;247m/);
  assert.match(stripAnsi(call), /docs_search "query purity" · path docs\/harness-doctrine\.md · page 2 · limit 3/);
  const progress = stripAnsi(renderDocsSearchResult({ content: [{ type: "text", text: "searching" }], details: { presentation: { kind: "docs-search", phase: "searching", status: "pending", query: "query purity", filters: { path: "docs/harness-doctrine.md" }, items: [] } } }, { isPartial: true }, {}, {}).render(140).join("\n"));
  assert.match(progress, /Query: "query purity"/);
  assert.match(progress, /… searching document sections/);
  const zero = docsStateFixture({ status: "lexical_ready", semantic: { status: "unavailable", reason: "provider_not_configured" }, items: [], counts: { candidates: 0, filtered: 0, returned: 0 } });
  assert.match(stripAnsi(renderDocsSearchResult(zero, {}, {}, {}).render(140).join("\n")), /✓ 0 ranked sections · lexical/);
  const semanticWeakLeads = docsStateFixture({ envelopeStatus: "warning", status: "ready", semantic: { status: "ready" }, ranking: { mode: "hybrid" }, items: [{ rank: 1, retrievalRank: 1, label: "Nearest section", authorityRole: "supporting_documentation", readSelector: "docs/guide.md:nearest#2", snippet: "A ranked but weakly supported section.", answerability: { status: "weak_lead", reasons: ["low_reranker_signal"] } }], counts: { candidates: 2, filtered: 2, returned: 1 }, candidateWindow: { limit: 40, returned: 2, saturated: false }, answerability: { status: "weak_leads_only", answer_bearing_count: 0, weak_lead_count: 2, low_rerank_weak: 2, weak_vector_weak: 0, max_rerank_score: 0.31 } });
  const weakPlain = stripAnsi(renderDocsSearchResult(semanticWeakLeads, {}, {}, {}).render(240).join("\n"));
  assert.match(weakPlain, /Answerability: 0 answer-bearing · 2 weak lead\(s\) · scores rank candidates, not confidence probabi/);
  assert.match(weakPlain, /Weak leads only: inspect the ranked sections, but do not treat them as an answer or universal abs/);
  assert.match(weakPlain, /Nearest section.*weak lead/);
  assert.match(weakPlain, /◐ 1 ranked section · hybrid/);
  const filtered = docsStateFixture({ status: "lexical_ready", semantic: { status: "unavailable", reason: "provider_not_configured" }, filters: { glob: "runbooks\/**" }, items: [], counts: { candidates: 8, filtered: 0, returned: 0 } });
  assert.match(stripAnsi(renderDocsSearchResult(filtered, {}, {}, {}).render(140).join("\n")), /No current candidates survived the requested path\/glob filter/);
  const degraded = docsStateFixture({ status: "lexical_ready", semantic: { status: "degraded", reason: "provider_query_failed: 503" }, items: [{ rank: 1, retrievalRank: 1, label: "Lexical fallback", authorityRole: "current_authority", readSelector: "docs/guide.md:lexical-fallback#2", snippet: "Useful lexical evidence remains visible.", retrievalScore: 0.8, authorityPrior: 0.35, finalScore: 1.15 }], counts: { candidates: 40, filtered: 1, returned: 1 }, candidateWindow: { limit: 40, returned: 40, saturated: true }, omissions: { count: 1, paths: [{ path: "docs/stale.md", reason: "indexed_section_stale" }] } });
  const degradedPlain = stripAnsi(renderDocsSearchResult(degraded, {}, {}, {}).render(160).join("\n"));
  assert.match(degradedPlain, /Candidate window: 40\/40 · lower bound/);
  assert.match(degradedPlain, /Selector omissions: 1/);
  assert.match(degradedPlain, /◐ 1 ranked section · lexical/);
  const unavailable = docsStateFixture({ envelopeStatus: "warning", status: "unavailable", semantic: { status: "unavailable", reason: "qmd_section_index_missing" }, items: [] });
  assert.match(stripAnsi(renderDocsSearchResult(unavailable, {}, {}, {}).render(140).join("\n")), /⚠ 0 ranked sections · lexical/);
  const error = docsStateFixture({ envelopeStatus: "error", status: "error", semantic: { status: "unknown" }, diagnostics: ["database failed"], items: [] });
  assert.match(stripAnsi(renderDocsSearchResult(error, {}, {}, {}).render(140).join("\n")), /✗ 0 ranked sections · lexical/);
});

test("explore call rendering exposes incompatible supplied identities", () => {
  const plain = stripAnsi(renderExploreCall({ view: "code", operation: "search", anchor: "rankedScope", query: "hidden map query", depth: 2 }, {}, {}).render(180).join("\n"));
  assert.match(plain, /rankedScope/);
  assert.match(plain, /supplied query.*hidden map query/);
  assert.match(plain, /depth 2/);
});

test("explore code TUI presents lexical mode as active evidence without readiness deterrents", () => {
  const result = {
    content: [{ type: "text", text: "Native code evidence\n## semantic_readiness\nprovider_identity=secretly-long\n## metadata" }],
    details: {
      envelope: { status: "success", summary: "Code search completed in lexical mode", artifacts: [] },
      presentation: {
        kind: "explore", view: "code", operation: "search", identity: "source authority certification",
        status: "degraded", searchMode: "keyword", semanticStatus: "unavailable",
        semanticReadiness: { reason: "graph changed after embedding generation", currentNodes: 5968, vectorCount: 5921, staleDeleted: 45 },
        candidates: [], pageWindows: [{ path: "results", page: 1, returned_count: 0, total_count: 0 }],
      },
    },
  };
  const plain = stripAnsi(renderExploreResult(result, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(plain, /Search mode: keyword · lexical code evidence active/);
  assert.doesNotMatch(plain, /Semantic recall unavailable|Reason:|stale\/deleted|semantic limited/);
  assert.match(plain, /╰── ✓ 0 ranked code identities · keyword/);
  assert.doesNotMatch(plain, /provider_identity/);
});

test("explore code TUI preserves useful lexical candidates without demoting the prepared result", () => {
  const result = {
    content: [{ type: "text", text: "bounded degraded result" }],
    details: {
      envelope: { status: "success", artifacts: [] },
      presentation: {
        kind: "explore", view: "code", operation: "search", identity: "qmd refresh", status: "degraded", searchMode: "fts_keyword", semanticStatus: "degraded",
        semanticReadiness: { reason: "graph changed after embedding generation", currentNodes: 6136, vectorCount: 6051, staleDeleted: 69 },
        candidates: [{ kind: "Function", name: "src/core/qmd-native-refresh.ts::refresh", path: "src/core/qmd-native-refresh.ts", start: 99, end: 146, score: 0.016393 }],
        pageWindows: [{ path: "results", page: 1, returned_count: 1, total_count: 1 }],
      },
    },
  };
  const plain = stripAnsi(renderExploreResult(result, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(plain, /Function src\/core\/qmd-native-refresh\.ts::refresh/);
  assert.match(plain, /retrieval-rank=0\.016/);
  assert.match(plain, /1 ranked code identity · fts_keyword/);
  assert.doesNotMatch(plain, /confidence=/);
});

test("explore File identity TUI presents lexical identity evidence directly", () => {
  const result = {
    content: [{ type: "text", text: "File identity" }],
    details: { envelope: { status: "success", artifacts: [] }, presentation: {
      kind: "explore", view: "code", operation: "search", identity: "index.ts", status: "ok", searchMode: "fts_keyword", semanticStatus: "not_applicable", semanticApplicable: false,
      candidates: [{ kind: "File", name: "index.ts", path: "index.ts", start: 1, end: 427, score: 0.065574 }],
      generation: "abcdef012345", pageWindows: [{ path: "results", page: 1, returned_count: 1, total_count: 1 }], backendFetch: { fetched_count: 1, lower_bound: false },
    } },
  };
  const plain = stripAnsi(renderExploreResult(result, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(plain, /Search mode: fts_keyword · lexical File identity evidence active/);
  assert.match(plain, /File index\.ts · index\.ts:1-427/);
  assert.match(plain, /╰── ✓ 1 ranked code identity · fts_keyword/);
  assert.doesNotMatch(plain, /Semantic recall unavailable|semantic limited/);
});

test("explore traversal TUI renders topology, paging, generation, and truthful not-found status", () => {
  const success = { content: [{ type: "text", text: "topology" }], details: { envelope: { status: "warning", artifacts: [] }, presentation: {
    kind: "explore", view: "code", operation: "traverse", identity: "index.ts", status: "ok", generation: "abcdef012345", nextPage: 2,
    backendFetch: { fetched_count: 6, lower_bound: true, native_truncated: true }, pageWindows: [{ path: "traversal", page: 1, returned_count: 5, total_count: 6 }],
    traversal: { startNode: "index.ts", mode: "bfs", maxDepth: 1, truncated: true, nodes: [{ kind: "File", name: "index.ts", path: "index.ts", start: 1, end: 427, depth: 0 }], edges: [{ kind: "CONTAINS", source: "index.ts", target: "index.ts::start", path: "index.ts", line: 1, confidence: 1, provenance: "EXTRACTED" }] }, authority: [],
  } } };
  const plain = stripAnsi(renderExploreResult(success, { expanded: false }, {}, {}).render(180).join("\n"));
  assert.match(plain, /Start: index\.ts · bfs depth 1 · native truncated/);
  assert.match(plain, /NODE d0 File index\.ts/);
  assert.match(plain, /EDGE index\.ts --CONTAINS \[EXTRACTED · confidence=1\]--> index\.ts::start/);
  assert.match(plain, /page 1 · 5 shown · 6\+ fetched lower-bound · next 2 · generation abcdef01 · native truncated/);
  assert.match(plain, /╰── ◐ 1 topology node • 1 edge/);

  const missing = { content: [{ type: "text", text: "not found" }], details: { envelope: { status: "warning", artifacts: [] }, presentation: { kind: "explore", view: "code", operation: "traverse", identity: "missing.ts", status: "not_found", traversal: { nodes: [], edges: [] }, pageWindows: [{ path: "traversal", page: 1, returned_count: 0, total_count: 0 }] } } };
  const missingPlain = stripAnsi(renderExploreResult(missing, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(missingPlain, /╰── ⚠ topology start not found/);
  assert.doesNotMatch(missingPlain, /✓ 0 code candidates/);

  const ambiguous = { content: [{ type: "text", text: "ambiguous" }], details: { envelope: { status: "warning", artifacts: [] }, presentation: { kind: "explore", view: "code", operation: "traverse", identity: "src/index.ts", status: "ambiguous", traversal: { nodes: [], edges: [] }, ambiguityCandidates: [{ kind: "File", name: "packages/a/src/index.ts", path: "packages/a/src/index.ts", start: 1, end: 20 }, { kind: "File", name: "packages/b/src/index.ts", path: "packages/b/src/index.ts", start: 1, end: 30 }] } } };
  const ambiguousPlain = stripAnsi(renderExploreResult(ambiguous, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(ambiguousPlain, /Ambiguous identities:/);
  assert.match(ambiguousPlain, /packages\/a\/src\/index\.ts/);
  assert.match(ambiguousPlain, /╰── ⚠ ambiguous topology start · 2 candidates/);
});

test("explore map TUI warns when the requested callable is not an actual graph start", () => {
  const result = {
    content: [{ type: "text", text: "large graph metadata" }],
    details: {
      envelope: { status: "success", summary: "Graph map: 2 leads", artifacts: [] },
      presentation: {
        kind: "explore", view: "map", query: "src/core/tui-render.ts renderGrepResult()", anchoring: "explicit-seeded",
        starts: ["render()", "tui-render.ts"],
        nodes: ["NODE tui-render.ts [src=src/core/tui-render.ts loc=L1]"],
        edges: ["EDGE render() --contains [EXTRACTED]--> tui-render.ts"],
        pageWindows: [{ path: "nodes", page: 1, returned_count: 1, total_count: 9, total_pages: 9 }, { path: "edges", page: 1, returned_count: 1, total_count: 2, total_pages: 2 }],
        nextPage: 2,
      },
    },
  };
  const plain = stripAnsi(renderExploreResult(result, { expanded: false }, {}, {}).render(160).join("\n"));
  assert.match(plain, /Starts: render\(\), tui-render\.ts/);
  assert.match(plain, /Requested callable renderGrepResult\(\) was not selected as a graph start/);
  assert.match(plain, /NODE tui-render\.ts/);
  assert.match(plain, /Page 1\/9 · nodes 1\/9 · edges 1\/2 · next 2/);
  assert.match(plain, /╰── ⚠ 1 nodes • 1 edges/);
});

test("explore TUI result uses native status summary and does not duplicate Sources", () => {
  const text = [
    "OK: native graph context returned; 10 handoff identities available.",
    "Primary: tilth (structural-fallback; code relationship terms without a concrete trace target).",
    "Sources: graph skipped (relationship graph navigation is not set up for this folder); tilth used (query variants: read).",
    "Navigation setup needed: relationship graph is not ready. I’m using structural handoff identities below instead. Live find/grep/read still work for current-file proof. Safe next step: ask to “prepare this folder for better navigation”.",
    "",
    "1. [tilth]",
    "   src/tools/read.ts:1-80",
    "   why: structural match for read",
    "   next: read({ path:\"src/tools/read.ts:1-80\" })",
  ].join("\n");
  const block = renderExploreResult({ content: [{ type: "text", text }] }, { expanded: true }, {}, {});
  const rendered = block.render(240).join("\n");
  const plainRendered = stripAnsi(rendered);
  assert.match(plainRendered, /✓ OK: native graph context returned/);
  assert.doesNotMatch(plainRendered, /✓ 0 leads/);
  assert.equal((plainRendered.match(/^│ Sources:/gm) ?? []).length, 1, rendered);
  assert.match(plainRendered, /Navigation setup needed: relationship graph is not ready/);
});

test("explore TUI result uses native summary after an interpreted preface", () => {
  const text = [
    "Interpreted as: ownership/responsibility.",
    "WARNING: native architecture context returned; 5 handoff identities available.",
    "Planned primary: architecture (ownership).",
    "",
    "1. [files]",
    "   src/tools/grep.ts:23-80",
    "   next: read({ path:\"src/tools/grep.ts:23-80\" })",
  ].join("\n");
  const block = renderExploreResult({ content: [{ type: "text", text }] }, { expanded: false }, {}, {});
  const rendered = block.render(240).join("\n");
  assert.match(rendered, /⚠ Interpreted as: ownership\/responsibility\./);
  assert.doesNotMatch(rendered, /⚠ 0 leads/);
});

test("explore TUI result uses useful starting point summary", () => {
  const text = [
    "Found: 3 useful starting points.",
    "Starter summary: begin with README.md:1-80; read before making claims.",
    "Best source: current files.",
    "",
    "1. README.md:1-80",
    "   next: read({ path:\"README.md:1-80\" })",
  ].join("\n");
  const block = renderExploreResult({ content: [{ type: "text", text }] }, { expanded: false }, {}, {});
  const rendered = block.render(240).join("\n");
  assert.match(rendered, /✓ Found: 3 useful starting points\./);
  assert.doesNotMatch(rendered, /✓ 0 leads/);
});

test("navigation config contract resolves exactly three hook-maintained prepared lanes", async () => {
  const cwd = await fixture();
  const nested = join(cwd, "src", "feature");
  const docsReady = await readyDocsFixture(cwd, "local/demo-docs", "docs");
  const architectureReady = await readyArchitectureFixture(cwd, "agent/extensions/codeweave-pi");
  await mkdir(nested, { recursive: true });
  await mkdir(join(cwd, ".pi", "navigation"), { recursive: true });
  await mkdir(join(cwd, "graphify-out"), { recursive: true });
  await writeFile(join(cwd, "graphify-out", "graph.json"), JSON.stringify({ nodes: [], links: [] }));
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({
    preparedIntelligence: { maxAgeMs: 60_000 },
    architecture: architectureReady.config,
    docs: { enabled: true, backend: "QMD", repo: "local/demo-docs", root: "docs", ...docsReady },
    graph: { enabled: true, backend: "Graphify", graphPath: "graphify-out/graph.json" },
  }, null, 2));
  await writeFile(join(cwd, ".pi", "navigation", "state.json"), JSON.stringify({
    indexes: {
      architecture: architectureReady.state,
      docs: { repo: "local/demo-docs", root: "docs", indexPath: ".pi/navigation/qmd", indexedAt: "2026-06-17T00:00:10.000Z", ...r2DocsState() },
      graph: { graphPath: "graphify-out/graph.json", updatedAt: "2026-06-17T00:00:20.000Z" },
    },
  }, null, 2));

  const bundle = await loadNavigationConfig(nested);
  assert.equal(bundle.root, cwd);
  assert.match(bundle.configPath, /\.pi-navigation\.json$/);
  assert.match(bundle.statePath, /\.pi\/navigation\/state\.json$/);

  const now = new Date("2026-06-17T00:00:40.000Z");
  const architecture = await resolvePreparedLane(nested, "architecture", { now, env: architectureReady.env });
  assert.equal(architecture.ok, true, architecture.reason);
  assert.equal(architecture.root, join(cwd, "agent", "extensions", "codeweave-pi"));
  assert.equal(architecture.indexPath, join(cwd, "agent", "extensions", "codeweave-pi", ".code-review-graph", "graph.db"));
  assert.match(architecture.reason, /code-review-graph enabled/);

  const docs = await resolvePreparedLane(nested, "docs", { now });
  assert.equal(docs.ok, true, docs.reason);
  assert.equal(docs.repo, "local/demo-docs");
  assert.equal(docs.root, join(cwd, "docs"));
  assert.match(docs.reason, /qmd repo local\/demo-docs/i);

  const graph = await resolvePreparedLane(nested, "graph", { now });
  assert.equal(graph.ok, true, graph.reason);
  assert.equal(graph.graphPath, join(cwd, "graphify-out", "graph.json"));

  const missingOldLane = await resolvePreparedLane(nested, "semantic", { now });
  assert.equal(missingOldLane.ok, false);
  assert.match(missingOldLane.reason, /semantic lane not configured/);

  const obsolete = await resolvePreparedLane(nested, "tilth", { now });
  assert.equal(obsolete.ok, false);
  assert.match(obsolete.reason, /tilth lane not configured/);
});

test("navigation config inherits the three prepared lanes from a covering parent while ignoring obsolete child state", async () => {
  const cwd = await fixture();
  const childRel = "agent/extensions/codeweave-pi";
  const child = join(cwd, ...childRel.split("/"));
  const docsReady = await readyDocsFixture(cwd, "local/parent-docs", childRel);
  const architectureReady = await readyArchitectureFixture(cwd, childRel);
  await mkdir(join(cwd, ".pi", "navigation"), { recursive: true });
  await mkdir(join(child, ".pi", "navigation"), { recursive: true });
  await mkdir(join(child, "graphify-out"), { recursive: true });
  await writeFile(join(child, "graphify-out", "graph.json"), JSON.stringify({ nodes: [], links: [] }));
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({
    preparedIntelligence: { maxAgeMs: 60_000 },
    docs: { enabled: true, backend: "QMD", repo: "local/parent-docs", root: childRel, ...docsReady },
    graph: { enabled: true, backend: "Graphify", root: childRel, graphPath: `${childRel}/graphify-out/graph.json` },
    architecture: architectureReady.config,
  }, null, 2));
  await writeFile(join(cwd, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: {
    docs: { repo: "local/parent-docs", root: childRel, indexPath: ".pi/navigation/qmd", indexedAt: "2026-06-17T00:00:00.000Z", ...r2DocsState() },
    graph: { root: childRel, graphPath: `${childRel}/graphify-out/graph.json`, updatedAt: "2026-06-17T00:00:00.000Z" },
    architecture: architectureReady.state,
  } }, null, 2));
  await writeFile(join(child, ".pi-navigation.json"), JSON.stringify({
    preparedIntelligence: { maxAgeMs: 60_000 },
    tilth: { enabled: true, backend: "Tilth", glob: "src/**/*.ts" },
  }, null, 2));
  await writeFile(join(child, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: {
    tilth: { root: ".", updatedAt: "2026-06-17T00:00:00.000Z" },
  } }, null, 2));
  const now = new Date("2026-06-17T00:00:01.000Z");

  const docs = await resolvePreparedLane(child, "docs", { now });
  const graph = await resolvePreparedLane(child, "graph", { now });
  const architecture = await resolvePreparedLane(child, "architecture", { now, env: architectureReady.env });
  const obsolete = await resolvePreparedLane(child, "tilth", { now });

  assert.equal(docs.ok, true, docs.reason);
  assert.equal(docs.configPath, join(cwd, ".pi-navigation.json"));
  assert.equal(graph.ok, true, graph.reason);
  assert.equal(architecture.ok, true, architecture.reason);
  assert.equal(obsolete.ok, false);
  assert.match(obsolete.reason, /tilth lane not configured/);

  await writeFile(join(child, ".pi-navigation.json"), JSON.stringify({ docs: { enabled: false } }, null, 2));
  const disabledDocs = await resolvePreparedLane(child, "docs", { now });
  assert.equal(disabledDocs.ok, false);
  assert.match(disabledDocs.reason, /docs disabled/);
});

test("navigation config does not reject usable prepared lanes based on age", async () => {
  const cwd = await fixture();
  const docsFixture = await readyDocsFixture(cwd, "local/old-docs");
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({
    preparedIntelligence: { maxAgeMs: 1 },
    docs: { enabled: true, repo: "local/old-docs", ...docsFixture },
    graph: { enabled: false },
  }, null, 2));
  await writeFile(join(cwd, ".pi", "navigation", "state.json"), JSON.stringify({
    indexes: { docs: { ...docsFixture, repo: "local/old-docs", indexedAt: "2026-06-17T00:00:00.000Z", ...r2DocsState() } },
  }, null, 2));

  const docs = await resolvePreparedLane(cwd, "docs", { now: new Date("2026-06-17T00:00:05.000Z") });
  assert.equal(docs.ok, true, docs.reason);
  assert.match(docs.reason, /qmd/i);
  const graph = await resolvePreparedLane(cwd, "graph", { now: new Date("2026-06-17T00:00:05.000Z") });
  assert.equal(graph.ok, false);
  assert.match(graph.reason, /graph disabled/);

  const noDocs = await resolvePreparedLane(await fixture(), "docs", { now: new Date("2026-06-17T00:00:00.000Z"), env: {} });
  assert.equal(noDocs.ok, false);
  assert.match(noDocs.reason, /docs lane not configured/);
});


test("graph lane remains query-ready when its last update is old", async () => {
  const root = await fixture();
  const graphPath = join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json");
  await mkdir(join(root, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(graphPath, JSON.stringify({ nodes: [], edges: [] }));
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    graph: { enabled: true, backend: "Graphify", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" },
  }, null, 2));
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({
    indexes: { graph: { graphPath: ".pi/navigation/graphify/graphify-out/graph.json", updatedAt: "2020-01-01T00:00:00.000Z" } },
  }, null, 2));

  const lane = await resolvePreparedLane(root, "graph", { now: new Date("2026-07-11T00:00:00.000Z") });
  assert.equal(lane.ok, true, lane.reason);
  assert.match(lane.reason, /Graphify graph/);
});

test("public schemas expose only current hashline read/edit/write fields", () => {
  assert.deepEqual(Object.keys(readParams.properties).sort(), ["path", "paths"]);
  assert.equal(readParams.properties.paths.maxItems, 8);
  assert.deepEqual(Object.keys(editParams.properties).sort(), ["input"]);
  assert.deepEqual(Object.keys(writeParams.properties).sort(), ["content", "overwrite", "path"]);
  const schemas = { readParams: [readParams.properties], editParams: [editParams.properties], writeParams: [writeParams.properties] };
  for (const [name, variants] of Object.entries(schemas)) {
    for (const properties of variants) for (const forbidden of ["range", "budget", "changes", "files", "section", "sections", "oldText", "newText", "intent", "offset", "limit", "heading"]) {
      assert.equal(Object.hasOwn(properties, forbidden), false, `${name} legacy schema field leaked: ${forbidden}`);
    }
  }
});

test("write/read/edit/stale/multihunk/raw/malformed gates", async () => {
  const cwd = await fixture();
  const path = join(cwd, "smoke.txt");

  const writeOut = await executeWrite({ cwd, path, content: "alpha\nbeta\ngamma\n" });
  assert.match(writeOut, TAG_RE);
  assert.doesNotMatch(writeOut, ANSI_RE);
  const old = tagOf(writeOut);

  const readOut = (await renderRead({ cwd, path: `${path}:1-2` })).text;
  assert.match(readOut, TAG_RE);
  assert.match(readOut, /1:alpha\n2:beta/);
  assert.doesNotMatch(readOut, ANSI_RE);

  const editOut = await applyPatch({ cwd, patch: `${old.header}\nREPLACE 2:\n+BETA` });
  assert.match(editOut, TAG_RE);
  assert.match(editOut, /2:BETA/);
  assert.doesNotMatch(editOut, ANSI_RE);
  const fresh = tagOf(editOut);
  assert.notEqual(fresh.tag, old.tag);
  assert.equal(await readFile(path, "utf8"), "alpha\nBETA\ngamma\n");

  assert.match(
    await applyPatch({ cwd, patch: `${old.header}\nREPLACE 2:\n+SECOND` }),
    /stale source could not be remapped safely/,
  );
  assert.equal(await readFile(path, "utf8"), "alpha\nBETA\ngamma\n");

  const multiOut = await applyPatch({ cwd, patch: `${fresh.header}\nREPLACE 1:\n+ALPHA\nINSERT AFTER 3:\n+delta` });
  assert.match(multiOut, TAG_RE);
  assert.equal(await readFile(path, "utf8"), "ALPHA\nBETA\ngamma\ndelta\n");

  const raw = (await renderRead({ cwd, path: `${path}:1-2:raw` })).text;
  assert.match(raw, /\[.*smoke\.txt · raw · no edit hash\]/);
  assert.match(raw, /ALPHA\nBETA/);
  assert.doesNotMatch(raw, TAG_RE);

  assert.match(
    await applyPatch({ cwd, patch: `${tagOf(multiOut).header}\nREPLACE 2:\n-BETA` }),
    /'-' rows are not valid/,
  );

  await assert.rejects(
    executeWrite({ cwd, path, content: "oops\n" }),
    /Write refused:[\s\S]*already exists[\s\S]*overwrite:true/,
  );
  assert.equal(await readFile(path, "utf8"), "ALPHA\nBETA\ngamma\ndelta\n");
  const overwriteOut = await executeWrite({ cwd, path, content: "replacement\n", overwrite: true });
  assert.match(overwriteOut, /Overwrote/);
  assert.match(overwriteOut, TAG_RE);
  assert.equal(await readFile(path, "utf8"), "replacement\n");
});

test("overlapping natural edit operations reject their conflict group before writing", async () => {
  const cwd = await fixture();
  const path = join(cwd, "overlap.txt");
  const header = tagOf(await executeWrite({ cwd, path, content: "one\ntwo\nthree\n" })).header;
  assert.match(
    await applyPatch({ cwd, patch: `${header}\nREPLACE 1..2:\n+ONE\n\nREPLACE 2..3:\n+TWO` }),
    /Rejected conflicting changes|Needs attention/,
  );
  assert.equal(await readFile(path, "utf8"), "one\ntwo\nthree\n");
});

test("oh-my-pi path selectors support first lines, from-line-to-EOF, and multi-range", async () => {
  const cwd = await fixture();
  const path = join(cwd, "selectors.txt");
  await writeFile(path, "one\ntwo\nthree\nfour\nfive\n");
  assert.match((await renderRead({ cwd, path: `${path}:1+2` })).text, /1:one\n2:two/);
  assert.match((await renderRead({ cwd, path: `${path}:4-` })).text, /4:four\n5:five/);
  assert.match((await renderRead({ cwd, path: `${path}:1-1,5-5` })).text, /1:one\n…\n5:five/);
});

test("markdown section selectors support compact QMD refs, mixed ranges, and slug collisions", async () => {
  const cwd = await fixture();
  const path = join(cwd, "guide.md");
  await writeFile(path, [
    "# Parent ✨",
    "intro",
    "## Section One",
    "alpha",
    "```",
    "## Fake",
    "```",
    "### Child Header",
    "child",
    "## Repeat",
    "first repeat",
    "## Repeat",
    "second repeat",
    "",
    "Other Title",
    "-----------",
    "setext body",
    "",
  ].join("\n"));

  const section = (await renderRead({ cwd, path: `${path}:parent/section-one#2` })).text;
  assert.match(section, TAG_RE);
  assert.match(section, /3:## Section One\n4:alpha[\s\S]*8:### Child Header\n9:child/);
  assert.match(section, /Within: Parent ✨/);
  assert.doesNotMatch(section, /10:## Repeat/);

  const mixed = (await renderRead({ cwd, path: `${path}:parent/section-one#2,12-,parent/repeat-2#2` })).text;
  assert.match(mixed, /3:## Section One[\s\S]*9:child\n…\n12:## Repeat[\s\S]*17:setext body/);

  const setext = (await renderRead({ cwd, path: `${path}:parent/other-title#2` })).text;
  assert.match(setext, /15:Other Title\n16:-----------\n17:setext body/);

  const ownedRange = (await renderRead({ cwd, path: `${path}:8-9` })).text;
  assert.match(ownedRange, /Within: Parent ✨ > Section One > Child Header/);
  assert.match(ownedRange, /8:### Child Header\n9:child/);

  await assert.rejects(
    renderRead({ cwd, path: `${path}:30-20` }),
    /end must be >= start/,
  );

  await assert.rejects(
    renderRead({ cwd, path: `${path}:parent/section-one` }),
    /not a valid selector|file not found|unsupported selector/,
  );
});

test("bare reads of large docs/source return hashed structural source while directories remain navigation", async () => {
  const cwd = await fixture();
  const md = join(cwd, "README.md");
  const mdLines = ["# Intro", "text", "```", "# Fake Heading", "```", "## Install", ...Array.from({ length: 140 }, (_, i) => `detail ${i}`)];
  await writeFile(md, `${mdLines.join("\n")}\n`);
  const mdSummary = (await renderRead({ cwd, path: md })).text;
  assert.match(mdSummary, TAG_RE);
  assert.match(mdSummary, /Structural source summary/);
  assert.match(mdSummary, /^1:# Intro/m);
  assert.match(mdSummary, /^6:## Install/m);

  const code = join(cwd, "auth.ts");
  const codeLines = [
    "import express from 'express'",
    "",
    "export function handleAuth(req, res) {",
    "  return req.user",
    "}",
    "",
    ...Array.from({ length: 140 }, (_, i) => `// filler ${i}`),
  ];
  await writeFile(code, `${codeLines.join("\n")}\n`);
  const codeSummary = (await renderRead({ cwd, path: code })).text;
  assert.match(codeSummary, TAG_RE);
  assert.match(codeSummary, /Structural source summary/);
  assert.match(codeSummary, /^3:export function handleAuth/m);
  assert.match(codeSummary, /^4:  return req\.user/m);

  // The bare structural read already displayed the function body, so edit it
  // directly under the summary hash instead of issuing a second range read.
  const summaryTag = tagOf(codeSummary);
  await applyPatch({ cwd, patch: `${summaryTag.header}\nREPLACE 4:\n+  return req.account` });
  assert.match(await readFile(code, "utf8"), /return req\.account/);

  const dir = join(cwd, "src");
  await mkdir(dir);
  await writeFile(join(dir, "index.ts"), "export const value = 1\n");
  await assert.rejects(
    () => renderRead({ cwd, path: dir }),
    /is a directory\. Use ls for directory listing\./,
  );
});

test("representative smart summary matrix covers code docs config and directory workflows", async () => {
  const cwd = await fixture();
  const filler = (prefix, count = 135) => Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
  const cases = [
    {
      label: "TS/JSX",
      file: "component.tsx",
      content: ["import React from 'react'", "interface Props { name: string }", "export function Widget(props: Props) {", "  return <div>{props.name}</div>", "}", ...filler("// filler")].join("\n") + "\n",
      selector: "3-5",
      patch: "REPLACE 4:\n+  return <span>{props.name}</span>",
      verify: /<span>/,
    },
    {
      label: "Python",
      file: "worker.py",
      content: ["import os", "import sys as system", "from pathlib import Path", "class Worker:", "    def run(self, value):", "        return value", "def helper(name):", "    return name", ...filler("# filler")].join("\n") + "\n",
      selector: "4-8",
      patch: "REPLACE 6:\n+        return str(value)",
      verify: /str\(value\)/,
    },
    {
      label: "Go",
      file: "server.go",
      content: ["package main", "", "import (", "  \"fmt\"", "  alias \"net/http\"", ")", "", "type Server struct {", "  Name string", "}", "", "func (s *Server) Serve(port int) {", "  fmt.Println(port)", "}", ...filler("// filler")].join("\n") + "\n",
      selector: "12-14",
      patch: "REPLACE 13:\n+  fmt.Println(\"port\", port)",
      verify: /"port"/,
    },
    {
      label: "Rust",
      file: "lib.rs",
      content: ["use std::fmt;", "pub struct Worker {", "  name: String,", "}", "impl Worker {", "  pub fn run(&self) -> String {", "    self.name.clone()", "  }", "}", ...filler("// filler")].join("\n") + "\n",
      selector: "5-9",
      patch: "REPLACE 7:\n+    format!(\"{}\", self.name)",
      verify: /format!\(/,
    },
    {
      label: "Kotlin",
      file: "Worker.kt",
      content: ["package demo", "", "import kotlin.collections.List", "", "object Registry {", "  fun load(name: String): String {", "    return name", "  }", "}", "", "class Worker {", "  fun run(value: String): String {", "    return value", "  }", "}", "", "fun topLevel(flag: Boolean): Boolean {", "  return flag", "}", ...filler("// filler")].join("\n") + "\n",
      selector: "17-19",
      patch: "REPLACE 18:\n+  return !flag",
      verify: /return !flag/,
    },
    {
      label: "Markdown",
      file: "GUIDE.md",
      content: ["# Intro", "", "```", "# Not a heading", "```", "## Install", "details", "## Usage", ...filler("paragraph")].join("\n") + "\n",
      selector: "6-7",
      patch: "REPLACE 7:\n+installation details",
      verify: /installation details/,
    },
    {
      label: "YAML",
      file: "config.yaml",
      content: ["server:", "  host: localhost", "  port: 8080", "database:", "  url: postgres://localhost", "  pool:", "    max: 10", "features:", "  auth: true", ...filler("# filler")].join("\n") + "\n",
      selector: "1-3",
      patch: "REPLACE 2:\n+  host: 127.0.0.1",
      verify: /127\.0\.0\.1/,
    },
    {
      label: "TOML",
      file: "settings.toml",
      content: ["[server]", "host = \"localhost\"", "port = 8080", "", "[database.pool]", "max = 10", ...filler("# filler")].join("\n") + "\n",
      selector: "1-3",
      patch: "REPLACE 2:\n+host = \"127.0.0.1\"",
      verify: /127\.0\.0\.1/,
    },
    {
      label: "JSON",
      file: "package.json",
      content: JSON.stringify({ scripts: { test: "node --test" }, dependencies: { react: "latest" }, private: true, items: Array.from({ length: 130 }, (_, i) => i) }, null, 2) + "\n",
      selector: "2-4",
      patch: "REPLACE 3:\n+    \"test\": \"node --test --watch=false\"",
      verify: /watch=false/,
    },
  ];

  for (const item of cases) {
    const filePath = join(cwd, item.file);
    await writeFile(filePath, item.content);
    const summary = (await renderRead({ cwd, path: filePath })).text;
    if (/smart read unavailable/.test(summary)) {
      assert.match(summary, /Native smart-read is required/, `${item.label} should fail closed when native smart-read is unavailable`);
      assert.doesNotMatch(summary, TAG_RE);
    } else {
      assertNavigationSummary(summary, item.label);
    }

    const exact = (await renderRead({ cwd, path: `${filePath}:${item.selector}` })).text;
    assert.match(exact, TAG_RE, `${item.label} exact selector should mint a hash`);
    const header = tagOf(exact).header;
    await applyPatch({ cwd, patch: `${header}\n${item.patch}` });
    assert.match(await readFile(filePath, "utf8"), item.verify, `${item.label} exact-read edit path failed`);
  }

  const dir = join(cwd, "overview");
  await mkdir(dir);
  await writeFile(join(dir, "index.ts"), "export const value = 1\n");
  await writeFile(join(dir, "README.md"), "# Overview\n");
  await assert.rejects(
    () => renderRead({ cwd, path: dir }),
    /is a directory\. Use ls for directory listing\./,
  );
  const childExact = (await renderRead({ cwd, path: `${join(dir, "index.ts")}:1-1` })).text;
  assert.match(childExact, TAG_RE);
});

test("native smart-read provider preserves editable structural source rows", async () => {
  const cwd = await fixture();
  const source = join(cwd, "native-large.ts");
  const lines = [
    "import express from 'express'",
    "import fs from 'node:fs'",
    "import { EventEmitter } from 'node:events'",
    "",
    "interface Props { name: string }",
    "export function Widget(props: Props) {",
    "  return props.name",
    "}",
    "export class Service {",
    "  run(value: string) {",
    "    return value",
    "  }",
    "}",
    ...Array.from({ length: 2400 }, (_, i) => `// filler ${i}`),
  ];
  await writeFile(source, `${lines.join("\n")}\n`);

  const calls = [];
  const provider = createPiNavSmartSummaryProvider({
    callNative: async request => {
      calls.push(request);
      return nativeReadOutput({
        outlineEntries: [
          { start: 1, end: 3, label: "imports: express, node:fs, node:events", kind: "import" },
          { start: 5, end: 5, label: "interface Props", kind: "interface" },
          { start: 6, end: 8, label: "fn Widget(props: Props)", kind: "function" },
          { start: 9, end: 13, label: "class Service", kind: "class" },
          { start: 10, end: 12, label: "fn run(value: string)", kind: "method" },
        ],
        completeness: { complete: true, returned: lines.length, total: lines.length },
      });
    },
  });

  const summary = await renderSmartSummary({ cwd, absolutePath: source, displayPath: source, normalized: `${lines.join("\n")}\n`, lines, kind: "file", sizeBytes: 48_000 }, {
    providers: [provider, localSourceHeuristicProvider],
  });

  assert.ok(summary, "expected native smart-read summary");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, "pi_nav_read");
  assert.equal(calls[0].args.mode, "auto");
  assert.match(calls[0].root, /pi-nav-v3-core-/);
  assert.match(summary, /Structural source summary/);
  assert.match(summary, /1:import express/);
  assert.match(summary, /6:export function Widget/);
  assert.match(summary, /9:export class Service/);
  assert.match(summary, /read all needed distant regions at once with .*native-large\.ts:\d+-\d+/);
  assert.doesNotMatch(summary, TAG_RE, "renderSmartSummary returns the body; renderRead owns the file hash header");
  assert.doesNotMatch(summary, LEGACY_OR_BACKEND_RE);

  const exact = (await renderRead({ cwd, path: `${source}:6-8` })).text;
  const exactTag = tagOf(exact);
  await applyPatch({ cwd, patch: `${exactTag.header}\nREPLACE 7:\n+  return props.name.toUpperCase()` });
  assert.match(await readFile(source, "utf8"), /toUpperCase/);
});

test("native smart-read entry caps keep grouped follow-up guidance", async () => {
  const cwd = await fixture();
  const source = join(cwd, "many-functions.ts");
  const lines = Array.from({ length: 140 }, (_, i) => `export function f${i + 1}() { return ${i + 1} }`);
  await writeFile(source, `${lines.join("\n")}\n`);

  const provider = createPiNavSmartSummaryProvider({
    callNative: async () => nativeReadOutput({
      outlineEntries: lines.map((_, i) => ({ start: i + 1, end: i + 1, label: `fn f${i + 1}()`, kind: "function" })),
      completeness: { complete: true, returned: lines.length, total: lines.length },
    }),
  });

  const summary = await renderSmartSummary({ cwd, absolutePath: source, displayPath: source, normalized: `${lines.join("\n")}\n`, lines, kind: "file", sizeBytes: 48_000 }, { providers: [provider] });

  assert.ok(summary, "expected native smart-read summary");
  assert.match(summary, /120:export function f120/);
  assert.doesNotMatch(summary, /121:export function f121/);
  assert.match(summary, /Structural outline was capped/);
  assert.match(summary, /read all needed distant regions at once with .*:\d+-\d+/);
});

test("native smart-read typed metadata rejects invalid ranges and uses bounded local structural fallback", async () => {
  const cwd = await fixture();
  const source = join(cwd, "native-unavailable.ts");
  const lines = ["export function target() {", "  return 1", "}", ...Array.from({ length: 2400 }, (_, i) => `// filler ${i}`)];
  await writeFile(source, `${lines.join("\n")}\n`);
  const input = { cwd, absolutePath: source, displayPath: source, kind: "file", lines, text: `${lines.join("\n")}\n`, sizeBytes: 48_000, extension: ".ts" };

  assert.equal(summaryFromNative({ files: [{ outlineEntries: [], completeness: { complete: true, total: lines.length } }] }, input), null);
  assert.equal(summaryFromNative({ files: [{ outlineEntries: [{ start: 9999, end: 10000, label: "nope", kind: "function" }], completeness: { complete: true, total: lines.length } }] }, input), null);
  const lineCountMismatch = summaryFromNative({ files: [{ totalLines: 444, outlineEntries: [{ start: 400, end: 410, label: "late function", kind: "function" }], completeness: { complete: true, total: 43 } }] }, { ...input, lines: Array.from({ length: 444 }, (_, index) => `// ${index + 1}`) });
  assert.equal(lineCountMismatch?.entries[0]?.start, 400, "outline-entry totals must not be treated as source-line totals");

  const fullProvider = createPiNavSmartSummaryProvider({ callNative: async () => nativeReadOutput({ outlineEntries: [], completeness: { complete: true, total: lines.length } }) });
  const invalidProvider = createPiNavSmartSummaryProvider({ callNative: async () => nativeReadOutput({ outlineEntries: [{ start: 9999, end: 10000, label: "nope", kind: "function" }], completeness: { complete: true, total: lines.length } }) });

  for (const provider of [fullProvider, invalidProvider]) {
    const result = await renderSmartSummary({ cwd, absolutePath: source, displayPath: source, normalized: `${lines.join("\n")}\n`, lines, kind: "file", sizeBytes: 48_000 }, {
      providers: [provider, localSourceHeuristicProvider],
      timeoutMs: 5,
    });
    assert.match(result ?? "", /Structural source summary/);
    assert.match(result ?? "", /1:export function target\(\)/);
    assert.match(result ?? "", /read all needed distant regions at once/);
    assert.doesNotMatch(result ?? "", TAG_RE, "renderSmartSummary returns the body; renderRead owns the hash header");
  }
});

test("native smart-read is tried whenever smart summary is invoked for supported files", async () => {
  const cwd = await fixture();
  const source = join(cwd, "small-supported.ts");
  const lines = ["export function target() {", "  return 1", "}"];
  await writeFile(source, `${lines.join("\n")}\n`);
  let called = false;
  const provider = createPiNavSmartSummaryProvider({ callNative: async () => { called = true; return nativeReadOutput({ outlineEntries: [{ start: 1, end: 3, label: "fn target()", kind: "function" }], completeness: { complete: true, total: lines.length } }); } });

  const summary = await renderSmartSummary({ cwd, absolutePath: source, displayPath: source, normalized: `${lines.join("\n")}\n`, lines, kind: "file", sizeBytes: 80 }, { providers: [provider, localSourceHeuristicProvider] });

  assert.equal(called, true);
  assert.match(summary ?? "", /1:export function target\(\)/);
});

test("smart summary providers degrade to local fallback and normalize public output", async () => {
  const cwd = await fixture();
  const source = join(cwd, "fallback.ts");
  const lines = ["export function target() {", "  return 1", "}", ...Array.from({ length: 130 }, (_, i) => `// filler ${i}`)];
  await writeFile(source, `${lines.join("\n")}\n`);

  const unavailable = { name: "hidden-unavailable", priority: 1, canHandle: () => true, summarize: async () => null };
  const timeout = { name: "hidden-timeout", priority: 2, canHandle: () => true, summarize: async () => new Promise(() => {}) };
  const invalidRanges = { name: "hidden-invalid", priority: 3, canHandle: () => true, summarize: async () => ({ title: "backend provider outline", entries: [{ start: 9999, end: 10000, label: "target" }], totalLines: lines.length }) };

  const fallback = await renderSmartSummary({ cwd, absolutePath: source, displayPath: source, normalized: `${lines.join("\n")}\n`, lines, kind: "file" }, {
    providers: [unavailable, timeout, invalidRanges, localSourceHeuristicProvider],
    timeoutMs: 5,
  });
  assert.ok(fallback, "expected local fallback summary");
  assert.match(fallback, /Structural source summary/);
  assert.match(fallback, /1:export function target\(\)/);
  assert.match(fallback, /read all needed distant regions at once with .*fallback\.ts:\d+-\d+/);
  assert.doesNotMatch(fallback, TAG_RE, "renderSmartSummary returns the body; renderRead owns the hash header");
  assert.doesNotMatch(fallback, LEGACY_OR_BACKEND_RE);

  const leakyValid = { name: "hidden-leaky", priority: 1, canHandle: () => true, summarize: async () => ({ title: "Tilth provider outline", entries: [{ start: 1, end: 3, label: "backend provider target" }], totalLines: lines.length }) };
  const normalized = await renderSmartSummary({ cwd, absolutePath: source, displayPath: source, normalized: `${lines.join("\n")}\n`, lines, kind: "file" }, {
    providers: [leakyValid],
    timeoutMs: 5,
  });
  assert.ok(normalized, "expected valid provider output to normalize");
  assert.match(normalized, /Structural source summary/);
  assert.doesNotMatch(normalized, LEGACY_OR_BACKEND_RE);
  assert.match(normalized, /read all needed distant regions at once with .*fallback\.ts:\d+-\d+/);
});

test("diff TUI preserves typed omissions and patch truncation", () => {
  setDensityLevel("extended");
  const incomplete = {
    content: [{ type: "text", text: "# Diff: many files" }],
    details: {
      envelope: { status: "warning", summary: "partial" },
      native: { data: { files: [{ path: "src/a.ts", change: "modified" }], symbols: [] }, completeness: { complete: false, returned: 1, total: 80, omitted: 79, unit: "files", reason: "budget" } },
    },
  };
  const typed = stripAnsi(renderDiffResult(incomplete, { expanded: false }, {}, { args: { view: "structure" } }).render(160).join("\n"));
  assert.match(typed, /80 files/);
  assert.match(typed, /79 files omitted \(budget\)/);

  const patch = { content: [{ type: "text", text: "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n[Output truncated at 100 chars; rerun narrower.]" }], details: { envelope: { status: "warning" } } };
  const rendered = stripAnsi(renderDiffResult(patch, { expanded: false }, {}, { args: { view: "patch" } }).render(160).join("\n"));
  assert.match(rendered, /output truncated; narrow scope or raise budget/);
  assert.match(rendered, /◐/);
});

test("diff TUI uses typed prepared impact rows instead of noisy prose", () => {
  const result = {
    content: [{ type: "text", text: "noisy backend prose that should not drive the preview" }],
    details: { envelope: { status: "success" }, prepared: { impact: { impacted_nodes: [{ name: "caller", file_path: "src/caller.ts" }] } } },
  };
  const rendered = stripAnsi(renderDiffResult(result, { expanded: false }, {}, { args: { view: "impact" } }).render(160).join("\n"));
  assert.match(rendered, /caller · src\/caller\.ts/);
  assert.doesNotMatch(rendered, /noisy backend prose/);
});

test("no-state fallback renders classic framed card (≥2 lines with footer)", () => {
  setDensityLevel("normal");
  const theme = { fg: (_s, t) => `\x1b[38;5;45m${t}\x1b[0m`, bold: (t) => t };
  const plain = stripAnsi(renderGrepResult({
    content: [{ type: "text", text: "native matches output" }],
    details: { envelope: { status: "success", artifacts: [] }, native: { completeness: { returned: 1 }, data: { mode: "matches", resolved: {}, groups: [], sourceRows: [], targets: [], coverage: { occurrences: 0 } } } },
  }, { expanded: false }, theme, {}).render(100).join("\n"));
  assert.match(plain, /╰──/);
});

test("ultra edit line carries hash when informative", () => {
  setDensityLevel("ultra");
  const theme = { fg: (_s, t) => t, bold: (t) => t };
  const ctx = { state: {} };
  const args = { input: "[src/a.ts#ABCD1234]\nREPLACE 1:\n+new" };
  const call = renderEditCall(args, theme, ctx);
  const text = "[src/a.ts#ABCD1234]\nEdited src/a.ts: 1 hunk, first changed line 1.\n\nDiff: first changed region only.\n-1:old\n+1:new";
  renderEditResult({ content: [{ type: "text", text }] }, { expanded: false }, theme, ctx);
  const line = stripAnsi(call.render(120)[0]);
  assert.match(line, /edit/);
  assert.match(line, /ABCD1234|hash/i);
  assert.match(line, /✓|…|◐|⚠|✗/);
});

