---
title: "ADR 5.3 — Typed multi-provider and repeated-provider web_search"
description: "Historical record of the removed typed multi-provider requests[] web_search contract, superseded when provider/method tools replaced duplicate public routes."
tags: [jeito-websift, adr, web-search, multi-provider, batching, schema]
created: 2026-07-28
updated: 2026-08-04
status: stale
adr_id: ADR-005.003
adr_type: child
decision_status: superseded
confidence: evidence-backed
evidence_grade: mixed
implementation_status: superseded
decision_owner: alehdezp
owns: "Historical multi-provider and repeated-provider web_search contract"
audience: contributor
parent: docs/adr/0005-provider-evaluation-and-guidance/README.md
code: [src/tools/web-search.ts, src/types.ts, src/routing.ts::runWithFallback]
related: [docs/adr/0001-product-and-evidence/0002-tool-surface-and-evidence.md, docs/adr/0001-product-and-evidence/0003-core-search-and-provider-specialists.md, docs/adr/0002-internal-architecture/0002-routing-and-failover.md]
---

# ADR 5.3 — Typed multi-provider and repeated-provider web_search


## ADR parent and current state

This micro-decision is historical. On 2026-08-04 `alehdezp` removed the public `requests[]` provider union because it duplicated provider-specific search tools and concentrated unrelated schemas in one shallow interface. [ADR 1.3](../0001-product-and-evidence/0003-core-search-and-provider-specialists.md) now owns the current decision: `web_search` means Serper Search only, and other provider/method searches use explicit lazy tools.

The contract, trajectory evidence, and failure analysis below remain intact to explain why typed routing was once accepted and why it was later removed. None of the fields or execution semantics below describe current public `web_search` behavior.

## Required behavior

One `web_search` call must be able to express:

- one automatic query using current defaults;
- one forced provider with provider-specific typed controls;
- different queries sent to Exa and Tavily in the same call;
- several queries sent to the same provider;
- a bounded mixture of automatic and forced requests;
- one explicit global provider-attempt ceiling covering fallback;
- result provenance back to the originating request.

The current `extraQueries` contract cannot express provider per query and truncates composed plans against a global ceiling. It remains supported during migration but is not the final advanced batch contract.

## Landed schema (Phase 3)

The one-query shorthand is unchanged. The advanced path adds a typed `requests[]` plan behind
the same `web_search` tool. Exactly one of `query` or `requests` is accepted; the
shorthand-only fields (`extraQueries`, `kind`, `depth`, `strategy`, `provider`,
`fallbackOnExplicit`, `recency`, `domains`, `count`, `exa`) cannot be mixed with `requests`,
and `maxProviderCalls` requires `requests`.

```text
web_search({
  query?: string,                 // shorthand path
  ...existing shorthand fields,

  requests?: [                    // advanced typed plan, maxItems 4
    {
      query: string,
      kind?: general|news|academic|code|social,
      depth?: fast|standard|deep,        // owns Exa/Tavily search depth
      count?: 1..20,                     // owns result count
      recency?: {from?, to?},            // exact dates; incompatible with forced Tavily
      domains?: {include?, exclude?},    // owns include/exclude domains
      route:                             // discriminated union; request, route, and option objects are closed
        | {provider: "auto",   fallback?: boolean} // false means one auto-selected provider, no fallback
        | {provider: "exa",    options?: ExaSearchControls,         fallback?: boolean}
        | {provider: "tavily", options?: TavilyPublicSearchOptions, fallback?: boolean}
        | {provider: "linkup", fallback?: boolean}             // no options; general-only; filters rejected pre-call
        | {provider: "xsearch", options?: XSearchPublicOptions, fallback?: boolean} // handle filters only; social-only; kind/depth/domains rejected pre-call
    }
  ],
  maxProviderCalls?: number       // positive integer <= limits.maxFanOut; requires requests
})
```

`ExaSearchControls` reuses the existing typed Exa public controls. `TavilyPublicSearchOptions`
is exactly `{topic?: "finance", timeRange?: year|month|week|day|y|m|w|d, days?: positive}`;
request `depth` maps to Tavily `searchDepth`. Advanced request objects, route objects, and
provider option objects are declared `additionalProperties: false`, so misspelled or
cross-provider keys are schema-invalid rather than silently ignored. Tavily answer/raw-content/images/image-descriptions/
max-tokens/chunks-per-source/timeout controls stay internal: the common `SearchResult[]`
discards their effect, and billing for discarded data is not capability exposure. The `linkup`
route branch was added in Phase 5A (general-only; no options bag; `kind` other than general,
exact recency, and domains rejected pre-call). The `xsearch` route branch was added in Phase 5B (handle filters only; social-only; `kind` other than social, explicit depth, and domains rejected pre-call). The `serper` route branch is deliberately not added yet.

