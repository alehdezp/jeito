---
title: "ADR 2.5 — webclaw extraction redesign: native text extraction superseded"
description: "Records the accepted webclaw/Tavily extraction redesign, crawl and llm_answer architecture, pi-nav source views, and pinned webclaw DNS/redirect enforcement."
tags: [jeito-websift, adr, webclaw, tavily, extraction, crawl, escalation, llm-answer, redesign, ssrf]
created: 2026-08-06
updated: "2026-09-22 13Z"
status: active
adr_id: ADR-002.005
adr_type: child
decision_status: accepted
confidence: evidence-backed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "The webclaw+tavily extraction stack, escalation policy, crawl/map scope, llm_answer persistence, pi-nav source view, and pinned webclaw DNS/redirect contract"
audience: contributor
parent: docs/adr/0002-internal-architecture/README.md
code: [src/tools/web-fetch.ts, src/fetch-cache.ts, src/destination-policy.ts, src/crawl-jobs.ts, src/js-needs.ts, src/webclaw-spawn.ts, src/adapters/webclaw.ts, src/adapters/tavily.ts, src/routing.ts, src/config.ts, src/fetch-handlers/github.ts, src/fetch-handlers/pdf.ts, src/fetch-handlers/youtube.ts]
related: [docs/adr/0002-internal-architecture/0003-fetch-pipeline.md, docs/adr/0002-internal-architecture/0002-routing-and-failover.md, docs/adr/0005-provider-evaluation-and-guidance/0004-benchmark-and-selection.md]
---

# ADR 2.5 — webclaw extraction redesign: native text extraction superseded

## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-002 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: evidence-backed`, `evidence_grade: verified`, `implementation_status: validated`. The extraction stack, bounded crawl, and async `llm_answer` generation are active.

**Crawl safety repair (2026-08-11).** `mode:"crawl"` is active again after local postconditions and lifecycle repair: bare-glob scopes seed webclaw at their literal path prefix; every reported URL must be present, same-origin, included, not excluded, destination-policy-approved, deduplicated, and inside the local 25-page cap before cache write. Identical running jobs share one subprocess and session shutdown aborts it. Deterministic regressions cover scope/cap/dedupe/abort, and a bounded live `https://tokio.rs/tokio/topics/*` call retained five scoped pages with no root leakage.

**`llm_answer` release evidence (2026-08-11).** The asynchronous generator deduplicates exact work, honors `wait`, reports completion once, aborts on shutdown, reads retained cache bytes via webclaw `--file`, and rejects writes after concurrent refresh. Immutable sidecars key cache path, content hash, objective, and `query_terms`; distinct page intents coexist, exact repeats reuse, and legacy `.summary.md` artifacts remain exact-match readable. An adaptive 20-job packet generated 20/20 artifacts (16 verified, 4 partial, zero factual drift/failure, no Tavily/fallback/retry). A fresh normal-startup proof then generated two distinct MDN 418 intents at different keyed paths and reused the second byte-for-byte.

## Decision

The web extension's text-extraction stack is:

1. **webclaw (local Rust binary, `/opt/homebrew/bin/webclaw`) is the universal text extractor** — single URL, batch/parallel, crawl, map, sitemap. Embedding = `child_process` spawn with `-f llm`; the `@webclaw/sdk` npm package is cloud-only and is NOT used.
2. **tavily is the paid escalation lane** — JS-rendered pages and webclaw failures only.
3. **native is KEPT for the download/intelligence class** — PDF, YouTube, git clone, and further download features the owner will define later. Native's readability text-extraction role ends.
4. **crw, exa, linkup, lightpanda are out of the fetch stack.** Existing search/answer adapters (serper, xsearch, exa, linkup) stay untouched — the port list is extraction only.

Implementation completed and cut over 2026-08-06 (webclaw adapter + async crawl/map + verticals + llm_answer + js-needs DB v2; 238-test suite green; live smoke against the real binary). The quality rule throughout was that anything answerable by docs, code reading, or experiment was answered that way before being asked.

## Schema v2 (grill rounds 1–6, 2026-08-07) — surface simplification

A follow-on grill (rounds 1–6) simplified the public schema; the extraction stack above is unchanged. Final contract:

