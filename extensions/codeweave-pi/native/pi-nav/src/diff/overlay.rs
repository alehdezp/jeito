use std::collections::HashMap;
use std::path::Path;

use crate::lang::detect_file_type;
use crate::lang::outline::get_outline_entries;
use crate::types::{FileType, OutlineEntry, OutlineKind};

use super::matching::{build_diff_symbols, match_symbols};
use super::{ChangeType, Conflict, DiffLine, DiffSource, FileDiff, FileOverlay, FileStatus,
    MatchConfidence, SymbolChange, SymbolSnapshot};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Build a structural overlay for a single file diff.
///
/// Fetches old/new content based on `source`, outlines both versions,
/// runs three-phase symbol matching, and attributes diff hunks to functions.
pub(crate) fn compute_overlay(
    file_diff: &FileDiff,
    source: &DiffSource,
    root: Option<&Path>,
    context: Option<&crate::dispatch::OperationContext>,
) -> Result<FileOverlay, String> {
    compute_overlay_with_base(file_diff, source, root, context, None, false)
}

pub(crate) fn compute_overlay_with_base(
    file_diff: &FileDiff, source: &DiffSource, root: Option<&Path>,
    context: Option<&crate::dispatch::OperationContext>, before_revision: Option<&str>,
    capture_old: bool,
) -> Result<FileOverlay, String> {
    let mut overlay = FileOverlay {
        path: file_diff.path.clone(),
        old_path: file_diff.old_path.clone(),
        symbol_changes: Vec::new(),
        unattributed_lines: Vec::new(),
        source_note: None,
        conflicts: Vec::new(),
        new_content: None,
        old_content: None,
    };
    if file_diff.is_binary || file_diff.is_generated || matches!(source, DiffSource::Patch(_)) {
        overlay.unattributed_lines = attribute_hunks(&file_diff.hunks, &mut []);
        if matches!(source, DiffSource::Patch(_)) {
            overlay.source_note = Some("Structural source unavailable: a patch does not supply complete before/after files.".into());
        }
        return Ok(overlay);
    }

    // Only an explicitly absent side is empty. Required-source failures must
    // survive search/filtering rather than masquerade as a successful zero.
    let old_content = if file_diff.status == FileStatus::Added {
        String::new()
    } else {
        (if let Some(revision) = before_revision {
            let path = file_diff.old_path.as_ref().unwrap_or(&file_diff.path);
            git_show(&format!("{revision}:{}", path.display()), root, context)
        } else {
            get_old_content(&file_diff.path, file_diff.old_path.as_deref(), source, root, context)
        })
            .map_err(|error| format!("before source unavailable for {}: {error}", file_diff.path.display()))?
    };
    let new_content = if file_diff.status == FileStatus::Deleted {
        String::new()
    } else {
        get_new_content(&file_diff.path, source, root, context)
            .map_err(|error| format!("after source unavailable for {}: {error}", file_diff.path.display()))?
    };
    validate_hunk_sources(file_diff, &old_content, &new_content)?;
    if let FileType::Code(lang) = detect_file_type(&file_diff.path) {
        let old = build_diff_symbols(&get_outline_entries(&old_content, lang), &old_content, lang);
        let new = build_diff_symbols(&get_outline_entries(&new_content, lang), &new_content, lang);
        overlay.symbol_changes = match_symbols(&old, &new);
    }
    overlay.unattributed_lines = attribute_hunks(&file_diff.hunks, &mut overlay.symbol_changes);
    if capture_old && file_diff.status != FileStatus::Added {
        overlay.old_content = Some(old_content);
    }
    if file_diff.status != FileStatus::Deleted {
        overlay.new_content = Some(new_content);
    }
    Ok(overlay)
}

/// A name/kind coincidence across files is only a possible move. Keep both
/// added/deleted identities; it cannot establish exact temporal continuity.
pub(crate) fn cross_file_matching(overlays: &mut [FileOverlay]) {
    let mut deleted: HashMap<(OutlineKind, String), Vec<(usize, usize)>> = HashMap::new();
    let mut added: HashMap<(OutlineKind, String), Vec<(usize, usize)>> = HashMap::new();
    for (oi, overlay) in overlays.iter().enumerate() {
        for (ci, change) in overlay.symbol_changes.iter().enumerate() {
            let map = match change.change {
                ChangeType::Deleted => &mut deleted,
                ChangeType::Added => &mut added,
                _ => continue,
            };
            map.entry((change.kind, change.name.clone())).or_default().push((oi, ci));
        }
    }
    for (key, old) in deleted {
        let Some(new) = added.get(&key) else { continue };
        if !old.iter().any(|(oi, _)| new.iter().any(|(ni, _)| oi != ni)) { continue; }
        let count = (old.len() + new.len()) as u32;
        for &(oi, ci) in old.iter().chain(new) {
            overlays[oi].symbol_changes[ci].match_confidence = MatchConfidence::Ambiguous(count);
        }
    }
}

