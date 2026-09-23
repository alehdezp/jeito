---
title: "jeito websift release work plan — resumable subgoal queue"
description: "Single release-readiness work queue. Every subgoal names the decision it unlocks, its resume pointers, definition of done, budget, and stop conditions, so any agent can pick one up and continue without re-deriving state."
tags: [jeito-websift, work-plan, release-readiness, subgoals, provider-experiments, resume-protocol]
created: 2026-08-04
updated: 2026-08-12
status: active
owns: "Release work queue, subgoal resume contract, and experiment intent doctrine"
audience: contributing-agent
related: [docs/ROADMAP.md, docs/adr/0005-provider-evaluation-and-guidance/0004-benchmark-and-selection.md]
---

# jeito websift release work plan

This is the single queue of remaining work. The ROADMAP records delivery history;
this file records what is left, in pickup order, so a fresh agent can resume one
subgoal without confusion.

## Resume protocol (every session, before any work)

1. Read this file, `.pi/goals/jeito-websift-capability.md` (checkpoints), and
   `.tmp/web-coordinator-responsibilities.md` (coordinator execution + two-model verification pair).
2. Verify Git truth: `git log --oneline -5`, `git status --short -- extensions/websift`,
   and that the index contains no unrelated session's staged files. Never
   `git reset` another task's index; commit web paths with path-scoped commits.
3. Re-derive the budget from the ledger below; never trust an in-chat running total.
4. Pick exactly one open subgoal. Update its status line here when starting,
   and record its outcome before moving to the next.
5. Stop for `alehdezp` at: public contract changes, provider role/default selection,
   skill-owner cutover, APPEND wording, commit boundaries that touch non-web paths,
   destructive actions, or budget exhaustion.

## Budget ledger (owner authority)

- Cumulative ceiling: **$13.00** (raised by `alehdezp` 2026-08-04 from $10.00 with an additional $3.00 creative-provider mastery allowance).
- Conservative consumed through apprenticeship v2: **$6.815** = $3.732
  (through the harness-learning pre-master, goal checkpoint) + $3.083
  (apprenticeship v2 95-cell operation;
  `.tmp/apprenticeship-v2-adjudication-and-tool-decisions-20260803.md` §1).
- W1 fetch-route incident (2026-08-04): an intended credential-free `world.org`
  site-map call routed through Tavily and reported two credits. Conservative
  reserve: **$0.016** at the recorded $0.008 pay-as-you-go maximum per credit.
