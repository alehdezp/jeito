import { basename } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";

// Goal/skill files are first-party Markdown too. Do not exclude .pi or .agents.
const DEPENDENCY_PATH = /(?:^|[/\\])(?:node_modules|vendor|site-packages|\.runtime|\.venv|\.git)(?:[/\\]|$)/;

export function isUpdatedFieldEligiblePath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path) && !DEPENDENCY_PATH.test(path)
    && !/\.upstream\.md$/i.test(basename(path))
    && !/[/\\]native[/\\](?:qmd[/\\]test[/\\]eval-docs|pi-nav[/\\](?:benchmark|prompts))[/\\]/.test(path);
}

export function formatUpdatedStamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 13)}Z`;
}

export interface MarkdownStamp {
  text: string;
  updatedLine: number;
  insertion?: { line: number; count: number };
}

/** Change only managed metadata, without serializing the rest of the YAML. */
export function stampUpdatedField(text: string, now: Date, create = false): MarkdownStamp {
  const stamp = JSON.stringify(formatUpdatedStamp(now));
  const date = now.toISOString().slice(0, 10);
  const bom = text.startsWith("\ufeff") ? "\ufeff" : "";
  const source = text.slice(bom.length);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const opening = /^---[ \t]*\r?\n/.exec(source);
  if (!opening) {
    const fields = [...(create ? [`created: ${date}`] : []), `updated: ${stamp}`];
    const prefix = ["---", ...fields, "---", ""].join(eol);
    return { text: bom + prefix + source, updatedLine: fields.length + 1, insertion: { line: 1, count: fields.length + 2 } };
  }

  const bodyStart = opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(source.slice(bodyStart));
  if (!closing) throw new Error("Markdown timestamp: unterminated YAML frontmatter; no file written.");
  const bodyEnd = bodyStart + closing.index;
  const body = source.slice(bodyStart, bodyEnd);
  const document = parseDocument(body);
  if (document.errors.length || (document.contents && (!isMap(document.contents) || document.contents.flow))) {
    throw new Error("Markdown timestamp: frontmatter must be a valid YAML block mapping with unique keys; no file written.");
  }
  const fields = isMap(document.contents) ? document.contents.items : [];
  const field = (name: string) => fields.find(pair => isScalar(pair.key) && pair.key.value === name);
  const updated = field("updated");
  let result = source;
  let updatedLine: number;
  if (updated) {
    const value = updated.value;
    if (!isScalar(value) || !value.range || value.anchor || value.tag
      || /[\r\n]/.test(body.slice(value.range[0], value.range[1]))) {
      throw new Error("Markdown timestamp: updated must be an untagged, single-line scalar; no file written.");
    }
    const [start, end] = value.range;
    // A null scalar after `updated:` may have no separating space, and a
    // zero-width range placed before a comment needs one after the stamp:
    // otherwise `updated: # managed` would land as `"stamp"# managed`.
    const before = start === end && body[start - 1] === ":" ? " " : "";
    const after = start === end && body[end] === "#" ? " " : "";
    result = source.slice(0, bodyStart + start) + before + stamp + after + source.slice(bodyStart + end);
    updatedLine = 2 + body.slice(0, start).split("\n").length - 1;
  } else {
    updatedLine = source.slice(0, bodyEnd).split("\n").length;
  }
  const additions = [...(create && !field("created") ? [`created: ${date}`] : []), ...(!updated ? [`updated: ${stamp}`] : [])];
  let insertion: MarkdownStamp["insertion"];
  if (additions.length) {
    // Replacement above cannot change line count, but can change byte offsets.
    const offset = bodyEnd + result.length - source.length;
    const line = source.slice(0, bodyEnd).split("\n").length;
    result = result.slice(0, offset) + additions.join(eol) + eol + result.slice(offset);
    insertion = { line, count: additions.length };
    if (!updated) updatedLine = line + additions.length - 1;
  }
  // Never land surgery the parser itself would reject: re-verify the new
  // frontmatter parses and `updated` holds the stamped string.
  const verifyClosing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(result.slice(bodyStart));
  const verifyBody = verifyClosing ? result.slice(bodyStart, bodyStart + verifyClosing.index) : "";
  const verifyDocument = parseDocument(verifyBody);
  const verifyUpdated = isMap(verifyDocument.contents)
    ? verifyDocument.contents.items.find(pair => isScalar(pair.key) && pair.key.value === "updated")?.value
    : undefined;
  if (!verifyClosing || verifyDocument.errors.length || !isScalar(verifyUpdated) || verifyUpdated.value !== formatUpdatedStamp(now)) {
    throw new Error("Markdown timestamp: stamped frontmatter failed verification; no file written.");
  }
  return { text: bom + result, updatedLine, insertion };
}
