import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { callTool, makePi, registerCleanPi, tempProject } from "./_clean-navigation-helper.mjs";
import jeitoCodeweavePiExtension from "../index.ts";

// Tolerance contract model (reconciled against the registered public schemas):
//
//  * A field the schema does not declare is REFUSED with typed evidence naming
//    the field, never silently dropped.
//  * A declared field carrying an unusable value is REFUSED with a typed reason;
//    malformed input is never rewritten into a different request.
//  * Read-style selectors (`:10-20`, `::symbol`) are read-only syntax. Tools that
//    do not accept them treat the literal string as a path and fail closed with
//    the exact path — they never silently strip it and search something else.
//  * A refusal states that nothing ran, and no refusal leaks an internal
//    identifier or a stack trace.
//  * Only genuine shape normalization survives (for example a scalar where a
//    one-item array is accepted), and it is reported as a normalization note.

const REFUSED = /INVALID CALL|ERROR:/;
const NO_EXECUTION = /nothing ran|Retrieval was not attempted|No query-time setup|No scanner, command, PATH, build, or navigation fallback was used|No navigation backend was run/;
const NO_INTERNAL_LEAK = /is not a function|Cannot read propert|TypeError|undefined is not|at Object\.|\.ts:\d+:\d+/;

async function project(prefix, files = {}) {
  const cwd = await tempProject(prefix);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, relative)), { recursive: true });
    await writeFile(join(cwd, relative), content);
  }
  return cwd;
}

function assertTypedRefusal(text, { fields = [], reason } = {}) {
  assert.match(text, REFUSED);
  assert.match(text, NO_EXECUTION, text);
  assert.doesNotMatch(text, NO_INTERNAL_LEAK, text);
  for (const field of fields) assert.match(text, new RegExp(`obsolete/unknown field\\(s\\): [^\\n]*\\b${field}\\b`), text);
  if (reason) assert.match(text, reason, text);
}

// ---------------------------------------------------------------------------
// grep: continuation, ranked constraints, and read-only selector syntax
// ---------------------------------------------------------------------------

test("grep refuses initial search fields beside a cursor instead of silently dropping them", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-grep-cont-", { "a.ts": "target\n" });
  // The cursor owns continuation; initial search fields are an unsafe intent mix.
  // The guard reports whichever initial fields are present, never a dispatched search.
  const withOutput = await callTool(pi, cwd, "grep", { cursor: "grep-opaque", pattern: "target", paths: cwd, output: "matches", syntax: "literal" });
  assertTypedRefusal(withOutput, { fields: ["output"] });
  assert.match(withOutput, /continuation: \{cursor:'grep-…'\}/);
  const withoutOutput = await callTool(pi, cwd, "grep", { cursor: "grep-opaque", pattern: "target", paths: cwd, syntax: "literal" });
  assertTypedRefusal(withoutOutput, { fields: ["pattern", "paths", "syntax"] });
  const onlyCursor = await callTool(pi, cwd, "grep", { cursor: "grep-opaque", contextLines: 2 });
  assert.match(onlyCursor, /cursor is unknown, expired, or evicted/);
  assert.match(onlyCursor, /No scanner, command, PATH, build, or navigation fallback was used/);
});

test("grep rejects contextLines on ranked as a hard error", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-grep-ctx-", { "a.ts": "target\n" });
  const out = await callTool(pi, cwd, "grep", { pattern: "target", paths: cwd, output: "ranked", contextLines: 2 });
  assertTypedRefusal(out, { reason: /contextLines is valid only with output:'matches'/ });
});

test("grep ranked rejects multiple locations naming the accepted one-path shape", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-grep-multi-", { "a.ts": "target\n", "b.md": "target\n" });
  const out = await callTool(pi, cwd, "grep", { pattern: "target", paths: [join(cwd, "a.ts"), join(cwd, "b.md")], output: "ranked" });
  assertTypedRefusal(out, { reason: /output:'ranked' accepts one path, but multiple targets were supplied/ });
});

