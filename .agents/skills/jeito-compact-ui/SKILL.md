---
name: jeito-compact-ui
description: >-
  Implement the standardized always-visible compact highly-informative Pi tool
  UI (ultra/normal/extended density, open-right frames, theme-aware chrome, Nerd
  Font icons, width-safe ANSI) in any jeito extension — with Ctrl+U as the
  own jeito density toggle (Ctrl+O stays native Pi).
disable-model-invocation: true
---

# jeito Compact UI — standardized tool-output rendering

Use this skill when adding or upgrading tool-output rendering in any `jeito` extension so it matches the reference implementation used by `extensions/shell` (`@alehdezp/jeito-shell`) and `extensions/codeweave-pi` (`@alehdezp/codeweave-pi`).

The standard is: **always-visible, compact, highly informative.** Ultra-compact is the live default and never hides signal — it keeps colored call/result chrome, status, counts, hashes, and compact diagnostic reasons while hiding only body rows. Normal and extended reveal progressively more of the same typed evidence. The global jeito density cycle is `ultra → normal → extended → ultra` on **`Ctrl+U`** — our own shortcut via `pi.registerShortcut("ctrl+u")` that cycles `Symbol.for("pi.agent.jeitoDensity.v1")`. **`Ctrl+O` (`app.tools.expand`) stays native Pi** for built-in tool expansion and is ignored by every jeito renderer.

The host `~/.pi/agent/keybindings.json` keeps `app.tools.expand: ["ctrl+o"]` native; `app.tree.filter.*` bindings are cleared to keep `Ctrl+U` solely for jeito density.

## 1. Reference owners — read these before editing

- `extensions/codeweave-pi/docs/ui-rendering.md` — rendering-only contract (frames, density phases, model/TUI boundary, color decisions, verification).
- `extensions/codeweave-pi/src/core/tui-render.ts` — canonical implementation for 11+ tools (owns `JEITO_DENSITY_KEY`, `currentDensity()`/`cycleDensity()`, Ctrl+U shortcut, frames, width-safe ANSI).
- `extensions/shell/index.ts` (lines 16–230) — sibling reference for `bash`/`jobs` (LeanCTX routing, completion cards, same own density).
- `extensions/shell/index.test.mjs` — density via `cycleDensity()`, narrow-pane ANSI/emoji regression, border/status coverage.
- `~/.pi/agent/keybindings.json` — host-owned (`app.tools.expand` stays `ctrl+o`; `app.tree.filter.*: []`; `Ctrl+U` is NOT a keybindings.json entry — it is an extension `registerShortcut`).

Do not redefine tool semantics, navigation policy, or mutation authority while doing UI work. Rendering is display-only.

## 2. What the standard guarantees

- **Always visible:** every tool call shows a colored top frame (`╭── <tool> <detail> ──`) immediately; every result shows a colored bottom frame (`╰── <status> <label> ──`) even in ultra. No tool is ever a blank gap.
- **Compact by default:** ultra shows only chrome + footer. Footer still carries tool-family border color, detected Nerd Font icon, `✓/✗/◐/⚠/…` status, line/hash/coverage counts, and one compact warning/error reason when present. Body rows are hidden only in the TUI (`currentDensity()==="ultra" ? [] : lines`); model-facing `content[].text` is unchanged.
- **Highly informative:** label synthesizes typed `details`/`native` fields (counts, hashes, coverage, generation, page/omission, exception totals, page windows) — never regex-parsed from model text. Typed evidence owns hierarchy/status/omissions/authority.
- **Consistent chrome:** open-right rounded frames, per-tool ANSI border colors, semantic `Theme.fg`/`Theme.bold` for title/accent/status, per-line `│` rail, width-clamped to `ctx.width`/`opt.width` with ANSI kept intact.
- **Density is global, own, and synchronized:** all extensions read `Symbol.for("pi.agent.jeitoDensity.v1")` via `currentDensity()`. One `Ctrl+U` press does `cycleDensity()` in the owner extension (codeweave-pi) and then invalidates every live jeito component — startup is ignored for the density, so only our shortcut drives it.
- **Narrow-safe:** every line through `visibleWidth`/`truncateToWidth` from `@earendil-works/pi-tui`; truncation keeps complete ANSI SGR sequences.

## 3. Dependencies

```json
{
  "dependencies": {
    "@earendil-works/pi-tui": "0.82.1"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.82.1"
  }
}
```

`@earendil-works/pi-tui` provides `visibleWidth`, `truncateToWidth`. Never reimplement `charWidth` locally — prior bug `⌚ U+231A` counted as 1 vs Pi 2.

## 4. Configuration

### 4.1 Host keybinding — DO NOT change `app.tools.expand`

`~/.pi/agent/keybindings.json` must keep native binding and disable tree filters that clash with `ctrl+u`:

```json
{
  "app.tools.expand": ["ctrl+o"],
  "app.tree.filter.userOnly": [],
  "app.tree.filter.noTools": [],
  "app.tree.filter.default": [],
  "app.tree.filter.labeledOnly": [],
  "app.tree.filter.all": [],
  "app.tree.filter.cycleForward": [],
  "app.tree.filter.cycleBackward": [],
  "app.model.select": ["ctrl+l", "ctrl+n"],
  "app.thinking.cycle": ["shift+tab", "ctrl+shift+t"],
  "app.thinking.toggle": ["ctrl+r"],
  "tui.input.newLine": ["ctrl+j", "shift+enter"]
}
```

