---
title: "Decision: proof-preserving source authority and the salvage edit engine"
description: "Why displayed source becomes edit authority without redundant reads, and why the edit engine salvages every provably-safe part of authored intent."
tags: [jeito-codeweave-pi, decision, source-authority, edit-engine, mutation, salvage]
created: 2026-07-25
updated: 2026-07-26
status: completed
decided: 2026-07-25
owns: "Why mutation authority is proof-preserving and salvage-oriented, and the rejected strict-mode/native-mutation machinery"
audience: contributor
code: [src/core/source-authority.ts, src/core/snapshot-store.ts, src/core/patch-apply.ts, src/core/edit-retry.ts, src/core/edit-repair.ts, native/pi-nav/src/source_proof.rs]
related: [docs/harness-doctrine.md, docs/automatic-workflow.md, docs/evidence.md, docs/decisions/pi-nav-owned-backend.md]
---

# Proof-preserving source authority and the salvage edit engine

Status: **accepted and shipped** (Gate R1 closed after corrective batches; edit-enhancement closure complete). Current behavior is owned by the structural-blocks flow (`docs/automatic-workflow.md:implemented-runtime-flows/6-structural-blocks#2`), the file-operations flow (`docs/automatic-workflow.md:implemented-runtime-flows/7-file-operations-and-independent-atomic-landing#2`), and mutation doctrine (`docs/harness-doctrine.md:navigation-harness-doctrine/mutation-doctrine#2`); this record preserves the *why* for the two coupled mutation decisions.

## Part A — unified source authority

### Decision

Optimize **after evidence sufficiency, never by collecting less evidence.** Once the task boundary is earned and the exact current rows needed for mutation are already displayed and certified, remove redundant agent-visible reads whose content cannot change the target, replacement, procedure, or validation plan. Eligible source is certified automatically through one coordinator; there is no public proof/expansion knob.

### Why proof-preserving, not a call-count target

The intended wins are controlled mechanical rewrites, complete homogeneous match sets, small function/signature changes, known callsite parameter additions, and exact documentation-section edits. If unseen context can change meaning, scope, side effects, ownership, or verification, the agent must still obtain it. Source authority proves text identity and seen anchors — it is **not semantic permission** that every matching occurrence should change.

### Two digest identities (never averaged)

1. `rawDigest` — SHA-256 of exact file bytes; compared with CRG whole-file hashes and QMD section versions.
2. `snapshotDigest` plus `tag` — SHA-256 and first eight uppercase hex of the normalized snapshot contract; this is the edit identity.

Rust preserves exact raw bytes and raw SHA-256; TypeScript exclusively applies edit normalization (BOM removal, LF/CRLF/CR normalization, trailing whitespace/newline behavior) when minting the edit identity. This keeps one edit owner across the FFI boundary.

### Rejected (do not resurrect)

- Moving public edit/write, stale recovery, block resolution, staging, per-file atomic landing, mode/xattr handling, or mutation queues into pi-nav.
- Making a hash authorize unseen lines; line edits remain limited to complete displayed rows.
- A shared daemon, filesystem watcher, speculative cross-call byte cache, native mutation path, provider fallback, AI source reconstruction, or public source-proof tool.
- Exposing provider raw hashes as edit tags, or trusting mtime/provider cache identity as current-byte proof.
The resulting authority flow is `docs/automatic-workflow.md:implemented-runtime-flows/3-unified-source-authority#2`; the evidence map is `docs/evidence.md:current-evidence-map/exact-live-utilities-and-source-authority#2`; the doctrine is `docs/harness-doctrine.md:navigation-harness-doctrine/source-and-mutation-authority#2`.

## Part B — salvage edit engine

### Decision

Make `edit` **salvage every provably-safe part of authored intent**, return exact residual work for a cheap ordinary retry, preserve atomic landing per physical file, and add automatic syntax plus explicitly scoped LSP feedback — without importing a noisy IDE pipeline. The default is salvage-oriented; there is no strict/atomic mode matrix. A new agent uses the ordinary `edit` language without knowing about target islands, provenance, recovery strategies, parser internals, or transactions.

### Why salvage over all-or-nothing

An unseen source row copied back unchanged does not require authority; an unseen row changed or deleted remains protected. Valid independent target islands apply while unsafe islands become exact residual work, so a partial failure never discards safe progress and never silently authorizes unsafe content. Multi-file mutation is atomic per physical file, not filesystem-wide: a later file failure does not roll back an earlier successful file.

### Failure boundaries

| Failure | Required boundary |
|---|---|
| Input cannot be divided into trustworthy sections | Call |
| Malformed section after a trustworthy header | Section |
| Missing/ambiguous snapshot or unsafe file type | Section/file target |
| Out-of-bounds, unseen, unrecoverable stale, or deterministic-repair refusal | Target island/operation |
| Overlap | Conflicting island group |
| Byte-identical target | Skip, not failure |
The salvage flow is `docs/automatic-workflow.md:implemented-runtime-flows/4-read-edit-continuation#2`; the edit surface is `docs/tool-operating-reference.md:jeito-codeweave-pi-tool-operating-reference-and-coverage-audit/edit#2`.

## Code and verification

- Source authority coordinator: `src/core/source-authority.ts`; native proof registration: `src/core/snapshot-store.ts` (`recordTrustedProof`); native proof substrate: `native/pi-nav/src/source_proof.rs`.
- Edit engine: `src/core/patch-apply.ts`, `src/core/patch-parser.ts`, `src/core/edit-retry.ts`, `src/core/edit-repair.ts`, `src/core/edit-recovery.ts`; advisory diagnostics: `src/core/syntax-validation.ts`, `src/core/lsp-validation.ts`.
- Probes: `tests/v3-live-source-authority.test.mjs`, `tests/v3-edit-retry.test.mjs`, `tests/v3-edit-repair.test.mjs`, `tests/v3-edit-recovery.test.mjs`, `tests/v3-edit-partial.test.mjs`, `tests/v3-edit-target.test.mjs`, `tests/v3-lsp-validation.test.mjs`, `tests/v3-syntax-validation.test.mjs`.
- Closure benchmark `/tmp/edit-enhancement-closure.json`: 9.810 ms p95 at 10k lines, 73.490 ms at 100k, 1.502 ms zero-copy p95, 9.436 ms warm-syntax p95, 41.288 ms 100k event-loop occupancy under the 50 ms ceiling.
