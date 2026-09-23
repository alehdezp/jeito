use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::dispatch::OperationContext;
use crate::output::{FileEntry, IncompleteReason, ToolOutput};
use crate::walk::{self, EntryKind, Visibility, WalkEntry, WalkOptions};

use super::resolve_scope;

#[cfg(test)]
pub(crate) fn tool_ls(args: &Value, context: &OperationContext) -> Result<String, String> {
    tool_ls_output(args, context).map(|output| output.text)
}

pub(crate) fn tool_ls_output(
    args: &Value,
    context: &OperationContext,
) -> Result<ToolOutput, String> {
    context.check().map_err(|error| error.to_string())?;
    let root = args.get("root").and_then(Value::as_str).map(Path::new);
    let (scope, warning) = match args.get("path").and_then(Value::as_str) {
        Some(path) => {
            let path = super::resolve_read_path(Path::new(path), root)?;
            if !path.is_dir() {
                return Err(format!("path is not a directory: {}", path.display()));
            }
            (path, None)
        }
        None => resolve_scope(args, root)?,
    };
    let view = args.get("view").and_then(Value::as_str).unwrap_or("list");
    if !matches!(view, "list" | "tree") {
        return Err(format!("view must be list or tree; got {view:?}"));
    }
    let requested_depth = args.get("depth").and_then(Value::as_u64);
    if view == "list" && requested_depth.is_some() {
        return Err("depth is only valid with view=tree".into());
    }
    let depth = if view == "tree" {
        let depth = requested_depth.unwrap_or(2);
        if !(1..=8).contains(&depth) {
            return Err("tree depth must be between 1 and 8".into());
        }
        depth as usize
    } else {
        1
    };
    let sort = args
        .get("sort")
        .and_then(Value::as_str)
        .unwrap_or(if view == "list" { "mtime" } else { "path" });
    if !matches!(sort, "mtime" | "path") {
        return Err(format!("sort must be mtime or path; got {sort:?}"));
    }
    let visibility = Visibility::parse(args.get("visibility").and_then(Value::as_str))?;
    let patterns = match args.get("glob") {
        None => Vec::new(),
        Some(Value::String(pattern)) if !pattern.is_empty() => vec![pattern.clone()],
        Some(Value::String(_)) => return Err("glob must not be empty".into()),
        Some(_) => return Err("glob must be a string".into()),
    };
    let report = walk::walk(
        &scope,
        &WalkOptions {
            visibility,
            policy_root: None,
            min_depth: 1,
            max_depth: Some(depth),
            patterns,
            deadline: context.deadline,
            cancelled: Some(context.cancelled.clone()),
            candidate_cap: None,
        },
    )?;
    let policy = report.policy.clone();
    let complete_scan = report.complete;
    let stop_reason = report.reason;
    let diagnostics = report.diagnostics;
    let entries = if view == "tree" {
        tree_order(report.entries, sort)
    } else {
        let mut entries = report.entries;
        if sort == "path" {
            entries.sort_by(|left, right| left.path.cmp(&right.path));
        } else {
            entries.sort_by(mtime_then_path);
        }
        entries
    };
    let budget = crate::budget::clamp(
        args.get("budget")
            .and_then(Value::as_u64)
            .unwrap_or(crate::budget::DEFAULT_BUDGET),
    );
    let total_entries = entries.len();
    let mut text = warning.unwrap_or_default();
    let _ = writeln!(
        text,
        "# Directory: {} — live filesystem, {}",
        scope.display(),
        if complete_scan {
            "complete"
        } else {
            "incomplete"
        }
    );
    let filter_label = if policy.custom_override {
        "project · .pi/navigation/ignore layered · gitignore respected"
    } else if policy.source == "gitignore" {
        "project · .gitignore active"
    } else if policy.visibility == "all" {
        "all · configurable ignore files disabled · safety exclusions remain"
    } else {
        "project · no project ignore file"
    };
    let _ = writeln!(
        text,
        "Filter: {filter_label} · {} excluded",
        policy.excluded
    );
    let file_count = entries
        .iter()
        .filter(|entry| entry.kind == EntryKind::File)
        .count();
    let directory_count = entries
        .iter()
        .filter(|entry| entry.kind == EntryKind::Directory)
        .count();
    let suffix = if complete_scan {
        String::new()
    } else {
        format!(", traversal stopped: {}", stop_reason_name(stop_reason))
    };
    let _ = writeln!(
        text,
        "# {file_count} files, {directory_count} directories{suffix} — sorted by {sort}\n"
    );
    let mut displayed = Vec::new();
    if view == "tree" {
        for group in subtree_groups(&entries) {
            let block: String = group
                .iter()
                .map(|entry| render_entry(entry, true))
                .collect();
            if crate::types::estimate_tokens((text.len() + block.len()) as u64) > budget {
                continue;
            }
            text.push_str(&block);
            displayed.extend(group);
        }
    } else {
        for entry in &entries {
            let line = render_entry(entry, false);
            if crate::types::estimate_tokens((text.len() + line.len()) as u64) > budget {
                break;
            }
            text.push_str(&line);
            displayed.push(entry);
        }
    }
    if displayed.len() < total_entries {
        let _ = writeln!(
            text,
            "… truncated ({} entries omitted, budget: {budget})",
            total_entries - displayed.len()
        );
    }
    let metadata_entries: Vec<_> = displayed
        .iter()
        .map(|entry| metadata_entry(entry, &scope, &context.root))
        .collect();
    let relative_scope = scope
        .strip_prefix(&context.root)
        .unwrap_or(&scope)
        .to_string_lossy()
        .replace('\\', "/");
    let returned = metadata_entries.len();
    let data = json!({
        "path": if relative_scope.is_empty() { "." } else { relative_scope.as_str() },
        "view": view,
        "depth": if view == "tree" { Some(depth) } else { None },
        "sort": sort,
        "visibility": visibility_name(visibility),
        "filter": policy,
        "entries": metadata_entries,
    });
    if complete_scan {
        if view == "tree" {
            let group_depth = scope
                .strip_prefix(&context.root)
                .unwrap_or(Path::new(""))
                .components()
                .count();
            Ok(ToolOutput::bounded_entry_groups(
                "pi_nav_ls",
                text,
                data,
                returned,
                total_entries,
                budget,
                group_depth,
            ))
        } else {
            Ok(ToolOutput::bounded(
                "pi_nav_ls",
                text,
                data,
                returned,
                total_entries,
                budget,
            ))
        }
    } else {
        Ok(ToolOutput::incomplete(
            "pi_nav_ls",
            text,
            data,
            returned,
            stop_reason.map_or(IncompleteReason::Error, Into::into),
            diagnostics,
        ))
    }
}

