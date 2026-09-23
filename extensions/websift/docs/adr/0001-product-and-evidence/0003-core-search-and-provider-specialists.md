---
title: "ADR 1.3 — Explicit provider/method search and answer tools"
description: "Defines Serper-only search, provisional Exa orientation, explicit provider/method specialists, lazy exposure, one-attempt dispatch, and evidence-based diversity retention."
tags: [jeito-websift, adr, public-tools, core-search, provider-specialists, prompt-guidelines]
created: 2026-08-01
updated: 2026-08-11
status: active
adr_id: ADR-001.003
adr_type: child
decision_status: accepted
confidence: user-stated
evidence_grade: mixed
implementation_status: completed
decision_owner: alehdezp
owns: "Provider/method tool decomposition, naming exceptions, one-attempt dispatch, answer-provider evidence gates, and diversity-preserving retention"
audience: mixed
parent: docs/adr/0001-product-and-evidence/README.md
code: [index.ts, src/gcf.ts::encodeGcfRecords, src/tools/web-search.ts::registerWebSearch, src/tools/web-answer.ts::registerWebAnswer, src/tools/web-search-specialists.ts::registerWebSearchSpecialists, src/tools/web-answer-specialists.ts::registerWebAnswerSpecialists]
related: [docs/adr/0001-product-and-evidence/0002-tool-surface-and-evidence.md, docs/adr/0005-provider-evaluation-and-guidance/0005-guidance-lifecycle.md, docs/ROADMAP.md]
---

# ADR 1.3 — Explicit provider/method search and answer tools

## ADR parent and current state

`alehdezp` replaced common cross-provider routing with one explicit method per tool. `web_search` is the startup naming exception for one Serper Search attempt; `web_answer` is the startup naming exception for one provisional Exa Answer attempt. Lazy specialists retain Exa/X/Tavily Search plus Exa/Linkup Answer controls. W12 removed public `web_search_linkup` after its Search method failed the distinctive-value gate.

## Decision

### Current decision frontier

- `web_search` performs one Serper/Google lexical Search attempt with no fallback. Its public schema is `query` (`q`/`term` aliases) plus optional `country`, with 10 fixed leads. Equal alias duplicates normalize visibly; conflicts fail before dispatch. Raw country reaches the Serper adapter, which owns validation and normalization receipts.
- `web_answer` performs one provisional Exa Answer attempt with no fallback or provider selector. Retained lazy answer specialists are `web_answer_exa` and `web_answer_linkup`; `$mini-research` owns W1/W2 verification and `$research` owns adaptive W3/W4 investigation.
- Provider diversity is not a leaderboard or automatic fallback. `$research` selects another method only after naming the different source class, language/region, chronology, social provenance, semantic neighborhood, or provider error it could expose.
- A provider/method tool survives only when mastered matched calls demonstrate distinctive decision-changing evidence, a unique source class, or reproduced constraint/cost value. A parameter survives only when it changes accepted evidence or materially reduces error/context/cost; provider acceptance alone is insufficient.
- GCF generic-profile text remains the model-visible serialization for structured provider results. Keep provider-native JSON internally and do not project away material fields merely to make methods look alike.
- Every public tool owns current `description`, parameter descriptions, `promptSnippet`, and one coherent `promptGuidelines` string. Constrained cards state task-shaped evidence and cannot claim broad quality.
- Near-valid calls normalize only losslessly inside the owning provider method. No normalization may choose another provider, add a billable call, weaken evidence/security, or discard conflicting fields.

### Capability accounting before naming or splitting wrappers

Before another public wrapper lands, map every reviewed provider operation across:

- search, answer/synthesis, fetch/extract, map/crawl, research, structured output, media/social, locale/language, freshness, domain/source filters, and provider-reported cost/usage;
- request schema, response shape, evidence right, latency/cost, cancellation, fallback safety, and lifecycle;
- advanced-research scenarios: latest general facts, AI releases and tools, academic/code provenance, guidelines and optimization, best practices, news, multilingual social evidence, and Chinese platforms/sources;
- keep, combine, split, internal-only, or discard—with the exact reason and evidence limit.

