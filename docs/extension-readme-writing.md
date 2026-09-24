---
title: "Write Pi extension READMEs"
description: "A source-grounded authoring procedure, rejection catalogue and review method for explaining an extension's contribution without producing a feature inventory or agent operating manual."
tags: [readme, documentation, authoring, editorial-review, visual-design, pi-extensions]
created: 2026-09-20
updated: "2026-09-24 08Z"
status: under-review
owns: "Extension README explanation, editorial selection, visual admission and acceptance procedure"
audience: contributor
related: [docs/README.md, AGENTS.md, docs/tool-guidance-architecture.md]
---

# Write Pi extension READMEs

Use this procedure when writing or rebuilding a Pi extension README. The reader is evaluating what the extension can do for agent work and may know neither Pi nor the implementation. The first 10–15 seconds should make the problem, useful change and reason to consider the extension understandable. Further reading explains the engineering choices and adoption requirements. Technical reasoning does not require jargon or prior source-code knowledge.

The procedure governs authoring and review, not the README's headings or length. Its rejection catalogue belongs in the writer's review process. A finished page should follow the explanation its subject needs.

The task's approved scope and [repository contributor rules](../AGENTS.md) govern edits. A documentation task does not authorize runtime repairs, installations, host changes, new product behavior or invented performance claims. [Tool guidance](tool-guidance-architecture.md) owns instructions delivered to the agent; a README introduces the project to people.

## Establish the contribution from project evidence

Read the package entrypoints, current contracts, relevant implementation, design decisions and available behavior evidence. Trace a claimed capability to its public registration or consumer before describing it as something the extension supplies. Code existing inside a package does not establish that users or agents can invoke it.

Use existing investigation where it still applies. Recheck evidence when source changes could alter the claim. A design record can establish a reason; source can establish implementation; execution can establish exercised behavior. If these disagree, resolve or disclose the disagreement before choosing wording. An old document marked active can still contain superseded details.

Keep an evidence note for consequential claims whose support is spread across owners. Record exact paths and symbols, the scope of any executed check, and unresolved questions. Do not publish that investigation as the README's main explanation.

Before discarding the previous presentation, identify installation requirements, attribution, licenses, privacy warnings and material behavior limits that must survive. Preserve their meaning, not necessarily their placement. Inspect setup commands as a sequence: a comment saying to continue only after success is insufficient if a pasted command block continues after a failed preparation step.

Form a short internal account of the contribution:

- What useful action, control or understanding does this extension provide?
- What difficulty or repeated work does its design address, and why does that matter?
- Which choices connect the capabilities into a useful solution?
- What does this integration contribute beyond Pi and its dependencies?
- What remains with the person using the harness, including configuration, waiting, review, storage, money or maintenance?

Answer from evidence and reasoning about the actual design. Do not infer historical motivation from code. If the purpose remains unclear after investigation, ask a focused question about the missing intent. Do not replace uncertainty with a generic story about complexity or context.

Compare with the relevant baseline while developing this account. A useful integration need not introduce a capability absent from Pi or invent a new underlying algorithm. Distinguish usefulness, design judgment and originality; do not make novelty a prerequisite for explaining value.

## Select the material before drafting

Choose the main explanation and the supporting ideas required to understand it. Several connected design choices may deserve substantial treatment. A narrow extension may need much less. Judge depth by the reasoning the reader needs, not by parity across packages or a word quota.

Assign the remaining material a purpose: supporting explanation, material boundary, setup, attribution, or linked reference. Remove detail that serves none of these. Internal research questions are not a list of required public sections.

Include a comparison when it makes a choice intelligible. Keep inspected versions in the evidence note unless compatibility or a version-dependent statement makes them important to the reader. A baseline capability inventory is rarely a useful introduction.

Give implementation detail space when it explains a consequence. Exact limits, algorithm names and configuration fields belong in the README only when they materially affect understanding, adoption or safe use. Otherwise link the owner of that detail.

Identify the nearest plausible wrong explanations before drafting. For example, a research integration might be reduced to a page cache; an editor finder might be misrepresented as the agent's code-search engine. A useful rejection names both the missing distinction and the evidence that resolves it. Do not invent weak alternatives merely to make the preferred account look good.

## Compose an explanation for the reader

Open directly with the extension's identity and useful behavior. Develop the reason the design matters as the reader encounters its important choices. Keep mechanisms close to their practical consequences: what can continue, what becomes inspectable, what no longer has to be reconstructed, or what the person can decide differently. Select the relationship supported by this project rather than borrowing one from another extension.

