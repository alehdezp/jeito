// draft-lift: improve an editor draft through a context-preserving side request.
// Cache reuse remains provider-observed, not guaranteed; see docs/cache-parity.md.

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { streamSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, matchesKey, Key, visibleWidth, wrapTextWithAnsi, truncateToWidth } from "@earendil-works/pi-tui";
import { clean } from "./clean.ts";

let originalText: string | undefined;
let enhancing = false;

// ── Theme helpers ──────────────────────────────────────────────────────
// Eleven colors. Gray chrome (borders, legend, scroll arrows, thinking label).
// Green→Violet spectrum: green (cache hit) → teal accent (spinner/status) →
// blue (model) → sky (thinking level) → lavender (original) → violet (candidate).
// Gold pastel accent for template tag. Red for cache miss / errors.

function b(t: string, th: Theme) { return th.fg("dim", t); }             // gray — borders, legend, scroll arrows, thinking label
function d(t: string, th: Theme) { return th.fg("dim", t); }             // gray (alias of b; reserved for future divergence)
function tx(t: string, th: Theme) { return th.fg("text", t); }           // default body text

function accent(t: string, th: Theme) { return th.fg("accent", t); }      // teal — spinner, "enhancing" status (the blue light)
function blue(t: string, th: Theme) { return th.fg("thinkingLow", t); }   // blue — model name
function sky(t: string, th: Theme) { return th.fg("thinkingMedium", t); }  // sky — thinking level
function lavender(t: string, th: Theme) { return th.fg("thinkingHigh", t); } // lavender — original label
function violet(t: string, th: Theme) { return th.fg("customMessageLabel", t); } // violet — candidate label
function gold(t: string, th: Theme) { return th.fg("mdHeading", t); }     // warm gold — template tag (the pastel accent)
function green(t: string, th: Theme) { return th.fg("success", t); }     // green — cache hit, feedback delivered
function red(t: string, th: Theme) { return th.fg("error", t); }        // red — cache miss, errors
function spaces(n: number) { return " ".repeat(Math.max(0, n)); }
function pa(t: string, w: number) { const v = visibleWidth(t); return v >= w ? t : t + spaces(w - v); }

// ── Unified enhancement overlay with streaming + steering ──────────────

const SENTINEL_OPEN = "[[REWRITE]]";
const SENTINEL_CLOSE = "[[/REWRITE]]";

// Rewriter role is delivered via the final user message, not the system
// prompt, so the provider sees the main session's system prompt as the body
// prefix — that is the part cached. Putting the rewriter rules here keeps
// cache parity (the cached prefix is identical to the main session's last
// request) while keeping the role framing explicit enough to stop weak
// models from answering the draft as if it were their own turn.
export function buildEnhancementInstruction(
  draft: string,
  feedback?: { previousCandidate: string; userFeedback: string },
  guidelines?: string | null,
  modelId?: string,
): string {
  const intro = [
    "You rewrite the user's messy draft into the clearest directly usable version of the same request for the agent that will act on it. Do not execute or answer the request, and do not continue the conversation.",
    "",
    "READ THE CONVERSATION:",
    "- Read the conversation as an exchange. Pay particular attention to the user's latest messages and the nearby assistant replies they answer, correct, accept, reject, modify, or refer to.",
    "- Assistant replies can establish what a reference, reaction, correction, or accepted proposal means, but assistant wording is never user intent by itself. A direct affirmative accepts the specific proposal it answers; silence and topic changes do not.",
    "- Recent user statements normally express the current objective, correction, or preference. Earlier active goals, constraints, decisions, and relevant expressed preferences remain in force until the user contradicts or abandons them. A correction replaces only what it contradicts. Preserve separate active goals.",
    "- Use context to connect explicit references, accepted proposals, corrections, contrasts, and omitted user-stated constraints. Interpretation may connect explicit material; it may not create a goal, preference, requirement, or deliverable. When applicability is uncertain, leave the detail out.",
    "- Do not call tools, search, explore, or read anything outside the supplied conversation.",
    "",
    "IMPROVE THE REQUEST:",
    "- Preserve the user's meaning, scope, stance, language, and level of ambition. Improve comprehension and execution of that intent rather than replacing it.",
    "- State the request first. Remove filler, repetition, and tangled wording. Restore directly applicable context that the next agent would otherwise need to reconstruct.",
    "- Improve and expand the draft when a safe addition makes the same intent clearer, safer to execute, or less likely to drift. Preserve already-clear parts instead of rewriting them for novelty.",
    "- Organize supplied material according to the task when useful; do not force a template or fill missing fields. For code work, clarify intended behavior and add only the smallest focused check needed to verify it. For research, clarify the question or decision and preserve stated evidence needs without inventing a research program. Apply the same proportionate judgment to other task types.",
    "- Keep simple requests simple. Added length, detail, formatting, structure, or ceremony count only when they materially improve understanding or prevent a predictable execution error without changing the requested outcome.",
    "- If one missing fact would materially change safe or correct execution, tell the next agent to ask that one focused question before acting. Leave optional details unspecified.",
    "",
    "BEFORE OUTPUT:",
    "- Inspect every addition. A goal, constraint, preference, deliverable, or scope decision must trace to the draft or directly applicable accepted user intent.",
    "- Other additions are allowed only when they directly improve understanding or prevent a predictable execution error without changing the requested outcome. Remove anything speculative, disproportionate, ceremonial, or likely to become work of its own.",
  ];

  if (modelId?.toLowerCase() === "gpt-5.6-sol") {
    intro.push(
      "",
      "ADDITIONAL GENERATION GUIDANCE — this governs the rewrite operation only; do not include it in the rewritten prompt:",
      "- Your deliverable is the rewritten prompt inside the markers. Do not replace it with analysis, planning, an audit, a feasibility study, alternative designs, validation, benchmarking, or discussion of how the underlying task should be executed. If you begin solving, testing, reviewing, or planning the user's task, stop and return to rewriting it.",
      "- Do not inflate the rewrite into a specification the user did not establish. Implementation workflows, broad steps, test strategies, validation programs, benchmarks, acceptance criteria, documentation, hardening, review checklists, and adjacent improvements belong only when they trace directly to accepted user intent. Proportionate execution guidance may be added only when it protects the same outcome without becoming another deliverable; for example, prefer the smallest direct behavior check over a broad test program.",
      "- Thoroughness, production conventions, available tools, discovered opportunities, and what a complete specification would normally contain do not expand intent. Supporting structure must help communicate the requested outcome; it must not replace it.",
      "- The rewrite is complete when it preserves every active commitment and removes a real comprehension or execution risk. Length, coverage, added process, and repeated review do not measure completeness. Output it immediately when this condition is met; do not add another pass, polish cycle, self-review, validation, or proof of the rewrite.",
      "- When revising a previous candidate, apply the requested correction as a constrained change. Do not rebuild or expand unaffected parts.",
    );
  }

  intro.push(
    "",
    "Return only the rewritten prompt inside " + SENTINEL_OPEN + " and " + SENTINEL_CLOSE + ". No preamble, analysis, explanation, or code fence.",
  );

  const instructionRoot = intro.join("\n");

  if (feedback) {
    return [
      instructionRoot,
      "",
      "[REVISION CONTEXT — apply the user's feedback as a constrained delta; preserve every untouched intent invariant from the draft and prior rewrite]",
      "Previous rewrite:",
      feedback.previousCandidate,
      "",
      "User feedback on previous rewrite:",
      feedback.userFeedback,
      "",
      guidelines ? guidelines : "",
      "",
      "[DRAFT TO REWRITE]",
      '"""',
      draft,
      '"""',
    ].filter(Boolean).join("\n");
  }

  if (guidelines) {
    return [
      instructionRoot,
      "",
      guidelines,
      "",
      "[DRAFT TO REWRITE]",
      '"""',
      draft,
      '"""',
    ].join("\n");
  }

  return [
    instructionRoot,
    "",
    "[DRAFT TO REWRITE]",
    '"""',
    draft,
    '"""',
  ].join("\n");
}

