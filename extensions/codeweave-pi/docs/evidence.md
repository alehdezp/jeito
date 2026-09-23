---
title: "jeito codeweave-pi behavior-to-code verification map"
description: "Canonical mapping from public behavior and runtime ownership to source owners and focused verification."
tags: [jeito-codeweave-pi, evidence-map, verification, runtime-ownership, tests]
created: 2026-07-25
updated: 2026-09-21
status: active
owns: "Mapping from public behavior to code owners and focused verification"
audience: contributor
code: [src/tools/explore.ts, src/tools/trace.ts, src/tools/docs-search.ts, src/tools/read.ts, src/core/markdown-frontmatter.ts, src/core/source-selector.ts, src/core/frontmatter-relationships.ts, src/core/source-authority.ts, native/analysis/maintenance.ts]
related: [docs/harness-doctrine.md, docs/automatic-workflow.md, docs/current-truth.md, docs/decisions/README.md]
---

# Current evidence map

This file maps shipped behavior to its current code owners and focused verification. Decision rationale belongs in `docs/decisions/`; upstream contracts belong in `docs/upstream/`.

## Public prepared tools

| Behavior | Code owner | Focused evidence |
|---|---|---|
| Graphify cross-domain map and A-to-B trace | `src/tools/{explore,trace}.ts`, `src/core/{navigation-config,navigation-clean}.ts`, `scripts/navigation-freshen.mjs` | `tests/v3-explore-copy.test.mjs`, `tests/v3-trace-explain.test.mjs`, map/path/explain focused tests |
| Core indexed code identity and topology | `src/tools/explore.ts`, `src/core/pi-nav-native.ts`, `native/analysis/maintenance.ts` | `tests/v3-explore-conductor.test.mjs`, `tests/v3-trace-guardrails.test.mjs`; prepared query, traversal, mutation, and loaded prepared-route tests |
| Focused callers/callees/imports/importers/tests | `src/tools/trace.ts`, `src/core/pi-nav-native.ts` | `tests/v3-trace-guardrails.test.mjs`, `tests/v3-live-source-authority.test.mjs`; ambiguity coverage proves that no relation is reported complete, only exact-name candidates become retry identities, approximate matches stay labeled and non-authoritative, and mixed batches remain partial |
| QMD prepared Markdown-section retrieval | `src/tools/docs-search.ts`, `src/core/qmd-docs-search.ts`, owned fork under `native/qmd/` | `tests/v3-qmd-docs-search.test.mjs` covers lexical, ZeroEntropy, and owned local-model inference; clean-break public-schema tests |

`code_context` is internal and unregistered. Public architecture inventories, file summaries, and speculative graph operations remain excluded. The doctrine separating these capabilities by the reality each observes is `docs/harness-doctrine.md:navigation-harness-doctrine/evidence-capabilities-not-routes#2`.

**Retired CRG code-lane receipts (historical).** These admission receipts were captured against the retired CRG runtime and are retained as evidence classes; they are not re-verified against the indexed Core lane. They include generic→result-guided refinement, exact search, traversal, callers/callees/tests traces, native→model/details/TUI preservation, and source-authority checks. Mixed search results prioritize non-test candidates while preserving the excluded-test count and `kind:"Test"` opt-in; test-only result sets remain visible instead of becoming a synthetic zero. Traversal edge pages begin with edges touching the requested start identity and then follow traversal depth/order. Test trace candidate origins page to the requested limit, preserve direct versus supplemental origin, and accept canonical aliases when prepared hashes use relative paths but relationships expose absolute paths. Negative controls catch source-first grep/read boundary collapse while identity remains open.

Graphify text-mode map evidence resolves an exact supplied path or `file::symbol` through native `explain`, queries from the returned graph node ID, verifies that identity against actual Start/NODE rows, and changes the envelope to warning when the requested anchor is not retained. Native `NODE` and `EDGE` rows page independently with stable non-overlapping windows while retaining actual Starts on every page. `tests/v3-explore-copy.test.mjs` covers exact-ID resolution, retained/rejected status, path priority, file seeds, late-edge preservation, and continuation; direct current execution covers `src/core/navigation-clean.ts` and `src/core/navigation-clean.ts::graphifyQueryEnv`. Prepared traversal accepts stock node `file` locations, and exact File qualification prefers the exact node identity over same-file symbol candidates. Trace source projection prefers exact native relationship-edge sites over broader declaration ranges, names the relationship peer, preserves graph path/explain evidence in the TUI, and reports an unresolved graph path as warning evidence without a synthetic file lead; `tests/v3-{core,explore-conductor,trace-explain,trace-guardrails}.test.mjs` cover these contracts.

