use std::collections::HashSet;
use std::fmt::Write;
use std::path::Path;

use crate::budget;
use crate::format::rel;
use crate::types::estimate_tokens;

use super::{
    ChangeType, CommitSummary, Conflict, DiffLine, DiffLineKind, FileOverlay, MatchConfidence,
    SymbolChange,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Format a high-level overview of all changed files with per-symbol markers.
///
/// Layout:
/// ```text
/// # Diff: {source_label} — N files, M modified, K added (~X tokens)
///
/// ## path (N symbols)
///   [~:sig]  fn name(old) → (new)    L42
///   [~]      fn name                 L88  (body, 44→51 lines)
///   [+]      fn name(sig)            L120 (new, 18 lines)
///
/// ## package-lock.json (generated, N lines changed — summarized)
/// ```
///
/// `file_meta` is parallel to `overlays`: `(path, is_generated, is_binary)`.
pub(crate) fn format_overview(
    overlays: &[FileOverlay],
    file_meta: &[(&Path, bool, bool)],
    warnings: &[String],
    source_label: &str,
    budget: Option<u64>,
) -> String {
    let scope = Path::new(".");

    // Count stats for header.
    let file_count = overlays.len();
    let mut fn_modified: usize = 0;
    let mut fn_added: usize = 0;
    for overlay in overlays {
        for change in &overlay.symbol_changes {
            match &change.change {
                ChangeType::BodyChanged | ChangeType::SignatureChanged => fn_modified += 1,
                ChangeType::Added => fn_added += 1,
                _ => {}
            }
        }
    }

    let mut out = String::new();

    // Placeholder header — token count is patched below.
    let _ = writeln!(
        out,
        "# Diff: {} — {} {}, {} modified, {} added",
        source_label,
        file_count,
        if file_count == 1 { "file" } else { "files" },
        fn_modified,
        fn_added,
    );

    for (i, overlay) in overlays.iter().enumerate() {
        let (path, is_generated, is_binary) = file_meta[i];
        let rel_path = rel(path, scope);

        let _ = writeln!(out);

        if is_binary {
            let _ = writeln!(out, "## {rel_path} (binary)");
            continue;
        }

        if is_generated {
            let (added, removed) = count_insertions_deletions(overlay);
            let changed_lines = added + removed;
            let _ = writeln!(
                out,
                "## {rel_path} (generated, {changed_lines} lines changed — summarized)"
            );
            continue;
        }

        // Normal file — show non-Unchanged symbol changes.
        let visible: Vec<&SymbolChange> = overlay
            .symbol_changes
            .iter()
            .filter(|c| !matches!(c.change, ChangeType::Unchanged))
            .collect();

        let sym_count = visible.len();
        let _ = writeln!(out, "## {rel_path} ({sym_count} symbols)");
        if let Some(note) = &overlay.source_note { let _ = writeln!(out, "  {note}"); }
        if let Some(old_path) = &overlay.old_path { let _ = writeln!(out, "  BEFORE path: {}", old_path.display()); }

        for change in &visible {
            let line = format_symbol_line(change);
            let _ = writeln!(out, "  {line}");
        }
    }

    // Warnings at the bottom.
    if !warnings.is_empty() {
        let _ = writeln!(out);
        for w in warnings {
            let _ = writeln!(out, "⚠ {w}");
        }
    }

    // Patch in the token count now that we know the full size.
    let token_count = estimate_tokens(out.len() as u64);
    if let Some(nl) = out.find('\n') {
        let new_header = format!(
            "# Diff: {} — {} {}, {} modified, {} added (~{} tokens)",
            source_label,
            file_count,
            if file_count == 1 { "file" } else { "files" },
            fn_modified,
            fn_added,
            token_count,
        );
        out.replace_range(..nl, &new_header);
    }

    if let Some(b) = budget {
        budget::apply(&out, b)
    } else {
        out
    }
}

/// Render matched declarations with separate before/after ranges and original
/// hunk coordinates. Shared physical rows appear once, with overlap disclosed.
pub(crate) fn format_file_detail(overlay: &FileOverlay, budget: Option<u64>) -> String {
    format_detail(overlay, None, budget)
}

/// A bare name may select several declarations. Do not silently choose the
/// first method or join their source under a single bare-name identity.
pub(crate) fn format_function_detail(overlay: &FileOverlay, name: &str) -> String {
    format_detail(overlay, Some(name), None)
}

fn format_detail(overlay: &FileOverlay, name: Option<&str>, budget: Option<u64>) -> String {
    let selected: Vec<_> = overlay
        .symbol_changes
        .iter()
        .filter(|change| name.is_none_or(|name| super::symbol_matches_name(change, name)))
        .collect();
    if let Some(name) = name.filter(|_| selected.is_empty()) {
        return match &overlay.source_note {
            Some(note) => format!("# Diff: {} — {note}", overlay.path.display()),
            None => format!("# Diff: {} — `{name}` not found in diff", overlay.path.display()),
        };
    }
    let lines = selected.iter().flat_map(|change| change.diff_lines.iter())
        .chain(overlay.unattributed_lines.iter().filter(|_| name.is_none()));
    let (insertions, deletions) = count_lines(lines);
    let touched = selected.iter().filter(|change| !matches!(change.change, ChangeType::Unchanged)).count();
    let mut out = format!("# Diff: {} — {touched} symbols touched, +{insertions}/−{deletions} lines\n",
        rel(&overlay.path, Path::new(".")));
    out.push_str("Line coordinates: old = before comparison; new = after comparison (not necessarily the working tree).\n");
    if let Some(old_path) = &overlay.old_path {
        let _ = writeln!(out, "BEFORE path: {}", old_path.display());
    }
    if let Some(note) = &overlay.source_note {
        let _ = writeln!(out, "{note}");
    }
    let mut emitted = HashSet::new();
    for change in selected {
        let marker = format_marker(&change.change, &change.match_confidence);
        let label = change_type_label(&change.change);
        let _ = writeln!(out, "\n## {marker} {} — {label}", symbol_name(change));
        for (side, snapshot) in [("BEFORE", &change.old), ("AFTER", &change.new)] {
            if let Some(snapshot) = snapshot {
                let _ = writeln!(out, "  {side}: {} (L{}-{})", snapshot_name(snapshot), snapshot.start_line, snapshot.end_line);
            }
        }
        if matches!(change.change, ChangeType::SignatureChanged) {
            if let Some(signature) = &change.old_sig {
                let _ = writeln!(out, "  BEFORE: {signature}");
            }
            if let Some(signature) = &change.new_sig {
                let _ = writeln!(out, "  AFTER:  {signature}");
            }
        }
        write_diff_lines(&mut out, &change.diff_lines, &mut emitted);
    }
    if name.is_none() && !overlay.unattributed_lines.is_empty() {
        out.push_str("\n## File-level changes/context outside changed declarations\n");
        write_diff_lines(&mut out, &overlay.unattributed_lines, &mut emitted);
    }
    if let Some(budget) = budget { crate::budget::apply(&out, budget) } else { out }
}

/// Format merge conflict blocks for a file.
///
/// Layout:
/// ```text
/// # Conflicts: N in path
///
/// ## fn enclosing_name (LN)
///   OURS:
///     ...
///   THEIRS:
///     ...
/// ```
pub(crate) fn format_conflicts(conflicts: &[Conflict], path: &Path) -> String {
    let scope = Path::new(".");
    let rel_path = rel(path, scope);

    let mut out = String::new();
    let _ = writeln!(out, "# Conflicts: {} in {rel_path}", conflicts.len());

    for conflict in conflicts {
        let fn_label = conflict.enclosing_fn.as_deref().unwrap_or("<top level>");
        let cline = conflict.line;
        let _ = writeln!(out, "\n## {fn_label} (L{cline})");
        let _ = writeln!(out, "  OURS:");
        for l in conflict.ours.lines() {
            let _ = writeln!(out, "    {l}");
        }
        let _ = writeln!(out, "  THEIRS:");
        for l in conflict.theirs.lines() {
            let _ = writeln!(out, "    {l}");
        }
    }

    out
}

/// Format a git log range as a structured summary.
///
/// Layout:
/// ```text
/// # Log: range — N commits, M files, K functions touched
///
/// ## abc1234 — "message" (2h ago, @author)
///   path:  [~:sig] name, [+] name
/// ```
pub(crate) fn format_log(summaries: &[CommitSummary], scope: &str, budget: Option<u64>) -> String {
    let path_scope = Path::new(".");

    let total_files: usize = summaries.iter().map(|s| s.overlays.len()).sum();
    let total_fns: usize = summaries
        .iter()
        .flat_map(|s| s.overlays.iter())
        .flat_map(|o| o.symbol_changes.iter())
        .filter(|c| !matches!(c.change, ChangeType::Unchanged))
        .count();

    let n_commits = summaries.len();
    let mut out = String::new();
    let _ = writeln!(
        out,
        "# Log: {scope} — {n_commits} {}, {total_files} {}, {total_fns} functions touched",
        if n_commits == 1 { "commit" } else { "commits" },
        if total_files == 1 { "file" } else { "files" },
    );

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    for summary in summaries {
        let short_hash = &summary.hash[..summary.hash.len().min(7)];
        let age = format_age(now - summary.timestamp);
        let _ = writeln!(
            out,
            "\n## {short_hash} — \"{}\" ({age}, @{})",
            summary.message, summary.author
        );

        for overlay in &summary.overlays {
            let rel_path = rel(&overlay.path, path_scope);
            let changed: Vec<&SymbolChange> = overlay
                .symbol_changes
                .iter()
                .filter(|c| !matches!(c.change, ChangeType::Unchanged))
                .collect();

            if changed.is_empty() {
                continue;
            }

            let markers: Vec<String> = changed
                .iter()
                .map(|c| {
                    format!(
                        "{} {}",
                        format_marker(&c.change, &c.match_confidence),
                        c.name
                    )
                })
                .collect();
            let _ = writeln!(out, "  {rel_path}:  {}", markers.join(", "));
        }
    }

    if let Some(b) = budget {
        budget::apply(&out, b)
    } else {
        out
    }
}

/// Union coordinates: a changed method also enclosed by a changed type is one
/// physical change, not two. Removed and added positions are separate sides.
pub(crate) fn count_insertions_deletions(overlay: &FileOverlay) -> (usize, usize) {
    count_lines(overlay.symbol_changes.iter().flat_map(|change| &change.diff_lines)
        .chain(&overlay.unattributed_lines))
}

fn count_lines<'a>(lines: impl Iterator<Item = &'a DiffLine>) -> (usize, usize) {
    let mut additions = HashSet::new();
    let mut removals = HashSet::new();
    for line in lines {
        match line.kind {
            DiffLineKind::Added => { additions.insert(line.new_line); }
            DiffLineKind::Removed => { removals.insert(line.old_line); }
            DiffLineKind::Context => {}
        }
    }
    (additions.len(), removals.len())
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Build the bracket marker for a symbol change.
/// `Ambiguous` confidence overrides to `[?→]` regardless of change type.
fn format_marker(change: &ChangeType, confidence: &MatchConfidence) -> String {
    if matches!(confidence, MatchConfidence::Ambiguous(_)) {
        return "[?→]".to_string();
    }
    match change {
        ChangeType::Added => "[+]".to_string(),
        ChangeType::Deleted => "[-]".to_string(),
        ChangeType::BodyChanged => "[~]".to_string(),
        ChangeType::SignatureChanged => "[~:sig]".to_string(),
        ChangeType::Renamed { .. } => "[→]".to_string(),
        ChangeType::Moved { .. } => "[↦]".to_string(),
        ChangeType::RenamedAndMoved { .. } => "[→↦]".to_string(),
        ChangeType::Unchanged => "[ ]".to_string(),
    }
}

/// Format one symbol change as a single overview line (used inside file sections).
fn format_symbol_line(change: &SymbolChange) -> String {
    let marker = format_marker(&change.change, &change.match_confidence);
    let name = symbol_name(change);
    let line_no = change.line;

    let mut s = format!("{marker:<8} {name}");

    // For signature changes, append old → new.
    if matches!(change.change, ChangeType::SignatureChanged) {
        if let (Some(old), Some(new)) = (&change.old_sig, &change.new_sig) {
            let _ = write!(s, "({old}) → ({new})");
        }
    }

    // Right-align line number at column ~50.
    let pad = 50usize.saturating_sub(s.len());
    let _ = write!(s, "{:>pad$}L{line_no}", "");

    // Trailing annotation.
    match &change.change {
        ChangeType::BodyChanged => {
            if let Some((old_sz, new_sz)) = change.size_delta {
                let _ = write!(s, "  (body, {old_sz}→{new_sz} lines)");
            }
        }
        ChangeType::Added => {
            if let Some((_, new_sz)) = change.size_delta {
                let _ = write!(s, "  (new, {new_sz} lines)");
            }
        }
        ChangeType::Deleted => {
            if let Some((old_sz, _)) = change.size_delta {
                let _ = write!(s, "  (deleted, {old_sz} lines)");
            }
        }
        _ => {}
    }
    if let Some(old) = &change.old {
        let _ = write!(s, "  [before {} L{}-{}]", snapshot_name(old), old.start_line, old.end_line);
    }
    if let Some(new) = &change.new {
        let _ = write!(s, "  [after L{}-{}]", new.start_line, new.end_line);
    }
    if let MatchConfidence::Ambiguous(count) = change.match_confidence {
        let _ = write!(s, "  ({count} possible correspondences; identity unverified)");
    }

    s
}

/// Human-readable label for a change type.
fn change_type_label(change: &ChangeType) -> &'static str {
    match change {
        ChangeType::Added => "added",
        ChangeType::Deleted => "deleted",
        ChangeType::BodyChanged => "body changed",
        ChangeType::SignatureChanged => "signature changed",
        ChangeType::Renamed { .. } => "renamed",
        ChangeType::Moved { .. } => "moved",
        ChangeType::RenamedAndMoved { .. } => "renamed and moved",
        ChangeType::Unchanged => "unchanged",
    }
}

