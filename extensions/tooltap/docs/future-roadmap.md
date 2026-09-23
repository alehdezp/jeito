---
title: "tooltap architecture implementation roadmap"
description: "Historical provider-routing roadmap superseded by the Pi-native migration plan and ADR-0009."
tags: [tooltap, roadmap, provider-routing, verification]
created: 2026-07-26
updated: 2026-08-23
status: stale
owns: "Architecture roadmap and deferred work tracker for tooltap"
audience: contributor
related: [contract.md, research-findings-2026-07-10.md]
---

# Architecture implementation roadmap

> **Historical:** this roadmap is closed and superseded by ADR-0009 and `.pi/goals/migrate-tooltap-to-native-dynamic-loading/plan.md`.

Status: implementation tracker grounded in [`research-findings-2026-07-10.md`](./research-findings-2026-07-10.md). The binding behavior is [`contract.md`](./contract.md); incomplete live gates remain explicit below.

## Objective

Optimize the combined outcome, in this order:

1. Correct tool selection and valid execution.
2. Stable provider prefix and reproducible session replay.
3. Low first-use latency and few model round trips.
4. Low provider input/context overhead.
5. A small, understandable extension and `tool.yaml` surface.

Token reduction alone does not justify a proxy round or weaker calls.

## Foundations to preserve

Do not redesign working foundations while adding the roadmap:

- GPT client `tool_search_call`/`tool_search_output` conversion, exact `call_id` pairing, duplicate-search guard, and session dispatch restore.
- Stable top-level tool ordering and passive hash/cache telemetry.
- Pi dynamic dispatch and its idempotent patch harness.
- Current blocked/excluded precedence and human-readable `tool.yaml` overrides.
- Shape-direct live evidence for GLM/MiMo and route-specific text-direct evidence for DeepSeek/Gemini.
- No synthetic cache warming, fuzzy model-family guessing, or payload logging that exposes secrets.

Remove dead code only after its replacement passes the same contract and live evidence.

## Policy vocabulary

```yaml
policy:
  core: []   # always direct, full schema
  startup: []      # operator-selected direct tools
  explicitOnly: []         # zero individual metadata; exact marker/group only
  excluded: []        # absent and impossible to activate

groups:
  project-navigation:
    description: Code topology, relationships, documentation, and changes.
    tools: [explore, code_context, trace, docs, diff]
```

Rules:

- Unclassified non-active tools are discoverable by default.
- A discoverable group may contain `explicitOnly` members; only the group capability is visible initially.
- `excluded` wins over individual and group activation.
- `core` is the non-negotiable minimal execution core selected by the operator/distribution.
- `startup` adds operator-preferred first-class tools; it never replaces or subtracts the core.
- Legacy `active` migrates into the union rather than silently overriding both lists.
- Groups are activation ergonomics, not a reason to load every group member during unrelated searches.

Markers:

- `##tool-name`: exact tool activation.
- `#group-name`: exact group activation.
- Marker parsing runs after skill expansion and before provider request construction.

## Provider strategy table

Strategy selection must use exact provider + API + model capability entries, not model-name substring guesses.

| Strategy | Initial hidden surface | Activation | Execution |
|---|---|---|---|
| `openai-client-search` | compact client search catalog | normal `tool_search_output`; explicit markers use public `additional_tools` or a Codex-compatible completed search pair | direct function |
| `proxy-default` (merges `shape-direct` + `explicit-proxy`, 2026-07-31) | frozen bare-skeleton subset for frequent tools; one stable proxy for the rest | subset: direct first call auto-enables dispatch; rest: exact marker/group/`tool_search` supplies contract | subset: direct function; rest: proxy validates and invokes underlying tool |
| `text-direct` | discovery catalog only | selected usage contract | undeclared direct function through Pi dispatch — capability-gated to any verified free-form model (DeepSeek V4 Pro, Gemini 3 Flash, future); never proxied |
| `static-only` | core/always tools only | rejected | unavailable |

Initial route proposal:

- `openai-codex / openai-responses / gpt-5.4|5.5|5.6-*`: `openai-client-search`.
- `zai / openai-completions / glm-5.2`: `shape-direct` for discoverable tools.
- `xiaomi-token-plan-ams / openai-completions / mimo-v2.5*`: `shape-direct` for discoverable tools.
- `deepseek / openai-completions / deepseek-v4-pro`: `text-direct`, retaining its exact live regression test.
- `google / google-generative-ai / gemini-3-flash-preview`: `text-direct`, retaining its known selection-quality caveat and live regression test.
- KiMi routes: keep existing shape fallback until live verification; do not generalize from the model name across providers.
- Unknown routes: `static-only` unless explicitly configured experimental.

