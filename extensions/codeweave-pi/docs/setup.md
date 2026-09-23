---
title: "Install, verify, and repair jeito-codeweave-pi runtimes"
description: "Core plus QMD installation, explicit optional Graphify setup, runtime checks, and unchanged existing-store boundaries."
tags: [jeito-codeweave-pi, setup, pi-install, qmd-local-models, owned-runtime, recovery]
created: 2026-07-25
updated: "2026-09-23 13Z"
status: active
owns: "Installation, verification, repair, and safe migration procedures"
audience: operator
code: [scripts/install-from-checkout.mjs, scripts/navigation-provision.mjs, scripts/qmd-model-provision.mjs, scripts/navigation-prepare.mjs, scripts/navigation-doctor.mjs, src/core/navigation-setup-planner.ts]
related: [docs/automatic-workflow.md, docs/current-truth.md, docs/decisions/r5-crg-clean-break.md]
---

# Setup, health, repair, and migration

This is the operator-facing source of truth. The current default is Core (pi-nav, CodeGraph maintenance and local code semantics) plus QMD. `npm run install:codeweave-pi` owns standalone checkout bootstrap; npm owns dependency preparation. CRG is no longer a selectable backend — its runtime, adapters, capability entry, and bundled `native/crg` source are being removed — and Graphify is the only optional Python backend. Normal Pi startup and navigation queries never install or repair runtimes. `/skill:deep-navigation-onboard` configures private provider preferences; `/skill:navigation-setup` handles explicit project choices.

**Delivery status:** the source setup/package owners now require the complete Core payload. This does not establish a released fresh-checkout installation: the active development checkout has no production maintenance runtime, and source/disposable checks are not installed or cross-machine acceptance. A bare checkout without publisher-prepared assets fails the Core gate; it does not silently compile, fetch assets, or fall back to Python. The in-progress CRG removal does not change this status.

## State and ownership

| Path | Purpose |
|---|---|
| `~/.pi/agent/navigation.yaml` | Private global automation/provider preferences; never print secret values |
| `<installed-extension>/node_modules/node-llama-cpp/` | npm-installed platform runtime for credential-free QMD inference; never a global QMD installation |
| `<installed-extension>/.runtime/` | Optional Graphify venv created by `npm run nav:provision:legacy` |
| `<installed-extension>/.runtime/.ready` | Written last after the Graphify import/version and CLI checks pass |
| `~/.cache/qmd/models/` | Postinstall-owned embedding/reranker GGUF cache; 928 MiB measured for the two models codeweave-pi installs and uses |
| `<installed-extension>/native/analysis/runtime/` | Package-owned CodeGraph maintenance/kernel/workers, WASM grammars and pinned local code model |
| `<root>/.pi-navigation.json` | Per-project lane configuration and owned scope |
| `<root>/.pi/navigation/state.json` | Persisted lane/worker/refresh health |
| `<root>/.pi/navigation/qmd/` | Lifecycle-owned QMD SQLite section index and vectors |
| `<root>/.pi/navigation/graphify/` | Graphify artifacts |
| `<root>/.pi/navigation/transactions/` | Per-lane cross-process transaction records |
| `<root>/.pi/navigation-setup.log.jsonl` | Setup/freshen audit evidence |
Retired CRG stores and configuration (for example a pre-existing `<root>/.code-review-graph/`) are left in place: they are never read, adopted, migrated, or deleted.

The bundled defaults enable policy-approved automatic Core and QMD preparation and leave Graphify disabled. Explicit host preferences remain host-owned; existing files and stores are not replaced. The legacy-only configuration seed is not the new Core setup path. Missing cloud credentials retain credential-free local inference when its prepared assets are available; startup never installs packages or downloads models.

Project identity is the nearest valid nested root, including `.git` and `.pi-navigation.json` boundaries. Never inherit a configured parent merely because it is nearby.
The backend health map behind these paths is `docs/evidence.md:current-evidence-map/lifecycle-and-backend-health#2`.

## Normal lifecycle

