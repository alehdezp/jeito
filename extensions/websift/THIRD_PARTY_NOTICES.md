---
title: "Third-party notices for jeito websift"
description: "Licenses and provenance for third-party code adapted or distributed by the jeito websift extension."
tags: [jeito, web, third-party-notices, licensing, provenance]
created: 2026-07-27
updated: "2026-09-23 12Z"
status: active
owns: "Third-party license index and provenance for jeito websift"
audience: contributor
related: [docs/upstreams/README.md, docs/adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md]
---

# Third-party notices — jeito websift

First-party websift code is [MIT licensed](LICENSE); the package remains private
to prevent accidental npm publication. The notices below preserve the separate
license obligations of adapted material. Full per-source provenance lives in
[`docs/upstreams/`](docs/upstreams/README.md).

## pi-web-access (fetch pipeline)

Portions of the fetch pipeline (`src/fetch-handlers/*`, `src/output.ts`) are
adapted from `pi-web-access` 0.13.0, Copyright (c) Nico Bailon, licensed MIT.
Repository: <https://github.com/nicobailon/pi-web-access>. See
[`docs/upstreams/pi-web-access.md`](docs/upstreams/pi-web-access.md) for exact
files ported, behavior omitted (curator/UI, security module, Jina/Gemini/
Parallel/Perplexity extraction branches), and local divergences.

> The MIT license text is reproduced in
> [`docs/upstreams/pi-web-access.md`](docs/upstreams/pi-web-access.md#license).

## @weihan28/pi-tavily (Tavily adapter reference)

The Tavily adapter contract was derived by reading `@weihan28/pi-tavily`
1.0.2, which wraps the official `@tavily/core` SDK. Repository:
<https://github.com/weihan28/pi-tavily>. The MIT license was confirmed from the
vendored upstream LICENSE during the Tavily provenance review. See
[`docs/upstreams/tavily.md`](docs/upstreams/tavily.md).

## Official provider SDKs

Where an official SDK is the stable vendor boundary (e.g. `@tavily/core`,
`exa-js`), it is used as a normal dependency and carries its own license; this
repository does not vendor or republish it.

## @blackwell-systems/gcf

Model-visible structured output uses the official `@blackwell-systems/gcf` 2.4.0 package under the MIT license. It is installed as a normal runtime dependency; jeito does not copy or vendor its source. The generic codec changes serialization only—provider-native JSON remains in the owning tool details.
## Excluded by license

`pi-web-agent` (AGPL-3.0-only) supplied architectural comparison only. No AGPL
source is copied into this project.
