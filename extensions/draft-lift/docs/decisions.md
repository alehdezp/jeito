---
title: "draft-lift Architecture Decision Records"
description: "Every consequential design decision in draft-lift, its rationale, alternatives rejected, and revisit conditions."
tags: [draft-lift, adr, architecture, decisions]
created: 2026-07-27
updated: 2026-08-28
status: active
---

# draft-lift — Architecture Decision Records

## ADR-001: Dedicated enhancer system prompt (not the agent system prompt)

**Date:** 2026-07-27  
**Status:** Superseded by ADR-026

**Code:** `index.ts` `enhancementOverlay` → `systemPrompt` variable

### Context

The original implementation passed `ctx.getSystemPrompt()` — the full 595-line agent identity (APPEND_SYSTEM.md) — as the system prompt for the enhancement side request. Weak models (e.g. MiniMax-M3, Qwen) saw the massive coding-agent identity and pattern-matched to "answer this draft as a coding agent" instead of "rewrite this draft." Strong models (GPT, Claude) overcame the framing, which masked the problem.

### Decision

Use a dedicated ~25-line system prompt that establishes the enhancer role: "You are an expert prompt rewriter." The conversation context still flows through the message history, so the enhancer can still infer context from the session. The full agent system prompt is never sent.

### Consequences

- **Cache parity lost.** The enhancer prefix differs from the main conversation prefix. Cache reuse is provider-observed, not guaranteed. This was never proven anyway (ADR-008).
- **Cross-model reliability gained.** Weak models stop answering the draft and start rewriting it.
- **Quality maintained.** The dedicated prompt carries full improvement guidance and mentality principles (ADR-005).

### Alternatives rejected

- Keep `ctx.getSystemPrompt()` and fight the framing with stronger user-message instructions. Rejected: the system prompt is the dominant identity signal for weak models. No user-message framing overcomes a 595-line system prompt.
- Send both the agent system prompt and a separate "ignore the above, you are now a rewriter" instruction. Rejected: brittle, model-dependent, and wastes tokens.

### Revisit when

A Pi API exposes a way to run a side request with a different system prompt while keeping the original conversation prefix for cache reuse. At that point, re-evaluate whether sending the agent system prompt is worth the cache hit.

---

## ADR-002: `streamSimple` instead of `completeSimple`

**Date:** 2026-07-27  
**Status:** Accepted  
**Code:** `index.ts` `enhancementOverlay` → `runStream`; both request paths route through `index.ts::resolveStreamFn`

### Context

`completeSimple` is single-shot: no streaming events. The user had no feedback during the enhancement wait. The overlay appeared only after the full response returned.

### Decision

Switch the `ctrl+shift+e` comparison path to `streamSimple`, which returns an `AssistantMessageEventStream` (async iterable). This enables:
- Live thinking display (`thinking_delta` events)
- Live candidate preview (`text_delta` events)
- Immediate overlay display (overlay shows "connecting…" before first token)
- Steering: user can type feedback while the model thinks

The direct shortcuts (`ctrl+alt+e`, `ctrl+shift+q`) use the same stream function through `doEnhance`, awaiting `.result()` without streaming UI.

### Consequences

- Better UX: user sees progress immediately.
- Steering becomes possible (ADR-003).
- Slightly more complex error handling (stream errors vs completion errors).
- Stream selection must respect extension-registered providers: the pi-ai compat registry only knows builtin apis, so the request routes through `index.ts::resolveStreamFn` (see `extensions/draft-lift/docs/architecture.md:architecture-and-request-flow/provider-stream-resolution#2`).

### Alternatives rejected

- Keep `completeSimple` with a static spinner. Rejected: no feedback during a multi-second wait is a poor UX.

### Revisit when

Never — streaming is strictly better for interactive enhancement.

---

## ADR-003: Queue feedback during working state (steering)

**Date:** 2026-07-27  
**Status:** Accepted  
**Code:** `index.ts` `enhancementOverlay` → `handleInput` (working state)

### Context

The user could only send feedback after the enhancement completed. If the model was taking 10 seconds to think, the user had to wait, then type feedback, then wait again.

### Decision

During the working state, Enter queues the feedback into `feedbackHistory` as `delivered: false`. The user can queue multiple messages. When the stream completes:
- If pending feedback exists, it is automatically combined and sent as the next refinement round.
- The feedback entries are marked `delivered: true` in the UI.

The overlay shows queued feedback immediately in the left column with a `⏳` icon (pending) or `✓` icon (delivered).

### Consequences

- User can steer mid-flight without waiting.
- Multiple feedback messages are batched into one refinement round.
- Feedback history is visually tracked so the user knows what was applied.

### Alternatives rejected

- Abort the current stream when Enter is pressed and restart. Rejected: wastes a partially-complete response.
- Only allow feedback in comparing state. Rejected: the user's original complaint.

