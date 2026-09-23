const IMPORTANT_KEYS = [
  "status", "summary", "decision_summary", "workflow", "title", "name", "kind", "target", "path", "file", "files", "representative_file", "representative_files", "file_path", "doc_path", "source_file",
  "change_plan", "debug_triage", "test_plan", "review", "impact", "review_context", "signal", "diagnostics", "artifact_quality", "warning",
  "scope_drift", "risk_score", "review_priorities", "review_guidance", "context_savings", "changed_files", "changed_functions", "test_gaps", "changed_nodes", "impacted_nodes", "impacted_files",
  "direct_target_evidence", "relationships_to_check", "changed_context_evidence", "tests_found", "test_gaps_or_absence_warnings", "target_summary", "suspected_target_summary", "likely_edit_boundary", "dependencies_to_understand", "dependents_to_protect", "tests_or_test_evidence", "possible_entry_points_or_callers", "downstream_dependencies_or_callees", "relevant_tests_or_missing_test_evidence", "known_test_candidates", "prospective_impact", "regression_context", "affected_flows", "affected_flows_to_validate", "risk_prioritized_validation_order", "command_policy", "evidence_locations",
  "native_components", "communities", "flows", "relationship_edges", "relationships", "results", "nodes", "edges", "steps", "metadata",
  "id", "node_id", "entry_point_id", "qualified_name", "import_target", "importer", "source", "line", "line_start", "line_end", "start", "end", "reason", "score", "rank", "confidence", "confidence_tier", "criticality", "node_count", "file_count", "depth", "step_count", "steps_truncated", "provenance", "snippet",
];

const VISIBLE_EMPTY_ARRAY_KEYS = new Set([
  "direct_target_evidence",
  "relationships_to_check",
  "changed_context_evidence",
  "tests_found",
  "test_gaps_or_absence_warnings",
  "likely_edit_boundary",
  "dependencies_to_understand",
  "dependents_to_protect",
  "tests_or_test_evidence",
  "possible_entry_points_or_callers",
  "downstream_dependencies_or_callees",
  "relevant_tests_or_missing_test_evidence",
  "known_test_candidates",
  "test_gaps",
  "affected_flows",
  "affected_flows_to_validate",
  "risk_prioritized_validation_order",
  "evidence_locations",
]);

/**
 * Encode arbitrary backend JSON into a compact GCF-style generic text form.
 *
 * This is intentionally synchronous and dependency-free for query-time safety: no
 * install/download/import-provider behavior is allowed inside navigation tools.
 * It is a local encoder modeled on the generic GCFormat shape; it is not proof
 * that the upstream GCFormat package/API is installed or being called.
 * Uniform object arrays become `## key [n]{field,...}` tables, nested objects
 * become `## key` sections, and primitive fields use `key=value` lines.
 */
export function encodeGenericGCFormat(data: unknown): string {
  const lines: string[] = [];
  emitValue(lines, undefined, data, 0);
  return lines.join("\n").trim();
}

function emitValue(lines: string[], key: string | undefined, value: unknown, depth: number): void {
  if (value === null || value === undefined || isPrimitive(value)) {
    lines.push(key ? `${key}=${formatScalar(value)}` : formatScalar(value));
    return;
  }
  if (Array.isArray(value)) {
    emitArray(lines, key ?? "items", value, depth);
    return;
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 0) return;
  if (key) lines.push(`## ${key}`);
  const ordered = orderedKeys(object);
  const omittedNested: string[] = [];
  for (const entryKey of ordered.keys) {
    if (depth >= 5 && !isPrimitive(object[entryKey])) {
      omittedNested.push(entryKey);
      continue;
    }
    emitValue(lines, entryKey, object[entryKey], depth + 1);
  }
  if (omittedNested.length) lines.push(`__omitted_nested_keys[${omittedNested.length}]: ${omittedNested.join(",")}`);
  if (ordered.omitted.length) lines.push(`__omitted_keys[${ordered.omitted.length}]: ${ordered.omitted.join(",")}`);
}

