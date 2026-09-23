// ADR-002.002: fallback stays bounded and visible because hidden retries can bill twice; see docs/adr/0002-internal-architecture/0002-routing-and-failover.md.
import { mapFetchFailure, mayFallback, ProviderError } from "./failures.ts";
import { providerEnabled, resolveCredential, type WebConfig } from "./config.ts";
import { AdapterRegistry } from "./registry.ts";
import type { Adapter, Attempt, Intent, OpContext, Operation } from "./types.ts";

const disabledProviders = new Set<string>();
const cooldownUntil = new Map<string, number>();

interface TavilyPreferredFetchRule { hostname: string; pathname?: RegExp }

// Accepted from the 2026-08-02 fixed-URL comparison; keep path-specific where one
// host also owns source classes that Native handles better (PDF, video, or code).
const TAVILY_PREFERRED_FETCH_RULES: readonly TavilyPreferredFetchRule[] = [
  { hostname: "openai.com", pathname: /^\/(?:news|index)(?:\/|$)/ },
  { hostname: "anthropic.com", pathname: /^\/news(?:\/|$)/ },
  { hostname: "huggingface.co", pathname: /^\/papers(?:\/|$)/ },
  { hostname: "techcrunch.com" },
  { hostname: "linkedin.com", pathname: /^\/company\/[^/]+\/posts(?:\/|$)/ },
  { hostname: "juejin.cn" },
  { hostname: "36kr.com" },
  { hostname: "yourstory.com" },
  { hostname: "wsj.com", pathname: /^\/tech\/ai(?:\/|$)/ },
  { hostname: "arstechnica.com", pathname: /^\/ai(?:\/|$)/ },
  { hostname: "github.com", pathname: /^\/trending(?:\/|$)/ },
  { hostname: "bloomberg.com", pathname: /^\/technology(?:\/|$)/ },
  { hostname: "bilibili.com", pathname: /^\/(?:$|c\/ai(?:\/|$))/ },
  { hostname: "inc42.com", pathname: /^\/$/ },
  { hostname: "tech.economictimes.indiatimes.com" },
];

function tavilyPreferredFetch(intent: Intent): boolean {
  if (intent.operation !== "fetch" || (intent.mode ?? "page") !== "page") return false;
  const urls = intent.urls ?? (intent.url ? [intent.url] : []);
  return urls.length > 0 && urls.every((value) => {
    try {
      const parsed = new URL(value);
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
      return TAVILY_PREFERRED_FETCH_RULES.some((rule) => rule.hostname === hostname && (!rule.pathname || rule.pathname.test(parsed.pathname)));
    } catch {
      return false;
    }
  });
}

function preferFetchProvider(candidates: Adapter[], intent: Intent): Adapter[] {
  if (!tavilyPreferredFetch(intent)) return candidates;
  const tavily = candidates.findIndex((candidate) => candidate.capability.id === "tavily");
  return tavily <= 0 ? candidates : [candidates[tavily]!, ...candidates.slice(0, tavily), ...candidates.slice(tavily + 1)];
}

export interface RoutedResult<T> {
  value: T;
  provider: string;
  attempts: Attempt[];
}

function capabilityMatches(adapter: Adapter, intent: Intent): boolean {
  if (intent.operation === "fetch") {
    const mode = intent.mode ?? "page";
    return !adapter.capability.modes?.length || adapter.capability.modes.includes(mode);
  }
  if (intent.operation !== "search") return true;
  if (intent.kind !== "general" && !adapter.capability.strengths.includes(intent.kind)) return false;
  if (intent.recency && !adapter.capability.filters?.includes("recency")) return false;
  if (intent.domains && !adapter.capability.filters?.includes("domains")) return false;
  return true;
}

function isEligible(adapter: Adapter, intent: Intent, config: WebConfig): boolean {
  return capabilityMatches(adapter, intent) && providerEnabled(adapter.capability.id, config) &&
    (adapter.capability.credentials.length === 0 || Boolean(resolveCredential(adapter.capability.id, config))) &&
    !disabledProviders.has(adapter.capability.id) && (cooldownUntil.get(adapter.capability.id) ?? 0) <= Date.now();
}

