---
title: "Decision: Graphify images are excluded from navigation graphs"
description: "Why codeweave-pi excludes image files before Graphify deep extraction, how generated exclusions converge without corrupting user corpus identity, and which residual failures remain hard errors."
tags: [jeito-codeweave-pi, decision, graphify, graph-lane, image-exclusion, corpus-policy]
created: 2026-08-04
updated: 2026-08-04
status: completed
decided: 2026-08-04
owns: "The settled rule that image files are outside codeweave-pi graph navigation and never sent to Graphify semantic extraction"
audience: contributor
code: [scripts/navigation-freshen.mjs, tests/v3-graphify-modality.test.mjs, tests/v3-navigation-freshen.test.mjs]
related: [docs/decisions/r5-crg-clean-break.md, docs/current-truth.md]
---

# Graphify images are excluded from navigation graphs

Status: **accepted and implemented.** Image semantics are outside codeweave-pi's navigation scope. Every future Graphify deep extraction receives generated image-extension exclusions, independent of provider capability.

## Context — image input poisoned unrelated semantic extraction

Graphify 0.9.23 batches code, documents, papers, and image files for deep semantic extraction. The tested opencode-go Console Go route rejected OpenAI-style `image_url` message parts during request deserialization:

```text
HTTP 400 invalid_request_error
messages[1]: unknown variant `image_url`, expected `text`
```

Because image and text files shared semantic chunks, one image rejected the whole chunk and discarded unrelated text extraction. The model was never invoked. Excluding images made both affected projects complete deep semantic extraction through the same route, proving that provider switching was unnecessary.

## Decision — discard images at the existing Graphify invocation seam

`scripts/navigation-freshen.mjs::graphifyExtractArgs` appends `GRAPHIFY_IMAGE_GLOB_EXCLUDES` to every deep-extract command. The list covers every image extension recognized by the pinned Graphify 0.9.23 release and is reviewed whenever `GRAPHIFY_PIN` changes. Image exclusions are deduplicated with ordinary corpus exclusions.

Successful graph freshen output includes `graph_image_semantics=excluded`; omission is deliberate and visible. Local AST update remains unchanged because it does not semantically process images.

No provider capability registry, multimodal retry framework, or fallback state machine is added. Those mechanisms would preserve a feature the product does not want.

## Generated image policy and existing graph convergence

Generated image exclusions are invocation policy, not user-authored corpus policy. `reconcileGraphifyCorpusPolicy` removes generated image patterns from both expected and persisted comparison values, preventing a user/global `**/*.png` entry from creating a permanent reconciliation mismatch.

This design deliberately avoids an automatic rebuild of every existing graph. Existing generations may retain old image-derived nodes until their next successful deep refresh; every future deep extraction excludes images and converges naturally. codeweave-pi does not promise an eager historical scrub.

## Failure boundary — residual modality rejection is an invariant failure

With the pinned Graphify image set synchronized, the original `image_url` rejection should be unreachable. If it appears after an upstream format change, freshen returns a structured error with `graphify_unsupported_modality=true` and `graph_image_exclusion_invariant_failed=true`, preserves the prior verified graph, and instructs the maintainer to update the exclusion list.

Freshen never publishes a partial semantic graph merely to make status green: a rejected mixed chunk loses text evidence as well as image evidence. Authentication, rate limits, I/O errors, malformed model output, and graph quality failures remain ordinary hard failures.

## Rejected alternatives

- **Provider/model capability registry:** unnecessary because images are excluded for every provider.
- **Retry or automatic AST fallback:** hides a broken image-exclusion invariant and can replace stronger last-good evidence with weaker output.
- **Global navigation-template image entries:** conflates generated Graphify policy with user corpus policy and would require unrelated project-wide migration.
- **Bundled Graphify patch:** violates the stock-plus-one-patch boundary in [`r5-crg-clean-break.md`](r5-crg-clean-break.md) for behavior owned cleanly at codeweave-pi's invocation seam.

## Code and verification

- Owning implementation: `scripts/navigation-freshen.mjs::graphifyExtractArgs`, `isGraphifyModalityRejection`, and `normalizedGraphifyPolicyExcludes`.
- Pin/format contract: `src/core/backend-registry.ts::GRAPHIFY_PIN` and `tests/v3-graphify-modality.test.mjs`.
- Integration proof: `tests/v3-navigation-freshen.test.mjs` verifies generated deep-extract arguments, configured-policy overlap convergence, and a structured residual modality failure rather than an escaping exception.
- Focused verification on 2026-08-04: 41/41 tests passed across `v3-graphify-modality`, `v3-navigation-freshen`, and `v3-navigation-ignore`.
