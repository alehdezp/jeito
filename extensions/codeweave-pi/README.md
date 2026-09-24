# codeweave-pi

**codeweave-pi is jeito's core: the evidence engine that lets a coding agent understand an unfamiliar repository the way one is verified — and change it without guessing.** Understanding here is evidence acquisition. Every result arrives in an evidence class — a relationship lead, an exhaustive audit, a written contract, current source — and keeps the authority of that class. A call graph can suggest the owner but cannot prove runtime behavior; current bytes settle a file but cannot decide intent. The engine never averages those limits into one score, because the difference between them is exactly what a consequential change turns on.

Embedding search answers which text resembles the question. A whole-file read answers what these bytes say. grep answers where a string occurs. Repository decisions turn on who owns a behavior, what the project promised in writing, what still agrees with the code, and what can safely change. codeweave-pi is built to answer those with verifiable evidence at the depth the decision needs: context is spent where it retires uncertainty, and the unit of progress is trustworthy uncertainty retired.

The design stands on five prior arts: QMD's document retrieval, Tilth's native file tooling, Semble, code-review-graph's relationship-first review graphs, and CodeGraph's maintained call graphs. Each carries one lesson into this engine — sections beat chunks, live structure beats cached text, relationships beat proximity, a maintained graph beats a re-parsed guess — and the fusion of those lessons under one authority model is the idea this package exists to deliver.

![Animated codeweave-pi diagram: the question selects discovery, examination or exact checking; each view keeps scope and omissions visible and deeper source reachable. All labels remain visible when paused.](docs/images/codeweave-context.gif)

## The trade-off behind each call

Every call buys one thing: uncertainty retired in a named class. The surface is eleven tools on purpose, each owning one evidence reality and one claim boundary.

| Question that must settle | Capability | What the answer may claim |
| --- | --- | --- |
| Who owns or implements this behavior? | ranked `grep`, `explore` | ranked candidates with their supporting evidence |
| What connects to what? | `trace`, `explore` map | typed structural edges — never runtime flow |
| What did the project promise in writing? | `docs_search` | sections with hierarchy, relationships and freshness |
| What do the bytes say now? | `read`, `find`, `ls` | current rows, ranges and directory truth |
| What changed? | `diff` | current patch, with graph planning labeled apart from exact change |
| What may safely change? | `edit`, `write` | only inspected current rows, under a whole-file hash |
| Did the change break anything? | `lsp_validate` | scoped diagnostics, explicitly unconfirmed when unconfirmed |

Two rules govern the trade-off. Discovery power wins ties; cost breaks them only when information value is equal. And known identity does not waive discovery — a familiar name still earns its owner, its callers and its tests before containment is assumed. Queries never install, index or repair: preparation lives outside the turn, so a call cannot quietly mutate the project it is studying.

## Ranked grep: one call returns the connected answer

![Mechanism diagram: one question becomes behavior-ranked declaration cards whose caller, use and documentation edges arrive in the same bounded reply, with documentation labeled as a source-verified lead and a cursor retaining the investigation identity.](docs/images/ranked-grep-connected.svg)

The deepest single call in the suite assembles behavior-ranked declarations — or a precise card for an exact symbol — together with the relationships around them: callers, callees, uses, implementations and documentation, as one connected answer rather than five parallel searches. Scoping `paths` constrains where the target may live; it never forbids the same-project connections that explain it.

The `auto` lane reads the shape of the question: ranked questions and lowercase concepts go to behavior discovery, a clean name goes to exact symbol inspection, and explicit syntax always wins. The result reports which lane actually ran. A literal search that found nothing while its pattern contains regex-looking tokens returns one precise invitation to declare `syntax:'regex'` — an executed zero is evidence, and repeating it unchanged is never the recovery.

Documentation evidence states exactly what was checked. A source-verified authored association means the code link is real and the prose is not certified; a source-verified document lead means the page is real and its code association is unverified. Both stay labeled in the result, so prose can guide the next question without impersonating proof.

The whole reply respects one ceiling. When the connected answer exceeds it, what returns is a cursor pinning the query, focus, scope and source versions — continuation replays that identity and refuses changed or expired inputs. A large caller set arrives as retained, ranked evidence with its omissions stated, not as a truncated wall. The exhaustive lane is separate and stricter: `output:'matches'` accounts for every eligible occurrence or [fails rather than degrade into a ranked sample](tests/v3-grep-cap-fallback.test.mjs). Zero, partial and complete always read differently — partial coverage never licenses a "not found" claim.

## Documents keep their place in the tree

![Mechanism diagram: loose chunks lose their address and offer only a similarity score, while a retrieved section arrives with its folder and heading path, validated code and related links, and a freshness chip from reconciliation with the current tree.](docs/images/document-hierarchy.svg)

Retrieval returns sections, not chunks. A document lead carries its address: the folder it lives in, its heading path, its authored title and description, and its `code:` and `related:` links — validated on first exposure and reported as valid, invalid, ambiguous or unverified. Similarity without an address cannot answer "where does this promise live, and who else depends on it."

