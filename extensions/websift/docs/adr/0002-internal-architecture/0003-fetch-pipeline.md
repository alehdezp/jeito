---
title: "ADR 2.3 — Composable fetch and retained-content pipeline"
description: "Records URL/content dispatch, persistent caching, query-guided raw retrieval, pi-nav smart-read source views, webclaw/tavily extraction, bounded map/crawl, and the async llm_answer synthesis lane."
tags: [jeito-websift, adr, fetch, extraction, cache, query-retrieval, pi-nav-view, llm-answer, webclaw, crawl]
created: 2026-07-28
updated: 2026-08-11
status: active
adr_id: ADR-002.003
adr_type: child
decision_status: accepted
confidence: confirmed
evidence_grade: mixed
implementation_status: validated
decision_owner: alehdezp
owns: "Fetch dispatcher, content handlers, persistent cache, query-guided section retrieval, pi-nav smart-read source views, bounded crawl, and the async llm_answer synthesis lane"
audience: contributor
parent: docs/adr/0002-internal-architecture/README.md
code: [src/tools/web-fetch.ts::registerWebFetch, src/fetch-cache.ts, src/section-rank.ts, src/webclaw-spawn.ts, src/crawl-jobs.ts, src/js-needs.ts, src/adapters/webclaw.ts, src/adapters/tavily.ts, src/routing.ts, src/fetch-handlers/github.ts, src/fetch-handlers/pdf.ts, src/fetch-handlers/youtube.ts]
related: [docs/upstreams/pi-web-access.md, docs/ROADMAP.md, docs/adr/0001-product-and-evidence/0002-tool-surface-and-evidence.md, docs/adr/0002-internal-architecture/0002-routing-and-failover.md, docs/adr/0002-internal-architecture/0005-webclaw-extraction-redesign.md]
---

# ADR 2.3 — Composable fetch and retained-content pipeline


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-002 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: confirmed`, `evidence_grade: mixed`, and `implementation_status: validated`. The metadata—not optimistic prose—governs whether dependent work may treat the decision as proved.

## Redesign notice (2026-08-06) — CUT OVER

**Part of this ADR is superseded.** [ADR-002.005 — webclaw extraction redesign](0005-webclaw-extraction-redesign.md) replaced the native readability text-extraction lane with the local webclaw binary (tavily escalation via the js-needs DB) and replaced the `llm_rich` research-brief machinery with `mode:"llm_answer"`. The `extract`, `linkup`, `llm_rich`, `summary_id`, `context`, `responseId`, and `pattern` params are removed from `web_fetch`; crawl is an async job (`crawl:N` handle). The model-visible source view is pi-nav smart read over the cache file (owner 2026-08-07), not the retired 2K smart view. The persistent cache contract, routing/fallback machinery, github/youtube/pdf handlers, and section-rank retrieval carry over unchanged.

## Decision

`web_fetch` is a **persistent retrieval coordinator over pluggable content handlers**. `src/fetch-cache.ts` owns exact cache identity and durable crawl manifests; `src/webclaw-spawn.ts` + `src/adapters/webclaw.ts` own webclaw extraction and the LLM spawn lane; `src/js-needs.ts` owns tavily escalation routing; `src/section-rank.ts` owns BM25 snippet retrieval. The model-visible source view is pi-nav `pi_nav_read` over the cache path (web metadata + pi-nav smart summary output), with graceful headers-only degradation when pi-nav is absent. The coordinator owns mode semantics, bounded fan-out, partial results, and model-visible output.

```
```
web_fetch(urls, mode: page|download|map|crawl|llm_answer, objective, query_terms, wait)
   │
   ├─ page (default) ───────▶ cache-first; view = pi-nav smart read over cache path
   ├─ download ─────────────▶ force fresh fetch, update cache, same pi-nav view + path
   ├─ map / site ───────────▶ webclaw --map → bounded same-host URL leads
   ├─ crawl ────────────────▶ async job; URL carries scope; poll urls:"crawl:N"
   └─ llm_answer ───────────▶ async synthesis (30s/call); summary file beside cache
        acquisition: webclaw (default) → js-needs DB / thin-shell / failure → tavily
        pdf/youtube/github stay on native handlers
```
## Explicit asynchronous `llm_answer` (replaces the retired `llm_rich` lane)

