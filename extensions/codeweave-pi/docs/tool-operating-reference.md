---
title: "jeito codeweave-pi tool operating reference and coverage audit"
description: "Exhaustive inventory of jeito codeweave-pi tools plus the APPEND-owned jeito Shell execution surface, with optimal call construction and coverage auditing."
tags: [jeito-codeweave-pi, jeito-shell, tool-reference, operational-literacy, call-construction, coverage-audit]
created: 2026-07-25
updated: 2026-09-21
status: active
owns: "Exhaustive public tool features, parameters, and optimal call construction"
audience: agent
code: [src/tools/explore.ts, src/tools/trace.ts, src/tools/docs-search.ts, src/tools/grep.ts, src/tools/find.ts, src/tools/ls.ts, src/tools/read.ts, src/core/source-selector.ts, src/core/frontmatter-relationships.ts, src/tools/diff.ts]
related: [docs/README.md, docs/harness-doctrine.md, docs/evidence.md]
---

# jeito codeweave-pi tool operating reference and coverage audit

This document inventories every public jeito-codeweave-pi tool and every public parameter currently registered by `index.ts`. It is the expanded review source for checking that public descriptions, parameters, promptGuidelines, tests, and live evaluation expose the real product rather than a remembered subset. Per-tool operating manuals live in each tool's registered description, parameters, and promptGuidelines; APPEND keeps only cross-tool doctrine.

Scope: the eleven registered extension tools—`explore`, `trace`, `docs_search`, `grep`, `find`, `ls`, `read`, `diff`, `lsp_validate`, `edit`, `write`—plus host execution tools `bash`/`jobs`, because APPEND composes them with project evidence. Optional web, research, orchestration, session-memory, and skill-specific tools are owned by their own schemas/skills and are outside this extension reference.

Durable responsibility: exhaustive public feature/parameter inventory, implementation-derived optimal call construction, and cross-layer coverage audit. Merge or delete this document only if another canonical owner can preserve the complete per-tool inventory and the schema-to-doc drift test without reducing reviewability.

Maintenance enforcement: `~/.pi/agent/skills/op-edit-system-prompt/SKILL.md` requires this inventory and implementation-derived query audit whenever `APPEND_SYSTEM.md` tool guidance changes; `docs/harness-doctrine.md` owns the corresponding product invariant and layered ownership boundary.

## How to audit tool coverage

For every tool, verify five layers:

1. **Intent:** the tool's description says which uncertainty the tool owns.
2. **Construction:** the tool's parameters explain optimal query/target/mode construction.
3. **Leverage:** advanced modes and every public parameter are discoverable.
4. **Interpretation:** result identity, diagnostics, omissions, authority, and continuation are explained.
5. **Adaptation:** the tool's promptGuidelines explain refinement, re-anchoring, continuation, evidence-class transition, and stop.
The operational-literacy bridge this audit checks is `docs/harness-doctrine.md:navigation-harness-doctrine/operational-literacy-bridges-reasoning-into-tool-calls#2`; the behavioral evaluation is `docs/evaluation-workflow.md:agent-evaluation-workflow/operational-literacy-evaluation#2`.

Coverage labels in this document:

- **APPEND covered:** cross-tool doctrine in APPEND covers the feature's strategy; per-tool text covers its construction.
- **Schema covered:** public description/parameter text exposes the executable mechanic.
- **Test covered:** focused automated evidence exercises or locks the contract.
- **Behavioral evaluation:** fresh GPT-5.6 Sol/Luna evaluation measures whether agents apply the guidance; it is not a readiness or availability condition for the tools.
- **Reference only:** observable parser tolerance or recovery exists, but the tool's canonical text teaches the safer canonical form.

Automated audit: run `node --test tests/v3-tool-operating-reference.test.mjs` to compare this document with registered schemas and doctrine. Run `PI_APPEND_SYSTEM_PATH="$HOME/.pi/agent/APPEND_SYSTEM.md" PI_APPEND_MAINTAINER_SKILL_PATH="$HOME/.pi/agent/skills/op-edit-system-prompt/SKILL.md" node --test tests/v3-tool-operating-reference.test.mjs` to additionally verify every registered parameter/consequential bridge in the host prompt and the maintenance workflow that prevents regression.

Global continuation rule: when output returns `next_page`, preserve tool mode, identity/query, scope/root, limit, and generation. Restart at page 1 if generation changes. Global batching rule: batch only independent items whose results are all required regardless of earlier results.

Confidence rule: registered prepared tools are normal callable evidence capabilities. Call the owning tool whenever its evidence class matters; do not preflight or speculate about readiness, indexing, freshness, or backend health. Interpret an actual diagnostic only after the call and only for that returned claim. Lexical or otherwise reduced modes still return useful prepared evidence and do not lower confidence in later calls.

## `explore`

