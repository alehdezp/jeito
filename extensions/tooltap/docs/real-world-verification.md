---
title: "Real-world tooltap verification contract"
description: "Live route checks and compatible-runtime evidence for the Git-distributed tooltap package."
tags: [tooltap, live-verification, provider-routing, tools, git-distribution]
created: 2026-07-26
updated: 2026-09-17
status: active
owns: "Live route proof and compatible-runtime evidence"
audience: contributor
---

# Real-world tooltap verification contract

Local tests prove policy and state mechanics. Live checks prove only the selected runtime/provider behavior they directly exercise. They are not comparative benchmarks or product scores.

## Evidence unit

Record one exact tuple:

```text
provider + API + model + Pi build/version + tooltap version + tool.yaml route
```

The Pi build matters: native needs cache-safe `setActiveToolsWithDeferred` plus registered lookup; direct needs dispatch APIs; gateway needs registered lookup. Stock version numbers alone do not establish these capabilities. Missing native capability selects gateway before the first request. Missing gateway lookup never authorizes target-schema promotion: verify `tools` remains present and late enablement preserves provider declarations and the earlier system prefix.

## Fast gateway regression gate

Run this gate before broad suites, documentation work, or model-matrix testing:

1. Run the focused harness and require its gateway checks to prove one stable serialized control declaration, target absence, and real wrapper execution together.

   ```bash
   npm test --workspace @alehdezp/tooltap
   ```

   Require `gatewayToolArrayByteStable: true`, `gatewayProxyExecution: true`, `bm25CuratedAutoEnable: true`, `capabilityAmbiguityNoMutation: true`, and `unsupportedRuntimeKeepsControl: true` in the summary.
2. Start one fresh configured proxy session and capture the provider declaration before enablement.
3. Call `tools({request:"find Pi documentation for developing extensions"})`; require one `pi_docs` enablement, then capture the declaration again and require byte identity plus `pi_docs` absence.
4. Call `tools({request:"pi_docs",arguments:{}})` and require the real documentation list.

Stop at the first failed signal. A missing `getRegisteredTool` is a runtime capability failure, not permission to activate `pi_docs` ordinarily. A provider rejection before any `tool_execution_start` is a provider request failure, not evidence against gateway dispatch. A model that omits the second call is a compliance failure only after the deterministic wrapper harness passes. Failure ownership and forbidden shortcuts are mapped in `docs/how-pi-tools-reach-models.md:how-tooltap-makes-deferred-tools-visible-and-executable/use-the-smallest-regression-gate-before-broad-verification#2`.

## Common direct checks

Use a fresh session and one harmless unfamiliar tool with a nested schema.

1. Capture the initial provider request and verify the target schema/instructions are absent.
2. Call `tools` with one capability request and retain the exact contract result.
3. Perform the route-specific exact execution.
4. Confirm the real underlying result—not narration or a substitute—returned.
5. Confirm current descriptions/results contain no historical public names.

Capture tool-container names/hashes to prove structural invariants only. Do not turn call counts, provider rounds, token usage, or cache totals into an adoption score.

## Native

- With an empty epoch baseline, the public control schema is exactly `tools({request})`.
- Pi capability metadata selected native before the first request.
- Enablement adds the target only through Pi's deferred representation.
- The model calls the exact target directly and receives its real result.
- `arguments` is absent from the current `tools` schema.
- Duplicate enablement returns no schema and instructs the direct exact call.
- A tool enabled late stays out of the ordinary baseline until a genuine model switch; after the switch it appears with its full schema and calls directly.

## Direct

- With an empty epoch baseline, the public control schema is exactly `tools({request})`.
- The target remains absent from provider tool containers after enablement.
- Dispatch permission changes and the undeclared exact call executes.
- `arguments` is absent; duplicate guidance directs the exact call.
- Removing dispatch or registered-tool runtime APIs must not remove `tools`, but must also never promote enabled gateway targets into ordinary provider schemas.
- A late target remains absent from ordinary provider schemas in the current epoch; after a genuine model switch it enters the next ordinary baseline.

## Gateway

- The control schema is exactly `tools({request, arguments?})`; ordinary baseline tools may coexist beside it.
- A target enabled late remains absent from provider tool containers in that epoch.
- First-contact `arguments` fails without enabling or executing.
- `tools({request})` returns the real contract.
- `tools({request:<exact enabled name>, arguments:{...}})` validates and executes.
- Invalid arguments do not reach the target; repeated valid execution works.
- Cancellation, updates, underlying errors, frozen results, and non-text content survive.
- After a genuine model switch, every previously enabled eligible target appears with its full schema and is directly callable; wrapper execution remains accepted as compatibility.

## Model-epoch lifecycle

