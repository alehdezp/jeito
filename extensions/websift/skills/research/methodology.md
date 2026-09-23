---
title: "Pi source harness methodology"
description: "Progressive W3/W4 research method, live jeito websift capability lanes, evidence promotion, and closure gates."
tags: [jeito-websift, research, methodology, evidence, closure]
created: 2026-07-31
updated: 2026-08-12
status: active
---

# Pi Source Harness Methodology

This file is progressive disclosure for `/skill:research`. Load it for W3 structured decisions, W4 deep investigations, tool-stack choices, package/install decisions, or when the short skill body is not enough.

## Live public web surface (read first)

jeito websift registers nine tools. Four everyday tools are startup-active; five explicit provider/method specialists are installed lazily. `web_search` is the named exception: its preserved public name means Serper Search only, never automatic routing.

- `web_search` — Serper/Google lexical discovery with query and optional country; up to 10 lead-only rows, one provider attempt, no fallback. Begin with 2–6 terms and at most one constraint; zero rows are a successful scoped outcome whose receipt suggests one mutation.
- `web_fetch` — known-URL extraction and targeted retrieval. Content always shows (full up to 5K tokens, smart view beyond with the cache path). One-page `query_terms` overlays ranked matches with exact line ranges; URL batches preserve every source independently. `mode:"llm_answer"` (or the hard single-URL rescue) starts a source-grounded LLM read; crawl jobs are polled via `urls:"crawl:N"`.
- `web_answer` — one quick provisional Exa answer, one attempt, no fallback; fetch decisive citations before relying on it.
- `web_lookup` — Context7 versioned docs plus SkillsMP and Pi-package catalog leads.
- `web_search_exa` — focused unfamiliar/narrow candidate discovery with Exa-native modes and filters.
- `web_search_x` — first-hand X evidence with exact date/handle and optional work/image bounds.
- `web_search_tavily` — constrained basic/general discovery for independent technical guides or country-shaped regional sources.
- `web_answer_exa` — one structured relationship or explicit-none Exa answer followed by field-level primary verification.
- `web_answer_linkup` — one official-domain/date-bounded sourced orientation step followed by fetched metadata verification.
- `bash` + `curl` — raw HTTP/registry diagnosis when transport or registry truth is the claim.

Use `tool_search` with one exact specialist name after its distinct evidence hypothesis is selected. Do not activate all five for provider roulette. A deliberate second method is justified only by a named source class or provider-error hypothesis. Internal/non-callable operations remain Exa Contents/Similar/Research, Tavily full Crawl/Research/usage and query-guided Extract, Linkup searchResults/structured Search/Research/balance, and xAI model/video controls.

## Core Principle: Evidence Weight > Source Age > Source Authority

A newer source with mechanical verification beats an older consensus source without evidence. A Tier 3 blog from 2026 with a passage-verified API behavior beats a Tier 1 official doc from 2023 that never confirmed the claim.

Three rules override the old "trust old authority" bias:

1. **Falsifiable claims from any tier get promoted when mechanically verified** — URL resolves, quoted passage exists in the fetched page.
2. **Staleness attacks apply to ALL sources, not only new ones** — an old trusted source is just as likely to be stale as a new weak source is to be unverified.
3. **Evidence weight > vote count** — one source with primary-source verification beats three sources repeating the same unverified claim (consensus hallucination, arXiv:2407.16604; Till et al. 2025).

## Source Quality Tiers

Classify every source, even if briefly. Tiers help decide which sources need more verification, not which to trust blindly.

| Tier | Label | Examples | Default verification need |
|---|---|---|---|
| **Tier 1** | Primary | Official docs, specs, changelogs, RFCs, peer-reviewed papers, author's own repo, registry metadata | Low — fetch and confirm the exact passage. |
| **Tier 2** | Curated secondary | Major publications, MDN, Wikipedia (w/ citations), analyst reports, official engineering blogs, developer portals | Medium — confirm the source hasn't been superseded. |
| **Tier 3** | Community | Blog posts, Stack Overflow, forums, tutorials, newsletters, personal GitHub repos | High — mechanical passage verification required for any factual claim. |
| **Tier 4** | Unverifiable | Social media, AI-generated content, SEO listicles, content farms, anonymous posts | Signal-only. Do not use as sole evidence for factual claims. |

