// ADR-001.005 protects one coherent tool-local usage guideline per public websift tool; the remaining assertions preserve registration, evidence, and schema boundaries.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { decodeGeneric } from "@blackwell-systems/gcf";
import extension from "../index.ts";
import { AdapterRegistry } from "../src/registry.ts";
import { registerContext7 } from "../src/tools/context7-tool.ts";
import { registerWebLookup } from "../src/tools/web-lookup.ts";
import { Check } from "typebox/value";
import { createContext7Adapter } from "../src/adapters/context7.ts";
import { createSkillsMpAdapter } from "../src/adapters/skillsmp.ts";
import { registerWebFetch } from "../src/tools/web-fetch.ts";

test("the extension registers ten public tools and both commands once", async () => {
  const tools = [];
  const commands = new Map();
  extension({ registerTool(tool) { tools.push(tool); }, registerCommand(name, command) { commands.set(name, command); } });
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names, ["web_answer", "web_search", "web_fetch", "web_lookup", "context7", "web_search_exa", "web_search_x", "web_search_tavily", "web_answer_exa", "web_answer_linkup"]);
  assert.equal(new Set(names).size, names.length);
  for (const tool of tools) assert.equal(tool.parameters?.type, "object", `${tool.name} must expose a root object schema to Pi providers`);
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string", `${tool.name} must describe its evidence role`);
    assert.equal(typeof tool.promptSnippet, "string", `${tool.name} must expose its high-attention default`);
    assert.equal(tool.promptGuidelines?.length, 1, `${tool.name} must own one coherent usage guideline`);
    assert.equal(typeof tool.promptGuidelines[0], "string");
  }
  assert.deepEqual([...commands.keys()], ["web-doctor", "web-setup"]);
  assert.equal(tools.find((tool) => tool.name === "web_fetch").parameters.properties.refresh, undefined);
  let notification = "";
  await commands.get("web-doctor").handler("", { ui: { notify(text) { notification = text; } } });
  assert.match(notification, /jeito websift doctor/);
});

test("web_lookup treats catalog rows as leads", async () => {
  const tools = [];
  const adapter = (id, result) => ({ capability: { id, operations: ["lookup"], credentials: [], strengths: [id], returns: ["content"], timeoutMs: 1000, concurrency: 1, fallbackEligible: false, provenance: "test" }, async lookup() { return [result]; } });
  registerWebLookup({ registerTool(tool) { tools.push(tool); } }, new AdapterRegistry([
    adapter("skillsmp", { title: "Skill", description: "catalog record" }),
  ]));
  const catalog = await tools[0].execute("catalog", { source: "skillsmp", query: "q" });
  assert.deepEqual([catalog.details.sources[0].evidenceStatus, catalog.details.sources[0].fetched], ["catalog", false]);
  const catalogOutput = decodeGeneric(catalog.content[0].text);
  assert.equal(catalogOutput.evidenceStatus, "catalog");
  assert.equal(catalogOutput.records[0].description, "catalog record");
});
test("web_lookup declares a flat standard object schema and discriminates at runtime", async () => {
  const tools = [];
  registerWebLookup({ registerTool(tool) { tools.push(tool); } }, new AdapterRegistry([]));
  const parameters = tools[0].parameters;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.equal(parameters.anyOf, undefined, "root union envelope must stay gone — serving stacks strip args against it");
  assert.deepEqual(Object.keys(parameters.properties).sort(), ["category","language","limit","occupation","page","query","sortBy","source"], "catalog parameters");
});

