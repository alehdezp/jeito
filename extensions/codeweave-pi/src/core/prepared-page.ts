import { createHash } from "node:crypto";

const PAGE_ARRAY_KEYS = new Set([
  "results", "relationships", "relationship_edges", "nodes", "edges", "communities", "flows",
  "candidates", "member_details", "steps", "file_backed_results", "sourceRows", "test_candidate_origins",
  "tests", "affected_flows", "changed_functions", "test_gaps", "hub_nodes", "bridge_nodes",
  "surprising_connections", "traversal", "questions", "large_functions", "gaps", "sections", "documents", "outline",
  "direct_target_evidence", "relationships_to_check", "changed_context_evidence", "tests_found",
  "test_gaps_or_absence_warnings", "likely_edit_boundary", "dependencies_to_understand", "dependents_to_protect",
  "tests_or_test_evidence", "possible_entry_points_or_callers", "downstream_dependencies_or_callees",
  "relevant_tests_or_missing_test_evidence", "known_test_candidates", "affected_flows_to_validate",
  "risk_prioritized_validation_order", "evidence_locations", "review_priorities", "changed_nodes", "impacted_nodes", "impacted_files",
]);

export interface PreparedPageOptions {
  page: number;
  limit: number;
  request: unknown;
  rootIdentity?: string;
  generationIdentity?: string;
  /** Optional exact collection paths to page; other native arrays remain additive evidence. */
  collectionPaths?: string[];
}

export interface PreparedPageWindow {
  path: string;
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

export function pagePreparedEvidence(value: unknown, options: PreparedPageOptions): unknown {
  const page = Math.max(1, Math.floor(options.page));
  const limit = Math.max(1, Math.floor(options.limit));
  const selectedPaths = options.collectionPaths ? new Set(options.collectionPaths) : undefined;
  const windows: PreparedPageWindow[] = [];

  const visit = (input: unknown, path: string, key?: string): unknown => {
    if (Array.isArray(input)) {
      if (!key || !PAGE_ARRAY_KEYS.has(key) || (selectedPaths && !selectedPaths.has(path))) return input.map((item, index) => visit(item, `${path}[${index}]`));
      const total = input.length;
      const start = Math.min(total, (page - 1) * limit);
      const end = Math.min(total, start + limit);
      const totalPages = Math.max(1, Math.ceil(total / limit));
      windows.push({
        path,
        page,
        page_size: limit,
        total_count: total,
        returned_count: end - start,
        omitted_before: start,
        omitted_after: total - end,
        total_pages: totalPages,
        ...(end < total ? { next_page: page + 1 } : {}),
        omitted_count: total - (end - start),
        complete: start === 0 && end === total,
        ...((start > 0 || end < total) ? { reason: "page_window" as const } : {}),
      });
      return input.slice(start, end).map((item, index) => visit(item, `${path}[${start + index}]`));
    }
    if (!input || typeof input !== "object") return input;
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(input as Record<string, unknown>)) {
      if (childKey === "page_windows") continue;
      output[childKey] = visit(child, path ? `${path}.${childKey}` : childKey, childKey);
    }
    return output;
  };

  const paged = visit(value, "");
  if (!paged || typeof paged !== "object" || Array.isArray(paged)) return paged;
  const record = paged as Record<string, unknown>;
  const existing = record.project_navigation && typeof record.project_navigation === "object" && !Array.isArray(record.project_navigation)
    ? record.project_navigation as Record<string, unknown>
    : {};
  const continuationOmitted: string[] = [];
  if (page > 1) {
    for (const key of ["summary", "decision_summary", "component_summaries", "native_components", "target_summary", "suspected_target_summary"]) {
      if (Object.hasOwn(record, key)) { delete record[key]; continuationOmitted.push(key); }
    }
  }
  const rowLimits = Object.fromEntries(windows
    .map(window => [window.path, {
      returned_count: window.returned_count,
      total_count: window.total_count,
      omitted_count: window.omitted_count,
      page: window.page,
      next_page: window.next_page,
    }]));
  return {
    ...record,
    ...(Object.keys(rowLimits).length ? { row_limits: rowLimits } : {}),
    project_navigation: {
      ...existing,
      request_identity: requestIdentity(options.request),
      root_identity: options.rootIdentity,
      generation_identity: options.generationIdentity,
      page_windows: windows,
      ...(continuationOmitted.length ? { continuation_omitted_fields: continuationOmitted } : {}),
      continuation: windows.some(window => window.next_page)
        ? { next_page: Math.min(...windows.filter(window => window.next_page).map(window => window.next_page!)), reason: "page_window" }
        : undefined,
    },
  };
}

function requestIdentity(request: unknown): string {
  return createHash("sha256").update(stableJson(request)).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
