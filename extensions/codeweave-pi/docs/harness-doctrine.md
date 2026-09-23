---
title: "Navigation harness doctrine and invariants"
description: "Product reasoning, evidence-capability routing, source and mutation authority, native-output preservation, query-time purity, and change-classification invariants."
tags: [jeito-codeweave-pi, doctrine, invariants, evidence-acquisition, mutation-authority]
created: 2026-07-25
updated: 2026-09-21
status: active
owns: "Product reasoning, evidence-capability routing, and timeless architecture invariants"
audience: contributor
code: [src/core/source-authority.ts, src/core/prepared-page.ts, src/core/tool-call-contract.ts]
related: [docs/evidence.md, docs/automatic-workflow.md, docs/current-truth.md, docs/decisions/proof-preserving-mutation.md]
---

# Navigation harness doctrine

This document owns the product reasoning and architecture invariants. Source behavior is mapped in `docs/evidence.md:current-evidence-map#1`; lifecycle mechanics are in `docs/automatic-workflow.md:implemented-runtime-flows#1`; current state is in `docs/current-truth.md:current-truth-and-future-work#1`.

## North star

Maximize accurate, precise, current project understanding through effective evidence acquisition. Truth and accuracy are hard constraints. Evidence whose purpose is to reveal possibilities outside the current hypothesis is signal, not overhead. Among approaches with equal consequential discovery power and proof quality, prefer less redundant acquisition, context, latency, and ceremony.

The unit of progress is trustworthy uncertainty retired—including unknown project relationships made visible—not tool calls avoided or completed.

## Earn the boundary

A file, symbol, error, route, config key, diff, or document is a clue, not the task boundary. The dangerous failure is premature boundary collapse: precisely proving something inside the wrong subsystem or evidence class.

A user's requested action and supplied artifacts are privileged clues, not automatically the evidence boundary. “Read these files,” “search for this,” or “implement from this document” must be honored, but they do not prove that role, connections, contracts, tests, current changes, or ownership are fully known unless the user explicitly restricts investigation. “Only edit these files” constrains mutation; “only inspect these files” constrains evidence and should be honored with the resulting limitation stated.

Plans are authoritative for intended outcomes, explicit constraints, permissions, ordering, and acceptance conditions—not automatically for current project facts. File ownership, architecture, status, dependency, command, and sequencing claims in a plan are hypotheses to validate. Preserve intent when project evidence contradicts a plan, but report and resolve the conflict instead of executing stale assumptions or silently changing constraints.

Throughout a task, distinguish intent/constraints, observed project facts, inferred assumptions, and unresolved risks. Agents cannot enumerate all relationships, hierarchy, flow, policy, tests, or ownership before prepared observation; inability to name an alternative is not evidence of containment. For nontrivial implementation, debugging, review, or design work, make a prepared boundary-discovery observation from the concrete clue unless the user restricts evidence or the task is mechanically bounded by current source. Prefer the capability with greatest consequential discovery value; narrower scope and lower cost break ties only when discovery power is equal.

Batching is conditional rather than a default efficiency move. Batch only independently earned items that ask one authority the same already-defined question and whose results are all required regardless of earlier answers. Keep work sequential whenever one result could change the next target, relation, purpose, range, scope, or evidence capability; do not multi-read speculative files before ownership, callers, impact, or the failing operation are established. Advanced options are warranted only when they close a named remaining claim—more parameters or more tools are not inherently more rigorous.

Known identity does not waive discovery. A recognized symbol may seed `explore(code/map)`, `code_context`, or `trace`; a known file may seed topology, task synthesis, structural qualification, or written-authority retrieval. Exact grep/read closes literal or source claims but cannot establish that no unseen owner, caller, lifecycle, policy, generated artifact, or test matters. Confirmation that the task is contained is a useful prepared result. The prepared capabilities and the boundary each owns are catalogued in `docs/evidence.md:current-evidence-map/public-prepared-tools#2`.

Use the smallest stable loop:

