// Unified ignore sources for navigation corpora (Core, QMD, Graphify).
//
// Resolution model (user-approved design):
//   1. Global template file ~/.pi/agent/navigation-ignore - seeded once from
//      the shipped defaults and user-editable; applies to every project.
//      Sectioned: [global] applies to all lanes; [code]/[docs] apply only there.
//   2. Project <root>/.pi/navigation/ignore overrides machine defaults.
//   3. Git exclusions remain project policy, never overridden by machine includes.
//   4. .pi-navigation.json scope.exclude remains a hard project boundary.
// Ordinary rules preserve file order: the last applicable match wins per layer.
// `!path` is the inclusion spelling; existing `+path` is a compatibility alias.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { VALUE_EXCLUDE_DIR_NAMES, VALUE_EXCLUDE_FILE_PATHS, VALUE_EXCLUDE_PATHS } from "./navigation-value-policy.ts";

export const GLOBAL_IGNORE_FILE_NAME = "navigation-ignore";
export const PROJECT_IGNORE_PATH = join(".pi", "navigation", "ignore");

export function globalNavigationIgnorePath(home = homedir()): string {
  if (!isAbsolute(home)) throw new Error("Navigation policy home must be an absolute directory");
  return join(home, ".pi", "agent", GLOBAL_IGNORE_FILE_NAME);
}

const TEMPLATE_VERSION = 1;

function templateLines(): string[] {
  return [
    `# jeito global navigation ignore template v${TEMPLATE_VERSION} - applied to`,
    "# every project's Core, QMD, and Graphify corpus. Edit freely; Git ignore",
    "# syntax. Sections: [global] applies to every lane, [code] to Core only.",
    "# Use !path to re-include a path (+path remains compatible).",
    "# Machine inclusions cannot undo a project's explicit exclusions.",
    "# Version upgrades merge: your edits are preserved, shipped defaults refresh.",
    "",
    "[global]",
    ...VALUE_EXCLUDE_DIR_NAMES.map(name => `${name}/`),
    ...VALUE_EXCLUDE_PATHS,
    ...VALUE_EXCLUDE_FILE_PATHS,
    "",
  ];
}

/** Create the global template once. Setup-time only; never called from query paths. */
export function ensureGlobalNavigationIgnore(home = homedir()): string {
  const target = globalNavigationIgnorePath(home);
  if (existsSync(target)) return target;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, templateLines().join("\n"));
  return target;
}

export function readGlobalNavigationIgnoreLines(home = homedir()): string[] {
  const target = globalNavigationIgnorePath(home);
  if (!existsSync(target)) return [];
  return meaningfulLines(readFileSync(target, "utf8"));
}

export function projectNavigationIgnorePath(root: string): string {
  return join(root, PROJECT_IGNORE_PATH);
}

export function readProjectNavigationIgnoreLines(root: string): string[] {
  const target = projectNavigationIgnorePath(root);
  if (!existsSync(target)) return [];
  return meaningfulLines(readFileSync(target, "utf8"));
}

function meaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter(line => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("#");
    });
}
export type IgnoreSection = "global" | "code" | "docs";
export interface NavigationIgnoreRule {
  section: IgnoreSection;
  pattern: string;
}

/** Keep original order across repeated sections; never pool inclusions globally. */
export function parseIgnoreSections(lines: string[]): NavigationIgnoreRule[] {
  const rules: NavigationIgnoreRule[] = [];
  let section: IgnoreSection = "global";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const header = trimmed.match(/^\[(global|code|docs)\]$/);
    if (header) {
      section = header[1] as IgnoreSection;
      continue;
    }
    const pattern = trimmed.startsWith("+") ? `!${line.trimStart().slice(1).trimStart()}` : line;
    if (pattern === "!") throw new Error("Navigation inclusion requires a path pattern");
    rules.push({ section, pattern });
  }
  return rules;
}

export function readGlobalNavigationIgnoreSections(home = homedir()): NavigationIgnoreRule[] {
  return parseIgnoreSections(readGlobalNavigationIgnoreLines(home));
}

export function readProjectNavigationIgnoreSections(root: string): NavigationIgnoreRule[] {
  return parseIgnoreSections(readProjectNavigationIgnoreLines(root));
}

/**
 * Versioned template merge: when the installed template is older than
 * TEMPLATE_VERSION, rewrite it as shipped defaults + the user's non-default
 * lines, preserving edits deterministically. Idempotent; never touches a
 * current-version template. Setup-time only.
 */
export function mergeVersionedTemplate(home = homedir()): { merged: boolean; path: string } {
  const target = globalNavigationIgnorePath(home);
  if (!existsSync(target)) {
    ensureGlobalNavigationIgnore(home);
    return { merged: true, path: target };
  }
  const current = readFileSync(target, "utf8");
  const version = Number(/template v(\d+)/.exec(current)?.[1] ?? 0);
  if (version >= TEMPLATE_VERSION) return { merged: false, path: target };
  const defaults = new Set([
    ...VALUE_EXCLUDE_DIR_NAMES.map(name => `${name}/`),
    ...VALUE_EXCLUDE_PATHS,
    ...VALUE_EXCLUDE_FILE_PATHS,
  ]);
  const userLines = meaningfulLines(current).filter(line => !defaults.has(line.trim().replace(/\/$/, "")) && !defaults.has(line.trim()));
  writeFileSync(target, [...templateLines(), ...userLines, ""].join("\n"));
  return { merged: true, path: target };
}

/**
 * Legacy prefix-only projection, not the shared analysis admission policy.
 * Never use it to admit analysis files: it cannot preserve rule order or rescue.
 * Parse the simple subset of Git ignore syntax into root-relative prefixes
 * for the extension-side corpus filter (QMD discovery filter + Graphify).
 * Literal dirs/files, leading or trailing slash, and dir/star-star map
 * cleanly. Negation, star-star-anchored, and globbed patterns are NOT
 * representable as root-relative prefixes and are dropped here. They are
 * honored only where the engine applies full Git semantics natively, such as
 * pi-nav discovery (visibility:\"project\"). The docs lane therefore does NOT
 * merge .gitignore prefixes at all; code/global lanes carry only the
 * representable subset. Core admission uses the full ordered policy instead.
 */
export function gitignoreLinesToPrefixes(lines: string[], root: string): string[] {
  const prefixes: string[] = [];
  for (const raw of lines) {
    let value = raw.trim();
    if (!value || value.startsWith("#") || value.startsWith("!")) continue;
    if (value.endsWith("/**")) value = value.slice(0, -3);
    if (value.includes("*") || value.includes("?") || value.includes("[")) continue;
    while (value.startsWith("/")) value = value.slice(1);
    while (value.endsWith("/")) value = value.slice(0, -1);
    if (!value || value.startsWith("../") || value === "." || value === "..") continue;
    prefixes.push(value);
  }
  return prefixes;
}
