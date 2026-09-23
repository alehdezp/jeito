// ADR-005.001: provider capability policy owns this adapter's contract surface; see docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md.
// Contract grounded in installed @tavily/core@0.7.6 plus current official Search/Extract/Map/Crawl/Research HTTP contracts — see docs/upstreams/tavily.md.
import { tavily, type TavilyClient } from "@tavily/core";
import { classifyHttpFailure, mapFetchFailure, ProviderError, redactCredential } from "../failures.ts";
import type {
  Adapter, FetchIntent, FetchedContent, OpContext, SearchIntent, SearchResult,
  SearchResultList, TavilyAccountUsage, TavilyCrawlControls, TavilyCrawlResponse, TavilyExtractControls,
  TavilyExtractResponse, TavilyMapControls, TavilyMapResponse, TavilyResearchControls,
  TavilyResearchResponse, TavilySearchControls, TavilySearchResponse, TavilyUsageResponse,
  TavilyUsageSection,
} from "../types.ts";

type ClientFactory = (apiKey: string) => TavilyClient;
type FetchLike = typeof fetch;

const SEARCH_MAX = 20;
const EXTRACT_MAX = 20;
const SITE_MAP_CAP = 25;

// --- Pre-call validation ---

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderError("aborted", "Request aborted");
}

function assertRootUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError("invalid_input", "map/crawl requires a root HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
    throw new ProviderError("invalid_input", "map/crawl requires a root HTTP(S) URL");
}

function assertMapCrawlBounds(c: { maxDepth?: number; maxBreadth?: number; limit?: number; timeout?: number }): void {
  if (c.maxDepth !== undefined && (c.maxDepth < 1 || c.maxDepth > 5))
    throw new ProviderError("invalid_input", "maxDepth must be 1-5");
  if (c.maxBreadth !== undefined && (c.maxBreadth < 1 || c.maxBreadth > 500))
    throw new ProviderError("invalid_input", "maxBreadth must be 1-500");
  if (c.limit !== undefined && (!Number.isSafeInteger(c.limit) || c.limit < 1))
    throw new ProviderError("invalid_input", "limit must be a positive integer");
  if (c.timeout !== undefined && (c.timeout < 10 || c.timeout > 150))
    throw new ProviderError("invalid_input", "timeout must be 10-150 seconds");
}

async function withHttpSignal<T>(ctx: OpContext, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  assertNotAborted(ctx.signal);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), Math.max(1, ctx.timeoutMs));
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout.signal]) : timeout.signal;
  try {
    return await operation(signal);
  } catch (error) {
    throw mapFetchFailure(error, ctx.signal);
  } finally {
    clearTimeout(timer);
  }
}

// --- Focused provider operations (internal; for comparison/maintenance code) ---

export async function tavilySearch(
  credential: string, query: string, controls: TavilySearchControls, ctx: OpContext,
  clientFactory: ClientFactory = (key) => tavily({ apiKey: key }),
): Promise<TavilySearchResponse> {
  if (controls.maxResults !== undefined && (controls.maxResults < 1 || controls.maxResults > SEARCH_MAX))
    throw new ProviderError("invalid_input", `maxResults must be 1-${SEARCH_MAX}`);
  if (controls.startDate !== undefined && controls.endDate !== undefined && controls.startDate >= controls.endDate)
    throw new ProviderError("invalid_input", "Tavily startDate must be before endDate; equal bounds are not accepted");
  // The SDK exposes no AbortSignal for search; pre/post-call checks prevent
  // fallback and a second provider charge but cannot cancel the in-flight HTTP request.
  assertNotAborted(ctx.signal);
  try {
    const r = await clientFactory(credential).search(query, {
      searchDepth: controls.searchDepth,
      topic: controls.topic,
      days: controls.days,
      maxResults: controls.maxResults,
      includeImages: controls.includeImages,
      includeImageDescriptions: controls.includeImageDescriptions,
      includeAnswer: controls.includeAnswer,
      includeRawContent: controls.includeRawContent,
      includeDomains: controls.includeDomains,
      excludeDomains: controls.excludeDomains,
      maxTokens: controls.maxTokens,
      timeRange: controls.timeRange,
      chunksPerSource: controls.chunksPerSource,
      country: controls.country,
      startDate: controls.startDate,
      endDate: controls.endDate,
      autoParameters: controls.autoParameters,
      exactMatch: controls.exactMatch,
      includeUsage: controls.includeUsage ?? true,
      timeout: controls.timeout,
    });
    if (!r || typeof r !== "object" || !Array.isArray(r.results)) throw new ProviderError("unavailable", "Tavily search response shape changed");
    assertNotAborted(ctx.signal);
    return {
      answer: r.answer, query: r.query, responseTime: r.responseTime,
      images: r.images ?? [], autoParameters: r.autoParameters,
      usageCredits: r.usage?.credits, requestId: r.requestId,
      results: r.results.map((x) => {
        if (!x || typeof x !== "object") return { title: "", url: "", content: "", score: 0, publishedDate: "" };
        return {
          title: x.title, url: x.url, content: x.content,
          rawContent: x.rawContent, score: x.score, publishedDate: x.publishedDate,
        };
      }),
    };
  } catch (error) {
    throw mapFetchFailure(error, ctx.signal);
  }
}

