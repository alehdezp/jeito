// ADR-005.001: provider capability policy owns this adapter's contract surface; see docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md.
// Contract grounded in the official Context7 Public API v2.0.0 (context7.com/docs/api-reference) and
// the installed @dreki-gg/pi-context7 0.2.0 donor — see docs/upstreams/context7.md. The donor is
// declared-MIT contract evidence (no LICENSE file shipped); no donor code is copied.
import { classifyHttpFailure, mapFetchFailure, ProviderError, redactCredential } from "../failures.ts";
import { cacheRoot } from "../fetch-cache.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Adapter, Context7Candidate, Context7DocsResponse, Context7SearchResponse, FetchedContent,
  LookupIntent, LookupResult, OpContext, ToolDetails,
} from "../types.ts";

type FetchLike = typeof fetch;

const SEARCH_URL = "https://context7.com/api/v2/libs/search";
const CONTEXT_URL = "https://context7.com/api/v2/context";
// jeito identifies itself honestly; the donor sends X-Context7-Source: pi-extension.
const CONTEXT7_SOURCE_HEADER = "jeito-websift";
// Inline excerpts are bounded; the complete raw body is saved under .cache/web/docs/<doc>/
// and the printed docs path is the handle (agent reads the file with the read tool).
const INLINE_EXCERPT_CHARS = 6000;
const LIBRARY_ID_PATTERN = /^\/[^/]+\/[^/]+(?:[/@][^/]+)?$/;

function assertContext7LibraryId(value: string): string {
  const libraryId = value.trim();
  if (!libraryId || libraryId.length > 500 || !LIBRARY_ID_PATTERN.test(libraryId)) {
    throw new ProviderError("invalid_input", "Context7 libraryId must use the official /owner/repo format with an optional /version or @version suffix");
  }
  return libraryId;
}