fn mtime_then_path(left: &WalkEntry, right: &WalkEntry) -> Ordering {
    match (left.modified_ns, right.modified_ns) {
        (Some(left_mtime), Some(right_mtime)) => right_mtime
            .cmp(&left_mtime)
            .then_with(|| left.path.cmp(&right.path)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => left.path.cmp(&right.path),
    }
}

fn render_entry(entry: &WalkEntry, tree: bool) -> String {
    let indent = if tree {
        "  ".repeat(entry.path.components().count().saturating_sub(1))
    } else {
        String::new()
    };
    let suffix = match entry.kind {
        EntryKind::File => format!("~{} tokens", entry.token_estimate),
        EntryKind::Directory => "directory".into(),
        EntryKind::Symlink => "symlink".into(),
    };
    format!("{indent}{}  {suffix}\n", entry.path.display())
}

fn visit_tree(
    parent: &Path,
    sort: &str,
    by_parent: &mut BTreeMap<PathBuf, Vec<WalkEntry>>,
    output: &mut Vec<WalkEntry>,
) {
    let mut children = by_parent.remove(parent).unwrap_or_default();
    if sort == "mtime" {
        children.sort_by(mtime_then_path);
    } else {
        children.sort_by(|left, right| left.path.cmp(&right.path));
    }
    for child in children {
        let child_path = child.path.clone();
        let recurse = child.kind == EntryKind::Directory;
        output.push(child);
        if recurse {
            visit_tree(&child_path, sort, by_parent, output);
        }
    }
}

fn tree_order(entries: Vec<WalkEntry>, sort: &str) -> Vec<WalkEntry> {
    let mut by_parent: BTreeMap<PathBuf, Vec<WalkEntry>> = BTreeMap::new();
    for entry in entries {
        by_parent
            .entry(entry.path.parent().unwrap_or(Path::new("")).to_path_buf())
            .or_default()
            .push(entry);
    }
    let mut ordered = Vec::new();
    visit_tree(Path::new(""), sort, &mut by_parent, &mut ordered);
    ordered
}

fn subtree_groups(entries: &[WalkEntry]) -> Vec<Vec<&WalkEntry>> {
    let mut groups: Vec<Vec<&WalkEntry>> = Vec::new();
    let mut current_root: Option<std::ffi::OsString> = None;
    for entry in entries {
        let root = entry
            .path
            .components()
            .next()
            .map(|component| component.as_os_str().to_os_string())
            .unwrap_or_default();
        if current_root.as_ref() != Some(&root) {
            groups.push(Vec::new());
            current_root = Some(root);
        }
        groups.last_mut().expect("group exists").push(entry);
    }
    groups
}

fn metadata_entry(entry: &WalkEntry, scope: &Path, root: &Path) -> FileEntry {
    let absolute = scope.join(&entry.path);
    let relative = absolute.strip_prefix(root).unwrap_or(&absolute);
    FileEntry {
        path: relative.to_string_lossy().replace('\\', "/"),
        kind: match entry.kind {
            EntryKind::File => "file",
            EntryKind::Directory => "directory",
            EntryKind::Symlink => "symlink",
        },
        depth: relative.components().count(),
        size: entry.size,
        token_estimate: entry.token_estimate,
        modified_ms: entry
            .modified_ns
            .and_then(|value| u64::try_from(value / 1_000_000).ok()),
        matched_patterns: None,
    }
}

fn visibility_name(visibility: Visibility) -> &'static str {
    match visibility {
        Visibility::Project => "project",
        Visibility::All => "all",
    }
}

