import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { harnessEnvelope, nativeToolResult, referenceTokenCount } from "../core/harness-result.ts";
import { prepareExactLeads, prepareSourceAuthority } from "../core/source-authority.ts";
import { nativeLocationLeads, nativeSourceEvidence } from "../core/pi-nav-evidence.ts";
import { callAnalysisNavigation, callIndexedGraphNavigation, callPiNav, validateRankedCorpus, type AnalysisProject, type IndexedGraphProjection, type NativeOutput, type PiNavCaller } from "../core/pi-nav-native.ts";
import { canonicalProjectPath, detectProjectRoot } from "../core/project-root.ts";
import { renderTraceCall, renderTraceResult } from "../core/tui-render.ts";
import { pagePreparedEvidence } from "../core/prepared-page.ts";
import { S } from "../core/schema.ts";
import { asToolCallValidationError, boundedInvalidToolCallResult, normalizedEnum, normalizedInteger, ToolCallValidationError, withToolCallNormalizations } from "../core/tool-call-contract.ts";
import {
  backendArtifactMissing,
  commandForLane,
  envelopeForLeads,
  graphifyQueryEnv,
  graphPathForLane,
  indexedGraphEvidence,
  parseFileBackedLeadsFromJson,
  parseFileBackedLeadsFromText,
  parseJsonOrText,
  rejectObsoleteNavigationParams,
  renderNativeResult,
  resolveNavigationScope,
  resolveRequiredLane,
  resultText,
  runCommand,
  sanitizeGraphifyResult,
  sanitizeAgentText,
  scopeRootForLane,
  selectAuthorityLeads,
  selectorForLead,
  unavailableResult,
  type Lead,
} from "../core/navigation-clean.ts";

const RELATIONS = new Set(["callers", "callees", "imports", "importers", "tests", "path", "explain"]);

export const traceParams = S.object({
  target: S.string("The one identity, exactly as the project knows it: a qualified symbol for callers/callees/tests, a project-relative file path for imports/importers, a graph node for path/explain. An unambiguous bare symbol works. Copy it from a search result rather than retyping."),
  targets: S.array(S.string(), "2-4 identities sharing one relation, when you need every answer regardless of the others. Code relations, page 1 only, at most 15 rows each."),
  relation: S.string("Which list you want — required. callers/callees/tests for symbols; imports/importers for files; path/explain for graph nodes."),
  to: S.string("Second graph node — only with relation:'path'."),
  scope: S.string("Which project owns the identity."),
  page: S.number("Next page for one target — pass target/relation/limit back unchanged; batches are page 1 only."),
  limit: S.number("Rows per page, default 50; raise toward 200 only for a dense relation."),
}, ["relation"]);

const FILE_RELATIONS = new Set(["imports", "importers"]);
const SYMBOL_RELATIONS = new Set(["callers", "callees", "tests"]);

interface TraceReplyState {
  commits: Array<() => void>;
  refit?: (limit: number) => Promise<any>;
  validate?: () => Promise<void>;
}
type CodeTraceRequest = { root: string; scope: string; cwd?: string; relation: string; target: string; limit: number; page: number; signal?: AbortSignal; callNative: PiNavCaller; analysisProject?: AnalysisProject; reply: TraceReplyState };
type TraceOutcome = { target: string; result: any; reply: TraceReplyState };

export function registerTraceTool(pi: ExtensionAPI, options: { callNative?: PiNavCaller; analysisProject?: AnalysisProject } = {}): void {
  const callNative = options.callNative ?? callPiNav;
  pi.registerTool({
    name: "trace",
    label: "trace",
    renderShell: "self",
    renderCall: renderTraceCall,
    renderResult: renderTraceResult,
    description: "Ask one wiring question about code you already know — like 'find usages' in an editor. One identity per call, or 2-4 via targets. Example: trace({target:'src/tools/grep.ts::registerGrepTool', relation:'callers', scope:'extensions/codeweave-pi'}).",
    promptGuidelines: ["Trace the exact name search returned; a bare name that isn't unique returns nothing, so qualify it with explore search first. Re-trace when you obtain a stronger identity.\n\n'No node found' usually means the identity or the scope is wrong — re-check both."],
    parameters: traceParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const normalizations: string[] = [];
      let relation: string;
      let limit: number;
      let page: number;
      let target = "";
      let targets: string[] | undefined;
      try {
        rejectObsoleteNavigationParams("trace", params, ["target", "targets", "relation", "to", "scope", "limit", "page"]);
        relation = normalizedEnum(params.relation, "trace relation", [...RELATIONS], normalizations);
        limit = normalizedInteger(params.limit, "trace limit", params.targets !== undefined ? 15 : 50, 1, 200, normalizations);
        page = normalizedInteger(params.page, "trace page", 1, 1, Number.MAX_SAFE_INTEGER, normalizations);
        target = typeof params.target === "string" ? params.target.trim() : "";
        if (params.targets !== undefined) {
          if (!Array.isArray(params.targets) || params.targets.some((item: unknown) => typeof item !== "string" || !item.trim())) throw new ToolCallValidationError("trace targets must be an array of non-empty identity strings.", { received: params.targets });
          targets = params.targets.map((item: string) => item.trim());
        }
        if (Boolean(target) === Boolean(targets)) throw new ToolCallValidationError("trace requires exactly one of target or targets.", { received: { target: params.target, targets: params.targets } });
        if (targets) {
          if (relation === "path" || relation === "explain") throw new ToolCallValidationError("trace batches support code relations only; graph path/explain require one exact target.", { received: relation });
          if (params.to !== undefined) throw new ToolCallValidationError("trace to applies only to a single-target relation:'path'.", { received: params.to });
          if (targets.length < 2 || targets.length > 4) throw new ToolCallValidationError("trace targets must contain 2 to 4 independent identities.", { received: targets });
          if (new Set(targets).size !== targets.length) throw new ToolCallValidationError("trace targets must be unique; duplicate work is not executed implicitly.", { received: targets });
          if (page !== 1) throw new ToolCallValidationError("trace batches are initial page 1 only.", { guidance: ["Continue each target separately with its returned next_page."] });
          if (limit > 15) throw new ToolCallValidationError("trace batches cap limit at 15 per target.", { guidance: ["Use limit 1-15 or focused single-target calls."] });
          for (const item of targets) validateTraceIdentity(relation, item);
        } else {
          if (!target) throw new ToolCallValidationError("trace target is required when targets is absent.");
          validateTraceIdentity(relation, target);
          if (relation === "path" && (typeof params.to !== "string" || !params.to.trim())) throw new ToolCallValidationError("trace relation:'path' requires to.", { accepted: ["{target:'exact graph node', relation:'path', to:'second exact graph node'}"], guidance: ["Copy both node identities from graph output."] });
          if (relation !== "path" && params.to !== undefined) throw new ToolCallValidationError(`trace relation:${JSON.stringify(relation)} does not accept to.`, { received: params.to, guidance: ["Remove to; it belongs only to relation:'path'."] });
        }
      } catch (error) {
        return boundedInvalidToolCallResult("trace", asToolCallValidationError(error, {
          accepted: ["symbol relation: {target:'qualified::symbol', relation:'callers|callees|tests'}", "file relation: {target:'src/file.ts', relation:'imports|importers'}", "graph path: {target:'node A', relation:'path', to:'node B'}", "batch: {targets:['symbolA','symbolB'], relation:'callers|callees|tests|imports|importers'}"],
          guidance: ["Use explore.code search to qualify an unknown symbol before tracing it.", "A trace relation observes one structural edge only; choose another capability for purpose or architecture."],
          received: params,
        }));
      }
      const resolved = await resolveNavigationScope(ctx.cwd, params.scope);
      if (!resolved.ok) return resultText(resolved.text, resolved.envelope);
      if (targets) return runMultiCodeTrace({ root: detectProjectRoot(resolved.scope).root, scope: canonicalProjectPath(resolved.scope), cwd: ctx.cwd, relation, targets, limit, signal, callNative, analysisProject: options.analysisProject, normalizations });
      const reply: TraceReplyState = { commits: [] };
      const result = relation === "path" || relation === "explain"
        ? await runGraphTrace({ scope: resolved.scope, relation, target, to: params.to?.trim(), limit, page, normalizations, signal })
        : await runCodeTrace({ root: detectProjectRoot(resolved.scope).root, scope: canonicalProjectPath(resolved.scope), cwd: ctx.cwd, relation, target, limit, page, signal, callNative, analysisProject: options.analysisProject, reply });
      return finishTraceReplies([{ target, result, reply }], { relation, limit, page, signal, normalizations });
    },
   });
 }

