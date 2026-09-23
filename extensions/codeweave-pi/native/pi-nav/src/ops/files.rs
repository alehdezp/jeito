use std::cmp::Ordering;
use std::fmt::Write as _;
use std::path::Path;

use crate::dispatch::OperationContext;
use crate::output::{FileEntry, IncompleteReason, PatternInfo, ToolOutput};
use globset::Glob;
use serde_json::{json, Value};

use super::resolve_scope;

// A safety bound for retained metadata before filtering/sorting. It is not a
// latency target; reaching it returns honest candidate-cap incompleteness.
const MAX_FIND_WALK_ENTRIES: usize = 100_000;

#[cfg(test)]
pub(crate) fn tool_files(
    args: &Value,
    context: Option<&OperationContext>,
) -> Result<String, String> {
    tool_files_output(args, context).map(|output| output.text)
}

#[cfg(test)]
thread_local! { static TEST_WALK_INVOCATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

pub(crate) fn tool_files_output(
    args: &Value,
    context: Option<&OperationContext>,
) -> Result<ToolOutput, String> {
    if let Some(context) = context {
        context.check().map_err(|error| error.to_string())?;
    }
    if let Some(policy) = args.get("corpusPolicy") {
        return corpus_census(args, policy, context);
    }
    let root = args.get("root").and_then(Value::as_str).map(Path::new);
    let (scope, warning) = resolve_scope(args, root)?;
    let patterns = input_patterns(args)?;
    let visibility =
        crate::walk::Visibility::parse(args.get("visibility").and_then(Value::as_str))?;
    let kind = args.get("type").and_then(Value::as_str).unwrap_or("any");
    if !matches!(kind, "any" | "file" | "directory") {
        return Err(format!(
            "type must be any, file, or directory; got {kind:?}"
        ));
    }
    let sort = args.get("sort").and_then(Value::as_str).unwrap_or("mtime");
    if !matches!(sort, "mtime" | "path") {
        return Err(format!("sort must be mtime or path; got {sort:?}"));
    }
    let matchers = patterns
        .iter()
        .map(|pattern| FileMatcher::parse(pattern))
        .collect::<Result<Vec<_>, _>>()?;
    let pattern_info: Vec<_> = matchers.iter().map(FileMatcher::info).collect();
    #[cfg(test)]
    TEST_WALK_INVOCATIONS.with(|count| count.set(count.get() + 1));
    let report = crate::walk::walk(
        &scope,
        &crate::walk::WalkOptions {
            visibility,
            policy_root: None,
            min_depth: 1,
            max_depth: None,
            patterns: Vec::new(),
            deadline: context.and_then(|value| value.deadline),
            cancelled: context.map(|value| value.cancelled.clone()),
            candidate_cap: Some(MAX_FIND_WALK_ENTRIES),
        },
    )?;
    let policy = report.policy.clone();
    let mut complete_scan = report.complete;
    let mut stop_reason = report.reason;
    let diagnostics = report.diagnostics;
    let (mut entries, filter_stop) = filter_entries(report.entries, kind, &matchers, context);
    if let Some(reason) = filter_stop {
        complete_scan = false;
        stop_reason = Some(reason);
    }
    if sort == "path" {
        entries.sort_by(|left, right| left.0.path.cmp(&right.0.path));
    } else {
        entries.sort_by(|left, right| mtime_path_order(&left.0, &right.0));
    }
    if let Some(reason) = context_stop_reason(context) {
        complete_scan = false;
        stop_reason = Some(reason);
    }
    let budget = crate::budget::clamp(
        args.get("budget")
            .and_then(Value::as_u64)
            .unwrap_or(crate::budget::DEFAULT_BUDGET),
    );
    let total = entries.len();
    let mut output = warning.unwrap_or_default();
    let _ = writeln!(
        output,
        "# Files: {} pattern(s), {} matches — {}",
        patterns.len(),
        total,
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
        output,
        "Filter: {filter_label} · {} excluded",
        policy.excluded
    );
    let mut metadata_entries = Vec::new();
    for (entry, matched) in entries {
        if let Some(reason) = context_stop_reason(context) {
            complete_scan = false;
            stop_reason = Some(reason);
            break;
        }
        let line = format!(
            "{}  {}  [{}]\n",
            entry.path.display(),
            entry_kind(entry.kind),
            matched.join(", ")
        );
        if crate::types::estimate_tokens((output.len() + line.len()) as u64) > budget {
            let _ = writeln!(
                output,
                "… truncated ({} entries omitted, budget: {budget})",
                total.saturating_sub(metadata_entries.len())
            );
            break;
        }
        output.push_str(&line);
        let metadata_path = root_relative(&scope.join(&entry.path), root);
        metadata_entries.push(FileEntry {
            path: metadata_path.to_string_lossy().replace('\\', "/"),
            kind: entry_kind(entry.kind),
            depth: metadata_path.components().count(),
            size: entry.size,
            token_estimate: entry.token_estimate,
            modified_ms: entry
                .modified_ns
                .and_then(|value| u64::try_from(value / 1_000_000).ok()),
            matched_patterns: Some(matched),
        });
    }
    if !complete_scan {
        output = output.replacen("— complete", "— incomplete", 1);
    }
    let returned = metadata_entries.len();
    let data = json!({ "patterns": pattern_info, "sort": sort, "visibility": visibility_name(visibility), "filter": policy, "entries": metadata_entries });
    if complete_scan {
        Ok(ToolOutput::bounded(
            "pi_nav_files",
            output,
            data,
            returned,
            total,
            budget,
        ))
    } else {
        Ok(ToolOutput::incomplete(
            "pi_nav_files",
            output,
            data,
            returned,
            stop_reason.map_or(IncompleteReason::Error, Into::into),
            diagnostics,
        ))
    }
}

/// Private read-only admission boundary for the supervised analysis candidate.
/// Never budget-trim a census: missing paths would silently change its corpus.
fn corpus_census(
    args: &Value,
    policy: &Value,
    context: Option<&OperationContext>,
) -> Result<ToolOutput, String> {
    let root = args
        .get("root")
        .and_then(Value::as_str)
        .ok_or("corpus root required")?;
    let root = Path::new(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let policy: crate::walk::CorpusPolicy = serde_json::from_value(policy.clone())
        .map_err(|error| format!("invalid corpus policy: {error}"))?;
    // `all` census is explicit: it still answers from the owning-project root
    // with the same boundary and symlink guards, but ignores configurable
    // ignore files. The reply names that visibility so a native that ignored it
    // cannot silently narrow the admission set.
    let visibility = crate::walk::Visibility::parse(args.get("visibility").and_then(Value::as_str))?;
    let cap = match args.get("maxEntries") {
        None => MAX_FIND_WALK_ENTRIES,
        Some(value) => value
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| (1..=MAX_FIND_WALK_ENTRIES).contains(value))
            .ok_or("maxEntries must be an integer in 1..=100000")?,
    };
    let options = crate::walk::WalkOptions {
        visibility,
        policy_root: Some(root.clone()),
        deadline: context.and_then(|value| value.deadline),
        cancelled: context.map(|value| value.cancelled.clone()),
        candidate_cap: Some(cap),
        ..crate::walk::WalkOptions::default()
    };
    let report = if visibility == crate::walk::Visibility::All {
        crate::walk::walk(&root, &options)?
    } else {
        crate::walk::walk_corpus(&root, &options, &policy)?
    };
    if !report.complete {
        return Err(format!(
            "corpus census incomplete ({:?}); no admission set returned",
            report.reason
        ));
    }
    let mut files = Vec::new();
    let mut directories = vec![String::new()];
    for entry in report.entries {
        let path = entry
            .path
            .to_str()
            .ok_or("non-UTF-8 corpus path")?
            .replace(std::path::MAIN_SEPARATOR, "/");
        match entry.kind {
            crate::walk::EntryKind::File => files.push(path),
            crate::walk::EntryKind::Directory => directories.push(path),
            // The bounded all walk lists aliases without following them. Omit
            // those entries, not unrelated admissible files in the same census.
            crate::walk::EntryKind::Symlink if visibility == crate::walk::Visibility::All => continue,
            crate::walk::EntryKind::Symlink => {
                return Err("corpus census returned a symbolic link".into())
            }
        }
    }
    files.sort();
    files.dedup();
    directories.sort();
    directories.dedup();
    let count = files.len();
    let mut data = json!({ "corpusPolicyVersion": 1, "root": root, "files": files, "directories": directories, "visited": report.visited });
    if visibility == crate::walk::Visibility::All {
        data["corpusVisibility"] = json!("all");
    }
    let output = ToolOutput::complete(
        "pi_nav_files",
        format!("Corpus census: {count} admitted files"),
        data,
        count,
        count,
    );
    // Stay below the existing native transport bound; do not add a second limit owner.
    if output.structured.to_string().len() > 240 * 1024 {
        return Err(
            "corpus census exceeds native transport capacity; no admission set returned".into(),
        );
    }
    Ok(output)
}

fn filter_entries(
    entries: Vec<crate::walk::WalkEntry>,
    kind: &str,
    matchers: &[FileMatcher],
    context: Option<&OperationContext>,
) -> (
    Vec<(crate::walk::WalkEntry, Vec<String>)>,
    Option<crate::walk::StopReason>,
) {
    let includes = matchers.iter().any(|matcher| !matcher.exclude);
    let mut filtered = Vec::new();
    for entry in entries {
        if let Some(reason) = context_stop_reason(context) {
            return (filtered, Some(reason));
        }
        if kind == "file" && entry.kind != crate::walk::EntryKind::File {
            continue;
        }
        if kind == "directory" && entry.kind != crate::walk::EntryKind::Directory {
            continue;
        }
        let matched: Vec<String> = matchers
            .iter()
            .filter(|matcher| !matcher.exclude && matcher.matches(&entry.path))
            .map(|matcher| matcher.input.clone())
            .collect();
        let excluded = matchers
            .iter()
            .any(|matcher| matcher.exclude && matcher.matches(&entry.path));
        if (!includes || !matched.is_empty()) && !excluded {
            filtered.push((entry, matched));
        }
    }
    (filtered, None)
}

fn context_stop_reason(context: Option<&OperationContext>) -> Option<crate::walk::StopReason> {
    match context?.check().err()? {
        crate::dispatch::NativeError::Cancelled => Some(crate::walk::StopReason::Cancelled),
        crate::dispatch::NativeError::Deadline => Some(crate::walk::StopReason::Deadline),
        _ => Some(crate::walk::StopReason::Error),
    }
}

fn mtime_path_order(left: &crate::walk::WalkEntry, right: &crate::walk::WalkEntry) -> Ordering {
    match (left.modified_ns, right.modified_ns) {
        (Some(left_mtime), Some(right_mtime)) => right_mtime
            .cmp(&left_mtime)
            .then_with(|| left.path.cmp(&right.path)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => left.path.cmp(&right.path),
    }
}

struct FileMatcher {
    input: String,
    normalized: String,
    exclude: bool,
    kind: MatcherKind,
}
enum MatcherKind {
    Glob(globset::GlobMatcher),
    Filename(String),
    Substring(String),
}

impl FileMatcher {
    fn parse(input: &str) -> Result<Self, String> {
        if input.is_empty() {
            return Err("patterns must not contain empty strings".into());
        }
        let original = input.to_string();
        let (exclude, input) = input
            .strip_prefix('!')
            .map_or((false, input), |value| (true, value));
        if input.is_empty() {
            return Err("exclusion pattern must not be empty".into());
        }
        let normalized = input.replace('\\', "/");
        let has_glob = normalized.contains(['*', '?', '[', '{']);
        let kind = if has_glob {
            MatcherKind::Glob(
                Glob::new(&normalized)
                    .map_err(|error| format!("invalid glob {input:?}: {error}"))?
                    .compile_matcher(),
            )
        } else if !normalized.contains('/') && normalized.contains('.') {
            MatcherKind::Filename(normalized.clone())
        } else {
            MatcherKind::Substring(normalized.clone())
        };
        Ok(Self {
            input: original,
            normalized,
            exclude,
            kind,
        })
    }

    fn matches(&self, path: &Path) -> bool {
        let path = path.to_string_lossy().replace('\\', "/");
        match &self.kind {
            MatcherKind::Glob(glob) if self.normalized.contains('/') => glob.is_match(&path),
            MatcherKind::Glob(glob) => path
                .rsplit('/')
                .next()
                .is_some_and(|name| glob.is_match(name)),
            MatcherKind::Filename(name) => path.rsplit('/').next() == Some(name),
            MatcherKind::Substring(needle) => path.contains(needle),
        }
    }

    fn info(&self) -> PatternInfo {
        PatternInfo {
            input: self.input.clone(),
            normalized: self.normalized.clone(),
            kind: if self.exclude {
                "exclude"
            } else {
                match self.kind {
                    MatcherKind::Glob(_) => "glob",
                    MatcherKind::Filename(_) => "filename",
                    MatcherKind::Substring(_) => "substring",
                }
            },
        }
    }
}

fn input_patterns(args: &Value) -> Result<Vec<String>, String> {
    let single = args.get("pattern").and_then(Value::as_str);
    let multiple = args.get("patterns").and_then(Value::as_array);
    if single.is_some() && multiple.is_some() {
        return Err("provide either pattern or patterns, not both".into());
    }
    let patterns = match multiple {
        Some(values) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("patterns must be an array of strings")
            })
            .collect::<Result<Vec<_>, _>>()?,
        None => single
            .map(str::to_owned)
            .map_or_else(|| vec!["*".into()], |value| vec![value]),
    };
    if patterns.is_empty() {
        return Err("patterns must contain at least one item".into());
    }
    if patterns.len() > 20 {
        return Err(format!(
            "patterns limited to 20 per call (got {})",
            patterns.len()
        ));
    }
    Ok(patterns)
}

