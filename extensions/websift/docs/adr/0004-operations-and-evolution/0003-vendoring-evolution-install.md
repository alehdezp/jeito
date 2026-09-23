---
title: "ADR 4.3 — Vendored inspection, evolution, and installability"
description: "Records maintainer-only upstream source reproduction, fresh-machine package installation, migration safety, and rollback obligations."
tags: [jeito-websift, adr, vendoring, evolution, installability, rollback]
created: 2026-07-28
updated: "2026-09-23 13Z"
status: active
adr_id: ADR-004.003
adr_type: child
decision_status: accepted
confidence: evidence-backed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Vendoring mechanism, extension evolution, installability, migration, and rollback"
audience: contributor
parent: docs/adr/0004-operations-and-evolution/README.md
code: [vendor.manifest.json, scripts/vendor-fetch.mjs]
related: [docs/upstreams/README.md, AGENTS.md, docs/adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md]
---

# ADR 4.3 — Vendored inspection, evolution, and installability


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-004 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: evidence-backed`, `evidence_grade: verified`, and `implementation_status: validated`. The metadata—not optimistic prose—governs whether dependent work may treat the decision as proved.

Two owner requirements, settled here: (1) keep the source of every upstream we
touch **locally, for inspection and evolution**; (2) make the extension
**installable on someone else's computer from the ground up** — it is not a
personal tool.

## Vendoring model

The source of every upstream we port from or derive a contract from is cloned
into **`vendor/<name>/`**, which is **gitignored**. `vendor/` is a **maintainer**
workspace, **not** part of what an end user installs.

- **End user:** installs the extension; runtime dependencies come from
  `package.json` via npm. They never see `vendor/`.
- **Maintainer:** runs `npm run vendor:fetch`, which reproduces `vendor/` from the
  committed [`../../vendor.manifest.json`](../../../vendor.manifest.json) on any
  machine.

So "gitignore the folders" and "installable elsewhere" are compatible: the
gitignored snapshots are maintainer-only and reproducible from a committed
manifest; the installable artifact (`src/`, `docs/`, `skills/`, `package.json`)
is independent of them.

## The manifest (committed)

`vendor.manifest.json` records per source: `package`, `version`, `repo` URL,
pinned `ref` (tag/branch), `role`, `mappedPaths`, and `subpath` (for monorepo
packages).

- **`role: "port"`** — we copy code from it. Today: `pi-web-access` (the fetch
  pipeline donor).
- **`role: "reference"`** — we inspect it to derive an adapter, while the runtime
  uses the vendor's npm SDK as a real dependency (e.g. `@tavily/core`, `exa-js`).
  Today: the provider Pi-packages (pi-tavily, pi-exa, pi-linkup, xsearch,
  context7, pi-package-search).
- **First-party** jeito code (`serper-search`, `skillsmp-search`) is **not**
  vendored — it is absorbed from the sibling extensions
  ([`../upstreams/serper.md`](../../upstreams/serper.md),
  [`../upstreams/skillsmp.md`](../../upstreams/skillsmp.md)).

Refs are best-known tags/branches. `vendor:fetch` prints the **resolved commit
SHA**, which is recorded in each [`../upstreams/<name>.md`](../../upstreams/README.md)
so the snapshot is auditable and reproducible.

## Evolution workflow (git-pull, what-changed)

1. Bump the pinned `ref` in `vendor.manifest.json`.
2. `npm run vendor:fetch` to refresh.
3. `git -C vendor/<name> diff <old-ref>..<new-ref> -- <mappedPaths>` — see exactly
   what changed, **only in the paths we use**.
4. Decide port-or-skip; port the affected module; update
   [`../upstreams/<name>.md`](../../upstreams/README.md) (resolved SHA, last-reviewed,
   divergence) and `CHANGELOG.md` (tagged `[ported]`)
   ([`ADR 4.2 — provenance and upkeep`](0002-provenance-and-upkeep.md)).

[`/skill:websift-maintain`](0001-setup-doctor-maintenance.md) orchestrates this.
No auto-merge, ever — version drift is a prompt to look, not proof to import.

## Fresh-machine installability (first-class)

This must hold for **someone else's** machine:

- **Distribution intent at acceptance:** a jeito sub-extension installed through an aggregate Git ref or a prepared local checkout; standalone npm publication remained a future option. The earlier `jeito/codeweave-pi` Git slug was a proposal, not a published release. [Current installation guidance](../../../README.md#installation-and-first-use) owns the selected repository identity and the local-only standalone path.
- **Runtime deps declared, not vendored:** `package.json` lists everything the
  extension runs on (typebox, yaml, @mozilla/readability, linkedom, turndown,
  p-limit, @tavily/core; unpdf optional). `npm install` fetches them on any
  machine. **`vendor/` is not required to install or run.**
- **No machine-specific assumptions:** no hardcoded home paths in runtime code —
  config resolves via `PI_CODING_AGENT_DIR` → `XDG_CONFIG_HOME/pi` → `~/.pi`
  ([`ADR 2.4 — configuration and credentials`](../0002-internal-architecture/0004-config-and-credentials.md)); upstreams
  are referenced by URL in the manifest, not by local path.
- **Optional runtimes are lazy:** `unpdf` is an optional package (PDF handler) and
  `yt-dlp` is the optional external binary (YouTube handler); each is loaded or
  detected only by its handler at use time, and absence degrades that handler
  (reports `unavailable`) without blocking base install
  ([`ADR 2.3 — composable fetch pipeline`](../0002-internal-architecture/0003-fetch-pipeline.md)).
- **Fresh-machine sequence:** install → restart Pi → `/skill:websift-setup` (seeds
  `web.yaml` only if absent, reports credential presence, prints per-shell set
  lines) → set keys (env or inline) → done. Missing optional providers never warn
  at boot.

## What would change this

- If a vendored reference proves useless (we only ever use its SDK), drop it from
  the manifest — vendoring is cheap but not free.
- If standalone distribution becomes important, publish `@alehdezp/websift` to npm
  (the manifest/`vendor/` stay maintainer-only either way).
- If shallow clones hinder a needed diff, `git fetch --unshallow` in that snapshot.

## Alternatives and decisive trade-off

Committing dependency snapshots would bloat and blur first-party ownership; keeping no reproducible source would make evolution depend on one machine. Gitignored maintainer snapshots reproduced from a committed manifest preserve inspectability while npm/Pi own user installation.

## Evidence and verification

`vendor.manifest.json`, `scripts/vendor-fetch.mjs`, package manifests, and root installation contracts validate the reproducible ownership split. Managed remote delivery remains constrained by Pi Git-source and monorepo rules.

## History

- 2026-07-27: added on owner approval of the design — vendoring (gitignored,
  manifest-driven, git-pull evolution) and fresh-machine installability made
  first-class. `@tavily/core@^0.3.7` added as the verified runtime SDK dependency.
