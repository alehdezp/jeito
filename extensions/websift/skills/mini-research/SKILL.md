---
name: mini-research
description: "Bounded W1/W2 web source work: a fact-check against one authoritative source, or a light 2-3 source check for a low-stakes question. Normally stateless — answers in chat with fetched URLs, no research folder. Escalates to skill/research on any W3/W4 trigger: best/superior/comparative, conflicting sources, several hard constraints, fast-moving/frontier/social evidence, a consequential install/architecture/money/security/strategy decision, or repeated searches returning adjacent results. Do not use for a single known URL (just fetch it) or for routine library docs (use web_lookup)."
disable-model-invocation: false
updated: "2026-09-23 12Z"
---

# Mini Research Operator (W1/W2)

`mini-research` is the default bounded web source check. It answers a low-stakes question with one to three fetched sources and stops. It is **not** the serious-research workflow — that is `skill/research` (`../research/SKILL.md`), which owns multi-lane rejection loops, the Closure Gate, durable research state, and full warrants.

## Activation boundary

Use ordinary tools without this skill for a single known URL (`web_fetch`) or routine versioned library docs (`web_lookup`).

Use `mini-research` when:

- **W1 fact-check:** one current fact needs one authoritative source.
- **W2 light research:** a low-stakes question needs two or three source checks, with no comparison, conflict, or consequential decision.

**Escalate to `skill/research` (`../research/SKILL.md`) — hand off, do not continue here — when any W3/W4 trigger is present:**

- the user explicitly invokes `skill/research`, or says hard/serious/thorough/compare deeply/deep research/W4;
- the task asks for best, superior, comparative, latest, emerging, frontier, social, or current practitioner evidence;
- several hard constraints must all hold;
- sources conflict, freshness is material, or source authority is unclear;
- a consequential install/architecture/money/security/law/health/strategy decision depends on the answer;
- repeated ordinary searches return adjacent results instead of the target;
- a reusable skill/package/tool may avoid significant reinvention but fit and currentness require investigation.

If a W2 check surfaces a trigger mid-run, stop the bounded work and escalate. Do not attempt the Closure Gate, multi-lane rejection loops, or full warrants here — those belong to `skill/research`.

## Stateless by default

Answer in chat. **Do not create a research folder, `.research` link, or other durable state for W1/W2.** Record state only if the user explicitly asks to persist it, or if the work escalates — at which point `skill/research` and its [`references/folder-system.md`](../research/references/folder-system.md#canonical-location-and-identity) own portable W3/W4 storage. Depth should change the work performed, not just the label used; a W1/W2 task that needs durable state is a W3/W4 task and should escalate.

## Bounded budget

- **W1:** one authoritative source fetched. Stop when the fact is confirmed or refuted.
- **W2:** two to three source checks. Stop when the low-stakes question is answered or a trigger appears.
- Roughly five searches and three fetches is the ceiling before reconsidering scope. If the answer still depends on an untested assumption or an unfetched source, escalate rather than spend more.

## Evidence discipline (shared with skill/research)

Read the shared reference before relying on a right or warrant; do not duplicate it here.

- **Evidence rights and warrants:** [`../research/references/evidence-and-warrants.md`](../research/references/evidence-and-warrants.md) — lead-only vs evidence-eligible vs verified, fetched-page content classes, and the minimal warrant.
- **Tool/lane preflight:** [`../research/references/tool-lane-preflight.md`](../research/references/tool-lane-preflight.md) — only when a provider/lane is named, unavailable, or non-default.

Core rules that always apply:

1. **Search output is discovery.** `web_search` snippets/rankings/provider answers, `web_answer` syntheses, and catalog rows are `lead-only` until the primary passage is fetched/read with `web_fetch`. Fetch returns full content up to 5K tokens (heading navigation beyond), prints the cache path, and `query_terms` overlays ranked matches with exact line ranges — read the file at those lines instead of refetching.
2. **Prefer primary sources.** Official docs/specs/changelogs, upstream source, registries, and `web_lookup` context7 for versioned library docs. "Official" is not timeless — check version and date.
3. **Mechanical check before relying on a Tier 3 or fast-moving source:** the URL resolves and the quoted claim appears in the fetched page. Snippets are not sufficient.
4. **External evidence does not override local truth.** Bind to pinned version, date, platform, and current local behavior before applying.
5. **Say "I don't know" when nothing reaches evidence-eligible.** Do not soften unsupported claims with "likely" or "appears to."

## Live public web surface

The startup-active tools are `web_search`, `web_fetch`, `web_answer`, and `web_lookup`.

- `web_search` — lead-only Serper/Google lexical discovery; one provider attempt with no fallback.
- `web_fetch` — known-URL extraction with full/smart content and ranked `query_terms`; bounded async `crawl` acquires one locally enforced subtree. `llm_answer` generates or reuses immutable answers keyed by retained page content, objective, and `query_terms`; generated prose remains lossy and exact cached lines remain the evidence authority.
- `web_answer` — one quick provisional Exa answer with no fallback; fetch decisive citations before relying on it. Verification remains this skill's job.
- `web_lookup` — Context7 library docs plus SkillsMP and Pi-package catalog leads.

The extension also installs five lazy specialists: `web_search_exa`, `web_search_x`, constrained `web_search_tavily`, `web_answer_exa`, and `web_answer_linkup`. Do not activate them merely to broaden a W1/W2 check. When a distinct provider method becomes decision-relevant, the task has crossed into the `skill/research` preflight and should escalate with its current findings.

Internal operations remain non-callable: Exa Contents/Similar/Research, Tavily full Crawl/Research/usage and query-guided Extract, Linkup structured Search/Research/balance, and xAI model/video controls. Comparative provider roles remain task-scoped; state what a source establishes, not a provider winner.

## Social evidence (only if the question is social)

For X/Reddit/HN/gated evidence, read [`../research/references/social-and-gated-sites.md`](../research/references/social-and-gated-sites.md). Social synthesis is a lead; fetch the cited post and record date and source-of-source. A high-engagement post is a prioritization signal, not quality proof.

## Output shape

Answer compactly in chat:

```text
Answer: <the claim, narrowly worded>
Source(s): <fetched URL(s); add the exact locator (heading, paragraph, line, timestamp, or URL fragment) when the fetched surface provides one — never fabricate a locator>
Warrant: <why the source supports this exact claim>
Limits: <what it does not prove; freshness/conflict>
Unverified: <anything left lead-only — name it, do not hedge it into the answer>
```

If the question turns out to need W3/W4 work, say so and hand off to `skill/research` with the objective and what was already checked.
