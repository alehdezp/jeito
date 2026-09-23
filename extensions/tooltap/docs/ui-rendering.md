---
title: "tooltap one-control UI rendering"
description: "UI-only density, frame, color, and width contract for the public tools control."
tags: [tooltap, tools, ui-rendering, tui]
created: 2026-07-26
updated: 2026-08-24
status: active
owns: "tools call/result UI rendering contract for tooltap"
audience: contributor
related: [contract.md, adr/0010-configured-cache-safe-routing.md]
---

# One-control UI rendering

This is UI-only. `extensions/index.ts` registers `tools` with `renderShell: "self"`; renderer edits must not change routing, enablement, gateway permission, selector policy, or execution.

## What it does

The renderer uses the jeito visual family:

- open-right rounded frame (`╭──`, `│`, `╰──`);
- shared `Symbol.for("pi.agent.jeitoDensity.v1")` density read live on every render;
- `ultra` footer-only, `normal` 30-line, and `extended` 120-line budgets;
- colored frame/title/accent and success/warning/error status icons;
- enablement labels such as `tools +N` and execution labels such as `tools → exact_name`;
- ANSI-safe width clamping and truncation.

## Code map

In `extensions/index.ts`:

- `UI_MAX_LINES`, `UI_EXTENDED_LINES`, shared density symbol/state, and ANSI constants own budgets and colors.
- `TextBlock` renders the call header; `StowDensityBlock` reads density live for results.
- `normalizeUiControls`, `uiWidth`, `truncateUiAnsi`, and `clampUi` own terminal-safe width handling.
- `frameTop`, `frameBottom`, and `frame` are the only frame primitives.
- `renderToolsCall` distinguishes enablement from gateway execution using the presence of `arguments`.
- `renderToolsResult` preserves underlying result text/content and labels enablement or exact execution.
- `registerToolsControl` attaches `renderShell: "self"` and both renderers.

## Failures to avoid

- Baking density at component construction; the same live card must cycle without recreation.
- Adding blank lines outside the frame owner.
- Collapsing normal density to ultra or exceeding 30/120-line budgets.
- Stripping or splitting ANSI escape sequences while truncating.
- Hiding the exact target of a gateway execution.
- Teaching internal route vocabulary or historical public names in cards.
- Mutating execution results solely for rendering.

## Verification

Run `npm run typecheck` and `npm test` from the package directory. The focused harness checks ANSI-bearing call/result output at widths that preserve the asserted label. Reload Pi before judging live UI; cycle `Ctrl+U` on the same `tools` result and confirm ultra → normal → extended → ultra.
