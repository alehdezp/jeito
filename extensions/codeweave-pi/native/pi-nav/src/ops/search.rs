use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::cache::OutlineCache;
use crate::index::bloom::BloomFilterCache;
use crate::output::{
    IncompleteReason, Location, SearchMatch as OutputSearchMatch, SourceRow, ToolOutput,
};
use crate::session::Session;
use crate::types::{FacetTotals, SearchResult};

use crate::search::capture::{Collection, RankedCapture};
use crate::search::continuation::{Progress, RankedCursor, RetainedRanked};

use super::{apply_budget, resolve_scope};

#[cfg(test)]
fn tool_search(
    args: &Value,
    cache: &OutlineCache,
    session: &Session,
    bloom: &Arc<BloomFilterCache>,
) -> Result<String, String> {
    let root = args.get("root").and_then(Value::as_str).map_or_else(
        || std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        PathBuf::from,
    );
    let context = crate::dispatch::OperationContext {
        root: root.canonicalize().unwrap_or(root),
        deadline: None,
        cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        confine_to_root: false,
        read_format: crate::dispatch::ReadFormat::Plain,
    };
    tool_search_output(args, cache, session, bloom, &context).map(|output| output.text)
}

pub(crate) fn tool_search_output(
    args: &Value,
    cache: &OutlineCache,
    session: &Session,
    bloom: &Arc<BloomFilterCache>,
    context: &crate::dispatch::OperationContext,
) -> Result<ToolOutput, String> {
    let matches_private = ["retainMatchesRender", "renderMatches", "matchesRenderBytes", "matchesAdmission"]
        .iter().any(|key| args.get(*key).is_some());
    if matches_private {
        if !matches!(args.get("retainMatchesRender"), None | Some(Value::Bool(_))) {
            return Err("retainMatchesRender must be a boolean".into());
        }
        let render = args.get("renderMatches");
        if let Some(handle) = render {
            handle.as_str().filter(|value| !value.is_empty() && value.len() <= 128)
                .ok_or("renderMatches requires an original-progress handle")?;
        }
        if let Some(bytes) = args.get("matchesRenderBytes") {
            if render.is_none() {
                return Err("matchesRenderBytes requires renderMatches; initial and public continuation pages use the default allowance".into());
            }
            bytes.as_u64().filter(|value| (1..=16_000).contains(value))
                .ok_or("matchesRenderBytes must be an integer from 1 through 16000")?;
        }
        if args.as_object().is_some_and(|object| object.keys().any(|key| {
            key.starts_with("analysis") || matches!(key.as_str(),
                "retainRankedRender" | "rankedRenderAllowance" | "renderRanked" |
                "captureRanked" | "resumeRanked" | "corpusAdmission" | "focus" | "capturedSource")
        })) {
            return Err("private Matches rendering cannot carry ranked, prepared, or supplied-source arguments".into());
        }
        if render.is_some() {
            if args.as_object().is_some_and(|object| object.keys()
                .any(|key| !matches!(key.as_str(), "renderMatches" | "matchesRenderBytes" | "root"))) {
                return Err("renderMatches accepts only its original-progress handle and matchesRenderBytes".into());
            }
            context.check().map_err(|error| error.to_string())?;
            return crate::search::matches::execute(args, cache, session, context);
        }
        if let Some(cursor) = args.get("cursor") {
            let id = cursor.as_str().filter(|value| !value.is_empty()).ok_or("cursor must be a nonempty string")?;
            if id.starts_with("grep-ranked-") || session.get_ranked_cursor(id).is_some() {
                return Err("private Matches rendering cannot resume a ranked cursor".into());
            }
        } else if args["output"] != "matches" {
            return Err("private Matches rendering requires output matches or an audit cursor".into());
        }
    }
    if args.get("analysisProjection").is_some() {
        return crate::search::prepared::projection::execute(args, context);
    }
    let retain_render = match args.get("retainRankedRender") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        _ => return Err("retainRankedRender must be a boolean".into()),
    };
    let fitting = retain_render || args.get("renderRanked").is_some();
    if args.get("rankedRenderAllowance").is_some() && !fitting { return Err("rankedRenderAllowance requires private ranked rendering".into()); }
    if fitting {
        ranked_render_allowance(args)?;
        if args["output"] == "matches" || matches!(args["kind"].as_str(), Some("content" | "regex" | "callers")) {
            return Err("private ranked rendering does not accept audit requests".into());
        }
    }
    if let Some(handle) = args.get("renderRanked") {
        let handle = handle.as_str().filter(|value| !value.is_empty() && value.len() <= 128).ok_or("renderRanked requires an original-progress handle")?;
        if args.get("cursor").is_some() { return Err("renderRanked cannot override a public cursor".into()); }
        let cursor = session.get_ranked_cursor(handle).ok_or("ranked render handle is unavailable or evicted; no collection was rerun")?;
        return ranked_cursor_output(args, cursor, cache, session, context);
    }
    // Corpus admission is legal for every ranked discovery kind and for widened
    // `all` visibility: the admitted file set is what the ranked collection may
    // read. Explicit audits and legacy callers keep their own admission owners.
    if args.get("corpusAdmission").is_some()
        && (args["output"] == "matches" || matches!(args["kind"].as_str(), Some("callers")))
    {
        return Err("corpus admission is ranked-discovery-only; explicit audits and legacy callers requests must not carry it".into());
    }
    if args.get("focus").is_some() && (args.get("cursor").is_some() || args.get("output").and_then(Value::as_str) == Some("matches")) {
        return Err("focus is ranked-only and cannot override a cursor request".into());
    }
    if let Some(id) = args.get("cursor").and_then(Value::as_str) {
        if let Some(cursor) = session.get_ranked_cursor(id) { return ranked_cursor_output(args, cursor, cache, session, context); }
        if id.starts_with("grep-ranked-") { return Err("ranked cursor is unavailable or evicted; restart the original query".into()); }
        if fitting { return Err("private ranked rendering cannot resume an ordinary audit cursor".into()); }
        if args.get("corpusAdmission").is_some() { return Err("ranked corpus admission cannot resume an ordinary audit cursor".into()); }
    }
    let capturing = match args.get("captureRanked") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        _ => return Err("captureRanked must be a boolean".into()),
    };
    if capturing && (args.get("resumeRanked").is_some() || args.as_object().is_some_and(|object| {
        object.keys().any(|key| key.starts_with("analysis"))
    })) {
        return Err("captureRanked requires live collection without analysis or resume fields".into());
    }
    let mut baseline_cursor = None;
    let resumed = if let Some(id) = args.get("resumeRanked") {
        let id = id.as_str().filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or("resumeRanked requires a private capture handle")?;
        let capture = session.take_ranked_capture(id)?;
        capture.validate(args, context)?;
        baseline_cursor = capture.baseline_cursor.clone();
        Some(capture.collection)
    } else { None };
    context.check().map_err(|error| error.to_string())?;
    let resuming_sources = resumed.as_ref().map(|capture| capture.result().sources.clone());
    let mut retained = None;
    let mut receipt = Progress::default();
    let mut output = search_output_inner(args, cache, session, bloom, context, resumed, &mut retained, &mut receipt)?;
    if let Some(sources) = resuming_sources {
        // Optional work/rendering must not hide drift after the initial resume check.
        sources.validate_retained(context)?;
        context.check().map_err(|error| error.to_string())?;
    }
    if retain_render {
        let render = (|| -> Result<Arc<RankedCursor>, String> {
            let collection = retained.as_ref().ok_or("request has no eligible retained ranked collection")?;
            let frame = output.ranked_render_frame.clone().ok_or("ranked first-answer framing is unavailable")?;
            let mut evidence = RetainedRanked::new(context.root.clone(), args, collection.clone(), &output.structured["data"])?;
            let owned = Arc::get_mut(&mut evidence).expect("new ranked evidence");
            owned.bytes = owned.bytes.saturating_add(frame.prefix.len()).saturating_add(frame.suffix.len());
            if owned.bytes > crate::search::capture::MAX_CAPTURE_BYTES { return Err("ranked framing exceeds retained-evidence bounds".into()); }
            owned.frame = Some(frame);
            let origin = RankedCursor { evidence, progress: Progress::default() };
            let id = session.put_ranked_cursor(origin, baseline_cursor.as_deref())?;
            session.get_ranked_cursor(&id).ok_or_else(|| "ranked render origin was evicted".into())
        })();
        match render {
            Ok(origin) => {
                let mut retry = json!({"renderRanked":origin.id(), "rankedRenderAllowance":ranked_render_allowance(args)?});
                for key in ["root", "corpusAdmission", "analysisDatabase", "analysisRevision", "analysisCorpusFiles", "analysisPolicyDigest"] {
                    if let Some(value) = args.get(key) { retry[key] = value.clone(); }
                }
                // Retention failure is optional; failed freshness/admission is not.
                output = ranked_cursor_output_protected(&retry, origin, cache, session, context, baseline_cursor.as_deref())?;
            },
            Err(reason) => output.ranked_render_unavailable = Some(bounded_ranked_reason(reason)),
        }
    } else if let Some(collection) = retained.as_ref().filter(|collection| RetainedRanked::remaining_in(collection, &receipt) > 0) {
        match context.check().map_err(|error| error.to_string()).and_then(|_| RetainedRanked::new(context.root.clone(), args, collection.clone(), &output.structured["data"])) {
            Ok(evidence) => offer_ranked_cursor(&mut output, evidence, receipt, session, baseline_cursor.as_deref()),
            Err(reason) => ranked_cursor_unavailable(&mut output, &reason),
        }
    }
    if capturing {
        match context.check().map_err(|error| error.to_string())
            .and_then(|_| retained.ok_or_else(|| "request has no eligible ranked collection".to_string()))
            .and_then(|collection| {
                let mut capture = RankedCapture::new(context.root.clone(), args, collection)?;
                capture.baseline_cursor = output.ranked_render_cursor.clone().or_else(|| output.structured["data"]["cursor"].as_str().map(str::to_owned));
                Ok(capture)
            })
            .and_then(|capture| session.put_ranked_capture(capture)) {
            Ok(id) => match context.check() {
                Ok(()) => output.search_capture = Some(id),
                Err(error) => {
                    let _ = session.take_ranked_capture(&id);
                    output.search_capture_unavailable = Some(error.to_string());
                }
            },
            Err(mut reason) => {
                // Match the private bridge bound without invalidating a usable
                // baseline merely because an input path was unusually long.
                reason = bounded_ranked_reason(reason);
                output.search_capture_unavailable = Some(reason);
            }
        }
    }
    Ok(output)
}

fn bounded_ranked_reason(mut reason: String) -> String {
    if reason.len() > 1024 {
        let mut end = 1021;
        while !reason.is_char_boundary(end) { end -= 1; }
        reason.truncate(end);
        reason.push_str("...");
    }
    reason
}

fn ranked_cursor_unavailable(output: &mut ToolOutput, reason: &str) {
    let reason = bounded_ranked_reason(reason.to_owned());
    output.structured["data"]["cursorUnavailable"] = json!(reason);
    let _ = write!(output.text, "\nRanked continuation unavailable: {reason}. Restart the original query for a fresh result.");
}

fn offer_ranked_cursor(output: &mut ToolOutput, evidence: Arc<RetainedRanked>, progress: Progress, session: &Session, protected: Option<&str>) {
    offer_ranked_cursor_protected(output, evidence, progress, session, &protected.into_iter().collect::<Vec<_>>());
}

fn offer_ranked_cursor_protected(output: &mut ToolOutput, evidence: Arc<RetainedRanked>, progress: Progress, session: &Session, protected: &[&str]) {
    let remaining = evidence.remaining(&progress);
    output.structured["data"]["remainingGroups"] = json!(remaining);
    output.structured["data"]["completedGroups"] = json!(progress.complete.len());
    if remaining == 0 { return; }
    match session.put_ranked_cursor_protected(RankedCursor { evidence, progress }, protected) {
        Ok(id) => {
            output.structured["data"]["cursor"] = json!(id);
            output.structured["completeness"]["complete"] = json!(false);
            output.structured["completeness"]["reason"] = json!(IncompleteReason::Budget);
            let _ = write!(output.text, "\n{remaining} retained source/evidence group(s) remain; compact locators are not completed rich evidence.\nMore: cursor {id}");
        }
        Err(reason) => ranked_cursor_unavailable(output, &reason),
    }
}

fn ranked_render_allowance(args: &Value) -> Result<u64, String> {
    match args.get("rankedRenderAllowance") {
        None => Ok(4_000),
        Some(value) => value.as_u64().filter(|value| (1..=4_000).contains(value)).ok_or_else(|| "rankedRenderAllowance must be an integer from 1 through 4000; it is not a reference-token guarantee".into()),
    }
}

fn ranked_cursor_output(args: &Value, cursor: Arc<RankedCursor>, cache: &OutlineCache, session: &Session,
    context: &crate::dispatch::OperationContext) -> Result<ToolOutput, String> {
    ranked_cursor_output_protected(args, cursor, cache, session, context, None)
}

fn ranked_cursor_output_protected(args: &Value, cursor: Arc<RankedCursor>, cache: &OutlineCache, session: &Session,
    context: &crate::dispatch::OperationContext, fallback: Option<&str>) -> Result<ToolOutput, String> {
    let evidence = &cursor.evidence;
    evidence.validate(args, context)?;
    let private = args.get("renderRanked").is_some() || args["retainRankedRender"] == true;
    let allowance = ranked_render_allowance(args)?;
    let initial = cursor.progress == Progress::default() && evidence.frame.is_some();
    let result = evidence.page_result(&cursor.progress);
    let rendered = if initial && evidence.frame.as_ref().is_some_and(|frame| frame.exact) {
        crate::search::format_exact_ranked_card_with_allowance(&result, cache, None, evidence.collection.lanes(), allowance)
    } else {
        crate::search::format_ranked_with_allowance(&result, cache, evidence.collection.lanes(), if initial { None } else { Some(&cursor.progress) }, allowance)
    }.ok_or("retained ranked evidence cannot be rendered without rediscovery; no collection was rerun")?;
    let mut progress = cursor.progress.clone();
    progress.merge(&rendered.receipt);
    if progress == cursor.progress {
        if !private { return Err("remaining ranked evidence cannot fit its source safeguards or page allowance; no group was skipped; restart the original query with a precise focus".into()); }
        let reason = "No additional coherent ranked source group fits this render allowance; no evidence was advanced.";
        let mut output = ToolOutput::incomplete("pi_nav_search", reason.into(),
            json!({"mode":"ranked", "query":evidence.data["query"], "scope":result.scope, "matches":[], "sourceRows":[], "remainingGroups":evidence.remaining(&progress)}),
            0, IncompleteReason::Budget, vec![reason.into()]);
        output.ranked_render_cursor = Some(cursor.id());
        output.ranked_render_unavailable = Some(reason.into());
        return Ok(output);
    }
    let kind = evidence.data["kind"].as_str().unwrap_or("fuzzy");
    let (matches, locations, source_rows) = search_metadata(&result, Some(&evidence.root), kind, &rendered.source_rows);
    let returned = matches.len();
    let mut data = evidence.data.clone();
    data["matches"] = json!(matches);
    data["locations"] = json!(locations);
    data["sourceRows"] = json!(source_rows);
    if data["analysis"].is_object() {
        data["analysis"]["omittedRelationshipEvidence"] = json!(rendered.omitted_relationship_evidence);
        if data["analysis"]["relation"].is_string() {
            let analysis = &mut data["analysis"];
            analysis["pageComplete"] = json!(rendered.omitted_relationship_evidence == 0);
            let page = analysis["page"].as_u64().unwrap_or(1);
            let limit = analysis["limit"].as_u64().unwrap_or(0);
            analysis["nextPage"] = if !analysis["indexedRunId"].is_string() && rendered.omitted_relationship_evidence == 0 && limit > 0
                && page.saturating_mul(limit) < analysis["totalConnections"].as_u64().unwrap_or(0) { json!(page + 1) } else { Value::Null };
        }
    }
    let text = if initial {
        let frame = evidence.frame.as_ref().unwrap();
        let prefix = if data["analysis"]["relation"].is_string() {
            format!("{}\n\n{}", prepared_relation_heading(&data["analysis"], rendered.omitted_relationship_evidence), frame.prefix.split_once("\n\n").map_or("", |(_, rest)| rest))
        } else { frame.prefix.clone() };
        format!("{prefix}{}{}", rendered.text, frame.suffix)
    } else {
        data["continuation"] = json!("retained source and selected connection evidence; no rediscovery or provider switch");
        format!("Ranked continuation for {:?} in {}\n{}\nConnection coverage remains limited to the retained selection; unsupported or partial relationships are not completed by advancing source groups.",
            data["query"].as_str().unwrap_or(""), result.scope.display(), rendered.text)
    };
    let budget = crate::budget::clamp(evidence.arguments.get("budget").and_then(Value::as_u64).unwrap_or(crate::budget::DEFAULT_BUDGET));
    let mut output = ToolOutput::bounded("pi_nav_search", text, data, returned, returned, budget).with_source_snapshots(rendered.source_snapshots);
    let complete = match &evidence.collection { Collection::Fuzzy { search, .. } => search.complete,
        Collection::Symbol { candidate_capped, lanes, .. } => !candidate_capped && lanes.as_ref().is_none_or(|lanes| lanes.complete) };
    if !complete || rendered.omitted_relationship_evidence > 0 || !evidence.data["analysis"]["extractionDiagnostics"].as_array().is_none_or(Vec::is_empty)
        || ["omittedTargets", "unassociatedTargetCount"].iter().any(|key| evidence.data["analysis"][key].as_u64().is_some_and(|count| count > 0)) {
        output.structured["completeness"]["complete"] = json!(false);
        output.structured["completeness"]["reason"] = json!(if rendered.omitted_relationship_evidence > 0 { IncompleteReason::Budget } else { IncompleteReason::Error });
    }
    evidence.validate(args, context)?;
    let origin = cursor.id();
    let mut protected = vec![origin.as_str()];
    if let Some(fallback) = fallback { protected.push(fallback); }
    if evidence.arguments.get("analysisRelation").is_none() {
        offer_ranked_cursor_protected(&mut output, evidence.clone(), progress, session, &protected);
    }
    if private { output.ranked_render_cursor = Some(origin); }
    Ok(output)
}

