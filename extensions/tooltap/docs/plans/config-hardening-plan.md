---
title: "tooltap config hardening & routing plan (features 4, 7, 9, 10)"
description: "Historical config-hardening plan predating ADR-0010 configured cache-safe routing."
tags: [tooltap, planning, config, routing, diagnostics, guidelines]
created: 2026-07-31
updated: 2026-08-02 (rev 5 — Increment 3 shipped; D1/D2 closed)
status: stale
related: [docs/adr/0005-tolerant-teachable-tool-proxy.md, docs/adr/0006-native-enablement-guidelines-in-description.md, docs/adr/0007-guidelines-marker-fallback-custom-prompts.md]
---

# tooltap config hardening & routing plan

> **Historical:** ADR-0010 and `docs/contract.md` now own routing, guidance, proxy visibility, and cache evidence. Do not implement this plan against the current package.

## Recommendation and delivery logic

Ship the two zero-risk diagnostics first (4 + 7, one shared session-start pass),
then resolve the one open design question on the bare-schema tier (9) before
building it, then ship the guidelines-injection fallback (10) which is already
verified as a real gap. Order is by risk and dependency, not by request order:
4/7 unlock honest config feedback that makes 9/10 safer to reason about; 9 is
gated on a user decision because it may be redundant with `startup`.

Status 2026-08-02 (rev 5): all four features closed. 4/7 shipped as
Increment 1; 10 shipped as the marker-fallback, NOT the description-injection
originally planned (Increment 2, ADR-007), later extended to the native route
(ADR-006); 9 shipped as the bareSchema skeleton subset after D1 resolved
(Increment 3, ADR-003/004 amendments).

Scope: four additive features in `extensions/tooltap/extensions/index.ts`.
No working route is removed. 4/7 and 9 are config-gated (`configHealthCheck`,
`policy.bareSchema` — empty by default = byte-identical); 10 is unconditional
by design (a flag would leave the gap for everyone — see ADR-007).

## 1. Outcome and boundaries

Objective: make tooltap config honest and its tool-guidance robust across
route types and custom system prompts.

Observable success:
- Ghost groups and stale overrides produce a startup warning (4, 7).
- A config option (`policy.bareSchema`) lets commonly-used hidden tools ship a
  frozen shape-only skeleton up front on the proxy-default route (9 — shipped).
- Operator `promptGuidelines` overrides reach the model even under a custom
  system prompt that lacks Pi's standard markers (10).

Non-goals: no LLM/heuristic behavior; no change to OpenAI-native or text-direct
routing (both verified to strip `tool_proxy` correctly); no new prefix token
cost beyond the flagged, opt-in description injection.

Decision owner: user. Affected: any agent session using tooltap.

## 2. Current state and load-bearing assumptions

Verified facts (this session, by code read):
- `session_start` hook at line 2060 has `ctx.ui.notify` and `pi.getAllTools()`,
  reads config at 2078, calls `refreshActiveTools(ctx)` at 2088. Home for 4/7.
- `config.groups` and `config.toolOverrides` are in memory at session start.
- `rewriteGuidelinesSection` (1206-1215) is marker-dependent: needs `Guidelines:\n`
  plus one of four end-markers, else returns text unchanged → overrides lost.
- OpenAI-native strips `tool_proxy` (1399); text-direct filters it (1372);
  explicit-proxy keeps it (1373). `tool_proxy` absent from APPEND_SYSTEM.md.
- `rewriteProviderToolDescriptions` (1110) already rewrites per-tool description
  in the payload — the natural home for 10's injection.

Assumptions carrying the plan:
- A1 (4/7): `pi.getAllTools()` at session_start lists every tool any loaded
  extension will register. Basis: Pi loads extensions before session_start.
  If false, the check could mis-flag late-registered tools as ghost.
  Cheapest evidence: log getAllTools().length at session_start vs after first
  provider request. Result → if late registration exists, run the check lazily
  on first `before_provider_request` instead. Owner: assistant.
- A2 (9): RESOLVED 2026-08-02. "Bare schema" is the existing ADR-004 skeleton
  mechanism reused on the proxy-default route for a frozen config-named subset —
  not a full-schema tier, not `startup`. The initial dismissal was an
  axis-collapse error (schema-presence conflated with always-on); the owner's
  correction and the ADR-003/004 amendments record the resolution.
