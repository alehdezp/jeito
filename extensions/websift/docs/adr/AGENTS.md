---
title: "jeito websift ADR authoring and stewardship instructions"
description: "Project mental model, numbered master/child ADR hierarchy, metadata semantics, confidence transitions, code/document linking, and verification rules for every decision under docs/adr/."
tags: [jeito-websift, adr, contributor-guide, confidence, decision-management, retrieval]
created: 2026-07-28
updated: 2026-07-31
status: active
owns: "Authoring and maintenance rules for the jeito websift ADR hierarchy"
audience: contributor
related: [docs/adr/README.md, docs/ROADMAP.md, docs/DESIGN.md, docs/WORK-PLAN.md]
---

# jeito websift ADR authoring and stewardship

## What jeito websift is building

jeito websift is the first-party Pi extension at `extensions/websift/`. The currently loaded package still exposes four historical evidence verbs, but ADR-001.003 now governs GCF model-visible structured output, tolerant near-valid calls, the common-search/provider-specialist frontier, existing fetch/lookup evidence boundaries, and an unresolved answer interface pending substantial provider-schema evidence.

- `web_search` owns ordinary Serper/Tavily URL-lead discovery;
- provider specialists own advanced vendor semantics only after current-contract review, focused exercise, and guidance acceptance;
- `web_fetch` retrieves known-source content and retained responses;
- `web_lookup` resolves versioned documentation and catalog records;
- `mini-research` and `research` own verification and multi-step research method; provider-native answer tools are admitted only when they add value over explicit search → fetch → Pi synthesis.

The extension retains grounded capability for Serper, Exa, Tavily, Linkup, X/xAI search, Context7, SkillsMP, Pi package discovery, and native/specialized fetching. Public exposure is selective: common semantics stay small, materially different semantics use provider specialists, and unselected operations remain callable internal capability rather than hidden tools. The currently loaded four-tool contract remains implementation reality until the ADR-001.003 migration is proven and cut over.

Search, answer, summary, and catalog output does not become source evidence merely because it looks plausible. `src/types.ts::Source` owns the lead/catalog/fetched distinction. `src/routing.ts::runWithFallback` owns bounded visible fallback and actual provider attempts. The extension is also evolving two shipped research skills: `mini-research` for bounded W1/W2 work and `research` for consequential W3/W4 investigation, both consuming one shared reference corpus.

The current implementation order and user decision gates live in [`docs/WORK-PLAN.md`](../WORK-PLAN.md). Current progress lives in [`docs/ROADMAP.md`](../ROADMAP.md). The integrated runtime picture lives in [`docs/DESIGN.md`](../DESIGN.md). ADRs own decisions and causal rationale—not status chronology, provider source facts, or raw exercise output.

## Numbered ADR hierarchy

`docs/adr/README.md` is **ADR 0**, the decision-system authority. Every first-level numbered folder is one master ADR. Its `README.md` explains why the area exists, which constraints every child inherits, and when the master must be reconsidered. Numbered files inside the folder are micro-decisions.

```text
docs/adr/
├── README.md                                   ADR 0 — decision system
├── AGENTS.md                                   authoring/stewardship instructions
├── 0001-product-and-evidence/                  ADR 1
│   ├── README.md                               master decision
│   ├── 0001-objective-and-scope.md             ADR 1.1
│   └── 0002-tool-surface-and-evidence.md       ADR 1.2
├── 0002-internal-architecture/                 ADR 2
├── 0003-engineering-stewardship/               ADR 3
├── 0004-operations-and-evolution/              ADR 4
└── 0005-provider-evaluation-and-guidance/      ADR 5
```

Assign the next unused top-level number only for a genuinely new decision frontier with its own lifecycle and children. Add a child to an existing folder when it inherits that master objective and differs only by a separable trade-off. Do not create a new master merely because a document is long.

Stable IDs use:

```text
ADR-000       decision system
ADR-001       master ADR 1
ADR-001.001   child ADR 1.1
ADR-005.004   child ADR 5.4
```

Never reuse an ID after supersession. A path may become more descriptive, but the ID remains the decision identity.

## Required ADR metadata

Every master and child ADR carries:

```yaml
status: active | draft | stale
adr_id: ADR-NNN | ADR-NNN.NNN
adr_type: master | child
decision_status: proposed | accepted | superseded | rejected
confidence: idea | inferred | user-stated | evidence-backed | confirmed
evidence_grade: none | lead | mixed | verified
implementation_status: not-applicable | planned | in-progress | implemented | validated | deferred
decision_owner: alehdezp
owns: "one explicit decision boundary"
audience: mixed | contributor
parent: docs/adr/<numbered-folder>/README.md   # children only
children: [...]                               # masters only
code: [...]                                   # when implementation owns the claim
related: [...]                                # strong non-obvious neighbors
```

