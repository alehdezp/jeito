---
name: navigation-setup
description: Prepare, freshen, repair, or migrate jeito-codeweave-pi after explicit approval. Use for Core, QMD, Graphify, root/scope, worker, and prepared-artifact readiness; use navigation-debug first for read-only diagnosis.
disable-model-invocation: true
---

# Navigation Setup

Use this skill only after the user approves changing setup state. For a foreign-repository symptom, begin with `navigation-debug`; diagnosis is read-only, setup is not.

## Non-negotiable boundaries

- Query-time navigation tools must never build, index, install, embed, call providers, download models, or mutate state.
- They also never repair prepared state; lifecycle repair stays in approved setup flows.
- Do not inspect, request, print, or configure API keys.
- Do not silently reduce configured AI-summary or embedding quality to make a lane appear ready.
- Do not automatically delete, rebuild, or migrate an index.
- Do not broad-scan a project root when a configured owned scope exists.
- Do not use shell/lexical fallback as a substitute for a broken prepared lane.
- Prepared docs/Graphify artifacts and state remain under setup-owned `.pi/navigation/**`; the indexed Core store is machine-side under `storage.indexRoot`, and bundled pi-nav is shipped code, not prepared state.
- Complete live hash-certified source can authorize edits; setup readiness does not make an edit appropriate.
- `.pi/navigation/ignore` is user-controlled exact-search policy. Never create or edit it automatically; first diagnose the effective policy, explain that it replaces Git ignore sources, and require explicit approval for the exact contents.

## Approval levels

| Level | Examples | Approval required |
|---|---|---|
| Read-only diagnosis | doctor, audit, dry-run, artifact/process/lock inspection | no additional setup approval |
| Non-destructive preparation | first local lane setup, incremental freshen, worker restart | explicit user approval |
| Provider-quality work | configured embeddings/summaries or Graphify deep/rich work | explicit user approval and existing configured provider policy |
| Destructive migration | index quarantine, scope replacement, full Graphify rebuild, deleting old artifacts | explicit approval after a written plan |

If provider capability is unavailable, report the blocker. Do not configure credentials or substitute a weaker provider/model.

## Workflow

### 1. Establish identity and a dry-run

From the jeito-codeweave-pi extension root:

```bash
npm run nav:doctor -- --path /absolute/project --json
npm run nav:prepare -- --path /absolute/project --dry-run --json
npm run nav:audit -- --path /absolute/project --json
```

Prove:

- resolved nested project root;
- `.pi-navigation.json` and state paths;
- configured include/owned docs scope;
- lane status, backend command, artifact path, health, locks, and proposed writes;
- whether the request is setup, repair, or destructive migration.

A passed process exit is not readiness. A path supplied by the user is not proof of the selected root.

### 2. Preview provider-capable work before approval

Before any preparation that can embed, summarize, rerank, or run deep/rich graph extraction, resolve the provider that the command will actually use. An `auto` policy is not a preview: resolve it to the selected provider before execution.

Show one bounded preview containing:

- selected provider and whether the selection came from an explicit project override or configured `auto` policy;
- locality and `contentLeavesMachine` from `src/core/provider-registry.ts`;
- exact embedding, reranking, or graph model names;
- required credential names and presence only—never values;
- expected project writes and artifact paths from the dry-run;
- whether the action is local-only, cloud inference, or provider-cost work.

Obtain explicit approval for that exact provider/model/write set before execution. If the selected provider cannot be resolved, its credential is absent, or policy blocks it, stop with the configured-quality blocker. Do not silently choose another provider, switch to lexical/local mode, or execute `auto` and disclose the provider afterward. Local Graphify update has no provider/model claim and does not pass through this cloud-provider gate.

### 3. Choose the smallest approved action


| Problem | Correct action |
|---|---|
| Missing Core maintenance/code-semantic payload | obtain the complete prepared codeweave-pi package and verify it with `npm run nav:provision`; the command never fetches, compiles or repairs assets, and a bare checkout cannot pass the Core gate |
| Missing optional Graphify runtime | run `/navigation-setup` for the exact command, stop Pi, run `npm run nav:provision:legacy`, then restart; never install a backend globally or add a PATH fallback |
| Missing local lane/config | approved scoped prepare |
| Indexed code lane unavailable or refused | check the shipped Core payload (`npm run pi-nav-build.mjs check-core --json`), the consent keys (`architecture.enabled/autoPrepare`, scope), and the machine store `maintenance-status.json` under `storage.indexRoot/codegraph/<root-hash>`; failed or interrupted maintenance stays unavailable because automatic recovery is not implemented |
| QMD lane transaction/vector-health failure | inspect the per-root transaction, QMD index identity, selected `local`/`zeroentropy`/`voyage`/`openrouter`/`lexical` provider, pending embeddings, cached local models, and current pi-nav projection; preserve current data and do not add a broker, daemon, or global QMD install |
| Wrong docs corpus or obsolete config | correct QMD root/index ownership and remove obsolete query command/transport fields; never auto-delete old user-owned data |
| Graphify degraded/old graph | inspect last-good graph; use approved update or explicit deep repair only when required |
| Bundled pi-nav artifact missing/incompatible | source checkout: `npm run pi-nav:build`; installed archive: reinstall the verified platform archive; never create a prepare lane or PATH fallback |
| Stale configured backend command after checkout move | inspect doctor `commandIdentity.configured`, `effective`, and `staleConfiguredIgnored`; preview the exact lane-specific freshen that rewrites only the owned command fields to the currently loaded extension paths, execute only after approval, then rerun doctor |
| Exact search is noisy under repository Git ignores | diagnose with `nav:doctor` and an exact-tool result; offer a proposed `.pi/navigation/ignore` only after explaining that its presence suppresses Git ignore sources and receiving explicit approval |
| Provider unavailable | report configured-quality blocker; do not change credentials/model/provider |

