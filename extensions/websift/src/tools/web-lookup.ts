// M3 (2026-08-23): web_lookup narrowed to catalog discovery (SkillsMP + pi-packages).
// Official version-pinned library documentation moved to the dedicated `context7` tool.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderWebLookupCall, renderWebLookupResult } from "../ui/tui-render.ts";
import { loadConfig } from "../config.ts";
import { ProviderError, recoveryAdvice } from "../failures.ts";
import { AdapterRegistry } from "../registry.ts";
import { runWithFallback } from "../routing.ts";
import type { Attempt, LookupIntent, LookupResult, LookupResultList, SkillsMpRateLimits, Source, ToolDetails } from "../types.ts";
import { cacheRoot } from "../fetch-cache.ts";
import { encodeGcfRecords } from "../gcf.ts";

const parameters = Type.Object({
  source: Type.Optional(Type.Union(
    [Type.Literal("skillsmp"), Type.Literal("pi-packages")],
    { description: "Which catalog: skillsmp = community agent-skills · pi-packages = npm package discovery. Pick by what you're hunting: reusable skills vs installable packages." },
  )),
  query: Type.Optional(Type.String({ minLength: 1, description: "What the tool should find (code review, typebox). Required. Keyword-shaped indexes: mutate one term at a time when results miss." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Results per page — skillsmp ≤100 (default 20) · pi-packages ≤20 (default 5). Tune up for surveys, down for targeted picks." })),
  page: Type.Optional(Type.Integer({ minimum: 1, description: "Result page for continued browsing." })),
  sortBy: Type.Optional(Type.Union([Type.Literal("stars"), Type.Literal("recent")], { description: "skillsmp: stars popularity vs recent maintenance novelty. Neither proves quality." })),
  category: Type.Optional(Type.String({ description: "skillsmp category slug (data-ai, devops) — narrows the firehose to your domain." })),
  occupation: Type.Optional(Type.String({ description: "skillsmp SOC occupation slug (software-developers)." })),
  language: Type.Optional(Type.String({ description: "skillsmp content-language ISO code (en, zh, ja; mul mixed, und undetermined)." })),
}, { description: "Search two curated catalogs and get lead records worth vetting — SkillsMP community agent-skills and npm packages. Use `source: skillsmp` when you are hunting a reusable skill (agent skill, `category`/`occupation`/`language` narrows it); use `source: pi-packages` when you are hunting an installable `npm` package. For official version-pinned library docs use `context7`, not this tool.", additionalProperties: false });

type Params = { source: "skillsmp" | "pi-packages"; query?: string; limit?: number; page?: number; sortBy?: "stars" | "recent"; category?: string; occupation?: string; language?: string };

function formatCatalogLeads(results: LookupResult[], inlineChars: number): string {
  const withRecency = results.map((result) => {
    const updated = result.metadata?.updatedAt;
    if (typeof updated !== "string" || !result.description) return result;
    return { ...result, description: `${result.description} · updated ${updated}` };
  });
  results = withRecency;
  return encodeGcfRecords(results, {
    maxChars: inlineChars,
    comments: ["Catalog records are discovery leads; inspect the linked source before relying on quality, safety, or maintenance claims.", "Next: web_fetch the top URL for README/license/maintenance before install."],
    metadata: { evidenceStatus: "catalog" },
  });
}

export function registerWebLookup(pi: ExtensionAPI, registry: AdapterRegistry): void {
  pi.registerTool({
    name: "web_lookup",
    label: "websift Lookup",
    description: "Search two curated catalogs and get lead records worth vetting — SkillsMP community agent-skills and npm packages. Use `source: skillsmp` when hunting a reusable skill (agent skill, `category`/`occupation`/`language` narrows it); use `source: pi-packages` when hunting an installable `npm` package. For official version-pinned library docs use `context7`, not this tool. Pro: `web_lookup({source:'pi-packages', query:'typebox'})` → lead records, then `web_fetch` the top URL to vet README/license before install.",
    parameters,
    renderShell: "self",
    renderCall: renderWebLookupCall as any,
    renderResult: renderWebLookupResult as any,
    promptSnippet: "Use web_lookup for catalog discovery — source: skillsmp for reusable skills (category/occupation/language narrow it), pi-packages for installable npm packages; vet license/scripts/maintenance through the linked source before recommending.",
    promptGuidelines: [`What it is: catalog leads for reusable skills/packages — not library docs. When: you need an existing solution. For library docs use context7, for general web use web_search. How pro calls it: one distinctive term + narrow filters; advanced filters (category/occupation/language, stars vs recent) are expected — use them to probe a missing class. Evidence: catalog (fetched:false, evidenceStatus: catalog) — stars = popularity, never safety; zero rows → change one term or filter and retry.`],
    async execute(_toolCallId, params: Params, signal): Promise<{ content: [{ type: "text"; text: string }]; details: ToolDetails }> {
      const config = loadConfig();
      if (!params.query || !params.query.trim()) {
        const failure = new ProviderError("invalid_input", `${params.source} requires query — e.g. {source:"${params.source}", query:"code review"}.`);
        const recovery = recoveryAdvice(failure, params.source, config);
        return { content: [{ type: "text", text: `web_lookup failed: invalid_input. ${failure.message}\nFix: ${recovery.action}` }], details: { provider: params.source, attempts: [], sources: [], fallbackOccurred: false, cached: false, warnings: config.warnings, failureClass: failure.failureClass, recovery } };
      }
      const ownedKeys = new Set(params.source === "skillsmp"
        ? ["source","query","limit","page","sortBy","category","occupation","language"]
        : ["source","query","limit","page"]);
      const extras = Object.keys(params as unknown as Record<string, unknown>).filter((key) => !ownedKeys.has(key) && (params as unknown as Record<string, unknown>)[key] !== undefined)
        .map((key) => `${key} is not used by ${params.source} — ignored`);
      const limitCap = params.source === "skillsmp" ? 100 : 20;
      if (params.limit !== undefined && (params.limit < 1 || params.limit > limitCap)) {
        const failure = new ProviderError("invalid_input", `limit must be between 1 and ${limitCap} for ${params.source}.`);
        const recovery = recoveryAdvice(failure, params.source, config);
        return { content: [{ type: "text", text: `web_lookup failed: invalid_input. ${failure.message}\nFix: ${recovery.action}` }], details: { provider: params.source, attempts: [], sources: [], fallbackOccurred: false, cached: false, warnings: config.warnings, failureClass: failure.failureClass, recovery } };
      }
      const intent: LookupIntent = {
        operation: "lookup", source: params.source, query: params.query,
        library: undefined, version: undefined,
        page: Math.max(1, Math.floor(params.page ?? 1)),
        limit: params.limit,
        sortBy: params.source === "skillsmp" ? params.sortBy : undefined,
        category: params.source === "skillsmp" ? params.category : undefined,
        occupation: params.source === "skillsmp" ? params.occupation : undefined,
        language: params.source === "skillsmp" ? params.language : undefined,
        provider: params.source,
      };
      if (typeof (params as any).limit === "string" && (params as any).limit.trim()) (params as any).limit = Number((params as any).limit);
      if (typeof (params as any).page === "string" && (params as any).page.trim()) (params as any).page = Number((params as any).page);
      try {
        const routed = await runWithFallback<LookupResult[]>(registry, intent, config, { signal, timeoutMs: config.limits.timeoutMs, persist() {}, root: cacheRoot(process.cwd()) });
        const skillsmp = (routed.value as LookupResultList).skillsmp ?? routed.value[0]?.metadata?.skillsmp as { effective?: Record<string, unknown>; rateLimits?: SkillsMpRateLimits } | undefined;
        const zeroReceipts: Record<Params["source"], { action: string }> = {
          skillsmp: { action: "Mutate one term or filter at a time before concluding absence; catalog indexing is keyword-shaped, so zero rows bound only this catalog/query." },
          "pi-packages": { action: "Try a different keyword or looser terms; zero objects bound only this npm query, not package existence." },
        };
        if (!routed.value.length) {
          const mutation = zeroReceipts[params.source].action;
          return { content: [{ type: "text", text: `Lookup completed: 0 records.\nSource: ${params.source}\nQuery: ${JSON.stringify(intent.query)}\nNext: ${mutation}` }], details: {
            provider: routed.provider, attempts: routed.attempts, sources: [], fallbackOccurred: false, cached: false,
            warnings: [...config.warnings, ...extras], query: intent.query, resultCount: 0, records: [], evidenceStatus: "catalog", recovery: { retryable: true, action: mutation },
            ...(skillsmp?.rateLimits ? { rateLimits: skillsmp.rateLimits } : {}), ...(skillsmp?.effective ? { lookupControls: skillsmp.effective } : {}),
          } };
        }
        const sources: Source[] = routed.value.map((result) => ({ url: result.url ?? `${params.source}:${result.title}`, title: result.title, passage: result.description ?? result.content?.slice(0, 500), fetched: false, evidenceStatus: "catalog" as const, provider: routed.provider }));
        return { content: [{ type: "text", text: formatCatalogLeads(routed.value, config.limits.inlineChars) }], details: { provider: routed.provider, attempts: routed.attempts, sources, fallbackOccurred: routed.attempts.some((attempt) => attempt.status === "failed"), cached: false, warnings: [...config.warnings, ...extras], records: routed.value, ...(skillsmp?.rateLimits ? { rateLimits: skillsmp.rateLimits } : {}), ...(skillsmp?.effective ? { lookupControls: skillsmp.effective } : {}) } };
      } catch (error) {
        const failure = error instanceof ProviderError ? error : new ProviderError("network", error instanceof Error ? error.message : "Lookup failed");
        const recovery = recoveryAdvice(failure, params.source, config);
        const attempts = (error as { attempts?: Attempt[] }).attempts ?? [];
        return { content: [{ type: "text", text: `web_lookup failed: ${failure.failureClass}. ${failure.message}\nFix: ${recovery.action}` }], details: { provider: params.source, attempts, sources: [], fallbackOccurred: attempts.some((attempt) => attempt.status === "failed"), cached: false, warnings: config.warnings, failureClass: failure.failureClass, recovery } };
      }
    },
  });
}
