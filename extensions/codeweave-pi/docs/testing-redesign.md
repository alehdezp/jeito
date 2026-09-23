---
title: "codeweave-pi reliability delivery plan — Git artifact probes, minimal smoke, and real-user release"
description: "Current execution plan for proving immutable GitHub refs with focused guards, one minimal installed smoke, and release-candidate-only user journeys while retaining npm only as the package dependency lifecycle."
tags: [jeito-codeweave-pi, testing, reliability, github-package, pi-rpc, lifecycle, release]
created: 2026-07-28
updated: 2026-09-21
status: active
owns: "Execution order, evidence gates, proof retention, and release learning loop for codeweave-pi reliability"
audience: mixed
code: [package.json, index.ts::jeitoCodeweavePiExtension, src/core/background-launch.ts::launchBackground, scripts/run-typescript-command.mjs, scripts/pi-nav-build.mjs, scripts/validate-release.mjs]
related: [docs/requirements.md, docs/evaluation-workflow.md, docs/automatic-workflow.md, docs/harness-doctrine.md]
---

# codeweave-pi reliability delivery plan

## Outcome, authority, and decision window

codeweave-pi is ready only when a user can acquire one immutable GitHub ref, install it through Pi's documented managed-Git path or the standard editable contributor path, open Pi without unintended work, explicitly onboard and prepare a project, receive current isolated evidence from Core/QMD/Graphify, update or roll back reliably, and exit or remove the package without leaked work or damaged user state. Test count is not an outcome.

[`requirements.md`](requirements.md) owns product behavior and release obligations. This plan owns execution order and proof selection. When current source, a test, another document, and `requirements.md` disagree, record the contradiction and run the cheapest discriminator; do not silently make production code satisfy the test. A change to product objectives, supported platforms, provider policy, publication commitment, or destructive migration returns to the package owner.

There is no committed release date. The controlling dependency is evidence: explicit source selection → accessible GitHub repository and immutable ref → Pi-managed Git installation → real Pi lifecycle → backend updates and isolation → update/rollback → two-platform journey.

## Boundaries that must survive implementation

- Do not build a general Pi test framework, local registry, DSL, backend simulator, scenario runner, second watcher, scheduler, cache, parser, or compatibility route.
- Do not install third-party observability packages as validation infrastructure. Pi JSON/RPC, existing codeweave-pi logs, direct backend evidence, and final state are the default observers.
- Do not use cmux. Herdr may control interactive investigation after its workspace/tab/pane preflight agrees; Herdr is never a release oracle or scripted gate.
- Do not add hook tracing speculatively. Entry/exit/error tracing is admissible only after a reproduced failure remains unattributable through existing evidence.
- Do not patch the Mac mini, container, or maintainer host to manufacture a pass. A representative-host failure is repaired in the shared package path and retested from a new immutable artifact.
- Do not run providers, install runtimes, download models, or mutate project state at query time.
- Do not automate every scenario. Retain proof only for stable, consequential behavior this project owns.
- Do not delete an existing test until stronger evidence owns the same claim and the test has no other unique safety value.

## Current verified baseline and correction through 2026-07-29

### Evidence that remains valid
**CRG-era receipts.** The baseline, increments and probes below were recorded before the code lane was retired. Entries that name CRG provisioning, CRG tests, CRG runtime identity, or CRG coexistence describe that delivery history; they are not current runtime claims, their counts are not evidence for the Core lane, and no CRG path should be reinstated from them.

