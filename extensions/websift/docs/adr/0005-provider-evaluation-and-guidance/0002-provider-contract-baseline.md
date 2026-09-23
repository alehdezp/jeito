---
title: "ADR 5.2 — Previous tools and current provider contract baseline"
description: "Accounts for previous provider operations and installed contracts; historical public-route descriptions are explicitly superseded by ADR 1.3's current provider/method tools."
tags: [jeito-websift, adr, providers, sdk, capability-baseline, parity]
created: 2026-07-28
updated: 2026-08-11
status: active
adr_id: ADR-005.002
adr_type: child
decision_status: accepted
confidence: evidence-backed
evidence_grade: mixed
implementation_status: in-progress
decision_owner: alehdezp
owns: "Previous-tool to current-provider capability accounting"
audience: contributor
parent: docs/adr/0005-provider-evaluation-and-guidance/README.md
code: [src/registry.ts::AdapterRegistry, src/tools/web-search.ts, src/tools/web-fetch.ts, src/tools/web-answer.ts, src/tools/web-lookup.ts, src/adapters/exa.ts, src/adapters/tavily.ts, src/adapters/linkup.ts]
related: [docs/upstreams/README.md, docs/ROADMAP.md]
---

# ADR 5.2 — Previous tools and current provider contract baseline


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-005 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: evidence-backed`, `evidence_grade: mixed`, and `implementation_status: in-progress`. The metadata—not optimistic prose—governs whether dependent work may treat the decision as proved.

**Current runtime authority:** [ADR 1.3](../0001-product-and-evidence/0003-core-search-and-provider-specialists.md) supersedes every `web_search.requests[]`, generic provider selector, and cross-provider fallback description below. Those rows remain historical capability accounting, not executable call guidance. Current `web_search` is Serper-only; Exa/X/Tavily Search and Exa/Linkup Answer are separate one-provider tools.

## Accounting rule

A previous operation receives one of four outcomes:

- **public-common** — represented by a shared field or mode in one of the four tools;
- **public-provider** — represented by a typed provider branch because semantics differ;
- **internal-comparison** — implemented and callable by focused development/maintenance comparison code but not registered as a tool;
- **pending-source-review** — previous contract is recorded, but current installed SDK/source must be re-read before implementation or comparison.

These outcomes describe exposure, not quality. Accepted focused evidence plus owner review own quality and routing decisions.

## Exa previous surface

Source authority: previous `@capyup/pi-exa` 0.5.1 schemas plus installed `exa-js` 2.16.3 types, recorded in [`../../upstreams/exa.md`](../../upstreams/exa.md).

| Previous tool | Previous purpose and important controls | Current outcome | Decision state |
|---|---|---|---|
| `exa_search` | query; count; days/from/to; include/exclude domains; category; search type; highlights/full text; max characters; deep system prompt; structured output | current types/categories/date/domain/text/location/moderation/full-text/deep controls are implemented under the temporary `web_search.exa` route; provider-reported cost is retained; structured output remains internal; no replacement wrapper name or search/answer split is selected | focused keyword/neural/hybrid/fast/instant/deep/publication recipes exercised; wrapper naming and operation grouping reopened under ADR 1.3 |
| `exa_fetch` | URL batch; text/summary/highlights; max characters; livecrawl; subpages and target | implemented as internal `fetchExaContents`; current requests use `maxAgeHours`, `livecrawlTimeout`, `filterEmptyResults`, query-guided highlights/summary, and structure-aware text controls; responses retain per-URL status/error and cost metadata; deprecated `livecrawl`, `numSentences`, and `highlightsPerUrl` are not sent | internal-comparison; text/highlights/summary/fresh-section behavior exercised; public exposure remains unselected |
| `exa_similar` | seed URL; count; exclude source domain; highlights/full text | compatibility-only `findSimilarWithExa`; installed `exa-js@2.16.3` marks URL similarity deprecated and scheduled for removal with no direct replacement; one qualified-seed call returned mostly catalogs/directories rather than first-party repos | deprecated compatibility path; do not expose or teach |
| `exa_answer` | question; location/model/system prompt; citations | question/citations are public through `web_answer`; provider-reported cost is retained; current location, system prompt, and structured output are implemented internally | public common answer exercised; internal controls remain unselected |
| `exa_research` | instructions; fast/standard/pro model; maximum wait; structured output | create and bounded polling are implemented internally; current official docs center Agent API and an exact `exa-research-fast` docs lookup returned no result | do not run/expose until lifecycle, source observability, and price are grounded |

No retained-session direct-call evidence was found for the five old Exa names in the 66-file current session scope. This does not establish non-use. The old tool descriptions and `$research` guidance remain the apprenticeship baseline.

## Tavily previous surface

Source authority: current official Tavily Markdown docs, `@tavily/core` 0.7.6, and donor `@weihan28/pi-tavily` 1.0.2, recorded in [`../../upstreams/tavily.md`](../../upstreams/tavily.md).

| Previous tool | Previous purpose and controls | Current outcome | Decision state |
|---|---|---|---|
| `tavily_search` | four depth modes; count; general/news/finance; relative and exact dates; domains/country; answer; raw content; images; automatic parameters; exact match; chunks per source | public typed route exposes every result-selection/snippet/latency/credit distinction that survives normalization; answer/raw/images/automatic parameters remain internal; response time/request ID/credits are retained | exercised; basic beat advanced on the single official-Fed task, fast/ultra-fast both missed the exact docs page, and exact dates worked — guidance is task-scoped |
| `tavily_extract` | URL batch; basic/advanced; format; images; query-guided chunks | basic/advanced public-common via `web_fetch`; query/chunks and images internal; titles, failures, response time, request ID, and credits preserved | exercised; basic and advanced returned identical 9,877-character docs content; query-guided chunks reduced it to 2,323 characters while retaining the requested field group |
| `tavily_map` | root URL; instructions; depth/breadth/limit; path/domain selectors; external links; timeout | bounded map public-common through `web_fetch`; full typed controls internal; usage metadata retained | exercised; focused map found the two relevant docs URLs but took 13.9 seconds |
| `tavily_crawl` | map controls plus extraction depth, images, output format, content, chunks, usage/request ID | internal `tavilyCrawl`; bounded limit required; no tool registration | exercised; bounded instruction-guided crawl returned two fetched pages quickly but query chunks missed the four requested parameter names |
| Tavily Research | model; schema; citation format; domains; output length; files; async status/results | internal bounded `runTavilyResearch`; no tool registration; sources remain synthesis leads | exercised with mini; produced a readable eight-source report in 45.9 seconds but included claims not independently passage-verified, so it cannot satisfy fetched-evidence closure |

Historical `$research` guidance said Tavily is a second lane when topic/time/raw-content semantics matter and map should precede a focused crawl. Apprenticeship narrows this: use the current typed controls when they match the task, treat advanced as a relevance-cost option rather than an automatic winner, and use direct official `.md` pages before search/map/crawl when the URL is already known.

**Historical public branch selection (2026-07-31; superseded 2026-08-04):** `requests[].route.provider:"tavily"` supported `searchDepth`, finance topic, relative `timeRange`/`days`, exact top-level recency, country, 1-3 chunks per source, and exact match. Top-level domains/count/kind remained shared. Relative and exact time controls could not mix; country was general-only; explicit Tavily depth could not duplicate top-level depth; ultra-fast could not carry chunks. Reported usage credits were model-visible. Search answers/raw/images/automatic parameters, query-guided Extract, full Map/Crawl, and Research remained internal because their output/evidence/lifecycle did not fit that historical contract.
No provider-quality ranking is claimed; confidence and evidence grade remain unchanged without focused matched evidence.

## Linkup previous surface

Source authority: current official Linkup documentation and focused live behavior, recorded in [`../../upstreams/linkup.md`](../../upstreams/linkup.md). The installed `@aliou/pi-linkup` 0.11.0 donor remains historical contract evidence only; jeito calls the current HTTP API directly. Refreshed 2026-08-01.

| Previous/current operation | Purpose and controls | Current outcome | Decision state |
|---|---|---|---|
| `linkup_web_search` | query; fast/standard/deep; count; exact dates; include/exclude domains; search results | historical public-provider route on removed `web_search.requests[]`; current public Linkup Search is removed while Linkup Answer remains explicit | historical contract mapped and live-exercised; superseded by ADR 1.3 |
| `linkup_web_answer` | question; fast/standard/deep; dates; include/exclude domains; sourced answer | current explicit `web_answer_linkup` specialist; provider citations remain Candidate until fetched | retained by ADR 1.3 as a separate one-provider/no-fallback method |
| current structured Search | JSON Schema-shaped data plus optional sources | internal — `linkupStructuredSearch`; schema is required and response shape is validated | implemented and live-exercised; no public exposure without recurring need |
| `linkup_web_fetch` | URL; JavaScript rendering; optional raw content | internal adapter capability; current `web_fetch` exposes no provider branch or renderJs control | retained internally; not a public tool contract |
| current Research | asynchronous mode, reasoning depth, dates/domains, sourced or structured output | internal — bounded `runLinkupResearch` create/poll path | implemented and live-exercised at S; scout only because synthesis does not replace fetched decisive passages |
| `linkup:balance` | remaining credits | internal maintenance — explicit `/web-setup` usage check only; never automatic startup or doctor work | current contract mapped |

**Current selective exposure:** `web_answer_linkup` is the explicit public Linkup method. Linkup Search, structured Search/Research, balance, and fetch controls remain internal or setup-owned; none is reachable through a generic provider selector. Promote another method only when recurring evidence proves a distinct caller-visible contract.

**Current pricing is verified.** The official pricing page fetched on 2026-08-01 and exact balance deltas matched it: fast/standard Search results `$0.005`, corresponding sourced/structured output `$0.006`, deep results `$0.05`, deep sourced/structured `$0.055`, Fetch `$0.001` static or `$0.005` rendered, and Research S/M/L/XL `$0.25/$0.50/$1.50/$2.50`. Re-fetch before consequential paid work. Pricing and scoped behavior inform recipes but do not establish comparative provider priority; that remains an interactive targeted-selection decision under [ADR 5.4](0004-benchmark-and-selection.md).
## X, Serper, catalogs, and native fetch

| Provider | Previous capability | Current outcome | Decision state |
|---|---|---|---|
| X/xsearch | query; inclusive exact dates; up to 20 allowed or excluded handles; model/media settings; Responses controls; synthesis/citations/usage | public social route exposes dates/handles and now emits one bounded synthesis plus model/token/tool-call work; model/media and Responses controls stay internal because media changes token work and internal bounds do not cap server-side search calls | current contract and live packet complete; exact-date/handle recipe evidence-backed, default model and comparative role unmeasured |
| Serper | Google Search plus current Images/Videos/Places/News/Shopping/Scholar/Patents/Autocomplete/Maps/Reviews/Lens/Webpage platform | public route remains lexical Search with `country`/`language`, strict count 10, credits, and bounded candidates; full Search controls and all generally available specialist operations are implemented through internal `serperOperation`; account-gated Product Reviews/Maps Autocomplete/Search Full/Bing excluded until accessible | current official frontend and live endpoint packet complete; exact lexical/locale recipe evidence-backed, comparative role unmeasured |
| Context7 | resolve library; version-aware docs; explicit ID/topic/page; retained raw docs | resolve (catalog) and version-pinned docs (fetched) are public through the `web_lookup` `source:"context7"` branch; `libraryId`/`topic`/`page`/`fast`/`responseType` exposed; complete raw body retained behind `responseId` via the shared `web_fetch` path; donor disk cache excluded (session-scoped retention reused) | docs lane complete (Phase 5C); compare correctness, not general web rank |
| SkillsMP | query/page/limit; sort; category; occupation; language; rate-limit headers | query/page/limit/`sortBy`/category/occupation/language are public through the `web_lookup` `source:"skillsmp"` branch; grounded `x-ratelimit-*` headers parsed to `details.rateLimits` (operational only); no undocumented response-pagination shape inferred | catalog lane complete (Phase 5D); discovery leads only, no quality or safety endorsement |
| Pi packages | registry query/size and inert install command | discovery is public; installation remains excluded | settled boundary |
| native fetch | HTTP/readable/markdown/raw; GitHub/PDF/YouTube/media handlers; retained content | public baseline fetch and specialized handlers | baseline for extraction comparisons |

**X/xsearch disposition (refreshed 2026-08-01).** Public date/handle citation leads remain selective, with the official handle ceiling raised from donor 10 to current 20. Focused calls disproved the claim that `maxTurns:1`, `parallelToolCalls:false`, and `maxOutputTokens:1000` form a tight cost ceiling: successful requests reported 10–14 X searches and 1,800–2,208 output tokens. Public output now shows one bounded synthesis plus provider-reported model/tokens/tool calls rather than repeating synthesis per citation; citation-free no-winner synthesis survives in the failure. Media/model controls remain internal. No default-model or comparative provider role is selected.

**Context7 disposition (Phase 5C, 2026-07-29).** Re-reviewed installed `@dreki-gg/pi-context7` 0.2.0 (declared MIT, no LICENSE file shipped; equals the latest published version, checked 2026-07-29) against the official Context7 Public API v2.0.0 reference and recorded the full contract in [`../../upstreams/context7.md`](../../upstreams/context7.md). Public, through the `web_lookup` `source:"context7"` branch of a source-discriminated union: `query`, `library`, `version`, `page`, and a closed `context7` options object — `mode` (`docs` default \| `resolve`), `libraryId` (exact ID, bypasses resolution, authoritative), `topic` and `page` (donor-compatible query steering encoded into the effective query, not independent server params), `fast` (official lower-latency/lower-reranking flag), and `responseType` (`txt` default \| `json`, the official `type` param). Resolve mode returns catalog candidates (`fetched:false`, no `responseId`), applies requested versions to candidate filtering, and rejects docs-only controls. Docs mode resolves conservatively—one candidate or one unique exact title/final-ID match; provider scores never authorize a guess—pins a requested version via the official `@<version>` library-ID suffix (or returns candidates with `versionNotFound` rather than fetching unversioned docs), validates the official library-ID and JSON-response shapes, fetches the documentation (`fetched:true`) under a timeout that includes body consumption, inlines a bounded excerpt, and retains the complete raw body behind a `responseId` retrieved through the existing `web_fetch({responseId})` path. Candidate metadata preserves Context7's own `trustScore`/`benchmarkScore` indicators—never presented as jeito comparative provider quality. Excluded-with-reason: the donor's independent on-disk cache and stale-cache fallback—jeito reuses the session-scoped `storeFetched`/`responseId` retention instead of a Context7-specific cache. `limit` is rejected on the Context7 branch (no grounded meaning). No comparative quality or routing-priority claim is made—those belong to [ADR 5.4](0004-benchmark-and-selection.md).

**SkillsMP disposition (Phase 5D, 2026-07-29).** Re-reviewed the first-party `@alehdezp/skillsmp-search` 0.1.0 source against the official SkillsMP API docs (`https://skillsmp.com/docs/api`, accessed 2026-07-29) and recorded the full contract in [`../../upstreams/skillsmp.md`](../../upstreams/skillsmp.md). Public, through the `web_lookup` `source:"skillsmp"` branch: `query`, `page` (default 1), `limit` (default 20, 1–100), `sortBy` (`stars` default \| `recent`), `category`, `occupation`, and detected-content `language` (ISO codes plus documented `mul`/`und`). Controls are trimmed and bounded before the call; blank query or supplied blank filters are rejected; omitted filters are not sent. The focused `skillsMpSearch` boundary covers response-body timeout, parses grounded `x-ratelimit-*` headers into `details.rateLimits`, and normalizes grounded record fields. The official docs define page/limit request parameters but no response-pagination object, so `total`/`totalPages`/`hasMore` are not inferred. Output is **catalog evidence only** (`fetched:false`, no `responseId`); rate metadata is operational, not ranking. The adapter makes no quality, license, safety, compatibility, or install endorsement. No comparative quality or routing-priority claim is made—those belong to [ADR 5.4](0004-benchmark-and-selection.md).

