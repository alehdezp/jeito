import {
  renderReadCall, renderReadResult,
  renderEditCall, renderEditResult,
  renderWriteCall, renderWriteResult,
  renderFindCall, renderFindResult,
  renderLsCall, renderLsResult,
  renderGrepCall, renderGrepResult,
  renderExploreCall, renderExploreResult,
  renderTraceCall, renderTraceResult,
  renderDocsSearchCall, renderDocsSearchResult,
  renderDiffCall, renderDiffResult,
  renderLspValidateCall, renderLspValidateResult,
  resetDisplayDensityForTests,
  cycleDensity,
} from "../extensions/codeweave-pi/src/core/tui-render.ts";
import {
  renderWebSearchCall, renderWebSearchResult,
  renderWebSearchExaCall, renderWebSearchExaResult,
  renderWebSearchXCall, renderWebSearchXResult,
  renderWebSearchTavilyCall, renderWebSearchTavilyResult,
  renderWebFetchCall, renderWebFetchResult,
  renderWebLookupCall, renderWebLookupResult,
  renderContext7Call, renderContext7Result,
  renderWebAnswerCall, renderWebAnswerResult,
  renderWebAnswerExaCall, renderWebAnswerExaResult,
  renderWebAnswerLinkupCall, renderWebAnswerLinkupResult,
} from "../extensions/websift/src/ui/tui-render.ts";
import { renderToolsCall, renderToolsResult } from "../extensions/tooltap/extensions/index.ts";
import { __jeitoShellUi as shellUi } from "../extensions/shell/index.ts";

export const DENSITIES = ["ultra", "condensed", "normal", "extended"];
export const DENSITY_BUDGETS = { ultra: 1, condensed: 8, normal: 30, extended: 120 };
export const GALLERY_WIDTHS = [56, 88, 120];

const VISUAL_COLORS = {
  toolTitle: "\x1b[38;2;205;214;244m",
  accent: "\x1b[38;2;137;220;235m",
  success: "\x1b[38;2;166;227;161m",
  warning: "\x1b[38;2;249;226;175m",
  error: "\x1b[38;2;243;139;168m",
  muted: "\x1b[38;2;139;148;158m",
  toolOutput: "\x1b[38;2;205;214;244m",
};
export const VISUAL_THEME = {
  fg: (style, text) => `${VISUAL_COLORS[style] ?? ""}${text}\x1b[0m`,
  bold: text => `\x1b[1m${text}\x1b[22m`,
};

export const ROLE_CODES = {
  toolTitle: "\x1b[38;5;81m",
  accent: "\x1b[38;5;213m",
  success: "\x1b[38;5;114m",
  warning: "\x1b[38;5;221m",
  error: "\x1b[38;5;203m",
  muted: "\x1b[38;5;245m",
  toolOutput: "\x1b[38;5;252m",
};
export const ROLE_THEME = {
  fg: (style, text) => `${ROLE_CODES[style] ?? ""}${text}\x1b[0m`,
  bold: text => `\x1b[1m${text}\x1b[22m`,
};

