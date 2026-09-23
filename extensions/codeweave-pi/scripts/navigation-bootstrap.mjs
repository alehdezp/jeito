#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { inspectNavigation, writeBootstrap } from "./navigation-doctor.mjs";
import { prepareNavigation } from "./navigation-prepare.mjs";
import { loadNavigationAutomationConfig } from "../src/core/navigation-automation-config.ts";
import { decideProviderPolicy } from "../src/core/provider-registry.ts";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { path: process.cwd(), config: undefined, writeConfig: false, dryRun: false, force: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--path" || flag === "-C") args.path = value();
    else if (flag === "--config") args.config = value();
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--write-config") args.writeConfig = true;
    else if (flag === "--force") args.force = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

export async function bootstrapNavigation(argv = process.argv.slice(2), options = {}) {
  const args = Array.isArray(argv) ? parseArgs(argv) : argv;
  if (args.help) return { help: true, text: helpText() };
  const env = options.env ?? process.env;
  const root = path.resolve(args.path ?? process.cwd());
  const before = await snapshotTree(root);
  const loaded = loadNavigationAutomationConfig({ path: args.config, env });
  const globalConfig = validateGlobalConfig(loaded, env);
  const doctor = inspectNavigation(root, { env });
  const prepare = await prepareNavigation(["--path", root, "--dry-run", ...(args.config ? ["--config", args.config] : [])], { env });
  const afterDryRun = await snapshotTree(root);
  const dryRunMutations = diffSnapshots(before, afterDryRun);
  const writes = [];
  const warnings = [];
  const obsoleteDiagnostics = loaded.diagnostics.filter(item => /^obsolete backends\.tilth ignored/.test(item));
  warnings.push(...obsoleteDiagnostics);
  if (args.writeConfig) {
    const written = writeBootstrap(root, { env, force: args.force });
    writes.push(...(written.writes ?? []));
    warnings.push(...(written.warnings ?? []));
  }
  const issues = [
    ...loaded.diagnostics.filter(item => !obsoleteDiagnostics.includes(item)),
    ...globalConfig.errors,
    ...(dryRunMutations.length ? [`prepare dry-run mutated ${dryRunMutations.join(", ")}`] : []),
  ];
  const status = issues.length ? "error" : warnings.length || globalConfig.warnings.length || doctor.status !== "success" || prepare.status !== "planned" ? "warning" : "success";
  const summary = `${args.writeConfig ? "bootstrap write-config" : "bootstrap dry-run"}: ${issues.length} error(s), ${warnings.length + globalConfig.warnings.length} warning(s), ${dryRunMutations.length} dry-run mutation(s), ${writes.length} write(s).`;
  return {
    status,
    summary,
    next_actions: nextActions({ issues, warnings: [...warnings, ...globalConfig.warnings], writeConfig: args.writeConfig }),
    artifacts: [...writes.map(file => display(root, file)), loaded.path ? display(root, loaded.path) : "global config default"],
    recovery: {
      safe_retry: `npm run nav:bootstrap -- --path ${JSON.stringify(root)} --dry-run --json`,
      stop_conditions: ["installer/download/provider call would be required", "global config is invalid", "provider env var names are missing", "storage root is invalid", "prepare dry-run mutates files"],
    },
    mode: args.writeConfig ? "write-config" : "dry-run",
    root,
    global_config: globalConfig,
    tools: doctor.tools,
    prepare: { status: prepare.status, policy: prepare.plan?.policy, summary: prepare.plan?.summary, dry_run_mutations: dryRunMutations },
    writes: writes.map(file => display(root, file)),
    warnings,
  };
}

function validateGlobalConfig(loaded, env) {
  const config = loaded.config;
  const errors = [];
  const warnings = [];
  const providerChecks = [];
  for (const [capability, provider] of [["embedding", config.providers.defaultEmbeddingProvider], ["llm", config.providers.defaultLLMProvider]]) {
    if (!provider) continue;
    const decision = decideProviderPolicy({ config, provider, capability, env, requireEnv: true });
    providerChecks.push({
      capability,
      provider: decision.canonicalProvider || provider,
      policy: decision.policy,
      required_env: decision.requiredEnv,
      missing_env: decision.missingEnv,
      content_leaves_machine: decision.contentLeavesMachine,
      may_download_models: decision.mayDownloadModels,
      reasons: decision.reasons,
    });
    if (decision.policy === "blocked") errors.push(`${capability} provider ${provider} is blocked: ${decision.reasons.join("; ")}`);
    else if (decision.policy === "ask_first") warnings.push(`${capability} provider ${provider} needs confirmation/config: ${decision.reasons.join("; ")}`);
  }
  if (!path.isAbsolute(config.storage.indexRoot)) errors.push("storage.indexRoot must resolve to an absolute path");
  if (!config.storage.projectStateDir || path.isAbsolute(config.storage.projectStateDir) || config.storage.projectStateDir.includes("..")) errors.push("storage.projectStateDir must be a safe relative path");
  return {
    path: loaded.path,
    exists: loaded.exists,
    diagnostics: loaded.diagnostics,
    storage: { indexRoot: config.storage.indexRoot, projectStateDir: config.storage.projectStateDir },
    providers: providerChecks,
    errors,
    warnings,
  };
}

const SNAPSHOT_SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "dist", "build", "out", "target", "coverage",
  "graphify-out", ".codanna", ".code-review-graph", ".codescope", ".codedb-mcp", ".trace-mcp", ".semble", ".pi", "navigation",
]);

