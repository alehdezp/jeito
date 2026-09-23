---
title: "jeito codeweave-pi contributor agent notes"
description: "Mandatory reading order, required architecture, migration authority, anti-drift principles, and verification discipline for changing the extension."
tags: [jeito-codeweave-pi, contributor-guide, architecture, anti-drift, verification]
created: 2026-07-25
updated: 2026-09-21
status: active
owns: "Contributor reading order, required architecture, and verification discipline"
audience: contributor
code: [index.ts, src/core/qmd-docs-search.ts::authorityRole, scripts/pi-nav-build.mjs]
related: [docs/README.md, docs/harness-doctrine.md, docs/evidence.md, docs/current-truth.md, docs/evaluation-workflow.md, docs/management.md]
---

# jeito codeweave-pi agent notes

Read this before changing the extension.

## Runtime prompt source

The active runtime navigation guidance is the host-owned `~/.pi/agent/APPEND_SYSTEM.md`. The extension does not ship or inject a repository-local APPEND; public schemas, tool output, this project context, and the canonical docs own the portable guidance.

## Canonical documentation

Start at `docs/README.md`. It routes every question to one canonical owner and maps the cross-references between docs, decisions, and code. `docs/management.md` owns the document-responsibility table and the frontmatter schema (`docs/management.md:documentation-ownership-and-maintenance/frontmatter-schema#2`); `docs/decisions/` preserves the reasoning behind settled decisions.

Do not resurrect removed recovery/default/tool-mastery plans. Consolidate into the current owner instead of creating new docs, logs, dated reports, or archive trees.

## Approved coherent analysis migration

