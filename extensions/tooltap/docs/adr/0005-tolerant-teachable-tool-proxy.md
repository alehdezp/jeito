---
title: "ADR 5 — A strict, teachable tool_proxy: change a value's type, never its meaning"
description: "On the explicit-proxy route, tooltap makes hidden tools reliable through strict tolerance (coerce primitive types, trim, apply declared defaults — nothing that interprets meaning) plus three general schema-derived teaching artifacts, with the proxy parameter named args and multi-form input deferred without a numeric gate."
tags: [tooltap, adr, tool-proxy, reliability, tolerance, teaching, schema-driven, explicit-proxy, args]
created: 2026-07-30
updated: 2026-08-23
status: stale
adr_id: ADR-005
adr_type: child
decision_status: superseded
confidence: confirmed
evidence_grade: verified
implementation_status: done
decision_owner: alehdezp
owns: "The reliability/intuitiveness design for tool_proxy on the explicit-proxy route: strict tolerance + general schema-derived teaching, args parameter, multi-form deferred"
audience: contributor
code: [extensions/index.ts::registerToolProxy, extensions/index.ts::buildDescription, extensions/index.ts::buildProxyContextMessage]
related: [../contract.md, 0001-top-level-tools-byte-stability.md, 0003-hidden-tool-activation-routing.md, 0004-skeleton-shape-only-schemas.md]
---

# ADR 5 — A strict, teachable `tool_proxy`

## Decision

On the `proxy-default` route — `explicit-proxy` in
[ADR-003](0003-hidden-tool-activation-routing.md), the default for every
non-native, non-text-direct family as of the 2026-07-31 amendment, so this
design now governs any family routed through the proxy (GLM/KiMi/MiMo included)
— a hidden tool is reached through one `tool_proxy({ name, args })` call, where
`args` carries the underlying tool's parameters. The model gets no typed
per-call guidance, so reliability comes from two things and **never** from
putting schemas back into top-level `tools[]`:

- **Strict tolerance.** Before validation, `tool_proxy` coerces a primitive to
  the schema's declared type (`"5"`→`5`, `"true"`→`true`), trims strings, and
  applies declared defaults — then reports what it did. **It changes a value's
  *type*, never its *meaning*.** Every other mismatch is a loud error, not a
  silent fix.
- **General, schema-derived teaching.** Three artifacts computed from any
  tool's schema, with zero per-tool authoring and nothing fabricated: the
  always-loaded pattern, the enablement signature card, and the real-error
  failure card.

