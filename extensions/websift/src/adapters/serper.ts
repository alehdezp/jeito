// ADR-005.001: provider capability policy owns this adapter's contract surface; see docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md.
// Current Serper platform contract grounded in the first-party adapter plus the official 2026-08-01
// playground/billing bundles and focused live calls; see docs/upstreams/serper.md. The public adapter
// remains general Search, while specialist endpoints stay callable through serperOperation until a
// recurring agent task justifies public mapping. All search-like output remains lead-only.
import { classifyHttpFailure, mapFetchFailure, ProviderError, redactCredential } from "../failures.ts";
import type { Adapter, OpContext, SearchIntent, SearchResult, SearchResultList, SerperEnvelope, SerperFull } from "../types.ts";

type FetchLike = typeof fetch;

const SEARCH_URL = "https://google.serper.dev/search";
const DEFAULT_NUM = 10;
const MAX_NUM = 10;
const CANDIDATE_STRING_CAP = 400;
const CANDIDATE_ARRAY_CAP = 10;
const CANDIDATE_DEPTH_CAP = 3;
// Grounded locale token: a 2-3 letter base with an optional region subtag (e.g. us, en, pt-br, zh-cn).
const LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

function clampNum(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_NUM;
  return Math.max(1, Math.min(MAX_NUM, Math.floor(value)));
}

// Trim + lowercase a locale code (these codes are case-insensitive on the wire). A blank value supplied
// explicitly is invalid; a rewrite (trim/case) surfaces a visible warning rather than a silent change.
function normalizeLocale(value: string | undefined, field: string, warnings: string[]): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new ProviderError("invalid_input", `Serper ${field} must not be blank when supplied`);
  const normalized = trimmed.toLowerCase();
  if (!LOCALE_PATTERN.test(normalized)) throw new ProviderError("invalid_input", `Serper ${field} must be a locale code like "us" or "pt-br"`);
  if (normalized !== value) warnings.push(`Serper ${field} normalized "${value}" -> "${normalized}"`);
  return normalized;
}

const QUERY_ENDPOINTS = ["search", "images", "videos", "places", "news", "shopping", "scholar", "patents"] as const;
type SerperQueryEndpoint = typeof QUERY_ENDPOINTS[number];
type SerperQueryControls = { endpoint: SerperQueryEndpoint; query: string; count?: number; location?: string; country?: string; language?: string; autocorrect?: boolean; tbs?: string; page?: number };
export type SerperOperationControls = SerperQueryControls
  | { endpoint: "autocomplete"; query: string; location?: string; country?: string; language?: string }
  | { endpoint: "maps"; query?: string; language?: string; ll?: string; placeId?: string; cid?: string; page?: number }
  | { endpoint: "reviews"; cid?: string; fid?: string; placeId?: string; country?: string; language?: string; sortBy?: string; topicId?: string; nextPageToken?: string }
  | { endpoint: "lens"; url: string; location?: string; country?: string; language?: string; tbs?: string }
  | { endpoint: "webpage"; url: string; includeMarkdown?: boolean; includeImages?: boolean; includeLinks?: boolean; includeVideos?: boolean };
export type SerperOperationResult = { endpoint: SerperOperationControls["endpoint"]; data: Record<string, unknown>; credits: number; warnings: string[] };

