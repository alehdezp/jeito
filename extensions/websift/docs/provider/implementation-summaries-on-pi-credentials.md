---
title: "Implementation plan: web_fetch LLM summaries on the user's current Pi credentials (subscriptions + API keys)"
description: "How to make web_fetch llm_rich summaries run on whichever providers the user already has authenticated in Pi — ChatGPT/Codex subscription OAuth, other subscription OAuth, or API keys — instead of the hardcoded deepseek-only chain. Config-driven candidate list, zero new credential machinery."
tags: [llm-summarizer, implementation-plan, pi-credentials, subscription-auth, web-yaml, config-driven]
created: 2026-08-05
updated: 2026-08-05
status: draft
related: [llm-summarizer-gpt56-luna-codex-eval.md, per-section-prompt-round3.md, src/llm-rich.ts, src/config.ts, src/fetch-summary-jobs.ts, src/tools/web-fetch.ts]
---

# Implementation plan: summaries on the user's current Pi credentials

Goal: `web_fetch` `llm_rich` summaries use models authenticated by whatever the user
ALREADY has in Pi — subscription OAuth (ChatGPT/Codex, Claude Pro/Max, Copilot, xAI…)
or API keys — instead of the hardcoded deepseek-only chain. No new credential
machinery: Pi's `auth.json` already stores both kinds and `ModelRuntime` already
resolves both.

Companion evidence: benchmark results and model/route behavior in
`llm-summarizer-gpt56-luna-codex-eval.md`; the saved per-section prompt template in
`per-section-prompt-round3.md`.

## Why this is a small change (current wiring)

The summarizer already runs on Pi credentials — what is hardcoded is only the
*candidate list*, not the auth mechanism:

- `src/llm-rich.ts::LLM_MODEL_PRIORITY` — the only place the model chain is defined:
  `opencode-go/deepseek-v4-flash` → `commandcode/deepseek/deepseek-v4-flash` →
  `deepseek/deepseek-v4-flash`.
- `src/llm-rich.ts::createLiveSummarizer()` builds `ModelRuntime.create({ authPath:
  ~/.pi/agent/auth.json, allowModelNetwork: false })`, then for each candidate:
  `getModel(provider, model)` → `checkAuth(provider)` → `completeSimple(...)`.
  Subscription OAuth and API keys both resolve through this same path (verified:
  `checkAuth("openai-codex")` returns the OAuth profile from auth.json).
- Failover, per-provider 10-min cooldown (`LLM_PROVIDER_COOLDOWN_MS`), and the 15 s
  per-attempt timeout (`LLM_TIMEOUT_MS`) already exist and need no change.
- Tool wiring: `src/tools/web-fetch.ts::registerWebFetch` →
  `createSummaryJobManager(pi)` → default factory `createLiveSummarizer`.
- Observability already exists: every summary output prints
  `Model: <provider>/<model>` (`src/llm-rich.ts::llmRichText`).
- `doctor.ts` currently has no summarizer reporting (checked 2026-08-05).

So: replace one hardcoded constant with a config-driven list; everything downstream
(failover, cooldown, timeout, caching, validation via `validateResearchBrief`) is
untouched.

## Design

### 1. Config surface — `web.yaml` owns it (ADR-002.004)

Per ADR-002.004, non-secret policy lives in `~/.pi/agent/web.yaml`. Add one section:

```yaml
summary:
  models:                                 # ordered candidate chain, first authenticated wins
    - { provider: openai-codex, model: gpt-5.6-luna }   # subscription route example
    - { provider: opencode-go,  model: gpt-5.6-luna }
    - { provider: opencode-go,  model: deepseek-v4-flash }
```

- Absent or malformed → fall back to the current chain (byte-compatible behavior).
- No secrets in this section, ever — auth stays exclusively in Pi's `auth.json`;
  `web.yaml` only names `provider/model` pairs. This keeps the change inside
  ADR-002.004's non-secret policy scope; no `/web-setup` writer changes needed.

### 2. Code changes (4 files)

