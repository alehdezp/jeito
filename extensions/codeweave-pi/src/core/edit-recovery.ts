import { applyPatch as applyStructuredPatch, diffArrays, structuredPatch } from "diff";
import type { ConcreteHunk } from "./patch-parser.ts";
import { joinLogicalLines, splitLogicalLines } from "./text-normalize.ts";
import { Worker } from "node:worker_threads";

export type RecoveryMethod = "same_coordinate" | "three_way" | "line_remap" | "session_replay" | "head_tail_drift";
export type RecoveryRefusal = "not_recovered" | "ambiguous" | "changed_anchor" | "budget_exceeded" | "unknown_snapshot" | "cancelled";

export interface RecoveryBudget { maxBytes: number; maxLines: number; deadlineMs: number; }
export interface RecoveryRequest {
  previousText: string;
  currentText: string;
  hunks: ConcreteHunk[];
  authorizedLines: ReadonlySet<number>;
  isHeadSnapshot?: boolean;
  signal?: AbortSignal;
  budget?: Partial<RecoveryBudget>;
  now?: () => number;
}
export interface RecoverySuccess {
  ok: true;
  method: RecoveryMethod;
  text: string;
  hunks: ConcreteHunk[];
  authorizedAfterLines: Set<number>;
  warnings: string[];
}
export interface RecoveryFailure { ok: false; reason: RecoveryRefusal; detail: string; }
export type RecoveryResult = RecoverySuccess | RecoveryFailure;

export const DEFAULT_RECOVERY_BUDGET: RecoveryBudget = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxLines: 250_000, deadlineMs: 500 });

/** Pure three-stage recovery adapted from @oh-my-pi/hashline recovery.ts. */
export async function recoverEditAsync(request: RecoveryRequest): Promise<RecoveryResult> {
  const invalid = validateRecoveryRequest(request);
  if (invalid) return invalid;
  const bytes = Buffer.byteLength(request.previousText, "utf8") + Buffer.byteLength(request.currentText, "utf8");
  const lines = countLines(request.previousText) + countLines(request.currentText);
  const byteThreshold = positiveInteger(Number(process.env.PI_NAV_RECOVERY_WORKER_BYTES), 1024 * 1024);
  const lineThreshold = positiveInteger(Number(process.env.PI_NAV_RECOVERY_WORKER_LINES), 20_000);
  if (bytes < byteThreshold && lines < lineThreshold) return recoverEdit(request);
  return await new Promise(resolve => {
    const worker = new Worker(new URL("./edit-recovery-worker.ts", import.meta.url), {
      workerData: { ...request, authorizedLines: [...request.authorizedLines], signal: undefined, now: undefined },
      execArgv: [],
    });
    let settled = false;
    const finish = (result: RecoveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const timeout = setTimeout(() => { void worker.terminate(); finish({ ok: false, reason: "budget_exceeded", detail: "recovery worker exceeded its deadline" }); }, recoveryBudget(request.budget).deadlineMs);
    const abort = () => { void worker.terminate(); finish({ ok: false, reason: "cancelled", detail: "recovery worker was cancelled" }); };
    request.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", message => {
      const result = message as RecoveryResult & { authorizedAfterLines?: number[] };
      finish(result.ok ? { ...result, authorizedAfterLines: new Set(result.authorizedAfterLines ?? []) } : result);
    });
    worker.once("error", error => finish({ ok: false, reason: "not_recovered", detail: `recovery worker failed: ${error.message}` }));
  });
}

