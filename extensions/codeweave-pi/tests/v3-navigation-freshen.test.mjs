import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { freshenDocs, freshenGraph, main, parseArgs } from "../scripts/navigation-freshen.mjs";
import { VALUE_EXCLUDE_DIR_NAMES } from "../src/core/navigation-value-policy.ts";
import { resolvePreparedLane } from "../src/core/navigation-config.ts";
import { inspectNavigation } from "../scripts/navigation-doctor.mjs";
import { setExtensionRuntimeRootForTests } from "../src/core/owned-runtime.ts";
import { publishOwnedGraphifyFixture } from "./_clean-navigation-helper.mjs";

const execFileP = promisify(execFile);
const FRESHEN = new URL("../scripts/navigation-freshen.mjs", import.meta.url);
const GRAPHIFY_RICH_HELPER = new URL("../scripts/graphify-rich-update.py", import.meta.url);
const NODE_SHEBANG = `#!${process.execPath}`;

function fakeLocalLlm() {
  return {
    embedModelName: "local-test-embed",
    generateModelName: "local-test-generate",
    rerankModelName: "local-test-rerank",
    async embed() { return { embedding: [1, 0, 0], model: this.embedModelName }; },
    async embedBatch(texts) { return texts.map(() => ({ embedding: [1, 0, 0], model: this.embedModelName })); },
    async generate() { return null; },
    async expandQuery() { return []; },
    async rerank(_query, documents) { return { model: this.rerankModelName, results: documents.map((document, index) => ({ file: document.file, index, score: index === 0 ? 0.95 : 0.75 })) }; },
    async modelExists(model) { return { name: model, exists: true }; },
    async dispose() {},
  };
}

async function fixture() {
  return mkdtemp(join(tmpdir(), "pi-nav-freshen-"));
}

async function makeRepo() {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo" }));
  await mkdir(join(root, "src", "read"), { recursive: true });
  await writeFile(join(root, "src", "read", "mod.rs"), "pub fn read_ranges_with_budget() {}\n");
  return root;
}

async function writeExecutable(path, content) {
  await writeFile(path, content);
  await chmod(path, 0o755);
  if (basename(path).startsWith("fake-graphify-") && !basename(path).startsWith("fake-graphify-python-")) await publishOwnedGraphifyFixture(join(path, ".."), path);
  return path;
}





async function makeDocsRepo() {
  const root = await makeRepo();
  await writeFile(join(root, "README.md"), "# Overview\n\nstructural awareness in one call\n");
  await mkdir(join(root, ".research"), { recursive: true });
  await writeFile(join(root, ".research", "retired-docs-backend.md"), "# Retired research\n\nMust not appear in normal docs navigation.\n");
  return root;
}


async function fakeGraphify(root, mode = "success") {
  const script = join(root, `fake-graphify-${mode}.mjs`);
  if (mode === "update-fail") {
    return writeExecutable(script, `${NODE_SHEBANG}\nconst cmd = process.argv[2];\nif (cmd === 'update' || cmd === 'extract') { console.error('fake graphify refresh failure'); process.exit(12); }\nconsole.log('unexpected');\n`);
  }
  if (mode === "no-graph") {
    return writeExecutable(script, `${NODE_SHEBANG}\nconst cmd = process.argv[2];\nif (cmd === 'update' || cmd === 'extract') { console.log('refreshed without graph'); process.exit(0); }\nconsole.log('unused');\n`);
  }
  if (mode === "query-fail") {
    return writeExecutable(script, `${NODE_SHEBANG}\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nconst out = args[0] === 'update' && process.env.GRAPHIFY_OUT ? join(process.env.GRAPHIFY_OUT, '..') : (args.includes('--out') ? args[args.indexOf('--out') + 1] : args[1]);\nif (args[0] === 'update' || args[0] === 'extract') { mkdirSync(join(out, 'graphify-out'), { recursive: true }); writeFileSync(join(out, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: ['A'], edges: [] })); console.log('refreshed graph'); }\nelse if (args[0] === 'query') { console.error('fake graphify query failure'); process.exit(13); }\nelse { process.exit(14); }\n`);
  }
  if (mode === "query-empty") {
    return writeExecutable(script, `${NODE_SHEBANG}\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nconst out = args[0] === 'update' && process.env.GRAPHIFY_OUT ? join(process.env.GRAPHIFY_OUT, '..') : (args.includes('--out') ? args[args.indexOf('--out') + 1] : args[1]);\nif (args[0] === 'update' || args[0] === 'extract') { mkdirSync(join(out, 'graphify-out'), { recursive: true }); writeFileSync(join(out, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: ['A'], edges: [] })); console.log('refreshed graph'); }\nelse if (args[0] === 'query') { console.log(''); }\nelse { process.exit(14); }\n`);
  }
  if (mode === "unsafe") {
    return writeExecutable(script, `${NODE_SHEBANG}\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nconst out = args[0] === 'update' && process.env.GRAPHIFY_OUT ? join(process.env.GRAPHIFY_OUT, '..') : (args.includes('--out') ? args[args.indexOf('--out') + 1] : args[1]);\nif (args[0] === 'update' || args[0] === 'extract') { mkdirSync(join(out, 'graphify-out'), { recursive: true }); writeFileSync(join(out, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{ source_file: 'vendor/copied/index.ts' }], edges: [] })); console.log('refreshed graph'); }\nelse if (args[0] === 'query') { console.log('fake graph query answer'); }\nelse { process.exit(16); }\n`);
  }
  if (mode === "unsafe-once") {
    return writeExecutable(script, `${NODE_SHEBANG}\nimport { existsSync, mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nconst out = args[0] === 'update' && process.env.GRAPHIFY_OUT ? join(process.env.GRAPHIFY_OUT, '..') : (args.includes('--out') ? args[args.indexOf('--out') + 1] : args[1]);\nconst marker = join(process.cwd(), '.graphify-unsafe-once-marker');\nif (args[0] === 'update' || args[0] === 'extract') { mkdirSync(join(out, 'graphify-out'), { recursive: true }); if (!existsSync(marker)) { writeFileSync(marker, 'seen'); writeFileSync(join(out, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{ source_file: 'dist/generated/index.ts' }], edges: [] })); console.log('refreshed unsafe graph'); } else { writeFileSync(join(out, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{ source_file: 'src/read/mod.rs' }], edges: [] })); console.log('refreshed clean graph'); } }\nelse if (args[0] === 'query') { console.log('fake graph query answer'); }\nelse { process.exit(16); }\n`);
  }
  if (mode === "private-config-literal") {
    return writeExecutable(script, `${NODE_SHEBANG}\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nconst out = args[0] === 'update' && process.env.GRAPHIFY_OUT ? join(process.env.GRAPHIFY_OUT, '..') : (args.includes('--out') ? args[args.indexOf('--out') + 1] : args[1]);\nif (args[0] === 'update' || args[0] === 'extract') { mkdirSync(join(out, 'graphify-out'), { recursive: true }); writeFileSync(join(out, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{ name: '~/.pi/agent/navigation.yaml', source_file: 'src/read/mod.rs' }], edges: [] })); console.log('refreshed graph'); }\nelse if (args[0] === 'query') { console.log('fake graph query answer'); }\nelse { process.exit(16); }\n`);
  }

  if (mode === "reuse-if-present") {
    return writeExecutable(script, `${NODE_SHEBANG}\nimport { existsSync, mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nconst out = args[0] === 'update' && process.env.GRAPHIFY_OUT ? join(process.env.GRAPHIFY_OUT, '..') : (args.includes('--out') ? args[args.indexOf('--out') + 1] : args[1]);\nconst graph = join(out || process.cwd(), 'graphify-out', 'graph.json');\nif (args[0] === 'update' || args[0] === 'extract') { if (existsSync(graph) && !args.includes('--force')) { console.log('[graphify watch] No code-graph topology changes detected; outputs left untouched.'); } else { mkdirSync(join(out, 'graphify-out'), { recursive: true }); writeFileSync(graph, JSON.stringify({ nodes: ['fresh'], edges: [] })); console.log('forced graph refresh'); } }\nelse if (args[0] === 'query') { const graphArg = args[args.indexOf('--graph') + 1]; if (!existsSync(graphArg)) { console.error('missing graph'); process.exit(15); } console.log('fake graph query answer'); }\nelse { process.exit(16); }\n`);
  }
  if (mode === "refuse-shrink") {
    return writeExecutable(script, `${NODE_SHEBANG}\nimport { existsSync, mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nconst out = args[0] === 'update' && process.env.GRAPHIFY_OUT ? join(process.env.GRAPHIFY_OUT, '..') : (args.includes('--out') ? args[args.indexOf('--out') + 1] : args[1]);\nconst graph = join(out || process.cwd(), 'graphify-out', 'graph.json');\nif (args[0] === 'update' || args[0] === 'extract') { if (existsSync(graph) && !args.includes('--force')) { console.error('new graph has 155 nodes but existing graph.json has 265. Refusing to overwrite — pass --force to override.'); process.exit(12); } mkdirSync(join(out, 'graphify-out'), { recursive: true }); writeFileSync(graph, JSON.stringify({ nodes: Array.from({ length: 155 }, (_, index) => 'new-' + index), edges: [] })); console.log('forced smaller graph'); }\nelse if (args[0] === 'query') { const graphArg = args[args.indexOf('--graph') + 1]; if (!existsSync(graphArg)) { console.error('missing graph'); process.exit(15); } console.log('fake graph query answer'); }\nelse { process.exit(16); }\n`);
  }

  return writeExecutable(script, `${NODE_SHEBANG}\nimport { existsSync, mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nconst out = args[0] === 'update' && process.env.GRAPHIFY_OUT ? join(process.env.GRAPHIFY_OUT, '..') : (args.includes('--out') ? args[args.indexOf('--out') + 1] : args[1]);\nif (args[0] === 'update') { mkdirSync(join(out, 'graphify-out'), { recursive: true }); writeFileSync(join(out, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: ['read'], edges: [{ source: 'read', target: 'docs', confidence: 'STRUCTURAL' }] })); writeFileSync(join(out, '.graphify-update-args.json'), JSON.stringify(args)); console.log('[graphify update] local structural graph refreshed'); }\nelse if (args[0] === 'extract') { mkdirSync(join(out, 'graphify-out'), { recursive: true }); writeFileSync(join(out, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: ['read'], edges: [{ source: 'read', target: 'docs', confidence: 'INFERRED' }] })); writeFileSync(join(out, '.graphify-extract-args.json'), JSON.stringify(args)); console.log('[graphify extract] semantic extraction on 1 files via deepseek'); }\nelse if (args[0] === 'query') { const graph = args[args.indexOf('--graph') + 1]; if (!existsSync(graph)) { console.error('missing graph'); process.exit(15); } console.log('fake graph query answer for ' + args[1]); }\nelse { console.error('unknown graphify command ' + args[0]); process.exit(16); }\n`);
}

