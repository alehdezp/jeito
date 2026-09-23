use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::search::capture::{RankedCapture, CAPTURE_TTL, MAX_CAPTURES, MAX_SESSION_CAPTURE_BYTES};
static NEXT_RANKED_CAPTURE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct CursorRecord {
    created: SystemTime,
    state: Value,
    ranked: Option<std::sync::Arc<crate::search::continuation::RankedCursor>>,
}

/// Tracks MCP activity across calls.
/// Stored alongside `OutlineCache` in server state.
pub struct Session {
    reads: AtomicUsize,
    searches: AtomicUsize,
    symbols: Mutex<HashMap<String, usize>>, // query → search count
    dir_hits: Mutex<HashMap<String, usize>>, // dir → count
    /// `path:line` → file mtime at expand-time. mtime versioning lets
    /// `is_expanded` detect stale records when the file has been edited
    /// since the expansion was first shown.
    expanded: Mutex<HashMap<String, SystemTime>>,
    dedup_enabled: bool,
    /// Cumulative token estimates: sum of full-file baseline tokens and
    /// tokens actually returned across all reads in this session.
    baseline_tokens: AtomicU64,
    saved_tokens: AtomicU64,
    /// Immutable, bounded, session-local grep continuation states.
    cursors: Mutex<HashMap<String, CursorRecord>>,
    ranked_captures: Mutex<HashMap<String, RankedCapture>>,
}

pub(crate) struct SessionSnapshot {
    pub(crate) reads: usize,
    pub(crate) searches: usize,
    pub(crate) top_queries: Vec<(String, usize)>,
    pub(crate) hot_paths: Vec<(String, usize)>,
}

impl Session {
    pub fn new() -> Self {
        Self::with_dedup(true)
    }

    pub fn without_dedup() -> Self {
        Self::with_dedup(false)
    }

    fn with_dedup(dedup_enabled: bool) -> Self {
        Session {
            reads: AtomicUsize::new(0),
            searches: AtomicUsize::new(0),
            symbols: Mutex::new(HashMap::new()),
            dir_hits: Mutex::new(HashMap::new()),
            expanded: Mutex::new(HashMap::new()),
            dedup_enabled,
            baseline_tokens: AtomicU64::new(0),
            saved_tokens: AtomicU64::new(0),
            cursors: Mutex::new(HashMap::new()),
            ranked_captures: Mutex::new(HashMap::new()),
        }
    }

    pub fn record_read(&self, path: &Path) {
        self.reads.fetch_add(1, Ordering::Relaxed);
        self.record_dir(path);
    }

    pub fn record_search(&self, query: &str) {
        self.searches.fetch_add(1, Ordering::Relaxed);
        let mut syms = self
            .symbols
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *syms.entry(query.to_string()).or_insert(0) += 1;
    }

    fn record_dir(&self, path: &Path) {
        if let Some(dir) = path.parent() {
            let key = dir.to_string_lossy().to_string();
            let mut dirs = self
                .dir_hits
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *dirs.entry(key).or_insert(0) += 1;
        }
    }

    /// Record a read event for savings accounting.
    /// `baseline_tokens`: estimated tokens for the full file (naive read).
    /// `returned_tokens`: estimated tokens for what pi-nav actually returned.
    /// Per-event clamp via `saturating_sub` ensures saved is never negative.
    pub fn record_savings(&self, baseline_tokens: u64, returned_tokens: u64) {
        self.baseline_tokens
            .fetch_add(baseline_tokens, Ordering::Relaxed);
        self.saved_tokens.fetch_add(
            baseline_tokens.saturating_sub(returned_tokens),
            Ordering::Relaxed,
        );
    }

    /// Returns `(baseline_tokens, saved_tokens)` accumulated this session.
    pub fn savings(&self) -> (u64, u64) {
        (
            self.baseline_tokens.load(Ordering::Relaxed),
            self.saved_tokens.load(Ordering::Relaxed),
        )
    }