## Execution semantics

- Exactly one of the shorthand `query` path or `requests` path is accepted.
- Request order is retained in `details.requestResults[]` even if calls execute concurrently.
- Repeating a provider is valid; each request is independent.
- Automatic routing may fallback only within the remaining global attempt budget.
- Forced routes do not fallback unless their route explicitly permits it.
- The complete derived plan is validated before the first billable call. A plan above `maxProviderCalls` fails `invalid_input`; it is not silently truncated.
- Advanced requests execute sequentially in Phase 3 (see landed accounting below); concurrency is deferred to a Phase 4 latency measurement.
- Canonical URL deduplication is global, but each retained result records every request index/provider that produced it so agreement is not erased.
- Failure of one independent request does not discard successful sibling results unless cancellation or an invalid/policy failure makes the complete call unsafe.

### Landed execution accounting and fallback (Phase 3)

Advanced requests execute **sequentially** so attempt accounting stays authoritative, request
order is stable, and partial-failure handling needs no concurrency machinery. Whether latency
justifies later concurrency is a Phase 4 measurement, not a Phase 3 assumption.

- The complete plan is validated before the first adapter call: path exclusivity, blank
  queries, unknown providers, provider/option mismatch, Tavily incompatibilities (exact
  recency, `kind:"news"`+`topic:"finance"`), forced `fallback:true` with non-empty options, and
  budget. Any violation fails `invalid_input` with zero adapter calls.
- Worst-case attempts are summed before execution: a forced route without fallback and an
  `auto` route with `fallback:false` are `1`; a forced route with `fallback:true` (no options)
  or normal `auto` route is `config.defaults.maxAttempts`. The plan is rejected if the worst
  case exceeds `min(maxProviderCalls ?? limits.maxFanOut, limits.maxFanOut)`. Actual attempts
  are the `Attempt` rows returned by `runWithFallback` and never exceed the effective ceiling.
- Forced-fallback candidates are filtered through the shared `isEligible` predicate
  (operation, enabled state, credential availability, request capability filters,
  cooldown/session-disable) instead of appending every registered provider. An `auto` route
  selects one eligible provider with bounded normal fallback and does not reproduce shorthand
  `strategy:"compare"` fan-out.
- A fallback-eligible operational failure of one request is recorded and execution continues;
  `aborted`, `invalid_input`, and `policy` abort the whole call. If at least one sibling
  succeeds, the call returns partial success with a `partial_results` warning and explicit
  per-request failure rows; if all fail, the normal failure envelope carries every attempt.

### Landed typed result and contributor contract

```ts
SearchRequestResult {
  requestIndex, query, requestedProvider: "auto"|"exa"|"tavily",
  actualProvider?, status: "ok"|"failed"|"cancelled"|"skipped-budget",
  attempts: Attempt[], resultCount, contributedUrls: string[],
  failureClass?, fallbackOccurred
}
SearchResultContributor { requestIndex, provider }
```

Canonical deduplication is global (`canonicalSearchUrl`): one display `SearchResult` is
retained per canonical URL in first-seen order, and every contributing request index and actual
provider is recorded. Grouped model-visible output retains each request's own returned title
and URL even when its canonical URL matches another provider; it does not misattribute the
first provider's result text to later contributors. When more than one distinct provider
contributes to a retained source, its `Source.provider` is `"multiple"`; the overall
`details.provider` is `"multiple"` when several providers succeed. `details` exposes
`requestResults`, `resultContributors` (canonical/url/contributors), `derivedCalls` (actual
attempt count), and the effective `maxProviderCalls` after the configured default is applied.
The advanced model-visible text groups results per request with requested/actual provider,
status, and duplicate-contributor agreement, so an agent never needs hidden logs to interpret
the comparison. `fallbackOccurred` means an actual fallback inside a request, not an unrelated
sibling failure. The shorthand content and details shape are unchanged.

