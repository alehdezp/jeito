---
name: research
description: "Use for serious W3/W4 source-dependent research: latest trends or techniques, social/frontier discovery, best/superior comparisons, conflicting evidence, consequential recommendations, or a large external-knowledge blockage after ordinary lookup fails. Do not invoke for a known URL, one authoritative fact, versioned library docs, or a contained project question unless the user explicitly requests skill/research."
disable-model-invocation: false
updated: "2026-09-23 12Z"
---

# Precision Research Operator — Exhaustive Edition

`skill/research` is the serious-research workflow, not the default web-search wrapper. Its job is to find the **exact requested thing or a demonstrably superior result**, reject attractive neighbors, and leave evidence strong enough for the final claim. **This edition is exhaustive: it never stops on near-misses, never accepts partial matches as results, and never closes until every lane and every closure gate is proven complete with primary-source evidence.**

## Activation boundary

Use ordinary source tools without this skill for a known URL, one current fact, versioned library documentation, or a small source check. Escalate to `skill/research` when any of these is true:

- the user explicitly invokes it;
- the task asks for latest, emerging, best, superior, comparative, social, or current practitioner evidence;
- several hard constraints must all hold;
- sources conflict, freshness is material, or source authority is unclear;
- repeated ordinary searches return adjacent results instead of the target;
- a consequential implementation/debugging decision depends on substantial external knowledge;
- a reusable skill/package/tool may avoid significant reinvention but fit and currentness require investigation.

Explicit invocation is launch approval when the objective and constraints are already clear. Ask only a question whose answer would materially change eligibility, source lanes, risk, or the decision. Do not stop for a ceremonial approval round.

## Non-negotiable research standard — Exhaustive

1. **Exact fit precedes quality.** A result that violates one hard requirement is rejected. Recency, popularity, authority, elegance, or general usefulness cannot rescue it.
2. **Near-miss is REJECT, never result.** A partial match, attractive neighbor, adjacent, inferior, baseline-equivalent, or merely similar result is logged in `ROUTES.md` as `reject` with failed requirement + false-positive class + next discriminator, and the loop MUST mutate and continue. Never promote a near-miss to "closest" or "best available."
3. **Search output is discovery.** Snippets, rankings, provider answers, social syntheses, and catalog rows are leads until the exact primary source is fetched/read.
4. **Every rejection teaches the next search.** Record the failed requirement, retrieval bait, false-positive class, and next query or lane mutation. No mutation = loop did not run.
5. **No-winner is valid only when proven exhaustive.** If no result clears the contract, report scoped no-winner ONLY after G0–G5 fully spent, G2 evidence-class budget exhausted across all lanes, and G3 mutation discipline honored. Budget-unspent no-winner is a hard error.
6. **External evidence does not override local truth.** Bind findings to version, date, platform, project constraints, and current local behavior before applying them.
7. **Read the caveats, not just the headline.** Before citing a study's result, check its sample size, statistical significance, and the authors' own threats to validity. A headline from a small or non-significant sample is a lead, not proof. Record the limit alongside the claim — a number without its caveat misleads the next reader.
8. **Vendor artifacts are comparison points, not evidence.** A company's production prompt, leaked system prompt, or product doc may confirm or contradict a finding — useful for triangulation — but it is never, by itself, evidence for a general principle. General principles need research methodology or convergence across independent experienced practitioners.
9. **Exhaustive persistence.** Continue intelligently, independently, and smarter every iteration until all three lanes and all closure gates are fully covered. Stopping after "trying a few tools then writing files" is a violation. The workflow is persistent and only closes when proven complete.

## Live public web surface — Intent-Driven Full Coverage

jeito websift registers nine tools. The startup-active tools are `web_search` (Serper Search), `web_fetch`, `web_answer`, and `web_lookup`. Five explicit one-provider specialists remain lazy until selected through `tool_search`: `web_search_exa`, `web_search_x`, constrained `web_search_tavily`, `web_answer_exa`, and `web_answer_linkup`.

**Exhaustive mandate: you MUST intent-drive use of almost all available web tools, not just 2-3.** The default "try some tools then write files" is forbidden. Required minimum per W3/W4 run (adjust up for complexity, never down):

