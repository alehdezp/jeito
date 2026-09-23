import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withLocalFileMutationQueues } from "./mutation-queue.ts";
import { renderSimpleDiff, firstChangedLine } from "./diff-renderer.ts";
import { displayPath, resolvePath, canonicalMutationPath } from "./path-resolve.ts";
import { type ConcreteHunk, type Hunk, parsePatch, type PatchSection, type PatchSectionFailure } from "./patch-parser.ts";
import { repairConcreteHunks } from "./edit-repair.ts";
import { applyTargetIslands, compileTarget, compileTextTarget, serializeTargetIsland, targetIslandToHunk, type TargetIsland } from "./edit-target.ts";
import { parseRetryCommand, recordNoChangeAttempt, replaceRetryCapsule, resetNoChangeAttempts, resolveRetryCommand, type StoredRetryResidual } from "./edit-retry.ts";
import { formatHeader, formatNumberedLines } from "./read-renderer.ts";
import { computeDigest, computeTag, type Snapshot, type SnapshotBlock, snapshots } from "./snapshot-store.ts";
import { assertTextLike, detectLineEnding, joinLogicalLines, normalizeForSnapshot, normalizeToLF, restoreLineEndings, splitLogicalLines, stripBom } from "./text-normalize.ts";
import { validateLspPaths, type LspValidationResult } from "./lsp-validation.ts";
import { validateLandedSyntax, type SyntaxDiagnosticsResolver } from "./syntax-validation.ts";
import { isUpdatedFieldEligiblePath, stampUpdatedField, type MarkdownStamp } from "./updated-field-stamp.ts";

const SEEN_LINE_REVEAL_CAP = 40;
const SEEN_LINE_REVEAL_MAX_COLUMNS = 512;
const execFileP = promisify(execFile);
const extendedAttributePresence = new Map<string, boolean>();
type LspValidator = (input: { cwd: string; paths: string[]; root?: string; signal?: AbortSignal }) => Promise<LspValidationResult>;

export type ChangeOutcome =
  | { status: "accepted"; island: TargetIsland; hunk: ConcreteHunk }
  | { status: "repaired"; island: TargetIsland; hunk: ConcreteHunk; warning: string }
  | { status: "skipped"; reason: "no_change"; operationLine: number }
  | { status: "held"; reason: "unseen" | "stale"; island: TargetIsland; residual: string; detail?: string }
  | { status: "rejected"; reason: "bounds" | "conflict" | "repair_ambiguous"; operationLine: number; island?: TargetIsland; detail: string };

interface PreparedSection {
  section: PatchSection;
  operation: "edit" | "delete" | "move";
  absolutePath: string;
  canonicalPath: string;
  display: string;
  destinationPath?: string;
  destinationDisplay?: string;
  beforeNormalized: string;
  beforeRaw: string;
  beforeDigest: string;
  sourceIdentity: string;
  afterNormalized: string;
  beforeSeenLines: Set<number>;
  beforeBlocks?: SnapshotBlock[];
  afterSeenLines: Set<number>;
  afterBlocks?: SnapshotBlock[];
  resolvedHunks?: ConcreteHunk[];
  warnings: string[];
  bom: string;
  lineEnding: "\n" | "\r\n";
  firstChanged?: number;
  metadataInsertion?: MarkdownStamp["insertion"];
  metadataTime?: Date;
  mode: number;
  sessionKey: string;
  outcomes: ChangeOutcome[];
}

interface StagedSection {
  item: PreparedSection;
  temporaryPath: string;
  backupPath: string;
  persisted: string;
  temporaryPresent: boolean;
  backupPresent: boolean;
  preserveBackup?: boolean;
}

export interface RetryResidual {
  path: string;
  operationLine: number;
  reason: "unseen" | "stale";
  input: string;
}

export interface FileOutcome {
  path: string;
  status: "landed" | "skipped" | "failed" | "cancelled";
  operation?: "edit" | "delete" | "move";
  changes: ChangeOutcome[];
  message?: string;
}

export interface ApplyPatchResult {
  text: string;
  details: {
    status: "success" | "partial" | "error";
    files: FileOutcome[];
    changedPaths: string[];
    refreshPaths: string[];
    residuals: RetryResidual[];
    cancelled?: boolean;
  };
}

interface SectionApplyFailure { path: string; text: string }

export type RecoverEditAuthority = (canonicalPath: string, text: string) => Iterable<number> | undefined;

