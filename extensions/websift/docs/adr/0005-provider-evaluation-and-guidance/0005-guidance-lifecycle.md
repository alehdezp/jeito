---
title: "ADR 5.5 — Tool schema, research skills, and APPEND guidance lifecycle"
description: "Records authority and migration for Pi tool definitions, first-use hooks, provider-expanded guidance, mini-research W1/W2, research W3/W4, cross-tool APPEND routing, apprenticeship evidence, and the APPEND decision ledger."
tags: [jeito-websift, adr, tool-schema, first-use-hooks, mini-research, research-skill, append]
created: 2026-07-28
updated: 2026-08-04
status: active
adr_id: ADR-005.005
adr_type: child
decision_status: accepted
confidence: user-stated
evidence_grade: mixed
implementation_status: in-progress
decision_owner: alehdezp
owns: "Provider/research guidance lifecycle, W1/W2, W3/W4, first-use hooks, cross-tool APPEND routing, and recommendation evolution"
audience: contributor
parent: docs/adr/0005-provider-evaluation-and-guidance/README.md
related: [docs/WORK-PLAN.md, docs/adr/0005-provider-evaluation-and-guidance/0004-benchmark-and-selection.md, docs/adr/0001-product-and-evidence/0005-tool-local-agent-guidance.md]
---

