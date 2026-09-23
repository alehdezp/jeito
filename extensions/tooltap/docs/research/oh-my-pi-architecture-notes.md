---
title: "Oh My Pi architecture notes for tooltap"
description: "External implementation notes that informed tooltap tool registration, dispatch, and provider adaptation decisions."
tags: [tooltap, upstream-research, oh-my-pi, architecture]
created: 2026-07-26
updated: 2026-07-26
status: stale
owns: "External oh-my-pi architecture observations informing tooltap"
audience: contributor
related: [../contract.md]
---

# oh-my-pi architecture notes (research only, not adopted)

Date: 2026-07-12
Source: github.com/can1357/oh-my-pi (fork of badlogic/pi-mono)
Purpose: capture omp design observations for future reference. No code ported.

## Architectural position

omp is a single Rust monorepo with 32 built-in tools and 40+ providers. The discovery story is built into the core, not loaded as an extension. It is one unified runtime, not a Pi-style extension model.

## Cache posture

omp's activation model mutates `tools[]` mid-session via `session.activateDiscoveredTools()` and `setActiveToolsByName()`. This breaks provider prefix cache from the mutation point forward. omp accepts this cost and relies on `appendOnlyContext` to rebuild the cache after the mutation. Their `StablePrefix` freezes the initial system prompt + tool specs; their `AppendOnlyLog` keeps message growth cache-stable via per-message digests. None of this protects the `tools[]` array from mutation.

Our tooltap position is the opposite: `tools[]` must stay immutable. All three of our activation routes (GPT client tool_search, GPT additional_tools, non-GPT shape-only skeleton, text-direct dynamic dispatch) preserve the wire format. omp is not a model to follow for activation.

## BM25 search (notable algorithm, future candidate)

omp's `search_tool_bm25` is a built-in tool in `packages/coding-agent/src/tools/search-tool-bm25.ts`. It runs BM25 over a static tool index with field weights:

- name: 6
- label: 4
- mcpToolName: 4
- serverName: 2
- summary: 2
- schemaKey: 1

The index is built at compile time in `packages/coding-agent/src/tool-discovery/tool-index.ts`. Each `DiscoverableTool` has `name, label, summary, source, serverName, mcpToolName, schemaKeys`. `schemaKeys` are extracted from tool parameters via `getSchemaPropertyKeys`. Summary falls back to first 200 chars of description.

The tokenizer normalizes Unicode, splits acronyms, splits camelCase, strips punctuation.

Execute flow: tokenize query → BM25 score → filter already-selected → slice to limit (default 8) → call `activateDiscoveredTools()` → return JSON `{query, activated_tools, match_count, total_tools}`.

Future port candidate: replace our hand-rolled `1000 / 500 / 100 / 40 / 5` scoring with a proper BM25 implementation. We do not need this now because our `##tool-name` exact-name path is the recommended activation route. If we ever expose a fuzzy search for non-exact-name queries, BM25 with these field weights is the principled backend.

## AppendOnlyLog with digest-based truncation (notable algorithm, future candidate)

`packages/agent/src/append-only-context.ts` has `syncMessages()` (lines 207-237) which:
1. Computes per-message digests.
2. Compares new message list against current log.
3. If a previous message was rewritten in place, truncates the log to the longest byte-stable prefix.
4. Appends the diverged tail.

This preserves provider KV cache up to the divergence point rather than forcing a full re-prefill on every message rewrite. This is a real implementation of "append-only" caching.

Future port candidate: if we want to preserve cache when Pi rewrites a message, we can implement the same digest-truncation algorithm on our side. This is at the message layer, not the tools layer, and is a separate optimization from activation.

## What omp has that we do not (just for reference)

1. BM25 with field weights (more principled than our hand-rolled scoring).
2. Schema-key extraction from parameters (queries match parameter keys too).
3. AppendOnlyLog with digest-based truncation (cache-stable message rewrites).
4. `loadMode: "discoverable" | "essential"` per tool (static per-tool class).

## What omp has that is worse than ours

1. `tools[]` mutation on activation (cache break on all providers).
2. No tool_search, additional_tools, or defer_loading usage.
3. Discovery only via BM25 query, no exact-name fallback.
4. No usage contract reuse — model is expected to know how to call from system prompt.
5. MCP server is the discoverable unit, not individual tools.

## Honest summary

omp solves "always have the right tool" with one mechanism that breaks cache. We solve "minimal context + stable cache" with multiple mechanisms that preserve cache. Different goals, different architectures. omp is not a model to follow for activation; it is a research reference for two specific algorithms (BM25 field weights, append-only log with digest truncation) that we may or may not use later.
