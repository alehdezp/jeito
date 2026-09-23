---
title: "tooltap provider verification baseline from 2026-07-09"
description: "Dated provider execution, cache, and tool-shape evidence retained as a historical tooltap baseline."
tags: [tooltap, provider-verification, cache, historical-evidence]
created: 2026-07-26
updated: 2026-07-26
status: stale
owns: "Historical provider verification baseline for tooltap 0.4.2"
audience: contributor
related: [contract.md, real-world-verification.md]
---

# Cross-model verification — 2026-07-09

This report records live Pi evidence for tooltap 0.4.2 on Pi 0.80.5. It distinguishes provider evidence from local contract tests and does not treat stable hashes alone as cache proof.

Follow-up raw API probes, catalog measurements, gateway/skeleton effectiveness benchmarks, and corrected `additional_tools` conclusions are recorded in [`research-findings-2026-07-10.md`](./research-findings-2026-07-10.md). The dated matrix below remains the evidence for the current shipping Pi implementation; roadmap experiments do not retroactively change its status.

## Configuration under test

- OpenAI client search: GPT-5.4, GPT-5.5, and GPT-5.6 Responses routes.
- Shape-only skeleton fallback: model IDs containing `glm-`, `kimi-`, or `mimo-`.
- Tool inventory in the live runs: 17 startup-active tools and 36 eligible hidden tools.
- `logPayloads: true`; no synthetic cache-probe requests.
- Test prompts used `pi_version` (no arguments) and `pi_changelog` with `version: "0.80.5"` (parameterized).

The canonical evidence is the correlated `before_provider_request` and `turn_usage` entries in `~/.pi/agent/tooltap.log.jsonl`, keyed by `sessionIdHash`.

## Results

| Model route | Strategy | Hidden execution | Stable `toolsHash` | Provider cache evidence | Status |
|---|---|---|---|---|---|
| `openai-codex/gpt-5.4` | client `tool_search` | searched once, then `pi_version` executed directly | yes | 12,288 then 12,800 cached tokens | pass |
| `openai-codex/gpt-5.5` | client `tool_search` | searched once, then `pi_version` executed directly | yes | 12,288 then 12,800 cached tokens | pass |
| `openai-codex/gpt-5.6-sol` | client `tool_search` | searched once, then `pi_version` executed directly | yes | 11,776 cached tokens on both post-search requests | pass |
| `zai/glm-5.2` | stable skeleton | direct `pi_version`; direct parameterized `pi_changelog` | yes after the stability fix | 18,880–18,944 cached tokens on continuation; a fresh matching session reused 18,816 cached tokens | pass |
| `xiaomi-token-plan-ams/mimo-v2.5` | stable skeleton | direct `pi_version`; direct parameterized `pi_changelog` | yes after the stability fix | 22,272, 22,400, then 22,528 cached tokens | pass |
| `deepseek/deepseek-v4-pro` | dispatch-only + `#tool` | direct `pi_version`; direct parameterized `pi_changelog` | yes | 16,000–16,256 cached tokens | pass for this route |
| `google/gemini-3-flash-preview` | dispatch-only + `#tool` | both tools executed, but one erroneous `bash pi_version` attempt occurred first | provider payload hook unavailable | ~16,256 cached tokens on continuations | partial |
| KiMi routes | stable skeleton | not observed live | payload contract only | unavailable | blocked by provider availability |

### GPT client-search details

The GPT-5.4/5.5/5.6 runs each showed:

- one top-level client `tool_search` declaration;
- zero function-form `tool_search` shims;
- zero hidden/deferred functions in initial top-level `tools[]`;
- one `tool_search_call` and one matching `tool_search_output`;
- one loaded schema;
- unchanged top-level tool and instruction hashes after loading;
- direct execution of `pi_version` after the search;
- non-zero provider-reported cache reads on post-search requests.

Representative session hashes:

- GPT-5.4: `fd9e50aca1f30db2`
- GPT-5.5: `3e2510b7b0275ec4`
- GPT-5.6: `a064d531b8b878e4`

