import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { NavigationAutomationConfig } from "./navigation-automation-config.ts";
import { decideProviderPolicy, defaultModelForProvider, providerForBackend } from "./provider-registry.ts";
import { ownedGraphifyBinIfPresent } from "./backend-registry.ts";
import type { NavigationPreflightReport } from "./navigation-preflight.ts";
import type { ScopePlan } from "./scope-planner.ts";

export type GraphifyPrepareMode = "update" | "deepExtract";
export type GraphifyPolicyMode = "auto" | "guided" | "blocked";

export interface GraphifyScopePolicyOptions {
  mode?: GraphifyPrepareMode;
  graphifyBin?: string;
  config?: NavigationAutomationConfig;
  provider?: string;
  useGlobalOut?: boolean;
  env?: Record<string, string | undefined>;
}

export interface GraphifyScopePolicy {
  ok: boolean;
  policy: GraphifyPolicyMode;
  mode: GraphifyPrepareMode;
  scope: string;
  command?: string[];
  cwd: string;
  writes: string[];
  qualityGates: string[];
  reason: string;
  warnings: string[];
  blockers: string[];
  provider?: string;
  outDir?: string;
}

const GRAPHIFY_QUALITY_GATES = [
  "command exits 0",
  "expected graphify graph JSON exists",
  "graphify query/path/explain verification returns nonzero leads",
  "top leads are live source paths and not generated/vendor/cache/tool-local output",
  "graph diagnostics pass when available",
];


export function planGraphifyScope(preflight: NavigationPreflightReport, scopePlan: ScopePlan, options: GraphifyScopePolicyOptions = {}): GraphifyScopePolicy {
  const graphifyBin = options.graphifyBin ?? ownedGraphifyBinIfPresent() ?? "";
  const mode = options.mode ?? "deepExtract";
  const blockers = [...scopePlan.blockers];
  if (!graphifyBin) blockers.push("Extension-owned Graphify runtime is unavailable; run /navigation-setup.");
  const warnings = scopePlan.queryMatchedScope ? scopePlan.warnings.filter(warning => !/Multiple package\/workspace|monorepo scope is ambiguous/i.test(warning)) : [...scopePlan.warnings];
  const selected = scopePlan.selectedScopes.filter(Boolean);
  // Coalesce multiple scopes to the broadest single scope for graph extraction.
  // Graphify needs one concrete scope; multiple scopes from the planner (e.g. index.ts, src, tests)
  // should be merged into the root scope rather than blocking entirely.
  const rawScope = selected.length === 1 ? selected[0] : selected.length === 0 ? "." : ".";
  const scope = selectGraphifyScope({ mode, rawScope, preflight });

  if (scopePlan.mode === "blocked") blockers.push(scopePlan.reason);
  if (scopePlan.mode === "guided") warnings.push(scopePlan.reason);
  if (scope === "." && preflight.generatedNoiseRatio >= 0.35) warnings.push("Graphify root scope is noisy; choose src/packages/apps scope before indexing.");
  if (scope === "." && preflight.projectShape === "monorepo") warnings.push("Graphify whole-monorepo scope is risky; choose a package scope unless global policy explicitly allows it.");
  if (mode === "deepExtract") {
    const providerDecision = decideProviderPolicy({ config: options.config, provider: options.provider, capability: "llm", env: options.env });
    if (providerDecision.policy !== "allowed") blockers.push(...providerDecision.reasons);
    const cliProvider = providerForBackend(providerDecision.canonicalProvider || providerDecision.provider, "graphify");
    const model = graphifyModel(options.config, cliProvider, options.env);
    const outDir = resolveOutDir(preflight.root, scope, options.config, true);
    const command = cliProvider ? [graphifyBin, "extract", scope || ".", "--mode", "deep", "--backend", cliProvider, ...(model ? ["--model", model] : []), "--out", outDir] : [graphifyBin, "extract", scope || ".", "--mode", "deep", "--out", outDir];
    return finalize({ mode, preflight, scope: scope || ".", command, outDir, writes: [join(outDir, "graphify-out", "graph.json"), join(outDir, "graphify-out", "GRAPH_REPORT.md"), join(outDir, "graphify-out", "graph.html")], warnings, blockers, provider: cliProvider, reason: blockers.length ? blockers[0] : scopePlan.mode === "auto" ? "Graphify deep extraction is allowed by provider policy and scope is concrete" : scopePlan.reason });
  }

  if (options.config && !options.config.storage.allowVisibleProjectDirs && !options.config.storage.allowBackendNativeDirs) blockers.push("Graphify update writes setup-owned .pi/navigation/graphify output; visible/backend-native project dirs are disabled by policy.");
  const outDir = resolveOutDir(preflight.root, scope, options.config, true);
  const command = [graphifyBin, "update", scope || "."];
  return finalize({ mode, preflight, scope: scope || ".", command, outDir, writes: [join(outDir, "graphify-out", "graph.json"), join(outDir, "graphify-out", "GRAPH_REPORT.md"), join(outDir, "graphify-out", "graph.html")], warnings, blockers, reason: blockers.length ? blockers[0] : scopePlan.mode === "auto" && warnings.length === 0 ? "Graphify update is local, scope is concrete, and output policy allows .pi/navigation/graphify" : scopePlan.reason });
}

