# jeito

jeito is a [Pi coding agent](https://pi.dev/) harness built on one claim: the quality of an agent's work cannot exceed the quality of the context it works from, and context quality is an engineering surface with its own design. The conventional agent-harness default spends context for throughput: full tool inventory from the first turn, retrieval answered as completely as possible, edits applied on the strength of a plausible patch. jeito refuses each default where correctness depends on the difference. Capability is admitted when it earns its context. Evidence arrives bounded but continuable, with the authority of its source intact. An edit is authorized only by current source the agent has inspected.

The design goal is decision quality under a context budget: fewer unsupported implementation choices, and a codebase that stays safe to change over months. Speed and token economy are accepted or refused per decision; they are never the objective in themselves. When a caller, a written contract or a conflicting result could change the implementation, the harness spends another question, because a confidently wrong change costs more than an extra turn. Focused tests verify individual delivery and edit contracts; improved agent outcomes, speed and patch quality are not measured claims.

This is a source-only work in progress used in its author's setup, not a supported release. The public tree omits prebuilt native components and codeweave-pi's production Core payload; a clean-machine full-suite install has not been proven. [Documentation](docs/README.md) · [Installation notes](docs/getting-started.md) · [Distribution gaps](docs/publication-readiness.md).

![Animated jeito diagram: understand the task, choose relevant evidence, inspect its limits, then act and check. The sequence is illustrative.](docs/images/jeito-system-hero.gif)

## The idea behind each extension

| Extension (read more) | The idea it defends |
| --- | --- |
| [codeweave-pi](extensions/codeweave-pi/README.md) | Evidence keeps its authority class: a ranked lead, an exhaustive audit and a current source read make different claims, and an edit answers only to inspected source. |
| [tooltap](extensions/tooltap/README.md) | Capability is separate from permission: a tool arrives when it earns its context without repricing the turns before it, and discoverability never executes. |
| [shell](extensions/shell/README.md) | Process lifetime and agent attention are separate resources: long work runs on, its result stays recoverable, and the turn answers from what is known. |
| [websift](extensions/websift/README.md) | A research claim is worth its source: pages stay saved and inspectable, and generated prose never stands in as evidence. |
| [guidepin](extensions/guidepin/README.md) | Governing intent outlives plan churn: reminders resurface it for reassessment and can never speak as the user. |
| [draft-lift](extensions/draft-lift/README.md) | The request belongs to the person: revision happens outside the coding conversation, and the agent receives only the wording they send. |
| [fff search](extensions/fff-search/README.md) | Path knowledge from the person is signal, and ownership stays a question for evidence. |
| [stall-guard](extensions/stall-guard/README.md) | A stalled transport and a deliberate stop are different events: recovery applies only to watchdog-tagged stalls after Pi settles. |
| [context diagnostics](extensions/context-diagnostics/README.md) (standalone) | Diagnosis starts from the context the runtime assembled, not from what the configuration appears to promise. |

## What the harness guarantees

The [versioned system prompt](config/APPEND_SYSTEM.md) states the working contract: frame the task before acting, separate observation from inference, return to current source before an edit. Behavioral instructions hold as far as the model follows them. The guarantees below are enforced rather than requested: a bounded result reports what it omits; an exhaustive audit that cannot account for every occurrence fails instead of degrading into a ranked sample; omitted detail stays reachable; an edit cannot touch source the agent has not inspected. Choosing the right question stays with the agent, and another turn spent checking is a cost the design accepts.

## Trying jeito

The public tree cannot prepare the full suite from a bare clone because codeweave-pi's production Core is absent. For a smaller experiment, the [installation guide](docs/getting-started.md#install-one-extension-from-a-checkout) explains how to prepare an eligible extension with npm before registering its local path with Pi. Do not register a separate copy beside the aggregate. Cloning does not apply the versioned system prompt or host tool settings; [jeito-setup](.agents/skills/jeito-setup/SKILL.md) previews those changes before applying them.