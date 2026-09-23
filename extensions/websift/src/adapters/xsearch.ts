// ADR-005.001: provider capability policy owns this adapter's contract surface; see docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md.
// Contract derived from @pi-lab/xsearch@1.0.3 (d78f2dabc9ec) and docs.x.ai/developers/tools/x-search —
// see docs/upstreams/xsearch.md. The donor is MIT-licensed contract evidence; no donor code is copied.
import { classifyHttpFailure, mapFetchFailure, ProviderError } from "../failures.ts";
import type { Adapter, OpContext, SearchIntent, SearchResult, SearchResultList, XSearchControls, XSearchFull, XSearchResponse, XSearchUsage } from "../types.ts";

type FetchLike = typeof fetch;

const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
// Grounded in the installed donor default and the README guidance to use a fast/non-reasoning
// model for routine searches. model stays internal (see ADR 5.2); it is never publicly exposed.
const DEFAULT_XSEARCH_MODEL = "grok-4-1-fast-non-reasoning";
const USER_AGENT = "jeito-websift/0.1.0 (@alehdezp/websift)";
const MAX_HANDLES = 20;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

// Wire types (xAI snake_case). Internal only — the public route uses camelCase options.
interface XSearchToolSpec {
  type: "x_search";
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  from_date?: string;
  to_date?: string;
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
}
interface XSearchRequestBody {
  model: string;
  input: Array<{ role: "user"; content: string }>;
  tools: XSearchToolSpec[];
  max_turns?: number;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
}

// Handle normalization is the single source of truth for the wire values AND the visible warning.
// Trims whitespace, strips leading "@", discards empties, enforces the max. A warning records any
// rewrite so the tool can surface it instead of silently changing the caller's handles. No
// character-set or length restriction is invented beyond the max — official docs own that contract.
export function normalizeXSearchHandles(raw: string[] | undefined, field: "allowedHandles" | "excludedHandles"): { handles: string[]; warnings: string[] } {
  if (raw === undefined) return { handles: [], warnings: [] };
  if (!Array.isArray(raw)) throw new ProviderError("invalid_input", `xAI ${field} must be an array of handles`);
  if (raw.length > MAX_HANDLES) throw new ProviderError("invalid_input", `xAI ${field} supports at most ${MAX_HANDLES} handles`);
  const warnings: string[] = [];
  const handles: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") throw new ProviderError("invalid_input", `xAI ${field} entries must be strings`);
    const trimmed = value.trim();
    const normalized = trimmed.replace(/^@+/, "");
    if (!normalized) {
      if (normalized !== value) warnings.push(`xAI ${field}: discarded "${value}" after removing leading @ and/or whitespace because the handle was empty`);
      continue;
    }
    if (normalized !== value) warnings.push(`xAI ${field}: normalized "${value}" to "${normalized}" (removed leading @ and/or whitespace)`);
    handles.push(normalized);
  }
  if (handles.length > MAX_HANDLES) throw new ProviderError("invalid_input", `xAI ${field} supports at most ${MAX_HANDLES} handles`);
  return { handles, warnings };
}

// Calendar-valid, not just regex-shaped: 2025-02-30 is rejected. Date.UTC rolls invalid days into
// the next month, so a real date round-trips its components.
export function isValidCalendarDate(date: string): boolean {
  if (!DATE_SHAPE.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year!, month! - 1, day!));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month! - 1 && utc.getUTCDate() === day;
}

function assertXSearchDate(date: string, field: "fromDate" | "toDate"): string {
  const trimmed = date.trim();
  if (!isValidCalendarDate(trimmed)) throw new ProviderError("invalid_input", `xAI ${field} must be a valid YYYY-MM-DD calendar date`);
  return trimmed;
}

function buildXSearchBody(controls: XSearchControls & { allowedHandles: string[]; excludedHandles: string[]; model: string }): XSearchRequestBody {
  const tool: XSearchToolSpec = { type: "x_search" };
  if (controls.allowedHandles.length) tool.allowed_x_handles = controls.allowedHandles;
  if (controls.excludedHandles.length) tool.excluded_x_handles = controls.excludedHandles;
  if (controls.fromDate) tool.from_date = controls.fromDate;
  if (controls.toDate) tool.to_date = controls.toDate;
  if (controls.enableImageUnderstanding) tool.enable_image_understanding = true;
  if (controls.enableVideoUnderstanding) tool.enable_video_understanding = true;
  return {
    model: controls.model,
    input: [{ role: "user", content: controls.query }],
    tools: [tool],
    max_turns: controls.maxTurns,
    parallel_tool_calls: controls.parallelToolCalls,
    max_output_tokens: controls.maxOutputTokens,
  };
}

