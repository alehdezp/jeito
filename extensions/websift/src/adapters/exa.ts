// ADR-005.001: provider capability policy owns this adapter's contract surface; see docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md.
// Contract grounded in installed exa-js 2.16.3 plus @capyup/pi-exa@0.5.1 — see docs/upstreams/exa.md.
import { Exa } from "exa-js";
import { mapFetchFailure, ProviderError } from "../failures.ts";
import type { Adapter, AnswerIntent, AnswerResult, ExaSearchEnvelope, FetchedContent, OpContext, SearchIntent, SearchResult, SearchResultList, Source } from "../types.ts";

export type ExaClient = {
  search(query: string, options: Record<string, unknown>): Promise<unknown>;
  answer(question: string, options: Record<string, unknown>): Promise<unknown>;
  getContents?(urls: string[], options: Record<string, unknown>): Promise<unknown>;
  findSimilar?(url: string, options: Record<string, unknown>): Promise<unknown>;
  research?: {
    create(params: Record<string, unknown>): Promise<unknown>;
    pollUntilFinished(id: string, options: { timeoutMs?: number }): Promise<unknown>;
  };
};
type ClientFactory = (apiKey: string) => ExaClient;

export type ExaContentSection = "unspecified" | "header" | "navigation" | "banner" | "body" | "sidebar" | "footer" | "metadata";

export interface ExaContentsRequest {
  urls: string[];
  mode?: "text" | "summary" | "highlights";
  query?: string;
  maxCharacters?: number;
  maxAgeHours?: number;
  livecrawlTimeout?: number;
  filterEmptyResults?: boolean;
  subpages?: number;
  subpageTarget?: string | string[];
  extras?: { links?: number; imageLinks?: number };
  textOptions?: { includeHtmlTags?: boolean; verbosity?: "compact" | "standard" | "full"; includeSections?: ExaContentSection[]; excludeSections?: ExaContentSection[] };
}

export interface ExaContentsStatus {
  id: string;
  status: string;
  source?: string;
  errorTag?: string;
  httpStatusCode?: number;
}

export interface ExaContentsResult {
  values: FetchedContent[];
  statuses: ExaContentsStatus[];
  cost?: { total: number; text?: number; highlights?: number; summary?: number };
}

export interface ExaSimilarRequest {
  url: string;
  count?: number;
  excludeSourceDomain?: boolean;
  returnFullText?: boolean;
  maxCharacters?: number;
}

export interface ExaResearchRequest {
  instructions: string;
  model?: "exa-research-fast" | "exa-research" | "exa-research-pro";
  outputSchema?: Record<string, unknown>;
  maxWaitMs?: number;
}

export interface ExaResearchResult extends Record<string, unknown> {
  id: string;
  status: string;
}

function exaFailure(error: unknown, outerSignal?: AbortSignal): ProviderError {
  const mapped = mapFetchFailure(error, outerSignal);
  if (mapped.failureClass !== "network") return mapped;
  const status = typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode: unknown }).statusCode) : undefined;
  if (status === 401 || status === 403) return new ProviderError("auth", `Exa rejected credentials (${status})`);
  if (status === 429) return new ProviderError("rate_limited", "Exa rate limited the request");
  if (status && status >= 400 && status < 500) {
    const message = error instanceof Error ? error.message : "";
    if (/credit|quota|billing|balance/i.test(message)) return new ProviderError("quota", `Exa rejected the request: ${message.slice(0, 200)} (${status})`);
  }
  if (status && status >= 500) return new ProviderError("network", `Exa request failed (${status})`);
  return mapped;
}

export function normalizeExaSearch(response: unknown, kind: SearchIntent["kind"]): SearchResult[] {
  if (!response || typeof response !== "object" || !("results" in response) || !Array.isArray((response as { results: unknown }).results)) throw new ProviderError("unavailable", "Exa response shape changed");
  const rows = (response as { results: Record<string, unknown>[] }).results;
  if (!rows.length) return [];
  const results = rows.flatMap((item) => {
    if (!item || typeof item !== "object" || typeof item.title !== "string" || typeof item.url !== "string") return [];
    const highlights = Array.isArray(item.highlights) ? item.highlights.filter((value): value is string => typeof value === "string") : [];
    return [{ title: item.title, url: item.url, snippet: highlights.join(" … ") || (typeof item.text === "string" ? item.text.slice(0, 1000) : ""), publishedAt: typeof item.publishedDate === "string" ? item.publishedDate : undefined, score: typeof item.score === "number" ? item.score : undefined, sourceType: kind === "academic" ? "academic" : kind === "code" ? "code" : "organic" }];
  });
  if (!results.length) throw new ProviderError("unavailable", "Exa result row shape changed");
  return results;
}

