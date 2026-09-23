---
title: "Research tool and source-lane preflight"
description: "Select startup or lazy websift tools by evidence need, activate exact provider specialists, and preserve failure and evidence boundaries."
tags: [jeito-websift, research, tool-selection, provider-specialists, evidence-lanes]
created: 2026-07-31
updated: "2026-09-22 13Z"
status: active
---

# Research Tool and Source-Lane Preflight

Read this when `$research` names or needs a specialized provider/lane, or when the active tools may not expose the required surface. It prevents silent fallback to whichever search box happens to be loaded.

## Live schema is authoritative

jeito websift registers nine tools. `web_search` (Serper Search), `web_fetch`, `web_answer`, and `web_lookup` are startup-active. `web_search_exa`, `web_search_x`, constrained `web_search_tavily`, `web_answer_exa`, and `web_answer_linkup` are installed but lazy. Before the first external search:

1. Inventory only the provider/method lanes that could change the answer.
2. Treat `web_search` as Serper lexical Search, never a generic router.
3. When another method is material, call `tool_search` with exactly one specialist name, inspect its live schema/guidelines, and keep one explicit provider attempt with no hidden fallback.
4. Name the diversity hypothesis: the source class, language/region, chronology, social provenance, semantic neighborhood, or sequential retrieval error the second method could expose. “Try another provider” is not enough.
5. Do not request non-callable operations: Exa Contents/Similar/Research; Tavily full Crawl/Research/usage and query-guided Extract; Linkup structured Search/Research/balance; xAI model/video controls.
6. Record a compact preflight receipt in `ACTIVE.md` or chat.

```text
surface | tool/method | state | purpose | decisive parameters | evidence right | fallback limit
```

Do not load every tool. If exact-name discovery fails, record `installed but undiscoverable` or the returned diagnostic. Never use a different provider while claiming the selected method ran.

## Exact tool states

- `active/callable`
- `installed but inactive`
- `configured but reload required`
- `excluded by policy`
- `missing API key/config`
- `provider/API failure`
- `bad query/parameters`
- `not installed`
- `no public call (internal/comparison-only)`
- `worked but wrong target`
- `worked but weak evidence`
- `worked and produced target leads`

A provider/API error is not a zero-result finding. A weak query is not proof the lane is bad. A successful call returning adjacent results is not evidence that no exact result exists.

## Choose by evidence surface

| Needed surface | Capability shape | What it can establish | Common failure |
|---|---|---|---|
| Official/current lexical | Serper-backed `web_search` with distinctive terms plus at most one initial quoted identity or `site:` constraint | Current source identity and documented contract after fetch | Over-constrained first query or generic rankings |
| Semantic/novelty | `web_search_exa` with a date/category/domain/text bundle | Unfamiliar vocabulary and candidates | Plausible but off-target adjacency |
| Structured relationship | `web_answer_exa` with explicit match/none semantics | Auditable candidate fields and cited gaps | Schema-valid entity or absence error |
| Official-domain/date orientation | `web_answer_linkup` with exact dates/domains | Candidate first-party page and sourced orientation | Passage omits decisive metadata |
| Current/regional broad web or independent technical guide | constrained `web_search_tavily` basic/general search with focused query and optional full-name country | Candidate source diversity after fetch | More sources without decision value |
| Implementation | Repository/source/code/issues/releases via `web_fetch`/`bash curl` | Actual mechanism, history, maintenance | README claims without source proof |
| Registry/package | Registry metadata, tarball/source via `bash curl` | Versions, dates, dependencies, shipped artifacts | Package site/marketing as implementation proof |
| Library/API | `web_lookup` Context7 plus upstream source | Versioned API/contract | Current docs mismatched to pinned version |
| Social/practitioner | `web_search_x` with exact dates/handles | Current posts, first-hand signal, vocabulary | Synthesis, hype cluster, inaccessible target posts |
| Criticism/failure | Issues, postmortems, negative search, forums | Known failures and costs | Anecdote generalized without scope |
| Provenance | Exact phrase/title/author/DOI/repo search | Original source behind repeated claim | Citation laundering through aggregators |
| Media | Transcript/chapter/frame-aware fetch | Verbal/demo/visual evidence | Title/description substituted for content |
| Crawl/site map | `web_fetch` `mode: map` then selected-page fetch | Site structure and selected target pages | Crawling hundreds of irrelevant pages |
| Raw transport/debug | `bash` + `curl` headers/body/status (web_fetch has no raw mode) | Access/redirect/body state | Treating raw/shell content as semantic evidence |

