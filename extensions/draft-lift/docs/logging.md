---
title: "draft-lift diagnostic logging"
description: "Backlog event schema, privacy boundary, and operational use for draft-lift provider diagnostics."
tags: [draft-lift, logging, privacy, diagnostics]
created: 2026-07-26
updated: 2026-07-26
status: active
owns: "Backlog event schema, privacy boundary, and diagnostic use"
audience: contributor
related: [docs/architecture.md]
---

# Logging format and backlog interpretation

`draft-lift` writes JSONL diagnostics to:

```text
<PI_CODING_AGENT_DIR>/draft-lift/backlog.jsonl
```

Runtime diagnostics are host-owned state outside the installed extension so Git/package updates cannot erase or dirty them.

The main-parity fields below are the logged form of the cache-relevant mirror defined in `extensions/draft-lift/docs/cache-parity.md:cacheparity-verification-strategy/what-is-mirrored#2`.

## Privacy

Backlog entries do not contain conversation text or draft text. They store hashes, counts, booleans, IDs, and provider usage metadata.

The log directory is ignored by both git and npm packaging.

## Events

Each line is one JSON object. Common event types:

| Event | Meaning |
| --- | --- |
| `start` | A sidequest attempt started. |
| `enhancer_provider_payload` | Provider payload summary after sidequest payload construction/mirroring. |
| `result` | Provider response completed. Includes token/cache usage. |
| `skip` | Request was intentionally skipped by a safety guard. |
| `error` | Request failed. Error is sanitized. |
| `main_provider_payload` | Optional debug record of normal main provider payload; only logged when enabled in code/env. |

Use `attemptId` to correlate `start`, `enhancer_provider_payload`, and `result` for one sidequest attempt.

## Important fields

### Context identity

- `sessionId`
- `leafId`
- `branchEntries`
- `branchLastEntryId`
- `branchLastType`

These identify where in the session tree the sidequest ran.

### Hashes/counts

- `prefixHash`
- `prefixChars`
- `draftHash`
- `draftChars`
- `requestHash`
- `toolsHash`
- `systemPromptHash`

These allow comparing attempts without logging sensitive text.

### Provider payload audit

`providerAudit` summarizes the actual provider body:

- `payloadHash`
- `bodyWithoutInputHash`
- `instructionsHash`
- `inputHash`
- `inputItems`
- `inputTypes`
- `tools`
- `toolsHash`
- `promptCacheKeyPresent`
- `promptCacheKeyHash`
- `reasoningHash`
- `textHash`
- `model`
- transport/options fields

### Main parity fields

Look for:

- `mainBodyWithoutInputMirrorApplied`
- `bodyWithoutInputMatchesLatestMain`
- `instructionsMatchLatestMain`
- `toolsMatchLatestMain`
- `promptCacheKeyMatchesLatestMain`
- `reasoningMatchesLatestMain`

For best cache parity evidence, these should be `true` on `enhancer_provider_payload`.

### Usage fields

`result` entries include:

```json
{
  "usage": {
    "input": 12706,
    "cacheRead": 116736,
    "cacheWrite": 0,
    "output": 1291,
    "totalTokens": 130733
  },
  "cacheHit": true
}
```

`cacheHit` means `usage.cacheRead > 0`.

## How to inspect a clean attempt

1. Run a normal main conversation turn first.
2. Trigger one sidequest with a fresh draft.
3. Find the latest `attemptId`.
4. Check that the draft hash appears only for that attempt.
5. Check the `enhancer_provider_payload` parity booleans.
6. Check the first `result` for that attempt.

Strong evidence of main-session-compatible cache reuse:

- unique fresh `draftHash`
- `mainBodyWithoutInputMirrorApplied: true`
- parity booleans true
- first `result` has large `usage.cacheRead`
- `cacheHit: true`

Evidence of self-cache instead:

- first identical sidequest request misses
- later repeated identical sidequest request hits
- draft hash appears in earlier attempts

## Skip entries

Common skip reasons:

- `recursive_enhancer_prompt`
- `duplicate_draft_cooldown`
- `empty_context`

Skip entries include enough metadata to explain why nothing was sent to the provider.