async function fakeGraphifyPython(root, mode = "incremental") {
  const script = join(root, `fake-graphify-python-${mode}.mjs`);
  if (mode === "missing-error") {
    return writeExecutable(script, `${NODE_SHEBANG}
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const graphOut = args[3];
const graphDir = join(graphOut, 'graphify-out');
mkdirSync(graphDir, { recursive: true });
const payload = { status: 'error', summary: 'Graphify rich incremental update needs an existing graph', root_cause: 'No owned graph.json exists for build_merge', safe_retry: 'manual setup first', diagnostics: ['graphify_rich_update_missing_existing_graph=true'], duration_ms: 7, llm_richness: 'no_llm_observed', report_path: join(graphDir, 'rich-update-report.json'), history_path: join(graphDir, 'rich-update-history.jsonl') };
writeFileSync(payload.report_path, JSON.stringify(payload, null, 2));
appendFileSync(payload.history_path, JSON.stringify(payload) + '\\n');
console.log(JSON.stringify(payload));
process.exit(1);
`);
  }
  if (mode === "provider-error") {
    return writeExecutable(script, `${NODE_SHEBANG}
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const graphDir = join(args[3], 'graphify-out');
mkdirSync(graphDir, { recursive: true });
const payload = { status: 'degraded', summary: 'Graphify rich refresh failed; existing graph preserved', root_cause: 'fake provider quota exceeded', safe_retry: 'retry on next lifecycle hook', failure_class: 'transient_provider', recovery_decision: 'retry_next_lifecycle', diagnostics: ['graphify_rich_refresh_degraded=true', 'graphify_rich_update_exception=true'], duration_ms: 11, llm_richness: 'no_llm_observed', graph_exists: true, manifest_exists: true, report_path: join(graphDir, 'rich-update-report.json'), history_path: join(graphDir, 'rich-update-history.jsonl') };
writeFileSync(payload.report_path, JSON.stringify(payload, null, 2));
appendFileSync(payload.history_path, JSON.stringify(payload) + '\\n');
console.log(JSON.stringify(payload));
process.exit(0);
`);
  }
  if (mode === "unsafe-candidate") {
    return writeExecutable(script, `${NODE_SHEBANG}
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), root = args[1], graphDir = join(args[3], 'graphify-out');
mkdirSync(graphDir, { recursive: true });
writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({ nodes: [{ source_file: 'vendor/generated.ts' }], edges: [] }));
writeFileSync(join(graphDir, 'manifest.json'), JSON.stringify({ 'src/read/mod.rs': { mtime: statSync(join(root, 'src/read/mod.rs')).mtimeMs / 1000, ast_hash: 'fresh', semantic_hash: 'fresh' } }));
console.log(JSON.stringify({ status: 'success', operation: 'rich_incremental', changed_total: 1, semantic_file_count: 0, code_file_count: 1, deleted_count: 0, nodes: 1, edges: 0 }));
`);
  }
  if (mode === "source-churn-then-success") {
    return writeExecutable(script, `${NODE_SHEBANG}
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), root = args[1], graphDir = join(args[3], 'graphify-out');
mkdirSync(graphDir, { recursive: true });
const source = join(root, 'src/read/mod.rs'), marker = join(root, '.graphify-churned-once');
const recorded = statSync(source).mtimeMs / 1000;
writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({ nodes: [{ source_file: 'src/read/mod.rs' }], edges: [] }));
writeFileSync(join(graphDir, 'manifest.json'), JSON.stringify({ 'src/read/mod.rs': { mtime: recorded, ast_hash: 'fresh', semantic_hash: 'fresh' } }));
if (!existsSync(marker)) { writeFileSync(marker, '1'); appendFileSync(source, '// changed during refresh\\n'); }
console.log(JSON.stringify({ status: 'success', operation: 'rich_incremental', changed_total: 1, semantic_file_count: 0, code_file_count: 1, deleted_count: 0, input_tokens: 0, output_tokens: 0, nodes: 1, edges: 0, semantic_extraction_observed: false, diagnostics: [] }));
`);
  }
  if (mode === "timeout") {
    return writeExecutable(script, `${NODE_SHEBANG}\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);\n`);
  }
  if (mode === "incremental-fail-full-success") {
    return writeExecutable(script, `${NODE_SHEBANG}
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const root = args[1];
const graphDir = join(args[3], 'graphify-out');
mkdirSync(graphDir, { recursive: true });
if (args[6] !== '1') {
  writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({ nodes: [], edges: [] }));
  writeFileSync(join(graphDir, 'manifest.json'), JSON.stringify({ 'src/read/mod.rs': { mtime: statSync(join(root, 'src/read/mod.rs')).mtimeMs / 1000, ast_hash: 'fresh', semantic_hash: 'fresh' } }));
  console.log(JSON.stringify({ status: 'success', operation: 'rich_incremental', changed_total: 1, semantic_file_count: 0, code_file_count: 1, deleted_count: 0, input_tokens: 0, output_tokens: 0, nodes: 0, edges: 0, semantic_extraction_observed: false, shrink_recovery: { forced: true, accepted: true, mode: 'unconditional_current_snapshot' }, diagnostics: [] }));
  process.exit(0);
}
writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({ nodes: [{ source_file: 'src/read/mod.rs' }], edges: [] }));
writeFileSync(join(graphDir, 'manifest.json'), JSON.stringify({ 'src/read/mod.rs': { mtime: statSync(join(root, 'src/read/mod.rs')).mtimeMs / 1000, ast_hash: 'fresh', semantic_hash: 'fresh' } }));
console.log(JSON.stringify({ status: 'success', operation: 'baseline_full_rebuild', changed_total: 1, semantic_file_count: 0, code_file_count: 1, deleted_count: 0, input_tokens: 0, output_tokens: 0, nodes: 1, edges: 0, semantic_extraction_observed: false, shrink_recovery: { forced: true, mode: 'baseline_full_rebuild' }, diagnostics: [] }));
`);
  }
  return writeExecutable(script, `${NODE_SHEBANG}
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const root = args[1];
const graphOut = args[3];
const strictRepair = args[6] === '1';
const graphDir = join(graphOut, 'graphify-out');
mkdirSync(graphDir, { recursive: true });
writeFileSync(join(graphDir, 'rich-args.json'), JSON.stringify({ argv: args, cwd: process.cwd(), root, strictRepair }));
if (strictRepair) {
  const payload = { status: 'error', summary: 'Graphify rich incremental update requires explicit deep repair', root_cause: 'rich-update must not rebuild the whole graph', safe_retry: 'run deep setup/repair', diagnostics: ['graphify_rich_update_requires_deep_repair=true'], duration_ms: 12, llm_richness: 'no_llm_observed', report_path: join(graphDir, 'rich-update-report.json'), history_path: join(graphDir, 'rich-update-history.jsonl') };
  writeFileSync(payload.report_path, JSON.stringify(payload, null, 2));
  appendFileSync(payload.history_path, JSON.stringify(payload) + '\\n');
  console.log(JSON.stringify(payload));
  process.exit(1);
}
writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({ nodes: [{ source_file: 'src/read/mod.rs' }], edges: [{ source_file: 'src/read/mod.rs' }] }));
writeFileSync(join(graphDir, 'manifest.json'), JSON.stringify({ 'src/read/mod.rs': { mtime: statSync(join(root, 'src/read/mod.rs')).mtimeMs / 1000, ast_hash: 'a', semantic_hash: 'a' } }));
let payload = { status: 'success', operation: 'rich_incremental', changed_total: 1, semantic_file_count: 1, code_file_count: 0, deleted_count: 0, input_tokens: 123, output_tokens: 456, duration_ms: 22, llm_richness: 'llm_semantic_extraction', nodes: 2, edges: 1, semantic_extraction_observed: true, code_file_sample: [], semantic_file_sample: ['docs/architecture.md'], deleted_file_sample: [], report_path: join(graphDir, 'rich-update-report.json'), history_path: join(graphDir, 'rich-update-history.jsonl') };
if ('${mode}' === 'noop') payload = { ...payload, operation: 'rich_noop', changed_total: 0, semantic_file_count: 0, code_file_count: 0, deleted_count: 0, input_tokens: 0, output_tokens: 0, duration_ms: 5, llm_richness: 'unchanged_noop', nodes: null, edges: null, semantic_extraction_observed: false, semantic_file_sample: [] };
if ('${mode}' === 'code-only') payload = { ...payload, operation: 'rich_incremental', changed_total: 1, semantic_file_count: 0, code_file_count: 1, deleted_count: 0, input_tokens: 0, output_tokens: 0, duration_ms: 9, llm_richness: 'local_ast_only', semantic_extraction_observed: false, code_file_sample: ['src/read/mod.rs'], semantic_file_sample: [] };
if ('${mode}' === 'delete-move') payload = { ...payload, operation: 'rich_incremental', changed_total: 1, semantic_file_count: 0, code_file_count: 1, deleted_count: 1, input_tokens: 0, output_tokens: 0, duration_ms: 13, llm_richness: 'local_ast_only', semantic_extraction_observed: false, code_file_sample: ['src/read/new-name.ts'], semantic_file_sample: [], deleted_file_sample: ['src/read/old-name.ts'] };
writeFileSync(payload.report_path, JSON.stringify(payload, null, 2));
appendFileSync(payload.history_path, JSON.stringify(payload) + '\\n');
console.log(JSON.stringify(payload));
`);
}


