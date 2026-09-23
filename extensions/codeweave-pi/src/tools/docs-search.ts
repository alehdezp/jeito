import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";

import { harnessEnvelope } from "../core/harness-result.ts";
import { validateFrontmatterRelationships } from "../core/frontmatter-relationships.ts";
import { cloneMarkdownFrontmatterExposureState, commitMarkdownFrontmatterExposure, createMarkdownFrontmatterExposureState, MARKDOWN_FRONTMATTER_BUDGET, selectMarkdownFrontmatter, type MarkdownFrontmatterExposureState, type MarkdownFrontmatterStatus } from "../core/markdown-frontmatter.ts";
import { rejectObsoleteNavigationParams } from "../core/navigation-clean.ts";
import { canonicalExistingPath } from "../core/path-resolve.ts";
import { detectProjectRoot } from "../core/project-root.ts";
import { resolveProjectDocsContext, searchDocsWithQmd } from "../core/qmd-docs-search.ts";
import { formatHeader } from "../core/read-renderer.ts";
import { computeTag, snapshots } from "../core/snapshot-store.ts";
import { normalizeToLF, splitLogicalLines, stripBom } from "../core/text-normalize.ts";
import { renderDocsSearchCall, renderDocsSearchResult } from "../core/tui-render.ts";
import { S } from "../core/schema.ts";
import { asToolCallValidationError, invalidToolCallResult, ToolCallValidationError } from "../core/tool-call-contract.ts";
const picomatch = createRequire(import.meta.url)("picomatch") as (pattern: string, options?: { dot?: boolean }) => (path: string) => boolean;


export const docsSearchParams = S.object({
  query: S.string("What to ask, in the project's own vocabulary — a concept, decision phrase, config key, or design term. Required."),
  path: S.string("Optional exact markdown file to search within — a hard filter after retrieval."),
  glob: S.string("Optional file pattern like docs/**/*.md — a post-filter."),
  scope: S.string("Which project's docs to search. Defaults to the project you're in; in a monorepo each extension owns its own docs."),
  page: S.number("Which page, 1-based; the result says when a next page exists."),
  limit: S.number("Results per page, 1-50, default 20."),
}, ["query"]);

