---
title: "tooltap deferred-tool research findings from 2026-07-10"
description: "Dated research evidence behind client tool search, additional tools, provider adapters, and stable tool surfaces."
tags: [tooltap, research-findings, tool-search, provider-adapters]
created: 2026-07-26
updated: 2026-07-26
status: stale
owns: "Historical deferred-tool research evidence for tooltap"
audience: contributor
related: [contract.md, future-roadmap.md]
---

# Deferred-tool research findings — 2026-07-10

This is the concise evidence ledger for the architecture discussion after the 0.4.2 live matrix. It separates provider behavior, Pi behavior, measurements, and design conclusions. The future design is in [`future-roadmap.md`](./future-roadmap.md).

## Evidence rules

- **API proof** means a live provider request produced the stated request/response/usage behavior.
- **Pi proof** means a saved Pi session plus provider/usage logs showed execution through the running integration.
- **Structural cache safety** means the integration preserved the earlier request prefix. It does not guarantee a provider cache hit.
- Byte/4 token figures are rough serialized-shape diagnostics, not tokenizer-authoritative billing.
- An accepted unknown JSON field is not support. Several chat APIs silently ignored `additional_tools`.

## OpenAI/GPT findings

Official references:

- [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

### Native client tool search

Verified behavior:

- GPT-5.4+ Responses accepts `{type:"tool_search", execution:"client"}`.
- A client `tool_search_call` must be paired with `tool_search_output` using the same `call_id`.
- Trusted functions absent from the initial request may be returned by client search.
- Loaded functions remain callable on later turns and should not be loaded again.
- Changing a historical loaded set breaks caching from that point.

A large 80-field function measured 2,306 input tokens as a normal function and 409 tokens through deferred hosted search in the controlled request: about 82% less initial input for that definition. This is one measured schema, not a universal ratio.

### `additional_tools`

The earlier claim that `additional_tools` necessarily breaks the whole cache or must be present at conversation start was disproved at the raw Responses API.

Stateful conversation proof:

1. Turn 1 had `tools: []` and no added function.
2. Turn 2 appended one `additional_tools` developer item and called the function with correct arguments.
3. The function result was returned normally.
4. A later ordinary turn omitted both top-level tools and a new additional item; the previously added function was still callable.

Manual replay proof, matching the shape Pi ultimately needs:

| Turn | Input tokens | Cached tokens | Observation |
|---|---:|---:|---|
| tool absent | 4,226 | 0 | no tool call |
| item appended | 4,375 | 0 | correct call |
| result replayed | 4,419 | 4,096 | earlier prefix reused |
| later user turn | 4,449 | 4,096 | same function called without re-adding it |

The replay contained exactly one historical `additional_tools` item and top-level `tools[]` stayed empty. A separate warmed-prefix activation request reported 3,072 cached tokens out of 3,410 while calling the newly added function.

Conclusion: `additional_tools` is valid for explicit application-selected activation, but Pi does not yet serialize/replay it. Provider proof is not Pi integration proof.

## Non-GPT API capability findings

Official documentation reviewed:

- [Z.AI chat completion](https://docs.z.ai/api-reference/llm/chat-completion)
- [Z.AI function calling](https://docs.z.ai/guides/capabilities/function-calling)
- [DeepSeek tool calls](https://api-docs.deepseek.com/guides/tool_calls)
- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache)
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Gemini caching](https://ai.google.dev/gemini-api/docs/caching)
- [Moonshot/KiMi tools](https://platform.moonshot.ai/docs/guide/use-kimi-api-to-complete-tool-calls)
- [MiMo API reference](https://platform.xiaomimimo.com/docs/api-reference/text-generation)

None of the reviewed non-GPT APIs documents OpenAI `defer_loading`, `tool_search_output`, or `additional_tools` input items.

### Live `additional_tools` probes

| Route | Top-level unknown `additional_tools` | Conversation item |
|---|---|---|
| GLM-5.2 | silently ignored; no call | silently ignored; no call |
| MiMo-2.5 | ignored; textual fake call | HTTP 400 |
| DeepSeek V4 | silently ignored; no call | HTTP 400 |
| Gemini Interactions | HTTP 400 unknown parameter | unsupported |

Normal late top-level `tools[]` mutation made the function callable, but cache behavior differed:

| Route | Warm cached | Activation cached after changing `tools[]` |
|---|---:|---:|
| GLM-5.2 | 2,624 | 0 |
| MiMo-2.5 | 2,560 | 2,560 |
| DeepSeek V4 | 2,560 | 2,560 |
| Gemini | no cache observed in that short probe | no conclusion |

GLM disproves any universal claim that late `tools[]` mutation is cache-safe. Chat-completion routes also required definitions again on later requests; omitting them produced textual tool markup, not API `tool_calls`.

Gemini Interactions is different: a function added on a later stateful interaction remained callable through `previous_interaction_id` even when later requests omitted or emptied `tools`. Current Pi uses `googleGenerativeAIApi`, not the Interactions API.

## Calling undeclared tools

With at least one unrelated registered function and a full usage contract in conversation:

- GLM called the unrelated registered function instead of the undeclared target.
- MiMo produced no real call.
- Gemini Interactions emitted a real call to the undeclared target with correct arguments.
- DeepSeek V4 previously did the same in live Pi: provider `toolCount` stayed 17 while dispatch count rose to 18 and `pi_version`/parameterized `pi_changelog` executed. Session: `2026-07-09T23-05-50-552Z_019f4921-5ad7-7087-85cf-c94d28919cb4.jsonl`; provider log session hash `b3f26003e13f3068`.

DeepSeek/Gemini undeclared calls are route-specific observed behavior, not a documented portable contract.

## What GLM requires for direct calls

Z.AI documents `parameters` as required for parameterized functions and omittable only for no-argument functions. Live probes matched that contract:

| Declaration | Later text supplied full schema | GLM arguments |
|---|---|---|
| name + description, no `parameters` | yes | `{}` |
| open object with `additionalProperties:true` | yes | `{}`; one complex probe looped empty calls |
| property names without types | yes | values could have wrong types (`"19"` instead of `19`) |
| typed shape skeleton | yes | correct direct arguments |

For reliable direct GLM calls, the provider schema must retain names, types, required fields, nested structure, array items, and enums. Rich prose can be deferred.

## Real inventory measurements

Registry captured from the running Pi installation: 54 registered tools, 17 startup-active, 36 eligible hidden, one blocked.

| Shape | Bytes | Rough tokens |
|---|---:|---:|
| 36 names + 80-character descriptions | 2,813 | 704 |
| 36 name-only enum/list | 680 | 170 |
| five group names + descriptions | 460 | 115 |
| groups + individual names | 1,141 | 286 |
| 36 current shape skeletons | 12,741 | 3,186 |
| one combined gateway parameter schema | 321 | 81 |

Fair variable surface estimates, excluding shared core tools/framing:

- Current skeleton route: about 4,005 rough tokens (`704 + 3,186 + ~115`).
- Schema-free search/proxy with the full discovery catalog: roughly 900–1,000 tokens.
- Potential context reduction: about 3,000–3,100 tokens, not “an 80-token total.”

The discovery catalog is unavoidable if the agent must discover individual tools autonomously. Group-only discovery is smaller but less accurate.

## Call-effectiveness benchmarks

Ten tasks covered Pi runtime, package detection, web similarity/crawl, library docs, structured user questions, extension profiling, stored search content, and skill installation. Reasoning models were rerun with `max_tokens:512`; earlier low-cap MiMo results were discarded.

### Selection

- GLM full individual descriptions + exact-name enum: 20/20 across two runs, about 1,137 prompt tokens.
- GLM compact groups + names: 15/20 across two runs, about 615 prompt tokens.
- MiMo full catalog + simple exact-name gateway: 9/10; the miss chose search-before-install, a defensible workflow.
- Current skeleton direct route: GLM 8/10 and MiMo 9/10 under strict expected-name scoring. GLM abstained when a required response ID was absent and asked before an underspecified install; these are not straightforward quality failures.

Conclusion: do not replace individual descriptions with group-only discovery when call selection matters.

### Real complex first use

Task: call `tavily_crawl` with URL, depth, limit, path arrays, and output enum.

| Route | Model steps | Final/call context | Result | Typical observed latency |
|---|---:|---:|---|---:|
| GLM skeleton direct | 1 | 4,378 prompt tokens | correct native call | ~6–8s |
| GLM combined gateway | 2 | ~1,450 final prompt | repeatedly answered text instead of second call | ~16–18s |
| GLM separate search + proxy | 2 | 1,414 final prompt; 2,535 cumulative | correct proxy call | ~17s |
| MiMo skeleton direct | 1 | 6,782 prompt tokens | correct native call | ~2–3s |
| MiMo separate search + proxy | 2 | 1,609 final prompt; 2,891 cumulative | correct proxy call | ~4s |

A single combined gateway is not reliable enough for GLM complex first use. Separate `tool_search` and `tool_proxy` work, but add a model round, output tokens, latency, validation, rendering, and forwarding complexity.

Repeated skeleton requests showed heavy cache reuse (for example, GLM 4,352/4,378 and MiMo 6,720/6,782 cached in repeated probes). Skeletons still occupy context; cache amortizes billing, not context size.

## Current conclusions

1. Keep native client tool search for GPT Responses.
2. Treat `additional_tools` as a proven provider mechanism for explicit application-selected activation, pending Pi item/replay support.
3. Keep direct shape skeletons for normal discoverable GLM/MiMo tools at the current 36-tool scale: one-step direct calls and provider validation outweigh ~3.1K context savings from a two-step proxy route.
4. Improve skeletons rather than making them empty: recursively preserve callable shape, attach concise descriptions to the matching function, and avoid duplicate catalog prose.
5. Keep verified DeepSeek/Gemini text-contract direct dispatch route-specific, not universal.
6. Use a stable proxy only where zero-upfront `noDiscover` semantics require it on schema-constrained providers, preferably after explicit marker/group selection so no search round is added.
7. Keep KiMi as live-unverified. Config-shape tests are not provider proof.

## Known limitations

- Raw provider experiments are not yet automated repository tests.
- Pi `additional_tools` serialization/replay remains unimplemented.
- Proxy forwarding of validation, cancellation, streaming, images/files, errors, renderer details, and session replay is unverified.
- Provider cache hits are probabilistic/runtime evidence; the extension can guarantee stable structure, not a hit rate.
- Results apply to exact tested provider/API/model routes and can regress with provider changes.
