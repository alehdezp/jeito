pub mod format;
pub mod matching;
pub mod overlay;
pub mod parse;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use rayon::prelude::*;

use crate::types::OutlineKind;

#[derive(Debug)]
pub enum DiffSource {
    GitUncommitted,
    GitStaged,
    GitRef(String),
    Files(PathBuf, PathBuf),
    Patch(PathBuf),
    Log(String),
}

#[derive(Debug)]
pub struct FileDiff {
    pub path: PathBuf,
    pub old_path: Option<PathBuf>,
    pub status: FileStatus,
    pub hunks: Vec<Hunk>,
    pub is_generated: bool,
    pub is_binary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug)]
pub struct Hunk {
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub content: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug)]
pub struct DiffSymbol {
    pub entry: crate::types::OutlineEntry,
    pub identity: SymbolIdentity,
    pub content_hash: u64,
    pub structural_hash: u64,
    pub source_text: String,
}

#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub struct SymbolIdentity {
    pub kind: OutlineKind,
    pub parent_path: String,
    pub name: String,
}

/// A declaration in one side of the comparison, not a current edit locator.
#[derive(Debug, Clone)]
pub struct SymbolSnapshot {
    pub identity: SymbolIdentity,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug)]
pub struct SymbolChange {
    pub name: String,
    pub kind: OutlineKind,
    pub change: ChangeType,
    pub match_confidence: MatchConfidence,
    pub line: u32,
    pub old_sig: Option<String>,
    pub new_sig: Option<String>,
    pub size_delta: Option<(u32, u32)>,
    pub old: Option<SymbolSnapshot>,
    pub new: Option<SymbolSnapshot>,
    pub diff_lines: Vec<DiffLine>,
}

#[derive(Debug, Clone)]
pub enum ChangeType {
    Added,
    Deleted,
    BodyChanged,
    SignatureChanged,
    Renamed { old_name: String },
    Moved { old_path: PathBuf },
    RenamedAndMoved { old_name: String, old_path: PathBuf },
    Unchanged,
}

#[derive(Debug)]
pub(crate) struct DiffFileFact {
    pub(crate) path: PathBuf,
    pub(crate) status: FileStatus,
}

#[derive(Debug)]
pub(crate) struct DiffSymbolFact {
    pub(crate) path: PathBuf,
    pub(crate) line: u32,
    pub(crate) end_line: u32,
    pub(crate) name: String,
    pub(crate) change: ChangeType,
    pub(crate) current_source: bool,
}

pub(crate) struct DiffOutput {
    pub(crate) text: String,
    pub(crate) files: Vec<DiffFileFact>,
    pub(crate) symbols: Vec<DiffSymbolFact>,
    pub(crate) review: Option<ReviewData>,
}

/// Captured comparison evidence only; neither current edit authority nor proof
/// that the surrounding project's resolution inputs match the after-state.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewSide {
    pub path: PathBuf,
    pub start: u32,
    pub end: u32,
    pub file_digest: Option<String>,
    pub name: Option<String>,
    pub parent: Option<String>,
    pub declaration: Vec<ReviewSourceLine>,
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct ReviewSourceLine {
    pub line: u32,
    pub content: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewChange {
    pub path: PathBuf,
    pub old_path: Option<PathBuf>,
    pub name: Option<String>,
    pub kind: String,
    pub old: Option<ReviewSide>,
    pub new: Option<ReviewSide>,
    pub lines: Vec<DiffLine>,
    pub note: Option<String>,
}

pub(crate) struct ReviewData {
    pub comparison: serde_json::Value,
    pub changes: Vec<ReviewChange>,
}

#[derive(Debug, Clone)]
pub enum MatchConfidence {
    Exact,
    Structural,
    Fuzzy(f32),
    Ambiguous(u32),
}

#[derive(Debug)]
pub struct FileOverlay {
    pub path: PathBuf,
    pub symbol_changes: Vec<SymbolChange>,
    pub old_path: Option<PathBuf>,
    pub unattributed_lines: Vec<DiffLine>,
    pub source_note: Option<String>,
    pub conflicts: Vec<Conflict>,
    pub new_content: Option<String>,
    pub old_content: Option<String>,
}

#[derive(Debug)]
pub struct Conflict {
    pub line: u32,
    pub ours: String,
    pub theirs: String,
    pub enclosing_fn: Option<String>,
}

#[derive(Debug)]
pub struct CommitSummary {
    pub hash: String,
    pub timestamp: i64,
    pub message: String,
    pub author: String,
    pub overlays: Vec<FileOverlay>,
}

/// Resolve the diff source from CLI/MCP parameters.
///
/// Priority: patch > log > a+b > source > default (uncommitted).
/// Returns an error if only one of `a` or `b` is provided.
pub fn resolve_source(
    source: Option<&str>,
    a: Option<&str>,
    b: Option<&str>,
    patch: Option<&str>,
    log: Option<&str>,
) -> Result<DiffSource, String> {
    if let Some(p) = patch {
        return Ok(DiffSource::Patch(PathBuf::from(p)));
    }
    if let Some(l) = log {
        return Ok(DiffSource::Log(l.to_string()));
    }
    match (a, b) {
        (Some(fa), Some(fb)) => return Ok(DiffSource::Files(PathBuf::from(fa), PathBuf::from(fb))),
        (Some(_), None) | (None, Some(_)) => {
            return Err("both --a and --b must be provided together".to_string());
        }
        (None, None) => {}
    }
    if let Some(s) = source {
        let ds = match s {
            "staged" => DiffSource::GitStaged,
            "uncommitted" | "working" => DiffSource::GitUncommitted,
            r => DiffSource::GitRef(r.to_string()),
        };
        return Ok(ds);
    }
    Ok(DiffSource::GitUncommitted)
}

/// Execute a git diff command and return raw unified diff output.
fn wait_child_output(
    mut child: std::process::Child,
    context: Option<&crate::dispatch::OperationContext>,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>), String> {
    let stdout = child.stdout.take().ok_or("child stdout was not piped")?;
    let stderr = child.stderr.take().ok_or("child stderr was not piped")?;
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut reader = stdout;
        std::io::Read::read_to_end(&mut reader, &mut bytes).map(|_| bytes)
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut reader = stderr;
        std::io::Read::read_to_end(&mut reader, &mut bytes).map(|_| bytes)
    });

    let status = loop {
        if let Some(context) = context {
            if let Err(error) = context.check() {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(error.to_string());
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(5)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("failed while waiting for git: {error}"));
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "git stdout reader panicked".to_string())?
        .map_err(|error| error.to_string())?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "git stderr reader panicked".to_string())?
        .map_err(|error| error.to_string())?;
    Ok((status, stdout, stderr))
}

fn run_git_diff(
    source: &DiffSource,
    scope: Option<&str>,
    context: Option<&crate::dispatch::OperationContext>,
) -> Result<String, String> {
    run_git_diff_with_base(source, scope, context, None)
}

fn run_git_diff_with_base(
    source: &DiffSource, scope: Option<&str>,
    context: Option<&crate::dispatch::OperationContext>, before_revision: Option<&str>,
) -> Result<String, String> {
    match source {
        DiffSource::Log(_) => return Err("log mode should not call run_git_diff directly".into()),
        DiffSource::Patch(path) => {
            let path = context.map_or_else(|| path.clone(), |context| context.root.join(path));
            return std::fs::read_to_string(path)
                .map_err(|error| format!("failed to read patch file: {error}"))
        }
        _ => {}
    }
    let mut command = Command::new("git");
    command.args(["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv",
        "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"]);
    if let Some(context) = context {
        command.current_dir(&context.root);
    }
    match source {
        DiffSource::GitUncommitted => {}
        DiffSource::GitStaged => {
            command.arg("--staged");
            if let Some(revision) = before_revision { command.arg(revision); }
        }
        DiffSource::GitRef(reference) => {
            command.arg("--end-of-options").arg(reference);
        }
        DiffSource::Files(left, right) => {
            command.arg("--no-index").arg("--").arg(left).arg(right);
        }
        DiffSource::Patch(_) | DiffSource::Log(_) => unreachable!(),
    }
    if !matches!(source, DiffSource::Files(_, _)) {
        if let Some(scope) = scope {
            let path = scope.split_once(':').map_or(scope, |(path, _)| path);
            command.arg("--").arg(path);
        }
    }
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = command
        .spawn()
        .map_err(|error| format!("failed to run git diff: {error}"))?;
    let (status, stdout, stderr) = wait_child_output(child, context)?;
    let expected_difference = matches!(source, DiffSource::Files(_, _)) && status.code() == Some(1);
    if !status.success() && !expected_difference {
        let reason = String::from_utf8_lossy(&stderr)
            .lines()
            .next()
            .unwrap_or("git diff failed")
            .to_string();
        return Err(reason);
    }
    String::from_utf8(stdout).map_err(|error| error.to_string())
}

/// Full diff orchestrator — parse → overlay → format pipeline.
pub fn diff(
    source: &DiffSource,
    scope: Option<&str>,
    search: Option<&str>,
    blast: bool,
    expand: usize,
    budget: Option<u64>,
) -> Result<String, String> {
    diff_typed(source, scope, search, blast, expand, budget, None).map(|output| output.text)
}