## Agent operational-literacy surface

The public surface is shipped only when agents can connect reasoning to effective calls. Registered prepared tools are callable by default: agents invoke the owning evidence capability without speculative readiness/indexing/freshness checks, while actual result diagnostics calibrate only that returned claim. `~/.pi/agent/APPEND_SYSTEM.md` owns durable intent, construction, leverage, interpretation, and adaptation strategy; `docs/harness-doctrine.md:navigation-harness-doctrine/operational-literacy-bridges-reasoning-into-tool-calls#2` owns that layered contract; each tool description/schema owns current accepted forms, mode-specific mechanics, limits, advanced-feature discoverability, and local recovery. `docs/tool-operating-reference.md:jeito-codeweave-pi-tool-operating-reference-and-coverage-audit/how-to-audit-tool-coverage#2` is the exhaustive human/agent review surface mapping every parameter and public advanced feature to APPEND, schema, tests, and behavioral evaluation.

Current source owners are `src/tools/{explore,trace,docs-search,grep,find,ls,read,diff,lsp-validate,edit,write}.ts` plus shared paging/authority owners `src/core/{prepared-page,source-authority}.ts`. `tests/v3-{explore-conductor,trace-guardrails,tool-operating-reference,param-contracts}.test.mjs` verify prepared code candidate retention, relevance-ordered traversal edges, test-origin paging, canonical hash aliases, broad-default limit recommendations, operational descriptions, exact schemas, and APPEND/doctrine coverage. Existing focused edit tests continue to own `CHECK LSP`, retries, multi-file outcomes, and certified blocks.

APPEND and doctrine include conditional worked calls rather than a fixed route and explicitly prohibit speculative prepared-tool health gates. Cross-domain questions require map invocation/re-entry/closure; implementation questions require code search while ownership is unqualified, traversal when an exact identity has an open neighborhood, and trace for one exact relation. Tests/helpers locate subsystems without proving ownership, and stronger identities reopen the owning code capability. Fresh Sol/Luna model evaluation (`docs/evaluation-workflow.md:agent-evaluation-workflow/operational-literacy-evaluation#2`) remains the authority for actual tool choice and stopping; previous targeted runs produced no output/session artifact, so that behavioral tier is unconfirmed rather than failed.

## Documentation retrieval and live Markdown

