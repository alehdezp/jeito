---
updated: "2026-09-23 12Z"
---
# Research Folder System

Purpose: give W3/W4 research enough durable state to restart quickly, avoid repeated dead ends, and preserve evidence without turning research into document maintenance. W1/W2 work stays stateless unless explicitly escalated.

## Canonical location and identity

By default, use `.research/<group>/<subgroup>/<objective>/` at the current Git project root. If there is no project root, ask for a research location before writing. A user with an existing independent library can explicitly set `JEITO_RESEARCH_ROOT` to its absolute directory; do not expand a relative value against an arbitrary working directory, create that root on the user's behalf, or migrate old work automatically. Resolve the root before looking for an existing objective, and keep research state private unless the user explicitly chooses to version it.

Read the selected root's `AGENTS.md` and group/subgroup indexes when they exist. Do not require an Atlas layout on a fresh install. Name the objective with a stable verb phrase such as `choose-semantic-repository-graph` or `design-session-governor`; do not encode origin project, date, W-level, or lifecycle status in the canonical path. Start from the package's `../templates/research-folder/` if the selected root has no templates. An explicit W3/W4 research request authorizes its normal state; ask before creating state for a request that only called for an answer in chat.

An existing project-local `.research` symlink may point at the selected root. It is an access pointer, not permission to overwrite or repair it. Distinguish absent path, valid link, broken link, regular file, and real directory; never overwrite a regular file/directory or silently follow a link outside the agreed location. Resolve a broken link with the user before writing, so link failure cannot duplicate research.

Continue an existing objective when the decision, hard constraints, and success criteria match. Use `passes/` for another round under the same objective and `experiments/` for a hypothesis test. Create a sibling objective only when the supported decision or boundary materially differs.
## Active working set

A continuing agent should be able to start with only:

```text
ACTIVE.md
```

Then load only the linked sections/files needed for the next action. `raw/`, old experiments, archives, and nested investigations are not default context.

## Core files

### `ACTIVE.md`

Governs fast restart. It should answer:

- What is the current objective?
- What is the current state?
- What should be done next, and why?
- Which routes are active?
- Which accepted/rejected/deferred decisions matter right now?
- Where do deeper details live?

Keep it short. If it stops being fast to read, condense it and move historical detail to `archive/`.

### `OBJECTIVE.md`

Governs alignment. It contains the north star, why the research matters, subobjectives, scope boundaries, success/stop criteria, and drift warnings. It should evolve as framing improves, but it is not a task log or findings dump.

### `ROUTES.md`

Governs non-repetition. It records hypotheses, leads, candidate tools/sources, accepted paths, rejected paths, deferred paths, near misses, and routes needing trials. Every closed route should preserve the compact reason future agents need to avoid repeating it.

Recommended status values:

```text
active | accepted | rejected | deferred | near-miss | needs-trial | superseded
```

### `FINDINGS.md`

Governs condensed knowledge. It contains current synthesis, valuable conclusions, important constraints, and unresolved findings—not raw evidence or a worklog. Give each current conclusion one stable descriptive heading, update that section in place, and link forward to an affected skill, instruction, or policy owner when one exists.

### `EVIDENCE.md`

Governs support for important conclusions. Record only important claims/conclusions, the evidence that supports them, the warrant, limits, and freshness/conflict state. Do not turn this into a giant source ledger unless the research depth justifies it.

## Conditional update rule

Write only where the result changes truth:

- route status or revisit condition changed → `ROUTES.md`;
- useful conclusion changed → the existing `FINDINGS.md` section;
- important support, limit, freshness, or conflict changed → `EVIDENCE.md`;
- current state, blocker, or next action changed → `ACTIVE.md`, after the deeper owners;
- objective, scope, success, or stop criteria changed → `OBJECTIVE.md`;
- affected skill, instruction, or policy decision changed → link the conclusion to that owner and let its lifecycle govern mutation.

A new source that leaves every conclusion and limit unchanged creates no maintenance work. Do not duplicate one conclusion under a new heading; update its stable section and preserve rejected or superseded routes in `ROUTES.md`.

## Optional files/folders

Create these only when they pay for themselves:

- `OPEN.md`: ideas, questions, leads, and tasks that no longer fit in `ACTIVE.md` but are not yet routes.
- `passes/`: distinct research rounds under one unchanged objective.
- `experiments/`: hands-on trials, benchmarks, setup notes, and outputs; each experiment states hypothesis, setup, result, and limits.
- `raw/`: fetched pages, transcripts, command logs, exports, screenshots, JSONL, or exact source excerpts needed for auditability/future verification.
- `investigations/`: tightly scoped child research that is not independently reusable.
- `archive/`: old detail that has been condensed out of active files.
- `agents/`: W4 or explicit multi-agent outputs only.
- `ORIGIN.md`: import history, old paths, and repaired local pointers; web-source evidence remains in `EVIDENCE.md`.

## Creation rule

For W3/W4, create or reuse the folder during the framing gate. Fill only the fields needed to launch well. Empty placeholders are worse than concise `unknown / next action` notes.

When creating an investigation, update an existing owning subgroup `AGENTS.md` if it indexes objectives; a fresh `.research` root does not require inventing group or subgroup indexes. Use unique descriptive H1s (`# <objective> — active state`, not `# ACTIVE`) and explicit relative links so `docs` and `explore.map` can navigate the corpus. For a done investigation, `ACTIVE.md` may be removed or condensed; do not create empty state files for references or historical imports.

## File-size discipline

- `ACTIVE.md`: keep as the start surface; if a new agent cannot resume from it quickly, it has failed.
- `OBJECTIVE.md`: stable alignment only; move execution history elsewhere.
- `ROUTES.md`: compact table rows; split only if a route becomes a nested investigation.
- `FINDINGS.md`: condensed synthesis; avoid dumping source notes.
- `EVIDENCE.md`: important support only; raw material goes in `raw/`.

Do not optimize for the fewest files. Optimize for a small active working set and progressive disclosure of deeper details.