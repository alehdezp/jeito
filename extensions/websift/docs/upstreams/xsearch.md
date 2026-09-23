---
title: "Provenance — current xAI X Search contract and apprenticeship"
description: "Current xAI Responses X Search contract plus focused exact-date, handle, image/video, usage, cost, no-winner, and public-output findings."
tags: [jeito, web, provenance, xsearch, xai, social, apprenticeship]
created: 2026-07-27
updated: 2026-08-01
status: active
owns: "xAI X Search adapter provenance and focused provider recipes"
audience: contributor
code: [src/adapters/xsearch.ts::xSearchResponses, src/adapters/xsearch.ts::normalizeXSearch, src/adapters/xsearch.ts::normalizeXSearchHandles, src/adapters/xsearch.ts::isValidCalendarDate]
related: [docs/upstreams/README.md, docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md, docs/adr/0005-provider-evaluation-and-guidance/0002-provider-contract-baseline.md]
---

# Current xAI X Search contract and focused provider recipes

- **Historical donor:** `@pi-lab/xsearch` 1.0.3 at `d78f2dabc9ec`, MIT licensed. It remains request-shape history; no donor code is copied.
- **Runtime:** direct `POST https://api.x.ai/v1/responses` with one `x_search` server-side tool.
- **Current authority:** official [X Search](https://docs.x.ai/developers/tools/x-search), [pricing](https://docs.x.ai/developers/pricing), Responses, citations, and model docs, refreshed 2026-08-01.
- **Live packet:** `.tmp/exa-apprenticeship-20260731/xsearch/`; five focused Responses calls under the owner-approved aggregate budget.

## Current request and response contract

The request sends a model, user input, and `tools:[{type:"x_search"}]`. Tool controls are mutually exclusive `allowed_x_handles`/`excluded_x_handles` (official maximum 20), inclusive `from_date`/`to_date`, and optional image/video understanding. Responses controls `max_turns`, `parallel_tool_calls`, and `max_output_tokens` remain internal.

The response provides Grok synthesis in `output[].content[].text`, citation URLs in annotations and/or top-level `citations[]`, and token/tool-call usage in `usage`. The API does not promise raw post objects. jeito emits one social lead per unique citation, never invents post author/date/engagement, and now shows the bounded synthesis once plus model, total tokens, and `x_search` call count instead of repeating the synthesis for every URL.

## Public and internal disposition

- **Public:** exact inclusive dates and up to 20 allowed or excluded handles. Handle trim/`@` removal stays visibly warned. A forced route implies social intent and rejects unrelated kind/depth/domain controls.
- **Internal:** model, image/video understanding, `maxTurns`, `parallelToolCalls`, and `maxOutputTokens`. Media understanding materially changes model token work; current normalized results cannot faithfully expose which media evidence supported which claim.
- **Local `count`:** bounds returned citation URLs only. It never reduces upstream model/tool work.

The donor default `grok-4-1-fast-non-reasoning` remains the public adapter default. Current `grok-4.5` is implemented for focused calls but is not promoted as the default: this packet did not run a successful matched quality comparison, and the current-model calls showed materially higher hidden retrieval/token work.

## Internal bounds are not a billable tool-call ceiling

The 2026-07-31 assumption that `max_turns:1`, `parallel_tool_calls:false`, and `max_output_tokens:1000` provide a tight cost ceiling was false. Two successful 2026-08-01 calls reported 10 and 14 `x_search` invocations inside one Responses request, plus 2,208 and 1,800 output tokens. `max_turns` bounds agent turns, not server-side search invocations; `parallel_tool_calls:false` changes concurrency, not total calls; the provider-reported output exceeded the requested 1,000 bound in this tool-using flow.

Therefore xAI live-call budgets must reserve token and tool-call work from observed envelopes rather than multiplying one request by one tool call. The public schema says this explicitly. There is no hidden retry in jeito; the multiplicity occurs inside one xAI Responses request.

## Focused exact-date, handle, media, and no-winner findings

- **Independent first-hand lane:** `grok-4.5`, exact July 2026 dates, and excluded `xai`/`elonmusk` returned nine practitioner citations in `51.199 s`. Decoding sampled X snowflake IDs independently placed them on July 8, 15, and 30. Reported work: 117,937 input tokens, 2,208 output tokens, 10 X searches.
- **Official-handle no-winner:** both donor-fast and current models returned no citation URLs for an exact-date `@xai` Grok 4.5 announcement query. This is a valid scoped no-winner, not evidence that date/handle filters failed.
- **Image-understanding no-winner:** the call returned six official-post citations but its synthesis explicitly said no July benchmark chart matched. The citations concerned adjacent official posts. Agents must read the synthesis and treat unrelated citations as rejected leads; citation presence alone does not overturn a no-winner.
- **Video no-winner:** one exact-date official-handle video query returned no cited match.

`xSearchResponses` returns a citation-free provider completion as a successful scoped zero that preserves the synthesized text and reported work metadata (token/model/x_search receipts), instead of treating a valid no-winner as a failure. Zero citations means no retrieved cited X evidence under that request, never absence of a post or event. Successful public output shows the synthesis once and keeps citations lead-only; malformed response shapes are provider-contract `unavailable`.

## Current pricing and packet reserve

Official pricing is model tokens plus `$5/1k` X Search invocations. Current `grok-4.5` short-context rates are `$2/M` input and `$6/M` output. The two successful calls total `$0.513842` from provider-reported usage. Three citation-free calls discarded usage under the old normalization path, so the ledger conservatively reserves each at the largest observed component envelope. Total packet reserve: `$1.485`. This is deliberately conservative; no additional paid call is needed to reconstruct already-spent exact usage.

## Failure, cancellation, and credential contract

The adapter validates calendar dates and handle combinations before network, races caller abort with a local timeout, classifies HTTP failures centrally, redacts the bearer credential, and fails loudly on malformed Responses shapes. No retry or fallback happens inside the adapter.

## Owning proof and evidence limits

- `tests/adapters/xsearch.test.mjs` owns request mapping, official max-20 handles, exact dates, internal media/bounds, metadata, no-winner synthesis, cancellation/failure, and redaction.
- `tests/output.test.mjs` owns one bounded model-visible synthesis plus usage rather than per-citation repetition.
- `tests/web-specialists.test.mjs` owns the public X Search specialist schema and one-attempt dispatch.
- This packet supports exact-date/handle call construction and no-winner discipline. It does not establish a default model or comparative provider priority.
