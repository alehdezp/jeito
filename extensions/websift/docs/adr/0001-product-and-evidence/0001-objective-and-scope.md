---
title: "ADR 1.1 — Owned jeito websift objective and scope"
description: "Records the owner-confirmed one-extension boundary and the advanced-research, token-efficiency, provider-apprenticeship, specialist-tool, interactive-selection product objective."
tags: [jeito-websift, adr, objective, scope, product-boundary]
created: 2026-07-28
updated: 2026-08-01
status: active
adr_id: ADR-001.001
adr_type: child
decision_status: accepted
confidence: user-stated
evidence_grade: mixed
implementation_status: in-progress
decision_owner: alehdezp
owns: "Objective and scope for jeito websift"
audience: mixed
parent: docs/adr/0001-product-and-evidence/README.md
related: [docs/ROADMAP.md, docs/DESIGN.md]
---

# ADR 1.1 — Owned jeito websift objective and scope


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-001 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns this decision. Current metadata: `decision_status: accepted`, `confidence: user-stated`, `evidence_grade: mixed`, and `implementation_status: in-progress`. The metadata—not optimistic prose—governs whether dependent work may treat the decision as proved.

> This ADR is also the persistent goal anchor for the effort. Re-read it at the
> start of each session to resist drift; re-anchor every sub-task to it.

## Decision owner and commitment

`alehdezp` owns this decision. The commitment: build one first-party jeito extension, `@alehdezp/websift` at `extensions/websift/`, with a minimal common search surface plus separately taught provider specialists over the existing grounded adapter layer.

## Objective (one sentence)

Build one owned, coherent jeito websift extension that retains and improves the previous providers while making agents exceptionally accurate and context-efficient on hard current, novel, AI-heavy, social, video, and long-tail research; provider roles, advanced schemas, fallbacks, costs, and guidance are selected interactively by `alehdezp` from challengeable contract and focused apprenticeship evidence.

## Observable success

- The target public surface starts with Serper/Tavily `web_search`, existing fetch/lookup evidence operations, and lazily active provider specialists; generic `web_answer` is decomposed into provider-native candidates plus skill-owned verification/research.
- Provider selection is capability- and intent-driven; explicit provider choice
  is always honored.
- Failures are loud and classified; fallback is bounded and provenance-stamped.
- Every result exposes selected provider, all attempts, sources, fallback/cache
  state, warnings, and a `responseId` for retained full content.
- Agents can narrow difficult sources to the smallest source-faithful passages needed, widen to surrounding/full content when required, and retain rejection/evidence state instead of repeatedly dumping whole pages into context.
- Operation conformance establishes eligibility; focused scenario evidence plus interactive `alehdezp` review selects specialist tools, advanced controls, fallbacks, and guidance.
- A fresh machine installs via Pi/npm lifecycle, runs `/skill:websift-setup`, and is
  operational; missing optional providers never break startup or warn at boot.
- Every settled decision maps to a ADR; every ported behavior maps to a
  provenance doc; prepared navigation recovers the *why* cold.

The currently loaded four-tool implementation is migration state, not proof that the superseded four-tools-only product constraint still governs. See [ADR-001.003](0003-core-search-and-provider-specialists.md).

## In scope (the core, no cutoff)

Adapters: Serper, Exa, Tavily, Linkup, xsearch (social), Context7, SkillsMP,
pi-package-search. Fetch pipeline ported compositably from pi-web-access
(native HTTP+Readability plus implemented GitHub/PDF/model-free YouTube handlers;
generic video-frame/model extraction remains outside the accepted baseline). Owned:
routing, failure classification, normalization, output bounding + response-ID
retention, typed config, provenance ledger, setup, maintenance, and the evidence-to-guidance lifecycle.

## Out of scope (settled)

