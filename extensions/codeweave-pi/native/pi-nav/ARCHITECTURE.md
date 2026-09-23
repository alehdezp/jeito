---
title: "pi-nav architecture and invariants"
description: "Current architecture, concrete owners, data flow, read-only boundary, result contract, and invariants for the pi-nav Rust backend."
tags: [pi-nav, architecture, invariants, rust-backend, napi]
created: 2026-07-25
updated: 2026-09-17
status: active
owns: "pi-nav architecture, data flow, and invariant ownership"
audience: contributor
code: [src/walk.rs, src/search/mod.rs, src/read/mod.rs, src/output.rs, src/source_proof.rs, src/dispatch.rs, src/napi.rs]
related: [README.md, UPSTREAM.md, AGENTS.md]
---

# pi-nav architecture

This is the current architecture and invariant owner for the Rust backend. It stays concise: source files own implementation detail, `UPSTREAM.md` owns provenance/synchronization, `AGENTS.md` owns contributor commands, and `../../docs/upstream/pi-nav-native-contracts.md` owns external runtime contracts.

## Status

- P0-P7, Gates R2/R1, and R3 implementation/build/runtime/documentation closure are complete for verified development/runtime targets. Native read/search/proof reuse operation-local bytes, hidden proof canonicalizes aliases, and TypeScript retains normalized edit identity and mutation safety. Production Apple publication remains separately deferred.
- Current native entry surfaces are the standalone CLI, standalone MCP server, and feature-gated N-API addon.
- Shared read-only operations, typed output, root context, traversal, cancellation checkpoints, map/overview, exact `ls`, files/search additions, full-source `pi_nav_symbol_range`, addon loader, per-root FIFO/session reuse, and current-host build/check are implemented.
- jeito codeweave-pi loads the addon directly for bundled `ls`, `find`, `grep`, smart summaries, supported trace routes, and structural diff; no legacy Tilth runtime owner or prepared pi-nav lane remains.
- P4 corrected the operation-aware diff/root contract, full typed changed-symbol spans, typed/displayed search-row correspondence, and generated `.pi` visibility exclusions before public consumer cutover.
- R3 keeps pi-nav as an exact typed fallback only for supported trace relations (`callers`, file `imports`/`importers`, homogeneous test-file locations, and `file_summary`); it does not synthesize callee or runtime semantics.
- The maintained analysis candidate uses a supervised Node writer with Rust extraction, coherent TypeScript resolution and a fresh read-only SQLite connection per native prepared query. It supports explicit and bounded policy-admitted project capture, not automatic Pi preparation or release-proven activation. The older native declaration/FTS CLI below remains an inactive migration foundation, not a second active code-graph owner.
- `search/prepared.rs::load_indexed_run` is a private, unwired integration seam for a completed single-owner donor run. It reuses graph/declaration/site projection with lazy admitted file-hash validation and a final retained-source check, without inventing G1 metadata or asserting whole-repository freshness. Indexed semantic retrieval and continuation are unavailable. Its caller-supplied run label and outside-source database rule do not establish production readiness/storage ownership. Ordinary calls still use the G1 path; the donor maintenance lifecycle has not been activated.

## Concrete owners

| Concern | Owner |
|---|---|
| Shared traversal, visibility, typed entries | `src/walk.rs` |
| Search algorithms/ranking/rendering | `src/search/` |
| Read algorithms/outlines/rendering | `src/read/` |
| Typed text + structured result contract | `src/output.rs` |
| Current-byte proof, raw digests, operation-local snapshots | `src/source_proof.rs` |
| Transport-neutral read-only operation adapters | `src/ops/` |
| Native session, operation context, errors, confinement, read-only dispatch | `src/dispatch.rs` |
| Session counters and standalone dedup state | `src/session.rs` |
| Standalone MCP schemas/adapters and edit-mode write | `src/mcp/` |
| CLI argument front door | `src/main.rs` |
| N-API task/FFI boundary | `src/napi.rs` only |
| Addon load, per-root FIFO/session, abort forwarding | `../../src/core/pi-nav-native.ts` only |
| Build/check/package path mapping, ABI validation, signing, manifest, archive | `../../scripts/pi-nav-build.mjs` only |
| Legacy native declaration/FTS foundation (inactive) | `src/index/evidence.rs`, private `src/main.rs::update_index` |
| Maintenance transport/termination (outside the query FIFO) | `../../src/core/native-maintenance.ts`, existing `../../src/core/process-supervisor.ts` |
| Coherent candidate publication and prepared reads | `../analysis/entry.ts`, `../../src/core/analysis-worker.mjs`, `../../src/core/analysis-database.ts`, `src/search/prepared.rs` |

