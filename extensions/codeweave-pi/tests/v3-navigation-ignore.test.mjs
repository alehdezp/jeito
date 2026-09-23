import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { compileLaneCorpusPolicy, compileNavigationCorpusPolicy, enumerateNavigationCorpus, navigationPathIsExcluded } from "../src/core/navigation-corpus-policy.ts";
import { ensureGlobalNavigationIgnore, gitignoreLinesToPrefixes, globalNavigationIgnorePath, mergeVersionedTemplate, parseIgnoreSections, readGlobalNavigationIgnoreLines, readGlobalNavigationIgnoreSections, readProjectNavigationIgnoreLines, readProjectNavigationIgnoreSections } from "../src/core/navigation-ignore.ts";

async function fixture(prefix = "pi-nav-ignore-") {
  return mkdtemp(join(tmpdir(), prefix));
}

test("global ignore template is created once and seeded from shipped defaults", async () => {
  const home = await fixture("home-");
  const path = ensureGlobalNavigationIgnore(home);
  assert.equal(path, globalNavigationIgnorePath(home));
  assert.ok(existsSync(path));
  const lines = readGlobalNavigationIgnoreLines(home);
  assert.ok(lines.includes("node_modules/"), "template seeds dependency trees");
  assert.ok(lines.includes(".pi/navigation"), "template seeds agent state paths");
  assert.equal(ensureGlobalNavigationIgnore(home), path, "idempotent");
});

test("gitignoreLinesToPrefixes maps the simple subset and drops globs and negation", () => {
  const root = "/tmp/proj";
  const prefixes = gitignoreLinesToPrefixes(["# comment", "", "!keep", "dist/", "/build", "src/generated/**", "**/vendor", "*.tmp", "docs/"], root);
  assert.deepEqual(prefixes.sort(), ["build", "dist", "docs", "src/generated"]);
});

test("corpus policy merges scope.exclude with template and project ignore (prefixes plus any-depth names)", () => {
  const root = "/tmp/proj";
  const policy = compileNavigationCorpusPolicy(root, ["native"], { extraValues: ["dist", "docs/plan", "prototypes"] });
  assert.deepEqual(policy.excludedPrefixes, ["docs/plan", "native"]);
  assert.deepEqual(policy.excludedNames, ["dist", "prototypes"]);
  assert.ok(navigationPathIsExcluded(policy, "/tmp/proj/native/crg/x.ts"));
  assert.ok(navigationPathIsExcluded(policy, "/tmp/proj/a/b/dist/file.ts"));
  assert.ok(navigationPathIsExcluded(policy, "/tmp/proj/prototypes/x.ts"));
  assert.ok(!navigationPathIsExcluded(policy, "/tmp/proj/src/main.ts"));
});

test("sectioned inclusions retain their scope, spelling compatibility, and cross-section order", () => {
  assert.deepEqual(parseIgnoreSections(["examples/", "[docs]", "+examples/", "[code]", "!src/**/*.ts", "[global]", "secret/", "\\!literal"]), [
    { section: "global", pattern: "examples/" },
    { section: "docs", pattern: "!examples/" },
    { section: "code", pattern: "!src/**/*.ts" },
    { section: "global", pattern: "secret/" },
    { section: "global", pattern: "\\!literal" },
  ]);
});

test("lane compilation preserves ordered full patterns and separate policy origins for native matching", async t => {
  const root = await fixture();
  const home = await fixture("home-");
  t.after(() => Promise.all([root, home].map(path => rm(path, { recursive: true, force: true }))));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(root, ".pi", "navigation"), { recursive: true });
  writeFileSync(globalNavigationIgnorePath(home), "defaults/\n!defaults/\n!private/\n");
  writeFileSync(join(root, ".pi", "navigation", "ignore"), "examples/\nprivate/\n[docs]\n+examples/\n[code]\n!src/**/*.ts\n[global]\nsrc/private/\n!curated/\n");
  writeFileSync(join(root, ".pi-navigation.json"), JSON.stringify({ scope: { exclude: ["curated"] } }));
  writeFileSync(join(root, ".gitignore"), "git-private/\n");
  const code = compileLaneCorpusPolicy(root, undefined, "code", { home });
  const docs = compileLaneCorpusPolicy(root, undefined, "docs", { home });
  assert.deepEqual(code.policy.globalRules, ["defaults/", "!defaults/", "!private/"]);
  assert.deepEqual(code.policy.projectRules, ["examples/", "private/", "!src/**/*.ts", "src/private/", "!curated/"]);
  assert.deepEqual(docs.policy.projectRules, ["examples/", "private/", "!examples/", "src/private/", "!curated/"]);
  assert.deepEqual(code.policy.excludedPrefixes, ["curated"]);
  assert.notEqual(code.digest, docs.digest);
  writeFileSync(join(root, ".gitignore"), "git-private/\nnew-private/\n");
  assert.notEqual(compileLaneCorpusPolicy(root, undefined, "code", { home }).digest, code.digest);
  writeFileSync(join(root, ".pi-navigation.json"), JSON.stringify({ scope: { exclude: "private" } }));
  assert.throws(() => compileLaneCorpusPolicy(root, undefined, "code", { home }), /scope.exclude/);
  writeFileSync(join(root, ".pi-navigation.json"), "{");
  assert.throws(() => compileLaneCorpusPolicy(root, undefined, "code", { home }), SyntaxError);
});