| Trigger | Behavior |
|---|---|
| npm package install | Installs the owned QMD fork and `node-llama-cpp` platform runtime with codeweave-pi. No global QMD command or query-expansion model is installed. |
| npm `postinstall` | Runs `pi-nav-build.mjs check-core` against shipped native/maintenance/model assets, then the existing QMD model provisioner. No Python provisioning. |
| `/navigation-setup` | Reports Core asset presence and verification commands without installing or preparing anything; presence is not a successful runtime verification. |
| `session_start` | Selects eligible unowned projects for policy-approved Core maintenance; retired CRG stores are neither ownership evidence nor a refusal reason and are never adopted or migrated. Missing assets remain explicit, with no repair or migration. |
| first broad request | Reuses startup/root coordination and starts only work not already scheduled. |
| `before_agent_start` | No synchronous docs mutation; queries use the current verified stores. |
| every 10 completed tool calls | Detached QMD reconciliation and, when enabled, an optional Graphify checkpoint; queries do not perform preparation. |
| Markdown `edit`/`write`/delete/move | Enqueues exact changed paths through the existing per-root lane; QMD replaces only changed section documents and vectors. |
| `docs_search` query | Searches prepared QMD and verifies returned selectors against current pi-nav structure; query time never indexes or repairs. |
| `session_shutdown` | Waits for queued QMD mutation work and runs allowed Graphify refresh. Read-only/no-setup policy suppresses heavy refresh. |
| `lsp_validate` / edit `CHECK LSP` | Starts or reuses only requested files' primary language servers through exact-pinned pi-lens subpaths. |

There is no heavy `agent_end` refresh.
These triggers realize the implemented runtime flows (`docs/automatic-workflow.md:implemented-runtime-flows#1`).

## Backend expectations

### QMD documentation lane

- QMD is the only persisted docs retrieval index. It stores pi-nav-projected Markdown section documents in one SQLite index using FTS5 and sqlite-vec.
- pi-nav is the only live Markdown parser. QMD never persists a second hierarchy manifest, raw Markdown cache, summaries, or tags/reference extraction.
- Normal lifecycle reconciliation scans current eligible Markdown, computes current section identities/hashes, deletes stale section records, upserts changed sections, and embeds only changed content through the persisted `local`, `zeroentropy`, `voyage`, or `openrouter` provider.
- Lexical search remains available without credentials or models. Hybrid readiness requires zero pending embeddings. Local mode uses cached QMD models; ZeroEntropy uses `zembed-1` plus `zerank-2`; Voyage uses `voyage-code-3` plus `rerank-2`; OpenRouter uses `nvidia/nemotron-3-embed-1b:free` plus `nvidia/llama-nemotron-rerank-vl-1b-v2:free`. Cloud modes send section/query text for inference but do not upload a managed corpus.
- Exact Pi Markdown mutations enqueue affected paths through the existing per-root transaction and coalescing owner. External changes are discovered by lifecycle reconciliation; there is no docs filesystem watcher.
- `docs_search` is read-only. It returns compact current section selectors after source-hash and pi-nav structure checks. `read` owns outline, section, range, subtree, and editable current bytes.
- Automatic lifecycle never deletes or force-rebuilds user data. Failure remains explicit in config/state/doctor output; repair is an approved setup action, never a query side effect. The runtime docs-retrieval contracts are `docs/evidence.md:current-evidence-map/documentation-retrieval-and-live-markdown#2`.

#### Select QMD semantic inference

codeweave-pi installation already downloads and verifies the local embedding and reranker. With no persisted project provider, lifecycle preparation uses an allowed configured cloud credential in order—ZeroEntropy, then Voyage—and otherwise uses local inference automatically:

