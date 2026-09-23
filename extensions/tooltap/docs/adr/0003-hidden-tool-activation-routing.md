---
title: "ADR 3 — Route hidden-tool activation by provider capability"
description: "tooltap keeps three provider routes selected by exact capability: native client search, capability-gated text-direct (any verified free-form model, never proxied), and proxy-default (tool_proxy is the default; a frozen bare-skeleton subset of frequent tools is direct). Amended 2026-07-31."
tags: [tooltap, adr, activation-routing, tool-proxy, dispatch, provider-capability]
created: 2026-07-29
updated: 2026-08-23
status: stale
adr_id: ADR-003
adr_type: child
decision_status: superseded
confidence: confirmed
evidence_grade: measured
implementation_status: partial
decision_owner: alehdezp
owns: "The activation-state model and provider-route selection for hidden tools"
audience: contributor
code: [extensions/index.ts::requestEnable, extensions/index.ts::registerToolProxy, extensions/index.ts::hasProxiableTools, extensions/index.ts::injectDeferredToolSchemas]
related: [../contract.md, ../how-pi-tools-reach-models.md, 0001-top-level-tools-byte-stability.md, 0005-tolerant-teachable-tool-proxy.md]
---

# ADR 3 — Route activation by provider capability

## Decision

A hidden tool is never made callable by mutating top-level `tools[]`
([ADR-001](0001-top-level-tools-byte-stability.md)). Instead, activation moves
it through explicit states and one of three execution routes chosen by **exact
provider + API + model capability**, not model-name substring guessing
(amended 2026-07-31 — see the amendment note below):

| Route | Used by | How the tool becomes callable |
|---|---|---|
| `openai-client-search` | GPT-5.4/5.5/5.6 Responses | `tool_search_output` / `additional_tools` in `input[]` ([ADR-002](0002-openai-native-client-tool-search.md)) |
| `text-direct` | any model **verified** for free-form direct dispatch (DeepSeek V4 Pro, Gemini 3 Flash, and future verified models) | full contract in conversation; model emits the undeclared name; Pi dispatch executes — **never proxied** |
| `proxy-default` | every other family (GLM/KiMi/MiMo, Qwen, MiniMax, …) | `tool_proxy` is the **default**; a **frozen bare-skeleton subset** of frequent tools is in `tools[]` from session start and calls directly ([ADR-004](0004-skeleton-shape-only-schemas.md)) |

## The three allowlists

`requestEnable` records activation in three disjoint sets, each feeding a
different mechanism ([`extensions/index.ts::requestEnable`](../../extensions/index.ts)):

- `unlocked` → `setDispatchTools(...)` — execution permission for direct calls
  (text-direct, skeleton).
- `proxyEnabled` → accepted by `tool_proxy`
  ([`extensions/index.ts::registerToolProxy`](../../extensions/index.ts)).
- `additionalToolsActivated` → GPT `additional_tools` / native output.

Startup-active tools are pre-added to `unlocked` at `session_start`; requesting
them again is a no-op, so re-activation never rewrites the surface.

## Amendment 2026-07-31 — three routes; proxy-default; capability-gated text-direct

`shape-direct` and `explicit-proxy` **merge into one `proxy-default` route.**
`tool_proxy` is the default for every non-native, non-text-direct family; a
**frozen skeleton subset** ([ADR-004](0004-skeleton-shape-only-schemas.md)) of
frequent tools sits in `tools[]` from session start and is called directly,
while every other hidden tool is proxied at zero upfront schema cost. Four
routes become three.

`text-direct` is **config-driven by model id, not a fixed provider list**: any
model whose id matches a configured `textDirectModels` prefix (default
`["deepseek-"]`) is free-form regardless of the gateway provider it runs
through; `textDirectProviders` adds provider-qualified overrides; and the
verified exact routes (deepseek-v4-pro, gemini-3-flash-preview) stay
text-direct unconditionally. On every text-direct route the proxy is **never
mentioned**: it is stripped from the payload, scrubbed from the tool_search
description and enablement instructions.