**Freshness overrides tier when mechanical verification succeeds.** A Tier 3 source from this month with passage-verified evidence beats a Tier 1 source from 2023 that never confirmed the claim. The tier tells you how much verification to apply, not how much to trust.

## "I Don't Know" Rule

When no source supports a claim at Evidence-eligible or higher:

- Say "I don't know" or "Not verified."
- Do not infer, guess, or paraphrase from memory.
- Do not soften unsupported claims with "likely" or "appears to."
- If the question matters, escalate depth and search.

## W0-W4 Quick Router

Default to **light/normal** research (W1-W2) unless the user clearly asks for more or the stakes require it. Depth should change the work performed, not just the label used. W1/W2 are owned by the companion `mini-research` skill; this file governs W3/W4 and the escalation boundary.

| Depth | Default action | Escalate when |
|---|---|---|
| W0 known-source | Fetch/read known source. | Source missing, stale, ambiguous, or consequential. |
| W1 fact-check | One authoritative source. | Fact drives recommendation or source is not authoritative. |
| W2 mini-research | 2-3 source checks; normal/default source work. | Comparison, conflict, or decision appears. |
| W3 structured decision | Mini-ledger + scoped warrants + adversarial checks. | User says “hard,” “serious,” “thorough,” “compare deeply,” or asks for a consequential tool/architecture recommendation. |
| W4 deep investigation | Compact artifacts + multi-lane research + primary sources + criticism/provenance + verifier/judge when useful. | User explicitly says “deep research,” “W4,” “deep investigation,” or strongly implies a broad/high-stakes investigation. |

Escalation triggers:

- user asks best/compare/should I/production-ready/recent;
- user says hard/serious/thorough/compare deeply;
- user explicitly says **deep research**, **W4**, or deep investigation;
- sources conflict;
- search/provider summary is the only support;
- topic is fast-moving;
- claim affects install, architecture, money, security, law, health, or strategy;
- evidence supports a narrower claim than the planned answer;
- result looks like SEO/AI slop;
- current answer depends on an untested assumption.

De-escalation triggers:

- one authoritative source directly answers a low-stakes question;
- source is known before searching;
- no recommendation/synthesis is needed;
- user asks for speed.

W4 minimum bar:

- frame lanes before searching;
- use multiple lanes, not one broad query;
- fetch/read primary sources for central claims;
- trace source-of-source for recommendation-driving claims;
- include criticism/contradiction/failure checks;
- maintain compact research-folder state (`ACTIVE.md`, `OBJECTIVE.md`, `ROUTES.md`, `FINDINGS.md`, `EVIDENCE.md`; optional `raw/`, `experiments/`, `investigations/`, `archive/`, `agents/`);
- write scoped warrants and evidence debt;
- do not declare a winner until the promoted mechanism beats the baseline on a named failure mode.

If those steps are not performed, call the work W2/W3, not W4.

## Current-project judgment research scope

When the research question is about improving agent judgment over the current repo/folder, the corpus is the **current project and its infrastructure documents**: source graph, docs, architecture notes, plans, runbooks, tests, config, evidence ledgers, status files, decisions, and recent repo state.

Do not drift into generic agent memory, personal long-term memory, compiled external knowledge bases, or broad GraphRAG unless the user explicitly asks or the mechanism directly improves current-project judgment. For this scope, rank mechanisms by whether they help answer:

- what matters for this task;
- what is current, canonical, stale, or superseded;
- which docs/files/code paths/tests/config are relevant;
- what source/provenance supports that judgment;
- what should be inspected next before acting.

BM25, embeddings, summaries, smart search, RAG, and generic knowledge graphs are not sufficient signals of superiority. Prefer code/documentation graph systems, source-relation models, status/evidence-ledger integration, and target-corpus trials that combine code structure, docs, repo state, and provenance.

