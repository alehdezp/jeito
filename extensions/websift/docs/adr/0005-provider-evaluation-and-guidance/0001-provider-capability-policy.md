---
title: "ADR 5.1 — Provider capability roles and configured fallback policy"
description: "Records current provider operations, credentials, mode-aware fallback order, scoped apprenticeship evidence, and the boundary between routing policy and comparative quality."
tags: [jeito-websift, adr, providers, capability-policy, grounding, routing]
created: 2026-07-28
updated: 2026-08-02
status: active
adr_id: ADR-005.001
adr_type: child
decision_status: accepted
confidence: inferred
evidence_grade: mixed
implementation_status: in-progress
decision_owner: alehdezp
owns: "Provider roles, grounding discipline, and configured non-ranking fallback order"
audience: contributor
parent: docs/adr/0005-provider-evaluation-and-guidance/README.md
code: [src/registry.ts::AdapterRegistry, src/adapters/serper.ts, src/adapters/exa.ts, src/adapters/tavily.ts, src/adapters/linkup.ts, src/adapters/xsearch.ts, src/adapters/context7.ts, src/adapters/skillsmp.ts, src/adapters/pi-packages.ts]
related: [docs/upstreams/README.md, docs/adr/0002-internal-architecture/0002-routing-and-failover.md]
---

