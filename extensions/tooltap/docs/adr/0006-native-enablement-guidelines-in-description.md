---
title: "ADR 6 — Native OpenAI tool_search enablement carries guidelines in the returned definition description"
description: "On the GPT client tool_search route, enabled tools' returned definitions carry operator (or built-in) guidelines appended to the description; discovery text and top-level tools[] stay untouched, and no non-standard field is added."
tags: [tooltap, adr, guidelines, tool-search, openai, enablement]
created: 2026-08-02
updated: 2026-08-23
status: stale
adr_id: ADR-006
adr_type: child
decision_status: superseded
confidence: confirmed
evidence_grade: tested
implementation_status: validated
decision_owner: alehdezp
owns: "The guideline-delivery shape for the native OpenAI client tool_search enablement route"
audience: contributor
code: [extensions/index.ts::toolDefinitionForTool, gauntlet.ts]
related: [0001-top-level-tools-byte-stability.md, 0002-openai-native-client-tool-search.md, 0004-skeleton-shape-only-schemas.md, ../contract.md, ../plans/config-hardening-plan.md]
---

# ADR 6 — Native OpenAI `tool_search` enablement carries guidelines in the returned definition description

## Decision

On the GPT/OpenAI native client-executed `tool_search` route
([ADR-002](0002-openai-native-client-tool-search.md)), the tool definitions
returned in a `tool_search_output` (and in `details.loadedTools`) carry the
tool's guidelines **appended to the `description`** of each returned
definition. Guideline source: the operator's `config.promptGuidelines[name]`
override first, else the tool's own built-in `promptGuidelines` — the same
fallback `fullUsageContract` already uses on the other enablement routes.

The discovery/catalog surface (manifest blurbs, search descriptions, top-level
`tools[]`) is **unchanged**. No non-standard field (e.g. `promptGuidelines`)
is added to the returned definition. Implementation:
[`extensions/index.ts::toolDefinitionForTool`](../../extensions/index.ts).

## Context

A custom system prompt skips Pi's `Guidelines:` section entirely, so tool
guidelines are silently dropped unless a delivery channel restores them.
tooltap' fallback (`rewriteGuidelinesSection`, feature 10) restores operator
overrides into the system prompt on the ordinary routes. An audit of every
enablement method showed the function-form `tool_search`, marker/group
activation, and first-use contract append all deliver guidelines through
`buildFullUsageContext`/`buildProxyContextMessage` — **except** the native
OpenAI client `tool_search` path, whose returned definitions were the only
contract the model received and contained no guidelines at all. That path is
the sole gap; this ADR closes it.

On this historical route the returned definitions were the enablement contract: the
now-removed `patches/add-client-tool-search.mjs` emitted them as
`tool_search_output.tools`, and the model read them at decision time. `description`
was the one universal free-form field every provider accepted—the native guidance
seat. Inspect the pre-ADR-0010 Git history for the removed patch; current behavior
is owned by `docs/contract.md`.

## What we rejected

- **A non-standard `promptGuidelines` field on returned definitions.** The
  definitions become provider tool definitions (`tool_search_output.tools`,
  and `additional_tools` on the marker route); an unknown field risks
  provider-side rejection or silent stripping. `description` is safe.
- **Appending guidelines to startup-visible tools' descriptions at session
  start (a "bake").** Token-neutral versus the existing system-prompt fallback
  but changes the visible surface for tools the model may never use, and would
  violate [ADR-004](0004-skeleton-shape-only-schemas.md) if applied to
  skeleton/bare-schema tools. Deferred; not requested.
- **Mutating top-level `tools[]`** — forbidden by
  [ADR-001](0001-top-level-tools-byte-stability.md). The `tool_search_output`
  is a conversation item, not the cached prefix, so appending guidelines there
  preserves the cache invariant.

## Evidence (tested)

Gauntlet section 13 (`gauntlet.ts`) drives the real native route
(`before_provider_request` with a Responses-shaped `gpt-5.4` payload, then
`tool_search` execute with explicit names) and asserts: the enabled tool is
returned; the description keeps its discovery base as prefix; the
`Guidelines:` block is appended with the operator's lines; no non-standard
top-level field exists on the returned definition; a tool without guidelines
keeps its description byte-identical. Full gauntlet: **51 passed, 0 failed**
(46 before this change); `tsc --noEmit` clean; fixture test-harness exits 0.

**Caveat:** proof is in-mock (fixture Pi). Live GPT execution remains blocked
by the Codex usage limit recorded in [ADR-002](0002-openai-native-client-tool-search.md);
re-grade to `verified`/`measured` after a fresh live GPT run.

## Consequences

- Enablement on the native route now always delivers guidelines, matching the
  "regardless of method" contract for tool enablement.
- Byte-stable: the augmentation derives from static config, so repeated
  enablements produce identical bytes; session replay preserves it because the
  patch re-emits from `details.loadedTools`, the same augmented objects.
- **Guidelines are never stripped as a token optimization.** Owner-confirmed
  (2026-08-02): `promptGuidelines`, when present, are always delivered on every
  enablement route — understandability outranks token savings. Schema
  *boilerplate* may be compressed; guidance never is.
- Hidden tools stay zero-token until enabled: guidelines appear only in the
  enablement output, never before.

## Revisit condition

If a provider adds a first-class guidelines field to tool schemas, prefer it
over description embedding and record the measured token/cache delta.
