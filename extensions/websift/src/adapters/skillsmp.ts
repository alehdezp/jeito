// ADR-005.001: provider capability policy owns this adapter's contract surface; see docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md.
// Contract grounded in the official SkillsMP API docs (skillsmp.com/docs/api, accessed 2026-07-29)
// and the first-party @alehdezp/skillsmp-search 0.1.0 source — see docs/upstreams/skillsmp.md.
// Catalog discovery only: records are leads, never fetched evidence, and carry no safety, license,
// compatibility, or install endorsement.
import { classifyHttpFailure, mapFetchFailure, ProviderError, redactCredential } from "../failures.ts";
import type {
  Adapter, LookupIntent, LookupResult, LookupResultList, OpContext, SkillsMpFull, SkillsMpRateLimits, SkillsMpSort,
} from "../types.ts";

type FetchLike = typeof fetch;

const SEARCH_URL = "https://skillsmp.com/api/v1/skills/search";
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function records(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["skills", "results", "items", "data"]) {
    const nested = (value as Record<string, unknown>)[key];
    if (Array.isArray(nested)) return nested;
    if (nested && typeof nested === "object") {
      for (const child of ["skills", "results", "items"]) {
        if (Array.isArray((nested as Record<string, unknown>)[child])) return (nested as Record<string, unknown>)[child] as unknown[];
      }
    }
  }
  return [];
}

// Whether the response carried a recognized record collection at all, and how many rows it held.
// Distinguishes a provider-valid empty catalog (`{skills:[]}`) from a changed shape (`{}`) and from
// all-malformed rows (`{skills:[{noTitle:true}]}`).
function rawRecordCount(value: unknown): { present: boolean; count: number } {
  if (Array.isArray(value)) return { present: true, count: value.length };
  if (!value || typeof value !== "object") return { present: false, count: 0 };
  for (const key of ["skills", "results", "items", "data"]) {
    const nested = (value as Record<string, unknown>)[key];
    if (Array.isArray(nested)) return { present: true, count: nested.length };
    if (nested && typeof nested === "object") {
      const record = nested as Record<string, unknown>;
      for (const child of ["skills", "results", "items"]) {
        if (Array.isArray(record[child])) return { present: true, count: (record[child] as unknown[]).length };
      }
    }
  }
  return { present: false, count: 0 };
}

function present(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Record normalization: preserve grounded fields where present (title/name/slug, description/summary,
// source URL, stars, category, occupation, and a stable identifier). Malformed records (no string
// title) are skipped only when valid siblings remain; the caller classifies the response.
export function normalizeSkillsMp(value: unknown): LookupResult[] {
  return records(value).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const title = present(record.title) ?? present(record.name) ?? present(record.slug);
    if (!title) return [];
    const url = present(record.githubUrl) ?? present(record.repository) ?? present(record.repo) ?? present(record.url);
    const description = present(record.description) ?? present(record.summary);
    const metadata: Record<string, unknown> = {};
    const stars = record.stars ?? record.githubStars;
    if (typeof stars === "number") metadata.stars = stars;
    if (typeof record.updatedAt === "string" && record.updatedAt) metadata.updatedAt = record.updatedAt.slice(0, 10);
    if (typeof record.author === "string" && record.author) metadata.author = record.author;
    const category = present(record.category) ?? present(record.categoryName);
    if (category) metadata.category = category;
    const occupation = present(record.occupation);
    if (occupation) metadata.occupation = occupation;
    const stableId = present(record.id) ?? present(record.skillId) ?? present(record.slug);
    if (stableId) metadata.id = stableId;
    return [{ title, url, description, metadata }];
  });
}

function parseRateLimits(headers: Headers): SkillsMpRateLimits | undefined {
  const parse = (name: string): number | undefined => {
    const value = headers.get(name);
    if (value === null) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
  };
  const rateLimits: SkillsMpRateLimits = {};
  const dailyLimit = parse("x-ratelimit-daily-limit");
  if (dailyLimit !== undefined) rateLimits.dailyLimit = dailyLimit;
  const dailyRemaining = parse("x-ratelimit-daily-remaining");
  if (dailyRemaining !== undefined) rateLimits.dailyRemaining = dailyRemaining;
  const minuteLimit = parse("x-ratelimit-minute-limit");
  if (minuteLimit !== undefined) rateLimits.minuteLimit = minuteLimit;
  const minuteRemaining = parse("x-ratelimit-minute-remaining");
  if (minuteRemaining !== undefined) rateLimits.minuteRemaining = minuteRemaining;
  return Object.keys(rateLimits).length > 0 ? rateLimits : undefined;
}

