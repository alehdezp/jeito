#!/usr/bin/env node
import { visibleWidth } from "@earendil-works/pi-tui";
import { DENSITIES, DENSITY_BUDGETS, GALLERY_WIDTHS, SCENARIOS, TOOL_CASES, VISUAL_THEME, renderCatalogCase, scenarioAvailable } from "./jeito-ui-catalog.mjs";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const MUTED = "\x1b[38;2;139;148;158m";
const ACCENT = "\x1b[38;2;137;220;235m";
const ERROR = "\x1b[38;2;243;139;168m";
const REVIEW = "Review: status → tool → target → metric · useful evidence first · truncation honest · failures actionable";
const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--all" || value === "--list" || value === "--help") out[value.slice(2)] = true;
    else if (value.startsWith("--")) out[value.slice(2)] = argv[++index];
  }
  return out;
}

function help() {
  console.log(`jeito interactive UI gallery\n\nUsage:\n  npm run ui:gallery\n  npm run ui:gallery -- --tool job-done --scenario failure\n  npm run ui:gallery -- --all --tool jobs --width 88\n\nInteractive keys:\n  ←/→ or h/l   previous/next tool\n  ↑/↓ or k/j   previous/next scenario\n  u             cycle ultra/condensed/normal/extended\n  w             cycle 56/88/120-column review widths\n  a             show one density or all four\n  q or Esc      quit\n\nCLI filters: --tool, --scenario, --density, --width, --all, --list`);
}

function findIndex(values, requested, fallback = 0) {
  if (requested === undefined) return fallback;
  const index = values.findIndex(value => String(value) === String(requested));
  if (index < 0) throw new Error(`Unknown value ${requested}. Choose one of: ${values.join(", ")}`);
  return index;
}

function visibleRule(width) {
  return `${MUTED}${"┄".repeat(Math.max(8, width - 1))}┤ ${width} columns${RESET}`;
}

