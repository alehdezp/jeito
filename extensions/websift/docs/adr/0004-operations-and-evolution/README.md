---
title: "ADR 4 — Operations and evolution"
description: "Master ADR for setup and diagnosis, provider provenance and drift handling, vendored inspection source, installation, migration, and rollback."
tags: [jeito-websift, adr, operations, setup, provenance, installability]
created: 2026-07-28
updated: 2026-07-28
status: active
adr_id: ADR-004
adr_type: master
decision_status: accepted
confidence: evidence-backed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Setup, diagnosis, provenance, evolution, installation, and rollback boundaries"
audience: contributor
parent: docs/adr/README.md
children: [docs/adr/0004-operations-and-evolution/0001-setup-doctor-maintenance.md, docs/adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md, docs/adr/0004-operations-and-evolution/0003-vendoring-evolution-install.md]
related: [docs/upstreams/README.md, THIRD_PARTY_NOTICES.md, AGENTS.md]
---

# ADR 4 — Operations and evolution

## Master decision: explicit setup and human-reviewed evolution

jeito websift separates normal startup from setup, diagnosis, provider-source upkeep, and migration. Setup is interactive and secret-safe; diagnosis is read-only by default; provider drift is reviewed against mapped source; installation and rollback remain reproducible.

- [`0001-setup-doctor-maintenance.md`](0001-setup-doctor-maintenance.md) owns `/skill:websift-setup`, `/web-doctor`, and `/skill:websift-maintain`.
- [`0002-provenance-and-upkeep.md`](0002-provenance-and-upkeep.md) owns upstream source ledgers, license provenance, and drift review.
- [`0003-vendoring-evolution-install.md`](0003-vendoring-evolution-install.md) owns maintainer-only vendor inspection, fresh-machine installation, migration, and rollback.

Current upstream facts live in [`docs/upstreams/`](../../upstreams/README.md). Aggregate installation policy remains governed by the repository [`AGENTS.md`](../../../AGENTS.md).

## Revisit conditions

Revisit when installation lifecycle changes, a provider's license/source can no longer be reproduced, automatic upkeep becomes measurably safer and cheaper than human review, or rollback cannot restore one known working owner.

## History

- 2026-07-28: Preserved the existing decision while moving it into the numbered master/child ADR hierarchy.