## Final architecture

```text
frozen session config + registered Pi inventory
                    │
        policy/group/marker resolver
                    │
       exact provider capability adapter
       ├─ GPT Responses → client search / API-specific explicit item → direct call
       ├─ GLM/KiMi/MiMo, Qwen, MiniMax, … → proxy-default:
       │     frozen skeleton subset → direct call; every other hidden tool → tool_proxy
       ├─ verified free-form (DeepSeek/Gemini/future) → text contract → direct dispatch
       └─ unknown route → static-only rejection
                    │
       canonical session evidence + telemetry
```

The resolver owns selection and policy; provider adapters own representation. No adapter may silently reinterpret `excluded`, invent groups, or mutate another adapter's historical items.

## Activation state and precedence

Use a small explicit state model:

- `startup-direct`: core/always-enabled, full native schema.
- `discoverable`: visible through the route's catalog or skeleton surface.
- `enabled-direct`: loaded through GPT search/additional item or text-direct dispatch.
- `enabled-proxy`: explicitly activated `explicitOnly` tool on a schema-constrained route.
- `never`: rejected everywhere.

Precedence is deterministic:

```text
excluded > startup-direct > already enabled > requested/group member > unknown
```

One shared resolver must return ordered `enabled`, `already`, `blocked`, `excluded`, and `unknown` lists. Provider adapters consume that result; they do not redo policy decisions.

Direct calls to a disabled name are handled by strategy:

- shape-direct: auto-enable dispatch because the stable skeleton already authorized the provider call;
- verified text-direct: execute only when an earlier contract/marker enabled the exact name;
- proxy: reject unless proxy-enabled;
- GPT: reject unless a historical search/additional item loaded it;
- unknown/static route: reject.

## GPT design

### Agent-selected discovery

Keep the verified client protocol:

```text
tool_search_call
→ trusted policy/group resolver
→ tool_search_output with exact same call_id
→ direct loaded function call
```

The initial top-level tool list remains stable and contains no hidden function definitions.

### Explicit marker/group activation

Implemented design:

```text
##tool or #group
→ policy/group resolver
→ public OpenAI Responses: one additional_tools item at the current tail
→ ChatGPT Codex Responses: one completed client tool_search call/output pair
→ direct selected function calls
```

Required invariants:

- Pi preserves the API-specific item form and never merges it into top-level `tools[]`.
- Session replay retains the item at the same historical position.
- Duplicate marker activation does not append another definition.
- Resumed and forked sessions restore dispatch state from historical items.
- Live Pi tests must prove immediate/later callability, stable top-level hash, and cache reads.

These invariants now pass on GPT-5.6 Luna low thinking for exact activation, group activation, saved-session resume, and fork. The Codex backend distinction was discovered live: it rejects public `additional_tools` with a missing-role validation error, while the equivalent client-search pair succeeds.

## GLM/MiMo discoverable-tool design

Keep one-step direct skeleton calls. Improve the skeleton representation:

1. Put the concise description on the matching function skeleton instead of duplicating every description in `tool_search` prose.
2. Recursively preserve only callable structure:
   - `type`
   - `properties`
   - `required`
   - `items`
   - `enum`
   - unions/alternatives only when the provider accepts them
3. Strip descriptions, examples, defaults, formatting guidance, prompt snippets, and long constraints from parameter schemas.
4. Canonically sort and serialize tools once per session.
5. Build the skeleton set from the frozen startup inventory, never mutable dispatch state.
6. Auto-enable dispatch on direct `tool_execution_start` before agent preparation.

Do not remove parameter shapes or replace them with open objects. GLM produced empty or mistyped arguments in those probes.

Amended 2026-07-31 ([adr/0003](./adr/0003-hidden-tool-activation-routing.md), [adr/0004](./adr/0004-skeleton-shape-only-schemas.md)): keep one-step direct skeleton calls **for a frozen subset of frequent tools**; route **every other** hidden tool through `tool_proxy` (the proxy-default route). The subset stays skeletonized precisely because the gateway round-trip below hurts *frequent* tools; non-frequent tools accept the hop in exchange for removing their upfront shape cost. Skeleton entries derive from the frozen startup set, so `tools[]` stays byte-stable ([adr/0001](./adr/0001-top-level-tools-byte-stability.md)). The "do not gateway all" warning below is superseded for the non-subset tools but still governs the frequent subset.

