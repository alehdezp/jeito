# codeweave-pi

An unfamiliar repository does not tell an agent which component owns a behavior. An error may lead to a test, a generated file or an API that only forwards the call. A precise patch in the first plausible place can leave the underlying contract wrong. codeweave-pi treats finding the owner and earning permission to change it as separate decisions.

I built it so the agent can assemble the context this task needs instead of carrying a dump of the repository. Prepared code relationships and project documents can reveal candidates the request did not name. Bounded results show what they cover and what they omit, so the agent can choose the next useful question. A candidate stays provisional until the agent returns to current source. The animation sketches that handoff; it is not a captured run.

![Animated codeweave-pi evidence handoff. A prepared relationship graph points to a candidate file, which is explicitly not edit authority. A live source read supplies complete displayed lines and a hash; the edit gate accepts seen current lines and refuses unsafe ones. The whole diagram remains legible when paused.](docs/images/codeweave-hero.gif)

## Find the boundary before narrowing the search

The [prepared code graph](native/analysis/README.md) makes symbols and their relationships available when the agent knows a behavior but not its name. It can follow a candidate into callers, imports and tests, or ask which written contract bears on the change. [Document retrieval](docs/evidence.md) leads to project sections that can then be checked against current Markdown. Optional cross-domain maps connect code and documentation when neither alone explains the boundary. A test or a call edge can reveal a relevant subsystem without proving ownership or runtime behavior.

Preparation happens outside the question. The results identify their generation, scope and omissions; a query does not silently rebuild an index or install missing assets. When the likely owner changes, so should the next inquiry. There is no mandatory walk from search to edit. The [navigation doctrine](docs/harness-doctrine.md) explains why a known filename is a useful clue, not proof that the investigation is contained.

## Give the agent enough evidence to decide what to inspect next

Whole files and exhaustive search dumps can fill the working context before the important exception appears. Code and document results use bounded pages, with a route back to the source and an indication when the answer is partial. When the question really is about *every* occurrence, an oversized audit [fails rather than quietly becoming a ranked overview](tests/v3-grep-cap-fallback.test.mjs). A first encounter with a document can include its authored title, description and references without repeating a long YAML header; [omitted references confer no authority](src/core/markdown-frontmatter.ts). These choices let the agent widen a weak lead or ask a sharper question. Shorter output is useful only while the evidence needed to challenge the first guess remains reachable.

## Make an edit answer to inspected source

A relationship or document may justify *where to look*. It cannot license a change to unseen bytes. A current [source read](src/tools/read.ts) displays numbered lines with a file hash. Complete verbatim lines already displayed by an eligible search or relationship result can also be [checked against live source](src/core/source-authority.ts) and passed into an edit without reading them twice. The hash and the recorded lines limit what the [edit engine](src/core/patch-apply.ts) may change. If another process changes the file, unchanged observed targets can sometimes be recovered; changed or ambiguous ones are refused. Outcomes are per file, so a later failure does not undo an earlier edit.

[Focused tests](tests/v3-live-source-authority.test.mjs) exercise the displayed-row handoff and refusal of unseen lines; [recovery tests](tests/v3-edit-recovery.test.mjs) cover ambiguous or changed targets. They establish those source boundaries, not that a model found the right owner or made a better change. The graph can be incomplete, written intent may be stale and a source hash cannot settle what the user meant. More investigation can be the responsible choice even when it takes another turn.

## Source and installation limits

This public tree omits prebuilt pi-nav executables and native modules, the locally adapted vendor tree, and the production Core payload with its pinned code model. **A bare clone cannot install the complete runtime.** A publisher-prepared checkout needs Pi, Node.js 22.19 or newer, npm, Git and matching assets; the Node floor alone does not prove native ABI compatibility. Installation verifies those assets, then provisions and exercises roughly 928 MiB of QMD models with first-install network and disk cost before registration. Startup does not compile or download them. Python 3.10–3.14 is needed only for optional Graphify; avoid registering this extension alongside another copy or the jeito aggregate.

[Setup](docs/setup.md) covers development and recovery; [current truth](docs/current-truth.md) separates source checks from loaded-runtime proof, and [third-party notices](THIRD_PARTY_NOTICES.md) cover bundled dependencies.