**Historical Serper disposition (Phase 5E, 2026-07-30; superseded surface):** Re-reviewed the first-party `@alehdezp/serper-search` 0.1.0 source against accessible official Serper material and recorded the full contract in [`../../upstreams/serper.md`](../../upstreams/serper.md). The former `web_search.requests[].route serper` branch exposed query/count/country/language. Current ADR 1.3 instead exposes Serper directly through `web_search` with query aliases, optional country, fixed 10 leads, no routing/fallback, and lead-only `answerBox`/`knowledgeGraph` metadata.

## Capability-map completion gate

The baseline is complete only when each pending row is refreshed against the installed SDK/source, its request and response fields are listed in the provider provenance document, and the operation is executable through either the public tool or internal comparison boundary. Quality remains unclaimed until focused evidence plus owner review supports it.

## Phase 1 audit: historical guidance crosswalk

Every consequential recommendation from the global research skill and completed Atlas architecture investigation has a stable `HG-<LANE>-NN` identifier. In source selectors below, `RESEARCH_ROOT` is `/Users/example/.pi/agent/skills/research` and `ATLAS_ROOT` is `/Users/example/atlas/research/pi-systems/tool-runtime/design-owned-web-retrieval-stack`; `path::Heading` names an exact section and `path:line` names an exact source row. Universal invariants appear in [ADR 5.5](0005-guidance-lifecycle.md); apprenticeship exercise and non-comparison proof mapping appears in [ADR 5.4](0004-benchmark-and-selection.md).

