---
title: "QMD and pi-nav documentation corpus boundaries"
description: "Verified QMD section-index ownership, pi-nav Git/custom ignore behavior, nested-root limitations, candidate filtering risks, and planned per-project docs admission."
tags: [jeito-codeweave-pi, qmd, pi-nav, documentation-corpus, nested-projects]
created: 2026-07-27
updated: 2026-07-27
status: active
owns: "QMD/pi-nav-specific corpus admission facts, ignore risks, and planned nested documentation project behavior"
audience: contributor
code: [src/core/qmd-docs-search.ts::syncQmdDocs, src/core/qmd-docs-search.ts::discoverMarkdown, src/tools/docs-search.ts::registerDocsSearchTool, native/pi-nav/src/walk.rs::builder_with_policy, src/core/qmd-docs-refresh.ts::scheduleQmdDocsRefresh]
related: [docs/plan/README.md, docs/plan/adversarial-review-prompt.md, docs/plan/corpus-contract.md, docs/plan/evidence-ledger.md, docs/setup.md, docs/evidence.md]
---

# QMD and pi-nav documentation corpus boundaries

## Planning status and backend identity

QMD is codeweave-pi’s sole persisted documentation retrieval index. Pi-nav remains the live Markdown file/section parser and current-source authority. These settled boundaries remain governed by `docs/current-truth.md:current-truth-and-future-work/locked-documentation-boundaries#2`.

This plan changes project/corpus ownership, not the parser hierarchy. It must not add a second Markdown manifest, raw Markdown cache, docs watcher, summary layer, or managed external corpus service.

## Current QMD corpus construction

`src/core/qmd-docs-search.ts::syncQmdDocs` receives one docs root, index path, and repository identity. A full reconciliation:

1. calls `discoverMarkdown(root)`;
2. asks bundled pi-nav for `**/*.md` under that root with `visibility:"project"`;
3. projects each live file’s sections through pi-nav;
4. upserts current section documents and source hashes;
5. deactivates stale files/sections;
6. embeds changed documents when the configured semantic provider is ready.

The SQLite filename is derived from repository identity, so multiple databases can physically coexist. Current `.pi-navigation.json` exposes only one active docs repo/root per configuration root; preparing a different scope reuses or replaces that lane instead of creating independently selectable project-local state.

## Pi-nav project ignore behavior

For `visibility:"project"`, `native/pi-nav/src/walk.rs::builder_with_policy` finds the nearest ancestor containing `.git` and then chooses one policy:

- `<git-root>/.pi/navigation/ignore`, when present; or
- Git `.gitignore`, global Git ignore, and Git `info/exclude` through the `ignore` walker; or
- no configurable ignore source when no Git root exists.

The custom navigation ignore **replaces** Git ignore sources. It does not merge with them. Hard safety still rejects traversal outside the scan root, `.git` internals, and generated `.pi/navigation` paths.

Pi-nav’s native `project_root()` recognizes `.git`, not `.pi-navigation.json` or nested package markers. Therefore a nested navigation project inside one outer Git repository still uses the outer Git root’s custom `.pi/navigation/ignore`.

## Executed nested QMD/pi-nav fixtures

Disposable `callPiNav(pi_nav_files)` fixtures established:

1. Root and nested `.gitignore` rules apply while scanning a nested docs root.
2. Creating `<outer-git-root>/.pi/navigation/ignore` disables those Git rules and applies only the custom rules.
3. A nested project’s own `.pi/navigation/ignore` is ignored when the nested project lacks its own `.git`; the outer Git root remains the policy owner.
4. Markdown under `node_modules` is admitted when neither Git nor custom rules exclude it.
5. Markdown inside `.pi/navigation` remains safety-excluded.

Claim IDs are in `docs/plan/evidence-ledger.md:nested-navigation-evidence-ledger/qmd-and-pi-nav-ignore-and-corpus-claims#2`.

The `node_modules` result matters: pi-nav exact tools intentionally avoid hidden policy invention. QMD cannot assume exact-tool safety exclusions provide a complete prepared-docs corpus policy.

## Why `.pi/navigation/ignore` cannot own prepared docs boundaries

