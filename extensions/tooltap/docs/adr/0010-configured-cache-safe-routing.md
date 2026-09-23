---
title: "ADR-0010: Route one tools control through configured cache-safe execution"
description: "Expose one tools control while configured model groups select native, direct, or gateway execution."
tags: [tooltap, adr, tools, cache-stability, provider-routing]
created: 2026-08-24
updated: 2026-08-28
status: active
adr_id: ADR-0010
adr_type: child
decision_status: accepted
confidence: confirmed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "One-control model routing and cache-safe additional-tool execution"
audience: contributor
code: [extensions/index.ts]
---

# ADR-0010: Route one `tools` control through configured cache-safe execution

## Decision

tooltap exposes exactly one public control named `tools`. Users continue classifying normalized model names in three internal `tool.yaml` groups:

- `native`: `{request}` enables through Pi's deferred representation, then the exact tool is called directly;
- `direct`: `{request}` returns the contract and grants dispatch-only permission, then the exact tool is called directly;
- `proxy`: model-facing gateway behavior uses `{request, arguments?}` with strict two-step enablement and execution through the same `tools` control.

There is no public `search_tools`, `tool_proxy`, alias, or route selector. Unqualified exact names and trailing-`^` families work across providers; `provider/model` entries express exceptions. Unknowns and equal-specificity conflicts fail safe to the gateway classification. Native remains capability-gated.

One normalized selector namespace resolves an exact unique tool/group before capability search. Startup collisions invalidate the namespace; late conflicting tools are quarantined. Canonical spelling is preserved.

## Why

A fresh agent should learn one honest control rather than a loader plus a separate wrapper. Route mechanics still differ because provider capabilities differ, but that distinction belongs inside tooltap rather than in public control names.

The previous cache evidence remains mechanically relevant: ordinary schema promotion damaged reuse on several gateway models, while a stable gateway control kept individual schemas out of provider tool containers. That evidence governs transport—not product judgment through call/round scoring.

Direct and strict gateway execution depend on runtime registered-tool/dispatch APIs. Missing capability must never remove the one public `tools` declaration, but it also must never be disguised by ordinary schema promotion. Gateway enablement keeps the target absent and byte-stable; execution fails explicitly until a compatible runtime is present.

## Cache invariant, amended by ADR-0011

- A genuine provider/API/model change may rebase every previously enabled tool into that new epoch's ordinary full-schema tool array.
- Within the epoch, gateway exposes one stable `tools` declaration and keeps newly enabled target schemas out of provider containers until another model switch.
- Within the epoch, direct changes dispatch permission only.
- Native late definitions use Pi-owned deferred transport.
- `before_provider_request` observes but never replaces payloads.

Hashes verify epoch boundaries and within-epoch structure; they are not adoption scores. [`ADR-0011`](0011-model-epoch-enabled-tool-rebasing.md) owns baseline-versus-late classification and persistence.

## Lifecycle consequences

- Enabled permission is route-neutral; versioned state persists exact model identity, ordinary epoch baseline, and late names.
- Model switching rebases all enabled names into the next ordinary baseline before the next request; same-model resume restores the exact classification.
- Compaction makes only late contracts stale; one exact request may refresh each late contract once.
- Completed old loader/wrapper pairs migrate only when call/result identity and selector/target agreement are safe; ambiguous history stops with a diagnostic.
- Cancellation, updates, errors, frozen results, and non-text content pass through gateway execution.
- Foreign startup or late ownership of `tools` fails clearly.

## Configuration consequences

`name` and `proxyName` are removed. `label`, policy, groups, routing, rendering, markers, and strict primitive normalization remain. The operator-facing route key `proxy` remains for now so routing migration is not mixed with a vocabulary-only change.

## Superseded surface

This decision supersedes ADR-0010's earlier `search_tools` plus route-visible `tool_proxy` public surface while preserving its configured route classification and cache findings. ADR-0009 remains historical evidence for why universal active-schema promotion, provider injection, and dependency patching were rejected.
