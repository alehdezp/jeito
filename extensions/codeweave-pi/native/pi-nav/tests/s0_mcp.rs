use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

fn binary() -> String {
    std::env::var("CARGO_BIN_EXE_pi-nav").expect("Cargo supplies the pi-nav binary path")
}

fn run_mcp(root: &Path, edit: bool, requests: &[Value]) -> Vec<Value> {
    let mut command = Command::new(binary());
    command
        .args(["--mcp", "--no-overview", "--scope"])
        .arg(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .current_dir(root.parent().unwrap_or(root));
    if edit {
        command.arg("--edit");
    }

    let mut child = command.spawn().expect("start pi-nav MCP server");
    let mut input = String::new();
    for request in requests {
        input.push_str(&request.to_string());
        input.push('\n');
    }
    child
        .stdin
        .take()
        .expect("MCP stdin")
        .write_all(input.as_bytes())
        .expect("send MCP requests");
    let output = child.wait_with_output().expect("collect MCP output");
    assert!(output.status.success(), "MCP exited: {output:?}");
    String::from_utf8(output.stdout)
        .expect("MCP stdout is UTF-8")
        .lines()
        .map(|line| serde_json::from_str(line).expect("MCP response JSON"))
        .collect()
}

fn initialize(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}}
    })
}

fn successful_text(response: &Value) -> &str {
    assert!(
        response.get("error").is_none(),
        "JSON-RPC error response: {response}"
    );
    let result = response.get("result").expect("JSON-RPC result");
    assert_ne!(
        result.get("isError"),
        Some(&Value::Bool(true)),
        "tool error response: {response}"
    );
    result["content"][0]["text"]
        .as_str()
        .expect("tool response text")
}

fn assert_structured(response: &Value, operation: &str) {
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["schemaVersion"], 1);
    assert_eq!(structured["operation"], operation);
    assert_eq!(structured["completeness"]["complete"], true);
    assert!(structured["completeness"]["total"].is_number());
    assert!(structured["diagnostics"].is_array());
}

fn assert_operation_data_shape(response: &Value, operation: &str) {
    let data = &response["result"]["structuredContent"]["data"];
    let arrays = |keys: &[&str]| {
        for key in keys {
            assert!(
                data[*key].is_array(),
                "{operation} data.{key} must be an array: {response}"
            );
        }
    };
    match operation {
        "pi_nav_search" => {
            assert!(data["kind"].is_string() && data["case"].is_string());
            arrays(&["matches", "locations", "sourceRows"]);
        }
        "pi_nav_read" => arrays(&["files"]),
        "pi_nav_files" => {
            arrays(&["patterns", "entries"]);
            assert!(data["sort"].is_string() && data["visibility"].is_string());
        }
        "pi_nav_ls" => {
            arrays(&["entries"]);
            for key in ["path", "view", "sort", "visibility"] {
                assert!(data[key].is_string());
            }
        }
        "pi_nav_diff" => arrays(&["files", "symbols", "locations"]),
        "pi_nav_deps" | "pi_nav_grok" => arrays(&["relationships", "locations"]),
        "pi_nav_map" => arrays(&["entries"]),
        "pi_nav_overview" => {
            assert!(data["fileCount"].is_number());
            arrays(&["modules", "entryPoints", "tests"]);
        }
        "pi_nav_session" => {
            assert!(data["reads"].is_number() && data["searches"].is_number());
            arrays(&["topQueries", "hotPaths"]);
        }
        "pi_nav_savings" => {
            assert!(data["baselineTokens"].is_number() && data["savedTokens"].is_number())
        }
        other => panic!("missing operation data fixture for {other}"),
    }
}

fn initialized() -> Value {
    json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
}

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(root)
        .status()
        .expect("run git fixture command");
    assert!(status.success(), "git {args:?} failed");
}

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temporary fixture");
    fs::create_dir_all(dir.path().join("src")).expect("fixture source directory");
    fs::write(
        dir.path().join("Cargo.toml"),
        "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n",
    )
    .expect("fixture manifest");
    fs::write(
        dir.path().join("src/lib.rs"),
        "pub fn greet() -> &'static str { \"hello\" }\npub fn caller() -> &'static str { greet() }\n",
    )
    .expect("fixture source");
    git(dir.path(), &["init", "-q"]);
    git(dir.path(), &["config", "user.email", "s0@example.test"]);
    git(dir.path(), &["config", "user.name", "S0"]);
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-qm", "baseline"]);
    fs::write(
        dir.path().join("src/lib.rs"),
        "pub fn greet() -> &'static str { \"updated\" }\npub fn caller() -> &'static str { greet() }\n",
    )
    .expect("fixture change");
    dir
}

