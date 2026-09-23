// M3 (2026-08-23): dedicated Context7 documentation tool — split out of web_lookup so
// library-doc retrieval gets a flat parameter surface with no dev knobs (rerank always
// on, excerpts always txt; complete raw body saves regardless).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderContext7Call, renderContext7Result } from "../ui/tui-render.ts";
import { loadConfig } from "../config.ts";
import { ProviderError, recoveryAdvice } from "../failures.ts";
import { AdapterRegistry } from "../registry.ts";
import { runWithFallback } from "../routing.ts";
import type { Attempt, LookupIntent, LookupResult, ToolDetails } from "../types.ts";
import { cacheRoot } from "../fetch-cache.ts";
import { encodeGcfRecords } from "../gcf.ts";

const CONTEXT7_DESCRIPTION = "Get the library's own docs, version-pinned — not blogs. Use when implementing against an API; for general web use `web_search`, for reusable skills/packages use `web_lookup`. Unambiguous names go straight to docs, ambiguous names give a /owner/repo menu — pick one and re-call with library. Pro: `context7({library: \"zod\", query: \"string email validation\", version: \"3.22\"})` → excerpt + saved Cache: .cache/web/docs/... for exact quoting.";

const parameters = Type.Object({
  library: Type.Optional(Type.String({ minLength: 1, description: "Library name — \"zod\", \"react\" — or exact \"/vercel/next.js@14\" id. Unambiguous names go straight to docs; ambiguous names reply with a candidate menu — put your chosen /owner/repo back here and re-call." })),
  query: Type.Optional(Type.String({ minLength: 1, description: "What you need from the docs — \"string email validation\", \"rules of hooks\". Required unless library is already an exact /owner/repo id." })),
  version: Type.Optional(Type.String({ description: "Optional: pin docs to a version the library advertises (\"14.3.0\") so examples match what you installed. Unadvertised versions are refused rather than serving latest." })),
  libraryId: Type.Optional(Type.String({ minLength: 1, description: "Re-call only: the /owner/repo[@version] id from a previous candidate menu — overrides library/version." })),
  mode: Type.Optional(Type.Union([Type.Literal("docs"), Type.Literal("resolve")], { description: "docs (default) retrieves documentation · resolve lists candidates only. You rarely need resolve — ambiguous names are handled automatically." })),
  topic: Type.Optional(Type.String({ description: "Optional: focus on one subtopic of large doc trees (\"cancellation\")." })),
}, { description: CONTEXT7_DESCRIPTION, additionalProperties: false });

type Params = { library?: string; query?: string; version?: string; libraryId?: string; mode?: "docs" | "resolve"; topic?: string };

function formatDocs(results: LookupResult[], inlineChars: number): string {
  const source = "context7" as string;
  const structured = results.filter((result) => result.metadata?.structuredData !== undefined);
  if (structured.length) {
    const records = structured.map((result) => ({
      title: result.title,
      url: result.url,
      description: result.description,
      data: result.metadata?.structuredData,
    }));
    return encodeGcfRecords(records, {
      maxChars: inlineChars,
      comments: ["Context7 structured documentation was retrieved from the provider; the complete raw body is saved to the printed docs path."],
      metadata: {
        source,
        evidenceStatus: "fetched",
        retained: structured.map((result) => ({ title: result.title, docsPath: result.metadata?.docsPath })),
      },
    });
  }
  const versionNotFound = results.some((result) => result.metadata?.versionNotFound);
  if (versionNotFound && source === "context7") {
    const hint = "Requested version is not advertised — no documentation was fetched. Inspect versions[] and re-call with an advertised exact version, or correct the requested version.";
    return encodeGcfRecords(results, { maxChars: Math.max(800, inlineChars - hint.length - 80), comments: [hint, "Catalog records are discovery leads; inspect candidate identity before selecting one."], metadata: { source, evidenceStatus: "catalog", versionNotFound: true } });
  }
  const needsResolution = results.some((result) => result.metadata?.needsResolution);
  const ambiguous = results.length > 1 && needsResolution && !results.some((result) => result.content);
  if (ambiguous) {
    const top = results.slice(0, 3).map((result) => {
    const versions = Array.isArray(result.metadata?.versions) && result.metadata.versions.length ? ` · versions: ${result.metadata.versions.join(", ")}` : "";
    return `${result.metadata?.id ?? result.title} (${result.metadata?.totalSnippets ?? "?"} snippets trust ${result.metadata?.trustScore ?? "?"}${versions})`;
  }).join(" | ");
    const hint = `Multiple libraries match — pick one and put its id back in library. Top: ${top}.`;
    return encodeGcfRecords(results, { maxChars: Math.max(800, inlineChars - hint.length - 80), comments: [hint, "Catalog records are discovery leads; do not select rank one automatically."], metadata: { source, evidenceStatus: "catalog", needsResolution: true } });
  }
  if (results.some((result) => result.content)) {
    return results.map((result, index) => `${index + 1}. ${result.title}${result.url ? `\n   ${result.url}` : ""}${result.description ? `\n   ${result.description}` : ""}${result.content ? `\n\n${result.content}` : ""}`).join("\n\n").slice(0, inlineChars);
  }
  return encodeGcfRecords(results, {
    maxChars: inlineChars,
    comments: ["Catalog records are discovery leads; inspect the linked source before relying on quality, safety, or maintenance claims."],
    metadata: { source, evidenceStatus: "catalog" },
  });
}