# ADR 5.1 — Provider capability roles and configured fallback policy


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-005 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: inferred`, `evidence_grade: mixed`, and `implementation_status: in-progress`. The metadata—not optimistic prose—governs whether dependent work may treat the decision as proved.

## Grounding discipline (no inference)

No provider is implemented from inference. **Each adapter slice begins by reading
that provider's installed source** under
`~/.pi/agent/npm/node_modules/<package>` (authoritative implementation evidence,
more reliable than vendor docs for "what does this code do"). The "Grounded"
column records what has actually been read in this effort; everything else is
pending its slice and must not be assumed.

## Core providers (no cutoff)

| Provider | Package | Operations | Strengths | Credential | Grounded? |
|---|---|---|---|---|---|
| Serper | `@alehdezp/serper-search` (first-party) | search | fast Google organic, lexical, freshness/provenance/criticism | `SERPER_API_KEY` | ✅ incumbent source read |
| native fetch | ported from `pi-web-access` 0.13.0 | fetch | HTTP+Readability primary; GitHub/PDF/model-free YouTube handlers | — | ✅ source read (see [`../upstreams/pi-web-access.md`](../../upstreams/pi-web-access.md)) |
| Exa | `@capyup/pi-exa` | search, answer | semantic, academic, code, freshness, deep | `EXA_API_KEY` | ✅ source read at `8da1600c459e` |
| Tavily | `@weihan28/pi-tavily` (wraps `@tavily/core`) | search, fetch | general/news/finance search; `extract`; `map`; raw content | `TAVILY_API_KEY` | ✅ source read at `279650620596` |
| Linkup | `@aliou/pi-linkup` | search, answer | fast/standard/deep sourced discovery; sourced answers | `LINKUP_API_KEY` | ✅ source read at `3d2588910cf0` |
| xsearch | `@pi-lab/xsearch` | search | X/Twitter synthesis with citation leads | `XAI_API_KEY` | ✅ source read at `d78f2dabc9ec` |
| Context7 | `@dreki-gg/pi-context7` | lookup | library resolution + version-aware docs | optional `CONTEXT7_API_KEY` | ✅ installed 0.2.0 source read |
| SkillsMP | `@alehdezp/skillsmp-search` (first-party) | lookup | agent-skill catalog discovery | `SKILLSMP_API_KEY` | ✅ source read |
| pi-package-search | `pi-package-search` | lookup | Pi package registry discovery (no install) | — | ✅ source read at `ec26ed0ec226` |

Registered tools observed in the live surface (authoritative evidence of current
capability): `serper_search`; `exa_search`, `exa_answer`, `exa_similar`,
`exa_research`; `tavily_search`, `tavily_extract`, `tavily_crawl`, `tavily_map`;
`linkup_web_search`, `linkup_web_answer`; `xsearch`; `context7_resolve_library_id`,
`context7_get_library_docs`, `context7_get_cached_doc_raw`; `search_skillsmp`;
`search_pi_packages`; plus `fetch_content`/`get_search_content` from
pi-web-access.

## Excluded (settled)

Firecrawl, Jina, Perplexity/Gemini/OpenAI answer endpoints, and SearXNG are out
of scope. `pi-chrome`/browser automation stays separate (authorization +
side-effect boundary). Note: pi-web-access uses Jina Reader and Gemini/Perplexity
as *internal extraction fallbacks*; those branches are trimmed from the port (see
[`ADR 2.3 — composable fetch pipeline`](../0002-internal-architecture/0003-fetch-pipeline.md)), consistent with excluding
those providers.

## Configured fallback order (not a quality ranking)

The current default order is operational policy, not a universal provider ranking. Focused apprenticeship establishes scoped recipes only; it does not promote one provider across task classes. Routing combines this order with capability, kind, credential, and mode matching ([`ADR 2.2`](../0002-internal-architecture/0002-routing-and-failover.md)):

| Operation / kind | Configured order | Grounded boundary |
|---|---|---|
| search / general | serper → exa → tavily → linkup → xsearch | fallback order only; typed forced routes own exact semantics |
| search / academic, code | exa → tavily | Exa exposes source-category controls; neither route proves source authority without fetch |
| search / news | tavily → serper | Tavily exposes news/finance controls; Serper provides lexical news discovery |
| search / social | xsearch | only public social-source route; synthesis/citations remain leads |
| fetch / ordinary page | native → tavily | Native general default and GitHub/PDF/YouTube specialist; one visible Tavily basic fallback after eligible transport/empty/thin extraction |
| fetch / accepted research host/path | tavily → native | scoped 2026-08-02 comparison decision; exact list and boundaries are owned by ADR 2.2 and `src/routing.ts` |
| fetch / site, map | tavily | mode routing excludes page-only Native and returns bounded URL leads |
| answer | exa → linkup | configured fallback; synthesis remains lead-only unless fetched evidence is required |
| lookup / library docs | context7 | only source; ambiguity and version safety apply |
| lookup / skills | skillsmp | only source; catalog evidence only |
| lookup / Pi packages | pi-packages | only source; discovery never installs |

## What would change this matrix

- Reading a provider's source during its slice may revise its operations,
  strengths, or filters — update this table and the adapter together.
- Accepted focused comparative evidence may replace an affected default only through interactive owner selection (see [`ADR 5.4`](0004-benchmark-and-selection.md)).
- A new provider is admitted only with a demonstrated use; the speculative tail
  stays excluded.

## Alternatives and decisive trade-off

Selecting provider roles from marketing or model memory would convert hypotheses into routing policy. Dropping old operations from missing session calls would confuse incomplete observation with non-use. Installed contracts establish capability; old schemas/guidance establish mandatory hypotheses; only accepted focused evidence establishes comparative roles.

## Evidence and verification

Installed SDK/source and `docs/upstreams/` support contract facts. Focused apprenticeship supports named call recipes. The accepted 2026-08-02 fetch comparison selects a scoped Tavily-first host/path table while retaining Native as the general default; it does not establish a universal provider ranking. Remaining configured priorities stay inferred operational policy and comparative evidence remains mixed.

## History

- 2026-07-27: core nine confirmed (no cutoff); speculative tail excluded;
  grounding discipline and unmeasured-policy labeling adopted.
- 2026-07-29–30: Phases 5A–5E completed version/source grounding for Linkup, xsearch, Context7, SkillsMP, and Serper and reconciled their public/internal/excluded contract mappings. This raises contract currentness only; provider strengths and starting priorities remain explicitly unmeasured pending ADR 5.4 and interactive owner selection.
- 2026-08-01: reconciled the table with live mode routing and completed apprenticeship packets. Removed stale quality shorthand, corrected site/map to Tavily-only public routing, and kept all ordering explicitly non-ranking pending interactive owner selection.
- 2026-08-02: accepted the scoped page-fetch role: Tavily basic first for the evidence-backed research host/path table, Native first elsewhere and for GitHub/PDF/YouTube specialties, with one visible eligible fallback. Search/answer/provider-wide ordering remains non-ranking.