function emitArray(lines: string[], key: string, value: unknown[], depth: number): void {
  const limit = 80;
  const items = value.slice(0, limit);
  if (items.length === 0) {
    if (VISIBLE_EMPTY_ARRAY_KEYS.has(key)) lines.push(`## ${key} [0]`);
    return;
  }
  if (items.every(item => item && typeof item === "object" && !Array.isArray(item))) {
    const { fields, omitted } = tableFields(items as Record<string, unknown>[]);
    const displayFields = omitted.length ? [...fields, "__omitted_fields"] : fields;
    lines.push(`## ${key} [${value.length}]{${displayFields.join(",")}}`);
    for (const item of items as Record<string, unknown>[]) {
      lines.push(displayFields.map(field => field === "__omitted_fields" ? escapeCell(omitted.filter(k => Object.prototype.hasOwnProperty.call(item, k)).join(",")) : formatCell(item[field])).join("|"));
    }
    if (value.length > items.length) lines.push(`...truncated ${value.length - items.length} of ${value.length}`);
    return;
  }
  if (items.every(item => isPrimitive(item))) {
    lines.push(`${key}[${value.length}]: ${items.map(formatScalar).join(",")}${value.length > items.length ? `,...truncated ${value.length - items.length} of ${value.length}` : ""}`);
    return;
  }
  lines.push(`## ${key} [${value.length}]`);
  items.forEach((item, index) => emitValue(lines, String(index + 1), item, depth + 1));
  if (value.length > items.length) lines.push(`...truncated ${value.length - items.length} of ${value.length}`);
}

function tableFields(items: Record<string, unknown>[]): { fields: string[]; omitted: string[] } {
  const seen = new Set<string>();
  const all: string[] = [];
  for (const key of IMPORTANT_KEYS) {
    if (items.some(item => Object.prototype.hasOwnProperty.call(item, key))) {
      seen.add(key);
      all.push(key);
    }
  }
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(key);
    }
  }
  const limit = 32;
  return { fields: all.slice(0, limit), omitted: all.slice(limit) };
}
function orderedKeys(object: Record<string, unknown>): { keys: string[]; omitted: string[] } {
  const keys = Object.keys(object);
  const important = IMPORTANT_KEYS.filter(key => keys.includes(key));
  const rest = keys.filter(key => !IMPORTANT_KEYS.includes(key));
  const ordered = [...important, ...rest];
  const limit = 64;
  return { keys: ordered.slice(0, limit), omitted: ordered.slice(limit) };
}

function isPrimitive(value: unknown): boolean {
  return value === null || value === undefined || ["string", "number", "boolean", "bigint"].includes(typeof value);
}

function formatCell(value: unknown): string {
  if (isPrimitive(value)) return escapeCell(formatScalar(value));
  if (Array.isArray(value) && value.every(isPrimitive)) return escapeCell(value.map(formatScalar).join(","));
  if (Array.isArray(value) && value.every(item => item && typeof item === "object" && !Array.isArray(item))) return escapeCell(formatObjectArrayCell(value as Record<string, unknown>[]));
  return escapeCell(JSON.stringify(value));
}

function formatObjectArrayCell(items: Record<string, unknown>[]): string {
  const limit = 5;
  const rendered = items.slice(0, limit).map(item => {
    const parts = ["name", "kind", "path", "qualified_name", "line_start", "line_end", "node_id"]
      .filter(key => item[key] !== undefined)
      .map(key => `${key}=${formatScalar(item[key])}`);
    return `{${parts.join(",")}}`;
  });
  return `[${rendered.join(",")}${items.length > limit ? `,...truncated ${items.length - limit} of ${items.length}` : ""}]`;
}

function formatScalar(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  return String(value);
}

function escapeCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "\\n");
}
