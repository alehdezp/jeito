import type { ConcreteHunk } from "./patch-parser.ts";
import { splitLogicalLines } from "./text-normalize.ts";

export interface RepairResult { hunks: ConcreteHunk[]; warnings: string[]; }

/**
 * Conservative adaptation of @oh-my-pi/hashline replacement-boundary repair.
 * Repairs fire only when surviving bytes or delimiter balance prove the intent;
 * ambiguous one-sided content echoes are left untouched.
 */
export function repairConcreteHunks(text: string, hunks: readonly ConcreteHunk[]): RepairResult {
  const source = splitLogicalLines(text).lines;
  const repaired: ConcreteHunk[] = [];
  const actions = new Map<number, string[]>();

  for (let index = 0; index < hunks.length; index++) {
    const hunk = hunks[index]!;
    if (hunk.kind !== "replace") { repaired.push(clone(hunk)); continue; }
    let body = [...hunk.body];
    const removed = source.slice(hunk.start - 1, hunk.end);
    const before = hunk.start > 1 ? source[hunk.start - 2] : undefined;
    const after = hunk.end < source.length ? source[hunk.end] : undefined;
    const note = (message: string) => {
      const rows = actions.get(index);
      if (rows) rows.push(message); else actions.set(index, [message]);
    };

    while (body.length >= 2 && before !== undefined && after !== undefined && body[0] === before && body.at(-1) === after) {
      body = body.slice(1, -1);
      note("removed duplicated unchanged boundary lines");
    }
    if (!actions.has(index) && balancesEqual(removed, body) && body.length > 1 && ((before !== undefined && body[0] === before && isStructuralBoundary(before)) || (after !== undefined && body.at(-1) === after && isStructuralBoundary(after)))) {
      if (before !== undefined && body[0] === before) {
        body = body.slice(1);
        note("removed a balance-neutral duplicated leading boundary line");
      } else if (after !== undefined && body.at(-1) === after) {
        body = body.slice(0, -1);
        note("removed a balance-neutral duplicated trailing boundary line");
      }
    }

    const trailing = matchingTrailingPayload(body, source, hunk.end);
    if (trailing > 0 && !balancesEqual(removed, body) && balancesEqual(removed, body.slice(0, -trailing))) {
      const duplicatedTail = body.at(-1) ?? "";
      body = body.slice(0, -trailing);
      note(trailing === 1 && isStructuralCloser(duplicatedTail) ? "removed duplicated surviving structural closer" : `removed ${trailing} duplicated trailing payload line(s) already present below the range`);
    } else {
      const leading = matchingLeadingPayload(body, source, hunk.start - 1);
      if (leading > 0 && !balancesEqual(removed, body) && balancesEqual(removed, body.slice(leading))) {
        body = body.slice(leading);
        note(`removed ${leading} duplicated leading payload line(s) already present above the range`);
      }
    }

    if (body.length && after !== undefined && body.at(-1) === after && isStructuralCloser(after)) {
      body = body.slice(0, -1);
      note("removed duplicated surviving structural closer");
    }
    if (actions.has(index) && body.length === 0) {
      throw new Error(`Edit rejected: ambiguous_boundary_repair; REPLACE ${hunk.start}..${hunk.end} would become an empty replacement after removing duplicated boundaries. Use DELETE explicitly if removal is intended.`);
    }
    repaired.push({ ...hunk, body });
  }

  let desired = applyConcreteHunks(source, repaired);
  for (let index = 0; index < repaired.length; index++) {
    const hunk = repaired[index]!;
    if (hunk.kind !== "replace") continue;
    const removed = source.slice(hunk.start - 1, hunk.end);
    const closer = removed.at(-1);
    if (closer === undefined || !isStructuralCloser(closer) || hunk.body.at(-1) === closer || balancesEqual(source, desired)) continue;
    if (!balancesEqual(removed, [...hunk.body, closer])) continue;
    const candidate = repaired.map((item, itemIndex) => itemIndex === index ? { ...hunk, body: [...hunk.body, closer] } : clone(item));
    const candidateDesired = applyConcreteHunks(source, candidate);
    if (!balancesEqual(source, candidateDesired)) continue;
    repaired[index] = candidate[index]!;
    desired = candidateDesired;
    const rows = actions.get(index);
    const message = "restored the range-owned structural closer required by the whole-patch delimiter residual";
    if (rows) rows.push(message); else actions.set(index, [message]);
  }

  const targetedLines = new Set<number>();
  for (const hunk of repaired) {
    if (hunk.kind === "replace" || hunk.kind === "delete") for (let line = hunk.start; line <= hunk.end; line++) targetedLines.add(line);
    else if (hunk.position === "before" || hunk.position === "after") targetedLines.add(hunk.lineNumber);
  }
  for (let index = 0; index < repaired.length; index++) {
    const hunk = repaired[index]!;
    if (hunk.kind !== "insert" || hunk.position !== "after") continue;
    const target = bodyTargetIndent(hunk.body);
    const anchor = source[hunk.lineNumber - 1];
    if (target === undefined || anchor === undefined || !indentDeeper(leadingIndent(anchor), target)) continue;
    let landing = hunk.lineNumber;
    let crossed = 0;
    for (let line = hunk.lineNumber + 1; line <= source.length; line++) {
      const row = source[line - 1] ?? "";
      if (!row.trim()) continue;
      if (!isStructuralCloser(row)) break;
      const indent = leadingIndent(row);
      if (!indent.startsWith(target) || targetedLines.has(line)) { landing = hunk.lineNumber; crossed = 0; break; }
      landing = line;
      crossed++;
      if (indent.length === target.length) break;
    }
    if (crossed === 0) continue;
    repaired[index] = { ...hunk, lineNumber: landing };
    actions.set(index, [`moved INSERT AFTER ${hunk.lineNumber} outward across ${crossed} structural closer line(s) to line ${landing}`]);
  }

  const warnings = [...actions.entries()].map(([index, rows]) => {
    const hunk = repaired[index]!;
    const target = hunk.kind === "replace" ? `REPLACE ${hunk.start}..${hunk.end}` : hunk.kind === "insert" ? `INSERT ${hunk.position.toUpperCase()}` : `DELETE ${hunk.start}..${hunk.end}`;
    return `Auto-repaired ${target}: ${unique(rows).join("; ")}.`;
  });
  return { hunks: repaired, warnings };
}

