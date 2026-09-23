---
title: "ADR 4.2 — Provider provenance and human-reviewed upkeep"
description: "Records the per-source provenance ledger, license evidence, mapped-path drift review, provider-apprenticeship-triggering changes, and update obligations."
tags: [jeito-websift, adr, provenance, licensing, drift, upkeep]
created: 2026-07-28
updated: 2026-07-31
status: active
adr_id: ADR-004.002
adr_type: child
decision_status: accepted
confidence: evidence-backed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Provider provenance ledger and upstream upkeep process"
audience: contributor
parent: docs/adr/0004-operations-and-evolution/README.md
related: [docs/upstreams/README.md, THIRD_PARTY_NOTICES.md, docs/adr/0005-provider-evaluation-and-guidance/0004-benchmark-and-selection.md]
---

# ADR 4.2 — Provider provenance and human-reviewed upkeep


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-004 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: evidence-backed`, `evidence_grade: verified`, and `implementation_status: validated`. The metadata—not optimistic prose—governs whether dependent work may treat the decision as proved.

## Decision

Every ported or referenced upstream gets one provenance doc in
[`../upstreams/`](../../upstreams/README.md). Upkeep is **lightweight and
human-reviewed**: `npm view` + diff of *mapped paths only* + human decision. No
tarball-diffing automation, no auto-merge. This matches the settled view that the
provider APIs are stable and churn is infrequent — a doc plus occasional check is
proportionate, and loud failures make breaks detectable.

## Ledger format (one doc per source)

Each `docs/upstreams/<source>.md` records:

- upstream package + repository;
- reviewed npm version + git commit/ref;
- exact source files/functions inspected or ported;
- license + required notice (reproduced where required);
- behavior imported;
- behavior deliberately omitted;
- local divergences + reasons;
- owning local tests;
- last-reviewed date;
- next comparison command (e.g. `npm view pi-web-access version`).
- **pinned upstream ref** — the exact git tag/SHA ported (not just the npm
  version), so `git diff <ref>..<latest> -- <mapped-file>` is reproducible; each
  ported file's top comment also carries `Ported-at: <ref>` beside the
  provenance pointer.

`../../THIRD_PARTY_NOTICES.md` carries the aggregate MIT/Apache notices
(pi-web-access is MIT — preserve it). AGPL source (pi-web-agent) is excluded;
comparison-only, never copied.

## Grounding status

All nine reviewed provider/donor families are source-grounded against their recorded installed or official baseline:
Serper, native/pi-web-access, Exa, Tavily, Linkup, xsearch, Context7, SkillsMP,
and pi-package-search. Each has an active ledger under [`docs/upstreams/`](../../upstreams/README.md);
the dated operation-level grounding and intentionally unmeasured comparative roles live in
[`ADR 5.1 — provider capability roles and starting policy`](../0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md).
Grounding proves contract provenance, not provider quality, priority, or final public selection. Current drift still lowers the affected operation until refreshed—for example, ADR 5.2 records the Exa Contents conformance gap that must close before comparison.

## Upkeep process

1. `/skill:websift-maintain` periodic check reports drifted versions across
   `upstreams/` and the affected local files.
2. Human reviews the mapped-path diff; decides port-or-skip.
3. A port updates the adapter + its test + the provenance doc (last-reviewed,
   divergence) + the governing ADR.

**Version drift is a prompt, not proof.** Every candidate change passes
ownership, behavior, license, and regression review before import.

## Versioning & release of `@alehdezp/websift` (after independent review — finding G1)

The upkeep process above tracks *upstream* drift; this section versions *this*
package. Stay `0.x` until stable; the first stable cut is `1.0.0`.

- **patch** — upstream behavior fix/parity (a re-port of a donor handler fix),
  bug fix, robustness-bound tuning. No new capability.
- **minor** — new provider adapter, new optional fetch handler, new additive tool
  parameter, new `details` key.
- **major** — any breaking change to a public tool schema, parameter, or `details`
  semantics.

> **Owner decision (first-stable gate), default applied, reversible:** `1.0.0` is
> gated on "four tools + Slice-1 providers stable," not "all nine + comparative program," so
> the semver-major bar activates pragmatically. Override to the stricter gate if
> preferred.

### CHANGELOG discipline

A `CHANGELOG.md` at the extension root. One entry per release: version, date, and
per-change a one-liner tagged `[ported]`, `[owned]`, or `[fix]`, with the
provenance link for `[ported]` items:

```
## 0.2.0
- [ported] http.ts: re-port Readability title extraction from pi-web-access@<ref>
  (docs/upstreams/pi-web-access.md).
