import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import fg from "fast-glob";

import { backendCapability, listBackendCapabilities } from "../src/core/backend-registry.ts";
import { resolvePreparedLane } from "../src/core/navigation-config.ts";

const root = path.resolve(new URL("..", import.meta.url).pathname);

test("production readiness docs avoid removed backends and name clean-break surface", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /explore.*trace.*docs_search/s);
  assert.match(readme, /Graphify|code-review-graph|QMD|pi-nav/);
  assert.doesNotMatch(readme, /Codanna.*approved|Semble.*approved/i);
});

test("production readiness backend registry is approved clean-break set only", () => {
  assert.deepEqual(new Set(listBackendCapabilities().map(row => row.id)), new Set(["qmd", "graphify"]));
  assert.equal(backendCapability("crg"), undefined, "the retired CRG architecture backend must not remain in the public registry");
  assert.equal(backendCapability("codanna"), undefined);
  assert.equal(backendCapability("semble"), undefined);
});

test("retired architecture lane refuses before any store mutation or command", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "pi-nav-retired-architecture-"));
  await mkdir(path.join(fixture, ".git"));
  await mkdir(path.join(fixture, ".code-review-graph"));
  const sentinel = path.join(fixture, ".code-review-graph", "graph.db");
  await writeFile(sentinel, "fixture");
  const sentinelBefore = statSync(sentinel).mtimeMs;
  const decoyLog = path.join(fixture, "retired-command-called");
  const decoy = path.join(fixture, "retired-architecture-wrapper.mjs");
  await writeFile(decoy, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(decoyLog)}, 'called');\n`);
  await writeFile(path.join(fixture, ".pi-navigation.json"), JSON.stringify({ architecture: { enabled: true, root: ".", indexPath: ".code-review-graph/graph.db", command: decoy, python: decoy } }));
  const env = { ...process.env, NODE_TEST_CONTEXT: undefined };
  await assert.rejects(resolvePreparedLane(fixture, "architecture", { env }), /Unknown prepared lane|retired/i);
  assert.equal(await readFile(sentinel, "utf8"), "fixture", "the retired lane must not rewrite the old store");
  assert.equal(statSync(sentinel).mtimeMs, sentinelBefore, "the retired lane must not touch the old store");
  assert.equal(existsSync(decoyLog), false, "the retired lane must not execute a configured command");
  assert.equal(existsSync(path.join(fixture, ".pi", "navigation", "crg")), false, "the retired lane must not create a replacement store");
});

test("active runtime owners contain no superseded distribution route", async () => {
  const canonical = ["README.md", "AGENTS.md", "docs/README.md", "docs/harness-doctrine.md", "docs/automatic-workflow.md", "docs/evidence.md", "docs/tool-operating-reference.md", "docs/current-truth.md", "docs/setup.md", "docs/evaluation-workflow.md"];
  const discovered = await fg(["src/**/*.ts", "scripts/**/*.mjs", "tests/**/*.mjs", "skills/**/*.md"], { cwd: root, onlyFiles: true });
  const forbidden = /PI_NAV_OWNED_ROOT|runtime-state\.json|crg-py3|graphify-py3|supplementalWheels|requiresBinaryWheels|releaseFingerprint|binary-wheel provisioning|independent versioned/;
  const staleDocs = /lock hashes|patched-wheel identity|hash-locked dependenc|fingerprinted (?:root|runtime)|runtime fingerprint|Python lock generation/;
  const violations = [];
  for (const relative of [...canonical, ...discovered]) {
    if (relative === "tests/v3-production-readiness-release.test.mjs") continue;
    const text = await readFile(path.join(root, relative), "utf8");
    if (forbidden.test(text) || (canonical.includes(relative) && staleDocs.test(text))) violations.push(relative);
  }
  assert.deepEqual(violations, []);
});

test("active runtime owners expose no CRG executable import or provisioning", async () => {
  const retired = ["src/core/crg-runtime.ts", "scripts/crg-adapter.py", "scripts/crg-check.mjs", "scripts/crg-architecture-wrapper.mjs", "native/crg/code_review_graph/__init__.py", "native/crg/jeito-codeweave-pi-runtime.json"];
  // Executable coupling only: a retired module on a load path, a retired artifact
  // on a command line, or a CRG runtime declaration in the package manifest.
  // Historical prose, refusal guards, and privacy/ignore exclusions stay allowed.
  const executableCoupling = [
    /\bfrom\s*["'`][^"'`]*(?:crg|code_review_graph)[^"'`]*["'`]/i,
    /\bimport\s*\(\s*["'`][^"'`]*(?:crg|code_review_graph)[^"'`]*["'`]/i,
    /\brequire\s*\(\s*["'`][^"'`]*(?:crg|code_review_graph)[^"'`]*["'`]/i,
    /^\s*(?:import|from)\s+code_review_graph\b/m,
    /\b(?:exec|execFile|execFileSync|execSync|spawn|spawnSync)\s*\([^)]{0,200}["'`][^"'`]*(?:crg-adapter|crg-check|crg-architecture-wrapper|crg-wrapper|code-review-graph)[^"'`]*["'`]/i,
  ];
  const sources = await fg(["index.ts", "src/**/*.ts", "scripts/**/*.mjs"], { cwd: root, onlyFiles: true });
  const violations = [];
  for (const relative of sources) {
    const text = await readFile(path.join(root, relative), "utf8");
    if (executableCoupling.some(pattern => pattern.test(text))) violations.push(relative);
  }
  assert.deepEqual(violations, [], "runtime sources must not import or execute a retired CRG artifact");
  // The scan only proves retirement if it would catch the regression it names.
  const couplingFixtures = [
    ['import { inspectOwnedCrgRuntime } from "../src/core/crg-runtime.ts";', true],
    ['const adapter = require("./scripts/crg-adapter.py");', true],
    ['spawnSync(join(root, "scripts", "crg-architecture-wrapper.mjs"), []);', true],
    ['from code_review_graph import cli', true],
    ['throw new Error("the architecture lane was retired with the CRG runtime");', false],
    ['const dirs = new Set([".code-review-graph", ".crg"]);', false],
  ];
  for (const [sample, coupling] of couplingFixtures) {
    assert.equal(executableCoupling.some(pattern => pattern.test(sample)), coupling, `retired-runtime scan misjudged: ${sample}`);
  }
  for (const removed of retired) assert.equal(existsSync(path.join(root, removed)), false, `${removed} must stay absent after the CRG retirement`);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const declared = { scripts: manifest.scripts ?? {}, dependencies: { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }, bin: manifest.bin ?? {} };
  assert.equal(/crg|code-review-graph/i.test(JSON.stringify(declared)), false, "package.json must not declare a CRG script, dependency, or executable");
});
