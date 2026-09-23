---
title: "Harness tool ergonomics proposal — docs_search, read, grep"
description: "Honest, deprioritized proposal for future docs_search, read, and grep ergonomics: what was overstated, what remains, and the cheapest correct implementation for each."
tags: [jeito-codeweave-pi, ergonomics, docs-search, read, grep, proposal]
created: 2026-08-21
updated: 2026-08-21
status: draft
owns: "Whether docs_search, read, and grep ergonomics change and how"
audience: contributor
related: [../tool-operating-reference.md, ../harness-doctrine.md, ../evidence.md]
---

# Harness tool ergonomics proposal — docs_search, read, grep

> Status: **draft proposal, not current behavior.** Captures honest reassessment after tool-harness evaluation. Most items are P3 or withdrawn; one docs_search item is P2. Do not implement speculatively.

## Summary: what the first evaluation overstated

Initial evaluation correctly identified that all three tools are structurally sound. It overstated three frictions:

* `read` selector reconstruction is **minor friction** (copy-paste, ~10s), not a blocker.
* `grep contextLines` default-to-2 would **break deterministic audits**; default 0 is correct.
* `grep ranked` already accepts one file/directory scope; the gap is only multi-file ranked, which is rare and has workarounds.

This proposal keeps only the friction that survives blunt reassessment and names the cheapest correct implementation for each.

---

## `read`

### 1. Inline `search` filter inside a read — would it conflict? Is it important? How to implement?

**Blunt answer:** Not important now. Good idea only at P3. Would not conflict.

* **Conflict:** None. The existing `read` contract resolves `path` → file bytes → `source-selector` intervals → authority + tag. A `filter` is a pure post-filter on already-resolved lines, before budget truncation and rendering. It does not touch selector parsing, batch grouping, or hash computation.
* **Why low priority:** `grep(matches)` already does cross-file search. Inline read filter only saves one tool call when you already loaded a large Markdown section and want to narrow it without leaving the file. That pattern occurs maybe 5% of reads.
* **Correct backend if ever built:**
  ```ts
  // read.ts params: add optional filter?: string  (regex, not new inline syntax)
  // read-renderer.ts: after resolveSourceSelector() and seenLines computed:
  // if (filter) { lines = lines.filter(l => regex.test(l.text)); recompute intervals/seenLines; }
  // Tag stays on original bytes (editing still works); rendered body is filtered view.
  // Do NOT invent `:search/foo` selector syntax — it collides with `:range` parsing in
  // source-selector.ts and adds parser complexity for no gain.
  ```
  Keep `filter` as a separate param so `path`/`paths`/`filter` compose orthogonally. Apply after authority, before `EXPLICIT_SELECTOR_OUTPUT_BUDGET` truncation, and report `filtered: N/M` in `BatchReadFileDetail`.

**Decision:** Do not implement now. Revisit only if large-section reads with internal search exceed ~20% of reads in telemetry.

### 2. Batch dedup

Withdrawn per your "do not care." No proposal.

### 3. `docs_search` → `read` round-trip — instruction example is enough

**Blunt correction:** Not hard. I overstated. No per-call noise needed — a single example in the instructions fixes it, *provided the selector is already in the right shape*. It is.

**Verification that the selector is already correct:**

* `docs_search` builds `read_selector` at `src/tools/docs-search.ts:193-216` from `src/core/qmd-docs-search.ts:354` as `${docPath}:${selector}` for headed sections or `${docPath}:${startLine}-${endLine}` for preamble. Example rendered at `docs-search.ts:118`: `docs/harness-doctrine.md:navigation-harness-doctrine/evidence-capabilities-not-routes#2 · L24-48`. That string is valid `read` input verbatim.
* `read` accepts single and double colon equivalently (`src/tools/read.ts` description: "Single and double colon separators are equivalent"). So `docs/foo.md:heading#2` works the same as `docs/foo.md::heading#2`. Preamble form `docs/foo.md:1-14` is also valid line-range syntax. No transformation, lowercasing, or hash needed — hash is `edit` authority only (`read-renderer.ts:262`).
* `promptGuidelines` already hints it at `docs-search.ts:41`: "Each hit's read_selector is the direct path to the full section — pass it to read rather than searching again." — but without an example it is easy to miss.

