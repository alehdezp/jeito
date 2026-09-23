import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  DENSITIES,
  DENSITY_BUDGETS,
  EXPECTED_TOOLS,
  ROLE_CODES,
  ROLE_THEME,
  SCENARIOS,
  TOOL_CASES,
  renderCatalogCase,
  scenarioAvailable,
  setDensity,
} from "./jeito-ui-catalog.mjs";

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const stripAnsi = value => String(value ?? "").replace(ANSI_RE, "");
const sorted = values => [...values].sort((left, right) => left.localeCompare(right));

function railColorCode(line) {
  const railIndex = String(line).indexOf("│");
  if (railIndex < 0) return "";
  return (String(line).slice(0, railIndex).match(/\x1b\[[0-9;]*m/g) ?? []).at(-1) ?? "";
}

function registrationSources() {
  const files = [];
  for (const directory of ["extensions/codeweave-pi/src/tools", "extensions/websift/src/tools"]) {
    for (const name of readdirSync(directory)) if (name.endsWith(".ts")) {
      const path = join(directory, name);
      const source = readFileSync(path, "utf8");
      if (source.includes("renderCall:")) files.push(source);
    }
  }
  files.push(readFileSync("extensions/shell/index.ts", "utf8"));
  files.push(readFileSync("extensions/tooltap/extensions/index.ts", "utf8"));
  return files;
}

function registeredRenderedTools() {
  const names = new Set(["tools"]); // tooltap registers the CONTROL_NAME constant rather than a string literal.
  for (const source of registrationSources()) {
    for (const match of source.matchAll(/registerTool(?:<[^>]+>)?\s*\(\s*\{[\s\S]*?\bname:\s*["'`]([^"'`]+)["'`]/g)) names.add(match[1]);
    if (/registerEntryRenderer\?\.\("job-done"|registerEntryRenderer\("job-done"/.test(source)) names.add("job-done");
  }
  return names;
}

function catalogDataSnapshot() {
  return JSON.stringify(TOOL_CASES.map(item => ({ tool: item.tool, args: item.args, success: item.success, failure: item.failure, scenarios: item.scenarios })));
}

test("visual gallery inventory covers every registered jeito renderer", () => {
  const catalogTools = TOOL_CASES.map(item => item.tool);
  assert.equal(new Set(catalogTools).size, catalogTools.length, "each rendered tool needs one gallery owner");
  assert.deepEqual(sorted(catalogTools), sorted(EXPECTED_TOOLS));
  assert.deepEqual(sorted(registeredRenderedTools()), sorted(EXPECTED_TOOLS));
});

test("every available scenario obeys semantic visual contracts at narrow and normal widths", () => {
  const before = catalogDataSnapshot();
  let rendered = 0;
  for (const width of [56, 88]) {
    for (const item of TOOL_CASES) {
      for (const scenario of SCENARIOS) {
        if (!scenarioAvailable(item, scenario)) continue;
        for (const density of DENSITIES) {
          const label = `${item.tool}/${scenario}/${density}/${width}`;
          const lines = renderCatalogCase(item, scenario, density, width, ROLE_THEME);
          rendered++;
          assert.ok(Array.isArray(lines) && lines.length > 0, `${label}: renderer must return visible lines`);
          assert.ok(lines.length <= DENSITY_BUDGETS[density], `${label}: ${lines.length} lines exceeds the ${DENSITY_BUDGETS[density]}-line density budget`);
          for (const line of lines) {
            assert.notEqual(stripAnsi(line).trim(), "", `${label}: blank UI rows waste vertical space`);
            assert.ok(visibleWidth(line) <= width, `${label}: ${visibleWidth(line)} columns exceeds width ${width}`);
          }

          const plain = stripAnsi(lines.join("\n"));
          const styled = lines.join("\n");
          if (density === "ultra") {
            assert.equal(lines.length, 1, `${label}: ultra is exactly one line`);
            assert.match(plain, /^[✓✗⚠…◐]/u, `${label}: status must lead the scan order`);
            assert.doesNotMatch(plain, /[╭│╰]/u, `${label}: ultra must not retain a frame fragment`);
            assert.ok(styled.includes(ROLE_CODES.toolTitle), `${label}: tool identity needs the tool-title color role`);
            assert.ok(styled.includes(ROLE_CODES.accent), `${label}: target/detail needs the accent color role`);
            const expectedStatus = scenario === "pending" ? ROLE_CODES.warning : scenario === "failure" ? ROLE_CODES.error : undefined;
            if (expectedStatus) assert.ok(styled.includes(expectedStatus), `${label}: scenario status needs its semantic color role`);
            else assert.ok([ROLE_CODES.success, ROLE_CODES.warning, ROLE_CODES.error].some(code => styled.includes(code)), `${label}: completed status needs a semantic color role`);
            if (scenario !== "pending") assert.ok(styled.includes(ROLE_CODES.muted), `${label}: metrics need a quieter color role than tool identity`);
            if (width === 56 && scenario === "success" && ["read", "edit", "write"].includes(item.tool)) {
              assert.match(plain, /hash [0-9A-F]{8}/u, `${label}: mutation authority outranks lower-value metrics at narrow width`);
            }
          } else {
            assert.match(stripAnsi(lines[0]), /^╭──/u, `${label}: framed modes need one header`);
            assert.match(stripAnsi(lines.at(-1)), /^╰──/u, `${label}: framed modes need one footer`);
            const bodyRows = lines.slice(1, -1);
            for (const line of bodyRows) assert.match(stripAnsi(line), /^│/u, `${label}: body rows must stay attached to the frame`);

            const omissionRows = bodyRows.filter(line => /(?:UI truncated|more (?:UI |diff |written |output |earlier output )?lines? hidden|more diff rows hidden)/iu.test(stripAnsi(line)));
            const evidenceRow = bodyRows.find(line => !omissionRows.includes(line));
            for (const omissionRow of omissionRows) {
              assert.ok(railColorCode(omissionRow), `${label}: omission notes need a colored card rail`);
              if (evidenceRow) assert.equal(railColorCode(omissionRow), railColorCode(evidenceRow), `${label}: omission rail must keep the card's current color`);
              assert.ok(omissionRow.slice(omissionRow.indexOf("│") + 1).includes(ROLE_CODES.muted), `${label}: omission text should stay quieter than the rail`);
            }
            if (item.family === "shell") {
              const chromeRole = scenario === "pending" ? ROLE_CODES.warning : scenario === "failure" ? ROLE_CODES.error : ROLE_CODES.success;
              assert.ok(lines[0].includes(chromeRole), `${label}: shell top chrome must follow status`);
              assert.ok(lines.at(-1).includes(chromeRole), `${label}: shell footer chrome must follow status`);
            }
          }
        }
      }
    }
  }
  assert.equal(rendered, 792, "25 surfaces × four scenarios × four densities × two widths, minus inapplicable pending job-done");
  assert.equal(catalogDataSnapshot(), before, "TUI rendering must not mutate model-visible fixtures or call arguments");
});

