// Query-guided section ranking (Tier 1 of the web_fetch query contract; ADR-002.003):
// fence-aware section splitting, paragraph sub-splitting of oversized sections, and
// pure-JS BM25 scoring. Zero dependencies, deterministic, ~1-3ms on a 60K-char page.
// Design notes (measured, spike 2026-08-03):
// - SUB_CHARS keeps every ranked unit <= 2,000 raw chars so top-N stays ~0.5K tokens per
//   unit and BM25 length normalization cannot bury a long but relevant section (qmd Quick
//   Start case).
// - notFound is score === 0 after BOTH the exact pass and a stemmed retry pass: measured
//   true absence scores exactly 0.0 on every page size, while ANY genuine overlap scores
//   1.4+. The stemmed retry (plurals, -ed/-ing, -ly, CVC-final-e) runs only when the exact
//   pass found nothing, so a vague query like "who gets paged at night" can still find
//   "page the storage lead" (paged -> pag == page -> pag); it never changes the primary
//   ranking. A false not-found is worse for agentic loops than a visibly scored weak
//   match, which the caller can judge or escalate to the LLM tier.
// - Heading tokens count HEADING_WEIGHT x in tf: headings carry topic density.
// - B = 0.5 (not BM25's 0.75): short dense sections must not outrank the fuller section
//   that actually answers the query (measured: graphify Install vs Troubleshooting chunk).
import { estimateTokens } from "./fetch-cache.ts";

export const SUB_CHARS = 2_000; // max raw chars per ranked unit
export const TOP_N = 3; // default ranked sections; callers may pass 1-5
export const TOP_N_MAX = 5;
/** Single-URL LLM rescue threshold (ADR-002.003/002.005): a page over 5K with query_terms
 *  whose best score is below this floor is "insignificant or really low value" — the
 *  deterministic verdict stays visible, but the automatic LLM read may fire. Calibrated
 *  band (novel-corpus eval): strong answers >= 3.6, weak/vague <= 2.4; 2.0 is the owner-
 *  accepted floor. */
export const WEAK_SCORE_FLOOR = 2.0;
const HEADING_WEIGHT = 2.5;
const K1 = 1.5;
const B = 0.5;
const STOP = new Set("a an and are as at be by for from has have i in is it its of on or that the this to was were will with you your we our".split(" "));

export interface RankedSection {
  heading: string; // heading text, or first-line label for list-item chunks; "" for root preamble
  startLine: number; // 1-based, inclusive, first body line (body-relative; printers add bodyStartLine-1)
  endLine: number; // 1-based, inclusive
  text: string; // raw trimmed body bytes
  score: number;
}

export interface QueryRank {
  sections: RankedSection[];
  pageTokens: number;
  topScore: number;
  notFound: boolean;
  unitCount: number; // total ranked units on the page (for the "top-N of M units" header)
}

export interface SnippetContextLine { line: number; text: string }
export interface RankedSnippet {
  heading: string;      // enclosing heading text ("" for root preamble; "(label)" style for list chunks)
  headingLine: number;  // 1-based body-relative line of the heading (or section start when none)
  startLine: number;    // 1-based, inclusive, first body line (printers add bodyStartLine-1)
  endLine: number;      // 1-based, inclusive
  matchLine: number;    // 1-based, inclusive, best-matching line inside the section
  score: number;
  context: SnippetContextLine[]; // the match line plus up to 3 lines above/below, clamped to the section
}

export interface SnippetRank {
  snippets: RankedSnippet[];
  topScore: number;
  notFound: boolean;    // true when the query shares no meaningful term with any unit
  unitCount: number;
}

export interface QueryDocument { id: string; body: string }
export interface RankedDocumentSection extends RankedSection { documentId: string }
export interface DocumentQueryRank extends Omit<QueryRank, "sections"> {
  sections: RankedDocumentSection[];
  documentCount: number;
}

export interface NavHeading { level: number; text: string; line: number }

interface Unit { heading: string; startLine: number; endLine: number; lines: string[]; documentId?: string }