- The npm `files` allowlist is the single first-party package inventory. The latest `npm pack --dry-run --json --ignore-scripts` returned 248 files; tests, `docs/plan/`, cmux, runtime state, dependency trees, CRG tests, pi-nav development sources, `native/qmd/src`, and the deleted custom Graphify helper were absent while the owned QMD runtime, CRG fork, precompiled pi-nav targets, skills, scripts, and extension source remained.
- The focused TypeScript launcher guard passed in 254 ms. It proves package-local `tsx` loading, inherited `NODE_OPTIONS` in one nested Node child, and exact nonzero exit forwarding. Those bytes have not changed; do not rerun it for documentation, allowlist, or unrelated test edits.
- The internal release-container archive built with 7,142 manifested files, and its 15-subtest custom-archive suite eventually passed. This is evidence only for that archive's frozen-dependency manifest, tamper checks, and internal Pi path. It is not managed-Git installation evidence.
- The pinned Python backends declared `Requires-Python >=3.10`. No pinned metadata supplies an upper bound. codeweave-pi therefore accepts Python 3.10 or newer with `venv` for the optional Graphify runtime and lets ordinary pip dependency resolution report an incompatible future interpreter.
- QMD declares Node `>=22`; the pinned Pi peer declares Node `>=22.19.0`. The package floor `>=22.19.0` is upstream-owned. No npm-version restriction is declared.

### Current result and remaining release constraints

- The exact 248-file local package artifact with integrity `sha512-G6VC4PyR1qp1kYHxrbMO+YPmdbH8TFd63uvh08bmwC3iQRu+tSpCR+5MrmYFB4b+0G3DXUV3wJZa9gwo69YvFQ==` installed with lifecycle scripts into wiped state. Package-local provisioning published CRG 2.3.7, Graphify 0.9.23, owned QMD runtime, and the bundled Darwin ARM64 pi-nav target. This remains component/package evidence, not GitHub acquisition proof.
- One canonical OpenRouter project preparation reached semantic-ready QMD, hybrid CRG with `nvidia/nemotron-3-embed-1b:free`, and semantic Graphify with `inclusionai/ling-3.0-flash:free`. The installed watcher receipt matched a live child PID, and its log contained no `.pi/navigation` feedback rebuilds.
- The installed journey falsified three shared assumptions before the final artifact: `--full-stack` overrode confirmed user provider policy; doctor treated OpenRouter as credentialless; and CRG selected ambient OpenAI key/base state ahead of the confirmed OpenRouter identity. The shared package now preserves user config precedence, recognizes OpenRouter credentials, and binds both key and endpoint to the selected provider.
- A real Pi mutation turn then exposed a more serious Graphify defect: lifecycle scope inference passed `--scope src` to an existing full-project graph. Native incremental extraction correctly interpreted every source outside `src` as deleted and pruned five sources, downgrading semantic evidence. The final planner passes a scope only when creating a graph; an owned graph reuses its published corpus root. The exact final artifact then completed initial preparation and stop refresh without `--scope`, retained `src/main.ts` and `docs/guide.md`, and stayed `mode=deepExtract` with semantic extraction observed.
- A deliberate invalid OpenRouter refresh exited nonzero and preserved the published graph path, generation, and SHA-256 `a6395872feb700b5f61377804e3477d6b226ab1586b9abf8b1d1991e073326ae`. Loaded Pi calls against the same artifact returned the changed Markdown token through `docs_search`, the changed function through code search, and a three-node/two-edge Graphify map.
- The onboarding probe is **inconclusive and unsafe on this host**. Pi tool execution resolved `~` to the real account despite an overridden process `HOME`; the model wrote `/Users/example/.pi/agent/navigation.yaml` instead of the disposable home. The file did not exist before the probe, the exact created bytes were deleted immediately, and absence was reverified. Do not repeat this probe outside a genuinely isolated OS user/container.
- The npm dependency lifecycle used inside Git/local installs still prints two non-gating warnings: optional `fsevents@2.3.3` attempts a source build without `binding.gyp`, and `node-llama-cpp` disables Metal tensor support in this environment. Cloud QMD completed despite both. `npm audit --omit=dev` also reports one high-severity `brace-expansion@5.0.7` advisory owned by the current `@earendil-works/pi-coding-agent@0.82.1`; codeweave-pi's `pi-lens` path already resolves fixed `5.0.8`, and no newer Pi package existed at that check.
- Local package coherence and the ordinary-project backend path are proved. The GitHub repository identity/visibility/ref, managed-Git acquisition, contributor-path update, isolated onboarding, nested removal/recovery, and the second platform remain open. `private: true` and Apple signing are irrelevant to the selected GitHub delivery channel.
- Complete package removal remains unimplemented: Pi removes registration, while `nav:clean` is project-artifact cleanup and no stopped-Pi owner currently stops only jeito workers or removes only jeito-owned registration. Increment 6 must implement or explicitly reject that owner before any removal-ready claim.
- The editable-maintainer update path exposed a separate compatibility failure after installation succeeded: the loader ignored preserved `~/.pi/navigation/config.json`, onboarding inferred fresh state from absent YAML, a HOME-root boundary produced direct preparation guidance, and native trace fallback lacked visible provenance. Shared source now preserves predecessor policy, reports dual-file conflicts, disables automation on malformed active YAML/JSON, blocks HOME/filesystem-root preparation before scanning, labels native fallback, and hands runtime repair/onboarding/project setup between the owning skills. This is focused source evidence only; no live onboarding, project preparation, or host migration was run.