Code owner: `src/tools/explore.ts`; code backend: `src/core/pi-nav-native.ts` over the package-owned indexed graph; map shaping: `extractGraphifySymbolSeeds`, `extractGraphifyPathSeeds`, `shapeGraphifyMapQuery`.
The evidence class explore owns is `docs/harness-doctrine.md:navigation-harness-doctrine/evidence-capabilities-not-routes#2`; the behavior map is `docs/evidence.md:current-evidence-map/public-prepared-tools#2`.

### `explore` parameters

| Parameter | Modes | Meaning and optimal use | APPEND |
|---|---|---|---|
| `view` | all; required | `code` for implementation identity/topology; `map` for cross-domain graph neighborhoods. | Covered |
| `operation` | code only | `search` discovers identities; `traverse` starts from one exact identity. | Covered |
| `anchor` | code only | Search query or exact traversal identity. Never use `query` in code view. | Covered |
| `query` | map only | Concrete keyword-seeded identity packet: one exact path/callable/config key or 1–3 distinctive symbol/path anchors. Never use in code view. | Covered |
| `kind` | code search only | Optional File/Class/Function/Method/Type/Test/Interface/Trait filter. Leave unset while owner kind is unknown. | Covered |
| `depth` | code traverse only | BFS depth 1–6, default 2. Raise only for farther topology, not merely more rows. | Covered |
| `scope` | all | Resolves the owning prepared project. It does not filter code/map results to a subtree. | Covered |
| `page` | all | One-based structural continuation page. Preserve request and generation. | Covered |
| `limit` | all | Page size 1–300, default 80. Omit it for normal calls; raise it only when reported omissions could change the answer and one wider page is useful. Code and map page native collections without changing search/traversal semantics. | Covered |

### `explore` limit guidance

- Start normal search, traversal, and map calls by omitting `limit`; the default 80 is intentionally broad.
- Raise `limit` toward 300 only for an intentionally broad ownership/topology audit where omitted candidates, nodes, or edges could change the decision and the larger output is jointly useful.
- Prefer `page` with the unchanged request when continuation order and generation identity matter more than fitting the evidence into one response.
- Map applies `limit` independently to NODE and EDGE collections, so the default can return up to 80 nodes plus 80 edges while retaining Start context.
- Use a smaller limit only for an explicitly bounded preview, not as a habitual token-saving default.

### Optimal `explore(code, search)` query construction

Invocation trigger: when a consequential answer depends on which implementation owns a behavior and no qualified owner has been observed, call code search as soon as one behavior/responsibility, signature fragment, or distinctive identifier is known. Do not wait for an exact symbol. A later stronger identity triggers another search when it could change the owner; recognizing the omission during an active task means make the call rather than write a postmortem.

Default code-search call:

- describe one behavior or responsibility in project vocabulary;
- include any known exact dotted, `snake_case`, or `PascalCase` identifier;
- use a signature fragment or distinctive type/function packet when available;
- avoid conversational questions, unrelated behaviors, and hoped-for output categories;
- keep `kind` unset unless the expected node kind is evidence, not a guess.

Why: current code search merges exact full-text ranking and full-query embeddings. Identifier-shaped terms receive qualified-name/kind boosts. A concise behavior phrase provides semantic meaning while the identifier improves precision.

After a result reports FTS/keyword mode:

- use one exact observed identifier, qualified fragment, or short exact name;
- do not lengthen the prose after a zero;
- treat a lexical zero from vague behavior language as unresolved.

Why: full-text search quotes the complete query; keyword fallback ANDs every whitespace-separated word. Long natural prose therefore becomes too restrictive without embeddings.

Inspect candidate kind, signature, path, qualified name, retrieval mode, secondary candidates, page omissions, and `next_page`. Mixed results prioritize non-test candidates and report how many tests were excluded plus the `kind:"Test"` opt-in; test-only result sets remain visible because they can locate the subsystem. Neither rank one nor subsystem connection proves implementation ownership. Reuse vocabulary from a promising candidate in a more discriminating follow-up while identity choice can change the boundary.

Example: `explore({view:"code", operation:"search", anchor:"exact occurrence search registerGrepTool"})`.

### Optimal `explore(code, traverse)` operation

Invocation trigger: when an exact qualified symbol or File identity is known but its callers, dependencies, tests, containment, or flow could change the answer, traverse it instead of inferring the neighborhood from separate source hits. Re-traverse after a stronger later identity when the prior neighborhood no longer establishes the boundary.

Copy an exact search result `qualified_name`, an exact symbol learned elsewhere, or an exact File identity. Start at depth 2; use depth 1 for immediate neighbors. Distinguish increasing `depth` (farther graph frontier) from increasing `limit`/`page` (more rows from the same traversal). Inspect edge direction/kind, provenance/confidence, generation, native truncation, and separate node/edge omissions. Public traversal orders edges touching the start identity first, then by traversal depth/order, so the first edge page remains connected to the requested neighborhood without deleting native edges.

