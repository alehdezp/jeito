import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import jeitoCodeweavePiExtension from "../index.ts";

const referenceUrl = new URL("../docs/tool-operating-reference.md", import.meta.url);
const doctrineUrl = new URL("../docs/harness-doctrine.md", import.meta.url);
const evaluationUrl = new URL("../docs/evaluation-workflow.md", import.meta.url);

function registeredTools() {
  const tools = new Map();
  jeitoCodeweavePiExtension({
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    getActiveTools() { return []; },
    getAllTools() { return [...tools.values()]; },
  });
  return tools;
}

function section(markdown, toolName) {
  const heading = `## \`${toolName}\``;
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const next = markdown.indexOf("\n## ", start + heading.length);
  return markdown.slice(start, next === -1 ? markdown.length : next);
}

function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker ${endMarker}`);
  return text.slice(start, end);
}

function numericContracts(schema) {
  const contracts = new Set();
  const visit = value => {
    if (!value || typeof value !== "object") return;
    for (const key of ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"]) {
      if (Number.isFinite(value[key])) contracts.add(String(value[key]));
    }
    const description = String(value.description ?? "");
    for (const match of description.matchAll(/\b(?:page\s+size|depth|integer|limit)\s+(\d+)\s*[-–]\s*(\d+)\b/gi)) contracts.add(`${match[1]}-${match[2]}`);
    for (const match of description.matchAll(/\b(?:default(?:s)?(?:\s+to)?|capped(?:\s+at)?|maximum|at\s+most|up\s+to)\s+(\d+)\b/gi)) contracts.add(match[1]);
    if (value.items) visit(value.items);
  };
  visit(schema);
  return [...contracts];
}

function normalizeNumericText(text) {
  return String(text).replace(/[–—]/g, "-").replace(/\s+/g, " ");
}

test("tool operating reference inventories every registered tool and public parameter", async () => {
  const markdown = await readFile(referenceUrl, "utf8");
  for (const [name, tool] of registeredTools()) {
    const body = section(markdown, name);
    const properties = tool.parameters?.properties ?? {};
    for (const parameter of Object.keys(properties)) {
      assert.ok(
        body.includes(`| \`${parameter}\` |`),
        `${name}.${parameter} is missing from the operating-reference parameter table`,
      );
    }
    const documented = [...body.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]).sort();
    assert.deepEqual(documented, Object.keys(properties).sort(), `${name} parameter table drifted from the registered schema`);
    assert.match(body, /Coverage:/, `${name} is missing a coverage statement`);
  }
});

test("tool operating reference preserves registered numeric limits and defaults", async () => {
  const markdown = await readFile(referenceUrl, "utf8");
  for (const [name, tool] of registeredTools()) {
    const body = section(markdown, name);
    for (const [parameter, schema] of Object.entries(tool.parameters?.properties ?? {})) {
      const row = body.match(new RegExp("^\\| `" + parameter + "` \\|.*$", "m"))?.[0] ?? "";
      for (const contract of numericContracts(schema)) {
        assert.ok(normalizeNumericText(row).includes(contract), `${name}.${parameter} numeric contract ${contract} is absent from its reference row`);
      }
    }
  }
});

