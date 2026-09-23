---
title: "ADR 1.4 — Tool calls compose; hard failure is the exception"
description: "Tool modes and parameters compose with visible mode labels and next-step hints; hard failure is reserved for input whose intent cannot be inferred."
tags: [jeito-websift, adr, tool-call-ergonomics, graceful-degradation, composition]
created: 2026-08-03
updated: 2026-08-04
status: active
adr_id: ADR-001.004
adr_type: child
decision_status: accepted
confidence: user-stated
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Tool-call composition and hard-failure boundary for all jeito websift tools"
audience: mixed
parent: docs/adr/0001-product-and-evidence/README.md
code: [src/tools/web-fetch.ts::registerWebFetch, src/section-rank.ts::querySections]
related: [docs/adr/0001-product-and-evidence/0002-tool-surface-and-evidence.md, docs/adr/0002-internal-architecture/0003-fetch-pipeline.md]
---

# ADR 1.4 — Tool calls compose; hard failure is the exception

## Decision

jeito websift tool calls **compose instead of hard-failing**. When a caller combines
parameters or modes, the tool runs the best-supported interpretation of the combined
intent, names the mode that actually ran, and prints a next-step hint where the
combination is approximate. A hard `invalid_input` failure is reserved for inputs whose
intention cannot be inferred at all: no URL/retained/job id, unknown mode, a blank supplied
pattern/`query_terms`, `top` without terms, out-of-range numeric controls, or conflicting identities such as `responseId` with a fresh URL.

This is a general must for every tool in this extension: **hard failure should be the
exception when the intention of the tool call could not be inferred, and every output
should display the mode being run plus proper next options.**

## The composition table (`web_fetch`, implemented)

| Call | What runs | Output order |
|---|---|---|
| one URL, no `query_terms` | ordinary page fetch | complete source through ~2K tokens or bounded navigation/section-start view |
| one URL + `query_terms` | BM25 rank of cached page | top-N raw sections, then compact navigation |
| one URL + `query_terms` + `pattern` / `download` | composed deterministic mode | primary mode and exact targeted output both remain visible |
| multiple URLs | independent per-source fetch | cumulative completion updates; final source cards in authored order; partial failures retained |
| multiple URLs + `query_terms` | same independent fetch | no BM25 cross-ranking; terms remain available only to an explicit summary |
| `llm_rich:true` | explicit asynchronous summary after acquisition | source output first plus `summary_id`; `wait` may return completion inline |
| `summary_id` | poll one existing summary job | running, completed brief, or failed status without refetching |
| multiple map seeds | every seed maps independently | one source-labelled map result per seed |
| multiple crawl seeds | fair shares of one global budget | per-seed manifests; visible failed/skipped entries |

`top` (1-5, default 3) controls only single-page ranked-section output. `query_terms` is the only BM25 input; `context` cannot alter it. `query_terms` and `context` are both optional for an explicitly requested general summary.

## Why

Agents make parameter mistakes under research pressure, but silent reinterpretation must not corrupt retrieval. A supplied blank lexical packet is invalid; an omitted packet is valid because full-page reading and general summarization are legitimate intents. Asynchronous summaries keep slow, lossy model work from blocking or replacing deterministic source acquisition.

Cross-document BM25 was removed because it makes sources compete and can hide zero-score pages even when the user asked to retrieve all of them. Multi-source retrieval now preserves every source and uses one synthesis group only when the caller explicitly requests model reasoning.

The not-found contract remains single-page and deterministic: zero exact/stemmed overlap returns navigation and cache paths rather than fabricated evidence.

## What would change this decision

A composed output that measurably confuses callers (evaluated on the novel-corpus gate)
or a mode combination whose best interpretation is genuinely ambiguous would move that
combination to a hard failure with a message listing the valid options.

## Evidence and verification

`tests/web-fetch.test.mjs` exercises single-page ranking, strict smart-view bounds, cumulative multi-source progress, authored final order, partial failure, Linkup fan-out, every-seed map, fair shared-budget crawl, explicit no-query summaries, operation summaries, polling, and invalid-input boundaries. `tests/section-rank.test.mjs` retains the single-page lexical ranking proof. `tests/llm-rich.test.mjs` covers source validation, persistence, output bounds, provider rotation, and cooldown.

## History

- 2026-08-03: accepted compose-over-reject with the original single-page ranking contract.
- 2026-08-23 (M3): surface decisions recorded — dedicated `context7` tool with flat parameters (rerank always on, txt inline pinned internally as developer constants); aliases removed from every public web tool; `freshness` parameter (default past month) translated internally to the provider time-filter dialect so wire codes never reach agents; instruction tails rewritten per docs/tool-guidance-architecture.md. Agent-decision rule adopted: a parameter exists only when its right value depends on caller intent.
- 2026-08-23: `web_lookup` joins compose-over-reject at the contract layer: flat declared schema (13 properties, `additionalProperties:false`, nothing required) with per-source runtime discrimination — wrong-source parameters become visible notes, limit caps (skillsmp 100 / pi-packages 20) fail as `invalid_input`. Replaces the ADR-001.002 root-anyOf envelope, which live serving stacks punished by stripping every argument. Proof: web suite 284/284; wire params −44 %; fresh-session execution verified.
- 2026-08-04: replaced grouped BM25 and automatic rescue with independent source rendering plus explicit asynchronous summaries; added multi-seed map/crawl composition and Linkup URL fan-out.
