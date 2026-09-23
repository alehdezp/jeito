---
title: "web_fetch LLM summarizer: gpt-5.6-luna via ChatGPT subscription vs deepseek-v4-flash"
description: "Evaluation record: whether web_fetch's llm_rich summarizer can run on gpt-5.6-luna via the ChatGPT/Codex subscription (no OpenAI API key), how the route is wired, reasoning-control mechanics, and a no-reasoning speed benchmark against the production deepseek-v4-flash path."
tags: [web-fetch, llm-summarizer, openai-codex, subscription-auth, benchmark, gpt-5.6-luna, deepseek-v4-flash]
created: 2026-08-05
updated: 2026-08-05
status: active
related: [src/llm-rich.ts, src/fetch-summary-jobs.ts]
---

# web_fetch LLM summarizer: gpt-5.6-luna via ChatGPT subscription vs deepseek-v4-flash

Evaluation from 2026-08-05 (pi 0.83.0, jeito websift extension). Question: can the
`web_fetch` `llm_rich` summarizer run on `gpt-5.6-luna` authenticated by the ChatGPT
Plus/Pro subscription instead of an OpenAI API key, and how fast is it without
reasoning compared to the production `deepseek-v4-flash` path? All testing was
throwaway (`.tmp/luna-bench/`); no production code or config was modified.

## How the summarizer picks its model

`extensions/websift/src/llm-rich.ts::LLM_MODEL_PRIORITY` hardcodes the candidate chain:
`opencode-go/deepseek-v4-flash` → `commandcode/deepseek/deepseek-v4-flash` →
`deepseek/deepseek-v4-flash`. `createLiveSummarizer()` resolves each candidate via
`ModelRuntime.getModel(provider, model)` + `checkAuth`, then calls
`runtime.completeSimple(model, context)` with **no options** per summary. Constraints
that any replacement model must fit:

- `LLM_TIMEOUT_MS = 15_000` — a summary attempt that exceeds 15 s aborts and rotates
  providers. Median latency below is fine; worst-case tails matter.
- `LLM_PROVIDER_COOLDOWN_MS = 10 min` per provider after a failure — a quota error on
  one provider does not poison the others, but repeated quota errors make the codex
  entry effectively dead for 10-minute windows.
- `JEITO_WEB_LLM_RICH_DISABLE=1` disables the feature entirely.
- Test seam: `createLiveSummarizer(runtimeOverride)` accepts an injected runtime;
  this is how the benchmark drove specific models without touching the priority list.

Switching production means editing `LLM_MODEL_PRIORITY` (nothing else), but see the
quota blocker in the benchmark section first.

## Subscription auth: how it works and that it is already wired up

Pi officially supports subscription providers via OAuth (no API key):

- `/login` in interactive mode → select **ChatGPT Plus/Pro (Codex)** → OAuth tokens
  stored in `~/.pi/agent/auth.json`, auto-refreshed. Requires ChatGPT Plus or Pro;
  officially endorsed by OpenAI ("Codex for OSS").
- Credential resolution order: CLI `--api-key` flag → `auth.json` entry (API key or
  OAuth token) → environment variable → custom provider keys from `models.json`.
- Headless/SSH note: browser OAuth is the default; device-code login for the Codex
  provider shipped in pi 0.77.0.

Sources: <https://pi.dev/docs/latest/providers> (fetched 2026-08-05, Subscriptions /
OpenAI Codex / Auth File / Resolution Order sections) and the version-matched local
copy `docs/providers.md` of the installed pi 0.83.0 package. Device-code fact is from
<https://github.com/earendil-works/pi/issues/3424> (final comment: shipped in 0.77.0).

**This machine was already set up** — nothing had to be installed:

- `~/.pi/agent/auth.json` contains an `openai-codex` OAuth profile (verified:
  `checkAuth("openai-codex")` returns `{source: "OAuth", type: "oauth"}`,
  `isUsingOAuth("openai-codex")` is true).
- `~/.pi/agent/models.json` already overrides `openai-codex/gpt-5.6-luna`
  (contextWindow 372000).
- `~/.pi/agent/models-store.json` registers `gpt-5.6-luna` under three providers:
  `openai` (api.openai.com, API key), `opencode-go` (opencode.ai/zen/go/v1, labeled
  "2x usage"), and `openai-codex` (`api: openai-codex-responses`, baseUrl
  `https://chatgpt.com/backend-api` — the subscription endpoint).

## Reasoning control: what "without reasoning" actually sends

