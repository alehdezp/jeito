# Evidence and Warrants

Purpose: keep serious research honest after candidate eligibility is established. Strong evidence cannot rescue an off-target candidate; evidence rights govern only what may be claimed about a result that survived the hard-fit gate.

## Evidence rights

Every tool result has a default evidentiary right:

| Right | Meaning | Allowed use |
|---|---|---|
| Lead-only | Useful for discovery; not final support. | Search snippets, rankings, provider summaries, directory pages. |
| Candidate | Relevant but exact support not yet proven. | A sourced answer or result that still needs source reading. |
| Evidence-eligible | Fetched/read source with target content and locator. | Can support a scoped claim after a warrant. |
| Verified | Evidence anchor + warrant + freshness/conflict check support the exact final wording. | Can support recommendation-driving claims. |

## Eligibility precedes evidence quality

Apply the hard must-have/disqualifier checklist from `SKILL.md` and `search-steering.md` first. Then evaluate whether the available source can prove the surviving claim.

- Off-target + primary source = well-proven reject.
- Exact-looking + weak source = `unverified-exact-fit`, not recommendation.
- Popular/recent + failed constraint = reject.
- Exact-fit + strong current evidence = eligible for comparison/recommendation checks.

Do not average fit and evidence into one score.

Default result rights:

- `web_search` snippet, ranking, or provider-route answer: Lead-only.
- `web_answer` summary, or a web-search answer summary: Candidate until exact sources are fetched/read.
- `web_fetch` (page mode), exact URL fetch: Evidence-eligible only for returned target content.
- `web_lookup` context7 docs: Evidence-eligible for library/API claims at the returned version, not product/news/social claims.
- GitHub/npm/PyPI/registry metadata (via `web_fetch` or `bash curl`): Evidence-eligible for repo/package/version facts; source/tarball needed for implementation claims.
- Bounded site traversal output (`web_fetch` map): Evidence-eligible per fetched page when target content is present. A dedicated crawl endpoint (Tavily Crawl, Crawl4AI) is an internal/apprenticeship hypothesis with no public call.
- X/social result (`web_search_x`): Signal-only or Candidate; not sole factual proof unless claim is about that post/thread.
- Raw HTTP (`bash curl`): Evidence-eligible for status, headers, redirects, and raw body; semantic claims need cleaned/read content.

## Fetched-page content classes

A fetched page is not automatically evidence for the intended target. Classify first:

- `target-content`: intended page content is present; can support scoped content claims.
- `shell-content`: login/app/unsupported-browser/marketing shell; proves only shell state.
- `block-content`: CAPTCHA, verification, bot block, paywall, access denial; proves only access state.
- `metadata-only`: title/OpenGraph/lightweight metadata/URL existence; supports metadata claims only.
- `raw-only`: HTML/JS dump without semantic extraction; needs reading/cleaning before content claims.
- `search-summary-only`: lead or candidate only; fetch/read before final use.

## Source authority and applicability

Source classes decide what verification and scope are required; they are not a timeless trust hierarchy.

| Class | Examples | Default use |
|---|---|---|
| Primary/canonical | Official docs/spec/changelog, upstream source/release/issue, registry, paper/artifact, direct maintainer statement | Fetch/read exact anchor; check version/date/applicability. |
| Independent technical | Reproduction, benchmark with artifacts, postmortem, engineering analysis | Verify method, versions, conflicts, and source-of-source. |
| Practitioner/community | First-hand post, forum thread, tutorial, newsletter | Signal, failure vocabulary, or scoped direct experience; seek artifact/source. |
| Noisy/unverifiable | SEO listicle, anonymous summary, AI-generated content, repeated marketing | Discovery only or reject. |

A current, mechanically verified independent source can be more applicable than old official docs for a changed interface. Official current docs can still be wrong for a project pinned to an older version. State the applicability boundary.

## Mechanical source verification

For W3/W4 claims from practitioner/community sources, fast-moving topics, or version-sensitive sources, apply before promotion:

1. URL/content check: the URL resolves (`web_fetch`, or `bash` + `curl -sIL`) or the fetch returns target content.
2. Passage check: the quoted claim or close paraphrase appears in the fetched/read source.

Search snippets are not sufficient. A source that passes both checks can become Evidence-eligible, but still needs a warrant for final use.

## Warrant rule

A warrant explains why evidence supports a claim and what it does not license.

Depth budget:

- W3: compact warrant for every recommendation-driving claim.
- W4: full warrant records for central claims and disputed evidence.

Minimal warrant:

```text
Claim:
Evidence:
Warrant:
Limit:
Allowed final wording:
```

## Adversarial checks

Use targeted attacks, not vague contradiction search:

- Staleness: newer changelogs, docs, prices, policy changes.
- Authority: original source behind secondary claims.
- Scope: what the evidence does not prove.
- Failure: bugs, deprecations, outages, warnings, issues.
- Alternative: better tools/explanations that weaken the recommendation.
- Maintenance: abandoned package, issue backlog, dependency risk.
- Interface drift: API/tool/schema changed since docs/examples.
- Novelty verification: new/low-tier interesting claim; verify mechanically or keep as signal.
- Bidirectional staleness: old trusted sources need currentness checks too.

Check budgets:

- W3: primary-source/applicability, staleness, failure, and alternative checks on recommendation-driving claims.
- W4: all relevant attacks for central claims, plus independent verification when feasible.

## Stop rule

Stop when the key claim has evidence-eligible support and a scoped warrant, recommendation-driving claims passed required checks, further searches repeat known weak sources, and remaining uncertainty is named and acceptable.

Do not keep searching to look rigorous. Continue only when the answer is still plausible-but-unproven, marketing-shaped, source-thin, or mismatched to the objective.
