#!/usr/bin/env python3
"""Graphify rich incremental update helper for jeito-codeweave-pi.

Runs under the Graphify Python environment. It updates the prepared graph at
.pi/navigation/graphify/graphify-out/graph.json using Graphify's Python API:

detect_incremental -> AST for changed code -> LLM semantic extraction for changed
non-code files -> build_merge -> save_manifest.

It prints one JSON object to stdout and sends backend chatter to stderr.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

CODE_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java",
    ".cpp", ".c", ".rb", ".swift", ".kt", ".kts", ".cs", ".scala", ".php",
    ".cc", ".cxx", ".hpp", ".h", ".lua", ".sh", ".bash", ".zsh", ".fish",
}
SEMANTIC_CATEGORIES = ("document", "paper", "image")
REPORT_NAME = "rich-update-report.json"
HISTORY_NAME = "rich-update-history.jsonl"
# F3: bound history growth by rotating to .1 when it exceeds this size.
# Mirrors the perf-telemetry rotation. 0 disables rotation.
DEFAULT_HISTORY_MAX_BYTES = 5 * 1024 * 1024



def classify_failure(exc: Exception) -> tuple[str, str]:
    text = str(exc).lower()
    # Graph size reduction is a normal result of deletions, refactors, parser
    # changes, and source-policy cleanup. It is never a refresh failure.
    if "video" in text or "audio" in text or "transcrib" in text:
        return "unsupported_media", "fail_closed"
    if "unauthor" in text or "authentication" in text or "api key" in text or "forbidden" in text:
        return "provider_authentication", "fail_closed"
    if "quota" in text or "rate limit" in text or "timeout" in text or "timed out" in text or "network" in text or "connection" in text:
        return "transient_provider", "retry_next_lifecycle"
    if isinstance(exc, json.JSONDecodeError):
        return "malformed_baseline", "baseline_rebuild_allowed"
    return "incremental_backend_error", "retry_next_lifecycle"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def rel_sample(paths: list[Path] | list[str], root: Path, limit: int = 20) -> list[str]:
    out: list[str] = []
    for item in paths[:limit]:
        p = Path(item)
        try:
            out.append(p.resolve().relative_to(root.resolve()).as_posix())
        except Exception:
            out.append(str(p).replace("\\", "/"))
    return out


def classify_richness(result: dict) -> str:
    operation = str(result.get("operation") or "")
    semantic_count = int(result.get("semantic_file_count", 0) or 0)
    code_count = int(result.get("code_file_count", 0) or 0)
    deleted_count = int(result.get("deleted_count", 0) or 0)
    tokens = int(result.get("input_tokens", 0) or 0) + int(result.get("output_tokens", 0) or 0)
    if operation == "rich_noop":
        return "unchanged_noop"
    if semantic_count > 0 and tokens > 0:
        return "llm_semantic_extraction"
    if semantic_count > 0:
        return "semantic_files_detected_no_token_count"
    if code_count > 0:
        return "local_ast_only"
    if deleted_count > 0:
        return "delete_prune_only"
    return "no_llm_observed"


def history_max_bytes() -> int:
    """F3: history rotation threshold from env, default 5 MB. 0 disables."""
    raw = str(os.environ.get("PI_NAV_GRAPHIFY_HISTORY_MAX_BYTES", "")).strip()
    if not raw:
        return DEFAULT_HISTORY_MAX_BYTES
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_HISTORY_MAX_BYTES
    return value if value >= 0 else DEFAULT_HISTORY_MAX_BYTES


def rotate_history_if_needed(history_path: Path, max_bytes: int) -> None:
    """F3: rotate history to .1 when it exceeds max_bytes (best-effort, never raises).
    The latest report JSON is always preserved separately and is never rotated."""
    if max_bytes <= 0:
        return
    try:
        if history_path.exists() and history_path.stat().st_size >= max_bytes:
            backup = history_path.with_name(f"{history_path.name}.1")
            os.replace(history_path, backup)
    except Exception:
        pass


def write_report(graph_dir: Path, payload: dict) -> tuple[str, str]:
    graph_dir.mkdir(parents=True, exist_ok=True)
    report_path = graph_dir / REPORT_NAME
    history_path = graph_dir / HISTORY_NAME
    # F5: report is written atomically (temp + os.replace) so a crash never leaves
    # a half-written latest report.
    tmp = report_path.with_name(f"{report_path.name}.tmp.{os.getpid()}")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, report_path)
    # F3: rotate history before appending so growth stays bounded at ~2x threshold.
    rotate_history_if_needed(history_path, history_max_bytes())
    with history_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return str(report_path), str(history_path)


def emit(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(code)


def paths_from(files: dict, categories: tuple[str, ...] | None = None) -> list[Path]:
    cats = categories if categories is not None else tuple(files.keys())
    out: list[Path] = []
    for cat in cats:
        out.extend(Path(p) for p in files.get(cat, []) if p)
    return out


def empty_extraction() -> dict:
    return {"nodes": [], "edges": [], "hyperedges": [], "input_tokens": 0, "output_tokens": 0}

def prune_deleted_manifest(files: dict, deleted: list[Path] | list[str], root: Path) -> dict:
    deleted_sources = {source_identity(item, root) for item in deleted}
    return {key: value for key, value in (files or {}).items() if source_identity(key, root) not in deleted_sources}

def reconcile_manifest(existing: dict, detected: dict, deleted: list[Path] | list[str], root: Path) -> dict:
    reconciled = prune_deleted_manifest(existing, deleted, root)
    reconciled.update(detected or {})
    return reconciled

def exact_manifest_for_detected(existing: dict, detected: dict, root: Path) -> dict:
    existing_by_source = {source_identity(key, root): value for key, value in (existing or {}).items()}
    manifest: dict[str, dict] = {}
    for file_path in paths_from(detected):
        source = source_identity(file_path, root)
        try:
            mtime = file_path.stat().st_mtime
        except OSError:
            continue
        prior = existing_by_source.get(source)
        if isinstance(prior, dict) and prior.get("mtime") == mtime and isinstance(prior.get("ast_hash"), str) and isinstance(prior.get("semantic_hash"), str):
            manifest[source] = prior
            continue
        digest = hashlib.md5()
        try:
            with file_path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        except OSError:
            continue
        content_hash = digest.hexdigest()
        manifest[source] = {"mtime": mtime, "ast_hash": content_hash, "semantic_hash": content_hash}
    return manifest


def write_manifest_exact(manifest_path: Path, files: dict) -> None:
    temporary = manifest_path.with_name(f"{manifest_path.name}.tmp.{os.getpid()}")
    temporary.write_text(json.dumps(files, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, manifest_path)


def merge_extractions(*chunks: dict) -> dict:
    nodes = []
    seen = set()
    edges = []
    hyperedges = []
    input_tokens = 0
    output_tokens = 0
    for chunk in chunks:
        for node in chunk.get("nodes", []):
            node_id = node.get("id")
            if node_id and node_id not in seen:
                seen.add(node_id)
                nodes.append(node)
        edges.extend(chunk.get("edges", []))
        hyperedges.extend(chunk.get("hyperedges", []))
        input_tokens += int(chunk.get("input_tokens", 0) or 0)
        output_tokens += int(chunk.get("output_tokens", 0) or 0)
    return {"nodes": nodes, "edges": edges, "hyperedges": hyperedges, "input_tokens": input_tokens, "output_tokens": output_tokens}

def source_identity(value: object, root: Path) -> str:
    if not isinstance(value, (str, os.PathLike)) or not str(value).strip():
        return "<unknown>"
    normalized = str(value).strip().replace("\\", "/")
    path_value = Path(normalized)
    try:
        if path_value.is_absolute():
            return path_value.resolve().relative_to(root.resolve()).as_posix()
    except Exception:
        return normalized
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized or "<unknown>"


def source_counts(items: list[dict], root: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        source = source_identity(item.get("source_file"), root)
        counts[source] = counts.get(source, 0) + 1
    return counts


def provenance_checked_shrink(existing: dict, current: dict, mutable_sources: set[str], root: Path, retired_sources: set[str] | None = None) -> dict:
    """Approve only losses owned by changed/deleted or no-longer-detected sources."""
    retired_sources = retired_sources or set()
    attributed_counts: dict[tuple[str, str, str], int] = {}
    unexplained_counts: dict[tuple[str, str], int] = {}

    def classify(category: str, source: str, count: int = 1, endpoint_sources: tuple[str, ...] = ()) -> None:
        reason = None
        if source in mutable_sources:
            reason = "changed_or_deleted"
        elif source in retired_sources:
            reason = "no_longer_detected"
        elif any(item in mutable_sources for item in endpoint_sources):
            reason = "endpoint_changed_or_deleted"
        elif any(item in retired_sources for item in endpoint_sources):
            reason = "endpoint_no_longer_detected"
        if reason:
            key = (category, source, reason)
            attributed_counts[key] = attributed_counts.get(key, 0) + count
        else:
            key = (category, source)
            unexplained_counts[key] = unexplained_counts.get(key, 0) + count

    for category, before_items, after_items in (
        ("nodes", list(existing.get("nodes", []) or []), list(current.get("nodes", []) or [])),
        ("hyperedges", list(existing.get("hyperedges", []) or []), list(current.get("hyperedges", []) or [])),
    ):
        before = source_counts(before_items, root)
        after = source_counts(after_items, root)
        for source, old_count in before.items():
            dropped = old_count - after.get(source, 0)
            if dropped > 0:
                classify(category, source, dropped)

    existing_nodes = {str(node.get("id")): source_identity(node.get("source_file"), root) for node in existing.get("nodes", []) or [] if isinstance(node, dict) and node.get("id") is not None}
    before_edges = list(existing.get("links", existing.get("edges", [])) or [])
    after_edges = list(current.get("edges", []) or [])
    def edge_signature(edge: dict) -> tuple[str, str, str, str]:
        return (str(edge.get("source", edge.get("_src", ""))), str(edge.get("target", edge.get("_tgt", ""))), str(edge.get("relation", edge.get("kind", edge.get("type", "")))), source_identity(edge.get("source_file"), root))
    remaining: dict[tuple[str, str, str, str], int] = {}
    for edge in after_edges:
        signature = edge_signature(edge)
        remaining[signature] = remaining.get(signature, 0) + 1
    for edge in before_edges:
        signature = edge_signature(edge)
        if remaining.get(signature, 0) > 0:
            remaining[signature] -= 1
            continue
        source = source_identity(edge.get("source_file"), root)
        endpoint_sources = (existing_nodes.get(signature[0], "<unknown>"), existing_nodes.get(signature[1], "<unknown>"))
        classify("edges", source, 1, endpoint_sources)

    attributed = [{"category": category, "source": source, "dropped": count, "reason": reason} for (category, source, reason), count in attributed_counts.items()]
    unexplained = [{"category": category, "source": source, "dropped": count} for (category, source), count in unexplained_counts.items()]
    return {
        "safe": bool(attributed) and not unexplained,
        "mutable_source_count": len(mutable_sources),
        "retired_source_count": len(retired_sources),
        "attributed_drop_count": sum(row["dropped"] for row in attributed),
        "unexplained_drop_count": sum(row["dropped"] for row in unexplained),
        "attributed_sample": attributed[:20],
        "unexplained_sample": unexplained[:20],
        "attributed_sample_omitted": max(0, len(attributed) - 20),
        "unexplained_sample_omitted": max(0, len(unexplained) - 20),
    }


def graph_sources(graph: dict, root: Path) -> set[str]:
    sources: set[str] = set()
    for key in ("nodes", "links", "edges", "hyperedges"):
        for item in list(graph.get(key, []) or []):
            if isinstance(item, dict):
                source = source_identity(item.get("source_file"), root)
                if source != "<unknown>":
                    sources.add(source)
    return sources

def protect_unchanged_node_ids(extraction: dict, existing_graph: dict, mutable_sources: set[str], root: Path) -> int:
    existing = {str(node.get("id")): source_identity(node.get("source_file"), root) for node in existing_graph.get("nodes", []) or [] if node.get("id") is not None}
    occupied = set(existing)
    remap: dict[str, str] = {}
    for node in extraction.get("nodes", []) or []:
        node_id = str(node.get("id")) if node.get("id") is not None else ""
        source = source_identity(node.get("source_file"), root)
        if node_id in remap:
            node["id"] = remap[node_id]
            continue
        prior_source = existing.get(node_id)
        if not node_id or not prior_source or prior_source in mutable_sources or source == prior_source or source == "<unknown>":
            continue
        suffix = hashlib.sha1(source.encode("utf-8")).hexdigest()[:10]
        replacement = f"{node_id}@@{suffix}"
        counter = 2
        while replacement in occupied:
            replacement = f"{node_id}@@{suffix}-{counter}"
            counter += 1
        node["id"] = replacement
        occupied.add(replacement)
        remap[node_id] = replacement
    if not remap:
        return 0
    def replace_refs(value):
        if isinstance(value, str):
            return remap.get(value, value)
        if isinstance(value, list):
            return [replace_refs(item) for item in value]
        if isinstance(value, dict):
            return {key: replace_refs(item) for key, item in value.items()}
        return value
    extraction["edges"] = [replace_refs(edge) for edge in extraction.get("edges", []) or []]
    extraction["hyperedges"] = [replace_refs(edge) for edge in extraction.get("hyperedges", []) or []]
    return len(remap)


def extract_ast(code_files: list[Path]) -> dict:
    if not code_files:
        return empty_extraction()
    from graphify.extract import collect_files, extract

    expanded: list[Path] = []
    for file in code_files:
        expanded.extend(collect_files(file) if file.is_dir() else [file])
    with contextlib.redirect_stdout(sys.stderr):
        result = extract(expanded, cache_root=Path("."))
    result.setdefault("hyperedges", [])
    result.setdefault("input_tokens", 0)
    result.setdefault("output_tokens", 0)
    return result


def build_incremental_graph(existing_graph: dict, extraction: dict, removed_sources: set[str], root: Path):
    """Merge a delta without rerunning Graphify's whole-graph canonicalizers."""
    import networkx as nx
    from graphify.build import build

    graph = nx.MultiGraph()
    for node in existing_graph.get("nodes", []) or []:
        if not isinstance(node, dict) or source_identity(node.get("source_file"), root) in removed_sources or node.get("id") is None:
            continue
        graph.add_node(node["id"], **{key: value for key, value in node.items() if key != "id"})
    links = existing_graph.get("links", existing_graph.get("edges", [])) or []
    for edge in links:
        if not isinstance(edge, dict) or source_identity(edge.get("source_file"), root) in removed_sources:
            continue
        source = edge.get("source")
        target = edge.get("target")
        if source not in graph or target not in graph:
            continue
        attrs = {key: value for key, value in edge.items() if key not in {"source", "target"}}
        attrs["_src"] = source
        attrs["_tgt"] = target
        graph.add_edge(source, target, **attrs)

    delta = build([extraction], directed=False, dedup=False, root=root)
    runtime_remap: dict[str, str] = {}
    occupied = set(graph.nodes())
    for node_id, attrs in delta.nodes(data=True):
        candidate = node_id
        source = source_identity(attrs.get("source_file"), root)
        if candidate in graph and source_identity(graph.nodes[candidate].get("source_file"), root) != source:
            suffix = hashlib.sha1(source.encode("utf-8")).hexdigest()[:10]
            candidate = f"{node_id}@@{suffix}"
            counter = 2
            while candidate in occupied:
                candidate = f"{node_id}@@{suffix}-{counter}"
                counter += 1
            runtime_remap[node_id] = candidate
        occupied.add(candidate)
        graph.add_node(candidate, **dict(attrs))
    skipped_edge_collisions = 0
    for source, target, attrs in delta.edges(data=True):
        source = runtime_remap.get(source, source)
        target = runtime_remap.get(target, target)
        graph.add_edge(source, target, **dict(attrs))

    retained_hyperedges = [edge for edge in existing_graph.get("hyperedges", []) or [] if isinstance(edge, dict) and source_identity(edge.get("source_file"), root) not in removed_sources]
    graph.graph["hyperedges"] = [*retained_hyperedges, *(extraction.get("hyperedges", []) or [])]
    return graph, len(runtime_remap), skipped_edge_collisions


