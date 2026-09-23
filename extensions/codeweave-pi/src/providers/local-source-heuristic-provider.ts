import type { SmartSummaryProvider, SummaryEntry } from "../core/smart-summary-provider.ts";
import { cleanLabel, compactArgs, leadingSpaces, SOURCE_EXTENSIONS, stripQuotedText } from "./local-provider-utils.ts";

export const localSourceHeuristicProvider: SmartSummaryProvider = {
  name: "local-source-heuristic",
  priority: 40,
  canHandle(input) {
    return input.kind === "file" && SOURCE_EXTENSIONS.has(input.extension ?? "");
  },
  async summarize(input) {
    const lines = input.lines ?? [];
    const ext = input.extension ?? "";
    const entries: SummaryEntry[] = [];
    const importEntry = summarizeImports(lines, ext);
    if (importEntry) entries.push(importEntry);

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      const symbol = matchSymbol(line, ext);
      if (!symbol) continue;
      const start = index + 1;
      const end = estimateSymbolEnd(lines, index, ext);
      entries.push({ start, end, label: `${symbol.kind} ${symbol.name}`, kind: symbol.entryKind, confidence: "medium" });
    }

    const deduped = dedupeEntries(entries);
    if (deduped.length === 0) return null;
    return {
      title: "source summary",
      entries: deduped.slice(0, 80),
      totalLines: lines.length,
      truncated: deduped.length > 80,
      providerName: "local-source-heuristic",
    };
  },
};

function summarizeImports(lines: string[], ext: string): SummaryEntry | undefined {
  if (ext === ".go") return summarizeGoImports(lines);
  const sources: string[] = [];
  let first = 0;
  let last = 0;
  for (let index = 0; index < Math.min(lines.length, 120); index++) {
    const trimmed = (lines[index] ?? "").trim();
    for (const source of importSources(trimmed, ext)) {
      if (!first) first = index + 1;
      last = index + 1;
      if (!sources.includes(source)) sources.push(source);
    }
  }
  if (!first || sources.length === 0) return undefined;
  const shown = sources.slice(0, 8).join(", ");
  const extra = sources.length > 8 ? `, … (${sources.length} total)` : "";
  return { start: first, end: last, label: `imports: ${shown}${extra}`, kind: "import", confidence: "medium" };
}

function summarizeGoImports(lines: string[]): SummaryEntry | undefined {
  const sources: string[] = [];
  let first = 0;
  let last = 0;
  for (let index = 0; index < Math.min(lines.length, 160); index++) {
    const trimmed = (lines[index] ?? "").trim();
    let match = /^import\s+(?:[._A-Za-z]\w*\s+)?"([^"]+)"/.exec(trimmed);
    if (match) {
      if (!first) first = index + 1;
      last = index + 1;
      if (!sources.includes(match[1]!)) sources.push(match[1]!);
      continue;
    }
    if (!/^import\s*\($/.test(trimmed)) continue;
    if (!first) first = index + 1;
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const inner = (lines[cursor] ?? "").trim();
      last = cursor + 1;
      if (inner === ")") {
        index = cursor;
        break;
      }
      match = /^(?:[._A-Za-z]\w*\s+)?"([^"]+)"/.exec(inner);
      if (match && !sources.includes(match[1]!)) sources.push(match[1]!);
    }
  }
  if (!first || sources.length === 0) return undefined;
  const shown = sources.slice(0, 8).join(", ");
  const extra = sources.length > 8 ? `, … (${sources.length} total)` : "";
  return { start: first, end: last || first, label: `imports: ${shown}${extra}`, kind: "import", confidence: "medium" };
}