## Tool Result Rights

| Tool/result type | Right | Allowed use |
|---|---|---|
| Explicit search-method snippets/rankings | Lead-only | Find sources and terms; retain provider identity. |
| `web_answer` / provider summaries | Lead-only/Candidate | Orient; fetch underlying sources before final claims. |
| `web_fetch` known URL with target-content present | Evidence-eligible | Can support scoped claim after warrant. |
| Official docs/registries (via `web_fetch`/`web_lookup`) | Evidence-eligible | Exact claims about documented behavior/version/status. |
| GitHub source/issues (via `web_fetch`/`bash curl`) | Evidence-eligible | Code behavior, maintenance, issue signals with limits. |
| Social/X/forum posts (`web_search_x`) | Signal-only/Candidate | Sentiment, reports, author statements; weak for factual proof. |
| Bounded site extracts (`web_fetch` site/map) | Candidate/Evidence-eligible per page | Use page-level extracts for evidence. |

Promotion path:

```text
Lead-only → Candidate → Evidence-eligible → Verified
```

A claim becomes Verified only when evidence supports the exact wording, the warrant names scope/limits, and freshness/conflict status is acceptable.

## Mechanical Source Verification

For W2+ claims where the source tier is 3 or the topic is fast-moving, apply one or both mechanical checks before promoting a source:

1. **URL resolution check**: `web_fetch` (or `bash` + `curl -sIL`) on the cited URL. Must return 2xx or a readable fetched result containing target-content. A 404, redirect-to-homepage, login shell, or block page kills the source for the intended claim.
2. **Passage existence check**: re-fetch the URL and confirm the quoted claim or a close paraphrase appears verbatim in the page. Search snippets are NOT sufficient — they can hallucinate too.

A source that passes both checks is Evidence-eligible regardless of tier. A Tier 4 source that passes both is still Signal-only unless it's the primary source of the claim (e.g., a tweet by the author announcing a release).

**Budget**: W2 apply URL check on the main claim source. W3 apply both checks to recommendation-driving claims. W4 apply both checks to all central claims.

## Capability Lane Playbook

### novelty-sources (NEW)

Use for fast-moving topics where the best answer may come from a week-old blog, repo issue, author post, preprint, demo, or package release rather than an old official doc.

Use the explicit method whose chronology contract fits: Serper-backed `web_search` and constrained `web_search_tavily` express dates lexically in the query; `web_search_exa` exposes exact recency or `publishedWithinDays`; `web_search_x` exposes exact social dates. `web_answer_linkup` accepts dates/domains for sourced orientation, not Search retrieval. Add source-type queries, social/community leads, implementation artifacts, and source-of-source tracing, then mechanically verify survivors with `web_fetch`. No method has universal freshness priority; preserve no-winner outcomes.

Right: Lead-only from search. Promote to Evidence-eligible only after mechanical verification (URL + passage check) and content classification.

Key rule: **do not downgrade a new source just because it is new, and do not accept it because it is exciting.** Verify it first. If it passes, it can beat old sources that never confirmed the same claim.

Novelty playbook:

1. Learn vocabulary quickly from broad search and social/community leads.
2. Pivot to the artifact class that would prove the claim: changelog, repo, package, paper, model card, commit, issue, demo, or author statement.
3. Search with old names, aliases, acronyms, errors, release identifiers, and maintainer names.
4. Look for negative evidence: closed issues, deprecations, migration guides, outages, pricing limits, and failed reproductions.
5. Promote only claims that survive source-of-source tracing or mechanical verification.
6. If proof remains missing, preserve the gap instead of smoothing it into a confident answer.

### official

Use for docs, specs, changelogs, registries, standards.

Prefer: `web_lookup` context7 when a versioned library doc fits, official URL via `web_fetch`, package registry fetch (`bash curl`), GitHub releases.

Do not use random blogs when official docs exist, unless checking stale-docs or criticism.

### semantic