Traversal is not required to follow search: source, docs, diff, tests, map, or an earlier trace may already provide the exact identity. Use `trace` when one edge direction remains; use `read` when current bytes remain.

Example: `explore({view:"code", operation:"traverse", anchor:"src/tools/grep.ts::registerGrepTool", depth:2})`.

### Optimal `explore(map)` query construction

Invocation trigger: when a task or the gathered evidence spans multiple project components or layers and the answer depends on their unobserved connection, call map as soon as one concrete path, symbol, config key, or project phrase is known. Do not wait for every component or for the missing edge to be predictable. Separate `docs_search`, source, or code-search hits do not close the topology claim. Re-enter map when any result supplies a stronger identity that could change the connection model. If the omission is recognized while the task remains active, make the call rather than writing a postmortem.

Map query matching is keyword-seeded, not semantic:

- put the strongest existing project path first;
- add only a few callable, config-key, or symbol anchors;
- `file.ext::symbol`, paths, and filenames become path seeds;
- `foo()`, qualified/dotted names, camelCase, PascalCase, snake_case, and underscore/config-like names become symbol seeds;
- ordinary lowercase natural-language prose remains weaker native text;
- never append hoped-for categories such as `tests docs owners`.

If any current path exists, the first project path becomes the requested exact anchor. The wrapper uses native `explain` resolution to obtain that path's—or a `file::symbol` query's—exact graph node ID, then queries the neighborhood from that ID. Inspect `query_anchoring`, `path_anchor`, `exact_anchor_id`, `exact_anchor_status`, and actual Start nodes. `retained` proves the requested identity is a Start; `rejected` makes the call a warning and leaves only the actual Starts usable. An incidental path placed first can therefore displace the intended owner.

Map NODE and EDGE rows page independently while preserving Start context. Re-anchor from stronger returned paths/callables/keys. Exact returned graph nodes feed `trace(path|explain)`.

Example: `explore({view:"map", query:"src/core/navigation-clean.ts::graphifyQueryEnv"})`.

Coverage: **APPEND/schema covered; focused mixed/test-only candidate selection, exact traversal, start-relative edge ordering, map anchoring, paging, and direct-current calls exist.**

## `trace`

Code owner: `src/tools/trace.ts`; relations: `callers`, `callees`, `imports`, `importers`, `tests`, `path`, `explain`.
The trace evidence class is `docs/harness-doctrine.md:navigation-harness-doctrine/evidence-capabilities-not-routes#2`.

### `trace` parameters

| Parameter | Meaning and optimal use | APPEND |
|---|---|---|
| `target` | One identity. Mutually exclusive with `targets`. | Covered |
| `targets` | 2-4 identities sharing one relation, when you need every answer regardless of the others. Code relations, page 1 only, at most 15 rows each. | Covered |
| `relation` | Required edge direction/family. | Covered |
| `to` | Required only for single-target `path`; rejected everywhere else. | Covered |
| `scope` | Resolves one prepared project shared by the request. | Covered |
| `page` | One-based single-target continuation page; batches are page 1 only. | Covered |
| `limit` | Page size 1–200; single targets default to 50, batches default to and cap at 15 per target. Omit it for normal single-target calls; use 100–200 only when a dense relation's additional rows are jointly useful. | Covered |

### `trace` limit guidance

- Start normal single-target relations by omitting `limit`; the default 50 is intended to avoid premature paging.
- Use `limit:100`–`200` when one dense relation needs a wider prepared view and the additional peers/sites can change the decision.
- Otherwise continue with `page` and the same target, relation, limit, and generation so page windows remain comparable.
- Batches remain fixed at 15 rows per target. Switch the identity that needs more coverage to a single-target trace instead of trying to raise the batch cap.
- Use a smaller limit only when the requested relation is explicitly bounded.

Invocation trigger: when a consequential claim depends on who calls, what is called, imports, importers, or tests and that relation has not been observed, call trace as soon as the exact identity is known. Separate source or documentation hits do not establish the edge. Re-trace after a stronger identity; if the omission is recognized while the task remains active, execute the relation rather than explaining it afterward.

Identity rules:

- `imports`/`importers`: exact file path;
- `callers`/`callees`/`tests`: qualified symbol preferred; unambiguous bare symbol accepted;
- `path`: exact graph source `target` plus exact graph destination `to`;
- `explain`: one exact graph `target`, no `to`.

Ambiguous bare symbols complete no relation. Retry only an exact-name candidate, or qualify with code search when no candidate is exact. Batch only when every target needs the same relation regardless of sibling results. Continue each batch target separately.

