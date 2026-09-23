---
title: "pi-nav Rust backend contributor guidance"
description: "Entrypoints, current owners, invariants, and verification commands for changing the owned Rust navigation backend."
tags: [pi-nav, rust-backend, contributor-guide, napi, navigation]
created: 2026-07-25
updated: 2026-09-09
status: active
owns: "pi-nav contributor entrypoints, owners, and invariants"
audience: contributor
code: [src/walk.rs, src/output.rs, src/source_proof.rs, src/dispatch.rs, src/napi.rs, ../../src/core/pi-nav-native.ts]
related: [../../docs/decisions/pi-nav-owned-backend.md, ../../docs/decisions/proof-preserving-mutation.md, ARCHITECTURE.md, UPSTREAM.md]
---

# pi-nav contributor guidance

`native/pi-nav` is the owned Rust navigation backend. Before changing it, read the backend decision in `../../docs/decisions/pi-nav-owned-backend.md`, the R1 source-authority contract in `../../docs/decisions/proof-preserving-mutation.md`, `ARCHITECTURE.md`, `UPSTREAM.md`, and the relevant section of `../../docs/upstream/pi-nav-native-contracts.md`. P0-P7 and Gates R2/R1 are closed for verified development/runtime targets.

Current owners:
- shared traversal and visibility policy: `src/walk.rs`; search-specific algorithms remain in `src/search/`;
- transport-neutral result contract: `src/output.rs`;
- current-byte proof, raw digests, and operation-local snapshots: `src/source_proof.rs`;
- transport-neutral read-only operations: `src/ops/`;
- native session, operation context, root/path resolution, typed errors, and read-only dispatch: `src/dispatch.rs`;
- standalone MCP protocol, schemas, adapters, and edit-only write: `src/mcp/`;
- runtime instructions: `prompts/mcp-base.md` and `prompts/mcp-edit.md` only;
- N-API addon boundary: `src/napi.rs`; jeito-codeweave-pi load/session/FIFO/abort boundary: `../../src/core/pi-nav-native.ts`.

Documentation owners:
- `ARCHITECTURE.md`: current owners, data flow, and root/cancel/panic/write invariants;
- `UPSTREAM.md`: imported-source provenance, local adaptations, and sync procedure;
- `../../docs/upstream/pi-nav-native-contracts.md`: pinned external npm/Pi/Apple/Node/napi-rs contracts, applied symbols/tests, and revalidation triggers;
- this file: contributor entrypoints and commands. Update the smallest owner in the same phase as the code; do not create a progress or research document.

Invariants:
- preserve model-facing output unless the plan names a defect;
- reuse existing owners; no speculative dependency, duplicate walker, broad Clippy allowance, compatibility alias or generic fallback. The approved A1 SQLite/FTS boundary permits its necessary standard native SQLite binding, not a custom store or unrelated runtime;
- jeito-codeweave-pi starts query mode only and never routes public edit/write through `pi-nav`;
- keep `pi_nav_write` available only for standalone native `--edit` parity;
- record upstream adaptations in `UPSTREAM.md`;
- anchor relative N-API inputs to the canonical session root, never process cwd; preserve explicit external targets under `ARCHITECTURE.md#root-and-cwd-invariant`. The root selects context/defaults, not filesystem permission;
- keep native work off the JavaScript thread, preserve caller-owned AbortSignal behavior, and catch task panics before FFI;
- when a relied-on external behavior changes, update the native-contract digest's source, `Applied in`, proving test, and revalidation trigger.

From this directory, run `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test --all-features` after the final relevant Rust/doc edit. Root `npm run pi-nav:build`, `npm run pi-nav:check`, and `npm run pi-nav:package -- --development` own current-host artifacts and the non-release package probe. Gate R1 additionally requires hidden-payload leak, one-proof-call/reuse, normalization, provider-version, root/cancel, mutation-regression, full-suite, and installed-package evidence. Production `pi-nav:package` remains fail-closed on signing/notarization and matching-host gates; never improvise an ad-hoc production release or inspect secret values.

Package lifecycle changes update this file, native README/ARCHITECTURE/UPSTREAM, setup/current-truth and the native-contract digest in the same slice. The approved A1/H maintenance extension in `../../docs/decisions/pi-nav-owned-backend.md` supersedes R2's no-prepared-pi-nav restriction: reuse this core/CLI for a short-lived supervised updater, while queries remain read-only N-API and R1 source/read/edit authority is unchanged. Do not restore a Tilth query process, generic broker or per-project service.