- `web_search` lexical — at least 4-6 distinct queries with discriminators, not topic rephrases.
- `web_search_exa` — at least 2-3 hybrid/neural cluster queries for concept neighborhoods + qualifier gating.
- `web_search_x` — at least 1-2 native X lanes with exact date bounds when social/practitioner evidence is relevant; otherwise explicitly justify skip.
- `web_search_tavily` — at least 1 independent Tavily lane for regional/independent-guide gap.
- `web_fetch` — at least 8-10 primary-source fetches (repo README, release page, changelog, Play listing, official docs, paper, registry API) — every recommendation-driving claim needs one.
- `web_answer_exa` / `web_answer_linkup` — at least 1 structured answer lane when entity/relationship verification or date-bounded official evidence is needed.
- `web_lookup` — at least 1 context7 (version-pinned docs) when implementing against an API and at least 1 pi-packages/skillsmp catalog check when reinvention is possible.
- `bash+curl` registry/API lanes — mandatory when recency/adoption/size/language are hard requirements: GitHub Search API qualifiers (`stars:>N pushed:>=DATE`), `gh search code`, PyPI/npm/crates registry APIs, HN Algolia (`hn.algolia.com/api/v1/search?tags=story|comment&numericFilters=created_at_i><unix>`), Reddit `search.json`, Lobsters `search.json`.

Choose the evidence lane before loading a specialist. `web_search` is one Serper lexical attempt, never a provider router; `web_answer` is one provisional Exa orientation attempt, never verification or research. Use the other everyday tools for known-URL evidence and versioned lookup. Load exactly one specialist when its method has a named chance to expose a different evidence class — but over the whole run, you MUST have loaded almost all of them with purpose:

- `web_search_exa` — unfamiliar or narrow candidate discovery where Exa mode, category, date, domain, or text filters materially shape recall;
- `web_search_x` — first-hand X evidence requiring exact dates, handles, or explicit work/media bounds;
- `web_search_tavily` — constrained basic/general discovery for an independent-guide or country-shaped regional gap; its only public controls are `query` and optional full-name `country`;
- `web_answer_exa` — one structured Exa relationship or explicit-none question whose fields will be checked against primary citations;
- `web_answer_linkup` — one official-domain or date-bounded sourced orientation step whose cited page metadata will be fetched afterward.

Do not load every specialist in one turn to compare whatever happens to return. Provider diversity is deliberate: state which distinct error or source class another method could expose and how success, zero, or adjacency changes the next action. If exact-name `tool_search` does not return the selected specialist, record its live state; never silently substitute another provider.

Live tool schemas and tool-local guidelines own exact call construction. Search, ranking, provider-answer, social-synthesis, and catalog output remains `lead-only` until decisive primary passages are fetched/read with `web_fetch`. `query_terms` returns ranked matches and exact cache-file ranges. URL batches retrieve sources independently. `llm_answer` reuses an exact retained summary or starts one asynchronous generation bound to the page's exact retained content, `objective`, and `query_terms`; deterministic cache-file ranges remain locator authority, never generated prose. `objective` otherwise applies only to the separate single-page >5K no-quality-match rescue. Bare fetch is for full-page or structural reading.

Internal operations remain non-callable: Exa Contents/Similar/Research, Tavily full Crawl/Research/usage and query-guided Extract, Linkup searchResults/structured Search/Research/balance, and xAI model/video controls. Legacy `serper_search` maps to Serper-backed `web_search`; public `linkup_web_search` has no replacement because W12 rejected Linkup Search retention; `fetch_content`/`get_search_content` map to `web_fetch`; Context7 wrappers map to `web_lookup`. Do not invent an equivalent for an internal operation.

## Exhaustive Three-Lane Architecture — Mandatory

Every W3/W4 run MUST execute all three lanes. A lane is not "covered" by a single query — each lane requires at least 3-5 intelligently mutated rounds, rejection logging, and primary fetches. Skipping a lane because it "probably won't help" is forbidden and makes any no-winner invalid.

**Lane 1 — Repo / Source / Code-Signature / Registry API:**
- GitHub qualifier search via `bash+curl` (`pushed:>=DATE stars:>N language:…`), `gh search code` implementation-signature search, PyPI/npm/crates registry API, package-registry native search. Must verify pushed dates + stars/downloads via registry API, not keyword inference.

**Lane 2 — Lexical / Semantic Cluster / Awesome-List / Site-Map / Deep Research:**
- `web_search` lexical with discriminators, `web_search_exa` hybrid/neural cluster-then-gate, Tavily independent guide, awesome-list crawl, competitor `COMPARABLE-TOOLS.md` harvesting, `web_answer_exa/linkup` structured verification. Must harvest at least one awesome-list or site-map and gate its entire cluster.