**Fix — instruction only, no output noise:**

* Add one example to `docs_search` tool description / promptGuidelines:
  ```
  Example: docs_search({query:"harness doctrine"}) → 1. docs/harness-doctrine.md:navigation-harness-doctrine/evidence-capabilities-not-routes#2
           → read({path:"docs/harness-doctrine.md:navigation-harness-doctrine/evidence-capabilities-not-routes#2"})
           Preamble hit → read({path:"docs/foo.md:1-14"})
  ```
* Add one line to `read` description: "Accepts docs_search read_selector verbatim."
* Mirror the example in `docs/tool-operating-reference.md` docs_search section.

That is it. Every scenario is covered — headed sections, duplicate headings (`#2`/`#3`), preamble, and batch `read({paths:[sel1, sel2]})` — because the selector string already matches `read`'s accepted grammar. No per-hit `→ read:` footer, no `next_reads` array, no new API. A `from_search` cursor would couple generation staleness (`indexed_section_stale` at `qmd-docs-search.ts:309`) into `read` for no saving — rejected.

**Decision:** P2 instruction-only. ~2 guideline strings + one example block. No schema or rendering change.

---

## `grep` — postponed item 1, expanded

### 1. Postponed: `contextLines` default — how `ranked` actually works (docs + code + intent)

**Status: Postponed. No code change. This section is explanatory only.**

**Intent by design — two tools in one name:**

`grep` is two distinct operations sharing a parameter schema, routed at `src/tools/grep.ts:82-93`:

* `output:"ranked"` — **discovery**. Question: "what owns this vocabulary, and where is it used?" Returns definitions, usages, owner/section context, bounded source lines, coverage, and possible source authority. Does not promise exact counts. Ranking is heuristic. This is the default (`grep.ts:82`: `normalizedEnum(params.output ?? "ranked", ...)`).
* `output:"matches"` — **deterministic audit**. Question: "exactly where does this literal/regex occur, and how many per file?" Returns ordered `file:line:match` with per-target zero lines, immutable cursor, and `coverage.complete` semantics for replacement safety. This is the mode for `contextLines`, `cursor`, and multi-target `paths`.

**How `ranked` works — docs + code:**

*Docs:* `docs/tool-operating-reference.md:225-228` — "Use one file/directory scope for definitions, usages, owner/section context, bounded source, coverage, and possible current source authority. `syntax:symbol` is useful for identifier discovery. `syntax:literal` is strongest for known phrases. Ranked output is often the optimal first observation for known vocabulary, including implementation discovery; ranking does not prove semantic ownership."

*Code path:* `src/tools/grep.ts:89-92`:
```ts
if (output === "matches") {
  nativeArgs = compact({ pattern, paths: resolvedPaths, syntax, output, case, glob, visibility, contextLines });
} else {
  const rankedPath = rankedScope(resolvedPaths);
  nativeArgs = compact({ query: pattern, kind: syntax === "literal" ? "content" : syntax, scope: rankedPath, glob, case, visibility, expand: 2 });
}
```
Ranked maps to `pi_nav_search` with `query` + `kind` + `scope` + `expand:2` (always 2 lines of owner context). Matches maps to `pi_nav_search` with `pattern` + `paths` array + `contextLines`.

*Why `contextLines` is rejected for ranked:* `grep.ts:86`:
```ts
if (output === "ranked" && contextLines !== undefined) throw new ToolCallValidationError("grep contextLines is valid only with output:'matches'.");
```
Ranked already has `expand:2` baked in — it always shows 3-4 lines around each hit (definition + surrounding owner). Adding `contextLines` would be redundant and would imply deterministic line coverage that ranked does not guarantee. Matches with `contextLines:0` is intentionally bare so `file:line:match` stays grep-compatible and zero-count audits (`returned === 0 && coverage.complete`) remain reliable (`grep.ts:137-138`).

*Current intent:* Use `ranked` first for any "find the owner" question. Switch to `matches` only when you need exact per-file counts, replacement safety, or cursor-paged exhaustive listing. The "useless single-line" complaint applies only when `matches` is used for discovery — wrong tool.