- W3 provider mastery (2026-08-04): **$0.325** conservative consumption = Exa reported `$0.007 + $0.007 + $0.005`, xAI `$0.300` retained reserve with no billing metadata, and Linkup `$0.006` retained standard reserve with no billing metadata. Manifests/results: `.tmp/w3-provider-mastery-20260804/`.
- W8a evidence-derived provider guidance mastery (2026-08-04): **$0.648** conservative consumption = Exa reported `$0.028 + $0.010`, xAI `$0.600` retained reserve with no billing metadata, and Linkup `$0.010` retained reserve with no billing metadata. Manifest/results: `.tmp/w10-provider-guidance-mastery/`.
- W8b creative hard-narrowing provider mastery (2026-08-04): **$2.669** conservative consumption = Exa `$0.080` (reported `$0.060` plus two `$0.010` empty-call reserves), xAI `$2.400` retained reserve, and Linkup `$0.189` retained reserve. Manifest/results: `.tmp/w11-creative-provider-narrowing/`.
- W8c provider/method diversity mastery (2026-08-05): **$0.328** conservative consumption = Serper `$0.010`, Tavily `$0.088`, and Linkup `$0.230` retained reserve. A coordinator tool-recipient error then made two irrelevant Exa Answer calls reporting `$0.005` each; the disclosed **$0.010 accidental off-manifest spend** is excluded from experiment evidence.
- **Current consumed: $10.811; remaining: $2.189.** Spend rules: track provider-reported cost, else reserve the grounded maximum; no interruptions for single amounts ≤ $0.01; stop before the next operation could exceed the ceiling. Every paid packet must be written down before dispatch. The W1 route incident and W8c coordinator incident remain disclosed; provider-routed output from either is excluded from the intended evidence packet.
- **Post-W8 reconciliation (2026-08-11):** retained current-session outputs show `$0.044` reported Exa spend (two Search calls at `$0.012`; four Answer calls at `$0.005`), seven Serper credits reserved at the `$0.001` Starter maximum (`$0.007`), one Tavily credit at the recorded `$0.008` maximum, fast/standard/deep Linkup sourced answers at `$0.006 + $0.006 + $0.055 = $0.067`, and two xAI searches with no billing metadata retaining `$0.300` each. Additional conservative consumption is **$0.726**; total consumed is **$11.537**, leaving **$1.463** at the `$13.00` ceiling. This closes the retained-session audit; provider dashboards remain authoritative for any off-session usage. No new paid packet is authorized without an explicit owner decision.
- **Completed `llm_answer` release packet (2026-08-11):** adaptive harness generated 20/20 artifacts; direct cache adjudication found **16 verified, 4 partial, 0 factual drift/failure**. Six extra candidates stopped before model work. No Tavily/fallback/retry ran. V4-Pro-rate reserve was `$0.095812`. Owner then approved immutable intent-keyed sidecars; focused tests prove distinct intents coexist and legacy exact reuse survives. A fresh normal Agent startup generated two distinct MDN 418 objectives at different keyed paths and reused the second byte-for-byte, with no fallback or policy rejection. Reserving the full `$0.025` proof cap brings program accounting to **$11.657812 consumed/reserved / $1.342188 remaining** at the `$13.00` ceiling. Evidence: `.tmp/web-llm-answer-20260811/` and Agent transcript `8f07e06f-162b-4dd-7609b498`.

## Experiment doctrine (owner-directed 2026-08-04)

A provider experiment exists to learn **how to direct each provider at hard,
specific research topics** — not to watch it behave passively.

- Every call needs: named intent, hard constraints, the provider mechanism that
  discriminates (advanced controls, date/handle/domain narrowing, structured
  output, native answer modes), and a no-winner state.
- Queries must be ambitious and hard: difficult, specific, recent, multilingual,
  or contradiction-heavy topics; use each provider's own directives (Exa
  `type`/`category`/`contents`/`systemPrompt`, Tavily depth/topic/exact-match,
  Linkup depth/domains/structured schema, xAI handles/dates/media/cost controls,
  Serper locale/verticals).
- **An experiment FAILS if the agent only issues plain queries, or makes minimal
  unambitious parameter tweaks that test almost the same thing.** Re-run with a
  discriminating design before drawing any conclusion.
- Classify every lane with the three-outcome rubric in
  `.tmp/harness-learning-20260803/scenarios.md`: similar-but-lower-quality,
  high-quality-and-trustworthy, drifted — plus no-winner as a valid fourth state.
- Output of every experiment: per-lane outcome class, one playbook recipe row
  (when to use this lane on this topic shape), one anti-recipe (past mistake to
  avoid), and a named follow-up area it uncovered. That is the product value:
  future agents using the tools or the research skill know the *end goal* of
  each call, get a second point of view that unblocks or widens research, and
  know how to narrow and filter what they want and do not want.
- The coordinator designs and executes every provider experiment directly after pinning references, hard gates, budget, and decision rules. Agents never substitute for coordinator testing or experimentation. After each coherent plan, implementation, test, or experiment checkpoint, send the same evidence and verification question in parallel to `web-council-deepseek` and `web-council-qwen`; use their independent disagreement as advisory falsification, not execution or proof.

## Two-model verification model (owner directive 2026-08-04)