fn entry_kind(kind: crate::walk::EntryKind) -> &'static str {
    match kind {
        crate::walk::EntryKind::File => "file",
        crate::walk::EntryKind::Directory => "directory",
        crate::walk::EntryKind::Symlink => "symlink",
    }
}

fn root_relative(path: &Path, root: Option<&Path>) -> std::path::PathBuf {
    let canonical_path = path.canonicalize().ok();
    let canonical_root = root.and_then(|root| root.canonicalize().ok());
    canonical_root
        .as_deref()
        .and_then(|root| {
            canonical_path
                .as_deref()
                .unwrap_or(path)
                .strip_prefix(root)
                .ok()
        })
        .unwrap_or_else(|| canonical_path.as_deref().unwrap_or(path))
        .to_path_buf()
}

fn visibility_name(visibility: crate::walk::Visibility) -> &'static str {
    match visibility {
        crate::walk::Visibility::Project => "project",
        crate::walk::Visibility::All => "all",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a small scratch project with .rs and .toml files and return the
    /// tempdir guard so the caller controls cleanup.
    fn scratch_project() -> tempfile::TempDir {
        let project = tempfile::tempdir().unwrap();
        let p = project.path();
        std::fs::write(p.join("Cargo.toml"), "[package]\nname = \"t\"").unwrap();
        std::fs::create_dir(p.join("src")).unwrap();
        std::fs::write(p.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(p.join("src/lib.rs"), "pub fn x() {}").unwrap();
        project
    }

    #[test]
    fn tool_files_batch_patterns_share_one_result_set() {
        let project = scratch_project();
        let args = serde_json::json!({
            "patterns": ["*.rs", "*.toml"],
            "scope": project.path().to_str().unwrap(),
        });
        let out = tool_files(&args, None).expect("tool_files should succeed");
        assert!(
            out.starts_with("# Files: 2 pattern(s), 3 matches — complete"),
            "unexpected output: {out}"
        );
        assert!(
            out.contains("main.rs  file  [*.rs]"),
            "missing rs match: {out}"
        );
        assert!(
            out.contains("Cargo.toml  file  [*.toml]"),
            "missing toml match: {out}"
        );
    }

    #[test]
    fn tool_files_pattern_and_patterns_mutually_exclusive() {
        let args = serde_json::json!({
            "pattern": "*.rs",
            "patterns": ["*.rs"],
            "scope": env!("CARGO_MANIFEST_DIR"),
        });
        let err = tool_files(&args, None).expect_err("expected mutual-exclusion error");
        assert!(err.contains("either pattern"), "unexpected error: {err}");
    }

    #[test]
    fn tool_files_empty_patterns_errors() {
        let args = serde_json::json!({ "patterns": [], "scope": env!("CARGO_MANIFEST_DIR") });
        let err = tool_files(&args, None).expect_err("expected empty-patterns error");
        assert!(err.contains("at least one"), "unexpected error: {err}");
    }

    #[test]
    fn tool_files_patterns_capped_at_20() {
        let twenty_one: Vec<&str> = vec!["*.rs"; 21];
        let args =
            serde_json::json!({ "patterns": twenty_one, "scope": env!("CARGO_MANIFEST_DIR") });
        let err = tool_files(&args, None).expect_err("expected cap error");
        assert!(err.contains("limited to 20"), "unexpected error: {err}");
    }

    #[test]
    fn tool_files_missing_pattern_defaults_to_all_entries() {
        let project = scratch_project();
        let args = serde_json::json!({ "scope": project.path() });
        let out = tool_files(&args, None).expect("omitted pattern defaults to all entries");
        assert!(out.contains("main.rs"), "unexpected output: {out}");
    }

    #[test]
    fn no_scope_no_root_defaults_to_cwd() {
        // WHY: the require-root discipline fires ONLY when a caller EXPLICITLY
        // passes a relative scope without an absolute root. A bare
        // `pi_nav_files(patterns)` call with no scope is the default flow of
        // every session and must keep working exactly as it does on main —
        // not refuse. This inverts the PR's original (too strict) assertion.
        let args = serde_json::json!({ "patterns": ["*.rs"] });
        let out = tool_files(&args, None).expect("bare files call must default to cwd, not refuse");
        // Doesn't assert on file contents (cwd varies by test runner), just that
        // the call succeeds and doesn't route through the require-root refusal.
        assert!(
            !out.contains("cannot be resolved"),
            "unexpected refusal: {out}"
        );
    }

    #[test]
    fn explicit_relative_scope_no_root_errors() {
        // An EXPLICITLY passed relative scope with no absolute root to anchor it
        // is unresolvable (the server cannot see the caller's shell cwd) — this
        // must still refuse.
        let args = serde_json::json!({ "patterns": ["*.rs"], "scope": "some/relative/dir" });
        let err =
            tool_files(&args, None).expect_err("explicit relative scope must refuse without root");
        assert!(
            err.contains("relative scope") && err.contains("root"),
            "explicit relative scope without root must refuse: {err}"
        );
    }

    #[test]
    fn relative_scope_absolute_root_resolves() {
        // Regression guard: a relative scope anchored to an absolute root must
        // resolve under root (not error), so the refusal above is scoped to the
        // unresolvable case only.
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("a.rs"), "fn a() {}\n").unwrap();
        let args = serde_json::json!({
            "patterns": ["*.rs"],
            "scope": "sub",
            "root": tmp.path().to_str().unwrap(),
        });
        let out = tool_files(&args, None).expect("relative scope + absolute root resolves");
        assert!(
            out.contains("a.rs"),
            "expected listing under anchored root: {out}"
        );
    }

    #[test]
    fn structured_files_classifier_dedup_sort_and_totals() {
        let project = scratch_project();
        let args = serde_json::json!({
            "root": project.path(), "scope": ".", "patterns": ["src", "*.rs", "!lib.rs"],
            "visibility": "all", "sort": "path", "type": "any"
        });
        let walks_before = TEST_WALK_INVOCATIONS.with(std::cell::Cell::get);
        let output = tool_files_output(&args, None).unwrap();
        assert_eq!(
            TEST_WALK_INVOCATIONS.with(std::cell::Cell::get),
            walks_before + 1,
            "batch patterns must share one walk"
        );
        let entries = output.structured["data"]["entries"].as_array().unwrap();
        let paths: Vec<_> = entries
            .iter()
            .filter_map(|entry| entry["path"].as_str())
            .collect();
        assert_eq!(
            paths.iter().filter(|path| **path == "src/main.rs").count(),
            1
        );
        assert!(paths.contains(&"src"));
        assert!(!paths.contains(&"src/lib.rs"));
        assert_eq!(output.structured["data"]["sort"], "path");
        assert_eq!(output.structured["data"]["visibility"], "all");
        assert_eq!(output.structured["completeness"]["complete"], true);
        assert!(entries
            .iter()
            .find(|entry| entry["path"] == "src/main.rs")
            .unwrap()["matchedPatterns"]
            .as_array()
            .is_some_and(|patterns| patterns.len() == 2));

        let exclusion_only =
            serde_json::json!({ "root": project.path(), "patterns": ["!*.toml"], "sort": "path" });
        let output = tool_files_output(&exclusion_only, None).unwrap();
        assert!(output.structured["data"]["entries"]
            .as_array()
            .is_some_and(|entries| entries.iter().any(|entry| entry["path"] == "src/main.rs")));
    }

    #[test]
    fn cancelled_post_walk_filter_returns_no_entries() {
        let project = scratch_project();
        let context = OperationContext {
            root: project.path().canonicalize().unwrap(),
            deadline: None,
            cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            confine_to_root: false,
            read_format: crate::dispatch::ReadFormat::Plain,
        };
        let entries = vec![crate::walk::WalkEntry {
            path: std::path::PathBuf::from("src/main.rs"),
            kind: crate::walk::EntryKind::File,
            size: 0,
            modified_ns: None,
            token_estimate: 0,
        }];
        let matchers = vec![FileMatcher::parse("*.rs").unwrap()];

        let (filtered, reason) = filter_entries(entries, "file", &matchers, Some(&context));

        assert!(filtered.is_empty());
        assert_eq!(reason, Some(crate::walk::StopReason::Cancelled));
    }

    #[test]
    fn mtime_sort_puts_missing_last_and_breaks_ties_by_path() {
        let entry = |path: &str, modified_ns| crate::walk::WalkEntry {
            path: std::path::PathBuf::from(path),
            kind: crate::walk::EntryKind::File,
            size: 0,
            modified_ns,
            token_estimate: 0,
        };
        assert_eq!(
            mtime_path_order(&entry("a", Some(1)), &entry("b", None)),
            Ordering::Less
        );
        assert_eq!(
            mtime_path_order(&entry("b", None), &entry("a", Some(1))),
            Ordering::Greater
        );
        assert_eq!(
            mtime_path_order(&entry("b", Some(1)), &entry("a", Some(1))),
            Ordering::Greater
        );
        assert_eq!(
            mtime_path_order(&entry("b", None), &entry("a", None)),
            Ordering::Greater
        );
    }

    #[cfg(unix)]
    #[test]
    fn structured_files_can_return_symlinks() {
        use std::os::unix::fs::symlink;
        let project = scratch_project();
        symlink(
            project.path().join("src/main.rs"),
            project.path().join("src/link.rs"),
        )
        .unwrap();
        let output = tool_files_output(&serde_json::json!({ "root": project.path(), "pattern": "link.rs", "visibility": "all", "sort": "path" }), None).unwrap();
        assert!(output.structured["data"]["entries"]
            .as_array()
            .is_some_and(|entries| entries.len() == 1 && entries[0]["kind"] == "symlink"));
    }

    #[test]
    fn all_visibility_corpus_census_is_explicit_and_keeps_owner_boundaries() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join(".pi/navigation")).unwrap();
        std::fs::write(root.join(".pi-navigation.json"), "{}").unwrap();
        for relative in [
            "src/allowed.ts",
            "src/sub/deep.ts",
            "src/child/hidden.ts",
            "src/git-child/hidden.ts",
            "node_modules/pkg/index.ts",
            ".pi/navigation/state.ts",
        ] {
            let path = root.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "token\n").unwrap();
        }
        std::fs::write(root.join("src/child/.pi-navigation.json"), "{}").unwrap();
        std::fs::create_dir(root.join("src/git-child/.git")).unwrap();
        let policy = || {
            serde_json::json!({ "version": 1, "globalRules": [], "projectRules": [], "excludedPrefixes": [] })
        };
        let widened = tool_files_output(
            &serde_json::json!({ "root": root, "corpusPolicy": policy(), "visibility": "all", "maxEntries": 1000 }),
            None,
        )
        .unwrap();
        let data = &widened.structured["data"];
        assert_eq!(data["corpusVisibility"], serde_json::json!("all"));
        assert_eq!(data["corpusPolicyVersion"], serde_json::json!(1));
        let files: Vec<&str> = data["files"].as_array().unwrap().iter().map(|value| value.as_str().unwrap()).collect();
        for present in ["src/allowed.ts", "src/sub/deep.ts", "node_modules/pkg/index.ts"] {
            assert!(files.contains(&present), "widened census is missing {present}: {files:?}");
        }
        for absent in ["src/child/hidden.ts", "src/git-child/hidden.ts", ".pi/navigation/state.ts"] {
            assert!(!files.contains(&absent), "widened census crossed a boundary with {absent}: {files:?}");
        }
        // The project default is unchanged and carries no widened acknowledgement.
        let default_census = tool_files_output(
            &serde_json::json!({ "root": root, "corpusPolicy": policy(), "maxEntries": 1000 }),
            None,
        )
        .unwrap();
        let default_data = &default_census.structured["data"];
        assert!(default_data.get("corpusVisibility").is_none(), "project census must not claim widened visibility");
        let default_files: Vec<&str> = default_data["files"].as_array().unwrap().iter().map(|value| value.as_str().unwrap()).collect();
        assert!(!default_files.contains(&"node_modules/pkg/index.ts"), "{default_files:?}");
        // A widened census that cannot finish still refuses instead of publishing a partial set.
        let capped = tool_files_output(
            &serde_json::json!({ "root": root, "corpusPolicy": policy(), "visibility": "all", "maxEntries": 1 }),
            None,
        )
        .unwrap_err();
        assert!(capped.contains("corpus census incomplete"), "{capped}");
        // Neither file nor directory aliases may be followed, but their presence
        // must not erase independently admitted ordinary files.
        let linked = tempfile::tempdir().unwrap();
        let linked_root = linked.path().canonicalize().unwrap();
        std::fs::create_dir(linked_root.join(".git")).unwrap();
        std::fs::write(linked_root.join("target.ts"), "token\n").unwrap();
        std::os::unix::fs::symlink(linked_root.join("target.ts"), linked_root.join("link.ts")).unwrap();
        std::os::unix::fs::symlink(&root, linked_root.join("directory-link")).unwrap();
        let linked_census = tool_files_output(
            &serde_json::json!({ "root": linked_root, "corpusPolicy": policy(), "visibility": "all", "maxEntries": 1000 }),
            None,
        )
        .unwrap();
        assert_eq!(linked_census.structured["data"]["files"], serde_json::json!(["target.ts"]));
        assert_eq!(linked_census.structured["data"]["directories"], serde_json::json!([""]));
    }
}
