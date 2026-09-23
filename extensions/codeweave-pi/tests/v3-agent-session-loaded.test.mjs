import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAgentSession } from "/Users/example/.local/share/mise/installs/node/24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { freshenDocs } from "../scripts/navigation-freshen.mjs";

const TAG_RE = /^\[(.+)#([0-9A-F]{4,})\]/m;
const ANSI_RE = /\x1b\[[0-9;]*m/;
const PROJECT_NAV = fileURLToPath(new URL("../index.ts", import.meta.url));

function textOf(result) {
  return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

function parseTag(text) {
  const match = TAG_RE.exec(text);
  assert.ok(match, `missing [path#HASH] in:\n${text}`);
  return { header: match[0], tag: match[2] };
}

function minimalCtx(cwd) {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    ui: { notify() {} },
  };
}

async function executable(file, content) {
  await writeFile(file, content);
  await chmod(file, 0o755);
  return file;
}




async function call(session, cwd, name, params) {
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `missing loaded tool ${name}`);
  const result = await tool.execute(`agent-session-${name}`, params, undefined, undefined, minimalCtx(cwd));
  const text = textOf(result);
  assert.doesNotMatch(text, ANSI_RE, `${name} leaked ANSI`);
  return text;
}

async function callDetailed(session, cwd, name, params) {
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `missing loaded tool ${name}`);
  const result = await tool.execute(`agent-session-${name}`, params, undefined, undefined, minimalCtx(cwd));
  const text = textOf(result);
  assert.doesNotMatch(text, ANSI_RE, `${name} leaked ANSI`);
  return { result, text };
}

function assertLoadedSchemas(session) {
  const infos = new Map(session.getAllTools().map(tool => [tool.name, tool]));
  for (const name of ["read", "edit", "write", "lsp_validate"]) {
    assert.equal(infos.get(name)?.sourceInfo?.path, PROJECT_NAV, `${name} should come from jeito-codeweave-pi`);
  }
  const read = session.getToolDefinition("read").parameters;
  const edit = session.getToolDefinition("edit").parameters;
  const write = session.getToolDefinition("write").parameters;
  assert.deepEqual(Object.keys(read.properties).sort(), ["path", "paths"]);
  assert.deepEqual(Object.keys(edit.properties).sort(), ["input"]);
  assert.deepEqual(Object.keys(write.properties).sort(), ["content", "overwrite", "path"]);
  const lsp = session.getToolDefinition("lsp_validate").parameters;
  assert.deepEqual(Object.keys(lsp.properties).sort(), ["includeWarnings", "limit", "paths", "root"]);
  const schemas = { read: [read.properties], edit: [edit.properties], write: [write.properties] };
  for (const [name, variants] of Object.entries(schemas)) {
    for (const properties of variants) for (const forbidden of ["range", "budget", "changes", "files", "section", "sections", "oldText", "newText", "intent", "offset", "limit", "heading"]) {
      assert.equal(Object.hasOwn(properties, forbidden), false, `${name} legacy schema field leaked: ${forbidden}`);
    }
  }
}

