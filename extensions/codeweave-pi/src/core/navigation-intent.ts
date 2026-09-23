export type NavigationIntentKind = "empty" | "known-path" | "filename" | "glob" | "exact-text" | "relationship" | "concept";

export interface NavigationIntent {
  kind: NavigationIntentKind;
  reason: string;
}

const RELATION_WORDS = /\b(callers?|callees?|called by|usages?|references?|depends?|dependencies|imports?|impact|blast radius|path between|explain relationship|trace)\b/i;
const QUESTION_START = /^(?:where|what|why|how|who|when|which|can|could|should|do|does|is|are)\b/i;
const EXACTISH = /(?:[A-Z0-9_]{3,}|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z_$][\w$]*\(|[A-Za-z0-9_.-]+\.[A-Za-z0-9]+|\/[A-Za-z0-9_./-]+)/;

export function classifyNavigationIntent(value: string | undefined): NavigationIntent {
  const text = String(value ?? "").trim();
  if (!text) return { kind: "empty", reason: "empty query" };
  if (looksGlobLike(text)) return { kind: "glob", reason: "glob-shaped pattern" };
  if (looksPathLike(text)) return { kind: "known-path", reason: "path-shaped query" };
  if (RELATION_WORDS.test(text)) return { kind: "relationship", reason: "relationship wording" };
  if (looksNaturalConcept(text)) return { kind: "concept", reason: "natural-language concept" };
  if (looksFilenameLike(text)) return { kind: "filename", reason: "filename/path fragment" };
  if (looksExactTextLike(text)) return { kind: "exact-text", reason: "exact text or symbol-like token" };
  return { kind: "concept", reason: "ambiguous phrase" };
}

export function noMatchRecoveryForIntent(value: string, scopeArg?: string): string {
  const intent = classifyNavigationIntent(value);
  const scoped = scopeArg && scopeArg !== "." ? `, scope:${JSON.stringify(scopeArg)}` : "";
  switch (intent.kind) {
    case "concept":
      return `This looks conceptual (${intent.reason}); use explore({ query:${JSON.stringify(value)}, view:"code"${scoped} }) or explore({ query:${JSON.stringify(value)}, view:"map"${scoped} }) rather than exact utilities.`;
    case "relationship":
      return `This looks like a relationship question (${intent.reason}); use trace with a known target, or explore first if the target is not known.`;
    case "filename":
    case "glob":
    case "known-path":
      return `This looks path-shaped (${intent.reason}); use read for known paths or exact utilities for filenames only.`;
    case "exact-text":
      return `This looks like exact text (${intent.reason}); exact utilities can inspect text, but they are not graph/docs navigation fallbacks.`;
    default:
      return "Use explore/context/trace/docs for navigation, and read for proof/edit authority.";
  }
}

function looksNaturalConcept(text: string): boolean {
  if (!/\s/.test(text)) return false;
  if (text.endsWith("?") || QUESTION_START.test(text)) return true;
  return /\b(how|where|why|what|understand|overview|architecture|design|flow|decide|implemented|works|setup|automatic|concept|explain)\b/i.test(text) && !/[{}*]/.test(text);
}

function looksExactTextLike(text: string): boolean {
  if (!/\s/.test(text)) return true;
  return EXACTISH.test(text);
}

function looksPathLike(text: string): boolean {
  return /(?:^|\/)\.?(?:src|lib|app|docs?|tests?|scripts?|packages?)\//i.test(text)
    || /^\.?\.?\//.test(text)
    || /\.[A-Za-z0-9]{1,8}(?::\d+)?$/.test(text);
}

function looksFilenameLike(text: string): boolean {
  return !/\s/.test(text) && /[./_-]/.test(text);
}

function looksGlobLike(text: string): boolean {
  return /[{}*]/.test(text) || (/\?/.test(text) && !/\s/.test(text) && /[/.?]/.test(text));
}