function matchingTrailingPayload(body: readonly string[], source: readonly string[], endLine: number): number {
  const available = Math.min(body.length - 1, source.length - endLine);
  let matched = 0;
  for (let count = 1; count <= available; count++) {
    const payload = body.slice(body.length - count);
    const below = source.slice(endLine, endLine + count);
    if (payload.every((line, index) => line === below[index])) matched = count;
  }
  return matched;
}

function matchingLeadingPayload(body: readonly string[], source: readonly string[], startIndex: number): number {
  const available = Math.min(body.length - 1, startIndex);
  let matched = 0;
  for (let count = 1; count <= available; count++) {
    const payload = body.slice(0, count);
    const above = source.slice(startIndex - count, startIndex);
    if (payload.every((line, index) => line === above[index])) matched = count;
  }
  return matched;
}

function applyConcreteHunks(source: readonly string[], hunks: readonly ConcreteHunk[]): string[] {
  const result = [...source];
  const ordered = hunks.map((hunk, index) => ({ hunk, index, at: hunk.kind === "replace" || hunk.kind === "delete" ? hunk.start : hunk.position === "head" ? 0 : hunk.position === "tail" ? Number.MAX_SAFE_INTEGER : hunk.lineNumber }))
    .sort((left, right) => right.at - left.at || right.index - left.index);
  for (const { hunk } of ordered) {
    if (hunk.kind === "replace") result.splice(hunk.start - 1, hunk.end - hunk.start + 1, ...hunk.body);
    else if (hunk.kind === "delete") result.splice(hunk.start - 1, hunk.end - hunk.start + 1);
    else if (hunk.position === "before") result.splice(hunk.lineNumber - 1, 0, ...hunk.body);
    else if (hunk.position === "after") result.splice(hunk.lineNumber, 0, ...hunk.body);
    else if (hunk.position === "head") result.splice(0, 0, ...hunk.body);
    else result.splice(result.length, 0, ...hunk.body);
  }
  return result;
}

interface Balance { paren: number; bracket: number; brace: number; jsx: string[]; }
function balancesEqual(a: readonly string[], b: readonly string[]): boolean { return equalBalance(balance(a), balance(b)); }
function equalBalance(a: Balance, b: Balance): boolean { return a.paren === b.paren && a.bracket === b.bracket && a.brace === b.brace && a.jsx.join("\0") === b.jsx.join("\0"); }

function balance(lines: readonly string[]): Balance {
  const result: Balance = { paren: 0, bracket: 0, brace: 0, jsx: [] };
  let blockComment = false;
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  const text = lines.join("\n");
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const next = text[index + 1];
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "/" && next === "/") { const newline = text.indexOf("\n", index + 2); if (newline < 0) break; index = newline; continue; }
    if (char === "/" && next === "*") { blockComment = true; index++; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "(") result.paren++; else if (char === ")") result.paren--;
    else if (char === "[") result.bracket++; else if (char === "]") result.bracket--;
    else if (char === "{") result.brace++; else if (char === "}") result.brace--;
    if (char === "<") {
      const tag = /^<\/?([A-Za-z][\w.:-]*|>)(?:\s[^<>]*?)?\/?\s*>/.exec(text.slice(index));
      if (tag) {
        const raw = tag[0];
        const name = tag[1] === ">" ? "" : tag[1]!;
        if (raw.startsWith("</")) { if (result.jsx.at(-1) === name) result.jsx.pop(); else result.jsx.push(`!${name}`); }
        else if (!raw.endsWith("/>") && !raw.startsWith("</")) result.jsx.push(name);
        index += raw.length - 1;
      }
    }
  }
  return result;
}

function bodyTargetIndent(rows: readonly string[]): string | undefined {
  const content = rows.filter(row => row.trim() && !isStructuralCloser(row));
  if (content.length === 0) return undefined;
  let target = leadingIndent(content[0]!);
  for (const row of content) {
    const indent = leadingIndent(row);
    if (indent.startsWith(target)) continue;
    if (target.startsWith(indent)) target = indent;
    else return undefined;
  }
  return target;
}
function leadingIndent(text: string): string { return /^\s*/.exec(text)?.[0] ?? ""; }
function indentDeeper(deeper: string, shallower: string): boolean { return deeper.length > shallower.length && deeper.startsWith(shallower); }

function isStructuralCloser(text: string): boolean {
  return /^\s*[)\]}]+[;,]?\s*$/.test(text) || /^\s*(?:<\/>|<\/[A-Za-z][\w.:-]*>|\/>)\s*[;,]?\s*$/.test(text);
}
function isStructuralBoundary(text: string): boolean {
  return isStructuralCloser(text) || /(?:\(|\{|\[|=>)\s*$/.test(text) || /^\s*<[A-Za-z][\w.:-]*(?:\s[^<>]*)?>\s*$/.test(text);
}
function clone(hunk: ConcreteHunk): ConcreteHunk { return hunk.kind === "insert" ? { ...hunk, body: [...hunk.body] } : hunk.kind === "replace" ? { ...hunk, body: [...hunk.body] } : { ...hunk }; }
function unique(values: string[]): string[] { return [...new Set(values)]; }