function splitUnits(body: string): Unit[] {
  const lines = body.split("\n");
  const units: Unit[] = [];
  let inFence = false;
  let current: Unit | null = null;
  const push = () => {
    if (current) { units.push(current); current = null; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; if (current) current.lines.push(line); continue; }
    if (!inFence) {
      const m = line.match(/^(#{1,5})\s+(.*)$/);
      if (m) {
        push();
        current = { heading: m[2]!, startLine: i + 2, endLine: 0, lines: [] }; // body starts after the heading line
        continue;
      }
    }
    if (!current) current = { heading: "", startLine: i + 1, endLine: 0, lines: [] };
    current.lines.push(line);
  }
  push();
  // Sub-split oversized units at paragraph boundaries, preserving exact line ranges.
  const out: Unit[] = [];
  for (const unit of units) {
    if (unit.lines.join("\n").length <= SUB_CHARS) { out.push(unit); continue; }
    const chunks: string[][] = [];
    let chunk: string[] = [];
    let chars = 0;
    const flush = () => { if (chunk.length) { chunks.push(chunk); chunk = []; chars = 0; } };
    for (const line of unit.lines) {
      const cost = line.length + 1;
      if (cost >= SUB_CHARS) {
        // Single unbreakable line (code block, minified content): slice at the cap.
        flush();
        for (let i = 0; i < line.length; i += SUB_CHARS) chunks.push([line.slice(i, i + SUB_CHARS)]);
        continue;
      }
      if (chunk.length === 0) { chunk.push(line); chars = cost; continue; }
      if (line.trim() === "" && chars > SUB_CHARS / 2) { flush(); continue; }
      if (chars + cost > SUB_CHARS) flush();
      chunk.push(line);
      chars += cost;
    }
    flush();
    if (chunks.length <= 1) { out.push(unit); continue; }
    let offset = 0;
    for (const chunkLines of chunks) {
      const first = chunkLines.find((l) => l.trim() !== "") ?? "";
      const label = /^\s*[-*]\s+/.test(first) || /^\s*\d+\.\s+/.test(first) ? first.trim().slice(0, 80) : unit.heading;
      out.push({ heading: label, startLine: unit.startLine + offset, endLine: 0, lines: chunkLines });
      offset += chunkLines.length;
    }
  }
  return out.filter((u) => u.lines.some((l) => l.trim())).map((u) => ({ ...u, endLine: u.startLine + u.lines.length - 1 }));
}

/** Heading-only navigation (levels 1..maxDepth, outside code fences) with 1-based line
 *  numbers (body-relative; printers add bodyStartLine-1) — the mini-nav block that follows
 *  ranked sections so the caller can jump to any other part of the page without reading it. */
export function headingNav(body: string, maxDepth = 3): NavHeading[] {
  const nav: NavHeading[] = [];
  let inFence = false;
  body.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = line.match(/^(#{1,5})\s+(.*)$/);
    if (m && m[1]!.length <= maxDepth) nav.push({ level: m[1]!.length, text: m[2]!, line: i + 1 });
  });
  return nav;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

/** Mini stemmer (plurals, -ed/-ing, -ly, CVC-final-e) used ONLY for the not-found retry
 *  pass, so a vague query like "who gets paged at night" can still find "page the storage
 *  lead" (paged -> pag == page -> pag). Never changes the primary ranking. */
function stem(t: string): string {
  if (t.length <= 3) return t;
  let s = t;
  if (s.endsWith("ies") && s.length > 4) s = s.slice(0, -3) + "y";
  else if (s.endsWith("es") && s.length > 4 && /[sxz]|ch$/.test(s.slice(0, -2))) s = s.slice(0, -2);
  else if (s.endsWith("s") && !s.endsWith("ss") && s.length > 3) s = s.slice(0, -1);
  if (s.endsWith("ing") && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith("ed") && s.length > 4) s = s.slice(0, -2);
  if (s.endsWith("ly") && s.length > 4) s = s.slice(0, -2);
  if (s.endsWith("e") && s.length > 3 && /[bcdfghjklmnpqrstvwxz][aeiouy][bcdfghjklmnpqrstvwxz]e$/.test(s)) s = s.slice(0, -1);
  return s;
}

function scoreUnits(units: Unit[], query: string): Array<{ unit: Unit; score: number }> {
  const q = tokenize(query);
  const n = units.length;
  if (!q.length || !n) return units.map((unit) => ({ unit, score: 0 }));
  const avgdl = units.reduce((a, u) => a + u.lines.join("\n").length, 0) / n;
  const df = new Map<string, number>();
  const tfs = units.map((u) => {
    const tf = new Map<string, number>();
    for (const t of tokenize(u.heading)) tf.set(t, (tf.get(t) ?? 0) + HEADING_WEIGHT);
    for (const t of tokenize(u.lines.join("\n"))) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });
  return units.map((u, i) => {
    const dl = Math.max(1, u.lines.join("\n").length);
    let score = 0;
    for (const t of new Set(q)) {
      const f = tfs[i]!.get(t) ?? 0;
      if (f === 0) continue;
      const idf = Math.log((n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5) + 1);
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (dl / avgdl))));
    }
    return { unit: u, score };
  }).sort((a, b) => b.score - a.score);
}