#[test]
fn query_mode_has_the_locked_s0_contract_and_retains_baseline_operations() {
    let fixture = fixture();
    let root = fixture.path().to_string_lossy().into_owned();
    let requests = vec![
        initialize(1),
        initialized(),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "pi_nav_search", "arguments": {"query": "greet", "kind": "symbol", "root": root}}}),
        json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "pi_nav_read", "arguments": {"path": "src/lib.rs", "root": root}}}),
        json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "pi_nav_files", "arguments": {"pattern": "*.rs", "root": root}}}),
        json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "pi_nav_search", "arguments": {"query": "greet", "kind": "callers", "root": root}}}),
        json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "pi_nav_grok", "arguments": {"target": "greet", "root": root}}}),
        json!({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "pi_nav_deps", "arguments": {"path": "src/lib.rs", "root": root}}}),
        json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "pi_nav_diff", "arguments": {"source": "uncommitted", "scope": "src/lib.rs"}}}),
        json!({"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "pi_nav_session", "arguments": {"action": "reset"}}}),
        json!({"jsonrpc": "2.0", "id": 11, "method": "tools/call", "params": {"name": "pi_nav_session", "arguments": {"action": "stats"}}}),
        json!({"jsonrpc": "2.0", "id": 12, "method": "tools/call", "params": {"name": "pi_nav_savings", "arguments": {}}}),
        json!({"jsonrpc": "2.0", "id": 13, "method": "tools/call", "params": {"name": "pi_nav_ls", "arguments": {"root": root}}}),
        json!({"jsonrpc": "2.0", "id": 14, "method": "tools/call", "params": {"name": "pi_nav_map", "arguments": {"root": root}}}),
        json!({"jsonrpc": "2.0", "id": 15, "method": "tools/call", "params": {"name": "pi_nav_overview", "arguments": {}}}),
    ];
    let responses = run_mcp(fixture.path(), false, &requests);

    assert_eq!(responses[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(responses[0]["result"]["serverInfo"]["name"], "pi-nav");
    let names: Vec<&str> = responses[1]["result"]["tools"]
        .as_array()
        .expect("tools list")
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name"))
        .collect();
    assert_eq!(
        names,
        [
            "pi_nav_search",
            "pi_nav_read",
            "pi_nav_files",
            "pi_nav_deps",
            "pi_nav_grok",
            "pi_nav_diff",
            "pi_nav_savings",
            "pi_nav_session",
            "pi_nav_ls",
            "pi_nav_map",
            "pi_nav_overview",
        ]
    );
    for tool in responses[1]["result"]["tools"].as_array().unwrap() {
        let schema = &tool["outputSchema"];
        assert_eq!(schema["properties"]["schemaVersion"]["const"], 1);
        assert!(schema["required"]
            .as_array()
            .is_some_and(|keys| keys.len() == 5));
    }

    let expected = [
        ("pi_nav_search", "greet", "matches"),
        ("pi_nav_read", "pub fn greet", "files"),
        ("pi_nav_files", "src/lib.rs", "entries"),
        ("pi_nav_search", "caller", "matches"),
        ("pi_nav_grok", "# grok: greet", "relationships"),
        ("pi_nav_deps", "# Deps:", "relationships"),
        ("pi_nav_diff", "# Diff:", "files"),
        ("pi_nav_session", "Session reset.", "reads"),
        ("pi_nav_session", "Files read:", "reads"),
        ("pi_nav_savings", "No measured reads", "baselineTokens"),
        ("pi_nav_ls", "# Directory:", "entries"),
        ("pi_nav_map", "# Map:", "entries"),
        ("pi_nav_overview", "[pi-nav]", "fileCount"),
    ];
    for (response, (operation, marker, data_key)) in responses[2..].iter().zip(expected) {
        assert_structured(response, operation);
        assert_operation_data_shape(response, operation);
        assert!(
            successful_text(response).contains(marker),
            "baseline operation missing {marker:?}: {response}"
        );
        assert!(
            response["result"]["structuredContent"]["data"]
                .get(data_key)
                .is_some(),
            "{operation} missing typed data key {data_key}: {response}"
        );
    }

    let map = Command::new(binary())
        .args(["--scope", &root, "--map"])
        .output()
        .expect("run map CLI");
    assert!(
        map.status.success() && !map.stdout.is_empty(),
        "map: {map:?}"
    );
    let overview = Command::new(binary())
        .args(["--scope", &root, "overview"])
        .output()
        .expect("run overview CLI");
    assert!(
        overview.status.success() && !overview.stdout.is_empty(),
        "overview: {overview:?}"
    );
}

#[test]
fn plain_and_hashline_reads_preserve_the_same_typed_source_rows() {
    let fixture = fixture();
    let root = fixture.path().to_string_lossy().into_owned();
    let request = |id| json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": "pi_nav_read", "arguments": {"path": "src/lib.rs", "root": root}}});
    let plain = run_mcp(
        fixture.path(),
        false,
        &[initialize(1), initialized(), request(2)],
    );
    let hashline = run_mcp(
        fixture.path(),
        true,
        &[initialize(1), initialized(), request(2)],
    );
    assert_ne!(successful_text(&plain[1]), successful_text(&hashline[1]));
    assert_eq!(
        plain[1]["result"]["structuredContent"]["data"]["sourceRows"],
        hashline[1]["result"]["structuredContent"]["data"]["sourceRows"]
    );
    assert_eq!(
        plain[1]["result"]["structuredContent"]["completeness"],
        hashline[1]["result"]["structuredContent"]["completeness"]
    );
    for response in [&plain[1], &hashline[1]] {
        let serialized = response.to_string();
        assert!(!serialized.contains("sourceSnapshots"));
        assert!(!serialized.contains("rawDigest"));
    }
}

#[test]
fn edit_mode_adds_only_native_write_in_an_isolated_fixture() {
    let fixture = fixture();
    let root = fixture.path().to_string_lossy().into_owned();
    let responses = run_mcp(
        fixture.path(),
        true,
        &[
            initialize(1),
            initialized(),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "pi_nav_write", "arguments": {"root": root, "files": [{"path": "isolated.txt", "mode": "overwrite", "content": "native write only\n"}]}}}),
        ],
    );
    let names: Vec<&str> = responses[1]["result"]["tools"]
        .as_array()
        .expect("tools list")
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name"))
        .collect();
    assert_eq!(names.last(), Some(&"pi_nav_write"));
    assert_eq!(names.len(), 12);
    assert!(!names.iter().any(|name| name.starts_with("tilth_")));
    assert_structured(&responses[2], "pi_nav_write");
    assert!(successful_text(&responses[2]).contains("isolated.txt"));
    assert_eq!(
        fs::read_to_string(fixture.path().join("isolated.txt")).expect("isolated native write"),
        "native write only\n"
    );
}

