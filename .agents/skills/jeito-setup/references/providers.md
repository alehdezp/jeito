---
title: "jeito provider inventory and profile evidence"
description: "Provider-specific evidence, privacy disclosures, official links, and per-row requirements for the jeito profile comparison and capability inventory."
tags: [jeito-setup, providers, profiles, opencode-go, command-code, gemini, minimax, ollama]
created: 2026-08-03
updated: 2026-08-03
status: active
---

# Provider inventory and profile evidence

Read this reference when the conversation reaches profile comparison, provider details, or the capability inventory (root layers 3 and 6). The root owns the decision rules and the complete Graphify choice set; this file owns the per-provider evidence, privacy disclosures, and links.

## Per-provider table rows

For every displayed provider, include availability, evidence, privacy, price/limit, and official setup links. Official links: use the installed catalog where it owns the URL; fetch only missing official provider pages; render every official link as a full `https://` URL — never a bare domain name. Explain that a page or key does not prove API health.

## OpenCode Go (Graphify)

When `OPENCODE_API_KEY` is present and the pinned Graphify runtime is available, show OpenCode Go `deepseek-v4-flash` as a cost-optimized Graphify alternative, not an automatic default. Endpoint https://opencode.ai/zen/go/v1 with thinking disabled. State the executed proof (two complete direct `extensions/shell` graphs plus one verified codeweave-pi generation), current Go pricing/limits, and the decisive privacy loss: OpenCode marks this model as training-used with no retention agreement. Use official Go rates; Graphify's child-scoped `(~openai)` estimate uses the wrong price table. Recommend OpenCode Go only after explicit privacy acceptance and offer one bounded corpus probe. Link https://opencode.ai/auth for the key/console and https://opencode.ai/docs/go/ for models, pricing, limits, endpoints, and privacy.

## Command Code Provider API

When `COMMANDCODE_API_KEY` is present, show Command Code as a candidate rather than supported Graphify capability until a bounded Provider API probe succeeds. Key presence does not distinguish the Go plan from Provider entitlement; `upgrade_required` means unavailable, not broken. Link https://commandcode.ai/studio/provider for key setup, https://commandcode.ai/provider for the OpenAI-compatible contract, and https://commandcode.ai/docs/resources/pricing-limits for pricing and plan limits.

## Remaining choice-set evidence

The complete Graphify choice set, the recommended order (OpenCode Go → OpenRouter Ling free → native DeepSeek), and the no-automatic-fallback rule live in the root decision rules. This file carries the per-row evidence:

- **Gemini** `gemini-3-flash-preview` free tier: experimental until a bounded Graphify corpus probe passes; disclose that Google uses unpaid-service content to improve products and human reviewers may process it.
- **MiniMax** `MiniMax-M3`: remains visible but rejected after unstable thinking-disabled `extensions/shell` runs; disclose its separate $20/$50/$120 Token Plan Subscription Key and official API/pricing pages.
- **OpenRouter Ling free**: proven one-key default path; disclose free-endpoint rate limits/availability drift and last-good-without-fallback behavior.
- **Native DeepSeek**: direct route when the key and runtime support it.
- **Voyage**: QMD-only embedding/reranking option (`voyage-4-large` plus `rerank-2.5`); never for CRG code embeddings because CRG 2.3.7's OpenAI-compatible client echoes a frozen `dimensions` argument from the second batch onward, which Voyage's API rejects (HTTP 400).
