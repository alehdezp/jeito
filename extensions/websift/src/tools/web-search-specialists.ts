// ADR-001.003 + accepted W1 §7: public provider specialists; index.ts owns registration.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderWebSearchExaCall, renderWebSearchExaResult, renderWebSearchTavilyCall, renderWebSearchTavilyResult, renderWebSearchXCall, renderWebSearchXResult } from "../ui/tui-render.ts";
import { isValidCalendarDate } from "../adapters/xsearch.ts";
import { loadConfig, type WebConfig } from "../config.ts";
import { ProviderError, recoveryAdvice } from "../failures.ts";
import { detailsForSearch, formatSearch } from "../output.ts";
import { AdapterRegistry } from "../registry.ts";
import { runWithFallback } from "../routing.ts";
import type { Attempt, ExaSearchEnvelope, SearchIntent, SearchResult, SearchResultList, TavilySearchEnvelope, ToolDetails, XSearchEnvelope } from "../types.ts";

const searchTypes = Type.Union([
  Type.Literal("keyword"), Type.Literal("neural"), Type.Literal("auto"), Type.Literal("hybrid"), Type.Literal("fast"),
  Type.Literal("instant"), Type.Literal("deep-lite"), Type.Literal("deep"), Type.Literal("deep-reasoning"),
], { description: "Exa retrieval mode. Exact identities usually need keyword plus exact filters; semantic modes broaden unfamiliar vocabulary. Deep modes spend more latency/cost and are not globally better." });

const exaParameters = Type.Object({
  query: Type.String({ minLength: 1, description: "Search query sent to Exa." }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Returned lead count. Default 10." })),
  searchType: Type.Optional(searchTypes),
  category: Type.Optional(Type.Union([Type.Literal("company"), Type.Literal("publication"), Type.Literal("news"), Type.Literal("personal site"), Type.Literal("financial report"), Type.Literal("people")], { description: "Exa source-category focus, not an exact result-class guarantee. company/people cannot combine with publication bounds or excludeDomains." })),
  publishedWithinDays: Type.Optional(Type.Number({ minimum: 1, description: "Request links published within the last N days unless startPublishedDate is set. Exa documents this as a hard bound, but returned dates still require caller verification." })),
  startPublishedDate: Type.Optional(Type.String({ description: "Inclusive YYYY-MM-DD publication lower bound. Exa documents this as hard; verify returned publishedAt because a retained call violated it." })),
  endPublishedDate: Type.Optional(Type.String({ description: "Inclusive YYYY-MM-DD publication upper bound. Exa documents this as hard; verify returned publishedAt." })),
  includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Only consider these domains." })),
  excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Provider hard exclusion. Not compatible with company/people categories." })),
  includeText: Type.Optional(Type.String({ description: "Require one phrase of at most five words in result text." })),
  excludeText: Type.Optional(Type.String({ description: "Exclude one phrase of at most five words from result text." })),
  returnFullText: Type.Optional(Type.Boolean({ description: "Return bounded page text instead of query-relevant highlights." })),
  maxCharacters: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum text characters per result; setting it requests full text." })),
  userLocation: Type.Optional(Type.String({ pattern: "^[A-Za-z]{2}$", description: "Two-letter ISO country code for location-aware search." })),
  moderation: Type.Optional(Type.Boolean({ description: "Ask Exa to moderate results." })),
  systemPrompt: Type.Optional(Type.String({ description: "Instructions for Exa search/synthesis, especially deep modes." })),
  additionalQueries: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 5, description: "Alternative query formulations; accepted only by deep-lite, deep, and deep-reasoning." })),
}, { additionalProperties: false });