/// Warn when the same symbol name has multiple signature changes across files.
pub(crate) fn signature_warnings(overlays: &[FileOverlay]) -> Vec<String> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    for overlay in overlays {
        for change in &overlay.symbol_changes {
            if matches!(change.change, ChangeType::SignatureChanged) {
                *counts.entry(change.name.clone()).or_default() += 1;
            }
        }
    }

    counts
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(name, count)| {
            format!("warning: `{name}` signature changed in {count} locations — check callers")
        })
        .collect()
}

/// Scan a file for merge conflict markers and extract conflict blocks.
pub(crate) fn detect_conflicts(path: &Path) -> Vec<Conflict> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };

    let lines: Vec<&str> = content.lines().collect();
    let mut conflicts = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        if lines[i].starts_with("<<<<<<<") {
            let start = i;
            let mut separator = None;
            let mut end = None;

            // Find ======= and >>>>>>>.
            let mut j = i + 1;
            while j < lines.len() {
                if lines[j].starts_with("=======") {
                    separator = Some(j);
                } else if lines[j].starts_with(">>>>>>>") {
                    end = Some(j);
                    break;
                }
                j += 1;
            }

            if let (Some(sep), Some(e)) = (separator, end) {
                let ours = lines[start + 1..sep].join("\n");
                let theirs = lines[sep + 1..e].join("\n");

                // Find enclosing function via outline.
                let ft = detect_file_type(path);
                let enclosing_fn = if let FileType::Code(lang) = ft {
                    let entries = get_outline_entries(&content, lang);
                    find_enclosing_function(&entries, (start + 1) as u32)
                } else {
                    None
                };

                conflicts.push(Conflict {
                    line: (start + 1) as u32,
                    ours,
                    theirs,
                    enclosing_fn,
                });

                i = e + 1;
                continue;
            }
        }
        i += 1;
    }

    conflicts
}


// ---------------------------------------------------------------------------
// Content fetching helpers
// ---------------------------------------------------------------------------

/// Fetch the old-side content for a file diff.
///
/// Returns `Ok(content)` on success (including legitimately empty for new files).
/// Returns `Err(reason)` when the git command OR a filesystem read fails — the caller should
/// treat this as a signal that old-side content is unavailable and handle accordingly.
fn get_old_content(
    path: &Path,
    old_path: Option<&Path>,
    source: &DiffSource,
    root: Option<&Path>,
    context: Option<&crate::dispatch::OperationContext>,
) -> Result<String, String> {
    let effective_path = old_path.unwrap_or(path);
    let path_str = effective_path.to_string_lossy();

    match source {
        DiffSource::GitUncommitted => git_show(&format!(":{path_str}"), root, context),
        DiffSource::GitStaged => git_show(&format!("HEAD:{path_str}"), root, context),
        DiffSource::GitRef(reference) => {
            let old = if let Some((left, right)) = reference.split_once("...") {
                let args = vec!["merge-base".into(), revision_or_head(left).into(), revision_or_head(right).into()];
                let (success, stdout, stderr) = super::run_git_capture_at(&args, root, context)?;
                if !success { return Err(format!("git merge-base failed: {stderr}")); }
                stdout.trim().to_string()
            } else {
                revision_or_head(reference.split_once("..").map_or(reference.as_str(), |(left, _)| left)).into()
            };
            git_show(&format!("{old}:{path_str}"), root, context)
        }
        DiffSource::Files(a, _) => {
            let a = rooted_path(a, root);
            std::fs::read_to_string(&a).map_err(|e| format!("read {}: {e}", a.display()))
        }
        DiffSource::Patch(_) | DiffSource::Log(_) => Err("complete before source is unavailable".into()),
    }
}

/// Where the "new" side of a `GitRef` diff reads its content from.
enum GitRefNewSide {
    /// A range ref (`a..b`): the committed blob at the right side, via `git show`.
    Committed(String),
    /// A bare ref: `git diff <ref>` compares against the working tree on disk.
    WorkingTree,
}