def install_safe_tokenizer() -> None:
    """Make repository control-token literals ordinary source text for counting.

    Graphify uses a cl100k tokenizer to estimate chunk sizes before sending
    files to the provider. A repository may legitimately document strings such
    as ``<|endoftext|>``; those strings are not control tokens in source text.
    Configure the cached tokenizer once so such input cannot abort the entire
    refresh before Graphify's per-chunk failure handling can run.
    """
    import graphify.llm as graphify_llm

    tokenizer = getattr(graphify_llm, "_TOKENIZER", None)
    if tokenizer is None or getattr(tokenizer, "_pi_navigation_safe_special_tokens", False):
        return

    class SafeTokenizer:
        _pi_navigation_safe_special_tokens = True

        def __init__(self, wrapped):
            self._wrapped = wrapped

        def encode(self, text, *args, **kwargs):
            # Source files are untrusted corpus text, never model control
            # messages. Encode reserved-looking strings as ordinary text.
            kwargs["disallowed_special"] = ()
            return self._wrapped.encode(text, *args, **kwargs)

        def __getattr__(self, name):
            return getattr(self._wrapped, name)

    graphify_llm._TOKENIZER = SafeTokenizer(tokenizer)


def extract_semantic(files: list[Path], provider: str, model: str | None, target: Path, max_concurrency: int) -> dict:
    if not files:
        return empty_extraction()
    install_safe_tokenizer()
    from graphify.llm import extract_corpus_parallel

    with contextlib.redirect_stdout(sys.stderr):
        return extract_corpus_parallel(
            files,
            backend=provider,
            model=model or None,
            root=target,
            chunk_size=20,
            max_concurrency=max_concurrency,
            deep_mode=True,
        )


