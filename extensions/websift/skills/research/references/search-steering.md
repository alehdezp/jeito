# Precision Search Steering

This is the mandatory operating reference for every `$research` W3/W4 run. It turns rejected results into better retrieval instead of repeatedly returning attractive neighbors.

## 1. Build the admission contract

Copy the eligibility contract from `SKILL.md`. Convert prose into pass/fail requirements before querying.

Example request:

> Find a current agent-research technique released in the last 90 days that prevents adjacent-result substitution, is simpler than a multi-agent framework, has an inspectable implementation, and has meaningful current signal.

Contract:

```text
Must have:
- published/released in the last 90 days;
- explicitly prevents or measures adjacent/off-target result substitution;
- instruction-level mechanism usable without training a model;
- implementation, prompt, or reproducible procedure is inspectable;
- lower ceremony than a multi-agent research framework.

Disqualifiers:
- generic RAG/search framework;
- training-only retrieval method;
- generic “verify sources” advice;
- older method with no current successor/application;
- README/tagline-only evidence;
- popularity without the required mechanism.

Quality signals after fit:
- maintained primary artifact;
- independent discussion/use;
- engagement/adoption relative to age and field;
- criticism/failure evidence;
- reproducibility.
```

Do not search until this distinction is clear: **must-have**, **preference**, or **signal**. A signal never compensates for a must-have.

## 2. Query from the discriminator, not the topic

A weak query names the field:

```text
best new AI research agents
```

A discriminating query names the behavior, source shape, time, and exclusions:

```text
("off-target" OR "requirement satisfaction" OR "hard negatives")
("search agent" OR "deep research")
(released OR benchmark OR implementation)
after:2026-04-01
-"RAG tutorial" -LangGraph -CrewAI -AutoGen
```

Before each call, state:

```text
Uncertainty tested:
Why this lane can answer it:
Qualifying result shape:
Known reject classes excluded:
```

## 3. Triage before deep reading

Use this order:

1. **Identity:** Is this the exact artifact/source, not an aggregator or similarly named object?
2. **Hard fit:** Does visible evidence satisfy every must-have?
3. **Disqualifier:** Does any rejection condition apply?
4. **Evidence potential:** Is there a fetchable primary source capable of proving the fit?
5. **Only then:** currentness, maintenance, adoption/engagement, independent signal, cost, and superiority.

Verdicts:

| Verdict | Meaning | Next action |
|---|---|---|
| `qualifies` | All hard requirements are proven. | Compare/verify recommendation claims. |
| `unverified-exact-fit` | No known hard failure; primary proof remains. | Fetch the narrow source needed. |
| `discovery-only` | Useful vocabulary/category/source-of-source, but not the target. | Reuse the useful term; never recommend it. |
| `reject` | Any hard requirement fails or a disqualifier applies. | Record the class and retrieval bait. |
| `duplicate` | Already evaluated candidate/class. | Skip without rereading. |

Do not use `near-miss` as a holding area. Unless the user asks for near misses, a candidate that fails eligibility is a reject. A useful mechanism from a rejected artifact may become vocabulary, not a recommendation.

## 4. Normalize rejection classes

Use stable classes so repeated noise becomes visible:

- `wrong-target`: similar words, different user outcome;
- `missing-mechanism`: claims the outcome but does not implement/measure it;
- `constraint-violation`: fails date, platform, license, scope, complexity, or another hard rule;
- `inferior-or-baseline-equivalent`: no named improvement over the baseline;
- `training-only`: requires model training when the task needs an instruction/workflow;
- `source-thin`: tagline, snippet, abstract, README, or marketing with no proving artifact;
- `stale-or-superseded`: outside the window or replaced/deprecated;
- `low-signal-unvalidated`: exact-looking but no maintenance, use, evidence, or independent signal yet;
- `hype-duplicate`: repeated launch/SEO/listicle cluster with no new evidence;
- `too-much-ceremony`: satisfies mechanism but violates simplicity/cost constraints;
- `inaccessible`: primary evidence unavailable; do not promote from summaries.

Record only the reason needed to prevent repetition:

```text
result: CrewAI research workflow article
verdict: reject
failed requirement: lower ceremony than a multi-agent framework
class: too-much-ceremony
retrieval bait: “agent research workflow” favored orchestration frameworks
useful vocabulary: independent verifier
next positive discriminator: “single-agent” OR “prompt-level” OR “no orchestration”
next exclusion: -CrewAI -LangGraph -AutoGen -"multi-agent framework"
```