### Revisit when

If models start supporting true mid-stream injection (modifying the active generation), this could become real-time steering instead of post-completion refinement.

---

## ADR-004: No tools in the enhancer call

**Date:** 2026-07-27  
**Status:** Superseded by ADR-026
**Code:** Historical; current tool-schema decision is `index.ts::buildEnhancementInstruction`, `runStream`, and `doEnhance`

### Context

The original implementation sent the active tool schemas (`pi.getAllTools()`) for cache-field parity. But `completeSimple`/`streamSimple` has no tool execution loop. A model that responds with a `tool_use` block produces no text, which appears as empty output — a silent failure.

### Decision

Send no tools. A prompt rewriter needs no tools. This eliminates the tool-call-only response failure mode entirely.

ADR-026 later restored active tool schemas for provider cache parity while retaining a no-tool-use instruction and explicit tool-call failure handling. The enhancer still must not use tools; the transport shape changed.

### Consequences

- No tool-call-only empty output failures.
- Cache parity slightly reduced (tool hash differs from main turn).
- The enhancer cannot read files or inspect state. This is fine — it's rewriting text, not acting on the project.

### Alternatives rejected

- Keep tools and add a bounded tool loop. Rejected (ADR-009 analysis): a prompt rewrite needs no tools, and a loop adds complexity without quality improvement.

### Revisit when

If a use case emerges where the enhancer needs to inspect the project to produce a better rewrite (e.g. "rewrite this prompt to reference the actual file structure"), add a read-only allowlist with a strict one-round limit.

---

## ADR-005: Accepted intent boundary allows safe prompt expansion

**Date:** 2026-07-27  
**Status:** Accepted  
**Amended:** 2026-08-12
**Code:** `index.ts::buildEnhancementInstruction`

### Context

The first system prompt iteration instructed the model to "replace vague questions with concrete, observable deliverables" and gave an explicit example: *"What do you know about this project? becomes a structured survey with defined dimensions."* This caused the enhancer to reinvent the user's request — turning a simple question into a formal audit specification. The user's actual intent was buried.

### Decision

Preserve accepted user intent while allowing useful refinement inside that fixed boundary. The enhancer reads the recent exchange around the draft—not isolated statements—to understand what the user is answering, correcting, accepting, rejecting, modifying, or referring to. Assistant replies provide this conversational context but never become intent without user acceptance. Recent user statements normally carry the current objective or preference; older active commitments survive until contradicted or abandoned.

An intent-bearing addition—goal, scope, preference, constraint, or deliverable—must trace to the draft or directly applicable accepted user intent. Non-intent additions may improve organization, restore applicable context, or add proportionate execution guidance only when they improve understanding or prevent a predictable error without changing the outcome or becoming separate work. This distinction avoids both reinvention and the opposite failure of preserving messy drafts too literally.

The runtime instruction applies the skill-master method without exposing its authoring jargon: state the request first, keep constraints near the governed action, adapt organization to the task only when useful, clarify one execution-critical unknown, inspect additions before output, and stop when further detail becomes ceremony. For code work, proportional verification means the smallest focused check that verifies the behavior—not an invented broad test program.

For exact `gpt-5.6-sol`, private generation guidance strengthens the same boundary at the rewrite action site. It prevents deliverable displacement, ungrounded specification growth, broad proof programs, supporting-artifact takeover, and repeated self-review. The suffix is never intended for the downstream agent or rewritten prompt; exact model gating occurs at both `buildEnhancementInstruction(...)` call sites.

### Consequences

- Conversation context can resolve accepted proposals, references, corrections, contrasts, and preferences without promoting assistant text into user intent.
- The enhancer may expand a draft to improve the same outcome; minimal editing is not a goal.
- New goals, scope, preferences, constraints, and deliverables remain prohibited unless grounded in accepted user intent.
- Task guidance is allowed when proportionate and protective, but speculative workflows, exhaustive testing, benchmarks, documentation, and adjacent work cannot become automatic requirements.
- Revision feedback applies as a constrained delta while preserving unaffected commitments.

### Evidence

The public rationale is materialized in this ADR, [`architecture.md`](architecture.md), and the exact runtime instructions in [`index.ts`](../index.ts). The rejected prior iteration below is the concrete drift evidence: unsupported specificity displaced accepted intent. It does not imply that every useful addition is intent, so the extension rejects inferred commitments while allowing proportionate guidance that improves the same outcome without creating separate work.

### Alternatives rejected

- "Enhance to be clearer, more specific, more actionable" (the original). Rejected: too vague, invites reinvention.
- "Replace vague questions with concrete deliverables" (a prior iteration). Rejected: actively caused the reinvention problem.

### Revisit when

Revisit when normal use reveals a concrete class of drift, under-refinement, or task-specific guidance that repeatedly misleads the downstream agent. Do not tighten or loosen the contract from isolated preference alone.

