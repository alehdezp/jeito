// ADR-001.003 owns the generic answer/specialist split and provider-citation evidence rights.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderWebAnswerCall, renderWebAnswerResult } from "../ui/tui-render.ts";
import { loadConfig, type WebConfig } from "../config.ts";
import { ProviderError, recoveryAdvice } from "../failures.ts";
import { formatAnswer } from "../output.ts";
import { AdapterRegistry } from "../registry.ts";
import { runWithFallback } from "../routing.ts";
import type { AnswerIntent, AnswerResult, Attempt, FailureClass, ToolDetails } from "../types.ts";

const DEFAULT_ANSWER_PROVIDER = "exa";

const parameters = Type.Object({
  question: Type.Optional(Type.String({ minLength: 1, description: "The question, stated concretely — \"what does GCF encoding do?\" returns citable specifics where \"GCF?\" returns generic summaries. Concrete questions make citations worth opening." })),
}, { additionalProperties: false });

type Params = { question?: string };

export function registerWebAnswer(pi: ExtensionAPI, registry: AdapterRegistry): void {
  pi.registerTool({
    name: "web_answer",
    label: "websift Answer",
    description: "Get one quick prose take when a ranked list would slow you — low-stakes orientation, not evidence. For verified claims use `web_search` + `web_fetch` or `$mini-research`/`$research`. Pro: `web_answer({question: 'what does GCF encoding do?'})` → provisional answer + provider-citation to fetch.",
    parameters,
    renderShell: "self",
    renderCall: renderWebAnswerCall as any,
    renderResult: renderWebAnswerResult as any,
    promptSnippet: "Use web_answer for a quick provisional take — fetch citations before relying.",
    promptGuidelines: [`What it is: provisional synthesis, not fetched evidence. When: you need orientation fast. For verified or comparative claims use web_search + web_fetch or $mini-research/$research. How pro calls it: one concrete question. Evidence: answer + citations are provider-citation (fetched:false, evidenceStatus: provider-citation) until you web_fetch them; fetch decisive pages before citing.`],
    async execute(_toolCallId, params: Params, signal): Promise<{ content: [{ type: "text"; text: string }]; details: ToolDetails }> {
      const normalized = params as Record<string, unknown>;
      const config = loadConfig();
      try {
        const question = typeof normalized.question === "string" ? normalized.question.trim() : "";
        if (!question) throw new ProviderError("invalid_input", "question cannot be blank");

        const intent: AnswerIntent = {
          operation: "answer",
          question,
          mode: "answer",
          provider: DEFAULT_ANSWER_PROVIDER,
        };
        const routed = await runWithFallback<AnswerResult>(registry, intent, config, { signal, timeoutMs: config.limits.timeoutMs, persist() {} });
        const sources = routed.value.sources;
        return {
          content: [{ type: "text", text: `Provisional provider answer — fetch decisive citations before relying on it.\n\n${formatAnswer(routed.value, sources, routed.provider, config.limits.inlineChars)}` }],
          details: {
            provider: routed.provider,
            attempts: routed.attempts,
            sources,
            fallbackOccurred: false,
            cached: false,
            warnings: [...config.warnings, ...(sources.some((source) => !source.fetched) ? ["unfetched_sources"] : [])],
            mode: "answer",
            model: routed.value.model,
            answer: routed.value.answer,
            structuredData: routed.value.structuredData,
            nativeResult: routed.value.nativeResult,
            ...(routed.value.reportedCostUsd !== undefined ? { reportedCostUsd: routed.value.reportedCostUsd } : {}),
          },
        };
      } catch (error) {
        const failure = error instanceof ProviderError ? error : new ProviderError("network", error instanceof Error ? error.message : "Answer failed");
        return failed(failure.failureClass, failure.message, (error as { attempts?: Attempt[] }).attempts ?? [], config);
      }
    },
  });
}

function failed(failureClass: FailureClass, message: string, attempts: Attempt[], config: WebConfig): { content: [{ type: "text"; text: string }]; details: ToolDetails } {
  const provider = attempts.at(-1)?.provider ?? DEFAULT_ANSWER_PROVIDER;
  const recovery = recoveryAdvice(new ProviderError(failureClass, message), provider, config, "answer");
  return { content: [{ type: "text", text: `web_answer failed: ${failureClass}. ${message}\nFix: ${recovery.action}` }], details: { provider, attempts, sources: [], fallbackOccurred: false, cached: false, warnings: config.warnings, failureClass, recovery } };
}
