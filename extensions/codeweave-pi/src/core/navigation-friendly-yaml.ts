import { DEFAULT_EMBEDDING_PROVIDER, DEFAULT_GRAPHIFY_MODEL, DEFAULT_GRAPHIFY_PROVIDER } from "./navigation-defaults.ts";
type StopRefreshMode = "off" | "enabled-local-only" | "aggressive";

export interface FriendlyNavigationYamlResult {
  config: any;
  diagnostics: string[];
  providerEnv?: Record<string, string>;
}

/**
 * Tiny YAML subset for the friendly private config at ~/.pi/agent/navigation.yaml.
 * Supports nested maps, inline scalars, quoted strings, booleans, numbers, and
 * inline arrays. It intentionally does not try to be a complete YAML parser.
 */
export function readFriendlyNavigationYaml(text: string): FriendlyNavigationYamlResult {
  return friendlyYamlToAutomationConfig(parseSimpleYaml(text));
}

function parseSimpleYaml(text: string): any {
  const root: any = {};
  const stack: { indent: number; value: any }[] = [{ indent: -1, value: root }];
  for (const raw of text.split(/\r?\n/)) {
    const withoutComment = stripYamlComment(raw);
    if (!withoutComment.trim()) continue;
    const match = /^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(withoutComment);
    if (!match) continue;
    const indent = match[1].length;
    const key = match[2];
    const rawValue = match[3] ?? "";
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (!rawValue.trim()) {
      const child: any = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseYamlScalar(rawValue.trim());
    }
  }
  return root;
}

function stripYamlComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== "\\") quote = quote === ch ? undefined : quote ?? ch;
    if (ch === "#" && !quote && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function parseYamlScalar(value: string): any {
  if (/^(true|false)$/i.test(value)) return /^true$/i.test(value);
  if (/^null$/i.test(value)) return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map(item => parseYamlScalar(item.trim())).filter(item => item !== "");
  return value;
}

function friendlyYamlToAutomationConfig(input: any): FriendlyNavigationYamlResult {
  const diagnostics: string[] = [];
  const config: any = { version: 1 };
  const providerEnv: Record<string, string> = {};
  const automation = input?.automation ?? {};
  if (input?.profile === "max-quality") config.automation = { mode: "aggressive" };
  if (automation.session_start !== undefined || automation.first_broad_request !== undefined || automation.stop_refresh !== undefined || automation.mode !== undefined) {
    config.automation = { ...(config.automation ?? {}) };
    if (automation.mode) config.automation.mode = automation.mode;
    if (automation.session_start !== undefined) config.automation.autoPrepareOnSessionStart = normalizeSessionStart(automation.session_start);
    if (automation.first_broad_request !== undefined) config.automation.autoPrepareOnFirstBroadRequest = normalizeBooleanAuto(automation.first_broad_request, true);
    if (automation.stop_refresh !== undefined) config.automation.autoRefreshOnStop = normalizeStopRefresh(automation.stop_refresh);
  }

  const providers = { ...(input?.providers ?? {}) };
  if (input?.api_keys && !providers.api_keys) providers.api_keys = input.api_keys;
  if (input?.apiKeys && !providers.api_keys) providers.api_keys = input.apiKeys;
  if (Object.keys(providers).length) {
    config.providers = {};
    if (providers.allow_cloud !== undefined) config.providers.allowCloud = normalizeBooleanAuto(providers.allow_cloud, false);
    if (providers.allow_llm !== undefined) config.providers.allowLLM = normalizeBooleanAuto(providers.allow_llm, false);
    if (providers.allow_embeddings !== undefined) config.providers.allowEmbeddings = normalizeBooleanAuto(providers.allow_embeddings, false);
    if (providers.allow_local_model_downloads !== undefined) config.providers.allowLocalModelDownloads = normalizeBooleanAuto(providers.allow_local_model_downloads, false);
    const defaults = providers.defaults ?? {};
    if (defaults.llm) config.providers.defaultLLMProvider = String(defaults.llm);
    if (defaults.embedding) config.providers.defaultEmbeddingProvider = String(defaults.embedding);
    const allowed = new Set<string>(Array.isArray(providers.allowed) ? providers.allowed.map(String) : providers.allowed ? String(providers.allowed).split(/[,\s]+/).filter(Boolean) : []);
    for (const name of ["voyage", "zeroentropy", "openrouter", "openai", "deepseek", "google", "anthropic", "kimi", "ollama", "sentence-transformers", "openai-compatible", "minimax"]) if (providers[name]) allowed.add(name);
    if (allowed.size) config.providers.allowed = [...allowed];
    collectProviderEnv(providers, providerEnv, config, diagnostics);
  }

  const backends = input?.backends ?? {};
  if (Object.keys(backends).length) config.backends = friendlyBackends(backends, diagnostics);
  return { config, diagnostics, providerEnv: Object.keys(providerEnv).length ? providerEnv : undefined };
}

function normalizeSessionStart(value: any): boolean | "detect-only" | "quick-local" {
  if (value === true || value === false) return value;
  const text = String(value).trim().toLowerCase();
  if (["quick-local", "detect-only"].includes(text)) return text as "quick-local" | "detect-only";
  if (["off", "false", "none", "disabled"].includes(text)) return false;
  if (["on", "true", "auto"].includes(text)) return true;
  return "quick-local";
}

function normalizeBooleanAuto(value: any, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["auto", "on", "true", "yes", "enabled"].includes(text)) return true;
  if (["off", "false", "no", "disabled"].includes(text)) return false;
  return fallback;
}