test("grep treats read-style selectors in paths as literal paths and fails closed with the exact path", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-grep-selectors-", { "a.ts": "target\n", "sub/a.ts": "needle\n", "data:2024.ts": "needle\n" });
  // A colon inside a filename is part of the path, not a selector: the file is searched.
  const kept = await callTool(pi, cwd, "grep", { pattern: "needle", paths: join(cwd, "data:2024.ts"), syntax: "literal" });
  assert.match(kept, /needle/);
  assert.match(kept, /data:2024\.ts/);
  assert.doesNotMatch(kept, /INVALID CALL/);
  // A read selector is not rewritten away: the request fails closed on the literal path.
  for (const selector of [":1-3", "::target"]) {
    const refused = await callTool(pi, cwd, "grep", { pattern: "needle", paths: `${join(cwd, "sub", "a.ts")}${selector}`, syntax: "literal" });
    assert.match(refused, /ERROR:/, refused);
    assert.ok(refused.includes(`a.ts${selector}`), `the exact refused path must be named: ${refused}`);
    assert.match(refused, /No scanner, command, PATH, build, or navigation fallback was used/);
  }
});

test("grep refuses include, folder and scope with the unknown-field receipt naming them", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-grep-aliases-", { "a.ts": "target\n" });
  assertTypedRefusal(await callTool(pi, cwd, "grep", { pattern: "target", paths: cwd, include: "*.md" }), { fields: ["include"] });
  assertTypedRefusal(await callTool(pi, cwd, "grep", { pattern: "target", folder: cwd }), { fields: ["folder"] });
  assertTypedRefusal(await callTool(pi, cwd, "grep", { pattern: "target", scope: cwd }), { fields: ["scope"] });
});

test("grep rejects a removed output value with the accepted list, and a disagreeing query/pattern", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-grep-output-", { "a.ts": "target\n" });
  const removed = await callTool(pi, cwd, "grep", { pattern: "target", paths: cwd, output: "match" });
  assertTypedRefusal(removed, { reason: /output must be one of: ranked, matches/ });
  // pattern and query are both declared; when they disagree the intent is ambiguous.
  const ambiguous = await callTool(pi, cwd, "grep", { pattern: "needleInOne", query: "needleInTwo" });
  assertTypedRefusal(ambiguous, { reason: /pattern and query disagree; supply the intended question once/ });
});

test("grep accepts the declared audit and single-path ranked shapes", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-grep-valid-", { "one/a.ts": "needleInOne\n", "two/b.ts": "needleInTwo\n" });
  const audit = await callTool(pi, cwd, "grep", { pattern: "needle", paths: [join(cwd, "one"), join(cwd, "two")], output: "matches" });
  assert.match(audit, /needleInOne/);
  assert.match(audit, /needleInTwo/);
  assert.doesNotMatch(audit, /INVALID CALL/);
  const ranked = await callTool(pi, cwd, "grep", { pattern: "needleInOne", paths: join(cwd, "one"), output: "ranked", syntax: "literal" });
  assert.match(ranked, /needleInOne/);
  assert.doesNotMatch(ranked, /needleInTwo/, "a single-path ranked query stays inside that path");
});

// ---------------------------------------------------------------------------
// find: pattern is one string, patterns is the supported list
// ---------------------------------------------------------------------------

test("find accepts the declared patterns list and refuses a list in the scalar pattern field", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-find-list-", { "a.ts": "x\n", "b.md": "x\n" });
  const list = await callTool(pi, cwd, "find", { patterns: ["*.ts", "*.md"] });
  assert.match(list, /a\.ts/);
  assert.match(list, /b\.md/);
  assert.match(list, /2 pattern\(s\)/);
  // pattern is declared as a single string; an array is unusable input, not a list.
  assertTypedRefusal(await callTool(pi, cwd, "find", { pattern: ["*.ts", "*.md"] }), { reason: /find requires exactly one of pattern or non-empty patterns/ });
  assertTypedRefusal(await callTool(pi, cwd, "find", { pattern: "*.ts", patterns: ["*.md"] }), { reason: /find requires exactly one of pattern or non-empty patterns/ });
});

test("find refuses path, name and paths aliases with named replacements", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-find-alias-", { "src/a.ts": "x\n" });
  assertTypedRefusal(await callTool(pi, cwd, "find", { pattern: "*.ts", path: "src" }), { fields: ["path"] });
  assertTypedRefusal(await callTool(pi, cwd, "find", { name: "*.ts" }), { fields: ["name"] });
  assertTypedRefusal(await callTool(pi, cwd, "find", { pattern: "*.ts", paths: "src" }), { fields: ["paths"] });
  assertTypedRefusal(await callTool(pi, cwd, "find", { pattern: "*.ts", name: "README.md" }), { fields: ["name"] });
  const ok = await callTool(pi, cwd, "find", { pattern: "*.ts" });
  assert.match(ok, /a\.ts/);
});

