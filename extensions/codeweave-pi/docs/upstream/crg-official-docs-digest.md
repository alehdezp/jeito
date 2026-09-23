---
title: "CRG / code-review-graph official docs digest"
description: "Pinned source digest of CRG upstream commands, skills, and the project-owned watch/daemon patch contract, with integration mistakes and the smallest reliable operating model."
tags: [jeito-codeweave-pi, upstream, crg, code-review-graph, evidence-digest]
created: 2026-06-22
updated: 2026-09-21
status: historical
owns: "Historical CRG upstream evidence; not current codeweave-pi runtime guidance"
audience: contributor
related: [../decisions/r5-crg-clean-break.md, ../current-truth.md]
---

# CRG official docs digest

Historical evidence for the retired Code Review Graph dependency. codeweave-pi no longer selects CRG as a runtime, optional backend or compatibility route. This digest preserves upstream findings behind [the superseded R5 decision](../decisions/r5-crg-clean-break.md); use [current truth](../current-truth.md) for the Core replacement.

Fetched/read initially on 2026-06-22; revalidated against stock CRG 2.3.7 and the R5 implementation on 2026-07-21.

## Source documents

- `tirth8205/code-review-graph - docs/COMMANDS.md`
  - https://github.com/tirth8205/code-review-graph/blob/main/docs/COMMANDS.md
- `tirth8205/code-review-graph - docs/LLM-OPTIMIZED-REFERENCE.md`
  - https://github.com/tirth8205/code-review-graph/blob/main/docs/LLM-OPTIMIZED-REFERENCE.md
- GitHub API listing for `skills/`
  - https://api.github.com/repos/tirth8205/code-review-graph/contents/skills?ref=main
