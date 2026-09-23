# codeweave-pi

codeweave-pi was built to make an agent's understanding of a repository less dependent on reconstructing the project from isolated matches. Plain text search is effective for exact terms; implementation decisions can also depend on callers, written contracts and recent changes that no single match explains. Sending entire files into the conversation increases coverage but spends context before the agent knows which connections matter. This extension keeps those forms of evidence available as separate, inspectable views. The intended payoff is a better-informed next question with less repeated reconstruction; agent time saved and patch quality have not been measured.

The tradeoff is useful reduction without false completeness. Ranked discovery can suggest where to look; an exhaustive search must account for every eligible occurrence. Prepared relationships and project writing may lag, so results expose scope and omissions and leave current source reachable. Spending another turn to reconcile conflicting evidence is a deliberate option when the missing contract could change the implementation. The agent is free to change the question; the harness does not impose a search-to-edit sequence.

![Animated codeweave-pi diagram: the question selects discovery, examination or exact checking; each view keeps scope and omissions visible and deeper source reachable. All labels remain visible when paused.](docs/images/codeweave-context.gif)

## Why the evidence stays open to challenge

I kept code relationships, written intent and actual changes distinct because they answer different engineering questions. Indexed relationships connect components but can lag and cannot establish runtime behavior. A project document describes intent that may have drifted from the implementation. Current source settles what a file says now; the agent still has to decide whether a change serves the user. A single ranking score would blur those limits just when they matter for the next action. The [navigation doctrine](docs/harness-doctrine.md) records that reasoning; the [evidence map](docs/evidence.md) separates implemented capabilities from their proof limits.

A bounded reply is useful only if the missing detail remains accessible. Pages and source references let the agent inspect more when a lead changes the question. An oversized exhaustive audit [fails rather than quietly becoming a ranked sample](tests/v3-grep-cap-fallback.test.mjs); otherwise a shorter answer could masquerade as complete coverage. The extra inquiry has a cost, but protecting the meaning of the question matters when omitted evidence could redirect the work.

## Why editing shares the evidence boundary

I chose to remove repeated reading after the agent has already inspected complete source for the proposed change. An identical read spends context without adding evidence; trusting an old or clipped excerpt creates a false safety claim. The [source-authority decision](docs/decisions/proof-preserving-mutation.md) joins navigation and editing around what the agent actually saw. If a file changes mid-task, safe independent parts of an edit can survive while unresolved targets return for review. An all-or-nothing edit would discard that work; permissive best-effort editing would risk changing bytes the agent did not inspect.

[Source-authority tests](tests/v3-live-source-authority.test.mjs) and [recovery tests](tests/v3-edit-recovery.test.mjs) exercise those narrower boundaries. They do not establish that an agent chose the right owner, understood the user's request or produced better code. The public tree also cannot prove that a prepared graph, a written contract and the current source always agree.

## Source and installation limits

This public tree omits prebuilt pi-nav executables and native modules, the locally adapted vendor tree, and the production Core payload with its pinned code model. **A bare clone cannot install the complete runtime.** A publisher-prepared checkout needs Pi, Node.js 22.19 or newer, npm, Git and matching assets; the Node floor alone does not prove native ABI compatibility. Installation verifies those assets, then provisions and exercises roughly 928 MiB of QMD models with first-install network and disk cost before registration. Startup does not compile or download them. Python 3.10–3.14 is needed only for optional Graphify; avoid registering this extension alongside another copy or the jeito aggregate.

[Setup](docs/setup.md) covers development and recovery; [current truth](docs/current-truth.md) separates source checks from loaded-runtime proof, and [third-party notices](THIRD_PARTY_NOTICES.md) cover bundled dependencies.