## Why this shape is provisional but preferred

Verified project facts:

- TypeBox emits nested object and union schemas.
- Current Pi tool contracts already carry nested objects.
- The Exa typed branch reaches the public execution path in focused proof.
- YAML/free-form options would discard schema validation and descriptions.

Still experimental:

- whether target models select the correct discriminated branch reliably;
- whether the complete provider unions cost acceptable schema tokens;
- whether concurrent execution improves latency without confusing attempts or costs;
- whether result grouping is sufficient for agents to compare providers.

Focused schema-use exercises must include tool-call validity and provider-selection accuracy before further schema promotion. If the union performs poorly, the fallback is separate typed request arrays per provider inside `requests`; the fallback is not free-form configuration or a provider tool explosion.

## Compatibility and rollout

1. Preserve the existing one-query shorthand.
2. Add `requests` behind the same `web_search` tool.
3. Exercise Exa+Tavily and repeated-Exa calls in Pi before adding every provider branch.
4. Add provider branches only after their installed contracts are refreshed.
5. Deprecate `extraQueries` only after `$research` and retained sessions have a migration path.

## Alternatives and decisive trade-off

Separate provider tools make agents own composition and fallback. Flat merged fields create conditional ambiguity. YAML or arbitrary provider bags hide accepted keys from the model. A typed request array with discriminated routes expresses different and repeated providers while preserving validation and one attempt budget.

## Evidence and verification

The Exa–Tavily and repeated-Exa `requests[]` contract is implemented and proven by deterministic focused tests: complete budget and provider cross-field validation before any call, auto `fallback:false`, forced-fallback eligibility, accurate aggregate fallback state, partial sibling failure, contributor-preserving dedup with request-owned grouped titles/URLs, request ordering, and the registered TypeBox schema accepting intended shapes while rejecting malformed, unknown, and cross-provider fields. Phase 4 (2026-07-29) confirmed through live model trajectories that grouped output, provenance, billing, failure-handling, and evidence-right behavior are all correctly perceived and interpreted by the target model. Agent usability of the route union is partially validated: the union was constructed correctly on the first attempt in 5 of 9 calling trajectories; a reproducible empty-route construction failure in the remaining cases surfaced an open route-discriminator decision (see Phase 4 section below).


## Phase 4 — agent schema-usability experiment (2026-07-29)

### Environment and baseline

- Baseline commit: `03a553af2e71bc094ed54175d11e4f62d2bcef54`
- Pi version: 0.82.1
- Model: `minimax/minimax-m3` (thinking: medium) — user-directed; the directive originally specified `openai-codex/gpt-5.6-sol`.
- Harness: isolated `PI_CODING_AGENT_DIR` (auth.json + model catalog + stripped settings; no web.yaml); web-provider env vars scrubbed; deterministic fake Exa/Tavily adapters (`credentials:[]`); production `registerWebSearch` + routing + validation + formatting; fresh `--session-id` per trajectory.
- Schema byte size: **9,891 bytes** (original, what the 10 trajectories ran against); **10,371 bytes** (after Constrain corrections).

### Ten-row trajectory table (original schema)

| # | Scenario | First-attempt valid | Outcome | Calls |
|---|---|---|---|---|
| T01 | Ordinary shorthand | N/A (no tool call) | Answered parametrically; did not call `web_search` | 0 |
| T02 | Forced Exa + typed control | ✓ | Shorthand `exa:{searchType:neural}`; prov=exa | 1 |
| T03 | Forced Tavily finance/time | ✓ schema; runtime ✗ | `kind:news` + `topic:finance` rejected; repaired (dropped kind) | 2 |
| T04 | Exa + Tavily one call | ✗ | `route:{}` ×6 → abandoned to two shorthand calls | 11 |
| T05 | Two queries to Exa | ✓ | Two `{provider:exa}` requests, `fallback:true`; executed | 1 |
| T06 | Auto + forced under budget | ✓ | `{provider:auto}` + `{provider:tavily}`, `maxProviderCalls:3`; prov=multiple | 1 |
| T07 | Over-budget rejected | ✗ | `additionalQueries` object-vs-array type error; over-budget rejection fired correctly (attempt 8) | 11 |
| T08 | Sibling failure + success | ✓ | req0 network-fail (fallback attempted), req1 ok; `partial_results` | 1 |
| T09 | Canonical duplicate | ✓ | exa+tavily same query; MULTI-CONTRIB `[0:exa,1:tavily]`; interpretation excellent | 1 |
| T10 | Interpret grouped output | ✓ schema; runtime ✗ | 3×`fallback:true` worst-case 6>4 rejected; repaired (`fallback:false`); interpretation excellent | 2 |