pub(crate) fn diff_typed(
    source: &DiffSource,
    scope: Option<&str>,
    search: Option<&str>,
    blast: bool,
    _expand: usize,
    budget: Option<u64>,
    context: Option<&crate::dispatch::OperationContext>,
) -> Result<DiffOutput, String> {
    diff_typed_inner(source, scope, search, blast, _expand, budget, context, false)
}

pub(crate) fn diff_review_typed(
    source: &DiffSource,
    scope: Option<&str>,
    search: Option<&str>,
    budget: Option<u64>,
    context: Option<&crate::dispatch::OperationContext>,
) -> Result<DiffOutput, String> {
    if matches!(source, DiffSource::Log(_)) {
        return Err("paired review does not support log mode".into());
    }
    diff_typed_inner(source, scope, search, false, 0, budget, context, true)
}

fn diff_typed_inner(
    source: &DiffSource, scope: Option<&str>, search: Option<&str>,
    blast: bool, _expand: usize, budget: Option<u64>,
    context: Option<&crate::dispatch::OperationContext>, review: bool,
) -> Result<DiffOutput, String> {
    if let Some(context) = context {
        context.check().map_err(|error| error.to_string())?;
    }
    if let DiffSource::Log(range) = source {
        return diff_log(range, scope, budget, context).map(|text| DiffOutput {
            text,
            files: Vec::new(),
            symbols: Vec::new(),
            review: None,
        });
    }
    let requested_source = source_label(source);
    let pinned = if review { pin_review_source(source, context)? } else { None };
    let source = pinned.as_ref().unwrap_or(source);
    let before_revision = if review && matches!(source, DiffSource::GitStaged) {
        Some(resolve_revision("HEAD", context)?)
    } else { None };
    let request_root = context.map_or_else(std::env::current_dir, |context| Ok(context.root.clone()))
        .and_then(std::fs::canonicalize).map_err(|error| error.to_string())?;
    let source_root = match source {
        DiffSource::GitUncommitted | DiffSource::GitStaged | DiffSource::GitRef(_) => repository_root(context)?,
        _ => request_root.clone(),
    };
    // Detect renames before applying a path filter: restricting Git to only
    // the destination hides the old path and turns a rename into an addition.
    let raw = run_git_diff_with_base(source, None, context, before_revision.as_deref())?;
    if raw.is_empty() {
        if let Some(scope) = scope {
            let path = scope.split_once(':').map_or(scope, |(path, _)| path);
            let root = context.map_or_else(
                || std::env::current_dir().unwrap_or_default(),
                |context| context.root.clone(),
            );
            if !root.join(path).exists() {
                return Err(format!("file '{path}' not found in diff"));
            }
        }
    }
    if raw.is_empty() {
        if review { return Ok(empty_review(source, &requested_source, &raw)); }
        return Ok(DiffOutput {
            text: "No changes.".into(),
            files: Vec::new(),
            symbols: Vec::new(),
            review: None,
        });
    }
    let mut file_diffs = parse::parse_unified_diff(&raw);
    if file_diffs.is_empty() {
        return Err("Structural diff unavailable: Git/patch output is not a supported unified file diff.".into());
    }
    if let Some(scope) = scope {
        if matches!(source, DiffSource::GitUncommitted | DiffSource::GitStaged | DiffSource::GitRef(_)) {
            let file = scope.split_once(':').map_or(scope, |(file, _)| file);
            let requested = request_path(&request_root.join(file), &request_root);
            file_diffs.retain(|diff| [&diff.path].into_iter().chain(diff.old_path.iter()).any(|path| {
                let path = request_path(&source_root.join(path), &request_root);
                requested.as_os_str().is_empty() || path == requested || path.starts_with(&requested)
            }));
            if file_diffs.is_empty() && !request_root.join(file).exists() {
                return Err(format!("file '{file}' not found in diff"));
            }
        }
    }
    if file_diffs.is_empty() {
        if review { return Ok(empty_review(source, &requested_source, &raw)); }
        return Ok(DiffOutput {
            text: "No changes.".into(),
            files: Vec::new(),
            symbols: Vec::new(),
            review: None,
        });
    }
    if let Some(context) = context {
        context.check().map_err(|error| error.to_string())?;
    }
    let mut overlays: Vec<FileOverlay> = file_diffs
        .par_iter()
        .map(|file| {
            overlay::compute_overlay_with_base(file, source, Some(&source_root), context, before_revision.as_deref(), review)
        })
        .collect::<Result<_, _>>()?;
    // Git headers/blob paths are repository-relative even when the request
    // starts in an extension. Display/typed paths must still address the file
    // from the request root; never join that root to Git's prefixed path twice.
    for (file, overlay) in file_diffs.iter_mut().zip(&mut overlays) {
        let absolute = match source {
            DiffSource::Files(_, b) => request_root.join(b),
            _ => source_root.join(&file.path),
        };
        file.path = request_path(&absolute, &request_root);
        overlay.path = file.path.clone();
        overlay.old_path = match source {
            DiffSource::Files(a, _) if review => Some(request_path(&request_root.join(a), &request_root)),
            _ => file.old_path.as_ref().map(|path| request_path(&source_root.join(path), &request_root)),
        };
    }
    overlay::cross_file_matching(&mut overlays);
    let mut warnings = overlay::signature_warnings(&overlays);
    // A directory scope is a filter over changed files, not a synthetic file
    // identity. Detect it from the diff paths themselves so deleted/ref-only
    // directories work even when no directory exists in the working tree.
    const EMPTY_SCOPE: &str = "";
    let directory_scope = scope
        .filter(|value| !value.contains(':'))
        .map(|value| value.trim_end_matches(['/', '\\']))
        .filter(|value| !value.is_empty())
        .filter(|value| {
            let prefix = request_path(&request_root.join(value), &request_root);
            overlays
                .iter()
                .flat_map(|overlay| std::iter::once(&overlay.path).chain(overlay.old_path.iter()))
                .any(|path| path != &prefix && (prefix.as_os_str().is_empty() || path.starts_with(&prefix)))
        })
        .unwrap_or(EMPTY_SCOPE);
    if !directory_scope.is_empty() {
        let prefix = request_path(&request_root.join(directory_scope), &request_root);
        overlays.retain(|overlay| std::iter::once(&overlay.path).chain(overlay.old_path.iter())
            .any(|path| prefix.as_os_str().is_empty() || path.starts_with(&prefix)));
    }
    if let Some(term) = search.filter(|_| !review) {
        filter_by_search(&mut overlays, term);
        if overlays.is_empty() {
            return Ok(DiffOutput {
                text: format!("No changes matching '{term}'."),
                files: Vec::new(),
                symbols: Vec::new(),
                review: None,
            });
        }
    }
    if blast {
        let mut blast_warnings =
            compute_blast(&overlays, context.map(|value| value.root.as_path()));
        warnings.append(&mut blast_warnings);
    }
    if let Some(context) = context {
        context.check().map_err(|error| error.to_string())?;
    }
    let file_meta: Vec<(&Path, bool, bool)> = overlays
        .iter()
        .map(|overlay| {
            let source = file_diffs.iter().find(|file| file.path == overlay.path);
            let (generated, binary) =
                source.map_or((false, false), |file| (file.is_generated, file.is_binary));
            (overlay.path.as_path(), generated, binary)
        })
        .collect();
    let label = source_label(source);
    let mut text = match scope {
        None => format::format_overview(&overlays, &file_meta, &warnings, &label, budget),
        Some(_) if !directory_scope.is_empty() => {
            format::format_overview(&overlays, &file_meta, &warnings, &label, budget)
        }
        Some(value) if value.contains(':') => {
            let (file_part, function) = value.split_once(':').expect("contains colon");
            let overlay = overlays
                .iter()
                .find(|overlay| overlay_matches_path(overlay, &request_path(&request_root.join(file_part), &request_root)))
                .ok_or_else(|| format!("file '{file_part}' not found in diff"))?;
            format::format_function_detail(overlay, function)
        }
        Some(file) => {
            let overlay = overlays
                .iter()
                .find(|overlay| overlay_matches_path(overlay, &request_path(&request_root.join(file), &request_root)))
                .ok_or_else(|| format!("file '{file}' not found in diff"))?;
            let binary = file_diffs
                .iter()
                .any(|item| item.path == overlay.path && item.is_binary);
            if binary {
                format!(
                    "# Diff: {} — binary content changed; textual line counts unavailable\n",
                    overlay.path.display()
                )
            } else {
                format::format_file_detail(overlay, budget)
            }
        }
    };
    if scope.is_some() && directory_scope.is_empty() {
        let position = text.find('\n').map_or(text.len(), |position| position + 1);
        text.insert_str(position, &format!("Comparison: {label}\n"));
        if let Some(budget) = budget { text = crate::budget::apply(&text, budget); }
    }
    if matches!(source, DiffSource::GitUncommitted) {
        let mut all_conflicts = Vec::new();
        for overlay in &overlays {
            let path = context.map_or_else(
                || overlay.path.clone(),
                |context| context.root.join(&overlay.path),
            );
            let conflicts = overlay::detect_conflicts(&path);
            if !conflicts.is_empty() {
                all_conflicts.push((&overlay.path, conflicts));
            }
        }
        for (path, conflicts) in &all_conflicts {
            text.push('\n');
            text.push_str(&format::format_conflicts(conflicts, path));
        }
        if !all_conflicts.is_empty() {
            if let Some(budget) = budget {
                text = crate::budget::apply(&text, budget);
            }
        }
    }
    let selected: Vec<_> = overlays.iter().filter(|overlay| {
        directory_scope != EMPTY_SCOPE || scope.is_none_or(|scope| {
            let file = scope.split_once(':').map_or(scope, |(file, _)| file);
            overlay_matches_path(overlay, &request_path(&request_root.join(file), &request_root))
        })
    }).collect();
    if review {
        let function = scope.and_then(|value| value.split_once(':').map(|(_, name)| name));
        let changes = review_changes(&selected, &file_diffs, function, search);
        // Ref names were resolved once. Detect changes to the mutable comparison
        // itself without borrowing a second set of source rows for this result.
        if raw != run_git_diff_with_base(source, None, context, before_revision.as_deref())? {
            return Err("comparison changed while collecting paired source".into());
        }
        let mut comparison = review_comparison(source, &requested_source, &raw);
        comparison["beforeRevision"] = serde_json::json!(before_revision);
        return Ok(DiffOutput {
            text: format!("Paired comparison: {requested_source}"), files: Vec::new(), symbols: Vec::new(),
            review: Some(ReviewData { comparison, changes }),
        });
    }
    let files = selected
        .iter()
        .map(|overlay| {
            let status = file_diffs
                .iter()
                .find(|file| file.path == overlay.path)
                .map_or(FileStatus::Modified, |file| file.status);
            DiffFileFact {
                path: overlay.path.clone(),
                status,
            }
        })
        .collect();
    let symbols = selected
        .iter()
        .flat_map(|overlay| {
            let function = scope.and_then(|value| value.split_once(':').map(|(_, name)| name));
            overlay
                .symbol_changes
                .iter()
                .filter(move |symbol| function.is_none_or(|name| symbol_matches_name(symbol, name)))
                .map(|symbol| DiffSymbolFact {
                    path: overlay.path.clone(),
                    line: symbol.line,
                    end_line: symbol_end_line(symbol),
                    name: symbol.name.clone(),
                    change: symbol.change.clone(),
                    current_source: symbol.new.is_some() && match source {
                        DiffSource::GitUncommitted | DiffSource::Files(_, _) => true,
                        DiffSource::GitRef(reference) => !reference.contains(".."),
                        _ => false,
                    },
                })
        })
        .collect();
    Ok(DiffOutput {
        text,
        files,
        symbols,
        review: None,
    })
}