Use plain English while retaining technical distinctions that carry the argument. Explain an unfamiliar term where it becomes necessary. Avoid narrative run-ups, imagined user predicaments, slogans without information, and lists of benefits detached from how the extension works.

Describe agent behavior to the human reader. Keep exact controls where they help someone evaluate or begin using the extension, but route parameter catalogues and ordinary operating sequences to their proper references. No tools/hooks/skills inventory or complete worked workflow is required.

Judge a section by the question it answers. “Why preserve distinct search methods?” calls for a design explanation; “Which parameters should the agent try next?” calls for operating guidance. Move operating detail to its owner instead of rephrasing it. Voice is not a section-level choice: project voice applies to every section without exception.

Use a brief grounded illustration when it clarifies a consequence or dependency. Label illustrative timing or conceptual behavior. An example must not imply a measured gain, automatic continuation, lossless capture, durability or correctness that the evidence does not establish.

State supported consequences directly. Distinguish a capability, an intended benefit and a measured outcome. Keep a condition beside the promise it changes; put other necessary operational limits where the reader makes the relevant choice. Do not introduce speculative benefits just to append disclaimers about them.

Credit the underlying engine or service accurately and explain the integration's contribution. Preserve required legal notices. Attribution should not turn into either an ownership overclaim or an apology for building on existing work.

Use an editorial reference to understand how its prose connects ideas. Verify its technical claims separately. Do not copy its headings, paragraph lengths or diagram subjects mechanically. When a rewrite is authorized, compose from the contribution brief rather than patching rejected paragraphs into another arrangement.

## Write in project voice

The reader is meeting a project, not its author. Public pages use project voice throughout: the first person never appears — no "I", "we", "my" or "our" — in prose, headings, tables or captions. State what the project does, chooses, guarantees and refuses.

Present the work as an opinionated design. Name the position it defends about how agent work should be done, including where it improves on the conventional agent-harness default. That positioning is a design claim, so state it as one: "an edit is authorized only by current source the agent has inspected". Never convert it into a measured comparison, a named-competitor claim or a promised outcome: "jeito patches more safely than other tools" is unsupported. The page earns its impression from the precision of its positions and the honesty of its limits; adjectives do no work here.

Do not tell a problem-and-cure story. A generic or invented failure scenario followed by the extension as its resolution is banned in every entry, even abstractly and even when the facts are accurate. The design position leads; the difficulty it addresses appears as the reason for that position, at most a clause, with no scene and no chronology.

Do not paraphrase behavior. Prose that narrates implementation logic in sequence is pseudocode with the code removed. "Complete source lines displayed during investigation can be reused after a current-file check" is narration; "an edit is authorized only by current source the agent has inspected" is a guarantee. READMEs state guarantees and consequences.

Do not invent terminology. Use established names and plain phrases. `config/APPEND_SYSTEM.md` is the versioned system prompt, not "the working instructions". If a project coinage is unavoidable, define it in the sentence that introduces it.

Before drafting, write the extension's idea in one sentence: the position it defends about how agent work should be done. The page exists to make that idea understood and credible; every section either supports it or serves setup, safety or attribution.

## Design the jeito header and explanatory figures

Choose the number of visuals according to what helps the reader understand the extension. There is no quota or fixed cap: one, two, three, four or no visuals may be appropriate. A header, when used, bears the extension's name and has a recognizable relationship to its subject. Branding is a valid purpose, but a generic symbol and a title do not by themselves establish a coherent identity.

Keep a coherent family identity through typography, palette, spacing, proportions and hierarchy. Allow a distinctive mark, restrained illustration or compositional variation where it fits the extension. Consistency should not require identical artwork.

Group related decisions when seeing them together makes the logic easier to understand. A diagram, workflow, graph, table or verified interface view may explain several connected mechanisms or choices. Choose the form for that relationship; do not enlarge one isolated fact merely to fill an image slot. Omit a visual that does not improve understanding.

Before drawing an explanatory figure, identify:

- the reader's question it will answer;
- the supported relationship or consequence it will make visible;
- the conditions that must remain visible to avoid a false promise;
- where it belongs in the explanation.

For a causal comparison, keep unrelated conditions constant so the visual does not attribute a gain to the wrong cause. Do not turn every figure into a comparison or force unrelated extensions into the same composition. Headers, timelines, interface views and source relationships have different jobs.