1. **Local QMD models (default):** credential-free and private. `embeddinggemma-300M-Q8_0.gguf` (318 MiB) and `qwen3-reranker-0.6b-q8_0.gguf` (610 MiB) live in `~/.cache/qmd/models`; measured cache footprint is 928 MiB. codeweave-pi does not install QMD's optional 1.19 GiB query-expansion model. Native initialization logs are disabled because Metal can emit error-colored compiler noise even when the packaged runtime succeeds; JavaScript fallback/failure paths still emit one bounded actionable diagnostic, while successful local inference stays quiet.
2. **ZeroEntropy:** use an already-configured `ZEROENTROPY_API_KEY` for `zembed-1` (2560 dimensions) and `zerank-2` cloud inference. Setup never asks for, prints, or writes the key.
3. **Voyage:** use an already-configured `VOYAGE_API_KEY` for `voyage-code-3` (1024 dimensions) and `rerank-2` cloud inference. Setup never asks for, prints, or writes the key.
4. **OpenRouter:** explicit opt-in only through `OPENROUTER_API_KEY`. QMD uses `nvidia/nemotron-3-embed-1b:free` (2048 dimensions) and `nvidia/llama-nemotron-rerank-vl-1b-v2:free`; free availability and rate limits remain provider-owned. This pair is supported for benchmarking but is not selected by `auto` until it beats the current baseline.
5. **Lexical only:** FTS5/BM25 with no model or provider work.

Before guided provider-capable setup executes, `/navigation-setup` resolves `auto` to the actual provider and previews provider source, locality, whether content leaves the machine, exact model names, credential presence only, and expected writes. Approval applies to that exact set; setup never silently substitutes a weaker or different provider.

An explicit project override is optional:

```bash
npm run nav:freshen -- docs --path /absolute/project --docs-provider local
npm run nav:freshen -- docs --path /absolute/project --docs-provider zeroentropy
npm run nav:freshen -- docs --path /absolute/project --docs-provider voyage
npm run nav:freshen -- docs --path /absolute/project --docs-provider openrouter
npm run nav:freshen -- docs --path /absolute/project --docs-provider lexical
```

The choice persists as `backends.docs.embeddingProvider` in `<root>/.pi-navigation.json`. `docs_search` never downloads models. Local query inference opens the installed GGUF files with downloads and native builds disabled.

### Core code navigation and local semantics

`native/analysis/maintenance.ts::maintainAdmittedProject` reuses CodeGraph initialization and incremental sync. The ordinary lifecycle in `index.ts::registerCandidateAnalysisLifecycle` owns admission, scheduling and writer selection; queries only read ready evidence. Existing legacy bindings/stores are not adopted. Failed/interrupted maintenance remains unavailable; automatic recovery is not implemented.

`scripts/pi-nav-build.mjs::checkCore` checks the required maintenance payload and grammars, loads the adjacent kernel/bundle, and exercises the native pinned 256-dimensional code encoder. The package-relative `semantic-model` assets are distinct from QMD's GGUF cache; [model provenance](../native/analysis/README.md#complete-indexed-semantics-before-publishing-readiness) identifies the immutable upstream model. No per-project model path or downloader is needed.

### Retired CRG (historical)

- CRG is not a supported route. Its runtime module, adapter, capability-registry entry, setup routing, and bundled `native/crg` source are being removed in this change set. `npm run nav:provision` verifies Core and provisions/verifies QMD models; it never provisions Python.
- Existing CRG stores, bindings, and configuration are never read, adopted, migrated, or deleted. A present `.code-review-graph/graph.db` is not current lane health, and repairing it is not codeweave-pi setup work.
- The clean-break delivery record is historical reasoning only: `docs/decisions/r5-crg-clean-break.md:r5-crg-clean-break-stock-plus-one-watchdaemon-patch#1`.

### Optional Graphify

