---
title: "Prepared corpus and navigation project contract"
description: "Planned shared model for project-owned corpora, explicit one-project queries, available-project discovery, and backend-specific corpus materialization."
tags: [jeito-codeweave-pi, corpus-contract, project-selection, scope-routing, query-purity]
created: 2026-07-27
updated: 2026-07-27
status: active
owns: "The planned entities, invariants, selection rules, and configuration boundary for nested navigation projects"
audience: contributor
code: [src/core/navigation-config.ts::resolvePreparedLane, src/core/project-root.ts::detectProjectRoot, src/core/navigation-desired-state.ts::compileNavigationDesiredState, src/core/prepared-mutation.ts::notifyPreparedMutation]
related: [docs/plan/README.md, docs/plan/adversarial-review-prompt.md, docs/plan/evidence-ledger.md, docs/plan/implementation.md, docs/harness-doctrine.md]
---

# Prepared corpus and navigation project contract

## Contract status and current limitation

This document defines planned behavior. Current configuration has one active `architecture`, `docs`, and `graph` lane per configuration root. A second scoped preparation replaces that lane’s configuration/state instead of adding a coexisting project. Current ancestor traversal in `src/core/navigation-config.ts::resolvePreparedLane` also accepts enabled ancestor lanes without proving they own the requested scope.

The governing current invariant remains query-time purity in `docs/harness-doctrine.md:navigation-harness-doctrine/query-time-purity-and-lifecycle-ownership#2`.

## Navigation project, corpus, and artifact definitions

A **navigation project** is the nearest valid `.pi-navigation.json` boundary for a canonical requested path. It owns:

- one canonical corpus root;
- normalized `scope.exclude` subtrees, including explicitly independent children;
- enabled prepared lanes;
- project-local backend artifacts, locks, generations, and health.

The canonical configuration root is the runtime/lifecycle key. Basename labels are diagnostic only; no persisted project UUID or user-facing project namespace is justified without a concrete cross-checkout consumer.

A **corpus** is the complete file set admitted before parsing, embedding, relationship extraction, or ranking. `scope.exclude` belongs to corpus construction; repository-native user ignore files remain separate policy sources.

An **artifact** is one backend’s prepared representation of that corpus:

- CRG `.code-review-graph/graph.db`;
- Graphify verified `graph.json` generation;
- QMD section SQLite database and vector state.

A **requested scope** is the caller path used to locate the nearest boundary. It never authorizes narrowing a broad artifact after construction.

## Scoping is not result filtering

Strict project isolation requires selecting an artifact built from that project’s corpus. It cannot be implemented by:

- searching a broad CRG graph and dropping rows outside a path;
- traversing a broad Graphify graph and hiding cross-project nodes afterward;
- retrieving QMD’s global candidate window and applying a path/glob filter afterward.

Those approaches alter presentation, not corpus membership or relationship construction. They also lose relevant results before filtering when native candidate limits saturate.

A backend-native subfolder constraint may replace a separate artifact only after direct evidence proves that parsing, relationship construction, candidate retrieval, traversal, and lifecycle refresh all remain scoped before result generation. No current backend satisfies that complete contract.

## One-project query and available-project discovery

Every prepared call selects exactly one navigation project:

```text
requested scope
-> canonical target
-> nearest valid .pi-navigation.json
-> enabled prepared lane with matching corpus-policy identity
-> one backend query
```

If the nearest boundary omits or disables the requested lane, selection returns unavailable. It must not continue to a farther ancestor. If the requested path lies under a parent exclusion, the exact excluded directory may be advertised only when it contains a valid project-local configuration and prepared lane; otherwise the path remains unavailable.

The response discloses requested scope, selected configuration root, corpus root, backend artifact, and policy/generation identity. Other valid child projects may be listed as not searched, but codeweave-pi never claims they contain results without querying them.

