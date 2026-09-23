import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileP = promisify(execFile);
const HELPER = new URL("../scripts/graphify-rich-update.py", import.meta.url);

async function decide(existing, current, mutableSources, retiredSources = []) {
  const program = String.raw`
import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location("graphify_rich_update", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(sys.argv[2])
result = module.provenance_checked_shrink(
    payload["existing"], payload["current"], set(payload["mutable"]), pathlib.Path("/repo"), set(payload["retired"])
)
print(json.dumps(result))
`;
  const { stdout } = await execFileP("python3", ["-c", program, HELPER.pathname, JSON.stringify({ existing, current, mutable: mutableSources, retired: retiredSources })]);
  return JSON.parse(stdout);
}

const node = (id, source_file) => ({ id, source_file });
const edge = source_file => ({ source: "a", target: "b", source_file });

test("Graphify shrink recovery automatically accepts losses owned by deleted or changed files", async () => {
  const existing = {
    nodes: [node("keep", "src/keep.ts"), node("old-a", "src/deleted.ts"), node("old-b", "src/deleted.ts")],
    links: [edge("src/keep.ts"), edge("src/deleted.ts")],
    hyperedges: [],
  };

  const current = {
    nodes: [node("keep", "src/keep.ts")],
    edges: [edge("src/keep.ts")],
    hyperedges: [],
  };
  const result = await decide(existing, current, ["src/deleted.ts"]);
  assert.equal(result.safe, true, JSON.stringify(result));
  assert.equal(result.attributed_drop_count, 3);
  assert.equal(result.unexplained_drop_count, 0);
});

test("Graphify shrink recovery attributes unchanged-owner edges removed with changed endpoints", async () => {
  const existing = {
    nodes: [node("changed", "src/changed.ts"), node("stable", "src/stable.ts")],
    links: [{ source: "changed", target: "stable", relation: "calls", source_file: "src/stable.ts" }],
  };
  const current = { nodes: [node("stable", "src/stable.ts")], edges: [] };
  const result = await decide(existing, current, ["src/changed.ts"]);
  assert.equal(result.safe, true);
  assert.equal(result.unexplained_drop_count, 0);
  assert.ok(result.attributed_sample.some(row => row.category === "edges" && row.reason === "endpoint_changed_or_deleted"));
});

test("Graphify shrink recovery treats rename as old-source pruning plus new-source addition", async () => {
  const existing = { nodes: [node("old", "src/old-name.ts")], links: [], hyperedges: [] };
  const current = { nodes: [node("new", "src/new-name.ts")], edges: [], hyperedges: [] };
  const result = await decide(existing, current, ["src/old-name.ts", "src/new-name.ts"]);
  assert.equal(result.safe, true, JSON.stringify(result));
  assert.equal(result.attributed_sample[0].source, "src/old-name.ts");
});

test("Graphify shrink recovery accepts losses from sources no longer selected by current detection", async () => {
  const existing = { nodes: [node("keep", "src/keep.ts"), node("vendor", "vendor/old-package")], links: [], hyperedges: [] };
  const current = { nodes: [node("keep", "src/keep.ts")], edges: [], hyperedges: [] };
  const result = await decide(existing, current, [], ["vendor/old-package"]);
  assert.equal(result.safe, true, JSON.stringify(result));
  assert.equal(result.retired_source_count, 1);
  assert.equal(result.attributed_sample[0].reason, "no_longer_detected");
});

test("Graphify manifest reconciliation preserves unchanged files and removes stale deleted entries", async () => {
  const program = String.raw`
import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location("graphify_rich_update", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
files = {"src/keep.ts": {"mtime": 1}, "src/changed.ts": {"mtime": 1}, ".ua/trash.json": {"mtime": 1}, "vendor/old.ts": {"mtime": 1}}
detected = {"src/changed.ts": {"mtime": 2}}
print(json.dumps(module.reconcile_manifest(files, detected, [pathlib.Path("/repo/.ua/trash.json"), pathlib.Path("/repo/vendor/old.ts")], pathlib.Path("/repo"))))
`;
  const { stdout } = await execFileP("python3", ["-c", program, HELPER.pathname]);
  assert.deepEqual(JSON.parse(stdout), { "src/keep.ts": { mtime: 1 }, "src/changed.ts": { mtime: 2 } });
});

