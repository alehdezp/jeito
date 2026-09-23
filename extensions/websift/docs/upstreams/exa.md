---
title: "Provenance — Exa (@capyup/pi-exa contract reference)"
description: "Grounded Exa adapter contract derived from @capyup/pi-exa 0.5.1 and refreshed against the installed official exa-js 2.16.3 SDK."
tags: [jeito, web, provenance, exa, adapter, sdk]
created: 2026-07-27
updated: 2026-08-12
status: active
owns: "Exa adapter provenance"
audience: contributor
code: [src/adapters/exa.ts]
related: [docs/upstreams/README.md, docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md]
---

# Exa adapter contract from the official SDK

- **Package:** `@capyup/pi-exa` 0.5.1; repository <https://github.com/capyup/pi-exa>.
- **Resolved snapshot:** `8da1600c459e`; MIT license confirmed from `LICENSE`.
- **Runtime boundary:** installed official `exa-js` 2.16.3; no upstream extension code is imported.
- **Grounded source:** the pinned wrapper, installed `exa-js/dist/index.d.ts`, and official [Get contents](https://docs.exa.ai/reference/get-contents) contract, reviewed 2026-07-31.

## Exa search and answer contracts used locally

The installed SDK's `search(query, options)` supports regular types
`keyword|neural|auto|hybrid|fast|instant`, deep types
`deep-lite|deep|deep-reasoning`, current categories
`company|publication|news|personal site|financial report|people`, domain and
publication filters, text constraints, location, moderation, deep instructions,
additional deep queries, structured output, and configurable contents.
`web_search.exa` exposes the high-value typed subset already mapped by
`src/adapters/exa.ts`; response normalization retains title, URL, publication
date, score, highlights or text.

`exa.answer(question, options)` returns an answer plus provider citation records and supports `text`, `userLocation`, `systemPrompt`, and `outputSchema` in the installed SDK. Returned citation passages use `provider-citation` with `fetched:false`; only jeito's independent fetch path may label source content `fetched`. SDK status 401/403 maps to auth, 429 to rate limit, and transport/server failures to the shared taxonomy.
Credentials never enter output.

Provider-valid zero search rows are a successful scoped no-winner, with cost and effective controls preserved. Malformed provider response shapes are `unavailable`. Because one retained response violated a documented publication lower bound, jeito locally adjudicates only observable URL/domain and parseable publication-date constraints; rejected and unverifiable counts remain visible. Text constraints and category remain provider-side/hint semantics and are never claimed as locally proven.

## Complete internal capability boundary

jeito websift calls `exa-js` in-process and reads credentials only through
`src/config.ts::resolveCredential`. `src/adapters/exa.ts` now owns typed internal
`getContents`, deprecated URL similarity, and asynchronous research create/poll
operations in addition to the public adapter. Similarity is compatibility-only because `exa-js@2.16.3` marks `findSimilar()` for removal with no direct replacement. Research remains unselected while current official documentation centers Agent rather than the legacy Research model names. These operations remain callable by focused
maintenance/comparison code but are not registered as hidden Pi tools.
[`../ROADMAP.md`](../ROADMAP.md) records implementation and exposure separately.

## Current Exa Contents request and response contract

`src/adapters/exa.ts::fetchExaContents` maps the current installed `exa-js@2.16.3` Contents surface rather than replaying the donor CLI fields:

- text mode supports `maxCharacters`, `includeHtmlTags`, `verbosity`, `includeSections`, and `excludeSections`;
- highlights and summary modes accept a retrieval `query`; highlights use current `maxCharacters` rather than deprecated sentence/count sizing;
- freshness and retrieval use `maxAgeHours`, `livecrawlTimeout`, and `filterEmptyResults`; the deprecated `livecrawl` enum is removed;
- every returned URL status is retained with source and typed error tag/status when present, including partial-result calls;
- `costDollars.total` and the text/highlights/summary breakdown are retained for focused cost accounting.

Search requests without full text now use the current `{highlights:true}` form instead of deprecated `numSentences` and `highlightsPerUrl`; Exa documents search-attached content as included at no extra charge up to ten results. Focused calls found query-guided highlights preserved the needed wording with less context than bounded text, while summary was slower, abstractive, and locator-poor. `maxAgeHours:0` correctly forced fresh section-aware extraction but added no value on the already-clean Exa documentation page. Native-versus-Exa-versus-Tavily-versus-Linkup extraction roles remain task- and owner-dependent.

## Focused Exa apprenticeship — 2026-07-31

- Quoted keyword search plus `includeText` repaired a broad exact-identity query; exact package versions still use the registry.
- One descriptive web-research-agent query returned a tighter direct-tool set under hybrid than neural; neural remained useful as a broader adjacent-concept scout.
- Instant and fast returned the same five official-document leads at $0.007 in 222 ms and 355 ms respectively in one direct run; official mode semantics, not one timing sample, remain authoritative.
- Deep-lite/deep returned five official sources in 4.2/3.7 seconds at $0.012; deep-reasoning took 11.3 seconds/$0.015 and added a useful changelog but did not improve the ordinary lookup enough to justify the extra mode.
- `category:"publication"` plus a freshness window produced paper/preprint leads without general-page noise.
- Answer returned eight source records in 1.9 seconds/$0.005. Search and Answer now preserve `costDollars.total` into model-visible output and tool details.
- URL similarity cost $0.007 and returned mostly catalogs/directories. Combined with the SDK deprecation, this closes public exposure as rejected.

Raw responses and cost accounting are under `.tmp/exa-apprenticeship-20260731/`; ADR 5.4 owns the scoped decision and reopen conditions.

## Owning proof and upkeep

`tests/adapters/exa.test.mjs` uses representative requests to protect current search-content mapping plus internal content/similarity/research behavior, including per-URL failure status and cost retention; `tests/web-specialists.test.mjs` proves the explicit Exa Search method reaches only Exa. The shared no-secret gate owns credential output. Last reviewed 2026-07-31 against installed `exa-js` 2.16.3.