Inspect qualified target, peer identity, edge direction, exact versus synthetic site, confidence/provenance, page omissions, and source authority. For `tests`, distinguish direct relationship edges from supplemental `tests_for` candidates and follow `test_candidate_origins` page windows; each page respects `limit`. Returned rows are authoritative for the executed prepared relation. A zero closes that relation only; use exact search when exhaustive site enumeration is the remaining claim.
Coverage: **APPEND/schema covered; limit-default guidance, guardrail, direct/supplemental test-origin paging, canonical source-hash alias, relationship, ambiguity, and batch tests exist.**

## `docs_search`

Code owners: `src/tools/docs-search.ts`, `src/core/qmd-docs-search.ts`.
The docs-retrieval contracts are `docs/evidence.md:current-evidence-map/documentation-retrieval-and-live-markdown#2`; the runtime docs-query flow is `docs/automatic-workflow.md:implemented-runtime-flows/9-docs-query-coordination#2`.

### `docs_search` parameters

| Parameter | Meaning and optimal use | APPEND |
|---|---|---|
| `query` | Required project concept/phrase/config key/design term. | Covered |
| `path` | Exact Markdown file; retrieval hint and hard post-filter. | Covered |
| `glob` | Markdown family; retrieval hint and hard post-filter. | Covered |
| `scope` | Resolves project/docs root. | Covered |
| `page` | One-based page after current-path filtering. | Covered |
| `limit` | Page size; default 20, capped at 50. | Covered |

### Optimal document-search query construction

When the exact heading is known, use it verbatim: exact title equality receives the strongest title prior. Otherwise front-load 4–6 distinctive project terms likely to occur in headings/body. Good terms combine:

- component or feature name;
- decision/constraint phrase;
- exact config key or callable;
- lifecycle/status/setup/policy wording.

One query drives every active ranking path: lexical retrieval keeps at most the first six unique meaningful terms and, for four or more terms, builds relaxed three-term combinations; semantic ranking embeds and reranks the full query. Put discriminating terms early, preserve exact technical spelling, and state important distinctions or negation explicitly.

Words such as `plan`, `planned`, `history`, `historical`, `roadmap`, `future`, `phase`, and `workstream` intentionally disable the ordinary current-authority preference. Include them only when historical/planned material is wanted.

`path`/`glob` are not merely ranking hints: results are hard-filtered afterward. Premature filtering can hide the governing document. Inspect ranking mode, retrieval/rerank/title/authority contributions, answerability, candidate-window saturation, currentness omissions, privacy, generation, and pages. Answer-bearing leads may support the returned section claim; weak leads are refinement candidates, not answers, and remain visible under warning status so a low score cannot masquerade as universal absence. Read the returned selector for current bytes.

Coverage: **APPEND covered with implementation-derived query and answerability inspection strategy; schema/result text distinguishes answer-bearing and weak leads; document ranking/currentness/weak-lead tests present.**

## `grep`

Code owners: `src/tools/grep.ts` normalizes requests and composes the final answer; `native/pi-nav/src/ops/search.rs` owns native search. These parameters describe maintained source, not an activation receipt. Use the schema actually exposed by the running tool and matching native assets; [current truth](current-truth.md) distinguishes development from installed readiness.

Grep is a first-class high-power discovery tool. Familiarity is not a reason to avoid it; use it when known vocabulary, exact occurrences, live definitions/usages, or deterministic audits are the most consequential evidence. Do not ask grep to prove hidden relationships, topology, intent, or runtime behavior.

### `grep` parameters

| Parameter | Meaning and optimal use | APPEND |
|---|---|---|
| `pattern` | Discovery question or text/symbol/regex query. Optional with `target`; when both are supplied, preserve the question while selecting that target. Omit for cursor continuation. | Source updated |
| `target` | Prefer `file:symbol` or `file::symbol`; bare/qualified names select exact declarations and retain ambiguity rather than guessing. Scope is optional. | Source updated |
| `focus` | Ordered priorities: `callers`, `callees`, `uses`, `implementations`, `documentation`. Canonical form is a list; scalar and legacy `{target,evidence}` forms remain compatible. Omission or `[]` keeps the ordinary connected answer. Priorities do not delete other useful evidence. | Source updated |
| `query` | Compatibility alias for `pattern`; conflicting values are refused. Prefer `pattern` in new requests. | Source updated |
| `paths` | Defaults to project root. Ranked accepts one exact file/directory; matches accepts one or ordered multiple exact targets. | Covered |
| `syntax` | `auto` default, `literal`, `regex`, or ranked-only `symbol`; explicit syntax wins. | Covered |
| `output` | `ranked` default for rich structural discovery or `matches` for deterministic occurrences. | Covered |
| `case` | `smart` default, `sensitive`, or `insensitive`. | Covered |
| `glob` | Include/exclude wildcard filtering; exact files bypass it and wildcards do not belong in `paths`. | Covered |
| `visibility` | `project` default; `all` disables configurable ignores but retains safety exclusions. | Covered |
| `contextLines` | Matches-only integer 0–10; ranked already has owner context. | Covered |
| `cursor` | Continue the retained ranked answer or matches audit without changing its request. Use alone; matches additionally permits `contextLines`. | Source updated |