Do not add a provider interface, generic transport, service locator, duplicate operation DTO tree, second walker, or Cargo workspace around these concrete owners.

## Data flow

Standalone MCP:

```text
MCP schema/adapter
  -> NativeSession + OperationContext
  -> dispatch_read_only
  -> src/ops + domain algorithms
  -> ToolOutput { text, structured, source_snapshots }
  -> MCP content + structuredContent (snapshots deliberately dropped)
```

Standalone CLI keeps direct typed argument handling and calls the same domain algorithms/renderers; it does not serialize through generic dispatch merely for symmetry.

jeito codeweave-pi N-API path:

```text
public TypeScript tool
  -> callPiNav(root, operation, args, timeout, signal)
  -> one cached PiNavSession + FIFO tail for canonical root
  -> napi-rs AsyncTask
  -> dispatch_read_only
  -> ToolOutput
  -> one N-API object { text, structured, sourceSnapshots? }
  -> TypeScript source-authority coordinator strips snapshot payload before persisted/model surfaces
```

No JSON string crosses the N-API boundary. No jeito-codeweave-pi query starts a pi-nav subprocess. Existing bounded Git subprocesses are operation internals, not a backend transport.

## A1 maintenance foundation and activation gate

The original Rust-only foundation described here was superseded by [`../../docs/decisions/pi-nav-owned-backend.md`](../../docs/decisions/pi-nav-owned-backend.md), section “Coherent analysis execution revision — approved 2026-09-08”. Its private CLI `update-index` remains available but is not the maintained candidate writer. That legacy command accepts one bounded JSON line on stdin; EOF ends it with exit 75.

`src/index/evidence.rs::reconcile` reuses the walker and outline parser, hashes content even when timestamps match, then publishes through one SQLite transaction. Base-generation, final census, content and parent-supplied policy-hash checks reject stale batches; failed publication retains committed data. The external cache requires a private owned directory on the supported Unix targets. Whole-file buffers are temporary; declaration signatures/documentation are persisted locally in SQLite/FTS. Oversized, binary and non-UTF8 files have explicit unavailable records, not false absence. Bundled rusqlite avoids host SQLite and requires the WAL-reset fix.

The job returns an ephemeral directory list from its final policy census so Pi can build bounded watchers without another directory walker or persisted hierarchy manifest. These directories are not proof that watching has started. Live N-API queries remain on the existing read-only route; no maintenance operation is registered through `dispatch_read_only`.

**Automatic activation remains excluded.** The maintained candidate now consumes the ordered sectioned policy through the shared walker; the user selected project-over-machine precedence and hard curated exclusions. Its current publication/query contract and remaining bounds live in [`../analysis/README.md`](../analysis/README.md). These candidate changes do not activate or retrofit the legacy Rust-only updater. Active-project lifecycle, durable invalidation and installation remain separate integration gates.

Focused proofs: `src/index/evidence.rs::tests` covers committed readers, source/base/policy rejection, FTS replacement/deletion, bounds and unavailable states; `tests/index_lifecycle.rs` exercises the actual CLI, blocked publication and parent-pipe EOF; `../../tests/v3-native-maintenance.test.mjs` exercises the real supervisor/CLI with Unicode paths, abort and existing live N-API. A disposable Darwin probe also killed the actual Node parent with SIGKILL after its real updater opened a locked database: the updater exited without being signaled, generation stayed 1, and SQLite integrity passed. This establishes parent-death cleanup while blocked, not crash-at-every-publication-step or actual Pi teardown. Native boundary checks also pass on Linux ARM64; whole-stack installation, active consumers, watcher failures, real Pi shutdown and complete resolved relationships remain unproved.