## 5. Compile rejection into the next query

A meaningful mutation changes what the retrieval system can return.

### Positive discriminator

Add the missing behavior or artifact shape:

- `"cannot self-approve"`
- `"requirement satisfaction"`
- `"query reformulation"`
- `"abstain"`
- `site:github.com (prompt OR skill OR implementation)`

### Negative discriminator

Exclude a repeated bait term, candidate, domain, or class:

- `-LangGraph -CrewAI -AutoGen`
- `-"RAG tutorial" -listicle`
- `-training -"reinforcement learning"`
- `-site:medium.com` when Medium listicles dominate this exact route

### Source-shape mutation

If wording changes still produce the same class, change where you look:

- broad web → official docs/changelog;
- keyword search → semantic search for unfamiliar vocabulary;
- semantic search → exact repo/registry/paper search;
- social launch posts → GitHub releases/issues/source;
- product pages → criticism/issue/failure lane;
- search results → source-of-source links from one promising artifact.

### Registry-API qualifier search (the highest-leverage trick)

When a hard requirement is expressible as a **numeric/date qualifier** (star count, push/commit recency, creation date, forks, license, language, archived state), do not approximate it with keyword search — execute it directly with the registry search API's qualifier syntax via `bash` + `curl`. Keyword search cannot reliably filter by adoption or recency; the qualifier can.

- **GitHub Search API**: `GET /search/repositories?q=<freetext> stars:>20 pushed:>=2026-07-01 forks:>5 archived:false language:rust&sort=stars&order=desc`. Keep the qualifiers **fixed** (they encode the hard contract) and **vary the free-text** across rounds — each free-text mutation is one loop iteration against the same proven gate. `stars:`, `pushed:>=YYYY-MM-DD`, `created:`, `language:`, `license:`, `topic:`, `archived:false`, `sort:stars` are the decisive ones. This is the single fastest way to turn a fuzzy "recent, adopted, fit" request into a precise, ranked candidate list. Requires a `User-Agent` header. Shell form that avoids quote-encoding boilerplate: `curl -sG -H 'Accept: application/vnd.github+json' -H 'User-Agent: research' 'https://api.github.com/search/repositories' --data-urlencode 'q=<freetext> stars:>20 pushed:>=2026-07-01' --data-urlencode 'sort=stars'`.
- **PyPI/npm/crates JSON**: `pypi.org/pypi/<pkg>/json`, `api.npmjs.org/downloads/point/last-week/<pkg>`, `crates.io/api/v1/crates/<pkg>` (with `User-Agent`) confirm real download adoption that star counts hide — a 3★ repo can have thousands of weekly installs; a 30k★ repo can be abandoned. Use downloads as an independence check on stars, not a replacement.

Pattern: run the qualifier search with one free-text phrasing; if `total_count` is 0, the free-text was over-constrained (terms are ANDed) — relax the free-text, keep qualifiers. Name-collision pollution is common (e.g. "gno" → GNOME/Linux); resolve the candidate to its exact `org/repo` path and re-verify before any claim (Closure Gate G5).

### Timestamp-precise social search

`site:reddit.com` / `site:news.ycombinator.com` Google/Serper searches cannot filter by exact date and miss recent niche posts. Use the platforms' own timestamp APIs instead:

- **HN Algolia** (`bash` + `curl`): `hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i><unix-seconds>&query=<q>&hitsPerPage=N` — date-windowed story search with points/sort. Good for "what trended in the last 90 days."
- **X via the native lane** (`web_search_x`; legacy name `xsearch`): always pass exact date bounds; treat Grok's prose synthesis + `/i/status/` citations as **leads, not evidence** — fabricated tool names are common; resolve every named tool to a real repo before relaying (G5).
- **Reddit**: prefer `reddit.com/r/<sub>/search.json?q=&restrict_sr=1&t=month` (via `bash` + `curl`) for date-bounded results over Google site-search.

### Implementation-signature search (`gh search code` and the Code Search API)

Repo-description search finds tools by what they *claim*; code search finds them by what they *implement*. When the discriminator is a technique ("custom inverted index", "graph_rag", "reciprocal_rank_fusion", a specific reranker class), search the code itself — many tools whose README never names the technique will surface.