fn prepared_relation_heading(metadata: &Value, omitted: usize) -> String {
    if metadata["indexedRunId"].is_string() {
        return format!("Indexed {} — {} selected connection rows; {} omitted by rendering. Retained selection only; graph paging is unavailable.",
            metadata["relation"].as_str().unwrap_or("relation"), metadata["returnedConnections"], omitted);
    }
    format!("Prepared {} — page {}, limit {}, {} of {} connection rows; source may be shared across sites.{}",
        metadata["relation"].as_str().unwrap_or("relation"), metadata["page"], metadata["limit"], metadata["returnedConnections"], metadata["totalConnections"],
        if omitted > 0 { " Page incomplete: selected evidence did not fit; no next page is offered. Reduce limit and restart at page 1.".into() }
        else { metadata["nextPage"].as_u64().map_or_else(|| " End of relation pages.".into(), |next| format!(" Next page: {next}; keep target, relation and limit unchanged.")) })
}

#[allow(clippy::too_many_arguments)]
fn search_output_inner(
    args: &Value,
    cache: &OutlineCache,
    session: &Session,
    bloom: &Arc<BloomFilterCache>,
    operation_context: &crate::dispatch::OperationContext,
    resumed: Option<Collection>,
    retained: &mut Option<Collection>,
    receipt: &mut Progress,
) -> Result<ToolOutput, String> {
    operation_context
        .check()
        .map_err(|error| error.to_string())?;
    if args.get("output").and_then(Value::as_str) == Some("matches") || args.get("cursor").is_some()
    {
        return crate::search::matches::execute(args, cache, session, operation_context);
    }
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .ok_or("missing required parameter: query")?;
    let root = args.get("root").and_then(Value::as_str).map(Path::new);
    let explicit_scope = match args.get("scope").and_then(Value::as_str) {
        Some(value) if Path::new(value).is_absolute() || root.is_some() => {
            Some(super::resolve_read_path(Path::new(value), root)?)
        }
        _ => None,
    };
    let mut globs = parse_globs(args.get("glob"))?;
    let (scope, scope_warning) = if let Some(path) = explicit_scope {
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("cannot resolve scope {}: {error}", path.display()))?;
        (canonical, None)
    } else {
        resolve_scope(args, root)?
    };
    if scope.is_file() {
        // Exact files bypass directory globs; filtering after ranking/caps can already lose the target.
        globs.clear();
    } else if !scope.is_dir() {
        return Err(format!(
            "scope is not a file or directory: {}",
            scope.display()
        ));
    }
    let requested_kind = args.get("kind").and_then(Value::as_str).unwrap_or("auto");
    let (kind, query) = resolve_kind(requested_kind, query)?;
    let case_mode = args.get("case").and_then(Value::as_str).unwrap_or("smart");
    if !matches!(case_mode, "smart" | "sensitive" | "insensitive") {
        return Err(format!(
            "case must be smart, sensitive, or insensitive; got {case_mode:?}"
        ));
    }
    let sensitive =
        case_mode == "sensitive" || (case_mode == "smart" && query.chars().any(char::is_uppercase));
    let visibility =
        crate::walk::Visibility::parse(args.get("visibility").and_then(Value::as_str))?;
    let expand = args.get("expand").and_then(Value::as_u64).unwrap_or(2) as usize;
    let budget = crate::budget::clamp(
        args.get("budget")
            .and_then(Value::as_u64)
            .unwrap_or(crate::budget::DEFAULT_BUDGET),
    );
    let context_path = args
        .get("context")
        .and_then(Value::as_str)
        .map(|value| super::resolve_read_path(Path::new(value), root))
        .transpose()?;
    if resumed.as_ref().is_some_and(|capture| capture.result().scope != scope) {
        return Err("ranked capture canonical scope changed; no search was rerun".into());
    }
    let resuming = resumed.is_some();
    let sources = if let Some(capture) = resumed.as_ref() { capture.result().sources.clone() }
        else { Arc::new(crate::search::OperationSources::from_arguments(args, &operation_context.root)?) };

    let analysis_relation = args.get("analysisRelation").is_some();
    if analysis_relation
        && (kind != "symbol" || !globs.is_empty() || args.get("analysisDatabase").is_none())
    {
        return Err("analysisRelation requires an exact symbol and an admitted analysisDatabase, without globs".into());
    }
    if args.get("focus").is_some() && (!matches!(kind, "symbol" | "fuzzy") || analysis_relation) {
        return Err("focus requires ranked symbol or behavior search, not literal/regex or analysisRelation".into());
    }
    if kind == "fuzzy" || args.get("focus").is_some() || matches!(&resumed, Some(Collection::Fuzzy { .. })) {
        return fuzzy_output(
            query,
            "behavior discovery",
            case_mode,
            &scope,
            root,
            &globs,
            visibility,
            expand,
            session,
            cache,
            bloom,
            budget,
            scope_warning,
            operation_context,
            &sources,
            args,
            resumed, retained, receipt,
        );
    }
    if kind == "callers" {
        return callers_output(
            query,
            case_mode,
            sensitive,
            &scope,
            root,
            &globs,
            visibility,
            expand,
            context_path.as_deref(),
            session,
            bloom,
            budget,
            operation_context,
        );
    }
    let mut resumed_lanes = None;
    let mut live = if let Some(Collection::Symbol { result, candidate_capped, lanes }) = resumed {
        resumed_lanes = lanes;
        Some((result, candidate_capped))
    } else if !analysis_relation
        && kind == "symbol"
        && args.get("analysisDatabase").is_some()
        && expand > 0
        && globs.is_empty()
    {
        Some(gather_search(
            kind,
            query,
            &scope,
            context_path.as_deref(),
            &globs,
            visibility,
            sensitive,
            operation_context,
            sources.clone(),
        )?)
    } else {
        None
    };
    let prepared = if let Some(database) = args
        .get("analysisDatabase")
        .filter(|_| kind == "symbol" && (expand > 0 || analysis_relation) && globs.is_empty())
    {
        let database = database.as_str().ok_or("analysisDatabase must be a path")?;
        let revision = args
            .get("analysisRevision")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .ok_or("analysisRevision must identify the selected producer")?;
        if let Some((live, _)) = &live {
            crate::search::prepared::load_for_live(
                query,
                sensitive,
                revision,
                args,
                &scope,
                Path::new(database),
                operation_context,
                sources.clone(),
                live,
            )?
        } else {
            crate::search::prepared::load(
                query,
                sensitive,
                revision,
                args,
                &scope,
                Path::new(database),
                operation_context,
                sources.clone(),
            )?
        }
    } else {
        None
    };
    if let Some(prepared) = prepared
        .as_ref()
        .filter(|prepared| analysis_relation && prepared.metadata["status"] != "ok")
    {
        let status = prepared.metadata["status"]
            .as_str()
            .unwrap_or("unavailable");
        let mut text = format!(
            "Prepared {} target {query:?}: {status}; no relationships selected.",
            prepared.metadata["relation"].as_str().unwrap_or("relation")
        );
        if let Some(candidates) = prepared.metadata["candidates"]
            .as_array()
            .filter(|candidates| !candidates.is_empty())
        {
            text.push_str("\nExact captured identities (use one unchanged as target):");
            for candidate in candidates {
                let _ = write!(
                    text,
                    "\n  {}::{} — {} at {}:{}; id {}",
                    candidate["filePath"].as_str().unwrap_or(""),
                    candidate["qualifiedName"].as_str().unwrap_or(""),
                    candidate["kind"].as_str().unwrap_or(""),
                    candidate["startLine"],
                    candidate["startColumn"],
                    candidate["id"].as_str().unwrap_or("")
                );
            }
            if prepared.metadata["omittedCandidates"]
                .as_u64()
                .is_some_and(|count| count > 0)
            {
                let _ = write!(
                    text,
                    "\n{} additional exact identities omitted.",
                    prepared.metadata["omittedCandidates"]
                );
            }
        }
        return Ok(ToolOutput::bounded(
            "pi_nav_search",
            text,
            json!({"kind":kind,"analysis":prepared.metadata,"matches":[],"locations":[],"sourceRows":[]}),
            0,
            0,
            budget,
        ));
    }
    let (result, candidate_capped, prepared_lanes, mut prepared_metadata) = if let Some(
        mut prepared,
    ) = prepared
    {
        if let Some((mut live_result, capped)) = live.take() {
            // Prepared declarations can fill a live classifier gap (for example
            // a Go interface), but cannot replace any live declaration or usage.
            let lanes = if live_result.definitions == 0 {
                let added = prepared.result.matches.len();
                let mut matches = std::mem::take(&mut prepared.result.matches);
                matches.append(&mut live_result.matches);
                live_result.matches = matches;
                live_result.definitions = added;
                live_result.facet_totals.definitions += added;
                live_result.total_found += added;
                prepared.lanes
            } else if resuming {
                if let Some(mut lanes) = resumed_lanes.take() {
                    lanes.enrich(prepared.lanes);
                    lanes
                } else {
                    // No live lanes were present in this collected baseline.
                    prepared.lanes
                }
            } else {
                let targets = live_result
                    .matches
                    .iter()
                    .filter(|matched| matched.is_definition)
                    .take(5)
                    .collect::<Vec<_>>();
                let mut lanes = crate::search::lanes::collect(
                    &targets,
                    &live_result,
                    bloom,
                    visibility,
                    &globs,
                    operation_context,
                )?;
                lanes.enrich(prepared.lanes);
                lanes
            };
            prepared.metadata["sourceComposition"] = json!("live declarations, usages and ordering retained; prepared associations keep their stated source limitations");
            (live_result, capped, Some(lanes), Some(prepared.metadata))
        } else {
            (
                prepared.result,
                false,
                Some(prepared.lanes),
                Some(prepared.metadata),
            )
        }
    } else {
        let (result, capped) = match live {
            Some(live) => live,
            None => gather_search(
                kind,
                query,
                &scope,
                context_path.as_deref(),
                &globs,
                visibility,
                sensitive,
                operation_context,
                sources.clone(),
            )?,
        };
        (result, capped, if resuming { resumed_lanes.take() } else { None }, None)
    };
    if !resuming && requested_kind == "auto" && kind == "symbol" && result.total_found == 0 {
        return fuzzy_output(
            query,
            "zero-definition symbol fallback",
            case_mode,
            &scope,
            root,
            &globs,
            visibility,
            expand,
            session,
            cache,
            bloom,
            budget,
            scope_warning,
            operation_context,
            &sources,
            args,
            None, retained, receipt,
        );
    }
    operation_context
        .check()
        .map_err(|error| error.to_string())?;
    if !resuming { session.record_search(query); }
    let exact_targets = if result.definitions == 1 {
        result
            .matches
            .iter()
            .filter(|matched| matched.is_definition && matched.exact)
            .take(1)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let lanes = if prepared_lanes.is_some() {
        prepared_lanes
    } else if resuming || exact_targets.is_empty() {
        None
    } else {
        Some(crate::search::lanes::collect(
            &exact_targets,
            &result,
            bloom,
            visibility,
            &globs,
            operation_context,
        )?)
    };
    if (!analysis_relation || args["retainRankedRender"] == true) && kind == "symbol" && expand > 0 {
        *retained = Some(Collection::Symbol {
            result: result.clone(), candidate_capped, lanes: lanes.clone(),
        });
    }
    let lane_incomplete = lanes.as_ref().is_some_and(|bundle| !bundle.complete);
    let render_session = if args["retainRankedRender"] == true { None } else { Some(session) };
    // Case-insensitive or qualified queries can select one exact declaration
    // without matching its display spelling. Those use the ranked renderer,
    // including the capture handoff and every subsequent budget refit.
    let exact_render = result.facet_totals.definitions == 1
        && exact_targets.first().is_some_and(|matched| matched.impl_target.is_none()
            && matched.def_name.as_deref() == Some(result.query.as_str()))
        && lanes.as_ref().is_none_or(|bundle| bundle.prepared_cards.is_empty());
    let rendered = if resuming {
        if prepared_metadata.is_none() {
            return Err("ranked capture has no admitted prepared enrichment; retain the live answer".into());
        }
        let rendered = if !exact_render {
            crate::search::format_fuzzy_result_typed(&result, cache, render_session, lanes.as_ref())
        } else {
            crate::search::format_exact_ranked_card(&result, cache, render_session, lanes.as_ref())
        };
        rendered.ok_or_else(|| crate::error::TilthError::InvalidQuery {
            query: query.into(), reason: "captured ranked rendering unavailable; no discovery fallback used".into(),
        })
    } else if !analysis_relation && kind == "symbol" && result.definitions > 1 {
        match crate::search::format_fuzzy_result_typed(
            &result,
            cache,
            render_session,
            lanes.as_ref(),
        ) {
            Some(rendered) => Ok(rendered),
            None => crate::search::format_search_result_typed(
                &result,
                cache,
                render_session,
                bloom,
                expand,
                Some(budget),
            ),
        }
    } else if let Some(bundle) = lanes.as_ref() {
        crate::search::format_search_result_with_lanes(
            &result,
            cache,
            render_session,
            bloom,
            expand,
            Some(budget),
            bundle,
        )
    } else {
        crate::search::format_search_result_typed(
            &result,
            cache,
            render_session,
            bloom,
            expand,
            Some(budget),
        )
    }
    .map_err(|error| error.to_string())?;
    if !lane_incomplete {
        operation_context
            .check()
            .map_err(|error| error.to_string())?;
    }
    *receipt = rendered.receipt.clone();
    let rendering_omitted = rendered.omitted_relationship_evidence;
    if let Some(metadata) = prepared_metadata.as_mut() {
        metadata["omittedRelationshipEvidence"] = json!(rendering_omitted);
        if analysis_relation {
            metadata["pageComplete"] = json!(rendering_omitted == 0);
            if rendering_omitted > 0 {
                // Page numbers use the requested limit. Advancing after render
                // omission would skip selected edges, so offer no continuation.
                metadata["nextPage"] = Value::Null;
            }
        }
    }
    let (matches, locations, source_rows) =
        search_metadata(&result, root, kind, &rendered.source_rows);
    let source_snapshots = rendered.source_snapshots;
    let mut text = scope_warning.unwrap_or_default();
    text.push_str(&rendered.text);
    let extraction_diagnostics = prepared_metadata
        .as_ref()
        .and_then(|metadata| metadata["extractionDiagnostics"].as_array());
    let extraction_notice = extraction_diagnostics.filter(|diagnostics| !diagnostics.is_empty()).map(|diagnostics| {
        if prepared_metadata.as_ref().is_some_and(|metadata| metadata["indexedRunId"].is_string()) {
            format!("Indexed extraction diagnostics affect {} selected files; free text and positions are withheld. Relationship coverage may be partial.", diagnostics.len())
        } else {
            format!("Prepared connection coverage is partial: {} reference sites have no unique source-owner representation in the captured graph. Their exact positions remain in extraction diagnostics; no outer caller was substituted.", diagnostics.len())
        }
    });
    if analysis_relation {
        if let Some(metadata) = &prepared_metadata {
            text = format!("{}\n\n{}", prepared_relation_heading(metadata, rendering_omitted), text);
        }
    }
    if let Some(metadata) = &prepared_metadata {
        if let Some(run) = metadata["indexedRunId"].as_str() {
            let _ = write!(text, "\nPrepared indexed run {run}: best-effort relationships; selected source independently verified; not current relationship or absence proof.");
        } else {
            let _ = write!(text, "\nPrepared capture: generation {}, {} captured files; not whole-project or runtime-dispatch proof.",
                metadata["generation"], metadata["capturedFiles"]);
        }
        if let Some(omitted) = metadata["omittedTargets"]
            .as_u64()
            .filter(|count| *count > 0)
        {
            let _ = write!(text, "\n{omitted} additional exact captured identities omitted; at most five rich targets are projected.");
        }
        if let Some(count) = metadata["unassociatedTargetCount"]
            .as_u64()
            .filter(|count| *count > 0)
        {
            let _ = write!(text, "\nPrepared source association unavailable for {count} matching graph targets; no guessed source identities were attached. Live declarations and evidence remain available.");
        }
    }
    if let Some(notice) = &extraction_notice {
        let _ = write!(text, "\n{notice}");
    }
    let returned = matches.len();
    let data = json!({
        "mode": "ranked", "query": args.get("query").and_then(Value::as_str).unwrap_or(query), "scope": scope,
        "visibility": args.get("visibility").and_then(Value::as_str).unwrap_or("project"),
        "kind": kind,
        "case": case_mode,
        "matches": matches,
        "locations": locations,
        "sourceRows": source_rows,
        "totalFound": result.total_found,
        "analysis": prepared_metadata,
        "definitions": result.definitions,
        "usages": result.usages,
        "facetTotals": {
            "definitions": result.facet_totals.definitions,
            "implementations": result.facet_totals.implementations,
            "tests": result.facet_totals.tests,
            "usagesLocal": result.facet_totals.usages_local,
            "usagesCross": result.facet_totals.usages_cross,
        },
    });
    let prepared_omitted = prepared_metadata.as_ref().is_some_and(|metadata| {
        result.total_found > result.matches.len()
            || metadata["omittedTargets"]
                .as_u64()
                .is_some_and(|count| count > 0)
    });
    let mut output = if candidate_capped || lane_incomplete {
        let mut diagnostics = if candidate_capped {
            vec!["search reached its candidate cap; total is unknown".into()]
        } else {
            Vec::new()
        };
        if let Some(bundle) = lanes.as_ref() {
            diagnostics.extend(bundle.diagnostics.clone());
        }
        let reason = if candidate_capped {
            IncompleteReason::CandidateCap
        } else if operation_context
            .cancelled
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            IncompleteReason::Cancelled
        } else {
            IncompleteReason::Deadline
        };
        ToolOutput::incomplete("pi_nav_search", text, data, returned, reason, diagnostics)
    } else {
        ToolOutput::bounded(
            "pi_nav_search",
            text,
            data,
            returned,
            result.total_found,
            budget,
        )
    };
    if prepared_omitted {
        output.structured["completeness"]["complete"] = json!(false);
        output.structured["completeness"]["reason"] = json!(IncompleteReason::Budget);
        let diagnostic = prepared_metadata
            .as_ref()
            .and_then(|metadata| {
                metadata["omittedTargets"]
                    .as_u64()
                    .filter(|count| *count > 0)
            })
            .map_or_else(
                || {
                    format!(
                        "{} search matches counted; {} result records retained",
                        result.total_found,
                        result.matches.len()
                    )
                },
                |omitted| {
                    format!("{omitted} exact captured identities omitted from prepared projection")
                },
            );
        output.structured["diagnostics"]
            .as_array_mut()
            .expect("diagnostics array")
            .push(json!(diagnostic));
    }
    if rendering_omitted > 0 {
        output.structured["completeness"]["complete"] = json!(false);
        output.structured["completeness"]["reason"] = json!(IncompleteReason::Budget);
        output.structured["diagnostics"].as_array_mut().expect("diagnostics array")
            .push(json!(format!("{rendering_omitted} relationship evidence groups or annotations omitted during rendering")));
    }
    if let Some(notice) = extraction_notice {
        output.structured["completeness"]["complete"] = json!(false);
        if !prepared_omitted && rendering_omitted == 0 {
            output.structured["completeness"]["reason"] = json!(IncompleteReason::Error);
        }
        output.structured["diagnostics"]
            .as_array_mut()
            .expect("diagnostics array")
            .push(json!(notice));
    }
    if args["retainRankedRender"] == true {
        output.ranked_render_frame = crate::search::continuation::RenderFrame::capture(&output.text, &rendered.text,
            exact_render);
    }
    Ok(output.with_source_snapshots(source_snapshots))
}