// ---------------------------------------------------------------------------
// ls: one directory path per call
// ---------------------------------------------------------------------------

test("ls rejects depth beside view:'list' and accepts it with view:'tree'", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-ls-depth-", { "src/a.ts": "x\n" });
  const refused = await callTool(pi, cwd, "ls", { path: cwd, view: "list", depth: 2 });
  assertTypedRefusal(refused, { reason: /ls depth applies only to view:'tree'/ });
  const tree = await callTool(pi, cwd, "ls", { path: cwd, view: "tree", depth: 2 });
  assert.match(tree, /a\.ts/);
  assert.doesNotMatch(tree, /INVALID CALL/);
});

test("ls refuses the paths alias and a selector-bearing path with typed evidence", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-ls-paths-", { "src/a.ts": "x\n" });
  assertTypedRefusal(await callTool(pi, cwd, "ls", { paths: [join(cwd, "src")] }), { fields: ["paths"] });
  const selector = await callTool(pi, cwd, "ls", { path: `${join(cwd, "src")}:10-20` });
  assert.match(selector, /ERROR: scope not found/);
  assert.match(selector, /No navigation backend was run/);
  assert.ok(selector.includes(`${join(cwd, "src")}:10-20`), "the literal path is reported, not a rewritten one");
  const listed = await callTool(pi, cwd, "ls", { path: join(cwd, "src") });
  assert.match(listed, /a\.ts/);
});

test("ls refuses a non-string path with typed evidence instead of dereferencing it", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-ls-nonstring-", { "src/a.ts": "x\n" });
  for (const path of [["src"], {}, 42, true, null]) {
    const reply = await callTool(pi, cwd, "ls", { path, sort: "path" });
    assertTypedRefusal(reply);
    assert.match(reply, /path must be a single directory string/);
    assert.doesNotMatch(reply, /is not a function|Cannot read propert/);
  }
});

// ---------------------------------------------------------------------------
// read: exact batch merge, single-directory refusal, no alias surface
// ---------------------------------------------------------------------------

test("read merges path with paths as one exact batch", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-read-merge-", { "a.ts": "alpha\n", "b.ts": "beta\n" });
  const merged = await callTool(pi, cwd, "read", { path: join(cwd, "a.ts"), paths: [join(cwd, "b.ts")] });
  assert.match(merged, /alpha/);
  assert.match(merged, /beta/);
  assert.doesNotMatch(merged, /INVALID CALL/);
  const packed = await callTool(pi, cwd, "read", { path: `${join(cwd, "a.ts")},${join(cwd, "b.ts")}` });
  assert.match(packed, /alpha/);
  assert.match(packed, /beta/);
});

test("read refuses files and a non-string path with typed evidence", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-read-aliases-", { "a.ts": "alpha\n", "b.ts": "beta\n" });
  assertTypedRefusal(await callTool(pi, cwd, "read", { files: [join(cwd, "a.ts")] }), { reason: /unknown parameter: files/ });
  assertTypedRefusal(await callTool(pi, cwd, "read", { files: [join(cwd, "b.ts")], paths: [join(cwd, "a.ts")] }), { reason: /unknown parameter: files/ });
  assertTypedRefusal(await callTool(pi, cwd, "read", { path: [join(cwd, "a.ts"), join(cwd, "b.ts")] }), { reason: /path must be a string/ });
});

test("read refuses a directory with the ls handoff instead of an internal error", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-read-dir-", { "src/a.ts": "alpha\n" });
  await assert.rejects(
    () => callTool(pi, cwd, "read", { path: join(cwd, "src") }),
    error => /is a directory\. Use ls for directory listing/.test(String(error?.message ?? error))
      && !NO_INTERNAL_LEAK.test(String(error?.message ?? error)),
  );
});

// ---------------------------------------------------------------------------
// write: overwrite is exactly true or omitted, and nothing is created on refusal
// ---------------------------------------------------------------------------

test("write refuses every non-true overwrite value and mutates nothing", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-write-overwrite-", {});
  const values = ["true", false, "1", 1];
  for (const [index, overwrite] of values.entries()) {
    const target = join(cwd, `w${index}.ts`);
    const out = await callTool(pi, cwd, "write", { path: target, content: "x", overwrite });
    assertTypedRefusal(out, { reason: /write overwrite must be omitted or exactly true/ });
    assert.equal(existsSync(target), false, `a refused write must not create ${target}`);
  }
});

