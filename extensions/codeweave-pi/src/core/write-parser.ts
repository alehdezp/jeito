export interface WriteSection {
  path: string;
  overwrite: boolean;
  content: string;
  headerLine: number;
}

export interface WriteParseFailure {
  path: string;
  headerLine: number;
  message: string;
}

export interface ParsedWriteProgram {
  sections: WriteSection[];
  failures: WriteParseFailure[];
}

const HEADER_RE = /^\[([^\]]+)\]\s*$/;

export function parseWriteProgram(input: string): ParsedWriteProgram {
  const lines = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const sections: WriteSection[] = [];
  const failures: WriteParseFailure[] = [];
  let current: { path: string; overwrite: boolean; headerLine: number; lines: string[] } | null = null;

  const finishSection = () => {
    if (!current) return;
    // Strip trailing blank lines — they're section separators, not content.
    while (current.lines.length > 0 && current.lines[current.lines.length - 1]!.trim() === "") current.lines.pop();
    sections.push({ path: current.path, overwrite: current.overwrite, content: current.lines.join("\n"), headerLine: current.headerLine });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    const match = HEADER_RE.exec(trimmed);
    if (match) {
      finishSection();
      const inner = match[1]!;
      const overwrite = inner.endsWith("!");
      const path = (overwrite ? inner.slice(0, -1) : inner).trim();
      if (!path) {
        failures.push({ path: inner, headerLine: i + 1, message: "Empty path in [header]." });
        continue;
      }
      current = { path, overwrite, headerLine: i + 1, lines: [] };
    } else if (current) {
      current.lines.push(lines[i] ?? "");
    } else if (trimmed) {
      failures.push({ path: "(before first header)", headerLine: i + 1, message: `Unrecognized content before first [path] header: "${trimmed.slice(0, 80)}".` });
    }
  }
  finishSection();

  if (sections.length === 0 && failures.length === 0) {
    failures.push({ path: "(input)", headerLine: 1, message: "No [path] sections found in write input." });
  }
  return { sections, failures };
}
