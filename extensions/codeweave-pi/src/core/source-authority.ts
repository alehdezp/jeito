import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { type LiveSourceEvidence, isCertifiableLiveSourceRow } from "./live-source-evidence.ts";
import type { Lead } from "./navigation-clean.ts";
import { canonicalExistingPath, displayPath, resolvePath } from "./path-resolve.ts";
import { callPiNav, MAX_SOURCE_PROOF_FILES, MAX_SOURCE_PROOF_FILE_BYTES, type NativeSourceSnapshot, type PiNavCaller } from "./pi-nav-native.ts";
import { computeDigest, PUBLIC_HASH_LENGTH, snapshots } from "./snapshot-store.ts";
import { normalizeToLF, splitLogicalLines, stripBom } from "./text-normalize.ts";

export interface SourceAuthorityResult {
  text: string;
  certified: boolean;
  authorities: Array<{ path: string; tag: string; lines: number[]; evidence: LiveSourceEvidence }>;
  rejectedRows: number;
}

/**
 * Certify complete verbatim rows from one native source snapshot per canonical file.
 * Snapshot payloads stay operation-local and never enter model text or persisted details.
 */
export async function certifySourceAuthority(options: Parameters<typeof prepareSourceAuthority>[0]): Promise<SourceAuthorityResult> {
  const { commit, complete: _complete, sourceSnapshots: _snapshots, ...result } = await prepareSourceAuthority(options);
  commit();
  return result;
}

/** Prepare the same proof and footer without granting authority to a discarded reply. */
export async function prepareSourceAuthority(options: {
  cwd: string;
  nativeText: string;
  evidence: LiveSourceEvidence[];
  sourceSnapshots?: NativeSourceSnapshot[];
  signal?: AbortSignal;
  callNative?: PiNavCaller;
}): Promise<SourceAuthorityResult & { complete: boolean; commit: () => void; sourceSnapshots: NativeSourceSnapshot[] }> {
  const deadline = performance.now() + 25_000;
  const root = canonicalRoot(options.cwd);
  const { grouped, resolved } = canonicalEvidence(root, options.cwd, options.evidence);
  const byCanonical = new Map<string, NativeSourceSnapshot>();
  // Keep the existing packet's maximum raw-text allowance across the entire
  // proof phase. Stage before recording authority so a later abort/deadline
  // cannot leave newly authorized rows from an unfinished proof operation.
  let remainingBytes = MAX_SOURCE_PROOF_FILES * MAX_SOURCE_PROOF_FILE_BYTES;
  const retain = (proofs: NativeSourceSnapshot[]) => {
    for (const source of proofs) {
      const canonical = canonicalKey(source.canonicalPath);
      if (!grouped.has(canonical) || byCanonical.has(canonical)) continue;
      const bytes = Buffer.byteLength(source.text, "utf8");
      if (bytes > MAX_SOURCE_PROOF_FILE_BYTES || bytes > remainingBytes) continue;
      byCanonical.set(canonical, source);
      remainingBytes -= bytes;
    }
  };
  retain(options.sourceSnapshots ?? []);
  const missing = [...grouped.keys()].filter(path => !byCanonical.has(canonicalKey(path)));
  const remainingTime = () => {
    options.signal?.throwIfAborted();
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error("[pi-nav:deadline] source proof deadline exceeded");
    return remaining;
  };
  for (let offset = 0; offset < missing.length && remainingBytes > 0; offset += MAX_SOURCE_PROOF_FILES) {
    const proof = await (options.callNative ?? callPiNav)({
      root,
      operation: "pi_nav_source_proof",
      args: { paths: missing.slice(offset, offset + MAX_SOURCE_PROOF_FILES) },
      timeoutMs: remainingTime(),
      signal: options.signal,
    });
    retain(proof.sourceSnapshots ?? []);
  }
  remainingTime();
  const authorities: SourceAuthorityResult["authorities"] = [];
  // Operation-local bytes for context derived from the very snapshot that certified a row.
  // Never include these in model text, persisted details, or the committing convenience API.
  const sourceSnapshots: NativeSourceSnapshot[] = [];
  const pending: Array<{ canonical: string; text: string; rawDigest: string; seen: Set<number> }> = [];
  const commit = () => {
    remainingTime();
    for (const item of pending) snapshots.recordTrustedProof(item.canonical, item.text, item.rawDigest, item.seen);
  };
  let rejectedRows = options.evidence.reduce((count, item) => count + item.rows.filter(row => !isCertifiableLiveSourceRow(row)).length, 0);
  let complete = resolved;

  for (const [canonical, group] of grouped) {
    const source = byCanonical.get(canonicalKey(canonical));
    if (!source || !validSnapshot(source, canonical)) {
      rejectedRows += group.evidence.rows.filter(isCertifiableLiveSourceRow).length;
      continue;
    }
    const normalized = normalizeToLF(stripBom(source.text).text);
    const { lines } = splitLogicalLines(normalized);
    const seen = new Set<number>();
    for (const row of group.evidence.rows) {
      if (!isCertifiableLiveSourceRow(row)) continue;
      if (seen.size >= 2000) { complete = false; continue; }
      if (row.line <= lines.length && lines[row.line - 1] === row.text) seen.add(row.line);
      else rejectedRows++;
    }
    if (!seen.size) continue;
    sourceSnapshots.push(source);
    const digest = computeDigest(source.text);
    pending.push({ canonical, text: source.text, rawDigest: source.rawDigest, seen });
    const validated: LiveSourceEvidence = {
      ...group.evidence,
      canonicalPath: canonical,
      wholeFileDigest: digest,
      rows: group.evidence.rows.filter(row => seen.has(row.line) && isCertifiableLiveSourceRow(row)),
    };
    authorities.push({
      path: displayPath(root, canonical),
      tag: digest.slice(0, PUBLIC_HASH_LENGTH),
      lines: [...seen].sort((a, b) => a - b),
      evidence: validated,
    });
  }

  complete &&= rejectedRows === 0;
  if (!authorities.length) return { text: `${options.nativeText}\n\nSource handoff: locator-only; no complete current verbatim rows were certified.`, certified: false, authorities, rejectedRows, complete, commit, sourceSnapshots };
  const manifest = authorities
    .map(authority => `[${authority.path}#${authority.tag}] lines ${formatLineSet(authority.lines)}`)
    .join("\n");
  return {
    text: `${options.nativeText}\n\nLive source authority\n${manifest}${rejectedRows ? `\nSource handoff: partial authority; ${rejectedRows} row(s) were not certifiable.` : ""}`,
    certified: true,
    authorities,
    rejectedRows,
    complete,
    commit,
    sourceSnapshots,
  };
}

