import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runSkillSmoke } from "../scripts/navigation-skill-smoke.mjs";

test("navigation skill smoke validates current Pi skill CLI and discovery metadata", async () => {
  const result = await runSkillSmoke();

  assert.equal(result.status, "success");
  assert.equal(result.cli.has_skill_flag, true);
  assert.equal(result.cli.has_no_skills_flag, true);
  assert.equal(result.cli.has_offline_flag, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.skills.length, 3);
  assert.ok(result.skills.every(skill => skill.relevant_keyword_matches >= 2));
  assert.ok(result.skills.every(skill => skill.irrelevant_keyword_matches === 0));
  assert.equal(result.global_skill_loads.length, 3);
  assert.ok(result.global_skill_loads.every(skill => skill.status === "success"), JSON.stringify(result.global_skill_loads, null, 2));
  assert.ok(result.summary.includes("globally loadable by active Pi CLI"));
  assert.ok(result.summary.includes("behavioral contracts satisfied"));
  assert.equal(result.behavioral_contracts.length, 3);
  assert.ok(result.behavioral_contracts.every(skill => skill.status === "success"), JSON.stringify(result.behavioral_contracts, null, 2));
  assert.ok(result.behavioral_contracts.every(skill => skill.checks.every(check => check.passed)), JSON.stringify(result.behavioral_contracts, null, 2));
  assert.equal(result.prompt_contract.navigation_routing_guidance_present, true);
  assert.equal(result.prompt_contract.setup_skill_not_inlined, true);
  assert.equal(result.prompt_contract.bootstrap_skill_not_inlined, true);
  assert.equal(result.manual_live_smoke.status, "documented-not-run");
  assert.match(result.manual_live_smoke.command, /--skill deep-navigation-onboard.*--skill navigation-setup/);
  assert.ok(Array.isArray(result.manual_live_smoke.prompts));
  assert.ok(result.manual_live_smoke.prompts.some(prompt => /query-time|normal query/i.test(prompt)));
});

test("navigation skill smoke writes artifact and package script exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nav-skill-smoke-"));
  const out = join(root, "skill-smoke.json");
  const result = await runSkillSmoke({ out });

  assert.equal(result.status, "success");
  assert.equal(existsSync(out), true);
  const artifact = JSON.parse(await readFile(out, "utf8"));
  assert.equal(artifact.status, "success");
  assert.ok(artifact.artifacts.some(item => item.endsWith("skill-smoke.json")));
  assert.equal(artifact.behavioral_contracts.length, 3);
  assert.ok(artifact.behavioral_contracts.every(skill => skill.status === "success"));

  const run = spawnSync(process.execPath, ["scripts/navigation-skill-smoke.mjs", "--json"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, "success");

  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["nav:skill-smoke"], "node scripts/navigation-skill-smoke.mjs");
});