### Where elapsed time went

| Work | Elapsed evidence | Assessment |
|---|---:|---|
| Six executions of `v3-pi-nav-package.test.mjs` | about 23.6 minutes | Avoidable. Output filtering reran the entire parent test because nested subtests were not independently selectable. Four diagnostic reruns added no new product evidence. |
| Repeated custom `pi-nav:package` builds | about 5 minutes plus failed attempts | Mostly avoidable. The archive is not the managed-Git user path; rebuild only when that internal artifact is an explicit deliverable. |
| Lockfile discovery/regeneration and sync recovery | about 4 minutes of commands plus investigation | One-time necessary work inflated by synchronization loss and uncertainty over root versus standalone locks. Both locks are required because the root aggregate and standalone package are separate install contracts. |
| Two identical scripts-enabled install failures | about 3 minutes | The first failure selected the postinstall owner. The second was redundant because no relevant bytes changed. |
| Reads, grep, and model deliberation across 104 tool calls | remainder of roughly 63 minutes | Avoidable coordination overhead. The agent preserved stale test expectations, debugged output capture by rerunning broad suites, and adopted a duplicate runtime-contract module before proving the real package lifecycle. |

### Expensive validation admission

| Validation | User-visible failure it catches | Why a cheaper observation is insufficient | Class and cadence | Current disposition |
|---|---|---|---|---|
| Scripts-enabled dependency installation plus minimal Pi smoke | Missing files, failed lifecycle scripts, unusable native QMD, extension load failure, unintended cold-open writes, hung shutdown, or surviving owned workers | Source imports and a file inventory cannot reproduce npm lifecycle ordering inside Git installation, native install selection, Pi resource loading, or process teardown | Installed-artifact smoke; after package/lifecycle/native changes and once per candidate | Current local artifact passed scripts-enabled installation, semantic project preparation, loaded public queries, shutdown cleanup, and exact package inventory; managed-Git acquisition and isolated onboarding remain open. |
| Full ordinary/parent-child/provider journey | Wrong backend convergence, isolation leakage, last-good loss, removal/rollback damage | These require real prepared state, providers, mutations, and lifecycle boundaries | Release-candidate-only agent journey | Ordinary-project backend/update/query/last-good slice passed locally; onboarding isolation and parent-child/removal remain open. |
| Second supported-host journey | Platform-specific native/package/process failure | One host cannot exercise the other shipped pi-nav artifact or native dependency selection | Release-candidate-only, one representative host per supported platform | Deferred |
| Python-minor matrix | A dependency failing on one enumerated minor | Upstream `>=3.10` metadata plus one representative install per platform owns the bounded compatibility claim; exhaustive minors add little unique evidence | Not a default gate | Remove from the critical path; run only for a reproduced version-specific defect |
| Custom release-container suite | Frozen dependency archive corruption, manifest tampering, signing/notarization, custom upgrade/repair | A normal Git clone plus npm lifecycle does not contain that manifest or frozen `node_modules` | Separate internal-distribution gate | Deferred; remove from the GitHub release-critical path unless the container is declared a user deliverable |

