---
title: "jeito websift roadmap — complete provider capability with selective exposure"
description: "Durable delivery plan for complete provider capability, advanced research quality, token-efficient evidence retrieval, provider-apprenticeship-led interactive selection, local provider onboarding, and lean verification."
tags: [jeito-websift, roadmap, provider-parity, advanced-research, token-efficiency, provider-setup, provider-apprenticeship, error-recovery]
created: 2026-07-28
updated: 2026-08-11
status: active
owns: "Provider capability map, implementation sequence, public-selection gates, and anti-drift boundaries"
audience: contributor
related: [docs/WORK-PLAN.md, docs/adr/0001-product-and-evidence/0002-tool-surface-and-evidence.md, docs/adr/0005-provider-evaluation-and-guidance/README.md, docs/adr/0003-engineering-stewardship/0002-maintainability-and-testing.md, AGENTS.md]
---

# jeito websift provider capability and lean delivery plan

## Delivery contract: complete capability, selective model exposure

jeito websift keeps four coherent model-facing verbs while fully mapping and
implementing the reviewed API surface of the owned providers. Internal provider
capability and model-facing capability are different boundaries: an implemented
operation may remain internal, but it is not registered as a hidden tool or
silently reachable through `tool_search`.

The tables below are the capability map. They must be detailed enough to compare
semantics, evidence, limits, cost, current implementation, and public mapping, but
they are intentionally Markdown rather than a generated registry or capability
platform. The provider source versions pinned in [`upstreams/`](upstreams/README.md)
own the reviewed baseline; inspect the installed version-matched SDK/API contract
before implementing or claiming parity.

Minimalism applies to scaffolding, abstractions, and proof—not to dropping the
agreed provider capability. Complete implementation does not imply complete public
exposure.

The product outcome is not merely consolidation. jeito must make difficult current, novel, strange, AI-heavy, social, video, and long-tail research more accurate and context-efficient. Source review establishes contracts; operation conformance establishes readiness; focused provider apprenticeship establishes practical behavior; targeted comparisons inform unresolved cost/quality trade-offs; `alehdezp` interactively selects provider roles, advanced schemas, fallbacks, and guidance. No lower stage may promote itself into the next authority.

## Current release state

