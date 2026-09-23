---
title: "draft-lift UI and shortcuts"
description: "Interactive comparison UI, enhancement shortcuts, rejection, retry, cancellation, and revert behavior."
tags: [draft-lift, ui, shortcuts, editor]
created: 2026-07-26
updated: 2026-07-26
status: active
owns: "Comparison UI, enhancement shortcuts, and revert behavior"
audience: contributor
related: [docs/architecture.md, docs/safety.md]
---

# UI behavior and shortcuts

## Running indicator

While the sidequest request is in flight, the extension displays:

```text
✦ Prompt sidequesting…
```

It sets both:

- a status bar entry using `ctx.ui.setStatus(...)`
- a small widget below the editor using `ctx.ui.setWidget(...)`

It also configures Pi’s working indicator APIs:

- `ctx.ui.setWorkingMessage(...)`
- `ctx.ui.setWorkingVisible(true)`
- `ctx.ui.setWorkingIndicator(...)`

The status and widget are used because direct side calls do not always show the same streaming loader as normal assistant responses.

All UI state is cleared in `finally`, so normal Pi UI state returns after success, skip, or error.

## Commands

| Command | Behavior |
| --- | --- |
| `/prompt-sidequest` | Enhance current editor text. |
| `/prompt-sidequest <draft>` | Enhance explicit draft text. |
| `/prompt-sidequest log` | Show backlog path. |
| `/prompt-sidequest backlog` | Show backlog path. |
| `/prompt-sidequest diag` | Show session/context counts and backlog path. |
| `/prompt-sidequest cache-diag` | Run the sidequest path and show token/cache usage. |

The revert and stale-editor guards behind these commands live in `extensions/draft-lift/docs/safety.md:safety-behavior/safe-editor-replacement#2`.

## Shortcuts

| Shortcut | Behavior |
| --- | --- |
| `ctrl+alt+e` | Quick sidequest current editor text. |
| `ctrl+shift+e` | Sidequest with comparison dialog. |
| `ctrl+shift+q` | Alternate quick sidequest. |
| `ctrl+shift+z` | Revert editor to the previous original text. |

## Comparison dialog

`ctrl+shift+e` opens a comparison overlay with the original draft and enhanced draft.

Actions:

| Key | Action |
| --- | --- |
| `Enter` / `A` | Accept enhanced draft. |
| `R` | Reject and restore original draft. |
| `E` | Run enhancement again using the enhanced draft as the next draft. |
| `Esc` | Cancel. |

The dialog guards narrow terminal widths to avoid negative padding crashes.

## Why no `ctrl+e`

`ctrl+e` is intentionally not registered. In some terminal setups, Command+Right sends the Ctrl-E byte sequence for end-of-line. Binding `ctrl+e` caused accidental sidequest triggers during ordinary cursor movement.