function extractSentinel(text: string): string {
  const m = text.match(/\[\[REWRITE\]\]([\s\S]*?)\[\[\/REWRITE\]\]/);
  return clean(m ? m[1].trim() : text);
}

type FeedbackEntry = { text: string; delivered: boolean };

// Detect shift+enter across terminal protocols.
// Mirrors pi-tui's Editor: Kitty CSI u, modifyOtherKeys, legacy \x1b\r, and \n.
// In terminals without Kitty protocol, shift+enter is indistinguishable from enter.
// Fallback: backslash + Enter inserts a newline (same as Pi's main editor).
function isShiftEnter(data: string): boolean {
  // Kitty protocol CSI u / modifyOtherKeys
  if (matchesKey(data, "shift+enter")) return true;
  // Legacy terminal custom mappings
  if (data === "\x1b\r") return true;       // Kitty map shift+enter send_text \e\r
  if (data === "\x1b[13;2~") return true;    // xterm modifyOtherKeys
  if (data.length > 1 && data.includes("\x1b") && data.includes("\r")) return true;
  // Ghostty / some terminals send \n for shift+enter
  // But only treat \n as shift+enter if it's standalone (not part of a longer sequence)
  if (data === "\n" && data.length === 1) return true;
  return false;
}

function enhancementOverlay(
  originalDraft: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<{ result: string | null }> {
  return ctx.ui.custom<{ result: string | null }>((tui, theme, _kb, done) => {
    const editorTheme: EditorTheme = {
      borderColor: (text: string) => theme.fg("border", text),
      selectList: {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("muted", text),
        noMatch: (text: string) => theme.fg("muted", text),
      },
    };
    const feedbackEditor = new Editor(tui as any, editorTheme);
    feedbackEditor.disableSubmit = true;
    feedbackEditor.focused = true;

    let state: "working" | "comparing" | "error" = "working";
    let thinkingText = "";
    let candidate = "";
    let errorMsg = "";
    let disposed = false;
    let lastCandidate = "";
    let attemptCount = 0;
    let cacheStatus = "";
    const feedbackHistory: FeedbackEntry[] = [];
    let focusMode: "editor" | "scroll" = "editor";
    let spinnerFrame = 0;
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

    // Scrolling state
    let scrollOffset = 0;

    // Spinner animation timer
    const spinnerTimer = setInterval(() => {
      if (state === "working" && !disposed) {
        spinnerFrame = (spinnerFrame + 1) % spinnerFrames.length;
        tui.requestRender();
      }
    }, 80);

    async function runStream(feedback?: { prev: string; userFeedback: string }) {
      if (disposed) return;
      attemptCount++;
      state = "working";
      thinkingText = "";
      candidate = "";
      errorMsg = "";
      cacheStatus = "";
      scrollOffset = 0;
      focusMode = "editor";
      feedbackEditor.setText("");
      tui.requestRender();

      const model = ctx.model;
      if (!model) { errorMsg = "No model selected"; state = "error"; tui.requestRender(); return; }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) { errorMsg = "No API key"; state = "error"; tui.requestRender(); return; }

      // Cache parity: use the main session's system prompt and tools so the
      // provider sees an identical body prefix to the main session's last
      // request. The rewriter role lives in the FINAL user message via
      // buildEnhancementInstruction — that part is uncached by definition
      // (it carries the draft), so putting rewriter rules there costs no
      // cache and still dominates the model's framing.
      const systemPrompt = ctx.getSystemPrompt();
      const activeToolNames = new Set(pi.getActiveTools());
      const tools = pi.getAllTools()
        .filter((tool) => activeToolNames.has(tool.name))
        .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));

      const sessionContext = ctx.sessionManager.buildSessionContext();
      const resolvedMessages = sessionContext.messages ?? [];
      const llmMessages = convertToLlm(resolvedMessages as any);

      const { guidelines, draft } = extractTemplate(originalDraft);
      const feedbackPayload = feedback
        ? { previousCandidate: feedback.prev, userFeedback: feedback.userFeedback }
        : undefined;
      const instruction = buildEnhancementInstruction(draft, feedbackPayload, guidelines, model.id);
      llmMessages.push({ role: "user", content: [{ type: "text" as const, text: instruction }] });
      const thinkingLevel = pi.getThinkingLevel();
      const reasoning = thinkingLevel === "off" ? undefined : thinkingLevel;

      try {
        const streamFn = resolveStreamFn(ctx, model);
        const stream = streamFn(model, { systemPrompt, messages: llmMessages, tools }, {
          apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal,
          sessionId: ctx.sessionManager.getSessionId(), reasoning, transport: "auto",
          onPayload: async (payload) => {
            // Mirror the latest main provider body so the cache prefix aligns
            // even before the main session has warmed the cache.
            const cacheKey = ctx.sessionManager.getSessionId();
            let next = payload;
            if (cacheKey) {
              const record = next as Record<string, unknown>;
              if (typeof record.prompt_cache_key !== "string") {
                next = { ...record, prompt_cache_key: Array.from(cacheKey).slice(0, 64).join("") };
              }
            }
            return next;
          },
        });

        let sawToolCall = false;
        for await (const event of stream) {
          if (disposed) return;
          if (event.type === "thinking_delta") {
            thinkingText += event.delta;
            tui.requestRender();
          } else if (event.type === "text_delta") {
            candidate += event.delta;
            tui.requestRender();
          } else if (event.type === "toolcall_start") {
            sawToolCall = true;
          } else if (event.type === "done") {
            const extracted = extractSentinel(candidate.trim());
            const usage = event.message.usage;
            if (usage && typeof usage.cacheRead === "number") {
              cacheStatus = usage.cacheRead > 0 ? "cache HIT" : "cache MISS";
            }
            if (extracted) {
              candidate = extracted;
              lastCandidate = extracted;
              // Auto-process any feedback queued during working
              const pending = feedbackHistory.filter((f) => !f.delivered);
              if (pending.length > 0 && attemptCount < 8) {
                const combined = pending.map((f) => f.text).join("; ");
                pending.forEach((f) => { f.delivered = true; });
                runStream({ prev: extracted, userFeedback: combined });
                return;
              }
              state = "comparing";
              scrollOffset = 0;
              tui.requestRender();
            } else {
              state = "error";
              // Restoring tools (for cache parity) re-opens the "model calls a
              // tool instead of rewriting" failure on weak models; label it so
              // the user knows to retry with a stronger model rather than seeing
              // a bare "Empty output".
              errorMsg = sawToolCall
                ? "Model called a tool instead of rewriting — retry with a stronger model"
                : "Empty output";
              tui.requestRender();
            }
          } else if (event.type === "error") {
            state = "error";
            errorMsg = safeError(event.error);
            tui.requestRender();
          }
        }
        // The stream can end without a terminal `done`/`error` event (network
        // drop, early close). Without this guard the overlay would stay in
        // "working" forever — the "says enhancing, then nothing" failure.
        if (!disposed && state === "working") {
          state = "error";
          errorMsg = sawToolCall
            ? "Model called a tool instead of rewriting — retry with a stronger model"
            : "Stream ended without a response";
          tui.requestRender();
        }
      } catch (err) {
        if (disposed) return;
        state = "error";
        errorMsg = safeError(err);
        tui.requestRender();
      }
    }

    function cancel() {
      if (disposed) return;
      // Save candidate to clipboard on cancel
      const best = candidate || lastCandidate;
      if (best) saveToClipboard(best);
      clearInterval(spinnerTimer);
      disposed = true;
      done({ result: null });
    }

    runStream();

    return {
      render(width: number): string[] {
        try {
        const w = Math.max(40, width);
        const inner = w - 2;
        const lines: string[] = [];

        const useWide = w >= 70;
        const ow = useWide ? Math.min(38, Math.max(14, Math.floor(inner * 0.30))) : 0;
        const cw = useWide ? inner - ow - 1 : 0;

        // ── Top border (always gray; ADR-025) ──
        lines.push(b("╭" + "─".repeat(inner) + "╮", theme));

        // ── Header ──
        const spinner = state === "working" ? spinnerFrames[spinnerFrame] : state === "error" ? "⊘" : "●";
        const statusText = state === "working" ? "enhancing" : state === "error" ? "failed" : "enhancement";
        const modelName = ctx.model?.name ?? ctx.model?.id ?? "?";
        const tl = pi.getThinkingLevel();
        const headerStr = ` ${accent(spinner, theme)} ${accent(statusText, theme)}  ${blue(modelName, theme)} ${sky(`· ${tl}`, theme)}`;
        lines.push(b("│", theme) + headerStr + spaces(Math.max(0, inner - visibleWidth(headerStr))) + b("│", theme));

        // ── Column separator + headers ──
        if (useWide) {
          lines.push(b("├" + "─".repeat(ow) + "┬" + "─".repeat(cw) + "┤", theme));
          let rightLabel: string;
          if (state === "working") { rightLabel = "thinking"; }
          else if (state === "error") { rightLabel = "error"; }
          else { rightLabel = "candidate"; }
          // Right label: thinking stays gray, error stays red, candidate uses violet
          const labelColor = rightLabel === "thinking" ? d : rightLabel === "error" ? red : violet;
          let rightHeader = labelColor(` ${rightLabel}`, theme);
          if (cacheStatus) {
            const isHit = /^cache\s+HIT/i.test(cacheStatus);
            // Cache HIT → green (always); cache MISS → red.
            rightHeader += isHit ? green(`  ${cacheStatus}`, theme) : red(`  ${cacheStatus}`, theme);
          }
          // Original label: lavender (in the green→violet spectrum, distinct from violet candidate).
          const leftLabel = focusMode === "scroll" ? lavender(" ◤ original", theme) : lavender(" original", theme);
          lines.push(b("│", theme) + pa(leftLabel, ow) + b("│", theme) + rightHeader + spaces(Math.max(0, cw - visibleWidth(rightHeader))) + b("│", theme));
          lines.push(b("├" + "─".repeat(ow) + "┼" + "─".repeat(cw) + "┤", theme));
        } else {
          lines.push(b("├" + "─".repeat(inner) + "┤", theme));
        }

        // ── Build left column ──
        const leftCol: string[] = [];
        if (useWide) {
          for (const line of wrapTextWithAnsi(originalDraft, ow)) leftCol.push(tx(pa(line, ow), theme));
          for (const fb of feedbackHistory) {
            leftCol.push(spaces(ow));
            const icon = fb.delivered ? "─" : "┄";
            for (const wl of wrapTextWithAnsi(` ${icon} ${fb.text}`, ow)) {
              const padded = pa(wl, ow);
              leftCol.push(fb.delivered
                ? theme.bg("toolSuccessBg", green(padded, theme))
                : theme.bg("toolPendingBg", sky(padded, theme)));
            }
          }
        }

        // ── Build right column ──
        const rightCol: string[] = [];
        if (useWide) {
          if (state === "working") {
            if (thinkingText.trim()) {
              for (const line of thinkingText.split("\n").filter((l) => l.trim()).slice(-10)) {
                for (const wl of wrapTextWithAnsi(line, cw)) rightCol.push(d(pa(wl, cw), theme));
              }
            } else {
              rightCol.push(d(pa(" …", cw), theme));
            }
          } else if (state === "error") {
            rightCol.push(red(pa(errorMsg.slice(0, cw), cw), theme));
          } else {
            for (const line of wrapTextWithAnsi(candidate, cw)) rightCol.push(tx(pa(line, cw), theme));
          }
        }

        // ── Emit content rows with height cap ──
        const maxHeight = Math.floor((tui as any).height * 0.5) || 20;
        const contentRows = Math.max(leftCol.length, rightCol.length, 1);

        if (useWide) {
          const start = contentRows > maxHeight ? scrollOffset : 0;
          const end = Math.min(start + maxHeight, contentRows);
          for (let i = start; i < end; i++) {
            const l = leftCol[i] ?? spaces(ow);
            const r = rightCol[i] ?? spaces(cw);
            lines.push(b("│", theme) + l + b("│", theme) + r + b("│", theme));
          }
          if (contentRows > maxHeight) {
            const indicator = ` ↑↓ j/k scroll  ${start + 1}-${end}/${contentRows} `;
            lines.push(b("│", theme) + d(pa(indicator, inner), theme) + b("│", theme));
          }
        } else {
          lines.push(b("│", theme) + lavender(pa(" original", inner), theme) + b("│", theme));
          lines.push(b("├" + "─".repeat(inner) + "┤", theme));
          for (const line of wrapTextWithAnsi(originalDraft, inner)) lines.push(b("│", theme) + tx(pa(line, inner), theme) + b("│", theme));
          for (const fb of feedbackHistory) {
            lines.push(b("│", theme) + spaces(inner) + b("│", theme));
            const icon = fb.delivered ? "─" : "┄";
            for (const wl of wrapTextWithAnsi(` ${icon} ${fb.text}`, inner)) {
              const padded = pa(wl, inner);
              lines.push(b("│", theme) + (fb.delivered
                ? theme.bg("toolSuccessBg", green(padded, theme))
                : theme.bg("toolPendingBg", sky(padded, theme))) + b("│", theme));
            }
          }
          lines.push(b("├" + "─".repeat(inner) + "┤", theme));
          if (state === "working") {
            lines.push(b("│", theme) + d(pa(" thinking", inner), theme) + b("│", theme));
            lines.push(b("├" + "─".repeat(inner) + "┤", theme));
            if (thinkingText.trim()) {
              for (const line of thinkingText.split("\n").filter((l) => l.trim()).slice(-4)) {
                for (const wl of wrapTextWithAnsi(line, inner)) lines.push(b("│", theme) + d(pa(wl, inner), theme) + b("│", theme));
              }
            } else {
              lines.push(b("│", theme) + d(pa(" …", inner), theme) + b("│", theme));
            }
          } else if (state === "error") {
            lines.push(b("│", theme) + red(pa(errorMsg.slice(0, inner), inner), theme) + b("│", theme));
          } else {
            lines.push(b("│", theme) + violet(pa(" candidate", inner), theme) + b("│", theme));
            lines.push(b("├" + "─".repeat(inner) + "┤", theme));
            for (const line of wrapTextWithAnsi(candidate, inner)) lines.push(b("│", theme) + tx(pa(line, inner), theme) + b("│", theme));
          }
        }

        // ── Input separator ──
        if (useWide) {
          lines.push(b("├" + "─".repeat(ow) + "┴" + "─".repeat(cw) + "┤", theme));
        } else {
          lines.push(b("├" + "─".repeat(inner) + "┤", theme));
        }

        // ── Editor rows — cursor-following window ──
        // Find which rendered line has the cursor, center the view around it
        const editorLines = feedbackEditor.render(Math.max(10, inner - 2));
        const maxEditorRows = 3;
        let cursorIdx = editorLines.findIndex((l) => l.includes("\x1b_pi:c\x07"));
        if (cursorIdx === -1) cursorIdx = 0;
        let showFrom = Math.max(0, cursorIdx - Math.floor(maxEditorRows / 2));
        showFrom = Math.min(showFrom, Math.max(0, editorLines.length - maxEditorRows));
        const visibleEdLines = editorLines.slice(showFrom, showFrom + maxEditorRows);
        for (let i = 0; i < visibleEdLines.length; i++) {
          const el = visibleEdLines[i];
          const elVis = visibleWidth(el);
          const prompt = (i === 0 && showFrom === 0) ? "› " : "  ";
          const promptColor = focusMode === "scroll" ? d : accent;
          lines.push(b("│", theme) + promptColor(prompt, theme) + el + spaces(Math.max(0, inner - 2 - elVis)) + b("│", theme));
        }
        while (visibleEdLines.length < 1) {
          const promptColor = focusMode === "scroll" ? d : accent;
          lines.push(b("│", theme) + promptColor("› ", theme) + spaces(inner - 2) + b("│", theme));
          visibleEdLines.push(""); // pad
        }

        // ── Help row ──
        lines.push(b("├" + "─".repeat(inner) + "┤", theme));
        const editorText = feedbackEditor.getText().trim();
        const inputEmpty = editorText.length === 0;
        let help: string;
        if (focusMode === "scroll") {
          help = " j/k ↑↓ scroll  [Esc] back to input ";
        } else if (state === "working") {
          help = inputEmpty
            ? " type to steer  [⇧+↵] newline  [↑] scroll  [Esc] cancel · saves "
            : " [Enter] queue  [⇧+↵] newline  [Esc] cancel · saves ";
        } else {
          help = inputEmpty
            ? " [Enter] accept  [⇧+↵] newline  [↑] scroll  [Esc] cancel · saves "
            : " [Enter] refine  [⇧+↵] newline  [Esc] cancel · saves ";
        }
        lines.push(b("│", theme) + d(help, theme) + spaces(Math.max(0, inner - visibleWidth(help))) + b("│", theme));

        // ── Bottom border (always gray; ADR-025) ──
        lines.push(b("╰" + "─".repeat(inner) + "╯", theme));
        // Defensive clamp: a sub-component (editor, autocomplete) can emit a
        // line wider than `width`, which crashes TUI.doRender. Truncate every
        // line to the real terminal width before returning.
        return lines.map((l) => truncateToWidth(l, width));
        } catch (renderErr) {
          // Never let a render error crash Pi
          return [b("╭" + "─".repeat(Math.max(0, width - 2)) + "╮", theme),
                  red("│ render error: " + String(renderErr).slice(0, Math.max(0, width - 20)), theme),
                  b("╰" + "─".repeat(Math.max(0, width - 2)) + "╯", theme)].map((l) => truncateToWidth(l, width));
        }
      },

      handleInput(data: string): void {
        if (disposed) return;

        // ── Scroll mode: j/k/arrows scroll content, Esc returns to editor ──
        if (focusMode === "scroll") {
          if (matchesKey(data, Key.escape)) {
            focusMode = "editor";
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.up) || data === "k") {
            scrollOffset = Math.max(0, scrollOffset - 3);
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.down) || data === "j") {
            scrollOffset += 3;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            // Enter in scroll mode = accept if comparing
            if (state === "comparing") {
              clearInterval(spinnerTimer);
              disposed = true;
              done({ result: candidate || lastCandidate || null });
            }
            return;
          }
          // Any other key returns to editor mode
          focusMode = "editor";
          // Fall through to editor handling below
        }

        // ── Editor mode ──
        // Esc cancels the overlay
        if (matchesKey(data, Key.escape)) { cancel(); return; }

        // Arrow Up on the first line of editor → enter scroll mode
        // (only in comparing state when there's content to scroll)
        if (state === "comparing" && matchesKey(data, Key.up)) {
          const text = feedbackEditor.getText();
          // If editor is empty or cursor is on first line, switch to scroll
          // The Editor handles Up for multi-line navigation internally;
          // we only intercept when it would be a no-op (single line or empty)
          if (!text.includes("\n")) {
            focusMode = "scroll";
            scrollOffset = 0;
            tui.requestRender();
            return;
          }
        }

        // Plain Enter: intercept for submit/queue/accept.
        if (matchesKey(data, Key.enter) && !isShiftEnter(data) && !matchesKey(data, "alt+enter")) {
          const text = feedbackEditor.getText().trim();
          // Backslash+Enter: terminal fallback for newline
          const rawText = feedbackEditor.getText();
          if (rawText.endsWith("\\")) {
            feedbackEditor.setText(rawText.slice(0, -1) + "\n");
            tui.requestRender();
            return;
          }
          if (state === "working") {
            if (text) {
              feedbackHistory.push({ text, delivered: false });
              feedbackEditor.setText("");
              tui.requestRender();
            }
            return;
          }
          if (text && (candidate || lastCandidate)) {
            feedbackHistory.push({ text, delivered: false });
            feedbackEditor.setText("");
            runStream({ prev: candidate || lastCandidate, userFeedback: text });
            feedbackHistory.forEach((f) => { f.delivered = true; });
          } else {
            clearInterval(spinnerTimer);
            disposed = true;
            done({ result: candidate || lastCandidate || null });
          }
          return;
        }

        // Everything else flows to the Editor
        feedbackEditor.handleInput(data);
        tui.requestRender();
      },

      dispose() { clearInterval(spinnerTimer); disposed = true; },
    };
  });
}