/// A focus that names a target selects one exact owner; an evidence-only focus
/// keeps the ordinary connected candidates and selects nothing.
fn focus_targeted(focus: Option<&Value>) -> bool {
    focus.is_some_and(|focus| focus["target"].is_string())
}

fn merge_semantic_metadata(prepared: &mut Value, semantic: &Value) -> Result<(), String> {
    if crate::search::prepared::semantic_publication(semantic).is_none() { return Ok(()); }
    // Both identity variants are compared, so a G1/indexed mix cannot match
    // merely because the other variant's keys are absent on both sides.
    for key in ["generation", "captureDigest", "indexedRunId", "indexedStatusDigest",
        "interpretationRevision", "policyDigest", "corpusDigest"] {
        if semantic.get(key) != prepared.get(key) {
            return Err("prepared publication changed between semantic selection and connections; retain live evidence".into());
        }
    }
    prepared["semantic"] = semantic.clone();
    if semantic["indexedRunId"].is_string() { prepared["semanticStatus"] = semantic["status"].clone(); }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn fuzzy_output(
    query: &str,
    route_label: &'static str,
    case_mode: &str,
    scope: &Path,
    root: Option<&Path>,
    globs: &[String],
    visibility: crate::walk::Visibility,
    expand: usize,
    session: &Session,
    cache: &OutlineCache,
    bloom: &Arc<BloomFilterCache>,
    budget: u64,
    scope_warning: Option<String>,
    operation_context: &crate::dispatch::OperationContext,
    sources: &Arc<crate::search::OperationSources>,
    args: &Value,
    resumed: Option<Collection>,
    retained: &mut Option<Collection>,
    receipt: &mut Progress,
) -> Result<ToolOutput, String> {
    let resuming = resumed.is_some();
    let (mut fuzzy, mut lanes, route_label) = match resumed {
        Some(Collection::Fuzzy { search, route, lanes }) => (search, lanes, route),
        Some(_) => return Err("ranked capture collection kind changed".into()),
        None => {
            let focus = args.get("focus").map(|value| crate::search::focus::Focus::parse(value, scope, sources)).transpose()?;
            let mut fuzzy = crate::search::fuzzy::search_with_focus(
                query,
                scope,
                globs,
                visibility,
                sources.clone(),
                operation_context,
                focus.as_ref(),
            )?;
            let zero_terms = fuzzy
                .term_counts
                .iter()
                .filter(|(_, count)| *count == 0 && !focus_targeted(fuzzy.focus.as_ref()))
                .map(|(term, _)| term.clone())
                .collect::<Vec<_>>();
            let mut seen_mentions = HashSet::new();
            let mut exact_mention_counts = HashMap::new();
            for term in zero_terms {
                let (mentions, candidate_capped) = gather_search(
                    "content",
                    &term,
                    scope,
                    None,
                    globs,
                    visibility,
                    false,
                    operation_context,
                    sources.clone(),
                )?;
                if candidate_capped {
                    fuzzy.complete = false;
                    fuzzy.diagnostics.push(format!(
                        "exact-mention fallback for {term:?} reached its candidate cap"
                    ));
                }
                for mut matched in mentions.matches {
                    if matched.is_definition || crate::types::is_test_file(&matched.path) {
                        continue;
                    }
                    let key = (matched.path.clone(), matched.line, matched.text.clone());
                    if seen_mentions.insert(key) {
                        *exact_mention_counts.entry(term.clone()).or_insert(0usize) += 1;
                        matched.exact = true;
                        fuzzy.result.matches.push(matched);
                        fuzzy.result.usages += 1;
                        fuzzy.result.total_found += 1;
                    }
                }
            }
            for (term, count) in exact_mention_counts {
                if let Some((_, status)) = fuzzy
                    .term_fallbacks
                    .iter_mut()
                    .find(|(candidate, _)| candidate == &term)
                {
                    let nearest = status
                        .strip_prefix("nearest-symbol")
                        .map(|suffix| format!(" + nearest-symbol{suffix}"))
                        .unwrap_or_default();
                    *status = format!("exact-mentions:{count}{nearest}");
                }
            }
            let lanes = {
                let targets = crate::search::fuzzy::rich_targets(&fuzzy.result)
                    .into_iter()
                    .filter(|matched| matches!(
                        crate::lang::detect_file_type(&matched.path),
                        crate::types::FileType::Code(_)
                    ))
                    .collect::<Vec<_>>();
                if targets.is_empty() || (focus_targeted(fuzzy.focus.as_ref())
                    && fuzzy.focus.as_ref().is_some_and(|focus| focus["status"] != "ok")) {
                    None
                } else {
                    Some(crate::search::lanes::collect(
                        &targets,
                        &fuzzy.result,
                        bloom,
                        visibility,
                        globs,
                        operation_context,
                    )?)
                }
            };
            (fuzzy, lanes, route_label)
        }
    };
    if resuming { operation_context.check().map_err(|error| error.to_string())?; }
    let semantic_eligible = !focus_targeted(fuzzy.focus.as_ref()) && !query.contains('|')
        && route_label == "behavior discovery" && args["kind"] != "symbol"
        && globs.is_empty() && visibility == crate::walk::Visibility::Project;
    let mut semantic_metadata = semantic_eligible.then(|| json!({"status":"unavailable",
        "reason":"no admitted semantic publication supplied; live lexical evidence is retained without indexing"}));
    if semantic_eligible && args.get("analysisDatabase").is_some() {
        match crate::search::prepared::semantic_candidates(query, args, scope, operation_context, sources.clone()) {
            Ok((candidates, metadata)) => {
                if !candidates.is_empty() {
                    crate::search::fuzzy::fuse_semantic(&mut fuzzy, candidates);
                    let targets = crate::search::fuzzy::rich_targets(&fuzzy.result).into_iter()
                        .filter(|matched| matches!(crate::lang::detect_file_type(&matched.path), crate::types::FileType::Code(_)))
                        .collect::<Vec<_>>();
                    lanes = match crate::search::lanes::collect(&targets, &fuzzy.result, bloom, visibility, globs, operation_context) {
                        Ok(lanes) => Some(lanes),
                        Err(reason) => { fuzzy.complete = false; fuzzy.diagnostics.push(format!("Selected connections unavailable: {reason}")); None }
                    };
                }
                if metadata["complete"] != true {
                    fuzzy.complete = false;
                    fuzzy.diagnostics.push(format!("Semantic scope coverage: {} examined graph declarations, {} unrepresented, {} missing features, {} invalid features, {} unassociated, {} stale omitted; capped={}, sourceCapped={}. Preparation coverage: {}. Unexamined candidates are not retained for continuation.",
                        metadata["examined"], metadata["unrepresented"], metadata["missingFeatures"], metadata["invalidFeatures"], metadata["unassociated"], metadata["staleCandidates"], metadata["capped"], metadata["sourceCapped"], metadata["preparation"]));
                }
                semantic_metadata = Some(metadata);
            }
            Err(reason) => { semantic_metadata = Some(json!({"status":"unavailable","reason":reason})); }
        }
    }
    // Semantic discovery owns an admitted publication even when no connection can be projected.
    let mut prepared_metadata = semantic_metadata.as_ref().and_then(crate::search::prepared::semantic_publication);
    if let Some(database) = args.get("analysisDatabase").filter(|_| {
        lanes.is_some() && globs.is_empty() && visibility == crate::walk::Visibility::Project
    }) {
        let database = database.as_str().ok_or("analysisDatabase must be a path")?;
        let revision = args
            .get("analysisRevision")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .ok_or("analysisRevision must identify the selected producer")?;
        let sensitive = case_mode == "sensitive"
            || (case_mode == "smart" && query.chars().any(char::is_uppercase));
        let connections = crate::search::prepared::load_for_live(
            query,
            sensitive,
            revision,
            args,
            scope,
            Path::new(database),
            operation_context,
            sources.clone(),
            &fuzzy.result,
        );
        match connections {
        Ok(Some(mut prepared)) => {
            if let Some(semantic) = semantic_metadata.as_ref() {
                merge_semantic_metadata(&mut prepared.metadata, semantic)?;
            }
            if let Some(lanes) = &mut lanes {
                lanes.enrich(prepared.lanes);
            }
            prepared.metadata["sourceComposition"] = json!("source-validated candidates; connections selected by captured graph identity or exact syntax association");
            prepared.metadata["connectionsStatus"] = json!("available");
            prepared.metadata["liveDefinitions"] = json!(fuzzy.result.definitions);
            prepared_metadata = Some(prepared.metadata);
        }
        Ok(None) => {},
        Err(reason) if prepared_metadata.is_some() => {
            fuzzy.complete = false;
            fuzzy.diagnostics.push(format!("Prepared connections unavailable: {reason}"));
        },
        Err(reason) => return Err(reason),
        }
    }
    if let Some(metadata) = prepared_metadata.as_ref().filter(|metadata| metadata.get("semantic").is_some()) {
        sources.validate_retained(operation_context)?;
        let database = Path::new(args["analysisDatabase"].as_str().ok_or("semantic publication has no database")?);
        crate::search::prepared::validate_continuation(args, metadata, database, operation_context, sources.clone())?;
    }
    if resuming && prepared_metadata.is_none() {
        return Err("ranked capture has no admitted prepared enrichment; retain the live answer".into());
    }
    if let Some(categories) = fuzzy.focus.as_ref().and_then(|focus| focus["evidence"].as_array()) {
        let categories = categories.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
        if !categories.is_empty() {
            if let Some(bundle) = &mut lanes { bundle.focus(&categories); }
        }
    }
    if let Some(bundle) = lanes.as_ref() {
        fuzzy.complete &= bundle.complete;
        fuzzy.diagnostics.extend(bundle.diagnostics.clone());
    }
    if !resuming { session.record_search(query); }
    if resuming { operation_context.check().map_err(|error| error.to_string())?; }
    let render_session = if args["retainRankedRender"] == true { None } else { Some(session) };
    let rendered = if fuzzy.result.matches.is_empty() && focus_targeted(fuzzy.focus.as_ref()) {
        crate::search::FormattedSearchResult {
            text: "No exact eligible focused declaration was selected; no nearest binding substituted.".into(),
            source_rows: Vec::new(), source_snapshots: Vec::new(), omitted_relationship_evidence: 0,
            receipt: Progress::default(),
        }
    } else if let Some(cards) = crate::search::format_fuzzy_result_typed(
        &fuzzy.result,
        cache,
        render_session,
        lanes.as_ref(),
    ) {
        cards
    } else if resuming {
        return Err("captured fuzzy rendering unavailable; no discovery fallback used".into());
    } else {
        crate::search::format_search_result_typed(
            &fuzzy.result,
            cache,
            render_session,
            bloom,
            expand.max(5),
            Some(budget),
        )
        .map_err(|error| error.to_string())?
    };
    let (matches, locations, source_rows) =
        search_metadata(&fuzzy.result, root, "fuzzy", &rendered.source_rows);
    let returned = matches.len();
    let fallback_by_term = fuzzy
        .term_fallbacks
        .iter()
        .cloned()
        .collect::<HashMap<_, _>>();
    let term_status = fuzzy
        .term_counts
        .iter()
        .map(|(term, count)| {
            let status = fallback_by_term.get(term).map_or("unknown", String::as_str);
            format!("{term}={count} [{status}]")
        })
        .collect::<Vec<_>>()
        .join(" · ");
    let mut text = scope_warning.unwrap_or_default();
    if let Some(focus) = &mut fuzzy.focus {
        let targeted = focus["target"].is_string();
        let associated = prepared_metadata.as_ref().is_some_and(|metadata| metadata["sourceAssociation"] != "unavailable");
        let categories = focus["evidence"].as_array().cloned().unwrap_or_default();
        let target_status = focus["status"].as_str().unwrap_or("unavailable").to_string();
        let mut statuses = serde_json::Map::new();
        let mut unavailable = Vec::new();
        for category in &categories {
            let name = category.as_str().unwrap_or_default();
            let state = match name {
                "documentation" => "unavailable",
                "implementations" if !associated => "unavailable",
                _ if target_status != "ok" && target_status != "connected" => "unavailable",
                _ => "bounded candidates; completeness and binding are not guaranteed",
            };
            statuses.insert(name.to_string(), json!(state));
            if state == "unavailable" { unavailable.push(name.to_string()); }
        }
        focus["prepared"] = json!(if associated { "captured source-associated evidence" } else { "unavailable; live candidates only" });
        focus["evidenceStatus"] = Value::Object(statuses);
        let original_query = args.get("query").and_then(Value::as_str).unwrap_or(query);
        if targeted {
            let _ = writeln!(text, "Question: {original_query}\nFocus: {} — {}", focus["target"].as_str().unwrap_or_default(), target_status);
        } else {
            let _ = writeln!(text, "Question: {original_query}\nFocus: connected candidates — {target_status}");
        }
        if !categories.is_empty() {
            let emphasis = categories.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ");
            let _ = writeln!(text, "Evidence emphasis: {emphasis}; {}", if targeted {
                "target source and relationship uncertainty retained."
            } else { "ordinary connected candidates retained; no exact owner was selected." });
            for name in &unavailable {
                let reason = if name == "documentation" {
                    "no authored reference owner is integrated; lexical similarity is not a document binding"
                } else { "no unique source target or admitted prepared facet; no relationship was inferred" };
                let _ = writeln!(text, "Requested {name} evidence unavailable: {reason}.");
            }
            if !unavailable.is_empty() {
                fuzzy.complete = false;
                for name in &unavailable { fuzzy.diagnostics.push(format!("focused {name} evidence unavailable")); }
            }
        }
    }
    if !text.is_empty() {
        text.push('\n');
    }
    let resolved = if route_label == "behavior discovery" {
        "auto→fuzzy"
    } else {
        "auto→symbol→fuzzy"
    };
    let ranking = if focus_targeted(fuzzy.focus.as_ref()) { "exact source focus; original question retained" }
        else if semantic_metadata.as_ref().is_some_and(|semantic| semantic["returned"].as_u64().is_some_and(|count| count > 0)) {
            "reciprocal-rank fusion of lexical evidence and scoped code vectors; nearest-name fallbacks receive no lexical vote; similarity is not ownership proof"
        } else { "BM25F over declarations, enclosed source and Markdown; lexical relevance, not semantic ownership" };
    if focus_targeted(fuzzy.focus.as_ref()) {
        let _ = writeln!(text, "Resolved: ranked source focus · original kind={}\nQuestion terms: {term_status}\nSelected by exact path and source qualification, not lexical rank or nearest binding.", args.get("kind").and_then(Value::as_str).unwrap_or("auto"));
    } else {
        let _ = writeln!(
            text,
            "Resolved: {resolved}\nRoute: {route_label} · normalized={}\nTerms: {term_status}\nOrdered by: {ranking}",
            fuzzy.normalized_terms.join("|")
        );
    }
    if let Some(semantic) = &semantic_metadata {
        let _ = writeln!(text, "Semantic discovery: {}. {}", semantic["status"].as_str().unwrap_or("unavailable"),
            semantic["reason"].as_str().unwrap_or("Scoped graph candidates only; similarity is not a textual hit or ownership proof."));
        if semantic.get("examined").is_some() {
            let _ = writeln!(text, "Semantic scope coverage: examined={}, returned={}, unrepresented={}, missing={}, invalid={}, unassociated={}, capped={}. Counts describe captured graph declarations, not every live declaration; the capped tail is unknown and not retained.",
                semantic["examined"], semantic["returned"], semantic["unrepresented"], semantic["missingFeatures"], semantic["invalidFeatures"], semantic["unassociated"], semantic["capped"]);
        }
    }
    if !focus_targeted(fuzzy.focus.as_ref()) && fuzzy.nearest_fallback {
        text.push_str("Lexical fallback: no lexical-scored declarations; nearest-name candidates retained without a lexical fusion vote.\n");
    } else if fuzzy.result.matches.is_empty() && !focus_targeted(fuzzy.focus.as_ref()) {
        text.push_str("0 results in scope; no nearest real symbol within distance 2\n");
    }
    text.push('\n');
    text.push_str(&rendered.text);
    let extraction_notice = prepared_metadata.as_ref()
        .and_then(|metadata| metadata["extractionDiagnostics"].as_array())
        .filter(|diagnostics| !diagnostics.is_empty())
        .map(|diagnostics| if prepared_metadata.as_ref().is_some_and(|metadata| metadata["indexedRunId"].is_string()) {
            format!("Indexed extraction diagnostics affect {} selected files; free text and positions are withheld. Relationship coverage may be partial.", diagnostics.len())
        } else {
            format!("Prepared connection coverage is partial: {} reference sites have no unique source-owner representation in the captured graph. Their exact positions remain in extraction diagnostics; no outer caller was substituted.", diagnostics.len())
        });
    if let Some(metadata) = &prepared_metadata {
        if let Some(run) = metadata["indexedRunId"].as_str() {
            let _ = write!(text, "\nPrepared indexed run {run}: best-effort relationships; selected source independently verified; not current relationship or absence proof.");
        } else {
            let _ = write!(text, "\nPrepared capture: generation {}, {} captured files; source-associated evidence, not whole-project or runtime-dispatch proof.", metadata["generation"], metadata["capturedFiles"]);
        }
    }
    if let Some(notice) = &extraction_notice {
        let _ = write!(text, "\n{notice}");
        fuzzy.complete = false;
        fuzzy.diagnostics.push(notice.clone());
    }
    *receipt = rendered.receipt.clone();
    if (!fuzzy.result.matches.is_empty() || args["captureRanked"] == true) && expand > 0 {
        *retained = Some(Collection::Fuzzy { search: fuzzy.clone(), route: route_label, lanes: lanes.clone() });
    }
    let mut data = json!({
        "mode": "ranked", "query": args.get("query").and_then(Value::as_str).unwrap_or(query), "scope": scope,
        "visibility": args.get("visibility").and_then(Value::as_str).unwrap_or("project"),
        "focus": fuzzy.focus,
        "kind": "fuzzy",
        "case": case_mode,
        "matches": matches,
        "locations": locations,
        "sourceRows": source_rows,
        "totalFound": fuzzy.result.total_found,
        "definitions": fuzzy.result.definitions,
        "usages": fuzzy.result.usages,
        "fuzzy": {
            "normalizedTerms": fuzzy.normalized_terms,
            "termCounts": fuzzy.term_counts,
            "termFallbacks": fuzzy.term_fallbacks,
            "nearestFallback": fuzzy.nearest_fallback,
            "ranking": ranking,
            "semanticTier": semantic_metadata,
        },
    });
    if let Some(metadata) = prepared_metadata {
        data["analysis"] = metadata;
    }
    let mut output = if fuzzy.complete {
        ToolOutput::bounded(
            "pi_nav_search",
            text,
            data,
            returned,
            fuzzy.result.total_found,
            budget,
        )
    } else {
        ToolOutput::incomplete(
            "pi_nav_search",
            text,
            data,
            returned,
            if fuzzy
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.contains("candidate cap"))
            {
                IncompleteReason::CandidateCap
            } else if operation_context
                .cancelled
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                IncompleteReason::Cancelled
            } else if operation_context.check().is_err() {
                IncompleteReason::Deadline
            } else {
                IncompleteReason::Error
            },
            fuzzy.diagnostics,
        )
    };
    if rendered.omitted_relationship_evidence > 0 {
        output.structured["completeness"]["complete"] = json!(false);
        output.structured["completeness"]["reason"] = json!(IncompleteReason::Budget);
        output.structured["diagnostics"]
            .as_array_mut()
            .expect("diagnostics array")
            .push(json!(format!(
                "{} relationship evidence groups or annotations omitted during rendering",
                rendered.omitted_relationship_evidence
            )));
    }
    if args["retainRankedRender"] == true {
        output.ranked_render_frame = crate::search::continuation::RenderFrame::capture(&output.text, &rendered.text, false);
    }
    Ok(output.with_source_snapshots(rendered.source_snapshots))
}

