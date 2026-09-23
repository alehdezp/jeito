---
title: "websift and source tool playbook"
description: "Call-construction and evidence-right guidance for explicit jeito websift provider/method tools used in W3/W4 research."
tags: [jeito-websift, research, provider-recipes, evidence-rights, tool-routing]
created: 2026-07-31
updated: 2026-08-12
status: active
---

# websift and Source Tool Playbook

Read only the sections needed for the active W3/W4 lanes after `tool-lane-preflight.md`. Live tool schemas override every parameter example here.

The purpose is not to use every provider. It is to make each call enforce the eligibility contract and produce a result shape that can change the decision.

The websift extension installs nine tools. `web_search` (Serper Search), `web_fetch`, `web_answer`, and `web_lookup` are startup-active. Five one-provider specialists are lazy: `web_search_exa`, `web_search_x`, constrained `web_search_tavily`, `web_answer_exa`, and `web_answer_linkup`. Activate one exact method only after its distinct evidence hypothesis is selected. `bash` + `curl` covers raw HTTP and registry APIs. Internal operations remain non-callable.

## Universal query compiler

Build queries from:

```text
<decisive mechanism>
+ <time/version window>
+ <source/artifact type>
+ <first-hand or evidence language>
- <known candidate names>
- <false-positive classes/bait terms>
```

Example:

```text
("requirement satisfaction" OR "off-target results" OR abstention)
("deep research" OR "search agent")
(benchmark OR implementation OR postmortem)
after:2026-04-01
-"RAG tutorial" -LangGraph -CrewAI -AutoGen -training
```

After each result set, use `search-steering.md` to update positive discriminators, exclusions, or source type. Never run the same query shape on another provider/method and call that progress; name the different retrieval error or source class first.

## Google-style lexical discovery (`web_search`, Serper Search)

Use `web_search` for Google/Serper lexical discovery. Begin with 2–6 distinctive terms and at most one constraint: one `site:`, one quoted identity, one year, or one exclusion. Country may shape ranking through `gl`; it does not prove geographic authorship. One invocation is one Serper attempt with up to 10 lead-only rows and no fallback.

First call:

```text
search agent off-target hard negatives
```

After inspecting the result, change one dimension only. Add `site:` when the owner domain is known, quote an exact identity when spelling matters, add a year when freshness changes eligibility, or exclude one repeated noise class. In a harder W3/W4 lane, constraints may accumulate across evidence-driven mutations; do not paste the full eligibility contract into the first query.

A response with zero organic rows is a successful scoped search outcome, not a provider failure. Use the printed query and next-action receipt: remove one constraint from a narrow query or add one to a broad query, then search again. Authentication, quota, network, timeout, and malformed provider responses remain actual failures.

Rankings, snippets, answer boxes, and knowledge graphs are leads. Fetch the canonical survivor instead of gathering more rankings. Current Images/Videos/Places/News/Shopping/Scholar/Patents/Autocomplete/Maps/Reviews/Lens/Webpage operations are internal and must not be invented as public `web_search` parameters.

## Exa search and structured-answer guidance (`web_search_exa`, `web_answer_exa`)

Use `web_search_exa` when Exa-native retrieval or source-shaping controls materially change one candidate-discovery gap. It is the only public Exa Search method; `web_search` never routes to Exa.

- **keyword** — one short exact identity plus domain fields. Two compound identity+relationship queries returned empty; reducing them to `Geometric Token Transport` and `Sessa 2604.18580` recovered only the expected records. Resolve ownership/implementation after identity retrieval. Use the package registry, not web ranking, for an exact package version.
- **neural** — broad unfamiliar-vocabulary/concept neighborhoods; expect adjacent concepts and apply the admission gate immediately.
- **hybrid** — concepts with useful lexical anchors. On one paper-to-code task it surfaced two qualified implementation pairs neural missed; on a non-overlapping compiler/runtime task neural and hybrid both found the same qualified Toka pair and no hybrid-unique candidate passed the direct gate. Do not teach hybrid as a general neural-repair or quality upgrade.
- **auto / fast / instant** — auto is the balanced default; fast reduces latency; instant minimizes it with less search depth. One same-query call returned the same official-doc set from fast and instant, so do not spend another lane unless latency matters.
- **deep-lite / deep / deep-reasoning** — use only for genuinely multi-step candidate expansion. A deep-lite historical-version bundle recovered every known historically linked GTT record but missed actual latest state; direct version APIs still own completeness. On exact Sessa identity, deep-lite added name-collision noise while minimal keyword returned the exact pair.
- **category / freshness / text filters** — use `publication` for papers, the other exact category for entity/source shape, `publishedWithinDays` or exact `startPublishedDate`/`endPublishedDate` for time, and `includeText`/`excludeText` for a decisive short phrase.

