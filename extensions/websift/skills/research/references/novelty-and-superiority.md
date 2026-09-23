# Frontier, Novelty, and Superiority Research

Read this reference for latest/new/trend/social/best/superior work. It prevents two opposite errors: recommending famous but off-target artifacts, and promoting obscure recent artifacts merely because their wording matches.

## Gate order

Apply these gates in order. Later signals cannot repair an earlier failure.

1. **Exact objective fit:** every hard requirement and no disqualifier.
2. **Mechanism proof:** primary source shows the requested behavior, not only a label or promise.
3. **Freshness/applicability:** within the requested window or a justified canonical/mature exception; relevant updates touch the decisive mechanism.
4. **Stewardship/maintenance:** maintained source, responsive ownership, usable release/artifact, no unresolved deprecation/supersession.
5. **Adoption/engagement quality:** evidence of real use or attention relative to artifact age, audience, and field—not one raw number.
6. **Independent corroboration:** use, criticism, reproduction, citations, issues, integrations, or discussion beyond coordinated launch repetition.
7. **Superiority:** verified difference over the named baseline on the required failure mode at acceptable cost/ceremony.

A result failing gate 1 is rejected immediately. Do not spend time checking its stars, views, or elegance.

## Signal vector, not popularity score

Keep these independent:

| Signal | What it may indicate | What it cannot prove |
|---|---|---|
| Release/post/publication date | Recency and possible frontier position | Quality, adoption, mechanism fit |
| Stars/downloads/views/likes | Awareness or attention | Correctness, fit, superiority, organic adoption |
| Stars/downloads per unit age | Early velocity | Durable use or quality |
| Contributors, dependents, integrations | Deeper ecosystem use | Suitability for this objective |
| Issues/PRs/replies | Active use and friction | Positive quality by themselves |
| Commits/releases/changelog | Maintenance/currentness | Adoption or correct mechanism |
| Citations/reproductions | Research attention/verification | Production usefulness |
| Independent practitioner reports | Real-world signal | General truth without artifacts/logs |
| Maintainer/author statement | Primary claim/provenance | Independent validation |

GitHub itself defines stars as bookmarks/displays of appreciation and a popularity ranking, not quality proof. Current research also finds that framework stars can diverge from contributor depth/retention and can be manipulated. Treat every popularity metric as triage evidence only.

## Age- and field-aware interpretation

Do not use a universal star/like/download threshold.

### New and low-signal

A result released days ago cannot have mature adoption. If it is exact-fit:

- classify `unverified-exact-fit`;
- verify source/mechanism and release date;
- inspect maintainer history and repository/package integrity;
- search exact names/authors for independent discussion;
- inspect early issues, demos, integrations, or reproductions;
- present as experimental/frontier only when the user asked for frontier results and evidence remains limited.

Do not call it “best,” “high quality,” or “superior” from exact wording alone.

### Old and highly adopted

An older artifact can remain valid when it is canonical, actively maintained, stable by design, or still dominant on the required mechanism. But for “latest/new” it is a baseline or mature alternative, not the requested frontier result unless recent work materially changes the mechanism.

### Popular but off-target

Reject. Popularity cannot compensate for a failed hard requirement.

### High engagement, low evidence

Keep as a social/hype signal. Fetch the primary artifact and look for independent use, criticism, and mechanism proof before promotion.

### Exact fit from an unknown author

Do not use nationality, geography, prestige, or follower count as a quality proxy. Evaluate inspectable mechanism, provenance, maintenance, reproducibility, independent signal, and evidence. Unknown authorship raises verification work; it does not itself prove low quality.

## Social/trend evidence matrix

For each trend claim, separate:

```text
social signal: mentions, engagement, independent accounts, replies/quotes
mechanism fit: what the artifact demonstrably does
currentness: release/post dates and recent mechanism-relevant activity
adoption: real use, contributors, integrations, downloads, citations, dependents
quality evidence: artifacts, tests, benchmarks, reproducible details, failures
source independence: launch cluster vs independent practitioners
limits: blocked posts, snippets, missing metrics, hype bias
```

A trend verdict may be strong while a quality verdict remains weak, or vice versa. State them separately.

## Frontier search pattern

Use non-overlapping lanes:

1. **Official/release:** new versions, changelogs, model cards, standards, announcements.
2. **Implementation:** repos, source, packages, demos, issues, PRs, benchmarks with code.
3. **Semantic discovery:** unfamiliar vocabulary, renamed mechanisms, adjacent fields.
4. **Social/practitioner:** launches, first-hand use, postmortems, failures, current vocabulary.
5. **Criticism:** bugs, abandoned attempts, deprecations, disappointments, security, hidden costs.
6. **Provenance:** original source behind repeated claims.

Start broad only until you learn vocabulary. Then use the eligibility contract and false-positive exclusions from `search-steering.md`.

## Social query sequence

For current practitioner evidence, do not issue repeated “best X” searches.

1. Exact mechanism + date window.
2. Dominant false-positive class excluded; add first-hand-use language (`we use`, `production`, `postmortem`, `stopped using`, logs, benchmark).
3. Criticism/failure query for surviving candidates or the category.
4. Source-of-source query only when a post reveals a repo, paper, release, or new vocabulary.

Separate author/maintainer posts from independent-user posts. Deduplicate coordinated launches, reposts, syndicated articles, and posts that cite the same origin.

## Baseline and superiority attack

Audit the named baseline before alternatives:

- Does it already implement the claimed novelty under another name?
- Is the candidate only a wrapper, naming change, or more elaborate version?
- Does the candidate improve the exact failure mode or only add features?
- What additional agents, hooks, state, dashboards, approvals, setup, or human decisions does it require?
- Is evidence measured against the actual baseline configuration?

Required promotion sentence:

```text
Compared with <baseline>, <mechanism> handles <failure mode> better
because <verified difference>, at <ceremony/cost/risk>.
```

If evidence cannot complete the sentence, use `unverified-exact-fit`, reject, or no-winner—not `superior`.

## Final verdicts

- `reject`: any hard gate fails, baseline-equivalent/inferior, stale without exception, unsupported, or excessive ceremony.
- `unverified-exact-fit`: hard fit appears present, but current-quality or primary proof is incomplete.
- `candidate`: all hard gates and enough current-quality evidence clear; a trial/comparison may decide.
- `superior`: verified improvement over the named baseline on the required dimension with acceptable cost.
- `no winner`: no result clears the contract in the searched lanes.

Do not publish “watch,” “steal,” or “near miss” categories unless the user explicitly requests experimental ideas or mechanisms. Those labels otherwise become a path for rejected results to re-enter the recommendation.

## No-winner report

When nothing qualifies, report:

```text
Exact contract:
Lanes searched:
Dominant rejection classes:
Strongest unverified exact fit (only if decision-relevant):
Why it was not promoted:
Untried lane or missing evidence:
Constraint/evidence that could change the outcome:
```

No-winner is more useful than a polished list of inferior substitutes.