The proxy parameter is named **`args`** (renamed from `arguments`). Multi-form
code input is **deferred and unbuilt**, with **no numeric gate** — it is
reconsidered only on qualitative evidence that the JSON shape itself (not the
model's knowledge) is the blocker.

## The line: type, not meaning

This is the load-bearing distinction and the one a future maintainer is most
likely to blur, so it is stated as a rule. Tolerance is legitimate **only where
the schema dictates a single target** — coercing to a declared type, applying a
declared default. These are not guesses; the schema removes all ambiguity. The
moment a fix requires interpreting *intent* — renaming a parameter
(`vers`→`version`), fuzzy-matching an enum (`"general"`→`"general-purpose"`),
re-nesting structure — it becomes a guess, and a guess that misfires **silently**
is worse than a loud failure. With the signature in view the model has no excuse
to send a wrong name, so silently renaming it would mask the very failure
teaching is meant to surface. Reliable means predictable: the tool either runs
exactly as intended or returns an unambiguous correction.

Equally deliberate: **no fabricated example.** An auto-generated call guesses
which parameters co-occur, and that guess is often false (`read` takes `path`
XOR `paths`), so it would teach an invalid call. The enablement artifact shows
the **shape** — the honest menu of params + types, with `default`/`enum` values
inline only where the schema declares them — and lets the model fill a valid
combination, which it can because `tool_search` already handed it the full
schema.

## The three teaching artifacts

One template applied to any tool; nothing per-tool, nothing guessed.

1. **Always-loaded pattern** — in the `tool_proxy` description
   ([`extensions/index.ts::registerToolProxy`](../../extensions/index.ts)):
   hidden tools are proxied; load one with `tool_search` (full schema), then call
   `tool_proxy({ name:"<tool>", args:{ …its parameters… } })`; parameters go
   inside `args`; on failure you get the tool's own error plus this reminder.
2. **Enablement signature card** — on enable, computed from the schema in
   [`extensions/index.ts::buildProxyContextMessage`](../../extensions/index.ts):
   the signature (params, types, required; declared defaults/enums inline) and
   the wrapping pattern. **No example call.**
3. **Failure card** — the original error verbatim (never swallowed) plus a short
   wrapping reminder, not a schema dump and never a guessed correction. Two
   layers: proxy-level (not enabled / mis-wrap) and tool-level (the underlying
   tool rejected the params). The reminder targets the #1 confusion: *this tool
   is proxied — parameters belong inside `args`, not as top-level fields.*

Teaching and tolerance share one principle — surface the truth, don't
manufacture it — and one deterministic analyzer: a failed call gets the real
error plus the wrapping pattern, never a fabricated fix.

## What we rejected

- **Fuzzy parameter rename.** Silently remapping a wrong name is a guess that
  masks failure; it is the anti-pattern this ADR exists to forbid.
- **Enum fuzzy-matching and structure reconciliation.** Same defect — they
  interpret meaning.
- **A fabricated example call.** Guesses parameter co-occurrence; can teach an
  invalid call.
- **LLM / heuristic argument repair in the hot path.** Non-deterministic, adds
  latency and cost to every call, and is unnecessary because the schema already
  disambiguates the structural failures that actually occur. If anyone ever wants
  it, it is a separate, explicitly-gated, opt-in *slow* path — not "tolerance."
- **Natural-language argument translation** and **context-inferred arguments.**
  Speculative; the latter violates fix-don't-guess.
- **A numeric gate for multi-form** (e.g. ">N% failures"). No percentage was ever
  claimed; inventing one is false precision. Multi-form is judged qualitatively
  on evidence.
- **Per-tool authored content** (hand-written gotchas or examples). The user
  installs arbitrary tools, so guidance must be one general algorithm over the
  schema, never authored per tool.
- **A per-feature flag taxonomy and a unit-test regime.** Rollback is one on/off
  flag for the whole behavior; proof is the gauntlet, not a mandated test matrix.
- **Dynamic per-tool schemas in the prefix.** Defeats the token goal and violates
  [ADR-001](0001-top-level-tools-byte-stability.md).

- **Loosening the `tool_proxy` wrapper schema to accept top-level parameters.** A
  live 2026-08-04 probe confirmed the strict wrapper schema (`required:
  [name, args]`, `additionalProperties: false`) rejects stray top-level params at
  the client gate before proxy logic runs. Accepting them (making `args`
  optional, allowing root extras) would require re-nesting top-level fields into
  `args` — structure reconciliation, a meaning-guess this ADR forbids — and
  would delete the loud error that teaches the correct wrapping pattern.
## Consequences and implementation obligations

- **Serves the cache invariant.** The only prefix cost is the catalog signatures
  in [`extensions/index.ts::buildDescription`](../../extensions/index.ts),
  derived from the immutable startup set, so byte-stable
  ([ADR-001](0001-top-level-tools-byte-stability.md)). Everything else rides
  conversation.
- **One rollback flag** for the whole behavior; additive — no working route
  (OpenAI-native, text-direct, skeleton, or the current proxy flow) is removed.
- **Transparency obligation:** every coercion/default is reported; nothing is
  silently changed.
- **Changes vs holds** (grounded in the current `registerToolProxy`): *holds* —
  proxy execution via `getRegisteredTool`, `proxyEnabled` gating, strict
  `validateSchema` with specific path+type errors, `additionalProperties:false`
  enforcing params-in-bag, and the existing `buildProxyContextMessage` enable
  message. *Changes* — `arguments`→`args`; a `normalizeArguments` step before
  `validateSchema`; failure-path enrichment (catch the tool's own error + the
  wrapping reminder); reshape `buildProxyContextMessage` to a signature card;
  rewrite the description/snippet; catalog signatures; one flag.
- **The `args` rename is a clean break.** `tool_proxy` is an internal surface
  with no external consumer of the field; each session uses its own schema and
  old logs are history, not replay. No compat shim.

## Evidence and verification

Honest grade: **verified**, **done**. The *direction* is `confirmed` by the
owner; the *mechanisms* are now built and exercised by a fixture gauntlet.

Already evidenced: the cold Qwen 3.8 gauntlet showed hidden tools — including
the complex `Agent` — called through `tool_proxy` with zero first-call failures
when the schema was freshly loaded; cache stability is `measured`/`verified`
under [ADR-001](0001-top-level-tools-byte-stability.md) and
[ADR-003](0003-hidden-tool-activation-routing.md).

Now evidenced by the fixture gauntlet (`npm run gauntlet`, 27/27 passing): strict
tolerance coerces string→integer/number/boolean and trims strings and fills
declared defaults, each change reported in `normalizedArguments`; clean
primitives pass through uncoerced; non-coercible types, missing-required, and
unknown-param calls are still rejected (no silent guess) with the specific
`validateSchema` error plus the wrapping reminder; a runtime throw from the
underlying tool is surfaced verbatim and annotated; a non-enabled name gets the
`tool_proxy({name, args})` guidance. This proves the mechanism, not field
frequency.

Still not evidenced: the *rate* at which these failure classes occur in real
traffic, and the gauntlet baseline-vs-after latency delta. The field gauntlet
(failure rate + cause + per-call latency) remains the proof instrument for those;
[`../contract.md`](../contract.md) forbids efficiency claims without measured
data, so no number is asserted here.

## Revisit conditions

- If strict tolerance proves too strict (a real, frequent failure class it
  refuses), widen it — but only to fixes the schema dictates, never to meaning
  interpretation.
- If teaching + tolerance leave a residue of failures that evidence attributes
  to the JSON shape itself (not the model's knowledge), reconsider the deferred
  multi-form code input.
- If normalization measurably moves per-call latency or any I/O creeps in, strip
  the offending stage.
- If an `explicit-proxy` family gains native client tool search or reliable
  undeclared-call dispatch, that route may move to a more intuitive
  representation ([ADR-002](0002-openai-native-client-tool-search.md),
  [ADR-004](0004-skeleton-shape-only-schemas.md)).
- If schema-constrained families migrate to the proxy per
  [ADR-004](0004-skeleton-shape-only-schemas.md)'s future direction, this design
  governs them; re-grade scope then (not anticipated now).
- If the discovery catalog's per-tool signatures grow with hidden-tool count
  into the dozens, collapse the prefix catalog to a group-only index (group
  names + one-liners) and fetch member names on demand via `tool_search`; do
  not add per-tool signatures speculatively before measured growth demands it.

## History

- 2026-07-30 — First written the same day as an *ambitious* tolerance design: a
  six-stage recovery pipeline including fuzzy parameter rename, enum
  fuzzy-matching, structure reconciliation, a generated example call, a ">10%"
  multi-form gate, a per-feature flag set, and a mandated unit-test regime. The
  owner rejected that as overengineered and reliability-hostile — a silent rename
  is a guess that masks failure, the generated example guesses parameter
  co-occurrence, and the threshold was invented without any percentage claim.
  Reconciled to **strict tolerance** (type/trim/defaults — change a value's type,
  never its meaning), **signature-only** teaching (no fabricated example), a
  **real-error failure card**, the **`args`** parameter, **one** rollback flag,
  and a **qualitative** (un-numbered) multi-form gate. Scope confirmed: designs
  for the current `explicit-proxy` route, not a future skeleton migration.
- 2026-07-30 — Implemented in `extensions/index.ts`: the `args` rename, strict `normalizeArguments` (behind the `proxyNormalize` setting, default **off**), the real-error failure card, and the wrapping-reminder teaching text (description, snippet, intro, and `buildProxyContextMessage`). Typecheck and the fixture harness pass. The enablement message realizes the "no fabricated example" principle as the tool's **full contract plus the wrapping reminder** (the "signature card" wording above is that principle, not a literal signature-only payload). The catalog-signatures enhancement in `buildDescription` is **deferred** as a follow-up. Live gauntlet pending; `implementation_status` advanced `not_started -> partial`.
- 2026-07-30 — Live gauntlet run in-session (`npm run gauntlet`, fixture
  `proxyNormalize: true`): 27/27 checks pass, exercising every `normalizeArguments`
  branch and both failure paths (validate-time and runtime-throw). `evidence_grade`
  advanced `inferred -> verified` for the mechanism and `implementation_status`
  `partial -> done`. The gauntlet is wired into `package.json` (`gauntlet` script,
  part of `verify`) so the proof is repeatable. What remains field-only: the
  real-traffic failure *rate* and the latency baseline-vs-after delta.
- 2026-07-30 — Live-audit round (in-session probes + a `verifier` subagent) found
  and fixed two teaching defects, then reworked the guidance wording:
  - **F4**: the runtime try/catch that appended "Re-call via tool_proxy" to every
    underlying throw was removed. Reaching `tool.execute` means the call already
    passed both the `tool_proxy` schema (`additionalProperties:false`) and
    `validateSchema`, so the wrapping was correct and a re-call nudge was noise on
    a clean domain error. The wrapping reminder now appears only on validate-time
    failures. Gauntlet asserts the domain error propagates with NO reminder.
  - **F5**: the single "not proxy-enabled … Enable it with tool_search" error was
    branched into three truthful cases — excluded ("not available on any route"),
    already-active/direct ("call it directly, not through tool_proxy"), and
    not-yet-enabled ("enable with tool_search"). Excluded is checked before
    `blocked` because `blocked` is seeded from `excluded`.
  - **Guidance rewording** (per a live subagent retrospective + a gpt-5.6-sol
    consult): the enablement message now leads with one **concrete, schema-generated
    example call** (`exampleProxyCall`: real tool name, required params only,
    neutral type-appropriate placeholder values, first enum value for enums —
    fabricates no domain meaning) instead of the `<tool>`/`...parameters...`
    placeholder; and the always-loaded `tool_search` intro/snippet dropped the
    four-route self-classification paragraph, deferring the exact calling method to
    the enablement response. Typecheck, main suite, and gauntlet (30/30) all pass.
- 2026-08-04 — Live probe on the explicit-proxy route confirmed top-level-param
  calls (`tool_proxy({name, version})` without `args`) fail at the client schema
  gate (`args` required, no root extras) before `tool_proxy` logic runs. This
  strengthens the deferred multi-form position: accepting top-level params would
  require loosening the wrapper schema and re-nesting structure (forbidden
  meaning-interpretation), not a proxy-side normalization. No decision change.