export function registerDocsSearchTool(pi: ExtensionAPI, frontmatterExposureState: MarkdownFrontmatterExposureState = createMarkdownFrontmatterExposureState()): void {
  pi.registerTool({
    name: "docs_search",
    label: "docs_search",
    renderShell: "self",
    renderCall: renderDocsSearchCall as any,
    renderResult: renderDocsSearchResult as any,
    description: "Search the project's documentation by meaning — ask in plain words, get the sections that answer, each with its file and line ready to read. It's grep for docs, but matching ideas, not words. Use it whenever what the project says about a topic could govern your answer. Example: docs_search({query:'tool operating reference grep parameters', scope:'extensions/codeweave-pi'}). Next step is read({path:\"<read_selector>\"}) — use the hit's read_selector verbatim, e.g. read({path:\"docs/harness-doctrine.md:navigation-harness-doctrine/evidence-capabilities-not-routes#2\"}) or preamble read({path:\"docs/foo.md:1-14\"}).",
    promptGuidelines: ["Each hit's read_selector is verbatim read input — e.g. read({path:\"docs/harness-doctrine.md:navigation-harness-doctrine/evidence-capabilities-not-routes#2\"}) or preamble read({path:\"docs/foo.md:1-14\"}) — copy it, don't rebuild the slug."],
    parameters: docsSearchParams,
    async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
      let query: string;
      let limit: number;
      let page: number;
      let request: ReturnType<typeof requestPresentation>;
      try {
        rejectObsoleteNavigationParams("docs_search", params, ["query", "path", "glob", "scope", "page", "limit"]);
        query = String(params.query ?? "").trim();
        if (!query) throw new ToolCallValidationError("docs_search query is required and must be non-empty.", { received: params.query });
        limit = normalizeInteger(params.limit, 20, 50, "limit");
        page = normalizeInteger(params.page, 1, Number.MAX_SAFE_INTEGER, "page");
        request = requestPresentation(params, query, page, limit);
      } catch (error) {
        return invalidToolCallResult("docs_search", asToolCallValidationError(error, { accepted: ["{query:'project concept'}", "{query:'config key', path:'docs/setup.md'}"], received: params }));
      }
      const detected = detectProjectRoot(resolve(ctx.cwd, String(params.scope ?? ".")));
      const root = detected.root;
      onUpdate?.(result(`Docs search: ${JSON.stringify(query)}\nStatus: querying the prepared document section index.`, {
        status: "success",
        summary: "Searching prepared document sections.",
        details: { presentation: { ...request, phase: "searching", status: "pending", items: [] } },
      }));
      const docsContext = await resolveProjectDocsContext(root);
      if (docsContext.status === "unavailable") return unavailable(query, request, docsContext.message, docsContext.summary, docsContext.reason);
      const docsRoot = docsContext.docsRoot;
      const exactPath = normalizePathFilter(params.path, docsRoot);
      const globPath = normalizeGlobFilter(params.glob, docsRoot);
      let searched: any;
      try {
        searched = await searchDocsWithQmd(query, {
          ...docsContext.options,
          pathHints: [exactPath, globPath].filter((value): value is string => typeof value === "string" && Boolean(value.trim())),
          signal,
        });
      } catch (error) {
        const reason = safeReason(error);
        return result(`ERROR: document search failed.\nReason: ${reason}`, {
          status: "error",
        summary: "Document search failed.",
          details: { presentation: { ...request, phase: "complete", status: "error", semantic: { status: "unknown" }, diagnostics: [reason], items: [] } },
        });
      }
      const matchesPath = pathFilter(exactPath, globPath);
      const filtered = (searched.results ?? []).filter((item: any) => matchesPath(String(item.doc_path ?? "")));
      const start = (page - 1) * limit;
      const rows = filtered.slice(start, start + limit);
      const totalPages = Math.max(1, Math.ceil(filtered.length / limit));
      const pageWindowBase = { path: "results", page, page_size: limit, returned_count: rows.length, total_count: filtered.length, total_pages: totalPages, omitted_before: Math.min(start, filtered.length), omitted_after: Math.max(0, filtered.length - start - rows.length), complete: page >= totalPages, ...(page < totalPages ? { next_page: page + 1 } : {}) };
      const hasMoreAnswerable = page < totalPages && filtered.slice(start + limit).some((item: any) => item?.project_navigation?.qmd?.answerability?.status === "answer_bearing");
      const pageWindow = { ...pageWindowBase, ...(semanticReady => semanticReady ? { has_more_answerable: hasMoreAnswerable } : {})(searched.semantic?.status === "ready") };
      const items = rows.map((item: any, index: number) => docsPresentationItem(item, start + index + 1));
      const frontmatter = await attachFirstMarkdownFrontmatter(items, docsRoot, root, frontmatterExposureState, signal);
      const semantic = searched.semantic ?? { status: "unknown" };
      const reason = searched.reason ?? semantic.reason;
      const omissions = searched.omissions ?? { count: 0, paths: [] };
      const status = String(searched.status ?? "unavailable");
      const lines = items.map((item: any) => {
        const range = item.startLine && item.endLine ? ` · L${item.startLine}-${item.endLine}` : "";
        const score = Number.isFinite(item.finalScore) ? ` · score=${item.finalScore.toFixed(4)} (retrieval=${item.retrievalScore.toFixed(4)}, title=${signed(item.titlePrior)}, authority=${signed(item.authorityPrior)})` : "";
        const weak = item.answerability?.status === "weak_lead";
        const strength = weak ? ` · weak lead (${(item.answerability.reasons ?? []).join(", ") || "retrieval signal"})` : "";
        const lead = `${item.rank}. ${item.readSelector}${range}${strength}\n   ${item.snippet}${score}`.trimEnd();
        return item.frontmatter?.text ? `${lead}\n${item.frontmatter.text}` : lead;
      });
      const mode = semantic.status === "ready" ? "hybrid" : "lexical";
      const ranking = mode === "hybrid"
        ? "lexical + vector + reranker + title/authority priors"
        : "lexical ranking + title/authority priors";
      const latency = Number.isFinite(Number(searched.latency_ms)) ? `${Number(searched.latency_ms)}ms` : "unknown";
      const modeLine = status === "unavailable"
        ? `Search result: unavailable for this request${reason ? ` · reason=${safeReason(reason)}` : ""}`
        : `Search mode: ${mode} · current document-section evidence active`;
      const text = [
        `Docs search: ${JSON.stringify(query)}`,
        modeLine,
        `Ranking: ${ranking} · current Markdown selectors`,
        `Generation: ${searched.generation ?? "unknown"} · privacy=${searched.privacy ?? "unknown"} · latency=${latency}`,
        `Coverage: candidates=${searched.candidate_window?.returned ?? searched.results?.length ?? 0}/${searched.candidate_window?.limit ?? 40}${searched.candidate_window?.saturated ? " (lower bound)" : ""} · filtered=${filtered.length} · returned=${rows.length} · page ${page}/${totalPages} · omitted before/after=${pageWindow.omitted_before}/${pageWindow.omitted_after}`,
        ...(semantic.status === "ready" ? [`Answerability: ${searched.answerability?.answer_bearing_count ?? 0} answer-bearing · ${searched.answerability?.weak_lead_count ?? 0} weak lead(s) · scores rank candidates and are not confidence probabilities${searched.answerability?.status === "weak_leads_only" ? " · no answer-bearing candidate met the configured retrieval signals" : ""}`] : []),
        ...(semantic.status === "ready" && page < totalPages ? [`Has more answer-bearing on next page: ${hasMoreAnswerable ? "yes" : "no"}`] : []),
        ...(Number(omissions.count ?? 0) ? [`Selector omissions: ${omissions.count} · ${omissions.paths.map((item: any) => `${item.path} (${item.reason})`).join(", ")}`] : []),
        ...(frontmatter.shown || frontmatter.summaries || frontmatter.deferred ? [`Frontmatter: full=${frontmatter.shown} · summary=${frontmatter.summaries} · deferred=${frontmatter.deferred}`] : []),
        "",
        ...(lines.length ? lines : [filtered.length === 0 && (searched.results?.length ?? 0) > 0 && (params.path || params.glob) ? "No current matching Markdown sections survived the requested path/glob filter." : "No current matching Markdown sections."]),
      ].join("\n");
      const weakPageOnly = items.length > 0 && items.every((item: any) => item.answerability?.status === "weak_lead");
      const envelopeStatus = status === "unavailable" || weakPageOnly || Number(omissions.count ?? 0) > 0 ? "warning" : "success";
      commitDocsFrontmatter(frontmatter.pending, frontmatterExposureState);
      return result(text, {
        status: envelopeStatus,
        summary: rows.length ? weakPageOnly ? `Returned ${rows.length} current weak document section lead(s); no answer-bearing match is claimed.` : `Returned ${rows.length} current document section lead(s).` : "No current document section leads matched.",
        details: {
          search: { ...searched, results: rows },
          presentation: {
            ...request,
            phase: "complete",
            status,
            provider: searched.provider,
            semantic,
            generation: searched.generation,
            privacy: searched.privacy,
            latencyMs: searched.latency_ms,
            health: searched.health,
            ranking: { mode: semantic.status === "ready" ? "hybrid" : "lexical", embeddingModel: searched.embedding_model, rerankerModel: searched.reranker_model, currentSelectors: true },
            counts: { candidates: searched.candidate_window?.returned ?? searched.results?.length ?? 0, filtered: filtered.length, returned: rows.length },
            candidateWindow: searched.candidate_window,
            answerability: searched.answerability ? { ...searched.answerability, ...(semantic.status === "ready" && page < totalPages ? { has_more_answerable: hasMoreAnswerable } : {}) } : searched.answerability,
            has_more_answerable: semantic.status === "ready" && page < totalPages ? hasMoreAnswerable : undefined,
            omissions,
            diagnostics: reason ? [safeReason(reason)] : [],
            items,
            pageWindows: [pageWindow],
          },
          project_navigation: { page_windows: [pageWindow] },
        },
      });
    },
  });
}