**Postponed action:** None. If revisited, the fix is a doc line, not a default change: make `tool-operating-reference.md` explicitly state "ranked already includes context; do not add contextLines; use matches only for audits."

### 2. `ranked` vs `matches` `paths` — plain-English explanation

**Plain English:**

Think of `grep` as two different search engines that share a name.

* **Ranked = "find who owns this idea."** You give it one place to look (or no place = whole project). It searches that place, finds candidates, ranks them by relevance (definitions first, usages next), and shows you each hit with its file, function, and a few lines of surrounding code so you understand the owner. It accepts **one** `paths` value because ranking only makes sense inside one corpus — you cannot rank hits from `src/a.ts` against hits from `src/b.ts` if they were searched separately; the scores would not be comparable. Code: `rankedScope` at `grep.ts:169-177` throws if you pass `["src/a.ts","src/b.ts"]` with ranked.

  Example: `grep({pattern:"renderRead", paths:"src/core", output:"ranked"})` — "find renderRead inside src/core, ranked."

* **Matches = "list every exact occurrence."** You give it one or many exact files, and it lists every line that literally matches, per file, with counts, including `0 matches in src/x.ts` so you can prove a rename is safe. It accepts **many** `paths` because it is not ranking — it is counting. Order is the order you gave. It supports `contextLines` and `cursor` because exhaustive lists can be huge.

  Example: `grep({pattern:"renderRead", paths:["src/a.ts","src/b.ts"], output:"matches"})` — "tell me exactly where renderRead occurs in these two files, with zeros if absent."

**Workaround for the only gap — "I want ranked but across 2-3 specific files":**

Ranked cannot take `["src/a.ts","src/b.ts"]` directly, but you have two equivalent options without an API change:

* `grep({pattern:"x", paths:"src", output:"ranked", glob:["src/a.ts","src/b.ts"]})` — search `src` but filter to those globs.
* Two ranked calls: `grep({pattern:"x", paths:"src/a.ts", output:"ranked"})` + `grep({pattern:"x", paths:"src/b.ts", output:"ranked"})` and merge client-side.

Revisit multi-target ranked only if telemetry shows >15% of ranked calls need it. Otherwise keep the single-scope invariant — it keeps ranking honest.

### 3. Cursor continuation — "not sure if this is the best option, it could be another"

**Blunt answer:** Cursor is correct for `matches` large result sets. Don't replace it.

* Cursor is immutable, bounded, and fails closed on expiry (`grep.ts:71-75`). Alternative "auto-page all results" would blow context budget — exactly what LeanCTX compression avoids for `bash`.
* The real improvement is not a new mechanism but better diagnostics when a cursor is stale: current message says "restart" but doesn't echo the original `pattern`/`paths`/`glob`. Adding `expired cursor was: pattern:"x" paths:[...]` to the error would save reconstruction.
* Another option — returning `coverage.more + total` so the agent can decide to page or refine query — already exists in `output.structured.data.coverage` and `completeness` (`grep.ts:131-136`). Surface it more prominently in `matches` text: `Coverage: 200 total, 50 shown, More: cursor ...`.

**Decision:** Keep cursor. Small P3 improvement: echo expired cursor's original params and show `total/more` in header.

---

## `docs_search` — what it does and why paging feels off

### What it does — plain English

`docs_search` searches your Markdown docs by meaning, not just words. You ask "how does harness doctrine handle evidence?" and it returns the sections that answer, already ordered.

Behind the scenes it keeps an index of every Markdown section (each heading plus its body). It stores each section as `File: <path> / Section: <hierarchy> / <body>`. It can search two ways:

* **With meaning (hybrid, when available):** it compares your question to section bodies by meaning (embeddings) plus words, then reranks the best 40 candidates for relevance. The result header says `Search mode: hybrid`.
* **Words only (fallback):** when the meaning index is not ready, it searches words only. Header says `lexical`.

Either way it scores each section. Sections from core docs (`harness-doctrine.md`, `evidence.md`, etc.) are boosted slightly; plans and prompt files are penalized — unless your question explicitly asks about a plan. An exact heading match gets a strong boost. This is why the right doc usually appears first without you naming the file.

