import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export type ProjectRootConfidence = "high" | "medium" | "low";

export interface ProjectRootInfo {
  root: string;
  confidence: ProjectRootConfidence;
  markers: string[];
}

const HIGH_CONFIDENCE_MARKERS = [".pi-navigation.json", ".git", ".svn"] as const;
export const PACKAGE_ROOT_MARKERS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "flake.nix",
] as const;
const ROOT_MARKERS = [...HIGH_CONFIDENCE_MARKERS, ...PACKAGE_ROOT_MARKERS] as const;

/** Pure marker walk shared by lifecycle and live native-query consumers. */
export function detectProjectRoot(startPath: string): ProjectRootInfo {
  let start = canonicalProjectPath(startPath);
  try {
    if (statSync(start).isFile()) start = dirname(start);
  } catch {}

  let nearest: { root: string; markers: string[] } | undefined;
  for (let current = start; ; current = dirname(current)) {
    const markers = ROOT_MARKERS.filter(marker => existsSync(join(current, marker)));
    if (!nearest && markers.length) nearest = { root: current, markers: [...markers] };
    if (markers.some(marker => HIGH_CONFIDENCE_MARKERS.includes(marker as typeof HIGH_CONFIDENCE_MARKERS[number]))) {
      return { root: canonicalProjectPath(current), confidence: "high", markers: [...markers] };
    }
    const parent = dirname(current);
    if (parent === current) break;
  }
  if (nearest) return { root: canonicalProjectPath(nearest.root), confidence: "medium", markers: nearest.markers };
  return { root: canonicalProjectPath(start), confidence: "low", markers: [] };
}

/** Resolve frontmatter-style package-relative paths without losing the outer project boundary. */
export function detectNearestPackageRoot(startPath: string, boundaryPath: string): string {
  let start = canonicalProjectPath(startPath);
  try {
    if (statSync(start).isFile()) start = dirname(start);
  } catch {}
  const boundary = canonicalProjectPath(boundaryPath);
  const rel = relative(boundary, start);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) return detectProjectRoot(start).root;
  for (let current = start; ; current = dirname(current)) {
    if (PACKAGE_ROOT_MARKERS.some(marker => existsSync(join(current, marker)))) return canonicalProjectPath(current);
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
  }
  return boundary;
}

export function canonicalProjectPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return resolve(value);
  }
}

export type ProjectAdmission = ProjectRootInfo & { allowed: boolean; reason: string };

/** Preparation must not interpret a broad host directory as a project, even with a marker. */
export function isUnsafePreparationRoot(rootPath: string, homePath = homedir()): boolean {
  const root = canonicalProjectPath(rootPath);
  const home = canonicalProjectPath(homePath);
  const homeRelative = relative(root, home);
  return root === dirname(root) || root === canonicalProjectPath(tmpdir())
    || homeRelative === "" || (!isAbsolute(homeRelative) && homeRelative !== ".." && !homeRelative.startsWith(`..${sep}`));
}

const execFileAsync = promisify(execFile);

/** Lifecycle-only admission; live queries do not require permission to retain an index. */
export async function resolvePreparationRoot(startPath: string, options: { home?: string; signal?: AbortSignal } = {}): Promise<ProjectAdmission> {
  options.signal?.throwIfAborted();
  let start: string;
  try {
    start = realpathSync.native(resolve(startPath));
    const info = statSync(start);
    if (info.isFile()) start = dirname(start);
    else if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    return { root: resolve(startPath), confidence: "low", markers: [], allowed: false, reason: "Project path is unavailable; live tools can still address explicit readable paths." };
  }

  let info = detectProjectRoot(start);
  // A dotfiles repository at home must not swallow a real, nearer package.
  if (isUnsafePreparationRoot(info.root, options.home)) {
    const packageRoot = detectNearestPackageRoot(start, info.root);
    info = { root: packageRoot, confidence: "medium", markers: PACKAGE_ROOT_MARKERS.filter(marker => existsSync(join(packageRoot, marker))) };
  }
  if (isUnsafePreparationRoot(info.root, options.home)) {
    return { ...info, allowed: false, reason: "Choose a bounded project root; automatic preparation does not scan home, its ancestors or the system temporary directory." };
  }

  if (info.markers.includes(".pi-navigation.json")) {
    try {
      const path = join(info.root, ".pi-navigation.json");
      const metadata = statSync(path);
      if (!metadata.isFile() || metadata.size > 1_048_576) throw new Error("invalid config file");
      const config = JSON.parse(readFileSync(path, "utf8"));
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid config object");
      return { ...info, allowed: true, reason: "Explicit project configuration bounds local preparation." };
    } catch {
      return { ...info, allowed: false, reason: "Project configuration is invalid or unreadable; no automatic preparation was authorized." };
    }
  }

  for (const marker of info.markers) {
    if (!PACKAGE_ROOT_MARKERS.includes(marker as typeof PACKAGE_ROOT_MARKERS[number])) continue;
    try {
      if (statSync(join(info.root, marker)).isFile()) return { ...info, allowed: true, reason: "A project manifest bounds local preparation; Git is not required." };
    } catch { /* A vanished/unreadable marker cannot grant admission. */ }
  }

  if (info.markers.includes(".git")) {
    try {
      // Inherited GIT_DIR/WORK_TREE overrides must not redirect project identity.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
      const { stdout } = await execFileAsync("git", ["-C", info.root, "rev-parse", "--show-toplevel"], { env, timeout: 2_000, maxBuffer: 64 * 1024, signal: options.signal });
      options.signal?.throwIfAborted();
      if (canonicalProjectPath(stdout.replace(/\r?\n$/, "")) === info.root) return { ...info, allowed: true, reason: "A validated Git worktree bounds local preparation." };
    } catch {
      options.signal?.throwIfAborted();
    }
    return { ...info, allowed: false, reason: "Git project identity could not be validated; choose an explicit project root before preparation." };
  }
  return { ...info, allowed: false, reason: "Live navigation is ready; choose the project root before retaining an index for this unmarked folder." };
}