---

## ADR-006: `[[REWRITE]]` sentinel markers

**Date:** 2026-07-27  
**Status:** Accepted  
**Code:** `index.ts` `extractSentinel` + system prompt output rule

### Context

Weak models wrap their rewrite in commentary: "Here is the enhanced prompt:", "I improved it by...", rationale, notes. The user gets preamble instead of just the rewrite.

### Decision

The system prompt demands the rewrite be wrapped in `[[REWRITE]]` and `[[/REWRITE]]` markers, with nothing before or after. The parser extracts the content between markers. If no markers are found, it falls back to the raw text (graceful degradation for models that ignore the instruction).

### Consequences

- When the model follows the instruction: clean output, no commentary.
- When the model ignores it: the raw text is used, which may contain commentary but is still usable.
- Pattern borrowed from promptsmith's `<promptsmith-enhanced-prompt>` sentinel approach.

### Alternatives rejected

- No sentinel, just "output only the rewritten text." Rejected: weak models ignore this.
- XML tags (`<rewrite>`). Rejected: can conflict with XML in the draft content. `[[REWRITE]]` is unlikely to appear in real prompts.

### Revisit when

If models universally stop ignoring the instruction and the sentinel adds parsing complexity, remove it. Currently it helps enough to keep.

---

## ADR-007: Bottom-anchored overlay (not floating center)

**Date:** 2026-07-27  
**Status:** Accepted  
**Code:** `index.ts` `overlayOptions: { anchor: "bottom-center", margin: 0 }`

### Context

A centered overlay floated in the middle of the terminal, blocking the conversation history. The user couldn't scroll and inspect code above while the overlay was open.

### Decision

Anchor the overlay to the bottom of the terminal (`anchor: "bottom-center"`, `margin: 0`), occupying at most 60% of terminal height. This leaves the top portion visible for scrolling and code inspection.

### Consequences

- Code above is visible while the overlay is open.
- The overlay sits where the prompt input normally lives — natural placement.
- The overlay does not float or block conversation history.

### Alternatives rejected

- Centered overlay. Rejected: blocks conversation history.
- Full-screen takeover. Rejected: prevents code inspection entirely.

### Revisit when

Pi adds a true sidebar/split-pane API. A sidebar would be even better for this use case.

---

## ADR-008: Cache parity is provider-observed, not guaranteed

**Date:** 2026-07-27  
**Status:** Accepted; transport shape superseded by ADR-026

**Code:** `index.ts` cache status display from `event.message.usage.cacheRead`

### Context

The extension retains provider-payload mirroring to improve cache reuse, but matching prompt shape alone cannot prove that a provider read cached tokens. ADR-026 restored the main system prompt, active tool schemas, conversation history, and final uncached enhancer instruction as the cache-compatible request shape.

### Decision

Treat cache reuse as provider-observed, not guaranteed. The overlay reports the actual cache status (`cache HIT` / `cache MISS`) from the completed response's `usage.cacheRead`; no cache claim is made without provider evidence. ADR-026 owns the current transport shape.

### Consequences

- Matching the main system prompt, active tools, and conversation prefix improves cache eligibility but does not prove a cache read.
- The overlay reports provider evidence instead of inferring success from request shape.
- Cache efficiency remains useful but is not an architectural dependency.

### Alternatives rejected

- Treat matching payload fields as proof of reuse. Rejected: only the provider's completed usage record establishes `cacheRead`.

### Revisit when

The provider usage contract changes or no longer exposes cache-read evidence.

---

## ADR-009: Refinement feedback wraps with anti-commentary instruction

**Date:** 2026-07-27  
**Status:** Accepted  
**Code:** `index.ts` `runStream` → feedback instruction

### Context

On refinement rounds, models often prepend commentary: "Here is the corrected prompt based on your feedback:"

### Decision

The refinement instruction explicitly states: *"Apply the feedback, then output ONLY the corrected rewrite inside the markers. Do NOT say 'here is the corrected prompt' or explain what you changed."*

### Consequences

- Cleaner refinement output.
- The anti-commentary reminder is only on the feedback path (where the risk is highest), not the initial path.

### Alternatives rejected

- Put the anti-commentary rule only in the system prompt. Rejected: on refinement, the model sees a long feedback instruction that can dilute the system prompt's output rule.

### Revisit when

Never — the cost is one extra line in the feedback instruction.

---

## ADR-010: Clipboard safety net

**Date:** 2026-07-27  
**Status:** Accepted  
**Code:** `index.ts` `saveToClipboard`

### Context

Enhancement failures or stale-editor conflicts could lose the draft text. The user had no recovery path.

### Decision

