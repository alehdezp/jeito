import { createHash } from "node:crypto";
import { normalizeForSnapshot } from "./text-normalize.ts";
export const PUBLIC_HASH_LENGTH = 8;

export interface SnapshotBlock {
  start: number;
  end: number;
  kind: "function" | "class" | "heading";
  label: string;
  parser?: "tree-sitter-wasm" | "deterministic-local";
  grammar?: string;
  grammarVersion?: string;
}

export interface Snapshot {
  canonicalPath: string;
  text: string;
  tag: string;
  digest: string;
  recordedAt: number;
  byteLength: number;
  /** 1-indexed complete source lines actually shown under this file hash. */
  seenLines?: Set<number>;
  /** Exact high-confidence structural spans minted by the read that produced this snapshot. */
  blocks?: SnapshotBlock[];
}

export function computeDigest(text: string): string {
  return createHash("sha256").update(normalizeForSnapshot(text)).digest("hex").toUpperCase();
}

export function computeTag(text: string): string {
  return computeDigest(text).slice(0, PUBLIC_HASH_LENGTH);
}

interface SnapshotAuthority {
  ranges?: [number, number][];
  blocks?: SnapshotBlock[];
}

export class SnapshotStore {
  #versions = new Map<string, Snapshot[]>();
  #maxVersionsPerPath: number;
  #maxPaths: number;
  #maxBytes: number;
  // Text is expensive; evicting it must not discard the authority earned by
  // delivered rows. Compact receipts share the existing byte budget, no disk.
  #authority = new Map<string, string>();
  #authorityBytes = 0;

  constructor(options: { maxVersionsPerPath?: number; maxPaths?: number; maxBytes?: number } = {}) {
    this.#maxVersionsPerPath = options.maxVersionsPerPath ?? 8;
    this.#maxPaths = options.maxPaths ?? 200;
    this.#maxBytes = options.maxBytes ?? snapshotByteLimit();
  }

  record(canonicalPath: string, text: string, seenLines?: Iterable<number>, blocks?: Iterable<SnapshotBlock>): Snapshot {
    const normalized = normalizeForSnapshot(text);
    const digest = computeDigest(normalized);
    // Eight public hex digits reduce cross-path collision risk while the full
    // digest + exact text remain the authoritative internal identity.
    const tag = digest.slice(0, PUBLIC_HASH_LENGTH);
    const byteLength = Buffer.byteLength(normalized, "utf8");
    const history = this.#versions.get(canonicalPath) ?? [];
    const existing = history.find(s => s.digest === digest && s.text === normalized);
    const snapshot: Snapshot = existing ?? { canonicalPath, text: normalized, tag, digest, recordedAt: Date.now(), byteLength };
    const retained = !existing && this.#authority.get(`${canonicalPath}\0${digest}`);
    if (retained) {
      const receipt: SnapshotAuthority = JSON.parse(retained);
      if (receipt.ranges) {
        snapshot.seenLines = new Set<number>();
        for (const [start, end] of receipt.ranges) for (let line = start; line <= end; line++) snapshot.seenLines.add(line);
      }
      snapshot.blocks = receipt.blocks;
    }
    snapshot.recordedAt = Date.now();
    snapshot.byteLength = byteLength;
    mergeSeenLines(snapshot, seenLines);
    mergeBlocks(snapshot, blocks);
    this.#rememberAuthority(snapshot);
    this.#versions.delete(canonicalPath);
    this.#versions.set(canonicalPath, [snapshot, ...history.filter(s => s !== snapshot)].slice(0, this.#maxVersionsPerPath));
    while (this.#versions.size > this.#maxPaths) {
      const oldest = this.#versions.keys().next().value;
      if (!oldest) break;
      this.#versions.delete(oldest);
    }
    this.#evictToByteLimit();
    return snapshot;
  }
  restore(canonicalPath: string, text: string): Snapshot | undefined {
    const digest = computeDigest(text);
    if (!this.#authority.has(`${canonicalPath}\0${digest}`)) return undefined;
    return this.record(canonicalPath, text);
  }

  #rememberAuthority(snapshot: Snapshot): void {
    const key = `${snapshot.canonicalPath}\0${snapshot.digest}`;
    const ranges: [number, number][] | undefined = snapshot.seenLines === undefined ? undefined : [];
    for (const line of [...(snapshot.seenLines ?? [])].sort((a, b) => a - b)) {
      const last = ranges!.at(-1);
      if (last && line === last[1] + 1) last[1] = line;
      else ranges!.push([line, line]);
    }
    const encoded = JSON.stringify({ ranges, blocks: snapshot.blocks } satisfies SnapshotAuthority);
    const previous = this.#authority.get(key);
    if (previous) this.#authorityBytes -= Buffer.byteLength(key) + Buffer.byteLength(previous);
    this.#authority.delete(key);
    this.#authority.set(key, encoded);
    this.#authorityBytes += Buffer.byteLength(key) + Buffer.byteLength(encoded);
    while (this.#authorityBytes > this.#maxBytes && this.#authority.size) {
      const oldest = this.#authority.keys().next().value!;
      this.#authorityBytes -= Buffer.byteLength(oldest) + Buffer.byteLength(this.#authority.get(oldest)!);
      this.#authority.delete(oldest);
    }
  }