// ── Context extraction ─────────────────────────────────────────────────

function extractRawMessages(ctx: ExtensionContext): any[] {
  const messages: any[] = [];
  const entries = ctx.sessionManager.getEntries();
  for (const entry of entries) {
    if (entry.type === "message") {
      const msg = (entry as any).message;
      if (msg && (msg.role === "user" || msg.role === "assistant")) {
        messages.push(msg);
      }
    }
  }
  return messages;
}

function extractMessages(ctx: ExtensionContext): string {
  const parts: string[] = [];
  const raw = extractRawMessages(ctx);
  for (const msg of raw) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content) ? msg.content.map((c: any) => c.type === "text" ? c.text : "").join("") : "";
      if (text.trim()) parts.push(`U: ${text.slice(0, 80)}`);
    } else if (msg.role === "assistant") {
      const text = Array.isArray(msg.content) ? msg.content.map((c: any) => c.type === "text" ? c.text : "").join("") : "";
      if (text.trim()) parts.push(`A: ${text.slice(0, 80)}`);
    }
  }
  return parts.join("\n");
}

// ── Types ──────────────────────────────────────────────────────────────

type EnhanceUsage = { input: number; cacheRead: number; cacheWrite: number; output: number; totalTokens: number };
type EnhanceResult = { text: string; usage: EnhanceUsage; logPath: string; attemptId: string };
type EnhanceFailure = { reason: string; category: string; attemptId: string };
type EnhanceOutcome = EnhanceResult | EnhanceFailure;