Use for discovery when vocabulary is weak or adjacent sources matter.

Use `web_search_exa` neural for broad unfamiliar-vocabulary neighborhoods and hybrid when exact anchors should tighten that neighborhood; controlled tasks did not establish universal hybrid superiority. Use category/date controls when source shape matters. When Exa is unavailable, change vocabulary or use Serper-backed `web_search` with quoted/`site:` anchors; never silently substitute another provider while claiming Exa ran.

Right: Lead-only or Candidate until fetched.

### freshness

Use for recent changes, announcements, model/tool releases.

Current method facts: Serper-backed `web_search` and constrained `web_search_tavily` use lexical date terms; `web_search_x` maps exact social bounds; `web_search_exa` accepts exact recency and `publishedWithinDays`; `web_answer_linkup` accepts exact dates for sourced orientation. Also inspect official changelogs, author posts, release notes, and dated docs.

Right: Lead-only until fetched/read.

### implementation

Use for code examples, package reality, API usage, repo health.

Prefer: GitHub, npm/PyPI (`bash curl` registry APIs), source fetch via `web_fetch`, code search where available.

Right: Evidence-eligible for code/package claims, but not broad quality claims without warrant.

### criticism

Use for bugs, deprecations, issues, limitations, negative reports.

Prefer: GitHub issues, changelogs, HN/Reddit/X as leads, failure posts.

Right: Candidate or weak signal unless primary issue/changelog/source is fetched.

### structured

Use for comparison extraction and sourced answers.

Use `web_answer_linkup` for official-domain or date-bounded sourced orientation and fetch every decisive citation. Use `$mini-research`/`$research` when synthesis must become a verified claim or comparison. Every provider-synthesized claim remains Candidate until its underlying source is fetched.


### verification

Use for exact source support.

Prefer: `web_fetch` static extraction first (webclaw, keyless; JS/login shells escalate to the tavily lane automatically via js-needs detection), exact source reads, and `bash` + `curl` for raw HTTP diagnosis.

Right: Evidence-eligible when exact locator/excerpt is retained.

### provenance

Use to trace claims to original sources.

Prefer: source-of-source search, official reports, DOI/paper/original filing.

### social

Use for early signals, author announcements, and community reports. Prefer `web_search_x` for native X signal.

Right: signal-only unless the claim is about the social source itself.

### media

Use for talks, demos, interviews, tutorials.

Prefer: `web_fetch` with a focused extract; transcript/timestamp first, frames only for visual claims.

Right: Evidence-eligible for what the speaker says; not for independent truth unless corroborated.

### crawl

Use for multi-page official docs/site traversal.

Use `web_fetch` `mode: map` to discover bounded site URLs, then fetch selected pages (`mode: page`) that can prove the claim. `mode: map` discovers and bounds URLs only; it is not a crawl and does not replicate Crawl4AI's BM25/structural filtering or multi-page crawl/extraction. A dedicated crawl tool (Tavily Crawl, local Crawl4AI) is an internal/apprenticeship hypothesis with no public call and no public equivalent — do not request it.

Right: page-level evidence only.

## Warrant Templates

### One-line W2/W3 warrant

```text
Claim:
Evidence:
Warrant:
Limit:
Allowed final wording:
```

### Full W4 warrant record

```json
{
  "warrant_id": "W001",
  "claim_id": "C001",
  "evidence_ids": ["E001"],
  "why_supports": "Why the evidence supports the claim",
  "scope": "What claim scope is allowed",
  "limits": ["What this evidence does not prove"],
  "overclaim_risk": "low | medium | high",
  "allowed_final_claim": "The narrowest accurate wording",
  "not_licensed": ["Broader claims this evidence cannot support"]
}
```

## Evidence Records

```json
{
  "evidence_id": "E001",
  "source_id": "S001",
  "claim_id": "C001",
  "quote_or_locator": "Exact excerpt, heading, paragraph, line, timestamp, URL fragment, or machine-verifiable metadata path",
  "evidence_type": "direct_quote | docs_section | changelog | source_code | issue | registry_metadata | transcript | benchmark",
  "right": "evidence-eligible",
  "strength": "strong | medium | weak",
  "notes": "What this evidence directly says"
}
```

