# Resume, Condense, Archive, and Split

Purpose: keep long-running research restartable from a small active working set while preserving deeper evidence/details only when useful.

## Resume protocol

When asked to continue existing research:

1. Read `ACTIVE.md` first.
2. Follow only the linked current decision or conclusion sections needed for the next action.
3. Check the relevant `ROUTES.md` entries before searching so rejected, deferred, and near-miss paths are not repeated.
4. Check `OBJECTIVE.md` when scope, boundary, or drift is in question.
5. Check only the `EVIDENCE.md` entries supporting claims you will rely on.
6. Do not read `raw/`, `archive/`, old experiments, or agent artifacts unless current state points there.

## Update protocol

After meaningful work, update only the owners whose truth changed:

1. route disposition or revisit condition → `ROUTES.md`;
2. current conclusion → its stable `FINDINGS.md#heading` section;
3. important support, limit, freshness, or conflict → `EVIDENCE.md`;
4. current state or next action → `ACTIVE.md`, after deeper owners;
5. north star, scope, success, or stop criteria → `OBJECTIVE.md`.

If evidence confirms the current conclusion without changing support or limits materially, update nothing. When research changes a skill, instruction, or policy decision, link to that existing owner instead of copying its rationale into research state.

## Condense triggers

Condense when:

- `ACTIVE.md` no longer acts as a fast restart surface.
- Closed route details dominate `ROUTES.md` and distract from active routes.
- Findings are historical and no longer guide next actions.
- Raw notes are only needed for auditability.
- A nested route has enough detail to deserve its own investigation folder.

Condense by moving detail to `archive/<DD-MM-YYYY>-<short-topic>.md` and leaving a one-line summary plus link in the active file.

Do not archive by time alone. Archive when detail no longer helps decide the next action.

## Nested investigations

Create `investigations/<subtopic-DD-MM-YYYY>/` only when a route/subtopic has:

- its own objective or subobjectives;
- enough routes/findings/evidence to crowd the parent;
- hands-on experiments or raw material that would bloat the parent;
- independent agents/scouts/verifiers;
- a need to pause/resume separately.

Nested investigations reuse the same core files when useful, but the parent remains authoritative for the parent objective.

Every nested investigation must write back to the parent:

- route status in `ROUTES.md`;
- condensed result in `FINDINGS.md`;
- central evidence in `EVIDENCE.md`;
- next action in `ACTIVE.md` if it affects the main path.

## OPEN.md promotion rules

Use `OPEN.md` only when ideas/questions/tasks no longer fit in `ACTIVE.md`.

Promote an item:

- to `ROUTES.md` when it becomes a route/hypothesis/candidate to test;
- to `OBJECTIVE.md` when it changes scope or success criteria;
- to `FINDINGS.md` when it becomes useful synthesized knowledge;
- to `EVIDENCE.md` when it becomes evidence for an important conclusion;
- to `archive/` when it is no longer relevant.

## Anti-patterns

- Treating `ACTIVE.md` as a full worklog.
- Re-searching before checking closed routes.
- Keeping all old evidence in active context “just in case.”
- Creating nested investigations for every minor idea.
- Archiving details without leaving a useful pointer.
- Updating findings but not routes, which makes future agents repeat dead ends.