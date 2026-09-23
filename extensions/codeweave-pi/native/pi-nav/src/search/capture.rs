//! Single-use private handoff of a live collection, not a public ranked cursor.
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::dispatch::OperationContext;
use crate::types::SearchResult;
use super::{fuzzy::FuzzySearch, lanes::LaneBundle};

pub(crate) const MAX_CAPTURES: usize = 4;
pub(crate) const MAX_CAPTURE_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_SESSION_CAPTURE_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const CAPTURE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub(crate) enum Collection {
    Symbol { result: SearchResult, candidate_capped: bool, lanes: Option<LaneBundle> },
    Fuzzy { search: FuzzySearch, route: &'static str, lanes: Option<LaneBundle> },
}

impl Collection {
    pub(crate) fn result(&self) -> &SearchResult {
        match self {
            Self::Symbol { result, .. } => result,
            Self::Fuzzy { search, .. } => &search.result,
        }
    }
    pub(crate) fn result_mut(&mut self) -> &mut SearchResult {
        match self {
            Self::Symbol { result, .. } => result,
            Self::Fuzzy { search, .. } => &mut search.result,
        }
    }
    pub(crate) fn lanes(&self) -> Option<&LaneBundle> {
        match self {
            Self::Symbol { lanes, .. } | Self::Fuzzy { lanes, .. } => lanes.as_ref(),
        }
    }
}

pub(crate) struct RankedCapture {
    pub(crate) created: Instant,
    pub(crate) bytes: usize,
    root: PathBuf,
    arguments: Value,
    pub(crate) collection: Collection,
    pub(crate) baseline_cursor: Option<String>,
}

fn immutable_arguments(arguments: &Value) -> Value {
    let mut arguments = arguments.clone();
    if let Some(object) = arguments.as_object_mut() {
        for key in ["captureRanked", "resumeRanked", "analysisDatabase", "analysisRevision",
            "analysisCorpusFiles", "analysisPolicyDigest", "analysisModelDirectory", "analysisRelation", "page", "limit", "retainRankedRender", "rankedRenderAllowance"] {
            object.remove(key);
        }
    }
    arguments
}

impl RankedCapture {
    pub(crate) fn new(root: PathBuf, arguments: &Value, collection: Collection) -> Result<Self, String> {
        let result = collection.result();
        let (files, source_bytes) = result.sources.capture_size()?;
        // Account retained source buffers and request bytes, not exact Rust heap
        // usage (Arc-backed facts and lane metadata also have allocation overhead).
        // Refuse, never trim a collection or add another source store.
        let matches = result.matches.iter();
        let candidate_bytes = matches.clone().fold(0usize, |bytes, matched| bytes
            .saturating_add(matched.path.as_os_str().len())
            .saturating_add(matched.text.len())
            .saturating_add(matched.def_name.as_ref().map_or(0, String::len))
            .saturating_add(matched.graph_node_id().map_or(0, str::len))
            .saturating_add(matched.syntax_key().map_or(0, |(_, _, kind)| kind.len())));
        let ranking_bytes = match &collection {
            Collection::Fuzzy { search, .. } => search.lexical_ranks.len().saturating_mul(std::mem::size_of::<Option<usize>>()),
            Collection::Symbol { .. } => 0,
        };
        let bytes = source_bytes.saturating_add(arguments.to_string().len()).saturating_add(candidate_bytes).saturating_add(ranking_bytes);
        if matches.count() > 20_000 || files > 2048 || bytes > MAX_CAPTURE_BYTES {
            return Err("ranked collection exceeds the 20000-match, 2048-file or 32-MiB retained-source bound".into());
        }
        Ok(Self { created: Instant::now(), bytes, root, arguments: arguments.clone(), collection, baseline_cursor: None })
    }

    pub(crate) fn validate(&self, arguments: &Value, context: &OperationContext) -> Result<(), String> {
        context.check().map_err(|error| error.to_string())?;
        if self.created.elapsed() >= CAPTURE_TTL {
            return Err("ranked capture expired; no search was rerun".into());
        }
        if self.root != context.root || immutable_arguments(&self.arguments) != immutable_arguments(arguments) {
            return Err("ranked capture root or immutable request options changed".into());
        }
        match arguments.get("analysisRelation").and_then(Value::as_str) {
            Some("callers" | "callees") if matches!(self.collection, Collection::Symbol { .. }) => {}
            None if arguments.get("analysisRelation").is_none() => {
                if ["page", "limit"].iter().any(|key| self.arguments.get(key) != arguments.get(key)) {
                    return Err("ranked capture page/limit may change only for a directed analysis relation".into());
                }
            }
            _ => return Err("ranked capture requires a symbol collection for a supported directed relation".into()),
        }
        self.collection.result().sources.validate_admission(arguments, &context.root)?;
        self.collection.result().sources.validate_retained(context)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::{NativeSession, ReadFormat};
    use crate::output::ToolOutput;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::sync::atomic::Ordering;

    struct Fixture {
        _directory: tempfile::TempDir,
        native: NativeSession,
        context: OperationContext,
        database: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap().join("project");
            std::fs::create_dir(&root).unwrap();
            let database = root.parent().unwrap().join("graph.sqlite");
            let connection = rusqlite::Connection::open(&database).unwrap();
            // Prepared-reader contract only, not producer/binding proof.
            connection.execute_batch("CREATE TABLE project_metadata(key TEXT,value TEXT);
                CREATE TABLE schema_versions(version INTEGER);
                CREATE TABLE nodes_fts(name TEXT);
                CREATE TABLE name_segment_vocab(segment TEXT);
                CREATE TABLE files(path TEXT,content_hash TEXT,errors TEXT);
                CREATE TABLE nodes(id TEXT,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,start_line INTEGER,end_line INTEGER,start_column INTEGER,end_column INTEGER);
                CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER,metadata TEXT,provenance TEXT);
                CREATE TABLE unresolved_refs(from_node_id TEXT,reference_kind TEXT,reference_name TEXT,status TEXT,line INTEGER,col INTEGER,candidates TEXT,id INTEGER);").unwrap();
            let mut manifest = Vec::new();
            let mut canonical = Vec::new();
            for (name, id, symbol, start, end, text) in [
                ("caller.ts", "caller", "Caller", 2, 2, "import { Target } from './target';\nfunction Caller() { return Target(1); }\n"),
                ("helper.ts", "helper", "Helper", 1, 1, "function Helper(value: number) { return value; }\n"),
                ("target.ts", "target", "Target", 2, 4, "import { Helper } from './helper';\nfunction Target(value: number) {\n  return Helper(value);\n}\n"),
            ] {
                std::fs::write(root.join(name), text).unwrap();
                let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
                manifest.push(json!({"path":name,"language":"typescript","digest":digest}));
                canonical.push(json!([name,"typescript",digest]));
                connection.execute("INSERT INTO files(path,content_hash) VALUES (?1,?2)", [name, &digest]).unwrap();
                let end_column = text.lines().nth(end - 1).unwrap().encode_utf16().count();
                connection.execute("INSERT INTO nodes VALUES (?1,'function',?2,?2,?3,?4,?5,0,?6)",
                    rusqlite::params![id, symbol, name, start as i64, end as i64, end_column as i64]).unwrap();
            }
            connection.execute_batch("INSERT INTO edges VALUES (1,'caller','target','calls',2,26,'{}',NULL);
                INSERT INTO edges VALUES (2,'target','helper','calls',3,9,'{}',NULL);").unwrap();
            let capture_digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&canonical).unwrap()));
            connection.execute("INSERT INTO project_metadata VALUES ('codeweave-pi.g1',?1)", [json!({
                "root":root,"generation":1,"kernelVersion":"0.1.0-codeweave-pi.5",
                "interpretationRevision":"capture-test","captureDigest":capture_digest,"sources":manifest,
            }).to_string()]).unwrap();
            let native = NativeSession::new(&root, false).unwrap();
            let context = OperationContext::for_session(&native, ReadFormat::Plain, true);
            Self { _directory: directory, native, context, database }
        }

        fn arguments(&self, query: &str, kind: &str) -> Value {
            json!({"root":self.context.root,"scope":self.context.root,"query":query,"kind":kind,"expand":2})
        }

        fn call(&self, arguments: &Value) -> Result<ToolOutput, String> {
            crate::ops::tool_search_output(arguments, &self.native.cache, &self.native.session,
                &self.native.bloom, &self.context)
        }

        fn capture(&self, arguments: &Value) -> ToolOutput {
            let mut arguments = arguments.clone();
            arguments["captureRanked"] = json!(true);
            let output = self.call(&arguments).unwrap();
            assert!(output.search_capture.is_some(), "capture refused: {:?}", output.search_capture_unavailable);
            output
        }

        fn resume(&self, arguments: &Value, id: &str) -> Value {
            let mut arguments = arguments.clone();
            arguments["resumeRanked"] = json!(id);
            arguments["analysisDatabase"] = json!(self.database);
            arguments["analysisRevision"] = json!("capture-test");
            arguments
        }
    }

    #[test]
    fn ranked_focus_prepared_handoff_keeps_target_source_and_typed_emphasis() {
        let fixture = Fixture::new();
        for query in ["which operation preserves the request", "helper", "helper.ts::Helper"] {
          for (evidence, included, retained) in [("callers", "Caller", "call evidence —"), ("callees", "Helper", "callers — ")] {
            let mut arguments = fixture.arguments(query, if query.contains("::") { "symbol" } else { "auto" });
            arguments["focus"] = json!({"target":format!("{}::Target", fixture.context.root.join("target.ts").display()), "evidence":evidence});
            let baseline = fixture.capture(&arguments);
            let resumed = fixture.call(&fixture.resume(&arguments, baseline.search_capture.as_ref().unwrap())).unwrap();
            assert_eq!(resumed.structured["data"]["query"], arguments["query"]);
            assert_eq!(resumed.structured["data"]["focus"]["status"], "ok");
            assert_eq!(resumed.structured["data"]["analysis"]["generation"], 1);
            assert!(resumed.text.contains("function Target(value: number) {"), "{}", resumed.text);
            assert!(resumed.text.contains("return Helper(value);"));
            assert!(resumed.text.contains(included), "{}", resumed.text);
            // Emphasis retains every category: focusing one category never deletes others.
            assert!(resumed.text.contains(retained), "focus deleted unrequested evidence: {}", resumed.text);
            if evidence == "callees" { assert!(!resumed.text.contains("callers: no")); }
          }
        }
    }

    #[test]
    fn ranked_cursor_prepared_requires_fresh_admission_and_pins_selected_publication() {
        let fixture = Fixture::new();
        let path = fixture.context.root.join("target.ts");
        let mut source = "import { Helper } from './helper';\nfunction Target(value: number) {\n".to_string();
        for index in 0..210 { source.push_str(&format!("  const step{index} = 'retained prepared source {index}';\n")); }
        source.push_str("  return Helper(value);\n}\n");
        std::fs::write(&path, &source).unwrap();
        let connection = rusqlite::Connection::open(&fixture.database).unwrap();
        let mut publication: Value = serde_json::from_str(&connection.query_row("SELECT value FROM project_metadata WHERE key='codeweave-pi.g1'", [], |row| row.get::<_, String>(0)).unwrap()).unwrap();
        let digest = format!("{:x}", Sha256::digest(source.as_bytes()));
        publication["sources"].as_array_mut().unwrap().iter_mut().find(|entry| entry["path"] == "target.ts").unwrap()["digest"] = json!(digest);
        let canonical = publication["sources"].as_array().unwrap().iter().map(|entry| json!([entry["path"], entry["language"], entry["digest"]])).collect::<Vec<_>>();
        publication["captureDigest"] = json!(format!("{:x}", Sha256::digest(serde_json::to_vec(&canonical).unwrap())));
        connection.execute("UPDATE project_metadata SET value=?1 WHERE key='codeweave-pi.g1'", [publication.to_string()]).unwrap();
        connection.execute("UPDATE files SET content_hash=?1 WHERE path='target.ts'", [&digest]).unwrap();
        connection.execute("UPDATE nodes SET end_line=?1,end_column=1 WHERE id='target'", [source.lines().count() as i64]).unwrap();
        connection.execute("UPDATE edges SET line=?1 WHERE id=2", [source.lines().count() as i64 - 1]).unwrap();
        let mut arguments = fixture.arguments("how does retained preparation work", "auto");
        arguments["focus"] = json!({"target":format!("{}::Target", path.display())});
        let live = fixture.capture(&arguments);
        let baseline_id = live.structured["data"]["cursor"].as_str().unwrap();
        for index in 0..3 {
            let mut competing = arguments.clone(); competing["query"] = json!(format!("interleaved question slot{index}"));
            assert!(fixture.call(&competing).unwrap().structured["data"]["cursor"].is_string());
        }
        let enriched = fixture.call(&fixture.resume(&arguments, live.search_capture.as_ref().unwrap())).unwrap();
        assert_eq!(fixture.native.session.cursor_owner_data(baseline_id)["ownsCursor"], true,
            "prepared retention must not evict the cursor needed by a late live fallback");
        let id = enriched.structured["data"]["cursor"].as_str().expect("long prepared target must retain its source remainder");
        let owner = fixture.native.session.cursor_owner_data(id);
        assert_eq!(owner["rankedCursor"]["analysis"]["generation"], 1);
        assert_eq!(owner["rankedCursor"]["analysis"]["captureDigest"], publication["captureDigest"]);
        assert_eq!(owner["rankedCursor"]["focus"], arguments["focus"]);
        assert!(owner.to_string().len() < 2048 && !owner.to_string().contains("sourceRows"));
        assert!(fixture.call(&json!({"cursor":id})).unwrap_err().contains("admission"));
        let admitted = json!({"cursor":id,"analysisDatabase":fixture.database,"analysisRevision":"capture-test",
            "analysisCorpusFiles":["caller.ts","helper.ts","target.ts"]});
        let searches = fixture.native.session.snapshot().searches;
        let page = fixture.call(&admitted).unwrap();
        assert_eq!(page.structured["data"]["analysis"]["generation"], 1);
        assert_eq!(fixture.native.session.snapshot().searches, searches);
        let replay = fixture.call(&admitted).unwrap();
        assert_eq!(page.text, replay.text);
        assert_eq!(page.structured, replay.structured);
        for (field, value) in [("analysisCorpusFiles", json!(["target.ts"])), ("analysisPolicyDigest", json!("changed")), ("analysisRevision", json!("changed"))] {
            let mut changed = admitted.clone(); changed[field] = value;
            assert!(fixture.call(&changed).is_err(), "changed admission {field} accepted");
        }
        let other_database = fixture.database.with_file_name("other.sqlite");
        std::fs::copy(&fixture.database, &other_database).unwrap();
        let mut changed = admitted.clone(); changed["analysisDatabase"] = json!(other_database);
        assert!(fixture.call(&changed).unwrap_err().contains("admission changed"));
        publication["generation"] = json!(2);
        connection.execute("UPDATE project_metadata SET value=?1 WHERE key='codeweave-pi.g1'", [publication.to_string()]).unwrap();
        assert!(fixture.call(&admitted).unwrap_err().contains("publication changed"));
        assert_eq!(fixture.native.session.cursor_owner_data(id), owner, "owner lookup describes immutable retained state, not fresh validity");
        assert!(fixture.call(&json!({"cursor":baseline_id})).unwrap().structured["data"]["analysis"].is_null(),
            "saved live cursor must remain live despite failed optional publication admission");
    }

    #[test]
    fn ranked_capture_keeps_live_output_and_resumes_interleaved_collections_without_discovery() {
        let fixture = Fixture::new();
        let exact = fixture.arguments("Target", "symbol");
        let fuzzy = fixture.arguments("Target|Helper", "auto");
        let ordinary = fixture.call(&exact).unwrap();
        let first = fixture.capture(&exact);
        assert_eq!(ordinary.text, first.text);
        assert_eq!(ordinary.structured, first.structured);
        assert_eq!(format!("{:?}", ordinary.source_snapshots), format!("{:?}", first.source_snapshots));
        assert!(!first.structured.to_string().contains("ranked-"));
        let second = fixture.capture(&fuzzy);
        assert_ne!(first.search_capture, second.search_capture);
        // Inspect the actual retained source owner, then replace this single-use
        // test handle. No candidate/source reconstruction is involved.
        let capture = fixture.native.session.take_ranked_capture(first.search_capture.as_ref().unwrap()).unwrap();
        let sources = capture.collection.result().sources.clone();
        let original_reads = sources.counters().0;
        let first_id = fixture.native.session.put_ranked_capture(capture).unwrap();
        std::fs::write(fixture.context.root.join("new.ts"), "function Surprise() { Target(2); }\n").unwrap();
        let searches = fixture.native.session.snapshot().searches;
        for (arguments, baseline, id) in [
            (&fuzzy, &second, second.search_capture.as_ref().unwrap().as_str()),
            (&exact, &first, first_id.as_str()),
        ] {
            let resumed = fixture.call(&fixture.resume(arguments, id)).unwrap();
            assert_eq!(resumed.structured["data"]["analysis"]["generation"], 1);
            assert_eq!(resumed.structured["data"]["matches"], baseline.structured["data"]["matches"]);
            assert!(!resumed.text.contains("Surprise"));
            assert!(!resumed.structured.to_string().contains("new.ts"));
            assert!(resumed.search_capture.is_none());
            assert!(fixture.call(&fixture.resume(arguments, id)).unwrap_err().contains("consumed"));
        }
        assert_eq!(fixture.native.session.snapshot().searches, searches);
        assert_eq!(sources.counters().0, original_reads, "resume reopened discovery source inputs");
    }

    #[test]
    fn ranked_capture_revalidates_declarations_callers_and_imported_callees() {
        let fixture = Fixture::new();
        let arguments = fixture.arguments("Target", "symbol");
        let baseline = fixture.capture(&arguments);
        let capture = fixture.native.session.take_ranked_capture(baseline.search_capture.as_ref().unwrap()).unwrap();
        let result = capture.collection.result();
        let Collection::Symbol { lanes: Some(lanes), .. } = &capture.collection else { panic!("missing collected lanes"); };
        let mut callers = 0;
        let mut candidates = 0;
        for matched in &result.matches {
            assert!(result.sources.retained_text(&matched.path).is_some());
            if let Some(lanes) = lanes.get(matched) {
                for caller in &lanes.callers {
                    assert_eq!(result.sources.retained_text(&caller.path).unwrap().as_str(), caller.content.as_str());
                    callers += 1;
                }
                for connection in &lanes.connections {
                    for candidate in &connection.candidates {
                        assert!(result.sources.retained_text(&candidate.file).is_some());
                        candidates += 1;
                    }
                }
            }
        }
        assert!(callers > 0 && candidates > 0, "fixture must exercise both external input carriers");
        for name in ["target.ts", "caller.ts", "helper.ts"] {
            let path = fixture.context.root.join(name);
            assert!(result.sources.retained_text(&path).is_some(), "untracked input: {name}");
            let original = std::fs::read_to_string(&path).unwrap();
            result.sources.validate_retained(&fixture.context).unwrap();
            // Same-size drift must be compared as bytes, not mtime or length.
            let changed = original.replacen("function", "functiox", 1);
            assert_eq!(original.len(), changed.len());
            std::fs::write(&path, changed).unwrap();
            assert!(result.sources.validate_retained(&fixture.context).unwrap_err().contains("source changed"));
            std::fs::write(&path, original).unwrap();
        }
    }

    #[test]
    fn ranked_capture_observed_same_size_drift_consumes_handle_even_after_restore() {
        let fixture = Fixture::new();
        let arguments = fixture.arguments("Target", "symbol");
        for name in ["target.ts", "caller.ts", "helper.ts"] {
            let baseline = fixture.capture(&arguments);
            let resume = fixture.resume(&arguments, baseline.search_capture.as_ref().unwrap());
            let path = fixture.context.root.join(name);
            let original = std::fs::read_to_string(&path).unwrap();
            std::fs::write(&path, original.replacen("function", "functiox", 1)).unwrap();
            assert!(fixture.call(&resume).unwrap_err().contains("source changed"));
            std::fs::write(&path, original).unwrap();
            assert!(fixture.call(&resume).unwrap_err().contains("consumed"));
            assert!(baseline.text.contains("Target"));
        }
    }

    #[test]
    fn ranked_capture_rejects_option_root_scope_and_session_mismatch_without_search() {
        let fixture = Fixture::new();
        let arguments = fixture.arguments("Target", "symbol");
        for (key, value) in [
            ("query", json!("Helper")), ("kind", json!("auto")), ("case", json!("insensitive")),
            ("scope", json!(fixture.context.root.join("target.ts"))), ("glob", json!("*.ts")),
            ("visibility", json!("all")), ("expand", json!(1)), ("budget", json!(1234)),
            ("page", json!(2)), ("limit", json!(3)), ("output", json!("matches")),
        ] {
            let baseline = fixture.capture(&arguments);
            let mut resume = fixture.resume(&arguments, baseline.search_capture.as_ref().unwrap());
            resume[key] = value;
            let searches = fixture.native.session.snapshot().searches;
            assert!(fixture.call(&resume).is_err(), "accepted changed {key}");
            assert_eq!(fixture.native.session.snapshot().searches, searches);
        }
        let baseline = fixture.capture(&arguments);
        let resume = fixture.resume(&arguments, baseline.search_capture.as_ref().unwrap());
        let other = Fixture::new();
        assert!(other.call(&resume).unwrap_err().contains("missing"));
        let mut context = fixture.context.clone();
        context.root = other.context.root.clone();
        assert!(crate::ops::tool_search_output(&resume, &fixture.native.cache, &fixture.native.session,
            &fixture.native.bloom, &context).unwrap_err().contains("root"));
    }

    #[test]
    fn ranked_capture_cancellation_deadline_expiry_eviction_reset_and_optional_failure() {
        let mut fixture = Fixture::new();
        let arguments = fixture.arguments("Target", "symbol");
        for cancelled in [false, true] {
            let baseline = fixture.capture(&arguments);
            let resume = fixture.resume(&arguments, baseline.search_capture.as_ref().unwrap());
            if cancelled { fixture.context.cancelled.store(true, Ordering::Relaxed); }
            else { fixture.context.deadline = Some(Instant::now()); }
            assert!(fixture.call(&resume).is_err());
            assert!(fixture.call(&json!({"query":"Target","captureRanked":true})).is_err());
            fixture.context.cancelled.store(false, Ordering::Relaxed);
            fixture.context.deadline = None;
            assert!(fixture.call(&resume).unwrap_err().contains("consumed"));
        }
        let baseline = fixture.capture(&arguments);
        let mut expired = fixture.native.session.take_ranked_capture(baseline.search_capture.as_ref().unwrap()).unwrap();
        expired.created = Instant::now() - CAPTURE_TTL;
        assert!(expired.validate(&arguments, &fixture.context).unwrap_err().contains("expired"));
        let expired_id = fixture.native.session.put_ranked_capture(expired).unwrap();
        assert!(fixture.native.session.take_ranked_capture(&expired_id).is_err());
        let mut handles = Vec::new();
        for _ in 0..=MAX_CAPTURES { handles.push(fixture.capture(&arguments).search_capture.unwrap()); }
        assert!(fixture.native.session.take_ranked_capture(&handles[0]).is_err());
        fixture.native.session.reset();
        assert!(fixture.native.session.take_ranked_capture(handles.last().unwrap()).is_err());
        for unavailable in [false, true] {
            let baseline = fixture.capture(&arguments);
            let mut resume = fixture.resume(&arguments, baseline.search_capture.as_ref().unwrap());
            if unavailable { resume["analysisDatabase"] = json!(fixture.context.root.join("missing.sqlite")); }
            else { resume.as_object_mut().unwrap().remove("analysisDatabase"); }
            let searches = fixture.native.session.snapshot().searches;
            assert!(fixture.call(&resume).is_err());
            assert_eq!(fixture.native.session.snapshot().searches, searches);
            assert!(baseline.text.contains("Target"));
        }
    }

    #[test]
    fn ranked_capture_refuses_oversized_retention_without_changing_live_output() {
        let fixture = Fixture::new();
        let arguments = fixture.arguments("Target", "symbol");
        let baseline = fixture.call(&arguments).unwrap();
        let mut oversized = arguments.clone();
        oversized["captureRanked"] = json!(true);
        oversized["privateTestPadding"] = json!("x".repeat(MAX_CAPTURE_BYTES));
        let refused = fixture.call(&oversized).unwrap();
        assert!(refused.search_capture.is_none());
        assert!(refused.search_capture_unavailable.unwrap().contains("32-MiB"));
        assert_eq!(refused.text, baseline.text);
        assert_eq!(refused.structured, baseline.structured);

        let captured = fixture.capture(&arguments);
        let seed = fixture.native.session.take_ranked_capture(captured.search_capture.as_ref().unwrap()).unwrap();
        let mut ids = Vec::new();
        let mut padded = arguments.clone();
        padded["privateTestPadding"] = json!("x".repeat(22 * 1024 * 1024));
        for _ in 0..3 {
            let capture = RankedCapture::new(fixture.context.root.clone(), &padded, seed.collection.clone()).unwrap();
            ids.push(fixture.native.session.put_ranked_capture(capture).unwrap());
        }
        assert!(fixture.native.session.take_ranked_capture(&ids[0]).is_err(), "64-MiB session bound must evict");
        for id in &ids[1..] { fixture.native.session.take_ranked_capture(id).unwrap(); }
        let mut too_many = seed.collection.clone();
        let Collection::Symbol { result, .. } = &mut too_many else { unreachable!() };
        result.matches.resize(20_001, result.matches[0].clone());
        assert!(RankedCapture::new(fixture.context.root.clone(), &arguments, too_many).is_err());
        let large = fixture.context.root.join("large.txt");
        std::fs::write(&large, "é".repeat(MAX_CAPTURE_BYTES / 2)).unwrap();
        seed.collection.result().sources.read_text(&large).unwrap();
        assert!(RankedCapture::new(fixture.context.root.clone(), &arguments, seed.collection).is_err());
    }

    #[test]
    fn ranked_capture_revalidates_alias_config_reexports_and_negative_resolution_probes() {
        for change in ["config", "reexport", "nearer-config", "preferred-file"] {
            let fixture = Fixture::new();
            let root = &fixture.context.root;
            std::fs::create_dir(root.join("nested")).unwrap();
            std::fs::write(root.join("barrel.js"), "export { Target as Chosen } from './target';\n").unwrap();
            std::fs::write(root.join("nested/alias.ts"), "import { Chosen } from '@entry';\nfunction AliasCaller() { return Chosen(1); }\n").unwrap();
            let config = r#"{"compilerOptions":{"baseUrl":".","paths":{"@entry":["barrel"]}}}"#;
            std::fs::write(root.join("tsconfig.json"), config).unwrap();
            let arguments = fixture.arguments("Target", "symbol");
            let ordinary = fixture.call(&arguments).unwrap();
            assert!(ordinary.text.contains("AliasCaller"), "ordinary alias behavior changed: {}", ordinary.text);
            let baseline = fixture.capture(&arguments);
            assert_eq!(baseline.text, ordinary.text);
            let resume = fixture.resume(&arguments, baseline.search_capture.as_ref().unwrap());
            match change {
                "config" => {
                    let changed = config.replace("barrel", "absent");
                    assert_eq!(changed.len(), config.len());
                    std::fs::write(root.join("tsconfig.json"), changed).unwrap();
                }
                "reexport" => { std::fs::write(root.join("barrel.js"), "export { Helper as Chosen } from './helper';\n").unwrap(); }
                "nearer-config" => { std::fs::write(root.join("nested/tsconfig.json"), "{}").unwrap(); }
                "preferred-file" => { std::fs::write(root.join("barrel.ts"), "export { Helper as Chosen } from './helper';\n").unwrap(); }
                _ => unreachable!(),
            }
            let searches = fixture.native.session.snapshot().searches;
            let error = fixture.call(&resume).unwrap_err();
            assert!(error.contains("changed"), "{change}: {error}");
            assert_eq!(fixture.native.session.snapshot().searches, searches);
        }
    }

    #[cfg(unix)]
    #[test]
    fn ranked_capture_rejects_scope_alias_and_dependency_destination_changes() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let root = &fixture.context.root;
        let alias = root.join("selected.ts");
        symlink(root.join("target.ts"), &alias).unwrap();
        let mut arguments = fixture.arguments("Target", "symbol");
        arguments["scope"] = json!(alias);
        let baseline = fixture.capture(&arguments);
        std::fs::remove_file(&alias).unwrap();
        symlink(root.join("helper.ts"), &alias).unwrap();
        let error = fixture.call(&fixture.resume(&arguments, baseline.search_capture.as_ref().unwrap())).unwrap_err();
        assert!(error.contains("scope") || error.contains("input changed"), "{error}");

        let sources = crate::search::OperationSources::default();
        assert!(sources.input_is_file(&alias));
        sources.validate_retained(&fixture.context).unwrap();
        std::fs::remove_file(&alias).unwrap();
        symlink(root.join("target.ts"), &alias).unwrap();
        assert!(sources.validate_retained(&fixture.context).unwrap_err().contains("input changed"));
    }

    #[test]
    fn ranked_render_prepared_origin_pins_generation_and_does_not_recollect() {
        let fixture = Fixture::new();
        let mut arguments = fixture.arguments("Target", "symbol");
        arguments["retainRankedRender"] = json!(true);
        let baseline = fixture.capture(&arguments);
        let live_origin = baseline.ranked_render_cursor.clone().unwrap();
        // Fill the four-dataset table with the live origin oldest. Speculative
        // prepared insertion must evict another dataset, not its saved fallback.
        for _ in 0..3 { fixture.call(&arguments).unwrap(); }
        assert!(fixture.native.session.get_ranked_cursor(&live_origin).is_some());
        let mut resumed = fixture.resume(&arguments, baseline.search_capture.as_ref().unwrap());
        resumed["analysisCorpusFiles"] = json!(["caller.ts", "helper.ts", "target.ts"]);
        let enriched = fixture.call(&resumed).unwrap();
        let origin = enriched.ranked_render_cursor.as_ref().unwrap();
        assert_ne!(origin, &live_origin);
        assert!(fixture.native.session.get_ranked_cursor(&live_origin).is_some());
        let searches = fixture.native.session.snapshot().searches;
        let retry = json!({"renderRanked":origin,"rankedRenderAllowance":800,
            "analysisDatabase":fixture.database,"analysisRevision":"capture-test","analysisCorpusFiles":["caller.ts", "helper.ts", "target.ts"]});
        let small = fixture.call(&retry).unwrap();
        assert_eq!(small.structured["data"]["analysis"]["generation"], 1);
        assert!(small.text.starts_with("# Target"));
        assert_eq!(fixture.native.session.snapshot().searches, searches);
        let connection = rusqlite::Connection::open(&fixture.database).unwrap();
        let raw: String = connection.query_row("SELECT value FROM project_metadata WHERE key='codeweave-pi.g1'", [], |row| row.get(0)).unwrap();
        let mut metadata: Value = serde_json::from_str(&raw).unwrap();
        metadata["generation"] = json!(2);
        connection.execute("UPDATE project_metadata SET value=?1 WHERE key='codeweave-pi.g1'", [metadata.to_string()]).unwrap();
        assert!(fixture.call(&retry).unwrap_err().contains("changed"));
    }

    #[test]
    fn ranked_capture_refuses_unretained_dependency_probes_and_legacy_import_inputs() {
        let fixture = Fixture::new();
        let sources = crate::search::OperationSources::default();
        for index in 0..=4096 {
            assert!(!sources.input_exists(&fixture.context.root.join(format!("missing-{index}"))));
        }
        assert!(sources.capture_size().unwrap_err().contains("4096-probe"));
        assert!(sources.validate_retained(&fixture.context).is_err());

        std::fs::write(fixture.context.root.join("legacy.rs"), "fn Legacy() { Unknown(); }\n").unwrap();
        let arguments = fixture.arguments("Legacy", "symbol");
        let ordinary = fixture.call(&arguments).unwrap();
        let mut capture = arguments.clone();
        capture["captureRanked"] = json!(true);
        let refused = fixture.call(&capture).unwrap();
        assert_eq!(refused.text, ordinary.text);
        assert!(refused.search_capture.is_none());
        assert!(refused.search_capture_unavailable.unwrap().contains("legacy import/package"));
        // Both resolvers currently return helper.ts, but the protected reader
        // also depends on absence of helper.ts.ts, which the binder never probes.
        let target = fixture.context.root.join("target.ts");
        let original = std::fs::read_to_string(&target).unwrap();
        std::fs::write(&target, original.replace("'./helper'", "'./helper.ts'")).unwrap();
        let mut arguments = fixture.arguments("Target", "symbol");
        let ordinary = fixture.call(&arguments).unwrap();
        arguments["captureRanked"] = json!(true);
        let refused = fixture.call(&arguments).unwrap();
        assert_eq!(refused.text, ordinary.text);
        assert!(refused.search_capture.is_none());
        assert!(refused.search_capture_unavailable.unwrap().contains("explicit-extension"));
    }

    #[test]
    fn ranked_capture_refusal_reason_fits_private_utf8_transport_without_losing_baseline() {
        let fixture = Fixture::new();
        let text = format!("import {{ Missing }} from './{}';\nfunction Target() {{ Missing(); }}\n", "é".repeat(1000));
        std::fs::write(fixture.context.root.join("target.ts"), text).unwrap();
        let mut arguments = fixture.arguments("Target", "symbol");
        let baseline = fixture.call(&arguments).unwrap();
        arguments["captureRanked"] = json!(true);
        let refused = fixture.call(&arguments).unwrap();
        let reason = refused.search_capture_unavailable.unwrap();
        assert!(reason.len() <= 1024 && reason.ends_with("..."), "{reason}");
        assert_eq!(refused.text, baseline.text);
        assert_eq!(refused.structured, baseline.structured);
        assert!(refused.search_capture.is_none());
    }
}
