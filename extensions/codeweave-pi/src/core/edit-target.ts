import type { ConcreteHunk } from "./patch-parser.ts";

export interface TargetOrigin {
  sectionIndex: number;
  operationIndex: number;
  inputOrder: number;
  operationLine: number;
}

export type TargetIslandKind = "replace" | "delete" | "insert";

export interface TargetIsland extends TargetOrigin {
  islandIndex: number;
  kind: TargetIslandKind;
  /** Zero-based inclusive index into the source used to compile this target. */
  sourceStartIndex: number;
  /** Zero-based exclusive index into the source used to compile this target. */
  sourceEndIndex: number;
  body: string[];
  /** One-based source rows whose existing content this island changes or deletes. */
  requiredRows: number[];
}

export interface CompiledTarget {
  source: string[];
  desired: string[];
  islands: TargetIsland[];
  converged: boolean;
}

export function compileTarget(source: readonly string[], hunk: ConcreteHunk, origin: TargetOrigin): CompiledTarget {
  const original = [...source];
  validateHunk(original.length, hunk);
  let desired = applyConcreteHunk(original, hunk);
  let islands: TargetIsland[];

  if (hunk.kind === "delete") {
    islands = [island(origin, 0, hunk.start - 1, hunk.end, [])];
  } else if (hunk.kind === "replace") {
    islands = replacementIslands(original.slice(hunk.start - 1, hunk.end), hunk.body, hunk.start - 1, origin);
  } else {
    const insertionIndex = hunk.position === "head" ? 0 : hunk.position === "tail" ? original.length : hunk.position === "before" ? hunk.lineNumber - 1 : hunk.lineNumber;
    const adjacent = hunk.body.length > 0 && (hunk.position === "tail"
      ? exactSliceAt(original, original.length - hunk.body.length, hunk.body)
      : exactSliceAt(original, insertionIndex, hunk.body));
    if (adjacent) desired = [...original];
    islands = adjacent
      ? []
      : [{
          ...origin,
          islandIndex: 0,
          kind: "insert",
          sourceStartIndex: insertionIndex,
          sourceEndIndex: insertionIndex,
          body: [...hunk.body],
          requiredRows: hunk.position === "before" || hunk.position === "after" ? [hunk.lineNumber] : [],
        }];
  }

  return { source: original, desired, islands, converged: islands.length === 0 };
}

/** Compile a current file into an exact desired file for retry/residual calculation. */
export function compileTextTarget(source: readonly string[], desired: readonly string[], origin: TargetOrigin): CompiledTarget {
  const original = [...source];
  const target = [...desired];
  const islands = replacementIslands(original, target, 0, origin);
  return { source: original, desired: target, islands, converged: islands.length === 0 };
}

export function applyTargetIslands(source: readonly string[], islands: readonly TargetIsland[]): string[] {
  const result = [...source];
  const ordered = islands.slice().sort((left, right) =>
    right.sourceStartIndex - left.sourceStartIndex || right.islandIndex - left.islandIndex || right.inputOrder - left.inputOrder,
  );
  for (const change of ordered) {
    result.splice(change.sourceStartIndex, change.sourceEndIndex - change.sourceStartIndex, ...change.body);
  }
  return result;
}

export function targetIslandToHunk(change: TargetIsland, sourceLineCount: number): ConcreteHunk {
  if (change.kind === "insert") {
    if (change.sourceStartIndex === 0) return { kind: "insert", position: "head", body: [...change.body], line: change.operationLine };
    if (change.sourceStartIndex === sourceLineCount) return { kind: "insert", position: "tail", body: [...change.body], line: change.operationLine };
    return { kind: "insert", position: "before", lineNumber: change.sourceStartIndex + 1, body: [...change.body], line: change.operationLine };
  }
  const start = change.sourceStartIndex + 1;
  const end = change.sourceEndIndex;
  return change.kind === "delete"
    ? { kind: "delete", start, end, line: change.operationLine }
    : { kind: "replace", start, end, body: [...change.body], line: change.operationLine };
}

export function serializeTargetIsland(change: TargetIsland, sourceLineCount: number): string {
  if (change.kind === "insert") {
    const operation = change.sourceStartIndex === 0
      ? "INSERT AT START:"
      : change.sourceStartIndex === sourceLineCount
        ? "INSERT AT END:"
        : `INSERT BEFORE ${change.sourceStartIndex + 1}:`;
    return `${operation}\n${change.body.map(line => `+${line}`).join("\n")}`;
  }
  const start = change.sourceStartIndex + 1;
  const end = change.sourceEndIndex;
  const range = start === end ? `${start}` : `${start}..${end}`;
  if (change.kind === "delete") return `DELETE ${range}`;
  return `REPLACE ${range}:\n${change.body.map(line => `+${line}`).join("\n")}`;
}

