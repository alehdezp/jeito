---
title: "tooltap extension contract"
description: "Binding one-control contract for model-epoch baselines and cache-safe native, direct, and gateway late enablement."
tags: [tooltap, tools, provider-routing, gateway, cache-stability]
created: 2026-07-10
updated: 2026-09-17
status: active
owns: "Binding additional-tool policy, one-control route execution, restoration, and cache-safety boundary"
audience: contributor
---

# tooltap extension contract

This document is binding. If code, configuration, tests, or provider behavior differs, treat that as a bug until the owner deliberately changes this contract.

## North star

A smart fresh agent encounters one coherent control, reaches the right additional capability, learns the minimum real contract, and executes correctly without learning route vocabulary. Additional tool schemas and instructions stay out of startup context because they are often unnecessary—not because those tools are discouraged—and gateway provider tool bytes stay stable.

The operational state model is explained in `docs/how-pi-tools-reach-models.md:how-tooltap-makes-deferred-tools-visible-and-executable/separate-the-five-tool-states-before-debugging#2`; it does not weaken this contract.

## One public control

tooltap registers exactly one model-facing function named `tools`. It never registers public `search_tools`, `tool_proxy`, aliases, compatibility names, or separate selector lanes. Historical names are accepted only as bounded session-migration input.

The route-derived schemas are exact:

```ts
// native and direct
{ request: string }

// gateway
{ request: string, arguments?: object }
```

`request` is required and nonempty. Extra properties fail validation. Gateway `arguments` means the complete parameter object for one exact already-enabled tool.

The control description renders ordinary enabled tools as one compact name-only line because their full schemas are already present. Additional tools retain concise discovery descriptions so agents can recognize useful capabilities before enabling their full contracts.

## Selector resolution

Tool names and configured group names share one normalized namespace. Resolution is:

1. one exact unique tool or configured group identifier;
2. natural capability search only when no exact identifier exists.

Capability resolution is local BM25 over policy-eligible additional-tool names and discovery text. An exact name remains authoritative. A fuzzy result auto-enables exactly one tool only when the calibrated score gap agrees and its discovery text has one explicit authority: either a host-authored `manifestBlurb`, or the registered source description when its loader-assigned `sourceInfo.source` is listed exactly in `trustedDescriptionSources`. Untrusted implementation descriptions may rank suggestions but cannot authorize permission mutation. `explicitOnly`, excluded, blocked, active, quarantined, and already-enabled names never enter fuzzy enablement.

Trusted-source descriptions are rendered in the manifest without a duplicate `manifestBlurb`; the registered tool remains the sole text owner. Source trust is host policy, not a tool self-assertion. Reserve `manifestBlurb` for built-in or third-party tools whose source should not be edited.

Results preserve canonical spelling. Startup normalized collisions are invalid and block enablement, but never remove a registered `tools` control. A conflicting tool registered later is quarantined with a diagnostic; existing unrelated tools and groups remain usable. If another extension owns `tools`, its winning registration remains active and tooltap reports that it cannot provide its own semantics.

Hash discovery matches anywhere in tool and group names rather than only at the beginning: `#x` may offer `web_search_x`, and `#stack` may offer `web-stack`. Entries with remaining members or tools to enable sort before entries already callable in the current epoch; status text says `Not enabled` or `Enabled` explicitly.

An exact marker for an already callable tool is reference-only: it leaves the marker in the user message but injects no activation message, contract, or permission change on any route. A partially enabled group requests only missing members and records already callable members as skipped.

## Model epochs and route ownership

A genuine provider/API/model identity change freezes every currently enabled eligible tool into the newly selected model's ordinary full-schema tool array for that entire epoch, on every route. Those baseline tools are called directly without another `tools` request. Tools enabled after the epoch begins remain late-bound until the next genuine model change absorbs them into the next baseline.

`tool.yaml` keeps internal model classifications named `native`, `direct`, and `proxy`; `proxy` selects model-facing gateway behavior for **late** tools and is not a public tool name.

- **Native late enablement:** `tools({request})` enables through Pi's deferred representation. The agent then calls the enabled exact tool directly.
- **Direct late enablement:** `tools({request})` returns the complete contract and grants dispatch-only permission while ordinary provider schemas remain unchanged. The agent then calls the exact tool directly.
- **Gateway late enablement:** `tools({request})` discovers or enables and returns the complete contract. A later `tools({request:<exact enabled name>, arguments:{...}})` validates and executes the real registered implementation.

Gateway late execution is strictly two-step. Arguments on an unavailable tool, group, or capability request fail before state mutation. Invalid arguments never reach the underlying implementation. Repeated valid execution works. A gateway baseline tool may still execute through `tools({request, arguments})` for compatibility, but its ordinary full schema is authoritative and current guidance directs the exact-name call.

Route selection is recalculated on `model_select`. A genuine identity change also rebases the enabled set before the next request; a same-identity reselect or runtime restart preserves the persisted epoch classification. Native requires both Pi model deferred-tool support and cache-safe runtime activation. Qualified exact route matches outrank unqualified/family matches; equal-specificity conflicts and unknowns fail safe to gateway behavior. Shipped `gpt-^` classification includes Astra, suffixed variants, and future GPT identifiers without bypassing either capability gate.

## Runtime capability boundary

Native requires `setActiveToolsWithDeferred(toolNames, deferredNames)` and `getRegisteredTool`. The former activates real implementations while excluding deferred names from the generated base prompt's selected tools, snippets, and guidelines; internal rebuilds retain that exclusion. Stow supplies its native late set on activation and same-model restoration, and clears the exclusion when those tools become an ordinary next-epoch baseline. The activation result carries the complete new guidance instead. Missing native capability selects gateway before the first request, never the ordinary cache-breaking activation path.

