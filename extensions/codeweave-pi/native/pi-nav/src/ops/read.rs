use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::cache::OutlineCache;
use crate::error::TilthError;
use crate::lang::detect_file_type;
use crate::lang::outline::get_outline_entries;
use crate::output::{
    IncompleteReason, ItemCompleteness, OutlineEntry as OutputOutlineEntry, SourceRow, ToolOutput,
};
use crate::session::Session;
use crate::source_proof::snapshot_text;
use crate::types::{estimate_tokens, FileType, OutlineEntry, ViewMode};

use super::apply_budget;

#[cfg(test)]
static DUPLICATE_PATH_COUNT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(test)]
static CANONICAL_ALIAS_COUNT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
pub(crate) fn tool_read(
    args: &Value,
    cache: &OutlineCache,
    session: &Session,
    edit_mode: bool,
) -> Result<String, String> {
    tool_read_context(args, cache, session, edit_mode, None).map(|prepared| prepared.text)
}

#[derive(Debug)]
struct PreparedSourceFile {
    path: PathBuf,
    text: String,
}

#[derive(Debug)]
struct PreparedReadOutput {
    text: String,
    files: Vec<PreparedSourceFile>,
    partial_reason: Option<IncompleteReason>,
}

fn tool_read_context(
    args: &Value,
    cache: &OutlineCache,
    session: &Session,
    edit_mode: bool,
    context: Option<&crate::dispatch::OperationContext>,
) -> Result<PreparedReadOutput, String> {
    let budget = args.get("budget").and_then(serde_json::Value::as_u64);
    let root = args.get("root").and_then(Value::as_str).map(Path::new);
    let full_flag = args.get("full").and_then(Value::as_bool).unwrap_or(false);
    let mode_str = args.get("mode").and_then(Value::as_str).unwrap_or("auto");
    if !matches!(mode_str, "auto" | "full" | "signature" | "stripped") {
        return Err(format!(
            "unknown read mode: {mode_str}. Use: auto, full, signature, stripped"
        ));
    }
    let force_full = full_flag || mode_str == "full";
    let force_signature = mode_str == "signature";
    let force_stripped = mode_str == "stripped";

    if let Some(paths_arr) = args.get("paths").and_then(Value::as_array) {
        if paths_arr.len() > 20 {
            return Err(format!(
                "batch read limited to 20 files (got {})",
                paths_arr.len()
            ));
        }
        let mut prepared_by_path: HashMap<PathBuf, Result<(String, Option<String>), String>> =
            HashMap::new();
        let mut first_raw_by_path: HashMap<PathBuf, String> = HashMap::new();
        let adapter_deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(
                std::env::var("PI_NAV_BATCH_TIMEOUT")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(60),
            );
        let deadline = context
            .and_then(|value| value.deadline)
            .map_or(adapter_deadline, |value| value.min(adapter_deadline));
        let mut results = Vec::with_capacity(paths_arr.len());
        let mut files = Vec::new();
        let mut partial_reason = None;
        for (index, value) in paths_arr.iter().enumerate() {
            let cancelled = context
                .is_some_and(|value| value.cancelled.load(std::sync::atomic::Ordering::Relaxed));
            if cancelled || std::time::Instant::now() >= deadline {
                partial_reason = Some(if cancelled {
                    IncompleteReason::Cancelled
                } else {
                    IncompleteReason::Deadline
                });
                results.push(format!(
                    "# batch read stopped — deadline or cancellation after {index}/{} files.",
                    paths_arr.len()
                ));
                break;
            }
            let path_str = value.as_str().ok_or("paths must be an array of strings")?;
            let path = super::resolve_read_path(&PathBuf::from(path_str), root)?;
            session.record_read(&path);
            let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
            let prepared = if let Some(cached) = prepared_by_path.get(&canonical) {
                #[cfg(test)]
                DUPLICATE_PATH_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                #[cfg(test)]
                if first_raw_by_path
                    .get(&canonical)
                    .is_some_and(|first| first != path_str)
                {
                    CANONICAL_ALIAS_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                cached.clone()
            } else {
                first_raw_by_path.insert(canonical.clone(), path_str.to_string());
                let result = if force_signature {
                    read_signature_file(&path, cache).map(|(body, _, text)| (body, Some(text)))
                } else if force_stripped {
                    read_stripped_file(&path, cache).map(|(body, _, _, text)| (body, Some(text)))
                } else {
                    crate::read::read_file_prepared(&path, None, force_full, cache, edit_mode)
                        .map(|prepared| (prepared.rendered, prepared.source_text))
                }
                .map_err(|error| error.to_string());
                prepared_by_path.insert(canonical, result.clone());
                result
            };
            match prepared {
                Ok((output, source_text)) => {
                    results.push(output);
                    if let Some(text) = source_text {
                        files.push(PreparedSourceFile { path, text });
                    }
                }
                Err(error) => results.push(format!("# {} — error: {error}", path.display())),
            }
        }
        return Ok(PreparedReadOutput {
            text: apply_budget(&results.join("\n\n"), budget),
            files,
            partial_reason,
        });
    }

    let path_str = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("missing required parameter: path (or use paths for batch read)")?;
    let path = super::resolve_read_path(&PathBuf::from(path_str), root)?;
    let section = args.get("section").and_then(Value::as_str);
    let sections_arr = args.get("sections").and_then(Value::as_array);
    if section.is_some() && sections_arr.is_some() {
        return Err("provide either section (single) or sections (array), not both".into());
    }
    if (force_signature || force_stripped) && (section.is_some() || sections_arr.is_some()) {
        return Err(format!("mode={mode_str} cannot be combined with section/sections — {mode_str} reshapes the whole file. Drop section/sections or pick mode=auto/full."));
    }

    if let Some(arr) = sections_arr {
        let ranges: Vec<&str> = arr
            .iter()
            .map(|value| value.as_str().ok_or("sections must be an array of strings"))
            .collect::<Result<_, _>>()?;
        if ranges.is_empty() || ranges.len() > 20 {
            return Err(if ranges.is_empty() {
                "sections must contain at least one range".into()
            } else {
                format!("sections limited to 20 per call (got {})", ranges.len())
            });
        }
        session.record_read(&path);
        let bytes =
            crate::read::read_current_bytes(&path, true).map_err(|error| error.to_string())?;
        let output = crate::read::read_ranges_from_bytes(&path, &bytes, &ranges, edit_mode, budget)
            .map_err(|error| error.to_string())?;
        let files = String::from_utf8(bytes)
            .ok()
            .map(|text| vec![PreparedSourceFile { path, text }])
            .unwrap_or_default();
        return Ok(PreparedReadOutput {
            text: output,
            files,
            partial_reason: None,
        });
    }

    session.record_read(&path);
    let auto_read = section.is_none() && !force_signature && !force_stripped && !force_full;
    let savings_baseline = auto_read
        .then(|| std::fs::metadata(&path).map(|metadata| metadata.len()).ok())
        .flatten();
    let (mut output, source_text) = if section.is_none() && force_signature {
        read_signature_file(&path, cache)
            .map(|(body, _, text)| (body, Some(text)))
            .map_err(|error| error.to_string())?
    } else if section.is_none() && force_stripped {
        read_stripped_file(&path, cache)
            .map(|(body, _, _, text)| (body, Some(text)))
            .map_err(|error| error.to_string())?
    } else {
        let prepared =
            crate::read::read_file_prepared(&path, section, force_full, cache, edit_mode)
                .map_err(|error| error.to_string())?;
        (prepared.rendered, prepared.source_text)
    };

    if section.is_none() && crate::read::would_outline(&path) {
        if let Some(text) = source_text.as_deref() {
            let related = crate::read::imports::resolve_related_files_with_content(&path, text);
            if !related.is_empty() {
                output.push_str("\n\n> Related: ");
                for (index, related_path) in related.iter().enumerate() {
                    if index > 0 {
                        output.push_str(", ");
                    }
                    let _ = write!(output, "{}", related_path.display());
                }
            }
        }
    }
    let response = apply_budget(&output, budget);
    if let Some(file_byte_len) = savings_baseline {
        session.record_savings(
            estimate_tokens(file_byte_len),
            estimate_tokens(response.len() as u64),
        );
    }
    let files = source_text
        .map(|text| vec![PreparedSourceFile { path, text }])
        .unwrap_or_default();
    Ok(PreparedReadOutput {
        text: response,
        files,
        partial_reason: None,
    })
}

fn markdown_structure_output(
    args: &Value,
    session: &Session,
    context: &crate::dispatch::OperationContext,
) -> Result<ToolOutput, String> {
    context.check().map_err(|error| error.to_string())?;
    let root = args.get("root").and_then(Value::as_str).map(Path::new);
    let path_str = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("missing required parameter: path")?;
    let path = super::resolve_read_path(&PathBuf::from(path_str), root)?;
    if !matches!(detect_file_type(&path), FileType::Markdown) {
        return Err("markdownStructure requires a Markdown file".into());
    }
    session.record_read(&path);
    let bytes = crate::read::read_current_bytes(&path, true).map_err(|error| error.to_string())?;
    let content = std::str::from_utf8(&bytes).map_err(|_| "Markdown file is not valid UTF-8")?;
    let mut data = markdown_projection(args, &relative_path(&path, root), content)?;
    data["files"][0]["sourceHash"] = json!(format!("{:x}", Sha256::digest(&bytes)));
    Ok(ToolOutput::bounded("pi_nav_read", String::new(), data, 1, 1, crate::budget::DEFAULT_BUDGET))
}

/// Pure structure of supplied text; deliberately no filesystem or source proof.
pub(crate) fn markdown_projection(args: &Value, path: &str, content: &str) -> Result<Value, String> {
    let structure = crate::read::outline::markdown::structure(content)
        .ok_or("could not parse Markdown structure")?;
    let selector = args.get("selector").and_then(Value::as_str);
    let byte_offset = args.get("byteOffset").and_then(Value::as_u64);
    if selector.is_some() && byte_offset.is_some() {
        return Err("provide either selector or byteOffset, not both".into());
    }
    let owner = if let Some(selector) = selector {
        Some(
            crate::read::outline::markdown::section_by_selector(&structure, selector)
                .ok_or_else(|| format!("Markdown section not found: {selector}"))?,
        )
    } else if let Some(byte_offset) = byte_offset {
        crate::read::outline::markdown::owner_at_byte(&structure, byte_offset as usize)
    } else {
        None
    };
    let mut ancestors = Vec::new();
    let mut parent = owner.and_then(|section| section.parent.as_deref());
    while let Some(parent_selector) = parent {
        let Some(section) =
            crate::read::outline::markdown::section_by_selector(&structure, parent_selector)
        else {
            break;
        };
        ancestors.push(json!({
            "selector": section.selector,
            "title": section.title,
            "level": section.level,
        }));
        parent = section.parent.as_deref();
    }
    ancestors.reverse();
    let include_sections = args
        .get("includeSections")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let data = json!({
        "files": [{
            "path": path,
            "totalLines": structure.total_lines,
            "codeBlockCount": structure.code_block_count,
            "owner": owner.map(|section| json!({
                "section": section,
                "ancestors": ancestors,
            })),
            "sections": include_sections.then_some(&structure.sections),
        }],
    });
    Ok(data)
}

pub(crate) fn tool_read_output(
    args: &Value,
    cache: &OutlineCache,
    session: &Session,
    edit_mode: bool,
    context: &crate::dispatch::OperationContext,
) -> Result<ToolOutput, String> {
    if args
        .get("markdownStructure")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return markdown_structure_output(args, session, context);
    }
    let prepared = tool_read_context(args, cache, session, edit_mode, Some(context))?;
    let text = prepared.text;
    let root = args.get("root").and_then(Value::as_str).map(Path::new);
    let budget = crate::budget::clamp(
        args.get("budget")
            .and_then(Value::as_u64)
            .unwrap_or(crate::budget::DEFAULT_BUDGET),
    );
    let mode = args.get("mode").and_then(Value::as_str).unwrap_or("auto");
    let force_full = args.get("full").and_then(Value::as_bool).unwrap_or(false) || mode == "full";
    let mut files = Vec::new();
    let mut partial_reason = prepared.partial_reason;
    let mut source_snapshots = Vec::new();
    let mut snapshot_paths = HashSet::new();
    for prepared_file in prepared.files {
        if let Err(error) = context.check() {
            partial_reason = Some(
                if matches!(error, crate::dispatch::NativeError::Cancelled) {
                    IncompleteReason::Cancelled
                } else {
                    IncompleteReason::Deadline
                },
            );
            break;
        }
        let path = prepared_file.path;
        let content = prepared_file.text;
        let lines: Vec<&str> = content.lines().collect();
        let total_lines = lines.len();
        let explicit_ranges = selected_ranges(args, total_lines);
        let small_full = estimate_tokens(content.len() as u64) <= crate::read::TOKEN_THRESHOLD;
        let view = if args.get("section").is_some() || args.get("sections").is_some() {
            "section"
        } else if mode == "signature" {
            "signature"
        } else if mode == "stripped" {
            "stripped"
        } else if force_full || small_full {
            "full"
        } else {
            "outline"
        };
        let max_source_bytes = budget.saturating_sub(50).saturating_mul(4) as usize;
        let mut source_rows = Vec::new();
        if matches!(view, "full" | "section") {
            let ranges = explicit_ranges.unwrap_or_else(|| vec![(1usize, total_lines)]);
            let mut used = 0usize;
            'ranges: for (start, end) in ranges {
                for line_number in start..=end.min(total_lines) {
                    let line = lines
                        .get(line_number.saturating_sub(1))
                        .copied()
                        .unwrap_or("");
                    let cost = line.len().saturating_add(1);
                    if used.saturating_add(cost) > max_source_bytes {
                        partial_reason = Some(IncompleteReason::Budget);
                        break 'ranges;
                    }
                    used += cost;
                    source_rows.push(SourceRow {
                        path: relative_path(&path, root),
                        line: line_number as u32,
                        text: line.to_string(),
                        visibility: "visible_complete",
                        transformation: "verbatim",
                    });
                }
            }
        }
        if !source_rows.is_empty() {
            let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
            if snapshot_paths.insert(canonical.clone()) {
                source_snapshots.push(snapshot_text(&canonical, content.clone()));
            }
        }
        let mut outline_entries = Vec::new();
        if let FileType::Code(language) = detect_file_type(&path) {
            flatten_outline(
                &get_outline_entries(&content, language),
                &relative_path(&path, root),
                &mut outline_entries,
            );
        }
        let file_returned = if matches!(view, "full" | "section") {
            source_rows.len()
        } else {
            outline_entries.len()
        };
        let file_complete = partial_reason.is_none();
        let total = if matches!(view, "full" | "section") {
            total_lines
        } else {
            outline_entries.len()
        };
        files.push(json!({
            "path": relative_path(&path, root),
            "view": view,
            "totalLines": total_lines,
            "outlineEntries": outline_entries,
            "sourceRows": source_rows,
            "completeness": ItemCompleteness {
                complete: file_complete,
                returned: file_returned,
                total: file_complete.then_some(total),
                reason: partial_reason,
            },
        }));
    }
    let returned_files = files.len();
    let data = json!({ "files": files });
    let output = if let Some(reason) = partial_reason {
        ToolOutput::incomplete(
            "pi_nav_read",
            text,
            data,
            returned_files,
            reason,
            vec!["read output contains a bounded prefix".into()],
        )
    } else {
        ToolOutput::bounded(
            "pi_nav_read",
            text,
            data,
            returned_files,
            returned_files,
            budget,
        )
    };
    Ok(output.with_source_snapshots(source_snapshots))
}

