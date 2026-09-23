---
title: "jeito codeweave-pi tool-output UI rendering contract"
description: "Visual style, color decisions, and the model/TUI output-quality boundary for jeito-codeweave-pi rendering. Density levels and card structure live in docs/density-card-contract.md."
tags: [jeito-codeweave-pi, ui-rendering, tui, display-only, theme]
created: 2026-07-25
updated: 2026-08-28
status: active
owns: "Visual style, color decisions, per-tool typed projections, and model/TUI output-quality contract for jeito-codeweave-pi"
audience: contributor
code: [src/core/tui-render.ts, src/core/read-renderer.ts, src/core/summary-renderer.ts]
related: [docs/density-card-contract.md, docs/evidence.md, docs/automatic-workflow.md]

# Tool-output UI rendering

Status: visual-style and output-quality guide for jeito-codeweave-pi rendering. It owns colors, frames, per-tool typed projections, and the model/TUI evidence boundary — not navigation or mutation semantics.

**Density levels, the unified tool-card pattern, block render contracts, and host-owned
leading spacing are owned by `docs/density-card-contract.md`**, which supersedes
every density claim previously made here. That document also owns the acceptance gate
(`tests/jeito-density-matrix.test.mjs`) for any new rendered tool.

This doc is about presentation only. It must not redefine tool semantics, navigation behavior, proof/edit authority, or backend policy. Compact evidence remains in `docs/evidence.md:current-evidence-map#1`.

The `tools` control renderer in the tooltap extension is a separate, narrower contract at `extensions/tooltap/docs/ui-rendering.md`; this document owns codeweave-pi's general tool-output rendering, not that control's chrome.

## What changed