function requestPresentation(params: any, query: string, page: number, limit: number) {
  return {
    kind: "docs-search",
    query,
    filters: { path: typeof params.path === "string" ? params.path : undefined, glob: typeof params.glob === "string" ? params.glob : undefined, scope: typeof params.scope === "string" ? params.scope : undefined },
    page,
    limit,
  };
}

function unavailable(query: string, request: any, message: string, summary: string, reason: string) {
  return result(`UNAVAILABLE: ${message}\nQuery: ${JSON.stringify(query)}\nRetrieval was not attempted.`, {
    status: "warning",
    summary,
    details: { presentation: { ...request, phase: "complete", status: "unavailable", semantic: { status: "unavailable", reason }, diagnostics: [reason], counts: { candidates: 0, filtered: 0, returned: 0 }, items: [], pageWindows: [{ path: "results", page: request.page, page_size: request.limit, returned_count: 0, total_count: 0, total_pages: 1, omitted_before: 0, omitted_after: 0, complete: true }] } },
  });
}

function docsPresentationItem(item: any, rank: number) {
  const qmd = item?.project_navigation?.qmd ?? {};
  return {
    rank,
    retrievalRank: Number(qmd.rank ?? rank),
    label: String(item?.title ?? item?.selector ?? "Untitled section"),
    path: String(item?.doc_path ?? ""),
    ref: String(item?.section_id ?? ""),
    readSelector: String(qmd.read_selector ?? item?.section_id ?? ""),
    startLine: Number(item?.start_line ?? 0),
    endLine: Number(item?.end_line ?? 0),
    level: Number(item?.level ?? 0),
    authorityRole: String(item?.authority_role ?? item?.project_navigation?.docs_authority_role ?? "supporting_documentation"),
    current: true,
    snippet: String(qmd.snippet ?? "").trim(),
    retrievalScore: Number(qmd.qmd_score),
    nativeScore: Number(qmd.native_score),
    authorityPrior: Number(qmd.authority_prior),
    titlePrior: Number(qmd.title_prior),
    finalScore: Number(qmd.final_score),
    answerability: qmd.answerability,
    contentHash: String(item?.content_hash ?? ""),
    explain: qmd.explain,
  };
}

