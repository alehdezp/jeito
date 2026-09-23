---
title: "jeito codeweave-pi architecture and canonical documentation entrypoint"
description: "Retrieval-oriented index for architecture, installation, runtime lifecycle, validation tiers, evidence ownership, and current limits."
tags: [jeito-codeweave-pi, architecture, documentation-index, validation, runtime]
created: 2026-07-25
updated: 2026-09-21
status: active
owns: "Architecture overview, documentation routing, and cross-reference hub"
audience: agent
code: [src/tools/explore.ts, src/tools/trace.ts, src/tools/docs-search.ts, src/core/qmd-docs-search.ts]
related: [docs/harness-doctrine.md, docs/automatic-workflow.md, docs/evidence.md, docs/current-truth.md, docs/decisions/README.md]
---

# jeito codeweave-pi: agent entrypoint

Status: **Gates R2, corrective R1, R3, R4, and R5 are complete for verified development/runtime/package targets.** Apple production publication remains separate and deferred. CRG is retired from the source in the current change set, so every R5/CRG receipt is historical; no fresh-install, production-payload, or cross-machine claim follows from it, and the retirement's own suite is not yet green.

## What this extension is

jeito codeweave-pi is Pi's evidence-acquisition and safe-mutation layer for local projects. It exposes prepared intelligence through `explore`, `trace`, and `docs_search`; exact live utilities through `ls`, `grep`, and `find`; current-change evidence through `diff`; and hash/provenance-based `read`, `edit`, and `write` operations.

It is not a fixed tool router. Agents earn the task boundary by choosing the observation that retires the most consequential uncertainty. Complete current hash-certified source is immediately editable regardless of which tool displayed it or where it lives on the local filesystem; locator-only, stale, transformed, clipped, generated, or historical output is not.

## Read these docs by question

| Question | Canonical owner |
|---|---|
| What exists, how components connect, and where code/tests live | This file and `docs/evidence.md:current-evidence-map#1` |
| Which reasoning and architecture invariants must survive | `docs/harness-doctrine.md:navigation-harness-doctrine#1` |
| What happens at startup, query, edit, reconciliation, and shutdown | `docs/automatic-workflow.md:implemented-runtime-flows#1` |
| How to install, configure, repair, or migrate safely | `docs/setup.md:setup-health-repair-and-migration#1` and the `navigation-setup` skill |
| What is implemented, limited, or admissible future work | `docs/current-truth.md:current-truth-and-future-work#1` |
| How to validate quickly during development or close a release candidate | `docs/evaluation-workflow.md:agent-evaluation-workflow/release-implementation-validation-tiers#2` |
| How to evaluate live agent behavior honestly | `docs/evaluation-workflow.md:agent-evaluation-workflow/one-scenario-loop#2` |
| How to operate every tool, construct optimal queries, and audit parameter/feature coverage | `docs/tool-operating-reference.md:jeito-codeweave-pi-tool-operating-reference-and-coverage-audit#1` |
| How normal tool output should render | `docs/ui-rendering.md:tool-output-ui-rendering#1` |
| What upstream behavior was verified | `docs/upstream/` digests |
| Why settled decisions were made (rejected alternatives, trade-offs) | `docs/decisions/README.md:decision-register#1` |

## Documentation cross-reference map

```text
README.md:jeito-codeweave-pi#1  (package entry)
  ↓
docs/README.md:jeito-codeweave-pi-agent-entrypoint#1  (this hub)
  ├─→ docs/harness-doctrine.md:navigation-harness-doctrine#1  (invariants, product reasoning)
  │     └─→ docs/decisions/proof-preserving-mutation.md:proof-preserving-source-authority-and-the-salvage-edit-engine#1  (mutation rationale)
  ├─→ docs/automatic-workflow.md:implemented-runtime-flows#1  (lifecycle flows)
│     ├─→ docs/decisions/r5-crg-clean-break.md:r5-crg-clean-break-stock-plus-one-watchdaemon-patch#1  (historical CRG delivery record)
  │     └─→ docs/decisions/pi-nav-owned-backend.md:owned-pi-nav-backend-as-an-in-process-n-api-addon#1  (native bridge)
  ├─→ docs/evidence.md:current-evidence-map#1  (behavior → code map)
  │     └─→ docs/decisions/README.md:decision-register#1  (all decision records)
  ├─→ docs/current-truth.md:current-truth-and-future-work#1  (current state + limits)
  ├─→ docs/setup.md:setup-health-repair-and-migration#1  (operator procedures)
  ├─→ docs/evaluation-workflow.md:agent-evaluation-workflow#1  (validation + eval)
  ├─→ docs/tool-operating-reference.md:jeito-codeweave-pi-tool-operating-reference-and-coverage-audit#1  (tool surface)
  ├─→ docs/ui-rendering.md:tool-output-ui-rendering#1  (display contract)
  └─→ docs/management.md:documentation-ownership-and-maintenance#1  (ownership + schema)

native/pi-nav/ARCHITECTURE.md  (backend design owner — file-level)
  └─→ docs/upstream/pi-nav-native-contracts.md  (external runtime contracts)

docs/upstream/  (evidence digests — file-level neighbors)
  ├─→ crg-official-docs-digest.md  (historical CRG upstream digest)
  ├─→ graphify-official-docs-digest.md
  └─→ pi-nav-native-contracts.md
```