- Save the original draft to the system clipboard before every enhancement attempt.
- On cancel, save the latest candidate to the clipboard.
- On stale-editor conflict, save the enhancement result to the clipboard.
- Clipboard operations are best-effort and silent on failure — a safety net, not a feature.

### Consequences

- The user never loses their text to a failure.
- Works on macOS (`pbcopy`) and Linux (`xclip`/`xsel`/`wl-copy`).

### Revisit when

Never — the cost is a few lines and the safety is high value.

---

## ADR-011: Template system with `*name` prefix and `{{input}}` placeholder

**Date:** 2026-07-27  
**Status:** Accepted  
**Code:** `index.ts` `extractTemplate`, `applyTemplate`, autocomplete provider

### Context

The user wanted optional prompt-enhancement templates (review, debug, plan) without a mandatory picker or modal.

### Decision

Templates live at `~/.pi/agent/draft-lift/templates/*.md`. Typing `*name <draft>` at the start of the editor triggers the template. The `{{input}}` placeholder in the template file controls where the user's draft appears (before, middle, after). No `*name` prefix = default enhancement (zero-config). Autocomplete shows available templates when `*` is typed.

### Consequences

- Zero-config default: the shortcut works without any template.
- Templates are user-authored markdown files — no config format, no schema.
- The `*` autocomplete follows the proven `$skill` inline-skills pattern (`davidgasquez/dotfiles`).

### Alternatives rejected

- Command palette / fuzzy picker. Rejected: adds ceremony to a low-friction shortcut.
- Command arguments (`/prompt-sidequest --template review`). Rejected: verbose.

### Revisit when

If template complexity grows (variables, includes, conditionals), evaluate a richer format. Currently one file = one template is sufficient.

---

## ADR-012: Works at startup with no conversation

**Date:** 2026-07-27  
**Status:** Accepted  
**Code:** `index.ts` — empty-conversation guard removed

### Context

The original code rejected empty conversations: "No conversation context. Send a message first." This prevented using the enhancer as a first-prompt improver.

### Decision

Remove the guard. With no conversation, `resolvedMessages` is `[]`, and the enhancer receives only system prompt + draft. The system prompt alone carries project context (AGENTS.md, file listings), so the enhancer is not context-poor.

### Consequences

- The enhancer can improve the very first prompt in a session.
- Quality may be lower without conversation context (best-effort, as documented).

### Revisit when

Never — enabling is strictly better than disabling.

---

## ADR-013: Scrollable content with arrow keys and j/k guard

**Date:** 2026-07-27  
**Status:** Accepted  
**Code:** `index.ts` `scrollOffset`, `scrollMode`, `j`/`k`/`Key.up`/`Key.down` handlers

### Context

Large original drafts or candidates could overflow the overlay, hiding the feedback input and footer. An initial j/k-only approach prevented the user from typing those letters.

### Decision

Content area is capped to ~half the terminal height. Scrolling uses three mechanisms:
- **Arrow Up/Down**: always scroll in comparing state (no text-input conflict since the Input is single-line with horizontal-only movement)
- **j/k**: scroll only when the feedback input is blank OR the user entered scroll mode via arrow keys
- **Scroll mode**: pressing arrow keys sets `scrollMode = true`; typing any letter (`a-z`) exits it and falls through to the input

A scroll indicator shows position (`↑↓ j/k scroll  1-10/25`). The feedback input and footer are always visible.

### Consequences

- The user can always see the input and footer.
- Large candidates can be reviewed before accepting.
- j/k type normally when the input has text — no key conflicts.

### Alternatives rejected

- j/k always scroll in comparing state. Rejected: user couldn't type those letters.
- PageUp/PageDown. Rejected: may conflict with Pi's own keybindings.
- Mouse wheel. Rejected: not universally supported in terminals.

## ADR-014: Dynamic footer legend with clipboard-save notice

**Date:** 2026-07-27  
**Status:** Accepted  
**Code:** `index.ts` render → help row

### Context

A static footer saying "[Enter] Accept/Send [F] Accept [Esc] Cancel" was confusing: Enter does different things depending on state, and F conflicts with typing. Additionally, the user did not know Esc saves the candidate to the clipboard.

### Decision

The footer legend changes dynamically based on state and input content, always in dim/gray:
- Working + empty input: `type to steer  [Esc] cancel · saves`
- Working + text in input: `[Enter] queue  [⇧+Enter] newline  [Esc] cancel · saves`
- Comparing + empty input: `[Enter] accept  [↑↓] scroll  [Esc] cancel · saves`
- Comparing + text in input: `[Enter] refine  [⇧+Enter] newline  [Esc] cancel · saves`

The `F` key is removed entirely. The `· saves` suffix communicates that Esc copies the candidate to the clipboard before closing.

### Consequences

- The user always knows what Enter will do.
- No key conflicts (F removed, j/k guarded by ADR-013).
- Esc's clipboard-save behavior is surfaced in the legend.

