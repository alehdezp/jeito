---
title: "ADR-0011: Rebase enabled tools into each model epoch"
description: "Freeze previously enabled tools into the newly selected model's ordinary full-schema tool array while keeping later enablements route-late-bound."
tags: [tooltap, adr, model-switching, cache-epochs, enabled-tools]
created: 2026-08-25
updated: 2026-08-25
status: accepted
adr_id: ADR-0011
adr_type: child
decision_status: accepted
confidence: confirmed
evidence_grade: tested
implementation_status: partial
decision_owner: alehdezp
owns: "Model-epoch baseline versus late-bound enabled-tool classification"
audience: contributor
code: [extensions/index.ts]
---

# ADR-0011: Rebase enabled tools into each model epoch

## Decision

A genuine provider/API/model identity change creates a new tool-declaration epoch. Every eligible tool enabled before that boundary becomes an ordinary active tool with its full registered schema for the entire new epoch, on every route. It can be called directly without another `tools` call.

Tools enabled after the boundary remain late-bound until the next model change:

- native uses Pi-owned deferred activation;
- direct changes dispatch permission without changing the ordinary declaration;
- gateway enables and executes through the one public `tools` control.

The next genuine model change absorbs all late tools into the next ordinary baseline. This is an epoch-frozen rebase, never a one-request promotion.

## Why

Route-only reprojection preserved old transport mechanics across a model switch even though the newly selected model began with a different cache identity. That made an already-enabled tool remain hidden and forced the new model to recover execution mode from historical guidance. The tool's actual state and its visible representation disagreed.

The model boundary is the right place to pay the declaration change once. Within the epoch, the ordinary baseline stays frozen and new enablements retain the cache-safe route transport. This preserves late-loading value while making inherited state self-describing through the provider's own tool schema.

## State ownership

tooltap owns:

- a route-neutral enabled set;
- the exact provider/API/model identity of the current epoch;
- a frozen ordinary baseline;
- a late set enabled after the epoch began.

Versioned non-model state persists all four. Same-model resume restores only a complete, disjoint classification. Different-model resume rebases every restored eligible name. A malformed newest v2 record cannot erase recoverable older names; their union restores conservatively as late with a warning. Legacy names-only state likewise cannot prove a baseline and remains late until a genuine switch. Current execution-result metadata is never permission authority.

Excluded, blocked, missing, quarantined, and colliding names never enter either class.

## Guidance and execution consequences

Baseline schemas are present in ordinary provider `tools[]`; current guidance tells the model to call them directly. Late gateway tools still require strict two-step execution through `tools`. Gateway may accept wrapper execution for an already-enabled baseline name as compatibility, but the wrapper is not required.

Historical enablement messages, duplicate responses, and contract refresh partition names by current epoch class. Context projection removes baseline names from historical `addedToolNames` metadata so Pi's deferred-tool adapter emits them as ordinary provider schemas; late names retain that marker. Completed historical execution results remain unchanged, and provider payload hooks remain observational.

## Cache consequence

ADR-0010's global gateway declaration invariant is narrowed to an epoch invariant:

- the ordinary tool declaration may change once at a genuine model boundary by absorbing enabled names;
- gateway/direct late enablement does not change ordinary `tools[]` within the epoch;
- native late enablement continues through Pi-owned deferred transport;
- switching back may intentionally replace that model's former declaration with a larger baseline.

Full baseline schemas occupy context for the epoch. This is an accepted trade for unambiguous inherited callability, not a claim of zero token cost. Structural hashes verify declaration boundaries; they are not product scores.

## Rejected alternatives

- **One-request promotion:** the schema would disappear immediately and create a second declaration change plus contradictory history.
- **Guidance-only handoff:** prose would describe permission while leaving the enabled tool absent from the new model's authoritative callable surface.
- **Whole-set route reprojection:** preserves the confusion this decision removes.
- **Immediate ordinary promotion on every enablement:** destroys within-epoch declaration stability and repeats the cache failure late binding exists to avoid.

## Verification

Focused proof must show a late tool absent within its enabling epoch, present and directly callable after a model switch, stable as baseline while another tool is enabled late, absorbed with that late tool at the next switch, and restored exactly across same-model versioned resume. Provider payload inspection—not registry inventory—owns the final live declaration claim.

Fresh Pi 0.84.3 native-route proof on 2026-08-25 verified the sequence directly from provider snapshots: `epoch_x` was absent while late on GPT-5.4, present with its full schema after switching to GPT-5.4-mini while `epoch_y` remained absent, and both schemas were present after switching to GPT-5.5. `.tmp/stow-model-epoch/native-provider-summary.json` indexes the snapshots. The active additive runtime also passed strict commandcode Muse gateway execution while preserving target absence; direct live proof still requires dispatch APIs.

