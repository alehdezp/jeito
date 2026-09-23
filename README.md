# jeito

A coding agent can make a precise patch to the wrong part of a system. A request names an outcome; the repository gives the agent only fragments of how the system works. The first plausible explanation may be incomplete. If the agent acts on it as though it were certain, the edit can be locally correct and still miss what the user needed.

jeito is the [Pi coding agent](https://pi.dev/) harness I built around that gap. It begins with what the request actually requires, then helps the agent seek evidence that could confirm or change its understanding. When the owner is unclear, investigation can range across the repository. Before changing code, the agent must return to current source it has actually seen. The design keeps a promising lead separate from a justified change, with the remaining uncertainty visible.

This is a source-only work in progress that I use in my own setup, not a supported release. The public tree omits prebuilt native components and codeweave-pi's production Core payload; a clean-machine full-suite install has not been proven. [Documentation](docs/README.md) · [Installation notes](docs/getting-started.md) · [Distribution gaps](docs/publication-readiness.md).

![Animated jeito diagram: understand the task, choose relevant evidence, inspect its limits, then act and check. The sequence is illustrative.](docs/images/jeito-system-hero.gif)

## Why these parts exist

| Extension (read more) | Why it is here |
| --- | --- |
| [codeweave-pi](extensions/codeweave-pi/README.md) | An unfamiliar repository can offer a convincing filename before it offers an owner. The agent can test that lead against relationships, written intent and current source; discovery cannot silently become permission to edit. |
| [tooltap](extensions/tooltap/README.md) | Carrying every possible capability from the start can crowd out the task before the agent knows what it needs. Extra capability can arrive when relevant without rewriting the earlier conversation; finding one does not grant permission to run it. |
| [shell](extensions/shell/README.md) | A slow command need not freeze unrelated work, and a huge log need not occupy the conversation. The agent can work elsewhere while it runs and return to a saved result; dependent work still waits for completion. |
| [websift](extensions/websift/README.md) | A short research reply can omit the condition that changes a conclusion. Retrieved source remains available beyond the initial excerpt, so a claim can be checked without loading entire pages into the conversation. The excerpt itself does not prove coverage. |
| [guidepin](extensions/guidepin/README.md) | As work stretches across turns, the latest plan can displace the reason the user asked for it. Reminders and a record of governing decisions keep that intent available for reassessment; neither creates a new task or overrides the user. |
| [draft-lift](extensions/draft-lift/README.md) | Clarifying a request in the working conversation can leave rejected versions behind as apparent instructions. The person can revise against prior context and inspect an unsent draft before deciding what the coding agent actually receives. |
| [fff search](extensions/fff-search/README.md) | Sometimes the person knows which file matters before the agent does. An indexed editor choice lets them put an explicit path in the request, leaving less to infer; it does not prove that this file is the right owner. |
| [stall-guard](extensions/stall-guard/README.md) | A tagged stalled connection can stop work even though the user never asked to stop. With a separate watchdog providing that tag, guarded continuation is possible after Pi settles, but not after newer activity or a deliberate abort. |
| [context diagnostics](extensions/context-diagnostics/README.md) (standalone) | When instructions seem to disappear, changing the agent's behavior may be the wrong fix. Opt-in capture shows what Pi assembled so a developer can check that premise; the sensitive snapshot does not show the final provider request. |

## Context for the next decision

The [working instructions](config/APPEND_SYSTEM.md) ask the agent to start with the user's outcome, separate observation from inference and look for evidence that could change its next action. Instructions alone cannot ensure that happens. The harness supports the discipline in what it returns: code and document leads are scoped and mark what was omitted; exact source can be read in small, chosen slices; complete current lines can carry a file hash into an edit. Unseen or changed lines cannot borrow authority from a promising search result. An exhaustive search that cannot fit fails as an audit instead of quietly becoming a shorter overview. This protects room in the conversation for the next relevant question without hiding when more evidence is needed.

Speed and context cost matter, but neither tells us whether a change is right. When ownership or consequences are unclear, another relationship, document section or source read can be worth the extra turn. A patch placed under the wrong owner becomes a misleading starting point for the next change. The aim is to spend attention where uncertainty could change the decision and avoid repeating evidence that is already sufficient. The agent still has to reason about what it finds; these boundaries do not establish that it chose well.

## Trying jeito

The public tree cannot prepare the full suite from a bare clone because codeweave-pi's production Core is absent. For a smaller experiment, the [installation guide](docs/getting-started.md#install-one-extension-from-a-checkout) explains how to prepare an eligible extension with npm before registering its local path with Pi. Do not register a separate copy beside the aggregate. Cloning does not apply the versioned instructions or host tool settings; [jeito-setup](.agents/skills/jeito-setup/SKILL.md) previews those changes before you choose them.