### Alternatives rejected

- Keep F and intercept it before the input. Rejected: fragile and confusing.
- Separate "saves to clipboard" notification on Esc. Rejected: too much ceremony for a safety net.

### Revisit when

Never — dynamic legend is strictly clearer.

---

## ADR-015: Color policy — gray borders/legend/thinking, vibrant content

**Date:** 2026-07-27  
**Status:** Accepted  
**Code:** `index.ts` theme helpers (`b`, `a`, `d`, `s`, `w`, `e`, `tx`)

### Context

The initial overlay used dim for almost everything. The user requested more vibrant color while keeping borders, the footer legend, and the thinking content gray.

### Decision

Color assignments:
- **Borders** (`border`): all box-drawing characters stay gray
- **Footer legend** (`dim`): the help row stays gray
- **Thinking content** (`dim`): the live thinking stream stays gray — it's metadata, not content
- **Spinner/status** (`accent`): the status icon and "enhancing" text are accent-colored
- **Model name** (`text`): readable, not gray
- **Original draft** (`text`): readable, not gray
- **Candidate** (`text`): readable, not gray
- **Cache HIT** (`success`): green
- **Cache MISS** (`warning`): yellow/orange
- **Error state** (`error`): red
- **Column headers**: accent for "◆ original", dim for "◇ thinking", success for "◇ candidate"

### Consequences

- Visual hierarchy: gray = structural/metadata, colored = content/status
- Borders and legend recede; content and status pop
- Thinking is deliberately muted — it's transient reasoning, not the deliverable

### Revisit when

The user changes their aesthetic preference. The theme helpers are thin wrappers, so changing a color is a one-line edit.

---

## ADR-016: Feedback entries with background colors

**Date:** 2026-07-27  
**Status:** Accepted  
**Code:** `index.ts` render → `feedbackHistory` entries, `theme.bg("toolSuccessBg"|"toolPendingBg")`

### Context

Feedback entries used plain text icons (`✓` for delivered, `⏳` for pending). The user found them "ugly" and not visually distinct enough.

### Decision

Each feedback entry row gets a colored background:
- **Delivered** (sent to the enhancer): `toolSuccessBg` (green background) with `success` foreground and `▸` icon
- **Pending** (queued during working, not yet sent): `toolPendingBg` (yellow/orange background) with `warning` foreground and `▹` icon

The background fills the full column width (padding included), making each entry a visually distinct block.

### Consequences

- Delivered vs pending is instantly distinguishable by background color
- No reliance on Nerd Font glyphs for the primary visual signal

### Alternatives rejected

- Nerd Font icons (nf-cod-check, nf-cod-sync). Rejected: glyph availability is terminal-dependent; background color is universal.
- Different border styles per entry. Rejected: adds complexity without adding clarity.

### Revisit when

The user wants icons added on top of the background colors. The icons (`▸`/`▹`) are placeholders that can be swapped without restructuring.

---

## ADR-017: Multi-line feedback via Editor component

**Date:** 2026-07-27  
**Status:** Accepted (supersedes the feedbackExtraLines + Input approach)  
**Code:** `index.ts` `feedbackEditor: Editor`, `disableSubmit`, `isShiftEnter()`

### Context

The initial approach used `Input` (single-line) with a `feedbackExtraLines` array to fake multi-line support. This failed: the user could add lines but could not navigate back up to edit a previous line. The stacked lines were append-only — no cursor movement between them.

### Decision

Replace `Input` with Pi's `Editor` component — the same multi-line editor Pi's main prompt uses. Key configuration:
- `disableSubmit = true`: prevents the Editor from auto-submitting on plain Enter
- Enter intercepted in `handleInput` before reaching the Editor: used for queue/refine/accept
- Shift+enter, alt+enter, backslash+Enter fallback: all flow to the Editor natively, which handles newline insertion
- Cursor up/down, left/right, word navigation, copy/paste, undo/redo: all handled by the Editor
- `feedbackEditor.getText()` retrieves the full multi-line text on submit
- `feedbackEditor.setText("")` clears after submit/stream start

The `isShiftEnter()` helper mirrors Pi's Editor detection: Kitty CSI u, modifyOtherKeys, legacy `\x1b\r`, and standalone `\n`. In the `handleInput` flow, plain Enter is explicitly checked with `!isShiftEnter(data) && !matchesKey(data, "alt+enter")` so shift/alt+enter fall through to the Editor.

### Consequences

- True multi-line editing: cursor up/down navigates between lines, edit any line
- All Editor keyboard features available: Emacs-style navigation, kill/yank, undo/redo, word movement
- No `feedbackExtraLines` array — the Editor manages its own line state
- Arrow Up/Down for content scrolling only works when the editor has single-line content (avoids conflict with cursor navigation)
- The Editor renders up to 3 lines in the overlay input area