- Cross-domain `explore(view:"map")` and Trace path/explain require explicit Graphify setup. Python/Graphify absence does not block the current Core + QMD default. Enabling the lane is separate from provisioning its runtime.
- Query tools consume the last verified graph and surface generation, refresh, and source-manifest freshness diagnostics.
- Graphify 0.9.23 is the only Python backend in the extension-local `.runtime`; global Graphify and `GRAPHIFY_BIN` are ignored.
- Source drift, deleted manifest entries, or a transient provider failure schedules Graphify maintenance without changing map availability: the last verified graph remains queryable until replacement succeeds.
- Mtime-only touches are checked against Graphify's recorded content digest and do not schedule refresh. Malformed project config does not disable a valid state/current generation; its parse failure remains diagnostic while the graph stays query-ready.
- Routine local `update` is provider-free, may preserve the existing graph without deep extraction, and reports local/AST mode without inactive provider/model attribution or upstream command guidance.
- Deep extraction, provider-rich rebuild, and destructive repair are manual/guided. Before provider-capable execution, `/navigation-setup` previews selected provider, locality/privacy, exact model, credential presence only, and expected writes, then requires approval for that exact set.
- A failed refresh must preserve the last usable graph, record actionable retry/backoff data, and keep map queries ready. `source_freshness_status` may report `refreshing`, `retry_pending`, or `blocked`; this is lifecycle work state, not graph unavailability.
- Local `update`, deep extraction, and rich incremental candidates all force legitimate smaller outputs. A zero-result verification query is valid; only a nonzero/unstartable backend query is a readiness failure.
- `GRAPH_REPORT.md` is an optional human-orientation artifact, not an `explore(view:"map")` dependency. Map/path/explain consume the verified `graph.json` generation directly.
- Generate or refresh the report only when a human-readable community/hub overview is useful. Fast local command: `graphify cluster-only .pi/navigation/graphify --no-viz --no-label`. For provider-named communities, omit `--no-label` and explicitly select an approved backend/model.
- `cluster-only` reclusters and rewrites the working `graph.json`; do not run it automatically after every incremental stop refresh. Treat it as guided output maintenance, then let the normal verified publication lifecycle adopt the result.
The Graphify lifecycle flow is `docs/automatic-workflow.md:implemented-runtime-flows/10-core-graphify-and-bundled-pi-nav-lifecycle/graphify#3`.

### Bundled pi-nav

- `ls`, grep/find, smart read, supported structural trace, and structural diff load a precompiled N-API addon from the extension package. `native/pi-nav/artifacts.json` supplies supported target/path declarations only. The build/package owner verifies staged-file checksums against `RELEASE-MANIFEST.json`; live addon build-info checks establish version/target/capability compatibility, not cryptographic authenticity. No duplicate declaration checksums need regeneration during setup.
- Precompiled pi-nav release targets are `darwin-arm64` and `linux-arm64`. Python 3.10–3.14 support applies to the optional Graphify runtime; Darwin x64, Linux x64/musl, and Windows remain unverified.
- Users never compile pi-nav. Cargo, `npm run pi-nav:build`, signing, and package assembly are contributor/release-CI responsibilities.
- There is no prepared pi-nav lane, PATH fallback, runtime downloader, or hot repair from a query.
- Never substitute Unix grep/find/fd/rg semantics inside public tools.
The in-process addon decision is `docs/decisions/pi-nav-owned-backend.md:owned-pi-nav-backend-as-an-in-process-n-api-addon#1`; the pi-nav lifecycle flow is `docs/automatic-workflow.md:implemented-runtime-flows/10-core-graphify-and-bundled-pi-nav-lifecycle/bundled-pi-nav#3`.

### Syntax and LSP validation

- Post-commit syntax diagnostics reuse the supervised structural worker and bundled grammars only; there is no grammar downloader or delimiter fallback. They never block or roll back write/edit. Unsupported code-like extensions, failures/cancellation, and before/after content above 256 KiB report unavailable; extensionless/`.txt`/`.log` stay silent.
- `lsp_validate` is explicit and scoped to requested files/directories (maximum 100). It may automatically discover/install the configured primary language server through exact-pinned pi-lens subpaths. It does not register the full pi-lens extension, format, autofix, run auxiliary scanners, or scan the project unless `paths:["."]` is explicitly requested.
- `CHECK LSP` inside an edit section runs once for that final landed canonical file. Missing/unlanded files are skipped; empty unconfirmed results are never called clean. After changing extension registration, reload/restart Pi and directly verify `lsp_validate`; current source registration alone is not loaded-tool proof.
- Closure fixtures prove deterministic diagnostics/clean/unconfirmed/unavailable/failure states, per-server serialization, cross-server concurrency, deadline/cancellation behavior, package/loose/Deno/monorepo roots, narrow module loading, bounded progress, process-global shutdown/reset, and fresh AgentSession standalone/inline execution after reload. The opt-in live TypeScript probe may discover/install through pi-lens-owned locations; ordinary tests use deterministic local services and never install or download.
#### Language server provisioning and diagnostics

