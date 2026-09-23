---
name: navigation-debug
description: Diagnose jeito codeweave-pi during real work in another repository. Capture session/root/scope identity, tool interpretation, native/backend parity, source authority, edit/lifecycle/process failures, and produce one compact regression card. Read-only by default; use navigation-setup only after an approved repair.
disable-model-invocation: true
---

# Navigation Debug

Use this skill to find the root cause of jeito codeweave-pi behavior while preserving the foreign repository and its evidence. Optimize for one reproduced failure and the smallest owner-correct fix—not a broad report or workaround route.

## Contract

Read-only by default. Do not:

- install/freshen/rebuild/delete indexes;
- mutate `.pi-navigation.json`, state, global config, or backend artifacts;
- call providers;
- kill processes before proving ownership;
- print API keys, tokens, environment values, or private config values;
- add debug docs/logs to the foreign repository;
- teach agents to route around a product defect.

Allowed: inspect source/config/state/artifacts, run doctor/audit/dry-run, invoke existing query tools, call a backend directly in read/query mode, inspect process/lock metadata, and write redacted evidence under jeito-codeweave-pi's `.tmp/manual-cmux/` or an external temp directory.

If repair is required, stop with an exact plan and switch to `navigation-setup` only after approval.

## Step 1 — capture session and repository identity

Record without guessing:

```text
foreign cwd:
resolved project root:
nested markers (.git/.pi-navigation.json/package roots):
configured scope/includes:
.pi-navigation.json path:
.pi/navigation/state.json path:
loaded jeito-codeweave-pi extension path/version/worktree:
Pi model/thinking/session mode when relevant:
active tool schema/description observed:
```

Read-only commands from the jeito-codeweave-pi extension root:

```bash
npm run nav:doctor -- --path /absolute/foreign-repo --json
npm run nav:prepare -- --path /absolute/foreign-repo --dry-run --json
npm run nav:audit -- --path /absolute/foreign-repo --json
```

Inspect the actual nested-root result. A path passed by the user is a clue; a configured parent is not automatically the correct root.

If the behavior appears after an extension edit/reload, distinguish source state from the handlers/schema already mounted in the current Pi process. A stale loaded session can continue running old lifecycle hooks.

If the loaded package root no longer exists or its source digest changed after process load, classify **loaded-runtime-stale** before project-root or backend diagnosis. Record the loaded package root/version/native target from the runtime warning, stop in-process repair, and hand off to root `jeito-setup` for settings/registration inspection after Pi stops. If the package is current but `.pi-navigation.json` contains an unavailable former absolute command, classify **project-config-stale** and compare doctor `commandIdentity.configured` with `effective`; queries may remain usable through the current owned runtime. If no codeweave-pi copy loads because Pi registration itself points to a missing checkout, this skill cannot run—root setup owns **registration-path-missing**. More than one registered source exposing the same resources is **duplicate-registration** and must be resolved before restart.

## Step 2 — reproduce one user task

Capture:

- exact user task;
- first tool and why it matched the uncertainty;
- exact visible parameters;
- rendered normalization (`Search:`, `Pattern:`, qualified target, graph starts, diff source);
- structural page window, request/root/generation identity, native returned/total, omitted-before/after, and `next_page`;
- native rows, ranks/scores, relationships, snippets, paths, and additive intelligence;
- diagnostics, omissions, scope drift, freshness/health notices;
- editable/partial/locator-only authority status and refusal reason;
- model interpretation and final claim.

Do not infer hidden parameters from model prose. If raw params are not visible, record that evidence limitation.

A tool being invoked is not a pass. Decide whether it was used well and whether its output answered the evidence question.

## Step 3 — classify before changing anything

Choose one primary class:

1. **Agent misuse** — wrong evidence class, invalid query shape, ignored diagnostics, premature boundary collapse.
2. **Schema/runtime guidance** — parameter meaning or local recovery is unclear; mounted schema may be stale.
3. **Renderer/native-output degradation** — backend evidence exists but fields/order/diagnostics/source are lost or misleading.
4. **Graphify health/freshness** — wrong seed, ambiguous node, missing/old graph, degraded refresh, last-good artifact behavior.
5. **Indexed code lane** — package payload missing/stale, consent disabled (`architecture.enabled/autoPrepare`, scope), root not admitted, maintenance child failed or interrupted, or a missing relationship despite prepared graph evidence.
6. **QMD docs lifecycle** — wrong root/index identity, pi-nav projection failure, pending/coalesced refresh, scope pollution, vector-health mismatch, stale selector, or reconciliation omission.
7. **Exact normalization** — grep content-vs-regex, find fragment/filename glob, path with spaces, presentation truncation.
8. **Source authority/provenance** — complete row not certified, transformed/clipped row incorrectly certified, unknown/evicted hash, unseen-line behavior.
9. **Edit engine** — parser, repair, stale recovery, block metadata, file operation, staging, rollback, coordinate continuation.
10. **Lifecycle/performance** — duplicate prepare, wrong hook, CPU spike, main-thread parse, orphaned worker/MCP/parser, stale process registration.
11. **Backend/provider limitation** — direct backend lacks the capability/data or configured provider is unavailable.
12. **Capture/runtime limitation** — cmux/terminal/session prevented observation.

Do not call a surprising result a defect until the test setup, target identity, rendered normalization, and backend data are verified.

## Step 4 — inspect the authoritative layer directly

### Public/native parity

Compare the public output with the backend/artifact that owns the claim. Preserve raw evidence outside canonical docs and redact secrets.

### Graphify

Inspect:

- configured `graphPath` and refresh status;
- graph mtime/last rich-update report;
- actual start-node resolution;
- direct node/edge/path result for the same identities;
- whether the last good graph is usable despite a failed refresh.

Graphify and indexed Core relationships may lag. Check each owner's published identity; bundled pi-nav exact queries certify source independently of graph freshness.

### Core (indexed code lane)

Inspect, read-only:

```bash
node scripts/pi-nav-build.mjs check-core --json
```

Run from the codeweave-pi package root. This checks shipped assets without fetching, compiling or repairing. Verify the payload (maintenance runtime, grammars, pinned code model), the reported indexed preparation status, consent (`architecture.enabled/autoPrepare` and scope), and `maintenance-status.json` under `storage.indexRoot/codegraph/<root-hash>` (default index root `~/.pi/navigation/indexes`). Compare public relationships with direct prepared output, including edges, diagnostics, qualification, page windows and generation identity.

Failed or interrupted maintenance stays unavailable; automatic recovery is not implemented. Independently supported live queries remain useful, but an unavailable graph is not a zero-relationship result. Retired CRG stores are never read, adopted, migrated or deleted; `.code-review-graph` presence is neither current lane health nor a repair target. Missing prepared tests are not proof tests do not exist.

### QMD docs lane

Inspect, without printing content unnecessarily:

- configured root/index path and owned Markdown scope;
- state status, last trigger/outcome, section count, and pending embedding count;
- per-root lane transaction and queued/coalesced refresh ownership;
- current pi-nav section projection/source hash for one affected file;
- direct QMD lexical/hybrid result for the same target;
- returned selector resolution through current `read`;
- whether lexical/hybrid readiness matches provider availability and pending vectors.

There is no docs MCP process, filesystem watcher, second hierarchy manifest, raw Markdown cache, summary layer, or query-time repair. Do not dump vector payloads or secrets.

Never synchronously dump or parse a huge production index merely to debug it. Use size/count/path summaries or a worker/helper. Distinguish backend wall latency from Pi event-loop delay.

### Bundled pi-nav / exact tools

Inspect the rendered normalized request, `details.native`, and exact addon identity reported by doctor/check. Check:

- `grep` resolved syntax/output/case, exact target order, owner groups, cursor and context;
- `find` bare fragment vs filename vs explicit glob;
- `ls` view/depth and whole-entry/subtree truncation;
- effective visibility (`project|all`), policy source/path, custom override flag, candidate/excluded/searched counts, and exceptional reasons;
- whether `.pi/navigation/ignore` exists and therefore suppresses repository Git ignore sources rather than merging with them;
- exact-file ignore bypass versus directory filtering;
- hidden/generated/index artifacts and retained safety exclusions;
- paths containing spaces;
- whether final presentation truncation hid rows before certification;
- addon target/version/schema/capabilities, canonical root, cancellation/completeness diagnostics, and absence of command/PATH fallback.

`nav:doctor --json` reports `exactSearchPolicy` without creating the custom file. Candidate/excluded/searched counts belong to the exact tool's structured result because doctor does not execute a search. If a custom file would help, report the current source/path and switch to `navigation-setup` only after the user approves the exact mutation.

### Source authority and edit

For authority failures record:

- path and eight-hex hash;
- displayed complete row(s);
- authority manifest;
- snapshot seen-line/block state if available;
- current source bytes at the anchor;
- exact rejection class.

For edit failures separate:

- `syntax_error`;
- `unseen_anchor` / truncated reveal;
- `unknown_hash` / collision ambiguity;
- `stale_hash_unrecoverable` and recovery method/refusal;
- `ambiguous_boundary_repair` or repair warning;
- `block_unavailable` and block metadata origin;
- path/symlink/destination/file-operation guard;
- `staging_failed`, `changed_after_preflight`, `commit_failed`, rollback-incomplete paths.

A rejected edit must leave bytes unchanged. A successful edit's fresh hash and coordinate manifest are the next authority; no automatic confirmation read is required.

### Lifecycle/process performance

Capture a bounded process view:

```bash
ps -axo pid,ppid,pgid,nice,etime,%cpu,rss,command
```

Correlate process command/root with prepare locks, lane transaction records, and telemetry before termination. Look for:

- simultaneous session-start/first-broad prepare trees;
- provider-heavy `--full-stack` work before first prompt;
- heavy `agent_end` work (there should be none);
- repeated or overlapping QMD reconciliation instead of one coalesced per-root task;
- an indexing child surviving timeout, abort, or shutdown;
- synchronous large-index parsing;
- event-loop delay vs background CPU.

## Step 5 — choose the smallest correct owner

| Finding | Owner |
|---|---|
| Durable evidence reasoning error that survives product repair | APPEND + doctrine |
| Tool parameter/normalization ambiguity | schema/description |
| Native evidence lost/misordered | renderer/formatter |
| Wrong backend query/mapping | integration code |
| Watch/root/queue/lock/hook/process problem | lifecycle/setup code |
| Parser/recovery/repair/block/staging defect | edit engine module |
| Foreign-repo operator procedure | this skill or navigation-setup |
| Verified implementation/limitation | evidence/current-truth docs |
| One repo/version calibration | regression artifact only |

Never add APPEND text to compensate for a fixable product defect. Never add canonical history that does not explain a current invariant.

## Step 6 — focused regression

Name one smallest test and fixture. Examples:

- renderer/native field loss → `v3-gcformat-output` or owning tool test;
- trace mapping → `v3-trace-guardrails`;
- QMD projection/lifecycle/current-selector behavior → `v3-qmd-docs-search`, `v3-qmd-docs-refresh`, `v3-navigation-freshen`, `v3-clean-break-navigation`;
- live authority → `v3-live-source-authority`;
- edit/recovery/block/transaction → `v3-hashline-read-edit`, `v3-edit-recovery`, `v3-edit-repair`, `v3-structural-block-resolver`;
- lifecycle/loaded state → `v3-loaded-tools`, `v3-agent-session-loaded`;
- main-thread docs health → focused doctor/config QMD readiness tests.
- Core payload/provisioning → `v3-navigation-provision`, `v3-backend-registry`; indexed admission/maintenance → `v3-candidate-analysis-lifecycle`, `v3-prepared-mutation`;

Run the focused test only after the root cause is proven. Escalate based on blast radius.

## Evidence storage and secrecy

Store foreign-repo evidence under:

```text
<jeito-codeweave-pi>/.tmp/manual-cmux/navigation-debug/<case>/
```

or an external temporary directory. Include only:

- redacted command/output excerpts;
- config/state structure without secret values;
- backend comparison;
- process/lock identities;
- regression card.

Do not commit foreign source, private paths beyond what diagnosis requires, raw environment dumps, provider payloads, or index copies. Do not create debug Markdown in the foreign repository.

## Regression card

```text
title:
symptom and user task:
foreign repository + resolved root/scope:
loaded extension/session identity:
tools + exact parameters:
rendered output + diagnostics/omissions:
authority manifest or locator state:
direct backend/source/artifact comparison:
primary classification:
root cause:
smallest fix and owner:
focused regression:
live retest required:
canonical docs/APPEND/schema/skill impact:
redactions and repository cleanup:
```

## Completion gate

Diagnosis is complete only when:

- repository/root/scope identity is proven;
- one failure is reproduced;
- rendered interpretation and diagnostics are captured;
- authoritative backend/source comparison is performed;
- classification names the failing layer;
- smallest reversible fix and focused test are identified;
- no query-time setup/destructive work occurred;
- evidence is redacted and stored outside the foreign docs;
- canonical docs are updated only if the finding generalizes.