- A3 (10): RESOLVED. Subagent review rejected description-injection outright;
  the shipped fix is the marker-fallback in `rewriteGuidelinesSection` (ADR-007).

## 3. Delivery strategy

The diagnostics (4/7) cause the objective by surfacing config drift at the only
moment the operator can act on it (startup), using data already in memory. The
guidelines fallback (10) causes its objective by restoring the operator's
override lines when Pi's `Guidelines:` marker is absent (custom prompts), at
the point of failure, in the prompt where guidelines belong (ADR-007).
The bareSchema subset (9) causes its objective by emitting a frozen,
shape-only skeleton for config-named frequent tools on the proxy-default
route — direct reach without the always-on cost of `startup`, full
instructions riding conversation on first use (ADR-003/004 amendments).

Alternatives considered for 10: (a) detect missing marker and conditionally
inject — rejected as overengineered; (b) always inject behind a flag —
rejected because default-off leaves the gap for everyone. Both gave way to the
root-cause fix: append the section when the marker is absent, no flag.
Rejected for 9: a new full-schema tier (YAGNI until the owner named the failing
behavior), then mid-session tools[] injection (forbidden by ADR-001).

Integration: 4/7 touch only `session_start`. 10 touches
`rewriteGuidelinesSection` (prompt path) and — via ADR-006 — the native
enablement description. 9 touches payload delivery (`injectDeferredToolSchemas`
explicit-proxy branch), the activation fork, and first-use contract arming.

## 4. Increments

### Increment 1 — session-start diagnostics (features 4 + 7) — DONE (2026-07-31)

Outcome: startup warnings for ghost groups and stale `toolOverrides`.
Included: one `diagnoseConfig()` pass over `config.groups` and
`config.toolOverrides` vs `pi.getAllTools()`; `ctx.ui.notify` warnings;
`configHealthCheck` flag (default true).
Excluded: auto-fix / auto-removal (diagnostic only — the user decides what to
remove; auto-mutation of config is out of scope and risky).
Integration point: end of `session_start` (after `refreshActiveTools`, line 2088).
Acceptance: typecheck + suite + gauntlet green; a fixture with a fake group
member and a fake override produces two warnings.
Existing evidence reused: gauntlet harness boots the extension end-to-end.
New proof: extend the fixture or a throwaway boot to assert warnings fire.
Rollback: `configHealthCheck: false`.
Status: implemented. `diagnoseConfig()` + `configHealthCheck` flag landed in
`extensions/index.ts` (interface, readUserConfig, fallback, function, session_start
call) and surfaced in `tool.yaml.template`. Typecheck + suite + gauntlet (30/30)
green; LSP clean. Live warning observation pending a reloaded session.

### Increment 2 — guidelines marker-fallback (feature 10) — DONE (2026-07-31)

Outcome: operator `promptGuidelines` reach the model under custom prompts.
**Subagent verifier rejected the original flag-gated description-injection as the
wrong shape** (boltons guidelines onto the tool schema → token bloat + cache
instability; default-off leaves the bug in place for everyone). Verified-better
fix, root-cause at the point of failure: make `rewriteGuidelinesSection` (lines
1205-1215) **fall back to appending a `Guidelines:` section with the override
lines when the marker / end-marker is absent**, instead of returning the text
unchanged. Reuses the existing unshift/dedup logic. ~5 lines, **no flag**.
Scope stays honest: only operator `config.promptGuidelines` overrides are
restored — a tool's own built-in guidelines under a custom prompt are Pi core's
responsibility, not tooltap'.
Acceptance: under a custom prompt lacking the marker, the payload's system prompt
gains a Guidelines section with the operator's override lines; standard prompts
unchanged (marker path still wins, so no double-count).
Status: implemented in `rewriteGuidelinesSection` (no flag, root-cause). Deeper
root cause confirmed by reading Pi's `buildSystemPrompt`: when `customPrompt` is
set it returns early and skips the Guidelines section ENTIRELY, so a custom prompt
loses all tool guidelines — the fallback restores the operator's overrides by
appending a `Guidelines:` section. Proven by gauntlet section 11 (36/36): custom
prompt gains the section + override; standard prompt keeps exactly one section
(no double-count) and also surfaces the override. Typecheck + suite + gauntlet green.
Extended 2026-08-02 (ADR-006): the native OpenAI client `tool_search`
enablement path — the one enablement method whose returned contract omitted
guidelines — now appends operator (or built-in) guidelines to each returned
definition's description. Discovery/catalog text and top-level `tools[]` stay
unchanged; no non-standard field is added. Gauntlet section 13 proves it
(51/51); operator config for the native path resolves through
`config.promptGuidelines[name] ?? tool.promptGuidelines`, consistent with
`fullUsageContract`.