First-attempt schema validity: **7 valid / 2 invalid / 1 no-call** (of 10).

### Hard-gate results

| Gate | Result |
|---|---|
| Billing / attempts ≤ ceiling | PASS — over-budget plans rejected before any adapter call; `maxProviderCalls` respected |
| Provenance / contributor preservation | PASS — MULTI-CONTRIB preserved (T09/T10); request/provider attribution in `requestResults` |
| Failure / sibling-vs-fallback distinction | PASS — correctly identified in T08 and T10 |
| Evidence-right / leads-vs-fetched | PASS — model consistently treated results as leads across all trajectories |
| Grouped output interpretation | PASS — T08/T09/T10 all correct; T09 showed near-perfect canonical-dedup understanding |

### Corrections and reruns (Constrain attempt)

**Correction A (route provider-required description):** Added "Every route MUST set provider…; an empty {} route is invalid" to the `searchRoute` union description. Rerun T04r (corrected schema, 10,371 bytes): still emitted `route:{}` ×5, abandoned to shorthand. Rerun T01b: `route:{}` ×3. **Correction A did NOT fix the construction; failure is reproducible across T04, T01b, T04r.**

**Correction B (news+finance incompatibility note):** Added "Incompatible with kind:'news'…" to the Tavily `topic` description. Rerun T03r (corrected schema): first attempt valid, 1 call. **Correction B worked.**

**Correction C (budget/fallback note):** Added worst-case accounting guidance to `maxProviderCalls` description. Not separately rerun (T10 self-repaired with excellent interpretation); accurate preventive documentation.

All three corrections are retained: B is validated; C is accurate documentation; A accurately states the current contract even though it did not change model behavior.

### Observed failure patterns

1. **Empty `route:{}` for auto (T04, T01b, T04r):** The model emits an empty route object expecting it to mean "auto/default." The schema requires `{provider:'auto'}`. Reproducible; description clarification did not fix it.
2. **`additionalQueries` as object (T07):** Exa option type error (object vs array); model recovered to the intended over-budget rejection.
3. **Undocumented `news+finance` constraint (T03):** Runtime rejection with no schema signal; fixed by Correction B.
4. **Budget exceeded via `fallback:true` (T10):** Worst-case accounting subtlety; model self-repaired and articulated the reasoning.

### Decision: Return-to-user → Proceed (after follow-up)

Constrain was attempted. Correction A (the primary fix for the route-construction failure) plus rerun failed under the same interaction premise, meeting the Replan trigger. Every effective fix — making `provider` optional with default "auto", runtime-coercing `{}`→auto, or defaulting the whole route — changes the public route architecture or validation semantics. Per the decision rule, this was **Return-to-user**.

**Resolution (2026-07-29):** The user approved option (a) — make `provider` optional with default "auto" on the auto branch. The follow-up experiment (10 trajectories, minimax-m3 + gpt-5.6-sol) confirms the fix. The decision gate passes. **Proceed.**

### Evidence limits

- Two models tested (minimax-m3 and gpt-5.6-sol); results are model-relative but consistent across both.
- Deterministic fake adapters: no live provider quality data; comparative quality and rollout remain open (`evidence_grade: mixed`).
- Non-deterministic call counts across runs of the same prompt; the empty-route failure was reliably reproducible before the fix and reliably absent after.
- Over-budget trajectories were exercised by model reasoning (mf-t07) and alternative path (gf-t07); the deterministic test suite covers the rejection path directly.

### Revisit condition

The route-discriminator decision is resolved (option a adopted, gate passed). Revisit when: additional provider branches are added; focused live evidence changes route roles; or a new target model shows construction failures with the current schema.

### Phase 4 follow-up — default-auto route, option (a) (2026-07-29)

**User decision:** Adopt option (a) — the auto branch's `provider` becomes optional. `route:{}` is valid and means `{provider:'auto'}`. Exa and Tavily branches still require their explicit provider discriminators. The whole route remains required. No runtime-only silent coercion outside the public schema. Closed-object validation is not weakened. Provider-specific options are not allowed on the auto branch.

