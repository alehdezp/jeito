---
title: "Decision: monorepo root is always indexed; ambiguity never skips root preparation"
description: "Why a monorepo/workspace root always prepares its code graph (ambiguity never blocks root preparation), why the code and Graphify lanes differ, and why per-package fan-out, a whole-repo global flip, and a filesystem-scanning sibling-scope hint were rejected."
tags: [jeito-codeweave-pi, decision, monorepo, crg, scope, corpus-policy, lifecycle]
created: 2026-07-28
updated: 2026-09-21
status: completed
decided: 2026-07-28
decision_status: superseded
owns: "The settled rule that the project root is always indexed and that monorepo ambiguity never blocks root preparation"
audience: contributor
code: [src/core/navigation-setup-planner.ts]
related: [docs/requirements.md, docs/decisions/r5-crg-clean-break.md, docs/current-truth.md]
---

# Monorepo root is always indexed

Status: **historical mechanics; the rule itself is live.** The CRG-specific mechanism this record describes (`navigation-setup-planner.ts::crgAction`, the `.code-review-graph` store, the declared architecture lane) was retired with CRG. The binding rule lives in [`../requirements.md`](../requirements.md) under "Explicit nested-project behavior" and is implemented by the indexed Core lifecycle (`index.ts::registerCandidateAnalysisLifecycle` with `native/analysis/maintenance.ts::maintainAdmittedProject`). This record preserves the *why*.

## Context

The scope planner treated a monorepo with no query-inferred package as "ambiguous" and downgraded the CRG prepare action to `guided` (`scope-planner.ts planMonorepo` → `navigation-setup-planner.ts` scope gate → `classifyPolicy`). The automatic lifecycle runs in `auto` mode and skips any action that is not `auto`, so a monorepo root **never** received a CRG graph at session start. `explore({view:"code"})` and `trace` at the root then failed closed with `architecture lane not declared by nearest .pi-navigation.json`. This directly contradicted the per-project contract: a prepared project is one folder plus everything it owns, and its corpus is root minus excludes — the root is supposed to be indexed.

## Decision

CRG always prepares the project root. A monorepo/workspace being "ambiguous" only affects which child a *scoped* query may prefer; it never decides whether the root is indexed. Independent children stay out of the root graph through `.pi-navigation.json` `scope.exclude`, exactly as the nested-project contract already requires.

- `navigation-setup-planner.ts crgAction` drops the scope-ambiguity reasons for CRG and defaults the action to the whole root (`scope: "."`). Genuine blockers (no source files, invalid config, hard preflight limits) still apply.

## Why CRG and Graphify differ

CRG is a bounded local AST build with local-or-keyed embeddings — cheap enough that the whole root is always worth indexing, so ambiguity is no reason to refuse it. Graphify deep extraction is LLM-backed and costly; it keeps its own cost-based deferral on an ambiguous monorepo. That is a **separate gate from scope ambiguity** and is deliberately unchanged: the two backends refuse for different reasons, and only CRG's reason was the bug.

## Rejected alternatives (do not resurrect)

- **Per-package lifecycle fan-out** (auto-prepare every workspace package at startup): heavier — N builds per session — and unnecessary, because the root is indexed once and independent children are excluded from it. A child gets its own graph only when someone actually prepares it as separate.
- **`monorepoMode: "whole-repo"` as the only lever:** forces every user to flip a global to get the behavior the contract already promises.
- **Automatic scope-inference magic:** the design is explicit agent choice. The agent scopes into a project on purpose; the system does not guess where it "might" want to search.
- **Filesystem-scanning sibling-scope hint:** an early revision of this change added `preparedSiblingScopes`, which walked the directory tree on a lane miss to advertise nested projects. It was removed: recursive discovery of *undeclared* projects is exactly the "automatic package scanning" the requirements forbid. The principle-compliant enumeration already exists — `navigation-config.ts::preparedLifecycleProjectRoots`, which follows only declared `scope.exclude` relationships — and a failure-path hint adds nothing over it. The no-federation / no-auto-scan rule is honored by not scanning, not by scanning politely.

## Code and verification

- Root auto-prepare (retired): `src/core/navigation-setup-planner.ts::crgAction` no longer exists; the live owner is `index.ts::registerCandidateAnalysisLifecycle`.
- CRG-era regression names in `tests/v3-navigation-setup-planner.test.mjs` no longer exist; the file, `tests/v3-scope-planner.test.mjs`, `tests/v3-explore-scope.test.mjs`, and `tests/v3-navigation-clean.test.mjs` remain the owning suites.
- Live proof at the time (CRG-era): a no-query monorepo `session_start` prepare reported CRG `policy=auto scope=.` and built `.code-review-graph/graph.db`; `explore({view:"code", scope:<root>})` resolved symbols from every package through the single root graph (the same call returned `UNAVAILABLE` before the fix).