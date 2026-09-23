import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GOAL_REMINDER,
  MAX_REMINDER_TOKENS,
  REFRESH_ENTRY_TYPE,
  activeEntryStart,
  buildReminderCapsule,
  collectSessionMetrics,
  estimateStringTokens,
  latestRefreshBucket,
  tokenBucket,
} from "./append-salience.ts";
import promptRuntime, { partnerMarkerLabel, partnerMarkerLine } from "./index.ts";

const appendFixture = `# Prompt\n\n## 2. Judge independently\n\n### Think like the partner\n\n- Preserve useful skepticism.\n\n### Establish what is true\nDO NOT COPY THIS SECTION\n\n## At every stop\n\n- Serve the stated goal.\n- Keep evidence current.\n\n⟡ Partner — fixture footer`;

test("builds a bounded non-steering capsule from current APPEND sections", () => {
  const capsule = buildReminderCapsule(appendFixture);
  assert.match(capsule, /not a new task/i);
  assert.match(capsule, /not new intent or permission/i);
  assert.match(capsule, /Preserve useful skepticism/);
  assert.match(capsule, /Serve the stated goal/);
  assert.ok(capsule.includes(GOAL_REMINDER));
  assert.doesNotMatch(capsule, /DO NOT COPY|fixture footer/);
  assert.ok(estimateStringTokens(capsule) <= MAX_REMINDER_TOKENS);
});

test("the repository prompt contributes current guidance without obsolete selectors", () => {
  const source = readFileSync(new URL("../../config/APPEND_SYSTEM.md", import.meta.url), "utf8");
  const capsule = buildReminderCapsule(source);
  assert.match(capsule, /Assess independently/);
  assert.match(capsule, /Keep reasoning freedom broad and mutation authority narrow/);
  assert.ok(capsule.includes(GOAL_REMINDER));
  assert.doesNotMatch(capsule, /measured 3%|Critical anchors|4\. \*\*Decide\*\*/);
  assert.ok(estimateStringTokens(capsule) <= MAX_REMINDER_TOKENS);
});

test("oversized or unfamiliar APPEND preserves the complete non-steering and goal core", () => {
  const oversized = `### Think like the partner\n${"extra guidance ".repeat(1000)}\n\n## At every stop\n- ${"extra anchor ".repeat(1000)}`;
  const fallback = buildReminderCapsule(oversized);
  assert.equal(fallback, buildReminderCapsule("unfamiliar host prompt"));
  assert.match(fallback, /not a new task/i);
  assert.match(fallback, /not new intent or permission/i);
  assert.ok(fallback.includes(GOAL_REMINDER));
  assert.ok(estimateStringTokens(fallback) <= MAX_REMINDER_TOKENS);
  assert.throws(() => buildReminderCapsule(oversized, 1), /exceeds 1/);
});

test("goal reminders reinforce interpretation without requesting record maintenance", () => {
  assert.match(GOAL_REMINDER, /intended outcome/);
  assert.match(GOAL_REMINDER, /revise a mistaken framing proactively/);
  assert.match(GOAL_REMINDER, /not a request to update them/);
  assert.doesNotMatch(GOAL_REMINDER, /goal\.md|work\.md|decisions\.md|Reconcile affected state/);
  assert.match(buildReminderCapsule(appendFixture), /does not request file maintenance/);
});

test("counts active tokens and tool results across the last compaction boundary", () => {
  const entries = [
    { id: "old", type: "message", message: { role: "user", content: "discarded" } },
    { id: "kept", type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "kept output" }] } },
    { id: "compact", type: "compaction", firstKeptEntryId: "kept" },
    { id: "new", type: "message", message: { role: "toolResult", toolName: "grep", content: [{ type: "text", text: "new output" }] } },
  ];

  assert.deepEqual(activeEntryStart(entries), { start: 1, compactionId: "compact" });
  const metrics = collectSessionMetrics(entries);
  assert.equal(metrics.toolCalls, 2);
  assert.equal(metrics.compactionId, "compact");
  assert.ok(metrics.rawTokens > 0);
});

