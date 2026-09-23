---
title: "Tool guidance architecture"
description: "Where each tool's operating manual lives, how it reaches the model, and the writing rules every tool draft follows."
tags: [tool-guidance, prompt-guidelines, writing-rules, tooltap, codeweave-pi]
created: 2026-08-18
updated: 2026-09-21
status: active
owns: "Tool-guidance authoring contract: three-layer split, writing rules, delivery fusion, and maintenance flow"
audience: mixed
related: [README.md, extensions/codeweave-pi/docs/tool-operating-reference.md, extensions/websift/docs/adr/0001-product-and-evidence/0005-tool-local-agent-guidance.md]
---

# Tool guidance architecture

Every registered tool owns its complete operating manual in three text
homes, and tooltap delivers them to the model as one fused
description. This doc is the contract every tool change in this suite
follows, so future tool work is fast and consistent.

## The three layers

| Layer | Owns | Position in the pack |
|-------|------|----------------------|
| description | what the tool does, when to call it, one gate, one minimal example | first block |
| promptGuidelines | the non-obvious leftovers — composition, the recommended escalation, a genuine trap; a few short lines, or none | second block |
| parameters | per-field what/when/advanced/benefit, plus one complex worked example | third block |

The three blocks are read together, as one continuous text, in this
order: description → promptGuidelines → parameters. No block repeats
what an earlier block already explained.

Delivery note: on the GPT startup route, guidelines may not reach the
model until the D9 fusion lands (see Delivery contract). That contract
makes this safe by design — every pre-call constraint lives in the
description or parameters, which always arrive.

## Writing rules

1. The three blocks are read together, in this order: description →
   promptGuidelines → parameters. No block repeats what an earlier
   block already explained. A fact has exactly one home.
2. Static text teaches only what the agent must know before the call
   and what no runtime message will ever teach. If the tool explains a
   behavior in its own result or error text, the static layers must not
   repeat it — improve the message instead.
3. Optimize for what the tool can do, not for what can go wrong.
   Advanced usage means advanced construction — the grammar, the block
   operations, a worked example — never error recovery, never a
   once-per-session scenario that would cost a line in every prompt,
   every session.
4. description = what + when + one gate + one minimal example.
   parameters = per-field what/when/advanced/benefit + one complex
   worked example where it teaches more than the fields can.
   promptGuidelines = only the non-obvious leftovers — composition,
   recommended escalation, a genuine trap — a few short lines, or none.
   No Use/Read/Recover/Stop skeleton, no headers added for symmetry.

## Word rules

Tool-facing text speaks in things a new agent already knows from
training: unix tools (grep, cat/sed, ls/tree, find(1)), git diff,
bash, LSP diagnostics. Reference points must be things the agent
itself uses and knows — not things only a human sees. An editor's red
squiggles are a human visual; the agent knows LSP diagnostics. If a
phrase needs a moment of decoding before it helps, rewrite it or
delete it. When an old instruction cannot be reframed to help a new
agent, delete it.

The freshness words never appear in tool-facing text: live, current,
stale, fresh, real-time. Every tool just does the work; none is stale,
none is live. (This rule is the one place those words are allowed to
appear: the list that bans them.)

Internal and third-party brand names never appear in agent-facing
text: LeanCTX, Graphify, QMD, pi-nav, and the rest. Describe
behavior — "compression", "language server diagnostics", "code graph"
— never the brand.

A new agent that reads a tool's text should master the tool
immediately, without spending time understanding it — one read, and
the tool's use is obvious.

## Drafting protocol

No tool draft is written without verification first:

1. Read the tool's code — its registered schema, validation, and
   execution path.
2. Run the tool — observe a real call and a real result.
3. Understand every option — what each accepts, rejects, and changes.
4. Verify every example in the draft resolves against the real tool.
   Stale examples are drift: the shipped read examples
   `setup/install/#2` and `invariants#2` failed live and were replaced
   with selectors verified against the current docs.
5. Then draft the three layers for a super-smart agent new to the
   harness.

The registered schema strings and the doc draft are one text — they
are written together and can never drift apart. Every tool lands only
after the user reviews its complete three-layer draft.

One hard worked example, well explained, beats ten trivial ones.
Prefer one complex example that shows several advanced capabilities in
a single call over a list of simple examples.

## Parameter style

Each parameter states: what it is, when to use it, how to use it
advancedly, and what benefit to expect. Parameters may expand as much
as the field genuinely needs — compact, intuitive, and never hiding an
advanced feature a new agent would not guess.

## APPEND boundary

APPEND_SYSTEM.md keeps cross-tool doctrine plus the uncertainty-keyed
owner map in its Part II opening (each line: a class of not-knowing →
the tool that owns it, in training-familiar words). APPEND never
re-lists per-tool parameters or per-tool manuals — those live in the
tool's own three layers. The exhaustive per-field inventory lives in
extensions/codeweave-pi/docs/tool-operating-reference.md (maintainer
reference), guarded by the schema-drift test.

## Delivery contract

Extensions register three clean layers and never pre-fuse them.
tooltap glues promptGuidelines onto the description once,
deterministically, for every enabled tool on every route; an operator
override wins over the built-in text, and nothing is duplicated.

Status: the fusion for startup tools on the GPT route is a settled
decision with its mechanism implementation parked (D9, deferred). Until
it lands, startup-tool guidelines may not reach the model on that
route. Writing rule 2 makes this safe by design: every critical
constraint lives in description or parameters, which always arrive.

## Length budget

Each manual is as long as its flow genuinely needs — no hard word cap.
The governor is measurement: a token snapshot before and after landing,
plus a cache-hit check, rejects only an actual cost collapse.

## Tests that protect this contract

- codeweave-pi: each tool registers at most one non-empty promptGuidelines
  string; a tool may approve with none. No test demands a skeleton, a
  minimum length, or a bridge line — wording is enforced by review, not
  by a robot check.
- The old APPEND-coverage test that demanded every parameter appear
  inside APPEND is deleted — its premise is the rule this doc repeals.
- The schema↔reference drift guard stays.
- tooltap: when the D9 fusion lands, one delivery test proves every
  enabled tool receives fused guidelines deterministically (same input,
  same output) and operator override wins without duplication.

## Review sequence

The copy-paste trio first (explore.code, trace, diff), then the hard
tools (edit, explore.map, docs_search) before the easy ones — hard
reviews correct the template early, when few specimens exist to
re-check. Each tool lands only after user review of its complete
draft. Complete: all twelve manuals drafted and approved; see
Specimens and status.

## Specimens and status

- First implementation of this pattern anywhere: the web extension
  (ADR-0005).
- First codeweave-pi specimen: grep — code-verified, run, and approved.
- Completed and approved under the four rules: explore.code, trace,
  diff, docs_search, edit, grep, read, find, ls, write (codeweave-pi) and
  bash, jobs (shell).
- Landed 2026-08-20: all twelve registrations updated (descriptions,
  parameters, promptGuidelines — one string per tool; find/ls/write
  approve with none), APPEND restructured to cross-tool doctrine plus
  the claim-class owner map, tests flipped/deleted per Q5, reference
  and ledger updated. See
  `design-sessions/2026-08-20-tool-guidance-move.md`.
- Remaining: a `/stow-dump-context` delivery proof on the live route
  once the D9 fusion lands.

## Design-session records

Consequential design decisions get recorded as a redacted markdown
session in codeweave-pi/docs/design-sessions/ before implementation. The
same practice is recommended for every project: record decision
sessions, not just outcomes.
