---
title: "tooltap release history"
description: "Release history and migration context for tooltap behavior, packaging, and provider compatibility."
tags: [tooltap, changelog, releases]
created: 2026-07-26
updated: 2026-09-17
status: active
owns: "Release history and migration context for tooltap"
audience: contributor
related: [README.md, docs/contract.md]
---

# Changelog

## Unreleased

### Fixed

- Separate native executable activation from baseline prompt contributions through the additive `setActiveToolsWithDeferred` runtime API. Late snippets/guidelines remain in activation results and stay out of earlier system instructions, including on registry refresh and same-model restoration.
- Require cache-safe runtime activation as well as model deferred-tool support before selecting native. Preserve strict gateway fallback on unsupported runtimes.
- Recover full snippets from registered definitions when Pi's metadata list omits them; rejected native activation does not persist enabled permission.

### Changed

- Shipped routing uses capability-gated `gpt-^`, covering Astra and suffix/future GPT variants. Host-owned configuration is not automatically changed.
- Add generated-system-prompt regression coverage alongside the narrower serializer/reminder prefix tests. The first-party compatibility patch covers both the executable bundle and modular SDK; runtime installation remains an explicit maintenance operation.

## [0.6.2] - 2026-08-29

### Added

- Ship `patches/ensure-pi-registered-tool-api.mjs`: an idempotent, fail-closed script that adds the additive `pi.getRegisteredTool(name)` runtime API stock Pi lacks (verified 0.84.3–0.84.4) to the runtime bundle chunk, with a per-version backup. A host fish wrapper runs it on every `pi` launch so Pi upgrades re-apply it automatically.
- Diagnose a missing execution capability at startup and at execution time: `notifyRouteResolution` emits an error naming `pi.getRegisteredTool` and the remedy when the gateway route cannot execute, and the "Registered tool … unavailable for execution" throw appends that cause instead of implying the target tool is broken.

### Changed

- Package 0.6.2 ships the patch script under `files`.

## [0.6.1] - 2026-08-25

### Changed

- Rebase every previously enabled eligible tool into the newly selected provider/API/model epoch's ordinary full-schema tool array, where it stays directly callable for that whole epoch.
- Keep tools enabled after the boundary route-late-bound until the next genuine model switch: native deferred, direct dispatch-only, or strict gateway execution through `tools`.
- Persist versioned epoch identity, baseline, and late state; restore same-model state exactly, rebase different-model state, and migrate names-only v1 state conservatively as late.
- Rewrite historical, duplicate, and compaction guidance by epoch class so baseline tools teach direct calls and only late tools receive route-specific contract refresh.
- Validate complete disjoint v2 snapshots before restoration; malformed newest state preserves recoverable names conservatively, current execution-result metadata cannot manufacture permission, and exact legacy selectors must agree with restored targets.
- Clear baseline names from historical `addedToolNames` classification during context projection so Pi's deferred-tool adapter places newly rebased schemas in ordinary provider `tools[]`; retain late names until the next epoch.
- Freeze the public `tools` declaration by model epoch so gateway enablement cannot change its description, schema, order, or target membership; missing runtime lookup keeps the stable control visible but never promotes the target.
- Present omitted schemas as normal additional tools available on demand, explaining that context economy—not discouragement—is why they are enabled only when useful; preserve all internal policy and route semantics.
- Replace multi-match substring activation with local BM25 intent resolution: exact selectors remain authoritative, curated discovery metadata may enable one decisive winner, and ambiguous or uncurated results return suggestions without mutating permission.
- Replace verbose ordinary-tool manifest rows with one compact name-only line; preserve richer descriptions only for additional tools whose capability must be discovered.
- Let exact host-trusted Pi source provenance use its registered description as the single discovery and fuzzy-enablement authority; retain host `manifestBlurb` overrides for built-in and third-party tools, while untrusted source prose remains suggestion-only.
- Add the `web-stack` group for all ten jeito websift tools, and make `#` autocomplete match substrings while sorting not-enabled groups/tools before already callable entries.
- Make exact markers for already callable tools reference-only on every route; native group markers now request only missing members instead of redundantly teaching `tools` calls for active tools.

### Preserved

- One public `tools` control, route classification, exclusions/collision quarantine, gateway validation and wrapper compatibility, provider observation without replacement, and downgrade-readable v1 enabled-name entries.

## [0.6.0] - 2026-08-24

### Changed