export function recoverEdit(request: RecoveryRequest): RecoveryResult {
  const invalid = validateRecoveryRequest(request);
  if (invalid) return invalid;
  const deadline = recoveryDeadline(request);
  const checkpoint = () => deadline.checkpoint();
  const headTailOnly = request.hunks.length > 0 && request.hunks.every(hunk => hunk.kind === "insert" && (hunk.position === "head" || hunk.position === "tail"));
  if (headTailOnly) {
    const text = applyConcreteHunks(request.currentText, request.hunks);
    return success("head_tail_drift", text, request.hunks, request, ["Recovered stale start/end insertion against current content; no historical line anchor was remapped."]);
  }

  let stopped = checkpoint();
  if (stopped) return stopped;
  const historicalEdited = safeApply(request.previousText, request.hunks);
  if (historicalEdited !== undefined && historicalEdited !== request.previousText) {
    const patch = structuredPatch("file", "file", request.previousText, historicalEdited, "", "", { context: 3 });
    const merged = applyStructuredPatch(request.currentText, patch, { fuzzFactor: 0 });
    if (typeof merged === "string" && merged !== request.currentText) {
      return success("three_way", merged, request.hunks, request, [request.isHeadSnapshot === false ? "Recovered an older in-session hash by exact-context three-way merge." : "Recovered external file drift by exact-context three-way merge with fuzz 0."]);
    }
  }

  stopped = checkpoint();
  if (stopped) return stopped;
  const remapped = remapHunks(request.previousText, request.currentText, request.hunks);
  if (remapped.ok) {
    const text = safeApply(request.currentText, remapped.hunks);
    if (text !== undefined && text !== request.currentText) {
      return success("line_remap", text, remapped.hunks, request, [`Recovered the stale hash by unchanged-line remapping with one uniform ${signed(remapped.offset)} line offset.`]);
    }
  }

  stopped = checkpoint();
  if (stopped) return stopped;
  if (request.isHeadSnapshot === false && equalLineCount(request.previousText, request.currentText) && anchorsHaveSameContent(request.previousText, request.currentText, request.hunks)) {
    const text = safeApply(request.currentText, request.hunks);
    if (text !== undefined && text !== request.currentText) return success("session_replay", text, request.hunks, request, ["Recovered an older in-session hash by guarded session-chain replay; verify the compact edit result."]);
  }

  return { ok: false, reason: remapped.reason ?? "not_recovered", detail: remapped.detail ?? "historical anchors could not be recovered uniquely" };
}

export function validateRecoveryRequest(request: RecoveryRequest): RecoveryFailure | undefined {
  if (request.signal?.aborted) return { ok: false, reason: "cancelled", detail: "recovery was cancelled before it started" };
  const budget = recoveryBudget(request.budget);
  const bytes = Buffer.byteLength(request.previousText, "utf8") + Buffer.byteLength(request.currentText, "utf8");
  if (bytes > budget.maxBytes) return { ok: false, reason: "budget_exceeded", detail: `recovery input is ${bytes} bytes; limit is ${budget.maxBytes}` };
  const lines = countLines(request.previousText) + countLines(request.currentText);
  if (lines > budget.maxLines) return { ok: false, reason: "budget_exceeded", detail: `recovery input is ${lines} logical lines; limit is ${budget.maxLines}` };
  return undefined;
}

export function recoveryBudget(overrides: Partial<RecoveryBudget> = {}): RecoveryBudget {
  return { maxBytes: positiveInteger(overrides.maxBytes, DEFAULT_RECOVERY_BUDGET.maxBytes), maxLines: positiveInteger(overrides.maxLines, DEFAULT_RECOVERY_BUDGET.maxLines), deadlineMs: positiveInteger(overrides.deadlineMs, DEFAULT_RECOVERY_BUDGET.deadlineMs) };
}
export function recoveryDeadline(request: RecoveryRequest): { expired(): boolean; checkpoint(): RecoveryFailure | undefined } {
  const now = request.now ?? Date.now;
  const expiresAt = now() + recoveryBudget(request.budget).deadlineMs;
  return {
    expired: () => now() > expiresAt,
    checkpoint: () => request.signal?.aborted ? { ok: false, reason: "cancelled", detail: "recovery was cancelled" } : now() > expiresAt ? { ok: false, reason: "budget_exceeded", detail: "recovery exceeded its deadline" } : undefined,
  };
}
export function cloneConcreteHunks(hunks: readonly ConcreteHunk[]): ConcreteHunk[] {
  return hunks.map(hunk => hunk.kind === "replace" || hunk.kind === "insert" ? { ...hunk, body: [...hunk.body] } : { ...hunk }) as ConcreteHunk[];
}

