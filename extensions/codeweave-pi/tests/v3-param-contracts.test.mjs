import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import jeitoCodeweavePiExtension from "../index.ts";

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

async function call(tool, params, cwd) {
  const result = await tool.execute(`test-${tool.name}`, params, undefined, undefined, { cwd });
  return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

function git(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
  return res.stdout;
}

test("find rejects removed scanner limit params and accepts budget", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-find-"));
  await writeFile(join(cwd, "a.ts"), "export const a = 1;\n");
  assert.match(await call(pi.tool("find"), { pattern: "a.ts", path: cwd, limit: 0 }, cwd), /INVALID CALL: find[\s\S]*(?:path|limit)/i);
  assert.match(await call(pi.tool("find"), { pattern: "a.ts", scope: cwd, budget: 0 }, cwd), /INVALID CALL: find[\s\S]*budget/i);
});

test("find and ls validate operation-specific enums and field combinations before native execution", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-find-ls-shapes-"));
  assert.match(await call(pi.tool("find"), { pattern: "x", patterns: ["y"] }, cwd), /INVALID CALL: find[\s\S]*exactly one/);
  assert.match(await call(pi.tool("find"), { pattern: "x", type: "FILEZ" }, cwd), /INVALID CALL: find[\s\S]*find type/);
  assert.match(await call(pi.tool("ls"), { path: cwd, view: "list", depth: 2 }, cwd), /INVALID CALL: ls[\s\S]*depth.*tree/);
  assert.match(await call(pi.tool("ls"), { path: cwd, view: "TREE", depth: "2" }, cwd), /Call normalization:[\s\S]*ls view[\s\S]*numeric string/i);
});

test("docs_search, ls, and read return typed invalid-call evidence before execution", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-contained-"));
  const file = join(cwd, "a.ts");
  await writeFile(file, "export const a = 1;\n");
  assert.match(await call(pi.tool("docs_search"), { query: "x", page: 0 }, cwd), /INVALID CALL: docs_search[\s\S]*nothing ran/i);
  assert.match(await call(pi.tool("ls"), { path: file }, cwd), /INVALID CALL: ls[\s\S]*directory[\s\S]*nothing ran/i);
  assert.match(await call(pi.tool("read"), {}, cwd), /INVALID CALL: read[\s\S]*nothing ran/i);
});

test("edit and write return typed malformed-call evidence before mutation", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-mutation-shapes-"));
  assert.match(await call(pi.tool("edit"), { input: "", legacy: true }, cwd), /INVALID CALL: edit[\s\S]*nothing ran/i);
  assert.match(await call(pi.tool("write"), { path: "a.ts", content: "x", overwrite: false }, cwd), /INVALID CALL: write[\s\S]*overwrite[\s\S]*nothing ran/i);
});

test("grep clean-break union returns actionable invalid-call evidence and validates matches controls", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-grep-"));
  const file = join(cwd, "g.ts");
  await writeFile(file, "const target = 1;\nconst target = 2;\n");
  for (const params of [
    { query: "target", kind: "content", scope: file },
    { pattern: "target", paths: file, output: "ranked", contextLines: 1 },
    { pattern: "target", paths: file, output: "matches", syntax: "symbol" },
    { cursor: "opaque", pattern: "target" },
    { pattern: "target", paths: file, output: "matches", contextLines: 11 },
  ]) assert.match(await call(pi.tool("grep"), params, cwd), /INVALID CALL: grep[\s\S]*(?:Nothing ran|nothing ran)/i);
  assert.match(await call(pi.tool("grep"), { pattern: "target", paths: [file, file], output: "ranked" }, cwd), /INVALID CALL: grep[\s\S]*multiple targets/);
});

test("grep explains regex-looking tokens after a literal zero", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-grep-literal-zero-"));
  const file = join(cwd, "g.ts");
  await writeFile(file, "const oldName = 1;\n");
  const text = await call(pi.tool("grep"), { pattern: "oldName|newName", paths: file, output: "matches", syntax: "literal" }, cwd);
  assert.match(text, /Literal-pattern guidance:[\s\S]*Resolved: literal[\s\S]*syntax:'regex'[\s\S]*do not repeat/i);
});

