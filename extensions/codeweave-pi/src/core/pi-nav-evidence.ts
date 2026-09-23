import type { LiveSourceEvidence, LiveSourceProvenance, LiveSourceTransformation, LiveSourceVisibility } from "./live-source-evidence.ts";
import type { Lead } from "./navigation-clean.ts";
import type { NativeStructured } from "./pi-nav-native.ts";

export function nativeSourceEvidence(
  structured: NativeStructured | unknown,
  provenance: LiveSourceProvenance,
): LiveSourceEvidence[] {
  const data = nativeData(structured);
  const grouped = new Map<string, LiveSourceEvidence["rows"]>();
  const rows = [
    ...nativeRecords(data.sourceRows),
    ...nativeRecords(data.files).flatMap(file => nativeRecords(file.sourceRows)),
  ];
  for (const candidate of rows) {
    if (typeof candidate.path !== "string" || !Number.isInteger(candidate.line) || Number(candidate.line) < 1 || typeof candidate.text !== "string") continue;
    const visibility = candidate.visibility;
    const transformation = candidate.transformation;
    if (!isVisibility(visibility) || !isTransformation(transformation)) continue;
    const rows = grouped.get(candidate.path) ?? [];
    if (!rows.some(row => row.line === candidate.line && row.text === candidate.text)) {
      rows.push({ line: Number(candidate.line), text: candidate.text, visibility, transformation });
    }
    grouped.set(candidate.path, rows);
  }
  return [...grouped].map(([path, rows]) => ({ path, rows, provenance: { ...provenance } }));
}

export function nativeLocationLeads(structured: NativeStructured | unknown): Lead[] {
  const data = nativeData(structured);
  const candidates = [
    ...nativeRecords(data.locations),
    ...nativeRecords(data.files).flatMap(file => nativeRecords(file.outlineEntries)),
  ];
  return candidates.flatMap(candidate => {
    if (typeof candidate.path !== "string") return [];
    const start = positiveInteger(candidate.start);
    const end = positiveInteger(candidate.end) ?? start;
    if (!start) return [];
    return [{
      path: candidate.path,
      start,
      end,
      label: typeof candidate.label === "string" ? candidate.label : undefined,
      reason: typeof candidate.role === "string" ? candidate.role : undefined,

    }];
  });
}

function nativeData(structured: NativeStructured | unknown): Record<string, unknown> {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return {};
  const record = structured as Record<string, unknown>;
  return record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record;
}

export function nativeRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function isVisibility(value: unknown): value is LiveSourceVisibility {
  return value === "visible_complete" || value === "hidden" || value === "clipped";
}

function isTransformation(value: unknown): value is LiveSourceTransformation {
  return value === "verbatim" || value === "transformed" || value === "inferred";
}