## Read-only and mutation boundary

`dispatch_read_only` is a closed allowlist for the twelve `pi_nav_*` read/query operations. `pi_nav_symbol_range` resolves an exact definition before bounded outline rendering and returns the parsed source SHA-256 so TypeScript can reject stale cached ranges. `pi_nav_write` remains reachable only from standalone MCP edit mode and native CLI behavior.

The N-API module exports only build information and `PiNavSession.call`. It must not export, advertise, or dispatch write. jeito codeweave-pi's public `edit`/`write` transaction engine remains the sole mutation owner and imports no pi-nav module.

## Root and cwd invariant

Every shared call receives an explicit root snapshot in `OperationContext`. Shared algorithms never read or mutate process cwd.

For N-API calls:

1. TypeScript canonicalizes an ordinary request's selected root with `realpathSync.native` for the process-global map key. Cursor-only continuation recovers its original session instead; see [cursor continuation](#cursor-continuation-and-source-identity).
2. Rust canonicalizes the session root again.
3. Relative path-bearing inputs anchor under that root.
4. Explicit absolute paths and parent-relative paths may address files or directories outside that root; the root selects project-local defaults and is not a filesystem access boundary.
5. Existing explicit targets are canonicalized, including symlink targets. Missing targets retain operation-specific missing/error semantics.
6. Standalone MCP and N-API share this unrestricted explicit-path behavior while preserving operation-local roots, cancellation, budgets, and typed completeness.


## Search seed identity and source evidence

`src/ops/search.rs::tool_search_output` retains a canonical exact file as the seed; it never converts it into parent-plus-basename or falls back from an unavailable explicit path to the project. Valid directory globs are bypassed for an exact file, before candidate collection, caps and ranking. `src/search/mod.rs::scoped_files` shares that distinction with fuzzy search, case-variant discovery and caller scanning while delegating directory policy to `src/walk.rs`; it is foreground-only, not maintenance admission. Search-local `rel` retains the filename when the seed and source are identical. The regression includes hundreds of neighboring decoys, glob metacharacters, aliases, both visibility modes, and all five existing search routes.

`src/search/fuzzy.rs` derives path terms relative to the project/request, not host directories. Explicit outside-root files retain filename evidence. Bare identifiers and pipe terms survive scaffolding removal; normalization cannot erase every token of a nonempty vocabulary query. These fixes do not add a route, semantic model or index.