**Lane 3 — Social / Community / Trend / Practitioner / Criticism:**
- `web_search_x` with exact date bounds, HN Algolia story + comment mining (`api/v1/search?tags=story|comment`), Reddit `search.json`, Lobsters, plus mandatory **criticism/failure lane** (search `"<candidate> criticism" "<mechanism> fails"` and verify). Social is not optional for latest/trend/best work — high engagement is signal, not proof, and must be corroborated.

Each lane must log every rejection with `candidate/result, verdict, failed requirement, false-positive class, retrieval bait, useful vocabulary/source-of-source, next positive discriminator, next exclusion or lane change` in `ROUTES.md`.

## Mandatory reference receipt

Critical behavior is defined in this file so reference skipping cannot remove the operator. References supply the worked mechanics for the active mode.

Before the first external search in every W3/W4 run:

1. Read [`references/search-steering.md`](./references/search-steering.md) completely.
2. For latest/new/best/superior/trend/social work, also read [`references/novelty-and-superiority.md`](./references/novelty-and-superiority.md).
3. For X, Reddit, LinkedIn, HN, YouTube, or gated/app-shell evidence, also read [`references/social-and-gated-sites.md`](./references/social-and-gated-sites.md).
4. When a provider/lane is named, unavailable, or non-default, read [`references/tool-lane-preflight.md`](./references/tool-lane-preflight.md) and only the relevant section of [`references/web-tools-playbook.md`](./references/web-tools-playbook.md).
5. Record `Loaded references: <paths>` in `ACTIVE.md`, or state it in chat when no file-backed state exists. If a required reference is missing or unreadable, report that diagnostic before searching; do not silently skip it.

For continuation, read `ACTIVE.md` and the currently relevant rejected/active routes before searching. Do not reread raw archives by default.

## Canonical W3/W4 state