test("uses token buckets and branch-local refresh entries to suppress repeats", () => {
  assert.equal(tokenBucket(49_999), 0);
  assert.equal(tokenBucket(50_000), 1);
  assert.equal(tokenBucket(79_999), 1);
  assert.equal(tokenBucket(80_000), 2);
  assert.equal(tokenBucket(110_000), 3);
  const entries = [
    { type: "custom", customType: REFRESH_ENTRY_TYPE, data: { compactionId: "a", bucket: 1 } },
    { type: "custom", customType: REFRESH_ENTRY_TYPE, data: { compactionId: "b", bucket: 3 } },
    { type: "custom", customType: REFRESH_ENTRY_TYPE, data: { compactionId: "a", bucket: 2 } },
  ];
  assert.equal(latestRefreshBucket(entries, "a"), 2);
  assert.equal(latestRefreshBucket(entries, "b"), 3);
  assert.equal(latestRefreshBucket(entries, "missing"), 0);
});

function setupHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands: string[] = [];
  const appended: Array<{ customType: string; data: any }> = [];
  const entries: any[] = [];
  const notices: string[] = [];
  const renderers: Array<{ customType: string; render: (entry: any, view: any, theme: any) => any }> = [];

  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, handler);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerEntryRenderer(customType: string, render: (entry: any, view: any, theme: any) => any) {
      renderers.push({ customType, render });
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
      entries.push({ type: "custom", customType, data });
    },
  };
  promptRuntime(pi as never);

  const ctx: any = {
    getContextUsage: () => ({ tokens: 100_000, percent: 25 }),
    getSystemPrompt: () => "native-base-prompt",
    sessionManager: { getBranch: () => entries },
    ui: { notify: (message: string) => notices.push(message) },
  };

  return { handlers, commands, appended, entries, notices, renderers, ctx };
}

test("registers only the persistent message hook and zero commands", () => {
  const { handlers, commands } = setupHarness();
  assert.deepEqual([...handlers.keys()], ["before_agent_start"]);
  assert.equal(commands.length, 0);
});

test("refresh persists a bounded non-steering message once per bucket without overriding system instructions", async () => {
  const { handlers, appended, notices, ctx } = setupHarness();
  const before = handlers.get("before_agent_start")!;
  const event = { prompt: "question", systemPrompt: "native-base-prompt", systemPromptOptions: { appendSystemPrompt: appendFixture } };
  const first = await before(event, ctx);
  assert.equal(first.systemPrompt, undefined);
  assert.match(first.message.content, /<append-salience-refresh>/);
  assert.match(first.message.content, /not a new task/i);
  assert.equal(first.message.display, false);
  assert.equal(appended.filter(e => e.customType === REFRESH_ENTRY_TYPE).length, 1);
  assert.equal(appended.at(-1)!.data.bucket, 2);
  assert.match(notices.at(-1)!, /salience refresh/);
  const originalContent = first.message.content;
  const repeat = await before(event, ctx);
  assert.doesNotMatch(repeat.message.content, /append-salience-refresh/);
  assert.ok(repeat.message.content.includes(GOAL_REMINDER));
  assert.equal(first.message.content, originalContent);
  ctx.getContextUsage = () => ({ tokens: 150_000 });
  const third = await before(event, ctx);
  assert.match(third.message.content, /append-salience-refresh/);
  assert.equal(appended.at(-1)!.data.bucket, 4);
  ctx.getContextUsage = () => ({ tokens: 10_000 });
  const early = await before(event, ctx);
  assert.doesNotMatch(early.message.content, /append-salience-refresh/);
  assert.equal(appended.filter(e => e.customType === REFRESH_ENTRY_TYPE).length, 2);
});

test("lens is stored separately from user input, skips steering, and deduplicates explicit reminders", async () => {
  const { handlers, appended, ctx } = setupHarness();
  ctx.getContextUsage = () => ({ tokens: 1000 });
  const before = handlers.get("before_agent_start")!;
  const event = { prompt: "my prompt", systemPrompt: "unchanged" };
  const result = await before(event, ctx);
  assert.match(result.message.content, /^⟡ Partner/);
  assert.equal(result.message.content.split(GOAL_REMINDER).length - 1, 1);
  assert.equal(result.systemPrompt, undefined);
  assert.equal(event.prompt, "my prompt");
  for (const prompt of ["/steer focus on X", "steer: focus on X", result.message.content]) {
    assert.equal(await before({ ...event, prompt }, ctx), undefined);
  }
  assert.equal(appended.length, 1);
});

