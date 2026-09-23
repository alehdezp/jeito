---
title: "Decision: owned pi-nav backend as an in-process N-API addon"
description: "Native query ownership, coherent donor maintenance and the reuse-first best-effort delivery tradeoff."
tags: [jeito-codeweave-pi, decision, pi-nav, napi, backend, architecture]
created: 2026-07-25
updated: 2026-09-16
status: completed
decided: 2026-07-25
owns: "Native query/maintenance execution boundaries and their durable tradeoffs"
audience: contributor
code: [native/pi-nav/src/napi.rs, native/pi-nav/src/dispatch.rs, native/pi-nav/src/walk.rs, native/pi-nav/src/output.rs, src/core/pi-nav-native.ts]
related: [docs/evidence.md, docs/automatic-workflow.md, docs/upstream/pi-nav-native-contracts.md, docs/decisions/proof-preserving-mutation.md]
---

# Owned pi-nav backend as an in-process N-API addon

The live-query N-API decision is **accepted and shipped** for the previously verified targets. The maintenance revisions below record design decisions, not release readiness. The latest reuse-first revision supersedes earlier strict successor-publication requirements; existing source/runtime guarantees do not change until implementation and authorized cutover. `native/pi-nav/ARCHITECTURE.md` owns implemented behavior; [`../upstream/pi-nav-native-contracts.md`](../upstream/pi-nav-native-contracts.md) owns external runtime evidence.

## Context

