# Social, Community, Media, and Gated Sources

Read this reference whenever `$research` uses X, Reddit, HN, LinkedIn, YouTube, forums, newsletters, Discord/Slack archives, or JS/login-gated pages.

## What social evidence can prove

Social evidence is useful for:

- current vocabulary and emerging mechanisms;
- launch/adoption/hype signal;
- first-hand practitioner experience;
- failure modes, complaints, workarounds, and evaluation criteria;
- author/maintainer statements;
- source-of-source links to repos, papers, releases, demos, or incident reports.

It does not prove general quality, correctness, popularity beyond the observed lane, or independent adoption merely because engagement is high.

## Mandatory lead record

For every shortlisted social result:

```text
URL:
date/window:
author relationship: maintainer | implementer | direct user | commentator | unknown
content class: target | shell | block | metadata | search-summary
exact claim/mechanism:
objective-fit gate:
engagement/adoption signal:
primary/source-of-source URL:
independent or launch-cluster:
criticism/contradiction:
next action:
```

Search-tool syntheses are `search-summary-only`. Fetch the cited post/thread when its content matters. Preserve source-of-source URLs separately.

## Social search sequence

1. **Exact target:** decisive mechanism + explicit date window + relevant artifact/user language.
2. **Noise repair:** exclude the dominant false-positive class and repeated handles/products; add first-hand terms such as `we use`, `production`, `postmortem`, `logs`, `benchmark`, `stopped using`, or exact error/failure language.
3. **Criticism:** search survivors/category with `failed`, `broken`, `regression`, `abandoned`, `security`, `too complex`, `not worth`, or the discovered complaint vocabulary.
4. **Source-of-source:** follow only new repos, papers, releases, demos, or evidence capable of changing the verdict.

Do not run a fourth query merely for more posts. It must be earned by a new discriminator, source, or contradiction.

## Engagement and independence

Treat engagement relative to:

- age of the post/artifact;
- size of the author's audience and field;
- whether engagement comes from replies/quotes with substantive use versus passive likes;
- number of independent accounts, not syndicated/reposted copies;
- whether discussion links to inspectable artifacts or reproducible details.

High engagement is prioritization signal. Low engagement can still contain exact first-hand evidence, but it increases the need for source verification and independent corroboration. Never use nationality, location, accent, or follower count alone as a quality judgment.

## Platform tactics and limits

### X

- Use the native X method (`web_search_x`; legacy name `xsearch`) when available; site search is partial.
- Use exact date ranges and handle filters (`allowedHandles`/`excludedHandles`) for provenance.
- Separate maintainer/author claims from independent-user reports.
- The method returns a synthesis plus citation URLs, never raw posts; fetch the cited post (`web_fetch`) when its content matters. Model/video controls remain internal; public image understanding is lead-only until media is inspected directly.
- Launch-thread repetition is one source cluster, not many independent signals.

### Reddit, HN, and forums

- Prefer exact threads with dates, versions, logs, and maintainer participation.
- Rank source-linked/reproducible comments above consensus without evidence.
- Direct Reddit fetches may be blocked; classify access honestly and use mirrors/source links only when they preserve target content.
- HN/API popularity is discussion signal, not mechanism proof.

### LinkedIn

- Public pages often return partial or app-shell content. Search snippets are leads only.
- Carousel/advice posts without versions, artifacts, or reproducible details are source-thin.
- Do not claim professional consensus from a few accessible posts.

### YouTube/video

- Transcript/chapter/timestamp first.
- Use frames only when UI, charts, demos, or visible code are part of the claim.
- Auto-caption errors and edited demos are evidence limits.

### Discord/Slack/chat archives

- Use public indexed archives only unless explicitly authorized.
- Treat messages as practitioner signal; prefer maintainer answers linked to docs/issues/source.
- Do not imply a private-community consensus from an incomplete archive.

### Newsletters and blogs

- Trace repeated claims to the original announcement, paper, repo, data, or incident.
- Author expertise/conflict is a signal, not a substitute for evidence.
- SEO/listicle repetition is one false-positive class.

## Fetched-content classes

- `target-content`: intended post/thread/transcript/page is visible; may support a scoped claim.
- `shell-content`: login/app/unsupported-browser/marketing shell; proves only shell state.
- `block-content`: CAPTCHA/paywall/access denial; proves only access state.
- `metadata-only`: title/OpenGraph/URL/date only.
- `search-summary-only`: provider synthesis/snippet; lead only.

A successful HTTP response is not target content.

## Social verdict separation

For “best,” “hyped,” or “emerging,” report separately when useful:

```text
social signal:
mechanism fit:
currentness/maintenance:
adoption/independent use:
quality evidence:
evidence limits:
```

A result may be socially hot but technically off-target; reject it from the recommendation while accurately reporting the social signal if the user asked about hype. A technically exact new result may have weak social signal; keep it experimental until corroborated.

## Stop conditions

Stop the social frontier when:

- repeated queries return the same launch cluster or false-positive class;
- no new primary/source-of-source artifacts appear;
- remaining posts add sentiment but cannot change eligibility or the recommendation;
- access limitations prevent target-content verification and alternatives are exhausted.

State the searched dates, platforms/handles where relevant, dominant noise classes, and untried lanes. Do not claim exhaustive community consensus.
