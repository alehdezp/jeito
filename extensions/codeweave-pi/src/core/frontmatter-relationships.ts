import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { MarkdownFrontmatterRelationship } from "./markdown-frontmatter.ts";
import { detectNearestPackageRoot } from "./project-root.ts";
import { DEFAULT_BROAD_TEXT_FILE_BYTES, isBinaryOrHeavyExtension, looksBinary, readTextFileSafely } from "./scan-policy.ts";
import { EXPLICIT_SELECTOR_OUTPUT_BUDGET, renderedSourceSelectionLength, resolveSourceSelector, splitSourceReference } from "./source-selector.ts";
import { normalizeToLF, splitLogicalLines, stripBom } from "./text-normalize.ts";
import type { PiNavCaller } from "./pi-nav-native.ts";
import type { SourceInterval } from "./source-selector.ts";

export interface AuthoredDocumentationReference {
  form: "frontmatter" | "project" | "markdown";
  value: string;
  field?: "code" | "related";
  /** Current grammar/YAML evidence supplied by the collector, not certified by this resolver. */
  site: { path: string; sourceHash: string; interval: SourceInterval; startOffset?: number; endOffset?: number };
}

export interface AuthoredReferenceResolution {
  reference: AuthoredDocumentationReference;
  status: RelationshipSelectorStatus;
  reason: string;
  claim: "unverified";
  target?: {
    path: string;
    sourceHash: string;
    kind: "file" | "selection";
    selector?: string;
    intervals: SourceInterval[];
    context: string[];
  };
}

/** Resolves a collected authored site, never the truth of the prose around it.
 * Admission must enforce the current owning project and code/docs corpus for BOTH paths.
 * The collector owns the site's current source hash and grammar-derived span.
 */