Write semantic queries as a description of the ideal evidence page, not a bag of buzzwords. Results remain leads; fetch accepted sources.

Query-guided Exa Contents highlights are internal and, on the focused documentation call, preserved the required wording with less context than bounded text. Summary is an abstractive scout, not source evidence. Fresh section filtering requires `maxAgeHours:0`; pay that crawl latency only when stale/boilerplate content makes it useful.

Do **not** request Exa URL similarity: installed `exa-js@2.16.3` marks it deprecated with no direct replacement. Exa Contents and legacy Research stay internal. Use `web_answer_exa` only for one structured relationship or explicit-none question; its schema-compliant synthesis remains a claim scaffold until every material field is checked against fetched primary citations.

Controlled provider-mastery evidence for public Exa Search is task-shaped. Neural stably oriented unfamiliar research but admitted adjacency; hybrid's first-task linkage advantage did not reproduce. Keyword is now reproduced as a minimal identity locator, not a compound relationship query. Deep-lite can widen historical records, not establish complete/latest state. Select mode from a named prediction, then fetch publisher/version history and repository ownership.

Use `web_answer_exa` only after one candidate is known. Candidate-bound Answer transferred successfully to Toka and SwitchCraft exact positive pairs, but prior relationship/evidence-gap fields drifted. Do not use structured Answer for complete version-set/latest aggregation: an explicit version-sensitive schema omitted three linked records, named a historical record as latest, transferred its link to latest, and overstated a supporting library as the full mechanism. Schema makes each field auditable, never authoritative.

## Constrained Tavily Search (`web_search_tavily`)

`web_search_tavily` is one basic/general Tavily attempt with no fallback, fixed at 10 leads. Its public schema is deliberately only `query` plus optional full-name `country`:

- Use it when Tavily has a named chance to expose an independent technical guide or country-shaped regional source missed by the current lane. W12 found substantive PostgreSQL 19 guides that Serper missed.
- Use `country` only when regional ranking is decision-relevant. One matched India cell added the primary IndiaAI partner guidelines; that is provisional one-task evidence, not regional superiority.
- Advanced used two credits, took 7.4 seconds, and replaced a qualifying Thai set with adjacent document-management pages. Exact match emptied an exact Toka query. Extra chunks changed no decisive source. Topic, freshness, domains, count, depth, chunks, and exact match therefore remain internal.

Reported credits stay model-visible. Search output remains leads. Fetch every decisive result, and fetch a known official URL directly instead of searching it.

For known-URL extraction, Native remains the default and keeps GitHub/PDF/YouTube locator specialties. The accepted 2026-08-02 comparison routes Tavily basic first for source families where it repeatedly or materially out-extracted Native: OpenAI News/Index, Anthropic News, Hugging Face Papers, TechCrunch, LinkedIn company posts, Juejin, 36Kr, YourStory, WSJ AI, Ars AI, GitHub Trending, Bloomberg Technology, selected Bilibili/Inc42 pages, and Economic Times Technology. This is an evidence-dated host/path preference, not a universal Tavily ranking. Elsewhere an eligible Native empty/thin extraction may visibly fall back once to Tavily. Linkup remains explicit.

Tavily's official grounded workflow is Search → curate URLs → Extract. Public `web_fetch` reaches basic Extract through the automatic route above; query-guided Extract remains internal. The comparison selected neither advanced extraction nor Linkup rendering as automatic retry: advanced uniquely rescued only one WeChat landing-page case, and rendered Linkup rescued zero static failures across 16 candidates.

`web_fetch` `mode:map` exposes bounded URL discovery, not a full Tavily control surface. Use it only when site structure is unknown, then fetch selected pages. Dedicated Crawl is internal; current guidance is Map first, depth 1, small breadth/limit, instructions/path filters, and incremental processing. Native Tavily Research is also internal: one mini run took 45.9 seconds and produced a readable cited report but no claim-to-passage proof. Treat it as a scout, never fetched-evidence closure.

## Linkup Answer, Fetch, and internal Search/Research (`web_answer_linkup`)

W12 removed public `web_search_linkup`: fast/standard/deep searchResults produced no two-class unique decisive evidence, deep duplicated or worsened exact retrieval, one deep official-domain call timed out, and Thai/Indian tasks missed the primary source class. Linkup searchResults, structured Search, and asynchronous Research remain internal maintenance/apprenticeship operations; provider capability is not public-tool justification.

Use `web_answer_linkup` for one official-domain or date-bounded sourced orientation step. Start standard. Escalate to deep only after the exact entity is found and one named chain field remains; deep is not identity or metadata repair. Fetch cited pages/APIs because provider passages can omit JSON-LD or page metadata.