### Ranked grep

Use one file/directory scope for definitions, usages, owner/section context, bounded source, coverage, and possible current source authority. `syntax:"symbol"` is useful for identifier discovery. `syntax:"literal"` is strongest for known phrases. Ranked output is often the optimal first observation for known vocabulary, including implementation discovery; ranking does not prove semantic ownership.

For known code, `target:"src/worker.ts:Worker.flush", focus:["callers","documentation"]` avoids inventing a discovery question. Add `pattern` when a question should remain in view. Explicit literal/regex or matches requests retain their text-matching semantics. QMD document sections are source-checked leads; similarity is not a code binding, and an authored association does not prove the prose. Optional documentation must fit the complete ranked reply and must not erase independently useful code evidence.

### Deterministic matches grep

Use one or multiple ordered exact targets for exact spans, counts, replacement audits, per-target zeros, and immutable continuation. Prefer literal; use regex only intentionally. `contextLines` changes lexical display, not structural completeness. A complete zero is bounded by paths, glob, visibility, syntax, case, and source state; it never automatically widens visibility. Retry explicitly with `visibility:"all"` only when ignored content matters.

When output returns `More: cursor …`, continue with only the cursor and optional context. Unknown/expired/evicted cursors fail closed; restart the original request rather than broadening it.

Coverage: **APPEND exhaustively covered; schema covered; cursor/zero/authority/invalid-call tests present; direct current-session use observed.**

## `find`

Code owner: `src/tools/find.ts`.

### `find` parameters

| Parameter | Meaning and optimal use | APPEND |
|---|---|---|
| `pattern` | One path fragment or glob. Mutually exclusive with `patterns`. | Covered |
| `patterns` | Small independent batch; every outcome remains visible. | Covered |
| `scope` | Discovery directory; defaults to cwd. | Covered |
| `type` | `any` default, `file`, or `directory`. | Covered |
| `visibility` | `project` default or `all`; project uses the configured navigation override, otherwise Git ignores. | Covered |
| `sort` | `mtime` default for recent activity or `path` for stable hierarchy. | Covered |
| `budget` | Token budget; defaults to the capped native budget. Increase only after explicit truncation. | Covered |

Find returns candidate paths and size hints, never content or meaning. It is not an exact known-path stat API. Each batched pattern has an independent zero/completeness outcome. A project zero never automatically widens visibility; retry explicitly with `visibility:"all"` only when ignored content matters.

Coverage: **APPEND covered; schema covered; batched-outcome and invalid-call tests present.**

## `ls`

Code owner: `src/tools/ls.ts`.

### `ls` parameters

| Parameter | Meaning and optimal use | APPEND |
|---|---|---|
| `path` | One directory; defaults to cwd. | Covered |
| `view` | `list` default for immediate children or `tree` for hierarchy. | Covered |
| `depth` | Tree-only depth 1–8, default 2. | Covered |
| `glob` | One optional naming slice. | Covered |
| `visibility` | `project` default or `all`; project uses the configured navigation override, otherwise Git ignores. | Covered |
| `sort` | Selectable `mtime`/`path`; list defaults to mtime and tree to path. | Covered |
| `budget` | Token budget; defaults to the capped native budget. Increase only after truncation. | Covered |

Use list for neighbor metadata, tree when hierarchy changes the investigation boundary. Directory shape does not prove behavior or ownership.

Coverage: **APPEND covered; schema covered; field-combination tests present.**

## `read`

Code owners: `src/tools/read.ts`, `src/core/read-renderer.ts`.
Read authority is `docs/harness-doctrine.md:navigation-harness-doctrine/source-and-mutation-authority#2`; the unified-source-authority flow is `docs/automatic-workflow.md:implemented-runtime-flows/3-unified-source-authority#2`.

### `read` parameters

| Parameter | Meaning and optimal use | APPEND |
|---|---|---|
| `path` | One known local, absolute, or parent-relative file with optional selectors. Mutually exclusive with `paths`. | Covered |
| `paths` | Ordered batch of 1–8 known-file selectors; each string is capped at 4096 characters. | Covered |

### Single-file advanced selectors

One `path` can select an exact code symbol (`src/foo.ts:validateInput` or `src/foo.ts::validateInput`), a Markdown section (`docs/setup.md::setup/install/#2`), line ranges, or a comma-separated combination (`src/foo.ts::validateInput,220-240`). Single and double colon separators are equivalent; the slash before a Markdown `#LEVEL` is optional. Supported range forms are `:START`, `:START-END`, `:START+COUNT`, and `:START-`. `:raw` bypasses structural summarization where supported. Code-symbol lookup is exact and fails closed on missing, ambiguous, stale, unsupported, or oversized results.

