// Global, in-process ledger of tool calls. Fed by the `tool_result` lifecycle
// hook (index.ts), which sees every tool the agent runs and its `toolName`.
//
// Reusable by any tool that needs call-count-aware behavior. The motivating case
// is the explore-map legend: show it on the first explore call, suppress it on
// repeats, and show it again only after the agent has run N calls to OTHER tools
// (so a long explore-heavy stretch doesn't re-spam it, but returning to explore
// after a while does). This generalizes the one-off `docsCadenceCounts` counter
// that previously lived inline in index.ts.

const counts = new Map<string, number>();

interface Gate {
  tool: string;
  shown: boolean;
  otherSinceShown: number;
}
const gates = new Map<string, Gate>();

/** Record one tool call. Called from the `tool_result` hook with `event.toolName`. */
export function recordToolCall(toolName: string): void {
  if (!toolName) return;
  counts.set(toolName, (counts.get(toolName) ?? 0) + 1);
  for (const gate of gates.values()) {
    // Only calls to OTHER tools advance the reset; repeat calls to the gate's
    // own tool never do (so "20 repeated explore calls" still suppresses).
    if (gate.shown && toolName !== gate.tool) gate.otherSinceShown += 1;
  }
}

/** Cumulative call count for a tool this process (0 if never called). */
export function toolCallCount(toolName: string): number {
  return counts.get(toolName) ?? 0;
}

/**
 * First-call gate. Returns `true` the first time `tool` is seen after the gate
 * opens, then `false` for repeat `tool` calls, until `resetAfterOtherCalls`
 * calls to OTHER tools have run — which re-opens the gate (returns `true` again).
 * Calls to `tool` itself never advance the reset counter.
 *
 * `featureKey` scopes the gate so multiple features/tools keep independent state.
 */
export function firstCallGate(featureKey: string, tool: string, resetAfterOtherCalls: number): boolean {
  let gate = gates.get(featureKey);
  if (!gate) {
    gate = { tool, shown: false, otherSinceShown: 0 };
    gates.set(featureKey, gate);
  }
  if (!gate.shown) {
    gate.shown = true;
    gate.otherSinceShown = 0;
    return true;
  }
  if (gate.otherSinceShown >= resetAfterOtherCalls) {
    gate.otherSinceShown = 0;
    return true;
  }
  return false;
}

/** Clear all counts and gates. Test hook. */
export function resetToolCallLedger(): void {
  counts.clear();
  gates.clear();
}
