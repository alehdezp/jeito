use std::sync::Arc;

use serde_json::{json, Value};

use crate::index::bloom::BloomFilterCache;
use crate::output::{IncompleteReason, Location, Relationship, ToolOutput};
use crate::session::Session;

use super::resolve_scope;

pub(crate) fn tool_grok_output(
    args: &Value,
    bloom: &Arc<BloomFilterCache>,
    session: &Session,
) -> Result<ToolOutput, String> {
    let target = args
        .get("target")
        .and_then(Value::as_str)
        .ok_or("missing required parameter: target")?;
    let root = args
        .get("root")
        .and_then(Value::as_str)
        .map(std::path::Path::new);
    let (scope, scope_warning) = resolve_scope(args, root)?;
    let full = args.get("full").and_then(Value::as_bool).unwrap_or(false);
    let caps = if full {
        crate::search::grok::GrokCaps::full()
    } else {
        crate::search::grok::GrokCaps::default()
    };
    let result = crate::search::grok::grok(target, &scope, bloom, session, caps)
        .map_err(|error| error.to_string())?;
    let mut text = scope_warning.unwrap_or_default();
    text.push_str(&crate::search::grok::format_grok(&result, &scope));
    let mut locations = vec![location(
        &result.target.path,
        result.target.start_line,
        result.target.end_line,
        root,
        Some(&result.target.name),
    )];
    let mut relationships = Vec::new();
    for callee in &result.callees_internal {
        let to = location(
            &callee.file,
            callee.start_line,
            callee.end_line,
            root,
            Some(&callee.name),
        );
        locations.push(location(
            &callee.file,
            callee.start_line,
            callee.end_line,
            root,
            Some(&callee.name),
        ));
        relationships.push(Relationship {
            from: location(
                &result.target.path,
                result.target.start_line,
                result.target.end_line,
                root,
                Some(&result.target.name),
            ),
            to: Some(to),
            kind: "calls".into(),
            symbol: Some(callee.name.clone()),
        });
    }
    for callee in &result.callees_external {
        relationships.push(Relationship {
            from: location(
                &result.target.path,
                result.target.start_line,
                result.target.end_line,
                root,
                Some(&result.target.name),
            ),
            to: None,
            kind: "external_call".into(),
            symbol: Some(callee.clone()),
        });
    }
    for caller in &result.callers {
        let from = location(
            &caller.path,
            caller.line,
            caller.line,
            root,
            Some(&caller.calling_function),
        );
        locations.push(location(
            &caller.path,
            caller.line,
            caller.line,
            root,
            Some(&caller.calling_function),
        ));
        relationships.push(Relationship {
            from,
            to: Some(location(
                &result.target.path,
                result.target.start_line,
                result.target.end_line,
                root,
                Some(&result.target.name),
            )),
            kind: "caller".into(),
            symbol: Some(result.target.name.clone()),
        });
    }
    for sibling in &result.siblings {
        let to = location(
            &result.target.path,
            sibling.start_line,
            sibling.end_line,
            root,
            Some(&sibling.name),
        );
        locations.push(location(
            &result.target.path,
            sibling.start_line,
            sibling.end_line,
            root,
            Some(&sibling.name),
        ));
        relationships.push(Relationship {
            from: location(
                &result.target.path,
                result.target.start_line,
                result.target.end_line,
                root,
                Some(&result.target.name),
            ),
            to: Some(to),
            kind: "sibling".into(),
            symbol: Some(sibling.name.clone()),
        });
    }
    for test in &result.tests {
        let from = location(
            &test.path,
            test.line,
            test.line,
            root,
            Some(&test.test_name),
        );
        locations.push(location(
            &test.path,
            test.line,
            test.line,
            root,
            Some(&test.test_name),
        ));
        relationships.push(Relationship {
            from,
            to: Some(location(
                &result.target.path,
                result.target.start_line,
                result.target.end_line,
                root,
                Some(&result.target.name),
            )),
            kind: "test".into(),
            symbol: Some(result.target.name.clone()),
        });
    }
    let returned = relationships.len();
    let data = json!({ "relationships": relationships, "locations": locations });
    let capped = result.total_callees_internal > result.callees_internal.len()
        || result.total_callees_external > result.callees_external.len()
        || result.total_callers > result.callers.len()
        || result.total_siblings > result.siblings.len()
        || result.total_tests > result.tests.len();
    if capped {
        Ok(ToolOutput::incomplete(
            "pi_nav_grok",
            text,
            data,
            returned,
            IncompleteReason::CandidateCap,
            vec!["grok bundle reached an operation cap".into()],
        ))
    } else {
        Ok(ToolOutput::complete(
            "pi_nav_grok",
            text,
            data,
            returned,
            returned,
        ))
    }
}

fn location(
    path: &std::path::Path,
    start: u32,
    end: u32,
    root: Option<&std::path::Path>,
    label: Option<&str>,
) -> Location {
    let relative = root
        .and_then(|root| path.strip_prefix(root).ok())
        .unwrap_or(path);
    Location {
        path: relative.to_string_lossy().replace('\\', "/"),
        start,
        end,
        label: label.map(str::to_string),
        role: None,
    }
}