The `llm_rich` research-brief lane, its `summary_id` polling, the provider-rotation chain (OpenCode Go → CommandCode → official DeepSeek), the 15-second shared deadline, and the v6 summary persistence are **retired** (ADR-002.005). The synthesis lane is `mode:"llm_answer"`:

- **Async by default when requested:** the call returns a message that the answer is being generated (continue or wait) plus the cache path; optional `wait:N` gives a soft inline window; completion is pushed to the agent.
- **LLM timeout 30s per call** (each of the per-section summary-map and objective-answer calls), via the webclaw `--extract-prompt` spawn with deepseek (`api.deepseek.com`, `deepseek-chat`, key from `~/.pi/agent/auth.json`).
- **Summary persisted to `<cachePath>.summary.md`** beside the cache; only the first successful generation is cached; repeat same-objective calls reuse the file and never re-run the LLM.
- **`query_terms` are passed to the model as focus** in `llm_answer`; ranked BM25 sections are not shown in that mode.
- **Single-URL rescue** (page >5K + query_terms + no/weak quality match below `WEAK_SCORE_FLOOR` 2.0) remains the one automatic LLM trigger and blocks its call.
- The answer remains lossy synthesis; validated exact quotes and raw cached lines remain the evidence boundary.

Fetch-specific failure recovery is owned by [`ADR-002.002`](0002-routing-and-failover.md): partial URL failures preserve successful evidence and print a per-URL next action.


## Primary handler: `http.ts`

Native HTTP + `@mozilla/readability` + `linkedom` + `turndown` (markdown).
`extract: readable|markdown|raw` selects the extraction style. This is the common
case.

For `extract:"readable"`, a projection below 1,000 characters is structural-empty only when the same downloaded HTML yields more than 10,000 Markdown characters and more than ten times the readable projection. That calibrated contrast came from the accepted 37-source comparison; it is not a general minimum article length.

### Ported divergences from pi-web-access (recorded honestly)

The `extract.ts` we port from couples its HTTP to `ssrf-protection.ts`
(`fetchRemoteUrl`/`validateRemoteUrl`) and embeds Jina Reader + Gemini + Parallel
+ Perplexity extraction fallbacks. By settled owner decision:

- **`http.ts` uses plain `fetch`.** It replaces `fetchRemoteUrl`/`validateRemoteUrl`
  and performs **no URL validation** (security dropped). It retains only
  robustness bounds that are scope, not security: `http(s)`-only scheme, a
  response size cap ("Response too large"), and `limits.timeoutMs`. A top-of-file
  comment states this divergence.
- **Jina/Gemini/Parallel/Perplexity extraction branches are trimmed** from the
  ported `extract` core (those providers are out of scope). The native
  Readability path remains.
- Ported helpers we keep: content-type detection, title extraction, and the error
  primitives from `utils.ts` (`isTimeoutError`, `readExecError`). The upstream
  `isLikelyJSRendered` heuristic was not ported.
- **Redirects (robustness, informational — not a security layer):** plain `fetch`
  follows redirects, so the request-time `http(s)` check and the final-URL scheme
  can differ via 3xx. Optional hardening: `redirect: "error"` or a bounded
  follow-count with a final-URL scheme recheck. Opt-in, not required for ship.

Full file-level provenance: [`../upstreams/pi-web-access.md`](../../upstreams/pi-web-access.md).

## Implemented specialized handlers

- **`github.ts`** — GitHub root/tree/blob extraction via shallow `git`/`gh` clone
  with a size-gated `gh`-API fallback. Repos larger than the configured
  `maxRepoSizeMB` (default 350 MB) always use the bounded API view (structure,
  README, individual files) instead of cloning. Full-SHA URLs also use the API
  path because they cannot be shallow-cloned by branch.
- **`pdf.ts`** — PDF → markdown via `unpdf` (lazy optional dependency). PDFs are
  matched by `.pdf` extension or `application/pdf` content type (so extensionless
  PDF URLs still extract). Bounded to the configured `responseBytes` (default 5 MB
  body) and 100 pages (`DEFAULT_MAX_PAGES`).