Size the header to GitHub's available README content width instead of an arbitrarily narrower canvas; that width changes with the page layout and viewport. Inspect explanatory assets at their actual reading size, including narrow widths, zoom and light/dark backgrounds. Repair small labels, weak contrast, clipping and ambiguous connections. Supply useful alternative text and an accessible text explanation; do not encode an important distinction only through color. XML validity, contrast checks and a successful screenshot cannot establish comprehension or accessibility. Animation is optional and must preserve an understandable static representation.

## Reject failures of understanding and scope

Use these cases when the draft's framing or audience is uncertain. The correction must change the explanation, not merely its tone.

| ID | Failure signal and why it fails | Correction and review signal |
| --- | --- | --- |
| U1 | A generic introduction about complexity, context or efficiency could introduce almost any extension. | Name the concrete restriction, repeated work or missing control. The explanation should reveal a project-specific choice. |
| U2 | A stock-Pi audit or gratuitous version comparison publishes research notes instead of explaining the solution. | Keep only the contrast that clarifies a design choice. Retain exact versions where compatibility or a scoped factual claim requires them. |
| U3 | A missing host capability is invented to justify the package. | Verify the baseline and explain the actual enhancement or alternative. This does not require a comparative paragraph in the README. |
| U4 | “Choose this if you want this” assumes the value the page should explain. | Explain what the capability offers and when it matters without requiring prior enthusiasm for its name or dependency. |
| U5 | One convenient mechanism stands in for a broader product, or a modest integration acquires an inflated mission. | Check the explanation against the public surface and accepted purpose. Its breadth should account for the contribution without manufacturing importance. |
| U6 | Source structure or an internal method is mistaken for a delivered capability. | Verify registration and consumers. The README must describe the interface the person or agent actually receives. |
| U7 | The page teaches the agent's next tool call, parameter choices or recovery sequence. | Explain the design and available choices to the person evaluating it; move operating detail to its owner. |
| U8 | A generic problem-and-cure story presents the extension as the resolution of an invented failure. | Lead with the design position; the difficulty appears only as its reason. The passage must survive deletion of the scene. |
| U9 | Prose narrates implementation logic in sequence and calls it explanation. | Replace the walkthrough with the guarantee and its consequence; move the sequence to an operating reference. |
| U10 | A coined term carries the explanation, such as "the working instructions". | Use the established or plain name; define an unavoidable coinage at first use. |

## Reject failures of composition and evidence

Use these cases while selecting and revising prose. Correct facts can still form an unhelpful document.

| ID | Failure signal and why it fails | Correction and review signal |
| --- | --- | --- |
| C1 | Every feature receives equal attention, obscuring the ideas that connect the project. | Establish a hierarchy. A section must explain a meaningful part of the argument or serve a clear setup/reference purpose. |
| C2 | An implementation walkthrough replaces the reason for the design. | Connect the important choice to a practical consequence. Knowing execution order alone is insufficient. |
| C3 | Simplification removes the technical distinction that makes the approach useful. | Restore the necessary distinction in plain language. A reader should be able to explain why it matters. |
| C4 | Capabilities or intentions become claims of speed, accuracy, savings or superiority. | Limit the claim to its evidence. State enabled behavior without converting it into a measured outcome. |
| C5 | Development history or founder motivation is inferred from code. | Use a recorded decision or explain present consequences without a historical story. |
| C6 | The integration takes credit for its dependency's engine or provider capability. | Identify the actual ownership boundary and the integration's choices, with required attribution intact. |
| C7 | Repeated disclaimers answer objections the page never raised. | Keep qualifications that materially change a promise; consolidate other necessary limits. Do not remove privacy, cost or safety information as stylistic cleanup. |
| C8 | An illustrative example appears to prove a gain or guarantee. | Label what is illustrative and retain conditions. A conceptual timeline does not establish faster task completion. |
| C9 | A good reference's headings, length or rhetorical pattern become a compulsory template. | Compose around this extension's explanatory dependencies. Related pages may share an identity without sharing an outline. |
| C10 | Successive wording changes preserve a misunderstanding of the contribution. | Return to the contribution brief, revise the interpretation and rebuild affected sections. Another synonym pass is not recovery. |
| C11 | A fluent external review is treated as independent technical evidence. | Separate its editorial observations from implementation claims. Verify behavior and inspect assets the reviewer could not access. |
| C12 | The author enters the page: "I built", "we chose", "my setup". | Project voice everywhere; the person never appears. |
| C13 | Opinionated positioning slides into measured or named-competitor superiority. | Keep it a design claim with its intended consequence; drop measured promises and competitor names. |

## Reject failures of visual explanation and delivery

Use these cases before admitting an asset or calling a document complete.

