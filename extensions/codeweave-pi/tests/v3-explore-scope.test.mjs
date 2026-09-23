import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { callTool, registerCleanPi, tempProject, writeGraphifyFixture } from "./_clean-navigation-helper.mjs";

test("explore scope resolves concrete project roots and rejects missing scopes cleanly", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-scope-clean-");
  const text = await callTool(pi, cwd, "explore", { query: "overview", view: "map", scope: cwd });
  assert.match(text, /UNAVAILABLE: graph map unavailable/);
  const missing = await callTool(pi, cwd, "explore", { query: "overview", view: "map", scope: join(cwd, "missing") });
  assert.match(missing, /does not exist|scope/i);
});

test("explore uses only artifacts rooted in selected scope", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-scope-graph-");
  await writeGraphifyFixture(cwd);
  const child = join(cwd, "child");
  await writeFile(join(cwd, "child.txt"), "not a project\n");
  const rootText = await callTool(pi, cwd, "explore", { query: "fixture", view: "map", scope: cwd });
  assert.match(rootText, /fixture src\/main\.ts:1/, "scope selection should return the selected root's compact map node");
  const childText = await callTool(pi, child, "explore", { query: "fixture", view: "map", scope: child });
  assert.match(childText, /scope|does not exist|not a directory|UNAVAILABLE/i);
});
