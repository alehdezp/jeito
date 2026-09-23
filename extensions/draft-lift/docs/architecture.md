---
title: "draft-lift architecture and request flow"
description: "How draft-lift preserves intent, adapts enhancement to the task, mirrors provider fields, and safely returns editor text."
tags: [draft-lift, architecture, request-flow, provider-mirroring]
created: 2026-07-26
updated: 2026-08-13
status: active
owns: "Sidequest context building, provider mirroring, and request flow"
audience: contributor
---

# Architecture and request flow

`draft-lift` is a Pi extension implemented in `index.ts`; `index.ts::buildEnhancementInstruction` owns the enhancer contract and `clean.ts` owns bounded output cleanup.

## High-level flow

1. The user invokes `/prompt-sidequest` or a shortcut.
2. The extension captures the current editor text or command argument as the draft.
3. It builds a context snapshot from the current session.
4. It appends one sidequest user message asking the model to improve the draft.
5. It streams the side request through `index.ts::resolveStreamFn` — the provider's own `streamSimple` when the provider is extension-registered (e.g. commandcode's `commandcode-custom` api), else the pi-ai compat `streamSimple` used for builtin apis.
6. It logs request/usage diagnostics as JSONL.
7. It cleans the model output.
8. It replaces the editor text only if safe.

The main session is not advanced by this side request.

## Context construction

The extension uses:

- `ctx.getSystemPrompt()` for the current system prompt.
- `ctx.sessionManager.buildSessionContext().messages` for resolved current session context.
- `convertToLlm(...)` to transform Pi messages to LLM messages.
- `pi.getActiveTools()` and `pi.getAllTools()` to include the active tool schema subset.
- `pi.getThinkingLevel()` to pass the same thinking/reasoning setting as the current session.
- `ctx.sessionManager.getSessionId()` as the provider `sessionId`.

## Context-aware enhancement instruction

### How the recent conversational exchange reconstructs intent

The final sidequest message instructs the enhancer to produce a clearer, directly usable version of the same request rather than execute it. It reads the recent local exchange—especially the latest user messages and the nearby assistant replies they answer—to resolve references, reactions, corrections, accepted proposals, and expressed preferences. Assistant text supplies conversational context but never user intent by itself.

### How safe expansion improves execution without inventing intent

The rewrite preserves active user commitments while allowing useful expansion inside that boundary. Intent-bearing additions such as goals, scope, preferences, constraints, and deliverables must trace to accepted user intent. Other additions may organize the request, restore applicable context, or add proportionate task guidance when that materially improves understanding or prevents a predictable execution error without creating another deliverable. For code work, this favors the smallest focused behavior check rather than an invented broad test program.

Recent user corrections take priority without erasing older goals, constraints, decisions, or relevant preferences that remain active. Interpretation may connect explicit material but cannot create commitments. One execution-critical unknown may become one focused clarification; optional details remain unspecified. The enhancer receives the conversation as its only evidence and is instructed not to call the supplied tools.

### GPT-5.6 Sol private prompt-enhancement generation guidance

When the enhancer model ID is exactly `gpt-5.6-sol`, the side request gains private generation guidance whose output contract forbids inclusion in the rewritten prompt. It prevents the enhancement turn from becoming analysis, planning, validation, benchmarking, or task execution; blocks ungrounded specification and supporting-artifact takeover; permits only proportionate execution guidance; and stops generation once the rewrite preserves active commitments and removes a real comprehension or execution risk. No other model receives this suffix. This boundary is instruction-level rather than a mechanical output filter.

### Verification boundary for the enhancement instruction

The accepted intent boundary, safe-expansion rule, and alternatives are owned by `extensions/draft-lift/docs/decisions.md:draft-lift-architecture-decision-records/adr-005-accepted-intent-boundary-allows-safe-prompt-expansion/decision#3`. The tests in `extensions/draft-lift/index.test.mjs` prove only composition and exact model gating; they do not establish semantic rewrite quality.

This is intentionally a side-call, not a user message inserted into the main conversation. The enhancer instruction remains the final uncached user-message suffix so the preceding main-session prompt and history can retain provider cache compatibility.

## Provider request mirroring

Pi’s normal assistant request passes through hooks that a direct side-request stream call cannot fully invoke through public APIs. To improve parity, `draft-lift` records the latest main provider payload in `before_provider_request`, strips provider input fields, and mirrors the latest main non-input body onto the sidequest provider payload.

The sidequest keeps its own `input`, but mirrors cache-relevant provider settings where possible:

- instructions
- tools
- prompt cache key
- reasoning/thinking
- text/output options
- model/provider body options

## Provider stream resolution

The side request streams through `index.ts::resolveStreamFn`, which selects the stream function the main session would use for the current model:

1. the provider's own `streamSimple` when the provider is extension-registered (`ctx.modelRegistry.getRegisteredProviderConfig(...)` or `getRegisteredNativeProvider(...)`) — for example `pi-commandcode-provider` registers `commandcode` with api `commandcode-custom`;
2. otherwise the pi-ai compat `streamSimple` used for builtin apis (`openai-responses`, `openai-completions`, `anthropic-messages`, ...).

Calling the compat `streamSimple` directly for an extension-registered provider fails with `No API provider registered for api: <api>`: the compat registry holds only pi-ai builtin APIs, while extension providers register into the host model registry (`@earendil-works/pi-coding-agent` `composeModelProvider`). The main session never hits this failure because it dispatches through the composed host provider; the side request mirrors that dispatch instead of bypassing it.

`extensions/draft-lift/index.test.mjs` pins the three routing cases (extension-registered, native-registered, builtin fallback). `.tmp/cc-proof/proof.mjs` drives the real commandcode stream with a mocked fetch.

## Public API limitation

The public extension context does not expose the full internal normal-agent hook chain for side calls. The mirror strategy is a practical workaround: it aligns the sidequest provider body with the latest main provider body without inserting anything into the main conversation.

The cache-reuse evidence this mirroring exists to produce is defined in `extensions/draft-lift/docs/cache-parity.md:cacheparity-verification-strategy/what-is-mirrored#2`; the "only if safe" step below is the guard in `extensions/draft-lift/docs/safety.md:safety-behavior/safe-editor-replacement#2`.

## Output handling

The response text is passed through `clean(...)`, which strips accidental surrounding code fences and quotes. The result is then placed in the editor, subject to safe replacement checks.
