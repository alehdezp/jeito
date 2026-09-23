import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  GOAL_REMINDER,
  REFRESH_ENTRY_TYPE,
  TOKEN_INTERVAL,
  buildReminderCapsule,
  collectSessionMetrics,
  formatCount,
  latestRefreshBucket,
  reminderSourceHash,
  tokenBucket,
} from "./append-salience.ts";

// Reminders enter once at Pi's persistent conversation boundary. Rewriting
// the latest user item in each provider request moves the reminder when a new
// user/custom message arrives; changing system instructions invalidates an
// even earlier prefix. Neither mechanism belongs in a payload hook.

export const LENS_ENTRY_TYPE = "harness-partner-lens";

const APPEND_PATH = join(getAgentDir(), "APPEND_SYSTEM.md");

const TOTEM = `⟡ Partner — not executor. "The more constraints one imposes, the more one frees one's self." — Stravinsky. Comprehend before acting — separate interpretation from agreement. ${GOAL_REMINDER} Lead with why, prove it, surface the better alternative even when not asked. Don't say "you're right" until you've checked — ask what would prove it false. Before adding abstraction, configurability, a dependency, benchmark infrastructure, or optimization, prove that it serves the accepted task. Abstraction requires the third real duplication.`;

const TOTEM_MARKER = "⟡ Partner — not executor.";

export function partnerMarkerLabel(customType: string): string {
  return customType === REFRESH_ENTRY_TYPE ? "⟡ Partner refresh" : "⟡ Partner lens";
}

// Bright purple via ANSI bright-magenta; theme palettes have no stable
// "purple" style name. Single line, no padding — Text(label, 0, 0).
const ANSI_BRIGHT_PURPLE = "\x1b[95m";
const ANSI_RESET = "\x1b[0m";

export function partnerMarkerLine(customType: string): string {
  return `${ANSI_BRIGHT_PURPLE}${partnerMarkerLabel(customType)}${ANSI_RESET}`;
}

function isSteerText(text: string): boolean {
  return /^\s*\/steer\b/i.test(text) || /^\s*steer:/i.test(text);
}

function branchEntries(ctx: any): any[] {
  return ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
}

export default function promptRuntime(pi: ExtensionAPI) {
  const renderMarker = (entry: any, _view: any, _theme: any) => {
    // Bright purple, single line, zero padding.
    return new Text(partnerMarkerLine(entry?.customType ?? ""), 0, 0);
  };
  pi.registerEntryRenderer(LENS_ENTRY_TYPE, renderMarker as never);
  pi.registerEntryRenderer(REFRESH_ENTRY_TYPE, renderMarker as never);

  pi.on("before_agent_start", async (event, ctx) => {
    const parts: string[] = [];
    const prompt = event.prompt ?? "";
    const addLens = !isSteerText(prompt) && !prompt.includes(TOTEM_MARKER);
    if (addLens) parts.push(TOTEM);

    let refresh: Record<string, unknown> | undefined;
    try {
      const entries = branchEntries(ctx);
      const session = collectSessionMetrics(entries);
      const usageTokens = ctx?.getContextUsage?.()?.tokens;
      const tokens = typeof usageTokens === "number" ? usageTokens : session.rawTokens;
      const bucket = tokenBucket(tokens);
      if (bucket > latestRefreshBucket(entries, session.compactionId)) {
        const options: any = (event as any).systemPromptOptions ?? {};
        const source = String(options.appendSystemPrompt ?? "").trim()
          ? String(options.appendSystemPrompt)
          : readFileSync(APPEND_PATH, "utf8");
        const capsule = buildReminderCapsule(source);
        parts.push(capsule);
        refresh = {
          bucket,
          compactionId: session.compactionId,
          contextTokens: tokens,
          rawTokens: session.rawTokens,
          toolCalls: session.toolCalls,
          sourceHash: reminderSourceHash(capsule),
        };
      }
    } catch {
      // Missing/unreadable APPEND must not suppress the independent lens.
    }

    if (!parts.length) return undefined;
    const content = parts.join("\n\n");
    if (addLens) pi.appendEntry(LENS_ENTRY_TYPE, { at: Date.now() });
    if (refresh) {
      pi.appendEntry(REFRESH_ENTRY_TYPE, refresh);
      ctx?.ui?.notify?.(
        `⟡ salience refresh · ${formatCount(refresh.contextTokens as number)} tok · bucket ${refresh.bucket} (${TOKEN_INTERVAL / 1000}k cadence)`,
        "info",
      );
    }
    // This diagnostic now contains only the newly persisted reminder, never
    // a provider payload or a copy of the user's message.
    if (process.env.GUIDEPIN_DEBUG) {
      try { writeFileSync(process.env.GUIDEPIN_DEBUG, content); } catch {}
    }
    return {
      message: {
        customType: refresh ? REFRESH_ENTRY_TYPE : LENS_ENTRY_TYPE,
        content,
        display: false,
      },
    };
  });
}