Do not replace all discoverable skeletons with a gateway at the current scale. The measured ~3.1K context reduction added another model round and approximately doubled GLM first-use latency.

## `explicitOnly` on schema-constrained providers

A direct parameterized GLM/MiMo function cannot be both absent initially and callable later without changing `tools[]`. Use an explicit-only proxy:

```text
##tool or #group
→ append selected compact usage contract
→ mark exact names proxy-enabled
→ model calls stable tool_proxy
→ validate against real schema
→ invoke underlying tool
```

Because the user/skill already selected the tool, no `tool_search` round is needed.

Proxy requirements:

- Reject names not enabled in the session.
- Reject `excluded` and recursive proxy/search calls.
- Validate against the underlying full schema before execution.
- Preserve `AbortSignal`, `onUpdate`, tool context, text/image/file content, errors, and structured details.
- Attribute logs and rendering to the underlying tool.
- Persist enough details to restore proxy-enabled names on replay.

If these requirements cannot be met cleanly, `explicitOnly` must be unsupported on that route rather than silently exposed as a skeleton.

## Groups

Start with a small operator-authored map. Do not infer groups automatically.

Recommended initial groups from the measured inventory:

- `skills`
- `pi-runtime`
- `web-research`
- `library-docs`
- `orchestration`
- `project-navigation`

Discovery behavior:

- Keep individual names + concise descriptions for normal discoverable tools where selection quality matters.
- Show group names/descriptions as an additional activation option.
- Do not replace individual descriptions with group-only discovery: GLM selection dropped from 20/20 to 15/20 in the controlled benchmark.
- Group activation deduplicates in configured order and reports blocked/excluded members.

## Context composition and deduplication

Schema and guidance are separate artifacts:

- Provider definitions carry only what is needed for a valid function call.
- Activation context carries extension-only usage guidance, limitations, and relationships.
- Do not paste a full JSON schema into guidance when the provider already received that same schema.
- For shape-direct routes, avoid listing every hidden description both in `tool_search` prose and on the individual skeleton; attach the concise description to the function that uses it.
- For GPT search/additional items, send the full selected definition once and append only non-schema guidance if required.
- For proxy-only activation, send one compact recursive schema because the underlying function is absent from provider tools.
- A `tool_search` result should carry the needed contract itself; do not also enqueue an equivalent hidden follow-up message.

Activation context is canonical and appended once. Duplicate activation appends nothing.

- No-parameter tools may drop empty-schema boilerplate from enablement
  contracts (`"properties":{}` → a "no parameters" line); promptGuidelines are
  never stripped (ADR-006, ADR-008). Agreed 2026-08-02; not yet implemented.

## Session/cache invariants

The extension can guarantee structure, not provider cache hit rates.

For every strategy:

1. Freeze config and inventory at `session_start`.
2. Keep top-level tool order and serialized definitions byte-stable for the session.
3. Never rewrite descriptions based on mutable unlocked/dispatch state.
4. Append activation context only; never edit earlier history.
5. Preserve historical search outputs/additional items exactly during replay.
6. Never unload by deleting historical definitions.
7. Canonically order group expansion and activated definitions.
8. Record hashes without logging secrets or complete sensitive payloads.

## Observability

Keep one JSONL event per provider request/turn with:

- provider, API, model, chosen strategy;
- session hash;
- top-level tools hash/count/bytes;
- discovery catalog bytes;
- skeleton bytes and property count;
- search/additional/proxy item counts;
- activated names/groups;
- input, cache read/write, output, total tokens;
- diagnostics for duplicate activation, unsupported route, validation failure, and scope drift.

No synthetic cache-warming requests.

## Minimality and non-goals

- No expansion budgets: they are unpredictable and add policy machinery without proving better calls.
- No automatic group inference, dependency graph, unloading timer, or profile engine in the first implementation.
- No command palette or new `/tools` UI. Keep `/tool` only for compatibility until `##tool`/`#group` markers are proven, then decide whether to deprecate it.
- Profiles remain optional future aliases over policy/groups; they must not become another execution layer.
- No universal proxy and no universal skeleton. Use the smallest proven adapter for each exact route.
- No group-only catalog when individual selection quality requires descriptions.
- No duplicated schema in both provider tools and conversation prose.

