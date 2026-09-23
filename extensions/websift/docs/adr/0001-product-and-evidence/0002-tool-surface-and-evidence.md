---
title: "ADR 1.2 — Four web tools and evidence model"
description: "Defines web_search, web_fetch, web_answer, and web_lookup, their public schema boundary, evidence states, and shared result envelope."
tags: [jeito-websift, adr, tools, schema, evidence-model]
created: 2026-07-28
updated: 2026-08-10
status: stale
adr_id: ADR-001.002
adr_type: child
decision_status: superseded
confidence: confirmed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Public tool contracts and evidence model"
audience: mixed
parent: docs/adr/0001-product-and-evidence/README.md
code: [src/tools/web-search.ts::registerWebSearch, src/tools/web-fetch.ts::registerWebFetch, src/tools/web-answer.ts::registerWebAnswer, src/tools/web-lookup.ts::registerWebLookup, src/types.ts::Source]
related: [docs/adr/0002-internal-architecture/README.md, docs/adr/0005-provider-evaluation-and-guidance/0003-multi-provider-search-schema.md]
---

# ADR 1.2 — Four web tools and evidence model


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-001 — the folder master ADR](README.md). It is superseded by [ADR-001.003](0003-core-search-and-provider-specialists.md): the four evidence verbs remain the everyday core, but provider-specialist activation means they are no longer the complete registered inventory.

`alehdezp` owns the decision. Historical metadata remains `decision_status: superseded`, `confidence: confirmed`, `evidence_grade: verified`, and `implementation_status: validated` for the four-tool core contract.

## Decision

Expose exactly four model-facing tools, one per evidence *verb*: **find**
(`web_search`), **read** (`web_fetch`), **synthesize** (`web_answer`),
**catalog** (`web_lookup`). A single union tool was rejected: search, fetch,
answer, and catalog have different parameter and evidence contracts, and four
concise tools are cognitively smaller than one ambiguous schema.

## Why this set is intuitive for agents

- The verbs map to how an agent already reasons about web work; the agent picks
  a tool by *what it wants back* (leads / content / an answer / a catalog row).
- Each tool's result carries an explicit **evidence status**, so the agent never
  confuses a lead with fetched content or a third-party synthesis with evidence.
- Provider selection is verb-specific rather than falsely uniform. `web_search` and `web_answer` can force a provider; `web_fetch` routes automatically except for its explicit Linkup rendering branch; `web_lookup` requires a source discriminator because documentation and catalog sources are different contracts. Common calls still need only `query`, `url`, `question`, or `source+query`.

## Evidence model (the invariant every tool honors)

- **Lead** = a pointer (title/url/snippet). Not evidence until fetched. Search
  results are leads.
- **Catalog record** = structured discovery metadata from SkillsMP or a package
  registry. It remains a lead for quality or fit decisions.
- **Provider citation** = a provider-native answer citation, optionally with a provider-returned passage. It uses `provider-citation` with `fetched:false`; it is not independently fetched evidence.
- **Fetched content** = bytes or documentation content jeito retrieved. Each `Source` preserves the compatibility boolean `fetched` and explicit `evidenceStatus: lead|catalog|provider-citation|fetched`.
- **Synthesis** = a third-party model's answer. It remains a lead or provider citation unless the cited target is independently fetched. `web_answer` exposes the distinction.
- Search snippets alone are never sufficient evidence for `verify`/`research`.

## Shared result envelope

Every tool returns lean model-facing text in `content[0].text` and full detail in
`details`:

```ts
details: {
  provider: string;          // provider that produced the returned result
  attempts: Attempt[];       // every provider tried, in order (see 0002)
  sources: Source[];         // normalized sources with fetched + evidenceStatus
  fallbackOccurred: boolean;
  cached: boolean;           // served from cache vs fresh
  warnings: string[];        // partial results, low evidence, etc.
  responseId?: string;       // id for retained full content (see 0005)
}
```

`content[0].text` is deliberately short (bounded by `limits.inlineChars`); the
agent retrieves full content via `responseId`. This preserves the 23→4 context
win. See [`ADR 2.1 — layered provider architecture`](../0002-internal-architecture/0001-layered-provider-architecture.md) for `SearchResult`,
`Source`, `Attempt`.