1. **Name** intent and constraints, observed facts, inferred assumptions, the current hypothesis, and the uncertainty that could change the next action.
2. **Observe** that uncertainty with the capability most likely to reduce consequential uncertainty, including non-obvious connections; cost breaks ties only when information value is equivalent.
3. **Inspect** what actually executed and returned: normalized input, graph starts, qualified target, native evidence, diagnostics, omissions, and contradictions. Update fact, inference, and unresolved risk.
4. **Decide** from the updated truth: continue, refine, switch evidence class, revise the boundary, ask for user intent, mutate, or stop.

Hard tasks benefit from a sequence of hypothesis-updating observations. After each meaningful result, name what became fact, what remains inference, and which unresolved claim could change the next action. Keep prepared discovery active before and after source reading whenever ownership, topology, tests, impact, or another connection remains open. A ranked test, helper, or adjacent type can prove connection to a subsystem without proving implementation ownership; inspect candidate kinds, signatures, paths, coverage, and consequential continuation pages, then refine with returned vocabulary when it increases discrimination. Once an identity is qualified, topology can expose the neighborhood while focused relations, current diff, written contracts, and current source close their distinct claims. Later evidence that reveals a new owner or abstraction is a stronger prepared anchor. Complexity increases the value of updating and testing the project model across observations.

Ask users for intent, preference, permission, priority, or external context. Investigate project facts with the harness.

## Evidence capabilities, not routes

Tools observe different project realities. Their names do not define a fixed workflow, and the syntactic shape of a clue does not choose between them. Prepared tools actively discover boundaries the agent cannot know to ask for yet; exact tools close already-defined literal, path, source, and change claims.

- Graphify backs cross-domain graph evidence used by `explore(map)` and graph `path`/`explain` relations.
- The package-owned Core indexed graph supplies typed code nodes and relationships for `explore(code)`, `trace`, and Diff planning. A call graph is not proof of runtime flow, test execution, or complete impact; unavailable relations remain explicit.
- QMD backs prepared written-project section retrieval used by `docs_search`; bundled pi-nav owns live Markdown hierarchy and current reads.
- Bundled pi-nav backs exact directory/path/content identity and typed current-byte source evidence used by `ls`, `grep`, `find`, native trace/read consumers, and source expansion.
- Git/pi-nav change evidence backs current patch and change-aware review context used by `diff`.
- Hashed reads and certified current-byte rows can authorize mutation.
- Focused execution can prove only the runtime behavior it exercised.

Prepared capabilities may be complementary in one investigation: map for cross-domain connections, code view for topology/lifecycle, trace for one structural edge, and docs_search for written authority. Use more than one when those are independent boundary risks. This is not a mandatory sequence; it is protection against source-first tunnel vision. The backend health and lifecycle of these capabilities is owned by `docs/evidence.md:current-evidence-map/lifecycle-and-backend-health#2`.

When an explanation depends on how multiple project components or layers work together and no returned evidence connects them, cross-domain topology remains unresolved. Invoke `explore(map)` at the first concrete identity instead of treating separate document, source, or code-identity hits as a connection. Re-enter map when later evidence supplies a stronger identity that could change the model; use `trace` only when one exact relation is already the question. If the agent recognizes this omission while the task remains active, corrective execution—not a postmortem—closes it.

When implementation ownership is consequential but no qualified owner has been observed, code identity remains unresolved. Invoke `explore(code, search)` at the first behavior/signature clue. In mixed results, non-test candidates lead while an excluded-test count and `kind:"Test"` opt-in remain visible; a test-only result set remains available as subsystem evidence. Returned tests/helpers locate a subsystem without proving ownership, so inspect secondary candidates, refine, or page while the owner could change the answer. When an exact code identity is known but its neighborhood remains inferred, invoke traversal; when one exact relation remains, invoke trace. Re-enter any of these after a stronger identity. Separate grep, source, and document hits cannot impersonate the missing structural evidence, and postmortem recognition does not close it.

A direct tool-result-hash → edit is correct when prepared or explicit evidence has earned containment and the complete displayed current-byte source is sufficient. The same transition is wrong when containment is only assumed because the symbol or file looked familiar.