Use distant ranges when they answer one question. Large files may return a structural summary rather than arbitrary leading bytes; follow exact ranges or certified blocks from that summary.

### Multi-file read

`read({paths:[...]})` is a first-class operation, not repeated single reads. Use it for up to eight independently known files when every result is needed regardless of siblings. It preserves order and per-file:

- canonical identity;
- selector(s) and merged requests;
- shown/error/omitted status;
- completeness and omission reason;
- current hash and seen-line authority.

Do not batch speculative files whose first result could change later targets. Never combine `path` and `paths`.

### Read authority and structural blocks

Only displayed complete numbered rows become mutation authority. Large summaries, outlines, transformed snippets, stale content, or path-only results remain locators. Structural blocks certified at read time authorize `BLOCK AT` edit operations; parser/backend work never runs during mutation.

Coverage: **APPEND prominently covers single-file distant selectors and multi-file read; schema covered; batch/selector/hash/block tests present.**

## `diff`

Code owner: `src/tools/diff.ts`.
Change evidence is governed by `docs/harness-doctrine.md:navigation-harness-doctrine/evidence-capabilities-not-routes#2`.

### `diff` parameters

| Parameter | Meaning and optimal use | APPEND |
|---|---|---|
| `root` | Repository/direct-comparison base; defaults to session cwd and does not change cwd. | Covered |
| `source` | Omit/`uncommitted` for unstaged tracked work, `staged` for index-only, or use one Git ref/range. | Covered |
| `scope` | Repository-relative file/directory filter, including deleted/ref-only paths. | Covered |
| `a` | First direct-comparison file; requires `b`. | Covered |
| `b` | Second direct-comparison file; requires `a`. | Covered |
| `view` | Repository default: `review` (paired changes before available connected context). Explicit `summary`, `patch`, `structure`, and `impact` retain their meanings. Direct a/b still defaults to `summary`; review/impact are unsupported there. | Covered |
| `search` | Review/default: case-insensitive substring selection across changed units' before/after names, paths and changed text. Structure retains its symbol filter. Unavailable selection is not a zero match or an unfiltered fallback. | Covered |
| `expand` | Non-negative context lines for direct a/b summary/patch only. | Covered |
| `budget` | Positive approximate character cap. Review fits whole paired units before optional support under this cap and an independent 8,000-reference-token ceiling; omitted units remain explicit. | Covered |

Repository evidence never merges staged and unstaged sources. Untracked files are excluded from tracked change units. Repository default/review preserves paired before/after source without requiring a graph; missing transport may retain exact Git patch evidence unless a requested search cannot be honored. Indexed explanatory source requires compatible comparison identity and verified current bytes; staged/revision comparisons withhold incompatible current consumers. Legacy graph planning remains explicitly advisory. Comparison rows alone confer no current edit authority. Explicit summary reports untracked files without treating them as tracked changes. Direct a/b is byte-first and never invents text for binaries.

Coverage: **Focused source tests cover default/review selection, explicit views, direct default, independent-evidence preservation, whole-unit fitting and source-authority boundaries. Installed/real-Pi acceptance is separate.**

## `lsp_validate`

Code owner: `src/tools/lsp-validate.ts`.

### `lsp_validate` parameters

| Parameter | Meaning and optimal use | APPEND |
|---|---|---|
| `paths` | Required file/directory scalar or ordered array. | Covered |
| `root` | Workspace/config root; defaults to cwd and is not a subtree filter. | Covered |
| `limit` | Resolved-file limit 1–100, default/hard maximum 100; errors instead of truncating. | Covered |
| `includeWarnings` | `false` default reports errors; `true` also includes severity-2 warnings. | Covered |

Prefer changed owners and direct consumers after a coherent edit. Use a directory only when all resolved files share the contract; `.` is deliberate project-wide validation. Clean, diagnostics, unsupported, timeout, skipped, and unconfirmed are distinct. LSP does not prove formatting, tests, build, or runtime.

Coverage: **APPEND covered; description/schema covered; focused and loaded tests present.**

## `edit`

Code owners: `src/tools/edit.ts`, `src/core/patch-parser.ts`, `src/core/patch-apply.ts`, `src/core/edit-retry.ts`, `src/core/updated-field-stamp.ts`, snapshot/repair/mutation queue owners.
The mutation doctrine is `docs/harness-doctrine.md:navigation-harness-doctrine/mutation-doctrine#2`; the read→edit flow is `docs/automatic-workflow.md:implemented-runtime-flows/4-read-edit-continuation#2`.

### `edit` parameter

| Parameter | Meaning and optimal use | APPEND |
|---|---|---|
| `input` | One hash-anchored single- or multi-file edit program, or an explicitly offered retry command. | Covered |

### Multi-file edit

