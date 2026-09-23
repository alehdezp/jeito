---
title: "Graphify official docs digest"
description: "Pinned local fact digest of Graphify upstream knowledge-graph capability claims; evidence, not a public-stack decision."
tags: [jeito-codeweave-pi, upstream, graphify, knowledge-graph, evidence-digest]
created: 2026-06-22
updated: 2026-06-22
status: active
owns: "Pinned Graphify upstream capability evidence digest"
audience: contributor
related: [README.md]
---

# Graphify official docs digest

Purpose: local fact digest for Graphify evidence. This is not a public-stack decision.

Fetched/read on: 2026-06-22.

## Source documents

- `Knowledge Graphs for AI Coding Assistants — Graphify`
  - https://graphify.net/knowledge-graph-for-ai-coding-assistants.html
- `safishamsi/graphify - README.md`
  - https://github.com/safishamsi/graphify/blob/main/README.md
- `/graphify` skill document
  - https://raw.githubusercontent.com/safishamsi/graphify/main/skills/graphify/skill.md
- `safishamsi/graphify - ARCHITECTURE.md`
  - https://github.com/safishamsi/graphify/blob/main/ARCHITECTURE.md
- `safishamsi/graphify - SECURITY.md`
  - https://github.com/safishamsi/graphify/blob/main/SECURITY.md

## Upstream capability claims

### Graph purpose and shape

The Graphify knowledge-graph page says a repository graph preserves structure that flat vector chunks lose. It describes nodes as concepts such as classes, functions, design decisions, paper sections, and diagrams, and edges as relationships such as `calls`, `imports`, `rationale_for`, and `semantically_similar_to`.

The README describes Graphify as a Claude Code skill for code, PDFs, markdown, screenshots, diagrams, whiteboard photos, and images. It says the output directory contains an interactive graph, Obsidian vault, optional wiki, `GRAPH_REPORT.md`, `graph.json`, and cache.

What this proves: upstream Graphify is documented as cross-modal and graph-native rather than just code-symbol lookup.

What this does not prove: it does not prove the current local Pi Graphify graph contains docs/images/PDF semantic extraction or that the current Pi wrapper exposes every mode.

### Extraction/provenance model

The knowledge-graph page and README both emphasize edge provenance labels: `EXTRACTED`, `INFERRED`, and `AMBIGUOUS`. The architecture doc defines the extraction schema with nodes containing `id`, `label`, `source_file`, and `source_location`, and edges containing `source`, `target`, `relation`, and `confidence`.

The architecture doc describes a pipeline:

```text
detect() -> extract() -> build_graph() -> cluster() -> analyze() -> report() -> export()
```

It says modules communicate through plain Python dicts and NetworkX graphs, with no shared state and no side effects outside `graphify-out/` for the pipeline.

What this proves: upstream Graphify has a documented native schema and confidence/provenance model worth preserving in Pi output.

What this does not prove: it does not prove every CLI subcommand is side-effect-free; local source/probe evidence already found query logging unless disabled, and the skill also describes query-result memory writes.

### Query-time graph operations

The README and skill document list:

- `/graphify query "..."` for traversal over the graph.
- `/graphify query --dfs` for specific chain/path tracing.
- `/graphify path "A" "B"` for shortest paths.
- `/graphify explain "Node"` for node explanation.
- MCP server tools: `query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, and `shortest_path`.

What this proves: upstream Graphify has documented query/explain/path primitives and a graph-native query surface.

What this does not prove: it does not prove those exact operations should become public Pi tools; Pi may still expose them via `explore`, `trace`, structured/native detail, or a hidden backend lane.

### Setup/update/watch operations

The README and skill document list setup/mutation modes:

- `pip install graphifyy && graphify install`.
- `/graphify <path>` full pipeline.
- `/graphify <path> --update` incremental extraction.
- `/graphify <path> --watch` filesystem watcher.
- `graphify hook install` post-commit hook.
- `graphify claude install` project CLAUDE.md integration.
- `/graphify add <url>` explicit URL ingest.

The skill document describes structural AST extraction, semantic extraction via subagents for non-code files, graph/report/export writes, cache writes, cost tracking, and optional exports.

Safety implication: these setup/update/watch/add/hook/install paths are not query-time navigation operations. They can write files, consume model/provider tokens for semantic extraction, or fetch network content when explicitly asked to ingest URLs.

### Security/locality claims

`SECURITY.md` calls Graphify a local development tool and says graph analysis makes no network calls; only explicit `ingest` URL fetch uses the network. It also documents URL validation, size caps for downloads, path validation for MCP graph files, label sanitization, no source-code execution, no `shell=True`, and no credential/API-key storage.

What this proves: upstream Graphify documents a local-security model for graph analysis, plus explicit exceptions for URL ingest and setup/semantic extraction workflows.

What this does not prove: it does not prove the current local CLI version or Pi wrapper behavior is fully non-mutating; wrappers still need command-level guards.


## Version and R2 delivery boundary

- The currently installed executable reports `graphify 0.8.44`; isolated environment metadata identifies package `graphifyy` 0.8.44 under the MIT License.
- R2 may package jeito-codeweave-pi's owned wrapper scripts and a required-version/capability manifest, but not a generated graph, provider credential, or installed Python environment. `src/graphify-out/**` is explicitly excluded from Pi archives.
- Installing or upgrading Graphify remains explicit `navigation-setup` work. First-time deep/semantic extraction and provider use remain approved setup work; first-open may automatically maintain only an already installed, compatible, durably approved lane.
- Revalidate the version, license, CLI/API symbols used by `scripts/graphify-rich-update.py`, and provider behavior before R2.4 freezes the compatibility manifest.

### Incremental-shrink reliability update

- The installed `graphifyy` remains 0.8.44. Its `to_json(..., force=False)` guard rejects every smaller graph regardless of whether the shrink is legitimate; its Python API supports `force=True`.
- Upstream explicitly added CLI `--force`/`GRAPHIFY_FORCE` for legitimate refactor deletions, while warning that unconditional forcing can hide partial-chunk or fuzzy-dedup loss: https://github.com/safishamsi/graphify/pull/639 and https://github.com/safishamsi/graphify/issues/1178.
- Upstream 0.9.16 fixes several update-integrity defects relevant to lifecycle automation, including nested-ignore scoping, persisted excludes, missing-cache zero-node regression, semantic-edge preservation, and omitted-document visibility: https://github.com/Graphify-Labs/graphify/releases/tag/v0.9.16.
- jeito codeweave-pi always uses `force=True` for its isolated incremental candidate write. Node/edge shrink is accepted as normal current state and published atomically; provenance attribution remains diagnostic telemetry and never blocks refresh or strands map availability.
- Upgrading the external Graphify installation remains explicit `navigation-setup` work; 0.9.16 is the currently researched successor and must receive a focused compatibility probe before replacing 0.8.44.
## Graphify facts most relevant to Pi redesign

- Graphify's unique documented value is graph-native cross-modal structure: code plus docs/papers/images/diagrams, edge provenance, communities, god nodes, surprising connections, suggested questions, and persistent `graph.json`.
- Graphify path/explain/query output should not be flattened into anonymous candidates when native graph signal matters.
- Graphify full/deep/update/watch/add/install/hook/claude setup paths are mutation/setup/provider/network paths and must stay outside query-time unless explicitly approved.
- Query-time Graphify calls need side-effect checks/guards; current Pi wrappers already set `GRAPHIFY_QUERY_LOG_DISABLE=1` on inspected query/path/explain calls, but raw CLI behavior should not be assumed safe.
- A fair Graphify-vs-CRG comparison must record graph scope and extraction mode. A code-only or AST-only Graphify graph is not evidence against Graphify's documented cross-modal capability.
