---
title: "jeito codeweave-pi agent and release validation workflow"
description: "Change-surface routing for fast owner checks, cached QMD/container proofs, coherent checkpoints, final release matrices, and live agent evaluation."
tags: [jeito-codeweave-pi, validation, release-gate, evaluation, performance]
created: 2026-07-25
updated: 2026-09-21
status: active
owns: "Evidence tiers, release validation gates, and live agent evaluation procedure"
audience: contributor
code: [scripts/validate-release.mjs, scripts/validate-qmd-container.mjs, scripts/validate-python-matrix.mjs, scripts/navigation-benchmark.mjs, scripts/navigation-tool-feel-eval.mjs]
related: [docs/current-truth.md, docs/evidence.md, docs/harness-doctrine.md]
---

# Agent evaluation workflow

Use this procedure for claims about tool choice, interpretation, runtime UX, lifecycle behavior, or performance. Unit tests and automated capture support these claims but do not close them.

## Required baseline

- Fresh normal interactive Pi/cmux session.
- Current session authentication inherited unchanged.
- Model: `openai-codex/gpt-5.6-luna`.
- Thinking: low.
- Never use `--no-session`.
- Never inspect, configure, request, or diagnose API keys.
- Preserve the normal extension/runtime unless the scenario explicitly isolates one integration defect; record isolation as a limitation.

If this baseline cannot answer one tiny prompt, record a runtime blocker and stop rather than substituting another route.
The doctrinal standard behind this baseline is `docs/harness-doctrine.md:navigation-harness-doctrine/verification-standard#2`.

## Evidence ladder

| Tier | Proves |
|---|---|
| Source and focused tests | implementation contract |
| Fake backend fixture | wrapper/parser/renderer behavior |
| Direct real backend/artifact probe | backend data and integration parity |
| Doctor/audit/state/process evidence | setup/lifecycle health |
| Non-model stress | mechanical latency, CPU, memory, errors |
| Fresh interactive model session | agent tool choice, parameter use, output interpretation, UX |

Do not claim a higher tier from a lower one.
This ladder is the operational form of the verification hierarchy (`docs/evidence.md:current-evidence-map/verification-hierarchy#2`) and the doctrine's verification standard (`docs/harness-doctrine.md:navigation-harness-doctrine/verification-standard#2`).

## Release implementation validation tiers

Validation proves affected claims once. Select the tier from the changed owner; do not start with the broadest command. A later edit invalidates only evidence that can observe that source, fixture, package input, lifecycle, or platform boundary.

### Change-surface routing matrix

| Changed owner | First decisive command | Escalate only when |
|---|---|---|
| TypeScript/JavaScript local contract | exact owning `node --test …` file, then `npm run validate:inner` | a public loaded-tool or backend boundary changed |
| QMD model acquisition, provider selection, indexing, or startup | `npm run validate:qmd` | download/cache code changed: add one temporary empty-cache acquisition; package/postinstall changed: add one checkout/Git install |
| Graphify Python runtime or shared lifecycle | `PI_NAV_TEST_PYTHON=… npm run validate:checkpoint` | package specification or supported Python behavior changed: run the affected platform/minor matrix |
| Package manifest, postinstall, or registration | one package build plus the affected standalone or aggregate install test | both delivery routes changed, or this is a release candidate |
| Native pi-nav bytes or platform selection | `npm run pi-nav:check`, then one affected host/container target | native bytes changed for both Darwin and Linux: run both targets |
| Documentation only | `docs_search`/`grep` consistency and `git diff --check` | commands, generated schemas, skill behavior, or package contents changed |
| Release candidate | `npm run validate:release` once | never repeat without a later relevant change |

One proof must represent one user boundary. Do not run checkout install, standalone Git install, aggregate Git install, and the package suite merely because all are available. Choose the route the change can break; the final release gate owns their combined readiness.

### Fast QMD checkpoint

```bash
npm run validate:qmd
```

