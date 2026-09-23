---
title: "pi-nav native runtime contracts digest"
description: "Source-backed digest of napi-rs, Node, Rust/Cargo, npm staging, Apple signing, and Pi-package contracts relied on by the pi-nav N-API bridge and release lifecycle."
tags: [jeito-codeweave-pi, upstream, pi-nav, napi, release-lifecycle, evidence-digest]
created: 2026-07-13
updated: 2026-09-21
status: active
owns: "Source-backed napi-rs, Node, npm, Apple, and Pi-package contracts for pi-nav"
audience: contributor
related: [README.md, ../../native/pi-nav/UPSTREAM.md, ../../native/pi-nav/ARCHITECTURE.md]
---

# pi-nav native runtime contracts

This is the compact source-backed digest for external behavior relied on by the pi-nav N-API bridge, jeito-codeweave-pi consumer adapters, and package/release lifecycle. It is evidence, not a plan or progress log. Read the relevant section before changing the N-API boundary, public-tool integration, P5 delivery, or P7 installed-package gates, and whenever a dependency/runtime floor changes.

## Maintenance rule

For each relied-on contract, keep five facts together: pinned source/version, contract, local application, proving test, and revalidation trigger. Update this digest in the same phase as the affected code. Do not copy whole websites, raw research logs, or temporary experiments into the repository.

- Design and runtime invariants belong in `native/pi-nav/ARCHITECTURE.md`.
- Imported-code provenance and upstream synchronization belong in `native/pi-nav/UPSTREAM.md`.
- Contributor reading order and commands belong in `native/pi-nav/AGENTS.md`.
- User install/repair behavior belongs in canonical root README/setup docs.

## N-API task and value boundary

### napi-rs AsyncTask and AbortSignal

- Source: napi-rs concepts, <https://napi.rs/docs/concepts/async-task>
- Locked source version: `napi` 3.10.5, `napi-derive` 3.5.10, and `napi-build` 2.3.2 in `native/pi-nav/Cargo.lock`; inspected runtime behavior is in `bindgen_runtime/js_values/task.rs` and async-work execution code.
- Context7 lookup: resolve `napi-rs`; use the official AsyncTask documentation and then the pinned crate source for generated/runtime behavior.
- Contract:
  - `AsyncTask<T>` runs `Task::compute` on libuv work threads and returns a Promise without requiring Tokio.
  - `AsyncTask::with_optional_signal` wires queued-work cancellation, but already-running operations still need cooperative cancellation through pi-nav's atomic flag/deadline checkpoints.
  - napi-rs converts `AbortSignal` by assigning its own `onabort` handler and does not expose a reliable pre-aborted check to the Rust task. jeito codeweave-pi therefore rejects pre-abort in TypeScript and forwards caller abort into a private `AbortController`; the caller-owned signal is never passed directly to napi-rs.
- Applied in: `native/pi-nav/src/napi.rs` (`PiNavSession::call`, `Blocking<T>`, private `pi_nav_grep_cursor_owner`) and `src/core/pi-nav-native.ts` (`callPiNav`). Cursor routing reuses this worker/signal contract; `native/pi-nav/ARCHITECTURE.md#cursor-continuation-and-source-identity` owns the cross-file invariant.
- Proved by: `tests/v3-pi-nav-native.test.mjs` covers pre-abort, caller `onabort` preservation, listener cleanup, cross-reload queued abort, queue-budget expiry without native dispatch, in-flight walker cancellation, honest partials, event-loop liveness, and cursor lookups sharing the original total budget; `napi::tests` calls `Task::compute` directly. The package build smoke also executes the private membership lookup.
- Revalidate when: the locked `napi` patch/minor changes, signal conversion changes, Node's AbortSignal behavior changes, or Tokio features are proposed.

### Structured JavaScript result

