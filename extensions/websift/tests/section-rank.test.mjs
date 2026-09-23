// Decision protected: local query ranking preserves Markdown structure, exact locators, size bounds, heading weight, and true-absence behavior.
// Unit proof for the query-guided section ranker (Tier 1 of the web_fetch query contract).
// Splitter: fence awareness, paragraph sub-splitting, root preamble, list-item labels.
// Ranker: heading weighting, relevance floor, not-found contract.
import assert from "node:assert/strict";
import test from "node:test";
import { headingNav, queryDocuments, querySections, SUB_CHARS } from "../src/section-rank.ts";

test("heading-looking lines inside code fences do not split sections", () => {
  const body = "# Title\n\n## Real heading\n\n```sh\n# not a heading\nnpm install -g tool\n```\n\nafter the fence\n";
  const rank = querySections(body, "npm install");
  const fake = rank.sections.find((s) => s.heading === "not a heading");
  assert.equal(fake, undefined, "fence content must stay inside the enclosing section");
  assert.ok(rank.sections.some((s) => s.text.includes("npm install -g tool")));
});

test("content before the first heading ranks as the root unit", () => {
  const body = "prime meridian nickname text lives here\n\n## Landslides\n\nnothing relevant\n";
  const rank = querySections(body, "prime meridian");
  assert.equal(rank.sections[0].heading, "");
  assert.match(rank.sections[0].text, /prime meridian nickname/);
});

test("oversized sections sub-split at paragraph boundaries with exact line ranges", () => {
  const longPara = "para-one ".repeat(SUB_CHARS);
  const body = `# Title\n\n## Big\n\n${longPara}\n\n## Needle\n\nneedle text here`;
  const rank = querySections(body, "needle");
  const hit = rank.sections.find((s) => s.heading === "Needle");
  assert.ok(hit, `"Needle" must rank in top-3, got ${rank.sections.map((s) => `"${s.heading}"`).join(", ")}`);
  // Heading at line 7; body spans the separator blank line and the content line.
  assert.equal(hit.startLine, 8);
  assert.equal(hit.endLine, 9);
  assert.equal(hit.text, "needle text here");
  assert.ok(rank.sections.every((s) => s.text.length <= SUB_CHARS + 80), "every ranked unit respects the size cap");
});

test("list items under a heading split into separate units with first-line labels", () => {
  const pad = " with plenty of surrounding detail and context words ".repeat(50);
  const body = `## Top Comments\n\n- Lots of people are talking about Graphify${pad}\n\n- Hey man, I am the creator of GitNexus${pad}\n\n- Graphify is not capable of handling large repos${pad}\n`;
  const rank = querySections(body, "gitnexus creator");
  assert.equal(rank.sections[0].heading.startsWith("- Hey man"), true, `expected the GitNexus comment unit, got "${rank.sections[0].heading}"`);
  assert.match(rank.sections[0].text, /creator of GitNexus/);
});

test("heading tokens weigh more than equal body tokens", () => {
  const body = "# Title\n\n## install\n\nnothing relevant here installs not at all anywhere else\n\n## Other\n\ninstall nothing relevant here installs not at all anywhere\n";
  const rank = querySections(body, "install");
  assert.equal(rank.sections[0].heading, "install", "the heading-weighted unit must outrank the body-only match");
});

test("headingNav lists levels 1-3 outside fences with exact line numbers", () => {
  const body = "# Title\n\n## Real heading\n\n```md\n# not a nav heading\n```\n\n### Sub heading\n\n#### Deep heading (excluded)\n";
  const nav = headingNav(body);
  assert.deepEqual(nav, [
    { level: 1, text: "Title", line: 1 },
    { level: 2, text: "Real heading", line: 3 },
    { level: 3, text: "Sub heading", line: 9 },
  ]);
});

test("queries the page does not cover return notFound with an empty section list", () => {
  const rank = querySections("# A\n\n## B\n\napple banana\n", "quantum entanglement");
  assert.equal(rank.notFound, true);
  assert.equal(rank.sections.length, 0);
});

test("blank query scores zero and returns notFound", () => {
  const rank = querySections("# A\n\n## B\n\napple banana\n", "   ");
  assert.equal(rank.notFound, true);
});

test("queryDocuments ranks one shared corpus and preserves source-local line ranges", () => {
  const rank = queryDocuments([
    { id: "tool", body: "# Tool\n\n## Lock recovery\n\nledger partition reify fact TOOL_FACT\n\n## Noise\n\ninstall install install\n" },
    { id: "changelog", body: "# Changes\n\n## Reconnect fix\n\nwisp handshake reconnect fact CHANGE_FACT\n" },
    { id: "unrelated", body: "# Other\n\ncoffee astronomy only\n" },
  ], "ledger partition reconnect wisp", 5);
  assert.deepEqual(new Set(rank.sections.map((section) => section.documentId)), new Set(["tool", "changelog"]));
  assert.equal(rank.sections.some((section) => section.documentId === "unrelated"), false, "zero-score pages are navigation-only, never evidence");
  const tool = rank.sections.find((section) => section.documentId === "tool");
  const change = rank.sections.find((section) => section.documentId === "changelog");
  assert.match(tool.text, /TOOL_FACT/);
  assert.match(change.text, /CHANGE_FACT/);
  assert.equal(tool.startLine, 4, "line ranges remain local to the source document");
  assert.equal(rank.notFound, false);
  assert.equal(rank.documentCount, 3);
});
