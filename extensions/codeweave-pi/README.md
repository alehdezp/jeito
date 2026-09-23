---
title: "codeweave-pi — evidence and safe mutation for Pi"
description: "Prepared project navigation, exact live source authority, hash-guided mutation, diagnostics, and extension-owned local runtimes."
tags: [jeito, codeweave-pi, navigation, evidence, mutation]
created: 2026-07-25
updated: "2026-09-23 15Z"
status: pre-release
owns: "The approachable codeweave-pi package entrypoint"
audience: mixed
related: [docs/README.md, docs/setup.md, docs/current-truth.md, AGENTS.md]
---

# codeweave-pi

codeweave-pi gives Pi an evidence-first way to understand and change a local project. Its distinctive idea is that prepared intelligence and exact source proof are different capabilities: graphs and ranked retrieval locate the right boundary, while current bytes and hashes authorize safe mutation. The agent can move from architecture to a precise edit without pretending a search hit is source authority.

## What it provides

| Need | Tools |
|---|---|
| Code topology; optional Graphify cross-domain maps | `explore`, `trace` |
| Project documentation retrieval | `docs_search` |
| Exact paths, text, symbols, source, and changes | `ls`, `find`, `grep`, `read`, `diff` |
| Hash/provenance-guided mutation | `edit`, `write` |
| Scoped diagnostics | `lsp_validate`, `CHECK LSP` in `edit` |

Prepared lanes preserve backend ranks, relationships, generation identity, and omissions. Exact tools query the live tree. Complete current source can become edit authority; stale, clipped, transformed, or locator-only output cannot.

## Why it is unusual

- **Capability selection, not a fixed route:** use the observation that retires the real uncertainty instead of forcing every task through one search workflow.
- **Proof-preserving edits:** the edit engine carries current-byte hashes and seen-line provenance through replace/delete/insert operations, stale recovery, file moves, and optional language-server checks.
- **Local project ownership:** pi-nav handles live source; CodeGraph supplies incremental code relationships and local semantic discovery; QMD handles documentation retrieval. Graphify cross-domain maps are the only optional backend. Queries do not index or repair.
- **Runtime boundary:** this public source snapshot omits prebuilt pi-nav executables and native modules and does not contain the production Core payload. A publisher-prepared package would carry matching native assets, Core, and its pinned code model; QMD models are provisioned at installation. Python is only for optional Graphify.

## Install from a checkout

codeweave-pi is pre-release. The Core + QMD path needs Pi, Node 22.19+/npm, Git, prepared matching native/maintenance/model assets and first-install network access. This source snapshot lacks those packaged assets; source and isolated-candidate checks do not prove a fresh installation or cross-machine release. Python 3.10–3.14 with `venv` is only for optional Graphify.

```bash
git clone git@github.com:alehdezp/jeito.git jeito
cd jeito
npm run install:codeweave-pi
```

For a publisher-prepared checkout, the installer verifies Core, provisions and exercises the roughly 928 MiB QMD model pair, and registers only after success. Missing Core assets fail explicitly; startup never downloads or compiles them. Keep the registered checkout at the same path and restart Pi. Do not also register the aggregate package.

Eligible projects use policy-approved automatic Core and QMD preparation. Use `/skill:deep-navigation-onboard` for provider changes or `/skill:navigation-setup` for project overrides and optional Graphify setup. `npm run nav:provision:legacy` prepares the optional Graphify runtime; existing stores are not migrated or adopted.

For the complete suite from a future immutable Git ref, follow the repository [installation guide](../../docs/getting-started.md).

## Status and boundaries

codeweave-pi is pre-release. Earlier native/platform receipts do not establish the new complete Core package. Fresh installation, immutable-ref update/rollback/removal, multi-machine delivery and loaded-runtime acceptance remain unproved. CRG is retired from the source in the current change set — the runtime, adapters, capability entry, and bundled `native/crg` source are being removed — so CRG-era receipts and test counts are historical. [`docs/setup.md`](docs/setup.md) owns the current setup path; [`docs/current-truth.md`](docs/current-truth.md) owns implementation limits; the root [publication-readiness register](../../docs/publication-readiness.md) owns unresolved release gaps.

## Documentation

- [`docs/README.md`](docs/README.md) — route any architecture, operation, or contributor question.
- [`docs/setup.md`](docs/setup.md) — install, onboard, configure, repair, update, and remove.
- [`docs/tool-operating-reference.md`](docs/tool-operating-reference.md) — complete public tool contract.
- [`docs/decisions/README.md`](docs/decisions/README.md) — accepted and provisional reasoning.
- [`AGENTS.md`](AGENTS.md) — codeweave-pi contributor invariants.
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — backend provenance and attribution.

## Focused verification

```bash
npm run validate:inner --workspace @alehdezp/codeweave-pi
```

Use the validation matrix in [`docs/evaluation-workflow.md`](docs/evaluation-workflow.md) for QMD, platform, installed-runtime, or release claims. A local source suite does not prove a managed Git installation or another operating system.
