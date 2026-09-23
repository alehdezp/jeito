//! Exercise the actual private CLI protocol, not a simulated maintenance backend.
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use pi_nav::cache::OutlineCache;
use pi_nav::index::evidence;
use rusqlite::{Connection, TransactionBehavior};
use serde_json::json;

#[test]
fn supervised_updater_keeps_live_queries_available_and_stops_when_parent_pipe_closes() {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap();
    let root = base.join("project");
    let database = base.join("cache/evidence.sqlite");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("main.rs"), "pub fn Kept() {}\n").unwrap();
    let request = json!({"root": root, "database": database, "max_entries": 100,
        "max_bytes": 1_000_000, "timeout_ms": 30_000, "policy_files": []});
    let mut child = Command::new(env!("CARGO_BIN_EXE_pi-nav"))
        .arg("update-index")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut parent = child.stdin.take().unwrap();
    writeln!(parent, "{request}").unwrap();
    // Keep the parent's pipe alive: wait_with_output otherwise closes child.stdin.
    let output = child.wait_with_output().unwrap();
    drop(parent);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["generation"], 1);
    assert_eq!(result["files"], 1);

    let mut blocker = Connection::open(&database).unwrap();
    let transaction = blocker
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_pi-nav"))
        .arg("update-index")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut parent = child.stdin.take().unwrap();
    writeln!(parent, "{request}").unwrap();
    // The writer cannot publish while this transaction is held. Live navigation uses
    // its ordinary native core, not the writer connection or a maintenance queue.
    let live = pi_nav::run("Kept", &root, None, None, None, &OutlineCache::new());
    drop(parent); // Also what the OS does when the owning Pi process dies.
    let deadline = Instant::now() + Duration::from_secs(10);
    let exit = loop {
        if let Some(exit) = child.try_wait().unwrap() {
            break exit;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("updater continued after its parent pipe closed");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    transaction.rollback().unwrap();
    assert_eq!(exit.code(), Some(75));
    assert!(live.unwrap().contains("Kept"));
    assert_eq!(
        evidence::status(&root, &database)
            .unwrap()
            .unwrap()
            .generation,
        1
    );
    assert_eq!(
        blocker
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}