test("navigation value policy excludes hidden/generated code graph inputs by default", () => {
  for (const dir of [".tmp", ".pi", ".agents", ".agent", ".claude", ".codex", ".research", ".gsd", "sessions", "graphify-out", "node_modules", "vendor"]) {
    assert.ok(VALUE_EXCLUDE_DIR_NAMES.includes(dir), `${dir} missing from navigation value-policy excludes`);
  }
});


test("navigation freshen refuses the retired architecture lane before mutation or spawn", async t => {
  const root = await makeRepo();
  await mkdir(join(root, ".code-review-graph"), { recursive: true });
  await writeFile(join(root, ".code-review-graph", "graph.db"), "retired store bytes");
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ architecture: { enabled: true, indexPath: ".code-review-graph/graph.db" } }));
  const artifacts = [join(root, ".code-review-graph", "graph.db"), join(root, ".pi-navigation.json")];
  const before = await Promise.all(artifacts.map(async path => ({ path, bytes: await readFile(path) })));

  // Public contract: the retired lane exits non-zero with an actionable refusal.
  const cli = await execFileP(process.execPath, [FRESHEN.pathname, "architecture", "--path", root], { encoding: "utf8" })
    .then(() => undefined, error => error);
  assert.ok(cli, "the retired architecture lane must exit non-zero");
  assert.equal(cli.code, 1);
  assert.match(String(cli.stderr), /architecture.*retired|retired.*architecture/i);

  // In-process contract: the refusal precedes every spawn and every write.
  const spawns = t.mock.method(childProcess, "spawnSync", () => { throw new Error("the retired lane must not launch work"); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(() => main(["architecture", "--path", root]),
    error => /architecture/i.test(error.message) && /retired/i.test(error.message));
  assert.equal(spawns.mock.callCount(), 0, "a retired lane must be refused before any child process");
  assert.equal(existsSync(join(root, ".pi")), false, "a retired lane must be refused before any navigation state exists");
  for (const entry of before) assert.deepEqual(await readFile(entry.path), entry.bytes, `${entry.path} must be untouched`);
});

test("navigation freshen projects Markdown sections into QMD and updates config/state", async () => {
  const root = await makeDocsRepo();
  await mkdir(join(root, ".pi", "navigation"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "config.json"), JSON.stringify({ providers: { allowLocalModelDownloads: false } }));
  const report = await freshenDocs(root, { env: { PATH: process.env.PATH }, docsRepo: "local/fake-docs", query: "structural awareness", qmdLlm: fakeLocalLlm() });
  assert.equal(report.status, "success", JSON.stringify(report));
  assert.equal(report.repo, "local/fake-docs");
  assert.equal(report.qmd.status, "ready");
  assert.equal(report.qmd.semantic_provider, "local");
  assert.ok(Number(report.qmd.sections) > 0);
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(config.docs.backend, "qmd");
  assert.equal(config.docs.queryCommand, undefined);
  assert.equal(config.docs.queryTransport, undefined);
  assert.equal(config.docs.repo, "local/fake-docs");
  assert.equal(config.docs.embeddingProvider, "auto");
  assert.equal(state.indexes.docs.qmd.generation, report.qmd.generation);
  assert.ok(report.diagnostics.includes("docs_backend=qmd-sections"));

  const warm = await freshenDocs(root, { env: { PATH: process.env.PATH }, qmdLlm: fakeLocalLlm() });
  assert.equal(warm.status, "success", JSON.stringify(warm));
  assert.equal(warm.repo, "local/fake-docs");
  assert.ok(Number(warm.qmd.unchanged) > 0);
  assert.equal(Number(warm.qmd.changed), 0);
});

