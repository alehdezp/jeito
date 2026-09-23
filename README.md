# jeito

jeito is a [Pi coding agent](https://pi.dev/) harness I built around the engineering decisions that happen between a user's request and a code change. A system prompt can ask an agent to respect the user's goal, and retrieval can give it relevant text. The harness also has to let the agent challenge an early assumption, inspect what a short reply omitted and distinguish evidence from a plausible guess. I designed its instructions, context delivery and tool boundaries together so the agent can keep reasoning as the task changes.

I chose to remove routine volume only where the detail remains recoverable. Optional capability can arrive later, a short command reply leaves its full log intact, and a focused passage keeps a path to the source. Loading everything at once spends context before relevance is known; unconditional summaries can conceal the condition that changes a decision. The hoped-for benefit is fewer unsupported implementation choices and a codebase that remains easier to work on later. Focused tests verify individual contracts; improved agent decisions, speed and code quality have not been measured.

This is a source-only work in progress that I use in my own setup, not a supported release. The public tree omits prebuilt native components and codeweave-pi's production Core payload; a clean-machine full-suite install has not been proven. [Documentation](docs/README.md) · [Installation notes](docs/getting-started.md) · [Distribution gaps](docs/publication-readiness.md).

![Animated jeito diagram: understand the task, choose relevant evidence, inspect its limits, then act and check. The sequence is illustrative.](docs/images/jeito-system-hero.gif)

## The choices behind the extensions

| Extension (read more) | Engineering reason and intended benefit |
| --- | --- |
| [codeweave-pi](extensions/codeweave-pi/README.md) | A file hit leaves too much reconstruction to the agent. Connected implementation and written intent can help it decide what to investigate next, while current source remains available to challenge an indexed lead. |
| [tooltap](extensions/tooltap/README.md) | A growing installation need not spend the first turn describing every optional capability. Later delivery preserves the prior conversation and the user's permission choices. |
| [shell](extensions/shell/README.md) | The agent's wait and the command's lifetime serve different purposes. Independent work can continue, with the complete output available when the result matters. |
| [websift](extensions/websift/README.md) | A research conclusion should remain answerable to its source. Saved pages and focused passages support follow-up without treating generated prose as evidence. |
| [guidepin](extensions/guidepin/README.md) | The reason for a task should survive changes to its plan. Reminders retain governing intent for reassessment without becoming new instructions from the user. |
| [draft-lift](extensions/draft-lift/README.md) | The person should choose the request the agent receives. An unsent revision avoids carrying discarded phrasings into the coding conversation. |
| [fff search](extensions/fff-search/README.md) | Human knowledge of a relevant path is worth using directly. It narrows the search without claiming that the chosen file owns the change. |
| [stall-guard](extensions/stall-guard/README.md) | Transport failure and a deliberate stop need different responses. Recovery is limited to a watchdog-tagged stall after Pi settles, with newer work protected. |
| [context diagnostics](extensions/context-diagnostics/README.md) (standalone) | When behavior disagrees with the intended instructions, inspect what Pi assembled before changing the prompt. The opt-in snapshot is sensitive and cannot prove the final provider request. |

## What the instructions can and cannot enforce

The [working instructions](config/APPEND_SYSTEM.md) ask the agent to identify the user's outcome, distinguish observation from inference and seek the evidence that could change its next action. The implementation makes narrower guarantees: a bounded result reports meaningful omissions, an exhaustive audit cannot silently turn into a ranked sample, fuller evidence remains reachable, and an edit must answer to source the agent actually saw. These are constraints on what the harness may claim and change. They do not make the agent choose the right question; spending another turn to check a contract can still be the responsible path.

## Trying jeito

The public tree cannot prepare the full suite from a bare clone because codeweave-pi's production Core is absent. For a smaller experiment, the [installation guide](docs/getting-started.md#install-one-extension-from-a-checkout) explains how to prepare an eligible extension with npm before registering its local path with Pi. Do not register a separate copy beside the aggregate. Cloning does not apply the versioned instructions or host tool settings; [jeito-setup](.agents/skills/jeito-setup/SKILL.md) previews those changes before you choose them.