Authority is per observation and claim, not per whole user request. Compound how/why/reliability questions may require written intent, code topology and lifecycle, cross-domain integration, structural relationships, tests, and runtime behavior to agree. Which dimensions matter must emerge from the repository and each knowledge delta rather than a task-shape routing table. One authoritative result closes its component but cannot silently impersonate the complete answer.

## Operational literacy bridges reasoning into tool calls

A capability is not usable merely because its schema is valid. Agent-facing guidance must close the ownership gap between an unresolved claim and a field list: the agent must be able to construct an effective invocation, exploit the capability's consequential features, interpret what actually executed, and turn the result into the next decision.

For every public capability, preserve this bridge:

1. **Intent:** which evidence class and uncertainty the call owns.
2. **Construction:** the strongest concrete identity/query packet, mode, scope, and consequential controls currently justified.
3. **Leverage:** paging, batching, multi-file operation, cursors, selectors, structural operations, validation, or recovery features that materially improve coverage or precision.
4. **Interpretation:** request normalization, qualified identity, native evidence, diagnostics, omissions, authority, atomicity/partial outcomes, and continuation state.
5. **Adaptation:** result-guided refinement, re-anchoring, continuation, evidence-class transition, or stop condition.

This is operational literacy, not a fixed route and not a prose schema copy. A question→tool table or mandatory sequence erases the evolving project model; a bare schema leaves strategy implicit and buries powerful modes behind familiar low-dimensional calls. Conditional playbooks and worked calls are appropriate when they teach how to adapt from current evidence without requiring that sequence for every task.

Operational literacy is behavioral, not recitation. A model that correctly explains why a capability applied but omits the call, fails to re-enter after a stronger identity, or stops with that capability's claim unresolved has not crossed the bridge.

Registered prepared capabilities are callable by default. Agent-facing guidance must say to invoke the owning capability when its evidence class matters, without speculative readiness, enablement, indexing, freshness, or “if it works” preconditions. The capability owns its preflight. Actual result diagnostics remain mandatory because they calibrate that returned claim; they must never be generalized into lower confidence in the capability or used to avoid later calls with a different identity.

Search construction must be implementation-derived. For semantic, hybrid, lexical, graph, and document retrieval, guidance must teach one confident default query/identity shape, explain token/phrase matching and dominant anchors, and use the active mode reported by the result to refine the next call. Hard filters remain explicit. Generic advice to “be specific,” readiness preflights, and fallback speculation do not close the bridge.

Ownership is layered rather than exclusive. APPEND owns durable selection, construction, composition, and adaptation strategy. Public descriptions and schemas own accepted forms, mode-specific mechanics, and limits; runtime result and error messages own local recovery — the static layers never pre-teach what a message will explain. Tool results own the evidence actually returned plus request-specific continuation identity; normal renderers do not invent a generic next call. Evaluation owns observed agent operation (`docs/evaluation-workflow.md:agent-evaluation-workflow/operational-literacy-evaluation#2`). Verification of a complex capability must test all four surfaces rather than treating source/schema review as behavioral proof.

`docs/tool-operating-reference.md:jeito-codeweave-pi-tool-operating-reference-and-coverage-audit/how-to-audit-tool-coverage#2` is the exhaustive audit owner for this extension. It must inventory every registered public parameter and agent-facing advanced operation, map each feature to APPEND/schema/result/test/behavioral coverage, and explain implementation-derived query construction. Defaults and ceilings must include operational guidance for when to omit a control, widen it, or preserve continuation identity through paging. A schema-drift test must fail when the registered surface grows without the reference. APPEND need not duplicate volatile numbers, but every consequential strategy or buried high-leverage feature must be discoverable at its owning layer.

Every registered project-work tool needs enough guidance to expose its consequential modes and high-leverage features. A feature that exists in source but is absent from the operating reference, APPEND strategy, public description/schema, normal result guidance where applicable, and evaluation is not operationally shipped to agents.

## Source and mutation authority

Keep these concepts separate:

1. **Locator**: path, compact ref, symbol, range, graph node, changed file, or test candidate. It narrows the next observation.
2. **Exact source/change proof**: current source rows or patch evidence that closes a text/change claim.
3. **Mutation authority**: complete current-byte source rows recorded under a whole-file hash with seen-line provenance.