## Claim Records

```json
{
  "claim_id": "C001",
  "claim": "Atomic claim text",
  "status": "lead | candidate | evidence-eligible | verified | weak | contradicted | unknown | stale-risk",
  "evidence_ids": ["E001"],
  "warrant_ids": ["W001"],
  "freshness_status": "ok | stale-risk | unknown",
  "contradiction_status": "none-found | unresolved | contradicted",
  "final_action": "use | narrow | mark_uncertain | remove | needs_inspection"
}
```

## Evidence Debt

Use evidence debt when a recommendation-driving claim is tempting but unsupported.

```json
{
  "debt_id": "D001",
  "draft_claim": "Package A is more reliable than Package B",
  "needed_evidence": ["maintenance history", "issue patterns", "source inspection", "independent user reports"],
  "status": "unpaid",
  "final_answer_action": "do not say this; downgrade to test-in-sandbox"
}
```

W3: include this in `Risk/Debt` column.
W4: write `evidence_debt.jsonl` only if needed.

## W3 Mini-Ledger

```markdown
Decision:
Freshness need:
Source lanes used:
Tool rights used:

Evidence-backed facts:

| Claim | Status | Evidence | Warrant | Risk/Debt |
|---|---|---|---|---|
|  | Lead / Candidate / Evidence-eligible / Verified / Weak / Contradicted |  |  |  |

Adversarial checks:
- Staleness:
- Failure:
- Alternative:

Recommendation:
Uncertainty:
What would change the conclusion:
```

## W4 Ledger Set

Use the user-named folder. If no folder is named and durable artifacts are needed, ask or use a clearly named local folder.

Recommended files:

```text
brief.md
source_map.jsonl
sources.jsonl
evidence.jsonl
warrants.jsonl
claims.jsonl
evidence_debt.jsonl       # only if needed
contradictions.jsonl
citation_audit.jsonl
judge-score.md
final.md
learning.jsonl            # only if useful and non-sensitive
```

## Citation Audit

```json
{
  "claim_id": "C001",
  "citation_url": "https://...",
  "source_was_read": true,
  "exact_support": "yes | partial | no",
  "claim_too_broad": false,
  "freshness_ok": true,
  "contradiction_checked": true,
  "verdict": "pass | rewrite | remove | mark_uncertain"
}
```

Downgrade rules:

- Search result only → Lead-only.
- Provider answer with unfetched citations → Candidate at most.
- Fetched source mentions topic but not exact claim → Weak or unsupported.
- Exact evidence supports narrower claim → rewrite narrower.
- One source only on consequential claim → Single-source / risk.
- Undated source on fast-moving topic → Stale-risk.
- Stronger conflicting source → Contradicted until resolved.
- No adversarial check on recommendation-driving claim → Not final-ready.

## Evidence Weight > Vote Count

When multiple sources agree on a claim, check whether they are independent:

- **Independent agreement** (different organizations, different search backends, different publication dates): stronger signal.
- **Shared-corpus agreement** (same search results, same news wire, same LLM training data echo): weak signal. This is consensus hallucination — LLMs agreeing because they read the same corpus, not because the fact is true.

One source with a primary-source URL that passes mechanical verification beats three sources repeating the same unverified claim.

**Anti-collapse warning (arXiv:2605.17193, May 2026)**: Multi-LLM systems exhibit robust semantic collapse — they converge in meaning even when wrong. 12 intervention strategies failed to restore diversity. Subagent agreement is often mechanical, not epistemic. Tactics that resist collapse:

- **Cross-provider search**: Exa, Tavily, Serper, and Linkup use different retrieval systems and produced different result sets in focused calls. Compare routes only when another retrieval mechanism can close a named gap; overlap is contributor agreement, not independent evidence, and still requires source fetching.
- **Cross-model families**: DeepSeek, GLM, GPT have different training corpora. Diversity of model = diversity of priors.
- **Divergent prompts**: ask subagents "find what other agents would miss" rather than "research X." Explicitly instruct divergence.
- **Evidence gate before agreement**: never treat subagent consensus as evidence. Fetch and verify independently.

