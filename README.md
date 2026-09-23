# jeito

![Animated illustration of jeito's working loop. Understand the task and its constraints; choose among code, documentation, web and relationship evidence; inspect a bounded reply with omissions visible; act with a guarded edit and a check. All stages stay readable when paused. The path is illustrative, not a required tool sequence.](docs/images/jeito-hero.gif?v=system-loop-1)

jeito is the [Pi coding agent](https://pi.dev/) harness I built to make the agent's next step answerable to the task and the available evidence. An agent can make a perfectly precise edit in the wrong subsystem, or follow an outdated plan because it never checked the current repository. The versioned [working instructions](config/APPEND_SYSTEM.md) ask it to understand the intended outcome, test its own framing and distinguish what it observed from what it inferred. The extensions give it ways to do that work. Instructions alone do not prove that a model will follow them.

The diagram shows one possible loop, not a mandatory `explore → read → edit` recipe. A known file may need a literal read; an unfamiliar behavior may need a code neighborhood first; a policy question may belong in project documents. As each result changes what the agent knows, the next question can change too. This is why the harness treats a result as evidence for a *particular claim*, not as permission to finish the whole task.

## Build context that helps the next decision

In a repository, the difficult part is often working out what to inspect. [codeweave-pi](extensions/codeweave-pi/README.md) can use prepared code relationships to locate an owner, `trace` to examine one connection and `docs_search` to find a written contract. Those are leads with provenance and limits. Exact tools then establish the current paths, lines and changes. Complete displayed source can carry a hash into a guarded edit; a graph hit or clipped excerpt cannot authorize unseen rows. The agent still has to decide whether it found the *right* boundary before that edit is justified.

The amount returned matters. A whole file or a broad grep dump can bury the caller, exception or test that would change the decision. A tiny answer that hides missing relationships is no better. Prepared results page candidates and name omissions; documentation search returns sections with locations for a deeper read; exact reads can target the lines or symbols actually needed. When a reply is incomplete, the agent can page, widen or change evidence class instead of mistaking a short response for a complete one. The [navigation doctrine](extensions/codeweave-pi/docs/harness-doctrine.md) explains why discovery remains valuable even when the likely file is already known.

That is the design goal behind **accuracy per token**: spend the conversation on evidence that can improve the next decision, and avoid paying again for identical source already inspected. It is not a benchmark score. Reducing tokens by dropping qualifications, pretending a partial result is complete or refusing to investigate beyond the first hypothesis would defeat the goal.

## Keep the rest of the system honest

A coding turn also waits on commands, opens outside sources and changes which tools the agent needs. [shell](extensions/shell/README.md) lets a slow process keep running after the agent's wait ends. It keeps a captured log for selective follow-up; compression never substitutes for raw capture when exact output matters. [websift](extensions/websift/README.md) retains extracted pages so a focused excerpt can be checked against the rest later. Search hits and generated answers remain distinct from fetched source.

[tooltap](extensions/tooltap/README.md) makes optional tools discoverable without loading every definition at the start. When the agent enables a relevant tool, its contract arrives later rather than rewriting earlier instructions within the same model epoch. That preserves eligibility for provider cache reuse, not a guaranteed cache hit. [guidepin](extensions/guidepin/README.md) appends reminders instead of replacing earlier messages; the tradeoff is that old reminders accumulate. Together with the working instructions, these are choices about what the agent sees, when it sees it and what that information can justify. Host-owned prompt and tool settings are not applied merely by cloning this repository.

The smaller extensions address moments the main loop does not: [draft-lift](extensions/draft-lift/README.md) lets a person compare an unsent request without adding rejected drafts to the task conversation; [fff search](extensions/fff-search/README.md) helps them choose a file in the editor without adding a model tool; [stall-guard](extensions/stall-guard/README.md) resumes only a separately watchdog-tagged stalled turn after checking that no newer work has displaced it. [context diagnostics](extensions/context-diagnostics/README.md) stays separate because its opt-in captures can contain private prompts and messages.

## Follow the implementation

| Area | Start with | Consequential boundary |
|---|---|---|
| Working instructions and goal guidance | [APPEND](config/APPEND_SYSTEM.md), [guidepin](extensions/guidepin/README.md) | A reminder does not become a new task or permission; persistent goal records remain separate from the turn. |
| Project evidence and edits | [codeweave-pi](extensions/codeweave-pi/README.md) | Prepared relationships locate; current displayed bytes and hashes bound mutation. |
| Commands and external evidence | [shell](extensions/shell/README.md), [websift](extensions/websift/README.md) | A short reply retains a path back to the captured run or extracted page. |
| Optional capability | [tooltap](extensions/tooltap/README.md) | Discovery, permission and execution are separate; late access preserves earlier input within the same model epoch. |
| Editor and recovery aids | [draft-lift](extensions/draft-lift/README.md), [fff search](extensions/fff-search/README.md), [stall-guard](extensions/stall-guard/README.md) | Review before sending, choose an explicit path, and resume only a tagged stalled turn. |

The [source-authority layer](extensions/codeweave-pi/src/core/source-authority.ts) and [hashline tests](extensions/codeweave-pi/tests/v3-hashline-read-edit.test.mjs) make the edit boundary inspectable. The [tooltap contract](extensions/tooltap/docs/contract.md) and [websift design](extensions/websift/docs/DESIGN.md) record the other two evidence-placement choices. Focused tests establish their exercised contracts, not a measured gain in agent accuracy, speed or cost.

I use jeito in my own setup. This public GitHub branch is a **source presentation**, not a supported release: it omits prebuilt pi-nav executables and native modules, the locally adapted vendor tree, private working records and the production codeweave-pi Core payload. There is no proven clean-machine full-suite installation or platform guarantee. The [installation guide](docs/getting-started.md) names prerequisites for checkout experiments; [distribution gaps](docs/publication-readiness.md) name the work before a supported release. [Documentation routes](docs/README.md), [contributor guidance](CONTRIBUTING.md), the [MIT license](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md), and the [security policy](SECURITY.md) are available for deeper inspection.