Complete, current, verbatim displayed project rows with path and line identity may be certified by any capability after byte/identity validation. `read` supplies missing source authority; it is not the only possible authority origin. Clipped snippets, transformed prose, historical removals, generated text, summaries, inferred text, stale versions, and path-only results are never mutation authority.

Source authority is orthogonal to routing: a hash does not prove the boundary is complete or editing is next. The implemented flow is `docs/automatic-workflow.md:implemented-runtime-flows/3-unified-source-authority#2`; the proof-preserving rationale is `docs/decisions/proof-preserving-mutation.md:proof-preserving-source-authority-and-the-salvage-edit-engine/part-a-unified-source-authority#2`.

## Native-output doctrine

Prepared capability output is evidence for the class it extracts. Preserve:

- relationships and edge kinds;
- ranks and retrieval diagnostics in structured evidence, with model-facing metrics translated only when their meaning is calibrated and explainable;
- snippets and exact paths;
- section hierarchy and compact refs;
- graph nodes, starts, paths, provenance, and health/scope/quality diagnostics;
- affected flows, tests, risks, and omission counts;
- backend reasons for empty or skipped results.

GCF-style formatting exists to lower token cost without deleting semantic fields. Normal-user output may hide wrapper/backend plumbing, but setup/debug views must expose enough identity and provenance to diagnose the integration. Exact text, paths, and code must never be sanitized into backend-opaque paraphrase.
Raw backend scores are not automatically semantic evidence for an agent. If live calibration shows relevant and wrong score ranges overlap, keep the raw numbers available for diagnostics but present result-local evidence the agent can reason about—such as exact identity, query-wording support, or a meaning-led candidate label—without pretending that the label certifies relevance.

If native evidence is bad or a capability contract is broken, fix that layer. Do not teach agents to substitute another evidence class for the broken one: exact tools remain direct authorities for exact claims, not workarounds for structured claims. The rendering contract that preserves native output is `docs/ui-rendering.md:tool-output-ui-rendering/modeltui-output-quality-contract#2`.

## Evidence-dense output design

Design output for capable agents: provide the facts required to interpret the result, not a generic instruction for an imagined next call. A structured location, owner, range, relationship, section, cursor, or authority manifest is evidence; render request-specific continuation identity when it exists, but let APPEND own cross-tool strategy and schemas own accepted call mechanics.

Use the smallest coherent evidence unit owned by the capability. For lexical code search this is usually one owner/section block with bounded source windows; for relationships it is one qualified edge/site; for docs it is one section with hierarchy; for directory/path tools it is one bounded entry set. Do not flatten a rich native unit into isolated lines, and do not expand it into a whole file or every adjacent relationship merely because the backend can.

Normal output follows these rules:

- render request interpretation once (`Resolved:`, qualified target, graph starts, diff source, or equivalent);
- render active filtering/scope once when it changes absence meaning;
- show one compact success/completeness summary;
- expand material exceptions—skipped targets, partial scans, stale identity, unavailable enrichment—rather than printing every internal axis on every successful call;
- preserve complete typed structured detail for renderers/tests/debug even when normal text compacts it;
- print each verbatim source row once and certify only that row; metadata, outlines and highlights do not become source;
- keep path/range/owner names non-redundant within a block;
- avoid routine byte offsets, pattern IDs, backend names, worker counts and token estimates unless they disambiguate the claim;
- never hide a filter, truncation, omission or skip whose absence could make the agent infer a false zero or complete result.

Output density is controlled by evidence intent, not by asking the agent to predict arbitrary result/token budgets. Prefer automatic bounded pages, complete atomic units, request-bound continuation, and one meaningful context control over a family of renderer knobs. A public density option requires loaded evidence that the default coherent unit costs materially more without improving decisions.

Before implementation, write normative normal, zero, partial, exact-target and continuation examples. Treat those examples as semantic acceptance contracts. Renderer work may improve local formatting but may not silently remove fields, duplicate evidence, alter tool semantics, or replace structured facts with prose parsed back by another layer. Renderer ownership is mapped in `docs/ui-rendering.md:tool-output-ui-rendering/code-map-for-future-edits#2`.