fn source_digest(content: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn resolve_revision(reference: &str, context: Option<&crate::dispatch::OperationContext>) -> Result<String, String> {
    let reference = if reference.is_empty() { "HEAD" } else { reference };
    let (success, output, error) = run_git_capture(&[
        "rev-parse".into(), "--verify".into(), "--end-of-options".into(), format!("{reference}^{{commit}}"),
    ], context)?;
    let revision = output.trim();
    if !success || !matches!(revision.len(), 40 | 64) || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("cannot pin comparison revision: {}", error.trim()));
    }
    Ok(revision.into())
}

fn pin_review_source(source: &DiffSource, context: Option<&crate::dispatch::OperationContext>) -> Result<Option<DiffSource>, String> {
    let DiffSource::GitRef(reference) = source else { return Ok(None); };
    let pinned = if let Some((left, right)) = reference.split_once("...") {
        let left = resolve_revision(left, context)?;
        let right = resolve_revision(right, context)?;
        let (success, base, error) = run_git_capture(&["merge-base".into(), left, right.clone()], context)?;
        if !success { return Err(format!("cannot pin comparison merge base: {}", error.trim())); }
        format!("{}..{right}", base.trim())
    } else if let Some((left, right)) = reference.split_once("..") {
        format!("{}..{}", resolve_revision(left, context)?, resolve_revision(right, context)?)
    } else {
        resolve_revision(reference, context)?
    };
    Ok(Some(DiffSource::GitRef(pinned)))
}

fn review_comparison(source: &DiffSource, requested: &str, raw: &str) -> serde_json::Value {
    let after = match source {
        DiffSource::GitUncommitted => "working_tree",
        DiffSource::GitStaged => "index",
        DiffSource::GitRef(reference) if !reference.contains("..") => "working_tree",
        DiffSource::GitRef(_) => "commit",
        DiffSource::Files(_, _) => "file",
        _ => "unavailable",
    };
    serde_json::json!({
        "source": requested, "resolvedSource": source_label(source),
        "patchDigest": source_digest(raw), "afterSource": after,
        "currentSource": matches!(after, "working_tree" | "file"),
        "association": "captured_files_only",
        "limitation": "File digests identify captured bytes, not matching project membership or resolution inputs; comparison rows are not edit authority."
    })
}

fn empty_review(source: &DiffSource, requested: &str, raw: &str) -> DiffOutput {
    DiffOutput { text: "No changes.".into(), files: Vec::new(), symbols: Vec::new(),
        review: Some(ReviewData { comparison: review_comparison(source, requested, raw), changes: Vec::new() }) }
}

fn review_side(path: &Path, content: Option<&str>, snapshot: Option<&SymbolSnapshot>,
    rows: &[DiffLine], old: bool) -> Option<ReviewSide> {
    let coordinates = rows.iter().filter_map(|row| if old { row.old_line } else { row.new_line });
    let start = snapshot.map(|side| side.start_line).or_else(|| coordinates.clone().min());
    let end = snapshot.map(|side| side.end_line).or_else(|| coordinates.max());
    if content.is_none() && start.is_none() { return None; }
    let start = start.unwrap_or(1);
    let end = end.unwrap_or_else(|| content.map_or(0, |text| text.lines().count() as u32));
    let declaration = content.zip(snapshot).and_then(|(text, side)| {
        crate::search::scope::declaration_end_line(path, text, side.start_line, side.end_line)
            .map(|last| text.lines().enumerate().filter(|(index, _)| {
                let line = *index as u32 + 1;
                line >= side.start_line && line <= last
            }).map(|(index, line)| ReviewSourceLine { line: index as u32 + 1, content: line.into() }).collect())
    }).unwrap_or_default();
    Some(ReviewSide {
        path: path.to_path_buf(), start, end, file_digest: content.map(source_digest),
        name: snapshot.map(|side| side.identity.name.clone()),
        parent: snapshot.map(|side| side.identity.parent_path.clone()), declaration,
    })
}

fn review_changes(overlays: &[&FileOverlay], files: &[FileDiff], function: Option<&str>, search: Option<&str>) -> Vec<ReviewChange> {
    let mut units = Vec::new();
    for overlay in overlays {
        let old_path = overlay.old_path.as_deref().unwrap_or(&overlay.path);
        for symbol in overlay.symbol_changes.iter().filter(|symbol| {
            !matches!(symbol.change, ChangeType::Unchanged) && function.is_none_or(|name| symbol_matches_name(symbol, name))
        }) {
            let kind = match symbol.change {
                ChangeType::Added => "added", ChangeType::Deleted => "deleted", ChangeType::BodyChanged => "body_changed",
                ChangeType::SignatureChanged => "signature_changed", ChangeType::Renamed { .. } => "renamed",
                ChangeType::Moved { .. } => "moved", ChangeType::RenamedAndMoved { .. } => "renamed_and_moved",
                ChangeType::Unchanged => unreachable!(),
            };
            units.push(ReviewChange {
                path: overlay.path.clone(), old_path: overlay.old_path.clone(), name: Some(symbol.name.clone()), kind: kind.into(),
                old: review_side(old_path, overlay.old_content.as_deref(), symbol.old.as_ref(), &symbol.diff_lines, true)
                    .filter(|_| symbol.old.is_some()),
                new: review_side(&overlay.path, overlay.new_content.as_deref(), symbol.new.as_ref(), &symbol.diff_lines, false)
                    .filter(|_| symbol.new.is_some()),
                lines: symbol.diff_lines.clone(), note: Some(format!("Declaration correspondence: {:?}; not binding proof", symbol.match_confidence)),
            });
        }
        if function.is_none() && (overlay.unattributed_lines.iter().any(|line| line.kind != DiffLineKind::Context)
            || overlay.symbol_changes.iter().all(|symbol| matches!(symbol.change, ChangeType::Unchanged))) {
            let file = files.iter().find(|file| file.path == overlay.path);
            let note = overlay.source_note.clone().or_else(|| file.map(|file| {
                if file.is_binary { "Binary change; textual source unavailable".into() }
                else { format!("File-level {:?} change; no declaration attribution", file.status) }
            }));
            units.push(ReviewChange {
                path: overlay.path.clone(), old_path: overlay.old_path.clone(), name: None, kind: "file".into(),
                old: review_side(old_path, overlay.old_content.as_deref(), None, &overlay.unattributed_lines, true),
                new: review_side(&overlay.path, overlay.new_content.as_deref(), None, &overlay.unattributed_lines, false),
                lines: overlay.unattributed_lines.clone(), note,
            });
        }
    }
    if let Some(term) = search {
        let term = term.to_lowercase();
        units.retain(|unit| {
            unit.path.to_string_lossy().to_lowercase().contains(&term)
                || unit.old_path.as_ref().is_some_and(|path| path.to_string_lossy().to_lowercase().contains(&term))
                || unit.old.iter().chain(&unit.new).any(|side| {
                    format!("{}::{}", side.parent.as_deref().unwrap_or(""), side.name.as_deref().unwrap_or("")).to_lowercase().contains(&term)
                }) || unit.lines.iter().any(|line| line.kind != DiffLineKind::Context && line.content.to_lowercase().contains(&term))
        });
    }
    units
}

