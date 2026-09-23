---
title: "Third-party notices for jeito codeweave-pi"
description: "Licenses and provenance for oh-my-pi hashline, pi-tree-sitter, pi-lens, owned QMD fork, and node-llama-cpp adapted or used by codeweave-pi."
tags: [jeito-codeweave-pi, third-party-notices, licensing, provenance]
created: 2026-07-25
updated: 2026-07-27
status: active
owns: "Third-party license and provenance index for jeito codeweave-pi"
audience: contributor
related: [../../THIRD_PARTY_NOTICES.md, native/qmd/UPSTREAM.md, native/analysis/README.md]
---

# Third-party notices

## oh-my-pi hashline

jeito codeweave-pi adapts selected editing algorithms and regression ideas from
[oh-my-pi](https://github.com/can1357/oh-my-pi), pinned for this work at commit
`e8d0a93db61e756361aad84d4bcbc2dd2db88973`.

Upstream package: `@oh-my-pi/hashline` 16.3.15  
Copyright: Can Boluk and contributors  
License: MIT

Pinned source map:

- `packages/hashline/src/recovery.ts` — exact-context recovery, unchanged-line remapping, and guarded session replay.
- `packages/hashline/src/apply.ts` — replacement-boundary, structural-closer, delimiter-balance, JSX, and landing repairs.
- `packages/hashline/src/snapshots.ts` — snapshot identity, seen-line attachment, path lookup, and relocation semantics.
- `packages/hashline/src/block.ts` — block-resolution seam and fail-closed block behavior.
- `packages/hashline/src/messages.ts` — recovery/repair diagnostic intent.
- `packages/coding-agent/src/edit/hashline/block-resolver.ts` — content-keyed tree-sitter resolver caching pattern.

The original MIT license is available in the pinned checkout at
`oh-my-pi-upstream/LICENSE`. jeito codeweave-pi retains its natural edit language,
Node runtime, stricter seen-line provenance, and active-file recovery/revalidation
model; it does not claim an unmodified upstream integration.

## pi-tree-sitter validation subset

The post-commit syntax diagnostic collector adapts the validation-only
`ERROR`/`MISSING` tree traversal and bounded-reporting behavior from
[pi-tree-sitter](https://github.com/mkokic/pi-tree-sitter), npm version 0.2.2,
gitHead `9e38589c0a75fd6bfd90e2a3a7b93dc8937e08b4`.

Copyright: Marko Kocic and contributors  
License: Eclipse Public License 2.0

Only the small diagnostic-collection behavior is adapted. jeito codeweave-pi
reuses its existing supervised worker, bundled grammars, cancellation, and
post-commit advisory semantics; it does not import pi-tree-sitter's extension
hook, pre-write gate, delimiter fallback, downloader, or edit schema. The EPL
2.0 license is reproduced at `vendor/pi-tree-sitter/LICENSE`.

## pi-lens LSP subpaths

jeito codeweave-pi depends on `pi-lens` 3.8.70, npm gitHead
`0a04bccf628b282d4083adecfb6b9652de744ba4`, and imports only its standalone
`dist/clients/lsp/index.js` and `dist/clients/lsp/config.js` runtime seams for
primary-server discovery, lifecycle, warmup, grouping, and diagnostics.

Copyright: pi-lens contributors  
License: MIT (included in the installed npm package)

The full extension entrypoint and its public tools, formatting, autofix,
auxiliary scanners, navigation, context injection, and background scans are
not loaded by jeito-codeweave-pi.

## Owned QMD fork and local inference runtime

jeito codeweave-pi vendors an owned fork of [`@tobilu/qmd`](https://github.com/tobi/qmd) 2.5.3 at commit `53232770867ccb16538c2c6034e7d891dffc9ce3`. QMD is MIT licensed; the license and exact fork delta are recorded at [`native/qmd/LICENSE`](native/qmd/LICENSE) and [`native/qmd/UPSTREAM.md`](native/qmd/UPSTREAM.md).

Credential-free semantic document retrieval depends on [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) 3.18.1 under the MIT license. npm installs its platform runtime as an ordinary codeweave-pi dependency; codeweave-pi never installs or invokes a global QMD command.

The GGUF embedding and reranker files are downloaded only after explicit local-model approval and are not distributed by this repository. Their canonical sources are [`ggml-org/embeddinggemma-300M-GGUF`](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF) and [`ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF`](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF); each model remains governed by its upstream terms.
