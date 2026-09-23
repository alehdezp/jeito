---
title: "jeito density levels and unified tool-card contract"
description: "The reference for adding a jeito-rendered tool card: density levels, ensure/bind/frame pattern, block contract, host-owned spacing, and the matrix acceptance test."
tags: [jeito, tui, density, tool-cards, unified-block, host-boundary]
created: 2026-08-25
updated: 2026-09-06
status: active
owns: "Density level system, unified card pattern, block render contract, and host-owned leading spacing"
audience: contributor
code:
  [
    src/core/tui-render.ts,
    ../shell/index.ts,
    ../tooltap/extensions/index.ts,
    ../web/src/ui/tui-render.ts,
  ]
related:
  [
    docs/ui-rendering.md,
    ../../tests/jeito-density-matrix.test.mjs,
    ../../.pi/goals/single-line-ultra-cards/goal.md,
  ]
---

# Density levels and the unified tool-card contract

This document supersedes the density/card sections of `docs/ui-rendering.md`, which
keeps visual style, color decisions, and the model/TUI output-quality contract. If
this file and `ui-rendering.md` disagree about density or card structure, this file wins.

## The four density levels

One shared global, one shortcut, everywhere:

| Level       | Budget (content lines) | Card shape                                                        |
| ----------- | ---------------------- | ----------------------------------------------------------------- |
| `ultra`     | 1                      | single status line, no frame                                      |
| `condensed` | 8                      | `╭── title` + up to 6 body lines (incl. `… N more…` hidden-note) + `╰── label` (=8 total) |
| `normal`    | 30                     | same shape, larger body budget (top + 28 body + footer)           |
| `extended`  | 120                    | same shape, effectively full body (top + 118 body + footer)       |

- State lives on `globalThis[Symbol.for("pi.agent.jeitoDensity.v1")]` as `{ level }`;
  index into `["ultra","condensed","normal","extended"]`. **Default is `condensed` (level 1)** —
  every new session starts there; `ultra` is one Ctrl+U step away.
- Every surface reads the same symbol via its own local `currentDensity()` /
  `cycleDensity()` / `resetDisplayDensityForTests()`. Never import these across
  extension packages — each surface keeps its own copy (repo ownership rule), but they
  must stay textually identical or the matrix test will desync.
- **Ctrl+U** cycles the level. It is registered exactly once, in
  `extensions/codeweave-pi/index.ts` (`jeitoCodeweavePiExtension`), which calls
  `cycleDensity()` then `appendEntry(...)` to force a TUI reflow. No other surface may
  register it.
- Density is **read inside `render()` on every call**. Never bake it into a field at
  construction time, or Ctrl+U stops reflowing already-mounted cards.
- Pi's `ctx.expanded` (Ctrl+O) is ignored by every jeito renderer. `isExpanded()`
  means exactly `currentDensity() === "extended"`.
- **Separator rule**: `wantsLeadingSpacer()` is `currentDensity() !== "ultra"` — ultra
  cards sit flush (dense status list); every framed level (condensed/normal/extended)
  gets the host's blank row so adjacent frames never butt together.

## Canonical pattern: adding a rendered tool

Three moving parts per surface plus one shared state slot. codeweave-pi
(`src/core/tui-render.ts`) is the reference implementation; shell/tooltap/websift mirror it.

```ts
// 1) renderCall — create or refresh THE card for this tool execution.
export function renderFooCall(args: any, theme: ThemeLike, context: any = {}): any {
  const title = /* icon + bold tool name + accent detail */;
  const w = widthOf(undefined, context);
  const card = ensureFooCard(context, "foo", theme, w, title);
  if (card) return card;                 // <- the unified card IS the call component
  return new TextBlock(frameTop(title, w)); // legacy fallback when ctx.state is absent
}

// 2) renderResult — bind FIRST LINE, build body, hand to framed().
export function renderFooResult(result: any, options: any, theme: ThemeLike, context: any = {}): any {
  bindFooResultCard(context);            // MUST be the first statement
  rememberDensity?.(theme, options, context);
  const status = frameStatus(result, options, context);   // always define before use
  const width = widthOf(options, context);
  return framed(buildBodyLines(result, theme), fooLabel(result, theme), status, theme, width, "foo");
}
```

```ts
// 3) framed() routes into the active card and returns a ZERO-LINE stub when bound:
function framed(lines, label, status, theme, width, tool, maxLines): any {
  const block = new FooDensityBlock(lines, label, status, theme, width, tool, maxLines);
  if (activeFooCard) { activeFooCard.receiveBlock(block); return { render: () => [], invalidate() {} }; }
  return block;                          // standalone path (tests, no-state callers)
}
```