The comparison rejects catch-all provider tools, provider discriminators inside common schemas, and cross-provider `web_answer` fallback. The startup answer exception is one fixed Exa orientation method; provider-native controls remain separate because schemas, evidence rights, costs, and failure modes differ.

### Provider-wrapper naming and activation rule

`index.ts` registers `web_answer` as the startup Exa orientation exception plus `web_search_exa`, `web_search_x`, `web_search_tavily`, `web_answer_exa`, and `web_answer_linkup` as explicit one-provider/no-fallback methods. Aggregate `config/tool.yaml` keeps four startup tools visible and five specialists lazy; the separately registered `context7` library-doc tool is also lazy. Standalone policy may expose all ten registered websift tools. Registration performs no provider call.

### Tool-local teaching through Pi

Every public tool uses Pi's native prompt metadata:

- `description` states the operation and evidence contract;
- `promptSnippet` gives the one-line selection cue;
- `promptGuidelines` carries dense active-only guidance naming the tool, use/avoid conditions, consequential interactions, evidence rights, grounded cost/latency, and nearby-valid-call recovery;
- parameter descriptions explain exact field semantics and incompatibilities.

This prompt surface is justified because Pi includes specialist guidelines only while the tool is active. Provider manuals and cross-call research procedure remain in the shared research references.

### GCF model-visible structured output

All websift adapters may keep and validate provider-native JSON internally. Before a structured provider result crosses the model-visible `content.text` boundary, encode the complete model-relevant JSON value with the official GCF generic codec. Pi `details` retains native JSON for programmatic inspection; GCF changes representation, not semantics, evidence rights, provider attribution, cost, or retention.

This applies to structured search rows, catalog/lookup records, maps/manifests, structured answer/research results, usage envelopes that are intentionally model-visible, and future provider specialists. Plain fetched Markdown/raw page bodies and native answer prose are already text rather than provider JSON; they remain text and may sit beside a GCF metadata block when needed.

Do not project away provider-native fields merely to make providers look alike. Omit a field only for a named secret, safety, evidence, or bounded-output reason. Truncation occurs at complete record boundaries with declared total/omission state; never slice a GCF record mid-row. GCF encoding failure is an explicit serialization failure rather than a silent switch to model-visible JSON.

Provider-side JSON Schema remains useful but is a separate concern: Exa Search/Answer/Agent, Linkup structured Search/Research, Tavily Research, and supported xAI structured outputs can generate JSON which jeito validates internally and then encodes as GCF for agent consumption.

### Historical implementation checkpoint — superseded 2026-08-04

The GCF representation decision is implemented without changing provider routing or evidence rights. `src/gcf.ts::encodeGcfRecords` uses pinned official `@blackwell-systems/gcf` `2.4.0`; `src/output.ts` emits search and advanced-search structures, `src/tools/web-lookup.ts` emits catalog and Context7 JSON structures, and `src/tools/web-fetch.ts` emits structured JSON pages, retained JSON, site-map rows, and crawl manifests. Native Markdown/raw bodies and current answer prose remain text. Repeated xAI synthesis is represented once as a complete record rather than duplicated per citation; if the output budget cannot hold it, the whole synthesis record is omitted after citation rows and the GCF document declares the omission.

Provider citation rights are now explicit in the current answer path: Exa and Linkup citation passages use `provider-citation` with `fetched:false`; only content retrieved through jeito's fetch path uses `fetched`. Model-visible source labels use that evidence state rather than collapsing every unfetched citation to `lead`.

The former `requests[].route` normalization belonged to the removed common multi-provider search surface. Since 2026-08-04, `web_search` is Serper-only and each specialist is a separate one-provider/no-fallback tool; the current decision frontier above governs runtime behavior.

### Completed answer-provider evidence gate

The recorded provider-native answer program completed in 2026-08-03 and informed the explicit Exa/Linkup specialists. Later live evidence showed generic verify/research prose could cite identities absent from its displayed fetched sources. The owner therefore retained generic `web_answer` only as one provisional Exa orientation attempt and assigned verification/investigation to `$mini-research`/`$research`.