fn relative_path(path: &Path, root: Option<&Path>) -> String {
    root.and_then(|root| path.strip_prefix(root).ok())
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn flatten_outline(entries: &[OutlineEntry], path: &str, output: &mut Vec<OutputOutlineEntry>) {
    for entry in entries {
        output.push(OutputOutlineEntry {
            path: path.to_string(),
            start: entry.start_line,
            end: entry.end_line,
            label: entry.name.clone(),
            kind: Some(format!("{:?}", entry.kind).to_lowercase()),
        });
        flatten_outline(&entry.children, path, output);
    }
}

fn selected_ranges(args: &Value, total: usize) -> Option<Vec<(usize, usize)>> {
    let raw: Vec<&str> = if let Some(section) = args.get("section").and_then(Value::as_str) {
        vec![section]
    } else {
        args.get("sections")
            .and_then(Value::as_array)?
            .iter()
            .filter_map(Value::as_str)
            .collect()
    };
    let mut ranges = Vec::new();
    for value in raw {
        let (start, end) = value.split_once('-')?;
        let start = start.trim().parse::<usize>().ok()?;
        let end = end.trim().parse::<usize>().ok()?;
        if start == 0 || start > end {
            return None;
        }
        ranges.push((start, end.min(total)));
    }
    Some(ranges)
}

// `cache` is intentionally unwired on the tree-sitter path: OutlineCache stores
// formatted outline strings, not Vec<OutlineEntry>, so get_outline_entries below
// re-parses every call. Wiring a structured cache is a separate change. The param
// is still used by the non-code fallback (read_file), so it keeps its real name.
fn read_signature_file(
    path: &Path,
    cache: &OutlineCache,
) -> Result<(String, u32, String), TilthError> {
    let content = std::fs::read_to_string(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => TilthError::NotFound {
            path: path.to_path_buf(),
            suggestion: None,
        },
        std::io::ErrorKind::PermissionDenied => TilthError::PermissionDenied {
            path: path.to_path_buf(),
        },
        _ => TilthError::IoError {
            path: path.to_path_buf(),
            source: error,
        },
    })?;
    let meta = std::fs::metadata(path).map_err(|source| TilthError::IoError {
        path: path.to_path_buf(),
        source,
    })?;
    let line_count = u32::try_from(content.lines().count()).unwrap_or(u32::MAX);
    let FileType::Code(lang) = detect_file_type(path) else {
        let body = crate::read::read_file(path, None, false, cache, false)?;
        return Ok((body, line_count, content));
    };
    let header = crate::format::file_header(path, meta.len(), line_count, ViewMode::Signature);
    let entries = get_outline_entries(&content, lang);
    let lines: Vec<&str> = content.lines().collect();
    let mut body = String::new();
    render_signature_entries(&entries, &lines, &mut body);
    if body.is_empty() {
        body = crate::format::hashlines(&content, 1);
    }
    Ok((
        format!("{header}\n\n{}", body.trim_end()),
        line_count,
        content,
    ))
}
fn render_signature_entries(entries: &[OutlineEntry], lines: &[&str], out: &mut String) {
    for entry in entries {
        let idx = entry.start_line.saturating_sub(1) as usize;
        if let Some(line) = lines.get(idx) {
            let hash = crate::format::line_hash(line.as_bytes());
            let _ = writeln!(out, "{}:{hash:03x}|{line}", entry.start_line);
        }
        render_signature_entries(&entry.children, lines, out);
    }
}

