---
title: "Nested navigation projects PRD and investigation index"
description: "Active product requirements, implemented nested-corpus lifecycle status, and remaining published-delivery gates for CRG, Graphify, and QMD."
tags: [jeito-codeweave-pi, nested-projects, prepared-corpora, product-requirements, investigation]
created: 2026-07-27
updated: 2026-07-28
status: superseded
owns: "Historical investigation record for nested navigation projects; the binding product objective and requirements now live in docs/requirements.md"
audience: mixed
code: [index.ts, scripts/navigation-freshen.mjs::freshenGraph, src/core/navigation-config.ts::resolvePreparedLane, src/core/navigation-config.ts::preparedLifecycleProjectRoots, src/core/project-root.ts::detectProjectRoot, src/core/scope-planner.ts::planNavigationScope]
related: [docs/plan/adversarial-review-prompt.md, docs/plan/corpus-contract.md, docs/plan/evidence-ledger.md, docs/plan/implementation.md, docs/current-truth.md, docs/harness-doctrine.md]
---

# Nested navigation projects PRD and investigation index

## Status: investigation history — superseded by docs/requirements.md

The binding product objective, per-project contract, delivery contract, credential model, update policies, and testing/fix discipline now live in `docs/requirements.md`, which is authoritative. This folder is retained as investigation history (evidence ledger, backend research, the adversarial review that selected the architecture). Its open gates and increments are **not** a work queue; do not pursue them as tasks. Read `docs/requirements.md` first.

This folder owns the remaining nested-navigation implementation and delivery boundary. Nearest-config resolution, artifact-local corpus adapters, path-owned mutation, and one recovered parent/child macOS journey now exist, but current behavior is not release-ready; `docs/current-truth.md:current-truth-and-future-work/cross-machine-delivery-status#2` governs that verdict. Planned claims remain explicit until published-artifact acquisition, first-run safety, lifecycle quiescence, and loaded-provider gates pass.

The current defect that triggered this work is cross-project ancestor-lane selection in `src/core/navigation-config.ts::resolvePreparedLane`: a requested scope can inherit an enabled but unrelated ancestor configuration. The larger design problem is stricter than that defect. A broad prepared graph cannot become an isolated nested project by filtering returned rows after indexing.

## Product objective and success criteria

jeito codeweave-pi must let a user declare a small hierarchy of prepared navigation projects. Each project owns a corpus and backend artifacts for CRG, Graphify, and QMD. A tool call selects one project, queries only its artifact, and may advertise other available projects without querying them.

Success requires:

1. **Corpus integrity:** every admitted file belongs to the selected project’s declared corpus; parent corpora exclude independent child projects.
2. **Artifact identity:** every prepared result reports requested scope, selected project, corpus root, backend artifact, and generation or health identity.
3. **One-project query:** `explore`, prepared `trace`, and `docs_search` never fan out automatically across projects.
4. **No synthetic isolation:** post-query path filtering is never presented as equivalent to a separately constructed corpus.
5. **Portable configuration:** project configuration stores relative project paths and logical backend choices, not host-specific runtime or Python paths.
6. **Read-only query time:** indexing, provider calls for preparation, downloads, repair, and project discovery mutations remain lifecycle/setup work.
7. **Path-owned lifecycle:** edits and external changes refresh the project owning each changed path, not merely the session working directory.
8. **Visible alternatives:** when other prepared projects are relevant by hierarchy, the response lists their identities as not searched and gives the next explicit call.

## Product boundaries and non-goals

The first implementation must not:

- query every child project and merge rankings;
- create a global cross-project CRG/QMD/Graphify abstraction;
- auto-index every package marker found in a monorepo;
- infer external repositories from natural-language query text;
- use `path`, glob, or result post-filtering as strict project isolation;
- replace backend-native ignore semantics with one unrestricted pattern language;
- run Graphify LLM extraction merely because a project was discovered.

Graphify’s namespaced `merge-graphs` capability is evidence that an explicit aggregate may be possible later. It is not a reason to create a Graphify-only federation contract before CRG and QMD have equivalent product semantics.

## Decisions supported by current evidence

