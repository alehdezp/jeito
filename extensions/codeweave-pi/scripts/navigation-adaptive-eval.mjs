#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(EXTENSION_ROOT, ".tmp", "navigation-adaptive-eval", "latest.json");
const FAILURE_CLASSES = ["routing", "ranking", "readiness", "noisy-scope", "backend-capability", "normalization", "UX", "proof-boundary", "eval-artifact"];

function parseArgs(argv = process.argv.slice(2)) {
  const args = { json: false, out: DEFAULT_OUT, toolFeelOut: undefined, toolFeelArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--json") args.json = true;
    else if (flag === "--out") args.out = path.resolve(value());
    else if (flag === "--tool-feel-out") args.toolFeelOut = path.resolve(value());
    else if (flag === "--help" || flag === "-h") args.help = true;
    else args.toolFeelArgs.push(flag);
  }
  return args;
}

function usage() {
  return `Usage: node scripts/navigation-adaptive-eval.mjs [--json] [--out file] [--tool-feel-out file] [extra nav:tool-feel args]\n\nRuns the black-box navigation tool-feel probe, then turns its transcript into\nan adaptive, decision-oriented evaluation report. This is intentionally not a\ncoverage suite: it classifies failure modes, surfaces near-miss prompts, and\nrecommends fix / investigate / ignore / stop.`;
}

function firstLine(text) {
  return String(text ?? "").split("\n").find(line => line.trim())?.trim() ?? "";
}

function topLeadPath(result) {
  const top = result?.topLead || result?.excerpt || "";
  const match = /\n?1\. \[[^\]]+\]\n\s+([^\n]+?)(?::\d+-\d+)?\s*$/m.exec(top);
  if (match) return match[1].trim();
  const loose = /\n?1\. \[[^\]]+\]\n\s+([^\n]+)/m.exec(top);
  return loose ? loose[1].trim().replace(/:\d+-\d+$/, "") : "";
}

function sourceFor(result) {
  return /Selected lead source: ([^.\n]+)/.exec(result?.excerpt ?? "")?.[1]?.trim() ?? "unknown";
}