Determined from the installed pi-ai bundled with pi 0.83.0, and confirmed empirically
by inspecting `thinking` blocks + `usage.reasoning` tokens in benchmark output:

- `completeSimple` accepts `reasoning?: ThinkingLevel` where `ThinkingLevel =
  "minimal" | "low" | "medium" | "high" | "xhigh" | "max"` ("off" exists only as an
  internal level in `EXTENDED_THINKING_LEVELS`).
- **openai-responses API** (luna via `openai`/`opencode-go`): with no reasoning
  option, the request sends `reasoning: { effort: thinkingLevelMap.off ?? "none" }`
  → effort **none**. Verified: production-shape runs showed 0 thinking characters.
- **openai-codex-responses API** (subscription route): with no reasoning option,
  `body.reasoning` is **omitted entirely** → chatgpt.com backend default applies.
  Passing `reasoning: "minimal"` maps through the model's `thinkingLevelMap` to
  effort `low` (the catalog maps `minimal→low`); `reasoning: "off"` is a no-op on
  this route. So the subscription route cannot currently be forced below "low"
  effort through this API surface.
- **deepseek-v4-flash** (production): no reasoning option → no thinking content
  (verified 0c); `reasoning: "minimal"` produces small thinking blocks (448–802c),
  i.e. minimal *adds* reasoning rather than removing it on this model.

Conclusion for a fair "no reasoning" comparison: use the production call shape (no
options), which is reasoning-off for both the deepseek path and luna via
openai-responses.

## Benchmark: method and results

Throwaway script `.tmp/luna-bench/bench.mjs` (2026-08-05, n=3 per cell, sequential,
same ~4k-token source page — the cached pi.dev providers doc — and a trimmed version
of the production research-brief prompt). Full data: `.tmp/luna-bench/results.json`,
outputs in `.tmp/luna-bench/out/`. Re-run after editing nothing:
`node .tmp/luna-bench/bench.mjs` from the monorepo root.

| Candidate | Config | n | Median | Range | Thinking output |
|---|---|---|---|---|---|
| gpt-5.6-luna @ openai-codex (subscription) | production shape | 3 | — | 920–1475 ms | **empty: "Codex error: The usage limit has been reached"** |
| gpt-5.6-luna @ openai-codex (subscription) | reasoning:minimal | 3 | — | 1024–1171 ms | same quota error |
| gpt-5.6-luna @ opencode-go | production shape (effort none) | 3 | 6621 ms | 5349–7009 ms | 0c |
| gpt-5.6-luna @ opencode-go | reasoning:minimal | 3 | 4665 ms | 4608–5324 ms | 0/569/454c |
| deepseek-v4-flash @ opencode-go (production) | production shape | 3 | 5309 ms | 4911–**12078** ms | 0c |
| deepseek-v4-flash @ opencode-go (production) | reasoning:minimal | 3 | 6106 ms | 4604–6435 ms | 486/802/448c |
| deepseek-v4-flash @ deepseek (direct) | production shape | 3 | 3627 ms | 3552–4048 ms | 0c |
| deepseek-v4-flash @ deepseek (direct) | reasoning:minimal | 3 | 4380 ms | 3654–8866 ms | 2831/403/315c |

### Findings

1. **Subscription route blocker (account, not config).** The `openai-codex` route
   authenticates and reaches the backend, but every call returns the quota error
   `"Codex error: The usage limit has been reached"` with empty content in ~1 s.
   Speed cannot be measured until the plan window resets. Note the failure mode for
   production: the summarizer would treat this as a provider failure, rotate to the
   next `LLM_MODEL_PRIORITY` entry, and put the provider in a 10-minute cooldown —
   safe but pointless while the quota is exhausted.
2. **Speed (no reasoning, production call shape).** Ranking: deepseek direct 3.6 s
   median (3.55–4.05 s, tightest spread of any route) < deepseek via opencode-go
   5.3 s (with the 12.1 s outlier) < luna via opencode-go 6.6 s (calm tail, worst
   7.0 s). The direct deepseek route is ~30% faster at the median than the same
   model through the opencode-go gateway and has no near-timeout tail; all routes
   fit `LLM_TIMEOUT_MS` at this input size.
3. **`reasoning: "minimal"` is not a speed knob here.** On opencode-go/luna it was
   faster (4.7 s) but that run benefited from a warm prefix cache (`cacheRead` 3930
   tokens) — first-call cache-write cost makes cross-config latency comparisons noisy
   at n=3. Do not read the minimal-vs-default gap as a reasoning-cost signal.
