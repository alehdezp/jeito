import { existsSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { harnessEnvelope, stripPrivateEvidence, type HarnessEnvelope } from "./harness-result.ts";
import { resolvePreparedLane, type NavigationLane, type PreparedLaneResolution } from "./navigation-config.ts";
import { encodeGenericGCFormat } from "./gcformat.ts";
import { recordPerfEvent } from "./perf-telemetry.ts";
import { runSupervisedCommand } from "./process-supervisor.ts";
import { ToolCallValidationError } from "./tool-call-contract.ts";
import type { NativeOutput } from "./pi-nav-native.ts";

/** One shape adapter for Explore, Trace and Diff. IDs remain graph identities;
 * returned qualified names remain usable file-and-symbol query addresses. */
export function indexedGraphEvidence(output: NativeOutput): any {
  const data = output.structured.data as any;
  const admitted = output.corpusAdmission?.files;
  const node = (row: any) => {
    if (!row || ![row.id, row.kind, row.name, row.qualifiedName, row.filePath].every(value => typeof value === "string")
      || !admitted?.includes(row.filePath) || !Number.isSafeInteger(row.startLine) || row.startLine < 1
      || !Number.isSafeInteger(row.endLine) || row.endLine < row.startLine) {
      throw new Error("Indexed projection contains an invalid or non-admitted node");
    }
    const qualified = row.kind === "file" ? row.filePath : row.qualifiedName.startsWith(`${row.filePath}::`) ? row.qualifiedName : `${row.filePath}::${row.qualifiedName}`;
    return { id: row.id, kind: row.kind, name: row.name, qualified_name: qualified, file_path: row.filePath,
      line_start: row.startLine, line_end: row.endColumn === 0 && row.endLine > row.startLine ? row.endLine - 1 : row.endLine,
      depth: row.depth, is_test: row.isTestFile === true };
  };
  const nodes = data.nodes.map(node), candidates = data.candidates.map(node);
  const byId = new Map<string, any>(nodes.map((row: any) => [row.id, row]));
  const edges = data.edges.map((row: any) => {
    const source = byId.get(row.source), target = byId.get(row.target);
    if (!source || !target || typeof row.kind !== "string" || !Number.isSafeInteger(row.id)) {
      throw new Error("Indexed projection contains an invalid edge or missing endpoint");
    }
    return { id: row.id, source: source.qualified_name, target: target.qualified_name,
      source_id: row.source, target_id: row.target, kind: row.kind, file_path: source.file_path,
      line: row.line ?? undefined, column: row.column ?? undefined, functionReference: row.functionReference === true };
  });
  const roots = data.roots.map((id: string) => {
    const root = byId.get(id);
    if (!root) throw new Error("Indexed projection root is missing");
    return root;
  });
  const claims = data.source_claims;
  if (claims !== undefined && (!Array.isArray(claims) || claims.some((claim: any) =>
    typeof claim?.path !== "string" || !admitted?.includes(claim.path) || !/^[a-f0-9]{64}$/i.test(claim.raw_digest)))) {
    throw new Error("Indexed projection contains invalid source versions");
  }
  return { status: data.status, nodes, candidates, edges, roots, analysis: data.analysis,
    coverage: data.coverage, selection: data.selection, truncated: data.coverage?.complete !== true,
    start_node: roots[0]?.qualified_name,
    source_claims: claims,
    project_navigation: { backend: "indexed", root_identity: output.sourceRoot,
      graph_generation_identity: `${data.analysis.indexedRunId}:${data.analysis.indexedStatusDigest}`,
      evidence_basis: data.analysis.scope, coverage: data.coverage,
      search_mode: ["available", "partial"].includes(data.analysis.semanticStatus) ? "hybrid" : "lexical" },
  };
}


export const OBSOLETE_NAVIGATION_FIELDS = new Set([
  "detail",
  "native",
  "diagnostic",
  "source",
  "mode",
  "output",
  "content",
  "backend",
  "backends",
  "lane",
  "lanes",
  "provider",
  "providers",
  "path",
  "budget",
  "task",
]);

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  aborted?: boolean;
  error?: string;
  pid?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  resourceSamples?: number;
  peakProcessCount?: number;
  peakRssKb?: number;
  peakCpuPct?: number;
}