function planFor(result) {
  return /Planned primary: ([^\s(.]+)/.exec(result?.excerpt ?? "")?.[1]?.trim() ?? "unknown";
}

function includesProofBoundaryMistake(result) {
  const text = `${result?.excerpt ?? ""}\n${result?.topLead ?? ""}`;
  return /edit authority|Leads only/i.test(text) && /explore/i.test(result?.tool ?? "");
}

function classifyFailure(result, scenario) {
  const text = `${result?.excerpt ?? ""}\n${result?.topLead ?? ""}`;
  if (result.ok) return [];
  const classes = new Set();
  if (/skipped|not ready|setup needed|stale|missing readiness|not configured/i.test(text)) classes.add("readiness");
  if (/\.research|\.agents|\.pi\/goals|generated|vendor/i.test(result.topLead ?? "")) classes.add("noisy-scope");
  if (scenario?.expected?.primary && planFor(result) !== "unknown" && planFor(result) !== scenario.expected.primary) classes.add("routing");
  if (scenario?.expected?.topLead && topLeadPath(result) && !scenario.expected.topLead.some(re => re.test(topLeadPath(result)))) classes.add("ranking");
  if (/ambiguous|synonym|variant|query/i.test(result.failures?.join(" ") ?? "")) classes.add("normalization");
  if (/backend/.test(result.id) || /No matching nodes|missing binary|graph missing/i.test(text)) classes.add("backend-capability");
  if (/Safe next step|Diagnose:|Plan recovery:/i.test(text) && /npm run/.test(text) && scenario?.userType === "non-technical") classes.add("UX");
  if (includesProofBoundaryMistake(result)) classes.add("proof-boundary");
  if (!classes.size) classes.add("eval-artifact");
  return [...classes].filter(item => FAILURE_CLASSES.includes(item));
}

function actionFor(result, classes, scenario) {
  if (result.ok) return "stop";
  if (classes.includes("eval-artifact")) return "ignore";
  if (classes.includes("backend-capability") && !classes.some(c => ["routing", "ranking", "readiness", "UX"].includes(c))) return "investigate";
  if (scenario?.impact === "high" || classes.some(c => ["routing", "ranking", "proof-boundary", "noisy-scope"].includes(c))) return "fix-now";
  return "investigate";
}

const SCENARIOS = {
  "project-ownership-explore": {
    family: "ownership / responsibility",
    prompt: "extension responsible for Pi folder and code searching grep tool implementation",
    expectedBehavior: "Use the best ready prepared signal (architecture/graph) and lead with a concrete pi-nav grep implementation range, without falling back to noisy files.",
    expected: { primary: "architecture", topLead: [/src\/tools\/grep\.ts/] },
    impact: "high",
    userType: "technical",
    nearMisses: ["which extension owns code search?", "what handles grep-style folder searching?", "where is code-search responsibility implemented?"],
  },
  "project-implementation-explore": {
    family: "implementation location",
    prompt: "where is grep implemented",
    expectedBehavior: "Use graph/relationship signal and lead with src/tools/grep.ts as a lead, not proof.",
    expected: { primary: "graph", topLead: [/src\/tools\/grep\.ts/] },
    impact: "high",
    userType: "technical",
    nearMisses: ["where does grep live?", "show me the grep tool implementation", "what file implements exact text search?"],
  },
  "project-setup-docs-explore": {
    family: "non-technical setup guidance",
    prompt: "setup docs navigation extension what should user do next",
    expectedBehavior: "Lead with the user-facing navigation setup skill/guide, not internal eval or audit docs that happen to mention setup.",
    expected: { primary: "docs", topLead: [/skills\/navigation-setup\/SKILL\.md/] },
    impact: "high",
    userType: "non-technical",
    nearMisses: ["How do I set this up?", "Where are the setup steps for navigation?", "What should I do next to prepare this repo?"],
  },
  "project-code-search-ownership-explore": {
    family: "ownership / responsibility",
    prompt: "Which extension owns code search in this repo? code search ownership backend source signal",
    expectedBehavior: "Interpret code search ownership as the jeito-codeweave-pi grep/search tool boundary and lead with src/tools/grep.ts, not eval/smoke scripts.",
    expected: { primary: "architecture", topLead: [/src\/tools\/grep\.ts/] },
    impact: "high",
    userType: "technical",
    nearMisses: ["which extension owns code search?", "what handles exact code search?", "who owns grep-style folder searching?"],
  },
  "project-exact-text-ownership-explore": {
    family: "ownership / responsibility",
    prompt: "which extension owns exact text lookup?",
    expectedBehavior: "Treat exact-text lookup as grep/search ownership, explain the grep-vs-find boundary, and lead with src/tools/grep.ts.",
    expected: { primary: "architecture", topLead: [/src\/tools\/grep\.ts/] },
    impact: "medium",
    userType: "technical",
    nearMisses: ["who owns exact text search?", "what handles text lookup in files?", "which tool owns repo text search?"],
  },
  "project-overview-explore": {
    family: "broad orientation",
    prompt: "5-minute repository orientation: main entry points architecture important files to open first",
    expectedBehavior: "Start with README and extension entry points, avoid read-tool implementation and secondary eval/audit docs for first-page orientation.",
    expected: { primary: "files", topLead: [/README\.md/] },
    impact: "medium",
    userType: "non-technical",
    nearMisses: ["Give me the first 5 files to read to understand this repo.", "I’m new here—where should I start?", "What are the main docs and entrypoints for this codebase?", "Orient me to this project without diving into implementation."],
  },
  "trace-disambiguates": {
    family: "exact symbol relationships",
    prompt: "trace registerGrepTool usages",
    expectedBehavior: "Either provide exact usages or refuse to merge ambiguous symbols and ask the agent to choose a candidate.",
    expected: {},
    impact: "medium",
    userType: "technical",
    nearMisses: ["who calls registerGrepTool?", "trace registerExploreTool", "usages of registerGrepTool in src/tools/grep.ts"],
  },
  "clean-overview": {
    family: "unprepared repo orientation",
    prompt: "help me understand this repo",
    expectedBehavior: "With no prepared intelligence, use live files and lead with README/package.",
    expected: { primary: "files", topLead: [/README\.md/] },
    impact: "medium",
    userType: "non-technical",
    nearMisses: ["start here", "what files should I open first?", "beginner guide"],
  },
  "docs-fallback": {
    family: "docs and onboarding",
    prompt: "where are setup docs",
    expectedBehavior: "When enhanced docs are unavailable, explain readiness honestly and lead with the concrete docs/setup.md file, not a generic directory or README.",
    expected: { primary: "docs", topLead: [/docs\/setup\.md/] },
    impact: "medium",
    userType: "non-technical",
    nearMisses: ["where is the setup guide?", "where are install instructions?", "where is onboarding documentation?", "where is the docs folder?"],
  },
  "noisy-prepared-grep": {
    family: "noisy scope with prepared signal",
    prompt: "where is grep implemented",
    expectedBehavior: "Prepared architecture/graph signal should beat .research/.agents/.pi noisy files.",
    expected: { topLead: [/src\/tools\/grep\.ts/] },
    impact: "high",
    userType: "technical",
    nearMisses: ["where is search implemented?", "where does grep happen?", "find grep code in this repo"],
  },
  "broad-grep-refuses": {
    family: "guardrail / efficiency",
    prompt: "grep x across project",
    expectedBehavior: "Refuse overly broad live grep and ask for a narrower path/pattern.",
    expected: {},
    impact: "medium",
    userType: "technical",
    nearMisses: ["grep a", "search for the letter e", "find TODO in entire home directory"],
  },
};

function evaluateToolResult(result) {
  const scenario = SCENARIOS[result.id] ?? { family: "unclassified", prompt: result.id, expectedBehavior: "No scenario card defined.", expected: {}, impact: "low", userType: "technical", nearMisses: [] };
  const classes = classifyFailure(result, scenario);
  const action = actionFor(result, classes, scenario);
  const topLead = topLeadPath(result);
  const good = result.ok;
  const whyItMatters = scenario.impact === "high"
    ? "This is a core navigation path; a bad result sends the agent to the wrong code or noisy scope."
    : scenario.impact === "medium"
      ? "This affects the number of steps and clarity for a normal agent/user."
      : "This is useful as supporting signal but not a primary quality gate.";
  return {
    id: result.id,
    family: scenario.family,
    prompt: scenario.prompt,
    tool: result.tool,
    status: good ? "good" : "bad",
    userImpact: scenario.impact,
    expectedBehavior: scenario.expectedBehavior,
    actualBehavior: result.ok
      ? `Passed. Planned primary: ${planFor(result)}; selected source: ${sourceFor(result)}; top lead: ${topLead || "n/a"}.`
      : `Failed assertions: ${result.failures.join("; ")}. Planned primary: ${planFor(result)}; selected source: ${sourceFor(result)}; top lead: ${topLead || "n/a"}.`,
    failureClasses: classes,
    likelyReason: inferReason(result, scenario, classes),
    nearMissPrompts: scenario.nearMisses,
    recommendedAction: action,
    evidence: { failures: result.failures, topLead: result.topLead, excerpt: result.excerpt },
  };
}

function inferReason(result, scenario, classes) {
  if (result.ok) {
    if (scenario.family === "docs and onboarding") return "The live-files fallback now preserves concrete docs file signal while warning that enhanced docs are not configured.";
    if (scenario.family === "noisy scope with prepared signal") return "Prepared intelligence survived Pi-facing routing/ranking and noisy paths did not win the first lead.";
    if (scenario.family === "implementation location") return "Relationship/graph intent was recognized and the focused implementation file remained first.";
    return "The observed tool behavior matches the scenario's expected useful behavior.";
  }
  if (classes.includes("routing")) return "The conductor likely interpreted the prompt as the wrong intent or chose a weaker primary source.";
  if (classes.includes("ranking")) return "The right source may have been available, but scoring/fusion put a less useful lead first.";
  if (classes.includes("readiness")) return "Prepared intelligence was absent/stale and the fallback or recovery message was insufficient.";
  if (classes.includes("noisy-scope")) return "Local/generated/noisy paths leaked into the high-signal result set.";
  if (classes.includes("UX")) return "The next-step text is probably too implementation-heavy for a non-technical user.";
  if (classes.includes("backend-capability")) return "Raw backend signal appears missing or inaccessible; compare backend output before changing Pi fusion.";
  return "The scenario may be underspecified or the assertion may be overfitted; inspect transcript before fixing code.";
}

function evaluateBackends(backendResults) {
  return backendResults.map(result => ({
    id: result.id,
    status: result.ok ? "good" : result.skipped ? "skipped" : "bad",
    failureClasses: result.ok ? [] : [result.skipped ? "readiness" : "backend-capability"],
    recommendedAction: result.ok ? "stop" : result.skipped ? "investigate" : "investigate",
    whyItMatters: "Backend probes distinguish Core/QMD/Graphify evidence availability from Pi-facing routing or ranking.",
    evidence: { status: result.status, signal: result.signal, reason: result.reason, excerpt: result.excerpt, command: result.command },
  }));
}

function summarize(toolAnalyses, backendAnalyses, toolFeelReport) {
  const bad = toolAnalyses.filter(item => item.status === "bad");
  const fixNow = toolAnalyses.filter(item => item.recommendedAction === "fix-now");
  const investigate = [...toolAnalyses, ...backendAnalyses].filter(item => item.recommendedAction === "investigate");
  const highValue = [...fixNow, ...investigate].find(item => item.userImpact === "high") ?? fixNow[0] ?? investigate[0];
  const allGood = bad.length === 0 && backendAnalyses.every(item => item.status === "good");
  return {
    status: allGood ? "passed" : bad.length ? "attention-needed" : "backend-attention",
    headline: allGood
      ? "No new high-value user-facing failure appeared in this adaptive pass."
      : `Adaptive pass found ${bad.length} tool-facing issue(s) and ${investigate.length} item(s) to inspect.`,
    whatHappened: `${toolFeelReport.summary}. The adaptive layer evaluated ${toolAnalyses.length} tool scenarios and ${backendAnalyses.length} backend probes, and classifies bad outcomes by user impact and failure mode when they appear.`,
    whyItMatters: highValue
      ? `Most important current signal: ${highValue.id} (${highValue.family ?? "backend"}). ${highValue.whyItMatters ?? highValue.expectedBehavior ?? "Inspect evidence."}`
      : "The harness is currently preserving the expected high-signal paths for this scenario set.",
    goodOrBad: allGood ? "Good for this slice, not proof of perfection." : "Bad enough to inspect before adding more broad tests.",
    whatGotSmarter: "The eval engine now explains expected vs actual behavior, classifies failure modes, emits near-miss prompts, and recommends fix/investigate/ignore/stop instead of only printing green/red checks.",
    remainsWeak: [
      "The classifier is heuristic; LLM/subagent review should validate any proposed fix.",
      "Near-miss prompts are generated as investigation leads, not automatically promoted to tests.",
      "This scenario set is intentionally small; it samples high-value navigation paths rather than claiming exhaustive coverage.",
    ],
    recommendedNextAction: fixNow.length
      ? `Fix now: ${fixNow[0].id} (${fixNow[0].failureClasses.join(", ")}). Add only one sharp regression after source/backend evidence confirms the cause.`
      : investigate.length
        ? `Investigate: ${investigate[0].id}. Compare Pi-facing transcript with raw backend/source evidence before editing.`
        : "Stop. Do not add more tests until a fresh live probe exposes a real weakness.",
  };
}

function runToolFeel(args, toolFeelOut) {
  const script = path.join(EXTENSION_ROOT, "scripts", "navigation-tool-feel-eval.mjs");
  const result = spawnSync(process.execPath, [script, "--json", "--out", toolFeelOut, ...args.toolFeelArgs], {
    cwd: EXTENSION_ROOT,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch (error) { throw new Error(`navigation-tool-feel-eval did not emit JSON (${error.message})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`); }
  return { status: result.status, stdout: firstLine(stdout), stderr: excerpt(stderr), report: parsed };
}

function excerpt(text, lines = 20) {
  return String(text ?? "").split("\n").slice(0, lines).join("\n");
}

async function main() {
  const args = parseArgs();
  if (args.help) { console.log(usage()); return; }
  const toolFeelOut = args.toolFeelOut ?? path.join(path.dirname(args.out), "tool-feel.json");
  await mkdir(path.dirname(args.out), { recursive: true });
  await mkdir(path.dirname(toolFeelOut), { recursive: true });
  const toolFeelRun = runToolFeel(args, toolFeelOut);
  const report = toolFeelRun.report;
  const toolAnalyses = (report.toolResults ?? []).map(evaluateToolResult);
  const backendAnalyses = evaluateBackends(report.backendResults ?? []);
  const summary = summarize(toolAnalyses, backendAnalyses, report);
  const adaptiveReport = {
    status: summary.status,
    generatedAt: new Date().toISOString(),
    proofLevel: `${report.proofLevel} Adaptive classifications are heuristic and should be validated against live source/backend evidence before editing.`,
    toolFeelReport: toolFeelOut,
    sourceReportSummary: report.summary,
    summary,
    scenarios: toolAnalyses,
    backendProbes: backendAnalyses,
    failureClasses: FAILURE_CLASSES,
  };
  await writeFile(args.out, `${JSON.stringify(adaptiveReport, null, 2)}\n`);
  if (args.json) console.log(JSON.stringify(adaptiveReport, null, 2));
  else {
    console.log(`${adaptiveReport.status.toUpperCase()}: ${summary.headline}`);
    console.log(`What happened: ${summary.whatHappened}`);
    console.log(`Why it matters: ${summary.whyItMatters}`);
    console.log(`Good or bad: ${summary.goodOrBad}`);
    console.log(`What got smarter: ${summary.whatGotSmarter}`);
    console.log(`Still weak: ${summary.remainsWeak.join(" ")}`);
    console.log(`Next action: ${summary.recommendedNextAction}`);
    console.log("\nScenario decisions:");
    for (const item of toolAnalyses) {
      const classes = item.failureClasses.length ? item.failureClasses.join(",") : "none";
      console.log(`- ${item.id}: ${item.status}; action=${item.recommendedAction}; class=${classes}; top=${topLeadPath(item.evidence) || "n/a"}`);
    }
    console.log(`Report: ${args.out}`);
    console.log(`Tool transcript: ${toolFeelOut}`);
  }
  if (toolFeelRun.status !== 0 || summary.status !== "passed") process.exitCode = 1;
}

main().catch(error => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
