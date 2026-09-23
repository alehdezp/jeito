import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { NavigationCorpusSnapshot } from "./navigation-corpus-policy.ts";
import { isAbsolute, posix, relative, resolve } from "node:path";

/** Only the directory-entry operations used by the pinned resolution helpers. */
export interface AnalysisDirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Adapt the donor's project-file reads to one already-admitted source capture.
 * This does not walk, admit, certify, or refresh files. The updater owns those
 * decisions and must validate captured versions before publication. No method
 * falls through to the live filesystem, including config and directory probes.
 */
export function createAnalysisFileSystem(root: string, admittedFiles: ReadonlyMap<string, string>) {
  if (!isAbsolute(root)) throw new Error("Analysis source root must be absolute");
  const canonicalRoot = resolve(root);
  const files = new Map<string, string>();
  const directories = new Map<string, Map<string, boolean>>([["", new Map()]]);

  function addEntry(directory: string, name: string, isDirectory: boolean): void {
    const entries = directories.get(directory)!;
    if (entries.has(name) && entries.get(name) !== isDirectory) {
      throw new Error("Analysis source contains a file/directory collision");
    }
    entries.set(name, isDirectory);
  }

  for (const [name, text] of admittedFiles) {
    if (!name || name.endsWith("/") || name.includes("\\") || name.includes("\0") || posix.isAbsolute(name)
      || posix.normalize(name) !== name || name === "." || name === ".." || name.startsWith("../")
      || /^[A-Za-z]:/.test(name)) {
      throw new Error("Analysis source paths must be normalized project-relative paths");
    }
    if (typeof text !== "string") throw new TypeError("Analysis source must contain captured text");
    files.set(name, text);
    let directory = "";
    const parts = name.split("/");
    for (let index = 0; index < parts.length - 1; index++) {
      const part = parts[index]!;
      addEntry(directory, part, true);
      directory = directory ? `${directory}/${part}` : part;
      if (!directories.has(directory)) directories.set(directory, new Map());
    }
    addEntry(directory, parts.at(-1)!, false);
  }

  function localPath(path: string): string | undefined {
    if (typeof path !== "string" || path.includes("\0")) return undefined;
    const name = relative(canonicalRoot, resolve(canonicalRoot, path)).replace(/\\/g, "/");
    if (isAbsolute(name) || name === ".." || name.startsWith("../")) return undefined;
    return name;
  }

  function unavailable(code: string): Error & { code: string } {
    // Do not echo arbitrary absolute config paths into a published diagnostic.
    return Object.assign(new Error(`Analysis source unavailable (${code})`), { code });
  }

  return {
    readFileSync(path: string, encoding: string): string {
      if (encoding !== "utf8" && encoding !== "utf-8") throw new TypeError("Analysis source reads require UTF-8");
      const name = localPath(path);
      if (name === undefined) throw unavailable("EACCES");
      const text = files.get(name);
      if (text !== undefined) return text;
      throw unavailable(directories.has(name) ? "EISDIR" : "ENOENT");
    },
    existsSync(path: string): boolean {
      const name = localPath(path);
      return name !== undefined && (files.has(name) || directories.has(name));
    },
    readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | AnalysisDirectoryEntry[] {
      const name = localPath(path);
      if (name === undefined) throw unavailable("EACCES");
      const entries = directories.get(name);
      if (!entries) throw unavailable(files.has(name) ? "ENOTDIR" : "ENOENT");
      const names = [...entries.keys()].sort();
      return options?.withFileTypes
        ? names.map(name => ({ name, isDirectory: () => entries.get(name)!, isFile: () => !entries.get(name)! }))
        : names;
    },
  };
}

export interface AnalysisAdmission {
  root: string;
  files: readonly string[];
  policyFiles: NavigationCorpusSnapshot["policyFiles"];
}

/** Live read-only access to an already admitted census, not a filesystem walk.
 * Policy failure is permanent for this run even if a donor helper catches it.
 * Fresh maintenance uses a fresh child/admission; source bytes need not be frozen.
 */
