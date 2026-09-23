---
title: "ADR 5.4 — Provider apprenticeship and targeted selection"
description: "Learn each provider through current source review and focused real calls, promote practical recipes into schemas and research guidance, and use bounded comparisons only for unresolved decisions."
tags: [jeito-websift, adr, provider-apprenticeship, targeted-comparison, research-guidance, cost]
created: 2026-07-28
updated: 2026-08-10
status: active
adr_id: ADR-005.004
adr_type: child
decision_status: accepted
confidence: user-stated
evidence_grade: mixed
implementation_status: in-progress
decision_owner: alehdezp
owns: "Provider apprenticeship, focused comparison, practical recipes, cost authorization, and interactive public selection"
audience: contributor
parent: docs/adr/0005-provider-evaluation-and-guidance/README.md
related: [docs/ROADMAP.md, docs/adr/0005-provider-evaluation-and-guidance/0002-provider-contract-baseline.md, docs/adr/0005-provider-evaluation-and-guidance/0003-multi-provider-search-schema.md, docs/adr/0005-provider-evaluation-and-guidance/0005-guidance-lifecycle.md, skills/research/references/web-tools-playbook.md]
---

# ADR 5.4 — Provider apprenticeship and targeted selection

## ADR parent and current state

This decision inherits the complete-capability and evidence boundaries from [ADR-005 — provider evaluation and guidance](README.md). It does not inherit provider roles or comparative confidence from sibling ADRs.

`alehdezp` replaced the prior benchmark-first plan on 2026-07-31. Current metadata is `decision_status: accepted`, `confidence: user-stated`, `evidence_grade: mixed`, and `implementation_status: in-progress`. The implementation is useful now, but provider recipes, schema exposure, defaults, and guidance remain provisional until exercised.

## Decision

jeito learns providers through **apprenticeship**:

1. read the current installed SDK/source and the previous extension schema;
2. exercise each behaviorally distinct operation or mode with a focused real call;
3. record the exact valid call, visible result difference, evidence class, failure, latency, and grounded cost;
4. use hard research situations to learn combinations and stopping rules;
5. promote accepted lessons directly into tool descriptions, `mini-research`, `$research`, and concise APPEND guidance;
6. run a targeted comparison only when two eligible routes still compete for one named decision.

The product is the four tools plus learned operating guidance—not a benchmark runner, corpus, leaderboard, or grading system.

## Objective and observable success

The extension succeeds when an agent can use `web_search`, `web_fetch`, `web_answer`, and `web_lookup` intelligently on recent, novel, strange, social, video, academic, code-heavy, and long-tail research:

- choose a suitable provider and mode;
- construct a valid advanced call on the first attempt;
- narrow dates, domains, handles, categories, and query vocabulary correctly;
- combine providers only when they contribute different evidence;
- treat search, synthesis, and catalogs as leads until the owning evidence path promotes them;
- fetch the smallest authoritative evidence needed;
- preserve contradictions, rejected leads, uncertainty, provenance, and cost;
- stop or widen for a named reason.

## What survives from the benchmark work

The discarded benchmark program exposed useful constraints that remain active:

- provider behavior, schema usability, fetch fidelity, synthesis quality, and full research behavior are different claims;
- one task cannot establish a universal provider winner;
- token reduction counts only after evidence fidelity and locators pass;
- candidate provider output cannot create its own reference truth;
- validation failures are interaction waste but zero provider spend;
- cost and latency remain decision evidence for `alehdezp`, never hidden automatic suppression.

The scenario taxonomy also survives as a source of hard tasks: exact provenance, uncertain vocabulary, academic/code origin, current/news/finance, first-hand social evidence, structured/JavaScript/PDF/YouTube extraction, bounded site traversal, and contradiction-heavy multi-hop synthesis.

## Provider apprenticeship record

Each meaningfully distinct mode earns one compact record in the owning guidance after execution:

```text
Research situation:
Use when:
Avoid when:
Exact valid call:
What the controls change:
Evidence returned:
Observed strengths and losses:
Failure or malformed-call recovery:
When to combine another route:
Observed latency and grounded cost:
Public, internal, deferred, or rejected:
Evidence date/version and reopen condition:
```

Do not create one record per field or SDK default. Combine fields that belong to one real call. A source-reviewed but unexecuted hypothesis stays labeled as such and does not become active guidance.

## Apprenticeship sequence