/// Decide how a `GitRef`'s new-side content is sourced.
///
/// A range ref (`a..b`) reads the committed blob at `b` via `git show b:<path>`;
/// a bare ref reads the working tree, because `git diff <ref>` compares `<ref>`
/// against the working tree rather than against `HEAD`.
fn resolve_git_ref_new_side(reference: &str, path_str: &str) -> GitRefNewSide {
    match reference.split_once("...").or_else(|| reference.split_once("..")) {
        Some((_, right)) => GitRefNewSide::Committed(format!("{}:{path_str}", revision_or_head(right))),
        None => GitRefNewSide::WorkingTree,
    }
}

fn revision_or_head(reference: &str) -> &str {
    if reference.is_empty() { "HEAD" } else { reference }
}
fn get_new_content(
    path: &Path,
    source: &DiffSource,
    root: Option<&Path>,
    context: Option<&crate::dispatch::OperationContext>,
) -> Result<String, String> {
    let path_str = path.to_string_lossy();

    match source {
        DiffSource::GitUncommitted => {
            let path = rooted_path(path, root);
            std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
        }
        DiffSource::GitStaged => git_show(&format!(":{path_str}"), root, context),
        DiffSource::GitRef(r) => match resolve_git_ref_new_side(r, &path_str) {
            GitRefNewSide::Committed(spec) => git_show(&spec, root, context),
            GitRefNewSide::WorkingTree => {
                let path = rooted_path(path, root);
                std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
            }
        },
        DiffSource::Files(_, b) => {
            let b = rooted_path(b, root);
            std::fs::read_to_string(&b).map_err(|e| format!("read {}: {e}", b.display()))
        }
        DiffSource::Patch(_) | DiffSource::Log(_) => Err("complete after source is unavailable".into()),
    }
}

fn rooted_path(path: &Path, root: Option<&Path>) -> std::path::PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.map_or_else(|| path.to_path_buf(), |root| root.join(path))
    }
}

fn git_show(spec: &str, root: Option<&Path>, context: Option<&crate::dispatch::OperationContext>) -> Result<String, String> {
    let args = vec!["show".into(), "--no-ext-diff".into(), "--no-textconv".into(), "--end-of-options".into(), spec.into()];
    let (success, stdout, stderr) = super::run_git_capture_at(&args, root, context)?;
    if success { Ok(stdout) } else { Err(format!("git show {spec}: {}", stderr.trim())) }
}