- Density/card mechanics live in `docs/density-card-contract.md` (ultra→condensed→normal→extended and unified cards). Installed Pi owns its separator; jeito no longer patches it. This file keeps what the deeper densities show: typed evidence bodies per tool.
- `src/core/tui-render.ts` owns jeito-codeweave-pi tool rendering: open-right frames, colored tool chrome, read syntax highlighting, edit/write diff previews, and width-safe output clamping. Semantic text/status colors already use Pi `Theme` tokens; the established border and diff palette remains local ANSI until a theme-derived replacement is live-validated.
- `read` renders numbered hashed source; any qualifying capability may also carry certified live-source authority.
- `edit` renders successful diffs with the existing preview and maps structured partial outcomes to the partial-success marker; raw text retains exact landed/held/rejected detail, retry guidance, syntax notes, and optional LSP results.
- `write` renders created files as added rows and overwrites as diff rows, also using the 50-line preview budget.
- `lsp_validate` is registered with the shared self-rendered shell, detected Nerd Font icon, tool-family color, shared density behavior, and typed per-file status/diagnostic rows. Clean, diagnostics, unsupported, unavailable, skipped, and unconfirmed remain distinct; mixed confirmed/unsupported output is partial, while actual diagnostics use warning status without treating successful execution as a tool error.
- Bounded detecting/warming/checking progress is emitted through `_onUpdate` without package-manager plumbing. Fresh AgentSession checks cover ordinary edit, unsupported standalone LSP, inline CHECK LSP, repeated reloads, and an opt-in TypeScript diagnostic/clean-or-unconfirmed run; deterministic core fixtures cover every structured LSP status.
- Prepared collection summaries surface structural page position and editable-site count from the same evidence. Full native rows, identities, page windows, omissions, and diagnostics remain in structured details; public text keeps only the relationship/ranking/change evidence needed for the current claim.
- `grep` matches rendering consumes typed resolved/filter/group/outline/source-row/exception/target/coverage/cursor fields. It preserves requested lexical context, syntax-highlights complete source, distinguishes match and context gutters, keeps concrete exceptional paths/reasons, renders actual `[path#HASH]` identities with visible line ranges, and marks clipped rows non-authoritative. Ranked grep model text now emits one scope/interpretation/coverage header plus bounded definitions and usages; the full ranked native result remains in structured details, and only certified current-source rows are appended. Both modes keep omissions and incomplete coverage explicit so an agent can distinguish a result cap, budget cap, or cancellation from a clean complete run without re-issuing the call.
- Prepared tools attach small presentation sidecars without discarding structured native evidence. Trace model text renders each related peer once with edge kind, provenance/confidence when present, one repo-relative site, page/omission coverage, and one bounded certified source expansion; full backend identities and collections stay in `details.native`. Homogeneous multi-target trace renders ordered per-target status and bounded exact rows without flattening sibling evidence. Explore code rendering leads with the active search mode and the evidence it returned: lexical candidates remain full prepared evidence rather than being demoted because semantic enrichment was not used. `docs_search` likewise presents hybrid or lexical mode as active current-section evidence, then preserves ranking provenance, scores, answerability, snippets, selectors, generation, filters, paging, omissions, request-specific unavailable/error diagnostics, and exact continuation. Diff summary/structure uses typed changed-file/symbol units and explicit native completeness; impact/review renders exact files/ranges/symbol counts once, keeps prepared components separately statused, normalizes in-project public paths to repository-relative form, and retains native prepared identities in structured details. Patch truncation remains visible and renders partial rather than success. Batched read pins failed groups and reports partial-success status when other groups remain usable, and find groups pattern buckets including explicit zero buckets while displaying the native `tokenEstimate` already computed for each path.
- Graph `path` and `explain` cards preserve native shortest-path, node, connection, provenance, and ambiguity evidence instead of reducing graph output to incidental source locators. Focused code-relation rows name the peer identity as well as the edge kind; complete-zero cards retain the native skip/not-found reason. Explore code search prioritizes non-test candidates in mixed results, reports the excluded-test count and opt-in, and keeps test-only results as subsystem evidence. Explore topology accepts stock CRG's `file` field, prefers exact File identity over same-file symbols, and orders edge cards by proximity to the requested start. Trace test cards preserve direct versus supplemental origin and page candidate origins to the requested limit.
- Exact-tool result labels preserve complete-zero semantics: a zero grep target is not counted as an exception, batched find model text names every pattern's count including zero, and diff review omits a prepared risk score from direct change claims when every attributed changed-function row falls outside the exact patch scope.
- Normal model text is compacted only in route-owned, evidence-preserving shapes: prepared search leads with active evidence rather than speculative health, docs retrieval signals share one line, diff removes duplicate prepared attribution while retaining exact scope, risks, omissions, and failures, and trace removes wrapper-derived duplicate collections while retaining native rows/provenance/page evidence. No generic native-field suppression was added; request-specific diagnostics remain in structured evidence and appear when they change the returned claim. The compaction doctrine is `docs/harness-doctrine.md:navigation-harness-doctrine/evidence-dense-output-design#2`.
- `../../shell/index.ts` owns bash/jobs presentation for the shell surface: open-right frames, colored frame chrome, result/status summaries, and job state labels, under the shared density contract.
- Nerd Font file/folder decoration is presentation-only: it adds no public tool field and never changes `ls`/`find` execution or model text. Detection is cached once from an explicit `PI_NAV_NERD_FONT` frontend override or the active Ghostty/Kitty/WezTerm configuration; unknown or unreadable font configuration fails closed to plain text.
- Footer status distinguishes partial success from a warning: `◐` means useful evidence was returned with incomplete coverage, while `⚠` is reserved for warning/unavailable/unsafe-zero states. Exact errors remain `✗`, pending remains `…`, and complete success remains `✓`.
- Density cycling, budgets, and default level: see `docs/density-card-contract.md`. **Ctrl+O (`app.tools.expand`) is NOT used by any jeito renderer** — it stays native for built-in tool expansion and is ignored everywhere.
- Consecutive tool calls are not transcript-grouped today. The current Pi `0.84.3` mechanism audit, rejected extension-only shortcuts, proposed host boundary, lifecycle risks, and disposable falsifier are owned by `../../../.pi/goals/single-line-ultra-cards/plan.md`; no grouping implementation is authorized under this rendering change.
- `read` batch (`paths`) renders each file as its own syntax-highlighted block with a `path · ranges · #hash` header, reusing the single-file source-line highlighter and gutter; long files are truncated per file so every file's header, ranges, and hash stay visible instead of a flat raw-text dump hiding later files. `shown_no_authority` files keep the header plus a dim reason, failed groups stay pinned red, and omitted groups report a compact reason. Extended mode reveals the full long file.

