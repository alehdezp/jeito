//! Symbol-range op (`pi_nav_symbol_range`): resolve a symbol NAME in a file to its
//! current definition line + body span, via the shared outline walker.
//!
//! The name is authoritative; the optional hint `line` is only a soft disambiguator
//! for same-name symbols, so ordinary line drift never breaks a lookup. When the
//! name is no longer present the op reports `found: false` so callers can flag or
//! drop the stale graph node/edge instead of trusting an outdated range.

use serde_json::{json, Value};

use crate::cache::OutlineCache;
use crate::ops::resolve_read_path;
use crate::output::ToolOutput;
use crate::types::OutlineKind;

pub(crate) fn tool_symbol_range_output(
    args: &Value,
    cache: &OutlineCache,
    root: Option<&std::path::Path>,
) -> Result<ToolOutput, String> {
    let raw_path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "symbol range requires a 'path' argument".to_string())?;
    let name = args.get("name").and_then(Value::as_str);
    let hint_line = args.get("line").and_then(Value::as_u64).map(|v| v as u32);

    let path = resolve_read_path(std::path::Path::new(raw_path), root)
        .map_err(|error| format!("symbol range path: {error}"))?;

    // Line-only mode: no name given → return the enclosing definition's block at
    // `line` (used to give edge call-sites a readable body range). Reuses the
    // cached parse via enclosing_definition_at; degrades to found:false when the
    // file isn't outlineable or the line sits outside any definition.
    let Some(name) = name else {
        let line = hint_line
            .ok_or_else(|| "symbol range requires a 'name' or a 'line' argument".to_string())?;
        let context = crate::search::scope::enclosing_definition_at(&path, line, cache);
        if context.is_err() {
            return Ok(ToolOutput::complete(
                "pi_nav_symbol_range",
                format!("{raw_path}:{line}: {}", crate::search::scope::MIXED_SCOPES),
                json!({ "found": false, "verified": false, "path": raw_path, "defLine": line }),
                1,
                1,
            ));
        }
        if let Ok(Some(scope)) = context {
            let data = json!({
                "found": true,
                "verified": true,
                "path": raw_path,
                "name": scope.name,
                "kind": scope.kind,
                "defLine": line,
                "bodyStart": scope.start,
                "bodyEnd": scope.end,
            });
            return Ok(ToolOutput::complete(
                "pi_nav_symbol_range",
                format!(
                    "{} {raw_path}:{}:[{}-{}]",
                    scope.kind, line, scope.start, scope.end
                ),
                data,
                1,
                1,
            ));
        }
        let data = json!({ "found": false, "verified": true, "path": raw_path, "defLine": line });
        return Ok(ToolOutput::complete(
            "pi_nav_symbol_range",
            format!("{raw_path}:{line}"),
            data,
            1,
            1,
        ));
    };

    let (lookup, source_hash) =
        crate::search::scope::definition_by_name_with_source(&path, name, hint_line, cache);
    let source_hash = source_hash.as_deref();
    match lookup {
        crate::search::scope::SymbolLookup::Unverified => {
            // pi-nav cannot outline this file (unsupported language / parse
            // failure), so staleness is unknown. Report unverified — callers must
            // keep the graph's own info rather than treat this as stale.
            let data = json!({ "found": false, "verified": false, "path": raw_path, "name": name, "sourceHash": source_hash });
            Ok(ToolOutput::complete(
                "pi_nav_symbol_range",
                format!("? {name}: unverified in {raw_path} (file not outlineable)"),
                data,
                1,
                1,
            ))
        }
        crate::search::scope::SymbolLookup::Absent => {
            let data = json!({ "found": false, "verified": true, "stale": true, "path": raw_path, "name": name, "sourceHash": source_hash });
            Ok(ToolOutput::complete(
                "pi_nav_symbol_range",
                format!("✗ {name}: not found in {raw_path} (stale)"),
                data,
                1,
                1,
            ))
        }
        crate::search::scope::SymbolLookup::Ambiguous {
            nearest,
            count,
            candidates,
        } => {
            let text = format!(
                "⚠ {name}: {count} matches in {raw_path} (nearest {}:{}) — verify",
                nearest.def_line, nearest.body_end
            );
            let data = json!({
                "found": true,
                "verified": true,
                "ambiguous": true,
                "candidates": count,
                "path": raw_path,
                "name": nearest.name,
                "kind": kind_text(nearest.kind),
                "defLine": nearest.def_line,
                "bodyStart": nearest.body_start,
                "bodyEnd": nearest.body_end,
                "signature": nearest.signature,
                "doc": nearest.doc.as_deref().and_then(first_doc_line),
                "sourceHash": source_hash,
                "all": candidates.iter().map(|c| json!({
                    "defLine": c.def_line, "bodyStart": c.body_start, "bodyEnd": c.body_end,
                })).collect::<Vec<_>>(),
            });
            Ok(ToolOutput::complete(
                "pi_nav_symbol_range",
                text,
                data,
                1,
                count,
            ))
        }
        crate::search::scope::SymbolLookup::Found(found) => {
            let doc_line = found.doc.as_deref().and_then(first_doc_line);
            let text = format!(
                "{} {raw_path}:{}:[{}-{}]{}{}",
                found
                    .signature
                    .clone()
                    .unwrap_or_else(|| found.name.clone()),
                found.def_line,
                found.body_start,
                found.body_end,
                doc_line
                    .as_deref()
                    .map_or_else(String::new, |d| format!(" — {d}")),
                ""
            );
            let data = json!({
                "found": true,
                "verified": true,
                "path": raw_path,
                "name": found.name,
                "kind": kind_text(found.kind),
                "defLine": found.def_line,
                "bodyStart": found.body_start,
                "bodyEnd": found.body_end,
                "signature": found.signature,
                "doc": doc_line,
                "sourceHash": source_hash,
            });
            Ok(ToolOutput::complete(
                "pi_nav_symbol_range",
                text,
                data,
                1,
                1,
            ))
        }
    }
}

