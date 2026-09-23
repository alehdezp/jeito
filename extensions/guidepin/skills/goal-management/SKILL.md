---
name: goal-management
description: Develop and preserve shared intent across investigation and continuation; use for material reframing, outcome-based decomposition, continuity recovery, or goal scaffolding.
disable-model-invocation: false
---

# Goal management

The goal system preserves and improves shared understanding so work can continue without the user repeatedly reconstructing what matters. Alignment is required; file maintenance supports it. Filled templates and frequent updates do not prove understanding. Current user instructions govern over stale documents. The [system contract](../../../../config/APPEND_SYSTEM.md#1-frame-the-task-before-acting) owns baseline behavior; this skill owns deeper procedure and scaffolding, not permission to expand the work.

## Develop and test understanding

Connect the requested work to the outcome it serves. Distinguish agreed direction, established facts, your interpretation and consequential unknowns. Investigate the uncertainty that could change the direction; do not wait for the user to diagnose a mistaken framing. Reconsider the interpretation when evidence challenges it, even if the nominal scope is unchanged.

When a reframe affects the work, explain the mistaken assumption, the evidence or correction, and what should change. An apology or agreement alone is not a reframe. Correct your interpretation proactively; propose consequential changes to the desired outcome or authority before acting on them. Do not narrate this reasoning as a routine checklist.

Example: “Make installation dependable” initially suggested script fixes. Investigation reveals undocumented dependence on the developer's machine. The outcome is unchanged, but the parent understanding and investigation should change. By contrast, discovering a typo in the script normally calls for a fix, not a goal edit.

## Start or continue

Identify the goal relevant to the conversation; never select by recency or status. For an existing goal, read `goal.md` and `work.md`, then the relevant branch brief and linked decisions as needed. Reuse current context rather than rereading unchanged files each turn. Resolve ambiguity when choosing the wrong goal would change the work.

A short request still needs an understood intent, but not necessarily a folder. For persistent work, use the scaffolder below. Several goals may coexist in a session; identify the relevant goal and branch when switching or delegating.

## Maintain intent and meaningful boundaries

- `goal.md` owns the parent intent, success, authority and understanding needed to interpret them correctly—not a rolling project briefing.
- `work.md` owns distinct unresolved outcomes or questions contributing to that intent, including material pending possibilities.
- A branch brief owns substantial context needed to continue that branch independently.
- `decisions.md` owns consequential choices and their non-obvious reasons.

Create subgoals within scope without waiting for the user to decompose the work. “Research installation tools” is an activity; “Determine whether failures come from packaging or hidden host assumptions” is a subgoal because its answer changes the route. Small actions need no invented subgoal. A branch discovery may reshape the parent understanding; the hierarchy must not block learning.

When a plausible alternative could misdirect continuation, preserve the distinction with its owner: a useful but unwanted outcome, related work that drifts from the goal, an approach that violates an established constraint, or apparent proof that could reward the wrong result. Briefly explain why it misses the intent.

Keep actual authorization and protected constraints. Do not pad boundaries with obvious exclusions, speculative dangers, or every imaginable alternative. Add a branch-specific boundary only when the parent does not already cover it.

Identify the basis for consequential boundaries. User direction and governing requirements establish constraints; evidence can establish facts or challenge feasibility. An agent interpretation remains provisional until resolved. Do not present it as a user decision or let it silently exclude viable methods.

A boundary against pursuing an alternative does not by itself prohibit discussing or investigating it within the authorized scope. Preserve freedom to propose better methods; respect explicit prohibitions on discussion, investigation or action.

Silence leaves a material proposal unresolved, not approved. Remove directions the user contradicts rather than retaining them as pending work. If only an approach is rejected, preserve the still-valid outcome. Record a lasting exclusion with the affected goal or branch; retain its rationale only when useful.

At a consequential choice or completion claim, check whether the same reasoning or evidence could also endorse a relevant near miss. If it could, that evidence does not distinguish the intended result; seek the missing distinction rather than claiming success.

## Persist only what continuation needs

Ask whether the existing account would materially misdirect a continuing agent about the intent, branch or commitment. If not, leave it unchanged. If so, update the narrowest owner of that misunderstanding. A discovery belongs in the parent when it changes the meaning of the goal, even without a scope change; branch findings belong with the branch. When a parent reframe invalidates branches or decisions, revise or retire those affected parts; leave unrelated state alone. Replace superseded state rather than accumulating warnings. Do not erase a governing boundary merely because it makes the current approach difficult.

Routine tool results, local corrections, completed actions, reminders and session boundaries do not by themselves require a file edit. Do not move the same activity log from `goal.md` to `work.md`. Preserve a useful resolution or evidence reference with its owner and remove obsolete open work when necessary for accurate continuation. Keep reversal rationale only when it explains the present or prevents a foreseeable repeated mistake.

## Expand and continue

Start subgoals as short sections in `work.md`. Move a branch into `work/<id>-<name>.md` when independent continuation needs substantial context; use a branch folder only when it genuinely needs several related artifacts. Leave a descriptive link, not duplicate state. Give a branch its own three-file goal only when it becomes independently governed—not because a file is long. Do not maintain a parallel work board in a plan.

A coordinator reconciles shared intent; delegated agents return findings or update explicitly assigned briefs. Reconcile late results with current understanding before incorporating them. For handoff, preserve the goal path, relevant branch, unresolved question and next useful action in the existing handoff. On resumption, read current state rather than treating that handoff as current authority.

Existing ADRs and behavior documentation remain their own authorities; link rather than duplicate them. Do not add a session-summary file, create a `.DONE` ledger, or rewrite historical goals merely to match this format.

## Scaffold a new persistent goal

Run the Python 3 standard-library [scaffolder](scripts/create_goal.py), resolving the script relative to this skill:

```sh
python3 <skill-directory>/scripts/create_goal.py <slug> \
  --title "<title>" --project "<project-root>"
```

It creates `.pi/goals/<slug>/{goal,work,decisions}.md`, refuses existing destinations and symlinked `.pi`/`goals` parents, and never selects a session goal or grants permission. Do not set or advance `updated`/`created` by hand when creating or editing goals—`write`/`edit` manage them automatically. On failure, inspect incomplete output; do not delete existing work or force a rerun. It does not install Python or apply host configuration.

The [goal](templates/goal.md), [work](templates/work.md) and [decision](templates/decisions.md) templates own the format. Fill them from current understanding; remove empty categories and examples instead of inventing facts or decisions. Generated `draft` status is not selection or authorization.