test("explore enforces clean-break schema and limit", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-explore-"));
  await writeFile(join(cwd, "README.md"), "# Demo\n");
  assert.match(await call(pi.tool("explore"), { query: "help me understand this repo", view: "code", scope: cwd, limit: 0 }, cwd), /INVALID CALL: explore[\s\S]*limit/i);
  assert.match(await call(pi.tool("explore"), { query: "help me understand this repo", view: "code", scope: cwd, limit: -1 }, cwd), /INVALID CALL: explore[\s\S]*limit/i);
  assert.match(await call(pi.tool("explore"), { query: "help me understand this repo", view: "code", path: cwd }, cwd), /INVALID CALL: explore[\s\S]*(?:obsolete|unknown field)/i);
  assert.match(await call(pi.tool("explore"), { query: "help me understand this repo", view: "code", scope: cwd, detail: "verbose" }, cwd), /INVALID CALL: explore[\s\S]*(?:obsolete|unknown field)/i);
  const unavailable = await call(pi.tool("explore"), { query: "help me understand this repo", view: "map", scope: cwd, limit: 1 }, cwd);
  assert.match(unavailable, /UNAVAILABLE: graph map unavailable/);
});

test("trace enforces strict single and batch contracts", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-trace-"));
  await writeFile(join(cwd, "a.ts"), "export function target() {}\n");
  const invalid = [
    { target: "target", relation: "callers", scope: cwd, limit: 0 },
    { target: "target", relation: "callers", scope: cwd, limit: -1 },
    { target: "target", relation: "usages", scope: cwd },
    { target: "target", relation: "callers", path: cwd },
    { target: "target", targets: ["a", "b"], relation: "callers", scope: cwd },
    { targets: ["a", "b"], relation: "path", to: "Node", scope: cwd },
    { targets: ["a", "b"], relation: "callers", scope: cwd, page: 2 },
    { targets: ["a", "b"], relation: "callers", scope: cwd, limit: 16 },
    { targets: ["target"], relation: "callers", scope: cwd },
    { targets: ["target", "target"], relation: "callers", scope: cwd },
    { targets: "target", relation: "callers", scope: cwd },
  ];
  for (const params of invalid) assert.match(await call(pi.tool("trace"), params, cwd), /INVALID CALL: trace/);
  assert.match(pi.tool("trace").description, /one wiring question/);
  assert.match(pi.tool("trace").parameters.properties.relation.description, /callers\/callees\/tests for symbols[\s\S]*imports\/importers for files[\s\S]*path\/explain for graph nodes/);
});


test("diff rejects invalid view/legacy selectors and validates numeric params", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-diff-"));
  await writeFile(join(cwd, "a.txt"), "one\ntwo\n");
  await writeFile(join(cwd, "b.txt"), "one\nthree\n");
  for (const params of [
    { a: "a.txt", b: "b.txt", expand: -1, view: "patch" },
    { a: "a.txt", b: "b.txt", budget: 0, view: "patch" },
    { a: "a.txt", b: "b.txt", budget: -10, view: "patch" },
    { a: "a.txt", b: "b.txt", view: "native" },
    { a: "a.txt", b: "b.txt", backend: "tilth", view: "patch" },
    { a: "a.txt", b: "b.txt", detail: "verbose", view: "patch" },
    { a: "a.txt", b: "b.txt", cwd, view: "patch" },
    { a: "a.txt", b: "b.txt", search: "target", view: "patch" },
    { root: cwd, view: "structure", expand: 1 },
  ]) assert.match(await call(pi.tool("diff"), params, cwd), /INVALID CALL: diff[\s\S]*nothing ran/i);
  // valid expand/budget still work
  const ok = await call(pi.tool("diff"), { a: "a.txt", b: "b.txt", expand: 1, budget: 5000, view: "patch" }, cwd);
  assert.match(ok, /three|two/);
});

test("diff schema documents source separation and parameter combination limits", () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const tool = pi.tool("diff");
  const properties = tool.parameters.properties;
  assert.match(tool.description, /git diff without leaving the session/);
  assert.match(properties.root.description, /relative a\/b files/);
  assert.match(properties.source.description, /unstaged tracked changes, 'staged' = index-only/);
  assert.match(properties.source.description, /index-only/);
  assert.match(properties.scope.description, /deleted paths accepted/);
  assert.match(properties.a.description, /Requires b/);
  assert.match(properties.search.description, /structure view only/i);
  assert.match(properties.expand.description, /a\/b summary\/patch only/);
  assert.match(properties.budget.description, /means incomplete/);
});

