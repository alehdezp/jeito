// ADR-002.005: webclaw is the universal local text extractor. URL-shape dispatch keeps the
// native download/intelligence class (github/youtube/pdf) on its handlers, routes the 8
// proven verticals to typed JSON, and sends everything else through the local binary with
// -f llm. JS-needs DB consult is DB-first; rule v2 detection on webclaw output and
// bot-class failures write the DB and throw so routing escalates to tavily. A missing
// binary is policy (no fallback — tavily cannot help an environment problem).
import { ProviderError, classifyHttpFailure, mapFetchFailure } from "../failures.ts";
import type { Adapter, FetchedContent, FetchIntent, OpContext } from "../types.ts";
import { extractGitHub, parseGitHubUrl } from "../fetch-handlers/github.ts";
import { extractYouTube, parseYouTubeUrl } from "../fetch-handlers/youtube.ts";
import { extractPdf, isPDF } from "../fetch-handlers/pdf.ts";
import { cacheRoot } from "../fetch-cache.ts";
import { bodyMetrics, parseLlmOutput, runWebclaw, verticalForUrl } from "../webclaw-spawn.ts";
import { clearJsNeed, hasJsNeed, jsNeedsRule, recordJsNeed } from "../js-needs.ts";
import { assertAllowedDestination, fetchWithDestinationPolicy, type DestinationFetch, type DestinationPolicy } from "../destination-policy.ts";

export interface WebclawAdapterOptions { timeoutMs?: number; responseBytes?: number; destinationPolicy?: DestinationPolicy; fetchImpl?: DestinationFetch }

const DEFAULT_RESPONSE_BYTES = 50 * 1024 * 1024;

export function createWebclawAdapter(options: WebclawAdapterOptions = {}): Adapter {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    capability: {
      id: "webclaw", operations: ["fetch"], credentials: [], strengths: ["page"], modes: ["page"],
      returns: ["content"], timeoutMs, concurrency: 5, fallbackEligible: true,
      provenance: "docs/adr/0002-internal-architecture/0005-webclaw-extraction-redesign.md",
    },
    async fetch(intent: FetchIntent, ctx: OpContext): Promise<FetchedContent[]> {
      const urls = intent.urls ?? (intent.url ? [intent.url] : []);
      try {
        return await Promise.all(urls.map((url) => fetchOne(url, ctx, options)));
      } catch (error) {
        throw mapFetchFailure(error, ctx.signal);
      }
    },
  };
}