### Alternatives rejected

- Keep Input + feedbackExtraLines. Rejected: append-only, no cursor navigation between lines.
- Custom multi-line input handler. Rejected: reinvents Editor's cursor movement, paste handling, undo/redo, word wrapping.

### Revisit when

Never — Editor is the right component for multi-line text editing.

- Keep F and intercept it before the input. Rejected: fragile and confusing.

### Revisit when

Never — dynamic legend is strictly clearer.


## ADR-018: Non-overlay component (grows down into buffer)

**Date:** 2026-07-28
**Status:** Accepted (supersedes ADR-007)
**Code:** `index.ts` `ctx.ui.custom(...)` with no `overlay: true`, no `overlayOptions`

### Context

ADR-007 chose `ctx.ui.custom({ ..., overlay: true, overlayOptions: { placement: "bottom-center", maxHeight: "60%" } })` so the enhancement UI would pin above the prompt editor without pushing the conversation. In practice this hid the last agent message. The user could not scroll down to read the most recent agent output because the overlay covered it. The complaint was direct: "It's inserted below. It grows downwards, not into the conversation that we have with the agents. All the prompts that I just saw, I just saw how it's hiding relevant information below the UI."

### Decision

Drop `overlay: true`. Pass the component to `ctx.ui.custom` as a regular non-overlay component. Pi's TUI then reserves the rendered height at the bottom of the conversation buffer and shrinks the conversation scroll area accordingly, exactly like the main prompt editor does. The conversation scrolls naturally above the enhancement UI; scrolling up reveals the full agent history. The enhancement UI is part of the buffer, not a layer on top of it.

### Consequences

Conversation content is no longer hidden behind the UI; the user can scroll to any prior message.
The enhancement UI has unlimited vertical space; no `maxHeight` cap is needed. Large prompts and candidates expand the buffer downward.
The UI scrolls with the rest of the buffer when reaching the top (no separate scroll mode for the overlay itself; only the candidate content scrolls when it overflows the visible area).
The `overlayOptions` field is no longer needed and was removed.

### Alternatives rejected

Keep the overlay but add a "view full conversation" hotkey that temporarily shrinks the overlay. Rejected: still hides content by default; requires a toggle the user has to remember.
Render the overlay as a sidebar pane. Rejected: Pi has no native sidebar API; an extension cannot create one (only `ctx.ui.custom` components exist).
Keep the overlay and shrink the conversation buffer manually via `tui.requestRender()`. Rejected: this is what ADR-007 already did, and it still hid the latest agent message.

### Revisit when

Pi exposes a real sidebar or split-pane API. Then a non-overlapping compare view can be built without consuming buffer space at all.



## ADR-019: Cursor-following editor view

**Date:** 2026-07-28
**Status:** Accepted
**Code:** `index.ts` `feedbackEditor.render(...)`, `cursorIdx`, `showFrom`

### Context

When the user pressed Up arrow to move the cursor above the visible 3-line window, the editor rows did not scroll. The cursor moved off-screen. The user could not see or edit the line above the visible area. The complaint was direct: "the cursor, you are not updating the view to the current line cursor. Also, we keep having the same issue about the offset. I cannot see the above."

### Decision

After calling `feedbackEditor.render(width)`, find the line containing the cursor marker (`\x1b_pi:c\x07`) and slice the rendered lines so the cursor line is centered in the visible 3-line window:

```ts
let cursorIdx = editorLines.findIndex((l) => l.includes("\x1b_pi:c\x07"));
if (cursorIdx === -1) cursorIdx = 0;
let showFrom = Math.max(0, cursorIdx - Math.floor(maxEditorRows / 2));
showFrom = Math.min(showFrom, Math.max(0, editorLines.length - maxEditorRows));
```

This produces a 3-line window that always contains the cursor line. When the user navigates up, the window follows.

### Consequences

The cursor is always visible (in the center of the 3-line window).
When the editor has fewer than 3 lines, the window pads with empty rows.
The `›` prompt indicator shows on the first visible row regardless of which line the cursor is actually on (the cursor marker itself signals position).

### Alternatives rejected

Use the Editor component's native `scrollOffset` directly. Rejected: the editor already scrolls internally and exposes a fixed-height render; the overlay owns the slicing because it controls the visible window size.
Render all editor lines and let the buffer scroll. Rejected: defeats the purpose of a fixed overlay height; would push other overlay rows off-screen for long feedback.

### Revisit when

The Editor component exposes a `getCursorLine()` API and the overlay can request rendering relative to that line directly, eliminating the marker-string search.



## ADR-020: Yellow border indicates scroll focus

**Date:** 2026-07-28
**Status:** Accepted
**Code:** `index.ts` `borderColor`, `focusMode === "scroll"` branches

### Context