pi-lens (pinned `3.8.70`) owns language server lifecycle, root detection, auto-install policy, and the supported-language matrix. This section points to pi-lens's own documentation for those details and documents only the gaps pi-lens does not cover.

**Provisioning and auto-install policy:** pi-lens's `docs/dependencies.md` (in `node_modules/pi-lens/docs/`) is the authoritative table of which servers are auto-installed and under what gate (config-gated, language-default, flow-gated, GitHub release). pi-lens's `docs/language-coverage.md` is the authoritative language support matrix. Do not maintain a separate per-language provisioning table here — those two pi-lens docs own it and change with each pinned version.

**Standard diagnostic procedure:** pi-lens's `docs/usage.md` Troubleshooting section owns the standard procedure: check `~/.pi-lens/sessionstart.log`, `~/.pi-lens/latency.log`, and `~/.pi-lens/cascade.log` for lifecycle/performance traces, and use `lens_diagnostics mode=all` to surface stale blockers from the current session.

**Root detection:** pi-lens resolves roots file-relative, not cwd-relative — it walks up from the file's directory to the nearest project marker (`Cargo.toml`, `go.mod`, `package.json`, `pyproject.toml`, …), then checks for a parent workspace root. In a monorepo, each nested project resolves its own root and gets its own server instance. `lsp_validate` works from any directory; the resolved root depends on the file, not the agent's cwd.

#### Broken proxy shims (undocumented gap)

pi-lens tries existing PATH/toolchain binaries before its own managed fallback. A **broken proxy shim** — a dispatcher binary that exists but exits immediately because the underlying toolchain component is not installed — prevents the managed fallback from running and produces `unavailable` with no actionable message. This is not documented in pi-lens's own docs and is the failure mode most likely to look like a broken design.

The canonical example is the rustup proxy at `~/.cargo/bin/rust-analyzer`: it exists as soon as rustup is installed but exits with `Unknown binary 'rust-analyzer' in official toolchain` unless the `rust-analyzer` component is actually installed for the active toolchain. pi-lens finds the proxy first (it exists and spawns), the proxy exits immediately, and pi-lens reports failure without falling through to its GitHub-release fallback.

Diagnosis: in `~/.pi-lens/sessionstart.log`, look for `lsp process <server>: closed code=` lines with a non-empty `stderr=` field. If the process spawned and then exited with stderr, the binary is a broken shim — not a pi-lens configuration problem. Run the server binary directly with `--version` to confirm it starts; if it exits with a toolchain error, install the missing component from the official upstream source, then re-run `lsp_validate`.

Servers affected: any toolchain-managed binary that pi-lens discovers from PATH or a toolchain bin directory but does not install itself. pi-lens's `dependencies.md` states these are "auto-detected from PATH or installed via native package managers (`go install`, `gem install`) when their language is detected." If the binary is absent, pi-lens falls back to its managed copy; if it is present but broken, it blocks the fallback. For official install commands per language, consult the upstream project's documentation — do not duplicate them here.


## Install, update, and repair codeweave-pi

Default prerequisites: Pi 0.82.1+, Node 22.19+/npm, Git, matching publisher-prepared Core assets and first-install network access for npm/QMD. Python 3.10–3.14 with `venv` is required only for optional Graphify. Prior ARM64 pi-nav verification does not establish the new combined Core package on either platform.

```bash
# Complete jeito suite only after an immutable ref and the prepared Core payload are published:
pi install git:github.com/alehdezp/jeito@<immutable-ref>

# codeweave-pi only from a cloned jeito checkout with publisher-prepared Core assets:
git clone git@github.com:alehdezp/jeito.git jeito
cd jeito
npm run install:codeweave-pi
```

For a local path, Pi only records the source; it does not run npm lifecycle scripts. The checkout installer first runs a frozen production npm install inside `extensions/codeweave-pi`, with workspace resolution disabled. Postinstall verifies the complete shipped Core runtime and downloads/exercises the required QMD embedding/reranker models. Only after success does the installer register the checkout. A missing Core payload must be supplied by the package publisher, not repaired by a query. Keep the registered checkout at the same path.

