// ADR-005.001: provider capability policy owns this adapter's contract surface; see docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md.
// Contract derived from @aliou/pi-linkup@0.11.0 (3d2588910cf0) — see docs/upstreams/linkup.md.
// The donor is contract evidence only; no donor code is copied (it ships no LICENSE file).
import { classifyHttpFailure, mapFetchFailure, ProviderError, redactCredential } from "../failures.ts";
import { isValidCalendarDate } from "./xsearch.ts";
import type {
  Adapter, AnswerIntent, AnswerResult, FetchIntent, FetchedContent, LinkupBalanceResponse,
  LinkupFetchControls, LinkupFetchResponse, LinkupResearchControls, LinkupResearchResponse,
  LinkupSearchControls, LinkupSearchResponse, LinkupSourcedAnswerControls,
  LinkupSourcedAnswerResponse, LinkupStructuredResponse, OpContext, SearchIntent, SearchResult, Source,
} from "../types.ts";

type FetchLike = typeof fetch;

const BASE_URL = "https://api.linkup.so/v1";
// Honest identifier; never impersonate the donor package's pi-linkup user agent.
const USER_AGENT = "jeito-websift/0.1.0 (@alehdezp/websift)";
const LINKUP_DEPTHS = new Set(["fast", "standard", "deep"]);

function assertDepth(depth: string): void {
  if (!LINKUP_DEPTHS.has(depth)) throw new ProviderError("invalid_input", "Linkup depth must be fast, standard, or deep");
}

async function requestLinkup(
  endpoint: string,
  method: "GET" | "POST",
  body: Record<string, unknown> | undefined,
  ctx: OpContext,
  fetchImpl: FetchLike,
): Promise<unknown> {
  if (!ctx.credential) throw new ProviderError("missing_credential", "LINKUP_API_KEY is not set");
  if (ctx.signal?.aborted) throw new ProviderError("aborted", "Linkup request aborted");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, ctx.timeoutMs));
  const abort = () => controller.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(`${BASE_URL}${endpoint}`, {
      method,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${ctx.credential}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw classifyHttpFailure(response.status, response.headers.get("retry-after"), errorBody);
    }
    return await response.json();
  } catch (error) {
    throw redactCredential(mapFetchFailure(error, ctx.signal), ctx.credential);
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", abort);
  }
}

function assertSearchResponse(response: unknown): LinkupSearchResponse {
  if (!response || typeof response !== "object" || !Array.isArray((response as { results?: unknown }).results))
    throw new ProviderError("unavailable", "Linkup response shape changed");
  return response as LinkupSearchResponse;
}

function assertSourcedAnswerResponse(response: unknown): LinkupSourcedAnswerResponse {
  if (!response || typeof response !== "object" || typeof (response as { answer?: unknown }).answer !== "string" || !Array.isArray((response as { sources?: unknown }).sources))
    throw new ProviderError("unavailable", "Linkup answer response shape changed");
  return response as LinkupSourcedAnswerResponse;
}

function assertFetchResponse(response: unknown): LinkupFetchResponse {
  if (!response || typeof response !== "object" || typeof (response as { markdown?: unknown }).markdown !== "string")
    throw new ProviderError("unavailable", "Linkup fetch response shape changed");
  return response as LinkupFetchResponse;
}

function assertBalanceResponse(response: unknown): LinkupBalanceResponse {
  if (!response || typeof response !== "object" || typeof (response as { balance?: unknown }).balance !== "number" || !Number.isFinite((response as { balance: number }).balance))
    throw new ProviderError("unavailable", "Linkup balance response shape changed");
  return response as LinkupBalanceResponse;
}

function assertLinkupFilters(controls: Pick<LinkupSearchControls, "includeDomains" | "excludeDomains" | "fromDate" | "toDate">): void {
  if ((controls.includeDomains?.length ?? 0) > 100) throw new ProviderError("invalid_input", "Linkup includeDomains accepts at most 100 domains");
  for (const [field, value] of [["fromDate", controls.fromDate], ["toDate", controls.toDate]] as const)
    if (value !== undefined && !isValidCalendarDate(value)) throw new ProviderError("invalid_input", `Linkup ${field} must be a valid YYYY-MM-DD date`);
  if (controls.fromDate && controls.toDate && controls.fromDate >= controls.toDate) throw new ProviderError("invalid_input", "Linkup fromDate must be before toDate; equal bounds are not accepted");
}

function searchBody(controls: LinkupSearchControls, outputType: "searchResults" | "sourcedAnswer" | "structured"): Record<string, unknown> {
  assertLinkupFilters(controls);
  const body: Record<string, unknown> = {
    q: controls.query, depth: controls.depth, outputType,
    includeDomains: controls.includeDomains, excludeDomains: controls.excludeDomains,
    fromDate: controls.fromDate, toDate: controls.toDate,
    includeImages: controls.includeImages,
  };
  if (controls.maxResults !== undefined) body.maxResults = controls.maxResults;
  if (outputType === "sourcedAnswer") body.includeInlineCitations = controls.includeInlineCitations;
  if (outputType === "structured") {
    if (!controls.structuredOutputSchema) throw new ProviderError("invalid_input", "Linkup structured output requires structuredOutputSchema");
    body.structuredOutputSchema = JSON.stringify(controls.structuredOutputSchema);
    body.includeSources = controls.includeSources ?? false;
  }
  return body;
}

