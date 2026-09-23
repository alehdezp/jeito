import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { harnessEnvelope, referenceTokenCount } from "../core/harness-result.ts";
import { renderExploreCall, renderExploreResult } from "../core/tui-render.ts";
import { S } from "../core/schema.ts";
import { prepareExactLeads, prepareSourceAuthority } from "../core/source-authority.ts";
import { nativeSourceEvidence } from "../core/pi-nav-evidence.ts";
import { callPiNav, callIndexedGraphNavigation, validateRankedCorpus, type NativeOutput, type PiNavCaller } from "../core/pi-nav-native.ts";
import { firstCallGate } from "../core/tool-call-ledger.ts";
import { pagePreparedEvidence } from "../core/prepared-page.ts";
import { asToolCallValidationError, boundedInvalidToolCallResult, normalizedEnum, normalizedInteger, ToolCallValidationError, withToolCallNormalizations } from "../core/tool-call-contract.ts";
import {
  backendArtifactMissing,
  commandForLane,
  envelopeForLeads,
  graphifyQueryEnv,
  indexedGraphEvidence,
  graphPathForLane,
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
  selectAuthorityLeads,
  scopeRootForLane,
  unavailableResult,
} from "../core/navigation-clean.ts";

const CODE_OPERATIONS = new Set(["search", "traverse"]);
const SEARCH_KINDS = new Set(["File", "Class", "Function", "Method", "Type", "Test", "Interface", "Trait"]);
const ROOT_FILE_IDENTITY = /^[^\\/\s]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const GRAPHIFY_MAP_TIMEOUT_MS = 20_000;
const GRAPHIFY_MAP_BUDGET = 15000;
// The captured map-quality corpus peaks at 15,235 bytes; 16 KiB preserves it
// without inventing a second row-count budget below the shared output ceiling.
const GRAPHIFY_MAP_NATIVE_CHARS = 16 * 1024;
// Indexed code projections own their own row windows through pagePreparedEvidence;
// the retired CRG search/traverse fetch ceiling is gone with that adapter.

export const exploreParams = S.object({
  query: S.string("Map only. Not a question — a packet of exact things: the strongest path first, then 1-3 symbol or config-key anchors. Prose is noise. Rejected with view:'code' (use anchor)."),
  view: S.string("'code' for code search/traverse, 'map' for cross-domain. Required."),
  operation: S.string("Code only: 'search' finds the owner when you know the behavior but not its location; 'traverse' walks around one exact symbol. Required with view:'code'."),
  anchor: S.string("Code only (map uses query). Search: one behavior phrase plus any exact name you have. Traverse: copy the exact qualified name or file path from a search result."),
  kind: S.string("Search-only filter: File, Class, Function, Method, Type, Test, Interface, Trait. Leave it out unless you already know the kind — filtering can hide the owner."),
  depth: S.number("Traverse only: steps around the symbol, 1-6, default 2."),
  scope: S.string("Which project to search. In a monorepo each extension is its own project; without scope the parent is searched. It picks the project, not a folder inside it."),
  page: S.number("Next page — pass it back with everything else unchanged; restart at page 1 if the generation changed."),
  limit: S.number("Page size 1-300; default 80. Omit limit for normal calls because the default is intentionally broad. Raise it toward 300 only when omitted candidates, nodes, or edges could change the answer and one wider page is useful; otherwise continue the unchanged request with page. Code pages candidates/topology; map pages NODE and EDGE rows independently (page 1 shows up to `limit` nodes + `limit` edges) while preserving traversal/start context."),
}, ["view"]);

export function registerExploreTool(pi: ExtensionAPI, options: { callNative?: PiNavCaller } = {}): void {
  pi.registerTool({
    name: "explore",
    label: "explore",
    renderShell: "self",
    renderCall: renderExploreCall as any,
    renderResult: renderExploreResult as any,
    description: "Three tools in one: find the code behind a behavior (search), look around a symbol you already found (traverse), see how code and docs connect (map). Example: explore({view:'code', operation:'search', anchor:'registerGrepTool', scope:'extensions/codeweave-pi'}).",
    promptGuidelines: ["Chain them: search names an owner → traverse its neighborhood → map its cross-domain connections when the task spans code and docs. Re-enter with a stronger identity when a result or a read reveals one — one good call, not one frozen call.\n\nThe map notation legend prints only on the first map call of a session; read it there.\n\nThe Search mode line says hybrid (meaning-matched) or lexical (word-matched) — a zero from vague prose in lexical mode is not a real zero.\n\nquery_anchoring=native-text-only means add a recognizable path or symbol."],
    parameters: exploreParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const normalizations: string[] = [];
      let view: string;
      let limit: number;
      let page: number;
      let operation: string | undefined;
      let query: string | undefined;
      let code: { anchor: string; kind?: string; depth: number } | undefined;
      try {
        rejectObsoleteNavigationParams("explore", params, ["query", "view", "operation", "anchor", "kind", "depth", "scope", "limit", "page"]);
        view = normalizedEnum(params.view, "explore view", ["code", "map"], normalizations);
        limit = normalizedInteger(params.limit, "explore limit", 80, 1, 300, normalizations);
        page = normalizedInteger(params.page, "explore page", 1, 1, Number.MAX_SAFE_INTEGER, normalizations);
        if (view === "map") {
          rejectIncompatibleExploreFields(params, ["operation", "anchor", "kind", "depth"], "map");
          query = requiredString(params.query, "explore map query");
        } else {
          operation = normalizedEnum(params.operation, "explore code operation", ["search", "traverse"], normalizations);
          if (params.query !== undefined) throw new ToolCallValidationError("explore view:'code' uses anchor, not query.", { accepted: ["code search: {view:'code', operation:'search', anchor:'behavior or signature'}", "code traverse: {view:'code', operation:'traverse', anchor:'exact qualified identity'}"], guidance: ["Move the identity to anchor and remove query."], received: params.query });
          code = validateCodeOperation({ operation, anchor: params.anchor, kind: params.kind, depth: params.depth }, normalizations);
        }
      } catch (error) {
        return boundedInvalidToolCallResult("explore", asToolCallValidationError(error, {
          accepted: ["map: {view:'map', query:'small concrete identity packet'}", "code search: {view:'code', operation:'search', anchor:'behavior/signature vocabulary'}", "code traverse: {view:'code', operation:'traverse', anchor:'exact qualified symbol or File identity'}"],
          guidance: ["Use query only for map; use anchor only for code.", "Inspect returned starts, candidates, health, paging and generation before refining."],
          received: params,
        }));
      }
      const resolved = await resolveNavigationScope(ctx.cwd, params.scope);
      if (!resolved.ok) return resultText(resolved.text, resolved.envelope);
      if (view === "map") return withToolCallNormalizations(await exploreMap({ scope: resolved.scope, cwd: ctx.cwd, query: query!, limit, page, normalizations, signal }), normalizations);
      const reply: CodeExploreReply = { commits: [] };
      const request: CodeExploreRequest = { scope: resolved.scope, cwd: ctx.cwd, operation: operation!, ...code!, limit, page, signal, callNative: options.callNative ?? callPiNav, reply };
      return finishCodeExploreReply(await exploreCode(request), request, normalizations);
    },
  });
}

interface CodeExploreReply {
  commits: Array<() => void>;
  refit?: (limit: number) => Promise<any>;
  validate?: () => Promise<void>;
}
type CodeExploreRequest = { scope: string; cwd: string; operation: string; anchor: string; kind?: string; depth: number; limit: number; page: number; signal?: AbortSignal; callNative: PiNavCaller; reply: CodeExploreReply };