## web_search

Discover leads from the live web. Results are lead-only.

| Param | Type | Default | Agent-facing description |
|---|---|---|---|
| `query` | string | required | The search query. |
| `extraQueries` | string[] | — | Optional bounded batch (cap 4) to run alongside `query`. Multiplies the fan-out budget — see below. |
| `kind` | enum | `general` | `general\|news\|academic\|code\|social`. Selects the *strongest provider* for the kind; it is not a budget. |
| `depth` | enum | `standard` | `fast\|standard\|deep`. The *budget*: fast/standard use one provider; deep may use up to two. |
| `strategy` | enum | `single` | `single\|compare`. `compare` fans out to cross-check sources and doubles the fan-out budget; use only when reconciling sources matters. |
| `provider` | string | auto | Force a specific provider. Honored exactly; no auto-fallback unless `fallbackOnExplicit`. |
| `fallbackOnExplicit` | boolean | `false` | Allow fallback even when `provider` is set. |
| `recency` | {from?,to?} | — | ISO date range filter. |
| `domains` | {include?,exclude?} | — | Domain include/exclude lists. |
| `count` | number | 10 | Results requested, clamped 1–20. |
| `exa` | typed object | — | Force Exa and apply current advanced controls: search type, category, recent-day window, required/excluded text, location, moderation, full text, deep instructions, and additional deep queries. |

**Optimal use:** default everything for a quick lead list. `kind:"academic"` or
`code` biases to Exa; `kind:"social"` routes to xsearch; `kind:"news"` biases to
Tavily. Set `provider` only when you know the engine you want. Use the typed
`exa` branch when Exa's retrieval mode or content controls materially affect the
research lane; it forces Exa without exposing an arbitrary options bag. Use
`strategy:"compare"` or `depth:"deep"` only when you will actually reconcile
sources — they cost more.

### Fan-out budget (interaction rule — after independent review, finding B1)

`extraQueries`, `depth`, and `strategy` compose, so the budget is one visible
number: `calls = queries × providers × (compare ? 2 : 1)`, where
`queries = 1 + len(extraQueries)` (cap 4), `providers = 1` for fast/standard and
`2` for deep, and `compare` doubles for the cross-check. The product is clamped
to `limits.maxFanOut` (default 4); a request exceeding it is clamped **with a
warning in `details.warnings`, never silently multiplied**, and the derived cost
is exposed in `details`. `compare`+`deep` together are an explicit opt-in against
that ceiling. (Simpler alternative the owner may choose: collapse `extraQueries`
into `depth` and keep `compare` as the only orthogonal toggle.)

## web_fetch

Fetch and extract one or more known URLs, or retrieve previously stored content.

| Param | Type | Default | Agent-facing description |
|---|---|---|---|
| `url` | string | one of | A single URL to fetch. |
| `urls` | string[] | one of | A bounded batch of URLs (cap ~10). |
| `responseId` | string | one of | Retrieve or page previously stored full content. Exactly one of `url`/`urls`/`responseId`. |
| `mode` | enum | `page` | `page\|site\|map`. `page` fetches the URL(s). `site`/`map` *discover* URLs and return them as leads (bounded ~25); they do not auto-fetch. |
| `extract` | enum | `readable` | `readable\|markdown\|raw`. `readable` = Readability main content; `markdown` = full page as markdown; `raw` = raw body. |

**Optimal use:** `url` for a known page. The dispatcher auto-detects GitHub
repos, PDFs, and (when enabled) YouTube/video and routes to the right handler —
see [`ADR 2.3 — composable fetch pipeline`](../0002-internal-architecture/0003-fetch-pipeline.md). Use `mode:"site"` to get a
bounded URL list, then fetch the ones you want individually. Use `responseId` to
page through retained full content without re-fetching. Only `http(s)` URLs are
accepted.

## Search versus Answer — superseded generic modes