function selectGraphifyScope(input: { mode: GraphifyPrepareMode; rawScope: string; preflight: NavigationPreflightReport }): string {
  const scope = input.rawScope || ".";
  if (input.mode !== "deepExtract") return scope;
  if (scope === ".") return scope;
  // If a .graphifyignore at the project root uses whitelist patterns
  // (* / !dir/ / !dir/**), trust it to handle scope safety and expand to root.
  // The whitelist explicitly opts in directories; safety-net negatives still apply.
  if (hasGraphifyWhitelist(input.preflight.root)) return ".";
  const cleanSinglePackage = input.preflight.projectShape !== "monorepo" && input.preflight.generatedNoiseRatio < 0.35;
  const sourceOnlyScope = ["src", "lib", "app", "server", "client"].includes(scope);
  const hasRootDocs = input.preflight.docs.files > 0 && input.preflight.docs.likelyRoots.some(root => root === "." || !root.includes("/"));
  if (cleanSinglePackage && sourceOnlyScope && hasRootDocs) return ".";
  return scope;
}

function hasGraphifyWhitelist(root: string): boolean {
  try {
    const ignorePath = join(root, ".graphifyignore");
    const content = readFileSync(ignorePath, "utf8");
    // Whitelist pattern: a bare "*" line followed by "!" negation patterns
    const lines = content.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    const hasStar = lines.some(l => l === "*");
    const hasNegation = lines.some(l => l.startsWith("!"));
    return hasStar && hasNegation;
  } catch {
    return false;
  }
}

function graphifyModel(config: NavigationAutomationConfig | undefined, provider: string | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  if (!provider) return undefined;
  // Provider-agnostic runtime override (used by callers that do not pass --model).
  const envModel = env.PI_NAV_GRAPHIFY_MODEL ?? env.GRAPHIFY_MODEL;
  if (envModel) return envModel;
  // Model configured for the active graph provider.
  const configuredProvider = String(config?.backends.graph?.provider ?? "").trim().toLowerCase();
  const configuredModel = config?.backends.graph?.model;
  if (configuredModel && (!configuredProvider || configuredProvider === provider)) return configuredModel;
  // Advisory catalog default; undefined lets graphify fall back to its backend default.
  return defaultModelForProvider(provider);
}

function finalize(input: { mode: GraphifyPrepareMode; preflight: NavigationPreflightReport; scope: string; command: string[]; writes: string[]; warnings: string[]; blockers: string[]; reason: string; provider?: string; outDir?: string }): GraphifyScopePolicy {
  let policy: GraphifyPolicyMode = "auto";
  if (input.blockers.length > 0) policy = "blocked";
  else if (input.warnings.length > 0) policy = "guided";
  return {
    ok: policy === "auto",
    policy,
    mode: input.mode,
    scope: input.scope,
    command: policy === "blocked" ? undefined : input.command,
    cwd: input.preflight.root,
    writes: input.writes,
    qualityGates: GRAPHIFY_QUALITY_GATES,
    reason: input.reason,
    warnings: input.warnings,
    blockers: input.blockers,
    provider: input.provider,
    outDir: input.outDir,
  };
}


function resolveOutDir(root: string, _scope: string, _config: NavigationAutomationConfig | undefined, _forceGlobal: boolean): string {
  return join(root, ".pi", "navigation", "graphify");
}
