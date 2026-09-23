import { extname } from "node:path";

export const SUMMARY_ENTRY_LIMIT = 80;
export const DIRECTORY_ENTRY_LIMIT = 80;
export const TEXT_EDGE_LINES = 20;

export const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".scala",
  ".rb", ".php", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".swift", ".dart", ".vue", ".svelte",
]);

export const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mdx", ".rst"]);
export const CONFIG_EXTENSIONS = new Set([".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".env", ".properties", ".xml"]);

export function classifyPath(name: string): "heading" | "function" | "config" | "text" | undefined {
  const ext = extname(name).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) return "heading";
  if (SOURCE_EXTENSIONS.has(ext)) return "function";
  if (CONFIG_EXTENSIONS.has(ext) || /(^|\.)env(\.|$)/.test(name)) return "config";
  if (/test|spec/i.test(name)) return "text";
  return undefined;
}

// Names/roots that orient a user fastest: docs, package manifests, entrypoints.
const IMPORTANT_ENTRY_RE = /^(readme|contributing|changelog|architecture|design|security)(\.|$)/i;
const MANIFEST_RE = /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|gemfile|pom\.xml|build\.gradle|requirements\.txt|flake\.nix|deno\.json)$/i;
const ENTRYPOINT_RE = /^(index|main|app|server|mod|lib)(\.[a-z0-9]+)$/i;

export function isImportantEntryName(name: string): boolean {
  const lower = name.toLowerCase();
  return IMPORTANT_ENTRY_RE.test(lower) || MANIFEST_RE.test(lower) || ENTRYPOINT_RE.test(lower);
}

export function compactArgs(args: string): string {
  const clean = args.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}

export function cleanLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

export function leadingSpaces(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

export function stripQuotedText(line: string): string {
  return line.replace(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`/g, "");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
