#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = ".tmp/navigation-skill-smokes/latest.json";
const SKILLS = [
  { name: "deep-navigation-onboard", path: "skills/deep-navigation-onboard/SKILL.md", prompt: "In one sentence, name the codeweave-pi machine onboarding workflow.", expected: /onboard|provider|runtime|navigation/i, relevant: [/onboard/i, /provider/i, /credential/i, /runtime/i], irrelevant: [/rename variable/i, /CSS color/i], checks: ["query_time_non_mutation", "confirmation_for_risky_setup"] },
  { name: "navigation-setup", path: "skills/navigation-setup/SKILL.md", prompt: "In one sentence, name the navigation setup workflow.", expected: /navigation|setup|prepare/i, relevant: [/prepare/i, /freshen/i, /setup/i, /navigation-ready/i], irrelevant: [/rename variable/i, /CSS color/i], checks: ["query_time_non_mutation", "live_authority_boundary", "confirmation_for_risky_setup", "provider_preview_before_execution", "audit_and_rollback", "hard_prompt_validation"] },
  { name: "navigation-debug", path: "skills/navigation-debug/SKILL.md", prompt: "In one sentence, name the navigation debug workflow.", expected: /navigation|debug|diagnose|readiness/i, relevant: [/debug/i, /diagnose/i, /readiness/i, /backend/i], irrelevant: [/single file edit/i, /format markdown/i], checks: ["query_time_non_mutation"] },
];

const BEHAVIORAL_CHECKS = [
  { key: "query_time_non_mutation", description: "Skill says query-time tools must not install, index, download, or mutate state.", pattern: /Query-time tools[\s\S]{0,180}must not install packages|Query-time navigation tools must never build|Do not build indexes, install packages, download models, call providers, or mutate|Read-only by default[\s\S]{0,320}install[\s\S]{0,320}mutate/i },
  { key: "live_authority_boundary", description: "Skill distinguishes complete live hash-certified rows from locator-only evidence without requiring read specifically.", pattern: /complete (?:live )?source rows[\s\S]{0,220}(?:whole-file hash|edit authority)|live-row certification|hash-certified/i },
  { key: "confirmation_for_risky_setup", description: "Skill requires confirmation or policy for installs, providers, model downloads, ambiguous/noisy scopes, and provisional quality.", pattern: /(Requires explicit approval|explicit (?:user )?approval|explicit confirmation|Ask\/confirm before|Ask\/confirm only for unconfigured risk|unless the user explicitly switches)[\s\S]{0,320}(package|network installs|cloud\/API|cloud providers|local model downloads|ambiguous|huge\/noisy|provider|setup)/i },
  { key: "provider_preview_before_execution", description: "Provider-capable setup resolves and previews provider, locality/privacy, models, credential presence, and writes before exact approval.", pattern: /Preview provider-capable work before approval[\s\S]{0,1400}selected provider[\s\S]{0,700}contentLeavesMachine[\s\S]{0,700}model names[\s\S]{0,700}expected project writes[\s\S]{0,900}explicit approval/i },
  { key: "audit_and_rollback", description: "Skill requires audit logs plus cleanup or rollback guidance for automatic setup.", pattern: /audit records|audit logs|nav:audit/i },
  { key: "hard_prompt_validation", description: "Skill includes hard prompt or validation workflow for prepared navigation behavior.", pattern: /Verify with hard prompts|Validate before declaring ready|hard prompts|verify only expected lanes/i },
];

