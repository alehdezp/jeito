---
title: "Nested navigation delivery plan"
description: "Implementation-ready sequence for corpus preview, project selection, backend materialization, lifecycle routing, setup UX, migration, and loaded-tool verification."
tags: [jeito-codeweave-pi, implementation-plan, nested-projects, migration, verification]
created: 2026-07-27
updated: 2026-07-27
status: active
owns: "The delivery sequence, evidence gates, dependencies, risks, rollout, and first executable commitment for nested navigation"
audience: contributor
code: [src/core/navigation-config.ts::resolvePreparedLane, src/core/scope-planner.ts::planNavigationScope, scripts/navigation-prepare.mjs, scripts/navigation-freshen.mjs, src/core/prepared-mutation.ts::notifyPreparedMutation]
related: [docs/plan/README.md, docs/plan/adversarial-review-prompt.md, docs/plan/corpus-contract.md, docs/plan/evidence-ledger.md, docs/plan/crg-backend.md, docs/plan/graphify-backend.md, docs/plan/qmd-backend.md]
---

# Nested navigation delivery plan

## Outcome, constraints, and delivery strategy

Deliver user-configured navigation projects whose CRG, Graphify, and QMD artifacts contain only their declared corpus, resolve deterministically from root/nested/external paths, remain read-only at query time, and refresh according to changed-path ownership.

The delivery strategy follows the settled nearest-boundary and artifact-policy model:

1. fix fail-closed nearest-config selection;
2. compile and preview one flat `scope.exclude` policy;
3. integrate artifact-local adapters—generated CRG file, native Graphify excludes, direct QMD filtering;
4. route lifecycle by changed-path ownership and policy identity;
5. expose setup/migration only after loaded one-project queries prove isolation.

Do not build a catalog, public project selector, automatic package scan, universal ignore grammar, or user-file merge subsystem.

## Starting state that implementation must preserve

- Existing scope/preflight/setup planning has 37/37 focused tests passing.
- Query time does not build, index, repair, download, or perform preparation provider work.
- CRG remains stock 2.3.7 plus the accepted bounded patch and conventional `.code-review-graph/graph.db` ownership.
- Graphify last-good generation behavior remains available during refresh failure.
- QMD remains the sole docs retrieval index and pi-nav remains the sole live Markdown parser.
- Existing user-owned artifacts are preserved until replacement project artifacts pass verification.
- Public tool names and current exact-tool behavior remain unchanged.

The current working tree already contains unrelated documentation/source changes. Implementation must select only nested-navigation-owned files and preserve those changes.

## Load-bearing uncertainties after the architecture experiment

| Uncertainty | Why it can change implementation | Required discriminator |
|---|---|---|
| QMD stale document/vector deletion | Determines whether exclusion-only policy changes can publish safely | Full sync with a previously indexed subtree becoming excluded |
| Project-local artifact layout | Controls coexistence, locks, rollback, and relocation | Root/A/B disposable preparation with concurrent local refresh |
| Graphify forced rich refresh | Unchanged semantic corpora repeat provider dispatch | Require dirty-policy/path evidence or explicit preparation |
| Distributed cutover | Parent config, child config, and artifacts cannot switch atomically | Policy-digest mismatch must fail unavailable through staged activation/rollback |

Plan later increments only through the next unresolved gate.

## Increment 1: pure corpus plan and admitted-file preview

**Outcome:** setup and tests can describe what each backend would admit without creating indexes or calling providers.

Work:

- Define a restricted canonical corpus value: one root plus excluded subtrees.
- Normalize relative paths, reject escapes/symlink boundary violations, and detect overlapping independent projects.
- Add backend preview adapters:
  - CRG `collect_all_files` read-only listing/digest;
  - Graphify `detect()` structured summary;
  - QMD pi-nav Markdown enumeration plus canonical exclusions.
- Report backend-native user policy sources separately from generated canonical exclusions.
- Produce one corpus-policy identity per canonical config root/backend/version.