async function runMultiCodeTrace(params: { root: string; scope: string; cwd?: string; relation: string; targets: string[]; limit: number; signal?: AbortSignal; callNative: PiNavCaller; analysisProject?: AnalysisProject; normalizations: string[] }) {
  const outcomes = await Promise.all(params.targets.map(async target => {
    const reply: TraceReplyState = { commits: [] };
    try {
      const result = await runCodeTrace({ ...params, target, page: 1, reply });
      return { target, result, reply };
    } catch (error) {
      params.signal?.throwIfAborted();
      reply.commits = [];
      const reason = error instanceof Error ? error.message : String(error);
      const result = resultText(`ERROR: trace batch item failed for ${JSON.stringify(target)}.\nReason: ${reason}\nSibling results remain independently usable.`, harnessEnvelope({ status: "error", summary: `Trace failed for ${target}.`, next_actions: [], artifacts: [], diagnostics: [reason] }));
      return { target, result, reply };
    }
  }));
  return finishTraceReplies(outcomes, { ...params, page: 1 });
}

function renderTraceBatch(items: TraceOutcome[], relation: string) {
  const outcomes = items.map(item => ({ ...item, status: traceResultStatus(item.result) }));
  const successful = outcomes.filter(item => item.status === "success").length;
  const failed = outcomes.length - successful;
  const status = failed === 0 ? "success" : successful === 0 ? "error" : "partial";
  const text = [
    `Trace batch: ${relation} for ${outcomes.length} ordered targets (${successful} successful, ${failed} non-successful).`,
    ...outcomes.flatMap((item, index) => [`\n## ${index + 1}. ${item.target} [${item.status}]`, String(item.result?.content?.[0]?.text ?? "No result text.")]),
  ].join("\n");
  const artifacts = [...new Set(outcomes.flatMap(item => Array.isArray(item.result?.details?.envelope?.artifacts) ? item.result.details.envelope.artifacts : []))];
  const diagnostics = outcomes.flatMap(item => (item.result?.details?.envelope?.diagnostics ?? []).map((entry: unknown) => `${item.target}: ${String(entry)}`));
  return {
    content: [{ type: "text" as const, text }],
    details: {
      status,
      envelope: harnessEnvelope({ status: status === "success" ? "success" : status === "error" ? "error" : "warning", summary: `Trace batch returned ${successful}/${outcomes.length} successful target results.`, next_actions: [], artifacts, diagnostics }),
      queries: outcomes.map(item => ({ target: item.target, status: item.status, details: item.result?.details })),
      presentation: { kind: "trace-batch", relation, items: outcomes.map(item => ({ target: item.target, status: item.status, presentation: item.result?.details?.presentation })) },
    },
  };
}

