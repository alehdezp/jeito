import { existsSync } from "node:fs";
import { join } from "node:path";

import type { NavigationLane } from "./navigation-config.ts";
import type { NavigationPreflightReport } from "./navigation-preflight.ts";
import type { MonorepoMode, NavigationAutomationConfig } from "./navigation-automation-config.ts";
import { VALUE_EXCLUDE_DIR_NAMES, VALUE_EXCLUDE_PATHS } from "./navigation-value-policy.ts";

export type ScopePlanMode = "auto" | "guided" | "blocked";
export type ScopePlanConfidence = "high" | "medium" | "low";

export interface ProjectScopeOverride {
  include?: string[];
  exclude?: string[];
}

export interface ScopePlanOptions {
  query?: string;
  lane?: NavigationLane;
  projectScope?: ProjectScopeOverride;
  config?: NavigationAutomationConfig;
  monorepoMode?: MonorepoMode;
  maxAutoFiles?: number;
  maxAutoBytes?: number;
}

export interface ScopePlan {
  root: string;
  selectedScopes: string[];
  excluded: string[];
  confidence: ScopePlanConfidence;
  mode: ScopePlanMode;
  reason: string;
  warnings: string[];
  blockers: string[];
  queryMatchedScope?: string;
}

const ENTERPRISE_EXCLUDES = [...VALUE_EXCLUDE_DIR_NAMES, ...VALUE_EXCLUDE_PATHS];

export function planNavigationScope(preflight: NavigationPreflightReport, options: ScopePlanOptions = {}): ScopePlan {
  const blockers = preflight.risks.filter(risk => risk.severity === "blocker").map(risk => risk.message);
  const warnings = preflight.risks.filter(risk => risk.severity === "warning").map(risk => risk.message);
  const excluded = unique([...(options.projectScope?.exclude ?? []), ...ENTERPRISE_EXCLUDES]);
  const explicitInclude = cleanScopes(options.projectScope?.include);
  const maxAutoFiles = options.maxAutoFiles ?? options.config?.scoping.maxAutoFiles ?? 50_000;
  const maxAutoBytes = options.maxAutoBytes ?? options.config?.scoping.maxAutoBytes ?? 1_000_000_000;
  const monorepoMode = options.monorepoMode ?? options.config?.scoping.monorepoMode ?? "ask-or-infer-from-query";

  if (blockers.length > 0) {
    return plan({ preflight, selectedScopes: explicitInclude.length ? explicitInclude : preflight.recommendedScopes, excluded, confidence: "low", mode: "blocked", reason: blockers[0], warnings, blockers });
  }

  const requestedRel = requestedScopeRelativeToRoot(preflight);
  if (explicitInclude.length > 0) {
    const requestedOutsideOverride = requestedRel && !scopeCoveredByAny(requestedRel, explicitInclude);
    if (requestedOutsideOverride) {
      return plan({ preflight, selectedScopes: [requestedRel], excluded, confidence: "medium", mode: "guided", reason: "explicit requested path is outside project scope override; not substituting configured setup scope", warnings, blockers });
    }
    const queryMatch = inferScopeFromQuery(options.query, preflight.monorepo.packageRoots);
    if (queryMatch && explicitInclude.some(scope => scope === "." || queryMatch === scope || queryMatch.startsWith(`${scope}/`))) {
      return plan({ preflight, selectedScopes: [queryMatch], excluded, confidence: "high", mode: "auto", reason: `query appears to target ${queryMatch}; using narrower scope inside project override`, warnings, blockers, queryMatchedScope: queryMatch });
    }
    return plan({ preflight, selectedScopes: explicitInclude, excluded, confidence: "high", mode: "auto", reason: "project scope override explicitly selected setup scope", warnings, blockers });
  }

  if (requestedRel && requestedPathLooksLikeProjectScope(preflight)) {
    return plan({ preflight, selectedScopes: [requestedRel], excluded, confidence: "high", mode: "auto", reason: "requested path is a nested project scope", warnings, blockers, queryMatchedScope: requestedRel });
  }

  if (preflight.scan.truncated || preflight.scan.filesYielded >= maxAutoFiles || preflight.source.bytes > maxAutoBytes) {
    return plan({ preflight, selectedScopes: preflight.recommendedScopes, excluded, confidence: "low", mode: "guided", reason: "folder exceeds automatic preflight limits; setup needs a narrower scope", warnings, blockers });
  }

  if (preflight.projectShape === "monorepo") {
    return planMonorepo(preflight, { query: options.query, excluded, warnings, blockers, monorepoMode });
  }

  if (preflight.rootConfidence === "low" && options.lane !== "docs" && preflight.source.files === 0) {
    return plan({ preflight, selectedScopes: preflight.recommendedScopes, excluded, confidence: "medium", mode: "guided", reason: "no project root marker and no source files were found; automatic code indexing should be confirmed or skipped", warnings, blockers });
  }

  if (options.lane === "docs" || preflight.projectShape === "docs-only") {
    const selectedScopes = preflight.docs.likelyRoots.length > 0 ? preflight.docs.likelyRoots : preflight.recommendedScopes;
    const mode = preflight.rootConfidence === "low" ? "guided" : "auto";
    const confidence = preflight.docs.files > 0 ? (mode === "auto" ? "high" : "medium") : "low";
    return plan({ preflight, selectedScopes, excluded, confidence, mode, reason: preflight.docs.files > 0 ? "docs roots are clear from preflight" : "no docs roots were found", warnings, blockers });
  }

  if (preflight.source.files === 0) {
    return plan({ preflight, selectedScopes: preflight.recommendedScopes, excluded, confidence: "low", mode: "guided", reason: "no source files were found; code navigation setup should be skipped or confirmed", warnings, blockers });
  }

  const selectedScopes = preflight.source.likelyRoots.length > 0 ? preflight.source.likelyRoots : ["."];
  return plan({ preflight, selectedScopes, excluded, confidence: "high", mode: "auto", reason: "single-package/source roots are clear from preflight", warnings, blockers });
}