- A **navigation project is the nearest valid `.pi-navigation.json` boundary plus its prepared corpus and artifacts**, not a query filter or catalog entry.
- One tool call selects one project. Missing lanes fail closed; farther ancestors are never lane fallbacks.
- Existing `scope.exclude` is the canonical flat list of normalized root-relative subtree prefixes. No new pattern grammar or project identifier is justified.
- Parent corpora exclude independent children during construction; post-query path filtering cannot provide strict isolation.
- Corpus policy is artifact-local: generated `.pi/navigation/crg.ignore` for the bundled CRG seam, persisted Graphify `--exclude`, and QMD admission filtering before section projection.
- User `.code-review-graphignore`, `.gitignore`, `.graphifyignore`, and exact-tool `.pi/navigation/ignore` remain untouched and additive where their backend supports them.
- Canonical configuration root owns runtime/lifecycle identity. A child is advertised only when an exact `scope.exclude` path has a valid project-local config and prepared lane.
- Graphify rich work is dirty/explicit only; CRG policy publications use atomic replacement plus its existing debounce; QMD policy changes require full stale-document/vector reconciliation.

The shared terminology and query behavior are `docs/plan/corpus-contract.md:prepared-corpus-and-navigation-project-contract#1`. Claim-level evidence is `docs/plan/evidence-ledger.md:nested-navigation-evidence-ledger#1`.

## Implementation and release gates still open

1. Publish an accessible immutable artifact and prove clean acquisition; a transferred candidate snapshot is not delivery evidence.
2. Re-run installer preflight on the representative Mac mini: Python now precedes runtime replacement, shell/npm-child Pi mismatch blocks registration, QMD models remain separate, and unsafe HOME/filesystem roots fail closed.
3. Re-run installed CRG dynamic registration on the representative machine. Local installed-runtime evidence now proves atomic config replacement starts a second watcher without daemon restart and readiness requires a PID-matching receipt.
4. Run loaded native Graphify parent/child maintenance from the installed artifact. The custom helper is deleted, focused lifecycle tests pass, and pinned 0.9.23 cache selection/exclusion persistence are executed locally; loaded scoped map publication remains the release proof.
5. Complete loaded-provider gates: MiniMax-M3 must exercise every public tool union, while Graphify uses a separately certified provider such as DeepSeek `deepseek-v4-flash` and fails incomplete semantic output closed.
6. Exercise removal and rollback from the published artifact without deleting user-owned models or project data.

## Navigation setup user experience

`/navigation-setup` should show the nearest project boundary and exact `scope.exclude` children rather than invent a catalog or scan every package:

```text
Boundary                         Parent exclusion          CRG   QMD   Graphify
.                                extensions/codeweave-pi      yes   yes   existing only
extensions/codeweave-pi             none                      yes   yes   guided
```

The user chooses whether a child is independent. Setup previews admitted files, generated artifact-local policy, provider/privacy effects, publication order, and rollback before writes. Ordinary exclusions remain exclusions; they are advertised as children only when the exact directory has a valid project-local configuration and prepared lane.

## Plan document map

| Question | Planning owner |
|---|---|
| What is a navigation project and how does one call select it? | [`corpus-contract.md`](corpus-contract.md) |
| Which claims are verified, inferred, contradicted, or open? | [`evidence-ledger.md`](evidence-ledger.md) |
| How does CRG construct and ignore its corpus? | [`crg-backend.md`](crg-backend.md) |
| How does Graphify construct and ignore its corpus? | [`graphify-backend.md`](graphify-backend.md) |
| How does QMD/pi-nav construct and ignore its docs corpus? | [`qmd-backend.md`](qmd-backend.md) |
| In what order should implementation proceed and what proves each increment? | [`implementation.md`](implementation.md) |
| What did the completed independent review inspect, challenge, execute, and report? | [`adversarial-review-prompt.md`](adversarial-review-prompt.md) |

## Completion and plan-collapse rule

This plan completes only when project selection, per-backend corpus admission, lifecycle ownership, setup preview, migration, and loaded-tool isolation pass the focused fixtures in `docs/plan/implementation.md:nested-navigation-delivery-plan/release-and-migration-gates#2`.

After implementation, move verified behavior into `docs/current-truth.md`, behavior-to-code proof into `docs/evidence.md`, and any settled choice with rejected alternatives into `docs/decisions/`. Delete this plan folder after durable knowledge has moved; do not leave a second current authority.