## Configuration and migration

- Parse legacy `active`, `blocked`, `hidden`, `neverSuggest`, `noDiscover`, `neverInject`, and `neverEnable` fields during migration; old blocked fields migrate to `excluded`.
- Write/document the canonical vocabulary: `core`, `startup`, `unlisted`, `explicitOnly`, `excluded`, `order`, and `groups`.
- Keep `unlisted` distinct from `explicitOnly`: the former hides suggestions but permits exact agent/user selection; the latter contributes zero individual metadata and requires explicit marker/group activation.
- Freeze the resolved config, inventory, group expansion, route strategy, and serialization order at `session_start`. File changes apply to the next session and should produce one concise notice rather than mutating the current cache epoch.
- Version the config shape and emit actionable validation errors for unknown tools, duplicate group members, cycles/recursive groups, and conflicting policy.

## Patch and upgrade durability

- Keep Pi core patches minimal, version-anchored, idempotent, and covered by a standalone contract harness.
- Detect upstream native support before patching; do not patch functionality Pi already provides.
- After every Pi upgrade: apply twice, run conversion/replay tests, run one live smoke, and require `/reload` before claiming readiness.
- Fail closed when a patch anchor or replay marker is missing. Do not silently fall back to cache-breaking top-level injection.

## Roadmap status and dependencies

