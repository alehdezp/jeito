import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

import type { PiNavCaller } from "./pi-nav-native.ts";
import { globalNavigationIgnorePath, projectNavigationIgnorePath, parseIgnoreSections } from "./navigation-ignore.ts";
import { isBinaryOrHeavyExtension, looksBinary } from "./scan-policy.ts";

export interface NavigationCorpusPolicy {
  root: string;
  excludedPrefixes: string[];
  excludedNames: string[];
  digest: string;
  /** Non-fatal policy findings (whitelist unrepresentable, negation ceilings) surfaced in freshen diagnostics. */
  warnings: string[];
}

/**
 * Compile portable project-relative subtree exclusions into one stable policy.
 * `values` are scope.exclude entries (validated); `extraValues` are ignore
 * lines parsed from the global template and the project .pi/navigation/ignore
 * (already normalized by gitignoreLinesToPrefixes). Entries containing a
 * slash become root-relative prefixes; bare names become any-depth name
 * exclusions, matching Git ignore semantics for directory names.
 */
export function compileNavigationCorpusPolicy(root: string, values: unknown, options: { extraValues?: string[]; digestValues?: string[] } = {}): NavigationCorpusPolicy {
  const canonicalRoot = canonicalNavigationPath(root);
  if (values !== undefined && !Array.isArray(values)) throw new Error("scope.exclude must be an array of project-relative directories");
  // scope.exclude entries are curated root-relative prefixes (the explicit
  // project decision); extraValues come from the global template and the
  // project .pi/navigation/ignore and keep Git-ignore semantics: bare names
  // match at any depth, slashed entries stay root-relative prefixes.
  const curated = (values ?? []).map((value: unknown) => normalizeExcludedPrefix(canonicalRoot, value, { checkFilesystem: true }));
  const extra = (options.extraValues ?? []).map((value: unknown) => normalizeExcludedPrefix(canonicalRoot, value, { checkFilesystem: false }));
  const prefixes = [...new Set([...curated, ...extra.filter(value => value.includes("/"))])].sort();
  const names = [...new Set(extra.filter(value => !value.includes("/")))].sort();
  const excludedPrefixes = prefixes.filter((candidate, index) => !prefixes.some((parent, parentIndex) => parentIndex !== index && candidate.startsWith(`${parent}/`)));
  const excludedNames = names;
  // digestValues ride the digest without entering the exclusion set: the docs
  // lane includes raw .gitignore bytes so any .gitignore change dirties QMD,
  // while pi-nav (not our mirrors) owns applying it.
  const digest = createHash("sha256").update(JSON.stringify({ version: 2, excludedPrefixes, excludedNames, digestValues: options.digestValues ?? [] })).digest("hex");
  return { root: canonicalRoot, excludedPrefixes, excludedNames, digest, warnings: [] };
}

export type CorpusLane = "code" | "docs" | "global";


export interface NavigationCorpusSnapshot {
  root: string;
  lane: CorpusLane;
  policy: { version: 1; globalRules: string[]; projectRules: string[]; excludedPrefixes: string[] };
  digest: string;
  policyFiles: { path: string; digest: string | null }[];
}

/** Lossless input to the native corpus matcher, not a prefix approximation.
 * This captures the explicit policy files; native census owns nested/effective Git policy.
 */
export function compileLaneCorpusPolicy(
  root: string,
  values: unknown,
  lane: CorpusLane,
  options: { home?: string; allowDisabledCode?: boolean } = {},
): NavigationCorpusSnapshot {
  const canonicalRoot = canonicalNavigationPath(root);
  const policyFiles: NavigationCorpusSnapshot["policyFiles"] = [];
  const readPolicy = (path: string): string | undefined => {
    let descriptor: number;
    try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      policyFiles.push({ path, digest: null });
      return undefined;
    }
    try {
      if (!fstatSync(descriptor).isFile()) throw new Error(`Policy is not a regular file: ${path}`);
      const buffer = Buffer.alloc(1_048_577);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(descriptor, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > 1_048_576) throw new Error(`Policy exceeds 1 MiB: ${path}`);
      const bytes = buffer.subarray(0, size);
      const text = bytes.toString("utf8");
      if (!bytes.equals(Buffer.from(text))) throw new Error(`Policy is not UTF-8: ${path}`);
      policyFiles.push({ path, digest: createHash("sha256").update(bytes).digest("hex") });
      return text;
    } finally { closeSync(descriptor); }
  };
  const selectedRules = (text: string | undefined): string[] => parseIgnoreSections((text ?? "").split(/\r?\n/))
    .filter(rule => rule.section === "global" || rule.section === lane)
    .map(rule => rule.pattern);
  const globalRules = selectedRules(readPolicy(globalNavigationIgnorePath(options.home)));
  const projectRules = selectedRules(readPolicy(projectNavigationIgnorePath(canonicalRoot)));
  const configuration = readPolicy(join(canonicalRoot, ".pi-navigation.json"));
  let configuredExclusions: unknown;
  if (configuration !== undefined) {
    let config: any;
    try { config = JSON.parse(configuration); }
    catch { throw new SyntaxError("Invalid navigation scope configuration"); }
    if (!config || typeof config !== "object" || Array.isArray(config)
      || (config.scope !== undefined && (!config.scope || typeof config.scope !== "object" || Array.isArray(config.scope)))) {
      throw new Error("Invalid navigation scope configuration");
    }
    if (lane === "code" && !options.allowDisabledCode && (config.architecture === false || config.architecture?.enabled === false)) {
      throw new Error("Code analysis is disabled by .pi-navigation.json");
    }
    configuredExclusions = config.scope?.exclude;
  }
  // Root Git policy enters identity too; full Git matching remains native-owned.
  readPolicy(join(canonicalRoot, ".gitignore"));
  const exclusions = values ?? configuredExclusions;
  if (exclusions !== undefined && (!Array.isArray(exclusions) || exclusions.some(value => typeof value !== "string"))) {
    throw new Error("scope.exclude must be an array of project-relative paths");
  }
  const curated = compileNavigationCorpusPolicy(canonicalRoot, exclusions);
  const policy = { version: 1 as const, globalRules, projectRules, excludedPrefixes: curated.excludedPrefixes };
  const digest = createHash("sha256").update(JSON.stringify({ root: canonicalRoot, lane, policy, policyFiles })).digest("hex");
  return { root: canonicalRoot, lane, policy, digest, policyFiles };
}


