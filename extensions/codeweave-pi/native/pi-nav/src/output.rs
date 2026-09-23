use serde::Serialize;
use serde_json::{json, Value};

use crate::source_proof::SourceSnapshot;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub(crate) path: String,
    pub(crate) start: u32,
    pub(crate) end: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) role: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRow {
    pub(crate) path: String,
    pub(crate) line: u32,
    pub(crate) text: String,
    pub(crate) visibility: &'static str,
    pub(crate) transformation: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub(crate) path: String,
    pub(crate) kind: &'static str,
    pub(crate) depth: usize,
    pub(crate) size: u64,
    pub(crate) token_estimate: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) modified_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) matched_patterns: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineEntry {
    pub(crate) path: String,
    pub(crate) start: u32,
    pub(crate) end: u32,
    pub(crate) label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) kind: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Relationship {
    pub(crate) from: Location,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) to: Option<Location>,
    pub(crate) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) symbol: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PatternInfo {
    pub(crate) input: String,
    pub(crate) normalized: String,
    pub(crate) kind: &'static str,
}

/// File-local, half-open UTF-8 byte coordinates in the captured source.
/// Not graph identity, binding proof, edit authority, or a delivery record.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceIdentity {
    pub(crate) start_byte: usize,
    pub(crate) end_byte: usize,
    pub(crate) syntax_kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchMatch {
    pub(crate) location: Location,
    pub(crate) role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) symbol: Option<String>,
    pub(crate) exact: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source_identity: Option<SourceIdentity>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangedSymbol {
    pub(crate) location: Location,
    pub(crate) name: String,
    pub(crate) change: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ItemCompleteness {
    pub(crate) complete: bool,
    pub(crate) returned: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<IncompleteReason>,
}

#[derive(Debug)]
pub(crate) struct ToolOutput {
    pub(crate) text: String,
    pub(crate) structured: Value,
    pub(crate) source_snapshots: Vec<SourceSnapshot>,
    pub(crate) search_capture: Option<String>,
    pub(crate) search_capture_unavailable: Option<String>,
    pub(crate) matches_render_cursor: Option<String>,
    pub(crate) ranked_render_cursor: Option<String>,
    pub(crate) ranked_render_unavailable: Option<String>,
    pub(crate) ranked_render_frame: Option<crate::search::continuation::RenderFrame>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum IncompleteReason {
    Budget,
    Deadline,
    Cancelled,
    CandidateCap,
    Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Completeness {
    complete: bool,
    unit: &'static str,
    returned: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    omitted: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<IncompleteReason>,
}

impl ToolOutput {
    pub(crate) fn text(operation: &str, text: String) -> Self {
        Self::bounded(
            operation,
            text,
            json!({}),
            0,
            0,
            crate::budget::DEFAULT_BUDGET,
        )
    }

    pub(crate) fn bounded(
        operation: &str,
        text: String,
        data: Value,
        returned: usize,
        total: usize,
        budget: u64,
    ) -> Self {
        let mut complete = Self::complete(operation, text, data, returned, total);
        // Rendered search evidence is required, not optional sidecar metadata:
        // retain source authority and the graph identities/provenance supporting
        // the displayed relationships. Transport hard limits still apply later.
        let mut evidence = Vec::new();
        if operation == "pi_nav_search" {
            if let Some(data) = complete
                .structured
                .get_mut("data")
                .and_then(Value::as_object_mut)
            {
                for key in ["sourceRows", "analysis"] {
                    if let Some(value) = data.remove(key) {
                        evidence.push((key, value));
                    }
                }
            }
        }
        let limit = usize::try_from(budget)
            .unwrap_or(usize::MAX)
            .saturating_mul(4);

        let mut omitted = 0usize;
        while complete.structured.to_string().len() > limit {
            let Some(data) = complete.structured.get_mut("data") else {
                break;
            };
            if !trim_longest_array(data) {
                break;
            }
            omitted += 1;
        }
        if omitted > 0 {
            complete
                .structured
                .get_mut("diagnostics")
                .and_then(Value::as_array_mut)
                .expect("diagnostics array")
                .push(Value::from(format!(
                    "{omitted} structured metadata record(s) omitted to honor response budget"
                )));
        }
        for (key, value) in evidence {
            complete.structured["data"]
                .as_object_mut()
                .expect("evidence came from a data object")
                .insert(key.into(), value);
        }
        complete
    }

    /// Bound an `entries` metadata array without splitting sibling subtrees.
    ///
    /// `group_depth` is the path-component index immediately below the listed
    /// scope. Model-facing text is already budgeted by the operation; this
    /// method only compacts the typed sidecar in whole top-level groups.
    pub(crate) fn bounded_entry_groups(
        operation: &str,
        text: String,
        data: Value,
        returned: usize,
        total: usize,
        budget: u64,
        group_depth: usize,
    ) -> Self {
        let mut complete = Self::complete(operation, text, data, returned, total);
        let limit = usize::try_from(budget)
            .unwrap_or(usize::MAX)
            .saturating_mul(4);
        let mut omitted = 0usize;

        while complete.structured.to_string().len() > limit {
            let Some(entries) = complete
                .structured
                .get_mut("data")
                .and_then(|data| data.get_mut("entries"))
                .and_then(Value::as_array_mut)
            else {
                break;
            };
            let Some(group) = entries
                .last()
                .and_then(|entry| entry.get("path"))
                .and_then(Value::as_str)
                .and_then(|path| path.split('/').nth(group_depth))
                .map(str::to_owned)
            else {
                break;
            };
            let before = entries.len();
            while entries.last().is_some_and(|entry| {
                entry
                    .get("path")
                    .and_then(Value::as_str)
                    .and_then(|path| path.split('/').nth(group_depth))
                    == Some(group.as_str())
            }) {
                entries.pop();
            }
            let removed = before - entries.len();
            if removed == 0 {
                break;
            }
            omitted += removed;
        }
        if omitted > 0 {
            complete
                .structured
                .get_mut("diagnostics")
                .and_then(Value::as_array_mut)
                .expect("diagnostics array")
                .push(Value::from(format!(
                    "{omitted} structured metadata record(s) omitted in whole subtree groups to honor response budget"
                )));
        }
        complete
    }

    pub(crate) fn complete(
        operation: &str,
        text: String,
        data: Value,
        returned: usize,
        total: usize,
    ) -> Self {
        Self::new(
            operation,
            text,
            data,
            Completeness {
                unit: unit_for(operation),
                complete: true,
                returned,
                total: Some(total),
                omitted: total.checked_sub(returned).filter(|count| *count > 0),
                reason: None,
            },
            Vec::new(),
        )
    }

    pub(crate) fn incomplete(
        operation: &str,
        text: String,
        data: Value,
        returned: usize,
        reason: IncompleteReason,
        diagnostics: Vec<String>,
    ) -> Self {
        Self::new(
            operation,
            text,
            data,
            Completeness {
                unit: unit_for(operation),
                complete: false,
                returned,
                total: None,
                omitted: None,
                reason: Some(reason),
            },
            diagnostics,
        )
    }

    pub(crate) fn with_source_snapshots(mut self, snapshots: Vec<SourceSnapshot>) -> Self {
        self.source_snapshots = snapshots;
        self
    }

    fn new(
        operation: &str,
        text: String,
        data: Value,
        completeness: Completeness,
        diagnostics: Vec<String>,
    ) -> Self {
        let mut structured = serde_json::Map::new();
        structured.insert("schemaVersion".into(), Value::from(1));
        structured.insert("operation".into(), Value::from(operation));
        structured.insert("data".into(), data);
        structured.insert(
            "completeness".into(),
            serde_json::to_value(completeness).expect("serialize completeness"),
        );
        structured.insert(
            "diagnostics".into(),
            serde_json::to_value(diagnostics).expect("serialize diagnostics"),
        );
        Self {
            text,
            structured: Value::Object(structured),
            source_snapshots: Vec::new(),
            search_capture: None,
            search_capture_unavailable: None,
            matches_render_cursor: None,
            ranked_render_cursor: None,
            ranked_render_unavailable: None,
            ranked_render_frame: None,
        }
    }
}

fn trim_longest_array(value: &mut Value) -> bool {
    fn longest_path(value: &Value, path: &mut Vec<String>, best: &mut (usize, Vec<String>)) {
        match value {
            Value::Array(values) => {
                if values.len() > best.0 {
                    *best = (values.len(), path.clone());
                }
                for (index, item) in values.iter().enumerate() {
                    path.push(index.to_string());
                    longest_path(item, path, best);
                    path.pop();
                }
            }
            Value::Object(values) => {
                for (key, item) in values {
                    path.push(key.clone());
                    longest_path(item, path, best);
                    path.pop();
                }
            }
            _ => {}
        }
    }

    let mut best = (0usize, Vec::new());
    longest_path(value, &mut Vec::new(), &mut best);
    if best.0 == 0 {
        return false;
    }
    let mut current = value;
    for segment in &best.1 {
        current = match current {
            Value::Object(values) => match values.get_mut(segment) {
                Some(next) => next,
                None => return false,
            },
            Value::Array(values) => match segment
                .parse::<usize>()
                .ok()
                .and_then(|index| values.get_mut(index))
            {
                Some(next) => next,
                None => return false,
            },
            _ => return false,
        };
    }
    current
        .as_array_mut()
        .is_some_and(|values| values.pop().is_some())
}

fn unit_for(operation: &str) -> &'static str {
    match operation {
        "pi_nav_files" | "pi_nav_ls" | "pi_nav_map" => "entries",
        "pi_nav_search" => "matches",
        "pi_nav_read" | "pi_nav_diff" => "files",
        "pi_nav_deps" | "pi_nav_grok" => "relationships",
        _ => "facts",
    }
}
impl From<crate::walk::StopReason> for IncompleteReason {
    fn from(reason: crate::walk::StopReason) -> Self {
        match reason {
            crate::walk::StopReason::Deadline => Self::Deadline,
            crate::walk::StopReason::Cancelled => Self::Cancelled,
            crate::walk::StopReason::CandidateCap => Self::CandidateCap,
            crate::walk::StopReason::Error => Self::Error,
        }
    }
}
pub(crate) fn output_schema() -> Value {
    json!({
        "type": "object",
        "required": ["schemaVersion", "operation", "data", "completeness", "diagnostics"],
        "properties": {
            "schemaVersion": { "type": "integer", "const": 1 },
            "operation": { "type": "string" },
            "data": {},
            "completeness": {
                "type": "object",
                "required": ["complete", "unit", "returned"],
                "properties": {
                    "complete": { "type": "boolean" },
                    "unit": { "type": "string", "enum": ["entries", "matches", "files", "lines", "symbols", "relationships", "facts"] },
                    "returned": { "type": "integer", "minimum": 0 },
                    "total": { "type": "integer", "minimum": 0 },
                    "omitted": { "type": "integer", "minimum": 0 },
                    "reason": { "type": "string", "enum": ["budget", "deadline", "cancelled", "candidate_cap", "error"] }
                }
            },
            "diagnostics": { "type": "array", "items": { "type": "string" } }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_and_incomplete_are_distinct_and_totals_are_honest() {
        let complete = ToolOutput::complete("files", String::new(), json!([]), 0, 0);
        let incomplete = ToolOutput::incomplete(
            "files",
            String::new(),
            json!([]),
            0,
            IncompleteReason::CandidateCap,
            vec![],
        );
        assert_eq!(complete.structured["completeness"]["complete"], true);
        assert_eq!(complete.structured["completeness"]["total"], 0);
        assert_eq!(incomplete.structured["completeness"]["complete"], false);
        assert!(incomplete.structured["completeness"].get("total").is_none());
    }

    #[test]
    fn all_incomplete_reasons_serialize_to_locked_values() {
        let reasons = [
            (IncompleteReason::Budget, "budget"),
            (IncompleteReason::Deadline, "deadline"),
            (IncompleteReason::Cancelled, "cancelled"),
            (IncompleteReason::CandidateCap, "candidate_cap"),
            (IncompleteReason::Error, "error"),
        ];
        for (reason, expected) in reasons {
            assert_eq!(serde_json::to_value(reason).unwrap(), expected);
        }
    }

    #[test]
    fn structured_metadata_is_bounded_with_text_budget() {
        let output = ToolOutput::bounded(
            "files",
            "text".into(),
            json!({"items": ["x".repeat(4_000)]}),
            1,
            1,
            100,
        );
        let structured = output.structured;
        assert_eq!(structured["completeness"]["complete"], true);
        assert_eq!(structured["data"]["items"], json!([]));
        assert!(structured["diagnostics"][0]
            .as_str()
            .is_some_and(|value| value.contains("omitted")));
        assert!(structured.to_string().len() <= 500);
    }

    #[test]
    fn search_compacts_optional_metadata_without_changing_rendered_source_rows() {
        // Disjoint displayed lines must remain disjoint: no authority for line 8.
        let text = "src/a.ts:\n7: const café = 1;\n9: return café;";
        let rows = json!([
            {"path": "src/a.ts", "line": 7, "text": "const café = 1;",
             "visibility": "visible_complete", "transformation": "verbatim"},
            {"path": "src/a.ts", "line": 9, "text": "return café;",
             "visibility": "visible_complete", "transformation": "verbatim"}
        ]);
        let analysis = json!({"generation": 3, "connections": [
            {"source": "execute", "target": "applyPatch", "siteLine": 35},
            {"source": "applyPatch", "target": "applyPatch", "siteLine": 105}
        ]});
        let output = ToolOutput::bounded(
            "pi_nav_search",
            text.into(),
            json!({"sourceRows": rows, "analysis": analysis, "optional": {"connections": ["x".repeat(8_000)]}}),
            1,
            1,
            500,
        );
        assert_eq!(output.text, text);
        assert_eq!(output.structured["data"]["sourceRows"], rows);
        assert_eq!(output.structured["data"]["analysis"], analysis);
        assert_eq!(
            output.structured["data"]["optional"]["connections"],
            json!([])
        );
        assert!(output.structured["diagnostics"][0]
            .as_str()
            .is_some_and(|value| value.starts_with("1 structured metadata record(s) omitted")));
    }

    #[test]
    fn search_keeps_mandatory_rows_when_they_alone_exceed_the_sidecar_budget() {
        let source = format!("const message = {:?};", "x".repeat(1_000));
        let text = format!("src/a.ts:\n12: {source}");
        let rows = json!([
            {"path": "src/a.ts", "line": 12, "text": source,
             "visibility": "visible_complete", "transformation": "verbatim"}
        ]);
        for budget in [0, 100] {
            assert!(rows.to_string().len() > budget as usize * 4);
            let small = json!({"connections": [{"source": "execute", "target": "applyPatch"}]});
            let empty_connections = json!({"connections": []});
            for (optional, expected) in [
                (json!({}), json!({})),
                (
                    small.clone(),
                    if budget == 0 {
                        empty_connections.clone()
                    } else {
                        small
                    },
                ),
                (
                    json!({"connections": ["x".repeat(8_000)]}),
                    empty_connections,
                ),
                (
                    json!({"sourceRows": ["x".repeat(8_000)]}),
                    json!({"sourceRows": []}),
                ),
            ] {
                let output = ToolOutput::bounded(
                    "pi_nav_search",
                    text.clone(),
                    json!({"sourceRows": rows, "optional": optional}),
                    1,
                    1,
                    budget,
                );
                assert_eq!(output.text, text);
                assert_eq!(output.structured["data"]["sourceRows"], rows);
                assert!(output.structured.to_string().len() > budget as usize * 4);
                assert_eq!(output.structured["data"]["optional"], expected);
                if optional == expected {
                    assert_eq!(output.structured["diagnostics"], json!([]));
                } else {
                    assert!(output.structured["diagnostics"][0]
                        .as_str()
                        .is_some_and(
                            |value| value.starts_with("1 structured metadata record(s) omitted")
                        ));
                }
            }
        }
    }

    #[test]
    fn source_row_protection_is_search_only_and_never_invents_rows() {
        for operation in ["pi_nav_read", "pi_nav_diff", "pi_nav_files"] {
            let output = ToolOutput::bounded(
                operation,
                "unchanged text".into(),
                json!({"sourceRows": ["x".repeat(4_000)]}),
                1,
                1,
                100,
            );
            assert_eq!(output.text, "unchanged text");
            assert_eq!(output.structured["data"]["sourceRows"], json!([]));
        }
        for data in [json!({}), json!({"sourceRows": []})] {
            let output = ToolOutput::bounded("pi_nav_search", String::new(), data.clone(), 0, 0, 0);
            assert_eq!(output.structured["data"], data);
        }
    }
}