test("navigation freshen migrates obsolete docs config to the QMD-owned lexical lane", async () => {
  const root = await makeDocsRepo();
  const legacyDir = join(root, ".pi", "navigation", "jdocmunch", "native");
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(legacyDir, "user-owned-marker"), "preserve\n");
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    docs: {
      enabled: true,
      backend: "jDocMunch",
      repo: "local/legacy-docs",
      root: ".",
      indexPath: ".pi/navigation/jdocmunch/native",
      queryCommand: "/obsolete/jdocmunch-mcp",
      queryTransport: "native-mcp",
      indexCommand: "/obsolete/jdocmunch-mcp",
      quality: { embeddings: "auto", aiSummaries: true },
      autoPrepare: true,
    },
  }));
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({
    indexes: { docs: { eligibleFiles: 28, selectedFiles: 42, backendIdentity: { name: "retired" } } },
  }));

  const report = await freshenDocs(root, { env: { PATH: process.env.PATH }, qmdLlm: fakeLocalLlm() });
  assert.equal(report.status, "success", JSON.stringify(report));
  assert.equal(report.qmd.status, "ready");
  assert.equal(report.qmd.semantic.status, "ready");
  assert.equal(report.qmd.semantic_provider, "local");
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(config.docs.backend, "qmd");
  assert.equal(config.docs.indexPath, ".pi/navigation/qmd");
  assert.equal(config.docs.queryCommand, undefined);
  assert.equal(config.docs.queryTransport, undefined);
  assert.equal(config.docs.indexCommand, undefined);
  assert.equal(config.docs.quality, undefined);
  assert.equal(config.docs.autoPrepare, true);
  assert.equal(state.indexes.docs.indexPath, ".pi/navigation/qmd");
  assert.equal(state.indexes.docs.qmd.status, "ready");
  assert.equal(state.indexes.docs.eligibleFiles, undefined);
  assert.equal(state.indexes.docs.selectedFiles, undefined);
  assert.equal(state.indexes.docs.backendIdentity, undefined);
  assert.equal(await readFile(join(legacyDir, "user-owned-marker"), "utf8"), "preserve\n");
});

test("provider degradation still publishes the current lexical QMD lane", async () => {
  const root = await makeDocsRepo();
  const report = await freshenDocs(root, {
    env: { PATH: process.env.PATH, ZEROENTROPY_API_KEY: "test" },
    zeroEntropyFetch: async () => new Response("provider unavailable", { status: 503 }),
  });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.equal(report.qmd.status, "lexical_ready");
  assert.equal(report.qmd.semantic.status, "degraded");
  assert.ok(Number(report.qmd.health.needsEmbedding) > 0);
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(config.docs.backend, "qmd");
  assert.equal(state.indexes.docs.qmd.semantic.status, "degraded");
});

test("explicit OpenRouter docs freshen persists the provider and exact NVIDIA embedding model", async () => {
  const root = await makeDocsRepo();
  const requests = [];
  const report = await freshenDocs(root, {
    docsProvider: "openrouter",
    env: { PATH: process.env.PATH, OPENROUTER_API_KEY: "configured" },
    providerFetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    },
  });
  assert.equal(report.status, "success", JSON.stringify(report));
  assert.equal(report.qmd.status, "ready");
  assert.equal(report.qmd.semantic_provider, "openrouter");
  assert.equal(report.qmd.embedding_model, "nvidia/nemotron-3-embed-1b:free");
  assert.ok(requests.every(request => request.url.endsWith("/embeddings")));
  assert.ok(requests.flatMap(request => request.body.input).every(text => text.startsWith("passage: ")));
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  assert.equal(config.docs.embeddingProvider, "openrouter");
});

test("lexical lifecycle mode never invokes a configured semantic provider", async () => {
  const root = await makeDocsRepo();
  let providerCalls = 0;
  const report = await freshenDocs(root, {
    env: { PATH: process.env.PATH, ZEROENTROPY_API_KEY: "configured" },
    useEmbeddings: "false",
    zeroEntropyFetch: async () => { providerCalls += 1; throw new Error("must not be called"); },
  });
  assert.equal(report.status, "success", JSON.stringify(report));
  assert.equal(report.qmd.status, "lexical_ready");
  assert.equal(report.qmd.semantic.status, "unavailable");
  assert.equal(providerCalls, 0);
});

test("failed lexical migration preserves obsolete public configuration for lifecycle retry", async () => {
  const root = await makeDocsRepo();
  const previous = {
    docs: { enabled: true, backend: "jDocMunch", repo: "local/legacy-docs", root: ".", indexPath: ".pi/navigation/jdocmunch/native", queryCommand: "/obsolete" },
  };
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify(previous));

  const report = await freshenDocs(root, {
    env: { PATH: process.env.PATH },
    callNative: async () => { throw new Error("pi-nav projection unavailable"); },
  });
  assert.equal(report.status, "error");
  assert.match(report.root_cause, /pi-nav projection unavailable/);
  assert.deepEqual(JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8")), previous);
});

test("navigation freshen CLI supports the QMD docs lane without backend executable flags", async () => {
  const root = await makeDocsRepo();
  const { stdout } = await execFileP(process.execPath, [FRESHEN.pathname, "docs", "--path", root, "--docs-repo", "local/cli-docs", "--query", "structural awareness", "--use-embeddings", "false", "--json"], {
    env: { ...process.env, PATH: process.env.PATH },
    timeout: 30_000,
  });
  const report = JSON.parse(stdout);
  assert.equal(report.status, "success", JSON.stringify(report));
  assert.equal(report.repo, "local/cli-docs");
  assert.ok(["ready", "lexical_ready"].includes(report.qmd.status), JSON.stringify(report.qmd));
});


test("navigation freshen graph defaults to local Graphify update, verifies query, and updates config/state", async () => {
  const root = await makeRepo();
  const graphify = await fakeGraphify(root);
  const report = freshenGraph(root, { graphifyBin: graphify, env: { PATH: "" }, graphifyMode: "update", query: "read docs relationship" });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.ok(existsSync(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json")));
  assert.ok(existsSync(join(root, ".pi", "navigation", "graphify", ".graphify-update-args.json")));
  const updateArgs = JSON.parse(await readFile(join(root, ".pi", "navigation", "graphify", ".graphify-update-args.json"), "utf8"));
  assert.equal(updateArgs.includes("--out"), false, "installed graphify update uses GRAPHIFY_OUT instead of --out");
  assert.ok(report.verify.outputBytes > 0);
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(config.graph.enabled, true);
  assert.equal(config.graph.command, graphify);
  assert.match(config.graph.graphPath, /^\.pi\/navigation\/graphify\/generations\/[^/]+\/graph\.json$/);
  assert.equal(state.indexes.graph.graphPath, config.graph.graphPath);
  assert.match(state.indexes.graph.desiredStateHash, /^[0-9a-f]{64}$/);
  assert.equal(state.indexes.graph.lastProbeStatus, "ready");
  assert.equal(config.graph.mode, "update");
  assert.equal(config.graph.provider, undefined);
  assert.equal(config.graph.root, ".");
  assert.equal(state.indexes.graph.root, ".");
  assert.match(state.indexes.graph.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(report.diagnostics.includes("query_time_rebuild=false"));
  assert.ok(report.diagnostics.includes("graphify_mode=update"));
  assert.ok(report.diagnostics.includes("graphify_local_update=true"));
  assert.match(report.summary, /local update/i);
  assert.equal(report.diagnostics.some(item => /^graphify_(?:backend|model)=/.test(item)), false, JSON.stringify(report.diagnostics));
  assert.doesNotMatch(`${report.stdout}\n${report.stderr}`, /\/graphify\b|\b(?:provider|model)\s*[:=]/i);
});

test("navigation freshen graph rich-update uses Graphify Python helper, writes manifest, and mirrors default ignores", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "graph.json"), JSON.stringify({ nodes: ["old"], edges: [] }));
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ "src/read/mod.rs": { mtime: 1, ast_hash: "old", semantic_hash: "old" } }));
  const graphify = await fakeGraphify(root);
  const graphifyPython = await fakeGraphifyPython(root);

  const report = freshenGraph(root, { graphifyBin: graphify, graphifyPython, graphifyMode: "rich-update", graphifyProvider: "deepseek", graphifyModel: "deepseek-v4-flash", env: { PATH: "" }, query: "read docs relationship" });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.equal(report.verify.semanticExtractionObserved, true);
  assert.ok(report.diagnostics.includes("graphify_mode=richUpdate"));
  assert.ok(report.diagnostics.includes("graphify_rich_operation=rich_incremental"));
  assert.ok(report.diagnostics.includes("graphify_rich_semantic_files=1"));
  assert.ok(report.diagnostics.includes("graphify_rich_input_tokens=123"));
  assert.ok(report.diagnostics.includes("graphify_rich_duration_ms=22"));
  assert.ok(report.diagnostics.includes("graphify_rich_llm_richness=llm_semantic_extraction"));
  assert.ok(report.diagnostics.includes("graphify_rich_report=.pi/navigation/graphify/graphify-out/rich-update-report.json"));
  assert.ok(report.diagnostics.some(item => /^graphify_ignore_defaults=/.test(item)), JSON.stringify(report.diagnostics));
  const ignore = await readFile(join(root, ".graphifyignore"), "utf8");
  assert.match(ignore, /\.tmp\//);
  assert.match(ignore, /\.ua\//);
  assert.doesNotMatch(ignore, /\*\*\/\.\*\//);
  assert.ok(existsSync(join(graphDir, "manifest.json")));
  const richReport = JSON.parse(await readFile(join(graphDir, "rich-update-report.json"), "utf8"));
  assert.equal(richReport.llm_richness, "llm_semantic_extraction");
  assert.equal(richReport.duration_ms, 22);
  assert.ok(existsSync(join(graphDir, "rich-update-history.jsonl")));
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(config.graph.mode, "richUpdate");
  assert.equal(state.indexes.graph.mode, "richUpdate");
  assert.equal(config.graph.lastRichUpdate.llmRichness, "llm_semantic_extraction");
  assert.equal(state.indexes.graph.lastRichUpdate.durationMs, 22);
  assert.equal(config.graph.provider, "deepseek");
  assert.equal(config.graph.model, "deepseek-v4-flash");
  assert.match(config.graph.sourceManifestPath, /^\.pi\/navigation\/graphify\/generations\/[^/]+\/manifest\.json$/);
  assert.equal(existsSync(join(root, config.graph.sourceManifestPath)), true);
  assert.equal(state.indexes.graph.sourceManifestPath, config.graph.sourceManifestPath);
});

test("navigation freshen restores an interrupted working pair from the verified generation", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "graph.json"), JSON.stringify({ nodes: ["old"], edges: [] }));
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ "src/read/mod.rs": { mtime: 1, ast_hash: "old", semantic_hash: "old" } }));
  const graphify = await fakeGraphify(root);
  const graphifyPython = await fakeGraphifyPython(root);
  const first = freshenGraph(root, { graphifyBin: graphify, graphifyPython, graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" } });
  assert.equal(first.status, "success", JSON.stringify(first));
  await writeFile(join(graphDir, "graph.json"), "{ interrupted");
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ "wrong.ts": { mtime: 1, ast_hash: "wrong", semantic_hash: "wrong" } }));
  const second = freshenGraph(root, { graphifyBin: graphify, graphifyPython: await fakeGraphifyPython(root, "noop"), graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" } });
  assert.equal(second.status, "success", JSON.stringify(second));
  assert.ok(second.diagnostics.includes("graphify_working_baseline_restored=current_pointer"), JSON.stringify(second.diagnostics));
  assert.doesNotMatch(await readFile(join(graphDir, "graph.json"), "utf8"), /interrupted/);
});

