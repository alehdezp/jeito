import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function skill(name) {
  return readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");
}

test("navigation setup skill pins clean-break query-time safety contract", async () => {
  const text = await skill("navigation-setup");
  assert.match(text, /Query-time navigation tools must never build, index, install, embed, call providers, download models, or mutate/);
  assert.match(text, /complete source rows[\s\S]{0,220}whole-file hash|live-row certification|hash-certified/i);
  assert.match(text, /npm run nav:prepare/);
  assert.match(text, /Graphify|code-review-graph|QMD|pi-nav/);
  assert.doesNotMatch(text, /Semble.*recommended|Codanna.*recommended/i);
});

test("navigation setup skill captures provider gates and artifact ownership", async () => {
  const text = await skill("navigation-setup");
  assert.match(text, /VOYAGE_API_KEY|OPENAI_API_KEY|provider/i);
  assert.match(text, /\.pi\/navigation/);
  assert.match(text, /rollback|audit/i);
  assert.match(text, /Graphify local update|deep extraction/);
});