// --- Focused provider operations (internal; for comparison/maintenance code) ---

export async function linkupSearch(controls: LinkupSearchControls, ctx: OpContext, fetchImpl: FetchLike = fetch): Promise<LinkupSearchResponse> {
  if (!controls.query.trim()) throw new ProviderError("invalid_input", "Linkup search query is empty");
  assertDepth(controls.depth);
  if (controls.maxResults !== undefined && (!Number.isSafeInteger(controls.maxResults) || controls.maxResults < 1))
    throw new ProviderError("invalid_input", "maxResults must be a positive safe integer");
  return assertSearchResponse(await requestLinkup("/search", "POST", searchBody(controls, "searchResults"), ctx, fetchImpl));
}

export async function linkupSourcedAnswer(controls: LinkupSourcedAnswerControls, ctx: OpContext, fetchImpl: FetchLike = fetch): Promise<LinkupSourcedAnswerResponse> {
  if (!controls.query.trim()) throw new ProviderError("invalid_input", "Linkup answer query is empty");
  assertDepth(controls.depth);
  return assertSourcedAnswerResponse(await requestLinkup("/search", "POST", searchBody(controls, "sourcedAnswer"), ctx, fetchImpl));
}

export async function linkupStructuredSearch(controls: LinkupSearchControls, ctx: OpContext, fetchImpl: FetchLike = fetch): Promise<LinkupStructuredResponse> {
  if (!controls.query.trim()) throw new ProviderError("invalid_input", "Linkup structured query is empty");
  assertDepth(controls.depth);
  const response = await requestLinkup("/search", "POST", searchBody(controls, "structured"), ctx, fetchImpl);
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new ProviderError("unavailable", "Linkup structured response shape changed");
  return response as LinkupStructuredResponse;
}