test("write creates without overwrite and replaces only with overwrite:true", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-write-valid-", {});
  const created = await callTool(pi, cwd, "write", { path: join(cwd, "n.ts"), content: "export const n = 1;\n" });
  assert.doesNotMatch(created, /INVALID CALL/);
  assert.equal(existsSync(join(cwd, "n.ts")), true);
  const replaced = await callTool(pi, cwd, "write", { path: join(cwd, "n.ts"), content: "export const n = 2;\n", overwrite: true });
  assert.doesNotMatch(replaced, /INVALID CALL/);
});

test("write refuses the file and text aliases with typed evidence", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-write-aliases-", {});
  assertTypedRefusal(await callTool(pi, cwd, "write", { file: join(cwd, "w.ts"), text: "x" }), { fields: ["file", "text"] });
  assertTypedRefusal(await callTool(pi, cwd, "write", { path: join(cwd, "w.ts"), text: "x" }), { fields: ["text"] });
  assert.equal(existsSync(join(cwd, "w.ts")), false);
});

// ---------------------------------------------------------------------------
// lsp_validate: one paths field, boolean warnings
// ---------------------------------------------------------------------------

test("lsp_validate refuses a non-boolean includeWarnings", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-lsp-bool-", { "src/a.ts": "export const a = 1;\n" });
  assertTypedRefusal(await callTool(pi, cwd, "lsp_validate", { paths: [join(cwd, "src", "a.ts")], includeWarnings: "true" }), { reason: /includeWarnings must be boolean/ });
});

test("lsp_validate refuses path and files aliases and never rewrites a selector path", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-lsp-aliases-", { "src/a.ts": "export const a = 1;\n" });
  assertTypedRefusal(await callTool(pi, cwd, "lsp_validate", { path: join(cwd, "src", "a.ts") }), { reason: /requires at least one non-empty file or directory path/ });
  assertTypedRefusal(await callTool(pi, cwd, "lsp_validate", { file: join(cwd, "src", "a.ts") }), { reason: /requires at least one non-empty file or directory path/ });
  assertTypedRefusal(await callTool(pi, cwd, "lsp_validate", { files: [join(cwd, "src", "a.ts")] }), { reason: /requires at least one non-empty file or directory path/ });
  const selector = await callTool(pi, cwd, "lsp_validate", { paths: `${join(cwd, "src", "a.ts")}:10-20` });
  assert.match(selector, /Path does not exist/);
  assert.ok(selector.includes(`${join(cwd, "src", "a.ts")}:10-20`), "the literal path is reported, not a rewritten one");
});

test("lsp_validate normalizes a scalar paths value and reports it", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-lsp-scalar-", { "src/a.ts": "export const a = 1;\n" });
  const out = await callTool(pi, cwd, "lsp_validate", { paths: join(cwd, "src", "a.ts") });
  assert.match(out, /Call normalization: scalar paths → one-item paths array/);
});

// ---------------------------------------------------------------------------
// trace: exact relation vocabulary and one identity form
// ---------------------------------------------------------------------------

test("trace refuses the singular relation alias with the accepted vocabulary", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await project("tolerance-trace-alias-", { "a.ts": "export function target() {}\n" });
  assertTypedRefusal(await callTool(pi, cwd, "trace", { target: "target", relation: "caller", scope: cwd }), { reason: /relation must be one of: callers, callees, imports, importers, tests, path, explain/ });
});

test("trace refuses the identity alias and a target/targets mix", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await project("tolerance-trace-identity-", { "a.ts": "export function target() {}\n" });
  assertTypedRefusal(await callTool(pi, cwd, "trace", { identity: "target", relation: "callers", scope: cwd }), { fields: ["identity"] });
  assertTypedRefusal(await callTool(pi, cwd, "trace", { target: "target", targets: ["beta"], relation: "callers", scope: cwd }), { reason: /requires exactly one of target or targets/ });
});

test("trace keeps file relations on file paths and symbol relations on symbols", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await project("tolerance-trace-shape-", { "src/a.ts": "export const alpha = 1;\n" });
  assertTypedRefusal(await callTool(pi, cwd, "trace", { target: `${join(cwd, "src", "a.ts")}::alpha`, relation: "imports" }), { reason: /imports requires a concrete file path target/ });
  const symbol = await callTool(pi, cwd, "trace", { target: "alpha", relation: "callers", scope: cwd });
  assert.match(symbol, /Callers of "alpha"|Live source authority|Source handoff/);
  assert.doesNotMatch(symbol, /INVALID CALL/);
});