let enhanceAttemptSeq = 0;
const RECENT_ENHANCE_COOLDOWN_MS = 10_000;
const recentEnhanceAttempts = new Map<string, number>();

const CACHE_BACKLOG_PATH = join(getAgentDir(), "draft-lift", "backlog.jsonl");
const TEMPLATE_DIR = join(getAgentDir(), "draft-lift", "templates");

function hashValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(text ?? "undefined").digest("hex").slice(0, 16);
}

// ── Provider payload audit (unchanged) ─────────────────────────────────

type ProviderPayloadAudit = {
  payloadHash: string;
  bodyWithoutInputHash: string;
  instructionsHash: string | null;
  inputHash: string | null;
  inputItems: number | null;
  inputTypes: Record<string, number>;
  tools: number | null;
  toolsHash: string | null;
  promptCacheKeyPresent: boolean;
  promptCacheKeyHash: string | null;
  promptCacheKeyLength: number | null;
  reasoningHash: string | null;
  textHash: string | null;
  model: unknown;
  store: unknown;
  stream: unknown;
  toolChoice: unknown;
  parallelToolCalls: unknown;
  serviceTier: unknown;
  transport: string;
};

type MainProviderAudit = ProviderPayloadAudit & {
  leafId: string;
  branchEntries: number;
  sessionIdHash: string;
  modelProvider?: string;
  modelId?: string;
};

