// ADR-001.002 owns lead-only search evidence. Owner decision 2026-08-04:
// web_search is the Serper-backed lexical search method; other providers use explicit tools.
// M3 (2026-08-23): advanced-by-default operator grammar, freshness window (default past
// month), aliases removed — one true name per input.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderWebSearchCall, renderWebSearchResult } from "../ui/tui-render.ts";
import { loadConfig } from "../config.ts";
import { ProviderError, recoveryAdvice } from "../failures.ts";
import { detailsForSearch, formatSearch } from "../output.ts";
import { AdapterRegistry } from "../registry.ts";
import { runWithFallback } from "../routing.ts";
import type { SearchIntent, SearchResultList, ToolDetails } from "../types.ts";

const FRESHNESS_VALUES = ["hour", "day", "week", "month", "year", "all"] as const;
/** Agent speaks intent; this table translates to the provider's time-search dialect. */
const FRESHNESS_TBS: Record<(typeof FRESHNESS_VALUES)[number], string | undefined> = {
  hour: "qdr:h",
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
  all: undefined,
};

const parameters = Type.Object({
  query: Type.Optional(Type.String({ minLength: 1, description: `Built like an investigator, not typed like a chat message. Core: 2–6 distinctive terms. Operators combine freely and stack: site:<domain> trust-scope · "exact phrase" pins names/error strings · a OR b synonyms · -noise cuts known clutter · intitle:login targets titles · inurl:docs targets slugs · filetype:pdf specs and papers · after:2025-01-01 / before:2025-06-01 calendar bounds · 2020..2024 numeric ranges · * one-word wildcard. Aim them at the source type you decided closes the question. No regex support. The goal of web searching is to find the most accurate and nowaday update truth, not the one that was true 3 months ago` })),
  freshness: Type.Optional(Type.Union(FRESHNESS_VALUES.map((value) => Type.Literal(value)), { description: "How recent results must be: hour · day · week · month (default — most questions care about the current state) · year · all for evergreen undated sweeps. Stack with after:/before: query bounds when you need calendar precision instead of a relative window." })),
  country: Type.Optional(Type.String({ minLength: 1, description: "Geolocation code (us, gb, in…) steering ranking toward a region. Ranking only — never proof of where content originates." })),
}, { additionalProperties: false });

type Params = { query?: string; freshness?: (typeof FRESHNESS_VALUES)[number]; country?: string };

/** Register the preserved public web_search name as one explicit Serper search method. */
export function registerWebSearch(pi: ExtensionAPI, registry: AdapterRegistry): void {
  pi.registerTool({
    name: "web_search",
    label: "websift Search (Serper)",
    description: "Find public web leads when you don't have URLs yet — 10 ranked pointers, not evidence. Use for discovery; to read known URLs use `web_fetch`, for library docs use `context7`, for skills/packages use `web_lookup`, for a quick take use `web_answer`. Pro: 2–6 terms + one `site:`, `\"phrase\"`, `-noise` or `after:` and `freshness` for recency — e.g. `web_search({query: 'tokio spawn_blocking site:docs.rs', freshness: 'month'})` → leads, fetch before citing.",
    parameters,
    renderShell: "self",
    renderCall: renderWebSearchCall as any,
    renderResult: renderWebSearchResult as any,
    promptSnippet: "Use web_search when you don't have URLs — build 2–6 terms + one operator and freshness, then fetch survivors.",
    promptGuidelines: [`Build with intent: 2–6 distinctive terms + one operator (site:, "phrase", -noise, after:/before:) and freshness (hour/day/week/month/year/all; default month). Advanced combos are expected — use them to probe a missing source class and verify by fetching. Every row is lead-only (evidenceStatus: lead, fetched:false) until web_fetch; zero rows → change one operator or freshness and retry.`],
    async execute(_toolCallId, params: Params, signal): Promise<{ content: [{ type: "text"; text: string }]; details: ToolDetails }> {
      const config = loadConfig();
      const attempts = [];
      let query = "";
      try {
        query = params.query?.trim() ?? "";
        if (!query) throw new ProviderError("invalid_input", "Serper query is blank — provide query e.g. {query: 'tokio spawn_blocking'}");
        if (params.freshness !== undefined && !(params.freshness in FRESHNESS_TBS)) {
          throw new ProviderError("invalid_input", `freshness must be one of: ${FRESHNESS_VALUES.join(", ")}.`);
        }
        const tbs = FRESHNESS_TBS[params.freshness ?? "month"];
        const intent: SearchIntent = {
          operation: "search", query, kind: "general", depth: "standard", strategy: "single",
          provider: "serper", fallbackOnExplicit: false, count: 10,
          serper: { country: params.country, tbs },
        };
        const routed = await runWithFallback<SearchResultList>(registry, intent, config, {
          signal, timeoutMs: config.limits.timeoutMs, persist() { },
        });
        attempts.push(...routed.attempts);
        const envelope = routed.value.serper ?? routed.value.find((result) => result.serper)?.serper;
        const warnings = [...config.warnings, ...(envelope?.warnings ?? [])];
        const details = detailsForSearch("serper", routed.attempts, routed.value, warnings);
        if (envelope) details.serper = envelope;
        if (!routed.value.length) {
          const constrained = /\bsite:|["“”]|\b(?:19|20)\d{2}\b|(?:^|\s)-\S/.test(query);
          const action = constrained
            ? "Remove one site:, quoted phrase, year, or exclusion; keep 2–6 distinctive terms and search again."
            : "Keep 2–6 distinctive terms, add exactly one site:, quoted identity, year, or exclusion, and search again.";
          details.query = query;
          details.resultCount = 0;
          details.recovery = { retryable: true, action };
          return { content: [{ type: "text", text: `Search completed: 0 organic results.\nQuery: ${JSON.stringify(query)}\nNext: ${action}` }], details };
        }
        return { content: [{ type: "text", text: formatSearch(routed.value, config.limits.inlineChars) }], details };
      } catch (error) {
        const failure = error instanceof ProviderError ? error : new ProviderError("network", error instanceof Error ? error.message : "Serper search failed");
        const failureAttempts = (error as { attempts?: typeof attempts }).attempts ?? attempts;
        const recovery = recoveryAdvice(failure, "serper", config, "search");
        const receipt = query ? `\nQuery: ${JSON.stringify(query)}` : "";
        return {
          content: [{ type: "text", text: `web_search failed: ${failure.failureClass}. ${failure.message}${receipt}\nFix: ${recovery.action}` }],
          details: { provider: "serper", attempts: failureAttempts, sources: [], fallbackOccurred: false, cached: false, warnings: config.warnings, failureClass: failure.failureClass, recovery, ...(query ? { query } : {}) },
        };
      }
    },
  });
}
