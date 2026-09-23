use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use serde_json::Value;

use crate::dispatch::{
    dispatch_read_only, NativeError, NativeSession, OperationContext, ReadFormat,
    READ_ONLY_OPERATIONS,
};
use crate::output::ToolOutput;
use crate::source_proof::{self, SourceSnapshot};

#[napi(object)]
pub struct BuildInfo {
    pub package_version: String,
    pub addon_api_version: u32,
    pub result_schema_version: u32,
    pub target: String,
    pub capabilities: Vec<String>,
    pub semantic_recipe: String,
    pub semantic_dimensions: u32,
}
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[napi(object)]
pub struct NativeSourceSnapshot {
    pub canonical_path: String,
    pub text: String,
    pub raw_digest: String,
    pub line_ending: String,
    pub bom: bool,
}

impl From<SourceSnapshot> for NativeSourceSnapshot {
    fn from(snapshot: SourceSnapshot) -> Self {
        Self {
            canonical_path: snapshot.canonical_path,
            text: snapshot.text,
            raw_digest: snapshot.raw_digest,
            line_ending: snapshot.line_ending.into(),
            bom: snapshot.bom,
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[napi(object)]
pub struct NativeOutput {
    pub text: String,
    pub structured: Value,
    pub source_snapshots: Option<Vec<NativeSourceSnapshot>>,
    pub search_capture: Option<String>,
    pub search_capture_unavailable: Option<String>,
    pub matches_render_cursor: Option<String>,
    pub ranked_render_cursor: Option<String>,
    pub ranked_render_unavailable: Option<String>,
}

impl From<ToolOutput> for NativeOutput {
    fn from(output: ToolOutput) -> Self {
        Self {
            text: output.text,
            structured: output.structured,
            search_capture: output.search_capture,
            search_capture_unavailable: output.search_capture_unavailable,
            matches_render_cursor: output.matches_render_cursor,
            ranked_render_cursor: output.ranked_render_cursor,
            ranked_render_unavailable: output.ranked_render_unavailable,
            source_snapshots: (!output.source_snapshots.is_empty()).then(|| {
                output
                    .source_snapshots
                    .into_iter()
                    .map(Into::into)
                    .collect()
            }),
        }
    }
}

#[napi(js_name = "getBuildInfo", catch_unwind)]
pub fn get_build_info() -> BuildInfo {
    BuildInfo {
        package_version: env!("CARGO_PKG_VERSION").into(),
        addon_api_version: 2,
        result_schema_version: 1,
        target: env!("PI_NAV_BUILD_TARGET").into(),
        semantic_recipe: crate::semantic::recipe().into(),
        semantic_dimensions: crate::semantic::DIMENSIONS as u32,
        capabilities: READ_ONLY_OPERATIONS
            .iter()
            .map(|operation| (*operation).to_string())
            .chain(["source_proof_v1", "grep_cursor_owner_v1", "ranked_capture_v1", "ranked_focus_v1", "ranked_cursor_v1", "semantic_encode_v1", "captured_source_v1", "semantic_inputs_v1", "ranked_corpus_v1", "ranked_render_v1", "matches_render_v1", "matches_corpus_v1"].map(str::to_string))
            .collect(),
    }
}

#[napi]
pub struct PiNavSession {
    inner: Arc<NativeSession>,
}

#[napi]
impl PiNavSession {
    #[napi(constructor, catch_unwind)]
    pub fn new(root: String) -> Result<Self> {
        let root = std::path::PathBuf::from(root);
        let inner = NativeSession::new(&root, false).map_err(|error| napi_error(&error))?;
        Ok(Self {
            inner: Arc::new(inner),
        })
    }

    #[napi(catch_unwind)]
    pub fn call(
        &self,
        operation: String,
        args: Value,
        timeout_ms: Option<u32>,
        mut signal: Option<AbortSignal>,
    ) -> Result<AsyncTask<Blocking<NativeCall>>> {
        if !args.is_object() {
            return Err(napi_error(&NativeError::InvalidArgument(
                "arguments must be an object".into(),
            )));
        }
        if args.get("root").is_some() {
            return Err(napi_error(&NativeError::InvalidArgument(
                "caller-supplied root is not allowed".into(),
            )));
        }
        captured_request(&operation, &args).map_err(|error| napi_error(&error))?;
        if !matches!(
            operation.as_str(),
            "pi_nav_source_proof" | "pi_nav_grep_cursor_owner" | "pi_nav_semantic_encode" | "pi_nav_semantic_inputs"
        ) && !READ_ONLY_OPERATIONS.contains(&operation.as_str())
        {
            return Err(napi_error(&NativeError::UnknownOperation(operation)));
        }

        // N-API path normalization anchors relative inputs to the session
        // root while permitting explicit absolute and parent-relative targets.
        let mut context = OperationContext::for_session(&self.inner, ReadFormat::Plain, true);
        context.deadline = timeout_ms
            .map(|milliseconds| Instant::now() + Duration::from_millis(u64::from(milliseconds)));
        if let Some(abort_signal) = signal.as_mut() {
            let cancelled = Arc::clone(&context.cancelled);
            abort_signal.on_abort(move || cancelled.store(true, Ordering::Relaxed));
        }
        let task = Blocking::new(NativeCall {
            session: Arc::clone(&self.inner),
            operation,
            args,
            context,
        });
        Ok(AsyncTask::with_optional_signal(task, signal))
    }
}

pub struct NativeCall {
    session: Arc<NativeSession>,
    operation: String,
    args: Value,
    context: OperationContext,
}

trait BlockingWork: Send {
    fn run(self) -> std::result::Result<NativeOutput, NativeError>;
}

impl BlockingWork for NativeCall {
    fn run(self) -> std::result::Result<NativeOutput, NativeError> {
        if ["retainRankedRender", "rankedRenderAllowance", "renderRanked", "retainMatchesRender", "renderMatches", "matchesRenderBytes"].iter().any(|key| self.args.get(*key).is_some())
            && (self.operation != "pi_nav_search" || self.args.get("capturedSource").is_some()) {
            return Err(NativeError::invalid_argument("retained rendering is private to search"));
        }
        if self.args.get("corpusAdmission").is_some() && (!matches!(self.operation.as_str(), "pi_nav_search" | "pi_nav_source_proof") || self.args.get("capturedSource").is_some()) {
            return Err(NativeError::invalid_argument("corpus admission is only valid for ranked search and its source proof"));
        }
        // Presence is checked before EVERY dispatch, including private operations.
        if let Some((path, text)) = captured_request(&self.operation, &self.args)? {
            self.context.check()?;
            let data = match self.operation.as_str() {
                "pi_nav_semantic_inputs" => crate::semantic::input_projection(&self.args, path, text, &self.context),
                "pi_nav_symbol_range" => crate::ops::captured_symbol_projection(&self.args, path, text),
                "pi_nav_read" => crate::ops::markdown_projection(&self.args, path, text),
                _ => unreachable!("captured request whitelist"),
            }.map_err(NativeError::Domain)?;
            self.context.check()?;
            return captured_output(&self.operation, path, text, data);
        }
        if self.operation == "pi_nav_source_proof" {
            source_proof::prove(&self.args, &self.context).map(NativeOutput::from)
        } else if self.operation == "pi_nav_semantic_encode" {
            crate::semantic::encode_operation(&self.args, &self.context).map(NativeOutput::from)
        } else if self.operation == "pi_nav_grep_cursor_owner" {
            self.context.check()?;
            let cursor = self
                .args
                .get("cursor")
                .and_then(Value::as_str)
                .ok_or_else(|| NativeError::invalid_argument("cursor must be a string"))?;
            // Even this memory-only lookup stays on the existing worker path:
            // the cursor mutex may be held by another native operation.
            let owner = self.session.session.cursor_owner_data(cursor);
            self.context.check()?;
            Ok(ToolOutput::complete(
                "pi_nav_grep_cursor_owner",
                String::new(),
                owner,
                0,
                0,
            )
            .into())
        } else {
            dispatch_read_only(&self.operation, &self.args, &self.session, &self.context)
                .map(NativeOutput::from)
        }
    }
}

impl<F> BlockingWork for F
where
    F: FnOnce() -> std::result::Result<NativeOutput, NativeError> + Send,
{
    fn run(self) -> std::result::Result<NativeOutput, NativeError> {
        self()
    }
}

pub struct Blocking<T> {
    work: Option<T>,
}

impl<T> Blocking<T> {
    fn new(work: T) -> Self {
        Self { work: Some(work) }
    }
}

impl<T: BlockingWork> Task for Blocking<T> {
    type Output = NativeOutput;
    type JsValue = NativeOutput;

    fn compute(&mut self) -> Result<Self::Output> {
        let work = self.work.take().ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                "[pi-nav:domain] native task compute called more than once".to_string(),
            )
        })?;
        match catch_unwind(AssertUnwindSafe(|| work.run())) {
            Ok(result) => result.map_err(|error| napi_error(&error)),
            Err(payload) => {
                let message = panic_message(payload.as_ref());
                dispose_panic_payload(payload);
                Err(napi_error(&NativeError::Panic(message)))
            }
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

const MAX_CAPTURED_SOURCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROJECTION_BYTES: usize = 2 * 1024 * 1024;

fn captured_request<'a>(operation: &str, args: &'a Value) -> std::result::Result<Option<(&'a str, &'a str)>, NativeError> {
    let Some(captured) = args.get("capturedSource") else {
        return if operation == "pi_nav_semantic_inputs" { Err(NativeError::invalid_argument("capturedSource is required")) } else { Ok(None) };
    };
    let invalid = || NativeError::invalid_argument("invalid capturedSource request; no live-path fallback");
    let allowed: &[&str] = match operation {
        "pi_nav_semantic_inputs" => &["path", "capturedSource", "owners"],
        "pi_nav_symbol_range" => &["path", "capturedSource", "name"],
        "pi_nav_read" if args["markdownStructure"] == true => &["path", "capturedSource", "markdownStructure", "includeSections", "selector", "byteOffset"],
        _ => return Err(invalid()),
    };
    if args.as_object().is_none_or(|map| map.keys().any(|key| !allowed.contains(&key.as_str()))) { return Err(invalid()); }
    let object = captured.as_object().ok_or_else(invalid)?;
    if object.len() != 1 { return Err(invalid()); }
    let text = object.get("text").and_then(Value::as_str).ok_or_else(invalid)?;
    if text.len() > MAX_CAPTURED_SOURCE_BYTES { return Err(NativeError::invalid_argument("captured source exceeds 8 MiB")); }
    let path = args["path"].as_str().ok_or_else(invalid)?;
    if path.is_empty() || path.len() > 4096 || path.contains('\\') || path.chars().any(char::is_control)
        || path.split('/').any(|part| matches!(part, "" | "." | "..")) || std::path::Path::new(path).is_absolute() {
        return Err(invalid());
    }
    if operation == "pi_nav_read" {
        if !matches!(crate::lang::detect_file_type(std::path::Path::new(path)), crate::types::FileType::Markdown)
            || args.get("includeSections").is_some_and(|v| !v.is_boolean())
            || args.get("selector").is_some_and(|v| v.as_str().is_none_or(|selector| selector.len() > 4096))
            || args.get("byteOffset").is_some_and(|v| v.as_u64().is_none_or(|offset| offset > text.len() as u64 || !text.is_char_boundary(offset as usize))) {
            return Err(invalid());
        }
    }
    Ok(Some((path, text)))
}

fn captured_envelope_size(output: &NativeOutput) -> usize {
    // Explicit null optional carriers conservatively count the entire native envelope.
    serde_json::to_vec(output).expect("native JSON output serializes").len()
}

fn captured_output(operation: &str, path: &str, text: &str, mut data: Value) -> std::result::Result<NativeOutput, NativeError> {
    use sha2::{Digest, Sha256};
    data["basis"] = serde_json::json!("supplied");
    data["path"] = serde_json::json!(path);
    data["suppliedSourceHash"] = serde_json::json!(format!("{:x}", Sha256::digest(text.as_bytes())));
    let semantic = operation == "pi_nav_semantic_inputs";
    let count = data["owners"].as_array().map_or(1, Vec::len);
    let mut output = NativeOutput::from(ToolOutput::complete(operation, String::new(), data, count, count));
    loop {
        if semantic {
            let complete = output.structured["data"]["owners"].as_array().expect("projection owners").iter().all(|owner| owner["status"] == "ok");
            output.structured["data"]["complete"] = serde_json::json!(complete);
        }
        if captured_envelope_size(&output) <= if semantic { MAX_PROJECTION_BYTES } else { 256 * 1024 } { return Ok(output); }
        if semantic {
            if let Some(owner) = output.structured["data"]["owners"].as_array_mut()
                .and_then(|owners| owners.iter_mut().rev().find(|owner| owner.get("input").is_some())) {
                owner.as_object_mut().expect("owner object").remove("input");
                owner["status"] = serde_json::json!("output_limit");
                continue;
            }
        }
        return Err(NativeError::Domain("captured projection exceeds serialized output bound".into()));
    }
}

fn napi_error(error: &NativeError) -> Error {
    let status = match error {
        NativeError::InvalidArgument(_) | NativeError::UnknownOperation(_) => Status::InvalidArg,
        NativeError::Cancelled | NativeError::Deadline => Status::Cancelled,
        NativeError::Io(_) | NativeError::Domain(_) | NativeError::Panic(_) => {
            Status::GenericFailure
        }
    };
    Error::new(status, error.to_string())
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else {
        "Rust task panicked with a non-string payload".into()
    }
}

// A panic payload may itself panic in Drop. Leaking only the secondary payload
// is preferable to aborting the Pi host while unwinding across the N-API edge.
fn dispose_panic_payload(payload: Box<dyn Any + Send>) {
    if let Err(secondary_payload) = catch_unwind(AssertUnwindSafe(|| drop(payload))) {
        std::mem::forget(secondary_payload);
    }
}

#[cfg(test)]
mod tests {
    use std::panic::panic_any;

    use super::*;

    fn output() -> NativeOutput {
        NativeOutput {
            text: "ok".into(),
            structured: serde_json::json!({"schemaVersion": 1}),
            source_snapshots: None,
            search_capture: None,
            search_capture_unavailable: None,
            matches_render_cursor: None,
            ranked_render_cursor: None,
            ranked_render_unavailable: None,
        }
    }

    #[test]
    fn ranked_capture_transport_stays_outside_structured_metadata() {
        let ordinary = NativeOutput::from(ToolOutput::text("pi_nav_search", "live".into()));
        assert!(ordinary.search_capture.is_none());
        assert!(ordinary.search_capture_unavailable.is_none());
        let mut output = ToolOutput::text("pi_nav_search", "live".into());
        output.search_capture = Some("private-handle".into());
        output.ranked_render_cursor = Some("private-origin".into());
        let native = NativeOutput::from(output);
        assert_eq!(native.text, ordinary.text);
        assert_eq!(native.structured, ordinary.structured);
        assert_eq!(native.search_capture.as_deref(), Some("private-handle"));
        assert!(!native.structured.to_string().contains("private-handle"));
        assert_eq!(native.ranked_render_cursor.as_deref(), Some("private-origin"));
        assert!(!native.structured.to_string().contains("private-origin"));
        assert!(get_build_info().capabilities.iter().any(|value| value == "ranked_render_v1"));
        assert!(get_build_info().capabilities.iter().any(|value| value == "ranked_capture_v1"));
    }

    #[test]
    fn matches_render_transport_stays_outside_structured_metadata() {
        let ordinary = ToolOutput::text("pi_nav_search", "audit".into());
        assert!(ordinary.matches_render_cursor.is_none());
        let structured = ordinary.structured.clone();
        let mut output = ordinary;
        output.matches_render_cursor = Some("private-matches-origin".into());
        let native = NativeOutput::from(output);
        assert_eq!(native.matches_render_cursor.as_deref(), Some("private-matches-origin"));
        assert_eq!(native.structured, structured);
        assert_eq!(native.text, "audit");
        let transport = serde_json::to_value(&native).unwrap();
        assert_eq!(transport["matchesRenderCursor"], "private-matches-origin");
        assert!(!native.structured.to_string().contains("private-matches-origin"));
        assert!(get_build_info().capabilities.iter().any(|value| value == "matches_render_v1"));
    }

    #[test]
    fn matches_render_arguments_reject_non_search_and_captured_operations() {
        let directory = tempfile::tempdir().unwrap();
        let session = Arc::new(NativeSession::new(directory.path(), false).unwrap());
        for (key, value) in [
            ("retainMatchesRender", serde_json::json!(true)),
            ("renderMatches", serde_json::json!("private-origin")),
            ("matchesRenderBytes", serde_json::json!(16000)),
        ] {
            for operation in ["pi_nav_read", "pi_nav_source_proof", "pi_nav_grep_cursor_owner", "pi_nav_semantic_encode", "pi_nav_search"] {
                let mut args = serde_json::json!({});
                args[key] = value.clone();
                if operation == "pi_nav_search" { args["capturedSource"] = serde_json::json!({}); }
                let call = NativeCall {
                    session: Arc::clone(&session), operation: operation.into(), args,
                    context: OperationContext::for_session(&session, ReadFormat::Plain, true),
                };
                let error = call.run().unwrap_err();
                assert!(matches!(error, NativeError::InvalidArgument(_)), "{key} {operation}: {error:?}");
                assert!(error.to_string().contains("retained rendering is private to search"));
            }
        }
    }

    #[test]
    fn blocking_compute_returns_success_and_error() {
        let mut ok = Blocking::new(|| Ok(output()));
        assert_eq!(Task::compute(&mut ok).unwrap().text, "ok");

        let mut error = Blocking::new(|| Err(NativeError::Domain("bad input".into())));
        assert_eq!(
            Task::compute(&mut error).unwrap_err().reason,
            "[pi-nav:domain] bad input"
        );
    }

    #[test]
    fn blocking_compute_contains_string_and_non_string_panics() {
        let mut string_panic =
            Blocking::new(|| -> std::result::Result<_, NativeError> { panic!("task exploded") });
        assert_eq!(
            Task::compute(&mut string_panic).unwrap_err().reason,
            "[pi-nav:panic] task exploded"
        );

        let mut non_string_panic =
            Blocking::new(|| -> std::result::Result<_, NativeError> { panic_any(42_u32) });
        assert_eq!(
            Task::compute(&mut non_string_panic).unwrap_err().reason,
            "[pi-nav:panic] Rust task panicked with a non-string payload"
        );
    }

    #[test]
    fn blocking_compute_contains_payload_drop_panic() {
        struct DropPanics;
        impl Drop for DropPanics {
            fn drop(&mut self) {
                panic!("payload drop exploded");
            }
        }

        let mut task =
            Blocking::new(|| -> std::result::Result<_, NativeError> { panic_any(DropPanics) });
        assert_eq!(
            Task::compute(&mut task).unwrap_err().reason,
            "[pi-nav:panic] Rust task panicked with a non-string payload"
        );
    }

    #[test]
    fn blocking_compute_rejects_a_second_execution() {
        let mut task = Blocking::new(|| Ok(output()));
        assert!(Task::compute(&mut task).is_ok());
        assert_eq!(
            Task::compute(&mut task).unwrap_err().reason,
            "[pi-nav:domain] native task compute called more than once"
        );
    }

    #[test]
    fn build_info_has_exact_read_only_capabilities() {
        let info = get_build_info();
        assert_eq!(info.package_version, "0.9.0");
        assert_eq!(info.addon_api_version, 2);
        assert_eq!(info.result_schema_version, 1);
        assert_eq!(
            info.capabilities,
            READ_ONLY_OPERATIONS
                .iter()
                .copied()
                .chain(["source_proof_v1", "grep_cursor_owner_v1", "ranked_capture_v1", "ranked_focus_v1", "ranked_cursor_v1", "semantic_encode_v1", "captured_source_v1", "semantic_inputs_v1", "ranked_corpus_v1", "ranked_render_v1", "matches_render_v1", "matches_corpus_v1"])
                .collect::<Vec<_>>()
        );
        assert!(!info.capabilities.iter().any(|name| name.contains("write")));
    }
}

#[cfg(test)]
mod captured_tests {
    use super::*;
    use serde_json::json;

    fn run(session: &Arc<NativeSession>, operation: &str, args: Value) -> std::result::Result<NativeOutput, NativeError> {
        NativeCall { session: session.clone(), operation: operation.into(), args,
            context: OperationContext::for_session(session, ReadFormat::Plain, true) }.run()
    }

    fn owner(text: &str, fragment: &str, id: &str, kind: &str) -> Value {
        let start = text.find(fragment).unwrap();
        let position = |byte: usize| {
            let before = &text[..byte];
            (before.bytes().filter(|b| *b == b'\n').count() + 1, before.rsplit('\n').next().unwrap().encode_utf16().count())
        };
        let (start_line, start_column) = position(start);
        let (end_line, end_column) = position(start + fragment.len());
        json!({"id":id,"kind":kind,"startLine":start_line,"startColumn":start_column,"endLine":end_line,"endColumn":end_column})
    }

    #[test]
    fn captured_source_never_reopens_label_and_default_reads_remain_live() {
        let temp = tempfile::tempdir().unwrap();
        let session = Arc::new(NativeSession::new(temp.path(), false).unwrap());
        let args = json!({"path":"ghost.rs","name":"persist","capturedSource":{"text":"fn persist() {}"}});
        let first = run(&session, "pi_nav_symbol_range", args.clone()).unwrap();
        assert_eq!(first.structured["data"]["status"], "found");
        std::fs::write(temp.path().join("ghost.rs"), "fn replacement() {}").unwrap();
        assert_eq!(run(&session, "pi_nav_symbol_range", args).unwrap().structured, first.structured);
        let md = json!({"path":"ghost.md","markdownStructure":true,"includeSections":true,"capturedSource":{"text":"# Supplied\nbody\n"}});
        let first_md = run(&session, "pi_nav_read", md.clone()).unwrap();
        std::fs::write(temp.path().join("ghost.md"), "# Current\nchanged\n").unwrap();
        assert_eq!(run(&session, "pi_nav_read", md).unwrap().structured, first_md.structured);
        assert_eq!(session.session.snapshot().reads, 0);
        for output in [&first, &first_md] {
            assert_eq!(output.structured["data"]["basis"], "supplied");
            assert!(output.structured["data"]["suppliedSourceHash"].is_string());
            assert!(output.source_snapshots.is_none());
            let serialized = output.structured.to_string();
            for forbidden in ["\"sourceHash\"", "\"verified\"", "\"sourceRows\""] { assert!(!serialized.contains(forbidden)); }
        }
        let ordinary = run(&session, "pi_nav_read", json!({"path":"ghost.md","markdownStructure":true,"includeSections":true})).unwrap();
        assert_eq!(ordinary.structured["data"]["files"][0]["sections"][0]["title"], "Current");
        assert!(ordinary.structured["data"]["files"][0]["sourceHash"].is_string());
        assert_eq!(session.session.snapshot().reads, 1);
        let ordinary_symbol = run(&session, "pi_nav_symbol_range", json!({"path":"ghost.rs","name":"replacement"})).unwrap();
        assert_eq!(ordinary_symbol.structured["data"]["verified"], true);
        assert_eq!(ordinary_symbol.structured["data"]["found"], true);
    }

    #[test]
    fn captured_presence_refuses_malformed_and_wrong_operations_before_dispatch() {
        let temp = tempfile::tempdir().unwrap();
        let session = Arc::new(NativeSession::new(temp.path(), false).unwrap());
        for operation in ["pi_nav_source_proof", "pi_nav_semantic_encode", "pi_nav_grep_cursor_owner", "pi_nav_search", "unknown"] {
            for captured in [Value::Null, json!({"text":"fn supplied() {}"})] {
                assert!(run(&session, operation, json!({"path":"absent.rs","capturedSource":captured})).unwrap_err().to_string().contains("capturedSource"));
            }
        }
        for captured in [Value::Null, json!({}), json!({"text":42}), json!({"text":"", "extra":true})] {
            assert!(run(&session, "pi_nav_symbol_range", json!({"path":"absent.rs","name":"x","capturedSource":captured})).is_err());
        }
        assert!(run(&session, "pi_nav_read", json!({"path":"absent.md","capturedSource":{"text":""}})).is_err());
        assert!(run(&session, "pi_nav_semantic_inputs", json!({"owners":[]})).is_err());
        for path in ["../escape.rs", "/absolute.rs", "a/./b.rs", "a//b.rs"] {
            assert!(captured_request("pi_nav_symbol_range", &json!({"path":path,"name":"x","capturedSource":{"text":""}})).is_err());
        }
        assert!(captured_request("pi_nav_symbol_range", &json!({"path":"x.rs","name":"x","capturedSource":{"text":"x".repeat(MAX_CAPTURED_SOURCE_BYTES)}})).is_ok());
        assert!(captured_request("pi_nav_symbol_range", &json!({"path":"x.rs","name":"x","capturedSource":{"text":"x".repeat(MAX_CAPTURED_SOURCE_BYTES + 1)}})).is_err());
        assert_eq!(session.session.snapshot().reads, 0);
    }

    #[test]
    fn captured_semantic_projection_owns_body_identity_recipe_and_utf16_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        let session = Arc::new(NativeSession::new(temp.path(), false).unwrap());
        let body = "function persist() { const local = 7; function nested() { return 'HIDDEN'; } return local; }";
        let text = format!("/*😀*/ {body}");
        let exact = owner(&text, body, "owner", "function");
        let mut wrong_kind = exact.clone(); wrong_kind["id"] = json!("wrong-kind"); wrong_kind["kind"] = json!("class");
        let mut invalid = exact.clone(); invalid["id"] = json!("invalid"); invalid["startColumn"] = json!(3);
        let output = run(&session, "pi_nav_semantic_inputs", json!({"path":"absent.ts","capturedSource":{"text":text},"owners":[exact,wrong_kind,invalid]})).unwrap();
        let data = &output.structured["data"];
        assert_eq!(data["recipe"], get_build_info().semantic_recipe);
        assert_eq!(data["dimensions"], get_build_info().semantic_dimensions);
        assert_eq!(data["owners"][0]["status"], "ok");
        let input: Value = serde_json::from_str(data["owners"][0]["input"].as_str().unwrap()).unwrap();
        assert_eq!(input.as_array().unwrap().len(), 7);
        assert_eq!(input[0], crate::semantic::REPRESENTATION);
        let owned_body = input[6].as_str().unwrap();
        assert!(owned_body.contains("const local = 7") && owned_body.contains("return local"));
        assert!(!owned_body.contains("HIDDEN") && !owned_body.contains("function nested"));
        assert_eq!(data["owners"][1]["status"], "kind_mismatch");
        assert_eq!(data["owners"][2]["status"], "invalid_extent");
        let shifted = format!("\n\n{text}");
        let shifted_owner = owner(&shifted, body, "different-graph-id", "function");
        let shifted_output = run(&session, "pi_nav_semantic_inputs", json!({"path":"absent.ts","capturedSource":{"text":shifted},"owners":[shifted_owner]})).unwrap();
        assert_eq!(shifted_output.structured["data"]["owners"][0]["input"], data["owners"][0]["input"]);
        let rust = "/*😀*/ fn persist() { let local = 7; local; }";
        let rust_owner = owner(rust, "fn persist() { let local = 7; local; }", "rust", "function");
        let output = run(&session, "pi_nav_semantic_inputs", json!({"path":"absent.rs","capturedSource":{"text":rust},"owners":[rust_owner]})).unwrap();
        assert_eq!(output.structured["data"]["owners"][0]["status"], "ok");
        assert_eq!(output.structured["data"]["owners"][0]["coverage"], "legacy-outline-owned");
        let duplicate = run(&session, "pi_nav_symbol_range", json!({"path":"absent.rs","name":"same","capturedSource":{"text":"fn same() {} fn same() {}"}})).unwrap();
        assert_eq!(duplicate.structured["data"]["status"], "ambiguous");
        assert!(duplicate.structured["data"].get("definition").is_none());
        assert!(crate::search::prepared::byte_at("😀", 1, 1).is_err());
        assert!(crate::search::prepared::byte_at("x", 2, 0).is_err());
        assert_eq!(session.session.snapshot().reads, 0);
    }
    #[test]
    fn captured_semantic_limits_and_outline_ambiguity_are_explicit() {
        let temp = tempfile::tempdir().unwrap();
        let session = Arc::new(NativeSession::new(temp.path(), false).unwrap());
        let text = "fn same() {} fn same() {}";
        let exact = owner(text, "fn same() {}", "same", "function");
        let call = |text: &str, owners: Value| run(&session, "pi_nav_semantic_inputs",
            json!({"path":"absent.rs","capturedSource":{"text":text},"owners":owners}));
        let output = call(text, json!([exact.clone()])).unwrap();
        assert_eq!(output.structured["data"]["owners"][0]["status"], "ambiguous");
        assert!(output.structured["data"]["owners"][0].get("input").is_none());
        assert!(call(text, json!([exact.clone(), exact.clone()])).is_err());
        let owners = (0..17).map(|i| { let mut value = exact.clone(); value["id"] = json!(i.to_string()); value }).collect::<Vec<_>>();
        assert!(call(text, json!(owners)).is_err());
        let mut malformed = exact.clone(); malformed["startLine"] = json!("x".repeat(300_000));
        assert!(call(text, json!([malformed])).unwrap_err().to_string().len() < 256);
        let mut too_long = exact; too_long["id"] = json!("x".repeat(257));
        assert!(call(text, json!([too_long])).is_err());
        let huge = format!("fn huge() {{ /*{}*/ }}", "x".repeat(crate::semantic::MAX_TEXT_BYTES));
        let output = call(&huge, json!([owner(&huge, &huge, "huge", "function")])).unwrap();
        assert_eq!(output.structured["data"]["owners"][0]["status"], "oversized");
        assert!(output.structured["data"]["owners"][0].get("input").is_none());
        let mut widened = owner("fn small() {} ", "fn small() {}", "wide", "function");
        widened["endColumn"] = json!(14);
        let output = call("fn small() {} ", json!([widened])).unwrap();
        assert_eq!(output.structured["data"]["owners"][0]["status"], "unsupported");
        assert!(output.structured["data"]["owners"][0].get("input").is_none());
        let empty = call("", json!([])).unwrap();
        assert_eq!(empty.structured["data"]["recipe"], get_build_info().semantic_recipe);
        assert_eq!(empty.structured["data"]["owners"], json!([]));
    }


    #[test]
    fn captured_projection_accounts_for_full_envelope_and_escaped_inputs() {
        let owners = (0..16).map(|id| json!({"id":id.to_string(),"status":"ok","input":"\"".repeat(crate::semantic::MAX_TEXT_BYTES)})).collect::<Vec<_>>();
        let output = captured_output("pi_nav_semantic_inputs", "x.ts", "", json!({"owners":owners})).unwrap();
        assert!(captured_envelope_size(&output) <= MAX_PROJECTION_BYTES);
        let owners = output.structured["data"]["owners"].as_array().unwrap();
        assert_eq!(owners.len(), 16);
        assert!(owners.iter().any(|owner| owner["status"] == "output_limit" && owner.get("input").is_none()));
        assert_eq!(output.structured["data"]["complete"], false);
        assert_eq!(get_build_info().semantic_recipe.len(), 64);
        assert_eq!(get_build_info().semantic_dimensions, 256);
    }
}
