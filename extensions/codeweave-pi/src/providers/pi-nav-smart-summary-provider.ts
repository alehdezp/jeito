import { nativeRecords } from "../core/pi-nav-evidence.ts";
import { callPiNav, type PiNavCaller } from "../core/pi-nav-native.ts";
import { detectProjectRoot } from "../core/project-root.ts";
import type { SmartSummaryProvider, SummaryEntry, SummaryEntryKind, SummaryInput, SummaryResult } from "../core/smart-summary-provider.ts";
import { CONFIG_EXTENSIONS, MARKDOWN_EXTENSIONS, SOURCE_EXTENSIONS, cleanLabel } from "./local-provider-utils.ts";

const PROVIDER_PRIORITY = 20;
const DEFAULT_TIMEOUT_MS = 900;
const DEFAULT_BUDGET = 24_000;

export interface PiNavSmartSummaryProviderOptions {
  callNative?: PiNavCaller;
  timeoutMs?: number;
  budget?: number;
}

export function createPiNavSmartSummaryProvider(
  options: PiNavSmartSummaryProviderOptions = {},
): SmartSummaryProvider {
  const callNative = options.callNative ?? callPiNav;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const budget = Math.max(1, options.budget ?? DEFAULT_BUDGET);
  return {
    name: "native-smart-read",
    priority: PROVIDER_PRIORITY,
    canHandle(input) {
      return input.kind === "file" && relevantExtension(input.extension ?? "");
    },
    async summarize(input, signal) {
      try {
        const output = await callNative({
          root: detectProjectRoot(input.absolutePath).root,
          operation: "pi_nav_read",
          args: { path: input.absolutePath, mode: "auto", budget },
          timeoutMs,
          signal,
        });
        return summaryFromNative(output.structured.data, input);
      } catch {
        return null;
      }
    },
  };
}

export const piNavSmartSummaryProvider = createPiNavSmartSummaryProvider();

export function summaryFromNative(data: Record<string, unknown>, input: SummaryInput): SummaryResult | null {
  const file = nativeRecords(data.files)[0];
  if (!file) return null;
  const totalLines = totalLinesFor(file) ?? input.lines.length;
  const entries = nativeRecords(file.outlineEntries).flatMap(entry => summaryEntry(entry, totalLines));
  if (!entries.length) return null;
  const completeness = file.completeness && typeof file.completeness === "object"
    ? file.completeness as Record<string, unknown>
    : {};
  return {
    title: titleForInput(input),
    entries,
    totalEntries: entries.length,
    totalLines,
    truncated: completeness.complete === false,
    providerName: "native-smart-read",
  };
}

function summaryEntry(entry: Record<string, unknown>, totalLines?: number): SummaryEntry[] {
  const start = positiveInteger(entry.start);
  const end = positiveInteger(entry.end);
  const label = typeof entry.label === "string" ? cleanLabel(entry.label) : "";
  if (!start || !end || !label || end < start || (totalLines !== undefined && end > totalLines)) return [];
  return [{
    start,
    end,
    label,
    kind: summaryKind(typeof entry.kind === "string" ? entry.kind : undefined),
    confidence: "high",
  }];
}

function summaryKind(kind?: string): SummaryEntryKind {
  switch (kind) {
    case "import": return "import";
    case "function":
    case "method": return "function";
    case "class":
    case "struct":
    case "impl":
    case "object": return "class";
    case "heading": return "heading";
    case "interface":
    case "type":
    case "trait":
    case "enum": return "type";
    case "config": return "config";
    default: return "text";
  }
}

function totalLinesFor(file: Record<string, unknown>): number | undefined {
  return positiveInteger(file.totalLines ?? file.total_lines);
}

function relevantExtension(ext: string): boolean {
  return SOURCE_EXTENSIONS.has(ext) || MARKDOWN_EXTENSIONS.has(ext) || CONFIG_EXTENSIONS.has(ext);
}

function titleForInput(input: SummaryInput): string {
  const ext = input.extension ?? "";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown summary";
  if (CONFIG_EXTENSIONS.has(ext)) return "config summary";
  if (SOURCE_EXTENSIONS.has(ext)) return "source summary";
  return "summary";
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}
