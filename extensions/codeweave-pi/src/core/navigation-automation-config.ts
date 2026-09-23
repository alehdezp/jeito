import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

import type { AutomationPolicyInput } from "./backend-registry.ts";
import { readFriendlyNavigationYaml } from "./navigation-friendly-yaml.ts";
import { DEFAULT_GRAPHIFY_PROVIDER, DEFAULT_GRAPHIFY_MODEL, DEFAULT_EMBEDDING_PROVIDER, DEFAULT_LLM_PROVIDER } from "./navigation-defaults.ts";
// Re-export for existing importers that expect these from this module.
export { DEFAULT_GRAPHIFY_PROVIDER, DEFAULT_GRAPHIFY_MODEL, DEFAULT_EMBEDDING_MODEL_OPENAI, DEFAULT_EMBEDDING_MODEL_VOYAGE, DEFAULT_LLM_PROVIDER, DEFAULT_LLM_MODEL_OPENAI, DEFAULT_EMBEDDING_PROVIDER } from "./navigation-defaults.ts";

export type AutomationMode = "auto-local" | "aggressive" | "guided" | "disabled";
export type StopRefreshMode = "off" | "enabled-local-only" | "aggressive";
export type MonorepoMode = "infer-from-query" | "ask-or-infer-from-query" | "ask" | "whole-repo";

export interface OpenAICompatibleProviderConfig {
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
}

export interface NavigationAutomationConfig {
  version: 1;
  automation: {
    mode: AutomationMode;
    autoPrepareOnSessionStart: boolean | "detect-only" | "quick-local";
    autoPrepareOnFirstBroadRequest: boolean;
    autoRefreshOnStop: StopRefreshMode;
    startupAutoPrepareBudgetMs: number;
    startupAutoPrepareActionTimeoutMs: number;
  };
  installs: {
    allowNetworkInstalls: boolean;
    allowedInstallers: string[];
    requireConfirmationForShellPipes: boolean;
  };
  providers: {
    allowCloud: boolean;
    allowed: string[];
    defaultEmbeddingProvider?: string;
    secondaryEmbeddingProvider?: string;
    defaultLLMProvider?: string;
    allowEmbeddings: boolean;
    allowLLM: boolean;
    allowLocalModelDownloads: boolean;
    openaiCompatible?: Record<string, OpenAICompatibleProviderConfig>;
  };
  storage: {
    indexRoot: string;
    projectStateDir: string;
    allowVisibleProjectDirs: boolean;
    allowBackendNativeDirs: boolean;
  };
  scoping: {
    maxAutoFiles: number;
    maxAutoBytes: number;
    monorepoMode: MonorepoMode;
    defaultIgnoresProfile: string;
  };
  backends: Record<string, any>;
}

export interface LoadedAutomationConfig {
  path?: string;
  exists: boolean;
  config: NavigationAutomationConfig;
  diagnostics: string[];
  /** Failed parsing/loading, not a non-fatal in-memory migration notice. */
  loadFailed?: true;
  /** Private provider env vars derived from ~/.pi/agent/navigation.yaml. Never render these values. */
  providerEnv?: Record<string, string>;
}

export interface LoadAutomationConfigOptions {
  path?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}