#[allow(clippy::too_many_arguments)]
fn callers_output(
    query: &str,
    case_mode: &str,
    sensitive: bool,
    scope: &Path,
    root: Option<&Path>,
    globs: &[String],
    visibility: crate::walk::Visibility,
    expand: usize,
    context: Option<&Path>,
    session: &Session,
    bloom: &Arc<BloomFilterCache>,
    budget: u64,
    operation_context: &crate::dispatch::OperationContext,
) -> Result<ToolOutput, String> {
    let mut seen = HashSet::new();
    let ordered: Vec<String> = query
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty() && seen.insert((*value).to_string()))
        .map(str::to_string)
        .collect();
    if ordered.is_empty() {
        return Err("missing required parameter: query".into());
    }
    if ordered.len() > 5 {
        return Err(format!(
            "multi-target callers search limited to 5 queries (got {})",
            ordered.len()
        ));
    }
    let mut targets = HashSet::new();
    let mut requested_for_variant = HashMap::new();
    let sources = Arc::new(crate::search::OperationSources::default());
    for requested in &ordered {
        session.record_search(requested);
        let variants = if sensitive {
            vec![requested.clone()]
        } else {
            let discovered = discover_variants(requested, scope, operation_context, &sources)?;
            if discovered.is_empty() {
                vec![requested.clone()]
            } else {
                discovered
            }
        };
        for variant in variants {
            requested_for_variant.insert(variant.clone(), requested.clone());
            targets.insert(variant);
        }
    }
    let options = crate::walk::WalkOptions {
        visibility,
        policy_root: None,
        min_depth: 1,
        max_depth: None,
        patterns: globs.to_vec(),
        deadline: operation_context.deadline,
        cancelled: Some(operation_context.cancelled.clone()),
        candidate_cap: None,
    };
    let batch_quit = crate::search::callers::BATCH_EARLY_QUIT.saturating_mul(targets.len().max(1));
    let batch = crate::search::callers::find_callers_batch_with_options(
        &targets, scope, bloom, &options, batch_quit,
    )
    .map_err(|error| error.to_string())?;
    // Alias-aware current callers: import aliases, chained named re-exports,
    // and tsconfig `baseUrl`/`paths` carriers. Binding fires only for a
    // project-wide unfiltered scope — with a glob or non-project visibility an
    // alias carrier outside the requested filter would surface as if it had
    // passed — and only when the exact query resolves to exactly one current
    // implementation owner; two real owners stay lexical-only.
    let mut alias_rows: Vec<(String, crate::search::callers::CallerMatch)> = Vec::new();
    if globs.is_empty() && visibility == crate::walk::Visibility::Project {
        for requested in &ordered {
            let Some((def_path, def_name)) =
                crate::search::symbol::single_definition_owner(requested, scope)
                    .map_err(|error| error.to_string())?
            else {
                continue;
            };
            for (_, ac) in crate::search::bindings::find_alias_callers_batch(
                &def_path,
                std::slice::from_ref(&def_name),
                scope,
            ) {
                alias_rows.push((
                    requested.clone(),
                    crate::search::callers::CallerMatch::from(ac),
                ));
            }
        }
    }
    let merged = crate::search::callers::merge_caller_rows(batch.matches, alias_rows);
    let raw_total = merged.len();
    let remapped = merged
        .into_iter()
        .map(|(variant, caller)| {
            (
                requested_for_variant
                    .get(&variant)
                    .cloned()
                    .unwrap_or(variant),
                caller,
            )
        })
        .collect();
    let rendered = crate::search::callers::render_callers_batch(
        &ordered,
        remapped,
        scope,
        bloom,
        expand,
        context,
        None,
        Some(&options),
        10,
        batch_quit,
    );
    let text = apply_budget(&rendered.text, Some(budget));
    let mut matches = Vec::new();
    let mut locations = Vec::new();
    let source_rows: Vec<SourceRow> = Vec::new();
    for (symbol, caller) in rendered.displayed {
        matches.push(OutputSearchMatch {
            location: location(&caller.path, caller.line, caller.line, root, Some("caller")),
            role: "caller",
            symbol: Some(symbol),
            source_identity: None,
            exact: sensitive,
        });
        locations.push(location(
            &caller.path,
            caller.line,
            caller.line,
            root,
            Some("caller"),
        ));
    }
    let returned = matches.len();
    let data = json!({ "kind": "callers", "case": case_mode, "matches": matches, "locations": locations, "sourceRows": source_rows });
    if batch.complete {
        Ok(ToolOutput::bounded(
            "pi_nav_search",
            text,
            data,
            returned,
            raw_total,
            budget,
        ))
    } else {
        let reason = match batch.reason {
            Some(crate::walk::StopReason::Deadline) => IncompleteReason::Deadline,
            Some(crate::walk::StopReason::Cancelled) => IncompleteReason::Cancelled,
            Some(crate::walk::StopReason::CandidateCap) => IncompleteReason::CandidateCap,
            _ => IncompleteReason::Error,
        };
        Ok(ToolOutput::incomplete(
            "pi_nav_search",
            text,
            data,
            returned,
            reason,
            batch.diagnostics,
        ))
    }
}

fn resolve_kind<'a>(requested: &'a str, query: &'a str) -> Result<(&'a str, &'a str), String> {
    if requested == "auto" {
        if query.starts_with('/') && query.ends_with('/') && query.len() > 2 {
            return Ok(("regex", &query[1..query.len() - 1]));
        }
        let identifier = |term: &str| {
            term.chars()
                .next()
                .is_some_and(|value| value == '_' || value.is_alphabetic())
                && term
                    .chars()
                    .all(|value| value == '_' || value.is_alphanumeric())
        };
        let pipe_terms: Vec<_> = query.split('|').collect();
        if pipe_terms.len() > 1
            && pipe_terms
                .iter()
                .all(|term| !term.is_empty() && identifier(term))
        {
            return Ok(("fuzzy", query));
        }
        if strong_regex_intent(query) {
            grep_regex::RegexMatcher::new(query)
                .map_err(|error| format!("invalid regex {query:?}: {error}"))?;
            return Ok(("regex", query));
        }
        if identifier(query) {
            return if matches!(
                crate::classify::classify(query, Path::new("")),
                crate::types::QueryType::Symbol(_)
            ) {
                Ok(("symbol", query))
            } else {
                Ok(("fuzzy", query))
            };
        }
        if query.split_whitespace().count() > 1 && query.split_whitespace().all(identifier) {
            return Ok(("fuzzy", query));
        }
        return Ok(("content", query));
    }
    matches!(requested, "symbol" | "content" | "regex" | "callers")
        .then_some((requested, query))
        .ok_or_else(|| {
            format!("unknown search kind: {requested}. Use: auto, symbol, content, regex, callers")
        })
}

fn strong_regex_intent(pattern: &str) -> bool {
    let mut escaped = false;
    let mut class_depth = 0usize;
    let mut strong = pattern.starts_with('^')
        || pattern.ends_with('$')
        || pattern.contains(".*")
        || pattern.contains(".+");
    for character in pattern.chars() {
        if escaped {
            strong = true;
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '[' => {
                class_depth += 1;
                strong = true;
            }
            ']' => class_depth = class_depth.saturating_sub(1),
            '(' => strong = true,
            '|' if class_depth == 0 => strong = true,
            '*' | '+' | '?' if class_depth == 0 => strong = true,
            _ => {}
        }
    }
    strong
}
fn parse_globs(value: Option<&Value>) -> Result<Vec<String>, String> {
    let values = match value {
        None => Vec::new(),
        Some(Value::String(value)) => vec![value.clone()],
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or("glob must contain strings")
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("glob must be a string or array of strings".into()),
    };
    if values.len() > 20 {
        return Err(format!(
            "glob limited to 20 patterns (got {})",
            values.len()
        ));
    }
    if values
        .iter()
        .any(|pattern| pattern.is_empty() || pattern == "!")
    {
        return Err("glob patterns and exclusions must not be empty".into());
    }
    for pattern in &values {
        globset::Glob::new(pattern.strip_prefix('!').unwrap_or(pattern))
            .map_err(|error| format!("invalid glob {pattern:?}: {error}"))?;
    }
    Ok(values)
}

#[allow(clippy::too_many_arguments)]
fn gather_search(
    kind: &str,
    query: &str,
    scope: &Path,
    context: Option<&Path>,
    globs: &[String],
    visibility: crate::walk::Visibility,
    sensitive: bool,
    operation_context: &crate::dispatch::OperationContext,
    sources: Arc<crate::search::OperationSources>,
) -> Result<(SearchResult, bool), String> {
    let scopes: Vec<PathBuf> = if scope.is_file() || visibility == crate::walk::Visibility::Project
    {
        vec![scope.to_path_buf()]
    } else {
        crate::walk::walk(
            scope,
            &crate::walk::WalkOptions {
                visibility,
                policy_root: None,
                min_depth: 0,
                max_depth: None,
                patterns: Vec::new(),
                deadline: operation_context.deadline,
                cancelled: Some(operation_context.cancelled.clone()),
                candidate_cap: None,
            },
        )?
        .entries
        .into_iter()
        .filter(|entry| {
            entry.kind == crate::walk::EntryKind::File && glob_allows(&entry.path, globs)
        })
        .map(|entry| scope.join(entry.path))
        .collect()
    };
    let include_globs: Vec<Option<&str>> = if visibility == crate::walk::Visibility::Project {
        let values: Vec<_> = globs
            .iter()
            .filter(|value| !value.starts_with('!'))
            .map(String::as_str)
            .map(Some)
            .collect();
        if values.is_empty() {
            vec![None]
        } else {
            values
        }
    } else {
        vec![None]
    };
    let filtered_mode = visibility != crate::walk::Visibility::Project
        || !sensitive
        || globs.len() > 1
        || globs.iter().any(|value| value.starts_with('!'));
    let mut results = Vec::new();
    for candidate_scope in scopes {
        operation_context
            .check()
            .map_err(|error| error.to_string())?;
        for glob in &include_globs {
            if kind == "symbol" && !sensitive {
                let variants =
                    discover_variants(query, &candidate_scope, operation_context, &sources)?;
                for variant in if variants.is_empty() {
                    vec![query.to_string()]
                } else {
                    variants
                } {
                    results.push(
                        crate::search::symbol::search_with_sources(
                            &variant,
                            &candidate_scope,
                            context,
                            *glob,
                            filtered_mode,
                            sources.clone(),
                            Some(operation_context),
                        )
                        .map_err(|error| error.to_string())?,
                    );
                }
                continue;
            }
            let result = match kind {
                "symbol" => crate::search::symbol::search_with_sources(
                    query,
                    &candidate_scope,
                    context,
                    *glob,
                    filtered_mode,
                    sources.clone(),
                    Some(operation_context),
                ),
                "content" => {
                    let pattern = if sensitive {
                        regex_syntax::escape(query)
                    } else {
                        format!("(?i:{})", regex_syntax::escape(query))
                    };
                    crate::search::content::search_with_sources(
                        &pattern,
                        &candidate_scope,
                        true,
                        context,
                        *glob,
                        filtered_mode,
                        sources.clone(),
                        Some(operation_context),
                    )
                }
                "regex" => {
                    let pattern = if sensitive {
                        query.to_string()
                    } else {
                        format!("(?i:{query})")
                    };
                    crate::search::content::search_with_sources(
                        &pattern,
                        &candidate_scope,
                        true,
                        context,
                        *glob,
                        filtered_mode,
                        sources.clone(),
                        Some(operation_context),
                    )
                }
                _ => unreachable!("validated search kind"),
            }
            .map_err(|error| error.to_string())?;
            results.push(result);
        }
    }
    let candidate_cap = if filtered_mode { 300 } else { 30 };
    let candidate_capped = results
        .iter()
        .any(|result| result.total_found >= candidate_cap);
    Ok((
        merge_results(
            results,
            query,
            scope,
            context,
            globs,
            filtered_mode,
            sources,
        ),
        candidate_capped,
    ))
}