let lastMainProviderAudit: MainProviderAudit | undefined;
type MainProviderMirror = {
  sessionIdHash: string;
  modelProvider?: string;
  modelId?: string;
  bodyWithoutInput: Record<string, any>;
};

let lastMainProviderMirror: MainProviderMirror | undefined;

function stripProviderInputFields(payload: unknown): Record<string, any> | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  const { input: _input, previous_response_id: _previousResponseId, ...withoutInput } = record;
  return structuredClone(withoutInput);
}

function mirrorLatestMainBodyWithoutInput(payload: unknown, sessionId: string | undefined, model: { provider: string; id: string }): { payload: unknown; applied: boolean; reason: string } {
  const record = asRecord(payload);
  const sessionIdHash = hashValue(sessionId);
  if (!record) return { payload, applied: false, reason: "payload_not_object" };
  if (!lastMainProviderMirror) return { payload, applied: false, reason: "no_main_provider_payload_seen" };
  if (lastMainProviderMirror.sessionIdHash !== sessionIdHash) return { payload, applied: false, reason: "session_mismatch" };
  if (lastMainProviderMirror.modelProvider !== model.provider || lastMainProviderMirror.modelId !== model.id) return { payload, applied: false, reason: "model_mismatch" };
  return {
    payload: {
      ...structuredClone(lastMainProviderMirror.bodyWithoutInput),
      input: record.input,
    },
    applied: true,
    reason: "matched_latest_main_body_without_input",
  };
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function inputTypeCounts(input: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(input)) return counts;
  for (const item of input) {
    const type = asRecord(item)?.type ?? asRecord(item)?.role ?? "unknown";
    const key = typeof type === "string" ? type : "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function summarizeProviderPayload(payload: unknown, transport: string): ProviderPayloadAudit {
  const record = asRecord(payload) ?? {};
  const { input: _input, previous_response_id: _previousResponseId, ...withoutInput } = record;
  const promptCacheKey = typeof record.prompt_cache_key === "string"
    ? record.prompt_cache_key
    : typeof record.promptCacheKey === "string" ? record.promptCacheKey : undefined;
  return {
    payloadHash: hashValue(record),
    bodyWithoutInputHash: hashValue(withoutInput),
    instructionsHash: typeof record.instructions === "string" ? hashValue(record.instructions) : null,
    inputHash: Array.isArray(record.input) ? hashValue(record.input) : null,
    inputItems: Array.isArray(record.input) ? record.input.length : null,
    inputTypes: inputTypeCounts(record.input),
    tools: Array.isArray(record.tools) ? record.tools.length : null,
    toolsHash: Array.isArray(record.tools) ? hashValue(record.tools) : null,
    promptCacheKeyPresent: typeof promptCacheKey === "string" && promptCacheKey.trim().length > 0,
    promptCacheKeyHash: promptCacheKey ? hashValue(promptCacheKey) : null,
    promptCacheKeyLength: promptCacheKey ? Array.from(promptCacheKey).length : null,
    reasoningHash: record.reasoning === undefined ? null : hashValue(record.reasoning),
    textHash: record.text === undefined ? null : hashValue(record.text),
    model: record.model ?? null,
    store: record.store ?? null,
    stream: record.stream ?? null,
    toolChoice: record.tool_choice ?? record.toolChoice ?? null,
    parallelToolCalls: record.parallel_tool_calls ?? record.parallelToolCalls ?? null,
    serviceTier: record.service_tier ?? record.serviceTier ?? null,
    transport,
  };
}

function addPromptCacheKeyIfMissing(payload: unknown, sessionId: string | undefined): { payload: unknown; added: boolean } {
  const record = asRecord(payload);
  const cacheKey = sessionId?.trim();
  if (!record || !cacheKey) return { payload, added: false };
  const existing = typeof record.prompt_cache_key === "string" ? record.prompt_cache_key : undefined;
  if (existing && existing.trim().length > 0) return { payload, added: false };
  return { payload: { ...record, prompt_cache_key: Array.from(cacheKey).slice(0, 64).join("") }, added: true };
}

function roleCounts(messages: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const msg of messages) {
    const role = typeof msg?.role === "string" ? msg.role : "unknown";
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

function safeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildContextSnapshot(ctx: ExtensionContext, systemPrompt: string, resolvedMessages: any[], llmMessages: any[], draft: string, tools: any[]) {
  const branch = ctx.sessionManager.getBranch();
  const last = branch[branch.length - 1];
  const serializedPrefix = JSON.stringify({ systemPrompt, messages: llmMessages, tools });
  return {
    contextSource: "sessionManager.buildSessionContext()+convertToLlm()",
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    leafId: ctx.sessionManager.getLeafId(),
    branchEntries: branch.length,
    branchLastEntryId: last?.id ?? null,
    branchLastType: last?.type ?? null,
    rawUserAssistantMessages: extractRawMessages(ctx).length,
    resolvedMessages: resolvedMessages.length,
    resolvedRoles: roleCounts(resolvedMessages),
    llmMessages: llmMessages.length,
    llmRoles: roleCounts(llmMessages),
    tools: tools.length,
    toolsHash: hashValue(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))),
    systemPromptHash: hashValue(systemPrompt),
    prefixHash: hashValue(serializedPrefix),
    prefixChars: serializedPrefix.length,
    draftHash: hashValue(draft),
    draftChars: draft.length,
  };
}

async function appendCacheBacklog(entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(CACHE_BACKLOG_PATH), { recursive: true });
    await appendFile(CACHE_BACKLOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // Logging must never break prompt enhancement.
  }
}

function formatUsage(usage: EnhanceUsage): string {
  const status = usage.cacheRead > 0 ? "HIT" : "MISS";
  const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
  return `Cache ${status}: ${usage.cacheRead.toLocaleString()} read, ${usage.input.toLocaleString()} fresh, ${usage.cacheWrite.toLocaleString()} write (${totalInput.toLocaleString()} total input-ish)`;
}
function shouldLogMainProviderPayload(): boolean {
  return process.env.PI_ENHANCE_CACHE_DEBUG_MAIN === "1";
}

// ── Clipboard safety ───────────────────────────────────────────────────