Each hit comes back with: the exact path to read it (`read_selector`), the line range, a short snippet, and a score. The scores are only for ordering — they are not "confidence." The header says `Answerability: 3 answer-bearing · 2 weak leads` — meaning 3 sections look solidly relevant, 2 are weak. Weak means the meaning match was low. If every hit is weak, the tool returns a warning, not success. The `Generation` hash just tells you whether the index matches the current file contents. If a section changed or disappeared since indexing, it is filtered out and listed under `Selector omissions`.

You page with `page: 2, limit: 20` (default 20, max 50). The index always searches the top 40 candidates, then filters, sorts, and slices `page 1 = 1-20, page 2 = 21-40`, etc.

### Why paging feels off — plain English

Paging cuts the sorted list into chunks of 20. Two problems:

1. **The boundary is arbitrary.** Section 20 and section 21 often have almost the same score (difference 0.01 — noise). But section 21 might be the second half of the same document you just read in section 18 — e.g., `harness-doctrine.md` has two relevant sections, one ranked 18, one ranked 21. You stop at page 1 and miss the second half that completes the answer.
2. **You cannot tell if the next page is worth fetching.** The header `Answerability: 5 answer-bearing` is for the whole search, not for page 2. You have no signal for "page 2 still has solid answers" vs "page 2 is just weak leftovers."

### Is a fix possible? Yes — without rebuilding the index

All three fixes below are possible because the search already knows per-section meaning scores and which document each section came from. No reindex needed:

1. **Per-page signal (P2, cheapest):** Return a simple flag per page — `page 1: has solid answers, has more solid answers on next page: yes/no`. Compute it from meaning similarity, not raw score difference. You only fetch page 2 when the flag says there is more solid material.
2. **Keep same-doc sections together (P2, a bit more work):** Before cutting into pages, group sections by document. If a document has sections on both sides of the 20-item cut, keep them together on page 1 (allow 20-24 items). This prevents splitting a document's related sections.
3. **Merge near-ties (P3):** If page 2's top section has almost the same score as page 1's bottom and comes from a document already on page 1, pull it onto page 1.

Implementation sketch for (1): after reranking, mark each section solid vs weak using the existing thresholds the tool already uses. Set `has_more_answerable = true` if any section on the next page is solid.

**Decision:** Propose (1) as the only P2 here. It is backward-compatible (new flag in the response), cheap, and directly fixes the "should I fetch page 2?" uncertainty. (2) is P2 if (1) proves insufficient in evaluation.

---

## Prioritized proposal

| Priority | Item | Change | Cost |
|----------|------|--------|------|
| **P2** | `docs_search` per-page signal | Add `has_more_answerable` flag so paging is not a guess | Small, QMD only |
| **P2** | `docs_search` → `read` instruction | One example in tool docs showing `read_selector` used verbatim | ~2 lines |
| **P3** | `docs_search` same-doc grouping | Group by doc before slicing pages | Small-medium |
| **P3** | `read` filter param | Optional `filter: regex` post-filter, not inline syntax | Small |
| **P3** | `grep` cursor diagnostics | Echo expired cursor params, show total/more | Trivial |
| **Withdrawn** | `read` per-hit footer | Noise on every call — instruction example is enough | — |
| **Withdrawn** | `read` from_search cursor | Not worth cross-tool coupling | — |
| **Withdrawn** | `grep` contextLines default 2 | Breaks deterministic audits | — |
| **Withdrawn** | `grep` multi-target ranked | Rare, workaround via glob exists | — |

All withdrawn items remain documented here so they are not re-proposed without new evidence.

---

## Verification

* `src/tools/docs-search.ts:41,193-216,201,118` prove `read_selector` is verbatim and already surfaced.
* `src/tools/grep.ts:169-177,85-93,90-91,131-138` prove ranked single-scope vs matches multi-target and cursor/coverage semantics.
* `docs/tool-operating-reference.md:216,225-232` matches source for grep ranked/matches contract.
* `src/core/qmd-docs-search.ts:9,239-395,328-331,366-390,378-391` prove index format, scoring, answerability thresholds, generation, and pagination candidate window.
* `src/core/read-renderer.ts:16-20,128-180` show read selector resolution and authority model that a filter would post-process.

No behavior changed by this proposal file. Implementation requires separate review.