const textResult = (text, details = {}, isError = false) => ({
  content: [{ type: "text", text }],
  details,
  ...(isError ? { isError: true } : {}),
});
const failureResult = tool => textResult(`ERROR: ${tool} could not reach the requested target.\nReason: permission denied.`, { envelope: { status: "error", summary: `${tool} failed`, artifacts: [] }, failureClass: "permission_denied", provider: "demo" }, true);
function overflowResult(tool) {
  const rows = Array.from({ length: 48 }, (_, index) => `${index + 1}. ${tool} evidence row ${index + 1}${index === 45 ? " warning: inspect this boundary" : ""}`);
  if (tool === "read") return textResult(`[src/auth/session.ts#A1B2C3D4]\n${rows.map((row, index) => `${index + 1}:${row}`).join("\n")}`);
  if (tool === "edit") return textResult(`[src/auth/session.ts#B2C3D4E5]\nEdited src/auth/session.ts: 1 hunk, first changed line 10.\n\n10:const session = rotate(token);\n\nDiff: first changed region only.\n-9:const session = verify(token);\n+9:const session = rotate(token);\n${rows.slice(0, 46).map((row, index) => ` ${index + 10}:${row}`).join("\n")}`);
  if (tool === "write") return textResult(`[src/auth/policy.ts#C3D4E5F6]\nCreated src/auth/policy.ts (48 lines).\n\n${rows.map((_, index) => `${index + 1}:export const value${index + 1} = ${index + 1};`).join("\n")}`);
  if (tool === "find") return textResult(`Path search\nScope: src\nPattern: **/*.ts\n# Glob: "**/*.ts" in /workspace/demo/src — 48 files\n\nProject files\n${rows.map((_, index) => `  src/module-${index + 1}.ts`).join("\n")}`);
  if (tool === "ls") return textResult("# Directory: /workspace/demo/src", { native: { completeness: { complete: true, returned: 48 }, data: { entries: rows.map((_, index) => ({ path: `src/module-${index + 1}.ts`, kind: "file", depth: 1, tokenEstimate: 20 + index })) } } });
  if (tool === "grep") return textResult("# Search: refreshSession", { envelope: { status: "success", artifacts: ["[src/auth/session.ts#A1B2C3D4]"] }, native: { completeness: { returned: 48, total: 48, complete: true }, data: { kind: "symbol", case: "sensitive", totalFound: 48, definitions: 1, usages: 47, facetTotals: { definitions: 1, implementations: 0, tests: 0 }, matches: rows.map((_, index) => ({ role: index ? "usage" : "definition", symbol: "refreshSession", location: { path: `src/module-${index + 1}.ts`, start: index + 1, end: index + 1 } })), sourceRows: rows.map((_, index) => ({ path: `src/module-${index + 1}.ts`, line: index + 1, text: `refreshSession(token${index + 1});` })) } } });
  if (tool === "diff") return textResult(`diff --git a/src/auth/session.ts b/src/auth/session.ts\n@@ -1,0 +1,48 @@\n${rows.map((_, index) => `+export const value${index + 1} = ${index + 1};`).join("\n")}`);
  if (tool === "lsp_validate") return textResult("48 diagnostics in 48 files", { files: rows.map((_, index) => ({ path: `src/module-${index + 1}.ts`, status: "diagnostics", diagnostics: [{ message: `Type mismatch ${index + 1}`, source: "typescript", code: "2322", range: { start: { line: index, character: 0 } } }] })) });
  if (tool === "web_lookup" || tool === "context7") return textResult(rows.join("\n"), { provider: tool === "context7" ? "context7" : "pi-packages", records: rows.map((_, index) => ({ name: `record-${index + 1}`, content: `catalog evidence ${index + 1}` })) });
  if (tool === "web_fetch") return textResult(rows.join("\n"), { provider: "webclaw", sources: rows.map((_, index) => ({ url: `https://example.com/page-${index + 1}`, status: "fetched", fetched: true })) });
  if (tool.startsWith("web_answer")) return textResult(rows.join("\n"), { provider: tool.endsWith("linkup") ? "linkup" : "exa", answer: "overflow answer", sources: rows.map((_, index) => ({ url: `https://example.com/source-${index + 1}` })) });
  return textResult(rows.join("\n"), { envelope: { status: "success", summary: `${tool} returned 48 rows`, artifacts: [] }, resultCount: 48, results: rows.map((_, index) => ({ title: `result ${index + 1}` })) });
}