A clean GPT-5.6 request measured 21,598 serialized top-level tool bytes, approximately 5,400 tokens using the deliberately rough `bytes / 4` diagnostic. Hidden schemas contributed zero initial bytes on this path.

### GLM/MiMo skeleton details

A live test initially exposed a cache bug: the function-form `tool_search` description reclassified newly unlocked tools and changed `toolsHash` on the next user turn. The implementation now classifies the manifest from the immutable startup set. Fresh post-fix GLM and MiMo runs kept the same hash, `5cca59e22313df4a`, while dispatch count increased from 16 to 18 as two hidden tools executed.

Both providers directly executed:

1. `pi_version` with no arguments;
2. `pi_changelog` with `version: "0.80.5"`.

This proves both no-argument and parameterized skeleton calls for the tested providers.

Representative post-fix session hashes:

- GLM-5.2: `1897b43d2943bcdb`
- MiMo-2.5: `9524cc8767834623`

## Token-shape measurements

For the same 17-active/36-hidden inventory, GLM and MiMo received an identical stable skeleton tool shape:

| Measurement | Bytes | Approximate tokens (`bytes / 4`) |
|---|---:|---:|
| All 53 top-level tool entries | 39,982 | 9,996 |
| 36 hidden shape-only skeleton entries | 12,732 | 3,183 |
| Hypothetical 36 full hidden definitions | 34,364 | 8,591 |
| Skeleton saving versus full hidden definitions | 21,632 | 5,408 |

The skeleton therefore reduced the hidden-definition serialization by about 63% while retaining parameter names, types, required fields, array item shapes, and enums needed for direct parameterized calls. It still costs roughly 3.2K estimated tokens up front. It is cache-efficient after the prefix is established, but it is not as initially token-efficient as OpenAI's native deferred loading.

The token estimates are diagnostics, not tokenizer-authoritative billing numbers. Provider `turn_usage` is the authority for actual input and cache usage.

## Dispatch-only evidence

DeepSeek V4 Pro proved that dispatch-only can be both lean and reliable on a compatible route:

- 17 top-level active tools and zero hidden skeleton entries; the active `tool_search` description still carries the compact discovery manifest;
- 27,251 serialized tool bytes (~6,813 rough tokens);
- stable hash `c5dd366801372326` while dispatch count increased from 17 to 18;
- direct `#tool`-activated execution of `pi_version` and parameterized `pi_changelog`;
- 16,000–16,256 provider-reported cached tokens after the first request.

Representative session hash: `b3f26003e13f3068`.

Gemini 3 Flash Preview also executed both hidden tools and reported cache reuse, but the first prompt attempted `pi_version` through `bash` before recovering to the actual tool. The Google provider path did not expose a `before_provider_request` payload to tooltap, so no canonical provider `toolsHash` was captured. Gemini is therefore partial evidence, not a same-quality pass.

Dispatch-only success is model-specific. It must not be generalized to every unconfigured provider without a live call and cache report.

## KiMi limitation

KiMi could not be verified live in this environment:

- `opencode-go/kimi-k2.7-code` returned HTTP 500 both with tooltap and in a `--no-extensions` control session;
- ClinePass returned its weekly-limit HTTP 429;
- GitHub Copilot had no usable API credential.

The local harness verifies that GLM, KiMi, and MiMo model IDs receive the same deterministic skeleton shape, but that is not live KiMi execution or cache proof.

## Interpretation

- **GPT-5.4/5.5/5.6:** hidden schema cost is deferred until search; live cache evidence passed.
- **GLM-5.2 and MiMo-2.5:** direct hidden-tool quality and stable-prefix caching passed. Shape-only skeletons save substantial tokens relative to full hidden schemas, but pay a bounded upfront parameter-shape cost.
- **DeepSeek V4 Pro dispatch-only:** no hidden schema entries up front beyond the compact discovery manifest; both tested hidden calls, stable hashes, and cache reuse passed.
- **Gemini 3 Flash Preview dispatch-only:** both tools eventually executed and cache reads were present, but tool selection quality and payload observability were weaker; partial only.
- **KiMi:** contract-tested but live-unverified because every available provider route was unavailable independently of tooltap.
