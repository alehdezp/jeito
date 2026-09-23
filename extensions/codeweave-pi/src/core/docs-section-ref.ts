export interface CompactSectionRef {
  docPath: string;
  slugPath: string;
  level: number;
}

export function parseSectionSelectorChunk(chunk: string): { slugPath: string; level: number } | undefined {
  const raw = String(chunk ?? "").trim();
  const match = /^(?<slugPath>[^,:\s#]+(?:\/[^,:\s#]+)*)#(?<level>\d+)$/.exec(raw);
  if (!match?.groups) return undefined;
  const slugPath = match.groups.slugPath.replace(/^\/+|\/+$/g, "");
  if (!slugPath || slugPath.split("/").some(part => !part)) return undefined;
  const level = Number.parseInt(match.groups.level, 10);
  if (!Number.isInteger(level) || level < 0 || level > 6) return undefined;
  return { slugPath, level };
}

export function isSectionSelectorChunk(chunk: string): boolean {
  return parseSectionSelectorChunk(chunk) !== undefined;
}

export function parseCompactSectionRef(value: string): CompactSectionRef | undefined {
  const raw = String(value ?? "").trim();
  const colon = raw.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const docPath = raw.slice(0, colon).trim();
  const selector = parseSectionSelectorChunk(raw.slice(colon + 1));
  if (!docPath || !selector) return undefined;
  return { docPath, ...selector };
}

export function compactSectionRef(ref: CompactSectionRef): string {
  return `${ref.docPath}:${ref.slugPath}#${ref.level}`;
}

export function parseNativeSectionId(id: string): (CompactSectionRef & { repo: string }) | undefined {
  const raw = String(id ?? "").trim();
  const parts = raw.split("::");
  if (parts.length < 3) return undefined;
  const repo = parts[0]?.trim() ?? "";
  const docPath = parts[1]?.trim() ?? "";
  const selector = parseSectionSelectorChunk(parts.slice(2).join("::"));
  if (!repo || !docPath || !selector) return undefined;
  return { repo, docPath, ...selector };
}

export function compactSectionRefFromNativeId(id: string): string | undefined {
  const parsed = parseNativeSectionId(id);
  return parsed ? compactSectionRef(parsed) : undefined;
}

export function nativeSectionIdFromCompactRef(value: string, repo: string): string | undefined {
  const parsed = parseCompactSectionRef(value);
  if (!parsed) return undefined;
  return `${repo}::${parsed.docPath}::${parsed.slugPath}#${parsed.level}`;
}

export function normalizeSectionIdForRepo(value: string | undefined, repo: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (parseNativeSectionId(raw)) return raw;
  return nativeSectionIdFromCompactRef(raw, repo) ?? raw;
}