async function requestSerperJson(url: string, body: Record<string, unknown>, ctx: OpContext, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  if (ctx.signal?.aborted) throw new ProviderError("aborted", "Serper request aborted");
  if (!ctx.credential) throw new ProviderError("missing_credential", "SERPER_API_KEY is not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, ctx.timeoutMs));
  const abort = () => controller.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener("abort", abort, { once: true });
  let raw: string;
  try {
    const response = await fetchImpl(url, { method: "POST", headers: { "X-API-KEY": ctx.credential, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw classifyHttpFailure(response.status, response.headers.get("retry-after"), errorBody);
    }
    raw = await response.text();
  } catch (error) {
    throw redactCredential(mapFetchFailure(error, ctx.signal), ctx.credential);
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", abort);
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("shape");
    return data as Record<string, unknown>;
  } catch {
    throw new ProviderError("unavailable", "Serper response is not valid JSON object");
  }
}

function put(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== "") body[key] = value;
}

/** Current specialist Serper endpoints remain internal until a recurring agent task justifies a
 * public mapping. This boundary preserves the full provider response and reported credit count. */
export async function serperOperation(controls: SerperOperationControls, ctx: OpContext, fetchImpl: FetchLike = fetch): Promise<SerperOperationResult> {
  const warnings: string[] = [];
  const body: Record<string, unknown> = {};
  let expected: string;
  let url = `https://google.serper.dev/${controls.endpoint}`;
  if (QUERY_ENDPOINTS.includes(controls.endpoint as SerperQueryEndpoint)) {
    const queryControls = controls as SerperQueryControls;
    if (!queryControls.query.trim()) throw new ProviderError("invalid_input", `Serper ${controls.endpoint} query must not be blank`);
    if (queryControls.count !== undefined) {
      const valid = controls.endpoint === "images" ? queryControls.count === 10 || queryControls.count === 100
        : controls.endpoint === "shopping" ? queryControls.count === 40
        : controls.endpoint === "scholar" ? false
        : queryControls.count === 10;
      if (!valid) throw new ProviderError("invalid_input", `Serper ${controls.endpoint} count is not supported by the current endpoint contract`);
    }
    put(body, "q", queryControls.query.trim()); put(body, "num", queryControls.count); put(body, "location", queryControls.location);
    put(body, "gl", normalizeLocale(queryControls.country, "country", warnings)); put(body, "hl", normalizeLocale(queryControls.language, "language", warnings));
    put(body, "autocorrect", queryControls.autocorrect); put(body, "tbs", queryControls.tbs); put(body, "page", queryControls.page);
    if (queryControls.page !== undefined && (!Number.isInteger(queryControls.page) || queryControls.page < 1)) throw new ProviderError("invalid_input", `Serper ${controls.endpoint} page must be a positive integer`);
    expected = controls.endpoint === "search" || controls.endpoint === "scholar" || controls.endpoint === "patents" ? "organic" : controls.endpoint;
  } else if (controls.endpoint === "autocomplete") {
    if (!controls.query.trim()) throw new ProviderError("invalid_input", "Serper autocomplete query must not be blank");
    put(body, "q", controls.query.trim()); put(body, "location", controls.location); put(body, "gl", normalizeLocale(controls.country, "country", warnings)); put(body, "hl", normalizeLocale(controls.language, "language", warnings)); expected = "suggestions";
  } else if (controls.endpoint === "maps") {
    if (![controls.query, controls.placeId, controls.cid].some((value) => typeof value === "string" && value.trim())) throw new ProviderError("invalid_input", "Serper maps requires query, placeId, or cid");
    put(body, "q", controls.query?.trim()); put(body, "hl", normalizeLocale(controls.language, "language", warnings)); put(body, "ll", controls.ll); put(body, "placeId", controls.placeId); put(body, "cid", controls.cid); put(body, "page", controls.page); expected = "places";
  } else if (controls.endpoint === "reviews") {
    if (![controls.cid, controls.fid, controls.placeId].some((value) => typeof value === "string" && value.trim())) throw new ProviderError("invalid_input", "Serper reviews requires cid, fid, or placeId");
    put(body, "cid", controls.cid); put(body, "fid", controls.fid); put(body, "placeId", controls.placeId); put(body, "gl", normalizeLocale(controls.country, "country", warnings)); put(body, "hl", normalizeLocale(controls.language, "language", warnings)); put(body, "sortBy", controls.sortBy); put(body, "topicId", controls.topicId); put(body, "nextPageToken", controls.nextPageToken); expected = "reviews";
  } else if (controls.endpoint === "lens") {
    try { const parsed = new URL(controls.url); if (!/^https?:$/.test(parsed.protocol)) throw new Error(); } catch { throw new ProviderError("invalid_input", "Serper lens URL must use HTTP(S)"); }
    put(body, "url", controls.url); put(body, "location", controls.location); put(body, "gl", normalizeLocale(controls.country, "country", warnings)); put(body, "hl", normalizeLocale(controls.language, "language", warnings)); put(body, "tbs", controls.tbs); expected = "organic";
  } else if (controls.endpoint === "webpage") {
    try { const parsed = new URL(controls.url); if (!/^https?:$/.test(parsed.protocol)) throw new Error(); } catch { throw new ProviderError("invalid_input", "Serper webpage URL must use HTTP(S)"); }
    url = "https://scrape.serper.dev"; put(body, "url", controls.url); if (controls.includeMarkdown) body.includeMarkdown = true; if (controls.includeImages) body.includeImages = true; if (controls.includeLinks) body.includeLinks = true; if (controls.includeVideos) body.includeVideos = true; expected = "text";
  } else {
    throw new ProviderError("invalid_input", "Unsupported Serper operation");
  }
  const data = await requestSerperJson(url, body, ctx, fetchImpl);
  if (expected === "text" ? typeof data.text !== "string" : !Array.isArray(data[expected])) throw new ProviderError("unavailable", `Serper ${controls.endpoint} response shape changed`);
  if (typeof data.credits !== "number" || !Number.isFinite(data.credits) || data.credits < 0) throw new ProviderError("unavailable", `Serper ${controls.endpoint} credit metadata shape changed`);
  return { endpoint: controls.endpoint, data, credits: data.credits, warnings };
}

// Organic normalization: require a string title and link for a lead; skip malformed siblings only while
// valid records remain; never exceed the effective requested count.
export function normalizeSerper(data: unknown, count: number): SearchResult[] {
  if (!data || typeof data !== "object" || !("organic" in data) || !Array.isArray((data as { organic: unknown }).organic)) throw new ProviderError("unavailable", "Serper response shape changed");
  const organic = (data as { organic: Array<Record<string, unknown>> }).organic;
  if (!organic.length) return [];
  const results = organic.slice(0, count).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const title = item.title;
    const link = item.link;
    if (typeof title !== "string" || typeof link !== "string") return [];
    return [{ title, url: link, snippet: typeof item.snippet === "string" ? item.snippet : "", publishedAt: typeof item.date === "string" ? item.date : undefined, sourceType: "organic" }];
  });
  if (!results.length) throw new ProviderError("unavailable", "Serper organic result shape changed");
  return results;
}