fn snapshot_name(snapshot: &super::SymbolSnapshot) -> String {
    if snapshot.identity.parent_path.is_empty() { snapshot.identity.name.clone() }
    else { format!("{}::{}", snapshot.identity.parent_path, snapshot.identity.name) }
}

fn symbol_name(change: &SymbolChange) -> String {
    change.new.as_ref().or(change.old.as_ref()).map_or_else(|| change.name.clone(), snapshot_name)
}

/// Never restart numbering at a declaration boundary: separated hunks retain
/// their original coordinates, including the old coordinate of each removal.
fn write_diff_lines(out: &mut String, lines: &[DiffLine], emitted: &mut HashSet<(Option<u32>, Option<u32>)>) {
    let mut reused = false;
    for line in lines {
        if !emitted.insert((line.old_line, line.new_line)) { reused = true; continue; }
        let coordinate = match (line.old_line, line.new_line) {
            (Some(old), Some(new)) => format!("  old {old} → new {new}"),
            (Some(old), None) => format!("- old {old}"),
            (None, Some(new)) => format!("+ new {new}"),
            (None, None) => "? coordinate unavailable".into(),
        };
        let _ = writeln!(out, "  {coordinate}| {}", line.content);
    }
    if reused { let _ = writeln!(out, "  Shared diff rows shown above; this declaration overlaps that evidence."); }
}