# ADR 5.5 — Tool schema, research skills, and APPEND guidance lifecycle


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-005 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: user-stated`, `evidence_grade: mixed`, and `implementation_status: in-progress`. Extension-owned skills, tool-local first-use guidance, scenario-bounded provider guidance, and package-resource proof are implemented; restarted-process identity after the 2026-08-04 collision repair remains open.

## Authority by layer

- **Installed SDK/source:** what a provider operation accepts and returns.
- **Focused execution:** whether jeito maps and represents that contract correctly.
- **Focused comparative execution:** which provider/mode performs better for a named task under a recorded version and cost.
- **Registered Pi tool definition:** the role and evidence boundary in `description`, exact field contracts in parameter descriptions, one high-attention `promptSnippet`, and one coherent `promptGuidelines` string containing the complete ordinary-use flow. [ADR-001.005](../0001-product-and-evidence/0005-tool-local-agent-guidance.md) owns this stack-wide boundary.
- **`mini-research`:** bounded W1/W2 source work using the four startup-active websift tools; it escalates instead of loading lazy specialists merely for breadth.
- **`research`:** consequential W3/W4 method, lane selection, exact-name activation of one decision-relevant provider specialist, rejection memory, source verification, compact state, and closure.
- **APPEND:** stable cross-tool evidence rights, external-evidence routing, and the activation boundary between ordinary calls, W1/W2 mini-research, and W3/W4 `$research`; never the owner of operation-level tool usage.
- **First-use hooks and provider-expanded guidance:** concise situational help after the live schema exists and accepted apprenticeship evidence plus interactive owner review establishes what should be taught; never an inferred provider manual or automatic winner announcement.
- **APPEND decision ledger:** why APPEND contains that universal cross-tool routing, what it replaced, its provenance, and when it should reopen.

No lower layer may manufacture a claim owned by a higher one. Provider documentation does not prove comparative quality; a focused comparison does not redefine the SDK contract; APPEND does not duplicate a provider manual; a skill does not invent parameters absent from the live schema.

## Canonical skill ownership and migration

The current source to preserve and challenge is
`/Users/example/.pi/agent/skills/research/`. It owns the historical W0–W4 router,
provider playbook, evidence rights, rejection loop, and G0–G5 closure behavior used by
the previous extensions.

The final source-controlled owners are:

```text
extensions/websift/skills/mini-research/SKILL.md
extensions/websift/skills/research/SKILL.md
extensions/websift/skills/research/references/
extensions/websift/skills/research/templates/
```

`mini-research` consumes a bounded subset of the shared references for W1/W2. It must
not fork provider recommendations or evidence rules into a second independent copy.
`research` owns W3/W4 and the shared reference corpus. Both ship from the web extension
and evolve in the same provider/apprenticeship slice.

Migration used stage-copy-verify, then an explicitly approved cutover. The complete source and candidate were compared under `.tmp/web-research-skill-migration/`, outside package discovery. After approval, the global owner moved to `/Users/example/.pi/agent/.skill_backups/research-pre-jeito-20260731`, and the verified `research` plus `mini-research` candidates moved into the final paths above. The websift manifest recursively collects `./skills`; the aggregate recursively collects `./extensions/*/skills`.

Pi skill loading makes duplicate ownership a concrete risk: `dist/core/skills.js::loadSkills` keeps the first skill for a name. The 2026-07-31 cutover removed the old `~/.pi/agent/skills/research` owner and proved the package skills after restart. A separate generic `~/.agents/skills/research` later shadowed the package on a 2026-08-04 reload; it was renamed to manual-only `background-research`, leaving `extensions/websift/skills/research` as the only load-eligible `research`. Current parser and package-resource proof passes; another Pi restart must confirm live owner selection. Rollback of the original cutover remains the preserved backup procedure, not simultaneous registration.

## Research depth boundary

- **W0 known source:** fetch/read the known source directly; no skill ceremony.
- **W1 fact check:** one current authoritative source, fetched and checked against the exact claim.
- **W2 mini-research:** normally two or three independent source checks, primary-source fetching for the consequential claim, one contradiction check, and explicit limits. No Atlas folder unless the work becomes resumable or consequential.
- **W3 structured decision:** eligibility contract, mini-ledger, scoped warrants, adversarial checks, and primary-source verification.
- **W4 deep investigation:** multiple required lanes, compact durable state, criticism/provenance checks, rejection mutation, evidence debt, and G0–G5 closure.

Escalate from `mini-research` to `$research` when sources conflict, the user asks for
best/superior/current comparative judgment, the decision affects architecture, money,
security, law, or strategy, social/frontier evidence is consequential, or a central
claim remains a provider summary rather than fetched primary evidence.

## Previous guidance is an apprenticeship baseline

Retain these current hypotheses until challenged:

- lexical/Google-style search for exact names, official pages, dates, criticism, and provenance;
- Exa semantic/hybrid search for unfamiliar vocabulary and adjacent fields;
- Exa similarity only from a seed that already passed hard fit;
- Exa answer/research/deep synthesis as scouts requiring primary-source verification;
- Tavily as a second lane when topic/time/raw-content controls matter;
- Tavily map before bounded crawl when site structure is unknown;
- Linkup rendered fetch for JavaScript-heavy shells and rendering-off for static speed;
- Linkup deep search only when iterative behavior addresses a demonstrated gap;
- X with exact dates and handles for first-hand social evidence;
- all search, catalog, and synthesis output as leads until the relevant source is fetched.

These statements are grounded as existing authored guidance, not as measured provider
rankings. Focused exercises name them explicitly so a contradiction updates the
recommendation rather than disappearing.

## Phase 1 audit: historical guidance inventory

The global research skill (`/Users/example/.pi/agent/skills/research/`) and the Atlas
architecture investigation
(`/Users/example/atlas/research/pi-systems/tool-runtime/design-owned-web-retrieval-stack/`)
were audited for consequential recommendations. Each carries a stable `HG-<LANE>-NN`
identifier. Provider-comparative and operational hypotheses appear in
[ADR 5.2](0002-provider-contract-baseline.md) with contract relationship and in
[ADR 5.4](0004-benchmark-and-selection.md) with apprenticeship exercise or non-comparison proof mapping.

Source selectors use the exact `RESEARCH_ROOT` and `ATLAS_ROOT` definitions in ADR 5.2. HG-EVIDENCE-01–06 and HG-CATALOG-02 have provenance `historical user-authored guidance`, confidence `user-stated`, and an evidence limit of “governing method or activation rule, not measured provider quality.”

### Universal evidence invariants — category error for comparative testing

These apply to all providers equally and cannot be confirmed or refuted by a
provider-vs-provider comparison:

| HG ID | Claim | Exact source selector(s) | Why comparative testing is category error |
|---|---|---|---|
| HG-EVIDENCE-01 | All search/answer/catalog output is lead-only; fetch primary sources before recommendation-driving claims | `RESEARCH_ROOT/SKILL.md::Non-negotiable research standard` item 3; `RESEARCH_ROOT/references/evidence-and-warrants.md::Evidence rights` | Applies to every search/answer/catalog provider equally |
| HG-EVIDENCE-02 | Exact fit precedes quality; one failed hard requirement rejects the result | `RESEARCH_ROOT/SKILL.md::Non-negotiable research standard` item 1 | Admission gate, not provider selection |
| HG-EVIDENCE-03 | No-winner is valid when modalities are exhausted | `RESEARCH_ROOT/SKILL.md::Non-negotiable research standard` item 5; `RESEARCH_ROOT/SKILL.md::Closure Gate — when a run may actually stop` | Outcome state, not provider ranking |
| HG-EVIDENCE-04 | Never relay aggregator claims as verified without primary-source fetch | `RESEARCH_ROOT/SKILL.md::Closure Gate — when a run may actually stop` G5 | Applies to all synthesis providers equally |
| HG-EVIDENCE-05 | External evidence does not override local truth; bind it to version/date/platform | `RESEARCH_ROOT/SKILL.md::Non-negotiable research standard` item 6; `RESEARCH_ROOT/references/search-steering.md::E. Official documentation conflicts with local behavior` | Applicability rule, not provider comparison |
| HG-EVIDENCE-06 | An explicitly requested provider must not silently fall back to another | `RESEARCH_ROOT/references/tool-lane-preflight.md::Provider constraints`; `ATLAS_ROOT/ROUTES.md:12` | User constraint and visible attempt policy, not provider ranking |

Later owner: `skills/research/references/` (shared evidence-rights and lane-preflight
corpus consumed by both `mini-research` and `research`). HG-EVIDENCE-06 also governs
Pi schema routing controls and the ADR routing architecture.

### Activation rules — not provider-contract claims

| HG ID | Claim | Exact source selector(s) | Why not a provider-contract claim |
|---|---|---|---|
| HG-CATALOG-02 | Check skill/package catalogs before designing a new framework; treat results as leads | `RESEARCH_ROOT/SKILL.md::Skills, packages, and existing solutions`; `RESEARCH_ROOT/references/web-tools-playbook.md::Pi package catalog` | Activation boundary, not provider comparison |

Later owner: shared research reference.

### Skill-collision status (verified)

No `extensions/websift/skills/research/SKILL.md` exists. Pi's `loadSkills` keeps the first
skill for a name and emits a collision diagnostic for the later path. A focused probe
retained the global `research` owner and rejected the second path. The extension-owned
`research` owner waits for the explicit stopped-process cutover gate (Phase 6).

## Pi tool-schema writing rule

Long descriptions are acceptable when every sentence changes the call. Each public
provider branch or consequential field should answer:

```text
Use when:
Avoid when:
What this changes:
Evidence returned:
Cost/latency consequence, if known:
Constraint or incompatibility:
```

Do not put parameter definitions in APPEND or require a skill to reconstruct a vendor
wire object. Use exact enums and bounds from current source. Do not include experiment
history, marketing language, or unsupported “best” claims in the schema. A recommendation
says “ADR 5.4 recorded X for task Y under call packet Z,” not “provider X is best.”

## Skill update rule

After an accepted contract or apprenticeship decision:

1. update the live Pi tool schema when parameters, bounds, incompatibilities, result rights, or call construction changed;
2. update `skills/research/references/web-tools-playbook.md` when provider/lane selection changed;
3. update `skills/research/references/tool-lane-preflight.md` when availability, activation, fallback, or evidence rights changed;
4. update `mini-research` only when W1/W2 routing or closure changed;
5. update the W3/W4 skill body only when serious-research method or activation changed;
6. preserve the replaced recommendation and reason in the apprenticeship ADR decision history;
7. add multi-provider and repeated-query examples only after the live schema lands;
8. keep rejection mutation, primary-source fetching, and closure independent of provider rankings.
9. update first-use hooks and provider-expanded guidance only after the current contract, conformance, focused evidence, and interactive `alehdezp` selection agree; keep the universal APPEND route separate.

Every provider/tool exercise that can change guidance must leave durable evidence in
this extension: contracts in `docs/upstreams/`, apprenticeship method/results/decisions in
`docs/adr/0005-provider-evaluation-and-guidance/`, active guidance in the skill references and tool schema,
and a terse event in `CHANGELOG.md`. Raw temporal runs stay in `.tmp/`; an Atlas research
folder may hold resumable working state but cannot be the only record supporting shipped
guidance.

`web_answer` remains a bounded scout/verification/brief operation. It does not replace
W3/W4 research state, rejection mutation, or closure even if it scores well on report
tasks.

## First-use hooks and provider-expanded guidance

All four tools remain enabled. A first-use hook may orient an agent to the tool's evidence rights, recovery path, and nearby advanced guidance; provider-expanded help may explain accepted scenario-specific controls when needed. Neither surface may infer provider strengths from source docs, fake-adapter tests, or one live smoke. Their trigger model and content are designed only after sufficient focused evidence and interactive owner acceptance, and must preserve concise schemas rather than duplicate full provider manuals.

## APPEND rule

APPEND may retain only the stable cross-tool routing needed before a particular websift tool is chosen:

- search, answer, and catalog results are leads;
- fetch surviving primary sources before recommendation-driving claims;
- route discovery, known-source retrieval, versioned docs/catalogs, and bounded synthesis to their owning active tools;
- use `mini-research` for bounded W1/W2 source work and `$research` for W3/W4 hard, current, comparative, social, multi-constraint, or consequential investigation.

APPEND must not teach websift fields, call construction, adaptive page flow, cache reuse, provider tactics, or operation-level recovery. [ADR-001.005](../0001-product-and-evidence/0005-tool-local-agent-guidance.md) assigns that complete ordinary-use guidance to each registered tool's description, parameter descriptions, prompt snippet, and single coherent guideline string. Skills retain research method and deeper provider recipes; project documentation records architecture and current behavior rather than acting as a parallel runtime prompt.

Every future APPEND mutation still uses `$op-edit-system-prompt`: resolve the canonical symlink target, show the complete change, create an exact backup, obtain confirmation, write atomically, validate, and update the APPEND section ledger/changelog in the same session. No APPEND mutation is required for a tool-local usage change.

## Drift checks

- A provider/version change marks selection-driving guidance experimental until the affected contract and focused apprenticeship exercise pass.
- A schema description naming a provider advantage must link in the owning ADR to the accepted exercise that established it.
- Repo silence or missing retained-session calls never proves a provider operation is useless.
- If schema and a skill conflict, current source owns parameters and the latest accepted apprenticeship decision owns comparative guidance; fix every affected active owner in the same slice.
- If `mini-research`, `$research`, and APPEND disagree about research depth, this ADR owns the boundary until a new user decision or experiment changes it.
- Never load both the old global and extension-owned `research` skill.

## Alternatives and decisive trade-off

Putting complete operation guidance in APPEND would consume always-on context and drift from active schemas. Putting exact parameters only in skills would hide them from ordinary calls. Duplicating guidance in mini and full research skills would create two owners. Registered tool definitions own complete ordinary use, one shared skill corpus owns provider/research method, APPEND owns only cross-tool evidence routing, and ADRs own why.

## Evidence and verification

The preserved migration backup and source manifests prove the historical method: 33/33 files retained, 26 byte-identical, seven adapted for current tool names/live constraints/research-depth ownership, all templates present, and six reference files byte-identical. The 2026-08-04 repair leaves one load-eligible `research` name under `extensions/websift`, makes the superseded generic helper manual-only as `background-research`, and teaches one exact lazy specialist per evidence gap. `validate-skills.mjs` passed for `research`, `mini-research`, and `background-research`; the focused package-resource contract passed 8/8 and now resolves every Web-owned skill from both aggregate and standalone manifests. Identical DeepSeek/Qwen pressure reviews passed the narrow-paper, known-URL, empty-X, and provider-roulette cases. Fresh restarted-process identity is not yet re-proven.

## History

- 2026-07-28: Preserved the existing decision while moving it into the numbered master/child ADR hierarchy.
- 2026-07-28: Verified the duplicate `research` name behavior against current Pi loading: the first path wins and the later owner is rejected with a collision diagnostic.
- 2026-07-31: added first-use hooks and provider-expanded guidance as post-contract, post-conformance, post-apprenticeship, interactive-owner rollout surfaces; no trigger or provider recommendation was selected.
- 2026-07-31: after explicit owner approval, completed the disk cutover to package-owned `research` and `mini-research`, moved the original global tree to the rollback path, and verified parser/resource identity.
- 2026-07-31: `alehdezp` reloaded Pi and confirmed both package-owned skills are present and working, closing restarted-process identity verification.
- 2026-08-04: narrowed APPEND to cross-tool evidence routing and delegated complete ordinary tool use to ADR-001.005 and each registered tool definition.
- 2026-08-04: a later `~/.agents/skills/research` collision was observed after reload. Renamed that generic helper to manual-only `background-research`, restored the websift extension as the sole active `$research` owner, updated W3/W4 guidance for four startup tools plus four exact-name lazy specialists, and added standalone websift skill-resolution proof; restart verification remains pending.