Proof:

- Root plus two child fixture with duplicate symbols/docs.
- Native ignored, generated noise, symlink, malformed policy, and incomplete enumeration cases.
- Preview performs zero index writes and provider calls.
- Subsequent disposable preparation admits the same source set or reports an explained backend transformation.

Do not broaden the accepted root-plus-prefix model to arbitrary globs without new contradictory evidence.

## Increment 2: nearest-boundary selection correctness

**Outcome:** every prepared call selects the nearest valid project-local config and one matching artifact, or fails closed before backend execution.

Work:

- Stop `resolvePreparedLane` at the nearest `.pi-navigation.json`; omitted/disabled lanes return unavailable.
- Canonicalize explicit absolute targets without consulting unrelated current-project/home configuration.
- Treat exact `scope.exclude` children as alternatives only when they have valid project-local config and prepared lane.
- Report requested scope, selected config root, corpus root, artifact, policy digest, and generation identity.
- Keep the public contract scope-only; add no project ID or selector.

**Status:** canonical nearest-boundary selection and fail-closed policy identity are focused-source verified on 2026-07-27. Review found and fixed lexical-parent leakage through external symlinks plus missing-digest acceptance. Complete result-envelope reporting, backend adapters, and loaded multi-project routing remain open.

Proof status:

- Passed: stale ancestors, canonical root/child A/B/external selection, excluded unowned paths, malformed child config, and external prepared/unprepared symlink targets.
- Passed: missing or mismatched policy identity fails unavailable before backend execution.
- Open: a loaded public-call backend spy proving exactly one invocation per request.

## Increment 3: artifact-local backend policy and coexistence

### CRG

- Add generated `.pi/navigation/crg.ignore` to the existing parser stack after user policy.
- Route generated-policy events through the existing 300 ms debounce; one policy rebuild supersedes pending file updates.
- Publish rules atomically and bind their digest to project-local graph state.
- Keep `.code-review-graphignore` user-owned and conventional graph DB paths project-local.

### Graphify

- Pass canonical prefixes through repeated native `--exclude`; persist them in output-owned `.graphify_build.json`.
- Store one working area and immutable verified generations per project-local config.
- Preserve Git/Graphify user policy and bind query/path/explain to one verified generation.
- Gate deep/rich work by dirty project evidence or explicit preparation.

### QMD

- Apply canonical prefixes between pi-nav discovery and section projection.
- Allocate one database, lock, transaction, generation, and health identity per project-local config.
- Remove stale documents/vectors when files leave the admitted corpus.
- Preserve exact-tool ignore policy independently.

Proof for every backend:

- Parent artifact excludes both child corpora; child artifacts contain their sentinels.
- Policy-only changes remove stale evidence.
- One child cannot mutate another project’s artifact or lock.
- Configuration remains relocation-safe and policy-digest mismatch returns unavailable.

## Increment 4: path-owned mutation and lifecycle routing

**Outcome:** changes refresh the owning project regardless of session working directory.

Work:

- Resolve each changed path to one project.
- Group paths by project before CRG, QMD, and Graphify scheduling.
- Key queues, transactions, dirty state, retry/backoff, and shutdown waiting by project identity.
- Enumerate only configured projects at session lifecycle checkpoints.
- Skip disabled, unchanged, or policy-clean projects without provider work.

Proof:

- Root session edits child A and refreshes only child A.
- One multi-file edit spanning root/A/B creates three bounded ownership groups.
- External absolute-path edit targets the external project only.
- Shutdown waits for all started project work and leaves no process/lock orphan.

## Increment 5: navigation setup hierarchy UX

**Outcome:** user chooses independent projects from one preview and receives exact writes, costs, privacy, verification, and undo.

Setup must:

- start from the nearest boundary and inspect only exact `scope.exclude` child directories;
- default to one root project unless the user explicitly creates an independent child config;
- show admitted files, artifact-local generated state, provider/privacy effects, staging order, and rollback;
- write complete lane declarations so omitted lanes cannot inherit;
- publish generated CRG policy atomically and pass Graphify/QMD policy without editing their user ignore files;
- never register aggregate and child resources twice.

A declined child project or ordinary excluded subtree is healthy and produces no startup warning.

## Migration and rollback

1. Diagnose current single-lane config/state and stale ancestor configurations.
2. Dry-run nearest-boundary and `scope.exclude` interpretation without writes.
3. Stage and verify the child config/artifacts while the parent remains authoritative.
4. Write parent exclusion and publish a matching parent generation.
5. Activate child selection only after both policy identities match.
6. Preserve old config/state references and artifacts until loaded queries and rollback pass.

Rollback restores previous references and leaves caches intact. Parent/config/artifact publication is multi-file, so correctness comes from policy identity: any mismatch is unavailable, never fallback evidence.

## Risk and premortem

| Failure | Prevention / signal |
|---|---|
| Parent and child both admit the same files | Preview/build parity and duplicate-sentinel fixture |
| Plausible wrong ancestor evidence | Stop at nearest config; selected root/policy identity in every result |
| CRG watcher rebuild storm | Generated-policy events use existing debounce; callback-count regression |
| Graphify user rules override navigation policy | Native `--exclude` appended last and persisted with the artifact |
| QMD exclusion leaves stale vectors | Full reconciliation deletion gate blocks publication |
| Partial cutover exposes mismatched corpus | Config/artifact policy digest mismatch returns unavailable |
| Startup repeats provider work | Dirty/policy gates; explicit preparation for rich Graphify |
| Absolute paths break relocation | Move-fixture configuration reload and local-state rebinding |
| Multi-file edit refreshes wrong project | Nearest-boundary grouping independent of session cwd |

## Release and migration gates

Focused acceptance must include:

- CRG generated-policy loading, stale prune, debounced callback count, daemon ready/receipt ownership, and shutdown;
- nearest-boundary and stale-ancestor regression;
- CRG generated-policy loading, stale prune, debounced callback count, and daemon ownership;
- Graphify persisted excludes, output isolation, unchanged local preservation, and forced-rich gating;
- QMD custom-override/noise/candidate-saturation/stale-vector deletion;
- root/child/external loaded `explore`, `trace`, and `docs_search` calls;
- path-owned edit/write refresh and shutdown;
- relocated checkout portability;
- setup dry-run, staged activation, rollback, and no-duplicate-resource checks.

A focused pass proves nested-navigation behavior only. Package/platform/release readiness remains a separate boundary.

## Execution control and documentation stewardship

After each increment:

1. update claim grades in `docs/plan/evidence-ledger.md:nested-navigation-evidence-ledger#1`;
2. revise dependent plan sections only when evidence changes them;
3. move implemented behavior to current authority immediately;
4. record a settled decision only when rejected alternatives matter;
5. stop if repeated observations add detail without changing corpus, selection, lifecycle, or migration decisions.

## Completed architecture gate

The independent review ran and rejected the catalog. Follow-up Graphify and CRG experiments replaced its managed-native-file recommendation with artifact-local policy. CRG static admission, parent/child isolation, stale prune, two-root isolation, and debounced watcher receipts passed in disposable fixtures; project source was not changed by those probes.

## First executable commitment

Implement Increment 1’s pure normalized prefix compiler and admitted-corpus preview, then the fail-closed nearest-boundary resolver. Do not land backend materialization until preview identities can be bound to config state.

Completion condition:

- deterministic root/A/B previews for CRG, Graphify, and QMD;
- no index/provider/user-ignore mutation during preview;
- preview-to-disposable-build parity;
- nearest boundary stops lane inheritance;
- no public tool schema change.

After that checkpoint, land backend adapters one at a time. A CRG patch that escapes `incremental.py` into new daemon/config machinery is a replan signal, not permission to keep expanding.
