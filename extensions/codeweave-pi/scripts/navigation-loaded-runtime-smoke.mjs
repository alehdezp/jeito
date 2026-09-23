#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_AGENT_DIR = path.join(homedir(), ".pi", "agent");
const DEFAULT_TARGET = EXTENSION_ROOT;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    out: undefined,
    target: DEFAULT_TARGET,
    cwd: EXTENSION_ROOT,
    agentDir: DEFAULT_AGENT_DIR,
    module: process.env.PI_AGENT_SESSION_MODULE,
    reloads: 1,
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
    else if (flag === "--path" || flag === "--target") args.target = path.resolve(value());
    else if (flag === "--cwd") args.cwd = path.resolve(value());
    else if (flag === "--agent-dir") args.agentDir = path.resolve(value());
    else if (flag === "--module") args.module = value();
    else if (flag === "--reloads") args.reloads = Number(value());
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!Number.isInteger(args.reloads) || args.reloads < 0 || args.reloads > 5) throw new Error(`--reloads must be an integer from 0 to 5; got ${args.reloads}`);
  return args;
}

function usage() {
  return `Usage: node scripts/navigation-loaded-runtime-smoke.mjs [--json] [--out file] [--path target] [--reloads n]\n\nVerifies jeito codeweave-pi explore behavior through a freshly created AgentSession and\noptional AgentSession.reload() cycles. This is stronger than source-only tests, but it\ndoes not directly call an already-mounted conversation tool such as functions.explore.\nIf this passes while the active conversation tool fails, reload the Pi session/extension.\n`;
}