This runs model-installer syntax/unit contracts, provider/startup/indexing tests, and cached embedding/reranker load verification. It neither rebuilds Python nor creates Git/package/container fixtures. If model acquisition logic changed, run exactly one clean acquisition separately:

```bash
cache=$(mktemp -d)
XDG_CACHE_HOME="$cache" npm run qmd:model-provision
rm -rf "$cache"
```

That network proof is valid until model URIs, downloader/cache validation, `node-llama-cpp`, or target platform changes. Normal edits reuse the validated cache.

When QMD runtime/platform code changes, run the focused Linux ARM64 boundary instead of the full five-Python matrix:

```bash
npm run validate:qmd:linux
```

This reuses the verified host GGUF cache read-only, uses a persistent npm cache, installs Linux Node dependencies without postinstall, asserts no global `qmd`, and performs real CPU embedding/reranking inside Apple `container`. It proves Linux ARM64 only.

### Inner loop

```bash
npm run validate:inner
```

This owns syntax, one-venv/sentinel behavior, interpreter diagnostics, registry/redaction/policy contracts, and QMD model-installer unit behavior. It performs no network provisioning, package assembly, Git installation, or container work.

### Coherent host checkpoint

```bash
PI_NAV_TEST_PYTHON=/absolute/path/to/a-supported-python npm run validate:checkpoint
```

Use this only after a coherent cross-backend/runtime change. It recreates `.runtime`, verifies the Graphify import/CLI, verifies the already-installed QMD models, runs the affected backend/query-purity fixtures, and checks the host Core package identity.

### Final release gate

```bash
PI_NAV_TEST_PYTHON=/absolute/path/to/python3.14 \
PI_NAV_PYTHON_310=/absolute/path/to/python3.10 \
PI_NAV_PYTHON_311=/absolute/path/to/python3.11 \
PI_NAV_PYTHON_312=/absolute/path/to/python3.12 \
PI_NAV_PYTHON_313=/absolute/path/to/python3.13 \
PI_NAV_PYTHON_314=/absolute/path/to/python3.14 \
npm run validate:release
```

The release orchestrator builds the development archive once and passes it read-only to package, Git, and platform workers. `.tmp/release-validation/` owns reusable pip and QMD caches: one QMD provisioning step publishes the embedding/reranker cache, every host install verifies it, and Linux containers mount the same architecture-neutral GGUF cache read/write instead of downloading another copy. Linux Python images build in bounded pairs; the full Linux behavior run starts only after those images exist.

The orchestrator terminates every active process group on failure or budget expiry. Do not delete shared caches to simulate rigor: use a temporary empty cache only when acquisition itself is the changed claim. Do not rerun a passed tier unless a later change touches its owner.

### Measured validation cost

On Darwin ARM64, `validate:inner` completed in 2.1 seconds. The optimized `validate:qmd` gate completed in 16 seconds: 76 provider/startup/indexing tests took 12.0 seconds and cached real 768-dimensional embedding plus two-document reranking took 1.4 seconds. QMD-only changes previously paid the 63.5-second all-backend checkpoint, so the routed gate removes about 75% of that wall time without dropping QMD-owned evidence. The focused Linux ARM64 container command completed in 14 seconds versus the previous 446.7-second full Linux matrix when only QMD changed. One deliberately empty-cache acquisition downloaded 972,759,040 bytes and verified both inference paths in 1 minute 45 seconds; rerun that network proof only when its owner changes. The previous broad baselines remain: pinned Git lifecycle 131.6 seconds, Darwin Python 94.2 seconds, and complete release 8.3 minutes. Replace those figures only after their optimized gates run.

The setup-side readiness checks are `docs/setup.md:setup-health-repair-and-migration/readiness-verification#2`; current verified status is `docs/current-truth.md:current-truth-and-future-work/implemented#2`.

## One-scenario loop

