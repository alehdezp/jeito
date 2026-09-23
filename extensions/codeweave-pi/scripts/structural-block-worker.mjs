#!/usr/bin/env node
import readline from "node:readline";
import { Parser, Language } from "web-tree-sitter";

await Parser.init();
const languages = new Map();
const cache = new Map();
let cacheBytes = 0;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

const grammarLoaders = {
  typescript: () => import("@lumis-sh/wasm-typescript").then(module => module.default),
  tsx: () => import("@lumis-sh/wasm-tsx").then(module => module.default),
  javascript: () => import("@lumis-sh/wasm-javascript").then(module => module.default),
  python: () => import("@lumis-sh/wasm-python").then(module => module.default),
  go: () => import("@lumis-sh/wasm-go").then(module => module.default),
  rust: () => import("@lumis-sh/wasm-rust").then(module => module.default),
  java: () => import("@lumis-sh/wasm-java").then(module => module.default),
  kotlin: () => import("@lumis-sh/wasm-kotlin").then(module => module.default),
  markdown: () => import("@lumis-sh/wasm-markdown").then(module => module.default),
};

const blockTypes = {
  typescript: new Map([["function_declaration", "function"], ["method_definition", "function"], ["class_declaration", "class"], ["interface_declaration", "class"], ["enum_declaration", "class"]]),
  tsx: new Map([["function_declaration", "function"], ["method_definition", "function"], ["class_declaration", "class"], ["interface_declaration", "class"], ["enum_declaration", "class"]]),
  javascript: new Map([["function_declaration", "function"], ["method_definition", "function"], ["class_declaration", "class"]]),
  python: new Map([["function_definition", "function"], ["class_definition", "class"]]),
  go: new Map([["function_declaration", "function"], ["method_declaration", "function"], ["type_declaration", "class"]]),
  rust: new Map([["function_item", "function"], ["impl_item", "class"], ["trait_item", "class"], ["struct_item", "class"], ["enum_item", "class"]]),
  java: new Map([["method_declaration", "function"], ["constructor_declaration", "function"], ["class_declaration", "class"], ["interface_declaration", "class"], ["enum_declaration", "class"]]),
  kotlin: new Map([["function_declaration", "function"], ["class_declaration", "class"], ["object_declaration", "class"]]),
  markdown: new Map([["section", "heading"]]),
};

async function languageFor(name) {
  if (languages.has(name)) return languages.get(name);
  const binary = await grammarLoaders[name]();
  const language = await Language.load(binary);
  languages.set(name, language);
  return language;
}

async function resolveBlocks(input) {
  const key = `${input.digest}:${input.language}:v1`;
  const cached = cache.get(key);
  if (cached) return { blocks: cached.blocks, cache: "hit", parseMs: 0 };
  const started = performance.now();
  const parser = new Parser();
  parser.setLanguage(await languageFor(input.language));
  const tree = parser.parse(input.text);
  const blocks = [];
  const types = blockTypes[input.language];
  const lines = input.text.split("\n");
  const visit = node => {
    const kind = types.get(node.type);
    if (kind) {
      const start = node.startPosition.row + 1;
      const end = Math.max(start, node.endPosition.column === 0 && node.endPosition.row > node.startPosition.row ? node.endPosition.row : node.endPosition.row + 1);
      if (end > start) blocks.push({ start, end, kind, label: labelFor(node, kind, lines), parser: "tree-sitter-wasm", grammar: input.language, grammarVersion: "0.26" });
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  tree.delete();
  parser.delete();
  const entry = { blocks: dedupe(blocks), bytes: Buffer.byteLength(input.text, "utf8") };
  cache.set(key, entry);
  cacheBytes += entry.bytes;
  while (cacheBytes > CACHE_MAX_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value;
    const removed = cache.get(oldest);
    cache.delete(oldest);
    cacheBytes -= removed?.bytes ?? 0;
  }
  return { blocks: entry.blocks, cache: "miss", parseMs: Math.round((performance.now() - started) * 1000) / 1000 };
}

async function resolveSyntax(input) {
  const started = performance.now();
  const parser = new Parser();
  parser.setLanguage(await languageFor(input.language));
  const tree = parser.parse(input.text);
  const diagnostics = [];
  const visit = node => {
    if (!node) return;
    if (diagnostics.length >= 10) return;
    if (node.type === "ERROR" || node.isMissing) diagnostics.push({
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endColumn: node.endPosition.column + 1,
      kind: node.isMissing ? "MISSING" : "ERROR",
      nodeType: node.type,
    });
    for (let index = 0; index < node.childCount && diagnostics.length < 10; index++) visit(node.child(index));
  };
  visit(tree.rootNode);
  tree.delete();
  parser.delete();
  return { diagnostics, parseMs: Math.round((performance.now() - started) * 1000) / 1000 };
}

function labelFor(node, kind, lines) {
  if (kind === "heading") return (lines[node.startPosition.row] ?? "heading").trim();
  const named = node.childForFieldName?.("name");
  const name = named?.text?.trim();
  return name ? `${kind} ${name}` : (lines[node.startPosition.row] ?? kind).trim().slice(0, 160);
}
function dedupe(blocks) {
  const map = new Map();
  for (const block of blocks) map.set(`${block.start}:${block.end}:${block.kind}:${block.label}`, block);
  return [...map.values()].sort((a, b) => a.start - b.start || b.end - a.end || a.label.localeCompare(b.label));
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  try {
    const result = message.input?.mode === "syntax" ? await resolveSyntax(message.input) : await resolveBlocks(message.input);
    process.stdout.write(`${JSON.stringify({ id: message.id, ok: true, ...result })}\n`);
  }
  catch (error) { process.stdout.write(`${JSON.stringify({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`); }
});
