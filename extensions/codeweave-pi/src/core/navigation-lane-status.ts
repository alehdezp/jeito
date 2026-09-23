import { existsSync } from "node:fs";

import { loadNavigationAutomationConfig } from "./navigation-automation-config.ts";
import { resolvePreparedLane, type NavigationLane, type PreparedLaneReady } from "./navigation-config.ts";

const LANES: { key: string; lane: NavigationLane }[] = [
  { key: "graph", lane: "graph" },
  { key: "docs", lane: "docs" },
];

export async function compactNavigationLaneStatus(scope: string, options: { env?: Record<string, string | undefined> } = {}): Promise<string> {
  const env = options.env ?? process.env;
  const loaded = loadNavigationAutomationConfig({ env });
  const parts: string[] = [];
  for (const item of LANES) {
    const status = await resolvePreparedLane(scope, item.lane, { env }).catch(error => ({ ok: false as const, reason: String(error?.message ?? error) }));
    parts.push(`${item.key}${status.ok ? readyLaneMarker(item.lane, status) : laneMarker(status.reason)}`);
  }
  const auto = loaded.config.automation.mode !== "disabled" && loaded.config.automation.autoPrepareOnFirstBroadRequest ? "first-broad✓" : "first-broad–";
  const cloud = loaded.config.providers.allowCloud || loaded.config.providers.allowLLM ? ` cloud${loaded.config.providers.allowCloud && loaded.config.providers.allowLLM ? "✓" : "~"}` : "";
  return `Nav: ${parts.join(" ")} | auto:${auto}${cloud}`;
}

export function compactNavigationLaneLegend(): string {
  return "Nav legend: graph=Graphify map, docs=QMD Markdown sections; Core code status is reported separately. ✓ ready, – missing/disabled, ! stale/error.";
}

function readyLaneMarker(lane: NavigationLane, status: PreparedLaneReady): string {
  if (lane === "graph" && status.graphPath && !existsSync(status.graphPath)) return "!";
  return "✓";
}

function laneMarker(reason: string | undefined): string {
  const text = reason ?? "";
  if (/stale|freshness|invalid|error/i.test(text)) return "!";
  if (/disabled|not configured|without|missing/i.test(text)) return "–";
  return "–";
}