const xParameters = Type.Object({
  query: Type.String({ minLength: 1, description: "Question for first-hand X discovery and bounded Grok synthesis." }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum citation URLs returned to the caller. This local cap does not reduce upstream x_search work. Default 10." })),
  allowedHandles: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Only consider posts from these X handles. Leading @ and whitespace are normalized with a visible warning. Mutually exclusive with excludedHandles." })),
  excludedHandles: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Exclude posts from these X handles. Leading @ and whitespace are normalized with a visible warning. Mutually exclusive with allowedHandles." })),
  fromDate: Type.Optional(Type.String({ description: "Inclusive YYYY-MM-DD lower bound." })),
  toDate: Type.Optional(Type.String({ description: "Inclusive YYYY-MM-DD upper bound." })),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Bound Responses API turns; not a direct x_search-call ceiling." })),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Bound requested output tokens; not a direct x_search-call ceiling." })),
  parallelToolCalls: Type.Optional(Type.Boolean({ description: "Allow xAI tool calls in parallel. In one matched narrow task true used 4 x_search calls/14,586 tokens versus false at 1/6,442 and made a window error; prefer false when bounded work and chronology matter. This is task-scoped evidence, not a universal quality ranking." })),
  enableImageUnderstanding: Type.Optional(Type.Boolean({ description: "Allow image understanding for a genuinely visual claim. One matched pair changed citations/work but not the decision, and returned synthesis rather than inspectable image evidence." })),
}, { additionalProperties: false });

const tavilyParameters = Type.Object({
  query: Type.String({ minLength: 1, description: "Search query sent to Tavily basic general search." }),
  country: Type.Optional(Type.String({ minLength: 1, description: "Full country name used as Tavily's ranking boost. One matched India task added a decision-relevant primary document; treat the control as provisional outside that task shape." })),
}, { additionalProperties: false });

type ExaParams = {
  query: string; count?: number; searchType?: "keyword" | "neural" | "auto" | "hybrid" | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning";
  category?: NonNullable<SearchIntent["exa"]>["category"]; publishedWithinDays?: number; startPublishedDate?: string; endPublishedDate?: string;
  includeDomains?: string[]; excludeDomains?: string[]; includeText?: string; excludeText?: string; returnFullText?: boolean; maxCharacters?: number;
  userLocation?: string; moderation?: boolean; systemPrompt?: string; additionalQueries?: string[];
};
type XParams = {
  query: string; count?: number; allowedHandles?: string[]; excludedHandles?: string[]; fromDate?: string; toDate?: string;
  maxTurns?: number; maxOutputTokens?: number; parallelToolCalls?: boolean; enableImageUnderstanding?: boolean;
};
type TavilyParams = { query: string; country?: string };

function exactDates(start: string | undefined, end: string | undefined, provider: string): void {
  for (const [field, value] of [["start", start], ["end", end]] as const)
    if (value !== undefined && !isValidCalendarDate(value)) throw new ProviderError("invalid_input", `${provider} ${field} date must be a valid YYYY-MM-DD calendar date`);
  if (start && end && start > end) throw new ProviderError("invalid_input", `${provider} start date must not be after end date`);
}

function failedSearch(toolName: string, provider: "exa" | "xsearch" | "tavily", error: unknown, attempts: Attempt[], config: WebConfig): { content: [{ type: "text"; text: string }]; details: ToolDetails } {
  const failure = error instanceof ProviderError ? error : new ProviderError("network", error instanceof Error ? error.message : `${provider} search failed`);
  const recovery = recoveryAdvice(failure, provider, config, "search");
  return { content: [{ type: "text", text: `${toolName} failed: ${failure.failureClass}. ${failure.message}\nFix: ${recovery.action}` }], details: { provider, attempts, sources: [], fallbackOccurred: false, cached: false, warnings: config.warnings, failureClass: failure.failureClass, recovery } };
}

function effectiveControlsText(provider: "exa" | "xsearch" | "tavily", intent: SearchIntent): string {
  if (provider === "exa") {
    const parts = [`searchType=${intent.exa?.searchType ?? "auto"}`];
    if (intent.exa?.category) parts.push(`category=${intent.exa.category}`);
    if (intent.exa?.publishedWithinDays) parts.push(`publishedWithinDays=${intent.exa.publishedWithinDays}`);
    if (intent.recency?.from) parts.push(`startPublishedDate=${intent.recency.from}`);
    if (intent.recency?.to) parts.push(`endPublishedDate=${intent.recency.to}`);
    if (intent.domains?.include?.length) parts.push(`includeDomains=[${intent.domains.include.join(",")}]`);
    if (intent.domains?.exclude?.length) parts.push(`excludeDomains=[${intent.domains.exclude.join(",")}]`);
    if (intent.exa?.includeText) parts.push(`includeText="${intent.exa.includeText}"`);
    if (intent.exa?.excludeText) parts.push(`excludeText="${intent.exa.excludeText}"`);
    return parts.join(", ");
  }
  if (provider === "xsearch") {
    const parts: string[] = [];
    if (intent.recency?.from) parts.push(`fromDate=${intent.recency.from}`);
    if (intent.recency?.to) parts.push(`toDate=${intent.recency.to}`);
    if (intent.xsearch?.allowedHandles?.length) parts.push(`allowedHandles=[${intent.xsearch.allowedHandles.join(",")}]`);
    if (intent.xsearch?.excludedHandles?.length) parts.push(`excludedHandles=[${intent.xsearch.excludedHandles.join(",")}]`);
    return parts.length ? parts.join(", ") : "no date/handle controls";
  }
  return intent.tavily?.country ? `country=${intent.tavily.country}` : "no country control";
}

