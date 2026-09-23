---
title: "Design session — per-tool guidance move into registered three layers"
description: "Record of the grill interview and settled design that moved per-tool APPEND cards into each tool's registered description, parameters, and promptGuidelines."
tags: [tool-guidance, design-session, append-system, prompt-guidelines, writing-rules]
created: 2026-08-20
updated: 2026-08-20
status: active
owns: "Design-session record for the tool-guidance restructure"
audience: contributor
related: [tool-guidance-architecture.md, ../config/APPEND_SYSTEM.md]
---

# Design session — per-tool guidance move

The full interview ran over four grill rounds plus drafting rounds. This
record captures the settled decisions and the rejected alternatives;
the architecture doc (`tool-guidance-architecture.md`) owns the active
authoring contract.

## Problem

Per-tool operating cards lived in `config/APPEND_SYSTEM.md`, duplicating
each tool's registered schema text. Two owners of one fact drifted
(verified: read's `setup/install/#2` and `invariants#2` examples no
longer resolve; docs_search's `glob` parameter was absent from its
APPEND card). The tool description is the only field LLM APIs carry
tool instructions on.

## Settled decisions

- **Delivery (A):** tooltap fuses promptGuidelines into descriptions
  at payload build for every enabled tool on every route; operator
  override wins; appended once, deterministically. Mechanism parked
  (D9, deferred) — until it lands, startup-tool guidelines may not
  reach the model on the GPT route; safe by design because pre-call
  constraints live in description/parameters.
- **Layer split:** description = what + when + one gate + one minimal
  example. Parameters = per-field what/when/advanced/benefit + one
  complex worked example. promptGuidelines = only the non-obvious
  leftovers (composition, recommended escalation, a genuine trap); a
  few short lines, or none.
- **Read order:** the three blocks are read together as one continuous
  text, description → promptGuidelines → parameters. No block repeats
  an earlier one; a fact has exactly one home.
- **Optimize for what the tool can do, not what can go wrong.**
  Runtime messages own recovery; static text never pre-teaches error
  recovery or once-per-session scenarios. One hard worked example
  beats ten trivial ones.
- **Vocabulary:** training-familiar anchors (grep, cat/sed, ls/tree,
  find(1), git diff, LSP diagnostics — not human-visual editor
  metaphors); banned freshness words and internal/third-party brands
  (LeanCTX, CRG, Graphify, QMD, pi-nav).
- **APPEND keeps:** cross-tool doctrine — claim-class owner map in
  Part II opening, evidence-loop playbook, callable-by-default, scope,
  diagnostics, Source authority and Mutation discipline reframed
  without freshness words, plus pointer lines.
- **Tests (Q5, minimal):** loaded-tools asserts at most one non-empty
  promptGuidelines string per tool (find/ls/write approve with none);
  the APPEND-coverage half of the operating-reference test deleted
  (premise repealed); numeric-drift and no-readiness-hedges guards
  stay.

## Rejected alternatives

- **C (fusion for only a named few tools):** would break future
  third-party installed tools; asymmetric delivery.
- **Registration-time fusion:** breaks tooltap' operator-override
  mechanism, which needs the original guidelines.
- **Guidelines as recovery manuals with Use/Read/Recover/Stop
  skeletons:** repeats description/parameters; teaches error recovery
  the runtime messages own.
- **Task-to-sequence routing table:** banned by removed.md's graveyard
  (2026-07-22); the owner map is claim-class ownership, not a flow.

## Verified evidence

- tooltap delivery gap confirmed in code and the July context dump
  (startup-tool guidelines reach the model nowhere on custom-prompt
  routes).
- Two flash-model interviews (commandcode/deepseek-v4-flash): agents
  decide to call from description + trigger; critical constraints must
  never live only in guidelines.
- All twelve tool drafts were code-read and live-run before drafting
  (the drafting mandate), and every shipped example selector was
  verified to resolve.
