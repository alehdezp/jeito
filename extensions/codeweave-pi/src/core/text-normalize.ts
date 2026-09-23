export interface TextEncodingInfo {
  bom: string;
  lineEnding: "\n" | "\r\n";
}

export function stripBom(text: string): { bom: string; text: string } {
  if (text.charCodeAt(0) === 0xfeff) return { bom: "\ufeff", text: text.slice(1) };
  return { bom: "", text };
}

export function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, lineEnding: "\n" | "\r\n"): string {
  return lineEnding === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function normalizeForSnapshot(text: string): string {
  const { text: withoutBom } = stripBom(text);
  return normalizeToLF(withoutBom).replace(/[ \t\r]+(?=\n|$)/g, "");
}

export function splitLogicalLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text.length === 0) return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  const raw = text.split("\n");
  if (trailingNewline) raw.pop();
  return { lines: raw, trailingNewline };
}

export function joinLogicalLines(lines: string[], trailingNewline: boolean): string {
  const body = lines.join("\n");
  return trailingNewline ? `${body}\n` : body;
}

export function assertTextLike(path: string, text: string): void {
  if (text.includes("\u0000")) {
    throw new Error(`Refusing binary-looking file: ${path}`);
  }
}
