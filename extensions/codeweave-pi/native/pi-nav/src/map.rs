use std::collections::BTreeMap;
use std::fmt::Write;
use std::path::{Path, PathBuf};

use crate::cache::OutlineCache;
use crate::lang::detect_file_type;
use crate::read::outline;
use crate::types::{estimate_tokens, FileType};
use crate::walk::{builder, Visibility};
use serde::Serialize;

/// Generate a structural codebase map.
/// Code files show symbol names from outline cache.
/// Non-code files show name + token estimate.
#[must_use]
pub fn generate(scope: &Path, depth: usize, budget: Option<u64>, cache: &OutlineCache) -> String {
    generate_typed(scope, depth, budget, cache, None).text
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MapSymbol {
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) start: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) end: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MapEntry {
    pub(crate) path: String,
    pub(crate) kind: &'static str,
    pub(crate) token_estimate: u64,
    pub(crate) symbols: Vec<MapSymbol>,
}

pub(crate) struct MapOutput {
    pub(crate) text: String,
    pub(crate) entries: Vec<MapEntry>,
    pub(crate) complete: bool,
    pub(crate) reason: Option<crate::walk::StopReason>,
    pub(crate) diagnostics: Vec<String>,
}

pub(crate) fn generate_typed(
    scope: &Path,
    depth: usize,
    budget: Option<u64>,
    cache: &OutlineCache,
    context: Option<&crate::dispatch::OperationContext>,
) -> MapOutput {
    let mut tree: BTreeMap<PathBuf, Vec<TreeFileEntry>> = BTreeMap::new();
    let mut entries = Vec::new();
    let mut complete = true;
    let mut reason = None;
    let mut diagnostics = Vec::new();
    let metadata_root = context.map_or(scope, |context| context.root.as_path());
    let walker = builder(scope, Visibility::Project)
        .max_depth(Some(depth + 1))
        .build();

    for item in walker {
        if let Some(context) = context {
            if let Err(error) = context.check() {
                complete = false;
                reason = Some(
                    if matches!(error, crate::dispatch::NativeError::Cancelled) {
                        crate::walk::StopReason::Cancelled
                    } else {
                        crate::walk::StopReason::Deadline
                    },
                );
                diagnostics.push(error.to_string());
                break;
            }
        }
        let Ok(entry) = item else {
            diagnostics.push("map traversal skipped an unreadable entry".into());
            continue;
        };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.path();
        let rel = path.strip_prefix(scope).unwrap_or(path);
        let file_depth = rel.components().count().saturating_sub(1);
        if file_depth > depth {
            continue;
        }
        let parent = rel.parent().unwrap_or(Path::new("")).to_path_buf();
        let name = rel
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_string();
        let meta = std::fs::metadata(path).ok();
        let byte_len = meta.as_ref().map_or(0, std::fs::Metadata::len);
        let tokens = estimate_tokens(byte_len);
        let file_type = detect_file_type(path);
        let typed_symbols = match file_type {
            FileType::Code(lang) => std::fs::read_to_string(path)
                .ok()
                .map(|content| {
                    let mut symbols = Vec::new();
                    collect_outline_symbols(
                        &crate::lang::outline::get_outline_entries(&content, lang),
                        &mut symbols,
                    );
                    symbols
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        let symbols = match file_type {
            FileType::Code(_) => {
                let mtime = meta
                    .and_then(|value| value.modified().ok())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                let outline = cache.get_or_compute(path, mtime, || {
                    let content = std::fs::read_to_string(path).unwrap_or_default();
                    outline::generate(path, file_type, &content, content.as_bytes(), true)
                });
                Some(extract_symbol_names(&outline))
            }
            _ => None,
        };
        tree.entry(parent.clone()).or_default().push(TreeFileEntry {
            name,
            symbols,
            tokens,
        });
        entries.push(MapEntry {
            path: root_relative(path, metadata_root),
            kind: "file",
            token_estimate: tokens,
            symbols: typed_symbols,
        });
        let mut ancestor = parent.parent();
        while let Some(value) = ancestor {
            tree.entry(value.to_path_buf()).or_default();
            if value == Path::new("") {
                break;
            }
            ancestor = value.parent();
        }
    }
    let totals = compute_dir_totals(&tree);
    for (path, tokens) in &totals {
        if !path.as_os_str().is_empty() {
            entries.push(MapEntry {
                path: root_relative(&scope.join(path), metadata_root),
                kind: "directory",
                token_estimate: *tokens,
                symbols: Vec::new(),
            });
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let mut text = format!("# Map: {} (depth {})\n", scope.display(), depth);
    format_tree(&tree, &totals, Path::new(""), 0, &mut text);
    if let Some(budget) = budget {
        text = crate::budget::apply(&text, budget);
    }
    MapOutput {
        text,
        entries,
        complete,
        reason,
        diagnostics,
    }
}

fn root_relative(path: &Path, root: &Path) -> String {
    let canonical_path = path.canonicalize().ok();
    let canonical_root = root.canonicalize().ok();
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
        .to_string_lossy()
        .replace('\\', "/")
}

fn collect_outline_symbols(source: &[crate::types::OutlineEntry], out: &mut Vec<MapSymbol>) {
    for entry in source {
        out.push(MapSymbol {
            name: entry.name.clone(),
            start: Some(entry.start_line),
            end: Some(entry.end_line),
        });
        collect_outline_symbols(&entry.children, out);
    }
}

/// Sum tokens for every directory in the tree, including the implicit root
/// (`Path::new("")`). Each directory's total is the sum of its own files
/// plus the totals of all descendants. Computed by walking each directory's
/// direct files and folding their byte total into every ancestor.
fn compute_dir_totals(tree: &BTreeMap<PathBuf, Vec<TreeFileEntry>>) -> BTreeMap<PathBuf, u64> {
    let mut totals: BTreeMap<PathBuf, u64> = BTreeMap::new();
    for (dir, files) in tree {
        let sum: u64 = files.iter().map(|f| f.tokens).sum();
        if sum == 0 {
            // Still need to seed the entry so format_tree can render the dir.
            totals.entry(dir.clone()).or_insert(0);
            continue;
        }
        let mut cur: Option<&Path> = Some(dir.as_path());
        while let Some(p) = cur {
            *totals.entry(p.to_path_buf()).or_insert(0) += sum;
            if p == Path::new("") {
                break;
            }
            cur = p.parent();
        }
    }
    totals
}

/// Compact human token count for directory rollups.
/// Uses the same scale as `pi_nav_files` output (`12.3k`, `1.2M`).
///
/// The k→M switchover triggers at `999_950` rather than `1_000_000` so values
/// that would round to `"1000.0k"` under `{:.1}` formatting roll cleanly into
/// the M tier (`"1.0M"`) instead of producing four-digit k labels.
fn fmt_tokens(n: u64) -> String {
    #[allow(clippy::cast_precision_loss)] // display-only; mantissa loss is fine for summaries
    let f = n as f64;
    if f >= 999_950.0 {
        format!("{:.1}M", f / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", f / 1_000.0)
    } else {
        n.to_string()
    }
}

struct TreeFileEntry {
    name: String,
    symbols: Option<Vec<String>>,
    tokens: u64,
}

/// Extract symbol names from an outline string.
/// Outline lines look like: `[7-57]       fn classify`
/// We extract the last word(s) after the kind keyword.
fn extract_symbol_names(outline: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in outline.lines() {
        let trimmed = line.trim();
        // Skip import lines and empty lines
        if trimmed.starts_with('[') {
            // Find the symbol name after kind keywords
            if let Some(sig_start) = find_symbol_start(trimmed) {
                let sig = &trimmed[sig_start..];
                // Take just the name (up to first paren or space after name)
                let name = extract_name_from_sig(sig);
                if !name.is_empty() && name != "imports" {
                    names.push(name);
                }
            }
        }
    }
    names
}

fn find_symbol_start(line: &str) -> Option<usize> {
    let kinds = [
        "fn ",
        "struct ",
        "enum ",
        "trait ",
        "impl ",
        "mod ",
        "class ",
        "interface ",
        "type ",
        "const ",
        "static ",
        "function ",
        "method ",
        "def ",
    ];
    for kind in &kinds {
        if let Some(pos) = line.find(kind) {
            return Some(pos + kind.len());
        }
    }
    None
}

fn extract_name_from_sig(sig: &str) -> String {
    // Take characters until we hit a non-identifier char
    sig.chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
        .collect()
}

fn format_tree(
    tree: &BTreeMap<PathBuf, Vec<TreeFileEntry>>,
    totals: &BTreeMap<PathBuf, u64>,
    dir: &Path,
    indent: usize,
    out: &mut String,
) {
    // Collect subdirectories that have entries
    let mut subdirs: Vec<&PathBuf> = tree
        .keys()
        .filter(|k| k.parent() == Some(dir) && *k != dir)
        .collect();
    subdirs.sort();

    let prefix = "  ".repeat(indent);

    // Show files in this directory
    if let Some(files) = tree.get(dir) {
        for f in files {
            if let Some(ref symbols) = f.symbols {
                if symbols.is_empty() {
                    let _ = writeln!(out, "{prefix}{} (~{} tokens)", f.name, f.tokens);
                } else {
                    let syms = symbols.join(", ");
                    let truncated = if syms.len() > 80 {
                        format!("{}...", crate::types::truncate_str(&syms, 77))
                    } else {
                        syms
                    };
                    let _ = writeln!(out, "{prefix}{}: {truncated}", f.name);
                }
            } else {
                let _ = writeln!(out, "{prefix}{} (~{} tokens)", f.name, f.tokens);
            }
        }
    }

    // Recurse into subdirectories — annotate with cumulative token rollup so
    // agents can triage which subtrees are worth descending into.
    for subdir in subdirs {
        let dir_name = subdir.file_name().and_then(|n| n.to_str()).unwrap_or("?");
        let total = totals.get(subdir).copied().unwrap_or(0);
        let _ = writeln!(out, "{prefix}{dir_name}/ (~{} tokens)", fmt_tokens(total));
        format_tree(tree, totals, subdir, indent + 1, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, tokens: u64) -> TreeFileEntry {
        TreeFileEntry {
            name: name.to_string(),
            symbols: None,
            tokens,
        }
    }

    #[test]
    fn rollup_sums_descendants_into_each_ancestor() {
        // Layout:
        //   src/lang/  (file_a 100, file_b 50)        → 150
        //   src/search/ (file_c 200)                  → 200
        //   src/  (only subdirs, no direct files)     → 350
        //   ""    (root)                              → 350
        let mut tree: BTreeMap<PathBuf, Vec<TreeFileEntry>> = BTreeMap::new();
        tree.insert(PathBuf::from(""), vec![]);
        tree.insert(PathBuf::from("src"), vec![]);
        tree.insert(
            PathBuf::from("src/lang"),
            vec![entry("a.rs", 100), entry("b.rs", 50)],
        );
        tree.insert(PathBuf::from("src/search"), vec![entry("c.rs", 200)]);

        let totals = compute_dir_totals(&tree);
        assert_eq!(totals.get(&PathBuf::from("src/lang")).copied(), Some(150));
        assert_eq!(totals.get(&PathBuf::from("src/search")).copied(), Some(200));
        assert_eq!(totals.get(&PathBuf::from("src")).copied(), Some(350));
        assert_eq!(totals.get(&PathBuf::from("")).copied(), Some(350));
    }

    #[test]
    fn rollup_handles_empty_directories() {
        let mut tree: BTreeMap<PathBuf, Vec<TreeFileEntry>> = BTreeMap::new();
        tree.insert(PathBuf::from("empty"), vec![]);
        let totals = compute_dir_totals(&tree);
        assert_eq!(totals.get(&PathBuf::from("empty")).copied(), Some(0));
    }

    #[test]
    fn fmt_tokens_thresholds() {
        assert_eq!(fmt_tokens(0), "0");
        assert_eq!(fmt_tokens(999), "999");
        assert_eq!(fmt_tokens(1_000), "1.0k");
        assert_eq!(fmt_tokens(12_345), "12.3k");
        assert_eq!(fmt_tokens(1_000_000), "1.0M");
        assert_eq!(fmt_tokens(2_500_000), "2.5M");
    }

    /// Boundary: values that would round to "1000.0k" under `{:.1}`
    /// formatting must roll over to the M tier instead of producing a
    /// four-digit k label.
    #[test]
    fn fmt_tokens_rolls_over_at_999_950() {
        // Just below the rollover boundary — still formats as k.
        assert_eq!(fmt_tokens(999_949), "999.9k");
        // At and above the boundary — formats as M, not "1000.0k".
        assert_eq!(fmt_tokens(999_950), "1.0M");
        assert_eq!(fmt_tokens(999_999), "1.0M");
        assert_eq!(fmt_tokens(1_499_999), "1.5M");
    }

    #[test]
    fn format_tree_renders_dir_rollups_alongside_files() {
        let mut tree: BTreeMap<PathBuf, Vec<TreeFileEntry>> = BTreeMap::new();
        tree.insert(PathBuf::from(""), vec![entry("README.md", 800)]);
        tree.insert(PathBuf::from("src"), vec![entry("main.rs", 4_200)]);
        let totals = compute_dir_totals(&tree);

        let mut out = String::new();
        format_tree(&tree, &totals, Path::new(""), 0, &mut out);

        assert!(out.contains("README.md (~800 tokens)"));
        // Subdir line: only main.rs lives under src/, so the rollup must
        // be exactly 4.2k. The previous OR-form hid the dead branch.
        assert!(
            out.contains("src/ (~4.2k tokens)"),
            "expected exact 'src/ (~4.2k tokens)' rollup, got: {out}"
        );
    }
}
