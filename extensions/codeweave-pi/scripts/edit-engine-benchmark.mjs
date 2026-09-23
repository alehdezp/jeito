#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { applyPatch as applyPatchResult } from "../src/core/patch-apply.ts";
import { compileTextTarget } from "../src/core/edit-target.ts";
import { renderRead } from "../src/core/read-renderer.ts";
import { certifySourceAuthority } from "../src/core/source-authority.ts";
import { liveSourceEvidenceFromRows } from "../src/core/live-source-evidence.ts";
import { startWorkUnit } from "../src/core/performance-telemetry.ts";
import { shutdownStructuralBlockResolver } from "../src/core/structural-block-resolver.ts";
import { SYNTAX_PARSE_BUDGET_BYTES, validateLandedSyntax } from "../src/core/syntax-validation.ts";
import { executeWrite } from "../src/core/write-core.ts";
const applyPatch = async params => (await applyPatchResult(params)).text;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = join(ROOT, ".tmp", "navigation-edit-benchmark", "latest.json");
const HEADER_RE = /^\[[^\]\n]+#[0-9A-F]+\]/m;
const SKIP = new Set([".git", ".pi", ".tmp", "node_modules", "vendor", "dist", "build", "out", "target", "coverage"]);
const BASELINE = { edit10kP95: 12.708, edit100kP95: 77.838, zeroCopyP95: 2.214 };
const MAIN_THREAD_EVENT_LOOP_MAX_MS = 50;

export async function runEditEngineBenchmark(options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "pi-nav-edit-benchmark-"));
  const out = options.out ? resolve(options.out) : DEFAULT_OUT;
  const only = options.case;
  try {
    const repoCounts = { project_navigation: await countFiles(ROOT), oh_my_pi: await countFiles(join(ROOT, "oh-my-pi-upstream")) };
    const cases = {};
    if (!only || only === "edit10k") cases.edit10k = await editCase(workspace, 10_000, 50);
    if (!only || only === "edit100k") cases.edit100k = await editCase(workspace, 100_000, 5);
    if (!only || only === "zeroCopy") cases.zeroCopy = await zeroCopyCase(workspace, 10_000, 100);
    if (!only) {
      cases.targetCompilation = await targetCompilationCase();
      cases.salvage98Plus2 = await salvageCase(workspace);
      cases.sameFileComposition = await sameFileCompositionCase(workspace);
      cases.retryResidual = await retryResidualCase(workspace);
      cases.syntax = await syntaxCases();
    }
    const acceptance = acceptanceVerdicts(cases);
    const result = {
      generatedAt: new Date().toISOString(),
      host: { platform: process.platform, arch: process.arch, node: process.version, exposedGc: typeof global.gc === "function" },
      methodology: { isolatedProcess: Boolean(only), warmup: "one unrecorded operation for target/syntax microcases; edit cases use the creating write as warmup", gc: typeof global.gc === "function" ? "explicit before measured case" : "not exposed" },
      upstream: { path: "oh-my-pi-upstream", commit: "e8d0a93db61e756361aad84d4bcbc2dd2db88973" },
      repoCounts,
      cases,
      acceptance,
    };
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await shutdownStructuralBlockResolver();
    await rm(workspace, { recursive: true, force: true });
  }
}

async function editCase(workspace, lineCount, edits) {
  global.gc?.();
  const cwd = join(workspace, `edit-${lineCount}`);
  await mkdir(cwd, { recursive: true });
  const path = join(cwd, "large.ts");
  const lines = Array.from({ length: lineCount }, (_, index) => `export const line_${index + 1} = ${index + 1};`);
  let result = await executeWrite({ cwd, path, content: `${lines.join("\n")}\n` });
  const target = Math.floor(lineCount / 2);
  const unit = startWorkUnit({ subsystem: "benchmark", operation: "current_hash_edits", root: cwd, fileCount: 1, lineCount, byteCount: Buffer.byteLength(lines.join("\n")), mode: `${edits}_sequential` });
  const samples = [];
  for (let index = 0; index < edits; index++) {
    const header = HEADER_RE.exec(result)?.[0];
    if (!header) throw new Error(`benchmark edit result has no header: ${result.slice(0, 200)}`);
    const started = performance.now();
    result = await applyPatch({ cwd, patch: `${header}\nREPLACE ${target}:\n+export const line_${target} = ${index % 2 ? target : -target};` });
    samples.push(performance.now() - started);
  }
  const telemetry = unit.finish("success");
  return { lineCount, edits, samplesMs: summarize(samples), telemetry };
}

