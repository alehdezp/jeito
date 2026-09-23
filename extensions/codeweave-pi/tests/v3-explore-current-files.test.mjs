import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { callTool, registerCleanPi, tempProject } from "./_clean-navigation-helper.mjs";
import { registerExploreTool } from "../src/tools/explore.ts";

test("explore fails closed instead of using live file scans in unprepared repos", async () => {
  const cwd = await tempProject("pi-explore-current-clean-");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "very-specific.ts"), "export const verySpecific = true;\n");

  // The owned preparation reader is the only code-exploration source: with no
  // published indexed graph the tool must refuse, name the real cause, and route
  // discovery to the tool that owns it. Naming Grep is guidance, not a scan — an
  // injected backend proves nothing was enumerated or queried.
  const backendCalls = [];
  const tools = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {}, getActiveTools() { return []; }, setActiveTools() {},
    tool(name) { const found = tools.get(name); assert.ok(found, `missing tool ${name}`); return found; },
  };
  registerExploreTool(pi, { callNative: async request => { backendCalls.push(request.operation); throw new Error("no backend may run without a published indexed graph"); } });
  const text = await callTool(pi, cwd, "explore", { view: "code", operation: "search", anchor: "verySpecific", scope: cwd });
  assert.match(text, /UNAVAILABLE: code exploration is unavailable for this scope/);
  assert.match(text, /no published indexed code graph may be read here/);
  assert.match(text, /No query-time setup, provider call, mutation or fallback navigation was used/);
  assert.doesNotMatch(text, /very-specific\.ts/, "the requested identity must not leak as a live-scan locator");
  assert.deepEqual(backendCalls, [], "no census, projection, or fallback backend call may run");
});

test("explore scope accepts concrete directories but not legacy path or docs view", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-explore-current-scope-");
  const docsViewText = await callTool(pi, cwd, "explore", { query: "overview", view: "docs", scope: cwd });
  assert.match(docsViewText, /INVALID CALL|view/i, "invalid view should be rejected");
  const legacyPathText = await callTool(pi, cwd, "explore", { query: "overview", path: cwd });
  assert.match(legacyPathText, /INVALID CALL|obsolete|path/i, "legacy path field should be rejected");
});
