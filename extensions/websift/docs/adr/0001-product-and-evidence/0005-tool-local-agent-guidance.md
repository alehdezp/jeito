---
title: "ADR 1.5 — Tool-local agent guidance across the websift stack"
description: "Places complete operational guidance for every jeito websift tool in its registered definition while APPEND retains only cross-tool evidence routing."
tags: [jeito-websift, adr, tool-guidance, prompt-guidelines, schema, append]
created: 2026-08-04
updated: 2026-08-12
status: active
adr_id: ADR-001.005
adr_type: child
decision_status: accepted
confidence: user-stated
evidence_grade: verified
implementation_status: completed
decision_owner: alehdezp
owns: "Runtime agent-guidance placement and non-duplication across every jeito websift tool"
audience: mixed
parent: docs/adr/0001-product-and-evidence/README.md
code: [index.ts, src/tools/web-search.ts::registerWebSearch, src/tools/web-fetch.ts::registerWebFetch, src/tools/web-answer.ts::registerWebAnswer, src/tools/web-lookup.ts::registerWebLookup, src/tools/web-search-specialists.ts::registerWebSearchSpecialists, src/tools/web-answer-specialists.ts::registerWebAnswerSpecialists]
related: [docs/adr/0001-product-and-evidence/0004-tool-call-ergonomics.md, docs/adr/0005-provider-evaluation-and-guidance/0005-guidance-lifecycle.md, tests/registration.test.mjs, tests/web-specialists.test.mjs, tests/web-fetch.test.mjs]
---

# ADR 1.5 — Tool-local agent guidance across the websift stack

## Decision

Every jeito websift tool owns its complete ordinary-use guidance in the registered Pi tool definition that the agent receives when the tool is active. Each definition separates four responsibilities:

- `description` states the tool's role, output boundary, and important contrast with sibling tools;
- parameter descriptions state field-local meaning, bounds, combinations, and evidence or cost consequences;
- `promptSnippet` supplies one high-attention default for choosing or constructing the tool call;
- `promptGuidelines` contains exactly one coherent string that teaches the full operating flow without repeating the parameter catalog: invocation, construction, composition, interpretation, reuse, evidence boundary, recovery, and stop condition.

The Pi contract types `promptGuidelines` as `string[]`, so “one string” means one array element rather than a different public type. The same ownership applies to the four startup tools and five provider/method specialists.

The single array element may be a multiline Markdown-formatted string. When a tool's advanced shape is easy to misuse, that string includes one schema-valid representative call plus the success, zero-result, adjacent-result, or failure interpretation that changes the next action. A provider-accepted zero-match response remains a successful scoped outcome; transport, credential, quota, timeout, cancellation, and malformed-response conditions remain failures.

APPEND may retain stable cross-tool external-evidence routing, such as discovery leads versus fetched evidence and W1/W2 versus W3/W4 research. APPEND does not own websift parameter construction, adaptive tool flow, page reuse, provider tactics, or operation-level recovery. Those rules change with the registered tool and must ship with it.

## Zero-result search outcomes remain successful

A reachable provider can accept a valid query and return no matching rows. Search and catalog tools represent that as an executed attempt with zero leads or records, the exact query or controls, and one tool-specific mutation when another attempt is useful. They do not relabel zero matches as provider failure or invent a synthetic record to carry metadata. Malformed JSON or changed provider response shape is `unavailable`, not an empty outcome.

Tool-local guidance owns the useful next mutation because retrieval mechanisms differ: Serper relaxes or adds one lexical constraint, Exa changes one identity/mode/filter dimension, X widens event coverage or authority scope, Tavily changes one focused regional or independent-guide hypothesis, and catalog lookup changes one term or filter. `$research` may accumulate hard constraints across evidence-driven W3/W4 iterations; APPEND never dictates those provider tactics.

The runtime owners are the registered definitions under `src/tools/`. Their full flows compose with [ADR-001.004](0004-tool-call-ergonomics.md), which keeps hard failure exceptional and makes executed modes visible.