test("pending calls and call-result joins cannot leave disconnected card fragments", () => {
  for (const item of TOOL_CASES.filter(item => !item.direct)) {
    for (const density of ["condensed", "normal", "extended"]) {
      const lines = renderCatalogCase(item, "pending", density, 88, ROLE_THEME);
      assert.equal(lines.length, 2, `${item.tool}/${density}: pending call should be one quiet header/footer card, not a loose title`);
    }
  }

  for (const tool of ["read", "bash", "tools", "web_search", "context7"]) {
    const item = TOOL_CASES.find(candidate => candidate.tool === tool);
    setDensity("condensed");
    const context = { width: 88, cwd: "/workspace/demo", state: {} };
    const card = item.call(item.args, ROLE_THEME, context);
    const resultStub = item.result(item.success, { expanded: false, width: 88 }, ROLE_THEME, context);
    assert.deepEqual(resultStub.render(88), [], `${tool}: result renderer must not append a second card`);
    const joined = card.render(88);
    assert.match(stripAnsi(joined[0]), /^╭──/u);
    assert.match(stripAnsi(joined.at(-1)), /^╰──/u);
  }
});

test("overflow reveals progressively more evidence instead of preserving arbitrary output strings", () => {
  for (const tool of ["read", "bash", "tools", "web_search", "job-done"]) {
    const item = TOOL_CASES.find(candidate => candidate.tool === tool);
    const counts = Object.fromEntries(DENSITIES.map(density => [density, renderCatalogCase(item, "overflow", density, 88, ROLE_THEME).length]));
    assert.equal(counts.ultra, 1, `${tool}: ultra stays one line`);
    assert.equal(counts.condensed, 8, `${tool}: an overflowing condensed card should use its useful eight-line budget`);
    assert.ok(counts.normal > counts.condensed, `${tool}: normal should reveal more than condensed`);
    assert.ok(counts.extended > counts.normal, `${tool}: extended should reveal more than normal`);
  }
});