// Focused HTTP boundary: pre-abort check, bearer auth, a LOCAL timeout covering fetch plus body
// consumption, caller-signal forwarding, shared HTTP classification, and credential redaction of
// transport errors. Returns the raw body text plus parsed rate-limit metadata.
async function requestSkillsMp(url: URL, ctx: OpContext, fetchImpl: FetchLike): Promise<{ body: string; rateLimits?: SkillsMpRateLimits }> {
  if (ctx.signal?.aborted) throw new ProviderError("aborted", "SkillsMP request aborted");
  if (!ctx.credential) throw new ProviderError("missing_credential", "SKILLSMP_API_KEY is not set");
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${ctx.credential}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, ctx.timeoutMs));
  const abort = () => controller.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    const rateLimits = parseRateLimits(response.headers);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw classifyHttpFailure(response.status, response.headers.get("retry-after"), errorBody);
    }
    return { body: await response.text(), rateLimits };
  } catch (error) {
    throw redactCredential(mapFetchFailure(error, ctx.signal), ctx.credential);
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", abort);
  }
}

// Focused search boundary: validate the bounded request, fetch, parse the response shape, normalize
// records, and return a typed full result (records + effective controls + rate limits).
export async function skillsMpSearch(
  controls: { query: string; page?: number; limit?: number; sortBy?: SkillsMpSort; category?: string; occupation?: string; language?: string },
  ctx: OpContext,
  fetchImpl: FetchLike = fetch,
): Promise<SkillsMpFull> {
  const query = controls.query.trim();
  if (!query) throw new ProviderError("invalid_input", "SkillsMP query must not be blank");
  const category = controls.category === undefined ? undefined : controls.category.trim();
  if (controls.category !== undefined && !category) throw new ProviderError("invalid_input", "SkillsMP category must not be blank when supplied");
  const occupation = controls.occupation === undefined ? undefined : controls.occupation.trim();
  if (controls.occupation !== undefined && !occupation) throw new ProviderError("invalid_input", "SkillsMP occupation must not be blank when supplied");
  const language = controls.language === undefined ? undefined : controls.language.trim();
  if (controls.language !== undefined && !language) throw new ProviderError("invalid_input", "SkillsMP language must not be blank when supplied");
  const effectivePage = clampInteger(controls.page, DEFAULT_PAGE, 1, Number.MAX_SAFE_INTEGER);
  const effectiveLimit = clampInteger(controls.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const sortBy: SkillsMpSort = controls.sortBy === "recent" ? "recent" : "stars";

  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("page", String(effectivePage));
  url.searchParams.set("limit", String(effectiveLimit));
  url.searchParams.set("sortBy", sortBy);
  if (category) url.searchParams.set("category", category);
  if (occupation) url.searchParams.set("occupation", occupation);
  if (language) url.searchParams.set("language", language);

  const { body, rateLimits } = await requestSkillsMp(url, ctx, fetchImpl);

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new ProviderError("unavailable", "SkillsMP response is not valid JSON");
  }
  if (data === null || (typeof data !== "object" && !Array.isArray(data))) {
    throw new ProviderError("unavailable", "SkillsMP response shape changed");
  }

  const raw = rawRecordCount(data);
  if (!raw.present) throw new ProviderError("unavailable", "SkillsMP response shape changed");
  const normalized = normalizeSkillsMp(data);
  if (raw.count > 0 && !normalized.length) throw new ProviderError("unavailable", "SkillsMP record shape changed");

  return {
    records: normalized,
    effective: {
      query, page: effectivePage, limit: effectiveLimit, sortBy,
      ...(category ? { category } : {}), ...(occupation ? { occupation } : {}), ...(language ? { language } : {}),
    },
    rateLimits,
  };
}

export function createSkillsMpAdapter(fetchImpl: FetchLike = fetch): Adapter {
  return {
    capability: {
      id: "skillsmp", operations: ["lookup"], credentials: ["SKILLSMP_API_KEY"], strengths: ["skillsmp"], returns: ["leads"],
      filters: ["category", "occupation", "language", "sortBy"], timeoutMs: 20_000, concurrency: 2, fallbackEligible: false,
      provenance: "docs/upstreams/skillsmp.md",
    },
    async lookup(intent: LookupIntent, ctx: OpContext): Promise<LookupResultList> {
      const full = await skillsMpSearch(
        {
          query: intent.query, page: intent.page, limit: intent.limit, sortBy: intent.sortBy,
          category: intent.category, occupation: intent.occupation, language: intent.language,
        },
        ctx, fetchImpl,
      );
      const { records: results, effective, rateLimits } = full;
      const envelope = { effective, ...(rateLimits ? { rateLimits } : {}) };
      const list = results as LookupResultList;
      // Envelope metadata rides the first record once; on a valid zero catalog it rides the array so
      // web_lookup still lifts effective controls and rate limits into top-level details.
      if (list[0]) list[0] = { ...list[0], metadata: { ...list[0].metadata, skillsmp: envelope } };
      else list.skillsmp = envelope;
      return list;
    },
  };
}