async function requestContext7(url: URL, ctx: OpContext, fetchImpl: FetchLike): Promise<string> {
  if (ctx.signal?.aborted) throw new ProviderError("aborted", "Context7 request aborted");
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    "X-Context7-Source": CONTEXT7_SOURCE_HEADER,
  };
  if (ctx.credential) headers.Authorization = `Bearer ${ctx.credential}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, ctx.timeoutMs));
  const abort = () => controller.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw classifyHttpFailure(response.status, response.headers.get("retry-after"), errorBody);
    }
    return await response.text();
  } catch (error) {
    throw redactCredential(mapFetchFailure(error, ctx.signal), ctx.credential);
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", abort);
  }
}

// Resolve call (GET /v2/libs/search). libraryName and query are required by the official API; fast
// skips LLM reranking for lower latency.
export async function context7SearchLibraries(
  controls: { query: string; library: string; fast?: boolean },
  ctx: OpContext,
  fetchImpl: FetchLike = fetch,
): Promise<Context7SearchResponse> {
  const library = controls.library.trim();
  if (!library) throw new ProviderError("invalid_input", "Context7 resolution requires a library name");
  const url = new URL(SEARCH_URL);
  url.searchParams.set("libraryName", library);
  url.searchParams.set("query", controls.query.trim() || library);
  if (controls.fast) url.searchParams.set("fast", "true");
  const rawBody = await requestContext7(url, ctx, fetchImpl);
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new ProviderError("unavailable", "Context7 search response is not valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray((payload as { results?: unknown }).results)) {
    throw new ProviderError("unavailable", "Context7 search response shape changed");
  }
  const body = payload as Context7SearchResponse;
  if (body.results.some((candidate) => !candidate || typeof candidate !== "object" || typeof (candidate as { id?: unknown }).id !== "string" || !LIBRARY_ID_PATTERN.test((candidate as { id: string }).id))) {
    throw new ProviderError("unavailable", "Context7 search candidate shape changed");
  }
  return { results: body.results, searchFilterApplied: body.searchFilterApplied };
}

// Docs call (GET /v2/context). Returns the complete raw body (txt by default, or the exact JSON string
// when responseType is json); parsing/normalization is the caller's responsibility.
export async function context7FetchDocs(
  controls: { libraryId: string; query: string; fast?: boolean; responseType?: "txt" | "json" },
  ctx: OpContext,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const libraryId = assertContext7LibraryId(controls.libraryId);
  const url = new URL(CONTEXT_URL);
  url.searchParams.set("libraryId", libraryId);
  url.searchParams.set("query", controls.query);
  if (controls.responseType) url.searchParams.set("type", controls.responseType);
  if (controls.fast) url.searchParams.set("fast", "true");
  const body = await requestContext7(url, ctx, fetchImpl);
  if (!body.trim()) throw new ProviderError("empty", "Context7 returned empty documentation");
  return body;
}

function normalizeName(value?: string): string {
  return (value ?? "").trim().toLowerCase();
}

// Auto-selection is intentionally conservative: one candidate is safe, as is one unique exact
// title or final ID-segment match. Provider scores remain metadata and never authorize a guess.
function selectContext7Library(candidates: Context7Candidate[], libraryName: string): { selected?: Context7Candidate; ambiguous: boolean } {
  if (candidates.length === 0) return { ambiguous: false };
  if (candidates.length === 1) return { selected: candidates[0], ambiguous: false };
  const target = normalizeName(libraryName).replace(/^@/, "");
  const exact = candidates.filter((candidate) => {
    const title = normalizeName(candidate.title).replace(/^@/, "");
    const finalIdSegment = normalizeName(candidate.id).split("/").filter(Boolean).at(-1)?.replace(/^@/, "");
    return title === target || finalIdSegment === target;
  });
  return exact.length === 1 ? { selected: exact[0], ambiguous: false } : { ambiguous: true };
}

// Match a requested version against a candidate's advertised versions, tolerating a leading-v
// difference; returns the exact advertised string so the pinned ID stays authoritative.
function matchVersion(versions: string[] | undefined, requested: string): string | undefined {
  if (!versions?.length) return undefined;
  const norm = (value: string): string => value.trim().replace(/^v/i, "").toLowerCase();
  const want = norm(requested);
  return versions.find((version) => norm(version) === want);
}

// Donor-compatible effective query: topic and page are steering encoded into the query text, not
// independent Context7 server parameters (the official API has no topic/page params).
function buildEffectiveQuery(query?: string, topic?: string, page?: number): string {
  const parts = [query?.trim(), topic?.trim() ? `Focus: ${topic.trim()}` : undefined];
  if (typeof page === "number" && page > 1) parts.push(`Requested page: ${page}`);
  return parts.filter(Boolean).join("\n\n") || "overview";
}

function candidateToRecord(candidate: Context7Candidate, searchFilterApplied?: boolean, needsResolution?: boolean): LookupResult {
  const metadata: Record<string, unknown> = { id: candidate.id };
  if (candidate.title !== undefined) metadata.title = candidate.title;
  if (candidate.description !== undefined) metadata.description = candidate.description;
  if (candidate.versions?.length) metadata.versions = candidate.versions;
  if (typeof candidate.totalSnippets === "number") metadata.totalSnippets = candidate.totalSnippets;
  if (typeof candidate.trustScore === "number") metadata.trustScore = candidate.trustScore;
  if (typeof candidate.benchmarkScore === "number") metadata.benchmarkScore = candidate.benchmarkScore;
  if (candidate.source !== undefined) metadata.source = candidate.source;
  if (searchFilterApplied !== undefined) metadata.searchFilterApplied = searchFilterApplied;
  if (needsResolution !== undefined) metadata.needsResolution = needsResolution;
  return { title: candidate.title || candidate.id, url: `https://context7.com${candidate.id}`, description: candidate.description, metadata };
}