/// A name lookup within supplied bytes, not a current-file verification.
pub(crate) fn captured_symbol_projection(args: &Value, path: &str, text: &str) -> Result<Value, String> {
    use crate::search::scope::{lookup_in_entries, SymbolLookup};
    let name = args["name"].as_str().filter(|name| !name.is_empty() && name.len() <= 4096)
        .ok_or("captured symbol lookup requires a nonempty name (at most 4096 bytes)")?;
    let crate::types::FileType::Code(lang) = crate::lang::detect_file_type(std::path::Path::new(path))
        else { return Ok(json!({"status":"unsupported"})); };
    let Some(grammar) = crate::lang::outline::outline_language(lang)
        else { return Ok(json!({"status":"unsupported"})); };
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&grammar).map_err(|error| error.to_string())?;
    let Some(tree) = parser.parse(text, None) else { return Ok(json!({"status":"unsupported"})); };
    if tree.root_node().has_error() { return Ok(json!({"status":"unsupported","reason":"invalid_syntax"})); }
    let entries = crate::lang::outline::walk_top_level(tree.root_node(), &text.lines().collect::<Vec<_>>(), lang);
    let project = |found: &crate::search::scope::DefinitionByName| json!({"name":found.name,"kind":kind_text(found.kind),
        "defLine":found.def_line,"bodyStart":found.body_start,"bodyEnd":found.body_end,"signature":found.signature,"doc":found.doc});
    Ok(match lookup_in_entries(&entries, name, None) {
        SymbolLookup::Found(found) => json!({"status":"found","definition":project(&found)}),
        SymbolLookup::Ambiguous { candidates, .. } => json!({"status":"ambiguous","candidates":candidates.iter().map(project).collect::<Vec<_>>()}),
        SymbolLookup::Absent => json!({"status":"absent"}),
        SymbolLookup::Unverified => json!({"status":"unsupported"}),
    })
}

/// First meaningful line of a doc comment, with common comment prefixes stripped
/// and length capped — the one-line intent surfaced on a seed, not the whole doc.
fn first_doc_line(doc: &str) -> Option<String> {
    let line = doc
        .lines()
        .map(str::trim)
        .map(|l| l.trim_start_matches("///").trim_start_matches("//!"))
        .map(str::trim)
        .find(|l| !l.is_empty())?;
    let trimmed: String = line.chars().take(80).collect();
    Some(if trimmed.len() < line.len() {
        format!("{trimmed}…")
    } else {
        trimmed
    })
}