/** Read-only admission census. An older native runtime must refuse, not ignore policy. */
export async function enumerateNavigationCorpus(
  root: string,
  lane: CorpusLane,
  callNative: PiNavCaller,
  options: { home?: string; signal?: AbortSignal; maxEntries?: number; timeoutMs?: number; allowDisabledCode?: boolean; metadataOnly?: boolean; visibility?: "project" | "all" } = {},
): Promise<NavigationCorpusSnapshot & { files: string[]; directories: string[]; binaryFiles: number }> {
  const deadline = performance.now() + (options.timeoutMs ?? 25_000);
  const check = () => {
    options.signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new Error("Navigation corpus census deadline exceeded");
  };
  check();
  const snapshot = compileLaneCorpusPolicy(root, undefined, lane, options);
  const result = await callNative({ root: snapshot.root, operation: "pi_nav_files",
    args: { corpusPolicy: snapshot.policy, ...(options.visibility === "all" ? { visibility: "all" } : {}), ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }) },
    timeoutMs: options.timeoutMs ?? 25_000, signal: options.signal });
  const data = result.structured.data;
  const paths = (value: unknown, directories: boolean): value is string[] => Array.isArray(value)
    && value.length <= 100_000 && value.every(path => typeof path === "string"
      && (directories && path === "" || path !== "" && !path.includes("\\") && !path.includes("\0") && !isAbsolute(path)
        && path.split("/").every(part => part !== "" && part !== "." && part !== "..")));
  if (data.corpusPolicyVersion !== 1 || data.root !== snapshot.root
    || options.visibility === "all" && data.corpusVisibility !== "all"
    || result.structured.completeness.complete !== true || !paths(data.files, false) || !paths(data.directories, true)) {
    throw new Error("Native runtime did not return a complete policy-aware corpus census");
  }
  check();
  const files: string[] = [];
  let binaryFiles = 0;
  for (const file of data.files) {
    check();
    // Text scans own binary/heavy-file outcomes themselves. Preparation keeps
    // its existing eligibility filter; neither path changes directory ownership.
    if (lane === "code" && !options.metadataOnly) {
      const absolute = join(snapshot.root, file);
      if (isBinaryOrHeavyExtension(absolute)) { binaryFiles++; continue; }
      if (realpathSync(absolute) !== absolute) throw new Error(`Corpus path changed: ${file}`);
      const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(descriptor).isFile()) throw new Error(`Corpus path is not a regular file: ${file}`);
        const sample = Buffer.alloc(8192);
        const length = readSync(descriptor, sample, 0, sample.length, 0);
        if (looksBinary(sample.subarray(0, length))) { binaryFiles++; continue; }
      } finally { closeSync(descriptor); }
    }
    files.push(file);
  }
  check();
  if (compileLaneCorpusPolicy(root, undefined, lane, options).digest !== snapshot.digest) {
    throw new Error("Navigation policy changed during corpus census");
  }
  return { ...snapshot, files, directories: data.directories, binaryFiles };
}


export function navigationPathIsExcluded(policy: NavigationCorpusPolicy, target: string): boolean {
  const canonicalTarget = canonicalNavigationPath(target);
  const rel = relative(policy.root, canonicalTarget).replace(/\\/g, "/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return false;
  if (policy.excludedPrefixes.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))) return true;
  return policy.excludedNames.some(name => rel.split("/").includes(name));
}

function normalizeExcludedPrefix(root: string, value: unknown, options: { checkFilesystem?: boolean } = {}): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("scope.exclude entries must be non-empty strings");
  const portable = value.trim().replace(/\\/g, "/");
  if (portable.startsWith("/") || portable.startsWith("//") || /^[A-Za-z]:\//.test(portable)) throw new Error(`scope.exclude must be relative: ${value}`);
  const normalized = posix.normalize(portable.replace(/^\.\//, "")).replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new Error(`scope.exclude escapes or replaces the project root: ${value}`);
  // Curated scope.exclude entries are resolved against the real filesystem so
  // a symlink cannot smuggle the boundary outside the project. Template and
  // project-ignore entries are Git-ignore patterns (bare names match at any
  // depth); they are validated as strings only — resolving a name like
  // ".research" against the root would trip the symlink guard on a symlink
  // that the pattern is not even anchored to.
  if (options.checkFilesystem !== false) {
    const candidate = resolve(root, normalized);
    const rel = relative(root, candidate);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`scope.exclude escapes the project root: ${value}`);
    if (existsSync(candidate)) {
      const real = canonicalNavigationPath(candidate);
      const realRel = relative(root, real);
      if (realRel === ".." || realRel.startsWith("../") || isAbsolute(realRel)) throw new Error(`scope.exclude symlink escapes the project root: ${value}`);
    }
  }
  return normalized;
}

export function canonicalNavigationPath(value: string): string {
  let current = resolve(value);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(value);
    missing.unshift(basename(current));
    current = parent;
  }
  try { return join(realpathSync.native(current), ...missing); } catch { return resolve(value); }
}