| Contract | Current owner | Proof/guard |
|---|---|---|
| Sole persisted docs retrieval index | owned QMD runtime under `native/qmd/` | local SQLite/FTS5 and sqlite-vec runtime; config rejects obsolete query commands/transports |
| Current Markdown section identities | bundled pi-nav Markdown structure operation | native Rust tests plus current source hash in the typed result |
| Section projection/reconciliation and ranking | `src/core/qmd-docs-search.ts`, owned QMD runtime | query-level tests cover project-visibility discovery, Unicode byte offsets, projection-format migration, relaxed lexical paraphrases, exact-title and current-vs-plan priors, answer-bearing versus weak-lead classification, stale-selector omission, incremental upsert, local/ZeroEntropy/Voyage/OpenRouter providers, provider degradation, and read-only fallback |
| Mutation/cadence/shutdown scheduling | `src/core/qmd-docs-refresh.ts`, `index.ts` | refresh tests prove exact-path coalescing and that lexical mutation never invokes a configured provider; loaded cadence tests prove `qmd` identity and reconciliation of external Markdown changes even from an already-ready lane |
| Startup/manual lifecycle, provider persistence, and obsolete-config migration | `src/core/navigation-setup-planner.ts`, `scripts/navigation-freshen.mjs` | setup/freshen tests prove docs-only startup, explicit local-model disclosure, lexical policy downgrade, persisted local choice, QMD-owned path selection, final config cutover, and preservation of old user data |
| Public ranked leads and active-mode display | `src/tools/docs-search.ts`, `src/core/tui-render.ts` | public-path tests cover direct invocation, filters, paging, scores, generation, current selectors, answer-bearing and warning-status weak leads, and model evidence; TUI fixtures cover hybrid/lexical evidence, filtered zero, request-specific unavailable/error results, provenance, snippets, omissions, continuation, and evidence-vocabulary rendering without internal stack names or speculative health deterrents |
| Session-scoped Markdown frontmatter exposure and relationship checks | `src/core/markdown-frontmatter.ts`, `src/core/frontmatter-relationships.ts`, `src/tools/read.ts`, `src/tools/docs-search.ts` | focused read and QMD public-path tests prove first exposure, cross-tool deduplication, exact numbered rows, title/description budget fallback, visible-field-only `code`/`related` validation, and valid/invalid/ambiguous/unverified reporting |
| Query purity and model acquisition boundary | `native/qmd/runtime/llm.js`, `src/core/qmd-docs-search.ts` | SQLite/runtime tests prove cached local inference opens with downloads disabled and rejects uncached models; release install gates require `node-llama-cpp` to initialize without download and reject global-QMD decoys |
| Outline/section/range/code-symbol/current bytes | `src/tools/read.ts`, `src/core/read-renderer.ts`, `src/core/source-selector.ts`, pi-nav `symbol_range` | focused selector tests prove equivalent `:`/`::`, mixed code/Markdown/range selectors, exact-file precedence, ambiguity, stale-source rejection, bounded output, and hash authority; native symbol tests prove tail-definition lookup without bounded-outline loss |
| Edit authority | `src/core/source-authority.ts`, `SnapshotStore` | `tests/v3-live-source-authority.test.mjs` |

Locked negatives:

- no second section manifest or hierarchy cache;
- no raw Markdown cache, summaries, tags/reference extraction, or public chunk API;
- no docs filesystem watcher or query-time indexing/repair;
- no managed corpus upload;
- no public legacy docs action tool or compatibility alias;
- no automatic deletion of old user-owned data.
The runtime docs-query flow is `docs/automatic-workflow.md:implemented-runtime-flows/9-docs-query-coordination#2`; the frontmatter contract is `docs/management.md:documentation-ownership-and-maintenance/frontmatter-schema#2`.

## Exact live utilities and source authority

| Behavior | Code owner | Focused evidence |
|---|---|---|
| Directory/path/content identity | bundled pi-nav + `src/tools/{ls,grep,find}.ts` | clean-break, scan-safety, grep cursor/authority tests; a complete literal zero containing regex-looking tokens emits one explicit `syntax:'regex'` recovery without weakening the literal evidence, complete zero targets are not labeled exceptions, and batched find model text retains every pattern outcome |
| Current source reads | `src/tools/read.ts`, `src/core/read-renderer.ts` | `tests/v3-core.test.mjs` |
| Unified current-byte authority | `src/core/source-authority.ts`, `src/core/live-source-evidence.ts`, snapshot store | `tests/v3-live-source-authority.test.mjs` |
| Natural hashed mutation | edit engine and `src/tools/{edit,write}.ts` | edit engine/unit/loaded checks |
| Syntax and LSP diagnostics | syntax validator, `lsp_validate`, pi-lens lifecycle | focused syntax/LSP suites; unconfirmed/timeout output explicitly forbids an unchanged retry and requires a changed hypothesis, setup, scope, or input |
| Current changes | `src/tools/diff.ts` and Git/pi-nav owners | diff structure/review tests; exact files/ranges/symbols govern direct change claims, while fully out-of-scope prepared risk is omitted rather than presented as exact-patch risk |
| Public-call normalization and actionable invalid-call evidence | `src/core/tool-call-contract.ts`, public tool owners, `src/core/tui-render.ts` | route contract tests prove visible case/numeric normalization and scalar LSP path normalization; malformed batches, duplicate targets, obsolete fields, and incompatible modes execute nothing while accepted forms/guidance remain structured and rendered. Bare-symbol trace ambiguity is a separate warning result: the qualification query ran, but no structural relation completed. |
The authority/mutation concepts are `docs/harness-doctrine.md:navigation-harness-doctrine/source-and-mutation-authority#2`; the decision rationale is `docs/decisions/proof-preserving-mutation.md:proof-preserving-source-authority-and-the-salvage-edit-engine/part-a-unified-source-authority#2`.