Provider specialists remain lead/candidate tools: their structured or sourced answers require fetched primary closure before a material claim is established. No provider inherits verification authority from its tool name, structured shape, or citation count.

### Answer evidence checkpoint — 2026-08-03

The required evidence program records 14 retained plus 36 new provider-query executions with zero retry/fallback. Exa Answer/Deep Search, Linkup sourced/structured Search, Tavily `includeAnswer`, Serper lexical candidates, and retained xAI synthesis all produced reviewable behavior; four new calls failed and remain failed. Conservative cumulative live-provider reserve is `$3.659/$5.00`.

The packet closes execution inventory, not causal comparison. T08's schema allowed four rows for five requested prices; T04 mixed provider input rejection with answer behavior; T12 lacked a matched Tavily cell and lost Exa Answer; and first-two citation fetches established transport rather than claim support. Credential-free official reads resolve the highest-impact xAI alias, strict-schema, pricing, and CompSelect-method disputes without further provider spend. JSON Schema constrained outer shape but not semantic correctness or evidence authority; deep modes did not reliably repair errors; source volume did not predict quality. GCF remains the codec; the owner-selected boundary below now governs which answer records cross the model-visible budget without selecting an answer provider or tool shape.

No additional paid call is justified before owner review. Focused recovery now rejects equal or reversed Tavily and Linkup exact-date bounds as `invalid_input` before provider spend; Linkup's current endpoint reference explicitly requires `fromDate` to be before `toDate`, isolating the packet's T04 HTTP 400 without another live call. No common answer schema, provider specialist, universal winner, default, or discard decision follows automatically. With error/recovery taxonomy and model-visible answer-output responsibility closed for the observed packet failures, the next owner frontier is public answer shape, then scenario-specific provider retention.

### Answer model-visible output boundary — accepted and implemented 2026-08-03

Native provider controls reduce avoidable bulk before terminal GCF budgeting. Exa Answer defaults to `text:false`: the evidence packet retained eight citation records in both modes while `text:true` responses expanded to roughly 66–223K characters and representative `text:false` responses stayed around 1.9–2.7K. Linkup sourced answers default to inline citations so the answer keeps provider-native citation markers; jeito does not infer a stronger claim-to-source mapping than the provider exposes.

Every answer GCF envelope reserves a compact `sourceIndex` containing every provider-ordered title, URL, evidence status, and provider before budgeting answer data or passage records. Structured answer data remains the first record; prose remains text beside the GCF appendix. Full passage records are never sliced and may be omitted whole, but their identities cannot disappear silently. If the complete identity index itself cannot fit, output fails honestly.

Answer details retain the full normalized answer, full source list, structured data, and complete native provider result. Model-visible `sourceIndex` makes omitted passage records inspectable without pretending provider citations are fetched or every passage is equally relevant.

### Specialist contracts implemented; activation and broad guidance deferred

`web_answer_exa` and `web_answer_linkup` expose one provider-native sourced-answer schema apiece. Neither contains verification, adaptive research, hidden fallback, another provider route, or jeito-authored search→fetch orchestration. `web_search_exa` exposes the accepted Exa retrieval controls without Search `outputSchema`; `web_search_x` exposes handle/date and bounded work/image controls while keeping model/video controls internal. Tavily `includeAnswer`, xAI synthesis, and Serper candidates keep their existing evidence boundaries.

W2 deterministic proof and one cold-model trajectory establish schema construction, one-attempt routing, GCF representation, evidence rights, and cost/work metadata only. W3 must still learn scenario-bound recipes and anti-recipes against fetched primary sources before activation. Broad claims such as “best,” “mastered,” or “preferred” remain invalid outside named exercised scenarios.

### Answer source posture — accepted 2026-08-03

`web_answer`, `web_answer_exa`, and `web_answer_linkup` use **identity-complete, passage-bounded** output: every source title/URL/evidence status/provider appears in GCF `sourceIndex`; answer data/prose then receives priority; full provider passage records use the remaining budget with `totalRecords`, `shownRecords`, and `omittedRecords` declared. Complete native results stay in `details`, and provider passages remain `provider-citation` until fetched.