function success(method: RecoveryMethod, text: string, hunks: ConcreteHunk[], request: RecoveryRequest, warnings: string[]): RecoverySuccess {
  return { ok: true, method, text, hunks: cloneConcreteHunks(hunks), authorizedAfterLines: provenanceAfterText(request.currentText, text, sameCoordinateAuthorized(request)), warnings };
}
function provenanceAfterText(currentText: string, afterText: string, currentSeen: ReadonlySet<number>): Set<number> {
  const current = splitLogicalLines(currentText).lines;
  const after = splitLogicalLines(afterText).lines;
  const seen = new Set<number>();
  let currentLine = 1;
  let afterLine = 1;
  for (const change of diffArrays(current, after)) {
    const count = change.value.length;
    if (change.added) { for (let offset = 0; offset < count; offset++) seen.add(afterLine + offset); afterLine += count; }
    else if (change.removed) currentLine += count;
    else { for (let offset = 0; offset < count; offset++) if (currentSeen.has(currentLine + offset)) seen.add(afterLine + offset); currentLine += count; afterLine += count; }
  }
  return seen;
}
function safeApply(text: string, hunks: ConcreteHunk[]): string | undefined { try { return applyConcreteHunks(text, hunks); } catch { return undefined; } }
function applyConcreteHunks(text: string, hunks: ConcreteHunk[]): string {
  const split = splitLogicalLines(text);
  const lines = [...split.lines];
  const originalCount = lines.length;
  for (const hunk of hunks) validateBounds(hunk, originalCount);
  const ordered = hunks.map((hunk, index) => ({ hunk, index, at: hunkLine(hunk) })).sort((a, b) => b.at - a.at || b.index - a.index);
  for (const { hunk } of ordered) {
    if (hunk.kind === "replace") lines.splice(hunk.start - 1, hunk.end - hunk.start + 1, ...hunk.body);
    else if (hunk.kind === "delete") lines.splice(hunk.start - 1, hunk.end - hunk.start + 1);
    else if (hunk.position === "before") lines.splice(hunk.lineNumber - 1, 0, ...hunk.body);
    else if (hunk.position === "after") lines.splice(hunk.lineNumber, 0, ...hunk.body);
    else if (hunk.position === "head") lines.splice(0, 0, ...hunk.body);
    else lines.splice(lines.length, 0, ...hunk.body);
  }
  return joinLogicalLines(lines, split.trailingNewline);
}
function validateBounds(hunk: ConcreteHunk, lineCount: number): void {
  if (hunk.kind === "replace" || hunk.kind === "delete") { if (hunk.start < 1 || hunk.end < hunk.start || hunk.end > lineCount) throw new Error("range out of bounds"); return; }
  if ((hunk.position === "before" || hunk.position === "after") && (hunk.lineNumber < 1 || hunk.lineNumber > lineCount)) throw new Error("anchor out of bounds");
}
function hunkLine(hunk: ConcreteHunk): number { return hunk.kind === "replace" || hunk.kind === "delete" ? hunk.start : hunk.position === "head" ? 0 : hunk.position === "tail" ? Number.MAX_SAFE_INTEGER : hunk.lineNumber; }

