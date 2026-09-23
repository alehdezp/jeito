# jeito

A coding agent can make a precise patch to the wrong part of a system. A request names an outcome; the repository gives the agent only fragments of how the system works. The first plausible explanation may be incomplete. If the agent acts on it as though it were certain, the edit can be locally correct and still miss what the user needed.

jeito is the [Pi coding agent](https://pi.dev/) harness I built around that gap. It begins with what the request actually requires, then helps the agent seek evidence that could confirm or change its understanding. When the owner is unclear, investigation can range across the repository. Before changing code, the agent must return to current source it has actually seen. The design keeps a promising lead separate from a justified change, with the remaining uncertainty visible.

This is a source-only work in progress that I use in my own setup, not a supported release. The public tree omits prebuilt native components and codeweave-pi's production Core payload; a clean-machine full-suite install has not been proven. [Documentation](docs/README.md) · [Installation notes](docs/getting-started.md) · [Distribution gaps](docs/publication-readiness.md).

![Animated jeito diagram: understand the task, choose relevant evidence, inspect its limits, then act and check. The sequence is illustrative.](docs/images/jeito-system-hero.gif)