- Replace the public loader-plus-wrapper surface with exactly one public control named `tools`; remove public `search_tools`, `tool_proxy`, aliases, and configurable control names.
- Use one normalized `request` namespace: exact unique tool/group before capability search. Startup collisions invalidate the namespace; late conflicting tools are quarantined.
- Native/direct expose `{ request }` and then accept exact-name calls. Gateway exposes `{ request, arguments? }` with strict two-step enablement and execution.
- Persist route-neutral enabled names in non-model session entries and permit one per-tool contract refresh after compaction/restart.
- Migrate only safe completed legacy loader/wrapper pairs; unmatched, duplicate, target-mismatched, and multi-selector history fails with an explicit diagnostic.
- Preserve cancellation, updates, errors, frozen results, non-text content, TUI density, and observational provider hooks.
- Fail closed when the Pi runtime lacks the registered-tool/dispatch APIs required by direct or gateway routes.

### Removed

- Remove `name` and `proxyName` from current configuration. Historical strings remain only in bounded restoration code and old release notes/ADRs.
- Withdraw the comparative candidate benchmark and its no-go; call/round/token counts are not product adoption gates.

## [0.5.0] - 2026-08-24

### Changed

- Rename the universal model-facing loader from reserved `tool_search` to ordinary `search_tools` and require Pi 0.84.2 or newer.
- Replace provider/API/regex profiles with three readable model groups: `native`, `direct`, and `proxy`. Exact normalized names work across providers, trailing `^` selects a family, and qualified entries express exceptions.
- Keep unknown/conflicting models proxy-safe and gate native membership with Pi's advertised deferred-tool metadata.
- Derive loader descriptions, prompt snippets, activation results, marker messages, and `/tool` context from the selected strategy; native/direct routes contain no proxy schema, name, or instructions.
- Restore saved names into the current route rather than always promoting them into active provider schemas.
- Keep `before_provider_request` observational and retain bounded legacy session migration.
- Reject duplicate native/direct `search_tools` calls without redisplaying schemas and direct the model to call already-loaded exact names; mixed requests continue loading new names.

### Restored with a narrower boundary

- Restore one stable `tool_proxy` only on configured proxy routes. It executes only session-enabled names, validates the registered schema, and optionally performs strict declared-type normalization.
- Restore direct dispatch permission as an evidence-owned strategy, separate from whether active-schema promotion damages cache reuse.
- Native markers now request an ordinary `search_tools` call so Pi can record `addedToolNames`; they do not mutate active schemas outside a loader result.

### Still removed

- Extension-owned client `tool_search` declarations, `_toolSearchOutput`, provider payload rewriting, skeleton injection, dependency patching, and automatic repair scripts remain removed.

### Evidence boundary

- Matched live controls found stable proxy execution substantially preserved cache relative to ordinary active promotion on opencode-go Muse/Ox and cline-pass Qwen/Kimi. That result rejects promotion, not free-form callability: DeepSeek and owner-proven Ox classify direct; Kimi, Muse, and Qwen remain proxy defaults; Kimi-native deferral remains capability-gated.
## [0.4.2] - 2026-07-09

### GPT-5.4/5.5/5.6 client tool search
- Replace Pi's ordinary `tool_search` function schema with one OpenAI client-executed declaration instead of sending duplicate tool forms.
- Enforce the documented `tool_search_call` → `tool_search_output` contract, including exact `call_id` pairing, structured loaded schemas, replay persistence, and `defer_loading: true`.
- Limit native activation to configured GPT-5.4, GPT-5.5, and GPT-5.6 Responses payloads; unsupported models keep the local fallback.
- Prevent duplicate searches from re-emitting loaded schemas, and restore loaded dispatch state when resuming a session.
- Remove the synthetic post-load cache completion. Diagnostics now record stable request hashes and normal response cache usage passively.
- Make exact-name searches return only the explicitly named schemas; relevance-filter fuzzy searches to at most three tools to prevent accidental context bloat.
- Correct passive diagnostics for `openai-codex-responses` and log native declaration, replayed call/output, loaded-schema, and dispatch counts.
- Update the Pi 0.80.5 patch anchors and add an idempotent protocol contract harness.

