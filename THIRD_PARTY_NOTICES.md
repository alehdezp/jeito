---
title: "Third-party notices for jeito"
description: "Index of package licenses, attributions, and provenance for third-party code adapted or distributed by jeito extensions."
tags: [jeito, third-party-notices, licensing, provenance]
created: 2026-07-26
updated: "2026-09-23 12Z"
status: active
owns: "Repository-wide third-party license and provenance routing"
audience: mixed
related: [README.md, docs/publication-readiness.md]
---

# Third-party notices for jeito

First-party jeito code and documentation are licensed under [`LICENSE`](LICENSE) (MIT); each standalone workspace also carries its own `LICENSE`. This page routes separate third-party attributions and retained notices. The first-party grant does not replace a dependency's license or the conditions for bundled and adapted material.

| Extension | License or notice owner |
|---|---|
| codeweave-pi | [`LICENSE`](extensions/codeweave-pi/LICENSE), [`THIRD_PARTY_NOTICES.md`](extensions/codeweave-pi/THIRD_PARTY_NOTICES.md), and backend-local license/provenance files |
| Context Diagnostics | [`LICENSE`](extensions/context-diagnostics/LICENSE) |
| FFF Search | [`LICENSE`](extensions/fff-search/LICENSE), with upstream lineage in its README |
| guidepin | [`LICENSE`](extensions/guidepin/LICENSE) and [`THIRD_PARTY_NOTICES.md`](extensions/guidepin/THIRD_PARTY_NOTICES.md) for adapted `pi-blackhole` accounting |
| draft-lift | [`LICENSE`](extensions/draft-lift/LICENSE) |
| Shell | [`LICENSE`](extensions/shell/LICENSE), [`THIRD_PARTY_NOTICES.md`](extensions/shell/THIRD_PARTY_NOTICES.md), and bundled LeanCTX notices under `extensions/shell/LICENSES/` |
| Stall Guard | [`LICENSE`](extensions/stall-guard/LICENSE) |
| tooltap | [`LICENSE`](extensions/tooltap/LICENSE) |
| websift | [`LICENSE`](extensions/websift/LICENSE), [`THIRD_PARTY_NOTICES.md`](extensions/websift/THIRD_PARTY_NOTICES.md), and provider/source provenance in [`docs/upstreams/`](extensions/websift/docs/upstreams/README.md) |

Dependencies installed through npm or pip retain their own package licenses. Optional third-party recommendations are installed independently with `pi install`; jeito does not vendor, patch, republish, or automatically reinstall them.