test("sectioned template round-trips through the readers and versioned merge preserves user edits", async () => {
  const home = await fixture("home-");
  const path = ensureGlobalNavigationIgnore(home);
  const sections = readGlobalNavigationIgnoreSections(home);
  assert.ok(sections.some(rule => rule.section === "global"), "template defaults land in [global]");
  assert.ok(readGlobalNavigationIgnoreLines(home).length > 0);
  assert.equal(mergeVersionedTemplate(home).merged, false, "current template is not rewritten");
  writeFileSync(path, "custom-entry/\n");
  assert.equal(mergeVersionedTemplate(home).merged, true, "legacy template without version header is merged");
  const merged = readGlobalNavigationIgnoreLines(home);
  assert.ok(merged.includes("custom-entry/"), "user lines survive the merge");
  assert.ok(merged.includes("node_modules/"), "shipped defaults are refreshed");
});

test("project ignore sections drive lane compilation for a nested project file", async () => {

  const root = await fixture();
  mkdirSync(join(root, ".pi", "navigation"), { recursive: true });
  writeFileSync(join(root, ".pi", "navigation", "ignore"), "[docs]\nscratch/\n+scratch/keep\n");
  const sections = readProjectNavigationIgnoreSections(root);
  assert.deepEqual(sections, [{ section: "docs", pattern: "scratch/" }, { section: "docs", pattern: "!scratch/keep" }]);
});

test("code eligibility excludes ordinary binaries but refuses unreadable required text", async t => {
  const root = realpathSync(await fixture());
  const home = await fixture("home-");
  t.after(() => Promise.all([root, home].map(path => rm(path, { recursive: true, force: true }))));
  writeFileSync(join(root, "ready.ts"), "export function Ready() {}\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "image.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  writeFileSync(join(root, "opaque"), Buffer.from([0, 1, 2, 3]));
  const files = ["ready.ts", "package.json", "image.png", "opaque"];
  const native = async () => ({ structured: { data: { root, corpusPolicyVersion: 1, files, directories: [""] }, completeness: { complete: true } } });
  const code = await enumerateNavigationCorpus(root, "code", native, { home });
  assert.deepEqual(code.files, ["ready.ts", "package.json"]);
  assert.equal(code.binaryFiles, 2);
  assert.ok(existsSync(join(root, "image.png")), "filtering does not delete or hide the path from ordinary path operations");
  const docs = await enumerateNavigationCorpus(root, "docs", native, { home });
  assert.deepEqual(docs.files, files, "this change does not replace the docs lane's own filtering");
  files.push("missing.ts");
  await assert.rejects(enumerateNavigationCorpus(root, "code", native, { home }), /ENOENT/);
});

test("missing HOME uses the operating-system home; explicit relative policy home is refused", async t => {
  const root = realpathSync(await fixture());
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.HOME;
  try {
    delete process.env.HOME;
    const policy = compileLaneCorpusPolicy(root, undefined, "code");
    assert.equal(globalNavigationIgnorePath(), join(homedir(), ".pi", "agent", "navigation-ignore"));
    assert.ok(policy.policyFiles.every(input => isAbsolute(input.path)), "native admission requires absolute policy identities");
    for (const reader of [globalNavigationIgnorePath, readGlobalNavigationIgnoreLines, readGlobalNavigationIgnoreSections, ensureGlobalNavigationIgnore, mergeVersionedTemplate]) {
      assert.throws(() => reader("relative"), /home must be an absolute/);
    }
    assert.throws(() => compileLaneCorpusPolicy(root, undefined, "code", { home: "relative" }), /home must be an absolute/);
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
  }
});