### Execution rules now in force

- One changed behavior gets one smallest focused guard. Package/load/lifecycle changes then get one real installed-artifact smoke. Full journeys run only for an immutable Git ref.
- Do not rerun inventory, install, package, or release checks after test-only or documentation-only changes. Rebuild only when Git-delivered bytes or lifecycle behavior changed.
- Delete command-string, wording, wrapper-argument, and obsolete-behavior assertions when stronger installed behavior owns the claim. Never change production code to satisfy them.
- The custom archive may consume npm's packlist, but it is outside the GitHub critical path. Its passed suite is not rerun during managed-Git work.
- Installation uses ordinary backend primitives: pinned PyPI `graphifyy` for the optional Graphify runtime, package-local Node dependencies for QMD, bundled Core analysis assets, and bundled precompiled pi-nav artifacts. No global/PATH fallback, Cargo, contributor inspection tool, alternate resolver, or host repair is permitted.
## Evidence evolution protocol

Any agent may propose a scenario, experiment, recommendation, or deletion, but it enters the plan only through this record:

```text
User consequence or decision:
Current status: observed | inferred | open | deferred | rejected
Expected result:
Cheapest owning observation:
Possible outcomes and action changed by each:
Time, mutation, provider, and cleanup bounds:
Observed result and evidence path:
Proof limit:
Decision: continue | constrain | replan | reframe | return to owner
Durable proof admitted? Why, and which weaker proof is removed?
```

Do not run a probe when every plausible outcome produces the same action. Preserve failing fixtures and redacted logs until root cause is established; delete successful disposable state. Update this plan’s current baseline and next gate rather than appending dated reports or creating another plan.

## Delivery increments and dependency gates

### Increment 0/1 — Historical substrate evidence

The original broad npm tarball completed scripts-enabled installation and inert Pi RPC after a plain-JavaScript bootstrap repair. A later synchronization rollback bypassed the shared `tsx` launcher and reproduced the postinstall failure. The accepted fix now routes `postinstall`, `nav:provision`, and installed TypeScript-backed commands through one package-local launcher; the duplicate bootstrap remains deleted.

Do not restore the duplicate plain-JavaScript backend-runtime contract. The launcher already owns every other TypeScript-backed installed command, and npm lifecycle ordering is tested more directly by installing the real npm tarball.

### Increment 2/3 — Package boundary and installed-artifact smoke passed locally

The current npm allowlist produces 248 files and excludes tests, `docs/plan/`, scratch/runtime state, dependency trees, CRG tests, pi-nav development sources, `native/qmd/src`, and the deleted custom Graphify helper. The exact artifact identified above installed with normal lifecycle scripts and loaded all owned runtimes without copying a checkout into the fixture.

The retained deterministic claims are package inventory and identity, scripts-enabled dependency installation, QMD semantic readiness through the shipped Node path, Graphify runtime identity, loaded Pi tools, clean process/lock state, and explicit project-consent behavior. Managed-Git acquisition/update/rollback and onboarding under a genuinely isolated home are not proved.

Do not rerun the custom archive or broad package suites. Repeat this smoke only after package contents, install/runtime selection, extension loading, cold-open, or shutdown behavior changes, and once for a release candidate.


### Increment 4 — Repair worker completion and lifecycle ownership

**Outcome:** `pass` for local process ownership and package seams. Pi and codeweave-pi now know when owned work actually completes.