test("trace batches independent targets on the live route", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await project("tolerance-trace-batch-", { "src/a.ts": "export function alpha() {}\nexport function beta() {}\n", "src/entry.ts": "import { alpha, beta } from './a';\nalpha();\nbeta();\n" });
  const out = await callTool(pi, cwd, "trace", { targets: ["alpha", "beta"], relation: "callers", scope: cwd, limit: 5 });
  assert.match(out, /alpha/);
  assert.match(out, /beta/);
  assert.doesNotMatch(out, /INVALID CALL/);
});

// ---------------------------------------------------------------------------
// explore: declared operations only; the code refusal names no target
// ---------------------------------------------------------------------------

test("explore refuses the operation alias with the accepted vocabulary", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-explore-alias-", { "a.ts": "export function target() {}\n" });
  assertTypedRefusal(await callTool(pi, cwd, "explore", { view: "code", anchor: "target", operation: "find" }), { reason: /explore code operation must be one of: search, traverse/ });
});

test("explore map refuses anchor and depth instead of ignoring them", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-map-shape-", {});
  assertTypedRefusal(await callTool(pi, cwd, "explore", { view: "map", query: "src/tools/explore.ts", anchor: "src/tools/trace.ts" }), { reason: /explore map does not accept anchor/ });
  assertTypedRefusal(await callTool(pi, cwd, "explore", { view: "map", query: "src/tools/explore.ts", depth: 2 }), { reason: /explore map does not accept depth/ });
});

test("explore code refuses an unprepared scope without echoing the requested identity", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-explore-refusal-", { "a.ts": "export const a = 1;\n" });
  const out = await callTool(pi, cwd, "explore", { view: "code", operation: "traverse", anchor: "src/a.ts:1-3" });
  assert.match(out, /UNAVAILABLE: code exploration is unavailable for this scope/);
  assert.match(out, /Query time never builds, indexes, repairs or adopts one/);
  assert.doesNotMatch(out, /src\/a\.ts/, "the requested identity must not be echoed as a live-scan locator");
});

// ---------------------------------------------------------------------------
// diff: declared views and sources only
// ---------------------------------------------------------------------------

test("diff refuses removed and misspelled views with the accepted list", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-diff-view-", { "a.txt": "one\ntwo\n", "b.txt": "one\nthree\n" });
  for (const view of ["stats", "sumary"]) {
    const out = await callTool(pi, cwd, "diff", { a: "a.txt", b: "b.txt", view });
    assertTypedRefusal(out, { reason: /diff view must be one of summary, patch, structure, impact, review/ });
  }
});

test("diff refuses from, to, range and ref with the source replacement", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-diff-source-", { "a.txt": "one\ntwo\n" });
  assertTypedRefusal(await callTool(pi, cwd, "diff", { from: "HEAD~1", to: "HEAD" }), { fields: ["from", "to"] });
  assertTypedRefusal(await callTool(pi, cwd, "diff", { from: "HEAD~1" }), { fields: ["from"] });
  assertTypedRefusal(await callTool(pi, cwd, "diff", { range: "HEAD~1..HEAD" }), { fields: ["range"] });
  assertTypedRefusal(await callTool(pi, cwd, "diff", { ref: "main" }), { fields: ["ref"] });
  assertTypedRefusal(await callTool(pi, cwd, "diff", { range: "a", ref: "b" }), { fields: ["range", "ref"] });
});

test("diff file pairs reject selector-bearing paths and accept two exact files", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-diff-pair-", { "a.txt": "one\ntwo\n", "b.txt": "one\nthree\n" });
  const refused = await callTool(pi, cwd, "diff", { a: "a.txt:1-2", b: "b.txt:5-9", view: "patch" });
  assert.match(refused, /ERROR: diff file-to-file path not found or not a file: a\.txt:1-2, b\.txt:5-9/);
  assert.match(refused, /Stop condition: do not interpret this as a successful file comparison/);
  const valid = await callTool(pi, cwd, "diff", { a: "a.txt", b: "b.txt", view: "patch" });
  assert.match(valid, /Read-only file comparison patch/);
  assert.doesNotMatch(valid, /INVALID CALL/);
});