Why this shape: Pi's `ToolExecutionComponent.updateDisplay()` clears its container and
re-invokes `renderCall` then (when a result exists) `renderResult` on every event, so
component identity is meaningless — only emitted lines matter. Both hooks receive the
same `ToolRenderContext.state` object; storing the card at `state.card` makes the call
line the single persistent component that absorbs the result. The zero-line stub means
the result adds no second row; the differential TUI then rewrites exactly one line
between pending → done.

Register the tool with `renderShell: "self"` plus both hooks. A tool registered without
them falls back to Pi's unframed default Box — that is how `web_fetch` ended up outside
the frame once; don't repeat it.

## Block contracts

### The unified card (`*UnifiedBlock`)

One class per surface. Required surface:

- ctor `(tool, theme, width, title[, target])`; `refreshCall(...)` updates those fields.
- `wantsLeadingSpacer(): boolean` → `currentDensity() !== "ultra"` (only ultra sits flush; condensed/normal/extended all keep the host blank so adjacent `╭──` frames never butt together — the `web_answer_exa`/`web_answer_linkup` butting was the `normal||extended` predicate missing condensed)
  (drives the host patch; see below).
- `receiveBlock(block)` stores the result-side density block; `setText()` no-op;
  `invalidate()` no-op.
- `render(width): string[]`:

| state      | ultra                          | condensed / normal / extended                                  |
| ---------- | ------------------------------ | --------------------------------------------------------------- |
| no block   | `… tool` (pending glyph line)  | `frameTop(title)` + `frameBottom("… pending tool")`              |
| has block  | single glyph line (below)      | `[frameTop(title), ...bodyBlock.render(w)]` capped               |