`web_search` still returns ranked leads for inspection and fetch. ADR-001.003 now owns answer placement: startup `web_answer` makes one provisional Exa attempt with no fallback, while lazy Exa/Linkup specialists expose provider-native answer controls. Generic `verify`/`research`, `claim`, `budget`, `requireFetched`, and provider routing were removed after a live verification emitted six citation markers while displaying only one fetched source.

Verification is now `$mini-research`-owned for W1/W2 and `$research`-owned for W3/W4. This preserves adaptive source selection and explicit warrants instead of hiding fixed search→fetch→provider-synthesis inside one call. Historical generic mode details remain recoverable from this ADR's Git history.

## web_lookup

Query structured catalogs and documentation services whose contracts are not
ordinary web search. The schema is a **source-discriminated union**: each
`source` branch is a closed object, so Context7-only fields are rejected on the
catalog sources and vice versa (no shared flat bag, no untyped `providerOptions`).

### Pi provider schema envelope for `web_lookup` (SUPERSEDED 2026-08-23 — flat schema + runtime discrimination; envelope caused live argument stripping)

[`src/tools/web-lookup.ts::registerWebLookup`](../../../src/tools/web-lookup.ts) must register a schema whose root is `type: "object"`. The three source-discriminated closed objects remain under `anyOf` inside that root envelope. This preserves branch validation while satisfying OpenAI-compatible providers such as DeepSeek, which reject a function schema whose root is only `anyOf` and therefore has no root type.

The envelope is owned by the web tool contract, not by [`tooltap`](../../../../tooltap/extensions/index.ts). tooltap may route or hide definitions, but it must not rewrite arbitrary tool semantics.

DeepSeek documents `parameters.type: "object"` as the function schema shape and lists `anyOf` as supported in strict mode: <https://api-docs.deepseek.com/guides/tool_calls/>.


| Param | Type | Default | Agent-facing description |
|---|---|---|---|
| `source` | enum | required | `context7\|skillsmp\|pi-packages`. |
| `query` | string | required | The lookup / ranking query. |
| `library` | string | context7 | Library name to resolve (Context7). |
| `version` | string | context7 | Requested version; pins the resolved ID via the official `@<version>` suffix (Context7). |
| `page` | number | 1 | Logical retrieval hint (Context7 donor-compatible steering) or result page (catalogs). |
| `limit` | number | catalog default | Results per page — **catalog sources only**; rejected on Context7 (no grounded meaning). |
| `context7` | object | — | Closed Context7-only options: `mode` (`docs` default \| `resolve`), `libraryId` (exact ID, bypasses resolution), `topic`, `fast`, `responseType` (`txt` default \| `json`). |
| `sortBy` | enum | `stars` | SkillsMP only: `stars` \| `recent`. Rejected on Context7/pi-packages. |
| `category` | string | — | SkillsMP only: category slug filter. Rejected on Context7/pi-packages. |
| `occupation` | string | — | SkillsMP only: SOC occupation slug filter. Rejected on Context7/pi-packages. |
| `language` | string | — | SkillsMP only: detected Skill content-language ISO code; `mul` selects mixed and `und` undetermined content. Rejected on Context7/pi-packages. |

**Evidence split (Context7).** `mode:"resolve"` returns library **catalog**
candidates (`fetched:false`, no `responseId`). `mode:"docs"` resolves safely
(a unique/defensible candidate only — silent first-candidate fallback is not
performed), pins the requested version, and returns **fetched** documentation:
a bounded inline excerpt plus the complete raw body retained behind a
`responseId`, retrieved through the shared `web_fetch({responseId})` path
([`ADR 2.3`](../0002-internal-architecture/0003-fetch-pipeline.md)). An ambiguous
or unversionable resolution returns candidates and performs no docs request.

**Evidence (SkillsMP / pi-packages).** Catalog branches return **catalog** records
(`fetched:false`, **no `responseId`**) — discovery leads only. The SkillsMP branch adds
`sortBy`/`category`/`occupation`/`language` filters and parses grounded `x-ratelimit-*` headers
into `details.rateLimits` (operational state, not a ranking signal). No response-pagination object is
exposed because the official contract documents request page/limit but no pagination response shape.
Records carry no safety, license, compatibility, or install endorsement; inspect the linked source
before any install.

