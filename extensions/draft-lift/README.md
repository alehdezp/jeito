---
title: "draft-lift: review the request before sending it"
description: "Rewrite a Pi editor draft using the current conversation, compare the candidate and keep rejected revisions out of the task history."
tags: [jeito, draft-lift, editor, prompt-enhancement]
created: 2026-07-26
status: experimental
owns: "The approachable draft-lift package entrypoint"
audience: mixed
related: [docs/architecture.md, docs/decisions.md, docs/cache-parity.md]
updated: "2026-09-23 13Z"
---

# draft-lift

![draft-lift banner: rewrite the draft outside the task, compare it with the original, then decide whether to send.](docs/images/v2-banner.svg)

A request to the coding agent often relies on decisions made earlier in the conversation. Asking the agent to help phrase that request puts rejected drafts and corrections into the same history it will use to perform the work. Writing in a separate app avoids that clutter but loses the context behind the request.

draft-lift uses the conversation as input to a separate rewriting exchange. You can compare its candidate with your original, give feedback and return a chosen version to the Pi editor **without sending it**. Rejected versions stay out of the working conversation. Only your subsequent submission assigns the work.

The hard part is deciding what the rewrite may add. Its instruction asks the model to trace additions to the draft or accepted intent, replace only what later corrections contradict and leave uncertain requirements out. It also asks for a focused question when one missing fact changes safe execution. Those instructions cannot prove the model understood you: the side-by-side comparison is where you catch changed meaning or an inflated assignment. A clear short request needs no extra model call.

## Review, replace and recover

`Ctrl+Shift+E` opens the comparison view. Feedback followed by `Enter` requests another version; an empty feedback field accepts a ready candidate, and `Esc` cancels when that field has focus. `/prompt-sidequest`, `Ctrl+Alt+E`, and `Ctrl+Shift+Q` instead rewrite the current draft directly into the editor; `/prompt-sidequest <draft>` uses explicit text. `Ctrl+Shift+Z` restores the saved original once, not an undo history.

Direct shortcuts and the command without arguments check whether the editor still matches the draft they started from (ignoring whitespace at the ends). If it changed while the request ran, they leave it alone and attempt to copy the candidate to the clipboard. The command with explicit text and accepting from the comparison view **do not** check for newer edits before replacing the editor; review that boundary when editing concurrently. Repeating an identical draft within ten seconds is skipped with a cooldown notice; changing the draft is unaffected.

Pi supplies the model, provider connection and prepared conversation. draft-lift adds the rewrite instruction and review interface. The request includes the main system prompt and active tool definitions but has no tool-execution loop; the rewriter cannot inspect files to settle facts outside the conversation. Its instruction forbids tool use. If a response is empty despite that instruction, the extension retries once without tool definitions and reports failure if the retry is also empty. Including the main prompt and tools is intended to leave room for prompt-cache reuse, **not evidence of an actual cache hit**. See [cache verification](docs/cache-parity.md).

## Privacy and limits

Diagnostics at `<PI_CODING_AGENT_DIR>/draft-lift/backlog.jsonl` record hashes, counts, usage and metadata rather than draft or conversation text. Session identifiers and paths still appear, and provider error messages can contain unredacted text. Keep the file private. `/prompt-sidequest log` reports its path; `cache-diag` makes a model request and can replace the editor contents.

The extension attempts to copy originals and some cancelled or unapplied rewrites to the clipboard with `pbcopy` on macOS, or `xclip`, `xsel`, then `wl-copy` elsewhere. Missing utilities fail silently, so clipboard recovery is not guaranteed. Each refinement costs a model call and review time. No test establishes faithful meaning, fewer downstream corrections or provider cache reuse.

## Install from a checkout

Requires Node.js 22.19.0 or newer, npm, and an interactive Pi session with a configured model/provider. The package declares Pi coding-agent, ai and tui 0.82.1 or newer; this is not a tested compatibility matrix.

From the repository checkout, prepare dependencies:

```bash
cd /absolute/path/to/jeito
npm install --omit=dev \
  --workspace @alehdezp/draft-lift \
  --include-workspace-root=false
```

Only after npm succeeds, register the prepared checkout:

```bash
pi install "$PWD/extensions/draft-lift"
```

Restart Pi. The jeito aggregate already includes draft-lift; do not register both copies. Standalone installation does not apply host-owned prompt or tool defaults. See [installation and updates](../../docs/getting-started.md#install-one-extension-from-a-checkout). No public standalone release is assumed.

## Verification and provenance

```bash
npm run check --workspace @alehdezp/draft-lift
npm run test --workspace @alehdezp/draft-lift
```

The focused tests check provider selection, command and shortcut registration, the rewrite instruction and feedback wording. They do not test the on-screen editor or whether a particular candidate preserves meaning. [`buildEnhancementInstruction` in `index.ts`](index.ts) defines the instruction; [architecture](docs/architecture.md), [decisions](docs/decisions.md) and [cache verification](docs/cache-parity.md) explain the boundaries. ADR-006 credits promptsmith's output-marker pattern. The [package manifest](package.json) declares MIT.