test("same-model restart preserves cadence and compaction creates an explicit new reminder boundary", async () => {
  const original = setupHarness();
  const event = { prompt: "question", systemPrompt: "fixed", systemPromptOptions: { appendSystemPrompt: appendFixture } };
  const first = await original.handlers.get("before_agent_start")!(event, original.ctx);
  const persistedContent = first.message.content;
  const restarted = setupHarness();
  restarted.entries.push(...structuredClone(original.entries));
  const resumed = await restarted.handlers.get("before_agent_start")!(event, restarted.ctx);
  assert.doesNotMatch(resumed.message.content, /append-salience-refresh/);
  restarted.entries.push({ type: "compaction", id: "new-boundary" });
  const compacted = await restarted.handlers.get("before_agent_start")!(event, restarted.ctx);
  assert.match(compacted.message.content, /append-salience-refresh/);
  assert.equal(restarted.appended.at(-1)!.data.compactionId, "new-boundary");
  assert.equal(first.message.content, persistedContent);
  assert.equal(compacted.systemPrompt, undefined);
});

test("markers retain the two borderless labels and stamp once per inserted reminder", async () => {
  const { handlers, renderers, appended, ctx } = setupHarness();
  assert.deepEqual(renderers.map(r => r.customType).sort(), ["append-salience-refresh", "harness-partner-lens"]);
  for (const r of renderers) assert.ok(r.render({ customType: r.customType }, {}, {}));
  assert.equal(partnerMarkerLine("harness-partner-lens"), "\x1b[95m⟡ Partner lens\x1b[0m");
  assert.equal(partnerMarkerLine("append-salience-refresh"), "\x1b[95m⟡ Partner refresh\x1b[0m");
  await handlers.get("before_agent_start")!({ prompt: "question", systemPromptOptions: { appendSystemPrompt: appendFixture } }, ctx);
  assert.equal(appended.filter(e => e.customType === "harness-partner-lens").length, 1);
  assert.equal(appended.filter(e => e.customType === REFRESH_ENTRY_TYPE).length, 1);
  assert.equal(handlers.has("before_provider_request"), false, "tool continuations must not rewrite or restamp reminders");
});

// Rebuild every request from persisted messages, as Pi does. Testing a second
// mutation of the already-decorated payload would hide the historical rewrite.
test("cache prefix survives new user and asynchronous custom messages", async () => {
  const { handlers, ctx } = setupHarness();
  ctx.getContextUsage = () => ({ tokens: 1000 });
  const start = await handlers.get("before_agent_start")!({ prompt: "first", systemPrompt: "fixed" }, ctx);
  const history: any[] = [{ role: "user", content: "first" }];
  if (start?.message) history.push({ role: "user", content: start.message.content });
  const request = () => {
    const payload = { instructions: start?.systemPrompt ?? "fixed", input: structuredClone(history) };
    return handlers.get("before_provider_request")?.({ payload }, ctx) ?? payload;
  };
  const first = request();
  assert.match(JSON.stringify(first), /⟡ Partner/);
  history.push({ type: "function_call_output", call_id: "test", output: "ok" });
  assert.deepEqual(request().input.slice(0, first.input.length), first.input);
  // Pi converts both human input and custom subagent-result messages to user.
  history.push({ role: "user", content: "asynchronous subagent result" });
  assert.deepEqual(request().input.slice(0, first.input.length), first.input);
});

test("cache prefix keeps system instructions fixed at refresh boundaries", async () => {
  const { handlers, ctx } = setupHarness();
  const event = { prompt: "next", systemPrompt: "fixed", systemPromptOptions: { appendSystemPrompt: appendFixture } };
  const first = await handlers.get("before_agent_start")!(event, ctx);
  const second = await handlers.get("before_agent_start")!(event, ctx);
  assert.equal(first?.systemPrompt ?? event.systemPrompt, event.systemPrompt);
  assert.equal(second?.systemPrompt ?? event.systemPrompt, event.systemPrompt);
  assert.match(first?.message?.content ?? "", /append-salience-refresh/);
});