test("tool operating reference keeps high-leverage and query-construction features reviewable", async () => {
  const markdown = await readFile(referenceUrl, "utf8");
  const expectations = new Map([
    ["explore", [
      /Default code-search call/i,
      /Invocation trigger:[\s\S]*which implementation owns a behavior/i,
      /Mixed results prioritize non-test candidates[\s\S]*test-only result sets remain visible/i,
      /orders edges touching the start identity first/i,
      /After a result reports FTS\/keyword mode/i,
      /qualified-name\/kind boosts/i,
      /native `explain` resolution[\s\S]*exact graph node ID/i,
      /Start nodes/i,
      /NODE and EDGE rows page independently/i,
      /Invocation trigger:[\s\S]*call map as soon as one concrete path/i,
      /Re-enter map when any result supplies a stronger identity/i,
      /exact_anchor_status/i,
      /BFS depth 1–6, default 2/i,
      /Page size 1–300, default 80/i,
      /Start normal search, traversal, and map calls by omitting `limit`[\s\S]*default 80/i,
      /Raise `limit` toward 300[\s\S]*omitted candidates, nodes, or edges/i,
      /up to 80 nodes plus 80 edges/i,
      /does not filter code\/map results to a subtree/i,
    ]],
    ["trace", [/Invocation trigger:[\s\S]*call trace as soon as the exact identity is known/i, /2-4 identities sharing one relation/i, /single targets default to 50, batches default to and cap at 15/i, /Start normal single-target relations by omitting `limit`[\s\S]*default 50/i, /`limit:100`–`200`[\s\S]*dense relation/i, /Batches remain fixed at 15 rows per target/i, /Continue each batch target separately/i, /direct relationship edges from supplemental `tests_for` candidates/i, /exact versus synthetic site/i]],
    ["docs_search", [
      /first six unique meaningful terms/i,
      /One query drives every active ranking path/i,
      /exact title equality receives the strongest title prior/i,
      /hard-filtered afterward/i,
      /default 20, capped at 50/i,
    ]],
    ["grep", [
      /first-class high-power discovery tool/i,
      /Ranked grep/i,
      /Deterministic matches grep/i,
      /Unknown\/expired\/evicted cursors fail closed/i,
      /`smart` default/i,
      /Matches-only integer 0–10/i,
    ]],
    ["find", [/defaults to cwd/i, /`mtime` default/i, /capped native budget/i, /independent zero\/completeness outcome/i]],
    ["ls", [/`list` default/i, /Tree-only depth 1–8, default 2/i, /list defaults to mtime and tree to path/i, /list for neighbor metadata, tree when hierarchy changes/i]],
    ["read", [
      /Single-file advanced selectors/i,
      /Multi-file read/i,
      /up to eight independently known files/i,
      /current hash and seen-line authority/i,
      /1–8 known-file selectors; each string is capped at 4096 characters/i,
    ]],
    ["diff", [/`summary` default/i, /Non-negative context lines/i, /never merges staged and unstaged/i, /byte-first/i, /separately statused planning context/i]],
    ["lsp_validate", [/Resolved-file limit 1–100, default\/hard maximum 100/i, /Clean, diagnostics, unsupported, timeout, skipped, and unconfirmed are distinct/i]],
    ["edit", [
      /Multi-file edit/i,
      /not filesystem-wide atomic/i,
      /Certified structural operations/i,
      /CHECK LSP/i,
      /RETRY N/i,
      /Parser tolerance marked reference-only/i,
    ]],
    ["write", [/empty string is valid, NUL\/binary-like content refused/i, /must be exactly `true`/i, /read\+edit for targeted existing-file changes/i]],
  ]);

  for (const [name, patterns] of expectations) {
    const body = section(markdown, name);
    for (const pattern of patterns) assert.match(body, pattern, `${name} is missing ${pattern}`);
  }
  assert.match(markdown, /Confidence rule:[\s\S]*normal callable evidence capabilities/i);

  assert.match(markdown, /Fresh GPT-5\.6 Sol\/low agent-choice evaluation passes\./);
  assert.match(markdown, /Fresh GPT-5\.6 Luna\/low release evaluation passes\./);
});

