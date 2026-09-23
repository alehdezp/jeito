import assert from "node:assert/strict";
import test from "node:test";

import { streamSimple } from "@earendil-works/pi-ai/compat";
import registerPromptSidequest, { buildEnhancementInstruction, resolveStreamFn } from "./index.ts";

test("routes extension-registered providers (commandcode) to their own streamSimple", () => {
  const providerStream = () => { throw new Error("registered stream invoked"); };
  const ctx = {
    modelRegistry: {
      getRegisteredProviderConfig: (provider) =>
        provider === "commandcode" ? { api: "commandcode-custom", streamSimple: providerStream } : undefined,
      getRegisteredNativeProvider: () => undefined,
    },
  };
  assert.equal(resolveStreamFn(ctx, { provider: "commandcode" }), providerStream);
});

test("routes native-registered providers to their streamSimple", () => {
  const nativeStream = () => {};
  const ctx = {
    modelRegistry: {
      getRegisteredProviderConfig: () => undefined,
      getRegisteredNativeProvider: () => ({ streamSimple: nativeStream }),
    },
  };
  assert.equal(resolveStreamFn(ctx, { provider: "opencode-go" }), nativeStream);
});

test("keeps builtin providers on compat streamSimple (no regression)", () => {
  const ctx = {
    modelRegistry: {
      getRegisteredProviderConfig: () => undefined,
      getRegisteredNativeProvider: () => undefined,
    },
  };
  assert.equal(resolveStreamFn(ctx, { provider: "opencode-go" }), streamSimple);
});

test("registers the experimental command, provider hook, and safe shortcuts", () => {
  const events = [];
  const commands = [];
  const shortcuts = [];
  registerPromptSidequest({
    on(name) { events.push(name); },
    registerCommand(name) { commands.push(name); },
    registerShortcut(name) { shortcuts.push(name); },
  });
  assert.deepEqual(events, ["session_start", "before_provider_request"]);
  assert.deepEqual(commands, ["prompt-sidequest"]);
  assert.deepEqual(shortcuts, ["ctrl+shift+e", "ctrl+alt+e", "ctrl+shift+q", "ctrl+shift+z"]);
  assert.ok(!shortcuts.includes("ctrl+e"));
});

test("enhancement instruction carries the intent-preservation and safe-expansion contract", () => {
  const instruction = buildEnhancementInstruction("fix this bug");
  assert.match(instruction, /Read the conversation as an exchange/);
  assert.match(instruction, /assistant wording is never user intent by itself/);
  assert.match(instruction, /Interpretation may connect explicit material; it may not create/);
  assert.match(instruction, /Do not call tools, search, explore, or read anything outside/);
  assert.match(instruction, /Improve and expand the draft when a safe addition/);
  assert.match(instruction, /smallest focused check needed to verify it/);
  assert.match(instruction, /prevent a predictable execution error without changing the requested outcome/);
  assert.match(instruction, /Remove anything speculative, disproportionate, ceremonial, or likely to become work of its own/);
  assert.match(instruction, /\[\[REWRITE\]\] and \[\[\/REWRITE\]\]/);
  assert.match(instruction, /fix this bug/);
});

test("adds private generation discipline only for GPT-5.6 Sol", () => {
  const sol = buildEnhancementInstruction("fix this bug", undefined, undefined, "gpt-5.6-sol");
  const casedSol = buildEnhancementInstruction("fix this bug", undefined, undefined, "GPT-5.6-SOL");
  const other = buildEnhancementInstruction("fix this bug", undefined, undefined, "gpt-5.6-terra");
  assert.match(sol, /this governs the rewrite operation only; do not include it in the rewritten prompt/);
  assert.match(sol, /smallest direct behavior check over a broad test program/);
  assert.match(sol, /Supporting structure must help communicate the requested outcome; it must not replace it/);
  assert.match(sol, /do not add another pass, polish cycle, self-review, validation, or proof/);
  assert.doesNotMatch(sol, /GPT-5\.6 SOL:/);
  assert.match(casedSol, /ADDITIONAL GENERATION GUIDANCE/);
  assert.doesNotMatch(other, /ADDITIONAL GENERATION GUIDANCE/);
});

test("revision feedback is a constrained delta", () => {
  const instruction = buildEnhancementInstruction("fix this bug", {
    previousCandidate: "Fix the login bug.",
    userFeedback: "Keep it shorter.",
  });
  assert.match(instruction, /apply the user's feedback as a constrained delta/);
  assert.match(instruction, /preserve every untouched intent invariant/);
  assert.match(instruction, /Keep it shorter/);
});