For a known URL, static extraction is the only `web_fetch` lane (webclaw `-f llm`, keyless). JS/login shells are detected automatically (js-needs rule) and escalate to the tavily lane; schema v2 removed the public Linkup branch, `renderJs`, and `extract` — there is no rendering knob and no raw-content knob. Linkup is out of the stack.

Use `web_answer_linkup` for one official-domain or date-bounded sourced orientation step, normally at standard depth. It can preserve a passage-level metadata gap without extracting JSON-LD. Standard matched deep on the complete Sessa chain; deep added one exact Toka date at greater latency/reserve; all depths missed the GTT historical identity. Fetch cited pages/APIs; `does not state` over a passage is never page-level absence, and depth is not identity or metadata repair.

## X/social search (`web_search_x`)

Use `web_search_x` for first-hand X evidence with an event-covering inclusive window and explicit account provenance. Three exact-day calls returned zero for a primary-confirmed event even without handles. Use exact-day bounds only when the post identity is known. allowedHandles trades recall for authority; excludedHandles can remove known noise but one matched call merely produced a different hype cluster.

Read the bounded synthesis before accepting URLs. Image understanding remains lead-only: in one matched visual task image-off and image-on reached the same no-proof decision; image-on returned fewer citations and more input tokens, with no inspectable image bytes. Citation presence never overturns a scoped no-winner.

Treat xAI as materially billable agentic work: count limits returned URLs only, and maxTurns/maxOutputTokens do not directly cap x_search calls. For narrow cost/chronology-sensitive tasks prefer `parallelToolCalls:false`: one matched cell used 1 search/6,442 tokens versus true at 4/14,586 and avoided true's date-window error. Keep this task-scoped, not a universal quality rank. Enable images only when visible media changes the decision.

Query for first-hand evidence rather than product names alone:

```text
Posts since 2026-05-01 describing a first-hand production failure where a
research/search agent returned semantically similar but constraint-violating
results. Require concrete query changes, logs, evaluation, or source links.
Exclude launch announcements and generic RAG advice.
```

The synthesis is `search-summary-only`; provider-reported model/tokens/tool calls are operational evidence. Verify decisive post claims through the cited post or its linked primary source when accessible, preserve no-winner outcomes, and keep independent/source-of-source checks separate.

Matched public `web_search_x` evidence separates calibration, recall, authority, and work. Evidence-shaped questions prevent false absence but do not repair exact-handle recall. Exact-day narrowing destroyed recall for a confirmed launch; a broader no-handle window recovered leads. Excluding known noisy handles replaced them with new pre-official-date hype rather than better authority. Image understanding changed work, not the conclusion. Under identical bounds, parallel false used one-quarter the searches and 44% of the tokens of true; true gained one citation/one second but falsely rejected in-window posts. Ask for cited posts, use an event-covering window, preserve handle provenance, and verify timestamps/media/official chronology directly.

See `social-and-gated-sites.md` for engagement, independence, and platform limits.

## Known URL and primary-source fetching (web_fetch)

Use `web_fetch` for shortlisted sources — `urls` accepts one URL string or a batch array. **Content is always shown**: full up to 5K tokens, heading navigation + section starts beyond; every result prints the cache path. Add `query_terms` (distinctive vocabulary, an addition never a replacement) to overlay ranked matches — each carries a score, the **exact line range to read**, and 3 lines of context; on full pages the ranked headings carry ★ focus markers. The workflow: `web_fetch` → see the match + range → `read` the cache file at those lines. In a batch, sources are ordered by best match; sources without a quality match show their cache path — read or grep the file.

Model work is explicit and rare: `objective` alone is dormant (a hint for the lanes below). Only `mode:"llm_answer"` (objective answer + per-section summaries, deepseek direct) or the automatic single-URL rescue (page over 5K + `query_terms` with no quality match) invokes the LLM. Treat answer prose as lossy; the exact cache ranges remain the evidence.

Site downloads: `mode:"crawl"` downloads a site or subtree as an async job — the URL carries the scope (`https://x/`, `https://x/test`, `https://x/*`, `https://x/**`, `https://x/+[a/*,b/*]-[c/*]`). The call returns `crawl:N`; polls (`urls:"crawl:N"`) soft-wait 30s by default, and a completed job is reported on your next `web_fetch` call — the listing (title + description + url → path) is never raw crawl content. Pass `query_terms` with the crawl call to rank each page (top 2) when you poll. `mode:"download"` fetches fresh and shows the per-source smart view — use it when multi-source full content would be noisy.

Text extraction is single-format webclaw `-f llm` (no extract knob). JS-rendered pages escalate to tavily automatically (js-needs DB). Typed vertical JSON arrives automatically for npm/pypi/crates.io/docker hub/arxiv/Hugging Face/Stack Overflow/Hacker News URLs. For GitHub, prefer repository/blob URLs when source structure matters; PDFs preserve page markers via the native handler; for YouTube cite transcript minute headings. After fetching, capture the smallest exact locator that proves or rejects the requirement and do not refetch successful content for reassurance.