Linkup structured Search remains a separate internal operation and is not mixed into sourced Answer. This decision does not activate either specialist, select a provider, authorize broad guidance, or reopen the GCF choice.

### Provider disposition from current contracts and focused calls

| Provider | Current public state | Investigation boundary |
|---|---|---|
| Serper | common `web_search` | teach the full generally available query/vertical schema; treat answerBox/knowledgeGraph as lead-only |
| Tavily | lazy `web_search_tavily`, plus accepted internal `web_fetch` escalation | compare immediate answer/research operations before selecting any additional public exposure |
| Exa | startup `web_answer`; lazy `web_search_exa` and `web_answer_exa` | generic answer is provisional prose only; structured candidate questions stay specialist-owned |
| Linkup | public `web_answer_linkup` | sourced Answer retains date/domain/depth controls; fetched metadata closes date/absence claims |
| xAI X | public `web_search_x` | date/handle/work/image controls do not make synthesis verified evidence |
| Context7 | dedicated lazy `context7`; SkillsMP / Pi packages use `web_lookup` | preserve catalog/version semantics and expose structured records as GCF |
| Native | default `web_fetch` plus GitHub/PDF/YouTube locator specialties | fetched prose remains prose; structured maps/manifests use GCF |

The current portfolio still lacks first-hand Weibo, WeChat public-account, RedNote, Douyin, and Bilibili social search. Locale-enabled websift search and Chinese-page fetch do not close that gap.

## Why the prior specialist attempt was rejected

The name `exa_search` and its flat search-only schema were locally workable but answered the wrong question. They assumed operation-specific provider tools before establishing whether a coherent `web_exa` wrapper could preserve search, answer, and structured outputs. They also preceded the required cross-provider capability/diversity review. The implementation was removed before activation rather than patched downstream.

## Alternatives and decisive trade-off

- **One universal normalized provider implementation:** rejected because it erases provider-native output, structured formats, operation cost, and evidence rights.
- **One catch-all wrapper per provider:** rejected for current Exa and Linkup because Search/Answer/Contents/Research combine different schemas and synchronous/asynchronous lifecycles.
- **Provider/method specialist tools:** selected as explicit one-provider/no-fallback interfaces; Exa/X Search and Exa/Linkup Answer retain scoped mastered recipes, while Tavily/Linkup Search remain provisional pending W12 retention evidence.
- **Cross-provider common `web_answer`:** rejected because provider selection/fallback has no generic authority. One fixed Exa orientation attempt remains startup-visible; verification/research stay skill-owned.
- **Diversity-preserving provider portfolio:** retained. Only deprecated Exa Similar is currently discarded on both contract and observed-value grounds.

## Evidence and verification

Current source and official provider contracts establish the operation inventory. The prior apprenticeship and W10/W11 mastery packets support scoped Exa/X/Linkup Answer recipes but do not justify a shared routing schema or broad provider ranking.

The owner identified live capability duplication: common `web_search` exposed Exa, Tavily, Linkup, X, and Serper while provider specialists repeated the same methods. The smallest coherent seam is now one provider/method per tool. The superseded ADR 5.3 contract and its deterministic tests remain history; they no longer define runtime behavior.

Current deterministic proof passes package typecheck and the complete 263/263 websift suite. Focused answer tests prove the generic tool exposes only question aliases, makes one Exa attempt, never calls Linkup on failure, and labels prose provisional. Search tests prove fake-limit removal, conflict-safe aliases, raw-country adapter ownership, fixed 10 leads, and no fallback. Registration still contains nine unique tools; retained specialists force one named provider without fallback.

## Revisit conditions

Revisit when an accepted specialist duplicates default search, when a proposed simplification cannot preserve a current advanced research guarantee, or when focused evidence shows a retained control adds no useful distinction.

## History

