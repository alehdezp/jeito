#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(EXTENSION_ROOT, ".tmp", "cmux-onboarding-smoke", "latest.json");
const DEFAULT_TRANSCRIPT = path.join(EXTENSION_ROOT, ".tmp", "cmux-onboarding-smoke", "latest.capture.txt");
const DEFAULT_INITIAL_TRANSCRIPT = path.join(EXTENSION_ROOT, ".tmp", "cmux-onboarding-smoke", "latest.initial.capture.txt");

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    out: DEFAULT_OUT,
    transcript: DEFAULT_TRANSCRIPT,
    initialTranscript: DEFAULT_INITIAL_TRANSCRIPT,
    prompt: "help me understand this repo",
    feedbackPrompt: "Now debug the navigation experience you just had: what broke, what instruction/tool behavior was confusing, and the smallest useful fix?",
    model: "openai-codex/gpt-5.6-luna",
    fixture: "fresh",
    expectTool: "explore",
    expectPattern: "Code map",
    forbidTools: "context,grep,find",
    waitReadyMs: 25_000,
    waitAnswerMs: 120_000,
    keepSurface: false,
    noClose: false,
    requireRawParams: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--json") args.json = true;
    else if (flag === "--out") args.out = path.resolve(value());
    else if (flag === "--transcript") args.transcript = path.resolve(value());
    else if (flag === "--initial-transcript") args.initialTranscript = path.resolve(value());
    else if (flag === "--prompt") args.prompt = value();
    else if (flag === "--feedback-prompt") args.feedbackPrompt = value();
    else if (flag === "--fixture") args.fixture = value();
    else if (flag === "--expect-tool") args.expectTool = value();
    else if (flag === "--expect-pattern") args.expectPattern = value();
    else if (flag === "--forbid-tools") args.forbidTools = value();
    else if (flag === "--model") args.model = value();
    else if (flag === "--wait-ready-ms") args.waitReadyMs = Number(value()) || args.waitReadyMs;
    else if (flag === "--wait-answer-ms") args.waitAnswerMs = Number(value()) || args.waitAnswerMs;
    else if (flag === "--require-raw-params") args.requireRawParams = true;
    else if (flag === "--keep-surface" || flag === "--no-close") { args.keepSurface = true; args.noClose = true; }
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function usage() {
  return `Usage: node scripts/navigation-cmux-onboarding-smoke.mjs [--json] [--out file]\n\nLaunches a real Pi TUI in a cmux terminal surface from a fresh temporary repo,\nsends a broad repo-understanding prompt, captures the terminal transcript, and\nasserts visible jeito-codeweave-pi onboarding/readiness guidance. This is an\ninteractive runtime smoke, not a unit test or simulated hook test.`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeoutMs ?? 15_000, maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function runOk(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}\nSTDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-nav-cmux-onboarding-"));
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# CMUX onboarding fixture\n\nSmall TypeScript service used to validate jeito-codeweave-pi onboarding. The HTTP server loads configuration, registers routes, and exposes a health check.\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "cmux-onboarding-fixture", scripts: { test: "node --test tests/server.test.ts", start: "node src/server.ts" } }, null, 2));
  await writeFile(path.join(root, "src", "server.ts"), "import { loadConfig } from './config';\nimport { registerRoutes } from './routes';\n\nexport function startServer() {\n  const config = loadConfig();\n  return registerRoutes(config);\n}\n");
  await writeFile(path.join(root, "src", "config.ts"), "export interface ServerConfig { port: number; serviceName: string }\n\nexport function loadConfig(): ServerConfig {\n  return { port: 3000, serviceName: 'cmux-onboarding-fixture' };\n}\n");
  await writeFile(path.join(root, "src", "routes.ts"), "import type { ServerConfig } from './config';\n\nexport function registerRoutes(config: ServerConfig) {\n  return { health: healthCheck(config), routes: ['/health'] };\n}\n\nexport function healthCheck(config: ServerConfig) {\n  return `${config.serviceName}:ok`;\n}\n");
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "tests", "server.test.ts"), "import { startServer } from '../src/server';\n\ntest('starts server routes', () => {\n  expect(startServer().health).toBe('cmux-onboarding-fixture:ok');\n});\n");
  await writeFile(path.join(root, "docs", "architecture.md"), "# Architecture\n\nThe entry point is `src/server.ts`. It loads configuration from `src/config.ts`, registers routes in `src/routes.ts`, and tests the behavior in `tests/server.test.ts`.\n");
  return root;
}