This is documented in:
- Shared Imagination (arXiv:2407.16604): LLM agreement without evidence is weaker than minority dissent with evidence.
- Till et al. 2025 (arXiv:2510.19507): single-source-with-evidence beats majority-consensus-without.
- Kong et al. 2026 (arXiv:2605.17193): multi-LLM semantic collapse is robust and resists intervention.

## Source Cascade (token-efficient verification)

When many sources exist for a claim, verify in order of cost:

1. **Local / `web_lookup` context7**: zero-cost, most reliable for docs/API claims.
2. **`web_search` snippets**: find the right URL. Do not treat snippets as evidence.
3. **`web_fetch` targeted evidence:** for a known source and specific need, pass compact `query_terms` plus LLM-only `context` when synthesis needs task background. Prefer ranked raw locators; use forced/automatic LLM filtering for synthesis or weak retrieval, then expand exact lines for consequential claims.
4. **Bounded site map / selected-page fetch (`web_fetch` site/map)**: only when a single page is insufficient.

Budget before asking user: 5 searches, 3 fetches per W2, 10+ for W3/W4.

## Discovery Mode vs Verification Mode

The harness defaults to verification mode (confirm/deny a claim). But many tasks need discovery mode first: finding things you don't know exist.

**Verification mode** (confirm a hypothesis):
- Narrow queries targeting known sources.
- Search → fetch → extract exact passage → check against claim.
- Ends when claim is confirmed or rejected.

**Discovery mode** (find the unknown):
- Use a broad query through the method whose retrieval shape fits the first uncertainty.
- Treat every result as a lead, not as evidence.
- Follow leads: pivot from one good source to its references, competitors, changelog, repo, docs, and citations.
- Add another provider/method only when a named source class, language/region, chronology, semantic neighborhood, social provenance, or sequential-retrieval error could change the candidate set.
- Ends when you have a candidate set to verify, or when leads stop producing novel results.

Discovery mode signal: disjoint qualified survivors from deliberately different methods expose useful richness. Overlap without new evidence means stop sampling providers and pivot to narrower queries, source-of-source tracing, official registries, GitHub/issues, or a niche source lane.

## Weak-Signal Amplification

For fast-moving fields (AI tools, frameworks, models, research), the best answer is often from the last 30 days and not yet widely cited. Finding it requires different tactics:

| Tactic | Tool | Use when |
|---|---|---|
| Time-gated discovery | `web_search` or constrained `web_search_tavily`: lexical dates; `web_search_x`: exact social bounds; `web_search_exa`: exact recency or `publishedWithinDays`; `web_answer_linkup`: date-bounded sourced orientation. Plus official release feeds, changelogs, dated docs. | Finding very recent releases, papers, announcements. |
| Category-scoped search | `web_search` domain-scoped queries such as `site:github.com`, `site:arxiv.org`, package registries | Finding code/repos or academic work before it hits mainstream blogs. |
| Domain-scoped search | `site:arxiv.org <topic>` or `site:github.com <topic>` via `web_search` | Bypass SEO listicles and go straight to primary sources. |
| Reference fan-out | Start from one accepted seed, then follow its references, repos, citations, docs, authors, issues, and alternatives | Discover work the seed explicitly links to. Exa URL similarity is deprecated in the installed SDK and must not be requested. |
| Cross-lane diversity | Same claim across official, implementation, criticism, and social routes | If lanes disagree, investigate conflict. If they overlap, try narrower queries. |
| Social/community scan | `web_search_x`, Reddit via Serper-backed `web_search`, HN/forums as leads | Find author announcements and practitioner discussion before formal publication. |
| Site subpage extraction | `web_fetch` `mode: map` then selected-page fetch | Extract recent posts from a lab/company site that have not been indexed yet. |
| Paper-to-code chain | Find a paper on arxiv → inspect linked project/repo → search repo/issues/releases | Trace from idea to implementation, often revealing practical gaps. |
| Awesome-list mining | Search for `awesome-<topic> 2026` repos | Curated lists often surface repos with 0-50 stars that are high quality but unknown. |