function planMonorepo(preflight: NavigationPreflightReport, input: { query?: string; excluded: string[]; warnings: string[]; blockers: string[]; monorepoMode: MonorepoMode }): ScopePlan {
  const match = inferScopeFromQuery(input.query, preflight.monorepo.packageRoots);
  if (match) {
    return plan({ preflight, selectedScopes: [match], excluded: input.excluded, confidence: "high", mode: "auto", reason: `query appears to target ${match}; preparing that package scope first`, warnings: input.warnings, blockers: input.blockers, queryMatchedScope: match });
  }

  if (input.monorepoMode === "whole-repo") {
    return plan({ preflight, selectedScopes: ["."], excluded: input.excluded, confidence: "medium", mode: "auto", reason: "global monorepo policy allows whole-repo setup", warnings: input.warnings, blockers: input.blockers });
  }

  const selectedScopes = preflight.monorepo.packageRoots.length > 0 ? preflight.monorepo.packageRoots.slice(0, 10) : preflight.recommendedScopes;
  const reason = input.monorepoMode === "ask" ? "monorepo policy requires choosing a package scope" : "monorepo scope is ambiguous and no package was inferred from the query";
  return plan({ preflight, selectedScopes, excluded: input.excluded, confidence: "low", mode: "guided", reason, warnings: input.warnings, blockers: input.blockers });
}

function inferScopeFromQuery(query: string | undefined, packageRoots: string[]): string | undefined {
  const normalized = normalize(query);
  if (!normalized) return undefined;
  for (const scope of packageRoots) {
    const parts = scope.split(/[\\/]/).filter(Boolean);
    const name = parts.at(-1) ?? scope;
    const specificParts = parts.filter(part => !["apps", "packages", "crates", "services"].includes(part));
    const candidates = [scope, name, ...specificParts].map(normalize).filter(Boolean);
    if (candidates.some(candidate => containsQueryToken(normalized, candidate))) return scope;
  }
  return undefined;
}

function containsQueryToken(query: string, candidate: string): boolean {
  if (!candidate) return false;
  if (candidate.includes("/") && query.includes(candidate)) return true;
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_.-])${escaped}($|[^a-z0-9_.-])`, "i").test(query);
}


function requestedScopeRelativeToRoot(preflight: NavigationPreflightReport): string | undefined {
  const root = normalizePath(preflight.root);
  const requested = normalizePath(preflight.requestedPath);
  if (!requested || requested === root) return undefined;
  if (!requested.startsWith(`${root}/`)) return undefined;
  const rel = requested.slice(root.length + 1);
  return rel || undefined;
}

function requestedPathLooksLikeProjectScope(preflight: NavigationPreflightReport): boolean {
  const rel = requestedScopeRelativeToRoot(preflight);
  if (!rel) return false;
  return ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "README.md"].some(marker => existsSync(join(preflight.requestedPath, marker)));
}

function scopeCoveredByAny(scope: string, includes: string[]): boolean {
  return includes.some(include => include === "." || scope === include || scope.startsWith(`${include}/`));
}

function normalizePath(value: string | undefined): string {
  return (value ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}
function plan(input: { preflight: NavigationPreflightReport; selectedScopes: string[]; excluded: string[]; confidence: ScopePlanConfidence; mode: ScopePlanMode; reason: string; warnings: string[]; blockers: string[]; queryMatchedScope?: string }): ScopePlan {
  const selectedScopes = cleanScopes(input.selectedScopes);
  return {
    root: input.preflight.root,
    selectedScopes: selectedScopes.length > 0 ? selectedScopes : ["."],
    excluded: input.excluded,
    confidence: input.confidence,
    mode: input.mode,
    reason: input.reason,
    warnings: input.warnings,
    blockers: input.blockers,
    queryMatchedScope: input.queryMatchedScope,
  };
}

function cleanScopes(scopes: string[] | undefined): string[] {
  if (!Array.isArray(scopes)) return [];
  return unique(scopes.map(scope => String(scope).trim()).filter(Boolean).map(scope => scope.replace(/^\.\//, "")));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9/_.-]+/g, " ").replace(/\s+/g, " ").trim();
}