test("completed automatic jobs never collapse into the orphaned failed header", () => {
  const item = TOOL_CASES.find(candidate => candidate.tool === "job-done");
  const ultra = renderCatalogCase(item, "failure", "ultra", 180, ROLE_THEME);
  assert.equal(ultra.length, 1);
  assert.match(stripAnsi(ultra[0]), /^✗ jobs job-7 · failed · exit 1/u);

  const condensed = renderCatalogCase(item, "failure", "condensed", 180, ROLE_THEME);
  assert.ok(condensed.length > 2, "failed completion needs diagnostics, not only a title line");
  assert.doesNotMatch(stripAnsi(condensed[0]), /job-7 failed/u, "status belongs in the footer/ultra metric, not duplicated in the header");
  assert.match(stripAnsi(condensed.join("\n")), /Inspect: jobs\(\{ id: "job-7", delta: true \}\)/u);
  assert.match(stripAnsi(condensed.at(-1)), /^╰── ✗ job-7 failed · exit 1/u);
  assert.doesNotMatch(stripAnsi(condensed.join("\n")), /no action required/iu, "successful or failed completion should show evidence, not filler");
});

test("registration preserves the host implementation without a disabling environment flag", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-host-registration-"));
  const directory = join(root, "dist", "modes", "interactive", "components");
  const target = join(directory, "tool-execution.js");
  const entry = join(root, "dist", "cli.js");
  const source = `class ToolExecutionComponent { render() { const lines = []; const contentLines = []; if (contentLines.length > 0) {\n  lines.push("");\n  lines.push(...contentLines);\n  } return lines; } }`;
  const oldEntry = process.argv[1];
  const oldDisabled = process.env.PI_JEITO_HOST_PATCH;
  const oldForce = process.env.PI_JEITO_HOST_PATCH_FORCE;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0" }));
    writeFileSync(target, source);
    writeFileSync(entry, "// fixture entry");
    process.argv[1] = entry;
    delete process.env.PI_JEITO_HOST_PATCH;
    process.env.PI_JEITO_HOST_PATCH_FORCE = "1";
    const { default: register } = await import("../extensions/codeweave-pi/index.ts");
    const tools = [];
    register({ on() {}, registerCommand() {}, registerShortcut() {}, appendEntry() {}, registerTool(tool) { tools.push(tool); } });
    assert.equal(readFileSync(target, "utf8"), source, "registration must not rewrite installed Pi");
    assert.deepEqual(readdirSync(directory), ["tool-execution.js"], "no host backup or temporary patch file");
    assert.ok(tools.some(tool => tool.name === "grep" && tool.renderShell === "self"));
    assert.ok(tools.some(tool => tool.name === "edit" && tool.renderCall && tool.renderResult));
  } finally {
    process.argv[1] = oldEntry;
    if (oldDisabled === undefined) delete process.env.PI_JEITO_HOST_PATCH;
    else process.env.PI_JEITO_HOST_PATCH = oldDisabled;
    if (oldForce === undefined) delete process.env.PI_JEITO_HOST_PATCH_FORCE;
    else process.env.PI_JEITO_HOST_PATCH_FORCE = oldForce;
    rmSync(root, { recursive: true, force: true });
  }
});
