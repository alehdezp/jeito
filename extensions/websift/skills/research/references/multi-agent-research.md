# Multi-Agent Research

Purpose: use subagents only when role separation improves research quality enough to justify cost and coordination.

## When to use

Use multi-agent mode for W4 or explicit multi-agent requests when the question has independent lanes, genuine breadth, adversarial verification needs, or strong benefit from parallel scouts.

Avoid multi-agent mode when:

- the task is W0-W2;
- all workers need the same full context;
- synthesis quality matters more than breadth;
- the research folder state is not prepared;
- the expected output would duplicate searches instead of reducing uncertainty.

Escalation heuristics:

- W3 with independent lanes: 2-4 narrow subagents only if useful.
- W4 broad/novel/adversarial: 3-6 subagents, rarely more without explicit budget.
- One verifier or judge is often more valuable than another scout.

## Roles

| Role | Use | Output |
|---|---|---|
| Lead | Frame, route, assign, synthesize, decide stop conditions. | Updates `ACTIVE.md`, parent route state, and final answer. |
| Scout | Explore one lane: official, implementation, paper, social, criticism, provenance. | Short findings with URLs, content classification, and gaps. |
| Verifier | Independently test candidate claims and warrants. | Pass/fail claims with exact evidence or rejection reason. |
| Contrarian | Search failure modes, alternatives, stale docs, misleading marketing. | Risks, contradictions, and what would change the answer. |
| Judge | Score completeness, citation fit, requirement fit, and evidence debt. | Compact review; no final answer. |
| Tool-scout | Check specialized tool/source lanes and limitations. | Tool routing recommendation and limits. |

## Contract

Give each subagent:

- narrow objective;
- lane and excluded lanes;
- source types to prioritize;
- max effort/time/breadth;
- current objective summary and only the necessary state excerpt;
- output schema;
- requirement to classify content: target, shell, block, metadata, raw, summary-only;
- requirement to say what each source proves, does not prove, and next best lead.

Do not pass the whole research context. The research folder is the memory.

## Artifact handoff

Subagents should return compact artifacts, not final answers. Lead agent consolidates into parent state:

- update route statuses in `ROUTES.md`;
- update useful synthesis in `FINDINGS.md`;
- update important support in `EVIDENCE.md`;
- update next action in `ACTIVE.md`;
- move raw/detail artifacts to `agents/` or `raw/` only when useful.

## Model/effort posture

Use stronger reasoning for lead synthesis, verifier, judge, and high-stakes ambiguity. Use cheaper/faster workers for broad scout, duplicate filtering, and first-pass source triage. Raise reasoning effort for technical, contradictory, or central claims; keep routine scouts lighter.

## Anti-patterns

- Starting scouts before `ACTIVE.md` and `OBJECTIVE.md` exist.
- Giving every scout the whole context and asking them all the same question.
- Letting scouts produce final answers.
- Treating subagent output as evidence without fetched/read source support.
- Running more scouts instead of a verifier/judge when evidence quality is the gap.
- Keeping subagent transcripts in active context instead of summarizing route/finding/evidence state.