/// Refuse raced, malformed or transformed source rather than certify a hunk
/// against unrelated bytes. Coordinates are those parsed from Git, not rebuilt
/// from the subset that happened to fit a symbol.
fn validate_hunk_sources(file: &FileDiff, old: &str, new: &str) -> Result<(), String> {
    let old: Vec<_> = old.lines().collect();
    let new: Vec<_> = new.lines().collect();
    for line in file.hunks.iter().flat_map(|hunk| &hunk.lines) {
        for (side, position, source) in [("before", line.old_line, &old), ("after", line.new_line, &new)] {
            if let Some(position) = position {
                if position == 0 || source.get(position as usize - 1).copied() != Some(line.content.as_str()) {
                    return Err(format!("{side} source does not match diff at {}:{position}; source changed or is unavailable", file.path.display()));
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Hunk-to-function attribution
// ---------------------------------------------------------------------------

/// Attach rows directly to the matched old/new declaration pair. A bare name
/// is not a join key: overloads and same-named methods retain separate ranges.
/// Overlapping declarations may share evidence; presentation/counts union the
/// actual coordinates rather than multiplying physical changes.
fn attribute_hunks(hunks: &[super::Hunk], changes: &mut [SymbolChange]) -> Vec<DiffLine> {
    let contains = |snapshot: &Option<SymbolSnapshot>, line: Option<u32>| {
        snapshot.as_ref().zip(line).is_some_and(|(symbol, line)|
            line >= symbol.start_line && line <= symbol.end_line)
    };
    let mut unattributed = Vec::new();
    for line in hunks.iter().flat_map(|hunk| &hunk.lines) {
        let mut attributed = false;
        for change in changes.iter_mut().filter(|change| !matches!(change.change, ChangeType::Unchanged)) {
            if contains(&change.old, line.old_line) || contains(&change.new, line.new_line) {
                change.diff_lines.push(line.clone());
                attributed = true;
            }
        }
        if !attributed { unattributed.push(line.clone()); }
    }
    unattributed
}

// ---------------------------------------------------------------------------
// Conflict helpers
// ---------------------------------------------------------------------------

/// Find the enclosing function for a given line number by walking the outline.
fn find_enclosing_function(entries: &[OutlineEntry], line: u32) -> Option<String> {
    for entry in entries {
        if line >= entry.start_line && line <= entry.end_line {
            // Check children first for more specific match.
            if let Some(child_name) = find_enclosing_function(&entry.children, line) {
                return Some(child_name);
            }
            if matches!(entry.kind, OutlineKind::Function) {
                return Some(entry.name.clone());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_git_ref_new_content_reads_working_tree() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sample.rs");
        std::fs::write(&file, "fn worktree_only() {}\n").unwrap();

        // A single ref (no `..`) diffs against the working tree, so the new
        // content must come from the file on disk — not `git show HEAD:<path>`,
        // which would return empty here and silently mis-attribute the diff.
        let content = get_new_content(&file, &DiffSource::GitRef("HEAD".to_string()), None, None)
            .expect("working-tree read must succeed");
        assert!(
            content.contains("worktree_only"),
            "bare GitRef new content must be the working tree, got {content:?}"
        );

        // Lock the routing decision too: a bare ref must take the working-tree branch.
        match resolve_git_ref_new_side("HEAD", "src/lib.rs") {
            GitRefNewSide::WorkingTree => {}
            GitRefNewSide::Committed(spec) => {
                panic!("bare ref must read the working tree, not `git show {spec}`")
            }
        }
    }

    #[test]
    fn range_git_ref_new_content_reads_committed_blob() {
        // Dual-path lock: a RANGE ref (`a..b`) must read the committed blob at the
        // right side via `git show b:<path>`, NOT the working tree. Without this a
        // regression collapsing both branches into the working-tree read would pass
        // the bare-ref test above while silently breaking range diffs.
        match resolve_git_ref_new_side("HEAD..feature", "src/lib.rs") {
            GitRefNewSide::Committed(spec) => {
                assert_eq!(spec, "feature:src/lib.rs", "wrong git show spec");
            }
            GitRefNewSide::WorkingTree => {
                panic!("range ref must read the committed blob, not the working tree")
            }
        }
    }

    #[test]
    fn a_unique_cross_file_name_is_not_an_exact_move() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.rs");
        let new = dir.path().join("new.rs");
        std::fs::write(&old, "fn same() { remove_data(); }\n").unwrap();
        std::fs::write(&new, "fn same() { create_data(); }\n").unwrap();
        let source = DiffSource::Files(old.clone(), new.clone());
        let mut overlays: Vec<_> = [(old, FileStatus::Deleted), (new, FileStatus::Added)]
            .into_iter()
            .map(|(path, status)| compute_overlay(&FileDiff {
                path, status, old_path: None, hunks: Vec::new(), is_binary: false, is_generated: false,
            }, &source, None, None).unwrap())
            .collect();
        cross_file_matching(&mut overlays);
        assert!(matches!(overlays[0].symbol_changes[0].change, ChangeType::Deleted));
        assert!(matches!(overlays[1].symbol_changes[0].change, ChangeType::Added));
        assert!(overlays.iter().all(|overlay| matches!(overlay.symbol_changes[0].match_confidence, MatchConfidence::Ambiguous(2))));
    }

    #[test]
    fn mismatched_hunk_source_fails_closed_on_each_side() {
        let files = super::super::parse::parse_unified_diff(
            "diff --git a/x.rs b/x.rs\n@@ -1 +1 @@\n-fn before() {}\n+fn after() {}\n",
        );
        assert!(validate_hunk_sources(&files[0], "fn before() {}\n", "fn after() {}\n").is_ok());
        let old_error = validate_hunk_sources(&files[0], "fn unrelated() {}\n", "fn after() {}\n").unwrap_err();
        assert!(old_error.contains("before source does not match diff"), "{old_error}");
        let new_error = validate_hunk_sources(&files[0], "fn before() {}\n", "fn unrelated() {}\n").unwrap_err();
        assert!(new_error.contains("after source does not match diff"), "{new_error}");
    }

    #[test]
    fn missing_required_source_is_an_error_not_empty_changes() {
        // An explicitly missing side is not an empty historical file.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("foo.rs");
        std::fs::write(&file, "fn new_fn() {}\n").unwrap();

        let missing = dir.path().join("does_not_exist.rs");
        let result = get_old_content(
            &file,
            None,
            &DiffSource::Files(missing.clone(), file.clone()),
            None,
            None,
        );
        assert!(result.is_err(), "missing file path must yield Err, got Ok");

        // The public overlay owner must propagate this failure through filtering.
        let file_diff = FileDiff {
            path: file.clone(),
            old_path: None,
            status: FileStatus::Modified,
            hunks: Vec::new(),
            is_generated: false,
            is_binary: false,
        };
        let error = compute_overlay(
            &file_diff, &DiffSource::Files(missing, file), None, None,
        ).unwrap_err();
        assert!(error.contains("before source unavailable"), "{error}");
    }
}