## Stack-wide obligations

`src/tools/web-search.ts::registerWebSearch` teaches Serper lexical lead discovery and stop conditions. `src/tools/web-fetch.ts::registerWebFetch` teaches first-call targeting, grouped retrieval, deterministic versus LLM filtering, cache reuse, and exact-evidence expansion. `src/tools/web-answer.ts::registerWebAnswer` teaches provisional Exa orientation and the handoff to `$mini-research`/`$research`. `src/tools/web-lookup.ts::registerWebLookup` teaches versioned documentation versus catalog evidence. The five specialist definitions each teach one native advanced call, no hidden fallback, provider-specific failure interpretation, primary verification, and return to the caller's larger research loop.

Tool definitions may repeat a field name when the full-flow sentence needs it, but they do not copy limits, provider lists, or branch mechanics already owned by that field's schema description. Current product documentation may describe the architecture and behavior; it is not a competing runtime instruction owner.

## Alternatives rejected

### Put the complete websift workflow in APPEND

Rejected because APPEND is always loaded, while websift operation details change with tool schemas and should disappear when the tools are inactive. The attempted `web_fetch` APPEND paragraph also encouraged redundant calls by conflating a selected URL with already-returned content.

### Keep exact parameters in schemas and the operating flow only in skills or documentation

Rejected because ordinary tool use must work without loading a manual skill or retrieving project documentation. Legal fields alone do not teach when to call, how to combine them, how to interpret the result, or when to stop.

### Split one tool's operating flow across several guideline bullets

Rejected because the previous `web_fetch` definition repeated `query_terms`, `context`, `llm_rich`, caching, and locators across its description, snippet, parameter descriptions, and six separate guideline entries. One coherent guideline string preserves the sequence while field descriptions retain exact local contracts.

## Evidence and verification

The installed Pi `ToolDefinition` contract exposes `description`, `promptSnippet`, `promptGuidelines: string[]`, and a TypeBox parameter schema. All nine current registrations expose one non-empty guideline string, and the two commands register once. `tests/registration.test.mjs` protects that stack-wide shape; `tests/web-search.test.mjs` protects successful zero-result receipts and the fixed Serper query/country contract; provider, specialist, fetch, lookup, answer, setup, and doctor suites protect their owning execution boundaries.

Current verification is recorded in `docs/WORK-PLAN.md`; historical provider packets remain evidence for scoped tactics rather than runtime success claims.

## Revisit conditions

Revisit ADR-001.005 if Pi gains a richer structured guidance contract, a representative fresh-agent trajectory shows that one coherent guideline string hides a consequential branch, or a tool's parameter descriptions and operating flow cannot remain non-repetitive without losing cold-start usability. Do not move operation-level guidance back into APPEND merely because one tool definition needs clearer wording; repair the owning definition first.

## History

- 2026-08-04: `alehdezp` rejected the proposed APPEND-level `web_fetch` usage paragraph, clarified that `query_terms` and `context` are normally supplied together on a new call for one-call adaptation, separated that rule from reuse of already-returned content, and extended tool-local guidance ownership to the whole jeito websift stack.
- 2026-08-04: `alehdezp` kept `promptGuidelines` as the Pi-required `string[]` but selected one multiline Markdown string per tool. All eight cards now include a schema-valid advanced example and local recovery/stop behavior; `mini-research` relies on the startup cards, while `$research` owns cross-tool rejection memory, specialist selection, and complex coordination.
- 2026-08-12: `alehdezp` reaffirmed that APPEND owns only evidence routing, active tools own ordinary construction/interpretation/recovery/stop guidance, and research skills own harder cross-source strategy. Serper zero-organic responses became successful scoped outcomes rather than `failureClass:"empty"`.
- 2026-08-12: extended successful-zero semantics to all search specialists and catalog lookup branches, separated malformed provider contracts as `unavailable`, and made specialist recovery operation-aware without adding fallback or removing provider controls.