export function registerContext7(pi: ExtensionAPI, registry: AdapterRegistry): void {
  pi.registerTool({
    name: "context7",
    label: "Context7 Library Docs",
    description: CONTEXT7_DESCRIPTION,
    parameters,
    renderShell: "self",
    renderCall: renderContext7Call as any,
    renderResult: renderContext7Result as any,
    promptSnippet: "Use context7 when you need the library's own version-pinned docs — not blogs or catalog leads.",
    promptGuidelines: [`What it is: the library's own documentation, version-pinned. When: implementing or debugging an API surface. For general web use web_search, for skills/packages use web_lookup. How pro calls it: context7({library: "zod", query: "string email validation"}) with optional version + topic; ambiguous → pick /owner/repo from the menu. Evidence: excerpt inline + full body saved at Cache: .cache/web/docs/... — grep that path for exact quoting.`],
    async execute(_toolCallId, rawParams: Record<string, unknown>, signal): Promise<{ content: [{ type: "text"; text: string }]; details: ToolDetails }> {
      const params = rawParams as unknown as Params;
      const config = loadConfig();
      try {
        const suppliedQuery = typeof params.query === "string" ? params.query.trim() : "";
        const exactById = Boolean(params.libraryId?.trim()) || (typeof params.library === "string" && params.library.trim().startsWith("/"));
        if (!suppliedQuery && !exactById) {
          const failure = new ProviderError("invalid_input", 'query is required — e.g. {library:"zod", query:"string email validation"} — unless you pass an exact /owner/repo id.');
          const recovery = recoveryAdvice(failure, "context7", config);
          return { content: [{ type: "text", text: `context7 failed: invalid_input. ${failure.message}\nFix: ${recovery.action}` }], details: { provider: "context7", attempts: [], sources: [], fallbackOccurred: false, cached: false, warnings: config.warnings, failureClass: failure.failureClass, recovery } };
        }
        const intent: LookupIntent = {
          operation: "lookup", source: "context7",
          query: suppliedQuery || "overview",
          library: params.library && !params.library.trim().startsWith("/") ? params.library.trim() : undefined,
          version: params.version,
          page: 1,
          provider: "context7",
          context7: {
            ...(params.libraryId?.trim() ? { libraryId: params.libraryId.trim() } : {}),
            ...(params.mode ? { mode: params.mode } : {}),
            ...(params.topic?.trim() ? { topic: params.topic.trim() } : {}),
          },
        };
        const routed = await runWithFallback<LookupResult[]>(registry, intent, config, { signal, timeoutMs: config.limits.timeoutMs, persist() {}, root: cacheRoot(process.cwd()) });
        if (!routed.value.length) {
          const action = "Check the library/query spelling or use resolve mode with a different name; zero candidates bound only this Context7 search, not the ecosystem.";
          return { content: [{ type: "text", text: `Lookup completed: 0 records.\nSource: context7\nQuery: ${JSON.stringify(intent.query)}\nNext: ${action}` }], details: { provider: routed.provider, attempts: routed.attempts, sources: [], fallbackOccurred: false, cached: false, warnings: [...config.warnings], query: intent.query, resultCount: 0, records: [], evidenceStatus: "catalog" as const, recovery: { retryable: true, action } } };
        }
        const evidenceSources = routed.value.map((result) => ({ url: result.url ?? `context7:${result.title}`, title: result.title, passage: result.description ?? result.content?.slice(0, 500), fetched: Boolean(result.content?.trim()), evidenceStatus: (result.content?.trim() ? "fetched" : "catalog") as "fetched" | "catalog", provider: routed.provider }));
        const docsPath = routed.value.find((result) => typeof result.metadata?.docsPath === "string")?.metadata?.docsPath as string | undefined;
        return { content: [{ type: "text", text: formatDocs(routed.value, config.limits.inlineChars) }], details: { provider: routed.provider, attempts: routed.attempts, sources: evidenceSources, fallbackOccurred: routed.attempts.some((attempt) => attempt.status === "failed"), cached: false, warnings: [...config.warnings], records: routed.value, ...(docsPath ? { docsPath } : {}) } };
      } catch (error) {
        const failure = error instanceof ProviderError ? error : new ProviderError("network", error instanceof Error ? error.message : "Context7 lookup failed");
        const attempts = (error as { attempts?: Attempt[] }).attempts ?? [];
        const recovery = recoveryAdvice(failure, "context7", config);
        return { content: [{ type: "text", text: `context7 failed: ${failure.failureClass}. ${failure.message}\nFix: ${recovery.action}` }], details: { provider: "context7", attempts, sources: [], fallbackOccurred: attempts.some((attempt) => attempt.status === "failed"), cached: false, warnings: config.warnings, failureClass: failure.failureClass, recovery } };
      }
    },
  });
}