export async function resolveAuthoredDocumentationReference(params: {
  projectRoot: string;
  reference: AuthoredDocumentationReference;
  admit: (request: { path: string; requestedPath: string; role: "document" | "target"; ownerPath: string; signal?: AbortSignal }) => boolean | Promise<boolean>;
  callNative?: PiNavCaller;
  signal?: AbortSignal;
}): Promise<AuthoredReferenceResolution> {
  const { reference, signal } = params;
  const finding = (status: RelationshipSelectorStatus, reason: string): AuthoredReferenceResolution => {
    signal?.throwIfAborted();
    return { reference, status, reason, claim: "unverified" };
  };
  signal?.throwIfAborted();
  try {
    const root = await realpath(params.projectRoot);
    const ownerRequested = resolve(root, reference.site.path);
    if (!inside(root, ownerRequested)) return finding("invalid", "document escapes project root");
    const ownerPath = await realpath(ownerRequested);
    if (!inside(root, ownerPath)) return finding("invalid", "document symlink escapes project root");
    if (!await params.admit({ path: ownerPath, requestedPath: ownerRequested, role: "document", ownerPath, signal })) return finding("unverified", "document is not admitted to the current docs corpus");
    signal?.throwIfAborted();

    const value = reference.value.trim();
    if (!value) return finding("invalid", "empty reference");
    let referenceRoot = detectNearestPackageRoot(ownerPath, root);
    let parsed;
    if (reference.form === "markdown") {
      // These are grammar-provided URL destinations, not apparent links scanned from prose.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return finding("unverified", "external URL is not resolved");
      const hash = value.indexOf("#");
      const pathPart = hash < 0 ? value : value.slice(0, hash);
      if (pathPart.includes("?")) return finding("unverified", "URL query is not a source selector");
      if (hash >= 0 && value.slice(hash + 1)) return finding("unverified", "standard Markdown fragment requires heading-based resolution; not a codeweave-pi selector");
      const filePath = decodeURIComponent(pathPart);
      referenceRoot = dirname(ownerPath);
      parsed = { filePath: filePath || ownerPath, raw: false, explicitSelector: false };
      if (filePath && isAbsolute(filePath)) return finding("invalid", "absolute Markdown URL paths are not project references");
    } else {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return finding("unverified", "external URL is not resolved");
      if (isAbsolute(value)) return finding("invalid", "project references must be relative");
      const literal = resolve(referenceRoot, value);
      if (!inside(root, literal)) return finding("invalid", "target escapes project root");
      const literalInfo = await stat(literal).catch((error: any) => {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
        throw error;
      });
      parsed = literalInfo ? { filePath: value, raw: false, explicitSelector: false } : splitSourceReference(value);
    }
    if (parsed.raw) return finding("unverified", "raw is an output modifier, not a relationship selector");
    const requestedPath = resolve(referenceRoot, parsed.filePath);
    if (!inside(root, requestedPath)) return finding("invalid", "target escapes project root");
    const canonical = await realpath(requestedPath);
    if (!inside(root, canonical)) return finding("invalid", "target symlink escapes project root");
    const before = await stat(canonical);
    if (!before.isFile()) return finding("invalid", "target is not a regular file");
    if (!await params.admit({ path: canonical, requestedPath, role: "target", ownerPath, signal })) return finding("unverified", "target is not admitted to the current code/docs corpus");
    signal?.throwIfAborted();
    if (isBinaryOrHeavyExtension(canonical) || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > DEFAULT_BROAD_TEXT_FILE_BYTES) return finding("unverified", "target exceeds text-analysis safety limits");
    const sameFile = (info: typeof before) => info.isFile() && info.dev === before.dev && info.ino === before.ino && info.size === before.size && info.mtimeMs === before.mtimeMs && info.ctimeMs === before.ctimeMs;
    if (await realpath(requestedPath) !== canonical || await realpath(canonical) !== canonical) return finding("unverified", "target changed during admission");
    // Pin the admitted inode before reading content; do not follow a replaced final symlink.
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameFile(await handle.stat())) return finding("unverified", "target changed during admission");
      signal?.throwIfAborted();
      // One sentinel byte detects growth without letting readFile allocate against a moving EOF.
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        signal?.throwIfAborted();
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== before.size || !sameFile(await handle.stat())) return finding("unverified", "target changed while reading");
      const bytes = buffer.subarray(0, length);
      if (looksBinary(bytes)) return finding("unverified", "target exceeds text-analysis safety limits");
      const sourceText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const sourceHash = createHash("sha256").update(bytes).digest("hex");
      const { lines } = splitLogicalLines(normalizeToLF(stripBom(sourceText).text));
      const selected = parsed.selector
        ? await resolveSourceSelector({ selector: parsed.selector, lines, display: canonical, cwd: referenceRoot, absolutePath: canonical, sourceText, signal, callNative: params.callNative, capturedSourceRoot: root })
        : { intervals: lines.length ? [{ start: 1, end: lines.length }] : [], context: [] };
      signal?.throwIfAborted();
      if (selected.intervals.some(interval => !Number.isSafeInteger(interval.start) || !Number.isSafeInteger(interval.end) || interval.start < 1 || interval.end < interval.start || interval.end > lines.length)) return finding("unverified", "resolved target range is invalid");
      if (!sameFile(await handle.stat()) || !sameFile(await stat(canonical)) || await realpath(requestedPath) !== canonical) return finding("unverified", "target changed while resolving");
      return { ...finding("valid", parsed.selector ? "current authored selector resolves; prose claim unverified" : "current authored file mention; prose claim unverified"), target: {
        path: canonical, sourceHash, kind: parsed.selector ? "selection" : "file", selector: parsed.selector, intervals: selected.intervals, context: selected.context,
      } };
    } finally {
      await handle.close();
      signal?.throwIfAborted();
    }
  } catch (error) {
    signal?.throwIfAborted();
    const reason = String(error instanceof Error ? error.message : error).replace(/^Read refused:\s*/, "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (/\bambiguous\b/i.test(reason)) return finding("ambiguous", reason);
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || /was not found|unsupported selector|Invalid range|beyond end of file/i.test(reason)) return finding("invalid", reason);
    return finding("unverified", reason);
  }
}

export type RelationshipSelectorStatus = "valid" | "invalid" | "ambiguous" | "unverified";

export interface RelationshipSelectorFinding extends MarkdownFrontmatterRelationship {
  status: RelationshipSelectorStatus;
  reason: string;
}

export interface RelationshipSelectorValidation {
  counts: Record<RelationshipSelectorStatus, number>;
  findings: RelationshipSelectorFinding[];
  text: string;
}

