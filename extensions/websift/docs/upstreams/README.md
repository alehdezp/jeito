---
title: "Upstream provenance ledger — jeito websift"
description: "Index and format of provenance records for every upstream source jeito websift ports from or derives a contract from, with grounding status and upkeep commands."
tags: [jeito, web, provenance, upstreams, licensing, ledger]
created: 2026-07-27
updated: "2026-09-24 08Z"
status: active
owns: "Upstream provenance ledger index and format"
audience: contributor
related: [docs/README.md, docs/adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md, THIRD_PARTY_NOTICES.md]
---

# Upstream provenance ledger

One doc per upstream source. The ledger exists so any ported behavior is
traceable to its origin, license, and last review — and so `websift-maintain` can
check drift. See [`ADR 4.2 — provider provenance and human-reviewed upkeep`](../adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md)
for the process and [`ADR 3.1 — retrieval-first documentation and ADR/code links`](../adr/0003-engineering-stewardship/0001-documentation-and-code-links.md)
for the code→doc pointer convention.

## Ledger format

Each record carries: upstream package + repository; reviewed npm version + git
ref; exact files/functions ported; license + notice; behavior imported; behavior
omitted; local divergences + reasons; owning tests; last-reviewed date; next
comparison command.

## Index

| Source | Package | Version | License | Role | Grounded |
|---|---|---|---|---|---|
| [`pi-web-access.md`](pi-web-access.md) | `pi-web-access` | 0.13.0 | MIT | fetch pipeline donor | ✅ source read |
| [`tavily.md`](tavily.md) | `@weihan28/pi-tavily` | 1.0.2 | MIT (confirm) | Tavily adapter contract | ✅ source read |
| [`serper.md`](serper.md) | `@alehdezp/serper-search` | 0.1.0 | UNLICENSED (first-party) | Serper adapter (absorbed) | ✅ source read |
| [`exa.md`](exa.md) | `@capyup/pi-exa` | 0.5.1 | MIT | Exa adapter | ✅ source read |
| [`linkup.md`](linkup.md) | `@aliou/pi-linkup` | 0.11.0 | MIT declared; license file absent | Linkup adapter | ✅ source read |
| [`xsearch.md`](xsearch.md) | `@pi-lab/xsearch` | 1.0.3 | MIT | social search adapter | ✅ source read |
| [`context7.md`](context7.md) | `@dreki-gg/pi-context7` | 0.2.0 | MIT | Context7 lookup adapter | ✅ installed source read |
| [`skillsmp.md`](skillsmp.md) | `@alehdezp/skillsmp-search` | 0.1.0 | UNLICENSED (first-party) | SkillsMP lookup (absorbed) | ✅ source read |
| [`pi-package-search.md`](pi-package-search.md) | `pi-package-search` | 0.1.1 | MIT | Pi package lookup adapter | ✅ source read |

"Grounded" = source read in this effort. "Metadata only" = verified
package/version/repo/registered-tools/license-as-recorded; porting detail is
filled during the owning slice (no inference). See
[`ADR 5.1 — provider capability roles and starting policy`](../adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md).

## Excluded upstream

`pi-web-agent` (AGPL-3.0-only) is comparison-only; no source is copied. Other
installed-but-excluded packages (`@heyhuynhgiabuu/pi-search`, `pi-crawl4ai`,
`pi-chrome`) are not providers here; they appear only as drift fixtures in
[`ADR 4.2 — provider provenance and human-reviewed upkeep`](../adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md).

## Vendored snapshots (gitignored `vendor/`)

Every source above is cloned locally into `vendor/<name>/` for inspection and
evolution — **gitignored**, maintainer-only, **not required to install or run**
the extension. Reproduce from the committed
[`../../vendor.manifest.json`](../../vendor.manifest.json):

```
npm run vendor:fetch    # clone/refresh all at pinned refs
```

| Source | `vendor/<name>` | role | pinned ref |
|---|---|---|---|
| pi-web-access | `vendor/pi-web-access` | port | v0.13.0 |
| pi-tavily | `vendor/pi-tavily` | reference | v1.0.2 |
| pi-exa | `vendor/pi-exa` | reference | v0.5.1 |
| pi-linkup | `vendor/pi-linkup` | reference | v0.11.0 |
| xsearch | `vendor/pi-lab-xsearch` (subpath `packages/xsearch`) | reference | main |
| context7 | `vendor/pi-context7` (subpath `packages/context7`) | reference | main |
| pi-package-search | `vendor/pi-package-search` | reference | main |

`port` = code is copied into first-party sources; `reference` = inspected to derive an adapter
(the runtime uses the vendor's npm SDK). First-party serper/skillsmp are absorbed
from sibling extensions, not vendored. Refs are best-known; `vendor:fetch` prints
the resolved commit SHA — **record it in each provenance doc** so the snapshot is
auditable.

**Update one source:**
```
# bump ref in vendor.manifest.json, then:
npm run vendor:fetch
git -C vendor/<name> diff <old-ref>..<new-ref> -- <mappedPaths>
```
Decide port-or-skip; port the module; update the provenance doc + `CHANGELOG.md`.
See [`ADR 4.3 — vendored inspection, evolution, and installability`](../adr/0004-operations-and-evolution/0003-vendoring-evolution-install.md).

### Resolved snapshots (vendored 2026-07-27)

| Source | resolved SHA | note |
|---|---|---|
| pi-web-access | `7bdc30a65cf7` | tag `v0.13.0` exact (port donor) |
| pi-tavily | `279650620596` | tag `v1.0.2` not found → default branch (reference-only; runtime uses `@tavily/core@^0.3.7`) |
| pi-exa | `8da1600c459e` | tag `v0.5.1` exact |
| pi-linkup | `3d2588910cf0` | tag `v0.11.0` exact |
| pi-lab-xsearch | `d78f2dabc9ec` | `main`, subpath `packages/xsearch` |
| pi-context7 | `d36aebb52c0` | tag `@dreki-gg/pi-context7@0.2.0` (corrected after `main` removed the package) |
| pi-package-search | `ec26ed0ec226` | `main` |

Where a tag was not found (pi-tavily), locate the matching release commit before
relying on the snapshot for a port. This only matters for `port`-role sources —
today just pi-web-access, which pinned exactly.