async function zeroCopyCase(workspace, lineCount, iterations) {
  global.gc?.();
  const cwd = join(workspace, "zero-copy");
  await mkdir(cwd, { recursive: true });
  const path = join(cwd, "source.ts");
  const lines = Array.from({ length: lineCount }, (_, index) => `const value_${index + 1} = ${index + 1};`);
  await writeFile(path, `${lines.join("\n")}\n`);
  const target = Math.floor(lineCount / 2);
  const unit = startWorkUnit({ subsystem: "benchmark", operation: "zero_copy_authority", root: cwd, fileCount: 1, lineCount, byteCount: Buffer.byteLength(lines.join("\n")), mode: `${iterations}_sequential` });
  const samples = [];
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    const result = await certifySourceAuthority({ cwd, nativeText: `native-${index}`, evidence: liveSourceEvidenceFromRows([{ path, line: target, text: lines[target - 1] }], { capability: "benchmark", backend: "fixture" }) });
    if (!result.certified) throw new Error("zero-copy benchmark failed to certify an exact row");
    samples.push(performance.now() - started);
  }
  return { lineCount, iterations, samplesMs: summarize(samples), telemetry: unit.finish("success") };
}

async function targetCompilationCase() {
  const source = Array.from({ length: 10_000 }, (_, index) => `line-${index}`);
  const desired = [...source];
  for (let index = 0; index < desired.length; index += 100) desired[index] = `changed-${index}`;
  const origin = { sectionIndex: 0, operationIndex: 0, inputOrder: 0, operationLine: 1 };
  compileTextTarget(source, desired, origin);
  const samples = [];
  let islands = 0;
  for (let index = 0; index < 50; index++) {
    const started = performance.now();
    islands = compileTextTarget(source, desired, origin).islands.length;
    samples.push(performance.now() - started);
  }
  return { lineCount: source.length, iterations: 50, islands, samplesMs: summarize(samples), exact: islands === 100 };
}

async function salvageCase(workspace) {
  const cwd = join(workspace, "salvage-98-plus-2");
  await mkdir(cwd, { recursive: true });
  const path = join(cwd, "salvage.txt");
  const source = Array.from({ length: 100 }, (_, index) => `line-${index + 1}`);
  await writeFile(path, `${source.join("\n")}\n`);
  const read = (await renderRead({ cwd, path: `${path}:1-98` })).text;
  const header = HEADER_RE.exec(read)?.[0];
  if (!header) throw new Error("98+2 benchmark failed to obtain authority");
  const operations = source.map((line, index) => `REPLACE ${index + 1}:\n+${index < 98 ? `${line}-changed` : `${line}-held`}`).join("\n");
  const started = performance.now();
  const result = await applyPatchResult({ cwd, patch: `${header}\n${operations}` });
  const durationMs = performance.now() - started;
  const landed = (await readFile(path, "utf8")).trimEnd().split("\n");
  const accepted = result.details.files.flatMap(file => file.changes).filter(change => change.status === "accepted" || change.status === "repaired").length;
  const held = result.details.files.flatMap(file => file.changes).filter(change => change.status === "held").length;
  return { durationMs: round(durationMs), accepted, held, exact: accepted === 98 && held === 2 && landed.slice(0, 98).every((line, index) => line === `${source[index]}-changed`) && landed.slice(98).every((line, index) => line === source[index + 98]) };
}

async function sameFileCompositionCase(workspace) {
  const cwd = join(workspace, "same-file-composition");
  await mkdir(cwd, { recursive: true });
  const path = join(cwd, "same.txt");
  await writeFile(path, "one\ntwo\n");
  const read = (await renderRead({ cwd, path: `${path}:1-2` })).text;
  const header = HEADER_RE.exec(read)?.[0];
  const started = performance.now();
  const result = await applyPatchResult({ cwd, patch: `${header}\nREPLACE 1:\n+ONE\n${header}\nREPLACE 2:\n+TWO` });
  return { durationMs: round(performance.now() - started), status: result.details.status, exact: await readFile(path, "utf8") === "ONE\nTWO\n" };
}

async function retryResidualCase(workspace) {
  const cwd = join(workspace, "retry-residual");
  await mkdir(cwd, { recursive: true });
  const path = join(cwd, "retry.txt");
  await writeFile(path, "one\ntwo\nthree\n");
  const first = (await renderRead({ cwd, path: `${path}:1-1,3-3` })).text;
  const header = HEADER_RE.exec(first)?.[0];
  const captureStarted = performance.now();
  const partial = await applyPatchResult({ cwd, sessionId: "benchmark-retry", patch: `${header}\nREPLACE 1:\n+ONE\nREPLACE 2:\n+TWO\nREPLACE 3:\n+THREE` });
  const captureMs = performance.now() - captureStarted;
  const replayStarted = performance.now();
  const replay = await applyPatchResult({ cwd, sessionId: "benchmark-retry", patch: "RETRY" });
  const finalText = await readFile(path, "utf8");
  return { captureMs: round(captureMs), replayMs: round(performance.now() - replayStarted), partialStatus: partial.details.status, replayStatus: replay.details.status, finalText, exact: finalText === "ONE\nTWO\nTHREE\n" };
}