type ExaAdjudication = NonNullable<ExaSearchEnvelope["adjudication"]>;

// Domain controls accept hostname, `*.subdomain`, and `hostname/path` forms. A control with any
// unsupported shape disables local enforcement of its whole list (the provider still enforces it,
// but a partial local filter would over-reject). Dates use inclusive bounds and are enforced only
// when both the bound and the row's publishedAt parse; anything else is reported unverifiable.
function parseDomainControl(control: string): { hostname: string; path?: string; wildcardOnly?: boolean } | undefined {
  let value = control.trim().toLowerCase();
  if (!value) return undefined;
  const scheme = value.match(/^[a-z][a-z0-9+.-]*:\/\//);
  if (scheme) value = value.slice(scheme[0].length);
  if (value.includes("*") && !value.startsWith("*.")) return undefined;
  const wildcardOnly = value.startsWith("*.");
  if (wildcardOnly) value = value.slice(2);
  if (!value || value.includes("/")) {
    const slash = value.indexOf("/");
    const hostname = value.slice(0, slash);
    const path = slash >= 0 ? value.slice(slash) : undefined;
    if (!hostname || !hostname.includes(".") || (path && !path.startsWith("/"))) return undefined;
    return { hostname, path };
  }
  if (!value.includes(".")) return undefined;
  return { hostname: value, wildcardOnly };
}

function domainMatches(hostname: string, control: { hostname: string; path?: string; wildcardOnly?: boolean }, url: URL): boolean {
  const subdomainMatch = hostname === control.hostname || hostname.endsWith(`.${control.hostname}`);
  const hostMatches = control.wildcardOnly ? hostname.endsWith(`.${control.hostname}`) : subdomainMatch;
  return hostMatches && (!control.path || url.pathname === control.path || url.pathname.startsWith(`${control.path}/`));
}

/** Locally observable Exa hard-filter adjudication. Only URL/domain and parseable publication dates
 *  are enforced; text filters and category are reported as not enforced because normalized rows hold
 *  bounded highlights/excerpts, not full page text. Zero qualifying rows are a scoped zero outcome. */
export function adjudicateExaRows(
  results: SearchResult[],
  intent: Pick<SearchIntent, "domains" | "recency" | "exa">,
  providerCount: number,
): { qualifying: SearchResult[]; verdict: ExaAdjudication } | undefined {
  const include = intent.domains?.include ?? [];
  const exclude = intent.domains?.exclude ?? [];
  const start = intent.recency?.from;
  const end = intent.recency?.to;
  if (!include.length && !exclude.length && !start && !end) return undefined;
  const enforced: string[] = [];
  const notEnforced: string[] = [];
  if (intent.exa?.includeText || intent.exa?.excludeText) {
    notEnforced.push("includeText/excludeText (full page text not retained in normalized rows)");
  }
  if (intent.exa?.category) notEnforced.push("category (provider focus hint, not a result class)");

  const includeControls = include.map(parseDomainControl);
  const excludeControls = exclude.map(parseDomainControl);
  const enforceIncludeDomains = include.length > 0 && includeControls.every((control) => control !== undefined);
  const enforceExcludeDomains = exclude.length > 0 && excludeControls.every((control) => control !== undefined);
  if (include.length && !enforceIncludeDomains) {
    notEnforced.push(`includeDomains (unsupported control shape: ${include.find((_, index) => includeControls[index] === undefined)})`);
  } else if (enforceIncludeDomains) {
    enforced.push("includeDomains");
  }
  if (exclude.length && !enforceExcludeDomains) {
    notEnforced.push(`excludeDomains (unsupported control shape: ${exclude.find((_, index) => excludeControls[index] === undefined)})`);
  } else if (enforceExcludeDomains) {
    enforced.push("excludeDomains");
  }

  const startMs = start ? Date.parse(start) : undefined;
  const endMs = end ? Date.parse(end) : undefined;
  if (start) {
    if (Number.isNaN(startMs)) notEnforced.push(`startPublishedDate (unparseable bound "${start}")`);
    else enforced.push("startPublishedDate");
  }
  if (end) {
    if (Number.isNaN(endMs)) notEnforced.push(`endPublishedDate (unparseable bound "${end}")`);
    else enforced.push("endPublishedDate");
  }
  const dateEnforced = (start && !Number.isNaN(startMs)) || (end && !Number.isNaN(endMs));

  const domainOk = (url: string): "ok" | "unverifiable" | string => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return "unverifiable"; }
    const hostname = parsed.hostname.toLowerCase();
    if (enforceExcludeDomains && excludeControls.some((control) => domainMatches(hostname, control!, parsed))) return `domain in excludeDomains (${hostname})`;
    if (enforceIncludeDomains && !includeControls.some((control) => domainMatches(hostname, control!, parsed))) return `domain not in includeDomains (${hostname})`;
    return "ok";
  };

  const rejected = new Map<string, number>();
  let unverifiableCount = 0;
  const qualifying: SearchResult[] = [];
  const reject = (reason: string): void => { rejected.set(reason, (rejected.get(reason) ?? 0) + 1); };
  for (const result of results) {
    const domain = domainOk(result.url);
    if (domain === "unverifiable") { unverifiableCount += 1; continue; }
    if (domain !== "ok") { reject(domain); continue; }
    if (dateEnforced) {
      const publishedDate = result.publishedAt ? new Date(result.publishedAt) : undefined;
      if (!publishedDate || Number.isNaN(publishedDate.valueOf())) { unverifiableCount += 1; continue; }
      const publishedDay = publishedDate.toISOString().slice(0, 10);
      if (start && startMs !== undefined && !Number.isNaN(startMs) && publishedDay < start) { reject("published before startPublishedDate"); continue; }
      if (end && endMs !== undefined && !Number.isNaN(endMs) && publishedDay > end) { reject("published after endPublishedDate"); continue; }
    }
    qualifying.push(result);
  }
  return {
    qualifying,
    verdict: {
      providerCount,
      qualifyingCount: qualifying.length,
      unverifiableCount,
      rejected: [...rejected.entries()].map(([reason, count]) => ({ reason, count })),
      enforced,
      notEnforced,
    },
  };
}