**Work completed:** `background-launch.ts` directly spawns Node in its own process group; timeout sends TERM then KILL and completion waits for child close plus cleanup grace. QMD remains edit-owned, and Graphify dirty work is coalesced after mutation tool results with explicit-project shutdown drain. Root-only mutation routing and nearest-parent lane inheritance introduced by synchronization rollback were removed.

**Acceptance evidence:** focused Darwin checks cover normal completion, timeout cleanup, dead-lock recovery, path-owned QMD/Graphify batches, nearest-config fail-closed selection, and awaited two-root shutdown. A disposable Linux ARM64 run observed normal worker completion and timeout termination; its non-reaping container PID 1 retained only a dead zombie entry, not a live worker. The current 248-file artifact installed normally, loaded through Pi from the installed path, reached process quiescence after public-tool sessions, and retained only the intentionally persistent stock CRG daemon until explicit cleanup.

**Durable proof:** focused process completion/timeout, per-project mutation, and multi-root shutdown guards replace wrapper-command-shape assertions. Independent review found one stale `agent_end` statement in `requirements.md`; it was corrected to the implemented mutation-tool-result plus shutdown ownership model.

### Increment 5 — Ordinary-project backend gate passed; isolated machine-configuration trajectory remains open

**Outcome:** `pass` for the exact installed artifact's project preparation, provider routing, mutation refresh, loaded queries, and last-good preservation; `inconclusive` for isolated machine-configuration review because this host did not honor the disposable `HOME` inside Pi tool execution.

**Observed proof:** all three semantic lanes became ready; loaded `docs_search`, code search, `trace`, and Graphify map returned project-local evidence; an actual Pi edit turn updated QMD/CRG and exposed the scoped-Graphify prune defect; the final artifact's stop refresh reused the owned corpus root, retained code and docs sources, and preserved semantic mode; an invalid provider refresh exited nonzero without changing the last-good graph bytes or generation.

**Proof limit:** the model required several invalid edit/trace attempts before recovering, onboarding was not safely isolated, direct final-artifact stop refresh rather than another model edit turn owns the corrected Graphify command, and no child/removal/rollback or second-platform claim is made.

**Decision:** constrain. Keep the focused merge-order, credential-recognition, provider-identity, generated-policy, and owned-corpus-root guards. Run onboarding next only under a genuinely isolated OS account/container, then proceed to Increment 6.

### Increment 6 — Prove isolation, removal, and recovery

**Outcome:** one parent/child fixture exercises the expensive product risks without scenario sprawl.

**Work:** add one user-selected independent child, publish the parent exclusion before overlapping evidence can be served, prepare three child artifacts, run positive/negative parent and child queries, exercise policy-only changes, remove isolation safely, then perform package removal, reinstall, rollback, stale-lock recovery, and worker-death recovery while preserving approved user state.

**Acceptance:** no cross-project leakage, no broad-result post-filtering, no unmanaged worker, no destructive cleanup without approval, and documented rollback restores a usable state.

### Increment 7 — GitHub two-platform release decision

**Outcome:** the exact immutable Git ref—not a local-only checkout or transferred archive—is releasable.

**Work:** after the owner selects an accessible GitHub repository and immutable candidate ref, install it through `pi install git:github.com/<owner>/<repository>@<ref>`, run the retained smoke and real-user journey on one supported host, update to a second immutable ref, roll back to the first, then repeat from representative state on the other supported host. Existing unrelated global tools and caches remain in place so package ownership is tested rather than manufactured by cleanup.

**Acceptance:** every binding `requirements.md` release condition is pass; blocked and inconclusive are not pass. npm publication and Apple Developer distribution are outside this decision.

## Ownership, effort ranges, and controlling dependencies

The implementation agent owns disposable probes, shared-code changes inside an accepted increment, focused verification, and plan updates. The package owner approves GitHub repository identity/visibility, immutable refs, supported-platform changes, provider-policy changes, destructive migration, and any weaker release boundary. Backend owners are the current Core, QMD, and Graphify integration modules—not new teams or abstractions.