async function syntaxCases() {
  await shutdownStructuralBlockResolver();
  const text = `${"export const value = 1;\n".repeat(200)}`;
  const coldStarted = performance.now();
  const cold = await validateLandedSyntax({ path: "syntax.ts", before: text, after: text });
  const coldMs = performance.now() - coldStarted;
  const warmSamples = [];
  for (let index = 0; index < 20; index++) {
    const started = performance.now();
    await validateLandedSyntax({ path: "syntax.ts", before: text, after: text });
    warmSamples.push(performance.now() - started);
  }
  let resolverCalls = 0;
  const over = " ".repeat(SYNTAX_PARSE_BUDGET_BYTES + 1);
  const overStarted = performance.now();
  const unavailable = await validateLandedSyntax({ path: "syntax.ts", before: over, after: over, resolveDiagnostics: async () => { resolverCalls++; return { diagnostics: [], parseMs: 0 }; } });
  return { coldMs: round(coldMs), coldStatus: cold?.status ?? "clean", warmSamplesMs: summarize(warmSamples), overBudgetMs: round(performance.now() - overStarted), overBudgetStatus: unavailable?.status, overBudgetWorkerCalls: resolverCalls };
}


function acceptanceVerdicts(cases) {
  const checks = {
    edit10kP95: cases.edit10k ? verdict(cases.edit10k.samplesMs.p95 <= BASELINE.edit10kP95 * 1.1, cases.edit10k.samplesMs.p95, `<= ${round(BASELINE.edit10kP95 * 1.1)} ms`) : undefined,
    edit100kP95: cases.edit100k ? verdict(cases.edit100k.samplesMs.p95 <= BASELINE.edit100kP95 * 1.1, cases.edit100k.samplesMs.p95, `<= ${round(BASELINE.edit100kP95 * 1.1)} ms`) : undefined,
    zeroCopyP95: cases.zeroCopy ? verdict(cases.zeroCopy.samplesMs.p95 <= BASELINE.zeroCopyP95 * 1.1, cases.zeroCopy.samplesMs.p95, `<= ${round(BASELINE.zeroCopyP95 * 1.1)} ms`) : undefined,
    edit100kEventLoop: cases.edit100k ? verdict(cases.edit100k.telemetry.eventLoopMaxMs <= MAIN_THREAD_EVENT_LOOP_MAX_MS, cases.edit100k.telemetry.eventLoopMaxMs, `<= ${MAIN_THREAD_EVENT_LOOP_MAX_MS} ms`) : undefined,
    targetCompilation: cases.targetCompilation ? verdict(cases.targetCompilation.exact, cases.targetCompilation.islands, "100 exact islands") : undefined,
    salvage98Plus2: cases.salvage98Plus2 ? verdict(cases.salvage98Plus2.exact, `${cases.salvage98Plus2.accepted}+${cases.salvage98Plus2.held}`, "98 accepted + 2 held") : undefined,
    sameFileComposition: cases.sameFileComposition ? verdict(cases.sameFileComposition.exact, cases.sameFileComposition.status, "exact bytes") : undefined,
    retryResidual: cases.retryResidual ? verdict(cases.retryResidual.exact, cases.retryResidual.replayStatus, "exact converged bytes") : undefined,
    syntaxWarm: cases.syntax ? verdict(cases.syntax.warmSamplesMs.p95 <= 100, cases.syntax.warmSamplesMs.p95, "<= 100 ms") : undefined,
    syntaxOverBudget: cases.syntax ? verdict(cases.syntax.overBudgetStatus === "unavailable" && cases.syntax.overBudgetWorkerCalls === 0, `${cases.syntax.overBudgetStatus}/${cases.syntax.overBudgetWorkerCalls}`, "unavailable/0 worker calls") : undefined,
  };
  const evaluated = Object.values(checks).filter(Boolean);
  return { thresholds: { exactEditP95RegressionPercent: 10, mainThreadEventLoopMaxMs: MAIN_THREAD_EVENT_LOOP_MAX_MS, syntaxWarmP95Ms: 100 }, checks, passed: evaluated.every(check => check.pass) };
}
function verdict(pass, observed, target) { return { pass, observed, target }; }

async function countFiles(root) {
  let count = 0;
  async function walk(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP.has(entry.name)) continue;
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else if (entry.isFile()) count++;
    }
  }
  await walk(root);
  return count;
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = quantile => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
  return { min: round(sorted[0] ?? 0), median: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? 0), total: round(values.reduce((sum, value) => sum + value, 0)) };
}
function round(value) { return Math.round(value * 1000) / 1000; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf("--out");
  const caseIndex = process.argv.indexOf("--case");
  const result = await runEditEngineBenchmark({ out: outIndex >= 0 ? process.argv[outIndex + 1] : undefined, case: caseIndex >= 0 ? process.argv[caseIndex + 1] : undefined });
  console.log(JSON.stringify(result, null, 2));
  if (!result.acceptance.passed) {
    const failures = Object.entries(result.acceptance.checks).filter(([, check]) => check && !check.pass).map(([name, check]) => `${name} ${check.observed} (target ${check.target})`);
    console.error(`BENCHMARK_ACCEPTANCE_FAILED: ${failures.join("; ")}`);
    process.exitCode = 2;
  }
}