function cmuxJson(args, options = {}) {
  const stdout = runOk("cmux", ["--json", ...args], options);
  return JSON.parse(stdout);
}

function cmux(args, options = {}) {
  return runOk("cmux", args, options);
}

function capture(surface) {
  const result = run("cmux", ["capture-pane", "--surface", surface, "--scrollback"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

async function waitFor(surface, timeoutMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  let latest = "";
  while (Date.now() < deadline) {
    latest = capture(surface);
    if (predicate(latest)) return latest;
    await sleep(2_000);
  }
  return latest || capture(surface);
}

function excerpt(text, lines = 80) {
  const split = String(text ?? "").split("\n");
  return split.slice(Math.max(0, split.length - lines)).join("\n");
}

export function assertTranscript(text, root, prompt, args = {}) {
  const boundedText = args.untilPrompt ? transcriptUntilPrompt(text, args.untilPrompt) : text;
  const afterPrompt = transcriptAfterPrompt(boundedText, prompt);
  const forbidden = String(args.forbidTools ?? "").split(",").map(item => item.trim()).filter(Boolean);
  const expectedTool = String(args.expectTool ?? "").trim();
  const expectedPattern = String(args.expectPattern ?? "").trim();
  const toolOutput = expectedTool ? outputAfterTool(afterPrompt, expectedTool) : afterPrompt;
  const checks = [
    { id: "real-pi-tui-started", ok: /pi v\d+\.\d+\.\d+/.test(text) && /ctrl\+c twice to exit/.test(text) },
    { id: "cwd-visible", ok: text.includes(root) || text.includes(root.replace(/^\/private/, "")) },
    { id: "prompt-visible", ok: text.includes(prompt) },
  ];
  if (args.fixture === "fresh") checks.push({ id: "startup-notice-or-audit-visible", ok: /Project navigation: preparing|navigation-setup\.log\.jsonl/.test(text) });
  if (expectedTool) checks.push({ id: `expected-tool-${expectedTool}`, ok: toolWasInvoked(afterPrompt, expectedTool) });
  if (expectedPattern) checks.push({ id: "expected-output-pattern", ok: Boolean(toolOutput.trim()) && new RegExp(expectedPattern, "i").test(toolOutput) });
  if (expectedTool === "explore") checks.push({ id: "prepared-code-output-not-empty", ok: preparedCodeOutputLooksUseful(toolOutput, args.fixture) });
  for (const tool of forbidden) checks.push({ id: `forbid-tool-${tool}`, ok: !forbiddenToolWasInvoked(afterPrompt, tool) });
  const analysis = analyzeTranscript(text, prompt, args);
  checks.push({ id: "transcript-tool-order-captured", ok: analysis.toolInvocations.length > 0 });
  if (args.requireRawParams) checks.push({ id: "raw-tool-params-visible", ok: analysis.rawParamVisibility === "visible" });
  return checks;
}

export function analyzeTranscript(text, prompt = "", args = {}) {
  const boundedText = args.untilPrompt ? transcriptUntilPrompt(text, args.untilPrompt) : text;
  const afterPrompt = transcriptAfterPrompt(boundedText, prompt);
  const knownTools = new Set(["explore", "code_context", "trace", "docs", "grep", "find", "read", "edit", "write", "diff", "bash"]);
  const lines = afterPrompt.split("\n");
  const toolInvocations = [];
  const rawParamSnippets = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (knownTools.has(trimmed)) toolInvocations.push({ tool: trimmed, line: i + 1 });
    else for (const tool of ["grep", "find", "read", "bash"]) if (commandLikeToolLine(trimmed, tool)) toolInvocations.push({ tool, line: i + 1, form: "command" });
    const snippet = rawParamSnippet(lines, i);
    if (snippet) rawParamSnippets.push({ line: i + 1, text: redactSensitiveSnippet(snippet) });
  }
  const uniqueParamSnippets = dedupeByText(rawParamSnippets).slice(0, 10);
  const expectedTool = String(args.expectTool ?? "").trim();
  return {
    toolInvocations,
    expectedToolVisible: expectedTool ? toolInvocations.some(item => item.tool === expectedTool) : undefined,
    rawParamVisibility: uniqueParamSnippets.length ? "visible" : "not_visible",
    rawParamSnippets: uniqueParamSnippets,
    limitations: uniqueParamSnippets.length ? [] : ["Terminal transcript did not expose raw JSON/tool-call params; visible tool order/output is evidence, but exact params are not proven."],
  };
}

function rawParamSnippet(lines, index) {
  const line = String(lines[index] ?? "");
  if (!/[{[]/.test(line)) return undefined;
  const window = lines.slice(index, Math.min(lines.length, index + 8)).join("\n").trim();
  if (!/\b(query|action|target|relation|goal|purpose|path|pattern|patterns|scope|doc|section)\b/i.test(window)) return undefined;
  if (!/[{[]/.test(window) || !/[}\]]/.test(window)) return undefined;
  return window.slice(0, 1200);
}

function redactSensitiveSnippet(value) {
  return String(value)
    .replace(/(["']?[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*["']?\s*[:=]\s*)(["'])[^"'\s,}\]]+\2/gi, "$1$2<redacted>$2")
    .replace(/(["']?[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*["']?\s*[:=]\s*)[^\s,}\]]+/gi, "$1<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/g, "$1<redacted>");
}

function dedupeByText(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item.text)) continue;
    seen.add(item.text);
    out.push(item);
  }
  return out;
}

function transcriptAfterPrompt(text, prompt) {
  const index = String(text ?? "").indexOf(String(prompt ?? ""));
  return index >= 0 ? String(text).slice(index + String(prompt).length) : String(text ?? "");
}

function transcriptUntilPrompt(text, prompt) {
  if (!prompt) return String(text ?? "");
  const index = String(text ?? "").indexOf(String(prompt));
  return index >= 0 ? String(text).slice(0, index) : String(text ?? "");
}

function preparedCodeOutputLooksUseful(output, fixture) {
  const text = String(output ?? "");
  if (!text.trim() || /No file-backed code candidates returned/.test(text)) return false;
  if (/Graph (?:map|context)/i.test(text)) return fixture === "current" ? /Graphify|QMD|docs\/|README\.md/.test(text) : /[\w./-]+\.(?:ts|tsx|js|mjs|md)\b|NODE\s+/i.test(text);
  if (!/Code (?:map|structure|context)/i.test(text)) return false;
  if (fixture === "fresh") return /(src\/server\.ts|src\/config\.ts|src\/routes\.ts)/.test(text);
  if (fixture === "current") return /(\bindex\.ts\b|src\/(?:tools|core)\/|scripts\/navigation-|tests\/v3-)/.test(text);
  return /[\w./-]+\.(?:ts|tsx|js|mjs|md)\b/.test(text);
}

function toolWasInvoked(text, tool) {
  return new RegExp(`\\n\\s*${escapeRegex(tool)}\\s*\\n`).test(text) || commandLikeToolRegex(tool).test(text);
}

function outputAfterTool(text, tool) {
  const regex = new RegExp(`\\n\\s*${escapeRegex(tool)}\\s*\\n`, "g");
  const commandRegex = commandLikeToolRegex(tool, "g");
  let match;
  let lastEnd = -1;
  while ((match = regex.exec(text))) lastEnd = match.index + match[0].length;
  while ((match = commandRegex.exec(text))) lastEnd = match.index + match[0].length;
  return lastEnd >= 0 ? text.slice(lastEnd) : "";
}

function commandLikeToolLine(line, tool) {
  return commandLikeToolRegex(tool).test(`\n${line}`);
}

function commandLikeToolRegex(tool, flags = "i") {
  if (!["grep", "find", "read", "bash"].includes(tool)) return /$a/;
  const finalFlags = flags.includes("i") ? flags : `${flags}i`;
  return new RegExp(`\\n\\s*${escapeRegex(tool)}\\s+[^\\n]+`, finalFlags);
}

function forbiddenToolWasInvoked(text, tool) {
  if (toolWasInvoked(text, tool)) return true;
  if (new RegExp(`\\b${escapeRegex(tool)}\\s*\\(`).test(text)) return true;
  if (tool === "grep" || tool === "find" || tool === "read" || tool === "bash") return new RegExp(`\\n\\s*${escapeRegex(tool)}\\s+[^\\n]+`, "i").test(text);
  return false;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function closeSurface(surface) {
  try { cmux(["send-key", "--surface", surface, "ctrl-c"], { timeout: 5_000 }); } catch {}
  await sleep(250);
  try { cmux(["send-key", "--surface", surface, "ctrl-c"], { timeout: 5_000 }); } catch {}
  await sleep(250);
  try { cmux(["close-surface", "--surface", surface], { timeout: 5_000 }); } catch {}
}

async function runSmoke(args) {
  if (!existsSync("/opt/homebrew/bin/cmux") && run("bash", ["-lc", "command -v cmux"], { timeout: 5_000 }).status !== 0) throw new Error("cmux is not available on PATH");
  if (run("bash", ["-lc", "command -v pi"], { timeout: 5_000 }).status !== 0) throw new Error("pi is not available on PATH");
  const providerEnv = `${args.provider.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`;
  if (!process.env[providerEnv]) throw new Error(`${providerEnv} is not set; refusing to run a pretend TUI prompt smoke`);

  const root = args.fixture === "current" ? EXTENSION_ROOT : await createFixture();
  const created = cmuxJson(["new-surface", "--type", "terminal", "--focus", "false"]);
  const surface = created.surface_ref;
  const command = [
    `cd ${shQuote(root)}`,
    `echo CMUX_ONBOARDING_ROOT=${shQuote(root)}`,
    [
      "pi",
      "--model", shQuote(args.model),
      "--no-extensions",
      "--extension", shQuote(path.join(EXTENSION_ROOT, "index.ts")),
      "--tools", "read,grep,find,explore,code_context,trace,docs",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--verbose",
    ].join(" "),
  ].join("; ");

  let initial = "";
  let final = "";
  try {
    cmux(["send", "--surface", surface, `${command}\n`], { timeout: 10_000 });
    initial = await waitFor(surface, args.waitReadyMs, text => /pi v\d+\.\d+\.\d+/.test(text) && /ctrl\+c twice to exit/.test(text));
    await mkdir(path.dirname(args.initialTranscript), { recursive: true });
    await writeFile(args.initialTranscript, initial);

    cmux(["send", "--surface", surface, `${args.prompt}\n`], { timeout: 10_000 });
    final = await waitFor(surface, args.waitAnswerMs, text => {
      const checks = assertTranscript(text, root, args.prompt, args);
      return checks.every(check => check.ok);
    });
    await mkdir(path.dirname(args.transcript), { recursive: true });
    await writeFile(args.transcript, final);

    cmux(["send", "--surface", surface, `${args.feedbackPrompt}\n`], { timeout: 10_000 });
    const feedback = await waitFor(surface, Math.max(60_000, Math.floor(args.waitAnswerMs / 2)), text => text.includes(args.feedbackPrompt) && /broke|confusing|smallest|fix|tool/i.test(text));
    final = feedback || final;
    await writeFile(args.transcript, final);

    const firstAnswerArgs = { ...args, untilPrompt: args.feedbackPrompt };
    const analysis = analyzeTranscript(final, args.prompt, firstAnswerArgs);
    const checks = assertTranscript(final, root, args.prompt, firstAnswerArgs);
    checks.push({ id: "feedback-debug-prompt-visible", ok: final.includes(args.feedbackPrompt) });
    const failures = checks.filter(check => !check.ok).map(check => check.id);
    const report = {
      status: failures.length ? "failed" : "passed",
      proofLevel: "cmux real Pi TUI surface with active jeito-codeweave-pi extension, fresh temporary repo, visible terminal transcript, real broad prompt, and second-pass agent feedback/debug prompt; not a simulated hook or AgentSession-only smoke",
      surface,
      closedSurface: !args.keepSurface,
      fixtureRoot: root,
      prompt: args.prompt,
      feedbackPrompt: args.feedbackPrompt,
      provider: args.provider,
      model: args.model,
      transcripts: {
        initial: path.relative(EXTENSION_ROOT, args.initialTranscript),
        final: path.relative(EXTENSION_ROOT, args.transcript),
      },
      transcriptAnalysis: analysis,
      checks,
      failures,
      excerpt: excerpt(final),
    };
    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    if (!args.keepSurface && surface) await closeSurface(surface);
  }
}

async function main() {
  const args = parseArgs();
  if (args.help) { console.log(usage()); return; }
  const report = await runSmoke(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.status.toUpperCase()}: ${report.checks.filter(check => check.ok).length}/${report.checks.length} cmux onboarding checks passed`);
    for (const check of report.checks) console.log(`${check.ok ? "✔" : "✖"} ${check.id}`);
    console.log(`Proof level: ${report.proofLevel}`);
    console.log(`Transcript: ${report.transcripts.final}`);
    if (report.failures.length) console.log(`Failures: ${report.failures.join(", ")}`);
  }
  if (report.status !== "passed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