Every doc carries frontmatter with `owns`, `audience`, `code` (implementation owners as `path::symbol`), and `related` (section-precise read-selectors). Frontmatter gives cold readers context and a structured manifest; the reliable `explore(map)`/Graphify edges come from inline body links and `path::symbol` references, not frontmatter values. The schema and cross-reference format are defined in `docs/management.md:documentation-ownership-and-maintenance/frontmatter-schema#2`.

`management.md` governs consolidation. New redesign logs or parallel architecture documents are not created.

## Architecture at a glance

```text
user task
  -> prepared evidence
       explore(map) ---------- Graphify cross-domain graph
      explore(code) --------- indexed code identity search and topology
      trace ----------------- focused indexed/pi-nav relations
       docs_search ----------- lifecycle-owned QMD section index
                               FTS5 always; compatible zembed-1/voyage vectors
                               and zerank-2/rerank-2 only when semantic-ready
  -> exact live evidence
       ls + grep + find ------ bundled pi-nav
       read Markdown --------- pi-nav live structure/owner resolution
       diff ------------------ Git/pi-nav current changes
  -> source authority
       current-byte validation + snapshot store
  -> edit/write
       natural hashed mutation + advisory syntax/LSP checks
  -> lifecycle propagation
      indexed code maintenance, QMD incremental section reconciliation,
      lifecycle Graphify refresh, persisted health/audit
```

QMD is the only persisted documentation retrieval index. pi-nav is the only live Markdown parser and owner resolver. `docs_search` returns ranked current section leads; `read` owns outline, section, range, subtree, and editable current source. The capability routing is `docs/harness-doctrine.md:navigation-harness-doctrine/evidence-capabilities-not-routes#2`; the behavior→code map is `docs/evidence.md:current-evidence-map#1`; the lifecycle flows are `docs/automatic-workflow.md:implemented-runtime-flows#1`.

## Public evidence responsibilities

Quick reference only; [`tool-operating-reference.md`](tool-operating-reference.md) is the exhaustive tool surface (every parameter, advanced feature, and coverage audit).

| Tool | Owns | Does not prove |
|---|---|---|
| `explore(view:"map")` | Cross-domain Graphify neighborhoods | Current source bytes or runtime behavior |
| `explore(view:"code")` | Ranked code identity and prepared topology | Literal completeness or exact patch text |
| `trace` | One focused callers/callees/imports/importers/tests edge | Semantic intent or architecture inventory |
| `docs_search` | Ranked project Markdown section leads | Live section bytes, code relations, or runtime behavior |
| `read` | Live text/Markdown structure plus mutation authority | Hidden relationships or impact |
| `ls` / `grep` / `find` | Exact directory, occurrence, and path evidence | Meaning or architecture |
| `diff` | Current patch/range evidence | Intent or tested correctness |
| `edit` / `write` | Controlled mutation and exact post-mutation authority | Broad readiness |
| `lsp_validate` / `CHECK LSP` | Scoped semantic diagnostics | Runtime behavior or tests |
| `bash` / `jobs` | Focused execution and process lifecycle | Untested behavior |

Prepared collection paging preserves request/root/generation identity. Proof covers only displayed current rows. The exhaustive tool surface is `docs/tool-operating-reference.md:jeito-codeweave-pi-tool-operating-reference-and-coverage-audit/how-to-audit-tool-coverage#2`; the evidence map is `docs/evidence.md:current-evidence-map/public-prepared-tools#2`.

## Non-negotiable invariants

The full invariant set is owned by [`harness-doctrine.md`](harness-doctrine.md). The one-sentence essence: preserve native evidence faithfully, never mutate or index at query time, keep QMD the sole persisted docs index with pi-nav the sole live Markdown parser, derive edit authority from complete current source rather than tool identity, and ship every public capability with an operational bridge from uncertainty to a concrete call. The invariants are `docs/harness-doctrine.md:navigation-harness-doctrine#1`; the operational bridge is `docs/harness-doctrine.md:navigation-harness-doctrine/operational-literacy-bridges-reasoning-into-tool-calls#2`.

## Current baseline and boundaries

- Bundled pi-nav supplies exact utilities and live Markdown structure with current-byte hashes.
- The owned QMD runtime supplies local FTS5/sqlite-vec storage and bounded provider inference (`zembed-1`/`zerank-2` or `voyage-code-3`/`rerank-2`) when configured; lexical retrieval remains available without provider credentials.
- `code_context` remains internal and unregistered.
- APPEND/doctrine own durable operational strategy; public descriptions/schemas own current modes, limits, advanced mechanics, and recovery. Cross-domain unknowns trigger map, unqualified implementation ownership triggers indexed code search, exact identities with open neighborhoods trigger traversal, and one exact relation triggers trace; stronger identities reopen the owning capability. Fresh Sol/Luna behavior remains a separate evidence tier.
- Multi-file mutation is atomic per physical file, not filesystem-wide.
- Graphify never serves a known-dirty or failed generation: common delete/move/shrink cases are repaired incrementally, full staged rebuild is reserved for an unusable baseline, and other failures remain specific and fail closed while last-good stays rollback-only.
- Apple production publication remains deferred. Current verified status is `docs/current-truth.md:current-truth-and-future-work/implemented#2`; limitations are `docs/current-truth.md:current-truth-and-future-work/known-limitations#2`.
- The working tree contains an intentional large redesign; preserve unrelated changes and inspect scoped diffs before overlapping edits.