4. **Quality (impression, n=1 read each, same page).** Both produced correct,
   well-structured briefs with valid evidence quotes. deepseek was slightly more
   thorough (caught the auth-file `!command`/`$ENV_VAR` mechanics); luna slightly
   better prose. No disqualifying difference at this sample size.
5. **Route matters as much as model.** The same deepseek-v4-flash weights were ~30%
   faster direct (3.6 s) than via the opencode-go gateway (5.3 s), and the 12.1 s
   outlier disappeared. `LLM_MODEL_PRIORITY` currently lists the direct `deepseek`
   provider third; if direct auth stays configured, reordering the chain is a
   free latency win independent of any model change. Direct-route data:
   `.tmp/luna-bench-direct/` (script `.tmp/luna-bench-direct.mjs`, same method).
6. **Scale caveat.** The benchmark used one ~4k-token page. Production input can be
   up to `LLM_INPUT_CHARS = 256 K` chars; latency scales with input, and the 15 s
   timeout becomes the binding constraint for large pages on any model.

## Round 2: large page + per-section summary prompt

Round 1 used a ~4k-token page and a short brief prompt. Round 2 (2026-08-05,
`.tmp/luna-bench2/bench2.mjs`, n=2, production call shape) scales both axes: source
is the cached nodejs.org `fs` API docs sliced to 150 K chars (~4x round 1, with 9
real top-level sections), and the prompt is a large instruction block demanding one
dedicated summary per source section, mirroring the page's own heading structure —
the same shape a raw `web_fetch` section view exposes. Prompt ≈ 151 K chars total.

| Candidate | n | Median | Range | Output | Sections covered | Notes |
|---|---|---|---|---|---|---|
| deepseek-v4-flash @ deepseek (direct) | 2 | — | 6.9 s / **20.9 s** | 3.8 Kc / 12.5 Kc | 6 / **51** | run 1 over-completed: one heading per `fsPromises.*` method, 3031 output tokens, exceeded the 15 s production timeout |
| deepseek-v4-flash @ opencode-go | 2 | 7.9 s | 7.6–8.3 s | 3.0–4.0 Kc | 7 / 9 | most stable; run 2 summarized the 6 in-slice sections and emitted explicit "not in source" disclaimers for the 3 beyond-slice sections |
| gpt-5.6-luna @ opencode-go | 2 | — | 13.6 s / **59.3 s** | ~4.3 Kc | 6 / 6 | summarized only the 6 in-slice sections and said nothing about the 3 beyond-slice ones; `usage.reasoning` 480–516 tokens despite effort none |
| gpt-5.6-luna @ openai-codex (subscription) | 2 | — | ~1 s | empty | — | quota error unchanged |

### Round-2 findings

1. **deepseek-direct is fast but shape-unstable at scale.** One run nailed the shape
   in 6.9 s; the other over-completed into a 51-heading method enumeration (12.5 K
   chars, 3031 output tokens) that took 20.9 s — past `LLM_TIMEOUT_MS`. Same model,
   same prompt, same route: variance is behavioral, not network. opencode-go's
   deepseek showed none of this in the same window.
   **Why the slow scenario (mechanism):** latency ≈ fixed overhead + ~6 ms per
   output token. The 20.9 s run generated 3031 output tokens (the blowout) vs 830
   in the disciplined run, and it also paid uncached prefill of ~37 K input tokens;
   the factors compound. Cache state flips on first use of a prompt: direct
   deepseek's models config enables `supportsLongCacheRetention`, so repeat calls
   read the prefix cache. The one outlier neither factor explains (round 1's 12.1 s
   opencode-go run: cached input, ~430 output tokens) is provider-side variance —
   DeepSeek peak-hour queueing is a plausible but unverified cause.
   **Not "bad" in itself:** the high-information run is the richest fully-grounded
   output and wins any maximum-information-digest task. It is a defect only against
   the bounded-brief contract: production's 15 s timeout would have killed it so it
   delivers nothing there, and identical inputs producing 6 vs 51 sections (the
   round-2 prompt's "level-2 and level-3 headings" literally admits both readings,
   since fs methods are h3) makes the behavior unpredictable to budget against.
2. **deepseek @ opencode-go was the most disciplined, not the most comprehensive.**
   The 150 K-char input slice actually contains only 6 of the page's 9 top-level
   sections (Synchronous API, Common Objects, Notes start at chars ~257 K, ~320 K,
   ~374 K — verified with `.tmp/luna-bench2/accuracy-check.mjs`). Run 2's "9/9
   coverage" was 6 real summaries plus explicit "not included in the provided
   source data" disclaimers for the rest — exactly the prompt's truncation rule.
   That is scope honesty, which is what a source-grounded summarizer must do.