- Source: napi-rs values/type conversion documentation, <https://napi.rs/docs/concepts/values>
- Inspected source version: `napi` 3.10.5 with `serde-json`.
- Contract: bare `serde_json::Value` is not a valid `AsyncTask::JsValue`; one public `#[napi(object)]` wrapper containing `text: String` and `structured: serde_json::Value` is required. No JSON stringify/parse crosses the addon boundary.
- Applied in: `native/pi-nav/src/napi.rs` (`NativeOutput` and `From<ToolOutput>`); domain data remains owned by `src/output.rs`.
- Proved by: all-feature addon compilation, current-host load/check, and structured-output/additive/malformed negative controls in `tests/v3-pi-nav-native.test.mjs`.
- Revalidate when: napi-rs changes `Task::JsValue`/`TypeName` requirements or the `serde-json` feature is changed.

### R1 internal source snapshots

- Relied-on sources: the same pinned napi-rs 3.10.5 object/value conversion above plus the current `NativeOutput` additive-field validation in `src/core/pi-nav-native.ts`.
- Applied contract: optional top-level `sourceSnapshots` and additive build capability `source_proof_v1` extend the existing napi object wrapper. Full source never enters schema-v1 `structured`, model text, persisted `details.native`, or MCP `structuredContent`. `pi_nav_source_proof` is internal N-API dispatch only and is neither advertised by MCP nor registered publicly.
- Local application: `native/pi-nav/src/source_proof.rs`, `src/output.rs`, `src/napi.rs`, `src/dispatch.rs`, read/search operation owners, `src/core/pi-nav-native.ts`, and `src/core/source-authority.ts`.
- Proved by: native source-proof/N-API/MCP privacy and root/size/encoding/cancel cases, one-hidden-proof-call/reuse tests, QMD stale-claim negatives, scoped leakage searches, and current-host addon build/check.
- Revalidate when: napi-rs object conversion, addon/result major, MCP serialization, package capability validation, or the source-proof payload shape changes.

### Panic handling

- Sources:
  - napi-rs error handling, <https://napi.rs/docs/concepts/error-handling>
  - Rust `catch_unwind`, <https://doc.rust-lang.org/std/panic/fn.catch_unwind.html>
  - Cargo profiles, <https://doc.rust-lang.org/cargo/reference/profiles.html#panic>
- Contract:
  - `panic = "abort"` cannot be caught and is unacceptable for the in-process addon.
  - napi-rs does not catch a panic produced inside `Task::compute`; pi-nav catches it before returning through N-API.
  - Rust warns that dropping a caught panic payload may itself panic. Payload message extraction and disposal therefore use a second `catch_unwind`; only the pathological secondary payload is forgotten.
  - The release profile is `panic = "unwind"` for the package's release artifacts; no separate CLI/addon profile machinery is maintained.
- Applied in: `native/pi-nav/Cargo.toml`, `src/napi.rs` (`Blocking<T>`, `dispose_panic_payload`), and `napi::tests`.
- Proved by: ok/error/string-panic/non-string-panic/drop-panics-payload/double-compute Rust tests plus isolated addon child load/check.
- Revalidate when: panic strategy, napi-rs task implementation, or Rust toolchain changes.

## Node and platform floors

### Node-API and TypeScript

- Sources:
  - Node v22.19.0 Node-API, <https://nodejs.org/download/release/v22.19.0/docs/api/n-api.html>
  - Node v22.19.0 TypeScript, <https://nodejs.org/download/release/v22.19.0/docs/api/typescript.html>
  - Node v22.19.0 modules, <https://nodejs.org/download/release/v22.19.0/docs/api/modules.html>
- Context7 lookup: resolve `Node.js`; use the v22.19.0 documentation matching Pi's engine floor.
- Contract:
  - Node-API 10 is supported by the chosen Node floor; pi-nav builds with napi-rs `napi10`.
  - The package engine is `>=22.19.0`.
  - Runtime `.mjs` → `.ts` imports must stay within Node's erasable TypeScript syntax and explicit-extension rules; packaged dependencies cannot assume TypeScript under `node_modules` is stripped.
  - Node's module cache owns one loaded addon instance per Pi process; the process-global symbol preserves root sessions/FIFO tails across extension reloads.