function sanitizeXSearchFailure(error: unknown, credential: string): unknown {
  if (!(error instanceof Error) || !error.message.includes(credential)) return error;
  const message = error.message.split(credential).join("[redacted]");
  if (error instanceof ProviderError) return new ProviderError(error.failureClass, message, error.retryAfterMs);
  if (error instanceof DOMException) return new DOMException(message, error.name);
  return new Error(message);
}

async function requestXSearch(body: XSearchRequestBody, ctx: OpContext, fetchImpl: FetchLike): Promise<unknown> {
  if (!ctx.credential) throw new ProviderError("missing_credential", "XAI_API_KEY is not set");
  if (ctx.signal?.aborted) throw new ProviderError("aborted", "xAI request aborted");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, ctx.timeoutMs));
  const abort = () => controller.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(XAI_RESPONSES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${ctx.credential}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw classifyHttpFailure(response.status, response.headers.get("retry-after"), errorBody);
    }
    const bodyText = await response.text();
    try {
      return bodyText ? JSON.parse(bodyText) : {};
    } catch {
      throw new ProviderError("unavailable", "xAI response body is not valid JSON");
    }
  } catch (error) {
    throw mapFetchFailure(sanitizeXSearchFailure(error, ctx.credential), ctx.signal);
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", abort);
  }
}

function assertXSearchResponse(response: unknown): XSearchResponse {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new ProviderError("unavailable", "xAI response shape changed");
  const value = response as Record<string, unknown>;
  if (value.output === undefined && value.citations === undefined) throw new ProviderError("unavailable", "xAI response carried no output or citations");
  if (value.output !== undefined && !Array.isArray(value.output)) throw new ProviderError("unavailable", "xAI response output shape changed");
  if (value.citations !== undefined && !Array.isArray(value.citations)) throw new ProviderError("unavailable", "xAI response citations shape changed");
  if (value.usage !== undefined && (!value.usage || typeof value.usage !== "object" || Array.isArray(value.usage))) throw new ProviderError("unavailable", "xAI response usage shape changed");
  return response as XSearchResponse;
}

function extractText(response: XSearchResponse): string {
  const parts: string[] = [];
  if (Array.isArray(response.output)) for (const item of response.output) {
    if (!item || typeof item !== "object" || !Array.isArray(item.content)) continue;
    for (const content of item.content) if (content && typeof content === "object" && typeof content.text === "string") parts.push(content.text);
  }
  return parts.join("\n\n").trim();
}

// One entry per unique citation URL, preserving the provider's original order. Citations arrive in
// output[].content[].annotations[].url and/or a top-level citations[].
function extractCitations(response: XSearchResponse): string[] {
  const citations = new Set<string>();
  if (Array.isArray(response.output)) for (const item of response.output) {
    if (!item || typeof item !== "object" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!content || typeof content !== "object" || !Array.isArray(content.annotations)) continue;
      for (const annotation of content.annotations) if (annotation && typeof annotation === "object" && typeof annotation.url === "string" && annotation.url.trim()) citations.add(annotation.url);
    }
  }
  if (Array.isArray(response.citations)) for (const url of response.citations) if (typeof url === "string" && url.trim()) citations.add(url);
  return [...citations];
}

// Provider work metadata retained in details; citation-free synthesis is also rendered as lead-only output.
function parseXaiUsage(response: XSearchResponse): XSearchUsage {
  const usage = response.usage && typeof response.usage === "object" ? response.usage : undefined;
  const toolUsage = usage?.server_side_tool_usage_details;
  const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
  return {
    inputTokens: num(usage?.input_tokens),
    outputTokens: num(usage?.output_tokens),
    totalTokens: num(usage?.total_tokens),
    xSearchCalls: num(toolUsage?.x_search_calls),
    webSearchCalls: num(toolUsage?.web_search_calls),
  };
}

// One SearchResult per unique citation. The synthesized text is the snippet (Grok's answer), never
// source content; every result stays a social lead. Never fabricates post title/author/handle/date/
// engagement/raw text — the API does not promise raw tweet objects. count bounds returned leads.
export function normalizeXSearch(response: unknown, count?: number): SearchResult[] {
  const parsed = assertXSearchResponse(response);
  const text = extractText(parsed);
  const citations = extractCitations(parsed);
  if (!citations.length) return [];
  const bounded = Number.isInteger(count) && (count as number) > 0 ? citations.slice(0, count) : citations;
  return bounded.map((url, index) => ({ title: `X source ${index + 1}`, url, snippet: text, sourceType: "social" }));
}