| Increment | Earliest credible effort from current state | Main driver or external dependency |
|---|---|---|
| 2 — package lifecycle boundary | 20–45 minutes | one focused provision check, dependency/network cache, ordinary pip provisioning, and one minimal Pi RPC smoke |
| 3 — retain smoke | 1–3 hours after a clean manual run | extracting stable commands and deterministic oracles without a framework |
| 4 — worker and turn lifecycle | half to one day | actual Linux process completion plus one real write turn; no wrapper-exit inference |
| 5 — ordinary project | half to one day with warm dependencies | backend preparation and provider availability |
| 6 — isolation/removal/recovery | one to two days | destructive-boundary approvals and retained fixture state |
| 7 — GitHub release | at least one install/update/rollback run per host | repository identity/visibility, immutable refs, package coexistence, and second supported host |

The critical path is repository/ref decision → managed-Git acquisition → isolated onboarding → Increment 6 → Increment 7. Custom-archive validation and exhaustive Python/npm matrices are not on this path.

## Proof portfolio and retention rules

| Proof job | Owner | When it runs | What it may claim |
|---|---|---|---|
| Focused guard | owning module | relevant owner bytes changed | only the escaped local behavior |
| Installed-artifact smoke | package/lifecycle boundary | package, dependency, load, cold-open, or shutdown bytes changed; release candidate | exact listed npm install/load/lifecycle claims |
| Real backend integration | Core/QMD/Graphify owner | affected backend adaptation changed | backend behavior through codeweave-pi, not package publication |
| Agent-run ordinary/nested journey | release owner | immutable candidate | complete recorded user outcomes with deterministic grading |
| Public two-platform journey | package owner | release candidate only | readiness of the tested exact public version and supported targets |
| Internal custom-archive gate | package owner | only if that archive is a declared deliverable | frozen archive/manifest/signing behavior, never npm readiness |

Automate only when `user consequence × recurrence likelihood × unique observability` clearly exceeds `runtime × flake risk × maintenance cost`. A new durable check names the escaped failure, stable oracle, owner, cadence, and weaker proof it replaces. No test is protected by filename or count.

## Risks, early warnings, and contingencies

| Risk | Early warning | Preventive action | Contingency |
|---|---|---|---|
| Allowlist removes provisioning inputs | install reads a path absent from the tarball | trace successful baseline reads before exclusion | restore boundary; replan packaging instead of adding fallbacks |
| Disposable probes never become protection | third repeat or operator-caused invalid run | apply Increment 3’s mandatory trigger | encode only the stable subset immediately |
| Smoke becomes a framework | config/DSL/matrix/reporter appears | one script, fixed claims, deterministic output | delete the abstraction and inline the stable path |
| Timing checks become flaky | sleeps/retries replace completion receipts | await authoritative process/backend signals | keep scenario agent-run until a stable oracle exists |
| Tracing perturbs a race | bug disappears only with telemetry enabled | existing evidence first; minimal opt-in events | compare traced and untraced runs; do not call disappearance a fix |
| Representative host becomes product target | host-specific path or repair enters code | fix shared package owner and wipe fixture | reject the patch and rerun immutable artifact |
| Model review becomes a rubber stamp | pass depends on final prose | deterministic state graders and cited evidence | mark inconclusive; do not promote |
| Existing safety proof is deleted too early | stronger proof does not exercise destructive boundary | claim-by-claim deletion review | restore the focused safety guard |
| Full journey exceeds rapid-feedback budget | ordinary edits trigger provider/platform journey | keep smoke and focused guards separate | move expensive scenario to release-only cadence |

## Execution control and plan self-evolution