async function runGates(session, label) {
  assertLoadedSchemas(session);
  const cwd = await mkdtemp(join(tmpdir(), `pi-nav-v3-agent-${label}-`));
  const file = join(cwd, "smoke.ts");

  const writeOut = await call(session, cwd, "write", { path: file, content: "alpha\nbeta\ngamma\n" });
  const old = parseTag(writeOut);

  const readOut = await call(session, cwd, "read", { path: `${file}:1-2` });
  assert.match(readOut, TAG_RE);
  assert.match(readOut, /1:alpha\n2:beta/);

  const editOut = await call(session, cwd, "edit", { input: `${old.header}\nREPLACE 2:\n+BETA` });
  const fresh = parseTag(editOut);
  assert.notEqual(fresh.tag, old.tag);
  assert.equal(await readFile(file, "utf8"), "alpha\nBETA\ngamma\n");

  const stale = await call(session, cwd, "edit", { input: `${old.header}\nREPLACE 2:\n+SECOND` });
  assert.match(stale, /No changes landed[\s\S]*stale source could not be remapped safely/);
  await assert.rejects(
    session.getToolDefinition("write").execute("overwrite-without-flag", { path: file, content: "oops\n" }, undefined, undefined, minimalCtx(cwd)),
    /Write refused:[\s\S]*already exists[\s\S]*overwrite:true/,
  );
  assert.equal(await readFile(file, "utf8"), "alpha\nBETA\ngamma\n");

  const multiOut = await call(session, cwd, "edit", { input: `${fresh.header}\nREPLACE 1:\n+ALPHA\n\nINSERT AFTER 3:\n+delta` });
  const latest = parseTag(multiOut);
  assert.equal(await readFile(file, "utf8"), "ALPHA\nBETA\ngamma\ndelta\n");

  const overlap = await call(session, cwd, "edit", { input: `${latest.header}\nREPLACE 1..2:\n+X\n\nREPLACE 2..3:\n+Y` });
  assert.match(overlap, /overlapping operations|No changes landed/);
  assert.equal(await readFile(file, "utf8"), "ALPHA\nBETA\ngamma\ndelta\n");

  const raw = await call(session, cwd, "read", { path: `${file}:1-2:raw` });
  assert.match(raw, /\[.*smoke\.ts · raw · no edit hash\]/);
  assert.match(raw, /ALPHA\nBETA/);
  assert.doesNotMatch(raw, TAG_RE);

  const largeCode = join(cwd, "large.ts");
  await writeFile(largeCode, ["import x from 'x'", "", "export function target() {", "  return 1", "}", ...Array.from({ length: 140 }, (_, i) => `// filler ${i}`)].join("\n") + "\n");
  const codeSummary = await call(session, cwd, "read", { path: largeCode });
  if (/smart read unavailable/.test(codeSummary)) assert.doesNotMatch(codeSummary, TAG_RE);
  else {
    assert.match(codeSummary, /Structural source summary/);
    assert.match(codeSummary, TAG_RE);
    assert.match(codeSummary, /^3:export function target/m);
  }

  const docs = join(cwd, "README.md");
  await writeFile(docs, ["# Intro", "```", "# Fake", "```", "## Install", ...Array.from({ length: 140 }, (_, i) => `line ${i}`)].join("\n") + "\n");
  const docsSummary = await call(session, cwd, "read", { path: docs });
  if (/smart read unavailable/.test(docsSummary)) assert.doesNotMatch(docsSummary, TAG_RE);
  else {
    assert.match(docsSummary, /Structural source summary/);
    assert.match(docsSummary, TAG_RE);
    assert.match(docsSummary, /^1:# Intro/m);
  }

  const dir = join(cwd, "src");
  await mkdir(dir);
  await writeFile(join(dir, "index.ts"), "export const value = 1\n");
  await assert.rejects(
    call(session, cwd, "read", { path: dir }),
    /is a directory\. Use ls for directory listing\./,
  );

  const plain = join(cwd, "plain.txt");
  const plainWrite = await call(session, cwd, "write", { path: plain, content: "one\n" });
  const plainTag = parseTag(plainWrite);
  const standaloneLsp = await call(session, cwd, "lsp_validate", { paths: [plain] });
  assert.match(standaloneLsp, /Unsupported: .*plain\.txt/);
  const inlineLsp = await call(session, cwd, "edit", { input: `${plainTag.header}\nREPLACE 1:\n+ONE\nCHECK LSP` });
  assert.match(inlineLsp, /Unsupported: .*plain\.txt/);
  assert.equal(await readFile(plain, "utf8"), "ONE\n");
  const malformed = await call(session, cwd, "edit", { input: `${latest.header}\nREPLACE 2:\n-BETA` });
  assert.match(malformed, /'-' rows are not valid|No changes landed/);
}

test("actual AgentSession loaded-tool gates after fresh start and reloads", async () => {
  const { session } = await createAgentSession({
    cwd: await mkdtemp(join(tmpdir(), "pi-nav-v3-session-cwd-")),
    agentDir: "/Users/example/.pi/agent",
    noTools: "builtin",
    tools: ["read", "edit", "write", "lsp_validate"],
  });
  try {
    await runGates(session, "fresh");
    await session.reload();
    await runGates(session, "reload");
    for (let i = 0; i < 3; i++) {
      await session.reload();
      await runGates(session, `repeat-${i}`);
    }
  } finally {
    session.dispose();
  }
});

test("fresh AgentSession loads docs_search without the legacy docs action tool", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-nav-v3-session-docs-search-"));
  const { session } = await createAgentSession({ cwd, agentDir: "/Users/example/.pi/agent", noTools: "builtin", tools: ["docs_search"] });
  try {
    const tool = session.getToolDefinition("docs_search");
    assert.equal(session.getAllTools().find(item => item.name === "docs_search")?.sourceInfo?.path, PROJECT_NAV);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["glob", "limit", "page", "path", "query", "scope"]);
    assert.equal(session.getAllTools().some(item => item.name === "docs"), false);
    const text = await call(session, cwd, "docs_search", { query: "missing", scope: cwd });
    assert.match(text, /UNAVAILABLE: Docs search is not enabled/);
  } finally {
    session.dispose();
  }
});

