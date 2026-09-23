import type { NavigationAutomationConfig } from "./navigation-automation-config.ts";

export type ProviderCapability = "embedding" | "llm";
export type ProviderLocality = "cloud" | "local" | "openai-compatible";
export type ProviderPolicy = "allowed" | "ask_first" | "blocked";

export interface ProviderRecord {
  id: string;
  displayName: string;
  aliases: string[];
  capabilities: ProviderCapability[];
  locality: ProviderLocality;
  contentLeavesMachine: boolean;
  requiredEnv: string[];
  optionalEnv: string[];
  mayDownloadModels: boolean;
  cacheLocations: string[];
  backends: string[];
  /** Advisory catalog of known models, first entry = recommended default. Never a gate: unlisted strings pass through. Provider-level; the LLM-vs-embedding choice for a dual-capability provider lives in backends/openaiCompatible config, not here. Refresh against provider docs — models go stale. */
  models?: string[];
  evidence: string[];
  undo: string[];
}

export interface ProviderPolicyDecision {
  provider: string;
  canonicalProvider: string;
  capability: ProviderCapability;
  policy: ProviderPolicy;
  reasons: string[];
  requiredEnv: string[];
  missingEnv: string[];
  contentLeavesMachine: boolean;
  mayDownloadModels: boolean;
}

export interface ProviderPolicyOptions {
  config?: NavigationAutomationConfig;
  provider?: string;
  capability: ProviderCapability;
  env?: Record<string, string | undefined>;
  requireEnv?: boolean;
}