- **`gh search code "<term>" "<term2>" --language rust --limit N`** — the authenticated `gh` CLI carries the auth the REST Code Search API requires (`GET /search/code` returns *Requires authentication* anonymously). Combine 2–3 exact tokens (e.g. `"inverted index" bm25`, `graph_rag mcp`). Hits return `org/repo:path`, which hand off to a `repos/<full_name>` adoption lookup and a README fetch.
- **Limit**: code search finds *files*, so every hit needs the two-step adoption+README verification (most hits are course projects / 0★). Its value is **discovery of the mechanism cluster**, then filtering by the registry qualifier gate — not direct evidence.

### Competitor-authored comparison docs (the inverse-search trick)

A leading tool's own `COMPARABLE-TOOLS.md` / `ALTERNATIVES.md` / "vs …" docs are a curated, technically-rigorous map of its real competitors — vendors compare themselves precisely to win, and they name the semantic-capable ones that keyword search misses. Read the top candidate's repo for a comparison doc and harvest the names it names; then verify each (they are biased and may omit stronger rivals, so treat as a lead source, not a closed set).

### Cluster-then-gate with semantic search

Neural/hybrid `web_search_exa` can surface a **concept cluster** regardless of wording. Use neural for the broad neighborhood and hybrid when lexical anchors should tighten it; one task favored hybrid, but a non-overlapping task did not reproduce a general advantage. Immediately cross-check the *entire* cluster against the registry qualifier gate (`stars:>N pushed:>=DATE`) rather than promoting an attractive hit. A cluster of 0–3★ repos is strong evidence the niche is *real but unadopted*—a finding, not a winner.

### HN thread comment-mining for practitioner endorsements

Beyond story search, fetch a full discussion tree with `hn.algolia.com/api/v1/items/<id>` (via `bash` + `curl`) and walk the `children` for practitioner verdicts ("settled on X and Y", "X works well, Y was buggy"). An *Ask HN: what's the best X?* thread's comments resolve vague category questions into named, real, battle-tested tools independent of SEO/marketing. Endorsements still need registry + README verification (G5) — a name in a comment is a lead until it resolves to a repo with qualifying adoption.

### Registry-native package search (find what star-search misses)

GitHub repo-description search finds tools by their README pitch; **package-registry search finds them by their actual distribution.** High-download crates/npm packages can have modest GitHub stars (or live in a different org), and they are invisible to `stars:>N` qualifier search. When the target ships as an installable package (Rust CLI, npm tool, Python lib), search the registry natively via `bash` + `curl`, then resolve to the GitHub repo for the adoption+recency gate.

- **crates.io**: `crates.io/api/v1/crates?q=<terms>&sort=relevance` returns Rust crates with **download counts** (a real-usage signal stars hide); each crate's `repository` field resolves to GitHub. Sort by relevance or downloads.
- **npm registry**: `registry.npmjs.org/-/v1/search?text=keywords:mcp+keywords:semantic&size=N` returns JS packages scoped by keyword, with `repository` URLs.
- **PyPI**: `pypi.org/pypi/<pkg>/json` (and the legacy XML-RPC search) for Python packages.
- Resolve the top hits' `repository` URL → batch through the GitHub qualifier gate (`stars:>N pushed:>=DATE`). **This is the trick that surfaced high-adoption tools a pure GitHub-star search missed** — in one session it found two multi-thousand-download crates (7k+ and 3.6k+ downloads) sitting at high-star GitHub repos that repo-keyword search had never returned.

### URL similarity discovery — deprecated, do not use

Installed `exa-js@2.16.3` marks `findSimilar()` deprecated and scheduled for removal with no direct URL-based replacement. A focused qualified-seed call returned mostly catalogs/directories rather than first-party repositories. Use Exa neural/hybrid search on the seed's distinctive mechanism vocabulary, then follow the seed's references, forks, citations, and alternatives; treat that as a different discovery tactic, not an equivalent similarity API.

### HN comment-text search + Lobsters