### Increment 3 — bareSchema subset (feature 9) — DONE (2026-08-02)

History (preserved): the subagent adversarial review recommended DROP (YAGNI),
arguing a directly-callable full-schema-upfront tool IS `startup`. That
recommendation collapsed two independent axes — schema-presence-in-tools[] and
always-on-from-session-start — and was overruled by the owner's clarification:
bareSchema is the ADR-004 skeleton reused on the proxy-default route, not a
full-schema tier. The ADR-003/004 amendments (2026-07-31) record the decision.

Outcome: `policy.bareSchema` (default empty = byte-identical to prior
behavior) names a frozen subset of hidden tools that get a shape-only skeleton
in the initial `tools[]` on the explicit-proxy route; every other hidden tool
stays behind `tool_proxy`. The subset derives from frozen config + stable
registry, so `tools[]` is byte-stable across turns (ADR-001).
Included: `bareSchema` on `ToolPolicy`/`UserConfig`; `bareSkeleton()` reusing
`compactSchemaShape`; skeleton emission in the explicit-proxy branch of
`injectDeferredToolSchemas`; activation-fork exclusion (bare tools dispatch
direct, never proxied); first-use contract arming reused from the shape-direct
path. Excluded: the shape-direct route (GLM/KiMi/MiMo keep validated
skeleton-for-all; the three-route merge is a later, measurement-gated increment).
Acceptance: gauntlet section 12 — skeleton emitted, shape kept / prose
stripped, only the configured subset skeletonized, byte-stable across two
identical requests, dispatched direct, `tool_proxy` rejects the bare tool as
already directly callable, non-subset tools never skeletonized. Status:
implemented; gauntlet 46/46, typecheck + suite green. Live measurement on a
real proxy-default session pending (roadmap phase-4b).

## 5. Dependency chain and constraints

4/7 (independent) → 10 (independent of 4/7, but benefits from honest config) →
9 (was blocked on D1; resolved 2026-08-02). All increments closed. No external
lead times remain.

## 6. Risks, contingencies, gates

- R1: late tool registration makes 4/7 mis-flag (A1). Warning: ghost warnings
  for tools that actually exist. Preventive: verify A1; contingency: run lazily.
- R2: 9 built speculatively and never used. RESOLVED: D1 answered before build;
  the shipped subset is config-gated and empty by default, so speculative use
  costs zero until an operator opts in.
- R3: 10 double-counts guidelines on standard prompts. Preventive: marker path
  still wins (fallback only fires when marker absent). No flag, no suppression logic.

## 7. Rollout, operations, learning

All flags default to current behavior except `configHealthCheck` (default on,
diagnostic-only). Verify via gauntlet + a live subagent in a fresh (reloaded)
session. Learning loop: the 4/7 warnings double as telemetry on whether the
group taxonomy is honest.

## 8. First executable commitment

Increment 1, owner assistant: add `diagnoseConfig()` + `configHealthCheck` flag,
wire into `session_start`, prove via typecheck/suite/gauntlet plus a warning
assertion. Completion: warnings fire for a planted ghost group and stale
override; all checks green.

## 9. Open user decisions

None open.

- **D1 (was: blocks 9) — RESOLVED 2026-08-02:** bareSchema is the frozen
  skeleton subset on the proxy-default route (owner's clarification + ADR-003/004
  amendments). Not `startup`; not a full-schema tier. Implemented in Increment 3.
- **D2 (was: 10 flag default) — SUPERSEDED:** no flag exists. Description-
  injection was rejected; the marker-fallback is unconditional (ADR-007), and
  the native route got its own mechanism (ADR-006).

## Change log

- rev 5 (2026-08-02): Increment 3 shipped (bareSchema subset, gauntlet 46/46);
  D1 resolved, D2 superseded; §2/§3 reconciled to as-shipped; DROP history
  preserved in Increment 3.
- rev 4 (2026-08-02, prior editor): Increment 2 extended to the native OpenAI
  route via ADR-006 (gauntlet 51/51).
- revs 1-3 (2026-07-31 to 2026-08-01): initial plan; Increment 1 done;
  Increment 2 done with marker-fallback root cause recorded.
