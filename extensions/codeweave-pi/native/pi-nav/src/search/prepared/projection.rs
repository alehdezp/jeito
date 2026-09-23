//! Bounded consumer topology on the existing admitted, completed-run snapshot.
//! Numbered pages belong to pagePreparedEvidence; this module returns one stable
//! bounded collection, never a second store, graph pager, or ranking policy.
use super::*;
use std::collections::{BTreeSet, VecDeque};
use crate::output::{IncompleteReason, ToolOutput};

const NODE_LIMIT: usize = 1_000;
const EDGE_LIMIT: usize = 4_000;
const SCAN_LIMIT: usize = 20_000;
// Collection is work-bounded separately from the smaller transport envelope.
const BYTE_LIMIT: usize = 1024 * 1024;
const TRANSPORT_LIMIT: usize = 256 * 1024;
const COLUMNS: &str = "id,kind,name,qualified_name,file_path,start_line,end_line,start_column,end_column";
const NODE_KINDS: &[&str] = &["file", "module", "class", "struct", "interface", "trait", "protocol", "function", "method", "property", "field", "variable", "constant", "enum", "enum_member", "type_alias", "namespace", "parameter", "import", "export", "route", "component", "union"];
const EDGE_KINDS: &[&str] = &["contains", "calls", "imports", "exports", "extends", "implements", "references", "type_of", "returns", "instantiates", "overrides", "decorates"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    operation: Operation,
    #[serde(default)]
    node_kinds: Vec<String>,
    depth: Option<usize>,
    #[serde(default)]
    test_only: bool,
    #[serde(default)]
    files: Vec<String>,
}
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Operation { Search, Traverse, Callers, Callees, Impact }
impl Options {
    fn depth(&self) -> usize { self.depth.unwrap_or(if self.relation() { 1 } else { 2 }) }
    fn relation(&self) -> bool { matches!(self.operation, Operation::Callers | Operation::Callees) }
    fn accepts(&self, node: &Node) -> bool { self.node_kinds.is_empty() || self.node_kinds.contains(&node.kind) }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectedNode {
    #[serde(flatten)]
    node: Node,
    depth: usize,
    is_test_file: bool,
}
impl ProjectedNode {
    fn new(node: Node, depth: usize) -> Self {
        Self { is_test_file:crate::types::is_test_file(Path::new(&node.file)), node, depth }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Edge {
    id: i64,
    source: String,
    target: String,
    kind: String,
    line: Option<u32>,
    column: Option<u32>,
    function_reference: bool,
}
#[derive(Default)]
struct Coverage { reasons: BTreeSet<&'static str>, bytes: usize }
impl Coverage {
    fn reserve(&mut self, value: &impl Serialize) -> Result<bool> {
        let bytes = serde_json::to_vec(value)?.len();
        if bytes > BYTE_LIMIT.saturating_sub(self.bytes) {
            self.reasons.insert("projection_byte_cap");
            return Ok(false);
        }
        self.bytes += bytes;
        Ok(true)
    }
}

pub(crate) fn execute(arguments: &Value, context: &OperationContext) -> std::result::Result<ToolOutput, String> {
    run(arguments, context).map_err(|error| format!("indexed projection unavailable: {error}"))
}
fn run(arguments: &Value, context: &OperationContext) -> Result<ToolOutput> {
    context.check()?;
    let mut options: Options = serde_json::from_value(arguments["analysisProjection"].clone())?;
    if options.node_kinds.len() > NODE_KINDS.len() || options.node_kinds.iter().any(|kind| !NODE_KINDS.contains(&kind.as_str())) {
        return Err("nodeKinds requires donor node kinds; Test classification is not a graph kind".into());
    }
    options.node_kinds.sort(); options.node_kinds.dedup();
    if options.depth.is_some_and(|depth| !(1..=6).contains(&depth)) || (options.depth.is_some() && !matches!(options.operation, Operation::Traverse | Operation::Impact | Operation::Callers)) {
        return Err("depth is traverse/impact/callers-only and must be 1..6".into());
    }
    if options.test_only && options.operation != Operation::Search { return Err("testOnly is search-only".into()); }
    if options.operation == Operation::Impact {
        if options.files.is_empty() || options.files.len() > 128 { return Err("impact requires 1..128 current relative files".into()); }
        options.files.sort(); options.files.dedup();
    } else if !options.files.is_empty() { return Err("files is impact-only".into()); }
    // The wrapper owns numbered slicing of these arrays, not SQL offsets or
    // ranked continuation. Refuse mixed modes rather than silently ignoring them.
    for key in ["page", "limit", "cursor", "focus", "glob", "captureRanked", "resumeRanked", "retainRankedRender", "renderRanked", "rankedRenderAllowance", "analysisRelation"] {
        if arguments.get(key).is_some() { return Err(format!("analysisProjection does not accept {key}").into()); }
    }
    if arguments.get("output").is_some_and(|value| value != "ranked") || arguments.get("visibility").is_some_and(|value| value != "project") {
        return Err("analysisProjection is an admitted project query, not an audit".into());
    }
    if arguments["analysisRevision"] != "codeweave-pi.maintenance.1" { return Err("analysisProjection requires an indexed completed run".into()); }
    let query = if options.operation == Operation::Impact { "current-file impact" }
        else { arguments["query"].as_str().filter(|query| !query.trim().is_empty() && query.len() <= 4096).ok_or("query must be nonempty and bounded")? };
    let database = arguments["analysisDatabase"].as_str().ok_or("analysisDatabase is required")?;
    let expected = arguments.get("analysisRunId").map(|value| value.as_str().ok_or("analysisRunId must be a string")).transpose()?.unwrap_or("");
    let scope = match arguments.get("scope") {
        None => context.root.clone(),
        Some(value) => {
            let path = Path::new(value.as_str().ok_or("scope must be a path")?);
            if path.is_absolute() { path.to_path_buf() } else { context.root.join(path) }
        }
    }.canonicalize()?;
    let local = scope.strip_prefix(&context.root)?.to_str().ok_or("non-UTF8 scope")?;
    let sources = Arc::new(OperationSources::from_arguments(arguments, &context.root)?);
    let validated = open_indexed(expected, arguments, Path::new(database), context, sources.clone())?;
    let mut coverage = Coverage::default();
    let mut semantic = Value::Null;
    let mut candidates = Vec::new();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut roots = Vec::new();
    let mut unseeded_files = Vec::new();
    let status;
    if options.operation == Operation::Search {
        nodes = search(query, &options, arguments, &scope, local, &validated, context, sources.clone(), &mut coverage, &mut semantic)?;
        status = if nodes.is_empty() { "not_found" } else { "ok" };
    } else if options.operation == Operation::Impact {
        let seeds = file_seeds(&options, local, &validated, context, &sources, &mut coverage, &mut unseeded_files)?;
        roots = seeds.iter().map(|seed| seed.id.clone()).collect();
        status = if seeds.is_empty() { "incomplete" } else { "ok" };
        nodes = walk(seeds, &options, local, &validated, context, &mut coverage)?;
        if !nodes.is_empty() { edges = induced_edges(&nodes, &options, &validated, context, &mut coverage)?; }
    } else {
        let (seeds, exhaustive) = seeds(query, &options, arguments, local, &validated, context, &mut coverage)?;
        if seeds.len() != 1 || !exhaustive {
            status = if seeds.len() > 1 { "ambiguous" } else if !exhaustive { "incomplete" } else { "not_found" };
            candidates = seeds.into_iter().map(|node| ProjectedNode::new(node, 0)).collect();
        } else {
            status = "ok";
            let seed = seeds.into_iter().next().unwrap();
            roots.push(seed.id.clone());
            nodes = walk(vec![seed], &options, local, &validated, context, &mut coverage)?;
            edges = induced_edges(&nodes, &options, &validated, context, &mut coverage)?;
        }
    }
    sources.validate_admission(arguments, &context.root)?;
    sources.validate_retained(context)?;
    validated.validate_indexed_run()?;
    context.check()?;
    let complete = coverage.reasons.is_empty();
    let mut analysis = validated.metadata(json!({}));
    // This collection has no native continuation; numbered pages carry run
    // labels. A changed label requires a restart, not a stateful wrapper pin.
    analysis["continuationStatus"] = json!("wrapper-numbered-pages");
    if !semantic.is_null() {
        analysis["semanticStatus"] = semantic["status"].clone();
        analysis["semantic"] = semantic;
    }
    let source_claims = nodes.iter().chain(candidates.iter()).map(|row| row.node.file.as_str())
        .collect::<BTreeSet<_>>().into_iter().map(|file| {
            let text = sources.retained_text(&context.root.join(file)).ok_or("returned node has no captured source version")?;
            Ok(json!({"path":file,"raw_digest":format!("{:x}", Sha256::digest(text.as_bytes()))}))
        }).collect::<Result<Vec<Value>>>()?;
    let data = json!({"mode":"analysis_projection", "query":query, "scope":scope,
        "operation":arguments["analysisProjection"]["operation"], "status":status,
        "roots":roots, "candidates":candidates, "nodes":nodes, "edges":edges, "analysis":analysis,
        "source_claims":source_claims,
        "coverage":{"complete":complete,"reasons":coverage.reasons,"nodeLimit":NODE_LIMIT,"edgeLimit":EDGE_LIMIT,
            "scanLimit":SCAN_LIMIT,"recordByteLimit":BYTE_LIMIT,"transportByteLimit":TRANSPORT_LIMIT,"depth":if options.operation == Operation::Search { 0 } else { options.depth() },
            "meaning":"bounded indexed selection only; not current binding, whole-project completeness, or absence proof"},
        "selection":{"testOnly":options.test_only,"testMeaning":"path naming heuristic only; not a Test kind, execution, assertion, or coverage proof",
            "files":options.files,"unseededFiles":unseeded_files,
            "impactMeaning":"reverse indexed relationships from declarations in current files; not changed-line precision, runtime impact, or risk scoring"},
        "positionEncoding":{"lineBase":1,"columnBase":0,"columnUnit":"UTF-16","nodeEndExclusive":true}});
    let output = fit_transport(data, context)?;
    sources.validate_retained(context)?;
    validated.validate_indexed_run()?;
    context.check()?;
    Ok(output)
}

fn fit_transport(mut data: Value, context: &OperationContext) -> Result<ToolOutput> {
    loop {
        context.check()?;
        let files = data["nodes"].as_array().unwrap().iter().chain(data["candidates"].as_array().unwrap())
            .filter_map(|row| row["filePath"].as_str().map(str::to_owned)).collect::<HashSet<_>>();
        data["source_claims"].as_array_mut().unwrap().retain(|claim| claim["path"].as_str().is_some_and(|file| files.contains(file)));
        let count = |key: &str| data[key].as_array().unwrap().len();
        let (nodes, edges, candidates) = (count("nodes"), count("edges"), count("candidates"));
        let returned = nodes + edges + candidates;
        let text = format!("Indexed {} projection: {nodes} nodes, {edges} edges, {candidates} candidates ({}).", data["operation"].as_str().unwrap(), data["status"].as_str().unwrap());
        let capped = data["coverage"]["reasons"].as_array().unwrap().iter().any(|reason| reason.as_str().is_some_and(|reason| reason.ends_with("_cap")));
        let mut output = if data["coverage"]["complete"] == true { ToolOutput::complete("pi_nav_search", text, data, returned, returned) }
            else { ToolOutput::incomplete("pi_nav_search", text, data, returned,
                if capped { IncompleteReason::CandidateCap } else { IncompleteReason::Error },
                vec!["Projection coverage is incomplete; inspect data.coverage.reasons".into()]) };
        // Include conservative framing allowance, not just the selected records.
        let size = serde_json::to_vec(&output.structured)?.len() + serde_json::to_vec(&output.text)?.len() + 1024;
        if size <= TRANSPORT_LIMIT { return Ok(output); }
        data = output.structured["data"].take();
        // Remove a coherent tail batch before serializing again; reserializing
        // the whole envelope after every dropped row is quadratic in payload size.
        let mut removed_bytes = 0;
        while removed_bytes < size - TRANSPORT_LIMIT {
            context.check()?;
            let nodes = data["nodes"].as_array().unwrap().len();
            let edges = data["edges"].as_array().unwrap().len();
            // A BFS/search suffix and its incident edges go together. Dense
            // parallel relationships retain both endpoints and lose edge tails.
            let removed = if nodes > 2 || (nodes > 0 && edges == 0) {
                let removed = data["nodes"].as_array_mut().unwrap().pop().unwrap();
                let edges = std::mem::take(data["edges"].as_array_mut().unwrap());
                for edge in edges {
                    if edge["source"] == removed["id"] || edge["target"] == removed["id"] { removed_bytes += serde_json::to_vec(&edge)?.len(); }
                    else { data["edges"].as_array_mut().unwrap().push(edge); }
                }
                data["roots"].as_array_mut().unwrap().retain(|root| root != &removed["id"]);
                removed
            } else if edges > 0 { data["edges"].as_array_mut().unwrap().pop().unwrap() }
            else if let Some(candidate) = data["candidates"].as_array_mut().unwrap().pop() { candidate }
            else { return Err("projection metadata exceeds the native transport bound".into()); };
            removed_bytes += serde_json::to_vec(&removed)?.len();
        }
        if data["operation"] == "impact" {
            let root_ids = data["roots"].as_array().unwrap().iter().filter_map(Value::as_str).collect::<HashSet<_>>();
            let seeded_files = data["nodes"].as_array().unwrap().iter().filter(|node| node["id"].as_str().is_some_and(|id| root_ids.contains(id)))
                .filter_map(|node| node["filePath"].as_str()).collect::<HashSet<_>>();
            let unseeded = data["selection"]["files"].as_array().unwrap().iter().filter(|file| !seeded_files.contains(file.as_str().unwrap())).cloned().collect::<Vec<_>>();
            data["selection"]["unseededFiles"] = json!(unseeded);
        }
        data["coverage"]["complete"] = json!(false);
        let reasons = data["coverage"]["reasons"].as_array_mut().unwrap();
        if !reasons.contains(&json!("projection_byte_cap")) { reasons.push(json!("projection_byte_cap")); }
        if data["nodes"].as_array().unwrap().is_empty() && data["candidates"].as_array().unwrap().is_empty() { data["status"] = json!("incomplete"); }
    }
}

fn scoped(file: &str, scope: &str) -> bool {
    scope.is_empty() || file == scope || file.strip_prefix(scope).is_some_and(|suffix| suffix.starts_with('/'))
}
fn nodes_sql() -> String {
    format!("SELECT {COLUMNS} FROM nodes WHERE (?1='' OR file_path=?1 OR substr(file_path,1,length(?1)+1)=?1||'/') AND (?2='[]' OR kind IN (SELECT value FROM json_each(?2))) ORDER BY file_path,start_line,start_column,id LIMIT {}", SCAN_LIMIT + 1)
}
fn seeds(query: &str, options: &Options, arguments: &Value, scope: &str, validated: &ValidatedAnalysis,
    context: &OperationContext, coverage: &mut Coverage) -> Result<(Vec<Node>, bool)> {
    use grep_matcher::Matcher;
    let case = arguments.get("case").and_then(Value::as_str).unwrap_or("smart");
    if !matches!(case, "smart" | "sensitive" | "insensitive") { return Err("invalid case mode".into()); }
    let sensitive = case == "sensitive" || (case == "smart" && query.chars().any(char::is_uppercase));
    let query = query.strip_prefix(&format!("{}/", context.root.display())).unwrap_or(query);
    let (file, lookup) = match query.split_once("::") {
        Some((file, lookup)) if validated.contains_file(file)? => (file, lookup),
        _ => ("", query),
    };
    let matcher = grep_regex::RegexMatcher::new(&format!("{}^{}$", if sensitive { "" } else { "(?i)" }, regex_syntax::escape(&lookup.replace("::", "."))))?;
    // IDs and exact File identities win over a coincidental display-name match.
    let exact_id: bool = validated.connection.query_row("SELECT EXISTS(SELECT 1 FROM nodes WHERE id=?1)", [query], |row| row.get(0))?;
    let exact_file = !exact_id && validated.contains_file(query)?;
    let mode = if exact_id { 1 } else if exact_file { 2 } else if sensitive { 3 } else { 0 };
    // Exact lookups must not depend on where the owner falls in a corpus scan.
    // Case-insensitive matching retains the shared Unicode regex semantics.
    let sql = format!("SELECT {COLUMNS} FROM nodes WHERE
        (?1='' OR file_path=?1 OR substr(file_path,1,length(?1)+1)=?1||'/')
        AND (?2='[]' OR kind IN (SELECT value FROM json_each(?2)))
        AND (?3=0 OR (?3=1 AND id=?4) OR (?3=2 AND kind='file' AND file_path=?4)
            OR (?3=3 AND (name=?6 OR qualified_name=?4 OR qualified_name=?6 OR replace(qualified_name,'::','.')=?7)))
        AND (?5='' OR file_path=?5) ORDER BY file_path,start_line,start_column,id LIMIT {}", SCAN_LIMIT + 1);
    let mut statement = validated.connection.prepare(&sql)?;
    let mut seeds = Vec::new();
    let mut exhaustive = true;
    for (index, candidate) in statement.query_map(rusqlite::params![scope, serde_json::to_string(&options.node_kinds)?, mode, query, file, lookup, lookup.replace("::", ".")], node)?.enumerate() {
        context.check()?;
        if index == SCAN_LIMIT { coverage.reasons.insert("seed_scan_cap"); exhaustive = false; break; }
        let candidate = candidate?;
        let selected = if exact_id { candidate.id == query }
            else if exact_file { candidate.kind == "file" && candidate.file == query }
            else { (file.is_empty() || candidate.file == file) && (matcher.is_match(candidate.name.as_bytes())?
                || matcher.is_match(candidate.qualified.replace("::", ".").as_bytes())?
                || candidate.qualified == query) };
        if !selected { continue; }
        if seeds.len() == NODE_LIMIT { coverage.reasons.insert("candidate_cap"); exhaustive = false; break; }
        validated.content_for(&candidate)?;
        if !coverage.reserve(&ProjectedNode::new(candidate.clone(), 0))? { exhaustive = false; break; }
        seeds.push(candidate);
    }
    Ok((seeds, exhaustive))
}

fn file_seeds(options: &Options, scope: &str, validated: &ValidatedAnalysis,
    context: &OperationContext, sources: &OperationSources, coverage: &mut Coverage,
    unseeded: &mut Vec<String>) -> Result<Vec<Node>> {
    let admission = sources.admission.as_ref().ok_or("impact requires corpus admission")?;
    if options.files.iter().map(String::len).sum::<usize>() > 16 * 1024 {
        return Err("impact file identities exceed input bound".into());
    }
    // Check every requested path before reading any requested source. No deleted
    // or comparison-only identities may acquire current graph coordinates.
    for file in &options.files {
        if !indexed_relative_path(file) || !scoped(file, scope) || !admission.files.contains(Path::new(file)) {
            return Err("impact files must be admitted current relative paths within scope".into());
        }
    }
    let mut bytes = 0u64;
    for file in &options.files {
        context.check()?;
        let path = context.root.join(file);
        bytes = bytes.checked_add(std::fs::metadata(&path)?.len()).ok_or("impact source byte bound")?;
        if bytes > CAPTURE_BYTES { return Err("impact selected files exceed source byte bound".into()); }
        sources.read_text(&path)?;
    }
    let sql = format!("SELECT {COLUMNS} FROM nodes WHERE file_path IN (SELECT value FROM json_each(?1))
        AND (?2='[]' OR kind IN (SELECT value FROM json_each(?2))) ORDER BY file_path,start_line,start_column,id LIMIT {}", SCAN_LIMIT + 1);
    let mut statement = validated.connection.prepare(&sql)?;
    let mut seeds = Vec::new();
    let mut seeded_files = HashSet::new();
    for (index, candidate) in statement.query_map(rusqlite::params![serde_json::to_string(&options.files)?, serde_json::to_string(&options.node_kinds)?], node)?.enumerate() {
        context.check()?;
        if index == SCAN_LIMIT { coverage.reasons.insert("seed_scan_cap"); break; }
        if seeds.len() == NODE_LIMIT { coverage.reasons.insert("node_cap"); break; }
        let candidate = candidate?;
        validated.content_for(&candidate)?;
        if !coverage.reserve(&ProjectedNode::new(candidate.clone(), 0))? { break; }
        seeded_files.insert(candidate.file.clone());
        seeds.push(candidate);
    }
    unseeded.extend(options.files.iter().filter(|file| !seeded_files.contains(*file)).cloned());
    if !unseeded.is_empty() { coverage.reasons.insert("unseeded_files"); }
    Ok(seeds)
}

fn search(query: &str, options: &Options, arguments: &Value, scope: &Path, local: &str, validated: &ValidatedAnalysis,
    context: &OperationContext, sources: Arc<OperationSources>, coverage: &mut Coverage, semantic: &mut Value) -> Result<Vec<ProjectedNode>> {
    // File lookup is a path lookup, not a new relevance score. All declaration
    // discovery uses the same lexical collection and semantic fusion as Grep.
    let file_lookup = options.node_kinds == ["file"];
    let mut ranks = HashMap::new();
    let mut graph_ranks = HashMap::new();
    if !file_lookup {
        let mut fuzzy = if options.test_only {
            super::super::fuzzy::search_test_files(query, scope, sources, context)?
        } else { super::super::fuzzy::search(query, scope, &[], crate::walk::Visibility::Project, sources, context)? };
        if !fuzzy.complete { coverage.reasons.insert("lexical_candidate_cap"); }
        if options.test_only {
            coverage.reasons.insert("semantic_unavailable");
            *semantic = json!({"status":"unavailable","reason":"indexed semantics excludes test paths; testOnly uses lexical discovery"});
        } else {
            match semantic_candidates_in_snapshot(query, arguments, scope, context, validated) {
                Ok((matches, metadata)) => {
                    if metadata["complete"] != true { coverage.reasons.insert("semantic_coverage"); }
                    super::super::fuzzy::fuse_semantic(&mut fuzzy, matches);
                    *semantic = metadata;
                }
                Err(error) => { coverage.reasons.insert("semantic_unavailable"); *semantic = json!({"status":"unavailable","reason":error.to_string()}); }
            }
        }
        for (rank, matched) in fuzzy.result.matches.iter().filter(|matched| matched.is_definition).enumerate() {
            if let Some(id) = matched.graph_node_id() { graph_ranks.insert(id.to_owned(), rank); }
            if let Some((start, end, kind)) = matched.syntax_key() {
                ranks.insert((matched.path.clone(), start, end, kind.to_owned()), rank);
            }
        }
    }
    let ranked_files = ranks.keys().map(|(path, _, _, _)| path.clone()).collect::<HashSet<_>>();
    let mut statement = validated.connection.prepare(&nodes_sql())?;
    let mut selected = Vec::new();
    for (index, candidate) in statement.query_map(rusqlite::params![local, serde_json::to_string(&options.node_kinds)?], node)?.enumerate() {
        context.check()?;
        if index == SCAN_LIMIT { coverage.reasons.insert("node_scan_cap"); break; }
        let candidate = candidate?;
        if options.test_only && !crate::types::is_test_file(Path::new(&candidate.file)) { continue; }
        let rank = if file_lookup {
            candidate.file.to_lowercase().contains(&query.to_lowercase()).then_some(0)
        } else if let Some(rank) = graph_ranks.get(&candidate.id) { Some(*rank) }
        else if ranked_files.contains(&context.root.join(&candidate.file)) {
            validated.syntax_identity(&candidate)?.and_then(|identity| ranks.get(&(context.root.join(&candidate.file), identity.bytes.start, identity.bytes.end, identity.syntax_kind)).copied())
        } else { None };
        if let Some(rank) = rank { selected.push((rank, candidate)); }
    }
    selected.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.file.cmp(&b.1.file)).then(a.1.start.cmp(&b.1.start)).then(a.1.id.cmp(&b.1.id)));
    let mut nodes = Vec::new();
    for (_, candidate) in selected {
        if nodes.len() == NODE_LIMIT { coverage.reasons.insert("node_cap"); break; }
        validated.content_for(&candidate)?;
        let projected = ProjectedNode::new(candidate, 0);
        if !coverage.reserve(&projected)? { break; }
        nodes.push(projected);
    }
    Ok(nodes)
}

fn walk(seeds: Vec<Node>, options: &Options, scope: &str, validated: &ValidatedAnalysis,
    context: &OperationContext, coverage: &mut Coverage) -> Result<Vec<ProjectedNode>> {
    let mut enqueued = seeds.iter().map(|seed| seed.id.clone()).collect::<HashSet<_>>();
    let mut nodes = seeds.into_iter().map(|seed| ProjectedNode::new(seed, 0)).collect::<Vec<_>>();
    let mut queue = (0..nodes.len()).collect::<VecDeque<_>>();
    let depth = options.depth();
    let predicate = match options.operation { Operation::Callers | Operation::Impact => "e.target=?1", Operation::Callees => "e.source=?1", _ => "(e.source=?1 OR e.target=?1)" };
    let filter = if options.relation() { INCIDENT_FILTER } else { "1" };
    let columns = COLUMNS.split(',').map(|name| format!("n.{name}")).collect::<Vec<_>>().join(",");
    let sql = format!("SELECT {columns} FROM edges e JOIN nodes n ON n.id=CASE WHEN e.source=?1 THEN e.target ELSE e.source END WHERE {predicate} AND {filter} ORDER BY CASE e.kind WHEN 'contains' THEN 0 WHEN 'calls' THEN 1 ELSE 2 END,n.file_path,n.start_line,n.start_column,n.id,e.id LIMIT {}", SCAN_LIMIT + 1);
    let mut visits = 0;
    while let Some(index) = queue.pop_front() {
        context.check()?;
        let next_depth = nodes[index].depth + 1;
        if next_depth > depth { continue; }
        let mut statement = validated.connection.prepare(&sql)?;
        for candidate in statement.query_map([&nodes[index].node.id], node)? {
            context.check()?;
            if visits == SCAN_LIMIT { coverage.reasons.insert("adjacency_scan_cap"); return Ok(nodes); }
            visits += 1;
            let candidate = candidate?;
            if enqueued.contains(&candidate.id) || !scoped(&candidate.file, scope) || !options.accepts(&candidate) { continue; }
            if nodes.len() == NODE_LIMIT { coverage.reasons.insert("node_cap"); continue; }
            validated.content_for(&candidate)?;
            let projected = ProjectedNode::new(candidate, next_depth);
            if !coverage.reserve(&projected)? { return Ok(nodes); }
            enqueued.insert(projected.node.id.clone());
            queue.push_back(nodes.len());
            nodes.push(projected);
        }
    }
    Ok(nodes)
}

fn induced_edges(nodes: &[ProjectedNode], options: &Options, validated: &ValidatedAnalysis,
    context: &OperationContext, coverage: &mut Coverage) -> Result<Vec<Edge>> {
    let ids = serde_json::to_string(&nodes.iter().map(|node| &node.node.id).collect::<Vec<_>>())?;
    // Multi-hop callers retain incoming call evidence into every expanded node,
    // not just the root. The unexpanded frontier supplies no additional hops.
    let relation_target = if options.operation == Operation::Callers {
        serde_json::to_string(&nodes.iter().filter(|node| node.depth < options.depth()).map(|node| &node.node.id).collect::<Vec<_>>())?
    } else { nodes[0].node.id.clone() };
    let predicate = match options.operation { Operation::Callers => "e.target IN (SELECT value FROM json_each(?2))", Operation::Callees => "e.source=?2", _ => "1" };
    let filter = if options.relation() { INCIDENT_FILTER } else { "1" };
    // Separate induced selection includes frontier-to-frontier edges. Edge IDs
    // preserve parallel occurrences; traversing both endpoints cannot duplicate.
    let sql = format!("SELECT e.id,e.source,e.target,e.kind,e.line,e.col,COALESCE(e.kind='references' AND (json_type(e.metadata,'$.fnRef')='true' OR json_extract(e.metadata,'$.refKind')='function_ref'),0) FROM edges e WHERE e.source IN (SELECT value FROM json_each(?1)) AND e.target IN (SELECT value FROM json_each(?1)) AND {predicate} AND {filter} ORDER BY e.source,e.target,e.kind,e.line,e.col,e.id LIMIT {}", EDGE_LIMIT + 1);
    let mut statement = validated.connection.prepare(&sql)?;
    let mut rows = if options.relation() { statement.query(rusqlite::params![ids, relation_target])? }
        else { statement.query([ids])? };
    let mut edges = Vec::new();
    while let Some(row) = rows.next()? {
        context.check()?;
        if edges.len() == EDGE_LIMIT { coverage.reasons.insert("edge_cap"); break; }
        let mut edge = Edge { id:row.get(0)?, source:row.get(1)?, target:row.get(2)?, kind:row.get(3)?, line:row.get(4)?, column:row.get(5)?, function_reference:row.get(6)? };
        if !EDGE_KINDS.contains(&edge.kind.as_str()) { return Err("unsupported indexed edge kind".into()); }
        let owner = &nodes.iter().find(|node| node.node.id == edge.source).ok_or("induced edge has no source")?.node;
        let (_, text) = validated.content_for(owner)?;
        let valid = edge.line.zip(edge.column).is_some_and(|(line, column)| line.checked_sub(1).and_then(|line| text.lines().nth(line as usize)).is_some_and(|line| valid_column(line, column, false)));
        if !valid { edge.line = None; edge.column = None; }
        if !coverage.reserve(&edge)? { break; }
        edges.push(edge);
    }
    Ok(edges)
}
