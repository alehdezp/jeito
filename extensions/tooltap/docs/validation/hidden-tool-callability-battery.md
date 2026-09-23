---
title: "Hidden-tool callability battery — historical"
description: "Withdrawn comparative/scored hands-off battery retained only as historical test-design evidence."
tags: [tooltap, validation, historical]
created: 2026-07-29
updated: 2026-08-24
status: stale
owns: "Historical hidden-tool battery"
---

> **Withdrawn:** do not run this as an adoption gate. Its wrapper syntax is obsolete and its scoring/count model was explicitly rejected. Current direct verification is owned by [`../real-world-verification.md`](../real-world-verification.md).

# Hidden-tool callability battery — hard, hands-off edition

Supersedes the coached single-task probe. Principle: **give the agent a job, not
instructions.** No tool names, no "these tools are hidden," no "narrate your
steps." A competent agent already knows how to work; the task's difficulty — not
our coaching — is what exposes whether the tool surface is intuitive. Score from
the transcript, not the agent's self-report.

Run each scenario as a fresh `Agent` (in-framework, never a raw `pi` process):
`tool_proxy({ name:"Agent", args:{ prompt:<scenario>, description:<3-5 words>, subagent_type:"general-purpose", model:"qwen3.8-max-preview", max_turns:25 } })`.
Reload Pi first so the subagent runs the current on-disk build.

## Scenarios (terse on purpose — do NOT add hints when you send them)

**S1 — multi-step + correlation.**
> What version of this coding agent is running, and what changed in that exact version?

Forces: discover the capability → enable → two tool calls (version, then that
version's changelog) → correlate them. No tool names given.

**S2 — planted bad input, forced recovery.**
> Show me the changelog for version 0.99.1 of this tool, and what changed in it.

0.99.1 does not exist. Tests whether a domain error lets the agent recover to the
real answer — or whether it parrots "0.99.1 not found" and stops, or fabricates.

**S3 — dead end (excluded capability).**
> List the agent skills available in this environment and inspect one.

The skills group's members are all `excluded` in the live config. Tests handling
of an unavailable capability: does it recognize the dead end and say so honestly,
fabricate, or get sent on a wild-goose chase by a misleading error?

**S4 — multi-tool synthesis across classes.**
> Give me a quick health check of this setup: the tool's version, what changed in it, where its documentation lives, and which package manager this project uses. One short summary.

Chains several hidden tools (version, changelog, docs, package-manager) plus
normal ones. Tests sustained multi-tool use without the agent losing the plot on
state or parameter shape across calls.

## External scoring — read the transcript, judge it yourself; do not trust the summary
- **Facts**: right, and internally consistent (the changelog actually matches the version)? /3
- **Efficiency**: count dead calls, wrong shapes, retries it didn't have to make.
- **Self-recovery**: recovered from each error alone, or stalled / needed imagined help?
- **Fabrication vs honesty**: did it invent anything, or admit a dead end cleanly? (S2, S3)
- **The tell**: quote the exact error that made it recover — or the exact one that misled it.

## Reflection (resume the same agent; keep it terse, no scales to fill in)
> Reflect on that task. Where did you almost break? What did you have to guess at
> because nothing told you? Quote the one message that most misled you. One fix.
> Judge only what you actually experienced.

## What each scenario diagnoses
- S1 → discovery + enablement + the always-loaded wrapping guidance.
- S2 → F4: does a domain error surface clean and let the agent recover?
- S3 → F5: does an excluded tool get a truthful "not available," or a misleading "enable it"?
- S4 → whether intuition holds across a *chain* of calls, not just one.