test("web_lookup notes wrong-source parameters and enforces per-source limits", async () => {
  const adapter = (id) => ({ capability: { id, operations: ["lookup"], credentials: [], strengths: [id], returns: ["content"], timeoutMs: 1000, concurrency: 1, fallbackEligible: false, provenance: "test" }, async lookup(intent) { return [{ title: intent.query, description: "record" }]; } });
  const tools = [];
  registerWebLookup({ registerTool(tool) { tools.push(tool); } }, new AdapterRegistry([adapter("context7"), adapter("skillsmp"), adapter("pi-packages")]));
  const noted = await tools[0].execute("noted", { source: "pi-packages", query: "q", sortBy: "stars" });
  assert.ok(noted.details.warnings.some((warning) => warning.includes("sortBy is not used by pi-packages")));
  const overCap = await tools[0].execute("over", { source: "skillsmp", query: "q", limit: 101 });
  assert.equal(overCap.details.failureClass, "invalid_input");
  assert.match(overCap.content[0].text, /limit must be between 1 and 100/);
  const withinCap = await tools[0].execute("within", { source: "pi-packages", query: "q", limit: 20 });
  assert.equal(withinCap.details.failureClass, undefined);
});
test("web_lookup reports valid catalog zeros as successful scoped outcomes with metadata", async () => {
  const zeroSkillsmp = [];
  zeroSkillsmp.skillsmp = { effective: { query: "skill", page: 1, limit: 20, sortBy: "stars" }, rateLimits: { dailyRemaining: 499 } };
  const lookupAdapter = (id, lookup) => ({ capability: { id, operations: ["lookup"], credentials: [], strengths: [id], returns: ["content"], timeoutMs: 1000, concurrency: 1, fallbackEligible: false, provenance: "test" }, lookup });
  const tools = [];
  registerWebLookup({ registerTool(tool) { tools.push(tool); }, appendEntry() {} }, new AdapterRegistry([
    lookupAdapter("context7", async () => []),
    lookupAdapter("skillsmp", async () => zeroSkillsmp),
    lookupAdapter("pi-packages", async () => []),
  ]));

  const skillsmp = await tools[0].execute("id", { source: "skillsmp", query: "skill" });
  assert.equal(skillsmp.details.failureClass, undefined);
  assert.equal(skillsmp.details.attempts[0].status, "ok");
  assert.equal(skillsmp.details.resultCount, 0);
  assert.deepEqual(skillsmp.details.records, []);
  assert.deepEqual(skillsmp.details.rateLimits, { dailyRemaining: 499 });
  assert.deepEqual(skillsmp.details.lookupControls, { query: "skill", page: 1, limit: 20, sortBy: "stars" });
  assert.match(skillsmp.content[0].text, /Mutate one term or filter at a time/);

  const pip = await tools[0].execute("id", { source: "pi-packages", query: "memory" });
  assert.equal(pip.details.failureClass, undefined);
  assert.equal(pip.details.attempts[0].status, "ok");
  assert.equal(pip.details.resultCount, 0);
  assert.deepEqual(pip.details.records, []);
  assert.match(pip.content[0].text, /different keyword or looser terms/);
});

test("context7 allows exact Context7 IDs without a query and blocks source-only catalog calls", async () => {
  let contextIntent;
  let catalogCalls = 0;
  const lookupAdapter = (id, lookup) => ({ capability: { id, operations: ["lookup"], credentials: [], strengths: [id], returns: ["content"], timeoutMs: 1000, concurrency: 1, fallbackEligible: false, provenance: "test" }, lookup });
  const tools = [];
  registerContext7({ registerTool(tool) { tools.push(tool); }, appendEntry() {} }, new AdapterRegistry([
    lookupAdapter("context7", async (intent) => { contextIntent = intent; return [{ title: "Docs", content: "body" }]; }),
    lookupAdapter("skillsmp", async () => { catalogCalls += 1; return []; }),
  ]));
  const exact = await tools[0].execute("exact", { libraryId: "/t/l" });
  assert.equal(exact.details.failureClass, undefined);
  assert.equal(contextIntent.query, "overview");
  const missing = await tools[0].execute("missing", { source: "skillsmp" });
  assert.equal(missing.details.failureClass, "invalid_input");
  assert.equal(catalogCalls, 0);
});

test("context7 reports version misses before ambiguity and never recommends an unpinned candidate", async () => {
  const records = [
    { title: "A", metadata: { id: "/a/lib", versions: ["1.0"], needsResolution: true, versionNotFound: "9.0" } },
    { title: "B", metadata: { id: "/b/lib", versions: ["2.0"], needsResolution: true, versionNotFound: "9.0" } },
  ];
  const adapter = { capability: { id: "context7", operations: ["lookup"], credentials: [], strengths: ["docs"], returns: ["content"], timeoutMs: 1000, concurrency: 1, fallbackEligible: false, provenance: "test" }, async lookup() { return records; } };
  const tools = [];
  registerContext7({ registerTool(tool) { tools.push(tool); }, appendEntry() {} }, new AdapterRegistry([adapter]));
  const result = await tools[0].execute("version", { library: "lib", query: "q", version: "9.0" });
  assert.match(result.content[0].text, /Requested version is not advertised/);
  assert.doesNotMatch(result.content[0].text, /Multiple libraries match|omit version/);
});