function canonicalEvidence(root: string, cwd: string, evidence: LiveSourceEvidence[]) {
  const grouped = new Map<string, { evidence: LiveSourceEvidence }>();
  let resolved = true;
  for (const item of evidence) {
    let canonical: string;
    try { canonical = canonicalExistingPath(resolvePath(cwd, item.path)); }
    catch { if (item.rows.length) resolved = false; continue; }

    const existing = grouped.get(canonical);
    if (!existing) {
      grouped.set(canonical, { evidence: { ...item, canonicalPath: canonical, rows: [...item.rows] } });
      continue;
    }
    for (const row of item.rows) {
      if (!existing.evidence.rows.some(candidate => candidate.line === row.line && candidate.text === row.text && candidate.visibility === row.visibility && candidate.transformation === row.transformation)) {
        existing.evidence.rows.push(row);
      }
    }
  }
  return { grouped, resolved };
}

export async function certifyExactLeads(options: Parameters<typeof prepareExactLeads>[0]) {
  const { commit, ...result } = await prepareExactLeads(options);
  commit();
  return result;
}

/** Exact-lead expansion also participates in final ranked fitting before authority lands. */
export async function prepareExactLeads(options: {
  cwd: string;
  nativeText: string;
  leads: Lead[];
  expectedRawDigests?: Record<string, string>;
  requireVersion?: boolean;
  signal?: AbortSignal;
  callNative?: PiNavCaller;
}): Promise<{ text: string; promoted: boolean; selectors: string[]; artifacts: string[]; reason?: string; commit: () => void }> {
  let commit = () => { options.signal?.throwIfAborted(); };
  const rejected: string[] = [];
  const exactLeads: Lead[] = [];
  const seenLead = new Set<string>();
  for (const lead of options.leads.filter(isExactLead)) {
    const start = Number(lead.start);
    const end = Number(lead.end ?? lead.start);
    const key = `${lead.path}:${start}-${end}`;
    if (seenLead.has(key)) continue;
    seenLead.add(key);
    if (end - start + 1 > 400) {
      rejected.push(`${key} exceeds the 400-line proof limit`);
      continue;
    }
    exactLeads.push(lead);
  }
  const selectedLeads = exactLeads.slice(0, 12);
  if (exactLeads.length > selectedLeads.length) rejected.push(`${exactLeads.length - selectedLeads.length} exact source claim(s) exceeded the 12-range visible proof limit`);
  const rawSelectors = groupNumericLeads(selectedLeads);
  const boundedSelectors = rawSelectors.filter(selector => {
    const lines = selector.ranges.reduce((count, range) => count + range.end - range.start + 1, 0);
    if (lines <= 400) return true;
    rejected.push(`${formatSelector(selector)} exceeds the 400-line proof limit`);
    return false;
  });
  const formattedSelectors = boundedSelectors.map(formatSelector);
  if (!exactLeads.length) return { text: options.nativeText, promoted: false, selectors: formattedSelectors, artifacts: [], reason: rejected[0] ?? "no exact source selector was returned", commit };
  if (!boundedSelectors.length) return { text: options.nativeText, promoted: false, selectors: formattedSelectors, artifacts: [], reason: rejected[0] ?? "exact source claims exceed proof limits", commit };

  const root = canonicalRoot(options.cwd);
  const expectedByCanonical = new Map<string, Set<string>>();
  for (const [path, digest] of Object.entries(options.expectedRawDigests ?? {})) {
    try {
      const key = canonicalKey(canonicalExistingPath(resolvePath(root, path)));
      const values = expectedByCanonical.get(key) ?? new Set<string>();
      values.add(digest.toUpperCase());
      expectedByCanonical.set(key, values);
    } catch { /* A missing indexed path remains untrusted and is handled per selector below. */ }
  }
  const byCanonicalSelector = new Map<string, NumericSelector>();
  for (const selector of boundedSelectors) {
    let canonical: string;
    try { canonical = canonicalExistingPath(resolvePath(root, selector.path)); }
    catch { rejected.push(`${formatSelector(selector)} path is unavailable`); continue; }
    const expectedCanonical = expectedByCanonical.get(canonicalKey(canonical));
    if (options.requireVersion && !options.expectedRawDigests?.[selector.path] && !expectedCanonical?.size) {
      rejected.push(`${formatSelector(selector)} has no indexed file version`);
      continue;
    }
    const key = canonicalKey(canonical);
    const existing = byCanonicalSelector.get(key);
    if (existing) {
      existing.ranges = mergeRanges([...existing.ranges, ...selector.ranges]);
      existing.aliases = [...new Set([...(existing.aliases ?? [existing.path]), selector.path])];
    } else if (byCanonicalSelector.size < 5) {
      byCanonicalSelector.set(key, { ...selector, canonical, aliases: [selector.path] });
    } else {
      rejected.push(`${formatSelector(selector)} exceeds the 5-file visible proof limit`);
    }
  }
  const selectors = [...byCanonicalSelector.values()];
  if (!selectors.length) return { text: options.nativeText, promoted: false, selectors: formattedSelectors, artifacts: [], reason: rejected[0] ?? "exact source claims could not be resolved", commit };

  const proof = await (options.callNative ?? callPiNav)({
    root,
    operation: "pi_nav_source_proof",
    args: { paths: selectors.map(selector => selector.path) },
    timeoutMs: 25_000,
    signal: options.signal,
  });
  const byCanonical = new Map((proof.sourceSnapshots ?? []).map(snapshot => [canonicalKey(snapshot.canonicalPath), snapshot]));
  const prepared: Array<{ canonical: string; rawText: string; rawDigest: string; seen: Set<number>; shown: string; body: string[] }> = [];
  let lineCount = 0;
  let byteCount = 0;
  for (const selector of selectors) {
    const canonical = selector.canonical!;
    const source = byCanonical.get(canonicalKey(canonical));
    if (!source || !validSnapshot(source, canonical)) {
      rejected.push(`${formatSelector(selector)} source proof is unavailable`);
      continue;
    }
    const expectedDigests = [...new Set([
      ...(selector.aliases ?? [selector.path]).map(path => options.expectedRawDigests?.[path]?.toUpperCase()).filter((value): value is string => Boolean(value)),
      ...[...(expectedByCanonical.get(canonicalKey(canonical)) ?? [])],
    ])];
    if (expectedDigests.length > 1 || (expectedDigests.length === 1 && source.rawDigest !== expectedDigests[0])) {
      rejected.push(`${formatSelector(selector)} indexed version is stale or inconsistent across aliases`);
      continue;
    }
    const normalized = normalizeToLF(stripBom(source.text).text);
    const { lines } = splitLogicalLines(normalized);
    if (selector.ranges.some(range => range.end > lines.length)) {
      rejected.push(`${formatSelector(selector)} range exceeds the current file`);
      continue;
    }
    const seen = new Set<number>();
    const body: string[] = [];
    let selectorLines = 0;
    let selectorBytes = 0;
    for (const range of selector.ranges) {
      for (let line = range.start; line <= range.end; line++) {
        const row = `${line}:${lines[line - 1]}`;
        selectorLines++;
        selectorBytes += Buffer.byteLength(`${row}\n`, "utf8");
        seen.add(line);
        body.push(row);
      }
    }
    if (lineCount + selectorLines > 400 || byteCount + selectorBytes > 96 * 1024) {
      rejected.push(`${formatSelector(selector)} exceeds the remaining 400-line or 96-KiB proof budget`);
      continue;
    }
    lineCount += selectorLines;
    byteCount += selectorBytes;
    if (seen.size) prepared.push({ canonical, rawText: source.text, rawDigest: source.rawDigest, seen, shown: displayPath(root, canonical), body });
  }

  commit = () => {
    options.signal?.throwIfAborted();
    for (const item of prepared) snapshots.recordTrustedProof(item.canonical, item.rawText, item.rawDigest, item.seen);
  };
  const rendered: string[] = [];
  const artifacts: string[] = [];
  for (const item of prepared) {
    const tag = computeDigest(item.rawText).slice(0, PUBLIC_HASH_LENGTH);
    artifacts.push(`[${item.shown}#${tag}]`);
    rendered.push(`[${item.shown}#${tag}]\n${item.body.join("\n")}`);
  }
  if (!rendered.length) {
    return { text: options.nativeText, promoted: false, selectors: formattedSelectors, artifacts, reason: rejected[0] ?? "exact source claims could not be proven", commit };
  }
  return {
    text: `${options.nativeText}\n\nExpanded live source\n${rendered.join("\n\n")}`,
    promoted: true,
    selectors: formattedSelectors,
    artifacts,
    reason: rejected.length ? `${rejected.length} exact source claim(s) were rejected: ${rejected.join("; ")}` : undefined,
    commit,
  };
}