function replacementIslands(source: readonly string[], body: readonly string[], offset: number, origin: TargetOrigin): TargetIsland[] {
  if (source.length === body.length) return positionalIslands(source, body, offset, origin);

  let prefix = 0;
  while (prefix < source.length && prefix < body.length && source[prefix] === body[prefix]) prefix++;
  let suffix = 0;
  while (suffix < source.length - prefix && suffix < body.length - prefix && source[source.length - 1 - suffix] === body[body.length - 1 - suffix]) suffix++;

  const sourceMiddle = source.slice(prefix, source.length - suffix);
  const bodyMiddle = body.slice(prefix, body.length - suffix);
  const anchors = uniqueMonotonicAnchors(sourceMiddle, bodyMiddle);
  const segments: Array<{ sourceStart: number; sourceEnd: number; bodyStart: number; bodyEnd: number }> = [];

  if (anchors && anchors.length > 0) {
    let sourceCursor = 0;
    let bodyCursor = 0;
    for (const [sourceIndex, bodyIndex] of anchors) {
      segments.push({ sourceStart: sourceCursor, sourceEnd: sourceIndex, bodyStart: bodyCursor, bodyEnd: bodyIndex });
      sourceCursor = sourceIndex + 1;
      bodyCursor = bodyIndex + 1;
    }
    segments.push({ sourceStart: sourceCursor, sourceEnd: sourceMiddle.length, bodyStart: bodyCursor, bodyEnd: bodyMiddle.length });
  } else {
    segments.push({ sourceStart: 0, sourceEnd: sourceMiddle.length, bodyStart: 0, bodyEnd: bodyMiddle.length });
  }

  const changes: TargetIsland[] = [];
  for (const segment of segments) {
    const sourcePart = sourceMiddle.slice(segment.sourceStart, segment.sourceEnd);
    const bodyPart = bodyMiddle.slice(segment.bodyStart, segment.bodyEnd);
    if (arraysEqual(sourcePart, bodyPart)) continue;
    changes.push(island(
      origin,
      changes.length,
      offset + prefix + segment.sourceStart,
      offset + prefix + segment.sourceEnd,
      bodyPart,
    ));
  }
  return changes;
}

function positionalIslands(source: readonly string[], body: readonly string[], offset: number, origin: TargetOrigin): TargetIsland[] {
  const changes: TargetIsland[] = [];
  let start = -1;
  for (let index = 0; index <= source.length; index++) {
    const differs = index < source.length && source[index] !== body[index];
    if (differs && start < 0) start = index;
    if (!differs && start >= 0) {
      changes.push(island(origin, changes.length, offset + start, offset + index, body.slice(start, index)));
      start = -1;
    }
  }
  return changes;
}

function uniqueMonotonicAnchors(source: readonly string[], body: readonly string[]): Array<[number, number]> | undefined {
  const sourcePositions = uniquePositions(source);
  const bodyPositions = uniquePositions(body);
  const pairs: Array<[number, number]> = [];
  for (const [line, sourceIndex] of sourcePositions) {
    const bodyIndex = bodyPositions.get(line);
    if (bodyIndex !== undefined) pairs.push([sourceIndex, bodyIndex]);
  }
  pairs.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < pairs.length; index++) {
    if (pairs[index - 1]![1] >= pairs[index]![1]) return undefined;
  }
  return pairs;
}

function uniquePositions(lines: readonly string[]): Map<string, number> {
  const positions = new Map<string, number>();
  const duplicates = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (positions.has(line)) duplicates.add(line);
    else positions.set(line, index);
  }
  for (const duplicate of duplicates) positions.delete(duplicate);
  return positions;
}

function island(origin: TargetOrigin, islandIndex: number, sourceStartIndex: number, sourceEndIndex: number, body: readonly string[]): TargetIsland {
  const kind: TargetIslandKind = sourceStartIndex === sourceEndIndex ? "insert" : body.length === 0 ? "delete" : "replace";
  return {
    ...origin,
    islandIndex,
    kind,
    sourceStartIndex,
    sourceEndIndex,
    body: [...body],
    requiredRows: Array.from({ length: sourceEndIndex - sourceStartIndex }, (_, index) => sourceStartIndex + index + 1),
  };
}

function applyConcreteHunk(source: readonly string[], hunk: ConcreteHunk): string[] {
  const desired = [...source];
  if (hunk.kind === "replace") desired.splice(hunk.start - 1, hunk.end - hunk.start + 1, ...hunk.body);
  else if (hunk.kind === "delete") desired.splice(hunk.start - 1, hunk.end - hunk.start + 1);
  else if (hunk.position === "before") desired.splice(hunk.lineNumber - 1, 0, ...hunk.body);
  else if (hunk.position === "after") desired.splice(hunk.lineNumber, 0, ...hunk.body);
  else if (hunk.position === "head") desired.splice(0, 0, ...hunk.body);
  else desired.splice(desired.length, 0, ...hunk.body);
  return desired;
}

function validateHunk(lineCount: number, hunk: ConcreteHunk): void {
  if (hunk.kind === "replace" || hunk.kind === "delete") {
    if (hunk.start < 1 || hunk.end < hunk.start || hunk.end > lineCount) throw new Error(`target_bounds:${hunk.start}..${hunk.end};line_count=${lineCount}`);
  } else if ((hunk.position === "before" || hunk.position === "after") && (hunk.lineNumber < 1 || hunk.lineNumber > lineCount)) {
    throw new Error(`target_bounds:${hunk.lineNumber};line_count=${lineCount}`);
  }
}

function exactSliceAt(source: readonly string[], start: number, expected: readonly string[]): boolean {
  return start >= 0 && start + expected.length <= source.length && expected.every((line, index) => source[start + index] === line);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