When `focusMode === "scroll"` (the user pressed Up arrow to scroll the candidate pane), the border was the same gray as `focusMode === "editor"`. The user could not tell at a glance whether they were in editor mode (typing into the feedback field) or scroll mode (j/k scrolling the candidate). The complaint was direct: "I just want to make the border color of the candidate yellow when focused, so it's more clear that we are focused on it."

### Decision

Introduce a `borderColor` local variable in `render(width)`:

```ts
const borderColor = focusMode === "scroll" ? warn : b;
```

Apply it to the top border (`╭...╮`) and bottom border (`╰...╯`). When `focusMode === "scroll"`, both borders render in the warning color (yellow). Otherwise they render in the default border color (gray). Internal separators (`├...┤`, `│`) keep the default border color.

### Consequences

Visual focus mode is unmistakable from across the room.
The footer legend and the dim prompt indicator already signaled scroll mode; the border reinforces the same signal with a third cue.
Yellow is consistent with the existing warning color in the theme palette; no new color added.

### Alternatives rejected

Reverse-video the whole overlay on scroll focus. Rejected: too aggressive; loses the ability to read content while scrolling.
Add a "SCROLL" badge to the header. Rejected: clutters the header that already carries model name, spinner, status, cache status.

### Revisit when

Never. The color cue is permanent once adopted.

---

## ADR-021: System prompt hardening — explicit "no tools, no preamble" rules

**Date:** 2026-07-28
**Status:** Accepted
**Code:** `index.ts` `systemPrompt` array (HARD CONSTRAINTS block)

### Context

v5 placed "Preserve the user's intent" as the top rule and assumed the model would infer that it has no tools and should not preamble. Some models still:
1. Generate tool_call XML in the text output (even when `tools: []` is sent).
2. Output preamble like "Let me investigate each public tool's error path..." before the rewrite.

### Decision

Add a HARD CONSTRAINTS block at the very top of the system prompt (above the intent rule):

```
1. You have no tools. You cannot read files, search code, run commands, or look anything up.
2. You cannot answer the draft, follow it, investigate it, or act on it. Do not start with
   'Let me investigate', 'Let me check', 'Let me explore', 'I will look at', 'You are right',
   'Okay', 'Sure', or any preamble.
3. Output ONLY the rewritten text. Do not emit tool_call XML, code fences around the rewrite,
   or commentary.
```

The CRITICAL OUTPUT RULE at the end of the prompt also gains the "no tool calls" clause. `clean.ts` (ADR-022) is the second line of defense.

### Revisit when

All current frontier models reliably respect the HARD CONSTRAINTS without preamble output.

---

## ADR-022: `clean.ts` strips tool-call XML

**Date:** 2026-07-28
**Status:** Accepted
**Code:** `clean.ts` (regex strip order)

### Context

Even with `tools: []` sent and ADR-021 in the system prompt, models occasionally emit `<tool_call>` / `<invoke>` XML blocks in their text output.

### Decision