type NumericSelector = { path: string; ranges: Array<{ start: number; end: number }>; canonical?: string; aliases?: string[] };

function isExactLead(lead: Lead): boolean {
  const start = Number(lead.start);
  const end = Number(lead.end ?? lead.start);
  if (!lead.path || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return false;
  if (/without exact range|synthetic locator|locator-only/i.test(String(lead.reason ?? ""))) return false;
  const label = `${lead.label ?? ""} ${lead.reason ?? ""}`.trim();
  // Retired evidence labels remain untrusted; removal must not grant old locator rows edit authority.
  const generic = !label || /^(?:CRG\s+)?(?:referenced|file)\b/i.test(label) || label === lead.path;
  return !(start === 1 && end >= 80 && generic);
}

function groupNumericLeads(leads: Lead[]): NumericSelector[] {
  const byPath = new Map<string, NumericSelector["ranges"]>();
  for (const lead of leads) {
    const ranges = byPath.get(lead.path) ?? [];
    ranges.push({ start: Number(lead.start), end: Number(lead.end ?? lead.start) });
    byPath.set(lead.path, ranges);
  }
  return [...byPath].map(([path, ranges]) => ({ path, ranges: mergeRanges(ranges) }));
}

function mergeRanges(ranges: NumericSelector["ranges"]): NumericSelector["ranges"] {
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: NumericSelector["ranges"] = [];
  for (const range of ranges) {
    const tail = merged.at(-1);
    if (tail && range.start <= tail.end + 1) tail.end = Math.max(tail.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function formatSelector(selector: NumericSelector): string {
  return `${selector.path}:${selector.ranges.map(range => `${range.start}-${range.end}`).join(",")}`;
}

function validSnapshot(snapshot: NativeSourceSnapshot, canonical: string): boolean {
  if (canonicalKey(snapshot.canonicalPath) !== canonicalKey(canonical)) return false;
  const rawDigest = createHash("sha256").update(snapshot.text).digest("hex").toUpperCase();
  if (rawDigest !== snapshot.rawDigest) return false;
  if (snapshot.bom !== snapshot.text.startsWith("\ufeff")) return false;
  return snapshot.lineEnding === (snapshot.text.includes("\r\n") ? "crlf" : "lf");
}

function canonicalRoot(cwd: string): string {
  const root = resolve(cwd);
  try { return realpathSync(root); } catch { return root; }
}

function canonicalKey(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}


function formatLineSet(lines: number[]): string {
  if (!lines.length) return "";
  const ranges: string[] = [];
  let start = lines[0];
  let end = start;
  for (const line of lines.slice(1)) {
    if (line === end + 1) { end = line; continue; }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    start = end = line;
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.join(",");
}
