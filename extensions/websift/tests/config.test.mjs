// Decision protected: malformed, cached, or deleted configuration degrades safely and surfaces one actionable warning across public tools.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { AdapterRegistry } from "../src/registry.ts";
import { registerWebAnswer } from "../src/tools/web-answer.ts";
import { registerWebFetch } from "../src/tools/web-fetch.ts";
import { registerWebLookup } from "../src/tools/web-lookup.ts";
import { registerWebSearch } from "../src/tools/web-search.ts";

function fakeAdapter(id, operation, value) {
  return { capability: { id, operations: [operation], credentials: [], strengths: [id === "context7" ? "context7" : "general", "page"], returns: ["content", "leads", "answers"], modes: ["page"], timeoutMs: 1000, concurrency: 1, fallbackEligible: true, provenance: "test" }, async [operation]() { return value; } };
}

test("malformed YAML returns defaults with a config_parse_error warning", () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websift-config-"));
  try {
    const path = join(root, "web.yaml");
    writeFileSync(path, "providers: [unterminated");
    const config = loadConfig(path);
    assert.deepEqual(config.limits, DEFAULT_CONFIG.limits);
    assert.deepEqual(config.warnings, ["config_parse_error"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("config cache invalidates on mtime and never exposes its cached snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websift-config-cache-"));
  try {
    const path = join(root, "web.yaml");
    writeFileSync(path, "limits:\n  timeoutMs: 100\n");
    const first = loadConfig(path);
    assert.equal(first.limits.timeoutMs, 100);
    first.limits.timeoutMs = 999;
    first.providers.serper.enabled = false;
    const cached = loadConfig(path);
    assert.notEqual(cached, first);
    assert.equal(cached.limits.timeoutMs, 100);
    assert.equal(cached.providers.serper.enabled, true);
    const nextMtime = new Date(Date.now() + 2000);
    writeFileSync(path, "limits:\n  timeoutMs: 200\n");
    utimesSync(path, nextMtime, nextMtime);
    const updated = loadConfig(path);
    assert.equal(updated.limits.timeoutMs, 200);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("network allowPrivateHosts is host-owned, exact, and normalized", () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websift-network-config-"));
  try {
    const path = join(root, "web.yaml");
    writeFileSync(path, "network:\n  allowPrivateHosts: [localhost, ' dev.internal ', 42, '']\n");
    assert.deepEqual(loadConfig(path).network, { allowPrivateHosts: ["localhost", "dev.internal"] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all four tools surface malformed-config warnings without crashing", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websift-tools-config-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  try {
    writeFileSync(join(root, "web.yaml"), "providers: [unterminated");
    process.env.PI_CODING_AGENT_DIR = root;
    const registry = new AdapterRegistry([
      fakeAdapter("serper", "search", [{ title: "Result", url: "https://example.com", snippet: "ok" }]),
      fakeAdapter("native", "fetch", [{ title: "Page", url: "https://example.com", content: "ok" }]),
      fakeAdapter("exa", "answer", { answer: "ok", sources: [] }),
      fakeAdapter("context7", "lookup", [{ title: "Docs", content: "ok" }]),
    ]);
    const tools = new Map();
    const pi = { registerTool(tool) { tools.set(tool.name, tool); }, appendEntry() {} };
    registerWebAnswer(pi, registry);
    registerWebSearch(pi, registry);
    registerWebFetch(pi, registry);
    registerWebLookup(pi, registry);
    const calls = [
      ["web_answer", { question: "q" }, undefined],
      ["web_search", { query: "q" }, undefined],
      ["web_fetch", { url: "https://example.com" }, { sessionManager: { getBranch: () => [] } }],
      ["web_lookup", { source: "context7", query: "q" }, undefined],
    ];
    for (const [name, params, ctx] of calls) {
      const result = await tools.get(name).execute("test", params, undefined, undefined, ctx);
      assert.ok(result.details.warnings.includes("config_parse_error"), name);
    }
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a web.yaml deleted after caching degrades to defaults, not a crash", () => {
  const root = mkdtempSync(join(tmpdir(), "jeito-websift-config-deleted-"));
  try {
    const path = join(root, "web.yaml");
    writeFileSync(path, "limits:\n  timeoutMs: 100\n");
    assert.equal(loadConfig(path).limits.timeoutMs, 100);
    rmSync(path);
    const after = loadConfig(path);
    assert.deepEqual(after.limits, DEFAULT_CONFIG.limits);
    assert.deepEqual(after.warnings, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});