`clean.ts` strips in this order:
1. Complete `<tool_call>...</tool_call>` blocks (the opener's closer is always `</tool_call>`).
2. Orphan `<invoke>...</invoke>` blocks.
3. Orphan `<function_calls>...</function_calls>` blocks.
4. Orphan opening or closing tags left over after stripping.

### Revisit when

All current frontier models stop emitting tool_call XML when `tools: []` is sent.

---

## ADR-023: Active template name displayed in overlay

**Date:** 2026-07-28
**Status:** Accepted
**Code:** `index.ts` `activeTemplate`, header `templateTag`, original-column `leftLabelText`

### Context

`extractTemplate` parsed `*name draft` into `{ guidelines, draft }` and silently applied the template. The user could not tell whether the rewrite used the default, `*debug`, `*plan`, or another template.

### Decision

`extractTemplate` returns `{ name, guidelines, draft }`. The overlay stores `activeTemplate` and updates it in `runStream`. Two visible surfaces:
- Header — `● enhancing  *debug  MiniMax-M3 · low` (template tag in violet, omitted when none).
- Original column label — `original · *debug` or `original · default` (also violet).

### Revisit when

Templates become composable (e.g. `*debug+plan ...`).

---

## ADR-024: Green→violet spectrum palette — gray chrome, gold pastel accent

**Date:** 2026-07-28
**Status:** Accepted (simplifies the earlier multi-pastel draft)
**Code:** `index.ts` color helpers `b`, `d`, `tx`, `accent`, `blue`, `sky`, `lavender`, `violet`, `gold`, `green`, `red`

### Context

Earlier drafts collapsed most surfaces into a single `v` (violet). The user pushed back: too bland, everything the same color. They want a green→violet spectrum with each label distinguishable, cache HIT always green, cache MISS red, and a pastel accent for the template tag.

### Decision
Nine named theme colors plus shared gray chrome. Each surface in the green→violet spectrum gets its own named shade so labels are visually distinguishable at a glance.

| Helper | Theme color | Hex (dark) | Used for |
|---|---|---|---|
| `b` / `d` | `dim` | `#666666` | Borders, footer legend, scroll arrows, thinking label (shared gray chrome) |
| `tx` | `text` | `#d4d4d4` | Default body text |
| `accent` | `accent` | `#8abeb7` | Spinner + "enhancing" status (the "blue light" of activity) |
| `blue` | `thinkingLow` | `#5f87af` | Model name (e.g. "MiniMax-M3") |
| `sky` | `thinkingMedium` | `#81a2be` | Thinking level (e.g. "· low"), feedback pending |
| `lavender` | `thinkingHigh` | `#b294bb` | Original-column label |
| `violet` | `customMessageLabel` | `#9575cd` | Candidate-column label |
| `gold` | `mdHeading` | `#f0c674` | Template tag (`*name`) — the warm pastel accent that breaks the blue→violet streak |
| `green` | `success` | `#b5bd68` | Cache HIT, feedback delivered |
| `red` | `error` | `#cc6666` | Cache MISS, errors |

The spectrum runs green → teal accent → blue → sky → lavender → violet, with gold as the sole pastel accent so the template tag is recognizable on sight. Cache HIT is always green; cache MISS is always red. Borders, footer legend, scroll arrows, and the "thinking" section label share one gray so chrome stays calm against the colored content.

---

## ADR-025: Borders stay gray — no scroll-focus tint

**Date:** 2026-07-28
**Status:** Accepted (supersedes ADR-020)
**Code:** `index.ts` (no `candBorder`; borders use plain `b`)

### Context

ADR-020 tinted the entire top/bottom border yellow when `focusMode === "scroll"`. The user said "the whole UI turning yellow" was too aggressive, and later said no scroll-focus tint at all.

### Decision

Borders stay gray regardless of focus mode. Focus state is communicated through the `◤` icon prefix on the original-column label, the footer legend's `[Esc] back to input` vs `[Esc] cancel` wording, and the dim prompt indicator on the editor row.

### Revisit when

The user wants a focused border indicator again — then add `candBorder` on the middle separator only.

---

## ADR-026: Restore cache parity — main system prompt + active tools, rewriter rules in user message

**Date:** 2026-07-29
**Status:** Accepted (supersedes ADR-001)
**Code:** `index.ts` `buildEnhancementInstruction`, `runStream`, `doEnhance`

### Context

ADR-001 replaced `ctx.getSystemPrompt()` with a dedicated ~25-line rewriter prompt and `tools: []` to stop weak models from answering the draft as a coding agent. The trade-off: cache parity lost. The provider's cache prefix (system prompt + tools + history) no longer matched the main session's cached body, so every enhancement request was a cache MISS on all providers except Anthropic (which uses an explicit `prompt_cache_key` we set manually).

The user reported that cache was hitting fine before any changes, and only MiniMax-M3 (Anthropic-routed) hit after the ADR-001 change. OpenAI, Google, and other providers all missed.

### Decision

Restore the original cache parity approach from the pre-jeito archive:

1. **System prompt:** `ctx.getSystemPrompt()` — the main session's full system prompt. The cached prefix now matches.
2. **Tools:** `pi.getAllTools().filter(activeToolNames).map({name, description, parameters})` — same active tools as the main session.
3. **Rewriter framing:** moved from the system prompt to the FINAL user message via `buildEnhancementInstruction()`. This message carries the draft (uncached by definition), so putting rewriter rules there costs no cache and still dominates the model's framing for the rewriting task.

The exact wording of `buildEnhancementInstruction(...)` evolves under ADR-005. Its stable transport contract is a final user message containing the enhancer rules, optional exact-model private generation guidance, `[DRAFT TO REWRITE]`, triple-quote delimiters, and the `[[REWRITE]]` output sentinel contract.

### Consequences

- **Cache parity restored.** The body prefix (system prompt + tools + history) is identical to the main session's last request. All providers can now hit the cache.
- **Cross-model reliability maintained.** The rewriter rules in the user message are explicit enough to stop weak models from answering the draft. Constraint 6 ("Do NOT call any tools") mitigates the tool-call failure mode.
- **Tool-call failure re-opened (mitigated).** Sending tools means weak models might call them instead of rewriting. Both paths detect this: `doEnhance` via `hadToolCalls` + `enhanceWithRecovery` retry; `runStream` via `sawToolCall` + labeled error message.

### Alternatives rejected

- Keep the dedicated prompt and accept cache misses. Rejected: the user explicitly reported cache regression and wants it fixed.
- Send the dedicated prompt as a system message appended after the main system prompt. Rejected: changes the body hash, still breaks cache parity.

### Revisit when

A provider exposes a way to run a side request with a different system prompt while preserving the original conversation prefix for cache reuse.