function zeroMutation(provider: "exa" | "xsearch" | "tavily"): string {
  if (provider === "exa") return "First simplify an overloaded exact-identity query; otherwise change exactly one mode, vocabulary, source class, date, or domain dimension. Never repeat unchanged.";
  if (provider === "xsearch") return "Widen the event window or authority scope once (for example add one day on each side or drop the handle restriction); never repeat unchanged and never infer post existence from this zero.";
  return "Change one regional, source-language, or independent-guide hypothesis; keep the fixed basic method and 10-lead cap. Never repeat unchanged.";
}

function zeroSearchReceipt(
  provider: "exa" | "xsearch" | "tavily",
  intent: SearchIntent,
  routed: { attempts: Attempt[] },
  envelope: { exa?: ExaSearchEnvelope; xsearch?: XSearchEnvelope; tavily?: TavilySearchEnvelope },
  warnings: string[],
): { content: [{ type: "text"; text: string }]; details: ToolDetails } {
  const action = zeroMutation(provider);
  const adjudication = provider === "exa" ? envelope.exa?.adjudication : undefined;
  const head = adjudication
    ? `Search completed: 0 qualifying results (provider returned ${adjudication.providerCount}; ${adjudication.qualifyingCount} qualifying; ${adjudication.unverifiableCount} unverifiable).`
    : provider === "xsearch"
      ? "Search completed: 0 cited X posts. Zero citations means no retrieved cited X evidence under this request — not absence of a post or event."
      : "Search completed: 0 results.";
  const rejected = adjudication?.rejected.length ? `\nRejected: ${adjudication.rejected.map((entry) => `${entry.reason} (${entry.count})`).join("; ")}.` : "";
  const synthesis = provider === "xsearch" && envelope.xsearch?.synthesis ? `\nProvider synthesis: ${envelope.xsearch.synthesis.slice(0, 800)}${envelope.xsearch.synthesis.length > 800 ? "…" : ""}` : "";
  const text = `${head}\nQuery: ${JSON.stringify(intent.query)}\nControls: ${effectiveControlsText(provider, intent)}${rejected}${synthesis}\nNext: ${action}`;
  const details = detailsForSearch(provider, routed.attempts, [], warnings);
  details.query = intent.query;
  details.resultCount = 0;
  details.recovery = { retryable: true, action };
  if (adjudication) details.exaAdjudication = adjudication;
  if (provider === "exa" && envelope.exa?.reportedCostUsd !== undefined) details.reportedCostUsd = envelope.exa.reportedCostUsd;
  if (provider === "xsearch" && envelope.xsearch) details.xsearch = envelope.xsearch;
  if (provider === "tavily" && envelope.tavily) {
    details.tavily = envelope.tavily;
    if (envelope.tavily.usageCredits !== undefined) details.reportedUsageCredits = envelope.tavily.usageCredits;
  }
  return { content: [{ type: "text", text }], details };
}