test("harness doctrine requires exhaustive implementation-derived operational literacy", async () => {
  const doctrine = await readFile(doctrineUrl, "utf8");
  assert.match(doctrine, /close the ownership gap between an unresolved claim and a field list/i);
  assert.match(doctrine, /paging, batching, multi-file operation, cursors, selectors, structural operations, validation, or recovery/i);
  assert.match(doctrine, /Registered prepared capabilities are callable by default/i);
  assert.match(doctrine, /without speculative readiness, enablement, indexing, freshness, or “if it works” preconditions/i);
  assert.match(doctrine, /Search construction must be implementation-derived/i);
  assert.match(doctrine, /semantic, hybrid, lexical, graph, and document retrieval/i);
  assert.match(doctrine, /tool-operating-reference\.md[\s\S]*every registered public parameter and agent-facing advanced operation/i);
  assert.match(doctrine, /schema-drift test must fail/i);
  assert.match(doctrine, /all four surfaces rather than treating source\/schema review as behavioral proof/i);
  assert.match(doctrine, /cross-domain topology remains unresolved[\s\S]*Invoke `explore\(map\)` at the first concrete identity/i);
  assert.match(doctrine, /correctly explains why a capability applied but omits the call/i);
  assert.match(doctrine, /implementation ownership is consequential[\s\S]*Invoke `explore\(code, search\)` at the first behavior\/signature clue/i);
  assert.match(doctrine, /exact code identity is known but its neighborhood remains inferred[\s\S]*invoke traversal/i);
});

test("evaluation treats prepared-tool confidence as adherence rather than readiness", async () => {
  const evaluation = await readFile(evaluationUrl, "utf8");
  assert.match(evaluation, /directly callable without health preflight/i);
  assert.match(evaluation, /Lexical or otherwise reduced active modes must remain usable prepared evidence/i);
  assert.match(evaluation, /request-specific diagnostics must constrain the returned claim without reducing willingness/i);
  assert.match(evaluation, /capture\/runtime blocker does not establish that prepared tools are unavailable or unreliable/i);
  assert.match(evaluation, /implementation questions, score identity and structural closure/i);
  assert.match(evaluation, /stops after rank one, or explains the omitted CRG call postmortem fails/i);
});

test("APPEND-maintainer skill enforces exhaustive tool-guidance intent", { skip: !process.env.PI_APPEND_MAINTAINER_SKILL_PATH }, async () => {
  const skill = await readFile(process.env.PI_APPEND_MAINTAINER_SKILL_PATH, "utf8");
  assert.match(skill, /Operational tool-guidance intent/);
  assert.match(skill, /Inventory before drafting[\s\S]*every public parameter and agent-facing advanced operation/i);
  assert.match(skill, /Intent → Construction → Leverage → Interpretation → Adaptation\/stop/);
  assert.match(skill, /Make confidence the default[\s\S]*normal callable evidence source/i);
  assert.match(skill, /batching, multi-file operation, paging\/cursors, selectors, structural edits, validation, retries/i);
  assert.match(skill, /concrete invocation trigger, a result-driven re-entry trigger, and a closure self-check/i);
  assert.match(skill, /explain why a capability applied but never invokes it has failed the bridge/i);
  assert.match(skill, /tool-operating-reference\.md[\s\S]*harness-doctrine\.md[\s\S]*Update both/i);
  assert.match(skill, /prepared capabilities are callable by default without speculative readiness\/freshness hedges[\s\S]*confidence-contract coverage pass/i);
});


test("prepared public descriptions recommend direct use without speculative health gates", () => {
  const tools = registeredTools();
  for (const name of ["explore", "trace", "docs_search"]) {
    const tool = tools.get(name);
    const text = [tool.description, ...Object.values(tool.parameters?.properties ?? {}).map(value => value.description ?? "")].join("\n");
    assert.doesNotMatch(text, /when semantic[^\n]*ready|if semantic[^\n]*degrad|embedding readiness|semantic readiness|might not work|could be stale|potentially lagging/i, `${name} contains a speculative confidence deterrent`);
  }
  assert.match(tools.get("explore").description, /find the code behind a behavior/);
  assert.match(tools.get("explore").description, /look around a symbol you already found/);
  assert.match(tools.get("explore").description, /how code and docs connect/);
  assert.match(tools.get("trace").description, /one wiring question/);
  assert.match(tools.get("docs_search").description, /search the project's documentation by meaning/i);
  assert.match(tools.get("docs_search").description, /grep for docs, but matching ideas, not words/);
});