- **Network-target hardening beyond the accepted local-tool boundary.** No SSRF,
  DNS-rebinding, or IP allow/deny layer. The `http(s)` scheme guard, response-size
  and timeout bounds remain, and credential redaction, secret-safe setup, atomic
  file mutation, failure classification, and evidence safety remain required.
- Additional providers such as Firecrawl, Jina, Parallel, Perplexity/Gemini/OpenAI,
  and SearXNG are not in the reviewed implementation set. They remain comparison
  candidates only when external research or a measured task justifies a provider decision.
- `pi-chrome` / browser automation (separate authorization + side-effect boundary).
- Package *installation* via `web_lookup` (discovery only).
- A custom secret manager, a plugin DSL, a DI container, automated upstream
  merging, unbounded multi-provider fan-out, startup network checks, mandatory
  LLM extraction for every simple fetch.

## Settled architectural commitments

1. **Not a runtime wrapper.** Pi 0.82.1 `ExtensionAPI` registers/inspects tools
   but cannot execute another registered tool; a facade would need private
   internals. Rejected.
2. **Not a wholesale copy.** Upstream UI/commands/config/boilerplate are not
   imported. Rejected.
3. **Hybrid:** own the public contracts and orchestration; each provider is a
   narrow adapter; use an official SDK where it is the stable boundary; use
   direct HTTP for small APIs; selectively port only proven *generic*
   implementation, with provenance.
4. **Own the stable, rent the volatile.** Contracts, routing, normalization,
   config, docs are owned; provider APIs are rented behind a thin capability
   contract; each volatile part is one file with a provenance doc.

## Constraints

- Do not move/rename the live `~/.pi/agent/legacy-local-source` checkout
  (concurrent sessions depend on its path).
- Do not uninstall/disable/mutate live packages during development; migration is
  a later, stopped-Pi transaction with rollback preserved.
- Never read, print, migrate, or commit secret values.
- Match jeito host conventions (npm workspaces, `typebox`, `pi.registerTool`,
  `node>=22.19`, peerDep `@earendil-works/pi-coding-agent>=0.82.1`,
  `node --experimental-strip-types --test`).

## What would change this objective

- A future Pi API that safely executes registered tools with preserved
  cancellation/details could reopen the wrapper option (duplicate config/schema
  drift would remain).
- A provider SDK becoming unstable or materially incomplete could justify owning
  direct HTTP for that provider.
- Measured query outcomes may change provider *priority*, but not the
  operation/capability and failure-class architecture.
- Evidence that query-aware passage extraction, structure-aware reading, task-bounded retained indexing, caching, or reranking improves a named scenario may extend the fetch/retrieval architecture; investigation does not itself authorize adoption.

## Alternatives and decisive trade-off

Keeping provider packages as separate public tools would preserve fragmentation, duplicate policy, and registration conflicts. A single undifferentiated web tool would merge incompatible evidence contracts. One owned extension with four evidence verbs preserves a small stable public model while allowing complete provider capability behind it.

## Evidence and verification

The user explicitly confirmed the one-extension objective and complete-capability requirement. The extension, four tools, provider implementations, and research skills exist with focused/live slice evidence; provider apprenticeship, final provider roles, and rollout guidance remain open, so implementation remains `in-progress` and evidence `mixed`.

The 2026-07-31 clarification expands the product outcome beyond package consolidation: advanced research quality, context-token efficiency, focused provider learning, and interactive selection are explicit. No comparative provider role or final guidance has yet been accepted.

## History

- 2026-07-27: one-extension/four-tool framing and hybrid architecture confirmed;
  the owner rejected an SSRF/DNS/IP network-target layer for this local tool,
  excluded the unreviewed provider tail from implementation, settled typed config
  with environment and optional inline-key resolution, and fixed the name to `web`.
- 2026-07-31: widened the objective to advanced research, context-efficient evidence retrieval, focused provider apprenticeship, and interactive owner selection; corrected the implemented Native GitHub/PDF/YouTube baseline and narrowed the security exclusion to network-target hardening.