For TS/JS, `src/search/declarations.rs` supplies both exact and fuzzy declaration projections from the maintained source classifier. The [analysis source contract](../analysis/README.md#pinned-provenance-and-adaptations) owns its byte identities, signature/comment spans and lexical parents. Navigation compiles those helpers in its existing parser context; it does not start Node or decode a graph to discover declarations. Other languages retain their current structural paths, and protected read outlining is not migrated.

Behavior discovery also includes syntax-bounded implementation text and Markdown sections, preambles and headerless documents through `src/search/fuzzy.rs`. Legacy outlines need a unique exact parser span before receiving body text; missing associations retain name/signature evidence with a coverage limitation. Enclosed text is lexical evidence, not semantic operation ownership. In `src/search/mod.rs::format_fuzzy_result_typed`, a compact child index is redundant only when its exact immediate parent is a selected rich target and every nonblank signature row is already emitted verbatim. Independent same-line declarations and partly shown signatures retain their entries. This within-answer reuse does not change ranking, matches, cross-call seen state or edit authority.

Live relationships retain `src/search/callee_query.rs::CallSite` expression/target spans, immediate lexical owner and receiver through `src/search/callees.rs::connections`, caller merging and identity-keyed `src/search/lanes.rs`. Same-row declarations do not share a relationship bucket. A call inside a nested function is nested-origin evidence, not an invocation by its ancestor. Source-container/import/receiver candidates remain **candidates, not binding proof**; first-name outline lookup cannot decide a migrated relationship. Per-response source-row union preserves owner/range/site annotations when source was already printed. Legacy `grok` outline-entry and whole-file dependency-name consumers remain explicitly structural.

Candidate project-mode ranked requests carry the current allowed-file census and policy inputs through `src/search/mod.rs::OperationSources`, independently of prepared-graph readiness. Collection, dependency reads, retained-source reopening and render decoration use that admitted source owner. `enclosing_definition_with_sources`, `get_outline_str`, `markdown_enclosing_scope` and `basename_file_outline` derive labels and outlines from the same captured bytes as matching rows. A selected path or shared path/mtime cache cannot certify a later read **or a cache hit**; basename fallback also selects from the admitted census. Missing decoration is omitted rather than recovered through an unrestricted reader. The `ranked_corpus_tests` cover excluded reads and a captured-before/current-after fixture with a populated shared cache. This boundary does not change explicit non-admitted audit/legacy operations or protected read/edit.

Ranked declarations use exact shared TS/JS facts, with `src/search/scope.rs::declaration_end_line` retained for unmigrated structural declarations. `src/search/declarations.rs::class_inventory` identifies class/member headers; the existing parser supplies immediate field-value boundaries absent from the carrier. `src/search/mod.rs::render_ranked_regions_with_progress` pages complete pending headers against the allowance and existing `Progress`, merging overlapping header rows into atomic units. Reserving every header made real QueryBuilder output insensitive to reduced allowances, so a whole inventory is not an indivisible floor. Bodies receive no extra allowance, and pending relationships are not discarded when inventory finishes. Bare fields/wrappers and same-row positions remain represented; unsupported shapes and per-line failures stay explicit. This is not semantic method prioritization.

Ranked render previews do not mutate native expansion/delivery state. A refused card cannot become already shown; accepted per-group rows govern continuation separately from native seen-state. Actual same-agent delivery/history remains unproved. Default read/edit contracts are unchanged; ranked authority is staged until the final composed reply is accepted, as described in the [result contract](#result-contract).

Focused proof owners include `src/search/declarations/tests.rs` for live composition, field/wrapper/header allowances, same-row identity and refused-card seen-state, plus the existing `src/ops/search.rs` exact-file/source-row tests and `src/search/scope.rs` declaration-boundary tests. The maintained candidate's registered checks independently compare displayed source and class headers with current files and the TypeScript compiler parser. These checks establish their named boundaries, not complete graph/language coverage or installed-runtime activation.

### Prepared connections retain live selection

`src/ops/search.rs::tool_search_output` retains the live search result, ranking, counts and source identities. `src/search/prepared.rs::load_for_live` associates selected declarations with captured graph spans; `LaneBundle::enrich` adds their connections to the existing live lanes. It does not replace discovery with the donor's name/FTS ordering. Retained metadata is not delivered evidence: reference and lane rendering must coexist, reserve existing live evidence before optional enrichment and deduplicate only rows actually emitted, not a selected target's entire range. Graph-target omissions come from prepared metadata, never total mixed live matches. TS/JS association uses exact parser identity; unsupported associations remain disclosed or live-only. The selected project's current corpus, policy, captured bytes and interpretation are validated in one read-only SQLite transaction before projection.

The private `analysisRelation` request on the existing search operation serves selected `trace` callers/callees: resolve exactly one identity, select the requested direction, and page stable edge rows before source-display deduplication. Ambiguous, missing, valid-zero and unavailable states are distinct. `FormattedSearchResult::omitted_relationship_evidence` propagates rendered omissions into completeness; an incomplete directed page has no `nextPage`, because advancing by its requested limit would skip undisplayed evidence. A smaller limit can retain complete pages. Calls and marked function references retain their meaning; inferred/synthesized positions are not certified invocation sites. The explicitly selected candidate bypasses CRG only for these two relations; other consumers remain unmigrated.

Ranked projection also retains stored construction, ordinary reference, import/export and heritage facts through the same bounded source renderer. Canonical TS/JS `new` expressions retain their full target/receiver and immediate source owner. Other recorded positions may identify a type, import or export statement, and coordinate-less dependencies remain aggregates without invented sites. Heritage does not establish signature satisfaction or dispatch; module dependencies do not establish imported-symbol identity. Source rows can be reused across roles without deleting those distinctions. `.5` producer default-export corrections and their limits are owned by [`../analysis/README.md`](../analysis/README.md#pinned-provenance-and-adaptations).

The TypeScript bridge obtains live output before optional enrichment, preserving the request deadline and certification time. Missing/stale/refused analysis can leave the **initial** policy-admitted live answer plus a limitation; it never starts preparation. `../../src/core/pi-nav-native.ts::callAnalysisNavigation` retains that answer privately as `NativeOutput.liveFallback`. Oversized enrichment can reuse it without another collection or deadline reset. A continuation's owner descriptor is not a saved live answer: changed publication/admission must refuse rather than fall back. Candidate builds and registered checks do not activate installed tools or automatic indexing.

The query process performs graph SQL through this native reader only. `src/search/prepared.rs::open_capture` owns schema/identity/generation/manifest and admission validation in one transaction; `validate_continuation` pins the actual publication, including its optional policy stamp. The TypeScript adapter keeps filesystem-only privacy and pre/post identity checks. Initialization and Node SQL inspection stay in the existing maintenance child; even a short-lived second SQLite copy can invalidate WAL coordination during concurrent queries. [Connection ownership and its bounded reproduction](../analysis/README.md#keep-writer-and-reader-connection-lifetimes-separate) own the rationale and proof limits.

### Ranked collection survives optional enrichment

`src/search/capture.rs`, `src/session.rs` and `src/ops/search.rs` retain an eligible symbol/fuzzy collection, its operation sources and live lanes under a single-use private handle. In the candidate admitted path, `../../src/core/pi-nav-native.ts::callAnalysisNavigation` validates corpus policy before collecting live output, then separately admits optional prepared evidence and resumes through `ranked_capture_v1`. Query/root/options identity cannot change. Directed transitional requests whose spelling changes retain the existing fresh-search path. Neither path indexes or starts maintenance.

Resume independently rereads retained bytes and validates canonical destinations before and after optional work. `OperationSources` also records alias-derivation inputs, relied-on absence, file kinds and path-resolution probes; a new nearer tsconfig or preferred extension can invalidate reuse even when target/caller bytes are unchanged. The admitted TS/JS path uses only the existing tracked binder, normalizing import paths before probes; mixing in legacy resolution previously invalidated ordinary `../src/target` imports. Non-admitted and unmigrated legacy probes still refuse unsupported retention rather than guessing. The current bounds are four handles, 30-second admission lifetime, 100 matches, 2,048 source files, 4,096 dependency probes, 32 MiB retained source/request bytes per handle and 64 MiB per session; these are retention bounds, not exact heap accounting or corpus-freshness proof.

An initial retention refusal on an otherwise compatible addon must not disable working prepared evidence: the bridge keeps the existing fresh enriched search after admission. An **attempted resume** that fails instead returns the saved live answer without recollection or a reset deadline, and drops its supplied snapshots so certification refetches visible files through admission. Private handles/refusal fields never become public or persisted output. Resume renders the retained collection directly; it cannot fall through to generic rendering that starts discovery again.

Focused native tests cover single use, interleaving, bounds, cancellation, same-length source/config changes, re-exports, negative probes, symlink destinations and late-added sibling callee evidence. Registered candidate checks require one-collection enrichment, stale-resume live preservation and prepared connections for explicit-extension imports without recollection. These are bounded checks, not final same-agent delivery or whole-corpus continuation claims; the work board owns fresh joined acceptance.

### Matches count meaningful context rows

`src/search/matches.rs::render_group_block` selects nonblank context for both automatic tiers and explicit `contextLines`. Code/structured-data rows containing only opening or only closing delimiters do not consume that quota; empty values such as `[]` and `{}` remain meaningful, and Markdown delimiter rows are retained. Matching rows are always inserted independently, even when blank or delimiter-only. Window union removes duplicate context, not occurrence spans. Existing matches tests prove exact context rows across two code files, JSON empty values, Markdown hierarchy and delimiter matches. Version-4 cursors split oversized owner groups between occurrence rows while retaining hierarchy and span identity; an indivisible row/context or metadata block that cannot fit returns an explicit incomplete-audit error. This source behavior does not imply installed-addon activation.

### Matches reuse parsed TOML key context

`src/search/matches/toml_context.rs::TomlContext` parses the already digest-verified matched snapshot through the existing `toml::de::DeTable` API. `matches.rs::line_context` reuses its ordinary owner/outline result: the smallest parser-owned byte region containing all occurrences on a row supplies a qualified key path. Inline sibling hits select their common container; table-header spans are not interpreted as table bodies. Quoted keys and array indices retain distinct identities. Malformed TOML, clipped/different rows and oversized paths retain exact matching without this optional context. `write_group_record` drops TOML context before refusing an oversized record, so added labels cannot alone remove otherwise deliverable occurrences. Labels add no source rows or edit authority; the existing snapshot, retained-page and final TypeScript proof/fitting owners remain unchanged. Focused `search::matches` tests cover these boundaries; installed activation is separate.

## Result contract

`ToolOutput` in `src/output.rs` contains native model-facing text, a required structured envelope, and optional operation-local `SourceSnapshot` values owned by `src/source_proof.rs`. Text remains established pi-nav rendering; structured fields carry bounded paths, locations, source rows, completeness, and diagnostics.

`src/napi.rs` converts snapshots into optional top-level `NativeOutput.sourceSnapshots`. Standalone MCP serializes only `text` and `structured`; model content, schema-v1 metadata, and persisted `details.native` never receive snapshot text or raw digests.

Matches `render_page` transports private snapshots only for files represented by retained page groups, using the canonical identities captured during source verification rather than resolving paths again. Its existing pagination test now checks exact `(path, line, startByte, endByte)` occurrence identities, rejects duplicates and checks each page's snapshot file set. The strengthened test first exposed an undisplayed `small.ts` snapshot leaking into earlier pages; filtering the outgoing snapshot set fixed it without changing cursor shape, page text, occurrence counts or read/edit. This is transport scoping, not proof of final same-agent delivery.

`source_proof_v1` and `pi_nav_symbol_range` are additive required addon capabilities under addon API version 2. Hidden `pi_nav_source_proof` is N-API-only, read-only, session-anchored, bounded to 32 files, and returns independent per-file status. Explicit external paths use the same current-byte proof contract. Neither capability is a public jeito-codeweave-pi tool; symbol ranges are consumed by `read` selectors and frontmatter validation.

Typed source rows are candidates until `src/core/source-authority.ts` validates a matching operation-local snapshot or hidden proof result. TypeScript then applies the existing normalization contract and `SnapshotStore.recordTrustedProof` mints the public edit identity/seen-line authority. Edit preflight still rereads current bytes.

Ranked final accounting belongs to `../../src/tools/grep.ts::registerGrepTool`: pinned `js-tiktoken` 1.0.21 with bundled `o200k_base` counts ordinary text after source manifests, framing, repairs, interpretation and authored-document additions. The whole returned text must fit 4,000 reference tokens; native estimates only guide selection, and byte guards remain separate. `../../src/core/source-authority.ts::prepareSourceAuthority` and `prepareExactLeads` stage proof without granting it to discarded previews. Only an accepted composition commits authority and exposes its candidate cursor. Failed required source verification preserves independently certified rows but withholds continuation credit. No-origin and exhausted-fitting refusals remain distinct; neither clips source or recollects. This boundary is returned-tool-text proof, not provider delivery or budget enforcement for other tools.

An oversized public matches response remains an incomplete audit, never an automatic ranked replacement. `../../src/tools/grep.ts` no longer issues the unscoped second search; the error preserves the audit intent and names smaller path batches or cursor context reduction. Successful matches pagination is unchanged. This transport-error proof does not resolve every native renderer ceiling or indivisible-group case.

Native log summaries treat `log` as a Git revision range, not command options. `src/diff/mod.rs::diff_log` now places `--end-of-options` before that input, matching the existing Git-ref path. The existing log test reproduced an option-shaped range creating a file inside its disposable repository, then passed after the one-line correction; all 25 diff-owner tests pass. This fixes the source implementation of the native CLI/`pi_nav_diff` log argument, not a new public diff field or the already-loaded addon. It does not establish every Git-configured transformation as raw source evidence.

## Cancellation and deadlines

One `OperationContext` atomic flag and deadline flow through dispatch, walkers, batch reads, search phases, and bounded Git-child loops. Do not add a second cancellation abstraction or process supervisor.

N-API behavior:

- napi-rs `AsyncTask` keeps blocking work off the JavaScript thread; no Tokio feature is enabled.
- The TypeScript FIFO owns queueing and snapshots one absolute deadline before queue entry. Queue wait consumes that budget; an expired follower is never dispatched, and native execution receives only the remaining time.
- Public grep (`../../src/tools/grep.ts::registerGrepTool`) additionally shares one 25-second cooperative allowance across search and follow-up source/lead proof calls; a proof cannot start a fresh allowance, and late results are rejected. This is not preemptive native-worker termination or a hard event-loop latency guarantee. `../../tests/v3-grep-cap-fallback.test.mjs` uses a controlled clock and the real certification coordinator to exercise remaining-budget forwarding and late-result refusal.
- TypeScript rejects an already-aborted request before native work.
- Because napi-rs assigns `AbortSignal.onabort`, TypeScript forwards caller abort into a private `AbortController`, passes only that private signal to Rust, and removes its listener in `finally`.
- The Rust abort callback flips the existing atomic flag. Valid walker/batch partials may resolve with honest incompleteness; operations without a valid partial reject.
- Cancelled Git children are killed and waited before return.

## Panic and FFI boundary

Release artifacts use `panic = "unwind"`. There is no separate CLI/addon panic profile.

`Task::compute` catches unwind, converts the payload to a stable `NativeError`, and disposes the payload inside a second `catch_unwind`; a pathological secondary panic payload is forgotten rather than unwinding across FFI. Synchronous constructor/build-info paths contain no external-input `unwrap`/`expect` and use the narrow napi-rs catch boundary where applicable.

This contains ordinary Rust panics. Undefined behavior, allocator aborts, or foreign-code crashes can still terminate Pi; isolated child load probes test the addon without pretending in-process code has child-process isolation.

## Sessions, caches, and concurrency

`NativeSession` owns root-specific cache/session state. Existing parse/outline/Bloom caches retain their current thread-safe implementations. The global Rayon pool is configured once for both CLI and N-API.

Node's module cache owns one addon instance per Pi process. `Symbol.for("jeito-codeweave-pi.pi-nav-native.v1")` owns one load promise and a map from canonical root to `{ session, tail }`. Calls serialize per root for deterministic session behavior and bounded work; different roots may execute independently. A rejected tail cannot poison the next call.

No daemon, PID file, socket, cross-Pi singleton, idle timer, scan cache, or same-root scheduler is part of this architecture.

### Cursor continuation and source identity

`../../src/core/pi-nav-native.ts::callPiNav` locates an opaque grep cursor among the existing native sessions before resolving the current request's root. It retains the raw token and original query context rather than creating another cursor registry or interpreting the token. Unknown or ambiguous ownership fails without creating a session; Rust's normal continuation still owns expiry, eviction, source-drift validation and dataset access.

The private `pi_nav_grep_cursor_owner` operation in `src/napi.rs::NativeCall::run` uses `Session::contains_cursor`: a non-mutating membership lookup, not expiry cleanup. It stays on the existing blocking worker because even its mutex acquisition can block. Lookups bypass unrelated JavaScript FIFO tails; the actual continuation joins its owning root's FIFO. A snapshot of cached roots bounds lookup work; the sequential native hops consume the original abort/deadline allowance. This is not a guarantee of constant lookup cost or independent native-worker capacity.

The bridge adds `sourceRoot` outside `structured`. `../../src/tools/grep.ts::registerGrepTool` resolves native evidence and exact leads against that original root, retains it for native proof calls, and uses the agent's cwd when formatting authority paths. This separates source identity from display context: a copied external authority path must reach the original file, not a same-name cwd decoy. Neither the root hint nor full snapshots enter persisted `details.native`. Additive capability `grep_cursor_owner_v1` gates routing: an older loaded addon gets an explicit restart/rebuild error, not a cwd fallback. `../../scripts/pi-nav-build.mjs` requires the capability and smoke-executes the private lookup; `../../tests/v3-pi-nav-native.test.mjs` covers routing/queues/cancellation/budget/compatibility and `../../tests/v3-live-source-authority.test.mjs` covers reusable external paths for typed rows and exact-lead expansion.

Ranked fitting uses `ranked_render_v1`, `src/search/continuation.rs::RankedCursor` and the existing bounded session store. Private `renderRanked` requests keep one immutable original-progress handle; they may lower the render allowance but cannot change question, focus, root, source identity or admission, nor rerun collection/ranking. Discarded attempts never advance that origin. An explicit all-visibility capture remains in that mode without fabricated prepared admission. The bridge permits an unchanged private origin plus a refusal reason only for an empty incomplete page with no public cursor; prepared admission/publication checks still precede accepting that refusal, which carries no fabricated `analysis`. Positive pages retain their full frozen-investigation checks. Older addons lacking the capability refuse rather than silently ignoring the contract; [current runtime limits](../../docs/current-truth.md#active-native-migration) distinguish the protected installed addon from the isolated candidate.

## Platform and delivery boundary

Current-host builds copy the addon and CLI to stable paths, normalize the Darwin addon install name, and ad-hoc sign macOS artifacts only so development load/check works. The same script now owns exact four-target mapping, native compatibility checks, production signing/notary orchestration, literal dependency staging, the sorted release manifest, staged check, and atomic archive/checksum output. Production macOS remains a separate trust gate: Developer ID signing, hardened runtime, secure timestamp, Accepted notarization, and actual quarantined online/offline load are required; if standalone ticket stapling prevents offline tar acceptance, P5 uses its predeclared stapled-DMG branch or remains blocked. Query-time never builds, downloads, extracts, repairs, or searches PATH.

## Documentation lifecycle

Update documentation in the same phase as the code:

- owner/data-flow/invariant change -> this file;
- imported source/version/adaptation or sync procedure -> `UPSTREAM.md`;
- contributor reading order/commands -> `AGENTS.md`;
- external behavior, applied symbol/test, or revalidation trigger -> native-contract digest;
- public install/repair/tool behavior -> canonical root README/setup/evidence docs.

Do not create progress logs, dated architecture reviews, research folders, or another N-API document. If a detail is obvious from one function and has no cross-file invariant, keep it in code/tests rather than adding prose.

## Native verification contract

P3 closes on correctness and containment:

- fmt, Clippy with all features/targets, and all-feature Rust tests;
- current-host addon and CLI build/check;
- foreign-cwd root/path escape tests for every path-bearing operation;
- pre-abort, queued abort, queue-budget expiry without native dispatch, in-flight cancellation, caller-signal preservation, and listener cleanup;
- event-loop liveness and unpoisoned FIFO behavior;
- panic/error/partial-result mapping;
- module/root-session reuse and root isolation;
- missing/corrupt/wrong-target/version/capability isolated child probes;
- no N-API write export/capability/dispatch;
- this file, `UPSTREAM.md`, `AGENTS.md`, and the native-contract digest updated after the final implementation edit.
