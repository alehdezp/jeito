use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::index::bloom::BloomFilterCache;
use crate::output::{IncompleteReason, Location, Relationship, ToolOutput};

use super::resolve_scope;

#[cfg(test)]
pub(crate) fn tool_deps(args: &Value, bloom: &Arc<BloomFilterCache>) -> Result<String, String> {
    tool_deps_output(args, bloom).map(|output| output.text)
}

pub(crate) fn tool_deps_output(
    args: &Value,
    bloom: &Arc<BloomFilterCache>,
) -> Result<ToolOutput, String> {
    let path_str = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("missing required parameter: path")?;
    let root = args
        .get("root")
        .and_then(Value::as_str)
        .map(std::path::Path::new);
    let path = super::resolve_read_path(&PathBuf::from(path_str), root)?;
    let (scope, scope_warning) = resolve_scope(args, root)?;
    let budget = args
        .get("budget")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    let result = crate::search::deps::analyze_deps(&path, &scope, bloom)
        .map_err(|error| error.to_string())?;
    let mut text = scope_warning.unwrap_or_default();
    text.push_str(&crate::search::deps::format_deps(&result, &scope, budget));
    let mut relationships = Vec::new();
    let mut locations = vec![location(&result.target, 1, 1, root, Some("target"))];
    for dependency in &result.uses_local {
        let to = location(&dependency.path, 1, 1, root, None);
        locations.push(location(&dependency.path, 1, 1, root, Some("dependency")));
        if dependency.symbols.is_empty() {
            relationships.push(Relationship {
                from: location(&result.target, 1, 1, root, None),
                to: Some(to),
                kind: "imports".into(),
                symbol: None,
            });
        } else {
            for symbol in &dependency.symbols {
                relationships.push(Relationship {
                    from: location(&result.target, 1, 1, root, None),
                    to: Some(location(&dependency.path, 1, 1, root, None)),
                    kind: "calls".into(),
                    symbol: Some(symbol.clone()),
                });
            }
        }
    }
    for dependency in &result.uses_external {
        relationships.push(Relationship {
            from: location(&result.target, 1, 1, root, None),
            to: None,
            kind: "external".into(),
            symbol: Some(dependency.clone()),
        });
    }
    for dependent in &result.used_by {
        locations.push(location(&dependent.path, 1, 1, root, Some("dependent")));
        if dependent.symbols.is_empty() {
            relationships.push(Relationship {
                from: location(&dependent.path, 1, 1, root, None),
                to: Some(location(&result.target, 1, 1, root, None)),
                kind: "imports".into(),
                symbol: None,
            });
        } else {
            for (_, symbol, line) in &dependent.symbols {
                relationships.push(Relationship {
                    from: location(&dependent.path, *line, *line, root, None),
                    to: Some(location(&result.target, 1, 1, root, None)),
                    kind: "calls".into(),
                    symbol: Some(symbol.clone()),
                });
            }
        }
    }
    let returned = relationships.len();
    let data = json!({ "relationships": relationships, "locations": locations });
    let capped = result.total_dependents > result.used_by.len()
        || result.exported_count > result.searched_count;
    if capped {
        Ok(ToolOutput::incomplete(
            "pi_nav_deps",
            text,
            data,
            returned,
            IncompleteReason::CandidateCap,
            vec!["dependency analysis reached its bounded symbol/dependent cap".into()],
        ))
    } else {
        Ok(ToolOutput::bounded(
            "pi_nav_deps",
            text,
            data,
            returned,
            returned,
            crate::budget::clamp(budget.unwrap_or(crate::budget::DEFAULT_BUDGET as usize) as u64),
        ))
    }
}

fn location(
    path: &std::path::Path,
    start: u32,
    end: u32,
    root: Option<&std::path::Path>,
    role: Option<&str>,
) -> Location {
    let relative = root
        .and_then(|root| path.strip_prefix(root).ok())
        .unwrap_or(path);
    Location {
        path: relative.to_string_lossy().replace('\\', "/"),
        start,
        end,
        label: None,
        role: role.map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bloom() -> Arc<BloomFilterCache> {
        Arc::new(BloomFilterCache::new())
    }

    #[test]
    fn relative_path_no_root_errors() {
        // WHY: pi_nav_deps resolves its `path` arg through resolve_read_path. A
        // relative path with no absolute root silently resolved against the
        // frozen server cwd before this spec. The `?` on the path resolution must
        // propagate the refusal, naming the path and the root escape hatch.
        let args = serde_json::json!({ "path": "src/foo.rs" });
        let err = tool_deps(&args, &bloom()).unwrap_err();
        assert!(
            err.contains("src/foo.rs") && err.contains("root"),
            "relative deps path without root must refuse: {err}"
        );
    }

    #[test]
    fn absolute_path_omitted_scope_no_root_defaults_to_cwd() {
        // WHY: the require-root discipline fires ONLY when a caller EXPLICITLY
        // passes a relative path/scope without an absolute root. `scope` is
        // never required by pi_nav_deps — an absolute `path` with an omitted
        // `scope` must resolve scope to the server's default cwd (exactly as on
        // main), not refuse. This inverts the PR's original (too strict)
        // assertion, which broke the default flow (path-only pi_nav_deps calls).
        let tmp = tempfile::tempdir().unwrap();
        let abs = tmp.path().join("foo.rs");
        std::fs::write(&abs, "fn foo() {}\n").unwrap();
        let args = serde_json::json!({ "path": abs.to_str().unwrap() });
        let out = tool_deps(&args, &bloom())
            .expect("absolute path + omitted scope must default to cwd, not refuse");
        assert!(
            !out.contains("cannot be resolved"),
            "unexpected refusal: {out}"
        );
    }

    #[test]
    fn absolute_path_explicit_relative_scope_no_root_errors() {
        // An EXPLICITLY passed relative `scope` with no absolute root is
        // unresolvable (the server cannot see the caller's shell cwd) — this
        // must still refuse, even though `path` is absolute.
        let tmp = tempfile::tempdir().unwrap();
        let abs = tmp.path().join("foo.rs");
        std::fs::write(&abs, "fn foo() {}\n").unwrap();
        let args = serde_json::json!({
            "path": abs.to_str().unwrap(),
            "scope": "some/relative/dir",
        });
        let err = tool_deps(&args, &bloom()).unwrap_err();
        assert!(
            err.contains("relative scope") && err.contains("root"),
            "explicit relative scope without root must refuse: {err}"
        );
    }
}