const codeweavePiCases = [
  ["read", renderReadCall, renderReadResult, { path: "src/auth/session.ts:10-18" }, textResult("[src/auth/session.ts#A1B2C3D4]\n10:export function refreshSession(token: string) {\n11:  return verify(token);\n12:}\n13:\n14:export const SESSION_TTL = 3600;")],
  ["edit", renderEditCall, renderEditResult, { input: "[src/auth/session.ts#A1B2C3D4]\nREPLACE 11:\n+  return verifyAndRotate(token);" }, textResult("[src/auth/session.ts#B2C3D4E5]\nEdited src/auth/session.ts: 1 hunk, first changed line 11.\n\n11:  return verifyAndRotate(token);\n\nDiff: first changed region only.\n-11:  return verify(token);\n+11:  return verifyAndRotate(token);")],
  ["write", renderWriteCall, renderWriteResult, { path: "src/auth/policy.ts", content: "export const policy = {\n  rotate: true,\n};" }, textResult("[src/auth/policy.ts#C3D4E5F6]\nCreated src/auth/policy.ts (3 lines).\n\n1:export const policy = {\n2:  rotate: true,\n3:};")],
  ["find", renderFindCall, renderFindResult, { pattern: "**/*auth*.ts", scope: "src" }, textResult("Path search\nScope: src\nPattern: **/*auth*.ts\n# Glob: \"**/*auth*.ts\" in /workspace/demo/src — 2 files\n\nProject files\n  src/auth/session.ts\n  src/auth/policy.ts")],
  ["ls", renderLsCall, renderLsResult, { path: "src/auth", view: "tree", depth: 2 }, textResult("# Directory: /workspace/demo/src/auth", { native: { completeness: { complete: true, returned: 4 }, data: { entries: [{ path: "policy.ts", kind: "file", depth: 1, tokenEstimate: 14 }, { path: "session.ts", kind: "file", depth: 1, tokenEstimate: 38 }, { path: "tests", kind: "directory", depth: 1, tokenEstimate: 0 }, { path: "tests/session.test.ts", kind: "file", depth: 2, tokenEstimate: 31 }] } } })],
  ["grep", renderGrepCall, renderGrepResult, { pattern: "refreshSession", paths: "src", output: "ranked", syntax: "symbol" }, textResult("# Search: refreshSession", { envelope: { status: "success", artifacts: ["[src/auth/session.ts#A1B2C3D4]", "[src/auth/middleware.ts#B2C3D4E5]"] }, native: { completeness: { returned: 2, total: 2, complete: true }, data: { kind: "symbol", case: "sensitive", totalFound: 2, definitions: 1, usages: 1, facetTotals: { definitions: 1, implementations: 0, tests: 0 }, matches: [{ role: "definition", symbol: "refreshSession", location: { path: "src/auth/session.ts", start: 10, end: 12 } }, { role: "usage", symbol: "refreshSession", location: { path: "src/auth/middleware.ts", start: 42, end: 42 } }], sourceRows: [{ path: "src/auth/session.ts", line: 10, text: "export function refreshSession(token: string) {" }, { path: "src/auth/middleware.ts", line: 42, text: "return refreshSession(request.token);" }] } } })],
  ["explore", renderExploreCall, renderExploreResult, { view: "code", operation: "search", anchor: "session refresh ownership" }, textResult("Code search: session refresh ownership\n1. refreshSession · function · src/auth/session.ts:10-12\n2. AuthMiddleware · class · src/auth/middleware.ts:30-55\n\nBest owner: refreshSession")],
  ["trace", renderTraceCall, renderTraceResult, { target: "src/auth/session.ts::refreshSession", relation: "callers" }, textResult("Callers of refreshSession\n1. AuthMiddleware.handle · src/auth/middleware.ts:42\n2. refreshRoute · src/api/refresh.ts:18\n\n2 callers")],
  ["docs_search", renderDocsSearchCall, renderDocsSearchResult, { query: "how session refresh ownership works", scope: "auth" }, textResult("1. Session refresh ownership\n   docs/auth.md:40-62\n   Selector: docs/auth.md::session-refresh-ownership#2\n   Rotate tokens only after verification.\n\n2. Failure handling\n   docs/auth.md:64-78")],
  ["diff", renderDiffCall, renderDiffResult, { source: "uncommitted", view: "patch", scope: "src/auth" }, textResult("diff --git a/src/auth/session.ts b/src/auth/session.ts\n@@ -10,3 +10,3 @@\n export function refreshSession(token: string) {\n-  return verify(token);\n+  return verifyAndRotate(token);\n }")],
  ["lsp_validate", renderLspValidateCall, renderLspValidateResult, { paths: ["src/auth/session.ts", "src/auth/policy.ts"], includeWarnings: true }, textResult("1 diagnostic in 2 files", { files: [
    { path: "src/auth/session.ts", status: "clean", diagnostics: [] },
    { path: "src/auth/policy.ts", status: "diagnostics", diagnostics: [{ message: "Property 'ttl' is missing", source: "typescript", code: "2741", range: { start: { line: 1, character: 2 } } }] },
  ] })],
].map(([tool, call, result, args, success]) => ({ family: "codeweave-pi", tool, call, result, args, success }));

