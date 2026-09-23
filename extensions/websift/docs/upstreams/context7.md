---
title: "Provenance — current Context7 resolve, versioned docs, and apprenticeship"
description: "Current Context7 resolve-then-docs contract plus ambiguity, version pinning, fast mode, text/GCF-encoded JSON context, retention, and evidence boundaries."
tags: [jeito, web, provenance, context7, lookup, library-docs, apprenticeship]
created: 2026-07-27
updated: 2026-08-11
status: active
owns: "Context7 lookup adapter provenance"
audience: contributor
code: [src/adapters/context7.ts::context7ResolveLibraries, src/adapters/context7.ts::context7GetLibraryDocs, src/adapters/context7.ts::context7SearchLibraries, src/adapters/context7.ts::context7FetchDocs, src/tools/web-lookup.ts::registerWebLookup, src/gcf.ts::encodeGcfRecords]
related: [docs/upstreams/README.md, docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md, docs/adr/0005-provider-evaluation-and-guidance/0002-provider-contract-baseline.md]
---

# Context7 resolve-then-docs HTTP contract

- **Package:** `@dreki-gg/pi-context7` 0.2.0; repository <https://github.com/dreki-gg/pi-extensions/tree/main/packages/context7>.
- **Installed version:** 0.2.0. **Latest checked:** 0.2.0 via `npm view @dreki-gg/pi-context7 version` on 2026-07-29 — installed equals latest, so no material contract drift.
- **Resolved snapshot:** the original `main` snapshot `b75b356784fe` no longer contained `packages/context7`; `vendor.manifest.json` pins tag `@dreki-gg/pi-context7@0.2.0`, peeled commit `d36aebb52c0b49b39ccc10d1ee8396151fa66eed` (verified with `git ls-remote`). The installed 0.2.0 package is the exact donor source read.
- **License:** MIT **declared** by the package manifest, but the installed package **ships no LICENSE file**. The donor is contract evidence only; no donor code is copied.
- **Runtime boundary:** direct HTTP to `https://context7.com/api`; anonymous access works, and `CONTEXT7_API_KEY` (optional) raises rate limits when present.

## Authoritative references and access dates

- API base: `https://context7.com/api` (donor `CONTEXT7_API_BASE_URL`).
- API guide: <https://context7.com/docs/api-guide> (accessed 2026-07-29).
- Search reference (`GET /v2/libs/search`): <https://context7.com/docs/api-reference/search/search-for-libraries> (accessed 2026-07-29).
- Context reference (`GET /v2/context`): <https://context7.com/docs/api-reference/context/get-documentation-context> (accessed 2026-07-29).

## Resolve request and response (`GET /v2/libs/search`)

Query params: `libraryName` (required), `query` (required, used for LLM relevance ranking), `fast` (optional `"true"`/`"false"`, default `"false"` — skips LLM reranking for lower latency). Response `SearchResponse { results: Library[], searchFilterApplied: boolean }`. Each `Library` carries `id`, `title`, `description`, `versions[]`, `totalSnippets`, `trustScore` (0–10 source-reputation), `benchmarkScore` (0–100 quality indicator), `source`, plus `branch`/`state`/`stars`/`lastUpdateDate`.

## Docs request and response (`GET /v2/context`)

Query params: `libraryId` (required), `query` (required), `type` (optional, enum `txt`|`json`, default `txt`), `fast` (optional `"true"`/`"false"`). With `type=txt` the body is `text/plain` documentation; with `type=json` it is `application/json` `ContextResponse { codeSnippets[], infoSnippets[], rules? }` (code snippets carry `codeTitle`/`codeDescription`/`codeLanguage`/`codeList[]`; info snippets carry `breadcrumb`/`content`).

**Library-ID format and version pinning.** `libraryId` is the URL path of the library on context7.com — `/owner/repo` for GitHub, or `/<source>/<id>` otherwise — and the official pattern is `^/[^/]+/[^/]+([/@][^/]+)?$`. A specific version is pinned by suffixing the ID with `/<version>` or `@<version>` (e.g. `/vercel/next.js@v14.3.0`). jeito uses the `@<version>` suffix when a requested version matches a candidate's advertised `versions[]`.

**Public query boundary.** Catalog searches and name resolution require `query`, `q`, or `term`. An exact `context7.libraryId` (or slash-shaped exact `library`) may omit it; jeito sends the provider-required neutral query `overview`. Missing catalog/resolution queries fail before any provider call.

## Official-vs-donor differences (Phase 5C reconciliation)