export async function tavilyExtract(
  credential: string, urls: string[], controls: TavilyExtractControls, ctx: OpContext,
  clientFactory: ClientFactory = (key) => tavily({ apiKey: key }),
): Promise<TavilyExtractResponse> {
  if (!urls.length || urls.length > EXTRACT_MAX)
    throw new ProviderError("invalid_input", `extract accepts 1-${EXTRACT_MAX} URLs`);
  assertNotAborted(ctx.signal);
  try {
    const r = await clientFactory(credential).extract(urls, {
      includeImages: controls.includeImages,
      extractDepth: controls.extractDepth,
      format: controls.format,
      query: controls.query,
      chunksPerSource: controls.chunksPerSource,
      includeUsage: controls.includeUsage ?? true,
      timeout: controls.timeout,
    });
    assertNotAborted(ctx.signal);
    return {
      results: (r.results ?? []).map((x) => ({ url: x.url, title: x.title, rawContent: x.rawContent, images: x.images, favicon: x.favicon })),
      failedResults: (r.failedResults ?? []).map((x) => ({ url: x.url, error: x.error })),
      responseTime: r.responseTime, usageCredits: r.usage?.credits, requestId: r.requestId,
    };
  } catch (error) {
    throw mapFetchFailure(error, ctx.signal);
  }
}

export async function tavilyMap(
  credential: string, controls: TavilyMapControls, ctx: OpContext,
  fetchImpl: FetchLike = fetch,
): Promise<TavilyMapResponse> {
  assertRootUrl(controls.url);
  assertMapCrawlBounds(controls);
  return withHttpSignal(ctx, async (signal) => {
    const response = await fetchImpl("https://api.tavily.com/map", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify({
        url: controls.url,
        instructions: controls.instructions,
        max_depth: controls.maxDepth ?? 1,
        max_breadth: controls.maxBreadth ?? 20,
        limit: controls.limit,
        select_paths: controls.selectPaths,
        select_domains: controls.selectDomains,
        exclude_paths: controls.excludePaths,
        exclude_domains: controls.excludeDomains,
        allow_external: controls.allowExternal ?? false,
        include_usage: true,
        timeout: controls.timeout ?? Math.max(10, Math.min(150, Math.ceil(ctx.timeoutMs / 1000))),
      }),
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw classifyHttpFailure(response.status, response.headers.get("retry-after"), errorBody);
    }
    const data = await response.json() as {
      base_url?: string; results?: unknown; response_time?: number;
      usage?: { credits?: number }; request_id?: string;
    };
    if (!Array.isArray(data.results) || !data.results.every((url) => typeof url === "string"))
      throw new ProviderError("unavailable", "Tavily map response shape changed");
    return {
      baseUrl: data.base_url ?? controls.url,
      results: data.results as string[],
      responseTime: data.response_time ?? 0,
      usageCredits: data.usage?.credits,
      requestId: data.request_id,
    };
  });
}

