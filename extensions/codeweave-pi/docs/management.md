---
title: "Documentation ownership, frontmatter schema, and anti-sprawl rules"
description: "Canonical document ownership, the shared YAML frontmatter schema and first-exposure behavior, and anti-sprawl rules."
tags: [jeito-codeweave-pi, documentation, ownership, frontmatter-schema, session-context, anti-sprawl]
created: 2026-07-25
updated: 2026-08-20
status: active
owns: "Documentation ownership, frontmatter schema, and anti-sprawl rules"
audience: contributor
code: [src/core/markdown-frontmatter.ts, src/core/updated-field-stamp.ts, src/core/source-selector.ts, src/core/frontmatter-relationships.ts, src/tools/docs-search.ts, src/tools/read.ts, src/tools/write.ts, src/tools/edit.ts]
related: [docs/README.md, docs/evidence.md, docs/current-truth.md]
---

# Documentation ownership and maintenance

Canonical docs are optimized for future coding agents. Each fact has one owner. The question-routing view is `docs/README.md:jeito-codeweave-pi-agent-entrypoint/read-these-docs-by-question#2`.

| Document | Durable responsibility |
|---|---|
| `README.md` | Entry point, architecture overview, tool responsibilities, current baseline |
| `harness-doctrine.md` | Product reasoning, invariants, evidence and change-classification doctrine |
| `automatic-workflow.md` | Implemented end-to-end runtime flows and lifecycle boundaries |
| `evidence.md` | Feature-to-code/test/live-evidence map, failure modes, rationale, limitations |
| `current-truth.md` | Current state, limitations, and admission gate for future work |
| `setup.md` | Setup, health, repair, migration, destructive boundaries |
| `evaluation-workflow.md` | Evidence tiers and live evaluation procedure |
| `ui-rendering.md` | Normal TUI rendering contract |
| `tool-operating-reference.md` | Exhaustive public tool features/parameters, optimal call construction, and APPEND/schema/test coverage audit |
| `upstream/` | Compact source-backed backend digests |
| `decisions/` | Preserved reasoning behind settled decisions: context, rejected alternatives, decisive trade-offs |

Rules:

1. Consolidate into an existing owner before creating a file.
2. Do not create dated reports, raw logs, transcript dumps, completed plans, or archive directories under `docs/`.
3. Store live artifacts under `.tmp/manual-cmux/`; summarize only durable conclusions in `evidence.md`.
4. Remove stale status language rather than preserving it as history.
5. Keep paths/symbols/tests in `evidence.md`; keep procedures in setup/evaluation/skills.
6. APPEND owns timeless runtime reasoning, not implementation maps or postmortems.
7. A new document requires a distinct durable responsibility, explicit owner, and deletion/merge condition.
8. When source changes invalidate documentation, update the owner document and tests in the same slice.
9. Never duplicate provider secrets or raw config values in docs.
10. Verify links, paths, schemas, lifecycle names, hashes, model/session policy, and removed terminology before completion.

## Frontmatter schema

Every canonical Markdown file carries one YAML frontmatter block. qmd/`docs_search` ranks by section heading, indexed section and preamble body (FTS5 plus vectors), and a path-derived authority prior (`src/core/qmd-docs-search.ts::authorityRole`); frontmatter fields do not change that prior. On the first `read` or `docs_search` appearance of each `.md` file in one extension session, [`src/core/markdown-frontmatter.ts`](../src/core/markdown-frontmatter.ts) supplies valid leading YAML as numbered current rows. A metadata-only digest deduplicates unchanged appearances across both tools and re-exposes the rows after frontmatter changes; body-only edits do not. The state is session-local and never persisted. Each file independently gets up to 300 estimated metadata tokens (four UTF-8 bytes per token): full YAML when it fits, otherwise exact `title` and `description` rows even when those required rows exceed the allowance. Source lines are never truncated. When visible frontmatter includes scalar or list `code`/`related` values, [`src/core/frontmatter-relationships.ts`](../src/core/frontmatter-relationships.ts) resolves them against current project source through the same selector contract as `read`, reporting valid, invalid, ambiguous, and unverified counts without automatically reading the targets. Hidden fallback fields are not validated. The certain value of frontmatter is cold-reader context in `read` and a structured owner/neighbor manifest; its retrieval-vocabulary value depends on the preamble being indexed. Validation does not create graph edges: the reliable mechanism for real `explore(map)`/Graphify edges remains inline Markdown links and `path::symbol` references in the document body. A consequential relationship should therefore appear both as a frontmatter field and as an inline body link. Keep metadata honest: stale metadata is misinformation, not decoration. The retrieval contracts this schema serves are `docs/evidence.md:current-evidence-map/documentation-retrieval-and-live-markdown#2`.

