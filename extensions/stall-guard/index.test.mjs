import assert from "node:assert/strict";
import test from "node:test";

import stallGuard, {
  MAX_CONSECUTIVE_RESUMES,
  STALL_CONTINUE_PROMPT,
  classifyStalledTurn,
  newestAssistantTimestamp,
} from "./index.ts";

const STALL_ERROR =
  "Request was aborted\n\n[stall-watchdog-retry] provider returned error; treating stalled provider stream as retryable.";

function stallMessage(timestamp = 1000) {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "**Drafting root AGENT**" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-6-astra",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "error",
    errorMessage: STALL_ERROR,
    timestamp,
  };
}

function progressMessage(timestamp = 2000) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-6-astra",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    stopReason: "toolUse",
    timestamp,
  };
}

function userAbortMessage(timestamp = 3000) {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "partial" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-6-astra",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp,
  };
}

function userMessage() {
  return { role: "user", content: "continue", timestamp: 4000 };
}

function makeApi() {
  const sent = [];
  const handlers = {};
  return {
    sent,
    handlers,
    api: {
      on(event, handler) {
        handlers[event] = handler;
      },
      sendUserMessage(content, options) {
        sent.push({ content, options });
      },
    },
  };
}

/** Entries are in getBranch() path order: the system prompt first, the newest entry last. */
function makeCtx(messages, notifications = []) {
  return {
    sessionManager: {
      getBranch: () => messages.map((message) => ({ type: "message", message })),
    },
    ui: {
      notify(message, kind) {
        notifications.push({ message, kind });
      },
    },
  };
}

function settleOn(handlers, ctx, lastMessage) {
  handlers.agent_start?.({}, ctx);
  handlers.agent_end?.({ messages: [lastMessage] }, ctx);
  handlers.agent_settled?.({}, ctx);
}

test("classifies a watchdog-tagged stall as a stall", () => {
  assert.equal(classifyStalledTurn(stallMessage()), "stall");
});

test("never classifies a user abort as a stall", () => {
  assert.equal(classifyStalledTurn(userAbortMessage()), "progress");
});

test("classifies a completed turn as progress", () => {
  assert.equal(classifyStalledTurn(progressMessage()), "progress");
});

test("classifies a missing message as none", () => {
  assert.equal(classifyStalledTurn(undefined), "none");
});

test("newest assistant timestamp ignores trailing non-message entries", () => {
  const branch = [
    { type: "message", message: progressMessage(1000) },
    { type: "message", message: stallMessage(1234) },
    { type: "custom", customType: "harness-partner-lens" },
  ];
  assert.equal(newestAssistantTimestamp(branch), 1234);
});

test("newest assistant timestamp is undefined when a user message is last", () => {
  const branch = [
    { type: "message", message: stallMessage(1000) },
    { type: "message", message: userMessage() },
  ];
  assert.equal(newestAssistantTimestamp(branch), undefined);
});

// A real branch opens with the system prompt, so a helper that stops at the first
// non-assistant message returns undefined and the guard never resumes.
test("newest assistant timestamp resolves on a branch that opens with system and user messages", () => {
  const branch = [
    { type: "session", id: "session-1" },
    { type: "message", message: { role: "system", content: "You are Pi.", timestamp: 900 } },
    { type: "message", message: { role: "user", content: "do the thing", timestamp: 950 } },
    { type: "message", message: stallMessage(1234) },
  ];
  assert.equal(newestAssistantTimestamp(branch), 1234);
});

test("settling on a stalled turn resumes the session once", () => {
  const { sent, handlers, api } = makeApi();
  const stall = stallMessage();
  const ctx = makeCtx([stall]);
  stallGuard(api);
  settleOn(handlers, ctx, stall);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, STALL_CONTINUE_PROMPT);
  assert.equal(sent[0].options.deliverAs, "followUp");
});