## Lifecycle and backend health

| Lane | Lifecycle contract | Evidence |
|---|---|---|
| Package/startup | Cloned-suite `npm run install:codeweave-pi` runs a frozen codeweave-pi-only install with workspaces disabled, requires the shipped QMD runtime and `node-llama-cpp`, verifies the Core maintenance/code-semantic payload through `pi-nav-build.mjs check-core`, then registers the local path; QMD embedding/reranker acquisition stays postinstall-owned and the optional Graphify runtime stays a separate stopped-Pi step; valid model caches are reused; startup performs path checks and never installs | Clean copied-checkout/empty-Pi-home registration proof; QMD acquisition/unit and real cached inference proof; Pi package and pinned-Git lifecycle gates; handler/RPC latency gates; `tests/codeweave-pi-checkout-install.test.mjs`; `tests/v3-qmd-model-provision.test.mjs`; `tests/v3-navigation-provision.test.mjs` |
| QMD docs | startup/cadence use QMD independently of Core and Graphify readiness; `auto` prefers allowed configured ZeroEntropy then Voyage and otherwise installed local inference; lexical mode remains explicit; only postinstall/model-provision acquires GGUF files; query paths never acquire or build | planner, freshen, QMD local/provider search, model provisioning, cadence, loaded-flow, package, SQLite runtime, and Linux behavior tests |
| Core indexed code | package-owned maintenance assets and the pinned local code model are checked by `scripts/pi-nav-build.mjs::checkCore`; admission, scheduling and writer selection live in `index.ts::registerCandidateAnalysisLifecycle`; queries read ready evidence only, and retired CRG stores or bindings are never adopted | `check-core`/package gates; maintenance, admission and prepared-mutation tests; ordinary-entrypoint fixture proof recorded in `docs/current-truth.md` |
| Graphify | pinned `graphifyy[openai]==0.9.23` is the only Python backend in the extension-local venv; no PATH/executable override; exact mutations mark refresh pending while verified graph publication remains atomic | provisioning/decoy/secret tests; freshen/shrink/mutation tests; installed Graphify path/explain probe; Linux behavior gate |
| pi-nav | precompiled package-relative N-API addon/CLI with SHA-256 manifest; no prepared lane, installer compilation, or query-time repair | host and Linux `pi-nav:check`; package Git-install and loaded exact-tool tests; installed `grep` probe |
The implemented lifecycle flows are `docs/automatic-workflow.md:implemented-runtime-flows/10-core-graphify-and-bundled-pi-nav-lifecycle#2`; operator backend expectations are `docs/setup.md:setup-health-repair-and-migration/backend-expectations#2`.

## Verification hierarchy

1. Use the smallest owning unit/native test for a local contract.
2. Use focused cross-owner tests when a shared boundary changes.
3. Use fresh loaded Pi execution for public tool registration, schemas, rendering, and N-API behavior.
4. Use package-content/install smoke for shipped artifact claims.
5. Run the broad suite only at the final shared-contract closure gate.

Package archives, pip downloads, and QMD GGUF files are immutable inputs for their version/hash and must be reused across independent workers. A clean download proves acquisition only when URI/downloader/cache/platform ownership changed; repeating it during every install adds cost without new evidence. The executable routing matrix is `docs/evaluation-workflow.md:agent-evaluation-workflow/release-implementation-validation-tiers/change-surface-routing-matrix#3`.

A passing check proves only the contract it exercises. Current source rows, repository patch evidence, prepared topology, written intent, and runtime behavior remain distinct evidence classes. The matching doctrine is `docs/harness-doctrine.md:navigation-harness-doctrine/verification-standard#2`; the detailed tiers and release gates are `docs/evaluation-workflow.md:agent-evaluation-workflow/evidence-ladder#2`.
