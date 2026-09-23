---
title: "Deferred tool-search design and verification"
description: "Historical client tool-search design superseded by Pi-native additive activation in ADR-0009."
tags: [tooltap, deferred-tools, tool-search, design]
created: 2026-07-26
updated: 2026-08-23
status: stale
owns: "Deferred hidden-tool discovery design and evidence boundary"
audience: contributor
related: [contract.md, client-tool-search-patch.md]
---

# OpenAI client tool-search notes

> **Historical:** ADR-0009 supersedes this client-search design with ordinary `search_tools` plus Pi-owned additive activation.

This document summarizes the OpenAI contract used by tooltap. The binding project contract is [`contract.md`](./contract.md).

Source: [OpenAI Tool Search Guide](https://developers.openai.com/api/docs/guides/tools-tool-search).

Live cross-model evidence: [`model-verification-2026-07-09.md`](./model-verification-2026-07-09.md).

## Supported models

OpenAI documents `tool_search` support on GPT-5.4 and later. This release intentionally enables its native integration only for configured GPT-5.4, GPT-5.5, and GPT-5.6 Responses model IDs.

## Client-executed request shape

The initial Responses request contains one client search declaration:

```json
{
  "type": "tool_search",
  "execution": "client",
  "description": "Find hidden project tools that are not already loaded.",
  "parameters": {
    "type": "object",
    "properties": {
      "goal": { "type": "string" }
    },
    "required": ["goal"],
    "additionalProperties": false
  }
}
```

tooltap replaces Pi's ordinary function-form `tool_search` shim in place. It must not send both declarations. Hidden function schemas are not included in the initial top-level `tools[]`.

## Required call/output pairing

The model emits a client search call:

```json
{
  "type": "tool_search_call",
  "execution": "client",
  "call_id": "call_abc123",
  "status": "completed",
  "arguments": { "goal": "Find the shipping ETA tool." }
}
```

The application searches its trusted inventory and returns a matching output with the same `call_id`:

```json
{
  "type": "tool_search_output",
  "execution": "client",
  "call_id": "call_abc123",
  "status": "completed",
  "tools": [
    {
      "type": "function",
      "name": "get_shipping_eta",
      "description": "Look up shipping ETA details for an order.",
      "defer_loading": true,
      "parameters": {
        "type": "object",
        "properties": { "order_id": { "type": "string" } },
        "required": ["order_id"],
        "additionalProperties": false
      }
    }
  ]
}
```

On the next and future turns, that loaded function is callable normally. The application does not need to load it again.

## Duplicate searches

If the model searches for an already-loaded function again, tooltap still has to pair the new `tool_search_call` with a protocol-valid `tool_search_output`. It returns `tools: []` and does not re-emit the schema. The earlier output remains the authority that keeps the function callable.

Do not mutate the `tools` array in an earlier `tool_search_output` to disable or replace loaded tools casually. OpenAI warns that changing the loaded set breaks the model cache from that point forward.

## Cache behavior

OpenAI appends dynamically loaded tools at the end of model context for both hosted and client-executed search. This is designed to preserve the existing cached prefix.

For tooltap, cache-compatible behavior means:

- top-level active `tools[]` stays identical after loading;
- the static client search declaration stays in the same position;
- GPT instructions and active tool descriptions are not rewritten between loading turns;
- the original `tool_search_call` and `tool_search_output` remain in conversation history at their original position;
- no extra completion is sent merely to probe or warm the cache.

These invariants do not prove a live cache hit. Use normal OpenAI response usage (`cached_tokens`, exposed by Pi as `usage.cacheRead`) for evidence. `logPayloads: true` records passive request hashes and turn usage without issuing another provider request.

## Advanced injection

OpenAI explicitly permits client-executed search to return trusted functions that were not declared in the original request. tooltap uses this advanced pattern because its available tools depend on Pi/project state. Returned schemas must therefore come only from Pi's trusted registered-tool inventory after blocked/excluded policy checks.

## Non-GPT shape-only skeleton fallback

GLM/KiMi/MiMo skeleton injection is a separate compatibility mechanism. Those providers do not implement OpenAI's client call/output protocol, so one stable entry for every eligible hidden tool remains in top-level `tools[]` and is tokenized up front.

The skeleton is deliberately **shape-only**, not empty:

- retain the tool name and structural parameter information needed to emit valid arguments;
- retain parameter names, types, required lists, array item shapes, and enums;
- strip tool and parameter descriptions, examples, prompt snippets, guidelines, and long instructions;
- keep both the skeleton set and function-form `tool_search` description immutable as dispatch state changes.

Direct skeleton calls are dispatch-enabled before Pi prepares the call. Live GLM-5.2 and MiMo-2.5 runs executed both `pi_version` and parameterized `pi_changelog` calls while keeping the same `toolsHash` across two hidden activations.

For the measured 36-hidden-tool inventory, skeletons serialized to 12,732 bytes (~3,183 rough tokens), versus 34,364 bytes (~8,591 rough tokens) for hypothetical full hidden schemas. That is about 63% less hidden-schema serialization, but still about 3.2K upfront estimated tokens. Provider cache reads showed that the stable prefix was reused on later requests. Do not describe this as OpenAI `defer_loading`, zero upfront cost, or equivalent initial token efficiency.

## `additional_tools`

OpenAI supports `additional_tools` for application-selected tools loaded outside the normal search flow and for preserving a specific historical insertion point. It is not needed after a model-selected client search because `tool_search_output` is the protocol authority for that call.

Raw GPT-5.4 Responses tests established that a tool absent from the first turn can be appended in one developer `additional_tools` item, called immediately, preserved at that position during manual replay, and called again on a later turn without re-adding it. The replay reused 4,096 cached tokens on later requests; a separately warmed activation request reused 3,072 of 3,410 input tokens.

Pi now preserves this item for public OpenAI Responses explicit marker activation. The ChatGPT Codex Responses backend returned `Missing required parameter: input[1].role` for that same item shape, so its adapter serializes explicit activation as an equivalent completed client `tool_search_call`/`tool_search_output` pair. GPT-5.6 Luna low-thinking live tests passed immediate exact/group activation, later saved-session direct calls without reactivation, stable top-level tools hashes, and 13,824–14,848 cached input tokens on continuation requests.

This is an API-specific distinction: do not send public `additional_tools` blindly to Codex, and do not substitute explicit activation for model-originated search.

Evidence and gates: [`research-findings-2026-07-10.md`](./research-findings-2026-07-10.md) and [`future-roadmap.md`](./future-roadmap.md).
