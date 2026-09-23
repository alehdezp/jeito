import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import jeitoCodeweavePiExtension from "../index.ts";
import { extensionRuntimePaths, setExtensionRuntimeRootForTests } from "../src/core/owned-runtime.ts";

export function makePi() {
  const tools = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    getActiveTools() { return []; },
    setActiveTools() {},
    tool(name) { const tool = tools.get(name); assert.ok(tool, `missing tool ${name}`); return tool; },
    tools,
  };
}

export function registerCleanPi() {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  return pi;
}

export async function tempProject(prefix = "pi-nav-clean-") {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(cwd, "README.md"), "# Fixture\n");
  return cwd;
}

export async function callTool(pi, cwd, name, params = {}) {
  const result = await pi.tool(name).execute(`test-${name}`, params, undefined, undefined, { cwd });
  return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

export async function executable(file, content) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  await chmod(file, 0o755);
  if (basename(file).startsWith("graphify")) await publishOwnedGraphifyFixture(dirname(dirname(file)), file);
  return file;
}

export async function publishOwnedGraphifyFixture(cwd, graphify) {
  const runtime = join(cwd, ".runtime");
  setExtensionRuntimeRootForTests(runtime);
  const paths = extensionRuntimePaths();
  await mkdir(dirname(paths.python), { recursive: true });
  await writeFile(paths.python, "");
  await copyFile(graphify, paths.graphify);
  await chmod(paths.graphify, 0o755);
  await writeFile(paths.ready, "ready\n");
}

export async function writeGraphifyFixture(cwd) {
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "{}\n");
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node\nif (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') process.exit(12);\nconsole.log('NODE fixture [src=src/main.ts loc=L1]');\n`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));
  return graphify;
}