- [owned] add xsearch social-search adapter.
- [fix] failures.ts: honor Retry-After on 429.
```

### Concrete drift check (the command the ledger lacked)

```
npm view <pkg> version                                 # current published
git diff <pinned-ref>..<latest-tag> -- <mapped-file>   # only mapped paths (repo donors)
# npm-only donors without easy tags:
npm pack <pkg>@<old> && npm pack <pkg>@<new>           # untar both, diff mapped files
```

`websift-maintain` describes the intent; this is the concrete command to put there.

### The four-part silent-drift defense

1. **Loud failures** ([`0004`](../0002-internal-architecture/0002-routing-and-failover.md)) — a break announces itself.
2. **Mapped-path-only diff** — never re-derive the whole donor.
3. **Pinned ref in each ledger doc** — the baseline is explicit.
4. **`[ported]` CHANGELOG line** — every port is auditable.

That chain is sufficient; the only tooling that earns its place is the
`FakeAdapter`/fixture test harness
([`ADR 3.2 — maintainability and verification`](../0003-engineering-stewardship/0002-maintainability-and-testing.md)),
which catches a normalization regression a human review could miss.

### License upkeep

A `[ported]` release that imports a new donor file adds its notice to
[`../../THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md) in the same change.
The six "(confirm)" license markers in
[`../upstreams/README.md`](../../upstreams/README.md) are tracked to closure at each
one's slice.

## First audit fixtures (known drift)

The first upkeep pass should detect these (from the design research, observed
2026-07-27):

| Package | Installed | Current (then) |
|---|---|---|
| pi-web-access | 0.13.0 | 0.14.0 |
| @heyhuynhgiabuu/pi-search | 0.2.3 | 0.3.0 |
| pi-crawl4ai | 0.1.2 | 0.1.5 |
| pi-chrome | 0.15.40 | 0.15.46 |

(Only pi-web-access is a donor here; the others are fixtures proving the check
works. pi-search/crawl4ai/chrome are out of scope as providers.)

## Targeted provider-priority comparison (deferred)

When a starting priority produces a real disputed decision, one focused comparison of
relevance, latency, fallback behavior, context size, and cost may replace that part of the
unmeasured starting policy in [`0003`](../0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md). Provider
rankings are **not hardcoded** before scoped measurements support them. Live provider
calls are opt-in (they consume credits); unit/contract tests use mocked responses.

## What would change this

- Frequent, painful drift for a specific donor → add a mapped-path diff for it
  (still human-reviewed).
- Accepted targeted comparison → replace the affected starting priority with a measured one.

## Alternatives and decisive trade-off

Copying provider behavior without source/version/license evidence makes later refresh unsafe. Whole-tarball auto-diff or auto-merge adds noise and license risk. A per-provider ledger plus mapped-path human review keeps the compared boundary reproducible and challengeable.

## Evidence and verification

`docs/upstreams/`, `THIRD_PARTY_NOTICES.md`, installed package/source reads, and provider fixtures provide current provenance evidence. Comparative provider quality remains outside this ADR and must come from ADR 5.4.

## History

- 2026-07-27: ledger format and lightweight human-reviewed upkeep settled;
  tarball-diffing automation and auto-merge rejected; broad comparison machinery deferred.
- 2026-07-31: corrected the stale three-of-nine grounding statement after Phases 5A–5E completed source review for Linkup, xsearch, Context7, SkillsMP, and Serper; all nine ledgers are grounded, while comparative roles remain unmeasured.
