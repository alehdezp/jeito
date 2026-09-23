---
title: "Provenance — SkillsMP catalog contract and apprenticeship"
description: "Current SkillsMP agent-skill catalog contract plus live sort/filter, repository-star, latency, quota, and catalog-evidence findings."
tags: [jeito, web, provenance, skillsmp, lookup, catalog, apprenticeship]
created: 2026-07-27
updated: 2026-08-01
status: active
owns: "SkillsMP lookup adapter provenance"
audience: contributor
code: [src/adapters/skillsmp.ts::skillsMpSearch, src/adapters/skillsmp.ts::createSkillsMpAdapter, src/adapters/skillsmp.ts::normalizeSkillsMp]
related: [docs/upstreams/README.md, docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md, docs/adr/0005-provider-evaluation-and-guidance/0002-provider-contract-baseline.md]
---

# SkillsMP catalog contract (first-party source + official API docs)

SkillsMP is an agent-skill catalog. jeito queries it for **discovery leads only** — a record is a
pointer to a skill's source repository, never an endorsement. The linked source code, license,
scripts, and maintenance status are not inspected by this adapter and still need review before any
install. Installation is a separate privileged operation that `web_lookup` never performs.

## Contract authority

- **First-party source:** `@alehdezp/skillsmp-search` 0.1.0 — private, `UNLICENSED`, absorbed from
  `extensions/skillsmp-search/index.ts` (read 2026-07-28). This was the original contract authority.
- **Official API docs:** `https://skillsmp.com/docs/api` (accessed 2026-07-29). The published REST
  documentation confirms the first-party contract and is the current authority for request parameters,
  rate limits, and error codes.
- **Runtime boundary:** `GET https://skillsmp.com/api/v1/skills/search` with bearer `SKILLSMP_API_KEY`.
- **Currentness check (2026-07-29):** official docs confirm `q`, page, limit, sort, category,
  occupation, and detected-content `language`; all grounded request controls are exposed. The docs
  define page/limit requests but no response-pagination object.

## Request contract

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `q` | string | ✓ | — | keyword query; trimmed; blank rejected before network; wildcard-only searches rejected by the API |
| `page` | number | — | 1 | 1-based result page; clamped to a bounded integer |
| `limit` | number | — | 20 | results per page, 1–100; clamped to a bounded integer |
| `sortBy` | string | — | `stars` | `stars` \| `recent` |
| `category` | string | — | — | category slug (e.g. `data-ai`, `devops`); trimmed; sent only when non-empty |
| `occupation` | string | — | — | SOC occupation slug (e.g. `software-developers`); trimmed; sent only when non-empty |
| `language` | string | — | — | detected Skill content-language ISO code (e.g. `en`, `zh`, `ja`); `mul` mixed, `und` undetermined; trimmed and sent only when non-empty |

Omitted `category`/`occupation`/`language` filters are never sent as empty parameters.

## Response and rate-limit contract

Response lists appear under `skills`, `results`, `items`, or `data` (with one nested level). Records
preserve grounded fields where present: `title`/`name`/`slug`, `description`/`summary`,
`githubUrl`/`repository`/`repo`/`url`, `stars`/`githubStars`, `category`/`categoryName`, `occupation`,
and a stable identifier (`id`/`skillId`/`slug`). Malformed records (no string title) are skipped only
while valid siblings remain. A provider-valid empty list (`{skills:[]}`) is a successful scoped zero
catalog; no recognized collection, or rows present with none surviving normalization, is a
provider-contract `unavailable` — never presented as an empty catalog. Official documentation defines page/limit request controls
but no response-pagination object; jeito therefore does not infer `total`, `totalPages`, or
`hasMore` fields from deterministic fixtures.

Rate-limit headers (operational state, **not** a ranking signal) are parsed from
`x-ratelimit-daily-limit`, `x-ratelimit-daily-remaining`, `x-ratelimit-minute-limit`, and
`x-ratelimit-minute-remaining` into `details.rateLimits` once per call. Official tiers: anonymous
50/day and 10/min (keyword search only); authenticated 500/day and 30/min.

Error codes map through the shared taxonomy: `INVALID_API_KEY` 401 → `auth`; `MISSING_QUERY` /
`INVALID_OCCUPATION` / `INVALID_LANGUAGE` 400 → `invalid_input`; `DAILY_QUOTA_EXCEEDED` 429 →
`rate_limited` (Retry-After preserved); `INTERNAL_ERROR` 500 → `network`. Upstream error bodies are not
surfaced in public output, and the bearer credential is scrubbed from transport errors before failure
mapping.

## Focused-function and test owners

`src/adapters/skillsmp.ts` exposes one focused boundary, `skillsMpSearch` (validate → fetch under a
local timeout that covers body consumption → parse rate limits → normalize records → typed full
result), plus the `normalizeSkillsMp` record normalizer and the `createSkillsMpAdapter` bridge. The
bridge attaches effective controls and grounded `rateLimits` to the first record's metadata once;
`web_lookup` lifts them into `details.rateLimits` / `details.lookupControls`.
`tests/adapters/skillsmp.test.mjs` owns the focused boundary and record normalization;
`tests/registration.test.mjs` owns the end-to-end `web_lookup` lift and source-discriminated schema;
`tests/no-secret.test.mjs` owns secret exclusion.

## Focused catalog recipes and limits

Three live calls on 2026-08-01 exercised `stars`, `recent`, language, category, and occupation controls. Stars and recent returned different ten-record sets in 11.174 s and 9.656 s; the category+occupation intersection returned no records in 591 ms. The authenticated response reported 500/day and 30/minute with correct remaining counts.

`stars` is repository popularity, not skill-specific quality: multiple top records from the same OpenClaw repository each carried the repository's identical 384,196-star value. Use stars to find popular source ecosystems, not to rank the safety or quality of individual skills. Use `recent` when maintenance novelty matters, then inspect the linked source. A filter intersection with no records is a valid scoped no-winner; do not silently drop filters to manufacture candidates.

## Catalog evidence limits and standalone rollback

Records are `evidenceStatus:"catalog"`, `fetched:false`, with **no `responseId`** — there is no
retained full body for a catalog lead. The adapter makes no claim that source code was inspected, that
a license or scripts are safe, that a skill is compatible, or that it should be installed.

The standalone `@alehdezp/skillsmp-search` package remains installed (unpublished, private) as a
rollback until the stopped-Pi migration; it is never published or installed by this work. Compare
against the first-party source and the official docs whenever the adapter changes.