Use only flags the command actually documents. Prefer a scoped lane action to full-stack work.

When doctor reports a stale configured command that was safely ignored, do not edit `.pi-navigation.json` directly and do not rebuild every lane. Show configured versus effective paths, run the matching `nav:freshen` command first as an explicit preview/dry-run when supported, obtain approval, then freshen only `docs` or `graph`. The owning freshen path preserves the selected project root/scope and rewrites its command to the loaded extension-owned runtime. Re-run doctor and require `configured === effective`; never search for or reactivate the former checkout.

### 4. Lane contracts

#### QMD docs lane

- QMD is the only persisted docs retrieval index; bundled pi-nav projects current Markdown sections and remains the live hierarchy/read owner.
- The owned QMD fork, `node-llama-cpp` platform runtime, embedding model, and reranker install and verify with codeweave-pi through npm. Never install or invoke a global `qmd` command.
- Exact Pi Markdown mutations enqueue changed or missing paths. Session start, every-ten-tool cadence, manual freshen, and shutdown waiting use the same per-root transaction/coalescing owner.
- Reconciliation deletes stale selectors, upserts changed section documents, and embeds only changed content. A no-change pass performs no provider work.
- Lexical readiness requires no credentials. Hybrid readiness uses the installed local QMD models or configured ZeroEntropy/Voyage/OpenRouter inference and requires zero pending vectors; never silently claim semantic readiness.
- `docs_search` never starts indexing, model acquisition, native builds, or repair. Local query inference opens only installed models with downloads/builds disabled. Returned selectors are checked against current pi-nav structure and opened through `read` for current authority.
- No filesystem watcher, broker, MCP session, raw Markdown cache, summaries, second hierarchy manifest, or managed corpus upload is part of the docs lane.
- Old user-owned backend data is reported only; cleanup is manual and explicitly approved.


#### QMD semantic provider override

Local semantic QMD is installed and is the keyless default. Do not ask permission to download it during project setup. When the project has no explicit provider, lifecycle preparation uses an allowed configured cloud credential in order—ZeroEntropy, then Voyage—and otherwise uses local inference automatically:

1. **Local QMD models (default):** no API key and no corpus leaves the machine. The installed embedding/reranker cache is 928 MiB measured. codeweave-pi omits QMD's unused 1.19 GiB query-expansion model.
2. **ZeroEntropy:** use only when `ZEROENTROPY_API_KEY` is already configured. QMD uses `zembed-1` plus `zerank-2`; do not request, inspect, or write the key.
3. **Voyage:** use only when `VOYAGE_API_KEY` is already configured. QMD uses `voyage-4-large` plus `rerank-2.5` (override via `voyage.embedding_model` in navigation.yaml); corpus leaves the machine. Do not request, inspect, or write the key.
4. **OpenRouter:** explicit opt-in only with `OPENROUTER_API_KEY`. QMD uses `nvidia/nemotron-3-embed-1b:free` plus `nvidia/llama-nemotron-rerank-vl-1b-v2:free`; the provider owns free availability and rate limits. Do not make it an `auto` candidate without benchmark evidence.
5. **Lexical only:** FTS5/BM25 with no provider call.

An explicit project override still requires previewing scope, writes, and privacy:

```bash
npm run nav:freshen -- docs --path /absolute/project --docs-provider local
npm run nav:freshen -- docs --path /absolute/project --docs-provider zeroentropy
npm run nav:freshen -- docs --path /absolute/project --docs-provider voyage
npm run nav:freshen -- docs --path /absolute/project --docs-provider openrouter
npm run nav:freshen -- docs --path /absolute/project --docs-provider lexical
```

The selected provider persists in `<root>/.pi-navigation.json`. Later lifecycle refreshes reuse it; `auto` uses an allowed configured ZeroEntropy or Voyage key and otherwise the installed local models. OpenRouter remains explicit opt-in.

#### Core (indexed code lane)