function importSources(trimmed: string, ext: string): string[] {
  const sources: string[] = [];
  let match = /^import\s+.*?from\s+["']([^"']+)["']/.exec(trimmed) || /^import\s+["']([^"']+)["']/.exec(trimmed) || /^export\s+.*?from\s+["']([^"']+)["']/.exec(trimmed);
  if (match) sources.push(match[1]!);

  if (ext === ".py") {
    match = /^from\s+([\w.]+)\s+import\s+/.exec(trimmed);
    if (match) sources.push(match[1]!);
    match = /^import\s+(.+)$/.exec(trimmed);
    if (match) {
      for (const part of match[1]!.split(",")) {
        const source = part.trim().split(/\s+as\s+/i)[0]?.trim();
        if (source) sources.push(source);
      }
    }
    return unique(sources);
  }

  match = /^(?:use|mod)\s+([^;{]+)[;{]?/.exec(trimmed);
  if (match && ext === ".rs") sources.push(match[1]!.trim());

  match = /^import\s+([^;]+)/.exec(trimmed);
  if (match && [".java", ".kt", ".kts", ".scala", ".swift", ".dart"].includes(ext)) sources.push(match[1]!.replace(/["';]/g, "").trim());

  match = /^(?:require|include|include_once|require_once)\s*[\("']([^"')]+)/.exec(trimmed);
  if (match) sources.push(match[1]!);
  return unique(sources.filter(Boolean).map(cleanLabel));
}

function matchSymbol(line: string, ext: string): { kind: string; name: string; entryKind: SummaryEntry["kind"] } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("# ")) return undefined;
  let match: RegExpExecArray | null;

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"].includes(ext)) {
    match = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)/.exec(trimmed);
    if (match) return { kind: "fn", name: `${match[1]}(${compactArgs(match[2] ?? "")})`, entryKind: "function" };
    match = /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (match) return { kind: "class", name: match[1]!, entryKind: "class" };
    match = /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (match) return { kind: "interface", name: match[1]!, entryKind: "type" };
    match = /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (match) return { kind: "type", name: match[1]!, entryKind: "type" };
    match = /^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (match) return { kind: "enum", name: match[1]!, entryKind: "type" };
    match = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/.exec(trimmed);
    if (match) return { kind: "fn", name: `${match[1]}(${compactArgs(match[2] ?? match[3] ?? "")})`, entryKind: "function" };
  }

  if (ext === ".py") {
    match = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)/.exec(trimmed);
    if (match) return { kind: "fn", name: `${match[1]}(${compactArgs(match[2] ?? "")})`, entryKind: "function" };
    match = /^class\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (match) return { kind: "class", name: match[1]!, entryKind: "class" };
  }

  if (ext === ".go") {
    match = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)/.exec(trimmed);
    if (match) return { kind: "fn", name: `${match[1]}(${compactArgs(match[2] ?? "")})`, entryKind: "function" };
    match = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)/.exec(trimmed);
    if (match) return { kind: match[2]!, name: match[1]!, entryKind: "type" };
  }

  if (ext === ".rs") {
    match = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(([^)]*)/.exec(trimmed);
    if (match) return { kind: "fn", name: `${match[1]}(${compactArgs(match[2] ?? "")})`, entryKind: "function" };
    match = /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (match) return { kind: match[1]!, name: match[2]!, entryKind: "type" };
    match = /^(?:pub(?:\([^)]*\))?\s+)?impl\b\s*(.*)/.exec(trimmed);
    if (match) return { kind: "impl", name: cleanLabel(match[1] ?? ""), entryKind: "class" };
  }

  if ([".kt", ".kts"].includes(ext)) {
    match = /^(?:(?:public|private|protected|internal|open|data|sealed|abstract|final|enum|annotation|value|expect|actual)\s+)*(class|interface|object)\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (match) return { kind: match[1]!, name: match[2]!, entryKind: match[1] === "object" ? "class" : "type" };
    match = /^(?:companion\s+)?object\s+([A-Za-z_]\w*)?/.exec(trimmed);
    if (match) return { kind: "object", name: match[1] ?? "companion object", entryKind: "class" };
    match = /^(?:(?:public|private|protected|internal|open|override|suspend|inline|tailrec|operator|infix|external|actual|expect)\s+)*fun\s+(?:<[^>]+>\s*)?(?:(\w[\w.<>?]*)\.)?([A-Za-z_]\w*)\s*\(([^)]*)/.exec(trimmed);
    if (match) {
      const receiver = match[1] ? `${match[1]}.` : "";
      return { kind: "fn", name: `${receiver}${match[2]}(${compactArgs(match[3] ?? "")})`, entryKind: "function" };
    }
  }

  match = /^(?:public\s+|private\s+|protected\s+|static\s+|final\s+|export\s+|async\s+)*(?:class|interface|enum|struct)\s+([A-Za-z_]\w*)/.exec(trimmed);
  if (match) return { kind: /interface/.test(trimmed) ? "interface" : /enum/.test(trimmed) ? "enum" : /struct/.test(trimmed) ? "struct" : "class", name: match[1]!, entryKind: "type" };
  match = /^(?:describe|it|test)\s*\(\s*["'`]([^"'`]+)["'`]/.exec(trimmed);
  if (match) return { kind: trimmed.startsWith("describe") ? "suite" : "test", name: cleanLabel(match[1]!), entryKind: "function" };
  return undefined;
}

function estimateSymbolEnd(lines: string[], startIndex: number, ext: string): number {
  const startLine = lines[startIndex] ?? "";
  if (ext === ".py") return estimatePythonEnd(lines, startIndex);
  if (startLine.includes("{") || startsBraceSoon(lines, startIndex)) return estimateBraceEnd(lines, startIndex);
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 20); index++) {
    if ((lines[index] ?? "").trim().endsWith(";")) return index + 1;
  }
  return startIndex + 1;
}

function startsBraceSoon(lines: string[], startIndex: number): boolean {
  for (let index = startIndex + 1; index < Math.min(lines.length, startIndex + 4); index++) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed) continue;
    return trimmed.startsWith("{");
  }
  return false;
}

function estimateBraceEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  let sawBrace = false;
  for (let index = startIndex; index < lines.length; index++) {
    const line = stripQuotedText(lines[index] ?? "");
    for (const char of line) {
      if (char === "{") { depth++; sawBrace = true; }
      else if (char === "}") depth--;
    }
    if (sawBrace && depth <= 0 && index > startIndex) return index + 1;
  }
  return Math.min(lines.length, startIndex + 1);
}

function estimatePythonEnd(lines: string[], startIndex: number): number {
  const baseIndent = leadingSpaces(lines[startIndex] ?? "");
  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    if (leadingSpaces(line) <= baseIndent) return index;
  }
  return lines.length;
}

function dedupeEntries(entries: SummaryEntry[]): SummaryEntry[] {
  const seen = new Set<string>();
  const out: SummaryEntry[] = [];
  for (const entry of entries.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || (a.end ?? 0) - (b.end ?? 0) || entryLabel(a).localeCompare(entryLabel(b)))) {
    const key = `${entry.start}:${entry.end}:${entry.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function entryLabel(entry: SummaryEntry): string {
  return entry.label;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
