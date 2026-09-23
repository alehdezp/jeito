use serde_json::{json, Value};

use crate::session::Session;

pub(crate) fn tool_session(args: &Value, session: &Session) -> Result<String, String> {
    let action = args
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("summary");
    match action {
        "reset" => {
            session.reset();
            Ok("Session reset.".to_string())
        }
        _ => Ok(session.summary()),
    }
}

pub(crate) fn tool_session_output(
    args: &Value,
    session: &Session,
) -> Result<crate::output::ToolOutput, String> {
    let text = tool_session(args, session)?;
    let snapshot = session.snapshot();
    let top_queries: Vec<_> = snapshot
        .top_queries
        .into_iter()
        .map(|(query, count)| json!({ "query": query, "count": count }))
        .collect();
    let hot_paths: Vec<_> = snapshot
        .hot_paths
        .into_iter()
        .map(|(path, count)| json!({ "path": path.replace('\\', "/"), "count": count }))
        .collect();
    Ok(crate::output::ToolOutput::complete(
        "pi_nav_session",
        text,
        json!({ "reads": snapshot.reads, "searches": snapshot.searches, "topQueries": top_queries, "hotPaths": hot_paths }),
        4,
        4,
    ))
}
