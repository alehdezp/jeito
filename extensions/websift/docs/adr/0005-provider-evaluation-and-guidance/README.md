---
title: "ADR 5 — Provider evaluation and research guidance"
description: "Master ADR for provider contract accounting, typed multi-provider calls, provider apprenticeship, targeted comparisons, extension-owned research skills, and evidence-backed guidance rollout."
tags: [jeito-websift, adr, providers, provider-apprenticeship, multi-provider, research-guidance]
created: 2026-07-28
updated: 2026-07-31
status: active
adr_id: ADR-005
adr_type: master
decision_status: accepted
confidence: user-stated
evidence_grade: mixed
implementation_status: in-progress
decision_owner: alehdezp
owns: "Provider evaluation program, child boundaries, and evidence-to-guidance lifecycle"
audience: contributor
parent: docs/adr/README.md
children: [docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md, docs/adr/0005-provider-evaluation-and-guidance/0002-provider-contract-baseline.md, docs/adr/0005-provider-evaluation-and-guidance/0003-multi-provider-search-schema.md, docs/adr/0005-provider-evaluation-and-guidance/0004-benchmark-and-selection.md, docs/adr/0005-provider-evaluation-and-guidance/0005-guidance-lifecycle.md]
related: [docs/ROADMAP.md, docs/upstreams/README.md, docs/adr/0001-product-and-evidence/0002-tool-surface-and-evidence.md, docs/adr/0003-engineering-stewardship/0002-maintainability-and-testing.md]
---

# ADR 5 — Provider evaluation and research guidance

## Master decision: implement complete reviewed capability, select exposure from evidence

jeito websift uses installed provider SDKs/source and previous tool contracts to account for reviewed capability. Public exposure, provider routing, and research guidance are learned through focused provider apprenticeship calls and targeted comparisons for unresolved decisions.

The program succeeds when:

1. every previous provider operation and parameter is accounted for against current installed source;
2. multiple providers and repeated same-provider searches work in one typed `web_search` call without free-form configuration;
3. practical provider recipes distinguish retrieval/evidence value, cost, latency, failure, and schema reliability without producing one universal ranking;
4. every comparative recommendation names its exercised situation, provider/version, evidence date, and confidence;
5. unselected operations remain callable internal capability, not hidden tools;
6. Pi schemas, extension-owned `mini-research`/`research`, and concise APPEND guidance agree with accepted evidence.

## Binding owner decisions recalled from the design conversation

- Anti-overengineering applies to scaffolding, abstraction, and proof that add no value; it does not narrow provider capability or product requirements.
- Installed SDKs/source define the reviewed capability baseline. Previous provider schemas and the existing research skill remain mandatory comparison inputs.
- Do not classify an operation as unused from memory or partial retained-session history; separate observed calls, authored guidance, current source, and unverified assumptions.
- One `web_search` call must support different providers and repeated same-provider queries under one actual provider-attempt budget.
- Typed schema descriptions may be long when the text materially improves when/why/how agents call the field. Token reduction is not a reason to hide consequential controls.
- Linkup's scenario role is not preselected; exercise current behavior and cost before writing guidance.
- Provider apprenticeship—current source review, behaviorally distinct real calls, practical recipes, then targeted comparison—supersedes the 12/48 benchmark-first program.
- Losing calls remain valid evidence because the objective is to identify task-specific strengths, hard failures, fallbacks, cost, and evidence quality—not manufacture a winner.
- Tool schemas own exact call construction. `mini-research` owns bounded W1/W2, `$research` owns consequential W3/W4, and APPEND owns only concise always-on evidence routing and activation boundaries.
- Research-guidance evolution ships from this extension and must preserve accepted evidence/decisions here even when resumable working state lives elsewhere.
- Stop for the user when evidence changes a public schema premise, provider role, live budget, skill cutover, APPEND wording, or another accepted trade-off.

## Child ADRs and dependencies

