---
title: "Decision: R5 CRG clean break — stock plus one watch/daemon patch"
description: "Historical reasons for the superseded CRG stock-plus-patch delivery contract; complete retirement now governs."
tags: [jeito-codeweave-pi, decision, crg, release-runtime, patch, lifecycle]
created: 2026-07-25
updated: 2026-09-21
status: superseded
decided: 2026-07-25
owns: "Historical rationale for the retired R5 CRG delivery contract"
audience: contributor
related: [docs/current-truth.md, docs/automatic-workflow.md, docs/upstream/crg-official-docs-digest.md, docs/setup.md]
---

# R5 CRG clean break: stock plus one watch/daemon patch

Status: **superseded by complete CRG retirement**. This is a historical record, not runtime or installation guidance. Core's CodeGraph-derived maintenance and self-contained delivery replace CRG; [current truth](../current-truth.md) and [setup](../setup.md) govern current behavior. Historical source paths and test receipts below describe the former implementation, not retained files or present readiness.

## Context

CRG (code-review-graph) supplies code topology and relationships. The prior candidate forked CRG and layered an exact graph/embedding revision protocol, all-node semantic admission, orphan-vector release gates, immutable graph generations, and a custom Python distribution with per-minor dependency locks and bundled wheels. That design predicted that replacing upstream installation behavior would make a two-backend release more reliable.

## Decision

Ship CRG as **pristine stock `v2.3.7` (commit `6a1ee1c7063cc35cfa5ff12b8198c29360f3e4ad`) plus at most one small upstreamable patch** for directly reproduced watch/daemon defects, installed through one extension-local normal-pip runtime.

- npm `postinstall` creates one ignored `.runtime` venv inside the installed extension clone and uses normal pip to install local patched CRG plus exact `graphifyy[openai]==0.9.23`. No external runtime state, per-minor locks, or wheel fork.
- One stock daemon owns `.code-review-graph/graph.db`, provider/model propagation, build→embed, cache health recovery, atomic config, move/delete/ignore convergence, retry, and orphan cleanup.
- Pi startup checks only the `.ready` sentinel and extension-relative executables; it never provisions. `/navigation-setup` is informational.
- Extension mutations coalesce stock incremental `update`; the stock watcher remains the external-save owner.
These were the former lifecycle mechanics. The replacement is described by [Core lifecycle](../automatic-workflow.md#core) and [Core setup](../setup.md#core-code-navigation-and-local-semantics); those pages do not certify the historical CRG behavior above.

## Why upstream installation had to stay the baseline

The custom-distribution fork produced multi-hour validation, repeated large dependency installs, a Darwin Python 3.14 rejection absent from normal CRG installation, and substantially more failure surface than the behavior patch itself. Direct CPython 3.14 installation of `./native/crg[communities,google-embeddings]` and `graphifyy[openai]==0.9.23` together succeeded in one ordinary venv (129 distributions, no conflict) in 41 seconds with a warm cache; Python 3.10–3.13 each resolved in 12–16 seconds. Pi's package manager clones the full Git ref before `npm install --omit=dev`, so the local CRG source path is available during real installation. The simpler path was strictly more reliable, so the heavier machinery lost.

## Rejected machinery (do not resurrect)

- Exact graph/embedding revision protocols and all-node semantic admission.
- Lane failure for one stale vector and orphan-vector release gates.
- Query-time mutation prohibition for a rebuildable local cache.
- Immutable graph generations and last-good publication.
- Custom exact-path reconciliation, source policy, or graph leases.
- Automatic patch-rebase machinery.
- Alternate databases, `data_dir`, `.pi/navigation/crg`, and TypeScript SQL repair.
- Large Python-in-JavaScript wrappers and internal tests that validate machinery instead of agent behavior.

CRG is a **rebuildable navigation cache**: preserve the current DB on ordinary failure and rebuild missing/empty/corrupt state through the sole stock lifecycle owner.

## Neutral evidence that bounded the patch

Pristine stock reconstructed outside the fork showed: explicit `embed` initializes vectors (build flags alone do not); stock `update` was genuinely incremental and invoked the provider; watch handled normal create/modify and refreshed embeddings; but atomic replace, rename-destination and ignore-policy reconciliation failed, delete removed graph rows without purging vectors, daemon config did not carry provider/model, an empty DB stayed empty on daemon start, concurrent registration corrupted `watch.toml`, and daemon-parent death left an orphan watcher. These reproduced defects admit one micro-patch; they do not admit query, readiness, reconciliation, or generation frameworks.

## Hard budgets

micro-patch ≤350 net production lines; public adapter ≤300; CRG lifecycle owner ≤200; mutation queue ≤80; total new production ≤1,000; production deletion ≥1,500; one installed-runtime lifecycle test ≤400; tests must not grow faster than production. A breach stops implementation for renewed approval.

## Completion evidence

Pi 0.82.1 pinned Git lifecycle passed in 131.6 s; real Pi RPC startup added 68.7 ms p95 over the disabled baseline; Darwin/Linux arm64 Python 3.10–3.14 passed; installed public `explore`, `trace`, Graphify path, and exact-tool probes passed; the full release gate finished in 8.3 minutes.

## Code and verification

- Runtime manifest binding the stock commit and patch: `native/crg/jeito-codeweave-pi-runtime.json`.
- Public adapter and launcher: `scripts/crg-adapter.py`, `scripts/crg-architecture-wrapper.mjs`.
- Lifecycle gate: `tests/crg-clean-break-lifecycle.py`; package/install gates: `tests/v3-release-git-install.test.mjs`, `tests/v3-navigation-provision.test.mjs`.
- Upstream capability and patch contracts: [`../upstream/crg-official-docs-digest.md`](../upstream/crg-official-docs-digest.md).
