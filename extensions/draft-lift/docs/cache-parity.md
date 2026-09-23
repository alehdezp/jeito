---
title: "draft-lift cache parity verification"
description: "Evidence required to distinguish main-session provider cache reuse from side-request self-cache reuse."
tags: [draft-lift, cache-parity, provider-usage, verification]
created: 2026-07-26
updated: 2026-07-26
status: active
owns: "Cache reuse evidence boundary for sidequest requests"
audience: contributor
related: [docs/architecture.md, README.md]
---

# Cache/parity verification strategy

`draft-lift` tries to distinguish real main-session cache reuse from accidental self-cache reuse.

## What “cache reuse” means here

Provider prompt cache is prefix/body sensitive. A sidequest call can reuse already-warm provider cache only if its cache-relevant request prefix matches a cached main-session request closely enough for the provider.

The extension does not assume success just because the model understands the conversation. It relies on provider usage metadata.

## What is mirrored

The latest normal main provider payload is captured by `before_provider_request`. The extension strips input fields from that payload and mirrors the remaining body onto the sidequest payload.

This mirrors the field set captured in the request flow at `extensions/draft-lift/docs/architecture.md:architecture-and-request-flow/provider-request-mirroring#2`; the fields below are what the diagnostic log records as parity evidence.

The sidequest request keeps its own `input`, but attempts to match main-session fields such as:

- instructions
- tools
- prompt cache key
- reasoning/thinking
- text options
- model/options body

## Key backlog fields

Look for an `attemptId` with these events:

1. `start`
2. `enhancer_provider_payload`
3. `result`

The `enhancer_provider_payload` entry should show:

```json
{
  "mainBodyWithoutInputMirrorApplied": true,
  "bodyWithoutInputMatchesLatestMain": true,
  "instructionsMatchLatestMain": true,
  "toolsMatchLatestMain": true,
  "promptCacheKeyMatchesLatestMain": true,
  "reasoningMatchesLatestMain": true
}
```

The `result` entry should show provider usage:

```json
{
  "usage": {
    "input": 15046,
    "cacheRead": 222208,
    "cacheWrite": 0
  },
  "cacheHit": true
}
```

`cacheHit` is computed as `usage.cacheRead > 0`.

## Distinguishing main-cache reuse from self-cache reuse

For a clean proof:

1. Advance the normal conversation first.
2. Run `draft-lift` exactly once with a fresh never-before-used draft.
3. Check that the draft hash appears only in that one attempt.
4. Check that the first result for that attempt has large `usage.cacheRead`.
5. Check that payload parity booleans are true.

If the first call misses and a second identical call hits, that suggests self-cache reuse. If the first unique call hits after a normal main turn and parity is true, that supports main-session-compatible cache reuse.

## Thinking/model parity

The extension uses the current Pi model and current Pi thinking level:

```ts
const thinkingLevel = pi.getThinkingLevel();
const reasoning = thinkingLevel === "off" ? undefined : thinkingLevel;
```

The provider payload audit records model and reasoning hashes. `reasoningMatchesLatestMain: true` means the sidequest provider body used the same reasoning payload as the latest main provider request.

## Caveats

- Provider cache behavior is provider-defined and can change.
- Public Pi APIs do not expose every internal hook used by the main assistant path.
- Mirroring latest main non-input body is a best-effort parity strategy, not a formal guarantee.
