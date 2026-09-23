---
title: "Provenance — current Linkup API contract and apprenticeship"
description: "Current official Linkup Search, Fetch, Research, and balance contracts plus focused live behavior, latency, cost, and evidence findings."
tags: [jeito, web, provenance, linkup, adapter, apprenticeship]
created: 2026-07-27
updated: 2026-08-12
status: active
owns: "Linkup adapter provenance and focused provider recipes"
audience: contributor
code: [src/adapters/linkup.ts::linkupSearch, src/adapters/linkup.ts::linkupSourcedAnswer, src/adapters/linkup.ts::linkupStructuredSearch, src/adapters/linkup.ts::linkupFetch, src/adapters/linkup.ts::runLinkupResearch, src/adapters/linkup.ts::linkupGetBalance]
related: [docs/upstreams/README.md, docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md, docs/adr/0005-provider-evaluation-and-guidance/0002-provider-contract-baseline.md]
---

# Current Linkup API contract and focused provider recipes

- **Runtime boundary:** direct HTTPS to `https://api.linkup.so/v1`; no donor code or SDK is imported.
- **Historical donor:** `@aliou/pi-linkup` 0.11.0 at snapshot `3d2588910cf0`. Its manifest declares MIT but the snapshot contains no `LICENSE`; it remains contract history only.
- **Current authority:** <https://docs.linkup.so/llms.txt>, the official Search [best-practices](https://docs.linkup.so/pages/documentation/endpoints/search/best-practices), Fetch [overview](https://docs.linkup.so/pages/documentation/endpoints/fetch/overview), Research [overview](https://docs.linkup.so/pages/documentation/endpoints/research/overview), and [pricing](https://docs.linkup.so/pages/documentation/platform/pricing), inspected 2026-08-01.
- **Live packet:** focused calls under `.tmp/exa-apprenticeship-20260731/linkup/`, executed 2026-08-01 with exact spend measured from `/credits/balance`. Temporary captures are execution evidence, not shipped runtime dependencies.

## Current Search, Fetch, Research, and balance contracts

- **Search** — `POST /search` with `q`, `depth:fast|standard|deep`, `outputType:searchResults|sourcedAnswer|structured`, optional `maxResults`, include/exclude domains, `fromDate`/`toDate`, inline citations, and a required JSON Schema for structured output. When both dates are supplied, official endpoint reference requires `fromDate < toDate`; equal bounds are invalid. Search-result responses contain `{results:[{name,url,content?}]}`; sourced answers contain `{answer,sources}`; structured responses contain `{data,sources?}`. Search results remain leads; sourced-answer passages use `provider-citation` with `fetched:false` until independently fetched.
- **Fetch** — `POST /fetch` with one HTTP(S) `url`, explicit `renderJs`, and optional `includeRawContent`. Response contains Markdown and optional raw content. The public `web_fetch` Linkup branch exposes Markdown or raw extraction; `renderJs` stays required because it changes cost materially.
- **Research** — `POST /research` creates an asynchronous task; `GET /research/{id}` polls it. Controls include `mode:answer|investigate|research`, `reasoningDepth:S|M|L|XL`, sourced or structured output, domains, dates, inline citations, and schema. `runLinkupResearch` requires a caller-owned maximum wait and polls no faster than once per second. Research output is a cited scout result, not fetched claim-to-passage closure.
- **Balance** — `GET /credits/balance` returns `{balance:number}`. `linkupGetBalance` remains an explicit internal maintenance operation used by `/web-setup`, never startup or doctor.

## Current pricing and exact live accounting

The official pricing page fetched successfully without JavaScript on 2026-08-01. Search results cost `$0.005` for fast/standard and `$0.05` for deep; sourced or structured output costs `$0.006` for fast/standard and `$0.055` for deep. Fetch costs `$0.001` without JavaScript and `$0.005` with it. Research costs `$0.25/$0.50/$1.50/$2.50` for S/M/L/XL. Failed requests deduct no credit.

