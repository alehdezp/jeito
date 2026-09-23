---
title: "Phase 4 testing learnings — schema-usability experiment harness"
description: "Harness guidance and measured schema-usability results, including the rejected strict-JSON constrained-sampling trial."
tags: [jeito-websift, testing, harness, schema-usability, constrained-sampling, phase-4]
created: 2026-07-29
updated: 2026-08-04
status: active
---

# Phase 4 testing learnings

## Harness recipe (what worked)

**Isolated config.** Throwaway `PI_CODING_AGENT_DIR` with only model auth + catalog:

```bash
cp ~/.pi/agent/auth.json ~/.pi/agent/models.json ~/.pi/agent/models-store.json "$ISO"/
printf '{"enabledModels":["<provider>/<model>"],"quietStartup":true}\n' > "$ISO/settings.json"
```

No `web.yaml` in `$ISO` → `loadConfig()` falls back to `DEFAULT_CONFIG`. Scrub web-provider env
vars (`EXA_API_KEY`, `TAVILY_API_KEY`, …) in the child. Model auth comes from `auth.json`
(Codex OAuth); env `OPENAI_API_KEY` alone is NOT sufficient for `openai-codex`.

**Fake adapters.** `credentials: []` makes them unconditionally eligible regardless of env.
Return a small realistic result set (3 leads), not a single lead — a single lead triggers the
production `low_yield` warning, which drives the model to over-search and confounds the
per-trajectory first-attempt observation.

**Marker technique.** Distinctive tokens as the search subject:
- `ZZFAILZZ` in a query → adapter throws `ProviderError("network")` (deterministic failure).
- `ZZDUPZZ` in a query → both providers return canonical-equivalent URLs (differ only in
  `utm_*` params + fragment) with distinct titles, exercising `canonicalSearchUrl` dedup.

**Invocation.**

```bash
PI_CODING_AGENT_DIR=$ISO PHASE4_JSONL=$OUT.jsonl PHASE4_SCHEMA=schema.json \
pi -p "$PROMPT" --provider <prov> --model <model> --thinking medium \
  --session-id "unique-per-trajectory" \
  -ne -e /path/to/extension.mjs --tools web_search \
  --no-context-files --no-skills --no-prompt-templates --no-themes \
  --mode json > $OUT.json
```

`-ne -e` loads only the temp extension. `--tools web_search` allowlists it (disables built-ins
and package tools). `--no-context-files/skills` stops AGENTS.md/skill guidance from biasing
construction — the schema descriptions must carry construction alone.

**Capture.** The harness wraps `pi.registerTool` to write `tool.parameters` (the exact
registered TypeBox schema) to `PHASE4_SCHEMA`, and log `{toolCallId, params, contentText,
details}` per execute to `PHASE4_JSONL`. The `--mode json` stream carries
`tool_execution_start.args` (the model's raw emitted args, including calls pi rejects before
execute) and `message_end` (final interpretation + token usage).

**Parser.** `Check(schema, args)` from `typebox/value` on each `tool_execution_start.args`
gives first-attempt schema validity. Correlate with JSONL by `toolCallId` for execution detail.
A call in the json stream but absent from JSONL was rejected by pi before execute.

## Key learnings

1. **macOS has no `timeout`.** Use pi's `--retry-stall-timeout-ms` (default 90 s).
2. **Model auth is in `auth.json`, not env** for Codex OAuth providers. A bare isolated dir
   fails with "No API key found."
3. **Single-lead fakes cause over-searching** via the `low_yield` warning. Return ≥3 leads.
4. **Do not reveal the JSON shape in prompts.** Name providers naturally; never show the
   expected `requests[]` structure.
5. **First-attempt validity is the primary datum.** Record the first `web_search` attempt
   before any repair; later calls are secondary (repair quality, over-searching).
6. **Description clarifications do not always change behavior.** The route-required note
   accurately documents the contract but did not stop minimax-m3 emitting `route:{}`
   reproducibly. Some gaps need schema-structure changes, not description fixes.
7. **Undocumented runtime constraints cause silent first-attempt failures.** `kind:news +
   topic:finance` had no schema signal; a one-line description note fixed it. Audit
   runtime-only rejections for missing schema signals.
8. **Budget subtleties self-repair well.** `fallback:true` inflating worst-case beyond
   `maxFanOut` was rejected and the model repaired + articulated the reasoning.
9. **Non-determinism is real.** Same prompt → different call counts across runs. A failure
   reproducible in ≥3 runs is strong evidence; a single-run anomaly is not.
10. **Token usage is directly observable** in `message_end.usage`. Report it; do not estimate.
11. **Schema version matters in the parser.** The parser reads `./schema.json` from its own
    directory. If the schema changes between experiment runs, copy the parser to the new
    output directory (or point `PHASE4_SCHEMA` at the correct schema) so `Check()` validates
    against the schema the model actually saw.
12. **Run model trajectories foreground, sequentially.** A background pi process can write to
    the checkout on exit (observed: `web-search.ts` reverted mid-session). Before and after
    every model batch, verify `git status --short -- extensions/websift`. If source changes
    unexpectedly, stop and report — do not silently reapply.
13. **Both minimax-m3 and gpt-5.6-sol were tested.** The original directive specified
    `openai-codex/gpt-5.6-sol`; minimax-m3 was user-directed for the initial run. The
    follow-up tested both models. Results are consistent across both.

## W7 strict-JSON constrained-sampling trial — rejected

The Phase 4 T07 prompt was rerun against the current `web_search` schema with fresh `openai/gpt-5-mini`, whose loaded model contract reports `supportsStrictMode: true`. Without constrained sampling, the first call was schema-valid but failed the runtime attempt ceiling. The model's second shorthand call executed, but `derivedCalls: 4` still violated the requested two-call ceiling while the final prose falsely claimed one call; baseline semantic validity was therefore still zero. With `{ type: "json_schema", strict: "prefer" }`, OpenAI rejected the tool before inference because the current public schema is not strict-schema compatible (`additionalProperties: false` is absent at the root). Strict mode changed a model-visible, repairable runtime error into a hard pre-inference error without improving validity.

Do not add `constrainedSampling` to `web_search`. Strict JSON cannot enforce the runtime-only budget rule and currently blocks strict-capable models. The baseline also exposes a separate guidance limit: schema-valid shorthand can violate a natural-language provider-call ceiling unless the call shape itself encodes that ceiling. Revisit strict mode only after the whole public schema satisfies strict-provider requirements and a matched trial shows fewer first-contact failures. Disposable evidence is retained in `.tmp/w7-constrained-sampling/`; DeepSeek runs are not strict evidence because that loaded model lacks `supportsStrictMode`.

## Proved vs. open

**Proved (minimax-m3 + gpt-5.6-sol, deterministic fakes):** billing gates, contributor preservation,
sibling-failure-vs-fallback distinction, leads-vs-fetched discipline, and grouped-output
interpretation (incl. canonical-dedup agreement) are all correctly perceived. Shorthand and
most advanced scenarios are intuitively constructible. The empty `route:{}` failure is resolved
by option (a) (default-auto route); both models now construct explicit exa/tavily routes and
`route:{}` correctly on the first attempt.

**Open:** comparative provider quality; additional target models; live provider behavior.