export const DEFAULT_NAVIGATION_AUTOMATION_CONFIG: NavigationAutomationConfig = {
  version: 1,
  automation: {
    mode: "aggressive",
    autoPrepareOnSessionStart: true,
    autoPrepareOnFirstBroadRequest: true,
    autoRefreshOnStop: "aggressive",
    startupAutoPrepareBudgetMs: 20 * 60_000,
    startupAutoPrepareActionTimeoutMs: 20 * 60_000,
  },
  installs: {
    allowNetworkInstalls: true,
    allowedInstallers: ["pip", "npm", "cargo"],
    requireConfirmationForShellPipes: true,
  },
  providers: {
    // Credentials remain host-owned; missing keys degrade prepared semantic lanes without affecting exact tools.
    allowCloud: true,
    allowed: ["openai", "voyage", "zeroentropy", "openrouter", "google", "anthropic", "openai-compatible", "deepseek", "kimi", "ollama", "sentence-transformers"],
    defaultEmbeddingProvider: "openai",
    secondaryEmbeddingProvider: "voyage",
    defaultLLMProvider: "deepseek",
    allowEmbeddings: true,
    allowLLM: true,
    allowLocalModelDownloads: true,
    openaiCompatible: {
      voyage: { baseUrl: "https://api.voyageai.com/v1", model: "voyage-4-large", apiKeyEnv: "VOYAGE_API_KEY" },
    },
  },
  storage: {
    indexRoot: "~/.pi/navigation/indexes",
    projectStateDir: ".pi/navigation",
    allowVisibleProjectDirs: true,
    allowBackendNativeDirs: true,
  },
  scoping: {
    maxAutoFiles: 50_000,
    maxAutoBytes: 1_000_000_000,
    monorepoMode: "ask-or-infer-from-query",
    defaultIgnoresProfile: "enterprise",
  },
  // Selected policy: the bundled default selects no external prepared code runtime.
  // `architecture` is the Core code-maintenance lane: its consent keys (enabled,
  // autoPrepare, root, scope) stay host-owned and are read by the lifecycle owner, so
  // the lane is kept as an opted-in-empty object and carries no CRG preparation
  // defaults. `graph` is the value `false`, not an object: an explicit host `graph`
  // object then replaces it wholesale during deep merge instead of inheriting a
  // default disable.
  backends: {
    architecture: {},
    docs: { primary: "qmd", mode: "hybridDocs", embeddings: "auto", embeddingProvider: "auto", aiSummaries: "auto", summarizerProvider: "deepseek", agentStopFreshen: "safe-scoped", maxAutomaticFiles: 300 },
    graph: false,
  },
};

// Opt-in semantic-stack preset (Graphify deep extraction). This is no longer the
// bundled default; a host that wants it must say so in its own navigation config.
// Layered onto the defaults so unrelated keys keep following them.
export const FULL_STACK_NAVIGATION_AUTOMATION_CONFIG: NavigationAutomationConfig = mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, {
  backends: {
    graph: { primary: "graphify", mode: "deepExtract", deepMode: "deepExtract", provider: "deepseek", model: "deepseek-v4-flash" },
  },
});

export function defaultAutomationConfigPath(home = homedir()): string {
  return join(home, ".pi", "navigation", "config.json");
}

export function defaultAgentNavigationConfigPath(home = homedir()): string {
  return join(home, ".pi", "agent", "navigation.yaml");
}

export function loadNavigationAutomationConfig(options: LoadAutomationConfigOptions = {}): LoadedAutomationConfig {
  const env = options.env ?? process.env;
  const configPath = options.path ?? env.PI_NAV_AUTOMATION_CONFIG ?? defaultAgentNavigationConfigPath(options.home);
  if (!existsSync(configPath)) {
    return { path: configPath, exists: false, config: expandAutomationConfigPaths(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, options.home), diagnostics: [] };
  }
  try {
    const loaded = readAutomationConfigFile(configPath);
    const merged = expandAutomationConfigPaths(mergeAutomationConfig(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, loaded.config), options.home);
    const migrated = migrateObsoleteDocsAutomation(merged);
    return { path: configPath, exists: true, config: migrated.config, diagnostics: [...loaded.diagnostics, ...migrated.diagnostics], providerEnv: loaded.providerEnv };
  } catch (error: any) {
    return {
      path: configPath,
      exists: true,
      config: expandAutomationConfigPaths(DEFAULT_NAVIGATION_AUTOMATION_CONFIG, options.home),
      loadFailed: true,
      diagnostics: [`navigation automation config error: ${configPath}: ${error?.message ?? error}`],
    };
  }

}
function migrateObsoleteDocsAutomation(config: NavigationAutomationConfig): { config: NavigationAutomationConfig; diagnostics: string[] } {
  const docs = config.backends.docs ?? {};
  if (String(docs.mode ?? "") !== "richDocs") return { config, diagnostics: [] };
  const allowed = [...new Set([...(config.providers.allowed ?? []), "zeroentropy"])];
  return {
    config: mergeAutomationConfig(config, {
      providers: { allowed },
      backends: { docs: { primary: "qmd", mode: "hybridDocs", embeddings: "auto", embeddingProvider: "auto", aiSummaries: false } },
    }),
    diagnostics: ["obsolete docs automation mode richDocs migrated in memory to QMD hybridDocs with local-or-ZeroEntropy inference selection"],
  };
}