Metadata fields answer different questions. Never collapse them:

- `status` — is the document maintained?
- `decision_status` — does the decision govern current work?
- `confidence` — why may a future agent rely on the choice?
- `evidence_grade` — what evidence supports the exact scoped claim?
- `implementation_status` — how far has the accepted behavior progressed?

An accepted ADR can be `user-stated`, `mixed`, and `planned`: the owner approved the direction, but implementation and experiment proof remain open. An implemented ADR is not automatically validated. A benchmark result is not owner confirmation. A normative user preference can be accepted without pretending it was experimentally proved.

## Metadata combinations for common decision states

| Situation | `decision_status` | `confidence` | `evidence_grade` | `implementation_status` |
|---|---|---|---|---|
| Unreviewed possibility | `proposed` | `idea` | `none` | `planned` |
| Agent inference needing owner review | `proposed` | `inferred` | `lead` or `mixed` | `planned` |
| User suggested a direction but has not accepted it as governing | `proposed` | `user-stated` | strongest honest grade | `planned` |
| User approved an experiment or future plan | `accepted` | `user-stated` | `mixed` | `planned` or `in-progress` |
| Source/focused execution supports behavior but owner acceptance or rollout is open | `accepted` | `evidence-backed` | `verified` for the scoped claim | `implemented` |
| User confirmed and owning proof passed | `accepted` | `confirmed` | `verified` | `validated` |
| Accepted work intentionally postponed | `accepted` | confidence already earned | current honest grade | `deferred` |
| Replaced active decision | `superseded` | confidence at replacement time | preserved grade | final historical state |

Do not encode “needs investigation” by lowering every field indiscriminately. Use `decision_status: proposed` when the choice does not govern yet, `confidence` for authority, `evidence_grade` for support, and `implementation_status` for delivery. Name the deciding experiment or user gate in the ADR body.


## Five confidence levels

### `idea`

A possibility recorded for later consideration. No source grounding or owner review. An idea cannot govern implementation or active guidance.

### `inferred`

A reasoned interpretation from partial source, behavior, or conversation evidence. Mark what is inferred in the body and name the observation that could confirm or refute it. Do not present an inferred provider advantage as current guidance.

### `user-stated`

The user explicitly directed or accepted the decision, but current implementation, agent usability, comparative quality, or rollout proof remains open. This is the normal confidence for approved future work.

### `evidence-backed`

Current source or focused execution supports the decision, but final user acceptance, a consequential comparative experiment, or rollout remains open. State the exact proof and its limit.

### `confirmed`

The user confirmed the trade-off and current claim-scoped proof supports the implemented behavior or governing artifact. Lower confidence immediately when source drift, failed trajectories, contradictory benchmark evidence, or a changed user objective invalidates that basis.

## Evidence grades

- `none` — no support beyond the idea.
- `lead` — old guidance, marketing, search output, catalog metadata, or incomplete documentation supplies a hypothesis only.
- `mixed` — some current source/runtime evidence exists, but a consequential comparison, implementation proof, or source gap remains.
- `verified` — current source and the proof owning the scoped claim agree after the last relevant change.

Provider comparative guidance requires accepted scenario evidence. Search or provider answer output never upgrades a claim by itself; fetch and verify the underlying primary source.

## Implementation status

- `not-applicable` — governance-only decision with no implementation target.
- `planned` — accepted or proposed work has not started.
- `in-progress` — some owning behavior exists, but acceptance remains open.
- `implemented` — intended behavior exists, but claim-scoped validation or rollout is incomplete.
- `validated` — current implementation passed the proof owning the ADR's acceptance claim.
- `deferred` — deliberately postponed with a named revisit condition; not silently abandoned.

Update implementation status from actual behavior, not test count or optimistic percentage.

## Master and child dependency rules

A child inherits only the master ADR's explicit objective and accepted constraints. A sibling does not inherit another sibling's confidence, evidence, or implementation state.

Every master must:

1. state the overall decision and why the folder exists;
2. list and link every child ADR;
3. explain cross-group dependencies that can change the whole area;
4. state master-level revisit conditions.

Every child must:

1. link its parent where the inherited constraint matters;
2. own one separable decision;
3. distinguish verified facts, user direction, inference, and unresolved questions;
4. record alternatives and the decisive trade-off;
5. name consequences and implementation obligations;
6. link current code, tests, configuration, provider provenance, and non-ADR owners;
7. state what evidence or event reopens the decision;
8. preserve materially superseded reasoning under `## History`.

