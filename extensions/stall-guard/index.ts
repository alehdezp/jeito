import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Keeps a session alive when a provider stream stalls.
 *
 * A stall watchdog aborts a stream that has gone silent and rewrites the resulting
 * aborted message into a retryable provider error tagged `[stall-watchdog-retry]`.
 * That tag buys no retry: the watchdog aborts through the session, and every Pi retry
 * path stands down while an abort is requested (`_agentRunAbortRequested` in
 * agent-session), so an aborted turn is never retried at any layer. The run settles
 * with the tagged error as the last message and the session waits for a human to type
 * something.
 *
 * This guard takes over at exactly that point. `agent_settled` is the only event
 * guaranteed to fire after no automatic retry, compaction, or queued continuation
 * will run, so a resume issued there cannot interleave with Pi's own retry.
 *
 * Bounds: at most MAX_CONSECUTIVE_RESUMES resumes in a row. Any completed turn, or
 * input that did not come from an extension, resets the bound, so a session that
 * makes any progress keeps recovering instead of dying.
 */
export const MAX_CONSECUTIVE_RESUMES = 3;

/**
 * The subset of a finalized assistant message this guard reads.
 *
 * Deliberately structural: a monorepo install can resolve two copies of
 * `@earendil-works/pi-ai` (hoisted, and nested under pi-coding-agent), and harness
 * events carry the nested instance's types. Matching only primitive fields keeps
 * both copies assignable instead of forcing a cast.
 */
export interface FinalAssistantMessage {
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
}

/** Tag written by the stall watchdog when it aborts a silent provider stream. */
const STALL_TAG_PATTERN = /\[stall-watchdog-retry\]/;

export const STALL_CONTINUE_PROMPT =
  "Continue from where you left off. The previous attempt was cut off by a stalled provider stream; do not repeat work that is already complete.";

/**
 * Classifies the final assistant message of a run.
 *
 * - `stall` — the run was cut off by the stalled-stream watchdog.
 * - `progress` — anything else, including a completed turn and a user-initiated
 *   abort. A user abort carries no watchdog tag, so it is never resumed.
 * - `none` — not an assistant message.
 */
export function classifyStalledTurn(message: FinalAssistantMessage | undefined): "stall" | "progress" | "none" {
  if (!message) return "none";
  const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "";
  if (message.stopReason === "error" && STALL_TAG_PATTERN.test(errorMessage)) return "stall";
  return "progress";
}

/**
 * Timestamp of the newest assistant message on the active branch, or undefined when
 * the newest message is something else (a user message, a tool result, a custom entry).
 *
 * `ReadonlySessionManager.getBranch()` returns path order root -> leaf, so the newest
 * entry is LAST. Scanning forward from the root reads the system prompt first, which is
 * why this helper must walk backwards: a forward scan never finds the stalled turn on a
 * real branch and silently disables the guard.
 */
export function newestAssistantTimestamp(branch: readonly SessionEntry[]): number | undefined {
  for (const entry of [...branch].reverse()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant") return undefined;
    return message.timestamp;
  }
  return undefined;
}

export default function stallGuard(pi: ExtensionAPI) {
  let runActive = false;
  let stalledAt: number | undefined;
  let consecutiveResumes = 0;
  let warnedExhausted = false;

  const resetResumeBound = () => {
    consecutiveResumes = 0;
    warnedExhausted = false;
  };

  pi.on("session_start", () => {
    runActive = false;
    stalledAt = undefined;
    resetResumeBound();
  });

  pi.on("agent_start", () => {
    runActive = true;
  });

  // A human, or an RPC client, taking over gives the session a fresh bound. Our own
  // continuations arrive as `extension` input and must not extend it.
  pi.on("input", (event) => {
    if (event.source !== "extension") resetResumeBound();
  });

  pi.on("agent_end", (event) => {
    runActive = false;
    const last = event.messages[event.messages.length - 1];
    if (!last || last.role !== "assistant") {
      stalledAt = undefined;
      return;
    }
    if (classifyStalledTurn(last) === "stall") {
      stalledAt = last.timestamp;
      return;
    }
    stalledAt = undefined;
    resetResumeBound();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (runActive || stalledAt === undefined) return;
    const expected = stalledAt;
    stalledAt = undefined;

    // Anything appended after the stall (a user message, a tool result, another turn)
    // means the session already moved on and this stall is no longer the live failure.
    if (newestAssistantTimestamp(ctx.sessionManager.getBranch()) !== expected) return;

    if (consecutiveResumes >= MAX_CONSECUTIVE_RESUMES) {
      if (!warnedExhausted) {
        warnedExhausted = true;
        ctx.ui.notify(
          `stall-guard: ${MAX_CONSECUTIVE_RESUMES} resumes in a row made no progress; waiting for your input`,
          "warning",
        );
      }
      return;
    }

    consecutiveResumes += 1;
    pi.sendUserMessage(STALL_CONTINUE_PROMPT, { deliverAs: "followUp" });
  });
}
