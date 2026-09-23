# jeito

jeito is a [Pi coding agent](https://pi.dev/) harness built by treating instructions, context and tool interfaces as connected engineering work. The versioned instructions keep the user's requested outcome and unresolved questions in view. The extensions let the agent draw on repository, research and execution evidence as the task develops, at the depth the next decision calls for.

A recurring design choice is reversible reduction: optional capability can arrive later; a short command reply leaves the full log to inspect; a focused passage keeps the underlying source within reach. Each saves room in the working conversation without making the omitted material disappear. When a caller, a written contract or a change in source could alter the implementation, another inquiry is worth the time and context. Focused tests exercise individual delivery and safety contracts; improved agent decisions remain unmeasured.

This is a source-only work in progress that I use in my own setup, not a supported release. The public tree omits prebuilt native components and codeweave-pi's production Core payload; a clean-machine full-suite install has not been proven. [Documentation](docs/README.md) · [Installation notes](docs/getting-started.md) · [Distribution gaps](docs/publication-readiness.md).

![Animated jeito diagram: understand the task, choose relevant evidence, inspect its limits, then act and check. The sequence is illustrative.](docs/images/jeito-system-hero.gif)

## What each part contributes

| Extension (read more) | Contribution to the harness |
| --- | --- |
| [codeweave-pi](extensions/codeweave-pi/README.md) | Brings implementation, relationships, written contracts and current source into the same investigation at different depths. Prepared evidence carries its limits; edits answer to source the agent has seen. |
| [tooltap](extensions/tooltap/README.md) | Lets an installation grow without putting every optional capability into the starting conversation. Late delivery preserves earlier messages, and discoverability remains separate from permission to run. |
| [shell](extensions/shell/README.md) | Separates command lifetime from the agent's wait. Full results remain recoverable after a short reply, so independent work can continue while dependent work waits. |
| [websift](extensions/websift/README.md) | Keeps research claims connected to saved, inspectable source and makes focused passages available later. A generated answer stays distinct from the page that could support it. |
| [guidepin](extensions/guidepin/README.md) | Carries the task's governing intent and decisions across turns for reassessment. A reminder cannot create a new task or override the user. |
| [draft-lift](extensions/draft-lift/README.md) | Gives the user an unsent place to refine the request against prior context, then decide which version the coding agent receives. |
| [fff search](extensions/fff-search/README.md) | Lets a person bring path knowledge into the request from the editor. The selected file remains a clue to investigate, not a verdict on ownership. |
| [stall-guard](extensions/stall-guard/README.md) | Allows guarded continuation after Pi settles from a separately tagged stall. Newer activity and deliberate aborts stay protected. |
| [context diagnostics](extensions/context-diagnostics/README.md) (standalone) | Captures Pi-assembled context for opt-in diagnosis. The snapshot can be sensitive and does not establish the final provider request. |

## How the working context is assembled

The [working instructions](config/APPEND_SYSTEM.md) ask the agent to identify which uncertainty could change its next action. The harness gives that instruction substance in the evidence it returns: code and document results are scoped and continuable, exact source can be read in chosen slices, and a search that cannot fit every requested occurrence fails as an audit. Complete displayed lines can be checked against the current file before an edit; unseen or changed lines cannot be supplied by a promising search result. Optional capabilities and long command output need not occupy the conversation before they matter.

These constraints leave the agent able to pursue an unexpected connection or a conflicting contract. Speed and context cost matter when they help that work; an extra question is justified when its answer could change the implementation. Focused checks exercise the delivery and edit boundaries, while choosing the right question remains the agent's responsibility.

## Trying jeito

The public tree cannot prepare the full suite from a bare clone because codeweave-pi's production Core is absent. For a smaller experiment, the [installation guide](docs/getting-started.md#install-one-extension-from-a-checkout) explains how to prepare an eligible extension with npm before registering its local path with Pi. Do not register a separate copy beside the aggregate. Cloning does not apply the versioned instructions or host tool settings; [jeito-setup](.agents/skills/jeito-setup/SKILL.md) previews those changes before you choose them.