interface PendingDocsFrontmatter {
  canonicalPath: string;
  inspected: boolean;
  normalized?: string;
  seenLines?: number[];
  digest?: string;
}

export async function attachFirstMarkdownFrontmatter(items: any[], docsRoot: string, projectRoot: string, exposureState: MarkdownFrontmatterExposureState, signal?: AbortSignal) {
  const handled = new Set<string>();
  const plannedExposureState = cloneMarkdownFrontmatterExposureState(exposureState);
  const pending: PendingDocsFrontmatter[] = [];
  let shown = 0;
  let summaries = 0;
  let deferred = 0;

  for (const item of items) {
    const docPath = String(item.path ?? "");
    if (!/\.md$/i.test(docPath) || handled.has(docPath)) continue;
    handled.add(docPath);
    if (signal?.aborted) throw new Error("Docs search aborted before frontmatter rendering.");
    try {
      const absolutePath = resolve(docsRoot, docPath);
      const bytes = await readFile(absolutePath);
      if (item.contentHash && createHash("sha256").update(bytes).digest("hex") !== item.contentHash.toLowerCase()) {
        item.frontmatter = { status: "deferred" satisfies MarkdownFrontmatterStatus };
        deferred++;
        continue;
      }
      const canonicalPath = canonicalExistingPath(absolutePath);
      const { text } = stripBom(bytes.toString("utf8"));
      const normalized = normalizeToLF(text);
      const { lines } = splitLogicalLines(normalized);
      const selection = selectMarkdownFrontmatter({ path: docPath, lines, canonicalPath, exposureState: plannedExposureState, maxBytes: MARKDOWN_FRONTMATTER_BUDGET });
      const validation = await validateFrontmatterRelationships({ projectRoot, ownerPath: canonicalPath, relationships: selection.relationships, signal });
      item.frontmatter = { status: selection.status, relationships: validation?.counts };
      if (selection.inspected) commitMarkdownFrontmatterExposure(plannedExposureState, canonicalPath, selection.digest);
      if (selection.text) {
        const tag = computeTag(normalized);
        item.frontmatter.text = [`${formatHeader(docPath, tag)}\n${selection.text}`, validation?.text].filter(Boolean).join("\n\n");
        item.frontmatter.lines = selection.intervals.flatMap(interval => Array.from({ length: interval.end - interval.start + 1 }, (_, index) => interval.start + index));
        if (selection.status === "full") shown++;
        else summaries++;
      } else if (selection.status === "deferred") {
        deferred++;
      }
      pending.push({ canonicalPath, inspected: selection.inspected, digest: selection.digest, normalized: selection.text ? normalized : undefined, seenLines: item.frontmatter.lines });
    } catch (error) {
      if (signal?.aborted) throw error;
      item.frontmatter = { status: "deferred" satisfies MarkdownFrontmatterStatus };
      deferred++;
    }
  }
  return { shown, summaries, deferred, pending };
}