The focused apprenticeship spent exactly `$0.400` by balance delta, including one S Research call. This is measured accounting, not a permanent budget guarantee; re-fetch pricing before consequential paid work.

## Internal Search recipes and observed public-retention failure

- **Fast:** keyword-shaped lookup. `Tavily advanced search costs 2 credits` found the official credits page in `796 ms`. The instruction-shaped control took `1.214 s` and returned broad Tavily pages instead. Fast is useful when one fact is expected and latency binds; it does not parse ordered instructions.
- **Standard:** one direct or parallel retrieval step. The one-page instruction asking for Tavily `search_depth` documentation found the exact Search endpoint in `1.501 s`. Use dates through `fromDate`/`toDate` and domains through structured filters rather than query prose.
- **Deep:** sequential discovery where one result informs the next. The explicit first/then query found both Tavily Search-depth and pricing pages in `3.268 s`; it costs ten times a raw fast/standard search. Use only when ordered, iterative retrieval is the requirement.
- **Output choice:** `searchResults` is the cheapest grounding shape; use `sourcedAnswer` for a directly cited synthesis and `structured` only when a schema materially removes downstream parsing. In the live packet, both standard synthesis shapes returned 20 lead sources.

These observations describe internal provider capability only. W12 removed public `web_search_linkup`: matched fast/standard/deep searchResults produced no two-class unique decisive evidence, deep duplicated or worsened exact retrieval, one official-domain deep call timed out, and Thai/Indian tasks missed the required first-party source class. `web_answer_linkup`, explicit Linkup fetch, and internal Search/Research remain because they have separate method/evidence contracts.

## Focused Fetch and Research recipes

- On `app.linkup.so`, static Fetch returned HTTP 400 while rendered Fetch succeeded in `1.566 s` with 2,802 Markdown characters. Render only after ordinary/static extraction returns shell, empty, or failure.
- On a static Linkup documentation page, non-rendered and rendered Fetch returned identical 17,503-character Markdown; static took `566 ms`, rendered `923 ms`, and rendering cost five times more. Do not enable JavaScript speculatively.
- Raw mode returned 517,506 characters for the same 17,503-character Markdown page—about 29.6 times more context. Request raw only for transport/markup diagnosis, never as the normal evidence path.
- Research S took `96.468 s`, cost `$0.25`, returned a useful 3,160-character answer and 14 official source records, but duplicated sources and remained synthesized lead evidence. Use it when a single Search cannot resolve a bounded investigation; fetch the decisive primary passages before closure.

## Failure, cancellation, and credential contract

`src/adapters/linkup.ts` sends `User-Agent: jeito-websift/0.1.0 (@alehdezp/websift)`, threads caller abort, enforces a local timeout, classifies HTTP failures centrally, validates every response shape, and redacts the bearer credential from surfaced failures. A provider 400 is `invalid_input`; equal or reversed date bounds are rejected locally before network dispatch because the official `/search` contract requires `fromDate` to be before `toDate`. Failed requests are not retried invisibly.

Provider-valid empty Search rows remain a scoped zero; malformed Search, sourced-answer, Fetch, Research, and balance shapes are provider-contract `unavailable`. A sourced answer with a valid answer string and an empty source array remains provisional evidence with no independently fetched support.

## Owning proof and evidence limits

- `tests/adapters/linkup.test.mjs` owns request mapping, complete response normalization, Research polling, bounds, abort/timeout/HTTP classification, and credential exclusion.
- `tests/web-specialists.test.mjs` owns public Linkup Answer exact-date/domain dispatch; public Linkup Search was removed by W12 while adapter-level Search remains covered above.
- `tests/web-fetch.test.mjs` owns explicit rendering plus Markdown/raw extraction and rejects batch/site/map/readable modes.
- No comparative winner or default priority follows from this packet. Another provider method runs only for a named complementary evidence hypothesis.