fn kind_text(kind: OutlineKind) -> &'static str {
    kind.as_label()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::OutlineCache;
    use std::fmt::Write as _;
    use std::fs;

    fn write(dir: &std::path::Path, name: &str, content: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn symbol_range_resolves_body_span() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.rs", "fn foo() {\n    let x = 1;\n}\n");
        let cache = OutlineCache::new();
        let args = serde_json::json!({ "path": p.to_str().unwrap(), "name": "foo" });
        let out = tool_symbol_range_output(&args, &cache, Some(tmp.path())).expect("resolve");
        let data = &out.structured["data"];
        assert_eq!(
            data.get("found").and_then(Value::as_bool),
            Some(true),
            "structured: {}",
            out.structured
        );
        assert_eq!(data.get("defLine").and_then(Value::as_u64), Some(1));
        assert_eq!(data.get("bodyEnd").and_then(Value::as_u64), Some(3));
        assert_eq!(
            data.get("sourceHash").and_then(Value::as_str).map(str::len),
            Some(64)
        );
    }

    #[test]
    fn symbol_range_resolves_tail_definition_without_bounded_outline_loss() {
        let tmp = tempfile::tempdir().unwrap();
        let mut source = String::new();
        for index in 0..1200 {
            writeln!(source, "fn fn_{index}() {{}}").unwrap();
        }
        let p = write(tmp.path(), "many.rs", &source);
        let cache = OutlineCache::new();
        let args = serde_json::json!({ "path": p.to_str().unwrap(), "name": "fn_1199" });
        let out = tool_symbol_range_output(&args, &cache, Some(tmp.path())).expect("resolve tail");
        let data = &out.structured["data"];
        assert_eq!(data.get("found").and_then(Value::as_bool), Some(true));
        assert_eq!(data.get("defLine").and_then(Value::as_u64), Some(1200));
    }

    #[test]
    fn symbol_range_reports_stale_when_name_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.rs", "fn bar() {}\n");
        let cache = OutlineCache::new();
        let args = serde_json::json!({ "path": p.to_str().unwrap(), "name": "foo" });
        let out = tool_symbol_range_output(&args, &cache, Some(tmp.path())).expect("resolve");
        assert_eq!(
            out.structured["data"].get("found").and_then(Value::as_bool),
            Some(false)
        );
        assert!(out.text.contains("stale"), "text: {}", out.text);
    }

    #[test]
    fn symbol_range_reports_unverified_for_non_outlineable_file() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "notes.unknownext", "plain text\n");
        let cache = OutlineCache::new();
        let args = serde_json::json!({ "path": p.to_str().unwrap(), "name": "foo" });
        let out = tool_symbol_range_output(&args, &cache, Some(tmp.path())).expect("resolve");
        let data = &out.structured["data"];
        assert_eq!(data.get("found").and_then(Value::as_bool), Some(false));
        assert_eq!(
            data.get("verified").and_then(Value::as_bool),
            Some(false),
            "must be unverified, not stale: {}",
            out.structured
        );
        assert!(out.text.contains("unverified"), "text: {}", out.text);
    }

    #[test]
    fn symbol_range_flags_ambiguous_when_multiple_match() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.rs", "fn dup() {\n}\n\n\n\n\nfn dup() {\n}\n");
        let cache = OutlineCache::new();
        let args = serde_json::json!({ "path": p.to_str().unwrap(), "name": "dup", "line": 1 });
        let out = tool_symbol_range_output(&args, &cache, Some(tmp.path())).expect("resolve");
        let data = &out.structured["data"];
        assert_eq!(
            data.get("ambiguous").and_then(Value::as_bool),
            Some(true),
            "structured: {}",
            out.structured
        );
        assert_eq!(data.get("candidates").and_then(Value::as_u64), Some(2));
    }

    #[test]
    fn symbol_range_surfaces_signature_and_doc() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.rs",
            "/// Adds two numbers.\nfn add(a: u32, b: u32) -> u32 {\n    a + b\n}\n",
        );
        let cache = OutlineCache::new();
        let args = serde_json::json!({ "path": p.to_str().unwrap(), "name": "add" });
        let out = tool_symbol_range_output(&args, &cache, Some(tmp.path())).expect("resolve");
        let data = &out.structured["data"];
        let sig = data.get("signature").and_then(Value::as_str).unwrap_or("");
        assert!(
            sig.contains("add") && sig.contains("a: u32"),
            "signature: {sig}"
        );
        assert_eq!(
            data.get("doc").and_then(Value::as_str),
            Some("Adds two numbers.")
        );
        assert!(
            out.text.contains("Adds two numbers"),
            "text carries doc: {}",
            out.text
        );
    }

    #[test]
    fn symbol_range_line_only_returns_enclosing_block() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.rs",
            "fn outer() {\n    let x = inner();\n}\n\nfn inner() -> u32 {\n    1\n}\n",
        );
        let cache = OutlineCache::new();
        // Line 2 sits inside `outer` → enclosing block is outer (lines 1-3).
        let args = serde_json::json!({ "path": p.to_str().unwrap(), "line": 2 });
        let out = tool_symbol_range_output(&args, &cache, Some(tmp.path())).expect("resolve");
        let data = &out.structured["data"];
        assert_eq!(
            data.get("found").and_then(Value::as_bool),
            Some(true),
            "structured: {}",
            out.structured
        );
        assert_eq!(data.get("name").and_then(Value::as_str), Some("outer"));
        assert_eq!(data.get("bodyStart").and_then(Value::as_u64), Some(1));
        assert_eq!(data.get("bodyEnd").and_then(Value::as_u64), Some(3));
        assert!(
            out.text.contains(":[1-3]"),
            "text carries block range: {}",
            out.text
        );
    }

    #[test]
    fn symbol_range_line_only_top_level_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.rs", "fn foo() {}\n\nfn bar() {}\n");
        let cache = OutlineCache::new();
        // Line 2 is blank top-level space between definitions → no enclosing def.
        let args = serde_json::json!({ "path": p.to_str().unwrap(), "line": 2 });
        let out = tool_symbol_range_output(&args, &cache, Some(tmp.path())).expect("resolve");
        assert_eq!(
            out.structured["data"].get("found").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn symbol_range_folds_multiline_signature_into_one_line() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.rs",
            "fn multi(\n    a: u32,\n    b: u32,\n) -> u32 {\n    a + b\n}\n",
        );
        let cache = OutlineCache::new();
        let args = serde_json::json!({ "path": p.to_str().unwrap(), "name": "multi" });
        let out = tool_symbol_range_output(&args, &cache, Some(tmp.path())).expect("resolve");
        let data = &out.structured["data"];
        let sig = data.get("signature").and_then(Value::as_str).unwrap_or("");
        // Multi-line param list is folded onto one line — every param plus the return
        // type survives (the old first-line-only extraction returned just `fn multi(`).
        assert!(
            sig.contains("a: u32") && sig.contains("b: u32") && sig.contains("-> u32"),
            "signature folded: {sig}"
        );
        assert!(!sig.contains('{'), "body brace excluded: {sig}");
    }

    #[test]
    fn symbol_range_keeps_object_param_brace_in_multiline_signature() {
        let tmp = tempfile::tempdir().unwrap();
        // The shape that triggered the bug: a multi-line signature whose parameter
        // is an object type. The signature's own `{ … }` must survive; only the
        // body's opening brace is excluded. The old first-`{` truncation cut this
        // at `params:`.
        let p = write(
            tmp.path(),
            "a.ts",
            "async function f(params: {\n  a: string;\n  b: number;\n}): Promise<string> {\n  return \"\";\n}\n",
        );
        let cache = OutlineCache::new();
        let args = serde_json::json!({ "path": p.to_str().unwrap(), "name": "f" });
        let out = tool_symbol_range_output(&args, &cache, Some(tmp.path())).expect("resolve");
        let data = &out.structured["data"];
        let sig = data.get("signature").and_then(Value::as_str).unwrap_or("");
        assert!(sig.contains("params: {"), "object param brace kept: {sig}");
        assert!(
            sig.contains("a: string") && sig.contains("b: number"),
            "params folded: {sig}"
        );
        assert!(sig.contains("Promise<string>"), "return type kept: {sig}");
        assert!(!sig.contains("return"), "body excluded: {sig}");
    }
}