This bends around [ADR-001](0001-top-level-tools-byte-stability.md) (untouched):
the skeleton subset derives from the immutable startup config, frozen at
`session_start`, so `tools[]` is never mutated mid-session. It revises (does not
repeat) the universal-proxy rejection below: the proxy is now the default on
proxy-capable routes but is **not** universal — native and text-direct are
exempt and the skeleton subset calls directly. Proxy reliability on the newly
default routes (GLM/KiMi/MiMo) and skeleton-subset direct-calling there are
**inferred, not measured** — re-grade after live runs.

## The Fix 2 change (2026-07-29)

Before this change, `tool_search(names:[…])` on an `explicit-proxy` route put a
regular discoverable tool into `unlocked` (dispatch) and told the model "use the
real tool name directly." But on `explicit-proxy` the tool is absent from the
schema and models like Qwen 3.8 do not reliably emit undeclared calls, so the
tool was effectively unreachable — discovery succeeded, execution failed.

The fix routes **all** tools activated through `tool_search` on an
`explicit-proxy` route into `proxyEnabled` instead
([`extensions/index.ts::injectDeferredToolSchemas`](../../extensions/index.ts)
handler routing), so `tool_proxy(name)` works deterministically. The proxy
already validates arguments, blocks recursion, and is now registered/active
whenever any tool could route through it
([`extensions/index.ts::hasProxiableTools`](../../extensions/index.ts)), not only
when `explicitOnly` tools exist. The instruction message becomes "Call
tool_proxy with the exact enabled tool name…", which is true on this route.

## What we rejected

- **A universal proxy for every route.** Still rejected. As of the 2026-07-31
  amendment the proxy is the *default* on proxy-capable routes, but it is not
  universal: native (OpenAI) and text-direct (verified free-form) routes are
  exempt, and the frozen skeleton subset calls directly. The original rationale
  ("forcing a directly-callable tool through a proxy adds a hop for no benefit")
  no longer binds for the *non-frequent* tools, which are proxied for a real
  reason — to drop their upfront skeleton shape cost.
- **Mutating `tools[]` to add the activated tool.** Rejected by
  [ADR-001](0001-top-level-tools-byte-stability.md).

## Evidence

- Live Qwen 3.8 Max Preview (`explicit-proxy`): `tool_search(names:["pi_docs"])`
  returned "Call tool_proxy with…", and `tool_proxy(pi_docs)` executed and
  returned 46 files. Group→proxy regression (`pi_version`) still returns
  `0.82.1`. `toolsHash` stayed constant; `cacheRead` present.
- Local fixture harness and `tsc` typecheck green after the change.
- Route-boundary audit (verified by code read, 2026-08-01 — code-read grade,
  not live-measured): `tool_proxy` never reaches a route that must not see it.
  In `injectDeferredToolSchemas`: the openai-client-search branch drops the
  proxy from the initial GPT surface (`if (isProxy) continue`, ~line 1481);
  the text-direct branch filters it out of `payload.tools` (~line 1436); the
  explicit-proxy branch returns the payload unchanged so the proxy stays
  (~line 1437); the shape-direct skeleton list excludes it (~lines 1378-1379).
  The operator's `APPEND_SYSTEM.md` carries no `tool_proxy` mention. Re-grade
  with live payload capture on each route.

## Known gap (implementation_status: partial)

The marker (`##tool` / `#group`) and `/tool` command paths still
**dispatch**-enable regular tools on `explicit-proxy` rather than proxy-enable
them, because those handlers lack reliable route detection (the command handler
has no model in its context). They work only when the model happens to emit the
undeclared call (observed model variance). Routing them through the proxy too is
a deferred follow-up in [`../future-roadmap.md`](../future-roadmap.md); it needs
route detection added to the marker/command paths and matching fixture updates.

How the `tool_proxy` on this route is made reliable to call — strict tolerance (change a value's type, never its meaning) plus general schema-derived teaching, with the proxy parameter named `args` — is owned by [ADR-005](0005-tolerant-teachable-tool-proxy.md).

## Revisit condition

When route detection is available uniformly across all activation entry points,
proxy-enable regular tools on `explicit-proxy` from markers and `/tool` as well,
and re-grade `implementation_status` to `validated`.