/** Rank the page's units against a query. notFound=true only when the query shares no
 *  meaningful term (exact or stemmed) with any unit — the measured true-absence signal.
 *  Weaker overlaps return their best sections with visible scores; callers decide. */
export function querySections(body: string, query: string, topN = TOP_N): QueryRank {
  const units = splitUnits(body);
  const ranked = scoreUnits(units, query);
  const topScore = ranked[0]?.score ?? 0;
  const retried = topScore === 0 ? stemmedRetry(units, query) : ranked;
  const sections = retried.filter((r) => r.score > 0).slice(0, topN).map((r) => ({
    heading: r.unit.heading, startLine: r.unit.startLine, endLine: r.unit.endLine,
    text: r.unit.lines.join("\n").trim(), score: r.score,
  }));
  return { sections, pageTokens: estimateTokens(body), topScore: retried[0]?.score ?? 0, notFound: sections.length === 0, unitCount: units.length };
}

/** Best-matching line inside a unit: the line with the most distinct query terms. */
function bestLine(unit: Unit, query: string): number {
  const q = tokenize(query);
  if (!q.length) return unit.startLine;
  let best = unit.startLine;
  let bestHits = 0;
  unit.lines.forEach((line, index) => {
    const hits = q.filter((term) => line.toLowerCase().includes(term)).length;
    if (hits > bestHits) { bestHits = hits; best = unit.startLine + index; }
  });
  return best;
}

/** Real heading line for a unit when its heading is a markdown heading on the line
 *  directly above the body start; otherwise point at the section start (sub-split chunks). */
