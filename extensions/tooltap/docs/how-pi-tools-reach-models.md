---
title: "How tooltap makes deferred tools visible and executable"
description: "Current mental model for registration, provider visibility, model epochs, route-specific execution, and the cache invariant that forbids gateway schema promotion."
tags: [tooltap, architecture, provider-tools, model-epochs, gateway, cache-stability]
created: 2026-07-26
updated: 2026-09-17
status: active
owns: "The operational mental model connecting tooltap state, provider visibility, and executable tool definitions"
audience: contributor
---

# How tooltap makes deferred tools visible and executable

tooltap keeps most tool schemas out of a model's initial callable surface while preserving one public `tools` control that can discover and enable them. The difficult part is that **registered**, **active**, **visible to the provider**, **enabled in the current model epoch**, and **executable** are different properties. Never use one as proof of another.

The binding behavior is owned by `docs/contract.md:tooltap-extension-contract#1`. This page explains how that behavior fits together; it does not replace the contract.

## Separate the five tool states before debugging

| State | Meaning | Current owner or proof |
|---|---|---|
| Registered metadata | Pi knows a tool's name, description, and parameter schema. | `pi.getAllTools()`; inventory only |
| Ordinary active | Pi includes the tool in the ordinary active surface for the current epoch. | `extensions/index.ts::orderedActiveTools` and `pi.getActiveTools()` |
| Epoch-enabled | tooltap has granted session permission and classified the name as baseline or late. | `extensions/index.ts::beginModelEpoch`, `epochBaseline`, `epochLate` |
| Provider-visible | The provider adapter serialized a declaration for the model. | The provider-specific tool container in `/stow-dump-context`; never infer this from `getAllTools()` |
| Executable | The selected route can invoke the real registered implementation. | Native active execution, direct dispatch APIs, or gateway `getRegisteredTool(name)` |

Two distinctions prevent most false conclusions:

1. `getAllTools()` proves registration, not provider visibility and not access to the executable definition.
2. An enabled name is not necessarily ordinary active. A late gateway name must remain absent from ordinary provider declarations and execute through `tools`.

## Follow one tool through a model epoch

A model epoch is one exact provider/API/model identity. At a genuine identity boundary, every previously enabled eligible tool becomes the new epoch's frozen ordinary baseline. Tools enabled afterward enter `epochLate` and remain route-late-bound until the next genuine identity change.

```text
registered tool
    │
    ├─ model boundary ───────────────► epoch baseline ─► ordinary full schema
    │
    └─ enabled inside current epoch ─► epoch late ─────► native, direct, or gateway route
                                                        │
                                      next model boundary┘ becomes baseline
```

This is why an ordinary provider declaration may change once at a model boundary but must not change when a gateway/direct tool is enabled inside that epoch. `docs/adr/0011-model-epoch-enabled-tool-rebasing.md:adr-0011-rebase-enabled-tools-into-each-model-epoch/decision#2` owns that trade-off.

## Route late tools without changing their shared permission

All routes use the same route-neutral enabled permission. The selected model route changes only how a late tool is represented and executed:

- **Native:** `tools({request})` enables Pi's provider-owned deferred representation through `setActiveToolsWithDeferred(activeNames, nativeLateNames)`; the model then calls the exact tool directly. Late snippets/guidelines appear in the activation result, not the earlier system instructions.
- **Direct:** `tools({request})` returns the complete contract and grants dispatch-only permission; the model calls the undeclared exact name directly.
- **Proxy/gateway:** `tools({request})` returns the complete contract. A second `tools({request:<exact name>, arguments:{...}})` validates and invokes the registered implementation.

The route decision is internal. Models see exactly one public control and never need to learn `native`, `direct`, or `proxy`. `docs/adr/0010-configured-cache-safe-routing.md:adr-0010-route-one-tools-control-through-configured-cache-safe-execution/decision#2` owns why the routes differ without becoming different public tools.

## Resolve additional-tool intent before changing permission

An exact tool or group remains authoritative. Otherwise `extensions/index.ts::resolveCapabilityRequest` ranks policy-eligible additional tools locally with BM25 over names and discovery text. Operator-curated `manifestBlurb` text may authorize one high-confidence enablement; raw implementation descriptions can produce suggestions but cannot authorize fuzzy permission changes. Close results return up to three ranked suggestions and mutate nothing.

This separation is deliberate: retrieval evidence proposes a capability, while `requestEnable` owns permission. `explicitOnly`, excluded, blocked, active, quarantined, and already-enabled names remain outside fuzzy enablement.

## Keep the gateway declaration frozen within the epoch

Gateway enablement must preserve three facts together:

1. `tools` remains present and its serialized declaration stays byte-identical.
2. The enabled target remains absent from ordinary provider `tools[]`.
3. The target executes only through `tools({request, arguments})`.

`extensions/index.ts::currentControlDeclarationKey` deliberately excludes `epochLate`, so enabling a gateway target cannot rebuild the public declaration from mutable state. `extensions/index.ts::requestEnable` deliberately avoids `setActiveTools` for the proxy route. `extensions/index.ts::executeThroughControl` obtains the executable definition through `getRegisteredTool` instead of promoting the target.

These are one invariant, not three optional optimizations. Promoting the target can make execution appear fixed while changing the provider's cacheable tool prefix; keeping bytes stable without executing the real implementation is also a failure.