`user-stated` records that the owner authored and required this historical guidance. It does not claim comparative truth: provider and operational hypotheses remain unmeasured until their mapped cases run.

### Provider-comparative hypotheses

| HG ID | Exact source selector(s) | Normalized claim | Provenance / confidence / evidence limit | Contract | Later owner |
|---|---|---|---|---|---|
| HG-LEXICAL-01 | `RESEARCH_ROOT/methodology.md::official`, `::freshness`; `RESEARCH_ROOT/references/web-tools-playbook.md::Google-style freshness/provenance search` | Lexical/Serper preferred for exact names, official pages, dates, criticism, provenance | historical user-authored guidance / user-stated / comparative quality unmeasured | supported | Pi schema + shared reference + ADR |
| HG-EXA-01 | `RESEARCH_ROOT/methodology.md::semantic`; `RESEARCH_ROOT/references/web-tools-playbook.md::Exa semantic/hybrid search` | Exa semantic/hybrid preferred for unfamiliar vocabulary, renamed concepts, adjacent fields | historical user-authored guidance / user-stated / comparative quality unmeasured | supported | Pi schema + shared reference + ADR |
| HG-EXA-02 | `RESEARCH_ROOT/references/web-tools-playbook.md::Exa semantic/hybrid search`; `RESEARCH_ROOT/references/search-steering.md:198` | Exa similarity only from a seed that passed hard fit | historical user-authored guidance / user-stated / seed-quality effect unmeasured | supported through internal `findSimilarWithExa` | Pi schema + shared reference + ADR |
| HG-EXA-03 | `RESEARCH_ROOT/references/web-tools-playbook.md::Exa semantic/hybrid search`, `::Autonomous/deep research tools` | Exa answer/research/deep as scouts requiring primary-source verification | historical user-authored guidance / user-stated / scout quality unmeasured | partially represented: answer public, research internal | Pi schema + shared reference + ADR |
| HG-TAVILY-01 | `RESEARCH_ROOT/references/web-tools-playbook.md::Tavily search/crawl/map` | Tavily as second discovery lane when topic/time/raw-content controls fit | historical user-authored guidance / user-stated / comparative quality unmeasured | implemented: general/news public; finance/time/raw/images/answer internal typed | Pi schema + shared reference + ADR |
| HG-X-01 | `RESEARCH_ROOT/references/web-tools-playbook.md::X/social search`; `RESEARCH_ROOT/references/social-and-gated-sites.md::X`; [`../../upstreams/xsearch.md`](../../upstreams/xsearch.md) | Native X with exact dates/handles for first-hand social evidence | historical user guidance plus focused live exercise / evidence-backed date-and-handle construction / comparative quality unmeasured | public exact dates and up to 20 handles; sampled citation dates independently verified from X snowflake IDs | Pi schema + shared reference + ADR |