## Context7/versioned library documentation (web_lookup context7 branch)

Use before implementing against an unfamiliar or fast-moving third-party API. Pass the library name and focused retrieval question. If resolution returns several same-named candidates, do not pick the first or highest provider score: resolve the exact library ID and pin a version advertised by that candidate. An absent version is a valid refusal, not permission to fetch unversioned docs. Prefer `responseType:"txt"` for model reading; use JSON only when code/info snippet structure matters. Use `fast:true` when latency matters more than LLM reranking.

Context7 evidence can prove documented API/library behavior for its returned version. It cannot prove:

- that the project uses that version;
- runtime behavior under the project's configuration;
- current package maintenance/adoption;
- product/social claims.

Check lockfiles/manifests and version-matched changelogs/source. If official current docs conflict with the pinned project version or runtime, report the applicability mismatch.

## Pi package and skill catalog (web_lookup pi-packages / skillsmp branches)

Use when the solution space is specifically a Pi package (`pi-packages`) or installable agent skill (`skillsmp`). Search with mechanism/failure vocabulary, not only category names. For SkillsMP, `stars` reflects source-repository popularity and can repeat across many skills from one repository; use `recent` for novelty, never as proof of maintenance quality. Keep category/occupation/language filters when they are hard constraints—a no-result intersection is better than silently broadening it.

Treat all catalog rows and registry scores as discovery leads, not individual quality or safety rankings. Verify package metadata, README/source, current releases, dependencies, permissions, maintenance, adoption, and exact fit. Install only with explicit authorization.

A catalog/provider error is not a zero-result finding. Record the tool state and use the public catalog/registry only if that fallback preserves the requested evidence.

## Repository and registry verification

Once a candidate name is known, stop generic search. Verify (via `web_fetch` and `bash` + `curl` registry APIs):

```text
identity and owner
latest release/publish date
recent mechanism-relevant commits/releases
archive/deprecation/supersession status
license
shipped files/exports/bin/dependencies
issues/PRs and maintainer responsiveness
contributors/dependents/integrations where meaningful
primary implementation of the claimed mechanism
```

Stars/downloads are attention/adoption signals only. Inspect age, contributor depth, retention/continued activity, independent integrations/use, and possible manipulation.

## Criticism and failure lane

Search the candidate and exact mechanism with:

```text
broken | regression | deprecated | removed | migration | security |
rate limit | pricing | abandoned | postmortem | "does not support" |
"stopped using" | "not worth" | issue
```

Prefer exact issues, postmortems, changelogs, reproductions, and first-hand logs. Do not convert one anecdote into a universal claim; use it to define a failure check.

## Adaptive research orchestration belongs to `$research`

When the manual frontier is stuck or the objective has several independent source lanes, continue through `$research` rather than delegating to a generic answer mode. Preserve the exact eligibility contract, disqualifiers, rejected classes, source priorities, date/version window, required output fields, and no-winner boundary in the research state. Activate one provider specialist only when its method has a named chance to expose a different evidence class.

Provider answers remain discovery evidence. Fetch decisive primary sources and apply the same admission and closure gates before promoting a claim.

## Handoff map

| Current state | Next move |
|---|---|
| Exact primary URL found | Fetch/read; stop broad search. |
| Unfamiliar vocabulary | Activate `web_search_exa`; run one semantic/hybrid call with eligibility constraints. |
| Famous off-target flood | Exclude names/class; source/date constrain; change mechanism language. |
| One perfect-fit seed | Fetch the seed and follow references/citations, then apply hard gate. |
| Claim without origin | Exact phrase/title/author/DOI/repo provenance search. |
| New obscure exact-fit | Primary source → maintenance/integrity → independent signal → criticism. |
| Social hype cluster | Activate `web_search_x`; exclude launch handles/product and search first-hand use/failure. |
| JS/login shell | Escalates automatically to tavily via the js-needs lane; otherwise an alternate primary source. |
| Library API uncertainty | Versioned docs (`web_lookup` context7) → pinned version/source → local smoke if needed. |
| Candidate repo/package | Repository/registry verification; stop generic search. |
| Same reject classes twice | Change source type/search mode, not adjectives. |
| Three non-overlapping lanes exhausted | No-winner/clarify/relax a named constraint. |

## Call-level self-check

Before every external call:

- Which exact requirement does this call test?
- What result shape would qualify?
- Which rejected classes are excluded?
- Why is this provider/lane discriminating rather than merely available?
- What will I do differently after success, zero, or adjacent results?

If none of those answers changes the query, do not call the tool.