### Cross-model cache and token verification
- Keep the function-form `tool_search` description immutable on skeleton/dispatch paths; live testing had exposed a cross-turn `toolsHash` change when an executed hidden tool was reclassified as active.
- Treat GLM/KiMi/MiMo skeletons as deliberate shape-only schemas: retain parameter structure needed for direct calls while stripping prose-heavy metadata.
- Add cross-family regression coverage for GLM, KiMi, and MiMo payloads, real hidden dispatch activation, and stable post-activation tool schemas.
- Add passive byte/token-estimate diagnostics for top-level tools, skeletons, and a hypothetical full-hidden baseline.
- Live-verify GPT-5.4/5.5/5.6, GLM-5.2, MiMo-2.5, and DeepSeek V4 Pro execution plus provider cache reads; record Gemini as partial and KiMi provider blockers without overstating either route.

## [0.4.1] - 2026-07-02

### Packaging
- Rename package `pi-tool-curator` → **`tooltap`**. The new name matches the real purpose: making the model act like a better model by stowing most tools out of the default view (not removing them), so its tool surface stays lean, clear, and correctly ordered. Hidden tools remain callable by exact name.
- Rename bin `pi-tool-curator-patch` → `tooltap-patch`.
- Rewrite `description` and README lead around the user benefit (cleaner tool surface, better tool choice, lower context use) rather than a feature list.
- Refresh keywords to surface the salience/context-hygiene framing (`tool-precedence`, `tool-salience`, `tool-triage`, `context-hygiene`, `model-attention`).

## [0.4.0] - 2026-07-02

### Packaging
- Rename package to `pi-tool-curator` to reflect the actual goal: curating Pi's tool surface by slimming default context, filtering/blocking tools, overriding tool wording, and enabling hidden dynamic dispatch/OpenAI deferred schemas only when needed.
- Ship the required local Pi dynamic-dispatch patch in `patches/` and expose `npm run patch:apply` plus `pi-tool-curator-patch`.
- Add MIT `LICENSE`, publishable fixture path, current `@earendil-works/pi-coding-agent` peer/dev dependency, direct `typebox` runtime dependency, and package-contained verification files.

## [0.3.7] - 2026-07-02

### Polish
- Add local npm scripts for typecheck, fixture-backed harness testing, patch re-application, dry-run packing, and full verification.
- Document the dynamic-dispatch Pi patch as a required local invariant, not removable cleanup.
- Clarify direct hidden-tool calls versus the preferred `tool_search` enablement path.

## [0.3.6] - 2026-04-24

### Bug Fixes
- Clear footer status when `toolSearch.showToolSearchFooterStatus` is `false`, and re-read setting each refresh so settings changes take effect without stale status.
- Add explicit `showToolSearchFooterStatus` config name with backward compatibility for older status keys.

## [0.3.5] - 2026-04-23

### Other
- Add `pi install npm:pi-tool-search` command to README

## [0.3.4] - 2026-04-23

### Other
- Clarify core defaults and token-saving purpose

## [0.3.3] - 2026-04-23

### Bug Fixes
- Refresh active tools on every `turn_start`, not only fresh user prompts, so unlocked tools stay available during agent-loop continuations
- Queue hidden steer hint after successful `tool_search` so agent can continue/retry without waiting for another user message
- Stop showing visible retry guidance in `tool_search` results and narrow hidden retry hint so successful same-turn tool calls are not repeated

### Other
- Document same-response activation caveat and recovery behavior in `README.md`

## [0.3.2] - 2026-04-23

### Bug Fixes
- Split `tool_search` description into "Already active" and "Hidden" sections so LLM skips redundant enable calls
- Add `grep` and `find` to default core tools (always enabled alongside `read`, `write`, `edit`, `bash`)

## [0.3.1] - 2026-04-23

### Other
- Add repository field to package.json

## 0.3.0

- Renamed from `pi-lazy-tools` to `pi-tool-search`
- Config key changed: `lazyTools` → `toolSearch` in `settings.json`
- `showStatus` config option: show/hide `N / total tools` footer status (default: on)
- Provider-agnostic: removed payload-level filtering, relies solely on `setActiveTools`
- `readUserConfig()` consolidates all settings reads into one call

## 0.2.0

- User config: add `"toolSearch": { "alwaysEnabled": ["lsp", "grep"] }` to `settings.json` to pre-unlock tools beyond the defaults
- Reads config at each `session_start` — no reinstall needed after changes

## 0.1.0

- Initial release
- Manifest-aware `tool_search` gate
- `names: string[]` batch enabling
- Per-turn manifest refresh via `before_agent_start`