  recordTrustedProof(canonicalPath: string, rawText: string, rawDigest: string, seenLines?: Iterable<number>, blocks?: Iterable<SnapshotBlock>): Snapshot {
    const observedRawDigest = createHash("sha256").update(rawText).digest("hex").toUpperCase();
    if (observedRawDigest !== rawDigest.toUpperCase()) {
      throw new Error(`Native source proof digest mismatch for ${canonicalPath}`);
    }
    return this.record(canonicalPath, rawText, seenLines, blocks);
  }


  byTag(canonicalPath: string, tag: string): Snapshot | undefined {
    const matches = (this.#versions.get(canonicalPath) ?? []).filter(s => s.tag === tag.toUpperCase());
    return matches.length === 1 ? matches[0] : undefined;
  }

  byContent(canonicalPath: string, text: string): Snapshot | undefined {
    const normalized = normalizeForSnapshot(text);
    return (this.#versions.get(canonicalPath) ?? []).find(s => s.text === normalized);
  }

  findByTag(tag: string): Snapshot[] {
    const matches: Snapshot[] = [];
    for (const history of this.#versions.values()) {
      for (const snapshot of history) if (snapshot.tag === tag.toUpperCase()) matches.push(snapshot);
    }
    return matches;
  }

  recordSeenLines(canonicalPath: string, tag: string, lines: Iterable<number>): void {
    const snapshot = this.byTag(canonicalPath, tag);
    if (snapshot) {
      mergeSeenLines(snapshot, lines);
      this.#rememberAuthority(snapshot);
    }
  }

  head(canonicalPath: string): Snapshot | undefined {
    return this.#versions.get(canonicalPath)?.[0];
  }

  invalidate(canonicalPath: string): void {
    this.#versions.delete(canonicalPath);
    for (const [key, encoded] of this.#authority) {
      if (!key.startsWith(`${canonicalPath}\0`)) continue;
      this.#authorityBytes -= Buffer.byteLength(key) + Buffer.byteLength(encoded);
      this.#authority.delete(key);
    }
  }

  relocate(oldCanonicalPath: string, newCanonicalPath: string, digest: string): boolean {
    const source = this.#versions.get(oldCanonicalPath) ?? [];
    const matches = source.filter(snapshot => snapshot.digest === digest);
    if (matches.length !== 1 || (this.#versions.get(newCanonicalPath)?.length ?? 0) > 0) return false;
    const snapshot = matches[0]!;
    this.invalidate(oldCanonicalPath);
    snapshot.canonicalPath = newCanonicalPath;
    this.#versions.set(newCanonicalPath, [snapshot]);
    this.#rememberAuthority(snapshot);
    return true;
  }

  totalBytes(): number {
    let total = this.#authorityBytes;
    for (const history of this.#versions.values()) for (const snapshot of history) total += snapshot.byteLength ?? Buffer.byteLength(snapshot.text, "utf8");
    return total;
  }

  clear(): void {
    this.#versions.clear();
    this.#authority.clear();
    this.#authorityBytes = 0;
  }

  #evictToByteLimit(): void {
    while (this.#versions.size > 1 && this.totalBytes() > this.#maxBytes) {
      const oldestPath = this.#versions.keys().next().value;
      if (!oldestPath) break;
      const history = this.#versions.get(oldestPath) ?? [];
      if (history.length > 1) this.#versions.set(oldestPath, history.slice(0, -1));
      else this.#versions.delete(oldestPath);
    }
  }
}

function mergeSeenLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
  if (lines === undefined) return;
  snapshot.seenLines ??= new Set<number>();
  for (const line of lines) if (Number.isInteger(line) && line >= 1) snapshot.seenLines.add(line);
}

function mergeBlocks(snapshot: Snapshot, blocks: Iterable<SnapshotBlock> | undefined): void {
  if (blocks === undefined) return;
  const byIdentity = new Map((snapshot.blocks ?? []).map(block => [`${block.start}:${block.end}:${block.kind}:${block.label}`, block]));
  for (const block of blocks) {
    if (!Number.isInteger(block.start) || !Number.isInteger(block.end) || block.start < 1 || block.end <= block.start) continue;
    byIdentity.set(`${block.start}:${block.end}:${block.kind}:${block.label}`, { ...block });
  }
  snapshot.blocks = [...byIdentity.values()].sort((a, b) => a.start - b.start || a.end - b.end || a.label.localeCompare(b.label));
}

function snapshotByteLimit(): number {
  const raw = String(process.env.PI_NAV_SNAPSHOT_MAX_BYTES ?? "").trim();
  const value = raw ? Number(raw) : 128 * 1024 * 1024;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 128 * 1024 * 1024;
}

export const snapshots = new SnapshotStore();
