---
title: "Provenance — Pi package catalog contract and apprenticeship"
description: "Current npm-backed Pi package discovery contract plus live ranking, evidence, and installation-boundary findings."
tags: [jeito, web, provenance, pi-package-search, lookup, npm, apprenticeship]
created: 2026-07-27
updated: 2026-08-12
status: active
owns: "Pi package lookup adapter provenance"
audience: contributor
code: [src/adapters/pi-packages.ts]
related: [docs/upstreams/README.md, docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md]
---

# Pi package discovery without installation

- **Package:** `pi-package-search` 0.1.1; repository <https://github.com/forjd/pi-package-search>.
- **Resolved snapshot:** `ec26ed0ec226`; MIT license confirmed from `LICENSE`.
- **Source read:** `src/search-pi-packages.ts` and `extensions/index.ts` on 2026-07-28.
- **Runtime boundary:** anonymous npm registry search; no upstream code is imported.

## npm registry query and normalized package records

The adapter queries `https://registry.npmjs.org/-/v1/search` with `text=keywords:pi-package <query>` and a 1–20 size bound. Package name, version, description, date, npm/homepage links, and score become lookup records. `installCommand` is returned as inert metadata only.

The upstream extension also registers an install tool that executes `pi install`; jeito websift deliberately omits it. `web_lookup(source:"pi-packages")` performs discovery only and never mutates package state.

## Focused package-discovery recipe

A live `web search` lookup on 2026-08-01 returned ten plausible packages in 957 ms, led by `@ollama/pi-web-search`, `pi-web-search`, `pi-deepseek-search`, and `pi-web-access`. The numeric score is npm registry search ranking, not package correctness, maintenance, compatibility, safety, or a jeito endorsement. Use lookup to produce candidates; inspect the package source and current Pi contract before installation. No metered monetary charge applies to the public registry request.

An npm response with `objects:[]` is a successful scoped catalog zero, not proof that no package exists. A missing/changed collection or rows present with no valid package names is provider-contract `unavailable`.

## Owning proof and upkeep

`tests/adapters/pi-packages.test.mjs` owns registry normalization and the discovery-only invariant. Last reviewed 2026-07-28. Next comparison: `npm view pi-package-search version`, then diff `src/search-pi-packages.ts` from `ec26ed0ec226`.