    pub fn summary(&self) -> String {
        let reads = self.reads.load(Ordering::Relaxed);
        let searches = self.searches.load(Ordering::Relaxed);

        let mut out = format!("Files read: {reads} | Searches: {searches}");

        // Top symbols
        let syms = self
            .symbols
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !syms.is_empty() {
            let mut sorted: Vec<_> = syms.iter().collect();
            sorted.sort_by(|a, b| b.1.cmp(a.1));
            let top: Vec<String> = sorted
                .iter()
                .take(5)
                .map(|(name, count)| format!("{name} ({count})"))
                .collect();
            let _ = write!(out, "\nTop queries: {}", top.join(", "));
        }

        // Hot paths
        let dirs = self
            .dir_hits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !dirs.is_empty() {
            let mut sorted: Vec<_> = dirs.iter().collect();
            sorted.sort_by(|a, b| b.1.cmp(a.1));
            let top: Vec<String> = sorted
                .iter()
                .take(5)
                .map(|(dir, count)| format!("{dir} ({count})"))
                .collect();
            let _ = write!(out, "\nHot paths: {}", top.join(", "));
        }

        out
    }

    pub(crate) fn snapshot(&self) -> SessionSnapshot {
        let reads = self.reads.load(Ordering::Relaxed);
        let searches = self.searches.load(Ordering::Relaxed);
        let mut queries: Vec<_> = self
            .symbols
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|(query, count)| (query.clone(), *count))
            .collect();
        queries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        queries.truncate(5);
        let mut paths: Vec<_> = self
            .dir_hits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|(path, count)| (path.clone(), *count))
            .collect();
        paths.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        paths.truncate(5);
        SessionSnapshot {
            reads,
            searches,
            top_queries: queries,
            hot_paths: paths,
        }
    }

    pub fn reset(&self) {
        self.reads.store(0, Ordering::Relaxed);
        self.searches.store(0, Ordering::Relaxed);
        self.symbols
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.dir_hits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.expanded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.baseline_tokens.store(0, Ordering::Relaxed);
        self.saved_tokens.store(0, Ordering::Relaxed);
        self.ranked_captures.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
        let mut cursors = self
            .cursors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let datasets = cursors
            .values()
            .filter_map(|record| cursor_dataset_path(&record.state))
            .collect::<std::collections::HashSet<_>>();
        cursors.clear();
        drop(cursors);
        for path in datasets {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Return true only when this `(path, line)` was previously expanded
    /// AND the recorded mtime matches `current_mtime`. After-edit re-grok
    /// falls back to a full re-inline.
    pub fn is_expanded(&self, path: &Path, line: u32, current_mtime: SystemTime) -> bool {
        if !self.dedup_enabled {
            return false;
        }
        let key = format!("{}:{}", path.display(), line);
        self.expanded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&key)
            .is_some_and(|&recorded| recorded == current_mtime)
    }

    pub fn record_expand(&self, path: &Path, line: u32, mtime: SystemTime) {
        if self.dedup_enabled {
            let key = format!("{}:{}", path.display(), line);
            self.expanded
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(key, mtime);
        }
    }

    pub(crate) fn put_ranked_capture(&self, capture: RankedCapture) -> Result<String, String> {
        let mut captures = self.ranked_captures.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        captures.retain(|_, capture| capture.created.elapsed() < CAPTURE_TTL);
        while captures.len() >= MAX_CAPTURES
            || captures.values().map(|capture| capture.bytes).sum::<usize>() + capture.bytes > MAX_SESSION_CAPTURE_BYTES {
            let Some(oldest) = captures.iter().min_by_key(|(_, capture)| capture.created)
                .map(|(key, _)| key.clone()) else { return Err("ranked capture storage bound exceeded".into()); };
            captures.remove(&oldest);
        }
        let sequence = NEXT_RANKED_CAPTURE.fetch_add(1, Ordering::Relaxed);
        let digest = Sha256::digest(format!("{sequence}:{:?}", SystemTime::now()).as_bytes());
        let id = format!("ranked-{:x}", digest);
        captures.insert(id.clone(), capture);
        Ok(id)
    }

    pub(crate) fn take_ranked_capture(&self, id: &str) -> Result<RankedCapture, String> {
        let capture = self.ranked_captures.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(id).ok_or("ranked capture is missing, consumed or evicted; no search was rerun")?;
        if capture.created.elapsed() >= CAPTURE_TTL {
            return Err("ranked capture expired; no search was rerun".into());
        }
        Ok(capture)
    }

    pub(crate) fn put_cursor(&self, state: Value) -> String {
        let mut identity = state.clone();
        if let Some(object) = identity.as_object_mut() {
            object.remove("datasetPath");
            object.remove("diagnostics");
        }
        let encoded = serde_json::to_vec(&identity).expect("cursor state serializes");
        let digest = Sha256::digest(&encoded);
        let hex = digest[..12].iter().fold(String::new(), |mut out, byte| {
            use std::fmt::Write as _;
            let _ = write!(out, "{byte:02x}");
            out
        });
        let id = format!("grep-{hex}");
        let mut cursors = self
            .cursors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(existing) = cursors.get(&id) {
            let incoming = cursor_dataset_path(&state);
            let retained = cursor_dataset_path(&existing.state);
            if incoming != retained {
                // A private page origin may still own the incoming dataset even
                // when this successor deduplicates to another retained dataset.
                remove_cursor_dataset_if_unreferenced(&cursors, &state);
            }
            return id;
        }
        let evicted = if cursors.len() >= 64 {
            let oldest = cursors.iter().min_by_key(|(_, record)| record.created)
                .map(|(key, _)| key.clone());
            oldest.and_then(|key| cursors.remove(&key))
        } else { None };
        cursors.insert(
            id.clone(),
            CursorRecord {
                created: SystemTime::now(),
                state,
                ranked: None,
            },
        );
        // Cleanup must see the incoming reference: the evicted page origin can
        // be the only previous owner of this successor's backing dataset.
        if let Some(record) = evicted {
            remove_cursor_dataset_if_unreferenced(&cursors, &record.state);
        }
        id
    }

    pub(crate) fn put_ranked_cursor(&self, cursor: crate::search::continuation::RankedCursor, protected: Option<&str>) -> Result<String, String> {
        self.put_ranked_cursor_protected(cursor, &protected.into_iter().collect::<Vec<_>>())
    }

    pub(crate) fn put_ranked_cursor_protected(&self, cursor: crate::search::continuation::RankedCursor, protected: &[&str]) -> Result<String, String> {
        use crate::search::capture::{MAX_CAPTURES, MAX_SESSION_CAPTURE_BYTES};
        let progress_bytes = cursor.progress.accounted_bytes();
        if cursor.evidence.bytes.saturating_add(progress_bytes) > MAX_SESSION_CAPTURE_BYTES {
            return Err("ranked continuation exceeds session retention bounds".into());
        }
        let id = cursor.id();
        let mut cursors = self.cursors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if cursors.contains_key(&id) { return Ok(id); }
        loop {
            let mut states = std::collections::HashMap::from([(cursor.evidence.id.as_str(), cursor.evidence.bytes)]);
            let mut bytes = progress_bytes;
            for record in cursors.values().filter_map(|record| record.ranked.as_ref()) {
                states.insert(record.evidence.id.as_str(), record.evidence.bytes);
                bytes = bytes.saturating_add(record.progress.accounted_bytes());
            }
            bytes = bytes.saturating_add(states.values().sum::<usize>());
            if cursors.len() < 64 && states.len() <= MAX_CAPTURES && bytes <= MAX_SESSION_CAPTURE_BYTES { break; }
            // Optional enrichment must not evict the live cursor that its saved
            // fallback still needs if a later transport/admission check refuses.
            let Some(oldest) = cursors.iter().filter(|(id, _)| !protected.contains(&id.as_str()))
                .min_by_key(|(_, record)| record.created).map(|(id, _)| id.clone())
                else { return Err("ranked continuation exceeds session retention bounds".into()); };
            if let Some(record) = cursors.remove(&oldest) { remove_cursor_dataset_if_unreferenced(&cursors, &record.state); }
        }
        cursors.insert(id.clone(), CursorRecord { created: SystemTime::now(), state: serde_json::json!({"mode":"ranked"}), ranked: Some(std::sync::Arc::new(cursor)) });
        Ok(id)
    }

    pub(crate) fn get_ranked_cursor(&self, id: &str) -> Option<std::sync::Arc<crate::search::continuation::RankedCursor>> {
        self.cursors.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(id).and_then(|record| record.ranked.clone())
    }

    pub(crate) fn cursor_owner_data(&self, id: &str) -> Value {
        let cursors = self.cursors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut data = serde_json::json!({"ownsCursor":cursors.contains_key(id)});
        if let Some(ranked) = cursors.get(id).and_then(|record| record.ranked.as_ref()) {
            data["rankedCursor"] = ranked.evidence.descriptor();
        } else if let Some(record) = cursors.get(id) {
            data["matchesCursor"] = serde_json::json!(true);
            data["matchesAdmission"] = record.state["request"]["directoryAdmission"].clone();
        }
        data
    }

    /// Routing only: expiration and source validation still belong to `get_cursor`
    /// and `matches::execute`. Looking for an owner must not evict or remove files.
    pub(crate) fn contains_cursor(&self, id: &str) -> bool {
        self.cursors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(id)
    }

    pub(crate) fn get_cursor(&self, id: &str) -> Option<Value> {
        let mut cursors = self
            .cursors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let expired = cursors.get(id).is_some_and(|record| {
            record
                .created
                .elapsed()
                .is_ok_and(|age| age.as_secs() > 1800)
        });
        if expired {
            if let Some(record) = cursors.remove(id) {
                remove_cursor_dataset_if_unreferenced(&cursors, &record.state);
            }
            return None;
        }
        cursors.get(id).map(|record| record.state.clone())
    }
}