- Applied in: root `package.json`/lock, `native/pi-nav/Cargo.toml`/lock, `src/core/pi-nav-native.ts`, and `scripts/pi-nav-build.mjs`.
- Proved by: supported-Node addon load, extension reload/session reuse, exact three-export test, and current-host build/check.
- Revalidate when: Pi's Node engine floor or TypeScript loading strategy changes.

### Linux and macOS

- Sources reviewed 2026-07-14:
  - Node 22.19 BUILDING/platform floor, <https://github.com/nodejs/node/blob/v22.19.0/BUILDING.md>
  - Apple notarization requirements and plug-in behavior, <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>
  - Apple command-line/custom notarization workflow, accepted containers, online tickets, and standalone-binary stapling limitation, <https://developer.apple.com/documentation/security/customizing-the-notarization-workflow>
  - Apple Developer ID distribution signing, <https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac>
  - Apple Gatekeeper overview, <https://support.apple.com/en-us/102445>
  - pinned implementation/reference note from oh-my-pi `bb35e79`, <https://github.com/can1357/oh-my-pi/blob/bb35e791890d33327ff184b1e94621d074b5bad4/docs/macos-signing-notarization.md>
  - POSIX.1-2024 `rename`, <https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html>: replacement keeps the destination name visible and open references retain the old contents; cross-filesystem replacement can fail.
- Contract:
  - GNU/Linux release artifacts target glibc 2.28, matching Node 22's supported floor; no glibc-2.17 cross-toolchain promise is made. Matching hosts must inspect required `GLIBC_*` versions rather than infer ABI from the target name.
  - macOS release artifacts target macOS 11.0 and build natively per architecture. Developer builds normalize/sign and check staged addon/CLI candidates before renaming each to its stable destination. Never truncate a loaded inode; fail rather than fall back to cross-filesystem copy. This is per-file atomic replacement, not a two-file transaction or an upgrade of already-loaded code.
  - Ad-hoc signing is not production distribution. Apple requires Developer ID signing, hardened runtime, secure timestamp, and notarization for distributed/quarantined executable code; quarantined plug-ins require notarization. Production pi-nav signs/notarizes the staged addon and CLI, never checkout binaries. Selector validation remains before dependency staging; the staged root supplies the signed-byte load check. Actual downloaded-container acceptance remains a separate release proof.
  - Apple accepts ZIP, disk image, and signed flat package submissions. Tickets for standalone Mach-O binaries exist online but cannot be stapled to the binaries or ZIP. P5 therefore has a fixed tar candidate → stapled-DMG fallback for offline first-load acceptance; an unavailable credential or failing DMG blocks production rather than authorizing `xattr` removal.
  - The pinned oh-my-pi note is a reference for practical Developer ID/notary smoke and the bare-Mach-O stapling limitation, not code to copy. Its Bun/JIT/library-validation entitlements are not automatically applicable to pi-nav; derive any entitlement from an observed pi-nav failure and Apple guidance.
- Applied in: target/artifact mapping in `src/core/pi-nav-native.ts`; build/check/install-name normalization, ABI floors, signing/notary orchestration, manifest/staging/archive in `scripts/pi-nav-build.mjs`; package regressions in `tests/v3-pi-nav-package.test.mjs`.
- Proved now by: current-host build/check, relocatable Darwin install name, development archive, fail-closed signature/notary branches, direct installed-package execution of every pi-nav-backed public tool, Pi 0.80.5/0.80.6 offline restarts, stopped same-path upgrade/repair, and matching Linux arm64/x64 344-file release candidates with official Pi 0.80.6 durable install/restart. Still required only before Apple production publication: darwin-x64 ABI/load, real Developer ID/Accepted notarization, and actual quarantine online/offline acceptance.
- Revalidate when: Node/platform floors, Xcode/notary behavior, distribution container, signing identity/policy, or host Pi loading model changes.

### Recent simple release-procedure review