fn stop_reason_name(reason: Option<walk::StopReason>) -> &'static str {
    match reason {
        Some(walk::StopReason::Deadline) => "deadline",
        Some(walk::StopReason::Cancelled) => "cancelled",
        Some(walk::StopReason::CandidateCap) => "candidate_cap",
        Some(walk::StopReason::Error) => "error",
        None => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::{NativeSession, ReadFormat};

    fn context(root: &Path) -> OperationContext {
        let session = NativeSession::new(root, false).expect("native session");
        OperationContext::for_session(&session, ReadFormat::Plain, true)
    }

    #[test]
    fn list_is_immediate_and_rejects_depth() {
        let root = tempfile::tempdir().expect("fixture");
        std::fs::write(root.path().join("top.rs"), "fn top() {}\n").expect("top");
        std::fs::create_dir(root.path().join("nested")).expect("nested");
        std::fs::write(root.path().join("nested/deep.rs"), "fn deep() {}\n").expect("deep");
        let context = context(root.path());
        let output = tool_ls(&serde_json::json!({"root": root.path()}), &context).expect("list");
        assert!(output.contains("top.rs"));
        assert!(!output.contains("deep.rs"));
        assert!(tool_ls(
            &serde_json::json!({"root": root.path(), "depth": 2}),
            &context
        )
        .is_err());
    }

    #[test]
    fn tree_honors_depth() {
        let root = tempfile::tempdir().expect("fixture");
        std::fs::create_dir(root.path().join("nested")).expect("nested");
        std::fs::write(root.path().join("nested/deep.rs"), "fn deep() {}\n").expect("deep");
        let context = context(root.path());
        let shallow = tool_ls(
            &serde_json::json!({"root": root.path(), "view": "tree", "depth": 1}),
            &context,
        )
        .expect("tree");
        assert!(shallow.contains("nested"));
        assert!(!shallow.contains("deep.rs"));
        let deep = tool_ls(
            &serde_json::json!({"root": root.path(), "view": "tree", "depth": 2}),
            &context,
        )
        .expect("tree");
        assert!(deep.contains("deep.rs"));
    }

    #[test]
    fn structured_ls_tree_budget_keeps_whole_top_level_subtrees() {
        let root = tempfile::tempdir().unwrap();
        for directory in ["alpha", "beta"] {
            std::fs::create_dir(root.path().join(directory)).unwrap();
            for index in 0..8 {
                std::fs::write(
                    root.path().join(directory).join(format!("file_{index}.rs")),
                    "fn value() {}\n",
                )
                .unwrap();
            }
        }
        let context = context(root.path());
        let output = tool_ls_output(&serde_json::json!({ "root": root.path(), "view": "tree", "depth": 2, "sort": "path", "budget": 90 }), &context).unwrap();
        let entries = output.structured["data"]["entries"].as_array().unwrap();
        for directory in ["alpha", "beta"] {
            let child_present = entries.iter().any(|entry| {
                entry["path"]
                    .as_str()
                    .is_some_and(|path| path.starts_with(&format!("{directory}/")))
            });
            let parent_present = entries.iter().any(|entry| entry["path"] == directory);
            assert_eq!(
                child_present, parent_present,
                "subtree must be retained or omitted as a whole"
            );
        }
        assert_eq!(output.structured["data"]["view"], "tree");
        assert_eq!(output.structured["data"]["depth"], 2);
        assert!(
            output.structured["completeness"]["total"].as_u64().unwrap() >= entries.len() as u64
        );
    }
}