test("fresh loaded docs_search reads and refreshes one edited QMD section", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-nav-v3-session-docs-flow-"));
  await writeFile(join(cwd, "README.md"), "# Guide\n\noriginal lifecycle marker\n");
  const prepared = await freshenDocs(cwd, { env: { PATH: process.env.PATH ?? "" }, useEmbeddings: false });
  assert.equal(prepared.status, "success", JSON.stringify(prepared));

  const priorNoSetup = process.env.PI_NAV_NO_AUTO_SETUP;
  process.env.PI_NAV_NO_AUTO_SETUP = "1";
  const { session } = await createAgentSession({ cwd, agentDir: "/Users/example/.pi/agent", noTools: "builtin", tools: ["docs_search", "read", "edit"] });
  if (priorNoSetup === undefined) delete process.env.PI_NAV_NO_AUTO_SETUP; else process.env.PI_NAV_NO_AUTO_SETUP = priorNoSetup;
  try {
    const found = await call(session, cwd, "docs_search", { query: "original lifecycle marker", scope: cwd });
    const selector = /1\. (README\.md:[^\s·]+)/.exec(found)?.[1];
    assert.ok(selector, found);
    const current = await call(session, cwd, "read", { path: selector });
    const tag = parseTag(current);
    assert.match(current, /3:original lifecycle marker/);
    await call(session, cwd, "edit", { input: `${tag.header}\nREPLACE 3:\n+updated lifecycle marker` });
    let updated = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      updated = await call(session, cwd, "docs_search", { query: "updated lifecycle marker", scope: cwd });
      if (/README\.md:/.test(updated)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.match(updated, /README\.md:/);
    assert.match(updated, /updated lifecycle marker/i);
    const state = JSON.parse(await readFile(join(cwd, ".pi", "navigation", "state.json"), "utf8"));
    assert.equal(state.indexes.docs.generationId, state.indexes.docs.qmd.generation);
  } finally {
    session.dispose();
  }
});

