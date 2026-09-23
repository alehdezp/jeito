import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runRealBackendMatrix } from "../scripts/navigation-real-smoke.mjs";
import { CORE_CMUX_PROBES, planCmuxBehaviorSuite, selectedProbes } from "../scripts/navigation-cmux-behavior-suite.mjs";
import { analyzeTranscript, assertTranscript } from "../scripts/navigation-cmux-onboarding-smoke.mjs";
import { publishOwnedGraphifyFixture } from "./_clean-navigation-helper.mjs";
import { setExtensionRuntimeRootForTests } from "../src/core/owned-runtime.ts";

const NODE = process.execPath;

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-real-smoke-test-"));
}

async function touch(file, content = "x") {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function executable(file, content) {
  await touch(file, content);
  await chmod(file, 0o755);
  return file;
}

async function fakeTools(root) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const graphify = await executable(join(bin, "graphify"), `#!${NODE}\nimport { existsSync, mkdirSync, writeFileSync } from 'node:fs';\nimport { dirname, join } from 'node:path';\nconst args = process.argv.slice(2);\nconst out = args[0] === 'update' && process.env.GRAPHIFY_OUT ? process.env.GRAPHIFY_OUT : (args.includes('--out') ? join(args[args.indexOf('--out') + 1], 'graphify-out') : join(args[1], 'graphify-out'));\nif (args[0] === 'update' || args[0] === 'extract') { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'graph.json'), JSON.stringify({ nodes: ['A'], edges: [] })); console.log('[graphify extract] semantic extraction on 1 files via deepseek'); }\nelse if (args[0] === 'query') { const graph = args[args.indexOf('--graph') + 1]; if (!existsSync(graph)) process.exit(3); console.log('graph answer'); }\nelse process.exit(4);\n`);
  // PATH is not authority: the owned runtime is. Publish this fake there so the
  // matrix can never borrow a real machine install, and restore the root after.
  const runtimeRoot = join(root, ".runtime");
  await publishOwnedGraphifyFixture(root, graphify);
  return { bin, runtimeRoot };
}

test("real backend matrix dry-runs representative repos without mutation", async () => {
  const result = await runRealBackendMatrix({ fixture: "synthetic", env: { PATH: "" } });

  assert.equal(result.status, "warning");
  assert.equal(result.fixtures.length, 5);
  assert.deepEqual(result.fixtures.map(item => item.name), ["tiny-code", "docs-only", "source-only", "monorepo", "noisy-generated"]);
  assert.equal(result.fixtures.reduce((sum, item) => sum + item.dry_run_mutations, 0), 0);
  assert.equal(result.backends.length, 2);
  assert.deepEqual(result.backends.map(row => row.backend), ["qmd", "graphify"]);
  assert.equal(result.backends.every(row => row.local_smoke.status === "skipped"), true);
  assert.equal(result.offline.network_installs, "not allowed");
  assert.ok(result.recovery.stop_conditions.includes("network/cloud/model download would be required"));
});

test("real backend matrix can run allowed local smokes with controlled fake tools", async t => {
  const root = await fixture();
  const { bin: toolDir, runtimeRoot } = await fakeTools(root);
  t.after(() => setExtensionRuntimeRootForTests());
  const out = join(root, "matrix.json");
  const result = await runRealBackendMatrix({ fixture: "synthetic", runLocal: true, toolDir, out, env: { PATH: "", PI_NAV_TEST_RUNTIME_ROOT: runtimeRoot } });

  assert.equal(result.status, "success", JSON.stringify(result, null, 2));
  assert.equal(existsSync(out), true);
  assert.equal(result.fixtures.reduce((sum, item) => sum + item.dry_run_mutations, 0), 0);
  assert.equal(result.backends.every(row => row.installed), true, JSON.stringify(result.backends));
  assert.equal(result.backends.every(row => row.local_smoke.status === "passed"), true, JSON.stringify(result.backends));
  const graphify = result.backends.find(row => row.backend === "graphify");
  const docs = result.backends.find(row => row.backend === "qmd");
  assert.equal(graphify.local_smoke.status, "passed");
  assert.equal(docs.local_smoke.status, "passed");
  assert.equal(result.backends.some(row => row.backend === "codanna" || row.backend === "semble"), false);
  assert.equal(result.failures.length, 0);

  const artifact = JSON.parse(await readFile(out, "utf8"));
  assert.equal(artifact.backends.find(row => row.backend === "graphify").local_smoke.audit_status, "success");
});

test("cmux behavior suite has focused core probes and a no-provider plan-only mode", () => {
  const plan = planCmuxBehaviorSuite({ probe: "all", provider: "deepseek", model: "deepseek-v4-flash" });
  assert.equal(plan.status, "planned");
  assert.equal(plan.probeCount, 4);
  assert.equal(CORE_CMUX_PROBES.length, 4);
  assert.ok(plan.probes.some(probe => /where should I start/i.test(probe.prompt) && probe.expectTool === "explore"));
  assert.ok(plan.probes.some(probe => /Find the docs/i.test(probe.prompt) && probe.expectTool === "docs"));
  assert.ok(plan.probes.some(probe => /What calls registerExploreTool/i.test(probe.prompt) && probe.expectTool === "trace"));
  assert.ok(plan.probes.some(probe => /impact of changing/i.test(probe.prompt) && probe.expectTool === "code_context"));
  assert.ok(/provider\/API|approval/i.test(plan.approvalNeeded));
  assert.equal(selectedProbes("setup-docs")[0].id, "setup-docs");
});

