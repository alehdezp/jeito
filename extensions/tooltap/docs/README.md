---
title: "tooltap documentation index"
description: "Reading order and ownership map for one-control routing, model-epoch rebasing, verification, and historical provider experiments."
tags: [tooltap, documentation-index, reading-order]
created: 2026-07-29
updated: 2026-08-28
status: active
owns: "tooltap documentation ordering and ownership map"
audience: contributor
---

# tooltap documentation index

Read in this order. The contract governs current behavior; the architecture explains the state machine; ADRs own the reasons; verification owns proof. When code and docs disagree, treat the mismatch as a bug until the owner resolves it.

## 1. Binding contract (start here)

- [`contract.md`](contract.md) — binding policy, model-epoch enabled state,
  route selection, cache boundary, restoration, and required tests.

## 2. Understand the state machine

- [`how-pi-tools-reach-models.md`](how-pi-tools-reach-models.md) — current mental model for registered, active, epoch-enabled, provider-visible, and executable tool state. Read this before changing activation or runtime fallbacks.

- [`../tool.yaml.template`](../tool.yaml.template) — annotated current configuration.
- [`ui-rendering.md`](ui-rendering.md) — UI-only renderer contract for the one public `tools` control.
- tooltap selects native, direct, or proxy execution from simple model groups in `tool.yaml`; Pi owns provider-native serialization, while tooltap never rewrites payloads.

## 3. Decisions (why the design is shaped this way)

- [`adr/README.md`](adr/README.md) — ADR index and metadata contract.
- [ADR-0010](adr/0010-configured-cache-safe-routing.md) — current decision: one `tools` control with configured native, direct, and gateway execution.
- [ADR-0011](adr/0011-model-epoch-enabled-tool-rebasing.md) — current model-switch decision: previously enabled tools become the next model epoch's ordinary full-schema baseline.
- [ADR-0009](adr/0009-pi-native-additive-activation.md) — superseded universal Pi-native attempt retained as failure evidence.

## 4. Verification (what is proven)

- [`real-world-verification.md`](real-world-verification.md) — what counts as live route and compatible-runtime proof, with pass/fail criteria per route.
- [`future-roadmap.md`](future-roadmap.md) and old implementation plans are historical evidence, not current execution authority.

## 5. Historical evidence (stale — read for context, not current truth)

- [`model-verification-2026-07-09.md`](model-verification-2026-07-09.md) —
  dated provider verification baseline (`status: stale`).
- [`research-findings-2026-07-10.md`](research-findings-2026-07-10.md) — dated
  research ledger behind the architecture (`status: stale`).
- [`research/oh-my-pi-architecture-notes.md`](research/oh-my-pi-architecture-notes.md)
  — external implementation notes, research only, nothing adopted
  (`status: stale`).
- [`validation/hidden-tool-callability-battery.md`](validation/hidden-tool-callability-battery.md) — withdrawn scored battery retained only as historical test-design evidence.