async function finishCodeExploreReply(original: any, params: CodeExploreRequest, normalizations: string[]) {
  let limit = params.limit;
  const compose = () => {
    const result = { ...original, content: original.content.map((part: any) => ({ ...part })), details: { ...original.details } };
    if (limit !== params.limit) {
      const notice = `Reply budget: requested page ${params.page}, limit ${params.limit}; restarted at page 1, limit ${limit}. Continue from this new page size, not the previous sequence; no generation is pinned.`;
      result.content[0].text = `${notice}\n\n${result.content[0].text}`;
      result.details.status = "partial";
      result.details.envelope = { ...result.details.envelope, status: "warning", diagnostics: [...(result.details.envelope?.diagnostics ?? []), notice] };
      result.details.budgetRestart = { requestedPage: params.page, requestedLimit: params.limit, page: 1, limit };
    }
    return withToolCallNormalizations(result, normalizations, true);
  };
  let result = compose();
  let tokens = referenceTokenCount(result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"));
  while (tokens > 4_000 && limit > 1 && params.reply.refit) {
    limit = Math.max(1, Math.min(limit - 1, Math.floor(limit * Math.min(0.8, 3_600 / tokens))));
    params.reply.commits = [];
    original = await params.reply.refit(limit);
    result = compose();
    tokens = referenceTokenCount(result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"));
  }
  if (tokens > 4_000) return resultText("Code exploration withheld: complete identities and evidence cannot fit the 4,000-token reply budget. Narrow the anchor/scope or request fewer rows. No source authority was granted.",
    harnessEnvelope({ status: "warning", summary: "Code exploration exceeds its reply budget.", next_actions: [], artifacts: [], diagnostics: ["reply_budget"] }));
  try {
    await params.reply.validate?.();
  } catch (error) {
    params.signal?.throwIfAborted();
    return resultText("Indexed code exploration withheld: corpus admission changed before delivery. Retry the request; no source authority was granted.",
      harnessEnvelope({ status: "warning", summary: "Indexed code exploration admission failed.", next_actions: [], artifacts: [], diagnostics: ["indexed_projection_unavailable"] }));
  }
  params.signal?.throwIfAborted();
  for (const commit of params.reply.commits) commit();
  return result;
}

async function exploreCode(params: CodeExploreRequest) {
  try {
    const kinds: Record<string, string[]> = { File: ["file"], Class: ["class", "struct"], Function: ["function"], Method: ["method"], Type: ["type_alias", "enum", "union"], Interface: ["interface", "protocol"], Trait: ["trait"] };
    const output = await callIndexedGraphNavigation({ root: params.scope, query: params.anchor, signal: params.signal,
      projection: params.operation === "traverse" ? { operation: "traverse", depth: params.depth }
        : { operation: "search", ...(params.kind === "Test" ? { testOnly: true } : params.kind ? { nodeKinds: kinds[params.kind] } : {}) },
    }, params.callNative);
    if (output) return await exploreIndexedCode(params, output);
  } catch (error) {
    params.signal?.throwIfAborted();
    return resultText(`Code exploration unavailable: ${sanitizeAgentText(error instanceof Error ? error.message : String(error))}\nNo indexing, repair or legacy fallback was performed.`, harnessEnvelope({ status: "warning", summary: "Indexed code exploration unavailable.", next_actions: [], artifacts: [], diagnostics: ["indexed_projection_unavailable"] }));
  }
  return resultText([
    "UNAVAILABLE: code exploration is unavailable for this scope.",
    "Reason: no published indexed code graph may be read here. Query time never builds, indexes, repairs or adopts one.",
    "Use the grep tool for lexical and semantic code discovery, then read the source it returns; explore view:'map' covers cross-domain Graphify questions.",
    "No query-time setup, provider call, mutation or fallback navigation was used.",
  ].join("\n"), harnessEnvelope({ status: "warning", summary: "Indexed code exploration unavailable.", next_actions: ["Use grep for code discovery, then read the returned selectors."], artifacts: [], diagnostics: ["indexed_projection_unavailable"] }));
}

async function exploreIndexedCode(params: CodeExploreRequest, output: NativeOutput) {
  const record = indexedGraphEvidence(output);
  let nodes = record.nodes;
  let excludedTests = 0;
  let retainedTestOnly = false;
  if (params.operation === "search" && params.kind !== "Test") {
    const implementations = nodes.filter((node: any) => !isCodeTestCandidate(node));
    if (implementations.length) { excludedTests = nodes.length - implementations.length; nodes = implementations; }
    // Excluding every candidate would turn a useful prepared result into a
    // synthetic zero. Retain the test-only set and disclose why.
    else if (nodes.length) { retainedTestOnly = true; excludedTests = 0; }
  }
  const raw = { status: record.truncated && record.status === "ok" ? "incomplete" : record.status, candidates: record.candidates, source_claims: record.source_claims,
    truncated: record.truncated, start_node: record.start_node, max_depth: params.depth, mode: "bfs",
    search_mode: record.project_navigation.search_mode,
    semantic_status: params.kind === "File" ? "not_applicable" : record.analysis.semanticStatus,
    ...(params.operation === "search" ? { results: nodes } : { traversal: nodes, edges: record.edges }),
    project_navigation: { ...record.project_navigation, excluded_tests: excludedTests,
      ...(retainedTestOnly ? { test_only_results_retained: true } : {}),
      // Disclose why the edge order is meaningful once a traversal reorders it.
      edge_order: params.operation === "traverse" ? "traversal_relevance" : undefined,
      backend_fetch: { fetched_count: record.nodes.length, visible_count: nodes.length, native_truncated: record.truncated, lower_bound: record.truncated },
      diagnostics: [record.analysis.scope, ...(record.coverage?.reasons ?? []), ...(params.kind === "Test" && record.selection?.testMeaning ? [record.selection.testMeaning] : [])] },
  };
  if (params.operation === "traverse") relevanceOrderTraversalEdges(raw);
  const render = (page: number, limit: number) => {
    const paged = pagePreparedEvidence(raw, { page, limit,
      request: { view: "code", operation: params.operation, anchor: params.anchor, kind: params.kind, depth: params.depth, limit },
      rootIdentity: output.sourceRoot, generationIdentity: record.project_navigation.graph_generation_identity,
      collectionPaths: params.operation === "search" ? ["results", "candidates"] : ["traversal", "edges", "candidates"],
    });
    return finishCodeExplore({ ...params, page, limit }, output.sourceRoot ?? params.scope, paged);
  };
  params.reply.refit = limit => render(1, limit);
  params.reply.validate = async () => { await validateRankedCorpus(output, params.callNative, { signal: params.signal, timeoutMs: 25_000 }); };
  return render(params.page, params.limit);
}

async function finishCodeExplore(params: CodeExploreRequest, root: string, paged: unknown) {
  const visible = withoutSourceClaims(paged);
  const leads = typeof visible === "string"
    ? parseFileBackedLeadsFromText(visible, root, params.limit)
    : parseFileBackedLeadsFromJson(params.operation === "search" ? { results: (visible as any)?.results ?? [] } : visible, root, params.limit);
  const authorityLeads = selectAuthorityLeads(leads, 5);
  const identity = params.anchor;
  const title = `Code explore\nOperation: ${params.operation}\nIdentity: ${identity}`;
  const rendered = renderCodeExploreEvidence(title, visible, root);
  const expectedRawDigests = sourceDigests(paged);
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
  if (proof) params.reply.commits.push(proof.commit);
  const text = proof?.text ?? rendered;
  const nativeStatus = visible && typeof visible === "object" ? String((visible as any).status ?? "ok") : "ok";
  const diagnostics = reason ? [`source_proof=${reason}`] : [];
  const summary = exploreSummary(params.operation, visible);
  const envelope = envelopeForLeads(summary, leads, diagnostics);
  envelope.status = nativeStatus === "error" ? "error" : !proofFailure && (nativeStatus === "ok" || (params.operation === "search" && nativeStatus === "degraded")) ? "success" : "warning";
  if (proof?.artifacts.length) envelope.artifacts = [...new Set([...(envelope.artifacts ?? []), ...proof.artifacts])];
  const result = resultText(reason ? `${text}\n\nSource handoff: ${proof?.promoted ? "partial authority" : "locator-only"}; ${reason}.` : text, envelope);
  return withExplorePresentation(result, codeExplorePresentation(params.operation, identity, visible, proof?.artifacts ?? [], reason), visible);
}


function isCodeTestCandidate(row: any): boolean {
  return row?.is_test === true || String(row?.kind ?? "").toLowerCase() === "test";
}

function relevanceOrderTraversalEdges(value: any): void {
  if (!value || !Array.isArray(value.traversal) || !Array.isArray(value.edges)) return;
  const order = new Map<string, number>();
  const depth = new Map<string, number>();
  value.traversal.forEach((node: any, index: number) => {
    const identity = String(node?.qualified_name ?? node?.name ?? "");
    if (!identity) return;
    order.set(identity, index);
    depth.set(identity, Number.isFinite(Number(node?.depth)) ? Number(node.depth) : Number.MAX_SAFE_INTEGER);
  });
  const start = String(value.start_node ?? value.traversal[0]?.qualified_name ?? value.traversal[0]?.name ?? "");
  value.edges = value.edges.map((edge: any, index: number) => ({ edge, index })).sort((left: any, right: any) => {
    const rank = ({ edge, index }: any) => {
      const source = String(edge?.source ?? edge?.source_qualified ?? "");
      const target = String(edge?.target ?? edge?.target_qualified ?? "");
      const sourceOrder = order.get(source) ?? Number.MAX_SAFE_INTEGER;
      const targetOrder = order.get(target) ?? Number.MAX_SAFE_INTEGER;
      return [source === start || target === start ? 0 : 1, Math.max(depth.get(source) ?? Number.MAX_SAFE_INTEGER, depth.get(target) ?? Number.MAX_SAFE_INTEGER), Math.min(sourceOrder, targetOrder), Math.max(sourceOrder, targetOrder), index];
    };
    const a = rank(left); const b = rank(right);
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index];
    return 0;
  }).map((item: any) => item.edge);
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ToolCallValidationError(`${label} is required and must be non-empty.`, { received: value });
  return value.trim();
}

function rejectIncompatibleExploreFields(params: Record<string, unknown>, fields: string[], operation: string): void {
  const supplied = fields.filter(field => params[field] !== undefined);
  if (supplied.length) throw new ToolCallValidationError(`explore ${operation} does not accept ${supplied.join(", ")}.`, { received: Object.fromEntries(supplied.map(field => [field, params[field]])), guidance: [operation === "map" ? "Map accepts query, scope, page and limit." : "Use only fields owned by the selected code operation."] });
}

function validateCodeOperation(params: { operation: string; anchor?: unknown; kind?: unknown; depth?: unknown }, normalizations: string[]): { anchor: string; kind?: string; depth: number } {
  const anchor = typeof params.anchor === "string" && params.anchor.trim() ? params.anchor.trim() : undefined;
  const authoredKind = typeof params.kind === "string" && params.kind.trim() ? params.kind.trim() : undefined;
  if (params.operation === "search") {
    if (!anchor) throw new ToolCallValidationError("explore search requires behavior vocabulary, a signature fragment, or one exact observed identifier in anchor.", { guidance: ["Use one concise meaning-led phrase and include an exact identifier when known; the result reports the active search mode for any refinement."] });
    if (params.depth !== undefined) throw new ToolCallValidationError("explore search does not accept depth.", { received: params.depth, guidance: ["Remove depth; it applies only to traverse."] });
    let kind: string | undefined;
    if (authoredKind) kind = normalizedEnum(authoredKind, "explore search kind", [...SEARCH_KINDS], normalizations);
    return { anchor, kind, depth: 2 };
  }
  const depth = normalizedInteger(params.depth, "explore traverse depth", 2, 1, 6, normalizations);
  const exactSymbol = Boolean(anchor?.includes("::"));
  const exactFile = Boolean(anchor && (/[\\/]/.test(anchor) || ROOT_FILE_IDENTITY.test(anchor)));
  if (!anchor || (!exactSymbol && !exactFile)) throw new ToolCallValidationError("explore traverse requires an exact qualified symbol or exact File identity returned by prepared evidence; a bare symbol is ambiguous.", { received: params.anchor, guidance: ["Use code search first to qualify the identity, then copy qualified_name or file_path into traverse."] });
  if (params.kind !== undefined) throw new ToolCallValidationError("explore traverse does not accept kind.", { received: params.kind, guidance: ["Remove kind; the exact traverse identity already determines the start node."] });
  return { anchor, depth };
}


function sourceDigests(native: unknown): Record<string, string> {
  if (!native || typeof native !== "object" || !Array.isArray((native as any).source_claims)) return {};
  return Object.fromEntries((native as any).source_claims.filter((claim: any) => typeof claim?.path === "string" && /^[A-F0-9]{64}$/i.test(String(claim?.raw_digest ?? ""))).map((claim: any) => [claim.path, String(claim.raw_digest).toUpperCase()]));
}

function withoutSourceClaims(native: unknown): unknown {
  if (!native || typeof native !== "object" || Array.isArray(native)) return native;
  const { source_claims: _hidden, ...visible } = native as Record<string, unknown>;
  return visible;
}

// Extract concrete symbols/paths the agent already named and feed them back as
// explicit Graphify seeds. Public explore(map) should treat a known path as a
// clue, not silently discard it: pass path-derived seeds and expose compact seed
// diagnostics so weak/default graph output can be diagnosed instead of guessed.

function extractGraphifySymbolSeeds(query: string): string[] {
  const text = String(query ?? "");
  const seeds = new Set<string>();
  // Symbols: foo(), Bar::baz, bare camelCase/PascalCase-like identifiers,
  // and qualified names.
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\(\)|::[A-Za-z_$][\w$]*))(?=\s|$|[.,;:)])/g)) seeds.add(match[1]);
  // Bare code identifiers: normalizeDocParam, ReconciliationLease, APPEND_SYSTEM.
  // Avoid ordinary lowercase words so concept queries still get Graphify's native
  // text matching plus our broad intent hints instead of noisy fake seeds.
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const token = match[1];
    const before = text.slice(Math.max(0, match.index - 2), match.index);
    const after = text.slice(match.index + token.length, match.index + token.length + 8);
    if (before.includes("/") || /^\.(?:ts|tsx|js|jsx|mjs|cjs|py|md)\b/.test(after)) continue;
    if (/[a-z][A-Z]|[_$]/.test(token)) seeds.add(token);
  }
  // Qualified names: file.ext::function
  for (const match of text.matchAll(/([\w./-]+\.[A-Za-z0-9]{1,10}::[A-Za-z_$][\w$]*)/g)) seeds.add(match[1]);
  return [...seeds].slice(0, 12);
}