Stop Pi before installing or updating. For a local checkout, `git pull` the intended revision and rerun `npm run install:codeweave-pi`; Pi package update does not update local source paths. Pi cannot install a monorepo subdirectory from a Git source, so remote one-command standalone delivery requires a separate repository or npm publication.
This realizes the package-installation flow (`docs/automatic-workflow.md:implemented-runtime-flows/1-package-installation-and-folder-startup#2`).

After restart, eligible projects use existing automatic preparation policy. Use `/skill:deep-navigation-onboard` for deliberate provider changes and `/skill:navigation-setup` for explicit project overrides or optional Graphify setup; neither is a mandatory per-project Core database/model-path configuration step.

### Verify Core and prepare the optional Graphify runtime

Run `/navigation-setup` to obtain the exact installed path without launching an installer. With Pi stopped, `npm run nav:provision` verifies Core and provisions/verifies QMD models. Missing Core files require a complete prepared package; rerunning this command cannot manufacture them. To opt into the optional Graphify runtime, use:

```bash
cd "<installed-jeito-codeweave-pi-clone>"
PI_NAV_PYTHON=/optional/absolute/python3 npm run nav:provision:legacy
test -f .runtime/.ready
.runtime/bin/graphify --help
# restart Pi
```

This optional command recreates the extension-local Python venv for Graphify, not project stores. Do not install a second Python backend separately, edit the venv, or use global/PATH fallbacks. Preserve pip failure output. No normal startup repair, store adoption or migration follows from installing this optional tool.

Provider/model/API configuration remains private in `~/.pi/agent/navigation.yaml`. Backend child environments receive only admitted values, and diagnostics redact secrets.

### Contributor native rebuild and runtime reconciliation

This is the editable-source workflow, not a requirement for ordinary users receiving precompiled artifacts. A Pi restart reloads extension source but **does not compile changed Rust**. A successful `pi-nav:check` proves artifact compatibility and smoke behavior; without a matching source/build record it does not prove that the binary contains the latest source changes. The package version alone is not a freshness check.

`[pi-nav:incompatible_addon] ... lacks matches_corpus_v1` means the loaded addon cannot enforce the Matches admission contract; it is not a pattern/paths formatting error. Package version/API equality and a reload alone cannot prove the capability exists. Verify `getBuildInfo().capabilities` on the actual artifact; with explicit deployment approval, replace the matching installed addon/CLI using the stopped-process flow below, restart Pi, and exercise the same Matches call. Never bypass admission or substitute an unrestricted scanner. This is independent of installing Core analysis or model assets.

Grep startup checks the **loaded addon** against `src/core/pi-nav-native.ts::PI_NAV_GREP_CAPABILITIES` without creating project sessions or scanning source. An incompatibility is reported to the operator and to prompts using Grep; unrelated tools are not disabled. `scripts/pi-nav-build.mjs::inspectAddonAndSmoke` uses the same base/Grep capability contract and runs registered directory Matches, an independent-child exclusion, a policy-aware census and a conflicting-query refusal before accepting a build/package. These checks detect feature skew even when package and API versions agree. They never compile or repair during queries/startup. An already-stale source identity still requires restart before this check, rather than loading more changed code into the old process. A stopped-Pi offline rebuild of the matching addon/CLI followed by a live `output:"matches"` call and a refused conflicting `pattern`+`query` pair confirmed this Grep gate in the current checkout on 2026-09-21; that is one machine's post-rebuild evidence, not a fresh-install or cross-machine result.

When source changes introduce native requirements, develop them in the unregistered candidate described below, then deliver matching source and native artifacts together through the existing build/package owner. Editing the active checkout's TypeScript and testing a newer addon only in `.tmp` leaves the installed tool broken; a candidate receipt is not a deployment receipt. After deployment, a full process restart is required: extension reload refreshes TypeScript, but codeweave-pi's native session cache and Node's loaded addon remain process-owned. The builder's per-file atomic rename avoids truncating a mapped binary; it does not hot-activate the new addon or make the pair replacement transactional.