- Status is accepted artifacts and observed outcomes, not percentage complete or test count.
- After each evidence-changing probe, update: verified baseline, open decision, next gate, and invalidated downstream increments. Do not preserve stale sequencing.
- Use `Expected / Observed / Violated premise / Proof limit / Decision` for consequential mismatches.
- A local action failure repairs that action. A sequence failure replans dependent increments. A shared-premise failure reframes the approach.
- Requirements changes, platform support, publication, provider defaults, destructive migration, and weaker release acceptance require package-owner approval.
- Implementation agents may add an experiment without permission when it is read-only or disposable, bounded, and can change the next technical action. State-changing work remains within the accepted increment or returns for approval.
- Update canonical docs after an accepted behavior changes. Do not create parallel plan, report, or history files.

## Fresh editable-maintainer installation probe

This proposed release probe tests a disposable copy of the documented contributor path. It is not an alternative installer or permission to clean an active checkout, existing stores, registrations or host configuration.

**Expected user-visible result:** a publisher-prepared copy containing the complete Core payload installs its dependencies, verifies Core/QMD, registers once in an isolated Pi home, and exits without orphaned workers. A source-only clone lacking Core assets must fail before registration, not compile or acquire them implicitly.

**Owning observation:** after separate installation authorization, assemble a disposable copy with `scripts/pi-nav-build.mjs::copyPackageSources`, explicit sealed Core input and matching native artifacts. Use an isolated home/registration and preserve the original checkout and all user stores. Run the documented install path; verify runtime identities, one registration, shutdown and unchanged original artifacts. Do not delete checkout-local graph stores to imitate a fresh clone.

**Stop conditions:** any Pi process using the checkout remains active; a checkout-owned child survives normal Pi shutdown; npm requires an undocumented command or host repair; npm changes tracked source/lockfiles; preparation touches global backend tools/models/state; package-relative readiness is absent; registration overlaps another jeito owner; inert startup writes onboarding/project state; RPC does not exit; or a jeito worker survives. Record the first mismatch as `fail` and do not repair or continue downstream merely to obtain a pass.

**Deferred from this probe:** GitHub acquisition, complete package removal, nested project behavior, provider-backed project preparation, and the second platform. Their current gaps remain documented but do not alter this probe's commands or result.

## Active gate and current stop point

The current local package and ordinary-project backend decision remains `pass` for the previously identified 248-file artifact, a CRG-era receipt recorded before the code lane was retired. That evidence covers scripts-enabled dependency installation, one-key semantic CRG/QMD/Graphify preparation, generated-policy exclusion without feedback storms, mutation refresh over the owned graph corpus, loaded project-local queries, deliberate provider failure with byte-identical last-good preservation, and no surviving fixture worker after cleanup. It does not prove GitHub acquisition, update compatibility in an installed artifact, or the newly changed bytes.

**Expected:** a contributor update preserves existing machine policy/project state and routes package verification → compatibility review → project diagnosis/setup without treating absent YAML as a fresh machine or HOME as a project target.

**Observed:** the initial update probe violated that premise. The shared loader, preflight, doctor, trace provenance, command messaging, setup skills, AGENTS files, and operator docs were repaired. Focused temporary-fixture checks now pass for legacy-only, current-plus-legacy, explicit override, malformed active policy, unsafe HOME, native trace provenance, stopped-Pi repair handoff, inert unprepared startup, and public unavailable-result guidance. A broader 76-test run had 74 passes and two unrelated stale assertions: obsolete Graphify `warming` terminology and a fixture path named `jeito-codeweave-pi` while expecting `codeweave-pi`.

**Proof limit and decision:** constrain. Source behavior is proved; installed-artifact update and actual user continuation are not. Do not run onboarding or project preparation automatically. After the user reloads the repaired package, `/skill:jeito-setup` verifies ownership, `/skill:deep-navigation-onboard` performs read-only compatibility classification before any confirmed policy write, `/skill:navigation-debug` owns symptoms, and `/skill:navigation-setup` owns only an exact approved project. GitHub acquisition, complete package removal, isolated fresh onboarding, nested removal/recovery, the upstream Pi advisory, and the second platform remain deferred.
