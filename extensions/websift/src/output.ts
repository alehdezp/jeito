// ADR-001.002: output must preserve lead/catalog/fetched evidence rights; see docs/adr/0001-product-and-evidence/0002-tool-surface-and-evidence.md.
import { encodeGcfRecords } from "./gcf.ts";
import { ProviderError } from "./failures.ts";
import type { AnswerResult, Attempt, SearchResult, Source, ToolDetails } from "./types.ts";

export function searchSources(provider: string, results: SearchResult[]): Source[] {
  return results.map((result) => ({ url: result.url, title: result.title, passage: result.snippet, fetched: false, evidenceStatus: "lead", provider }));
}
function xsearchRecords(results: SearchResult[], decorate: (result: SearchResult) => Record<string, unknown> = () => ({})): Record<string, unknown>[] {
  const xsearch = results.find((result) => result.xsearch)?.xsearch;
  if (!xsearch) return results.map((result) => ({ ...decorate(result), ...result }));
  const syntheses = [...new Set(results.flatMap((result) => result.snippet ? [result.snippet] : []))];
  const citations = results.map((result) => {
    const { snippet: _duplicateSynthesis, xsearch: _duplicateEnvelope, ...citation } = result;
    return { ...decorate(result), recordType: "search-result", ...citation };
  });
  return [...citations, ...syntheses.map((text) => ({ recordType: "xsearch-synthesis", text, xsearch }))];
}


export function formatSearch(results: SearchResult[], inlineChars: number): string {
  return encodeGcfRecords(xsearchRecords(results), {
    maxChars: inlineChars,
    comments: ["websift search results are lead-only; fetch surviving sources before citing them."],
    metadata: { evidenceStatus: "lead" },
  });
}


const ANSWER_TRUNCATION = "\n\n…[answer truncated; complete native answer retained in details]";

function boundedAnswerText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= ANSWER_TRUNCATION.length) return "…[answer retained in details]".slice(0, maxChars);
  return `${text.slice(0, maxChars - ANSWER_TRUNCATION.length).trimEnd()}${ANSWER_TRUNCATION}`;
}

function answerSourceRecords(sources: Source[]): Record<string, unknown>[] {
  return sources.map((source, index) => ({ recordType: "source", providerOrder: index + 1, ...source }));
}

function answerSourceIndex(sources: Source[]): Record<string, unknown>[] {
  return sources.map((source, index) => ({
    providerOrder: index + 1,
    title: source.title,
    url: source.url,
    evidenceStatus: source.evidenceStatus,
    provider: source.provider,
  }));
}

/** Keep answer data ahead of provider-ordered source rows; full native data remains in tool details. */
export function formatAnswer(result: AnswerResult, sources: Source[], provider: string, inlineChars: number): string {
  const sourceRecords = answerSourceRecords(sources);
  const evidenceStatus = sources.length === 0 ? "none" : sources.every((source) => source.evidenceStatus === "fetched") ? "fetched" : "provider-citation";
  const metadata = { provider, evidenceStatus, model: result.model, reportedCostUsd: result.reportedCostUsd, sourceRecords: sources.length, sourceIndex: answerSourceIndex(sources) };
  if (result.structuredData !== undefined) {
    return encodeGcfRecords([{ recordType: "answer", data: result.structuredData }, ...sourceRecords], {
      maxChars: inlineChars,
      comments: ["Structured provider answer first; source records retain provider order and evidence status."],
      metadata,
    });
  }

  const cost = result.reportedCostUsd === undefined ? "" : `\n\nProvider-reported cost: $${result.reportedCostUsd.toFixed(6)}`;
  const prose = `${result.answer}${cost}`;
  if (sourceRecords.length === 0) return boundedAnswerText(prose, inlineChars);

  const separator = "\n\nSources (GCF; provider order):\n";
  for (let answerBudget = Math.min(prose.length, inlineChars); answerBudget >= 0; answerBudget = Math.max(0, answerBudget - 256)) {
    const answer = boundedAnswerText(prose, answerBudget);
    const sourceBudget = inlineChars - answer.length - separator.length;
    if (sourceBudget > 0) {
      try {
        const encoded = encodeGcfRecords(sourceRecords, {
          maxChars: sourceBudget,
          comments: ["Provider-returned source records are candidate evidence until independently fetched."],
          metadata,
        });
        return `${answer}${separator}${encoded}`;
      } catch (error) {
        if (!(error instanceof ProviderError) || !error.message.includes("GCF metadata exceeds")) throw error;
      }
    }
    if (answerBudget === 0) break;
  }
  throw new ProviderError("unavailable", `Answer metadata exceeds the ${inlineChars}-character model-visible output budget`);
}

export function detailsForSearch(provider: string, attempts: Attempt[], results: SearchResult[], warnings: string[] = []): ToolDetails {
  return { provider, attempts, sources: searchSources(provider, results), fallbackOccurred: attempts.length > 1, cached: false, warnings, results };
}