One `edit` call can contain multiple `[PATH#HASH]` sections and multiple operations per file. All coordinates refer to the original snapshot, so earlier operations do not renumber later ones. Duplicate same-path sections may be composed in input order when they share one source identity.

Each physical file stages/revalidates/lands atomically, but the whole request is not filesystem-wide atomic. Earlier files can remain landed when a later file fails or cancellation occurs. Inspect every per-file outcome: landed, failed, cancelled, skipped, accepted, repaired, held, or rejected.

### Canonical line operations

- `REPLACE N:` or `REPLACE N..M:` followed by `+TEXT` rows.
- `DELETE N` or `DELETE N..M`.
- `INSERT BEFORE N:`, `INSERT AFTER N:`, `INSERT AT START:`, or `INSERT AT END:` followed by `+TEXT` rows.

### Certified structural operations

- `REPLACE BLOCK AT N:` plus `+TEXT`.
- `DELETE BLOCK AT N`.
- `INSERT AFTER BLOCK AT N:` plus `+TEXT`.

Use only when the current hashed read certified exactly one structural block beginning at N. Missing/ambiguous blocks fail closed; use a concrete range instead.

### Whole-file operations

`DELETE FILE` and `MOVE FILE TO destination` must be the sole operation under that file header. A move preserves current content but changes path-sensitive evidence; rediscover/re-anchor when later relationships depend on path.

### Inline and automatic validation

`CHECK LSP` can appear in each file section. It runs only for corresponding landed files. Every supported landed edit also runs bounded syntax validation automatically and reports newly introduced/worsened grammar failures; syntax feedback is not a full build/test. A landed Markdown edit whose leading YAML frontmatter already contains an `updated` field also auto-stamps that value to the current UTC date and hour, quoted `YYYY-MM-DD HHZ` (`src/core/updated-field-stamp.ts`), before the file is committed, so the returned hash, diff, and disk always agree; the field is never added, no-op edits stay byte-identical, and dependency/runtime/generated/framework-managed trees plus duplicate/empty/multi-line/collection values are exempt.

### Repair, stale handling, and retry

The edit engine can accept exact operations, conservatively repair safe anchors, hold unseen/stale operations, reject bounds/conflicts/ambiguous repair, and return fresh per-file context. Partial success can retain exact residuals:

- `RETRY` when exactly one residual remains;
- `RETRY N` for one selected residual;
- `RETRY ALL` for all retained residuals.

Retry is session-local and valid only when prior output explicitly offered it. External change may make a retry stale. Repeated no-change attempts are stopped.

### Parser tolerance marked reference-only

The parser can accept some body rows without canonical `+` and can normalize pasted `LINE:TEXT` rows, emitting warnings. APPEND intentionally teaches `+TEXT` only because tolerant input is recovery behavior, not the recommended authoring form. `-` body rows are invalid because the replacement range already names removed text.

Coverage: **APPEND prominently covers multi-file edit, every canonical operation, block edits, inline LSP, per-file atomicity, partial outcomes, retry, and fresh continuation. Schema covered. Existing hashline/block/retry/loaded-LSP tests execute these features.**

## `write`

Code owners: `src/tools/write.ts`, `src/core/write-core.ts`, `src/core/updated-field-stamp.ts`.
The mutation doctrine is `docs/harness-doctrine.md:navigation-harness-doctrine/mutation-doctrine#2`.

### `write` parameters

| Parameter | Meaning and optimal use | APPEND |
|---|---|---|
| `path` | Target path; parent directories are created. | Covered |
| `content` | Complete UTF-8 text; empty string is valid, NUL/binary-like content refused. | Covered |
| `overwrite` | Omit for create; must be exactly `true` for intentional whole-file replacement. | Covered |

Existing files refuse accidental overwrite. Target directories are refused. Creation/overwrite returns a fresh hash, preview/diff, byte count, and bounded automatic syntax validation. Use read+edit for targeted existing-file changes.

A content-changing write to Markdown (`.md`/`.markdown`) whose leading YAML frontmatter already contains an `updated` field auto-stamps that value to the current UTC date and hour, quoted `YYYY-MM-DD HHZ`, replacing only the value span and preserving every other byte (comments, CRLF, BOM, spacing). The field is never added and frontmatter is never created; no-op overwrites stay byte-identical. The stamp is skipped for dependency/runtime/generated/framework-managed trees (`node_modules/`, `vendor/`, `.runtime/`, `site-packages/`, venvs, VCS internals, `dist/`/`build/`/`out/`/`target/`, `graphify-out/`, `.pi/`, `.agents/`, caches, logs, archives) and for duplicate, empty, multi-line, or collection `updated` values.

Coverage: **APPEND covered; schema covered; write refusal/hash/syntax tests present.**

## `bash` and `jobs`

jeito Shell registers these first-party tools under `extensions/shell`; codeweave-pi does not own their implementation, but this reference audits the runtime execution surface taught by APPEND.

### `bash` parameters and features