Frontmatter relationship paths are relative to the Markdown owner's nearest package root (`package.json`, `Cargo.toml`, or another supported package marker), while the outer detected project remains the escape boundary. This keeps `src/...` and `docs/...` references valid inside nested monorepo packages without allowing absolute paths or project-root escapes.

`read` always applies this first-exposure contract. `docs_search` expands frontmatter only for results whose displayed final ranking score is at least `0.60` (the current medium-high confidence boundary); lower-scoring sections remain ranked without file I/O, relationship validation, snapshot authority, or exposure-state mutation. A later qualifying `docs_search` result or direct `read` can still expose that file's metadata.

| Field | Required | Meaning and retrieval role |
|---|---|---|
| `title` | yes | One query-shaped title. Exact-heading matches receive the strongest title prior. |
| `description` | yes | One sentence: what this file owns and why it matters. Front-load distinctive retrieval vocabulary; indexed in the preamble. |
| `tags` | yes | 3–8 lowercase-hyphenated terms; the component plus the concepts a future query would use. Indexed preamble vocabulary. |
| `owns` | yes | The one question or claim this file is the authority for. Disambiguates near-duplicate files for cold readers and ranking. |
| `audience` | yes | `agent`, `operator`, `contributor`, or `mixed`. Retrieval-intent signal and cold-reader orientation. |
| `code` | recommended | Exact implementation owners as `path/to/file.ts::symbol` when a specific function or class owns the claim, or the file path when the whole module is relevant. Cold-reader manifest; also link the owner inline in the body to create a graph edge. |
| `related` | recommended | Exact related doc references as `docPath:full-slug-path-from-H1#level` read-selectors when one section owns the relationship, or the file when the whole document is relevant (never a top-heading `#1`). The form `read` accepts and `docs_search` returns as `read_selector`. Cold-reader manifest; also link inline in the body to create a doc-to-doc graph edge. |
| `created` | yes | Date the file first existed (`YYYY-MM-DD`). codeweave-pi supplies it when creating Markdown if absent; supplied values are preserved. |
| `updated` | yes | codeweave-pi adds or refreshes this on content-changing Markdown writes/edits, quoted as `YYYY-MM-DD HHZ` in UTC. No minutes or seconds. |
| `status` | yes | `active` (current truth), `completed` (closed decision record), or `stale` (superseded, pending removal). |
| `decided` | decision records | Date the recorded decision was settled. |

[`src/core/updated-field-stamp.ts`](../src/core/updated-field-stamp.ts) owns automatic Markdown timestamps for `write` and `edit`, including goal and skill files. Missing frontmatter or fields are added; existing YAML and body formatting are preserved without reserializing the document. Invalid YAML, duplicate keys, flow-style root maps and complex/anchored `updated` values are refused before that file lands. Dependencies and pristine upstream material are excluded. No-op edits/overwrites, moves and external editor/shell writes do not advance timestamps. The transformation happens before the mutation commits: returned hashes, snapshots and coordinates describe the final content, including inserted metadata lines. Agents need not issue a separate timestamp edit; caller-authored changes retain normal row-authority checks.

Rules:

1. Match this schema exactly; do not invent parallel fields (`keywords`, `owner`) in neighboring files.
2. `description`, `tags`, and `owns` are retrieval claims: update them with the content, or ranking drifts from truth.
3. Prefer exact `path::symbol` in `code`. In `related` and in body cross-references, point at the exact owning section with a read-selector (format below) when one section owns the claim; use a file-level reference only when the whole document is the honest neighbor. Vague directory globs help neither cold readers nor graph edges, so list concrete owners or omit the field.
4. A file added to or renamed within the `current_authority` set (canonical `docs/*.md`, `docs/decisions/`, `AGENTS.md`, `native/*/{ARCHITECTURE,README}.md`) must also be registered in `authorityRole()` or it silently loses its ranking prior.
5. Third-party and dependency content is never indexed or edited. `node_modules/`, `.runtime/`, `vendor/`, and any git- or pip-installed package tree (including their `README.md`, `CHANGELOG.md`, and `LICENSE.md`), plus vendored upstream docs (`native/qmd/test/eval-docs/`, `native/pi-nav/benchmark/`, `native/pi-nav/prompts/`, pristine upstream `README.upstream.md`), stay exactly as shipped. They carry no frontmatter and never get any; a doc audit stops at the package boundary. Only docs this repository authors get the schema, and a clean index excludes every dependency tree by construction.

### Cross-reference format

A cross-reference points at the exact section that owns a claim, in the read-selector form `read` accepts and `docs_search` returns as `read_selector`:

```text
docPath:full-slug-path-from-H1#level
```

The slug path is hierarchical and must start at the document's H1 slug; each heading is lowercased with runs of non-alphanumerics collapsed to `-`. The `#level` suffix (heading depth) is mandatory. Example — the R5 status section of current-truth:

```text
docs/current-truth.md:current-truth-and-future-work/r5-clean-break-status#2
```

Verified resolver behavior: the full hierarchical path with `#level` resolves; a leaf-only slug (`r5-clean-break-status#2`), a bare heading (`## R5 clean-break status`), and a missing `#level` are all refused.

Apply section precision when one section owns the claim, and reference the shallowest section that owns it (often an H2 rather than a deep H3) to limit coupling. Read-selectors are heading-coupled: renaming any ancestor heading breaks the references beneath it, so re-verify that selectors still resolve after a heading rename. In prose, write the selector as inline code so a future agent can copy it straight into `read`; the leading `docPath` is also the path seed `explore(map)`/Graphify follows. The cross-reference map built on this format is `docs/README.md:jeito-codeweave-pi-agent-entrypoint/documentation-cross-reference-map#2`.

## APPEND system maintenance

Pi loads the host-owned `~/.pi/agent/APPEND_SYSTEM.md` before its core instructions. This extension does not ship or inject a second APPEND: APPEND owns durable cross-tool selection, composition, and adaptation strategy; each tool's registered description, parameters, and promptGuidelines own its operating manual; runtime result and error messages own recovery; canonical docs own product rationale and maintenance procedures. The doctrine-side ownership boundary is `docs/harness-doctrine.md:navigation-harness-doctrine/instruction-ownership#2`; the authoring contract is `codeweave-pi/docs/tool-guidance-architecture.md`.

When reviewing agent-facing guidance:

1. Keep internal backend names out of public descriptions; describe what the tool does.
2. Keep exhaustive accepted fields, combinations, and limits in the tool's description/parameters. Put only non-obvious composition and adaptation leftovers in promptGuidelines; never duplicate a fact across layers. Runtime messages own recovery — improve the message, don't pre-teach around it.
3. Ensure every public feature is discoverable through the tool's description/parameters/promptGuidelines, APPEND cross-tool strategy, result evidence/recovery, and evaluation. A source-only feature is not operationally shipped.
4. Verify loaded behavior in a fresh Pi session when the claim concerns tool choice or agent experience.
5. Use a context dump only to diagnose the host prompt; do not add a repository-local fallback or duplicate the global doctrine.