Bounded `crawl` and async `llm_answer` are active. `llm_answer` binds immutable sidecars to cache path, page content hash, objective, and `query_terms`; distinct intents on one page coexist, exact repeats reuse, and legacy `.summary.md` artifacts remain exact-match readable. See [`ADR 2.5`](adr/0002-internal-architecture/0005-webclaw-extraction-redesign.md#adr-parent-and-current-state).

## Landed low-complexity improvements

- `/web-doctor` reports config health, credential presence, permissions, restart requirements, and operation coverage without network calls or secret values. Owner: `src/doctor.ts::buildDoctorReport`.
- Failure results include machine-readable `recovery` advice and one actionable `Fix:` line. Owner: `src/failures.ts::recoveryAdvice`.
- Multi-provider search deduplicates fragments and known tracking parameters while retaining the original result URL. Owner: `src/tools/web-search.ts::canonicalSearchUrl`.
- Generic `web_answer` is one provisional Exa attempt; W1/W2 verification is `$mini-research`-owned and W3/W4 investigation is `$research`-owned. Owner: `src/tools/web-answer.ts::registerWebAnswer`.
- Search schemas state how `extraQueries`, `depth`, and `strategy` consume fan-out.
- `mode:"download"` always re-fetches, updates persistent `.cache/web/<host>/` content, and reports whether the artifact was fresh or refreshed; ordinary `page` reuses exact cache hits. The removed `refresh` name is not a second behavior.
- Large-page retrieval now returns full content through ~5,000 estimated tokens and otherwise the pi-nav smart-read source view (web metadata + pi-nav `pi_nav_read` outline over the cache file; pi-nav's own thresholds decide full vs outline; headers-only fallback when pi-nav is absent). Multi-seed map processes every root; multi-seed crawl divides one 25-page/50-MB budget fairly and writes partial-success manifests.

## Provider operation and parameter inventory

### Serper reviewed surface

Source: [`upstreams/serper.md`](upstreams/serper.md).

| Operation / field | Status | Mapping or next owner |
|---|---|---|
| Search `q`, `num`, `gl`, `hl`; organic/candidates/credits | public subset mapped and live-exercised | forced `web_search is Serper lexical only (site:/quoted/year via query, no requests[]/route)`; count capped at 10; locale normalized; credits and bounded candidates visible |
| Search `location`, `autocorrect`, `tbs`, `page` | implemented internal | `serperOperation(endpoint:"search")`; no public fields until a recurring task needs the distinction |
| Images, Videos, Places, News, Shopping, Scholar, Patents | implemented internal and live-exercised | preserve endpoint-specific provider records/credits; do not flatten media/local/shopping into ordinary leads |
| Autocomplete | implemented internal and live-exercised | suggestion discovery; no public lookup mapping selected |
| Maps → Reviews | implemented internal and live-exercised | dependent local-data flow; Reviews requires a provider identifier |
| Lens | implemented internal and live-exercised | reverse-image lead discovery from a known HTTP(S) image URL |
| Webpage | implemented internal and live-exercised | extracted text/Markdown/media/link record; public fetch/retention role pending targeted comparison |
| gated Product Reviews, Maps Autocomplete, Search Full, Bing | excluded from general contract | current official frontend exposes them only to selected accounts/employees; reopen when configured account access is grounded |

### Exa reviewed surface

Source: [`upstreams/exa.md`](upstreams/exa.md), the pinned `@capyup/pi-exa` contract, and installed `exa-js` 2.16.3 types.

| Operation | Implemented/public now | Remaining internal implementation or exposure decision |
|---|---|---|
| search | public `query`, `count`, dates/domains, highlights plus typed `exa` controls for `keyword/neural/auto/hybrid/fast/instant/deep-*`, current categories, recent days, include/exclude text, location, moderation, full text, system prompt, and deep additional queries; internal intent also supports flags and structured output | decide whether structured output earns public exposure after its result/evidence shape is exercised; streamed synthesis remains unselected |
| fetch/content | internal typed `fetchExaContents` implements current text/summary/query-guided highlights, `maxCharacters`, `maxAgeHours`, `livecrawlTimeout`, structure-aware text controls, filtering, subpages/target, per-URL status/error inspection, and cost retention; search content uses current `{highlights:true}` or bounded text | Public deterministic targeting remains single-page `web_fetch query_terms`; multi-source retrieval deliberately shows every source without BM25. Text extraction is webclaw local (`-f llm`) with tavily escalation and `mode:"llm_answer"` for question answering (ADR 2.5). Exa query-guided highlights remain an alternative provider lane, not an automatic route. |
| answer | public question and citation normalization; internal answer intent supports user location, system prompt, and structured output | evaluate those controls for public use only when `web_answer` can represent their evidence honestly |
| similar | internal deprecated-SDK `findSimilarWithExa` supports count, source-domain exclusion, highlights/full text | keep internal until it beats search mutation on a real case |
| research job | internal `runExaResearch` implements create and bounded poll for all current models plus output schema; owned manual search→fetch→synthesis remains public behavior | keep provider-native research non-public until sources and evidence remain observable |

### Tavily reviewed surface

Source: [`upstreams/tavily.md`](upstreams/tavily.md).

| Operation | Mapped | Deferred parameters/features |
|---|---|---|
| search | four depth modes; count; general/news/finance; domains/country; relative/exact freshness; chunks; exact match; usage metadata | answer/raw/images/max tokens/automatic parameters remain internal |
| extract | URL batch; basic/advanced; format; query-guided chunks; images; failures and usage metadata | public fetch does not yet expose query/chunks/images |
| map | full typed traversal and usage metadata; bounded URL discovery public through `web_fetch mode:map` | advanced instructions/path/domain selectors remain internal |
| crawl | full bounded typed controls, query chunks, page content, usage and request ID internal | no public call; use only for a demonstrated multi-page need |
| research | bounded create/poll; model/schema/citation/domains/output length/files; source list | internal scout because synthesis lacks fetched claim-to-passage proof |

### Linkup reviewed surface

Source: [`upstreams/linkup.md`](upstreams/linkup.md).

| Operation / field | Status | Mapping or next owner |
|---|---|---|
| search `query`, fast/standard/deep, `searchResults`, `maxResults`, exact dates, domain filters | mapped and live-exercised | `web_search` typed `linkup` route; fast uses keyword-shaped prompts, standard one-step instructions, deep ordered retrieval |
| sourced answer `query`, depth, sources, inline citations | mapped and live-exercised | `web_answer_linkup`; remains unfetched synthesis |
| structured Search with JSON Schema | implemented internal | focused apprenticeship/maintenance path; expose only if a recurring public scenario needs schema-shaped output |
| fetch `url`, explicit `renderJs`, optional raw content | removed from public surface (2026-08-06) | linkup is out of the fetch stack (ADR 2.5); webclaw + tavily own fetch |
| asynchronous Research mode/depth/schema/filters | implemented internal and live-exercised at S | bounded scout; fetched primary passages still own closure |
| credits balance | excluded from model tools | explicit `/web-setup` usage check only; never startup or doctor |

### xAI/X search reviewed surface

Source: [`upstreams/xsearch.md`](upstreams/xsearch.md) and pinned `xsearch` schemas.

| Operation / field | Status | Mapping or next owner |
|---|---|---|
| query, inclusive from/to date | mapped and live-exercised | forced `web_search` xsearch route; real calendar dates, `from<=to` |
| `allowed_x_handles`, `excluded_x_handles` (max 20) | mapped and live-exercised | public `allowedHandles`/`excludedHandles`; mutually exclusive; trim/strip `@` with visible warning |
| model and image/video understanding | internal and live-exercised | current semantics represented; no public exposure because media changes token work and normalized citations cannot attribute media evidence |
| `max_turns`, `parallel_tool_calls`, `max_output_tokens` | internal; not a cost ceiling | observed one-turn requests used 10–14 X searches and reported more output tokens than the requested bound; never budget as one tool call |
| synthesized text, citations, usage | mapped | one bounded lead-only synthesis plus citation URLs and model/token/tool-call metadata; citation-free no-winner synthesis retained in failure |

### Context7 reviewed surface

Source: [`upstreams/context7.md`](upstreams/context7.md).

| Operation | Mapped | Deferred / excluded |
|---|---|---|
| resolve library | `mode:"resolve"` (Phase 5C): `library`, `query`, optional `version`, `fast`; catalog candidates with full metadata (`id`/`title`/`description`/`versions`/`totalSnippets`/`trustScore`/`benchmarkScore`/`source`/`searchFilterApplied`); requested versions filter candidates | none — automatic selection requires one candidate or one unique exact title/final-ID match; provider scores remain metadata and never authorize a guess |
| get docs | `mode:"docs"` (Phase 5C): `libraryId` (exact, bypasses resolution) or `library`+`version`; `topic`/`page` donor-compatible steering, `fast`, `responseType` `txt`\|`json`; safe resolution, official `@<version>` pinning, fetched evidence, bounded inline excerpt | none material |
| retained raw docs | complete raw body (txt or exact json) saved to `.cache/web/docs/<doc>/full.<md|json>` and the result names that path (2026-08-06; `responseId` removed) | donor on-disk cache + stale-cache fallback excluded-by-design (retention is a local file, not a session store) |

### SkillsMP reviewed surface

Source: [`upstreams/skillsmp.md`](upstreams/skillsmp.md).

| Field | Status | Mapping or next owner |
|---|---|---|
| `q`, page, limit | mapped (Phase 5D) | `web_lookup(source:"skillsmp")`; trimmed + bounded-integer clamped; blank query rejected pre-network |
| `sortBy` | mapped (Phase 5D) | public `stars` (default) \| `recent` |
| category, occupation, language | mapped (Phase 5D) | optional catalog filters; language accepts documented ISO codes plus `mul`/`und`; trimmed; sent only when non-empty; blank-when-supplied rejected |
| title, description, source, stars, category, occupation, stable id | mapped (Phase 5D) | normalized catalog record (metadata where present) |
| `x-ratelimit-*` headers | mapped (Phase 5D) | parsed to `details.rateLimits` (operational only, not a ranking signal) |
| response pagination metadata | excluded | official docs define page/limit requests but no response-pagination object; do not infer total/totalPages/hasMore fields |

### Pi package search reviewed surface

Source: [`upstreams/pi-package-search.md`](upstreams/pi-package-search.md).

| Operation / field | Status | Mapping or next owner |
|---|---|---|
| registry text query and size | mapped | `web_lookup(source:"pi-packages")` |
| normalized package metadata and inert install command | mapped | discovery only |
| package installation | excluded | state-changing operation remains owned by `pi install`, never `web_lookup` |

### Native fetch and retained content

Source: [`upstreams/pi-web-access.md`](upstreams/pi-web-access.md).

| Capability | Status | Mapping or next owner |
|---|---|---|
| HTTP(S) text extraction, size/timeout bounds | implemented, live-exercised | `src/adapters/webclaw.ts` — webclaw `-f llm` single format; JS-needs DB v2 routes shells to tavily; missing binary is policy with install guidance |
| response ID persistence/retrieval | mapped | `src/output.ts` |
| GitHub-aware extraction | mapped, live-exercised | `src/fetch-handlers/github.ts` — clone + size-gated `gh`-API fallback (dispatched from the webclaw adapter) |
| PDF extraction | mapped, live-exercised | `src/fetch-handlers/pdf.ts` lazy `unpdf`; <= configured responseBytes (default 5 MB), <= 100 pages, page markers retained (webclaw `--pdf-mode` tested NOT superior — ADR 2.5) |
| YouTube transcript and metadata | mapped, live-exercised | `src/fetch-handlers/youtube.ts` — model-free yt-dlp captions with minute locators; degrades to metadata-only |
| video frames / generic local-remote video | excluded | needs a model to describe ffmpeg frames; not part of the native baseline |
| persistent exact-URL cache, refresh, pi-nav smart-read source views, async crawl jobs + manifests | mapped, focused-proven | `src/tools/web-fetch.ts` + `src/fetch-cache.ts` + `src/crawl-jobs.ts`; no TTL by owner decision, secret-safe provenance, `.cache/` Git-ignored |

The [`ADR 5 — provider evaluation and research guidance`](adr/0005-provider-evaluation-and-guidance/README.md) family owns the current capability audit, typed multi-provider contract, provider apprenticeship, targeted comparisons, and guidance decisions. This roadmap remains the operation ledger and execution summary; child ADRs carry the challengeable rationale.

## Outcome and boundaries

The roadmap is complete when:

1. every operation and parameter in the reviewed provider set is recorded here;
2. the agreed provider surface is implemented inside the owning adapter/provider
   module, including capability not selected for model use;
3. only coherent, useful controls appear in registered public tool schemas;
4. internal-only capability remains callable by the focused maintenance or
   comparison path but is not registered as a Pi tool;
5. provider attempts, billable fan-out, evidence state, normalization, and
   fallback remain visible;
6. `$research` can perform granular, current, rejection-driven research without
   treating `web_answer` as a replacement;
7. a small set of integrated proofs establishes real Pi tool behavior and the
   important internal provider boundaries.
8. hard current/novel/social/video/multi-hop scenarios can be narrowed to source-faithful evidence with measured context use, and final provider/schema/guidance selection is made interactively with `alehdezp`.

### Explicit non-goals

- No YAML/TOML string or arbitrary provider-options dictionary.
- No flattened schema containing unrelated fields from every provider.
- No provider capability registry generator, plugin DSL, DI container, benchmark
  dashboard, generic adapter factory, or schema code generator.
- No speculative providers beyond the reviewed set.
- No cache, ranking framework, automatic query rewriting, broad crawl, or retained-corpus system is adopted without an observed task and comparative evidence. Query-aware passages, structure-aware locate-then-read, task-bounded QMD/codeweave-pi retrieval, caching, and reranking are active investigation candidates rather than categorical exclusions.
- No per-field, per-helper, or vendor-SDK behavior test program.
- No public or hidden tool merely because an internal operation exists.

These exclusions protect maintainability. They do not reduce the provider
implementation requirement above.

## Public schema decision rule

Use the first shape that preserves the real semantics:

1. **Common field** when at least two providers perform materially the same job
   with the same evidence meaning. Use one jeito name and translate wire names
   inside adapters.
2. **Typed provider branch inside the owning verb** when one selected provider has
   valuable controls whose semantics differ. The branch names the provider and
   exposes only selected typed fields; it is never a free-form bag.
3. **Separate tool-surface decision** only when an operation has a genuinely
   different verb, lifecycle, or result contract that cannot fit search, fetch,
   answer, or lookup without ambiguity.

Do not normalize fields merely because their words look similar. Tavily relative
`timeRange`, Exa publication dates, Exa `searchType`, and Linkup `depth` remain
distinct unless the adapter can make one contract truthful. Use camelCase for the
jeito schema and map provider wire spelling internally.

## Provider implementation shape

- Keep provider request construction, execution, failure mapping, and response
  normalization together in the provider owner. The public adapter calls the same
  implementation as the internal maintenance/comparison path.
- Extend the current provider file until unrelated operations make it hard to hold
  in one head; split by operation only then. Do not create interfaces with one
  implementation or factories for one provider.
- Internal-only operations export typed functions. `index.ts` registers the four
  everyday tools plus the four owner-accepted specialists; unselected provider operations stay out of the tool inventory.
- Large or long-running output uses the existing response store and bounded model
  text rather than inventing another persistence layer.
- Preserve grounded provider implementation even when public selection says “not
  exposed.” Record the reason here so a future comparison starts from evidence,
  not reconstruction.

## Delivery increments

### Increment 1 — truthful surface and Exa baseline (landed locally)

Catalog/fetched evidence is explicit, shipped `tool.yaml` selects the four tools,
Exa is refreshed against installed `exa-js` 2.16.3, advanced Exa search controls
reach `web_search`, and previous Exa content/similarity/answer/research operations
have internal implementations rather than hidden tools. Local focused and package
proof passed; live provider compatibility and model schema usability remain open.

Before widening implementation, close one coherent Git checkpoint: stage the web
extension with its root manifest, shipped `tool.yaml`, and owning installation/resource
contracts; run the web package proof plus the root integration contracts; review the
staged boundary; and commit only with user authorization.

### Increment 2 — research-guidance baseline and ownership design

Treat the current `/Users/example/.pi/agent/skills/research/` skill as the historical
W3/W4 authority and apprenticeship baseline. Audit its W0–W4 router,
`references/web-tools-playbook.md`, and `references/tool-lane-preflight.md` before
writing provider descriptions or focused call recipes. Record each old provider
recommendation as a hypothesis, not a measured fact.

Prepare the extension-owned final shape without loading duplicate `research` skills:

- `skills/mini-research/SKILL.md` owns bounded W1/W2 source work;
- `skills/research/SKILL.md` owns consequential W3/W4 investigation;
- `skills/research/references/` owns shared evidence rights, tool-lane guidance, and
  current provider recommendations consumed by both skills;
- provider contracts stay in `docs/upstreams/`, apprenticeship evidence and decisions stay
  in `docs/adr/0005-provider-evaluation-and-guidance/`, and active call construction stays in Pi tool
  schemas.

Copy and verification were completed before the explicitly approved cutover. The original global tree remains at `/Users/example/.pi/agent/.skill_backups/research-pre-jeito-20260731`; old and package copies never loaded together.

**Phase 1 audit and skill migration complete (2026-07-31):** The historical research skill and completed Atlas architecture investigation were audited. All 28 consequential records carry stable `HG-<LANE>-NN` identifiers with exact source selectors, provenance, confidence/evidence limits, current-contract relationships, intended owners, and either disconfirming exercise outcomes or explicit non-comparison proof in [ADR 5.2](adr/0005-provider-evaluation-and-guidance/0002-provider-contract-baseline.md), [ADR 5.4](adr/0005-provider-evaluation-and-guidance/0004-benchmark-and-selection.md), and [ADR 5.5](adr/0005-provider-evaluation-and-guidance/0005-guidance-lifecycle.md). Package-owned `mini-research` and `research` are now live after a stopped-process reload; provider recommendations remain apprenticeship hypotheses.

### Increment 3 — Historical Tavily completion and typed Exa–Tavily requests

Complete the current Tavily SDK search/extract contract and grounded map/crawl HTTP
contract, including failed URLs, request IDs, credits, output bounds, and cancellation.

**Phase 2 Tavily contract complete (2026-07-28):** Every observed official SDK search/extract
field and grounded map/crawl HTTP field is typed and mapped in `src/types.ts` and
`src/adapters/tavily.ts`. Search, extract, map, and crawl are executable through
public-common or focused internal boundaries. Provider metadata (answer, images, rawContent,
failedResults, baseUrl, responseTime, credits, requestId, favicon) is preserved internally.
Evidence rights are correct. Invalid bounds fail before calls. SDK cancellation limits are
documented. [ADR 5.2](adr/0005-provider-evaluation-and-guidance/0002-provider-contract-baseline.md)
Tavily rows updated from pending to implemented.
Then implement
[`ADR 5.3 — typed multi-provider and repeated-provider web_search`](adr/0005-provider-evaluation-and-guidance/0003-multi-provider-search-schema.md): preserve the one-query shorthand and add a typed
`requests[]` plan that can send different queries to Exa and Tavily or several queries
to the same provider. Validate one shared actual-attempt budget before the first
billable call, retain request-index provenance, and reject oversized plans instead of
silently truncating them.

The first integration proof covers one Exa request plus one Tavily request and two
requests to one provider. Do not wait for Linkup to run this schema experiment: Linkup
does not affect whether the Exa–Tavily discriminated request shape is intuitive.

**Phase 3 typed requests[] complete (2026-07-29):** the advanced `requests[]` path is
implemented behind `web_search`
([ADR 5.3](adr/0005-provider-evaluation-and-guidance/0003-multi-provider-search-schema.md)):
a discriminated auto/Exa/Tavily route union with closed request, route, and option objects;
complete-plan budget and cross-field validation before the first call; sequential execution
with partial sibling results; and global canonical dedup that preserves contributor provenance
without replacing a request's own displayed title/URL with another provider's result. Auto
routes honor `fallback:false`; aggregate fallback metadata records actual fallback rather than
an unrelated sibling failure. The one-query shorthand is byte-for-shape compatible.
Exa+Tavily and repeated-Exa plans are proven deterministically.

**Increment 3 complete.** Increment 4 — the agent schema-usability experiment — is the next

**Superseded public shape (2026-08-04):** the typed `requests[]` implementation and proof remain historical evidence, but owner-directed provider/method decomposition removed that public surface. Current `web_search` is Serper-only; Exa, X, Tavily, and Linkup searches use explicit one-provider tools under [ADR 1.3](adr/0001-product-and-evidence/0003-core-search-and-provider-specialists.md).
gate; it must falsify this interaction shape with real Pi calls before any further provider
branch is added.

### Increment 4 — agent schema-usability experiment

Exercise the real Pi schema and result envelope before adding every provider branch.
Cover shorthand compatibility, forced Exa, forced Tavily, Exa plus Tavily, repeated
Exa, preflight rejection of an over-budget plan, sibling partial failure, canonical
deduplication with contributor preservation, request ordering, and visible fallback
attempt accounting.

Deterministic fixtures own billing/provenance/failure claims. Representative Pi calls
own agent construction and interpretation claims. A tiny live compatibility smoke
requires explicit authorization. If agents systematically choose the wrong route or
cannot interpret grouped results, stop and return to the schema decision; do not add
provider-specific conditionals around a failed interaction shape.

**Phase 4 experiment complete — Proceed (2026-07-29):** all hard gates (billing,
provenance, failure, evidence-right, grouped-output interpretation) pass. The original
experiment (minimax-m3, 10 trajectories) identified a reproducible empty-`route:{}` failure;
the user approved option (a) (make `provider` optional with default "auto" on the auto branch).
The follow-up experiment (minimax-m3 + gpt-5.6-sol, 10 trajectories) confirms the fix: both
models construct explicit exa/tavily routes and `route:{}` correctly on the first attempt.
`implementation_status` → `validated`. See
[ADR 5.3 Phase 4 section](adr/0005-provider-evaluation-and-guidance/0003-multi-provider-search-schema.md)
and `docs/PHASE4-TESTING-LEARNINGS.md`.

**Next action:** Increment 5 — Linkup re-review and remaining provider completion.

### Increment 5 — remaining current-contract completion

Re-read and implement the remaining installed contracts before comparing quality:

**Phase 5E complete 2026-07-30; current-platform refresh complete 2026-08-01:** the public closed Serper route still exposes lexical Search with country/language and a strict 10-result ceiling. Current official playground/billing bundles revealed a wider generally available platform, now implemented through internal `serperOperation`: full Search controls, Images, Videos, Places, News, Shopping, Scholar, Patents, Autocomplete, Maps, Reviews, Lens, and Webpage. All twelve specialist operations plus the internal boundary were exercised live with provider-reported credits. Public selection remains narrow because the specialist result/evidence shapes differ; no generic flattening or provider-quality claim was added.

*(Phase 5F complete 2026-07-30: the user-invoked `/web-setup` control center — local-only status
(disabled/inline/environment/required-missing/optional-anonymous/local), official provider
convenience pages (navigation, not health proof), masked inline-key set/replace/remove with atomic
mode-`0600` exact-path writes (malformed/symlink/non-regular refused, exclusive temp, no backup),
and explicit concurrent Tavily `GET /usage` + reused Linkup balance checks where one failure never
suppresses the other; zero network on open; ADR 4.1/2.4 reconciled to the single local
masked-command secret boundary; four model tools unchanged. Native fetch is Phase 5G.)*

*(Phase 5D complete 2026-07-29: SkillsMP re-reviewed and complete — the `web_lookup`
`source:"skillsmp"` branch exposes query/page/limit/sortBy/category/occupation/language, parses
grounded rate headers into operational `details.rateLimits`, catalog evidence only; no
response-pagination object inferred.)*

*(Phase 5C complete 2026-07-29: Context7 re-reviewed and complete — `web_lookup` became a
source-discriminated union; the `source:"context7"` branch exposes resolve (catalog) and version-pinned
docs (fetched) with a closed `context7` options object, safe resolution + official `@<version>`
pinning, complete raw body saved to `.cache/web/docs/<doc>/full.<md|json>` (retained locally; `responseId` removed); donor disk cache excluded.)*

*(Phase 5B complete 2026-07-29: X/xsearch re-reviewed and complete — public-provider `xsearch` search
route exposing handle filters under a forced `kind:"social"` route, calendar-validated exact dates,
mutually-exclusive handles normalized with a visible warning, model/media flags internal-comparison;
citation-only social leads.)*

*(Phase 5A complete 2026-07-29; refreshed 2026-08-01: public `linkup` Search accepts current exact-date/domain controls; `linkup:{renderJs}` Fetch accepts Markdown/raw; sourced answer remains public-common; structured Search, Research, and balance remain focused internal capabilities. Current official pricing is fetched and live balance deltas match it.)*

1. **Linkup — DONE (Phase 5A + apprenticeship refresh):** current Search, sourced/structured output, Fetch, Research, and balance contracts are mapped; focused live calls establish scoped query-shape/rendering/raw-context recipes and exact costs without selecting comparative provider priority.
2. **X — DONE (Phase 5B + apprenticeship refresh 2026-08-01):** current official exact dates and max-20 handle filters public; model/media/Responses controls internal; live calls establish first-hand date/handle construction, no-winner handling, and actual hidden work. The prior one-turn cost-ceiling premise was disproved and public output now exposes synthesis once plus usage.
3. **Context7 — DONE (Phase 5C):** re-reviewed against installed `@dreki-gg/pi-context7` 0.2.0
   (declared MIT, no LICENSE shipped; == latest, checked 2026-07-29) and the official Context7 Public
   API v2.0.0; resolve (catalog) and version-pinned docs (fetched) public through the `web_lookup`
   `source:"context7"` branch, `libraryId`/`topic`/`page`/`fast`/`responseType` exposed, safe
   resolution + official `@<version>` pinning, complete raw body saved to `.cache/web/docs/<doc>/full.<md|json>` (local file; `responseId` removed); donor
   disk cache excluded.
4. **SkillsMP — DONE (Phase 5D):** re-reviewed against the first-party `@alehdezp/skillsmp-search`
   0.1.0 source and the official SkillsMP API docs (skillsmp.com/docs/api, accessed 2026-07-29);
   query/page/limit/sortBy/category/occupation/language public, grounded rate-limit headers parsed to
   `details.rateLimits` (operational only), catalog evidence only (no `responseId`); response
   pagination excluded because no official response shape is documented.
5. **Serper — DONE (Phase 5E + current-platform refresh):** public lexical/locale Search remains stable; current specialist discovery, media, local, reverse-image, and Webpage operations are typed internal capabilities with credit retention. Account-gated operations remain excluded until accessible. Focused live evidence supports exact lexical query construction and locale behavior, not comparative priority.
6. **Provider setup control center — DONE (Phase 5F, complete 2026-07-30):** added the user-invoked
   `/web-setup` command, which reports local provider enabled/credential/anonymous status, opens
   official account/API-key/billing/docs convenience pages (navigation, not health proof), accepts an
   API key only through a local masked TUI that never enters model/session/log/test output, and
   atomically updates exactly `providers.<id>.apiKey` in `web.yaml` with mode `0600` after a fixed
   redacted preview and explicit plaintext-storage confirmation. `/web-doctor` remains read-only and
   network-free; `/skill:websift-setup` is the guided/headless fallback. Native usage retrieval is
   explicit and limited to the already-grounded Linkup balance operation plus Tavily's official
   `/usage` endpoint; one provider's failure does not suppress the other. ADR 4.1 and `AGENTS.md`
   were reconciled so the no-secret rule explicitly permits this local masked command boundary while
   continuing to forbid secrets in conversation, skill, logs, notifications, tests, and session
   entries. Proven by `tests/provider-control.test.mjs` (statuses, masked input, safe write,
   concurrent usage) and the full package suite. Opening the command performed no network calls,
   missing providers stayed healthy, and routing/fallback policy is unchanged. No full-screen
   dashboard, browser automation, secret-manager abstraction, persistent usage cache, new dependency,
   fifth tool, live credential check, or parallel Phase 5G work was built.
7. **Native fetch — DONE (Phase 5G, complete 2026-07-31):** HTTP/GitHub/PDF/model-free YouTube
   confirmed as the implemented, dispatched extraction baseline; reconciliation removed the dead
   `forceClone` option/branch and unused ffmpeg helpers and reclassified video frames/model extraction
   as deliberate exclusions. No new capability, dependency, or handler was added.

Each operation needs one representative request/response proof, not one test per field. Completion establishes apprenticeship eligibility, not public superiority. Add each provider's typed route only after the shared request shape survives observed agent use.

### Increment 6 — current conformance, token-efficient retrieval investigation, and skill preparation

1. **Closed 2026-07-31:** refreshed Exa Contents and search-content request/response handling away from deprecated `livecrawl`, `numSentences`, and `highlightsPerUrl`; added current freshness, query-guided highlights/summary, structure-aware text controls, per-URL status inspection, and cost retention. This proves the current contract without choosing public exposure or comparative role.
2. **Focused investigation complete 2026-07-31; architecture unselected:** an eight-source pilot compared Native readable/full retained content, codeweave-pi's existing section-projected QMD lexical path, and current Exa query-guided highlights. Native extraction succeeded 8/8. Local retrieval preserved fixed literal checks with stable selectors and 84.8% median character reduction but saved 0% on a flattened PDF; Exa preserved the checks with 83.1% median reduction and saved 98% on that PDF but returned no stable within-source locator and repeats provider work/cost per query. Nine Exa calls, including one evidence-triggered livecrawl correction, reported $0.009 total under the approved $0.05 ceiling. The result qualifies a complementary query/locator/widening design for interactive review; it does not authorize a websift→codeweave-pi dependency, automatic Exa routing, public schema, cache/index architecture, or superiority claim.
3. **Deterministic operation inventory complete 2026-07-31; live integration exercised 2026-08-01:** representative proofs cover reviewed HTTP/API request mappings, response envelopes, evidence classes, and shared failure/cancellation boundaries. The Pi package lookup proof reaches its real bounded registry request. GitHub clone/`gh`, PDF `unpdf`, and YouTube `yt-dlp` remain environment-dependent integration paths rather than synthetic unit seams; focused live apprenticeship has now exercised each. Conformance selects no provider role or guidance.
4. **Research-skill cutover and restarted-process proof complete 2026-07-31:** copied and compared the complete historical method under `.tmp/web-research-skill-migration/`, preserving 33/33 source files, 26 byte-identical files, all templates, six unchanged references, eligibility contracts, rejection mutation, source verification, compact state, and G0–G5 closure. After explicit `alehdezp` approval, moved the global owner to `/Users/example/.pi/agent/.skill_backups/research-pre-jeito-20260731` and installed `skills/research/` plus `skills/mini-research/`. Pi parser and package-resource proof found both package skills model-invocable with no duplicate; after reload, `alehdezp` confirmed both skills are present and working. Provider recommendations, first-use hooks, and expanded guidance now follow accepted apprenticeship recipes and targeted comparisons.

Stop for `alehdezp` before prototyping the complementary retrieval architecture, deciding generic-video scope, exceeding the remaining cumulative live-provider budget, or changing APPEND/final provider roles.

### Increment 7 — provider apprenticeship and targeted comparisons

Follow [`ADR 5.4 — provider apprenticeship and targeted selection`](adr/0005-provider-evaluation-and-guidance/0004-benchmark-and-selection.md). The 12/48 benchmark-first program and its unexecuted scaffold were removed on 2026-07-31 because they delayed practical provider guidance.

1. **Exa — operation packet complete 2026-07-31:** exercised keyword repair, neural/hybrid, publication filter, latency/deep modes, Contents text/highlights/summary/fresh sections, Answer, deprecated similarity, and legacy-Research discoverability. Current registered search/answer paths retain provider-reported cost; this establishes operation behavior, not final answer grouping or provider quality.
2. **Tavily — complete 2026-07-31:** upgraded the official SDK contract to 0.7.6, exposed current result-visible search controls including exact dates and credits, implemented bounded internal Research, and exercised five search modes/constraints plus Extract/Map/Crawl/Research. Query-guided Extract reduced one official page by 76.5%; native Research remains a scout.
3. **Linkup — operation packet complete 2026-08-01:** refreshed against current official docs; implemented domain/date Search filters, structured Search, raw Fetch, and bounded asynchronous Research; exercised depth-specific query shapes, sourced/structured output, static/rendered/raw Fetch, Research S, and exact balance accounting. This establishes schema and observed behavior; answer grouping, comparative value, and final public exposure remain owner-pending.
4. **Serper and X — complete 2026-08-01:** Serper's generally available specialist surface is implemented internally; xAI exact-date/handle/media calls expose one synthesis plus actual work and preserve no-winner text. Scoped call recipes are accepted; no default xAI model or comparative provider priority was selected.
5. **Context7 and catalogs — complete 2026-08-01:** Context7 normal/fast resolution, text/JSON context, ambiguous names, available-version pinning, and absent-version refusal were exercised live. SkillsMP stars/recent/filter behavior and npm-backed Pi package discovery were exercised as catalog-only leads. Accepted guidance now prefers Context7 text unless structured snippets matter, never selects the first ambiguous candidate or treats provider scores as authority, treats SkillsMP stars as repository popularity rather than skill quality, and keeps package installation outside `web_lookup`.
6. **Native/provider fetch — complete 2026-08-01:** live Native calls exercised structured HTML, Linkup documentation, GitHub root/blob, BrowseComp PDF, YouTube transcript, and the public retained-page path. The packet corrected a PDF byte/timeout bypass and added minute transcript locators. Native handled the sampled Linkup documentation without rendering; rendered fetch is recommended only after static output demonstrably misses required content. Query-aware retained passage narrowing is not part of the current public contract.

Use a small reusable set of hard situations—unknown vocabulary, exact current fact, paper plus implementation, first-hand social window, difficult extraction, and contradiction-heavy multi-hop research—to learn provider combinations. A targeted comparison is created only when two eligible routes still compete for one named decision. Live packets require an exact provider/mode/call/cost envelope before execution.

**Current checkpoint:** current-contract and focused execution packets exist for every installed provider and Native, but packet completion means calls ran—not that quality, value, or final roles are validated. The answer-evidence program contains 14 retained plus 36 new no-retry/no-fallback records; T08's four-row schema could not hold five required prices, T12 was unmatched, and first-two-source fetches proved transport rather than claim support. The owner accepted and implementation proved the model-visible answer boundary; current Linkup authority also isolated T04's equal-date HTTP 400 and both Tavily and Linkup now reject invalid bounds locally. The owner then selected lazy `web_exa_answer` and `web_linkup_answer` as the eventual public grouping, rejecting one conditional cross-provider `web_answer`, but deferred implementation and advanced guidance. The next work is coordinator-led apprenticeship on difficult, specific Exa and Linkup research topics; guidance may describe only named exercised scenarios and follows owner review. Conservative live-provider spend is **$3.659 of $5.00**, leaving **$1.341**.

#### Completed 2026-08-04 — predictable multi-source retrieval and asynchronous summaries

- Single-source contract: sources through ~5,000 tokens return completely; larger sources return the pi-nav smart-read source view (metadata + outline over the cache file; headers-only fallback when pi-nav is absent). Single-page `query_terms` keeps deterministic raw ranking.
- Multi-source contract: page/download/refresh and explicit Linkup batches settle every URL independently, stream cumulative updates, preserve partial failures, and render final source cards in authored order. `query_terms` never causes cross-source BM25. Multi-seed map maps every root; multi-seed crawl shares the existing 25-page/50-MB cap fairly instead of multiplying it.
- Summary contract: only `mode:"llm_answer"` invokes a model. It is async by default (a "generating, continue or wait" message, optional `wait:N`; 30s/call timeout) and persists answer + section summaries to an immutable intent-keyed sidecar; exact repeats reuse it and distinct objectives coexist. `query_terms` become model focus only. The only automatic model call is the single-URL rescue when `query_terms` finds no/weak quality match on a page over 5K tokens. Summary failure cannot erase or fail successful acquisition.
- Guidance ownership: the registered tool schema and one coherent guideline string own ordinary call construction. APPEND remains generic cross-tool evidence routing and is not a Web-operation owner.

#### Completed 2026-08-04 — source-grounded research brief and fetch recovery

- Replaced per-section LLM summaries and cost-gated prior-summary substitution with one task-adaptive research brief over current raw source content. Output order is Answer → validated Evidence → Read next → verified page-authored links → bounded inferred research opportunities → navigation; the answer remains visibly labeled synthesis.
- Deterministic validation derives cache lines from exact or one uniquely matching Markdown-normalized source quote, recovers a wrong source ID only when one source contains the quote, resolves section/link IDs, drops invented/ambiguous IDs, and maps GitHub repository-relative links through `blob/HEAD`. Summary policy advanced to `v6`.
- No public parameter or default repair call was added. The existing provider hierarchy shares one 15-second synthesis deadline; immediate failures can rotate, while a true timeout degrades to ranking. Integrated QMD proof completed in 5.762 seconds through OpenCode Go with three validated quotes, two next-read sections, a verified CHANGELOG link, two research opportunities, and navigation.
- Agent-trajectory weaknesses also closed locally: URL fields now say same-question sources belong in one call; 404/410 are non-retryable `not_found`; fetch timeout/network/empty recovery is operation-aware; and partial batches print per-URL next actions without discarding successful evidence.

### Increment 8 — public selection, guidance, and rollout

Use accepted apprenticeship recipes and targeted comparison results as scoped decision evidence. `alehdezp` interactively selects common fields, provider-specific branches, internal/documented-only operations, fallback roles, and cost/quality trade-offs. One call or task never creates a global provider winner.

Fetch-provider selection closed 2026-08-02 after 171 fixed-URL observations over 37 source cases and explicit owner review. Native remains the general default and owns GitHub/PDF/YouTube locator specialties. Tavily basic runs first for the accepted host/path families where it was materially richer for current AI/news/tool/regional research; otherwise it is one visible fallback after an eligible Native empty/thin extraction. Linkup static/rendered stays explicit because rendering rescued zero static failures across 16 candidates, and Tavily advanced stays explicit because it did not earn a general retry role. The same slice repairs origin 401/403 handling so a blocked website cannot disable credential-free Native session-wide.

Owner correction 2026-08-03 supersedes the nine-call packet recommendation. GCF generic-profile text is settled for structured provider results while native JSON stays internal. Current answer output reserves every provider-ordered source title, URL, evidence status, and provider in model-visible `sourceIndex` before answer/passages; passage records may be omitted whole with visible counts, never by silently losing identity. Structured answer data remains first, prose remains text, and full native results remain internal. Current endpoint authority also isolates strict Tavily/Linkup date ordering. Provider selection remains explicit and task-shaped rather than a universal winner.

After each accepted packet, update the smallest owning surfaces together under [`ADR 5.5 — tool schema, research skills, and APPEND guidance lifecycle`](adr/0005-provider-evaluation-and-guidance/0005-guidance-lifecycle.md): exact call construction in tool schemas; practical cross-call recipes in the shared websift playbook; W1/W2 and W3/W4 method in their skills; and only universal routing in APPEND. Preserve rejection memory, closure gates, primary-source fetching, and evidence rights independently of provider preferences.

The research-skill cutover is complete and live-verified. Keep `/Users/example/.pi/agent/.skill_backups/research-pre-jeito-20260731` as the rollback owner until final rollout is accepted; never restore it while package `research` remains load-eligible.

APPEND changes use `$op-edit-system-prompt`: preview, back up, confirm, edit, validate, and update the APPEND decision ledger in the same session. Keep legacy provider packages disabled. Apply host-owned configuration only through preview, exact backup, confirmation, atomic replacement, restart, and loaded-owner verification. Provider/SDK updates re-run contract conformance plus only the affected apprenticeship recipes or targeted comparisons.

## Minimal proof budget

[`ADR 3.2 — maintainability and claim-scoped verification`](adr/0003-engineering-stewardship/0002-maintainability-and-testing.md)
owns the detailed rules. The roadmap-level constraints are:

- prefer one Pi tool execution that proves schema input, provider translation,
  routing, evidence state, and model-facing output together;
- use one representative internal-operation proof for capability not exposed to
  agents;
- extend an owning test rather than creating a file per field or helper;
- new proof code should normally be smaller than the implementation it protects;
- reuse stable routing, retained-content, registration, cancellation, and
  credential gates unless the change can affect them;
- run the full package suite only at a coherent provider slice or rollout boundary;
- paid live checks are explicit and answer a compatibility question mocks cannot.

## Risks and controls

| Risk | Early signal | Control / contingency |
|---|---|---|
| Full capability turns into a framework project | new registries, generators, factories, or test DSLs appear before a second consumer | stop and implement the provider operation directly in its owner |
| Selective exposure becomes lost capability | an unexposed operation is omitted from the table or implementation | treat mapping, implementation, and exposure as separate checklist columns |
| Public schema becomes provider soup | fields require “only valid when provider X” prose at top level | move selected fields into one typed provider branch or keep them internal |
| Internal capability silently rots | provider version changes or representative request proof fails | mark the entry stale and refresh that provider before promotion or use |
| Tests dominate implementation | proof diff exceeds product diff for ordinary mapping | redesign one integrated proof; allow excess only for real safety/lifecycle risk |
| Billing exceeds visible intent | actual attempts exceed the announced plan | shared attempt budget; return partial results instead of hidden retries |
| Provider synthesis is mistaken for fetched evidence | citations carry provider-returned snippets but no independently fetched body | retain lead/catalog/provider-citation/fetched distinctions and fail evidence-required answers |
| Plan drifts toward “minimal demo” | a required provider operation is dropped as low value without a decision record | re-anchor to the complete-capability goal and preserve it internally |

## Execution control

- Status is accepted provider operations and working public behaviors, not percent
  complete or test count.
- After each provider increment, update the operation table, selection reason,
  provenance version, and next provider. Do not create a separate tracking system.
- A failed request-shape premise returns to the provider source; do not add adapter
  workarounds around an unverified contract.
- A public option that agents repeatedly misuse is constrained, renamed before
  release, or returned to internal status; implementation remains available.
- Two failed corrections under one schema design trigger a schema re-evaluation,
  not a third conditional patch.
- The current resumable release queue lives in [`docs/WORK-PLAN.md`](WORK-PLAN.md);
  this roadmap records delivery history, not the live pickup order.

## First executable commitment

The immediate boundary is a coherent Git checkpoint for the already-landed web
extension and root integration changes. After that, audit the current research skill as
the historical guidance baseline, complete Tavily, and land the typed Exa–Tavily plus
repeated-provider request slice. Run the schema-usability experiment before Linkup or
other provider branches depend on that shape. Do not run live calibration without an
explicit maximum provider-call and cost authorization, and do not cut over the global
`research` skill or mutate APPEND without the required user preview and confirmation.
