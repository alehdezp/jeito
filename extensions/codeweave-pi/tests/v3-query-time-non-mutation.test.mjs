import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import jeitoCodeweavePiExtension from "../index.ts";

const FORBIDDEN_ARTIFACTS = [
  ".pi",
  ".codanna",
  ".codedb-mcp",
  ".codescope",
  ".trace-mcp",
  ".semble",
  ".fastembed_cache",
  "graphify-out",
  "navigation-setup.log.jsonl",
];

function makePi() {
  const tools = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, { ...tool, sourceInfo: { source: "jeito-codeweave-pi-test" } }); },
    on() {},
    getActiveTools() { return []; },
    getAllTools() { return [...tools.values()]; },
    tool(name) {
      const tool = tools.get(name);
      assert.ok(tool, `missing loaded tool ${name}`);
      return tool;
    },
  };
}

async function callTool(tool, params, cwd) {
  const result = await tool.execute(`test-${tool.name}`, params, undefined, undefined, { cwd });
  return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

async function makeRepo(prefix = "query-nonmut-") {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "docs"), { recursive: true });
  await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(cwd, "README.md"), "# Demo\n\nUse src/app.ts to start.\n");
  await writeFile(join(cwd, "docs", "guide.md"), "# Guide\n\nNatural navigation docs.\n");
  await writeFile(join(cwd, "src", "app.ts"), "export function run() { return helper(); }\nexport function helper() { return 1; }\n");
  await writeFile(join(cwd, "src", "config.json"), "{\"enabled\":true}\n");
  await writeFile(join(cwd, "node_modules", "pkg", "noise.ts"), "export const noise = true;\n");
  return cwd;
}

async function snapshotTree(root) {
  const rows = new Map();
  async function visit(abs) {
    const info = await stat(abs);
    const rel = relative(root, abs).replace(/\\/g, "/") || ".";
    if (info.isDirectory()) {
      rows.set(`${rel}/`, "dir");
      const entries = await readdir(abs, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) await visit(join(abs, entry.name));
      return;
    }
    if (info.isFile()) {
      const hash = createHash("sha256").update(await readFile(abs)).digest("hex");
      rows.set(rel, `file:${info.size}:${hash}`);
    }
  }
  await visit(root);
  return rows;
}

function diffSnapshots(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].sort().flatMap(path => {
    if (!before.has(path)) return [`added:${path}`];
    if (!after.has(path)) return [`removed:${path}`];
    if (before.get(path) !== after.get(path)) return [`changed:${path}`];
    return [];
  });
}

function artifactPaths(root) {
  return FORBIDDEN_ARTIFACTS.filter(path => existsSync(join(root, path)));
}

const CASES = [
  {
    tool: "explore",
    params: cwd => ({ view: "code", operation: "search", anchor: "application configuration", scope: cwd, limit: 3 }),
    expect: /UNAVAILABLE: code exploration|Code explore|UNAVAILABLE/i,
  },
  {
    tool: "trace",
    params: cwd => ({ target: "run", relation: "callers", scope: join(cwd, "src"), limit: 3 }),
    expect: /UNAVAILABLE: code trace|Live code|prepared code graph|Callers of/i,
  },
  {
    tool: "docs_search",
    params: cwd => ({ query: "guide", scope: cwd, limit: 3 }),
    expect: /UNAVAILABLE: Docs search is not enabled/i,
  },
  {
    tool: "grep",
    params: cwd => ({ pattern: "run", syntax: "symbol", paths: cwd }),
    expect: /Exact search|UNAVAILABLE|src\/app\.ts|run/i,
  },
  {
    tool: "find",
    params: cwd => ({ pattern: "**/*.ts", scope: cwd, budget: 5000 }),
    expect: /Path search|src\/app\.ts/i,
  },
  {
    tool: "read",
    params: () => ({ path: "src/app.ts:1-2" }),
    expect: /\[src\/app\.ts#[0-9A-F]+\]/,
  },
];

for (const item of CASES) {
  test(`query-time ${item.tool} does not mutate repository state`, async () => {
    const pi = makePi();
    jeitoCodeweavePiExtension(pi);
    const cwd = await makeRepo();
    assert.deepEqual(artifactPaths(cwd), [], "fixture should start without navigation artifacts");

    const before = await snapshotTree(cwd);
    const text = await callTool(pi.tool(item.tool), item.params(cwd), cwd);
    assert.match(text, item.expect, `${item.tool} smoke assertion failed:\n${text}`);
    const after = await snapshotTree(cwd);

    const changes = diffSnapshots(before, after);
    assert.deepEqual(changes, [], `${item.tool} mutated query tree: ${changes.join(", ")}`);
    const artifacts = artifactPaths(cwd);
    assert.deepEqual(artifacts, [], `${item.tool} created forbidden navigation artifacts: ${artifacts.join(", ")}`);
  });
}

test("query-time clean-break tools reject legacy Semble selectors without launching commands", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await makeRepo("query-semantic-guard-");
  const text = await callTool(pi.tool("explore"), { query: "where is app configuration", scope: cwd, source: "semantic", detail: "diagnostic" }, cwd);
  assert.match(text, /INVALID CALL: explore[\s\S]*(?:obsolete|source|detail)/i);
});

async function withEnv(overrides, fn) {
  const old = {};
  for (const [key, value] of Object.entries(overrides)) {
    old[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await fn(); }
  finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