function textOf(result) {
  return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

function topLeadBlock(text) {
  const match = /\n1\. \[[\s\S]*?(?=\n2\. \[|\n\[More leads omitted|\nDiagnostics:|$)/.exec(text);
  return match ? match[0] : "";
}

function countMatches(text, re) {
  return (text.match(re) ?? []).length;
}

function compactText(text) {
  return text.split("\n").slice(0, 40).join("\n");
}


async function sha256File(file) {
  if (!existsSync(file)) return undefined;
  return createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 16);
}

const CHECKS = [
  {
    id: "code-invalid-call-guidance",
    query: "grep implementation",
    params: { view: "code", operation: "search", anchor: "grep implementation", query: "wrong field", limit: 3 },
    assertions: [
      ["typed invalid call", text => /INVALID CALL: explore[\s\S]*uses anchor, not query[\s\S]*nothing ran/i.test(text)],
    ],
  },
  {
    id: "code-search-corrected",
    query: "grep implementation",
    params: { view: "code", operation: "search", anchor: "grep exact occurrence search", limit: 6 },
    assertions: [
      ["code candidates or honest unavailable", text => /Code explore[\s\S]*Candidates:|UNAVAILABLE|semantic=.*(?:ready|degraded)|WARNING: code exploration failed/i.test(text)],
    ],
  },
  {
    id: "map-exact-path-page-1",
    query: "src/tools/explore.ts",
    params: { view: "map", query: "src/tools/explore.ts", limit: 1, page: 1 },
    assertions: [
      ["exact path retained as start", text => /Start:\s*\[[^\]]*src\/tools\/explore\.ts/i.test(text)],
      ["structural page one node", text => countMatches(text, /^NODE /gm) <= 1],
      ["structural page one edge", text => countMatches(text, /^EDGE /gm) <= 1],
    ],
  },
  {
    id: "map-exact-path-page-2",
    query: "src/tools/explore.ts",
    params: { view: "map", query: "src/tools/explore.ts", limit: 1, page: 2 },
    assertions: [
      ["exact path retained on continuation", text => /Start:\s*\[[^\]]*src\/tools\/explore\.ts/i.test(text)],
      ["structural page two bounded", text => countMatches(text, /^(?:NODE|EDGE) /gm) <= 2],
    ],
  },
];

async function runPass(session, label, args) {
  const tool = session.getToolDefinition("explore");
  if (!tool) throw new Error("AgentSession did not load explore; check agentDir/tools configuration");
  const results = [];
  for (const check of CHECKS) {
    const started = Date.now();
    let text = "";
    const failures = [];
    try {
      const result = await tool.execute(`loaded-runtime-${check.id}`, { scope: args.target, ...check.params }, undefined, undefined, { cwd: args.cwd, mode: "print", hasUI: false, ui: { notify() {} } });
      text = textOf(result);
      if (check.expectThrow) failures.push(`expected throw ${check.expectThrow}, got success`);
      for (const [name, predicate] of check.assertions) {
        if (!predicate(text)) failures.push(name);
      }
    } catch (error) {
      if (!check.expectThrow || !check.expectThrow.test(String(error?.message ?? error))) failures.push(`execute threw: ${error?.message ?? error}`);
      text = String(error?.message ?? error);
    }
    results.push({
      id: check.id,
      label,
      query: check.query,
      ok: failures.length === 0,
      failures,
      durationMs: Date.now() - started,
      excerpt: compactText(text),
    });
  }
  return results;
}

async function main() {
  const args = parseArgs();
  if (args.help) { console.log(usage()); return; }
  const agentSessionModule = resolveAgentSessionModule(args);
  const moduleSpecifier = toImportSpecifier(agentSessionModule);
  const imported = await import(moduleSpecifier).catch(error => {
    throw new Error(`Could not import AgentSession module ${agentSessionModule}: ${error?.message ?? error}. Set PI_AGENT_SESSION_MODULE or --module.`);
  });
  if (typeof imported.createAgentSession !== "function") throw new Error(`AgentSession module ${agentSessionModule} does not export createAgentSession`);
  const { createAgentSession } = imported;
  const exploreHash = await sha256File(path.join(EXTENSION_ROOT, "src", "tools", "explore.ts"));
  const { session } = await createAgentSession({
    cwd: args.cwd,
    agentDir: args.agentDir,
    noTools: "builtin",
    tools: ["explore", "read", "grep", "find", "trace"],
  });
  const all = [];
  try {
    all.push(...await runPass(session, "fresh", args));
    for (let i = 0; i < args.reloads; i++) {
      await session.reload();
      all.push(...await runPass(session, `reload-${i + 1}`, args));
    }
  } finally {
    session.dispose();
  }
  const failures = all.filter(item => !item.ok);
  const report = {
    status: failures.length ? "failed" : "passed",
    summary: failures.length ? `${failures.length}/${all.length} loaded-runtime checks failed` : `${all.length}/${all.length} loaded-runtime checks passed`,
    proofLevel: "AgentSession loaded/reloaded extension tools; not the already-mounted conversation functions.* API surface",
    staleRuntimeGuidance: failures.length ? "If source tests pass but this or active functions.explore fails, reload the Pi session/extension and rerun this smoke." : undefined,
    target: args.target,
    cwd: args.cwd,
    agentDir: args.agentDir,
    module: agentSessionModule,
    exploreSourceHash: exploreHash,
    checks: all,
  };
  if (args.out) await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.status.toUpperCase()}: ${report.summary}`);
    for (const check of all) console.log(`${check.ok ? "✔" : "✖"} ${check.label}/${check.id}${check.ok ? "" : ` — ${check.failures.join("; ")}`}`);
    console.log(`Proof level: ${report.proofLevel}`);
  }
  if (failures.length) process.exitCode = 1;
}

function resolveAgentSessionModule(args) {
  if (args.module) return args.module;
  const candidates = [
    path.join(args.agentDir, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    path.join(path.dirname(path.dirname(process.execPath)), "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    process.env.npm_config_prefix ? path.join(process.env.npm_config_prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js") : undefined,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "@earendil-works/pi-coding-agent";
}

function toImportSpecifier(value) {
  if (/^file:/.test(value)) return value;
  if (value.startsWith("/") || value.startsWith(".") || /^[A-Za-z]:[\\/]/.test(value)) return new URL(`file://${path.resolve(value)}`).href;
  return value;
}

main().catch(error => {
  console.error(`navigation-loaded-runtime-smoke failed: ${error?.message ?? error}`);
  process.exit(1);
});
