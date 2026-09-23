import { isMap, isScalar, isSeq, parseAllDocuments, type Node } from "yaml";
import { normalizeToLF, stripBom } from "./text-normalize.ts";

/** Syntactic key paths only: never resolve aliases, merge mappings or grant source authority. */
export function structuredMatchContext(source: string, extension: string, rows: Array<{
  line: number; text: string; spans: Array<{ startByte: number; endByte: number }>;
}>): Array<{ line: number; path: string }> {
  if (![".yaml", ".yml", ".json"].includes(extension.toLowerCase())) return [];
  const text = normalizeToLF(stripBom(source).text);
  try {
    // YAML can read JSON ranges, but must not silently accept YAML syntax in a JSON file.
    if (extension.toLowerCase() === ".json") JSON.parse(text);
    const documents = parseAllDocuments(text, { uniqueKeys: false, prettyErrors: false, logLevel: "silent" });
    if (documents.some(document => document.errors.length)) return [];
    const lines = text.split("\n");
    const starts: number[] = [];
    let offset = 0;
    for (const line of lines) { starts.push(offset); offset += line.length + 1; }
    const hits: Array<{ line: number; start: number; end: number; path: string }> = [];
    for (const row of rows) {
      if (lines[row.line - 1] !== row.text) continue;
      const bytes = Buffer.from(row.text, "utf8");
      for (const span of row.spans) {
        if (!Number.isSafeInteger(span.startByte) || !Number.isSafeInteger(span.endByte)
          || span.startByte < 0 || span.endByte < span.startByte || span.endByte > bytes.length) continue;
        const before = bytes.subarray(0, span.startByte).toString("utf8");
        const through = bytes.subarray(0, span.endByte).toString("utf8");
        if (Buffer.byteLength(before) !== span.startByte || Buffer.byteLength(through) !== span.endByte) continue;
        hits.push({ line: row.line, start: starts[row.line - 1]! + before.length,
          end: starts[row.line - 1]! + through.length, path: "" });
      }
    }
    const keyPath = (parent: string, key: string) => /^[A-Za-z_$][\w$]*$/.test(key)
      ? `${parent}${parent ? "." : ""}${key}` : `${parent}[${JSON.stringify(key)}]`;
    const visit = (node: Node | null, path: string, start = node?.range?.[0], end = node?.range?.[1], depth = 0) => {
      // Bound the optional walk; deeper matches retain their containing key's context.
      if (depth > 64 || start === undefined || end === undefined) return;
      const selected = hits.filter(hit => hit.start >= start && hit.end <= end && hit.start < end);
      if (!selected.length) return;
      for (const hit of selected) hit.path = path;
      if (isMap<Node, Node | null>(node)) {
        for (const pair of node.items) {
          if (!isScalar(pair.key) || !pair.key.range || pair.key.value === null
            || !["string", "number", "boolean"].includes(typeof pair.key.value)) continue;
          visit(pair.value, keyPath(path, String(pair.key.value)), pair.key.range[0],
            pair.value?.range?.[1] ?? pair.key.range[1], depth + 1);
        }
      } else if (isSeq<Node | null>(node)) {
        node.items.forEach((item, index) => visit(item, `${path}[${index}]`, undefined, undefined, depth + 1));
      }
    };
    documents.forEach((document, index) => visit(document.contents, documents.length > 1 ? `document[${index + 1}]` : ""));
    const seen = new Set<string>();
    return hits.flatMap(hit => {
      const key = `${hit.line}:${hit.path}`;
      if (!hit.path || seen.has(key)) return [];
      seen.add(key);
      return [{ line: hit.line, path: hit.path }];
    });
  } catch {
    // Context is optional. Malformed/unsupported structure must not discard text matches.
    return [];
  }
}