- Window: 2026-04-14 through 2026-07-14; stable Apple/GitHub/manylinux documentation was also checked as canonical authority.
- Sources: current GitHub standard runner matrix, <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>; current napi-rs package template, <https://github.com/napi-rs/package-template/blob/main/.github/workflows/CI.yml>; manylinux images, <https://github.com/pypa/manylinux>; recent explicit glibc-2.28 zigbuild procedure, <https://github.com/hzzgithub/DeepSeek-TUI/commit/41843e63b0b72fdc2331a89a5f757d82ae4c6ab5>; recent direct Apple signing/notary/DMG procedure, <https://github.com/momenbasel/Phosphor/commit/fecffb9934ff85e38970f9390cd01572c172e793>.
- Decision: keep `scripts/pi-nav-build.mjs` as the only package owner. Matching native hosts run its existing build/check/package contract and preserve immutable artifacts. CI automation is deferred; if later requested, four standard native runner labels are preferred over QEMU, Rosetta-only proof, custom runners, npmgen, cargo-dist, or another package framework.
- macOS correction: Developer ID signing plus Accepted notarization is required only for production distribution of quarantined executable/plugin code. A stapled DMG is not presumed mandatory: first test the notarized tar online and offline (branch A); use the identical-tree notarized/stapled DMG only if offline tar acceptance fails (branch B). Local development and non-distributed use remain valid with explicitly development-only ad-hoc artifacts.
- Revalidate when: target-host availability, Apple trust behavior, the archive/container decision, or the chosen automation posture changes.

## Package and upstream references

### npm frozen production staging

- Sources reviewed 2026-07-14:
  - npm 11 `npm ci`, <https://docs.npmjs.com/cli/v11/commands/npm-ci/>
  - npm 11 `package.json` fields/pack exclusions, <https://docs.npmjs.com/cli/v11/configuring-npm/package-json/>
  - Node 22.19 `crypto`, <https://nodejs.org/download/release/v22.19.0/docs/api/crypto.html>
- Contract:
  - `npm ci` requires lock/package agreement, removes any existing staging `node_modules`, never rewrites package/lock, and is the frozen release install.
  - `--omit=dev --omit=peer` omits build-only and Pi-host packages from disk; `--ignore-scripts` prevents dependency lifecycle execution. Package checks must import all declared production modules because script suppression is accepted only when runtime works without them.
  - npm's `files`/`npm pack` semantics always exclude `node_modules` and `package-lock.json`; they cannot implement this self-contained local-path release. A custom literal staging allowlist plus host tar/DMG and Node SHA-256 is required; this is not an npm publication path.
  - Generated local navigation artifacts beneath source roots—including `src/graphify-out`, `.codanna`, and `.fastembed_cache`—are not runtime package inputs. The package owner excludes them explicitly rather than inheriting incidental working-tree state.
- Applied in: P5 `package.json`/lock and `scripts/pi-nav-build.mjs package`; no query-time owner.
- Proved by: `tests/v3-pi-nav-package.test.mjs` lock immutability, production-tree imports, dev/peer absence, sorted manifest hashes/modes, exact allowlist/root including generated-state exclusion, link rejection, cleanup, packaged check, and offline restart tests.
- Revalidate when: npm major/lock format, dependency tree, package transport, source-directory allowlist, or Pi package installation behavior changes.

### Pi local packages

- Source pinned to Pi `v0.80.6`: <https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/packages.md>
- Contract:
  - local package paths are recorded without copy or dependency installation; relative paths resolve against settings and identity is the resolved absolute path;
  - the release must provide a durable absolute package directory containing production dependencies and native artifacts before `pi install <absolute-directory>`;
  - Pi core imports belong in peer dependencies and are not bundled. jeito codeweave-pi uses `@earendil-works/pi-coding-agent:"*"` as a host peer while its actual source imports remain type-only.
- Applied in: P5 package metadata/staging/check, root README, and `docs/setup.md`.
- Proved now by: isolated `PI_CODING_AGENT_DIR` local-path settings/restart under installed Pi 0.80.5 and official Pi 0.80.6, unchanged package bytes, package-root dependency resolution, no bundled peer, loaded `ls` source/schema/native query, and stopped upgrade/repair at the same path.
- Revalidate when: pinned/current Pi package manager semantics, core peer guidance, or settings identity changes.


### Pi custom tools, details, and built-in override