function saveToClipboard(text: string): void {
  // ponytail: best-effort clipboard, silent on failure — it's a safety net, not a feature.
  try {
    if (process.platform === "darwin") {
      execSync("pbcopy", { input: text, timeout: 2000 });
    } else {
      try { execSync("xclip -selection clipboard", { input: text, timeout: 2000 }); }
      catch { try { execSync("xsel --clipboard --input", { input: text, timeout: 2000 }); }
      catch { execSync("wl-copy", { input: text, timeout: 2000 }); } }
    }
  } catch { /* silent */ }
}

// ── Templates ──────────────────────────────────────────────────────────

function extractTemplate(text: string): { guidelines: string | null; draft: string } {
  const match = text.match(/^\*(\w[\w-]*)\s+([\s\S]*)/);
  if (!match) return { guidelines: null, draft: text };
  const [, name, rest] = match;
  try {
    const content = readFileSync(join(TEMPLATE_DIR, `${name}.md`), "utf8").trim();
    return { guidelines: content, draft: rest.trim() };
  } catch {
    return { guidelines: null, draft: text };
  }
}

function applyTemplate(guidelines: string, draft: string): string {
  if (guidelines.includes("{{input}}")) {
    return guidelines.replace(/\{\{input\}\}/g, draft);
  }
  return `${guidelines}\n\n${draft}`;
}
function listTemplates(): { name: string; description: string }[] {
  try {
    return readdirSync(TEMPLATE_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const name = f.slice(0, -3);
        try {
          const content = readFileSync(join(TEMPLATE_DIR, f), "utf8");
          const firstLine = content.split("\n").find((l) => l.trim()) ?? "";
          return { name, description: firstLine.trim().slice(0, 60) };
        } catch {
          return { name, description: "" };
        }
      });
  } catch {
    return [];
  }
}

// ── Failure helpers ────────────────────────────────────────────────────

function classifyEmptyOutput(stopReason: string | undefined, hadToolCalls: boolean): string {
  if (hadToolCalls) return "Model tried to call tools instead of producing text";
  if (stopReason === "length") return "Output truncated (length limit)";
  if (stopReason === "content_filter") return "Output blocked by content filter";
  return `No text output (stop: ${stopReason ?? "unknown"})`;
}

// ── Editor safety ──────────────────────────────────────────────────────

function safeReplaceEditor(ctx: ExtensionContext, expectedText: string, replacement: string): boolean {
  const current = ctx.ui.getEditorText();
  if (current.trim() !== expectedText.trim()) {
    saveToClipboard(replacement);
    return false;
  }
  ctx.ui.setEditorText(replacement);
  return true;
}

function looksLikeRecursiveEnhancerPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.includes("[[REWRITE]]") ||
    trimmed.includes("<mentality>") ||
    trimmed.includes("<draft_to_rewrite>");
}

function enhancementCooldownKey(ctx: ExtensionContext, text: string): string {
  return `${ctx.sessionManager.getSessionId()}:${hashValue(text.trim())}`;
}

function checkAndMarkEnhancementCooldown(ctx: ExtensionContext, text: string): { ok: boolean; key: string; remainingMs?: number } {
  const key = enhancementCooldownKey(ctx, text);
  const now = Date.now();
  for (const [k, ts] of recentEnhanceAttempts) {
    if (now - ts > RECENT_ENHANCE_COOLDOWN_MS * 3) recentEnhanceAttempts.delete(k);
  }
  const last = recentEnhanceAttempts.get(key);
  if (last !== undefined && now - last < RECENT_ENHANCE_COOLDOWN_MS) {
    return { ok: false, key, remainingMs: RECENT_ENHANCE_COOLDOWN_MS - (now - last) };
  }
  recentEnhanceAttempts.set(key, now);
  return { ok: true, key };
}

async function skipEnhance(ctx: ExtensionContext, source: string, reason: string, text: string, extra: Record<string, unknown> = {}): Promise<EnhanceFailure> {
  const draftHash = hashValue(text.trim());
  await appendCacheBacklog({
    event: "skip",
    source,
    reason,
    sessionId: ctx.sessionManager.getSessionId(),
    leafId: ctx.sessionManager.getLeafId(),
    branchEntries: ctx.sessionManager.getBranch().length,
    draftHash,
    draftChars: text.length,
    ...extra,
  });
  ctx.ui.notify(`draft-lift: ${reason}`, "warning");
  return { reason, category: reason, attemptId: "skip" };
}


// ── Enhancement ────────────────────────────────────────────────────────

/**
 * Resolve the stream function the main session would use for this model.
 * Extension-registered providers (e.g. commandcode's `commandcode-custom` api)
 * own their streamSimple in the host model registry; the pi-ai compat registry
 * only knows builtin apis, so calling compat streamSimple directly would throw
 * "No API provider registered for api: ..." for them. Builtin providers keep
 * using compat's streamSimple.
 */
export function resolveStreamFn(ctx: ExtensionContext, model: { provider: string }) {
  const registered = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
  if (registered?.streamSimple) return registered.streamSimple;
  const native = ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
  if (native?.streamSimple) return native.streamSimple;
  return streamSimple;
}

type EnhanceOptions = {
  feedback?: { previousCandidate: string; userFeedback: string };
  noTools?: boolean;
};