test("diff bounds a reply by the numeric budget it was given", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-diff-budget-", { "a.txt": "one\ntwo\n", "b.txt": "one\nthree\n" });
  for (const budget of ["oops", NaN, Infinity, {}, []]) {
    assertTypedRefusal(await callTool(pi, cwd, "diff", { a: "a.txt", b: "b.txt", view: "patch", budget }), { reason: /diff budget must be a finite positive number/ });
  }
  const bounded = await callTool(pi, cwd, "diff", { a: "a.txt", b: "b.txt", view: "patch", budget: 20000 });
  assert.match(bounded, /Read-only file comparison patch/);
  assert.doesNotMatch(bounded, /INVALID CALL/);
});

// ---------------------------------------------------------------------------
// edit: a malformed program is refused, never partially applied
// ---------------------------------------------------------------------------

test("edit refuses a malformed program at the execute boundary without writing", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-edit-malformed-", { "a.ts": "x\n" });
  // The refusal text is typed and safe, but it arrives as a thrown error rather
  // than a returned invalid-call result. Reported as a boundary difference; the
  // non-mutation obligation holds either way.
  await assert.rejects(
    () => callTool(pi, cwd, "edit", { input: "[src/a.ts#BAD] REPLACE 1:\n+new" }),
    error => /Edit rejected: syntax_error; no files were written/.test(String(error?.message ?? error))
      && !NO_INTERNAL_LEAK.test(String(error?.message ?? error)),
  );
  assert.equal((await readFile(join(cwd, "a.ts"), "utf8")).trim(), "x");
});

// ---------------------------------------------------------------------------
// docs_search: declared filters, and no implicit entry into an excluded child
// ---------------------------------------------------------------------------

test("docs_search refuses the term alias with the query replacement", async () => {
  const pi = registerCleanPi();
  const cwd = await project("tolerance-docs-term-", {});
  assertTypedRefusal(await callTool(pi, cwd, "docs_search", { term: "setup" }), { fields: ["term"] });
});

test("docs_search accepts the declared path and glob filters without entering an excluded child", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("tolerance-docs-child-");
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ scope: { include: ["."], exclude: ["child"] } }));
  await mkdir(join(cwd, "child", "docs", "guides"), { recursive: true });
  await mkdir(join(cwd, "child", ".pi", "navigation", "qmd"), { recursive: true });
  await writeFile(join(cwd, "child", ".pi-navigation.json"), JSON.stringify({ docs: { enabled: true, backend: "qmd", repo: "local/child" } }));
  await writeFile(join(cwd, "child", "docs", "guides", "setup.md"), "# Setup\n\nconfigure the harness.\n");
  for (const filter of [{ path: "child/docs/guides/setup.md" }, { glob: "child/**/*.md" }, {}]) {
    const out = await callTool(pi, cwd, "docs_search", { query: "harness", ...filter });
    // Filters are declared and accepted; the excluded child corpus is never entered.
    assert.doesNotMatch(out, /INVALID CALL/, JSON.stringify(filter));
    assert.doesNotMatch(out, /local\/child|child\/docs|Other queryable project/, `no implicit entry into the excluded child: ${out}`);
    assert.match(out, /UNAVAILABLE: Docs search is not enabled for this project/);
    assert.match(out, /Retrieval was not attempted/);
    assert.doesNotMatch(out, /No current matching Markdown sections/, "retrieval never ran, so a searched-and-empty claim would be fabricated");
  }
});

// ---------------------------------------------------------------------------
// Root-scope defaulting never reaches into a nested project
// ---------------------------------------------------------------------------

test("root-scope defaulting audits its own scope and never names a nested project", async () => {
  const pi = makePi(); jeitoCodeweavePiExtension(pi);
  const cwd = await tempProject("tolerance-root-scope-");
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ scope: { include: ["."], exclude: ["child"] } }));
  await mkdir(join(cwd, "child"), { recursive: true });
  await writeFile(join(cwd, "child", ".pi-navigation.json"), JSON.stringify({ scope: { include: ["."], exclude: [] } }));
  await writeFile(join(cwd, "a.ts"), "export function target() {}\n");
  const trace = await callTool(pi, cwd, "trace", { target: "target", relation: "callers" });
  assert.doesNotMatch(trace, /child/, `a defaulted root scope must not reach the nested project: ${trace}`);
  assert.match(trace, /Callers of "target"/);
  const grep = await callTool(pi, cwd, "grep", { pattern: "target" });
  assert.doesNotMatch(grep, /child/);
  assert.match(grep, /a\.ts/);
});