export const PROVIDER_REGISTRY: ProviderRecord[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    aliases: ["openai"],
    capabilities: ["embedding", "llm"],
    locality: "cloud",
    contentLeavesMachine: true,
    requiredEnv: ["OPENAI_API_KEY"],
    optionalEnv: ["OPENAI_MODEL", "OPENAI_EMBEDDING_MODEL"],
    mayDownloadModels: false,
    cacheLocations: [],
    backends: ["graphify"],
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "text-embedding-3-large", "text-embedding-3-small"],
    evidence: ["Graphify help lists openai provider"],
    undo: ["remove OPENAI_API_KEY from environment", "disable providers.allowCloud/providers.allowLLM/providers.allowEmbeddings in ~/.pi/agent/navigation.yaml"],
  },
  {
    id: "voyage",
    displayName: "Voyage AI",
    aliases: ["voyage", "voyageai", "voyage-ai"],
    capabilities: ["embedding"],
    locality: "openai-compatible",
    contentLeavesMachine: true,
    requiredEnv: ["VOYAGE_API_KEY"],
    optionalEnv: ["VOYAGE_EMBEDDING_MODEL", "OPENAI_BASE_URL", "OPENAI_EMBEDDING_MODEL"],
    mayDownloadModels: false,
    cacheLocations: [],
    backends: ["qmd"],
    models: ["voyage-4-large", "voyage-4", "voyage-code-3"],
    evidence: ["QMD document inference uses VoyageProvider with an explicitly configured API key and optional embedding model."],
    undo: ["remove VOYAGE_API_KEY from environment", "disable providers.allowCloud/providers.allowEmbeddings in ~/.pi/agent/navigation.yaml"],
  },
  {
    id: "zeroentropy",
    displayName: "ZeroEntropy",
    aliases: ["zeroentropy", "zero-entropy", "zero_entropy"],
    capabilities: ["embedding"],
    locality: "cloud",
    contentLeavesMachine: true,
    requiredEnv: ["ZEROENTROPY_API_KEY"],
    optionalEnv: ["ZEROENTROPY_EMBEDDING_MODEL"],
    mayDownloadModels: false,
    cacheLocations: [],
    backends: ["qmd"],
    evidence: ["QMD docs uses zembed-1 query/document embeddings and zerank-2 reranking while persisting vectors locally."],
    undo: ["remove ZEROENTROPY_API_KEY from environment", "disable providers.allowCloud/providers.allowEmbeddings in ~/.pi/agent/navigation.yaml"],
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    aliases: ["openrouter", "open-router"],
    capabilities: ["embedding"],
    locality: "cloud",
    contentLeavesMachine: true,
    requiredEnv: ["OPENROUTER_API_KEY"],
    optionalEnv: [],
    mayDownloadModels: false,
    cacheLocations: [],
    backends: ["qmd"],
    models: ["nvidia/nemotron-3-embed-1b:free", "nvidia/llama-nemotron-rerank-vl-1b-v2:free"],
    evidence: ["OpenRouter exposes the NVIDIA embedding and reranking models through /api/v1/embeddings and /api/v1/rerank while QMD keeps vectors local."],
    undo: ["remove OPENROUTER_API_KEY from environment", "select another QMD docs provider", "disable providers.allowCloud/providers.allowEmbeddings in ~/.pi/agent/navigation.yaml"],
  },
  {
    id: "openai-compatible",
    displayName: "OpenAI-compatible endpoint",
    aliases: ["openai-compatible", "openai_compatible", "openai-compatible-api"],
    capabilities: ["embedding", "llm"],
    locality: "openai-compatible",
    contentLeavesMachine: true,
    requiredEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    optionalEnv: ["OPENAI_MODEL", "OPENAI_EMBEDDING_MODEL", "OPENAI_API_BASE"],
    mayDownloadModels: false,
    cacheLocations: [],
    backends: ["graphify"],
    evidence: ["Graphify deep extraction supports OpenAI-family provider configuration"],
    undo: ["remove endpoint/API env vars", "disable openai-compatible in providers.allowed"],
  },
  {
    id: "google",
    displayName: "Google/Gemini",
    aliases: ["google", "gemini"],
    capabilities: ["embedding", "llm"],
    locality: "cloud",
    contentLeavesMachine: true,
    requiredEnv: ["GOOGLE_API_KEY"],
    optionalEnv: ["GEMINI_MODEL", "GOOGLE_MODEL"],
    mayDownloadModels: false,
    cacheLocations: [],
    backends: ["graphify"],
    models: ["gemini-3.6-flash", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-embedding-001"],
    evidence: ["Graphify help lists gemini provider"],
    undo: ["remove GOOGLE_API_KEY from environment", "disable google/gemini in providers.allowed"],
  },
  {
    id: "anthropic",
    displayName: "Anthropic/Claude",
    aliases: ["anthropic", "claude"],
    capabilities: ["llm"],
    locality: "cloud",
    contentLeavesMachine: true,
    requiredEnv: ["ANTHROPIC_API_KEY"],
    optionalEnv: ["ANTHROPIC_MODEL", "CLAUDE_MODEL"],
    mayDownloadModels: false,
    cacheLocations: [],
    backends: ["graphify"],
    evidence: ["Graphify help lists claude provider"],
    undo: ["remove ANTHROPIC_API_KEY from environment", "disable anthropic/claude in providers.allowed"],
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    aliases: ["deepseek"],
    capabilities: ["llm"],
    locality: "cloud",
    contentLeavesMachine: true,
    requiredEnv: ["DEEPSEEK_API_KEY"],
    optionalEnv: ["DEEPSEEK_MODEL"],
    mayDownloadModels: false,
    cacheLocations: [],
    backends: ["graphify"],
    models: ["deepseek-v4", "deepseek-v4-flash"],
    evidence: ["Graphify help lists deepseek provider"],
    undo: ["remove DEEPSEEK_API_KEY from environment", "disable deepseek in providers.allowed"],
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    aliases: ["minimax", "minimax-m3"],
    capabilities: ["llm"],
    locality: "openai-compatible",
    contentLeavesMachine: true,
    requiredEnv: ["MINIMAX_API_KEY"],
    optionalEnv: ["PI_NAV_GRAPHIFY_MODEL", "GRAPHIFY_MODEL"],
    mayDownloadModels: false,
    cacheLocations: [],
    backends: ["graphify"],
    models: ["MiniMax-M3"],
    evidence: ["MiniMax-M3 exposes an OpenAI-compatible chat completions endpoint at https://api.minimax.io/v1; reached through graphify's built-in openai backend via a scoped env (OPENAI_BASE_URL/OPENAI_API_KEY mapped from MINIMAX_API_KEY in navigation-freshen.mjs graphifyProviderEnv), model selected with --model from the provider catalog"],
    undo: ["remove MINIMAX_API_KEY from environment", "disable minimax in providers.allowed"],
  },
  {
    id: "kimi",
    displayName: "Kimi/Moonshot",
    aliases: ["kimi", "moonshot"],
    capabilities: ["llm"],
    locality: "cloud",
    contentLeavesMachine: true,
    requiredEnv: ["KIMI_API_KEY"],
    optionalEnv: ["MOONSHOT_API_KEY", "KIMI_MODEL"],
    mayDownloadModels: false,
    cacheLocations: [],
    backends: ["graphify"],
    models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"],
    evidence: ["Graphify help lists kimi provider"],
    undo: ["remove KIMI_API_KEY/MOONSHOT_API_KEY from environment", "disable kimi in providers.allowed"],
  },
  {
    id: "ollama",
    displayName: "Ollama",
    aliases: ["ollama"],
    capabilities: ["embedding", "llm"],
    locality: "local",
    contentLeavesMachine: false,
    requiredEnv: [],
    optionalEnv: ["OLLAMA_HOST", "OLLAMA_MODEL", "OLLAMA_EMBEDDING_MODEL"],
    mayDownloadModels: true,
    cacheLocations: ["~/.ollama/models"],
    backends: ["graphify"],
    evidence: ["Graphify help lists ollama provider"],
    undo: ["remove selected Ollama models", "disable ollama in providers.allowed", "disable providers.allowLocalModelDownloads"],
  },
];