## Provider constraints

A user-named provider or source lane is a constraint. Use it when callable. If unavailable, report the exact state and ask before substituting when the substitution materially weakens the requested evidence.

Do not silently replace:

- native X search with generic web snippets for a social-signal question;
- repository/source inspection with a product page;
- registry metadata with a package marketing page;
- versioned docs with trained-in API memory;
- a requested date window with a vague “recent” filter;
- primary-source fetch with a provider answer.

## Discovery versus evidence

Default rights:

- search/ranking/answer/summary/catalog: lead-only;
- fetched target page/post/source: evidence-eligible for the visible scoped claim;
- repository/registry metadata: evidence-eligible for repository/package facts;
- source/code/changelog/issue/release: evidence-eligible for the exact implementation/history claim;
- social post: evidence about that post or author claim, signal for broader conclusions;
- bounded site traversal: per-page evidence only where target content is present.

Synthesized answers can accelerate vocabulary and source discovery. Preserve every citation URL, but verify recommendation-driving claims in the cited primary source.

## Failure-driven lane repair

| Result shape | Repair |
|---|---|
| Exact target URL found | Stop broad search; fetch/read it. |
| Adjacent semantic flood | Add hard mechanism and disqualifiers; switch to exact/primary source search. |
| Famous usual suspects dominate | Exclude names/class; use date/source-type constraints and semantic frontier lane. |
| New obscure candidates dominate | Verify mechanism/source first, then current quality/adoption; do not promote from novelty. |
| Listicles/SEO dominate | Restrict to primary domains/artifact types; search source-of-source. |
| Social launch repetition | Exclude launch handles/products; add first-hand-use and criticism language. |
| Block/shell | Try an alternate primary route (JS/login shells escalate to the tavily lane automatically via js-needs detection); classify access debt if still blocked. |
| API/provider failure | Record exact failure; retry on wrong parameters or one reduced-payload retry on timeout (smaller count / faster depth); otherwise use an approved alternative or state blockage. |
| `web_fetch` fails `policy` naming webclaw or its version | Environmental, not an input problem: run `webclaw --version`; align the binary into 0.6.16 <= v < 0.7.0 (macOS `brew upgrade 0xmassi/webclaw/webclaw`) or install it, then retry the same call — no URL/mode change and no restart needed. `/web-doctor` shows the installed version's status; search/answer/lookup lanes are unaffected meanwhile. |
| Zero results after overconstrained query | Relax one soft dimension, preserve hard gates, or change lane. |
| Same reject classes after two query mutations | Change source type/search mode instead of paraphrasing again. |

## Specialized capability activation

Use a sparse activation rule:

- semantic search (`web_search_exa`) only when unfamiliar vocabulary or adjacency could reveal a qualifying candidate;
- social search (`web_search_x`) only when social signal, practitioner language, or posts are target evidence;
- site map/selective fetch only when multiple pages on one site are necessary;
- `web_answer` only for quick provisional orientation; use `$mini-research` or `$research` when the answer must be established from fetched evidence;
- package/skill catalogs (`web_lookup`) only when that ecosystem is plausibly the solution space;
- library-doc tools (`web_lookup` context7) before coding against a third-party API, but still match the project's pinned version.

## Preflight completion test

Before search, you should be able to answer:

- Which hard requirement does each active lane test?
- Why is the chosen tool/route better than the fallback for that requirement?
- What live parameters enforce date/domain/source constraints?
- What result would trigger fetch instead of another search?
- What limitation remains if the lane fails?

If not, the preflight is provider theater rather than research planning.
