---
title: "Implemented jeito-codeweave-pi installation and runtime flows"
description: "Source-backed installation and runtime flows, including query purity, session-scoped Markdown frontmatter, mutation, recovery, and shutdown."
tags: [jeito-codeweave-pi, lifecycle, postinstall, qmd-local-models, frontmatter, runtime-provisioning, query-purity]
created: 2026-07-25
updated: 2026-09-21
status: active
owns: "End-to-end lifecycle: installation, startup, query, mutation, reconciliation, shutdown"
audience: contributor
code: [index.ts, src/core/navigation-setup-planner.ts, src/core/qmd-docs-refresh.ts, src/core/markdown-frontmatter.ts, src/core/source-selector.ts, src/core/frontmatter-relationships.ts, src/tools/docs-search.ts, src/core/read-renderer.ts, src/core/patch-apply.ts]
related: [docs/setup.md, docs/evidence.md, docs/decisions/r5-crg-clean-break.md, docs/decisions/pi-nav-owned-backend.md]
---

# Implemented runtime flows

This document owns the current source lifecycle. Ordinary registration now selects indexed Core code maintenance on eligible, unowned projects; retired CRG bindings and stores are never adopted, migrated or deleted, and independent Core can coexist with them. QMD and Graphify remain independent lanes. This source integration is not installed-runtime activation or clean-install acceptance. Setup and destructive repair remain in `docs/setup.md`; backend health expectations are in `docs/evidence.md`.

## Indexed lifecycle — ordinary startup

The default `index.ts` extension registers `registerCandidateAnalysisLifecycle` before its other lifecycle handlers, so the indexed owner reserves the process-local code writer first. The exported hook also supports isolated development proofs; ordinary registration needs no injected project, native caller or maintainer. Retired CRG bindings and stores are not consulted for ownership and cannot acquire a code writer through later mutation. No project database/model configuration or public tool is added.

The hook reuses `resolvePreparationRoot`, `planNavigationScope`, the code corpus census and `native-maintenance.ts::createAnalysisLifecycle`. It requires aggressive mode with automatic startup explicitly enabled and honors host, prompt, project/backend and scope prohibitions. Initial denial or missing packaged maintenance assets leaves ownership unchanged; loaded-source staleness also refuses preparation. Once selected, indexed ownership remains latched after revocation. `native-maintenance.ts::assertPackagedMaintenanceAvailable` checks required packaged artifacts without loading code or requiring semantic models; the worker still validates compatibility. `analysis-project.mjs::ensureAnalysisProjectParent` allocates only missing private machine parents; it never repairs existing permissions or adopts a store. The supervised child owns the graph and writer lock. Busy/building/failed state remains unavailable; no automatic recovery is selected.

`index.ts::registerCandidateAnalysisLifecycle` forwards the validated census directories to the existing lifecycle before maintenance. Shallow watches subscribe only to those directories, close retired subscriptions and request a coalesced full reconciliation on external edits; no donor watcher or second scheduler is started. Events during maintenance queue a follow-up pass. `automaticPreparationAllowed` rechecks current permission on watcher activity so external revocation closes subscriptions before more maintenance; shutdown aborts and awaits work. Watches are hints, not current-content or privacy proof: turn checkpoints still reconcile and query-time guards remain independent. Writes inside an existing unwatched `.pi`/excluded subtree do not create work, though creating/removing the directory entry can trigger its admitted parent's shallow watch.