#[test]
fn success_helper_and_query_mode_reject_error_controls() {
    let json_rpc_error =
        json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -1, "message": "boom"}});
    let tool_error = json!({"jsonrpc": "2.0", "id": 1, "result": {"isError": true, "content": [{"type": "text", "text": "boom"}]}});
    assert!(std::panic::catch_unwind(|| successful_text(&json_rpc_error)).is_err());
    assert!(std::panic::catch_unwind(|| successful_text(&tool_error)).is_err());

    let fixture = fixture();
    let responses = run_mcp(
        fixture.path(),
        false,
        &[
            initialize(1),
            initialized(),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "tilth_search", "arguments": {}}}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "pi_nav_write", "arguments": {}}}),
        ],
    );
    assert_eq!(responses.len(), 3);
    for response in &responses[1..] {
        assert_eq!(
            response["result"]["isError"], true,
            "negative control unexpectedly succeeded: {response}"
        );
        let structured = &response["result"]["structuredContent"];
        assert_eq!(structured["schemaVersion"], 1);
        assert_eq!(structured["completeness"]["complete"], false);
        assert_eq!(structured["completeness"]["reason"], "error");
        assert!(structured["completeness"].get("total").is_none());
        assert!(std::panic::catch_unwind(|| successful_text(response)).is_err());
    }
}

#[test]
fn version_uses_the_owned_binary_identity() {
    let output = Command::new(binary())
        .arg("--version")
        .output()
        .expect("run version");
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .expect("version UTF-8")
        .starts_with("pi-nav "));
}