Use one hands-off session and inspect provider payloads, not registry inventory:

1. On gateway model A, enable `X`; prove `X` is absent from ordinary `tools[]` and executes through `tools({request, arguments})`.
2. Switch provider/model; prove `X` appears once with its full schema in ordinary `tools[]` and executes directly without another control call.
3. Enable `Y`; prove `X` remains baseline while `Y` stays late through the selected route and the ordinary declaration remains stable within the epoch.
4. Switch again or back; prove `X` and `Y` are both ordinary baseline tools. Enable gateway `Z` and prove only `Z` remains late.
5. Resume the same model from v2 state; prove baseline and late classification is unchanged. Resume names-only v1 state; prove all restored names remain late until a genuine switch.
6. Compact, then prove only a late tool receives one contract refresh; a baseline tool receives none because its schema is already present.
7. Confirm historical enablement guidance says direct for baseline and route-late execution for late names; completed execution results stay unchanged.
8. Re-run startup/late normalized collisions and startup/late foreign `tools` ownership checks.

Record ordinary tool names and structural hashes before late enablement, after late enablement, and after switching. A passing epoch changes once at the model boundary, not during gateway/direct late enablement. These hashes prove declaration ownership only; they are not a comparative score.

## Host completion

Repository checks are not live completion. Through `/skill:jeito-setup`:

1. preview shipped versus active `tool.yaml`;
2. create an exact timestamped backup;
3. obtain confirmation;
4. write atomically;
5. restart Pi;
6. verify exactly one public `tools` and the selected route behavior;
7. exercise rollback if any direct check fails.

If the user declines host migration, report repository implementation as not active.

## Current evidence boundary

The disposable `.tmp/tooltap-one-control/` runs established gateway Muse, direct DeepSeek, native Codex, same-owner route registration, stable gateway declarations, and gateway-history-to-native replay. Comparative counts from those runs were explicitly withdrawn and have no adoption authority. Fresh release checks must use production code and the reconciled host.

The 0.6.1 repository harness exercises model-epoch baseline/late state, exact identity changes, optimized direct late dispatch, same-model v2 restoration, conservative/malformed restoration, history guidance, deferred-classification cleanup, gateway declaration byte stability, proxy execution, and permission isolation. The active additive Pi runtime then passes real `tools → pi_docs` proxy execution without activating `pi_docs`.

RPC call sequences independently show `tools → epoch_x`, then baseline `epoch_x` without `tools`; `tools → epoch_y`, then baseline `epoch_x → epoch_y` without `tools`.

Fresh `opencode-go/muse-spark-1.2-contributor` and `commandcode/meta/muse-spark-1.2-contributor` processes accepted the natural capability request `find Pi documentation for developing extensions`, enabled only `pi_docs`, and returned the real 46-file result through `tools({request:"pi_docs",arguments:{}})`. The opencode provider snapshot proves `tools` remained present, provider `tools[]` stayed byte-identical, and `pi_docs` remained absent before/after enablement. That earlier concise-blurb snapshot measured 3,832 bytes versus its previous 4,652-byte baseline; it does not own the later source-description size. Evidence: `.tmp/stow-model-epoch/muse-opencode-pi-docs-summary.json` and its indexed context dumps.

The source-ownership correction is independently covered by `.tmp/additional-tools-eval/context7-source-owned-summary.json`: a fresh opencode Muse process preserved the natural capability request, enabled `context7` from the registered description of trusted loader source `legacy-local-source`, kept provider declarations byte-identical with `context7` absent, and returned real TypeBox documentation through strict gateway execution. The provider manifest contained the complete canonical Context7 description and no `tool.yaml` duplicate; its measured 5,221 bytes retain the compact active-name line while carrying richer source-owned discovery text.

### Verify native activation with Pi's generated system prompt

Pi 0.85.1's ordinary `setActiveToolsByName` inserts newly active tool snippets/guidelines into the early system prompt. Stable deferred `tools[]` placement does not prevent this cache invalidation. `patches/ensure-pi-registered-tool-api.mjs` now supplies cache-safe activation; `tests/tooltap-native-runtime.test.mjs` exercises the actual patched SDK in a disposable copy, never the installed package. Its negative control proves the old ordinary call changes the generated prompt. Native/gateway enablement, repeated real target execution, registry refresh and same-model restoration must then preserve that prompt while activation results retain full guidance.

Run `npm run test:cache-prefix` at the repository root. `PI_TEST_RUNTIME=/absolute/path/to/pi-coding-agent` selects another installed SDK as read-only input. The generated-prompt regression passed against Pi 0.84.3 and 0.85.1; the separate fixed-system serializer/reminder tests retain their narrower claim. Runtime patch tests exercise source-anchor rejection, idempotence, validation and prompt behavior; `npm test --workspace @alehdezp/tooltap` also requires the native capability gate, complete guidance and rejected-activation permission checks.