## Structural paging

Prepared collection results use `page` as a 1-based window and `limit` as page size (default 5, maximum 20). Each bounded array reports request, root, generation, returned/total, omitted-before/after, total-pages, and next-page identity. Continue with the unchanged request and page size; do not merge windows whose request or generation identity differs. Backend `complete:true` may mean traversal completed even when the visible page is only part of the replacement set. Source proof is selected after paging so hidden pages cannot consume the visible page's authority budget.

Structural paging replaces duplicate prefix truncation, not native semantics. Safe unknown fields, relationships, ranks, diagnostics, provenance, confidence, and omission reasons remain visible on their owning row or are truthfully retrievable through another page.

## Query-time purity and lifecycle ownership

Navigation queries consume prepared evidence or current project files. They do not:

- install packages;
- build/rebuild/delete indexes;
- call summary providers or embedding providers for repository-node indexing; semantic code search may call the lifecycle-selected embedding provider only for the bounded query and must expose provider/model/privacy/readiness plus degraded lexical status;
- start watchers;
- mutate project/global configuration;
- silently fall back to another evidence class.

Lifecycle/setup owns preparation and repair (`docs/setup.md:setup-health-repair-and-migration/install-update-and-repair-codeweave-pi#2`). Destructive migration requires explicit approval and rollback material. The query-time/lifecycle split is implemented in `docs/automatic-workflow.md:implemented-runtime-flows/9-docs-query-coordination#2`.

## Mutation doctrine

The edit engine must preserve these invariants:

- whole-file digest plus eight-hex public anchor;
- exact-content snapshot identity and collision refusal;
- seen-line provenance for every concrete anchor;
- original-snapshot coordinates for all operations in one section;
- one natural edit language;
- parser-certified block metadata attached at read time;
- conservative repair with visible warnings;
- stale recovery that never authorizes changed or historically unseen targets;
- deterministic path locks and revalidation;
- same-filesystem staging for atomic per-file landing;
- explicit rollback and incomplete-rollback reporting;
- current post-edit hash and coordinate manifest for continuation.

Do not copy upstream conveniences that weaken provenance, accept ambiguous short hashes, bypass stale seen-line checks, or make mutation depend on an index/provider. These invariants are realized by the structural-block flow (`docs/automatic-workflow.md:implemented-runtime-flows/6-structural-blocks#2`); the salvage-over-all-or-nothing rationale is `docs/decisions/proof-preserving-mutation.md:proof-preserving-source-authority-and-the-salvage-edit-engine/part-b-salvage-edit-engine#2`.

## Trust and diagnostics model

Prepared and exact outputs are authoritative within the evidence classes they own. Relationships, topology, hierarchy, task context, exact identity, and current changes do not form a trust hierarchy.

Judge capability output by the target/scope actually executed, native evidence, diagnostics, omissions, and contradictions. Refine weak or mismatched output in its own evidence class; switch only when the remaining claim belongs elsewhere, never for reassurance.

Tool familiarity is not a routing criterion. Exact search and reads are appropriate for exact identity and source-text claims, not for relationship, topology, impact, task-context, or written-hierarchy claims. Complete current-byte source under a hash remains the mutation authority; that separate requirement does not make structured project evidence less trustworthy.

## Performance doctrine

Do not improve speed by disabling evidence, reducing provider quality, truncating native semantics, or replacing deterministic parsing with weaker heuristics presented as equivalent.

Use:

- lazy imports on uncommon recovery paths;
- workers for parsing, recovery, and other work that would block Pi's main thread;
- per-root single flight and cross-process locks;
- trigger coalescing and cooldowns;
- background priority where the host supports it;
- bounded caches and idle release;
- no large synchronous artifact parsing on Pi's main thread;
- focused telemetry that does not alter normal output.

A wall-time improvement that adds wrong targets, premature edits, missing evidence, or UI stalls is a regression.

## Diagnostics and absence