The selected successor reuses the coherent CodeGraph maintenance subsystem, one SQLite/FTS graph, existing Pi lifecycle and a supervised maintenance child. Live queries remain native. The [reuse-first revision](docs/decisions/pi-nav-owned-backend.md#reuse-first-best-effort-delivery-revision--2026-09-16) supersedes the earlier mandatory whole-corpus/outer-transaction successor design; it does not change installed behavior or source/edit safety. QMD remains the document retrieval owner; Graphify retention needs demonstrated value.

The legacy R-series below does not override the selected goal (local-only work record). Follow reuse-first execution control (local-only work record): identify the working donor/owner and smallest adaptation before code or delegation; use cheap checks only when their result changes the route. Consider Rust placement across all tools when reuse or a small port lowers real runtime cost, but do not equate language with reliability or treat read/edit/write assessment as an unscoped rewrite. Scoped local progress replaces the reassessment freeze; installation/activation, existing stores, acquisition, public/infrastructure removal and protected behavior changes retain separate authority. No agent evaluation.

## Required architecture

- **Selected destination:** ranked Grep owns rich connected code/documentation understanding, mandatory semantic discovery, precise focus and continuation. Core + QMD is the baseline. CRG/code-review-graph is explicitly selected for complete removal, including optional runtime, adapters, provisioning and fallbacks; retained capabilities belong in owned code. The separate CodeGraph-derived `native/analysis` is retained. Public `explore.code`, Trace and generic explain keep their separate replacement/removal gates. Graphify/map must earn retention through the bounded value comparison. No separate Impact tool is selected.
- **Current registration, not final design:** `explore`, `trace`, and `docs_search` are still public prepared tools. Bundled pi-nav backs `ls`, `grep`, and `find`; `read` remains the TypeScript snapshot/source-authority owner. `code_context` remains internal.
- **Current changes:** `diff` retains independent Git evidence. Native temporal identity/attribution has bounded candidate proof; preserve that correction rather than repeat it. Richer consequence analysis remains unfinished, and today's graph cannot supply historical edges.
- Mutation authority: complete live rows recorded under a whole-file eight-hex hash, whether supplied by `read` or another validating capability.
- Mutation: natural `REPLACE`, `DELETE`, `INSERT`, certified block operations, `DELETE FILE`, `MOVE FILE TO`.

One CodeGraph-derived SQLite/FTS code graph and QMD's document index are the selected baseline. Existing approved active-project lifecycle owns preparation, not a new permanent daemon, broker or second hierarchy manifest. Preserve existing user stores without adoption, deletion or migration. Retired-store exclusion and explicit user opt-out checks are safety boundaries, not permission to restore the retired runtime.

- Backends/infrastructure: Core (bundled pi-nav, CodeGraph-derived maintenance and pinned local code semantics), QMD, and optional Graphify. Public edit/write never route through pi-nav.
- Structural parsing: worker-backed `web-tree-sitter` at read time; no structural parser/backend/provider call during mutation. Markdown timestamp maintenance uses the installed YAML parser locally before final source authority is returned; it does not authorize caller edits to unseen rows.
- Docs lifecycle: QMD is the only persisted retrieval index; pi-nav owns live Markdown parsing. Startup/cadence/manual reconciliation and exact edit/write/delete/move paths share one existing per-root lane transaction. No watcher, broker, second hierarchy manifest, raw cache, summaries, query-time repair, or managed corpus upload.
- Core delivery: self-contained prebuilt maintenance, grammar and code-model payload through the existing build/package owner. Setup-time Core artifact downloaders and end-user compilation are not selected. Package/source checks alone do not prove clean-machine installation.
- Optional Python delivery: `nav:provision:legacy` retains its command name but provisions Graphify only in the extension-local ignored `.runtime`. Normal Pi startup never installs, downloads or repairs dependencies.
- Graphify: lifecycle-refreshed prepared graph. Query it directly; returned generation and identity diagnostics bound only that neighborhood.
- No Semble, Codanna, generic semantic fallback, or removed compatibility aliases.
- Query-time navigation never indexes, installs, embeds repository nodes, repairs, or mutates state. No agent preflight is required: registered prepared tools report the active mode, privacy, and request-specific diagnostics in their result.

## Migration and historical decisions

- R-series decisions preserve historical reasoning; they do not authorize keeping CRG optional or restoring its adapter, daemon or provisioning.
- The user-selected complete retirement supersedes [R5](docs/decisions/r5-crg-clean-break.md). Preserve unrelated QMD/Graphify behavior, source-authority and mutation safety while removing superseded owners rather than adding compatibility paths.
- Source retirement does not authorize deleting existing stores or deployed runtime environments. Installation, downloads, activation and migration require their own authority.
- Production Apple publication remains deferred and separate.

## Anti-drift principles

- Preserve native relationships, ranks, scores, snippets, paths, provenance, hierarchy, graph starts/paths, diagnostics, and omission counts.
- Compact with local GCF-style formatting; do not claim upstream GCFormat API integration.
- Normal output hides wrapper plumbing, not semantic evidence. Setup/debug may expose backend detail.
- Prepared evidence is not demoted to a lead merely because raw text feels familiar.
- A locator is not mutation authority. Complete current hash-certified source is immediately editable when the task boundary is earned; do not force a reassurance read.
- Edit authority does not imply editing is the correct next action.
- Scores/ranks prioritize retrieval; they are not correctness confidence.
- Fix product/backend contracts rather than coaching agents to route around defects.
- Keep provider summary/embedding quality configured; do not trade quality for speed.

## Verification discipline

Start with the changed owner, not the broadest available suite. Use the routing matrix in `docs/evaluation-workflow.md:agent-evaluation-workflow/release-implementation-validation-tiers/change-surface-routing-matrix#3`: exact test first; `validate:inner` for shared local contracts; `validate:qmd` for QMD acquisition/provider/startup/indexing; `validate:qmd:linux` only when the Linux ARM64 QMD boundary changed; `validate:checkpoint` only for cross-backend or Python-runtime changes; `validate:release` once per release candidate.

Reuse `.tmp/release-validation/` pip/QMD caches and the one package archive built by the release orchestrator. An empty-cache download is required only when model URI, acquisition, validation, dependency, or target-platform behavior changed. Do not repeat checkout, standalone Git, aggregate Git, package, and container installs for one local claim; choose the affected delivery boundary and leave the combined matrix to the release gate.

Verify tool callability, registered parameter handling, returned source/contract correctness and errors directly. Agent behavior, tool choice/use, guideline adherence and task-performance evaluation are explicitly out of scope for the selected goal; this document does not authorize them. Container evidence is target-specific. Herdr/cmux is optional assistance, not a readiness requirement; never inspect or configure API keys.

Use `navigation-debug` for a foreign-repository failure. Compare the authoritative backend/artifact/source before diagnosing wrapper behavior, then classify the smallest correct change surface.