1. Define one user task and the uncertainty being evaluated.
2. Launch one controlled fresh session; save root, workspace/surface refs, exact prompt, model/thinking, and artifact paths.
3. Observe first tool, visible parameters, rendered output, diagnostics/omissions, interpretation, and final answer.
4. Decide whether the tool was merely invoked or used well.
5. If surprising, inspect authoritative source/backend/artifact directly before diagnosing the wrapper.
6. Classify the failure.
7. Apply the smallest owner-correct fix.
8. Reload/retest the same prompt in the same session when possible.
9. Add one focused regression; add broader tests only when shared blast radius requires them.
10. Preserve a compact artifact and merge only durable findings into canonical docs.

## Failure classification

Use exactly one primary class, with secondary contributors if needed:

- agent misuse or premature boundary collapse;
- unclear APPEND reasoning guidance;
- schema/description parameter ambiguity;
- renderer/native-output degradation;
- stale mounted extension/schema;
- Graphify artifact/health limitation;
- indexed code admission, maintenance-worker, or prepared-relation integration defect;
- QMD root/index identity, pi-nav projection, lifecycle reconciliation, vector-health, or selector-currency defect;
- pi-nav exact-query/typed-metadata normalization defect;

- source-authority/provenance defect;
- edit parser/recovery/repair/block/transaction defect;
- lifecycle duplication/process/CPU/UI blocking defect;
- backend/provider limitation;
- capture/runtime limitation.

A backend defect is not an APPEND workaround. A one-repository calibration is not a global contract until reproduced.
This mirrors the doctrine's change classification (`docs/harness-doctrine.md:navigation-harness-doctrine/change-classification#2`).

## Required product observations

For navigation tasks, inspect:

- the uncertainty before each tool call;
- whether the selected evidence capability could observe it;
- rendered `Search:`/`Pattern:`/qualified target/graph starts/diff source;
- native relationships, ranks, scores, paths, snippets, diagnostics, and omissions;
- whether complete live rows were hash-certified or only locators returned;
- whether the agent continued discovery when unknown relationships could change the answer;
- whether it avoided redundant confirmation reads after sufficient authority;
- whether it overclaimed absence, freshness, impact, or runtime correctness, or avoided a registered prepared capability because of speculative readiness/indexing/freshness concerns not returned by an actual call.

## Operational literacy evaluation

Tool availability and valid schemas are not sufficient. Evaluate whether the agent treats every registered prepared capability as directly callable without health preflight, turns its uncertainty into a strong call, uses consequential features, and adapts from the actual result. Lexical or otherwise reduced active modes must remain usable prepared evidence; request-specific diagnostics must constrain the returned claim without reducing willingness to make later prepared calls.

For each public project-work capability, score five stages:

1. **Intent:** the selected capability can observe the unresolved claim.
2. **Construction:** identity/query packet, mode, scope, and controls are discriminating and valid; unrelated filters are absent.
3. **Leverage:** advanced features are used when consequential—intentional broad defaults, result-driven widening versus paging, secondary candidates, refinement, independent batching, structural selectors, deterministic audits, change views, certified block edits, retries, or scoped diagnostics.
4. **Interpretation:** normalization, qualification, evidence, diagnostics, omissions, authority, and continuation state are read correctly.
5. **Adaptation:** the agent refines, re-anchors, continues, changes evidence class, mutates, or stops for an explicit returned-evidence reason—not a speculative capability-health concern.

Cover all registered tools: `explore` (code search, code traverse, map), `trace` (symbol/file/graph relations and independent batches), `docs_search`, `grep` (ranked/matches/cursor), `find`, `ls`, `read`, `diff`, `lsp_validate`, `edit`, and `write`; include `bash/jobs` for execution and process ownership. A tool merely appearing in the transcript is not a pass.

For cross-component questions, score topology closure rather than tool-name recognition. When an answer depends on how multiple components or layers connect, the agent must invoke `explore(map)` at the first concrete identity, inspect actual starts, and re-enter after a stronger identity when it could change the model. A transcript that explains this trigger without making the call, uses separate docs/source/code hits as a substitute for observed connection evidence, or discovers the omission only in its final answer fails the scenario.