Diagnostics constrain claims; they are not chatter.

- Zero `grep`/`find` matches supports “not found in this searched scope.”
- A healthy qualified `trace` relation from the prepared code graph with no edge supports “no structural edge for this relation.”
- Empty orientation/docs/task retrieval means that query produced no usable evidence—not universal nonexistence. A weak document lead is a ranked refinement candidate, not an answer or an absence claim; only answer-bearing returned content supports an answer within its stated scope.
- Cross-domain project graph neighborhood absence is bounded by the returned scope and graph-health diagnostics.
- Missing prepared tests are not proof no tests exist.

Inspect rendered normalization and target qualification before diagnosing a tool defect.

## Instruction ownership

- `~/.pi/agent/APPEND_SYSTEM.md`: host-owned reasoning, tool-selection, call-construction, composition, adaptation, and completion doctrine. The extension does not ship or inject a second APPEND. Its maintenance rules are in `docs/management.md:documentation-ownership-and-maintenance/append-system-maintenance#2`.
- Public tool descriptions/schemas: exact accepted fields, mode-specific mechanics, limits, advanced feature discoverability, and local failure/recovery semantics.
- `harness-doctrine.md`: product invariants, rationale, and ownership boundaries—including the operational-literacy bridge; `tool-operating-reference.md`: exhaustive registered feature/parameter inventory, implementation-derived query construction, and cross-layer coverage audit.
- `automatic-workflow.md`: implemented runtime flows.
- `setup.md` and skills: operator/debug procedures.
- `evidence.md`: source/test/verification map.
- `current-truth.md`: only current limitations and future work.

Runtime instructions must describe ideal behavior, not postmortems. Historical context belongs only where it explains a current invariant.

Agent-facing text (tool descriptions, parameter descriptions, error/guidance strings, and active agent doctrine) must never use internal stack/tooling names that LLMs were never trained on — CRG, Graphify, QMD, pi-nav, code_context, zembed, zerank, Semble, Codanna. Replace them with what-the-tool-does descriptions: "code graph" not "CRG", "cross-domain project graph" not "Graphify", "document search index" not "QMD", "native file tools" not "pi-nav". The agent needs to know what a tool does, when to use it, and what to expect — not what stack is behind it. Internal implementation names (imports, function names, telemetry, config values) are not agent-facing and are unaffected.

## Change classification

When a finding appears, classify it before editing guidance:

| Finding | Correct owner |
|---|---|
| Durable uncertainty/evidence reasoning or cross-tool composition habit | APPEND + doctrine |
| Stable strategy for constructing, exploiting, interpreting, and adapting one capability | APPEND + doctrine; operating reference records complete feature/coverage mapping; description/schema carries executable forms |
| One-tool parameter, limit, combination, advanced operation, or local recovery mechanic | description/schema + operating reference + focused contract/schema-drift test |
| Renderer loses native meaning or request-specific continuation identity | renderer/formatter + regression test |
| Backend integration defect | integration code + direct-backend parity test |
| Lifecycle/health/scope defect | lifecycle/setup code + fixture/runtime proof |
| One-repository calibration | evidence until reproduced |
| Operator procedure | setup/debug skill |
| Current limitation/future proposal | current plan |

A defect may reveal a durable reasoning lesson, but defect-specific workarounds do not belong in runtime guidance. The change-surface decision procedure is `docs/evaluation-workflow.md:agent-evaluation-workflow/change-surface-decision#2`.

## Verification standard

Match evidence to the claim (the full ladder is owned by `docs/evaluation-workflow.md:agent-evaluation-workflow/evidence-ladder#2`):

- source/unit tests: implementation contract;
- fake backend fixtures: wrapper behavior;
- direct real backend probes: integration parity;
- doctor/audit: setup and artifact health;
- focused Pi execution: runtime behavior;
- fresh session-enabled interactive evaluation: agent choice, interpretation, and UX.

Use the model, thinking level, and session baseline owned by `docs/evaluation-workflow.md:agent-evaluation-workflow/required-baseline#2`. Never inspect or configure API keys. Automated capture may assist collection but does not replace transcript-level judgment.
