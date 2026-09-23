import { createAnalysisFileSystem, createAdmittedAnalysisFileSystem, type AnalysisAdmission, type AnalysisDirectoryEntry } from "../../src/core/analysis-source.ts";
import type { Stats } from 'node:fs';
export type { Stats } from 'node:fs';
export type Dirent = AnalysisDirectoryEntry & { isSymbolicLink(): boolean };

type Capture = ReturnType<typeof createAnalysisFileSystem>;
type LiveSource = ReturnType<typeof createAdmittedAnalysisFileSystem>;
let source: Capture | undefined;
let live: LiveSource | undefined;
let unsupported: Error | undefined;

function deny(operation: string): never {
  unsupported ??= new Error("Uncaptured analysis filesystem operation: " + operation);
  throw unsupported;
}

export function assertSourceBoundary(): void {
  if (unsupported) throw unsupported;
  live?.assertCurrent();
}

/** Captured absent/excluded paths are normal; swallowed helper failures are not. */
export function assertCaughtFailure(error: unknown, site: string): void {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ENOENT" || code === "EACCES") return;
  unsupported ??= new Error("Analysis helper failed at " + site);
  throw unsupported;
}

export function realpathSync(path: string): string { return live ? live.realpathSync(path) : deny("realpathSync"); }
export function statSync(path: string): Stats { return live ? live.statSync(path) : deny("statSync"); }
export function unlinkSync(..._args: unknown[]): never { return deny("unlinkSync"); }
export function writeFileSync(..._args: unknown[]): never { return deny("writeFileSync"); }
export function openSync(..._args: unknown[]): never { return deny("openSync"); }
export function readSync(..._args: unknown[]): never { return deny("readSync"); }
export function closeSync(..._args: unknown[]): never { return deny("closeSync"); }

export function installSource(root: string, files: ReadonlyMap<string, string>): void {
  if (source || live) throw new Error("One source capture per analysis process");
  source = createAnalysisFileSystem(root, files);
}

export function installAdmittedSource(admission: AnalysisAdmission): void {
  if (source || live) throw new Error("One source admission per analysis process");
  live = createAdmittedAnalysisFileSystem(admission);
}

/** Undefined for the old captured API; the admitted maintenance scan never uses Git. */
export function admittedSourceFiles(root: string): readonly string[] | undefined {
  assertSourceBoundary();
  if (!live) return undefined;
  if (root !== live.root) return deny("foreign source root");
  return live.files;
}

function current(): Capture | LiveSource {
  assertSourceBoundary();
  if (!source && !live) throw new Error("Analysis source not installed");
  return (live ?? source)!;
}
export function readFileSync(path: string): Buffer;
export function readFileSync(path: string, encoding: string): string;
export function readFileSync(path: string, encoding?: string): string | Buffer {
  assertSourceBoundary();
  return live ? live.readFileSync(path, encoding) : (current() as Capture).readFileSync(path, encoding!);
}
export function existsSync(path: string): boolean { return current().existsSync(path); }
export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
export function readdirSync(path: string, options?: { withFileTypes?: false }): string[];
export function readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | Dirent[] {
  const entries = current().readdirSync(path, options);
  return options?.withFileTypes
    ? (entries as AnalysisDirectoryEntry[]).map(entry => ({ ...entry, isSymbolicLink: () => false }))
    : entries as string[];
}
export async function readFile(path: string, encoding: string): Promise<string> { return readFileSync(path, encoding); }
export async function stat(path: string): Promise<Stats> { return statSync(path); }