jeito codeweave-pi needed exact live filesystem operations (`ls`, `find`, filesystem-backed `grep`) and smart structural reads backed by a Rust engine. The inherited option was a persistent MCP child process (Tilth's model). The question was how the extension's production bridge should reach that engine.

## Decision

Build a renamed, owned Tilth fork (`native/pi-nav`) and make the production bridge a **direct in-process N-API addon**, not a persistent MCP child. One addon loads in Pi's main Node environment; one lightweight Rust session lives per canonical project root. No pi-nav backend process is ever spawned for a query.

## Why N-API over an MCP child

This is an **ownership simplification, not a performance contest.** N-API was chosen because the only production caller is Pi, and an in-process addon deletes the TypeScript stdio client, child registry, process supervision, JSON-line framing, kill/retry policy, and one process per root. Comparative N-API/MCP timing is not an acceptance criterion. The accepted trade-off is an in-process FFI boundary that must be hardened explicitly (panic containment, cancellation, root/cwd isolation), which `native/pi-nav/ARCHITECTURE.md` owns.

## Locked identity

- Source directory and Cargo package: `native/pi-nav` / `pi-nav`.
- Addon feature/module: `napi-addon` / `src/napi.rs` inside the existing crate — no workspace or second core crate.
- Tilth base: upstream commit `c05475fd41fa620be1662a0f2e9b0e4093c6b68b`.
- oh-my-pi reference: commit `bb35e791890d33327ff184b1e94621d074b5bad4`, limited to its napi-rs task/cancellation/panic pattern and native build/loader lessons.

## Original query-bridge non-goals

- Using MCP, a private RPC protocol, or a child process as the native runtime bridge.
- Creating a Cargo workspace, second core crate, provider interface, transport framework, daemon, or plugin system.
- Replacing CRG, Graphify, or QMD, or rewriting Tilth features that already work.
- Turning `ls` into architecture/ownership/relationship synthesis, or exposing native write through N-API.
- Porting oh-my-pi's loader/extraction/CPU-variant/npm-leaf machinery, Tokio runtime, cache, or streaming callbacks.
- Supporting Windows, musl/Alpine, npm publication, or automatic release downloads in the release gate.

## Delivery boundary

pi-nav is internal runtime shipped inside a self-contained Pi local-package release, not a PATH dependency or separate npm native package. Query-time never builds, downloads, extracts, repairs, or consults PATH; users never compile pi-nav. Cargo builds, signing, and package assembly are contributor/release-CI work.
The resulting lifecycle is `docs/automatic-workflow.md:implemented-runtime-flows/10-core-graphify-and-bundled-pi-nav-lifecycle/bundled-pi-nav#3`; operator expectations are `docs/setup.md:setup-health-repair-and-migration/backend-expectations/bundled-pi-nav#3`; the exact-utility evidence is `docs/evidence.md:current-evidence-map/exact-live-utilities-and-source-authority#2`.

## Code and verification

- N-API front door and session: `native/pi-nav/src/napi.rs`, `native/pi-nav/src/dispatch.rs`; live-query traversal: `native/pi-nav/src/walk.rs`; result contract: `native/pi-nav/src/output.rs`.
- TypeScript load/bridge: `src/core/pi-nav-native.ts`; artifact binding: `native/pi-nav/artifacts.json`.
- Probes: `tests/v3-pi-nav-native.test.mjs` (pre-abort, cross-reload abort, walker cancellation, event-loop liveness), `tests/v3-pi-nav-package.test.mjs`.

## A1/H maintenance extension — approved 2026-09-06

Keep live queries in Pi's N-API addon, but run automatic index maintenance in a **short-lived supervised invocation of the packaged Rust CLI**, sharing the same Rust core. At most one maintenance child runs per Pi runtime. Watch only deliberately active, safely bounded projects; cached or incidentally referenced folders do not own continuing work. A1 is one native SQLite/FTS code-evidence owner; H supplies filesystem hints to authoritative reconciliation alongside Pi/lifecycle/manual checkpoints. Queries never activate preparation or repair.

The distinction is failure containment and explicit lifetime, not speed. Native tasks already running inside Pi depend on cooperative cancellation; a separate update job can be terminated without terminating Pi. A persistent per-project daemon adds lifetime machinery without a demonstrated need. The accepted cost is process startup, a private bounded job request/result and parent-liveness handling. Reuse the CLI/core, shared traversal and existing process supervisor; no MCP query client, transport framework or second core crate is introduced.

This deliberately supersedes the original prohibition on native prepared code evidence/CRG replacement and maintenance subprocesses, not the N-API query or TypeScript read/edit safety decision. A standard native SQLite binding is justified by A1; speculative dependencies remain excluded. QMD remains the documentation retrieval owner and Graphify's useful map evidence remains protected. Replace obsolete lifecycle/implementation only after caller-visible behavior is retained; no public tool retirement is implied.

Implementation must prove committed-generation readers, source/policy/base validation before publication, useful live navigation during preparation, cancellation/parent-death/shutdown cleanup, and package/platform operation. Opening a project does not authorize downloads, cloud work, project-code execution, host configuration changes or out-of-root indexing. Existing explicit provider policy is separate from local-maintenance permission. Architecture/package docs track what actually lands; this decision does not claim those proofs already exist.

## Coherent analysis execution revision — approved 2026-09-08

The user approved replacing the Rust-only maintenance executable/writer boundary with **one short-lived supervised Node maintenance child**, retaining Rust extraction and coherent donor TypeScript resolution. One SQLite/FTS code graph, Pi-owned active-project watching, bounded supervision, useful live queries and unchanged TypeScript read/edit remain required. This supersedes the execution-language portion of the September6 extension, not its lifetime, privacy or publication requirements. Implementation is in progress; automatic activation and installed-runtime cutover are not implied.

Why: the donor's import, receiver, callback and ordered relationship passes contain valuable working behavior. Translating that subsystem merely to preserve a Rust-only updater creates parity and maintenance work without an established benefit. The accepted cost is a maintained Node/native interface and compatible packaging. A substantial native port remains a reconsideration if retaining the donor requires rebuilding most of it.

**Historical strict-capture requirement, superseded for the successor by the September 16 revision below:** reuse could not inherit silent synthesis failures, unadmitted source reads or partially published batches. The donor's synchronous transaction helper commits before an async callback finishes; an isolated two-connection probe observed its inserted row both before completion and after an injected async failure. The then-selected wrapper therefore awaited the complete operation and validation before commit on one connection. That is a valid receipt for the old design, not a requirement to wrap the intact donor maintenance pipeline in another transaction. Preserve reference positions/provenance, source/privacy safety and selected output behavior in the successor.

## Reuse-first best-effort delivery revision — 2026-09-16

The user endorsed coherent CodeGraph reuse, best-effort indexing and faster verified delivery rather than further engineering of instantaneous freshness. Keep indexed relationships distinct from independently verified current source. Normal refresh handles graph lag; live navigation remains useful during preparation or recovery. The successor does not require whole-repository immutable capture, one transaction enclosing the donor pipeline, or continuous last-good graph availability. Earlier publication requirements above remain historical rationale and existing implementation facts, not a mandate to reproduce that design.

Why: CodeGraph's maintenance facade already owns reconciliation, reference repair and ordered passes, using its own worker/transaction/journal lifecycle. Recreating that lifecycle to fit codeweave-pi's curated wrapper costs more maintenance than the stronger freshness promise justifies. Adapt project/storage selection, source admission, process ownership and honest completed-run readiness at narrow boundaries. Never weaken exclusion/privacy, displayed-source identity, edit safety or failure reporting. This decision authorizes no modification of existing stores or automatic host activation.

Prefer existing Rust implementation or a cheap maintainable port for repeated data/CPU work when total process, memory, startup and transport cost supports it. Retain coherent TypeScript donor logic when a port would duplicate difficult behavior; thin Pi orchestration is not itself a heavyweight spawned runtime. Avoid duplicate per-project maintenance starts before redesigning the engine. Read/write/edit placement is eligible for assessment, not automatic migration or permission to alter protected contracts. The execution-control owner (local-only work record) carries the decision procedure; the selected goal (local-only work record) bounds current local work.