### 1. Exa

Exercise keyword, neural, hybrid, fast, deep, and deep-reasoning search where the mode changes retrieval; date/category/text controls; query-guided Contents and full text; similarity from a qualified seed; Answer; and Research only after its request ceiling and cost are bounded. Current code owners include `src/adapters/exa.ts::fetchExaContents`, `findSimilarWithExa`, and `runExaResearch`, plus the typed Exa branch in `src/tools/web-search.ts`.

#### Exa packet A — source/schema comparison complete, authorized under the owner budget

Current `exa-js@2.16.3`, `src/adapters/exa.ts`, the installed `@capyup/pi-exa@0.5.1` five-tool schema, the active research playbook, and official Exa Contents/pricing pages were compared on 2026-07-31. The old extension exposed search, fetch, similarity, answer, and research directly; jeito already maps the current Exa contract more accurately but exposes only advanced search and common answer behavior. Contents, similarity, Exa-specific answer controls, and Research remain internal until focused calls show their evidence/result distinction is useful through a coherent public verb.

The first paid packet is seven independent operations with no retry, fallback, Pi model request, or research job:

| Call | Exact intent | Decision served | Maximum known cost |
|---|---|---|---:|
| S1 | `web_search` forced Exa `searchType:"keyword"`, count 5, query `exa-js 2.16.3 npm GitHub`, domains `npmjs.com` + `github.com` | exact identity/provenance recipe | $0.007 |
| S2 | forced Exa `searchType:"neural"`, count 5, query `An open-source system that lets coding agents search current web sources by semantic meaning, retrieve query-focused passages, and preserve citation URLs without relying on exact vocabulary` | semantic candidate shape | $0.007 |
| S3 | same S2 query with `searchType:"hybrid"` | whether hybrid materially repairs neural precision/coverage | $0.007 |
| S4 | forced Exa `searchType:"deep-lite"`, count 5, query `Find current official Exa documentation and source showing how query-guided Contents highlights are configured, which parameter names are current, and which old highlight or livecrawl fields are deprecated`; `systemPrompt:"Return only official Exa documentation or exa-js source leads; prioritize current parameter names and migration notes."`; `additionalQueries:["Exa Contents highlights query maxCharacters official", "exa-js deprecated numSentences highlightsPerUrl livecrawl current replacement"]` | deep-control value on one hard current-source task | $0.012 |
| C1 | internal `fetchExaContents`, official Contents Retrieval URL, text mode, `maxCharacters:2000` | bounded full-text wording and structure | $0.001 |
| C2 | same URL, highlights mode, query `Which content modes are extractive or abstractive, and which highlight controls are current?`, `maxCharacters:1200` | query-guided narrowing fidelity versus C1 | $0.001 |
| A1 | `web_answer` forced Exa, answer mode, `requireFetched:false`, asking which Contents modes are extractive versus abstractive | citation/evidence-state behavior for short sourced answers | $0.005 |

Official pricing fetched from `https://exa.ai/pricing` on 2026-07-31: Search $7/1k requests, Deep Search $12/1k, Contents $1/1k pages, Answer $5/1k. Therefore the exact known ceiling is **7 provider operations and $0.040**. Raw responses go only to `.tmp/exa-apprenticeship-20260731/`. Stop the packet on credential/auth/rate-limit/schema drift; report partial results and actual provider-reported cost. Similarity and Research are deliberately excluded until their current price/request ceiling and source observability are grounded. On 2026-07-31 `alehdezp` authorized a cumulative **$5.00 aggregate live-provider budget across all providers**. Continue autonomously under the remaining aggregate ceiling; never interrupt for approval of an individual amount at or below $0.01, and ask again only before a call that could exceed the remaining $5.00 budget or another non-cost stop boundary.

#### Exa packet A results and focused extensions

Twenty-three Exa operations were exercised for **$0.169 reported or conservatively reserved**, leaving $4.831 of the owner budget. Raw provider responses and the spend ledger are in `.tmp/exa-apprenticeship-20260731/`.

