export type ConcreteHunk =
  | { kind: "replace"; start: number; end: number; body: string[]; line: number }
  | { kind: "delete"; start: number; end: number; line: number }
  | { kind: "insert"; position: "before" | "after"; lineNumber: number; body: string[]; line: number }
  | { kind: "insert"; position: "head" | "tail"; body: string[]; line: number };

export type Hunk = ConcreteHunk
  | { kind: "block_replace"; anchor: number; body: string[]; line: number }
  | { kind: "block_delete"; anchor: number; line: number }
  | { kind: "block_insert_after"; anchor: number; body: string[]; line: number };
export type FileOperation =
  | { kind: "delete_file"; line: number }
  | { kind: "move_file"; destination: string; line: number };

export interface PatchSection {
  path: string;
  tag: string;
  hunks: Hunk[];
  fileOperation?: FileOperation;
  checkLsp?: boolean;
  headerLine: number;
  warnings: string[];
}

export interface PatchSectionFailure {
  path: string;
  tag: string;
  headerLine: number;
  inputOrder: number;
  message: string;
}

export interface ParsedPatch {
  sections: PatchSection[];
  failures: PatchSectionFailure[];
}

const HEADER_RE = /^\[([^#\]\r\n]+)#([0-9A-Fa-f]{8})\]\s*$/;
const REPLACE_BLOCK_RE = /^REPLACE\s+BLOCK\s+AT\s+(\d+)\s*:\s*$/i;
const DELETE_BLOCK_RE = /^DELETE\s+BLOCK\s+AT\s+(\d+)\s*$/i;
const INSERT_AFTER_BLOCK_RE = /^INSERT\s+AFTER\s+BLOCK\s+AT\s+(\d+)\s*:\s*$/i;
const REPLACE_RE = /^REPLACE\s+(\d+)(?:\s*\.\.\s*(\d+))?\s*:\s*$/i;
const DELETE_RE = /^DELETE\s+(\d+)(?:\s*\.\.\s*(\d+))?\s*$/i;
const INSERT_ANCHOR_RE = /^INSERT\s+(BEFORE|AFTER)\s+(\d+)\s*:\s*$/i;
const INSERT_EDGE_RE = /^INSERT\s+AT\s+(START|END)\s*:\s*$/i;
const DELETE_FILE_RE = /^DELETE\s+FILE\s*$/i;
const MOVE_FILE_RE = /^MOVE\s+FILE\s+TO\s+(.+?)\s*$/i;
const CHECK_LSP_RE = /^CHECK\s+LSP\s*$/i;

interface PendingBody {
  section: PatchSection;
  hunk: Extract<Hunk, { body: string[] }>;
  rows: Array<{ text: string; bare: boolean }>;
  deferredBlankCount: number;
}

function parsePatchSection(input: string): ParsedPatch {
  const lines = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const sections: PatchSection[] = [];
  let current: PatchSection | undefined;
  let pending: PendingBody | undefined;

  const finishPending = () => {
    if (!pending) return;
    if (pending.rows.length === 0) {
      throw new Error(`Line ${pending.hunk.line}: ${hunkName(pending.hunk)} requires at least one +TEXT body row.`);
    }
    const bareRows = pending.rows.filter(row => row.bare);
    const nonBlankBareRows = bareRows.filter(row => row.text.trim().length > 0);
    const stripNumbers = nonBlankBareRows.length > 0 && nonBlankBareRows.every(row => /^\s*\d+:/.test(row.text));
    pending.hunk.body.push(...pending.rows.map(row => stripNumbers && row.bare ? row.text.replace(/^\s*\d+:/, "") : row.text));
    if (bareRows.length > 0) {
      pending.section.warnings.push(stripNumbers
        ? `Normalized ${nonBlankBareRows.length} pasted LINE:TEXT body row(s) under ${hunkName(pending.hunk)} to literal replacement text.`
        : `Accepted ${bareRows.length} body row(s) without the canonical +TEXT prefix under ${hunkName(pending.hunk)}.`);
    }
    pending = undefined;
  };

  for (let index = 0; index < lines.length; index++) {
    const sourceLine = index + 1;
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();

    if (pending) {
      if (raw.startsWith("+")) {
        for (let count = 0; count < pending.deferredBlankCount; count++) pending.rows.push({ text: "", bare: true });
        pending.deferredBlankCount = 0;
        pending.rows.push({ text: raw.slice(1), bare: false });
        continue;
      }
      if (trimmed === "") {
        if (pending.rows.length > 0) pending.deferredBlankCount++;
        continue;
      }
      if (!isHeaderOrOperation(trimmed)) {
        if (trimmed.startsWith("-")) {
          throw new Error(`Line ${sourceLine}: '-' rows are not valid; the REPLACE range already names removed lines. Prefix a literal Markdown bullet with '+': '+- item'.`);
        }
        for (let count = 0; count < pending.deferredBlankCount; count++) pending.rows.push({ text: "", bare: true });
        pending.deferredBlankCount = 0;
        pending.rows.push({ text: raw, bare: true });
        continue;
      }
      finishPending();
    }

    if (trimmed === "" || trimmed === "*** Begin Patch") continue;
    if (trimmed === "*** End Patch" || trimmed === "*** Abort") break;

    const header = HEADER_RE.exec(trimmed);
    if (header) {
      current = { path: unquotePath(header[1]!.trim()), tag: header[2]!.toUpperCase(), hunks: [], headerLine: sourceLine, warnings: [] };
      sections.push(current);
      continue;
    }
    if (trimmed.startsWith("[")) {
      throw new Error(`Line ${sourceLine}: expected [PATH#HASH] with the eight-hex hash copied from read/edit output.`);
    }
    if (!current) throw new Error(`Line ${sourceLine}: input must begin with [PATH#HASH] from read/edit output.`);

    if (CHECK_LSP_RE.test(trimmed)) {
      current.checkLsp = true;
      continue;
    }
    if (DELETE_FILE_RE.test(trimmed)) {
      setFileOperation(current, { kind: "delete_file", line: sourceLine });
      continue;
    }

    const moveFile = MOVE_FILE_RE.exec(trimmed);
    if (moveFile) {
      const destination = unquotePath(moveFile[1]!.trim());
      if (!destination) throw new Error(`Line ${sourceLine}: MOVE FILE TO requires a destination path.`);
      setFileOperation(current, { kind: "move_file", destination, line: sourceLine });
      continue;
    }

    const replaceBlock = REPLACE_BLOCK_RE.exec(trimmed);
    if (replaceBlock) {
      const anchor = positiveLine(replaceBlock[1], sourceLine);
      const hunk: Hunk = { kind: "block_replace", anchor, body: [], line: sourceLine };
      current.hunks.push(hunk);
      pending = { section: current, hunk, rows: [], deferredBlankCount: 0 };
      continue;
    }

    const deleteBlock = DELETE_BLOCK_RE.exec(trimmed);
    if (deleteBlock) {
      current.hunks.push({ kind: "block_delete", anchor: positiveLine(deleteBlock[1], sourceLine), line: sourceLine });
      continue;
    }

    const insertAfterBlock = INSERT_AFTER_BLOCK_RE.exec(trimmed);
    if (insertAfterBlock) {
      const anchor = positiveLine(insertAfterBlock[1], sourceLine);
      const hunk: Hunk = { kind: "block_insert_after", anchor, body: [], line: sourceLine };
      current.hunks.push(hunk);
      pending = { section: current, hunk, rows: [], deferredBlankCount: 0 };
      continue;
    }

    const replace = REPLACE_RE.exec(trimmed);
    if (replace) {
      const start = Number(replace[1]);
      const end = Number(replace[2] ?? replace[1]);
      const hunk: Hunk = { kind: "replace", start, end, body: [], line: sourceLine };
      validateRange(start, end, sourceLine);
      current.hunks.push(hunk);
      pending = { section: current, hunk, rows: [], deferredBlankCount: 0 };
      continue;
    }

    const deletion = DELETE_RE.exec(trimmed);
    if (deletion) {
      const start = Number(deletion[1]);
      const end = Number(deletion[2] ?? deletion[1]);
      validateRange(start, end, sourceLine);
      current.hunks.push({ kind: "delete", start, end, line: sourceLine });
      continue;
    }

    const insertion = INSERT_ANCHOR_RE.exec(trimmed);
    if (insertion) {
      const lineNumber = Number(insertion[2]);
      if (lineNumber < 1) throw new Error(`Line ${sourceLine}: line number must be positive.`);
      const hunk: Hunk = { kind: "insert", position: insertion[1]!.toUpperCase() === "BEFORE" ? "before" : "after", lineNumber, body: [], line: sourceLine };
      current.hunks.push(hunk);
      pending = { section: current, hunk, rows: [], deferredBlankCount: 0 };
      continue;
    }

    const edge = INSERT_EDGE_RE.exec(trimmed);
    if (edge) {
      const hunk: Hunk = { kind: "insert", position: edge[1]!.toUpperCase() === "START" ? "head" : "tail", body: [], line: sourceLine };
      current.hunks.push(hunk);
      pending = { section: current, hunk, rows: [], deferredBlankCount: 0 };
      continue;
    }

    if (/^(?:SWAP|DEL|INS(?:\.|\s))/i.test(trimmed)) {
      throw new Error(`Line ${sourceLine}: SWAP/DEL/INS syntax is not supported. Use the single canonical REPLACE/DELETE/INSERT language, including BLOCK AT only when the hashed structural read certified a block.`);
    }
    throw new Error(`Line ${sourceLine}: expected REPLACE [BLOCK AT], DELETE [BLOCK AT|FILE], INSERT BEFORE|AFTER|AT START|AT END|AFTER BLOCK AT, MOVE FILE TO path, or another [PATH#HASH] header.`);
  }

  finishPending();
  if (sections.length === 0) throw new Error("No [PATH#HASH] edit sections found.");
  for (const section of sections) {
    if (section.fileOperation && section.hunks.length > 0) throw new Error(`Line ${section.fileOperation.line}: ${section.fileOperation.kind === "delete_file" ? "DELETE FILE" : "MOVE FILE TO"} must be the only operation under ${section.path}.`);
    if (!section.fileOperation && section.hunks.length === 0 && !section.checkLsp) throw new Error(`Line ${section.headerLine}: file section has no operations.`);
  }
  return { sections, failures: [] };
}

export function parsePatch(input: string): ParsedPatch {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const headers: Array<{ index: number; path: string; tag: string }> = [];
  for (let index = 0; index < lines.length; index++) {
    const trimmed = (lines[index] ?? "").trim();
    const header = HEADER_RE.exec(trimmed);
    if (header) headers.push({ index, path: unquotePath(header[1]!.trim()), tag: header[2]!.toUpperCase() });
    else if (trimmed.startsWith("[")) throw new Error(`Line ${index + 1}: expected [PATH#HASH] with the eight-hex hash copied from read/edit output.`);
  }
  if (headers.length === 0) return parsePatchSection(normalized);
  for (let index = 0; index < headers[0]!.index; index++) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed && trimmed !== "*** Begin Patch") throw new Error(`Line ${index + 1}: input before the first [PATH#HASH] section is not recognized.`);
  }

  const sections: PatchSection[] = [];
  const failures: PatchSectionFailure[] = [];
  for (let inputOrder = 0; inputOrder < headers.length; inputOrder++) {
    const header = headers[inputOrder]!;
    const end = headers[inputOrder + 1]?.index ?? lines.length;
    const chunk = lines.slice(header.index, end).join("\n");
    try {
      const parsed = parsePatchSection(chunk);
      for (const section of parsed.sections) {
        section.headerLine += header.index;
        for (const hunk of section.hunks) hunk.line += header.index;
        if (section.fileOperation) section.fileOperation.line += header.index;
        sections.push(section);
      }
    } catch (error) {
      failures.push({ path: header.path, tag: header.tag, headerLine: header.index + 1, inputOrder, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { sections, failures };
}

function hunkName(hunk: Extract<Hunk, { body: string[] }>): string {
  if (hunk.kind === "replace") return "REPLACE";
  if (hunk.kind === "block_replace") return "REPLACE BLOCK AT";
  if (hunk.kind === "block_insert_after") return "INSERT AFTER BLOCK AT";
  if (hunk.position === "head") return "INSERT AT START";
  if (hunk.position === "tail") return "INSERT AT END";
  return hunk.position === "before" ? "INSERT BEFORE" : "INSERT AFTER";
}

function unquotePath(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1);
  return value;
}

function isHeaderOrOperation(line: string): boolean {
  return HEADER_RE.test(line) || CHECK_LSP_RE.test(line) || DELETE_FILE_RE.test(line) || MOVE_FILE_RE.test(line) || REPLACE_BLOCK_RE.test(line) || DELETE_BLOCK_RE.test(line) || INSERT_AFTER_BLOCK_RE.test(line) || REPLACE_RE.test(line) || DELETE_RE.test(line) || INSERT_ANCHOR_RE.test(line) || INSERT_EDGE_RE.test(line) || line === "*** End Patch" || line === "*** Abort";
}

function positiveLine(value: string | undefined, sourceLine: number): number {
  const line = Number(value);
  if (!Number.isInteger(line) || line < 1) throw new Error(`Line ${sourceLine}: block anchor must be a positive line number.`);
  return line;
}

function validateRange(start: number, end: number, line: number): void {
  if (start < 1 || end < start) throw new Error(`Line ${line}: invalid inclusive range ${start}..${end}.`);
}

function setFileOperation(section: PatchSection, operation: FileOperation): void {
  if (section.fileOperation || section.hunks.length > 0) throw new Error(`Line ${operation.line}: whole-file operation must be the only operation under ${section.path}.`);
  section.fileOperation = operation;
}