- Code navigation comes from the package-owned Core maintenance runtime. There is no extension-local code runtime to install, and no setup command installs or repairs one while Pi runs; a missing payload requires the complete prepared package.
- `index.ts::registerCandidateAnalysisLifecycle` owns admission, scheduling and writer selection on eligible unowned roots. A root is claimed under the consent keys `architecture.enabled/autoPrepare` plus scope; an explicit `false` is an honored prohibition, not predecessor configuration to clean up.
- The store is machine-side: `<storage.indexRoot>/codegraph/<root-hash>` (default index root `~/.pi/navigation/indexes`), with `maintenance-status.json` as its status artifact. Setup writes nothing into the project for this lane.
- Failed or interrupted maintenance leaves the lane unavailable; automatic recovery is not implemented, and prepared queries keep useful live source instead.
- Retired CRG artifacts, bindings and stores are never read, adopted, migrated or deleted, and they are never repaired as setup work.
- `explore(code)` and prepared `trace` query existing artifacts only.

#### Graphify

- Preserve and diagnose the last-good graph before considering rebuild.
- Graphify local update is routine lifecycle work, not proof of deep/provider-rich extraction.
- Deep extraction, rich rebuild, URL ingest, and provider-cost work require explicit approval and a configured policy.
- Query-time map/path/explain remains read-only and surfaces health/freshness limits.

#### Bundled pi-nav (not a prepared lane)

- `ls`, `find`, `grep`, smart read, native trace, and structural diff load the archive-owned addon directly.
- It has no setup action, index state, command lookup, PATH fallback, provider, or migration from obsolete configurations.
- Default `visibility:"project"` uses `<git-root>/.pi/navigation/ignore` when present, otherwise repository Git ignore sources. The custom file uses Gitignore syntax and replaces rather than merges Git rules.
- `visibility:"all"` disables configurable ignore files but retains root/symlink/cycle, `.git` internals, query-state, deadline, and cancellation safety.
- Exact file targets bypass ignore selection and report that fact; they still obey confinement, regular-file, text/binary, read, and deadline rules.
- Setup may suggest a custom ignore after diagnosis. Creation or editing is a separate explicitly approved mutation; it is never part of automatic prepare, freshen, doctor, or a query.

### 5. Destructive migration

Before quarantining/rebuilding/replacing scope:

1. Capture root, config/state structure, artifact paths/sizes, repo identity, locks/process owners, and current query behavior.
2. Produce an exact dry-run with expected corpus and quality.
3. Get explicit approval.
4. Quarantine by atomic rename; never immediately delete.
5. Build the corrected scoped artifact at existing configured quality.
6. Verify corpus boundaries, vectors/summaries when configured, native query behavior, worker cleanup, and event-loop impact.
7. Keep the quarantine until separate approval for deletion.

## Verification

Run the smallest applicable checks:

```bash
npm run nav:doctor -- --path /absolute/project --json
npm run nav:audit -- --path /absolute/project --json
```

Then verify only expected lanes:

- Core: `explore(view:"code")` identity/topology plus one focused `trace` relation against a known target, and a session-start notice that reports the indexed lifecycle state.
- QMD: lexical/hybrid status must match provider and pending-vector reality; verify direct search → current selector → read, then one exact Markdown mutation after queued reconciliation settles.
  - Local mode reports `semantic_provider=local`, the default embedding/reranker identities, `local_index_local_inference`, and zero pending vectors. Verify that a query performs no model download or native build.
  - ZeroEntropy mode reports `semantic_provider=zeroentropy`, `zembed-1`/`zerank-2`, `local_index_cloud_inference`, and zero pending vectors.
  - Voyage mode reports `semantic_provider=voyage`, `voyage-4-large`/`rerank-2.5`, `local_index_cloud_inference`, and zero pending vectors.
  - OpenRouter mode reports `semantic_provider=openrouter`, the two configured NVIDIA model slugs, `local_index_cloud_inference`, and zero pending vectors.
- Graphify: map/path/explain with reported health respected.
- Bundled pi-nav: exact `ls`/`find`/`grep` behavior and doctor-reported addon/CLI artifact paths; no prepare action is expected.
- LSP validation: run `lsp_validate` on a representative file for each language in the project. pi-lens owns auto-install, root detection, and the supported-language matrix — consult `node_modules/pi-lens/docs/dependencies.md` for the auto-install/gate policy and `node_modules/pi-lens/docs/language-coverage.md` for the language matrix. If a file reports `unavailable`, follow pi-lens's standard diagnostic procedure from its `docs/usage.md` Troubleshooting: check `~/.pi-lens/sessionstart.log` for `lsp process <server>: closed code=` lines and read the `stderr=` field. A broken proxy shim (binary exists but exits immediately, e.g. a rustup proxy without the component installed) prevents pi-lens's managed fallback — confirm the binary starts with `<server> --version` and install the missing component from the official upstream source if it doesn't. This is user-side toolchain setup, not a jeito-codeweave-pi action.

Check that normal query calls did not start setup/provider work. Validate source claims with complete live rows or `read`; prepared locators are not mutation authority by themselves.

## Completion report

```text
approved goal and risk level:
resolved root/scope:
commands run and actual writes:
lanes ready / guided / blocked:
quality preserved or explicit provider blocker:
artifact and worker/lock health:
verification evidence:
rollback/quarantine path, if any:
remaining limitation:
```

For model-driven UX claims, use the current session model with low thinking, never `--no-session`, and never inspect/configure API keys. See `docs/setup.md` for the detailed operator contract.