/// Format a duration in seconds as a human-readable age string.
fn format_age(secs: i64) -> String {
    let secs = secs.max(0) as u64;
    if secs < 60 {
        return format!("{secs}s ago");
    }
    let mins = secs / 60;
    if mins < 60 {
        return format!("{mins}m ago");
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    let days = hours / 24;
    format!("{days}d ago")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::{
        ChangeType, Conflict, FileOverlay, MatchConfidence, SymbolChange,
    };
    use crate::types::OutlineKind;
    use std::path::{Path, PathBuf};

    fn make_overlay(path: &str, changes: Vec<SymbolChange>) -> FileOverlay {
        FileOverlay {
            path: PathBuf::from(path),
            symbol_changes: changes,
            old_path: None,
            unattributed_lines: Vec::new(),
            source_note: None,
            conflicts: Vec::new(),
            new_content: None,
            old_content: None,
        }
    }

    fn make_change(name: &str, change: ChangeType) -> SymbolChange {
        let snapshot = |end_line| super::super::SymbolSnapshot {
            identity: super::super::SymbolIdentity { name: name.into(), parent_path: String::new(), kind: OutlineKind::Function },
            start_line: 42, end_line,
        };
        let old = (!matches!(change, ChangeType::Added)).then(|| snapshot(51));
        let new = (!matches!(change, ChangeType::Deleted)).then(|| snapshot(53));
        SymbolChange {
            name: name.to_string(),
            kind: OutlineKind::Function,
            change,
            match_confidence: MatchConfidence::Exact,
            line: 42,
            old_sig: None,
            new_sig: None,
            size_delta: Some((10, 12)),
            old, new, diff_lines: Vec::new(),
        }
    }

    fn make_sig_change(name: &str, old: &str, new: &str) -> SymbolChange {
        let mut change = make_change(name, ChangeType::SignatureChanged);
        change.old_sig = Some(old.into());
        change.new_sig = Some(new.into());
        change
    }

    // Helper: build file_meta slice referencing the overlays' paths.
    // Since lifetimes are tricky with inline vec, callers build it manually.

    // 1. All 6 change types produce correct markers
    #[test]
    fn test_overview_markers() {
        let changes = vec![
            make_change("fn_added", ChangeType::Added),
            make_change("fn_deleted", ChangeType::Deleted),
            make_change("fn_body", ChangeType::BodyChanged),
            make_sig_change("fn_sig", "old", "new"),
            make_change(
                "fn_renamed",
                ChangeType::Renamed {
                    old_name: "old_fn".to_string(),
                },
            ),
            make_change(
                "fn_moved",
                ChangeType::Moved {
                    old_path: PathBuf::from("old.rs"),
                },
            ),
        ];
        let overlay = make_overlay("src/lib.rs", changes);
        let path = overlay.path.clone();
        let meta: Vec<(&Path, bool, bool)> = vec![(&path, false, false)];
        let out = format_overview(&[overlay], &meta, &[], "HEAD", None);
        assert!(out.contains("[+]"), "missing [+]:\n{out}");
        assert!(out.contains("[-]"), "missing [-]:\n{out}");
        assert!(out.contains("[~]"), "missing [~]:\n{out}");
        assert!(out.contains("[~:sig]"), "missing [~:sig]:\n{out}");
        assert!(out.contains("[→]"), "missing [→]:\n{out}");
        assert!(out.contains("[↦]"), "missing [↦]:\n{out}");
    }

    // 2. Ambiguous confidence → [?→]
    #[test]
    fn test_overview_ambiguous_marker() {
        let mut change = make_change("fn_ambig", ChangeType::Added);
        change.match_confidence = MatchConfidence::Ambiguous(3);
        let overlay = make_overlay("src/lib.rs", vec![change]);
        let path = overlay.path.clone();
        let meta: Vec<(&Path, bool, bool)> = vec![(&path, false, false)];
        let out = format_overview(&[overlay], &meta, &[], "HEAD", None);
        assert!(out.contains("[?→]"), "expected [?→]:\n{out}");
    }

    // 3. Warnings appended at bottom
    #[test]
    fn test_overview_warnings() {
        let overlay = make_overlay("src/lib.rs", vec![]);
        let path = overlay.path.clone();
        let meta: Vec<(&Path, bool, bool)> = vec![(&path, false, false)];
        let warnings = vec!["warning: foo changed in 2 locations".to_string()];
        let out = format_overview(&[overlay], &meta, &warnings, "HEAD", None);
        assert!(
            out.contains("warning: foo changed"),
            "warnings not appended:\n{out}"
        );
        let warn_pos = out.find("warning: foo").unwrap();
        let file_pos = out.find("## src/lib.rs").unwrap();
        assert!(warn_pos > file_pos, "warning before file section:\n{out}");
    }

    // 4. Generated files show one-line summary
    #[test]
    fn test_overview_generated() {
        let mut overlay = make_overlay("package-lock.json", vec![]);
        overlay.unattributed_lines = super::super::parse::parse_unified_diff(
            "diff --git a/x b/x\n@@ -1,2 +1,2 @@\n-b\n+a\n c\n"
        ).remove(0).hunks.remove(0).lines;
        let path = overlay.path.clone();
        let meta: Vec<(&Path, bool, bool)> = vec![(&path, true, false)];
        let out = format_overview(&[overlay], &meta, &[], "HEAD", None);
        assert!(out.contains("generated"), "missing 'generated':\n{out}");
        assert!(
            out.contains("lines changed"),
            "missing 'lines changed':\n{out}"
        );
        assert!(
            out.contains("2 lines changed"),
            "expected 2 changed lines:\n{out}"
        );
    }

    // 5. Binary files show "(binary)"
    #[test]
    fn test_overview_binary() {
        let overlay = make_overlay("image.png", vec![]);
        let path = overlay.path.clone();
        let meta: Vec<(&Path, bool, bool)> = vec![(&path, false, true)];
        let out = format_overview(&[overlay], &meta, &[], "HEAD", None);
        assert!(out.contains("(binary)"), "missing (binary):\n{out}");
    }

    // 6. Small budget truncates with "... truncated"
    #[test]
    fn test_overview_budget() {
        let changes = vec![
            make_change("fn_a", ChangeType::Added),
            make_change("fn_b", ChangeType::BodyChanged),
            make_change("fn_c", ChangeType::Deleted),
        ];
        let overlay = make_overlay("src/lib.rs", changes);
        let path = overlay.path.clone();
        let meta: Vec<(&Path, bool, bool)> = vec![(&path, false, false)];
        let out = format_overview(&[overlay], &meta, &[], "HEAD", Some(5));
        assert!(out.contains("truncated"), "expected truncation:\n{out}");
    }

    // 7. Unchanged symbols NOT shown in overview
    #[test]
    fn test_overview_unchanged_hidden() {
        let changes = vec![
            make_change("fn_changed", ChangeType::BodyChanged),
            make_change("fn_unchanged", ChangeType::Unchanged),
        ];
        let overlay = make_overlay("src/lib.rs", changes);
        let path = overlay.path.clone();
        let meta: Vec<(&Path, bool, bool)> = vec![(&path, false, false)];
        let out = format_overview(&[overlay], &meta, &[], "HEAD", None);
        assert!(out.contains("fn_changed"), "changed fn missing:\n{out}");
        assert!(
            !out.contains("fn_unchanged"),
            "unchanged fn should be hidden:\n{out}"
        );
    }

    // 8. Multiple files — correct file count, both paths present
    #[test]
    fn test_overview_multiple_files() {
        let overlay_a = make_overlay("src/a.rs", vec![make_change("fn_a", ChangeType::Added)]);
        let overlay_b = make_overlay(
            "src/b.rs",
            vec![make_change("fn_b", ChangeType::BodyChanged)],
        );
        let path_a = overlay_a.path.clone();
        let path_b = overlay_b.path.clone();
        let meta: Vec<(&Path, bool, bool)> = vec![(&path_a, false, false), (&path_b, false, false)];
        let out = format_overview(&[overlay_a, overlay_b], &meta, &[], "HEAD", None);
        assert!(out.contains("2 files"), "wrong file count:\n{out}");
        assert!(out.contains("src/a.rs"), "missing a.rs:\n{out}");
        assert!(out.contains("src/b.rs"), "missing b.rs:\n{out}");
    }

    // 9. Signature annotation shows old→new for [~:sig]
    #[test]
    fn test_overview_signature_annotation() {
        let change = make_sig_change("process", "fn process(x: i32)", "fn process(x: i64)");
        let overlay = make_overlay("src/lib.rs", vec![change]);
        let path = overlay.path.clone();
        let meta: Vec<(&Path, bool, bool)> = vec![(&path, false, false)];
        let out = format_overview(&[overlay], &meta, &[], "HEAD", None);
        assert!(out.contains("[~:sig]"), "missing sig marker:\n{out}");
        assert!(
            out.contains("fn process(x: i32)"),
            "missing old sig:\n{out}"
        );
        assert!(
            out.contains("fn process(x: i64)"),
            "missing new sig:\n{out}"
        );
        assert!(out.contains('→'), "missing arrow:\n{out}");
    }

    // 10. File detail header — symbol count and +N/-N
    #[test]
    fn test_file_detail_header() {
        let mut overlay = make_overlay(
            "src/lib.rs",
            vec![make_change("foo", ChangeType::BodyChanged)],
        );
        overlay.symbol_changes[0].diff_lines = super::super::parse::parse_unified_diff(
            "diff --git a/x b/x\n@@ -42 +42,2 @@\n-z\n+x\n+y\n"
        ).remove(0).hunks.remove(0).lines;
        let out = format_file_detail(&overlay, None);
        assert!(out.starts_with("# Diff: src/lib.rs"), "bad header:\n{out}");
        assert!(out.contains("+2"), "missing insertions:\n{out}");
        assert!(out.contains('1'), "missing deletions:\n{out}");
    }

    // 11. File detail — +/-/space prefixes with line numbers
    #[test]
    fn test_file_detail_diff_lines() {
        let mut overlay = make_overlay(
            "src/lib.rs",
            vec![make_change("foo", ChangeType::BodyChanged)],
        );
        overlay.symbol_changes[0].diff_lines = super::super::parse::parse_unified_diff(
            "diff --git a/x b/x\n@@ -42,2 +42,2 @@\n-removed line\n+added line\n context line\n"
        ).remove(0).hunks.remove(0).lines;
        let out = format_file_detail(&overlay, None);
        assert!(out.contains('+'), "missing + prefix:\n{out}");
        assert!(out.contains('-'), "missing - prefix:\n{out}");
        assert!(out.contains("added line"), "missing added line:\n{out}");
        assert!(out.contains("removed line"), "missing removed line:\n{out}");
        assert!(out.contains("context line"), "missing context line:\n{out}");
    }

    // 12. File detail — BEFORE/AFTER labels for sig change
    #[test]
    fn test_file_detail_before_after() {
        let overlay = make_overlay(
            "src/lib.rs",
            vec![make_sig_change("foo", "foo(x: i32)", "foo(x: i64)")],
        );
        let out = format_file_detail(&overlay, None);
        assert!(out.contains("BEFORE:"), "missing BEFORE:\n{out}");
        assert!(out.contains("AFTER:"), "missing AFTER:\n{out}");
        assert!(out.contains("foo(x: i32)"), "missing old sig:\n{out}");
        assert!(out.contains("foo(x: i64)"), "missing new sig:\n{out}");
    }

    // 13. File detail — [ ] marker for unchanged symbols
    #[test]
    fn test_file_detail_unchanged_context() {
        let changes = vec![
            make_change("fn_changed", ChangeType::BodyChanged),
            make_change("fn_unchanged", ChangeType::Unchanged),
        ];
        let overlay = make_overlay("src/lib.rs", changes);
        let out = format_file_detail(&overlay, None);
        assert!(
            out.contains("[ ] fn_unchanged"),
            "missing unchanged marker:\n{out}"
        );
        assert!(out.contains("unchanged"), "missing unchanged label:\n{out}");
    }

    // 14. Function detail — correct name and content
    #[test]
    fn test_function_detail_found() {
        let mut overlay = make_overlay(
            "src/lib.rs",
            vec![make_change("my_fn", ChangeType::BodyChanged)],
        );
        overlay.symbol_changes[0].diff_lines = super::super::parse::parse_unified_diff(
            "diff --git a/x b/x\n@@ -42,0 +42 @@\n+new code\n"
        ).remove(0).hunks.remove(0).lines;
        let out = format_function_detail(&overlay, "my_fn");
        assert!(out.contains("my_fn"), "missing fn name:\n{out}");
        assert!(out.contains("new code"), "missing diff content:\n{out}");
        assert!(!out.contains("not found"), "unexpected 'not found':\n{out}");
    }

    // 15. Function detail — "not found" message
    #[test]
    fn test_function_detail_not_found() {
        let overlay = make_overlay("src/lib.rs", vec![]);
        let out = format_function_detail(&overlay, "nonexistent");
        assert!(out.contains("not found"), "expected 'not found':\n{out}");
        assert!(out.contains("nonexistent"), "missing fn name:\n{out}");
    }

    // 16. Conflict format — ours/theirs with enclosing function
    #[test]
    fn test_conflict_format() {
        let conflicts = vec![Conflict {
            line: 42,
            ours: "let x = 1;".to_string(),
            theirs: "let x = 2;".to_string(),
            enclosing_fn: Some("compute".to_string()),
        }];
        let path = PathBuf::from("src/lib.rs");
        let out = format_conflicts(&conflicts, &path);
        assert!(out.starts_with("# Conflicts:"), "bad header:\n{out}");
        assert!(out.contains("compute"), "missing fn name:\n{out}");
        assert!(out.contains("L42"), "missing line number:\n{out}");
        assert!(out.contains("OURS:"), "missing OURS:\n{out}");
        assert!(out.contains("THEIRS:"), "missing THEIRS:\n{out}");
        assert!(out.contains("let x = 1;"), "missing ours content:\n{out}");
        assert!(out.contains("let x = 2;"), "missing theirs content:\n{out}");
    }

    // 17. Log format — per-commit with function markers
    #[test]
    fn test_log_format() {
        use crate::diff::CommitSummary;
        let overlay = make_overlay("src/lib.rs", vec![make_change("foo", ChangeType::Added)]);
        let summary = CommitSummary {
            hash: "abc1234def".to_string(),
            timestamp: 0,
            message: "add foo".to_string(),
            author: "alice".to_string(),
            overlays: vec![overlay],
        };
        let out = format_log(&[summary], "HEAD~1..HEAD", None);
        assert!(out.starts_with("# Log:"), "bad header:\n{out}");
        assert!(out.contains("abc1234"), "missing short hash:\n{out}");
        assert!(out.contains("add foo"), "missing commit message:\n{out}");
        assert!(out.contains("@alice"), "missing author:\n{out}");
        assert!(out.contains("[+]"), "missing marker:\n{out}");
        assert!(out.contains("foo"), "missing fn name:\n{out}");
    }

    // 18. count_insertions_deletions — correct counting
    #[test]
    fn test_count_insertions_deletions() {
        let mut overlay = make_overlay("src/lib.rs", vec![]);
        overlay.unattributed_lines = super::super::parse::parse_unified_diff(
            "diff --git a/x b/x\n@@ -42,3 +42,3 @@\n-c\n-e\n+a\n+b\n d\n"
        ).remove(0).hunks.remove(0).lines;
        let (ins, del) = count_insertions_deletions(&overlay);
        assert_eq!(ins, 2, "insertions: {ins}");
        assert_eq!(del, 2, "deletions: {del}");
    }
}