test("navigation freshen graph atomically publishes a smaller incremental graph without rebuilding", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  const previousGraph = JSON.stringify({ nodes: [{ source_file: "src/read/mod.rs", stale: true }], edges: [] });
  await writeFile(join(graphDir, "graph.json"), previousGraph);
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ "src/read/mod.rs": { mtime: 1, ast_hash: "old", semantic_hash: "old" } }));
  const report = freshenGraph(root, { graphifyBin: await fakeGraphify(root), graphifyPython: await fakeGraphifyPython(root, "incremental-fail-full-success"), graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" }, query: "read docs relationship" });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_rich_shrink=accepted_current_snapshot"), JSON.stringify(report.diagnostics));
  assert.equal(report.diagnostics.includes("graphify_baseline_full_rebuild=true"), false);
  assert.deepEqual(JSON.parse(await readFile(join(graphDir, "graph.json"), "utf8")).nodes, []);
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  assert.equal(config.graph.refreshStatus, "ready");
  assert.equal(config.graph.sourceFreshnessStatus, "current");
  const lane = await resolvePreparedLane(root, "graph", { env: { PATH: process.env.PATH } });
  assert.equal(lane.ok, true, JSON.stringify(lane));
  assert.equal(lane.refreshStatus, "ready");
  assert.equal(lane.sourceFreshnessStatus, "current");
});

test("navigation freshen converges when source changes during a long refresh", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "graph.json"), JSON.stringify({ nodes: [{ source_file: "src/read/mod.rs" }], edges: [] }));
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ "src/read/mod.rs": { mtime: 1, ast_hash: "old", semantic_hash: "old" } }));
  const report = freshenGraph(root, { graphifyBin: await fakeGraphify(root), graphifyPython: await fakeGraphifyPython(root, "source-churn-then-success"), graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" } });
  assert.equal(report.status, "success", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_convergence_retry=1"), JSON.stringify(report.diagnostics));
  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(state.indexes.graph.refreshStatus, "ready");
  assert.equal(state.indexes.graph.sourceFreshnessStatus, "current");
  const manifest = JSON.parse(await readFile(join(root, state.indexes.graph.sourceManifestPath), "utf8"));
  assert.ok(Math.abs(manifest["src/read/mod.rs"].mtime - (await stat(join(root, "src/read/mod.rs"))).mtimeMs / 1000) <= 0.001);
});

test("navigation freshen graph rich-update records no-op output report", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "graph.json"), JSON.stringify({ nodes: ["old"], edges: [] }));
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ "src/read/mod.rs": { mtime: 1, ast_hash: "old", semantic_hash: "old" } }));
  const report = freshenGraph(root, { graphifyBin: await fakeGraphify(root), graphifyPython: await fakeGraphifyPython(root, "noop"), graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" } });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_rich_operation=rich_noop"));
  assert.ok(report.diagnostics.includes("graphify_rich_llm_richness=unchanged_noop"));
  const richReport = JSON.parse(await readFile(join(graphDir, "rich-update-report.json"), "utf8"));
  assert.equal(richReport.llm_richness, "unchanged_noop");
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  assert.equal(config.graph.lastRichUpdate.changedFiles, 0);
  assert.equal(config.graph.lastRichUpdate.inputTokens, 0);
});

test("navigation freshen graph rich-update records code-only zero-token AST refresh", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "graph.json"), JSON.stringify({ nodes: ["old"], edges: [] }));
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ "src/read/mod.rs": { mtime: 1, ast_hash: "old", semantic_hash: "old" } }));
  const report = freshenGraph(root, { graphifyBin: await fakeGraphify(root), graphifyPython: await fakeGraphifyPython(root, "code-only"), graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" } });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_rich_code_files=1"));
  assert.ok(report.diagnostics.includes("graphify_rich_semantic_files=0"));
  assert.ok(report.diagnostics.includes("graphify_rich_input_tokens=0"));
  assert.ok(report.diagnostics.includes("graphify_rich_output_tokens=0"));
  assert.ok(report.diagnostics.includes("graphify_rich_llm_richness=local_ast_only"));
  const richReport = JSON.parse(await readFile(join(graphDir, "rich-update-report.json"), "utf8"));
  assert.deepEqual(richReport.code_file_sample, ["src/read/mod.rs"]);
});

test("navigation freshen graph rich-update records delete/move pruning samples", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "graph.json"), JSON.stringify({ nodes: ["old"], edges: [] }));
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ "src/read/old-name.ts": { mtime: 1, ast_hash: "old", semantic_hash: "old" } }));
  const report = freshenGraph(root, { graphifyBin: await fakeGraphify(root), graphifyPython: await fakeGraphifyPython(root, "delete-move"), graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" } });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_rich_deleted_files=1"));
  const richReport = JSON.parse(await readFile(join(graphDir, "rich-update-report.json"), "utf8"));
  assert.deepEqual(richReport.code_file_sample, ["src/read/new-name.ts"]);
  assert.deepEqual(richReport.deleted_file_sample, ["src/read/old-name.ts"]);
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  assert.equal(config.graph.lastRichUpdate.deletedFiles, 1);
});

test("navigation freshen graph rebuilds only when the incremental manifest is unusable", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "graph.json"), JSON.stringify({ nodes: ["old"], edges: [] }));
  const report = freshenGraph(root, { graphifyBin: await fakeGraphify(root), graphifyPython: await fakeGraphifyPython(root, "incremental-fail-full-success"), graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" } });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_baseline_full_rebuild=true"), JSON.stringify(report.diagnostics));
  assert.ok(report.diagnostics.includes("graphify_full_rebuild_reason=incremental manifest is missing"), JSON.stringify(report.diagnostics));
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  assert.equal(config.graph.refreshStatus, "ready");
  assert.match(config.graph.graphPath, /^\.pi\/navigation\/graphify\/generations\/[^/]+\/graph\.json$/);
  const lane = await resolvePreparedLane(root, "graph", { env: { PATH: process.env.PATH } });
  assert.equal(lane.ok, true, JSON.stringify(lane));
});