function railColorCode(line) {
  const railIndex = String(line).indexOf("│");
  if (railIndex < 0) return "";
  return (String(line).slice(0, railIndex).match(/\x1b\[[0-9;]*m/g) ?? []).at(-1) ?? "";
}

function renderCard(item, scenario, density, width) {
  try {
    const lines = renderCatalogCase(item, scenario, density, width, VISUAL_THEME);
    if (!lines.length) return `${MUTED}(scenario not applicable)${RESET}`;
    const plain = value => String(value).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
    const warnings = [];
    if (lines.length > DENSITY_BUDGETS[density]) warnings.push(`${lines.length}/${DENSITY_BUDGETS[density]} lines`);
    if (lines.some(line => visibleWidth(line) > width)) warnings.push(`content exceeds ${width} columns`);
    if (density === "ultra" && (lines.length !== 1 || plain(lines[0]).startsWith("╭"))) warnings.push("ultra must be one frameless line");
    if (density !== "ultra" && (!plain(lines[0]).startsWith("╭") || !plain(lines.at(-1)).startsWith("╰"))) warnings.push("framed mode lost its top or footer");
    if (density !== "ultra") {
      const bodyRows = lines.slice(1, -1);
      const omissionRows = bodyRows.filter(line => /(?:UI truncated|Ctrl\+U to show)/iu.test(plain(line)));
      const evidenceRow = bodyRows.find(line => !omissionRows.includes(line));
      if (omissionRows.some(line => !railColorCode(line) || (evidenceRow && railColorCode(line) !== railColorCode(evidenceRow)))) warnings.push("omission note lost the card rail color");
      if (omissionRows.some(line => !line.slice(line.indexOf("│") + 1).includes(MUTED))) warnings.push("omission text is not muted");
    }
    return `${lines.join("\n")}${warnings.length ? `\n${ERROR}⚠ visual contract: ${warnings.join(" · ")}${RESET}` : ""}`;
  } catch (error) {
    return `${ERROR}Gallery fixture failed: ${error instanceof Error ? error.stack : String(error)}${RESET}`;
  }
}

function scenarioFor(item, preferredIndex, direction = 1) {
  let index = preferredIndex;
  for (let attempts = 0; attempts < SCENARIOS.length; attempts++) {
    if (scenarioAvailable(item, SCENARIOS[index])) return index;
    index = (index + direction + SCENARIOS.length) % SCENARIOS.length;
  }
  return preferredIndex;
}

function printReview(items, scenarios, densities, width) {
  console.log(`${MUTED}${REVIEW}${RESET}`);
  for (const item of items) {
    for (const scenario of scenarios) {
      if (!scenarioAvailable(item, scenario)) continue;
      for (const density of densities) {
        console.log(`\n${BOLD}${item.family} / ${item.tool}${RESET} ${ACCENT}${scenario}${RESET} ${MUTED}${density} · ${width} columns${RESET}`);
        console.log(visibleRule(width));
        console.log(renderCard(item, scenario, density, width));
      }
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { help(); process.exit(0); }
if (args.list) {
  for (const [index, item] of TOOL_CASES.entries()) console.log(`${String(index + 1).padStart(2)}  ${item.family.padEnd(10)} ${item.tool}`);
  process.exit(0);
}

let toolIndex = args.tool ? findIndex(TOOL_CASES.map(item => item.tool), args.tool) : findIndex(TOOL_CASES.map(item => item.tool), "job-done");
let scenarioIndex = findIndex(SCENARIOS, args.scenario, 1);
let densityIndex = findIndex(DENSITIES, args.density, 1);
let widthIndex = args.width ? findIndex(GALLERY_WIDTHS, Number(args.width)) : 1;
let showAllDensities = false;
scenarioIndex = scenarioFor(TOOL_CASES[toolIndex], scenarioIndex);

if (args.all || !process.stdin.isTTY || !process.stdout.isTTY) {
  const items = args.tool ? [TOOL_CASES[toolIndex]] : TOOL_CASES;
  const scenarios = args.scenario ? [SCENARIOS[scenarioIndex]] : SCENARIOS;
  const densities = args.density ? [DENSITIES[densityIndex]] : DENSITIES;
  printReview(items, scenarios, densities, GALLERY_WIDTHS[widthIndex]);
  process.exit(0);
}

function draw() {
  const item = TOOL_CASES[toolIndex];
  const scenario = SCENARIOS[scenarioIndex];
  const width = Math.min(GALLERY_WIDTHS[widthIndex], Math.max(24, process.stdout.columns || GALLERY_WIDTHS[widthIndex]));
  const densities = showAllDensities ? DENSITIES : [DENSITIES[densityIndex]];
  const sections = densities.map(density => `${BOLD}${density}${RESET} ${MUTED}${width} columns${RESET}\n${visibleRule(width)}\n${renderCard(item, scenario, density, width)}`);
  const header = `${BOLD}jeito UI gallery${RESET}  ${MUTED}${toolIndex + 1}/${TOOL_CASES.length}${RESET}  ${ACCENT}${item.family} / ${item.tool}${RESET}  ${BOLD}${scenario}${RESET}`;
  const controls = `${MUTED}←/→ tool · ↑/↓ scenario · u density · w width · a all modes · q quit${RESET}`;
  process.stdout.write(`${CLEAR}${header}\n${controls}\n${MUTED}${REVIEW}${RESET}\n\n${sections.join("\n\n")}\n`);
}

function moveTool(delta) {
  toolIndex = (toolIndex + delta + TOOL_CASES.length) % TOOL_CASES.length;
  scenarioIndex = scenarioFor(TOOL_CASES[toolIndex], scenarioIndex, delta < 0 ? -1 : 1);
}
function moveScenario(delta) {
  scenarioIndex = (scenarioIndex + delta + SCENARIOS.length) % SCENARIOS.length;
  scenarioIndex = scenarioFor(TOOL_CASES[toolIndex], scenarioIndex, delta);
}
function cleanup() {
  if (process.stdin.isRaw) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`${SHOW_CURSOR}${ALT_OFF}${RESET}`);
}

process.stdout.write(`${ALT_ON}${HIDE_CURSOR}`);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", key => {
  if (key === "q" || key === "\x1b" || key === "\x03") { cleanup(); process.exit(0); }
  if (key === "\x1b[D" || key === "h") moveTool(-1);
  else if (key === "\x1b[C" || key === "l") moveTool(1);
  else if (key === "\x1b[A" || key === "k") moveScenario(-1);
  else if (key === "\x1b[B" || key === "j") moveScenario(1);
  else if (key === "u") densityIndex = (densityIndex + 1) % DENSITIES.length;
  else if (key === "w") widthIndex = (widthIndex + 1) % GALLERY_WIDTHS.length;
  else if (key === "a") showAllDensities = !showAllDensities;
  draw();
});
process.on("SIGTERM", () => { cleanup(); process.exit(143); });
process.on("exit", () => { if (process.stdin.isRaw) cleanup(); });
draw();