Direct late binding requires `getDispatchTools` and `setDispatchTools`; strict gateway execution requires `getRegisteredTool`. Missing capability does not authorize removing `tools` or activating a gateway target ordinarily. The stable gateway control remains present, enablement keeps provider `tools[]` byte-identical and the target absent, and wrapper execution fails explicitly until registered-tool lookup exists. `patches/ensure-pi-registered-tool-api.mjs` owns the additive compatibility adaptation; the extension does not install or apply it at startup.

Standalone release readiness therefore requires an explicit compatible-runtime proof; the package version alone is not sufficient evidence.

## Policy

- `excluded` wins across discovery, activation, restoration, dispatch, and execution.
- `explicitOnly` contributes zero individual catalog metadata and requires an exact request, exact marker, `/tool`, or configured group.
- `unlisted` omits catalog text but remains eligible for exact and capability resolution.
- Groups are operator-authored activation collections, not orchestration programs.
- Optional gateway normalization applies only declared primitive coercion, trimming, and schema defaults; it never guesses names, enums, or structure.
- Startup/core tools remain directly callable and are not re-enabled through `tools`.

## State, restoration, and compaction

One route-neutral enabled-name set owns session permission. A versioned epoch state partitions it into an ordinary full-schema baseline and names enabled late in the current epoch, keyed by exact provider/API/model identity.

Every enablement and genuine model switch appends non-model state containing unlocked, baseline, late, and model identity. A same-model fresh runtime restores a complete valid disjoint classification exactly. A different selected model rebases every restored eligible name into its baseline. Malformed newest v2 state cannot override recoverable older names: their union restores conservatively as late with a warning. Legacy names-only state is likewise underdetermined and restores as late until a genuine model switch; the extension records the v2 migration and never fabricates a baseline.

Compaction makes only late contracts stale: one exact no-argument request may redisplay each late contract once. Baseline contracts remain present in ordinary provider tool definitions and receive no redundant refresh.

Completed historical loader and gateway pairs migrate atomically when one old call matches one old result and selector/result targets agree. Loader calls become `tools({request})`; old gateway calls become `tools({request, arguments})`. Target disagreements, duplicate IDs, unmatched results, and zero/multi-lane loader calls fail with a restart/rollback diagnostic rather than fabricating history. Current one-control permission comes only from versioned state—underlying execution-result metadata cannot unlock another tool. Historical enablement guidance is rewritten by current epoch class; unrelated conversation bytes remain untouched.

## Result and execution semantics

Gateway execution forwards `AbortSignal`, `onUpdate`, context, underlying errors, and text/image/resource content. It returns a shallow result copy with merged execution metadata so frozen underlying results cannot fail after side effects. Public `tools` execution is conservatively sequential until dynamic target scheduling is proven safe.

`before_provider_request` is observational: it may record hashes and diagnostics but returns no replacement and mutates no payload.

## Cache boundary

Ordinary provider tool declarations are frozen within a model epoch. Baseline schemas may enter provider `tools[]` once at a genuine identity change. Gateway/direct late enablement does not change that ordinary declaration; native late definitions use Pi-owned deferred transport. Switching back intentionally rebases the newly selected model with every tool enabled elsewhere, so its former declaration may be replaced once. `before_provider_request` observes but never replaces payloads. Structural hashes verify epoch boundaries; they are not product-value scores.

Late enablement and repeated execution must also preserve previously sent system instructions and conversation content. Stable `tools[]` alone is insufficient. Do not insert late tool snippets/guidelines into earlier system instructions, discard guidance, freeze unrelated system-prompt updates, or rewrite provider payloads to hide a mutation. Test Pi's normal generated prompt: a fixed-system fixture cannot prove this boundary.

Pi provider adapters classify transcript-loaded tools through historical tool-result `addedToolNames` metadata. Context projection removes only validated `epochBaseline` names from that metadata; late names retain it until the next epoch. This changes provider placement through ordinary context semantics, not provider-payload replacement.

## Commands and markers

`/tool`, `##tool`, `#tool:tool`, and configured group markers feed the same policy and route-neutral enabled state. Native marker/command messages ask the model to call `tools({request:<exact name>})`; they do not bypass ordinary native enablement. Current messages distinguish baseline direct calls from route-late execution and never teach a second public control.

## Forbidden

- Public `search_tools`, `tool_proxy`, aliases, or route-specific public names.
- Separate `names`, `groups`, `query`, `mode`, or execution selector lanes.
- Atomic first-contact gateway execution.
- One-request baseline promotion or removal before the next genuine model change.
- Immediate ordinary schema promotion for gateway/direct tools enabled inside the current epoch.
- Extension-owned provider payload replacement, injected client `tool_search`, `_toolSearchOutput`, dependency patches, or automatic repair.
- Provider/model identities hardcoded in TypeScript.
- Comparative call/round/token counts used as product adoption gates.

## Required direct checks

1. Exactly one public `tools` registration; legacy names absent from clean surfaces.
2. Exact native/direct and gateway schemas reject extra fields.
3. Exact tool, exact group, capability fallback, canonical spelling, and policy behavior.
4. Strict gateway enable-then-execute, validation, repeat execution, and unchanged underlying semantics.
5. Native active definitions and direct dispatch-only calls.
6. Model-epoch switching, same-model v2 restart, conservative v1 restoration, late-only compaction refresh, and bounded legacy-pair migration.
7. Startup/late selector collisions and startup/late public-name ownership conflicts.
8. Cancellation, updates, frozen/non-text results, conservative ordering, and non-mutating provider observation.
9. Within-epoch gateway/direct declaration stability, late-schema absence, and one-boundary baseline absorption after model switching.
10. Compatible-runtime failure is explicit and fail-closed.

Live host checks follow [`real-world-verification.md`](./real-world-verification.md).