fn request_path(absolute: &Path, root: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {},
            std::path::Component::ParentDir => { normalized.pop(); },
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized.strip_prefix(root).unwrap_or(&normalized).to_path_buf()
}

fn overlay_matches_path(overlay: &FileOverlay, path: &Path) -> bool {
    overlay.path == path || overlay.old_path.as_deref() == Some(path)
}

fn repository_root(context: Option<&crate::dispatch::OperationContext>) -> Result<PathBuf, String> {
    let (success, stdout, stderr) = run_git_capture(&["rev-parse".into(), "--show-toplevel".into()], context)?;
    if !success { return Err(format!("cannot resolve Git root: {}", stderr.trim())); }
    std::fs::canonicalize(stdout.trim_end()).map_err(|error| format!("cannot resolve Git root: {error}"))
}

fn symbol_end_line(symbol: &SymbolChange) -> u32 {
    symbol.new.as_ref().or(symbol.old.as_ref()).map_or(symbol.line, |side| side.end_line)
}

fn symbol_matches_name(symbol: &SymbolChange, name: &str) -> bool {
    symbol.name == name || symbol.old.iter().chain(&symbol.new).any(|side| {
        side.identity.name == name || format!("{}::{}", side.identity.parent_path, side.identity.name) == name
    })
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/// Human-readable label for a diff source.
fn source_label(source: &DiffSource) -> String {
    match source {
        DiffSource::GitUncommitted => "uncommitted (index → working tree)".to_string(),
        DiffSource::GitStaged => "staged (HEAD → index)".to_string(),
        DiffSource::GitRef(r) => r.clone(),
        DiffSource::Files(a, b) => format!("{} vs {}", a.display(), b.display()),
        DiffSource::Patch(p) => format!("patch: {}", p.display()),
        DiffSource::Log(r) => format!("log: {r}"),
    }
}

/// Filter overlays to only symbols whose diff lines contain the search term
/// (case-insensitive substring match). Removes files with no matches.
fn filter_by_search(overlays: &mut Vec<FileOverlay>, term: &str) {
    let term = term.to_lowercase();
    overlays.retain_mut(|overlay| {
        overlay.symbol_changes.retain(|change| {
            change.old.iter().chain(&change.new).any(|side| {
                format!("{}::{}", side.identity.parent_path, side.identity.name).to_lowercase().contains(&term)
            }) || change.diff_lines.iter().any(|line| line.content.to_lowercase().contains(&term))
        });
        overlay.unattributed_lines.retain(|line| line.content.to_lowercase().contains(&term));
        // A source-unavailable patch cannot establish a symbol-search zero.
        !overlay.symbol_changes.is_empty() || !overlay.unattributed_lines.is_empty() || overlay.source_note.is_some()
    });
}

/// Find callers of signature-changed symbols and return warnings.
fn compute_blast(overlays: &[FileOverlay], root: Option<&Path>) -> Vec<String> {
    let sig_changed: HashSet<String> = overlays
        .iter()
        .flat_map(|o| o.symbol_changes.iter())
        .filter(|c| matches!(c.change, ChangeType::SignatureChanged))
        .map(|c| c.name.clone())
        .collect();

    if sig_changed.is_empty() {
        return Vec::new();
    }

    let scope = root.map_or_else(
        || std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        Path::to_path_buf,
    );
    let bloom = crate::index::bloom::BloomFilterCache::new();

    match crate::search::callers::find_callers_batch(
        &sig_changed,
        &scope,
        &bloom,
        None,
        crate::search::callers::BATCH_EARLY_QUIT,
    ) {
        Ok(matches) => {
            let mut counts: std::collections::HashMap<String, usize> =
                std::collections::HashMap::new();
            for (target, _) in &matches {
                *counts.entry(target.clone()).or_default() += 1;
            }
            counts
                .into_iter()
                .map(|(name, count)| {
                    format!(
                        "blast: `{name}` signature changed — {count} caller{} may need updating",
                        if count == 1 { "" } else { "s" }
                    )
                })
                .collect()
        }
        Err(_) => Vec::new(),
    }
}

fn run_git_capture(
    args: &[String],
    context: Option<&crate::dispatch::OperationContext>,
) -> Result<(bool, String, String), String> {
    run_git_capture_at(args, context.map(|context| context.root.as_path()), context)
}

fn run_git_capture_at(
    args: &[String],
    root: Option<&Path>,
    context: Option<&crate::dispatch::OperationContext>,
) -> Result<(bool, String, String), String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(root) = root {
        command.current_dir(root);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("failed to run git: {error}"))?;
    let (status, stdout, stderr) = wait_child_output(child, context)?;
    Ok((
        status.success(),
        String::from_utf8(stdout).map_err(|error| error.to_string())?,
        String::from_utf8(stderr).map_err(|error| error.to_string())?,
    ))
}

