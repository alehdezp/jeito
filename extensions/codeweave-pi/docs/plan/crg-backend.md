---
title: "CRG corpus roots, ignore semantics, and nested project constraints"
description: "Verified CRG 2.3.7 admission, root-only custom ignore behavior, Git interaction, executed watcher behavior, observability gaps, and planned nested-project materialization."
tags: [jeito-codeweave-pi, crg, code-review-graph, ignore-policy, nested-projects]
created: 2026-07-27
updated: 2026-07-27
status: active
owns: "CRG-specific corpus construction facts, risks, and planned translation from navigation projects"
audience: contributor
code: [native/crg/code_review_graph/incremental.py::collect_all_files, native/crg/code_review_graph/incremental.py::_load_ignore_patterns, native/crg/code_review_graph/incremental.py::_should_ignore, native/crg/code_review_graph/incremental.py::watch, scripts/navigation-freshen.mjs::freshenArchitecture]
related: [docs/plan/README.md, docs/plan/adversarial-review-prompt.md, docs/plan/corpus-contract.md, docs/plan/evidence-ledger.md, docs/upstream/crg-official-docs-digest.md, docs/decisions/r5-crg-clean-break.md]
---

# CRG corpus roots, ignore semantics, and nested project constraints

## Planning status and backend identity

This document records current CRG behavior and planned nested-project integration. The shipped backend remains patched stock CRG 2.3.7 under the accepted delivery decision `docs/decisions/r5-crg-clean-break.md:r5-crg-clean-break-stock-plus-one-watchdaemon-patch/decision#2`. Nested corpus behavior is not implemented by this plan.

CRG’s prepared artifact is `<crg-root>/.code-review-graph/graph.db`. Public code search and structural relations call `scripts/crg-adapter.py` with one repository root. Native search has no complete path-restricted corpus/query mode; strict nested isolation therefore selects a separately constructed CRG root.

## Full-build candidate discovery

`native/crg/code_review_graph/incremental.py::collect_all_files` chooses candidates in this order:

1. Git/SVN tracked files when available.
2. Recursive filesystem files only when tracked discovery returns none.
3. CRG ignore matching.
4. Path-length, regular-file, symlink, supported-language, and binary checks.

Running `git ls-files` from a nested package inside a larger Git repository returns paths under that working directory. A nested package can therefore be a practical CRG root even without its own `.git`, provided setup intentionally selects it and owns its graph artifact there.

## Default CRG exclusions

`DEFAULT_IGNORE_PATTERNS` applies before user rules. Important categories include:

- `.code-review-graph`, `node_modules`, `.git`, `.svn`;
- Python caches and virtual environments;
- root `dist`, `build`, `.next`, `.nuxt`, `target`, `bin`, `obj`, coverage, and temporary output;
- any-depth `vendor`, `.bundle`, `.gradle`, `.dart_tool`, `.pub-cache`, and `cdk.out`;
- minified assets, source maps, lockfiles, databases, and SQLite journals.

The distinction between root-anchored and any-depth rules is intentional. `/build/**` excludes only the selected CRG root’s build directory, while `**/vendor/**` excludes vendor directories anywhere below it.

## Custom `.code-review-graphignore` behavior

Current CRG reads one user file:

```text
<selected-crg-root>/.code-review-graphignore
```

It does not walk ancestor or descendant directories for additional CRG ignore files. The accepted nested-navigation design adds one fixed generated source, `<selected-crg-root>/.pi/navigation/crg.ignore`, through the same parser; it does not change user-file hierarchy.

Pattern normalization supports:

- `vendor/` -> any-depth directory exclusion;
- `/generated/` -> root-anchored directory exclusion;
- `services/api/vendor/` -> explicit root-relative subtree;
- normal `fnmatch` file patterns such as `*.generated.ts`.

The implementation does not provide Graphify-style ordered negation/re-inclusion semantics. Generated navigation rules must therefore be additive exclusions only.

A disposable CRG 2.3.7 fixture established:

- parent-root build ignored the parent’s configured subtree;
- a child `.code-review-graphignore` did not affect the parent build;
- selecting the child as CRG root made the child ignore effective;
- default `node_modules` exclusion remained active.

Claim IDs and evidence grades are in `docs/plan/evidence-ledger.md:nested-navigation-evidence-ledger/crg-ignore-and-corpus-claims#2`.

## `.gitignore` behavior and tracked files

CRG does not use `.gitignore` as its general custom pattern file.

In a Git repository, `git ls-files` naturally omits untracked ignored files. A tracked file remains in `git ls-files` even if a later `.gitignore` rule matches it; CRG admitted such a force-added fixture file. Excluding tracked generated/source files requires the root `.code-review-graphignore`.

