---
title: "Provenance — Tavily (official SDK and grounded HTTP contract)"
description: "How the Tavily adapter contract was derived from @tavily/core 0.7.6, current official agent/API/best-practice docs, and @weihan28/pi-tavily 1.0.2: operations, parameters, response shapes, evidence rights, live apprenticeship, and public/internal mapping."
tags: [jeito, web, provenance, tavily, adapter, sdk]
created: 2026-07-27
updated: 2026-08-10
status: active
owns: "Tavily adapter provenance"
audience: contributor
code: [src/adapters/tavily.ts]
related: [docs/upstreams/README.md, docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md, docs/adr/0002-internal-architecture/0003-fetch-pipeline.md]
---

# Tavily — adapter contract reference

- **Official SDK:** `@tavily/core` 0.7.6 — search, extract, map, crawl, and research client contract.
- **Grounded donor reference:** `@weihan28/pi-tavily` 1.0.2 at SHA `279650620596` — historical map/crawl direct-HTTP baseline.
- **License:** MIT (confirmed from the vendored LICENSE).
- **Credential:** `TAVILY_API_KEY`; client built lazily via `tavily({ apiKey })`.

## How we use it

`src/adapters/tavily.ts` calls the official SDK for search and extract, sends current snake_case HTTP to `api.tavily.com/map` and `/crawl`, and implements bounded `/research` create/poll plus `/usage`. Current official `.md` API references and best-practice pages own the wire and guidance contract. We do not copy pi-tavily code; it remains historical comparison evidence.

## Search — `@tavily/core` SDK and constrained public mapping

`TavilySearchOptions` covers `searchDepth` (`basic|advanced|fast|ultra-fast`), topic (`general|news|finance`), relative `days`/`timeRange`, exact `startDate`/`endDate`, `maxResults`, answer/raw/images, include/exclude domains, chunks per source, country boost, automatic parameters, exact match, usage, and timeout. The adapter retains that typed capability.

Public `web_search_tavily` is deliberately narrower after W12: required `query`, optional full-name `country`, fixed basic depth, general topic, and 10 leads. One call is one Tavily attempt with no fallback. Reported credits, response time, request ID, and normalized leads remain model-visible.

The matched packet established the boundary:

- basic Tavily uniquely surfaced substantive PostgreSQL 19 independent guides missed by Serper;
- `country:"india"` added a decision-relevant IndiaAI partner-guidelines document, but that one-task result remains provisional outside the task shape;
- advanced cost two credits, took 7.4 seconds, and replaced a qualifying Thai set with adjacent document-management pages;
- exact match emptied an exact Toka query, while one versus three chunks changed no decisive source;
- topic and typed freshness did not pass matched public-parameter admission.

Depth, topic, exact/relative freshness, domains, chunks, exact match, answer/raw/images/max tokens, and automatic parameters therefore remain internal. Basic/fast/ultra-fast cost one credit and advanced costs two under the current official price contract; capability and pricing do not imply public exposure.

The SDK retains `[key:string]:any`; jeito never exposes it as an untyped bag.

## Extract — `@tavily/core` SDK

`TavilyExtractOptions` supports URL batches, `extractDepth` (`basic|advanced`), markdown/text format, images, query-guided reranking, `chunksPerSource` (1-5 when query is present), timeout, and usage metadata. Focused `tavilyExtract` preserves titles, raw content, images, favicon, failed URL/reason records, response time, credits, and request ID. Public `web_fetch` currently selects basic for readable and advanced for markdown/raw; query-guided extraction remains internal pending a typed fetch decision.

## Map — direct HTTP `POST https://api.tavily.com/map`

Bearer auth, snake_case body:

| Field | Default | Bounds |
|---|---|---|
| `url` | required | root HTTP(S) |
| `instructions` | — | — |
| `max_depth` | 1 | 1-5 |
| `max_breadth` | 20 | 1-500 |
| `limit` | public map: 25; internal map: provider default when omitted; crawl: required | positive safe integer when supplied |
| `select_paths` | — | regex patterns |
| `select_domains` | — | regex patterns |
| `exclude_paths` | — | regex patterns |
| `exclude_domains` | — | regex patterns |
| `allow_external` | **false** (our policy default; API default is true) | — |
| `timeout` | computed from ctx, clamped 10-150 | 10-150 seconds; every call also requests `include_usage` |

Response: `base_url`, `results: string[]`, `response_time`, `usage.credits?`, `request_id?`.

## Crawl — direct HTTP `POST https://api.tavily.com/crawl`

Same body as map plus `include_images` (default false), `extract_depth` (`basic|advanced`, default basic), `format` (`markdown|text`, default markdown), `chunks_per_source`, and `include_usage:true`.

Response: `base_url`, `results:[{url,raw_content,favicon?}]`, `response_time`, `usage.credits?`, and `request_id?`.

## Research — bounded direct HTTP create/poll