// Focused typed boundary for one xAI x_search call: validates before network, builds the exact
// Responses API body, threads caller cancellation, enforces a local timeout, classifies failures
// through the shared taxonomy, and preserves the full synthesized/citation/usage metadata.
export async function xSearchResponses(controls: XSearchControls, ctx: OpContext, fetchImpl: FetchLike = fetch): Promise<XSearchFull> {
  if (!controls.query.trim()) throw new ProviderError("invalid_input", "xAI search query is empty");
  const allowed = normalizeXSearchHandles(controls.allowedHandles, "allowedHandles");
  const excluded = normalizeXSearchHandles(controls.excludedHandles, "excludedHandles");
  if (allowed.handles.length && excluded.handles.length) throw new ProviderError("invalid_input", "xAI allowedHandles and excludedHandles cannot be set together");
  const fromDate = controls.fromDate !== undefined ? assertXSearchDate(controls.fromDate, "fromDate") : undefined;
  const toDate = controls.toDate !== undefined ? assertXSearchDate(controls.toDate, "toDate") : undefined;
  if (fromDate && toDate && fromDate > toDate) throw new ProviderError("invalid_input", "xAI fromDate must be before or equal to toDate");
  if (controls.maxTurns !== undefined && (!Number.isInteger(controls.maxTurns) || controls.maxTurns < 1)) throw new ProviderError("invalid_input", "xAI maxTurns must be a positive integer");
  if (controls.maxOutputTokens !== undefined && (!Number.isInteger(controls.maxOutputTokens) || controls.maxOutputTokens < 1)) throw new ProviderError("invalid_input", "xAI maxOutputTokens must be a positive integer");
  const model = controls.model?.trim() || DEFAULT_XSEARCH_MODEL;
  const response = assertXSearchResponse(await requestXSearch(buildXSearchBody({
    query: controls.query.trim(), allowedHandles: allowed.handles, excludedHandles: excluded.handles,
    fromDate, toDate, model, enableImageUnderstanding: controls.enableImageUnderstanding, enableVideoUnderstanding: controls.enableVideoUnderstanding,
    maxTurns: controls.maxTurns, parallelToolCalls: controls.parallelToolCalls, maxOutputTokens: controls.maxOutputTokens,
  }), ctx, fetchImpl));
  const text = extractText(response);
  const citations = extractCitations(response);
  const usage = parseXaiUsage(response);
  // A provider-completed response without citation URLs is a scoped zero outcome: no retrieved
  // cited X evidence under this request. Synthesis and reported work remain visible, never a failure.
  if (!citations.length) {
    return { results: [], text, citations, model, usage, warnings: [...allowed.warnings, ...excluded.warnings] };
  }
  return { results: normalizeXSearch(response), text, citations, model, usage, warnings: [...allowed.warnings, ...excluded.warnings] };
}

export function createXSearchAdapter(fetchImpl: FetchLike = fetch): Adapter {
  return {
    capability: {
      id: "xsearch", operations: ["search"], credentials: ["XAI_API_KEY"], strengths: ["social"],
      returns: ["leads"], filters: ["recency"], timeoutMs: 20_000, concurrency: 1, fallbackEligible: true,
      provenance: "docs/upstreams/xsearch.md",
    },
    async search(intent: SearchIntent, ctx: OpContext): Promise<SearchResultList> {
      const controls = intent.xsearch;
      const full = await xSearchResponses({
        query: intent.query,
        allowedHandles: controls?.allowedHandles,
        excludedHandles: controls?.excludedHandles,
        fromDate: intent.recency?.from,
        toDate: intent.recency?.to,
        enableImageUnderstanding: controls?.enableImageUnderstanding,
        maxTurns: controls?.maxTurns,
        parallelToolCalls: controls?.parallelToolCalls,
        maxOutputTokens: controls?.maxOutputTokens,
      }, ctx, fetchImpl);
      // intent.count bounds returned leads locally; it does not reduce upstream xAI work.
      const count = intent.count;
      const results = (Number.isInteger(count) && count > 0 ? full.results.slice(0, count) : full.results) as SearchResultList;
      const envelope = { model: full.model, usage: full.usage, ...(full.text ? { synthesis: full.text } : {}), ...(full.warnings.length ? { warnings: full.warnings } : {}) };
      if (results[0]) results[0] = { ...results[0], xsearch: envelope };
      else results.xsearch = envelope;
      return results;
    },
  };
}