def incremental_update(target: Path, graph_path: Path, manifest_path: Path, provider: str, model: str | None, max_concurrency: int) -> dict:
    existing_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    from graphify.cluster import cluster
    from graphify.detect import detect_incremental
    from graphify.export import to_json

    with contextlib.redirect_stdout(sys.stderr):
        inc = detect_incremental(target, str(manifest_path), kind="semantic")
    new_files = inc.get("new_files", {})
    deleted = list(inc.get("deleted_files", []) or [])
    manifest_files = exact_manifest_for_detected(existing_manifest, inc.get("files", {}) or {}, target)
    videos = paths_from(new_files, ("video",))
    if videos:
        raise RuntimeError("Graphify rich update helper does not transcribe video/audio; run guided /graphify update for media changes")
    code_files = paths_from(new_files, ("code",))
    semantic_files = paths_from(new_files, SEMANTIC_CATEGORIES)
    changed_total = int(inc.get("new_total", 0) or 0)
    if changed_total == 0 and not deleted:
        return {
            "operation": "rich_noop",
            "changed_total": 0,
            "semantic_file_count": 0,
            "code_file_count": 0,
            "deleted_count": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "nodes": None,
            "edges": None,
            "semantic_extraction_observed": False,
            "code_file_sample": [],
            "semantic_file_sample": [],
            "deleted_file_sample": [],
            "detected_total_files": inc.get("total_files", 0),
        }

    existing_graph = json.loads(graph_path.read_text(encoding="utf-8"))
    detected_sources = {source_identity(item, target) for item in manifest_files.keys()}
    retired_sources = {
        source for source in graph_sources(existing_graph, target)
        if source not in detected_sources and not any(candidate.startswith(f"{source.rstrip('/')}/") for candidate in detected_sources)
    }
    mutable_sources = {
        source_identity(item, target)
        for item in [*code_files, *semantic_files, *deleted]
    }
    ast_extraction = extract_ast(code_files)
    semantic_extraction = extract_semantic(semantic_files, provider, model, target, max_concurrency)
    # Graceful degradation, not a hard failure: when the LLM semantic extraction
    # hollows — changed docs were sent but produced NO usable nodes (a filtered
    # response, a reasoning model that spent its whole output budget thinking and
    # never emitted JSON, a missing openai SDK, or any other failure) — do not
    # mark those docs as re-extracted. Leaving their sources in mutable_sources
    # would prune their existing nodes and silently shrink the graph (data loss
    # under a green success). Preserve them and apply only the AST/code changes;
    # the manifest keeps them dirty so the next refresh retries. A legitimately
    # smaller graph (real deletions or refactors that DO re-extract with nodes)
    # is unaffected and never blocks. Token counts are deliberately NOT part of
    # this check: a reasoning-truncation hollow can burn thousands of output
    # tokens while still yielding zero nodes.
    semantic_hollow = bool(semantic_files) and not semantic_extraction.get("nodes")
    if semantic_hollow:
        hollow_sources = {source_identity(item, target) for item in semantic_files}
        mutable_sources = {source for source in mutable_sources if source not in hollow_sources}
    extraction = merge_extractions(ast_extraction, semantic_extraction)
    identity_collision_remaps = protect_unchanged_node_ids(extraction, existing_graph, mutable_sources, target)
    with contextlib.redirect_stdout(sys.stderr):
        # Preserve unchanged baseline rows byte-for-byte at the graph-model
        # level. Graphify's build_merge/build_from_json whole-graph passes also
        # run canonicalizers that can reassign unchanged provenance. Always
        # force the atomic candidate write: a smaller graph is valid current
        # state, not corruption or a reason to strand the published generation.
        graph, runtime_collision_remaps, skipped_edge_collisions = build_incremental_graph(existing_graph, extraction, mutable_sources | retired_sources, target)
        identity_collision_remaps += runtime_collision_remaps
        communities = cluster(graph)
        wrote = to_json(graph, communities, str(graph_path), force=True)
    if not wrote:
        raise RuntimeError("Graphify forced incremental write did not complete")
    shrink_recovery = None
    before_nodes = len(existing_graph.get("nodes", []) or [])
    before_edges = len(existing_graph.get("links", existing_graph.get("edges", [])) or [])
    if graph.number_of_nodes() < before_nodes or graph.number_of_edges() < before_edges:
        current_graph = {
            "nodes": [{"id": node_id, **dict(data)} for node_id, data in graph.nodes(data=True)],
            "edges": [{"source": data.get("_src", source), "target": data.get("_tgt", target), **dict(data)} for source, target, data in graph.edges(data=True)],
            "hyperedges": list(getattr(graph, "graph", {}).get("hyperedges", []) or []),
        }
        shrink_recovery = provenance_checked_shrink(existing_graph, current_graph, mutable_sources, target, retired_sources)
        shrink_recovery.update({"forced": True, "accepted": True, "mode": "unconditional_current_snapshot"})
    if semantic_hollow:
        # Keep hollowed files dirty: restore their prior manifest entry (old
        # mtime/hash) so detect_incremental re-extracts them on the next refresh
        # instead of treating the skipped change as already applied. A brand-new
        # file with no prior entry is simply omitted, which also reads as new.
        for item in semantic_files:
            source = source_identity(item, target)
            prior = (existing_manifest or {}).get(source)
            if isinstance(prior, dict):
                manifest_files[source] = prior
            else:
                manifest_files.pop(source, None)
    write_manifest_exact(manifest_path, manifest_files)
    return {
        "operation": "rich_incremental",
        "changed_total": changed_total,
        "semantic_file_count": len(semantic_files),
        "code_file_count": len(code_files),
        "deleted_count": len(deleted),
        "input_tokens": extraction.get("input_tokens", 0),
        "output_tokens": extraction.get("output_tokens", 0),
        "nodes": graph.number_of_nodes(),
        "edges": graph.number_of_edges(),
        "semantic_extraction_observed": bool(semantic_files),
        "code_file_sample": rel_sample(code_files, target),
        "semantic_file_sample": rel_sample(semantic_files, target),
        "deleted_file_sample": rel_sample(deleted, target),
        "detected_total_files": inc.get("total_files", 0),
        "shrink_recovery": shrink_recovery,
        "identity_collision_remaps": identity_collision_remaps,
        "skipped_edge_collisions": skipped_edge_collisions,
    }