`runTavilyResearch` implements current `POST /research` plus bounded `GET /research/{request_id}` polling. It supports model (`mini|pro|auto`), output schema, citation format, include/exclude domains (20 each), output length, up to five base64 text/Markdown/JSON files, a mandatory maximum wait, and caller cancellation. It preserves status, content, source URLs/titles/favicons, response time, and request ID. It is internal: generated prose and source URLs are synthesis leads, not fetched-passage evidence.

## Usage — direct HTTP `GET https://api.tavily.com/usage`

Internal maintenance capability (`tavilyGetUsage`), invoked only by the
user-invoked `/web-setup` "Check usage" action — never a registered tool, never
automatic, never on startup or doctor, and never persisted. Bearer auth.

**Shape (official reference, not a probe):** top-level `key` and `account`
objects of integer usage fields — `usage` and `limit` (nullable when
unlimited), plus `search_usage`/`extract_usage`/`crawl_usage`/`map_usage`/
`research_usage`; `account` adds `current_plan`, `plan_usage`/`plan_limit`, and
`paygo_usage`/`paygo_limit`, derived from the official OpenAPI reference
(`docs.tavily.com/documentation/api-reference/endpoint/usage`). Additive or
unknown fields are ignored. A body that is not an object, carries no recognized
section, or fails JSON parsing is rejected as a provider-contract `unavailable`
rather than accepted; the body is consumed under the local timeout, so a
body-read abort maps to `timeout` (never `empty`). The bearer credential is
redacted from mapped transport errors, and formatting shows only returned
fields (no fabricated zero or infinity).

**Live check:** focused `/usage` calls succeeded on 2026-07-31 and returned current plan/key/account counters without secret values. The counters did not update immediately after one completed mini Research task, so billing decisions use the current official operation ceilings rather than assuming the usage endpoint is synchronous.

## Evidence rights

| Output | Evidence status |
|---|---|
| Search result content | lead |
| Search answer (includeAnswer) | lead/scout synthesis — never verified evidence |
| Search rawContent | lead/scout material in this product contract |
| Search images | leads |
| Map URLs | leads |
| Successful extract content | fetched |
| Successful crawl page content | fetched for that page |
| Failed extract/crawl entries | preserved by focused provider results; not evidence |

Tavily `includeAnswer` and native Research remain internal and are **not** added to `AdapterCapability.operations.answer`. Their cited synthesis remains lead/scout output; `$mini-research` or `$research` must fetch decisive passages before promoting a claim.

The focused extract result preserves mixed successes and failed URL/reason records. The shared public `web_fetch` wrapper returns successful fetched content and a generic count when all extraction fails; it does not publish partial-failure metadata because no typed shared metadata boundary exists yet. Phase 3 may expose that metadata only through an explicit typed result decision.

## Cancellation and billing

**SDK (search/extract):** No `AbortSignal` exposed. The adapter rejects immediately if the outer signal is already aborted, and checks again after the SDK call. This prevents fallback and a second provider charge but cannot cancel the in-flight HTTP request.

**HTTP (map/crawl):** `fetch` receives one combined signal covering caller cancellation and the local `ctx.timeoutMs` deadline. The API's server timeout remains a separate 10–150 second request field. Caller abort maps to `aborted`; the local deadline maps to `timeout`; neither path retries internally.

## Focused operation functions

`tavilySearch`, `tavilyExtract`, `tavilyMap`, `tavilyCrawl`, `runTavilyResearch`, and `tavilyGetUsage` are exported from `src/adapters/tavily.ts`. Focused apprenticeship and maintenance code call these directly; `/web-setup` calls `tavilyGetUsage` only for its explicit usage check.

The shared search/fetch adapter keeps common results while namespaced Tavily metadata retains response time, request ID, and usage credits through model-visible output and retained fetch content.

## Public behavior

- `web_search_tavily`: provisional typed Search method covering four depths, general/news/finance, relative or exact freshness, count, domains, country, 1-3 chunks per source, exact match, and visible reported credits
- `web_fetch` page: basic/advanced extraction with provider usage metadata when fallback reaches Tavily
- `web_fetch` site/map: bounded map URL discovery (`SITE_MAP_CAP=25`) with provider usage metadata
- query-guided Extract, full Map/Crawl controls, Search answer/raw/images/automatic parameters, and Research remain internal

## Owning tests

- `tests/adapters/tavily.test.mjs` — adapter and focused-operation contract, including current search/extract fields, map/crawl metadata, bounded Research create/poll, cancellation, failure classification, and usage redaction; `tests/web-specialists.test.mjs` owns explicit Tavily Search schema, dispatch, pre-call incompatibilities, and visible credits.

## Upkeep

- **Last reviewed:** 2026-07-31 (`@tavily/core@0.7.6`, official `llms.txt`, `agents.md`, Search/Extract/Map/Crawl/Research/Usage API references and best-practice pages; donor `@weihan28/pi-tavily@1.0.2` SHA `279650620596`).
- **Next comparison:** refresh the official Markdown index and `npm view @tavily/core version`; rerun only recipes whose contract or guidance changed.