test("context7 ambiguity requires an explicit candidate choice", async () => {
  const records = [{ title: "A", metadata: { id: "/a/lib", needsResolution: true, versions: ["1.0"] } }, { title: "B", metadata: { id: "/b/lib", needsResolution: true, versions: ["2.0"] } }];
  const adapter = { capability: { id: "context7", operations: ["lookup"], credentials: [], strengths: ["docs"], returns: ["content"], timeoutMs: 1000, concurrency: 1, fallbackEligible: false, provenance: "test" }, async lookup() { return records; } };
  const tools = [];
  registerContext7({ registerTool(tool) { tools.push(tool); }, appendEntry() {} }, new AdapterRegistry([adapter]));
  const result = await tools[0].execute("ambiguous", { library: "lib", query: "q" });
  assert.match(result.content[0].text, /put its id back in library|Multiple libraries match/);
  assert.match(result.content[0].text, /versions: 1\.0/);
  assert.match(result.content[0].text, /do not select rank one automatically/);
});

test("context7 docs save the complete body to a docsPath file with a bounded inline", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-reg-ctx7-"));
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    let calls = 0;
    const fullBody = "CTX7_RAW_BODY_MARKER ".repeat(400); // ~8400 chars, exceeds the 6000-char inline bound
    const fakeFetch = async () => (++calls === 1
      ? new Response(JSON.stringify({ results: [{ id: "/t/l", title: "T", versions: [] }] }))
      : new Response(fullBody));
    const registry = new AdapterRegistry([createContext7Adapter(fakeFetch)]);
    const tools = [];
    const pi = { registerTool(tool) { tools.push(tool); }, appendEntry() {} };
    registerContext7(pi, registry);
    const webLookup = tools.find((tool) => tool.name === "context7");

    const lookupResult = await webLookup.execute("id", { library: "t", query: "q" });
    const docsPath = lookupResult.details.docsPath;
    assert.equal(typeof docsPath, "string");
    assert.equal(lookupResult.details.sources[0].evidenceStatus, "fetched");
    // Inline is bounded and the complete raw body is NOT duplicated into details.records.
    assert.ok(lookupResult.details.records[0].content.length < fullBody.length);
    assert.ok(!lookupResult.details.records[0].content.includes(fullBody));
    assert.match(lookupResult.details.records[0].content, /excerpt truncated/);
    // The complete body is a file; the agent reads it with the read tool.
    assert.equal(readFileSync(docsPath, "utf8"), fullBody);
  } finally {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("context7 saves the exact raw body to a docsPath and renders a token-lean txt excerpt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jeito-reg-ctx7-json-"));
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    const rawJson = JSON.stringify({ codeSnippets: [{ codeTitle: "Typed route", codeList: [{ language: "ts", code: "route()" }] }] });
    const registry = new AdapterRegistry([createContext7Adapter(async () => new Response(rawJson))]);
    const tools = [];
    registerContext7({ registerTool(tool) { tools.push(tool); }, appendEntry() {} }, registry);
    const ctxTool = tools.find((tool) => tool.name === "context7");

    const lookup = await ctxTool.execute("id", { libraryId: "/t/l", query: "route" });
    assert.match(lookup.content[0].text, /route|Typed route/);
    assert.equal(lookup.details.sources[0].evidenceStatus, "fetched");
    assert.equal(readFileSync(lookup.details.docsPath, "utf8"), rawJson);
  } finally {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_lookup declares a flat standard schema accepting every source's parameters", () => {
  const tools = [];
  registerWebLookup({ registerTool(tool) { tools.push(tool); } }, new AdapterRegistry([]));
  const schema = tools.find((tool) => tool.name === "web_lookup").parameters;
  // Every catalog's parameter set validates against the single flat object.
  assert.equal(Check(schema, { source: "skillsmp", query: "q", limit: 5, page: 1 }), true);
  assert.equal(Check(schema, { source: "pi-packages", query: "q", page: 2 }), true);
  assert.equal(Check(schema, { source: "skillsmp", sortBy: "recent", category: "devops" }), true);
  assert.equal(Check(schema, {}), true);
});