function renderContext7Json(parsed: Context7DocsResponse): string {
  const parts: string[] = [];
  for (const snippet of parsed.codeSnippets ?? []) {
    const header = snippet.codeTitle || "Code snippet";
    const page = snippet.pageTitle ? ` — ${snippet.pageTitle}` : "";
    const blocks = (snippet.codeList ?? []).map((example) => `\`\`\`${example.language ?? ""}\n${example.code ?? ""}\n\`\`\``);
    parts.push([`### ${header}${page}`, snippet.codeDescription, ...blocks].filter(Boolean).join("\n\n"));
  }
  for (const info of parsed.infoSnippets ?? []) {
    parts.push(`## ${info.breadcrumb || "Documentation"}\n\n${info.content ?? ""}`);
  }
  return parts.join("\n\n") || "(Context7 returned no snippets)";
}

function boundInline(text: string, docsPath?: string): string {
  if (text.length <= INLINE_EXCERPT_CHARS) return text;
  const hint = docsPath ? `read ${docsPath} (read tool)` : "read the printed docs path (read tool)";
  return `${text.slice(0, INLINE_EXCERPT_CHARS)}\n\n…[excerpt truncated; the complete body is at ${hint}]`;
}

// Resolve-only focused operation: catalog candidates, fetched:false, no responseId.
export async function context7ResolveLibraries(
  controls: { query: string; library: string; version?: string; fast?: boolean },
  ctx: OpContext,
  fetchImpl: FetchLike = fetch,
): Promise<LookupResult[]> {
  const response = await context7SearchLibraries(controls, ctx, fetchImpl);
  if (!response.results.length) return [];
  const requestedVersion = controls.version?.trim() || undefined;
  const matching = requestedVersion ? response.results.filter((candidate) => matchVersion(candidate.versions, requestedVersion)) : response.results;
  const versionNotFound = Boolean(requestedVersion && !matching.length);
  const candidates = matching.length ? matching : response.results;
  const selection = versionNotFound ? { ambiguous: true as const } : selectContext7Library(candidates, controls.library);
  return candidates.map((candidate) => {
    const record = candidateToRecord(candidate, response.searchFilterApplied, versionNotFound || !selection.selected);
    return { ...record, metadata: {
      ...record.metadata,
      ...(requestedVersion ? { requestedVersion } : {}),
      ...(versionNotFound ? { versionNotFound: requestedVersion } : {}),
      ...(selection.selected?.id === candidate.id ? { recommendedLibraryId: candidate.id } : {}),
    } };
  });
}
// Docs focused operation: safe resolution (or an explicit ID), version pinning, docs retrieval, and
// retention of the complete raw body at the docsPath file. Ambiguous or unversionable resolution returns
// catalog candidates and performs no docs request.