- **Parameters:** `urls` (string | string[], the ONLY required parameter) · `mode` (page default | download | map | crawl | llm_answer; arrays accepted) · `objective` (dormant hint — used only by `mode:"llm_answer"` or the single-URL no-quality-match rescue) · `query_terms` (optional addition) · `wait` (0–60s; crawl polls default 30s). Removed: `url`, `responseId`, `crawl_id`, `pattern`, `top`, `question`, `extract`, `linkup`, `llm_rich`, `summary_id`, `context`, `refresh` (merged into download), `site` (alias for map).
- **Tolerance doctrine:** every parameter combination is accepted; the most logical resolution wins and is reported in the result; the only hard error is an empty call. Scheme-less hosts get https://; mode arrays resolve (crawl only alone on one URL; download over map; llm_answer rides page/download per URL); multi-URL calls never crawl.
- **Content is always shown:** full up to 5K tokens (universal cap); beyond that the source view is web metadata + pi-nav smart read over the cache file (pi-nav's own thresholds decide full vs outline: `TOKEN_THRESHOLD` 6000, `OUTLINE_MIN_COMPRESSION` 80, 500KB cap; `[start-end] ## Title` outline entries; `markdownStructure` selectors). The former 2K smart-view budget is retired (owner 2026-08-07). `query_terms` is an addition: single page top-5 matches (score + exact line range to read + 3 lines of context; focus markers on the full page ≤5K), batch top-3 per source ordered by best score, crawl top-2 per page; no-match sources show their cache path (read or grep the file). In `mode:"llm_answer"`, ranked snippets are NOT shown — `query_terms` become model focus only.
- **The LLM fires only** on explicit `mode:"llm_answer"` (async by default: generate, continue or wait; optional `wait:N`; 30s per call; immutable intent-keyed sidecar, exact-repeat reuse) or the single-URL rescue (page >5K + query_terms + no/weak quality match below `WEAK_SCORE_FLOOR` 2.0). `objective` alone is inert. In `llm_answer`, `query_terms` select the intent and are passed to the model as focus.
- **Crawl:** async parallel job; the URL carries the scope — `https://x/` and `https://x/test` crawl the site or the /test subtree, `/*` one level, `/**` recursive (capped 25), `+[a/*,b/*]-[c/*]` with brackets optional around a single include; poll by `urls:"crawl:N"`; completed jobs are reported on the next web_fetch call (never silent, never lost); `query_terms` given with the crawl call ranks each page (top 2) at poll time.
- **context7** saves the complete raw body to `.cache/web/docs/<doc>/full.md|json` and prints the path — the agent reads it with the read tool; the retained-session store (responseId) is deleted.
- **Hardening round (2026-08-07, external reviewer probes):** the map path crashed with an uncaught `TypeError` whenever the host supplied a live progress callback (`mapManyFlow` fed `ToolResult` objects into the `UrlResult`-shaped progress builder; CI never passed `onUpdate`). Fixed by map-shaped progress details plus a top-level `execute` guard that converts any unexpected throw into a structured `unavailable` failure with recovery advice. Exit-1-with-valid-stdout (webclaw's documented partial-failure contract) now yields the parsed URLs plus a partial note instead of a total failure, for both map and crawl. The spawn layer guarantees string stdout/stderr; map rows must be absolute URLs. Output honesty: `llm_answer` counts a source answered only when the LLM call actually succeeded; map truncation reports `N of M shown (siteMapCap)`; every result carries `details.operation` (ADR 1.4 mode display) and the cache line shows the fetch date. `site`/`refresh` literals were removed from the schema union (scalar values now hard-reject naming the five valid modes; array-form tolerance with notes remains).
- **Reviewer-triage round (2026-08-07, second external review):** accepted and fixed — (1) js-needs DB landed at a doubled path (`<root>/.cache/web/.cache/web/js-needs.json`) because the adapter passed a cache-rooted root into a module that re-applied `cacheRoot`; js-needs now takes the cache-root convention used by every cache consumer (sane path, one convention). (2) Rule v2 flagged legitimately tiny pages WITH a heading (example.com: 117 chars, 1 heading) as JS shells, misrouting free static content to the paid lane; calibration correction — both clauses now require a headingless body (all three measured shells are headingless; the tiny-static class is now shown, per content-always-shown). (3) LLM lanes ran page content into `--extract-prompt` with no trust boundary; prompts now frame the page as untrusted data, and `llm_answer` labels answers as model output over untrusted content. (4) Error taxonomy: `map` classified spawn failures as `unavailable` while the fetch lane emitted `network`/`timeout`/`not_found`/`policy`; map now uses the same `mapSpawnFailure` vocabulary. (5) `details.operation` now also appears on flow-level failures. (6) `parseSummaryJson` tolerates fenced/prose-wrapped JSON. (7) `headingNav` truncation in `llm_answer` is reported. (8) Fetch spawns honor the caller's AbortSignal (pre-abort check + `execFile` signal; `aborted` failure class). (9) promptGuidelines gained the cross-tool pointer (web_search/web_answer), cache-hygiene note, and body-secret echo note; the playbook's removed-surface claims (`renderJs`, `extract`, Linkup branch) were replaced with the current contract. **Rejected with evidence:** unknown-parameter tolerance — `additionalProperties: false` was locked in the grill and the host rejects typos like `objetive` at schema validation; the reviewer's probe bypassed the host.

## Rounds 4–5 settlements (same session, 2026-08-06) — scope widened, then closed

The owner widened the scope after round 3 ("port almost everything that makes sense") and settled the remainder:

**Substrate, not just a tool:** one config change (`priority.fetch: [webclaw, tavily]`) makes webclaw the page extractor for `web_fetch` and the research/mini-research skills that call it. Startup `web_answer` no longer fetches evidence; `web_lookup` remains provider-owned. The `linkup` renderJs parameter is removed with `extract` (Linkup is out of the fetch stack).

**Vertical extractors — ported, proven subset only:** auto-dispatch by URL shape (the `dispatch.ts` pattern) for the 8 verified-working verticals: `npm`, `pypi`, `crates_io`, `docker_hub`, `arxiv`, `huggingface_model`(+`dataset`), `stackoverflow`, `hackernews`. Typed JSON is stored as the cached body (no lossy markdown conversion). Evidence: 13-vertical experiment (`extensions/websift/.tmp/webclaw-port/exp-verticals.ts` + `out/vert/`) — notably `crates_io` and `stackoverflow` return EMPTY generic llm extraction but rich typed JSON (rescue, not nicety). `github_*`/`youtube_video` shapes stay with the existing github/youtube handlers; bot-walled verticals (trustpilot/amazon/instagram/linkedin/ebay/etsy) escalate to tavily under the architecture, and unproven shapes (reddit/dev_to/shopify — 404 on guessed URLs) get no dispatch until a real URL proves them.

**Excluded, confirmed:** search (duplicates serper), `--watch`/`--on-change`/`--webhook`, `--brand`, cloud `--research`/`--api-key`, `--bench`, `--diff` (needs a JSON snapshot store that breaks the single-format lock), `--path-prefix` (glob covers it), `--extract-json` (deferred with the llm_answer lane).

**PDFs stay native — webclaw's `--pdf-mode` is NOT superior:** 118–121K-char arxiv extraction carried 396 `Unicode mismatch` debug lines on stdout and one heading; native `pdf.ts` (unpdf) keeps page markers, metadata, truncation markers. PDF text extraction remains with native.

**Crawl is an async parallel job:** runs until all pages are downloaded (webclaw `--crawl`, concurrency 5, delay 100ms); returns a session-local job id immediately; the agent soft-waits (`wait:N`) or polls; the listing (title + estimated tokens + cache path) is returned on completion. Reuses the retired summary-job pattern; no new public knobs (`wait` already exists). Map = `--map` capped at `siteMapCap` (25).

**`--only-main-content`: FINAL = OFF, always, never public** (13-host verdict: 0–4% savings, drops structural headings, non-subset behavior).

**Onboarding install:** webclaw presence becomes a check in jeito-setup's machine snapshot and websift-setup's zero-arg review; both offer `brew install 0xmassi/webclaw/webclaw` (macOS) or the README's GitHub-release/cargo path (Linux) with the usual preview/confirm; runtime missing-binary is a clear error with the exact command. Substrate detail: `defaults.maxAttempts = 2` is already the retry contract; js-needs rule v2 stays as measured (zero false positives), exposed as a tunable constant.

## Locked design (grill rounds 1–3)

**Extraction and embedding**

1. Spawn `webclaw <url> -f llm`; parse the leading `> KEY: value` header block into the cache YAML frontmatter; body is markdown. Verified end-to-end against the real `writeCache`/`readCache` (unicode titles, redirects — webclaw reports the final URL as canonical for free, query strings, missing-field variants).
2. **Single format `llm` everywhere** — cache and agent-facing return. No format fork.
3. **`--only-main-content` default OFF** (never a public option). 13-host experiment: 0–4% savings, drops structural headings (Fed press release), non-subset behavior on GitHub. No fidelity loss justified.
4. Empty-body success (pure SPA, exit 0) is never cached; it feeds detection/escalation.

**Escalation policy**

5. DB-first: js-needs DB hit → tavily directly. Otherwise webclaw; then JS-needs detection on webclaw output **and any webclaw failure** → tavily. Detection/failure writes the DB.
6. **JS-needs rule v2** (llm output has no links, so v1's link component is dead): `(headings == 0 && textChars < 2000) || textChars < 200` — 16-page experiment: caught all 3 true shells (hn.algolia.com, qwen.ai/blog SPA, x.com status), zero false positives on 8 known-good pages. webclaw's static engine also extracts pages native needed JS for (linear.app, docs.anthropic.com, x.ai/news, docs.tavily.com).
7. **The js-needs DB is wiped at cutover** and re-learned under rule v2: its native-era records (docs.tavily.com, x.ai/news) would route free webclaw pages to paid tavily forever, because DB-first routing skips the webclaw success that self-heals records.
8. **Tavily truncation guard** (tavily silently truncates very long pages — RFC 4918 evidence): detect TOC-shaped output (heading-heavy, body tiny vs raw), warn in the result. No re-fetch: escalation only fires where webclaw already failed, and the truncation class is handled by webclaw locally.
9. tavily inside crawl/map: **never**.

**Crawl, map, sitemap, URL format**

10. Crawl is download-only: files on disk under the existing cache naming schema; the agent receives a listing (webclaw title + estimated tokens + path), never raw crawl content. Defaults depth 1, max 25 pages; webclaw concurrency 5 / delay 100ms kept.
11. Depth is encoded in include globs: `test.com/*` = depth 1, `test.com/*/*` = depth 2. Implementation expands `X/*` to also include `X/` itself (webclaw's glob does not match the directory page itself — verified).
12. Canonical URL form `https://host/+[inc/*,other/*]-[exclude/]`; bare `http://host/path/*` also valid; tolerant parsing, minimal errors. No brackets = plain single-URL fetch.
13. Sitemap (robots.txt + /sitemap.xml) is always merged into crawl scope when it works; **excludes apply to sitemap-seeded URLs** — verified zero leakage on sitemaps.org across 17 excluded prefixes. This is webclaw's native behavior; no code needed.
14. Batch/multi-URL stays public: webclaw parallelizes internally; partial failure exits non-zero but stdout still carries every good page — the wrapper parses stdout regardless of exit code; missing URLs escalate.

**Tool surface**

15. **Zero new public knobs.** The URL + format string carries includes/excludes/depth; all else is fixed internal defaults.
16. **`llm_rich` parameter removed; new `mode: "llm_answer"`** — async by default when requested (message "answer being generated, continue or wait"; optional `wait:N`; completion pushed), LLM timeout **30s per call**, and immutable sidecars keyed by cache bytes + objective + `query_terms`. Distinct intents coexist and exact repeats reuse; legacy `.summary.md` artifacts remain exact-match readable. Ranked snippets are not shown in this mode. `llm-rich.ts` + `fetch-summary-jobs.ts` are retired; `section-rank.ts` survives.
17. The LLM lane runs webclaw's own `--summarize`/`--extract-prompt` with `--llm-provider openai --llm-base-url <endpoint> --llm-model <model>` and the key via `OPENAI_API_KEY` env. **Provider: deepseek direct** (`api.deepseek.com`, `deepseek-chat`, key from `~/.pi/agent/auth.json`). No `--llm-api-key` flag exists in webclaw 0.6.16; the opencode gateway key authenticates but the account has zero credits (verified `CreditsError`); no local ollama.

## Relationship to ADR 2.3 and pi-nav

At cutover this ADR supersedes parts of [ADR 2.3](0003-fetch-pipeline.md): `src/fetch-handlers/http.ts` retires as text extractor (deleted); the native adapter's fetch-priority slot becomes webclaw; the `llm_rich` research-brief machinery retires in favor of `mode:"llm_answer"`. The persistent cache contract (`fetch-cache.ts`), routing/fallback machinery, TAVILY_PREFERRED_FETCH_RULES, and the github/youtube/pdf handlers carry over unchanged. The legacy `extract: readable|markdown|raw` parameter is **removed** (owner decision 2026-08-06: "ignore and remove extract") — not kept, not accepted-and-ignored. Old cache entries (`extract: readable`) remain readable and simply age out — no purge, no migration.

**Source view = pi-nav smart read (owner 2026-08-07).** The model-visible view for a cached page is web metadata (webclaw `-f llm` header title/description/word count) + pi-nav `pi_nav_read` over the cache file; pi-nav's thresholds decide full vs outline (`TOKEN_THRESHOLD` 6000, `OUTLINE_MIN_COMPRESSION` 80, 500KB cap) and `markdownStructure` supplies exact section selectors. The web layer keeps acquisition + cache path only; the 2K smart view is retired. When pi-nav is absent, web degrades to headers-only + clean notice. The codeweave-pi provider seam (`createPiNavSmartSummaryProvider` → `callPiNav({operation:"pi_nav_read", args:{path, mode:"auto", budget}})`) is the verified integration point.

## Evidence base

- Redesign experiments (this decision): `extensions/websift/.tmp/webclaw-port/` — `probe-e2e.ts` (embed contract), `exp-maincontent.ts` (13 hosts × 2 modes), `exp-jsneeds.ts` (16 pages + rule evaluation), `exp-summarize.ts`/`exp-summarize2.ts` (LLM lane incl. the credits failure), `exp-crawl.ts` (include/exclude/depth/sitemap/split/listing), `out/` artifacts.
- Stack-selection evidence: `extensions/websift/.tmp/provider-fetch-comparison/` (53-page run, 16-page × 6-lane v2 run, records + report).
- **Version-matched redirect/DNS security evidence (2026-08-11):** webclaw v0.6.16 [`url_security.rs`](https://github.com/0xMassi/webclaw/blob/v0.6.16/crates/webclaw-fetch/src/url_security.rs) rejects mixed/private/internal DNS answers, including embedded IPv4; [`tls.rs`](https://github.com/0xMassi/webclaw/blob/v0.6.16/crates/webclaw-fetch/src/tls.rs) installs a public-only resolver and asynchronously validates every redirect destination. `src/destination-policy.ts` owns extension preflight, pinned direct fetches, and direct redirects; `src/webclaw-spawn.ts` refuses URL-bearing work from any other binary version, and webclaw/crawl-reported URLs re-enter policy before persistence.
- Session record: `/tmp/webclaw-redesign-handoff.md` (rounds 1–3, verified facts, grill quality rules). Superseded design grill: `.pi/goals/web-fetch-v2-design-grill.md`.

## Version guard revision (2026-09-22)

The exact pin `v === 0.6.16` blocked every URL-bearing fetch for seven days once Homebrew moved the binary to 0.6.23 (symlink 2026-09-15): the guard failed closed as designed, but the generic `policy` recovery text misdirected callers, `/web-doctor` only checked presence, and the failed check was memoized for the whole session. Review of the 0.6.16→0.6.23 delta: `url_security.rs` changed by one test-assertion line, `tls.rs` by one pool-size constant, zero security commits in the range, and every CLI surface this extension uses (`-f llm`, `vertical`, `--map*`, `--crawl*`, `--file`, `--extract-prompt`, `--llm-*`) verified present and smoke-tested on 0.6.23. Decision: the guard becomes the reviewed **range 0.6.16 <= v < 0.7.0** — the floor keeps this ADR's SSRF evidence bound, the ceiling keeps fail-closed at the 0.x breaking boundary — failed checks re-read instead of memoizing, version/PATH policy errors carry site-owned `advice` with the exact fix, and `/web-doctor` reports range conformance (`webclaw_version_mismatch`). This satisfies the deferred "revisit on upgrade from 0.6.16" condition below.

## Deferred and revisit conditions

Deferred by the owner: more native download features beyond pdf/youtube/git-clone; the llm_answer lane's deeper design (quality eval, summary-file schema for a future pi-nav/QMD reader). Revisit this ADR when webclaw's CLI contract changes materially (upgrade from 0.6.16), when tavily's escalation economics or truncation behavior change, or when a local JS-rendering engine re-enters the evidence with comparative proof. The pi-nav source-view integration is the active alignment item: web must consume `pi_nav_read` over cache paths and degrade to headers-only when the lane is absent.
