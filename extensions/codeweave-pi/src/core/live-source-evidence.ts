export type LiveSourceVisibility = "visible_complete" | "hidden" | "clipped";
export type LiveSourceTransformation = "verbatim" | "transformed" | "inferred";

export interface LiveSourceProvenance {
  capability: string;
  backend: string;
  route?: string;
}

export interface LiveSourceEvidenceRow {
  line: number;
  text: string;
  visibility: LiveSourceVisibility;
  transformation: LiveSourceTransformation;
}

/**
 * Typed evidence transport. canonicalPath and wholeFileDigest are populated
 * only after live-byte validation; parser-produced candidates leave them unset.
 */
export interface LiveSourceEvidence {
  path: string;
  canonicalPath?: string;
  wholeFileDigest?: string;
  rows: LiveSourceEvidenceRow[];
  provenance: LiveSourceProvenance;
}

export interface DisplayedLiveRow {
  path: string;
  line: number;
  text: string;
}

export function liveSourceEvidenceFromRows(rows: DisplayedLiveRow[], provenance: LiveSourceProvenance): LiveSourceEvidence[] {
  const grouped = new Map<string, LiveSourceEvidenceRow[]>();
  for (const row of rows) {
    if (!row.path || !Number.isInteger(row.line) || row.line < 1 || typeof row.text !== "string") continue;
    const list = grouped.get(row.path) ?? [];
    if (!list.some(item => item.line === row.line && item.text === row.text)) {
      list.push({ line: row.line, text: row.text, visibility: "visible_complete", transformation: "verbatim" });
    }
    grouped.set(row.path, list);
  }
  return [...grouped].map(([path, evidenceRows]) => ({ path, rows: evidenceRows, provenance: { ...provenance } }));
}


export function isCertifiableLiveSourceRow(row: LiveSourceEvidenceRow): boolean {
  return row.visibility === "visible_complete" && row.transformation === "verbatim" && Number.isInteger(row.line) && row.line >= 1 && typeof row.text === "string";
}
