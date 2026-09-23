#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extensionRuntimePaths } from "../src/core/owned-runtime.ts";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const DEFAULT_PARENT_TARGET = path.join(DEFAULT_AGENT_DIR, "extensions");
const DEFAULT_PROJECT_TARGET = EXTENSION_ROOT;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    out: undefined,
    parentTarget: DEFAULT_PARENT_TARGET,
    projectTarget: DEFAULT_PROJECT_TARGET,
    cwd: EXTENSION_ROOT,
    agentDir: DEFAULT_AGENT_DIR,
    module: process.env.PI_AGENT_SESSION_MODULE,
    keepFixtures: false,
    backendTimeoutMs: 15_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--json") args.json = true;
    else if (flag === "--out") args.out = value();
    else if (flag === "--parent-target") args.parentTarget = path.resolve(value());
    else if (flag === "--project-target") args.projectTarget = path.resolve(value());
    else if (flag === "--cwd") args.cwd = path.resolve(value());
    else if (flag === "--agent-dir") args.agentDir = path.resolve(value());
    else if (flag === "--module") args.module = value();
    else if (flag === "--keep-fixtures") args.keepFixtures = true;
    else if (flag === "--backend-timeout-ms") args.backendTimeoutMs = Number(value()) || args.backendTimeoutMs;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function usage() {
  return `Usage: node scripts/navigation-tool-feel-eval.mjs [--json] [--out file]\n\nRuns an opinionated black-box navigation quality eval through a freshly loaded\nAgentSession plus direct backend probes. It checks explore/find/grep/trace/read\nfeel, noisy fixtures, and whether backend signal survives Pi integration.\nThis is a local harness eval: it does not mutate query targets except temporary\nfixtures under /tmp.`;
}