fn merge_results(
    results: Vec<SearchResult>,
    query: &str,
    scope: &Path,
    context: Option<&Path>,
    globs: &[String],
    filtered_mode: bool,
    sources: Arc<crate::search::OperationSources>,
) -> SearchResult {
    let mut matches = Vec::new();
    let mut total_found = 0usize;
    let mut definitions = 0usize;
    let mut usages = 0usize;
    let mut facets = FacetTotals::default();
    for result in results {
        total_found = total_found.saturating_add(result.total_found);
        definitions = definitions.saturating_add(result.definitions);
        usages = usages.saturating_add(result.usages);
        facets.definitions += result.facet_totals.definitions;
        facets.implementations += result.facet_totals.implementations;
        facets.tests += result.facet_totals.tests;
        facets.usages_local += result.facet_totals.usages_local;
        facets.usages_cross += result.facet_totals.usages_cross;
        matches.extend(result.matches.into_iter().filter(|item| {
            glob_allows(item.path.strip_prefix(scope).unwrap_or(&item.path), globs)
        }));
    }
    matches.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.line.cmp(&right.line))
            .then(left.is_definition.cmp(&right.is_definition))
            .then_with(|| {
                left.declaration
                    .as_ref()
                    .map(|d| d.key())
                    .cmp(&right.declaration.as_ref().map(|d| d.key()))
            })
    });
    matches.dedup_by(|left, right| {
        left.path == right.path
            && left.line == right.line
            && left.is_definition == right.is_definition
            && left.def_name == right.def_name
            && left.declaration.as_ref().map(|d| d.key())
                == right.declaration.as_ref().map(|d| d.key())
    });
    if filtered_mode {
        total_found = matches.len();
        definitions = matches.iter().filter(|item| item.is_definition).count();
        usages = total_found.saturating_sub(definitions);
        // Filtering/case folding changes the candidate set, not whether its
        // declarations deserve the same ranked card as case-sensitive lookup.
        let grouped = crate::search::facets::facet_matches(matches.clone(), scope);
        facets = FacetTotals {
            definitions: grouped.definitions.len(),
            implementations: grouped.implementations.len(),
            tests: grouped.tests.len(),
            usages_local: grouped.usages_local.len(),
            usages_cross: grouped.usages_cross.len(),
        };
    }
    crate::search::rank::sort(&mut matches, query, scope, context);
    matches.truncate(10);
    SearchResult {
        query: query.to_string(),
        scope: scope.to_path_buf(),
        matches,
        sources,
        total_found,
        definitions,
        usages,
        facet_totals: facets,
    }
}

fn discover_variants(
    query: &str,
    scope: &Path,
    context: &crate::dispatch::OperationContext,
    sources: &Arc<crate::search::OperationSources>,
) -> Result<Vec<String>, String> {
    let walked = sources.scoped_files(
        scope,
        &crate::walk::WalkOptions {
            visibility: crate::walk::Visibility::Project,
            policy_root: None,
            min_depth: 0,
            max_depth: None,
            patterns: Vec::new(),
            deadline: context.deadline,
            cancelled: Some(context.cancelled.clone()),
            candidate_cap: None,
        },
    )?;
    let folded_query: String = query.chars().flat_map(char::to_lowercase).collect();
    let mut variants = HashSet::new();
    for path in walked.paths {
        context.check().map_err(|error| error.to_string())?;
        let Ok(content) = sources.read_text(&path) else {
            continue;
        };
        for token in content.split(|value: char| !(value == '_' || value.is_alphanumeric())) {
            let folded: String = token.chars().flat_map(char::to_lowercase).collect();
            if folded == folded_query {
                variants.insert(token.to_string());
            }
        }
        if variants.len() >= 20 {
            break;
        }
    }
    let mut values: Vec<_> = variants.into_iter().collect();
    values.sort();
    Ok(values)
}

fn search_metadata(
    result: &SearchResult,
    root: Option<&Path>,
    kind: &str,
    rendered_rows: &[crate::search::RenderedSourceRow],
) -> (Vec<OutputSearchMatch>, Vec<Location>, Vec<SourceRow>) {
    let mut matches = Vec::new();
    let mut locations = Vec::new();
    let rich = if kind == "fuzzy" { crate::search::fuzzy::rich_targets(result) } else { Vec::new() };
    for (index, item) in result.matches.iter().enumerate() {
        // Bound locators, not source collection or rich target selection. Keep
        // promoted parents beyond this window and all existing usage carriers.
        if kind == "fuzzy" && item.is_definition && index >= crate::search::fuzzy::COMPACT_CANDIDATE_LIMIT
            && !rich.iter().any(|target| std::ptr::eq(*target, item)) { continue; }
        let start = item.def_range.map_or(item.line, |range| range.0);
        let end = item.def_range.map_or(item.line, |range| range.1);
        let role = if matches!(kind, "content" | "regex") {
            "content"
        } else if item.is_definition {
            "definition"
        } else {
            "usage"
        };
        matches.push(OutputSearchMatch {
            location: location(&item.path, start, end, root, Some(role)),
            role,
            symbol: item.def_name.clone(),
            exact: item.exact,
            source_identity: item.declaration.as_ref().map(|declaration| {
                let (start_byte, end_byte, syntax_kind) = declaration.key();
                crate::output::SourceIdentity {
                    start_byte,
                    end_byte,
                    syntax_kind: syntax_kind.to_string(),
                }
            }),
        });
        locations.push(location(&item.path, start, end, root, Some(role)));
    }
    let rows = rendered_rows
        .iter()
        .map(|row| SourceRow {
            path: relative(&row.path, root),
            line: row.line,
            text: row.text.clone(),
            visibility: "visible_complete",
            transformation: "verbatim",
        })
        .collect();
    (matches, locations, rows)
}

fn glob_allows(path: &Path, globs: &[String]) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let includes: Vec<_> = globs
        .iter()
        .filter(|value| !value.starts_with('!'))
        .collect();
    let include =
        includes.is_empty() || includes.iter().any(|value| glob_match(value, &normalized));
    include
        && !globs
            .iter()
            .filter_map(|value| value.strip_prefix('!'))
            .any(|value| glob_match(value, &normalized))
}

fn glob_match(pattern: &str, path: &str) -> bool {
    let Ok(glob) = globset::Glob::new(pattern) else {
        return false;
    };
    let matcher = glob.compile_matcher();
    if pattern.contains('/') {
        matcher.is_match(path)
    } else {
        path.rsplit('/')
            .next()
            .is_some_and(|name| matcher.is_match(name))
    }
}

fn location(
    path: &Path,
    start: u32,
    end: u32,
    root: Option<&Path>,
    role: Option<&str>,
) -> Location {
    Location {
        path: relative(path, root),
        start,
        end,
        label: None,
        role: role.map(str::to_string),
    }
}

