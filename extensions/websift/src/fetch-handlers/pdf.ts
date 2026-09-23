// Ported-at: 7bdc30a65cf7 from pi-web-access@0.13.0 pdf-extract.ts — see docs/upstreams/pi-web-access.md.
// Divergence: returns the markdown content directly instead of writing a file to ~/Downloads,
// because a fetch handler yields content to the model, not a saved artifact.
import { ProviderError } from "../failures.ts";
import type { FetchedContent } from "../types.ts";

const DEFAULT_MAX_PAGES = 100;

export function isPDF(url: string, contentType?: string): boolean {
  if (contentType?.includes("application/pdf")) return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function titleFromURL(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    let filename = pathname.split("/").pop()?.replace(/\.pdf$/i, "") ?? "";
    if (urlObj.hostname.includes("arxiv.org")) {
      const match = pathname.match(/\/(?:pdf|abs)\/(\d+\.\d+)/);
      if (match) filename = `arxiv-${match[1]}`;
    }
    filename = filename.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    return filename || "document";
  } catch {
    return "document";
  }
}

export async function extractPdf(bytes: Uint8Array, url: string, maxPages = DEFAULT_MAX_PAGES): Promise<FetchedContent> {
  // Lazy: unpdf is an optional dependency, so a missing install degrades PDF only,
  // not the whole dispatch chain that imports this module.
  let getDocumentProxy: (data: Uint8Array) => Promise<{ numPages: number; getMetadata(): Promise<{ info?: unknown }>; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }> }>;
  try {
    ({ getDocumentProxy } = await import("unpdf"));
  } catch {
    throw new ProviderError("unavailable", "PDF extraction requires the optional 'unpdf' dependency (install it to enable PDF fetch)");
  }
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(bytes);
  } catch (error) {
    throw new ProviderError("empty", `Could not parse PDF: ${error instanceof Error ? error.message : String(error)}`);
  }
  const metadata = await pdf.getMetadata();
  const info = metadata.info && typeof metadata.info === "object" ? (metadata.info as Record<string, unknown>) : null;
  const metaTitle = typeof info?.Title === "string" ? info.Title.trim() : "";
  const metaAuthor = typeof info?.Author === "string" ? info.Author.trim() : "";
  const title = metaTitle || titleFromURL(url);

  const safeMaxPages = Number.isFinite(maxPages) ? Math.max(1, Math.floor(maxPages)) : DEFAULT_MAX_PAGES;
  const pagesToExtract = Math.min(pdf.numPages, safeMaxPages);
  const truncated = pdf.numPages > safeMaxPages;

  const pages: { pageNum: number; text: string }[] = [];
  for (let i = 1; i <= pagesToExtract; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: unknown) => (item as { str?: string }).str || "").join(" ").replace(/\s+/g, " ").trim();
    if (pageText) pages.push({ pageNum: i, text: pageText });
  }
  if (!pages.length) throw new ProviderError("empty", "PDF contained no extractable text");

  const lines: string[] = [`# ${title}`, "", `> Source: ${url}`, `> Pages: ${pdf.numPages}${truncated ? ` (extracted first ${pagesToExtract})` : ""}`];
  if (metaAuthor) lines.push(`> Author: ${metaAuthor}`);
  lines.push("", "---", "");
  for (let i = 0; i < pages.length; i++) {
    if (i > 0) lines.push("", `<!-- Page ${pages[i].pageNum} -->`, "");
    lines.push(pages[i].text);
  }
  if (truncated) lines.push("", "---", "", `*[Truncated: only first ${pagesToExtract} of ${pdf.numPages} pages extracted]*`);

  return { url, title, content: lines.join("\n"), contentType: "application/pdf" };
}