- **Exact identity:** a broad keyword query returned one canonical repo plus four irrelevant GitHub issues. Quoting the repository identity and adding `includeText:"2.16.3"` returned only the canonical repo. Exact package-version proof still belongs to the npm registry, not web ranking.
- **Semantic discovery:** on one descriptive web-research-agent query, hybrid returned five directly relevant search/research-agent repositories; neural returned a broader neighborhood that included a code-search false positive and general deep-research systems. Treat this as a scoped recipe, not a universal win.
- **Source-type narrowing:** `category:"publication"` plus a two-year freshness window returned ten paper/preprint leads rather than general pages.
- **Latency modes:** direct same-query calls returned five official Exa pages at $0.007 each; instant took 222 ms and fast 355 ms in this single run. Official semantics—not one timing sample—own the durable distinction.
- **Deep modes:** deep-lite took 4.2 s/$0.012, deep 3.7 s/$0.012, and deep-reasoning 11.3 s/$0.015 on the same current-documentation task. All returned five official sources; deep-reasoning added a relevant changelog but did not improve the ordinary lookup enough to justify its extra latency here.
- **Contents:** query-guided highlights returned the needed extractive/abstractive distinction and current controls in 233 ms/$0.001 with less surrounding text than bounded text (349 ms/$0.001). Summary produced a useful scout in 5.2 s/$0.001 but is abstractive and locator-poor. `maxAgeHours:0` plus section controls forced a crawl (1.2 s/$0.001) but did not improve this already-clean documentation page.
- **Answer:** Exa Answer returned the correct distinction with eight source records in 1.9 s/$0.005. Public search/answer initially dropped provider cost; the owning adapters/tools now retain and render `costDollars.total` when Exa supplies it.
- **URL similarity:** installed `exa-js@2.16.3` marks `findSimilar()` deprecated and scheduled for removal with no direct URL-based replacement. The compatibility call cost $0.007 and returned mostly catalogs/directories rather than first-party repositories. Keep the implementation compatibility-only and do not teach or expose it.
- **Legacy Research:** current official documentation centers the Agent API; an exact official-doc search for `exa-research-fast` returned nothing. Do not run or expose the legacy Research path until its current lifecycle, source observability, and price are grounded.

Accepted Exa call guidance belongs in the live schema and shared websift playbook. The observations above reopen when the SDK/version changes or a materially different task class contradicts them.

### 2. Tavily

Exercise basic versus advanced search, finance and relative-time controls, extract, map, crawl, and bounded research where eligible. Keep direct-search quality separate from traversal and synthesis. Current operations live in `src/adapters/tavily.ts`.

#### Tavily apprenticeship results

Sixteen Tavily operations were exercised. Provider usage metadata was inconsistent for batched Extract/Crawl accounting and the account usage endpoint did not update immediately after Research, so the spend ledger reserves the official maximum **$1.000** rather than understating cost. Cumulative Exa+Tavily spend is conservatively $1.169, leaving $3.831 of the owner budget.

- **Basic versus advanced:** on one current Federal Reserve finance query, basic returned the July 29 official FOMC statement first for one credit. Advanced cost two credits, omitted that current statement, and returned older June minutes among five results. Advanced is a coverage/relevance option, not an automatic quality winner.
- **Fast versus ultra-fast:** both returned five duplicate/fragmented LangChain integration pages rather than the exact Research API page. Ultra-fast took 238 ms versus fast 510 ms; speed did not repair query/source mismatch.
- **Exact dates:** a July 2026 news window was accepted and returned only July-dated results, closing the stale contract that rejected Tavily exact recency.
- **Extract:** basic and advanced returned the same 9,877-character official Research page; advanced added no content on this source. Query-guided extraction returned 2,323 characters (76.5% reduction) while retaining the requested domain/output/citation/file controls. The `.md` form failed provider extraction while the canonical page URL succeeded, so append-`.md` is an external fetch tactic, not a Tavily Extract recipe.
- **Map and Crawl:** instruction-guided Map found the two relevant documentation URLs but took 13.9 seconds. A bounded Crawl returned two extracted pages in 2.0 seconds but its focused chunks omitted requested parameter details. When the exact URL is known, direct Markdown fetch or query-guided Extract is better; Map then focused Crawl remains for genuinely unknown multi-page site structure.
- **Research:** mini produced a readable 2,808-character report with eight official source URLs in 45.9 seconds. It also asserted unverified properties such as “high-confidence excerpts” without claim-to-passage mapping. Keep it internal as a scout; source URLs and generated prose do not satisfy fetched-evidence closure.

Current official guidance recommends Search→Extract for grounded answers, advanced plus three chunks for quality-first discovery, Map before Crawl, conservative crawl depth/limit, and Research only when cited synthesis is the desired product. jeito adopts those as provider guidance with the observed exceptions above, not as comparative proof against other providers.

