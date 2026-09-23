---
title: "ADR 3.1 — Retrieval-first documentation and ADR/code links"
description: "Records when implementation comments are justified, how ADRs connect to code and current references, and how future agents retrieve decision rationale."
tags: [jeito-websift, adr, documentation, comments, retrieval, code-links]
created: 2026-07-28
updated: 2026-07-28
status: active
adr_id: ADR-003.001
adr_type: child
decision_status: accepted
confidence: confirmed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Comment policy, ADR/code edges, and retrieval-first documentation conventions"
audience: contributor
parent: docs/adr/0003-engineering-stewardship/README.md
related: [AGENTS.md, docs/adr/README.md, docs/adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md]
---

# ADR 3.1 — Retrieval-first documentation and ADR/code links


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-003 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: confirmed`, `evidence_grade: verified`, and `implementation_status: validated`. The metadata—not optimistic prose—governs whether dependent work may treat the decision as proved.

## Comment policy

- **Why, never what.** A comment earns its place only if it states a constraint,
  a non-obvious routing decision, a divergence from ported upstream, or "this
  breaks if Z." A comment that restates the line below it is the defect.
- **One provenance pointer per ported file**, at the top:
  `// Ported from pi-web-access@0.13.0 extract.ts — see docs/upstreams/pi-web-access.md`.
  That single line is the code→doc edge.
- **State the biggest divergence inline.** In `src/fetch-handlers/http.ts`:
  `// Replaces pi-web-access fetchRemoteUrl with plain fetch; URL validation intentionally omitted (project policy).`
- **`ponytail:` marker for a deliberate simplification + its ceiling:**
  `// ponytail: in-memory store; move to disk if cross-restart retention matters`.
- **Owned logic names its governing ADR** in a top-of-file note.
- **Not needed:** thin adapter HTTP calls, obvious error handling, self-evident
  code. Most adapters get ~zero comments beyond the provenance pointer. Reasoning
  lives in ADRs/docs; comments only point to it.

## Docs are written for retrieval, not scrolling

A future agent finds these docs through `docs_search` (ranks sections by heading
and body) and `explore(map)` (follows cross-references). So:

- **Structure precondition:** balanced code fences and well-formed headings. An
  unclosed fence silently drops every heading below it from `docs_search`,
  read-selectors, and the graph — with no error. Self-check that fences balance.
- **Query-shaped headings** that work as search queries ("How credentials
  resolve from env or config", not "Config").
- **One thought per section; each section standalone.** `docs_search` returns a
  single section without its neighbors; it must still make sense.
- **Explicit referents:** "Tavily `extract`" not "the fallback mentioned earlier."
- **Honest ADR frontmatter:** follow [`docs/adr/AGENTS.md`](../AGENTS.md) for `adr_id`, parent/children, decision lifecycle, five confidence levels, evidence grade, implementation status, ownership, code, and strong non-obvious relationships. Metadata is a queryable claim, not decoration.

## The ADR↔doc↔code edges (what navigation follows)

Frontmatter is a manifest; the **inline body references are the real edges.**

- **ADR → code:** `code:` frontmatter lists owning symbols such as `src/routing.ts::selectProviders`, repeated inline where the relationship matters.
- **code → ADR:** top-of-file comment names the governing ADR; ported files add
  the provenance pointer to `upstreams/`.
- **ADR → doc:** inline links to `upstreams/<source>.md` (at the relevant section
  when one section owns it) and to sibling ADRs.
- **Index → everything:** [`docs/README.md`](../../README.md) routes each question to its owner; [`ADR 0`](../README.md) is the numbered decision catalog.

Verification: before committing a doc, every selector and `path::symbol` ref
resolves. A dead reference is a broken graph edge.

## Anti-sprawl

- Author and index only what this package owns. `node_modules/`, vendored
  upstream copies, and dependency trees are never edited, frontmattered, or
  indexed (per jeito AGENTS.md).
- Update an existing doc over creating a new one; a new file only for a distinct
  owner or retrieval frontier.
- Temporal artifacts go in `.tmp/`, never the package root or `docs/`.

## Update discipline

A decision change updates the owning ADR (`updated`, active decision, confidence, evidence grade, implementation status, revisit conditions, and History) plus any current reference or code whose truth changed. A behavior change also updates the owning proof. [`websift-maintain`](../../../skills/websift-maintain/SKILL.md) enforces “no behavior change without an ADR/provenance/proof update.”

## Alternatives and decisive trade-off

Comments everywhere duplicate code and drift; documentation without code links becomes a beautiful orphan; a flat decision dump becomes hard to retrieve. Numbered ADR masters, exact body links, and sparse why-comments preserve rationale without making implementation unreadable.

## Evidence and verification

Current ADR metadata/link checks, `docs_search` section retrieval, and exact code comments validate the mechanism for this repository. A future retrieval miss or repeated stale link is the signal to revise the convention.

## History

- 2026-07-27: conventions adopted, matching jeito docs schema and the
  prepared-navigation retrieval contract.