test("actual AgentSession loaded explore uses clean-break graph routing after reload", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-nav-v3-session-explore-"));
  await mkdir(join(cwd, "bin"), { recursive: true });
  await mkdir(join(cwd, "src", "tools"), { recursive: true });
  await mkdir(join(cwd, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await mkdir(join(cwd, ".pi", "navigation"), { recursive: true });
  await writeFile(join(cwd, "src", "tools", "grep.ts"), "export function registerGrepTool() {}\n");
  await writeFile(join(cwd, "index.ts"), "import { registerGrepTool } from './src/tools/grep.js';\nexport default function extension(pi) { registerGrepTool(pi); }\n");
  await writeFile(join(cwd, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), JSON.stringify({ directed: true, multigraph: false, graph: {}, nodes: [{ id: "registerGrepTool", label: "registerGrepTool", type: "function", source_file: "src/tools/grep.ts", source_location: "L1" }, { id: "projectNavigation", label: "projectNavigation", type: "module", source_file: "index.ts", source_location: "L1" }], links: [{ source: "projectNavigation", target: "registerGrepTool", relation: "calls" }] }));
  const graphify = await executable(join(cwd, "bin", "graphify"), `#!/usr/bin/env node
if (process.env.GRAPHIFY_QUERY_LOG_DISABLE !== '1') { console.error('missing query log disable'); process.exit(3); }
const query = process.argv[3] ?? process.argv[2];
if (/grep|tool_search|search/.test(query)) console.log('NODE registerGrepTool [src=src/tools/grep.ts loc=L1]\\nNODE projectNavigation [src=index.ts loc=L1]');
else console.log('No matching nodes found.');
`);
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({
    preparedIntelligence: { maxAgeMs: 86_400_000 },
    graph: { enabled: true, backend: "Graphify", command: graphify, root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" },
  }, null, 2));
  await writeFile(join(cwd, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { graph: { root: ".", graphPath: ".pi/navigation/graphify/graphify-out/graph.json", updatedAt: new Date().toISOString() } } }, null, 2));

  const { session } = await createAgentSession({
    cwd,
    agentDir: "/Users/example/.pi/agent",
    noTools: "builtin",
    tools: ["explore"],
  });
  try {
    const schemaKeys = Object.keys(session.getToolDefinition("explore").parameters.properties).sort();
    assert.deepEqual(schemaKeys, ["anchor", "depth", "kind", "limit", "operation", "page", "query", "scope", "view"]);
    for (const label of ["fresh", "reload"]) {
      if (label === "reload") await session.reload();
      const invalid = await session.getToolDefinition("explore").execute("legacy", { query: "where is grep implemented", path: cwd, detail: "diagnostic" }, undefined, undefined, minimalCtx(cwd));
      const invalidText = typeof invalid === "string" ? invalid : (invalid?.content ?? []).map((c) => c?.text ?? "").join("\n");
      assert.match(invalidText, /obsolete|path|detail|rejected/i, `${label}: legacy fields should be rejected`);
      const text = await call(session, cwd, "explore", { query: "where is grep implemented", view: "map", scope: cwd, limit: 5 });
      assert.match(text, /Graph map/, `${label}:\n${text}`);
      assert.match(text, /NODE registerGrepTool \[src=src\/tools\/grep\.ts loc=L1/, `${label}:\n${text}`);
      assert.doesNotMatch(text, /GRAPHIFY_QUERY_LOG_DISABLE|backend/i, `${label}: normal output should not expose debug plumbing:\n${text}`);
      assert.doesNotMatch(text, /files used|grep fallback|find fallback/i, `${label}: no lexical fallback should run:\n${text}`);
    }
  } finally {
    session.dispose();
  }
});

test("fresh loaded AgentSession executes the grep matches contract and custom filter policy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-nav-v3-loaded-grep-"));
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(join(cwd, ".pi", "navigation"), { recursive: true });
  await writeFile(join(cwd, ".gitignore"), "git-only.txt\n");
  await writeFile(join(cwd, ".pi", "navigation", "ignore"), "custom-skip.txt\n");
  await writeFile(join(cwd, "many.txt"), Array.from({ length: 200 }, (_, index) => `hello ${index} goodbye`).join("\n") + "\n");
  await writeFile(join(cwd, "git-only.txt"), "hello|goodbye\n");
  await writeFile(join(cwd, "custom-skip.txt"), "hello custom goodbye\n");
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0x68, 0x69, 0x00, 0x78]));
  await symlink("git-only.txt", join(cwd, "git-alias.txt"));
  await writeFile(join(cwd, ".pi", "navigation", "private.txt"), "hiddenQueryState\n");

  const { session } = await createAgentSession({ cwd, agentDir: "/Users/example/.pi/agent", noTools: "builtin", tools: ["grep", "ls", "find"] });
  try {
    assert.equal(session.getAllTools().find(tool => tool.name === "grep")?.sourceInfo?.path, PROJECT_NAV);
    const ranked = await callDetailed(session, cwd, "grep", { pattern: "hello" });
    assert.match(ranked.text, /Search:/);

    const first = await callDetailed(session, cwd, "grep", {
      pattern: "hello|goodbye",
      syntax: "auto",
      output: "matches",
      paths: ["many.txt", "git-only.txt", "binary.dat", "missing.txt"],
      contextLines: 0,
    });
    assert.match(first.text, /Resolved: auto→regex/);
    assert.match(first.text, /git-only\.txt.*ignore bypass/s);
    assert.match(first.text, /binary_nul/);
    assert.match(first.text, /path not found/);
    assert.match(first.text, /\[many\.txt#[0-9A-F]{8}\]/);
    assert.equal(first.result.details.native.data.groups[0].matches[0].spans.length, 2);
    const cursor = first.result.details.native.data.cursor;
    assert.equal(typeof cursor, "string");

    const second = await callDetailed(session, cwd, "grep", { cursor, contextLines: 1 });
    const repeated = await callDetailed(session, cwd, "grep", { cursor, contextLines: 1 });
    assert.equal(second.text, repeated.text);
    const firstLines = new Set(first.result.details.native.data.groups.flatMap(group => group.matches.map(match => `${match.path}:${match.line}`)));
    const secondLines = second.result.details.native.data.groups.flatMap(group => group.matches.map(match => `${match.path}:${match.line}`));
    assert.ok(secondLines.every(line => !firstLines.has(line)), "loaded continuation repeated a match identity");
    await writeFile(join(cwd, "many.txt"), "changed source\n");
    const stale = await callDetailed(session, cwd, "grep", { cursor });
    assert.match(stale.text, /source changed|stale/i);

    const literal = await callDetailed(session, cwd, "grep", { pattern: "hello|goodbye", syntax: "literal", output: "matches", paths: "git-only.txt" });
    assert.match(literal.text, /1 occurrence/);
    const aliases = await callDetailed(session, cwd, "grep", {
      pattern: "hello|goodbye",
      syntax: "literal",
      output: "matches",
      paths: ["git-alias.txt", "git-only.txt"],
    });
    assert.deepEqual(
      aliases.result.details.native.data.targets.map(target => basename(target.requested)),
      ["git-alias.txt", "git-only.txt"],
    );
    assert.match(aliases.text, /Target: .*git-alias\.txt · Searched/);
    assert.match(aliases.text, /Target: .*git-only\.txt · Searched/);
    assert.match(aliases.result.details.native.data.executionDiagnostics.join("\n"), /1 streamed files/);
    const filtered = await callDetailed(session, cwd, "grep", { pattern: "hello", syntax: "literal", output: "matches", visibility: "project" });
    assert.match(filtered.text, /git-only\.txt/);
    assert.doesNotMatch(filtered.text, /custom-skip\.txt/);
    assert.match(filtered.text, /\.pi\/navigation\/ignore active/);
    assert.equal(filtered.result.details.native.data.filter[0].source, "custom_navigation_ignore");
    const queryState = await callDetailed(session, cwd, "grep", { pattern: "hiddenQueryState", syntax: "literal", output: "matches", visibility: "all", glob: "**/*.txt" });
    assert.match(queryState.text, /0 matches/);
    assert.match(queryState.text, /Coverage: complete/);

    const listed = await callDetailed(session, cwd, "ls", { path: ".", visibility: "project" });
    assert.match(listed.text, /many\.txt/);
    const found = await callDetailed(session, cwd, "find", { pattern: "git-only.txt", visibility: "all" });
    assert.match(found.text, /git-only\.txt/);
  } finally {
    session.dispose();
  }
});

