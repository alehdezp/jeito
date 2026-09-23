---
title: "ADR 4 — Shape-only skeleton schemas for schema-constrained providers"
description: "A stable shape-only skeleton (parameter shape kept, prose stripped) serves a frozen subset of frequent hidden tools on the proxy-default route; every other hidden tool is reached through tool_proxy. Amended 2026-07-31 from skeleton-for-all."
tags: [tooltap, adr, skeleton, schema-constrained, glm, kimi, mimo, token-reduction]
created: 2026-07-29
updated: 2026-08-23
status: stale
adr_id: ADR-004
adr_type: child
decision_status: superseded
confidence: confirmed
evidence_grade: verified
implementation_status: partial
decision_owner: alehdezp
owns: "The skeleton representation decision for schema-validating providers"
audience: contributor
code: [extensions/index.ts::injectDeferredToolSchemas, extensions/index.ts::compactSchemaShape]
related: [../how-pi-tools-reach-models.md, ../research-findings-2026-07-10.md, 0001-top-level-tools-byte-stability.md, 0005-tolerant-teachable-tool-proxy.md]
---

# ADR 4 — Shape-only skeleton schemas for schema-constrained providers

## Decision

For a **configured frozen subset** of frequent hidden tools — on the
schema-constrained families (`glm-`, `kimi-`, `mimo-`) and, by the 2026-07-31
amendment, as a reusable representation on any `proxy-default` route
([ADR-003](0003-hidden-tool-activation-routing.md)) — each subset tool gets one
**stable skeleton** entry in top-level `tools[]` from session start. The
skeleton keeps the parameter *shape* the provider needs to validate a call —
`type`, `properties`, `required`, `items`, `enum`, `anyOf/oneOf/allOf`,
`$ref/$defs`, `additionalProperties` — and strips the prose that costs tokens
without enabling the call: descriptions, instructions, examples, verbose
parameter docs ([`extensions/index.ts::compactSchemaShape`](../../extensions/index.ts)).
A one-line description flags that `tool_search` can load full instructions.
**Every other hidden tool is reached through `tool_proxy`
([ADR-005](0005-tolerant-teachable-tool-proxy.md)) at zero upfront schema cost.**

The subset is fixed in config and frozen at `session_start`, so the skeleton
entries stay byte-stable across turns (below, and
[ADR-001](0001-top-level-tools-byte-stability.md)). Skeleton-for-**all** was the
original scope; it was superseded on 2026-07-31 — see the amendment at the end.

## Context

These providers refuse a function call whose name or parameters were not
represented in the request schema, so strict zero-schema hiding is impossible
without a proxy ([`../how-pi-tools-reach-models.md`](../how-pi-tools-reach-models.md),
"Schema-validating models"). The skeleton is the best available trade: the model
can construct a valid first call from the shape, while the bulky guidance is
deferred until actually needed. Z.AI documents `parameters` as required for
parameterized functions; live probes matched
([`../research-findings-2026-07-10.md`](../research-findings-2026-07-10.md)).

The skeleton set is derived from the **immutable startup set**, so it is
byte-stable across turns and does not violate
[ADR-001](0001-top-level-tools-byte-stability.md). Loading a tool via
`tool_search` appends the full contract to conversation context; it never
changes the skeleton entries.

## What we rejected

- **Full hidden schemas up front.** Correct but expensive; defeats the purpose.
- **Strict zero-schema hiding on these providers.** The provider rejects
  undeclared calls; without a stable proxy this is not achievable here. (The
  proxy route is the path to zero upfront cost — see "Future direction".)

## Evidence (verified)

Code inspection plus retained measurements and live baseline. Representative
figures from [`../research-findings-2026-07-10.md`](../research-findings-2026-07-10.md)
and [`../future-roadmap.md`](../future-roadmap.md): recursive described skeletons
for 33 tools ≈ 12,923 bytes (~3,231 rough tokens), a stable 51-tool hash across
GLM/MiMo turns, and ~19.8K–23.8K cached tokens on continuations — roughly a 40%
reduction versus full hidden schemas. **Firsthand caveat:** skeleton routes were
not re-run live this session; the live pass is inherited from the dated baseline
[`../model-verification-2026-07-09.md`](../model-verification-2026-07-09.md).
Re-grade to `measured` after a fresh GLM/MiMo run.

## Amendment 2026-07-31 — subset skeleton + proxy for the rest (decided)

Supersedes "every eligible hidden tool gets a skeleton." The skeleton now serves
a **frozen subset** of frequent tools; **every other** hidden tool moves onto
`tool_proxy` ([ADR-003](0003-hidden-tool-activation-routing.md),
[ADR-005](0005-tolerant-teachable-tool-proxy.md)), removing even the skeleton's
upfront shape cost for the non-subset tools (only the proxy's tiny schema
remains). This realizes the future direction recorded above.

- **Mechanism reused, not removed.** `compactSchemaShape` and the stable
  structural preview are unchanged; only the *scope* changes (all → subset).
- **Byte-stability preserved.** The subset is config-driven and frozen at
  `session_start` from the immutable startup set, so skeleton entries never
  change mid-session ([ADR-001](0001-top-level-tools-byte-stability.md)). Full
  instructions for a subset tool still arrive in conversation on first use,
  never via `tools[]`.
- **Capability carve-out.** Text-direct (free-form) routes are exempt and never
  proxied — Gemini 3 Flash and any future verified free-form model stay direct
  ([ADR-003](0003-hidden-tool-activation-routing.md)).
- **Not universal.** The proxy is the default on proxy-capable routes, but
  native and text-direct are exempt and the subset calls directly — not the
  rejected universal proxy or universal skeleton.
- **Evidence gate (inferred → re-grade).** Skeleton-subset direct-calling on
  proxy-default routes, `tool_proxy` reliability on GLM/KiMi/MiMo, and the token
  delta versus skeleton-for-all are **inferred**, not measured. Re-grade to
  `measured` after live runs before claiming the benefit.

## Revisit condition

If a schema-constrained provider gains native client tool search, or the proxy
route is verified reliable for these families, supersede the skeleton for that
route and record the measured token delta.
