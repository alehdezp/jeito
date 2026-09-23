---
title: "ADR 3 — Engineering stewardship"
description: "Master ADR for retrieval-first documentation and ADR/code links, public contract stability, maintainability, and claim-scoped verification."
tags: [jeito-websift, adr, engineering, documentation, maintainability, testing]
created: 2026-07-28
updated: 2026-07-28
status: active
adr_id: ADR-003
adr_type: master
decision_status: accepted
confidence: confirmed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Documentation/code relationship and maintainability/proof policy"
audience: contributor
parent: docs/adr/README.md
children: [docs/adr/0003-engineering-stewardship/0001-documentation-and-code-links.md, docs/adr/0003-engineering-stewardship/0002-maintainability-and-testing.md]
related: [AGENTS.md, docs/WORK-PLAN.md, docs/adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md]
---

# ADR 3 — Engineering stewardship

## Master decision: retrieval-first rationale with lean behavior proof

Consequential rationale belongs in ADRs and provenance documents; implementation comments point to ADRs only when the non-obvious invariant needs protection at the action site. Tests prove locally owned behavior and real boundaries rather than vendor defaults or every field.

- [`0001-documentation-and-code-links.md`](0001-documentation-and-code-links.md) owns comment admission, ADR/code edges, and retrieval conventions.
- [`0002-maintainability-and-testing.md`](0002-maintainability-and-testing.md) owns contract stability, proof budgets, directory responsibility, and the definition of a coherent slice.

Provider contract provenance remains under [`ADR-004.002`](../0004-operations-and-evolution/0002-provenance-and-upkeep.md). The implementing-agent sequence remains in [`docs/WORK-PLAN.md`](../../WORK-PLAN.md), not in this decision family.

## Revisit conditions

Revisit when repeated maintenance demonstrates missing proof at a real security, billing, cancellation, migration, lifecycle, or data-loss boundary, or when retrieval checks show agents cannot locate the governing decision from code and task vocabulary.

## History

- 2026-07-28: Preserved the existing decision while moving it into the numbered master/child ADR hierarchy.
