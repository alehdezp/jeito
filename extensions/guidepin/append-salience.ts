import { createHash } from "node:crypto";

export const REFRESH_ENTRY_TYPE = "append-salience-refresh";
export const TOKEN_INTERVAL = 30_000;
export const START_OFFSET = 50_000;
export const MAX_REMINDER_TOKENS = 1200;

const REMINDER_HEADER = `APPEND SALIENCE REFRESH — not a new task. The reminder itself is not new intent or permission. Do not reopen closed claims, repeat completed work, or narrate this refresh merely because it appeared. Continue from current evidence and user intent; the reminder does not request file maintenance.`;

// One compact reminder for both runtime paths; APPEND owns the full contract.
export const GOAL_REMINDER = `Work toward the intended outcome, not merely the current plan. Check your interpretation against user input and evidence; name consequential uncertainty and revise a mistaken framing proactively. Goal files preserve that understanding for continuation—this reminder is not a request to update them.`;

type Entry = {
  id?: string;
  type: string;
  message?: unknown;
  content?: unknown;
  summary?: unknown;
  firstKeptEntryId?: string;
  customType?: string;
  data?: Record<string, unknown>;
};

export interface SessionMetrics {
  rawTokens: number;
  toolCalls: number;
  compactionId: string;
}

export function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Adapted from pi-blackhole 0.3.9's MIT-licensed token accounting.
export function estimateEntryTokens(entry: Entry): number {
  if (entry.type === "message" && entry.message) {
    return estimateStringTokens(JSON.stringify(entry.message));
  }
  if (entry.type === "custom_message" && entry.content) {
    if (typeof entry.content === "string") return estimateStringTokens(entry.content);
    if (Array.isArray(entry.content)) {
      return entry.content.reduce((total, block) => {
        if (!block || typeof block !== "object") return total;
        const text = (block as { type?: string; text?: string }).type === "text"
          ? (block as { text?: string }).text
          : undefined;
        return total + (text ? estimateStringTokens(text) : 0);
      }, 0);
    }
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return estimateStringTokens(entry.summary);
  }
  return 0;
}

export function activeEntryStart(entries: Entry[]): { start: number; compactionId: string } {
  let compactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex === -1) return { start: 0, compactionId: "none" };

  const compaction = entries[compactionIndex];
  const firstKeptIndex = compaction.firstKeptEntryId
    ? entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
    : -1;
  return {
    start: firstKeptIndex === -1 ? compactionIndex + 1 : firstKeptIndex,
    compactionId: compaction.id ?? `compaction:${compactionIndex}`,
  };
}

export function collectSessionMetrics(entries: Entry[]): SessionMetrics {
  const { start, compactionId } = activeEntryStart(entries);
  let rawTokens = 0;
  let toolCalls = 0;

  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary") {
      rawTokens += estimateEntryTokens(entry);
    }
    if (
      entry.type === "message"
      && entry.message
      && typeof entry.message === "object"
      && (entry.message as { role?: string }).role === "toolResult"
    ) {
      toolCalls += 1;
    }
  }

  return { rawTokens, toolCalls, compactionId };
}

export function tokenBucket(tokens: number, interval = TOKEN_INTERVAL): number {
  if (tokens < START_OFFSET) return 0;
  return 1 + Math.floor((tokens - START_OFFSET) / interval);
}

export function latestRefreshBucket(entries: Entry[], compactionId: string): number {
  let latest = 0;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== REFRESH_ENTRY_TYPE) continue;
    if (entry.data?.compactionId !== compactionId) continue;
    const bucket = entry.data?.bucket;
    if (typeof bucket === "number" && bucket > latest) latest = bucket;
  }
  return latest;
}

function markdownSection(source: string, heading: string): string | undefined {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return undefined;
  const level = heading.match(/^#+/)![0].length;
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    const nextHeading = lines[end].match(/^(#{1,6})\s+/);
    if (nextHeading && nextHeading[1].length <= level) break;
  }
  return lines.slice(start, end).join("\n").trim();
}

export function buildReminderCapsule(appendSource: string, maxTokens = MAX_REMINDER_TOKENS): string {
  const thinkHeader = markdownSection(appendSource, "### Think like the partner");
  const anchors = markdownSection(appendSource, "## At every stop")
    ?.split("\n").filter((line) => line.startsWith("- ")).join("\n");
  const partnerLens = thinkHeader ? thinkHeader.split("\n").slice(0, 12).join("\n").trim() : "";
  const stuckGuard = `When stuck, stop and reframe — don't rock the head. If two approaches failed on the same premise, reframe before a third local try. If what you don't understand is not in the project and current evidence is not enough, be honest and get help from the web/docs for that specific unknown — you don't need the user to tell you. websift is part of this problem's solution, not the whole project.`;
  const overengGuard = `Before adding an abstraction, configurability, a dependency, benchmark infrastructure, or optimization, prove that it serves the accepted task. Abstraction requires the third real duplication. Simplicity is prerequisite for reliability.`;
  const proveLens = `Check real bytes, not model: "The map is not the territory." — Korzybski. "The first principle is that you must not fool yourself." — Feynman. What would change your mind? What check would falsify the load-bearing certainty? Extraordinary claims require extraordinary evidence. — Sagan. Don't agree until you've asked what would prove it false.`;
  const core = [REMINDER_HEADER, GOAL_REMINDER, stuckGuard, overengGuard, proveLens];
  const wrap = (parts: Array<string | undefined>) => `<append-salience-refresh>\n${parts.filter(Boolean).join("\n\n")}\n</append-salience-refresh>`;
  const full = wrap([...core, partnerLens, anchors]);
  if (estimateStringTokens(full) <= maxTokens) return full;
  // Drop optional excerpts, never the anti-steering or intent boundary.
  const fallback = wrap(core);
  if (estimateStringTokens(fallback) <= maxTokens) return fallback;
  throw new Error(`APPEND reminder exceeds ${maxTokens} estimated tokens`);
}

export function reminderSourceHash(capsule: string): string {
  return createHash("sha256").update(capsule).digest("hex").slice(0, 12);
}

export function formatCount(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}
