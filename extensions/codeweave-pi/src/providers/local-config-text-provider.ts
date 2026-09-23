import type { SmartSummaryProvider, SummaryEntry } from "../core/smart-summary-provider.ts";
import { cleanLabel, CONFIG_EXTENSIONS, escapeRegExp, leadingSpaces, TEXT_EDGE_LINES } from "./local-provider-utils.ts";

export const localConfigTextProvider: SmartSummaryProvider = {
  name: "local-config-text",
  priority: 50,
  canHandle(input) {
    return input.kind === "file";
  },
  async summarize(input) {
    const lines = input.lines ?? [];
    const ext = input.extension ?? "";
    if (CONFIG_EXTENSIONS.has(ext) || isEnvLike(input.displayPath)) {
      const configEntries = configEntriesFor(input.text ?? lines.join("\n"), lines, ext, input.displayPath);
      if (configEntries.length > 0) {
        return {
          title: "config summary",
          entries: configEntries.slice(0, 80),
          totalLines: lines.length,
          truncated: configEntries.length > 80,
          providerName: "local-config-text",
        };
      }
    }

    const textEntries = textHeadTailEntries(lines);
    if (textEntries.length === 0) return null;
    return {
      title: "summary",
      entries: textEntries,
      totalLines: lines.length,
      providerName: "local-config-text",
    };
  },
};

function configEntriesFor(text: string, lines: string[], ext: string, displayPath: string): SummaryEntry[] {
  if ([".json", ".jsonc"].includes(ext)) return jsonEntries(text, lines);
  if ([".yaml", ".yml"].includes(ext)) return yamlEntries(lines);
  if (ext === ".toml") return tomlEntries(lines);
  if (ext === ".ini" || ext === ".properties" || ext === ".env" || isEnvLike(displayPath)) return flatKeyEntries(lines);
  return genericConfigEntries(lines);
}

function jsonEntries(text: string, lines: string[]): SummaryEntry[] {
  const clean = stripJsonComments(text);
  try {
    const parsed = JSON.parse(clean);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed).map(([key, value]) => {
      const start = findJsonKeyLine(lines, key) ?? 1;
      return {
        start,
        end: start,
        label: `key ${key}${describeValue(value)}`,
        kind: "config",
        confidence: "medium",
      } satisfies SummaryEntry;
    });
  } catch {
    return genericConfigEntries(lines);
  }
}

function yamlEntries(lines: string[]): SummaryEntry[] {
  const entries: SummaryEntry[] = [];
  const stack: { indent: number; key: string }[] = [];
  const childCounts = new Map<string, number>();

  for (let index = 0; index < Math.min(lines.length, 500); index++) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("- ")) continue;
    const match = /^(\s*)(["']?[A-Za-z0-9_.-]+["']?)\s*:\s*(.*)$/.exec(raw);
    if (!match) continue;
    const indent = match[1]!.length;
    const key = cleanConfigKey(match[2]!);
    const value = match[3] ?? "";
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const path = [...stack.map(item => item.key), key];
    const depth = path.length - 1;
    const parent = path[0] ?? key;
    stack.push({ indent, key });

    if (depth > 1) continue;
    if (depth === 1) {
      const count = childCounts.get(parent) ?? 0;
      if (count >= 4) continue;
      childCounts.set(parent, count + 1);
    }
    const start = index + 1;
    entries.push({
      start,
      end: yamlBlockEnd(lines, index, indent),
      label: `${"  ".repeat(depth)}key ${path.join(".")}${describeYamlValue(value)}`,
      kind: "config",
      confidence: depth === 0 ? "medium" : "low",
    });
  }
  return entries;
}

function tomlEntries(lines: string[]): SummaryEntry[] {
  const sections: { line: number; name: string }[] = [];
  for (let index = 0; index < Math.min(lines.length, 500); index++) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^\[\[?([^\]]+)\]\]?/.exec(trimmed);
    if (match) sections.push({ line: index + 1, name: cleanLabel(match[1]!) });
  }
  if (sections.length > 0) {
    return sections.map((section, index) => ({
      start: section.line,
      end: index + 1 < sections.length ? sections[index + 1]!.line - 1 : lines.length,
      label: `table ${section.name}`,
      kind: "config",
      confidence: "medium",
    }));
  }
  return flatKeyEntries(lines);
}

