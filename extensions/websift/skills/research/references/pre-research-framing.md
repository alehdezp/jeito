---
updated: "2026-09-23 12Z"
---
# Serious-Research Framing

Use this when a W3/W4 objective is not already clear from the user's request or when creating/resuming canonical research state. Do not turn an explicit `$research` request into an unnecessary approval ceremony.

## Frame the decision

Capture:

```text
Decision supported:
Exact target:
Why it matters:
Must-have requirements:
Disqualifiers:
Baseline and superiority dimension:
Date/version/platform window:
Evidence needed:
Quality/adoption signals:
No-winner condition:
```

Ask the user only when an unknown field would materially change eligibility, source lanes, risk, or the decision. If the user already supplied exact requirements and asked to proceed, that is launch approval.

## Resolve prior state

1. Resolve the root according to [`folder-system.md`](./folder-system.md#canonical-location-and-identity). Read its `AGENTS.md` and group/subgroup indexes if present; do not require a maintainer-local Atlas checkout.
2. Search objectives/routes by the actual decision and hard constraints.
3. Resume when decision and success criteria match; use a pass for another date/source round.
4. Start a sibling only when the supported decision or boundary is materially different.
5. Read `ACTIVE.md` first for continuation, then only currently relevant routes/evidence.

## Scan local context when applicable

Before external search, inspect first-party facts that constrain eligibility:

- pinned versions, manifests, current configuration;
- project plans/status/architecture and explicit permissions;
- prior accepted/rejected routes;
- known baselines and current local behavior;
- previous research freshness and evidence debt.

Local context constrains applicability; it does not prove external semantics that belong to current official/upstream sources.

## Write launch state

Keep it compact:

- `OBJECTIVE.md`: contract and drift warnings;
- `ACTIVE.md`: current state, loaded-reference receipt, next actions, blockers;
- `ROUTES.md`: initial lanes plus known false-positive classes;
- `FINDINGS.md`/`EVIDENCE.md`: only verified framing facts worth preserving.

## Preflight completion

Launch when:

- hard requirements are distinguishable from preferences/signals;
- no critical user clarification remains;
- the relevant mandatory references were read and receipt recorded;
- each initial lane tests a named requirement;
- the first query includes decisive positive discriminators and known exclusions;
- the no-winner/stop condition is explicit.

## Failure modes

- Asking approval again after an explicit proceed instruction.
- Starting from topic keywords before eligibility is defined.
- Treating existing research state as timeless truth.
- Creating empty files instead of useful restart state.
- Launching every source lane without saying which requirement it tests.
- Quietly relaxing a hard constraint because initial searches returned no candidates.
