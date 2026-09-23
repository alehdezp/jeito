---
title: "Upstream navigation backend source digests index"
description: "Index of pinned source digests proving Graphify and pi-nav native backend capability, plus the historical CRG digest; evidence, not status or plan."
tags: [jeito-codeweave-pi, upstream, evidence-digest, crg, graphify, pi-nav]
created: 2026-06-22
updated: 2026-09-21
status: active
owns: "Index of pinned upstream backend source digests for capability proof"
audience: contributor
related: [crg-official-docs-digest.md, graphify-official-docs-digest.md, pi-nav-native-contracts.md]
---

# Upstream navigation backend sources

This directory stores compact source digests for backend capability proof. These files are evidence, not status reports or implementation plans.

Existing backend digests were fetched/read on 2026-06-22; pi-nav native runtime sources were reviewed on 2026-07-13. Each digest records its own pinned versions and revalidation triggers.

## CRG / code-review-graph sources (historical)

CRG is retired from codeweave-pi, so these digests are historical evidence only. They are retained because the R5 delivery record and its rejected alternatives cite them; nothing here is current runtime guidance.

- Fetched document name: `tirth8205/code-review-graph - docs/COMMANDS.md`
  - URL: https://github.com/tirth8205/code-review-graph/blob/main/docs/COMMANDS.md
  - Local digest: `crg-official-docs-digest.md`
- Fetched document name: `tirth8205/code-review-graph - docs/LLM-OPTIMIZED-REFERENCE.md`
  - URL: https://github.com/tirth8205/code-review-graph/blob/main/docs/LLM-OPTIMIZED-REFERENCE.md
  - Local digest: `crg-official-docs-digest.md`
- Fetched directory listing: `skills`
  - URL: https://api.github.com/repos/tirth8205/code-review-graph/contents/skills?ref=main
  - Local digest: `crg-official-docs-digest.md`
- Fetched skill documents:
  - `skills/build-graph/SKILL.md`
  - `skills/debug-issue/SKILL.md`
  - `skills/explore-codebase/SKILL.md`
  - `skills/refactor-safely/SKILL.md`
  - `skills/review-changes/SKILL.md`
  - `skills/review-delta/SKILL.md`
  - `skills/review-pr/SKILL.md`

## Graphify sources

- Fetched document name: `Knowledge Graphs for AI Coding Assistants — Graphify`
  - URL: https://graphify.net/knowledge-graph-for-ai-coding-assistants.html
  - Local digest: `graphify-official-docs-digest.md`
- Fetched document name: `safishamsi/graphify - README.md`
  - URL: https://github.com/safishamsi/graphify/blob/main/README.md
  - Local digest: `graphify-official-docs-digest.md`
- Fetched document name: `/graphify`
  - URL: https://raw.githubusercontent.com/safishamsi/graphify/main/skills/graphify/skill.md
  - Local digest: `graphify-official-docs-digest.md`
- Fetched document name: `safishamsi/graphify - ARCHITECTURE.md`
  - URL: https://github.com/safishamsi/graphify/blob/main/ARCHITECTURE.md
  - Local digest: `graphify-official-docs-digest.md`
- Fetched document name: `safishamsi/graphify - SECURITY.md`
  - URL: https://github.com/safishamsi/graphify/blob/main/SECURITY.md
  - Local digest: `graphify-official-docs-digest.md`

## pi-nav native runtime sources

- Official napi-rs, Node.js, Rust, Cargo/platform, npm staging, Apple signing/notarization, Pi-package, and pinned oh-my-pi contracts used by the owned N-API bridge and release lifecycle.
  - Local digest: `pi-nav-native-contracts.md`
  - Read the relevant section before P3 bridge, P5 package/release, or P7 installed-package work; update it in the same phase as any relied-on dependency/runtime/distribution contract.

## Current decision docs

- Current architecture and truth: `../README.md` and `../current-truth.md`.
- Compact evidence ledger: `../evidence.md`.
- Do not add new upstream digests unless they change a current decision. Extend `pi-nav-native-contracts.md` rather than creating another N-API/package research document.