export interface NavigationRunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  telemetry?: {
    tool?: string;
    backend?: string;
    lane?: string;
    mode?: string;
  };
}

export interface Lead {
  path: string;
  start?: number;
  end?: number;
  label?: string;
  reason?: string;
}

export function rejectObsoleteNavigationParams(tool: string, params: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(params ?? {}).filter(key => !allowedSet.has(key));
  const obsolete = unknown.filter(key => OBSOLETE_NAVIGATION_FIELDS.has(key));
  const rejected = obsolete.length ? obsolete : unknown;
  if (rejected.length) {
    throw new ToolCallValidationError(`${tool} rejected clean-break obsolete/unknown field(s): ${rejected.join(", ")}.`, {
      received: Object.fromEntries(rejected.map(key => [key, params[key]])),
      guidance: ["Use only fields in the current tool schema; legacy aliases and backend selectors are not supported."],
    });
  }
}
export async function resolveNavigationScope(cwd: string, scope?: string): Promise<{ ok: true; scope: string; isFile: boolean } | { ok: false; text: string; envelope: HarnessEnvelope }> {
  const expanded = scope ? (scope.startsWith("~") ? join(homedir(), scope.startsWith("~/") ? scope.slice(2) : scope.slice(1)) : scope) : undefined;
  const target = expanded ? (isAbsolute(expanded) ? expanded : resolve(cwd, expanded)) : cwd;
  const info = await stat(target).catch(() => undefined);
  if (!info) {
    return {
      ok: false,
      text: `ERROR: scope not found: ${scope ?? "."}.\nNo navigation backend was run. Choose an existing project/file scope and retry.`,
      envelope: harnessEnvelope({ status: "error", summary: "Navigation scope was not found.", next_actions: ["Retry with an existing scope."], artifacts: [], diagnostics: [`scope=${scope ?? "."}`] }),
    };
  }
  return { ok: true, scope: target, isFile: info.isFile() };
}

export async function resolveRequiredLane(scope: string, lane: NavigationLane): Promise<PreparedLaneResolution> {
  return resolvePreparedLane(scope, lane);
}

export function publicLaneName(lane: NavigationLane): string {
  if (lane === "docs") return "docs index";
  if (lane === "graph") return "graph map";
  return "navigation lane";
}

export function sanitizeAgentText(text: string): string {
  return String(text ?? "")
    .replace(/\b(code graph|docs index|graph map|live structural utility)\s+backend\b/gi, "$1 capability")
    .replace(/GRAPHIFY_QUERY_LOG_DISABLE=1/g, "query logging disabled")
    .replace(/Backend\/lane:/gi, "Failing layer:");
}

export function laneUnavailableText(kind: string, readiness: PreparedLaneResolution): string {
  const layer = publicLaneName(readiness.lane);
  const isGraph = /^graph\b/i.test(kind) || /graph/i.test(layer);
  const guidance = isGraph
    ? "Automatic mode schedules safe graph preparation/refresh for eligible Git projects, but query time never repairs artifacts. Check .pi/navigation-prepare-err.log and .pi/navigation-setup.log.jsonl, run `npm run nav:doctor -- --path <project> --json`, then use /navigation-setup only when guided repair or initial provider setup is required."
    : "Use navigation-debug for diagnosis or navigation-setup to prepare the missing lane.";
  return [
    `UNAVAILABLE: ${kind} unavailable for this scope.`,
    `Failing layer: ${layer}.`,
    `Reason: ${sanitizeAgentText(readiness.reason)}`,
    "No query-time setup, indexing, provider call, mutation, or fallback navigation was used.",
    guidance,
  ].join("\n");
}