export function listProviderRecords(): ProviderRecord[] {
  return PROVIDER_REGISTRY.map(record => structuredClone(record));
}

export function providerRecord(provider: string): ProviderRecord | undefined {
  const canonical = canonicalProviderId(provider);
  const record = PROVIDER_REGISTRY.find(item => item.id === canonical);
  return record ? structuredClone(record) : undefined;
}

export function canonicalProviderId(provider: string | undefined): string | undefined {
  const normalized = normalizeProvider(provider);
  if (!normalized) return undefined;
  return PROVIDER_REGISTRY.find(record => record.id === normalized || record.aliases.map(normalizeProvider).includes(normalized))?.id;
}

/**
 * Recommended default model for a provider: the first entry of its advisory
 * `models` catalog. Undefined when the provider has no catalog, so callers let
 * graphify use its backend default. Advisory only: model strings not in the
 * catalog pass through unchanged, so custom/unlisted models work.
 */
export function defaultModelForProvider(provider: string | undefined): string | undefined {
  const record = providerRecord(provider ?? "");
  return record?.models?.[0];
}

export function providerForBackend(provider: string | undefined, backend: string): string | undefined {
  const canonical = canonicalProviderId(provider);
  if (!canonical) return undefined;
  if (backend === "graphify") {
    if (canonical === "google") return "gemini";
    if (canonical === "anthropic") return "claude";
  }
  return provider ?? canonical;
}

export function decideProviderPolicy(options: ProviderPolicyOptions): ProviderPolicyDecision {
  const config = options.config;
  const provider = options.provider ?? defaultProviderForCapability(config, options.capability);
  const canonical = canonicalProviderId(provider);
  const reasons: string[] = [];
  if (!provider || !canonical) {
    return {
      provider: provider ?? "",
      canonicalProvider: canonical ?? "",
      capability: options.capability,
      policy: "ask_first",
      reasons: [provider ? `unknown provider: ${provider}` : `no ${options.capability} provider configured`],
      requiredEnv: [],
      missingEnv: [],
      contentLeavesMachine: false,
      mayDownloadModels: false,
    };
  }
  const record = PROVIDER_REGISTRY.find(item => item.id === canonical)!;
  if (!record.capabilities.includes(options.capability)) reasons.push(`${record.id} does not support ${options.capability}`);
  const allowed = config?.providers.allowed ?? [];
  if (allowed.length > 0 && !allowed.map(item => canonicalProviderId(item) ?? normalizeProvider(item)).includes(canonical)) reasons.push(`${record.id} is not listed in providers.allowed`);
  if (options.capability === "embedding" && !config?.providers.allowEmbeddings) reasons.push("providers.allowEmbeddings is false");
  if (options.capability === "llm" && !config?.providers.allowLLM) reasons.push("providers.allowLLM is false");
  if (record.contentLeavesMachine && !config?.providers.allowCloud) reasons.push(`${record.id} may send repository content to a cloud provider and providers.allowCloud is false`);
  if (record.mayDownloadModels && !config?.providers.allowLocalModelDownloads) reasons.push(`${record.id} may download local models and providers.allowLocalModelDownloads is false`);
  const env = options.env ?? process.env;
  const requiredEnv = requiredEnvForProvider(record, config);
  const missingEnv = options.requireEnv === false ? [] : requiredEnv.filter(name => !env[name]);
  if (missingEnv.length > 0) reasons.push(`missing required env vars: ${missingEnv.join(", ")}`);
  const policy: ProviderPolicy = reasons.length === 0 ? "allowed" : reasons.some(reason => /does not support|not listed/.test(reason)) ? "blocked" : "ask_first";
  return {
    provider,
    canonicalProvider: canonical,
    capability: options.capability,
    policy,
    reasons,
    requiredEnv,
    missingEnv,
    contentLeavesMachine: record.contentLeavesMachine,
    mayDownloadModels: record.mayDownloadModels,
  };
}

function requiredEnvForProvider(record: ProviderRecord, config: NavigationAutomationConfig | undefined): string[] {
  const configuredApiKeyEnv = config?.providers.openaiCompatible?.[record.id]?.apiKeyEnv?.trim();
  if (configuredApiKeyEnv) return [configuredApiKeyEnv];
  return record.requiredEnv;
}

function defaultProviderForCapability(config: NavigationAutomationConfig | undefined, capability: ProviderCapability): string | undefined {
  if (capability === "embedding") return config?.providers.defaultEmbeddingProvider;
  return config?.providers.defaultLLMProvider;
}

function normalizeProvider(provider: string | undefined): string {
  return (provider ?? "").trim().toLowerCase().replace(/_/g, "-");
}