async function executeSearch(toolName: string, provider: "exa" | "xsearch" | "tavily", intent: SearchIntent, registry: AdapterRegistry, signal?: AbortSignal): Promise<{ content: [{ type: "text"; text: string }]; details: ToolDetails }> {
  const config = loadConfig();
  try {
    const routed = await runWithFallback<SearchResult[]>(registry, intent, config, { signal, timeoutMs: config.limits.timeoutMs, persist() {} });
    const list = routed.value as SearchResultList;
    const exa = list.exa ?? routed.value.find((result) => result.exa)?.exa;
    const xsearch = list.xsearch ?? routed.value.find((result) => result.xsearch)?.xsearch;
    const tavily = list.tavily ?? routed.value.find((result) => result.tavily)?.tavily;
    if (!routed.value.length) return zeroSearchReceipt(provider, intent, routed, { exa, xsearch, tavily }, [...config.warnings, ...(xsearch?.warnings ?? [])]);
    const warnings = [...config.warnings, ...(xsearch?.warnings ?? [])];
    const details = detailsForSearch(provider, routed.attempts, routed.value, warnings);
    if (exa) {
      details.reportedCostUsd = exa.reportedCostUsd;
      if (exa.adjudication) details.exaAdjudication = exa.adjudication;
    }
    if (xsearch) details.xsearch = xsearch;
    if (tavily) {
      details.tavily = tavily;
      if (tavily.usageCredits !== undefined) details.reportedUsageCredits = tavily.usageCredits;
    }
    let text = formatSearch(routed.value, config.limits.inlineChars);
    if (exa?.adjudication && (exa.adjudication.rejected.length > 0 || exa.adjudication.unverifiableCount > 0)) {
      const verdict = exa.adjudication;
      const rejected = verdict.rejected.map((entry) => `${entry.reason} (${entry.count})`).join("; ");
      text += `\n\nExa local adjudication: ${verdict.providerCount} returned, ${verdict.qualifyingCount} qualifying, ${verdict.unverifiableCount} unverifiable${rejected ? `; rejected: ${rejected}` : ""}.`;
    }
    return { content: [{ type: "text", text }], details };
  } catch (error) {
    return failedSearch(toolName, provider, error, (error as { attempts?: Attempt[] }).attempts ?? [], config);
  }
}