**Exact landed schema change:**

```text
// TypeBox auto branch (was: provider: Type.Literal("auto"))
provider: Type.Optional(Type.Literal("auto"))

// TypeScript SearchRoute (was: { provider: "auto"; fallback?: boolean })
| { provider?: "auto"; fallback?: boolean }
```

Normalization: one `routeProvider(route)` helper returns `route.provider ?? "auto"` and is used at every site that reads the provider (intent construction, validation, attempt accounting, `requestResults.requestedProvider`, output, error details). `requestedProvider` is always `"auto"|"exa"|"tavily"`, never `undefined`.

**Corrective trajectories — minimax/minimax-m3 (medium):**

| # | Scenario | First-attempt valid | Outcome | Calls |
|---|---|---|---|---|
| mf-t01 | Ordinary shorthand | ✓ | Shorthand `{query,count}`; prov=exa | 1 |
| mf-t02 | Advanced Exa neural | ✓ | `{provider:"exa", options:{searchType:"neural"}}`; prov=exa | 1 |
| mf-t04 | Exa + Tavily one call | ✓ | Explicit exa+tavily routes, `fallback:false`; prov=multiple | 1 |
| mf-t07 | Over-budget (simple auto) | N/A (no call) | Model reasoned about budget violation pre-flight and declined | 0 |
| mf-auto | Direct `route:{}` | ✓ | `route:{}` → `requestedProvider="auto"`, `actualProvider="exa"` | 1 |

**Corrective trajectories — openai-codex/gpt-5.6-sol (medium):**

| # | Scenario | First-attempt valid | Outcome | Calls |
|---|---|---|---|---|
| gf-t01 | Ordinary shorthand | ✓ | requests[] with auto routes; prov=exa | 3 |
| gf-t02 | Advanced Exa neural | ✓ | `{provider:"exa", options:{searchType:"neural"}}`; prov=exa | 1 |
| gf-t04 | Exa + Tavily | ✓ | Explicit exa+tavily routes, `fallback:false`; prov=multiple | 1 |
| gf-auto | Direct `route:{}` | ✓ | `route:{}` → `requestedProvider="auto"`, `actualProvider="exa"` | 1 |
| gf-t07 | Over-budget (simple auto) | ✓ | Used shorthand extraQueries (alternative path); prov=exa | 1 |

**Key result:** The empty `route:{}` failure that caused the original T04 to fail with 11 calls is now fixed. Both models construct explicit exa/tavily routes correctly on the first attempt (mf-t04, gf-t04), AND `route:{}` works as default-auto (mf-auto, gf-auto). The original T04 failure is resolved.

**Decision gate: PROCEED.** All criteria met:
- `route:{}` is schema-valid and executes as auto ✓
- `requestedProvider` is always `"auto"|"exa"|"tavily"` ✓
- Both models construct required advanced routes without a repeated same-premise failure ✓
- Shorthand and over-budget trajectories are genuinely exercised ✓
- All billing/provenance/evidence gates remain green ✓

**Distinction from original Phase 4 evidence:** The original Phase 4 (10 trajectories, minimax-m3 only) identified the empty-route failure and returned to the user. The follow-up (10 trajectories, minimax-m3 + gpt-5.6-sol) validates the fix. The original evidence is retained as historical context; the follow-up evidence is the basis for the Proceed decision.

## Phase 5A — Linkup route and schema-usability (2026-07-29)

**Landed Linkup search route.** A typed `linkup` branch was added to the `requests[].route` union: `{provider:"linkup", fallback?:boolean}` with `additionalProperties:false` and **no options bag**. Common request fields own the contract — `query`→`q`, `depth`→`depth` (fast/standard/deep), `count`→`maxResults`. Linkup has no grounded exact-date, domain, academic, code, news, or social filtering contract, so a forced Linkup route carrying `kind` other than `general`, exact `recency`, or `domains` is rejected `invalid_input` before any call. Fallback is allowed because, with those semantics rejected, every remaining field is common and an eligible fallback provider can honor it. The `routeProvider()` normalization, worst-case accounting, and grouped output/provenance already handle the new provider without further change. No comparative quality or routing-priority claim is made; those remain apprenticeship-owned ([ADR 5.4](0004-benchmark-and-selection.md)).