### Operational and tool-design hypotheses

| HG ID | Exact source selector(s) | Normalized claim | Provenance / confidence / evidence limit | Contract | Later owner |
|---|---|---|---|---|---|
| HG-CRAWL-01 | `RESEARCH_ROOT/references/web-tools-playbook.md::Tavily search/crawl/map`; `RESEARCH_ROOT/methodology.md::crawl` | Map before crawl when site structure is unknown | historical user-authored guidance / user-stated / task efficiency unmeasured | implemented: bounded map public; crawl internal | Pi schema + shared reference + ADR |
| HG-CRAWL-02 | `RESEARCH_ROOT/references/web-tools-playbook.md::Tavily search/crawl/map` | Constrain crawl to selected paths rather than crawling an entire documentation site | historical user-authored guidance / user-stated / relevance-cost trade-off unmeasured | implemented: select_paths/exclude_paths in internal crawl controls | Pi schema + shared reference |
| HG-LINKUP-01 | `RESEARCH_ROOT/references/web-tools-playbook.md::Linkup search/answer/fetch`; [`../../upstreams/linkup.md`](../../upstreams/linkup.md) | Render only after static Fetch returns shell, empty, or failure | historical user guidance plus focused same-URL live exercise / evidence-backed for the scoped recipe / not a universal extractor ranking | implemented public; app shell required rendering while static docs were identical and faster without it | Pi schema + shared reference + ADR |
| HG-LINKUP-02 | `RESEARCH_ROOT/references/web-tools-playbook.md::Linkup search/answer/fetch`; [`../../upstreams/linkup.md`](../../upstreams/linkup.md) | Fast uses keyword-shaped lookup; standard handles one-step retrieval; deep is reserved for ordered iterative work | current official contract plus focused live exercise / evidence-backed for query construction / no cross-provider ranking | implemented; deep cost ten times raw fast/standard Search | Pi schema + shared reference + ADR |
| HG-RESEARCH-01 | `RESEARCH_ROOT/SKILL.md::Non-negotiable research standard` item 3; `RESEARCH_ROOT/references/web-tools-playbook.md::Autonomous/deep research tools`; [`../../upstreams/linkup.md`](../../upstreams/linkup.md) | Autonomous/deep Research is a scout, never final evidence | historical user-authored guidance plus live Exa/Tavily/Linkup exercises / evidence-backed evidence-right boundary | internal Research operations; fetched primary passages still own closure | shared reference + ADR |
| HG-CATALOG-01 | `RESEARCH_ROOT/references/web-tools-playbook.md::Context7/versioned library documentation`; `RESEARCH_ROOT/methodology.md::official` | Use version-aware library documentation before coding against unfamiliar APIs | historical user-authored guidance / user-stated / correctness checked only against pinned version | name/version docs public under `web_lookup` | Pi schema + shared reference + ADR |
| HG-FETCH-01 | `RESEARCH_ROOT/references/web-tools-playbook.md::Known URL and primary-source fetching` | Prefer specialized repository/media handling only when materially better than native fetch | historical user-authored guidance / user-stated / quality advantage unmeasured | native baseline plus specialized handlers implemented | Pi schema + shared reference + ADR |

