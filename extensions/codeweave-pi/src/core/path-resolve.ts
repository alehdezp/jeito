import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function cleanPath(input: string): string {
  return input.startsWith("@") ? input.slice(1) : input;
}

export function resolvePath(cwd: string, input: string): string {
  const cleaned = cleanPath(input);
  const expanded = cleaned.startsWith("~")
    ? cleaned === "~" ? homedir()
    : join(homedir(), cleaned.slice(1))
    : cleaned;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function canonicalExistingPath(path: string): string {
  return realpathSync(path);
}

export function canonicalMutationPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return resolve(realpathSync(dirname(path)), path.split(/[\\/]/).pop() ?? "");
    } catch {
      return resolve(path);
    }
  }
}

export function displayPath(cwd: string, absolutePath: string, requested?: string): string {
  if (requested && cleanPath(requested).startsWith("/")) return cleanPath(requested);
  const rel = relative(cwd, absolutePath);
  return rel && !rel.startsWith("..") && !rel.includes(`..${"/"}`) ? rel || "." : absolutePath;
}