export function resultText(text: string, envelope?: HarnessEnvelope) {
  const rendered = String(text ?? "");
  const safeEnvelope = envelope ? stripPrivateEvidence(envelope) as HarnessEnvelope : undefined;
  if (safeEnvelope?.summary) {
    const page = /(?:^|\n)page=(\d+)/m.exec(rendered)?.[1];
    const totalPages = /(?:^|\n)total_pages=(\d+)/m.exec(rendered)?.[1];
    const editable = new Set([...rendered.matchAll(/\[([^\]\n]+#[A-F0-9]{8})\]/g)].map(match => match[1])).size;
    const suffix = [page ? `page ${page}${totalPages ? `/${totalPages}` : ""}` : "", editable ? `editable ${editable}` : ""].filter(Boolean);
    if (suffix.length) safeEnvelope.summary = `${safeEnvelope.summary} · ${suffix.join(" · ")}`;
  }
  return { content: [{ type: "text" as const, text: rendered }], details: safeEnvelope ? { envelope: safeEnvelope } : {} };
}

export function unavailableResult(kind: string, readiness: PreparedLaneResolution) {
  const text = laneUnavailableText(kind, readiness);
  const isGraph = /^graph\b/i.test(kind);
  const nextActions = isGraph
    ? ["Inspect .pi/navigation-prepare-err.log and .pi/navigation-setup.log.jsonl.", "Run `npm run nav:doctor -- --path <project> --json`; use navigation-debug or /navigation-setup for the diagnosed repair."]
    : ["Use navigation-debug for diagnosis, or navigation-setup to prepare the missing lane outside query-time."];
  return resultText(text, harnessEnvelope({ status: "warning", summary: `${kind} unavailable.`, next_actions: nextActions, artifacts: [], diagnostics: [`reason=${sanitizeAgentText(readiness.reason)}`, ...(readiness.diagnostics ?? []).map(value => sanitizeAgentText(value))] }));
}

export async function runCommand(command: string, args: string[], options: NavigationRunOptions): Promise<CommandResult> {
  const parsed = parseCommand(command);
  const resolved = parsed.command;
  const finalArgs = [...parsed.args, ...args];
  const started = Date.now();
  const run = await runSupervisedCommand(resolved, finalArgs, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
  });
  recordPerfEvent({
    kind: "query_command",
    cwd: options.cwd,
    root: options.cwd,
    tool: options.telemetry?.tool,
    backend: options.telemetry?.backend,
    lane: options.telemetry?.lane,
    mode: options.telemetry?.mode,
    status: run.ok ? "success" : "failed",
    command: resolved,
    args: finalArgs,
    pid: run.pid,
    durationMs: Date.now() - started,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    stdoutBytes: run.stdoutBytes,
    stderrBytes: run.stderrBytes,
    stdoutTruncated: run.stdoutTruncated,
    stderrTruncated: run.stderrTruncated,
    resourceSamples: run.resourceSamples,
    peakProcessCount: run.peakProcessCount,
    peakRssKb: run.peakRssKb,
    peakCpuPct: run.peakCpuPct,
    childCount: run.peakProcessCount,
    exitCode: run.code,
    signal: run.signal,
    timedOut: run.timedOut,
    aborted: run.aborted,
    error: run.error,
  }, { root: options.cwd, env: options.env ?? process.env });
  return run;
}
function parseCommand(command: string): { command: string; args: string[] } {
  const parts = splitCommand(command);
  return { command: parts[0] ?? command, args: parts.slice(1) };
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (current) { parts.push(current); current = ""; }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts.length ? parts : [command];
}



export function graphifyQueryEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const safe = Object.fromEntries(Object.entries(env).filter(([name]) => !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)));
  return { ...safe, GRAPHIFY_QUERY_LOG_DISABLE: "1" };
}

export function relativeDisplay(root: string, path: string): string {
  const rel = relative(root, path).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : path.replace(/\\/g, "/");
}

export function selectorForLead(lead: Lead): string {
  const range = lead.start ? `:${lead.start}${lead.end && lead.end !== lead.start ? `-${lead.end}` : ""}` : "";
  return `${lead.path}${range}`;
}

const STRUCTURED_LEAD_DIRECT_KEYS = new Set([
  "path", "file", "file_path", "doc_path", "source_file", "filename", "member", "name",
  "title", "label", "summary", "reason", "why", "kind", "qualified_name",
]);

export function parseFileBackedLeadsFromJson(raw: any, root: string, limit: number): Lead[] {
  const out: Lead[] = [];
  const seen = new Set<string>();
  const push = (pathValue: string, start?: number, end?: number, label?: string, reason?: string) => {
    const normalized = normalizeLeadPathInfo(pathValue, root);
    if (!normalized || isUnsafeNavigationPath(normalized.rel)) return;
    const range = normalizeLeadRange(normalized.abs, start, end);
    const key = `${normalized.rel}:${range.start ?? 1}:${range.end ?? range.start ?? 80}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: normalized.rel, start: range.start ?? 1, end: range.end ?? range.start ?? 80, label, reason: reason ?? (start === undefined ? "result referenced this file without exact range" : "result referenced this source location") });
  };
  const visit = (value: any) => {
    if (out.length >= limit || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (looksLikePath(value)) push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const hasStructuredResults = Array.isArray((value as any).results) && (value as any).results.length > 0;
    const pathValue = firstString(value.path, value.file, value.file_path, value.doc_path, value.source_file, value.filename, value.member, value.name);
    if (pathValue && looksLikePath(pathValue)) {
      const docsLike = typeof value.doc_path === "string" || typeof value.section_id === "string";
      const start = firstNumber(value.line, value.line_start, value.start_line, value.range?.start_line) ?? (docsLike ? undefined : firstNumber(value.start, value.range?.start));
      const end = firstNumber(value.end_line, value.line_end, value.range?.end_line) ?? (docsLike ? undefined : firstNumber(value.end, value.range?.end)) ?? start;
      const precision = firstString(value.precision, value.range_precision);
      const reason = precision === "synthetic_locator" ? "synthetic locator without exact source range" : firstString(value.summary, value.reason, value.why);
      push(pathValue, start, end, firstString(value.title, value.label, value.summary, value.kind), reason);
    }
    for (const [key, item] of Object.entries(value)) {
      if (hasStructuredResults && key === "relationships") continue;
      if (pathValue && looksLikePath(pathValue) && STRUCTURED_LEAD_DIRECT_KEYS.has(key)) continue;
      visit(item);
    }
  };
  visit(raw);
  return out.slice(0, limit);
}

export function parseJsonOrText(stdout: string): any | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return undefined;
}

export function formatBackendJsonForOutput(raw: any): string {
  const compact = compactBackendJson(raw);
  const gcf = encodeGenericGCFormat(compact);
  return gcf || JSON.stringify(compact, null, 2);
}

export function sanitizeGraphifyResult(value: unknown, root: string): { value: unknown; diagnostics: string[]; staleFileNodeCount: number } {
  const stalePaths = new Set<string>();
  const rootPath = resolve(root);
  const visit = (item: any, parentKey = ""): any => {
    if (Array.isArray(item)) {
      const filtered = item.filter(candidate => {
        if (!["nodes", "path", "results"].includes(parentKey) || !isGraphifyFileNode(candidate)) return true;
        const source = firstString(candidate.source_file, candidate.file_path, candidate.path);
        if (!source) return true;
        const candidatePath = resolve(rootPath, source);
        const inRoot = candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${pathSeparator()}`);
        if (inRoot && existsSync(candidatePath)) return true;
        stalePaths.add(source);
        return false;
      });
      return filtered.map(candidate => visit(candidate, parentKey));
    }
    if (!item || typeof item !== "object") return item;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(item)) out[key] = visit(nested, key);
    return out;
  };
  const sanitized = visit(value);
  const diagnostics = stalePaths.size ? [`graphify_stale_file_nodes=${stalePaths.size}`, `graphify_stale_file_sample=${[...stalePaths].sort().slice(0, 5).join(",")}`] : [];
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    const record = sanitized as Record<string, any>;
    record.project_navigation = {
      ...(record.project_navigation && typeof record.project_navigation === "object" ? record.project_navigation : {}),
      graphify_hygiene: { stale_file_node_count: stalePaths.size, stale_file_sample: [...stalePaths].sort().slice(0, 5), lifecycle_refresh_required: stalePaths.size > 0 },
    };
  }
  return { value: sanitized, diagnostics, staleFileNodeCount: stalePaths.size };
}