- **`type` and `fast` are official, not donor.** The installed donor's `fetchLibraryDocs` sends only `libraryId` + `query`; it never sends `type` or `fast`. The official API owns both, so jeito maps `responseType`→`type` and `fast`→`fast`.
- **`topic` and `page` are donor query-steering, not server params.** The official API has no `topic`/`page` parameters. The donor's `buildEffectiveQuery` encodes them into the query text (`Focus: <topic>`, `Requested page: <N>`). jeito preserves this donor-compatible steering and documents it honestly — neither is an independent server-side selector.
- **Version pinning is by ID suffix, not query decoration.** The donor appended `Version: …` to the docs query, which does not guarantee version accuracy. jeito pins via the official `@<version>` library-ID suffix and records `requestedVersion` and `resolvedLibraryId` separately.
- **Donor disk cache is excluded.** The donor maintains an independent on-disk cache (`cache.ts`) with TTL and stale-cache fallback. jeito does **not** port it; successful docs responses retain the exact provider body at the returned `.cache/web/docs/<doc>/full.md|json` `docsPath`.
- **Source header.** The donor sends `X-Context7-Source: pi-extension`; jeito sends `X-Context7-Source: jeito-websift` (honest identification).

## Focused functions and owning proof

- `src/adapters/context7.ts` exports the focused boundaries `context7SearchLibraries` (resolve HTTP), `context7FetchDocs` (docs HTTP, returns the complete raw body), `context7ResolveLibraries` (resolve-only → catalog records), and `context7GetLibraryDocs` (safe resolution → version pinning → docs → retention), plus the internal conservative exact-match selector and `createContext7Adapter`. Library IDs are validated against the official path contract before retrieval; provider scores remain metadata and never authorize automatic selection.
- `tests/adapters/context7.test.mjs` owns the resolve/docs request shapes, candidate metadata, conservative exact-match and ambiguous resolution, resolve-mode version filtering, version pinning and safe failure, topic/page/fast/responseType mapping, txt/json shape validation and exact raw retention, full-response-body timeout coverage, HTTP/malformed classification, and transport-error credential redaction.
- `tests/registration.test.mjs` owns the source-discriminated `web_lookup` schema, missing-query rejection, exact-ID query fallback, version-miss-before-ambiguity guidance, catalog GCF output, Context7 JSON→GCF round trip, and exact `docsPath` retention.
- `tests/no-secret.test.mjs` owns Context7 secret exclusion.

## Focused resolution and context recipes

- A React 19 server-rendering query returned five candidates. The first candidate advertised only a React 18 branch; the second advertised `v19.2.7`. Provider order and trust/benchmark scores therefore must never authorize “pick first.” The public safe-resolution path returned candidates without a docs request.
- Requesting available version `19.2.7` narrowed to `/react/react@v19.2.7`, fetched 3,296 characters, retained the exact body at `docsPath`, and cited React source at that tag. Requesting absent `19.1.1` returned all candidates with `versionNotFound`, made no docs request, and now prints version repair before generic ambiguity guidance.
- `fast:true` returned the same five candidates in the same order in this case while reducing wall time from 1.278 s to 397 ms. Treat that as a latency recipe, not proof of equal ranking for every query.
- Direct text context was 3,222 characters; provider JSON was 31,169 characters for the same query/candidate. Default to text for model reading; request JSON only when code/info snippet structure changes downstream work. jeito keeps the native JSON internally, exposes model-relevant structure as GCF with total/shown/omitted state, and retains the exact raw content at the returned `docsPath`.

## Evidence and retention limits

Resolve output is **catalog evidence** (`fetched:false`, no `docsPath`); retrieved documentation is **fetched evidence**. Resolve mode applies requested versions to candidate filtering and rejects docs-only controls. Successful docs retrieval saves the complete raw provider body at `.cache/web/docs/<doc>/full.md|json`; text mode returns a bounded prose excerpt, while JSON mode validates `codeSnippets[]`/`infoSnippets[]` and exposes the structured value as GCF. The printed `docsPath` is the continuation contract; no Context7-specific cache or extra tool exists.

A provider-valid zero candidate list is a successful scoped catalog outcome; it bounds only that Context7 name/query. Malformed search or JSON documentation shapes are provider-contract `unavailable`, while a selected library returning a blank documentation body remains an `empty` content failure.

Live Context7 apprenticeship calls on 2026-08-01 exercised normal/fast resolution, text/JSON docs, ambiguity, available-version pinning, and absent-version refusal. No metered monetary charge was exposed. Provider scores remain metadata, never jeito quality or selection authority; no comparative provider priority is claimed.
