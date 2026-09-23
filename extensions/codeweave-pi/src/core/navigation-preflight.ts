import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalProjectPath, detectProjectRoot } from "./project-root.ts";
import { createScanPolicy, createScanStats, type ScanStats } from "./scan-policy.ts";
import { walkFiles } from "./walk.ts";

export type RootConfidence = "high" | "medium" | "low";
export type ProjectShape = "single-package" | "monorepo" | "no-git-folder" | "source-only" | "docs-only" | "mixed" | "empty-or-unknown";
export type PreflightRiskKind = "ambiguous_scope" | "large_repo" | "generated_vendor_noise" | "no_source" | "no_docs" | "no_project_root" | "invalid_config";

export interface PreflightRisk {
  kind: PreflightRiskKind;
  severity: "info" | "warning" | "blocker";
  message: string;
}

export interface DensitySummary {
  files: number;
  bytes: number;
  likelyRoots: string[];
  extensions: Record<string, number>;
}

export interface NavigationPreflightReport {
  root: string;
  requestedPath: string;
  rootConfidence: RootConfidence;
  rootMarkers: string[];
  projectShape: ProjectShape;
  source: DensitySummary;
  docs: DensitySummary;
  config: { exists: boolean; valid: boolean; path?: string; error?: string };
  monorepo: { packageRoots: string[]; workspaceHints: string[] };
  scan: ScanStats;
  generatedNoiseRatio: number;
  risks: PreflightRisk[];
  recommendedScopes: string[];
}

export interface NavigationPreflightOptions {
  maxSampleFiles?: number;
  largeFileThreshold?: number;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".py", ".go", ".java", ".kt", ".kts", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".ex", ".exs"]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst"]);
const SOURCE_ROOT_NAMES = ["src", "lib", "app", "apps", "packages", "crates", "cmd", "internal"];
const DOC_ROOT_NAMES = ["docs", "doc", "guides", "handbook"];

export async function preflightNavigationTarget(targetPath = process.cwd(), options: NavigationPreflightOptions = {}): Promise<NavigationPreflightReport> {
  const requestedPath = canonicalProjectPath(targetPath);
  const rootInfo = detectProjectRoot(requestedPath);
  const root = rootInfo.root;
  const scan = createScanStats();
  const policy = await createScanPolicy(root);
  const source = emptyDensity();
  const docs = emptyDensity();
  const maxSampleFiles = options.maxSampleFiles ?? 20_000;

  for await (const file of walkFiles(root, maxSampleFiles, { policy, stats: scan })) {
    const rel = relativeish(root, file);
    const ext = extension(file);
    const size = await stat(file).then(info => info.size).catch(() => 0);
    if (SOURCE_EXTENSIONS.has(ext)) addDensity(source, ext, size, topRoot(rel));
    if (DOC_EXTENSIONS.has(ext) || isDocName(file)) addDensity(docs, ext || basename(file).toLowerCase(), size, topRoot(rel));
  }

  source.likelyRoots = likelyRoots(root, source.likelyRoots, SOURCE_ROOT_NAMES);
  docs.likelyRoots = likelyDocRoots(root, docs.likelyRoots);
  const monorepo = await detectMonorepo(root);
  const config = inspectConfig(root);
  const generatedNoiseRatio = scan.filesYielded + scan.skippedByDefault > 0 ? scan.skippedByDefault / (scan.filesYielded + scan.skippedByDefault) : 0;
  const projectShape = classifyShape({ rootInfo, source, docs, monorepo });
  const risks = buildRisks({ rootInfo, source, docs, monorepo, scan, generatedNoiseRatio, config, options });
  const recommendedScopes = recommendScopes({ root, source, docs, monorepo, projectShape });

  return {
    root,
    requestedPath,
    rootConfidence: rootInfo.confidence,
    rootMarkers: rootInfo.markers,
    projectShape,
    source,
    docs,
    config,
    monorepo,
    scan,
    generatedNoiseRatio,
    risks,
    recommendedScopes,
  };
}


function inspectConfig(root: string): NavigationPreflightReport["config"] {
  const path = join(root, ".pi-navigation.json");
  if (!existsSync(path)) return { exists: false, valid: false };
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return { exists: true, valid: true, path };
  } catch (error: any) {
    return { exists: true, valid: false, path, error: String(error?.message ?? error) };
  }
}

async function detectMonorepo(root: string): Promise<{ packageRoots: string[]; workspaceHints: string[] }> {
  const packageRoots = new Set<string>();
  const workspaceHints: string[] = [];
  const packageJson = join(root, "package.json");
  if (existsSync(packageJson)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJson, "utf8"));
      if (parsed?.workspaces) workspaceHints.push("package.json workspaces");
    } catch {}
  }
  if (existsSync(join(root, "pnpm-workspace.yaml"))) workspaceHints.push("pnpm-workspace.yaml");
  if (existsSync(join(root, "Cargo.toml"))) {
    try { if (/\[workspace\]/.test(readFileSync(join(root, "Cargo.toml"), "utf8"))) workspaceHints.push("Cargo workspace"); } catch {}
  }
  for (const dir of ["apps", "packages", "crates", "services", "extensions", "agent/extensions"]) {
    const parent = join(root, dir);
    if (!existsSync(parent)) continue;
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(parent, entry.name);
      if (["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "README.md"].some(marker => existsSync(join(child, marker)))) packageRoots.add(relativeish(root, child));
    }
  }
  return { packageRoots: [...packageRoots].sort(), workspaceHints };
}

