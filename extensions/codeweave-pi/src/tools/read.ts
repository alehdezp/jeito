import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMarkdownFrontmatterExposureState, MARKDOWN_FRONTMATTER_BUDGET, type MarkdownFrontmatterExposureState } from "../core/markdown-frontmatter.ts";
import { renderRead, renderReadBatch } from "../core/read-renderer.ts";
import { S } from "../core/schema.ts";
import { renderReadCall, renderReadResult } from "../core/tui-render.ts";
import { asToolCallValidationError, invalidToolCallResult } from "../core/tool-call-contract.ts";

const PATH_DESCRIPTION = "One file, with selectors after it:\n- :20-40 a line range · :20+10 ten lines · :20- to the end · :raw the whole file;\n- ::name a function or class · a heading like ::setup/install reads that section · #2 picks the 2nd same-named section;\n- comma-separated chunks combine distant regions of the same file in one call.\n\nTo read a Markdown section, the selector is the heading lowercased with words joined by '-', punctuation dropped, prefixed by its parent headings joined by '/', ending in #LEVEL where LEVEL is the heading depth (# = 1, ## = 2, ### = 3). So '## The plan proposed, not yet executed' under '# The plan' is ::the-plan/the-plan-proposed-not-yet-executed#2.\n\nImages come back as the picture. Large files return a map of the file with block anchors — follow the named range instead of re-reading.";

// DeepSeek requires function parameters to have a top-level object schema.
// Keep the path/paths exclusivity check in validateReadRequest() so providers
// that reject a root-level anyOf can still receive this tool definition.
export const readParams = {
  type: "object",
  properties: {
    path: S.string(PATH_DESCRIPTION),
    paths: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", maxLength: 4096 },
      description: "Up to 8 files in one call, each keeping its own result and errors. The comma form is the shortcut: 'a.ts:1-10,b.ts:2-8' packs several into one string and is expanded for you.",
    },
  },
  additionalProperties: false,
  description: "Read one known file with path, or an ordered batch with paths. Both may be supplied and are merged into one batch.",
};

export function registerReadTool(pi: ExtensionAPI, frontmatterExposureState: MarkdownFrontmatterExposureState = createMarkdownFrontmatterExposureState()): void {
  pi.registerTool({
    name: "read",
    label: "read",
    renderShell: "self",
    description: "Read files, named code symbols, Markdown sections, and images, with numbered lines and a hash that makes the text edit-ready — cat, plus selectors that read multiple precise parts at once. Use it for exactly the parts of files you need to see. One call can carry several selectors at once: read({paths:['docs/harness-doctrine.md::navigation-harness-doctrine/evidence-capabilities-not-routes#2','src/tools/read.ts::splitMultiFilePaths,96-106']}) reads one doc section, plus one function and a line range, in a single call.",
    promptGuidelines: ["Combine several selectors of one file in a single call when the parts answer one question, and batch several files in one call when none of them changes what to read next — read one at a time when each read decides the next. docs_search returns the exact section selector; copy it instead of hand-building the slug."],
    parameters: readParams,
    renderCall: renderReadCall,
    renderResult: renderReadResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let request: { path?: string; paths?: string[] };
      try {
        request = validateReadRequest(params);
      } catch (error) {
        return invalidToolCallResult("read", asToolCallValidationError(error, { accepted: ["{path:'src/file.ts:20-40'}", "{paths:['src/a.ts','src/b.ts:10-20']}"], guidance: ["Supply path and/or paths."], received: params }));
      }
      if (request.path !== undefined) {
        const result = await renderRead({ cwd: ctx.cwd, path: request.path, signal, frontmatterExposureState, frontmatterMaxBytes: MARKDOWN_FRONTMATTER_BUDGET });
        const content = result.image ? { type: "image" as const, data: result.image.data, mimeType: result.image.mimeType } : { type: "text" as const, text: result.text };
        return { content: [content], details: { tag: result.tag, path: result.displayPath, intervals: result.intervals } };
      }
      const result = await renderReadBatch({ cwd: ctx.cwd, paths: request.paths!, signal, frontmatterExposureState, frontmatterMaxBytes: MARKDOWN_FRONTMATTER_BUDGET });
      return { content: [{ type: "text", text: result.text }], details: { files: result.files, counts: result.counts, complete: result.complete } };
    },
  });
}

function validateReadRequest(params: unknown): { path?: string; paths?: string[] } {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Read refused: parameters must be an object with path and/or paths.");
  const value = params as Record<string, unknown>;
  const unknown = Object.keys(value).filter(key => key !== "path" && key !== "paths");
  if (unknown.length) throw new Error(`Read refused: unknown parameter${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  const hasPath = Object.prototype.hasOwnProperty.call(value, "path");
  const hasPaths = Object.prototype.hasOwnProperty.call(value, "paths");
  if (!hasPath && !hasPaths) throw new Error("Read refused: supply path and/or paths.");

  // Collect all non-empty trimmed path strings from whichever parameter(s) are present.
  const items: string[] = [];
  if (hasPath) {
    if (typeof value.path !== "string") throw new Error("Read refused: path must be a string.");
    const trimmed = value.path.trim();
    if (trimmed.length > 4096) throw new Error("Read refused: path exceeds 4096 characters.");
    if (trimmed) items.push(trimmed);
  }
  if (hasPaths) {
    if (!Array.isArray(value.paths)) throw new Error("Read refused: paths must be an array of strings.");
    for (let i = 0; i < value.paths.length; i++) {
      if (!(i in value.paths) || typeof value.paths[i] !== "string") throw new Error(`Read refused: paths[${i}] must be a string.`);
      const trimmed = (value.paths[i] as string).trim();
      if (trimmed.length > 4096) throw new Error(`Read refused: paths[${i}] exceeds 4096 characters.`);
      if (trimmed) items.push(trimmed); // ponytail: silently skip empty/whitespace-only entries
    }
  }
  if (items.length === 0) throw new Error("Read refused: no non-empty path supplied.");

  // Expand comma-packed multi-file entries (agents pack "a.md:sel,b.md:sel" into one string).
  const expanded: string[] = [];
  for (const item of items) {
    const split = splitMultiFilePaths(item);
    if (split) expanded.push(...split);
    else expanded.push(item);
  }
  if (expanded.length > 8) throw new Error(`Read refused: ${expanded.length} paths exceed the 8-item batch limit. Split into multiple calls.`);
  if (expanded.length === 1) return { path: expanded[0] };
  return { paths: expanded };
}


// ponytail: agents pack multiple file:selector entries into one string, or into both path and
// paths at once. A comma-separated segment whose file-part (before the first colon) ends with a
// dot-extension is a distinct file — bare range/section chunks (220-260, section/x#2) never match.
// Applied to every collected item so merged path+paths inputs also expand correctly.
function splitMultiFilePaths(raw: string): string[] | undefined {
  const segments = raw.split(",").map(s => s.trim()).filter(s => s.length > 0);
  if (segments.length < 2 || segments.length > 8) return undefined;
  const fileLike = segments.filter(s => /\.\w{1,10}$/.test(s.split(":")[0] ?? ""));
  return fileLike.length >= 2 ? segments : undefined;
}
