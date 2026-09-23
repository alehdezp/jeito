---
title: "Graphify corpus hierarchy, ignore semantics, and multi-graph lifecycle"
description: "Verified Graphify 0.9.23 corpus isolation, native incremental deep maintenance, semantic-cache behavior, and remaining lifecycle delivery gates."
tags: [jeito-codeweave-pi, graphify, graphifyignore, multi-graph, lifecycle]
created: 2026-07-27
updated: 2026-07-28
status: active
owns: "Graphify-specific corpus construction facts, native lifecycle boundaries, and remaining multi-project delivery gates"
audience: contributor
code: [src/core/graphify-scope-policy.ts::planGraphifyScope, scripts/navigation-freshen.mjs::freshenGraph, scripts/navigation-freshen.mjs::reconcileGraphifyCorpusPolicy]
related: [docs/plan/README.md, docs/plan/adversarial-review-prompt.md, docs/plan/corpus-contract.md, docs/plan/evidence-ledger.md, docs/upstream/graphify-official-docs-digest.md, docs/automatic-workflow.md]
---

# Graphify corpus hierarchy, ignore semantics, and multi-graph lifecycle

## Planning status and backend identity

This document separates verified Graphify 0.9.23 corpus behavior from remaining delivery work. Each nearest `.pi-navigation.json` root now owns an isolated Graphify output, persisted exclusion policy, lock/cache namespace, and verified generation under `.pi/navigation/graphify`; public loaded multi-project delivery proof remains open.

Graphify query, path, and explain consume one supplied `graph.json`. They have no complete source-folder isolation mode after the graph is built. Strict project isolation therefore selects a graph constructed from that project’s corpus.

## Graphify discovery and hard pruning

Installed Graphify 0.9.23 discovers files with `graphify.detect.detect(root)`. Before type classification it hard-prunes common noise directories, including:

- `node_modules`, `.git`, virtual environments and `site-packages`;
- `dist`, `build`, `target`, `out`;
- language/framework caches such as `.next`, `.nuxt`, `.turbo`, `.terraform`, `.serverless`;
- test/coverage output and Graphify’s own output/cache directories.

Hard noise pruning is distinct from ignore rules and cannot be assumed reversible through negation. Graphify also records ignored, hard-pruned, sensitive, unclassified, and walk-error paths so partial or over-broad discovery can be diagnosed.

## Hierarchical `.gitignore` and `.graphifyignore`

Graphify’s ignore model is hierarchical:

1. Find the nearest VCS root above the selected scan root. Without VCS, the scan root is the ceiling.
2. Load Git `info/exclude` at the VCS root.
3. Load `.gitignore`, then `.graphifyignore`, from the VCS root down through the selected scan root.
4. While walking descendants, load each visited directory’s own `.gitignore` and `.graphifyignore` before pruning its children.
5. Append CLI `--exclude` patterns last, anchored at the selected scan root.

Rules carry the directory that owns them. An ignore file governs only paths beneath its own directory. Inner rules are later and use last-match-wins semantics. Git’s parent-exclusion rule still applies: a negation cannot re-include a file under an excluded parent directory.

`.graphifyignore` is loaded after `.gitignore` in the same directory. `--no-gitignore` disables `.gitignore` and Git `info/exclude` but keeps `.graphifyignore` active.

## Executed nested-ignore fixture

A disposable root/child fixture called installed `graphify.detect.detect` without extraction or providers. It proved:

- root `.gitignore` excluded its subtree;
- root `.graphifyignore` excluded its subtree;
- child `.gitignore` and `.graphifyignore` were honored during a parent-root scan;
- selecting the child as scan root still inherited applicable VCS-root rules;
- nested `node_modules` remained hard-pruned;
- disabling Git rules admitted Git-ignored files while Graphify-ignored files stayed excluded.

The claim matrix is `docs/plan/evidence-ledger.md:nested-navigation-evidence-ledger/graphify-ignore-and-corpus-claims#2`.

## Current integration and accepted artifact policy

`src/core/graphify-scope-policy.ts::planGraphifyScope` currently chooses one concrete extraction scope. `scripts/navigation-freshen.mjs::ensureGraphifyIgnoreDefaults` writes a marked defaults block to `.graphifyignore`; this is current behavior, not the accepted transport for nested-project exclusions.

Current output ownership is one graph slot per configuration root:

```text
<config-root>/.pi/navigation/graphify/graphify-out/graph.json
<config-root>/.pi/navigation/graphify/generations/<generation>/graph.json
```

For nested navigation, each project-local config owns its own output/verified generations. Canonical `scope.exclude` prefixes are passed as repeated native `--exclude` arguments. Installed Graphify persists these in output-owned `.graphify_build.json`, so later updates reuse the policy without editing `.graphifyignore` or adding a fork.

A disposable `extract <root> --code-only --exclude child --out <owned-output>` probe admitted only `a.py`, persisted `{"excludes":["child"]}`, and a later `update --force` kept `child/b.py` absent without provider work. A separate probe showed that parent `.graphifyignore` `child/` excludes the parent scan while a direct child-root scan still admits `child/child.py`; managed policy is technically viable, but native output-owned excludes have clearer ownership and cannot be overridden by later user-file ordering.

Accepted preparation sequence:

1. Select one project-local corpus root and output.
2. Pass normalized canonical prefixes as native `--exclude` values; never use `--no-gitignore`.
3. Preserve `.gitignore`, Git `info/exclude`, and user `.graphifyignore` as additive native policy.
4. Run read-only `detect()` preview and report native versus canonical exclusions separately.
5. Bind one project root/policy digest to one verified generation and query only that generation.