Title search misses endorsements buried inside comment bodies. **`hn.algolia.com/api/v1/search?tags=comment&numericFilters=created_at_i><unix>&query=<q>`** (via `bash` + `curl`) searches the text of every comment (not just story titles) — this is how you catch an organic "or tools like X" mention with zero marketing. Pair it with:
- **Lobsters** `lobste.rs/search.json?q=<q>&what=stories&order=newest` — a smaller, lower-noise developer community than HN/Reddit; returns empty for many niche tools (an honest negative, not a gap).
- **MCP registries** (glama.ai, mcp.so, smithery): for the specific "tool exposes an MCP server" target, these curated registries are a faster discovery path than web search; check the candidate's README for a registry badge (e.g. `glama.ai/mcp/servers/<org>/<repo>`) as proof of real listing.

### Abstraction mutation

If the category name is wrong:

- generalize once to discover the field term;
- specialize immediately with the decisive constraint;
- search the failure rather than the solution label;
- search what would falsify the attractive candidate.

## 6. Escalation rules

- Same reject class twice: add an exclusion or stronger positive discriminator before another call.
- Same classes after two materially different queries: switch source type or search mode.
- One strong exact-fit lead: stop broad search and fetch its primary source.
- One exact-fit but weak-signal new artifact: verify mechanism, release date, maintainer history, issues/activity, and independent use; do not promote yet.
- Three non-overlapping lanes return only the same reject classes: stop the frontier, report no qualifying candidate in those lanes, or ask which hard constraint may relax.
- New source-of-source or vocabulary that changes the eligibility hypothesis: another round is justified.

Do not search again merely to collect more results or citations.

## 7. Worked examples

### A. Famous but off-target

Objective: a low-ceremony prompt-level verifier that cannot approve its own result.

Result: a popular multi-agent framework with 50k stars and reviewer agents.

Verdict: `reject / too-much-ceremony + wrong mechanism`. Stars do not matter because hard fit failed.

Next query:

```text
("separate verifier" OR "cannot self-approve" OR "independent check")
(prompt OR skill OR hook)
-"multi-agent framework" -CrewAI -LangGraph -AutoGen
```

### B. Recent exact fit with almost no adoption

Objective: a technique from the last month that records rejected search classes and mutates queries.

Result: a five-day-old repository with six stars, exact source code, and no independent use.

Verdict: `unverified-exact-fit`, not winner and not automatic reject.

Next actions:

1. Verify the code actually records rejection reasons and changes queries.
2. Inspect release/commit history and maintainer identity/activity.
3. Search exact repo/author/mechanism for independent discussion or use.
4. Look for criticism or a maintained predecessor.
5. If no corroboration appears, report only as an experimental frontier signal when the user requested frontier results.

### C. Social trend query returns launch-post repetition

Objective: techniques practitioners adopted in the last 60 days to reduce deep-research false positives.

Round 1 returns ten launch announcements for one product.

Classification: `hype-duplicate`; engagement proves attention, not independent adoption.

Mutation:

```text
("false positives" OR "off-target results" OR "search drift")
("we use" OR "production" OR "postmortem" OR "stopped using")
-"launch announcement" -"introducing" -"now available"
```

Then use handle exclusions, criticism terms, replies/quotes where supported, and fetch source-of-source repositories or reports.

### D. Paper search returns model-training methods

Objective: instruction guidance for a Pi skill.

Round 1 returns retriever RL and hard-negative training papers.

Classification: `training-only`. Retain vocabulary such as `hard negatives` if useful, but reject the implementations.

Mutation:

```text
("hard negatives" OR "requirement-aware")
("inference-time" OR checklist OR prompt OR workflow OR evaluation)
-"reinforcement learning" -training -fine-tuning
```

If no instruction-level implementation appears, use the paper only as evidence for the failure model, not as the proposed solution.

### E. Official documentation conflicts with local behavior

Official docs describe a current API, but the project pins an older release and a local smoke test differs.

Verdict: external docs prove the current upstream contract; local version/source/runtime proves project applicability. Do not average them. Fetch version-matched docs/changelog or report the mismatch.

## 8. Verification and final selection

For each survivor, preserve:

```text
candidate:
hard requirements: pass/fail with source
mechanism evidence:
version/date applicability:
maintenance/currentness:
adoption/engagement signal:
independent corroboration:
known failures/criticism:
baseline comparison:
complexity/cost:
remaining evidence debt:
```

A superiority conclusion requires:

```text
Compared with <baseline>, <candidate/mechanism> handles <named failure>
better because <verified difference>, under <cost/ceremony constraints>.
```

If that sentence cannot be completed honestly, the candidate is not proven superior.
