---
title: "ADR 2 — Internal provider architecture"
description: "Master ADR for provider layering, normalized contracts, routing and bounded fallback, composable fetching, and configuration/credential resolution."
tags: [jeito-websift, adr, architecture, routing, fetch, configuration]
created: 2026-07-28
updated: 2026-08-06
status: active
adr_id: ADR-002
adr_type: master
decision_status: accepted
confidence: evidence-backed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Internal architecture and shared runtime invariants"
audience: contributor
parent: docs/adr/README.md
children: [docs/adr/0002-internal-architecture/0001-layered-provider-architecture.md, docs/adr/0002-internal-architecture/0002-routing-and-failover.md, docs/adr/0002-internal-architecture/0003-fetch-pipeline.md, docs/adr/0002-internal-architecture/0004-config-and-credentials.md, docs/adr/0002-internal-architecture/0005-webclaw-extraction-redesign.md]
related: [docs/DESIGN.md, docs/adr/0001-product-and-evidence/0002-tool-surface-and-evidence.md, docs/adr/0003-engineering-stewardship/0002-maintainability-and-testing.md]
---

# ADR 2 — Internal provider architecture

## Master decision: stable public schemas over normalized orchestration

Public tools emit normalized intents and never call providers directly. The registry, routing/failure layer, adapters, fetch handlers, output retention, and configuration each own one reason to change. This shape keeps provider churn behind stable agent-facing contracts.

The child ADRs own separable invariants:

- [`0001-layered-provider-architecture.md`](0001-layered-provider-architecture.md) — layering, registry, normalized types, and dependency direction;
- [`0002-routing-and-failover.md`](0002-routing-and-failover.md) — deterministic selection, visible attempts, and bounded fallback;
- [`0003-fetch-pipeline.md`](0003-fetch-pipeline.md) — handler dispatch, extraction, discovery, and retained content (extraction lane superseded in direction by 0005, pending cutover);
- [`0005-webclaw-extraction-redesign.md`](0005-webclaw-extraction-redesign.md) — webclaw+tavily extraction stack, escalation policy, crawl/map port, `llm_answer` mode (settled, implementation pending);
- [`0004-config-and-credentials.md`](0004-config-and-credentials.md) — `web.yaml`, credential resolution, and secret-safe behavior.

The public contract comes from [`ADR-001.002`](../0001-product-and-evidence/0002-tool-surface-and-evidence.md). Proof and abstraction limits come from [`ADR-003.002`](../0003-engineering-stewardship/0002-maintainability-and-testing.md).

## Revisit conditions

Revisit the layering only when repeated provider work shows a real shared invariant cannot be protected in current owners, or Pi introduces a runtime contract that removes an entire layer without duplicating schema, configuration, cancellation, or provenance.

## History

- 2026-07-28: Preserved the existing decision while moving it into the numbered master/child ADR hierarchy.
- 2026-08-06: Added 0005 (webclaw extraction redesign, settled but unimplemented) and flagged 0003's extraction lane as superseded in direction pending cutover.
