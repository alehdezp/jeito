use std::collections::{BTreeSet, HashMap};
use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, AtomicUsize, Ordering},
    Arc,
};
use std::time::{SystemTime, UNIX_EPOCH};

use grep_matcher::Matcher;
use grep_regex::RegexMatcher;
use grep_searcher::{
    BinaryDetection, MmapChoice, Searcher, SearcherBuilder, Sink, SinkFinish, SinkMatch,
};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::cache::OutlineCache;
use crate::dispatch::OperationContext;
use crate::output::{IncompleteReason, SourceRow, ToolOutput};
use crate::session::Session;
use crate::types::{is_test_file, FileType};
use crate::walk::{EffectiveFilterPolicy, EntryKind, Visibility, WalkOptions};

mod toml_context;

/// Bounded serialized candidate pool for one rendered page. This is
/// deliberately much larger than the rendered hard ceiling: hierarchy-rich
/// dataset records can be several times larger than their visible C0 blocks.
/// Render-time assembly, not record overhead, owns pagination.
const PAGE_TARGET_BYTES: usize = 128_000;
/// Soft page target in rendered bytes (≈3,000 tokens at bytes/4): the tier
/// mixer demotes per-window context toward it — never a global tier step
/// (user law 2026-09-01: half the matches at C2 and half at C1 is valid).
/// The target is capped by the page's real metadata budget, so a visible
/// target ledger reduces optional context before it paginates.
const SOFT_RENDERED_BYTES: usize = 12_000;
/// Hard page ceiling in rendered bytes (≈4,000 tokens): pages fill to here;
/// pagination begins only past it — soft may be exceeded to prevent
/// pagination (user law 2026-09-01).
const HARD_RENDERED_BYTES: usize = 16_000;
/// Session cursor receipts are `grep-` + 24 hex (`Session::put_cursor`). The fit
/// budget reserves the successor line at the exact length the page prints.
const CURSOR_ID_PREFIX: &str = "grep-";
const CURSOR_ID_HEX_CHARS: usize = 24;
const MORE_CURSOR_PREFIX: &str = "More: cursor ";
const MAX_CONTEXT_LINES: u8 = 10;
const MAX_RENDERED_LINE_BYTES: usize = 2_000;
const MAX_GROUP_RECORD_BYTES: usize = 64 * 1024;
const MAX_LEDGER_REASONS: usize = 8;
// A tree full of skipped candidates (venvs, build caches) must never turn the
// response into an exceptions dump — the project-navigation failure rendered
// ~1.6 MB of "Exceptional:" lines for a single search.
const MAX_RENDERED_EXCEPTIONS: usize = 20;
const MAX_STRUCTURED_EXCEPTIONS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TargetOutcome {
    Searched,
    Zero,
    Skipped,
    Partial,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetLedgerRow {
    requested: String,
    canonical: Option<String>,
    candidates: usize,
    searched: usize,
    occurrences: usize,
    outcome: TargetOutcome,
    reasons: Vec<String>,
    explicit_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExceptionalOutcome {
    path: String,
    outcome: TargetOutcome,
    reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MatchSpan {
    start_byte: usize,
    end_byte: usize,
    start_column: usize,
    end_column: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnerRegion {
    kind: String,
    name: String,
    start: u32,
    end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutlineItem {
    kind: String,
    name: String,
    start: u32,
    end: u32,
    selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrichedLine {
    path: String,
    line: u32,
    text: String,
    #[serde(default, skip_serializing_if = "is_false")]
    text_clipped: bool,
    spans: Vec<MatchSpan>,
    role: String,
    owner: Option<OwnerRegion>,
    outline: Vec<OutlineItem>,
    enrichment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatchGroup {
    path: String,
    owner: Option<OwnerRegion>,
    outline: Vec<OutlineItem>,
    matches: Vec<EnrichedLine>,
}

#[derive(Debug, Clone)]
struct Candidate {
    path: PathBuf,
    selectors: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SourceSignature {
    path: String,
    size: u64,
    modified_ns: Option<u128>,
    digest: Option<String>,
}

/// Compiled policy is per owner, while selection remains per explicit directory.
/// This is query/cursor memory only; binary/heavy eligibility still belongs to Matches.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MatchesPolicy {
    root: PathBuf,
    policy: crate::walk::CorpusPolicy,
    policy_digest: String,
    policy_files: Vec<super::PolicyInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MatchesAdmission {
    owners: Vec<MatchesPolicy>,
    directories: std::collections::BTreeMap<PathBuf, usize>,
    explicit_files: BTreeSet<PathBuf>,
    /// Selected `all` visibility: the admission was compiled for widened
    /// visibility and must match the request's own visibility exactly.
    #[serde(default, skip_serializing_if = "is_false")]
    all_visibility: bool,
}

impl MatchesAdmission {
    fn validate(&self) -> Result<(), String> {
        let digest = |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
        if self.owners.len() > 64 || self.directories.len() + self.explicit_files.len() > 64 {
            return Err("Matches admission exceeds target bounds".into());
        }
        for owner in &self.owners {
            if !owner.root.is_absolute() || owner.root.canonicalize().ok().as_ref() != Some(&owner.root)
                || !owner.root.is_dir() || !digest(&owner.policy_digest)
                || owner.policy_files.is_empty() || owner.policy_files.len() > 16
                || owner.policy_files.iter().any(|input| !input.path.is_absolute()
                    || input.digest.as_ref().is_some_and(|value| !digest(value))) {
                return Err("invalid Matches policy identity".into());
            }
            super::validate_policy_inputs(&owner.policy_files).map_err(|error| error.to_string())?;
        }
        if self.directories.iter().any(|(directory, index)| self.owners.get(*index)
            .is_none_or(|owner| !directory.is_absolute() || !directory.starts_with(&owner.root)))
            || self.explicit_files.iter().any(|file| !file.is_absolute()) {
            return Err("invalid Matches selector admission".into());
        }
        Ok(())
    }

    fn validate_source(&self, path: &Path) -> Result<(), String> {
        self.validate()?;
        if path.canonicalize().ok().as_deref() != Some(path) { return Err("Matches source path changed".into()); }
        if self.explicit_files.contains(path) { return Ok(()); }
        for (directory, index) in &self.directories {
            if !path.starts_with(directory) { continue; }
            let root = &self.owners[*index].root;
            let mut parent = path.parent();
            let mut independent = false;
            while let Some(current) = parent.filter(|current| *current != root) {
                if current.join(".git").exists() || current.join(".pi-navigation.json").is_file() { independent = true; break; }
                parent = current.parent();
            }
            if !independent { return Ok(()); }
        }
        Err("Matches source is outside its retained directory admission; restart the audit".into())
    }
}

fn candidate_membership(candidates: &[Candidate]) -> String {
    let mut identities = candidates.iter().map(|candidate| (&candidate.path, &candidate.selectors)).collect::<Vec<_>>();
    identities.sort();
    format!("{:x}", Sha256::digest(serde_json::to_vec(&identities).expect("candidate identities serialize")))
}

fn validate_directory_membership(request: &NormalizedRequest, context: &OperationContext) -> Result<(), String> {
    if let Some(admission) = &request.directory_admission {
        admission.validate()?;
        let visibility = Visibility::parse(Some(&request.visibility))?;
        let (_, candidates, _, _, _) = plan_targets(&request.paths, &request.requested_paths,
            &request.globs, visibility, context, Some(admission))?;
        if request.directory_membership.as_deref() != Some(candidate_membership(&candidates).as_str()) {
            return Err("Matches directory admission changed; restart the audit".into());
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NormalizedRequest {
    pattern: String,
    paths: Vec<String>,
    #[serde(default)]
    requested_paths: Vec<String>,
    syntax: String,
    requested_syntax: String,
    case_mode: String,
    effective_case: String,
    visibility: String,
    globs: Vec<String>,
    #[serde(default)]
    directory_admission: Option<MatchesAdmission>,
    #[serde(default)]
    directory_membership: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatchCursorState {
    version: u8,
    request: NormalizedRequest,
    root: String,
    next_offset: u64,
    next_group: usize,
    #[serde(default)]
    next_match: usize,
    context_explicit: Option<u8>,
    signatures: Vec<SourceSignature>,
    ledger: Vec<TargetLedgerRow>,
    filter_text: String,
    filter_data: Value,
    exceptions: Vec<ExceptionalOutcome>,
    diagnostics: Vec<String>,
    coverage_complete: bool,
    dataset_path: String,
    group_count: usize,
    total_occurrences: usize,
    /// Private retained-render page origin: only `renderMatches` may replay it.
    /// An ordinary public cursor request must reject it and never rescan.
    #[serde(default, skip_serializing_if = "is_false")]
    retained_render: bool,
    /// The retained page is the scan's first page, so its replay must not print
    /// the continuation header.
    #[serde(default, skip_serializing_if = "is_false")]
    first_page: bool,
}

struct ScanResult {
    request: NormalizedRequest,
    ledger: Vec<TargetLedgerRow>,
    filter_text: String,
    filter_data: Value,
    exceptions: Vec<ExceptionalOutcome>,
    dataset_path: PathBuf,
    group_count: usize,
    total_occurrences: usize,
    signatures: Vec<SourceSignature>,
    diagnostics: Vec<String>,
    coverage_complete: bool,
}

#[cfg(test)]
static STREAM_SCAN_COUNTS: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, (usize, usize)>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
fn note_stream_scan(path: &Path) {
    let counts = STREAM_SCAN_COUNTS.get_or_init(Default::default);
    let mut counts = counts
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    counts.entry(path.to_path_buf()).or_insert((0, 0)).0 += 1;
}

#[cfg(test)]
fn stream_scan_count(path: &Path) -> usize {
    STREAM_SCAN_COUNTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(path)
        .map(|counts| counts.0)
        .unwrap_or(0)
}

#[cfg(test)]
fn source_read_count(path: &Path) -> usize {
    STREAM_SCAN_COUNTS.get_or_init(Default::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(path).map_or(0, |counts| counts.1)
}

fn read_matches_source(path: &Path) -> io::Result<Vec<u8>> {
    #[cfg(test)] {
        STREAM_SCAN_COUNTS.get_or_init(Default::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(path.to_path_buf()).or_insert((0, 0)).1 += 1;
    }
    let mut bytes = Vec::new();
    super::open_source(path)?.read_to_end(&mut bytes)?;
    Ok(bytes)
}

static DATASET_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn dataset_path() -> PathBuf {
    let sequence = DATASET_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    std::env::temp_dir().join(format!(
        "pi-nav-grep-{}-{stamp}-{sequence}.jsonl",
        std::process::id()
    ))
}

#[derive(Debug, Default)]
struct ScanMetrics {
    streamed_files: AtomicUsize,
    snapshot_reads: AtomicUsize,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
}

struct InFlightGuard<'a>(&'a ScanMetrics);

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

impl ScanMetrics {
    fn enter(&self) -> InFlightGuard<'_> {
        self.streamed_files.fetch_add(1, Ordering::Relaxed);
        let current = self.in_flight.fetch_add(1, Ordering::Relaxed) + 1;
        self.max_in_flight.fetch_max(current, Ordering::Relaxed);
        InFlightGuard(self)
    }
}
#[derive(Debug, Serialize, Deserialize)]
struct RawMatchedLine {
    line: u32,
    text: String,
    #[serde(default, skip_serializing_if = "is_false")]
    text_clipped: bool,
    spans: Vec<MatchSpan>,
}

#[derive(Debug)]
struct CandidateScan {
    candidate: Candidate,
    path_label: String,
    signature: Option<SourceSignature>,
    raw_path: Option<PathBuf>,
    occurrences: usize,
    byte_count: u64,
    binary: bool,
    error: Option<String>,
}

struct TempFileGuard(Option<PathBuf>);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

struct ValidatingReader<'a> {
    file: File,
    context: &'a OperationContext,
    utf8_tail: Vec<u8>,
    hasher: Sha256,
}

impl<'a> ValidatingReader<'a> {
    fn new(file: File, context: &'a OperationContext) -> Self {
        Self {
            file,
            context,
            utf8_tail: Vec::with_capacity(4),
            hasher: Sha256::new(),
        }
    }

    fn validate_chunk(&mut self, bytes: &[u8], eof: bool) -> io::Result<()> {
        let mut joined = Vec::with_capacity(self.utf8_tail.len() + bytes.len());
        joined.extend_from_slice(&self.utf8_tail);
        joined.extend_from_slice(bytes);
        self.utf8_tail.clear();
        match std::str::from_utf8(&joined) {
            Ok(_) => Ok(()),
            Err(error) if error.error_len().is_none() && !eof => {
                self.utf8_tail
                    .extend_from_slice(&joined[error.valid_up_to()..]);
                Ok(())
            }
            Err(_) => Err(io::Error::new(io::ErrorKind::InvalidData, "invalid_utf8")),
        }
    }

    fn digest_hex(&self) -> String {
        let digest = self.hasher.clone().finalize();
        digest.iter().fold(String::new(), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
    }
}

impl Read for ValidatingReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.context
            .check()
            .map_err(|error| io::Error::new(io::ErrorKind::Interrupted, error.to_string()))?;
        let read = self.file.read(buffer)?;
        if read == 0 {
            self.validate_chunk(&[], true)?;
            return Ok(0);
        }
        self.hasher.update(&buffer[..read]);
        self.validate_chunk(&buffer[..read], false)?;
        Ok(read)
    }
}

struct MatchSink<'a> {
    matcher: &'a RegexMatcher,
    context: &'a OperationContext,
    writer: BufWriter<File>,
    occurrences: usize,
    binary: bool,
    byte_count: u64,
}

impl<'a> MatchSink<'a> {
    fn new(
        matcher: &'a RegexMatcher,
        context: &'a OperationContext,
        writer: BufWriter<File>,
    ) -> Self {
        Self {
            matcher,
            context,
            writer,
            occurrences: 0,
            binary: false,
            byte_count: 0,
        }
    }
}

impl Sink for MatchSink<'_> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, matched: &SinkMatch<'_>) -> io::Result<bool> {
        self.context
            .check()
            .map_err(|error| io::Error::new(io::ErrorKind::Interrupted, error.to_string()))?;
        let raw = matched.bytes();
        let raw = raw.strip_suffix(b"\n").unwrap_or(raw);
        let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
        let text = std::str::from_utf8(raw)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid_utf8"))?;
        let mut spans = Vec::new();
        self.matcher
            .find_iter(raw, |found| {
                spans.push(MatchSpan {
                    start_byte: found.start(),
                    end_byte: found.end(),
                    start_column: text[..found.start()].chars().count(),
                    end_column: text[..found.end()].chars().count(),
                });
                true
            })
            .map_err(|error| io::Error::other(error.to_string()))?;
        if !spans.is_empty() {
            self.occurrences += spans.len();
            let (display_text, text_clipped) = bounded_line(text, &spans);
            serde_json::to_writer(
                &mut self.writer,
                &RawMatchedLine {
                    line: matched.line_number().unwrap_or(1) as u32,
                    text: display_text,
                    text_clipped,
                    spans,
                },
            )
            .map_err(io::Error::other)?;
            self.writer.write_all(b"\n")?;
        }
        Ok(true)
    }

    fn binary_data(&mut self, _searcher: &Searcher, _offset: u64) -> io::Result<bool> {
        self.binary = true;
        Ok(false)
    }

    fn finish(&mut self, _searcher: &Searcher, finish: &SinkFinish) -> io::Result<()> {
        self.byte_count = finish.byte_count();
        if finish.binary_byte_offset().is_some() {
            self.binary = true;
        }
        self.writer.flush()?;
        Ok(())
    }
}

fn build_stream_searcher() -> Searcher {
    SearcherBuilder::new()
        .line_number(true)
        .multi_line(false)
        .memory_map(MmapChoice::never())
        .bom_sniffing(false)
        .binary_detection(BinaryDetection::quit(0))
        .build()
}

fn scan_candidate_streaming(
    candidate: Candidate,
    matcher: &RegexMatcher,
    searcher: &mut Searcher,
    context: &OperationContext,
    metrics: &ScanMetrics,
) -> CandidateScan {
    let _in_flight = metrics.enter();
    let path_label = relative_path(&candidate.path, &context.root);
    // Per-candidate deadline poll: the Rayon parallel scan (scan_request:767) runs
    // after the bounded discovery walk and is not otherwise time-checked, so a
    // huge discovered set (index backups, node_modules via visibility=all/out-of-root)
    // could peg CPU well past context.deadline. Mirror the early-return error shape so
    // the existing `error.contains("deadline")` -> Partial handling (:822) applies.
    if context
        .deadline
        .is_some_and(|deadline| std::time::Instant::now() >= deadline)
    {
        return CandidateScan {
            candidate,
            path_label,
            signature: None,
            raw_path: None,
            occurrences: 0,
            byte_count: 0,
            binary: false,
            error: Some("deadline".to_string()),
        };
    }
    let canonical_path = candidate.path.to_string_lossy().into_owned();
    #[cfg(test)]
    note_stream_scan(&candidate.path);
    let metadata = match std::fs::metadata(&candidate.path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return CandidateScan {
                candidate,
                path_label,
                signature: None,
                raw_path: None,
                occurrences: 0,
                byte_count: 0,
                binary: false,
                error: Some(format!("read metadata: {error}")),
            };
        }
    };
    // Skip files > 4 MiB before opening (ported from oh-my-pi MAX_FILE_BYTES, grep.rs:35).
    // Surfaces as Skipped → coverage partial (compact grep.ts line), not a per-file dump.
    const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
    if metadata.len() > MAX_FILE_BYTES {
        return CandidateScan {
            candidate,
            path_label,
            signature: None,
            raw_path: None,
            occurrences: 0,
            byte_count: 0,
            binary: false,
            error: Some("oversized".to_string()),
        };
    }
    let file = match super::open_source(&candidate.path) {
        Ok(file) => file,
        Err(error) => {
            return CandidateScan {
                candidate,
                path_label,
                signature: None,
                raw_path: None,
                occurrences: 0,
                byte_count: 0,
                binary: false,
                error: Some(format!("read: {error}")),
            };
        }
    };
    let raw_path = dataset_path();
    let raw_file = match OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&raw_path)
    {
        Ok(file) => file,
        Err(error) => {
            return CandidateScan {
                candidate,
                path_label,
                signature: None,
                raw_path: None,
                occurrences: 0,
                byte_count: 0,
                binary: false,
                error: Some(format!("create match spool: {error}")),
            };
        }
    };
    let mut reader = ValidatingReader::new(file, context);
    let mut sink = MatchSink::new(matcher, context, BufWriter::new(raw_file));
    let result = searcher.search_reader(matcher, &mut reader, &mut sink);
    let digest = (result.is_ok() && !sink.binary).then(|| reader.digest_hex());
    let error = result.err().map(|error| {
        if error.kind() == io::ErrorKind::InvalidData {
            "invalid_utf8".to_string()
        } else {
            format!("read: {error}")
        }
    });
    CandidateScan {
        candidate,
        path_label,
        signature: Some(SourceSignature {
            path: canonical_path,
            size: metadata.len(),
            modified_ns: metadata.modified().ok().and_then(system_time_ns),
            digest,
        }),
        raw_path: Some(raw_path),
        occurrences: if error.is_none() && !sink.binary {
            sink.occurrences
        } else {
            0
        },
        byte_count: sink.byte_count,
        binary: sink.binary,
        error,
    }
}

pub(crate) fn execute(
    args: &Value,
    cache: &OutlineCache,
    session: &Session,
    context: &OperationContext,
) -> Result<ToolOutput, String> {
    // Private retained-render replay: refit the retained page start under a byte
    // allowance, never rescan and never accept a new query or context override.
    if let Some(handle) = args.get("renderMatches") {
        let handle = handle
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .ok_or("renderMatches requires an original-progress handle")?;
        if args.as_object().is_some_and(|object| {
            object.keys().any(|key| {
                !matches!(key.as_str(), "renderMatches" | "matchesRenderBytes" | "root")
            })
        }) {
            return Err(
                "renderMatches accepts only its original-progress handle and matchesRenderBytes"
                    .into(),
            );
        }
        let allowance = match args.get("matchesRenderBytes") {
            None => HARD_RENDERED_BYTES,
            Some(value) => value
                .as_u64()
                .filter(|value| (1..=HARD_RENDERED_BYTES as u64).contains(value))
                .ok_or("matchesRenderBytes must be an integer from 1 through 16000")?
                as usize,
        };
        let value = session.get_cursor(handle).ok_or_else(|| {
            "retained render origin is unavailable or expired; reissue the original audit"
                .to_string()
        })?;
        let state: MatchCursorState = serde_json::from_value(value)
            .map_err(|error| format!("cursor state is invalid: {error}"))?;
        if state.version != 4 {
            return Err("cursor version is unsupported; restart the search".into());
        }
        if !state.retained_render {
            return Err("renderMatches requires a retained Matches render origin".into());
        }
        if Path::new(&state.root) != context.root {
            return Err(
                "cursor root mismatch; restart the search in the original project root".into(),
            );
        }
        let first_page = state.first_page;
        let context_request = state.context_explicit;
        let scan = ScanResult {
            request: state.request,
            ledger: state.ledger,
            filter_text: state.filter_text,
            filter_data: state.filter_data,
            exceptions: state.exceptions,
            dataset_path: PathBuf::from(state.dataset_path),
            group_count: state.group_count,
            total_occurrences: state.total_occurrences,
            signatures: state.signatures,
            diagnostics: state.diagnostics,
            coverage_complete: state.coverage_complete,
        };
        let output = render_page(
            scan,
            state.next_offset,
            state.next_group,
            state.next_match,
            context_request,
            session,
            context,
            !first_page,
            // The replay retains the same page origin: the store deduplicates the
            // identical page-start state back to this handle, which keeps the
            // canonical dataset alive even when the refit is complete and has no
            // successor.
            true,
            allowance,
        )?;
        // The replay must answer with the origin it was asked to replay: the
        // canonical stored state is the render source, so a different handle
        // would mean the render no longer belongs to this origin.
        if output.matches_render_cursor.as_deref() != Some(handle) {
            return Err(
                "retained render origin changed identity during replay; reissue the original audit"
                    .into(),
            );
        }
        return Ok(output);
    }
    if let Some(cursor) = args.get("cursor").and_then(Value::as_str) {
        if args.as_object().is_some_and(|object| {
            object.keys().any(|key| {
                !matches!(key.as_str(), "cursor" | "contextLines" | "root" | "retainMatchesRender")
            })
        }) {
            return Err(
                "cursor continuation accepts only cursor, contextLines and retainMatchesRender"
                    .into(),
            );
        }
        let retain_render = match args.get("retainMatchesRender") {
            None | Some(Value::Bool(false)) => false,
            Some(Value::Bool(true)) => true,
            _ => return Err("retainMatchesRender must be a boolean".into()),
        };
        // The byte allowance is refit-only; a continuation page uses the default
        // page ceiling while still retaining its own page origin.
        let value = session.get_cursor(cursor).ok_or_else(|| {
            "cursor is unknown, expired, or evicted; restart the search".to_string()
        })?;
        let state: MatchCursorState = serde_json::from_value(value)
            .map_err(|error| format!("cursor state is invalid: {error}"))?;
        if state.version != 4 {
            return Err("cursor version is unsupported; restart the search".into());
        }
        if state.retained_render {
            return Err(
                "retained render origin is private; refit it with renderMatches, do not continue it as an audit cursor"
                    .into(),
            );
        }
        if Path::new(&state.root) != context.root {
            return Err(
                "cursor root mismatch; restart the search in the original project root".into(),
            );
        }
        let context_request = parse_context(args.get("contextLines"))?.or(state.context_explicit);
        let scan = ScanResult {
            request: state.request,
            ledger: state.ledger,
            filter_text: state.filter_text,
            filter_data: state.filter_data,
            exceptions: state.exceptions,
            dataset_path: PathBuf::from(state.dataset_path),
            group_count: state.group_count,
            total_occurrences: state.total_occurrences,
            signatures: state.signatures,
            diagnostics: state.diagnostics,
            coverage_complete: state.coverage_complete,
        };
        return render_page(
            scan,
            state.next_offset,
            state.next_group,
            state.next_match,
            context_request,
            session,
            context,
            true,
            retain_render,
            HARD_RENDERED_BYTES,
        );
    }
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or("missing required parameter: pattern")?
        .to_string();
    if pattern.is_empty() {
        return Err("pattern must not be empty".into());
    }
    let requested_syntax = args.get("syntax").and_then(Value::as_str).unwrap_or("auto");
    if !matches!(requested_syntax, "auto" | "literal" | "regex") {
        return Err("matches syntax must be auto, literal, or regex".into());
    }
    let syntax = if requested_syntax == "auto" && strong_regex_intent(&pattern) {
        "regex"
    } else if requested_syntax == "auto" {
        "literal"
    } else {
        requested_syntax
    };
    let case_mode = args.get("case").and_then(Value::as_str).unwrap_or("smart");
    if !matches!(case_mode, "smart" | "sensitive" | "insensitive") {
        return Err("case must be smart, sensitive, or insensitive".into());
    }
    let sensitive = case_mode == "sensitive"
        || (case_mode == "smart" && pattern.chars().any(char::is_uppercase));
    let paths = input_paths(args, &context.root)?;
    let requested_paths = input_requested_paths(args)?.unwrap_or_else(|| paths.clone());
    if requested_paths.len() != paths.len() {
        return Err("requested path identity count does not match resolved paths".into());
    }
    let globs = input_globs(args.get("glob"))?;
    let visibility = Visibility::parse(args.get("visibility").and_then(Value::as_str))?;
    let directory_admission = args.get("matchesAdmission").map(|value| {
        if value.to_string().len() > 128 * 1024 { return Err("Matches admission exceeds private metadata bounds".to_string()); }
        let admission: MatchesAdmission = serde_json::from_value(value.clone()).map_err(|_| "invalid Matches admission".to_string())?;
        if admission.all_visibility != (visibility == Visibility::All) {
            return Err("Matches admission visibility does not match the requested visibility".into());
        }
        admission.validate()?;
        Ok(admission)
    }).transpose()?;
    let request = NormalizedRequest {
        pattern,
        paths,
        requested_paths,
        requested_syntax: requested_syntax.to_string(),
        syntax: syntax.to_string(),
        case_mode: case_mode.to_string(),
        effective_case: if sensitive {
            "sensitive"
        } else {
            "insensitive"
        }
        .into(),
        visibility: match visibility {
            Visibility::Project => "project",
            Visibility::All => "all",
        }
        .into(),
        directory_admission,
        directory_membership: None,
        globs,
    };
    let retain_render = match args.get("retainMatchesRender") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        _ => return Err("retainMatchesRender must be a boolean".into()),
    };
    if args.get("matchesRenderBytes").is_some() {
        return Err("matchesRenderBytes requires a renderMatches origin".into());
    }
    // The byte allowance is refit-only: an initial audit renders at the default
    // page ceiling and merely retains its page origin.
    let context_request = parse_context(args.get("contextLines"))?;
    let scan = scan_request(&request, cache, context)?;
    render_page(
        scan,
        0,
        0,
        0,
        context_request,
        session,
        context,
        false,
        retain_render,
        HARD_RENDERED_BYTES,
    )
}

fn input_paths(args: &Value, root: &Path) -> Result<Vec<String>, String> {
    let values = match args.get("paths") {
        None => vec![root.to_string_lossy().into_owned()],
        Some(Value::String(path)) => vec![path.clone()],
        Some(Value::Array(paths)) => paths
            .iter()
            .map(|path| {
                path.as_str()
                    .map(str::to_string)
                    .ok_or("paths must contain strings")
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("paths must be a string or array of strings".into()),
    };
    if values.is_empty() {
        return Err("paths must contain at least one target".into());
    }
    if values.len() > 64 {
        return Err("paths limited to 64 targets".into());
    }
    Ok(values)
}

fn input_requested_paths(args: &Value) -> Result<Option<Vec<String>>, String> {
    let Some(value) = args.get("requestedPaths") else {
        return Ok(None);
    };
    let paths = match value {
        Value::String(path) => vec![path.clone()],
        Value::Array(paths) => paths
            .iter()
            .map(|path| {
                path.as_str()
                    .map(str::to_string)
                    .ok_or("requestedPaths must contain strings")
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err("requestedPaths must be a string or array of strings".into()),
    };
    Ok(Some(paths))
}

fn input_globs(value: Option<&Value>) -> Result<Vec<String>, String> {
    let values = match value {
        None => Vec::new(),
        Some(Value::String(value)) => vec![value.clone()],
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or("glob must contain strings")
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("glob must be a string or array of strings".into()),
    };
    if values.len() > 20 {
        return Err("glob limited to 20 patterns".into());
    }
    for pattern in &values {
        globset::Glob::new(pattern.strip_prefix('!').unwrap_or(pattern))
            .map_err(|error| format!("invalid glob {pattern:?}: {error}"))?;
    }
    Ok(values)
}

fn parse_context(value: Option<&Value>) -> Result<Option<u8>, String> {
    let Some(value) = value else { return Ok(None) };
    let number = value.as_u64().ok_or("contextLines must be an integer")?;
    if number > u64::from(MAX_CONTEXT_LINES) {
        return Err(format!(
            "contextLines must be between 0 and {MAX_CONTEXT_LINES}"
        ));
    }
    Ok(Some(number as u8))
}

fn strong_regex_intent(pattern: &str) -> bool {
    let mut escaped = false;
    let mut class_depth = 0usize;
    let mut group_depth = 0usize;
    let mut strong = pattern.starts_with('^')
        || pattern.ends_with('$')
        || pattern.contains(".*")
        || pattern.contains(".+");
    for character in pattern.chars() {
        if escaped {
            strong = true;
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '[' => {
                class_depth += 1;
                strong = true;
            }
            ']' => class_depth = class_depth.saturating_sub(1),
            '(' => {
                group_depth += 1;
                strong = true;
            }
            ')' => group_depth = group_depth.saturating_sub(1),
            '|' if class_depth == 0 => strong = true,
            '*' | '+' | '?' if class_depth == 0 => strong = true,
            _ => {}
        }
    }
    strong
}
fn scan_request(
    request: &NormalizedRequest,
    cache: &OutlineCache,
    context: &OperationContext,
) -> Result<ScanResult, String> {
    let visibility = Visibility::parse(Some(&request.visibility))?;
    let (mut ledger, candidates, policies, mut diagnostics, mut coverage_complete) = plan_targets(
        &request.paths,
        &request.requested_paths,
        &request.globs,
        visibility,
        context,
        request.directory_admission.as_ref(),
    )?;
    let mut retained_request = request.clone();
    if request.directory_admission.is_some() { retained_request.directory_membership = Some(candidate_membership(&candidates)); }
    let expression = if request.syntax == "literal" {
        regex_syntax::escape(&request.pattern)
    } else {
        request.pattern.clone()
    };
    let expression = if request.effective_case == "insensitive" {
        format!("(?i:{expression})")
    } else {
        expression
    };
    RegexMatcher::new(&expression)
        .map_err(|error| format!("invalid regex {:?}: {error}", request.pattern))?;

    // Indexed parallel iteration preserves candidate order in the collected
    // vector while each Rayon worker reuses its grep-searcher line buffer.
    let metrics = Arc::new(ScanMetrics::default());
    let scans: Vec<CandidateScan> = candidates
        .into_par_iter()
        .map_init(
            || {
                (
                    build_stream_searcher(),
                    RegexMatcher::new(&expression)
                        .expect("expression validated before parallel scan"),
                )
            },
            |(searcher, matcher), candidate| {
                if let Some(admission) = &request.directory_admission { admission.validate_source(&candidate.path)?; }
                Ok::<_, String>(scan_candidate_streaming(candidate, matcher, searcher, context, &metrics))
            },
        )
        .collect::<Result<Vec<_>, String>>()?;

    let path = dataset_path();
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|error| format!("create cursor dataset: {error}"))?;
    let mut writer = BufWriter::new(file);
    let mut group_count = 0usize;
    let mut total_occurrences = 0usize;
    let mut signatures = Vec::new();
    let mut exceptions = Vec::new();

    for scan in scans {
        let candidate = scan.candidate;
        let path_label = scan.path_label;
        let _raw_guard = TempFileGuard(scan.raw_path.clone());
        if let Some(signature) = scan.signature.clone() {
            signatures.push(signature);
        }
        if scan.binary {
            coverage_complete = false;
            exceptions.push(ExceptionalOutcome {
                path: path_label.clone(),
                outcome: TargetOutcome::Skipped,
                reason: "binary_nul".into(),
            });
            mark_candidate_exception(
                &mut ledger,
                &candidate,
                &path_label,
                TargetOutcome::Skipped,
                "binary_nul",
            );
            continue;
        }
        if let Some(error) = scan.error {
            coverage_complete = false;
            let (outcome, reason) = if error == "invalid_utf8" {
                (TargetOutcome::Skipped, error)
            } else if error == "oversized" {
                (TargetOutcome::Skipped, error)
            } else if error.contains("deadline") || error.contains("cancel") {
                (TargetOutcome::Partial, error)
            } else {
                (TargetOutcome::Error, error)
            };
            exceptions.push(ExceptionalOutcome {
                path: path_label.clone(),
                outcome: outcome.clone(),
                reason: reason.clone(),
            });
            mark_candidate_exception(&mut ledger, &candidate, &path_label, outcome, &reason);
            continue;
        }
        let Some(signature) = scan.signature else {
            coverage_complete = false;
            let reason = "source identity unavailable";
            mark_candidate_exception(
                &mut ledger,
                &candidate,
                &path_label,
                TargetOutcome::Error,
                reason,
            );
            continue;
        };
        if scan.byte_count != signature.size {
            coverage_complete = false;
            let reason = format!(
                "source changed while streaming: scanned {} of {} bytes",
                scan.byte_count, signature.size
            );
            exceptions.push(ExceptionalOutcome {
                path: path_label.clone(),
                outcome: TargetOutcome::Partial,
                reason: reason.clone(),
            });
            mark_candidate_exception(
                &mut ledger,
                &candidate,
                &path_label,
                TargetOutcome::Partial,
                &reason,
            );
            continue;
        }

        let file_occurrences = scan.occurrences;
        for selector in &candidate.selectors {
            ledger[*selector].searched += 1;
            ledger[*selector].occurrences += file_occurrences;
        }
        if file_occurrences == 0 {
            continue;
        }

        // grep-searcher's streaming sink exposes only its rolling line buffer.
        // For a matched file, obtain one file-atomic snapshot and require its
        // SHA-256 to equal the bytes observed by the streaming reader before
        // parser enrichment or source authority can use it. Unmatched files
        // never take this allocation/fallback path.
        metrics.snapshot_reads.fetch_add(1, Ordering::Relaxed);
        if let Some(admission) = &request.directory_admission { admission.validate_source(&candidate.path)?; }
        let bytes = match read_matches_source(&candidate.path) {
            Ok(bytes) => bytes,
            Err(error) => {
                coverage_complete = false;
                let reason = format!("matched snapshot read: {error}");
                mark_candidate_exception(
                    &mut ledger,
                    &candidate,
                    &path_label,
                    TargetOutcome::Partial,
                    &reason,
                );
                exceptions.push(ExceptionalOutcome {
                    path: path_label.clone(),
                    outcome: TargetOutcome::Partial,
                    reason,
                });
                continue;
            }
        };
        let snapshot_digest = Sha256::digest(&bytes);
        let snapshot_digest = snapshot_digest.iter().fold(String::new(), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        });
        if signature.digest.as_deref() != Some(snapshot_digest.as_str()) {
            coverage_complete = false;
            let reason = "source changed between streaming scan and matched snapshot";
            mark_candidate_exception(
                &mut ledger,
                &candidate,
                &path_label,
                TargetOutcome::Partial,
                reason,
            );
            exceptions.push(ExceptionalOutcome {
                path: path_label.clone(),
                outcome: TargetOutcome::Partial,
                reason: reason.into(),
            });
            continue;
        }
        let content = match String::from_utf8(bytes) {
            Ok(content) => Arc::new(content),
            Err(_) => {
                coverage_complete = false;
                let reason = "invalid_utf8";
                mark_candidate_exception(
                    &mut ledger,
                    &candidate,
                    &path_label,
                    TargetOutcome::Skipped,
                    reason,
                );
                exceptions.push(ExceptionalOutcome {
                    path: path_label.clone(),
                    outcome: TargetOutcome::Skipped,
                    reason: reason.into(),
                });
                continue;
            }
        };
        let mtime = std::fs::metadata(&candidate.path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH);
        let parsed = cache.get_or_parse_source(&candidate.path, mtime, Arc::clone(&content));
        let toml = candidate.path.extension().and_then(|extension| extension.to_str())
            .filter(|extension| extension.eq_ignore_ascii_case("toml"))
            .and_then(|_| toml_context::TomlContext::parse(&content));
        let markdown = matches!(
            crate::lang::detect_file_type(&candidate.path),
            FileType::Markdown
        )
        .then(|| crate::read::outline::markdown::structure(&content))
        .flatten();
        let raw_path = scan
            .raw_path
            .as_ref()
            .ok_or_else(|| format!("match spool missing for {path_label}"))?;
        let raw_file = File::open(raw_path)
            .map_err(|error| format!("open match spool for {path_label}: {error}"))?;
        let mut pending: Option<MatchGroup> = None;
        for raw in BufReader::new(raw_file).lines() {
            let raw = raw.map_err(|error| format!("read match spool: {error}"))?;
            let line: RawMatchedLine = serde_json::from_str(&raw)
                .map_err(|error| format!("decode match spool: {error}"))?;
            let (owner, outline, mixed) =
                match line_context(parsed.as_deref(), markdown.as_ref(), toml.as_ref(), &line, &content) {
                    Ok((owner, outline)) => (owner, outline, false),
                    Err(_) => (None, Vec::new(), true),
                };
            let enriched = EnrichedLine {
                path: path_label.clone(),
                line: line.line,
                text: line.text,
                text_clipped: line.text_clipped,
                spans: line.spans,
                role: if is_test_file(&candidate.path) {
                    "test".into()
                } else {
                    "usage".into()
                },
                enrichment: if mixed {
                    super::scope::MIXED_SCOPES.into()
                } else if owner.is_some() {
                    "complete".into()
                } else {
                    "exact_line_fallback".into()
                },
                owner,
                outline,
            };
            if pending
                .as_ref()
                .is_some_and(|group| group_accepts(group, &enriched))
            {
                pending
                    .as_mut()
                    .expect("pending group exists")
                    .matches
                    .push(enriched);
            } else {
                if let Some(group) = pending.take() {
                    write_group_record(&mut writer, &group)?;
                    group_count += 1;
                }
                pending = Some(MatchGroup {
                    path: enriched.path.clone(),
                    owner: enriched.owner.clone(),
                    outline: enriched.outline.clone(),
                    matches: vec![enriched],
                });
            }
        }
        if let Some(group) = pending {
            write_group_record(&mut writer, &group)?;
            group_count += 1;
        }
        total_occurrences += file_occurrences;
        drop(content);
    }

    for row in &mut ledger {
        if matches!(
            row.outcome,
            TargetOutcome::Error | TargetOutcome::Skipped | TargetOutcome::Partial
        ) {
            continue;
        }
        row.outcome = if row.occurrences > 0 {
            TargetOutcome::Searched
        } else {
            TargetOutcome::Zero
        };
    }
    signatures.sort_by(|left, right| left.path.cmp(&right.path));
    writer
        .flush()
        .map_err(|error| format!("flush cursor dataset: {error}"))?;
    let filter_text = render_filter(&policies, &request.visibility);
    let filter_data = serde_json::to_value(&policies)
        .map_err(|error| format!("serialize filter policy: {error}"))?;
    diagnostics.push(format!(
        "matches execution: {} streamed files, {} matched snapshot reads, max {} in flight",
        metrics.streamed_files.load(Ordering::Relaxed),
        metrics.snapshot_reads.load(Ordering::Relaxed),
        metrics.max_in_flight.load(Ordering::Relaxed),
    ));
    Ok(ScanResult {
        request: retained_request,
        ledger,
        filter_text,
        filter_data,
        exceptions,
        dataset_path: path,
        group_count,
        total_occurrences,
        signatures,
        diagnostics,
        coverage_complete,
    })
}

fn mark_candidate_exception(
    ledger: &mut [TargetLedgerRow],
    candidate: &Candidate,
    path_label: &str,
    outcome: TargetOutcome,
    reason: &str,
) {
    for selector in &candidate.selectors {
        ledger[*selector].outcome = if ledger[*selector].explicit_file {
            outcome.clone()
        } else {
            TargetOutcome::Partial
        };
        let reasons = &mut ledger[*selector].reasons;
        // A venv traversal can skip tens of thousands of files; without this cap
        // the ledger row's joined reasons alone exceeded the response window.
        if reasons.len() < MAX_LEDGER_REASONS {
            reasons.push(format!("{path_label}: {reason}"));
        }
    }
}

fn plan_targets(
    resolved: &[String],
    requested: &[String],
    globs: &[String],
    visibility: Visibility,
    context: &OperationContext,
    admission: Option<&MatchesAdmission>,
) -> Result<
    (
        Vec<TargetLedgerRow>,
        Vec<Candidate>,
        Vec<EffectiveFilterPolicy>,
        Vec<String>,
        bool,
    ),
    String,
> {
    let mut ledger = Vec::with_capacity(requested.len());
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut by_canonical: HashMap<PathBuf, usize> = HashMap::new();
    let mut policies = Vec::new();
    let mut diagnostics = Vec::new();
    let mut complete = true;

    let mut admitted_walks = HashMap::new();
    if let Some(admission) = admission { admission.validate()?; }
    for (target_index, (raw, requested_raw)) in resolved.iter().zip(requested).enumerate() {
        let path = PathBuf::from(raw);
        let requested_path = Path::new(requested_raw);
        let display = if requested_path.is_absolute() {
            let relative = relative_path(requested_path, &context.root);
            if relative.is_empty() {
                ".".to_string()
            } else {
                relative
            }
        } else {
            requested_raw.trim_start_matches("./").replace('\\', "/")
        };
        let mut row = TargetLedgerRow {
            requested: display,
            canonical: None,
            candidates: 0,
            searched: 0,
            occurrences: 0,
            outcome: TargetOutcome::Zero,
            reasons: Vec::new(),
            explicit_file: false,
        };
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                row.outcome = TargetOutcome::Error;
                row.reasons
                    .push(format!("path not found or inaccessible: {error}"));
                complete = false;
                ledger.push(row);
                continue;
            }
        };
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("cannot resolve {raw}: {error}"))?;
        row.canonical = Some(canonical.to_string_lossy().into_owned());
        row.explicit_file = metadata.is_file();
        if metadata.is_file() {
            if admission.is_some_and(|admission| !admission.explicit_files.contains(&canonical)) {
                return Err("Matches target changed from its admitted kind or identity; restart the audit".into());
            }
            row.candidates = 1;
            insert_candidate(&mut candidates, &mut by_canonical, canonical, target_index);
        } else if metadata.is_dir() {
            let report = if let Some(admission) = admission {
                let index = *admission.directories.get(&canonical).ok_or("Matches directory lacks owning-project admission")?;
                let owner = &admission.owners[index];
                if !admitted_walks.contains_key(&index) {
                    // Project admission keeps the compiled corpus walk. A widened
                    // `all` admission uses the same admitted-root plain walk:
                    // configurable ignore files are off, while the owning-project
                    // boundary, symlink refusal and metadata-only contract stay.
                    let selection = WalkOptions {
                        policy_root: Some(owner.root.clone()), min_depth: 1,
                        deadline: context.deadline, cancelled: Some(context.cancelled.clone()),
                        candidate_cap: Some(100_000), ..Default::default()
                    };
                    let report = if admission.all_visibility {
                        crate::walk::walk(&owner.root, &WalkOptions { visibility: Visibility::All, ..selection })?
                    } else {
                        crate::walk::walk_corpus(&owner.root, &selection, &owner.policy)?
                    };
                    admitted_walks.insert(index, report);
                }
                let report = &admitted_walks[&index];
                let (includes, excludes) = crate::walk::compile_patterns(globs)?;
                let mut entries = report.entries.iter().filter_map(|entry| {
                    let absolute = owner.root.join(&entry.path);
                    let relative = absolute.strip_prefix(&canonical).ok()?;
                    if relative.as_os_str().is_empty() || !crate::walk::matches_patterns(relative, includes.as_ref(), excludes.as_ref())
                        || relative.ancestors().skip(1).filter(|parent| !parent.as_os_str().is_empty())
                            .any(|parent| !crate::walk::matches_patterns(parent, None, excludes.as_ref())) { return None; }
                    Some(crate::walk::WalkEntry { path: relative.into(), kind: entry.kind, size: entry.size,
                        modified_ns: entry.modified_ns, token_estimate: entry.token_estimate })
                }).take(10_001).collect::<Vec<_>>();
                let capped = entries.len() > 10_000;
                entries.truncate(10_000);
                crate::walk::WalkResult { entries, diagnostics: report.diagnostics.clone(), complete: report.complete && !capped,
                    reason: if capped { Some(crate::walk::StopReason::CandidateCap) } else { report.reason },
                    visited: report.visited, policy: report.policy.clone() }
            } else { crate::walk::walk(
                &canonical,
                &WalkOptions {
                    visibility,
                    policy_root: None,
                    min_depth: 1,
                    max_depth: None,
                    patterns: globs.to_vec(),
                    deadline: context.deadline,
                    cancelled: Some(context.cancelled.clone()),
                    candidate_cap: Some(10_000), // bound runaway dir walks (index backups, node_modules); Partial propagates via report.complete
                },
            )? };
            row.candidates = report
                .entries
                .iter()
                .filter(|entry| entry.kind == EntryKind::File)
                .count();
            policies.push(report.policy.clone());
            diagnostics.extend(report.diagnostics);
            if !report.complete {
                row.outcome = TargetOutcome::Partial;
                row.reasons
                    .push(format!("target traversal incomplete: {:?}", report.reason));
                complete = false;
            }
            for entry in report
                .entries
                .into_iter()
                .filter(|entry| entry.kind == EntryKind::File)
            {
                let candidate = canonical
                    .join(entry.path)
                    .canonicalize()
                    .map_err(|error| error.to_string())?;
                insert_candidate(&mut candidates, &mut by_canonical, candidate, target_index);
            }
        } else {
            row.outcome = TargetOutcome::Skipped;
            row.reasons
                .push("target is not a regular file or directory".into());
            complete = false;
        }
        ledger.push(row);
    }
    if let Some(admission) = admission { admission.validate()?; }
    Ok((ledger, candidates, policies, diagnostics, complete))
}

fn insert_candidate(
    candidates: &mut Vec<Candidate>,
    by_canonical: &mut HashMap<PathBuf, usize>,
    path: PathBuf,
    selector: usize,
) {
    if let Some(index) = by_canonical.get(&path).copied() {
        if !candidates[index].selectors.contains(&selector) {
            candidates[index].selectors.push(selector);
        }
        return;
    }
    let index = candidates.len();
    by_canonical.insert(path.clone(), index);
    candidates.push(Candidate {
        path,
        selectors: vec![selector],
    });
}

fn line_context(
    parsed: Option<&crate::cache::ParsedFile>,
    markdown: Option<&crate::read::outline::markdown::MarkdownStructure>,
    toml: Option<&toml_context::TomlContext>,
    row: &RawMatchedLine,
    content: &str,
) -> Result<(Option<OwnerRegion>, Vec<OutlineItem>), super::scope::MixedScopes> {
    let line = row.line;
    let (owner, mut outline) = if let Some(parsed) = parsed {
        let owner =
            super::scope::enclosing_definition_in_source(parsed, line)?.map(|owner| OwnerRegion {
                kind: owner.kind.into(),
                name: owner.name,
                start: owner.start,
                end: owner.end,
            });
        let outline = super::scope::enclosing_containers_in_tree(
            &parsed.tree,
            content,
            parsed.lang,
            line,
            None,
        )
        .into_iter()
        .map(|scope| OutlineItem {
            kind: scope.kind.into(),
            name: scope.name,
            start: scope.start,
            end: scope.end,
            selected: false,
        })
        .collect::<Vec<_>>();
        (owner, outline)
    } else if let Some(tree) = markdown {
        let outline = markdown_hierarchy(tree, content, line);
        let owner = outline.last().map(|item| OwnerRegion {
            kind: item.kind.clone(),
            name: item.name.clone(),
            start: item.start,
            end: item.end,
        });
        (owner, outline)
    } else if let Some(owner) = toml.and_then(|context| context.owner(row, content)) {
        (Some(owner), Vec::new())
    } else {
        (None, Vec::new())
    };
    if let Some(owner) = &owner {
        // Top-level values also have owners, although they are not callable/type containers.
        if !outline
            .iter()
            .any(|item| item.start == owner.start && item.end == owner.end)
        {
            outline.push(OutlineItem {
                kind: owner.kind.clone(),
                name: owner.name.clone(),
                start: owner.start,
                end: owner.end,
                selected: false,
            });
        }
    }
    if let Some(item) = outline.last_mut() {
        item.selected = true;
    }
    Ok((owner, outline))
}

fn markdown_hierarchy(
    structure: &crate::read::outline::markdown::MarkdownStructure,
    content: &str,
    line: u32,
) -> Vec<OutlineItem> {
    // The grammar's `section` ancestry handles ATX headings, not Setext.
    // Reuse the existing heading-level/range model instead of that ancestry.
    structure
        .sections
        .iter()
        .filter(|section| section.heading_start_line <= line && line <= section.subtree_end_line)
        .map(|section| {
            let name = if section.title.is_empty()
                && section.heading_end_line > section.heading_start_line
            {
                // Setext content is a paragraph child, not a direct inline child.
                // Recover its title from the parser-owned range without changing
                // the protected read selector/outline behavior.
                content[section.heading_start_byte..section.heading_end_byte]
                    .lines()
                    .take((section.heading_end_line - section.heading_start_line) as usize)
                    .collect::<Vec<_>>()
                    .join(" ")
                    .trim()
                    .to_string()
            } else {
                section.title.clone()
            };
            OutlineItem {
                kind: "section".into(),
                name,
                start: section.heading_start_line,
                end: section.subtree_end_line,
                selected: false,
            }
        })
        .collect()
}

fn group_accepts(group: &MatchGroup, line: &EnrichedLine) -> bool {
    let same_owner = group.owner.as_ref().map(|owner| (owner.start, owner.end))
        == line.owner.as_ref().map(|owner| (owner.start, owner.end));
    let nearby_plain = group.owner.is_some()
        || group
            .matches
            .last()
            .is_some_and(|previous| line.line <= previous.line.saturating_add(5));
    group.path == line.path && same_owner && nearby_plain && group.matches.len() < 20
}

fn write_group_record(writer: &mut BufWriter<File>, group: &MatchGroup) -> Result<(), String> {
    let mut record =
        serde_json::to_vec(group).map_err(|error| format!("write cursor dataset: {error}"))?;
    if record.len() > MAX_GROUP_RECORD_BYTES
        && group.owner.as_ref().is_some_and(|owner| owner.kind == "TOML key")
    {
        // Optional context must not turn an otherwise deliverable audit into an error.
        let mut plain = group.clone();
        plain.owner = None;
        plain.outline.clear();
        for row in &mut plain.matches {
            row.owner = None;
            row.outline.clear();
            row.enrichment = "exact_line_fallback".into();
        }
        record = serde_json::to_vec(&plain)
            .map_err(|error| format!("write cursor dataset: {error}"))?;
    }
    if record.len() > MAX_GROUP_RECORD_BYTES {
        return Err(format!(
            "match group exceeded the {MAX_GROUP_RECORD_BYTES}-byte response safety limit; narrow the search target"
        ));
    }
    writer
        .write_all(&record)
        .and_then(|_| writer.write_all(b"\n"))
        .map_err(|error| format!("write cursor dataset: {error}"))
}

/// One rendered group: text block plus per-page counters. Built at a chosen
/// context tier so the page assembler can measure before committing.
#[derive(Default)]
struct GroupBlock {
    text: String,
    clipped: usize,
    rows: Vec<SourceRow>,
}

fn render_group_block(
    group: &MatchGroup,
    source: &str,
    tier: u8,
    page_matches: &BTreeSet<(String, u32)>,
    displayed: &mut BTreeSet<(String, u32)>,
) -> GroupBlock {
    let mut text = String::new();
    let mut clipped = 0usize;
    let mut rows = Vec::new();
    let (start, end, label) = group.owner.as_ref().map_or_else(
        || {
            let start = group.matches.first().map_or(1, |row| row.line);
            let end = group.matches.last().map_or(start, |row| row.line);
            (start, end, "exact lines".to_string())
        },
        |owner| {
            (
                owner.start,
                owner.end,
                format!("{} {}", owner.kind, owner.name),
            )
        },
    );
    let range = if start == end {
        start.to_string()
    } else {
        format!("{start}-{end}")
    };
    let occurrences = group
        .matches
        .iter()
        .map(|row| row.spans.len())
        .sum::<usize>();
    if group.outline.is_empty() {
        let _ = writeln!(
            text,
            "### {}:{range} [{label} · {occurrences} matches]",
            group.path
        );
    } else {
        let _ = writeln!(text, "### {} · {occurrences} matches", group.path);
    }
    for row in &group.matches {
        if row.enrichment == super::scope::MIXED_SCOPES {
            let _ = writeln!(
                text,
                "Context at line {}: {}",
                row.line,
                super::scope::MIXED_SCOPES
            );
        }
    }
    for (depth, item) in group.outline.iter().enumerate() {
        let range = if item.start == item.end {
            item.start.to_string()
        } else {
            format!("{}-{}", item.start, item.end)
        };
        let _ = writeln!(
            text,
            "{}[{range}]: {} {}",
            "  ".repeat(depth),
            item.kind,
            item.name
        );
    }
    text.push('\n');
    let source_lines: Vec<&str> = source.lines().collect();
    let enclosure_lines = matches!(
        crate::lang::detect_file_type(Path::new(&group.path)),
        FileType::Code(_) | FileType::StructuredData
    );
    // A top-level value's declaration range is not an enclosing scope: its
    // neighboring bindings can supply useful context. Callable/type/document
    // scopes, however, must not borrow rows from an unrelated sibling.
    let context_owner = group.owner.as_ref().filter(|owner| {
        matches!(
            owner.kind.as_str(),
            "function"
                | "method"
                | "class"
                | "struct"
                | "interface"
                | "trait"
                | "type"
                | "enum"
                | "module"
                | "object"
                | "impl"
                | "section"
        )
    });
    // Context counts useful source rows, not blank padding or delimiter-only code.
    // Preselect once per block rather than walking long blank runs for every hit.
    let context_lines: Vec<u32> = if tier == 0 {
        Vec::new()
    } else {
        source_lines
            .iter()
            .zip(1_u32..)
            .filter(|(_, line)| {
                context_owner.is_none_or(|owner| *line >= owner.start && *line <= owner.end)
            })
            .filter(|(line, _)| {
                let text = line.trim();
                // Keep empty values such as [] and {}; only one-sided enclosure
                // rows can be skipped without interpreting the expression.
                let opening_only = text
                    .chars()
                    .all(|ch| ch.is_whitespace() || matches!(ch, '{' | '(' | '['));
                let closing_only = text
                    .chars()
                    .all(|ch| ch.is_whitespace() || matches!(ch, '}' | ')' | ']' | ';' | ','));
                !text.is_empty() && (!enclosure_lines || !(opening_only || closing_only))
            })
            .map(|(_, line)| line)
            .collect()
    };
    let mut lines_to_show = BTreeSet::new();
    for row in &group.matches {
        // A matching row is never suppressed, even when it is blank or all delimiters.
        lines_to_show.insert(row.line);
        let before = context_lines.partition_point(|line| *line < row.line);
        let after = context_lines.partition_point(|line| *line <= row.line);
        lines_to_show.extend(
            context_lines[before.saturating_sub(usize::from(tier))..before]
                .iter()
                .copied(),
        );
        lines_to_show.extend(
            context_lines[after..(after + usize::from(tier)).min(context_lines.len())]
                .iter()
                .copied(),
        );
    }
    let matched_lines: BTreeSet<u32> = group.matches.iter().map(|row| row.line).collect();
    for line in lines_to_show {
        let identity = (group.path.clone(), line);
        // A match is delivered in its own group, never first as another group's
        // optional context. Reuse context only within this page, not this session.
        if !matched_lines.contains(&line)
            && (page_matches.contains(&identity) || displayed.contains(&identity))
        {
            continue;
        }
        let Some(source_value) = source_lines.get(line.saturating_sub(1) as usize) else {
            continue;
        };
        let matched = group.matches.iter().find(|row| row.line == line);
        let (display_value, line_clipped) = matched.map_or_else(
            || bounded_line(source_value, &[]),
            |row| (row.text.clone(), row.text_clipped),
        );
        let separator = if matched_lines.contains(&line) {
            ':'
        } else {
            '-'
        };
        let _ = writeln!(text, "{line}{separator} {display_value}");
        displayed.insert(identity);
        if line_clipped {
            clipped += 1;
        } else {
            rows.push(SourceRow {
                path: group.path.clone(),
                line,
                text: (*source_value).to_string(),
                visibility: "visible_complete",
                transformation: "verbatim",
            });
        }
    }
    text.push('\n');
    GroupBlock {
        text,
        clipped,
        rows,
    }
}

fn count_tiers(tiers: &[u8]) -> [usize; 3] {
    let mut counts = [0usize; 3];
    for tier in tiers {
        counts[(*tier as usize).min(2)] += 1;
    }
    counts
}

/// Everything a page prints outside its match blocks, rendered by the same
/// formatter that produces the delivered text: `head` precedes the blocks and
/// `tail` follows them. The fit budget measures this exact output, so a page's
/// visible target ledger and its block allowance can never disagree.
fn render_page_metadata(
    scan: &ScanResult,
    continuation: bool,
    auto_tiers: bool,
    default_tier: u8,
    tier_counts: [usize; 3],
    clipped_source_lines: usize,
    page_match_lines: usize,
    cursor_receipt: Option<&str>,
) -> (String, String) {
    let mut head = String::new();
    let _ = writeln!(head, "# Search: {:?}", scan.request.pattern);
    let syntax_label = if scan.request.requested_syntax == "auto" {
        format!("auto→{}", scan.request.syntax)
    } else {
        scan.request.syntax.clone()
    };
    let context_label = if auto_tiers {
        format!(
            "context=auto · default C{default_tier} · windows C2×{} · C1×{} · C0×{}",
            tier_counts[2], tier_counts[1], tier_counts[0]
        )
    } else {
        format!("contextLines={default_tier}")
    };
    let _ = writeln!(
        head,
        "Resolved: {syntax_label} · output=matches · case={}→{} · {context_label}",
        scan.request.case_mode, scan.request.effective_case
    );
    let _ = writeln!(head, "Filter: {}", scan.filter_text);
    if continuation {
        let _ = writeln!(
            head,
            "Continuation: next unseen match rows · {context_label}"
        );
    }
    head.push('\n');

    let mut tail = String::new();
    if clipped_source_lines > 0 {
        let _ = writeln!(
            tail,
            "Presentation: {clipped_source_lines} oversized source lines clipped; exact spans are preserved, and clipped rows have no source authority."
        );
    }
    if scan.group_count == 0 {
        let searched: usize = scan.ledger.iter().map(|row| row.searched).sum();
        let _ = writeln!(tail, "0 matches in {searched} searched files");
    }
    render_exceptions(&mut tail, &scan.exceptions);
    for target in &scan.ledger {
        if scan.ledger.len() > 1
            || (target.outcome != TargetOutcome::Searched && target.outcome != TargetOutcome::Zero)
        {
            let reason = if target.reasons.is_empty() {
                String::new()
            } else {
                format!(" · {}", target.reasons.join("; "))
            };
            let explicit = if target.explicit_file {
                " · explicit ignore bypass"
            } else {
                ""
            };
            let _ = writeln!(
                tail,
                "Target: {} · {:?} · {} occurrences{}{}",
                target.requested, target.outcome, target.occurrences, explicit, reason,
            );
        }
    }
    let coverage = if scan.coverage_complete {
        "complete"
    } else {
        "partial"
    };
    let _ = writeln!(
        tail,
        "Coverage: {coverage} · {} occurrences · {page_match_lines} match lines on this page",
        scan.total_occurrences
    );
    if let Some(receipt) = cursor_receipt {
        let _ = writeln!(tail, "{MORE_CURSOR_PREFIX}{receipt}");
    }
    (head, tail)
}

/// Bytes the match blocks may occupy for one candidate page shape: the hard
/// ceiling minus the metadata that shape prints. The successor line is reserved
/// at its real length, and the caller keeps blocks only while they fit here.
fn page_block_budget(
    scan: &ScanResult,
    continuation: bool,
    auto_tiers: bool,
    default_tier: u8,
    tier_counts: [usize; 3],
    clipped_source_lines: usize,
    page_match_lines: usize,
    more: bool,
    hard_bytes: usize,
) -> usize {
    let receipt = more.then(|| format!("{CURSOR_ID_PREFIX}{}", "0".repeat(CURSOR_ID_HEX_CHARS)));
    let (head, tail) = render_page_metadata(
        scan,
        continuation,
        auto_tiers,
        default_tier,
        tier_counts,
        clipped_source_lines,
        page_match_lines,
        receipt.as_deref(),
    );
    hard_bytes.saturating_sub(head.len() + tail.len())
}

fn render_page(
    scan: ScanResult,
    start_offset: u64,
    start_group: usize,
    start_match: usize,
    context_request: Option<u8>,
    session: &Session,
    context: &OperationContext,
    continuation: bool,
    retain_render: bool,
    hard_bytes: usize,
) -> Result<ToolOutput, String> {
    validate_directory_membership(&scan.request, context)?;
    // A retained origin owns the source of this render: store the page-start
    // origin first, read the canonical stored state back, and render from it.
    // Deduplication may have dropped the incoming dataset in favour of an
    // identical retained one, so the incoming path is never rendered directly,
    // and an unavailable origin fails closed instead of falling back to a file
    // the cursor store no longer owns.
    let (scan, start_offset, start_group, start_match, context_request, continuation, origin) =
        if retain_render {
            let id = session.put_cursor(
                serde_json::to_value(MatchCursorState {
                    version: 4,
                    request: scan.request.clone(),
                    root: context.root.to_string_lossy().into_owned(),
                    next_offset: start_offset,
                    next_group: start_group,
                    next_match: start_match,
                    context_explicit: context_request,
                    signatures: scan.signatures.clone(),
                    ledger: scan.ledger.clone(),
                    filter_text: scan.filter_text.clone(),
                    filter_data: scan.filter_data.clone(),
                    exceptions: scan.exceptions.clone(),
                    diagnostics: scan.diagnostics.clone(),
                    coverage_complete: scan.coverage_complete,
                    dataset_path: scan.dataset_path.to_string_lossy().into_owned(),
                    group_count: scan.group_count,
                    total_occurrences: scan.total_occurrences,
                    retained_render: true,
                    first_page: !continuation,
                })
                .expect("origin serializes"),
            );
            let value = session.get_cursor(&id).ok_or_else(|| {
                "retained render origin is unavailable or expired; reissue the original audit"
                    .to_string()
            })?;
            let state: MatchCursorState = serde_json::from_value(value)
                .map_err(|error| format!("retained render origin is invalid: {error}"))?;
            if !state.retained_render {
                return Err("retained render origin is not a Matches page origin".into());
            }
            let canonical = ScanResult {
                dataset_path: PathBuf::from(&state.dataset_path),
                request: state.request,
                ledger: state.ledger,
                filter_text: state.filter_text,
                filter_data: state.filter_data,
                exceptions: state.exceptions,
                group_count: state.group_count,
                total_occurrences: state.total_occurrences,
                signatures: state.signatures,
                diagnostics: state.diagnostics,
                coverage_complete: state.coverage_complete,
            };
            (
                canonical,
                state.next_offset,
                state.next_group,
                state.next_match,
                state.context_explicit,
                !state.first_page,
                Some(id),
            )
        } else {
            (
                scan,
                start_offset,
                start_group,
                start_match,
                context_request,
                continuation,
                None,
            )
        };
    let (mut selected, read_next_offset, read_more) =
        read_dataset_page(&scan.dataset_path, start_offset)?;
    if start_group + selected.len() > scan.group_count {
        return Err("cursor points past the result set".into());
    }
    if start_match > 0 {
        let (_, group) = selected
            .first_mut()
            .ok_or("cursor has no remaining match group")?;
        if start_match >= group.matches.len() {
            return Err("cursor points past the match group".into());
        }
        group.matches.drain(..start_match);
    }

    // Load and verify all page sources once: digest mismatch between scan and
    // render is an error, never silently stale bytes.
    let mut sources: Vec<(PathBuf, Arc<String>)> = Vec::with_capacity(selected.len());
    let mut page_sources: HashMap<PathBuf, Arc<String>> = HashMap::new();
    for (_, group) in &selected {
        let absolute = context
            .root
            .join(&group.path)
            .canonicalize()
            .map_err(|error| format!("cursor source unavailable for {}: {error}", group.path))?;
        if let Some(admission) = &scan.request.directory_admission { admission.validate_source(&absolute)?; }
        if let Some(source) = page_sources.get(&absolute) {
            sources.push((absolute, Arc::clone(source)));
        } else {
            let source = Arc::new(load_verified_source(
                &absolute,
                &scan.signatures,
                continuation,
            )?);
            page_sources.insert(absolute.clone(), Arc::clone(&source));
            sources.push((absolute, source));
        }
    }

    // Context tiers (user law 2026-09-01): explicit `contextLines` stays
    // uniform — explicit intent beats automation. Auto measures the visible
    // C0 footprint (<1,000 tokens → C2 · 1,000–2,000 → C1 · >2,000 → C0,
    // at bytes/4); serialized dataset overhead must not influence presentation.
    // It then demotes PER WINDOW from the end toward the soft target — never a
    // global all-to-C1-then-C0 step.
    let page_matches = selected
        .iter()
        .flat_map(|(_, group)| {
            group
                .matches
                .iter()
                .map(|row| (group.path.clone(), row.line))
        })
        .collect::<BTreeSet<_>>();
    let render_at = |tiers: &[u8]| {
        let mut displayed = BTreeSet::new();
        selected
            .iter()
            .enumerate()
            .map(|(index, (_, group))| {
                render_group_block(
                    group,
                    &sources[index].1,
                    tiers[index],
                    &page_matches,
                    &mut displayed,
                )
            })
            .collect::<Vec<_>>()
    };
    let (default_tier, auto_tiers, mut blocks) = if let Some(explicit) = context_request {
        (explicit, false, render_at(&vec![explicit; selected.len()]))
    } else {
        let c0_blocks = render_at(&vec![0; selected.len()]);
        let c0_rendered: usize = c0_blocks.iter().map(|block| block.text.len()).sum();
        let tier = match c0_rendered {
            0..4_000 => 2,
            4_000..8_000 => 1,
            _ => 0,
        };
        let blocks = if tier == 0 {
            c0_blocks
        } else {
            render_at(&vec![tier; selected.len()])
        };
        (tier, true, blocks)
    };
    let mut tiers: Vec<u8> = vec![default_tier; selected.len()];
    if auto_tiers {
        // Visible metadata is not optional context, so the demotion target is the
        // real page budget of the currently rendered blocks: the clipping notice,
        // the current tier counts, the full selected line count and the actual
        // read_more flag all move it, and it is recomputed after every demotion.
        // A target that omitted them could stop one context row short and leave
        // the fit loop refusing a single-row group it could have delivered.
        let page_lines: usize = selected
            .iter()
            .map(|(_, group)| group.matches.len())
            .sum();
        let target = |tiers: &[u8], blocks: &[GroupBlock]| {
            SOFT_RENDERED_BYTES.min(page_block_budget(
                &scan,
                continuation,
                auto_tiers,
                default_tier,
                count_tiers(tiers),
                blocks.iter().map(|block| block.clipped).sum(),
                page_lines,
                read_more,
                hard_bytes,
            ))
        };
        let mut projected: usize = blocks.iter().map(|block| block.text.len()).sum();
        for index in (0..selected.len()).rev() {
            if projected <= target(&tiers, &blocks) {
                break;
            }
            while tiers[index] > 0 && projected > target(&tiers, &blocks) {
                tiers[index] -= 1;
                // A demotion can free context previously reused by a later
                // group. Fit the composed page, not independently duplicated blocks.
                blocks = render_at(&tiers);
                projected = blocks.iter().map(|block| block.text.len()).sum();
            }
        }
    }

    // Pages fill to the hard ceiling minus the metadata this page will print.
    // The budget is rendered from the same formatter as the delivered text, so
    // a visible target ledger or exception list is never over-committed.
    let mut kept = 0usize;
    let mut used = 0usize;
    let mut next_match = 0usize;
    for index in 0..selected.len() {
        let block_len = blocks[index].text.len();
        let candidate_kept = index + 1;
        let candidate_lines: usize = selected[..candidate_kept]
            .iter()
            .map(|(_, group)| group.matches.len())
            .sum();
        let candidate_clipped: usize = blocks[..candidate_kept]
            .iter()
            .map(|block| block.clipped)
            .sum();
        let budget = page_block_budget(
            &scan,
            continuation,
            auto_tiers,
            default_tier,
            count_tiers(&tiers[..candidate_kept]),
            candidate_clipped,
            candidate_lines,
            candidate_kept < selected.len() || read_more,
            hard_bytes,
        );
        if used + block_len > budget {
            if kept > 0 {
                break;
            }
            // A group is a presentation choice, not indivisible evidence.
            // Split only between occurrence rows, retaining every span and
            // the same owner/context tier on the continuation page.
            let mut fitting = None;
            {
                let group = &mut selected[index].1;
                for count in (1..group.matches.len()).rev() {
                    group.matches.truncate(count);
                    let fragment = render_group_block(
                        group,
                        &sources[index].1,
                        tiers[index],
                        &page_matches,
                        &mut BTreeSet::new(),
                    );
                    let fragment_budget = page_block_budget(
                        &scan,
                        continuation,
                        auto_tiers,
                        default_tier,
                        count_tiers(&tiers[..1]),
                        fragment.clipped,
                        count,
                        true,
                        hard_bytes,
                    );
                    if fragment.text.len() <= fragment_budget {
                        fitting = Some((fragment, count));
                        break;
                    }
                }
            }
            let (fragment, count) = fitting.ok_or_else(|| format!(
                "exact match at {}:{} with its hierarchy/requested context and the visible target ledger cannot fit the hard page limit; audit incomplete, no page delivered. Narrow the requested context or the target batch",
                selected[index].1.path, selected[index].1.matches.first().map_or(1, |row| row.line)
            ))?;
            next_match = start_match + count;
            blocks[index] = fragment;
            kept = 1;
            break;
        }
        used += block_len;
        kept = candidate_kept;
    }
    let next_offset = if next_match > 0 {
        selected[0].0
    } else if kept < selected.len() {
        selected[kept].0
    } else {
        read_next_offset
    };
    let more = next_match > 0 || kept < selected.len() || read_more;
    let next_group = start_group + if next_match > 0 { 0 } else { kept };
    let tier_counts = count_tiers(&tiers[..kept]);

    // The successor continues from the same canonical dataset the page was
    // rendered from; a retained origin already owns that source above.
    let successor = more.then(|| {

        session.put_cursor(
            serde_json::to_value(MatchCursorState {
                version: 4,
                request: scan.request.clone(),
                root: context.root.to_string_lossy().into_owned(),
                next_offset,
                next_group,
                next_match,
                context_explicit: context_request,
                signatures: scan.signatures.clone(),
                ledger: scan.ledger.clone(),
                filter_text: scan.filter_text.clone(),
                filter_data: scan.filter_data.clone(),
                exceptions: scan.exceptions.clone(),
                diagnostics: scan.diagnostics.clone(),
                coverage_complete: scan.coverage_complete,
                dataset_path: scan.dataset_path.to_string_lossy().into_owned(),
                group_count: scan.group_count,
                total_occurrences: scan.total_occurrences,
                retained_render: false,
                first_page: false,
            })
            .expect("cursor serializes"),
        )
    });

    let cursor_receipt = successor.as_deref();
    let page_match_lines: usize = selected[..kept]
        .iter()
        .map(|(_, group)| group.matches.len())
        .sum();
    let clipped_source_lines: usize = blocks[..kept]
        .iter()
        .map(|block| block.clipped)
        .sum();
    let (mut text, tail) = render_page_metadata(
        &scan,
        continuation,
        auto_tiers,
        default_tier,
        tier_counts,
        clipped_source_lines,
        page_match_lines,
        cursor_receipt,
    );

    let mut source_rows = Vec::new();
    let mut page_occurrences = 0usize;
    for index in 0..kept {
        let (_, group) = &selected[index];
        page_occurrences += group
            .matches
            .iter()
            .map(|row| row.spans.len())
            .sum::<usize>();
        let block = std::mem::take(&mut blocks[index]);
        text.push_str(&block.text);
        source_rows.extend(block.rows);
    }
    text.push_str(&tail);

    if text.len() > hard_bytes {
        return Err("exact-search page metadata exceeds the hard limit; audit incomplete, no page delivered. Narrow the pattern or target batch".into());
    }

    validate_directory_membership(&scan.request, context)?;
    let groups_data: Vec<Value> = selected[..kept]
        .iter()
        .map(|(_, group)| serde_json::to_value(group).unwrap_or(Value::Null))
        .collect();
    let target_data = scan.ledger.clone();
    let data = json!({
        "mode": "matches",
        "resolved": {
            "pattern": scan.request.pattern,
            "syntax": scan.request.syntax,
            "case": scan.request.case_mode,
            "effectiveCase": scan.request.effective_case,
            "contextLines": context_request,
            "contextMode": if auto_tiers { "auto" } else { "explicit" },
            "contextDefaultTier": default_tier,
            "contextWindows": { "c2": tier_counts[2], "c1": tier_counts[1], "c0": tier_counts[0] },
        },
        "filter": scan.filter_data,
        "targets": target_data,
        "exceptions": scan.exceptions.iter().take(MAX_STRUCTURED_EXCEPTIONS).cloned().collect::<Vec<_>>(),
        "groups": groups_data,
        "sourceRows": source_rows,
        "coverage": {
            "complete": scan.coverage_complete,
            "occurrences": scan.total_occurrences,
            "groups": scan.group_count,
            "returnedGroups": kept,
            "pageStartGroup": start_group,
            "pageStartMatch": start_match,
            "nextMatch": next_match,
            "more": more,
            "clippedSourceLines": clipped_source_lines,
            "omittedExceptions": scan.exceptions.len().saturating_sub(MAX_STRUCTURED_EXCEPTIONS),
        },
        "cursor": successor,
        "executionDiagnostics": scan.diagnostics,
    });
    // Only files represented on this page need to cross the private proof boundary.
    // Reuse the verified identities; do not resolve potentially changed symlinks again.
    let visible_paths: BTreeSet<_> = sources[..kept]
        .iter()
        .map(|(path, _)| path.clone())
        .collect();
    let mut snapshots = Vec::new();
    for (path, source) in page_sources {
        if visible_paths.contains(&path) {
            crate::source_proof::push_search_snapshot(&mut snapshots, &path, &source);
        }
    }
    let mut output = if scan.coverage_complete {
        ToolOutput::complete(
            "pi_nav_search",
            text,
            data,
            page_occurrences,
            scan.total_occurrences,
        )
    } else {
        ToolOutput::incomplete(
            "pi_nav_search",
            text,
            data,
            page_occurrences,
            IncompleteReason::Error,
            scan.diagnostics,
        )
    };
    // A retained origin references this dataset, and the cursor store owns the
    // dataset's lifetime from here: never delete a dataset an origin can replay.
    if !more && successor.is_none() && !continuation && origin.is_none() {
        let _ = std::fs::remove_file(&scan.dataset_path);
    }
    output.matches_render_cursor = origin;
    Ok(output.with_source_snapshots(snapshots))
}

fn read_dataset_page(
    path: &Path,
    start_offset: u64,
) -> Result<(Vec<(u64, MatchGroup)>, u64, bool), String> {
    let file = File::open(path).map_err(|error| {
        format!("cursor dataset is unavailable or expired; restart the search: {error}")
    })?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if start_offset > length {
        return Err("cursor dataset offset is invalid; restart the search".into());
    }
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(start_offset))
        .map_err(|error| error.to_string())?;
    let mut selected: Vec<(u64, MatchGroup)> = Vec::new();
    let mut estimated = 0usize;
    loop {
        let line_start = reader
            .stream_position()
            .map_err(|error| error.to_string())?;
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        if !selected.is_empty() && estimated + read > PAGE_TARGET_BYTES {
            reader
                .seek(SeekFrom::Start(line_start))
                .map_err(|error| error.to_string())?;
            break;
        }
        let group = serde_json::from_str::<MatchGroup>(line.trim_end())
            .map_err(|error| format!("cursor dataset is corrupt: {error}"))?;
        estimated += read;
        selected.push((line_start, group));
    }
    let next = reader
        .stream_position()
        .map_err(|error| error.to_string())?;
    Ok((selected, next, next < length))
}

fn load_verified_source(
    path: &Path,
    signatures: &[SourceSignature],
    continuation: bool,
) -> Result<String, String> {
    let expected = signatures
        .iter()
        .find(|signature| Path::new(&signature.path) == path)
        .and_then(|signature| signature.digest.as_deref())
        .ok_or_else(|| format!("source identity unavailable for {}", path.display()))?;
    let bytes = read_matches_source(path).map_err(|error| format!("read page source: {error}"))?;
    let digest = Sha256::digest(&bytes);
    let digest = digest.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    });
    if digest != expected {
        return Err(if continuation {
            "cursor stale: relevant source identity changed; restart the search".into()
        } else {
            "source changed between scan and page rendering; retry the search".into()
        });
    }
    String::from_utf8(bytes).map_err(|_| "verified page source became invalid_utf8".into())
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn render_exceptions(text: &mut String, exceptions: &[ExceptionalOutcome]) {
    if exceptions.is_empty() {
        return;
    }
    for exception in exceptions.iter().take(MAX_RENDERED_EXCEPTIONS) {
        let _ = writeln!(
            text,
            "Exceptional: {} · {:?} · {}",
            exception.path, exception.outcome, exception.reason,
        );
    }
    let omitted = exceptions.len().saturating_sub(MAX_RENDERED_EXCEPTIONS);
    if omitted > 0 {
        let _ = writeln!(
            text,
            "… {omitted} more skipped/unreadable file outcomes omitted; match totals are unaffected."
        );
    }
}