## Code map for future edits

jeito codeweave-pi:

- `src/core/tui-render.ts::{configuredNerdFont,fileIcon,toolIcon}` — frontend-only icon detection and semantic Nerd Font decoration.
- `src/core/tui-render.ts::{framed,framedCall,UnifiedCardBlock,jeitoDensityBlock}` — colored open-right chrome, status labels, and visual budgets. Density mechanics: `docs/density-card-contract.md`.
- `src/core/tui-render.ts::{clampLineToWidth,truncateAnsiToWidth,visibleWidth}` — ANSI/control-safe width handling; this is the live-color safety seam.
- `src/core/tui-render.ts::{cliHighlight,cacheHighlight,highlightReadCodeBlock,highlightedEvidenceRow}` — optional cached syntax highlighting and local fallback.
- `src/core/tui-render.ts::{renderPrettyDiffRows,renderEditResult,renderWriteResult}` — current project diff presentation; do not replace it merely to match another package.
- `src/core/tui-render.ts::{structuredFindPreview,structuredLsPreview,structuredMatchesPreview,structuredRankedPreview,renderLspValidateResult,structuredExplorePreview,structuredTracePreview,structuredDocsPreview,structuredDiffPreview}` — typed capability-specific TUI projections. `structuredExplorePreview` renders code search candidates separately from traversal nodes/edges, keeps not-found/ambiguity non-green, labels File identity semantic work as not applicable, shows generation/native truncation/next page, and distinguishes retrieval rank from edge confidence plus prepared locators from current source authority. `structuredLsPreview` owns both list and colored/icon tree rendering; falling back to native tree prose loses decoration. `find` must retain native token hints, and `lsp_validate` must remain in the shared density/color contract.
- `tests/v3-core.test.mjs` — codeweave-pi typed-evidence content, width/ANSI safety, and status semantics. Cross-surface semantic coverage lives in `../../../tests/jeito-density-matrix.test.mjs`; realistic scenarios in `../../../tests/jeito-ui-catalog.mjs` feed the interactive `../../../tests/jeito-ui-gallery.mjs`.

Shell surface (bash/jobs):

- `../../shell/index.ts` — TextBlock/ShellDensityBlock/ShellUnifiedBlock, ANSI stripping/width helpers, bash/jobs call/result renderers, unified-card helpers. Structure per `docs/density-card-contract.md`.

## Frontend settings and controls

- **Ctrl+U** is the owned jeito toggle (`Symbol.for("pi.agent.jeitoDensity.v1")`; levels and default in `docs/density-card-contract.md`). It is **not** Pi's `app.tools.expand` — Ctrl+O stays native and is ignored by every jeito renderer.
- **Ctrl+O** remains `app.tools.expand` (`ctrl+o` in `~/.pi/agent/keybindings.json`). Do not rebind it to `ctrl+u`; tree-filter `app.tree.filter.*` bindings disabled to keep `ctrl+u` solely for jeito density.
- `Ctrl+R` is the active local binding for Pi's `app.thinking.toggle`, configured in `~/.pi/agent/keybindings.json`; `Ctrl+T` is no longer bound to that action in this installation. This is a user-level Pi setting, not a jeito-codeweave-pi tool parameter.
- Pi's host `Theme` supplies semantic colors (`toolTitle`, `accent`, `muted`, `toolOutput`, `success`, `warning`, `error`). Stable tool-family borders and diff backgrounds remain local ANSI RGB constants until a theme-derived replacement passes live dark/light and narrow-pane validation.
- `PI_NAV_NERD_FONT=on|off` is a frontend-only override. Without an override, Ghostty, Kitty, and WezTerm configuration is checked once at module load; unknown/unreadable/non-Nerd configurations produce no decorative glyphs. Tool schemas and model text never contain icon controls.
- Per-level content: condensed adds a bounded body preview under the header; normal keeps up to 30 total lines; extended raises the total cap to 120; ultra keeps one status line. Ultra colors status, tool, target, and metric as separate roles, reserves space for both target and metric at narrow widths, and puts mutation hashes before lower-priority counts.
- The shell surface uses the same density hierarchy for `bash`, `jobs`, and automatic `job-done` entries. Shell frame chrome follows status rather than tool color; completion summaries count newline-delimited command output and failed completions include a concrete `jobs({ id, delta:true })` inspection action. Package behavior is owned by `../../shell/README.md`.