const searchDetails = provider => ({ provider, resultCount: 3, results: [{ title: "Official guide" }, { title: "Reference" }, { title: "Issue discussion" }], sources: [{ url: "https://example.com/guide" }, { url: "https://example.com/reference" }, { url: "https://example.com/issues/42" }] });
const websiftCases = [
  ["web_search", renderWebSearchCall, renderWebSearchResult, { query: "Pi extension renderer lifecycle", freshness: "month" }, textResult("1. Official extension guide — example.com\n2. Renderer reference — example.com\n3. Tool lifecycle issue — example.com", searchDetails("serper"))],
  ["web_search_exa", renderWebSearchExaCall, renderWebSearchExaResult, { query: "terminal UI progressive disclosure", searchType: "neural" }, textResult("1. Progressive disclosure patterns\n2. Terminal hierarchy study\n3. Compact status design", { ...searchDetails("exa"), reportedCostUsd: 0.0042 })],
  ["web_search_x", renderWebSearchXCall, renderWebSearchXResult, { query: "terminal UI release announcement", fromDate: "2026-08-01" }, textResult("@project: New compact terminal cards released.\n@maintainer: Design notes and migration details.", { ...searchDetails("xsearch"), results: [{ xsearch: true }, {}, {}] })],
  ["web_search_tavily", renderWebSearchTavilyCall, renderWebSearchTavilyResult, { query: "terminal interface accessibility", country: "united states" }, textResult("1. Terminal accessibility guide\n2. ANSI color contrast notes\n3. Screen-reader terminal patterns", searchDetails("tavily"))],
  ["web_fetch", renderWebFetchCall, renderWebFetchResult, { urls: ["https://example.com/guide", "https://example.com/reference"], mode: "page", objective: "inspect renderer lifecycle" }, textResult("Fetched two references.", { provider: "webclaw", cache: [
    { url: "https://example.com/guide", status: "fresh", path: ".cache/web/guide.md", estimatedTokens: 1280 },
    { url: "https://example.com/reference", status: "cache_hit", path: ".cache/web/reference.md", estimatedTokens: 860 },
  ], sources: [{ url: "https://example.com/guide", fetched: true }, { url: "https://example.com/reference", fetched: true }] })],
  ["web_lookup", renderWebLookupCall, renderWebLookupResult, { source: "pi-packages", query: "terminal ui" }, textResult("1. pi-tool-display — compact tool cards\n2. pi-tui-kit — terminal components", { provider: "pi-packages", records: [{ name: "pi-tool-display", content: "README" }, { name: "pi-tui-kit", content: "README" }] })],
  ["context7", renderContext7Call, renderContext7Result, { library: "zod", query: "string email validation", version: "3.22" }, textResult("Zod string schemas support email validation with z.string().email().\n\nCache: .cache/web/docs/zod.md", { provider: "context7", docsPath: ".cache/web/docs/zod.md", records: [{ title: "Zod strings", content: "email validation" }], sources: [{ url: "context7:/colinhacks/zod", fetched: true }] })],
  ["web_answer", renderWebAnswerCall, renderWebAnswerResult, { question: "How does progressive disclosure help terminal tool output?" }, textResult("Progressive disclosure keeps status scannable while preserving details on demand.\n\nSources: [1] Interface guide [2] Terminal study", { provider: "exa", model: "answer-v2", sources: [{ url: "https://example.com/guide" }, { url: "https://example.com/study" }] })],
  ["web_answer_exa", renderWebAnswerExaCall, renderWebAnswerExaResult, { question: "Which component owns tool rendering?" }, textResult("ToolExecutionComponent owns the call/result shell and renderer state.\n\nSource: official SDK", { provider: "exa", reportedCostUsd: 0.0031, sources: [{ url: "https://example.com/sdk" }] })],
  ["web_answer_linkup", renderWebAnswerLinkupCall, renderWebAnswerLinkupResult, { question: "Can a custom entry be kept out of model context?", includeDomains: ["example.com"] }, textResult("Yes. A custom entry renderer can present durable UI without adding a model message.\n\nSource: official extensions guide", { provider: "linkup", sources: [{ url: "https://example.com/extensions" }] })],
].map(([tool, call, result, args, success]) => ({ family: "web", tool, call, result, args, success }));

