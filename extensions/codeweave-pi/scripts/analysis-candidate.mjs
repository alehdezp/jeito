#!/usr/bin/env node
// Explicit, local development candidate. Never registers with Pi or activates indexing.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectProjectRoot } from "../src/core/project-root.ts";
import { spawnSupervisedProcess } from "../src/core/process-supervisor.ts";
import { piNavArtifactPaths, resolvePiNavTarget } from "../src/core/pi-nav-native.ts";

const extensionRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const candidate = join(extensionRoot, ".tmp", "analysis-candidate");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const usage = `Usage: node scripts/analysis-candidate.mjs --build [--maintenance-grammars DIRECTORY --semantic-model DIRECTORY]
  or --root PROJECT --state PRIVATE_DIRECTORY --prepare
     (--project | --file LANGUAGE:RELATIVE_PATH [--file ...])
     [--source RELATIVE_CONFIG_PATH ...] [--respect-policy] [--query 'GREP_PARAMETERS_JSON' ...] [--json]
  or --root PROJECT --state PRIVATE_DIRECTORY [--query 'GREP_PARAMETERS_JSON' | --trace 'TRACE_PARAMETERS_JSON'] ... [--json]

--build explicitly assembles the isolated Core runtime. Its first build needs
existing maintenance grammars and the pinned semantic model; subsequent builds
can reuse those candidate assets. Nothing downloads them. --prepare builds if
necessary and reconciles the selected project. Queries never build or repair.
The state directory must be private and outside captured source. No installed
replacement, Pi registration, host changes or automatic activation.
`;

function argumentsForRun(args) {
  const options = { files: [], queries: [], json: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--help") return null;
    if (key === "--json") { options.json = true; continue; }
    if (key === "--prepare") { options.prepare = true; continue; }
    if (key === "--build") { options.build = true; continue; }
    if (key === "--respect-policy") { options.respectPolicy = true; continue; }
    if (key === "--project") { options.project = true; options.respectPolicy = true; continue; }
    if (!["--root", "--state", "--file", "--source", "--query", "--trace", "--maintenance-grammars", "--semantic-model"].includes(key) || !args[i + 1]) throw new Error(usage);
    const value = args[++i];
    if (key === "--root") options.root = realpathSync(resolve(value));
    else if (key === "--state") options.state = resolve(value);
    else if (key === "--maintenance-grammars") options.maintenanceGrammars = realpathSync(resolve(value));
    else if (key === "--semantic-model") options.semanticModel = realpathSync(resolve(value));
    else if (key === "--query" || key === "--trace") {
      const query = JSON.parse(value);
      if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("Each query must be a tool parameter object");
      options.queries.push({ tool: key === "--trace" ? "trace" : "grep", query });
    } else if (key === "--source") options.files.push({ path: value, language: null });
    else {
      const colon = value.indexOf(":");
      if (colon < 1 || colon === value.length - 1) throw new Error("--file requires LANGUAGE:RELATIVE_PATH");
      options.files.push({ path: value.slice(colon + 1), language: value.slice(0, colon) });
    }
  }
  if (options.build) {
    if (options.root || options.state || options.files.length || options.project || options.prepare || options.queries.length || options.respectPolicy) throw new Error(usage);
  } else if (!options.root || !options.state || (options.prepare
    ? ((!options.project && !options.files.length) || (options.project && options.files.length))
    : (!options.queries.length || options.files.length || options.project || options.respectPolicy))) throw new Error(usage);
  if (!options.build && !options.prepare && (options.maintenanceGrammars || options.semanticModel)) throw new Error(usage);
  return options;
}

async function command(script, args, cwd, signal) {
  const child = spawnSupervisedProcess(process.execPath, [script, ...args], { cwd, signal, timeoutMs: 1_200_000 });
  child.child.stdin.end();
  child.child.stdout.on("data", chunk => process.stderr.write(chunk));
  child.child.stderr.on("data", chunk => process.stderr.write(chunk));
  const exit = await child.done;
  signal.throwIfAborted();
  if (exit.code !== 0 || exit.error || exit.timedOut) throw new Error(`Candidate command failed: ${script} (${exit.error ?? exit.signal ?? exit.code})`);
}