fn bounded_line(value: &str, spans: &[MatchSpan]) -> (String, bool) {
    if value.len() <= MAX_RENDERED_LINE_BYTES {
        return (value.to_string(), false);
    }
    let anchor = spans
        .first()
        .map_or(0, |span| span.start_byte.min(value.len()));
    let mut start = anchor.saturating_sub(MAX_RENDERED_LINE_BYTES / 2);
    let mut end = (start + MAX_RENDERED_LINE_BYTES).min(value.len());
    if end - start < MAX_RENDERED_LINE_BYTES {
        start = end.saturating_sub(MAX_RENDERED_LINE_BYTES);
    }
    while start < end && !value.is_char_boundary(start) {
        start += 1;
    }
    while end > start && !value.is_char_boundary(end) {
        end -= 1;
    }
    let prefix = if start > 0 {
        format!("…[{} bytes omitted] ", start)
    } else {
        String::new()
    };
    let suffix = if end < value.len() {
        format!(" …[{} bytes omitted]", value.len() - end)
    } else {
        String::new()
    };
    (format!("{prefix}{}{suffix}", &value[start..end]), true)
}

fn render_filter(policies: &[EffectiveFilterPolicy], visibility: &str) -> String {
    if visibility == "all" {
        return "all · configurable ignore files disabled · safety exclusions remain".into();
    }
    if policies.iter().any(|policy| policy.custom_override) {
        let excluded: usize = policies.iter().map(|policy| policy.excluded).sum();
        return format!(
            "project · .pi/navigation/ignore layered · gitignore respected · {excluded} excluded"
        );
    }
    if policies.iter().any(|policy| policy.source == "gitignore") {
        let excluded: usize = policies.iter().map(|policy| policy.excluded).sum();
        return format!("project · .gitignore active · {excluded} excluded");
    }
    "project · exact files bypass ignore selection or no project ignore file".into()
}