### Atlas architecture and stewardship decisions — not provider-quality benchmarks

The Atlas investigation explicitly did **not** benchmark provider quality or latency (`ATLAS_ROOT/FINDINGS.md::Limits and uncertainty`). These records preserve its consequential architecture decisions individually rather than laundering them into provider rankings.

| HG ID | Exact source selector(s) | Normalized claim | Provenance / confidence / evidence limit | Current relationship | Later owner |
|---|---|---|---|---|---|
| HG-ARCH-01 | `ATLAS_ROOT/FINDINGS.md::Current answer`; `ATLAS_ROOT/ROUTES.md:7`; `ATLAS_ROOT/EVIDENCE.md::Claim: a supported wrapper cannot execute registered upstream tools` | Own orchestration and thin adapters instead of wrapping independently registered tools | historical user-authored guidance / evidence-backed / Pi API evidence is version-bound | implemented; recheck if Pi adds supported tool execution | ADR 2.1 + provider adapters |
| HG-ARCH-02 | `ATLAS_ROOT/FINDINGS.md::Key findings` item 6 | Preserve four public evidence verbs rather than one giant tool or provider-named surface | historical user-authored guidance / evidence-backed / schema usability still unmeasured | implemented; Phase 4 tests agent usability | ADR 1.2 + Pi schemas |
| HG-ARCH-03 | `ATLAS_ROOT/FINDINGS.md::Key findings` item 5; `ATLAS_ROOT/ROUTES.md:11` | Use capability metadata and concise model guidance; do not let brittle intent regexes or one fixed chain own routing | historical user-authored guidance / evidence-backed / route quality unmeasured | partially implemented | ADR 2.1–2.2 + Pi schemas |
| HG-ARCH-04 | `ATLAS_ROOT/FINDINGS.md::Key findings` item 7 | Keep credentials host-owned and expose presence-only diagnostics instead of inventing a secret manager | historical user-authored guidance / evidence-backed / live credential health unproved | implemented through config and `/web-doctor` | ADR 2.4 + ADR 4.1 |
| HG-ARCH-05 | `ATLAS_ROOT/FINDINGS.md::Key findings` items 8 and 10 | Maintain provenance and explicit upstream drift review; never auto-merge upstream changes | historical user-authored guidance / evidence-backed / future upkeep effectiveness unmeasured | provenance ledger and maintenance skill implemented | ADR 4.2–4.3 |
| HG-ARCH-06 | `ATLAS_ROOT/FINDINGS.md::Key findings` item 9; `ATLAS_ROOT/OBJECTIVE.md::Out of scope` | Keep authenticated, side-effect-capable browser automation outside ordinary read-only retrieval | historical user-authored guidance / evidence-backed / future read-only integration remains open | preserved boundary | ADR 1.1 + ADR 4.3 |
| HG-ARCH-07 | `ATLAS_ROOT/EVIDENCE.md::Claim: evidence-quality orchestration is valuable but its source cannot be casually ported`; `ATLAS_ROOT/ROUTES.md:10` | Reuse AGPL concepts only as requirements; do not copy source without an explicit license decision | historical user-authored guidance / evidence-backed / license conclusion is version-bound, not legal advice | no AGPL source copied | ADR 4.3 + notices/provenance |
| HG-ARCH-08 | `ATLAS_ROOT/ROUTES.md:12`; `ATLAS_ROOT/OBJECTIVE.md::Drift warnings` | Fallback must be bounded and visible; abort, policy, invalid-input, SSRF, and explicit-provider failures do not silently route elsewhere | historical user-authored guidance / evidence-backed / failure coverage remains operation-scoped | implemented in routing/failure policy | ADR 2.2 |

