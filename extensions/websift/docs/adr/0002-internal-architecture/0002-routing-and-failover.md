---
title: "ADR 2.2 — Deterministic routing and bounded visible fallback"
description: "Records operation/mode-aware provider selection, failure classification and recovery, explicit-provider behavior, visible attempt accounting, and the prohibition on hidden billable retries."
tags: [jeito-websift, adr, routing, failover, billing, failure-classification]
created: 2026-07-28
updated: 2026-08-07
status: active
adr_id: ADR-002.002
adr_type: child
decision_status: accepted
confidence: confirmed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Provider selection, failure classification, and fallback policy"
audience: contributor
parent: docs/adr/0002-internal-architecture/README.md
code: [src/types.ts::FailureClass, src/routing.ts::selectProviders, src/routing.ts::preferFetchProvider, src/routing.ts::runWithFallback, src/failures.ts::classifyHttpFailure, src/failures.ts::mapFetchFailure, src/failures.ts::recoveryAdvice, src/failures.ts::mayFallback]
related: [docs/adr/0001-product-and-evidence/0002-tool-surface-and-evidence.md, docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md]
---

# ADR 2.2 — Deterministic routing and bounded visible fallback


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-002 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: confirmed`, `evidence_grade: verified`, and `implementation_status: validated`. The metadata—not optimistic prose—governs whether dependent work may treat the decision as proved.

## Decision

Selection is deterministic code over capability metadata plus one accepted, evidence-dated URL preference table for known-URL fetch — **not** natural-language or topic regex classification. The model expresses `kind`/`depth`/`provider`; code owns availability, exact fetch-host preference, cost, failure class, circuit-breaking, and bounded fallback. Auto mode is the default; explicit provider choice is always honored.

## Auto selection (`src/routing.ts::selectProviders`)

Given an intent, build the candidate set in this order:

1. **Operation** — adapters whose `operations` include the intent.
2. **Mode/filter capability** — fetch modes must appear in `capability.modes`; search kinds and filters must appear in their capability metadata. A page-only adapter is never attempted for `site` or `map`.
3. **Credentials present** — drop adapters whose credential cannot be resolved (see [`0006`](0004-config-and-credentials.md)).
4. **Priority policy** — apply the configured order ([`0003`](../0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md)).
5. **Accepted fetch preference** — for page URLs matching the 2026-08-02 table below, move an eligible Tavily adapter to the front. Native remains first everywhere else.

Then run **first-fit**: try the top candidate; fall back only on an eligible failure class (below). Never fan out implicitly.

### Tavily-preferred known-URL research families

`src/routing.ts` holds exact host/path rules for OpenAI News/Index, Anthropic News, Hugging Face Papers, TechCrunch, LinkedIn company posts, Juejin, 36Kr, YourStory, WSJ AI, Ars AI, GitHub Trending, Bloomberg Technology, Bilibili home/AI lists, Inc42 root, and Economic Times Technology. These routes came from the fixed 37-source comparison and explicit `alehdezp` acceptance. Path-specific rules prevent the table from taking PDFs, videos, code, or unrelated pages away from stronger Native handlers. Tavily must still be enabled and credentialed; otherwise ordinary candidate selection continues without it.

## Explicit provider

If `provider` is set, that adapter is used exactly. **No auto-fallback** unless
`fallbackOnExplicit:true`. A failure on an explicit provider is returned as-is.
This guarantees "choosing the provider is always the agent's option."

## Loud failure classes (`src/failures.ts::classifyHttpFailure` and `mapFetchFailure`)

Adapters fail *loudly*: a structurally changed or empty response is classified,
not silently returned as garbage. This is what makes the lightweight maintenance
model valid — a break announces itself.

```ts
type FailureClass =
  | "unavailable"        // provider down / not installed
  | "missing_credential" // credential not resolvable
  | "auth"               // 401/403 bad key
  | "rate_limited"       // 429
  | "timeout"            // exceeded timeoutMs / AbortError-from-timeout
  | "network"            // transient 5xx / connection error
  | "empty"              // structural: zero results, or response fails the shape contract
  | "not_found"          // 404/410 source identity no longer resolves
  | "invalid_input"      // caller bug (bad URL, missing field)
  | "aborted"            // user AbortSignal
  | "policy";            // disallowed scheme etc. (http(s)-only scope)
  | "quota";             // provider billing exhaustion (credit/quota wording in a 4xx body)
