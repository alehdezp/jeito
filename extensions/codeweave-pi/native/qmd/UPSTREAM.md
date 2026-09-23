---
title: "Owned QMD fork provenance"
description: "Upstream QMD identity, fork delta, and the read-only local-inference boundary for the owned QMD fork."
tags: [qmd, upstream, provenance, fork, local-inference]
created: 2026-07-25
updated: 2026-07-27
status: active
owns: "QMD fork provenance and delta record"
audience: contributor
related: [README.md, CHANGELOG.md]
---

# Owned QMD fork

- Upstream: https://github.com/tobi/qmd
- Version: 2.5.3
- Commit: 53232770867ccb16538c2c6034e7d891dffc9ce3
- License: MIT (`LICENSE`)

Project-evidence changes provider injection from `LlamaCpp` to the `LLM` interface, adds the ZeroEntropy zembed-1/zerank-2 provider, preserves query/document asymmetry, allows character-estimated chunking when a remote provider has no tokenizer, and adds a read-only local-inference mode that refuses native builds or model downloads. The public extension indexes pi-nav-projected Markdown sections as QMD documents; it does not use QMD global collections or managed ZeroEntropy zsearch.