## Measured no-change and policy-change behavior

Disposable Graphify 0.9.23 fixtures exercised the same local command shape codeweave-pi uses: `update --force <root>` with clustering enabled.

- Initial two-node build: 0.23 seconds.
- Two unchanged updates: 0.14 and 0.15 seconds.
- Both unchanged updates reported no topology change and changed no file hash or modification time under `graphify-out`.
- The timing is illustrative, not a scalability claim: `update` still performs full detection and local AST extraction when no changed-path list is supplied.

An ignore-only fixture built `a.py` and `b.py`, then added `b.py` to `.graphifyignore`. The next update removed every `b.py` source node, proving that the installed stale-source reconciliation handles policy-only exclusion changes.

Deep/rich behavior is materially different. `scripts/navigation-freshen.mjs::freshenGraph` sets `GRAPHIFY_FORCE=1` for deep extraction. Installed Graphify then skips semantic cache reads. A controlled provider seam received one unchanged `README.md` dispatch on each of two consecutive deep runs: provider-call count advanced from one to two. No network request or provider payload was used.

## Multi-graph lifecycle decision

- Local code-only update is provider-free and preserves published outputs when topology is unchanged.
- Local update is not a constant-time manifest check; startup should still select projects by changed-path or corpus-policy evidence rather than scan every configured graph by default.
- Deep/rich update must require dirty project evidence or explicit preparation. Running it across unchanged projects would repeat provider work under the current forced mode.
- Ignore-policy identity must participate in dirty selection because exclusion-only changes correctly require a local rebuild and stale-node prune.

Native incremental deep extraction now reuses Graphify's semantic cache without `--force`; codeweave-pi still preserves and publishes an immutable last-good generation only after quality and query verification.

## Native Graphify lifecycle replaces the invalid custom helper

The retained Mac matrix proved the initial native `graphify extract --exclude` path but falsified the later custom lifecycle. Five child projects plus one parent were prepared; the parent deep graph initially contained only `src/fleet_root.py` and `docs/guide.md`, with all five exclusions persisted. On Pi stop, the former `scripts/graphify-rich-update.py` called Graphify `detect_incremental()` without the persisted excludes, detected 18 files, and published every child code/doc source into the parent while retaining the parent exclusion digest. A loaded parent map then returned a child source.

The helper is deleted. `scripts/navigation-freshen.mjs::freshenGraph` now invokes pinned Graphify 0.9.23 directly: `extract --mode deep` for semantic maintenance and `update --force` for local code-only maintenance. Repeated native deep extraction preserves persisted `.graphify_build.json` exclusions and uses Graphify's own incremental detection, semantic cache, `build_merge`, stale-source pruning, output-local lock, and manifest. A disposable DeepSeek fixture observed an unchanged second pass with `semantic cache: 2 hit / 0 miss`; after one document changed, the next pass reported `1 hit / 1 miss` and dispatched only that document. The provider response did not finish before the bounded probe was terminated, so this run proves cache selection and dispatch—not completion of that third publication.

The same matrix found a separate quality problem: MiniMax-M3 sometimes spent its output on reasoning and produced no Graphify JSON. codeweave-pi previously marked those partial graphs ready. Current candidate code fails closed on Graphify's definitive dispatched-file-missing warning; DeepSeek `deepseek-v4-flash` succeeded on the one-file retry for approximately $0.0004. Provider fallback remains explicit—never automatic.


## Explicit aggregate remains deferred

Graphify supports namespaced `merge-graphs` and a global graph. The installed implementation prefixes node identities to avoid same-name collisions. This is useful upstream capability, not an admitted codeweave-pi product behavior.

An aggregate graph would need explicit user ownership, independent freshness, provenance, and a clear relation to CRG/QMD projects. It must not be silently queried when a normal project is selected.

## Executed concurrent project-local output isolation

A disposable two-root fixture launched two `extract --code-only --no-cluster` processes concurrently, each with 121 admitted sources and its own output root. Both exited successfully. Their graphs contained only A or B source identities and their `.graphify_build.json` files retained independent exclusions.

Two concurrent `update --force --no-cluster` processes then used distinct absolute `GRAPHIFY_OUT` values. Each output’s `.rebuild.lock` was observed while active and absent after completion. New A/B sources remained isolated. Replacing only A’s persisted policy with `excludedA` plus `pruneMe` removed A’s `pruneMe/prune.py`; B retained its copy and original `excludedB` policy. Provider keys were removed from the child environment. The fixture was deleted.

This proves Graphify's backend output, config, cache, and lock primitive. codeweave-pi now binds the absolute project-owned output to each nearest configuration root and uses the same path for extraction, update, verification, and generation publication; loaded delivery proof remains separate.

## Remaining Graphify gates

1. Re-run dirty parent/child stop-refresh from a loaded installed extension and verify both awaited audit completions plus scoped map results.
2. Verify cross-platform path anchoring and VCS ceilings in nested worktrees/submodules.
3. Re-run the parent-excludes-child loaded map journey from the installable artifact, including policy-only removal, retry, and rollback.
4. Certify one Graphify-supported semantic provider for the release journey; MiniMax-M3 remains rejected for Graphify 0.9.23 because its incomplete JSON fails closed.

The architecture review ruled out managed navigation blocks for child exclusions because native persisted `--exclude` already owns the artifact policy. Existing defaults-block behavior is a separate current compatibility concern and should be removed or retained only on its own evidence, not expanded for nested-project transport.