Ultra line grammar (all clamped via the surface's ANSI-safe clamp):
`glyph bold(tool) [accent(target)] · muted(metric) [· muted(diagnostic)]`.
The target and metric receive separate width budgets so a long query cannot erase status
evidence at narrow widths. Mutation tools remove duplicated action/path prose and put the
edit-authority hash before lower-priority counts. On warning/error/partial, surface the
first matching reason line from the body (codeweave-pi's regex is the reference). Deduplicate
before composing: strip the status glyph, the tool name, and the target/detail from the
result label before it becomes the metric (codeweave-pi `ultraLine`, shell `ultraMetric`,
tooltap/websift `plainLabel` slices are the four references) — a metric that repeats the target
wastes the narrow budget and reads as duplication.

### The density block (`*DensityBlock`)

Owns body shaping for standalone/fallback use and supplies the body under wider levels.

- Total rendered budgets are fleet-wide and exact: `condensed → 8`, `normal → 30`, `extended → 120`; the header and footer count toward them.
- `ultra` branch retained: footer-only (this is what no-state callers see).
- Overflow emits `… N more UI lines hidden · Ctrl+U to show` before the footer. The `│` keeps the card's current chrome color (tool color for codeweave-pi/websift/tooltap, status color for Shell), while the message is separately `muted`. The `capUi`/`capRenderedLines` fallback `… UI truncated to N lines · Ctrl+U to show` follows the same split; coloring the whole row muted detaches it visually from the card.
- Must expose getters used by the unified card: `labelText`, `blockStatus`,
  `bodyLines` (codeweave-pi also `budget`). websift's block grew these after the matrix caught
  their absence — copy them when porting.

### Color contract (so condensed/ultra never look bland)

- **Frame chrome** (`╭──`, `│`, `╰──`):
  - codeweave-pi / stow / web: tool-colored (`toolBorder`/`toolColor`) so each tool keeps its identity (read=blue, bash=yellow etc.) — status is shown by the glyph + footer label.
  - Shell `bash`/`jobs`: **must be status-colored** via `statusBorder` on **all three parts** (top `╭──`, side `│`, bottom `╰──`): `success` → green, `error` → red, `warning` → yellow. Leaving the top in tool yellow while the sides are red was the live bug in your screenshot.
- **Ultra single line** must carry **hierarchy**: status-colored glyph (`fg(statusColor)`), bold tool (`bold`), `·` and metric in `muted`, target/detail in `accent`, diagnostic in `muted`. With the numeric test theme this means ≥2 SGR escapes on the line; the matrix asserts it. A plain white line is a regression.
- **Condensed/normal/extended body** must keep the same hierarchy: tool title via `toolTitle` (bold + toolTitle color + accent detail), body rows via `highlightReadCodeBlock`/`tintOutputLine` where applicable, and the `│` rail (tool-colored for codeweave-pi/websift/tooltap, status-colored for bash/jobs). If `condensed` looks “bland” (all white), the `toolTitle`/`accent`/`muted` wrappers were dropped.
### Hard rules (each one was a live crash)

1. `render()` **always returns `string[]`**, never `undefined`, never empty for a done
   card. Guard every delegated call: `(block as any)?.render?.(w) ?? []`.
2. Use THIS file's strip/clamp helpers (`stripUiAnsi` vs `stripAnsi` differ per surface —
   wrong-name crashes are `ReferenceError`s mid-frame).
3. When refactoring a renderer, diff its locals against the original before landing —
   dropped `const status` / `const executed` locals were two separate incidents.
4. Define helpers before the classes that close over them, and keep exactly one
   definition of `framed()`/`frame()` per surface (a duplicate silently re-binds nothing).
5. Every registered jeito tool sets `renderShell: "self"` + `renderCall` +
   `renderResult`. No exceptions.

## Host-owned leading spacing

jeito uses Pi's supported `renderShell: "self"`, `renderCall`, and `renderResult` interface. Registration does not rewrite installed Pi, create host backups, or require an environment flag to prevent those writes. The former automatic leading-spacer patch was removed because dependency mutation during startup is incompatible with portable, predictable installation.

The inspected Pi renderer prepends one blank line to nonempty self-rendered content; its public tool definition offers no leading-spacer control. That separator belongs to the host. jeito's own frame adds no padding, and the existing rich evidence, density levels and shortcuts remain unchanged. Already-patched host installations are not automatically restored; host restoration is a separate explicitly authorized operation.

The density-matrix registration test uses a disposable imitation host and verifies unchanged bytes and no backup files without a disabling environment flag. The remaining matrix verifies the existing card output. This proves source registration safety and renderer contracts, not the appearance of every Pi release.

## Verification — visual review first, semantic gate second

`tests/jeito-ui-catalog.mjs` is the realistic fixture inventory for every registered
jeito renderer. It covers pending, success, failure, and overflow where applicable at
56, 88, and 120 columns. Add a tool there in the same change that registers its renderer:
append the name to `EXPECTED_TOOLS` and give it one `TOOL_CASES` entry whose success
fixture uses the renderer's native structured details (typed rows under
`details.native`/the tool's own details shape), not prose shaped like the output. A
text-only fixture renders an empty condensed/normal body with a misleading footer — the
grep success fixture did exactly that until it was replaced with native match and
source-row data. Give the overflow fixture tool-specific body rows (`overflowResult`)
and, when overflowing requires a path or payload argument, tool-specific arguments
(`argsForScenario`).

```bash
npm run test:ui        # semantic gate (matrix); root `verify` runs it first
npm run ui:gallery     # interactive review
npm run ui:gallery -- --tool job-done --scenario failure --all --width 88
```

Arrow keys move through tools/scenarios; `u` cycles density, `w` cycles width, and `a`
compares all four modes. The gallery flags line-budget, width, ultra-frame, missing-
frame, and omission-rail violations inline — an omission row that loses the card's rail
color, or whose message is not muted, is a warning. Review hierarchy, useful-first
evidence, honest truncation, and failure actionability; it is deliberately not a
snapshot approval tool.

`tests/jeito-density-matrix.test.mjs` is the fast semantic gate, run as
`npm run test:ui`. It derives expected coverage from actual `registerTool` calls and
asserts that set equals the catalog's `EXPECTED_TOOLS` in both directions, so a
registered renderer without a catalog case fails the inventory test. Role assertions
run against the numeric per-role test theme (`ROLE_CODES`/`ROLE_THEME`); review new
cases with that theme, not a cosmetic one. It renders every available scenario at
narrow and normal widths and checks:

- one frameless ultra line versus complete framed cards at wider densities;
- exact 1/8/30/120 budgets and ANSI-safe width;
- status, tool, accent-target, and muted-metric color roles;
- zero-line result stubs after call/result joining;
- progressively revealed overflow evidence, honest hidden notes, and omission rails that retain the surrounding card color while their text stays muted;
- completed-job failure actionability and the host spacer cycle `false,true,true,true`.

The gate protects user-facing meaning without freezing exact prose. codeweave-pi's focused
`tests/v3-core.test.mjs` still owns typed evidence projections; shell, web, and stow keep
their package tests. None alone substitutes for running the visual gallery.