function headingLineOf(body: string, unit: Unit): number {
  if (!unit.heading) return unit.startLine;
  const lines = body.split("\n");
  const candidate = unit.startLine - 2; // 0-based index of the line before the body
  if (candidate >= 0 && /^#{1,5}\s+/.test(lines[candidate] ?? "") && lines[candidate]!.includes(unit.heading)) return candidate + 1;
  return unit.startLine;
}

/** Snippet view: the top-N ranked units with the best line plus up to 3 context lines
 *  above/below (clamped to the section) and the section's exact line range, so an agent
 *  can read the cached file at precisely those lines after seeing the match. */
export function rankSnippets(body: string, query: string, topN = TOP_N): SnippetRank {
  const units = splitUnits(body);
  const ranked = scoreUnits(units, query);
  const retried = ranked[0]?.score === 0 ? stemmedRetry(units, query) : ranked;
  const topScore = retried[0]?.score ?? 0;
  const picked = retried.filter((item) => item.score > 0).slice(0, topN);
  const snippets: RankedSnippet[] = picked.map(({ unit, score }) => {
    const matchLine = bestLine(unit, query);
    const from = Math.max(unit.startLine, matchLine - 3);
    const to = Math.min(unit.endLine, matchLine + 3);
    const context: SnippetContextLine[] = [];
    for (let line = from; line <= to; line++) context.push({ line, text: unit.lines[line - unit.startLine] ?? "" });
    return {
      heading: unit.heading || "(root)",
      headingLine: headingLineOf(body, unit),
      startLine: unit.startLine,
      endLine: unit.endLine,
      matchLine,
      score,
      context,
    };
  });
  return { snippets, topScore, notFound: snippets.length === 0, unitCount: units.length };
}

/** Compact printable snippet: heading, score, exact read range, and numbered context
 *  lines with ">" on the match line. offset = bodyStartLine - 1 for cached bodies. */
export function snippetBlockText(snippet: RankedSnippet, offset: number): string {
  const head = `### ${snippet.heading || "(root)"} (score ${snippet.score.toFixed(2)} · read lines ${snippet.startLine + offset}-${snippet.endLine + offset})`;
  const context = snippet.context.map(({ line, text }) => {
    const marker = line === snippet.matchLine ? ">" : " ";
    const clipped = text.length > 500 ? `${text.slice(0, 497)}…` : text;
    return `  ${marker} ${line + offset} | ${clipped}`;
  });
  return [head, ...context].join("\n");
}

/** Focus index for full-page (<=5K) ranked views: rank, score, heading, read range. */
export function focusIndexText(snippets: RankedSnippet[], offset: number, query: string): string {
  const lines = [`Focus (query "${query}") — read the marked sections first:`];
  snippets.forEach((snippet, index) => {
    lines.push(`${index + 1}. ## ${snippet.heading || "(root)"} (score ${snippet.score.toFixed(2)} · lines ${snippet.startLine + offset}-${snippet.endLine + offset})`);
  });
  return lines.join("\n");
}

/** Rank units from multiple pages in one BM25 corpus so IDF and scores are comparable.
 * Line ranges stay document-local; zero-score documents never become evidence. */
export function queryDocuments(documents: QueryDocument[], query: string, topN = TOP_N): DocumentQueryRank {
  const units = documents.flatMap((document) => splitUnits(document.body).map((unit) => ({ ...unit, documentId: document.id })));
  const ranked = scoreUnits(units, query);
  const topScore = ranked[0]?.score ?? 0;
  const retried = topScore === 0 ? stemmedRetry(units, query) : ranked;
  const sections = retried.filter((item) => item.score > 0).slice(0, topN).map((item) => ({
    documentId: item.unit.documentId!, heading: item.unit.heading,
    startLine: item.unit.startLine, endLine: item.unit.endLine,
    text: item.unit.lines.join("\n").trim(), score: item.score,
  }));
  return {
    sections,
    pageTokens: documents.reduce((total, document) => total + estimateTokens(document.body), 0),
    topScore: retried[0]?.score ?? 0,
    notFound: sections.length === 0,
    unitCount: units.length,
    documentCount: documents.length,
  };
}

/** Second chance for the not-found case: stem both sides and re-score. Returns the
 *  stemmed ranking when it finds matches, otherwise the original (all-zero) ranking. */
function stemmedRetry(units: Unit[], query: string): Array<{ unit: Unit; score: number }> {
  const q = tokenize(query).map(stem);
  const n = units.length;
  if (!q.length || !n) return [];
  const avgdl = units.reduce((a, u) => a + u.lines.join("\n").length, 0) / n;
  const df = new Map<string, number>();
  const tfs = units.map((u) => {
    const tf = new Map<string, number>();
    for (const t of tokenize(u.heading).map(stem)) tf.set(t, (tf.get(t) ?? 0) + HEADING_WEIGHT);
    for (const t of tokenize(u.lines.join("\n")).map(stem)) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });
  const scored = units.map((u, i) => {
    const dl = Math.max(1, u.lines.join("\n").length);
    let score = 0;
    for (const t of new Set(q)) {
      const f = tfs[i]!.get(t) ?? 0;
      if (f === 0) continue;
      const idf = Math.log((n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5) + 1);
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (dl / avgdl))));
    }
    return { unit: u, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored : [];
}
