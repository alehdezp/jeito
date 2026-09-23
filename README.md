---
title: "jeito — an evidence-first Pi extension suite"
description: "A compact router to jeito's extensions, installation guide, contributor documentation, and publication status."
tags: [jeito, pi, extensions, git-distribution]
created: 2026-07-26
updated: "2026-09-23 15Z"
status: pre-release
owns: "The public entry point and extension router"
audience: mixed
related: [docs/README.md, docs/getting-started.md, CONTRIBUTING.md, SECURITY.md]
---

# jeito

jeito is a work-in-progress extension suite for the [Pi coding agent](https://pi.dev/), built around one problem: a plausible answer is not enough to justify changing a project. Its tools help the agent find the right source, inspect current evidence, make precise edits, keep command output recoverable, and bring in web material or extra tools only when the task needs them.

> **In development:** I use jeito in my own setup. The [first-party code is MIT licensed](LICENSE), but there is no supported installation or platform guarantee yet. The repository address is `git@github.com:alehdezp/jeito.git`; no immutable release ref or clean-machine full-suite install has been proved. [Publication readiness](docs/publication-readiness.md) separates a public source presentation from a supported release.

## Extensions

The root package declares these extension entrypoints together; this source snapshot is not a prepared installable bundle:

| Extension | What is distinctive |
|---|---|
| [codeweave-pi](extensions/codeweave-pi/README.md) | Prepared code/docs/architecture evidence plus hash-authorized mutation in one local-project workflow. |
| [shell](extensions/shell/README.md) | `bash` and background `jobs` with LeanCTX compression, exact recoverable logs, and reusable scratch cells. |
| [tooltap](extensions/tooltap/README.md) | One stable `tools` control that keeps late tool activation cache-safe across provider routes and model epochs. |
| [websift](extensions/websift/README.md) | Evidence-status-aware search, fetch, library docs, catalog lookup, and explicit provider specialists over one retrieval stack. |
| [draft-lift](extensions/draft-lift/README.md) | Improves the current editor draft through a separate context-aware request without replacing accepted user intent. |
| [guidepin](extensions/guidepin/README.md) | Appends persistent working reminders and ships goal-management guidance alongside the versioned system prompt. |
| [fff search](extensions/fff-search/README.md) | Fast `@file` editor autocomplete without adding agent tools, commands, or a second broad filesystem index. |
| [stall-guard](extensions/stall-guard/README.md) | Continues a tagged stalled-provider turn, with a three-resume bound; a separate stall watchdog must supply the tag. |

Standalone development packages are intentionally excluded from the aggregate:

| Extension | Why it is separate |
|---|---|
| [context diagnostics](extensions/context-diagnostics/README.md) | Dumps sensitive prompts, schemas, and messages only on explicit request. |

## Start here

- **Install or update:** [`docs/getting-started.md`](docs/getting-started.md)
- **Find the owning document:** [`docs/README.md`](docs/README.md)
- **Contribute:** [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md)
- **Report a vulnerability:** [`SECURITY.md`](SECURITY.md)
- **Review licenses and provenance:** [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and each extension's license metadata
- **Review source-presentation and later distribution gaps:** [`docs/publication-readiness.md`](docs/publication-readiness.md)