Automatically writing this file for QMD would change `grep`, `find`, and `ls` project visibility because the same native policy governs exact tools. It would also suppress repository Git ignore sources rather than add QMD exclusions.

Prepared documentation projects therefore need explicit QMD admission filters before section projection. Exact-tool visibility remains separately user-controlled.

The planned QMD sequence is:

```text
pi-nav Markdown discovery
-> canonical project root/exclusion admission
-> complete admission diagnostics
-> pi-nav section projection
-> QMD upsert/embed
```

Canonical exclusions must be applied on normalized root-relative paths and must delete previously indexed files that become excluded during full reconciliation.

## `docs_search` path and glob filters are not project isolation

`src/core/qmd-docs-search.ts::searchDocsWithQmd` asks QMD for a bounded candidate window of 40. `src/tools/docs-search.ts::registerDocsSearchTool` then applies exact path/glob filtering to returned candidates.

A relevant nested document can be absent before filtering because unrelated broad-corpus candidates consumed the window. Path/glob remains useful when the governing documentation family is already known, but it cannot substitute for an independently constructed docs corpus.

A future project selection must choose the QMD database/repo before retrieval. The current `path` and `glob` parameters continue to narrow within that selected project.

## Accepted project-local QMD ownership

Each project-local `.pi-navigation.json` with docs enabled owns:

- one docs corpus root and normalized exclusion digest;
- one logical QMD repo/database identity derived from project-local configuration, not a catalog ID;
- one reconciliation transaction, lock, generation, and health record;
- one persisted semantic provider choice and compatible vector generation.

The same local embedding/reranker model files may be shared; corpus databases, generations, locks, and health must not be shared accidentally.

Setup preview reports pi-nav discovery policy separately from canonical QMD exclusions, including admitted/ignored/safety-excluded counts, removals from the previous generation, semantic mode, privacy, expected vector work, and provider choice. It never writes `.pi/navigation/ignore` for prepared docs.

## Path-owned mutation and external changes

Current edit/write scheduling calls `scheduleQmdDocsRefresh` with session `cwd`. Its preparation resolves one project root and discards changed Markdown outside that configured docs root.

Nested support must group changed Markdown by owning navigation project before enqueueing. Each project retains one transaction/coalescing owner. External Markdown changes remain lifecycle reconciliation work; the design does not introduce watchers.

A root session must not reconcile every configured QMD project after every tool call. Lifecycle should use project dirtiness, bounded cadence, and explicit active-project selection. Exact scheduling policy remains open until corpus manifests and no-change cost are measured.

## Executed reconciliation and candidate-window discriminator

A disposable fixture indexed 46 high-scoring distractors plus `child/target.md` with a fake local embedding provider. Broad retrieval returned and saturated 40 candidates before filtering; the child target was absent. A separate child-local repo/database indexed one file and returned `target.md` first, proving that project selection changes retrievability rather than presentation alone.

Adding `child/` to the parent discovery policy and running a full sync changed the parent ledger from 47 to 46 files. Reconciliation reported one removed source and cleanup counts of one orphaned vector, one inactive document, and one orphaned content row. Parent and child repo identities produced two SQLite files. The fixture was deleted.

This proves backend deletion and physical coexistence. It does not implement the canonical `scope.exclude` adapter; that adapter must produce the same filtered discovery set before section projection.

## Remaining QMD implementation probes

1. Apply normalized `scope.exclude` prefixes after pi-nav discovery and prove parity with the executed discovery-exclusion result.
2. Run lexical and semantic modes after project-local routing lands to prove provider compatibility and query-time purity through the public contract.
3. Move the fixture checkout and prove portable configuration reloads without edits while local state rebinds to the canonical root.

## Remaining QMD decisions

- Project-relative database path/repo naming that remains collision-free after relocation without a new public project identifier.
- Parent/root documentation such as `README.md` when child projects are excluded.
- Bounded lifecycle scheduling for several dirty docs projects.
- Migration and preservation of existing single-repo QMD databases.

The architecture review settled the policy boundary: QMD owns direct pre-projection filtering, pi-nav remains the live parser, and `.pi/navigation/ignore` remains user-controlled exact-tool policy. The unresolved work is reconciliation and artifact identity, not another ignore grammar or project catalog.