Freshness is structural rather than hoped for. The index reconciles against current Markdown identity and source hashes: changed sections are re-embedded, stale sections are pruned instead of ranked, and a current implementation outranks a plan that promised otherwise. Answer-bearing passages are classified apart from weak leads, so a suggestive paragraph refines the next query instead of closing the claim.

Provider choice is a trade-off, stated as one. Local inference — a 318 MiB embedding model and a 610 MiB reranker, 928 MiB measured in cache — is credential-free and private. ZeroEntropy and Voyage cloud modes send only section and query text for inference, never a managed corpus. Lexical FTS5/BM25 search needs no model at all and remains ready when everything else degrades. `auto` prefers an allowed configured cloud provider and falls back to local inference; hybrid claims readiness only at zero pending embeddings, and every degraded mode says so.

## Edits answer to inspected bytes

The common harness edit form re-quotes old lines and replaces them wholesale: it spends tokens re-typing provenance it cannot verify, and one stale line discards the whole patch. codeweave-pi's edit names targets and their replacement under a whole-file hash. Complete verbatim rows already displayed by any capability can become edit authority after byte certification, so the redundant re-read is what disappears — never the proof. Two identities are kept and never averaged: the file's exact bytes, and the normalized snapshot hash whose eight hex anchors address every edit.

The engine then [salvages every provably-safe part of authored intent](docs/decisions/proof-preserving-mutation.md). Safe target islands land, atomically per physical file; unsafe or ambiguous islands return as exact residual work for a cheap ordinary retry. A byte-identical target is a skip, not a failure, and a later file failure never rolls back an earlier file that already landed. A hash never authorizes unseen lines — changed or historically unseen targets are refused or recovered only when the observed target still matches. Syntax diagnostics and explicitly scoped LSP feedback follow the landing automatically. The engine's own closure benchmark is [recorded with its scope](docs/decisions/proof-preserving-mutation.md#code-and-verification): single-digit millisecond p95 on ten-thousand-line files.

## Reads that know where they are

A read is an address, not a dump. Line ranges, `::symbol` targets, `#section` selectors and `:raw` files can be mixed in one call of up to eight chunks, and every file header keeps its own range. Outlines, metadata and highlights never count as source; only complete verbatim rows under the file hash can authorize anything. Whatever a search or relationship result already displayed can be certified in place — the same rows, the same authority, no second copy in the conversation.

## Stays current without touching the query

Intelligence that decays is worse than none. Corpus admission is policy-driven — layered `[global]`, `[code]` and `[docs]` rules in `navigation-ignore`, project over machine, last match winning — and the admitted census is what the graph is allowed to know. Maintenance is incremental: an edit re-projects the changed file, not the repository. Watches coalesce, turn checkpoints reconcile, and every retained cursor is invalidated the moment its source versions drift. Queries stay pure throughout: no installs, no index builds, no silent repairs, no embedding of repository nodes mid-question.

## Setup and configuration

Prerequisites: Pi 0.82.1+, Node.js 22.19+ (22.x or 24 — Node 23 lacks the built-in SQLite APIs), npm, Git, and a publisher-prepared package carrying the production Core payload and its pinned code model. First install needs network access.

```bash
cd /absolute/path/to/jeito
npm install --omit=dev --workspace @alehdezp/codeweave-pi --include-workspace-root=false
npm run install:codeweave-pi
```

Installation verifies the Core payload before registration. Document-index models are a separate, explicit step — `npm run qmd:model-provision -- --accept-model-terms` acquires the two pinned GGUF files (928 MiB measured in cache) and nothing else; queries never download. `auto` provider preference is ZeroEntropy, then Voyage, then local inference, with lexical always available; `/navigation-setup` verifies the installed path read-only and never installs. The optional cross-domain graph lane (Graphify) needs Python 3.10–3.14 and is provisioned separately, stopped-Pi. Corpus scope is configured through `~/.pi/agent/navigation-ignore` and `<project>/.pi/navigation/ignore`. [Setup](docs/setup.md) owns the full path, repair tree and provider selection; [current truth](docs/current-truth.md) separates source checks from loaded-runtime proof.

## Boundaries

This public tree omits prebuilt pi-nav executables, native modules, the locally adapted vendor tree, and the production Core payload with its pinned code model. **A bare clone cannot install the complete runtime.** Prebuilt native targets are darwin-arm64 and linux-arm64; the Node floor alone does not prove native ABI compatibility. Graph edges are leads, not runtime proof. Structured retrieval can be stale or partial and says so. Focused tests establish source-authority, retrieval and edit contracts — improved agent outcomes, speed and patch quality are not measured claims.

## Provenance

The engine keeps its lineage visible: QMD's document retrieval, Tilth's native file tooling, Semble, code-review-graph's relationship-first review graphs, and [CodeGraph](https://github.com/colbymchenry/codegraph)'s maintained call graph, from which the maintained analysis core is an owned derivation. The code encoder is upstream `minishlab/potion-code-16M-v2` (MIT). The earlier code-review-graph runtime is retired; the relationship-first lessons remain in owned code. [Third-party notices](THIRD_PARTY_NOTICES.md) cover bundled dependencies, grammars and model terms; first-party code is [MIT licensed](LICENSE).