test("diff source:'staged' uses cached/staged diff, not a raw positional ref", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-staged-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  // commit a baseline of two tracked files
  await writeFile(join(cwd, "README.md"), "r1\n");
  await writeFile(join(cwd, "app.ts"), "a1\n");
  git(cwd, "add", "README.md", "app.ts");
  git(cwd, "commit", "-q", "-m", "base");
  // stage a change to README; leave an unstaged change on app.ts
  await writeFile(join(cwd, "README.md"), "r1\npineapple\n");
  git(cwd, "add", "README.md");
  await writeFile(join(cwd, "app.ts"), "a1\ndurian\n");

  const staged = await call(pi.tool("diff"), { source: "staged", root: cwd, view: "patch" }, cwd);
  assert.match(staged, /Read-only staged\/index patch/, `staged diff should explain it is read-only:\n${staged}`);
  assert.match(staged, /pineapple/, `staged diff must show the staged README change; got:\n${staged}`);
  assert.doesNotMatch(staged, /durian/, `staged diff must not leak unstaged working-tree changes; got:\n${staged}`);

  const summary = await call(pi.tool("diff"), { source: "staged", root: cwd }, cwd);
  assert.match(summary, /Read-only staged\/index summary/);
  assert.match(summary, /Changed files \(1\)/);
  assert.match(summary, /README\.md/);

  const working = await call(pi.tool("diff"), { root: cwd, view: "patch" }, cwd);
  assert.match(working, /Read-only unstaged working-tree patch/, `working diff should explain it is read-only:\n${working}`);
  assert.match(working, /durian/, `default diff must show the unstaged working-tree change; got:\n${working}`);
  assert.doesNotMatch(working, /pineapple/, `default diff must not show fully-staged changes; got:\n${working}`);
});

test("diff wraps unknown sources and missing scopes with recovery guidance", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-diff-recovery-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  await writeFile(join(cwd, "README.md"), "base\n");
  git(cwd, "add", "README.md");
  git(cwd, "commit", "-q", "-m", "base");

  const badSource = await call(pi.tool("diff"), { root: cwd, source: "banana", view: "patch" }, cwd);
  assert.match(badSource, /ERROR: unknown diff source\/ref/);
  assert.match(badSource, /Safe retry:/);
  assert.doesNotMatch(badSource, /fatal: ambiguous argument/);

  const missingScope = await call(pi.tool("diff"), { root: cwd, scope: "no-such-file", view: "patch" }, cwd);
  assert.match(missingScope, /ERROR: diff scope not found/);
  assert.match(missingScope, /Stop condition:/);
  assert.doesNotMatch(missingScope, /^No changes\./);
});

test("diff rejects option-like and invalid sources in every repository view", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-diff-source-"));
  git(cwd, "init", "-q"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test");
  await writeFile(join(cwd, "README.md"), "base\n"); git(cwd, "add", "."); git(cwd, "commit", "-q", "-m", "base"); await writeFile(join(cwd, "README.md"), "changed\n");
  for (const view of ["patch", "summary", "structure"]) {
    const out = await call(pi.tool("diff"), { root: cwd, source: "--stat", view }, cwd);
    assert.match(out, /ERROR:|unknown diff source|git diff failed/i, `${view} must reject option-like sources:\n${out}`);
    assert.doesNotMatch(out, /^No changes\.$/m);
  }
});

test("diff budget truncation includes an explicit marker", async () => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await mkdtemp(join(tmpdir(), "param-diff-truncate-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  await writeFile(join(cwd, "README.md"), "base\n");
  git(cwd, "add", "README.md");
  git(cwd, "commit", "-q", "-m", "base");
  await writeFile(join(cwd, "README.md"), `${"changed line\n".repeat(80)}`);

  const out = await call(pi.tool("diff"), { root: cwd, budget: 200, view: "patch" }, cwd);
  assert.match(out, /Output truncated at 200 chars/);
  assert.match(out, /larger budget or narrower scope/);
});