export function selectProviders(registry: AdapterRegistry, intent: Intent, config: WebConfig): Adapter[] {
  if ("provider" in intent && intent.provider) {
    const adapter = registry.get(intent.provider);
    if (!adapter || !adapter.capability.operations.includes(intent.operation)) throw new ProviderError("invalid_input", `Provider ${intent.provider} does not support ${intent.operation}`);
    if (!capabilityMatches(adapter, intent)) throw new ProviderError("invalid_input", `Provider ${intent.provider} does not support the requested ${intent.operation} mode or filters`);
    return [adapter];
  }
  return preferFetchProvider(registry.forIntent(intent, config).filter((adapter) => isEligible(adapter, intent, config)), intent);
}

async function callAdapter(adapter: Adapter, intent: Intent, ctx: OpContext): Promise<unknown> {
  const fn = adapter[intent.operation] as ((intent: Intent, ctx: OpContext) => Promise<unknown>) | undefined;
  if (!fn) throw new ProviderError("unavailable", `${adapter.capability.id} does not support ${intent.operation}`);
  return fn.call(adapter, intent, ctx);
}

export async function runWithFallback<T>(
  registry: AdapterRegistry,
  intent: Intent,
  config: WebConfig,
  baseContext: Omit<OpContext, "credential">,
): Promise<RoutedResult<T>> {
  const explicit = "provider" in intent && Boolean(intent.provider);
  const allowExplicitFallback = explicit && "fallbackOnExplicit" in intent && Boolean(intent.fallbackOnExplicit);
  let candidates = selectProviders(registry, intent, config);
  if (!candidates.length) {
    const first = registry.forIntent(intent, config).find((adapter) => capabilityMatches(adapter, intent));
    const provider = first?.capability.id ?? "none";
    throw Object.assign(new ProviderError("missing_credential", `No available ${intent.operation} provider`), { attempts: [{ provider, operation: intent.operation, status: "failed", durationMs: 0, failureClass: "missing_credential" }] });
  }
  if (allowExplicitFallback) candidates = [candidates[0]!, ...registry.forIntent(intent, config).filter((candidate) => candidate !== candidates[0] && isEligible(candidate, intent, config))];

  const attempts: Attempt[] = [];
  const maxAttempts = explicit && !allowExplicitFallback ? 1 : Math.max(1, config.defaults.maxAttempts);
  const allowEmpty = intent.operation === "fetch" || (intent.operation === "search" && (intent.depth === "deep" || intent.strategy === "compare"));

  for (const adapter of candidates.slice(0, maxAttempts)) {
    const started = Date.now();
    try {
      const needsCredential = adapter.capability.credentials.length > 0;
      const credential = resolveCredential(adapter.capability.id, config);
      if (needsCredential && !credential) throw new ProviderError("missing_credential", `Credential unavailable for ${adapter.capability.id}`);
      const value = await callAdapter(adapter, intent, { ...baseContext, credential });
      attempts.push({ provider: adapter.capability.id, operation: intent.operation, status: "ok", durationMs: Date.now() - started });
      return { value: value as T, provider: adapter.capability.id, attempts };
    } catch (error) {
      const failure = mapFetchFailure(error, baseContext.signal);
      attempts.push({ provider: adapter.capability.id, operation: intent.operation, status: "failed", durationMs: Date.now() - started, failureClass: failure.failureClass, fallbackReason: failure.message });
      if (failure.failureClass === "auth" && adapter.capability.credentials.length > 0) disabledProviders.add(adapter.capability.id);
      if (failure.failureClass === "rate_limited" || failure.failureClass === "quota") cooldownUntil.set(adapter.capability.id, Date.now() + (failure.retryAfterMs ?? (failure.failureClass === "quota" ? 5 * 60_000 : 60_000)));
      if (explicit && !allowExplicitFallback || !mayFallback(failure.failureClass, allowEmpty)) throw Object.assign(failure, { attempts });
    }
  }
  throw Object.assign(new ProviderError(attempts.at(-1)?.failureClass ?? "unavailable", "All eligible providers failed"), { attempts });
}

export function resetRoutingState(): void {
  disabledProviders.clear();
  cooldownUntil.clear();
}
