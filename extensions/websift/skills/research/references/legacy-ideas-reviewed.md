---
updated: "2026-09-23 12Z"
---
# Legacy Ideas Reviewed

This file records which ideas from prior local research notes influenced the current `$research` workflow. It is provenance and guardrail, not a requirement to merge old docs.

Sources considered included:

- `/Users/example/atlas/research/research-methods/workflow/improve-pi-research-workflow/plan/`
- `/Users/example/atlas/research/research-methods/workflow/improve-pi-research-workflow/passes/2026-05-round-1/`
- `/Users/example/atlas/research/research-methods/workflow/improve-pi-research-workflow/references/quick-discovery-recipes/`
- `/Users/example/atlas/research/knowledge-systems/memory-and-context/design-agent-memory-governor/00-meta/`
- `~/.pi/.tmp/navigation-tool-research/*`
- related tool-ecosystem and search-workflow notes under `~/.pi/.tmp/`

## Adopted ideas

### Fast restart / compressed active state

- **Problem solved:** New agents should not reread huge chat histories, raw logs, or old artifacts to continue.
- **Fit:** Directly supports better-framed, less-drifting W2/W3/W4 research.
- **Why worth it:** One `ACTIVE.md` is cheaper than repeated rediscovery.
- **Why not overengineering:** It is a compression surface, not another ledger.
- **Not adopted:** Large per-agent artifact directories as default.

### Route memory

Inspired by navigation-tool research where candidates were kept, piloted, deferred, or discarded with reasons.

- **Problem solved:** Agents repeat already-discarded paths when rejection reasons are not preserved.
- **Fit:** Makes searches nonrepetitive and lets future work review why routes were accepted/rejected/deferred.
- **Why worth it:** `ROUTES.md` directly governs next search choice.
- **Why not overengineering:** One compact route table replaces many separate logs.
- **Not adopted:** Full backend benchmark matrices for every research task.

### North-star/objective document

Inspired partly by Memory Governor `PROJECT_BRIEF.md`, but compressed and generalized.

- **Problem solved:** Agents drift toward easier adjacent questions.
- **Fit:** Keeps objective, subobjectives, scope, and stop criteria visible across turns.
- **Why worth it:** Objective drift is one of the highest-cost research failures.
- **Why not overengineering:** `OBJECTIVE.md` is not a protocol, task list, or findings dump.
- **Not adopted:** Separate project brief, open questions, assumptions, glossary, protocol, and ADR files by default.

### Evidence and warrant discipline

Inspired by existing `$research` methodology and Memory Governor evidence rules.

- **Problem solved:** Findings become unsupported memory if evidence is not attached to important conclusions.
- **Fit:** Keeps source-dependent recommendations honest while allowing lightweight W2/W3 operation.
- **Why worth it:** Important claims need support and limits.
- **Why not overengineering:** `EVIDENCE.md` only records important conclusions; it is not a giant source ledger by default.
- **Not adopted:** Tagging every sentence or creating separate claims/sources/contradictions files by default.

### Pre-research framing gate

Inspired by prior meta-research emphasis on adaptive search and by the observed failure mode of searching with too many unknowns.

- **Problem solved:** Agents begin deep searching before they understand the objective, local context, or critical uncertainties.
- **Fit:** Makes W2/W3/W4 better framed before spending search/fetch/subagent budget.
- **Why worth it:** A short framing pass prevents larger wasted investigations.
- **Why not overengineering:** It creates only launch state and asks only critical questions.
- **Not adopted:** A rigid multi-phase research lifecycle.

### Optional nested investigations

Inspired by larger research folders and tool-research branches, but made optional.

- **Problem solved:** Large subtopics can bloat the parent active files.
- **Fit:** Preserves deeper work while keeping parent context restartable.
- **Why worth it:** Allows ordered large research without huge markdown files.
- **Why not overengineering:** Only create when a route has its own objective/detail burden.
- **Not adopted:** Automatic subfolders for every source type or every scout.

## Rejected default ideas

### ADRs by default

Rejected because research progress is not always an architectural decision. ADRs are useful only when a hard-to-reverse decision with real tradeoffs has been made.

### Six-phase research protocol

Rejected as too domain-specific and too heavy for general W2/W3/W4 research. It was useful for Memory Governor architecture work, not a generic default.

### Separate claims/sources/contradictions/recommendations files by default

Rejected because they create document sprawl. Use `EVIDENCE.md`, `FINDINGS.md`, and `ROUTES.md` unless W4 evidence volume truly justifies specialized files.

### Default multi-agent artifact structure

Rejected because multi-agent output is expensive and often repetitive. Use `agents/` only for W4 or explicit multi-agent runs.

### Central canonical research storage

Earlier guidance rejected forced `~/.pi/research` storage because it was an unstructured home-folder dump. A maintainer later used a structured Atlas library with project-local `.research` access pointers. The portable contract now defaults to project-local `.research` and permits an explicitly selected existing library via `JEITO_RESEARCH_ROOT`; structure, provenance, restart state and safe links remain necessary. Historical paths above are source provenance, not instructions to create them.

### Full source ledgers for every W2/W3

Rejected because evidence sprawl is not the goal. Preserve raw/source detail only when it supports important conclusions or future verification.

## Current design standard

Adopt an old idea only when it improves one of these outcomes:

1. faster restart;
2. better objective framing;
3. less drift;
4. less repeated discarded work;
5. clearer next search/action;
6. evidence-backed conclusions without evidence sprawl;
7. ordered large research through progressive disclosure.

Otherwise reject it as ceremony, even if it appeared in prior local research.