// `cache` is intentionally unwired on the tree-sitter path: OutlineCache stores
// formatted outline strings, not Vec<OutlineEntry>, so strip_noise re-parses every
// call. Wiring a structured cache is a separate change. The param is still used by
// the non-code fallback (read_file), so it keeps its real name.
fn read_stripped_file(
    path: &Path,
    cache: &OutlineCache,
) -> Result<(String, u32, u32, String), TilthError> {
    let content = std::fs::read_to_string(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => TilthError::NotFound {
            path: path.to_path_buf(),
            suggestion: None,
        },
        std::io::ErrorKind::PermissionDenied => TilthError::PermissionDenied {
            path: path.to_path_buf(),
        },
        _ => TilthError::IoError {
            path: path.to_path_buf(),
            source: e,
        },
    })?;
    let meta = std::fs::metadata(path).map_err(|e| TilthError::IoError {
        path: path.to_path_buf(),
        source: e,
    })?;
    let total_lines = u32::try_from(content.lines().count()).unwrap_or(u32::MAX);

    if !matches!(detect_file_type(path), FileType::Code(_)) {
        let body = crate::read::read_file(path, None, false, cache, false)?;
        return Ok((body, total_lines, 0, content));
    }

    let skip_lines = crate::search::strip::strip_noise(&content, path, Some((1, total_lines)));
    let width = total_lines.max(1).to_string().len();
    let mut body = String::with_capacity(content.len());
    let mut kept: u32 = 0;
    for (i, line) in content.lines().enumerate() {
        let line_num = u32::try_from(i + 1).unwrap_or(u32::MAX);
        if skip_lines.contains(&line_num) {
            continue;
        }
        let _ = writeln!(body, "{line_num:>width$}  {line}");
        kept += 1;
    }

    let stripped = total_lines.saturating_sub(kept);
    let header = crate::format::file_header(path, meta.len(), total_lines, ViewMode::Stripped);
    let note = format!(
        "// stripped {stripped} of {total_lines} lines (plain comments, debug logs, blank collapse) — non-editable view"
    );
    Ok((
        format!("{header}\n{note}\n\n{}", body.trim_end()),
        total_lines,
        stripped,
        content,
    ))
}

