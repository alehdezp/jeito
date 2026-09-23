---
title: "Provenance — current Serper platform contract and apprenticeship"
description: "Current official Serper Search, specialist discovery, local/media, and webpage contracts plus focused live behavior, credits, and selective public mapping."
tags: [jeito, web, provenance, serper, lexical-search, media-search, apprenticeship]
created: 2026-07-27
updated: 2026-08-12
status: active
owns: "Serper adapter provenance and focused provider recipes"
audience: contributor
code: [src/adapters/serper.ts::serperSearch, src/adapters/serper.ts::serperOperation, src/adapters/serper.ts::createSerperAdapter, src/adapters/serper.ts::normalizeSerper]
related: [docs/upstreams/README.md, docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md, docs/adr/0005-provider-evaluation-and-guidance/0002-provider-contract-baseline.md, docs/adr/0002-internal-architecture/0002-routing-and-failover.md]
---

# Current Serper platform contract and focused provider recipes

Serper provides Google-backed lexical and vertical discovery. Search-like results, answer boxes, knowledge graphs, media, local records, and suggestions are leads. The Webpage endpoint returns extracted content but remains internal until its evidence/retention mapping is compared with existing `web_fetch` paths.

## Current authority and generally available surface

- **Historical first-party source:** `@alehdezp/serper-search` 0.1.0, private and `UNLICENSED`, absorbed from the former standalone extension. It owns the original public Search behavior but no longer describes the whole platform.
- **Current official source:** the Serper playground and billing application bundles served from <https://serper.dev/playground> and <https://serper.dev/billing>, build `BQqdk0tXay85rGS65tF_R`, inspected 2026-08-01. The live frontend defines endpoint choices, request shaping, response credit display, and current price tiers.
- **Live packet:** `.tmp/exa-apprenticeship-20260731/serper/`, including direct endpoint captures and one `serperOperation` compatibility call. Temporary captures are execution evidence, not shipped dependencies.

The generally available official endpoint list is Search, Images, Videos, Places, News, Shopping, Scholar, Patents, Autocomplete, Lens, Maps, Reviews, and Webpage. Product Reviews, Maps Autocomplete, Search Full, and Bing operations are account/employee-gated in the current frontend and are excluded from the general contract until the configured account exposes them.

## Current request and response contracts

- **Query endpoints:** `POST https://google.serper.dev/{search|images|videos|places|news|shopping|scholar|patents}`. Common controls are `q`, `location`, `gl`, `hl`, `autocorrect`, `tbs`, and `page`. Current count choices are 10 for Search/Videos/Places/News/Patents, 10 or 100 for Images, 40 for Shopping, and omitted for Scholar.
- **Autocomplete:** `q`, optional location/locale; returns `suggestions[]`.
- **Maps:** query or place identifier plus `hl`, `ll`, and page; returns `places[]` and map coordinates.
- **Reviews:** `cid`, `fid`, or `placeId` plus locale/sort/topic/pagination token; returns `reviews[]` and optional `nextPageToken`.
- **Lens:** one HTTP(S) image URL plus optional location/locale/time filter; returns `organic[]` reverse-image leads.
- **Webpage:** `POST https://scrape.serper.dev` with one HTTP(S) URL and optional Markdown/images/links/videos flags; returns text plus requested extracted forms and metadata.
- Every focused live response carried numeric `credits`; `serperOperation` requires this metadata and preserves the full provider record.

`serperSearch` remains the normalized Search boundary: trimmed `q`, `num` capped at 10, and adapter-owned `gl`/`hl` validation plus normalization receipts. Public `web_search` fixes `num:10`, exposes `query` aliases and optional raw `country`, and never pre-normalizes locale input. The adapter preserves credits plus bounded `answerBox`/`knowledgeGraph` candidates in `details.serper`; wider operations remain internal.

## Current pricing and exact credit accounting

The official billing bundle advertises Starter 50,000 credits for `$50` (`$1.00/1k`), Standard 500,000 for `$375` (`$0.75/1k`), Scale 2.5M for `$1,250` (`$0.50/1k`), and Ultimate 12.5M for `$3,750` (`$0.30/1k`). Use the Starter rate as the conservative maximum when the account tier is unknown.

The specialist packet reported 18 credits: one each for Images, Videos, Places, News, Scholar, Patents, Autocomplete, and Reviews; two for Shopping and Webpage; three for Maps and Lens. Six ordinary Search calls plus one internal News compatibility call bring the packet reserve to 25 credits, or `$0.025` at the conservative Starter rate.

## Focused Search and locale findings

- Exact lexical provenance worked directly: `site:openai.com/index/ "GPT-5.6"` returned ten official OpenAI pages in `1.112 s`, with the intended launch page first.
- W12 reproduced country-ranking value across Thai and Indian tasks: adding `country` surfaced qualified first-party guides and IndiaAI/PIB artifacts absent from the held shortlists. Language changed only adjacent/mirrored rows, so it is no longer public. Country is a ranking/localization control, not evidence quality.
- Two attempts to elicit an answer box (arithmetic and a capital-city question) returned none. An `OpenAI` query returned a knowledge graph. Structured candidates are opportunistic leads and must never be required for success or treated as verified facts.

These scoped calls support Serper as a precise lexical/provenance method. They do not establish comparative superiority over Exa, Tavily, Linkup, or another provider.

## Specialist endpoint findings and public-selection boundary

All twelve generally available specialist operations exercised successfully. Response collections matched the official frontend contract: Images 5, Videos 10, Places 2, News 10, Shopping 40, Scholar 10 organic, Patents 10 organic, Autocomplete 10 suggestions, Maps 3 places, Reviews 11, Lens 3 organic, and Webpage text/Markdown/links. Latency ranged from `386 ms` for Autocomplete to `5.537 s` for Webpage.

The capabilities remain internal because their result shapes and evidence rights differ: media/local/shopping records are not ordinary web leads, Reviews depends on a Maps identifier, Lens starts from an image URL, and Webpage would need fetched-source retention semantics. A future public mapping requires a named research task and interactive owner choice; implementing the contract does not authorize flattening these records into generic `SearchResult[]`.

## Failure, cancellation, and secret handling

Both focused boundaries reject unsafe input before network, keep timeout active through body consumption, classify HTTP failures centrally, redact `SERPER_API_KEY`, and validate the operation-specific root collection. `serperOperation` rejects unsupported endpoint counts instead of letting the API silently substitute its default.

Search `organic:[]` is a successful zero outcome and may still carry candidate metadata. Invalid JSON, missing/wrong result collections, and all-malformed organic rows are provider-contract `unavailable`, not zero matches.

## Owning proof and upkeep

- `tests/adapters/serper.test.mjs` owns public normalization plus representative query/local/Lens/Webpage internal request mapping, credit retention, unsafe-input rejection, timeout, failure classification, and secret exclusion.
- `tests/web-search.test.mjs` owns the fixed-10 closed schema, conflict-safe query aliases, raw-country handoff, and one-attempt/no-fallback boundary.
- Re-fetch the live official bundles when the build ID or endpoint behavior changes; do not infer gated endpoints are available to every account.