3. **luna @ opencode-go degrades on large summarization tasks.** 2x slower at
   median, a 59.3 s outlier, and both runs silently stopped after the last in-slice
   section without acknowledging the requested sections that were absent from the
   input. The omission is defensible; the silence is not — for `web_fetch`'s
   evidence contract, silent gaps are the worse failure mode than disclaimed ones.
4. **Factual grounding: tie.** Mechanical check extracted every `fs.*` /
   `fsPromises.*` method name from all six non-empty outputs and matched them
   against the input slice: 0 fabricated method names anywhere (42, 12, 13, 11, 15,
   13 mentions per output). At this scale the models differ in scope discipline and
   stability, not hallucination rate. Sentence-level factual accuracy was
   spot-checked, not exhaustively verified.
5. **Timeout headroom:** at 150 K chars input + ~1 K-word structured output only the
   opencode-go routes stayed clearly inside the 15 s production timeout. Direct
   deepseek and luna both produced single runs above it.
6. **Caveat:** n=2, one page. Output-length-sensitive tasks are inherently noisy at
   this sample size; treat route rankings as directional. Data:
   `.tmp/luna-bench2/results.json`, per-run outputs in `.tmp/luna-bench2/out/`.

## Round 3: ground-truth-scored coverage (fixing the round-2 design)

Round 2 had two design flaws, both correctly flagged in review: (1) the prompt
enumerated the section names, so models could pattern-match the leaked list instead
of reading the page; (2) no ground truth was ever measured, so "9 vs 51 sections"
had no right answer. Round 3 (2026-08-05, `.tmp/luna-bench3/bench3.mjs`, n=2,
production call shape) fixes both: the prompt names no sections, pins granularity
explicitly ("one heading per ##/### heading only; never for methods, classes, or
parameters"), and a mechanical scorer compares outputs against the actual headings
in the input slice (proper = matching heading + ≥80-char non-disclaimer body).
Prompt layout was also rebuilt for cache economics: the big stable body (256 K
chars = the production `LLM_INPUT_CHARS` cap, ~71 K tokens) comes FIRST with short
instructions last, so the dominant token mass stays prefix-cache-hot across runs,
queries, and hosts — DeepSeek bills cache reads ~10x cheaper than fresh input.

**Ground truth: the 256 K slice contains exactly 6 ##/### sections** (File system,
Promise example, Callback example, Synchronous example, Promises API, Callback
API). Round 2's "9" and "51" were both wrong; the right answer was 6.

| Candidate | Proper sections | Extra headings | Latency | Cache (run 2) |
|---|---|---|---|---|
| deepseek-v4-flash @ deepseek | 6/6, 6/6 | **125 / 96** (0 invented) | 48.9 s / 41.9 s | 71 296 tokens read |
| deepseek-v4-flash @ opencode-go | **5/6**, 6/6 | 27 / 88 (0 invented) | 21.3 s / 36.5 s | 71 296 tokens read |
| gpt-5.6-luna @ opencode-go | 6/6, 6/6 | **0 / 0** | **7.1 s / 7.5 s** | 67 531 tokens read |

### Round-3 findings

1. **The prompt was the contaminant.** Round 2's "9" was 6 real summaries + 3
   disclaimers pattern-matched from section names leaked in the prompt; the "51"
   was the page's `####` method headings promoted to section headings. Neither
   model was hallucinating — both were responding to an ambiguous, leaky prompt.
2. **With a clean prompt, luna @ opencode-go is the most accurate, most disciplined,
   and fastest.** Both runs: exactly 6/6 proper, zero extra headings, 578–612 output
   tokens, ~7 s. The round-2 verdict ("luna degrades on large summarization") is
   reversed — it was a prompt artifact.
3. **deepseek-v4-flash over-generation is a real behavioral signature, not an
   artifact.** 3 of 3 large-prompt runs (round 2 + round 3, both routes) added
   27–125 below-section headings despite explicit prohibition, producing
   2 372–6 470 output tokens and self-inflicting 21–49 s latency (~6 ms per output
   token). Its coverage is grounded (0 invented names) but its latency problem is
   self-inflicted output bloat — it is only fast when its output stays small, and
   on this task it does not.
4. **Worst single coverage error of any round:** deepseek @ opencode-go run 1
   skipped Callback API entirely — the largest section, 56% of the input body
   (chars 113 K–256 K) — with zero mentions anywhere in its output. Run 2 covered
   it; luna covered it both runs.