- [`0001-provider-capability-policy.md`](0001-provider-capability-policy.md) — provider roles, grounding discipline, and explicitly unmeasured starting policy.
- [`0002-provider-contract-baseline.md`](0002-provider-contract-baseline.md) — previous tools versus current installed operation/parameter accounting.
- [`0003-multi-provider-search-schema.md`](0003-multi-provider-search-schema.md) — typed multi-provider and repeated-provider request/result contract.
- [`0004-benchmark-and-selection.md`](0004-benchmark-and-selection.md) — provider apprenticeship, focused comparisons, practical recipes, cost gates, and promotion rules.
- [`0005-guidance-lifecycle.md`](0005-guidance-lifecycle.md) — schema, W1/W2, W3/W4, APPEND, and decision-ledger ownership.

The stable four-verb/evidence boundary comes from [`ADR-001.002`](../0001-product-and-evidence/0002-tool-surface-and-evidence.md). Lean proof limits come from [`ADR-003.002`](../0003-engineering-stewardship/0002-maintainability-and-testing.md). Current provider contracts come from [`docs/upstreams/`](../../upstreams/README.md).

## Confidence rule for provider decisions

Previous schemas and authored research guidance are mandatory hypotheses, not proof of superiority. Missing calls in retained sessions do not prove non-use. Provider marketing cannot exceed `lead`. Current contract mapping can reach `evidence-backed`; comparative routing or guidance reaches `confirmed` only after accepted scenario evidence and user confirmation.

## Delivery sequence

1. Close a coherent Git checkpoint for the landed extension and root integration contracts.
2. Audit the current global research skill as the historical W3/W4 and provider-guidance baseline; prepare extension ownership without duplicate registration.
3. Complete Tavily and implement typed Exa–Tavily plus repeated-provider requests.
4. Run the agent schema-usability experiment; stop if the request/result shape needs replanning.
5. Re-review Linkup and complete remaining provider contracts.
6. Run operation conformance and finish extension-owned W1/W2 and W3/W4 skills; stop for the global-skill cutover decision.
7. Exercise behaviorally distinct provider modes and record practical call recipes.
8. Run a small set of hard cross-provider research situations; create a targeted comparison only for unresolved decisions.
9. Select public controls, routing roles, internal-only operations, and guidance interactively from scoped evidence.
10. Update Pi schemas, both research skills, ADRs, provenance, and APPEND through their owning protocols.

The detailed executable order and user stop gates live in [`docs/WORK-PLAN.md`](../../WORK-PLAN.md). The current status lives in [`docs/ROADMAP.md`](../../ROADMAP.md); this master owns why the evaluation exists, not daily progress.

## Anti-drift stop rules

- Do not declare a provider globally best from one task, old guidance, or marketing.
- Do not expose every SDK field merely because it exists; each public distinction needs a named task or hard constraint.
- Do not remove grounded internal capability merely because one focused comparison does not select it.
- Do not build a benchmark platform or broad matrix unless repeated targeted comparisons demonstrate a reproducibility or accounting need.
- Do not publish provider-specific APPEND instructions.
- Do not load old and new `research` skill owners together.
- Stop for the user when evidence changes a public contract, accepted provider role, research-depth boundary, live budget, migration action, or APPEND wording.

## Revisit conditions

Revisit this master when the reviewed provider set changes, Pi's schema/runtime contract changes, repeated agent trajectories invalidate the four-verb or typed-route premise, targeted comparisons cannot resolve consequential defaults, or the user changes the research-depth/guidance ownership model.

## History

This family previously lived in an incorrectly named decision-record folder. On 2026-07-28 the user corrected the artifact type to ADR and requested master/child grouping, five-level confidence, and concrete code/non-ADR relationships. The provider decisions and execution objective were preserved while authority moved to `docs/adr/0005-provider-evaluation-and-guidance/`.

On 2026-07-31 `alehdezp` replaced the benchmark-first 12/48 plan with provider apprenticeship and targeted comparisons after the scaffold grew without producing practical provider guidance.