export async function validateFrontmatterRelationships(params: {
  projectRoot: string;
  ownerPath?: string;
  relationships: MarkdownFrontmatterRelationship[];
  signal?: AbortSignal;
}): Promise<RelationshipSelectorValidation | undefined> {
  if (params.relationships.length === 0) return undefined;
  const projectRoot = await realpath(params.projectRoot);
  const referenceRoot = detectNearestPackageRoot(params.ownerPath ?? projectRoot, projectRoot);
  const findings: RelationshipSelectorFinding[] = [];
  const memo = new Map<string, Promise<Omit<RelationshipSelectorFinding, "field" | "value">>>();
  for (const relationship of params.relationships) {
    const value = relationship.value.trim();
    let validation = memo.get(value);
    if (!validation) {
      validation = validateReference(referenceRoot, projectRoot, value, params.signal).catch(error => {
        if (params.signal?.aborted) throw error;
        return { status: "unverified" as const, reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").trim().slice(0, 300) };
      });
      memo.set(value, validation);
    }
    findings.push({ ...relationship, ...(await validation) });
  }
  const counts = { valid: 0, invalid: 0, ambiguous: 0, unverified: 0 } satisfies Record<RelationshipSelectorStatus, number>;
  for (const finding of findings) counts[finding.status]++;
  return { counts, findings, text: renderRelationshipValidation(counts, findings) };
}

async function validateReference(referenceRoot: string, projectRoot: string, value: string, signal?: AbortSignal): Promise<{ status: RelationshipSelectorStatus; reason: string }> {
  if (!value) return { status: "invalid", reason: "empty reference" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { status: "unverified", reason: "external URL is not validated" };
  if (isAbsolute(value)) return { status: "invalid", reason: "frontmatter references must be project-relative" };
  const literalPath = resolve(referenceRoot, value);
  if (!inside(projectRoot, literalPath)) return { status: "invalid", reason: "target escapes project root" };
  const literalInfo = await stat(literalPath).catch((error: any) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  const reference = literalInfo
    ? { filePath: value, raw: false, explicitSelector: false as const }
    : splitSourceReference(value);
  const absolutePath = literalInfo ? literalPath : resolve(referenceRoot, reference.filePath);
  if (!inside(projectRoot, absolutePath)) return { status: "invalid", reason: "target escapes project root" };
  const info = literalInfo ?? await stat(absolutePath).catch((error: any) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return { status: "invalid", reason: `target not found: ${reference.filePath}` };
  if (!info.isFile()) return { status: "invalid", reason: "target is not a regular file" };
  const canonical = await realpath(absolutePath);
  if (!inside(projectRoot, canonical)) return { status: "invalid", reason: "target symlink escapes project root" };
  if (!reference.selector) return { status: "valid", reason: "current target file exists" };
  if (reference.raw) return { status: "unverified", reason: "raw is an output modifier, not a relationship selector" };

  const safe = await readTextFileSafely(canonical, { signal });
  if (!safe.ok) return { status: "unverified", reason: `target cannot be structurally read (${safe.reason})` };
  const { text } = stripBom(safe.text);
  const normalized = normalizeToLF(text);
  const { lines } = splitLogicalLines(normalized);
  try {
    const resolved = await resolveSourceSelector({ selector: reference.selector, lines, display: reference.filePath, cwd: referenceRoot, absolutePath: canonical, sourceText: safe.text, signal });
    if (renderedSourceSelectionLength(reference.filePath, lines, resolved.intervals, resolved.context) > EXPLICIT_SELECTOR_OUTPUT_BUDGET) {
      return { status: "unverified", reason: "resolved selection exceeds the read output budget" };
    }
    return { status: "valid", reason: "current selector resolves" };
  } catch (error) {
    if (signal?.aborted) throw error;
    const reason = String(error instanceof Error ? error.message : error).replace(/^Read refused:\s*/, "").replace(/\s+/g, " ").trim();
    if (/\bambiguous\b/i.test(reason)) return { status: "ambiguous", reason };
    if (/\bunavailable\b|\bchanged while resolving\b|\bnative symbol range .* invalid\b/i.test(reason)) return { status: "unverified", reason };
    return { status: "invalid", reason };
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function renderRelationshipValidation(counts: Record<RelationshipSelectorStatus, number>, findings: RelationshipSelectorFinding[]): string {
  const lines = [`Relationship selectors: valid=${counts.valid} · invalid=${counts.invalid} · ambiguous=${counts.ambiguous} · unverified=${counts.unverified}`];
  for (const finding of findings.filter(item => item.status !== "valid").slice(0, 20)) {
    const value = finding.value.replace(/\s+/g, " ").trim().slice(0, 240);
    lines.push(`- ${finding.field}: ${value} (${finding.reason})`);
  }
  if (findings.filter(item => item.status !== "valid").length > 20) lines.push(`- … ${findings.filter(item => item.status !== "valid").length - 20} more findings omitted`);
  return lines.join("\n");
}