1. Run `jeito-setup` registration inspection first. Preserve the existing aggregate or standalone owner; do not register a second codeweave-pi copy to repair native code. Keep host configuration and project preparation separate.
2. Ensure the checkout's declared development dependencies and Rust/C toolchain are prepared. Use the owning npm lifecycle if dependencies are missing; do not install an arbitrary global/latest build helper. Stop every Pi process using this checkout before changing its installed addon/CLI, not just the conversation requesting the build.
3. From the monorepo root, run the same owner commands on either supported platform:

   ```sh
   npm run pi-nav:build --workspace @alehdezp/codeweave-pi &&
   npm run pi-nav:check --workspace @alehdezp/codeweave-pi -- --json
   ```

   Build failure stops the sequence: do not register, activate, or claim freshness. The script builds and checks addon and CLI candidates before per-file replacement. macOS checks architecture, relocatable/system dependencies, deployment floor and development signature. Linux checks architecture, runtime paths and the glibc 2.28 ceiling; use a compatible build environment rather than relaxing that ceiling. Current supported targets are Darwin ARM64 and Linux ARM64—not every macOS/Linux architecture or libc.
4. Restart Pi in the intended consumer project and resume the conversation. Verify registration/resource identity and exercise representative actual tools against known source. Keep package compatibility, changed-behavior proof and loaded-process proof separate. These commands do not activate A1, choose a provider, prepare project indexes or establish production release readiness.

When Pi must remain running, a contributor may build a candidate in a separate **unregistered source snapshot**, with output paths confined there, using the same build/check script. Record the source identity and verify that installed artifact bytes remain unchanged. That is candidate proof only; it is not installation or activation, and must not silently replace the loaded checkout. A dependency-linked candidate also does not prove a clean-machine install. Ordinary stopped-process rebuilding above remains the supported reconciliation path.

The Core payload additionally needs the maintained analysis build, existing CodeGraph WASM grammars and the pinned local code model. `analysis-build --output-dir <isolated-directory> --maintenance-grammars <canonical-existing-directory> --semantic-model <canonical-existing-directory>` stages those inputs without downloading them. `analysis-candidate.mjs --build` accepts the same asset inputs on first assembly and reuses its candidate assets afterward; its final `check-core` is still isolated evidence. `pi-nav-build.mjs::copyPackageSources` includes these runtime assets, and `packageRelease` checks Core both before and after copying. Publisher dependency staging, signing and installed journeys remain separately authorized release work.

## Diagnostics and guided project preparation

`/navigation-setup` reports asset presence, the stopped-Pi Core/QMD verification command and a separate optional Python command. It never installs or prepares a project. Use the `navigation-debug` skill for project root, lane/provider policy and artifact diagnosis. Optional Python `.ready` and CLI checks do not certify Core or its code-semantic model.

## Repair decision tree

1. **Wrong root/scope**: stop. Correct nested-root identity or owned include roots before indexing.
2. **Missing runtime assets**: obtain the complete prepared Core package, then verify it; for a missing optional Graphify executable, stop Pi and run `npm run nav:provision:legacy`. Never add a global/PATH fallback.
3. **Indexed code lane unavailable**: verify the complete Core payload with the stopped-Pi Core/QMD command. Crashed or interrupted maintenance stays unavailable because automatic recovery is not implemented, and retired CRG stores are never consulted, adopted, or repaired as setup work.
4. **Graphify unavailable**: inspect the rich-update report and failure classification. Use full reconstruction only for a missing/incompatible baseline; provider and timeout failures keep their specific diagnosis.
5. **QMD pending, stale, or missing local models**: inspect QMD status, selected provider, source/index identity, pending embeddings, and lifecycle audit. For local mode, verify the two expected GGUF files are cached; rerun approved docs freshen to resume an interrupted download. Do not delete the index or model cache automatically.
6. **Provider unavailable**: lexical mode may remain ready; hybrid mode reports pending vectors rather than silently claiming semantic readiness. Never substitute ZeroEntropy for local mode or download local models for `auto`.
7. **Public query failure with a healthy index**: compare direct backend output and current pi-nav structure before changing setup.