test("fresh loaded edit scenarios preserve partial landing, retry continuation, syntax states, and multi-file truth", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-nav-v3-loaded-edit-closure-"));
  const { session } = await createAgentSession({ cwd, agentDir: "/Users/example/.pi/agent", noTools: "builtin", tools: ["read", "edit", "write", "lsp_validate"] });
  try {
    const partialPath = join(cwd, "partial.txt");
    await writeFile(partialPath, "one\ntwo\nthree\n");
    const partialRead = await call(session, cwd, "read", { path: `${partialPath}:1-1,3-3` });
    const partial = await call(session, cwd, "edit", { input: `${parseTag(partialRead).header}\nREPLACE 1:\n+ONE\nREPLACE 2:\n+TWO\nREPLACE 3:\n+THREE` });
    assert.match(partial, /Needs attention/);
    assert.equal(await readFile(partialPath, "utf8"), "ONE\ntwo\nTHREE\n");
    const retried = await call(session, cwd, "edit", { input: "RETRY" });
    assert.equal(await readFile(partialPath, "utf8"), "ONE\nTWO\nTHREE\n");
    const follow = await call(session, cwd, "edit", { input: `${parseTag(retried).header}\nREPLACE 2:\n+TWO AGAIN` });
    assert.match(follow, /Edited/);
    assert.equal(await readFile(partialPath, "utf8"), "ONE\nTWO AGAIN\nTHREE\n");

    const good = join(cwd, "good.txt");
    const bad = join(cwd, "bad.txt");
    await writeFile(good, "good\n");
    await writeFile(bad, "bad\n");
    const goodRead = await call(session, cwd, "read", { path: `${good}:1` });
    const multi = await call(session, cwd, "edit", { input: `${parseTag(goodRead).header}\nREPLACE 1:\n+GOOD\n[${bad}#DEADBEEF]\nREPLACE 1:\n+BAD` });
    assert.match(multi, /Needs attention/);
    assert.equal(await readFile(good, "utf8"), "GOOD\n");
    assert.equal(await readFile(bad, "utf8"), "bad\n");

    const syntaxPath = join(cwd, "syntax.ts");
    const syntaxWrite = await call(session, cwd, "write", { path: syntaxPath, content: "export const value = 1;\n" });
    const syntax = await call(session, cwd, "edit", { input: `${parseTag(syntaxWrite).header}\nREPLACE 1:\n+export const value = ;` });
    assert.match(syntax, /Syntax check found/);
    assert.equal(await readFile(syntaxPath, "utf8"), "export const value = ;\n");

    const largePath = join(cwd, "over-budget.ts");
    const large = await call(session, cwd, "write", { path: largePath, content: `// ${"x".repeat(256 * 1024)}\n` });
    assert.match(large, /exceeds the bounded 262144-byte parse budget/);
    assert.ok((await readFile(largePath)).byteLength > 256 * 1024);
  } finally {
    session.dispose();
  }
});

