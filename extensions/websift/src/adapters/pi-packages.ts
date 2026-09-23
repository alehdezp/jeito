// ADR-005.001: provider capability policy owns this adapter's contract surface; see docs/adr/0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md.
// Contract derived from pi-package-search@0.1.1 (ec26ed0ec226) — see docs/upstreams/pi-package-search.md.
import { classifyHttpFailure, mapFetchFailure, ProviderError } from "../failures.ts";
import type { Adapter, LookupIntent, LookupResult, OpContext } from "../types.ts";

type FetchLike = typeof fetch;

export function normalizePiPackages(value: unknown): LookupResult[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { objects?: unknown }).objects)) throw new ProviderError("unavailable", "npm registry response shape changed");
  const objects = (value as { objects: Record<string, unknown>[] }).objects;
  if (!objects.length) return [];
  const results = objects.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const pkg = item.package;
    if (!pkg || typeof pkg !== "object" || typeof (pkg as { name?: unknown }).name !== "string") return [];
    const record = pkg as Record<string, unknown>;
    const links = record.links && typeof record.links === "object" ? record.links as Record<string, unknown> : {};
    return [{ title: record.name as string, url: typeof links.npm === "string" ? links.npm : `https://www.npmjs.com/package/${record.name}`, description: typeof record.description === "string" ? record.description : undefined, metadata: { version: record.version, date: record.date, score: typeof item.score === "object" && item.score ? (item.score as Record<string, unknown>).final : item.searchScore, installCommand: `pi install npm:${record.name}` } }];
  });
  if (!results.length) throw new ProviderError("unavailable", "npm package record shape changed");
  return results;
}

export function createPiPackagesAdapter(fetchImpl: FetchLike = fetch): Adapter {
  return {
    capability: {
      id: "pi-packages", operations: ["lookup"], credentials: [], strengths: ["pi-packages"], returns: ["leads"],
      timeoutMs: 20_000, concurrency: 2, fallbackEligible: false, provenance: "docs/upstreams/pi-package-search.md",
    },
    async lookup(intent: LookupIntent, ctx: OpContext): Promise<LookupResult[]> {
      try {
      const url = new URL("https://registry.npmjs.org/-/v1/search");
      url.searchParams.set("text", `keywords:pi-package ${intent.query}`.trim());
      url.searchParams.set("size", String(Math.max(1, Math.min(20, intent.limit ?? 5))));
        const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: ctx.signal });
        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw classifyHttpFailure(response.status, response.headers.get("retry-after"), errorBody);
        }
        const bodyText = await response.text();
        let data: unknown;
        try { data = JSON.parse(bodyText); } catch { throw new ProviderError("unavailable", "npm registry response is not valid JSON"); }
        return normalizePiPackages(data);
      } catch (error) {
        throw mapFetchFailure(error, ctx.signal);
      }
    },
  };
}