5. **Cache economics confirmed.** Body-first stable prefix: run 2 billed 3–29 fresh
   input tokens and read 67 531–71 296 from cache (~10x cheaper on DeepSeek;
   `models.json` already enables `supportsLongCacheRetention` for deepseek).
   **Production implication (recommendation, not implemented):** `promptFor()` in
   `src/llm-rich.ts` puts instructions first, body last, and the per-call
   queryTerms/context near the top — every new query invalidates the prefix, so no
   cross-query cache reuse is possible today. Moving the body to the front (stable
   prefix) with the variable query last would make the dominant token mass
   cache-hit across different queries on the same page.
6. **Revised standing** for the bounded per-section summary contract: luna @
   opencode-go first on accuracy + discipline + latency; deepseek routes are
   grounded but need tighter output constraints to be predictable.
7. **Caveats:** n=2, one page; the scorer is mechanical (heading match + body
   length + disclaimer detection), and summary prose quality was spot-checked, not
   adversarially verified. Data: `.tmp/luna-bench3/results.json`, outputs in
   `.tmp/luna-bench3/out/`.

## Round 4: layout-flip control (was deepseek nerfed by the round-3 layout?)

Hypothesis under test: round 3 put instructions AFTER 71 K tokens of body; if
deepseek follows trailing instructions worse than luna, the layout itself — not the
model — produced the over-generation. Round 4 (2026-08-05,
`.tmp/luna-bench4/bench4.mjs`, n=2) flips to instructions-first / body-last
(production `promptFor()` order), same task, source, and scorer.

| Candidate | Proper | Extra headings | Latency | Output tokens |
|---|---|---|---|---|
| deepseek-v4-flash @ deepseek | 6/6, 6/6 | **96, 96** (0 invented) | 46.3 s / 36.6 s | 6 766 / 5 757 |
| deepseek-v4-flash @ opencode-go | 6/6, 6/6 | **96, 96** (one run +20 invented) | 52.1 s / 36.8 s | 7 783 / 5 125 |
| gpt-5.6-luna @ opencode-go | 6/6, 6/6 | **0, 0** | **7.9 s / 7.6 s** | 658 / 597 |

**Verdict: layout is not the nerf.** Deepseek over-generated almost identically in
both layouts (exactly 96 extra headings in all four round-4 runs — near-deterministic
on this input), and one round-4 run even invented 20 headings that exist nowhere in
the source. Luna stayed clean in both layouts. Also ruled out: hidden reasoning —
deepseek billed 0 reasoning tokens while luna billed 199–277 and still produced the
smallest, most disciplined output.

Remaining asymmetries conceded as real (not test artifacts): (1) **tier mismatch** —
`deepseek-v4-flash` is a flash-tier model against a gpt-5.6 full-tier model; a fair
fight would use `deepseek-v4-pro`; (2) **contract fit** — the scored contract is
constrained extraction, where negative constraints ("do not create headings for
methods") are exactly what flash-tier over-informativeness fails; a
maximum-information contract would rank deepseek's method enumeration as coverage,
not violation. Neither invalidates the measurement; both bound its generalization.

## Verdict

- **Possible:** yes. gpt-5.6-luna on the ChatGPT subscription is a first-class Pi
  route (`openai-codex` provider, `openai-codex-responses` API, OAuth in auth.json)
  and is already registered and authenticated on this machine.
- **Measurable today:** no — the subscription quota is currently exhausted. Re-run
  `.tmp/luna-bench/bench.mjs` after the limit window resets to get real codex-route
  numbers.
- **Strongest measured summarizer (rounds 1–3):** gpt-5.6-luna via `opencode-go` —
  perfect ground-truth coverage, zero instruction violations, fastest at scale.
  Caveat: gateway "2x usage" billing and it is not the subscription route asked
  about. deepseek-v4-flash remains grounded and cheap but over-generates output
  unless tightly constrained.
- **To switch production** (only after codex-route speed is measured): add
  `{ provider: "openai-codex", model: "gpt-5.6-luna" }` at the desired position in
  `LLM_MODEL_PRIORITY` in `extensions/websift/src/llm-rich.ts`. Nothing else changes;
  failover and cooldown already handle quota errors.

## Unresolved

- Actual codex-route latency and quota consumption per summary (blocked by limit).
- Whether chatgpt.com/backend-api honors a below-"low" reasoning effort at all; the
  pi catalog maps `minimal→low` and provides no `off` on this API.
- Behavior of subscription quota under summary-cache misses on large (100k+ char)
  pages.
