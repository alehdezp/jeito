---
title: "ADR 1 — Top-level tools[] byte-stability is the cache invariant"
description: "The foundational tooltap decision: never mutate the provider's top-level tools[] mid-session, because tool definitions sit in the cacheable prefix and any mutation forces a full re-prefill."
tags: [tooltap, adr, cache-stability, prompt-cache, tools-invariant]
created: 2026-07-29
updated: 2026-08-23
status: stale
adr_id: ADR-001
adr_type: child
decision_status: superseded
confidence: settled
evidence_grade: measured
implementation_status: validated
decision_owner: alehdezp
owns: "The cache-stability invariant that constrains every activation route"
audience: contributor
code: [extensions/index.ts::injectDeferredToolSchemas, extensions/index.ts::providerAudit]
related: [../contract.md, ../how-pi-tools-reach-models.md]
---

# ADR 1 — Top-level `tools[]` byte-stability is the cache invariant

## Decision

For a frozen session, the provider's top-level `tools[]` array is treated as
immutable. Activating, loading, or enabling a hidden tool **never** adds,
removes, or rewrites an entry in `tools[]`. Loaded tools are delivered by other
means (conversation `input[]`, dispatch permission, or proxy), never by mutating
the tool surface.

This is `settled`: it is not open to trade-off. Any future mechanism that would
mutate `tools[]` mid-session is rejected regardless of its other benefits.

## Why it is non-negotiable

Tool definitions live in the leading, cacheable portion of the provider request
(the system/tool prefix). Provider prompt caching keys on a stable byte prefix;
the moment a tool definition changes, every cached token after the mutation
point is discarded and the whole session re-consumes its full input. For a
long-running coding session that is the difference between reading a few hundred
new tokens and re-reading tens of thousands each turn — both a cost and a
latency cliff. The entire reason tooltap exists is to reduce that upfront
cost; mutating `tools[]` on activation would undo it at the worst possible time.

The owning code makes the invariant observable:
[`extensions/index.ts::providerAudit`](../../extensions/index.ts) hashes
`record.tools` into `toolsHash`, and
[`extensions/index.ts::injectDeferredToolSchemas`](../../extensions/index.ts)
rewrites the payload without ever appending a loaded tool to the top level. The
historical bug that proved the rule: the function-form `tool_search` description
once reclassified newly unlocked tools, changing `toolsHash` on the next turn;
the fix classifies the manifest from the immutable startup set
([`extensions/index.ts::buildDescription`](../../extensions/index.ts), lines
~737–740).

## What we rejected

**Mutate `tools[]` on activation (the oh-my-pi model).** omp activates discovered
tools by rewriting the tool set mid-session and accepts the cache break, leaning
on `appendOnlyContext` to rebuild afterward. Rejected: it breaks the prefix on
every activation. Documented in
[`../research/oh-my-pi-architecture-notes.md`](../research/oh-my-pi-architecture-notes.md)
as an explicit anti-model for activation.

## Evidence (measured)

Observed firsthand this session and across the retained log:

- Live Qwen 3.8 Max Preview session: `dispatch` rose 18→19 on activation while
  `tools=20` and `toolsHash=5134c7db` stayed constant and `cacheRead` climbed
  106k→108k.
- Retained log (104,711 events, 373 sessions): GPT `client-tool-search` sessions
  hold one `toolsHash` while `inputLoadedToolCount` goes 0→16 and dispatch
  16→32; skeleton sessions hold a stable hash across turns.

## Consequences / rules

- Activation state is split from the tool surface: `setActiveTools` is frozen at
  startup; `setDispatchTools` and proxy enablement grow without touching
  `tools[]` (see [ADR-003](0003-hidden-tool-activation-routing.md)).
- Descriptions and skeletons are derived from the frozen startup set, never the
  mutable unlock set.
- The contract's north star
  ([`../contract.md`](../contract.md), "North star") restates this as a
  non-negotiable constraint.

## Revisit condition

Only a provider model in which tool definitions are *not* part of the cached
prefix — or a cache mechanism keyed per-tool rather than per-prefix — would
reopen this. Until such a provider exists and is measured, the invariant holds.