const shellCases = [
  { family: "shell", tool: "bash", call: shellUi.renderBashCall, result: shellUi.renderBashResult, args: { command: "npm test -- --runInBand" }, success: textResult("bash | tests/auth.test.ts passed\n18 tests passed\nDuration 1.4s", { bodyId: "bash", exitCode: 0, outputLines: 3, compressed: true }), failure: textResult("bash | EXIT 1\nERROR auth.test.ts: expected rotated token\n1 test failed", { bodyId: "bash", exitCode: 1, outputLines: 2, compressed: true }, true) },
  { family: "shell", tool: "jobs", call: shellUi.renderJobsCall, result: shellUi.renderJobsResult, args: { id: "job-7", wait: 30, delta: true }, success: textResult("job-7 [completed] 12s — sh-4 • 3 output lines\n\nchecking types\n18 tests passed\nbuild complete", { jobId: "job-7", status: "completed", exitCode: 0 }), failure: textResult("job-7 [failed] 8s — sh-4 • 2 output lines\n\nERROR type check failed\n1 error", { jobId: "job-7", status: "failed", exitCode: 1 }, true), overflow: textResult(`job-7 [completed] 2m14s — sh-4 • 48 output lines\n\n${Array.from({ length: 48 }, (_, index) => `progress ${index + 1}/48`).join("\n")}`, { jobId: "job-7", status: "completed", exitCode: 0 }) },
];

const tooltapCases = [{
  family: "tooltap", tool: "tools", call: renderToolsCall, result: renderToolsResult,
  args: { request: "context7" },
  success: textResult("Enabled context7. Call it directly on your next turn.", { enabled: ["context7"] }),
  failure: textResult("Could not enable context7: source is not trusted.", { activationFailed: ["context7"] }, true),
  overflow: textResult(Array.from({ length: 48 }, (_, index) => `Enabled deferred tool ${index + 1}.`).join("\n"), { enabled: Array.from({ length: 48 }, (_, index) => `tool-${index + 1}`) }),
}];

const completionCases = [{
  family: "shell", tool: "job-done", direct: true,
  scenarios: {
    success: { jobId: "job-7", bodyId: "sh-4", status: "completed", elapsed: "12s", outputLines: 8, compressed: true, preview: "checking types\n18 tests passed\nbuild complete" },
    failure: { jobId: "job-7", bodyId: "sh-4", status: "failed", elapsed: "8s", outputLines: 4, exitCode: 1, compressed: true, preview: "checking types\nERROR type check failed\n1 error\nbuild stopped" },
    overflow: { jobId: "job-7", bodyId: "sh-4", status: "completed", elapsed: "2m14s", outputLines: 48, compressed: true, preview: Array.from({ length: 48 }, (_, index) => `progress ${index + 1}/48`).join("\n") },
  },
}];

export const TOOL_CASES = [...codeweavePiCases, ...shellCases, ...tooltapCases, ...websiftCases, ...completionCases];
export const EXPECTED_TOOLS = [
  "read", "edit", "write", "find", "ls", "grep", "explore", "trace", "docs_search", "diff", "lsp_validate",
  "bash", "jobs", "job-done", "tools",
  "web_search", "web_search_exa", "web_search_x", "web_search_tavily", "web_fetch", "web_lookup", "context7", "web_answer", "web_answer_exa", "web_answer_linkup",
];
export const SCENARIOS = ["pending", "success", "failure", "overflow"];

export function setDensity(density) {
  const level = DENSITIES.indexOf(density);
  if (level < 0) throw new Error(`Unknown density ${density}`);
  resetDisplayDensityForTests();
  for (let index = 0; index < level; index++) cycleDensity();
}

function argsForScenario(item, scenario) {
  if (scenario !== "overflow") return item.args;
  if (item.tool === "read") return { path: "src/auth/session.ts" };
  if (item.tool === "write") return { path: "src/auth/policy.ts", content: Array.from({ length: 48 }, (_, index) => `export const value${index + 1} = ${index + 1};`).join("\n") };
  return item.args;
}
export function renderCatalogCase(item, scenario, density, width = 88, theme = VISUAL_THEME) {
  setDensity(density);
  if (item.direct) {
    if (scenario === "pending") return [];
    const data = item.scenarios[scenario] ?? item.scenarios.success;
    return shellUi.renderJobDoneEntry({ data }, { expanded: false }, theme).render(width);
  }
  const context = { width, cwd: "/workspace/demo", state: {} };
  const card = item.call(argsForScenario(item, scenario), theme, context);
  if (scenario !== "pending") {
    const result = scenario === "success" ? item.success : scenario === "failure" ? (item.failure ?? failureResult(item.tool)) : (item.overflow ?? overflowResult(item.tool));
    const resultBlock = item.result(result, { expanded: false, width }, theme, context);
    resultBlock?.render?.(width);
  }
  return card.render(width);
}

export function scenarioAvailable(item, scenario) {
  return !item.direct || scenario !== "pending";
}