| Parameter | Meaning and optimal use | APPEND |
|---|---|---|
| `command` | Fresh command/script. | Covered |
| `id` | Saved `sh-N` cell or clone form. | Covered |
| `action` | `run`, `show`, `clone`, `list`; valid combinations are schema-owned. | Covered |
| `background` | Start a non-gating process as an owned background job while independent authorized work continues. | Covered |
| `wait` | Soft foreground wait; never kills. | Covered |
| `raw` | Bypass LeanCTX for exact uncompressed capture. Oversized model-facing text remains a bounded preview with the exact session-log path. | Covered |

Every non-raw command uses extension-owned LeanCTX output handling. The runtime protects verbatim or passthrough output when fidelity requires it and applies command-aware compression otherwise. Raw and non-raw capture both use the same recoverable model-view boundary: small output stays inline; oversized output reports omitted bytes and the exact session-local log path in provider-visible content. Multiline commands become reusable scratch cells; rerun unchanged cells, inspect uncertain content, and clone separately named variants instead of reconstructing long commands.

### `jobs` parameters and features

| Parameter | Meaning and optimal use | APPEND |
|---|---|---|
| `id` | Specific job; omit to list active jobs. | Covered |
| `wait` | Poll for bounded time. | Covered |
| `delta` | Return only unread output; a bounded preview advances to the reported snapshot end and names the log that retains omitted bytes. | Covered |
| `filter` | Regex-filter the complete requested snapshot while bounding matching output and retaining the complete unfiltered log path. | Covered |
| `lines` | Return only the final positive-integer number of lines after delta/filter selection; the byte bound and exact-log recovery remain authoritative. | Covered |
| `signal` | `term`, `kill`, `stop`, `cont` for whole process group. | Covered |

Every background process remains owned until exit or deliberate control. Poll before the first dependent action or claim. For repeated polls, combine a useful `wait` with `delta`; add `filter` for named evidence and `lines` when only recent progress or the terminal summary matters. `lines` stays optional because the byte bound already protects context and a fixed default could hide useful short output. When a preview marker reports omitted bytes, inspect the named log before making a claim that depends on them; a later delta does not replay bytes skipped by an earlier bounded delta. A command proves only the state it exercised, and concurrent changes to exercised inputs or shared state make that proof stale.

## Current coverage gaps and review checklist
This checklist operationalizes the operational-literacy bridge (`docs/harness-doctrine.md:navigation-harness-doctrine/operational-literacy-bridges-reasoning-into-tool-calls#2`).

- [x] Every parameter of all eleven registered jeito-codeweave-pi tools appears in this document.
- [x] Every parameter appears in APPEND strategy/operation guidance.
- [x] Code semantic-search query construction reflects current hybrid/FTS/keyword behavior.
- [x] Code-search invocation/re-entry/closure guidance covers unqualified implementation ownership, exact-identity neighborhoods, and focused relations without imposing graph-first routing or call quotas.
- [x] Code search prioritizes implementations in mixed results while preserving test exclusion/opt-in and test-only subsystem evidence; traversal orders edges by start proximity; trace pages test origins and canonicalizes relative/absolute source-hash aliases.
- [x] Map query construction includes the concrete cross-component invocation/re-entry/closure trigger, native exact-path/`file::symbol` node-ID resolution, and retained/rejected Start verification.
- [x] Document query construction reflects exact-title prior, first-six lexical terms, relaxed combinations, semantic full-query reranking, authority intent, path hints, and hard filters.
- [x] Grep ranked/matches/case/context/glob/visibility/cursor/source-authority behavior is explicit.
- [x] Multi-file read and multi-file edit are prominent first-class capabilities.
- [x] Edit line/block/whole-file/LSP/repair/retry/syntax/continuation behavior is explicit.
- [x] APPEND, doctrine, maintainer skill, public prepared-tool descriptions, startup guidance, and normal output present registered prepared tools as directly callable without speculative readiness/indexing/freshness gates.
- [x] Lexical code/docs modes render as successful prepared evidence; trace relation rows render as authoritative within their relation; actual failure/zero/ambiguity/omission diagnostics remain request-specific.
- [x] Trace batches default to their valid 15-row cap when `limit` is omitted.
- [x] Registered numeric limits/defaults and structural array/string bounds are checked against each parameter's reference row.
- [ ] Fresh GPT-5.6 Sol/low agent-choice evaluation passes.
- [ ] Fresh GPT-5.6 Luna/low release evaluation passes.

Do not mark the last two items complete from source review, unit tests, direct tool execution, or an active-session conversation. They measure fresh-model adherence, not tool readiness or availability. The latest targeted Luna/low run produced no output, stderr, or session artifact for 9m33s before termination; earlier Luna/low and Sol/low attempts behaved similarly for 3m05s and 5m24s. These are capture/runtime blockers and establish no behavioral verdict.