function flatKeyEntries(lines: string[]): SummaryEntry[] {
  const keys: { line: number; key: string }[] = [];
  for (let index = 0; index < Math.min(lines.length, 300); index++) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*[:=]/.exec(trimmed);
    if (!match) continue;
    keys.push({ line: index + 1, key: match[1]! });
    if (keys.length >= 40) break;
  }
  if (keys.length === 0) return [];
  const grouped = keys.slice(0, 24).map(item => item.key).join(", ");
  const extra = keys.length > 24 ? `, … (${keys.length} keys)` : "";
  return [{
    start: keys[0]!.line,
    end: keys[keys.length - 1]!.line,
    label: `keys ${grouped}${extra}`,
    kind: "config",
    confidence: "low",
  }];
}

function genericConfigEntries(lines: string[]): SummaryEntry[] {
  const entries: SummaryEntry[] = [];
  for (let index = 0; index < Math.min(lines.length, 300); index++) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    let match = /^"?([A-Za-z0-9_.-]+)"?\s*[:=]/.exec(trimmed);
    if (!match) match = /^\[([^\]]+)\]/.exec(trimmed);
    if (!match) continue;
    entries.push({ start: index + 1, end: index + 1, label: `key ${cleanLabel(match[1]!)}`, kind: "config", confidence: "low" });
    if (entries.length >= 40) break;
  }
  return entries.length ? [groupEntries(entries)] : [];
}

function groupEntries(entries: SummaryEntry[]): SummaryEntry {
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  const keys = entries.map(entry => entry.label.replace(/^key\s+/, "")).slice(0, 24).join(", ");
  const extra = entries.length > 24 ? `, … (${entries.length} keys)` : "";
  return { start: first.start, end: last.end, label: `keys ${keys}${extra}`, kind: "config", confidence: "low" };
}

function textHeadTailEntries(lines: string[]): SummaryEntry[] {
  const total = lines.length;
  if (total === 0) return [];
  const headEnd = Math.min(total, TEXT_EDGE_LINES);
  const tailStart = Math.max(headEnd + 1, total - TEXT_EDGE_LINES + 1);
  const entries: SummaryEntry[] = [{ start: 1, end: headEnd, label: "start of file", kind: "text", confidence: "low" }];
  if (tailStart <= total) entries.push({ start: tailStart, end: total, label: "end of file", kind: "text", confidence: "low" });
  return entries;
}

function findJsonKeyLine(lines: string[], key: string): number | undefined {
  const keyRe = new RegExp(`^\\s*"${escapeRegExp(key)}"\\s*:`);
  const found = lines.findIndex(line => keyRe.test(line));
  return found >= 0 ? found + 1 : undefined;
}

function yamlBlockEnd(lines: string[], startIndex: number, indent: number): number {
  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (leadingSpaces(line) <= indent && /^["']?[A-Za-z0-9_.-]+["']?\s*:/.test(trimmed)) return index;
  }
  return lines.length;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return ` (array, ${value.length} items)`;
  if (value && typeof value === "object") return ` (object, ${Object.keys(value).length} keys)`;
  if (value === null) return " (null)";
  return ` (${typeof value})`;
}

function describeYamlValue(value: string): string {
  const clean = value.split("#")[0]?.trim() ?? "";
  if (!clean) return "";
  if (clean === "[]") return " (array)";
  if (clean === "{}") return " (object)";
  if (/^(true|false)$/i.test(clean)) return " (boolean)";
  if (/^-?\d+(?:\.\d+)?$/.test(clean)) return " (number)";
  return " (value)";
}

function cleanConfigKey(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function isEnvLike(path: string): boolean {
  return /(^|\/)\.env(?:\.|$)/.test(path) || /(^|\.)env(\.|$)/.test(path);
}
