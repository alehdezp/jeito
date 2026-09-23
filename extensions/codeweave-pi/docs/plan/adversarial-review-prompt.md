---
title: "Adversarial review prompt for nested navigation projects"
description: "Completed independent-review mandate that produced the nearest-boundary and artifact-local nested-navigation architecture."
tags: [jeito-codeweave-pi, adversarial-review, nested-projects, portability, installation, verification]
created: 2026-07-27
updated: 2026-07-27
status: completed
owns: "The completed independent review mandate, evidence protocol, experiments, and deliverable format that selected the current nested-navigation architecture"
audience: contributor
code: [src/core/navigation-config.ts::resolvePreparedLane, src/core/navigation-desired-state.ts::compileNavigationDesiredState, src/core/project-root.ts::detectProjectRoot, scripts/navigation-freshen.mjs::freshenGraph]
related: [docs/plan/README.md, docs/plan/corpus-contract.md, docs/plan/evidence-ledger.md, docs/plan/crg-backend.md, docs/plan/graphify-backend.md, docs/plan/qmd-backend.md, docs/plan/implementation.md]
---
# Adversarial review prompt for nested navigation projects

## Outcome: completed review gate

This prompt was executed in a fresh session. The review rejected the proposed central project catalog and favored project-local boundaries plus parent exclusions. Follow-up Graphify and CRG experiments then narrowed its managed-native-file recommendation to artifact-local policy: persisted Graphify `--exclude`, generated `.pi/navigation/crg.ignore`, and direct QMD admission filtering. Current decisions live in `docs/plan/corpus-contract.md:prepared-corpus-and-navigation-project-contract#1`; executed evidence lives in `docs/plan/evidence-ledger.md:nested-navigation-evidence-ledger#1`. Do not rerun this gate unless new evidence violates that model.
## Copy this entire prompt into a fresh agent session
You are the independent senior reviewer for jeito codeweave-pi’s proposed nested-navigation architecture. Do not endorse the existing plan, polish its prose, or implement the first plausible design. Determine whether the proposal is correct, minimal, maintainable, installable, portable, observable, and aligned across source code, configuration, setup skills, package lifecycle, documentation, tests, and loaded Pi behavior.
Treat every planning claim as a hypothesis and every prior experiment as bounded evidence. Challenge the central model. If a simpler design satisfies the objective, recommend it. If a backend already provides a reliable primitive, prove it and remove custom machinery. If the plan fails across arbitrary folders, nested Git repositories, non-Git roots, relocated checkouts, or supported installation modes, say so directly.
Do not implement product code during this review. Use disposable fixtures and read-only inspection. Never mutate real user indexes, provider configuration, package registration, host defaults, API credentials, or existing project artifacts.
## Objective to preserve
Design the simplest reliable way for `explore(view:"code")`, `explore(view:"map")`, prepared `trace`, and `docs_search` to select exactly one prepared project corpus from:
- a repository root;
- an independent nested project or package;
- a monorepo containing related and unrelated packages;
- a nested Git repository, worktree, or submodule;
- a non-Git directory with package markers;
- an explicit absolute path outside the current session project;
- a checkout moved to a different absolute path or another supported computer.
Prevent evidence leakage between independent projects, preserve useful cross-package relationships inside intentionally shared projects, keep query time read-only, and avoid automatic one-index-per-folder sprawl.
## Current proposal you must challenge
The plan currently proposes:
1. A navigation project is one prepared corpus plus backend artifacts, not a result filter.
2. The shared corpus shape begins with one root plus excluded subtrees.
3. Independent children own separate CRG, Graphify, and QMD artifacts.
4. Parent corpora exclude independent children before indexing.
5. One public call selects one project and one backend artifact.
6. Other configured projects may be listed as not searched but are never queried implicitly.
7. Selection uses explicit scope and the longest verified owning project boundary.
8. Query time never indexes, repairs, downloads, installs, embeds corpora, or performs provider-backed preparation.
9. Changed paths are grouped by owning project before lifecycle refresh.
10. Setup presents candidate boundaries and lets the user approve hierarchy and backend work.
Do not assume these points are all necessary or jointly sufficient.
## Known defect that must reproduce
`src/core/navigation-config.ts::resolvePreparedLane` walks ancestor `.pi-navigation.json` files and accepts the first enabled lane without proving ownership of the requested scope. The known failure selected a stale unrelated ancestor architecture lane for an explicit codeweave-pi scope.
Reproduce this with a disposable chain or pure direct call. Capture requested scope, candidate config/state roots, selected lane/artifact, applicability reason, explicit-disable semantics, and expected fail-closed behavior. A successful backend response is not proof of correct project selection.
## Required planning and current-authority reads
Read completely:
- `docs/plan/README.md`
- `docs/plan/corpus-contract.md`
- `docs/plan/evidence-ledger.md`
- `docs/plan/crg-backend.md`
- `docs/plan/graphify-backend.md`
- `docs/plan/qmd-backend.md`
- `docs/plan/implementation.md`
Then inspect current authority and contradictions:
- `docs/current-truth.md`, `docs/harness-doctrine.md`, `docs/evidence.md`, `docs/automatic-workflow.md`
- `docs/setup.md`, `docs/management.md`, `docs/decisions/README.md`, `docs/decisions/r5-crg-clean-break.md`
- `extensions/codeweave-pi/AGENTS.md` and repository-root `AGENTS.md`
Planning prose never overrides current source or current authority.
## Package and installation evidence
Inspect:
- root `package.json`, `README.md`, installation tests, and `.agents/skills/jeito-setup/SKILL.md`;
- `extensions/codeweave-pi/package.json`, `README.md`, `scripts/install-from-checkout.mjs`, and `scripts/validate-release.mjs`;
- Pi manifests, npm lifecycle scripts, generated runtime ownership, platform constraints, and duplicate-resource prevention.
Verify local-path npm preparation precedes Pi registration; managed Git may let Pi own npm. Never propose aggregate plus contained duplicate registration, global backend installs, PATH fallback, startup repair, or host-specific paths in portable config.
## Setup and onboarding contracts
Inspect:
- `skills/navigation-setup/SKILL.md`, `skills/navigation-debug/SKILL.md`, `skills/deep-navigation-onboard/SKILL.md`;
- `src/core/navigation-setup-planner.ts`, `navigation-preflight.ts`, `scope-planner.ts`;
- `scripts/navigation-doctor.mjs`, `navigation-prepare.mjs`, `navigation-freshen.mjs`, `navigation-audit.mjs`.
Compare documented commands, flags, writes, approval levels, provider/privacy behavior, undo, and readiness gates with actual code and tests. Record every disagreement; do not silently choose one authority.
## Query, configuration, and lifecycle owners
Inspect:
- `src/core/navigation-config.ts`, `project-root.ts`, `navigation-desired-state.ts`;
- `prepared-mutation.ts`, `qmd-docs-refresh.ts`, `qmd-docs-search.ts`, `graphify-scope-policy.ts`;
- `src/tools/explore.ts`, `trace.ts`, `docs-search.ts`, and `index.ts`.
Use prepared code search/traversal only after confirming it selected this project. If it routes to the stale ancestor, record the failure and use exact source evidence. Separate grep hits do not prove topology.
## Configuration alternatives to compare
Compare at least:
A. One root `.pi-navigation.json` containing a project catalog.
B. One `.pi-navigation.json` per independent project, discovered by boundaries.
C. Project-local ownership plus explicit parent child-exclusion references.
D. A materially simpler alternative derived from backend primitives.
For every alternative evaluate:
- root, nested, sibling, shared-root, and external-path selection;
- parent knowledge required to exclude independent children;
- portability after relocation and across supported hosts;
- duplicate names, stable identity, and artifact collisions;
- explicit disablement, omitted lanes, malformed configs, and partial state;
- symlink, `..`, case-folding, realpath, escape, nested Git, worktree, submodule, and non-Git behavior;
- config/state/artifact/lock locations and schema versioning;
- backward compatibility with top-level `architecture`, `docs`, and `graph` fields;
- `compileNavigationDesiredState`, `rootIdentity`, `scopeDigest`, generation identity, migration, and rollback;
- necessity of a public `project` parameter.
The current local config may contain only docs. Explain how each viable design prevents omitted architecture/graph lanes from inheriting an unrelated ancestor.
## Shared corpus-model challenge
Determine whether `root + excluded subtrees` is sufficient. Test shared root files, related packages intentionally kept together, child add/remove/rename/disable, generated outputs, symlinks, newly created siblings, and parent exclusion drift. Reject arbitrary pattern languages unless all backends can translate them safely.
A corpus preview must use each backend’s real admission logic, expose incompleteness, avoid artifact/provider mutation, and bind backend version plus translated policy. Explain time-of-check/time-of-build drift and whether preview-to-build mismatch fails, retries, or is reported.
## CRG review
Verify bundled patched CRG 2.3.7 rather than a global install:
- tracked and non-Git fallback enumeration;
- default ignores and selected-root-only `.code-review-graphignore`;
- lack of hierarchical nested CRG ignore semantics and ordered negation;
- graph DB path, daemon/multi-repository ownership, nested roots without nested `.git`;
- watcher triggers, completion observability, tracked files later matched by `.gitignore`;
- submodules, worktrees, symlinks, unsupported files, binary checks;
- pure `collect_all_files()` preview without graph/provider writes;
- managed root ignore block versus any safe ephemeral exclusion mechanism.
Resolve the contradiction: `navigation-setup` claims a managed CRG block, while current freshen code has no writer. Name every code, skill, test, and doc that must change together.
## Graphify review
Verify extension-local Graphify 0.9.23:
- VCS ceiling; hierarchical `.gitignore`, `info/exclude`, `.graphifyignore`, descendant loading, last-match-wins, hard pruning, and `--no-gitignore`;
- persisted `--exclude`, policy-only stale-node pruning, source manifests, locks, caches, working output, verified generations;
- isolation across multiple projects and last-good behavior during failed replacement;
- representative unchanged local `update --force` cost without extrapolating tiny timings;
- forced deep/rich provider dispatch on unchanged semantic files;
- safety of removing `GRAPHIFY_FORCE` versus stale/partial semantic evidence;
- whether namespaced `merge-graphs` simplifies an explicit aggregate without contaminating normal project queries.
Measure only when a result changes lifecycle policy.
## QMD and pi-nav review
Verify the combined path:
- outer Git root versus nested project root;
- `.pi/navigation/ignore` replacing Git sources and nested custom-ignore behavior without nested `.git`;
- dependency/cache Markdown admission and hard safety exclusions;
- canonical exclusions before section projection and stale document/section/vector deletion;
- logical repo/database identity, collision behavior, transactions, locks, health, providers, and vector generations;
- shared local models versus isolated project indexes;
- lexical/semantic readiness and query-time prohibition on sync, download, build, repair, or corpus embedding;
- candidate-window saturation before current `path`/`glob` filtering.
Run one deterministic more-than-40-distractor experiment comparing broad post-filtering with independent-project selection. State what it proves and does not prove.
## Public tool contract review
For `explore`, prepared `trace`, and `docs_search`, inspect schemas and loaded behavior. Compare scope-only selection, logical `project` plus scope, a shared selector object, and any smaller contract.
Require:
- exactly one project/backend invocation per call;
- project/scope disagreement fails closed;
- selected project, scope, corpus root, artifact, generation, and freshness are visible;
- alternatives are configured and explicitly not searched;
- no claims about matches in unqueried projects;
- pagination retains project/artifact/generation identity;
- external scopes ignore unrelated current-session config;
- unavailable results give one precise setup action;
- query time remains mutation-free.
Exercise stale ancestor, missing artifact, malformed config, duplicate identity, moved checkout, disabled lane, and degraded provider—not only success.
## Mutation and lifecycle review
Trace edit/write notifications through prepared mutation, QMD, CRG, and Graphify. Prove:
- ownership derives from every changed path, not session `cwd`;
- one multi-file edit can form multiple project groups;
- root files are not assigned to the active child;
- external paths target only their external project;
- queues, transactions, retries, locks, dirty state, and shutdown waits are project-keyed;
- disabled/clean projects cause no provider work;
- corpus-policy changes dirty the correct parent/child;
- startup enumerates configured projects only, not package markers;
- rich Graphify work remains guided and provider-visible;
- CRG watcher events are not treated as corpus-policy proof;
- failures preserve last-good artifacts and avoid partial catalog cutover.
Challenge whether every lane needs startup refresh. Prefer changed-path/policy evidence when equally correct.
## Installation and folder portability review
Evaluate:
1. Managed aggregate Git at an immutable ref.
2. Editable aggregate local checkout.
3. Root-selective codeweave-pi workspace.
4. codeweave-pi extension-root local install.
5. Project-local registration from a separate consumer project.
6. Moved/replaced installation with explicit old-source approval.
7. Darwin arm64 and Linux arm64 supported runtime matrices.
8. Unsupported platforms failing clearly before partial registration.
Prove project config contains logical identities and relative paths only. Extension runtime commands must derive from the currently loaded extension. Host canonical paths and generations belong only to local state. Moving the project or extension must produce explicit stale-state diagnosis and safe regeneration, not accidental ancestor fallback.
## Navigation setup UX review
Require doctor, dry-run prepare, and audit to prove resolved root, hierarchy, corpus preview, artifacts, writes, provider/privacy effects, locks, quality, and undo before mutation.
Candidate boundaries are suggestions. The user may keep one broad project or approve independent children. Declined projects are healthy and silent.
`.pi/navigation/ignore` remains user-controlled exact-tool policy. The review originally required managed native ignore changes to preserve and back up user content; later execution removed that mutation from the accepted design. Setup now previews generated CRG state and native Graphify/QMD arguments, while destructive migration still quarantines before deletion and old artifacts survive until isolated preparation, loaded cutover, and rollback succeed.
## Required bounded experiments
Use one reusable temporary root/A/B fixture where possible. Delete it afterward. Run only probes that distinguish designs:
1. Stale ancestor reproduction and fail-closed resolver.
2. Root/A/B duplicate-symbol and duplicate-doc corpus previews.
3. CRG parent versus selected-child admission parity.
4. Graphify parent/child translation and policy-only prune.
5. QMD exclusion/stale deletion and >40 distractors.
6. Multi-file changed-path ownership grouping.
7. Relocated fixture config reload without edits.
8. Different extension install path without persisted runtime path.
9. Loaded one-project query spy proving one backend invocation.
10. Single-lane migration dry-run and rollback without deletion.
Do not create a giant matrix. A probe matters only if it can choose, constrain, replan, reframe, or reject a design.
## Adversarial questions
Answer directly:
- Is a catalog needed, or are project-local configs plus parent exclusions smaller?
- Does longest-path ownership fail for shared files, symlinks, generated files, or nested Git?
- What happens when a child is added, removed, renamed, disabled, or malformed?
- What prevents two projects sharing one artifact or QMD repo identity?
- What prevents moved-checkout stale state from appearing healthy?
- Does root-plus-excludes preserve intentionally shared cross-package edges?
- Can alternative-project metadata leak private paths or imply unsearched relevance?
- Can setup preview exact admission without building the artifact?
- What happens if files change between preview and build?
- Which multi-file config/catalog writes can partially land?
- How are locks/retries recovered after process death?
- Is configured provider quality preserved exactly?
- Is every new abstraction needed by at least three real consumers?
- Can uninstall leave project-owned indexes safely untouched?
- Which current docs, skills, tests, and examples become stale at landing?
## Evidence and honesty rules
Label consequential claims **Observed**, **Inferred**, or **Unobserved**. For mismatches record:
```text
Expected:
Observed:
Violated premise:
Decision consequence:
```
Do not upgrade repository silence to proof. Do not cite a test without reading its assertion. Do not claim cross-platform portability from macOS. Do not claim installation readiness from imports. Do not weaken tests to fit the plan.
## Required final deliverable
Return one self-contained review with:
1. Executive verdict: adopt, revise, reframe, or reject.
2. Simplest recommended architecture and end-to-end flow.
3. Alternatives ruled in/out with evidence and maintenance/installability trade-offs.
4. Plan-versus-code/config/skill/doc/test/install contradictions.
5. Separate CRG, Graphify, and QMD/pi-nav findings.
6. Exact public selection contract and fail-closed diagnostics.
7. Versioned portable config/local-state schema with example.
8. Installation matrix, generated state, verification, rollback, unsupported targets.
9. Setup/migration UX and deletion boundary.
10. Lifecycle ownership, dirty policy, provider gates, concurrency, shutdown, last-good behavior.
11. Experiment ledger: probe, result, scope, proof, limit.
12. Small implementation increments with falsifiable gates.
13. Focused test strategy, loaded-tool proof, and release boundary.
14. Every code/config/skill/doc/test/package artifact that must change together.
15. Remaining unknowns and one decision gate.
Your verdict must be independent. Agreement earns no credit. Prefer a smaller maintainable alternative. If this plan is already minimal, prove why each simpler alternative fails.