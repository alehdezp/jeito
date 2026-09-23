// ADR-002.004: configuration and credential precedence are governed by docs/adr/0002-internal-architecture/0004-config-and-credentials.md.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { DestinationPolicy } from "./destination-policy.ts";

export interface ProviderConfig {
  enabled?: boolean;
  env?: string;
  apiKey?: string;
}

export interface WebConfig {
  providers: Record<string, ProviderConfig>;
  priority: Record<string, string[]>;
  defaults: { depth: "fast" | "standard" | "deep"; strategy: "single" | "compare"; maxAttempts: number };
  limits: { timeoutMs: number; concurrency: number; inlineChars: number; siteMapCap: number; maxFanOut: number; responseBytes: number };
  network: DestinationPolicy;
  warnings: string[];
}

const DEFAULT_ENV: Record<string, string> = {
  serper: "SERPER_API_KEY",
  exa: "EXA_API_KEY",
  tavily: "TAVILY_API_KEY",
  linkup: "LINKUP_API_KEY",
  xsearch: "XAI_API_KEY",
  context7: "CONTEXT7_API_KEY",
  skillsmp: "SKILLSMP_API_KEY",
};

export const DEFAULT_CONFIG: WebConfig = {
  providers: {
    serper: { enabled: true }, exa: { enabled: true }, tavily: { enabled: true },
    linkup: { enabled: true }, xsearch: { enabled: true }, context7: { enabled: true },
    skillsmp: { enabled: true }, "pi-packages": { enabled: true }, webclaw: { enabled: true },
  },
  priority: {
    search: ["serper", "exa", "tavily", "linkup", "xsearch"],
    fetch: ["webclaw", "tavily"],
    answer: ["exa", "linkup"],
    lookup: ["context7", "skillsmp", "pi-packages"],
  },
  defaults: { depth: "standard", strategy: "single", maxAttempts: 2 },
  limits: { timeoutMs: 20_000, concurrency: 3, inlineChars: 12_000, siteMapCap: 25, maxFanOut: 4, responseBytes: 5_000_000 },
  network: { allowPrivateHosts: [] },
  warnings: [],
};

interface CachedConfig { mtimeMs: number | undefined; value: WebConfig }
const configCache = new Map<string, CachedConfig>();

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "pi") : join(homedir(), ".pi"));
}

// Cached per path; re-read only when web.yaml's mtime changes. The cached
// snapshot stays private; every caller receives a clone so nested mutations
// cannot corrupt later calls. A deleted or unreadable file degrades to defaults.
export function loadConfig(path = join(getAgentDir(), "web.yaml")): WebConfig {
  let mtimeMs: number | undefined;
  try { mtimeMs = statSync(path).mtimeMs; } catch { mtimeMs = undefined; }
  const cached = configCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return structuredClone(cached.value);
  if (mtimeMs === undefined) {
    const value = structuredClone(DEFAULT_CONFIG);
    configCache.set(path, { mtimeMs, value });
    return structuredClone(value);
  }
  let parsed: Partial<WebConfig> | null;
  try {
    parsed = parse(readFileSync(path, "utf8")) as Partial<WebConfig> | null;
  } catch {
    const value = { ...structuredClone(DEFAULT_CONFIG), warnings: ["config_parse_error"] };
    configCache.set(path, { mtimeMs, value });
    return structuredClone(value);
  }
  const value: WebConfig = {
    providers: { ...DEFAULT_CONFIG.providers, ...parsed?.providers },
    priority: { ...DEFAULT_CONFIG.priority, ...parsed?.priority },
    defaults: { ...DEFAULT_CONFIG.defaults, ...parsed?.defaults },
    limits: { ...DEFAULT_CONFIG.limits, ...parsed?.limits },
    network: { allowPrivateHosts: Array.isArray(parsed?.network?.allowPrivateHosts) ? parsed.network.allowPrivateHosts.filter((host): host is string => typeof host === "string" && Boolean(host.trim())).map((host) => host.trim()) : [] },
    warnings: [],
  };
  configCache.set(path, { mtimeMs, value });
  return structuredClone(value);
}

export interface CredentialStatus {
  enabled: boolean;
  present: boolean;
  source: "inline" | "environment" | "missing" | "none";
  envName?: string;
}

export function credentialStatus(provider: string, config: WebConfig): CredentialStatus {
  const entry = config.providers[provider];
  const enabled = entry?.enabled !== false;
  const envName = entry?.env || DEFAULT_ENV[provider];
  if (!enabled) return { enabled, present: false, source: "missing", envName };
  if (entry?.apiKey?.trim()) return { enabled, present: true, source: "inline", envName };
  if (envName) return { enabled, present: Boolean(process.env[envName]), source: process.env[envName] ? "environment" : "missing", envName };
  return { enabled, present: true, source: "none" };
}

export function resolveCredential(provider: string, config: WebConfig): string | undefined {
  const status = credentialStatus(provider, config);
  if (!status.enabled) return undefined;
  const entry = config.providers[provider];
  if (status.source === "inline") return entry?.apiKey?.trim();
  return status.envName ? process.env[status.envName] : undefined;
}

export function providerEnabled(provider: string, config: WebConfig): boolean {
  return config.providers[provider]?.enabled !== false;
}