| Phase | Status | Depends on |
|---|---|---|
| 0. Evidence/docs | complete | — |
| 1. Skeleton quality/context dedup | implemented and live-verified on GLM/MiMo | phase 0 |
| 2. Policy/groups/markers/config epoch | implemented; unit + live marker/group pass | phase 1 stable serialization |
| 3. GPT explicit adapter | implemented; GPT-5.6 Luna exact/group/resume/fork/cache live pass | phase 2 resolver + Pi replay patch |
| 4. Explicit proxy → proxy-default route | core implemented; GLM/MiMo live pass; `tool_search` proxy-enables regular tools on explicit-proxy (2026-07-29, Qwen-verified). **2026-07-31:** decided to merge shape-direct + explicit-proxy into one proxy-default route (frozen skeleton subset + proxy for the rest); pending live verification | phase 2 resolver + execution forwarding patch |
| 4b. Skeleton subset on proxy-default (#9) | **implemented 2026-07-31** — config-gated `policy.bareSchema`; frozen shape-only skeleton in `tools[]`, direct dispatch, full contract on first use, rest proxied; gauntlet-proven 46/46 (byte-stable). Pending live measurement | live verification: skeleton-subset direct-calling, proxy reliability on GLM/KiMi/MiMo, token delta vs skeleton-for-all |
| 5. Route hardening/KiMi | partial | live provider availability |
| 6. Migration/release hardening | in progress | selected shipping subset |

Phases 3 and 4 remain gated independently: passing local replay or one provider does not prove every runtime edge.

### Implementation evidence — 2026-07-11

- Recursive described skeletons: 33 tools, 12,923 bytes (~3,231 rough tokens); stable 51-tool hash `e7668702c8208d27` across tested GLM/MiMo turns.
- Cache evidence: GLM continuations reported ~19.8K–20.4K cached tokens; MiMo ~23.3K–23.8K.
- Live calls: GLM/MiMo/Gemini explicit `##pi_version` or `#group:pi-runtime` returned Pi 0.80.5; GLM group search returned changelog heading `## 0.80.5`; GLM executed complex `tavily_crawl` arguments.
- Proxy forwarding required and now uses patched `pi.getRegisteredTool()`; metadata-only `getAllTools()` was insufficient and failed live before this correction.
- GPT conversion/replay contract and prior raw API proof pass. New GPT Pi live execution is blocked by the current Codex usage limit.
- DeepSeek re-verification is blocked by insufficient balance. KiMi remains unavailable through configured providers.

### Implementation evidence — 2026-07-29 (cache + explicit-proxy activation evaluation)

- Cache invariant re-confirmed live: a Qwen 3.8 Max Preview session held `tools=20` / `toolsHash=5134c7db` constant while `dispatch` rose 18→19 on activation and `cacheRead` climbed 106k→108k. The retained log (104,711 events, 373 sessions) shows GPT `client-tool-search` holding one hash while `inputLoadedToolCount` goes 0→16 and dispatch 16→32.
- Gap found and fixed (tool_search path): on `explicit-proxy` routes, `tool_search(names:[…])` previously dispatch-enabled regular discoverable tools and told the model to "use the real tool name directly," but the tool was absent from the schema and not proxy-enabled, so it was unreachable. It now routes all tool_search-activated tools through `tool_proxy` on `explicit-proxy`. Live Qwen proof: `tool_search(names:["pi_docs"])` → `tool_proxy(pi_docs)` returned 46 files; group→proxy `pi_version` regression returned 0.82.1. See [adr/0003-hidden-tool-activation-routing.md](./adr/0003-hidden-tool-activation-routing.md).
- Added a distinct `tool_activated` diagnostic event so activations are catchable in `tooltap.log.jsonl` without diffing consecutive provider requests.
- Deferred: marker (`##tool`/`#group`) and `/tool` command paths still dispatch-enable (not proxy-enable) regular tools on `explicit-proxy`, pending route detection in those handlers (ADR-0003 known gap).
- Decided 2026-07-31 ([adr/0003](./adr/0003-hidden-tool-activation-routing.md), [adr/0004](./adr/0004-skeleton-shape-only-schemas.md)): route schema-constrained (and other proxy-default) families through `tool_proxy` for the non-subset tools, keeping a **frozen skeleton subset** for frequent tools — removing the skeleton's upfront shape cost for the rest. Implementation pending; needs live verification first (skeleton-subset direct-calling, proxy reliability on GLM/KiMi/MiMo, token delta vs skeleton-for-all).

### Implementation evidence — 2026-07-31 (proxy-default bare-schema subset, #9)

- `policy.bareSchema` (frozen at `session_start`) emits a shape-only skeleton (`compactSchemaShape`, reused from the shape-direct route) for the named subset in top-level `tools[]` on the explicit-proxy route; every other hidden tool stays behind `tool_proxy`. Subset derives from frozen config + stable registry, so `tools[]` is byte-identical across turns (ADR-0001 honored).
- Activation fork excludes `bareSchema` names from `proxyEnabled` (dispatched direct); the first-use contract hook arms the full contract on a successful direct call. Empty `bareSchema` is byte-identical to prior behavior (config-gated, safe default).
- Gauntlet 46/46, including 11 #9 checks: skeleton emitted on explicit-proxy, shape kept / prose stripped, only the subset skeletonized, byte-stable across requests, dispatched direct (not proxied), `tool_proxy` rejects the bare tool, non-subset tools never skeletonized.
- **Not yet measured live:** skeleton-subset direct-calling on real Qwen/GLM/KiMi/MiMo, proxy reliability on those families, and the token delta versus skeleton-for-all. Evidence grade for the new scope stays `inferred` until a live run re-grades it.
- Not re-run this session (inherit the 2026-07-09 baseline): GPT live (Codex usage limit), DeepSeek (balance), KiMi (provider unavailable), GLM/MiMo skeleton live.

## Phased implementation

### Phase 0 — preserve evidence

- Add the research ledger and this roadmap.
- Correct contract text that previously rejected `additional_tools` categorically.
- Keep current runtime behavior unchanged.

Exit: docs link correctly; tests remain green.

### Phase 1 — skeleton quality, context deduplication, and measurement

- Add recursive provider-compatible shape compaction with canonical ordering.
- Attach concise descriptions to skeleton functions.
- Remove duplicate hidden catalog prose on shape-direct routes.
- Stop emitting equivalent activation guidance in both the tool result and a queued custom message.
- Keep schema and extension-only guidance separate; selected guidance is appended once.
- Add exact serialized catalog/skeleton/guidance metrics and stable hashes.
- Add realistic no-arg, scalar, nested object, array, enum, and required-field fixtures.
- Re-run GLM/MiMo selection, complex first-use, latency, and cache comparisons with adequate reasoning output limits.

Exit: byte-stable before/after dispatch; all argument-shape calls pass live; no selection or first-use latency regression; duplicate activation adds zero context.

### Phase 2 — policy, groups, markers, and frozen session config

- Add versioned `explicitOnly`, `excluded`, and explicit operator-authored group config.
- Preserve legacy config aliases with warnings and deterministic precedence.
- Add `##tool` and `#group` parsing after skill expansion; avoid treating ordinary Markdown headings as activations.
- Add one deterministic resolver shared by every provider strategy.
- Freeze config, inventory, route capability, and ordering at `session_start`; changes apply next session.
- Add cycle, duplicate member, unknown tool, conflicting policy, already-enabled, blocked, and excluded diagnostics.
- Keep `/tool` only as a compatibility alias; do not add a palette or profile engine.

Exit: precedence, deterministic expansion, marker parsing, legacy migration, duplicate suppression, and frozen-session tests pass; groups do not change provider shape mid-session.

### Phase 3 — GPT explicit activation

- Patch Pi Responses conversion to preserve public `additional_tools` and emit the equivalent completed client-search pair for ChatGPT Codex Responses.
- Persist exact item position and selected definitions through save, replay, resume, and fork boundaries.
- Rehydrate direct dispatch state from either historical explicit representation.
- Suppress duplicate marker/group definitions without rewriting the earlier item.
- Keep stateful/manual-replay contract harnesses idempotent and version-aware.
- Live-test absent upfront, call now, result, call later, resume, fork, top-level hash, and cache-read behavior.

Exit: passed on GPT-5.6 Luna low thinking. Top-level hash remained `4b3cf7a4d9d50d72`; exact/group activation, native discovery, complex calling, resume, and fork succeeded; continuation requests observed 13,824–14,848 cached input tokens. Compaction remains covered by structural replay rather than a dedicated live compaction run.

### Phase 4 — explicit proxy for schema-constrained `explicitOnly`

- Register one stable proxy only on exact configured schema-constrained routes.
- Include zero individual `explicitOnly` names/descriptions/schemas upfront.
- Let marker/group activation append one compact recursive contract and proxy-enable exact names.
- Validate proxy arguments with the underlying full schema and enforce policy again at execution.
- Forward cancellation, streaming updates, context, text/image/file content, errors, structured details, and renderer attribution.
- Restore proxy-enabled names from session history; reject direct, recursive, unknown, or non-enabled calls.
- Test real no-arg, nested, streaming, cancellation, image/file, error, parallel, replay, and duplicate scenarios.

Exit: marker-to-call works in one model turn; no individual metadata exists before activation; underlying behavior and attribution are preserved; malformed calls fail closed.

### Phase 5 — route capability hardening

- Replace loose family matching with exact provider + API + model capability entries.
- Pin verified DeepSeek/Gemini text-direct routes and test undeclared direct calls with real arguments.
- Add safe fallback to `shape-direct` only where its schema is stable and verified; otherwise use `static-only`.
- Verify KiMi when a provider is available; do not infer from OpenAI compatibility claims.
- Record route-specific cache availability, tool-call parsing, output limits, and provider regressions.

Exit: every enabled route has live selection, call, replay, and cache evidence or is explicitly labeled experimental/static-only.

### Phase 6 — migration and release hardening

- Ship config migration notes and examples for core/always/explicitOnly/excluded/groups.
- Update README, contract, verification matrix, changelog, and package contents only for implemented phases.
- Run typecheck, unit harness, patch double-apply, conversion/replay contract harness, pack dry-run, link checks, and focused live routes.
- Verify no secrets/full sensitive payloads are logged and no user worktree changes are overwritten.
- Document rollback per provider strategy and Pi-upgrade reapplication steps.

Exit: full verification pipeline passes; package contains docs/patches/tests; current versus roadmap behavior is unambiguous; rollback is tested.

## Rejected designs

- **Mutate `tools[]` after activation universally:** GLM cache dropped from 2,624 to 0.
- **Name + description with schema supplied later on GLM:** parameterized calls emitted `{}`.
- **Open-object GLM placeholder:** emitted `{}` and could loop.
- **Group-only discovery:** saved tokens but measurably reduced exact selection.
- **One combined gateway for all GLM calls:** enabled correctly but repeatedly answered text instead of emitting the second complex call.
- **Separate search/proxy for every discoverable GLM tool:** worked, but added a model round and roughly doubled first-use latency for only ~3.1K context reduction.
- **Assume accepted unknown fields are supported:** GLM/MiMo/DeepSeek silently ignored top-level `additional_tools`.

## Release gate

Do not describe a strategy as shipped, cache-safe in Pi, or provider-verified until its phase exits with observed patch, session, and usage evidence. Update [`contract.md`](./contract.md) only when implementation becomes binding; update the dated research ledger when experiments change the evidence.