For implementation questions, score identity and structural closure. When the answer depends on which code owner implements a behavior, the agent must invoke code search at the first behavior/signature clue. In mixed results it must inspect non-test candidates plus the excluded-test count/opt-in; in test-only results it must use tests as subsystem evidence without promoting them to ownership. It must inspect secondary candidates or pages and refine while ownership remains open. Once an exact identity exists, unresolved neighborhood claims require traversal and one exact edge requires trace; stronger later identities require re-entry. A transcript that infers ownership/topology from separate grep/source/docs hits, stops after rank one, or explains the omitted code-search call postmortem fails the scenario.

Use at least one hard cross-tool scenario where a familiar grep/read path is tempting, a prepared result exposes a secondary or later-page identity, and a later source/docs/diff/test observation creates a stronger anchor. Also use focused micro-scenarios for modes that one broad task may not naturally exercise. Compare the same prompt and project before/after guidance changes when possible.

Run the normal Luna/low release baseline and a Sol/low targeted regression for instruction-compression and prepared-tool confidence failures. If a fresh session produces no answer, preserve the runtime blocker and stop; static prompt/schema review, direct tool execution, or this active conversation cannot substitute for agent-choice evidence. A capture/runtime blocker does not establish that prepared tools are unavailable or unreliable.
This evaluates the operational-literacy bridge (`docs/harness-doctrine.md:navigation-harness-doctrine/operational-literacy-bridges-reasoning-into-tool-calls#2`) against the agent-operational-literacy evidence surface (`docs/evidence.md:current-evidence-map/agent-operational-literacy-surface#2`).

## Indexed code evidence evaluation

For code-backend search, topology, relation, flow, test, or change-impact claims, evaluate useful signal retention and use—not merely invocation, rank one, call count, or token count.

Capture one signal ledger across:

1. direct current backend/native JSON;
2. wrapper/native structured result;
3. model-facing tool text;
4. typed presentation details;
5. normal and expanded TUI;
6. the agent's interpretation, refinement, reuse, and final boundary.

Record candidates/signatures, qualified identities, nodes, edge direction/kind, provenance/confidence, communities/flows when nonempty, tests, source claims, health/readiness, generation, truncation, fetched lower bounds, page/omission state, and reasons for empty results. Classify every material native signal as normally visible, expanded-only, structured-only, intentionally private with reason, or accidentally lost.

Representative scenarios must include conceptual identity, result-guided query refinement, exact File/symbol topology, debugging with structural relations, unconventional test evidence, multi-page topology, degraded semantic recall with useful lexical evidence, current-diff impact, an unexpected owner that changes the boundary, and a later knowledge delta that justifies code-backend reuse. A scenario where another capability owns the final claim can still demonstrate valuable code-backend boundary discovery.
The backend under evaluation is mapped in `docs/evidence.md:current-evidence-map/lifecycle-and-backend-health#2`; code operator expectations are `docs/setup.md:setup-health-repair-and-migration/backend-expectations/core-code-navigation-and-local-semantics#3`.

### Hard complex indexed-code scenario

At least one advanced-usage evaluation must make source-first narrowing tempting while leaving ownership or topology genuinely unresolved. Construct or select a task where a broad healthy search either reports excluded tests in a mixed result or returns useful test-only/helper/adjacent-type subsystem evidence before the likely owner, the owner appears in a secondary candidate or consequential continuation page, and a later source/diff/test observation supplies a stronger anchor. The agent should:

1. choose code search while the identity/topology uncertainty is still load-bearing rather than letting familiar grep/read hits define the subsystem;
2. distinguish candidate kind, signature, path, retrieval rank, and connection from implementation ownership;
3. inspect secondary candidates and continuation when they can change the identity, then form a more discriminating query from returned vocabulary;
4. traverse a qualified identity for neighborhood evidence and select `trace`, `diff`, `read`, `docs_search`, or map evidence only for the distinct remaining claim each owns;
5. re-anchor code search after a later knowledge delta when the newly visible owner, abstraction, or contract could change the boundary;
6. explain which observation changed the hypothesis and why another code-search observation did or did not remain consequential.