### 3. Linkup — exercised

Current Search date/domain filters, search-results/sourced/structured output, static/rendered/raw Fetch, bounded Research, and exact balance accounting were exercised. Search and answer remain leads; Native/static extraction comes first for known URLs, with `renderJs:true` reserved for observed shell/empty/failure cases. Research S was slow and duplicate-prone but useful as a scout. See `docs/upstreams/linkup.md`.

### 4. Serper and X — exercised

Serper's generally available specialist endpoints and credit accounting were exercised internally; only lexical Search remains public pending a named specialist-result mapping. X exact dates, handles, donor/current models, image understanding, no-winner synthesis, citations, token usage, and internal search count were exercised; one request can trigger 10–14 searches and high token use, so no default model was selected. See `docs/upstreams/serper.md` and `docs/upstreams/xsearch.md`.

### 5. Context7, SkillsMP, and Pi packages — exercised

Context7 normal/fast resolution, text/JSON docs, ambiguity, available-version pinning, and absent-version refusal were exercised. Provider order/scores never resolve ambiguity; text is the default token-efficient representation. SkillsMP stars/recent/filter behavior proved repository popularity is not individual skill quality, and Pi package scores remain npm discovery ranking. All catalog rows stay leads. See the three owning upstream ledgers.

### 6. Native and provider-assisted fetch — exercised

Structured HTML, JavaScript-capable documentation, GitHub root/blob, PDF, YouTube transcript, and retained page output were exercised. The packet corrected a PDF byte/timeout bypass and added minute transcript locators. Native extracted the sampled Linkup documentation without rendering. Query-aware retained passage selection remains unimplemented; `alehdezp` deferred the proposed public focus contract on 2026-08-01.

## Hard research situations

Use a small reusable set of difficult situations to teach combinations, not to produce a leaderboard:

1. an unknown or renamed concept;
2. an exact current official fact;
3. an originating paper plus official implementation;
4. first-hand social evidence inside a date/handle window;
5. difficult JavaScript, PDF, GitHub, or YouTube evidence;
6. a multi-hop claim with contradictory evidence and a valid scoped no-winner outcome.

A provider participates only when its contract fits the task. Repeating a situation requires an observed instability or an unresolved decision, not a target case count.

## Public exposure and guidance gates

A field, mode, operation, or provider-specific tool becomes model-facing only when:

1. its current contract is source-grounded;
2. a focused call shows a visible distinction the caller needs;
3. agents can construct it reliably through the typed schema;
4. its evidence state, failure behavior, latency, and known cost are visible;
5. it improves one named research situation or uniquely satisfies a hard constraint;
6. concise call-site and research guidance teach when to use it, avoid it, and recover from malformed or weak results;
7. `alehdezp` accepts the exposure and guidance.

A capability may remain internal for contract preservation and focused maintenance, but internal implementation is not agent capability and cannot satisfy product completeness. If a public route would imply broader provider support than agents can actually use, either expose and teach the missing behavior coherently or state the unsupported gap; do not ship a misleading partial tool merely to keep the tool count low.

## Targeted comparison rule

Create a comparison only when a concrete question survives apprenticeship, for example:

- Exa neural versus Serper lexical for uncertain vocabulary;
- Native versus Linkup rendering for one JavaScript shell;
- Native versus Exa Contents for one difficult PDF;
- one provisional `web_answer` result versus `$mini-research` search→fetch verification for the same factual question;
- Context7 versus official documentation discovery for version accuracy.

The comparison changes one decision. It records exact calls, accepted evidence, disqualifiers, attempts, latency, cost, model-visible content, and the result's scope. No universal score or provider ranking is produced.

## Cost and live-call authorization

Live provider calls consume credits and require an exact approved envelope: providers/modes, maximum calls including fallback, known unit prices and freshness, model trajectories where used, maximum known cost, and stop behavior. Unknown prices remain unknown. Approval of one apprenticeship packet does not authorize later packets.

A small direct-call packet is preferred over infrastructure for enforcing a hypothetical large run. Build a runner only if repeated manual packets create a demonstrated accounting or reproducibility defect.

## Guidance ownership and learning loop