async function snapshotTree(root) {
  const output = new Map();
  async function visit(abs) {
    for (const entry of await readdir(abs, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(abs, entry.name);
      const rel = display(root, child);
      if (entry.isDirectory()) {
        output.set(`${rel}/`, "dir");
        await visit(child);
      } else if (entry.isFile()) {
        const info = await stat(child).catch(() => undefined);
        if (info) output.set(rel, `file:${info.size}:${Math.trunc(info.mtimeMs)}`);
      }
    }
  }
  if (existsSync(root)) await visit(root);
  return output;
}

function diffSnapshots(before, after) {
  const changed = [];
  for (const [file, hash] of after) if (before.get(file) !== hash) changed.push(file);
  for (const file of before.keys()) if (!after.has(file)) changed.push(file);
  return [...new Set(changed)].sort();
}

function display(root, file) {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

function nextActions({ issues, warnings, writeConfig }) {
  if (issues.length) return ["Fix bootstrap errors, then rerun dry-run before writing config."];
  if (!writeConfig) return ["Review dry-run output, then rerun with --write-config only if safe skeleton config/state files are desired."];
  if (warnings.length) return ["Review warnings; do not run installers/providers/model downloads from bootstrap."];
  return ["Run nav:prepare --dry-run or nav:real-smoke before enabling any prepared lane."];
}

function helpText() {
  return `Usage: node scripts/navigation-bootstrap.mjs [--path DIR] [--config FILE] [--write-config] [--force] [--json]\n\nValidates global navigation config, provider env var names, storage roots, installed tools, and nav:prepare --dry-run. It never installs packages, calls providers, downloads models, or builds indexes. --write-config writes only safe project config/state skeletons.`;
}

function renderText(result) {
  if (result.help) return result.text;
  const lines = [`Navigation bootstrap ${result.mode}: ${result.status}`, result.summary, `Root: ${result.root}`];
  for (const error of result.global_config.errors) lines.push(`Error: ${error}`);
  for (const warning of [...result.global_config.warnings, ...result.warnings]) lines.push(`Warning: ${warning}`);
  if (result.writes.length) lines.push(`Writes: ${result.writes.join(", ")}`);
  lines.push(`Next: ${result.next_actions.join("; ")}`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (args.help) console.log(helpText());
  else bootstrapNavigation(args).then(result => {
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
    if (result.status === "error") process.exitCode = 2;
  }).catch(error => {
    console.error(`ERROR: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