**Optimal use:** `context7` for library documentation (resolve, or `docs` with
`library`/`libraryId` + `version`); `skillsmp` for agent-skill catalog discovery;
`pi-packages` for Pi package discovery (discovery only — installation stays a
separate privileged operation). Social search belongs under
`web_search(kind:"social")`, not here.

## What would change this surface

- A fifth tool is admitted only if a real task repeatedly fails to express its
  intent through these four (e.g. a distinct streaming/monitoring operation).
- A parameter is added only when a reproduced need proves it; avoid a generic
  untyped `providerOptions` bag.

## Alternatives and decisive trade-off

Provider-named tools expose every vendor detail but force agents to own routing and fallback. One union tool makes search, fetch, answer, and catalog fields conditionally relevant. Four evidence verbs keep call intent and evidence rights legible while typed provider branches preserve advanced differences only where needed.

## Evidence and verification

Current source registers the four tools and `src/types.ts::Source` represents lead/catalog/provider-citation/fetched state. Exa and Linkup answer citations use `provider-citation` with `fetched:false`; only the owned fetch path produces `fetched`. [`src/tools/web-lookup.ts::registerWebLookup`](../../../src/tools/web-lookup.ts) emits a root-object schema envelope around its source branches. Focused adapter/answer tests and `npm run typecheck --workspace @alehdezp/websift` pass; answer-provider quality and final tool grouping remain unselected under ADR-001.003.

## History

- 2026-08-10: ADR-001.003 superseded the generic answer modes. Startup `web_answer` is one provisional Exa attempt; research skills own verification/investigation and provider specialists retain native controls.
- 2026-08-03: corrected the inherited evidence vocabulary so provider-native citation passages are explicit `provider-citation`, never independently fetched content.
- 2026-08-01: Superseded by ADR-001.003 after repeated first-contact failures showed that the unified advanced-search union moved provider complexity into conditional schema interactions; runtime migration remains pending.
- 2026-07-31: corrected ADR 5.3 from “unimplemented” to implemented/validated for contract mechanics while keeping advanced provider grouping and public selection apprenticeship/user-pending.
- 2026-08-23: envelope retired — live serving stacks stripped **all** tool-call arguments against its empty-properties root (8/8 failures across two routes, session-log proven); `web_lookup` now declares a flat standard object and discriminates per source at runtime, per ADR-001.004. Fresh-session execution verified; see `.pi/goals/websift-tools-usable/`.
- 2026-07-31: added the root-object envelope to `web_lookup` while retaining its source-discriminated `anyOf` branches. The focused registration suite and web typecheck validate the local contract; live DeepSeek execution remains unrun.
- 2026-07-27: four-tool surface settled; `answer` mode kept but flagged as the
  weakest/highest-epistemic-risk, with `verify`/`research` first-class and
  mandatory `fetched` exposure.
- 2026-07-29: Phase 5C restructured `web_lookup` as a source-discriminated union
  (Context7-only fields rejected on catalog sources; `limit` rejected on Context7)
  and split Context7 evidence into resolve=catalog vs docs=fetched, with the complete
  raw docs body retained behind `responseId` through the shared `web_fetch` path.
- 2026-07-29: Phase 5D extended the `web_lookup` `source:"skillsmp"` branch with
  `sortBy` (`stars`|`recent`), `category`, `occupation`, and `language` filters (SkillsMP-only;
  rejected on Context7/pi-packages) and grounded `x-ratelimit-*` parsing into
  `details.rateLimits`; SkillsMP output stays catalog evidence with no `responseId`, and undocumented
  response-pagination fields are not inferred.
- 2026-07-30: Phase 5E added a closed `serper` branch to the `web_search.requests[].route` union —
  grounded Google lexical search with `country`/`language` locale controls, `count` capped at Serper's
  grounded maximum of 10 (a forced over-10 count is rejected, not truncated), organic leads plus bounded
  `answerBox`/`knowledgeGraph` candidates surfaced in `details.serper` as unfetched leads (never
  evidence, never a quality signal).
- 2026-08-01: Corrected the false uniform-provider claim and clarified the current Search-versus-Answer seam, including X's lead-only provider synthesis edge; no tool name or public field changed.
