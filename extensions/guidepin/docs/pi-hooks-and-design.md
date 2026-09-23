---
title: "guidepin append-only reminder delivery"
description: "Persistent reminder insertion, Pi hook ownership, prefix-cache invariants, and the rejected payload/system rewrite designs."
tags: [jeito, guidepin, pi-hooks, cache-stability, reminders]
created: 2026-08-25
updated: 2026-09-17
status: active
owns: "Reminder insertion rationale, Pi persistence boundary, cache verification, and rejected designs"
audience: contributor
code: [../index.ts, ../append-salience.ts]
related: [../README.md, ../../../config/APPEND_SYSTEM.md, ../skills/goal-management/SKILL.md]
---

# Pi hook pipeline and guidepin design

The hook/transport observations below came from Pi's extension documentation and the August 2026 headless probes. Current reminder assembly and scaffolding are verified through deterministic contract tests, not agent-behavior studies. Historical observations do not prove the currently loaded host or every provider route. Preserve the delivery boundaries: most were bought with a broken request.

## Insert reminders at Pi's persistent conversation boundary

`index.ts::promptRuntime` registers only `before_agent_start`. Its returned `message` is persisted by Pi as a custom conversation message after the new user message. Pi converts custom messages into its ordinary model context and owns provider-specific serialization; guidepin does not guess transport fields or modify `instructions`, `messages[]`, or Responses `input`.

The message is hidden from normal conversation display (`display:false`), not hidden from the model. It contains the partner lens and, when due, the salience capsule. Display-only `pi.appendEntry` records render the two familiar borderless labels. Plain custom state entries are not model messages; custom **message** entries are.

Only a new agent run inserts a reminder. Tool continuations and asynchronous subagent-result delivery do not regenerate or reposition prior reminders. Later APPEND changes affect only newly inserted capsules. Existing conversation bytes remain the authority for replay and resume.

## Preserve lens meaning and refresh cadence

- The lens skips prompt text beginning with `/steer` or `steer:` and skips a prompt already containing its explicit marker. Its wording uses `GOAL_REMINDER` from `append-salience.ts` to reinforce interpretation, consequential uncertainty and proactive reframing—not a file-maintenance procedure. The reminder explicitly does not request goal-file updates; the skill owns selective persistence and decomposition.
- The refresh first becomes eligible at 50k context tokens and then each 30k bucket. `ctx.getContextUsage()` is primary; `collectSessionMetrics` is fallback. `latestRefreshBucket` reads branch-local marker entries scoped by the latest compaction identity. Existing marker entries remain compatible across restart.
- `buildReminderCapsule` preserves the non-steering header, goal reminder, and bounded APPEND excerpts. The 1200-estimated-token limit is unchanged. A reminder is not new intent or permission.
- Missing or unreadable APPEND suppresses only the refresh, not the independent lens. No fallback changes system instructions or provider fields.
- A compaction explicitly changes the conversation boundary; the next eligible refresh belongs to that new boundary. It never rewrites earlier retained messages.

## Why per-request decoration and transient system refresh were removed

The old `before_provider_request` implementation decorated only the last user-shaped message in each freshly rebuilt payload. When another user message arrived, the previous one lost its decoration. Pi also maps custom subagent results to user-shaped messages, so asynchronous delivery could invalidate a cached prefix during an otherwise normal tool loop. Deduplicating a single already-decorated payload did not detect this cross-request defect.

The old refresh appended a capsule to `event.systemPrompt` for one run. Pi supplies its base prompt again on the next run and resets to it when no override is returned. Adding and then removing the capsule changed the early cacheable prefix twice. A transport-valid system override is not necessarily cache-safe.

The replacement deliberately accepts persistent reminder messages instead of temporary instructions. This is the approved cache-preservation tradeoff: messages grow only at the tail, rather than apparently saving a little history by invalidating reuse of much more history.

The earlier historical transport fixes—handling Responses `input_text` instead of chat `text`, and never inventing system fields for opaque transports—remain useful lessons, but no longer define the current insertion mechanism. There is no provider-payload rewrite hook to maintain.

## Verify previous prefixes, not just tool declarations

`append-salience.test.ts` includes regressions that failed against the old implementation: rebuild requests from original persisted history, append a tool result and a new user/custom result, and require every earlier item to remain identical. A second regression crosses a refresh boundary and requires the system prompt to remain unchanged while reminder content is delivered.

The root `npm run test:cache-prefix` runs `tests/tooltap-prompt-prefix.test.mjs` against real Pi session persistence/conversion and the installed Responses serializer/deferral classifier, with a mocked tool registry and fixed system instructions. Both native and gateway fixtures preserve complete previous input prefixes across enablement, repeated execution, custom results, refresh and same-model reminder-extension restart. This proves reminder/serialization behavior, not native activation's effect on Pi's generated system prompt.

Additional checks cover capsule meaning, steering exclusions, display markers, same-model restart, and compaction-scoped cadence. Final-stack verification must also inspect provider serialization after all extension hooks: stable tool declarations/order, system instructions, cache key, and the previous input prefix. A Stow-only snapshot before another extension runs is insufficient.

Live verification used `openai-codex/gpt-5.6-luna` with fixed system instructions: ordinary-tool, native deferred and gateway sessions preserved request prefixes and measured cache reuse. A separate normal-Pi-system preflight found a remaining native-activation defect: `setActiveToolsByName` rebuilds the system prompt with a late tool's snippet/guidelines. The fixed-system runs do not clear that defect or authorize expanding native routing. Cache usage is supporting evidence, not a guarantee of provider availability or retention.

## Diagnostics and rollout limits

`GUIDEPIN_DEBUG=<path>` writes newly inserted reminder text only. It does not dump user input or final provider requests. Treat APPEND excerpts as potentially private and keep diagnostics outside version control.

Restart Pi to load the repaired module. Prior payload-only decorations were never persisted, so deployment into an old session is a one-time cache boundary; do not fabricate historical messages to imitate them. Future reminders are replayed unchanged. Other extensions, deliberate model switches, compaction, and provider-side cache lifetime remain separate boundaries. Persistent delivery proves neither model adherence nor every custom provider's request semantics.
