---
title: "jeito websift documentation index"
description: "Routes product, architecture, provider, research-guidance, operation, provenance, implementation, and execution questions to one current owner."
tags: [jeito-websift, documentation-index, adr, architecture, provider-evaluation, provenance]
created: 2026-07-27
updated: 2026-08-28
status: active
owns: "jeito websift documentation routing and cross-reference map"
audience: mixed
related: [README.md, docs/adr/README.md, docs/upstreams/README.md, docs/ROADMAP.md]
---

# jeito websift documentation index

## Start with the owner matching the question

jeito websift uses separate artifacts because each promises different authority:

- [`docs/adr/`](adr/README.md) records accepted, proposed, superseded, and rejected decisions with confidence, evidence, implementation state, alternatives, and revisit conditions.
- [`docs/adr/AGENTS.md`](adr/AGENTS.md) explains the numbered master/child ADR schema and gives future agents the project mental model.
- [`docs/DESIGN.md`](DESIGN.md) is the integrated current architecture in one read.
- [`docs/ROADMAP.md`](ROADMAP.md) is the implementation order and progress ledger.
- [`docs/WORK-PLAN.md`](WORK-PLAN.md) is the implementing-agent procedure with user stop gates.
- [`docs/upstreams/`](upstreams/README.md) records provider package/source/version/license contracts.
- [`CHANGELOG.md`](../CHANGELOG.md) records user-visible events.

Do not copy volatile progress into ADRs or causal decision rationale into the roadmap.

## Product and public tool questions

| Question | Current owner |
|---|---|
| What is jeito websift and how is it installed? | [`README.md`](../README.md) |
| What is the objective, scope, and completion boundary? | [`ADR 1.1`](adr/0001-product-and-evidence/0001-objective-and-scope.md) |
| Why four startup evidence tools, one lazy library-doc tool, and five provider/method specialists—and what evidence does each return? | [`ADR 1.2`](adr/0001-product-and-evidence/0002-tool-surface-and-evidence.md) for the evidence model and [`ADR 1.3`](adr/0001-product-and-evidence/0003-core-search-and-provider-specialists.md) for the current provider/method split; [`README.md`](../README.md) lists all ten registered tools |
| What is the whole current system in one read? | [`DESIGN.md`](DESIGN.md) |

## Internal architecture questions

| Question | Current owner |
|---|---|
| Why normalized orchestration over thin adapters? | [`ADR 2.1`](adr/0002-internal-architecture/0001-layered-provider-architecture.md) |
| How are providers selected and fallback bounded? | [`ADR 2.2`](adr/0002-internal-architecture/0002-routing-and-failover.md) |
| How does URL/content dispatch, extraction, and retention work? | [`ADR 2.3`](adr/0002-internal-architecture/0003-fetch-pipeline.md) |
| How do `web.yaml` and credential precedence work? | [`ADR 2.4`](adr/0002-internal-architecture/0004-config-and-credentials.md) |

## Engineering and operations questions

| Question | Current owner |
|---|---|
| How are ADRs connected to code and when does a comment belong? | [`ADR 3.1`](adr/0003-engineering-stewardship/0001-documentation-and-code-links.md) |
| What proof is required and what test work is waste? | [`ADR 3.2`](adr/0003-engineering-stewardship/0002-maintainability-and-testing.md) |
| How do setup, doctor, and maintenance surfaces divide ownership? | [`ADR 4.1`](adr/0004-operations-and-evolution/0001-setup-doctor-maintenance.md) |
| How are provider provenance, licenses, and drift reviewed? | [`ADR 4.2`](adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md) |
| How are upstream snapshots reproduced and the extension installed/rolled back? | [`ADR 4.3`](adr/0004-operations-and-evolution/0003-vendoring-evolution-install.md) |
| Where does complete runtime usage guidance for every websift tool live? | [`ADR 1.5`](adr/0001-product-and-evidence/0005-tool-local-agent-guidance.md) |

## Provider evaluation and research-guidance questions

| Question | Current owner |
|---|---|
| Which provider roles are source-grounded versus still inferred? | [`ADR 5.1`](adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md) |
| What did previous provider tools expose and what is public/internal/pending now? | [`ADR 5.2`](adr/0005-provider-evaluation-and-guidance/0002-provider-contract-baseline.md) |
| Why was one-call multi-provider search removed? | Historical [`ADR 5.3`](adr/0005-provider-evaluation-and-guidance/0003-multi-provider-search-schema.md), explicitly superseded by the one-provider tools in ADR 1.3 |
| How are contract conformance, provider apprenticeship, focused comparison, cost, and selection handled? | [`ADR 5.4`](adr/0005-provider-evaluation-and-guidance/0004-benchmark-and-selection.md) |
| How do tool schemas, `mini-research`, `$research`, APPEND, and the decision ledger evolve together? | [`ADR 5.5`](adr/0005-provider-evaluation-and-guidance/0005-guidance-lifecycle.md) |
| Which operation/parameter is next to implement? | [`ROADMAP.md`](ROADMAP.md) |
| What current source grounds one provider? | [`upstreams/README.md`](upstreams/README.md) |

## Documentation relationship map

```text
README.md ──product entry──▶ ADR 1 ──public semantics──▶ src/tools/* + src/types.ts
ADR 2 ──runtime invariants──▶ registry + routing + failures + fetch + config
ADR 3 ──stewardship──▶ AGENTS.md + tests + ADR/code comments
ADR 4 ──operations──▶ setup/doctor/maintain + upstreams + install/rollback
ADR 5 ──apprenticeship──▶ provider adapters + focused calls + research skills + cross-tool APPEND routing
ROADMAP.md ──orders work──▶ WORK-PLAN.md ──executes with owner stop gates
```

The body links above are navigation edges. Frontmatter is only a cold-reader manifest.