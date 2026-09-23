---
title: "ADR 3.2 — Maintainability and claim-scoped verification"
description: "Records public contract stability, directory responsibilities, lean proof budgets, slice acceptance, and the boundaries that justify durable tests."
tags: [jeito-websift, adr, maintainability, testing, contract-stability, verification]
created: 2026-07-28
updated: 2026-08-05
status: active
adr_id: ADR-003.002
adr_type: child
decision_status: accepted
confidence: confirmed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Maintainability, contract stability, directory ownership, and proof strategy"
audience: contributor
parent: docs/adr/0003-engineering-stewardship/README.md
code: [src/registry.ts::AdapterRegistry, src/types.ts, tests/routing.test.mjs, tests/registration.test.mjs, tests/no-secret.test.mjs]
related: [AGENTS.md, tests/AGENTS.md, docs/WORK-PLAN.md, docs/adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md]
---

# ADR 3.2 — Maintainability and claim-scoped verification


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-003 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: confirmed`, `evidence_grade: verified`, and `implementation_status: validated`. The metadata—not optimistic prose—governs whether dependent work may treat the decision as proved.

The enforceable practices that keep the extension cheap to change as providers and
handlers multiply. Added after independent review (findings A1, K1, and the
reviewer's maintainability playbook). Pairs with the upstream-tracking/release
playbook in [`ADR 4.2 — provenance and upkeep`](../0004-operations-and-evolution/0002-provenance-and-upkeep.md).

## Contract stability (the four public schemas are the API)

- Tool names and parameter names are **immutable once shipped**. New parameters
  are additive with a safe default. Removing or renaming a parameter is a
  **major** version ([`0009`](../0004-operations-and-evolution/0002-provenance-and-upkeep.md) semver).
- The `details` envelope may gain keys (additive); never remove or repurpose an
  existing key. `Source.fetched`, `attempts[]`, `provider`, and `responseId` are
  load-bearing — never change their semantics.
- `AdapterCapability` is internal, but `operations`, `strengths`, `modes`,
  `returns`, and `fallbackEligible` are semi-stable because routing/dispatch
  depend on them.

## Deprecation

A deprecated parameter is kept, fires a `warning` in `details.warnings`, and is
removed only at a major bump.

## Reliability invariants — improvements over upstream (reviewer §7)

Deliberate upgrades over the incumbents, not copied behavior:

- **Typed failures.** Adapters throw a typed `ProviderError` with a `FailureClass`
  ([`0004`](../0002-internal-architecture/0002-routing-and-failover.md)); incumbents throw generic
  `Error("...status...")` (e.g. `serper-search/index.ts:66`).
- **Response-shape validation before normalization.** Adapters validate the shape
  and fail loud `empty` rather than `as any`-trusting it
  (`serper-search/index.ts:68`); this is what makes structural-`empty` sound.
- **Cancellation propagation.** Adapters thread the `OpContext` `AbortSignal` into
  in-flight HTTP (the fetch `AbortController`) so an aborted agent turn cancels
  the request and never issues a second billable call; incumbents ignore the
  signal. A test asserts abort cancels in-flight work.
- **`Retry-After` honored on 429** ([`0004`](../0002-internal-architecture/0002-routing-and-failover.md)).
- **No-secret-in-output** enforced as a shared gate (below), not assumed.

## Definition of done — one coherent provider change

1. Read the installed provider source or version-matched SDK/API contract. Map
   the complete reviewed operation and parameter surface in
   [`../ROADMAP.md`](../../ROADMAP.md) and the provider provenance document; the map
   stays concise but may not silently omit fields.
2. Implement the agreed provider capability inside the owning adapter or provider
   module. A capability may remain internal when it is not selected for the four
   model-facing tools; internal is not a hidden Pi tool and not dead scaffolding.
3. Keep public exposure selective. Map only useful, coherent controls into the
   four tools, with typed provider-specific branches when semantics genuinely
   differ. Do not expose a field merely because its implementation exists.
4. Prove selected behavior through the highest public boundary that can exercise
   it: register the extension, execute the affected Pi tool with a fake provider
   boundary, and assert the consequential request plus returned evidence state in
   one owning test. Cover an internal-only operation through the same focused
   provider execution path used for maintenance or comparison, not by registering
   another tool.
5. Reuse the shared routing, failure, output, and no-secret proof unless the change
   can affect those contracts. Do not create a provider-specific copy of a proof
   that already fails for the expected regression.
6. Run the focused owning proof and `npm run typecheck --workspace @alehdezp/websift`.
   Run the package suite only at a coherent slice or rollout boundary.

The change is not done because every helper has a unit test. It is done when the
provider capability is implemented at the agreed boundary, selected behavior
works through Pi, internal behavior remains maintainable without model exposure,
and the smallest proof would fail if the owned behavior regressed.

## Minimal high-value proof strategy

[`tests/AGENTS.md`](../../../tests/AGENTS.md) is the operational owner for test-file scope, behavior ownership, and the per-change proof budget. This ADR owns the durable rationale and exception classes; the test-folder instruction applies them at the proof site.

Prefer these proofs in order:

1. **Existing proof** that already exercises the changed behavior.
2. **One public-tool execution test** covering schema input, provider translation,
   and the agent-visible result together when the capability is exposed.
3. **One representative provider-operation proof** for internal-only capability;
   exercise several related fields in one realistic request instead of one test
   per field.
4. **One boundary-specific test** only when the integrated path cannot isolate a
   real risk such as cancellation, credential redaction, retained-content
   recovery, or billable fallback.
5. **One authorized live smoke** only when mocked execution cannot establish that
   the current provider accepts the request and returns the expected shape.

Tests should normally be shorter than the implementation they protect. If a
change adds more proof code than product code, stop and justify the excess before
landing it. Security, cancellation, migration, credential, billing, and data-loss
boundaries may justify the exception; ordinary option mapping does not.

Do not add tests for:

- trivial helpers, getters, field copies, or SDK behavior passed through unchanged;
- every enum member, optional field, provider default, or documentation sentence;
- snapshots of whole TypeBox schemas or provider responses;
- internal call order that a legitimate refactor may change;
- speculative malformed inputs outside the public trust boundary;
- a fixture corpus when one representative inline response proves the owned
  normalization.

Keep these durable shared gates because they protect stable project-owned risks:

- exactly nine registered public tools with no duplicate names;
- one representative routing/fallback chain with visible attempts;
- one retained-content round trip;
- one credential-redaction gate across provider output;
- focused cancellation proof where this project owns transport cancellation;
- TypeScript contract validation.

Existing tests are not deleted merely to improve a line ratio. Remove or merge a
test only when another proof owns the same regression or the behavior no longer
exists.

## Directory ownership

- `tools/` = public contract (rare change).
- `routing.ts` / `failures.ts` / `output.ts` / `config.ts` = shared core (rare).
- `adapters/` and provider-local modules = complete grounded provider capability;
  only selected mappings reach `tools/`.
- `fetch-handlers/` = extraction / upstream changes.
- `docs/adr/` = decisions; `docs/upstreams/` = provenance.

Do not create a generated capability registry, provider framework, test DSL, or
targeted-comparison platform. The roadmap table is the decision map; a temporary script or
one focused live comparison is enough until repeated comparison work proves a
durable harness would pay for itself.

## Over-engineering circuit breakers

- The complete reviewed provider surface is mapped and implemented as agreed.
  That requirement does not authorize extra providers, generic infrastructure,
  speculative ranking, or public exposure of low-value fields.
- A new abstraction needs three real consumers or a named shared invariant that
  cannot be protected coherently in place. Similar field names are not enough.
- A new test file needs a distinct stable boundary. Extend the owning public-tool
  test for another option on the same behavior.
- After two corrections fail under the same design premise, stop patching and
  return to the last verified provider contract.
- Retain grounded internal provider capability even when it is not publicly
  selected. Delete disposable probe harnesses and speculative abstractions, not
  agreed provider implementation.
- Do not add plugin systems, schema generators, DI containers, generic provider
  option bags, YAML-in-a-string arguments, caches, or ranking frameworks without
  a reproduced task that the current design cannot express.

One owner per behavior matters more than one file per concept. Split only when a
unit has a genuinely separate reason to change.
## What would change this

- A regression escapes the owning public-tool test → strengthen that test at the
  escaped boundary; do not start a broad fixture or property-test program.
- Repeated provider comparisons become expensive or inconsistent → add the
  smallest reusable comparison script for those observed cases.
- A selected provider capability cannot fit a four-tool verb without conditional
  ambiguity → consider one typed provider branch; a new tool requires a separate
  tool-surface decision.
- Stable release requirements grow beyond focused proof → add readiness checks at
  the release boundary, not to every implementation increment.
## Alternatives and decisive trade-off

Per-field and vendor-SDK tests inflate proof code without protecting owned behavior. Full-suite execution after every edit wastes time and obscures the owning claim. Representative public trajectories, internal-operation proof, and boundary-specific tests keep proof proportional while preserving billing, cancellation, secrets, migration, and data-loss invariants.

## Evidence and verification

The current web package tests, typecheck, root installation/resource contracts, and isolated Pi slices supply verified evidence for landed behavior. Every future slice must use proof after its last relevant change; passing focused checks never implies release readiness.

## History

- 2026-07-27: added contract-stability, provider, and deterministic proof rules.
- 2026-07-28: replaced per-adapter/per-field proof growth with integrated Pi tool
  and representative provider-operation proofs, explicit proof-size controls, and
  circuit breakers that preserve full capability without speculative machinery.
- 2026-07-31: linked `tests/AGENTS.md` as the operational proof-budget owner after Phase 5F consolidated redundant provider-control tests; the lean-proof policy and exception boundaries remain unchanged.