**Schema-usability result (gpt-5.6-sol, medium, deterministic fake Linkup adapter).** One fresh foreground trajectory per public surface; no live Linkup call; `git status --short -- extensions/websift` verified identical before/after each.

| Surface | First-attempt args | Schema-valid | Route / branch | Observed |
|---|---|---|---|---|
| `web_search` advanced | `{requests:[{query:"quantum error correction surface codes", depth:"deep", count:10, route:{provider:"linkup", fallback:false}}], maxProviderCalls:1}` | ✓ (`Check`) | `linkup`, depth deep | requestedProvider=actualProvider=linkup; 3 leads; model reported "lead-only … need fetching before cited" |
| `web_fetch` branch | `{url:"https://spa-example.example.org/dashboard", mode:"page", extract:"markdown", linkup:{renderJs:true}}` | ✓ (`Check`) | `linkup:{renderJs:true}` | provider=linkup; markdown returned; model chose renderJs:true for a client-rendered SPA and called it "fetched evidence" |

Both first attempts were schema-valid (confirmed by `Check()` against the captured production schemas) and executed with correct provider attribution and evidence-status interpretation.

**Confidence stays bounded.** This is one target model (gpt-5.6-sol) against a deterministic fake adapter, proving schema constructibility and evidence framing — not live Linkup behavior or comparative quality. `evidence_grade` remains `mixed`; Linkup quality/latency/role await focused apprenticeship.
**2026-08-01 current-contract supersession.** Current official Linkup Search now grounds `fromDate`/`toDate`, `includeDomains`, and `excludeDomains`. The public route maps common `recency` and `domains` controls accordingly while still rejecting non-general `kind` and provider-specific options. The 2026-07-29 paragraph above remains the historical Phase 5A record, not current call guidance; [`../../upstreams/linkup.md`](../../upstreams/linkup.md) owns the refreshed source and live evidence.

## Phase 5B — X/xsearch route and schema-usability (2026-07-29)

**Landed X search route.** A typed `xsearch` branch was added to the `requests[].route` union: `{provider:"xsearch", options?:XSearchPublicOptions, fallback?:boolean}` with `additionalProperties:false`. `XSearchPublicOptions` is exactly `{allowedHandles?:string[], excludedHandles?:string[]}` (each max 10) — only the handle filters are exposed, mapped internally to xAI's snake_case `allowed_x_handles`/`excluded_x_handles`. A forced xsearch route implies social intent: `kind` may be omitted or `"social"` (other kinds rejected), explicit `depth` is rejected (xAI `x_search` has no grounded fast/standard/deep contract), and `domains` are rejected (no grounded domain filter). Handles are mutually exclusive, trimmed/`@`-stripped with a **visible structured warning** surfaced on the request's grouped output, and dates are calendar-validated (`YYYY-MM-DD`, real days, `from<=to`). `model` and image/video understanding flags are implemented internally but withheld from the public surface (internal-comparison; see ADR 5.2). `fallback:true` with non-empty handle options is rejected before execution because no fallback provider can preserve handle semantics. Synthesized text is a lead-only snippet; citation URLs are social leads; raw posts are never claimed. No comparative quality or routing-priority claim is made; those remain apprenticeship-owned ([ADR 5.4](0004-benchmark-and-selection.md)).

**Schema-usability result (gpt-5.6-sol, medium, deterministic fake xsearch adapter).** Two fresh foreground trajectories; no live xAI call; `git status --short -- extensions/websift` verified identical before/after.

| Trajectory | First-attempt args (abbreviated) | Schema-valid | Observed |
|---|---|---|---|
| Natural prompt (`@` handles in prose) | `{requests:[{query, kind:"social", recency:{from:"2026-03-01",to:"2026-03-31"}, count:10, route:{provider:"xsearch", options:{allowedHandles:["openai","anthropic"]}, fallback:false}}], maxProviderCalls:1}` | ✓ (`Check`) | requestedProvider=actualProvider=xsearch; 1 attempt; 3 leads; model pre-stripped `@` before calling so no warning fired; model flagged the off-filter `@example` lead as suspect and reported "leads only … must be fetched and verified before cited" |
| Verbatim-`@` prompt (asked to pass `@` through) | same shape with `allowedHandles:["@openai","@anthropic"]` | ✓ (`Check`) | visible warning fired in grouped output: `warning: xAI allowedHandles: normalized "@openai" to "openai" …` (and `@anthropic`); recorded in `requestResults[0].warnings`; social kind, exact dates, single attempt |