async function finishTraceReplies(outcomes: TraceOutcome[], params: { relation: string; limit: number; page: number; signal?: AbortSignal; normalizations: string[] }) {
  let limit = params.limit;
  const compose = () => {
    const original = outcomes.length > 1 ? renderTraceBatch(outcomes, params.relation) : outcomes[0].result;
    const result = { ...original, content: original.content.map((part: any) => ({ ...part })), details: { ...original.details } };
    if (limit !== params.limit) {
      const items = outcomes.flatMap((item, index) => item.reply.refit ? [index + 1] : []);
      const notice = `Reply budget: requested page ${params.page}, limit ${params.limit}; restarted at page 1, limit ${limit}. Continue from this new page size, not the previous sequence; no generation is pinned.${items.length < outcomes.length ? ` Only batch items ${items.join(", ")} restarted; other entries are unchanged.` : ""}`;
      result.content[0].text = `${notice}\n\n${result.content[0].text}`;
      result.details.status = "partial";
      result.details.envelope = { ...result.details.envelope, status: "warning", diagnostics: [...(result.details.envelope?.diagnostics ?? []), notice] };
      result.details.budgetRestart = { requestedPage: params.page, requestedLimit: params.limit, page: 1, limit, items };
    }
    return withToolCallNormalizations(result, params.normalizations, true);
  };
  let result = compose();
  let tokens = referenceTokenCount(result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"));
  while (tokens > 4_000 && limit > 1 && outcomes.some(item => item.reply.refit)) {
    limit = Math.max(1, Math.min(limit - 1, Math.floor(limit * Math.min(0.8, 3_600 / tokens))));
    // Retain the capture, not authority from its rejected presentation. In a
    // batch refittable targets share a page size; fixed siblings stay intact.
    for (const item of outcomes) {
      if (!item.reply.refit) continue;
      item.reply.commits = [];
      item.result = await item.reply.refit!(limit);
    }
    result = compose();
    tokens = referenceTokenCount(result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"));
  }
  if (tokens > 4_000) return resultText("Trace reply withheld: complete identities and evidence cannot fit the 4,000-token reply budget. Narrow the target/scope or request fewer rows. No source authority was granted.",
    harnessEnvelope({ status: "warning", summary: "Trace reply exceeds its budget.", next_actions: [], artifacts: [], diagnostics: ["reply_budget"] }));
  try {
    for (const item of outcomes) await item.reply.validate?.();
  } catch (error) {
    params.signal?.throwIfAborted();
    return resultText("Indexed trace withheld: corpus admission changed before delivery. Retry the request; no source authority was granted.",
      harnessEnvelope({ status: "warning", summary: "Indexed trace admission failed.", next_actions: [], artifacts: [], diagnostics: ["indexed_projection_unavailable"] }));
  }
  params.signal?.throwIfAborted();
  for (const item of outcomes) for (const commit of item.reply.commits) commit();
  return result;
}

function traceResultStatus(result: any): "success" | "warning" | "error" {
  const status = String(result?.details?.envelope?.status ?? result?.details?.status ?? "success");
  return status === "error" ? "error" : status === "warning" || status === "partial" ? "warning" : "success";
}


function validateTraceIdentity(relation: string, target: string): void {
  const qualified = target.includes("::") || target.includes("#");
  const pathLike = /[\\/]/.test(target) || /\.[A-Za-z0-9]+(?::\d+)?$/.test(target);
  if (FILE_RELATIONS.has(relation) && (qualified || !pathLike)) {
    throw new ToolCallValidationError(`trace ${relation} requires a concrete file path target.`, { received: target, guidance: ["Use the exact project-relative or absolute file path, not a symbol or basename guess."] });
  }
  if (SYMBOL_RELATIONS.has(relation) && pathLike && !qualified) {
    throw new ToolCallValidationError(`trace ${relation} requires a bare or qualified symbol target, not a file path.`, { received: target, guidance: ["Use explore.code search to obtain a qualified symbol, then trace that identity."] });
  }
}

async function runGraphTrace(params: { scope: string; relation: string; target: string; to?: string; limit: number; page: number; normalizations?: string[]; signal?: AbortSignal }) {
  const graph = await resolveRequiredLane(params.scope, "graph");
  const graphPath = graphPathForLane(graph);
  if (!graph.ok || backendArtifactMissing(graphPath)) return unavailableResult("graph trace", graph);
  if (params.relation === "path" && !params.to) throw new Error("trace relation 'path' requires parameter to in the clean-break schema.");
  const command = commandForLane(graph);
  const args = params.relation === "path"
    ? ["path", params.target, String(params.to), "--graph", graphPath!]
    : ["explain", params.target, "--graph", graphPath!];
  const run = await runCommand(command, args, { cwd: params.scope, signal: params.signal, timeoutMs: 25_000, env: graphifyQueryEnv(), telemetry: { tool: "trace", backend: "graphify", lane: "graph", mode: params.relation } });
  if (run.stdoutTruncated) return resultText("Graph trace capture was truncated before complete relationship evidence could be retained. Narrow the target; changing display page or limit cannot recover uncaptured records. No graph rows were delivered.",
    harnessEnvelope({ status: "warning", summary: "Graph trace capture is incomplete.", next_actions: [], artifacts: [], diagnostics: ["stdout_truncated"] }));
  if (!run.ok) {
    return resultText([
      "WARNING: graph trace failed; no fallback navigation was used.",
      `Reason: ${run.error ?? (run.stderr || `exit ${run.code}`)}`,
      "Query-time tools read existing graph artifacts only; they do not build or mutate state.",
    ].join("\n"), harnessEnvelope({ status: "warning", summary: "Graph trace failed.", next_actions: ["Use navigation-debug for diagnosis."], artifacts: [], diagnostics: [sanitizeAgentText(run.stderr || run.error || `exit=${run.code}`)] }));
  }
  const rawJson = parseJsonOrText(run.stdout);
  let root = scopeRootForLane(graph, params.scope);
  const noRelationship = params.relation === "path"
    ? /\bNo path found\b/i.test(run.stdout)
    : /\bNo node matching\b/i.test(run.stdout);
  const warningText = sanitizeAgentText(run.stderr || "").trim();
  const marker = params.normalizations?.length ? `\n\nCall normalization: ${[...new Set(params.normalizations)].join("; ")}.` : "";
  const compose = async (page: number, limit: number) => {
    let hygiene = rawJson ? sanitizeGraphifyResult(rawJson, root) : undefined;
    let cleanJson = hygiene?.value;
    const json = cleanJson ? pagePreparedEvidence(cleanJson, { page, limit, request: { relation: params.relation, target: params.target, to: params.to, limit }, rootIdentity: (graph as any).rootIdentity, generationIdentity: (graph as any).generationId }) : cleanJson;
    // An echoed endpoint in a failed lookup is not returned relationship evidence.
    const leads = noRelationship ? [] : json ? parseFileBackedLeadsFromJson(json, root, limit) : parseFileBackedLeadsFromText(run.stdout, root, limit);
    const baseDiagnostics = [...(warningText ? [`warnings=${warningText}`] : []), ...(hygiene?.diagnostics ?? [])];
    const native = graphNativeWithWarnings(json ?? run.stdout, warningText);
    const summary = noRelationship
      ? `Graph ${params.relation}: no relationship found`
      : leads.length
        ? `Graph ${params.relation}: ${leads.length} ${leads.length === 1 ? "lead" : "leads"}`
        : `Graph ${params.relation}: no source leads found`;
    const text = renderNativeResult(`Graph ${params.relation}: ${JSON.stringify(params.target)}${params.to ? ` -> ${JSON.stringify(params.to)}` : ""}`, native, leads, { maxNativeChars: Number.MAX_SAFE_INTEGER, contextLabel: "Graph context", followUpSelectors: true });
    const envelope = noRelationship || warningText
      ? harnessEnvelope({ status: "warning", summary, next_actions: noRelationship ? ["Retry with exact graph node IDs from trace explain when endpoint resolution was ambiguous."] : [], artifacts: selectAuthorityLeads(leads).map(selectorForLead), diagnostics: baseDiagnostics })
      : envelopeForLeads(summary, leads, baseDiagnostics);
    return { result: withTracePresentation(resultText(text, envelope), params.relation, params.target, native, leads), text, leads };
  };
  let limit = params.limit;
  let composed = await compose(params.page, limit);
  if (!composed.leads.length && root !== params.scope) {
    root = params.scope;
    composed = await compose(params.page, limit);
  }
  // Skip expensive BPE only when the independent character wall already rejects
  // the page; every character-eligible final reply still gets the exact count.
  let tokens = (composed.text + marker).length > 16_000 ? undefined : referenceTokenCount(composed.text + marker);
  for (let attempts = 0; (tokens === undefined || tokens > 4_000) && limit > 1 && attempts < 8; attempts++) {
    const ratio = tokens === undefined ? 16_000 / (composed.text + marker).length : 3_600 / tokens;
    limit = Math.max(1, Math.min(limit - 1, Math.floor(limit * Math.min(0.6, ratio))));
    composed = await compose(1, limit);
    tokens = (composed.text + marker).length > 16_000 ? undefined : referenceTokenCount(composed.text + marker);
  }
  if (limit !== params.limit) {
    const notice = `Reply budget: requested page ${params.page}, limit ${params.limit}; restarted at page 1, limit ${limit}. Continue from this new page size, not the previous sequence; no generation is pinned.`;
    composed.result.content[0].text = `${notice}\n\n${composed.result.content[0].text}`;
    composed.result.details.status = "partial";
    composed.result.details.envelope = { ...composed.result.details.envelope, status: "warning", diagnostics: [...(composed.result.details.envelope?.diagnostics ?? []), notice] };
    composed.result.details.budgetRestart = { requestedPage: params.page, requestedLimit: params.limit, page: 1, limit };
  }
  params.signal?.throwIfAborted();
  if ((composed.result.content[0].text + marker).length > 16_000 || referenceTokenCount(composed.result.content[0].text + marker) > 4_000) {
    return resultText("Graph trace reply withheld: complete identities and evidence cannot fit within both the 4,000-token ceiling and the bounded character allowance. Narrow the target; no graph rows were delivered.",
      harnessEnvelope({ status: "warning", summary: "Graph trace exceeds its reply budget.", next_actions: [], artifacts: [], diagnostics: ["reply_budget"] }));
  }
  return composed.result;
}

async function runCodeTrace(params: CodeTraceRequest) {
  if (params.analysisProject && (params.relation === "callers" || params.relation === "callees")) return runSelectedCodeTrace(params, params.analysisProject);
  if (SYMBOL_RELATIONS.has(params.relation)) {
    const indexed = await runIndexedCodeTrace(params);
    if (indexed !== undefined) return indexed;
  }
  return runNativeCodeTrace(params);
}

/** The selected candidate consumes typed, directed native evidence. It never
 * reconstructs graph relationships from a rendered grep page.
 */
async function runSelectedCodeTrace(
  params: CodeTraceRequest,
  project: AnalysisProject,
) {
  const deadline = performance.now() + 25_000;
  const remaining = () => {
    params.signal?.throwIfAborted();
    const timeout = Math.floor(deadline - performance.now());
    if (timeout <= 0) throw new Error("[pi-nav:deadline] trace deadline exceeded");
    return timeout;
  };
  try {
    const output = await callAnalysisNavigation({ root: params.root, operation: "pi_nav_search", signal: params.signal,
      timeoutMs: remaining(), args: { query: params.target, kind: "symbol", scope: params.root, expand: 2,
        analysisRelation: params.relation, page: params.page, limit: params.limit } }, project, params.callNative);
    const finish = async (output: NativeOutput, preparedUnavailable = false) => {
      remaining();
      if (preparedUnavailable) {
        const diagnostic = "Prepared connections unavailable: the enriched response was refused by the output safety boundary; this result uses the saved live navigation only.";
        const { analysis: _analysis, ...data } = output.structured.data;
        output = { ...output, text: `${output.text}\n${diagnostic}`, structured: {
          ...output.structured, data, diagnostics: [...output.structured.diagnostics, diagnostic],
        } };
      }
      const analysis = output.structured.data.analysis as Record<string, any> | undefined;
      const available = analysis?.relation === params.relation;
      const sourceRoot = output.sourceRoot ?? params.root;
      const evidence = nativeSourceEvidence(output.structured, { capability: "trace", backend: "pi-nav", route: params.relation });
      const authority = await prepareSourceAuthority({ cwd: params.cwd ?? params.root,
        nativeText: available ? output.text : `UNAVAILABLE: prepared ${params.relation} for ${JSON.stringify(params.target)}.\nLive source follows; it is not a completed directed relation.\n${output.text}`,
        evidence: evidence.map(item => ({ ...item, path: resolve(sourceRoot, item.path) })),
        sourceSnapshots: output.sourceSnapshots, signal: params.signal,
        callNative: request => params.callNative({ ...request, root: sourceRoot, timeoutMs: remaining() }),
      });
      remaining();
      const status = available && analysis.status === "ok" && output.structured.completeness.complete !== false ? "success" : "warning";
      const result = nativeToolResult(authority.text, output.structured, harnessEnvelope({ status,
        summary: available ? `Prepared ${params.relation}: ${analysis.status}; generation ${analysis.generation}, page ${params.page}.` : `Prepared ${params.relation} unavailable; live source retained.`,
        next_actions: [], artifacts: authority.authorities.map(item => `[${item.path}#${item.tag}]`),
        diagnostics: output.structured.diagnostics,
      }));
      if (result.content[0].text === authority.text) params.reply.commits.push(authority.commit);
      return result;
    };
    const result = await finish(output);
    // finish supplies only success/warning; error is the existing boundary's refusal.
    return output.liveFallback && result.details.envelope.status === "error"
      ? await finish(output.liveFallback, true) : result;
  } catch (error) {
    params.signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    return resultText(`ERROR: trace ${params.relation} failed.\nReason: ${reason}\nNo preparation, repair or other graph provider was invoked.`,
      harnessEnvelope({ status: "error", summary: "Selected trace failed.", next_actions: [], artifacts: [], diagnostics: [reason] }));
  }
}

function indexedTraceProjection(relation: string): IndexedGraphProjection {
  // Test-file candidates retain one indirect caller hop. Follow only the
  // caller relation, not generic topology (imports/containment are not tests).
  // The native owner supplies path-based isTestFile; this is not coverage proof.
  if (relation === "callees") return { operation: "callees" };
  if (relation === "tests") return { operation: "callers", depth: 2 };
  return { operation: "callers" };
}

/** Ordinary indexed callers/callees/tests: read the existing prepared indexed
 * graph without building, repairing, or adopting it. Returns the focused
 * result when a projection is ready, an unavailable warning when the reader
 * itself is unusable, or undefined when there is no prepared indexed graph or
 * explicit legacy ownership — the caller then falls through to the live native route.
 */
async function runIndexedCodeTrace(
  params: CodeTraceRequest,
) {
  try {
    const output = await callIndexedGraphNavigation({ root: params.root, query: params.target, signal: params.signal,
      projection: indexedTraceProjection(params.relation) }, params.callNative);
    if (!output) return undefined;
    params.reply.refit = limit => finishIndexedCodeTrace({ ...params, page: 1, limit }, output);
    params.reply.validate = async () => { await validateRankedCorpus(output, params.callNative, { signal: params.signal, timeoutMs: 25_000 }); };
    return await finishIndexedCodeTrace(params, output);
  } catch (error) {
    params.signal?.throwIfAborted();
    return resultText(`Indexed ${params.relation} trace unavailable: ${sanitizeAgentText(error instanceof Error ? error.message : String(error))}\nNo indexing, repair or legacy fallback was performed.`,
      harnessEnvelope({ status: "warning", summary: "Indexed trace unavailable.", next_actions: [], artifacts: [], diagnostics: ["indexed_projection_unavailable"] }));
  }
}

async function finishIndexedCodeTrace(
  params: CodeTraceRequest,
  output: NativeOutput,
) {
  const record = indexedGraphEvidence(output);
  const root = output.sourceRoot ?? params.root;
  const isTests = params.relation === "tests";
  // Callers/callees exclude the queried root from the result nodes. Tests keep
  // only projected caller nodes flagged is_test by the indexed source.
  const rootIds = new Set(record.roots.map((node: any) => node.id));
  const nodes = record.nodes.filter((node: any) => !rootIds.has(node.id) && (!isTests || node.is_test === true));
  const raw = {
    status: record.status,
    candidates: record.candidates,
    source_claims: record.source_claims,
    truncated: record.truncated,
    start_node: record.start_node,
    search_mode: record.project_navigation.search_mode,
    coverage: record.coverage,
    results: nodes,
    ...(isTests ? {} : { edges: record.edges }),
    project_navigation: { ...record.project_navigation, relation: params.relation, target: params.target },
  };
  const paged = pagePreparedEvidence(raw, {
    page: params.page,
    limit: params.limit,
    request: { tool: "trace", relation: params.relation, target: params.target, limit: params.limit },
    rootIdentity: root,
    generationIdentity: record.project_navigation.graph_generation_identity,
    collectionPaths: isTests ? ["results", "candidates"] : ["results", "edges", "candidates"],
  });
  const visible = withoutSourceClaims(paged) as any;
  if (record.status === "ambiguous") {
    return renderAmbiguousTraceResult(params.target, params.relation, visible);
  }
  const leads = indexedTraceLeads(params.relation, params.target, visible);
  const rendered = renderIndexedCodeTraceResult(params.relation, params.target, visible, params.limit);
  const expectedRawDigests = sourceDigests(paged, root);
  const authorityLeads = selectAuthorityLeads(leads, 12);
  let proof: Awaited<ReturnType<typeof prepareExactLeads>> | undefined;
  let proofFailure: string | undefined;
  try {
    if (authorityLeads.length) proof = await prepareExactLeads({ cwd: root, nativeText: rendered, leads: authorityLeads,
      expectedRawDigests, requireVersion: true, signal: params.signal, callNative: params.callNative });
  } catch (error) {
    params.signal?.throwIfAborted();
    proofFailure = "exact source proof unavailable; use read for source authority";
  }
  const reason = proof?.reason ?? proofFailure;
  const text = `${proof?.text ?? rendered}${reason ? `\n\nSource handoff: ${proof?.promoted ? "partial authority" : "locator-only"}; ${reason}.` : ""}`;
  const status = record.status === "error" ? "error" : record.status === "ok" && !record.truncated && !proofFailure ? "success" : "warning";
  const summary = `${indexedTraceSummary(params.relation, params.target, visible)}${proof?.artifacts?.length ? ` · ${proof.artifacts.length} certified source artifacts` : ""}`;
  const result: any = resultText(text, harnessEnvelope({ status, summary,
    next_actions: [], artifacts: proof?.artifacts ?? [], diagnostics: [record.analysis.scope, ...(record.coverage?.reasons ?? []), ...(proofFailure ? [proofFailure] : [])] }));
  result.details.presentation = {
    kind: "trace",
    relation: params.relation,
    target: params.target,
    rows: indexedTraceRows(params.relation, params.target, visible),
    summary,
    pageWindows: visible?.project_navigation?.page_windows ?? [],
    generation: record.project_navigation.graph_generation_identity,
  };
  if (proof) params.reply.commits.push(proof.commit);
  return result;
}

function indexedTraceLeads(relation: string, target: string, native: unknown): Lead[] {
  const value = native && typeof native === "object" && !Array.isArray(native) ? native as any : {};
  const leads: Lead[] = [];
  const seen = new Set<string>();
  const push = (path: string, start: number, end: number, label: string) => {
    if (!path) return;
    const key = `${path}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    leads.push({ path, start, end, label, reason: `indexed ${relation} relationship site` });
  };
  for (const edge of Array.isArray(value.relationship_edges) ? value.relationship_edges : Array.isArray(value.edges) ? value.edges : []) {
    const path = String(edge?.file_path ?? edge?.path ?? "");
    const line = Number(edge?.line ?? edge?.line_start ?? 0) || undefined;
    if (line) push(path, line, line, String(edge?.source ?? edge?.target ?? target));
  }
  for (const node of Array.isArray(value.results) ? value.results : []) {
    const path = String(node?.file_path ?? "");
    const start = Number(node?.line_start ?? 0) || undefined;
    const end = Number(node?.line_end ?? node?.line_start ?? 0) || start;
    if (start) push(path, start, end === undefined ? start : end, String(node?.qualified_name ?? node?.name ?? target));
  }
  return leads;
}

function indexedTraceRows(relation: string, target: string, native: unknown): Array<{ origin: string; path: string; start?: number; end?: number; column?: number; label: string; peer?: string; kind?: string; functionReference?: boolean }> {
  const value = native && typeof native === "object" && !Array.isArray(native) ? native as any : {};
  if (relation === "tests") {
    return (Array.isArray(value.results) ? value.results : []).map((node: any) => ({
      origin: relation,
      path: String(node?.file_path ?? ""),
      start: Number(node?.line_start ?? 0) || undefined,
      end: Number(node?.line_end ?? node?.line_start ?? 0) || undefined,
      label: String(node?.kind ?? "test") === "test" ? "test file" : `${String(node?.kind ?? "test")} test candidate`,
      peer: String(node?.qualified_name ?? node?.name ?? target),
    }));
  }
  // Preserve same-line parallel edges as distinct rows and label function
  // references distinctly from invocations, exactly as the indexed edge carries.
  const rows: Array<{ origin: string; path: string; start?: number; end?: number; column?: number; label: string; peer?: string; kind?: string; functionReference?: boolean }> = [];
  for (const edge of Array.isArray(value.edges) ? value.edges : []) {
    const path = String(edge?.file_path ?? edge?.path ?? "");
    const line = Number(edge?.line ?? edge?.line_start ?? 0) || undefined;
    const peer = relation === "callers" ? String(edge?.source ?? "") : String(edge?.target ?? "");
    rows.push({ origin: relation, path, start: line, end: line, column: edge.column,
      label: `${edge?.functionReference === true ? "function reference" : "invocation"} ${peer}`.trim(),
      peer: peer || String(edge?.source ?? edge?.target ?? target),
      kind: String(edge?.kind ?? (edge?.functionReference === true ? "function reference" : "invocation")),
      functionReference: edge?.functionReference === true });
  }
  return rows;
}

function markerIndexedRelation(visible: any): string {
  const value = visible && typeof visible === "object" ? visible : {};
  const coverage = value.coverage && typeof value.coverage === "object" ? value.coverage : {};
  const windows = Array.isArray(value.project_navigation?.page_windows) ? value.project_navigation.page_windows : [];
  const primary = windows.find((window: any) => window?.path === "edges") ?? windows.find((window: any) => window?.path === "results");
  return `bounded-selection=${coverage.complete === true ? "complete" : "incomplete"}${primary ? ` · ${primary.returned_count ?? 0}/${primary.total_count ?? 0} shown` : ""}`;
}

function renderIndexedCodeTraceResult(relation: string, target: string, native: unknown, limit: number): string {
  const value = native && typeof native === "object" && !Array.isArray(native) ? native as any : {};
  if (relation === "tests") {
    const rows = indexedTraceRows(relation, target, native);
    const lines = [`Code tests: ${JSON.stringify(target)}`];
    lines.push(`Status: indexed test-file candidates by path-naming heuristic; not execution or coverage proof · ${markerIndexedRelation(value)}.`);
    if (rows.length) {
      lines.push("", "Test file candidates");
      for (const row of rows) lines.push(`- ${row.path}${row.start ? `:${row.start}${row.end && row.end !== row.start ? `-${row.end}` : ""}` : ""}`);
    } else {
      lines.push("", "Test relation result: 0 indexed test-file candidates for this symbol.");
    }
    lines.push(`Basis: ${value.project_navigation?.evidence_basis ?? "best-effort indexed relationships; not binding or absence proof"}`);
    lines.push(`Generation: ${value.project_navigation?.graph_generation_identity ?? value.project_navigation?.generation_identity ?? "unknown"}`);
    return lines.join("\n");
  }
  const rows = indexedTraceRows(relation, target, native);
  const lines = [`Code ${relation}: ${JSON.stringify(target)}`];
  lines.push(`Status: indexed code graph relation · ${rows.length} row(s) · ${markerIndexedRelation(value)} · page ${value.project_navigation?.page_windows?.[0]?.page ?? 1}.`);
  if (rows.length) {
    lines.push("", "Relationship context");
    for (const row of rows.slice(0, limit)) {
      const site = row.path ? `${row.path}${row.start ? `:${row.start}` : ""}${Number.isSafeInteger(row.column) ? ` col0=${row.column}` : ""}` : "unknown site";
      lines.push(`- ${row.label} · ${site}`);
    }
    if (rows.length > limit) lines.push(`- … ${rows.length - limit} more indexed row(s) omitted by limit`);
  } else {
    lines.push("", `${relation} relation result: 0 indexed rows.`);
  }
  lines.push(`Basis: ${value.project_navigation?.evidence_basis ?? "best-effort indexed relationships; not binding or absence proof"}`);
  lines.push(`Generation: ${value.project_navigation?.graph_generation_identity ?? value.project_navigation?.generation_identity ?? "unknown"}`);
  return lines.join("\n");
}

function indexedTraceSummary(relation: string, target: string, native: unknown): string {
  const rows = indexedTraceRows(relation, target, native);
  const noun = relation === "tests" ? "test-file candidate(s)" : `${relation} row(s)`;
  return `Indexed ${relation}: ${rows.length} ${noun}`;
}

function visibleTraceAuthorityLeads(params: { relation: string; target: string; limit: number }, native: unknown, leads: Lead[]): Lead[] {
  const exactEdgeLeads = relationshipRowsFromNative(native, params.relation, params.target).map(row => ({
    path: row.path,
    start: row.start,
    end: row.end,
    label: row.label,
    reason: `${params.relation} exact relationship site`,
  }));
  const { relationLeads } = splitTargetAndRelationshipLeads(params.target, leads, native);
  if (params.relation === "tests") {
    const candidates = [...exactEdgeLeads, ...relationLeads].filter(lead => looksLikeTestPath(lead.path));
    return selectAuthorityLeads(dedupeTestLeads(candidates).slice(0, params.limit));
  }
  if (params.relation === "file_summary") return selectAuthorityLeads(leads.slice(0, params.limit));
  return selectAuthorityLeads(dedupeRelationshipLeads([...exactEdgeLeads, ...relationLeads]).slice(0, params.limit));
}

type TraceAmbiguityCandidate = {
  name: string;
  kind: string;
  path: string;
  start?: number;
  end?: number;
  qualifiedName: string;
  retryTarget: string;
};

function traceAmbiguityCandidates(native: unknown, target: string): { exact: TraceAmbiguityCandidate[]; related: TraceAmbiguityCandidate[] } {
  const value = native && typeof native === "object" && !Array.isArray(native) ? native as any : {};
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  const handoffs = Array.isArray(value?.project_navigation?.candidate_handoffs) ? value.project_navigation.candidate_handoffs : [];
  const exactTargets = new Set(handoffs.filter((item: any) => item?.exact_name === true).map((item: any) => String(item?.retry_target ?? "")).filter(Boolean));
  const toRow = (item: any): TraceAmbiguityCandidate => {
    const qualifiedName = String(item?.qualified_name ?? item?.retry_target ?? "");
    return {
      name: String(item?.name ?? item?.label ?? qualifiedName.split("::").at(-1) ?? "candidate"),
      kind: String(item?.kind ?? "Symbol"),
      path: String(item?.file_path ?? item?.path ?? ""),
      start: Number(item?.line_start ?? item?.start ?? item?.line ?? 0) || undefined,
      end: Number(item?.line_end ?? item?.end ?? item?.line ?? 0) || undefined,
      qualifiedName,
      retryTarget: String(item?.retry_target ?? qualifiedName),
    };
  };
  const exact: TraceAmbiguityCandidate[] = [];
  const related: TraceAmbiguityCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const row = toRow(candidate);
    const isExact = row.name === target || row.qualifiedName === target || exactTargets.has(row.qualifiedName);
    const key = row.retryTarget || `${row.path}:${row.start ?? ""}:${row.name}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    (isExact ? exact : related).push(row);
  }
  for (const handoff of handoffs) {
    if (handoff?.exact_name !== true) continue;
    const row = toRow(handoff);
    const key = row.retryTarget || `${row.path}:${row.start ?? ""}:${row.name}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    exact.push(row);
  }
  return { exact, related };
}

function ambiguityCandidateLine(candidate: TraceAmbiguityCandidate): string {
  const range = candidate.path ? `${candidate.path}${candidate.start ? `:${candidate.start}${candidate.end && candidate.end !== candidate.start ? `-${candidate.end}` : ""}` : ""}` : "location unavailable";
  return `- ${candidate.retryTarget || candidate.qualifiedName || candidate.name} · ${candidate.kind} · ${range}`;
}

function renderAmbiguousTraceResult(target: string, relation: string, native: unknown) {
  const { exact, related } = traceAmbiguityCandidates(native, target);
  const value = native && typeof native === "object" && !Array.isArray(native) ? native as any : {};
  const candidateWindow = Array.isArray(value?.project_navigation?.page_windows)
    ? value.project_navigation.page_windows.find((item: any) => item?.path === "candidates")
    : undefined;
  const generation = value?.project_navigation?.metadata?.graph_generation_identity ?? value?.project_navigation?.generation_identity;
  const text = [
    `Code ${relation}: ${JSON.stringify(target)}`,
    "Status: qualification required; no structural relation was completed.",
    exact.length ? `Exact-name retry candidates (${exact.length}):` : "No exact-name retry candidate was returned.",
    ...exact.map(ambiguityCandidateLine),
    !exact.length ? "Use explore(code) search to qualify the symbol, then retry trace with one exact qualified identity." : "Retry trace with one exact qualified identity above.",
    related.length ? `Related approximate matches — not retry identities (${related.length}):` : "",
    ...related.map(ambiguityCandidateLine),
    candidateWindow ? `Coverage: candidate page ${candidateWindow.page ?? 1}/${candidateWindow.total_pages ?? 1} · ${candidateWindow.returned_count ?? exact.length + related.length}/${candidateWindow.total_count ?? exact.length + related.length} shown${candidateWindow.complete === false ? ` · next ${candidateWindow.next_page ?? "available"}` : " · complete"}` : "",
    generation ? `Generation: ${generation}` : "",
  ].filter(Boolean).join("\n");
  const result: any = resultText(text, harnessEnvelope({ status: "warning", summary: exact.length ? "Code trace requires one exact qualified identity before the relation can run." : "Code trace could not qualify the requested bare symbol.", next_actions: ["Use one exact qualified identity before retrying this relation."], artifacts: [], diagnostics: ["qualification_required", ...(related.length ? [`approximate_candidates=${related.length}`] : [])] }));
  result.details.presentation = {
    kind: "trace",
    relation,
    target,
    rows: exact.map(candidate => ({ origin: "exact-name candidate", path: candidate.path, start: candidate.start, end: candidate.end, label: candidate.retryTarget })),
    summary: exact.length ? `${exact.length} exact-name qualification candidate(s).` : "No exact-name qualification candidate.",
    pageWindows: Array.isArray(value?.project_navigation?.page_windows) ? value.project_navigation.page_windows : [],
  };
  result.details.ambiguity = { exactCandidates: exact, relatedCandidateCount: related.length };
  return result;
}

function sourceDigests(native: unknown, root: string): Record<string, string> {
  if (!native || typeof native !== "object" || !Array.isArray((native as any).source_claims)) return {};
  const entries: Array<[string, string]> = [];
  for (const claim of (native as any).source_claims) {
    if (typeof claim?.path !== "string" || !/^[A-F0-9]{64}$/i.test(String(claim?.raw_digest ?? ""))) continue;
    const digest = String(claim.raw_digest).toUpperCase();
    entries.push([claim.path, digest]);
    entries.push([isAbsolute(claim.path) ? claim.path : resolve(root, claim.path), digest]);
  }
  return Object.fromEntries(entries);
}

function withoutSourceClaims(native: unknown): unknown {
  if (!native || typeof native !== "object" || Array.isArray(native)) return native;
  const { source_claims: _hidden, ...visible } = native as Record<string, unknown>;
  return visible;
}

function withTracePresentation(result: any, relation: string, target: string, native: unknown, leads: Lead[]) {
  const value = native && typeof native === "object" && !Array.isArray(native) ? native as any : {};
  const { relationLeads } = splitTargetAndRelationshipLeads(target, leads, native);
  const edgeRows = relationshipRowsFromNative(native, relation, target);
  const leadRows = dedupeRelationshipLeads(relationLeads).map(lead => ({
    origin: relation,
    path: lead.path,
    start: lead.start,
    end: lead.end,
    label: lead.label ?? lead.reason ?? relation,
  }));
  const rows = edgeRows.length ? edgeRows : leadRows;
  result.details ??= {};
  result.details.presentation = {
    kind: "trace",
    relation,
    target,
    rows,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    pageWindows: Array.isArray(value?.project_navigation?.page_windows) ? value.project_navigation.page_windows : [],
  };
  // Public text is deliberately compact; retain the full prepared relation for
  // programmatic inspection without repeating it in the model-facing channel.
  result.details.native = withoutSourceClaims(native);
  return result;
}

/** Split a file-qualified symbol identity (`path/to/file.ts::Symbol`,
 * `path#Symbol`) into its declaration file and bare symbol. A `::`/`#` form
 * without a path-like head (e.g. `Class::method`) is a qualified name, not a
 * file identity, and returns undefined so the existing route runs unchanged.
 */
function splitFileQualifiedSymbolTarget(target: string): { file: string; symbol: string } | undefined {
  const cuts: Array<{ head: string; symbol: string }> = [];
  let search = 0;
  while (search < target.length) {
    const double = target.indexOf("::", search);
    const hash = target.indexOf("#", search);
    let at = -1;
    let width = 0;
    if (double !== -1 && (hash === -1 || double < hash)) { at = double; width = 2; }
    else if (hash !== -1) { at = hash; width = 1; }
    else break;
    cuts.push({ head: target.slice(0, at), symbol: target.slice(at + width) });
    search = at + width;
  }
  for (const cut of cuts) {
    if (!cut.symbol) continue;
    // Recognizable file boundary mirrors grep.ts::grepTargetAddress (path
    // separator or known source extension): never split the colons in a
    // qualified name. No shared helper exists; the rule is mirrored here, not a service.
    if (/[\\/]/.test(cut.head) || /\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|[ch]|cc|cpp|hpp|php|kts?|zig|swift|exs?|rb|md)$/i.test(cut.head)) return { file: cut.head, symbol: cut.symbol };
  }
  return undefined;
}

function normalizeTraceFilePath(root: string, file: string): string {
  const forward = String(file).replace(/\\/g, "/").replace(/^\.\//, "");
  const absolute = isAbsolute(forward) ? forward : resolve(root, forward);
  return relative(root, absolute).replace(/\\/g, "/").replace(/^\.\//, "");
}

function callersIdentityRefusal(relation: string, target: string, lines: string[], diagnostic: string, rowNoun: string) {
  return resultText([
    `Code ${relation}: ${JSON.stringify(target)}`,
    "Status: exact declaration identity could not be verified on the live route; no structural relation was completed.",
    ...lines,
    `No ${rowNoun} are claimed. Scoped absence is not established.`,
  ].join("\n"), harnessEnvelope({ status: "warning", summary: `Trace ${relation} identity unverified; no relation completed.`, next_actions: ["Use explore.code search to qualify the symbol, then retry trace with one exact qualified identity."], artifacts: [], diagnostics: [diagnostic] }));
}

/** Verify a file-qualified symbol target against current declaration sites
 * before the live native route runs. That route matches bare identifier
 * tokens, so the qualified form must resolve to exactly one current
 * declaration site in the requested file: the raw form yields a fabricated
 * complete zero (no owner) or silently mixed same-named owners — including
 * two same-named declarations in one file, which a per-file set would hide.
 * A truncated ownership probe is unverifiable and refused outright. Scope
 * stays project-wide — external rows are never narrowed away. Only exact
 * symbol-name equality counts: namespace-qualified candidates stay
 * binding-unverified rather than silently accepted.
 */
async function verifyFileQualifiedSymbolTarget(params: { root: string; scope: string; signal?: AbortSignal; callNative: PiNavCaller }, file: string, symbol: string, target: string, relation: "callers" | "tests"): Promise<{ query: string } | { refusal: ReturnType<typeof resultText> }> {
  const rowNoun = relation === "callers" ? "call-site rows" : "test rows";
  const probe = await params.callNative({
    root: params.root,
    operation: "pi_nav_search",
    args: { query: symbol, kind: "symbol", scope: params.scope, expand: 0, budget: 5000 },
    timeoutMs: 25_000,
    signal: params.signal,
  });
  if ((probe.structured as any)?.completeness?.complete === false) {
    return { refusal: callersIdentityRefusal(relation, target, [`Reason: the ownership probe reply was incomplete (truncated), so uniqueness of ${JSON.stringify(symbol)} cannot be established; proceeding would risk mixed or missing owners.`], `unverified_${relation}_identity=incomplete_probe`, rowNoun) };
  }
  const matches = Array.isArray((probe.structured as any)?.data?.matches) ? (probe.structured as any).data.matches : [];
  const owners = new Map<string, string>();
  for (const match of matches) {
    if (match?.role !== "definition") continue;
    if (typeof match?.symbol !== "string" || match.symbol !== symbol) continue;
    const path = match?.location?.path;
    const start = match?.location?.start;
    const end = match?.location?.end;
    if (typeof path !== "string" || !path || !Number.isInteger(start) || !Number.isInteger(end)) continue;
    const site = `${normalizeTraceFilePath(params.root, path)}:${start}-${end}`;
    if (!owners.has(site)) owners.set(site, `"${normalizeTraceFilePath(params.root, path)}:${start}-${end}"`);
  }
  const requested = normalizeTraceFilePath(params.root, file);
  if (!owners.size) {
    return { refusal: callersIdentityRefusal(relation, target, [`Reason: no current definition of ${JSON.stringify(symbol)} was found in scope; zero ${rowNoun} would be a fabricated answer.`], `unverified_${relation}_identity=no_definition`, rowNoun) };
  }
  const requestedSites = [...owners.keys()].filter(site => site === requested || site.startsWith(`${requested}:`));
  if (owners.size > 1 || !requestedSites.length) {
    const competing = [...owners.values()].sort().slice(0, 8);
    return { refusal: callersIdentityRefusal(relation, target, [
      `Reason: ${owners.size > 1 ? `the name ${JSON.stringify(symbol)} has ${owners.size} same-named current declaration sites, so live rows cannot be attributed to ${JSON.stringify(requested)} without mixing owners` : `the single current declaration site is ${competing[0]}, not in the requested ${JSON.stringify(requested)}`}.`,
      `Competing declaration site(s): ${competing.join(", ")}${owners.size > competing.length ? ` +${owners.size - competing.length} more` : ""}.`,
    ], `unverified_${relation}_identity=ambiguous_or_mismatched_owner`, rowNoun) };
  }
  return { query: symbol };
}

async function runNativeCodeTrace(
  params: CodeTraceRequest,
) {
  const budget = Math.max(1000, Math.min(20_000, Math.floor(params.limit * 1000)));
  const depsRelation = (params.relation === "imports" || params.relation === "importers") && looksFileishTarget(params.target);
  const operation = params.relation === "callers"
    ? { name: "pi_nav_search", args: { query: params.target, kind: "callers", scope: params.scope, expand: 0, budget } }
    : depsRelation
      ? { name: "pi_nav_deps", args: { path: isAbsolute(params.target) ? canonicalProjectPath(params.target) : params.target, scope: params.scope, budget } }
      : params.relation === "tests"
        ? { name: "pi_nav_search", args: { query: params.target, kind: "symbol", scope: params.scope, expand: 0, budget } }
        : undefined;
  if (!operation) {
    return resultText([
      `UNAVAILABLE: native structural trace does not support relation ${JSON.stringify(params.relation)}.`,
      "Supported native routes are callers, file imports/importers through typed dependency evidence, and homogeneous test-file candidates from typed symbol locations.",
      "Callees needs prepared indexed code evidence; query time never builds, repairs or adopts one.",
      "No build/update/index/provider call or grep/find fallback was attempted at query time.",
    ].join("\n"), harnessEnvelope({ status: "warning", summary: `Native structural route does not support ${params.relation}.`, next_actions: ["Use navigation-setup to prepare indexed code evidence, or use explore/grep for a different relation."], artifacts: [], diagnostics: [`unsupported_native_relation=${params.relation}`] }));
  }
  try {
    const identityRelation = params.relation === "callers" || params.relation === "tests" ? params.relation : undefined;
    if (identityRelation) {
      const qualified = splitFileQualifiedSymbolTarget(params.target);
      if (qualified) {
        const verified = await verifyFileQualifiedSymbolTarget(params, qualified.file, qualified.symbol, params.target, identityRelation);
        if ("refusal" in verified) return verified.refusal;
        (operation.args as Record<string, unknown>).query = verified.query;
      }
    }
    const output = await params.callNative({
      root: params.root,
      operation: operation.name,
      args: operation.args,
      timeoutMs: 25_000,
      signal: params.signal,
    });
    const structured = depsRelation ? filterNativeDeps(output.structured, params.relation) : params.relation === "tests" ? filterNativeTests(output.structured) : output.structured;
    const leads = nativeLocationLeads(structured).slice(0, params.limit);
    const evidence = nativeSourceEvidence(structured, { capability: "trace", backend: "pi-nav", route: params.relation });
    const selectedNative = depsRelation || params.relation === "tests";
    const nativeText = selectedNative
      ? `${output.text}\n\n${renderNativeResult(`Selected native ${params.relation}`, structured, leads, { maxNativeChars: 8000, contextLabel: "Typed structural relation" })}`
      : output.text;
    const authority = await prepareSourceAuthority({
      cwd: params.root,
      nativeText,
      evidence,
      sourceSnapshots: output.sourceSnapshots,
      signal: params.signal,
      callNative: params.callNative,
    });
    const text = authority.text;
    const envelope = envelopeForLeads(`Native code ${params.relation} returned relationship context.`, leads, [
      `relation=${params.relation}`,
      ...structured.diagnostics,
    ]);
    if (authority.certified) envelope.artifacts = [...new Set([...(envelope.artifacts ?? []), ...authority.authorities.map(item => `[${item.path}#${item.tag}]`)])];
    const result = nativeToolResult(text, structured, envelope);
    if (result.content[0].text === text) params.reply.commits.push(authority.commit);
    return result;
  } catch (error) {
    return resultText([
      "ERROR: native structural trace failed.",
      `Reason: ${error instanceof Error ? error.message : String(error)}`,
      "No command, PATH, setup/indexing, or grep/find fallback route was used.",
    ].join("\n"), harnessEnvelope({ status: "error", summary: "Native structural trace failed; no fallback used.", next_actions: ["Use navigation-debug for diagnosis."], artifacts: [], diagnostics: [`relation=${params.relation}`] }));
  }
}


function filterNativeDeps(structured: any, relation: string): any {
  const data = structured?.data && typeof structured.data === "object" ? structured.data : {};
  const locations = Array.isArray(data.locations) ? data.locations : [];
  const targetPath = locations.find((location: any) => location?.role === "target")?.path;
  const relationships = (Array.isArray(data.relationships) ? data.relationships : []).filter((edge: any) => {
    if (!targetPath) return false;
    return relation === "imports" ? edge?.from?.path === targetPath : edge?.to?.path === targetPath;
  });
  const acceptedRole = relation === "imports" ? "dependency" : "dependent";
  const selectedLocations = locations.filter((location: any) => location?.role === "target" || location?.role === acceptedRole);
  return {
    ...structured,
    data: { ...data, relationships, locations: selectedLocations },
    diagnostics: [...(structured?.diagnostics ?? []), `typed_dependency_direction=${relation}`],
  };
}

function filterNativeTests(structured: any): any {
  const data = structured?.data && typeof structured.data === "object" ? structured.data : {};
  const locations = (Array.isArray(data.locations) ? data.locations : []).filter((location: any) => looksLikeTestPath(String(location?.path ?? "")));
  const sourceRows = (Array.isArray(data.sourceRows) ? data.sourceRows : []).filter((row: any) => looksLikeTestPath(String(row?.path ?? "")));
  const matches = (Array.isArray(data.matches) ? data.matches : []).filter((match: any) => looksLikeTestPath(String(match?.location?.path ?? match?.path ?? "")));
  return {
    ...structured,
    data: { ...data, locations, sourceRows, matches },
    diagnostics: [...(structured?.diagnostics ?? []), "typed_test_candidates=test_like_paths_only"],
  };
}

function looksLikeTestPath(path: string): boolean {
  const p = String(path).replace(/\\/g, "/");
  return /\/(tests?|__tests?)\//.test(p) ||
    /\.(test|spec)\./.test(p) ||
    /(^|\/)test_[^/]+$/.test(p) ||
    /(^|\/)[^/]+_test\.[^/]+$/.test(p);
}

function dedupeTestLeads(leads: Lead[]): Lead[] {
  // `tests` returns test files, so keep one selector per file and prefer the
  // narrowest native range (for example an import site) over a synthetic 1-80
  // file reference.
  const byPath = new Map<string, Lead>();
  for (const lead of leads) {
    const key = normalizeTargetForComparison(lead.path);
    const current = byPath.get(key);
    if (!current || leadSpanLength(lead) < leadSpanLength(current)) byPath.set(key, lead);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path) || Number(a.start ?? 1) - Number(b.start ?? 1));
}

function leadSpanLength(lead: Lead): number {
  const start = Number(lead.start ?? 1);
  const end = Number(lead.end ?? lead.start ?? start);
  return Math.max(1, end - start + 1);
}

function dedupeRelationshipLeads(leads: Lead[]): Lead[] {
  const byPath = new Map<string, Lead>();
  for (const lead of leads) {
    const key = normalizeTargetForComparison(lead.path);
    const current = byPath.get(key);
    if (!current || leadSpanLength(lead) < leadSpanLength(current)) byPath.set(key, lead);
  }
  return [...byPath.values()];
}

interface RelationshipPresentationRow {
  origin: string;
  path: string;
  start?: number;
  end?: number;
  label: string;
  kind?: string;
  peer?: string;
  provenance?: string;
  confidence?: number;
  resolution?: "resolved" | "unresolved";
}

function relationshipRowsFromNative(native: unknown, relation: string, target: string): RelationshipPresentationRow[] {
  if (!native || typeof native !== "object" || Array.isArray(native)) return [];
  const value = native as any;
  const edges = Array.isArray(value.relationship_edges) ? value.relationship_edges : Array.isArray(value.edges) ? value.edges : [];
  const normalizedTarget = normalizeTargetForComparison(target);
  const resolutionByQualifiedName = new Map<string, "resolved" | "unresolved">(
    (Array.isArray(value.results) ? value.results : [])
      .map((result: any) => [String(result?.qualified_name ?? ""), result?.resolution === "unresolved" || result?.unresolved_target === true ? "unresolved" : result?.resolution === "resolved" ? "resolved" : undefined] as const)
      .filter((entry: readonly [string, "resolved" | "unresolved" | undefined]) => entry[0] && entry[1]),
  );
  const rows = edges.flatMap((edge: any) => {
    const path = String(edge?.file_path ?? edge?.path ?? "");
    if (!path || normalizeTargetForComparison(path) === normalizedTarget) return [];
    const start = Number(edge?.line_start ?? edge?.start ?? edge?.line ?? 0) || undefined;
    const end = Number(edge?.line_end ?? edge?.end ?? edge?.line ?? 0) || start;
    const kind = String(edge?.kind ?? relation);
    const peer = relation === "callers" || relation === "importers"
      ? String(edge?.source ?? edge?.source_qualified ?? "")
      : String(edge?.target ?? edge?.target_qualified ?? "");
    return [{
      origin: relation,
      path,
      start,
      end,
      label: peer ? `${kind} ${peer}` : kind,
      kind,
      peer: peer || undefined,
      provenance: typeof edge?.provenance === "string" ? edge.provenance : undefined,
      confidence: Number.isFinite(Number(edge?.confidence)) ? Number(edge.confidence) : undefined,
      resolution: resolutionByQualifiedName.get(peer),
    }];
  });
  const seen = new Set<string>();
  return rows.filter((row: RelationshipPresentationRow) => {
    const key = `${normalizeTargetForComparison(row.path)}:${row.start ?? ""}:${row.end ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function splitTargetAndRelationshipLeads(target: string, leads: Lead[], native?: unknown): { targetLeads: Lead[]; relationLeads: Lead[] } {
  const normalizedTarget = normalizeTargetForComparison(target);
  const referencedKeys = looksFileishTarget(target) ? new Set<string>() : referencedTargetLeadKeys(native);
  const hasNonReferenceLead = leads.some(lead => !referencedKeys.has(leadKey(lead)));
  const targetLeads: Lead[] = [];
  const relationLeads: Lead[] = [];
  for (const lead of leads) {
    const normalizedPath = normalizeTargetForComparison(lead.path);
    const isExplicitTarget = normalizedTarget && (normalizedPath === normalizedTarget || normalizedPath.endsWith(`/${normalizedTarget}`));
    const isReferencedTarget = hasNonReferenceLead && referencedKeys.has(leadKey(lead));
    if (isExplicitTarget || isReferencedTarget) targetLeads.push(lead);
    else relationLeads.push(lead);
  }
  return { targetLeads, relationLeads };
}

function referencedTargetLeadKeys(native: unknown): Set<string> {
  const keys = new Set<string>();
  if (!native || typeof native !== "object" || !Array.isArray((native as any).results)) return keys;
  for (const item of (native as any).results) {
    if (/^referenced\b/i.test(String(item?.summary ?? "")) && typeof item?.path === "string") {
      keys.add(leadKey({ path: item.path, start: item.start, end: item.end }));
    }
  }
  return keys;
}

function leadKey(lead: Pick<Lead, "path" | "start" | "end">): string {
  return `${normalizeTargetForComparison(lead.path)}:${lead.start ?? 1}:${lead.end ?? lead.start ?? 80}`;
}

function normalizeTargetForComparison(value: string): string {
  return String(value ?? "").replace(/\\/g, "/").replace(/:\d+(?:-\d+)?$/, "").replace(/^\.\//, "");
}

function graphNativeWithWarnings(native: unknown, warningText: string): unknown {
  if (!warningText) return native;
  const warnings = warningText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (native && typeof native === "object" && !Array.isArray(native)) return { warnings, ...(native as Record<string, unknown>) };
  const body = String(native ?? "").trim();
  return [warningText, body].filter(Boolean).join("\n");
}

function looksFileishTarget(target: string): boolean {
  return /[\\/]|\.[A-Za-z0-9]{1,8}(?::\d+)?$/.test(target);
}