- **`youtube.ts`** — model-free transcript + metadata via `yt-dlp` captions. Transcript text is grouped under minute timestamp headings so evidence can be narrowed and cited without rereading one undifferentiated paragraph. **External runtime: `yt-dlp`, lazy-detected and optional** — never required for base install; if absent, the handler reports `unavailable` rather than breaking startup. pi-web-access's Gemini/Perplexity stream-analysis branches are intentionally not ported. When captions are unavailable the handler degrades to metadata-only output.

Deterministic URL, detection, dispatch, resource-bound, and normalization boundaries have focused tests. Live apprenticeship exercised GitHub clone, PDF `unpdf`, and YouTube `yt-dlp`; these remain environment-dependent integration paths rather than deterministic unit proof.

### Deliberately excluded or future decisions (not missing baseline)

The following were considered and are **not** part of the accepted native-fetch
baseline. They are exclusions or deferred decisions, not gaps:

- **`video.ts` / local-video frames** — local/remote video *file* analysis needs a
  model to describe ffmpeg-extracted frames; without one it produces no usable text.
  Not ported. (No `video.ts` exists or is planned in the baseline.)
- **ffmpeg** — no handler in the baseline shells out to ffmpeg. The YouTube handler
  uses `yt-dlp` captions only.
- **Model extraction** (Gemini/Perplexity frame or stream description) — out of scope.
- **React Server Component (`rsc-extract.ts`) extraction** — out of scope.
- **Jina Reader / Gemini / Parallel / Perplexity HTTP extraction branches** — trimmed
  from the ported `extract` core; those providers are out of scope.

## Provider fallback for fetch

Native remains the general page default and the GitHub/PDF/YouTube specialist. The accepted 2026-08-02 host/path table sends common current-news, AI-research, tool-list, and regional source families to Tavily basic first when Tavily is available; [`ADR 2.2`](0002-routing-and-failover.md) owns the exact rules. Everywhere else, a Native transport failure, empty extraction, or calibrated thin-readable projection may fall back once to Tavily. `invalid_input`/`aborted`/`policy` never fall back, Linkup remains explicit, and Tavily advanced is not an automatic retry.

## Bounded map and explicit crawl

`mode:"site"` is a tolerant alias for `mode:"map"`. Map discovers same-host URLs through the eligible provider and returns a deduplicated lead list capped by `limits.siteMapCap` (default 25); it never fetches those pages. A URL ending in `/*` implies map only when `mode` is omitted, so an explicit `mode:"page"` remains literal.

`mode:"crawl"` is the explicit opt-in to fan-out. It maps the seed, keeps only the seed host and endpoint path, then downloads at most 25 pages with configured concurrency. `endpoint`, `endpoint/`, and `endpoint/*` share the same descendant boundary. Each page is capped by configured `responseBytes` (default 5 MB), the crawl is capped at 50 MB, and sibling failures do not erase successful pages. Every crawl writes a JSON manifest under `.cache/web/<host>/` with each URL's saved path, token estimate, heading preview, provider, or failure. If mapping fails, the seed page is still attempted and the map failure remains visible.

## Persistent cache, source views via pi-nav smart read, and deterministic retrieval

Ordinary `mode:"page"` reuses an exact persistent cache hit without network. The model-visible source view is **web metadata + pi-nav smart read over the cache file**, not a custom web renderer: web_fetch returns the source card (URL, cache path, webclaw header title/description/word count, estimated tokens) and delegates the reading view to pi-nav `pi_nav_read` on the cache path (owner decision 2026-08-07: "ignore that budget, just web metadata from webclaw + pi-nav smart summary output, nothing fancy"). The former 2K smart-view budget (`SMART_VIEW_TOKEN_CAP`/`SECTION_EXCERPT_CHARS`) is vestigial and retired from the live path. When the pi-nav lane is absent, web_fetch degrades to a headers-only view plus a clean notice (settled graceful-degradation rule).

pi-nav read decides the view from its own thresholds (`TOKEN_THRESHOLD` 6000 → full below, outline view with `[start-end] ## Title` entries above, `OUTLINE_MIN_COMPRESSION` 80, 500KB file cap) and returns `markdownStructure` section selectors; those line/selector references are the exact read path for the agent. The web layer keeps only acquisition metadata and the cache path; it does not reimplement display thresholds.