test("navigation freshen graph permits a baseline rebuild for a structurally invalid manifest", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "graph.json"), JSON.stringify({ nodes: ["old"], edges: [] }));
  await writeFile(join(graphDir, "manifest.json"), "[]");
  const report = freshenGraph(root, { graphifyBin: await fakeGraphify(root), graphifyPython: await fakeGraphifyPython(root, "incremental-fail-full-success"), graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" } });
  assert.equal(report.status, "success", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_full_rebuild_reason=incremental manifest is structurally invalid"), JSON.stringify(report.diagnostics));
  assert.ok(report.diagnostics.includes("graphify_baseline_full_rebuild=true"));
});

test("navigation freshen graph keeps query readiness after a transient provider failure", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  const previousGraph = JSON.stringify({ nodes: ["old"], edges: [] });
  await writeFile(join(graphDir, "graph.json"), previousGraph);
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ "src/read/mod.rs": { mtime: 1, ast_hash: "old", semantic_hash: "old" } }));
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, mode: "deepExtract", graphPath: ".pi/navigation/graphify/graphify-out/graph.json" } }));
  const report = freshenGraph(root, { graphifyBin: await fakeGraphify(root), graphifyPython: await fakeGraphifyPython(root, "provider-error"), graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" } });

  assert.equal(report.status, "error", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_full_rebuild_skipped=incremental_failure"), JSON.stringify(report.diagnostics));
  assert.ok(report.diagnostics.includes("graphify_failure_class=transient_provider"));
  assert.ok(report.diagnostics.includes("graphify_recovery_decision=retry_next_lifecycle"));
  assert.match(report.stop_condition, /verified graph remains query-ready/);
  assert.equal(await readFile(join(graphDir, "graph.json"), "utf8"), previousGraph, "last-good bytes remain rollback material only");
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(config.graph.sourceManifestPath.replace(/manifest\.json$/, "graph.json"), config.graph.graphPath, "preserved graph and manifest must publish as one generation pair");
  assert.equal(state.indexes.graph.sourceManifestPath, config.graph.sourceManifestPath);
  assert.equal(config.graph.refreshStatus, "ready");
  assert.equal(config.graph.sourceFreshnessStatus, "retry_pending");
  assert.equal(config.graph.lastRefreshFailure.failureClass, "transient_provider");
  assert.equal(config.graph.lastRefreshFailure.recoveryDecision, "retry_next_lifecycle");
  assert.equal(config.graph.lastRefreshFailure.retryAttempt, 1);
  assert.ok(Date.parse(config.graph.lastRefreshFailure.retryAfter) > Date.now());
  assert.equal(state.indexes.graph.refreshStatus, "ready");
  assert.equal(state.indexes.graph.sourceFreshnessStatus, "retry_pending");
  assert.equal(state.indexes.graph.lastProbeStatus, "ready");
  const lane = await resolvePreparedLane(root, "graph", { env: { PATH: process.env.PATH } });
  assert.equal(lane.ok, true, JSON.stringify(lane));
  assert.equal(lane.refreshStatus, "ready");
  assert.equal(lane.sourceFreshnessStatus, "refreshing");
  assert.ok(lane.diagnostics.some(value => /graph_refresh_scheduled=retry_pending/.test(value)), JSON.stringify(lane.diagnostics));
});

test("navigation freshen graph does not publish candidates that fail quality or query verification", async () => {
  for (const scenario of ["quality", "query"]) {
    const root = await makeRepo();
    const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
    await mkdir(graphDir, { recursive: true });
    const previousGraph = JSON.stringify({ nodes: ["old"], edges: [] });
    await writeFile(join(graphDir, "graph.json"), previousGraph);
    await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ "src/read/mod.rs": { mtime: 1, ast_hash: "old", semantic_hash: "old" } }));
    const report = freshenGraph(root, { graphifyBin: await fakeGraphify(root, scenario === "query" ? "query-fail" : "success"), graphifyPython: await fakeGraphifyPython(root, scenario === "quality" ? "unsafe-candidate" : "incremental"), graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" } });
    assert.equal(report.status, "error", `${scenario}: ${JSON.stringify(report)}`);
    assert.ok(report.diagnostics.includes("graphify_full_rebuild_skipped=incremental_failure"), scenario);
    assert.ok(report.diagnostics.includes(scenario === "quality" ? "graphify_incremental_candidate_quality_failed=true" : "graphify_incremental_candidate_query_failed=true"), JSON.stringify(report.diagnostics));
    assert.equal(await readFile(join(graphDir, "graph.json"), "utf8"), previousGraph, `${scenario} candidate must stay isolated`);
  }
});

test("navigation freshen graph does not rebuild after an incremental timeout", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  const previousGraph = JSON.stringify({ nodes: ["old"], edges: [] });
  await writeFile(join(graphDir, "graph.json"), previousGraph);
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ "src/read/mod.rs": { mtime: 1, ast_hash: "old", semantic_hash: "old" } }));
  const report = freshenGraph(root, { graphifyBin: await fakeGraphify(root), graphifyPython: await fakeGraphifyPython(root, "timeout"), graphifyMode: "rich-update", graphifyProvider: "deepseek", timeoutMs: 50, env: { PATH: "" } });
  assert.equal(report.status, "error", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_full_rebuild_skipped=incremental_failure"));
  assert.equal(await readFile(join(graphDir, "graph.json"), "utf8"), previousGraph);
});

test("navigation freshen graph attempts a baseline rebuild when no graph exists", async () => {
  const root = await makeRepo();
  const graphify = await fakeGraphify(root);
  const graphifyPython = await fakeGraphifyPython(root, "missing-error");

  const report = freshenGraph(root, { graphifyBin: graphify, graphifyPython, graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" } });

  assert.equal(report.status, "error");
  assert.match(report.root_cause, /No owned graph\.json|full recovery|must not rebuild/i);
  assert.ok(report.diagnostics.includes("graphify_full_rebuild_reason=existing graph is missing"), JSON.stringify(report.diagnostics));
  assert.equal(existsSync(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json")), false);
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  assert.equal(config.graph, undefined);
});

test("navigation freshen graph repairs unsafe prior provenance through the incremental path", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  const graphPath = join(graphDir, "graph.json");
  await mkdir(graphDir, { recursive: true });
  await writeFile(graphPath, JSON.stringify({ nodes: [{ source_file: ".pi/navigation/qmd/research-docs/doc.md" }], edges: [] }));
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ "src/read/mod.rs": { mtime: 1, ast_hash: "old", semantic_hash: "old" } }));
  const report = freshenGraph(root, { graphifyBin: await fakeGraphify(root), graphifyPython: await fakeGraphifyPython(root), graphifyMode: "rich-update", graphifyProvider: "deepseek", env: { PATH: "" }, query: "project map" });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.equal(report.diagnostics.includes("graphify_baseline_full_rebuild=true"), false);
  assert.ok(report.diagnostics.some(item => item.startsWith("graph_existing_needs_repair=unsafe_existing_graph")), JSON.stringify(report.diagnostics));
  assert.match(await readFile(graphPath, "utf8"), /src\/read\/mod\.rs/);
});

test("navigation freshen graph records AST-only degradation when explicit deep Graphify reports no semantic LLM extraction", async () => {
  const root = await makeRepo();
  const graphify = await fakeGraphify(root, "reuse-if-present");
  const report = freshenGraph(root, { graphifyBin: graphify, graphifyMode: "deep", graphifyProvider: "deepseek", env: { PATH: "" }, query: "read docs relationship" });
  assert.equal(report.status, "success", JSON.stringify(report));
  assert.equal(report.verify.semanticExtractionObserved, false);
  assert.ok(report.diagnostics.includes("graphify_mode=deepExtractAstOnly"));
  assert.ok(report.diagnostics.includes("graphify_degraded=ast_only_no_semantic_llm_output"));
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(config.graph.mode, "deepExtractAstOnly");
  assert.equal(state.indexes.graph.mode, "deepExtractAstOnly");
  assert.equal(config.graph.semanticExtractionObserved, false);
});