def baseline_rebuild(target: Path, graph_path: Path, manifest_path: Path, provider: str, model: str | None, max_concurrency: int) -> dict:
    """Build a complete candidate in an isolated output directory."""
    from graphify.build import build_merge
    from graphify.cluster import cluster
    from graphify.detect import detect_incremental
    from graphify.export import to_json

    with contextlib.redirect_stdout(sys.stderr):
        inc = detect_incremental(target, str(manifest_path), kind="semantic")
    new_files = inc.get("new_files", {})
    videos = paths_from(new_files, ("video",))
    if videos:
        raise RuntimeError("Graphify baseline rebuild does not transcribe video/audio; run guided Graphify setup for media changes")
    code_files = paths_from(new_files, ("code",))
    semantic_files = paths_from(new_files, SEMANTIC_CATEGORIES)
    extraction = merge_extractions(
        extract_ast(code_files),
        extract_semantic(semantic_files, provider, model, target, max_concurrency),
    )
    with contextlib.redirect_stdout(sys.stderr):
        graph = build_merge([extraction], root=target, directed=False)
        communities = cluster(graph)
        wrote = to_json(graph, communities, str(graph_path), force=True)
    if not wrote or not graph_path.exists():
        raise RuntimeError("Graphify staged baseline rebuild did not write its graph")
    write_manifest_exact(manifest_path, exact_manifest_for_detected({}, inc.get("files", {}) or {}, target))
    return {
        "operation": "baseline_full_rebuild",
        "changed_total": int(inc.get("new_total", 0) or 0),
        "semantic_file_count": len(semantic_files),
        "code_file_count": len(code_files),
        "deleted_count": 0,
        "input_tokens": extraction.get("input_tokens", 0),
        "output_tokens": extraction.get("output_tokens", 0),
        "nodes": graph.number_of_nodes(),
        "edges": graph.number_of_edges(),
        "semantic_extraction_observed": bool(semantic_files),
        "code_file_sample": rel_sample(code_files, target),
        "semantic_file_sample": rel_sample(semantic_files, target),
        "deleted_file_sample": [],
        "detected_total_files": inc.get("total_files", 0),
        "shrink_recovery": {"forced": True, "mode": "baseline_full_rebuild"},
    }


