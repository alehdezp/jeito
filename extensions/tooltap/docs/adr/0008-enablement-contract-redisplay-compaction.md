---
title: "ADR 8 — Enablement contract re-display is intentional and compaction-aware"
description: "Hidden-tool enablement contracts are shown on the first activation event, re-armed after compaction, and refreshable on demand via tool_search; collapsing re-display into a one-liner pointer is rejected because compaction evicts the contract from conversation history."
tags: [tooltap, adr, enablement-contract, compaction, tool-search, usage-contract, re-display]
created: 2026-08-04
updated: 2026-08-23
status: stale
adr_id: ADR-008
adr_type: child
decision_status: superseded
confidence: confirmed
evidence_grade: tested
implementation_status: partial
decision_owner: alehdezp
owns: "The enablement-contract display lifecycle across activation, refresh, and compaction"
audience: contributor
code: [extensions/index.ts, test-harness.ts]
related: [0001-top-level-tools-byte-stability.md, 0003-hidden-tool-activation-routing.md, 0005-tolerant-teachable-tool-proxy.md, 0006-native-enablement-guidelines-in-description.md, ../contract.md]
---

# ADR 8 — Enablement contract re-display is intentional and compaction-aware

> **Superseded runtime behavior:** ADR-0010 now rejects duplicate native/direct loader calls without redisplaying contracts and tells the model to call the loaded exact name directly. The refresh lifecycle below documents the removed pre-0.5 implementation.

## Decision

A hidden tool's full usage contract is shown (a) on the **first activation event** — whichever comes first: `tool_search` enablement, exact `##tool`/`#group` activation, or first successful use — (b) again on the **first use after a session compaction**, and (c) **on demand**, via an explicit `tool_search` call for an already-enabled tool. The owner-stipulated floor is **one on-demand refresh per compaction cycle**; the current implementation is more permissive (no hard cap).

The re-display is deliberate. It must **not** be collapsed into a one-liner pointer ("tool enabled, see earlier contract") as a token optimization.

## Context and decisive trade-off

Enablement contracts live in **conversation history** as tool results — they are not part of the cached system/tool prefix ([ADR-001](0001-top-level-tools-byte-stability.md)). Conversation history is exactly what session compaction evicts. So after compaction the model may hold the tool's *name* (from the frozen discovery catalog) with no memory of its parameters. Re-display is the recovery mechanism; without it, the first post-compaction call to a proxied tool would be a blind guess against the strict `tool_proxy` gate.

The trade-off is tokens-per-refresh versus post-compaction reliability. A refresh costs a contract-sized message; a failed blind call costs a validation error, a correction turn, and — because the failure-card teaching re-shows the wrapping pattern — roughly the same tokens with worse UX. Reliability wins; the owner confirmed this explicitly (2026-08-02).

## Lifecycle (as implemented)

Freshness state: `usageContractsLoaded`, `usageContractCountdown`, `pendingFirstUseContracts` in `extensions/index.ts`.

1. **First activation event** → full contract shown once; countdown armed.
2. **Uncompacted stretch** → no automatic re-display; duplicate activation appends nothing ([`../contract.md`](../contract.md), "Context composition and deduplication").
3. **Compaction** (`session_compact`) → freshness state cleared; activation, dispatch, and provider `tools[]` stay untouched; the next use re-arms the contract (handler at `extensions/index.ts:2334`).
4. **On demand** → `tool_search` for an already-enabled tool re-displays the full contract (startup-core and dynamically-enabled schemas) with a one-turn countdown.

Harness proof: `test-harness.ts:255-288` asserts the one-turn countdown re-arms, compaction resets freshness, and the already-enabled refresh re-displays full usage instructions.

## What we rejected

- **Collapse re-display to a one-liner pointer.** Compacted sessions would lose the contract with no recovery; that is the failure this lifecycle exists to prevent. Proposed and rejected by the owner (2026-08-02) as cache-blind.
- **Auto-enable + contract display on every mention of the tool name.** Activation stays explicit; the discovery catalog is unchanged ([ADR-001](0001-top-level-tools-byte-stability.md)).

## Boundary with "appended once"

[`../contract.md`](../contract.md) states "Activation context is canonical and appended once. Duplicate activation appends nothing." That governs the activation-time append into context. A `tool_search` refresh returns the contract as its **result content** (not a duplicate context append), and post-compaction re-arm is a fresh append after eviction. The two statements are consistent; the refresh path is not a duplicate activation.

## Evidence

- Code: `session_compact` clears the three freshness maps without touching activation state (`extensions/index.ts:2334-2340`).
- Harness: `test-harness.ts:255-288` covers countdown re-arm, compaction reset, and refresh re-display.
- Live: this session observed `tool_search` enablement returning full contracts as tool-result content on the proxy-default route — the contract this lifecycle governs.
- Caveat: a dedicated **live compaction run** is still pending ([`../future-roadmap.md`](../future-roadmap.md), Phase 3 exit note). Evidence grade `tested`, not `measured`.

## Revisit conditions

- If a future route carries enablement contracts in the cached prefix (e.g. skeleton entries embedding full guidance), re-display after compaction becomes unnecessary on that route; scope this lifecycle down accordingly.
- If live compaction runs show re-display failures, repair the freshness maps or the compaction hook — the lifecycle itself is not in question.

## History

- 2026-08-02 — Owner ratified the lifecycle while rejecting a proposal to return a one-liner on already-enabled `tool_search` re-query; the proposal missed compaction eviction.
- 2026-08-04 — Recorded as ADR-008 after verifying the implemented behavior: `session_compact` handler, harness assertions, and `tool_search` refresh re-display.