| File | Change |
|---|---|
| `src/config.ts` | Add `summary: { models: Array<{ provider: string; model: string }> }` to `WebConfig` + `DEFAULT_CONFIG`. Default value = today's `LLM_MODEL_PRIORITY` entries, so unconfigured behavior is unchanged. Validate entries are `{provider, model}` string pairs; drop invalid rows into `warnings`. Config is already mtime-cached by `loadConfig`. |
| `src/llm-rich.ts` | `createLiveSummarizer` reads `loadConfig()` internally (zero signature/wiring change — the mtime cache makes repeated calls cheap) and iterates `config.summary.models` instead of the hardcoded constant. Keep `LLM_MODEL_PRIORITY` exported as the default source. All other behavior (cooldown map, `completeSimple` no-options call, `JEITO_WEB_LLM_RICH_DISABLE`) unchanged. |
| `src/doctor.ts` | Add one bounded status block: configured chain order, and per entry: registered? auth configured? (read-only via `ModelRuntime.hasConfiguredAuth`/`getRegisteredProviderIds` — no network, no secret values). |
| `tests/` | (a) config tests: default when absent, malformed rows ignored + warned; (b) summarizer tests via the existing `createLiveSummarizer(runtimeOverride)` seam with a fake runtime: candidates picked in config order, unauthenticated entries skipped, all-unauthenticated → `undefined`. No network in tests. |

No changes to `fetch-summary-jobs.ts`, `web-fetch.ts`, or the tool schema — the
factory default keeps the same shape.

### 3. Subscription and quota semantics

- **Auth:** `/login`-stored OAuth (any subscription provider) and API keys are both
  `auth.json` entries; `checkAuth` validates either. Nothing to build.
- **Quota exhaustion** (measured 2026-08-05 on `openai-codex`: "Codex error: The
  usage limit has been reached"): surfaces as a provider failure → existing rotation
  to the next chain entry + 10-min provider cooldown. A persistently exhausted
  subscription makes its entry effectively dormant in 10-minute windows; the chain
  keeps working through later entries. If ALL entries fail, the summary job fails
  cleanly and the raw fetch output remains available — summaries never block the
  fetch itself.
- **Timeout:** `LLM_TIMEOUT_MS = 15 s` per attempt stays. Subscription backends were
  not latency-measured (quota blocked); operators putting a subscription route first
  accept its tail behavior, and failover covers it.
- **Reasoning:** calls stay no-options. On `openai-responses` routes this sends
  `reasoning.effort = none`; on `openai-codex-responses` the parameter is omitted
  (backend default) and cannot be forced below `low` through Pi's API surface
  (catalog maps `minimal→low`). Documented limit, not a blocker.
- **Data routing:** the page body is sent to the FIRST authenticated entry in the
  user's configured order. The chain order is therefore a privacy/cost choice the
  operator controls explicitly — say this in `/web-setup` status output.

### 4. Recommended chain composition (from benchmark evidence)

Ship the current chain as the default. For operators configuring explicitly, the
rounds 1–4 evidence supports:

- Subscription route first (zero marginal cash cost) — accepts quota dormancy risk;
- then `opencode-go/gpt-5.6-luna` — best measured on the constrained-summary
  contract (perfect coverage, zero instruction violations, fastest at scale);
- then a deepseek route — cheapest and fast when output stays small; flash tier
  over-generates on section-summary tasks unless output is tightly bounded.

A body-first prompt layout (saved template) additionally makes the dominant input
mass prefix-cache-hot across queries — ~10x cheaper input on DeepSeek — but that is
an independent prompt change; do not bundle it with this config change.

## Alternatives considered

- **Dynamic discovery** (`getRegisteredProviderIds()` + `hasConfiguredAuth()` +
  `getAvailable()` to auto-build the chain from all configured providers): rejected
  for v1 — unpredictable model suitability (image models, tiny models, cost tiers)
  and no operator control over data routing. Revisit only with a suitability filter.
- **Per-call model override in the `web_fetch` schema:** rejected — grows the tool
  surface for an operator-level policy decision.
- **Separate credential store for the summarizer:** rejected — Pi's auth.json is the
  single credential boundary by design; duplicating it violates ADR-002.004.

## Acceptance criteria

1. No `summary` config: behavior byte-identical to today (same chain, same calls).
2. Configured chain with an authenticated subscription route first: summaries
   execute on it — visible in the output's `Model: <provider>/<model>` header.
3. First entry unauthenticated or quota-exhausted: clean failover to the next entry;
   no crash, no blocked fetch.
4. Malformed config rows: ignored with a `warnings` entry, never throw.
5. Tests pass offline (runtimeOverride seam; no live provider calls).
6. `/web-setup` status shows the chain + auth states, names only, never values.

## Out of scope (explicit)

- Changing `promptFor()` layout or prompt content (separate decision, see saved
  template doc).
- The `openai-codex` subscription quota itself — account-level, nothing to fix.
- Multi-model ensembles or per-source model routing.