function classifyShape(input: { rootInfo: { confidence: RootConfidence; markers: string[] }; source: DensitySummary; docs: DensitySummary; monorepo: { packageRoots: string[]; workspaceHints: string[] } }): ProjectShape {
  if (input.monorepo.packageRoots.length > 1 || input.monorepo.workspaceHints.length > 0) return "monorepo";
  if (input.source.files === 0 && input.docs.files === 0) return "empty-or-unknown";
  if (input.source.files === 0 && input.docs.files > 0) return "docs-only";
  if (input.source.files > 0 && input.docs.files === 0) return input.rootInfo.confidence === "low" ? "source-only" : "single-package";
  if (input.rootInfo.confidence === "low") return "no-git-folder";
  return input.rootInfo.markers.some(marker => marker === "package.json" || marker === "Cargo.toml" || marker === "pyproject.toml" || marker === "go.mod") ? "single-package" : "mixed";
}

function buildRisks(input: { rootInfo: { confidence: RootConfidence }; source: DensitySummary; docs: DensitySummary; monorepo: { packageRoots: string[]; workspaceHints: string[] }; scan: ScanStats; generatedNoiseRatio: number; config: NavigationPreflightReport["config"]; options: NavigationPreflightOptions }): PreflightRisk[] {
  const risks: PreflightRisk[] = [];
  if (input.rootInfo.confidence === "low") risks.push({ kind: "no_project_root", severity: "warning", message: "No VCS/config/package marker was found; automatic setup can inspect the folder but should avoid assuming repo-wide scope." });
  if (input.monorepo.packageRoots.length > 1 || input.monorepo.workspaceHints.length > 0) risks.push({ kind: "ambiguous_scope", severity: "warning", message: "Multiple package/workspace hints were found; broad automatic setup should infer a sub-scope from the user request or ask." });
  if (input.scan.truncated || input.scan.filesYielded >= (input.options.maxSampleFiles ?? 20_000)) risks.push({ kind: "large_repo", severity: "warning", message: "The preflight sample hit the file limit; full-stack setup should narrow scope before expensive indexing." });
  if (input.source.bytes > (input.options.largeFileThreshold ?? 1_000_000_000)) risks.push({ kind: "large_repo", severity: "warning", message: "Source sample exceeds the automatic byte threshold; prepare should be guided or scoped." });
  if (input.generatedNoiseRatio >= 0.35 && input.scan.skippedByDefault > 100) risks.push({ kind: "generated_vendor_noise", severity: "warning", message: "Generated/vendor/default-skipped paths are prominent; Core/QMD/Graphify setup needs strong ignores/scoping." });
  if (input.source.files === 0) risks.push({ kind: "no_source", severity: "info", message: "No likely source files were found in the safe sample; code navigation lanes may not help." });
  if (input.docs.files === 0) risks.push({ kind: "no_docs", severity: "info", message: "No likely docs were found in the safe sample; docs lane can be skipped." });
  if (input.config.exists && !input.config.valid) risks.push({ kind: "invalid_config", severity: "blocker", message: "Existing .pi-navigation.json is invalid; setup should stop until it is fixed." });
  return risks;
}

function recommendScopes(input: { root: string; source: DensitySummary; docs: DensitySummary; monorepo: { packageRoots: string[]; workspaceHints: string[] }; projectShape: ProjectShape }): string[] {
  if (input.monorepo.packageRoots.length > 0) return input.monorepo.packageRoots.slice(0, 10);
  if (input.projectShape === "docs-only" && input.docs.likelyRoots.length > 0) return input.docs.likelyRoots;
  if (input.source.likelyRoots.length > 0) return input.source.likelyRoots;
  if (input.docs.likelyRoots.length > 0) return input.docs.likelyRoots;
  return ["."];
}

function emptyDensity(): DensitySummary {
  return { files: 0, bytes: 0, likelyRoots: [], extensions: {} };
}

function addDensity(summary: DensitySummary, ext: string, bytes: number, likelyRoot: string): void {
  summary.files++;
  summary.bytes += bytes;
  summary.extensions[ext] = (summary.extensions[ext] ?? 0) + 1;
  if (likelyRoot && !summary.likelyRoots.includes(likelyRoot)) summary.likelyRoots.push(likelyRoot);
}

function likelyRoots(root: string, sampledRoots: string[], preferred: string[]): string[] {
  const roots = new Set<string>();
  for (const name of preferred) if (existsSync(join(root, name))) roots.add(name);
  for (const sampled of sampledRoots) if (sampled !== ".") roots.add(sampled);
  return [...roots].sort();
}

function likelyDocRoots(root: string, sampledRoots: string[]): string[] {
  const roots = new Set<string>();
  for (const name of DOC_ROOT_NAMES) if (existsSync(join(root, name))) roots.add(name);
  for (const name of ["README.md", "ARCHITECTURE.md", "CONTRIBUTING.md"]) if (existsSync(join(root, name))) roots.add(name);
  for (const sampled of sampledRoots) if (sampled !== ".") roots.add(sampled);
  return [...roots].sort();
}

function extension(path: string): string {
  const name = basename(path).toLowerCase();
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
}

function isDocName(path: string): boolean {
  return /(^|\/)(readme|architecture|contributing|changelog|license)(\.[^/]*)?$/i.test(path);
}

function topRoot(rel: string): string {
  if (!rel || rel === ".") return ".";
  const normalized = rel.replace(/\\/g, "/");
  if (!normalized.includes("/")) return ".";
  const first = normalized.split("/")[0];
  return first || ".";
}

function relativeish(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, "") || "." : path;
}