// Recursively bound a structured candidate so a large answerBox/knowledgeGraph cannot bloat details:
// cap string length, array length, and nesting depth while preserving structure.
function boundCandidate(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > CANDIDATE_STRING_CAP ? `${value.slice(0, CANDIDATE_STRING_CAP)}…` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= CANDIDATE_DEPTH_CAP) return undefined;
  if (Array.isArray(value)) return value.slice(0, CANDIDATE_ARRAY_CAP).map((entry) => boundCandidate(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = boundCandidate(entry, depth + 1);
  return out;
}

function candidateObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return boundCandidate(value) as Record<string, unknown>;
}

// Focused search boundary: validate the bounded request, fetch under a local timeout that covers body
// consumption, classify failures, redact the credential, normalize organic leads, and preserve bounded
// answerBox/knowledgeGraph candidates. Always sends an integer num in the grounded 1-10 range.
export async function serperSearch(
  controls: { query: string; count?: number; country?: string; language?: string; tbs?: string },
  ctx: OpContext,
  fetchImpl: FetchLike = fetch,
): Promise<SerperFull> {
  if (ctx.signal?.aborted) throw new ProviderError("aborted", "Serper request aborted");
  if (!ctx.credential) throw new ProviderError("missing_credential", "SERPER_API_KEY is not set");
  const query = controls.query.trim();
  if (!query) throw new ProviderError("invalid_input", "Serper query must not be blank");

  const warnings: string[] = [];
  const country = normalizeLocale(controls.country, "country", warnings);
  const language = normalizeLocale(controls.language, "language", warnings);
  const requestedCount = controls.count ?? DEFAULT_NUM;
  const num = clampNum(requestedCount);
  if (requestedCount > MAX_NUM) warnings.push(`Serper's grounded maximum is ${MAX_NUM} results; requested ${requestedCount}, sending num=${num}`);

  const body: Record<string, unknown> = { q: query, num };
  if (country) body.gl = country;
  if (language) body.hl = language;
  if (controls.tbs) body.tbs = controls.tbs;

  const data = await requestSerperJson(SEARCH_URL, body, ctx, fetchImpl);

  const results = normalizeSerper(data, num);
  const record = data as Record<string, unknown>;
  const answerBox = candidateObject(record.answerBox);
  const knowledgeGraph = candidateObject(record.knowledgeGraph);
  const credits = typeof record.credits === "number" && Number.isFinite(record.credits) ? record.credits : undefined;
  if (answerBox) warnings.push("Serper answerBox candidate present in details.serper (lead-only, not fetched evidence)");
  if (knowledgeGraph) warnings.push("Serper knowledgeGraph candidate present in details.serper (lead-only, not fetched evidence)");

  const effective = { query, num, ...(country ? { country } : {}), ...(language ? { language } : {}) };
  return { results, effective, ...(answerBox ? { answerBox } : {}), ...(knowledgeGraph ? { knowledgeGraph } : {}), ...(credits !== undefined ? { credits } : {}), warnings };
}

export function createSerperAdapter(fetchImpl: FetchLike = fetch): Adapter {
  return {
    capability: {
      // Public routing remains general Search. Current news/media/local/scholar/patent/scrape
      // operations are focused internal capabilities until a public scenario needs their result shape.
      id: "serper", operations: ["search"], credentials: ["SERPER_API_KEY"],
      strengths: ["general"], returns: ["leads"],
      timeoutMs: 20_000, concurrency: 3, fallbackEligible: true,
      provenance: "docs/upstreams/serper.md",
    },
    async search(intent: SearchIntent, ctx: OpContext): Promise<SearchResultList> {
      const full = await serperSearch(
        { query: intent.query, count: intent.count, country: intent.serper?.country, language: intent.serper?.language, tbs: intent.serper?.tbs },
        ctx, fetchImpl,
      );
      const { results, ...envelope } = full;
      const output = results as SearchResultList;
      // Metadata belongs to the result list when there is no lead to carry it. Existing non-empty
      // calls retain the established first-result envelope for compatibility.
      if (output[0]) output[0] = { ...output[0], serper: envelope };
      else output.serper = envelope;
      return output;
    },
  };
}