## Libraries studied and reusable ideas

Use these repositories as source references and visual inspiration, not automatic dependencies:

- [`@wierdbytes/pi-facelift`](https://github.com/wierdbytes/pi-wierd-stuff/tree/master/packages/facelift) and the [`pi-wierd-stuff` common frame/diff code](https://github.com/wierdbytes/pi-wierd-stuff) — open-right frames, status-aware footers, duration/status summaries, visual demo harnesses, consistent diff-layout decisions, and width-safe rendering.
- [`@xynogen/pix-pretty`](https://github.com/xynogen/pix-mono/tree/main/packages/pix-pretty) and [`pix-edit`](https://github.com/xynogen/pix-mono/tree/main/packages/pix-edit) — semantic icon catalogs, Nerd/Unicode/ASCII fallbacks, bounded highlight caches, file-type decoration, tree/grid layout, and shared renderer primitives.
- [`@mobrienv/pi-tidy-tools`](https://github.com/mikeyobrien/pi-tidy-tools/tree/main/packages/pi-tidy-tools) — compact call/result composition, result-tail-preserving truncation, and use of Pi's `expanded` render signal. Its two-line generic/reasoning schema is not our contract; our typed evidence remains intact. Its source also demonstrates why Pi's expansion signal is global, so a multi-level derivative must synchronize one global phase and treat first component appearance as a join rather than a toggle.
- [`pi-tool-display`](https://github.com/MasuRii/pi-tool-display) — compact pending previews, theme-derived palettes, and alternate diff presentation. Evaluate visually before borrowing; do not replace current execution or authority paths.
- [Pi `ToolExecutionComponent`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/tool-execution.ts), [extension renderer types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts), and [keybindings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/keybindings.ts) — authoritative host behavior for `renderShell`, `ToolRenderContext.state`, the Boolean `expanded` flag, component construction, and application actions.

Concepts already borrowed locally, without adding those packages as runtime dependencies:

- open-right rounded frames and stable tool-family colors;
- status-aware result footers and partial-success distinction;
- tool-specific grouped/typed rendering rather than generic text cards;
- syntax-highlighted reads and match evidence;
- current edit/write diff previews, gutters, colored add/remove rows, and changed-span emphasis;
- ANSI-safe narrow-width clamping;
- semantic detected Nerd Font icons;
- compact/normal/extended transcript density;
- typed colored `ls` list/tree rendering.

Future reuse rules:

- Extract local frame/density/icon/tree code into a small internal renderer module before `tui-render.ts` grows another major feature family.
- Prefer renderer APIs that preserve exact native paths, source text, diagnostics, hierarchy, status, omissions, and authority. Never substitute a search/mutation backend merely to obtain its presentation.
- Keep current diffs unless a proposed change is demonstrably better for multiline edits in live visual tests.
- Any density feature must test several existing tools, different render orders, a tool created mid-cycle with constructor-default state, resize/stream updates, and color retention.
- Any icon change must remain fail-closed when font support is unknown and must pass actual Pi width measurement.

## Implementation notes

- Render hooks use `renderShell: "self"` and return `TextBlock`-like components with `render(width): string[]`.
- `TextBlock.render` clamps all lines to the width Pi asks for. The width may be much narrower than the default frame width used when constructing text.
- `resultText` enriches prepared-result envelope summaries with `page N/M` and distinct `[path#HASH]` counts when those signals are present. TUI chrome may surface them, but it must not infer missing totals or hide native continuation diagnostics.
- `read` highlighting is best-effort: `cli-highlight` is optional; fallback highlighting is local and lightweight.
- `edit` output is parsed from the text returned by `applyPatch`; `extractDiff` must accept both `Diff:\n` and inline `Diff: first changed region...` forms.
- `write` created-file output is converted from numbered `read`-style rows into synthetic added diff rows via `sourceRowsToAddedDiffRows`.
- Edit/write preview line budgets are larger than normal tool output because mutation proof needs more visual context. Current cap: 50 rendered UI lines.
- Source registration alone is not live proof. Closure uses fresh AgentSession execution for edit/LSP output plus loaded renderer regressions; the already-mounted conversation surface still requires a Pi reload before a newly registered tool can appear. Loaded-renderer verification follows `docs/evaluation-workflow.md:agent-evaluation-workflow/release-implementation-validation-tiers#2`.
- Footer labels should include the compressed path and hash when available. This helps users infer exactly what changed without expanding raw output.
- Nerd Font detection performs at most a bounded set of small terminal-config reads once when the renderer module loads. Consumers request semantic file/directory roles; if detection fails, `fileIcon` returns an empty string with no layout option exposed to agents.
- `ls` and `find` icons decorate typed native entries only; both display native token estimates, and tree view derives colored connectors from typed depth. `lsp_validate` uses a semantic tool icon but never decorates diagnostic text as source authority. None of these renderers rewrite paths, source rows, hashes, diagnostics, or agent-visible schemas.
- Density state, defaults, and the no-state fallback path are specified in `docs/density-card-contract.md`. In short: one shared global level (default `condensed`), read live per render; standalone calls without `ToolRenderContext.state` get the classic framed block so direct/test callers keep working.
- The TUI never changes model-facing evidence: wider levels reveal more body rows; ultra removes body rows only from the TUI.
- Extended mode raises the UI cap to 120 lines while keeping capability-specific selection, source-authority rules, ANSI-safe width clamping, and omission markers. Ultra mode removes body rows only from the TUI; model-facing evidence is unchanged.

## Model/TUI output-quality contract

Design the structured result and model-visible text together before writing renderer code. The normal text is not a debug dump, and the TUI is not allowed to recover semantics by regex-parsing that text when typed fields exist. This is the model-facing half of the native-output doctrine (`docs/harness-doctrine.md:navigation-harness-doctrine/native-output-doctrine#2`).

For each capability define and fixture at least five states: normal success, complete zero, filtered/skipped zero, partial success, and continuation. Add exact-target mixed success when the tool accepts several targets. Each fixture identifies the atomic display unit, fields shown once, fields retained only structurally, source rows eligible for authority, and material exception expansion.

Model-visible output should be rich but non-redundant:

- one normalized interpretation line;
- one scope/filter line when it affects result meaning;
- one path/range/owner header per coherent block;
- bounded hierarchy/outline only where it explains the result;
- verbatim source lines once, with match styling/structured spans never replacing source text;
- one compact normal completeness line;
- detailed diagnostics only for exceptional targets or incomplete work;
- one continuation identity when another stable page exists.

Do not print instructional handoffs, duplicate path/range/owner prose, full internal coverage matrices, routine byte offsets, or repeated source in authority sections. Smart agents can select their next evidence capability from the location; they still need explicit filtering, incompleteness and skip facts to avoid false interpretation.

- `docs_search` renders the active lexical/hybrid ranking mode as current document-section evidence, plus generation, latency, candidate-window lower bounds, title/authority and BM25/vector/rerank/RRF provenance, per-result answerability status/reasons, answer-bearing and weak-lead counts, exact `read` selectors, filters, paging, and selector diagnostics. A page containing only weak leads is a warning and explicitly claims no answer-bearing match; an explicit path/glob filter can still produce a true filtered zero. Collapsed view suppresses duplicate score detail; expanded view retains retrieval/native/final scores and compact provenance.

The TUI may collapse or decorate blocks, but it must preserve warnings, filter state, continuation, counts and authority identity. Width/token compaction happens between complete units or source rows; it may not silently remove the matched row, turn partial into complete, or certify hidden text.

## Color decisions

Current colors are hardcoded ANSI RGB. This is accepted for now because the original working jeito-codeweave-pi border palette already used hardcoded ANSI, and a theme-derived palette has not been live-validated.

Where to adjust colors:

- Tool border colors: `TOOL_BORDER_COLORS` in `src/core/tui-render.ts`.
- Diff row colors: `DIFF_ADD_FG`, `DIFF_REMOVE_FG`, `DIFF_ADD_BG`, `DIFF_REMOVE_BG`, `DIFF_ADD_EMPHASIS_BG`, `DIFF_REMOVE_EMPHASIS_BG` in `src/core/tui-render.ts`.
- Shell surface colors: `UI_COLORS` in `../../shell/index.ts`.

Current jeito-codeweave-pi palette is recorded compactly in `docs/evidence.md:current-evidence-map#1`. When changing it, keep these rules:

- add/remove colors must be readable on dark terminals;
- row backgrounds must be subtle enough not to bury syntax highlighting;
- tool border colors should stay stable and recognizable by tool family;
- truncation and hidden-item rows keep the same rail color as neighboring body rows; only their explanatory text is muted;
- colors must survive clamping; stripping ANSI is a regression;
- never colorize exact file paths or code snippets by rewriting their text content.

## Mistakes to avoid

- Do not change tool execution, schema, authority, or navigation semantics while doing UI work.
- Do not treat a renderer as source authority. `read` or another capability can provide live hash-certified rows; render hooks only display the result.
- Do not use broad grep/find/bash searches to reason about renderer relationships; use prepared navigation or direct known-file reads.
- Do not strip ANSI in `clampLineToWidth` when truncating overwide rows. That caused live Pi narrow panes to render monochrome even though standalone smokes contained color. Use `truncateAnsiToWidth`-style complete-SGR preservation.
- Do not keep partial ANSI/OSC/control sequences. Width clamping must keep terminal safety and color preservation together.
- Do not add a new dependency just for visuals unless it is justified, reviewed, and does not alter tool behavior.
- Do not assume source-level render smokes prove live visual quality. Pi may need `/reload` or restart, and terminal width/theme can change the result.
- Do not create dated screenshot/log docs. Keep durable facts here or compact evidence in `docs/evidence.md:current-evidence-map#1`.

## Verification

The fixture catalog, interactive gallery, and semantic gate workflow is owned by
`docs/density-card-contract.md:density-levels-and-the-unified-tool-card-contract/verification-visual-review-first-semantic-gate-second#2`.
Run `npm run test:ui` first after any card/density change, then the gallery at narrow
and normal widths.

Focused checks after renderer edits:

- `npm run test:ui` — cross-surface semantic gate (owner: `docs/density-card-contract.md`). Run this FIRST after any card/density change.
- `node --test extensions/codeweave-pi/tests/v3-core.test.mjs` — codeweave-pi typed-evidence content, width safety, edit/write preview coverage, narrow ANSI preservation, and status semantics.
- Shell, web, and tooltap surfaces run their own package tests (`npm test --workspace extensions/shell`; typecheck plus tests for web and tooltap). A codeweave-pi green proves nothing for another surface.

For docs-only updates, run `git diff --check -- docs/` and do not run broad tests. For release-clean UX claims, run manual live Pi/cmux visual inspection after `/reload` or a Pi restart; automated tests are supporting evidence only.

## Live-use notes

- Users may need `/reload` or a Pi restart before renderer changes appear.
- If colors are absent live but present in smoke output, first suspect width/clamping or stale Pi extension load state.
- If colors are too low-contrast, tune the palette constants before changing parsing/rendering behavior.
- If output looks correct in source tests but bad live, capture the live pane width/theme/reload state before changing core logic.
