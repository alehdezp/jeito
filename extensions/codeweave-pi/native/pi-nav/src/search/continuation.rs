//! Immutable ranked evidence and renderer progress owned by the existing Session
//! cursor table. These records are not delivery receipts or a persistent index.
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::capture::{Collection, RankedCapture, MAX_CAPTURE_BYTES};
use super::lanes::TargetKey;
use super::RenderedSourceRow;
use crate::dispatch::OperationContext;

static NEXT_EVIDENCE: AtomicU64 = AtomicU64::new(1);
pub(crate) const CURSOR_TTL: Duration = Duration::from_secs(1800);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum GroupKey {
    Target(TargetKey),
    Lane(TargetKey, &'static str, usize),
    Mention(PathBuf, u32),
}

pub(crate) type SourceLine = (PathBuf, u32);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Progress {
    pub(crate) rows: BTreeMap<GroupKey, BTreeSet<SourceLine>>,
    pub(crate) complete: BTreeSet<GroupKey>,
    pub(crate) required: BTreeMap<GroupKey, BTreeSet<SourceLine>>,
}

impl Progress {
    pub(crate) fn contains(&self, key: &GroupKey, path: &std::path::Path, line: u32) -> bool {
        self.rows.get(key).is_some_and(|rows| rows.contains(&(path.to_path_buf(), line)))
    }
    /// Call only after the source/role block actually survives composition. A
    /// compact locator cannot invoke this target-group receipt.
    pub(crate) fn record(&mut self, key: GroupKey, required: &[SourceLine], rendered: &[RenderedSourceRow], prior: Option<&Self>) {
        self.required.entry(key.clone()).or_default().extend(required.iter().cloned());
        let rows = self.rows.entry(key.clone()).or_default();
        if let Some(previous) = prior.and_then(|prior| prior.rows.get(&key)) { rows.extend(previous.iter().cloned()); }
        for row in rendered {
            let identity = (row.path.clone(), row.line);
            if required.contains(&identity) { rows.insert(identity); }
        }
        if required.iter().all(|row| rows.contains(row)) { self.complete.insert(key); }
    }
    /// Complete accepted groups after optional source expansions, before compact
    /// tail locators are appended. Only groups admitted by the renderer exist here.
    pub(crate) fn finish(&mut self, rendered: &[RenderedSourceRow], prior: Option<&Self>) {
        let requirements = self.required.clone();
        for (key, required) in requirements {
            self.record(key, &required.into_iter().collect::<Vec<_>>(), rendered, prior);
        }
    }
    pub(crate) fn merge(&mut self, receipt: &Self) {
        self.complete.extend(receipt.complete.iter().cloned());
        for (key, rows) in &receipt.rows { self.rows.entry(key.clone()).or_default().extend(rows.iter().cloned()); }
        for (key, rows) in &receipt.required { self.required.entry(key.clone()).or_default().extend(rows.iter().cloned()); }
    }
    pub(crate) fn accounted_bytes(&self) -> usize { format!("{self:?}").len() }
}

/// Frozen first-answer framing. Refit changes source selection, not the question,
/// semantic interpretation, or the initial/continued presentation role.
#[derive(Debug, Clone)]
pub(crate) struct RenderFrame {
    pub(crate) prefix: String,
    pub(crate) suffix: String,
    pub(crate) exact: bool,
}

impl RenderFrame {
    pub(crate) fn capture(text: &str, body: &str, exact: bool) -> Option<Self> {
        if body.is_empty() { return None; }
        let start = text.find(body)?;
        Some(Self { prefix: text[..start].into(), suffix: text[start + body.len()..].into(), exact })
    }
}

pub(crate) struct RetainedRanked {
    pub(crate) id: String,
    pub(crate) created: Instant,
    pub(crate) bytes: usize,
    pub(crate) root: PathBuf,
    pub(crate) arguments: Value,
    pub(crate) collection: Collection,
    pub(crate) data: Value,
    pub(crate) database: Option<PathBuf>,
    pub(crate) frame: Option<RenderFrame>,
}

impl RetainedRanked {
    pub(crate) fn new(root: PathBuf, arguments: &Value, mut collection: Collection, data: &Value) -> Result<Arc<Self>, String> {
        // Do not let the private enrichment handoff's mutable maps change a
        // baseline cursor after it has been offered to the caller.
        collection.result_mut().sources = Arc::new(collection.result().sources.fork());
        let mut arguments = arguments.clone();
        if let Some(arguments) = arguments.as_object_mut() {
            for key in ["captureRanked", "resumeRanked", "retainRankedRender", "rankedRenderAllowance"] { arguments.remove(key); }
        }
        let capture = RankedCapture::new(root.clone(), &arguments, collection)?;
        let mut data = data.clone();
        if let Some(data) = data.as_object_mut() {
            for key in ["matches", "locations", "sourceRows", "cursor"] { data.remove(key); }
        }
        let bytes = capture.bytes.saturating_add(data.to_string().len());
        if bytes > MAX_CAPTURE_BYTES { return Err("ranked continuation exceeds its 32-MiB retained-evidence bound".into()); }
        let prepared = data["analysis"]["generation"].is_u64() || data["analysis"]["indexedRunId"].is_string();
        let database = if prepared {
            Some(PathBuf::from(arguments.get("analysisDatabase").and_then(Value::as_str)
                .ok_or("prepared continuation has no admitted database")?).canonicalize().map_err(|error| error.to_string())?)
        } else { None };
        let sequence = NEXT_EVIDENCE.fetch_add(1, Ordering::Relaxed);
        let id = format!("{:x}", Sha256::digest(format!("{sequence}:{:?}", SystemTime::now()).as_bytes()));
        let evidence = Arc::new(Self { id, created: Instant::now(), bytes, root, arguments: arguments.clone(),
            collection: capture.collection, data, database, frame: None });
        if evidence.descriptor().to_string().len() > 64 * 1024 { return Err("ranked cursor routing metadata exceeds 64 KiB".into()); }
        Ok(evidence)
    }

    /// Memory-only routing information. It deliberately says nothing about
    /// present policy, publication, source freshness, or expiry.
    pub(crate) fn descriptor(&self) -> Value {
        let mut descriptor = json!({"query":self.data["query"],"scope":self.collection.result().scope,
            "visibility":self.data["visibility"]});
        if let Some(focus) = self.arguments.get("focus") { descriptor["focus"] = focus.clone(); }
        if let Some(root) = self.collection.result().sources.corpus_root() { descriptor["corpusRoot"] = json!(root); }
        if self.database.is_some() {
            let analysis = &self.data["analysis"];
            descriptor["analysis"] = if analysis["indexedRunId"].is_string() {
                json!({"indexedRunId":analysis["indexedRunId"],"interpretationRevision":analysis["interpretationRevision"],
                    "corpusDigest":analysis["corpusDigest"]})
            } else {
                json!({"generation":analysis["generation"],"captureDigest":analysis["captureDigest"],
                    "interpretationRevision":analysis["interpretationRevision"]})
            };
            if let Some(policy) = analysis.get("policyDigest").filter(|policy| !policy.is_null()) {
                descriptor["analysis"]["policyDigest"] = policy.clone();
            }
        }
        descriptor
    }

    pub(crate) fn validate(&self, arguments: &Value, context: &OperationContext) -> Result<(), String> {
        context.check().map_err(|error| error.to_string())?;
        if self.created.elapsed() >= CURSOR_TTL { return Err("ranked cursor expired; restart the original query".into()); }
        if context.root != self.root { return Err("ranked cursor belongs to a different root".into()); }
        if arguments.as_object().is_none_or(|arguments| arguments.keys().any(|key| !matches!(key.as_str(),
            "cursor" | "renderRanked" | "retainRankedRender" | "rankedRenderAllowance" | "root" | "corpusAdmission" | "analysisDatabase" | "analysisRevision" | "analysisCorpusFiles" | "analysisPolicyDigest"))) {
            return Err("ranked continuation accepts cursor only; query, focus, filters and contextLines cannot change".into());
        }
        if let Some(root) = arguments.get("root") {
            let root = PathBuf::from(root.as_str().ok_or("root must be a path")?).canonicalize().map_err(|error| error.to_string())?;
            if root != self.root { return Err("ranked cursor transport root changed".into()); }
        }
        if let Some(scope) = self.arguments.get("scope").and_then(Value::as_str) {
            let scope = self.root.join(scope).canonicalize().map_err(|error| error.to_string())?;
            if scope != self.collection.result().scope { return Err("ranked cursor canonical scope changed".into()); }
        }
        self.collection.result().sources.validate_admission(arguments, &context.root)?;
        self.collection.result().sources.validate_retained(context)?;
        if let Some(database) = &self.database {
            let current_database = PathBuf::from(arguments.get("analysisDatabase").and_then(Value::as_str)
                .ok_or("prepared ranked cursor requires fresh internal admission; restart the original query")?)
                .canonicalize().map_err(|error| error.to_string())?;
            if &current_database != database || arguments.get("analysisRevision") != self.arguments.get("analysisRevision")
                || arguments.get("analysisPolicyDigest") != self.arguments.get("analysisPolicyDigest") {
                return Err("prepared ranked cursor admission changed; restart the original query".into());
            }
            super::prepared::validate_continuation(arguments, &self.data["analysis"], database, context,
                Arc::new(self.collection.result().sources.fork()))?;
        } else if arguments.as_object().is_some_and(|arguments| arguments.keys().any(|key| key.starts_with("analysis"))) {
            return Err("live ranked cursor cannot switch to a prepared provider".into());
        }
        Ok(())
    }
    pub(crate) fn pending(&self, matched: &crate::types::Match, progress: &Progress) -> bool {
        if !matched.is_definition {
            let excludes_tests = self.collection.result().matches.iter().any(|candidate| candidate.is_definition && !crate::types::is_test_file(&candidate.path));
            return !(excludes_tests && crate::types::is_test_file(&matched.path))
                && !progress.complete.contains(&GroupKey::Mention(matched.path.clone(), matched.line));
        }
        !progress.complete.contains(&GroupKey::Target(super::lanes::target_key(matched)))
            || self.collection.lanes().is_some_and(|lanes| lanes.group_keys(matched).iter().any(|key| !progress.complete.contains(key)))
    }

    pub(crate) fn remaining(&self, progress: &Progress) -> usize { Self::remaining_in(&self.collection, progress) }

    pub(crate) fn remaining_in(collection: &Collection, progress: &Progress) -> usize {
        let mut keys = BTreeSet::new();
        let excludes_tests = collection.result().matches.iter().any(|candidate| candidate.is_definition && !crate::types::is_test_file(&candidate.path));
        for matched in &collection.result().matches {
            if matched.is_definition {
                keys.insert(GroupKey::Target(super::lanes::target_key(matched)));
                if let Some(lanes) = collection.lanes() { keys.extend(lanes.group_keys(matched)); }
            } else if !(excludes_tests && crate::types::is_test_file(&matched.path)) { keys.insert(GroupKey::Mention(matched.path.clone(), matched.line)); }
        }
        keys.difference(&progress.complete).count()
    }

    pub(crate) fn page_result(&self, progress: &Progress) -> crate::types::SearchResult {
        let mut result = self.collection.result().clone();
        result.matches.retain(|matched| self.pending(matched, progress));
        result.sources = Arc::new(result.sources.fork());
        result
    }
}

pub(crate) struct RankedCursor {
    pub(crate) evidence: Arc<RetainedRanked>,
    pub(crate) progress: Progress,
}
impl RankedCursor {
    pub(crate) fn id(&self) -> String {
        let digest = Sha256::digest(format!("{:?}", self.progress).as_bytes());
        format!("grep-ranked-{}-{:x}", &self.evidence.id[..16], digest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::{NativeSession, ReadFormat};
    use crate::output::ToolOutput;

    fn call(native: &NativeSession, args: &Value) -> Result<ToolOutput, String> {
        crate::ops::tool_search_output(args, &native.cache, &native.session, &native.bloom,
            &OperationContext::for_session(native, ReadFormat::Plain, true))
    }

    fn source_rows(root: &std::path::Path, output: &ToolOutput) -> BTreeSet<(PathBuf, u32)> {
        let mut seen = BTreeSet::new();
        for row in output.structured["data"]["sourceRows"].as_array().unwrap() {
            let path = root.join(row["path"].as_str().unwrap());
            let line = row["line"].as_u64().unwrap() as u32;
            assert!(seen.insert((path.clone(), line)), "duplicate physical row {path:?}:{line}");
            let source = std::fs::read_to_string(&path).unwrap();
            assert_eq!(source.lines().nth(line as usize - 1).unwrap(), row["text"].as_str().unwrap());
        }
        seen
    }

    #[test]
    fn ranked_render_real_query_builder_pages_complete_member_headers() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let path = root.join("queries.ts");
        let source = include_str!("../../../analysis/src/db/queries.ts");
        std::fs::write(&path, source).unwrap();
        let policy = root.join(".pi-navigation.json");
        std::fs::write(&policy, "{}").unwrap();
        let admission = json!({"root":root,"files":["queries.ts"],"policyDigest":"a".repeat(64),
            "policyFiles":[{"path":policy,"digest":format!("{:x}", Sha256::digest(b"{}"))}]});
        let native = NativeSession::new(&root, false).unwrap();
        let first = call(&native, &json!({"scope":path,"query":"QueryBuilder","kind":"symbol","retainRankedRender":true,"corpusAdmission":admission})).unwrap();
        let origin = first.ranked_render_cursor.as_ref().unwrap();
        let retained = native.session.get_ranked_cursor(origin).unwrap();
        let matched = retained.evidence.collection.result().matches.iter().find(|matched| matched.is_definition && matched.def_name.as_deref() == Some("QueryBuilder")).unwrap();
        let headers = matched.declaration.as_ref().unwrap().class_inventory(source, crate::types::Lang::TypeScript).unwrap()
            .into_iter().skip(1).map(|(_, span)| super::super::declarations::lines_for(source, &span)).collect::<Vec<_>>();
        assert_eq!(headers.len(), 104, "the real class's inventory must not silently shrink");
        let required = headers.iter().flat_map(|(start, end)| *start..=*end).collect::<BTreeSet<_>>();
        let searches = native.session.snapshot().searches;
        let request = json!({"renderRanked":origin,"rankedRenderAllowance":1000,"corpusAdmission":admission});
        let mut page = call(&native, &request).unwrap();
        assert!(page.text.len() < first.text.len(), "shrinking the allowance left a fixed inventory floor");
        assert_eq!(call(&native, &request).unwrap().text, page.text, "same origin and allowance must replay identically");
        let mut delivered = BTreeSet::new();
        for index in 0..30 {
            let rows = source_rows(&root, &page).into_iter().filter_map(|(file, line)| (file == path).then_some(line)).collect::<BTreeSet<_>>();
            for (start, end) in &headers {
                if (*start..=*end).any(|line| rows.contains(&line)) {
                    assert!((*start..=*end).all(|line| rows.contains(&line)), "member header {start}-{end} split on page {index}");
                }
            }
            let new = required.intersection(&rows).filter(|line| !delivered.contains(*line)).count();
            assert!(new > 0, "inventory stalled on page {index}: {}", page.text);
            delivered.extend(rows);
            if required.is_subset(&delivered) { break; }
            assert!(index < 29, "inventory did not finish within 30 pages");
            let cursor = page.structured["data"]["cursor"].as_str().expect("undelivered headers require continuation");
            page = call(&native, &json!({"cursor":cursor,"retainRankedRender":true,"rankedRenderAllowance":1000,"corpusAdmission":admission})).unwrap();
        }
        assert!(required.is_subset(&delivered));
        assert_eq!(native.session.snapshot().searches, searches);
        assert_eq!(native.session.get_ranked_cursor(origin).unwrap().progress, Progress::default());
        // Relationship groups may legitimately outlive the inventory. They are
        // not retired just to make an inventory-only consumer stop paging.
        println!("QueryBuilder inventory rows={}, remaining groups={}", required.len(), page.structured["data"]["remainingGroups"]);
    }

    #[test]
    fn ranked_render_preserves_explicit_all_visibility_without_prepared_admission() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.ts\n").unwrap();
        std::fs::write(root.join("ignored.ts"), "export function HiddenWork() { return 7; }\n").unwrap();
        let native = NativeSession::new(&root, false).unwrap();
        let first = call(&native, &json!({"query":"HiddenWork", "kind":"symbol", "scope":root,
            "visibility":"all", "retainRankedRender":true})).unwrap();
        let origin = first.ranked_render_cursor.as_ref().unwrap();
        assert!(first.structured["data"]["sourceRows"].as_array().unwrap().iter().any(|row| row["path"] == "ignored.ts" && row["line"] == 1));
        let repeated = call(&native, &json!({"renderRanked":origin, "rankedRenderAllowance":4000})).unwrap();
        assert_eq!(first.text, repeated.text);
        assert_eq!(first.structured, repeated.structured);
    }

    #[test]
    fn ranked_render_undisplayable_call_is_not_credited_as_complete_context() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let target = root.join("target.ts");
        std::fs::write(&target, "export function Wanted() { return 7; }\n").unwrap();
        std::fs::write(root.join("caller.ts"), format!("function Caller() {{\n  Wanted({});\n}}\n", "argument".repeat(1024))).unwrap();
        let native = NativeSession::new(&root, false).unwrap();
        let first = call(&native, &json!({"query":"calling operation", "kind":"auto", "scope":root,
            "focus":{"target":format!("{}::Wanted", target.display()),"evidence":"callers"},"retainRankedRender":true})).unwrap();
        assert!(first.structured["data"]["sourceRows"].as_array().unwrap().iter().all(|row| row["path"] != "caller.ts"));
        let next = first.structured["data"]["cursor"].as_str().expect("undisplayable caller must remain pending");
        let blocked = call(&native, &json!({"renderRanked":next,"rankedRenderAllowance":4000})).unwrap();
        assert!(blocked.ranked_render_unavailable.is_some());
        assert!(blocked.structured["data"]["cursor"].is_null());
    }

    #[test]
    fn ranked_render_complete_origin_and_smaller_exact_replay_are_immutable() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let path = root.join("target.ts");
        std::fs::write(&path, "export function Wanted() { return 7; }\n").unwrap();
        let native = NativeSession::new(&root, true).unwrap();
        let first = call(&native, &json!({"query":"Wanted", "kind":"symbol", "scope":root, "retainRankedRender":true})).unwrap();
        let origin = first.ranked_render_cursor.as_ref().expect("even a complete answer needs a fitting origin");
        assert!(first.structured["data"]["cursor"].is_null());
        assert!(first.text.starts_with("# Wanted"));
        let searches = native.session.snapshot().searches;
        let args = json!({"renderRanked":origin,"rankedRenderAllowance":600});
        let small = call(&native, &args).unwrap();
        let replay = call(&native, &args).unwrap();
        assert_eq!(small.text, replay.text);
        assert_eq!(small.structured, replay.structured);
        assert!(small.text.starts_with("# Wanted"));
        assert!(!small.text.contains("Ranked continuation"));
        assert_eq!(small.ranked_render_cursor.as_ref(), Some(origin));
        assert_eq!(native.session.snapshot().searches, searches);
        assert_eq!(native.session.get_ranked_cursor(origin).unwrap().progress, Progress::default());
        let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert!(!native.session.is_expanded(&path, 1, mtime), "a discarded preview granted expanded credit");
        for (key, value) in [("query", json!("other")), ("scope", json!(root)), ("focus", json!({"target":"target.ts::Wanted"})), ("rankedRenderAllowance", json!(4001))] {
            let mut invalid = args.clone(); invalid[key] = value;
            assert!(call(&native, &invalid).is_err(), "accepted {key} override");
        }
        let retained = native.session.get_ranked_cursor(origin).unwrap();
        for index in 0..80 {
            let mut progress = Progress::default();
            progress.complete.insert(GroupKey::Mention(path.clone(), index));
            native.session.put_ranked_cursor_protected(RankedCursor { evidence: retained.evidence.clone(), progress }, &[origin]).unwrap();
        }
        assert!(native.session.get_ranked_cursor(origin).is_some(), "fitting evicted its own origin");
        assert_eq!(call(&native, &args).unwrap().text, small.text);
        std::fs::write(&path, "export function Wanted() { return 8; }\n").unwrap();
        assert!(call(&native, &args).unwrap_err().contains("changed"));
    }

    #[test]
    fn ranked_render_revalidates_admission_before_retained_content_reads() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let policy = b"{}";
        std::fs::write(root.join(".pi-navigation.json"), policy).unwrap();
        std::fs::write(root.join("target.ts"), "export function Wanted() { return 7; }\n").unwrap();
        let admission = json!({"root":root,"files":["target.ts"],
            "policyDigest":"a".repeat(64),"policyFiles":[{"path":root.join(".pi-navigation.json"),"digest":format!("{:x}", Sha256::digest(policy))}]});
        let native = NativeSession::new(&root, false).unwrap();
        let first = call(&native, &json!({"query":"Wanted","kind":"symbol","scope":root,"retainRankedRender":true,"corpusAdmission":admission})).unwrap();
        let origin = first.ranked_render_cursor.unwrap();
        let retained = native.session.get_ranked_cursor(&origin).unwrap();
        let sources = &retained.evidence.collection.result().sources;
        let reads = sources.content_reads.lock().unwrap().len();
        assert!(call(&native, &json!({"renderRanked":origin,"rankedRenderAllowance":800})).is_err());
        assert_eq!(sources.content_reads.lock().unwrap().len(), reads);
        std::fs::write(root.join(".pi-navigation.json"), "{\"exclude\":[\"target.ts\"]}").unwrap();
        assert!(call(&native, &json!({"renderRanked":origin,"rankedRenderAllowance":800,"corpusAdmission":admission})).is_err());
        assert_eq!(sources.content_reads.lock().unwrap().len(), reads);
    }

    #[test]
    fn ranked_render_focused_small_callers_are_atomic_and_withheld_groups_remain_reachable() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::write(root.join("target.ts"), "export function Wanted() { return 7; }\n").unwrap();
        let source = (0..60).map(|index| format!("export function Caller{index}(\n{}): number {{\n  return Wanted();\n}}\n",
            (0..10).map(|parameter| format!("  parameter{parameter}: number = {parameter},\n")).collect::<String>())).collect::<String>();
        let path = root.join("callers.ts");
        std::fs::write(&path, &source).unwrap();
        let native = NativeSession::new(&root, false).unwrap();
        let first = call(&native, &json!({"query":"caller inputs and request defaults", "kind":"auto", "scope":root,
            "focus":{"target":format!("{}::Wanted", root.join("target.ts").display()), "evidence":"callers"}, "retainRankedRender":true})).unwrap();
        let origin = first.ranked_render_cursor.unwrap();
        let searches = native.session.snapshot().searches;
        let request = json!({"renderRanked":origin, "rankedRenderAllowance":1800});
        let mut page = call(&native, &request).unwrap();
        assert!(page.text.starts_with("Question: caller inputs and request defaults"));
        assert!(page.text.len() < first.text.len());
        let replay = call(&native, &request).unwrap();
        assert_eq!(page.text, replay.text);
        assert_eq!(page.structured, replay.structured);
        let mut seen = BTreeSet::new();
        for index in 0..20 {
            let rows = source_rows(&root, &page);
            for caller in 0..60 {
                let start = caller * 14 + 1;
                if rows.contains(&(path.clone(), start)) {
                    for line in start..start + 14 { assert!(rows.contains(&(path.clone(), line)), "caller {caller} split at row {line}"); }
                    seen.insert(caller);
                }
            }
            let Some(next) = page.structured["data"]["cursor"].as_str().map(str::to_owned) else { break; };
            assert_ne!(next, origin);
            let blocked = call(&native, &json!({"renderRanked":next,"rankedRenderAllowance":1})).unwrap();
            assert!(blocked.ranked_render_unavailable.is_some());
            assert!(blocked.structured["data"]["cursor"].is_null());
            assert!(index < 19, "fitting failed to progress");
            page = call(&native, &json!({"cursor":next,"retainRankedRender":true,"rankedRenderAllowance":1800})).unwrap();
        }
        assert_eq!(seen.len(), 60);
        assert_eq!(native.session.snapshot().searches, searches, "rendering recollected candidates");
        assert_eq!(native.session.get_ranked_cursor(&origin).unwrap().progress, Progress::default());
    }

    #[test]
    fn ranked_cursor_retains_125_candidates_and_completes_bodies_not_compact_locators() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let path = root.join("worker.ts");
        let source = (0..125).map(|index| format!("export function task{index}() {{\n  // quasar pagination\n  return {index};\n}}\n")).collect::<String>();
        std::fs::write(&path, &source).unwrap();
        let native = NativeSession::new(&root, false).unwrap();
        let args = json!({"root":root,"scope":root,"query":"quasar pagination","kind":"auto","expand":2});
        let first = call(&native, &args).unwrap();
        assert_eq!(first.structured["data"]["totalFound"], 125);
        assert_eq!(first.structured["data"]["remainingGroups"], 120);
        let first_cursor = first.structured["data"]["cursor"].as_str().unwrap().to_owned();
        let owner = native.session.cursor_owner_data(&first_cursor);
        assert_eq!(owner["rankedCursor"]["query"], args["query"]);
        assert_eq!(owner["rankedCursor"]["scope"], json!(root));
        assert_eq!(owner["rankedCursor"]["visibility"], "project");
        assert!(owner["rankedCursor"].get("analysis").is_none());
        let retained = native.session.get_ranked_cursor(&first_cursor).unwrap();
        assert_eq!(retained.evidence.collection.result().matches.len(), 125);
        let reads = retained.evidence.collection.result().sources.counters().0;
        let searches = native.session.snapshot().searches;
        std::fs::write(root.join("new.ts"), "function NewCandidate() { /* quasar pagination */ }\n").unwrap();
        let mut rows = source_rows(&root, &first);
        let mut cursor = Some(first_cursor.clone());
        let mut replay = None;
        let mut pages = 1;
        while let Some(id) = cursor {
            assert!(pages < 40, "cursor failed to make bounded progress");
            let output = call(&native, &json!({"cursor":id})).unwrap();
            if replay.is_none() { replay = Some((output.text.clone(), output.structured.clone())); }
            assert!(!output.structured.to_string().contains("NewCandidate"));
            rows.extend(source_rows(&root, &output));
            cursor = output.structured["data"]["cursor"].as_str().map(str::to_owned);
            if cursor.is_none() { assert_eq!(output.structured["data"]["remainingGroups"], 0); }
            pages += 1;
        }
        assert_eq!(pages, 25);
        for line in 1..=source.lines().count() as u32 { assert!(rows.contains(&(path.clone(), line)), "missing source body row {line}"); }
        let again = call(&native, &json!({"cursor":first_cursor})).unwrap();
        assert_eq!((again.text, again.structured), replay.unwrap());
        assert_eq!(native.session.snapshot().searches, searches, "continuation rediscovered candidates");
        assert_eq!(retained.evidence.collection.result().sources.counters().0, reads);
    }

    #[test]
    fn ranked_cursor_pages_target_without_repeating_body_and_keeps_selected_caller_context() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let path = root.join("worker.ts");
        let mut source = "function Target() {\n".to_string();
        for index in 0..230 { source.push_str(&format!("  const body{index} = 'target source remainder {index}';\n")); }
        source.push_str("}\nfunction LargeCaller() {\n");
        for index in 0..700 { source.push_str(&format!("  const caller{index} = 'caller source remainder {index}';\n")); }
        source.push_str("  Target();\n}\n");
        std::fs::write(&path, &source).unwrap();
        let native = NativeSession::new(&root, false).unwrap();
        let args = json!({"root":root,"scope":root,"query":"why preserve remainder","kind":"auto","expand":2,
            "focus":{"target":format!("{}::Target", path.display()),"evidence":"callers"}});
        let mut output = call(&native, &args).unwrap();
        let mut body_seen = BTreeSet::new();
        let mut all_seen = BTreeSet::new();
        let mut pages = 0;
        loop {
            pages += 1;
            assert!(pages < 30, "long source stalled");
            for (path, line) in source_rows(&root, &output) {
                all_seen.insert((path.clone(), line));
                if source.lines().nth(line as usize - 1).unwrap().contains("const ") {
                    assert!(body_seen.insert((path, line)), "body row {line} repeated across pages");
                }
            }
            let Some(cursor) = output.structured["data"]["cursor"].as_str() else { break; };
            output = call(&native, &json!({"cursor":cursor})).unwrap();
        }
        assert!(pages > 1);
        for line in 2..=231 { assert!(body_seen.contains(&(path.clone(), line)), "target source retired at {line}"); }
        // Caller completion is its declaration plus the coherent call operation,
        // not 700 unrelated local declarations or an arbitrary body prefix.
        for line in [233, 934, 935] { assert!(all_seen.contains(&(path.clone(), line)), "selected caller row {line} missing"); }
        assert!(!all_seen.contains(&(path.clone(), 234)));
        assert!(body_seen.len() < 250);
    }

    #[test]
    fn ranked_cursor_refuses_overrides_same_mtime_drift_and_foreign_sessions() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let path = root.join("worker.ts");
        let source = (0..12).map(|index| format!("function quasar{index}() {{\n  return {index};\n}}\n")).collect::<String>();
        std::fs::write(&path, &source).unwrap();
        let native = NativeSession::new(&root, false).unwrap();
        let first = call(&native, &json!({"root":root,"scope":root,"query":"quasar","kind":"auto","expand":2})).unwrap();
        let cursor = first.structured["data"]["cursor"].as_str().unwrap();
        for (field, value) in [("query", json!("other")), ("contextLines", json!(1)), ("scope", json!(root)),
            ("focus", json!({"target":format!("{}::quasar0", path.display())})), ("analysisRevision", json!("other"))] {
            let mut args = json!({"cursor":cursor}); args[field] = value;
            assert!(call(&native, &args).is_err(), "override {field} accepted");
        }
        let foreign = NativeSession::new(&root, false).unwrap();
        assert!(!foreign.session.cursor_owner_data(cursor)["ownsCursor"].as_bool().unwrap());
        assert!(call(&foreign, &json!({"cursor":cursor})).is_err());
        let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::fs::write(&path, source.replacen("return 0", "return 9", 1)).unwrap();
        std::fs::OpenOptions::new().write(true).open(&path).unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(mtime)).unwrap();
        assert!(call(&native, &json!({"cursor":cursor})).unwrap_err().contains("changed"));
    }

    #[test]
    fn ranked_cursor_optional_enrichment_failure_keeps_baseline_cursor_immutable() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::write(root.join("worker.ts"), (0..12).map(|index| format!("function quasar{index}() {{ return {index}; }}\n")).collect::<String>()).unwrap();
        let native = NativeSession::new(&root, false).unwrap();
        let args = json!({"root":root,"scope":root,"query":"quasar","kind":"auto","expand":2,"captureRanked":true});
        let first = call(&native, &args).unwrap();
        let id = first.structured["data"]["cursor"].as_str().unwrap();
        let descriptor = native.session.cursor_owner_data(id);
        let mut resume = args.clone(); resume.as_object_mut().unwrap().remove("captureRanked");
        resume["resumeRanked"] = json!(first.search_capture.unwrap());
        resume["analysisDatabase"] = json!(root.join("missing.sqlite"));
        resume["analysisRevision"] = json!("unavailable");
        assert!(call(&native, &resume).is_err());
        assert_eq!(native.session.cursor_owner_data(id), descriptor);
        assert!(call(&native, &json!({"cursor":id})).is_ok());

    }

    #[cfg(unix)]
    #[test]
    fn ranked_cursor_explicit_focused_test_alias_is_retained_and_retargeting_refused() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let path = root.join("worker.test.ts");
        let source = format!("function testRetry() {{\n{}}}\n", (0..210).map(|index| format!("  const part{index} = 'quasar retry {index}';\n")).collect::<String>());
        std::fs::write(&path, &source).unwrap();
        let alias = root.join("alias.ts");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        let native = NativeSession::new(&root, false).unwrap();
        let ordinary = json!({"root":root,"scope":root,"query":"quasar retry","kind":"auto","expand":2});
        assert_eq!(call(&native, &ordinary).unwrap().structured["data"]["definitions"], 0);
        let mut focused = ordinary.clone();
        focused["focus"] = json!({"target":format!("{}::testRetry", alias.display())});
        let first = call(&native, &focused).unwrap();
        assert_eq!(first.structured["data"]["focus"]["status"], "ok");
        let id = first.structured["data"]["cursor"].as_str().unwrap();
        assert_eq!(native.session.cursor_owner_data(id)["rankedCursor"]["focus"], focused["focus"]);
        assert!(call(&native, &json!({"cursor":id})).is_ok());
        let other = root.join("other.ts");
        std::fs::write(&other, &source).unwrap();
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&other, &alias).unwrap();
        assert!(call(&native, &json!({"cursor":id})).unwrap_err().contains("changed"));
    }

    #[test]
    fn ranked_cursor_owner_is_read_only_and_expiry_eviction_reset_are_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::write(root.join("worker.ts"), (0..12).map(|index| format!("function quasar{index}() {{ return {index}; }}\n")).collect::<String>()).unwrap();
        let native = NativeSession::new(&root, false).unwrap();
        let args = json!({"root":root,"scope":root,"query":"quasar","kind":"auto","expand":2});
        let first = call(&native, &args).unwrap();
        let first_id = first.structured["data"]["cursor"].as_str().unwrap();
        let cursor = native.session.get_ranked_cursor(first_id).unwrap();
        let mut evidence = RetainedRanked::new(root.clone(), &args, cursor.evidence.collection.clone(), &cursor.evidence.data).unwrap();
        Arc::get_mut(&mut evidence).unwrap().created = Instant::now() - CURSOR_TTL - Duration::from_secs(1);
        let expired = native.session.put_ranked_cursor(RankedCursor { evidence, progress: cursor.progress.clone() }, None).unwrap();
        let descriptor = native.session.cursor_owner_data(&expired);
        assert_eq!(descriptor["ownsCursor"], true);
        assert!(call(&native, &json!({"cursor":expired})).unwrap_err().contains("expired"));
        assert_eq!(native.session.cursor_owner_data(&expired), descriptor);
        for _ in 0..4 { assert!(call(&native, &args).unwrap().structured["data"]["cursor"].is_string()); }
        assert_eq!(native.session.cursor_owner_data(first_id)["ownsCursor"], false);
        native.session.reset();
        assert_eq!(native.session.cursor_owner_data(&expired)["ownsCursor"], false);
    }
}