function remapHunks(previousText: string, currentText: string, hunks: ConcreteHunk[]): { ok: true; hunks: ConcreteHunk[]; offset: number } | { ok: false; reason?: RecoveryRefusal; detail?: string } {
  const previous = splitLogicalLines(previousText).lines;
  const current = splitLogicalLines(currentText).lines;
  const map = buildLineMap(previous, current);
  const anchors = anchorLines(hunks);
  if (!anchors.length) return { ok: false, reason: "not_recovered", detail: "no line anchors to remap" };
  const duplicatesPrevious = duplicatedValues(previous);
  const duplicatesCurrent = duplicatedValues(current);
  const anchorSet = new Set(anchors);
  const offsets: number[] = [];
  for (const line of anchors) {
    const mapped = map.get(line);
    if (mapped === undefined || previous[line - 1] !== current[mapped - 1]) return { ok: false, reason: "changed_anchor", detail: `anchor line ${line} changed or was deleted` };
    const duplicate = duplicatesPrevious.has(previous[line - 1]!) || duplicatesCurrent.has(current[mapped - 1]!);
    if (!contextMatches(line, mapped, anchorSet, map, previous.length, duplicate)) return { ok: false, reason: "ambiguous", detail: `anchor line ${line} has no unique unchanged context` };
    offsets.push(mapped - line);
  }
  if (!offsets.every(offset => offset === offsets[0]) || offsets[0] === 0) return { ok: false, reason: "ambiguous", detail: "anchors do not share one non-zero offset" };
  return { ok: true, offset: offsets[0]!, hunks: shiftHunks(hunks, offsets[0]!) };
}
function buildLineMap(previous: string[], current: string[]): Map<number, number> {
  const map = new Map<number, number>();
  let oldLine = 1, newLine = 1;
  for (const change of diffArrays(previous, current)) {
    const count = change.value.length;
    if (change.added) newLine += count;
    else if (change.removed) oldLine += count;
    else { for (let index = 0; index < count; index++) map.set(oldLine + index, newLine + index); oldLine += count; newLine += count; }
  }
  return map;
}
function contextMatches(line: number, mapped: number, anchors: Set<number>, map: Map<number, number>, lineCount: number, duplicate: boolean): boolean {
  let before = line - 1; while (before >= 1 && anchors.has(before)) before--;
  let after = line + 1; while (after <= lineCount && anchors.has(after)) after++;
  const offset = mapped - line;
  const beforeOk = before >= 1 && map.get(before) === before + offset;
  const afterOk = after <= lineCount && map.get(after) === after + offset;
  return duplicate ? beforeOk && afterOk : afterOk || beforeOk;
}
function duplicatedValues(lines: string[]): Set<string> { const seen = new Set<string>(), duplicated = new Set<string>(); for (const line of lines) { if (seen.has(line)) duplicated.add(line); else seen.add(line); } return duplicated; }
function anchorLines(hunks: ConcreteHunk[]): number[] { const out = new Set<number>(); for (const hunk of hunks) { if (hunk.kind === "replace" || hunk.kind === "delete") for (let line = hunk.start; line <= hunk.end; line++) out.add(line); else if (hunk.position === "before" || hunk.position === "after") out.add(hunk.lineNumber); } return [...out].sort((a, b) => a - b); }
function shiftHunks(hunks: ConcreteHunk[], offset: number): ConcreteHunk[] { return hunks.map(hunk => hunk.kind === "replace" ? { ...hunk, start: hunk.start + offset, end: hunk.end + offset, body: [...hunk.body] } : hunk.kind === "delete" ? { ...hunk, start: hunk.start + offset, end: hunk.end + offset } : hunk.position === "before" || hunk.position === "after" ? { ...hunk, lineNumber: hunk.lineNumber + offset, body: [...hunk.body] } : { ...hunk, body: [...hunk.body] }); }
function anchorsHaveSameContent(previousText: string, currentText: string, hunks: ConcreteHunk[]): boolean { const previous = splitLogicalLines(previousText).lines, current = splitLogicalLines(currentText).lines; return anchorLines(hunks).every(line => line <= previous.length && line <= current.length && previous[line - 1] === current[line - 1]); }
function equalLineCount(a: string, b: string): boolean { return splitLogicalLines(a).lines.length === splitLogicalLines(b).lines.length; }
function sameCoordinateAuthorized(request: RecoveryRequest): Set<number> { const previous = splitLogicalLines(request.previousText).lines, current = splitLogicalLines(request.currentText).lines; return new Set([...request.authorizedLines].filter(line => line <= previous.length && line <= current.length && previous[line - 1] === current[line - 1])); }
function countLines(text: string): number { if (!text) return 1; let count = 1; for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++; return count; }
function positiveInteger(value: number | undefined, fallback: number): number { return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback; }
function signed(value: number): string { return value > 0 ? `+${value}` : String(value); }