function resolveAgentSessionModule(args) {
  if (args.module) return args.module;
  const candidates = [
    path.join(args.agentDir, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    path.join(path.dirname(path.dirname(process.execPath)), "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    process.env.npm_config_prefix ? path.join(process.env.npm_config_prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js") : undefined,
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return "@earendil-works/pi-coding-agent";
}

function toImportSpecifier(value) {
  if (/^file:/.test(value)) return value;
  if (value.startsWith("/") || value.startsWith(".") || /^[A-Za-z]:[\\/]/.test(value)) return pathToFileURL(path.resolve(value)).href;
  return value;
}

function textOf(result) {
  return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

function excerpt(text, lines = 28) {
  return String(text ?? "").split("\n").slice(0, lines).join("\n");
}

function topLeadBlock(text) {
  const match = /\n1\. \[[\s\S]*?(?=\n2\. \[|\n\[More leads omitted|\nDiagnostics:|$)/.exec(text);
  return match ? match[0] : "";
}

function count(text, re) {
  return (text.match(re) ?? []).length;
}

function topLeadIsPreparedGrep(text) {
  return /\n1\. \[(?:architecture|graph)(?: \+ [^\]]+)?\]\n\s+src\/tools\/grep\.ts:\d+-\d+/.test(text);
}

function topLeadIsGrep(text) {
  return /\n1\. \[[^\]]+\]\n\s+src\/tools\/grep\.ts:\d+-\d+/.test(text);
}

async function sha256File(file) {
  if (!existsSync(file)) return undefined;
  return createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 16);
}

async function executable(file, content) {
  await writeFile(file, content);
  await chmod(file, 0o755);
  return file;
}

async function mkRepo(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, ".pi"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  return root;
}

async function buildFixtures() {
  const now = new Date().toISOString();
  const clean = await mkRepo("nav-feel-clean-ts");
  await mkdir(path.join(clean, "src", "tools"), { recursive: true });
  await writeFile(path.join(clean, "README.md"), "# Clean TS Repo\n\nMain entry docs.\n");
  await writeFile(path.join(clean, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
  await writeFile(path.join(clean, "src", "tools", "search.ts"), "export function registerSearchTool(){}\n");

  const docs = await mkRepo("nav-feel-docs-heavy");
  await mkdir(path.join(docs, "docs"), { recursive: true });
  await mkdir(path.join(docs, "src"), { recursive: true });
  await writeFile(path.join(docs, "README.md"), "# Docs Heavy\n");
  await writeFile(path.join(docs, "docs", "setup.md"), "# Setup Guide\n\nNavigation setup docs live here.\n");
  await writeFile(path.join(docs, "src", "app.ts"), "export const app = true;\n");

  const noisy = await mkRepo("nav-feel-noisy");
  await mkdir(path.join(noisy, "src", "tools"), { recursive: true });
  await mkdir(path.join(noisy, ".research", "surrealdb", "mcp", "src", "tools"), { recursive: true });
  await mkdir(path.join(noisy, ".agents", "skills", "noise"), { recursive: true });
  await mkdir(path.join(noisy, ".code-review-graph"), { recursive: true });
  await mkdir(path.join(noisy, ".pi", "goals"), { recursive: true });
  await writeFile(path.join(noisy, "src", "tools", "grep.ts"), "export function registerGrepTool(){}\n");
  await writeFile(path.join(noisy, ".research", "surrealdb", "mcp", "src", "tools", "connection.rs"), "// grep implemented noise\n");
  await writeFile(path.join(noisy, ".agents", "skills", "noise", "SKILL.md"), "grep implemented noise\n");
  await writeFile(path.join(noisy, ".pi", "goals", "goal.md"), "grep implemented noise\n");
  await writeFile(path.join(noisy, ".code-review-graph", "graph.db"), "fixture graph marker\n");

  return { clean, docs, noisy };
}

async function callTool(session, name, params, cwd) {
  const tool = session.getToolDefinition(name);
  if (!tool) throw new Error(`loaded AgentSession missing ${name}`);
  const started = Date.now();
  const result = await tool.execute(`tool-feel-${name}`, params, undefined, undefined, { cwd, mode: "print", hasUI: false, ui: { notify() {} } });
  return { text: textOf(result), details: result.details, durationMs: Date.now() - started };
}

async function runCheck(session, check) {
  let text = "";
  let details;
  const failures = [];
  let durationMs = 0;
  try {
    const result = await callTool(session, check.tool, check.params, check.cwd);
    text = result.text;
    details = result.details;
    durationMs = result.durationMs;
    for (const [name, predicate] of check.assertions) {
      let ok = false;
      try { ok = Boolean(predicate(text, details)); } catch { ok = false; }
      if (!ok) failures.push(name);
    }
  } catch (error) {
    failures.push(`execute threw: ${error?.message ?? error}`);
  }
  return { id: check.id, tool: check.tool, ok: failures.length === 0, failures, durationMs, excerpt: excerpt(text), topLead: topLeadBlock(text) };
}

function commandProbe(id, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: options.cwd ?? EXTENSION_ROOT, encoding: "utf8", timeout: options.timeoutMs ?? 15_000, env: { ...process.env, ...(options.env ?? {}) }, maxBuffer: 4 * 1024 * 1024 });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const ok = result.status === 0 && (!options.mustMatch || options.mustMatch.test(text));
  return { id, ok, status: result.status, signal: result.signal, durationMs: Date.now() - started, excerpt: excerpt(text, 24), command: [command, ...args].join(" ") };
}

function backendProbes(args) {
  const runtime = extensionRuntimePaths();
  const graphify = runtime.graphify;
  const graphPath = path.join(args.projectTarget, ".pi", "navigation", "graphify", "graphify-out", "graph.json");
  const probes = [];
  if (existsSync(graphify) && existsSync(graphPath)) probes.push(commandProbe("graphify-map", graphify, ["query", "navigation", "--graph", graphPath, "--budget", "1200"], { timeoutMs: args.backendTimeoutMs }));
  else probes.push({ id: "graphify-map", ok: false, skipped: true, reason: "graphify binary or graph missing" });
  return probes;
}

async function main() {
  const args = parseArgs();
  if (args.help) { console.log(usage()); return; }
  const modulePath = resolveAgentSessionModule(args);
  const imported = await import(toImportSpecifier(modulePath));
  if (typeof imported.createAgentSession !== "function") throw new Error(`AgentSession module ${modulePath} does not export createAgentSession`);
  const { createAgentSession } = imported;
  const fixtures = await buildFixtures();
  const { session } = await createAgentSession({ cwd: args.cwd, agentDir: args.agentDir, noTools: "builtin", tools: ["explore", "code_context", "trace", "docs", "find", "grep", "read"] });
  const checks = [
    { id: "project-code-explore", tool: "explore", cwd: args.cwd, params: { query: "project navigation clean-break architecture", view: "code", scope: args.projectTarget, limit: 5 }, assertions: [["code route", t => /Code map|UNAVAILABLE|read/i.test(t)], ["no lexical fallback wording", t => !/fallback.*grep|fallback.*find/i.test(t)]] },
    { id: "project-map-explore", tool: "explore", cwd: args.cwd, params: { query: "project navigation graph map", view: "map", scope: args.projectTarget, limit: 5 }, assertions: [["graph route", t => /Graph map|UNAVAILABLE/i.test(t)], ["query-time non-mutation", t => !/extract|update|install/i.test(t.split("\n").slice(0, 8).join("\n"))]] },
    { id: "project-code-context-impact", tool: "code_context", cwd: args.cwd, params: { goal: "what changes if navigation tool routing changes", purpose: "impact", target: "src/tools/explore.ts", scope: args.projectTarget, limit: 5 }, assertions: [["code_context route", t => /Code context|UNAVAILABLE/i.test(t)], ["no trace impact", t => !/trace\(relation:?['\"]impact/i.test(t)]] },
    { id: "project-docs", tool: "docs", cwd: args.cwd, params: { action: "search", query: "navigation setup", scope: args.projectTarget, limit: 5 }, assertions: [["docs route", t => /Docs|UNAVAILABLE|docs/i.test(t)]] },
    { id: "grep-exact", tool: "grep", cwd: args.cwd, params: { query: "registerGrepTool", kind: "symbol", scope: path.join(args.projectTarget, "src", "tools"), glob: "grep.ts", expand: 1, budget: 5000 }, assertions: [["grep source", t => /Exact search|src\/tools\/grep\.ts|grep\.ts|UNAVAILABLE/i.test(t)], ["no relationship routing", t => !/callers|callees|imports|importers/i.test(t.split("\n").slice(0, 4).join("\n"))]] },
    { id: "find-jeito-codeweave-pi", tool: "find", cwd: args.cwd, params: { pattern: "jeito-codeweave-pi", scope: args.parentTarget, budget: 5000 }, assertions: [["jeito-codeweave-pi path", t => /jeito-codeweave-pi/.test(t) || /Path search|UNAVAILABLE/i.test(t)]] },
    { id: "trace-callers", tool: "trace", cwd: args.cwd, params: { target: "registerExploreTool", relation: "callers", scope: args.projectTarget, limit: 5 }, assertions: [["trace route", t => /Code callers|Live code callers|UNAVAILABLE|registerExploreTool/i.test(t)]] },
    { id: "clean-overview", tool: "explore", cwd: fixtures.clean, params: { query: "help me understand this repo", view: "code", scope: fixtures.clean, limit: 4 }, assertions: [["clean route", t => /Code map|UNAVAILABLE/i.test(t)]] },
    { id: "docs-unprepared", tool: "docs", cwd: fixtures.docs, params: { action: "search", query: "where are setup docs", scope: fixtures.docs, limit: 4 }, assertions: [["honest docs missing", t => /UNAVAILABLE|docs navigation/i.test(t)]] },
    { id: "grep-not-navigation", tool: "grep", cwd: args.cwd, params: { query: "where is navigation setup?", kind: "content", scope: args.projectTarget, budget: 2000 }, assertions: [["exact utility route", t => /Exact search|UNAVAILABLE|exact/i.test(t)], ["no fallback router", t => !/use explore|use trace|fallback/i.test(t.split("\n").slice(0, 5).join("\n"))]] },
  ];
  let toolResults = [];
  try {
    for (const check of checks) toolResults.push(await runCheck(session, check));
  } finally {
    session.dispose();
  }
  const backendResults = backendProbes(args);
  const failures = [...toolResults, ...backendResults].filter(item => !item.ok && !item.skipped);
  const report = {
    status: failures.length ? "failed" : "passed",
    summary: `${toolResults.filter(r => r.ok).length}/${toolResults.length} tool checks passed; ${backendResults.filter(r => r.ok).length}/${backendResults.length} backend probes passed`,
    proofLevel: "Fresh AgentSession extension tools plus direct local backend commands; does not introspect an already-mounted conversation functions.* implementation.",
    projectTarget: args.projectTarget,
    parentTarget: args.parentTarget,
    fixtures,
    exploreSourceHash: await sha256File(path.join(EXTENSION_ROOT, "src", "tools", "explore.ts")),
    toolResults,
    backendResults,
  };
  if (args.out) { await mkdir(path.dirname(args.out), { recursive: true }); await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`); }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.status.toUpperCase()}: ${report.summary}`);
    for (const item of toolResults) console.log(`${item.ok ? "✔" : "✖"} tool/${item.id}${item.ok ? "" : ` — ${item.failures.join("; ")}`}`);
    for (const item of backendResults) console.log(`${item.ok ? "✔" : item.skipped ? "-" : "✖"} backend/${item.id}${item.ok ? "" : item.skipped ? ` — skipped: ${item.reason}` : ""}`);
    console.log(`Proof level: ${report.proofLevel}`);
    if (args.out) console.log(`Report: ${args.out}`);
  }
  if (failures.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
