---
title: "draft-lift editor and shortcut safety"
description: "Guards against stale editor replacement, duplicate requests, recursive prompts, shortcut conflicts, and logging failures."
tags: [draft-lift, safety, editor, shortcuts]
created: 2026-07-26
updated: 2026-07-26
status: active
owns: "Editor replacement, duplicate request, and shortcut safety guards"
audience: contributor
related: [docs/architecture.md, docs/ui-shortcuts.md]
---

# Safety behavior

`draft-lift` includes several guards to avoid accidental editor mutation, recursive requests, and terminal shortcut surprises.

## Safe editor replacement

The extension captures the editor text before the async sidequest request starts.

This protects the asynchronous side-request flow described in `extensions/draft-lift/docs/architecture.md:architecture-and-request-flow/high-level-flow#2`, where the editor may change between capture and response.

When the response returns, it replaces the editor only if the current editor text still matches the captured original draft. If you typed or pasted something while the request was running, replacement is skipped and the extension reports:

```text
Editor changed; skipped replacement
```

This prevents stale async results from overwriting newer user edits.

## Duplicate draft cooldown

The extension tracks recent attempts by session and draft hash. Repeating the same draft in the same session within the cooldown window is skipped.

Current cooldown:

```ts
const RECENT_ENHANCE_COOLDOWN_MS = 10_000;
```

Backlog skip reason:

```text
duplicate_draft_cooldown
```

This helps prevent accidental double-triggering and makes cache tests easier to interpret.

## Recursive prompt guard

The extension refuses drafts that look like the wrapper prompt used by the sidequest itself, including drafts starting with:

```text
Enhance this prompt draft using the full conversation context above.
```

or:

```text
Draft to enhance:
```

Backlog skip reason:

```text
recursive_enhancer_prompt
```

This prevents draft-lift from sidequesting its own sidequest wrapper.

## No `ctrl+e`

The extension does not bind `ctrl+e`.

Reason: some terminals send Ctrl-E for unrelated editor/navigation actions such as Command+Right/end-of-line. Binding it caused accidental prompt enhancement.

Use `ctrl+alt+e`, `ctrl+shift+e`, or `ctrl+shift+q` instead.

## Logging must not break enhancement

Backlog writes are wrapped in a best-effort helper. If logging fails, prompt enhancement continues.

## Privacy-preserving logs

The extension logs hashes/counts/metadata only. It does not write conversation text or draft text into backlog files.

Runtime diagnostics live outside the installed extension:

```text
<PI_CODING_AGENT_DIR>/draft-lift/backlog.jsonl
```

Treat the backlog as private host state and delete it after cache/parity investigations.