fn relative(path: &Path, root: Option<&Path>) -> String {
    let canonical_root = root.and_then(|root| root.canonicalize().ok());
    let canonical_path = path.canonicalize().ok();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::OutlineCache;
    use crate::index::bloom::BloomFilterCache;
    use crate::session::Session;

    #[test]
    fn matches_render_dispatch_rejects_mixed_and_invalid_private_requests() {
        let directory = tempfile::tempdir().unwrap();
        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = Arc::new(BloomFilterCache::new());
        let cases = [
            (json!({"output":"matches", "retainMatchesRender":"true"}), "must be a boolean"),
            (json!({"output":"matches", "matchesRenderBytes":1000}), "requires renderMatches"),
            (json!({"output":"matches", "retainMatchesRender":true, "matchesRenderBytes":16000}), "requires renderMatches"),
            (json!({"cursor":"grep-public", "retainMatchesRender":true, "matchesRenderBytes":16000}), "requires renderMatches"),
            (json!({"retainMatchesRender":true, "query":"Wanted"}), "requires output matches"),
            (json!({"retainMatchesRender":true, "cursor":"grep-ranked-private"}), "cannot resume a ranked cursor"),
            (json!({"renderMatches":""}), "original-progress handle"),
            (json!({"renderMatches":12}), "original-progress handle"),
            (json!({"renderMatches":"origin", "cursor":"public"}), "accepts only"),
            (json!({"renderMatches":"origin", "contextLines":0}), "accepts only"),
            (json!({"renderMatches":"origin", "pattern":"rescan"}), "accepts only"),
            (json!({"renderMatches":"origin", "analysisProjection":{}}), "cannot carry ranked"),
            (json!({"renderMatches":"origin", "corpusAdmission":{}}), "cannot carry ranked"),
            (json!({"renderMatches":"origin", "retainRankedRender":true}), "cannot carry ranked"),
            (json!({"renderMatches":"origin", "matchesRenderBytes":0}), "integer from 1 through 16000"),
            (json!({"renderMatches":"origin", "matchesRenderBytes":16001}), "integer from 1 through 16000"),
            (json!({"renderMatches":"origin", "matchesRenderBytes":1.5}), "integer from 1 through 16000"),
        ];
        for (mut args, expected) in cases {
            args["root"] = json!(directory.path());
            let error = tool_search(&args, &cache, &session, &bloom).unwrap_err();
            assert!(error.contains(expected), "{args}: {error}");
        }
    }

    #[test]
    fn matches_render_dispatch_preserves_initial_audit_route() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("one.txt"), "needle\n").unwrap();
        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = Arc::new(BloomFilterCache::new());
        let output = tool_search(&json!({"root":directory.path(), "output":"matches",
            "pattern":"needle", "paths":["one.txt"], "retainMatchesRender":true}),
            &cache, &session, &bloom).unwrap();
        assert!(output.contains("needle"));
        assert!(!output.contains("matchesRenderCursor"));
    }

    #[test]
    fn semantic_composition_requires_same_identity_variant_run_status_policy_and_corpus() {
        let indexed = json!({"indexedRunId":"11111111-1111-4111-8111-111111111111",
            "indexedStatusDigest":"status", "policyDigest":"policy", "corpusDigest":"corpus",
            "interpretationRevision":"codeweave-pi.maintenance.1", "status":"partial"});
        let mut prepared = indexed.clone();
        prepared["semanticStatus"] = json!("unavailable");
        merge_semantic_metadata(&mut prepared, &indexed).unwrap();
        assert_eq!(prepared["semantic"], indexed);
        assert_eq!(prepared["semanticStatus"], "partial");
        for key in ["indexedRunId", "indexedStatusDigest", "policyDigest", "corpusDigest", "interpretationRevision"] {
            let mut changed = indexed.clone(); changed[key] = json!("changed");
            assert!(merge_semantic_metadata(&mut changed, &indexed).is_err(), "{key}");
            let mut absent = indexed.clone(); absent.as_object_mut().unwrap().remove(key);
            assert!(merge_semantic_metadata(&mut absent, &indexed).is_err(), "missing {key}");
        }
        let g1 = json!({"generation":1,"captureDigest":"capture","policyDigest":"policy","interpretationRevision":"g1"});
        assert!(merge_semantic_metadata(&mut indexed.clone(), &g1).is_err());
        assert!(merge_semantic_metadata(&mut g1.clone(), &indexed).is_err());
        let mut same = g1.clone();
        merge_semantic_metadata(&mut same, &g1).unwrap();
        assert_eq!(same["semantic"], g1);
        let mut changed = g1.clone(); changed["policyDigest"] = json!("changed");
        assert!(merge_semantic_metadata(&mut changed, &g1).is_err());
    }

    /// Regression: `kind=callers` with a comma query must search each target
    /// separately, not for a literal symbol named "alpha,beta". Before the
    /// comma-split arm this returned an empty no-callers message.
    #[test]
    fn callers_comma_query_finds_both_targets() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("lib.rs"),
            "fn alpha() {}\n\
             fn beta() {}\n\
             fn uses_alpha() { alpha(); }\n\
             fn uses_beta() { beta(); }\n",
        )
        .unwrap();

        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = std::sync::Arc::new(BloomFilterCache::new());
        let args = serde_json::json!({
            "query": "alpha,beta",
            "kind": "callers",
            "scope": tmp.path().to_str().unwrap(),
        });

        let out = tool_search(&args, &cache, &session, &bloom).unwrap();

        // Both targets must be reported with a real call site, not a single
        // literal "alpha,beta" lookup that finds nothing. Header uses the
        // unified single-target shape: `# Callers of "<target>" in <scope>`.
        assert!(
            out.contains("Callers of \"alpha\""),
            "missing alpha section: {out}"
        );
        assert!(
            out.contains("Callers of \"beta\""),
            "missing beta section: {out}"
        );
        assert!(
            out.contains("uses_alpha"),
            "alpha call site not found: {out}"
        );
        assert!(out.contains("uses_beta"), "beta call site not found: {out}");
        // The literal combined string must never be searched as one symbol.
        assert!(
            !out.contains("\"alpha,beta\""),
            "comma query was treated as a literal symbol: {out}"
        );
    }

    /// Regression for the duplicate-target render bug: query "alpha,alpha"
    /// must still report alpha's call site once, not render an empty
    /// no-callers section on the second occurrence after the first consumed
    /// the matched bucket.
    #[test]
    fn callers_duplicate_target_does_not_render_empty_section() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("lib.rs"),
            "fn alpha() {}\n\
             fn uses_alpha() { alpha(); }\n",
        )
        .unwrap();

        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = std::sync::Arc::new(BloomFilterCache::new());
        let args = serde_json::json!({
            "query": "alpha,alpha",
            "kind": "callers",
            "scope": tmp.path().to_str().unwrap(),
        });

        let out = tool_search(&args, &cache, &session, &bloom).unwrap();

        assert!(
            out.contains("uses_alpha"),
            "alpha call site not found: {out}"
        );
        // The duplicate must collapse to a single section: no no-callers
        // message should appear — that is what the second occurrence rendered
        // before the dedupe consumed the bucket on the first pass.
        assert!(
            !out.contains("no call sites") && !out.contains("no direct call sites"),
            "duplicate target rendered a false no-callers section: {out}"
        );
    }

    /// Multi-target search must retain the same bounded second-hop candidate
    /// evidence as the single-target path, without claiming proven change impact.
    /// `alpha` is called by exactly `IMPACT_FANOUT_THRESHOLD`-or-fewer unique
    /// functions (one: `uses_alpha`), which are themselves called by
    /// `hop2_alpha` — so the 2-target search "alpha,beta" must show a 2nd-hop
    /// section for the alpha bucket, same as a lone `callers("alpha")` would.
    #[test]
    fn callers_multi_target_includes_second_hop_impact_per_bucket() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("lib.rs"),
            "fn alpha() {}\n\
             fn beta() {}\n\
             fn uses_alpha() { alpha(); }\n\
             fn hop2_alpha() { uses_alpha(); }\n\
             fn uses_beta() { beta(); }\n",
        )
        .unwrap();

        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = std::sync::Arc::new(BloomFilterCache::new());

        // Single-target baseline: what callers("alpha") alone produces.
        let single_args = serde_json::json!({
            "query": "alpha",
            "kind": "callers",
            "scope": tmp.path().to_str().unwrap(),
        });
        let single_out = tool_search(&single_args, &cache, &session, &bloom).unwrap();
        assert!(
            single_out.contains("caller candidates (2nd hop; name-only)"),
            "single-target baseline should show second-hop candidates: {single_out}"
        );
        assert!(single_out.contains("hop2_alpha"));

        // Multi-target: "alpha,beta" must not omit what a lone "alpha" search
        // would show for the alpha bucket.
        let multi_args = serde_json::json!({
            "query": "alpha,beta",
            "kind": "callers",
            "scope": tmp.path().to_str().unwrap(),
        });
        let multi_out = tool_search(&multi_args, &cache, &session, &bloom).unwrap();
        assert!(
            multi_out.contains("caller candidates (2nd hop; name-only)"),
            "multi-target alpha bucket dropped the second-hop candidates: {multi_out}"
        );
        assert!(
            multi_out.contains("hop2_alpha"),
            "multi-target alpha bucket missing the hop-2 caller: {multi_out}"
        );
    }

    /// MED finding from PR review: single- and multi-target output must use
    /// the same header shape for the same target — the review found multi
    /// diverging into a `## callers of "foo"` / `### path:line` style while
    /// single used `# Callers of "foo" in <scope> — N call site(s)` /
    /// `## path:line`. A caller diffing single vs. one bucket of multi should
    /// see the identical shape (same target, same scope, same one hit).
    #[test]
    fn callers_multi_target_header_matches_single_target_shape() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("lib.rs"),
            "fn alpha() {}\n\
             fn beta() {}\n\
             fn uses_alpha() { alpha(); }\n\
             fn uses_beta() { beta(); }\n",
        )
        .unwrap();

        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = std::sync::Arc::new(BloomFilterCache::new());

        let single_args = serde_json::json!({
            "query": "alpha",
            "kind": "callers",
            "scope": tmp.path().to_str().unwrap(),
        });
        let single_out = tool_search(&single_args, &cache, &session, &bloom).unwrap();

        let multi_args = serde_json::json!({
            "query": "alpha,beta",
            "kind": "callers",
            "scope": tmp.path().to_str().unwrap(),
        });
        let multi_out = tool_search(&multi_args, &cache, &session, &bloom).unwrap();

        // Top-level bucket header: same "# Callers of ... — N call site(s)" shape.
        assert!(
            single_out.contains("# Callers of \"alpha\""),
            "single-target header shape missing: {single_out}"
        );
        assert!(
            multi_out.contains("# Callers of \"alpha\""),
            "multi-target alpha bucket must render the single-target header shape, \
             not a divergent '## callers of' shape: {multi_out}"
        );
        assert!(
            single_out.contains("1 call site"),
            "single-target count phrase missing: {single_out}"
        );
        assert!(
            multi_out.contains("1 call site"),
            "multi-target alpha bucket must render the same count phrase: {multi_out}"
        );

        // Call-site sub-header: same "## path:line [caller: name]" shape,
        // not multi's divergent "### path:line [caller: name]".
        assert!(
            single_out.contains("[caller: uses_alpha]"),
            "single-target caller label missing: {single_out}"
        );
        assert!(
            multi_out.contains("[caller: uses_alpha]"),
            "multi-target alpha bucket must render the same caller label: {multi_out}"
        );
        assert!(
            !multi_out.contains("### lib.rs"),
            "multi-target must use single-target's '##' sub-header level, not '###': {multi_out}"
        );
    }

    /// MED finding from PR review: `BATCH_EARLY_QUIT` (50 raw matches) is a
    /// walk-wide budget shared by every target in a batch search. The walker
    /// (`find_callers_batch`) checks this budget once per **file** visited
    /// (an `AtomicUsize` compared before each file read — see
    /// `src/search/callers.rs`'s `found_count.load(..) >= early_quit_threshold`
    /// gate), so it only starves later files, not later matches within one
    /// already-open file. To reproduce real starvation this test spreads 60
    /// `alpha` call sites across 60 separate files (one call site per file:
    /// `a_00.rs`..`a_59.rs`) — comfortably above the un-scaled 50-match
    /// walk-wide budget — and puts `beta`'s lone call site in a file that
    /// sorts after all of them (`z_beta.rs`). With an unscaled budget the
    /// walk can quit after visiting ~50 of the `a_*.rs` files, before
    /// `z_beta.rs` is ever read, starving beta entirely. Scaling the budget
    /// by target count (2x for 2 targets = 100) gives the walk enough
    /// headroom to reach `z_beta.rs`.
    #[test]
    fn callers_multi_target_later_target_not_starved_by_hit_rich_earlier_target() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("defs.rs"), "fn alpha() {}\nfn beta() {}\n").unwrap();
        for i in 0..60 {
            std::fs::write(
                tmp.path().join(format!("a_{i:02}.rs")),
                format!("fn uses_alpha_{i}() {{ alpha(); }}\n"),
            )
            .unwrap();
        }
        // Sorts after every "a_*.rs" file — only reached if the walk's
        // early-quit budget has enough headroom to visit all 61 prior files.
        std::fs::write(tmp.path().join("z_beta.rs"), "fn uses_beta() { beta(); }\n").unwrap();

        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = std::sync::Arc::new(BloomFilterCache::new());
        let args = serde_json::json!({
            "query": "alpha,beta",
            "kind": "callers",
            "scope": tmp.path().to_str().unwrap(),
        });

        let out = tool_search(&args, &cache, &session, &bloom).unwrap();

        assert!(
            out.contains("uses_beta"),
            "beta call site starved by alpha's hit-rich budget consumption \
             (early-quit budget was not scaled by target count): {out}"
        );
    }

    /// WHY: the require-root discipline fires ONLY when a caller EXPLICITLY
    /// passes a relative scope/path without an absolute root. A bare
    /// `pi_nav_search(query)` call with no scope is the default flow of every
    /// session and must keep working exactly as it does on main — refusing
    /// here would break every session's default search. This inverts the PR's
    /// original (too strict) assertion.
    ///
    /// Asserts only `is_ok()`, not the response body: the body is real search
    /// output over whatever tree the test runs in (including this very source
    /// file), so substring-matching it is not a reliable way to detect a
    /// require-root refusal. `resolve_scope`'s own unit tests in
    /// `mcp::tools::tests` already pin the exact refusal-vs-default-cwd
    /// behavior directly; this test only pins that `tool_search` propagates
    /// success through to its caller instead of swallowing it into an error.
    #[test]
    fn no_scope_no_root_defaults_to_cwd() {
        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = Arc::new(BloomFilterCache::new());
        let args = serde_json::json!({ "query": "anything_unlikely_to_match_zzz" });
        let result = tool_search(&args, &cache, &session, &bloom);
        assert!(
            result.is_ok(),
            "bare search must default to cwd, not refuse: {result:?}"
        );
    }

    /// An EXPLICITLY passed relative scope with no absolute root to anchor it
    /// is unresolvable (the server cannot see the caller's shell cwd) — this
    /// must still refuse.
    #[test]
    fn explicit_relative_scope_no_root_errors() {
        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = Arc::new(BloomFilterCache::new());
        let args = serde_json::json!({ "query": "anything", "scope": "some/relative/dir" });
        let err = tool_search(&args, &cache, &session, &bloom).unwrap_err();
        assert!(
            err.contains("relative scope") && err.contains("root"),
            "explicit relative scope without root must refuse: {err}"
        );
    }

    fn native(
        root: &Path,
    ) -> (
        crate::dispatch::NativeSession,
        crate::dispatch::OperationContext,
    ) {
        let session = crate::dispatch::NativeSession::new(root, false).expect("native session");
        let context = crate::dispatch::OperationContext::for_session(
            &session,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        (session, context)
    }

    #[test]
    fn structured_search_smart_case_globs_visibility_and_file_scope() {
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir(project.path().join(".git")).unwrap();
        std::fs::write(project.path().join(".gitignore"), "ignored.rs\n").unwrap();
        std::fs::write(project.path().join("visible.rs"), "pub fn CamelCase() {}\n").unwrap();
        std::fs::write(project.path().join("ignored.rs"), "pub fn CamelCase() {}\n").unwrap();
        std::fs::write(project.path().join("other.txt"), "CamelCase\n").unwrap();
        let (session, context) = native(project.path());
        let args = serde_json::json!({
            "root": project.path(), "scope": ".", "query": "camelcase", "kind": "symbol",
            "case": "smart", "glob": ["*.rs", "!ignored.rs"], "visibility": "project", "expand": 0
        });
        let output = tool_search_output(
            &args,
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        assert_eq!(output.structured["data"]["kind"], "symbol");
        assert!(output.text.contains("CamelCase"));
        assert!(output.structured["data"]["matches"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        assert!(output.structured["data"]["sourceRows"]
            .as_array()
            .is_some_and(|items| items.iter().all(|row| row["path"] == "visible.rs")));
        assert_eq!(output.structured["data"]["totalFound"], 1);
        assert_eq!(output.structured["data"]["definitions"], 1);
        assert_eq!(output.structured["data"]["usages"], 0);
        assert!(output.structured["data"]["facetTotals"].is_object());

        let sensitive = serde_json::json!({ "root": project.path(), "query": "camelcase", "kind": "symbol", "case": "sensitive", "expand": 0 });
        let output = tool_search_output(
            &sensitive,
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        assert!(output.structured["data"]["matches"]
            .as_array()
            .is_some_and(Vec::is_empty));

        let project_filtered = serde_json::json!({ "root": project.path(), "query": "CamelCase", "kind": "content", "case": "sensitive", "visibility": "project", "expand": 0 });
        let output = tool_search_output(
            &project_filtered,
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        assert!(output.structured["data"]["locations"]
            .as_array()
            .is_some_and(|items| items.iter().all(|item| item["path"] != "ignored.rs")));

        let file_scope = serde_json::json!({ "root": project.path(), "scope": "visible.rs", "query": "CamelCase", "kind": "content", "case": "sensitive", "expand": 0 });
        let output = tool_search_output(
            &file_scope,
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        assert!(output.structured["data"]["locations"]
            .as_array()
            .is_some_and(
                |items| !items.is_empty() && items.iter().all(|item| item["path"] == "visible.rs")
            ));
        assert!(output.structured["data"]["matches"]
            .as_array()
            .is_some_and(|items| items.iter().all(|item| item["role"] == "content")));
    }

    #[test]
    fn structured_callers_honor_case_globs_visibility_file_scope_and_visible_rows() {
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir(project.path().join(".git")).unwrap();
        std::fs::write(project.path().join(".gitignore"), "ignored.rs\n").unwrap();
        std::fs::write(
            project.path().join("visible.rs"),
            "pub fn Target() {}\npub fn visible() { Target(); }\n",
        )
        .unwrap();
        std::fs::write(
            project.path().join("ignored.rs"),
            "pub fn ignored() { Target(); }\n",
        )
        .unwrap();
        let (session, context) = native(project.path());
        let args = serde_json::json!({ "root": project.path(), "query": "target", "kind": "callers", "case": "insensitive", "glob": ["*.rs", "!ignored.rs"], "visibility": "all", "expand": 1 });
        let output = tool_search_output(
            &args,
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        let locations = output.structured["data"]["locations"].as_array().unwrap();
        assert!(
            !locations.is_empty()
                && locations
                    .iter()
                    .all(|location| location["path"] == "visible.rs")
        );
        for row in output.structured["data"]["sourceRows"].as_array().unwrap() {
            assert!(
                output.text.contains(row["text"].as_str().unwrap()),
                "source row must be visible in rendered text"
            );
        }
        let file = serde_json::json!({ "root": project.path(), "scope": "visible.rs", "query": "Target", "kind": "callers", "case": "sensitive", "visibility": "project", "expand": 0 });
        let output = tool_search_output(
            &file,
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        assert!(output.structured["data"]["locations"]
            .as_array()
            .is_some_and(
                |items| !items.is_empty() && items.iter().all(|item| item["path"] == "visible.rs")
            ));
    }

    #[test]
    fn callers_recover_alias_reexport_and_tsconfig_carriers() {
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir(project.path().join(".git")).unwrap();
        std::fs::create_dir_all(project.path().join("src")).unwrap();
        let write = |rel: &str, content: &str| {
            std::fs::write(project.path().join(rel), content).unwrap();
        };
        write(
            "src/manifest.ts",
            "export function loadManifest(raw: string) {\n  return JSON.parse(raw);\n}\n",
        );
        write(
            "src/direct.ts",
            "import { loadManifest as localLoad } from './manifest';\nexport function directCaller(raw: string) {\n  return localLoad(raw);\n}\n",
        );
        write(
            "src/barrel-a.ts",
            "export { loadManifest as parseManifest } from './manifest';\n",
        );
        write(
            "src/barrel-b.ts",
            "export { parseManifest as readManifest } from './barrel-a';\n",
        );
        write(
            "src/reexport.ts",
            "import { readManifest } from './barrel-b';\nexport function reexportCaller(raw: string) {\n  return readManifest(raw);\n}\n",
        );
        write(
            "src/path-alias.ts",
            "import { loadManifest as configLoad } from '@/manifest';\nexport function pathAliasCaller(raw: string) {\n  return configLoad(raw);\n}\n",
        );
        write(
            "src/plain.ts",
            "import { loadManifest } from './manifest';\nexport function plainCaller(raw: string) {\n  return loadManifest(raw);\n}\n",
        );
        // Hard stops: an import whose module does not export the symbol and a
        // namespace import must not produce inferred alias rows.
        write("src/barrel-x.ts", "export const unrelated = 1;\n");
        write(
            "src/decoy.ts",
            "import { loadManifest } from './barrel-x';\nexport function decoy() {\n  return 1;\n}\n",
        );
        write(
            "src/ns-decoy.ts",
            "import * as m from './manifest';\nexport function nsDecoy() {\n  return 1;\n}\n",
        );
        write(
            "tsconfig.json",
            r#"{"compilerOptions":{"baseUrl":"./src","paths":{"@/*":["*"]}}}"#,
        );
        let (session, context) = native(project.path());
        let args = serde_json::json!({ "root": project.path(), "query": "loadManifest", "kind": "callers", "case": "sensitive", "visibility": "project", "expand": 0 });
        let output = tool_search_output(
            &args,
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        let text = &output.text;
        for (file, owner, call) in [
            ("src/direct.ts", "directCaller", "return localLoad(raw);"),
            (
                "src/reexport.ts",
                "reexportCaller",
                "return readManifest(raw);",
            ),
            (
                "src/path-alias.ts",
                "pathAliasCaller",
                "return configLoad(raw);",
            ),
            ("src/plain.ts", "plainCaller", "return loadManifest(raw);"),
        ] {
            let header = format!("## {file}:3 [caller: {owner}]");
            assert!(
                text.contains(&header),
                "missing alias carrier {header:?} in:\n{text}"
            );
            assert!(
                text.contains(&format!("-> {call}")),
                "missing call text {call:?} in:\n{text}"
            );
        }
        // The direct named import is found by both the lexical walk and the
        // alias scan; the exact (path, line, carrier) merge keeps one row.
        assert_eq!(
            text.matches("## src/plain.ts:").count(),
            1,
            "plain.ts must appear exactly once:\n{text}"
        );
        assert!(
            !text.contains("src/decoy.ts"),
            "hard-stop decoy leaked:\n{text}"
        );
        assert!(
            !text.contains("src/ns-decoy.ts"),
            "namespace decoy leaked:\n{text}"
        );
        // Structured rows carry the alias sites with exact lines.
        let matches = output.structured["data"]["matches"].as_array().unwrap();
        for (file, line) in [
            ("src/direct.ts", 3),
            ("src/reexport.ts", 3),
            ("src/path-alias.ts", 3),
        ] {
            assert!(
                matches
                    .iter()
                    .any(|m| m["location"]["path"] == file && m["location"]["start"] == line),
                "missing structured alias match for {file}:{line}: {matches:?}"
            );
        }
        assert_eq!(
            matches
                .iter()
                .filter(|m| m["location"]["path"] == "src/plain.ts")
                .count(),
            1,
            "plain.ts must appear exactly once in structured matches: {matches:?}"
        );
    }

    #[test]
    fn exact_ranked_card_source_rows_match_live_read_lines() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(
            project.path().join("lib.rs"),
            "pub fn internal_helper(\n    value: i32,\n) -> i32 {\n    value + 1\n}\n\npub fn expanded_target() {\n    let alpha = 1;\n\n\n    let beta = internal_helper(2);\n    println!(\"{}\", alpha + beta);\n}\n",
        )
        .unwrap();
        std::fs::write(
            project.path().join("caller.rs"),
            "pub fn invoke_target() {\n    expanded_target();\n}\n",
        )
        .unwrap();
        std::fs::write(
            project.path().join("shadow.rs"),
            "pub fn shadowed(expanded_target: fn()) {\n    expanded_target();\n}\n",
        )
        .unwrap();
        let mut long_caller = "pub fn invoke_twice(\n    enabled: bool,\n) {\n".to_string();
        for line in 4..=30 {
            if matches!(line, 10 | 25) {
                long_caller.push_str("    expanded_target();\n");
            } else {
                long_caller.push_str(&format!("    let filler_{line} = {line};\n"));
            }
        }
        long_caller.push_str("}\n");
        std::fs::write(project.path().join("long.rs"), long_caller).unwrap();
        let (session, context) = native(project.path());
        let args = serde_json::json!({
            "root": project.path(),
            "query": "expanded_target",
            "kind": "symbol",
            "case": "sensitive",
            "expand": 1,
            "budget": 4000
        });
        let output = tool_search_output(
            &args,
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        let rows = output.structured["data"]["sourceRows"].as_array().unwrap();
        assert!(
            rows.len() > 1,
            "ranked target and lane live rows must be typed"
        );
        for row in rows {
            let line = row["line"].as_u64().unwrap();
            let text = row["text"].as_str().unwrap();
            assert_eq!(row["transformation"], "verbatim");
            let source =
                std::fs::read_to_string(project.path().join(row["path"].as_str().unwrap()))
                    .unwrap();
            assert_eq!(
                source.lines().nth(line as usize - 1),
                Some(text),
                "typed evidence must match the actual file, not just the same response"
            );
            assert!(
                output.text.lines().any(|rendered| {
                    let rendered = rendered.trim_start();
                    rendered == format!("{line}: {text}")
                        || (rendered.starts_with(&format!("[{line}-"))
                            && rendered.ends_with(&format!("]: {text}")))
                }),
                "typed row must be visible as a live line or stitched range header: {row:?}"
            );
        }
        assert_eq!(
            rows.iter().filter(|row| row["text"] == "").count(),
            2,
            "fully shown target bytes preserve consecutive blank source lines"
        );
        assert!(output
            .text
            .contains("callers — name/alias candidates; target binding unverified:"));
        assert!(output.text.contains(
            "caller.rs:\n    [1-3]: pub fn invoke_target() {\n    2:     expanded_target();"
        ));
        assert!(
            output.text.contains(
                "long.rs:\n    [1-31]: pub fn invoke_twice(\n    2:     enabled: bool,\n    3: ) {"
            ),
            "missing multiline caller declaration in:\n{}",
            output.text
        );
        // Selected operation windows retain complete context around both calls;
        // unrelated body filler is not automatically restored merely to fill a page.
        for line in (7..=13).chain(22..=28) {
            assert!(rows.iter().any(|row| row["path"] == "long.rs" && row["line"] == line), "missing caller context row {line}");
        }
        assert!(!rows.iter().any(|row| row["path"] == "long.rs" && row["line"] == 15));
        assert!(output
            .text
            .contains("call evidence — source-range origin; target ownership unverified:"));
        assert!(!output
            .text
            .contains("definitions resolved in the same or imported code"));
        assert!(output
            .text
            .contains("same/imported-name candidates; binding unverified"));
        let declaration = "    [1-5]: pub fn internal_helper(\n    2:     value: i32,\n    3: ) -> i32 {";
        let file_start = output.text.find("  lib.rs:\n").unwrap();
        let declaration_start = output.text.find(declaration).expect("complete callee signature");
        // Basis and exact call-site evidence may precede the declaration, but
        // another file heading must not steal its source attribution.
        assert!(declaration_start > file_start);
        assert!(output.text[file_start..declaration_start].lines().skip(1)
            .all(|line| !line.starts_with("  ") || line.starts_with("    ")), "{}", output.text);
        assert!(
            output.text.contains("shadow.rs:"),
            "uncertain candidates remain visible rather than being silently removed"
        );
        assert!(
            !output.text.contains("verified direct call sites"),
            "live bytes cannot certify the shadowed parameter's binding"
        );
    }

    #[test]
    fn structured_search_candidate_cap_has_no_total_and_invalid_inputs_fail() {
        let project = tempfile::tempdir().unwrap();
        for index in 0..40 {
            std::fs::write(project.path().join(format!("f{index}.txt")), "needle\n").unwrap();
        }
        let (session, context) = native(project.path());
        let args = serde_json::json!({ "root": project.path(), "query": "needle", "kind": "content", "case": "sensitive", "expand": 0 });
        let output = tool_search_output(
            &args,
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        assert_eq!(output.structured["completeness"]["complete"], false);
        assert_eq!(output.structured["completeness"]["reason"], "candidate_cap");
        assert!(output.structured["completeness"].get("total").is_none());

        let globs: Vec<String> = (0..21).map(|index| format!("*.{index}")).collect();
        let invalid =
            serde_json::json!({ "root": project.path(), "query": "needle", "glob": globs });
        assert!(tool_search_output(
            &invalid,
            &session.cache,
            &session.session,
            &session.bloom,
            &context
        )
        .is_err());
        let invalid_case =
            serde_json::json!({ "root": project.path(), "query": "needle", "case": "folded" });
        assert!(tool_search_output(
            &invalid_case,
            &session.cache,
            &session.session,
            &session.bloom,
            &context
        )
        .is_err());
    }

    #[test]
    fn search_defaults_and_typed_rows_follow_the_rendered_budget() {
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir(project.path().join("src")).unwrap();
        for index in 0..10 {
            std::fs::write(
                project.path().join("src").join(format!("f{index}.txt")),
                format!("needle-text {index} {}\n", "payload".repeat(100)),
            )
            .unwrap();
        }
        let (session, context) = native(project.path());
        let args = serde_json::json!({
            "root": project.path(),
            "query": "needle-text",
            "context": "src/f0.txt",
            "case": "sensitive",
            "expand": 0,
            "budget": 400
        });
        let output = tool_search_output(
            &args,
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        assert_eq!(output.structured["data"]["kind"], "content");
        let matches = output.structured["data"]["matches"].as_array().unwrap();
        let rows = output.structured["data"]["sourceRows"].as_array().unwrap();
        assert!(!rows.is_empty(), "visible preview rows must be emitted");
        assert!(
            rows.len() <= matches.len(),
            "typed source rows must remain a subset of typed matches"
        );
        for row in rows {
            assert_eq!(row["transformation"], "verbatim");
            assert!(output.text.contains(row["text"].as_str().unwrap()));
        }

        for invalid_glob in [serde_json::json!("!"), serde_json::json!(["!"])] {
            let invalid = serde_json::json!({
                "root": project.path(), "query": "needle-text", "glob": invalid_glob
            });
            assert!(tool_search_output(
                &invalid,
                &session.cache,
                &session.session,
                &session.bloom,
                &context,
            )
            .is_err());
        }

        let twenty = vec!["*.txt"; 20];
        let file_scope = serde_json::json!({
            "root": project.path(), "scope": "src/f0.txt", "query": "needle-text", "glob": twenty
        });
        assert!(tool_search_output(
            &file_scope,
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .is_ok());
    }

    #[test]
    fn exact_file_scope_precedes_search_caps_and_never_widens() {
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(project.path().join("src/nested")).unwrap();
        let selected = "src/lib[1].rs";
        std::fs::write(
            project.path().join(selected),
            "pub fn TokenStore() {}\npub fn Use() { TokenStore(); }\n",
        )
        .unwrap();
        let decoys = "pub fn TokenStore() {}\npub fn Decoy() { TokenStore(); }\n".repeat(200);
        for path in ["src/nested/lib[1].rs", "src/lib1.rs", "src/other.rs"] {
            std::fs::write(project.path().join(path), &decoys).unwrap();
        }
        let mut scopes = vec![selected];
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                project.path().join(selected),
                project.path().join("alias.rs"),
            )
            .unwrap();
            scopes.push("alias.rs");
        }
        let (session, context) = native(project.path());
        for scope in scopes {
            for visibility in ["project", "all"] {
                for (kind, query) in [
                    ("symbol", "tokenstore"),
                    ("content", "TokenStore"),
                    ("regex", "Token(Store)"),
                    ("auto", "token"),
                    ("callers", "TokenStore"),
                ] {
                    let output = tool_search_output(
                        &json!({"root": project.path(), "scope": scope, "query": query, "kind": kind, "case": "insensitive", "visibility": visibility, "glob": ["other.rs", "!lib*"], "expand": 0}),
                        &session.cache, &session.session, &session.bloom, &context,
                    ).unwrap();
                    let locations = output.structured["data"]["locations"].as_array().unwrap();
                    assert!(
                        !locations.is_empty(),
                        "{kind}/{visibility}/{scope}: {}",
                        output.text
                    );
                    assert!(
                        locations
                            .iter()
                            .all(|location| location["path"] == selected),
                        "{kind}/{visibility}/{scope}: {locations:?}"
                    );
                    if kind == "auto" {
                        assert!(
                            output.text.contains("— lib[1].rs #"),
                            "exact-file cards need a usable source header: {}",
                            output.text
                        );
                    }
                    if kind == "callers" {
                        assert!(
                            output.text.contains("## lib[1].rs:"),
                            "exact-file caller headers must not have an empty identity: {}",
                            output.text
                        );
                    }
                }
            }
        }
        let missing = tool_search_output(
            &json!({"root": project.path(), "scope": "src/missing.rs", "query": "TokenStore"}),
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        );
        assert!(
            missing.is_err(),
            "a missing exact scope must not fall back to the project"
        );
    }

    #[test]
    fn auto_route_distinguishes_symbol_behavior_pipe_phrase_and_regex() {
        assert_eq!(resolve_kind("auto", "MemoryCache").unwrap().0, "symbol");
        assert_eq!(resolve_kind("auto", "cache").unwrap().0, "fuzzy");
        assert_eq!(
            resolve_kind("auto", "where is token expiry handled")
                .unwrap()
                .0,
            "fuzzy"
        );
        assert_eq!(
            resolve_kind("auto", "token|expiry|backoff").unwrap().0,
            "fuzzy"
        );
        assert_eq!(resolve_kind("auto", "/token|expiry/").unwrap().0, "regex");
        assert_eq!(
            resolve_kind("content", "token|expiry").unwrap().0,
            "content"
        );
    }

    #[test]
    fn auto_closing_punctuation_is_literal_in_ranked_and_matches() {
        let directory = tempfile::tempdir().unwrap();
        let source = "pub const VALUE: &str = \"a)b\";\n";
        std::fs::write(directory.path().join("lib.rs"), source).unwrap();
        let (session, context) = native(directory.path());
        for output in ["ranked", "matches"] {
            let mut args = json!({"root":directory.path(), "scope":directory.path(),
                "query":"a)b", "pattern":"a)b", "output":output, "kind":"auto", "syntax":"auto"});
            let result = tool_search_output(&args, &session.cache, &session.session, &session.bloom, &context).unwrap();
            assert!(result.text.contains(source.trim()), "{output} omitted the literal source: {}", result.text);
            // An explicitly requested invalid regex must still fail, not become literal.
            args["kind"] = json!("regex");
            args["syntax"] = json!("regex");
            assert!(tool_search_output(&args, &session.cache, &session.session, &session.bloom, &context).is_err(), "{output} ignored explicit regex");
        }
        assert_eq!(resolve_kind("auto", "a)b").unwrap(), ("content", "a)b"));
        assert!(resolve_kind("auto", "a(b").is_err(), "an opening regex group retains strong intent");
    }

    #[test]
    fn fuzzy_relocation_cannot_create_evidence_and_scaffolding_can_be_a_symbol() {
        let base = tempfile::tempdir().unwrap();
        for folder in ["neutral", "banana"] {
            let root = base.path().join(folder);
            std::fs::create_dir(&root).unwrap();
            std::fs::write(
                root.join("lib.rs"),
                "pub fn Connect() {}\npub fn find() {}\n",
            )
            .unwrap();
            let (session, context) = native(&root);
            let query = |term: &str| {
                tool_search_output(
                &json!({"root": root, "scope": root, "query": term, "kind": "auto", "expand": 0}),
                &session.cache, &session.session, &session.bloom, &context,
            ).unwrap()
            };
            assert!(
                query("banana").structured["data"]["matches"]
                    .as_array()
                    .unwrap()
                    .is_empty(),
                "an enclosing host folder cannot invent query evidence"
            );
            assert!(query("find").structured["data"]["matches"]
                .as_array()
                .unwrap()
                .iter()
                .any(|matched| matched["symbol"] == "find"));
            std::fs::write(root.join("banana.rs"), "pub fn Load() {}\n").unwrap();
            assert!(
                query("banana").structured["data"]["matches"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|matched| matched["symbol"] == "Load"),
                "real project-relative path evidence stays useful"
            );
            let external = base.path().join("banana.rs");
            std::fs::write(&external, "pub fn OutsideLoad() {}\n").unwrap();
            let output = tool_search_output(
                &json!({"root": root, "scope": external, "query": "banana", "kind": "auto", "expand": 0}),
                &session.cache, &session.session, &session.bloom, &context,
            ).unwrap();
            assert!(
                output.structured["data"]["matches"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|matched| matched["symbol"] == "OutsideLoad"),
                "an explicit external file retains its own filename evidence"
            );
        }
    }

    #[test]
    fn fuzzy_question_normalization_ranks_structural_owner_first() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(
            project.path().join("retry.ts"),
            "/** Renew a token after expiry with bounded backoff. */\nexport function scheduleTokenRenewal(token: string): number {\n  return token.length;\n}\n",
        )
        .unwrap();
        std::fs::write(
            project.path().join("parse.ts"),
            "export function parseToken(token: string): string {\n  return token.trim();\n}\n",
        )
        .unwrap();
        std::fs::write(
            project.path().join("inline.rs"),
            "#[cfg(test)]\nmod tests {\n    fn token_expiry_backoff_test_helper() {}\n}\n",
        )
        .unwrap();
        let (session, context) = native(project.path());
        let output = tool_search_output(
            &json!({
                "root": project.path(),
                "query": "where is token expiry backoff handled",
                "kind": "auto",
                "expand": 2,
                "budget": 4_000
            }),
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        assert_eq!(output.structured["data"]["kind"], "fuzzy");
        assert_eq!(
            output.structured["data"]["fuzzy"]["normalizedTerms"],
            json!(["token", "expiry", "backoff"])
        );
        assert_eq!(
            output.structured["data"]["matches"][0]["symbol"],
            "scheduleTokenRenewal"
        );
        assert!(output.text.contains("Route: behavior discovery"));
        assert!(output.text.contains("scheduleTokenRenewal"));
        assert!(!output.text.contains("token_expiry_backoff_test_helper"));
        assert_eq!(output.structured["data"]["fuzzy"]["semanticTier"]["status"], "unavailable");
        assert!(output.text.contains("no admitted semantic publication supplied"));
    }

    #[test]
    fn fuzzy_legacy_bodies_require_unique_syntax_spans() {
        let project = tempfile::tempdir().unwrap();
        let code = "impl Driver { fn first() { beep(); } fn second() { boop(); } }\n";
        std::fs::write(project.path().join("driver.rs"), code).unwrap();
        let (session, context) = native(project.path());
        let output = tool_search_output(
            &json!({"root": project.path(), "query": "boop", "kind": "auto", "expand": 2}),
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        let matches = output.structured["data"]["matches"].as_array().unwrap();
        assert!(
            matches.iter().any(|matched| matched["symbol"] == "second"),
            "{}",
            output.text
        );
        assert!(
            !matches.iter().any(|matched| matched["symbol"] == "first"),
            "{}",
            output.text
        );
        assert!(output.text.contains("kind: fn"), "{}", output.text);
        for row in output.structured["data"]["sourceRows"].as_array().unwrap() {
            assert_eq!(
                row["text"].as_str(),
                code.lines().nth(row["line"].as_u64().unwrap() as usize - 1)
            );
        }

        // Same names and rows are not sufficient to pick one of two bodies.
        let file = project.path().join("shared.rs");
        std::fs::write(
            &file,
            "impl A { fn drive() { emerald(); } } impl B { fn drive() { cobalt(); } }\n",
        )
        .unwrap();
        let fuzzy = crate::search::fuzzy::search(
            "drive|emerald",
            &file,
            &[],
            crate::walk::Visibility::Project,
            Arc::new(crate::search::OperationSources::default()),
            &context,
        )
        .unwrap();
        assert_eq!(
            fuzzy
                .term_counts
                .iter()
                .find(|(term, _)| term == "emerald")
                .unwrap()
                .1,
            0
        );
        assert_eq!(
            fuzzy
                .result
                .matches
                .iter()
                .filter(|matched| matched.def_name.as_deref() == Some("drive"))
                .count(),
            2
        );
        assert!(!fuzzy.complete);
        assert!(fuzzy
            .diagnostics
            .iter()
            .any(|message| message.contains("without unique syntax spans")));
        let output = tool_search_output(
            &json!({"root": project.path(), "query": "drive", "kind": "auto", "scope": file, "expand": 2}),
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        ).unwrap();
        assert_eq!(output.structured["completeness"]["reason"], "error");
        assert!(output
            .text
            .contains("lexical relevance, not semantic ownership"));
    }

    #[test]
    fn fuzzy_owned_operations_and_document_sections_enter_before_card_selection() {
        let project = tempfile::tempdir().unwrap();
        let code = "export class Store {\n  flush() {\n    if (this.pending && this.failures < this.limit) {\n      this.retry(this.backoff);\n    }\n  }\n  retry(delay: number) { return delay; }\n}\nexport function Decoy() {\n  function hidden() { return 'quarantine'; }\n  return 'clean';\n}\n";
        let guide = "Writer\n======\nRecovery\n--------\nPending failures use retry backoff; inspect Store.flush before changing the policy.\n";
        std::fs::write(project.path().join("store.ts"), code).unwrap();
        std::fs::write(project.path().join("guide.md"), guide).unwrap();
        std::fs::write(project.path().join("asset.txt"), [0xff, 0xfe, 0x00]).unwrap();
        let discovery = crate::search::fuzzy::search(
            "pending failures retry backoff",
            project.path(),
            &[],
            crate::walk::Visibility::Project,
            Arc::new(crate::search::OperationSources::default()),
            &native(project.path()).1,
        )
        .unwrap();
        assert!(discovery.complete, "{:?}", discovery.diagnostics);
        let (session, context) = native(project.path());
        let query = |pattern: &str| {
            tool_search_output(
            &json!({"root": project.path(), "query": pattern, "kind": "auto", "expand": 2, "budget": 4_000}),
            &session.cache, &session.session, &session.bloom, &context,
        ).unwrap()
        };
        let output = query("pending failures retry backoff");
        let selected = output.structured["data"]["matches"]
            .as_array()
            .unwrap()
            .iter()
            .take(5)
            .collect::<Vec<_>>();
        assert!(
            selected.iter().any(|matched| matched["symbol"] == "flush"),
            "{}",
            output.text
        );
        assert!(
            selected
                .iter()
                .any(|matched| matched["symbol"] == "Recovery"),
            "{}",
            output.text
        );
        assert!(output.text.contains("kind: document section"));
        assert!(output.text.contains("in Writer [1-5]"), "{}", output.text);
        let rows = output.structured["data"]["sourceRows"].as_array().unwrap();
        assert!(rows
            .iter()
            .any(|row| row["path"] == "store.ts" && row["line"] == 4));
        assert!(rows
            .iter()
            .any(|row| row["path"] == "guide.md" && row["line"] == 5));
        for row in rows {
            let content =
                std::fs::read_to_string(project.path().join(row["path"].as_str().unwrap()))
                    .unwrap();
            assert_eq!(
                content
                    .lines()
                    .nth(row["line"].as_u64().unwrap() as usize - 1),
                row["text"].as_str()
            );
        }
        let nested = query("quarantine");
        let symbols = nested.structured["data"]["matches"].as_array().unwrap();
        assert!(symbols.iter().any(|matched| matched["symbol"] == "hidden"));
        assert!(
            !symbols.iter().any(|matched| matched["symbol"] == "Decoy"),
            "a containing declaration must not inherit a nested implementation's terms"
        );
        // Every query term already has a code candidate: zero-term fallback
        // cannot compensate for missing headerless prose or a document prefix.
        for (path, bytes) in [
            ("plain.md", "Pending failures use retry backoff without headings.\n"),
            ("preamble.md", "Pending failures use retry backoff before a heading.\n\n# Quiet\nUnrelated section text.\n"),
            ("empty.md", "\n  \n"),
        ] {
            std::fs::write(project.path().join(path), bytes).unwrap();
        }
        let output = query("pending|failures|retry|backoff");
        let rows = output.structured["data"]["sourceRows"].as_array().unwrap();
        for path in ["plain.md", "preamble.md"] {
            assert!(
                rows.iter()
                    .any(|row| row["path"] == path && row["line"] == 1),
                "{}",
                output.text
            );
            let bytes = std::fs::read_to_string(project.path().join(path)).unwrap();
            assert!(
                output.text.contains(bytes.lines().next().unwrap()),
                "{}",
                output.text
            );
        }
        assert!(
            output.text.contains("kind: document preamble"),
            "{}",
            output.text
        );
        assert!(!rows.iter().any(|row| row["path"] == "empty.md"));
    }

    #[test]
    fn fuzzy_pipe_keeps_each_hit_bearing_term_in_the_top_five() {
        let project = tempfile::tempdir().unwrap();
        for (file, name) in [
            ("token.ts", "tokenWorker"),
            ("expiry.ts", "expiryWorker"),
            ("backoff.ts", "backoffWorker"),
        ] {
            let body = (0..60)
                .map(|index| format!("  const step_{index} = {index};"))
                .collect::<Vec<_>>()
                .join("\n");
            std::fs::write(
                project.path().join(file),
                format!("export function {name}(): void {{\n{body}\n}}\n"),
            )
            .unwrap();
        }
        let (session, context) = native(project.path());
        let output = tool_search_output(
            &json!({
                "root": project.path(),
                "query": "token|expiry|backoff",
                "kind": "auto",
                "expand": 2,
                "budget": 4_000
            }),
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        let symbols: HashSet<_> = output.structured["data"]["matches"]
            .as_array()
            .unwrap()
            .iter()
            .take(5)
            .filter_map(|matched| matched["symbol"].as_str())
            .collect();
        for expected in ["tokenWorker", "expiryWorker", "backoffWorker"] {
            assert!(
                symbols.contains(expected),
                "missing {expected}: {symbols:?}"
            );
        }
        let rows = output.structured["data"]["sourceRows"].as_array().unwrap();
        for file in ["token.ts", "expiry.ts", "backoff.ts"] {
            let visible = rows.iter().filter(|row| row["path"] == file).count();
            assert!(
                (20..=50).contains(&visible),
                "{file} should retain a useful mini-card without exceeding the 50-line ceiling: {visible}\n{}", output.text
            );
        }
        assert!(output.text.contains("remaining target"));
    }

    #[test]
    fn fuzzy_n0_falls_back_to_exact_mentions_then_nearest_and_preserves_honest_zero() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(
            project.path().join("config.rs"),
            "const AUTH_TOKEN_TTL: u64 = 3600;\n",
        )
        .unwrap();
        std::fs::write(project.path().join("cache.ts"), "export class Cache {}\n").unwrap();
        std::fs::write(
            project.path().join("validate.ts"),
            "export function validate(): boolean { return true; }\n",
        )
        .unwrap();
        std::fs::write(
            project.path().join("notes.ts"),
            "// validte is deliberately misspelled in this cache migration note\n",
        )
        .unwrap();
        std::fs::write(
            project.path().join("guide.md"),
            "# Cache migration\nRun validte before replacing the cache.\n",
        )
        .unwrap();
        let (session, context) = native(project.path());
        let nearest = tool_search_output(
            &json!({
                "root": project.path(),
                "query": "AUTHTOKENTTL",
                "kind": "auto",
                "expand": 2,
                "budget": 4_000
            }),
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        assert!(nearest
            .text
            .contains("Route: zero-definition symbol fallback"));
        assert!(nearest
            .text
            .contains("authtokenttl=0 [nearest-symbol:normalized-name]"));
        assert!(
            nearest.structured["data"]["fuzzy"]["nearestFallback"] == true,
            "unexpected fallback metadata: {}",
            nearest.structured["data"]
        );
        assert_eq!(
            nearest.structured["data"]["matches"][0]["symbol"],
            "AUTH_TOKEN_TTL"
        );

        let mentions = tool_search_output(
            &json!({
                "root": project.path(),
                "query": "cache|validte",
                "kind": "auto",
                "expand": 2,
                "budget": 4_000
            }),
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        assert!(mentions
            .text
            .contains("validte=0 [exact-mentions:2 + nearest-symbol:edit-distance]"));
        assert!(mentions
            .text
            .contains("exact non-definition mentions (fallback):"));
        assert!(mentions
            .text
            .contains("notes.ts:\n    top-level\n    1: // validte"));
        let document_rows = mentions.structured["data"]["sourceRows"]
            .as_array()
            .unwrap();
        assert!(document_rows.iter().any(|row| row["path"] == "guide.md"
            && row["line"] == 2
            && row["text"] == "Run validte before replacing the cache."));
        assert!(mentions.text.contains("kind: document section"));
        assert!(mentions
            .text
            .contains("2: Run validte before replacing the cache."));
        assert!(
            mentions.structured["data"]["matches"]
                .as_array()
                .unwrap()
                .iter()
                .any(|matched| matched["symbol"] == "validate"),
            "nearest code alternative survives document retrieval"
        );

        let zero = tool_search_output(
            &json!({
                "root": project.path(),
                "query": "ZXQ_UNRELATED_MISSING_SYMBOL",
                "kind": "auto",
                "expand": 2,
                "budget": 4_000
            }),
            &session.cache,
            &session.session,
            &session.bloom,
            &context,
        )
        .unwrap();
        assert!(zero.text.contains("0 results in scope"));
        assert!(zero.structured["data"]["matches"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn ranked_focus_preserves_question_source_qualification_scope_and_ambiguity() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let path = root.join("owners.ts");
        let source = "class Wanted { run(value: number) {\n  const retained = value + 1;\n  return retained;\n} }\nclass Decoy { run() { return 'expiry retry'; } }\nfunction duplicate() {} function duplicate() {}\nfunction envelope() { (() => { function hidden() {} })(); }\n";
        std::fs::write(&path, source).unwrap();
        std::fs::write(root.join("other.ts"), "function Elsewhere() {}\n").unwrap();
        let (session, context) = native(&root);
        let call = |args: &Value| tool_search_output(args, &session.cache, &session.session, &session.bloom, &context);
        let mut args = json!({"root":root,"scope":root,"query":"expiry retry question","kind":"auto",
            "focus":{"target":format!("{}::Wanted.run", path.display())}});
        let output = call(&args).unwrap();
        assert_eq!(output.structured["data"]["mode"], "ranked");
        assert_eq!(output.structured["data"]["query"], "expiry retry question");
        assert_eq!(output.structured["data"]["focus"]["status"], "ok");
        assert_eq!(output.structured["data"]["matches"].as_array().unwrap().len(), 1);
        assert!(output.text.contains("const retained = value + 1;"), "{}", output.text);
        assert!(output.text.contains("return retained;"));
        assert!(!output.text.contains("class Decoy"));
        for row in output.structured["data"]["sourceRows"].as_array().unwrap() {
            let text = std::fs::read_to_string(root.join(row["path"].as_str().unwrap())).unwrap();
            assert_eq!(row["text"].as_str().unwrap(), text.lines().nth(row["line"].as_u64().unwrap() as usize - 1).unwrap());
        }
        args["focus"]["target"] = json!(format!("{}::duplicate", path.display()));
        let output = call(&args).unwrap();
        assert_eq!(output.structured["data"]["focus"]["status"], "ambiguous");
        let alternatives = output.structured["data"]["focus"]["alternatives"].as_array().unwrap();
        assert_eq!(alternatives.len(), 2);
        assert_ne!(alternatives[0]["sourceIdentity"], alternatives[1]["sourceIdentity"]);
        assert!(!output.text.contains("connections for"));
        for missing in ["Wanted.rum", "envelope.hidden"] {
            args["focus"]["target"] = json!(format!("{}::{missing}", path.display()));
            let output = call(&args).unwrap();
            assert_eq!(output.structured["data"]["focus"]["status"], "not_found");
            assert!(!output.text.contains("nearest real symbols shown"));
        }
        args["focus"]["target"] = json!(format!("{}::Wanted.run", path.display()));
        args["scope"] = json!(root.join("other.ts"));
        assert!(call(&args).unwrap_err().contains("outside"));
        args["scope"] = json!(root);
        args["glob"] = json!("other.ts");
        assert_eq!(call(&args).unwrap().structured["data"]["focus"]["status"], "not_found");
        args.as_object_mut().unwrap().remove("glob");
        args["focus"]["evidence"] = json!("documentation");
        let output = call(&args).unwrap();
        assert_eq!(output.structured["data"]["focus"]["evidence"], json!(["documentation"]));
        assert_eq!(output.structured["data"]["focus"]["evidenceStatus"]["documentation"], "unavailable");
        assert!(output.text.contains("return retained;"));
        assert!(output.text.contains("authored reference owner"));
        args["output"] = json!("matches");
        assert!(call(&args).unwrap_err().contains("ranked-only"));
    }

    /// List focus keeps every requested category: unrequested evidence is never
    /// deleted, requested categories are presented in the supplied order, and
    /// each requested category carries an honest status. Scalar evidence stays
    /// accepted and normalizes to a one-item list.
    #[test]
    fn ranked_focus_list_retains_categories_and_presents_requested_first() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let path = root.join("lib.ts");
        std::fs::write(&path, "export function helper() { return 1; }\n\
            export function Wanted() { return helper(); }\n\
            export function Caller() { return Wanted(); }\n").unwrap();
        let (session, context) = native(&root);
        let call = |args: &Value| tool_search_output(args, &session.cache, &session.session, &session.bloom, &context);
        let caller_heading = "callers — name/alias candidates";
        let callee_heading = "call evidence —";
        let mut args = json!({"root":root,"scope":root,"query":"Wanted","kind":"symbol",
            "focus":{"target":format!("{}::Wanted", path.display())}});
        let baseline = call(&args).unwrap();
        assert!(baseline.text.contains(caller_heading), "{}", baseline.text);
        assert!(baseline.text.contains(callee_heading), "{}", baseline.text);
        args["focus"]["evidence"] = json!("callers");
        let retained = call(&args).unwrap();
        assert_eq!(retained.structured["data"]["focus"]["evidence"], json!(["callers"]));
        assert_eq!(retained.structured["data"]["focus"]["evidenceStatus"]["callers"],
            "bounded candidates; completeness and binding are not guaranteed");
        assert!(retained.text.contains(caller_heading), "{}", retained.text);
        assert!(retained.text.contains(callee_heading), "scalar focus deleted unrelated evidence: {}", retained.text);
        args["focus"]["evidence"] = json!(["callees", "callers", "callees"]);
        let ordered = call(&args).unwrap();
        assert_eq!(ordered.structured["data"]["focus"]["evidence"], json!(["callees", "callers"]));
        assert!(ordered.structured["data"]["focus"]["evidenceStatus"]["callees"].is_string());
        assert!(ordered.structured["data"]["focus"]["evidenceStatus"]["callers"].is_string());
        let callee_at = ordered.text.find(callee_heading).expect("callee evidence");
        let caller_at = ordered.text.find(caller_heading).expect("caller evidence");
        assert!(callee_at < caller_at, "requested order not presented: {}", ordered.text);
        let mut invalid = args.clone();
        invalid["focus"]["evidence"] = json!(["callers", "retry"]);
        assert!(call(&invalid).unwrap_err().contains("focus.evidence"));
    }

    /// Name-only targets resolve by exact identity across the admitted scope:
    /// qualified and plain spellings select a unique owner, several owners stay
    /// honest alternatives, and a missing name is never rescued lexically.
    #[test]
    fn ranked_focus_name_only_resolves_exact_identity_and_keeps_alternatives_honest() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        std::fs::write(root.join("one.ts"), "export function Wanted() { return 1; }\n\
            export class Worker { flush() { return 2; } }\n\
            export function WantedRetry() { return 3; }\n").unwrap();
        std::fs::write(root.join("two.ts"), "export function Wanted() { return 4; }\n").unwrap();
        let (session, context) = native(&root);
        let call = |args: &Value| tool_search_output(args, &session.cache, &session.session, &session.bloom, &context);
        let query = "which wanted value returns";
        let mut args = json!({"root":root,"scope":root,"query":query,"kind":"auto",
            "focus":{"target":"Wanted"}});
        let ambiguous = call(&args).unwrap();
        assert_eq!(ambiguous.structured["data"]["focus"]["status"], "ambiguous");
        let alternatives = ambiguous.structured["data"]["focus"]["alternatives"].as_array().unwrap();
        assert_eq!(alternatives.len(), 2, "{}", ambiguous.text);
        assert_ne!(alternatives[0]["path"], alternatives[1]["path"]);
        std::fs::remove_file(root.join("two.ts")).unwrap();
        let resolved = call(&args).unwrap();
        assert_eq!(resolved.structured["data"]["focus"]["status"], "ok");
        assert_eq!(resolved.structured["data"]["matches"].as_array().unwrap().len(), 1);
        args["focus"]["target"] = json!("Worker.flush");
        let qualified = call(&args).unwrap();
        assert_eq!(qualified.structured["data"]["focus"]["status"], "ok");
        assert_eq!(qualified.structured["data"]["matches"].as_array().unwrap().len(), 1);
        args["focus"]["target"] = json!("WantedNowhere");
        let missing = call(&args).unwrap();
        assert_eq!(missing.structured["data"]["focus"]["status"], "not_found");
        assert!(!missing.text.contains("# Wanted"), "{}", missing.text);
        assert!(!missing.text.contains("nearest real symbols shown"), "{}", missing.text);
    }

    /// Evidence-only focus emphasizes the ordinary connected candidates and
    /// selects no owner: the metadata carries no target and the candidates keep
    /// their lexical ordering.
    #[test]
    fn ranked_focus_evidence_only_emphasizes_connected_candidates_without_an_owner() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        std::fs::write(root.join("lib.ts"), "export function helper() { return 1; }\n\
            export function Wanted() { return helper(); }\n\
            export function Caller() { return Wanted(); }\n").unwrap();
        let (session, context) = native(&root);
        let call = |args: &Value| tool_search_output(args, &session.cache, &session.session, &session.bloom, &context);
        let output = call(&json!({"root":root,"scope":root,"query":"Wanted","kind":"symbol",
            "focus":{"evidence":["callers","documentation"]}})).unwrap();
        assert!(output.structured["data"]["focus"]["target"].is_null());
        assert_eq!(output.structured["data"]["focus"]["status"], "connected");
        assert_eq!(output.structured["data"]["focus"]["evidence"], json!(["callers", "documentation"]));
        assert_eq!(output.structured["data"]["focus"]["evidenceStatus"]["documentation"], "unavailable");
        assert_eq!(output.structured["data"]["focus"]["evidenceStatus"]["callers"],
            "bounded candidates; completeness and binding are not guaranteed");
        assert!(output.text.contains("Focus: connected candidates — connected"), "{}", output.text);
        assert!(output.text.contains("Evidence emphasis: callers, documentation;"), "{}", output.text);
        assert!(output.text.contains("# Wanted — lib.ts"), "{}", output.text);
        assert!(output.text.contains("callers — name/alias candidates"), "{}", output.text);
    }

    /// A focus without a subject and a path-only target are refused instead of
    /// guessed, while the existing absolute path validation stays intact.
    #[test]
    fn ranked_focus_refuses_empty_and_path_only_forms() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        std::fs::write(root.join("lib.ts"), "export function Wanted() { return 1; }\n").unwrap();
        let (session, context) = native(&root);
        let call = |args: &Value| tool_search_output(args, &session.cache, &session.session, &session.bloom, &context);
        let empty = call(&json!({"root":root,"scope":root,"query":"Wanted","kind":"auto","focus":{}})).unwrap_err();
        assert!(empty.contains("focus requires a target or at least one evidence category"), "{empty}");
        let pathy = call(&json!({"root":root,"scope":root,"query":"Wanted","kind":"auto",
            "focus":{"target":"src/lib.ts"}})).unwrap_err();
        assert!(pathy.contains("cannot be a path"), "{pathy}");
        let outside = call(&json!({"root":root,"scope":root,"query":"Wanted","kind":"auto",
            "focus":{"target":"/etc/hosts::Wanted"}})).unwrap_err();
        assert!(outside.contains("outside the original requested scope"), "{outside}");
    }

    /// `Worker::flush` is a qualified name, not a relative pathname: the colon
    /// spelling selects the same exact identity as `Worker.flush`, keeps several
    /// owners as honest alternatives, never rescues a missing name, and leaves
    /// relative path spellings refused.
    #[test]
    fn ranked_focus_colon_qualified_names_resolve_like_dot_spellings() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let body = "export class Worker {\n    flush() { return 1; }\n}\n";
        std::fs::write(root.join("one.ts"), body).unwrap();
        std::fs::write(root.join("two.ts"), body).unwrap();
        let (session, context) = native(&root);
        let call = |args: &Value| tool_search_output(args, &session.cache, &session.session, &session.bloom, &context);
        let mut args = json!({"root":root,"scope":root,"query":"how does worker flush behave","kind":"auto",
            "focus":{"target":"Worker::flush"}});
        let ambiguous = call(&args).unwrap();
        assert_eq!(ambiguous.structured["data"]["focus"]["status"], "ambiguous");
        assert_eq!(ambiguous.structured["data"]["focus"]["alternatives"].as_array().unwrap().len(), 2);
        std::fs::remove_file(root.join("two.ts")).unwrap();
        let colon = call(&args).unwrap();
        assert_eq!(colon.structured["data"]["focus"]["status"], "ok");
        assert_eq!(colon.structured["data"]["matches"].as_array().unwrap().len(), 1);
        args["focus"]["target"] = json!("Worker.flush");
        let dot = call(&args).unwrap();
        assert_eq!(dot.structured["data"]["focus"]["status"], "ok");
        assert_eq!(dot.structured["data"]["matches"].as_array().unwrap().len(), 1);
        args["focus"]["target"] = json!("Worker::missing");
        let missing = call(&args).unwrap();
        assert_eq!(missing.structured["data"]["focus"]["status"], "not_found");
        assert!(!missing.text.contains("# Worker"), "{}", missing.text);
        assert!(!missing.text.contains("nearest real symbols shown"), "{}", missing.text);
        for spelling in ["src/one.ts::Worker.flush", "one.ts::Worker.flush"] {
            let mut relative = args.clone();
            relative["focus"]["target"] = json!(spelling);
            assert!(call(&relative).unwrap_err().contains("absolute"), "{spelling}");
        }
    }

    /// Corpus admission belongs to ranked discovery: widened `all` visibility and
    /// text (content/regex) discovery may carry it, explicit audits and legacy
    /// callers may not.
    #[test]
    fn corpus_admission_is_legal_for_widened_and_text_discovery() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = Arc::new(BloomFilterCache::new());
        let admission = json!({ "root": root, "files": [], "policyDigest": "a".repeat(64),
            "policyFiles": [{ "path": root.join(".pi-navigation.json"), "digest": null }] });
        let accepted = [
            json!({ "query": "token", "kind": "content", "scope": root, "corpusAdmission": admission }),
            json!({ "query": "token", "kind": "regex", "scope": root, "corpusAdmission": admission }),
            json!({ "query": "token", "kind": "symbol", "scope": root, "visibility": "all", "corpusAdmission": admission }),
        ];
        for args in accepted {
            let error = tool_search(&args, &cache, &session, &bloom).unwrap_err();
            assert!(!error.contains("ranked-discovery-only"), "{args}: {error}");
        }
        let rejected = [
            json!({ "pattern": "token", "output": "matches", "paths": [root], "corpusAdmission": admission }),
            json!({ "query": "token", "kind": "callers", "scope": root, "corpusAdmission": admission }),
        ];
        for args in rejected {
            let error = tool_search(&args, &cache, &session, &bloom).unwrap_err();
            assert!(error.contains("ranked-discovery-only"), "{args}: {error}");
        }
    }
}
