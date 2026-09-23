---
title: "ADR 7 — Guidelines marker-fallback restores operator overrides under custom prompts"
description: "When the system prompt lacks Pi's Guidelines section (custom prompt case), rewriteGuidelinesSection appends operator promptGuidelines overrides as a Guidelines section instead of silently dropping them. Only operator overrides are restored, not built-in tool guidelines."
tags: [tooltap, adr, guidelines, custom-prompt, system-prompt, fallback]
created: 2026-08-02
updated: 2026-08-23
status: stale
adr_id: ADR-007
adr_type: child
decision_status: superseded
confidence: confirmed
evidence_grade: tested
implementation_status: validated
decision_owner: alehdezp
owns: "The guideline-delivery fallback for ordinary (non-native) routes under custom system prompts"
audience: contributor
code: [extensions/index.ts::rewriteGuidelinesSection, gauntlet.ts]
related: [0001-top-level-tools-byte-stability.md, 0006-native-enablement-guidelines-in-description.md, ../contract.md, ../plans/config-hardening-plan.md]
---

# ADR 7 — Guidelines marker-fallback restores operator overrides under custom prompts

## Decision

When the system prompt text lacks Pi's `Guidelines:` section marker — the
exact signature of a user-supplied `customPrompt` —
[`rewriteGuidelinesSection`](../../extensions/index.ts) **appends** a
`Guidelines:` section carrying the operator's `config.promptGuidelines`
overrides, instead of returning the prompt unchanged. When the marker is
present (Pi's default prompt), the existing rewrite path wins, so no
double-count occurs.

This is **not** flag-gated. It fires whenever the marker is absent and
operator overrides exist. The fallback is idempotent: repeated rewrites of
the same prompt produce identical bytes.

## Context

Pi's `buildSystemPrompt` returns early when `customPrompt` is set, skipping
the `Available tools:` and `Guidelines:` sections entirely. Under a custom
prompt, **all** tool guidelines vanish from the model — not just tooltap'
operator overrides but every tool's built-in `promptGuidelines` too. This is
Pi's design: a custom prompt opts out of Pi's prompt builder by user intent.

tooltap cannot restore built-in guidelines (Pi's prompt builder is their
sole source), but it **can** restore the operator's `config.promptGuidelines`
overrides, which flow through `rewriteProviderPromptOverrides` →
`rewritePromptText` → `rewriteGuidelinesSection`. Before this fix, that
function returned the text unchanged when the marker was absent, silently
dropping every operator override.

The native OpenAI route has a separate gap (returned definitions carry no
guidelines at all), closed by
[ADR-006](0006-native-enablement-guidelines-in-description.md). This ADR
covers the ordinary routes (explicit-proxy, shape-direct, text-direct) where
guidelines ride the system prompt.

## Scope boundary

Only **operator overrides** (`config.promptGuidelines`) are restored. Each
tool's **built-in** `promptGuidelines` are intentionally NOT restored: a
custom prompt is the user's deliberate choice to own the full prompt, and
second-guessing that boundary by injecting Pi's built-in guidelines would
override the user's intent. This is the correct, defensible scope.

## What we rejected

- **Injecting guidelines into tool descriptions.** Bloats every request's
  tool schema with token cost and cache-stability cost; mixes "what the tool
  is" with "how to use it well"; rejected by adversarial subagent review.
- **A flag-gated opt-in (`injectGuidelinesInDescription`).** Default-off would
  leave the silent gap for everyone — the tell that a flag is the wrong shape.
  The fix is unconditional because the gap is unconditional.
- **Restoring built-in tool guidelines.** Pi's prompt builder is their sole
  source; a custom prompt opts out by design. Restoring them would override
  the user's choice.

## Evidence (tested)

Gauntlet section 11 (`gauntlet.ts`) drives `before_provider_request` with a
custom prompt (no `Guidelines:` marker) and asserts: the prompt gains a
`Guidelines:` section; the section carries the operator's override lines; the
original prompt text is preserved verbatim before the appended section. A
standard prompt (marker present) keeps exactly one `Guidelines:` section (no
double-count) and also surfaces the override. Full gauntlet: **51 passed,
0 failed**; `tsc --noEmit` clean.

**Caveat:** proof is in-mock (fixture Pi). Live verification under a real
custom-prompt session remains pending; re-grade to `measured` after a live run.

## Consequences

- Operator `promptGuidelines` overrides now reach the model regardless of
  whether the system prompt is Pi-generated or user-supplied.
- Byte-stable: the appended section derives from static config, so repeated
  rewrites produce identical bytes. The fallback only fires when the marker is
  absent, so Pi-generated prompts (marker present) are untouched.
- Hidden tools stay zero-token until enabled: guidelines appear only in the
  system prompt (or enablement output via ADR-006), never in `tools[]`.

## Revisit condition

If Pi adds a first-class mechanism for extensions to inject guidelines into
custom prompts (e.g., a `customPromptGuidelines` hook), prefer it over the
marker-fallback and record the measured delta.