export function envWithNavigationProviders(loaded: LoadedAutomationConfig, baseEnv: Record<string, string | undefined> = process.env, home = homedir()): Record<string, string | undefined> {
  const merged = { ...baseEnv, ...(loaded.providerEnv ?? {}) };
  return { ...merged, PATH: navigationBackendPath(merged.PATH, home) };
}

/** Builds the child-process environment for a prepared backend run. Only the
 * selected backend's own provider variables survive; unrelated credentials and API
 * keys are dropped before a prepared backend is spawned. */
export function envForNavigationBackend(
  backend: "graphify",
  loaded: LoadedAutomationConfig,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const configured = envWithNavigationProviders(loaded, baseEnv);
  const output = Object.fromEntries(Object.entries(baseEnv).filter(([name]) => !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)));
  const allowed = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "MINIMAX_API_KEY", "KIMI_API_KEY"];
  for (const name of allowed) if (configured[name]) output[name] = configured[name];
  return output;
}

function navigationBackendPath(pathValue: string | undefined, home: string): string | undefined {
  if (pathValue === "") return pathValue;
  const candidates = [
    pathValue,
    dirname(process.execPath),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    join(home, ".local", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, "bin"),
    join(home, ".cargo", "bin"),
    join(home, "go", "bin"),
  ].flatMap(value => String(value ?? "").split(delimiter)).filter(Boolean);
  const unique = [...new Set(candidates)].filter(existsSync);
  return unique.length ? unique.join(delimiter) : pathValue;
}

function firstExisting(...paths: string[]): string | undefined {
  return paths.find(path => existsSync(path));
}

function readAutomationConfigFile(path: string): { config: any; diagnostics: string[]; providerEnv?: Record<string, string> } {
  const text = readFileSync(path, "utf8");
  if (/\.ya?ml$/i.test(path)) return readFriendlyNavigationYaml(text);
  return { config: JSON.parse(text), diagnostics: [] };
}


export function automationPolicyInput(config: NavigationAutomationConfig): AutomationPolicyInput {
  const disabled = config.automation.mode === "disabled";
  return {
    allowNetworkInstalls: !disabled && config.installs.allowNetworkInstalls,
    allowCloud: !disabled && config.providers.allowCloud,
    allowEmbeddings: !disabled && config.providers.allowEmbeddings,
    allowLLM: !disabled && config.providers.allowLLM,
    allowLocalModelDownloads: !disabled && config.providers.allowLocalModelDownloads,
    allowVisibleProjectDirs: !disabled && config.storage.allowVisibleProjectDirs,
    allowUnverifiedBackends: false,
  };
}

export function mergeAutomationConfig(base: NavigationAutomationConfig, override: any): NavigationAutomationConfig {
  const value = deepMerge(base, override ?? {}) as NavigationAutomationConfig;
  value.version = 1;
  return value;
}

function expandAutomationConfigPaths(config: NavigationAutomationConfig, home = homedir()): NavigationAutomationConfig {
  const clone = structuredClone(config);
  clone.storage.indexRoot = expandPath(clone.storage.indexRoot, home);
  return clone;
}

function expandPath(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function deepMerge(base: any, override: any): any {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? structuredClone(base) : structuredClone(override);
  const output: any = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    output[key] = isPlainObject(value) && isPlainObject(output[key]) ? deepMerge(output[key], value) : structuredClone(value);
  }
  return output;
}

function isPlainObject(value: any): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
