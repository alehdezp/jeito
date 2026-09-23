---
title: "ADR 2 — Use OpenAI native client-executed tool_search for GPT-5.4/5.5/5.6"
description: "tooltap delivers hidden tools to GPT-5.4/5.5/5.6 Responses routes via OpenAI's native client-executed tool_search protocol rather than a duplicate function-form shim."
tags: [tooltap, adr, openai-tool-search, client-executed, gpt]
created: 2026-07-29
updated: 2026-08-23
status: stale
adr_id: ADR-002
adr_type: child
decision_status: superseded
confidence: confirmed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "The GPT/OpenAI native tool-search representation decision"
audience: contributor
code: [extensions/index.ts::shouldUseNativeClientToolSearch, extensions/index.ts::injectDeferredToolSchemas, patches/add-client-tool-search.mjs]
related: [../client-tool-search-patch.md, ../tool-search-deferred.md, ../contract.md]
---

# ADR 2 — Native client-executed `tool_search` for GPT-5.4/5.5/5.6

## Decision

For configured GPT-5.4/5.5/5.6 Responses routes, tooltap replaces Pi's
ordinary function-form `tool_search` entry with **one** native declaration
`{ type: "tool_search", execution: "client" }`, in place, keeping tool order and
count stable. The model emits `tool_search_call`; the compatibility patch
converts it to a Pi tool call, runs the local handler, and replays a
protocol-valid `tool_search_output` with the loaded function. Hidden schemas are
deferred until search and arrive in conversation `input[]`, not `tools[]`.

## Context

OpenAI documents `tool_search` support on GPT-5.4+ and appends dynamically
loaded tools at the *end* of model context for client-executed search,
deliberately preserving the cached prefix
([`../tool-search-deferred.md`](../tool-search-deferred.md), "Cache behavior").
Pi core does not natively speak this protocol — it drops `tool_search_call` and
mis-emits the result as `function_call_output` — so a version-anchored host
patch is required ([`../client-tool-search-patch.md`](../client-tool-search-patch.md)).

## What we rejected

**A duplicate function-form shim alongside the native declaration.** Sending two
representations of `tool_search` (a function shim plus the native item) risked
the model choosing the wrong mechanism and destabilized the prefix. Rejected in
favor of a single in-place native declaration; the local function shim is
removed from the GPT surface (`isProxy`/`isFunctionShim` handling in
[`extensions/index.ts::injectDeferredToolSchemas`](../../extensions/index.ts),
Case 1).

## Correctness validation

The gate is exact, not a model-name guess
([`extensions/index.ts::shouldUseNativeClientToolSearch`](../../extensions/index.ts)):
compatibility patch present **and** a Responses payload (has `input`, no
`messages`) **and** `supportsOpenAiToolSearch(model)` (GPT-5.4/5.5/5.6) **and**
a configured deferred family. The declaration shape matches OpenAI's documented
client-executed contract. The now-removed historical patch at `patches/add-client-tool-search.mjs`
passed non-function tools through `convertResponsesTools`, recognized
`tool_search_call`, and emitted `tool_search_output` with the same `call_id`.
Inspect the pre-ADR-0010 Git history for those bytes; the current tree deliberately does not ship the patch.

## Evidence (verified)

Code inspection this session matches the documented OpenAI contract and the
retained live baseline. **Firsthand caveat:** live GPT execution this session
was *not* re-run — GPT routes are currently blocked by a Codex usage limit. The
live pass rests on the dated baseline
[`../model-verification-2026-07-09.md`](../model-verification-2026-07-09.md)
(GPT-5.4/5.5/5.6: `nativeToolSearchDeclarationCount: 1`, zero shims, stable
`toolsHash`/`instructionsHash`, `cacheRead` present). Re-grade to `measured`
after a fresh GPT run.

## Consequences

- Requires the host patch; tooltap fails closed when a Pi update removes it
  (disable native search, withhold hidden metadata, return a recoverable error).
- Duplicate searches return `tools: []` and never rewrite an earlier
  `tool_search_output`, because changing the loaded set breaks the cache from
  that point forward.

## Revisit condition

When Pi ships native client-`tool_search` support, drop the patch and the
shim-removal logic; the extension should detect upstream support and stop
patching ([`../future-roadmap.md`](../future-roadmap.md), "Patch and upgrade
durability").
