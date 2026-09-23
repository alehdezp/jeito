---
title: "pi-nav upstream provenance and synchronization"
description: "Pinned Tilth base, oh-my-pi reference, owned adaptations per phase, and the synchronization contract for the pi-nav Rust backend."
tags: [pi-nav, upstream, provenance, tilth, oh-my-pi, synchronization]
created: 2026-07-25
updated: 2026-09-17
status: active
owns: "pi-nav upstream provenance, adaptation record, and sync contract"
audience: contributor
related: [README.md, ARCHITECTURE.md, ../../docs/upstream/pi-nav-native-contracts.md]
---

# Upstream provenance

## Tilth base

`native/pi-nav` was imported from [jahala/tilth](https://github.com/jahala/tilth)
at commit `c05475fd41fa620be1662a0f2e9b0e4093c6b68b` (`c05475f`). The import used
`git archive`; it contains no upstream `.git` metadata, build artifacts, or
untracked benchmark output. Tilth's MIT `LICENSE` is retained at `LICENSE`.

## oh-my-pi reference

The locked reference is [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
commit `bb35e791890d33327ff184b1e94621d074b5bad4` (`bb35e79`). S0 copied no
oh-my-pi code or crate.

## Prepared ranked support reuse

Prepared support now joins the existing live selection and source composition instead of replacing it with graph-ordered ranked cards. Preserve exact declaration/site/owner identities, distinct directed trace edges, non-call kinds and nullable positions when synchronizing; a node name, equal line number or stored confidence cannot reconstruct discarded evidence. `src/search/mod.rs::append_ranked_lanes` shares displayed source across roles while retaining their annotations. The current behavior and concrete owners live in [prepared connections retain live selection](ARCHITECTURE.md#prepared-connections-retain-live-selection); session redisplay and exhaustive matches remain separate.

The unwired indexed-run reader is an owned adaptation in `src/search/prepared.rs`, not a donor query-engine port. `AnalysisIdentity` distinguishes G1 captures from supplied completed-run context; the two openers share stored-row/source projection while retaining distinct validation and metadata. Keep indexed relationships explicitly best effort and selected-source hashes as coordinate checks, not binding-currentness proof. Synchronization must not fabricate a G1 manifest for donor output or expose this seam through normal tools before storage/admission/readiness integration. `ARCHITECTURE.md#status` owns its current reachability limits.

## Prepared policy-version handoff

`src/search/prepared.rs` compares the caller's private `analysisPolicyDigest` with committed capture policy inside the read transaction. Policy-bound captures require it; a supplied current `analysisCorpusFiles` census also constrains untagged explicit captures. Valid empty publications remain valid—not broken stores. The caller owns current admission and the reader validates captured source versions; neither a digest nor an endpoint-only check proves the corpus current. These corrections preserve read/edit and do not enable automatic preparation.

## TOML Matches adaptation

`src/search/matches/toml_context.rs` is an owned adapter over the already locked `toml` 1.1.2+spec-1.1.0 parser, not imported parsing code or a replacement for protected read outlines. Preserve its parser-supplied key/value/header/array-element spans when synchronizing; generic table extents or indentation guesses cannot substitute for those coordinates. [Matches reuse parsed TOML key context](ARCHITECTURE.md#matches-reuse-parsed-toml-key-context) owns behavior and proof boundaries. No dependency, feature, public parameter or native transport shape changes accompany this adaptation.

## S0 adaptations

All tracked Tilth files were copied. S0 adapts only the Cargo/binary and
user-facing `pi-nav` identity, MCP protocol `2025-06-18`, and the locked
`pi_nav_*` MCP names in `Cargo.toml`, `src/main.rs`, `src/mcp/`, `src/install.rs`,
and generated MCP prompts. `tests/s0_mcp.rs` covers the owned process contract.

## P0 ownership audit

P0 removed the nine broad Rust 1.96 Clippy allowances added during import and
fixed the exposed findings without changing native behavior. It also restored
jeito-codeweave-pi's generated/index exclusions, migrated active environment,
diagnostic, package, release, benchmark, temporary-file, install, and skill
identity to `pi-nav`/`PI_NAV_*`, separated contributor guidance from runtime
MCP prompts, deleted the obsolete prompt-to-AGENTS generator and all references,
and removed upstream repository metadata because this owned subtree has no
independent remote. `TilthError` remains an internal provenance type name.

The `tilth_search` string in `tests/s0_mcp.rs` is an intentional negative-control
fixture proving that stale MCP operation names are rejected; it is not an alias.

## P1/P2 owned adaptations

P1/P2 added jeito-codeweave-pi's shared walker/visibility policy, typed `ToolOutput`, transport-neutral read-only operation owners, `NativeSession`/`OperationContext`/read-only dispatch, exact `ls`, deterministic multi-pattern files, search additions, typed metadata, root confinement, cancellation checkpoints, and Git-child reaping. These are owned product changes, not claims about upstream Tilth. The final P2 gate passed with 634 library, 4 binary, and 5 MCP integration tests.

## Native runtime and release references

`../../docs/upstream/pi-nav-native-contracts.md` is the source-backed owner for napi-rs, Node, Rust panic, npm frozen staging, Pi local-package, platform-floor, Apple signing/notarization, and pinned oh-my-pi behavior relied on by P3–P7. Its package entries now map to `../../scripts/pi-nav-build.mjs`, `../../scripts/navigation-doctor.mjs::inspectPiNavPackage`, and `../../tests/v3-pi-nav-package.test.mjs`; P7 revalidates source versions and shipped behavior.

The oh-my-pi adaptation remains intentionally narrow: AsyncTask/cooperative cancellation, guarded panic-payload disposal, native build lessons, and macOS release behavior as a reference only. It does not authorize copying the global crash handler, extraction loader, npm leaf packages, CPU variants, Tokio runtime, Bun entitlements, or unrelated native modules.

## P3 N-API adaptation

P3 added one feature-gated napi-rs front door in `src/napi.rs`, one Cargo `rlib`/`cdylib` package, and the current-host build/check lifecycle. `Cargo.lock` pins `napi` 3.10.5, `napi-derive` 3.5.10, and `napi-build` 2.3.2; the root dev tool is `@napi-rs/cli` 3.7.0. The adaptation includes direct `AbortSignal` cooperative cancellation, guarded task panic/payload disposal, one object result wrapper, exact build info/capabilities, session-anchored read-only dispatch with explicit external-path support, and no N-API write reachability. Addon API version 2 adds owned `pi_nav_symbol_range`: exact name lookup over the complete parsed file plus a source SHA-256, avoiding bounded-outline false absence and stale-range trust.

jeito codeweave-pi owns the TypeScript load/session/FIFO/private-abort boundary in `../../src/core/pi-nav-native.ts` and stable current-host artifact build/check in `../../scripts/pi-nav-build.mjs`. These are local product owners, not copied oh-my-pi loader/package infrastructure.

The owned cursor correction adds private membership lookup in `src/napi.rs`/`src/session.rs` and original-session routing in the TypeScript bridge, without changing Tilth's opaque token or cursor lifetime owner. [Cursor continuation and source identity](ARCHITECTURE.md#cursor-continuation-and-source-identity) owns the worker/FIFO, capability and source-certification contract.

The private ranked collection/resume handoff is also an owned adaptation, not an upstream cursor feature. Preserve its original request identity, independent source/dependency revalidation and live-preserving refusal behavior; the [ranked collection contract](ARCHITECTURE.md#ranked-collection-survives-optional-enrichment) owns the bounds and distinction between refused retention and failed resume. Do not replace it with a single last-search slot or restore discovery during resume.

Immutable ranked render-only fitting and complete class-header paging are owned adaptations too: `src/search/continuation.rs::RankedCursor` retains original progress, while `src/search/mod.rs::render_ranked_regions_with_progress` selects atomic pending header units. Preserve these rather than restoring an all-header floor or crediting discarded previews. Native allowances remain estimates; the TypeScript Grep owner performs pinned whole-reply accounting and staged authority. The [result contract](ARCHITECTURE.md#result-contract) and [cursor contract](ARCHITECTURE.md#cursor-continuation-and-source-identity) own the protocol, limits and evidence boundary.

## P5 package adaptation

jeito codeweave-pi's root package is the sole distribution owner. `../../scripts/pi-nav-build.mjs` now owns matching-host build/check/package, Darwin install-name normalization, macOS/Linux ABI floors, production Developer ID/notary sequencing, frozen non-dev/non-peer dependencies, exact source staging, manifest hashing/modes, and atomic tar/checksum output. `../../scripts/navigation-doctor.mjs::inspectPiNavPackage` consumes its isolated JSON check without loading the addon in the doctor process. These are owned release adaptations; no npm downloader, native-crate publisher, postinstall, platform leaf package, or query-time repair was imported from Tilth or oh-my-pi.

The build owner now checks both staged artifacts before per-file rename publication rather than copying over a potentially loaded addon/running CLI inode. Its smoke check exercises the candidate directly; the installed location additionally exercises the TypeScript loader. The Darwin ARM64 rebuild probe retained old descriptor bytes and a working old reader. This is an owned installation-safety correction, not a hot upgrade or atomic two-file release transaction.

Production packaging's signing phase now receives the isolated staged root and artifacts. Credential-selector validation still fails before dependency staging; signing and signed-byte checks no longer target the checkout. The focused forced-staging-failure test proves the original binary bytes remain unchanged without invoking real signing or notarization.

## P5 synchronization requirement

Before packaging, inventory owned changes by concrete owner/test against the pinned Tilth base: identity/protocol, shared output/ops/dispatch, walker/visibility, files/ls/search/read/diff metadata, N-API, and release paths. Future upstream comparison happens in a temporary checkout and produces a reviewed patch; it never resets, cleans, copies over, or treats dirty `../../vendor/tilth-patched` as source authority. Release-only npm/Pi/Apple changes belong in jeito-codeweave-pi package owners and this provenance pointer, not in a second native release framework.

## Search correctness adaptations

Owned corrections in `src/ops/search.rs`, `src/search/{mod,fuzzy,callers,scope,lanes}.rs` preserve exact file identity before caps, remove host-directory ranking terms, retain meaningful query vocabulary, and use parsed source declaration boundaries rather than counting a folded signature's lines. Ranked caller labels no longer promote name/alias candidates to binding proof. These are first-party repairs to reproduced counterexamples, not donor functionality. [`ARCHITECTURE.md#search-seed-identity-and-source-evidence`](ARCHITECTURE.md#search-seed-identity-and-source-evidence) owns their current behavior and focused tests. Do not restore the parent-plus-basename search or guessed declaration boundaries during an upstream merge.

The TS/JS exact/fuzzy migration replaces their independent depth/shallow-outline decisions with `src/search/declarations.rs`, compiling the maintained analysis source classifier in navigation's parser context. The [search architecture](ARCHITECTURE.md#search-seed-identity-and-source-evidence) owns that handoff. Retain this shared owner during upstream synchronization rather than restoring a separate TS/JS declaration detector; other language and protected read projections remain distinct.

The live-composition correction carries call expression, receiver and immediate-owner identity through the existing caller/callee consumers and uses exact declaration keys instead of path/start-line buckets. It replaces first-name binding guesses with visibly qualified syntax candidates and retains source once with role annotations. Class inventories and post-fit expansion recording reuse that carrier; no new graph, resolver, parser runtime or public mode was added. During synchronization, preserve the [search architecture](ARCHITECTURE.md#search-seed-identity-and-source-evidence), not the discarded line/name shortcuts. Prepared publication and interpretation identity are unchanged by this navigation-only correction.

Body/document candidate collection and within-answer declaration-inventory reuse are owned navigation changes, not donor semantic resolution. Preserve source-bounded collection and the identity/complete-signature reuse guard described in the [search architecture](ARCHITECTURE.md#search-seed-identity-and-source-evidence); otherwise a synchronization can again spend the page on a second member index rather than useful connection source.

Admitted ranked search now carries the existing corpus policy through collection, dependency reads, capture reopening and rendering. Preserve normalized-before-probe TS/JS imports and captured-source outline/scope/Markdown decoration during synchronization: ordinary sibling imports must remain capturable, and neither a selected path nor a shared mtime cache authorizes reading a replacement file. The [search architecture](ARCHITECTURE.md#search-seed-identity-and-source-evidence) and `src/search/mod.rs::ranked_corpus_tests` own this correction; protected read helpers and legacy non-admitted operations remain distinct.

## Updating

1. Fetch and verify the intended Tilth commit in a temporary checkout.
2. Export it with `git archive` into a clean `native/pi-nav/` tree; never copy
   upstream Git metadata, build artifacts, or benchmark results.
3. Reapply only approved owned changes, retain the MIT license and this record,
   then run the owning Cargo checks and parity fixtures.
4. Compare upstream behavior against the concrete owners/tests listed in
   `ARCHITECTURE.md`; do not restore obsolete MCP ownership or process-cwd
   assumptions merely because upstream still has them.
5. Record any newly copied or adapted oh-my-pi file and its MIT provenance here,
   update the native-contract digest, and add the focused test before use.
