---
title: "pi-nav owned Rust navigation backend"
description: "Status, owners, development checks, and invariants for the owned Rust navigation backend loaded by jeito codeweave-pi."
tags: [pi-nav, rust-backend, navigation, napi, owned-runtime]
created: 2026-07-25
updated: 2026-09-09
status: active
owns: "pi-nav status, owners, development checks, and invariants"
audience: contributor
code: [src/walk.rs, src/output.rs, src/ops/, src/dispatch.rs, src/napi.rs, src/mcp/]
related: [ARCHITECTURE.md, UPSTREAM.md, AGENTS.md, ../../docs/upstream/pi-nav-native-contracts.md]
---

# pi-nav

`pi-nav` is jeito-codeweave-pi's owned Rust navigation backend. It preserves the imported Tilth algorithms and compact model-facing text while adding jeito-codeweave-pi's typed result, traversal, visibility, exact `ls`/files/search, full-source symbol-range lookup with source hashes, root-confinement, cancellation, and N-API requirements.

It is not installed separately for jeito-codeweave-pi. The extension loads the platform addon from its own package. The same Rust package also retains standalone CLI and MCP entry surfaces, including MCP edit mode; public jeito-codeweave-pi `edit`/`write` remain the separate TypeScript transaction engine.

## Current status

- P0-P7, Gates R2/R1, and R3 implementation/build/runtime/documentation closure are complete for verified development/runtime targets. Public prepared tools now compose pi-nav fallback only for supported typed relationships; pi-nav remains read-only to jeito-codeweave-pi.
- The current Darwin-arm64 R3 development archive has 3,485 sorted manifest files and passes SHA-256, addon/CLI capability, extracted/package, and link/allowlist checks. The larger count reflects the current production dependency tree plus the minimal owned CRG bootstrap; it is evidence, not an API contract.
- Corrective-R1 matching Linux arm64/x64 candidates passed glibc-2.28 and official Pi 0.80.6 checks, but are historical rather than current R3 publication candidates.
- Source authority remains TypeScript-owned and must not move into pi-nav.
- Apple production publication remains explicitly deferred: darwin-x64, Developer ID/Accepted notarization, and actual quarantine tar/conditional-DMG evidence remain required before release. CI automation is deferred too.

Do not describe `package --development`, the ad-hoc-signed macOS arm64 artifact, or completed Linux evidence as proof of Apple production release.

## Owners

- `src/walk.rs` — exact live-query traversal and visibility.
- `src/output.rs` — typed `ToolOutput`, completeness, and diagnostics.
- `src/ops/` — transport-neutral read-only operation bodies.
- `src/dispatch.rs` — native session/context, root/path resolution, errors, and read-only allowlist.
- `src/napi.rs` — feature-gated N-API task/value/panic boundary.
- `src/mcp/` — standalone MCP protocol/schemas and edit-only write adapter.
- `ARCHITECTURE.md` — current data flow and invariants.
- `UPSTREAM.md` — pinned Tilth/oh-my-pi provenance and synchronization.
- `AGENTS.md` — contributor entrypoint and commands.
- `../../docs/upstream/pi-nav-native-contracts.md` — official napi-rs, Node, npm, Pi package, platform, Apple release, and reference-implementation contracts.
- `../../docs/decisions/pi-nav-owned-backend.md` — closed implementation gates and the backend decision. `../../docs/decisions/proof-preserving-mutation.md` — R1 source-authority contract.

## Development checks

From `native/pi-nav/`:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

From the extension root:

```bash
npm run pi-nav:build
npm run pi-nav:check
npm run pi-nav:package -- --development
```

`pi-nav:build` creates only the current-host development addon/CLI. `pi-nav:package` is production by default and fails closed when macOS signing/notary selectors are unavailable; `--development` creates a distinctly named manifest-verified probe only. The same script owns ABI checks, literal staging, frozen production dependencies, archive/checksum creation, and package checks. Do not add a PATH fallback, downloader, postinstall build, npm publication path, or ad-hoc production release.

For source-change rebuilds, follow `../../docs/setup.md#contributor-native-rebuild-and-runtime-reconciliation`: stop all processes using the installed addon before replacement, then build/check/restart and verify actual loaded tools. Restart alone does not compile Rust; a compatible artifact or isolated candidate is not proof of current-source activation. That workflow distinguishes macOS/Linux checks, contributor prerequisites and ordinary precompiled-user setup.

## Invariants

- Preserve native model-facing text unless a named contract and parity tests require change.
- Keep typed metadata beside rendering; never recover native facts by parsing prose.
- Keep N-API read-only and anchor relative paths to the explicit session root, never process cwd. Explicit external targets remain supported under the [root contract](ARCHITECTURE.md#root-and-cwd-invariant).
- Keep blocking work off the JavaScript thread with cooperative deadline/abort checks and guarded panic handling.
- Keep standalone MCP/CLI behavior independent from jeito-codeweave-pi's in-process addon loader.
- Add no daemon, transport framework, duplicate walker, native public mutation path, or compatibility alias.
- Update architecture, provenance, contributor, and external-contract owners in the same phase as code.

Tilth's MIT license is retained in `LICENSE`. Exact imported source and local adaptations are recorded in `UPSTREAM.md`.