- 2026-08-01: Reopened the four-tool-only premise after advanced unified search produced repeated first-contact construction failures; provider wrappers and tool-local guidance became the candidate direction.
- 2026-08-02: rejected the provisional `exa_search` name and premature search-only split before activation. Reopened provider-wrapper naming, common-versus-provider answer placement, native JSON/CFG structured output, and diversity-preserving scenario selection.
- 2026-08-02: current contract review and nine provider-native answer calls produced the recommendation: common Serper/Tavily search; lazy `web_exa_search`, `web_linkup_search`, and `web_x_search`; one simple typed `web_answer` for Exa/Linkup/Tavily; provider citation rights distinct from fetched evidence; JSON Schema provider output kept separate from Pi tool-input CFG.
- 2026-08-03: owner accepted bounded source-bearing GCF as the default answer source posture for the later-renamed `web_answer_exa` and `web_answer_linkup`. The acceptance settled posture only; specialists remained inactive and advanced guidance stayed deferred.
- 2026-08-03: owner correction superseded the common-`web_answer` recommendation. GCF is settled for all model-visible structured provider JSON while native JSON remains internal; answer grouping waits for provider-by-provider schema teaching and roughly fifty difficult-query observations; near-valid calls must execute after unambiguous visible normalization, including missing advanced-search routes defaulting to one auto provider with no fallback.
- 2026-08-03: implemented the pinned GCF output boundary and missing-route normalization across the current public tools without changing provider roles, routing priorities, or the unresolved answer-provider frontier.
- 2026-08-03: completed and reviewed the 50-record provider-native answer evidence inventory. Packet defects prevent automatic consolidation or ranking; credential-free official reads resolved high-impact contract disputes, no further paid call is justified before owner review, and the ordered frontier became error recovery, model-relevant GCF output responsibility, answer shape, then scenario retention.
- 2026-08-03: owner accepted and implementation proved the answer-output boundary: native controls reduce avoidable source bulk first; structured answers precede provider-ordered source records in GCF; prose stays text beside a GCF source appendix; complete native results remain in details; visible total/shown/omitted state replaces raw string slicing. Provider and public-shape selection remain open.
- 2026-08-03: current Linkup `/search` authority isolated the packet's T04 HTTP 400: `fromDate` must be earlier than `toDate`. Equal/reversed Tavily and Linkup bounds now fail locally as `invalid_input`; this closes the observed request-recovery gap without another paid call and moves the frontier to public answer shape.
- 2026-08-03: owner selected lazy provider-specific Exa and Linkup answer tools and rejected one cross-provider `web_answer`, while explicitly deferring implementation, activation, provider retention guidance, and advanced instructions until coordinator-led apprenticeship demonstrated scoped competence. The final `web_answer_exa` and `web_answer_linkup` names were accepted on 2026-08-04.
- 2026-08-04: owner accepted the amended four-tool schema with answer names `web_answer_exa` and `web_answer_linkup`. W2 implemented all four as dormant registration functions; focused deterministic proof, package typecheck, the 291-test suite, and one cold-model call-construction trajectory pass. `index.ts` remains unchanged, so activation and W3 guidance are still open.
- 2026-08-04: after W3 scenario evidence and W4 first-use guidance passed, `alehdezp` activated all four specialists. `index.ts` now registers eight unique tools; aggregate startup policy keeps the everyday four upfront and specialists lazy-discoverable.
- 2026-08-04: owner removed the duplicate common multi-provider search lane. `web_search` became Serper-only under an explicit naming exception; provisional `web_search_tavily` and `web_search_linkup` joined retained `web_search_exa` and `web_search_x` for W12 retention testing.
- 2026-08-05: W12 ran 30 matched Serper/Tavily/Linkup Search cells plus direct primary adjudication. Serper retained only query/country with fixed 10 leads; Tavily was constrained to basic/general query/full-name-country; public Linkup Search was removed while Linkup Answer/fetch/internal operations stayed. Independent DeepSeek/Qwen reviews passed the evidence and decision boundary.
- 2026-08-10: owner retained startup `web_answer` only as one provisional Exa orientation attempt and removed generic verify/research, fetched-evidence budgeting, and provider routing after a live verify result cited six identities while displaying one fetched source. `$mini-research`/`$research` now own verification/investigation; all answer tools reserve every source identity in model-visible `sourceIndex` before budgeting answer/passages.
- 2026-08-10: removed the fake `limit` sentinel, made query-alias conflicts fail before dispatch while preserving equal duplicates, and moved raw country validation/normalization receipts solely to the Serper adapter.