function exaSearchEnvelope(response: unknown): ExaSearchEnvelope | undefined {
  if (!response || typeof response !== "object") return undefined;
  const costDollars = (response as { costDollars?: unknown }).costDollars;
  if (!costDollars || typeof costDollars !== "object") return undefined;
  const total = (costDollars as { total?: unknown }).total;
  return typeof total === "number" && Number.isFinite(total) ? { reportedCostUsd: total } : undefined;
}

function exaContent(response: unknown, mode: ExaContentsRequest["mode"] = "text"): ExaContentsResult {
  if (!response || typeof response !== "object" || !Array.isArray((response as { results?: unknown }).results)) throw new ProviderError("unavailable", "Exa content response shape changed");
  const body = response as { results: Record<string, unknown>[]; statuses?: unknown; costDollars?: unknown };
  if (body.statuses !== undefined && !Array.isArray(body.statuses)) throw new ProviderError("unavailable", "Exa content status shape changed");
  const statuses = (body.statuses ?? []).map((value): ExaContentsStatus => {
    if (!value || typeof value !== "object") throw new ProviderError("unavailable", "Exa content status shape changed");
    const status = value as Record<string, unknown>;
    if (typeof status.id !== "string" || typeof status.status !== "string") throw new ProviderError("unavailable", "Exa content status shape changed");
    const error = status.error && typeof status.error === "object" ? status.error as Record<string, unknown> : undefined;
    return { id: status.id, status: status.status, source: typeof status.source === "string" ? status.source : undefined, errorTag: typeof error?.tag === "string" ? error.tag : undefined, httpStatusCode: Number.isFinite(error?.httpStatusCode) ? Number(error?.httpStatusCode) : undefined };
  });
  const values = body.results.flatMap((item) => {
    if (typeof item.url !== "string") return [];
    const highlights = Array.isArray(item.highlights) ? item.highlights.filter((value): value is string => typeof value === "string").join("\n") : "";
    const content = mode === "summary" && typeof item.summary === "string" ? item.summary : mode === "highlights" ? highlights : typeof item.text === "string" ? item.text : highlights;
    return content ? [{ url: item.url, title: typeof item.title === "string" ? item.title : item.url, content }] : [];
  });
  if (!values.length && !statuses.length) throw new ProviderError("empty", "Exa returned no content or per-URL statuses");
  const dollars = body.costDollars && typeof body.costDollars === "object" ? body.costDollars as Record<string, unknown> : undefined;
  const contents = dollars?.contents && typeof dollars.contents === "object" ? dollars.contents as Record<string, unknown> : undefined;
  const cost = Number.isFinite(dollars?.total) ? { total: Number(dollars?.total), text: Number.isFinite(contents?.text) ? Number(contents?.text) : undefined, highlights: Number.isFinite(contents?.highlights) ? Number(contents?.highlights) : undefined, summary: Number.isFinite(contents?.summary) ? Number(contents?.summary) : undefined } : undefined;
  return { values, statuses, cost };
}