In filesystem fallback, `.gitignore` is not applied by `collect_all_files`. Non-Git projects therefore depend on CRG defaults and the root custom ignore.

## Watcher behavior and generated-policy experiment

The stock watcher recognizes several filenames, but only root `.code-review-graphignore` currently changes custom admission. Nested `.code-review-graphignore`, `.crgignore`, and some `.gitignore` events can trigger expensive no-effect full builds because `_rebuild_policy()` always reloads the selected root policy.

A disposable patch tested the narrower artifact-local design:

1. `_load_ignore_patterns(root)` read defaults, user `.code-review-graphignore`, then generated `.pi/navigation/crg.ignore` through the existing parser.
2. Parent preview admitted only `root.py`; direct child preview admitted only `child.py` under independent generated policies.
3. Removing the parent exclusion admitted child files; restoring it removed their existing SQLite nodes through `full_build()` stale reconciliation.
4. A second root with different generated policy remained isolated.
5. No configuration field, dependency, parser, environment override, daemon protocol, or global state was added.

Immediate rebuild on every watchdog event was correct but wasteful: three policy publications produced callback deltas `4,2,1` on macOS. A second probe sent policy events through CRG’s existing 300 ms debounce. Atomic replace, second replace, and delete then produced exactly `1,1,1` callbacks and the expected final corpus. One debounced full build supersedes pending per-file work.

`watch()` already accepts `on_files_updated`; `start_watch_thread()` still does not expose it. The experiment proves callback behavior when `watch()` is called with a receipt, not that the convenience API or full multi-repository daemon lifecycle is ready.

## Accepted navigation-project translation

For each prepared CRG project:

1. Compile normalized `scope.exclude` prefixes into anchored additive rules.
2. Atomically publish `<root>/.pi/navigation/crg.ignore`; never merge navigation policy into user `.code-review-graphignore`.
3. Load both files through the existing CRG parser, preserving defaults and user rules.
4. Route generated-policy create/modify/delete/move events through the existing watcher debounce before one `full_build()`.
5. Preview through `collect_all_files()` before build and record policy/backend/root/artifact identities.
6. Query only the project-local conventional `.code-review-graph/graph.db`.

The patch should remain in `native/crg/code_review_graph/incremental.py`. If implementation requires a new daemon protocol, global setting, or several CRG modules, stop and reconsider the CRG-only managed-block fallback.

## Read-only corpus preview requirement

CRG has no current public command dedicated to listing the exact admitted corpus without building. The smallest owned addition is a bounded adapter operation over `collect_all_files()` that returns:

- root-relative admitted paths or a digest plus bounded examples;
- counts by language/top-level root;
- default versus custom exclusion metadata;
- incomplete/error diagnostics;
- no graph/database writes and no embedding/provider calls.

Setup uses this preview before approval. Tests should compare preview admission with the files persisted by a subsequent disposable build.

## Executed stock-daemon multi-root ownership

A disposable daemon fixture configured two repositories through the real `python -m code_review_graph daemon` path. The first probe exposed a lifecycle distinction: `daemon-state.json` recorded two live child PIDs before either watchdog observer had logged `Watching`, so a policy publication at that point was missed. PID liveness is ownership evidence, not admission readiness.

The corrected probe waited for each per-repo log to report `Watching`. Both initial graphs excluded their own child corpus. Removing then restoring A’s generated policy admitted and pruned only A; each completed rebuild wrote A’s `.code-review-graph/embedding-refresh.json` with `ok:true`, while B’s receipt and graph remained unchanged. A normal B source save updated only B and wrote B’s `ok:true` receipt. SIGTERM terminated both children and removed daemon state.

The stock daemon launches the CLI `watch` command, which already passes `run_post_processing` into `watch(..., on_files_updated=...)`; it does not use callback-less `start_watch_thread()`. codeweave-pi should therefore retain stock daemon ownership and observe per-repo ready plus receipt state instead of starting another watcher.

## Remaining CRG gates

1. Land the generated-file and debounced-policy patch with focused durable tests.
2. Bind daemon configuration to nearest project-local roots without duplicating watcher ownership.
3. Verify submodule and linked-worktree candidate boundaries.
4. Bind generated-policy digest to prepared artifact state and fail unavailable on mismatch.

Graph search and trace must not proceed when project selection or policy identity is unverified; a successful CRG response can still be evidence from the wrong artifact.

## Completed architecture review

The independent review rejected a central catalog and proposed managed root ignore blocks. Follow-up execution retained its flat-prefix insight but selected generated artifact-local CRG policy because it avoids user-file merging and remained a bounded one-module seam. Evidence and limits are recorded in `docs/plan/evidence-ledger.md:nested-navigation-evidence-ledger/crg-ignore-and-corpus-claims#2`.
