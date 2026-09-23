import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillPath = new URL("../skills/cmux-harness-evaluation/SKILL.md", import.meta.url);

test("cmux harness evaluation requires fresh adaptive evidence, not automated scorecards", async () => {
  const text = await readFile(skillPath, "utf8");

  assert.match(text, /normal session-enabled Pi launch/);
  assert.match(text, /current session model.*low thinking/i);
  assert.match(text, /Never use `--no-session`/);
  assert.match(text, /State the user task, clue, and uncertainty/);
  assert.match(text, /Observe the first tool, exact rendered parameters\/normalization/);
  assert.match(text, /Judge whether the tool actually matched the uncertainty/);
  assert.match(text, /Retest only the concrete failure/);
  assert.match(text, /Do not report a broad UX\/release claim from an automated capture alone/);
});