export async function fetchExaContents(client: ExaClient, request: ExaContentsRequest, signal?: AbortSignal): Promise<ExaContentsResult> {
  if (!client.getContents) throw new ProviderError("unavailable", "Installed Exa client does not support getContents");
  if (!request.urls.length) throw new ProviderError("invalid_input", "Exa contents requires at least one URL");
  const mode = request.mode ?? "text";
  if (mode === "text" && request.query) throw new ProviderError("invalid_input", "Exa contents query requires highlights or summary mode");
  if (mode !== "text" && request.textOptions) throw new ProviderError("invalid_input", "Exa textOptions require text mode");
  const structureAwareText = request.textOptions?.verbosity !== undefined || Boolean(request.textOptions?.includeSections?.length) || Boolean(request.textOptions?.excludeSections?.length);
  if (structureAwareText && request.maxAgeHours !== undefined && request.maxAgeHours !== 0) throw new ProviderError("invalid_input", "Exa structure-aware text controls require maxAgeHours: 0");
  const content = mode === "summary"
    ? { summary: request.query ? { query: request.query } : true }
    : mode === "highlights"
      ? { highlights: request.query || request.maxCharacters !== undefined ? { query: request.query, maxCharacters: request.maxCharacters } : true }
      : { text: { maxCharacters: request.maxCharacters ?? 5000, ...request.textOptions } };
  try {
    const response = await client.getContents(request.urls, { ...content, maxAgeHours: structureAwareText ? 0 : request.maxAgeHours, livecrawlTimeout: request.livecrawlTimeout, filterEmptyResults: request.filterEmptyResults, subpages: request.subpages, subpageTarget: request.subpageTarget, extras: request.extras });
    if (signal?.aborted) throw new ProviderError("aborted", "Exa content request aborted");
    return exaContent(response, mode);
  } catch (error) { throw exaFailure(error, signal); }
}

/** @deprecated exa-js marks URL-based similarity for removal with no direct replacement. Keep only for compatibility comparison; do not expose publicly. */
export async function findSimilarWithExa(client: ExaClient, request: ExaSimilarRequest, signal?: AbortSignal): Promise<SearchResult[]> {
  if (!client.findSimilar) throw new ProviderError("unavailable", "Installed Exa client does not support findSimilar");
  try {
    const response = await client.findSimilar(request.url, { numResults: request.count ?? 5, excludeSourceDomain: request.excludeSourceDomain, contents: request.returnFullText || request.maxCharacters !== undefined ? { text: { maxCharacters: request.maxCharacters ?? 5000 } } : { highlights: true } });
    if (signal?.aborted) throw new ProviderError("aborted", "Exa similar request aborted");
    return normalizeExaSearch(response, "general");
  } catch (error) { throw exaFailure(error, signal); }
}

export async function runExaResearch(client: ExaClient, request: ExaResearchRequest, signal?: AbortSignal): Promise<ExaResearchResult> {
  if (!client.research) throw new ProviderError("unavailable", "Installed Exa client does not support research jobs");
  try {
    const created = await client.research.create({ instructions: request.instructions, model: request.model, outputSchema: request.outputSchema }) as Record<string, unknown>;
    if (typeof created.id !== "string") throw new ProviderError("unavailable", "Exa research creation response shape changed");
    if (signal?.aborted) throw new ProviderError("aborted", "Exa research request aborted");
    const completed = await client.research.pollUntilFinished(created.id, { timeoutMs: request.maxWaitMs }) as Record<string, unknown>;
    if (typeof completed.status !== "string") throw new ProviderError("unavailable", "Exa research completion response shape changed");
    return { ...completed, id: created.id, status: completed.status };
  } catch (error) { throw exaFailure(error, signal); }
}