test("settling resumes a stall recorded on a branch that opens with the system prompt", () => {
  const { sent, handlers, api } = makeApi();
  const stall = stallMessage();
  const ctx = makeCtx([
    { role: "system", content: "You are Pi.", timestamp: 900 },
    { role: "user", content: "do the thing", timestamp: 950 },
    stall,
  ]);
  stallGuard(api);
  settleOn(handlers, ctx, stall);
  assert.equal(sent.length, 1);
});

test("does not resume when the session already moved past the stall", () => {
  const { sent, handlers, api } = makeApi();
  const stall = stallMessage();
  const ctx = makeCtx([stall, userMessage()]);
  stallGuard(api);
  settleOn(handlers, ctx, stall);
  assert.equal(sent.length, 0);
});

test("does not resume an untagged abort", () => {
  const { sent, handlers, api } = makeApi();
  const aborted = userAbortMessage();
  const ctx = makeCtx([aborted]);
  stallGuard(api);
  settleOn(handlers, ctx, aborted);
  assert.equal(sent.length, 0);
});

test("stops after the cap and warns once instead of looping", () => {
  const { sent, handlers, api } = makeApi();
  const stall = stallMessage();
  const notifications = [];
  const ctx = makeCtx([stall], notifications);
  stallGuard(api);
  for (let i = 0; i < MAX_CONSECUTIVE_RESUMES + 2; i += 1) {
    settleOn(handlers, ctx, stall);
  }
  assert.equal(sent.length, MAX_CONSECUTIVE_RESUMES);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, "warning");
});

test("progress resets the resume bound", () => {
  const { sent, handlers, api } = makeApi();
  const stall = stallMessage();
  const progress = progressMessage();
  const ctx = makeCtx([stall]);
  stallGuard(api);
  for (let i = 0; i < MAX_CONSECUTIVE_RESUMES; i += 1) {
    settleOn(handlers, ctx, stall);
  }
  assert.equal(sent.length, MAX_CONSECUTIVE_RESUMES);
  settleOn(handlers, ctx, progress);
  assert.equal(sent.length, MAX_CONSECUTIVE_RESUMES);
  settleOn(handlers, ctx, stall);
  assert.equal(sent.length, MAX_CONSECUTIVE_RESUMES + 1);
});

test("input from a human resets the resume bound", () => {
  const { sent, handlers, api } = makeApi();
  const stall = stallMessage();
  const ctx = makeCtx([stall]);
  stallGuard(api);
  for (let i = 0; i < MAX_CONSECUTIVE_RESUMES; i += 1) {
    settleOn(handlers, ctx, stall);
  }
  handlers.input?.({ type: "input", text: "continue", source: "interactive" }, ctx);
  settleOn(handlers, ctx, stall);
  assert.equal(sent.length, MAX_CONSECUTIVE_RESUMES + 1);
});

test("our own continuation does not reset the resume bound", () => {
  const { sent, handlers, api } = makeApi();
  const stall = stallMessage();
  const ctx = makeCtx([stall]);
  stallGuard(api);
  for (let i = 0; i < MAX_CONSECUTIVE_RESUMES; i += 1) {
    settleOn(handlers, ctx, stall);
    handlers.input?.({ type: "input", text: STALL_CONTINUE_PROMPT, source: "extension" }, ctx);
  }
  settleOn(handlers, ctx, stall);
  assert.equal(sent.length, MAX_CONSECUTIVE_RESUMES);
});

test("a new session resets the resume bound", () => {
  const { sent, handlers, api } = makeApi();
  const stall = stallMessage();
  const ctx = makeCtx([stall]);
  stallGuard(api);
  for (let i = 0; i < MAX_CONSECUTIVE_RESUMES; i += 1) {
    settleOn(handlers, ctx, stall);
  }
  handlers.session_start?.({}, ctx);
  settleOn(handlers, ctx, stall);
  assert.equal(sent.length, MAX_CONSECUTIVE_RESUMES + 1);
});
