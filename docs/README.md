---
title: "jeito documentation index"
description: "Routes installation, contribution, security, publication, and extension questions to one current owner."
tags: [jeito, documentation-index, routing]
created: 2026-07-27
updated: "2026-09-23 12Z"
status: active
owns: "Repository-wide public documentation routing"
audience: mixed
related: [README.md, CONTRIBUTING.md, AGENTS.md]
---

# jeito documentation index

Use the document that owns the question. Historical ADRs explain prior decisions; they do not override current source, current contracts, or the indexes that label them superseded.

## Repository

| Question | Owner |
|---|---|
| How do I explain an extension in its README and choose its visuals? | [`extension-readme-writing.md`](extension-readme-writing.md) |
| What is jeito and which extension should I open? | [`README.md`](../README.md) |
| How do I install the suite or one extension from Git/a checkout? | [`getting-started.md`](getting-started.md) |
| How do I contribute? | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Which engineering invariants govern changes? | [`AGENTS.md`](../AGENTS.md) |
| How do I report a vulnerability? | [`SECURITY.md`](../SECURITY.md) |
| What still blocks public release? | [`publication-readiness.md`](publication-readiness.md) |
| Which third-party licenses and adaptations are present? | [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) |
| How are optional third-party packages handled? | [`recommendations.md`](recommendations.md) |
| How should tool guidance be owned? | [`tool-guidance-architecture.md`](tool-guidance-architecture.md) |
| What full-harness defaults ship in Git? | [`config/APPEND_SYSTEM.md`](../config/APPEND_SYSTEM.md) and [`config/tool.yaml`](../config/tool.yaml) |
| How do agents scaffold and maintain evolving intent without a session log? | [`goal-management`](../extensions/guidepin/skills/goal-management/SKILL.md) and the [system contract](../config/APPEND_SYSTEM.md#1-frame-the-task-before-acting) |

## Extensions

| Extension | Package entrypoint | Deeper authority |
|---|---|---|
| codeweave-pi | [`extensions/codeweave-pi/README.md`](../extensions/codeweave-pi/README.md) | [`docs/README.md`](../extensions/codeweave-pi/docs/README.md), [`AGENTS.md`](../extensions/codeweave-pi/AGENTS.md), [`decisions/`](../extensions/codeweave-pi/docs/decisions/README.md) |
| Shell | [`extensions/shell/README.md`](../extensions/shell/README.md) | [`THIRD_PARTY_NOTICES.md`](../extensions/shell/THIRD_PARTY_NOTICES.md) |
| tooltap | [`extensions/tooltap/README.md`](../extensions/tooltap/README.md) | [`docs/README.md`](../extensions/tooltap/docs/README.md), [`contract.md`](../extensions/tooltap/docs/contract.md), [`adr/`](../extensions/tooltap/docs/adr/README.md) |
| websift | [`extensions/websift/README.md`](../extensions/websift/README.md) | [`docs/README.md`](../extensions/websift/docs/README.md), [`DESIGN.md`](../extensions/websift/docs/DESIGN.md), [`adr/`](../extensions/websift/docs/adr/README.md) |
| draft-lift | [`extensions/draft-lift/README.md`](../extensions/draft-lift/README.md) | [`docs/architecture.md`](../extensions/draft-lift/docs/architecture.md), [`docs/safety.md`](../extensions/draft-lift/docs/safety.md) |
| FFF Search | [`extensions/fff-search/README.md`](../extensions/fff-search/README.md) | package README |
| Stall Guard | [`extensions/stall-guard/README.md`](../extensions/stall-guard/README.md) | package README and resume bounds |
| Context Diagnostics | [`extensions/context-diagnostics/README.md`](../extensions/context-diagnostics/README.md) | package README privacy boundary |
| guidepin | [`extensions/guidepin/README.md`](../extensions/guidepin/README.md) | [`docs/pi-hooks-and-design.md`](../extensions/guidepin/docs/pi-hooks-and-design.md) |

## codeweave-pi native backends

codeweave-pi bundles and attributes three backend families. Their native/upstream documents are package evidence, not repository-wide onboarding:

- [`pi-nav`](../extensions/codeweave-pi/native/pi-nav/README.md) — live exact and structural queries;
- [`CodeGraph-derived Core`](../extensions/codeweave-pi/native/analysis/README.md) — maintained code relationships and local semantic representations;
- [`QMD`](../extensions/codeweave-pi/native/qmd/UPSTREAM.md) — documentation retrieval.

Start at the codeweave-pi docs hub rather than reading backend files in isolation.