export function createAdmittedAnalysisFileSystem(admission: AnalysisAdmission) {
  const { root } = admission;
  if (!isAbsolute(root) || resolve(root) !== root || fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) {
    throw new Error("Analysis source root must be a canonical directory");
  }
  if (admission.files.length > 100_000 || new Set(admission.files).size !== admission.files.length
    || admission.policyFiles.length === 0 || admission.policyFiles.length > 16) throw new Error("Invalid analysis admission bounds");
  // Reuse the captured adapter's path validation and directory census only.
  // Its placeholder values are never used as source text or publication data.
  const census = createAnalysisFileSystem(root, new Map(admission.files.map(file => [file, ""])));
  const files = Object.freeze([...admission.files]);
  const policyFiles = admission.policyFiles.map(input => ({ ...input }));
  for (const input of policyFiles) {
    if (!isAbsolute(input.path) || resolve(input.path) !== input.path
      || (input.digest !== null && !/^[a-f0-9]{64}$/.test(input.digest))) throw new Error("Invalid analysis policy input");
  }
  let failure: Error | undefined;
  const unavailable = () => Object.assign(new Error("Source is outside admitted analysis"), { code: "ENOENT" });

  function readBytes(path: string, maximum: number, canonical: boolean): Buffer {
    if (canonical && fs.realpathSync(path) !== path) throw new Error("Analysis source path changed");
    const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (canonical ? fs.constants.O_NOFOLLOW : 0));
    try {
      const before = fs.fstatSync(descriptor);
      if (!before.isFile() || before.size > maximum) throw new Error("Analysis input is not a bounded regular file");
      const selected = canonical ? fs.lstatSync(path) : fs.statSync(path);
      if (!selected.isFile() || selected.dev !== before.dev || selected.ino !== before.ino
        || (canonical && fs.realpathSync(path) !== path)) throw new Error("Analysis source handle changed before read");
      const bytes = Buffer.alloc(Math.min(before.size + 1, maximum + 1));
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      const after = canonical ? fs.lstatSync(path) : fs.statSync(path);
      if (length !== before.size || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino
        || (canonical && fs.realpathSync(path) !== path)) throw new Error("Analysis source changed during read");
      return bytes.subarray(0, length);
    } finally { fs.closeSync(descriptor); }
  }

  function assertCurrent(): void {
    if (failure) throw failure;
    try {
      if (fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) throw new Error("Analysis root changed");
      for (const input of policyFiles) {
        let digest: string | null;
        try { digest = createHash("sha256").update(readBytes(input.path, 1_048_576, false)).digest("hex"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; digest = null; }
        if (digest !== input.digest) throw new Error("Analysis policy changed; restart maintenance with current admission");
      }
    } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  }

  function admittedPath(path: string): string {
    assertCurrent();
    if (!census.existsSync(path)) throw unavailable();
    const absolute = resolve(root, path);
    if (fs.realpathSync(absolute) !== absolute) throw new Error("Analysis source path changed");
    return absolute;
  }

  function readFileSync(path: string, encoding?: string): string | Buffer {
    const absolute = admittedPath(path);
    const bytes = readBytes(absolute, 8 * 1024 * 1024, true);
    if (encoding === undefined) return bytes;
    if (encoding !== "utf8" && encoding !== "utf-8") throw new TypeError("Analysis source reads require UTF-8");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) throw new Error("Analysis source is not UTF-8");
    return text;
  }

  assertCurrent();
  return {
    root, files, assertCurrent, readFileSync,
    existsSync(path: string): boolean {
      assertCurrent();
      if (!census.existsSync(path)) return false;
      try { admittedPath(path); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    },
    realpathSync(path: string): string { return admittedPath(path); },
    statSync(path: string): fs.Stats { return fs.statSync(admittedPath(path)); },
    readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | AnalysisDirectoryEntry[] {
      admittedPath(path);
      return census.readdirSync(path, options);
    },
  };
}
