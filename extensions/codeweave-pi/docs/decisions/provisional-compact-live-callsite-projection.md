---
title: "Provisional decision: compact live call-site projection grouped by file and owner"
description: "Records the founder-approved call-site rendering shape: one current file identity, one owner range and signature, all matching lines, adjacent alias evidence, and no duplicated source or line labels."
tags: [jeito-codeweave-pi, decision, grep, callers, source-authority, compact-rendering]
created: 2026-08-13
updated: 2026-08-13
status: active
decision_status: accepted
confidence: confirmed
evidence_grade: mixed
implementation_status: deferred
decision_owner: founder
owns: "Provisional model-facing projection of direct live call sites and import aliases"
audience: contributor
code: [src/tools/grep.ts, src/core/source-authority.ts, native/pi-nav/src/search/callers.rs]
related: [docs/decisions/README.md, docs/harness-doctrine.md, docs/current-truth.md]
---

# Provisional compact live call-site projection grouped by file and owner

## Decision

When codeweave-pi shows live callers for one resolved owner, group the evidence by canonical current file and print the file authority tag once. Within that file, group all matching sites by enclosing owner. Print each enclosing owner once as `[start-end]: signature`, followed by every matching call line as `>line: source`. Do not repeat the function name, range, signature-line number, file path, or unchanged source merely to satisfy a section template.

```text
[apps/api/src/routes.ts#A21617AE]
[5-9]: export function handleManifest(raw: string) {
>8:   return loadManifest(raw);
```

For a long owner, name an omission only when undisplayed lines separate displayed source rows:

```text
[apps/api/src/routes.ts#A21617AE]
[5-32]: export function handleManifest(raw: string) {
… 22 lines omitted
>28:   return loadManifest(raw);
```

If one function calls the target several times, keep one `[start-end]: signature` row and print every matching line beneath it. If one file contains several caller functions, keep one file tag and print each owner block beneath it.

## Alias evidence stays adjacent and edit-ready

An alias or re-export line appears once under the same file tag when it explains why the displayed local call reaches the target. Ordinary imports that add no understanding remain omitted.

```text
[packages/worker/src/worker.ts#C298ED2A]
1: import { loadManifest as readManifest } from "../../config/src/manifest";
[3-5]: export function startWorker(raw: string) {
>4:   return readManifest(raw);
[10-15]: function testWorker(raw: string) {
>13:   return readManifest(raw);
```

The file tag and displayed current rows are source authority. The owner range is also an exact read target, but omitted lines are not edit authority merely because their range is named. An implementation must preserve this distinction instead of making compact presentation silently authorize unseen bytes.

## Context and decisive trade-off

The earlier candidate repeated the file path, owner name, owner range, signature line number, and call-site line in separate labels. That repetition spent tokens without adding evidence and made a logically unified source projection look like several unrelated facts. The opposite extreme—printing only `file:line`—would lose enclosing-owner identity, full-range navigation, alias explanation, and current edit-ready source.

The selected shape compresses repeated representation, not evidence. Its unit is a current source carrier grouped by file and owner, not a provider section or one output row per backend fact.

## Consequences and implementation obligations

- Group by canonical file identity first, then enclosing owner identity; preserve deterministic source order within each group.
- Print one authority tag per current file and never duplicate an unchanged source row inside the same result.
- Keep every relevant matching line for the displayed owner; compactness must not silently select one occurrence.
- Show aliases or re-exports beside the affected call, not in a detached Imports section.
- Keep relationship meaning explicit in the surrounding heading or owner block without repeating it on every line.
- Preserve category completeness, omitted counts, unavailable states, and current-versus-stored disagreement outside the source projection.
- The projection may later merge into a richer lifecycle or graph tree when that is more intuitive. Any replacement must retain the approved richness: current file identity, enclosing owner range and signature, every relevant call line, alias explanation, live/edit-ready rows, and no duplicated source.

## Alternatives worth remembering

- **Whole caller bodies:** rejected as the default because unrelated lines overwhelm direct evidence; the full range remains a precise read target.
- **One standalone row per call:** rejected because it repeats file and owner context and fragments multiple sites in one function.
- **Bare `file:line` pointers:** rejected because they remove enclosing-owner context, alias resolution, and immediate edit-ready source.
- **Detached import sections:** rejected because the import matters only where it explains a relationship.
- **Provider-shaped sections:** rejected when they repeat the same source or relationship under pi-nav, CRG, or LSP headings.

## Revisit conditions

This is a provisional accepted direction, not an implemented contract. Revisit the placement or grouping when the complete symbol card and exact graph-route representation are designed. Revisit the source form only if a real output proves that another projection is more intuitive while retaining every approved evidence property above. Do not reopen it merely to restore provider-oriented sections or arbitrary compactness.

## Implementation and authorization status

No renderer, provider, schema, public tool, or compatibility change is authorized by this record. The founder approved the provisional rendering direction; production implementation remains deferred behind the provider-fusion investigation and a later explicit implementation decision.
