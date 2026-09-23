#!/usr/bin/env python3
"""One realistic CRG seam gate: fresh repo, embeddings, daemon watch, atomic save."""
from __future__ import annotations

import json
import os
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Embeddings(BaseHTTPRequestHandler):
    calls = 0

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        values = body.get("input", [])
        if isinstance(values, str):
            values = [values]
        type(self).calls += 1
        payload = {"object": "list", "model": body.get("model", "gate-model"), "data": [
            {"object": "embedding", "index": index, "embedding": [float((index + offset) % 7) / 7 for offset in range(12)]}
            for index, _ in enumerate(values)
        ], "usage": {"prompt_tokens": len(values), "total_tokens": len(values)}}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def run(env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run([sys.executable, "-m", "code_review_graph", *args], env=env, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"{' '.join(args)} failed: {result.stderr or result.stdout}")
    return result


def wait_for(label: str, predicate, timeout: float = 90) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.25)
    raise TimeoutError(label)


def count(db: Path, sql: str, params: tuple = ()) -> int:
    if not db.exists():
        return 0
    try:
        with sqlite3.connect(db) as connection:
            return int(connection.execute(sql, params).fetchone()[0])
    except sqlite3.Error:
        return 0


def watcher_alive(home: Path) -> bool:
    try:
        state = json.loads((home / ".code-review-graph" / "daemon-state.json").read_text())
        pid = int(state["gate"]["pid"])
        os.kill(pid, 0)
        return True
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        return False

def watcher_ready(home: Path) -> bool:
    try:
        return watcher_alive(home) and "Watching " in (home / ".code-review-graph" / "logs" / "gate.log").read_text()
    except OSError:
        return False


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="crg-clean-break-") as temporary:
        base = Path(temporary)
        home, repo = base / "home", base / "repo"
        home.mkdir(); repo.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / "main.py").write_text("def initial_value():\n    return 1\n")

        server = ThreadingHTTPServer(("127.0.0.1", 0), Embeddings)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env = {
            **os.environ,
            "HOME": str(home),
            "PYTHONNOUSERSITE": "1",
            "CRG_OPENAI_API_KEY": "gate-key",
            "OPENAI_API_KEY": "gate-key",
            "CRG_OPENAI_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
            "OPENAI_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
            "CRG_DAEMON_HEALTH_INTERVAL": "1",
        }
        run(env, "daemon", "add", str(repo), "--alias", "gate", "--embedding-provider", "openai", "--embedding-model", "gate-model")
        daemon = subprocess.Popen([sys.executable, "-m", "code_review_graph", "daemon", "start", "--foreground"], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        db = repo / ".code-review-graph" / "graph.db"
        try:
            wait_for("initial graph and embeddings", lambda: count(db, "select count(*) from nodes") > 0 and count(db, "select count(*) from embeddings") > 0)
            wait_for("watcher child", lambda: watcher_ready(home))
            initial_calls = Embeddings.calls

            (repo / "main.py").write_text("def watched_value():\n    return 2\n")
            wait_for("normal save", lambda: count(db, "select count(*) from nodes where name='watched_value'") == 1)
            wait_for("normal-save embedding refresh", lambda: Embeddings.calls > initial_calls)

            stage = repo / ".atomic-stage.py"
            destination = repo / "atomic.py"
            stage.write_text("def atomic_value():\n    return 3\n")
            os.replace(stage, destination)
            wait_for("atomic save", lambda: count(db, "select count(*) from nodes where name='atomic_value'") == 1)

            destination.unlink()
            wait_for("delete", lambda: count(db, "select count(*) from nodes where name='atomic_value'") == 0)
            print(json.dumps({"status": "passed", "nodes": count(db, "select count(*) from nodes"), "vectors": count(db, "select count(*) from embeddings"), "embedding_calls": Embeddings.calls}))
        finally:
            daemon.send_signal(signal.SIGTERM)
            try:
                daemon.wait(timeout=10)
            except subprocess.TimeoutExpired:
                daemon.kill(); daemon.wait(timeout=5)
            server.shutdown(); server.server_close()


if __name__ == "__main__":
    main()