async function fetchOne(url: string, ctx: OpContext, options: WebclawAdapterOptions): Promise<FetchedContent> {
  const root = ctx.root ?? cacheRoot(process.cwd());
  if (ctx.signal?.aborted) throw new ProviderError("aborted", "Fetch aborted by the caller");
  const policy = options.destinationPolicy ?? { allowPrivateHosts: [] };
  const destination = await assertAllowedDestination(url, policy);
  if (destination.privateAllowed) return fetchConfiguredLocal(url, ctx, options, policy);
  if (hasJsNeed(url, root)) throw new ProviderError("unavailable", `js-needs DB routes ${new URL(url).host} to the JS-rendering lane`);

  // Native download/intelligence shapes stay on their handlers.
  if (parseGitHubUrl(url)) {
    try {
      const result = await extractGitHub(url, { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
      if (result) return result;
    } catch (error) {
      if (error instanceof ProviderError && ["aborted", "policy", "invalid_input"].includes(error.failureClass)) throw error;
      // A clone/API failure falls through to webclaw, mirroring the old dispatch contract.
    }
  }
  if (parseYouTubeUrl(url)) return extractYouTube(url, { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
  if (isPDF(url)) return fetchPdf(url, ctx, options);

  const vertical = verticalForUrl(url);
  if (vertical) {
    const verticalResult = await runWebclaw(["vertical", vertical, url], { timeoutMs: ctx.timeoutMs, signal: ctx.signal, destination: { url, policy } });
    if (verticalResult.ok && verticalResult.stdout.trim()) {
      return { url, title: verticalTitle(url, verticalResult.stdout), content: verticalResult.stdout, contentType: "application/json" };
    }
    // Vertical failure falls through to the generic lane — one attempt total, no double cost.
  }

  const result = await runWebclaw([url, "-f", "llm", "-t", String(Math.max(1, Math.ceil(ctx.timeoutMs / 1000)))], { timeoutMs: ctx.timeoutMs, signal: ctx.signal, destination: { url, policy } });
  if (!result.ok) {
    if (ctx.signal?.aborted) throw new ProviderError("aborted", "Fetch aborted by the caller");
    const failure = mapSpawnFailure(result);
    if (failure.failureClass === "unavailable") recordJsNeed(url, { chars: 0, tokens: 0, headings: 0, links: 0, fences: 0, tables: 0, textChars: 0 }, root);
    throw failure;
  }
  const { header, body } = parseLlmOutput(result.stdout);
  const effectiveUrl = header.url ? (await assertAllowedDestination(header.url, policy)).url.href : url;
  const metrics = bodyMetrics(body);
  if (metrics.textChars === 0) {
    recordJsNeed(url, metrics, root);
    throw new ProviderError("empty", `webclaw returned no content for ${url}`);
  }
  if (jsNeedsRule(metrics)) {
    recordJsNeed(url, metrics, root);
    throw new ProviderError("unavailable", `webclaw returned a thin shell for ${url}; JS rendering required`);
  }
  // Self-heal: a rich webclaw success invalidates any (stale) record for this prefix.
  clearJsNeed(url, root);
  return {
    url: effectiveUrl,
    title: header.title ?? effectiveUrl,
    content: body,
    contentType: "text/markdown",
    webclaw: {
      ...(header.description ? { description: header.description } : {}),
      ...(header.author ? { author: header.author } : {}),
      ...(header.language ? { language: header.language } : {}),
      ...(header.wordCount !== undefined && Number.isFinite(header.wordCount) ? { wordCount: header.wordCount } : {}),
    },
  };
}

async function directBytes(url: string, ctx: OpContext, options: WebclawAdapterOptions, policy: DestinationPolicy): Promise<{ bytes: Uint8Array; contentType: string; effectiveUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  try {
    const { response, effectiveUrl } = await fetchWithDestinationPolicy(url, {
      signal,
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36" },
    }, policy, options.fetchImpl);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw classifyHttpFailure(response.status, response.headers.get("retry-after"), errorBody);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > (options.responseBytes ?? DEFAULT_RESPONSE_BYTES)) throw new ProviderError("unavailable", "Content exceeds the responseBytes cap");
    return { bytes, contentType: response.headers.get("content-type")?.toLowerCase() ?? "", effectiveUrl };
  } catch (error) {
    throw mapFetchFailure(error, ctx.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPdf(url: string, ctx: OpContext, options: WebclawAdapterOptions): Promise<FetchedContent> {
  const policy = options.destinationPolicy ?? { allowPrivateHosts: [] };
  const fetched = await directBytes(url, ctx, options, policy);
  return extractPdf(fetched.bytes, fetched.effectiveUrl);
}

async function fetchConfiguredLocal(url: string, ctx: OpContext, options: WebclawAdapterOptions, policy: DestinationPolicy): Promise<FetchedContent> {
  const fetched = await directBytes(url, ctx, options, policy);
  if (isPDF(fetched.effectiveUrl) || fetched.contentType.includes("application/pdf")) return extractPdf(fetched.bytes, fetched.effectiveUrl);
  if (fetched.contentType && !/(?:text\/|json|xml|javascript)/.test(fetched.contentType)) throw new ProviderError("policy", `Configured local destination returned unsupported content type: ${fetched.contentType}`);
  const content = new TextDecoder().decode(fetched.bytes);
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(content)?.[1]?.replace(/\s+/g, " ").trim() || fetched.effectiveUrl;
  return { url: fetched.effectiveUrl, title, content, contentType: fetched.contentType || "text/plain" };
}

export function mapSpawnFailure(result: { stderr: string; code?: number | string }): ProviderError {
  const message = result.stderr.slice(0, 300) || `webclaw exited ${String(result.code)}`;
  if (result.code === "ENOENT")
    return new ProviderError(
      "policy",
      "webclaw binary not found on PATH. Install with `brew install 0xmassi/webclaw/webclaw` (macOS) or the Linux/Windows path in https://github.com/0xMassi/webclaw#install",
      undefined,
      "webclaw is not installed (or not on PATH). macOS: `brew install 0xmassi/webclaw/webclaw`; Linux/Windows: https://github.com/0xMassi/webclaw#install — then retry this same call.",
    );
  if (/bot protection/i.test(message)) return new ProviderError("unavailable", `webclaw reported bot protection: ${message}`);
  if (/not found|404|410/i.test(message)) return new ProviderError("not_found", `webclaw: ${message}`);
  if (/failed to resolve host|dns|ETIMEDOUT|timed out/i.test(message)) return new ProviderError("timeout", `webclaw: ${message}`);
  return new ProviderError("network", `webclaw failed: ${message}`);
}

function verticalTitle(url: string, json: string): string {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    for (const key of ["name", "full_name", "title", "id"]) {
      const value = parsed?.[key];
      if (typeof value === "string" && value) return value;
    }
  } catch { /* malformed vertical JSON keeps the URL title */ }
  return url;
}