Resolve the research root using [`references/folder-system.md`](./references/folder-system.md#canonical-location-and-identity). By default it is `.research/` at the current Git project root; an explicitly set absolute `JEITO_RESEARCH_ROOT` may select an existing independent library. Do not assume the maintainer's Atlas path exists or create state outside the selected root. Before creating an objective, search that root by the actual decision and constraints. Resume when decision and success criteria match; add a pass only for a distinct auditable round, not a new date or source lane alone.

Keep the active state small:

- `OBJECTIVE.md`: decision, hard constraints, success/no-winner conditions, drift warnings.
- `ACTIVE.md`: current answer/state, loaded-reference receipt, next best action, active routes, blockers.
- `ROUTES.md`: accepted and rejected routes, false-positive classes, query mutations, revisit conditions.
- `FINDINGS.md`: condensed synthesis, not a search log.
- `EVIDENCE.md`: recommendation-driving claims, URLs/locators, warrants, freshness, conflicts, limits.

Use stable descriptive headings as conclusion identity: `path/to/file.md#heading`, never volatile line numbers. Link a conclusion forward to any affected instruction, skill, or policy owner; that owner links back only when the conclusion changes its current decision.

Update only files whose truth changed. New supporting evidence does not require a new finding, `ACTIVE.md` update, or instruction change. Update `ACTIVE.md` only when current state or next action changes, and `OBJECTIVE.md` only when the north star or boundary changes.

Create optional raw/experiment/agent artifacts only when they improve auditability or continuation.

## Eligibility contract — write before searching

Do not begin with keywords. First write this compact contract in `OBJECTIVE.md` or `ACTIVE.md`:

```text
Decision supported:
Exact target:
Why it is needed:
Must-have requirements:
Disqualifiers:
Named baseline(s):
What “superior” must improve:
Freshness/version/date window:
Acceptable evidence:
Quality/adoption signals:
No-winner / stop condition:
```

Requirements are pass/fail unless the user explicitly labels them preferences. If a request is underspecified and different answers would change eligibility, ask; otherwise launch.

## Candidate admission gate

Classify every serious result before spending deep-reading time:

- `qualifies`: every must-have is evidenced; no disqualifier applies.
- `unverified-exact-fit`: appears to satisfy all must-haves, but one or more require primary-source verification.
- `discovery-only`: useful vocabulary, source-of-source, category, or failure language; never a final recommendation.
- `reject`: fails a hard requirement, is inferior/baseline-equivalent, stale for the requested window, source-thin, unsupported, or too costly/complex for the constraint.
- `duplicate`: same candidate or already-exhausted false-positive class.

Do not use a weighted total for admission. A high score elsewhere cannot compensate for a failed must-have.

After eligibility, compare survivors on a vector rather than one vague quality score:

```text
exact mechanism fit | evidence authority | freshness/applicability |
maintenance/stewardship | adoption/engagement relative to age and field |
independent use/corroboration | complexity/ceremony/cost | known failures
```

A famous off-target result is a reject. A new low-adoption exact fit is `unverified-exact-fit`: investigate it, but do not promote it as best/superior without mechanism proof and stronger current-quality evidence. Do not infer quality from nationality, geography, follower count, or prestige alone.

## Rejection-driven search loop — Persistent Until Proven Complete

For each search round:

1. **Question:** Which eligibility requirement or uncertainty does this round test?
2. **Lane:** Where would qualifying evidence live—official docs, implementation/source, registry, paper, social, criticism, provenance, or media?
3. **Query:** Include the decisive mechanism, date/version, source type, and already-known exclusions.
4. **Triage:** Apply the admission gate before deep reading.
5. **Reject:** For every failure worth remembering, record:

```text
candidate/result:
verdict:
failed requirement:
false-positive class:
retrieval bait (term/domain/result pattern):
useful vocabulary/source-of-source:
next positive discriminator:
next exclusion or lane change:
```

6. **Mutate:** The next search must change a decision-relevant dimension learned from the result—not merely rephrase adjectives.
7. **Verify:** Fetch/read primary sources only for survivors or source-of-source leads that could change the decision.
8. **Decide:** Promote, reject, switch lane, clarify, abstain, or stop.

**Exhaustive persistence rules (10x rigor):**

- If the same false-positive class appears twice, stop reading more of it and add an exclusion or stronger positive discriminator. If two materially changed queries return the same classes, change source type or search mode. If three non-overlapping lanes converge on the same rejects, that is evidence for no-winner ONLY after G2–G5 proven spent.
- Never stop after 2-3 queries. Minimum per run: at least 12-15 distinct mutated queries across all lanes, at least 8-10 primary fetches, every rejection logged. "Tried a few tools then wrote files" is a hard error.
- Near-miss is not progress. Logging it and stopping is not exhaustive. You must continue with a smarter mutation until the lane's exhaustion is proven or a qualifies is verified.
- Each lane must run at least 3-5 rounds before any closure claim. A lane with 0-1 rounds is budget-unspent.
- Cross-lane corroboration is mandatory before any stop: a survivor must be corroborated by at least 2 distinct primary sources from different lanes, or the no-winner must be corroborated by convergence across at least 2 lanes with distinct source types.

If three non-overlapping lanes converge on the same rejects and no survivor clears the gate, stop with a scoped no-winner or ask what constraint may be relaxed — but only after the Closure Gate (below) confirms the evidence-class budget and mutation discipline were actually spent; apparent convergence with an unspent budget is not a stop.

## Evidence rights and source use

Default rights:

- search result, ranking, snippet, provider answer, catalog row: `lead-only`;
- fetched/read primary target content with locator: `evidence-eligible`;
- exact evidence plus warrant, currentness/applicability, and conflict check: `verified` for the scoped claim;
- social post: signal or evidence about that post/author claim, not general truth unless source-of-source or mechanical proof supports it.

Prefer official docs/specs/changelogs, upstream repositories/source/issues/releases, registries, papers and artifacts, maintainer statements, and reproducible examples. “Official” is not timeless: check version, date, deprecation/supersession, and whether the project actually uses that contract.

For recommendation-driving W3 claims, run at least: primary-source verification, staleness/applicability check, failure/criticism check, and alternative/baseline check. Keep facts, source-reported claims, inference, recommendation, and uncertainty separate.

## Frontier, social, and trend research

For “latest,” trends, techniques, hype, or practitioner sentiment, recency is necessary but not sufficient. Evaluate separately:

- exact target/mechanism fit;
- publication/release/post date and whether recent work touches the mechanism;
- maintenance and stewardship;
- adoption or engagement relative to age, field size, and source type;
- independent mentions/use versus coordinated launch repetition;
- primary artifact/source-of-source;
- criticism, failures, and contrary evidence.
- temporal validity: for capability claims ("agents can/can't do X"), prefer current-year sources — model generations move fast and capability findings from 2+ years back may be obsolete. STRUCTURAL findings (attention mechanics, instruction-decay asymmetries, horizon-dependent degradation) endure across model generations and are worth chasing even from older work; capability pessimism does not endure and should not be relayed from stale studies.

High engagement prioritizes inspection; it does not prove quality. Low engagement does not disprove quality, but an obscure recent result remains experimental until its mechanism and evidence survive verification. Search social lanes for practitioner vocabulary, first-hand failures, independent use, and source-of-source—not as a substitute for implementation evidence.

## Skills, packages, and existing solutions

When a substantial recurring workflow or ecosystem integration may already exist, check the relevant skill/package catalog (`web_lookup` `skillsmp` or `pi-packages` branch) before designing a new framework. Treat catalog results as leads. Fetch package/repository docs and source; check current releases, maintenance, adoption, permissions, dependencies, and fit with the local project. Do not run package discovery for ordinary contained work, and never install without explicit user authorization.

## Closure Gate — when a run may actually stop — Proven Complete

The "No-winner is valid" rule (standard 5) and the loop's convergence stop above are valid only once this gate is cleared. They are not exit ramps for fatigue or repetition. A premature closure — promoting a weak-evidence result, inheriting an aggregator claim, or stopping before the requested delivery count with the budget unspent — is a hard error regardless of how many lanes appeared to converge. Check every clause before answering; the first failure means continue. **Exhaustive edition: this gate is 10x stricter — you must prove persistence, not just coverage.**

### G0 — Scope fidelity

The answer addresses the actual decision and exact target named in the eligibility contract — not a substitute question ("does one exist?" when asked for N superior items; "is it relevant?" when asked "is it best?"; "is it maintained?" when asked "is it superior?"). If the answered question differs from the asked one, the run is not done.

### G1 — Delivery contract

If the user requested N items or answers, deliver N. Each *missing* slot requires a per-slot exhaustion proof (G2–G5 run for that slot's target), not a global "nothing found." A no-winner that does not account for the requested N is premature.

### G2 — Evidence-class budget (per question type) — Exhaustive Minimums

Keyword search alone never closes a run. Spend ≥1 real round on each modality the question type requires, and in exhaustive mode, meet these minima or prove why a lane is impossible. A modality is "spent" only after a query actually ran on it — not skipped because it "probably won't help," and not satisfied by a different modality's results.

| Question type | Required modalities (≥1 round each; exhaustive minima) |
|---|---|
| tool / package / library | primary repo/source (≥3 fetches) + registry API (GitHub/PyPI/npm/crates) (≥2 qualifier queries) + awesome-list or bounded site map (≥1 harvest) + deep multi-step research (≥2) + social (≥1) |
| technique / method / paper | paper index (arXiv/Scholar/SemanticScholar) + runnable implementation + benchmark/eval + criticism/retraction lane |
| best / superior / comparative | primary source per candidate + baseline-attack (what would falsify the leader) + independent corroboration (≥2 distinct primary sources) |
| social / trend / practitioner | native social lane (X/Reddit/HN/forums) with explicit dates (≥2 platforms) + primary artifact / source-of-source |
| current fact / release / status | official/changelog/registry + dated news + version/date match (all three) |
| product / market / landscape | official sources + independent reviews/criticism + competitive alternatives (all three) |

**Exhaustive cross-lane minima (applied to every W3/W4):** at least 12-15 distinct mutated queries total, at least 8-10 primary fetches, at least 3-5 rounds per lane, all three lanes executed. Fewer is budget-unspent.

### Source provenance for corroboration

Provider diversity is not source independence: two lanes can index the same canonical page, or mirrors and derivatives of it. Corroboration requires distinct primary sources, not distinct providers.

- Deduplicate by canonical source: the same URL, domain, or derivative copy counts as one source. Fail closed — same-domain evidence across lanes is still single-source.
- Record source lineage: which lane surfaced which source, and which source corroborates which claim element.
- A claim backed by one source is lead-only; absence is recorded as absence — never filled from model memory. Model memory is not a corroboration lane: it is the thing being checked.
- Conflicting sources: fetch both primaries with `web_fetch`, quote the exact passages, and report the conflict. Never average; never pick silently.
- **Exhaustive:** every survivor or no-winner claim needs at least 2 distinct primary corroborations from different lanes OR explicit documentation of failed corroboration attempts.

### Source skepticism while reading

- Gell-Mann amnesia — you noticed the source was wrong about something you know well; do not let that same source speak with authority about what you don't know.
- Lateral reading (SIFT): leave the page before trusting it — check the publisher, find independent coverage, trace the claim to its origin.
- Brandolini's law — refuting nonsense costs an order of magnitude more effort than producing it: filter weak sources at the door, and prefer one authoritative source over ten weak ones.
- Hitchens's razor applies to sources, never to the user: what a source asserts without evidence can be dismissed without evidence — but a user's report is evidence, not an assertion to dismiss.
- Study-shaped claims: check sample, baseline, and what was actually measured. One study is a lead, not a conclusion — replication crisis, p-hacking, and publication bias are the default context.
### G3 — Mutation discipline — Exhaustive

Every rejection spawned a mutated query — a positive discriminator added, a source-shape change, or an abstraction shift (generalize once to find the field term, then specialize on the decisive constraint). **Zero mutations ⇒ the loop did not run**, regardless of how many lanes "converged." The loop rule already demands an exclusion or lane change when a reject class repeats twice; a stop reached without honoring that is invalid. **Exhaustive:** at least 8-10 distinct mutations logged in `ROUTES.md` before any closure claim. A run with 0-2 mutations is not exhaustive.

### G4 — Evidence-grade gate (lead ≠ answer)

The admission grades bind the final answer: `lead-only`, `discovery-only`, and `unverified-exact-fit` cannot occupy an answer or "verified/superior" slot. A sub-grade result promoted to survivor/verified is a hard error. Deliver such a result only with its grade labeled, or keep searching. **Exhaustive:** any promotion requires 2 distinct primary sources corroborating the same claim element.

### G5 — Primary-source verification (no inherited aggregator claims)

Never relay a factual, adoption, recency, or quality claim from an aggregator — deep-research synthesis, AI answer engine, social summary, catalog row, or README tagline — as verified. Pull the primary number/source before any existence, superiority, or no-winner claim. A moved/renamed source that 404s is a signal to resolve the canonical path (search the org, check registry mirrors, follow redirects), not to drop the candidate. **Exhaustive:** every factual element in the final answer must have a primary-source URL + cache locator + freshness stamp in `EVIDENCE.md`.

### Closure label (state which)

- **answered** — requested N delivered, each at `qualifies`/`verified` with primary-source proof + cross-lane corroboration (≥2 distinct primaries).
- **scoped no-winner (proven)** — G0–G5 fully spent at exhaustive minima, three lanes proven with distinct source types, dominant reject classes documented with ≥8 mutations, and what evidence or relaxed constraint could change it.
- **scoped no-winner (budget-unspent)** — G2 or G3 not yet met at exhaustive minima. This is **not** a valid stop; continue. In exhaustive mode, single-lane or 3-query no-winner is automatically budget-unspent.

Only after G2 and G3 are genuinely spent at exhaustive minima and no productive mutation remains may you ask the user which constraint may relax.

## Final answer gate

Before answering:

- The [Closure Gate](#closure-gate--when-a-run-may-actually-stop--proven-complete) is cleared at exhaustive minima: requested delivery count met, evidence-class budget spent across all three lanes, mutations ran (≥8), and no answer-slot result is below `qualifies`/`verified` grade with ≥2 distinct primary corroborations.
- Every recommendation satisfies all hard requirements with primary-source proof.
- Every external claim used has a direct URL + cache locator + freshness; every recommendation-driving source was fetched/read.
- Rejected/adjacent results are omitted unless explicitly useful to explain no-winner or the user requested near misses — but all rejects are logged in `ROUTES.md`.
- Popularity and recency are described as signals, not quality proof.
- Contradictions, staleness, failures, and evidence debt are visible.
- The answer separates evidence-backed fact, interpretation, recommendation, and unresolved uncertainty.
- If nothing qualifies, say exactly that, name the searched lanes and dominant reject classes, and state what evidence or relaxed constraint could change the outcome — with exhaustive minima proven.

## Optional references

- [`references/evidence-and-warrants.md`](./references/evidence-and-warrants.md): detailed source classes, warrants, and adversarial checks.
- [`references/folder-system.md`](./references/folder-system.md): canonical state and file ownership.
- [`references/resume-and-condense.md`](./references/resume-and-condense.md): continuation and archive discipline.
- [`references/multi-agent-research.md`](./references/multi-agent-research.md): only when role-separated W4/W3 research materially helps.
