import { splitLogicalLines } from "./text-normalize.ts";

export function firstChangedLine(before: string, after: string): number | undefined {
  const a = splitLogicalLines(before).lines;
  const b = splitLogicalLines(after).lines;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) return i + 1;
  }
  return undefined;
}

export function renderSimpleDiff(before: string, after: string, context = 2): string {
  const first = firstChangedLine(before, after);
  if (first === undefined) return "No changes.";
  const a = splitLogicalLines(before).lines;
  const b = splitLogicalLines(after).lines;
  const start = Math.max(1, first - context);
  const end = Math.min(Math.max(a.length, b.length), first + context);
  const rows: string[] = ["Diff: first changed region only; increase expand or use git diff for a full file comparison."];
  for (let line = start; line <= end; line++) {
    const oldLine = a[line - 1];
    const newLine = b[line - 1];
    if (oldLine === newLine) rows.push(` ${line}:${oldLine ?? ""}`);
    else {
      if (oldLine !== undefined) rows.push(`-${line}:${oldLine}`);
      if (newLine !== undefined) rows.push(`+${line}:${newLine}`);
    }
  }
  return rows.join("\n");
}