function normalizeStopRefresh(value: any): StopRefreshMode {
  const text = String(value).trim().toLowerCase();
  if (["enabled-local-only", "enabled", "local"].includes(text)) return "enabled-local-only";
  if (text === "aggressive") return "aggressive";
  return "off";
}

function friendlyBackends(backends: any, diagnostics: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  // A lane written as `false`, or with `enabled`/`autoPrepare`, is explicit machine
  // policy, not reader decoration: those flags are honored by existing consumers
  // (index.ts architecture/docs automatic-preparation gates) and must survive load.
  // Absent keys stay absent so a lane cannot inherit a disable from this reader.
  const laneFlags = (lane: any): Record<string, any> => {
    const flags: Record<string, any> = {};
    if (lane?.enabled !== undefined) flags.enabled = normalizeBooleanAuto(lane.enabled, true);
    if (lane?.autoPrepare !== undefined) flags.autoPrepare = normalizeBooleanAuto(lane.autoPrepare, true);
    return flags;
  };
  if (backends.architecture === false) out.architecture = false;
  else if (backends.architecture) out.architecture = laneFlags(backends.architecture);
  if (backends.graph === false) out.graph = false;
  else if (backends.graph) out.graph = { primary: "graphify", mode: backends.graph.mode ?? "deepExtract", deepMode: backends.graph.deepMode ?? "deepExtract", provider: backends.graph.provider ?? DEFAULT_GRAPHIFY_PROVIDER, model: backends.graph.model ?? DEFAULT_GRAPHIFY_MODEL, ...laneFlags(backends.graph) };
  if (backends.docs === false) out.docs = false;
  else if (backends.docs) out.docs = { primary: "qmd", mode: backends.docs.mode ?? "hybridDocs", embeddings: backends.docs.embeddings ?? "auto", embeddingProvider: backends.docs.embeddingProvider ?? backends.docs.embedding_provider ?? "auto", agentStopFreshen: backends.docs.agentStopFreshen ?? "safe-scoped", maxAutomaticFiles: normalizeDocsFileLimit(backends.docs.maxAutomaticFiles ?? backends.docs.max_automatic_files ?? backends.docs.maxFiles ?? backends.docs.max_files, 300), ...laneFlags(backends.docs) };
  if (backends.tilth) diagnostics.push("obsolete backends.tilth ignored; bundled pi-nav live queries require no backend configuration or migration");
  if (backends.structural) diagnostics.push("backends.structural ignored; bundled pi-nav live queries require no backend configuration");
  return out;
}