export async function context7GetLibraryDocs(
  controls: { query: string; library?: string; version?: string; libraryId?: string; topic?: string; page: number; fast?: boolean; responseType?: "txt" | "json" },
  ctx: OpContext,
  fetchImpl: FetchLike = fetch,
): Promise<LookupResult[]> {
  const requestedVersion = controls.version?.trim() || undefined;
  let resolvedLibraryId: string | undefined;
  let resolvedCandidate: Context7Candidate | undefined;

  if (controls.libraryId?.trim()) {
    // An explicit library ID is authoritative and bypasses resolution (it may already be version-pinned).
    resolvedLibraryId = assertContext7LibraryId(controls.libraryId);
  } else {
    const library = controls.library?.trim();
    if (!library) throw new ProviderError("invalid_input", "Context7 docs require context7.libraryId or library");
    const search = await context7SearchLibraries({ query: controls.query, library, fast: controls.fast }, ctx, fetchImpl);
    if (!search.results.length) return [];

    let pool = search.results;
    if (requestedVersion) {
      const matched = search.results.filter((candidate) => matchVersion(candidate.versions, requestedVersion) !== undefined);
      if (!matched.length) {
        // The requested version cannot be pinned safely: return candidates, never fetch unversioned docs.
        return search.results.map((candidate) => {
          const record = candidateToRecord(candidate, search.searchFilterApplied, true);
          return { ...record, metadata: { ...record.metadata, versionNotFound: requestedVersion } };
        });
      }
      pool = matched;
    }

    const selection = selectContext7Library(pool, library);
    if (!selection.selected) {
      // Ambiguous resolution: return candidates and perform no docs request.
      return search.results.map((candidate) => candidateToRecord(candidate, search.searchFilterApplied, true));
    }
    resolvedCandidate = selection.selected;
    const advertised = requestedVersion ? matchVersion(resolvedCandidate.versions, requestedVersion) : undefined;
    resolvedLibraryId = assertContext7LibraryId(advertised ? `${resolvedCandidate.id}@${advertised}` : resolvedCandidate.id);
  }

  const effectiveQuery = buildEffectiveQuery(controls.query, controls.topic, controls.page);
  const rawBody = await context7FetchDocs({ libraryId: resolvedLibraryId, query: effectiveQuery, fast: controls.fast, responseType: controls.responseType }, ctx, fetchImpl);

  let inline: string;
  let structuredData: Context7DocsResponse | undefined;
  if (controls.responseType === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new ProviderError("unavailable", "Context7 json response is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProviderError("unavailable", "Context7 json response shape changed");
    const json = parsed as Record<string, unknown>;
    if (!Array.isArray(json.codeSnippets) || !Array.isArray(json.infoSnippets)) throw new ProviderError("unavailable", "Context7 json response shape changed");
    structuredData = parsed as Context7DocsResponse;
    inline = renderContext7Json(structuredData);
  } else {
    inline = rawBody;
  }

  // Retain the complete raw body as a file; only a bounded representation goes inline.
  const root = ctx.root ?? cacheRoot(process.cwd());
  const docName = resolvedLibraryId.replace(/^\/+/, "").replace(/[/@:]/g, "_");
  const docsDir = join(root, "docs", docName);
  mkdirSync(docsDir, { recursive: true });
  const docsPath = join(docsDir, controls.responseType === "json" ? "full.json" : "full.md");
  writeFileSync(docsPath, rawBody);

  const metadata: Record<string, unknown> = {
    libraryId: resolvedLibraryId,
    resolvedLibraryId,
    requestedVersion,
    responseType: controls.responseType ?? "txt",
    page: controls.page,
    docsPath,
  };
  if (structuredData) metadata.structuredData = structuredData;
  if (controls.topic?.trim()) metadata.topic = controls.topic.trim();
  if (controls.fast !== undefined) metadata.fast = controls.fast;
  if (resolvedCandidate) {
    if (typeof resolvedCandidate.trustScore === "number") metadata.trustScore = resolvedCandidate.trustScore;
    if (typeof resolvedCandidate.benchmarkScore === "number") metadata.benchmarkScore = resolvedCandidate.benchmarkScore;
    if (resolvedCandidate.versions?.length) metadata.versions = resolvedCandidate.versions;
  }
  const title = resolvedCandidate?.title || resolvedLibraryId;
  return [{ title, url: `https://context7.com${resolvedLibraryId}`, description: resolvedCandidate?.description, content: boundInline(inline, docsPath), metadata }];
}

export function createContext7Adapter(fetchImpl: FetchLike = fetch): Adapter {
  return {
    capability: {
      id: "context7", operations: ["lookup"], credentials: [], strengths: ["context7"], returns: ["content"],
      filters: ["version"], timeoutMs: 20_000, concurrency: 2, fallbackEligible: false,
      provenance: "docs/upstreams/context7.md",
    },
    async lookup(intent: LookupIntent, ctx: OpContext): Promise<LookupResult[]> {
      const options = intent.context7 ?? {};
      const mode = options.mode ?? "docs";
      if (mode === "resolve") {
        if (!intent.library?.trim()) throw new ProviderError("invalid_input", "Context7 resolve mode requires library");
        if (options.libraryId || options.topic || options.responseType || intent.page > 1) throw new ProviderError("invalid_input", "Context7 resolve mode accepts library, optional version, and fast only");
        return context7ResolveLibraries({ query: intent.query, library: intent.library, version: intent.version, fast: options.fast }, ctx, fetchImpl);
      }
      return context7GetLibraryDocs({
        query: intent.query, library: intent.library, version: intent.version, libraryId: options.libraryId,
        topic: options.topic, page: intent.page, fast: options.fast, responseType: options.responseType,
      }, ctx, fetchImpl);
    },
  };
}