An offline Darwin ARM64/Node24 fixture drove the **default extension**, emitted startup/mutation/shutdown events, and exercised twelve registered queries with real matching native and maintenance assets. A Git project with no `.pi-navigation.json` prepared automatically; Explore and Trace delivered certified source, callers retained distinct same-line/nested/value-reference evidence, tests included direct and one-hop-indirect candidates but excluded unrelated imports, and Diff kept exact changes separate from file-level planning. Stale source refused, refresh produced a new run, queries preserved database/status bytes, and user revocation stopped maintenance. The existing semantic/document pressure fixture was also rerun through default registration, preserving condition/consequence/prose and privacy controls. Its documents were explicitly prepared lexically with automatic docs preparation disabled. Both emitters are fixtures, not real Pi sessions. Cached assets were staged through existing builders; no install, acquisition or activation occurred. See the [producer/reader contract](../native/analysis/README.md#complete-indexed-semantics-before-publishing-readiness) for limits.

### Ordinary startup preserves ownership and consent

Code-owner selection is not preparation consent. Initial refusal leaves a root unselected; after selection, revocation keeps the reservation so a queued refresh cannot resume prepared work. No branch retains Python readiness checks or legacy configuration seeding: indexed Core checks its packaged maintenance assets instead, QMD selection is independent of Python/code asset readiness and does not seed host configuration, and Graphify remains an independent graph lane with its existing policy-gated shutdown refresh.

The indexed hook currently requires `automation.mode: aggressive` and `autoPrepareOnSessionStart: true`, then honors host/read-only and prompt suppression, explicit project/backend disables, and root/scope admission. `detect-only`, `quick-local`, guided and disabled settings do not grant that permission. Although `auto-local` exists in the configuration type, that alone does not establish full-indexing consent. Generic `architecture.enabled/autoPrepare: false` and `backends.crg.enabled: false` settings remain explicit prohibitions, not disposable predecessor configuration; retired CRG stores are neither ownership evidence nor grounds to refuse it.

Focused tests exercise the complete ordinary handler chain: host/prompt prohibitions stay latched across later events, guided mode and missing assets do not launch code maintenance, and retired CRG bindings/configuration remain unchanged and are never adopted. Only explicit input/prompt fields can revoke consent; returned tool text cannot. A separate launch-only QMD test verifies backend selection without executing preparation or model work. The ordinary-entrypoint proof above does not certify package provisioning, installation, real-Pi activation or all repository/language behavior.

Automatic QMD maintenance does not grant model acquisition: `qmd-docs-search.ts::qmdInference` requires an explicit manual-maintenance allowance, and read-only queries override it. `navigation-freshen.mjs::freshenDocsUnlocked` grants it only for manual entry, `manual_prepare` or `manual_freshen`, preserving the documented interrupted-download recovery; startup, broad-request, stop/cadence and mutation work use installed assets. `qmd-docs-refresh.ts::refresh` passes the owning project root separately from the docs subfolder so exact mutation paths cannot bypass parent exclusions. Model provisioning remains owned by `scripts/qmd-model-provision.mjs`, not a new startup installer.

## 1. Package installation and folder startup

```text
cloned-suite `npm run install:codeweave-pi`
  -> verify Pi/Node/platform prerequisites
  -> run frozen production npm install inside extensions/codeweave-pi with workspaces disabled
       install owned QMD dependencies and node-llama-cpp locally; no root/sibling install or global QMD command
  -> postinstall verifies the shipped Core maintenance/code-semantic payload; no Python is installed
       download/validate the required QMD embedding and reranker GGUF files
       run one embedding and reranking inference smoke with downloads disabled
       the optional Graphify runtime stays a separate stopped-Pi step: `npm run nav:provision:legacy`
  -> verify packaged pi-nav artifacts
  -> register the absolute extension checkout with `pi install` only after every check passes

Pi Git package installation runs the same npm/postinstall runtime lifecycle in Pi's managed clone.

Pi loads extension
  -> registers public tools, informational /navigation-setup, and lifecycle hooks
  -> indexed lifecycle checks consent, root/scope, ownership and packaged assets
       eligible unowned root -> supervised CodeGraph maintenance in private machine storage
       denial/missing assets -> no code writer, installer or repair; prepared queries keep live source
  -> policy-approved detached QMD preparation uses existing docs assets independently
       trigger/root locks prevent overlapping prepared-backend work
       provider policy reuses persisted local/ZeroEntropy/Voyage/lexical choice
       pi-nav projects admitted current Markdown sections into QMD
  -> Graphify keeps its separate query/lifecycle contract, and retired CRG stores are never adopted, migrated or deleted

No startup or query/tool execution invokes npm, pip, Python dependency installation, repair, or global backend command resolution.
```

Owners:

- checkout bootstrap: `scripts/install-from-checkout.mjs`; optional Graphify Python runtime: `scripts/navigation-provision.mjs` (stopped-Pi `npm run nav:provision:legacy`); cached-only QMD probe: `scripts/qmd-local-runtime-smoke.mjs`;
- extension-relative readiness: `src/core/owned-runtime.ts`;
- root/setup gating and hooks: `index.ts` (`detectProjectRoot`, lifecycle locks, `startBackgroundPrepare`, extension registration);
- setup policy: `src/core/navigation-setup-planner.ts`, `src/core/navigation-automation-config.ts`;
- prepare/freshen execution: `scripts/navigation-prepare.mjs`, `scripts/navigation-freshen.mjs`;
- lane readiness: `src/core/navigation-config.ts`.

Failure boundaries:

- an optional Graphify `pip` or verification failure leaves `.runtime/.ready` absent and exits that command non-zero; a Core verification failure prevents registration;
- ambiguous or unsafe project scope fails guided/blocked rather than broad-indexing;
- a startup lock proves project preparation ownership, not backend readiness;
- query tools fail closed only when their required artifact is absent, unreadable, unsafe, or unqueryable;
- startup never waits for installation or provider-heavy full-stack work. The retired CRG installation baseline is historical: `docs/decisions/r5-crg-clean-break.md:r5-crg-clean-break-stock-plus-one-watchdaemon-patch/decision#2`.

## 2. Navigation query

```text
tool call
  -> public schema validation rejects obsolete/unsupported fields
  -> resolveNavigationScope / resolveRequiredLane
  -> call the owned backend or exact utility
  -> preserve native relationships/ranks/scores/diagnostics and additive intelligence; docs_search uses the lifecycle-prepared QMD section index
  -> for prepared collections, apply tool-owned stable page windows with request/root/generation identity
  -> select visible-page source candidates and run the shared current-byte authority coordinator
  -> compact with local GCF-style rendering; repeat summaries are omitted explicitly on continuation pages
  -> return evidence + artifacts/diagnostics/omissions/next_page
  -> never start indexing/setup/model acquisition/repository-node provider work; docs_search uses FTS5 in every ready lane, attempts bounded query embedding/reranking only for a lifecycle-verified local, ZeroEntropy, Voyage, or explicit OpenRouter semantic lane, and falls back read-only to FTS5 if inference fails. Local query inference opens only cached GGUF files with downloads and native builds disabled
```
The capability routing behind this query flow is `docs/harness-doctrine.md:navigation-harness-doctrine/evidence-capabilities-not-routes#2`; the tool surface is inventoried in `docs/tool-operating-reference.md:jeito-codeweave-pi-tool-operating-reference-and-coverage-audit#1`.

Owners:

- public tools: `src/tools/{explore,trace,docs-search,ls,grep,find,diff}.ts`; internal synthesis owner: `src/tools/context.ts`;
- common shaping/paging: `src/core/navigation-clean.ts`, `src/core/prepared-page.ts`, `src/core/gcformat.ts`;
- lane resolution/health: `src/core/navigation-config.ts`;
- UI summaries: `src/core/tui-render.ts` (page/editable counts are presentation only).

Backend boundaries:

- `explore(map)` resolves the first exact current path or `file::symbol` through native Graphify `explain`, queries from that node ID, verifies the requested identity against actual Start/NODE rows, and returns warning when it was not retained; map and `trace(path|explain)` inherit graph freshness diagnostics;
- indexed `explore(code)`, `trace(callers|callees|tests)` and Diff planning reuse `pi-nav-native.ts::callIndexedGraphNavigation` and the existing fenced native projection. Numbered pages carry generation labels, not a cross-call server pin; restart when the generation changes. Source hashes certify displayed bytes, never graph bindings. Trace tests follows incoming calls/function references up to one indirect hop, then reports path-classified test-file candidates—not coverage. Diff planning is file-scoped and explicitly omits unsupported risk, coverage and flow verdicts. [The reader contract](../native/analysis/README.md#project-indexed-evidence-for-retained-consumers) owns limits and admission details;
- `explore(code)` executes one explicit `search` or `traverse` identity contract. Mixed search results prioritize non-test implementation candidates while reporting the excluded-test count and `kind:"Test"` opt-in; test-only results remain visible as subsystem evidence. Traversal pages only `traversal` and `edges`, with edges touching the exact start ordered first before depth/order peers. `trace(tests)` pages direct/supplemental candidate origins to the requested limit, and source certification canonicalizes relative/absolute prepared hash aliases. Additive sidecars cannot manufacture continuation or authority. `code_context` composes only purpose-valid internal inputs, and prepared-code trace enforces file-versus-symbol identities against the ready indexed graph;
- `docs_search` queries the local QMD section index. Exact plus bounded relaxed FTS5 queries are available after lexical preparation. A semantically ready lane combines exact FTS5 with compatible vectors from local QMD models, ZeroEntropy `zembed-1`, Voyage `voyage-code-3`, or explicit OpenRouter `nvidia/nemotron-3-embed-1b:free`, then reranks the bounded set with the selected local reranker, `zerank-2`, `rerank-2`, or `nvidia/llama-nemotron-rerank-vl-1b-v2:free`. Retrieval signals classify each candidate as answer-bearing or a weak ranked lead; weak leads remain visible under warning status and never claim an answer. Inference failure falls back to read-only relaxed lexical retrieval. Current-authority priors are disabled for explicit plan/history queries. Returned selectors are checked against current pi-nav structure/source hashes; ranking/provenance, provider/model identity, answerability, generation, latency, privacy, filters, paging, saturation, and currentness omissions remain visible. The corpus is never uploaded to managed zsearch; `read` owns all live Markdown content and hierarchy presentation.
- ls/grep/find and supported pi-nav trace routes query the live tree in process. The maintained selected-analysis candidate obtains live ranked output before admission and reuses an eligible private collection for enrichment; otherwise the existing fresh enriched search remains available. Failed resume preserves the baseline without recollection. The [native ranked collection contract](../native/pi-nav/ARCHITECTURE.md#ranked-collection-survives-optional-enrichment) owns source checks and limits; this is not installed activation or public ranked continuation.
- diff combines exact Git/pi-nav change evidence with constrained review synthesis.

## 3. Unified source authority

```text
native/prepared result identifies complete displayed rows or an exact bounded range
  -> pi-nav returns operation-local sourceSnapshots, or the coordinator calls hidden pi_nav_source_proof
  -> source-authority.ts validates canonical confinement, raw digest, BOM/line endings, and exact rows/ranges
  -> TypeScript normalizes the proven text and records only visible_complete + verbatim lines
  -> SnapshotStore mints the current whole-file edit identity and seen-line authority
  -> the tool preserves native text as the byte-identical prefix and appends compact [path#HASH] proof
```

Owners: `native/pi-nav/src/source_proof.rs`, `native/pi-nav/src/napi.rs`, `src/core/source-authority.ts`, `src/core/live-source-evidence.ts`, and `src/core/snapshot-store.ts`.

Typed pi-nav read/search outputs carry hidden operation-local snapshots. Exact visible prepared-code rows and live Markdown reads use the same coordinator. Snapshot text never enters model content, structured metadata, or persisted native details. Explicit local paths may cross the session root; complete current rows from those paths use the same source-authority contract. Hidden, clipped, transformed, inferred, stale, mismatched, broad, or over-budget claims remain locators. Page-selected exact proof is bounded to 5 canonical files, 12 ranges, 400 lines, and 96 KiB. The governing doctrine is `docs/harness-doctrine.md:navigation-harness-doctrine/source-and-mutation-authority#2`; the rationale is `docs/decisions/proof-preserving-mutation.md:proof-preserving-source-authority-and-the-salvage-edit-engine/part-a-unified-source-authority#2`; the evidence map is `docs/evidence.md:current-evidence-map/exact-live-utilities-and-source-authority#2`.

## 4. Read → edit → continuation

```text
read selector
  -> source-selector separates the exact file from `:`/`::` code-symbol, Markdown-section, line-range, and mixed chunks
  -> exact file bytes are normalized; pi-nav resolves exact code symbols and returns a source hash checked against those bytes
  -> missing, ambiguous, stale, unsupported, over-budget, or escaping selectors fail closed before authority is minted
  -> on a Markdown file's first session exposure, numbered frontmatter rows attach within the metadata budget; visible `code`/`related` values run through the same selector resolver without reading targets into context
  -> structural summary or exact numbered rows are rendered
  -> structural-block-resolver certifies displayed complete constructs
  -> SnapshotStore records digest, eight-hex hash, seen lines, blocks

edit input
  -> patch-parser isolates trusted [path#HASH] sections and parses natural operations, RETRY, and CHECK LSP
  -> if full text was evicted, restore compact full-digest row/block authority; the public wrapper can also recover unchanged read rows from the existing active-branch transcript
  -> an unknown hash alone provides no row authority; normal held-row disclosure and safe salvage remain available
  -> edit-target compiles authored hunks into desired states and conservative change islands
  -> deterministic repair and stale recovery run without bypassing seen-line provenance
  -> accepted/repaired islands continue; held/rejected islands become typed outcomes and bounded residuals
  -> mutation queue locks canonical paths; each file stages, revalidates, and lands atomically
  -> later file failure/cancellation preserves exact earlier landed results; no cross-file rollback
  -> fresh snapshots retain only justified seen lines/blocks
  -> bundled-only syntax validation runs once after each final landed supported code path, reports only newly introduced/worsened grammar failures, and returns unavailable above the 256-KiB before/after budget
  -> optional CHECK LSP validates the final landed canonical file through the primary server
  -> return fresh hashes, compact context, warnings, diffs, coordinates, outcomes, and retry guidance
```

Core owners:

- read/selectors: `src/core/read-renderer.ts`, `src/core/summary-renderer.ts`, `src/core/summary-normalize.ts`;
- snapshots: `src/core/snapshot-store.ts`;
- grammar: `src/core/patch-parser.ts`;
- apply/landing: `src/core/patch-apply.ts`, `src/core/edit-target.ts`, `src/core/edit-retry.ts`, `src/core/mutation-queue.ts`;
- recovery/repair: `src/core/edit-recovery.ts`, `src/core/edit-recovery-worker.ts`, `src/core/edit-repair.ts`;
- blocks/syntax: `src/core/structural-block-resolver.ts`, `src/core/syntax-validation.ts`, `scripts/structural-block-worker.mjs`;
- LSP: `src/core/lsp-validation.ts`, `src/tools/lsp-validate.ts`;
- public wrappers: `src/tools/read.ts`, `edit.ts`, `write.ts`.

Continuation rule: the successful edit result is exact mutation evidence and the next authority. Use its post-edit coordinate manifest for distant hunks; do not automatically reread or diff unless a broader change question remains. Mutation invariants are `docs/harness-doctrine.md:navigation-harness-doctrine/mutation-doctrine#2`; the salvage rationale is `docs/decisions/proof-preserving-mutation.md:proof-preserving-source-authority-and-the-salvage-edit-engine/part-b-salvage-edit-engine#2`.

Cache eviction controls memory, not permission: `SnapshotStore` keeps compact full-digest row/block receipts within the existing encoded-byte budget. `src/tools/edit.ts::recoverReadRows` uses existing active-branch read results only when memory cannot supply proof; canonical path, tag, delivered numbered text and recorded intervals must agree with current source. Compaction does not itself revoke earlier reads. Cold recovery currently does not reconstruct native/edit-only receipts or certified block metadata; these remain integration gaps, not a blanket reread policy. Read rendering and the public edit language are unchanged.

## 5. Stale edit recovery

```text
hash no longer matches current bytes
  -> locate exact historical snapshot; unknown/ambiguous hash fails closed
  -> validate recovery budgets/deadline/cancellation
  -> try exact-context merge with fuzz 0
  -> else try unchanged-anchor uniform line remap
  -> else try guarded same-session replay
  -> reject changed, deleted, duplicate-ambiguous, or non-uniform anchors
  -> carry provenance only for unchanged rows still valid at current coordinates
  -> authored rows + displayed post-edit context become seen
```

Large files dispatch to a worker. Head/tail-only insertion drift has a separately bounded path. Recovery does not grant whole-file authority. Recovery mechanics are `docs/tool-operating-reference.md:jeito-codeweave-pi-tool-operating-reference-and-coverage-audit/edit/repair-stale-handling-and-retry#3`; the mutation doctrine is `docs/harness-doctrine.md:navigation-harness-doctrine/mutation-doctrine#2`.

## 6. Structural blocks

At read time, `resolveStructuralBlocks` sends supported code/Markdown to one cached low-priority `web-tree-sitter` worker. Certified spans are filtered to blocks whose boundaries were completely displayed, then stored with the snapshot.

At mutation time, `REPLACE/DELETE/INSERT ... BLOCK AT` resolves only stored metadata. No parser, navigation backend, or provider is called. Missing/ambiguous certification returns `block_unavailable` and writes nothing. Certified-block operations are `docs/tool-operating-reference.md:jeito-codeweave-pi-tool-operating-reference-and-coverage-audit/edit/certified-structural-operations#3`; the certified-block rationale is `docs/decisions/proof-preserving-mutation.md:proof-preserving-source-authority-and-the-salvage-edit-engine/part-b-salvage-edit-engine/failure-boundaries#3`.

Supported grammars: TypeScript, TSX, JavaScript, Python, Go, Rust, Java, Kotlin, Markdown.

## 7. File operations and independent atomic landing

`DELETE FILE` and `MOVE FILE TO` require the exact current hash; stale recovery is forbidden. The engine rejects directories, symlink sources, root escapes, existing destinations, case-fold collisions, and mixed file/content operations for one source.

Content replacement stages a same-directory temporary file, preserves mode and macOS xattrs when present, revalidates the source, then renames atomically. Ordered locks prevent deadlock. Files land independently: a later file failure or cancellation does not roll back an earlier successful file, while staging/commit recovery remains local to the active file and reports exact outcomes. The `write`/whole-file surface is `docs/tool-operating-reference.md:jeito-codeweave-pi-tool-operating-reference-and-coverage-audit/write#2`; atomicity doctrine is `docs/harness-doctrine.md:navigation-harness-doctrine/mutation-doctrine#2`.

## 8. Document mutation and reconciliation

### Exact Pi mutation

```text
edit/write/delete/move completes
  -> public wrapper extracts affected Markdown paths
  -> scheduleQmdDocsRefresh(trigger=edit|write, exact paths)
  -> acquire the existing per-root docs transaction
  -> pi-nav projects current sections for changed files
  -> QMD deletes stale selectors, upserts changed section documents,
       and embeds changed content only through the persisted local, ZeroEntropy, or Voyage provider;
       a lexical lane never upgrades itself into provider work or model acquisition
  -> mutation authority remains independent of background refresh status
```

### External change discovery

```text
session-start / every-ten-tool / manual freshen
  -> acquire one per-root docs transaction
  -> discover eligible current Markdown through pi-nav project visibility (custom navigation ignore when configured, otherwise Git ignores)
  -> pi-nav projects byte-correct section selectors, ranges, hierarchy, and source hash
  -> QMD removes stale section identities, upserts changed sections, and publishes a generation bound to source fingerprints plus projection format
  -> persist lexical readiness independently from vector/provider/reranker health and record the admitted semantic provider

edit/write/delete/move
  -> enqueue exact paths through the same owner
  -> coalesce overlapping requests and wait during shutdown
  -> reconcile changed or missing Markdown identities incrementally
```

Owners:

- refresh queue, path filtering, and shutdown waiting: `src/core/qmd-docs-refresh.ts`;
- section projection and QMD reconciliation: `src/core/qmd-docs-search.ts`;
- lifecycle transaction/state: `scripts/navigation-freshen.mjs` and existing lane-transaction owners;
- live Markdown parsing: bundled pi-nav.

Package postinstall is the sole automatic QMD model-acquisition owner. It downloads and verifies the 318 MiB embedding and 610 MiB reranker GGUF files (928 MiB measured cache); repeat installs reuse valid cached files. Project setup selects local, ZeroEntropy, Voyage, or lexical behavior without reacquiring models. codeweave-pi omits QMD's optional 1.19 GiB query-expansion model because structured docs retrieval never calls it.

There is no docs broker, MCP session, filesystem watcher, hierarchy cache, copied-store rollback, summary layer, or query-time repair. The runtime docs-retrieval contracts are `docs/evidence.md:current-evidence-map/documentation-retrieval-and-live-markdown#2`; query-time purity is `docs/harness-doctrine.md:navigation-harness-doctrine/query-time-purity-and-lifecycle-ownership#2`.

## 9. Docs query coordination

`docs_search` reads the current QMD index immediately. It never schedules indexing or waits for background refresh. Returned section selectors are projected against current pi-nav Markdown structure and rejected when source hashes disagree. Each returned `.md` file's first appearance in the extension session may attach exact numbered YAML frontmatter under the same source-authority contract as `read`, regardless of ranking score. Subsequent `docs_search` or `read` appearances omit unchanged frontmatter; a frontmatter digest change makes it eligible again. Ranked section snippets remain prepared evidence. `read` resolves a selected section again from current bytes and supplies any additional source authority. The retrieval contracts are `docs/evidence.md:current-evidence-map/documentation-retrieval-and-live-markdown#2`; the frontmatter schema is `docs/management.md:documentation-ownership-and-maintenance/frontmatter-schema#2`.

## 10. Core, Graphify, and bundled pi-nav lifecycle
The backend lifecycle map is `docs/evidence.md:current-evidence-map/lifecycle-and-backend-health#2`; operator expectations are `docs/setup.md:setup-health-repair-and-migration/backend-expectations#2`.

### Core

- `index.ts::registerCandidateAnalysisLifecycle` owns admission, scheduling and writer selection for the package-owned indexed code graph. Queries read ready evidence only and never prepare, build or repair it;
- `native/analysis/maintenance.ts::maintainAdmittedProject` runs inside the supervised maintenance child and reuses CodeGraph initialization and incremental sync; [`../native/analysis/README.md#maintain-an-admitted-project-in-one-isolated-child`](../native/analysis/README.md#maintain-an-admitted-project-in-one-isolated-child) owns the child contract and limits;
- `scripts/pi-nav-build.mjs::checkCore` verifies the required maintenance payload and grammars, loads the adjacent kernel/bundle, and exercises the packaged code encoder. The package-relative `semantic-model` assets are distinct from QMD's GGUF cache, and there is no per-project model path or downloader;
- an explicit `architecture.enabled/autoPrepare: false` or `backends.crg.enabled: false` remains an honored prohibition of automatic code preparation rather than disposable predecessor configuration;
- failed or interrupted maintenance leaves indexed relations unavailable; automatic recovery is not implemented. Independent live Grep and Git evidence remain separate capabilities, not a promise of a fallback inside every prepared query;
- retired CRG bindings and stores are never read, adopted, migrated or deleted. They neither prove nor block code ownership, and independent Core coexists with them.
The retired CRG delivery record is historical reasoning only: `docs/decisions/r5-crg-clean-break.md:r5-crg-clean-break-stock-plus-one-watchdaemon-patch/decision#2`; the current Core owner contract is `docs/setup.md:setup-health-repair-and-migration/backend-expectations/core-code-navigation-and-local-semantics#3`.

### Graphify

- query-time map/path/explain consumes the last verified generation and remains available while refresh is pending/retrying; missing, unreadable, unsafe, or backend-unqueryable artifacts fail closed;
- successful edit/write mutations schedule Graphify refresh; duplicate work is a stock hash no-op;
- every-ten-tool cadence includes a Graphify incremental/currentness checkpoint so externally added files—not present in the prior manifest and therefore invisible to mtime comparison—are discovered without waiting for session shutdown;
- routine rich refresh repairs changed, deleted, moved, no-longer-selected, and colliding source identities inside the incremental update and publishes only after exact-manifest, source/path quality, and representative-query verification;
- graph-size reduction is normal current state. The isolated rich candidate always uses Graphify's forced write, records provenance-loss telemetry, and publishes only after manifest/path/query verification;
- a failed incremental operation keeps the verified generation query-ready. Retryable provider/backend failures retain backoff and retry automatically; only actionable blockers such as authentication, unsupported media, a missing/corrupt artifact, or an unsafe scope require operator intervention;
- legacy explicit `update`/`deep` paths also force legitimate shrink and no longer strand refresh merely because ignore policy is newer. Unsafe output provenance, incompatible scope, missing/corrupt artifacts, or a nonzero backend query remain the fail-closed boundaries.

The observed shrink failure had six project-owned causes rather than a generic Graphify outage: the shared ignore defaults omitted the generated `.ua/` analysis tree; incremental manifest publication merged deleted entries back into the manifest; the detector's category-to-path map was later mistaken for manifest entries; incremental `build_merge` first ran Graphify's global fuzzy deduplication over the loaded baseline and, even with that disabled, whole-graph canonicalization and simple-graph identity collisions reassigned unchanged node/edge provenance; and an older graph retained `vendor/tilth-patched` provenance that current detection no longer selected while the shrink gate admitted only explicitly changed/deleted sources. The lifecycle now excludes `.ua/`, creates an exact valid manifest from current detection, treats no-longer-detected provenance and edges removed with changed/retired endpoints as attributable retirement, disables whole-baseline merge canonicalization, preserves parallel existing edges with a multigraph candidate, deterministically remaps changed-node IDs that collide with unchanged-source IDs, and isolates candidate graph/manifest mutation until quality and query verification pass.

Upstream Graphify behavior is `docs/upstream/graphify-official-docs-digest.md:graphify-official-docs-digest#1`.
### Bundled pi-nav

- `ls`, grep/find, smart read, supported structural trace, and structural diff use the archive-owned N-API addon;
- no prepared index, setup lane, command lookup, PATH fallback, provider, or query-time process is involved;
- canonical-root sessions are reused per Pi process and calls are FIFO per root; cancellation and deadlines remain cooperative;
- exact utility semantics remain distinct: `ls` observes directory shape, grep searches content, and find discovers paths.
The in-process addon lifecycle and rationale are `docs/decisions/pi-nav-owned-backend.md:owned-pi-nav-backend-as-an-in-process-n-api-addon#1`.

## 11. Shutdown and process cleanup

```text
session_shutdown
  -> always shutdownQmdDocsRefreshes
       await queued/coalesced docs reconciliation
  -> always shutdownStructuralBlockResolver
       terminate parser worker
  -> when setup is allowed: one lock-coalesced Graphify stop refresh
  -> when PI_NAV_NO_AUTO_SETUP / read-only host policy applies: no heavy stop refresh
```

There is no heavy `agent_end` refresh. Orphaned refresh/parser processes are defects; diagnose process ownership and lane transaction tokens before killing unrelated processes. The normal lifecycle is `docs/setup.md:setup-health-repair-and-migration/normal-lifecycle#2`.

## 12. Setup, repair, and destructive boundaries

Query-time failure must not trigger repair. `/navigation-setup` only reports runtime status and the exact stopped-Pi `npm run nav:provision` command. The approved setup workflow in `docs/setup.md:setup-health-repair-and-migration/repair-decision-tree#2` owns:

- complete shared-runtime rebuild after missing/failed postinstall;
- initial lane preparation and targeted freshen;
- provider/config changes;
- Graphify deep rebuild;
- scope migration;
- index quarantine/restore/delete.

Destructive actions require explicit approval, a dry-run or exact plan, rollback material, and post-action verification. Automatic lifecycle never deletes or force-rebuilds an index.
Destructive boundaries and current limitations are `docs/current-truth.md:current-truth-and-future-work/known-limitations#2`.