function isGraphifyFileNode(value: any): boolean {
  if (!value || typeof value !== "object") return false;
  const type = `${value.kind ?? ""} ${value.type ?? ""} ${value.category ?? ""} ${value.label ?? ""}`;
  return Boolean(firstString(value.source_file, value.file_path, value.path)) && /(?:^|\W)file(?:$|\W)/i.test(type);
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function compactBackendJson(value: any, depth = 0): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  // Let the GCF encoder own array truncation so it can report the true native
  // total. Pre-truncating here changed a 500-row native array into an 81-row
  // synthetic array and hid the real count from the rendered output.
  if (Array.isArray(value)) return value.map(item => compactBackendJson(item, depth + 1));
  const implementationNoise = new Set(["backend", "tool", "detail_level", "source_status", "leads"]);
  const important = ["status", "summary", "decision_summary", "workflow", "title", "name", "kind", "target", "path", "file", "files", "representative_file", "representative_files", "file_path", "doc_path", "qualified_name", "import_target", "importer", "source", "line", "line_start", "line_end", "start", "end", "reason", "score", "confidence", "confidence_tier", "id", "node_id", "entry_point_id", "criticality", "node_count", "file_count", "depth", "step_count", "steps_truncated", "communities", "flows", "native_components", "direct_target_evidence", "relationships_to_check", "changed_context_evidence", "tests_found", "test_gaps_or_absence_warnings", "target_summary", "suspected_target_summary", "likely_edit_boundary", "dependencies_to_understand", "dependents_to_protect", "tests_or_test_evidence", "possible_entry_points_or_callers", "downstream_dependencies_or_callees", "relevant_tests_or_missing_test_evidence", "known_test_candidates", "test_gaps", "affected_flows_to_validate", "risk_prioritized_validation_order", "command_policy", "evidence_locations", "prospective_impact", "regression_context", "change_plan", "debug_triage", "test_plan", "results", "nodes", "edges", "relationship_edges", "steps", "metadata", "diagnostics", "signal", "artifact_quality", "filtered_excluded_path_count", "excluded_segments", "relationship_count", "relationship_edge_count", "relationships", "callers", "callees", "imports", "importers", "tests", "ancestors", "children", "section", "content", "snippet", "rank", "provenance", "impact", "review", "review_context", "risk", "risk_score", "changed_files", "changed_nodes", "impacted_nodes", "impacted_files", "changed_functions", "affected_flows", "review_priorities", "review_guidance", "context_savings", "scope_drift", "requested_changed_files", "warning", "in_scope_changed_function_count", "out_of_scope_changed_function_count", "in_scope_test_gap_count", "out_of_scope_test_gap_count", "in_scope_changed_functions", "out_of_scope_changed_functions", "in_scope_test_gaps", "out_of_scope_test_gaps", "omitted_count", "total_count", "saved_tokens", "saved_percent", "estimated", "hints", "edge_count", "total_impacted", "truncated"];
  const signalCountKeys = ["dependency_count", "dependent_count", "known_test_count", "caller_count", "callee_count", "affected_flow_count", "test_gap_count", "changed_function_count", "review_priority_count", "changed_node_count", "impacted_node_count", "changed_file_count", "impacted_file_count", "community_count", "flow_count", "result_count"];
  const priority = [...important, ...signalCountKeys];
  const entries = Object.entries(value).filter(([key, item]) => item !== undefined && !implementationNoise.has(key));
  const presentPriority = priority
    .filter(key => Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined && !implementationNoise.has(key))
    .map(key => [key, value[key]] as [string, any]);
  const extraEntries = entries.filter(([key]) => !priority.includes(key));
  // Match the generic encoder's object-key cap. Unknown native fields are
  // semantic evidence until proven to be implementation chatter; preserve them
  // instead of silently whitelisting them away.
  const remaining = Math.max(0, 64 - presentPriority.length);
  const keptExtras = extraEntries.slice(0, remaining);
  const omittedExtras = extraEntries.slice(remaining).map(([key]) => key);
  const out: Record<string, any> = {};
  for (const [key, item] of [...presentPriority, ...keptExtras]) out[key] = compactBackendJson(item, depth + 1);
  if (omittedExtras.length) out.__omitted_native_keys = omittedExtras;
  return out;
}