test("cmux transcript checks require tool output and catch command-like forbidden tools", () => {
  const root = "/tmp/pi-nav-fixture";
  const prompt = "Find the docs about navigation setup.";
  const base = `\n pi v0.79.10\n ctrl+c twice to exit\n${root}\n${prompt}\n\n docs\n`;

  const promptOnly = assertTranscript(base, root, prompt, { expectTool: "docs", expectPattern: "Docs search|Navigation Setup" });
  assert.equal(promptOnly.find(check => check.id === "expected-tool-docs")?.ok, true);
  assert.equal(promptOnly.find(check => check.id === "expected-output-pattern")?.ok, false, "expected output must not match the prompt text before tool results arrive");

  const withResult = `${base}\nDocs search\n\nResults\n- Navigation Setup — skills/navigation-setup/SKILL.md\n`;
  const resultChecks = assertTranscript(withResult, root, prompt, { expectTool: "docs", expectPattern: "Docs search|Navigation Setup" });
  assert.equal(resultChecks.find(check => check.id === "expected-output-pattern")?.ok, true);

  const broadPrompt = "What is this project and where should I start?";
  const withFallback = `\n pi v0.79.10\n ctrl+c twice to exit\n${root}\n${broadPrompt}\n\n explore\nCode map:\nCandidate files\n- src/server.ts:1-80\n\n find README* in .\n`;
  const fallbackChecks = assertTranscript(withFallback, root, broadPrompt, { expectTool: "explore", expectPattern: "Code map", forbidTools: "grep,find" });
  assert.equal(fallbackChecks.find(check => check.id === "forbid-tool-find")?.ok, false, "command-like find usage must fail the forbidden-tool check");

  const currentPrompt = "Use the jeito-codeweave-pi operational contract.";
  const currentOutput = `\n pi v0.79.10\n ctrl+c twice to exit\n${root}\n${currentPrompt}\n\n explore\nCode map:\nCode structure\n## communities [1]{name,size}\njeito-codeweave-pi|12\n\nHandoff identities\n1. index.ts:1-80\n2. src/tools/explore.ts:1-80\n`;
  const currentChecks = assertTranscript(currentOutput, root, currentPrompt, { fixture: "current", expectTool: "explore", expectPattern: "Code map", forbidTools: "grep,find" });
  assert.equal(currentChecks.find(check => check.id === "prepared-code-output-not-empty")?.ok, true, "current fixture should accept jeito-codeweave-pi code candidates, not fresh-fixture server files only");

  const feedbackPrompt = "Now debug the navigation experience you just had";
  const combinedWithFeedbackFind = `${currentOutput}\n${feedbackPrompt}\nThe feedback phase may mention command text like find register*Tool in ., but first-answer checks should ignore it.\n`;
  const firstAnswerChecks = assertTranscript(combinedWithFeedbackFind, root, currentPrompt, { fixture: "current", expectTool: "explore", expectPattern: "Code map", forbidTools: "grep,find", untilPrompt: feedbackPrompt });
  assert.equal(firstAnswerChecks.find(check => check.id === "forbid-tool-find")?.ok, true, "feedback-phase find prose must not fail first-answer forbidden-tool checks");
  const firstAnswerAnalysis = analyzeTranscript(combinedWithFeedbackFind, currentPrompt, { expectTool: "explore", untilPrompt: feedbackPrompt });
  assert.deepEqual(firstAnswerAnalysis.toolInvocations.map(item => item.tool), ["explore"]);

  const analysis = analyzeTranscript(withResult, prompt, { expectTool: "docs" });
  assert.deepEqual(analysis.toolInvocations.map(item => item.tool), ["docs"]);
  assert.equal(analysis.rawParamVisibility, "not_visible");
  assert.ok(analysis.limitations.some(item => /raw JSON\/tool-call params/.test(item)));

  const withParams = `${base}\n{ "action": "search", "query": "setup", "OPENAI_API_KEY": "secret-value" }\nDocs search\n`;
  const paramAnalysis = analyzeTranscript(withParams, prompt, { expectTool: "docs" });
  assert.equal(paramAnalysis.rawParamVisibility, "visible");
  assert.match(paramAnalysis.rawParamSnippets[0].text, /OPENAI_API_KEY":\s*"?<redacted>/);
});

test("package scripts expose navigation smoke commands", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["nav:real-smoke"], "node scripts/navigation-real-smoke.mjs");
  assert.equal(pkg.scripts["nav:loaded-runtime-smoke"], "node scripts/navigation-loaded-runtime-smoke.mjs");
  assert.equal(pkg.scripts["nav:cmux-onboarding-smoke"], "node scripts/navigation-cmux-onboarding-smoke.mjs");
  assert.equal(pkg.scripts["nav:cmux-suite"], "node scripts/navigation-cmux-behavior-suite.mjs");
});