test("Graphify rich helper itself writes durable error report when graph is missing", async (t) => {
  const python = process.env.PYTHON || process.env.PYTHON3 || "python3";
  try {
    await execFileP(python, ["-c", "import sys; print(sys.executable)"]);
  } catch {
    t.skip("python3 unavailable");
    return;
  }
  const root = await makeRepo();
  const out = join(root, ".pi", "navigation", "graphify");
  let stdout = "";
  let stderr = "";
  try {
    await execFileP(python, [GRAPHIFY_RICH_HELPER.pathname, root, root, out, "deepseek", "", "0", "incremental"]);
    assert.fail("helper should fail closed when graph is missing");
  } catch (error) {
    stdout = String(error?.stdout ?? "");
    stderr = String(error?.stderr ?? "");
  }
  assert.match(stdout, /Graphify rich incremental update needs an existing deep graph/, stderr);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, "error");
  assert.equal(parsed.graph_exists, false);
  assert.equal(parsed.manifest_exists, false);
  assert.ok(parsed.report_path.endsWith("rich-update-report.json"));
  const report = JSON.parse(await readFile(join(out, "graphify-out", "rich-update-report.json"), "utf8"));
  assert.equal(report.status, "error");
  assert.equal(report.llm_richness, "no_llm_observed");
  assert.ok(existsSync(join(out, "graphify-out", "rich-update-history.jsonl")));
});

test("navigation freshen parseArgs accepts setup timeout and explicit refresh/reindex flags", () => {
  const args = parseArgs(["docs", "--timeout-ms", "600000", "--verify-timeout-ms", "120000", "--force-reindex"]);
  assert.equal(args.lane, "docs");
  assert.equal(args.timeoutMs, 600000);
  assert.equal(args.verifyTimeoutMs, 120000);
  assert.equal(args.forceReindex, true);
  const docs = parseArgs(["docs", "--docs-index-path", ".pi/navigation/custom-qmd"]);
  assert.equal(docs.docsIndexPath, ".pi/navigation/custom-qmd");
  const provider = parseArgs(["docs", "--docs-provider", "local"]);
  assert.equal(provider.docsProvider, "local");


  const graph = parseArgs(["graph", "--graphify-mode", "rich-update"]);
  assert.equal(graph.graphifyMode, "rich-update");
  assert.throws(() => parseArgs(["graph", "--graphify-python", "/tmp/graphify-python"]), /unknown argument: --graphify-python/);
});

test("navigation freshen graph rejects legacy Graphify provider aliases and does not provider-hop", async () => {
  assert.throws(() => parseArgs(["graph", "--graphify-backend", "openai"]), /unknown argument: --graphify-backend/);
  assert.throws(() => parseArgs(["graph", "--graphify-fallback-provider", "openai"]), /unknown argument: --graphify-fallback-provider/);

  const root = await makeRepo();
  const graphify = await fakeGraphify(root, "update-fail");
  const report = freshenGraph(root, { graphifyBin: graphify, graphifyMode: "deep", graphifyProvider: "deepseek", env: { PATH: "", PI_NAV_GRAPHIFY_FALLBACK_PROVIDER: "openai" } });

  assert.equal(report.status, "error");
  assert.ok(!report.diagnostics.some(item => /fallback/i.test(item)), JSON.stringify(report.diagnostics));
  assert.match(report.safe_retry, /provider API keys|rerun navigation-freshen graph --graphify-mode deep/i);
});

test("navigation freshen graph supports scoped Graphify output", async () => {
  const root = await makeRepo();
  await mkdir(join(root, "packages", "core"), { recursive: true });
  const graphify = await fakeGraphify(root);
  const report = freshenGraph(root, { graphifyBin: graphify, env: { PATH: "" }, query: "core relationship", scope: "packages/core" });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.equal(report.scope, "packages/core");
  assert.match(report.graphPathRel, /^\.pi\/navigation\/graphify\/generations\/[^/]+\/graph\.json$/);
  assert.ok(existsSync(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json")));
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(config.graph.root, "packages/core");
  assert.match(config.graph.graphPath, /^\.pi\/navigation\/graphify\/generations\/[^/]+\/graph\.json$/);
  assert.equal(state.indexes.graph.root, "packages/core");
  assert.equal(state.indexes.graph.graphPath, config.graph.graphPath);
  assert.ok(report.diagnostics.includes("graph_scope=packages/core"));
});

test("navigation freshen graph reports real missing/update/query failures but accepts an empty query result", async t => {
  const missingRoot = await makeRepo();
  setExtensionRuntimeRootForTests(join(missingRoot, "missing-runtime"));
  t.after(() => setExtensionRuntimeRootForTests());
  const missing = freshenGraph(missingRoot, { env: { PATH: "" } });
  assert.equal(missing.status, "error");
  assert.match(missing.root_cause, /extension-owned Graphify executable is not provisioned/i);
  assert.equal(existsSync(join(missingRoot, ".pi-navigation.json")), false);
  setExtensionRuntimeRootForTests();

  const failRoot = await makeRepo();
  const updateFail = await fakeGraphify(failRoot, "update-fail");
  const failed = freshenGraph(failRoot, { graphifyBin: updateFail, env: { PATH: "" } });
  assert.equal(failed.status, "error");
  assert.match(failed.root_cause, /non-zero status/);
  assert.equal(existsSync(join(failRoot, ".pi-navigation.json")), false);

  const noGraphRoot = await makeRepo();
  const noGraph = await fakeGraphify(noGraphRoot, "no-graph");
  const missingGraph = freshenGraph(noGraphRoot, { graphifyBin: noGraph, env: { PATH: "" } });
  assert.equal(missingGraph.status, "error");
  assert.match(missingGraph.root_cause, /graph\.json.*does not exist/);
  assert.equal(existsSync(join(noGraphRoot, ".pi-navigation.json")), false);

  const queryRoot = await makeRepo();
  const queryFail = await fakeGraphify(queryRoot, "query-fail");
  const verifyFail = freshenGraph(queryRoot, { graphifyBin: queryFail, env: { PATH: "" } });
  assert.equal(verifyFail.status, "error");
  assert.match(verifyFail.root_cause, /Graphify query exited 13/);
  assert.equal(existsSync(join(queryRoot, ".pi-navigation.json")), false);

  const emptyRoot = await makeRepo();
  const queryEmpty = await fakeGraphify(emptyRoot, "query-empty");
  const empty = freshenGraph(emptyRoot, { graphifyBin: queryEmpty, env: { PATH: "" } });
  assert.equal(empty.status, "success", JSON.stringify(empty));
  assert.equal(empty.verify.outputBytes, 0);
  assert.equal(existsSync(join(emptyRoot, ".pi-navigation.json")), true);
});

test("navigation freshen graph rejects generated/vendor/cache paths in graph index", async () => {
  const root = await makeRepo();
  const graphify = await fakeGraphify(root, "unsafe");
  const report = freshenGraph(root, { graphifyBin: graphify, env: { PATH: "" } });

  assert.equal(report.status, "error");
  assert.match(report.root_cause, /generated\/vendor\/cache\/archive/);
  assert.match(report.root_cause, /vendor\/copied/);
  assert.equal(existsSync(join(root, ".pi-navigation.json")), false);
});

test("navigation freshen graph does not retry or publish an unsafe generated-path candidate", async () => {
  const root = await makeRepo();
  const graphify = await fakeGraphify(root, "unsafe-once");

  const report = freshenGraph(root, { graphifyBin: graphify, env: { PATH: "" }, graphifyMode: "deep", query: "project map" });

  assert.equal(report.status, "error", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_quality_verify_failed=true"), JSON.stringify(report.diagnostics));
  assert.ok(!report.diagnostics.some(item => item.startsWith("graphify_quality_repair_retry")), JSON.stringify(report.diagnostics));
  const graph = JSON.parse(await readFile(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "utf8"));
  assert.deepEqual(graph.nodes, [{ source_file: "dist/generated/index.ts" }]);
  assert.equal(existsSync(join(root, ".pi-navigation.json")), false);
});

test("navigation freshen graph allows private config path literals outside graph source/path fields", async () => {
  const root = await makeRepo();
  const graphify = await fakeGraphify(root, "private-config-literal");
  const report = freshenGraph(root, { graphifyBin: graphify, env: { PATH: "" }, graphifyMode: "update", query: "private config vocabulary" });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.match(report.graphPathRel, /^\.pi\/navigation\/graphify\/generations\/[^/]+\/graph\.json$/);
});

test("navigation freshen graph does not destructively replace an unsafe existing graph", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "graph.json"), JSON.stringify({ nodes: [{ source_file: ".pi/navigation/qmd/research-docs/doc.md" }], edges: [] }));
  const graphify = await fakeGraphify(root, "reuse-if-present");

  const report = freshenGraph(root, { graphifyBin: graphify, env: { PATH: "" }, graphifyMode: "update", query: "project map" });

  assert.equal(report.status, "error", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_destructive_preclean_skipped=true"), JSON.stringify(report.diagnostics));
  const graph = JSON.parse(await readFile(join(graphDir, "graph.json"), "utf8"));
  assert.deepEqual(graph.nodes, [{ source_file: ".pi/navigation/qmd/research-docs/doc.md" }]);
});

test("navigation freshen graph does not destructively replace a scope-mismatched graph", async () => {
  const root = await makeRepo();
  await mkdir(join(root, "framework-research"), { recursive: true });
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "graph.json"), JSON.stringify({ nodes: ["old-root"], edges: [] }));
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", graphPath: ".pi/navigation/graphify/graphify-out/graph.json", root: ".", refreshStatus: "degraded", lastRefreshFailure: { rootCause: "old failure" }, lastRichUpdate: { nodes: 999 } } }));
  await mkdir(join(root, ".pi", "navigation"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { graph: { root: ".", updatedAt: "2026-01-01T00:00:00.000Z", refreshStatus: "degraded", lastRefreshFailure: { rootCause: "old failure" }, lastRichUpdate: { nodes: 999 } } } }));
  const graphify = await fakeGraphify(root, "reuse-if-present");

  const report = freshenGraph(root, { graphifyBin: graphify, env: { PATH: "" }, graphifyMode: "update", scope: "framework-research", query: "project map" });

  assert.equal(report.status, "error", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_destructive_preclean_skipped=true"), JSON.stringify(report.diagnostics));
  assert.ok(report.diagnostics.some(item => item.includes("scope_changed:.->framework-research")), JSON.stringify(report.diagnostics));
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  const graph = JSON.parse(await readFile(join(graphDir, "graph.json"), "utf8"));
  assert.equal(config.graph.root, ".");
  assert.equal(config.graph.refreshStatus, "ready");
  assert.equal(config.graph.sourceFreshnessStatus, "blocked");
  assert.deepEqual(graph.nodes, ["old-root"]);
});

