---
title: "ADR 0 — jeito websift decision system"
description: "Master architecture decision record for the numbered jeito websift ADR hierarchy, confidence and implementation metadata, ownership, and code/document relationships."
tags: [jeito-websift, adr, decision-records, confidence, provenance]
created: 2026-07-28
updated: 2026-07-31
status: active
adr_id: ADR-000
adr_type: master
decision_status: accepted
confidence: confirmed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "ADR hierarchy, metadata contract, confidence vocabulary, and decision-change procedure"
audience: contributor
children: [docs/adr/0001-product-and-evidence/README.md, docs/adr/0002-internal-architecture/README.md, docs/adr/0003-engineering-stewardship/README.md, docs/adr/0004-operations-and-evolution/README.md, docs/adr/0005-provider-evaluation-and-guidance/README.md]
related: [docs/adr/AGENTS.md, docs/ROADMAP.md, docs/DESIGN.md, docs/WORK-PLAN.md]
---

# ADR 0 — jeito websift decision system

## Decision: group architecture decisions by evolving concern

jeito websift records consequential product and architecture choices as **architecture decision records (ADRs)**, not product requirement documents. `docs/adr/` is the only current decision-record authority.

A master ADR owns each stable concern and links to child ADRs that can evolve independently. The hierarchy prevents one flat sequence from mixing product semantics, internal architecture, engineering policy, operations, and provider experiments:

- [`ADR 1 — product and evidence`](0001-product-and-evidence/README.md) — product boundary, public verbs, and evidence semantics;
- [`ADR 2 — internal architecture`](0002-internal-architecture/README.md) — internal layering, routing, fetching, and configuration;
- [`ADR 3 — engineering stewardship`](0003-engineering-stewardship/README.md) — documentation/code edges, maintainability, and proof;
- [`ADR 4 — operations and evolution`](0004-operations-and-evolution/README.md) — setup, diagnosis, provenance, vendoring, installation, and upkeep;
- [`ADR 5 — provider evaluation and guidance`](0005-provider-evaluation-and-guidance/README.md) — provider contracts, typed multi-provider requests, provider apprenticeship, targeted selection, and research-guidance evolution.

The execution sequence remains a plan in [`docs/ROADMAP.md`](../ROADMAP.md); the integrated current picture remains in [`docs/DESIGN.md`](../DESIGN.md). ADRs own decisions and causal rationale, not implementation chronology.

The nested [`AGENTS.md`](AGENTS.md) is the operational authoring authority for future sessions. It explains what jeito websift is building, how numbered folders and micro-decisions are assigned, how metadata moves, and when an ADR change returns to the user.

## ADR frontmatter contract

Every ADR uses this queryable core:

```yaml
status: active | draft | stale
adr_id: ADR-NNN | ADR-NNN.NNN
adr_type: master | child
decision_status: proposed | accepted | superseded | rejected
confidence: idea | inferred | user-stated | evidence-backed | confirmed
evidence_grade: none | lead | mixed | verified
implementation_status: not-applicable | planned | in-progress | implemented | validated | deferred
decision_owner: alehdezp
owns: "one consequential decision boundary"
parent: docs/adr/<numbered-folder>/README.md       # child ADRs
children: [...]                          # master ADRs
code: [...]                              # exact owning symbols/files when applicable
related: [...]                           # non-obvious cross-group or non-ADR neighbors
```

`status` describes the document lifecycle. `decision_status` describes whether the decision governs current work. `confidence` records why the decision can be trusted. `evidence_grade` records the strongest evidence supporting the scoped claim. `implementation_status` records actual delivery progress. These fields are independent: an accepted user direction may remain `user-stated`, `mixed`, and `planned` until implementation and focused proof agree.

## Five confidence levels for evolving ADRs