export function createExaAdapter(clientFactory: ClientFactory = (apiKey) => new Exa(apiKey) as unknown as ExaClient): Adapter {
  return {
    capability: {
      id: "exa", operations: ["search", "answer"], credentials: ["EXA_API_KEY"], strengths: ["general", "academic", "code"],
      returns: ["leads", "answers"], filters: ["recency", "domains"], timeoutMs: 20_000, concurrency: 3,
      fallbackEligible: true, provenance: "docs/upstreams/exa.md",
    },
    async search(intent: SearchIntent, ctx: OpContext): Promise<SearchResultList> {
      if (!ctx.credential) throw new ProviderError("missing_credential", "EXA_API_KEY is not set");
      if (ctx.signal?.aborted) throw new ProviderError("aborted", "Exa search aborted");
      try {
        const exa = intent.exa;
        const searchType = exa?.searchType ?? (intent.depth === "deep" ? "deep" : "auto");
        if (exa?.additionalQueries?.length && !["deep-lite", "deep", "deep-reasoning"].includes(searchType)) throw new ProviderError("invalid_input", "Exa additionalQueries require a deep searchType");
        const startPublishedDate = intent.recency?.from ?? (exa?.publishedWithinDays ? new Date(Date.now() - exa.publishedWithinDays * 86_400_000).toISOString().slice(0, 10) : undefined);
        const fullText = exa?.returnFullText || exa?.maxCharacters !== undefined;
        const response = await clientFactory(ctx.credential).search(intent.query, {
          type: searchType, numResults: intent.count,
          includeDomains: intent.domains?.include, excludeDomains: intent.domains?.exclude,
          startPublishedDate, endPublishedDate: intent.recency?.to,
          category: exa?.category, includeText: exa?.includeText ? [exa.includeText] : undefined,
          excludeText: exa?.excludeText ? [exa.excludeText] : undefined, userLocation: exa?.userLocation,
          moderation: exa?.moderation, systemPrompt: exa?.systemPrompt, additionalQueries: exa?.additionalQueries, flags: exa?.flags, outputSchema: exa?.outputSchema,
          contents: fullText ? { text: { maxCharacters: exa?.maxCharacters ?? 5000 } } : { highlights: true },
        });
        if (ctx.signal?.aborted) throw new ProviderError("aborted", "Exa search aborted");
        const results = normalizeExaSearch(response, intent.kind);
        const providerCount = Array.isArray((response as { results?: unknown }).results) ? (response as { results: unknown[] }).results.length : results.length;
        const adjudicated = adjudicateExaRows(results, { ...intent, recency: { ...intent.recency, from: startPublishedDate } }, providerCount);
        const rows = adjudicated?.qualifying ?? results;
        const cost = exaSearchEnvelope(response);
        const envelope: ExaSearchEnvelope | undefined = cost || adjudicated
          ? { ...(cost?.reportedCostUsd !== undefined ? { reportedCostUsd: cost.reportedCostUsd } : {}), ...(adjudicated ? { adjudication: adjudicated.verdict } : {}) }
          : undefined;
        const list = rows as SearchResultList;
        if (envelope) {
          if (list[0]) list[0] = { ...list[0], exa: envelope };
          else list.exa = envelope;
        }
        return list;
      } catch (error) { throw exaFailure(error, ctx.signal); }
    },
    async answer(intent: AnswerIntent, ctx: OpContext): Promise<AnswerResult> {
      if (!ctx.credential) throw new ProviderError("missing_credential", "EXA_API_KEY is not set");
      try {
        const response = await clientFactory(ctx.credential).answer(intent.question, { text: intent.exa?.text ?? false, userLocation: intent.exa?.userLocation, systemPrompt: intent.exa?.systemPrompt, outputSchema: intent.exa?.outputSchema }) as { answer?: unknown; citations?: unknown; costDollars?: { total?: unknown } };
        if (response.citations !== undefined && !Array.isArray(response.citations)) throw new ProviderError("unavailable", "Exa answer citation shape changed");
        if (typeof response.answer !== "string" && (!response.answer || typeof response.answer !== "object")) throw new ProviderError("unavailable", "Exa answer response shape changed");
        const citations = response.citations ?? [];
        const sources: Source[] = citations.flatMap((item) => typeof item === "object" && item && typeof (item as { url?: unknown }).url === "string" ? [{ url: (item as { url: string }).url, title: typeof (item as { title?: unknown }).title === "string" ? (item as { title: string }).title : (item as { url: string }).url, passage: typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text.slice(0, 500) : undefined, fetched: false, evidenceStatus: "provider-citation" as const, provider: "exa" }] : []);
        if (citations.length > 0 && sources.length === 0) throw new ProviderError("unavailable", "Exa answer citation row shape changed");
        const reportedCostUsd = typeof response.costDollars?.total === "number" && Number.isFinite(response.costDollars.total) ? response.costDollars.total : undefined;
        const structuredData = typeof response.answer === "object" ? response.answer : undefined;
        return { answer: typeof response.answer === "string" ? response.answer : "", sources, model: "exa", reportedCostUsd, structuredData, nativeResult: response };
      } catch (error) { throw exaFailure(error, ctx.signal); }
    },
  };
}