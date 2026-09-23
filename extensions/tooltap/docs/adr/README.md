---
title: "ADR 0 — tooltap decision records"
description: "Master index for one-control configured routing and model-epoch enabled-tool rebasing."
tags: [tooltap, adr, decision-records, confidence, provenance]
created: 2026-07-29
updated: 2026-08-25
status: active
adr_id: ADR-000
adr_type: master
decision_status: accepted
confidence: confirmed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "tooltap ADR index, metadata contract, and decision-change procedure"
audience: contributor
code: [extensions/index.ts]
children: [0001-top-level-tools-byte-stability.md, 0002-openai-native-client-tool-search.md, 0003-hidden-tool-activation-routing.md, 0004-skeleton-shape-only-schemas.md, 0005-tolerant-teachable-tool-proxy.md, 0006-native-enablement-guidelines-in-description.md, 0007-guidelines-marker-fallback-custom-prompts.md, 0008-enablement-contract-redisplay-compaction.md, 0009-pi-native-additive-activation.md, 0010-configured-cache-safe-routing.md, 0011-model-epoch-enabled-tool-rebasing.md]
---

# ADR 0 — tooltap decision records

## Decision: record the load-bearing design choices as ADRs

tooltap has a small number of decisions that everything else depends on. They lived implicitly in [`../contract.md`](../contract.md) and the code; this folder makes them explicit, queryable, and individually changeable. The binding behavior remains [`../contract.md`](../contract.md); these ADRs record *why* the contract is shaped that way and what evidence backs it.

## ADR frontmatter contract

Every ADR carries the queryable core (matching the jeito websift convention so the two extensions stay consistent):

- `adr_id`, `adr_type` (`master` | `child`)
- `decision_status`: `proposed` | `accepted` | `superseded` | `deprecated`
- `confidence`: `idea` | `draft` | `confirmed` | `settled`
- `evidence_grade`: `none` | `inferred` | `tested` | `verified` | `measured`
- `implementation_status`: `not_started` | `partial` | `validated`
- `decision_owner`, `code` (owning symbol/file), `related` (inline-linked in body)

`confidence` and `evidence_grade` are independent: a decision can be `settled` (non-negotiable) on `verified` evidence, or `confirmed` on `measured` evidence.

## Current decision

| ADR | Decision | Status | Evidence |
|---|---|---|---|
| [0010](0010-configured-cache-safe-routing.md) | One stable public `tools` control selects native, direct, or strict gateway execution without within-epoch gateway schema promotion | accepted | direct fixture/live mechanics + focused production tests + owner decision |
| [0011](0011-model-epoch-enabled-tool-rebasing.md) | Rebase previously enabled tools into each newly selected model's ordinary full-schema baseline; later enablements remain route-late-bound | accepted | focused state proof + native provider snapshots + live gateway proof |

ADR-0011 amends ADR-0010's global gateway declaration invariant into a model-epoch invariant while preserving ADR-0010's one public control and configured route classes. ADR-0010 supersedes ADR-0009's universal `setActiveTools` fallback and its own earlier loader-plus-wrapper public surface. ADRs 0001–0009 remain historical mechanism evidence; they do not independently govern current public names.

## How to change an ADR

1. Read this master and the child owner.
2. A child changes only its own decision. If it changes a master premise (especially ADR-0001, the cache invariant), stop dependent work and update the master first.
3. Bump `updated`, adjust `confidence`/`evidence_grade` to the new evidence, and record the superseding reason in the body. Never silently edit a `settled` decision.

Top-level stability remains the default structural guard. Provider observations may verify transport behavior, but comparative counts and cache totals do not decide product adoption.