On 2026-09-17, a patched isolated Pi 0.85.1 SDK with the normal generated prompt completed six requests and two real target executions on each of native and gateway `openai-codex/gpt-5.6-luna`. Every captured final-hook transition preserved instructions, ordinary declaration bytes, cache key and all prior input items, including custom-message arrival and reminder refresh. Both routes measured cache reuse (native up to 3,584 cached tokens; gateway 2,560); cold misses also occurred with unchanged client prefixes. No lookup shim or fixed-system override was used. Evidence: `.tmp/stow-cache-investigation/luna-generated-{native,proxy}-summary.json` and `luna-live.ts`.

The generated-runtime regression also injects a rebuild failure and requires complete activation rollback, so a failed tool enablement cannot silently grant dispatch without its deferred result. Patch tests are portable (default workspace Pi or `PI_TEST_RUNTIME`), reject ambiguous/drifted API bodies and invalid ESM before writes, and verify check-only/idempotence and backups. This failure-path proof supplements the successful-path Luna runs; it is not a new provider benchmark.

This closes the reproduced native prompt-builder defect in source and isolated execution, not deployment into an already running host. Runtime installation/restart and confirmed host `tool.yaml` reconciliation are separate delivery checks. Provider cache hits, model-switch rebasing and compaction remain outside the within-epoch byte-stability guarantee.

## Assess public npm release readiness

Public npm publication is a separate claim from jeito-host completion. This section records the 2026-08-25 assessment; it is decision support, not a commitment to complete every item.

### What the current package proves

Version 0.6.1 passes its typecheck, deterministic harness, package dry-run, and fresh jeito gateway regression. A real tarball also installed into an isolated directory with its Pi manifest, extension source, and MIT license intact. An audit of that isolated production dependency tree reported no known vulnerabilities. A disposable copy of the tarball passed `npm publish --dry-run` after removing `private` and adding public scoped-package access; this proves the package shape, not registry authority or runtime compatibility.

### Runtime compatibility is the load-bearing release gate

The latest public `@earendil-works/pi-coding-agent` observed in the npm registry was 0.84.3. Its stock `ExtensionAPI` exposed none of `getRegisteredTool`, `getDispatchTools`, or `setDispatchTools`. The active jeito 0.84.3 build carries an additive `getRegisteredTool`, which is why strict gateway execution succeeds here; that host-local proof does not transfer to a public installation.

Publishing with the current peer range, `>=0.84.2`, would therefore admit stock runtimes that can discover and enable a gateway target but cannot execute it. Missing dispatch methods may safely degrade direct routing to the gateway, but gateway correctness still requires public registered-tool lookup. The preferred release gate is a public Pi version exposing `getRegisteredTool`, followed by setting the peer minimum to that version and exercising the installed tarball against that unmodified runtime. Do not replace this gate with ordinary target-schema promotion: that would violate the gateway cache contract.

### Publication controls still need an explicit decision

The source package deliberately has `private: true`, so the real workspace is not publishable. If public publication is chosen after the runtime gate clears, remove that guard deliberately and add `publishConfig.access: public`; scoped npm packages otherwise require an explicit public-access choice.

The audit host was not authenticated to npm: `npm whoami` returned `ENEEDAUTH`, while `npm view @alehdezp/tooltap` returned E404. E404 does not distinguish an unclaimed public name from a private or unauthorized package. Authenticate, prove control of the `@alehdezp` scope, and confirm the target name immediately before publication.

Publish from a clean release commit and immutable tag rather than the current broad dirty worktree. Build and install the final tarball from that tag so its bytes, source, and rollback point are reproducible.

### Optional public-package improvements

These are worthwhile choices, not correctness gates:

- Add authoritative repository, issue tracker, and homepage metadata once those public locations exist; the audited checkout had no configured Git remote from which to derive them.
- Decide whether the public tarball should retain the test harness, fixture, historical ADRs, internal research, future roadmap, and old patch documentation. The audited package was 114 kB compressed and 390 kB unpacked across 32 files; keeping the archive is defensible, but a smaller `files` allowlist would give public consumers a clearer package.
- Keep direct-route optimization explicitly unproven until a public runtime exposes dispatch APIs. This does not justify weakening the tested gateway fallback.

### Final public-release proof

After those decisions, require one clean sequence: set the truthful peer minimum; build from the release tag; install dependencies and register the tarball in a clean environment; restart stock Pi; prove one public `tools`, exact discovery, gateway declaration byte identity, late-target absence, and real wrapper execution; run `npm publish --dry-run`; then publish only if npm scope authority is also verified.