def main(argv: list[str]) -> int:
    if len(argv) < 6:
        emit({"status": "error", "summary": "missing arguments", "diagnostics": ["graphify_rich_update_args_missing=true"]}, 2)
    started_at = utc_now()
    started = time.monotonic()
    root = Path(argv[0]).resolve()
    target = Path(argv[1]).resolve()
    graph_out = Path(argv[2]).resolve()
    provider = argv[3] or "deepseek"
    model = argv[4] or None
    strict_repair = argv[5].lower() in {"1", "true", "yes"}
    repair_reason = argv[6] if len(argv) > 6 else "strict_repair"
    max_concurrency = int(os.environ.get("PI_NAV_GRAPHIFY_RICH_MAX_CONCURRENCY", "2") or "2")
    graph_dir = graph_out / "graphify-out"
    graph_dir.mkdir(parents=True, exist_ok=True)
    graph_path = graph_dir / "graph.json"
    manifest_path = graph_dir / "manifest.json"
    os.chdir(root)

    def finish(payload: dict, code: int) -> None:
        finished_at = utc_now()
        duration_ms = int((time.monotonic() - started) * 1000)
        payload = {
            "schema_version": 1,
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_ms": duration_ms,
            "root": str(root),
            "target": str(target),
            "graph_path": str(graph_path),
            "manifest_path": str(manifest_path),
            "provider": provider,
            "model": model,
            "strict_repair": strict_repair,
            "repair_reason": repair_reason if strict_repair else None,
            **payload,
        }
        payload["llm_richness"] = classify_richness(payload)
        payload["graph_exists"] = graph_path.exists()
        payload["manifest_exists"] = manifest_path.exists()
        report_path, history_path = write_report(graph_dir, payload)
        emit({**payload, "report_path": report_path, "history_path": history_path}, code)

    try:
        if strict_repair:
            result = baseline_rebuild(target, graph_path, manifest_path, provider, model, max_concurrency)
        elif not graph_path.exists():
            finish({
                "status": "error",
                "summary": "Graphify rich incremental update needs an existing deep graph",
                "root_cause": "No owned graph.json exists for build_merge; rich-update refreshes an existing rich graph and must not create or rebuild the full graph.",
                "safe_retry": "Run explicit Graphify deep setup once, then let rich-update maintain the graph incrementally.",
                "failure_class": "baseline_unusable",
                "recovery_decision": "baseline_rebuild_allowed",
                "diagnostics": ["graphify_rich_update_missing_existing_graph=true", "graphify_rich_update_needs_deep_setup=true"],
            }, 1)
        elif not manifest_path.exists():
            finish({
                "status": "error",
                "summary": "Graphify rich incremental update needs an existing manifest",
                "root_cause": "No manifest.json exists for incremental detection; rich-update cannot safely infer changes against an unknown baseline.",
                "safe_retry": "Restore the verified generation pair or perform a staged baseline rebuild.",
                "failure_class": "baseline_unusable",
                "recovery_decision": "baseline_rebuild_allowed",
                "diagnostics": ["graphify_rich_update_missing_manifest=true", "graphify_rich_update_needs_deep_repair=true"],
            }, 1)
        else:
            result = incremental_update(target, graph_path, manifest_path, provider, model, max_concurrency)
        finish({"status": "success", **result}, 0)
    except SystemExit:
        raise
    except Exception as exc:
        failure_class, recovery_decision = classify_failure(exc)
        failure = {
            "root_cause": str(exc),
            "safe_retry": "Retry at the next lifecycle checkpoint." if recovery_decision == "retry_next_lifecycle" else "Repair the reported cause; the prior verified graph remains queryable while refresh is blocked.",
            "failure_class": failure_class,
            "recovery_decision": recovery_decision,
            "diagnostics": ["graphify_rich_update_exception=true", f"exception_type={type(exc).__name__}"],
            "traceback_tail": traceback.format_exc(limit=8),
        }
        finish({
            "status": "error",
            "summary": "Graphify rich refresh failed",
            **failure,
        }, 1)


if __name__ == "__main__":
    main(sys.argv[1:])