HG-ARCH-01–08 are architecture or stewardship claims. Their owning proof is current source, focused conformance, licensing/provenance review, or the Phase 4 agent-schema experiment—not provider-versus-provider ranking.

## Alternatives and decisive trade-off

Implementing only fields already exposed would make apprenticeship unable to challenge the old surface. Publishing every SDK field would burden agents before need is demonstrated. Complete internal accounting plus selective typed exposure preserves capability without forcing every operation into the public schema.

## Evidence and verification

All reviewed provider families now have source-grounded public, internal, or excluded-with-reason dispositions, and the current Exa Contents request/response contract is mapped. Completion remains `in-progress` because focused provider apprenticeship and comparative roles/public selection remain owned by ADR 5.4 plus interactive `alehdezp` review.

## History

- 2026-07-28: Preserved the existing decision while moving it into the numbered master/child ADR hierarchy.
- 2026-07-29: Phase 3 exposed Tavily `topic:"finance"` and relative-time (`timeRange`/`days`) controls through the advanced `requests[].route tavily` branch; discarded-effect controls stay internal. No provider-quality promotion.
- 2026-07-29: Phase 5A completed the Linkup contract — public-provider `linkup` search route and `linkup:{renderJs}` fetch branch, public-common answer via the generic `provider` field (no typed branch), and internal `linkupGetBalance`. Pricing kept version-bound (live pricing page not machine-verifiable). No provider-quality promotion.
- 2026-07-29: Phase 5B completed the X/xsearch contract — public-provider `xsearch` search route exposing handle filters (`allowedHandles`/`excludedHandles`, max 10, mutually exclusive, normalized with a visible warning) under a forced `kind:"social"` route, with calendar-validated exact dates; `model` and image/video flags kept internal-comparison. No provider-quality promotion.
- 2026-07-29: Phase 5C completed the Context7 contract — `web_lookup` became a source-discriminated union; the `source:"context7"` branch exposes resolve (catalog) and version-pinned docs (fetched) with `libraryId`/`topic`/`page`/`fast`/`responseType`, safe resolution (the donor's silent first-candidate fallback removed), official `@<version>` library-ID pinning, and complete raw-body retention behind `responseId` via the shared `web_fetch` path; the donor's on-disk cache is excluded in favor of session-scoped retention. No provider-quality promotion.
- 2026-07-29: Phase 5D completed the SkillsMP contract — `web_lookup(source:"skillsmp")` exposes query/page/limit/sort/category/occupation/language, parses grounded rate headers into operational `details.rateLimits`, and returns catalog evidence only; undocumented response-pagination fields are not inferred. No quality, safety, install, or provider-quality promotion.
- 2026-07-30: Phase 5E completed the Serper contract — a closed `web_search.requests[].route serper` branch exposes grounded Google lexical search with `country`/`language` locale controls, `count` capped at the grounded 10 (forced over-10 rejected, not truncated), organic leads plus bounded `answerBox`/`knowledgeGraph` candidates in `details.serper` (lead-only, never evidence, never quality); `autocorrect`/`tbs`/`page` excluded as not grounded for public exposure; the shared `redactCredential` helper was extracted into `src/failures.ts`. No quality, safety, install, or provider-quality promotion.
- 2026-07-31: refreshed Exa Contents conformance against installed `exa-js@2.16.3` and the official Contents contract; current freshness/query/text controls, per-URL statuses, and cost metadata are represented while deprecated request fields are removed. Contract mapping is closed; extraction quality, routing, public exposure, and guidance remain apprenticeship- and owner-pending.
- 2026-07-31: refreshed xAI against current Responses/pricing docs and added internal-only request bounds for focused comparison cost control; public xsearch behavior and provider guidance remain unchanged.
- 2026-08-01: refreshed Linkup against current official Search/Fetch/Research/pricing docs; mapped exact dates, domains, structured Search, raw Fetch, and asynchronous Research; exercised depth-specific query shapes, static/rendered/raw Fetch, and Research S with exact balance accounting. Promoted only scoped call-construction recipes, not comparative priority.
- 2026-08-01: corrected the Serper baseline after the current official playground exposed a materially wider generally available surface than the absorbed 0.1.0 adapter. Implemented and live-exercised full Search controls plus twelve specialist operations internally, retained provider credits, kept the public route narrow, and excluded only account-gated operations. No comparative priority promotion.
- 2026-08-01: exercised current xAI X Search with exact dates, allowed/excluded handles, current/donor models, and image/video understanding. Corrected the official handle cap to 20; disproved the assumed one-turn cost ceiling; exposed one bounded synthesis plus usage; preserved citation-free no-winner text and work. No default-model or comparative priority promotion.
- 2026-08-02: removed the provisional `exa_search` specialist before activation after owner review reopened `web_<provider>` versus `web_<provider>_<operation>`, common answer normalization, and JSON/CFG structured-output design. Grounded Exa implementation remains intact under the current surface.