function extractGraphifyPathSeeds(query: string, root = "."): string[] {
  const text = String(query ?? "");
  const seeds = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)([^\s()"'`]+)(?=\s|$)/g)) {
    const token = match[1]!.replace(/[.,;]+$/, "");
    const path = token.replace(/[:#][^/]*$/, "").replace(/^\.\//, "").replace(/\\/g, "/");
    const knownProjectPath = existsSync(isAbsolute(path) ? path : join(root, path));
    if (!path.includes("/") || (!knownProjectPath && !/\.[A-Za-z0-9]{1,10}$/.test(path))) continue;
    seeds.add(path);
    const base = basename(path);
    if (base && base !== path) seeds.add(base);
  }
  return [...seeds].slice(0, 12);
}


interface GraphifyMapQueryShape {
  query: string;
  diagnostics: string[];
  anchoring: "explicit-seeded" | "native-text-only";
  pathAnchor?: string;
  exactTarget?: string;
}

function shapeGraphifyMapQuery(query: string, root = "."): GraphifyMapQueryShape {
  const text = String(query ?? "").trim();
  const symbolSeeds = extractGraphifySymbolSeeds(text);
  const pathSeeds = extractGraphifyPathSeeds(text, root);
  const anchoring = pathSeeds.length || symbolSeeds.length ? "explicit-seeded" as const : "native-text-only" as const;
  const diagnostics = [
    `query_anchoring=${anchoring}`,
    ...(symbolSeeds.length ? [`symbol_seeds=${symbolSeeds.join(",")}`] : []),
    ...(pathSeeds.length ? [`path_seeds=${pathSeeds.join(",")}`] : []),
  ];
  if (pathSeeds.length) {
    const primaryPath = pathSeeds.find(seed => seed.includes("/")) ?? pathSeeds[0]!;
    const qualified = text.match(/([\w./-]+\.[A-Za-z0-9]{1,10})::([A-Za-z_$][\w$]*)/);
    const exactTarget = qualified && qualified[1]!.replace(/^\.\//, "").replace(/\\/g, "/") === primaryPath ? qualified[2]! : primaryPath;
    diagnostics.push(`path_anchor=${primaryPath}`);
    return { query: primaryPath, diagnostics, anchoring, pathAnchor: primaryPath, exactTarget };
  }
  return { query: text, diagnostics, anchoring };
}

interface GraphifyExactAnchor {
  id: string;
  label: string;
  source: string;
}

function parseGraphifyExactAnchor(output: string, expectedPath: string): GraphifyExactAnchor | undefined {
  const label = String(output).match(/^Node:\s*(.+)$/m)?.[1]?.trim();
  const id = String(output).match(/^\s*ID:\s*(.+)$/m)?.[1]?.trim();
  const sourceWithLine = String(output).match(/^\s*Source:\s*(.+)$/m)?.[1]?.trim();
  const source = sourceWithLine?.replace(/\s+L\d+(?:[-:]\d+)?\s*$/, "").replace(/^\.\//, "").replace(/\\/g, "/");
  if (!label || !id || source !== expectedPath) return undefined;
  return { id, label, source };
}

async function resolveGraphifyExactAnchor(command: string, graphPath: string, shaped: GraphifyMapQueryShape, params: { scope: string; signal?: AbortSignal }): Promise<GraphifyExactAnchor | undefined> {
  if (!shaped.pathAnchor || !shaped.exactTarget) return undefined;
  const run = await runCommand(command, ["explain", shaped.exactTarget, "--graph", graphPath], { cwd: params.scope, signal: params.signal, timeoutMs: GRAPHIFY_MAP_TIMEOUT_MS, maxBytes: 64_000, env: graphifyQueryEnv(), telemetry: { tool: "explore", backend: "graphify", lane: "graph", mode: "map-anchor" } });
  if (!run.ok) return undefined;
  return parseGraphifyExactAnchor(run.stdout, shaped.pathAnchor);
}

function graphifyAnchorRetention(stdout: string, pathAnchor: string | undefined, exact?: GraphifyExactAnchor): "retained" | "rejected" | undefined {
  if (!pathAnchor) return undefined;
  const traversal = String(stdout).split("\n").find(line => /^Traversal:.*\bStart:\s*\[/.test(line));
  const starts = new Set([...(traversal?.match(/\bStart:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]!.trim()));
  for (const line of String(stdout).split("\n")) {
    const match = line.match(/^NODE\s+(.+?)\s+\[src=([^\s\]]+)/);
    if (!match) continue;
    const label = match[1]!.trim();
    const source = match[2]!.replace(/^\.\//, "").replace(/\\/g, "/");
    if (source === pathAnchor && starts.has(label) && (!exact || label === exact.label)) return "retained";
  }
  return "rejected";
}

function stripGraphifyMapQueryHints(output: string): string {
  return String(output ?? "")
    .replace(/\n\nGraphify query intent: [^\n]*(?=\n|$)/g, "")
    .replace(/\nGraphify seeds: [^\n]*(?=\n|$)/g, "");
}

interface GraphDirectionEdge {
  sourceLabel: string;
  targetLabel: string;
  relation: string;
  sourceFile?: string;
  sourceLine?: number;
}

async function loadGraphDirectionEdges(graphPath: string): Promise<GraphDirectionEdge[]> {
  const graph = JSON.parse(await readFile(graphPath, "utf8"));
  const labels = new Map<string, string>();
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (node?.id !== undefined && typeof node?.label === "string") labels.set(String(node.id), node.label);
  }
  return (Array.isArray(graph?.links) ? graph.links : []).flatMap((edge: any) => {
    const sourceLabel = labels.get(String(edge?.source));
    const targetLabel = labels.get(String(edge?.target));
    const relation = typeof edge?.relation === "string" ? edge.relation : undefined;
    if (!sourceLabel || !targetLabel || !relation) return [];
    const sourceLine = Number(String(edge?.source_location ?? "").match(/L?(\d+)/)?.[1]);
    return [{ sourceLabel, targetLabel, relation, sourceFile: edge?.source_file, ...(Number.isFinite(sourceLine) ? { sourceLine } : {}) }];
  });
}

function normalizeGraphMapDirections(stdout: string, storedEdges: GraphDirectionEdge[]): { text: string; corrected: number; unverified: number } {
  let corrected = 0;
  let unverified = 0;
  const text = String(stdout).split("\n").map(line => {
    const match = line.match(/^EDGE (.+?) --(\w+) \[(\w+)(?: context=(\w+))?\]--> (.+?)(?: at=(.+?))?\s*$/);
    if (!match) return line;
    const [, nativeSource, relation, confidence, context, nativeTarget, at] = match;
    let candidates = storedEdges.filter(edge => edge.relation === relation && (
      (edge.sourceLabel === nativeSource && edge.targetLabel === nativeTarget)
      || (edge.sourceLabel === nativeTarget && edge.targetLabel === nativeSource)
    ));
    const site = at?.match(/^(.*?):L?(\d+)$/);
    if (site && candidates.length > 1) {
      const siteMatches = candidates.filter(edge => edge.sourceFile === site[1] && edge.sourceLine === Number(site[2]));
      if (siteMatches.length) candidates = siteMatches;
    }
    const orientations = new Map(candidates.map(edge => [`${edge.sourceLabel}\0${edge.targetLabel}`, edge]));
    if (orientations.size !== 1) {
      unverified++;
      return line;
    }
    const edge = [...orientations.values()][0]!;
    if (edge.sourceLabel !== nativeSource || edge.targetLabel !== nativeTarget) corrected++;
    return `EDGE ${edge.sourceLabel} --${relation} [${confidence}${context ? ` context=${context}` : ""}]--> ${edge.targetLabel}${at ? ` at=${at}` : ""}`;
  }).join("\n");
  return { text, corrected, unverified };
}

async function exploreMap(params: { scope: string; cwd: string; query: string; limit: number; page: number; normalizations?: string[]; signal?: AbortSignal }) {
  const graph = await resolveRequiredLane(params.scope, "graph");
  const graphPath = graphPathForLane(graph);
  if (!graph.ok || backendArtifactMissing(graphPath)) return unavailableResult("graph map", graph);
  const command = commandForLane(graph);
  const shaped = shapeGraphifyMapQuery(params.query, params.scope);
  const exactAnchor = await resolveGraphifyExactAnchor(command, graphPath!, shaped, params);
  const nativeQuery = exactAnchor?.id ?? shaped.query;
  let root = scopeRootForLane(graph, params.scope);
  const run = await runCommand(command, ["query", nativeQuery, "--graph", graphPath!, "--budget", String(GRAPHIFY_MAP_BUDGET)], { cwd: params.scope, signal: params.signal, timeoutMs: GRAPHIFY_MAP_TIMEOUT_MS, maxBytes: 180_000, env: graphifyQueryEnv(), telemetry: { tool: "explore", backend: "graphify", lane: "graph", mode: "map" } });
  if (run.stdoutTruncated) return resultText("Graph map capture was truncated before complete records could be retained. Narrow the query; changing display page or limit cannot recover uncaptured records. No graph rows or source authority were delivered.",
    harnessEnvelope({ status: "warning", summary: "Graph map capture is incomplete.", next_actions: [], artifacts: [], diagnostics: ["stdout_truncated"] }));
  if (!run.ok) {
    return resultText([
      "WARNING: graph map failed; no fallback navigation was used.",
      `Reason: ${run.error ?? (run.stderr || `exit ${run.code}`)}`,
      "Query-time tools read existing graph artifacts only; they do not build or mutate state.",
    ].join("\n"), harnessEnvelope({ status: "warning", summary: "Graph map failed.", next_actions: ["Use navigation-debug for diagnosis."], artifacts: [], diagnostics: [sanitizeAgentText(run.stderr || run.error || `exit=${run.code}`)] }));
  }
  const nativeStdout = stripGraphifyMapQueryHints(run.stdout);
  let direction: { text: string; corrected: number; unverified: number };
  try {
    direction = normalizeGraphMapDirections(nativeStdout, await loadGraphDirectionEdges(graphPath!));
  } catch {
    direction = { text: nativeStdout, corrected: 0, unverified: (nativeStdout.match(/^EDGE /gm) ?? []).length };
  }
  const stdout = direction.text;
  const anchorRetention = graphifyAnchorRetention(stdout, shaped.pathAnchor, exactAnchor);
  const rawJson = parseJsonOrText(stdout);
  let hygiene = rawJson ? sanitizeGraphifyResult(rawJson, root) : undefined;
  const graphReadiness = {
    mode: (graph as any).graphMode,
    provider: (graph as any).graphProvider,
    model: (graph as any).graphModel,
    deep_extraction_observed: (graph as any).graphDeepExtractionObserved,
    semantic_extraction_observed: (graph as any).graphSemanticExtractionObserved,
    refresh_status: (graph as any).refreshStatus,
    source_freshness_status: (graph as any).sourceFreshnessStatus,
    generation_identity: (graph as any).generationId,
    source_snapshot_identity: (graph as any).sourceSnapshotIdentity,
    diagnostics: (graph as any).diagnostics,
  };
  let cleanJson = hygiene?.value;
  if (cleanJson && typeof cleanJson === "object" && !Array.isArray(cleanJson)) cleanJson = {
    ...(cleanJson as Record<string, unknown>),
    project_navigation: {
      ...(((cleanJson as any).project_navigation as Record<string, unknown> | undefined) ?? {}),
      graph_readiness: graphReadiness,
    },
  };
  const diagnostics = [...shaped.diagnostics, ...(exactAnchor ? [`exact_anchor_id=${exactAnchor.id}`] : []), ...(anchorRetention ? [`exact_anchor_status=${anchorRetention}`] : []), ...(direction.corrected ? [`graph_edge_direction_corrected=${direction.corrected}`] : []), ...(direction.unverified ? [`graph_edge_direction_unverified=${direction.unverified}`] : []), ...(hygiene?.diagnostics ?? []), `graph_mode=${graphReadiness.mode ?? "unknown"}`, `graph_deep_extraction=${graphReadiness.deep_extraction_observed ?? "unknown"}`, `graph_semantic_extraction=${graphReadiness.semantic_extraction_observed ?? "unknown"}`, `graph_refresh_status=${graphReadiness.refresh_status ?? "unknown"}`, `graph_source_freshness=${graphReadiness.source_freshness_status ?? "unknown"}`, ...((graph as any).diagnostics ?? [])];
  const marker = params.normalizations?.length ? `\n\nCall normalization: ${[...new Set(params.normalizations)].join("; ")}.` : "";
  // Enrichment is bounded and page-independent: derive once from the full map so
  // a budget refit reuses the same captured live records without re-running them.
  const [enrichments, edgeBlocks] = await Promise.all([enrichSeedNodes(stdout, root, params.signal), enrichEdgeBlocks(stdout, root, params.signal)]);
  // Legend choice is captured once: rejected budget previews must not consume the
  // gate and change what the retained composition shows.
  const showLegend = firstCallGate("explore-legend", "explore", 20);
  const compose = async (page: number, limit: number) => {
    const textPage = !cleanJson ? pageGraphMapText(stdout, page, limit) : undefined;
    const pageJson = cleanJson ? pagePreparedEvidence(cleanJson, {
      page, limit, request: { view: "map", query: params.query, limit },
      rootIdentity: root, generationIdentity: graphReadiness.generation_identity, collectionPaths: ["nodes", "edges"],
    }) : undefined;
    const visibleStdout = textPage?.text ?? stdout;
    const pageLeads = pageJson ? parseFileBackedLeadsFromJson(pageJson, root, limit) : parseFileBackedLeadsFromText(visibleStdout, root, limit);
    const pageWindows = textPage?.pageWindows ?? (((pageJson as any)?.project_navigation?.page_windows as MapPageWindow[] | undefined) ?? []);
    const nextPage = textPage?.nextPage ?? (pageJson as any)?.project_navigation?.continuation?.next_page;
    const native = pageJson ?? graphMapNativeWithDiagnostics(visibleStdout, diagnostics, Number.MAX_SAFE_INTEGER, pageWindows, nextPage, enrichments, edgeBlocks, showLegend);
    const rendered = renderNativeResult(`Graph map: ${JSON.stringify(params.query)}`, native, pageLeads, { maxNativeChars: Number.MAX_SAFE_INTEGER, contextLabel: "Graph context" });
    const authority = pageJson ? await prepareExploreRows(root, rendered, pageJson, params.signal) : undefined;
    const text = authority?.text ?? rendered;
    const baseSummary = pageLeads.length ? `Graph map: ${pageLeads.length} ${pageLeads.length === 1 ? "lead" : "leads"}` : "Graph map: no leads found";
    const startSummary = graphMapStartSummary(stdout);
    const summary = [baseSummary, shaped.anchoring, startSummary].filter(Boolean).join(" · ");
    const envelope = envelopeForLeads(summary, pageLeads, diagnostics);
    if (anchorRetention === "rejected") {
      envelope.status = "warning";
      envelope.summary = `${summary} · requested exact anchor was not retained`;
    }
    if (exactAnchor && direction.unverified) {
      envelope.status = "warning";
      envelope.summary = `${envelope.summary} · ${direction.unverified} edge direction(s) could not be verified against the stored graph`;
    }
    if (nextPage) envelope.next_actions = [`Continue with page:${nextPage}, retaining the same map query, scope, and limit.`];
    if (authority?.authorities.length) envelope.artifacts = [...new Set([...(envelope.artifacts ?? []), ...authority.authorities.map(item => `[${item.path}#${item.tag}]`)])];
    const result = withExplorePresentation(resultText(text, envelope), mapExplorePresentation(params.query, shaped.anchoring, visibleStdout, pageLeads, pageWindows, nextPage, enrichments, edgeBlocks, anchorRetention), native);
    return { result, text, commit: authority?.commit, leads: pageLeads };
  };
  let limit = params.limit;
  let composed = await compose(params.page, limit);
  if (!composed.leads.length && root !== params.scope) {
    root = params.scope;
    hygiene = rawJson ? sanitizeGraphifyResult(rawJson, root) : undefined;
    cleanJson = hygiene?.value;
    if (cleanJson && typeof cleanJson === "object" && !Array.isArray(cleanJson)) cleanJson = {
      ...(cleanJson as Record<string, unknown>),
      project_navigation: { ...(((cleanJson as any).project_navigation as Record<string, unknown> | undefined) ?? {}), graph_readiness: graphReadiness },
    };
    composed = await compose(params.page, limit);
  }
  // Do not tokenize a page already rejected by the character wall: long single
  // identifiers make BPE expensive. Every character-eligible final reply is counted.
  let tokens = (composed.text + marker).length > GRAPHIFY_MAP_NATIVE_CHARS ? undefined : referenceTokenCount(composed.text + marker);
  for (let attempts = 0; (tokens === undefined || tokens > 4_000) && limit > 1 && attempts < 8; attempts++) {
    const ratio = tokens === undefined ? GRAPHIFY_MAP_NATIVE_CHARS / (composed.text + marker).length : 3_600 / tokens;
    limit = Math.max(1, Math.min(limit - 1, Math.floor(limit * Math.min(0.6, ratio))));
    composed = await compose(1, limit);
    tokens = (composed.text + marker).length > GRAPHIFY_MAP_NATIVE_CHARS ? undefined : referenceTokenCount(composed.text + marker);
  }
  if (limit !== params.limit) {
    const notice = `Reply budget: requested page ${params.page}, limit ${params.limit}; restarted at page 1, limit ${limit}. Continue from this new page size, not the previous sequence; no generation is pinned.`;
    composed.result.content[0].text = `${notice}\n\n${composed.result.content[0].text}`;
    composed.result.details.status = "partial";
    composed.result.details.envelope = { ...composed.result.details.envelope, status: "warning", diagnostics: [...(composed.result.details.envelope?.diagnostics ?? []), notice] };
    composed.result.details.budgetRestart = { requestedPage: params.page, requestedLimit: params.limit, page: 1, limit };
  }
  params.signal?.throwIfAborted();
  if ((composed.result.content[0].text + marker).length > GRAPHIFY_MAP_NATIVE_CHARS || referenceTokenCount(composed.result.content[0].text + marker) > 4_000) {
    return resultText("Graph map reply withheld: complete identities and evidence cannot fit within both the 4,000-token ceiling and the bounded character allowance. Narrow the query; no graph rows or source authority were delivered.",
      harnessEnvelope({ status: "warning", summary: "Graph map exceeds its reply budget.", next_actions: [], artifacts: [], diagnostics: ["reply_budget"] }));
  }
  composed.commit?.();
  return composed.result;
}

function withExplorePresentation(result: any, presentation: Record<string, unknown>, native?: unknown) {
  result.details ??= {};
  result.details.presentation = presentation;
  if (native !== undefined) result.details.native = native;
  return result;
}

function codeNode(row: any) {
  return {
    name: row?.qualified_name ?? row?.name ?? row?.label ?? "result",
    kind: row?.kind,
    path: row?.file_path ?? row?.file ?? row?.path ?? row?.location?.path,
    start: row?.line_start ?? row?.start ?? row?.location?.start,
    end: row?.line_end ?? row?.end ?? row?.location?.end,
    score: row?.score ?? row?._score,
    signature: row?.signature,
    depth: row?.depth,
    provenance: row?.provenance,
  };
}

function codeEdge(row: any) {
  return {
    kind: row?.kind ?? row?.type ?? "EDGE",
    source: row?.source ?? row?.source_qualified,
    target: row?.target ?? row?.target_qualified,
    path: row?.file_path ?? row?.path,
    line: row?.line,
    column: row?.column,
    functionReference: row?.functionReference === true,
    confidence: row?.confidence,
    provenance: row?.confidence_tier ?? row?.provenance,
  };
}

function codeExplorePresentation(operation: string, identity: string, visible: unknown, authority: string[] = [], sourceReason?: string) {
  const value = visible && typeof visible === "object" && !Array.isArray(visible) ? visible as any : {};
  const project = value.project_navigation ?? {};
  const windows = Array.isArray(project.page_windows) ? project.page_windows : [];
  const candidates = Array.isArray(value.results) ? value.results.map(codeNode) : [];
  const traversal = Array.isArray(value.traversal) ? value.traversal.map(codeNode) : [];
  const edges = Array.isArray(value.edges) ? value.edges.map(codeEdge) : [];
  return {
    kind: "explore",
    view: "code",
    operation,
    identity,
    status: value.status,
    summary: value.summary,
    searchMode: value.search_mode,
    semanticStatus: value.semantic_status,
    semanticApplicable: value.semantic_applicable,
    semanticReadiness: value.semantic_readiness ? {
      ready: value.semantic_readiness.ready,
      reason: value.semantic_readiness.reason,
      currentNodes: value.semantic_readiness.current_non_file_nodes,
      vectorCount: value.semantic_readiness.current_vector_count,
      staleDeleted: value.semantic_readiness.stale_deleted_vector_count,
      incompatible: value.semantic_readiness.incompatible_vector_count,
      provider: value.semantic_readiness.provider,
      model: value.semantic_readiness.model,
      privacy: value.semantic_readiness.privacy,
      dimension: value.semantic_readiness.dimension,
      graphUpdated: value.semantic_readiness.graph_last_updated,
      embeddingsUpdated: value.semantic_readiness.embedding_graph_last_updated,
    } : undefined,
    candidates,
    traversal: { startNode: value.start_node, mode: value.mode, maxDepth: value.max_depth, nodesVisited: value.nodes_visited, truncated: value.truncated === true, nodes: traversal, edges },
    ambiguityCandidates: Array.isArray(value.candidates) ? value.candidates.map(codeNode) : [],
    generation: project.generation_identity ?? project.graph_generation_identity,
    requestIdentity: project.request_identity,
    backendFetch: project.backend_fetch,
    nextPage: project.continuation?.next_page,
    pageWindows: windows,
    diagnostics: Array.isArray(project.diagnostics) ? project.diagnostics : [],
    authority,
    sourceReason,
  };
}

function exploreSummary(operation: string, visible: unknown): string {
  const value = visible && typeof visible === "object" && !Array.isArray(visible) ? visible as any : {};
  if (operation === "search") return `${Array.isArray(value.results) ? value.results.length : 0} ranked code candidate(s)`;
  const nodes = Array.isArray(value.traversal) ? value.traversal.length : 0;
  const edges = Array.isArray(value.edges) ? value.edges.length : 0;
  return `${nodes} traversal node(s) and ${edges} edge(s)`;
}

// Strip a repo-root prefix so candidates show `src/tools/explore.ts` instead of the
// full absolute path twice (the single biggest byte waste in the old output).
function relativePath(p: string, root: string): string {
  const path = String(p ?? "");
  const rootPath = String(root ?? "").replace(/[\\/]+$/, "");
  if (rootPath && path.startsWith(`${rootPath}/`)) return path.slice(rootPath.length + 1);
  return path;
}
// CRG renders every signature Python-style (`def name((params))` with a doubled param
// wrap). Drop the `def ` prefix and unwrap one layer of doubled parens so a TypeScript
// signature reads `name(params)`. Conservative: only unwraps when the whole arg list is
// wrapped, so genuine signatures are untouched.
function cleanSignature(signature: string): string {
  let s = String(signature ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/^def\s+/, "");
  const open = s.indexOf("(");
  if (open >= 0 && s.startsWith("(", open + 1) && s.endsWith("))")) {
    s = s.slice(0, open + 1) + s.slice(open + 2, -2) + ")";
  }
  return s;
}
function renderCodeExploreEvidence(title: string, visible: unknown, root: string): string {
  if (!visible || typeof visible !== "object" || Array.isArray(visible)) return `${title}\n\n${String(visible ?? "No native evidence.")}`;
  const value = visible as any;
  const project = value.project_navigation ?? {};
  const displayStatus = value.status === "degraded" && Array.isArray(value.results) ? "completed" : value.status ?? "unknown";
  const lines = [title, "", `Status: ${displayStatus}${value.summary ? ` · ${value.summary}` : ""}`];
  if (Array.isArray(value.results)) {
    lines.push("Legend: relevance-ranked candidates (best first; the numeric rank is omitted — order is the signal). Format: `N. Kind name · path:start-end` then its live signature. Helpers remain visible because they can locate the subsystem without proving ownership. Mixed result sets exclude tests so implementation candidates lead; pass kind:\"Test\" to include them. Test-only result sets remain visible as subsystem evidence. Locations are locators; only explicit hash-certified rows below authorize editing.");
    if (value.semantic_status === "not_applicable") {
      lines.push(`Search mode: ${value.search_mode ?? "keyword"} · lexical File identity evidence active`);
    } else {
      const semanticActive = ["ready", "available", "partial"].includes(value.semantic_status);
      lines.push(`Search mode: ${value.search_mode ?? "unknown"} · ${semanticActive ? "semantic + lexical code evidence active" : "lexical code evidence active"}`);
    }
    const readinessReason = value.semantic_readiness?.reason;
    if (readinessReason && displayStatus === "unavailable") lines.push(`Semantic readiness: ${readinessReason}`);
    if (value.results.length) lines.push("Candidates:");
    for (const [index, row] of value.results.entries()) {
      const node = codeNode(row);
      const range = node.path ? `${relativePath(node.path, root)}${node.start ? `:${node.start}${node.end && node.end !== node.start ? `-${node.end}` : ""}` : ""}` : "unknown location";
      lines.push(`${index + 1}. ${node.kind ?? "Node"} ${node.name} · ${range}`);
      if (node.signature) lines.push(`   ${cleanSignature(String(node.signature)).slice(0, 320)}`);
    }
    if (project.excluded_tests) lines.push(`Tests: ${project.excluded_tests} test candidate(s) excluded from the default retrieve — ${project.test_filter ?? `pass kind:"Test" to include them`}.`);
    if (project.test_only_results_retained) lines.push("Tests: retained because no non-test implementation candidate was returned; refine with returned vocabulary before treating a test as the owner.");
  } else {
    lines.push(`Traversal: start=${value.start_node ?? "unresolved"} · mode=${value.mode ?? "bfs"} · depth=${value.max_depth ?? "unknown"} · native_truncated=${value.truncated === true}`);
    if (Array.isArray(value.traversal) && value.traversal.length) lines.push("Nodes:");
    for (const row of value.traversal ?? []) {
      const node = codeNode(row);
      const range = node.path ? `${relativePath(node.path, root)}${node.start ? `:${node.start}${node.end && node.end !== node.start ? `-${node.end}` : ""}` : ""}` : "unknown location";
      lines.push(`NODE depth=${node.depth ?? "?"} · ${node.kind ?? "Node"} ${node.name} · ${range}`);
    }
    if (Array.isArray(value.edges) && value.edges.length) lines.push("Edges:");
    for (const row of value.edges ?? []) {
      const edge = codeEdge(row);
      const site = edge.path ? `${relativePath(edge.path, root)}${edge.line ? `:${edge.line}` : ""}${Number.isSafeInteger(edge.column) ? ` col0=${edge.column}` : ""}` : "unknown site";
      const quality = [edge.provenance, edge.confidence !== undefined ? `confidence=${edge.confidence}` : "", edge.functionReference ? "function value, not invocation" : ""].filter(Boolean).join(" · ");
      lines.push(`EDGE ${edge.source ?? "?"} --${edge.kind}${quality ? ` [${quality}]` : ""}--> ${edge.target ?? "?"} · ${site}`);
    }
  }
  if (Array.isArray(value.candidates) && value.candidates.length) {
    lines.push("Ambiguity candidates:");
    for (const row of value.candidates) lines.push(`- ${row.qualified_name ?? row.name ?? "candidate"} · ${row.kind ?? "Node"} · ${relativePath(row.file_path ?? "unknown path", root)}`);
  }
  const primaryPath = Array.isArray(value.results) ? "results" : "traversal";
  const window = Array.isArray(project.page_windows) ? project.page_windows.find((item: any) => item?.path === primaryPath) : undefined;
  const fetch = project.backend_fetch ?? {};
  const pageBits = [
    `page=${window?.page ?? 1}`,
    `returned=${window?.returned_count ?? 0}`,
    `native_fetched=${fetch.fetched_count ?? window?.total_count ?? 0}${fetch.lower_bound ? "+ lower-bound" : ""}`,
    fetch.visible_count !== undefined ? `visible_fetched=${fetch.visible_count}` : "",
    project.continuation?.next_page ? `next_page=${project.continuation.next_page}` : "",
    project.generation_identity ? `generation=${project.generation_identity}` : "",
    fetch.native_truncated ? "native_truncated=true" : "",
  ].filter(Boolean);
  if (project.continuation?.next_page) lines.push(`Showing ${window?.returned_count ?? 0} of ${window?.total_count ?? fetch.visible_count ?? 0} visible candidates — page for more.`);
  if (pageBits.length) lines.push(`Page: ${pageBits.join(" · ")}`);
  if (project.continuation?.next_page) lines.push("Continuation: keep operation/identity/limit unchanged; restart at page 1 if generation differs.");
  const material = Array.isArray(project.diagnostics) ? project.diagnostics.filter((item: unknown) => !/^Withheld \d+ private native proof\/hash field/i.test(String(item))) : [];
  if (material.length) lines.push(`Diagnostics: ${material.join("; ")}`);
  return lines.join("\n");
}


interface MapPageWindow {
  path: "nodes" | "edges";
  page: number;
  page_size: number;
  total_count: number;
  returned_count: number;
  omitted_before: number;
  omitted_after: number;
  omitted_count: number;
  total_pages: number;
  next_page?: number;
  complete: boolean;
  reason?: "page_window";
}

function pageGraphMapText(stdout: string, page: number, limit: number): { text: string; pageWindows: MapPageWindow[]; nextPage?: number } {
  const lines = String(stdout ?? "").split("\n");
  const collections = [
    { path: "nodes" as const, indexes: lines.map((line, index) => line.startsWith("NODE ") ? index : -1).filter(index => index >= 0) },
    { path: "edges" as const, indexes: lines.map((line, index) => line.startsWith("EDGE ") ? index : -1).filter(index => index >= 0) },
  ];
  const keep = new Set<number>();
  const pageWindows = collections.map(({ path, indexes }) => {
    const total = indexes.length;
    const start = Math.min(total, (page - 1) * limit);
    const end = Math.min(total, start + limit);
    for (const index of indexes.slice(start, end)) keep.add(index);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      path,
      page,
      page_size: limit,
      total_count: total,
      returned_count: end - start,
      omitted_before: start,
      omitted_after: total - end,
      omitted_count: total - (end - start),
      total_pages: totalPages,
      ...(end < total ? { next_page: page + 1 } : {}),
      complete: start === 0 && end === total,
      ...((start > 0 || end < total) ? { reason: "page_window" as const } : {}),
    } satisfies MapPageWindow;
  });
  const rowIndexes = new Set(collections.flatMap(item => item.indexes));
  const text = lines.filter((_line, index) => !rowIndexes.has(index) || keep.has(index)).join("\n");
  const continuations = pageWindows.flatMap(window => window.next_page ? [window.next_page] : []);
  return { text, pageWindows, ...(continuations.length ? { nextPage: Math.min(...continuations) } : {}) };
}

function mapExplorePresentation(query: string, anchoring: string | undefined, stdout: string, leads: Array<{ path: string; start?: number; end?: number; label?: string }>, pageWindows: MapPageWindow[] = [], nextPage?: number, enrichments?: Map<string, SeedEnrichment>, edgeBlocks?: Map<string, EdgeBlock>, anchorRetention?: "retained" | "rejected") {
  const lines = String(stdout ?? "").split("\n");
  const traversal = lines.find(line => /^Traversal:.*\bStart:\s*\[/.test(line));
  const rawStarts = traversal?.match(/\bStart:\s*\[([^\]]*)\]/)?.[1] ?? "";
  const starts = [...rawStarts.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]!.trim()).filter(Boolean);
  // Display the same compact, enriched rows the agent text uses (★seeds with live
  // signature+range, `REL→` edges with call-site blocks) instead of Graphify's raw
  // `[src=… loc=L… community=…]` / `--rel [EXTRACTED]-->` noise. Seeds = the Start line.
  const seeds = new Set(starts);
  const compact = (prefix: string) => lines.filter(line => line.startsWith(prefix)).map(line => compactGraphLine(line, seeds, enrichments, edgeBlocks));
  return {
    kind: "explore",
    view: "map",
    query,
    anchoring,
    starts,
    anchorRetention,
    traversal,
    nodes: compact("NODE "),
    edges: compact("EDGE "),
    leads: leads.map(lead => ({ path: lead.path, start: lead.start, end: lead.end, label: lead.label })),
    pageWindows,
    nextPage,
  };
}


async function prepareExploreRows(root: string, nativeText: string, native: unknown, signal?: AbortSignal) {
  const evidence = nativeSourceEvidence(native as any, { capability: "explore", backend: "graphify", route: "explore-map" });
  if (!evidence.length) return undefined;
  if (/\.\.\.\[presentation truncated\b/.test(nativeText)) {
    return { text: `${nativeText}\n\nSource handoff: locator-only; presentation truncation prevents complete displayed-row certification.`, certified: false, authorities: [], rejectedRows: evidence.reduce((count, item) => count + item.rows.length, 0), commit: () => {} };
  }
  const displayed = evidence.map(item => ({
    ...item,
    rows: item.rows.filter(row => nativeText.includes(row.text) && nativeText.includes(String(row.line))),
  })).filter(item => item.rows.length);
  if (!displayed.length) return undefined;
  // Deferred: the caller commits authority only for the composed reply that is
  // actually accepted, so a rejected budget preview grants nothing.
  const prepared = await prepareSourceAuthority({ cwd: root, nativeText, evidence: displayed, signal });
  return { text: prepared.text, certified: prepared.certified, authorities: prepared.authorities, rejectedRows: prepared.rejectedRows, commit: prepared.commit };
}
// Lossless edge compaction: relation names use 1:1 readable abbreviations that never
// collapse two distinct relations (imports_from→imp_from stays distinct from imports,
// indirect_call→ind_call from calls, inherits/implements/extends stay separate). Long
// names abbreviate to their distinguishing part; short names are unchanged; context is
// kept verbatim (e.g. →ref:parameter_type). Compaction strips only structural noise (the
// EDGE prefix, [ ] brackets, the default [EXTRACTED] tag, the --relation--> syntax).
// 1:1 relation abbreviations: each long relation maps to a UNIQUE readable token (keeping
// its distinguishing part) so nothing collapses — imports_from→imp_from stays distinct
// from imports, indirect_call→ind_call from calls, inherits/implements/extends stay
// separate. Short names are unchanged. Lossless + compact; all defined in the legend.
const GRAPH_MAP_REL_ABBREV: Record<string, string> = {
  imports_from: "imp_from", indirect_call: "ind_call", references: "ref", rationale_for: "rationale",
};
// What each edge means, in plain terms, so a fresh agent can interpret the map without
// re-deriving it. Kept concise; the system prompt carries a short reading guide too.
const GRAPH_MAP_LEGEND = [
  "Legend: ★=query seed (most relevant). ★seed line: `★<signature> . <file>:<defLine>:[<bodyStart>-<bodyEnd>] — \"<doc>\"` = current contract + current range (read that span for the whole symbol) + one-line intent; ✗ before it = no current definition at this locator; ⚠N = N same-named matches (verify which). Node: `<label> <file>:<line> cN`. Edge: `source REL→ target @<file>:<line>:[<blockStart>-<blockEnd>]` (label before arrow, reads as a sentence) — REL: contains (file/type holds symbol) | calls | ref:ctx (references; ctx=parameter_type/return_type/generic_arg/field/…) | imports | imp_from=imports_from | ind_call=indirect_call | method | inherits | implements | extends | rationale=rationale_for | uses | re_exports · ⚑ before REL = INFERRED/AMBIGUOUS (EXTRACTED unmarked) · @file:line:[block]=call-site + its enclosing block (a direct read target) · cN=community.",
  "Read in relevance order: ★seeds first, then neighbors by proximity + centrality — read top-down and stop once answered.",
];

// Live seed enrichment: for each query seed (the relevance-ordered top of the map),
// resolve its CURRENT definition via pi-nav's tree-sitter outline so the agent sees
// signature + live range + staleness without a read. Bounded to seeds, degrades
// gracefully — any failure (addon down, unsupported file) leaves the seed's normal
// compact line untouched, so this can never degrade below the un-enriched output.
type SeedEnrichment = {
  status: "found" | "stale" | "ambiguous" | "unverified";
  signature?: string;
  doc?: string;
  defLine?: number;
  bodyStart?: number;
  bodyEnd?: number;
  candidates?: number;
};

type EdgeBlock = { bodyStart: number; bodyEnd: number };

async function enrichSeedNodes(stdout: string, root: string, signal?: AbortSignal): Promise<Map<string, SeedEnrichment>> {
  const enrichments = new Map<string, SeedEnrichment>();
  try {
    const lines = String(stdout ?? "").split("\n");
    const seeds = new Set<string>();
    const traversal = lines.find(line => /^Traversal:.*\bStart:\s*\[/.test(line));
    const rawStarts = traversal?.match(/\bStart:\s*\[([^\]]*)\]/)?.[1] ?? "";
    for (const match of rawStarts.matchAll(/['"]([^'"]+)['"]/g)) seeds.add(match[1]!.trim());
    if (!seeds.size) return enrichments;
    type SeedNode = { label: string; src: string; line: number };
    const seedNodes: SeedNode[] = [];
    for (const line of lines) {
      const node = line.match(/^NODE (.+?) \[src=(.*?) loc=L?(\d+)(?: community=(.+?))?\]\s*$/);
      if (!node) continue;
      const label = node[1]!.trim();
      if (seeds.has(label)) seedNodes.push({ label, src: node[2]!.trim(), line: Number(node[3]) });
    }
    await Promise.all(seedNodes.slice(0, 12).map(async ({ label, src, line }) => {
      try {
        if (looksLikeFileSeed(label)) return;
        const name = bareSymbolName(label);
        if (!name) return;
        const out = await callPiNav({ root, operation: "pi_nav_symbol_range", args: { path: src, name, line }, signal });
        const data = (out.structured?.data ?? {}) as Record<string, unknown>;
        const found = data.found === true;
        const status: SeedEnrichment["status"] = !found
          ? (data.verified === false ? "unverified" : "stale")
          : (data.ambiguous === true ? "ambiguous" : "found");
        enrichments.set(label, {
          status,
          signature: typeof data.signature === "string" ? data.signature : undefined,
          doc: typeof data.doc === "string" ? data.doc : undefined,
          defLine: typeof data.defLine === "number" ? data.defLine : undefined,
          bodyStart: typeof data.bodyStart === "number" ? data.bodyStart : undefined,
          bodyEnd: typeof data.bodyEnd === "number" ? data.bodyEnd : undefined,
          candidates: typeof data.candidates === "number" ? data.candidates : undefined,
        });
      } catch {
        // Per-seed failures leave that seed un-enriched (graceful degradation).
      }
    }));
  } catch {
    // Whole-pass failure → empty map → compact output unchanged (the floor).
  }
  return enrichments;
}

// Strip a trailing parameter list so a node label like `grepRoot()` maps to the
// bare symbol name `grepRoot` that pi-nav matches against the outline.
function bareSymbolName(label: string): string {
  const index = label.indexOf("(");
  return (index >= 0 ? label.slice(0, index) : label).trim();
}

function looksLikeFileSeed(label: string): boolean {
  return /(?:^|\/)[^/]+\.[A-Za-z0-9]{1,10}$/.test(label.trim());
}

// Render an enriched seed line: the live signature (the contract — name, params,
// return type) leads, then location + live body range, then the one-line doc. The
// signature is surfaced as-is from the outline (language-agnostic, no fragile
// parsing); unverified seeds fall back to the normal compact line so we never
// mislabel a symbol in a file pi-nav cannot outline.
function renderEnrichedSeed(label: string, src: string, locLine: string, community: string | undefined, enrichment: SeedEnrichment): string {
  const communityTag = community ? ` c${community}` : "";
  if (enrichment.status === "unverified") return `★${label} ${src}:${locLine}${communityTag}`;
  if (enrichment.status === "stale") return `★✗ ${label} ${src}:${locLine} (no current definition at this locator)${communityTag}`;
  const head = enrichment.signature || label;
  const defLine = enrichment.defLine ?? Number(locLine);
  const body = enrichment.bodyStart !== undefined && enrichment.bodyEnd !== undefined ? `:[${enrichment.bodyStart}-${enrichment.bodyEnd}]` : "";
  const ambiguous = enrichment.status === "ambiguous" ? ` ⚠${enrichment.candidates ?? 2} matches` : "";
  const doc = enrichment.doc ? ` — ${enrichment.doc}` : "";
  return `★${head} . ${src}:${defLine}${body}${ambiguous}${doc}${communityTag}`;
}

// Resolve each edge call-site (`at=file:L<line>`) to its enclosing definition's
// body range, via pi-nav's line-only symbol_range mode (enclosing_definition_at,
// cached parse). Lets an agent read the calling block directly — `read file:l:[s-e]`
// — instead of re-grepping the call-site line. Keyed by the raw `at=` value so
// compactGraphMapText can look it up. Degrades gracefully: a call-site that can't
// be resolved (top-level, non-code file, pi-nav down) keeps its bare @file:line.
async function enrichEdgeBlocks(stdout: string, root: string, signal?: AbortSignal): Promise<Map<string, EdgeBlock>> {
  const blocks = new Map<string, EdgeBlock>();
  try {
    const lines = String(stdout ?? "").split("\n");
    const callSites = new Map<string, { file: string; line: number }>();
    for (const line of lines) {
      const m = line.match(/ at=(\S+)\s*$/);
      if (!m) continue;
      const at = m[1]!.trim();
      if (callSites.has(at)) continue;
      const lm = at.match(/^(.*?):L?(\d+)$/);
      if (!lm) continue;
      callSites.set(at, { file: lm[1]!.trim(), line: Number(lm[2]) });
    }
    await Promise.all([...callSites.entries()].slice(0, 40).map(async ([at, { file, line }]) => {
      try {
        const out = await callPiNav({ root, operation: "pi_nav_symbol_range", args: { path: file, line }, signal });
        const data = (out.structured?.data ?? {}) as Record<string, unknown>;
        if (data.found === true && typeof data.bodyStart === "number" && typeof data.bodyEnd === "number") {
          blocks.set(at, { bodyStart: data.bodyStart, bodyEnd: data.bodyEnd });
        }
      } catch {
        // Per-edge failures leave that call-site bare (graceful degradation).
      }
    }));
  } catch {
    // Whole-pass failure → empty map → edges keep bare @file:line (the floor).
  }
  return blocks;
}

// Compact Graphify's verbose NODE/EDGE text WITHOUT reordering: the seed-first /
// hop-distance / degree relevance order is the precision signal that lets an agent read
// top-down and stop early, so it is preserved exactly. Measured ~28% net smaller after
// enhancement (compaction alone ~30%; seed enrichment grows seed lines with the live
// signature/range/doc and edge block-ranges add ~9 chars each, clawing some back). Seeds
// (from the Start line) get ★; community becomes an inline cN tag; edges keep their at=
// call-site + enclosing block (a direct read target).
// Extract the query-seed labels from Graphify's `Traversal: … Start: […]` line. Shared
// by the text compactor and the TUI presentation so both mark the same ★ seeds.
function graphMapSeeds(stdout: string): Set<string> {
  const seeds = new Set<string>();
  const traversal = String(stdout ?? "").split("\n").find(line => /^Traversal:.*\bStart:\s*\[/.test(line));
  const rawStarts = traversal?.match(/\bStart:\s*\[([^\]]*)\]/)?.[1] ?? "";
  for (const match of rawStarts.matchAll(/['"]([^'"]+)['"]/g)) seeds.add(match[1]!.trim());
  return seeds;
}

// Compact ONE Graphify NODE/EDGE line losslessly (format guarantees documented on
// compactGraphMapText below). Extracted so the agent-text path and the TUI presentation
// share one transform — the UI shows exactly what the agent reads. Unrecognized lines
// (e.g. `NODE Graphify [src=None loc=None …]` with no parseable location) pass through
// verbatim: the lossless floor.
function compactGraphLine(line: string, seeds: Set<string>, enrichments?: Map<string, SeedEnrichment>, edgeBlocks?: Map<string, EdgeBlock>): string {
  const node = line.match(/^NODE (.+?) \[src=(.*?) loc=L?(\d+)(?: community=(.+?))?\]\s*$/);
  if (node) {
    const [, label, src, locLine, community] = node;
    const key = label!.trim();
    const enrichment = enrichments?.get(key);
    if (enrichment) return renderEnrichedSeed(key, src!, locLine!, community, enrichment);
    const star = seeds.has(key) ? "★" : "";
    const communityTag = community ? ` c${community}` : "";
    return `${star}${label} ${src}:${locLine}${communityTag}`;
  }
  const edge = line.match(/^EDGE (.+?) --(\w+) \[(\w+)(?: context=(\w+))?\]--> (.+?)(?: at=(.+?))?\s*$/);
  if (edge) {
    const [, src, relation, confidence, context, target, at] = edge;
    const flag = confidence && confidence !== "EXTRACTED" ? "⚑" : "";
    const relName = GRAPH_MAP_REL_ABBREV[relation!] ?? relation!;
    const relPart = context ? `${relName}:${context}` : relName;
    let atPart = "";
    if (at) {
      const cleanAt = at.replace(/:L(\d+)$/, ":$1");
      const block = edgeBlocks?.get(at);
      atPart = block ? ` @${cleanAt}:[${block.bodyStart}-${block.bodyEnd}]` : ` @${cleanAt}`;
    }
    // Label-before-arrow: reads as a sentence ("A calls→ B"), the most intuitive
    // form for a fresh agent (SVO order) and matches Graphify's native --calls-->.
    return `${src} ${flag}${relPart}→ ${target}${atPart}`;
  }
  return line;
}

function compactGraphMapText(stdout: string, enrichments?: Map<string, SeedEnrichment>, edgeBlocks?: Map<string, EdgeBlock>): string {
  const seeds = graphMapSeeds(stdout);
  return String(stdout ?? "").split("\n").map(line => compactGraphLine(line, seeds, enrichments, edgeBlocks)).join("\n");
}

function graphMapNativeWithDiagnostics(stdout: string, diagnostics: string[], maxNativeChars: number, pageWindows: MapPageWindow[] = [], nextPage?: number, enrichments?: Map<string, SeedEnrichment>, edgeBlocks?: Map<string, EdgeBlock>, showLegend = true): string {
  const body = trimGraphMapNative(compactGraphMapText(String(stdout ?? "").trim(), enrichments, edgeBlocks), maxNativeChars);
  const sections: string[] = showLegend ? [...GRAPH_MAP_LEGEND] : [];
  if (diagnostics.length) sections.push(`Seed diagnostics: ${diagnostics.join("; ")}`);
  if (pageWindows.length) {
    const nodes = pageWindows.find(window => window.path === "nodes");
    const edges = pageWindows.find(window => window.path === "edges");
    sections.push(`Page: page=${nodes?.page ?? edges?.page ?? 1} · nodes=${nodes?.returned_count ?? 0}/${nodes?.total_count ?? 0} · edges=${edges?.returned_count ?? 0}/${edges?.total_count ?? 0}${nextPage ? ` · next_page=${nextPage}` : ""}`);
  }
  sections.push(body);
  return sections.filter(Boolean).join("\n");
}

function graphMapStartSummary(stdout: string): string | undefined {
  const traversal = String(stdout ?? "").split("\n").find(line => /^Traversal:.*\bStart:\s*\[/.test(line));
  const raw = traversal?.match(/\bStart:\s*\[([^\]]*)\]/)?.[1];
  if (!raw) return undefined;
  const labels = [...raw.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]!.trim()).filter(Boolean);
  if (!labels.length) return undefined;
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const compact = [...counts].slice(0, 3).map(([label, count]) => count > 1 ? `${label} ×${count}` : label);
  return `starts ${compact.join(", ")}`;
}

function trimGraphMapNative(body: string, maxNativeChars: number): string {
  if (body.length <= maxNativeChars) return body;
  const marker = `\n...[truncated middle ${body.length - maxNativeChars} chars; preserved native head and tail]\n`;
  const budget = Math.max(0, maxNativeChars - marker.length);
  const headChars = Math.ceil(budget * 0.65);
  const tailChars = budget - headChars;
  return `${body.slice(0, headChars)}${marker}${body.slice(Math.max(0, body.length - tailChars))}`;
}


function normalizePage(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || !Number.isInteger(value)) throw new Error(`page must be a positive integer; got ${JSON.stringify(value)}.`);
  return value;
}


function normalizeLimit(value: unknown, fallback: number, cap: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`limit must be a positive number; got ${JSON.stringify(value)}.`);
  return Math.max(1, Math.min(cap, Math.floor(value)));
}