export function renderLeads(title: string, leads: Lead[], _root: string, rawContext?: string): string {
  const lines = [String(title ?? "")];
  if (rawContext?.trim()) lines.push("", trimText(rawContext.trim(), 3000));
  appendExactFollowUpSelectors(lines, exactFollowUpLeads(leads).slice(0, 8));
  return lines.join("\n");
}


export function renderNativeResult(title: string, native: unknown, leads: Lead[], options: { rawText?: string; maxNativeChars?: number; contextLabel?: string; followUpSelectors?: boolean } = {}): string {
  const lines = [String(title ?? "")];
  const nativeText = typeof native === "string"
    ? native
    : native !== undefined
      ? formatBackendJsonForOutput(stripPrivateEvidence(native))
      : options.rawText ?? "";
  if (nativeText.trim()) {
    const maxChars = options.maxNativeChars ?? 16000;
    const body = native && typeof native === "object" && hasPreparedPageWindows(native) && nativeText.length > maxChars
      ? `${nativeText.slice(0, maxChars)}\n...[presentation truncated ${nativeText.length - maxChars} chars; use next_page from project_navigation.page_windows]`
      : trimText(nativeText.trim(), maxChars);
    lines.push("", options.contextLabel ?? "Result", body);
  }
  if (options.followUpSelectors) appendExactFollowUpSelectors(lines, selectAuthorityLeads(leads));
  return lines.join("\n");
}