/** Register the three retained explicit one-provider search methods. */
export function registerWebSearchSpecialists(pi: ExtensionAPI, registry: AdapterRegistry): void {
  pi.registerTool({
    name: "web_search_exa", label: "Exa Search",
    description: "Try a different retrieval shape on the same question — lexical, semantic or filtered. Use when wording, date, domain or text filter is the miss; both Exa and Tavily can help on the same question — verify by fetching. Pro: `web_search_exa({query: 'Sessa 2604.18580', searchType: 'keyword', includeDomains: ['arxiv.org']})` → leads; advanced modes (neural/hybrid/deep) are expected probes, not upgrades.",
    promptSnippet: "Use web_search_exa to test a different query shape — keyword for exact identity, neural/hybrid/deep to probe a vocabulary or expansion gap; verify by fetching.",
    promptGuidelines: [`What it is: same question, different retrieval shape. When: lexical missed due to wording, or you need an exact date/domain/text filter or a semantic expansion. Both Exa and Tavily can help — pick the gap you need to test, not a winner. How pro calls it: one identity for keyword, mechanism + artifact for neural/hybrid, one multi-query bundle for deep-lite/deep/deep-reasoning. Advanced combos are expected — use category, publishedWithinDays/start/end, includeDomains/excludeDomains, includeText/excludeText to test a missing class. Evidence: lead-only until web_fetch; fetch survivors and re-query with one changed dimension on miss.`],
    parameters: exaParameters,
    renderShell: "self",
    renderCall: renderWebSearchExaCall as any,
    renderResult: renderWebSearchExaResult as any,
    async execute(_toolCallId, params: ExaParams, signal) {
      try {
        const query = params.query.trim();
        if (!query) throw new ProviderError("invalid_input", "Exa query is blank");
        exactDates(params.startPublishedDate, params.endPublishedDate, "Exa");
        const searchType = params.searchType ?? "auto";
        if (params.additionalQueries?.length && !["deep-lite", "deep", "deep-reasoning"].includes(searchType)) throw new ProviderError("invalid_input", "Exa additionalQueries require searchType deep-lite, deep, or deep-reasoning");
        if (["company", "people"].includes(params.category ?? "") && (params.publishedWithinDays !== undefined || params.startPublishedDate !== undefined || params.endPublishedDate !== undefined || Boolean(params.excludeDomains?.length))) {
          throw new ProviderError("invalid_input", "Exa category company/people cannot combine with publication bounds or excludeDomains; remove the incompatible filters or choose another category");
        }
        return await executeSearch("web_search_exa", "exa", {
          operation: "search", query, kind: "general", depth: "standard", strategy: "single", provider: "exa", fallbackOnExplicit: false,
          count: params.count ?? 10, recency: { from: params.startPublishedDate, to: params.endPublishedDate }, domains: { include: params.includeDomains, exclude: params.excludeDomains },
          exa: { searchType, category: params.category, publishedWithinDays: params.publishedWithinDays, includeText: params.includeText, excludeText: params.excludeText, returnFullText: params.returnFullText, maxCharacters: params.maxCharacters, userLocation: params.userLocation, moderation: params.moderation, systemPrompt: params.systemPrompt, additionalQueries: params.additionalQueries },
        }, registry, signal);
      } catch (error) {
        return failedSearch("web_search_exa", "exa", error, [], loadConfig());
      }
    },
  });

  pi.registerTool({
    name: "web_search_x", label: "X Search",
    description: "Find first-hand X posts when the post itself is evidence — announcements, chronology, account provenance. Use with an event window and handles; zero citations is not absence. Pro: `web_search_x({query: 'cited posts announcing the release', fromDate: '2026-07-01', allowedHandles: ['project']})` → leads + synthesis, verify timestamps.",
    promptSnippet: "Use web_search_x when the X post itself is evidence — event window + handles, verify timestamps.",
    promptGuidelines: [`What it is: first-hand X evidence, not general web truth. When: you need who posted what when. How pro calls it: event-covering window (fromDate/toDate) + allowedHandles or excludedHandles, count limits returned URLs only. Advanced handle/date work is expected — use it to test provenance, not to boost authority. Evidence: synthesis + citations are leads until you open the post; zero citations is no retrieved evidence, not absence; verify timestamps and media directly.`],
    parameters: xParameters,
    renderShell: "self",
    renderCall: renderWebSearchXCall as any,
    renderResult: renderWebSearchXResult as any,
    async execute(_toolCallId, params: XParams, signal) {
      return executeSearch("web_search_x", "xsearch", {
        operation: "search", query: params.query.trim(), kind: "social", depth: "standard", strategy: "single", provider: "xsearch", fallbackOnExplicit: false,
        count: params.count ?? 10, recency: { from: params.fromDate, to: params.toDate },
        xsearch: { allowedHandles: params.allowedHandles, excludedHandles: params.excludedHandles, maxTurns: params.maxTurns, maxOutputTokens: params.maxOutputTokens, parallelToolCalls: params.parallelToolCalls, enableImageUnderstanding: params.enableImageUnderstanding },
      }, registry, signal);
    },
  });

  pi.registerTool({
    name: "web_search_tavily", label: "Tavily Search",
    description: "Try an alternative general lane when you need independent guides or a regional angle the first search missed. Use one focused query + optional full country name; both Serper and Tavily can help — verify after. Pro: `web_search_tavily({query: 'IndiaAI Safety technical guide', country: 'india'})` → leads.",
    promptSnippet: "Use web_search_tavily to test an alternative general lane — one focused query + optional country; verify after.",
    promptGuidelines: [`What it is: same question, alternative general index. When: first lane missed independent guides or a regional source class. Both Serper and Tavily can help — pick the gap, not a winner. How pro calls it: one focused query + full country name only when region matters; basic/general and 10 leads are fixed. Advanced breadth is expected — one focused, well-formed query is the pro move; verify survivors by fetching.`],
    parameters: tavilyParameters,
    renderShell: "self",
    renderCall: renderWebSearchTavilyCall as any,
    renderResult: renderWebSearchTavilyResult as any,
    async execute(_toolCallId, params: TavilyParams, signal) {
      try {
        const query = params.query.trim();
        if (!query) throw new ProviderError("invalid_input", "Tavily query is blank");
        return await executeSearch("web_search_tavily", "tavily", {
          operation: "search", query, kind: "general", depth: "standard", strategy: "single",
          provider: "tavily", fallbackOnExplicit: false, count: 10,
          tavily: { searchDepth: "basic", country: params.country },
        }, registry, signal);
      } catch (error) {
        return failedSearch("web_search_tavily", "tavily", error, [], loadConfig());
      }
    },
  });
}