`mode:"download"` ensures the full page is cached and returns a compact URL→path/token/headings manifest. `mode:"refresh"` always performs a network fetch and updates the same entry while preserving `created`; the compatible `mode:["download","refresh"]` form normalizes to refresh-and-save. Explicit Linkup rendering follows these same per-source modes and now accepts URL batches as independent calls.

`query_terms` remains the sole BM25 input for one-page targeted retrieval; `objective` never changes ranking. In a multi-source call, neither field causes cross-document BM25: every source remains visible through the ordinary per-source view, and the fields guide only an explicitly requested `llm_answer`. The former `pattern` parameter is disabled (decision recorded in ADR-002.005); per-source exact regex search is not part of the schema-v2 surface.

All multi-source page/download/refresh calls settle independently under configured concurrency. Each replacement-safe update contains every settled source's normal bounded output plus pending/failure cards; the final result remains in authored URL order. Partial failures survive, and only total failure is an aggregate fetch failure. Normalized invalid tokens remain visible, and the explicit batch cap remains ten URLs.

Multi-seed `map` runs every root concurrently and retains each resulting URL list for optional synthesis. Multi-seed `crawl` divides the existing 25-page and 50-MB limits fairly across seeds, uses one shared page-fetch concurrency limiter, preserves same-host/endpoint scoping, and emits per-seed manifests with visible failed/skipped entries. The limits are not multiplied by seed count.

The disk cache intentionally has no TTL. `.cache/` is Git-ignored and exact paths remain available to `read` and `grep`. Cache metadata never stores URL userinfo or secret-looking query values. The session `responseId` retention store is deleted (owner decision 2026-08-07): oversized results are written as local cache files, read and grepped locally.

## LLM synthesis: `mode:"llm_answer"` (replaces the retired research brief)

The former `llm_rich` research-brief machinery and its 15-second provider deadline are **retired** at webclaw cutover (ADR-002.005). `mode:"llm_answer"` is the synthesis lane: fully async by default when requested (a message that the answer is being generated; the agent may continue or wait), optional `wait:N` window, LLM timeout 30s per call, completion pushed to the agent, and immutable sidecars keyed by cache path, current page content hash, objective, and `query_terms`. Exact repeats reuse; distinct intents on one page coexist; legacy `<cachePath>.summary.md` artifacts remain exact-match readable without migration. Ranked BM25 sections are not shown in this mode. The single-URL rescue (page >5K + query_terms + no/weak quality match below `WEAK_SCORE_FLOOR`) remains the one automatic LLM trigger and blocks its call.

**Retired: response-ID session retention.** The former in-memory `Map` + `storeResult`/`getResult` (1-hour TTL, `output.ts`) is deleted; `responseId` is removed from the surface (owner decision 2026-08-07). Oversized or later-needed results are written to local cache files and read/grepped there. `output.ts` no longer implements response retention; the boundary is the disk cache.
The persistence design notes below are superseded: the write-path analysis, the `appendEntry` mirror, the `storeFetched`/`restoreFromSession` retention, and the shared `web_lookup` Context7 `responseId` reuse are all retired with the `responseId` surface. `web_lookup` now saves Context7 complete raw bodies to `.cache/web/docs/<doc>/full.md|json` and prints the docs path for `read` (ADR-002.005), with no session store.

Historical write-path analysis (superseded 2026-08-07): `pi.appendEntry` and `ctx.sessionManager.getBranch()` were analyzed for cross-restart retention; that design was deleted with `responseId`. The durable boundary is the disk cache only.

## What would change this pipeline

- A handler's external-runtime cost (yt-dlp) proves undesirable → keep it
  optional/lazy or drop it; never make it required for base install.
- If plain-`fetch` robustness bounds (size/timeout) prove insufficient for real
  pages, adjust the bounds (still not a security layer).
- The YouTube backend question is resolved: yt-dlp captions, no model dependency.
- Targeted raw retrieval and separate LLM context are accepted. Reopen their bounds only when real-page evidence falsifies recall or context isolation. The research-brief/grouped-corpus/4K-budget/15-second-deadline/cooldown machinery is retired (ADR-002.005); the current synthesis contract is `mode:"llm_answer"` (async, 30s per call, summary file persistence, query_terms as model focus, single-URL weak-match rescue below `WEAK_SCORE_FLOOR`). The answer remains lossy synthesis; validated exact quotes and raw cached lines remain the evidence boundary.
- Generic video understanding remains an explicit capability gap until `alehdezp` decides whether captions/search are sufficient or a new reviewed provider is warranted; the accepted baseline does not imply the research outcome is closed.

