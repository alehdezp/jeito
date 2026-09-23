const MAX_RESIDUALS = 64;
const MAX_CAPSULE_BYTES = 256 * 1024;

export interface StoredRetryResidual {
  path: string;
  operationLine: number;
  reason: "unseen" | "stale";
  input: string;
  context: string;
}

interface RetryCapsule {
  residuals: StoredRetryResidual[];
  bytes: number;
}

const noChangeAttempts = new Map<string, number>();
const retryCapsules = new Map<string, RetryCapsule>();

export function parseRetryCommand(input: string): { kind: "one" | "all"; ordinal?: number } | undefined {
  const trimmed = input.trim();
  if (trimmed === "RETRY") return { kind: "one" };
  if (trimmed === "RETRY ALL") return { kind: "all" };
  const numbered = /^RETRY ([1-9]\d*)$/.exec(trimmed);
  return numbered ? { kind: "one", ordinal: Number(numbered[1]) } : undefined;
}

export function replaceRetryCapsule(sessionId: string, residuals: StoredRetryResidual[]): { ok: true } | { ok: false; reason: string } {
  if (residuals.length === 0) {
    retryCapsules.delete(sessionId);
    return { ok: true };
  }
  const bytes = residuals.reduce((total, residual) => total + Buffer.byteLength(residual.input, "utf8") + Buffer.byteLength(residual.context, "utf8"), 0);
  if (residuals.length > MAX_RESIDUALS || bytes > MAX_CAPSULE_BYTES) {
    retryCapsules.delete(sessionId);
    return { ok: false, reason: `retry capsule refused: ${residuals.length} residuals/${bytes} bytes exceeds ${MAX_RESIDUALS} residuals/${MAX_CAPSULE_BYTES} bytes` };
  }
  retryCapsules.set(sessionId, { residuals: residuals.map(residual => ({ ...residual })), bytes });
  return { ok: true };
}

export function resolveRetryCommand(sessionId: string, command: { kind: "one" | "all"; ordinal?: number }): { input: string; selected: number[]; remaining: StoredRetryResidual[] } {
  const capsule = retryCapsules.get(sessionId);
  if (!capsule) throw new Error("Edit rejected: no_retry_available; there is no retained partial edit in this session.");
  if (command.kind === "all") return { input: capsule.residuals.map(residual => residual.input).join("\n"), selected: capsule.residuals.map((_, index) => index + 1), remaining: [] };
  if (command.ordinal === undefined) {
    if (capsule.residuals.length !== 1) throw new Error(`Edit rejected: retry_selection_required; the latest partial edit has ${capsule.residuals.length} remaining changes. Use RETRY N or RETRY ALL.`);
    return { input: capsule.residuals[0]!.input, selected: [1], remaining: [] };
  }
  const selected = capsule.residuals[command.ordinal - 1];
  if (!selected) throw new Error(`Edit rejected: retry_selection_invalid; remaining change ${command.ordinal} does not exist (available: 1-${capsule.residuals.length}).`);
  return { input: selected.input, selected: [command.ordinal], remaining: capsule.residuals.filter((_, index) => index !== command.ordinal! - 1).map(residual => ({ ...residual })) };
}

export function retryCapsuleForTests(sessionId: string): readonly StoredRetryResidual[] | undefined {
  return retryCapsules.get(sessionId)?.residuals;
}

export function recordNoChangeAttempt(sessionKey: string, path: string): number {
  const key = `${sessionKey}\0${path}`;
  const count = (noChangeAttempts.get(key) ?? 0) + 1;
  noChangeAttempts.set(key, count);
  return count;
}

export function resetNoChangeAttempts(sessionKey: string, path: string): void {
  noChangeAttempts.delete(`${sessionKey}\0${path}`);
}

export function clearEditSession(sessionKey: string): void {
  const prefix = `${sessionKey}\0`;
  for (const key of noChangeAttempts.keys()) if (key.startsWith(prefix)) noChangeAttempts.delete(key);
  retryCapsules.delete(sessionKey);
}