#[cfg(test)]
fn reset_batch_path_counts() {
    DUPLICATE_PATH_COUNT.store(0, std::sync::atomic::Ordering::Relaxed);
    CANONICAL_ALIAS_COUNT.store(0, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(test)]
fn batch_path_counts() -> (usize, usize) {
    (
        DUPLICATE_PATH_COUNT.load(std::sync::atomic::Ordering::Relaxed),
        CANONICAL_ALIAS_COUNT.load(std::sync::atomic::Ordering::Relaxed),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::tool_definitions;

    #[test]
    fn tool_read_signature_mode_emits_hash_prefixed_signatures() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("signature.rs");
        std::fs::write(
            &path,
            "fn signature_target() {\n    let body_marker = 42;\n}\n",
        )
        .unwrap();
        let args = serde_json::json!({
            "path": path.to_str().unwrap(),
            "mode": "signature",
        });
        let cache = OutlineCache::new();
        let session = Session::new();

        let out = tool_read(&args, &cache, &session, false).expect("signature read");

        assert!(
            out.contains("[signature]"),
            "signature header missing: {out}"
        );
        assert!(
            out.lines()
                .any(|l| l.starts_with("1:") && l.contains("fn signature_target")),
            "hash-prefixed signature line missing: {out}"
        );
        assert!(
            !out.contains("body_marker"),
            "signature mode should omit function body: {out}"
        );
    }

    #[test]
    fn tool_read_stripped_mode_drops_comments_and_keeps_doc_comments() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stripped.rs");
        std::fs::write(
            &path,
            "/// keep docs\nfn keep() {\n    // drop plain comment\n    dbg!(1);\n    println!(\"keep\");\n}\n",
        )
        .unwrap();
        let args = serde_json::json!({
            "path": path.to_str().unwrap(),
            "mode": "stripped",
        });
        let cache = OutlineCache::new();
        let session = Session::new();

        let out = tool_read(&args, &cache, &session, true).expect("stripped read");

        assert!(out.contains("[stripped]"), "stripped header missing: {out}");
        assert!(out.contains("/// keep docs"), "doc comment missing: {out}");
        assert!(out.contains("println!"), "kept code missing: {out}");
        assert!(
            !out.contains("drop plain comment"),
            "plain comment should be stripped: {out}"
        );
        assert!(!out.contains("dbg!"), "debug log should be stripped: {out}");
        assert!(
            !out.lines().any(|l| l.contains(':') && l.contains('|')),
            "stripped output must not expose hash anchors: {out}"
        );
    }

    #[test]
    fn tool_read_unknown_mode_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("any.rs");
        std::fs::write(&path, "fn f() {}\n").unwrap();
        let args = serde_json::json!({
            "path": path.to_str().unwrap(),
            "mode": "outline",
        });
        let cache = OutlineCache::new();
        let session = Session::new();

        let err = tool_read(&args, &cache, &session, false).expect_err("unknown mode must error");
        assert!(
            err.starts_with("unknown read mode: outline"),
            "error must name the bad mode: {err}"
        );
        assert!(
            err.contains("auto, full, signature, stripped"),
            "error must list valid modes: {err}"
        );
    }

    #[test]
    fn tool_read_signature_mode_non_code_falls_back_to_normal_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        std::fs::write(&path, "alpha line\nbeta line\ngamma line\n").unwrap();
        let args = serde_json::json!({
            "path": path.to_str().unwrap(),
            "mode": "signature",
        });
        let cache = OutlineCache::new();
        let session = Session::new();

        let out = tool_read(&args, &cache, &session, false).expect("signature read on text");

        // Non-code falls back to the normal read: no signature header, full content.
        assert!(
            !out.contains("[signature]"),
            "non-code must not emit signature header: {out}"
        );
        assert!(out.contains("alpha line"), "content must survive: {out}");
        assert!(out.contains("gamma line"), "content must survive: {out}");
    }

    #[test]
    fn tool_read_stripped_mode_non_code_falls_back_to_normal_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        std::fs::write(&path, "alpha line\nbeta line\ngamma line\n").unwrap();
        let args = serde_json::json!({
            "path": path.to_str().unwrap(),
            "mode": "stripped",
        });
        let cache = OutlineCache::new();
        let session = Session::new();

        let out = tool_read(&args, &cache, &session, false).expect("stripped read on text");

        assert!(
            !out.contains("[stripped]"),
            "non-code must not emit stripped header: {out}"
        );
        assert!(out.contains("alpha line"), "content must survive: {out}");
        assert!(out.contains("gamma line"), "content must survive: {out}");
    }

    #[test]
    fn tool_read_full_flag_is_legacy_alias_for_mode_full() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aliased.rs");
        // Body must exceed TOKEN_THRESHOLD (6k tokens ≈ 24KB) AND compress well
        // so `auto` returns an outline rather than full content — making the
        // alias equivalence observable, not a trivial small-file match where
        // auto and full coincide. Functions have large bodies so the outline
        // (signatures only) is a small fraction of the full-file token cost,
        // ensuring OGATE does not fire and auto != full.
        let mut src = String::from("// header comment\n");
        for i in 0..80 {
            let _ = writeln!(src, "fn f_{i}() {{");
            // Large body: many statements so the outline compresses well
            for j in 0..30 {
                let _ = writeln!(src, "    let local_var_{j}_in_fn_{i}: u64 = {j} + {i};");
            }
            src.push_str("}\n");
        }
        std::fs::write(&path, &src).unwrap();
        let cache = OutlineCache::new();
        let session = Session::new();

        let via_flag = tool_read(
            &serde_json::json!({ "path": path.to_str().unwrap(), "full": true }),
            &cache,
            &session,
            false,
        )
        .expect("full:true read");
        let via_mode = tool_read(
            &serde_json::json!({ "path": path.to_str().unwrap(), "mode": "full" }),
            &cache,
            &session,
            false,
        )
        .expect("mode:full read");
        let via_auto = tool_read(
            &serde_json::json!({ "path": path.to_str().unwrap() }),
            &cache,
            &session,
            false,
        )
        .expect("auto read");

        assert_eq!(
            via_flag, via_mode,
            "full:true must be a byte-identical alias for mode='full'"
        );
        assert!(
            via_flag.contains("[full]"),
            "alias must force full view: {}",
            &via_flag[..via_flag.len().min(80)]
        );
        assert_ne!(
            via_auto, via_flag,
            "auto must outline a large file, differing from forced full"
        );
    }

    #[test]
    fn tool_read_signature_beats_full_flag() {
        // full:true + mode:signature must resolve to a signature view, not a full
        // dump. If a future change flips the dispatch order this test fails loudly.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("precedence.rs");
        std::fs::write(
            &path,
            "fn precedence_target() {\n    let body_marker = 99;\n}\n",
        )
        .unwrap();
        let args = serde_json::json!({
            "path": path.to_str().unwrap(),
            "mode": "signature",
            "full": true,
        });
        let cache = OutlineCache::new();
        let session = Session::new();

        let out = tool_read(&args, &cache, &session, false).expect("signature+full read");

        assert!(
            out.contains("[signature]"),
            "signature must win over full:true (header): {out}"
        );
        assert!(
            !out.contains("body_marker"),
            "signature must win over full:true (body omitted): {out}"
        );
    }

    #[test]
    fn tool_read_signature_mode_rejects_section() {
        // Combining a reshaping mode with section must error, not silently drop the
        // mode (which would return a section slice and ignore signature entirely).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conflict.rs");
        std::fs::write(&path, "fn a() {}\nfn b() {}\n").unwrap();
        let args = serde_json::json!({
            "path": path.to_str().unwrap(),
            "mode": "signature",
            "section": "1-1",
        });
        let cache = OutlineCache::new();
        let session = Session::new();

        let err =
            tool_read(&args, &cache, &session, false).expect_err("signature + section must error");
        assert!(
            err.contains("signature") && err.contains("section"),
            "error must name the conflict: {err}"
        );
    }

    #[test]
    fn pi_nav_read_schema_lists_stripped_mode() {
        let tools = tool_definitions(false);
        let read = tools
            .iter()
            .find(|tool| tool.get("name").and_then(Value::as_str) == Some("pi_nav_read"))
            .expect("pi_nav_read definition");
        let modes = read
            .pointer("/inputSchema/properties/mode/enum")
            .and_then(Value::as_array)
            .expect("mode enum");

        assert!(
            modes.iter().any(|v| v.as_str() == Some("stripped")),
            "mode enum must advertise stripped: {read}"
        );
    }

    #[test]
    fn root_param_anchors_relative_path_under_root() {
        // Guards #78: pi_nav_read with a relative path + root must read from
        // <root>/<path>, not from <cwd>/<path>. Prevents worktree agents from
        // silently reading the wrong checkout.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("hello.rs"), "fn hello() {}").unwrap();

        let cache = OutlineCache::new();
        let session = Session::new();
        let args = serde_json::json!({
            "paths": ["hello.rs"],
            "mode": "full",
            "root": root.to_str().unwrap()
        });
        let result = tool_read(&args, &cache, &session, false).unwrap();
        assert!(
            result.contains("fn hello()"),
            "expected file content via root-anchored path, got: {result}"
        );
    }

    #[test]
    fn root_param_absolute_path_unaffected() {
        // Absolute paths must be used as-is even when root is set.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let abs_file = root.join("abs.rs");
        std::fs::write(&abs_file, "fn abs() {}").unwrap();

        let unrelated_root = tempfile::tempdir().unwrap();
        let cache = OutlineCache::new();
        let session = Session::new();
        let args = serde_json::json!({
            "paths": [abs_file.to_str().unwrap()],
            "mode": "full",
            "root": unrelated_root.path().to_str().unwrap()
        });
        let result = tool_read(&args, &cache, &session, false).unwrap();
        assert!(
            result.contains("fn abs()"),
            "absolute path must resolve independently of root, got: {result}"
        );
    }

    #[test]
    fn no_root_reads_absolute_path_unchanged() {
        // Omitting root must behave identically to before #78: absolute paths
        // resolve as-is regardless of whether root is set or not.
        let tmp = tempfile::tempdir().unwrap();
        let abs_file = tmp.path().join("check.rs");
        std::fs::write(&abs_file, "fn check() {}").unwrap();

        let cache = OutlineCache::new();
        let session = Session::new();
        let args = serde_json::json!({
            "paths": [abs_file.to_str().unwrap()],
            "mode": "full"
        });
        let result = tool_read(&args, &cache, &session, false).unwrap();
        assert!(
            result.contains("fn check()"),
            "no-root regression: absolute path must be readable without root, got: {result}"
        );
    }

    #[test]
    fn relative_path_no_root_errors() {
        // WHY: a relative path + no root silently resolved against the frozen
        // server cwd before this spec — the worktree bug. It must now refuse
        // with a message naming the path and the absolute-root escape hatch.
        let cache = OutlineCache::new();
        let session = Session::new();
        let args = serde_json::json!({ "paths": ["src/foo.rs"], "mode": "full" });
        let err = tool_read(&args, &cache, &session, false).unwrap_err();
        assert!(
            err.contains("src/foo.rs") && err.contains("root"),
            "relative path without root must refuse with an actionable message: {err}"
        );
    }

    // -- savings recording tests ------------------------------------------

    /// A large file with large function bodies read in auto mode (outline) must record
    /// saved > 0 and baseline > 0 on the session.
    #[test]
    fn tool_read_large_file_records_positive_savings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.rs");
        // Build a file large enough to exceed TOKEN_THRESHOLD (6 000 tokens ≈ 24 KB)
        // with functions that have substantial bodies so the outline compresses well.
        let mut src = String::from("// header\n");
        for i in 0..200 {
            let _ = writeln!(src, "fn func_{i}() {{");
            // 20 lines of body per function so outline is much smaller than full content
            for j in 0..20 {
                let _ = writeln!(src, "    let v_{i}_{j}: u64 = {j} * {i} + 42;");
            }
            src.push_str("}\n");
        }
        std::fs::write(&path, &src).unwrap();
        let file_size = std::fs::metadata(&path).unwrap().len();
        assert!(
            file_size > 24_000,
            "test file must be large enough to trigger outline: {file_size} bytes"
        );
        let cache = OutlineCache::new();
        let session = Session::new();
        let args = serde_json::json!({ "path": path.to_str().unwrap() });

        tool_read(&args, &cache, &session, false).expect("large file read");

        let (baseline, saved) = session.savings();
        assert!(
            baseline > 0,
            "baseline must be > 0 for a non-empty file: baseline={baseline}"
        );
        assert!(
            saved > 0,
            "large outlined file must record positive savings: saved={saved}, baseline={baseline}"
        );
    }

    /// A small file read in auto mode (full content) must record baseline > 0
    /// but saved == 0 (no reduction applied).
    #[test]
    fn tool_read_small_file_records_zero_savings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("small.rs");
        std::fs::write(&path, "fn small() {}\n").unwrap();
        let cache = OutlineCache::new();
        let session = Session::new();
        let args = serde_json::json!({ "path": path.to_str().unwrap() });

        tool_read(&args, &cache, &session, false).expect("small file read");

        let (baseline, saved) = session.savings();
        assert!(baseline > 0, "baseline must be > 0 for a non-empty file");
        assert_eq!(
            saved, 0,
            "small file returned in full must record zero savings"
        );
    }

    /// A single-section read requested an explicit range — the naive baseline is
    /// that range, not the whole file — so it must NOT record a (bogus) full-file
    /// saving. Guards against over-counting explicit sub-view reads.
    #[test]
    fn tool_read_section_records_no_savings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sectioned.rs");
        // Large file: a full-file baseline would book a big (bogus) "saving".
        let mut src = String::new();
        for i in 0..500 {
            let _ = writeln!(src, "fn f_{i}() {{ let v = {i}; }}");
        }
        std::fs::write(&path, &src).unwrap();
        let cache = OutlineCache::new();
        let session = Session::new();
        let args = serde_json::json!({ "path": path.to_str().unwrap(), "section": "1-5" });

        tool_read(&args, &cache, &session, false).expect("section read");

        let (baseline, saved) = session.savings();
        assert_eq!(
            baseline, 0,
            "section reads must not record a full-file baseline"
        );
        assert_eq!(saved, 0, "section reads must not record savings");
    }

    #[test]
    fn structured_read_rows_outline_and_batch_deadline_are_honest() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("small.rs"),
            "fn alpha() {}\nfn beta() {}\n",
        )
        .unwrap();
        let native = crate::dispatch::NativeSession::new(root.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(
            &native,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        let args = serde_json::json!({ "root": root.path(), "path": "small.rs", "mode": "full" });
        let output =
            tool_read_output(&args, &native.cache, &native.session, false, &context).unwrap();
        let file = &output.structured["data"]["files"][0];
        assert_eq!(file["path"], "small.rs");
        assert_eq!(file["view"], "full");
        assert_eq!(file["sourceRows"][0]["line"], 1);
        assert_eq!(file["sourceRows"][0]["text"], "fn alpha() {}");
        assert!(file["outlineEntries"]
            .as_array()
            .is_some_and(|entries| entries.iter().any(|entry| entry["label"] == "alpha")));

        let mut expired = crate::dispatch::OperationContext::for_session(
            &native,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        expired.deadline = Some(std::time::Instant::now());
        let batch = serde_json::json!({ "root": root.path(), "paths": ["small.rs", "small.rs"] });
        let output =
            tool_read_output(&batch, &native.cache, &native.session, false, &expired).unwrap();
        assert_eq!(output.structured["completeness"]["complete"], false);
        assert_eq!(output.structured["completeness"]["reason"], "deadline");
        assert!(output.structured["completeness"].get("total").is_none());
    }

    #[test]
    fn structured_markdown_read_resolves_live_owner_and_hierarchy() {
        let root = tempfile::tempdir().unwrap();
        let content = "# Root\nintro\n## Child\nanswer\n";
        std::fs::write(root.path().join("guide.md"), content).unwrap();
        let native = crate::dispatch::NativeSession::new(root.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(
            &native,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        let args = serde_json::json!({
            "root": root.path(),
            "path": "guide.md",
            "markdownStructure": true,
            "byteOffset": content.find("answer").unwrap(),
            "includeSections": true,
        });

        let output =
            tool_read_output(&args, &native.cache, &native.session, false, &context).unwrap();
        let file = &output.structured["data"]["files"][0];
        assert_eq!(file["owner"]["section"]["selector"], "root/child#2");
        assert_eq!(file["owner"]["ancestors"][0]["selector"], "root#1");
        assert_eq!(file["sections"].as_array().map(Vec::len), Some(2));
        assert!(output.source_snapshots.is_empty());
    }

    #[test]
    fn native_batch_read_reuses_one_current_read_for_aliases() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("alias.rs");
        std::fs::write(&path, "fn alias_target() {}\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&path, root.path().join("alias-link.rs")).unwrap();
        reset_batch_path_counts();
        let paths = if cfg!(unix) {
            serde_json::json!(["alias.rs", path, "alias-link.rs"])
        } else {
            serde_json::json!(["alias.rs", path])
        };
        let args = serde_json::json!({ "root": root.path(), "paths": paths, "mode": "full" });
        let native = crate::dispatch::NativeSession::new(root.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(
            &native,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        let (output, counts) = crate::read::with_read_count_probe(|| {
            tool_read_output(&args, &native.cache, &native.session, false, &context).unwrap()
        });
        assert_eq!(counts, (1, 0));
        let (duplicates, aliases) = batch_path_counts();
        assert!(duplicates >= 1);
        assert!(aliases >= 1);
        assert_eq!(output.source_snapshots.len(), 1);
    }
}
