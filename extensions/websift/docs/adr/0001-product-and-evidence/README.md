---
title: "ADR 1 — Product and evidence surface"
description: "Master ADR for jeito websift product scope, evidence semantics, public tools, tool-local agent guidance, and provider-specialist surfaces."
tags: [jeito-websift, adr, product-scope, tool-surface, evidence-model]
created: 2026-07-28
updated: 2026-08-04
status: active
adr_id: ADR-001
adr_type: master
decision_status: accepted
confidence: user-stated
evidence_grade: mixed
implementation_status: in-progress
decision_owner: alehdezp
owns: "Product boundary, public web tools, and evidence semantics"
audience: mixed
parent: docs/adr/README.md
children: [docs/adr/0001-product-and-evidence/0001-objective-and-scope.md, docs/adr/0001-product-and-evidence/0002-tool-surface-and-evidence.md, docs/adr/0001-product-and-evidence/0003-core-search-and-provider-specialists.md, docs/adr/0001-product-and-evidence/0004-tool-call-ergonomics.md, docs/adr/0001-product-and-evidence/0005-tool-local-agent-guidance.md]
related: [docs/DESIGN.md, docs/ROADMAP.md, docs/adr/0005-provider-evaluation-and-guidance/README.md]
---

# ADR 1 — Product and evidence surface

## Master decision: one owned extension with a minimal core and taught specialists

jeito websift remains one first-party extension with explicit evidence rights. [`0001-objective-and-scope.md`](0001-objective-and-scope.md) owns the product objective. [`0002-tool-surface-and-evidence.md`](0002-tool-surface-and-evidence.md) preserves the implemented four-tool design as superseded history. [`0003-core-search-and-provider-specialists.md`](0003-core-search-and-provider-specialists.md) governs the replacement target: small common search, lazily active provider specialists, tool-local Pi guidance, and no generic answer orchestration tool. [`0005-tool-local-agent-guidance.md`](0005-tool-local-agent-guidance.md) governs where complete runtime guidance lives for both the current tools and that target surface.

Provider contract evidence remains separate under the [`provider-evaluation` master ADR](../0005-provider-evaluation-and-guidance/README.md). Provider apprenticeship can justify a specialist's fields, but it does not automatically authorize public exposure.

## Child dependency

- **ADR-001.001:** what jeito websift must achieve and what remains out of scope.
- **ADR-001.002:** superseded four-tool implementation and durable evidence semantics.
- **ADR-001.003:** governing public-surface migration to core search and provider specialists.
- **ADR-001.004:** tool calls compose; hard failure is the exception — modes combine with visible mode labels and next-step hints.
- **ADR-001.005:** every websift tool owns one complete, non-repetitive runtime usage flow in its registered definition; APPEND retains only cross-tool evidence routing.

## Revisit conditions

Revisit this master when focused trajectories show the common core or specialist teaching model is systematically unintuitive, or when a provider operation cannot fit a search/fetch/answer/lookup specialist honestly.

## History

- 2026-08-04: Added ADR-001.005 after the owner rejected APPEND-level operation guidance and made registered tool definitions the complete runtime guidance owner across the websift stack.
- 2026-08-01: Replaced the four-verbs-only constraint after repeated advanced-schema construction failures; ADR-001.003 now governs the migration while ADR-001.002 remains implementation history.
- 2026-07-28: Preserved the existing decision while moving it into the numbered master/child ADR hierarchy.
