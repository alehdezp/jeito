---
name: cmux-harness-evaluation
description: Evaluate jeito-codeweave-pi or another AI/tool harness through fresh cmux/Pi sessions. Use for live tool-choice, output-interpretation, authority, lifecycle, and UX claims after source and focused-test evidence exists.
disable-model-invocation: true
---

# cmux Harness Evaluation

Use this skill for behavioral evidence, not scorecards. Automated suites and unit tests support a claim; a fresh visible agent session closes claims about tool choice, output interpretation, or UX.

## Baseline

- Use a normal session-enabled Pi launch.
- Use the current session model with low thinking.
- Never use `--no-session`.
- Never inspect, configure, or request API keys.
- If that route cannot answer a tiny prompt, capture the runtime blocker and stop. Do not substitute a provider/model.

## Evaluate one realistic task

1. State the user task, clue, and uncertainty that could change the answer.
2. Start one fresh cmux/Pi session and record workspace/surface, repository root, prompt, model/thinking, extension revision, and expected evidence tier.
3. Observe the first tool, exact rendered parameters/normalization, native rows/diagnostics, and agent interpretation.
4. Judge whether the tool actually matched the uncertainty—not whether it appeared in a transcript.
5. Retest only the concrete failure after its smallest corrective change.

## Required observations

### Navigation

- Does the agent earn a boundary when related docs/tests/config/flows could matter?
- Does it use evidence capabilities rather than fixed tool chains?
- Does it inspect `Search:`/`Pattern:`, qualified target, graph starts, diff source, diagnostics, and omissions?
- Does it preserve native ranks, relationships, provenance, and health limitations in its answer?
- Does it stop when another observation cannot change the claim?

### Source authority and mutation

- Does the agent distinguish complete hash-certified live rows from locators?
- When authority is sufficient and the boundary is earned, does it avoid redundant read/search/diff confirmation?
- Does it use an eight-hex hash and natural operations?
- Does unseen/stale recovery fail or recover conservatively?
- Does it use the edit result’s fresh hash and coordinate manifest for continuation?

### Lifecycle and performance

- Does startup remain responsive without duplicate/full-stack pre-prompt work?
- Are worker/prepare processes background-prioritized and cleaned at shutdown?
- Does a docs query avoid visible UI/event-loop blocking?
- Does the agent interpret pending refresh as pending rather than absence?

## cmux discipline

- `cmux ping` must return `PONG`.
- Keep the shell surface alive after Pi exits so fast failures remain observable.
- Send the prompt and Enter explicitly.
- Capture enough scrollback; a tail can omit the actual answer.
- Use one scenario per surface.
- For long probes, use `bash({background:true})` and `jobs({id,wait,delta,filter})` rather than sleeping blindly.
- Record/close only project-owned panes and process groups.

## Failure classification

Classify the first real blocker before proposing a fix:

- agent boundary/evidence misuse;
- schema or parameter wording;
- renderer/native-output loss;
- stale mounted extension;
- Core, Graphify, QMD, or bundled pi-nav integration/health;
- source authority or edit engine;
- lifecycle/process/performance;
- backend/provider limitation;
- cmux/runtime capture limitation.

Use `navigation-debug` for foreign-repository diagnosis. A backend defect is not an APPEND workaround; a one-repo observation is not a global contract.

## Regression card

```text
title:
user task / expected evidence tier:
repository and resolved root:
prompt and session baseline:
tools and rendered parameters:
native output / diagnostics / authority state:
agent interpretation and outcome:
classification:
smallest correct owner and fix:
focused regression:
live retest result:
limitations and redactions:
```

## Completion

Do not report a broad UX/release claim from an automated capture alone. Preserve evidence under `.tmp/manual-cmux/`; merge only durable behavior into `docs/evidence.md`, `docs/evaluation-workflow.md`, the owning skill, schema, or implementation.