Both first attempts were schema-valid (confirmed by `Check()` against the captured production schema) and executed with correct provider attribution and lead-only interpretation. Together the trajectories show the model both pre-normalizes handles (the common case) and, when asked to pass `@` verbatim, triggers the visible normalization warning — the warning is a safety net for the latter and is deterministically proven by the focused tests for the former.

**Confidence stays bounded.** This is one target model (gpt-5.6-sol) against a deterministic fake adapter, proving schema constructibility, the handle-normalization warning, and evidence framing — not live xAI behavior or comparative quality. `evidence_grade` remains `mixed`; X quality/latency/role await focused apprenticeship.

**2026-08-01 current-contract and output supersession.** The current official maximum is 20 handles, so the existing public fields now accept 20. Focused live calls confirmed exact-date/handle behavior but also showed 10–14 provider-internal X searches inside one Responses request. Advanced output now shows one bounded synthesis plus model/token/tool-call usage before citation URLs; citation-free no-winner synthesis survives in the error. The 2026-07-29 max-10 and fake-output paragraphs remain historical evidence, not current call guidance. See [`../../upstreams/xsearch.md`](../../upstreams/xsearch.md).

## History

- 2026-07-28: Preserved the existing decision while moving it into the numbered master/child ADR hierarchy.
- 2026-07-29: Phase 3 landed the auto/Exa/Tavily discriminated route union with closed request/route/option objects, pre-call worst-case and cross-field validation, sequential execution, partial sibling results, accurate fallback metadata, and global canonical dedup with contributor provenance plus request-owned grouped output. `implementation_status` → `implemented`; agent usability remains Phase 4.
- 2026-07-29: Phase 4 experiment (minimax/minimax-m3, baseline 03a553af): billing/provenance/failure/evidence/grouped-output gates all pass. Route union correctly constructed on first attempt in 5 of 9 calling trajectories; empty `route:{}` failure reproducible in T04/T01b/T04r despite description correction. Constrain attempted → Replan trigger met → Return-to-user: route-discriminator decision (make `provider` optional/default vs. keep strict) requires user approval. Three description corrections committed: news+finance note validated; budget note accurate documentation; route-required note accurate but did not fix construction. `confidence` → `evidence-backed`; `implementation_status` stays `implemented` pending route-discriminator resolution. See `docs/PHASE4-TESTING-LEARNINGS.md` for harness and testing guidance.
- 2026-07-29: Phase 4 follow-up (option a: default-auto route, baseline 5b1639cc): auto branch `provider` made optional; `route:{}` valid as `{provider:"auto"}`; one `routeProvider()` normalization helper. Corrective experiment (minimax-m3 + gpt-5.6-sol, 10 trajectories): all decision gates pass; empty-route failure resolved; both models construct explicit exa/tavily routes and `route:{}` correctly on first attempt. `implementation_status` → `validated`. See `docs/PHASE4-TESTING-LEARNINGS.md`.
- 2026-07-29: Phase 5A landed the typed `linkup` search route (`{provider:"linkup", fallback?}`, no options; general-only; kind/recency/domains rejected pre-call) and the `web_fetch` `linkup:{renderJs}` branch. gpt-5.6-sol schema-usability trajectories for both surfaces were first-attempt schema-valid with correct provider attribution and lead/fetched interpretation. Linkup confidence stays bounded by single-model deterministic-fake evidence; quality remains apprenticeship-owned.
- 2026-07-29: Phase 5B landed the typed `xsearch` search route (`{provider:"xsearch", options?:{allowedHandles?,excludedHandles?}, fallback?}`; social-only; kind/depth/domains rejected pre-call; handles max 10, mutually exclusive, normalized with a visible warning; dates calendar-validated; model/media internal-comparison). Two gpt-5.6-sol schema-usability trajectories were first-attempt schema-valid with correct provider attribution and lead-only interpretation; the verbatim-`@` trajectory fired the visible normalization warning. X confidence stays bounded by single-model deterministic-fake evidence; quality remains apprenticeship-owned.
- 2026-07-31: narrowed “validated” to contract mechanics and fake-adapter schema constructability; comparative quality, final advanced grouping, and rollout remain apprenticeship/user-pending.