The coordinator plans, implements, tests, and experiments directly. Every consequential checkpoint then receives the same bounded verification task from exactly two independent agents in parallel:

- `web-council-deepseek` — `opencode-go/deepseek-v4-flash`
- `web-council-qwen` — `alibaba-plan/qwen3.8-max`

Agents are double verification only: they do not own implementation, tests, provider calls, evidence interpretation, or completion. The coordinator compares both findings against current source/runtime evidence, records substantiated dissent, and fixes only verified issues. Never silently substitute another model or send different questions that make agreement meaningless. Runtime recovery and durable-memory mechanics live in `.tmp/web-coordinator-responsibilities.md` under "Persistent two-model verification pair".

## Provider mastery loop (owner directive 2026-08-04)

Provider result quality is NEVER validated with reusable static tests, fixtures,
or hardcoded expectations. Provider behavior drifts by version and by day; a
hardcoded assertion of what a provider returned is waste. Validation is an
adaptive, coordinator-executed loop with the same bounded result/admission claims then sent to the DeepSeek/Qwen verification pair:

1. **Query** — state the intent and hard constraints for this hard task/scenario.
2. **Think, understand** — reason about what this provider's mechanisms can do
   for this shape before calling it.
3. **Creative intelligent mutation** — change parameters, filters, dates, domains,
   structured controls, or simply write a better query; mutations must be
   discriminating, not minimal paraphrases.
4. **Understand results** — read what actually came back: what happened, why,
   which mechanism produced it, what is missing or drifted.
5. **Repeat** — mutate again from that understanding, until the task shape is
   refined and the lane's behavior is explained.
6. **Distill** — one recipe row (how/when this lane helps this topic shape), one
   anti-recipe, and how the lane complements the others — even when inferior here.

The loop runs until refinement for each hard task and scenario; the council
governance pair adjudicates results semantically against independently fetched
primary sources. Scripts only ever check transport/billing/secret guardrails —
never what a provider said.

## Subgoal queue

Status values: `open` | `in-progress` | `blocked-on-owner` | `done`.

### W1 — Owner + council attack on the apprenticeship v2 adjudication — done

- **Decision it unlocks:** the four specialist tool schemas may be implemented.
- **Resume:** `.tmp/apprenticeship-v2-adjudication-and-tool-decisions-20260803.md`
  §7 and `.tmp/w1-credential-free/source-adjudication.md`.
- **Work:** two governance rounds and both primary-source adjudications completed.
- **Done:** `alehdezp` accepted §7 and corrected the answer names to
  `web_answer_exa` and `web_answer_linkup`; reviewer objections remain recorded.
- **Budget:** $0 planned; $0.016 route incident tracked in the ledger above.

### W2 — Implement the accepted specialist tools — done

- **Decision it unlocks:** W3 can exercise the exact specialist contracts in an isolated harness; loaded agents still cannot call them until owner-approved activation.
- **Resume:** accepted adjudication §7 schema list; ADR-001.003 (`web_` namespace rule);
  goal checkpoint 103 (no invented orchestration; provider outputs differ honestly).
- **Work:** `web_search_exa`, `web_search_x`, `web_answer_exa`,
  `web_answer_linkup` — typed schemas from accepted W1 amendments, dense tool-local guidance
  (scenario-bound, never global "best"), GCF output encoding, no hidden
  fallback. Do not activate or register until W3 recipes exist and the owner
  accepts activation.
- **Done:** two dormant verb-owned modules define all four accepted schemas; one focused deterministic owner proves schema/request/evidence/cost boundaries; a cold Qwen trajectory constructed four valid first-attempt calls and exposed only wording ambiguities that were corrected. The package typecheck and 291-test suite pass. `index.ts` and public registration remain unchanged.
- **Budget:** $0 implementation; one trajectory model run.

### W3 — Intent-driven difficult-topic experiments (council scout pair) — done