function commitDocsFrontmatter(pending: PendingDocsFrontmatter[], exposureState: MarkdownFrontmatterExposureState): void {
  for (const item of pending) {
    if (item.normalized && item.seenLines?.length) snapshots.record(item.canonicalPath, item.normalized, item.seenLines);
    if (item.inspected) commitMarkdownFrontmatterExposure(exposureState, item.canonicalPath, item.digest);
  }
}

function signed(value: number): string { return Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(4)}` : "unknown"; }
function safeReason(value: unknown): string {
  const text = String(value instanceof Error ? value.message : value).replace(/ze_[A-Za-z0-9]+/g, "<redacted>").replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function normalizePathFilter(value: unknown, root: string): string | undefined {
  let path = String(value ?? "").trim().replace(/\\/g, "/").replace(/:\d+(?:-\d+)?$/, "");
  if (!path) return undefined;
  if (isAbsolute(path)) path = relative(root, path).replace(/\\/g, "/");
  return path.replace(/^\.\//, "");
}

function normalizeGlobFilter(value: unknown, root: string): string | undefined {
  let glob = String(value ?? "").trim().replace(/\\/g, "/");
  if (!glob) return undefined;
  if (isAbsolute(glob)) glob = relative(root, glob).replace(/\\/g, "/");
  return glob.replace(/^\.\//, "");
}

function pathFilter(pathValue: unknown, globValue: unknown): (path: string) => boolean {
  const exact = String(pathValue ?? "").trim().replace(/^\.\//, "");
  const glob = String(globValue ?? "").trim();
  const matchGlob = glob ? picomatch(glob, { dot: true }) : undefined;
  return path => (!exact || path === exact) && (!matchGlob || matchGlob(path));
}
function normalizeInteger(value: unknown, fallback: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`docs_search ${label} must be an integer from 1 to ${max}`);
  return number;
}
function result(text: string, input: { status: "success" | "warning" | "error"; summary: string; details?: any }) {
  return {
    content: [{ type: "text" as const, text }],
    details: { ...(input.details ?? {}), envelope: harnessEnvelope({ status: input.status, summary: input.summary, next_actions: [], artifacts: [] }) },
  };
}