async function doEnhance(
  text: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  source = "unknown",
  options?: EnhanceOptions,
): Promise<EnhanceOutcome> {
  const attemptId = `${Date.now().toString(36)}-${++enhanceAttemptSeq}`;
  if (looksLikeRecursiveEnhancerPrompt(text)) {
    return skipEnhance(ctx, source, "recursive_enhancer_prompt", text, { attemptId });
  }
  const cooldown = checkAndMarkEnhancementCooldown(ctx, text);
  if (!cooldown.ok) {
    return skipEnhance(ctx, source, "duplicate_draft_cooldown", text, { attemptId, cooldownKey: cooldown.key, remainingMs: cooldown.remainingMs });
  }

  const model = ctx.model;
  if (!model) { ctx.ui.notify("No model", "error"); return { reason: "No model selected", category: "no_model", attemptId }; }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) { ctx.ui.notify("No API key", "error"); return { reason: "No API key", category: "no_api_key", attemptId }; }

  // Cache parity: use the main session's system prompt and tools so the
  // provider sees an identical body prefix to the main session's last
  // request. The rewriter role lives in the FINAL user message via
  // buildEnhancementInstruction — that part is uncached by definition
  // (it carries the draft), so putting rewriter rules there costs no
  // cache and still dominates the model's framing.
  const systemPrompt = ctx.getSystemPrompt();
  const activeToolNames = new Set(pi.getActiveTools());
  const tools = pi.getAllTools()
    .filter((tool) => activeToolNames.has(tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));

  const sessionContext = ctx.sessionManager.buildSessionContext();
  const resolvedMessages = sessionContext.messages ?? [];

  const llmMessages = convertToLlm(resolvedMessages as any);

  const thinkingLevel = pi.getThinkingLevel();
  const reasoning = thinkingLevel === "off" ? undefined : thinkingLevel;

  // Template extraction
  const { guidelines, draft } = extractTemplate(text);
  const snapshot = buildContextSnapshot(ctx, systemPrompt, resolvedMessages as any[], llmMessages as any[], draft, tools);

  const instruction = buildEnhancementInstruction(
    draft,
    options?.feedback
      ? { previousCandidate: options.feedback.previousCandidate, userFeedback: options.feedback.userFeedback }
      : undefined,
    guidelines,
    model.id,
  );

  llmMessages.push({
    role: "user",
    content: [{ type: "text" as const, text: instruction }],
  });
  const requestHash = hashValue({ systemPrompt, messages: llmMessages, tools, reasoning });

  await appendCacheBacklog({
    event: "start",
    source,
    attemptId,
    model: { provider: model.provider, id: model.id },
    ...snapshot,
    requestHash,
    sessionIdPassedToProvider: ctx.sessionManager.getSessionId(),
    toolsIncludedToMatchMainTurn: tools.length,
    beforeProviderRequestHooksApplied: false,
    reasoningPassedToProvider: reasoning ?? null,
    transportAssumption: "auto",
    contextHooksApplied: false,
    adjustToolSetHooksApplied: false,
    note: "Conversation/draft content is not logged; hashes and counts only.",
  });

  ctx.ui.setStatus("draft-lift", ctx.ui.theme.fg("accent", "✦ Prompt sidequesting…"));
  ctx.ui.setWidget("draft-lift", [ctx.ui.theme.fg("accent", "✦ Prompt sidequesting…")], { placement: "belowEditor" });
  ctx.ui.setWorkingMessage("Prompt sidequesting...");
  ctx.ui.setWorkingVisible(true);
  ctx.ui.setWorkingIndicator({
    frames: [
      ctx.ui.theme.fg("dim", "↱"),
      ctx.ui.theme.fg("muted", "↗"),
      ctx.ui.theme.fg("accent", "✦"),
      ctx.ui.theme.fg("muted", "↘"),
      ctx.ui.theme.fg("dim", "↲"),
    ],
    intervalMs: 120,
  });

  try {
    const streamFn = resolveStreamFn(ctx, model);
    const resp = await streamFn(model, { systemPrompt, messages: llmMessages, tools }, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: ctx.signal,
      sessionId: ctx.sessionManager.getSessionId(),
      reasoning,
      transport: "auto",
      onPayload: async (payload) => {
        const withCacheKey = addPromptCacheKeyIfMissing(payload, ctx.sessionManager.getSessionId());
        const mirroredBody = mirrorLatestMainBodyWithoutInput(withCacheKey.payload, ctx.sessionManager.getSessionId(), model);
        const finalPayload = mirroredBody.payload;
        const providerAudit = summarizeProviderPayload(finalPayload, "auto");
        await appendCacheBacklog({
          event: "enhancer_provider_payload",
          source,
          attemptId,
          model: { provider: model.provider, id: model.id },
          ...snapshot,
          requestHash,
          providerAudit,
          promptCacheKeyAddedByEnhancerMirror: withCacheKey.added,
          mainBodyWithoutInputMirrorApplied: mirroredBody.applied,
          mainBodyWithoutInputMirrorReason: mirroredBody.reason,
          latestMainProviderAudit: lastMainProviderAudit ? {
            leafId: lastMainProviderAudit.leafId,
            branchEntries: lastMainProviderAudit.branchEntries,
            bodyWithoutInputHash: lastMainProviderAudit.bodyWithoutInputHash,
            instructionsHash: lastMainProviderAudit.instructionsHash,
            tools: lastMainProviderAudit.tools,
            toolsHash: lastMainProviderAudit.toolsHash,
            promptCacheKeyHash: lastMainProviderAudit.promptCacheKeyHash,
            reasoningHash: lastMainProviderAudit.reasoningHash,
            textHash: lastMainProviderAudit.textHash,
            transport: lastMainProviderAudit.transport,
          } : null,
          bodyWithoutInputMatchesLatestMain: lastMainProviderAudit
            ? providerAudit.bodyWithoutInputHash === lastMainProviderAudit.bodyWithoutInputHash
            : null,
          instructionsMatchLatestMain: lastMainProviderAudit
            ? providerAudit.instructionsHash === lastMainProviderAudit.instructionsHash
            : null,
          toolsMatchLatestMain: lastMainProviderAudit
            ? providerAudit.toolsHash === lastMainProviderAudit.toolsHash
            : null,
          promptCacheKeyMatchesLatestMain: lastMainProviderAudit
            ? providerAudit.promptCacheKeyHash === lastMainProviderAudit.promptCacheKeyHash
            : null,
          reasoningMatchesLatestMain: lastMainProviderAudit
            ? providerAudit.reasoningHash === lastMainProviderAudit.reasoningHash
            : null,
        });
        return finalPayload;
      },
    }).result();
    const usage: EnhanceUsage = {
      input: resp.usage?.input ?? 0,
      cacheRead: resp.usage?.cacheRead ?? 0,
      cacheWrite: resp.usage?.cacheWrite ?? 0,
      output: resp.usage?.output ?? 0,
      totalTokens: resp.usage?.totalTokens ?? 0,
    };
    const hadToolCalls = resp.content.some((c: any) => c.type === "tool_use");
    const rawText = resp.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n").trim();
    // Extract content from sentinel if present; fall back to raw text for models that ignore the marker.
    const sentinelMatch = rawText.match(/\[\[REWRITE\]\]([\s\S]*?)\[\[\/REWRITE\]\]/);
    const enhanced = clean(sentinelMatch ? sentinelMatch[1].trim() : rawText);
    const answeredInsteadOfRewriting = !sentinelMatch && rawText.length > 0;
    await appendCacheBacklog({
      event: "result",
      source,
      attemptId,
      model: { provider: model.provider, id: model.id },
      ...snapshot,
      requestHash,
      usage,
      cacheHit: usage.cacheRead > 0,
      stopReason: resp.stopReason ?? null,
      responseId: (resp as any).responseId ?? null,
      emptyOutput: !enhanced,
      hadToolCalls,
      sentinelFound: !!sentinelMatch,
      answeredInsteadOfRewriting,
    });
    if (!enhanced) {
      const reason = answeredInsteadOfRewriting
        ? "Model answered the draft instead of rewriting it"
        : classifyEmptyOutput(resp.stopReason, hadToolCalls);
      return { reason, category: answeredInsteadOfRewriting ? "answered_not_rewrote" : "empty_output", attemptId };
    }
    return { text: enhanced, usage, logPath: CACHE_BACKLOG_PATH, attemptId };
  } catch (err) {
    await appendCacheBacklog({
      event: "error",
      attemptId,
      source,
      model: { provider: model.provider, id: model.id },
      ...snapshot,
      requestHash,
      error: safeError(err),
    });
    return { reason: safeError(err), category: "provider_error", attemptId };
  } finally {
    ctx.ui.setStatus("draft-lift", undefined);
    ctx.ui.setWidget("draft-lift", undefined);
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
  }
}

// ── Shared enhance+recover ─────────────────────────────────────────────

async function enhanceWithRecovery(
  text: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  source: string,
  options?: EnhanceOptions,
): Promise<EnhanceResult | null> {
  let outcome = await doEnhance(text, ctx, pi, source, options);
  if ("text" in outcome) return outcome;

  // Graceful recovery: retry without tools (most common cause of empty output).
  if (!options?.noTools) {
    outcome = await doEnhance(text, ctx, pi, source, { ...options, noTools: true });
    if ("text" in outcome) return outcome;
  }

  // All attempts failed — surface the reason.
  ctx.ui.notify(`Enhancement failed: ${outcome.reason}`, "warning");
  return null;
}