export async function tavilyCrawl(
  credential: string, controls: TavilyCrawlControls, ctx: OpContext,
  fetchImpl: FetchLike = fetch,
): Promise<TavilyCrawlResponse> {
  assertRootUrl(controls.url);
  assertMapCrawlBounds(controls);
  return withHttpSignal(ctx, async (signal) => {
    const response = await fetchImpl("https://api.tavily.com/crawl", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify({
        url: controls.url,
        instructions: controls.instructions,
        max_depth: controls.maxDepth ?? 1,
        max_breadth: controls.maxBreadth ?? 20,
        limit: controls.limit,
        select_paths: controls.selectPaths,
        select_domains: controls.selectDomains,
        exclude_paths: controls.excludePaths,
        exclude_domains: controls.excludeDomains,
        allow_external: controls.allowExternal ?? false,
        include_images: controls.includeImages ?? false,
        extract_depth: controls.extractDepth ?? "basic",
        format: controls.format ?? "markdown",
        chunks_per_source: controls.chunksPerSource,
        include_usage: true,
        timeout: controls.timeout ?? Math.max(10, Math.min(150, Math.ceil(ctx.timeoutMs / 1000))),
      }),
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw classifyHttpFailure(response.status, response.headers.get("retry-after"), errorBody);
    }
    const data = await response.json() as {
      base_url?: string;
      results?: Array<{ url: string; raw_content: string; favicon?: string }>;
      response_time?: number;
      usage?: { credits?: number };
      request_id?: string;
    };
    if (!Array.isArray(data.results) || !data.results.every((result) =>
      result && typeof result.url === "string" && typeof result.raw_content === "string"))
      throw new ProviderError("unavailable", "Tavily crawl response shape changed");
    return {
      baseUrl: data.base_url ?? controls.url,
      results: data.results.map((result) => ({ url: result.url, rawContent: result.raw_content, favicon: result.favicon })),
      responseTime: data.response_time ?? 0,
      usageCredits: data.usage?.credits,
      requestId: data.request_id,
    };
  });
}

function assertResearchControls(controls: TavilyResearchControls): void {
  if (!controls.input.trim()) throw new ProviderError("invalid_input", "research input is blank");
  if (!Number.isFinite(controls.maxWaitMs) || controls.maxWaitMs <= 0) throw new ProviderError("invalid_input", "research maxWaitMs must be positive");
  if ((controls.includeDomains?.length ?? 0) > 20 || (controls.excludeDomains?.length ?? 0) > 20)
    throw new ProviderError("invalid_input", "research domain lists accept at most 20 entries");
  if ((controls.files?.length ?? 0) > 5) throw new ProviderError("invalid_input", "research accepts at most 5 files");
}