## Token-efficient retained-evidence pilot

The 2026-07-31 eight-source pilot compared current Native readable extraction, codeweave-pi's existing section-projected QMD lexical path, and current Exa query-guided highlights. Native extraction succeeded on all eight HTML/JavaScript/PDF shapes. After decomposing multi-aspect questions, local section retrieval preserved every fixed literal evidence check with stable selectors/line ranges and 84.8% median character reduction, but a flattened PDF remained one 91,807-character section with no saving. Exa preserved the same checks with 83.1% median reduction and reduced that PDF by 98%; it supplied URL-level source attribution but no stable within-source locators and incurs provider work/cost for each new query. Nine Exa calls, including one evidence-triggered livecrawl correction, reported $0.009 total.

The pilot's architecture decision was resolved on 2026-08-03–04 without a QMD dependency or Exa route: local BM25 owns raw section retrieval, while an optional in-process model tier rescues measured weak/vague queries. Structure preservation and explicit widening remain mandatory. Exa query-guided highlights remain an alternative only if a later source-class comparison beats the local locator/quality contract.

## Alternatives and decisive trade-off

One universal extractor would mix unrelated URL/content concerns; enabling every optional handler at once would widen dependencies without proof. Handler dispatch plus native HTTP baseline lets each specialized path enter only when it materially improves extraction.

## Evidence and verification

Native HTTP extraction/dispatch, persistent cache reuse, and the pi-nav smart-read source view have deterministic execution proof. `tests/web-fetch.test.mjs` exercises the schema-v2 surface (full ≤5K, heading navigation beyond, query_terms ranked snippets with read ranges 5/3/2, per-source independent multi-source output, map/crawl semantics, llm_answer with/without objective, no-quality-match rescue, deepseek-key fail-closed, fenced-JSON tolerance), the webclaw spawn contract, and the js-needs escalation. The pi-nav view itself is owned and tested in the codeweave-pi extension (`pi_nav_read` outline/markdownStructure); web consumes it through the cache path and degrades to headers-only when absent.

Query retrieval retains contamination-controlled fixture and real-corpus recall/containment proof for the single-page BM25 lane (`tests/section-rank.test.mjs`, `tests/novel-corpus.test.mjs`, `tests/real-corpus.test.mjs`). The llm_answer lane is covered by focused web-fetch tests with a fake spawn; live LLM behavior remains environment-dependent and is exercised through bounded authorized runs, not the deterministic suite.

The current implementation checkpoint passed `npm run typecheck`, 35/35 focused `web-fetch`/summary-job tests, and the complete websift suite at 304/304. These checks prove the deterministic contracts and integration paths they exercise; live post-return model-visible completion still depends on the host `sendMessage` lifecycle and must be re-exercised after restarting Pi with the current extension source.

## History

- 2026-07-27: dispatcher + composable handlers settled; security module omitted
  and Jina/Gemini/Parallel/Perplexity branches trimmed by owner decision;
  YouTube/video deferred as optional with documented external runtime.
- 2026-07-29: Phase 5C reused the `storeFetched`/`responseId` retention for `web_lookup`
  Context7 docs — complete raw body retained, bounded inline excerpt, retrieved via
  `web_fetch({responseId})`; no Context7-specific cache added.
- 2026-07-31: Phase 5G reconciliation. Marked HTTP/GitHub/PDF/model-free YouTube
  handlers implemented and dispatched; removed the phantom `video.ts`/ffmpeg handler
  and the unported `isLikelyJSRendered` claim; reclassified video frames,
  local-video, model extraction, RSC, and the Jina/Gemini/Parallel/Perplexity
  branches as deliberate exclusions/future decisions rather than missing baseline.
  Recorded limits (PDF <= configured responseBytes default 5 MB and <= 100 pages;
  GitHub clone/`gh` runtime; YouTube needs yt-dlp and may degrade to metadata-only).
  `implementation_status` -> `validated` for the accepted baseline while retaining
  `evidence_grade: mixed` and explicit subprocess/body proof limits. Removed the
  project-dead `GitHubFetchOptions.forceClone` option and its branch from
  `github.ts`, and the unused `trimErrorText`/`mapFfmpegError` ffmpeg helpers from
  `utils.ts`.