// ── Extension registration ─────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Template autocomplete: * at start of text shows available templates.
  // Pattern mirrors the $skill inline-skills extension: delegate to current
  // provider when our trigger doesn't match, implement only our own expansion.
  const TEMPLATE_COMPLETION = /^\s*\*([a-z0-9-]*)$/;
  pi.on("session_start", (_event, ctx) => {
    originalText = undefined;
    if (ctx.mode !== "tui") return;

    ctx.ui.addAutocompleteProvider((current) => ({
      ...current,
      triggerCharacters: [...(current.triggerCharacters ?? []), "*"],

      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
        const query = beforeCursor.match(TEMPLATE_COMPLETION)?.[1];
        if (query === undefined) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const templates = listTemplates();
        if (templates.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        const items = templates
          .filter((t) => t.name.startsWith(query))
          .map((t) => ({
            value: `*${t.name}`,
            label: `*${t.name}`,
            description: t.description || undefined,
          }));

        return items.length > 0
          ? { prefix: `*${query}`, items }
          : current.getSuggestions(lines, cursorLine, cursorCol, options);
      },

      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const audit: MainProviderAudit = {
      ...summarizeProviderPayload(event.payload, "main-agent-config"),
      leafId: ctx.sessionManager.getLeafId(),
      branchEntries: branch.length,
      sessionIdHash: hashValue(ctx.sessionManager.getSessionId()),
      modelProvider: ctx.model?.provider,
      modelId: ctx.model?.id,
    };
    lastMainProviderAudit = audit;
    const bodyWithoutInput = stripProviderInputFields(event.payload);
    if (bodyWithoutInput) {
      lastMainProviderMirror = {
        sessionIdHash: audit.sessionIdHash,
        modelProvider: ctx.model?.provider,
        modelId: ctx.model?.id,
        bodyWithoutInput,
      };
    }
    if (shouldLogMainProviderPayload()) {
      await appendCacheBacklog({
        event: "main_provider_payload",
        source: "before_provider_request",
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
        leafId: audit.leafId,
        branchEntries: audit.branchEntries,
        sessionIdHash: audit.sessionIdHash,
        providerAudit: audit,
        note: "Normal assistant provider payload after earlier before_provider_request hooks; content is hashed only.",
      });
    }
    return undefined;
  });

  pi.registerCommand("prompt-sidequest", {
    description: "Sidequest from current context to improve editor prompt draft",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const text = args?.trim() || ctx.ui.getEditorText()?.trim();

      if (text === "log" || text === "backlog") {
        ctx.ui.notify(`draft-lift backlog: ${CACHE_BACKLOG_PATH}`, "info");
        return;
      }

      if (text === "diag") {
        const branch = ctx.sessionManager.getBranch();
        const resolved = ctx.sessionManager.buildSessionContext().messages ?? [];
        const raw = extractRawMessages(ctx);
        const roles = Object.entries(roleCounts(resolved as any[])).map(([r, n]) => `${r}:${n}`).join(", ");
        const convo = extractMessages(ctx);
        ctx.ui.notify(
          `Tree/thread: ${branch.length} branch entries, ${resolved.length} resolved messages (${roles || "none"}), ` +
          `${raw.length} raw user/assistant messages, ${convo.length} text chars. Backlog: ${CACHE_BACKLOG_PATH}`,
          "info"
        );
        return;
      }

      if (text === "cache-diag") {
        if (enhancing) { ctx.ui.notify("Already enhancing", "warning"); return; }
        const editorText = ctx.ui.getEditorText()?.trim();
        if (!editorText) { ctx.ui.notify("Editor empty", "warning"); return; }
        enhancing = true;
        saveToClipboard(editorText);
        try {
          const result = await enhanceWithRecovery(editorText, ctx, pi, "command:cache-diag");
          if (result) {
            const replaced = safeReplaceEditor(ctx, editorText, result.text);
            ctx.ui.notify(`${formatUsage(result.usage)} — output: ${result.usage.output} tokens. ${replaced ? "Editor updated" : "Editor changed; result copied to clipboard"}. Attempt: ${result.attemptId}.`, replaced ? "info" : "warning");
          }
        } finally { enhancing = false; }
        return;
      }

      if (!text) { ctx.ui.notify("Usage: /prompt-sidequest <draft> or diag/cache-diag/log", "warning"); return; }
      if (enhancing) { ctx.ui.notify("Already enhancing", "warning"); return; }
      enhancing = true; originalText = text;
      saveToClipboard(text);
      try {
        const result = await enhanceWithRecovery(text, ctx, pi, "command");
        if (result) {
          const replaced = args?.trim() ? (ctx.ui.setEditorText(result.text), true) : safeReplaceEditor(ctx, text, result.text);
          ctx.ui.notify(`Enhanced. ${formatUsage(result.usage)}. ${replaced ? "Editor updated" : "Editor changed; result copied to clipboard"}. Attempt: ${result.attemptId}.`, replaced ? "info" : "warning");
        }
        else originalText = undefined;
      } finally { enhancing = false; }
    },
  });

  pi.registerShortcut("ctrl+shift+e", {
    description: "Enhance with streaming, steering, and comparison",
    handler: async (ctx) => {
      if (enhancing) { ctx.ui.notify("Already enhancing", "warning"); return; }
      const text = ctx.ui.getEditorText()?.trim();
      if (!text) { ctx.ui.notify("Editor empty", "warning"); return; }
      enhancing = true; originalText = text;
      saveToClipboard(text);
      try {
        const outcome = await enhancementOverlay(text, ctx, pi);
        if (outcome.result) {
          ctx.ui.setEditorText(outcome.result);
          ctx.ui.notify("Enhanced.", "info");
        }
      } finally { enhancing = false; }
    },
  });

  // Do not bind ctrl+e: in this Ghostty setup cmd+right sends Ctrl-E (\x05)
  // for end-of-line, which would accidentally trigger enhancement.
  pi.registerShortcut("ctrl+alt+e", {
    description: "Prompt sidequest",
    handler: async (ctx) => {
      if (enhancing) { ctx.ui.notify("Already enhancing", "warning"); return; }
      const text = ctx.ui.getEditorText()?.trim();
      if (!text) { ctx.ui.notify("Editor empty", "warning"); return; }
      enhancing = true; originalText = text;
      saveToClipboard(text);
      try {
        const result = await enhanceWithRecovery(text, ctx, pi, "shortcut:ctrl+alt+e");
        if (result) {
          const replaced = safeReplaceEditor(ctx, text, result.text);
          ctx.ui.notify(`Enhanced. ${formatUsage(result.usage)}. ${replaced ? "Editor updated" : "Editor changed; result copied to clipboard"}. Attempt: ${result.attemptId}.`, replaced ? "info" : "warning");
        }
        else originalText = undefined;
      } finally { enhancing = false; }
    },
  });

  pi.registerShortcut("ctrl+shift+q", {
    description: "Prompt sidequest",
    handler: async (ctx) => {
      if (enhancing) { ctx.ui.notify("Already enhancing", "warning"); return; }
      const text = ctx.ui.getEditorText()?.trim();
      if (!text) { ctx.ui.notify("Editor empty", "warning"); return; }
      enhancing = true; originalText = text;
      saveToClipboard(text);
      try {
        const result = await enhanceWithRecovery(text, ctx, pi, "shortcut:ctrl+shift+q");
        if (result) {
          const replaced = safeReplaceEditor(ctx, text, result.text);
          ctx.ui.notify(`Enhanced. ${formatUsage(result.usage)}. ${replaced ? "Editor updated" : "Editor changed; result copied to clipboard"}. Attempt: ${result.attemptId}.`, replaced ? "info" : "warning");
        }
        else originalText = undefined;
      } finally { enhancing = false; }
    },
  });

  pi.registerShortcut("ctrl+shift+z", {
    description: "Revert",
    handler: async (ctx) => {
      if (!originalText) { ctx.ui.notify("Nothing to revert", "warning"); return; }
      ctx.ui.setEditorText(originalText);
      originalText = undefined;
    },
  });
}