function normalizeDocsFileLimit(value: any, fallback: number | "all"): number | "all" {
  if (value === undefined || value === null || value === "") return fallback;
  if (String(value).trim().toLowerCase() === "all") return "all";
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function collectProviderEnv(providers: any, env: Record<string, string>, config: any, diagnostics: string[]): void {
  const apiKeys = providers.api_keys ?? providers.apiKeys ?? {};
  const voyage = { ...(apiKeys.voyage ? { api_key: apiKeys.voyage } : {}), ...(providers.voyage ?? providers.voyageai ?? providers["voyage-ai"] ?? {}) };
  if (voyage.api_key) env.VOYAGE_API_KEY = String(voyage.api_key);
  if (voyage.embedding_model || voyage.model) env.VOYAGE_EMBEDDING_MODEL = String(voyage.embedding_model ?? voyage.model);

  const zeroentropy = { ...(apiKeys.zeroentropy ? { api_key: apiKeys.zeroentropy } : {}), ...(providers.zeroentropy ?? providers.zero_entropy ?? providers["zero-entropy"] ?? {}) };
  if (zeroentropy.api_key) env.ZEROENTROPY_API_KEY = String(zeroentropy.api_key);
  if (zeroentropy.embedding_model) env.ZEROENTROPY_EMBEDDING_MODEL = String(zeroentropy.embedding_model);
  const openrouter = { ...(apiKeys.openrouter ? { api_key: apiKeys.openrouter } : {}), ...(providers.openrouter ?? providers.open_router ?? providers["open-router"] ?? {}) };
  if (openrouter.api_key) env.OPENROUTER_API_KEY = String(openrouter.api_key);
  const openai = { ...(apiKeys.openai ? { api_key: apiKeys.openai } : {}), ...(providers.openai ?? {}) };
  if (openai.api_key) {
    env.OPENAI_API_KEY = String(openai.api_key);
  }
  if (openai.embedding_model) {
    env.OPENAI_EMBEDDING_MODEL = String(openai.embedding_model);
  }
  const openaiCompatible = providers["openai-compatible"] ?? providers.openai_compatible ?? providers.openaiCompatible ?? {};
  if (openaiCompatible.base_url) env.OPENAI_BASE_URL = String(openaiCompatible.base_url);
  if (openaiCompatible.model) env.OPENAI_MODEL = String(openaiCompatible.model);
  if (openaiCompatible.api_key && !env.OPENAI_API_KEY) env.OPENAI_API_KEY = String(openaiCompatible.api_key);
  const deepseek = { ...(apiKeys.deepseek ? { api_key: apiKeys.deepseek } : {}), ...(providers.deepseek ?? {}) };
  if (deepseek.api_key) env.DEEPSEEK_API_KEY = String(deepseek.api_key);
  if (deepseek.model) env.DEEPSEEK_MODEL = String(deepseek.model);
  if (deepseek.base_url) env.DEEPSEEK_BASE_URL = String(deepseek.base_url);
  const google = { ...(apiKeys.google ? { api_key: apiKeys.google } : {}), ...(providers.google ?? providers.gemini ?? {}) };
  if (google.api_key) env.GOOGLE_API_KEY = String(google.api_key);
  const anthropic = { ...(apiKeys.anthropic ? { api_key: apiKeys.anthropic } : {}), ...(providers.anthropic ?? providers.claude ?? {}) };
  if (anthropic.api_key) env.ANTHROPIC_API_KEY = String(anthropic.api_key);
  const minimax = { ...(apiKeys.minimax ? { api_key: apiKeys.minimax } : {}), ...(providers.minimax ?? {}) };
  if (minimax.api_key) env.MINIMAX_API_KEY = String(minimax.api_key);
  const kimi = { ...(apiKeys.kimi ? { api_key: apiKeys.kimi } : {}), ...(providers.kimi ?? providers.moonshot ?? {}) };
  if (kimi.api_key) env.KIMI_API_KEY = String(kimi.api_key);
  if (providers.api_keys) diagnostics.push("providers.api_keys was read; prefer named provider blocks such as providers.voyage or providers.openai.");
}