test("web_lookup keeps integer and blank-query bounds at the boundary and enforces per-source limits at runtime", async () => {
  const tools = [];
  registerWebLookup({ registerTool(tool) { tools.push(tool); } }, new AdapterRegistry([]));
  const schema = tools.find((tool) => tool.name === "web_lookup").parameters;
  assert.equal(Check(schema, { source: "pi-packages", query: "q", page: 1.5 }), false);
  assert.equal(Check(schema, { source: "skillsmp", query: "q", page: 2.5 }), false);
  assert.equal(Check(schema, { source: "context7", query: "" }), false);
  assert.equal(Check(schema, { source: "context7", query: "q", page: 0 }), false);
  assert.equal(Check(schema, { source: "skillsmp", query: "q", limit: 0 }), false);
  const overSkillsmp = await tools[0].execute("over-sm", { source: "skillsmp", query: "q", limit: 101 });
  assert.equal(overSkillsmp.details.failureClass, "invalid_input");
  assert.match(overSkillsmp.content[0].text, /limit must be between 1 and 100/);
  const overPackages = await tools[0].execute("over-pp", { source: "pi-packages", query: "q", limit: 25 });
  assert.equal(overPackages.details.failureClass, "invalid_input");
  assert.match(overPackages.content[0].text, /limit must be between 1 and 20/);
});

test("web_lookup SkillsMP end-to-end: catalog evidence and rateLimits lifted, no responseId", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ skills: [{ name: "Skill A", githubUrl: "https://github.com/x/a", stars: 5 }, { name: "Skill B" }] }), { status: 200, headers: { "x-ratelimit-daily-limit": "500", "x-ratelimit-daily-remaining": "499" } });
  const tools = [];
  registerWebLookup({ registerTool(tool) { tools.push(tool); }, appendEntry() {} }, new AdapterRegistry([createSkillsMpAdapter(fakeFetch)]));
  const result = await tools[0].execute("id", { source: "skillsmp", query: "code review", sortBy: "recent", language: "en", limit: 2 });
  assert.deepEqual(result.details.sources.map((source) => [source.evidenceStatus, source.fetched]), [["catalog", false], ["catalog", false]]);
  assert.equal(result.details.responseId, undefined);
  assert.deepEqual(result.details.rateLimits, { dailyLimit: 500, dailyRemaining: 499 });
  assert.equal(result.details.pagination, undefined);
  assert.deepEqual(result.details.lookupControls, { query: "code review", page: 1, limit: 2, sortBy: "recent", language: "en" });
  assert.equal(result.details.records[0].title, "Skill A");
});

test("web_lookup accepts SkillsMP controls at the boundary and reports wrong-source parameters as runtime notes", async () => {
  const adapter = (id) => ({ capability: { id, operations: ["lookup"], credentials: [], strengths: [id], returns: ["content"], timeoutMs: 1000, concurrency: 1, fallbackEligible: false, provenance: "test" }, async lookup(intent) { return [{ title: intent.query, description: "record" }]; } });
  const tools = [];
  registerWebLookup({ registerTool(tool) { tools.push(tool); } }, new AdapterRegistry([adapter("context7"), adapter("skillsmp"), adapter("pi-packages")]));
  const schema = tools.find((tool) => tool.name === "web_lookup").parameters;
  assert.equal(Check(schema, { source: "skillsmp", query: "q", page: 2, limit: 50, sortBy: "recent", category: "devops", occupation: "software-developers", language: "ja" }), true);
  assert.equal(Check(schema, { source: "skillsmp", query: "q", sortBy: "newest" }), false);
  assert.equal(Check(schema, { source: "skillsmp", query: "q", bogus: true }), false);
  const noted = await tools[0].execute("noted", { source: "context7", query: "q", library: "lib", sortBy: "recent", language: "en" });
  assert.equal(noted.details.failureClass, undefined);
  const notes = noted.details.warnings.filter((warning) => warning.includes("is not used by context7"));
  assert.ok(notes.some((warning) => warning.startsWith("sortBy")), "sortBy note missing");
  assert.ok(notes.some((warning) => warning.startsWith("language")), "language note missing");
});