If child evidence invalidates a master premise, stop dependent work and update or return the master decision to the user. Do not patch every child around a failed master assumption.

## ADR body structure

Use these sections when they fit; preserve more specific query-shaped headings when an existing ADR already carries valuable detail:

```text
# ADR N.N — descriptive decision
## Decision
## Context and current problem
## Decision owner and confidence
## Alternatives considered
## Decisive trade-off
## Consequences and obligations
## Evidence and verification
## Revisit conditions
## History
```

A retrieved section must name its subject without relying on “this,” “it,” or neighboring prose. Put the current decision first; keep chronology in History.

## Strong relationships and concrete references

Use folder placement for ordinary family membership. Use `related:` only for strong non-obvious neighbors across ADR families or outside ADRs. `parent:` and `children:` describe hierarchy but do not replace body links.

At the point where a relationship matters, link exact owners:

- `src/routing.ts::runWithFallback` for bounded fallback;
- `src/types.ts::Source` for evidence state;
- `docs/upstreams/exa.md` for the reviewed Exa contract;
- `docs/ROADMAP.md:delivery-increments#2` for execution order;
- `docs/WORK-PLAN.md:3-stop-and-return-protocol#2` for user decision gates;
- `skills/research/references/web-tools-playbook.md` for active provider research guidance after that skill lands.

Use standard Markdown links for navigation and exact inline `path::symbol` references for code graph edges. Frontmatter is a manifest, not the edge.

## Code comments referencing ADRs

Do not add an ADR comment to every file. Add one only where the implementation contains a non-obvious constraint that a maintainer could reasonably “simplify” into a regression.

Format:

```ts
// ADR-002.002: fallback stays bounded and visible because hidden retries can bill twice.
```

The comment must name why the decision matters and point to the exact ADR path when the ID alone is insufficient. Obvious adapter calls and self-explanatory transformations need no ADR comment.

## What belongs outside ADRs

- **Current integrated design:** `docs/DESIGN.md`.
- **Execution order and status:** `docs/ROADMAP.md`.
- **Implementing-agent procedure and stop gates:** `docs/WORK-PLAN.md`.
- **Provider source/version/license facts:** `docs/upstreams/`.
- **Contributor invariants:** `extensions/websift/AGENTS.md`.
- **Setup and research procedures:** extension-owned skills.
- **Temporal raw apprenticeship/comparison output:** `.tmp/`.
- **User-visible event history:** `CHANGELOG.md`.

Link these owners; do not copy volatile content into ADRs.

## Changing or adding an ADR

1. Search `docs/adr/` by the behavior, trade-off, symbol, provider, and likely user query.
2. Read the owning master and current child before drafting.
3. Verify current source, execution, user direction, and evidence separately.
4. Update an existing child when it can own the decision; create a child only for a separable trade-off.
5. Create a numbered master folder only for a new decision frontier.
6. Assign metadata from evidence, never optimism.
7. Update code/current docs/provenance/tests only when their truth changed.
8. Preserve superseded rationale in History and mark supersession links.
9. Search for the old path/name and duplicate current claims.
10. Verify retrieval, section structure, links, metadata, and current source consistency.

Stop for the user when a change affects the four public verbs, provider exposure, accepted apprenticeship/comparison interpretation, live cost, research-depth boundary, skill ownership cutover, APPEND wording, destructive migration, or a master ADR premise.

## Current high-priority decision program

[`ADR 5`](0005-provider-evaluation-and-guidance/README.md) is the active product-evolution program. It preserves complete reviewed provider capability, validates typed multi-provider calls, runs operation conformance, ships aligned W1/W2 and W3/W4 research skills, learns behaviorally distinct provider calls through apprenticeship, and uses targeted comparisons only for unresolved public/schema/guidance decisions under explicit live-cost authorization.

Do not treat provider-apprenticeship plans as comparative proof. ADR 5 children remain `user-stated`, `inferred`, or `evidence-backed` until their owning focused execution and user gate close.

## ADR retrieval and consistency checks

Before reporting an ADR change complete:

1. Confirm code fences balance and intended headings appear in the Markdown section tree.
2. Run `docs_search` with the decision's likely behavior, trade-off, provider, and ADR ID.
3. Read returned sections without neighbors and verify standalone meaning.
4. Validate parent, child, related, code, test, and non-ADR references.
5. Search legacy product-requirement terminology, removed paths, old filenames, stale ADR paths, and duplicate `owns:` claims.
6. Compare consequential current claims with source/configuration/execution evidence.
7. Run `git diff --check` over changed documentation.

No active file or instruction may describe these records as product requirements. Migration history may explain that the former artifact type was corrected, but old paths must not remain resolvable authorities.