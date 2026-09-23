// ADR-001.003 + accepted W1 §7: public provider specialists; index.ts owns registration.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderWebAnswerExaCall, renderWebAnswerExaResult, renderWebAnswerLinkupCall, renderWebAnswerLinkupResult } from "../ui/tui-render.ts";
import { loadConfig, type WebConfig } from "../config.ts";
import { ProviderError, recoveryAdvice } from "../failures.ts";
import { formatAnswer } from "../output.ts";
import { AdapterRegistry } from "../registry.ts";
import { runWithFallback } from "../routing.ts";
import type { AnswerIntent, AnswerResult, Attempt, ToolDetails } from "../types.ts";

const jsonSchema = Type.Object({}, { additionalProperties: true, description: "JSON Schema Draft 7 object for the answer shape. Shape conformance does not establish factual or per-field correctness." });

const exaParameters = Type.Object({
  question: Type.String({ minLength: 1, description: "Question sent directly to Exa Answer." }),
  text: Type.Optional(Type.Boolean({ description: "Include full citation page text in Exa's native result. Default false because it can greatly expand retained output without improving the answer." })),
  systemPrompt: Type.Optional(Type.String({ description: "Instructions that narrow Exa's answer behavior. They do not make unsupported claims authoritative." })),
  userLocation: Type.Optional(Type.String({ description: "Two-letter ISO country code for location-aware answering." })),
  outputSchema: Type.Optional(jsonSchema),
}, { additionalProperties: false });

const linkupParameters = Type.Object({
  question: Type.String({ minLength: 1, description: "Question sent directly to Linkup sourced Answer." }),
  depth: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("standard"), Type.Literal("deep")], { description: "Linkup depth. Default standard. In the LU09/LU17 matched task, deep used a 9.2× reserve and changed prose/order without semantic repair." })),
  fromDate: Type.Optional(Type.String({ description: "Inclusive YYYY-MM-DD lower bound. Must be before toDate; equal bounds are invalid." })),
  toDate: Type.Optional(Type.String({ description: "Inclusive YYYY-MM-DD upper bound. Must be after fromDate." })),
  includeDomains: Type.Optional(Type.Array(Type.String(), { maxItems: 100, description: "Only consider these domains." })),
  excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Exclude these domains." })),
  includeInlineCitations: Type.Optional(Type.Boolean({ description: "Keep provider-native inline citation markers. Default true." })),
}, { additionalProperties: false });

type ExaParams = { question: string; text?: boolean; systemPrompt?: string; userLocation?: string; outputSchema?: Record<string, unknown> };
type LinkupParams = { question: string; depth?: "fast" | "standard" | "deep"; fromDate?: string; toDate?: string; includeDomains?: string[]; excludeDomains?: string[]; includeInlineCitations?: boolean };

function failed(toolName: string, provider: "exa" | "linkup", error: unknown, attempts: Attempt[], config: WebConfig): { content: [{ type: "text"; text: string }]; details: ToolDetails } {
  const failure = error instanceof ProviderError ? error : new ProviderError("network", error instanceof Error ? error.message : `${provider} answer failed`);
  const recovery = recoveryAdvice(failure, provider, config, "answer");
  return { content: [{ type: "text", text: `${toolName} failed: ${failure.failureClass}. ${failure.message}\nFix: ${recovery.action}` }], details: { provider, attempts, sources: [], fallbackOccurred: false, cached: false, warnings: config.warnings, failureClass: failure.failureClass, recovery } };
}