## Per-Tool Tactical Playbook

Each tool has capabilities that are not obvious from its description. Use these tactics for harder-to-find information. The four everyday tools are startup-active; load one specialist by exact name only when its native controls are decision-relevant. Live schemas own exact parameters.

### web_fetch
- **Default evidence fetch**: use for known URLs, official docs, GitHub pages/repos, articles, and video/media when relevant.
- **Classify returned content**: target-content, shell-content, block-content, metadata-only, or raw-only before using it as evidence.
- **Extraction**: single static lane (webclaw `-f llm`, keyless); the public `extract` knob and Linkup rendering branch are removed — there is no render or raw-content control.
- **Shell escalation**: JS/login shells are detected (js-needs rule) and escalate to the tavily lane automatically. A clean page can still be a login shell, cookie modal, or block page, so verify target content before using it as evidence.

### web_search (Serper Search)
- Start with 2–6 distinctive terms and at most one quoted identity, `site:`, year, or exclusion. Add another constraint only after the prior result exposes a specific noise class or missing discriminator. `country` maps to `gl`; the method returns up to 10 leads. Dates and domains are lexical query operators, not hidden provider fields. Media/local/scholar endpoints remain separate internal methods.
- One call is one Serper attempt without fallback. Answer boxes and knowledge graphs remain opportunistic leads; fetch the canonical survivor.

### Lazy provider/method specialists
- **`web_search_exa`**: minimal keyword for one known identity; neural/deep for a named discovery expansion. Classify adjacency/incomplete sets and use direct publisher/version/repository APIs; do not overload keyword or treat deep output as complete/latest.
- **`web_search_x`**: use an event-covering window, cited-post query, and explicit provenance. Exact-day/handle zeros are no retrieved evidence. Image synthesis stays unfetched; task-scoped evidence favors `parallelToolCalls:false` for narrow bounded work.
- **`web_search_tavily`**: constrained basic/general search with fixed 10 leads. Use one focused `query` and optional full-name `country` only for a named independent-guide or regional gap. Advanced, topic, freshness, domains, chunks, and exact match remain internal after failing W12 public-admission gates.
- **`web_answer_exa`**: bind one known candidate for a compact relationship question. Candidate pairs transferred; complete version aggregation failed despite explicit schema/instructions. Verify every field and use direct APIs for set/latest claims.
- **`web_answer_linkup`**: start standard for official-domain/date orientation. Escalate to deep only for one named missing chain field after identity success; never to repair an identity miss or metadata extraction. Fetch decisive pages/APIs.

Specialists are explicit one-provider attempts, not a substitute for the rejection-driven loop. After success, zero, or adjacency, return to the admission gate and choose fetch, one-variable mutation, a deliberately different method, or scoped no-winner.

### web_lookup
- **Context7 branch**: resolve ambiguity before docs, pin only a version the candidate advertises, prefer text for model reading, and use fast mode when latency matters more than reranking. Provider scores never authorize selection.
- **SkillsMP / pi-packages branches**: catalog leads only. SkillsMP stars are source-repository popularity and npm scores are registry ranking; inspect source and metadata before any install.

### bash + curl (raw diagnosis)
- Distinguish target-content from shell/block/metadata/raw output via headers/status/body.
- Registry APIs (GitHub/PyPI/npm/crates), HN Algolia, Lobsters for adoption and timestamp-precise discovery.

**Historical/apprenticeship, no public call (no public equivalent)**: `crawl4ai` (W4 JS-heavy/multi-page crawl with BM25/structural filtering); Tavily query-guided Extract, full Crawl controls, native Research, and usage (bounded site-map discovery is public through unified `web_fetch` `mode:map`); Exa Contents and legacy Research. Exa URL similarity is deprecated and must not be requested. Do not invent these as tools.

