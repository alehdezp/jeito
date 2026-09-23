---
title: "Pi client tool-search compatibility patch"
description: "Historical host-patch design removed by ADR-0009; retained only as failure-analysis evidence."
tags: [tooltap, pi-patch, openai-tool-search, dynamic-dispatch]
created: 2026-07-26
updated: 2026-08-23
status: stale
owns: "Pi client tool-search compatibility patch behavior"
audience: contributor
related: [contract.md, how-pi-tools-reach-models.md, tool-search-deferred.md]
---

# Client-Executed Tool Search Patch

> **Historical:** ADR-0009 removed this patch and all extension-owned provider transport. Do not apply these instructions to the current package.

## What this is

Pi core does not natively support OpenAI's client-executed tool_search protocol. When the model emits `tool_search_call`, Pi silently drops it. When the extension returns a tool result, Pi emits it as `function_call_output` instead of `tool_search_output`.

This patch fixes both gaps so Pi can participate in the client-executed tool_search cycle described in the [OpenAI docs](https://developers.openai.com/api/docs/guides/tools-tool-search).

## How it works

### The flow

1. For GPT-5.4/5.5/5.6 Responses payloads, the extension replaces Pi's ordinary function-form `tool_search` entry with one `{ type: "tool_search", execution: "client" }` declaration. Tool order and count remain stable.
2. The model emits `tool_search_call` when it needs a hidden tool.
3. `openai-responses-shared.js` recognizes object- or string-valued search arguments and converts the call to Pi's internal `toolCall` format.
4. Pi executes the registered local `tool_search` handler.
5. The extension returns trusted structured `loadedTools` plus `_toolSearchOutput: true`.
6. `agent-loop.js` preserves the marker in the stored tool-result message.
7. `openai-responses-shared.js` replays `tool_search_call` and emits `tool_search_output` with the same `call_id`.
8. The loaded function is callable on later turns without changing top-level `tools[]` or searching for it again.

### What the patches modify

| File | Change |
|------|--------|
| `pi-ai/dist/api/openai-responses-shared.js` | Pass-through `tool_search` tools, recognize `tool_search_call`, emit `tool_search_output` |
| `pi-agent-core/dist/agent-loop.js` | Pass through `_toolSearchOutput` marker in `createToolResultMessage` |

## How to apply

```bash
cd ~/.pi/agent/extensions/pi-tool-search-alehdezp

# Prerequisite: dynamic dispatch patch must be applied first
node patches/apply-pi-dynamic-dispatch.mjs

# Apply the client tool search patch
node patches/add-client-tool-search.mjs
```

Then run `/reload` in Pi.

## How to reapply after Pi updates

The patches modify compiled `.js` files in `node_modules`. After `npm update` or `pi update`, the original files are replaced and the patches are lost.

To reapply:

```bash
cd ~/.pi/agent/extensions/pi-tool-search-alehdezp
node patches/apply-pi-dynamic-dispatch.mjs
node patches/add-client-tool-search.mjs
# Then /reload in Pi
```

Both patches are idempotent — they skip already-applied changes.

## How to verify the patch is active

Run the local contract harness (it patches a local dev Pi install twice to prove idempotency):

```bash
npm run patch:test
```

Then verify a real GPT-5.4/5.5/5.6 session after `/reload`:

1. `tooltap.log.jsonl` reports `strategy: "client-tool-search"` and `nativeToolSearchDeclarationCount: 1`.
2. `functionToolSearchShimCount`, `topLevelDeferredFunctionCount`, and the initial `inputLoadedToolCount` are zero.
3. `toolCount` equals `activeCount` because the native declaration replaced the local function shim in place.
4. After search, call/output counts are one, `inputLoadedToolCount` is one, and the returned hidden function executes directly.
5. `toolsHash` and `instructionsHash` remain unchanged; `turn_usage.cacheRead` supplies cache evidence without an extra probe completion.

The live GPT-5.4/5.5/5.6 results are recorded in [`model-verification-2026-07-09.md`](./model-verification-2026-07-09.md).
## What survives Pi updates

- The extension code (`extensions/index.ts`) is in the extension directory and is not affected by Pi updates.
- The patch files (`patches/*.mjs`) are in the extension directory and survive Pi updates.
- The **applied** patches (modifications to Pi core `.js` files) are lost after Pi updates and must be reapplied.

## What this does NOT do

- This does not modify Pi's TypeScript source files — only compiled `.js` files.
- This does not add `tool_search_call`/`tool_search_output` to Pi's type definitions.
- This does not handle the case where OpenAI returns an error because `tool_search_call` was not handled (that's what the patch fixes).