fn cursor_dataset_path(state: &Value) -> Option<std::path::PathBuf> {
    state
        .get("datasetPath")
        .and_then(Value::as_str)
        .map(std::path::PathBuf::from)
}

fn remove_cursor_dataset_if_unreferenced(cursors: &HashMap<String, CursorRecord>, removed: &Value) {
    let Some(path) = cursor_dataset_path(removed) else {
        return;
    };
    let referenced = cursors
        .values()
        .filter_map(|record| cursor_dataset_path(&record.state))
        .any(|candidate| candidate == path);
    if !referenced {
        let _ = std::fs::remove_file(path);
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_eviction_preserves_incoming_dataset_and_cleans_unreferenced_old_dataset() {
        for shared in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let old_dataset = directory.path().join("origin.jsonl");
            let incoming_dataset = if shared { old_dataset.clone() }
                else { directory.path().join("successor.jsonl") };
            std::fs::write(&old_dataset, "origin matches").unwrap();
            std::fs::write(&incoming_dataset, "successor matches").unwrap();
            let session = Session::new();
            let origin = session.put_cursor(serde_json::json!({
                "root": "/captured", "nextGroup": 0, "renderOrigin": true, "datasetPath": old_dataset,
            }));
            for slot in 0..63 {
                session.put_cursor(serde_json::json!({"slot": slot}));
            }
            {
                let mut cursors = session.cursors.lock().unwrap();
                assert_eq!(cursors.len(), 64);
                // Select eviction deterministically without invoking TTL lookup.
                cursors.get_mut(&origin).unwrap().created = SystemTime::UNIX_EPOCH;
            }
            let successor = session.put_cursor(serde_json::json!({
                "root": "/captured", "nextGroup": 1, "datasetPath": incoming_dataset,
            }));
            assert_eq!(session.cursors.lock().unwrap().len(), 64);
            assert!(!session.contains_cursor(&origin));
            let retained = session.get_cursor(&successor).unwrap();
            assert_eq!(retained["datasetPath"], serde_json::json!(incoming_dataset));
            assert_eq!(std::fs::read_to_string(&incoming_dataset).unwrap(), "successor matches");
            assert_eq!(old_dataset.exists(), shared, "unreferenced eviction must still clean up");
        }
    }

    #[test]
    fn duplicate_successor_preserves_dataset_shared_with_page_origin() {
        let directory = tempfile::tempdir().unwrap();
        let retained = directory.path().join("retained.jsonl");
        let incoming = directory.path().join("incoming.jsonl");
        let unreferenced = directory.path().join("unreferenced.jsonl");
        for path in [&retained, &incoming, &unreferenced] {
            std::fs::write(path, "retained matches").unwrap();
        }
        let session = Session::new();
        let successor = session.put_cursor(serde_json::json!({
            "root": "/captured", "nextGroup": 1, "datasetPath": retained,
        }));
        let origin = session.put_cursor(serde_json::json!({
            "root": "/captured", "nextGroup": 0, "renderOrigin": true, "datasetPath": incoming,
        }));
        let duplicate = session.put_cursor(serde_json::json!({
            "root": "/captured", "nextGroup": 1, "datasetPath": incoming,
        }));
        assert_eq!(duplicate, successor);
        assert_eq!(session.get_cursor(&duplicate).unwrap()["datasetPath"], serde_json::json!(retained));
        assert_eq!(std::fs::read_to_string(&incoming).unwrap(), "retained matches");
        assert!(retained.exists());

        // Dedupe must still discard a genuinely unowned replacement dataset.
        assert_eq!(session.put_cursor(serde_json::json!({
            "root": "/captured", "nextGroup": 1, "datasetPath": unreferenced,
        })), successor);
        assert!(!unreferenced.exists());

        session.cursors.lock().unwrap().get_mut(&origin).unwrap().created = SystemTime::UNIX_EPOCH;
        assert!(session.get_cursor(&origin).is_none());
        assert!(!incoming.exists());
        assert!(retained.exists());
        assert!(session.get_cursor(&successor).is_some());
    }

    #[test]
    fn cursor_owner_lookup_does_not_expire_or_remove_the_dataset() {
        let directory = tempfile::tempdir().unwrap();
        let dataset = directory.path().join("matches.jsonl");
        std::fs::write(&dataset, "retained dataset").unwrap();
        let session = Session::new();
        let id = session.put_cursor(serde_json::json!({
            "root": "/captured", "datasetPath": dataset.to_string_lossy(),
        }));
        session
            .cursors
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .created = SystemTime::UNIX_EPOCH;

        assert!(session.contains_cursor(&id));
        assert!(!session.contains_cursor("unknown"));
        assert_eq!(session.cursors.lock().unwrap().len(), 1);
        assert_eq!(
            std::fs::read_to_string(&dataset).unwrap(),
            "retained dataset"
        );
        assert!(session.get_cursor(&id).is_none());
        assert!(!session.contains_cursor(&id));
        assert!(
            !dataset.exists(),
            "only normal cursor access performs expiry cleanup"
        );
    }

    #[test]
    fn record_savings_accumulates_across_calls() {
        let session = Session::new();
        session.record_savings(1000, 200);
        session.record_savings(500, 100);
        let (baseline, saved) = session.savings();
        assert_eq!(baseline, 1500);
        assert_eq!(saved, 1200); // (1000-200) + (500-100)
    }

    #[test]
    fn record_savings_clamps_when_returned_exceeds_baseline() {
        let session = Session::new();
        // returned > baseline: saved contribution is 0, baseline still accumulates
        session.record_savings(100, 500);
        let (baseline, saved) = session.savings();
        assert_eq!(baseline, 100);
        assert_eq!(saved, 0);
    }

    #[test]
    fn record_savings_exact_match_adds_zero_saved() {
        let session = Session::new();
        session.record_savings(400, 400);
        let (baseline, saved) = session.savings();
        assert_eq!(baseline, 400);
        assert_eq!(saved, 0);
    }

    #[test]
    fn savings_getter_returns_both_counters() {
        let session = Session::new();
        let (b, s) = session.savings();
        assert_eq!(b, 0);
        assert_eq!(s, 0);
        session.record_savings(300, 50);
        let (b2, s2) = session.savings();
        assert_eq!(b2, 300);
        assert_eq!(s2, 250);
    }

    #[test]
    fn reset_zeroes_savings_counters() {
        let session = Session::new();
        session.record_savings(1000, 100);
        let (b, s) = session.savings();
        assert!(
            b > 0 && s > 0,
            "precondition: counters non-zero before reset"
        );
        session.reset();
        let (b2, s2) = session.savings();
        assert_eq!(b2, 0, "baseline_tokens must be zero after reset");
        assert_eq!(s2, 0, "saved_tokens must be zero after reset");
    }
}
