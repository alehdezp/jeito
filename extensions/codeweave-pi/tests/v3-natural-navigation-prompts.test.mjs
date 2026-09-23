import assert from "node:assert/strict";
import test from "node:test";

import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import jeitoCodeweavePiExtension from "../index.ts";
import { callTool, makePi, registerCleanPi, tempProject } from "./_clean-navigation-helper.mjs";
import { registerExploreTool } from "../src/tools/explore.ts";

test("unknown code vocabulary is refused without dispatching a backend or leaking the identity", async () => {
  const cwd = await tempProject("pi-natural-clean-semantic-");
  // Naming Grep as the discovery owner is guidance. An injected backend proves the
  // refusal is not a live scan, and the question text must not leak as a locator.
  const backendCalls = [];
  const tools = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {}, getActiveTools() { return []; }, setActiveTools() {},
    tool(name) { const found = tools.get(name); assert.ok(found, `missing tool ${name}`); return found; },
  };
  registerExploreTool(pi, { callNative: async request => { backendCalls.push(request.operation); throw new Error("no backend may run without a published indexed graph"); } });
  const text = await callTool(pi, cwd, "explore", { view: "code", operation: "search", anchor: "supervised background reconciliation", scope: cwd });
  assert.match(text, /UNAVAILABLE: code exploration is unavailable for this scope/);
  assert.match(text, /No query-time setup, provider call, mutation or fallback navigation was used/);
  assert.doesNotMatch(text, /supervised background reconciliation/, "the question must not be echoed as a live-scan locator");
  assert.deepEqual(backendCalls, [], "no census, projection, or fallback backend call may run");
});

test("natural relationship prompt is represented by trace with known target", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-natural-clean-trace-");
  const text = await callTool(pi, cwd, "trace", { target: "registerTool", relation: "callers", scope: cwd });
  assert.match(text, /code trace|UNAVAILABLE|Live code|Callers of/i);
  assert.doesNotMatch(text, /grep|find/i);
});

test("natural docs prompt is represented by docs search and fails closed when unprepared", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-natural-clean-docs-");
  const text = await callTool(pi, cwd, "docs_search", { query: "setup docs", scope: cwd });
  assert.match(text, /UNAVAILABLE: Docs search is not enabled/);
  assert.doesNotMatch(text, /grep|find|fallback result/i);
});

test("natural edit-tag questions remain proof/edit-boundary concerns for read", async () => {
  const pi = registerCleanPi();
  const fields = Object.keys(pi.tool("read").parameters.properties).sort();
  assert.deepEqual(fields, ["path", "paths"]);
});

test("read-only tool results cannot bypass suppression at the docs cadence", async (t) => {
  const cwd = await tempProject("pi-cadence-suppression-");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".git"));
  const config = join(cwd, "automation.json");
  await writeFile(config, JSON.stringify({ automation: { mode: "aggressive" } }));
  const overrides = { PI_NAV_AUTOMATION_CONFIG: config, PI_NAV_NO_AUTO_SETUP: "0", PI_NAV_READ_ONLY: "0", PI_JEITO_HOST_PATCH: "off" };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const launches = t.mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter();
    child.unref = () => queueMicrotask(() => child.emit("close", 0));
    return child;
  });
  syncBuiltinESMExports();
  const hooks = new Map();
  const pi = makePi();
  pi.on = (name, handler) => hooks.set(name, handler);
  jeitoCodeweavePiExtension(pi);
  const result = hooks.get("tool_result");
  for (let i = 0; i < 10; i++) await result({ toolName: "grep" }, { cwd, readOnly: true });
  assert.equal(launches.mock.callCount(), 0);
  await assert.rejects(access(join(cwd, ".pi")), { code: "ENOENT" });
  // Positive control: the same cadence still starts permitted work, but never a real child here.
  for (let i = 0; i < 10; i++) await result({ toolName: "grep" }, { cwd });
  assert.equal(launches.mock.callCount(), 1);
});