```

| Class | May fall back? | Handling |
|---|---|---|
| unavailable, missing_credential | yes | try next candidate |
| auth | yes; disable only an adapter that owns credentials | don't hammer a bad provider key; an origin 401/403 from credential-free Native affects only that URL |
| rate_limited, timeout, network | yes | transient; retry elsewhere; recovery names fetch-specific actions for fetch failures |
| empty | fetch: yes once; search: only deep/compare | structural response failure; fetch recovery suggests URL/extraction/provider changes rather than search-only controls |
| not_found | **no** | verify the source URL or return to discovery for its current canonical location |
| invalid_input | **no** | correct the caller contract shown by the schema |
| quota | yes | provider billing exhaustion — recovery names the account top-up; 5-minute session cooldown (Retry-After honored when present) suppresses a dead lane without pretending it recovers on a timer |
| aborted | **no** | never a second billable call; propagate cancel |
| explicit-provider failure | **no** unless opted in | caller chose it |
| valid-but-disagrees | **no** | disagreement is data, not failure |

## Structural `empty` vs low yield (after independent review — finding E1)

`empty` remains structural rather than a subjective evidence-quality judgment. Search uses zero results or an invalid response shape and falls back only for deep/compare. Fetch may always try its one remaining bounded candidate because a known URL either produced extractable content or it did not.

Native readable HTML adds one calibrated structural check from the 37-source comparison: if Readability returns fewer than 1,000 characters while the same downloaded page yields more than 10,000 Markdown characters and more than ten times the readable projection, classify that projection as `empty`. This catches content-rich application/list shells without treating an ordinary concise page or low search-result count as failure. The second provider attempt and reported Tavily credit remain visible.

## `Retry-After` on rate-limit (after independent review — finding E2)

On `rate_limited`, capture the response's `Retry-After` header (if present) and
seed the session cooldown from it, so the circuit-breaker timer is
server-informed rather than count-based. Fallback still routes to the **next**
candidate (unchanged); the seed just prevents re-selecting a known-throttled
provider within the same session/cascade. A small addition to
`src/failures.ts::classifyHttpFailure`, not new machinery.

## Bounds

- Max **two** providers per ordinary request (`defaults.maxAttempts`).
- Bounded `limits.timeoutMs` and `limits.concurrency` per adapter.
- Session-local **circuit breaker / cooldown** per provider after repeated
  failure, so a dead provider is skipped quickly for the rest of the session.
- `strategy:"compare"` / `depth:"deep"` may run a small cascade and merge —
  **optional, off by default**, requested by the agent, never imposed.

## Provenance of choice — fact, not inferred quality

Every result carries `attempts[]`: provider, operation, status, duration,
`failureClass`, `fallbackReason`. The agent sees *which* provider ran, *what* failed, *why* fallback happened. Comparative quality remains scenario-scoped: the 2026-08-02 fetch packet selected Tavily only for the named host/path families and left Native first elsewhere; it did not create a universal provider leaderboard.

## Why these defaults

- First-fit keeps cost/latency low and prevents silent billable fan-out.
- Evidence-backed host/path preference avoids knowingly returning thin Native shells on common research sources.
- Loud failures make the doc-driven maintenance model work (breaks are detectable).
- Explicit-override-always honors agent choice.
- Disabling only credentialed adapters on `auth` avoids burning a bad provider key without converting one website's access policy into session-wide Native disablement.

## What would change this policy

- Accepted focused comparative evidence may add, remove, or narrow a host/path preference.
- If the calibrated thin-readable condition produces noisy paid retries, tighten or remove that condition from current comparison evidence rather than adding host folklore.
- A new failure class is added only when a real provider failure does not fit the taxonomy.
- `quota` exists because credit exhaustion is none of: caller input (`invalid_input`), transient timing (`rate_limited`/`timeout`), or provider outage (`network`). Classification reads the 4xx response body for credit/quota/billing wording (Serper's `400 {"message":"Not enough credits"}` verified live 2026-08-07); `web_search`'s explicit-provider one-attempt contract is unchanged, while internal evidence collection may fail over to a funded lane.

## Alternatives and decisive trade-off

Model-owned provider routing would hide availability and billing policy inside prompts. Natural-language intent regexes would be brittle, while exact URL rules tied to a dated comparison are inspectable and challengeable. Unbounded or invisible retry can duplicate paid calls. Deterministic capability/priority selection, the narrow accepted fetch table, explicit provider override, and visible bounded attempts preserve operator control.

## Evidence and verification

`src/routing.ts::selectProviders`, `src/routing.ts::runWithFallback`, and `src/failures.ts` are implemented with focused routing/failure proof. The connected fetch-routing trajectory proves a Tavily-preferred URL runs Tavily first, an ordinary Native `empty` result visibly falls back once, and an origin `auth` failure does not disable credential-free Native for the next URL. `tests/failures.test.mjs` proves HTTP 404/410 map to non-retryable `not_found`, 422 remains `invalid_input`, and fetch `empty` recovery no longer recommends search-only parameters. `tests/web-fetch.test.mjs` proves partial URL failures retain successful evidence and print operation-appropriate next actions. Public `web_fetch` mode proof still confirms page-only Native is excluded for `site`/`map`.

## History

- 2026-07-27: deterministic selection + loud-failure taxonomy settled; "low
  evidence quality" rejected as an automatic fallback trigger (routed to the
  model as a warning instead); provider ranking deferred.
- 2026-07-31: focused provider preparation exposed that fetch `capability.modes` were documented but ignored. Added mode-aware eligibility before priority selection and public-tool proof that `map` reaches Tavily without attempting Native.
- 2026-08-02: accepted the fixed-URL fetch comparison. Kept Native as general default, promoted Tavily basic for named research host/path families, enabled one visible fetch-empty fallback, calibrated thin Readability against the same page's Markdown, and limited auth circuit-breaking to adapters that own credentials.
- 2026-08-07: added `quota` (3-agent council + coordinator, verified live): body-aware 4xx classification, fallback-eligible, top-up recovery, 5-minute self-healing cooldown. Operation-aware `empty` recovery stopped naming search knobs no public tool exposes; `fallbackOccurred` unified on `attempts.some(failed)`.
- 2026-08-04: a live invalid GitHub repository exposed that 404 was incorrectly classified as caller `invalid_input` with schema-repair advice. Added non-fallback `not_found` for 404/410, operation-aware fetch recovery for timeout/network/empty, and per-URL next actions while preserving successful siblings.