- **Decision it unlocks:** scenario-bound recipes and anti-recipes for the
  research skill playbook; activation approval for the specialists.
- **Resume:** `.tmp/harness-learning-20260803/scenarios.md` (12 scenarios, rubric);
  doctrine section above.
- **Work:** the scout pair (`web-scout-deepseek`, `web-scout-qwen`) each run a
  designed packet over distinct hard scenarios
  current events, long-tail papers + implementations, first-hand social windows).
  Pinned references and hard gates BEFORE dispatch. Every packet records the
  three-outcome classification per lane.
- **Fail condition:** plain-query or minimally-mutated packets — reject and redesign.
- **Done:** E2, X2, and E3 stopped under their manifests; primary bytes and fresh DeepSeek/Qwen adjudication are final in `.tmp/w3-provider-mastery-20260804/ADJUDICATION.md`. Scenario-bound specialist rows now live beside the Exa, Linkup, and X lanes in `skills/research/references/web-tools-playbook.md`; each states its task, confidence boundary, anti-recipe, and direct-fetch complement.
- **Budget:** W3 consumed `$0.325` conservatively: Exa reported `$0.007 + $0.007 + $0.005`; xAI retains the `$0.300` reservation because it returned no billing metadata; Linkup retains its `$0.006` standard reserve because it returned no billing metadata. Program ledger is `$7.156` consumed / `$2.844` remaining. No retry or fallback ran.
- **Result:** Exa Search oriented unfamiliar 2026 research but its exact-title GitHub pin drifted to adjacent repos; xAI remained empty and falsely denied a primary-confirmed launch after the one-control window repair; Linkup found the official page but omitted its date metadata; Exa Answer obeyed explicit-none schema while falsely claiming its own cited paper lacked the explicitly linked project repository. Direct publisher/repository bytes decided every promoted claim. These are single-scenario recipes, not provider-quality rankings; W3 alone did not approve activation, which the owner accepted after W4.

### W4 — Teach the surface: promptSnippet/promptGuidelines + first-use hooks — done

- **Decision it unlocks:** agents construct advanced calls correctly on first contact.
- **Resume:** `src/tools/web-search-specialists.ts`, `src/tools/web-answer-specialists.ts`, and `tests/web-specialists.test.mjs`.
- **Work:** `alehdezp` accepted the council-reviewed W3-derived wording. At the W4 checkpoint, every then-dormant specialist owned one concise `promptSnippet` and exactly one coherent active-only `promptGuidelines` string; registration, APPEND, defaults, and activation remained untouched until the later owner gate.
- **Done:** coordinator-run focused specialist tests pass 2/2 and package typecheck is clean. A fresh Qwen trajectory, given only the `web_search_x` and `web_answer_exa` cards plus two hard scenarios, produced first-attempt-valid calls under the current TypeBox schemas and correctly kept synthesis/structured output unfetched until primary-source verification. Independent Qwen and DeepSeek agents then received the same W4 source-verification task and both returned PASS; neither substituted for the coordinator checks.
- **Budget:** $0.

### W5 — Portfolio-gap probes: Chinese social + video scope — blocked-on-owner

- **Decision it unlocks:** whether first-hand Weibo/WeChat/RedNote/Douyin/Bilibili
  and generic video understanding enter scope or stay recorded gaps.
- **Resume:** goal checkpoint 104 (portfolio gap named); ADR-002.003 video gap;
  adjudication §6.4 (TikHub-style leads).
- **Work:** credential-free landscape survey only; present options + cost shape to
  the owner. A clean no-winner is a valid recorded outcome.
- **Done:** owner decision recorded in an ADR child with confidence/evidence fields.
- **Budget:** $0 survey; any live probe needs explicit approval.

### W6 — Test intent audit (no new static tests) — done

- **Decision it unlocks:** the suite protects deterministic contracts only, and
  never grows toward asserting provider behavior.