export async function linkupFetch(controls: LinkupFetchControls, ctx: OpContext, fetchImpl: FetchLike = fetch): Promise<LinkupFetchResponse> {
  let parsed: URL;
  try { parsed = new URL(controls.url); } catch { throw new ProviderError("invalid_input", "Linkup fetch URL is invalid"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new ProviderError("invalid_input", "Linkup fetch supports HTTP(S) URLs only");
  if (typeof controls.renderJs !== "boolean") throw new ProviderError("invalid_input", "renderJs must be boolean");
  return assertFetchResponse(await requestLinkup("/fetch", "POST", { url: controls.url, renderJs: controls.renderJs, includeRawContent: controls.includeRawContent, extractImages: controls.extractImages }, ctx, fetchImpl));
}

// Internal maintenance capability. Deliberately not a registered model tool and never
// invoked by startup or doctor; only the user's explicit /web-setup usage check calls it.
export async function linkupGetBalance(ctx: OpContext, fetchImpl: FetchLike = fetch): Promise<LinkupBalanceResponse> {
  return assertBalanceResponse(await requestLinkup("/credits/balance", "GET", undefined, ctx, fetchImpl));
}

function assertResearchResponse(response: unknown): LinkupResearchResponse {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new ProviderError("unavailable", "Linkup research response shape changed");
  const raw = response as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id || typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string" ||
      !raw.input || typeof raw.input !== "object" || Array.isArray(raw.input) || !["pending", "processing", "completed", "failed"].includes(String(raw.status)) ||
      !(raw.error === null || typeof raw.error === "string")) throw new ProviderError("unavailable", "Linkup research response shape changed");
  if (raw.status === "completed") {
    if (!raw.output || typeof raw.output !== "object" || Array.isArray(raw.output)) throw new ProviderError("unavailable", "Linkup research output shape changed");
    const output = raw.output as Record<string, unknown>;
    if (!(typeof output.answer === "string" || "data" in output) || !Array.isArray(output.sources) || output.sources.some((source) =>
      !source || typeof source !== "object" || Array.isArray(source) || typeof (source as Record<string, unknown>).name !== "string" || typeof (source as Record<string, unknown>).url !== "string"))
      throw new ProviderError("unavailable", "Linkup research output shape changed");
  }
  return raw as unknown as LinkupResearchResponse;
}

export async function runLinkupResearch(controls: LinkupResearchControls, ctx: OpContext, fetchImpl: FetchLike = fetch): Promise<LinkupResearchResponse> {
  if (!controls.query.trim()) throw new ProviderError("invalid_input", "Linkup research query is empty");
  if (!Number.isFinite(controls.maxWaitMs) || controls.maxWaitMs <= 0) throw new ProviderError("invalid_input", "Linkup research maxWaitMs must be positive");
  assertLinkupFilters(controls);
  let current = assertResearchResponse(await requestLinkup("/research", "POST", {
    q: controls.query, outputType: controls.outputType, mode: controls.mode,
    reasoningDepth: controls.reasoningDepth, includeDomains: controls.includeDomains,
    excludeDomains: controls.excludeDomains, fromDate: controls.fromDate, toDate: controls.toDate,
    structuredOutputSchema: controls.structuredOutputSchema,
  }, ctx, fetchImpl));
  const deadline = Date.now() + controls.maxWaitMs;
  let interval = Math.max(1000, controls.pollIntervalMs ?? 2000);
  while (current.status === "pending" || current.status === "processing") {
    if (Date.now() >= deadline) throw new ProviderError("timeout", `Linkup research did not finish within ${controls.maxWaitMs}ms`);
    await new Promise<void>((resolve, reject) => {
      if (ctx.signal?.aborted) return reject(new ProviderError("aborted", "Linkup request aborted"));
      const onAbort = () => { clearTimeout(timer); reject(new ProviderError("aborted", "Linkup request aborted")); };
      const timer = setTimeout(() => { ctx.signal?.removeEventListener("abort", onAbort); resolve(); }, Math.min(interval, Math.max(0, deadline - Date.now())));
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
    });
    current = assertResearchResponse(await requestLinkup(`/research/${encodeURIComponent(current.id)}`, "GET", undefined, ctx, fetchImpl));
    interval = Math.min(10_000, interval * 2);
  }
  return current;
}

// --- Public normalization (provider metadata → normalized evidence) ---

export function normalizeLinkupSearch(response: LinkupSearchResponse): SearchResult[] {
  const results = response.results.flatMap((item) => item && typeof item === "object" && typeof item.name === "string" && typeof item.url === "string"
    ? [{ title: item.name, url: item.url, snippet: typeof item.content === "string" ? item.content : "", sourceType: "organic" }]
    : []);
  // A provider-valid empty result list is a scoped zero; rows present but all malformed is a changed shape.
  if (!results.length && response.results.length > 0) throw new ProviderError("unavailable", "Linkup result row shape changed");
  return results;
}

export function normalizeLinkupSourcedAnswer(response: LinkupSourcedAnswerResponse): AnswerResult {
  const sources: Source[] = response.sources.flatMap((item) => typeof item === "object" && item && typeof item.url === "string"
    ? [{ url: item.url, title: typeof item.name === "string" ? item.name : item.url, passage: typeof item.snippet === "string" ? item.snippet : undefined, fetched: false, evidenceStatus: "provider-citation" as const, provider: "linkup" }]
    : []);
  if (response.sources.length > 0 && sources.length === 0) throw new ProviderError("unavailable", "Linkup answer source row shape changed");
  return { answer: response.answer, sources, model: "linkup", nativeResult: response };
}

export function normalizeLinkupFetch(url: string, response: LinkupFetchResponse, preferRaw = false): FetchedContent[] {
  return [{ url, title: url, content: preferRaw && response.rawContent ? response.rawContent : response.markdown, contentType: preferRaw ? response.contentType : "text/markdown" }];
}

export function createLinkupAdapter(fetchImpl: FetchLike = fetch): Adapter {
  return {
    capability: {
      id: "linkup", operations: ["search", "fetch", "answer"], credentials: ["LINKUP_API_KEY"],
      strengths: ["general"], modes: ["page"], returns: ["leads", "content", "answers"], filters: ["domains", "recency"],
      timeoutMs: 20_000, concurrency: 3, fallbackEligible: true,
      provenance: "docs/upstreams/linkup.md",
    },
    async search(intent: SearchIntent, ctx: OpContext): Promise<SearchResult[]> {
      return normalizeLinkupSearch(await linkupSearch({ query: intent.query, depth: intent.depth, maxResults: intent.count, includeDomains: intent.domains?.include, excludeDomains: intent.domains?.exclude, fromDate: intent.recency?.from, toDate: intent.recency?.to }, ctx, fetchImpl));
    },
    async answer(intent: AnswerIntent, ctx: OpContext): Promise<AnswerResult> {
      const controls = intent.linkup;
      return normalizeLinkupSourcedAnswer(await linkupSourcedAnswer({
        query: intent.question,
        depth: controls?.depth ?? "standard",
        includeDomains: controls?.includeDomains,
        excludeDomains: controls?.excludeDomains,
        fromDate: controls?.fromDate,
        toDate: controls?.toDate,
        includeInlineCitations: controls?.includeInlineCitations ?? true,
      }, ctx, fetchImpl));
    },
    async fetch(intent: FetchIntent, ctx: OpContext): Promise<FetchedContent[]> {
      if (intent.mode !== "page") throw new ProviderError("policy", "Linkup fetch supports page mode only");
      if (intent.urls && intent.urls.length > 1) throw new ProviderError("policy", "Linkup fetch supports a single URL only");
      const url = intent.url ?? intent.urls?.[0];
      if (!url) throw new ProviderError("invalid_input", "Linkup fetch requires a URL");
      const renderJs = intent.linkup?.renderJs;
      if (typeof renderJs !== "boolean") throw new ProviderError("invalid_input", "linkup.renderJs is required and must be boolean");
      const preferRaw = intent.extract === "raw";
      return normalizeLinkupFetch(url, await linkupFetch({ url, renderJs, includeRawContent: preferRaw }, ctx, fetchImpl), preferRaw);
    },
  };
}