function hasPreparedPageWindows(native: unknown): boolean {
  if (!native || typeof native !== "object" || Array.isArray(native)) return false;
  const projectNavigation = (native as any).project_navigation;
  return Boolean(projectNavigation && Array.isArray(projectNavigation.page_windows));
}

function exactFollowUpLeads(leads: Lead[]): Lead[] {
  const seen = new Set<string>();
  const out: Lead[] = [];
  for (const lead of leads) {
    if (!isExactFollowUpLead(lead)) continue;
    const selector = selectorForLead(lead);
    if (seen.has(selector)) continue;
    seen.add(selector);
    out.push(lead);
  }
  return out;
}

export function selectAuthorityLeads(leads: Lead[], limit = 12): Lead[] {
  return exactFollowUpLeads(leads).slice(0, Math.max(0, Math.min(12, Math.floor(limit))));
}

function isExactFollowUpLead(lead: Lead): boolean {
  const start = Number(lead.start);
  const end = Number(lead.end ?? lead.start);
  if (!lead.path || !Number.isFinite(start) || start <= 0) return false;
  if (/without exact range|synthetic locator|locator-only/i.test(String(lead.reason ?? ""))) return false;
  if (isGenericReferencedLead(lead)) return false;
  if (isBroadDefaultLead(lead, start, end)) return false;
  return true;
}