- Sources pinned to earendil-works Pi `v0.80.6`:
  - extension contract, <https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/extensions.md>
  - same-name override example, <https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/examples/extensions/tool-override.ts>
  - built-in ls, <https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/src/core/tools/ls.ts>
  - tool result/session types and provider conversion under `packages/coding-agent/src/core/extensions/types.ts`, `packages/agent/src/harness/messages.ts`, and `packages/ai/src/api/*`.
- Context7 lookup: `/earendil-works/pi`, custom tools/extensions/details/active tools.
- Contract:
  - registering a custom tool with the same name replaces the built-in definition; Pi 0.80.6 includes a built-in alphabetical `ls({path,limit})`, so P4 must prove jeito-codeweave-pi's richer same-name `ls` is the one active definition;
  - active-tool selection is by name, so `PUBLIC_TOOLS` contains `ls` once rather than inventing a second name;
  - tool-result `details` is persisted in session entries and supplied to renderers/branch reconstruction, while provider request conversion emits tool `content`; bounded typed native metadata belongs in `details.native`, never stringified beside model text;
  - runtime dependencies must be production dependencies for installed packages; P4 adds none and P5 validates the staged package.
- P4 application owners: `index.ts`, `src/core/harness-result.ts`, `src/core/pi-nav-native.ts`, `src/tools/{ls,find,grep,trace,diff}.ts`, and the typed smart-summary provider. The P4 gate passed; P5 repeats these contracts from the installed package.
- Proved by: loaded-tool source/schema test, built-in-only `limit` rejection, exact one-name activation, session-details/content separation test, TUI rendering test, and P5 package/runtime import smoke.
- Revalidate when: Pi's pinned version, custom-tool override semantics, active-tool APIs, tool-result persistence/provider conversion, or built-in ls schema changes.

### Borrowed oh-my-pi mechanism

- Source: `can1357/oh-my-pi` commit `bb35e791890d33327ff184b1e94621d074b5bad4`, especially `crates/pi-natives/src/task.rs` and its napi-rs build files.
- Contract: borrow only the small AsyncTask/cancellation/panic-disposal mechanics and build lessons. Do not port its global crash handler, extraction loader, npm leaf packages, CPU variants, Tokio runtime, or unrelated native modules.
- Applied in: `native/pi-nav/src/napi.rs` and `scripts/pi-nav-build.mjs`; provenance remains in `native/pi-nav/UPSTREAM.md`.
- Proved by: P3 safety tests and exact dependency/file-boundary searches.
- Revalidate when: the borrowed implementation is materially changed or another oh-my-pi component is proposed.

### Borrowed oh-my-pi automatic seen-line pattern

- Source: `can1357/oh-my-pi` commit `bb35e791890d33327ff184b1e94621d074b5bad4`, especially `packages/coding-agent/src/tools/grep.ts` and `packages/coding-agent/src/edit/file-snapshot-store.ts`.
- Contract: grep automatically records one whole-file snapshot for eligible displayed files, emits hash headers, and records only complete non-clipped emitted lines as seen; the agent does not opt into trust for source it already saw.
- Local application: implemented by the Gate R1 automatic source-authority coordinator. jeito codeweave-pi keeps its stronger existing hash format, block support, recovery, and transactional edit engine rather than porting oh-my-pi mutation code.
- Prove with: complete/clipped row fixtures, automatic grep-to-edit, heterogeneous/capped replacement refusal, and no reassurance-read loaded-agent scenarios.
- Revalidate when: the pinned oh-my-pi grep/snapshot flow changes or jeito-codeweave-pi proposes borrowing more than the automatic seen-line principle.

## Current implementation status

P3, P4, P6, P7, Gate R2, and corrective Gate R1 are complete for verified development/runtime targets. Gate R1 includes current Darwin-arm64 development packaging and rebuilt matching manylinux 2.28 arm64/x64 candidates with official Pi 0.80.6 durable offline install/restart. Apple production publication remains explicitly deferred: darwin-x64 plus a valid Developer ID identity/notary profile and the quarantined tar → conditional stapled-DMG branch remain mandatory before release. Ad-hoc macOS artifacts are development evidence only.
