#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ONBOARDING = path.join(EXTENSION_ROOT, "scripts", "navigation-cmux-onboarding-smoke.mjs");
const DEFAULT_OUT = path.join(EXTENSION_ROOT, ".tmp", "cmux-behavior-suite", "latest.json");
const DEFAULT_ARTIFACT_DIR = path.join(EXTENSION_ROOT, ".tmp", "cmux-behavior-suite");

export const CORE_CMUX_PROBES = [
  { id: "project-overview", prompt: "What is this project and where should I start?", fixture: "fresh", expectTool: "explore", expectPattern: "Code map", forbidTools: "context,grep,find" },
  { id: "setup-docs", prompt: "Find the docs about navigation setup.", fixture: "current", expectTool: "docs", expectPattern: "Docs search|Navigation Setup", forbidTools: "context,grep,find" },
  { id: "known-symbol-callers", prompt: "What calls registerExploreTool?", fixture: "current", expectTool: "trace", expectPattern: "Code callers|registerExploreTool", forbidTools: "context,grep,find" },
  { id: "explore-impact", prompt: "What is the impact of changing src/tools/explore.ts?", fixture: "current", expectTool: "code_context", expectPattern: "Code context|src/tools/explore.ts", forbidTools: "context,grep,find" },
];

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { json: false, planOnly: false, probe: "all", provider: "deepseek", model: "deepseek-v4-flash", out: DEFAULT_OUT, artifactDir: DEFAULT_ARTIFACT_DIR, waitReadyMs: 25_000, waitAnswerMs: 120_000 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--json") args.json = true;
    else if (flag === "--plan-only") args.planOnly = true;
    else if (flag === "--probe") args.probe = value();
    else if (flag === "--provider") args.provider = value();
    else if (flag === "--model") args.model = value();
    else if (flag === "--out") args.out = path.resolve(value());
    else if (flag === "--artifact-dir") args.artifactDir = path.resolve(value());
    else if (flag === "--wait-ready-ms") args.waitReadyMs = Number(value()) || args.waitReadyMs;
    else if (flag === "--wait-answer-ms") args.waitAnswerMs = Number(value()) || args.waitAnswerMs;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

export function selectedProbes(probe = "all") {
  if (probe === "all") return CORE_CMUX_PROBES;
  const selected = CORE_CMUX_PROBES.filter(item => item.id === probe);
  if (!selected.length) throw new Error(`unknown cmux behavior probe ${probe}; expected all or one of ${CORE_CMUX_PROBES.map(item => item.id).join(", ")}`);
  return selected;
}

export function planCmuxBehaviorSuite(args = {}) {
  const probes = selectedProbes(args.probe ?? "all");
  return {
    status: "planned",
    proofLevel: "plan-only; no cmux surface, provider, model, or Pi TUI was invoked",
    provider: args.provider ?? "deepseek",
    model: args.model ?? "deepseek-v4-flash",
    probeCount: probes.length,
    probes,
    runCommand: `npm run nav:cmux-suite -- --json --provider ${args.provider ?? "deepseek"} --model ${args.model ?? "deepseek-v4-flash"}`,
    approvalNeeded: "Running the suite starts real Pi TUI sessions through cmux and may call the configured provider/API. Do not run without explicit approval and credentials.",
  };
}

function usage() {
  return `Usage: node scripts/navigation-cmux-behavior-suite.mjs [--json] [--plan-only] [--probe all|id]\n\nRuns the core jeito-codeweave-pi cmux behavior probes by delegating each prompt to\nnavigation-cmux-onboarding-smoke.mjs. Use --plan-only for a no-provider dry plan.\nReal runs start Pi TUI sessions and may call the configured provider/API.`;
}

async function runSuite(args) {
  const probes = selectedProbes(args.probe);
  if (args.planOnly) return planCmuxBehaviorSuite(args);
  const providerEnv = `${args.provider.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`;
  if (!process.env[providerEnv]) throw new Error(`${providerEnv} is not set; refusing to run live cmux behavior suite without provider credentials`);
  await mkdir(args.artifactDir, { recursive: true });
  const results = [];
  for (const probe of probes) {
    const out = path.join(args.artifactDir, `${probe.id}.json`);
    const transcript = path.join(args.artifactDir, `${probe.id}.capture.txt`);
    const initialTranscript = path.join(args.artifactDir, `${probe.id}.initial.capture.txt`);
    const child = spawnSync(process.execPath, [
      ONBOARDING,
      "--json",
      "--prompt", probe.prompt,
      "--provider", args.provider,
      "--model", args.model,
      "--wait-ready-ms", String(args.waitReadyMs),
      "--wait-answer-ms", String(args.waitAnswerMs),
      "--fixture", probe.fixture ?? "fresh",
      "--expect-tool", probe.expectTool ?? "",
      "--expect-pattern", probe.expectPattern ?? "",
      "--forbid-tools", probe.forbidTools ?? "",
      "--out", out,
      "--transcript", transcript,
      "--initial-transcript", initialTranscript,
    ], { cwd: EXTENSION_ROOT, encoding: "utf8", timeout: Math.max(180_000, args.waitReadyMs + args.waitAnswerMs + 90_000), maxBuffer: 8 * 1024 * 1024 });
    let report;
    try { report = JSON.parse(await readFile(out, "utf8")); }
    catch { report = { status: "failed", failures: ["missing-report"], excerpt: `${child.stdout ?? ""}${child.stderr ?? ""}`.slice(-4000) }; }
    results.push({ id: probe.id, prompt: probe.prompt, status: report.status, failures: report.failures ?? [], report: path.relative(EXTENSION_ROOT, out), transcript: path.relative(EXTENSION_ROOT, transcript), exitCode: child.status, excerpt: report.excerpt });
  }
  const failures = results.filter(result => result.status !== "passed" || result.exitCode !== 0);
  return {
    status: failures.length ? "failed" : "passed",
    proofLevel: "real cmux Pi TUI behavior suite; each probe uses active jeito-codeweave-pi extension and second-pass feedback prompt",
    provider: args.provider,
    model: args.model,
    probeCount: probes.length,
    results,
    failures: failures.map(item => item.id),
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) { console.log(usage()); return; }
  const report = await runSuite(args);
  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.status.toUpperCase()}: ${report.probeCount} cmux behavior probe(s)`);
    if (report.probes) for (const probe of report.probes) console.log(`- ${probe.id}: ${probe.prompt}`);
    if (report.results) for (const result of report.results) console.log(`${result.status === "passed" ? "✔" : "✖"} ${result.id}`);
    console.log(`Proof level: ${report.proofLevel}`);
  }
  if (report.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