- CRG FAQ: <https://github.com/tirth8205/code-review-graph/blob/main/docs/FAQ.md>
- `TESTED_BY` direction defect: issue [#515](https://github.com/tirth8205/code-review-graph/issues/515) and unmerged PR [#559](https://github.com/tirth8205/code-review-graph/pull/559), fetched/read 2026-07-16.
- Skill documents:
  - `skills/build-graph/SKILL.md`
  - `skills/debug-issue/SKILL.md`
  - `skills/explore-codebase/SKILL.md`
  - `skills/refactor-safely/SKILL.md`
  - `skills/review-changes/SKILL.md`
  - `skills/review-delta/SKILL.md`
  - `skills/review-pr/SKILL.md`

## Upstream capability claims

### MCP/tool surface

`COMMANDS.md` documents CRG MCP tools across several categories:

- Build/setup: `build_or_update_graph_tool`, `run_postprocess_tool`, `embed_graph_tool`.
- Minimal and review context: `get_minimal_context_tool`, `get_review_context_tool`, `detect_changes_tool`.
- Relationship/graph queries: `query_graph_tool`, `traverse_graph_tool`, `get_impact_radius_tool`, `semantic_search_nodes_tool`.
- Architecture and flow: `get_architecture_overview_tool`, `list_flows_tool`, `get_flow_tool`, `get_affected_flows_tool`, `list_communities_tool`, `get_community_tool`.
- Health/architecture: hub nodes, bridge nodes, knowledge gaps, surprising connections, suggested questions.
- Refactor/wiki/multi-repo: `refactor_tool`, `apply_refactor_tool`, wiki generation/readback, repo registry, cross-repo search.

What this proves: upstream CRG is documented as more than an architecture overview; it includes review, change impact, minimal task context, flows, communities, semantic search, and refactor planning.

What this does not prove: it does not prove every tool is safe for Pi query-time use or belongs in the public Pi tool surface.

### Token-efficient workflow guidance

`LLM-OPTIMIZED-REFERENCE.md` tells agents to start with `get_minimal_context_tool(task="your task")`, then use minimal detail levels unless more detail is needed. It describes `context_savings` as an estimated compact hint, not exact tokenization.

What this proves: CRG's docs are explicitly agent-workflow-oriented and treat minimal context as a first-class operation.

What this does not prove: it does not prove the current Pi wrapper exposes `get_minimal_context_tool` or that its output is always enough for actual implementation tasks.

### Review/change focus

`COMMANDS.md` says:

- `detect-changes --brief` is read-only and asks for impact of current changes against an existing graph.
- `update --brief` re-parses changed files into the graph first, then runs similar analysis.
- Review workflows compute blast radius, changed files, affected flows, risk scoring, and test gaps.

What this proves: upstream CRG distinguishes read-only change inspection from graph-updating mutation, and its documented sweet spot includes code review / impact / risk analysis.

What this does not prove: it does not prove that a stale graph makes `detect-changes` fair, or that `update` is permissible under query-time constraints.

### Storage, locality, embeddings, telemetry

`LLM-OPTIMIZED-REFERENCE.md` describes the DB file as `.code-review-graph/graph.db`, says core graph/review workflows are local and no telemetry is present, and says optional cloud embeddings send embedded source snippets to the selected provider only when selected. It also says `semantic_search_nodes_tool` can use vectors when available and fallback to keyword/FTS when not.

What this proves: CRG can be local for core workflows, but embeddings/provider modes are separate setup/provider-cost questions.

What this does not prove: it does not prove the locally populated CRG graph is configured as a Pi lane, fresh, or equivalent to Graphify's local graph.

### Source locations and indexed file identity

Inspected against stock CRG 2.3.7 (`6a1ee1c7063cc35cfa5ff12b8198c29360f3e4ad`) and the ordered project patch result (`fa36ff5f457f1abdde9ff60ac569002a7e9573cf`).

- Source: <https://github.com/tirth8205/code-review-graph/blob/main/code_review_graph/graph.py> and <https://github.com/tirth8205/code-review-graph/blob/main/code_review_graph/incremental.py>.
- `GraphNode` stores `file_path`, `line_start`, `line_end`, and optional `file_hash`; `GraphEdge` stores `file_path` and one source `line`.
- Build/update reads raw file bytes once and stores lowercase SHA-256 of those exact bytes as `file_hash` on each node for that file.
- This supports a versioned source locator: jeito-codeweave-pi can preserve the graph relationship, compare the indexed raw hash with a current raw hash, and retrieve the exact current range only when the version contract permits it.
- It does **not** make the CRG hash a jeito-codeweave-pi edit tag. The public edit hash uses a different normalized-text contract, and edge rows need a bounded lookup to obtain their file's node hash.
- Implemented: the R1 source-claim adapter preserves graph evidence and promotes only current exact ranges whose indexed digest matches current bytes.
- Prove with: node/edge/file hash fixtures, atomic replace/move watcher fixture, current-hash match, stale-hash mismatch preserving relationship output, and one batched hash lookup per unique file.
- Revalidate when: the owned CRG version, graph schema, parser line semantics, hash implementation, or wrapper normalization changes.

### Reference completeness and owned `TESTED_BY` divergence

The upstream FAQ describes LSP as the stronger source for provably complete, type-aware single-symbol references and live diagnostics. CRG is broader and persistent across many languages, but call resolution is heuristic and its edges distinguish `EXTRACTED`, `INFERRED`, and `AMBIGUOUS` provenance. The same FAQ distinguishes fresh setup-free grep for literal/one-hop lookup from graph traversal for multi-hop callers, impact, tests, flows, and communities; its token-reduction benchmark compares with whole-corpus reading, not a skilled bounded grep workflow.

CRG 2.3.7 corrects the `TESTED_BY` consumer direction and evidence-backed bare-target qualification defects described above. The R5 candidate does not retain the old `.10` fork. It starts from exact 2.3.7 and applies only three auditable patches: agent query, reconciliation, and mandatory embeddings. Patch behavior and deletion conditions are recorded below.

## Skill workflow facts

The fetched CRG skills emphasize different workflows:

- `build-graph`: check graph stats, build/update graph, verify file/node/edge/language counts; stores graph in `.code-review-graph/graph.db`.
- `explore-codebase`: stats -> architecture overview -> communities -> semantic search -> query graph callers/callees/imports -> flows.
- `debug-issue`: semantic search -> callers/callees -> flow -> recent changes -> impact radius.
- `review-changes`: detect changes -> affected flows -> tests_for -> impact radius.
- `review-delta`: call optimized docs section, update graph, get review context, inspect blast radius.
- `review-pr`: identify diff, update graph, get review context, get impact radius, deep-dive high-risk files.
- `refactor-safely`: refactor suggestions/dead code/rename preview/apply, then detect changes.

Safety implication: several skills call build/update/apply-style operations. Those are useful upstream workflows but are not query-time-safe without explicit setup or mutation approval.

## CRG facts most relevant to Pi redesign

- CRG's distinct documented value is change-aware code-review context: minimal task context, blast radius, risk, affected flows, test gaps, and structured graph relationships.
- CRG has documented query-style tools that can be read-only when pointed at an existing graph (`detect_changes`/`query_graph`/architecture/flows/impact), but freshness matters.
- CRG setup/update/embed/watch/postprocess paths are mutation/setup paths and must not run inside query-time navigation without explicit approval.
- CRG semantic search should not be judged without noting whether embeddings exist; upstream docs say fallback can be keyword/FTS.
- If Pi exposes CRG, the useful unit may be task/context/review/impact surfaces, not only architecture overview.

## Native CRG feature inventory

The installed `code-review-graph` CLI directly exposes these command families:

- lifecycle: `build`, `update`, `reconcile`, `postprocess`, `embed`, `watch`, `status`;
- read/query: `query`, `search`, `impact`, `detect-changes`, `flows`, `flow`, `communities`, `community`, `architecture`, `dead-code`, `large-functions`;
- generated views and refactoring: `visualize`, `wiki`, `refactor`;
- serving/integration: `serve`, `mcp`, `install`, `uninstall`;
- repository ownership: `register`, `unregister`, `repos`;
- multi-repository watch ownership: `daemon start|stop|restart|status|add|remove|logs`.

The relationship query patterns in 2.3.7 are `callers_of`, `callees_of`, `imports_of`, `importers_of`, `children_of`, `tests_for`, `inheritors_of`, and `file_summary`. `inheritors_of` follows both inheritance and implementation edges. `tests_for` combines graph evidence with explicitly labelled naming fallback. File lookup canonicalizes repository paths. Native rows carry graph identity, source ranges where available, edge provenance/confidence, communities, flows, and query status.

CRG also provides:

- persistent multi-language nodes and edges;
- FTS and vector search;
- exact and fuzzy graph traversal;
- impact radius, risk, test-gap, flow, and community analysis;
- incremental Git-aware update;
- watchdog-based filesystem update;
- per-repository and multi-repository watcher modes;
- canonical local SQLite storage at `.code-review-graph/graph.db`;
- source hashes and line locators usable as versioned evidence, but not as Pi edit hashes.

These features are native CRG capabilities. Pi wrappers should preserve them, not reconstruct weaker summaries or require unrelated backends before they can be queried.

## Stock 2.3.7 behavior that agents must know

### The simple path really is simple

For a normal tracked repository, the direct operating sequence is:

```text
code-review-graph build --repo <root>
code-review-graph embed --repo <root> --provider <provider> --model <model>
code-review-graph watch --repo <root> [embedding options]
```

or register the repository once with `daemon add` and let the stock daemon own its watcher. `status`, `query`, `search`, and the other read commands then use `.code-review-graph/graph.db`. Graphify, QMD, Pi state mirrors, and wrapper architecture-overview output are not prerequisites for CRG itself.

### File discovery

Stock `collect_all_files` uses Git-tracked files when the repository has them. Its filesystem fallback is used only when the tracked set is empty. It applies CRG/Git ignore policy, language detection, binary rejection, path safety, and symlink rejection. Therefore a large dirty worktree can still omit newly created untracked source files. That is expected stock behavior, not watcher failure. Do not reintroduce a custom walker to hide an uncommitted repository-state problem; either track the source or state the coverage limitation.

### Build and embeddings are distinct upstream concepts

Upstream treats initial `build` and `embed` as separate commands. A build can produce a useful graph without vectors. R5's mandatory-embedding mode adds a fail-closed adapter contract, but should not obscure the native distinction. The reliable initial sequence remains graph build, embedding publication, then watcher ownership.

### Provider identity

The OpenAI-compatible provider reads `CRG_OPENAI_API_KEY` and `CRG_OPENAI_BASE_URL`; merely having `OPENAI_API_KEY` does not satisfy the native provider constructor. The project lifecycle may map an accepted credential into these variables, but direct CLI probes must do the same without printing values. Provider identity is endpoint-aware: changing the OpenAI-compatible base URL requires a distinct embedding generation.

The stock `search` CLI has no provider/model flags and may select its default local provider. When a graph was embedded with an online provider, agent-facing semantic search must call the provider-aware query function/wrapper with the selected provider/model. A provider mismatch is a truthful unavailable result, not permission to rebuild, switch provider, or report lexical fallback as semantic success.

### Watch modes

CRG offers both a direct per-repository `watch` command and a multi-repository daemon. `serve --auto-watch` is another upstream entry point. Project integration must choose one owner for a repository. Starting a new daemon without stopping or reconciling the previous owner can create duplicate watchers against the same database. Runtime replacement must stop the old owner first or preserve it until an atomic handoff succeeds.

The daemon's initial-build decision is based on database presence. An accidentally created empty `.code-review-graph/graph.db` can bypass the absent-database build path. Query time must never create that file. Setup should treat an empty/uninitialized database as needing the ordinary direct build, not add a second recovery framework.

## The three R5 patches and their deletion conditions

### `0001-agent-query`

Adds only behavior needed for trustworthy agent queries:

- kind filtering occurs inside candidate retrieval rather than after a small mixed-kind window;
- read-only query mode does not create tables or run setup migrations;
- required semantic search reports explicit execution/readiness and fails closed;
- File-node search remains intentionally lexical;
- strict traversal accepts exact identity, stops on ambiguity, and preserves directional edges.

Delete any part when a future upstream release proves the same neutral contracts. Do not retain it because of historical ownership.

### `0002-reconciliation`

Adds exact path reconciliation, atomic move handling, delete postprocessing, startup reconciliation, a bounded lease, and explicit mutation-hook ingestion. It preserves stock watcher ownership rather than adding a second scheduler. Delete behaviors as upstream gains equivalent move/delete/startup contracts.

### `0003-mandatory-embeddings`

Adds graph/embedding generation publication, endpoint-aware provider identity, stale-vector pruning, mutation dirtying, exact coverage/orphan validation, and required provider/model propagation through build/watch/daemon paths. Missing, stale, mismatched, or failed vectors are unavailable; they never silently become healthy lexical semantic search. Delete behaviors when upstream exposes equivalent mandatory-generation semantics.

## Integration mistakes observed during R5

These were jeito codeweave-pi failures, not CRG failures:

1. **Mirrored readiness became a gate.** Pi rejected a live healthy CRG database because `.pi/navigation/state.json` still said `dirty`. CRG's own provider/generation query is the authority; mirrored lifecycle state is diagnostic only.
2. **Unrelated structural output became admission.** Semantic search succeeded, but setup rejected the lane because architecture overview or `file_summary` returned zero projected leads. Required semantic execution is sufficient for semantic admission; optional analytical views must not gate it.
3. **Graphify blocked CRG.** Architecture and Graphify refreshes shared a long-running `prepared` transaction. A slow Graphify extraction prevented a three-second CRG convergence. Backend refresh locks must be lane-specific; CRG has no Graphify dependency.
4. **Runtime handoff created duplicate daemons.** Replacing files while the old daemon remained alive produced two watcher sets. Stop/hand off the old owner before publishing the new runtime and preserve the last-good runtime for rollback.
5. **An empty database looked initialized.** An empty canonical database existed before daemon registration, so the stock absent-database initial-build path did not run. Run the direct build; do not infer graph readiness from path existence.
6. **Credential names were assumed.** Direct embedding failed because the shell had `OPENAI_API_KEY` but CRG required `CRG_OPENAI_API_KEY` and `CRG_OPENAI_BASE_URL`. Map accepted credentials explicitly and never print them.
7. **CLI provider defaults were ignored.** Direct `search` selected local embeddings against an online-published generation. Use the provider-aware API/wrapper for agent semantic search.
8. **Untracked candidate source was expected in the graph.** The active worktree contained newly added but untracked R5 files; stock tracked-file discovery correctly omitted them. Do not patch CRG around repository status.
9. **Wrapper arguments drifted.** The loaded Pi wrapper passed `--index` to the reset wrapper even though the wrapper no longer accepted that obsolete argument. Public caller and wrapper CLI contracts must be tested together in the loaded runtime.
10. **The wrong Python was used for tests.** Packaged/runtime/system interpreters intentionally lacked `pytest`. Source verification belongs to `uv run --frozen pytest`; production runtime verification belongs to CRG probes and lifecycle tests.

## Minimal reliable Pi integration

The target boundary is deliberately small:

```text
verified CRG package
  -> direct build of canonical database when absent or uninitialized
  -> explicit embed for the selected provider/model
  -> one stock watch owner
  -> read-only wrapper queries the live database
```

Rules:

- CRG must not wait for Graphify, QMD, or another backend.
- Query time never builds, embeds repository nodes, starts daemons, repairs state, or creates a database.
- Setup may install, build, embed, and register one watcher.
- Exact mutation hooks call CRG's reconciliation entry point; they do not create another watcher/scheduler.
- The live CRG query result owns semantic readiness. State/config may describe desired provider/model and report diagnostics, but stale mirrors do not override a healthy live result.
- A failed semantic query remains unavailable. Do not provider-hop or silently call lexical output semantic.
- Optional architecture, flow, community, impact, or file-summary views are useful evidence but do not gate basic search/traversal availability.
- Preserve native status, identities, edges, provenance, scores, ranges, coverage, and diagnostics.
- Stop the previous daemon before runtime replacement; preserve the last-good directory until loaded verification passes.
- Verify one direct search and one exact relation through the active public tools after reload.

## Troubleshooting without inventing infrastructure

Use CRG's own evidence first:

```text
code-review-graph status --repo <root>
code-review-graph daemon status
code-review-graph query ...
code-review-graph build --repo <root>
code-review-graph embed --repo <root> --provider <provider> --model <model>
```

Check credential **presence by name only**. Never print values. Confirm node/vector counts and provider/generation identity from the canonical database or provider-aware read API. If direct CRG works while Pi fails, inspect wrapper arguments, path/config projection, and stale mirrored gates before changing CRG. If direct CRG fails, reproduce against unmodified upstream before admitting another patch.

## Honest current loaded-runtime finding

On the first post-publication reload, direct CRG build, embedding, daemon watch, status, and provider-aware semantic search worked. Pi's loaded `explore` still failed because the TypeScript caller supplied obsolete `--index` to the reset wrapper. That external-database argument has now been deleted from `explore`, `trace`, diff, and internal context callers; direct wrapper search and callers queries pass. A fresh loaded `explore` and `trace` verification remains required before R5 can be called complete.