export async function applyPatch(params: { cwd: string; patch: string; signal?: AbortSignal; sessionId?: string; retryInvocation?: boolean; carriedResiduals?: StoredRetryResidual[]; syntaxResolver?: SyntaxDiagnosticsResolver; lspValidator?: LspValidator; recoverAuthority?: RecoverEditAuthority }): Promise<ApplyPatchResult> {
  const sessionId = params.sessionId ?? params.cwd;
  const retryCommand = parseRetryCommand(params.patch);
  if (retryCommand) {
    const resolved = resolveRetryCommand(sessionId, retryCommand);
    return applyPatch({ ...params, patch: resolved.input, sessionId, retryInvocation: true, carriedResiduals: resolved.remaining });
  }
  let parsed;
  try {
    parsed = parsePatch(params.patch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Edit rejected: syntax_error; no files were written.\n${message}`);
  }

  let prepared: PreparedSection[] = [];
  const sectionFailures: SectionApplyFailure[] = parsed.failures.map(failure => ({ path: failure.path, text: renderParsedSectionFailure(failure) }));
  for (const section of parsed.sections) {
    try {
      prepared.push(await prepareSection(params.cwd, section, params.recoverAuthority));
    } catch (error) {
      sectionFailures.push({ path: section.path, text: `Rejected section for ${section.path} at input line ${section.headerLine}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  prepared = combinePreparedSections(prepared, sectionFailures);
  assertUniqueMutationPaths(prepared);

  const actionable = prepared.filter(item => item.operation !== "edit" || item.beforeNormalized !== item.afterNormalized);
  const unchanged = prepared.filter(item => item.operation === "edit" && item.beforeNormalized === item.afterNormalized);
  for (const item of unchanged) {
    if (item.outcomes.length > 0 && item.outcomes.every(outcome => outcome.status === "skipped")) {
      const attempts = recordNoChangeAttempt(item.sessionKey, item.canonicalPath);
      if (attempts >= 3) throw new Error(`Edit rejected: repeated_no_change; ${item.display} already matches the requested target. Stop retrying the same operation and use the fresh source coordinates if another change is needed.\nNo files were written.`);
    }
  }

  const fileOutcomes: FileOutcome[] = unchanged.map(item => ({ path: item.display, status: "skipped", operation: item.operation, changes: item.outcomes }));
  fileOutcomes.push(...sectionFailures.map(failure => ({ path: failure.path, status: "failed" as const, changes: [], message: failure.text })));
  const textParts = [...unchanged.map(renderUnchangedResult), ...sectionFailures.map(failure => failure.text)];
  const changedPaths: string[] = [];
  let cancelled = false;

  if (actionable.length > 0) {
    await withLocalFileMutationQueues(mutationPaths(actionable), async () => {
      const staged: StagedSection[] = [];
      if (!params.signal?.aborted) {
        for (const item of actionable) {
          try {
            await revalidatePrepared([item], "before staging");
            staged.push(...await stagePrepared([item]));
          } catch (error) {
            fileOutcomes.push({ path: item.display, status: "failed", operation: item.operation, changes: item.outcomes, message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      if (params.signal?.aborted) {
        cancelled = true;
        await cleanupStaged(staged);
        for (const item of actionable.filter(candidate => !fileOutcomes.some(outcome => outcome.path === candidate.display))) {
          fileOutcomes.push({ path: item.display, status: "cancelled", operation: item.operation, changes: item.outcomes, message: "Cancelled before file landing." });
        }
        return;
      }
      for (let index = 0; index < staged.length; index++) {
        const entry = staged[index]!;
        if (params.signal?.aborted) {
          cancelled = true;
          for (const remaining of staged.slice(index)) fileOutcomes.push({ path: remaining.item.display, status: "cancelled", operation: remaining.item.operation, changes: remaining.item.outcomes, message: "Cancelled before this file landed." });
          await cleanupStaged(staged.slice(index));
          break;
        }
        try {
          await revalidatePrepared([entry.item], "after staging");
          textParts.unshift(await commitStaged([entry]));
          changedPaths.push(...landedPaths(entry.item));
          if (entry.item.operation !== "delete") {
            const syntaxPath = entry.item.destinationPath ?? entry.item.absolutePath;
            const syntax = await validateLandedSyntax({
              path: syntaxPath,
              before: entry.item.operation === "move" ? entry.item.afterNormalized : entry.item.beforeNormalized,
              after: entry.item.afterNormalized,
              signal: params.signal,
              resolveDiagnostics: params.syntaxResolver,
            });
            if (syntax) textParts.push(syntax.text);
          }
          fileOutcomes.push({ path: entry.item.display, status: "landed", operation: entry.item.operation, changes: entry.item.outcomes });
        } catch (error) {
          fileOutcomes.push({ path: entry.item.display, status: "failed", operation: entry.item.operation, changes: entry.item.outcomes, message: error instanceof Error ? error.message : String(error) });
        } finally {
          await cleanupStaged([entry]);
        }
      }
    });
  }

  const lspRequested = prepared.filter(item => item.section.checkLsp);
  if (lspRequested.length > 0) {
    const landed = lspRequested.filter(item => fileOutcomes.some(file => file.path === item.display && file.status === "landed"));
    if (landed.length === 0) textParts.push("LSP validation skipped: CHECK LSP was requested, but no corresponding file landed.");
    else {
      const lsp = await (params.lspValidator ?? validateLspPaths)({ cwd: params.cwd, root: params.cwd, paths: [...new Set(landed.map(item => item.destinationPath ?? item.absolutePath))], signal: params.signal });
      textParts.push(lsp.text);
    }
  }

  const hasAttention = cancelled || fileOutcomes.some(file => file.status === "failed" || file.status === "cancelled" || file.changes.some(change => change.status === "held" || change.status === "rejected"));
  for (const file of fileOutcomes) if (file.message && !textParts.includes(file.message)) textParts.push(file.message);
  const residuals = [...(params.carriedResiduals ?? []), ...buildRetryResiduals(prepared, fileOutcomes)];
  const capsule = replaceRetryCapsule(sessionId, residuals);
  if (residuals.length > 0 && capsule.ok) textParts.push(renderRetryResiduals(residuals));
  else if (!capsule.ok) textParts.push(`Retry unavailable: ${capsule.reason}. Use the displayed source and a normal edit instead.`);
  if (hasAttention) textParts.push("Needs attention: one or more changes were held, rejected, cancelled, or failed; successful files remain landed.");
  const paths = [...new Set(changedPaths)];
  return {
    text: textParts.join("\n\n"),
    details: {
      status: hasAttention ? (paths.length ? "partial" : "error") : "success",
      files: fileOutcomes,
      changedPaths: paths,
      refreshPaths: paths,
      residuals: residuals.map(({ context: _context, ...residual }) => residual),
      ...(cancelled ? { cancelled: true } : {}),
    },
  };
}

function buildRetryResiduals(items: PreparedSection[], files: FileOutcome[]): StoredRetryResidual[] {
  const residuals: StoredRetryResidual[] = [];
  for (const item of items) {
    if (!files.some(file => file.path === item.display && file.status === "landed")) continue;
    const held = item.outcomes.filter((outcome): outcome is Extract<ChangeOutcome, { status: "held" }> => outcome.status === "held");
    if (held.length === 0) continue;
    const snapshot = snapshots.head(item.canonicalPath);
    if (!snapshot) continue;
    const before = splitLogicalLines(item.beforeNormalized).lines;
    const landed = splitLogicalLines(item.afterNormalized).lines;
    const accepted = item.outcomes.flatMap(outcome => outcome.status === "accepted" || outcome.status === "repaired" ? [outcome.island] : []);
    for (const outcome of held) {
      const currentHashAuthored = item.section.tag === computeTag(item.beforeNormalized);
      let compiled: ReturnType<typeof compileTextTarget> | undefined;
      if (currentHashAuthored) {
        let target = applyTargetIslands(before, [...accepted, outcome.island]);
        try {
          // Retry the requested change, not removal of metadata added at landing.
          if (item.metadataTime) target = splitLogicalLines(stampUpdatedField(joinLogicalLines(target, true), item.metadataTime).text).lines;
          compiled = compileTextTarget(landed, target, outcome.island);
        } catch {
          // Pending invalid YAML retains its original hash/intent for normal
          // recovery and validation; it must not undo an already landed file.
        }
      }
      const changes = compiled?.islands.length ? compiled.islands : [outcome.island];
      for (const change of changes) {
        const tag = compiled ? snapshot.tag : item.section.tag;
        const sourceLineCount = compiled ? landed.length : before.length;
        residuals.push({
          path: item.display,
          operationLine: outcome.island.operationLine,
          reason: outcome.reason,
          input: `[${item.display}#${tag}]\n${serializeTargetIsland(change, sourceLineCount)}`,
          context: retryContext(item.afterNormalized, change),
        });
      }
    }
  }
  return residuals;
}

function retryContext(text: string, change: TargetIsland): string {
  const lines = splitLogicalLines(text).lines;
  const anchor = Math.min(lines.length, Math.max(1, change.sourceStartIndex + 1));
  const start = Math.max(1, anchor - 2);
  const end = Math.min(lines.length, Math.max(anchor, change.sourceEndIndex) + 2);
  return formatNumberedLines(lines.slice(start - 1, end), start);
}

function renderRetryResiduals(residuals: StoredRetryResidual[]): string {
  const rows = residuals.map((residual, index) => `Remaining change ${index + 1} for ${residual.path} (input line ${residual.operationLine}):\n${residual.context}`);
  const command = residuals.length === 1 ? `edit({ input: "RETRY" })` : `edit({ input: "RETRY N" }) for one, or edit({ input: "RETRY ALL" }) for all`;
  return `${rows.join("\n\n")}\n\nRetry with ${command}.`;
}

function renderParsedSectionFailure(failure: PatchSectionFailure): string {
  return `Rejected section for ${failure.path} at input line ${failure.headerLine}: ${failure.message}`;
}

function combinePreparedSections(items: PreparedSection[], failures: SectionApplyFailure[]): PreparedSection[] {
  const groups = new Map<string, PreparedSection[]>();
  for (const item of items) {
    const key = item.canonicalPath.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const combined: PreparedSection[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      combined.push(group[0]!);
      continue;
    }
    const first = group[0]!;
    if (group.some(item => item.operation !== "edit")) {
      failures.push({ path: first.display, text: `Rejected ${group.length} sections for ${first.display}: whole-file operations cannot be combined with another section for the same path.` });
      continue;
    }
    if (group.some(item => item.beforeDigest !== first.beforeDigest || item.sourceIdentity !== first.sourceIdentity)) {
      failures.push({ path: first.display, text: `Rejected ${group.length} sections for ${first.display}: the file changed while same-path sections were being prepared.` });
      continue;
    }
    const outcomes = rejectTargetConflicts(group.flatMap(item => item.outcomes));
    const hunks = acceptedHunks(outcomes);
    const afterNormalized = applyHunks(first.beforeNormalized, hunks, first.display);
    const changed = firstChangedLine(first.beforeNormalized, afterNormalized);
    const afterSeenLines = seenLinesAfterEdit(first.beforeNormalized, hunks, first.beforeSeenLines);
    if (changed !== undefined) {
      const context = editContextRange(afterNormalized, changed);
      for (let line = context.start; line <= context.end; line++) afterSeenLines.add(line);
    }
    const section: PatchSection = {
      ...first.section,
      hunks: group.flatMap(item => item.section.hunks),
      checkLsp: group.some(item => item.section.checkLsp),
      warnings: group.flatMap(item => item.section.warnings),
    };
    combined.push({
      ...first,
      section,
      afterNormalized,
      afterSeenLines,
      afterBlocks: blocksAfterEdit(first.beforeBlocks, first.beforeNormalized, hunks),
      resolvedHunks: hunks.map(cloneConcreteHunk),
      outcomes,
      warnings: [...group.flatMap(item => item.warnings), ...conflictWarnings(outcomes), `Composed ${group.length} same-path sections in input order under one atomic file replacement.`],
      firstChanged: changed,
    });
  }
  return combined;
 }

function landedPaths(item: PreparedSection): string[] {
  if (item.operation === "move") return [item.display, item.destinationDisplay!];
  return [item.display];
}

async function revalidatePrepared(prepared: PreparedSection[], phase: string): Promise<void> {
  for (const item of prepared) {
    if (await currentFileIdentity(item.canonicalPath) !== item.sourceIdentity) {
      throw new Error(`Edit rejected: changed_after_preflight; ${item.display} changed ${phase}. No files were written. Re-read the affected range and retry.`);
    }
    if (item.destinationPath && await pathExists(item.destinationPath)) {
      throw new Error(`Edit rejected: destination_changed_after_preflight; ${item.destinationDisplay} appeared ${phase}. No files were written.`);
    }
  }
}

async function stagePrepared(prepared: PreparedSection[]): Promise<StagedSection[]> {
  const batchId = `${process.pid}-${randomUUID()}`;
  const staged: StagedSection[] = [];
  try {
    for (let index = 0; index < prepared.length; index++) {
      const item = prepared[index]!;
      if (item.operation === "edit" && isUpdatedFieldEligiblePath(item.canonicalPath)) {
        item.metadataTime = new Date();
        const stamp = stampUpdatedField(item.afterNormalized, item.metadataTime);
        // The preview moves to the metadata if that becomes the first change.
        // Retain observed/authored rows, not the former preview's unseen neighbors.
        item.afterSeenLines = seenLinesAfterEdit(item.beforeNormalized, item.resolvedHunks ?? [], item.beforeSeenLines);
        const insertion = stamp.insertion;
        if (insertion) {
          const hunk: ConcreteHunk = { kind: "insert", position: "before", lineNumber: insertion.line, line: item.section.headerLine, body: splitLogicalLines(stamp.text).lines.slice(insertion.line - 1, insertion.line - 1 + insertion.count) };
          item.afterSeenLines = seenLinesAfterEdit(item.afterNormalized, [hunk], item.afterSeenLines);
          item.afterBlocks = blocksAfterEdit(item.afterBlocks, item.afterNormalized, [hunk]);
          for (let line = insertion.line; line < insertion.line + insertion.count; line++) item.afterSeenLines.delete(line);
          item.metadataInsertion = insertion;
        }
        if (stamp.text !== item.afterNormalized) item.afterSeenLines.delete(stamp.updatedLine);
        item.afterNormalized = stamp.text;
        item.firstChanged = firstChangedLine(item.beforeNormalized, stamp.text);
        const context = editContextRange(stamp.text, item.firstChanged ?? 1);
        for (let line = context.start; line <= context.end; line++) item.afterSeenLines.add(line);
      }
      const stem = `.${basename(item.canonicalPath)}.pi-edit-${batchId}-${index}`;
      const temporaryPath = join(dirname(item.canonicalPath), `${stem}.tmp`);
      const backupPath = join(dirname(item.canonicalPath), `${stem}.bak`);
      const persisted = item.operation === "edit" ? item.bom + restoreLineEndings(item.afterNormalized, item.lineEnding) : item.beforeRaw;
      const entry: StagedSection = { item, temporaryPath, backupPath, persisted, temporaryPresent: true, backupPresent: false };
      staged.push(entry);
      if (item.operation === "edit") {
        await stageAtomicEdit(item.canonicalPath, temporaryPath, persisted, item.mode);
      } else {
        await writeFile(temporaryPath, persisted, { encoding: "utf8", mode: item.mode & 0o777 });
      }
    }
    return staged;
  } catch (error) {
    await cleanupStaged(staged);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Edit rejected: staging_failed; no files were written.\n${message}`);
  }
}

async function commitStaged(staged: StagedSection[]): Promise<string> {
  if (staged.length !== 1) throw new Error(`internal_edit_contract: file-local commit expected one staged file, received ${staged.length}`);
  const entry = staged[0]!;
  try {
    if (entry.item.operation === "edit") {
      if ((entry.item.mode & 0o222) === 0) throw new Error(`EACCES: ${entry.item.display} is not writable`);
      await link(entry.item.canonicalPath, entry.backupPath);
      entry.backupPresent = true;
      const backupRaw = await readFile(entry.backupPath, "utf8");
      if (backupRaw !== entry.item.beforeRaw) throw new Error(`changed_after_preflight: ${entry.item.display} changed immediately before atomic replacement`);
      await rename(entry.temporaryPath, entry.item.canonicalPath);
      entry.temporaryPresent = false;
    } else if (entry.item.operation === "delete") {
      await unlink(entry.item.canonicalPath);
    } else {
      await rename(entry.item.canonicalPath, entry.item.destinationPath!);
    }
  } catch (error) {
    try {
      await rollbackEntry(entry);
    } catch (rollbackError) {
      entry.preserveBackup = true;
      throw new Error(`Edit failed: rollback_incomplete. Inspect ${entry.item.display} before continuing.\nCommit error: ${error instanceof Error ? error.message : String(error)}\nRollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw new Error(`Edit rejected: commit_failed; ${entry.item.display} was restored and unrelated successful files remain landed.\n${error instanceof Error ? error.message : String(error)}`);
  }

  resetNoChangeAttempts(entry.item.sessionKey, entry.item.canonicalPath);
  if (entry.item.operation === "edit") {
    const snapshot = snapshots.record(entry.item.canonicalPath, entry.item.afterNormalized, entry.item.afterSeenLines, entry.item.afterBlocks);
    return renderEditResult(entry.item, snapshot.tag);
  }
  if (entry.item.operation === "delete") {
    snapshots.invalidate(entry.item.canonicalPath);
    return `Deleted file ${entry.item.display} (verified hash #${entry.item.section.tag}).`;
  }
  snapshots.invalidate(entry.item.destinationPath!);
  if (!snapshots.relocate(entry.item.canonicalPath, entry.item.destinationPath!, entry.item.beforeDigest)) {
    snapshots.invalidate(entry.item.canonicalPath);
    snapshots.record(entry.item.destinationPath!, entry.item.beforeNormalized, entry.item.afterSeenLines, entry.item.afterBlocks);
  }
  return `${formatHeader(entry.item.destinationDisplay!, entry.item.section.tag)}\nMoved file ${entry.item.display} to ${entry.item.destinationDisplay}. The hash and previously displayed line authority moved with the file.`;
}

async function rollbackEntry(entry: StagedSection): Promise<void> {
  const item = entry.item;
  if (item.operation === "edit") {
    if (await pathExists(item.canonicalPath) && computeDigest(normalizeForSnapshot(await readFile(item.canonicalPath, "utf8"))) === item.beforeDigest) return;
    if (entry.backupPresent && await pathExists(entry.backupPath)) {
      await rename(entry.backupPath, item.canonicalPath);
      entry.backupPresent = false;
      await syncDirectory(dirname(item.canonicalPath));
    } else await writeFile(item.canonicalPath, item.beforeRaw, "utf8");
    return;
  }
  if (item.operation === "delete") {
    if (!await pathExists(item.canonicalPath)) await writeFile(item.canonicalPath, item.beforeRaw, { encoding: "utf8", mode: item.mode & 0o777 });
    else if (computeDigest(normalizeForSnapshot(await readFile(item.canonicalPath, "utf8"))) !== item.beforeDigest) throw new Error("source path contains unexpected bytes during rollback");
    return;
  }
  const sourceExists = await pathExists(item.canonicalPath);
  const destinationExists = await pathExists(item.destinationPath!);
  if (!sourceExists && destinationExists) await rename(item.destinationPath!, item.canonicalPath);
  else if (!sourceExists || destinationExists) throw new Error("move rollback found an ambiguous source/destination state");
}

async function cleanupStaged(staged: StagedSection[]): Promise<void> {
  await Promise.all(staged.flatMap(entry => [
    ...(entry.temporaryPresent ? [entry.temporaryPath] : []),
    ...(entry.backupPresent && !entry.preserveBackup ? [entry.backupPath] : []),
  ].map(async path => {
    try { await unlink(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
  })));
}

async function stageAtomicEdit(source: string, destination: string, content: string, mode: number): Promise<void> {
  if (process.platform === "darwin" && await sourceHasExtendedAttributes(source)) {
    await execFileP("/bin/cp", ["-p", source, destination]);
    await chmod(destination, (mode & 0o777) | 0o200);
    await writeFile(destination, content, "utf8");
    await chmod(destination, mode & 0o777);
    return;
  }
  await writeFile(destination, content, { encoding: "utf8", mode: mode & 0o777 });
}

async function sourceHasExtendedAttributes(source: string): Promise<boolean> {
  const cached = extendedAttributePresence.get(source);
  if (cached !== undefined) return cached;
  try {
    const result = await execFileP("/usr/bin/xattr", [source]);
    const present = String(result.stdout ?? "").trim().length > 0;
    extendedAttributePresence.set(source, present);
    return present;
  } catch {
    // If metadata inspection itself is unavailable, preserve by taking the
    // slower metadata-copy path rather than silently dropping attributes.
    extendedAttributePresence.set(source, true);
    return true;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function prepareSection(cwd: string, section: PatchSection, recoverAuthority?: RecoverEditAuthority): Promise<PreparedSection> {
  let absolutePath = resolvePath(cwd, section.path);
  let pathRecoveryWarning: string | undefined;
  let info;
  try {
    info = await stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const recovered = await recoverMissingSectionPath(cwd, section, absolutePath);
    if (!recovered) throw new Error(`Edit rejected: file_not_found; ${section.path}. Use write({ path, content }) to create new files.`);
    absolutePath = recovered;
    info = await stat(absolutePath);
    pathRecoveryWarning = `Recovered missing authored path ${section.path} to ${displayPath(cwd, absolutePath, absolutePath)} by one unique basename + #${section.tag} session snapshot match.`;
  }
  if (info.isDirectory()) throw new Error(`Edit rejected: wrong_file_type; ${section.path} is a directory, not a file.`);
  if (!info.isFile()) throw new Error(`Edit rejected: wrong_file_type; ${section.path} is not a regular file.`);
  if (section.fileOperation && (await lstat(absolutePath)).isSymbolicLink()) throw new Error(`Edit rejected: symlink_source; whole-file operations refuse symlink sources: ${section.path}.`);
  const canonicalPath = canonicalMutationPath(absolutePath);
  const display = displayPath(cwd, absolutePath, section.path);
  const beforeRaw = await readFile(canonicalPath, "utf8");
  const sourceIdentity = fileIdentity(info);
  assertTextLike(section.path, beforeRaw);
  const { bom, text } = stripBom(beforeRaw);
  const lineEnding = detectLineEnding(text);
  const beforeNormalized = normalizeToLF(text);
  const beforeDigest = computeDigest(beforeNormalized);
  const liveTag = computeTag(beforeNormalized);
  const stored = snapshots.byTag(canonicalPath, section.tag);
  let provenance: Snapshot | undefined;
  let appliedHunks: ConcreteHunk[] = [];
  let outcomes: ChangeOutcome[] = [];
  let currentSeenLines: Set<number> | undefined;
  const warnings: string[] = [...section.warnings, ...(pathRecoveryWarning ? [pathRecoveryWarning] : [])];

  if (section.fileOperation) {
    const projectRoot = await realpath(cwd);
    if (liveTag !== section.tag) throw mismatchError(display, section, liveTag, beforeNormalized, Boolean(stored), "whole-file operations require the exact current hash; stale recovery is not allowed");
    provenance = snapshots.byContent(canonicalPath, beforeNormalized) ?? snapshots.restore(canonicalPath, beforeNormalized);
    if (!provenance) {
      // Whole-file intent still needs the current hash, not a whole-file read.
      // But moving a file must not invent row authority for later line edits.
      provenance = snapshots.record(canonicalPath, beforeNormalized, recoverAuthority?.(canonicalPath, beforeNormalized) ?? []);
    }
    if (provenance.tag !== section.tag) throw mismatchError(display, section, liveTag, beforeNormalized, false, "exact current-content snapshot is unavailable or ambiguous");
    let destinationPath: string | undefined;
    let destinationDisplay: string | undefined;
    if (section.fileOperation.kind === "move_file") {
      const destination = await prepareMoveDestination(cwd, projectRoot, canonicalPath, section.fileOperation.destination);
      destinationPath = destination.path;
      destinationDisplay = destination.display;
    }
    return {
      section,
      operation: section.fileOperation.kind === "delete_file" ? "delete" : "move",
      absolutePath: canonicalPath,
      canonicalPath,
      display,
      destinationPath,
      destinationDisplay,
      beforeNormalized,
      beforeDigest,
      sourceIdentity,
      afterNormalized: beforeNormalized,
      beforeSeenLines: new Set(provenance.seenLines ?? []),
      beforeBlocks: provenance.blocks ? [...provenance.blocks] : undefined,
      afterBlocks: provenance.blocks ? [...provenance.blocks] : undefined,
      afterSeenLines: new Set(provenance.seenLines ?? []),
      warnings,
      bom,
      lineEnding,
      beforeRaw,
      mode: info.mode,
      sessionKey: cwd,
      outcomes: [],
    };
  }

  if (liveTag === section.tag) {
    provenance = snapshots.byContent(canonicalPath, beforeNormalized);
    if (!provenance) {
      provenance = snapshots.restore(canonicalPath, beforeNormalized)
        ?? snapshots.record(canonicalPath, beforeNormalized, recoverAuthority?.(canonicalPath, beforeNormalized) ?? []);
      if (provenance.seenLines === undefined || provenance.seenLines.size > 0) {
        warnings.push(`Re-authorized ${display} from previously delivered unchanged source; no additional read required.`);
      }
    }
    currentSeenLines = provenance.seenLines;
    const resolved = resolveBlockHunks(section.hunks, provenance, display);
    const repaired = repairResolvedHunks(provenance.text, resolved.hunks);
    const preparedTargets = compileCurrentTargetOutcomes(section, provenance, resolved.hunks, repaired.hunks, repaired.warningsByOperation, repaired.outcomes);
    outcomes = preparedTargets.outcomes;
    appliedHunks = preparedTargets.hunks;
    warnings.push(...resolved.warnings, ...repaired.warnings, ...preparedTargets.warnings);
  } else if (stored) {
    provenance = stored;
    const resolved = resolveBlockHunks(section.hunks, stored, display);
    const repaired = repairResolvedHunks(stored.text, resolved.hunks);
    const preparedTargets = await compileStaleTargetOutcomes(section, canonicalPath, stored, beforeNormalized, resolved.hunks, repaired.hunks, repaired.warningsByOperation, repaired.outcomes);
    outcomes = preparedTargets.outcomes;
    appliedHunks = preparedTargets.hunks;
    const currentSnapshot = snapshots.byContent(canonicalPath, beforeNormalized);
    currentSeenLines = currentSnapshot?.seenLines ?? seenLinesStillAtSameCoordinates(stored, beforeNormalized);
    warnings.push(...resolved.warnings, ...repaired.warnings, ...preparedTargets.warnings);
  } else {
    throw mismatchError(display, section, liveTag, beforeNormalized, false);
  }

  const afterNormalized = applyHunks(beforeNormalized, appliedHunks, display);
  const changed = firstChangedLine(beforeNormalized, afterNormalized);
  const afterSeenLines = seenLinesAfterEdit(beforeNormalized, appliedHunks, currentSeenLines);
  const afterBlocks = liveTag === section.tag ? blocksAfterEdit(provenance?.blocks, beforeNormalized, appliedHunks) : undefined;
  if (changed !== undefined) {
    const context = editContextRange(afterNormalized, changed);
    for (let line = context.start; line <= context.end; line++) afterSeenLines.add(line);
  }
  return {
    section,
    operation: "edit",
    absolutePath: canonicalPath,
    canonicalPath,
    display,
    beforeNormalized,
    beforeDigest,
    sourceIdentity,
    beforeSeenLines: new Set(currentSeenLines ?? []),
    beforeBlocks: liveTag === section.tag && provenance?.blocks ? [...provenance.blocks] : undefined,
    afterNormalized,
    afterSeenLines,
    afterBlocks,
    resolvedHunks: appliedHunks.map(hunk => hunk.kind === "replace" || hunk.kind === "insert" ? { ...hunk, body: [...hunk.body] } : { ...hunk }),
    warnings,
    bom,
    lineEnding,
    beforeRaw,
    firstChanged: changed,
    mode: info.mode,
    sessionKey: cwd,
    outcomes,
  };
}


async function recoverMissingSectionPath(cwd: string, section: PatchSection, authoredPath: string): Promise<string | undefined> {
  const name = basename(authoredPath);
  const candidates = snapshots.findByTag(section.tag).filter(snapshot => basename(snapshot.canonicalPath) === name);
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0]!.canonicalPath;
  const root = await realpath(cwd);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) return undefined;
  const info = await lstat(candidate).catch(() => undefined);
  return info?.isFile() && !info.isSymbolicLink() ? candidate : undefined;
}

interface RepairedOperations {
  hunks: Array<ConcreteHunk | undefined>;
  warnings: string[];
  warningsByOperation: string[][];
  outcomes: ChangeOutcome[];
}

function repairResolvedHunks(text: string, hunks: ConcreteHunk[]): RepairedOperations {
  try {
    const whole = repairConcreteHunks(text, hunks);
    const warningsByOperation = whole.hunks.map((hunk, index) => hunksEqual(hunks[index], hunk) ? [] : [...whole.warnings]);
    return { hunks: whole.hunks, warnings: whole.warnings, warningsByOperation, outcomes: [] };
  } catch {
    // Fall back to per-operation repair so one ambiguous operation cannot erase
    // deterministic repairs and valid siblings. The whole-patch pass is used
    // whenever it is itself unambiguous.
  }
  const repaired: Array<ConcreteHunk | undefined> = [];
  const warnings: string[] = [];
  const warningsByOperation: string[][] = [];
  const outcomes: ChangeOutcome[] = [];
  for (const hunk of hunks) {
    try {
      const result = repairConcreteHunks(text, [hunk]);
      repaired.push(result.hunks[0]);
      warningsByOperation.push(result.warnings);
      warnings.push(...result.warnings);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      repaired.push(undefined);
      warningsByOperation.push([]);
      outcomes.push({ status: "rejected", reason: "repair_ambiguous", operationLine: hunk.line, detail });
      warnings.push(`Rejected change from input line ${hunk.line}: deterministic repair was ambiguous.`);
    }
  }
  return { hunks: repaired, warnings, warningsByOperation, outcomes };
}

interface TargetOutcomePreparation {
  outcomes: ChangeOutcome[];
  hunks: ConcreteHunk[];
  warnings: string[];
}

function compileCurrentTargetOutcomes(section: PatchSection, snapshot: Snapshot, resolved: ConcreteHunk[], repaired: Array<ConcreteHunk | undefined>, repairWarnings: string[][], initialOutcomes: ChangeOutcome[]): TargetOutcomePreparation {
  const source = splitLogicalLines(snapshot.text).lines;
  const outcomes: ChangeOutcome[] = [...initialOutcomes];
  const unseen = new Set<number>();
  let phantomDeletes = 0;
  for (let operationIndex = 0; operationIndex < repaired.length; operationIndex++) {
    const hunk = repaired[operationIndex];
    if (!hunk) continue;
    if (snapshot.text.endsWith("\n") && hunk.kind === "delete" && hunk.start === source.length + 1 && hunk.end === hunk.start) {
      outcomes.push({ status: "skipped", reason: "no_change", operationLine: hunk.line });
      phantomDeletes++;
      continue;
    }
    const origin = { sectionIndex: section.headerLine, operationIndex, inputOrder: hunk.line, operationLine: hunk.line };
    let target;
    try {
      target = compileTarget(source, hunk, origin);
    } catch (error) {
      outcomes.push({ status: "rejected", reason: "bounds", operationLine: hunk.line, detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (target.converged) {
      outcomes.push({ status: "skipped", reason: "no_change", operationLine: hunk.line });
      continue;
    }
    const wasRepaired = !hunksEqual(resolved[operationIndex], hunk);
    for (const compiledChange of target.islands) {
      const change = bindOperationAuthority(compiledChange, section.hunks[operationIndex]);
      const missing = snapshot.seenLines ? change.requiredRows.filter(line => !snapshot.seenLines!.has(line)) : [];
      if (missing.length > 0) {
        for (const line of missing) unseen.add(line);
        outcomes.push({ status: "held", reason: "unseen", island: change, residual: serializeTargetIsland(change, source.length) });
        continue;
      }
      const concrete = target.islands.length === 1 ? cloneConcreteHunk(hunk) : targetIslandToHunk(change, source.length);
      outcomes.push(wasRepaired
        ? { status: "repaired", island: change, hunk: concrete, warning: repairWarnings[operationIndex]?.join(" ") || "The authored replacement was deterministically repaired." }
        : { status: "accepted", island: change, hunk: concrete });
    }
  }
  const conflicted = rejectTargetConflicts(outcomes);
  return {
    outcomes: conflicted,
    hunks: acceptedHunks(conflicted),
    warnings: [...(phantomDeletes ? [`Skipped ${phantomDeletes} deletion(s) of the synthetic trailing split row; the real final newline and blank lines are unchanged.`] : []), ...(unseen.size > 0 ? [renderHeldUnseen(section, snapshot, [...unseen])] : []), ...rejectionWarnings(conflicted), ...conflictWarnings(conflicted)],
  };
}

async function compileStaleTargetOutcomes(section: PatchSection, canonicalPath: string, snapshot: Snapshot, currentText: string, resolved: ConcreteHunk[], repaired: Array<ConcreteHunk | undefined>, repairWarnings: string[][], initialOutcomes: ChangeOutcome[]): Promise<TargetOutcomePreparation> {
  const previousLines = splitLogicalLines(snapshot.text).lines;
  const currentLines = splitLogicalLines(currentText).lines;
  const outcomes: ChangeOutcome[] = [...initialOutcomes];
  const warnings: string[] = [];
  const unseen = new Set<number>();
  let phantomDeletes = 0;
  const { recoverEditAsync } = await import("./edit-recovery.ts");

  for (let operationIndex = 0; operationIndex < repaired.length; operationIndex++) {
    const authored = repaired[operationIndex];
    if (!authored) continue;
    if (snapshot.text.endsWith("\n") && authored.kind === "delete" && authored.start === previousLines.length + 1 && authored.end === authored.start) {
      outcomes.push({ status: "skipped", reason: "no_change", operationLine: authored.line });
      phantomDeletes++;
      continue;
    }
    const origin = { sectionIndex: section.headerLine, operationIndex, inputOrder: authored.line, operationLine: authored.line };
    let target;
    try {
      target = compileTarget(previousLines, authored, origin);
    } catch (error) {
      outcomes.push({ status: "rejected", reason: "bounds", operationLine: authored.line, detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (target.converged) {
      outcomes.push({ status: "skipped", reason: "no_change", operationLine: authored.line });
      continue;
    }
    const wasRepaired = !hunksEqual(resolved[operationIndex], authored);
    for (const compiledChange of target.islands) {
      const change = bindOperationAuthority(compiledChange, section.hunks[operationIndex]);
      const missing = snapshot.seenLines ? change.requiredRows.filter(line => !snapshot.seenLines!.has(line)) : [];
      if (missing.length > 0) {
        for (const line of missing) unseen.add(line);
        outcomes.push({ status: "held", reason: "unseen", island: change, residual: serializeTargetIsland(change, previousLines.length) });
        continue;
      }
      const recovered = await recoverEditAsync({
        previousText: snapshot.text,
        currentText,
        hunks: [targetIslandToHunk(change, previousLines.length)],
        authorizedLines: snapshot.seenLines ?? new Set<number>(),
        isHeadSnapshot: snapshots.head(canonicalPath) === snapshot,
      });
      if (!recovered.ok) {
        outcomes.push({ status: "held", reason: "stale", island: change, residual: serializeTargetIsland(change, previousLines.length), detail: `${recovered.reason}: ${recovered.detail}` });
        warnings.push(`Held remaining change from input line ${change.operationLine}: stale source could not be remapped safely (${recovered.reason}).`);
        continue;
      }
      warnings.push(...recovered.warnings);
      const recoveredTarget = compileTextTarget(currentLines, splitLogicalLines(recovered.text).lines, change);
      if (recoveredTarget.converged) {
        outcomes.push({ status: "skipped", reason: "no_change", operationLine: change.operationLine });
        continue;
      }
      for (const recoveredIsland of recoveredTarget.islands) {
        const concrete = targetIslandToHunk(recoveredIsland, currentLines.length);
        outcomes.push(wasRepaired
          ? { status: "repaired", island: recoveredIsland, hunk: concrete, warning: repairWarnings[operationIndex]?.join(" ") || "The authored replacement was deterministically repaired." }
          : { status: "accepted", island: recoveredIsland, hunk: concrete });
      }
    }
  }
  if (unseen.size > 0) warnings.push(renderHeldUnseen(section, snapshot, [...unseen]));
  const conflicted = rejectTargetConflicts(outcomes);
  if (phantomDeletes) warnings.push(`Skipped ${phantomDeletes} deletion(s) of the synthetic trailing split row; the real final newline and blank lines are unchanged.`);
  warnings.push(...rejectionWarnings(conflicted), ...conflictWarnings(conflicted));
  return { outcomes: conflicted, hunks: acceptedHunks(conflicted), warnings };
}

function rejectTargetConflicts(outcomes: ChangeOutcome[]): ChangeOutcome[] {
  const candidates = outcomes.flatMap((outcome, index) => outcome.status === "accepted" || outcome.status === "repaired" ? [{ outcome, index }] : []);
  const rejected = new Set<number>();
  for (let left = 0; left < candidates.length; left++) {
    for (let right = left + 1; right < candidates.length; right++) {
      const a = candidates[left]!;
      const b = candidates[right]!;
      if (targetIslandsConflict(a.outcome.island, b.outcome.island)) {
        rejected.add(a.index);
        rejected.add(b.index);
      }
    }
  }
  return outcomes.map((outcome, index) => rejected.has(index) && (outcome.status === "accepted" || outcome.status === "repaired")
    ? { status: "rejected", reason: "conflict", operationLine: outcome.island.operationLine, island: outcome.island, detail: `Input line ${outcome.island.operationLine} conflicts with another resolved change at the same current coordinates.` }
    : outcome);
}

function targetIslandsConflict(left: TargetIsland, right: TargetIsland): boolean {
  if (left.kind === "insert" && right.kind === "insert") return false;
  if (left.kind === "insert") return left.sourceStartIndex > right.sourceStartIndex && left.sourceStartIndex < right.sourceEndIndex;
  if (right.kind === "insert") return right.sourceStartIndex > left.sourceStartIndex && right.sourceStartIndex < left.sourceEndIndex;
  return left.sourceStartIndex < right.sourceEndIndex && right.sourceStartIndex < left.sourceEndIndex;
}

function bindOperationAuthority(change: TargetIsland, authored: Hunk | undefined): TargetIsland {
  if (authored?.kind === "block_replace" || authored?.kind === "block_delete" || authored?.kind === "block_insert_after") {
    return { ...change, requiredRows: [authored.anchor] };
  }
  return change;
}

function acceptedHunks(outcomes: ChangeOutcome[]): ConcreteHunk[] {
  return outcomes.flatMap(outcome => outcome.status === "accepted" || outcome.status === "repaired" ? [outcome.hunk] : []);
}

function cloneConcreteHunk(hunk: ConcreteHunk): ConcreteHunk {
  return hunk.kind === "replace" || hunk.kind === "insert" ? { ...hunk, body: [...hunk.body] } : { ...hunk };
}

function rejectionWarnings(outcomes: ChangeOutcome[]): string[] {
  return outcomes.flatMap(outcome => outcome.status === "rejected" && outcome.reason === "bounds"
    ? [`Rejected change from input line ${outcome.operationLine}: its resolved target is outside the current source bounds.`]
    : []);
}

function conflictWarnings(outcomes: ChangeOutcome[]): string[] {
  const lines = outcomes.flatMap(outcome => outcome.status === "rejected" && outcome.reason === "conflict" ? [outcome.operationLine] : []);
  return lines.length ? [`Rejected conflicting changes from input line(s) ${[...new Set(lines)].sort((a, b) => a - b).join(", ")}; unrelated changes remain eligible.`] : [];
}

function renderHeldUnseen(section: PatchSection, snapshot: Snapshot, lines: number[]): string {
  const source = splitLogicalLines(snapshot.text).lines;
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const reveal = sorted.slice(0, SEEN_LINE_REVEAL_CAP).flatMap(line => {
    if (line < 1 || line > source.length) return [];
    const text = source[line - 1] ?? "";
    return [{ line, text: text.length > SEEN_LINE_REVEAL_MAX_COLUMNS ? `${text.slice(0, SEEN_LINE_REVEAL_MAX_COLUMNS)}…` : text, clipped: text.length > SEEN_LINE_REVEAL_MAX_COLUMNS }];
  });
  const truncated = sorted.length > reveal.length || reveal.some(row => row.clipped);
  if (!truncated) snapshots.recordSeenLines(snapshot.canonicalPath, snapshot.tag, reveal.map(row => row.line));
  const preview = reveal.map(row => `  ${row.line}:${row.text}`).join("\n");
  return `Held remaining change(s) for ${section.path}: source line(s) ${formatLineRanges(sorted)} were not displayed under [${section.path}#${section.tag}].${preview ? `\nActual file content at those lines:\n${preview}` : ""}${truncated ? "\nRead the complete held range before retrying it." : ""}`;
}

function hunksEqual(left: ConcreteHunk | undefined, right: ConcreteHunk): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

async function currentFileIdentity(path: string): Promise<string> {
  return fileIdentity(await stat(path));
}

function fileIdentity(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
function resolveBlockHunks(hunks: Hunk[], snapshot: Snapshot, display: string): { hunks: ConcreteHunk[]; warnings: string[] } {
  const resolved: ConcreteHunk[] = [];
  const warnings: string[] = [];
  for (const hunk of hunks) {
    if (hunk.kind === "replace" || hunk.kind === "delete" || hunk.kind === "insert") {
      resolved.push(hunk);
      continue;
    }
    const matches = (snapshot.blocks ?? []).filter(block => block.start === hunk.anchor);
    if (matches.length === 0) {
      throw new Error(`Edit rejected: block_unavailable; ${display} hash #${snapshot.tag} has no exact certified block beginning at line ${hunk.anchor}. Use one concrete REPLACE/DELETE range after a grouped read.`);
    }
    if (matches.length > 1) {
      throw new Error(`Edit rejected: block_ambiguous; ${display} line ${hunk.anchor} maps to ${matches.length} structural spans (${matches.map(block => `${block.start}..${block.end} ${block.label}`).join("; ")}). Use a concrete range.`);
    }
    const block = matches[0]!;
    if (hunk.kind === "block_replace") resolved.push({ kind: "replace", start: block.start, end: block.end, body: [...hunk.body], line: hunk.line });
    else if (hunk.kind === "block_delete") resolved.push({ kind: "delete", start: block.start, end: block.end, line: hunk.line });
    else resolved.push({ kind: "insert", position: "after", lineNumber: block.end, body: [...hunk.body], line: hunk.line });
    const operation = hunk.kind === "block_replace" ? "REPLACE BLOCK AT" : hunk.kind === "block_delete" ? "DELETE BLOCK AT" : "INSERT AFTER BLOCK AT";
    warnings.push(`Resolved ${operation} ${hunk.anchor} to original lines ${block.start}..${block.end} (${block.label}).`);
  }
  return { hunks: resolved, warnings };
}


function hunkAnchorLines(hunks: Hunk[]): number[] {
  const lines = new Set<number>();
  for (const hunk of hunks) {
    if (hunk.kind === "replace" || hunk.kind === "delete") {
      for (let line = hunk.start; line <= hunk.end; line++) lines.add(line);
    } else if (hunk.kind === "insert") {
      if (hunk.position === "before" || hunk.position === "after") lines.add(hunk.lineNumber);
    } else {
      lines.add(hunk.anchor);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

function mismatchError(display: string, section: PatchSection, currentTag: string, currentText: string, recognized: boolean, recoveryDetail?: string): Error {
  const lines = splitLogicalLines(currentText).lines;
  const anchors = hunkAnchorLines(section.hunks);
  const contextLines = new Set<number>();
  for (const anchor of anchors) {
    for (let line = Math.max(1, anchor - 2); line <= Math.min(lines.length, anchor + 2); line++) contextLines.add(line);
  }
  const sorted = [...contextLines].sort((a, b) => a - b);
  const preview = sorted.map(line => `  ${line}:${lines[line - 1] ?? ""}`).join("\n");
  const selector = formatLineRanges(anchors);
  const currentHashWithoutAuthority = !recognized && section.tag === currentTag;
  const failureKind = recognized ? "stale_hash_unrecoverable" : currentHashWithoutAuthority ? "current_hash_without_authority" : "unknown_hash";
  const reason = recognized
    ? `the file changed since #${section.tag} was issued — applying your patch could overwrite that work`
    : currentHashWithoutAuthority
      ? `this app restarted since #${section.tag} was issued — edit authority is session-scoped by design, though nothing on disk changed`
      : `hash #${section.tag} was not created for this path in this session`;
  const remedy = `read({path:"${display}:${selector}"}) to re-certify these ranges, then rebuild your section against the fresh hashes.`;
  return new Error(`Edit rejected: ${failureKind}; ${display}: ${reason}. Current file hash is #${currentTag}.\nLive content at the lines your patch targets:\n${preview}\nRemedy: ${remedy}`);
}

function applyHunks(text: string, hunks: ConcreteHunk[], display: string): string {
  const split = splitLogicalLines(text);
  const lines = [...split.lines];
  const lineCount = lines.length;
  for (const hunk of hunks) validateBounds(hunk, lineCount, display);
  const ordered = hunks.map((hunk, index) => ({ hunk, index, at: hunkSortLine(hunk) })).sort((a, b) => b.at - a.at || b.index - a.index);
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

function seenLinesStillAtSameCoordinates(snapshot: Snapshot, currentText: string): Set<number> {
  const before = splitLogicalLines(snapshot.text).lines;
  const current = splitLogicalLines(currentText).lines;
  return new Set([...(snapshot.seenLines ?? [])].filter(line => line <= before.length && line <= current.length && before[line - 1] === current[line - 1]));
}

function seenLinesAfterEdit(text: string, hunks: ConcreteHunk[], previouslySeen?: Set<number>): Set<number> {
  const split = splitLogicalLines(text);
  const lines = [...split.lines];
  const seen = lines.map((_, index) => previouslySeen?.has(index + 1) ?? false);
  const lineCount = lines.length;
  for (const hunk of hunks) validateBounds(hunk, lineCount, "snapshot provenance");
  const ordered = hunks.map((hunk, index) => ({ hunk, index, at: hunkSortLine(hunk) })).sort((a, b) => b.at - a.at || b.index - a.index);
  for (const { hunk } of ordered) {
    if (hunk.kind === "replace") seen.splice(hunk.start - 1, hunk.end - hunk.start + 1, ...hunk.body.map(() => true));
    else if (hunk.kind === "delete") seen.splice(hunk.start - 1, hunk.end - hunk.start + 1);
    else if (hunk.position === "before") seen.splice(hunk.lineNumber - 1, 0, ...hunk.body.map(() => true));
    else if (hunk.position === "after") seen.splice(hunk.lineNumber, 0, ...hunk.body.map(() => true));
    else if (hunk.position === "head") seen.splice(0, 0, ...hunk.body.map(() => true));
    else seen.splice(seen.length, 0, ...hunk.body.map(() => true));
  }
  return new Set(seen.flatMap((value, index) => value ? [index + 1] : []));
}

function blocksAfterEdit(blocks: SnapshotBlock[] | undefined, text: string, hunks: ConcreteHunk[]): SnapshotBlock[] | undefined {
  if (!blocks?.length) return undefined;
  const lineCount = splitLogicalLines(text).lines.length;
  const tokens = applyTokenHunks(Array.from({ length: lineCount }, (_, index) => `old:${index + 1}`), hunks);
  const remapped: SnapshotBlock[] = [];
  for (const block of blocks) {
    const start = tokens.indexOf(`old:${block.start}`);
    const end = tokens.indexOf(`old:${block.end}`);
    if (start < 0 || end < start) continue;
    const expected = Array.from({ length: block.end - block.start + 1 }, (_, index) => `old:${block.start + index}`);
    const actual = tokens.slice(start, end + 1);
    if (actual.length !== expected.length || actual.some((token, index) => token !== expected[index])) continue;
    remapped.push({ ...block, start: start + 1, end: end + 1 });
  }
  return remapped.length ? remapped : undefined;
}

function renderPostEditCoordinates(text: string, hunks: ConcreteHunk[], insertion?: MarkdownStamp["insertion"]): string {
  if (!hunks.length) return "";
  const needsTailCoordinate = hunks.some(hunk => hunk.kind === "insert" && hunk.position === "tail");
  const lineCount = needsTailCoordinate ? logicalLineCount(text) : 0;
  const coordinates = new Array<string>(hunks.length);
  let delta = 0;
  const ordered = hunks.map((hunk, index) => ({ hunk, index, base: postEditBaseLine(hunk, lineCount) }))
    .sort((a, b) => a.base - b.base || a.index - b.index);
  for (const { hunk, index, base } of ordered) {
    const removed = hunk.kind === "replace" || hunk.kind === "delete" ? hunk.end - hunk.start + 1 : 0;
    const added = hunk.kind === "delete" ? 0 : hunk.body.length;
    const start = base + delta;
    const remap = (line: number) => line + (insertion && line >= insertion.line ? insertion.count : 0);
    coordinates[index] = added > 0 ? `lines ${remap(start)}${added > 1 ? `-${remap(start + added - 1)}` : ""}` : "removed";
    delta += added - removed;
  }
  const rows = hunks.map((hunk, index) => {
    const target = hunk.kind === "replace" ? `REPLACE ${hunk.start}..${hunk.end}`
      : hunk.kind === "delete" ? `DELETE ${hunk.start}..${hunk.end}`
      : hunk.position === "before" || hunk.position === "after" ? `INSERT ${hunk.position.toUpperCase()} ${hunk.lineNumber}`
      : `INSERT AT ${hunk.position.toUpperCase()}`;
    return `- ${target} → ${coordinates[index]}`;
  });
  return `Post-edit coordinates under this hash:\n${rows.join("\n")}`;
}

function postEditBaseLine(hunk: ConcreteHunk, lineCount: number): number {
  if (hunk.kind === "replace" || hunk.kind === "delete") return hunk.start;
  if (hunk.position === "before") return hunk.lineNumber;
  if (hunk.position === "after") return hunk.lineNumber + 1;
  return hunk.position === "head" ? 1 : lineCount + 1;
}

function logicalLineCount(text: string): number {
  if (!text) return 0;
  let count = text.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++;
  return count;
}

function applyTokenHunks(initial: string[], hunks: ConcreteHunk[], operationMarkers = false): string[] {
  const tokens = [...initial];
  const ordered = hunks.map((hunk, index) => ({ hunk, index, at: hunkSortLine(hunk) })).sort((a, b) => b.at - a.at || b.index - a.index);
  for (const { hunk, index } of ordered) {
    const body = hunk.kind === "delete" ? [] : hunk.body.map((_, bodyIndex) => operationMarkers ? `op:${index}:${bodyIndex}` : `new:${index}:${bodyIndex}`);
    if (hunk.kind === "replace") tokens.splice(hunk.start - 1, hunk.end - hunk.start + 1, ...body);
    else if (hunk.kind === "delete") tokens.splice(hunk.start - 1, hunk.end - hunk.start + 1);
    else if (hunk.position === "before") tokens.splice(hunk.lineNumber - 1, 0, ...body);
    else if (hunk.position === "after") tokens.splice(hunk.lineNumber, 0, ...body);
    else if (hunk.position === "head") tokens.splice(0, 0, ...body);
    else tokens.splice(tokens.length, 0, ...body);
  }
  return tokens;
}

function editContextRange(text: string, changed: number): { start: number; end: number } {
  const lineCount = splitLogicalLines(text).lines.length;
  return { start: Math.max(1, changed - 2), end: Math.min(lineCount, changed + 6) };
}

function hunkSortLine(hunk: ConcreteHunk): number {
  if (hunk.kind === "replace" || hunk.kind === "delete") return hunk.start;
  if (hunk.position === "before" || hunk.position === "after") return hunk.lineNumber;
  return hunk.position === "tail" ? Number.MAX_SAFE_INTEGER : 0;
}

function validateBounds(hunk: ConcreteHunk, lineCount: number, display: string): void {
  const max = Math.max(1, lineCount);
  if (hunk.kind === "replace" || hunk.kind === "delete") {
    if (hunk.end > lineCount) throw new Error(`Edit rejected: out_of_bounds; ${display} has ${lineCount} lines, but ${hunk.kind.toUpperCase()} targets ${hunk.start}..${hunk.end}.`);
  } else if ((hunk.position === "before" || hunk.position === "after") && hunk.lineNumber > max) {
    throw new Error(`Edit rejected: out_of_bounds; ${display} has ${lineCount} lines, but INSERT ${hunk.position.toUpperCase()} targets line ${hunk.lineNumber}.`);
  }
}

function renderUnchangedResult(item: PreparedSection): string {
  const tag = computeTag(item.beforeNormalized);
  const { lines } = splitLogicalLines(item.beforeNormalized);
  const context = formatNumberedLines(lines.slice(0, Math.min(lines.length, 7)), 1);
  const skipped = item.outcomes.filter(outcome => outcome.status === "skipped").length;
  const held = item.outcomes.filter(outcome => outcome.status === "held").length;
  const rejected = item.outcomes.filter(outcome => outcome.status === "rejected").length;
  const summary = held || rejected
    ? `No changes landed for ${item.display}: ${held} held, ${rejected} rejected.`
    : `Skipped ${skipped || item.section.hunks.length} already-satisfied ${skipped === 1 ? "change" : "changes"} for ${item.display}; the file already matches the requested target.`;
  const warnings = item.warnings.length ? `\n\nWarnings:\n${item.warnings.join("\n")}` : "";
  return `${formatHeader(item.display, tag)}\n${summary} The hash above remains current for a normal follow-up edit.\n\n${context}${warnings}`;
}

function renderEditResult(item: PreparedSection, tag: string): string {
  const changed = item.firstChanged ?? 1;
  const { lines } = splitLogicalLines(item.afterNormalized);
  const { start, end } = editContextRange(item.afterNormalized, changed);
  const context = formatNumberedLines(lines.slice(start - 1, end), start);
  const opWord = item.section.hunks.length === 1 ? "operation" : "operations";
  const coordinates = renderPostEditCoordinates(item.beforeNormalized, item.resolvedHunks ?? [], item.metadataInsertion);
  const warnings = item.warnings.length ? `\n\nWarnings:\n${item.warnings.join("\n")}` : "";
  const diff = renderSimpleDiff(item.beforeNormalized, item.afterNormalized);
  return `${formatHeader(item.display, tag)}\nEdited ${item.display}: ${item.section.hunks.length} ${opWord}, first changed line ${changed}. Next edit: use this hash with current coordinates, or reuse an earlier in-session hash with that snapshot's original coordinates for unchanged anchors; recovery fails closed if changed or ambiguous.\n\n${context}${coordinates ? `\n\n${coordinates}` : ""}\n\n${diff}${warnings}`;
}

function formatLineRanges(lines: number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length;) {
    const start = sorted[index]!;
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) end = sorted[++index]!;
    parts.push(start === end ? `${start}` : `${start}-${end}`);
    index++;
  }
  return parts.join(", ");
}

function mutationPaths(prepared: PreparedSection[]): string[] {
  return prepared.flatMap(item => item.destinationPath ? [item.canonicalPath, item.destinationPath] : [item.canonicalPath]);
}

function assertUniqueMutationPaths(prepared: PreparedSection[]): void {
  const seen = new Map<string, string>();
  for (const item of prepared) {
    for (const path of item.destinationPath ? [item.canonicalPath, item.destinationPath] : [item.canonicalPath]) {
      const key = path.toLowerCase();
      const previous = seen.get(key);
      if (previous) throw new Error(`Edit rejected: conflicting_paths; ${path} collides with a path used by ${previous} and ${item.section.path}.`);
      seen.set(key, item.section.path);
    }
  }
}

async function prepareMoveDestination(cwd: string, projectRoot: string, sourcePath: string, requested: string): Promise<{ path: string; display: string }> {
  const unresolved = resolvePath(cwd, requested);
  const parent = await realpath(dirname(unresolved)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Edit rejected: destination_parent_missing; parent directory does not exist for ${requested}.`);
    throw error;
  });
  const path = join(parent, basename(unresolved));
  if (sourcePath.toLowerCase() === path.toLowerCase()) throw new Error(`Edit rejected: casefold_collision; source and destination collide after case folding: ${requested}.`);
  if (await pathExists(path)) throw new Error(`Edit rejected: destination_exists; ${requested} already exists.`);
  const folded = basename(path).toLowerCase();
  const collision = (await readdir(parent)).find(name => name.toLowerCase() === folded);
  if (collision) throw new Error(`Edit rejected: casefold_collision; destination ${requested} collides with existing ${collision}.`);
  return { path, display: displayPath(projectRoot, path, requested) };
}


async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