Score the quality of these decisions, not how few calls were made. A source-first answer that eventually finds plausible bytes but never tests unresolved ownership/topology has not passed the scenario. A code-search call that is ignored after rank one also has not passed. Conditional guidance may be admitted from one clearly reproduced decision pattern when direct backend/wrapper parity proves the relevant signal existed; ranking, filtering, projection, or public-surface changes still require repeated evidence that their owning layer caused the failure.

Score whether the agent selected code search when consequential, inspected secondary candidates and signatures, used returned vocabulary to refine, interpreted rank separately from confidence/provenance, reused code search after a genuine knowledge delta, retained useful evidence when switching evidence class, and avoided overclaiming completeness. Do not impose a graph-first rule, one-call rule, mandatory sequence, maximum tool-call count, or token quota.

Before changing ranking, filtering, public operations, or native projection, show repeated scenario evidence that the owning layer—not query intent, health, target qualification, or another projection layer—caused the decision failure. Compaction may foreground primary evidence but must retain unique native signals and explicit omissions.

For edit tasks, inspect:

- eight-hex hash and displayed-line provenance;
- natural operation syntax;
- unseen/stale refusal or recovery behavior;
- repair warnings;
- block span origin;
- post-edit coordinate continuation;
- staging/rollback outcome and unchanged bytes after refusal.

For lifecycle tasks, inspect:

- root/scope identity;
- config/state/artifact paths;
- process tree, niceness, lock owner, queue/generation;
- provider call counts and quality state;
- duplicate work and orphan cleanup;
- event-loop delay separately from backend wall latency.

## cmux discipline

- `cmux ping` must return `PONG`.
- Reuse full `workspace:N` and `surface:N` refs.
- Launch Pi in a shell command that keeps the surface alive after Pi exits; otherwise fast startup failure can destroy the evidence surface.
- Send prompt text and Enter explicitly.
- Capture enough scrollback: a tail can omit an earlier answer even when the interaction passed.
- Run one scenario at a time.
- Use Bash background jobs and `jobs(wait,delta)` for orchestration; do not accumulate hung panes/processes.
- Close surfaces only after the prompt converges or a hard blocker is recorded.

## Regression card

```text
title:
user task / symptom:
repository and resolved scope:
tools + exact parameters:
rendered output + diagnostics/omissions:
direct backend/source/artifact comparison:
classification:
root cause:
smallest code/schema/renderer/lifecycle/docs fix:
focused regression:
live retest required:
canonical owner to update (if any):
secrets/redactions checked:
```

## Change-surface decision

| Finding | Change |
|---|---|
| Durable uncertainty/evidence reasoning or cross-tool composition error | APPEND + doctrine |
| Stable one-capability construction/leverage/adaptation gap | APPEND + doctrine; executable forms in schema/description |
| One tool parameter/normalization/limit misunderstanding | schema/description |
| Wrong backend query/mapping | integration code |
| Root/scope/watch/queue/process problem | lifecycle/setup code |
| Foreign-repo operator procedure | navigation-debug/setup skill |
| Verified current implementation/limitation | evidence/current plan |
| One-off repo/version behavior | artifact/regression card only |

## Minimum release set for broad jeito-codeweave-pi changes

1. Focused owning tests.
2. Related loaded-runtime/schema tests.
3. Direct backend parity when an integration changed.
4. Startup/process/performance check when lifecycle changed.
5. Fresh Luna/low prompt locating the feature/source.
6. Fresh Luna/low end-to-end flow explanation.
7. A realistic foreign-repository failure diagnosed with `navigation-debug`.
8. Agent correctly classifies whether the durable fix belongs in code, schema, renderer, APPEND, skill, or canonical docs.

Automated `nav:cmux-suite` output is capture assistance, not verdict authority. Preserve live artifacts under `.tmp/manual-cmux/`; only durable conclusions belong in canonical docs.