- **Resume:** `tests/AGENTS.md` (proof budget); the green 291-test suite;
  "Provider mastery loop" above.
- **Work:** every pre-W2 owning test gained or retained an explicit decision-protected header; no provider-result expectation was found. W6 itself added no tests or assertions. The separately authorized W2 specialist contract proof is not provider-quality validation.
- **Done:** the audit table covers all 27 owners, including the later W2 specialist owner; package suite green; zero assertions added by W6.
- **Budget:** $0.

### W7 — Structured-output hardening trial — done

- **Decision:** reject Pi strict-JSON constrained sampling for the current `web_search` schema.
- **Evidence:** the Phase 4 T07 prompt was rerun on fresh `openai/gpt-5-mini` (`supportsStrictMode: true`). Baseline first emitted a schema-valid/runtime-invalid budget plan; its second shorthand call executed but still produced four derived provider calls and falsely claimed one. Strict mode produced zero calls because OpenAI rejected the non-strict-compatible schema before inference (`additionalProperties: false` absent at the root). See `docs/PHASE4-TESTING-LEARNINGS.md` under “W7 strict-JSON constrained-sampling trial — rejected.”
- **Boundary:** no production code changed. Reopen only after the full public schema satisfies strict-provider requirements; strict JSON cannot enforce the separate runtime budget rule.
- **Budget:** $0 web-provider spend; model trajectory only.

### W8 — Deferred and owner-gated items

- Public specialist activation — **done 2026-08-04**. `alehdezp` accepted all four; `index.ts` registers them with no fallback/default change. The aggregate full-harness policy keeps the everyday four at startup and the specialists lazy-discoverable.
- Query-aware retained passage narrowing remains deferred (2026-08-01; reopen gate in ROADMAP Increment 7).
- APPEND wording evolution remains owner-gated via `op-edit-system-prompt`; activation required no APPEND change because tool-local guidance and the research playbook already own specialist behavior.

### W8a — Evidence-derived provider guidance mastery — done

- **Decision it unlocks:** which provider-specific query, mode, filter, answer-shape, and mutation strategies deserve active tool guidance for hard or narrow research.
- **Resume:** `.tmp/w10-provider-guidance-mastery/MANIFEST.md`; W3 baselines in `.tmp/w3-provider-mastery-20260804/ADJUDICATION.md`.
- **Work:** coordinator executes controlled Exa Search/Answer, xAI/X, and Linkup packets; every promoted rule requires a matched baseline or reproduction across non-overlapping tasks plus primary-source adjudication. Schema-valid examples alone do not qualify.
- **Budget:** consumed `$0.648` conservatively, bringing the program to `$7.804` consumed / `$2.196` remaining. Conditional deep-lite was skipped; no fallback, retry, deep Linkup, model change, or off-manifest call ran.
- **Done:** `.tmp/w10-provider-guidance-mastery/ADJUDICATION.md` records the primary-adjudicated strategy table, exact anti-recipes, and ledger. Unsupported hybrid-superiority guidance was rejected; five registered examples are schema-valid; typecheck, 9/9 focused registration/specialist tests, and the full 304/304 websift suite pass. Fresh cold-start Qwen and DeepSeek trajectories independently produced valid narrowed calls, result-shape branches, and primary-source closure plans from the cards alone.

### W8b — Creative hard-narrowing provider mastery — done