function isBroadDefaultLead(lead: Lead, start: number, end: number): boolean {
  const span = Math.max(1, end - start + 1);
  const label = String(lead.label ?? "").trim();
  const reason = String(lead.reason ?? "").trim();
  const genericText = `${label} ${reason}`.trim();
  const generic = !genericText || looksLikePath(genericText) || /^(?:File|Referenced|CRG referenced|result referenced)\b/i.test(genericText);
  return start === 1 && (end >= 80 || (span > 40 && generic));
}

function isGenericReferencedLead(lead: Lead): boolean {
  const text = `${lead.label ?? ""} ${lead.reason ?? ""}`.trim();
  return /^(?:CRG\s+)?referenced\b/i.test(text);
}

function appendExactFollowUpSelectors(lines: string[], leads: Lead[]): void {
  if (!leads.length) return;
  lines.push("", "Exact follow-up selectors");
  for (const lead of leads) lines.push(`- ${selectorForLead(lead)}`);
}

export function envelopeForLeads(summary: string, leads: Lead[], diagnostics: string[] = []): HarnessEnvelope {
  return harnessEnvelope({
    status: "success",
    summary,
    next_actions: [],
    artifacts: exactFollowUpLeads(leads).slice(0, 12).map(selectorForLead),
    diagnostics: diagnostics.filter(Boolean),
  });
}

export function trimText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]` : text;
}

export function parseFileBackedLeadsFromText(text: string, root: string, limit: number): Lead[] {
  const leads: Lead[] = [];
  const seen = new Set<string>();
  const push = (pathValue: string, start?: number, end?: number) => {
    const normalized = normalizeLeadPathInfo(pathValue, root);
    if (!normalized || isUnsafeNavigationPath(normalized.rel)) return;
    const range = normalizeLeadRange(normalized.abs, start, end);
    const isDefaultBareRange = (range.start ?? 1) === 1 && (range.end ?? range.start ?? 80) === 80 && start === undefined && end === undefined;
    if (isDefaultBareRange && leads.some(lead => lead.path === normalized.rel && !(lead.start === 1 && (lead.end === 80 || lead.end === undefined)))) return;
    const key = `${normalized.rel}:${range.start ?? 1}:${range.end ?? range.start ?? 80}`;
    if (seen.has(key) || leads.length >= limit) return;
    seen.add(key);
    leads.push({ path: normalized.rel, start: range.start ?? 1, end: range.end ?? range.start ?? 80, reason: start === undefined ? "result referenced this file without exact range" : "result referenced this source location" });
  };
  const patterns = [
    /^### (.+?\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|md|mdx|rst|txt|json|toml|ya?ml|sh|css|html)):(\d+)(?:-(\d+))?(?:\s|$)/gm,
    /^```(.+?\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|md|mdx|rst|txt|json|toml|ya?ml|sh|css|html)):(\d+)(?:-(\d+))?$/gm,
    /((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|md|mdx|rst|txt|json|toml|ya?ml|sh|css|html)):(\d+)(?:-(\d+)|:(\d+))?/g,
    /\[((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|md|mdx|rst|txt|json|toml|ya?ml|sh|css|html)):(\d+)(?:-(\d+))?\]/g,
    /\b((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|md|mdx|rst|txt|json|toml|ya?ml|sh|css|html))\s+L(\d+)\b/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) && leads.length < limit) {
      const start = Number(match[2] ?? 1) || 1;
      const end = Number(match[3] ?? match[4] ?? start) || start;
      push(match[1]!, start, end);
    }
  }
  const sourcePattern = /\bsrc=([^\]\s]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|md|mdx|rst|txt|json|toml|ya?ml|sh|css|html))(?:\s|\])/g;
  let sourceMatch: RegExpExecArray | null;
  while ((sourceMatch = sourcePattern.exec(text)) && leads.length < limit) push(sourceMatch[1]!);
  const barePathPattern = /(?<![\w/.-])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|md|mdx|rst|txt|json|toml|ya?ml|sh|css|html))(?![\w/.-])/g;
  let barePathMatch: RegExpExecArray | null;
  while ((barePathMatch = barePathPattern.exec(text)) && leads.length < limit) push(barePathMatch[1]!);
  return leads;
}