function sourceInputs() {
  const paths = ["index.ts", "package.json", "package-lock.json", "scripts/pi-nav-build.mjs", "scripts/analysis-candidate.mjs", "scripts/navigation-freshen.mjs", "scripts/navigation-doctor.mjs", "native/pi-nav/Cargo.toml", "native/pi-nav/Cargo.lock", "native/pi-nav/build.rs", "native/pi-nav/artifacts.json", "native/qmd/package.json"];
  function collect(directory) {
    for (const entry of readdirSync(join(extensionRoot, directory), { withFileTypes: true })) {
      if (["target", "runtime", "node_modules", ".git"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error(`Non-regular candidate input: ${path}`);
    }
  }
  for (const directory of ["src", "native/pi-nav/src", "native/pi-nav/prompts", "native/analysis"]) collect(directory);
  // Ordinary Grep imports the existing QMD SDK even when its lane is unavailable.
  // Copy that prepared runtime unchanged; never build/download QMD or its models here.
  collect("native/qmd/runtime");
  return new Map(paths.sort().map(path => [path, readFileSync(join(extensionRoot, path))]));
}

async function assemble(signal, options) {
  const inputs = sourceInputs();
  // Successful-build input stamps are only a development cache, not a release manifest.
  const stampPath = join(candidate, "BUILD-INPUTS.json");
  let previous = {};
  if (existsSync(stampPath)) previous = JSON.parse(readFileSync(stampPath, "utf8"));
  const stamp = { source: extensionRoot, inputs: Object.fromEntries([...inputs].map(([path, bytes]) => [path, hash(bytes)])) };
  if (previous.source && previous.source !== extensionRoot) throw new Error("Candidate belongs to another source checkout");
  // Partial replacement followed by source reversion must not reuse an old stamp.
  rmSync(stampPath, { force: true });
  const allPaths = new Set([...inputs.keys(), ...Object.keys(previous.inputs ?? {})]);
  for (const path of allPaths) {
    if (relative(candidate, resolve(candidate, path)) !== path || path.startsWith(`..${sep}`)) throw new Error("Invalid candidate input record");
    if (!inputs.has(path)) {
      const destination = join(candidate, path);
      if (existsSync(dirname(destination)) && realpathSync(dirname(destination)) !== dirname(destination)) throw new Error("Candidate cleanup parent is a symlink");
      rmSync(destination, { force: true });
    }
  }
  for (const [path, bytes] of inputs) {
    const destination = join(candidate, path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (realpathSync(dirname(destination)) !== dirname(destination)) throw new Error(`Candidate source parent is a symlink: ${path}`);
    if (existsSync(destination)) {
      if (realpathSync(destination) !== destination) throw new Error(`Candidate source is a symlink: ${path}`);
      if (readFileSync(destination).equals(bytes)) continue; // Preserve Cargo input mtimes.
    }
    writeFileSync(destination, bytes);
  }
  const changed = path => previous.inputs?.[path] !== stamp.inputs[path];
  const builder = join(candidate, "scripts/pi-nav-build.mjs");
  // Navigation compiles these maintained source helpers through Rust #[path].
  // Their changes must invalidate the query addon as well as the analysis kernel.
  const queryInputs = [
    "package.json", "package-lock.json", "scripts/pi-nav-build.mjs",
    "native/analysis/codegraph-kernel/src/tsjs/source.rs",
    "native/analysis/codegraph-kernel/src/comment_ranges.rs",
  ];
  const queryChanged = [...allPaths].some(path => (path.startsWith("native/pi-nav/") || queryInputs.includes(path)) && changed(path));
  // Only analysis-source.ts is imported into the core bundle; worker/lifecycle TS is copied, not compiled into it.
  const analysisChanged = [...allPaths].some(path => ((path.startsWith("native/analysis/") && !path.endsWith(".md")) || path === "src/core/analysis-source.ts" || ["package.json", "package-lock.json", "scripts/pi-nav-build.mjs"].includes(path)) && changed(path));
  const queryArtifacts = piNavArtifactPaths(candidate, resolvePiNavTarget());
  const analysis = join(candidate, "native/analysis/runtime");
  const { ANALYSIS_OUTPUT_ARTIFACTS, MAINTENANCE_OUTPUT_ARTIFACTS, SEMANTIC_MODEL_DIRECTORY } = await import(pathToFileURL(join(candidate, "native/analysis/identity.mjs")));
  const analysisFiles = [...Object.values(ANALYSIS_OUTPUT_ARTIFACTS), ...Object.values(MAINTENANCE_OUTPUT_ARTIFACTS)];
  const maintenanceGrammars = options.maintenanceGrammars ?? join(analysis, "wasm");
  const semanticModel = options.semanticModel ?? join(analysis, SEMANTIC_MODEL_DIRECTORY);
  if (!existsSync(maintenanceGrammars) || !existsSync(semanticModel)) throw new Error("First Core candidate build requires --maintenance-grammars and --semantic-model existing directories; no automatic downloads");
  if (analysisChanged || options.maintenanceGrammars || options.semanticModel || !analysisFiles.every(name => existsSync(join(analysis, name)))) {
    const built = join(candidate, ".tmp", "analysis-build");
    await command(builder, ["analysis-build", "--output-dir", built, "--maintenance-grammars", maintenanceGrammars, "--semantic-model", semanticModel], candidate, signal);
    mkdirSync(analysis, { recursive: true });
    for (const name of analysisFiles) renameSync(join(built, name), join(analysis, name));
    for (const directory of ["wasm", SEMANTIC_MODEL_DIRECTORY]) {
      mkdirSync(join(analysis, directory), { recursive: true });
      for (const name of readdirSync(join(built, directory))) renameSync(join(built, directory, name), join(analysis, directory, name));
    }
  }
  if (queryChanged || !Object.values(queryArtifacts).every(existsSync)) await command(builder, ["build"], candidate, signal);
  await command(builder, ["check-core", "--json"], candidate, signal);
  for (const [path, bytes] of inputs) {
    if (hash(readFileSync(join(extensionRoot, path))) !== hash(bytes)) throw new Error(`Source changed during assembly: ${path}; rerun the candidate`);
  }
  writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + "\n");
  return analysis;
}



async function main(options) {
  const lock = join(extensionRoot, ".tmp", "analysis-candidate.lock");
  const maintenance = options.build || options.prepare;
  if (maintenance) {
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    try { mkdirSync(lock, { mode: 0o700 }); } catch (error) {
      if (error.code === "EEXIST") throw new Error(`Another candidate maintenance command owns ${lock}. Remove it only after confirming that command stopped.`);
      throw error;
    }
  }
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Candidate interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if (maintenance) {
      mkdirSync(candidate, { recursive: true, mode: 0o700 });
      if (realpathSync(candidate) !== candidate) throw new Error("Candidate path must not be a symlink");
      await assemble(abort.signal, options);
    } else if (!existsSync(join(candidate, "BUILD-INPUTS.json"))) {
      throw new Error("Candidate runtime is missing; run --build or --prepare explicitly");
    }
    if (options.build) { console.log(JSON.stringify({ candidate, built: true })); return; }
    abort.signal.throwIfAborted();
    const root = detectProjectRoot(options.root).root;
    const project = { root, directory: options.state };
    const { readAnalysisProject } = await import(pathToFileURL(join(candidate, "src/core/analysis-project.mjs")));
    let publication;
    if (options.prepare) {
      const { prepareAnalysisProject } = await import(pathToFileURL(join(candidate, "src/core/native-maintenance.ts")));
      publication = await prepareAnalysisProject({ root: options.root, directory: options.state,
        ...(options.project ? {} : { files: options.files }), respectPolicy: options.respectPolicy }, abort.signal);
    } else {
      try {
        const { sources: _sources, ...metadata } = readAnalysisProject(project).metadata;
        publication = metadata;
      } catch { /* Each registered request reports whether it needs unavailable prepared state. */ }
    }
    const { registerGrepTool } = await import(pathToFileURL(join(candidate, "src/tools/grep.ts")));
    const { registerTraceTool } = await import(pathToFileURL(join(candidate, "src/tools/trace.ts")));
    const tools = new Map();
    const pi = { registerTool(tool) { tools.set(tool.name, tool); } };
    registerGrepTool(pi, { analysisProject: project });
    registerTraceTool(pi, { analysisProject: project });
    const results = [];
    for (const { tool, query } of options.queries) {
      const result = await tools.get(tool).execute("analysis-candidate", query, abort.signal, undefined, { cwd: options.root });
      results.push({ tool, query, result });
    }
    const report = { candidate, state: options.state, publication, results };
    if (options.json) console.log(JSON.stringify(report));
    else {
      console.log(publication ? `Retained ${publication.corpus ?? "unpublished"} in ${options.state}; generation ${publication.generation}.` : `No usable prepared metadata at ${options.state}; availability is reported per query.`);
      for (const { tool, query, result } of results) console.log(`\n${tool}(${JSON.stringify(query)})\n${result.content.filter(part => part.type === "text").map(part => part.text).join("\n")}`);
    }
    if (results.some(({ result }) => result.isError || result.details?.envelope?.status === "error")) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (maintenance) rmSync(lock, { recursive: true });
  }
}

try {
  const options = argumentsForRun(process.argv.slice(2));
  if (options) await main(options);
  else console.log(usage);
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
}