- **Decision it unlocks:** whether exact lexical/semantic/deep bundles, version-sensitive structured Answer, Linkup depth, X date/handle/exclusion narrowing, image understanding, and parallel-tool work controls materially improve hard evidence retrieval.
- **Resume:** `.tmp/w11-creative-provider-narrowing/MANIFEST.md`; prior strategy baseline `.tmp/w10-provider-guidance-mastery/ADJUDICATION.md`.
- **Budget:** consumed `$2.669` conservatively under the `$2.750` packet ceiling, bringing the `$13.00` program to `$10.473` consumed / `$2.527` remaining. Twenty-five exact calls ran; no fallback, retry, or off-manifest spend.
- **Done:** `.tmp/w11-creative-provider-narrowing/ADJUDICATION.md` records primary-adjudicated strategies and anti-recipes. Reproduced improvements: minimal Exa keyword identity; deep-lite as historical candidate expansion but not latest/completeness; candidate-bound Answer only; Linkup standard-first/named-field deep escalation; event-covering X windows; exclusions as noise suppression only; image synthesis as unfetched; serial xAI work for narrow cost/chronology. Five revised examples validate; TypeScript, `git diff --check`, and the full 304/304 websift suite pass; identical fresh Qwen/DeepSeek transfer reviews returned PASS on every tactic and closure boundary.

### W8c — Provider/method decomposition and diversity mastery — done

- **Decision it unlocks:** whether Serper Search, Tavily Search, and Linkup Search each earn a public method tool and which controls provide distinctive decision-changing evidence without automatic routing or a global provider winner.
- **Implementation:** `web_search` is Serper-only with public `query`/`country`; `web_search_exa`/`web_search_x` remain; W12 constrained `web_search_tavily` to basic/general `query`/full-name-`country`; public `web_search_linkup` is removed while `web_answer_linkup` and internal Linkup operations remain. The removed multi-provider `requests[]` contract is superseded history.
- **Resume:** `.tmp/w12-provider-method-mastery/ADJUDICATION.md`, manifest, immutable calls, raw results, and direct primary evidence.
- **Budget:** 30 exact calls consumed `$0.328` conservatively. The separate disclosed `$0.010` coordinator incident brings the `$13.00` program to `$10.811` consumed / `$2.189` remaining.
- **Done:** `.tmp/w12-provider-method-mastery/ADJUDICATION.md` records all raw outcomes, primary qualification, retained/removed controls, and the coordinator incident. TypeScript is clean; 20/20 focused tests and 262/262 full websift tests pass; three live-schema examples validate; stale active-surface audits leave `web_search_linkup` only in explicit removal/history text. Absolute-main-checkout cold reviews `11e2577f-10df-4b4` (DeepSeek) and `acf44d78-9f24-4cc` (Qwen) independently passed all four narrowed-tool cases after an earlier isolated DeepSeek review was rejected for reading stale committed bytes.

### W9 — Release readiness gate — ready for owner acceptance

- **Complete:** README/CHANGELOG, ADR 1.5, research guidance, APPEND, and its decision ledger agree on tool-local operating guidance. Clean detached `HEAD` proof passed websift typecheck, 269/269 websift tests covering all nine tools and both commands, and the root installation/resource command with 15 passes, zero failures, and one environment-gated codeweave-pi checkout fixture skipped. The research rollback backup exists and host settings load the aggregate while legacy provider packages remain outside active extension discovery.
- **Remaining:** explicit owner release acceptance.
- **Limit:** the skipped codeweave-pi cloned-checkout/QMD fixture requires `PI_NAV_TEST_PYTHON`; it does not exercise the websift package. The primary checkout still contains unrelated uncommitted work, so release evidence comes from a detached clean committed tree rather than the dirty filesystem.

## Completed (reference only — detail in goal checkpoints and ROADMAP)

All nine provider contracts implemented and exercised; fetch-provider selection
closed (Native default + Tavily host table + explicit Linkup); research-skill
cutover live-verified; setup control center; GCF encoding; tolerant route
normalization; answer envelope boundary; 80+8-cell apprenticeship v2 adjudicated.

## Known stale-plan hygiene (performed 2026-08-04)

`docs/BUILD-PROMPT.md` and `docs/REVIEW-BRIEF.md` were removed: superseded
execution prompts whose phases all closed or were replaced by this plan and
ADR 5.4. All references were repointed here. The deleted benchmark/ directory
must not be reintroduced (goal checkpoint 88).