export function isUnsafeNavigationPath(pathValue: string): boolean {
  const parts = pathValue.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.some(part => new Set(["node_modules", "vendor", "dist", "build", "out", "coverage", "target", ".git", ".hg", ".svn", ".pi", ".agents", ".agent", ".claude", ".codex", ".research", ".rtfm", ".gsd", "graphify-out", ".code-review-graph", ".crg", ".semble", ".codanna", ".codedb-mcp", ".codescope", ".codesearch.db", ".trace-mcp", ".fastembed_cache", ".tmp", ".cache", "logs", "log", "sessions", "archive", "archives", ".archive"]).has(part));
}

function normalizeLeadPathInfo(pathValue: string, root: string): { rel: string; abs: string } | undefined {
  let value = String(pathValue).trim().replace(/\\/g, "/");
  if (!value) return undefined;
  if (/^[a-z]+:\/\//i.test(value)) return undefined;
  const lineSuffix = /:(\d+)(?::\d+)?$/.exec(value);
  if (lineSuffix) value = value.slice(0, lineSuffix.index);
  const abs = isAbsolute(value) ? value : join(root, value);
  if (!existsSync(abs)) return undefined;
  try {
    const info = statSync(abs);
    if (!info.isFile()) return undefined;
  } catch { return undefined; }
  return { rel: relativeDisplay(root, abs), abs };
}

function normalizeLeadPath(pathValue: string, root: string): string | undefined {
  return normalizeLeadPathInfo(pathValue, root)?.rel;
}

function normalizeLeadRange(abs: string, start?: number, end?: number): { start?: number; end?: number } {
  const lines = countFileLines(abs);
  const safeStart = Number.isFinite(Number(start)) && Number(start) > 0 ? Math.floor(Number(start)) : undefined;
  const safeEnd = Number.isFinite(Number(end)) && Number(end) > 0 ? Math.floor(Number(end)) : safeStart;
  if (!lines) return { start: safeStart, end: safeEnd };
  if (!safeStart || safeStart > lines) return { start: 1, end: Math.min(80, lines) };
  return { start: safeStart, end: Math.min(Math.max(safeEnd ?? safeStart, safeStart), lines) };
}

function countFileLines(abs: string): number | undefined {
  try {
    const text = readFileSync(abs, "utf8");
    return Math.max(1, text.split(/\r\n|\r|\n/).length);
  } catch { return undefined; }
}

function looksLikePath(value: string): boolean {
  return /[/.]/.test(value) && /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|md|mdx|rst|txt|json|toml|yaml|yml|sh|css|html)$/i.test(value.replace(/:\d+(?::\d+)?$/, ""));
}

function firstString(...values: any[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function firstNumber(...values: any[]): number | undefined {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export function backendArtifactMissing(pathValue?: string): boolean {
  return !pathValue || !existsSync(pathValue);
}

export function scopeRootForLane(readiness: PreparedLaneResolution, fallback: string): string {
  return readiness.ok ? readiness.root : fallback;
}

export function commandForLane(readiness: PreparedLaneResolution): string {
  if (!readiness.ok || !readiness.command) throw new Error("prepared lane has no verified extension-owned command");
  return readiness.command;
}

export function graphPathForLane(readiness: PreparedLaneResolution): string | undefined {
  return readiness.ok ? readiness.graphPath ?? readiness.indexPath : undefined;
}

export function describeLeadSource(name: string, readiness: PreparedLaneResolution): string {
  if (!readiness.ok) return `${name} unavailable: ${readiness.reason}`;
  const stamp = readiness.updatedAt ?? readiness.indexedAt;
  return `${name} via ${publicLaneName(readiness.lane)}${stamp ? ` updated ${stamp}` : ""}`;
}

export function displayScopeName(scope: string): string {
  return basename(scope) || scope;
}