async function executeAnswer(toolName: string, provider: "exa" | "linkup", intent: AnswerIntent, registry: AdapterRegistry, signal?: AbortSignal): Promise<{ content: [{ type: "text"; text: string }]; details: ToolDetails }> {
  const config = loadConfig();
  try {
    if (!intent.question.trim()) throw new ProviderError("invalid_input", "question is blank");
    const routed = await runWithFallback<AnswerResult>(registry, intent, config, { signal, timeoutMs: config.limits.timeoutMs, persist() {} });
    const sources = routed.value.sources;
    return {
      content: [{ type: "text", text: formatAnswer(routed.value, sources, provider, config.limits.inlineChars) }],
      details: {
        provider, attempts: routed.attempts, sources, fallbackOccurred: false, cached: false,
        warnings: [...config.warnings, ...(sources.some((source) => !source.fetched) ? ["unfetched_sources"] : [])],
        mode: "answer", model: routed.value.model, answer: routed.value.answer,
        structuredData: routed.value.structuredData, nativeResult: routed.value.nativeResult,
        ...(routed.value.reportedCostUsd !== undefined ? { reportedCostUsd: routed.value.reportedCostUsd } : {}),
      },
    };
  } catch (error) {
    return failed(toolName, provider, error, (error as { attempts?: Attempt[] }).attempts ?? [], config);
  }
}

/** Register the two accepted answer specialists. */
export function registerWebAnswerSpecialists(pi: ExtensionAPI, registry: AdapterRegistry): void {
  pi.registerTool({
    name: "web_answer_exa", label: "Exa Answer",
    description: "Get a cited answer on one known entity with optional structure — use when you already have the candidate and need one relationship or field; both Exa and Linkup can help — verify every field by fetching. Pro: `web_answer_exa({question: 'For Sessa 2604.18580 identify the exact repo', outputSchema: {...}})` → one attempt, schema not truth.",
    promptSnippet: "Use web_answer_exa when you have the candidate — one relationship or field, verify every field by fetching.",
    promptGuidelines: [`What it is: one candidate, one relationship — cited answer with optional structure. When: candidate known, gap is one field. Both Exa and Linkup can help — pick the gap, not a winner. How pro calls it: one concrete question + outputSchema for the field you can verify; keep schema small and auditable. Advanced schema use is expected — use it to test a bounded field, not to claim completeness. Evidence: provider-citation until you fetch every decisive page and API; schema conformance is not truth.`],
    parameters: exaParameters,
    renderShell: "self",
    renderCall: renderWebAnswerExaCall as any,
    renderResult: renderWebAnswerExaResult as any,
    async execute(_toolCallId, params: ExaParams, signal) {
      return executeAnswer("web_answer_exa", "exa", {
        operation: "answer", question: params.question, mode: "answer", provider: "exa",
        exa: { text: params.text, systemPrompt: params.systemPrompt, userLocation: params.userLocation, outputSchema: params.outputSchema },
      }, registry, signal);
    },
  });

  pi.registerTool({
    name: "web_answer_linkup", label: "Linkup Answer",
    description: "Get a cited answer constrained by official domains or dates — use when you need one identity-to-evidence chain; both Exa and Linkup can help — start standard, verify after. Pro: `web_answer_linkup({question: 'Locate Toka 2606.01974 and its repo', depth: 'standard', includeDomains: ['arxiv.org','github.com']})` → one attempt, domain/date filtered.",
    promptSnippet: "Use web_answer_linkup when you need one domain/date-constrained chain — start standard, verify after.",
    promptGuidelines: [`What it is: one chain, domain/date constrained. When: you need an official-source or time-bounded answer. Both Exa and Linkup can help — pick the gap, not a winner. How pro calls it: one concrete question + includeDomains/includeInlineCitations/fromDate/toDate; depth standard first, deep only for one named missing field after identity found. Advanced domain/date/depth use is expected — use it to test that chain, not to repair identity. Evidence: provider-citation until you fetch decisive pages/APIs; deep adds cost without proving identity.`],
    parameters: linkupParameters,
    renderShell: "self",
    renderCall: renderWebAnswerLinkupCall as any,
    renderResult: renderWebAnswerLinkupResult as any,
    async execute(_toolCallId, params: LinkupParams, signal) {
      return executeAnswer("web_answer_linkup", "linkup", {
        operation: "answer", question: params.question, mode: "answer", provider: "linkup",
        linkup: { depth: params.depth ?? "standard", fromDate: params.fromDate, toDate: params.toDate, includeDomains: params.includeDomains, excludeDomains: params.excludeDomains, includeInlineCitations: params.includeInlineCitations ?? true },
      }, registry, signal);
    },
  });
}