test("opt-in loaded lsp_validate and CHECK LSP use the current primary server", { skip: process.env.PI_NAV_RUN_LIVE_LSP !== "1" }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-nav-v3-live-lsp-"));
  await writeFile(join(cwd, "package.json"), "{}\n");
  const clean = join(cwd, "clean.ts");
  const broken = join(cwd, "broken.ts");
  await writeFile(clean, "export const value: string = 'ok';\n");
  await writeFile(broken, "export const value: string = 1;\n");
  const { session } = await createAgentSession({ cwd, agentDir: "/Users/example/.pi/agent", noTools: "builtin", tools: ["read", "edit", "lsp_validate"] });
  try {
    const standalone = await call(session, cwd, "lsp_validate", { paths: [clean, broken] });
    assert.match(standalone, /(?:Clean|Unconfirmed): .*clean\.ts/);
    assert.match(standalone, /Diagnostics: .*broken\.ts/);
    const read = await call(session, cwd, "read", { path: `${clean}:1` });
    const header = parseTag(read).header;
    const inline = await call(session, cwd, "edit", { input: `${header}\nREPLACE 1:\n+export const value: string = 1;\nCHECK LSP` });
    assert.match(inline, /Diagnostics: .*clean\.ts/);
    await session.reload();
    const afterReload = await call(session, cwd, "lsp_validate", { paths: [broken] });
    assert.match(afterReload, /Diagnostics: .*broken\.ts/);
  } finally {
    session.dispose();
  }
});