const BEHAVIORAL_SMOKE_PROMPTS = [
  "Prepare this unknown repo for better navigation without mutating query-time tools.",
  "Semantic search feels weak; what should I run and what must remain only a lead?",
  "Can explore install missing backends or download models during a normal query?",
];

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { json: false, out: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--out") args.out = value();
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

export async function runSkillSmoke(options = {}) {
  const piHelp = spawnSync("pi", ["--help"], { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const helpText = `${piHelp.stdout ?? ""}\n${piHelp.stderr ?? ""}`;
  const cli = {
    status: piHelp.error || piHelp.status !== 0 ? "warning" : "success",
    has_skill_flag: /--skill\s+<path>/i.test(helpText),
    has_no_skills_flag: /--no-skills/i.test(helpText),
    has_offline_flag: /--offline/i.test(helpText),
  };

  const skillRows = [];
  for (const skill of SKILLS) skillRows.push(await inspectSkill(skill));
  const globalRows = [];
  for (const skill of SKILLS) globalRows.push(checkGlobalSkill(skill));
  const behaviorRows = [];
  for (const skill of SKILLS) behaviorRows.push(await inspectBehaviorContract(skill));
  const systemPrompt = await readFile(path.join(EXTENSION_ROOT, "index.ts"), "utf8");
  const promptContract = {
    navigation_routing_guidance_present: ["registerExploreTool(pi", "registerTraceTool(pi", "registerDocsSearchTool(pi", "registerReadTool(pi"].every(call => systemPrompt.includes(call)) && !systemPrompt.includes("registerCodeContextTool(pi"),
    setup_skill_not_inlined: !/## Standard workflow[\s\S]*## Completion checklist/.test(systemPrompt),
    bootstrap_skill_not_inlined: !/## Bootstrap contract[\s\S]*## Final report checklist/.test(systemPrompt),
    base_prompt_mentions_prepare_only: /prompt-safe detect-only|policy-gated background prepare|Setup\/freshen owns|setup\/freshen owns|Automatic setup\/freshen belongs only|first prompt is read-only|Navigation first-prompt readiness|startBackgroundPrepare|nav:prepare --auto/.test(systemPrompt),
  };

  const failures = [];
  if (!cli.has_skill_flag || !cli.has_no_skills_flag || !cli.has_offline_flag) failures.push("current pi CLI does not expose expected skill/offline flags");
  for (const row of skillRows) failures.push(...row.failures.map(failure => `${row.name}: ${failure}`));
  for (const row of globalRows) failures.push(...row.failures.map(failure => `${row.name}: ${failure}`));
  for (const row of behaviorRows) failures.push(...row.failures.map(failure => `${row.name}: ${failure}`));
  for (const [key, ok] of Object.entries(promptContract)) if (!ok) failures.push(`prompt contract failed: ${key}`);

  const outPath = options.out ? path.resolve(EXTENSION_ROOT, options.out) : undefined;
  const result = {
    status: failures.length ? "error" : "success",
    summary: `${skillRows.length} navigation skills inspected; ${globalRows.filter(row => row.status === "success").length}/${globalRows.length} globally loadable by active Pi CLI; ${behaviorRows.filter(row => row.status === "success").length}/${behaviorRows.length} behavioral contracts satisfied; Pi CLI skill/offline flags ${cli.has_skill_flag && cli.has_offline_flag ? "present" : "missing"}; ${failures.length} failure(s).`,
    next_actions: failures.length
      ? ["Install/copy navigation skills into the active Pi global skills directory, fix skill metadata/prompt/behavior contract, then rerun nav:skill-smoke."]
      : ["Active Pi CLI can load the onboarding/setup/debug skills by name and their files preserve setup safety/proof-boundary contracts; use deep-navigation-onboard once per machine and navigation-setup per project."],
    artifacts: outPath ? [relativePath(EXTENSION_ROOT, outPath), ".tmp/navigation-skill-smokes/README.md"] : ["stdout", ".tmp/navigation-skill-smokes/README.md"],
    recovery: {
      safe_retry: `npm run nav:skill-smoke -- --json --out ${DEFAULT_OUT}`,
      stop_conditions: ["Pi CLI skill flags unavailable", "active Pi CLI cannot load navigation skills by name", "skill metadata cannot resolve", "setup/bootstrap guidance is duplicated into base prompt"],
    },
    cli,
    skills: skillRows,
    global_skill_loads: globalRows,
    behavioral_contracts: behaviorRows,
    prompt_contract: promptContract,
    manual_live_smoke: {
      status: "documented-not-run",
      reason: "The live by-name skill load is executed above; behavioral checks are static contract checks. These prompts are documented for optional model-backed/manual operator checks.",
      prompts: BEHAVIORAL_SMOKE_PROMPTS,
      command: "pi --offline --no-extensions --skill deep-navigation-onboard --skill navigation-setup --no-tools -p '<ask a machine or project navigation setup prompt>'",
    },
    failures,
  };

  if (outPath) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

async function inspectSkill(skill) {
  const abs = path.join(EXTENSION_ROOT, skill.path);
  const text = await readFile(abs, "utf8");
  const frontmatter = parseFrontmatter(text);
  const failures = [];
  if (frontmatter.name !== skill.name) failures.push(`frontmatter name ${frontmatter.name || "<missing>"} does not match`);
  if (!frontmatter.description || frontmatter.description.length < 20) failures.push("description missing or too short for discovery");
  const safetyCheck = BEHAVIORAL_CHECKS.find(check => check.key === "query_time_non_mutation");
  if (skill.checks.includes("query_time_non_mutation") && !safetyCheck.pattern.test(text)) failures.push("query-time non-mutation safety contract missing");
  if (!/nav:prepare|nav:bootstrap|nav:freshen|nav:doctor|nav:audit/.test(text)) failures.push("setup/debug command guidance missing");
  const description = `${frontmatter.name} ${frontmatter.description}`;
  const relevantMatches = skill.relevant.filter(pattern => pattern.test(description)).length;
  const irrelevantMatches = skill.irrelevant.filter(pattern => pattern.test(description)).length;
  if (relevantMatches < 2) failures.push("description lacks enough setup/bootstrap discovery keywords");
  if (irrelevantMatches > 0) failures.push("description appears too broad for unrelated edit prompts");
  return {
    name: skill.name,
    path: skill.path,
    exists: existsSync(abs),
    description: frontmatter.description,
    relevant_keyword_matches: relevantMatches,
    irrelevant_keyword_matches: irrelevantMatches,
    safety_contract_present: failures.every(failure => !/safety/.test(failure)),
    failures,
  };
}

function checkGlobalSkill(skill) {
  let run;
  for (let attempt = 0; attempt < 2; attempt++) {
    run = spawnSync("pi", ["--offline", "--no-extensions", "--skill", skill.name, "--no-tools", "-p", skill.prompt], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 512 * 1024,
    });
    if (!run.error && run.status === 0) break;
  }
  const text = `${run?.stdout ?? ""}\n${run?.stderr ?? ""}`;
  const failures = [];
  if (run?.error) failures.push(`active Pi CLI could not run skill by name: ${run.error.message}`);
  else if (run?.status !== 0) failures.push(`active Pi CLI failed to load skill by name (exit ${run?.status})`);
  return {
    name: skill.name,
    status: failures.length ? "error" : "success",
    exitCode: run.status,
    outputPreview: text.trim().split(/\r?\n/).slice(0, 3).join("\n"),
    failures,
  };
}

async function inspectBehaviorContract(skill) {
  const abs = path.join(EXTENSION_ROOT, skill.path);
  const text = await readFile(abs, "utf8");
  const failures = [];
  const checks = BEHAVIORAL_CHECKS.filter(check => skill.checks.includes(check.key)).map(check => {
    const passed = check.pattern.test(text);
    if (!passed) failures.push(`behavioral contract missing: ${check.key}`);
    return { key: check.key, description: check.description, passed };
  });
  return { name: skill.name, path: skill.path, status: failures.length ? "error" : "success", checks, failures };
}

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  const output = {};
  if (!match) return output;
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (parsed) output[parsed[1]] = parsed[2].trim();
  }
  return output;
}

function relativePath(root, file) {
  return path.relative(root, file).replace(/\\/g, "/") || ".";
}

function helpText() {
  return `Usage: node scripts/navigation-skill-smoke.mjs [--json] [--out PATH]\n\nValidates jeito-codeweave-pi skill discovery metadata against the current Pi CLI skill surface with a minimal by-name load probe. Writes a smoke artifact and documents the manual live-session command.`;
}

function renderText(result) {
  if (result.help) return result.text;
  const lines = [`Navigation skill smoke: ${result.status}`, result.summary];
  for (const row of result.skills) lines.push(`- ${row.name}: ${row.failures.length ? row.failures.join("; ") : "ok"}`);
  lines.push(`Next: ${result.next_actions.join("; ")}`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (args.help) console.log(helpText());
  else runSkillSmoke(args).then(result => {
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
    if (result.status === "error") process.exitCode = 2;
  }).catch(error => {
    console.error(`ERROR: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