/// Log mode pipeline: run per-commit diffs and format as commit summaries.
fn diff_log(
    range: &str,
    scope: Option<&str>,
    budget: Option<u64>,
    context: Option<&crate::dispatch::OperationContext>,
) -> Result<String, String> {
    let args = vec![
        "log".into(),
        "--format=%H %at %s%x00%an".into(),
        "--end-of-options".into(),
        range.into(),
    ];
    let (success, stdout, stderr) = run_git_capture(&args, context)?;
    if !success {
        return Err(format!("git log failed: {stderr}"));
    }
    let mut summaries: Vec<CommitSummary> = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Format: "<hash> <timestamp> <subject>\0<author>"
        let Some((rest, author)) = line.split_once('\0') else {
            continue;
        };

        let mut parts = rest.splitn(3, ' ');
        let Some(hash) = parts.next() else {
            continue;
        };
        let timestamp: i64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let message = parts.next().unwrap_or("").to_string();

        // Run diff for this commit.
        let ref_str = format!("{hash}^..{hash}");
        let commit_source = DiffSource::GitRef(ref_str);
        let raw = run_git_diff(&commit_source, scope, context)?;
        let file_diffs = parse::parse_unified_diff(&raw);

        let source_root = repository_root(context)?;
        let mut overlays: Vec<FileOverlay> = file_diffs
            .iter()
            .map(|fd| {
                overlay::compute_overlay(
                    fd,
                    &commit_source,
                    Some(&source_root),
                    context,
                )
            })
            .collect::<Result<_, _>>()?;
        overlay::cross_file_matching(&mut overlays);

        summaries.push(CommitSummary {
            hash: hash.to_string(),
            timestamp,
            message,
            author: author.to_string(),
            overlays,
        });
    }

    // Filter by scope if set.
    if let Some(file_scope) = scope {
        for summary in &mut summaries {
            summary.overlays.retain(|o| {
                let p = o.path.to_string_lossy();
                p == file_scope || p.ends_with(file_scope)
            });
        }
        summaries.retain(|s| !s.overlays.is_empty());
    }

    if summaries.is_empty() {
        return Ok("No commits found.".to_string());
    }

    Ok(format::format_log(&summaries, range, budget))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::sync::Mutex;

    fn paired_review(root: &Path, arguments: serde_json::Value) -> crate::output::ToolOutput {
        let session = crate::dispatch::NativeSession::new(root, false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(&session, crate::dispatch::ReadFormat::Plain, true);
        let mut arguments = arguments;
        arguments["review"] = serde_json::json!(true);
        crate::ops::tool_diff_output(&arguments, Some(&context)).unwrap()
    }

    #[test]
    fn paired_review_keeps_separated_deltas_and_complete_headers_from_captured_sides() {
        let dir = setup_test_repo();
        let path = dir.path().join("src/main.rs");
        let old = format!("use old::Thing;\n\nfn changed(\n    value: i32,\n) -> i32 {{\n    let first = 1;\n{}    first + value\n}}\n", "    // retained context\n".repeat(15));
        let new = old.replace("old::Thing", "new::Thing").replace("let first = 1", "let first = 2").replace("first + value", "first - value");
        fs::write(&path, &old).unwrap();
        git(dir.path(), &["add", "."]);
        fs::write(&path, &new).unwrap();
        let output = paired_review(dir.path(), serde_json::json!({"source":"uncommitted", "search":"changed"}));
        let data = &output.structured["data"];
        let changes = data["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1);
        let unit = &changes[0];
        assert_eq!(unit["old"]["fileDigest"], source_digest(&old));
        assert_eq!(unit["new"]["fileDigest"], source_digest(&new));
        assert_eq!(unit["old"]["start"], 3);
        let declaration = unit["new"]["declaration"].as_array().unwrap();
        assert_eq!(declaration.iter().map(|row| row["content"].as_str().unwrap()).collect::<Vec<_>>(),
            vec!["fn changed(", "    value: i32,", ") -> i32 {"]);
        let rows = unit["lines"].as_array().unwrap();
        for (kind, content, old_line, new_line) in [
            ("removed", "    let first = 1;", Some(6), None),
            ("added", "    let first = 2;", None, Some(6)),
            ("removed", "    first + value", Some(22), None),
            ("added", "    first - value", None, Some(22)),
        ] {
            assert!(rows.iter().any(|row| row["kind"] == kind && row["content"] == content
                && row["oldLine"] == serde_json::json!(old_line) && row["newLine"] == serde_json::json!(new_line)), "{unit}");
        }
        assert_eq!(data["comparison"]["afterSource"], "working_tree");
        assert_eq!(data["comparison"]["association"], "captured_files_only");
        assert_eq!(data["changesCompleteness"]["complete"], true);
    }

    #[test]
    fn paired_review_search_keeps_import_counterpart_and_before_path() {
        let dir = setup_test_repo();
        let path = dir.path().join("src/main.rs");
        let old = format!("use old::Thing;\n{}", fs::read_to_string(&path).unwrap());
        fs::write(&path, &old).unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-m", "import"]);
        git(dir.path(), &["mv", "src/main.rs", "src/renamed.rs"]);
        fs::write(dir.path().join("src/renamed.rs"), old.replace("old::Thing", "new::Thing")).unwrap();
        git(dir.path(), &["add", "."]);
        for search in ["new::Thing", "src/main.rs"] {
            let output = paired_review(dir.path(), serde_json::json!({"source":"staged", "search":search}));
            let changes = output.structured["data"]["changes"].as_array().unwrap();
            assert_eq!(changes.len(), 1);
            assert_eq!(changes[0]["oldPath"], "src/main.rs");
            let lines = changes[0]["lines"].to_string();
            assert!(lines.contains("use old::Thing;") && lines.contains("use new::Thing;"), "{lines}");
        }
    }

    #[test]
    fn paired_review_index_and_committed_sides_never_borrow_worktree_bytes() {
        let dir = setup_test_repo();
        let path = dir.path().join("src/main.rs");
        let head = fs::read_to_string(&path).unwrap();
        let index = head.replace("println!(\"hello\")", "println!(\"INDEX\")");
        fs::write(&path, &index).unwrap();
        git(dir.path(), &["add", "."]);
        fs::write(&path, index.replace("INDEX", "WORKTREE")).unwrap();
        let staged = paired_review(dir.path(), serde_json::json!({"source":"staged", "search":"hello"}));
        assert_eq!(staged.structured["data"]["changes"][0]["new"]["fileDigest"], source_digest(&index));
        assert_eq!(staged.structured["data"]["comparison"]["afterSource"], "index");
        assert_eq!(staged.structured["data"]["comparison"]["currentSource"], false);
        assert_eq!(staged.structured["data"]["comparison"]["beforeRevision"], git(dir.path(), &["rev-parse", "HEAD"]).trim());
        assert!(!staged.structured["data"].to_string().contains("WORKTREE"));
        git(dir.path(), &["commit", "-m", "indexed"]);
        let historical = paired_review(dir.path(), serde_json::json!({"source":"HEAD~1..HEAD", "search":"hello"}));
        let comparison = &historical.structured["data"]["comparison"];
        assert_eq!(comparison["afterSource"], "commit");
        assert!(!comparison["resolvedSource"].as_str().unwrap().contains("HEAD"));
        assert_eq!(historical.structured["data"]["changes"][0]["new"]["fileDigest"], source_digest(&index));
        assert!(!historical.structured["data"].to_string().contains("WORKTREE"));
    }

    #[test]
    fn paired_review_direct_paths_and_added_deleted_sides_are_explicit() {
        let dir = setup_test_repo();
        fs::write(dir.path().join("before.rs"), "fn x() { old(); }\n").unwrap();
        fs::write(dir.path().join("after.rs"), "fn x() { new(); }\n").unwrap();
        let direct = paired_review(dir.path(), serde_json::json!({"a":"before.rs", "b":"after.rs"}));
        let unit = &direct.structured["data"]["changes"][0];
        assert_eq!(unit["old"]["path"], "before.rs");
        assert_eq!(unit["new"]["path"], "after.rs");
        fs::remove_file(dir.path().join("src/main.rs")).unwrap();
        let deleted = paired_review(dir.path(), serde_json::json!({"scope":"src/main.rs"}));
        assert!(deleted.structured["data"]["changes"].as_array().unwrap().iter().any(|unit| unit["kind"] == "deleted"));
        for change in deleted.structured["data"]["changes"].as_array().unwrap().iter().filter(|unit| unit["kind"] == "deleted") {
            assert!(change["new"].is_null());
            assert!(change["old"]["fileDigest"].is_string());
        }
        fs::write(dir.path().join("added.rs"), "fn added() {}\n").unwrap();
        git(dir.path(), &["add", "added.rs"]);
        let added = paired_review(dir.path(), serde_json::json!({"source":"staged", "scope":"added.rs"}));
        assert!(added.structured["data"]["changes"][0]["old"].is_null());
        assert!(added.structured["data"]["changes"][0]["new"]["fileDigest"].is_string());
    }

    #[test]
    fn paired_review_transport_omits_whole_units_but_keeps_affordable_successors() {
        let dir = setup_test_repo();
        let path = dir.path().join("src/main.rs");
        fs::write(&path, format!("fn huge() {{\n    old(\"{}\");\n}}\nfn small() {{ old(); }}\n", "x".repeat(140_000))).unwrap();
        git(dir.path(), &["add", "."]);
        let old = fs::read_to_string(&path).unwrap();
        fs::write(&path, old.replace("old(", "new(")).unwrap();
        let output = paired_review(dir.path(), serde_json::json!({}));
        let data = &output.structured["data"];
        assert_eq!(data["changesCompleteness"]["total"], 2);
        assert_eq!(data["changesCompleteness"]["returned"], 1);
        assert_eq!(data["changesCompleteness"]["omitted"], 1);
        assert_eq!(data["changes"][0]["name"], "small");
        assert_eq!(data["changes"][0]["lines"].as_array().unwrap().iter().filter(|row| row["kind"] != "context").count(), 2);
        assert_eq!(output.structured["completeness"]["complete"], false);
        assert!(serde_json::to_vec(&output.structured).unwrap().len() < 128 * 1024);
    }

    #[test]
    fn paired_review_unattributed_changes_keep_both_sides_and_empty_selection_is_honest() {
        let dir = setup_test_repo();
        let path = dir.path().join("settings.cfg");
        fs::write(&path, "mode=old\nkeep=true\n").unwrap();
        git(dir.path(), &["add", "."]);
        fs::write(&path, "mode=new\nkeep=true\n").unwrap();
        let output = paired_review(dir.path(), serde_json::json!({"search":"mode=new"}));
        let changes = output.structured["data"]["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0]["kind"], "file");
        assert!(changes[0]["name"].is_null());
        assert!(changes[0]["lines"].as_array().unwrap().iter().any(|row| row["kind"] == "removed" && row["content"] == "mode=old"));
        assert!(changes[0]["lines"].as_array().unwrap().iter().any(|row| row["kind"] == "added" && row["content"] == "mode=new"));
        let empty = paired_review(dir.path(), serde_json::json!({"search":"not-present"}));
        assert_eq!(empty.structured["data"]["changesCompleteness"]["total"], 0);
        assert_eq!(empty.structured["data"]["changesCompleteness"]["complete"], true);
    }

    #[test]
    fn deleted_and_renamed_files_preserve_before_source_without_current_leads() {
        let dir = setup_test_repo();
        let path = dir.path().join("src/main.rs");
        let old = fs::read_to_string(&path).unwrap();
        git(dir.path(), &["mv", "src/main.rs", "src/renamed.rs"]);
        fs::write(dir.path().join("src/renamed.rs"), old.replace("    println!(\"hello\");\n", "")).unwrap();
        git(dir.path(), &["add", "."]);
        let session = crate::dispatch::NativeSession::new(dir.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(&session, crate::dispatch::ReadFormat::Plain, true);
        let renamed = diff_typed(&DiffSource::GitStaged, None, None, false, 0, None, Some(&context)).unwrap();
        assert_eq!(renamed.files.len(), 1);
        assert_eq!(renamed.files[0].status, FileStatus::Renamed);
        assert!(renamed.text.contains("BEFORE path: src/main.rs"), "{}", renamed.text);
        let detail = diff_typed(&DiffSource::GitStaged, Some("src/renamed.rs"), Some("hello"), false, 0, None, Some(&context)).unwrap();
        assert!(detail.text.contains("- old 2|     println!(\"hello\");"), "{}", detail.text);
        assert!(detail.symbols.iter().all(|symbol| !symbol.current_source));
        let old_path_detail = diff_typed(&DiffSource::GitStaged, Some("src/main.rs"), Some("hello"), false, 0, None, Some(&context)).unwrap();
        assert_eq!(detail.text, old_path_detail.text);
        git(dir.path(), &["commit", "-m", "rename"]);
        fs::remove_file(dir.path().join("src/renamed.rs")).unwrap();
        let deleted = crate::ops::tool_diff_output(&serde_json::json!({"scope":"src/renamed.rs"}), Some(&context)).unwrap();
        assert!(!deleted.structured["data"]["symbols"].as_array().unwrap().is_empty());
        assert!(deleted.structured["data"]["locations"].as_array().unwrap().is_empty());
        assert!(deleted.text.contains("- old 1| fn hello() {"), "{}", deleted.text);
        // A new indexed file has no HEAD side; that is an expected absence,
        // unlike a failed required-source read.
        fs::write(dir.path().join("added.rs"), "fn added() {}\n").unwrap();
        git(dir.path(), &["add", "added.rs"]);
        let added = diff_typed(&DiffSource::GitStaged, Some("added.rs"), None, false, 0, None, Some(&context)).unwrap();
        assert!(added.text.contains("+ new 1| fn added() {}"), "{}", added.text);
        assert!(!added.text.contains("BEFORE: added"), "{}", added.text);
    }

    #[test]
    fn temporal_diff_keeps_removed_rows_and_separated_hunk_coordinates() {
        let dir = setup_test_repo();
        let path = dir.path().join("src/main.rs");
        let mut old = String::from("fn changed() {\n");
        for index in 0..30 { old.push_str(&format!("    let value_{index} = {index};\n")); }
        old.push_str("}\n");
        fs::write(&path, &old).unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-m", "long function"]);
        let new = format!("// prefix one\n// prefix two\n{}", old
            .replace("    let value_1 = 1;\n", "")
            .replace("    let value_20 = 20;", "    let value_20 = 200;")
            .replace("    let value_29 = 29;", "    let value_29 = 290;"));
        fs::write(&path, &new).unwrap();
        let session = crate::dispatch::NativeSession::new(dir.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(&session, crate::dispatch::ReadFormat::Plain, true);
        let raw = run_git_diff(&DiffSource::GitUncommitted, None, Some(&context)).unwrap();
        let files = parse::parse_unified_diff(&raw);
        assert!(files[0].hunks.len() >= 2, "fixture must exercise separated hunks");
        let result = diff_typed(&DiffSource::GitUncommitted, Some("src/main.rs"), Some("changed"), false, 0, None, Some(&context)).unwrap();
        assert!(result.text.contains("+2/−3 lines"), "{}", result.text);
        for (marker, content, source) in [
            ("- old", "    let value_1 = 1;", &old),
            ("- old", "    let value_20 = 20;", &old),
            ("+ new", "    let value_20 = 200;", &new),
            ("- old", "    let value_29 = 29;", &old),
            ("+ new", "    let value_29 = 290;", &new),
        ] {
            let line = source.lines().position(|line| line == content).unwrap() + 1;
            assert!(result.text.contains(&format!("{marker} {line}| {content}")), "{}", result.text);
        }
        assert!(result.text.contains("BEFORE: changed (L1-32)"), "{}", result.text);
        assert!(result.text.contains("AFTER: changed (L3-33)"), "{}", result.text);
    }

    #[test]
    fn same_named_methods_keep_parent_identity_and_independent_rows() {
        let dir = setup_test_repo();
        let path = dir.path().join("methods.ts");
        let old = "class A {\n  run() {\n    return 'OLD_A';\n  }\n}\nclass B {\n  run() {\n    return 'OLD_B';\n  }\n}\n";
        fs::write(&path, old).unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-m", "methods"]);
        fs::write(&path, old.replace("OLD_A", "NEW_A").replace("OLD_B", "NEW_B")).unwrap();
        let session = crate::dispatch::NativeSession::new(dir.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(&session, crate::dispatch::ReadFormat::Plain, true);
        let files = parse::parse_unified_diff(&run_git_diff(&DiffSource::GitUncommitted, Some("methods.ts"), Some(&context)).unwrap());
        let overlay = overlay::compute_overlay(&files[0], &DiffSource::GitUncommitted, Some(dir.path()), Some(&context)).unwrap();
        let methods: Vec<_> = overlay.symbol_changes.iter().filter(|change| change.name == "run").collect();
        assert_eq!(methods.len(), 2);
        for method in methods {
            let parent = &method.old.as_ref().unwrap().identity.parent_path;
            let other = if parent == "A" { "B" } else { "A" };
            assert!(method.diff_lines.iter().any(|line| line.content.contains(&format!("OLD_{parent}"))));
            assert!(!method.diff_lines.iter().any(|line| line.content.contains(&format!("OLD_{other}"))));
        }
        let output = format::format_function_detail(&overlay, "run");
        assert!(output.contains("A::run") && output.contains("B::run"), "{output}");
        assert!(output.contains("+2/−2 lines"), "{output}");
        let file_output = format::format_file_detail(&overlay, None);
        assert!(file_output.contains("+2/−2 lines"), "{file_output}");
        assert_eq!(file_output.matches("|     return 'OLD_A';").count(), 1, "{file_output}");
        let focused = format::format_function_detail(&overlay, "A::run");
        assert!(focused.contains("OLD_A") && !focused.contains("OLD_B"), "{focused}");
    }

    #[test]
    fn staged_unstaged_and_subdirectory_requests_use_the_actual_sides() {
        let dir = setup_test_repo();
        let path = dir.path().join("src/main.rs");
        let head = fs::read_to_string(&path).unwrap();
        let index = head.replace("hello\");", "INDEX\");");
        let worktree = index.replace("INDEX", "WORKTREE");
        fs::write(&path, &index).unwrap();
        git(dir.path(), &["add", "src/main.rs"]);
        fs::write(&path, &worktree).unwrap();
        let run = |root: &Path, scope: &str, source: &str| {
            let session = crate::dispatch::NativeSession::new(root, false).unwrap();
            let context = crate::dispatch::OperationContext::for_session(&session, crate::dispatch::ReadFormat::Plain, true);
            crate::ops::tool_diff_output(&serde_json::json!({"source":source,"scope":scope,"search":"hello"}), Some(&context)).unwrap()
        };
        let root = run(dir.path(), "src/main.rs", "uncommitted");
        let nested = run(&dir.path().join("src"), "main.rs", "uncommitted");
        assert!(root.text.contains("INDEX") && root.text.contains("WORKTREE"), "{}", root.text);
        assert_eq!(root.text.replace("src/main.rs", "main.rs"), nested.text);
        assert_eq!(nested.structured["data"]["files"][0]["path"], "main.rs");
        assert!(!nested.structured["data"]["locations"].as_array().unwrap().is_empty());
        let staged = run(dir.path(), "src/main.rs", "staged");
        assert!(staged.text.contains("INDEX") && !staged.text.contains("WORKTREE"), "{}", staged.text);
        assert!(staged.text.contains("println!(\"hello\")"), "{}", staged.text);
        assert!(staged.structured["data"]["locations"].as_array().unwrap().is_empty(), "historical rows must not become current source leads");
    }

    #[test]
    fn three_dot_uses_merge_base_not_left_tip_or_worktree() {
        let dir = setup_test_repo();
        let path = dir.path().join("src/main.rs");
        let base = fs::read_to_string(&path).unwrap();
        let base_ref = git(dir.path(), &["rev-parse", "HEAD"]).trim().to_string();
        git(dir.path(), &["checkout", "-b", "left"]);
        fs::write(&path, base.replace("println!(\"hello\")", "println!(\"LEFT\")")).unwrap();
        git(dir.path(), &["commit", "-am", "left"]);
        git(dir.path(), &["checkout", "-b", "right", &base_ref]);
        fs::write(&path, base.replace("println!(\"hello\")", "println!(\"RIGHT\")")).unwrap();
        git(dir.path(), &["commit", "-am", "right"]);
        fs::write(&path, "fn not_the_compared_version() {}\n").unwrap();
        let session = crate::dispatch::NativeSession::new(dir.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(&session, crate::dispatch::ReadFormat::Plain, true);
        let compare = |reference: &str| diff_typed(&DiffSource::GitRef(reference.into()), Some("src/main.rs"), Some("hello"), false, 0, None, Some(&context)).unwrap();
        let three = compare("left...right");
        assert!(three.text.contains("println!(\"hello\")") && three.text.contains("RIGHT"), "{}", three.text);
        assert!(!three.text.contains("LEFT") && !three.text.contains("not_the_compared_version"), "{}", three.text);
        assert!(three.symbols.iter().all(|symbol| !symbol.current_source));
        let two = compare("left..right");
        assert!(two.text.contains("LEFT") && two.text.contains("RIGHT"), "{}", two.text);
        let omitted = compare("left...");
        assert_eq!(three.text.replace("Comparison: left...right", "Comparison: left..."), omitted.text);
    }

    /// Mutex to serialize tests that change process cwd.
    static CWD_LOCK: Mutex<()> = Mutex::new(());

    /// Create a test git repo with an initial commit containing a Rust file.
    fn setup_test_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("failed to create tempdir");
        let p = dir.path();

        git(p, &["init"]);
        git(p, &["config", "user.email", "test@test.com"]);
        git(p, &["config", "user.name", "Test"]);

        let src = p.join("src");
        fs::create_dir_all(&src).unwrap();

        let main_rs = src.join("main.rs");
        fs::write(
            &main_rs,
            "fn hello() {\n    println!(\"hello\");\n}\n\nfn goodbye() {\n    println!(\"bye\");\n}\n\nfn main() {\n    hello();\n    goodbye();\n}\n",
        )
        .unwrap();

        git(p, &["add", "-A"]);
        git(p, &["commit", "-m", "initial"]);

        dir
    }

    /// Run a git command in the given directory.
    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@test.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@test.com")
            .output()
            .expect("failed to run git");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// Run `diff()` from within the test repo directory, serialized via `CWD_LOCK`.
    fn run_diff_in(
        dir: &Path,
        source: &DiffSource,
        scope: Option<&str>,
        search: Option<&str>,
        blast: bool,
        budget: Option<u64>,
    ) -> Result<String, String> {
        let _lock = CWD_LOCK.lock().unwrap();
        let prev = std::env::current_dir().unwrap();
        std::env::set_current_dir(dir).unwrap();
        let result = diff(source, scope, search, blast, 0, budget);
        std::env::set_current_dir(&prev).unwrap();
        result
    }

    // 1. test_empty_diff
    #[test]
    fn test_empty_diff() {
        let dir = setup_test_repo();
        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert_eq!(result, "No changes.");
    }

    // 2. test_overview_modified
    #[test]
    fn test_overview_modified() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        let content = fs::read_to_string(&main_rs).unwrap();
        fs::write(
            &main_rs,
            content.replace("println!(\"hello\")", "println!(\"hi there\")"),
        )
        .unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert!(result.contains("[~]"), "expected [~] marker in:\n{result}");
    }

    // 3. test_overview_added
    #[test]
    fn test_overview_added() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        let mut content = fs::read_to_string(&main_rs).unwrap();
        content.push_str("\nfn new_function() {\n    println!(\"new\");\n}\n");
        fs::write(&main_rs, content).unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert!(result.contains("[+]"), "expected [+] marker in:\n{result}");
    }

    // 4. test_overview_deleted
    #[test]
    fn test_overview_deleted() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        // Remove the goodbye function entirely.
        fs::write(
            &main_rs,
            "fn hello() {\n    println!(\"hello\");\n}\n\nfn main() {\n    hello();\n}\n",
        )
        .unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert!(result.contains("[-]"), "expected [-] marker in:\n{result}");
    }

    // 5. test_overview_signature_changed
    #[test]
    fn test_overview_signature_changed() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        let content = fs::read_to_string(&main_rs).unwrap();
        // Change hello() to hello(name: &str)
        let new_content = content
            .replace("fn hello() {", "fn hello(name: &str) {")
            .replace("println!(\"hello\")", "println!(\"hello {}\", name)")
            .replace("hello();", "hello(\"world\");");
        fs::write(&main_rs, new_content).unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert!(
            result.contains("[~:sig]"),
            "expected [~:sig] marker in:\n{result}"
        );
    }

    // 6. test_file_detail_scope
    #[test]
    fn test_file_detail_scope() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        let content = fs::read_to_string(&main_rs).unwrap();
        fs::write(
            &main_rs,
            content.replace("println!(\"hello\")", "println!(\"hi\")"),
        )
        .unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            Some("src/main.rs"),
            None,
            false,
            None,
        )
        .unwrap();
        assert!(
            result.contains("# Diff: src/main.rs"),
            "expected file detail header in:\n{result}"
        );
        assert!(
            result.contains("symbols touched"),
            "expected symbols touched in:\n{result}"
        );
    }

    // 7. test_function_detail_scope
    #[test]
    fn test_function_detail_scope() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        let content = fs::read_to_string(&main_rs).unwrap();
        fs::write(
            &main_rs,
            content.replace("println!(\"hello\")", "println!(\"hi\")"),
        )
        .unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            Some("src/main.rs:hello"),
            None,
            false,
            None,
        )
        .unwrap();
        assert!(
            result.contains("hello"),
            "expected hello function in:\n{result}"
        );
    }

    // 8. test_staged_diff
    #[test]
    fn test_staged_diff() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        let content = fs::read_to_string(&main_rs).unwrap();
        fs::write(
            &main_rs,
            content.replace("println!(\"hello\")", "println!(\"staged\")"),
        )
        .unwrap();
        git(dir.path(), &["add", "src/main.rs"]);

        let result =
            run_diff_in(dir.path(), &DiffSource::GitStaged, None, None, false, None).unwrap();
        assert!(
            result.contains("main.rs") || result.contains("[~]"),
            "expected staged changes in:\n{result}"
        );
    }

    // 9. test_ref_diff
    #[test]
    fn test_ref_diff() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        let content = fs::read_to_string(&main_rs).unwrap();
        fs::write(
            &main_rs,
            content.replace("println!(\"hello\")", "println!(\"ref\")"),
        )
        .unwrap();
        git(dir.path(), &["add", "-A"]);
        git(dir.path(), &["commit", "-m", "change hello"]);

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitRef("HEAD~1..HEAD".to_string()),
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert!(
            result.contains("main.rs"),
            "expected main.rs in ref diff:\n{result}"
        );
    }

    // 10. test_generated_file
    #[test]
    fn test_generated_file() {
        let dir = setup_test_repo();
        let lock = dir.path().join("package-lock.json");
        fs::write(&lock, "{}").unwrap();
        git(dir.path(), &["add", "-A"]);
        git(dir.path(), &["commit", "-m", "add lock"]);

        fs::write(&lock, "{ \"version\": 2 }").unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert!(
            result.contains("generated"),
            "expected 'generated' in:\n{result}"
        );
    }

    // 11. test_multiple_files
    #[test]
    fn test_multiple_files() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        let content = fs::read_to_string(&main_rs).unwrap();
        fs::write(
            &main_rs,
            content.replace("println!(\"hello\")", "println!(\"hi\")"),
        )
        .unwrap();

        let lib_rs = dir.path().join("src/lib.rs");
        fs::write(&lib_rs, "pub fn lib_fn() {\n    42\n}\n").unwrap();
        git(dir.path(), &["add", "src/lib.rs"]);
        git(dir.path(), &["commit", "-m", "add lib"]);
        fs::write(&lib_rs, "pub fn lib_fn() {\n    99\n}\n").unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert!(result.contains("main.rs"), "expected main.rs in:\n{result}");
        assert!(result.contains("lib.rs"), "expected lib.rs in:\n{result}");
        assert!(
            result.contains("2 files"),
            "expected '2 files' in:\n{result}"
        );
    }

    // 12. test_search_filter
    #[test]
    fn test_search_filter() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        let content = fs::read_to_string(&main_rs).unwrap();
        // Modify both functions.
        let new_content = content
            .replace("println!(\"hello\")", "println!(\"UNIQUE_MARKER\")")
            .replace("println!(\"bye\")", "println!(\"other change\")");
        fs::write(&main_rs, new_content).unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            None,
            Some("UNIQUE_MARKER"),
            false,
            None,
        )
        .unwrap();
        assert!(
            result.contains("hello"),
            "expected hello (matching) in:\n{result}"
        );
    }

    // 13. test_search_no_matches
    #[test]
    fn test_search_no_matches() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        let content = fs::read_to_string(&main_rs).unwrap();
        fs::write(
            &main_rs,
            content.replace("println!(\"hello\")", "println!(\"hi\")"),
        )
        .unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            None,
            Some("NONEXISTENT_TERM_XYZ"),
            false,
            None,
        )
        .unwrap();
        assert!(
            result.contains("No changes matching"),
            "expected no-match message in:\n{result}"
        );
    }

    // 14. test_file_scope_not_found
    #[test]
    fn test_file_scope_not_found() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        let content = fs::read_to_string(&main_rs).unwrap();
        fs::write(
            &main_rs,
            content.replace("println!(\"hello\")", "println!(\"hi\")"),
        )
        .unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            Some("nonexistent.rs"),
            None,
            false,
            None,
        );
        assert!(result.is_err(), "expected error for missing file scope");
        assert!(
            result.unwrap_err().contains("not found"),
            "expected 'not found' in error"
        );
    }

    // 15. test_patch_file
    #[test]
    fn test_patch_file() {
        let dir = setup_test_repo();
        let patch = dir.path().join("test.patch");
        let patch_content = "\
diff --git a/src/main.rs b/src/main.rs
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,3 @@
 fn hello() {
-    println!(\"hello\");
+    println!(\"patched\");
 }
";
        fs::write(&patch, patch_content).unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::Patch(patch.clone()),
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert!(
            result.contains("main.rs"),
            "expected main.rs in patch result:\n{result}"
        );
    }

    // 16. test_file_to_file
    #[test]
    fn test_file_to_file() {
        let dir = setup_test_repo();
        let file_a = dir.path().join("a.txt");
        let file_b = dir.path().join("b.txt");
        fs::write(&file_a, "line one\nline two\n").unwrap();
        fs::write(&file_b, "line one\nline three\n").unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::Files(file_a, file_b),
            None,
            None,
            false,
            None,
        )
        .unwrap();
        // The diff should contain something — the files differ.
        assert!(
            !result.contains("No changes"),
            "expected changes between files:\n{result}"
        );
    }

    // 17. test_log_mode
    #[test]
    fn test_log_mode() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");

        // Make a second commit.
        let content = fs::read_to_string(&main_rs).unwrap();
        fs::write(
            &main_rs,
            content.replace("println!(\"hello\")", "println!(\"log test\")"),
        )
        .unwrap();
        git(dir.path(), &["add", "-A"]);
        git(dir.path(), &["commit", "-m", "second commit"]);

        let result = run_diff_in(
            dir.path(),
            &DiffSource::Log("HEAD~1..HEAD".to_string()),
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert!(
            result.contains("# Log:"),
            "expected log header in:\n{result}"
        );
        assert!(
            result.contains("second commit"),
            "expected commit message in:\n{result}"
        );
        let unexpected = dir.path().join("unexpected-log.txt");
        let rejected = run_diff_in(
            dir.path(),
            &DiffSource::Log(format!("--output={}", unexpected.display())),
            None,
            None,
            false,
            None,
        );
        assert!(
            !unexpected.exists(),
            "a log range must never become a Git output option"
        );
        assert!(rejected.is_err(), "option-shaped ranges must be refused");
    }

    // 18. test_resolve_source_variants
    #[test]
    fn test_resolve_source_variants() {
        // Default → uncommitted.
        assert!(matches!(
            resolve_source(None, None, None, None, None).unwrap(),
            DiffSource::GitUncommitted
        ));

        // Staged.
        assert!(matches!(
            resolve_source(Some("staged"), None, None, None, None).unwrap(),
            DiffSource::GitStaged
        ));

        // Working.
        assert!(matches!(
            resolve_source(Some("working"), None, None, None, None).unwrap(),
            DiffSource::GitUncommitted
        ));

        // Ref.
        match resolve_source(Some("HEAD~3..HEAD"), None, None, None, None).unwrap() {
            DiffSource::GitRef(r) => assert_eq!(r, "HEAD~3..HEAD"),
            other => panic!("expected GitRef, got {other:?}"),
        }

        // Files.
        match resolve_source(None, Some("a.rs"), Some("b.rs"), None, None).unwrap() {
            DiffSource::Files(a, b) => {
                assert_eq!(a, PathBuf::from("a.rs"));
                assert_eq!(b, PathBuf::from("b.rs"));
            }
            other => panic!("expected Files, got {other:?}"),
        }

        // Error: only one of a/b.
        assert!(resolve_source(None, Some("a.rs"), None, None, None).is_err());

        // Patch.
        match resolve_source(None, None, None, Some("test.patch"), None).unwrap() {
            DiffSource::Patch(p) => assert_eq!(p, PathBuf::from("test.patch")),
            other => panic!("expected Patch, got {other:?}"),
        }

        // Log.
        match resolve_source(None, None, None, None, Some("HEAD~5..HEAD")).unwrap() {
            DiffSource::Log(r) => assert_eq!(r, "HEAD~5..HEAD"),
            other => panic!("expected Log, got {other:?}"),
        }

        // Patch takes priority over source.
        assert!(matches!(
            resolve_source(Some("staged"), None, None, Some("x.patch"), None).unwrap(),
            DiffSource::Patch(_)
        ));
    }

    #[test]
    fn typed_diff_scope_search_and_symbol_spans_match_rendered_selection() {
        let dir = setup_test_repo();
        let main_rs = dir.path().join("src/main.rs");
        let other = dir.path().join("src/other.rs");
        fs::write(&other, "pub fn other() {\n    println!(\"before\");\n}\n").unwrap();
        git(dir.path(), &["add", "src/other.rs"]);
        git(dir.path(), &["commit", "-m", "add other"]);

        let content = fs::read_to_string(&main_rs).unwrap();
        fs::write(
            &main_rs,
            content
                .replace("println!(\"hello\")", "println!(\"UNIQUE_MARKER\")")
                .replace("println!(\"bye\")", "println!(\"other change\")"),
        )
        .unwrap();
        fs::write(&other, "pub fn other() {\n    println!(\"after\");\n}\n").unwrap();

        let session = crate::dispatch::NativeSession::new(dir.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(
            &session,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        let scoped = diff_typed(
            &DiffSource::GitUncommitted,
            Some("src/main.rs:hello"),
            None,
            false,
            0,
            None,
            Some(&context),
        )
        .unwrap();
        assert_eq!(scoped.files.len(), 1);
        assert_eq!(scoped.files[0].path, PathBuf::from("src/main.rs"));
        assert!(scoped.symbols.iter().all(|symbol| symbol.name == "hello"));
        assert!(scoped
            .symbols
            .iter()
            .all(|symbol| symbol.end_line >= symbol.line));
        assert!(scoped
            .symbols
            .iter()
            .any(|symbol| symbol.end_line > symbol.line));

        let searched = diff_typed(
            &DiffSource::GitUncommitted,
            None,
            Some("UNIQUE_MARKER"),
            false,
            0,
            None,
            Some(&context),
        )
        .unwrap();
        assert!(searched.text.contains("hello"));
        assert!(searched.symbols.iter().any(|symbol| symbol.name == "hello"));
        assert!(!searched
            .symbols
            .iter()
            .any(|symbol| symbol.name == "goodbye"));
        assert!(!searched
            .files
            .iter()
            .any(|file| file.path == Path::new("src/other.rs")));
    }

    #[test]
    fn git_child_is_killed_and_reaped_on_context_deadline() {
        let repository = setup_test_repo();
        let session = crate::dispatch::NativeSession::new(repository.path(), false).unwrap();
        let mut context = crate::dispatch::OperationContext::for_session(
            &session,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        context.deadline = Some(std::time::Instant::now());
        let error = run_git_diff(&DiffSource::GitUncommitted, None, Some(&context)).unwrap_err();
        assert!(
            error.starts_with("[pi-nav:deadline]"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn child_capture_drains_large_pipes_before_waiting() {
        let mut command = std::process::Command::new("sh");
        command
            .args(["-c", "yes x | head -c 262144; yes e | head -c 131072 >&2"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let child = command.spawn().expect("large-output child");
        let (status, stdout, stderr) = wait_child_output(child, None).expect("capture");
        assert!(status.success());
        assert_eq!(stdout.len(), 262_144);
        assert_eq!(stderr.len(), 131_072);
    }

    #[test]
    fn directory_scope_filters_changed_files_without_treating_directory_as_file() {
        let dir = setup_test_repo();
        let src_file = dir.path().join("src/main.rs");
        let root_file = dir.path().join("README.md");
        fs::write(&src_file, "fn main() { println!(\"directory scope\"); }\n").unwrap();
        fs::write(&root_file, "outside directory scope\n").unwrap();

        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            Some("src"),
            None,
            false,
            None,
        )
        .unwrap();
        assert!(
            result.contains("src/main.rs"),
            "expected scoped file:\n{result}"
        );
        assert!(
            !result.contains("README.md"),
            "unexpected out-of-scope file:\n{result}"
        );
    }

    #[test]
    fn uncommitted_source_excludes_fully_staged_changes() {
        let dir = setup_test_repo();
        fs::write(dir.path().join("src/other.rs"), "fn other() {}\n").unwrap();
        git(dir.path(), &["add", "src/other.rs"]);
        git(dir.path(), &["commit", "-m", "other"]);
        fs::write(
            dir.path().join("src/main.rs"),
            "fn main() { println!(\"staged\"); }\n",
        )
        .unwrap();
        git(dir.path(), &["add", "src/main.rs"]);
        fs::write(
            dir.path().join("src/other.rs"),
            "fn other() { println!(\"unstaged\"); }\n",
        )
        .unwrap();
        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert!(result.contains("src/other.rs"));
        assert!(
            !result.contains("src/main.rs"),
            "staged change leaked into uncommitted diff:\n{result}"
        );
    }

    #[test]
    fn invalid_ref_is_an_error_not_an_empty_diff() {
        let dir = setup_test_repo();
        let error = run_diff_in(
            dir.path(),
            &DiffSource::GitRef("--stat".into()),
            None,
            None,
            false,
            None,
        )
        .unwrap_err();
        assert!(!error.is_empty());
    }

    #[test]
    fn binary_file_detail_does_not_invent_zero_text_stats() {
        let dir = setup_test_repo();
        fs::write(dir.path().join("binary.dat"), [0_u8, 1, 2]).unwrap();
        git(dir.path(), &["add", "binary.dat"]);
        git(dir.path(), &["commit", "-m", "binary"]);
        fs::write(dir.path().join("binary.dat"), [0_u8, 9, 2]).unwrap();
        let result = run_diff_in(
            dir.path(),
            &DiffSource::GitUncommitted,
            Some("binary.dat"),
            None,
            false,
            None,
        )
        .unwrap();
        assert!(result.contains("binary content changed"));
        assert!(!result.contains("+0/−0"));
    }
}
