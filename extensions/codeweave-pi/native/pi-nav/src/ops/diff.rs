use serde_json::{json, Value};

pub(crate) fn tool_diff_output(
    args: &Value,
    context: Option<&crate::dispatch::OperationContext>,
) -> Result<crate::output::ToolOutput, String> {
    let source = args.get("source").and_then(Value::as_str);
    let scope = args.get("scope").and_then(Value::as_str);
    let a = args.get("a").and_then(Value::as_str);
    let b = args.get("b").and_then(Value::as_str);
    let patch = args.get("patch").and_then(Value::as_str);
    let log = args.get("log").and_then(Value::as_str);
    let search = args.get("search").and_then(Value::as_str);
    let blast = args.get("blast").and_then(Value::as_bool).unwrap_or(false);
    let expand = args.get("expand").and_then(Value::as_u64).unwrap_or(0) as usize;
    let budget = crate::budget::clamp(
        args.get("budget")
            .and_then(Value::as_u64)
            .unwrap_or(crate::budget::DEFAULT_BUDGET),
    );
    let diff_source = crate::diff::resolve_source(source, a, b, patch, log)?;
    let review = args.get("review").and_then(Value::as_bool).unwrap_or(false);
    if review {
        let result = crate::diff::diff_review_typed(&diff_source, scope, search, Some(budget), context)?;
        return review_output(result);
    }
    let result = crate::diff::diff_typed(
        &diff_source,
        scope,
        search,
        blast,
        expand,
        Some(budget),
        context,
    )?;
    let root = context.map(|value| value.root.as_path());
    let files: Vec<_> = result.files.iter().map(|file| json!({
        "path": relative(&file.path, root),
        "change": match file.status { crate::diff::FileStatus::Added => "added", crate::diff::FileStatus::Modified => "modified", crate::diff::FileStatus::Deleted => "deleted", crate::diff::FileStatus::Renamed => "renamed" },
    })).collect();
    let symbols: Vec<_> = result
        .symbols
        .iter()
        .map(|symbol| {
            let location = crate::output::Location {
                path: relative(&symbol.path, root),
                start: symbol.line,
                end: symbol.end_line,
                label: Some(symbol.name.clone()),
                role: Some(if symbol.current_source { "changed_symbol" } else { "comparison_symbol_not_current_source" }.into()),
            };
            crate::output::ChangedSymbol {
                location,
                name: symbol.name.clone(),
                change: change_name(&symbol.change).into(),
            }
        })
        .collect();
    let locations: Vec<_> = result
        .symbols
        .iter()
        // Only live after-side symbols may become certification leads. Staged,
        // committed and deleted coordinates remain comparison evidence above.
        .filter(|symbol| symbol.current_source)
        .map(|symbol| crate::output::Location {
            path: relative(&symbol.path, root),
            start: symbol.line,
            end: symbol.end_line,
            label: Some(symbol.name.clone()),
            role: Some("changed_symbol".into()),
        })
        .collect();
    let returned = files.len();
    let data = json!({ "files": files, "symbols": symbols, "locations": locations });
    let mut output = crate::output::ToolOutput::bounded(
        "pi_nav_diff",
        result.text,
        data,
        returned,
        returned,
        budget,
    );
    let visible = output.structured["data"]["files"]
        .as_array()
        .map_or(0, Vec::len);
    if visible < returned {
        output.structured["completeness"]["complete"] = json!(false);
        output.structured["completeness"]["returned"] = json!(visible);
        output.structured["completeness"]["omitted"] = json!(returned - visible);
        output.structured["completeness"]["reason"] = json!("budget");
    }
    Ok(output)
}

/// Transport fitting is independent of the parent's final reply token limit.
/// Never let the generic metadata trimmer remove rows from a paired change.
fn review_output(result: crate::diff::DiffOutput) -> Result<crate::output::ToolOutput, String> {
    const DATA_LIMIT: usize = 128 * 1024;
    const UNIT_LIMIT: usize = 256;
    let review = result.review.ok_or("paired comparison evidence unavailable")?;
    let total = review.changes.len();
    let mut changes = Vec::new();
    let mut bytes = serde_json::to_vec(&review.comparison).map_err(|error| error.to_string())?.len() + 4096;
    if bytes > DATA_LIMIT { return Err("comparison identity exceeds paired transport limit".into()); }
    for change in review.changes {
        let value = serde_json::to_value(change).map_err(|error| error.to_string())?;
        let size = serde_json::to_vec(&value).map_err(|error| error.to_string())?.len() + 1;
        if changes.len() < UNIT_LIMIT && bytes.saturating_add(size) <= DATA_LIMIT {
            bytes += size;
            changes.push(value);
        }
    }
    let returned = changes.len();
    let omitted = total - returned;
    let complete = omitted == 0;
    let data = json!({ "comparison": review.comparison, "changes": changes,
        "changesCompleteness": { "complete": complete, "total": total, "returned": returned, "omitted": omitted,
            "reason": if complete { Value::Null } else { json!("transport_limit") } } });
    let text = format!("{}\nPaired changes: {returned}/{total}; {omitted} whole units omitted for transport. Comparison evidence, not current edit authority.", result.text);
    let mut output = crate::output::ToolOutput::complete("pi_nav_diff", text, data, returned, total);
    output.structured["completeness"]["unit"] = json!("changes");
    output.structured["completeness"]["complete"] = json!(complete);
    if !complete { output.structured["completeness"]["reason"] = json!("budget"); }
    Ok(output)
}

fn relative(path: &std::path::Path, root: Option<&std::path::Path>) -> String {
    root.and_then(|root| path.strip_prefix(root).ok())
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn change_name(change: &crate::diff::ChangeType) -> &'static str {
    match change {
        crate::diff::ChangeType::Added => "added",
        crate::diff::ChangeType::Deleted => "deleted",
        crate::diff::ChangeType::BodyChanged => "body_changed",
        crate::diff::ChangeType::SignatureChanged => "signature_changed",
        crate::diff::ChangeType::Renamed { .. } => "renamed",
        crate::diff::ChangeType::Moved { .. } => "moved",
        crate::diff::ChangeType::RenamedAndMoved { .. } => "renamed_and_moved",
        crate::diff::ChangeType::Unchanged => "unchanged",
    }
}
