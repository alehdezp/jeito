import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createScanPolicy, type ScanPolicy, type ScanStats, shouldSkipDirectory, shouldSkipFilePath, throwIfAborted } from "./scan-policy.ts";

export interface WalkFilesOptions {
  signal?: AbortSignal;
  stats?: ScanStats;
  policy?: ScanPolicy;
  skipFilePaths?: boolean;
  includeFiles?: boolean;
  includeDirs?: boolean;
  maxDepth?: number;
  allowDefaultSkippedDirNames?: Set<string>;
}

export async function* walkFiles(root: string, limit = 5000, options: WalkFilesOptions = {}): AsyncGenerator<string> {
  let yielded = 0;
  const policy = options.policy ?? await createScanPolicy(root);
  const wantsFiles = options.includeFiles !== false;
  const wantsDirs = options.includeDirs === true;
  async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
    throwIfAborted(options.signal);
    if (yielded >= limit) {
      if (options.stats) options.stats.truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
      if (options.stats) options.stats.dirsVisited++;
    } catch {
      if (options.stats) options.stats.readErrors++;
      return;
    }
    for (const entry of entries) {
      throwIfAborted(options.signal);
      if (yielded >= limit) {
        if (options.stats) options.stats.truncated = true;
        return;
      }
      const full = join(dir, entry.name);
      const entryDepth = depth + 1;
      const within = options.maxDepth === undefined || entryDepth <= options.maxDepth;
      const deeper = options.maxDepth === undefined || entryDepth < options.maxDepth;
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(full, entry.name, policy, options.stats, { allowDefaultNames: options.allowDefaultSkippedDirNames })) continue;
        if (within && wantsDirs) {
          yielded++;
          yield full;
        }
        if (deeper) yield* walk(full, entryDepth);
      } else if (entry.isFile() && wantsFiles && within) {
        if (options.skipFilePaths !== false && shouldSkipFilePath(full, policy, options.stats)) continue;
        yielded++;
        if (options.stats) options.stats.filesYielded++;
        yield full;
      }
    }
  }
  const s = await stat(root).catch(() => undefined);
  if (!s) return;
  if (s.isFile()) {
    yielded++;
    if (options.stats) options.stats.filesYielded++;
    yield root;
  } else if (s.isDirectory()) yield* walk(root);
}

export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]*";
    } else if (ch === "?") out += ".";
    else out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}