async function tavilyResearchRequest(
  credential: string, path: string, ctx: OpContext, fetchImpl: FetchLike, body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return await withHttpSignal(ctx, async (signal) => {
      const response = await fetchImpl(`https://api.tavily.com${path}`, {
        method: body ? "POST" : "GET", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw classifyHttpFailure(response.status, response.headers.get("retry-after"), errorBody);
      }
      const text = await response.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new ProviderError("unavailable", "Tavily research response is not valid JSON"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProviderError("unavailable", "Tavily research response shape changed");
      return parsed as Record<string, unknown>;
    });
  } catch (error) {
    throw redactCredential(error instanceof ProviderError ? error : mapFetchFailure(error, ctx.signal), credential);
  }
}
function normalizeResearchResponse(raw: Record<string, unknown>): TavilyResearchResponse {
  const requestId = raw.request_id;
  const status = raw.status;
  const responseTime = raw.response_time;
  if (typeof requestId !== "string" || !["pending", "in_progress", "completed", "failed"].includes(String(status)) || typeof responseTime !== "number")
    throw new ProviderError("unavailable", "Tavily research response shape changed");
  const rawSources = raw.sources;
  if (rawSources !== undefined && (!Array.isArray(rawSources) || !rawSources.every((source) =>
    source && typeof source === "object" && typeof (source as { title?: unknown }).title === "string" && typeof (source as { url?: unknown }).url === "string")))
    throw new ProviderError("unavailable", "Tavily research source shape changed");
  return {
    requestId, status: status as TavilyResearchResponse["status"], responseTime,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : undefined,
    input: typeof raw.input === "string" ? raw.input : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    content: typeof raw.content === "string" || (raw.content && typeof raw.content === "object" && !Array.isArray(raw.content)) ? raw.content as string | Record<string, unknown> : undefined,
    sources: rawSources as TavilyResearchResponse["sources"],
  };
}

export async function runTavilyResearch(
  credential: string, controls: TavilyResearchControls, ctx: OpContext, fetchImpl: FetchLike = fetch,
): Promise<TavilyResearchResponse> {
  assertResearchControls(controls);
  const created = normalizeResearchResponse(await tavilyResearchRequest(credential, "/research", ctx, fetchImpl, {
    input: controls.input, model: controls.model ?? "auto", output_schema: controls.outputSchema,
    citation_format: controls.citationFormat, include_domains: controls.includeDomains,
    exclude_domains: controls.excludeDomains, output_length: controls.outputLength, files: controls.files,
  }));
  const deadline = Date.now() + controls.maxWaitMs;
  let current = created;
  while (current.status === "pending" || current.status === "in_progress") {
    if (Date.now() >= deadline) throw new ProviderError("timeout", `Tavily research did not finish within ${controls.maxWaitMs}ms`);
    const delayMs = Math.min(controls.pollIntervalMs ?? 1000, Math.max(0, deadline - Date.now()));
    await new Promise<void>((resolve, reject) => {
      if (ctx.signal?.aborted) return reject(new ProviderError("aborted", "Request aborted"));
      const onAbort = () => { clearTimeout(timer); reject(new ProviderError("aborted", "Request aborted")); };
      const timer = setTimeout(() => { ctx.signal?.removeEventListener("abort", onAbort); resolve(); }, delayMs);
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
    });
    current = normalizeResearchResponse(await tavilyResearchRequest(credential, `/research/${encodeURIComponent(created.requestId)}`, ctx, fetchImpl));
  }
  return current;
}

// --- Focused usage operation (internal maintenance; not a registered tool) ---
// Shape is taken ONLY from the official OpenAPI reference
// (docs.tavily.com/documentation/api-reference/endpoint/usage): GET /usage returns a top-level
// `key` object and `account` object of integer usage fields (limit fields nullable). Additive
// unknown fields are ignored; a body that is not an object, or carries neither recognized
// section, is rejected as a provider-contract change rather than accepted.

function usageInt(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageLimit(raw: Record<string, unknown>, key: string): number | null | undefined {
  const value = raw[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKeyUsage(raw: unknown): TavilyUsageSection | undefined {
  if (!isPlainObject(raw)) return undefined;
  return {
    usage: usageInt(raw, "usage"),
    limit: usageLimit(raw, "limit"),
    searchUsage: usageInt(raw, "search_usage"),
    extractUsage: usageInt(raw, "extract_usage"),
    crawlUsage: usageInt(raw, "crawl_usage"),
    mapUsage: usageInt(raw, "map_usage"),
    researchUsage: usageInt(raw, "research_usage"),
  };
}

function parseAccountUsage(raw: unknown): TavilyAccountUsage | undefined {
  if (!isPlainObject(raw)) return undefined;
  const section = parseKeyUsage(raw)!;
  const account: TavilyAccountUsage = { ...section };
  const plan = raw.current_plan;
  if (typeof plan === "string") account.currentPlan = plan;
  account.planUsage = usageInt(raw, "plan_usage");
  account.planLimit = usageLimit(raw, "plan_limit");
  account.paygoUsage = usageInt(raw, "paygo_usage");
  account.paygoLimit = usageLimit(raw, "paygo_limit");
  return account;
}

function sectionHasData(section: TavilyUsageSection | undefined): boolean {
  if (!section) return false;
  return Object.values(section).some((value) => value !== undefined);
}

export async function tavilyGetUsage(
  credential: string, ctx: OpContext, fetchImpl: FetchLike = fetch,
): Promise<TavilyUsageResponse> {
  return withHttpSignal(ctx, async (signal) => {
    let response: Response;
    try {
      response = await fetchImpl("https://api.tavily.com/usage", {
        method: "GET", signal,
        headers: { Authorization: `Bearer ${credential}` },
      });
    } catch (error) {
      throw redactCredential(mapFetchFailure(error, ctx.signal), credential);
    }
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw redactCredential(classifyHttpFailure(response.status, response.headers.get("retry-after"), errorBody), credential);
    }
    // Consume the body under the existing timeout signal; a body-read abort escapes to
    // withHttpSignal and maps to "timeout" (never misclassified as a parse failure). JSON is
    // parsed separately afterward so a true parse failure is a provider-contract class.
    const bodyText = await response.text();
    let data: unknown;
    try { data = JSON.parse(bodyText); } catch { throw new ProviderError("unavailable", "Tavily usage response is not valid JSON"); }
    if (!isPlainObject(data)) throw new ProviderError("unavailable", "Tavily usage response is not an object");
    const key = parseKeyUsage(data.key);
    const account = parseAccountUsage(data.account);
    // At least one recognized section with a documented field must be present; an empty or
    // wholly changed body is rejected, never silently accepted.
    if (!sectionHasData(key) && !sectionHasData(account))
      throw new ProviderError("unavailable", "Tavily usage response carried no recognized usage section");
    const result: TavilyUsageResponse = {};
    if (key) result.key = key;
    if (account) result.account = account;
    return result;
  });
}

// --- Shared adapter ---

export function createTavilyAdapter(
  clientFactory: ClientFactory = (apiKey) => tavily({ apiKey }),
  fetchImpl: FetchLike = fetch,
): Adapter {
  return {
    capability: {
      id: "tavily", operations: ["search", "fetch"], credentials: ["TAVILY_API_KEY"],
      strengths: ["general", "news"], modes: ["page", "site", "map"],
      returns: ["content", "leads"], filters: ["domains", "recency"],
      timeoutMs: 20_000, concurrency: 3,
      fallbackEligible: true, provenance: "docs/upstreams/tavily.md",
    },
    async search(intent: SearchIntent, ctx: OpContext): Promise<SearchResult[]> {
      if (!ctx.credential) throw new ProviderError("missing_credential", "TAVILY_API_KEY is not set");
      if (intent.tavily?.days !== undefined && !(intent.tavily.days > 0)) throw new ProviderError("invalid_input", "tavily.days must be a positive number");
      const response = await tavilySearch(ctx.credential, intent.query, {
        searchDepth: intent.tavily?.searchDepth ?? (intent.depth === "deep" ? "advanced" : intent.depth === "fast" ? "fast" : "basic"),
        maxResults: Math.min(intent.count, SEARCH_MAX),
        topic: intent.tavily?.topic ?? (intent.kind === "news" ? "news" : "general"),
        timeRange: intent.tavily?.timeRange,
        days: intent.tavily?.days,
        startDate: intent.recency?.from,
        endDate: intent.recency?.to,
        includeDomains: intent.domains?.include,
        excludeDomains: intent.domains?.exclude,
        chunksPerSource: intent.tavily?.chunksPerSource,
        country: intent.tavily?.country,
        exactMatch: intent.tavily?.exactMatch,
        timeout: ctx.timeoutMs / 1000,
      }, ctx, clientFactory);
      const tavily = { usageCredits: response.usageCredits, responseTime: response.responseTime, requestId: response.requestId };
      const rows = response.results;
      const normalized = rows
        .filter((result) => result && typeof result === "object" && result.title && result.url && result.content)
        .map((result) => ({
          title: result.title, url: result.url, snippet: result.content,
          publishedAt: result.publishedDate || undefined, score: result.score,
          sourceType: intent.kind === "news" ? "news" : "organic", tavily,
        }));
      if (!rows.length) {
        // Provider-valid empty results: a successful scoped zero with the envelope carried on the array.
        const empty = [] as unknown as SearchResultList;
        empty.tavily = tavily;
        return empty;
      }
      if (!normalized.length) throw new ProviderError("unavailable", "Tavily result row shape changed");
      const results = normalized as SearchResultList;
      if (normalized.length < rows.length) {
        results[0] = { ...results[0], tavily: { ...tavily, malformedOmissionCount: rows.length - normalized.length } };
      }
      return results;
    },
    async fetch(intent: FetchIntent, ctx: OpContext): Promise<FetchedContent[]> {
      if (!ctx.credential) throw new ProviderError("missing_credential", "TAVILY_API_KEY is not set");
      const urls = intent.urls ?? (intent.url ? [intent.url] : []);
      if (intent.mode === "page") {
        const response = await tavilyExtract(ctx.credential, urls, {
          extractDepth: intent.extract === "readable" ? "basic" : "advanced",
          format: intent.extract === "raw" ? "text" : "markdown",
          timeout: ctx.timeoutMs / 1000,
        }, ctx, clientFactory);
        const tavily = { usageCredits: response.usageCredits, responseTime: response.responseTime, requestId: response.requestId };
        const fetched = response.results
          .filter((result) => result.rawContent)
          .map((result) => ({ url: result.url, title: result.title ?? result.url, content: result.rawContent, tavily }));
        if (!fetched.length)
          throw new ProviderError("empty", `Tavily failed to extract ${response.failedResults.length || urls.length} URL(s)`);
        return fetched;
      }
      const rootUrl = urls[0];
      if (!rootUrl) throw new ProviderError("invalid_input", "fetch site/map requires a URL");
      const mapResult = await tavilyMap(ctx.credential, {
        url: rootUrl,
        maxDepth: intent.mode === "site" ? 2 : 1,
        maxBreadth: 20,
        limit: SITE_MAP_CAP,
        allowExternal: false,
      }, ctx, fetchImpl);
      if (!mapResult.results.length) throw new ProviderError("empty", "Tavily map returned no URLs");
      return [{
        url: rootUrl,
        title: `Site map for ${rootUrl}`,
        content: mapResult.results.slice(0, SITE_MAP_CAP).join("\n"),
        contentType: "text/uri-list",
        tavily: { usageCredits: mapResult.usageCredits, responseTime: mapResult.responseTime, requestId: mapResult.requestId },
      }];
    },
  };
}
