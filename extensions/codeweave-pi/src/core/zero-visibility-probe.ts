import type { PiNavCaller } from "./pi-nav-native.ts";

export type ZeroProbeOutcome = {
  kind: "hits" | "verified-zero" | "failed";
  text: string;
  diagnostic: string;
};

// Fires only on a complete, project-filtered zero — non-zero results never pay
// for it. One bounded re-scan with configurable ignores disabled retires the
// classic false negative: "absent" that is actually "ignored" (node_modules,
// .runtime, generated trees). A timeout or backend failure degrades to the
// pre-probe zero plus an explicit retry hint; it never masks the primary result.
export async function probeZeroVisibility(input: {
  callNative: PiNavCaller;
  root: string;
  operation: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  sampleLimit?: number;
}): Promise<ZeroProbeOutcome> {
  const sampleLimit = input.sampleLimit ?? 8;
  try {
    const output = await input.callNative({
      root: input.root,
      operation: input.operation,
      args: { ...input.args, visibility: "all" },
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    const completeness = (output.structured?.completeness ?? {}) as Record<string, unknown>;
    const returned = Number(completeness.returned ?? 0);
    if (returned > 0) {
      const samples = extractSamplePaths(output.structured, output.text, sampleLimit);
      const sampleBlock = samples.length ? `\n${samples.map(path => `- ${path}`).join("\n")}` : "";
      return {
        kind: "hits",
        diagnostic: `zero_visibility_probe=hits(${returned})`,
        text: `\n\nIgnored-scope escalation: the project-filtered scan returned zero, but ${returned} match(es) exist with configurable ignores disabled (automatic visibility:'all' probe).${sampleBlock}\nThe zero was filter-caused, not absence.`,
      };
    }
    return {
      kind: "verified-zero",
      diagnostic: "zero_visibility_probe=verified_zero",
      text: "\n\nIgnored-scope escalation: also zero with configurable ignores disabled — absence is verified across both filtered and unfiltered scopes.",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: "failed",
      diagnostic: "zero_visibility_probe=failed",
      text: `\n\nIgnored-scope auto-probe failed (${reason}); rerun with visibility:'all' to confirm the zero.`,
    };
  }
}

export function shouldProbeZero(params: {
  returned: number;
  complete: boolean;
  visibility: string;
  isContinuation?: boolean;
}): boolean {
  return params.returned === 0
    && params.complete
    && params.visibility === "project"
    && params.isContinuation !== true;
}

// Structured entries carry path/file fields across pi_nav_search, pi_nav_files,
// and pi_nav_ls; matches-mode text falls back to file:line references.
function extractSamplePaths(structured: unknown, nativeText: string, limit: number): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const push = (path: unknown): void => {
    if (typeof path !== "string" || !path || seen.has(path)) return;
    seen.add(path);
    found.push(path);
  };
  const visit = (value: unknown, depth: number): void => {
    if (found.length >= limit * 3 || depth > 6 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    push(record.path);
    push(record.file);
    for (const item of Object.values(record)) visit(item, depth + 1);
  };
  visit((structured as { data?: unknown })?.data, 0);
  if (found.length < limit) {
    for (const match of String(nativeText).matchAll(/(?:^|[\s[(])([^\s:[\]|()]+?\.[A-Za-z0-9]{1,10}):\d+/g)) {
      push(match[1]);
      if (found.length >= limit) break;
    }
  }
  return found.slice(0, limit);
}
