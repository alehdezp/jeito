---
title: "jeito codeweave-pi decision register"
description: "Index of accepted and provisional product and architecture decisions whose reasoning must remain retrievable without confusing proposal with shipped behavior."
tags: [jeito-codeweave-pi, decisions, adr, rationale, index]
created: 2026-07-26
updated: 2026-09-21
status: active
owns: "Which accepted and provisional decisions exist and where their preserved reasoning lives"
audience: contributor
related: [docs/current-truth.md, docs/harness-doctrine.md, docs/evidence.md]
---

# Decision register

Accepted decisions keep their reasoning here after the phase plans that produced them were collapsed. Current behavior lives in [`../current-truth.md`](../current-truth.md); behavior-to-code maps live in [`../evidence.md`](../evidence.md); timeless invariants live in [`../harness-doctrine.md`](../harness-doctrine.md). Accepted records own the *why*: context, the choice, the decisive trade-off, and rejected alternatives that must not be re-litigated.

| Decision | Status | Owns |
|---|---|---|
| [R5 CRG clean break](r5-crg-clean-break.md) | historical · superseded by the CRG retirement | Why CRG shipped as pristine stock plus one watch/daemon patch through one extension-local normal-pip runtime; retained for its rejected alternatives |
| [Owned pi-nav N-API backend](pi-nav-owned-backend.md) | accepted | Why native queries run in an in-process N-API addon instead of a persistent MCP child |
| [Proof-preserving mutation](proof-preserving-mutation.md) | accepted | Why displayed source becomes edit authority without redundant reads, and why the edit engine salvages provably-safe intent |
| [Provider fusion](current-source-pi-nav-with-prepared-crg-provider-fusion.md) | historical · superseded | Why codeweave-pi implements live alias-aware identity and carriers in pi-nav and once retained CRG for prepared candidates |
| [Monorepo root is always indexed](monorepo-root-always-indexed.md) | historical · superseded | Why monorepo ambiguity never blocks root preparation, and why per-package fan-out and automatic sibling scanning were rejected |

## Provisional decisions

| Decision | Status | Owns |
|---|---|---|
| [Compact live call-site projection](provisional-compact-live-callsite-projection.md) | accepted provisional · not implemented | Why direct callers and aliases group by current file and enclosing owner without duplicated source or line labels |

Provisional records preserve founder-approved direction while placement, provider ownership, or the surrounding complete result remains open. They never establish current behavior.

## Register policy

A new decision record is created only for an accepted choice or an explicitly requested provisional choice with rejected alternatives worth preserving. Transient task plans are not decisions and do not get records; when a plan is collapsed, its durable reasoning is extracted here and the plan files are deleted.