test("navigation freshen graph preserves an immutable prior generation when destructive scope repair fails", async () => {
  const root = await makeRepo();
  await mkdir(join(root, "framework-research"), { recursive: true });
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  const graphPath = join(graphDir, "graph.json");
  await mkdir(graphDir, { recursive: true });
  const priorGraph = JSON.stringify({ nodes: [{ source_file: "src/read/mod.rs" }], edges: [] });
  await writeFile(graphPath, priorGraph);
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ graph: { enabled: true, backend: "Graphify", graphPath: ".pi/navigation/graphify/graphify-out/graph.json", root: "." } }));
  await mkdir(join(root, ".pi", "navigation"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({ indexes: { graph: { graphPath: ".pi/navigation/graphify/graphify-out/graph.json", root: "." } } }));

  const report = freshenGraph(root, { graphifyBin: await fakeGraphify(root, "update-fail"), env: { PATH: "" }, graphifyMode: "update", scope: "framework-research", query: "project map" });

  assert.equal(report.status, "error", JSON.stringify(report));
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  assert.match(config.graph.graphPath, /^\.pi\/navigation\/graphify\/generations\/[^/]+\/graph\.json$/);
  const preservedPath = join(root, config.graph.graphPath);
  assert.equal(existsSync(preservedPath), true, "failed destructive refresh must leave a queryable immutable graph");
  assert.equal(await readFile(preservedPath, "utf8"), priorGraph);
  const pointer = JSON.parse(await readFile(join(root, ".pi", "navigation", "graphify", "current.json"), "utf8"));
  assert.equal(pointer.id, config.graph.graphPath.split("/")[4]);
});

test("navigation freshen local update forces and publishes a smaller owned graph", async () => {
  const root = await makeRepo();
  const graphDir = join(root, ".pi", "navigation", "graphify", "graphify-out");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "graph.json"), JSON.stringify({ nodes: Array.from({ length: 265 }, (_, index) => `old-${index}`), edges: [] }));
  const newerThanPolicy = new Date(Date.now() + 60_000);
  await utimes(join(graphDir, "graph.json"), newerThanPolicy, newerThanPolicy);
  const graphify = await fakeGraphify(root, "refuse-shrink");

  const report = freshenGraph(root, { graphifyBin: graphify, env: { PATH: "" }, graphifyMode: "update", query: "project map" });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_local_update=true"), JSON.stringify(report.diagnostics));
  const graph = JSON.parse(await readFile(join(graphDir, "graph.json"), "utf8"));
  assert.equal(graph.nodes.length, 155);
  const args = JSON.parse(await readFile(join(root, ".pi", "navigation", "graphify", ".graphify-update-args.json"), "utf8").catch(() => "null"));
  if (args) assert.ok(args.includes("--force"));
});

test("navigation freshen forced local update reconciles a newer Graphify ignore policy", async () => {
  const root = await makeRepo();
  await mkdir(join(root, ".pi", "navigation", "graphify", "graphify-out"), { recursive: true });
  await writeFile(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), JSON.stringify({ nodes: ["stale"], edges: [] }));
  const old = new Date(Date.now() - 60_000);
  await utimes(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), old, old);
  await writeFile(join(root, ".graphifyignore"), "vendor/\n");
  const graphify = await fakeGraphify(root, "reuse-if-present");
  const report = freshenGraph(root, { graphifyBin: graphify, env: { PATH: "" }, graphifyMode: "update" });

  assert.equal(report.status, "success", JSON.stringify(report));
  assert.ok(report.diagnostics.includes("graphify_ignore_policy_changed=true"), JSON.stringify(report.diagnostics));
  const graph = JSON.parse(await readFile(join(root, ".pi", "navigation", "graphify", "graphify-out", "graph.json"), "utf8"));
  assert.deepEqual(graph.nodes, ["fresh"]);
});

test("navigation freshen CLI loads private navigation.yaml for Graphify provider/model", async t => {
  const root = await makeRepo();
  const home = await fixture();
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(join(home, ".pi", "agent", "navigation.yaml"), `
providers:
  allow_cloud: true
  allow_llm: true
  defaults:
    llm: deepseek
  deepseek:
    model: deepseek-v4-flash
backends:
  graph:
    mode: deepExtract
    provider: deepseek
    model: deepseek-v4-flash
`);
  const graphify = await fakeGraphify(root);
  t.after(() => setExtensionRuntimeRootForTests());
  const { stdout } = await execFileP(process.execPath, [FRESHEN.pathname, "graph", "--path", root, "--query", "read docs relationship", "--json"], {
    env: { ...process.env, HOME: home, PATH: "", PI_NAV_TEST_RUNTIME_ROOT: join(root, ".runtime") },
    timeout: 10_000,
  });
  const report = JSON.parse(stdout);
  assert.equal(report.status, "success", JSON.stringify(report));
  const args = JSON.parse(await readFile(join(root, ".pi", "navigation", "graphify", ".graphify-extract-args.json"), "utf8"));
  assert.equal(args[0], "extract");
  assert.equal(args[args.indexOf("--backend") + 1], "deepseek");
  assert.equal(args[args.indexOf("--model") + 1], "deepseek-v4-flash");
  const config = JSON.parse(await readFile(join(root, ".pi-navigation.json"), "utf8"));
  assert.equal(config.graph.provider, "deepseek");
  assert.equal(config.graph.model, "deepseek-v4-flash");
});

test("navigation freshen CLI rejects external Graphify executable overrides", async () => {
  const root = await makeRepo();
  const graphify = await fakeGraphify(root);
  await assert.rejects(
    execFileP(process.execPath, [FRESHEN.pathname, "graph", "--path", root, "--graphify-bin", graphify, "--json"], { env: { ...process.env, PATH: "" }, timeout: 10_000 }),
    /unknown argument: --graphify-bin/,
  );
});
