import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import registerContextDiagnostics from "./index.ts";

function fakeContext(notifications) {
  return {
    model: { id: "test-model", contextWindow: 1000 },
    getContextUsage: () => ({ tokens: 10, percent: 1 }),
    getSystemPrompt: () => "private prompt",
    getSystemPromptOptions: () => ({ appendSystemPrompt: "private append" }),
    sessionManager: { messages: [{ role: "user", content: "private message" }] },
    ui: { notify(message, kind) { notifications.push({ message, kind }); } },
  };
}

test("defaults to one explicit private dump and sanitizes its label", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-diagnostics-"));
  const previousRoot = process.env.PI_CODING_AGENT_DIR;
  const previousAuto = process.env.PI_CONTEXT_DIAGNOSTICS_AUTO;
  process.env.PI_CODING_AGENT_DIR = root;
  delete process.env.PI_CONTEXT_DIAGNOSTICS_AUTO;
  const commands = new Map();
  const events = [];
  const notifications = [];
  try {
    registerContextDiagnostics({
      registerCommand(name, command) { commands.set(name, command); },
      on(name) { events.push(name); },
      getAllTools() { return [{ name: "read", description: "Read files", parameters: {} }]; },
    });
    assert.deepEqual(events, []);
    await commands.get("dump-context").handler("../../ unsafe label", fakeContext(notifications));
    const directory = join(root, "context-dumps");
    const files = readdirSync(directory);
    assert.equal(files.length, 1);
    assert.match(files[0], /_unsafe-label\.json$/);
    assert.equal(statSync(join(directory, files[0])).mode & 0o777, 0o600);
    const dump = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
    assert.equal(dump.systemPrompt, "private prompt");
    assert.equal(dump.messages[0].content, "private message");
    assert.equal(notifications[0].kind, "warning");
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousRoot;
    if (previousAuto === undefined) delete process.env.PI_CONTEXT_DIAGNOSTICS_AUTO;
    else process.env.PI_CONTEXT_DIAGNOSTICS_AUTO = previousAuto;
  }
});

test("registers automatic capture only after explicit opt-in", () => {
  const previous = process.env.PI_CONTEXT_DIAGNOSTICS_AUTO;
  process.env.PI_CONTEXT_DIAGNOSTICS_AUTO = "1";
  const events = [];
  try {
    registerContextDiagnostics({ registerCommand() {}, on(name) { events.push(name); } });
    assert.deepEqual(events, ["context", "agent_end", "before_agent_start"]);
  } finally {
    if (previous === undefined) delete process.env.PI_CONTEXT_DIAGNOSTICS_AUTO;
    else process.env.PI_CONTEXT_DIAGNOSTICS_AUTO = previous;
  }
});