fn relative_path(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn system_time_ns(time: SystemTime) -> Option<u128> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::{NativeSession, ReadFormat};

    fn context(root: &Path) -> (NativeSession, OperationContext) {
        let session = NativeSession::new(root, false).unwrap();
        let context = OperationContext::for_session(&session, ReadFormat::Plain, true);
        (session, context)
    }

    fn matches_owner(root: &Path, excludes: &[&str]) -> Value {
        let config = root.join(".pi-navigation.json");
        std::fs::write(&config, "{}").unwrap();
        json!({ "root": root, "policyDigest": "0".repeat(64),
            "policyFiles": [{ "path": config, "digest": format!("{:x}", Sha256::digest(b"{}")) }],
            "policy": { "version": 1, "globalRules": [], "projectRules": ["/src/ignored/"],
                "excludedPrefixes": excludes } })
    }

    #[test]
    fn admitted_directories_filter_before_opening_and_preserve_mixed_selector_attribution() {
        for syntax in ["literal", "regex"] {
            let a = tempfile::tempdir().unwrap();
            let b = tempfile::tempdir().unwrap();
            let a = a.path().canonicalize().unwrap();
            let b = b.path().canonicalize().unwrap();
            for (root, paths) in [(&a, vec!["src/allowed.ts", "src/excluded/hidden.ts", "src/ignored/hidden.ts",
                "src/child/hidden.ts", "src/git-child/hidden.ts", "src/node_modules/hidden.ts", "src/data.lock", "src/bundle.min.js"]),
                (&b, vec!["src/allowed.ts", "src/private/hidden.ts"])] {
                for relative in paths {
                    let file = root.join(relative);
                    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                    std::fs::write(file, "O6_BOUNDARY_TOKEN\n").unwrap();
                }
            }
            std::fs::write(a.join("src/child/.pi-navigation.json"), "{}").unwrap();
            std::fs::create_dir(a.join("src/git-child/.git")).unwrap();
            std::fs::write(a.join("src/binary.dat"), b"O6_BOUNDARY_TOKEN\0").unwrap();
            let owners = vec![matches_owner(&a, &["src/excluded"]), matches_owner(&b, &["src/private"])];
            let admission = json!({ "owners": owners, "directories": {
                a.join("src").to_string_lossy().as_ref(): 0, b.join("src").to_string_lossy().as_ref(): 1 },
                "explicitFiles": [a.join("src/excluded/hidden.ts")] });
            let paths = vec![a.join("src"), b.join("src"), a.join("src/excluded/hidden.ts"), a.join("src/../src")];
            let (native, context) = context(&a);
            let output = execute(&json!({ "pattern": if syntax == "regex" { "O6_BOUNDARY_[A-Z]+" } else { "O6_BOUNDARY_TOKEN" },
                "syntax": syntax, "paths": paths, "matchesAdmission": admission, "contextLines": 0,
                "retainMatchesRender": true }), &native.cache, &native.session, &context).unwrap();
            let data = &output.structured["data"];
            assert_eq!(data["coverage"]["occurrences"], 5, "{}", output.text);
            let ledger = data["targets"].as_array().unwrap();
            assert_eq!(ledger.len(), 4);
            assert_eq!(ledger.iter().map(|row| row["occurrences"].as_u64().unwrap()).collect::<Vec<_>>(), vec![3, 1, 1, 3]);
            assert!(output.text.contains("binary_nul"));
            assert!(output.text.contains("data.lock") && output.text.contains("bundle.min.js"));
            for denied in [a.join("src/ignored/hidden.ts"), a.join("src/child/hidden.ts"),
                a.join("src/git-child/hidden.ts"), a.join("src/node_modules/hidden.ts"), b.join("src/private/hidden.ts")] {
                assert_eq!(stream_scan_count(&denied), 0, "opened {}", denied.display());
                assert_eq!(source_read_count(&denied), 0);
            }
            assert_eq!(stream_scan_count(&a.join("src/allowed.ts")), 1, "aliases scan once");
            assert_eq!(stream_scan_count(&a.join("src/excluded/hidden.ts")), 1, "explicit file override is retained");
            for row in data["sourceRows"].as_array().unwrap() {
                let text = std::fs::read_to_string(context.root.join(row["path"].as_str().unwrap())).unwrap();
                assert_eq!(row["text"].as_str().unwrap(), text.lines().nth(row["line"].as_u64().unwrap() as usize - 1).unwrap());
            }
            let origin = output.matches_render_cursor.unwrap();
            assert_eq!(native.session.cursor_owner_data(&origin)["matchesAdmission"], admission);
            let refit = json!({ "renderMatches": origin, "matchesRenderBytes": 12_000 });
            let replay = execute(&refit, &native.cache, &native.session, &context).unwrap();
            assert_eq!(replay.structured["data"]["coverage"]["occurrences"], 5);
            assert_eq!(stream_scan_count(&a.join("src/allowed.ts")), 1);
        }
    }

    #[test]
    fn directory_revocation_blocks_continuation_and_refit_before_source_access() {
        for change in ["policy", "independent-child", "nested-ignore"] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            std::fs::create_dir(root.join(".git")).unwrap();
            std::fs::create_dir_all(root.join("src/deep")).unwrap();
            let file = root.join("src/deep/many.txt");
            std::fs::write(&file, (0..300).map(|i| format!("O6_BOUNDARY_TOKEN {i} {}\n", "x".repeat(150))).collect::<String>()).unwrap();
            let admission = json!({ "owners": [matches_owner(&root, &[])],
                "directories": { root.join("src").to_string_lossy().as_ref(): 0 }, "explicitFiles": [] });
            let (native, context) = context(&root);
            let first = execute(&json!({ "pattern": "O6_BOUNDARY_TOKEN", "syntax": "literal", "paths": [root.join("src")],
                "contextLines": 0, "retainMatchesRender": true, "matchesAdmission": admission }),
                &native.cache, &native.session, &context).unwrap();
            let cursor = first.structured["data"]["cursor"].as_str().unwrap();
            let origin = first.matches_render_cursor.as_ref().unwrap();
            let refit = json!({ "renderMatches": origin, "matchesRenderBytes": 4_000 });
            let before = execute(&refit, &native.cache, &native.session, &context).unwrap();
            assert_eq!(before.text, execute(&refit, &native.cache, &native.session, &context).unwrap().text);
            let reads = source_read_count(&file);
            match change {
                "policy" => std::fs::write(root.join(".pi-navigation.json"), "{\"scope\":{\"exclude\":[\"src\"]}}").unwrap(),
                "independent-child" => std::fs::write(root.join("src/deep/.pi-navigation.json"), "{}").unwrap(),
                _ => std::fs::write(root.join("src/.gitignore"), "deep/\n").unwrap(),
            }
            for args in [json!({ "cursor": cursor }), refit] {
                let error = execute(&args, &native.cache, &native.session, &context).unwrap_err();
                assert!(error.contains("changed"), "{change}: {error}");
                assert_eq!(source_read_count(&file), reads, "revoked source opened by {change}");
                assert_eq!(stream_scan_count(&file), 1);
            }
        }
    }

    #[test]
    fn exception_rendering_is_capped_and_counts_omissions() {
        let exceptions: Vec<ExceptionalOutcome> = (0..500)
            .map(|index| ExceptionalOutcome {
                path: format!("venv/file-{index}.pyc"),
                outcome: TargetOutcome::Skipped,
                reason: "binary".into(),
            })
            .collect();
        let mut text = String::new();
        render_exceptions(&mut text, &exceptions);
        let rendered_lines = text.lines().count();
        assert_eq!(rendered_lines, MAX_RENDERED_EXCEPTIONS + 1);
        assert!(text.contains("Exceptional: venv/file-19.pyc"));
        assert!(!text.contains("file-20.pyc"));
        assert!(text.contains("480 more skipped/unreadable file outcomes omitted"));

        let mut text = String::new();
        render_exceptions(&mut text, &exceptions[..2]);
        assert_eq!(text.lines().count(), 2);
        assert!(!text.contains("omitted"));

        let mut text = String::new();
        render_exceptions(&mut text, &[]);
        assert!(text.is_empty());
    }

    #[test]
    fn toml_matches_reuse_spans_without_inventing_sibling_owners_or_source_rows() {
        let root = tempfile::tempdir().unwrap();
        let source = concat!(
            "[auth]\r\n",
            "\"é.标签\" = \"TOKEN_UTF\"\r\n",
            "branch.leaf = \"TOKEN_DOTTED\"\r\n",
            "inline = { a = \"TOKEN_A\", b = \"TOKEN_B\" }\r\n",
            "array = [\"TOKEN_X\", \"TOKEN_Y\"]\r\n",
            "note = '''\r\nTOKEN_MULTI\r\n'''\r\n",
            "[[servers]]\r\nname = \"TOKEN_ONE\"\r\n",
            "[[servers]]\r\nname = \"TOKEN_TWO\"\r\n",
            "[other]\r\nvalue = \"TOKEN_OTHER\"\r\n",
            "# TOKEN_COMMENT\r\n",
        );
        let path = root.path().join("settings.toml");
        std::fs::write(&path, source).unwrap();
        let (native, context) = context(root.path());
        for syntax in ["literal", "regex"] {
            let output = execute(&json!({"pattern":"TOKEN", "syntax":syntax,
                "paths":&path, "contextLines":0}), &native.cache, &native.session, &context).unwrap();
            assert_eq!(output.structured["data"]["coverage"]["occurrences"], source.matches("TOKEN").count());
            let groups = output.structured["data"]["groups"].as_array().unwrap();
            let owners: Vec<_> = groups.iter().filter_map(|group| group["owner"]["name"].as_str()).collect();
            assert_eq!(owners, ["auth[\"é.标签\"]", "auth.branch.leaf", "auth.inline", "auth.array",
                "auth.note", "servers[0].name", "servers[1].name", "other.value"]);
            for name in &owners { assert!(output.text.contains(name), "{}", output.text); }
            let rows = output.structured["data"]["sourceRows"].as_array().unwrap();
            assert_eq!(rows.len(), source.lines().filter(|line| line.contains("TOKEN")).count());
            for row in rows {
                let original = source.lines().nth(row["line"].as_u64().unwrap() as usize - 1).unwrap();
                assert!(original.contains("TOKEN"), "undisplayed parent acquired a source row");
                assert_eq!(row["text"], original);
            }
            assert_eq!(output.source_snapshots[0].text, source);
        }
        for (pattern, expected) in [("TOKEN_A", "auth.inline.a"), ("TOKEN_Y", "auth.array[1]")] {
            let output = execute(&json!({"pattern":pattern, "syntax":"literal", "paths":&path,
                "contextLines":0}), &native.cache, &native.session, &context).unwrap();
            assert_eq!(output.structured["data"]["groups"][0]["owner"]["name"], expected);
        }
        let headers = execute(&json!({"pattern":"servers", "syntax":"literal", "paths":&path,
            "contextLines":0}), &native.cache, &native.session, &context).unwrap();
        let names: Vec<_> = headers.structured["data"]["groups"].as_array().unwrap().iter()
            .map(|group| group["owner"]["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["servers[0]", "servers[1]"]);
    }

    #[test]
    fn toml_unavailable_or_oversized_context_never_removes_exact_hits() {
        for source in ["a = \"TOKEN\"\na = \"TOKEN\"\n".to_string(),
            "a = \"TOKEN\n".to_string(),
            format!("[{}]\na = \"TOKEN\"\n", "q".repeat(MAX_RENDERED_LINE_BYTES + 1)),
            format!("[{}]\na = '''\n{}'''\n", "q".repeat(1800), "TOKEN line\n".repeat(20))] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("settings.toml");
            std::fs::write(&path, &source).unwrap();
            let (native, context) = context(root.path());
            let output = execute(&json!({"pattern":"TOKEN", "syntax":"literal", "paths":&path,
                "contextLines":0}), &native.cache, &native.session, &context).unwrap();
            assert_eq!(output.structured["data"]["coverage"]["occurrences"], source.matches("TOKEN").count());
            let groups = output.structured["data"]["groups"].as_array().unwrap();
            assert!(groups.iter().all(|group| group["owner"].is_null()), "{}", output.text);
            assert_eq!(output.structured["data"]["sourceRows"].as_array().unwrap().len(), source.matches("TOKEN").count());
        }
    }

    #[test]
    fn matches_keep_nested_hierarchy_without_neighbor_context_or_duplicate_rows() {
        let root = tempfile::tempdir().unwrap();
        let source = "class Session {\n  run() {\n    return tasks.map(() => {\n      const needle = 1;\n      return needle;\n    });\n  }\n}\nfunction other() {\n  return 'unrelated';\n}\n";
        let path = root.path().join("nested.ts");
        std::fs::write(&path, source).unwrap();
        let (native, context) = context(root.path());
        for syntax in ["literal", "regex"] {
            let output = execute(
                &json!({"pattern":"needle", "syntax":syntax, "paths":&path, "contextLines":2}),
                &native.cache,
                &native.session,
                &context,
            )
            .unwrap();
            let group = &output.structured["data"]["groups"][0];
            let names = group["outline"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["name"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(names, ["Session", "run", "<anonymous>"]);
            assert_eq!(group["owner"]["start"], 3);
            assert_eq!(group["owner"]["end"], 6);
            assert_eq!(output.structured["data"]["coverage"]["occurrences"], 2);
            assert!(!output.text.contains("unrelated"));
            let mut delivered = BTreeSet::new();
            for row in output.structured["data"]["sourceRows"].as_array().unwrap() {
                let line = row["line"].as_u64().unwrap() as usize;
                assert!((3..=6).contains(&line));
                assert!(delivered.insert(line));
                assert_eq!(row["text"], source.lines().nth(line - 1).unwrap());
            }
            assert!(delivered.contains(&4) && delivered.contains(&5));
        }
    }

    #[test]
    fn matches_markdown_hierarchy_includes_setext_and_respects_sibling_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let source = "Guide\n=====\nintro\nLimits\n------\nneedle first\n## Other\nneedle second\n```md\n# not a section\n```\n";
        let path = root.path().join("guide.md");
        std::fs::write(&path, source).unwrap();
        let (native, context) = context(root.path());
        let output = execute(
            &json!({"pattern":"needle", "syntax":"literal", "paths":&path, "contextLines":2}),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        let groups = output.structured["data"]["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        // Setext consumes the preceding paragraph, including its first line.
        for (group, expected) in groups
            .iter()
            .zip([["Guide", "intro Limits"], ["Guide", "Other"]])
        {
            let names = group["outline"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["name"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(names, expected);
        }
        assert_eq!(groups[0]["owner"]["end"], 6);
        assert_eq!(groups[1]["owner"]["start"], 7);
        let rows = output.structured["data"]["sourceRows"].as_array().unwrap();
        let mut delivered = BTreeSet::new();
        for row in rows {
            let line = row["line"].as_u64().unwrap() as usize;
            assert!(delivered.insert(line));
            assert_eq!(row["text"], source.lines().nth(line - 1).unwrap());
        }
        assert!(delivered.contains(&6) && delivered.contains(&8));
    }

    #[test]
    fn literal_regex_spans_large_text_binary_and_exact_target_truth() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        std::fs::write(root.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(root.path().join("hot.txt"), "foo foo\nfoo\n").unwrap();
        std::fs::write(root.path().join("cold.txt"), "foo\n").unwrap();
        std::fs::write(root.path().join("ignored.txt"), "foo\n").unwrap();
        std::fs::write(root.path().join("binary.dat"), b"foo\0bar").unwrap();
        std::fs::write(
            root.path().join("large.txt"),
            format!("{}foo\n", "x".repeat(600_000)),
        )
        .unwrap();
        let (native, context) = context(root.path());
        let args = json!({
            "pattern": "foo",
            "syntax": "literal",
            "paths": [root.path().join("hot.txt"), root.path().join("cold.txt"), root.path().join("ignored.txt"), root.path().join("binary.dat"), root.path().join("large.txt")],
            "visibility": "project"
        });
        let output = execute(&args, &native.cache, &native.session, &context).unwrap();
        assert!(output.text.contains("hot.txt"));
        assert!(output.text.contains("cold.txt"));
        assert!(output.text.contains("ignored.txt"));
        assert!(output.text.contains("binary_nul"));
        assert_eq!(
            output.structured["data"]["exceptions"][0]["path"],
            "binary.dat"
        );
        let occurrences = output.structured["data"]["coverage"]["occurrences"]
            .as_u64()
            .unwrap();
        assert_eq!(occurrences, 6);
        let groups = output.structured["data"]["groups"].as_array().unwrap();
        let hot = groups
            .iter()
            .find(|group| group["path"] == "hot.txt")
            .unwrap();
        assert_eq!(hot["matches"][0]["spans"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn regex_alternation_invalid_regex_cursor_idempotence_and_source_drift() {
        let root = tempfile::tempdir().unwrap();
        let mut source = String::new();
        for index in 0..200 {
            writeln!(source, "hello {index} goodbye {}", "x".repeat(200)).unwrap();
        }
        std::fs::write(root.path().join("many.txt"), source).unwrap();
        let (native, context) = context(root.path());
        let args = json!({ "pattern": "hello|goodbye", "syntax": "regex", "paths": root.path(), "contextLines": 0 });
        let first = execute(&args, &native.cache, &native.session, &context).unwrap();
        let cursor = first.structured["data"]["cursor"]
            .as_str()
            .unwrap()
            .to_string();
        let scanned_path = root.path().join("many.txt").canonicalize().unwrap();
        let scans_before_continuation = stream_scan_count(&scanned_path);
        assert_eq!(scans_before_continuation, 1);
        let second = execute(
            &json!({ "cursor": cursor }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        let repeated = execute(
            &json!({ "cursor": cursor }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert_eq!(second.text, repeated.text);
        assert_eq!(
            stream_scan_count(&scanned_path),
            scans_before_continuation,
            "cursor continuation must consume the Rust-owned result dataset without rescanning"
        );
        let mut wrong_version = native.session.get_cursor(&cursor).unwrap();
        wrong_version["version"] = Value::from(1);
        let wrong_version = native.session.put_cursor(wrong_version);
        let version_error = execute(
            &json!({ "cursor": wrong_version }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap_err();
        assert!(version_error.contains("version"));
        let mut wrong_root = native.session.get_cursor(&cursor).unwrap();
        wrong_root["root"] = Value::from("/");
        let wrong_root = native.session.put_cursor(wrong_root);
        let root_error = execute(
            &json!({ "cursor": wrong_root }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap_err();
        assert!(root_error.contains("root mismatch"));
        std::fs::write(root.path().join("many.txt"), "changed\n").unwrap();
        let stale = execute(
            &json!({ "cursor": cursor }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap_err();
        assert!(stale.contains("cursor stale"));
        let invalid = execute(
            &json!({ "pattern": "hola|(", "syntax": "regex" }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap_err();
        assert!(invalid.contains("invalid regex"));
        let auto = execute(
            &json!({ "pattern": "hello|goodbye", "syntax": "auto", "paths": root.path() }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert!(auto.text.contains("Resolved: auto→regex"));
        let invalid_auto = execute(
            &json!({ "pattern": "hola|(", "syntax": "auto", "paths": root.path() }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap_err();
        assert!(invalid_auto.contains("invalid regex"));
    }

    #[test]
    fn custom_ignore_layers_over_git_and_markdown_owner_is_structured() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        std::fs::create_dir_all(root.path().join(".pi/navigation")).unwrap();
        std::fs::write(root.path().join(".gitignore"), "git.md\n").unwrap();
        std::fs::write(root.path().join(".pi/navigation/ignore"), "custom.md\n").unwrap();
        std::fs::write(root.path().join("git.md"), "# Owner\nneedle\n").unwrap();
        std::fs::write(root.path().join("custom.md"), "# Hidden\nneedle\n").unwrap();
        std::fs::write(
            root.path().join("owner.md"),
            "# Owner\nbefore\n{\n\nneedle\n\n}\nafter\n",
        )
        .unwrap();
        let (native, context) = context(root.path());
        let output = execute(
            &json!({ "pattern": "needle", "syntax": "literal", "paths": root.path() }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert!(
            !output.text.contains("git.md"),
            "gitignore stays respected when a custom ignore file exists"
        );
        assert!(!output.text.contains("custom.md:"));
        assert!(output.text.contains("owner.md"));
        assert!(output.text.contains("section Owner"));
        assert!(output.text.contains("ignore layered · gitignore respected"));
        let lines: Vec<_> = output.structured["data"]["sourceRows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["line"].as_u64().unwrap())
            .collect();
        assert_eq!(
            lines,
            vec![2, 3, 5, 7, 8],
            "plain Markdown delimiters remain useful context"
        );
    }

    #[test]
    fn auto_context_small_result_defaults_to_c2() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        std::fs::write(
            root.path().join("small.ts"),
            "let first = 1;\nlet second = 2;\nconst needle = first + second;\nlet fourth = 4;\nlet fifth = 5;\n",
        )
        .unwrap();
        let (native, context) = context(root.path());
        let output = execute(
            &json!({ "pattern": "needle", "syntax": "literal" }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert_eq!(output.structured["data"]["resolved"]["contextMode"], "auto");
        assert_eq!(
            output.structured["data"]["resolved"]["contextDefaultTier"],
            2
        );
        assert_eq!(
            output.structured["data"]["resolved"]["contextWindows"]["c2"],
            1
        );
        assert!(output.text.contains("1- let first = 1;"));
        assert!(output.text.contains("3: const needle = first + second;"));
        assert!(output.text.contains("5- let fifth = 5;"));
    }

    #[test]
    fn auto_context_mixes_windows_instead_of_demoting_every_group() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        let filler = "x".repeat(1_000);
        for index in 0..8 {
            let source =
                format!("{filler}\n{filler}\nconst needle{index} = 1;\n{filler}\n{filler}\n");
            std::fs::write(root.path().join(format!("f{index:02}.ts")), source).unwrap();
        }
        let (native, context) = context(root.path());
        let output = execute(
            &json!({ "pattern": "needle", "syntax": "literal" }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        let windows = &output.structured["data"]["resolved"]["contextWindows"];
        let c0 = windows["c0"].as_u64().unwrap_or(0);
        let c1 = windows["c1"].as_u64().unwrap_or(0);
        let c2 = windows["c2"].as_u64().unwrap_or(0);
        assert_eq!(output.structured["data"]["resolved"]["contextMode"], "auto");
        assert!(c1 + c2 > 0, "front groups keep richer context");
        assert!(
            c0 > 0,
            "trailing groups demote per-window toward the soft target"
        );
        assert_eq!(c0 + c1 + c2, 8);
        assert_eq!(output.structured["data"]["coverage"]["more"], false);
    }

    #[test]
    fn explicit_context_lines_stay_uniform() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        let source = "function container() {\n  const beforeOne = 1;\n\n  {\n    const beforeTwo = 2;\n  }\n\n  const needle = 0;\n\n  {\n    const afterOne = 3;\n  }\n  const afterTwo = 4;\n}\n";
        for path in ["alpha.ts", "beta.ts"] {
            std::fs::write(root.path().join(path), source).unwrap();
        }
        let (native, context) = context(root.path());
        let output = execute(
            &json!({ "pattern": "needle", "syntax": "literal", "contextLines": 2 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert_eq!(
            output.structured["data"]["resolved"]["contextMode"],
            "explicit"
        );
        assert_eq!(output.structured["data"]["resolved"]["contextLines"], 2);
        assert!(output.text.contains("contextLines=2"));
        assert_eq!(
            output.structured["data"]["groups"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let rows = output.structured["data"]["sourceRows"].as_array().unwrap();
        for path in ["alpha.ts", "beta.ts"] {
            let visible: Vec<_> = rows.iter().filter(|row| row["path"] == path).collect();
            assert_eq!(
                visible
                    .iter()
                    .map(|row| row["line"].as_u64().unwrap())
                    .collect::<Vec<_>>(),
                vec![2, 5, 8, 11, 13]
            );
            for row in visible {
                assert_eq!(
                    row["text"],
                    source
                        .lines()
                        .nth(row["line"].as_u64().unwrap() as usize - 1)
                        .unwrap()
                );
            }
        }
        let delimiters = execute(
            &json!({ "pattern": "}", "syntax": "literal", "contextLines": 0 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        for path in ["alpha.ts", "beta.ts"] {
            let lines: Vec<_> = delimiters.structured["data"]["sourceRows"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["path"] == path)
                .map(|row| row["line"].as_u64().unwrap())
                .collect();
            assert_eq!(
                lines,
                vec![6, 12, 14],
                "delimiter matches must remain visible"
            );
        }
        let values = root.path().join("values.json");
        std::fs::write(
            &values,
            "{\n  \"before\": [\n    []\n  ],\n  \"needle\": 0,\n  \"after\": [\n    {}\n  ]\n}\n",
        )
        .unwrap();
        let output = execute(
            &json!({ "pattern": "needle", "syntax": "literal", "paths": values, "contextLines": 2 }),
            &native.cache,
            &native.session,
            &context,
        ).unwrap();
        let lines: Vec<_> = output.structured["data"]["sourceRows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["line"].as_u64().unwrap())
            .collect();
        assert_eq!(
            lines,
            vec![2, 3, 5, 6, 7],
            "empty array/object values are meaningful context"
        );
    }

    #[test]
    fn page_fills_to_hard_before_paginating() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        let filler = "x".repeat(600);
        let big = (0..132)
            .map(|index| format!("const needle{index} = \"{filler}\";"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(root.path().join("big.ts"), big).unwrap();
        std::fs::write(root.path().join("small.ts"), "const needle_small = 1;\n").unwrap();
        let (native, context) = context(root.path());
        let first = execute(
            &json!({ "pattern": "needle", "syntax": "literal" }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        let first_group_count = first.structured["data"]["coverage"]["returnedGroups"]
            .as_u64()
            .expect("returned group count");
        assert!(
            first_group_count > 1,
            "page size is byte-driven, not one group"
        );
        assert!(
            first_group_count < 133,
            "the hard ceiling creates continuation"
        );
        assert!(
            first.text.len() > SOFT_RENDERED_BYTES,
            "soft may be exceeded to avoid a prematurely short page"
        );
        assert!(
            first.text.len() <= HARD_RENDERED_BYTES,
            "header/footer allowance keeps the rendered page under hard"
        );
        assert!(first.text.contains("### big.ts"));

        let mut current = first;
        let mut returned = 0u64;
        let mut pages = 0usize;
        let mut saw_small = false;
        let expected: BTreeSet<_> = (1_u64..=132)
            .map(|line| ("big.ts".to_string(), line, 6_u64, 12_u64))
            .chain(std::iter::once(("small.ts".to_string(), 1, 6, 12)))
            .collect();
        let mut delivered = BTreeSet::new();
        loop {
            pages += 1;
            returned += current.structured["data"]["coverage"]["returnedGroups"]
                .as_u64()
                .expect("returned group count");
            saw_small |= current.text.contains("### small.ts");
            let groups = current.structured["data"]["groups"].as_array().unwrap();
            let visible_paths: BTreeSet<_> = groups
                .iter()
                .map(|group| {
                    root.path()
                        .join(group["path"].as_str().unwrap())
                        .canonicalize()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect();
            let snapshot_paths: BTreeSet<_> = current
                .source_snapshots
                .iter()
                .map(|snapshot| snapshot.canonical_path.clone())
                .collect();
            assert_eq!(
                snapshot_paths, visible_paths,
                "only this page's files cross the source-proof boundary"
            );
            for group in groups {
                for row in group["matches"].as_array().unwrap() {
                    for span in row["spans"].as_array().unwrap() {
                        let identity = (
                            group["path"].as_str().unwrap().to_string(),
                            row["line"].as_u64().unwrap(),
                            span["startByte"].as_u64().unwrap(),
                            span["endByte"].as_u64().unwrap(),
                        );
                        assert!(
                            delivered.insert(identity.clone()),
                            "duplicate occurrence: {identity:?}"
                        );
                    }
                }
            }
            let Some(cursor) = current.structured["data"]["cursor"]
                .as_str()
                .map(str::to_string)
            else {
                break;
            };
            assert!(pages < 20, "cursor must make forward progress");
            current = execute(
                &json!({ "cursor": cursor }),
                &native.cache,
                &native.session,
                &context,
            )
            .unwrap();
        }
        assert!(pages > 1);
        assert!(saw_small);
        assert_eq!(returned, 133, "all hierarchy groups arrive exactly once");
        assert_eq!(
            delivered, expected,
            "every independently identified occurrence arrives"
        );
    }

    #[test]
    fn oversized_owner_group_paginates_every_span_without_losing_hierarchy() {
        let root = tempfile::tempdir().unwrap();
        let mut source = String::from("function flood() {\n");
        for _ in 0..37 {
            writeln!(source, "  consume(\"needle needle {}\");", "x".repeat(900)).unwrap();
        }
        source.push_str("}\n");
        let path = root.path().join("flood.ts");
        std::fs::write(&path, &source).unwrap();
        let lines: Vec<_> = source.lines().collect();
        let expected: BTreeSet<_> = lines
            .iter()
            .enumerate()
            .flat_map(|(line, text)| {
                text.match_indices("needle")
                    .map(move |(start, _)| (line as u64 + 1, start as u64, (start + 6) as u64))
            })
            .collect();
        for explicit in [None, Some(0), Some(2)] {
            let (native, context) = context(root.path());
            let mut args = json!({ "pattern": "needle", "syntax": "literal", "paths": path });
            if let Some(tier) = explicit {
                args["contextLines"] = json!(tier);
            }
            let mut page = execute(&args, &native.cache, &native.session, &context).unwrap();
            assert!(
                page.structured["data"]["coverage"]["nextMatch"]
                    .as_u64()
                    .unwrap()
                    > 0
            );
            let mut delivered = BTreeSet::new();
            let mut pages = 0;
            loop {
                pages += 1;
                assert!(page.text.len() <= HARD_RENDERED_BYTES);
                for group in page.structured["data"]["groups"].as_array().unwrap() {
                    assert_eq!(group["owner"]["name"], "flood");
                    assert_eq!(group["owner"]["start"], 1);
                    assert_eq!(group["owner"]["end"], 39);
                    for row in group["matches"].as_array().unwrap() {
                        for span in row["spans"].as_array().unwrap() {
                            assert!(
                                delivered.insert((
                                    row["line"].as_u64().unwrap(),
                                    span["startByte"].as_u64().unwrap(),
                                    span["endByte"].as_u64().unwrap()
                                )),
                                "occurrence replayed"
                            );
                        }
                    }
                }
                let mut page_rows = BTreeSet::new();
                for row in page.structured["data"]["sourceRows"].as_array().unwrap() {
                    assert!(
                        page_rows.insert((
                            row["path"].as_str().unwrap().to_string(),
                            row["line"].as_u64().unwrap()
                        )),
                        "source row repeated on one page"
                    );
                    assert_eq!(
                        row["text"].as_str().unwrap(),
                        lines[row["line"].as_u64().unwrap() as usize - 1]
                    );
                }
                let Some(cursor) = page.structured["data"]["cursor"].as_str() else {
                    break;
                };
                assert!(pages < 20, "continuation must advance within the group");
                let request = json!({ "cursor": cursor });
                page = execute(&request, &native.cache, &native.session, &context).unwrap();
                let replay = execute(&request, &native.cache, &native.session, &context).unwrap();
                assert_eq!(
                    page.structured["data"]["groups"],
                    replay.structured["data"]["groups"]
                );
                if let Some(tier) = explicit {
                    assert_eq!(page.structured["data"]["resolved"]["contextLines"], tier);
                }
            }
            assert!(pages > 1);
            assert_eq!(delivered, expected);
        }
    }

    #[test]
    fn code_owner_outline_context_and_source_rows_share_the_retained_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let source = "fn before() {}\nfn owner() {\n    let needle = 1;\n    println!(\"needle {needle}\");\n}\nfn after() {}\n";
        let path = root.path().join("owner.rs");
        std::fs::write(&path, source).unwrap();
        let (native, context) = context(root.path());
        let output = execute(
            &json!({ "pattern": "needle", "syntax": "literal", "paths": &path, "contextLines": 1 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        let group = &output.structured["data"]["groups"][0];
        assert_eq!(group["owner"]["name"], "owner");
        assert_eq!(group["owner"]["start"], 2);
        assert_eq!(group["owner"]["end"], 5);
        assert!(group["outline"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["selected"] == true));
        let rows = output.structured["data"]["sourceRows"].as_array().unwrap();
        assert!(rows
            .iter()
            .any(|row| row["line"] == 3 && row["text"] == "    let needle = 1;"));
        assert_eq!(output.source_snapshots.len(), 1);
        assert_eq!(output.source_snapshots[0].text, source);
    }

    #[test]
    fn concurrent_calls_are_deterministic_and_cursor_context_override_is_presentation_only() {
        let root = tempfile::tempdir().unwrap();
        let mut source = String::new();
        for index in 0..200 {
            writeln!(source, "alpha {index} beta {}", "x".repeat(200)).unwrap();
        }
        std::fs::write(root.path().join("many.txt"), source).unwrap();
        let (native, context) = context(root.path());
        let alpha = json!({ "pattern": "alpha", "syntax": "literal", "paths": root.path() });
        let beta = json!({ "pattern": "beta", "syntax": "literal", "paths": root.path() });
        let sequential_alpha = execute(&alpha, &native.cache, &native.session, &context)
            .unwrap()
            .text;
        let sequential_beta = execute(&beta, &native.cache, &native.session, &context)
            .unwrap()
            .text;
        let (parallel_alpha, parallel_beta) = std::thread::scope(|scope| {
            let left_context = context.clone();
            let right_context = context.clone();
            let cache = &native.cache;
            let session = &native.session;
            let alpha_ref = &alpha;
            let beta_ref = &beta;
            let left = scope.spawn(move || {
                execute(alpha_ref, cache, session, &left_context)
                    .unwrap()
                    .text
            });
            let right = scope.spawn(move || {
                execute(beta_ref, cache, session, &right_context)
                    .unwrap()
                    .text
            });
            (left.join().unwrap(), right.join().unwrap())
        });
        assert_eq!(parallel_alpha, sequential_alpha);
        assert_eq!(parallel_beta, sequential_beta);

        let first = execute(&alpha, &native.cache, &native.session, &context).unwrap();
        let cursor = first.structured["data"]["cursor"].as_str().unwrap();
        let continued = execute(
            &json!({ "cursor": cursor, "contextLines": 2 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert_eq!(continued.structured["data"]["resolved"]["contextLines"], 2);
        assert!(continued.text.contains("Continuation:"));
    }

    #[test]
    fn streaming_execution_reports_bounded_snapshot_fallback_and_text_edges() {
        let root = tempfile::tempdir().unwrap();
        let unmatched = root.path().join("large-unmatched.txt");
        let huge_matched = root.path().join("huge-matched.txt");
        let crlf = root.path().join("crlf.txt");
        let bom = root.path().join("bom.txt");
        let invalid = root.path().join("invalid.txt");
        std::fs::write(&unmatched, format!("{}\n", "x".repeat(2_000_000))).unwrap();
        std::fs::write(
            &huge_matched,
            format!("{}needle{}\n", "x".repeat(1_000_000), "y".repeat(1_000_000)),
        )
        .unwrap();
        std::fs::write(&crlf, b"before\r\nneedle\r\nafter\r\n").unwrap();
        std::fs::write(&bom, b"\xEF\xBB\xBFneedle\n").unwrap();
        std::fs::write(&invalid, b"plain\n\xFF\n").unwrap();
        let (native, context) = context(root.path());
        let output = execute(
            &json!({
                "pattern": "needle",
                "syntax": "literal",
                "paths": [&unmatched, &huge_matched, &crlf, &bom, &invalid]
            }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        let diagnostics = output.structured["data"]["executionDiagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(diagnostics.contains("5 streamed files"));
        assert!(diagnostics.contains("3 matched snapshot reads"));
        assert_eq!(stream_scan_count(&unmatched.canonicalize().unwrap()), 1);
        assert_eq!(stream_scan_count(&huge_matched.canonicalize().unwrap()), 1);
        assert!(output.text.contains("crlf.txt"));
        assert!(output.text.contains("bom.txt"));
        assert!(output.text.contains("invalid_utf8"));
        assert!(output.text.contains("oversized source lines clipped"));
        assert!(output.text.len() < 12_000);
        assert_eq!(
            output.structured["data"]["coverage"]["clippedSourceLines"],
            1
        );
        let huge_group = output.structured["data"]["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["path"].as_str() == Some("huge-matched.txt"))
            .unwrap();
        assert_eq!(huge_group["matches"][0]["textClipped"], true);
        assert!(!output.structured["data"]["sourceRows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["path"].as_str() == Some("huge-matched.txt")));
        assert_eq!(output.source_snapshots.len(), 3);
    }

    #[test]
    fn rayon_candidate_merge_is_deterministic_and_uses_bounded_worker_state() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..32 {
            std::fs::write(
                root.path().join(format!("file-{index:02}.txt")),
                format!("{}\nneedle {index}\n", "x".repeat(64_000)),
            )
            .unwrap();
        }
        let (native, context) = context(root.path());
        let args = json!({ "pattern": "needle", "syntax": "literal", "paths": root.path() });
        let first = execute(&args, &native.cache, &native.session, &context).unwrap();
        let second = execute(&args, &native.cache, &native.session, &context).unwrap();
        assert_eq!(first.text, second.text);
        let diagnostics = first.structured["data"]["executionDiagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(diagnostics.contains("32 streamed files"));
        assert!(diagnostics.contains("32 matched snapshot reads"));
        assert!(diagnostics.contains("in flight"));
    }

    #[cfg(unix)]
    #[test]
    fn exact_alias_targets_preserve_requested_identity_while_scanning_once() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.txt");
        let alias = root.path().join("alias.txt");
        std::fs::write(&source, "needle\n").unwrap();
        symlink("source.txt", &alias).unwrap();
        let (native, context) = context(root.path());
        let output = execute(
            &json!({
                "pattern": "needle",
                "syntax": "literal",
                "paths": [&source, &source],
                "requestedPaths": ["alias.txt", "source.txt"]
            }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();

        assert!(output.text.contains("Target: alias.txt · Searched"));
        assert!(output.text.contains("Target: source.txt · Searched"));
        assert_eq!(stream_scan_count(&source.canonicalize().unwrap()), 1);
        assert_eq!(
            output.structured["data"]["targets"][0]["requested"],
            "alias.txt"
        );
        assert_eq!(
            output.structured["data"]["targets"][1]["requested"],
            "source.txt"
        );
    }

    #[test]
    fn oversized_match_group_is_rejected_before_it_can_become_a_page() {
        let path = dataset_path();
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        let mut writer = BufWriter::new(file);
        let group = MatchGroup {
            path: "large.md".into(),
            owner: Some(OwnerRegion {
                kind: "section".into(),
                name: "x".repeat(MAX_GROUP_RECORD_BYTES),
                start: 1,
                end: 1,
            }),
            outline: Vec::new(),
            matches: Vec::new(),
        };
        let error = write_group_record(&mut writer, &group).unwrap_err();
        assert!(error.contains("response safety limit"), "{error}");
        let _ = std::fs::remove_file(path);
    }

    /// A dense audit whose visible per-target ledger alone exceeds the old fixed
    /// header/footer allowance must page rather than refuse: every requested
    /// path keeps a status row on every page, occurrences keep exact identity
    /// with no replay, and no page may exceed the native hard byte ceiling.
    #[test]
    fn dense_multi_target_audit_pages_with_visible_path_status_and_exact_union() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        let mut paths = Vec::new();
        let mut expected = BTreeSet::new();
        for index in 0..48u32 {
            let name = format!("t{index:02}.ts");
            let mut source = String::from("export function marker() {\n");
            for k in 0..5u32 {
                let line = format!("  const needle{index}_{k} = \"{}\";", "y".repeat(120));
                let start = line.find("needle").expect("fixture contains the pattern") as u64;
                expected.insert((name.clone(), u64::from(k) + 2, start, start + 6));
                source.push_str(&line);
                source.push('\n');
            }
            source.push_str("}\n");
            std::fs::write(root.path().join(&name), source).unwrap();
            paths.push(root.path().join(&name));
        }
        let (native, context) = context(root.path());
        let args = json!({ "pattern": "needle", "syntax": "literal", "paths": paths, "contextLines": 0 });
        let mut page = execute(&args, &native.cache, &native.session, &context)
            .expect("a dense multi-target audit must page, not refuse");
        let mut delivered = BTreeSet::new();
        let mut pages = 0usize;
        loop {
            pages += 1;
            assert!(
                page.text.len() <= HARD_RENDERED_BYTES,
                "page {pages} exceeded the native hard byte ceiling"
            );
            let status_lines: Vec<&str> = page
                .text
                .lines()
                .filter(|line| line.starts_with("Target: "))
                .collect();
            assert_eq!(
                status_lines.len(),
                48,
                "page {pages} must keep every requested path's status visible"
            );
            assert_eq!(
                status_lines
                    .iter()
                    .filter(|line| line.contains("· Searched · 5 occurrences"))
                    .count(),
                48,
                "each status row reports that path's own occurrence count"
            );
            for index in 0..48u32 {
                assert!(
                    page.text.contains(&format!("t{index:02}.ts")),
                    "page {pages} is missing the status row for t{index:02}.ts"
                );
            }
            assert_eq!(
                page.structured["data"]["coverage"]["occurrences"]
                    .as_u64()
                    .unwrap(),
                240,
                "the reported total stays the audit total, not this page's count"
            );
            for group in page.structured["data"]["groups"].as_array().unwrap() {
                let path = group["path"].as_str().unwrap().to_string();
                for row in group["matches"].as_array().unwrap() {
                    for span in row["spans"].as_array().unwrap() {
                        assert!(
                            delivered.insert((
                                path.clone(),
                                row["line"].as_u64().unwrap(),
                                span["startByte"].as_u64().unwrap(),
                                span["endByte"].as_u64().unwrap(),
                            )),
                            "occurrence replayed across pages"
                        );
                    }
                }
            }
            let Some(cursor) = page.structured["data"]["cursor"].as_str().map(str::to_string)
            else {
                break;
            };
            assert!(pages < 20, "cursor must make forward progress");
            let request = json!({ "cursor": cursor });
            page = execute(&request, &native.cache, &native.session, &context).unwrap();
            let replay = execute(&request, &native.cache, &native.session, &context).unwrap();
            assert_eq!(page.text, replay.text, "a continuation page must replay identically");
            assert_eq!(
                page.structured["data"]["groups"], replay.structured["data"]["groups"],
                "a continuation page must replay the same groups"
            );
        }
        assert!(
            pages > 1,
            "a dense audit with a large visible ledger must paginate"
        );
        assert_eq!(
            delivered, expected,
            "every occurrence of the dense audit arrives exactly once"
        );
    }

    /// Astra's single-row refusal. Group A holds one matching row at line 3 and
    /// two oversized optional neighbours, so at C2 its block sits inside the
    /// window the clipping notice occupies: the pre-fix demotion target omitted
    /// that notice, stopped one context row early, and the fit loop then had to
    /// refuse (a one-row group cannot split). The actual page budget after
    /// demotion must deliver the row, and a C0 request of the same audit must
    /// fit without any demotion at all.
    #[test]
    fn single_row_with_oversized_neighbours_demotes_context_instead_of_refusing() {
        let root = tempfile::tempdir().unwrap();
        let oversized = "x".repeat(2_400);
        // The two long optional neighbours tune this group's C2 block into the
        // band where it fits the old (notice-less) target but not the page
        // budget that actually prints the clipping notice: measured refusal at
        // 1_935-1_965, so 1_950 sits mid-band.
        std::fs::write(
            root.path().join("a.txt"),
            format!(
                "{oversized}\n{}\nneedle\n{}\n{oversized}\n",
                "y".repeat(1_950),
                "z".repeat(1_950)
            ),
        )
        .unwrap();
        // A second match keeps a successor cursor on the page, so the metadata
        // the target must reserve includes the receipt line.
        std::fs::write(root.path().join("b.txt"), "needle\n").unwrap();
        // Substantial zero-target ledger: 44 requested paths with no match, each
        // visible row the same byte length so the page budget is deterministic.
        let mut zeros = Vec::new();
        for index in 0..44u32 {
            let dir = root
                .path()
                .join(format!("generated/z{index:02}/section-{index:02}/part-{index:02}"));
            std::fs::create_dir_all(&dir).unwrap();
            let name = format!("item-{index:04}.txt");
            std::fs::write(dir.join(&name), "unrelated\n").unwrap();
            zeros.push(dir.join(&name));
        }
        let (native, context) = context(root.path());
        let mut paths = vec![root.path().join("a.txt"), root.path().join("b.txt")];
        paths.extend(zeros);
        let page = execute(
            &json!({ "pattern": "needle", "syntax": "literal", "paths": paths.clone() }),
            &native.cache,
            &native.session,
            &context,
        )
        .expect(
            "a single matched row with oversized optional neighbours must demote optional context to fit, not refuse",
        );
        assert!(
            page.text.len() <= HARD_RENDERED_BYTES,
            "the page must respect the native hard byte ceiling"
        );
        assert_eq!(
            page.text
                .lines()
                .filter(|line| line.starts_with("Target: "))
                .count(),
            46,
            "every requested path keeps a visible status row"
        );
        assert!(
            page.text.contains("3: needle"),
            "the matching row must be delivered: {}",
            page.text
        );
        let context_rows = page
            .text
            .lines()
            .filter(|line| {
                ["1- ", "2- ", "4- ", "5- "]
                    .iter()
                    .any(|prefix| line.starts_with(prefix))
            })
            .count();
        assert!(
            context_rows < 4,
            "optional context must be demoted below the C2 default: {}",
            page.text
        );
        // The same audit at C0 fits without any demotion: the refusal was the
        // context choice, not the size of the requested evidence.
        let zero_context = execute(
            &json!({ "pattern": "needle", "syntax": "literal", "paths": paths, "contextLines": 0 }),
            &native.cache,
            &native.session,
            &context,
        )
        .expect("the same audit at C0 must fit");
        assert!(zero_context.text.contains("3: needle"));
    }

    /// One audit file whose page is complete on its own, so a retained origin is
    /// the only reason its dataset must survive.
    fn retained_fixture(root: &Path, rows: usize) -> PathBuf {
        let mut source = String::new();
        for index in 0..rows {
            writeln!(source, "needle {index} {}", "x".repeat(200)).unwrap();
        }
        let path = root.join("audit.txt");
        std::fs::write(&path, source).unwrap();
        path
    }

    #[test]
    fn retained_origin_refits_smaller_without_rescan_or_header_change() {
        let root = tempfile::tempdir().unwrap();
        let path = retained_fixture(root.path(), 40);
        let (native, context) = context(root.path());
        let first = execute(
            &json!({ "pattern": "needle", "syntax": "literal", "paths": &path, "retainMatchesRender": true }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        let origin = first
            .matches_render_cursor
            .clone()
            .expect("a retained origin is returned");
        assert!(
            first.structured["data"]["cursor"].is_null(),
            "the fixture page is complete, so only the origin keeps the dataset"
        );
        assert!(first.text.contains("40: needle 39"), "{}", first.text);
        let canonical = path.canonicalize().unwrap();
        let scans = stream_scan_count(&canonical);

        let refit = execute(
            &json!({ "renderMatches": origin, "matchesRenderBytes": 4_000 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert_eq!(
            refit.matches_render_cursor.as_deref(),
            Some(origin.as_str()),
            "a replay answers with the same origin handle"
        );
        assert_eq!(
            stream_scan_count(&canonical),
            scans,
            "a retained refit must consume the stored dataset without rescanning"
        );
        assert!(
            refit.text.len() <= 4_000,
            "the byte allowance bounds the delivered page: {}",
            refit.text.len()
        );
        assert!(
            !refit.text.contains("Continuation:"),
            "the retained first page must not print a continuation header"
        );
        assert_eq!(
            refit.text.lines().next(),
            first.text.lines().next(),
            "the refit keeps the same search identity"
        );
        assert!(
            refit
                .text
                .lines()
                .nth(1)
                .unwrap()
                .starts_with("Resolved: literal · output=matches · case=smart→insensitive · context=auto · default C0 · windows "),
            "the refit resolves the same way; only the window counts follow the smaller page: {}",
            refit.text.lines().nth(1).unwrap()
        );
        assert!(
            refit.structured["data"]["cursor"].is_string(),
            "rows left out of the smaller page keep a public cursor"
        );
        // A public continuation may retain its own page origin, and replaying
        // that origin keeps the continuation marker of the page it came from.
        let continued = execute(
            &json!({ "cursor": refit.structured["data"]["cursor"], "retainMatchesRender": true }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        let continued_origin = continued
            .matches_render_cursor
            .clone()
            .expect("a retaining continuation exposes its own origin");
        assert_ne!(
            continued_origin, origin,
            "a continuation page retains its own page start, not the first page"
        );
        let continued_refit = execute(
            &json!({ "renderMatches": continued_origin, "matchesRenderBytes": 3_000 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert!(
            continued_refit.text.len() <= 3_000 && continued_refit.text.contains("Continuation:"),
            "a continuation-page replay keeps its continuation header: {}",
            continued_refit.text.lines().take(3).collect::<Vec<_>>().join(" | ")
        );
        assert_eq!(
            continued_refit.matches_render_cursor.as_deref(),
            Some(continued_origin.as_str())
        );
        let replay = execute(
            &json!({ "renderMatches": origin, "matchesRenderBytes": 4_000 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert_eq!(refit.text, replay.text, "a refit replays identically");

        // An explicit context override is captured by the origin and reused.
        let overridden = execute(
            &json!({ "pattern": "needle", "syntax": "literal", "paths": &path, "contextLines": 1, "retainMatchesRender": true }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        let overridden_origin = overridden.matches_render_cursor.clone().unwrap();
        let overridden_refit = execute(
            &json!({ "renderMatches": overridden_origin, "matchesRenderBytes": 4_000 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert_eq!(
            overridden_refit.structured["data"]["resolved"]["contextLines"],
            json!(1),
            "the retained origin keeps the explicit context override"
        );
    }

    #[test]
    fn retained_origin_refit_delivers_only_its_own_rows() {
        let root = tempfile::tempdir().unwrap();
        let path = retained_fixture(root.path(), 40);
        let (native, context) = context(root.path());
        let first = execute(
            &json!({ "pattern": "needle", "syntax": "literal", "paths": &path, "retainMatchesRender": true }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        let origin = first.matches_render_cursor.clone().unwrap();
        let refit = execute(
            &json!({ "renderMatches": origin, "matchesRenderBytes": 3_000 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert!(refit.text.len() <= 3_000);
        assert!(
            !refit.text.contains("40: needle 39"),
            "rows beyond the allowance are not delivered: {}",
            refit.text
        );
        assert_eq!(
            refit.structured["data"]["coverage"]["occurrences"].as_u64(),
            Some(40),
            "the audit total is unchanged by a smaller page"
        );
        assert_eq!(
            refit.structured["data"]["coverage"]["more"],
            json!(true),
            "a smaller page keeps continuation"
        );
        // Every credited row is a delivered row, and the delivered union is the
        // whole audit once the public cursor is drained.
        let mut delivered = BTreeSet::new();
        let mut page = refit;
        let mut pages = 0usize;
        loop {
            pages += 1;
            for group in page.structured["data"]["groups"].as_array().unwrap() {
                for row in group["matches"].as_array().unwrap() {
                    let line = row["line"].as_u64().unwrap();
                    assert!(
                        page.text.contains(&format!("{line}: ")),
                        "a credited row must appear in the delivered page: {line}"
                    );
                    for span in row["spans"].as_array().unwrap() {
                        assert!(
                            delivered.insert((
                                line,
                                span["startByte"].as_u64().unwrap(),
                                span["endByte"].as_u64().unwrap(),
                            )),
                            "occurrence replayed"
                        );
                    }
                }
            }
            let Some(cursor) = page.structured["data"]["cursor"].as_str().map(str::to_string)
            else {
                break;
            };
            assert!(pages < 20, "continuation must advance");
            page = execute(
                &json!({ "cursor": cursor }),
                &native.cache,
                &native.session,
                &context,
            )
            .unwrap();
        }
        assert!(pages > 1, "the smaller page needs a continuation");
        assert_eq!(
            delivered.len(),
            40,
            "the refit plus its continuations deliver every occurrence exactly once"
        );
    }

    #[test]
    fn duplicate_retained_queries_and_refit_successors_keep_the_origin_dataset() {
        let root = tempfile::tempdir().unwrap();
        let path = retained_fixture(root.path(), 6);
        let (native, context) = context(root.path());
        let args = json!({ "pattern": "needle", "syntax": "literal", "paths": &path, "retainMatchesRender": true });
        let first = execute(&args, &native.cache, &native.session, &context).unwrap();
        let origin = first.matches_render_cursor.clone().unwrap();
        // The same retained audit again, carrying the initial default allowance
        // the dispatcher permits: the origin deduplicates to one handle, the page
        // is unchanged (the allowance is refit-only), and the dataset every
        // cursor references must still be readable.
        let duplicate = execute(
            &json!({ "pattern": "needle", "syntax": "literal", "paths": &path, "retainMatchesRender": true }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert_eq!(
            duplicate.text, first.text,
            "an initial allowance does not resize an audit page"
        );
        assert_eq!(
            duplicate.matches_render_cursor.as_deref(),
            Some(origin.as_str()),
            "an identical retained audit yields the same origin"
        );
        let refit = execute(
            &json!({ "renderMatches": origin, "matchesRenderBytes": 16_000 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert!(refit.text.contains("6: needle 5"), "{}", refit.text);
        assert!(
            refit.structured["data"]["cursor"].is_null(),
            "a complete refit has no successor, which is exactly the case that must still keep origin ownership"
        );
        let again = execute(
            &json!({ "renderMatches": origin, "matchesRenderBytes": 16_000 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert_eq!(
            refit.text, again.text,
            "a complete refit must not delete the dataset its own origin replays"
        );
        // A nearby allowance keeps the same frozen output, and the origin still
        // answers after both refits.
        let nearby = execute(
            &json!({ "renderMatches": origin, "matchesRenderBytes": 15_000 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert_eq!(nearby.text, refit.text, "a nearby allowance changes nothing");
        assert_eq!(
            nearby.matches_render_cursor.as_deref(),
            Some(origin.as_str())
        );
    }

    #[test]
    fn private_origin_rejects_public_continuation_and_new_query() {
        let root = tempfile::tempdir().unwrap();
        // A page large enough to keep a public cursor for its undelivered rows.
        let path = retained_fixture(root.path(), 200);
        let (native, context) = context(root.path());
        let first = execute(
            &json!({ "pattern": "needle", "syntax": "literal", "paths": &path, "retainMatchesRender": true, "contextLines": 0 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        let origin = first.matches_render_cursor.clone().unwrap();
        let canonical = path.canonicalize().unwrap();
        let scans = stream_scan_count(&canonical);
        // The origin is private: an ordinary continuation must fail closed.
        let continued = execute(
            &json!({ "cursor": origin }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap_err();
        assert!(continued.contains("private"), "{continued}");
        // A replay cannot smuggle a new query, scope or context override.
        for rejected in [
            json!({ "renderMatches": origin, "pattern": "needle" }),
            json!({ "renderMatches": origin, "contextLines": 2 }),
            json!({ "renderMatches": origin, "paths": [path.to_string_lossy()] }),
        ] {
            let error = execute(&rejected, &native.cache, &native.session, &context).unwrap_err();
            assert!(error.contains("renderMatches accepts only"), "{error}");
        }
        // Only a retained origin can be replayed, and an unknown handle fails
        // closed instead of rescanning.
        let unknown = execute(
            &json!({ "renderMatches": "grep-000000000000000000000000" }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap_err();
        assert!(unknown.contains("unavailable or expired"), "{unknown}");
        assert_eq!(
            stream_scan_count(&canonical),
            scans,
            "rejected or unknown handles must fail closed without rescanning"
        );
        // An unretained audit exposes no origin, and a public page cursor is not
        // a replay handle.
        let public = execute(
            &json!({ "pattern": "needle", "syntax": "literal", "paths": &path, "contextLines": 0, "retainMatchesRender": true }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        let public_cursor = public
            .structured["data"]["cursor"]
            .as_str()
            .map(str::to_string)
            .expect("the unretained-size page keeps a cursor for its undelivered rows");
        let not_origin = execute(
            &json!({ "renderMatches": public_cursor }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap_err();
        assert!(
            not_origin.contains("requires a retained Matches render origin"),
            "{not_origin}"
        );
        assert_eq!(
            stream_scan_count(&canonical),
            scans + 1,
            "only the fresh public audit above scanned; the rejected replay did not"
        );
    }

    /// The retained origin owns the render source: the page, its successor and
    /// every replay read the canonical stored dataset, a duplicate audit cannot
    /// move that source, and a stale origin fails closed without rescanning or
    /// handing back a cursor.
    #[test]
    fn retained_origin_owns_the_render_source() {
        let root = tempfile::tempdir().unwrap();
        let path = retained_fixture(root.path(), 200);
        let (native, context) = context(root.path());
        let args = json!({ "pattern": "needle", "syntax": "literal", "paths": &path, "contextLines": 0, "retainMatchesRender": true });
        let first = execute(&args, &native.cache, &native.session, &context).unwrap();
        let origin = first.matches_render_cursor.clone().unwrap();
        let successor = first.structured["data"]["cursor"]
            .as_str()
            .map(str::to_string)
            .expect("a large audit keeps a public successor");
        let origin_state = native.session.get_cursor(&origin).unwrap();
        let successor_state = native.session.get_cursor(&successor).unwrap();
        let origin_dataset = origin_state["datasetPath"].as_str().unwrap().to_string();
        assert_eq!(
            origin_dataset,
            successor_state["datasetPath"].as_str().unwrap(),
            "the page and its successor must read the same canonical dataset"
        );
        assert!(
            Path::new(&origin_dataset).exists(),
            "the retained origin must own a live dataset"
        );
        // A duplicate audit deduplicates onto the same origin and must not move
        // the canonical source.
        let duplicate = execute(&args, &native.cache, &native.session, &context).unwrap();
        assert_eq!(duplicate.matches_render_cursor.as_deref(), Some(origin.as_str()));
        assert_eq!(
            native.session.get_cursor(&origin).unwrap()["datasetPath"]
                .as_str()
                .unwrap(),
            origin_dataset,
            "a duplicate audit must not repoint the canonical render source"
        );
        // The canonical source still renders for a refit.
        let refit = execute(
            &json!({ "renderMatches": origin, "matchesRenderBytes": 4_000 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap();
        assert!(refit.text.len() <= 4_000);
        // A stale origin fails closed: no rescan, no cursor, no fallback to the
        // incoming dataset.
        std::fs::remove_file(&origin_dataset).unwrap();
        let canonical_source = path.canonicalize().unwrap();
        let scans = stream_scan_count(&canonical_source);
        let stale = execute(
            &json!({ "renderMatches": origin, "matchesRenderBytes": 4_000 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap_err();
        assert!(stale.contains("dataset is unavailable or expired"), "{stale}");
        assert_eq!(
            stream_scan_count(&canonical_source),
            scans,
            "a stale origin must fail closed instead of rescanning"
        );
        assert!(
            native.session.get_cursor(&origin).is_some(),
            "the failed replay must not mint or drop a cursor"
        );
    }

    /// A widened `all` admission disables configurable ignores while keeping the
    /// owning-project boundary: marker children are never opened, and a marker
    /// that lands inside an admitted directory revokes it before a retained
    /// refit re-reads any source.
    #[test]
    fn all_visibility_admission_widens_ignores_and_keeps_owner_boundaries() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        for relative in [
            "src/allowed.ts",
            "src/ignored/hidden.ts",
            "src/sub/deep.ts",
            "src/child/hidden.ts",
            "src/git-child/hidden.ts",
        ] {
            let path = root.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "O6_ALL_TOKEN\n").unwrap();
        }
        std::fs::write(root.join("src/child/.pi-navigation.json"), "{}").unwrap();
        std::fs::create_dir(root.join("src/git-child/.git")).unwrap();
        // The compiled project policy still excludes src/ignored; `all` must not
        // apply it, because widened visibility disables configurable ignores.
        let admission = json!({
            "owners": [matches_owner(&root, &[])],
            "directories": { root.join("src").to_string_lossy().as_ref(): 0 },
            "explicitFiles": [],
            "allVisibility": true,
        });
        let (native, context) = context(&root);
        let args = json!({ "pattern": "O6_ALL_TOKEN", "syntax": "literal", "paths": [root.join("src")],
            "visibility": "all", "matchesAdmission": admission, "contextLines": 0, "retainMatchesRender": true });
        let output = execute(&args, &native.cache, &native.session, &context).unwrap();
        let rendered: Vec<_> = output.structured["data"]["groups"].as_array().unwrap().iter()
            .map(|group| {
                let path = Path::new(group["path"].as_str().unwrap());
                (if path.is_absolute() { path.to_path_buf() } else { context.root.join(path) }).canonicalize().unwrap()
            })
            .collect();
        for present in ["src/allowed.ts", "src/ignored/hidden.ts", "src/sub/deep.ts"] {
            assert!(rendered.contains(&root.join(present).canonicalize().unwrap()),
                "widened admission is missing {present}: {rendered:?}");
        }
        for denied in ["src/child/hidden.ts", "src/git-child/hidden.ts"] {
            let path = root.join(denied);
            assert_eq!(stream_scan_count(&path), 0, "opened {denied}");
            assert_eq!(source_read_count(&path), 0, "read {denied}");
        }
        // A marker inside a previously admitted directory revokes it: the refit
        // must refuse and must not touch the source it can no longer admit.
        let deep = root.join("src/sub/deep.ts");
        let reads_before = source_read_count(&deep);
        std::fs::write(root.join("src/sub/.pi-navigation.json"), "{}").unwrap();
        let origin = output.matches_render_cursor.clone().unwrap();
        let revoked = execute(
            &json!({ "renderMatches": origin, "matchesRenderBytes": 12_000 }),
            &native.cache,
            &native.session,
            &context,
        )
        .unwrap_err();
        assert!(revoked.contains("Matches directory admission changed"), "{revoked}");
        assert_eq!(source_read_count(&deep), reads_before, "a revoked refit must not re-read admitted source");
    }

    #[test]
    fn admission_visibility_must_match_the_request() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        std::fs::write(root.join("one.ts"), "TOKEN\n").unwrap();
        let (native, context) = context(&root);
        let directories = json!({ root.to_string_lossy().as_ref(): 0 });
        let project_admission = json!({ "owners": [matches_owner(&root, &[])], "directories": directories.clone(), "explicitFiles": [] });
        let widened_admission = json!({ "owners": [matches_owner(&root, &[])], "directories": directories, "explicitFiles": [], "allVisibility": true });
        let base = json!({ "pattern": "TOKEN", "syntax": "literal", "paths": [root.clone()], "contextLines": 0 });
        for (admission, visibility) in [(&project_admission, json!("all")), (&widened_admission, json!("project"))] {
            let mut args = base.clone();
            args["matchesAdmission"] = admission.clone();
            args["visibility"] = visibility.clone();
            let error = execute(&args, &native.cache, &native.session, &context).unwrap_err();
            assert!(error.contains("visibility does not match"), "{error}");
        }
        let mut accepted = base.clone();
        accepted["matchesAdmission"] = widened_admission;
        accepted["visibility"] = json!("all");
        assert!(execute(&accepted, &native.cache, &native.session, &context).is_ok());
    }
}