## Treat runtime capabilities as execution boundaries

Stock Pi 0.85.1's ordinary `setActiveToolsByName` couples executable activation to rebuilding the base system prompt. Adding a tool with `promptSnippet` or `promptGuidelines` changes the early prefix even when its provider schema is correctly deferred. Stock registered metadata also omits the snippet and cannot execute a target by itself.

The first-party compatibility owner, `patches/ensure-pi-registered-tool-api.mjs`, adds `getRegisteredTool(name)` and `setActiveToolsWithDeferred(toolNames, deferredNames)` to Pi's bundled and SDK surfaces. Deferred activation records the exact deferred prompt-name set; the shared prompt builder filters only those names. It still rebuilds ordinary instructions normally. Stow's `requestEnable` calls this boundary before persisting permission, and `refreshActiveTools` reapplies the epoch partition on restoration/reselection. `toolUsageContract` retrieves missing snippet metadata from the registered definition rather than dropping it.

Apply runtime compatibility changes as an explicit maintenance operation with a backup and restart, not extension-startup repair. The patch fails closed on unsupported source shapes. Direct late execution separately requires `getDispatchTools()` and `setDispatchTools()`. Missing cache-safe native APIs cause pre-request gateway fallback; missing gateway lookup is reported by `notifyRouteResolution` and `executeThroughControl`. No fallback promotes a late target into the ordinary declaration.

When a required runtime API is absent:
- keep the public `tools` control present;
- keep the target absent from ordinary provider declarations;
- fail wrapper execution explicitly;
- do **not** call `setActiveTools` as a fallback;
- do **not** rebuild `tools` from mutable late-enable state;
- do **not** claim a mocked runtime proves the active host.

The fail-closed requirement is binding in `docs/contract.md:tooltap-extension-contract/runtime-capability-boundary#2`.

## Diagnose the provider surface from the strongest available evidence

Run `/stow-dump-context <label>` only after at least one provider request. The dump separates:

- `providerSnapshot.payload`: what tooltap observed and returned unchanged at its provider hook;
- `providerSnapshot.inputAudit` and `outputAudit`: structural hashes at that hook;
- `activeTools`: Pi's ordinary active names;
- `registryInventory`: registered metadata, never a provider declaration claim.

Inspect the provider-specific declaration container when it is available. OpenAI-compatible payloads commonly use `tools[]` or `tools[].function`; other adapters use different shapes. A custom provider may not expose its final tool container in this hook. In that case, report the observation limit and use Pi's active surface only as an adapter-boundary check—not as byte-level wire proof.

The hook is observational and may be followed by another extension's handler. A tooltap snapshot proves tooltap' output stage, not an unobserved later rewrite.

## Use the smallest regression gate before broad verification

For a gateway regression, stop after the first failed signal:

1. Start a fresh session on one configured proxy route.
2. Capture the ordinary declaration or strongest observable active surface.
3. Call `tools({request:"find Pi documentation for developing extensions"})` and require one confident `pi_docs` enablement from curated discovery metadata.
4. Capture the same surface again; require byte identity when provider bytes are observable and require `pi_docs` absence.
5. Call `tools({request:"pi_docs",arguments:{}})`.
6. Require the real `pi_docs` result, not model narration.

Interpret failures by boundary:

| First failing signal | Investigate first | Do not do |
|---|---|---|
| `tools` missing at startup | `orderedActiveTools`, name ownership, registration | Promote targets or change routing |
| Declaration changed after enablement | `currentControlDeclarationKey`, proxy branch of `requestEnable` | Accept execution as sufficient proof |
| `Registered tool … unavailable for execution` | Active runtime `getRegisteredTool` capability — reapply `patches/ensure-pi-registered-tool-api.mjs` (startup emits this diagnostic with the exact command) | Call `setActiveTools` for the target |
| Provider rejects the request before any tool execution | Provider adapter/request compatibility | Blame or redesign gateway dispatch |
| Model enables but does not issue the second call | Model compliance/prompting after deterministic wrapper proof | Infer that the wrapper cannot execute |

Run the focused repository harness before a live model gate because it calls the wrapper deterministically. Run the broader package and installation suites only after this six-step gate closes. `docs/real-world-verification.md:real-world-tooltap-verification-contract/fast-gateway-regression-gate#2` owns the repeatable proof procedure.

## Use each document for one question

- Current binding behavior: `docs/contract.md:tooltap-extension-contract#1`.
- Architecture and state transitions: this document.
- Why one control and three routes: `docs/adr/0010-configured-cache-safe-routing.md:adr-0010-route-one-tools-control-through-configured-cache-safe-execution#1`.
- Why model boundaries absorb late tools: `docs/adr/0011-model-epoch-enabled-tool-rebasing.md:adr-0011-rebase-enabled-tools-into-each-model-epoch#1`.
- Live proof and failure interpretation: `docs/real-world-verification.md:real-world-tooltap-verification-contract#1`.
- Operator configuration: `tool.yaml.template`.
- Implementation: `extensions/index.ts::toolSearchExtension`; focused regression checks: `test-harness.ts`.

Update this mental model when a state dimension, route execution mechanism, provider observation boundary, or required Pi runtime API changes. Do not add chronological experiment results here; place current proof in the verification contract and preserve design history in the owning ADR.