## Cross-Lane Triangulation

For discovery (W2+), use multiple lanes on the same question. Do not trust the first easy result, and do not mistake search-result availability for truth.

| Pattern | When | How |
|---|---|---|
| **Serper route + official source** | Finding the canonical source behind a widely repeated claim | Search broadly, then fetch the original docs, filing, changelog, paper, or author source. |
| **Official + implementation** | Checking whether docs match reality | Compare docs against repo source, package metadata, examples, or release artifacts. |
| **Official + criticism** | Production-readiness and risk questions | Compare claims against issues, changelogs, deprecations, incidents, forum reports, and negative cases. |
| **Freshness + staleness** | Fast-moving tools, APIs, pricing, models | Check newest releases and changelogs, then verify older authoritative sources are still current. |
| **Social/gated + primary proof** | Reddit/X/LinkedIn/Discord/TikTok leads | Treat social/gated output as leads unless the exact post/page is the claim. Verify elsewhere when possible. |
| **Fetch + raw HTTP diagnosis** | Fetched output looks thin or suspicious | Use `bash` + `curl` to distinguish target-content from shell-content, block-content, metadata-only, or raw-only output. |

Rule: if lanes return largely the same sources, you are in the mainstream. Try narrower vocabulary, source-of-source tracing, registry/package pivots, issues, changelogs, or a niche result as the next pivot.

## Eval Rubric

For W3/W4 postrun evaluation, score lightly. Do not over-bureaucratize.

Quality checks:

- Did depth match task complexity?
- Did discovery tools stay lead-only?
- Were final factual claims backed by fetched/read evidence?
- Did warrants prevent overclaiming?
- Were recommendation-driving claims attacked?
- Were contradictions preserved?
- Was uncertainty useful and specific?
- **NEW**: Were new/low-tier sources mechanically verified before use?
- **NEW**: Did old trusted sources get staleness-checked, not just assumed current?

Friction checks:

- Did W0/W1 stay fast?
- Did the harness over-escalate?
- Were tool calls excessive?
- Did the answer stop when enough evidence existed?

Hard failures:

- final claim cites an unfetched source;
- provider summary treated as evidence;
- final claim broader than evidence;
- W0/W1 created durable artifacts without need;
- W3 recommendation lacks adversarial check;
- contradiction hidden or smoothed away;
- **NEW**: new source dismissed as "low-tier" without attempting mechanical verification;
- **NEW**: old source trusted as "authoritative" without freshness check.

## Tool Stack (live, policy-aware)

Tool availability changes by `tool.yaml`, session activation, and installation state. Use the active tool list first. Do not request tools blocked by policy or tools that have no public call.

**Startup-active**:
- `web_search` — one Serper/Google lexical Search attempt with query, optional country, fixed 10 leads, and no fallback.
- `web_fetch` — primary known-URL verification; targeted sections, grouped corpora, page/map/crawl modes, and explicit rendered Linkup fetch.
- `web_answer` — one provisional Exa orientation attempt; verification and research are skill-owned.
- `web_lookup` — Context7 documentation plus SkillsMP and Pi-package catalogs.

**Installed by the websift extension; activate only by exact-name `tool_search` after method selection**:
- `web_search_exa` — mastered Exa-native narrow/novel candidate discovery.
- `web_search_x` — mastered exact-window/handle first-hand X discovery.
- `web_search_tavily` — constrained basic/general Tavily Search with query and optional full-name country.
- `web_answer_exa` — structured Exa relationship/none synthesis.
- `web_answer_linkup` — official-domain/date-bounded Linkup orientation.

`bash` + `curl` remains available for raw HTTP/status/header/body and registry diagnosis.

**Internal/apprenticeship — no public call**: Exa Contents/Similar/Research; Tavily full Crawl/Research/usage and query-guided Extract; Linkup structured Search/Research/balance; xAI model/video controls; `crawl4ai`. Legacy wrapper names map only where their current public semantics match an everyday tool.