- 2026-07-31: reopened token-efficient narrowing/indexing techniques as comparative research questions without adopting an architecture; kept the grounded Native baseline and recorded generic-video understanding as an owner-gated gap. The subsequent eight-source pilot found comparable median context reduction from section-projected local retrieval (84.8%) and Exa highlights (83.1%) but different failure modes—stable local locators versus Exa's flattened-PDF recovery—so no winner, dependency, route, or public contract was selected.
- 2026-07-31: Stage A audit corrected the proof boundary: deterministic Native HTTP/dispatch and retention are execution-proven; GitHub/PDF/YouTube parsing, detection, rejection, and normalization are focused-proven; their external-runtime extraction paths remain integration-level. No production seam or duplicate test was added to manufacture unit proof.
- 2026-07-31: focused provider preparation found that page-only Native could intercept `site`/`map` before Tavily; added public-tool mode-routing proof.
- 2026-08-01: native apprenticeship exercised structured React docs, Linkup docs, GitHub root/blob, BrowseComp PDF, YouTube transcript, and the public retained-page path. The run exposed that extension-matched PDFs bypassed `http.ts` byte/timeout guards; PDF routing was centralized through `fetchHttp` and covered by one focused regression test. YouTube transcript output gained minute timestamp locators. Native extraction handled the sampled Linkup documentation without JavaScript rendering, so that URL no longer supports a rendered-fetch recommendation.
- 2026-08-01: `alehdezp` deferred query-aware retained passage narrowing and the proposed public `web_fetch.focus` contract. Current bounded-inline plus full-body `responseId` behavior remains; no selector, index, cache, codeweave-pi dependency, or automatic paid fallback is authorized.
- 2026-08-02: `alehdezp` accepted persistent exact-URL caching, 5,000-token full-page threshold, hierarchy-preserving smart views, download/refresh modes, cached regex retrieval with exact line locators, tolerant grouped inputs, bounded explicit crawl, per-URL partial results, and secret-safe YAML provenance. Added `src/fetch-cache.ts`, rewired `src/tools/web-fetch.ts`, and added five connected public trajectories without selecting a provider-quality role.
- 2026-08-02: accepted Native as the general default and Tavily basic as first route for the evidence-backed host/path table; added calibrated thin-readable classification, one visible fetch-empty fallback, and origin-auth isolation while keeping Linkup and Tavily advanced explicit.
- 2026-08-03: shipped `query` BM25 raw-section retrieval, compose-over-reject semantics, heading navigation, a contamination-controlled recall surface, and the optional quality-triggered `llm_rich` tier with exact expansion locators.
- 2026-08-04: rejected summary-only multi-query reuse after a false-negative QMD probe; replaced it with cost-gated prior context plus newly ranked raw evidence. Added the fixed DeepSeek provider/model fallback hierarchy and visible provenance. Rejected destructive cache cleanup because current noise is not structurally separable from valid navigation.
- 2026-08-04: clean break replaced public `query` with `query_terms` and added LLM-only `context`; no alias remains. Added tri-state LLM behavior, summary policy/context cache keys, one-corpus grouped ranking, one-answer grouped synthesis, per-page navigation, OpenCode Go → CommandCode → official DeepSeek silent fallback, and ten-minute provider cooldown. A small two-page call answered both facts in 3.7 seconds. A 367K-character probe then falsified ranked-only over-cap input by starving Beta; fair per-page prefixes plus global lexical hits returned both facts in 4.9 seconds while declaring 107,529 omitted characters.
- 2026-08-04: owner accepted quality-first source-grounded research briefs. Removed prior-summary delta substitution and default repair calls; added answer-first adaptive synthesis, deterministic exact/uniquely-normalized quote validation, derived cache ranges, stable section/link IDs, page-authored link recommendations, bounded inferred research opportunities, visible synthesis status, and one 15-second provider deadline. Live integrated QMD proof completed in 5.762 seconds through OpenCode Go with validated evidence and navigable recommendations. Same increment added `not_found` 404/410 classification, fetch-specific recovery, partial-failure next actions, and stronger same-question grouping guidance.