**Do NOT add `ctrl+u` to `keybindings.json`.** `Ctrl+U` is an `ExtensionAPI.registerShortcut("ctrl+u")` — see §5. It wins with a conflict warning over `app.tree.filter.userOnly` (`ctrl+u`) because that binding is not `restrictOverride`; after clearing filters above, no warning occurs.

### 4.2 Own shortcut — `Ctrl+U` cycles jeito density

One owner (codeweave-pi) registers:

```ts
import { cycleDensity } from "./src/core/tui-render.ts";
// in create of the codeweave-pi extension (see §5 template):
pi.registerShortcut("ctrl+u", {
  description: "Cycle jeito density ultra → normal → extended",
  handler: async (ctx) => {
    const d = cycleDensity();
    ctx.ui.notify(`jeito density: ${d}`, "info");
    // invalidate every live tool component so re-render picks new density
    // — see §5 template for registry + forEach invalidate + requestRender
  },
});
```

Other extensions (shell/websift/tooltap) import `currentDensity` only — they do NOT register another `ctrl+u`.

### 4.3 Hints

Every renderer hint says `Ctrl+U`:

- `EXPAND_HINT = " • Ctrl+U to cycle view"` and every `… hidden; Ctrl+U to cycle view`.

### 4.4 Nerd Font icons (frontend-only)

As before — `PI_NAV_NERD_FONT` override or Ghostty/Kitty/WezTerm check once, fail-closed.

## 5. Minimal renderer template — copy/paste

```ts
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth as tuiVisibleWidth, truncateToWidth as tuiTruncateToWidth } from "@earendil-works/pi-tui";

type ThemeLike = Pick<Theme, "fg" | "bold">;
type DisplayDensity = "ultra" | "normal" | "extended";
const DENSITY_LEVELS: DisplayDensity[] = ["ultra","normal","extended"];
const JEITO_DENSITY_KEY = Symbol.for("pi.agent.jeitoDensity.v1");
const JEITO_DENSITY_STATE: { level: number } = (() => {
  const g = globalThis as any; return (g[JEITO_DENSITY_KEY] ??= { level: 0 });
})();
export function currentDensity(): DisplayDensity { return DENSITY_LEVELS[JEITO_DENSITY_STATE.level] ?? "ultra"; }
export function cycleDensity(): DisplayDensity { JEITO_DENSITY_STATE.level = (JEITO_DENSITY_STATE.level+1)%DENSITY_LEVELS.length; return currentDensity(); }
export function resetDisplayDensityForTests(): void { JEITO_DENSITY_STATE.level = 0; }

// choiceful invalidation registry — all components register their invalidate
const LIVE_JEITO_INVALIDATORS = (() => {
  const g = globalThis as any;
  const K = Symbol.for("pi.agent.jeitoInvalidators.v1");
  return (g[K] ??= new Set<() => void>()) as Set<() => void>;
})();
export function registerjeitoInvalidator(fn: () => void): () => void { LIVE_JEITO_INVALIDATORS.add(fn); return () => LIVE_JEITO_INVALIDATORS.delete(fn); }
export function invalidateAlljeitoDensity(): void { for (const fn of [...LIVE_JEITO_INVALIDATORS]) try { fn(); } catch {} }
```

In your renderer: `framed()` reads `currentDensity()` directly (no `ctx.expanded`, no `DENSITY_BY_THEME`). In `renderCall`/`renderResult`, create a component object `{ invalidate() { /* re-derive from currentDensity and requestRender */ }, render(width) { … } }` and `registerjeitoInvalidator(() => component.invalidate())` on construction, removing on `dispose`. The `Ctrl+U` handler above calls `cycleDensity()` then `invalidateAlljeitoDensity()`.

(codeweave-pi keeps the invalidation wiring for all its 11 tools centrally; websift/shell/tooltap each keep one in their `TuiRender` module — see those files for the exact pattern.)

## 6. Highly informative — what the footer must carry

Same as before — derived from typed `details`.

## 7. What NOT to do

- Do NOT bind `Ctrl+U` via `keybindings.json` or remap `app.tools.expand`.
- Do NOT derive density from `ctx.expanded`/`options.expanded` or `DENSITY_BY_THEME` — our cycle is own state.
- Do NOT register `ctrl+u` in more than one extension — one owner (codeweave-pi).

## 8. Validation

```bash
cd extensions/<name> && npm run typecheck && npm test
# owned code must say Ctrl+U only:
grep -rn "Ctrl+O" --include="*.ts" --include="*.md" extensions/<name> | grep -v node_modules  # expect 0 in owned jeito code
grep -rn 'Symbol.for("pi.agent.jeitoDensity' extensions/codeweave-pi extensions/shell extensions/websift extensions/tooltap
```

Live: `/reload` then press `Ctrl+O` — only built-in Pi output toggles. Press `Ctrl+U` — all jeito panes advance `ultra→normal(30)→extended(120)→ultra` coordinately.