| ID | Failure signal and why it fails | Correction and review signal |
| --- | --- | --- |
| V1 | A feature list is drawn as boxes without clarifying a useful relationship. | Choose a consequence, interface or relationship worth seeing. The figure should improve understanding beyond identifying its parts. |
| V2 | A weak visual subject is approved because its colors and styling match. | Review subject and composition before polish. Family coherence and explanatory value are separate checks. |
| V3 | An asset works at desktop size but becomes tiny, crowded or low-contrast in its actual placement. | Inspect narrow and light/dark renders. XML validity and a successful screenshot do not establish legibility. |
| D1 | Setup, credit or essential warnings disappear during restructuring. | Reconcile the preserved requirements against the draft and linked owners. Check that copied commands obey their stated preconditions. |
| D2 | Passing links, tests or rendering checks is presented as proof of good writing. | Review understanding separately. A technically sound feature inventory can still fail the task. |
| D3 | A draft is called successful because the author followed the procedure. | Present the explanation and consequential choices for review. The reader's understanding, not a compliance receipt, decides editorial acceptance. |

## Review meaning, facts and presentation separately

Read the draft without consulting its source notes. Can someone explain what the extension changes, why its main choices help, what adopting it involves, and when a simpler approach is enough? The page need not answer these as separate sections. If it only enables someone to repeat features, reconsider the explanation before polishing.

Check the claims against the evidence note and current owners. Use focused execution when a behavioral claim requires it and execution is authorized. Link or syntax checks cannot establish runtime behavior. A README task does not require a new benchmark or a broad test run just to justify an ordinary design decision.

Check local links, intended heading structure, code fences, setup sequencing, attribution and material warnings. Inspect actual visual renders. Report unavailable checks rather than repairing dependencies or host state outside the task's authority.

Apply humanizer guidance after the argument works. Remove staged openings, repetitive closers, inflated language and mechanical formatting without dropping meaningful distinctions. A forbidden-word list is not an editorial method; review what the sentence contributes.

If feedback changes the underlying interpretation, return to the contribution brief. If it identifies a local ambiguity, repair that passage and recheck affected claims. Do not reopen settled choices without new evidence or user direction, and do not preserve a failed structure merely because assets have already been drawn for it.

## Calibrate the procedure on contrasting extensions

Use a broad integration and a narrow enhancement when checking whether these rules generalize. Review the proposed explanations and their nearest wrong interpretations before producing a full pilot. Keep dated source snapshots and assessment notes in `.tmp/`; this guide owns the method, not a second copy of extension behavior.

For websift, a candidate explanation must account for differentiated retrieval and source inspection together. A page-cache thesis is too narrow; a provider catalogue does not explain their relationship. Capabilities and design choices lead, with research skills as a less important supporting contribution. The [provider/method decision](../extensions/websift/docs/adr/0001-product-and-evidence/0003-core-search-and-provider-specialists.md#alternatives-and-decisive-trade-off) records why these distinctions matter; `registerWebSearchSpecialists` in [the current registration source](../extensions/websift/src/tools/web-search-specialists.ts) establishes the public controls.

For FFF Search, a candidate explanation must make the bounded editor integration intelligible without inventing a fuzzy-search gap or implying that it replaces the agent's search tools. `fffSearchExtension` in [the registration source](../extensions/fff-search/index.ts) establishes the delivered surface; `FffAtAutocompleteProvider` in [the editor source](../extensions/fff-search/src/editor.ts) connects the finder to the person's file-selection action. An optional integration can be useful without being a novel engine or a demonstrated performance improvement.

Check valid exceptions as well as bad drafts: a useful ordinary capability need not be unique; a named header need not explain a mechanism; a necessary warning is not defensive clutter. Include an incomplete-evidence case and a source/documentation conflict. State expected decisions before assessing the guide, then record whether its wording actually distinguishes the cases. Do not convert a self-review into an independent evaluation or a quantitative quality score.

## Deliver and maintain the result

Return the readable artifact, the material editorial choices and their reasons, checks performed and their limits, and unresolved questions that could change the explanation. Honor any user review gate before editing additional READMEs or producing assets.

Inspect scoped diffs and preserve unrelated work. When commits are authorized, stage only the intended changes and inspect the staged patch; a dirty documentation index may contain work that does not belong in the commit.

Revise this procedure when a real calibration or reader response exposes a missing decision or an overbroad rule. Keep one owner for the rule, add a representative case when useful, and remove the superseded instruction. Do not grow the catalogue merely to accumulate more ways of saying that writing can be bad.