No public `project` parameter is needed initially. Canonical scope already determines the boundary, avoids a second identity namespace, and works for external absolute paths. Add an explicit selector only if a demonstrated caller cannot express its target as a path.
## External path selection

An explicit absolute scope outside the session project may select a prepared project at that path. Resolution must stop at the external project’s own verified boundary. It must not consult unrelated configuration under the current working directory or search the user’s home for candidates.

If no prepared project owns the path, the query returns unavailable and identifies the explicit setup action. Query time does not create configuration or artifacts.

## Shared corpus shape and artifact-local backend policy

The first portable corpus model is:

```text
corpus root + excluded subtree prefixes
```

Values are normalized project-relative directory prefixes. Reject absolute paths, escapes, empty segments, and symlink targets outside the canonical root. Do not accept globs, negation, or backend syntax.

One pure compiler produces normalized prefixes and a digest. Each backend applies that value at its artifact boundary:

- CRG serializes anchored additive lines to `<project>/.pi/navigation/crg.ignore`; the bundled backend reads this after defaults and user `.code-review-graphignore`.
- Graphify receives repeated native `--exclude <prefix>` arguments, persisted in its output-owned `.graphify_build.json`; user Git/Graphify rules remain active.
- QMD filters normalized paths after pi-nav discovery and before section projection; `.pi/navigation/ignore` remains exact-tool policy.

These adapters intentionally differ because backend lifecycle ownership differs. They share a value, not a universal ignore file or parser.

## Accepted configuration shape

Reuse existing top-level lane configuration and `scope.exclude`:

```json
{
  "schemaVersion": 2,
  "scope": {
    "exclude": ["extensions/codeweave-pi", "generated"]
  },
  "architecture": { "enabled": true },
  "docs": { "enabled": true },
  "graph": { "enabled": true }
}
```

An independent child has its own `.pi-navigation.json`. The parent does not carry child lane configuration or a project catalog. Configuration stores no host runtime path, artifact generation, canonical absolute path, or derived project identifier.

## Corpus preview and policy identity

Before preparation, setup must invoke each backend’s actual read-only enumerator and show admitted, ignored, hard-pruned, unsafe, and incomplete counts. One shared policy digest is insufficient unless it also binds backend version and translated rules.

The project state should preserve:

- canonical root identity for the current checkout;
- normalized corpus exclusion digest;
- backend/version plus materialized-policy digest;
- admitted corpus snapshot or manifest identity;
- artifact generation and last successful probe.

A changed corpus policy is lifecycle drift. Query time reports it; approved setup/lifecycle work reconciles it. Correctness requires configuration exclusion digest and prepared artifact policy digest to match.

## Path-owned lifecycle

Current edit/write hooks call `src/core/prepared-mutation.ts::notifyPreparedMutation` and QMD refresh using the session working directory. Nested projects require changed paths to be grouped by nearest owning boundary before scheduling:

```text
changed files -> nearest configured boundaries -> project-local CRG/QMD/Graphify refresh
```

Parent lifecycle examines only exact `scope.exclude` directories when advertising children. It never recursively scans package markers. Unchanged, disabled, or policy-clean projects produce no backend/provider work.

## Rejected alternatives and completed decision gate

- Ancestor lane inheritance after the nearest project boundary.
- A central `projects` catalog, generated project identifiers, or global registry.
- Automatic package discovery/indexing or query fan-out.
- Result filtering presented as project isolation.
- A universal ignore file or unrestricted pattern grammar.
- Managed Graphify/CRG user-file blocks when artifact-local policy is available.
- Using `.pi/navigation/ignore` as QMD prepared-corpus policy.
- Persisting current-machine runtime paths in portable configuration.

The independent review required by `docs/plan/adversarial-review-prompt.md:adversarial-review-prompt-for-nested-navigation-projects#1` completed. It rejected the catalog and prompted the artifact-policy reframe. Follow-up Graphify and CRG execution selected the accepted shape above; future work must reopen it only when new evidence violates one of its predictions.