- Current wire/API facts: installed SDK/source and `docs/upstreams/`.
- Public call construction: TypeBox descriptions in `src/tools/`.
- Practical cross-call recipes: `skills/research/references/web-tools-playbook.md`.
- W1/W2 method: `skills/mini-research/SKILL.md`.
- W3/W4 method, rejection memory, and closure: `skills/research/SKILL.md` plus shared references.
- Universal evidence routing only: APPEND, through its preview/backup/approval protocol.

After each accepted packet, update the smallest owning surfaces together. Provider-specific detail never expands APPEND; unaccepted observations never become recommendations.

## Alternatives and decisive trade-off

### Formal 12/48 benchmark before guidance — rejected

It promised comprehensive selection evidence but shifted work into cases, capsules, budget gates, grading, and meta-review before teaching agents how to use providers. Small real panels and focused retrieval calls produced more actionable schema and guidance evidence than the scaffold. Reopen a broad matrix only if targeted comparisons cannot resolve several consequential defaults and the repeated task volume justifies durable automation.

### Keep every old extension schema unchanged — constrained

Old schemas are valuable baselines, but installed contracts and the unified four-tool interaction differ. Preserve useful call shapes and descriptions; do not retain outdated fields or duplicate provider-named tools solely for migration comfort.

### Provider apprenticeship with targeted comparisons — accepted

This path reaches useful guidance earlier, preserves advanced capability, and still requires evidence for comparative claims. Its risk is anecdotal overgeneralization; scoped wording, evidence dates, reopen conditions, and owner review contain that risk.

## Evidence and verification

Verified evidence supporting the reframe:

- provider contracts and focused operations are implemented and the full websift package passed 239 tests with TypeScript clean before this decision;
- a five-model Exa/Serper panel immediately exposed three schema-construction failures, provider complementarity, evidence-promotion mistakes, and one wasteful fetch;
- the Native/section-projection/Exa Contents pilot produced direct context/fidelity trade-offs without selecting an architecture;
- the unexecuted benchmark scaffold grew while producing no provider recipe or accepted guidance;
- BrowseComp, DeepResearch Bench, BrowseComp-Plus, and BEIR remain useful references for hard tasks and measurement caution, not a mandate to build a local benchmark platform.
- the 2026-08-03 answer evidence packet recorded 14 retained plus 36 new zero-retry/zero-fallback cells and exposed decisive failure modes—shape without semantic correctness, deep modes that did not repair errors, source floods without authority, and fluent unsupported answers—while its own T04/T08/T12 and citation-adjudication defects prevent clean provider ranking;
- credential-free official reads resolved xAI alias behavior, OpenAI-versus-Anthropic strict required-property rules, current Exa/Tavily/Linkup prices, and the CompSelect method without another paid provider call; repository author ownership remains unproven.

No provider role, default, fallback, or universal winner is accepted merely by this ADR. Apprenticeship calls ran under the owner-approved aggregate budget; final public selection remains interactive.

## History

- 2026-07-28: Created the staged benchmark and selection decision.
- 2026-07-31: Added hard novel/social/video/context-efficiency scenarios and interactive owner selection.
- 2026-07-31: Built, then removed, an unexecuted 12/48 benchmark scaffold after it failed to advance practical provider guidance.
- 2026-07-31: `alehdezp` replaced benchmark-first delivery with provider apprenticeship, immediate scoped learning, and targeted comparisons only for unresolved decisions.
- 2026-08-01: Completed focused packets across Exa, Tavily, Linkup, Serper, X, Context7, SkillsMP, Pi packages, and Native fetch. Recorded scoped recipes and fixes without selecting a universal provider winner; cumulative conservative spend reached $3.081 of the approved $5.00.
- 2026-08-01: `alehdezp` deferred final public-surface selection and query-aware retained passage narrowing. The current four-tool surface and provider mappings remain unchanged; no `web_fetch.focus` field or automatic provider escalation was authorized.
- 2026-08-01: `alehdezp` established the public-readiness principle that an uninvestigated, weakly taught, or misleadingly partial tool is worse than no tool. Internal contract preservation no longer counts as agent capability; exposure requires exercised behavior plus call-site guidance.
- 2026-08-03: Completed and reviewed the 50-record provider-native answer evidence inventory. No answer consolidation or provider role was selected; the next owner frontier is error/recovery taxonomy, model-relevant GCF output responsibility, public answer shape, then scenario-specific retention. Conservative cumulative spend reached `$3.659/$5.00`.