Docs health is the QMD index identity, section/source hash coverage, and pending-embedding count. A Git-dirty repository alone does not make docs stale.
The lifecycle setup-repair flow is `docs/automatic-workflow.md:implemented-runtime-flows/12-setup-repair-and-destructive-boundaries#2`; current limitations are `docs/current-truth.md:current-truth-and-future-work/known-limitations#2`.

## Docs migration and cleanup

The clean break uses QMD only:

1. Run normal docs freshen into the configured `.pi/navigation/qmd` index.
2. Require current root/index identity, expected section count, and truthful lexical/hybrid health.
3. Confirm `.pi-navigation.json` contains the QMD docs backend and no obsolete query command or transport.
4. Exercise `docs_search`, then use `read` for one returned section and verify current source authority.
5. Leave old user-owned backend directories untouched; jeito-codeweave-pi does not delete them automatically.

Graphify destructive migrations retain their separate last-good/quarantine protocol.

## Readiness verification
These checks correspond to the release validation tiers (`docs/evaluation-workflow.md:agent-evaluation-workflow/release-implementation-validation-tiers#2`).

### Docs

- `npm run qmd:model-provision -- --verify-only` reports both required GGUF files, a non-empty embedding vector, and two finite reranker scores without downloads;
- repo/root/QMD-index identity matches config;
- owned paths do not cross nested project or internal-cache boundaries;
- exact mutation and external lifecycle reconciliation update only changed section identities;
- no-change reconciliation performs no provider work;
- lexical readiness works without credentials; hybrid readiness requires zero pending embeddings;
- `docs_search` reports QMD engine/model/privacy/freshness diagnostics and does not synchronously parse or rebuild the corpus;
- every returned selector is checked against current pi-nav Markdown structure and source hash;
- `read` opens the selector concisely and preserves ordinary current-byte edit authority.

### Graphify

- graph path exists and query resolves expected nodes;
- `graphPath`, source-manifest path, state generation, and canonical current pointer agree, or the read-only resolver safely reconciles to an existing verified generation and reports the mismatch for automatic repair;
- source drift makes Graphify eligible for immediate automatic refresh without changing graph query readiness;
- smaller node/edge counts are accepted and atomically published as valid current state;
- refresh work state, retry/backoff, and last failure are truthful;
- failed update leaves the last verified graph usable while automatic retry proceeds;
- no query-time provider/deep extraction occurs.
- missing or stale `GRAPH_REPORT.md` is a guidance/output warning only; it must not make the graph lane unavailable.

### Public contract

- schemas expose current fields only;
- native relationships/ranks/scores/diagnostics survive rendering;
- query-time calls create no setup/index/provider process;
- exact live rows may certify hash authority; locators do not;
- read/edit use eight-hex hashes and natural operations.
Edit authority is `docs/harness-doctrine.md:navigation-harness-doctrine/source-and-mutation-authority#2`; native-output survival is `docs/harness-doctrine.md:navigation-harness-doctrine/native-output-doctrine#2`.

## Focused verification

For runtime/setup changes, start with the owning boundary and then the affected lifecycle:

```bash
node --test --test-concurrency=1 tests/v3-navigation-provision.test.mjs tests/v3-backend-registry.test.mjs
npm run validate:checkpoint
PI_NAV_TEST_PYTHON=/absolute/python3 npm run validate:release
```

`tests/v3-pi-nav-package.test.mjs` keeps archive/install verification opt-in: `PI_NAV_TEST_PACKAGE=1` permits archive construction and isolated Pi lifecycle checks; `PI_NAV_RELEASE_ARCHIVE` selects an existing archive for those checks. Neither belongs to a source-only verification run. `PI_NAV_TEST_CORE_RUNTIME=/absolute/sealed/runtime` independently enables byte-exact Core staging and the mocked dependency-failure/signing boundary without installation or deployment. Skipped archive checks are not release acceptance.

Escalate only when the changed contract justifies it. Required live UX claims use fresh session-enabled `openai-codex/gpt-5.6-luna` with low thinking, never `--no-session`, and never inspect/configure API keys. This baseline is owned by `docs/evaluation-workflow.md:agent-evaluation-workflow/required-baseline#2`.