test("Graphify exact manifest projects current detection instead of category buckets or stale selected paths", async () => {
  const program = String.raw`
import importlib.util, json, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location("graphify_rich_update", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = pathlib.Path(tempfile.mkdtemp())
(root / "src").mkdir()
(root / "src/current.ts").write_text("export const current = 1;\n")
(root / "src/stale.ts").write_text("export const stale = 1;\n")
existing = {"src/stale.ts": {"mtime": 1, "ast_hash": "old", "semantic_hash": "old"}}
result = module.exact_manifest_for_detected(existing, {"code": [str(root / "src/current.ts")], "document": []}, root)
print(json.dumps(result))
`;
  const { stdout } = await execFileP("python3", ["-c", program, HELPER.pathname]);
  const result = JSON.parse(stdout);
  assert.deepEqual(Object.keys(result), ["src/current.ts"]);
  assert.equal(typeof result["src/current.ts"].mtime, "number");
  assert.match(result["src/current.ts"].ast_hash, /^[a-f0-9]{32}$/);
  assert.equal(result["src/current.ts"].semantic_hash, result["src/current.ts"].ast_hash);
});

test("Graphify incremental identity collisions preserve unchanged-source nodes", async () => {
  const program = String.raw`
import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location("graphify_rich_update", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
existing = {"nodes": [{"id": "shared", "source_file": "src/unchanged.ts"}]}
extraction = {"nodes": [{"id": "shared", "source_file": "src/changed.ts"}], "edges": [{"source": "shared", "target": "other", "source_file": "src/changed.ts"}], "hyperedges": []}
count = module.protect_unchanged_node_ids(extraction, existing, {"src/changed.ts"}, pathlib.Path("/repo"))
print(json.dumps({"count": count, "extraction": extraction}))
`;
  const { stdout } = await execFileP("python3", ["-c", program, HELPER.pathname]);
  const result = JSON.parse(stdout);
  assert.equal(result.count, 1);
  assert.match(result.extraction.nodes[0].id, /^shared@@/);
  assert.equal(result.extraction.edges[0].source, result.extraction.nodes[0].id);
});

test("Graphify shrink diagnostics report fuzzy-dedup or unknown-provenance loss without blocking publication", async () => {
  const existing = {
    nodes: [node("changed", "src/changed.ts"), node("unrelated", "src/unrelated.ts"), node("unknown", undefined)],
    links: [edge("src/unrelated.ts")],
    hyperedges: [],
  };
  const current = {
    nodes: [node("changed-new", "src/changed.ts")],
    edges: [],
    hyperedges: [],
  };
  const result = await decide(existing, current, ["src/changed.ts"]);
  assert.equal(result.safe, false, JSON.stringify(result));
  assert.ok(result.unexplained_sample.some(row => row.source === "src/unrelated.ts"));
  assert.ok(result.unexplained_sample.some(row => row.source === "<unknown>"));
});

test("Graphify failure taxonomy distinguishes retryable provider errors from fail-closed errors", async () => {
  const program = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("graphify_rich_update", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
values = [module.classify_failure(RuntimeError(text)) for text in ["provider quota exceeded", "network connection timeout", "invalid API key", "video transcription unsupported", "malformed candidate"]]
print(json.dumps(values))
`;
  const { stdout } = await execFileP("python3", ["-c", program, HELPER.pathname]);
  assert.deepEqual(JSON.parse(stdout), [
    ["transient_provider", "retry_next_lifecycle"],
    ["transient_provider", "retry_next_lifecycle"],
    ["provider_authentication", "fail_closed"],
    ["unsupported_media", "fail_closed"],
    ["incremental_backend_error", "retry_next_lifecycle"],
  ]);
});

test("Graphify shrink publication is unconditional even when provenance cannot attribute the reduction", async () => {
  const result = await decide(
    { nodes: [node("old", "src/a.ts")], links: [], hyperedges: [] },
    { nodes: [], edges: [], hyperedges: [] },
    [],
  );
  assert.equal(result.safe, false, "provenance remains diagnostic evidence rather than a publication gate");
  const source = await readFile(HELPER, "utf8");
  assert.match(source, /to_json\(graph, communities, str\(graph_path\), force=True\)/);
  assert.doesNotMatch(source, /raise UnsafeShrinkError/);
});