1. **`idea`** — captured possibility; neither source-grounded nor owner-reviewed. It cannot govern implementation.
2. **`inferred`** — reasoned synthesis from partial evidence; explicitly not confirmed by the decision owner or a discriminating experiment.
3. **`user-stated`** — explicit owner direction accepted as intent, but implementation behavior or comparative quality remains unproved.
4. **`evidence-backed`** — current source or focused experiment supports the decision, but final owner acceptance, rollout, or a consequential comparison remains open.
5. **`confirmed`** — the decision owner confirmed the choice and current claim-scoped proof supports the implemented behavior or governing artifact.

Confidence moves in either direction. Provider/version drift, contradictory execution, failed agent trajectories, or a changed user objective must lower confidence before dependent guidance continues.

## Evidence grades remain separate from confidence

- **`none`** — no evidence beyond the recorded idea.
- **`lead`** — old guidance, marketing, search output, or incomplete documentation identifies a hypothesis.
- **`mixed`** — some source/runtime evidence exists, but consequential comparison or implementation proof remains open.
- **`verified`** — current source plus the proof that owns the scoped claim agree.

Comparative provider guidance cannot become active from `lead`. A `confirmed` architecture decision requires `verified` evidence for its current implementation claim; a purely normative user decision may be accepted as `user-stated` without pretending it was experimentally proved.

## Master and child dependency rule

A child ADR inherits only the parent ADR's objective and settled constraints. It does not inherit the confidence or evidence grade of a sibling. The child body must link its parent where that dependency matters and link non-obvious cross-group decisions inline.

A master ADR may summarize children, but the child remains authoritative for its separable decision. If a child changes a master premise, stop dependent implementation and update the master before adding downstream workarounds.

## ADR content contract

Every child ADR must make these sections recoverable, using equivalent query-shaped headings when the subject requires a different structure:

```text
Decision
Context and current problem
Decision owner and confidence
Alternatives considered
Decisive trade-off
Consequences and obligations
Evidence and verification
Revisit conditions
History
```

Preserve existing non-obvious detail when migrating an older record. Do not rewrite grounded history merely to fit a template.

## ADR relationships to code and non-ADR documentation

- **ADR → code:** `code:` names the exact current symbol when one symbol owns the invariant, or the file when the module is the honest boundary. Repeat the reference inline where the relationship matters.
- **Code → ADR:** add a short `ADR-NNN.NNN` comment only where a non-obvious invariant would otherwise be re-litigated or accidentally broken. Do not add comments to every file or restate obvious code.
- **ADR → ADR:** child bodies link their master and only strong sibling/cross-group dependencies. Folder proximity supplies ordinary family context.
- **ADR → current reference:** link `docs/DESIGN.md`, `docs/ROADMAP.md`, `docs/upstreams/`, skills, configuration, or tests at the claim they own. Frontmatter is a cold-reader manifest, not the graph edge.

Example implementation note:

```ts
// ADR-002.002: fallback is bounded and visible because hidden retries can bill twice.
```

Use the comment only in the function owning that invariant, such as `src/routing.ts::runWithFallback`.

## How to change an ADR

1. Read the master ADR and current child owner.
2. Compare the decision with current source, focused execution/comparison evidence, and user direction.
3. Update `updated`, `decision_status`, `confidence`, `evidence_grade`, and `implementation_status` honestly.
4. Replace the active decision when it changes; preserve materially different prior reasoning under **History**.
5. Update implementation, focused proof, current references, and active guidance only when their truth changed.
6. Stop for the user when evidence changes an accepted trade-off, public contract, live budget, migration boundary, or APPEND instruction.
7. Search removed decision-record directories, prior filenames, legacy product-requirement terminology, and duplicate `owns:` claims before finishing; no second active decision owner may remain.

## Migration history

On 2026-07-28, the user corrected the prior product-requirement framing to architecture decision records and explicitly requested numbered folder masters, nested micro-decisions, five confidence levels, implementation metadata, an ADR-specific `AGENTS.md`, and concrete code/non-ADR relationships. Existing decisions moved without changing the underlying product objective. Former flat and incorrectly named paths no longer govern current work.
