//! Read-only graph projection with independent source validation.
//! G1 retains its capture contract; indexed-run loading uses selected
//! admitted source only. Neither path indexes, repairs or acquires model assets.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    callees::DeclarationCandidate,
    callers::CallerMatch,
    lanes::{LaneBundle, SymbolLanes},
    OperationSources,
};
use crate::dispatch::OperationContext;
use crate::types::{FacetTotals, Match, SearchResult};

pub(crate) mod projection;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const CAPTURE_BYTES: u64 = 8 * 1024 * 1024;
const CONNECTION_LIMIT: usize = 1000;

// Only these candidate-local failures may be omitted by indexed semantics.
// Admission, status, SQL integrity and source I/O failures remain hard errors.
#[derive(Debug)]
enum IndexedSourceOmission { Stale, ByteBound }
impl std::fmt::Display for IndexedSourceOmission {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Stale => "indexed source changed; stored coordinates withheld",
            Self::ByteBound => "selected indexed sources exceed byte bound",
        })
    }
}
impl std::error::Error for IndexedSourceOmission {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capture {
    root: PathBuf,
    generation: u64,
    kernel_version: String,
    interpretation_revision: String,
    capture_digest: String,
    #[serde(default)]
    policy_digest: Option<String>,
    #[serde(default)]
    corpus: Option<String>,
    #[serde(default)]
    semantic: Option<Value>,
    sources: Vec<CapturedFile>,
}
#[derive(Deserialize)]
struct CapturedFile {
    path: String,
    language: Option<String>,
    digest: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    id: String,
    kind: String,
    name: String,
    #[serde(rename = "qualifiedName")]
    qualified: String,
    #[serde(rename = "filePath")]
    file: String,
    #[serde(rename = "startLine")]
    start: u32,
    #[serde(rename = "endLine")]
    end: u32,
    start_column: u32,
    end_column: u32,
}
fn node(row: &Row<'_>) -> rusqlite::Result<Node> {
    Ok(Node {
        id: row.get(0)?,
        kind: row.get(1)?,
        name: row.get(2)?,
        qualified: row.get(3)?,
        file: row.get(4)?,
        start: row.get(5)?,
        end: row.get(6)?,
        start_column: row.get(7)?,
        end_column: row.get(8)?,
    })
}

// Producer columns are zero-based UTF-16 positions, not bytes or scalar counts.
// Ordinary carrier starts must point to a character; declaration ends may be EOL.
fn valid_column(line: &str, column: u32, allow_end: bool) -> bool {
    let mut offset = 0;
    for character in line.chars() {
        if offset == column {
            return true;
        }
        offset += character.len_utf16() as u32;
    }
    allow_end && offset == column
}

fn validate_span(node: &Node, text: &str) -> Result<()> {
    let lines = text.lines().collect::<Vec<_>>();
    let position_valid = |line: u32, column: u32| {
        line.checked_sub(1)
            .and_then(|index| lines.get(index as usize))
            .is_some_and(|text| valid_column(text, column, true))
            || (node.kind == "file" && line as usize == lines.len() + 1 && column == 0)
    };
    let start = (node.start, node.start_column);
    let end = (node.end, node.end_column);
    if !position_valid(start.0, start.1)
        || !position_valid(end.0, end.1)
        || start > end
        || (start == end && node.kind != "file")
    {
        return Err("graph node span is outside its source version".into());
    }
    Ok(())
}

struct IncidentEdge {
    opposite: Node,
    id: i64,
    source: String,
    target: String,
    kind: String,
    line: Option<u32>,
    column: Option<u32>,
    metadata: Option<String>,
    provenance: Option<String>,
}

pub(crate) struct PreparedSearch {
    pub result: SearchResult,
    pub lanes: LaneBundle,
    pub metadata: Value,
}

pub(crate) fn load(
    query: &str,
    sensitive: bool,
    expected_revision: &str,
    arguments: &Value,
    scope: &Path,
    database: &Path,
    context: &OperationContext,
    sources: Arc<OperationSources>,
) -> std::result::Result<Option<PreparedSearch>, String> {
    load_capture(
        query,
        sensitive,
        expected_revision,
        arguments,
        scope,
        database,
        context,
        sources,
        None,
    )
    .map_err(|error| format!("prepared analysis unavailable: {error}"))
}

pub(crate) fn load_for_live(
    query: &str,
    sensitive: bool,
    expected_revision: &str,
    arguments: &Value,
    scope: &Path,
    database: &Path,
    context: &OperationContext,
    sources: Arc<OperationSources>,
    live: &SearchResult,
) -> std::result::Result<Option<PreparedSearch>, String> {
    load_capture(
        query,
        sensitive,
        expected_revision,
        arguments,
        scope,
        database,
        context,
        sources,
        Some(live),
    )
    .map_err(|error| format!("prepared analysis unavailable: {error}"))
}
// Producer positions are UTF-16; navigation identities are half-open UTF-8 bytes.
pub(crate) fn byte_at(text: &str, line: u32, column: u32) -> Result<usize> {
    let index = line.checked_sub(1).ok_or("invalid source line")? as usize;
    let mut start = 0;
    for (row, raw) in text.split_inclusive('\n').enumerate() {
        if row == index {
            let source = raw
                .trim_end_matches('\n')
                .strip_suffix('\r')
                .unwrap_or(raw.trim_end_matches('\n'));
            let mut utf16 = 0;
            for (offset, character) in source.char_indices() {
                if utf16 == column {
                    return Ok(start + offset);
                }
                utf16 += character.len_utf16() as u32;
            }
            if utf16 == column {
                return Ok(start + source.len());
            }
            return Err("column is not a UTF-16 character boundary".into());
        }
        start += raw.len();
    }
    if index == text.lines().count() && column == 0 && (text.is_empty() || text.ends_with('\n')) {
        return Ok(text.len());
    }
    Err("line is outside captured source".into())
}

impl ValidatedAnalysis {
    fn validate_indexed_run(&self) -> Result<()> {
        if let AnalysisIdentity::Indexed(run) = &self.identity { run.validate()?; }
        Ok(())
    }
    fn content_for(&self, node: &Node) -> Result<(PathBuf, Arc<String>)> {
        if let AnalysisIdentity::Indexed(run) = &self.identity {
            run.validate()?;
            let relative = Path::new(&node.file);
            if node.file.is_empty() || node.file.contains('\\')
                || !relative.components().all(|part| matches!(part, Component::Normal(_))) {
                return Err("invalid indexed source path".into());
            }
            let path = run.root.join(relative);
            let retained_bytes: u64 = self.contents.borrow().iter()
                .filter(|(file, _)| *file != &node.file)
                .map(|(_, (_, text))| text.len() as u64).sum();
            if std::fs::metadata(&path)?.len() > CAPTURE_BYTES.saturating_sub(retained_bytes) {
                return Err(IndexedSourceOmission::ByteBound.into());
            }
            // Admission must run even before a cache hit. Matching bytes bind
            // coordinates, not the current truth of the stored relationship.
            let text = run.sources.read_text(&path)?;
            if let Some((_, previous)) = self.contents.borrow().get(&node.file) {
                if Arc::ptr_eq(previous, &text) {
                    validate_span(node, &text)?;
                    return Ok((path, text));
                }
            }
            let (digest, has_diagnostics): (String, bool) = self.connection.query_row(
                "SELECT content_hash,errors IS NOT NULL AND errors!='[]' FROM files WHERE path=?1", [&node.file],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if format!("{:x}", Sha256::digest(text.as_bytes())) != digest {
                return Err(IndexedSourceOmission::Stale.into());
            }
            validate_span(node, &text)?;
            if has_diagnostics {
                self.extraction_diagnostics.borrow_mut().push(json!({"filePath":node.file,
                    "status":"indexed extraction diagnostics present; free text withheld"}));
            }
            self.contents.borrow_mut().insert(node.file.clone(), (path.clone(), text.clone()));
            return Ok((path, text));
        }
        let contents = self.contents.borrow();
        let (path, text) = contents.get(&node.file)
            .ok_or("graph node is outside captured source")?;
        validate_span(node, text)?;
        Ok((path.clone(), text.clone()))
    }

    fn capture(&self) -> Result<&Capture> {
        match &self.identity {
            AnalysisIdentity::Captured(capture) => Ok(capture),
            AnalysisIdentity::Indexed(_) => Err("indexed semantic retrieval is unavailable".into()),
        }
    }

    fn metadata(&self, mut metadata: Value) -> Value {
        let object = metadata.as_object_mut().expect("projection metadata is an object");
        match &self.identity {
            AnalysisIdentity::Captured(capture) => {
                object.extend(serde_json::Map::from_iter([
                    ("generation".into(), json!(capture.generation)),
                    ("captureDigest".into(), json!(capture.capture_digest)),
                    ("interpretationRevision".into(), json!(capture.interpretation_revision)),
                    ("policyDigest".into(), json!(capture.policy_digest)),
                ]));
            }
            AnalysisIdentity::Indexed(run) => {
                object.remove("capturedFiles");
                object.insert("indexedRunId".into(), json!(run.status.record.run_id));
                object.insert("indexedRunCounts".into(), json!(run.status.record.counts));
                object.insert("interpretationRevision".into(), json!(run.status.record.format));
                object.insert("policyDigest".into(), json!(run.status.record.policy_digest));
                object.insert("corpusDigest".into(), json!(run.status.record.corpus_digest));
                object.insert("indexedStatusDigest".into(), json!(run.status.pin_digest()));
                object.insert("scope".into(), json!("best-effort indexed relationships; selected source independently verified; not current relationship or absence proof"));
                object.insert("semanticStatus".into(), json!("unavailable"));
                object.insert("continuationStatus".into(), json!("retained-evidence-only"));
                object.remove("nextPage");
            }
        }
        metadata
    }

    fn contains_file(&self, file: &str) -> Result<bool> {
        match &self.identity {
            AnalysisIdentity::Captured(_) => Ok(self.contents.borrow().contains_key(file)),
            AnalysisIdentity::Indexed(run) => {
                run.validate()?;
                let admission = run.sources.admission.as_ref().ok_or("indexed source admission is required")?;
                admission.validate()?;
                if !admission.files.contains(Path::new(file)) { return Ok(false); }
                Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM files WHERE path=?1)", [file], |row| row.get(0))?)
            }
        }
    }

    fn source_facts(&self, node: &Node) -> Result<Arc<CapturedSource>> {
        let (path, text) = self.content_for(node)?;
        if let Some(source) = self.source_facts.borrow().get(&node.file) {
            return Ok(source.clone());
        }
        let mut declarations = Vec::new();
        let mut sites = Vec::new();
        let mut excluded_tests = Vec::new();
        let mut syntax_tree = None;
        if let crate::types::FileType::Code(lang) = crate::lang::detect_file_type(&path) {
            if let Some(language) = crate::lang::outline::outline_language(lang) {
                let mut parser = tree_sitter::Parser::new();
                parser.set_language(&language)?;
                if let Some(tree) = parser.parse(text.as_str(), None) {
                    if super::declarations::supports(lang) {
                        let facts = Arc::new(crate::tsjs_source::collect(tree.root_node(), &text));
                        let lines = text.lines().collect::<Vec<_>>();
                        for reference in &facts.references {
                            let Some(mut expression) = tree.root_node().descendant_for_byte_range(
                                reference.expression.start,
                                reference.expression.end.saturating_sub(1),
                            ) else {
                                continue;
                            };
                            while expression.byte_range() != reference.expression
                                || expression.kind() != reference.syntax_kind
                            {
                                let Some(parent) = expression.parent() else {
                                    break;
                                };
                                expression = parent;
                            }
                            if expression.byte_range() != reference.expression
                                || expression.kind() != reference.syntax_kind
                            {
                                continue;
                            }
                            if let Some(target) = expression
                                .child_by_field_name("function")
                                .or_else(|| expression.child_by_field_name("constructor"))
                            {
                                sites.push(super::callee_query::CallSite::capture(
                                    expression, target, &text, &lines, lang,
                                ));
                            }
                        }
                        declarations = super::declarations::from_facts(facts);
                    } else {
                        excluded_tests = super::fuzzy::excluded_test_spans(tree.root_node(), &text, lang);
                        sites =
                            super::callees::call_sites(tree.root_node(), &language, lang, &text);
                    }
                    syntax_tree = Some(tree);
                }
            }
        }
        let facts = Arc::new(CapturedSource {
            excluded_tests,
            syntax_tree,
            declarations,
            sites,
        });
        self.source_facts
            .borrow_mut()
            .insert(node.file.clone(), facts.clone());
        Ok(facts)
    }

    fn declaration(&self, node: &Node) -> Result<Option<super::declarations::Declaration>> {
        let (_, text) = self.content_for(node)?;
        if matches!(node.kind.as_str(), "file" | "import") {
            return Ok(None);
        }
        let span = byte_at(&text, node.start, node.start_column)?
            ..byte_at(&text, node.end, node.end_column)?;
        let facts = self.source_facts(node)?;
        let mut matches = facts
            .declarations
            .iter()
            .filter(|declaration| declaration.region().id.bytes == span);
        let first = matches.next().cloned();
        // Legal coordinates or a nearby declaration are not an association.
        Ok(if matches.next().is_none() {
            first
        } else {
            None
        })
    }

    fn syntax_identity(&self, node: &Node) -> Result<Option<crate::tsjs_source::Identity>> {
        if let Some(declaration) = self.declaration(node)? { return Ok(Some(declaration.region().id.clone())); }
        let (path, text) = self.content_for(node)?;
        let crate::types::FileType::Code(lang) = crate::lang::detect_file_type(&path) else { return Ok(None); };
        if super::declarations::supports(lang) { return Ok(None); }
        let source = self.source_facts(node)?;
        let Some(tree) = &source.syntax_tree else { return Ok(None); };
        let span = byte_at(&text, node.start, node.start_column)?..byte_at(&text, node.end, node.end_column)?;
        Ok(super::fuzzy::syntax_identity_at(tree.root_node(), &text, lang, span))
    }

    fn candidate(&self, node: &Node) -> Result<DeclarationCandidate> {
        let (file, text) = self.content_for(node)?;
        let declaration = self.declaration(node)?;
        Ok(DeclarationCandidate {
            name: node.qualified.clone(),
            file,
            start_line: node.start,
            end_line: node.end.min(text.lines().count() as u32),
            signature: declaration
                .as_ref()
                .map(|declaration| text[declaration.region().signature.clone()].to_string()),
            declaration,
        })
    }

    fn matched(&self, node: &Node) -> Result<Match> {
        let (path, text) = self.content_for(node)?;
        let mut matched = if let Some(declaration) = self.declaration(node)? {
            declaration.to_match(
                &path,
                &text,
                text.lines().count().try_into()?,
                std::fs::metadata(&path)?.modified()?,
            )
        } else {
            Match {
                path: path.clone(),
                line: node.start,
                text: text
                    .lines()
                    .nth(node.start as usize - 1)
                    .ok_or("missing declaration")?
                    .into(),
                is_definition: true,
                exact: true,
                file_lines: text.lines().count().try_into()?,
                mtime: std::fs::metadata(&path)?.modified()?,
                def_range: Some((node.start, node.end)),
                def_name: None,
                def_weight: 100,
                source_association: None,
                declaration: None,
                impl_target: None,
            }
        };
        if matched.declaration.is_none() {
            matched.def_name = Some(node.qualified.clone());
        }
        matched.source_association = Some(crate::types::SourceAssociation {
            syntax: self.syntax_identity(node)?, graph_node_id: Some(node.id.clone()),
        });
        Ok(matched)
    }

    fn site(
        &self,
        edge: &IncidentEdge,
        source: &Node,
    ) -> Result<Option<super::callee_query::CallSite>> {
        if !matches!(edge.kind.as_str(), "calls" | "instantiates") {
            return Ok(None);
        }
        let (Some(line), Some(column)) = (edge.line, edge.column) else {
            return Ok(None);
        };
        let (_, text) = self.content_for(source)?;
        let start = byte_at(&text, line, column)?;
        Ok(self
            .source_facts(source)?
            .sites
            .iter()
            .find(|site| site.expression.start == start)
            .cloned())
    }
}

fn source_identity(declaration: Option<&super::declarations::Declaration>) -> Value {
    declaration.map_or(Value::Null, |declaration| {
        let (start, end, kind) = declaration.key();
        json!({"startByte":start,"endByte":end,"syntaxKind":kind})
    })
}

const INCIDENT_FILTER: &str = "(e.kind='calls' OR (e.kind='references' AND (json_type(e.metadata,'$.fnRef')='true' OR json_extract(e.metadata,'$.refKind')='function_ref')))";
fn incident_filter(relation: Option<&str>) -> &'static str {
    if relation.is_some() {
        INCIDENT_FILTER
    } else {
        "e.kind IN ('calls','references','instantiates','imports','exports','extends','implements','overrides')"
    }
}
fn incident_predicate(relation: Option<&str>) -> &'static str {
    match relation {
        Some("callers") => "e.target=?1",
        Some("callees") => "e.source=?1",
        _ => "(e.source=?1 OR e.target=?1)",
    }
}
fn incident_edges(
    connection: &Connection,
    target: &str,
    relation: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<Vec<IncidentEdge>> {
    let sql = format!("SELECT n.id,n.kind,n.name,n.qualified_name,n.file_path,n.start_line,n.end_line,n.start_column,n.end_column,e.id,e.source,e.target,e.kind,e.line,e.col,e.metadata,e.provenance FROM edges e JOIN nodes n ON n.id=CASE WHEN e.source=?1 THEN e.target ELSE e.source END WHERE {} AND {} ORDER BY n.file_path,n.start_line,n.start_column,e.line,e.col,e.id LIMIT ?2 OFFSET ?3", incident_predicate(relation), incident_filter(relation));
    let mut statement = connection.prepare(&sql)?;
    let edges = statement
        .query_map(
            rusqlite::params![target, limit as i64, offset as i64],
            |row| {
                Ok(IncidentEdge {
                    opposite: node(row)?,
                    id: row.get(9)?,
                    source: row.get(10)?,
                    target: row.get(11)?,
                    kind: row.get(12)?,
                    line: row.get(13)?,
                    column: row.get(14)?,
                    metadata: row.get(15)?,
                    provenance: row.get(16)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(edges)
}
struct CapturedSource {
    syntax_tree: Option<tree_sitter::Tree>,
    excluded_tests: Vec<std::ops::Range<usize>>,
    declarations: Vec<super::declarations::Declaration>,
    sites: Vec<super::callee_query::CallSite>,
}

// Private completed-run binding; never parsed from ordinary tool arguments.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IndexedStatusRecord {
    format: String,
    kernel_version: String,
    state: String,
    run_id: String,
    root: PathBuf,
    root_dev: u64,
    root_ino: u64,
    directory_dev: u64,
    directory_ino: u64,
    database_dev: Option<u64>,
    database_ino: Option<u64>,
    policy_digest: String,
    corpus_digest: String,
    counts: HashMap<String, f64>,
}

#[derive(Debug, PartialEq)]
struct IndexedStatus {
    record: IndexedStatusRecord,
    identity: (u64, u64),
    digest: String,
}

impl IndexedStatus {
    fn pin_digest(&self) -> String {
        // Bind the complete producer record (including store identities) and the
        // status inode, not just its UUID. No graph reads are needed on resume.
        let mut hash = Sha256::new();
        hash.update(self.digest.as_bytes());
        hash.update(self.identity.0.to_le_bytes());
        hash.update(self.identity.1.to_le_bytes());
        format!("{:x}", hash.finalize())
    }
}

fn indexed_corpus_digest(sources: &OperationSources) -> Result<String> {
    let admission = sources.admission.as_ref().ok_or("indexed source admission is required")?;
    let mut files = admission.files.iter().map(|file| file.to_str().ok_or("non-UTF8 admission path"))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    files.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    let mut hash = Sha256::new();
    for file in files {
        if !indexed_relative_path(file) { return Err("invalid indexed admission path".into()); }
        hash.update(file.as_bytes());
        hash.update([0]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn indexed_relative_path(file: &str) -> bool {
    !file.is_empty() && !file.contains(['\\', '\0']) && !Path::new(file).is_absolute()
        && file.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

#[cfg(unix)]
fn indexed_file_identity(metadata: &std::fs::Metadata, private: bool, directory: bool) -> Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    if (directory && !metadata.is_dir()) || (!directory && (!metadata.is_file() || metadata.nlink() != 1))
        || private && (metadata.uid() != unsafe { libc::getuid() } || metadata.mode() & 0o077 != 0) {
        return Err("indexed storage must remain private, owned and without aliases".into());
    }
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn indexed_file_identity(_: &std::fs::Metadata, _: bool, _: bool) -> Result<(u64, u64)> {
    Err("indexed private storage validation is unavailable on this platform".into())
}

fn indexed_path_identity(path: &Path, private: bool, directory: bool) -> Result<(u64, u64)> {
    if !path.is_absolute() || path.canonicalize()? != path { return Err("indexed storage alias refused".into()); }
    indexed_file_identity(&std::fs::symlink_metadata(path)?, private, directory)
}

fn read_indexed_status(database: &Path, root: &Path, sources: &OperationSources) -> Result<IndexedStatus> {
    use std::io::Read;
    if !database.is_absolute() || database.starts_with(root) || database.file_name().and_then(|name| name.to_str()) != Some("graph.sqlite") {
        return Err("indexed database must be graph.sqlite outside source".into());
    }
    let directory = database.parent().ok_or("indexed directory missing")?;
    let directory_identity = indexed_path_identity(directory, true, true)?;
    let status_path = directory.join("maintenance-status.json");
    let identity = indexed_path_identity(&status_path, true, false)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(&status_path)?;
    let metadata = file.metadata()?;
    if indexed_file_identity(&metadata, true, false)? != identity || metadata.len() > 16 * 1024 {
        return Err("indexed status identity or size changed".into());
    }
    let mut bytes = Vec::new();
    file.take(16 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 1024 || indexed_path_identity(&status_path, true, false)? != identity {
        return Err("indexed status identity or size changed".into());
    }
    let record: IndexedStatusRecord = serde_json::from_slice(&bytes)?;
    let uuid = record.run_id.as_bytes();
    let uuid_valid = uuid.len() == 36 && uuid.iter().enumerate().all(|(i, byte)| {
        if [8, 13, 18, 23].contains(&i) { *byte == b'-' } else { byte.is_ascii_digit() || (b'a'..=b'f').contains(byte) }
    });
    let hex = |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    let counts = ["filesDiscovered", "filesIndexed", "filesSkipped", "filesErrored", "filesChecked", "filesAdded",
        "filesModified", "filesRemoved", "nodesCreated", "edgesCreated", "nodesUpdated", "durationMs"];
    if record.format != "codeweave-pi.maintenance.1" || record.kernel_version != "0.1.0-codeweave-pi.5"
        || record.state != "ready" || !uuid_valid || record.root != root
        || !hex(&record.policy_digest) || !hex(&record.corpus_digest)
        || record.counts.iter().any(|(key, value)| !counts.contains(&key.as_str()) || !value.is_finite() || *value < 0.0) {
        return Err("indexed status is not a compatible completed run".into());
    }
    if indexed_path_identity(root, false, true)? != (record.root_dev, record.root_ino)
        || directory_identity != (record.directory_dev, record.directory_ino)
        || Some(indexed_path_identity(database, true, false)?) != record.database_dev.zip(record.database_ino) {
        return Err("indexed root or store identity changed".into());
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let path = directory.join(format!("graph.sqlite{suffix}"));
        match std::fs::symlink_metadata(&path) {
            Ok(_) => { indexed_path_identity(&path, true, false)?; }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let admission = sources.admission.as_ref().ok_or("indexed source admission is required")?;
    admission.validate()?;
    if record.policy_digest != admission.policy_digest || record.corpus_digest != indexed_corpus_digest(sources)? {
        return Err("indexed policy or corpus listing changed".into());
    }
    if indexed_path_identity(directory, true, true)? != directory_identity {
        return Err("indexed directory changed during validation".into());
    }
    Ok(IndexedStatus { record, identity, digest: format!("{:x}", Sha256::digest(bytes)) })
}

struct IndexedRun {
    root: PathBuf,
    database: PathBuf,
    status: IndexedStatus,
    sources: Arc<OperationSources>,
}

impl IndexedRun {
    fn validate(&self) -> Result<()> {
        if read_indexed_status(&self.database, &self.root, &self.sources)? != self.status {
            return Err("completed indexed run changed during query".into());
        }
        Ok(())
    }
}

fn validate_indexed_paths(connection: &Connection, sources: &OperationSources, context: &OperationContext) -> Result<()> {
    let admission = sources.admission.as_ref().ok_or("indexed source admission is required")?;
    // This first executed read pins the SQLite snapshot before any graph aggregate.
    // Listing eligibility only: never read or hash the whole source corpus.
    let mut statement = connection.prepare("SELECT file_path FROM nodes UNION SELECT path FROM files
        UNION SELECT COALESCE(NULLIF(u.file_path,''),n.file_path) FROM unresolved_refs u LEFT JOIN nodes n ON n.id=u.from_node_id")?;
    let mut count = 0;
    for file in statement.query_map([], |row| row.get::<_, String>(0))? {
        context.check()?;
        let file = file?;
        count += 1;
        if count > 100_000 || !indexed_relative_path(&file) || !admission.files.contains(Path::new(&file)) {
            return Err("indexed graph contains ineligible paths".into());
        }
    }
    let dangling: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM edges e
        LEFT JOIN nodes s ON s.id=e.source LEFT JOIN nodes t ON t.id=e.target WHERE s.id IS NULL OR t.id IS NULL)
        OR EXISTS(SELECT 1 FROM unresolved_refs u LEFT JOIN nodes n ON n.id=u.from_node_id WHERE n.id IS NULL)", [], |row| row.get(0))?;
    if dangling { return Err("indexed graph has missing relationship owners".into()); }
    Ok(())
}

enum AnalysisIdentity {
    Captured(Capture),
    Indexed(IndexedRun),
}

struct ValidatedAnalysis {
    connection: Connection,
    identity: AnalysisIdentity,
    contents: RefCell<HashMap<String, (PathBuf, Arc<String>)>>,
    extraction_diagnostics: RefCell<Vec<Value>>,
    source_facts: RefCell<HashMap<String, Arc<CapturedSource>>>,
}

/// Direct donor probe compatibility. Ordinary loading supplies scope, case and
/// live-selected identities through load_indexed instead.
#[cfg(test)]
fn load_indexed_run(
    query: &str, run_id: &str, arguments: &Value, database: &Path,
    context: &OperationContext, sources: Arc<OperationSources>,
) -> Result<Option<PreparedSearch>> {
    load_indexed(query, true, run_id, arguments, &context.root, database, context, sources, None)
}

fn validate_indexed_admission(arguments: &Value, context: &OperationContext, sources: &OperationSources) -> Result<()> {
    sources.validate_admission(arguments, &context.root)?;
    let admission = sources.admission.as_ref().ok_or("indexed source admission is required")?;
    if arguments.get("analysisPolicyDigest").is_some_and(|value| value.as_str() != Some(admission.policy_digest.as_str())) {
        return Err("indexed policy admission changed".into());
    }
    if let Some(files) = arguments.get("analysisCorpusFiles") {
        let files = files.as_array().ok_or("indexed census must contain paths")?;
        let paths = files.iter().map(|file| file.as_str().map(PathBuf::from))
            .collect::<Option<std::collections::BTreeSet<_>>>().ok_or("indexed census must contain paths")?;
        if paths.len() != files.len() || paths != admission.files {
            return Err("indexed corpus admission changed".into());
        }
    }
    Ok(())
}

fn load_indexed(
    query: &str, sensitive: bool, run_id: &str, arguments: &Value, scope: &Path, database: &Path,
    context: &OperationContext, sources: Arc<OperationSources>, live: Option<&SearchResult>,
) -> Result<Option<PreparedSearch>> {
    let validated = open_indexed(run_id, arguments, database, context, sources.clone())?;
    let result = project_graph(query, sensitive, arguments, scope, context, sources.clone(), live, &validated)?;
    // Continuation freezes this selection; it must never query more graph rows.
    sources.validate_admission(arguments, &context.root)?;
    sources.validate_retained(context)?;
    validated.validate_indexed_run()?;
    Ok(result)
}

fn open_indexed(run_id: &str, arguments: &Value, database: &Path,
    context: &OperationContext, sources: Arc<OperationSources>) -> Result<ValidatedAnalysis> {
    let status = read_indexed_status(database, &context.root, &sources)?;
    if !run_id.is_empty() && status.record.run_id != run_id {
        return Err("completed indexed run does not match expected run".into());
    }
    validate_indexed_admission(arguments, context, &sources)?;
    if arguments.get("page").is_some_and(|page| page.as_u64() != Some(1))
        || ["cursor", "renderRanked"].iter().any(|key| arguments.get(*key).is_some()) {
        return Err("indexed graph paging is unavailable".into());
    }
    let connection = open_read_snapshot(database, context)?;
    // Check only the columns this projection consumes; never migrate, fabricate
    // G1 metadata or require the separate semantic extension in a donor store.
    for sql in [
        "SELECT id,kind,name,qualified_name,file_path,start_line,end_line,start_column,end_column FROM nodes LIMIT 0",
        "SELECT id,source,target,kind,line,col,metadata,provenance FROM edges LIMIT 0",
        "SELECT path,content_hash,errors FROM files LIMIT 0",
        "SELECT id,from_node_id,reference_kind,reference_name,status,line,col,candidates,file_path FROM unresolved_refs LIMIT 0",
    ] { connection.prepare(sql)?; }
    validate_indexed_paths(&connection, &sources, context)?;
    let validated = ValidatedAnalysis {
        connection,
        identity: AnalysisIdentity::Indexed(IndexedRun {
            root: context.root.clone(), database: database.into(), status, sources: sources.clone(),
        }),
        contents: RefCell::default(), extraction_diagnostics: RefCell::default(),
        source_facts: RefCell::default(),
    };
    validated.validate_indexed_run()?;
    Ok(validated)
}

fn open_read_snapshot(database: &Path, context: &OperationContext) -> Result<Connection> {
    context.check()?;
    if !database.is_absolute() || database.canonicalize()? != database || database.starts_with(&context.root) {
        return Err("candidate database must be a canonical path outside source".into());
    }
    let connection = Connection::open_with_flags(database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW)?;
    connection.busy_timeout(Duration::from_millis(100))?;
    connection.execute_batch("BEGIN")?;
    Ok(connection)
}

fn open_capture(
    expected_revision: &str,
    arguments: &Value,
    database: &Path,
    context: &OperationContext,
    sources: &OperationSources,
) -> Result<ValidatedAnalysis> {
    let connection = open_read_snapshot(database, context)?;
    let raw: String = connection.query_row(
        "SELECT value FROM project_metadata WHERE key='codeweave-pi.g1' AND length(value)<=8388608",
        [],
        |row| row.get(0),
    )?;
    let tables = connection.prepare("SELECT name FROM sqlite_schema WHERE type='table'")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<HashSet<_>, _>>()?;
    for table in ["schema_versions", "nodes", "edges", "files", "unresolved_refs", "nodes_fts", "name_segment_vocab"] {
        if !tables.contains(table) {
            return Err(format!("incomplete analysis schema (missing {table})").into());
        }
    }
    // Initialization has identity but no manifest. Recognize only an owned,
    // compatible zero generation; published records still need the strict Capture
    // deserializer below, including its missing/duplicate-field checks.
    let identity: Value = serde_json::from_str(&raw)?;
    if identity["generation"].as_u64() == Some(0)
        && identity["root"].as_str().is_some_and(|root| Path::new(root) == context.root)
        && identity["kernelVersion"] == "0.1.0-codeweave-pi.5"
        && !expected_revision.is_empty()
        && identity["interpretationRevision"] == expected_revision
    {
        return Err("project has not published a generation".into());
    }
    let capture: Capture = serde_json::from_str(&raw)?;
    if capture.root != context.root
        || capture.generation == 0
        || capture.generation > 9_007_199_254_740_991
        || capture.kernel_version != "0.1.0-codeweave-pi.5"
        || expected_revision.is_empty()
        || capture.interpretation_revision != expected_revision
        || capture.sources.len() > 10_000
    {
        return Err("candidate identity or captured source manifest is invalid".into());
    }
    sources.validate_admission(arguments, &context.root)?;
    let expected_policy_digest = arguments
        .get("analysisPolicyDigest")
        .map(|value| {
            value
                .as_str()
                .ok_or("analysisPolicyDigest must be a string")
        })
        .transpose()?;
    // Admission describes current eligibility, not whether an explicit publication
    // was policy-stamped. Without admission, preserve the direct-call contract.
    let policy_matches = if let Some(admission) = &sources.admission {
        capture.policy_digest.as_deref().is_none_or(|digest| digest == admission.policy_digest)
            && expected_policy_digest.is_none_or(|digest| digest == admission.policy_digest)
    } else {
        capture.policy_digest.as_deref() == expected_policy_digest
    };
    if !policy_matches || expected_policy_digest.is_some_and(|digest| {
        digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(
            "corpus policy version is missing or changed; validate admission before querying"
                .into(),
        );
    }
    // The selected-query caller always supplies current eligibility. Compare it
    // inside this snapshot even for an explicit capture without a policy stamp;
    // an earlier metadata check cannot constrain a newer concurrent publication.
    if capture.policy_digest.is_some() || arguments.get("analysisCorpusFiles").is_some() {
        let files = arguments
            .get("analysisCorpusFiles")
            .and_then(Value::as_array)
            .ok_or("current corpus census is required for policy-bound analysis")?;
        if files.len() > 10_000 {
            return Err("current corpus census exceeds its bound".into());
        }
        let paths = files
            .iter()
            .map(Value::as_str)
            .collect::<Option<HashSet<_>>>()
            .ok_or("current corpus census must contain paths")?;
        if paths.len() != files.len() {
            return Err("current corpus census contains duplicates".into());
        }
        if capture
            .sources
            .iter()
            .any(|source| !paths.contains(source.path.as_str()))
            || (capture.corpus.as_deref() == Some("project-capture")
                && paths.len() != capture.sources.len())
        {
            return Err("captured corpus membership changed; reconcile before querying".into());
        }
    }
    // Preserve publication order in this hash: the writer supplies the canonical
    // manifest. Sorting here with a different Unicode ordering would change it.
    let canonical = capture
        .sources
        .iter()
        .map(|file| json!([file.path, file.language, file.digest]))
        .collect::<Vec<_>>();
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&canonical)?));
    if digest != capture.capture_digest {
        return Err("captured source manifest does not match generation".into());
    }
    let mut contents = HashMap::new();
    let mut extraction_diagnostics = Vec::new();
    let mut total_bytes = 0_u64;
    for file in &capture.sources {
        context.check()?;
        let relative = Path::new(&file.path);
        if file.path.is_empty()
            || !relative
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            || file.path.contains('\\')
            || file.digest.len() != 64
            || !file.digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("invalid captured source identity".into());
        }
        let path = context.root.join(relative);
        if path.canonicalize()? != path {
            return Err("captured source path changed".into());
        }
        total_bytes = total_bytes
            .checked_add(std::fs::metadata(&path)?.len())
            .ok_or("capture size overflow")?;
        if total_bytes > CAPTURE_BYTES {
            return Err("captured source changed or exceeds candidate bound".into());
        }
        let text = sources.read_text(&path)?;
        if format!("{:x}", Sha256::digest(text.as_bytes())) != file.digest {
            return Err("captured source changed; prepared relationships withheld".into());
        }
        if file.language.is_some() {
            let (stored, errors): (String, Option<String>) = connection.query_row(
                "SELECT content_hash,errors FROM files WHERE path=?1",
                [&file.path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if stored != file.digest {
                return Err("file and generation versions disagree".into());
            }
            if let Some(errors) = errors {
                let diagnostics: Vec<Value> = serde_json::from_str(&errors)?;
                for mut diagnostic in diagnostics {
                    let line = diagnostic["line"]
                        .as_u64()
                        .and_then(|line| usize::try_from(line).ok());
                    let column = diagnostic["column"].as_u64();
                    let source_line = line
                        .and_then(|line| line.checked_sub(1))
                        .and_then(|line| text.lines().nth(line));
                    if diagnostic["severity"] != "warning"
                        || diagnostic["code"] != "unrepresented_reference_origin"
                        || diagnostic["message"].as_str().is_none()
                        || !source_line.zip(column).is_some_and(|(line, column)| {
                            column <= line.encode_utf16().count() as u64
                        })
                    {
                        return Err("invalid captured extraction diagnostic".into());
                    }
                    diagnostic["filePath"] = json!(file.path);
                    extraction_diagnostics.push(diagnostic);
                }
            }
        }
        if contents.insert(file.path.clone(), (path, text)).is_some() {
            return Err("duplicate captured source".into());
        }
    }
    Ok(ValidatedAnalysis {
        connection,
        identity: AnalysisIdentity::Captured(capture),
        contents: RefCell::new(contents),
        extraction_diagnostics: RefCell::new(extraction_diagnostics),
        source_facts: RefCell::new(HashMap::new()),
    })
}

pub(crate) fn semantic_publication(semantic: &Value) -> Option<Value> {
    let keys: &[&str] = if semantic["indexedRunId"].is_string() {
        if semantic.get("generation").is_some() || semantic.get("captureDigest").is_some() { return None; }
        &["indexedRunId", "indexedRunCounts", "indexedStatusDigest", "corpusDigest",
            "interpretationRevision", "policyDigest", "continuationStatus"]
    } else {
        semantic["generation"].as_u64()?;
        &["generation", "captureDigest", "interpretationRevision", "capturedFiles", "policyDigest"]
    };
    let mut publication = json!({"status":"ok", "semantic":semantic, "connectionsStatus":"unavailable",
        "sourceComposition":"source-validated semantic candidates; connection association is independent"});
    for key in keys { publication[*key] = semantic[*key].clone(); }
    Some(publication)
}

/// Semantic retrieval supplies a bounded scoped capture, not merely lexical winners.
/// Current bytes and the graph share the same committed read snapshot.
pub(crate) fn semantic_candidates(query: &str, arguments: &Value, scope: &Path,
    context: &OperationContext, sources: Arc<OperationSources>) -> std::result::Result<(Vec<Match>, Value), String> {
    let retrieve = || -> Result<(Vec<Match>, Value)> {
        let database = arguments["analysisDatabase"].as_str().ok_or("analysis database unavailable")?;
        let revision = arguments["analysisRevision"].as_str().ok_or("analysis revision unavailable")?;
        let validated = if revision == "codeweave-pi.maintenance.1" {
            open_indexed("", arguments, Path::new(database), context, sources.clone())?
        } else { open_capture(revision, arguments, Path::new(database), context, &sources)? };
        let result = semantic_candidates_in_snapshot(query, arguments, scope, context, &validated)?;
        sources.validate_admission(arguments, &context.root)?;
        sources.validate_retained(context)?;
        validated.validate_indexed_run()?;
        Ok(result)
    };
    retrieve().map_err(|error| format!("semantic discovery unavailable: {error}"))
}

fn semantic_candidates_in_snapshot(query: &str, arguments: &Value, scope: &Path,
    context: &OperationContext, validated: &ValidatedAnalysis) -> Result<(Vec<Match>, Value)> {
    // Refuse incompatible preparation before opening model assets. Consumer
    // projection shares this exact snapshot rather than opening another reader.
    let descriptor = semantic_descriptor(validated)?;
    let vector = if descriptor["status"] == "unavailable" { Vec::new() } else {
        let directory = arguments["analysisModelDirectory"].as_str().ok_or("local model assets unavailable")?;
        crate::semantic::encode(Path::new(directory), &[query.to_string()], context)?
            .pop().ok_or("query encoding is unavailable")?
    };
    rank_semantic(validated, &vector, scope, context)
}

fn semantic_descriptor(validated: &ValidatedAnalysis) -> Result<Value> {
    let descriptor = match &validated.identity {
        AnalysisIdentity::Captured(capture) => capture.semantic.clone().ok_or("semantic preparation is missing")?,
        AnalysisIdentity::Indexed(run) => {
            run.validate()?;
            // Optional semantic objects do not gate the structural projection.
            // input_digest must be the sole primary key: a composite key would
            // admit duplicate feature rows for one binding and multiply candidates.
            let compatible: bool = validated.connection.query_row(r#"SELECT
                EXISTS(SELECT 1 FROM pragma_table_info('nodes')
                    WHERE name='semantic_input_digest' AND upper(type)='TEXT' AND "notnull"=0)
                AND (SELECT count(*) FROM pragma_table_info('semantic_features'))=2
                AND EXISTS(SELECT 1 FROM pragma_table_info('semantic_features')
                    WHERE name='input_digest' AND upper(type)='TEXT' AND pk=1)
                AND EXISTS(SELECT 1 FROM pragma_table_info('semantic_features')
                    WHERE name='vector' AND upper(type)='BLOB' AND "notnull"=1 AND pk=0)"#,
                [], |row| row.get(0))?;
            if !compatible { return Err("indexed semantic schema is missing or incompatible".into()); }
            let raw: String = validated.connection.query_row(
                "SELECT CASE WHEN length(value)<=16384 THEN value ELSE NULL END FROM project_metadata WHERE key='codeweave-pi.indexed-semantic.1'",
                [], |row| row.get(0))?;
            let value: Value = serde_json::from_str(&raw)?;
            let keys = ["format", "runId", "recipe", "dimensions", "status", "reason", "examined", "unexamined", "represented", "missing", "unrepresented"];
            if value.as_object().is_none_or(|object| object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)))
                || value["format"] != "codeweave-pi.indexed-semantic.1"
                || value["runId"] != run.status.record.run_id
                || !["available", "partial", "unavailable"].iter().any(|status| value["status"] == *status)
                || !["complete", "coverage", "budget", "model-unavailable", "native-unavailable"].iter().any(|reason| value["reason"] == *reason)
                || ["examined", "unexamined", "represented", "missing", "unrepresented"].iter()
                    .any(|key| value[*key].as_u64().is_none_or(|count| count > 9_007_199_254_740_991)) {
                return Err("indexed semantic descriptor is incompatible with completed run".into());
            }
            let count = |key: &str| value[key].as_u64().unwrap(); // bounded above
            let total = count("examined") + count("unexamined");
            if total > 9_007_199_254_740_991
                || total != count("represented") + count("missing") + count("unrepresented")
                || count("unexamined") > count("unrepresented") {
                return Err("indexed semantic coverage counts are inconsistent".into());
            }
            if value["status"] == "available" && (value["reason"] != "complete"
                || ["unexamined", "missing", "unrepresented"].iter().any(|key| value[*key] != 0)) {
                return Err("indexed semantic coverage descriptor is inconsistent".into());
            }
            if value["status"] == "unavailable" && value["represented"] != 0 {
                return Err("unavailable indexed semantics cannot claim represented candidates".into());
            }
            value
        }
    };
    let native_unavailable = matches!(&validated.identity, AnalysisIdentity::Indexed(_))
        && descriptor["status"] == "unavailable" && descriptor["reason"] == "native-unavailable" && descriptor["recipe"].is_null();
    if (!native_unavailable && descriptor["recipe"] != crate::semantic::recipe()) || descriptor["dimensions"] != crate::semantic::DIMENSIONS {
        return Err("semantic recipe is incompatible; explicit maintenance is required".into());
    }
    Ok(descriptor)
}

fn rank_semantic(validated: &ValidatedAnalysis, vector: &[f32], scope: &Path,
    context: &OperationContext) -> Result<(Vec<Match>, Value)> {
    let descriptor = semantic_descriptor(validated)?;
    let indexed = matches!(&validated.identity, AnalysisIdentity::Indexed(_));
    let local = scope.strip_prefix(&context.root)?.to_str().ok_or("non-UTF8 scope")?;
    if indexed && descriptor["status"] == "unavailable" {
        // Preserve producer coverage (including a zero-progress budget stop)
        // without query encoding, candidate reads or invented G1 identity.
        let mut metadata = validated.metadata(json!({"status":"unavailable", "reason":descriptor["reason"],
            "recipe":descriptor["recipe"], "dimensions":descriptor["dimensions"], "preparation":descriptor,
            "examined":0, "unexamined":null, "unrepresented":0, "missingFeatures":0, "invalidFeatures":0,
            "unassociated":0, "staleCandidates":0, "capped":false, "sourceCapped":false, "complete":false, "returned":0,
            "coverageMeaning":"no semantic candidates examined; producer coverage is separate; no continuation recollection"}));
        metadata["scope"] = json!(scope);
        return Ok((Vec::new(), metadata));
    }
    if !crate::semantic::valid_vector(vector) {
        return Err("semantic recipe is incompatible; explicit maintenance is required".into());
    }
    let mut statement = validated.connection.prepare("SELECT n.id,n.kind,n.name,n.qualified_name,n.file_path,n.start_line,n.end_line,n.start_column,n.end_column,
        n.semantic_input_digest, CASE WHEN f.vector IS NULL THEN NULL WHEN length(f.vector)=1024 THEN f.vector ELSE X'' END
        FROM nodes n LEFT JOIN semantic_features f ON f.input_digest=n.semantic_input_digest
        WHERE (?1='' OR n.file_path=?1 OR substr(n.file_path,1,length(?1)+1)=?1||'/')
        AND n.kind IN ('function','method','interface','class','struct','trait','protocol','enum','union','type_alias','constant','variable','property','field')
        ORDER BY n.file_path,n.start_line,n.start_column,n.id")?;
    let mut rows = statement.query([local])?;
    let mut scored = Vec::new();
    let (mut examined, mut unrepresented, mut missing, mut invalid) = (0usize, 0usize, 0usize, 0usize);
    let mut excluded_tests = 0usize;
    let mut capped = false;
    let mut source_capped = false;
    let mut stale = 0usize;
    let mut source_bytes = 0u64;
    let mut source_files = HashSet::new();
    while let Some(row) = rows.next()? {
        context.check()?;
        let candidate = node(row)?;
        if crate::types::is_test_file(Path::new(&candidate.file)) { continue; }
        if examined == 20_000 { capped = true; break; }
        // Indexed missing bindings/features must not trigger source reads.
        let input: Option<String> = row.get(9)?;
        let bytes: Option<Vec<u8>> = row.get(10)?;
        let stored = bytes.as_deref().map(crate::semantic::decode_vector);
        if indexed {
            if input.is_none() { examined += 1; unrepresented += 1; continue; }
            if bytes.is_none() { examined += 1; missing += 1; continue; }
            if stored.as_ref().is_some_and(|vector| vector.is_err()) { examined += 1; invalid += 1; continue; }
            if source_files.insert(candidate.file.clone()) {
                source_bytes = source_bytes.saturating_add(std::fs::metadata(context.root.join(&candidate.file))?.len());
                if source_bytes > CAPTURE_BYTES { capped = true; source_capped = true; break; }
            }
        }
        let (_, content) = match validated.content_for(&candidate) {
            Ok(content) => content,
            Err(error) => match error.downcast_ref::<IndexedSourceOmission>() {
                Some(IndexedSourceOmission::Stale) => { examined += 1; stale += 1; continue; }
                Some(IndexedSourceOmission::ByteBound) => { capped = true; source_capped = true; break; }
                None => return Err(error),
            },
        };
        let start = byte_at(&content, candidate.start, candidate.start_column)?;
        let end = byte_at(&content, candidate.end, candidate.end_column)?;
        if validated.source_facts(&candidate)?.excluded_tests.iter().any(|range| range.start <= start && end <= range.end) {
            excluded_tests += 1;
            continue;
        }
        examined += 1;
        if input.is_none() { unrepresented += 1; continue; }
        let Some(stored) = stored else { missing += 1; continue; };
        let Ok(stored) = stored else { invalid += 1; continue; };
        let score: f64 = vector.iter().zip(stored).map(|(a, b)| f64::from(*a) * f64::from(b)).sum();
        scored.push((score, candidate));
    }
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.id.cmp(&b.1.id)));
    let mut matches = Vec::new();
    let mut unassociated = 0usize;
    for (_, candidate) in scored {
        context.check()?;
        let mut matched = validated.matched(&candidate)?;
        if matched.syntax_key().is_none() { unassociated += 1; }
        matched.exact = false;
        matches.push(matched);
    }
    validated.validate_indexed_run()?;
    let complete = !capped && stale == 0 && unrepresented == 0 && missing == 0 && invalid == 0 && unassociated == 0
        && (!indexed || descriptor["status"] == "available");
    let mut metadata = validated.metadata(json!({"recipe":crate::semantic::recipe(),"dimensions":crate::semantic::DIMENSIONS,
        "capturedFiles":validated.contents.borrow().len(),
        "excludedTestScopes":excluded_tests,
        "scope":scope,"examined":examined,"unrepresented":unrepresented,"missingFeatures":missing,
        "invalidFeatures":invalid,"unassociated":unassociated,"staleCandidates":stale,"sourceCapped":source_capped,
        "capped":capped,"unexamined":if capped { Value::Null } else { json!(0) },"complete":complete,"returned":matches.len(),
        "status":if matches.is_empty() { "missing" } else if complete { "available" } else { "partial" },
        "coverageMeaning":"scoped captured graph declarations; not a census of every live declaration; capped tail is unknown and not retained",
        "meaning":"semantic candidates, not textual hits or ownership proof"}));
    if indexed {
        metadata.as_object_mut().unwrap().remove("semanticStatus");
        metadata["preparation"] = descriptor;
        metadata["scope"] = json!(scope);
        metadata["coverageMeaning"] = json!("scoped indexed declarations; only feature-bearing examined sources verified; stale owners omitted; preparation coverage is separate; capped tail is unknown and not retained");
    }
    Ok((matches, metadata))
}

/// Revalidate a pinned G1 publication or completed indexed run. Indexed resumes
/// only check status/admission/retained source: no SQL or provider replacement.
pub(crate) fn validate_continuation(arguments: &Value, pinned: &Value, database: &Path,
    context: &OperationContext, sources: Arc<OperationSources>) -> std::result::Result<(), String> {
    let revision = arguments.get("analysisRevision").and_then(Value::as_str).ok_or("prepared cursor revision missing")?;
    if arguments.get("analysisCorpusFiles").is_none() { return Err("prepared cursor requires a current complete census".into()); }
    if revision == "codeweave-pi.maintenance.1" {
        validate_indexed_admission(arguments, context, &sources).map_err(|error| error.to_string())?;
        let status = read_indexed_status(database, &context.root, &sources).map_err(|error| error.to_string())?;
        if pinned.get("generation").is_some() || pinned.get("captureDigest").is_some()
            || pinned["indexedRunId"] != status.record.run_id
            || pinned["interpretationRevision"] != status.record.format
            || pinned["policyDigest"] != status.record.policy_digest
            || pinned["corpusDigest"] != status.record.corpus_digest
            || pinned["indexedStatusDigest"] != status.pin_digest() {
            return Err("prepared ranked cursor indexed run changed; restart the original query".into());
        }
        sources.validate_retained(context)?;
        if read_indexed_status(database, &context.root, &sources).map_err(|error| error.to_string())? != status {
            return Err("completed indexed run changed during continuation".into());
        }
        return Ok(());
    }
    let validated = open_capture(revision, arguments, database, context, &sources).map_err(|error| error.to_string())?;
    let capture = validated.capture().map_err(|error| error.to_string())?;
    if json!(capture.generation) != pinned["generation"]
        || json!(capture.capture_digest) != pinned["captureDigest"]
        || json!(capture.interpretation_revision) != pinned["interpretationRevision"]
        || json!(capture.policy_digest) != pinned["policyDigest"]
        || pinned.get("semantic").is_some_and(|semantic| capture.semantic.as_ref().is_none_or(|current| current["recipe"] != semantic["recipe"])) {
        return Err("prepared ranked cursor publication changed; restart the original query".into());
    }
    Ok(())
}

fn load_capture(
    query: &str,
    sensitive: bool,
    expected_revision: &str,
    arguments: &Value,
    scope: &Path,
    database: &Path,
    context: &OperationContext,
    sources: Arc<OperationSources>,
    live: Option<&SearchResult>,
) -> Result<Option<PreparedSearch>> {
    if expected_revision == "codeweave-pi.maintenance.1" {
        return load_indexed(query, sensitive, "", arguments, scope, database, context, sources, live);
    }
    let validated = open_capture(expected_revision, arguments, database, context, &sources)?;
    project_graph(query, sensitive, arguments, scope, context, sources, live, &validated)
}

fn project_graph(
    query: &str, sensitive: bool, arguments: &Value, scope: &Path,
    context: &OperationContext, sources: Arc<OperationSources>, live: Option<&SearchResult>,
    validated: &ValidatedAnalysis,
) -> Result<Option<PreparedSearch>> {
    let connection = &validated.connection;
    let indexed = matches!(&validated.identity, AnalysisIdentity::Indexed(_));
    let captured_files = validated.contents.borrow().len();
    let relation = arguments
        .get("analysisRelation")
        .map(|value| match value.as_str() {
            Some("callers") => Ok("callers"),
            Some("callees") => Ok("callees"),
            _ => Err("analysisRelation must be callers or callees"),
        })
        .transpose()?;
    let positive = |key: &str, default: usize, maximum: usize| -> Result<usize> {
        let value = arguments.get(key).map_or(Ok(default as u64), |value| {
            value
                .as_u64()
                .ok_or("page and limit must be positive integers")
        })?;
        let value = usize::try_from(value)?;
        if value == 0 || value > maximum {
            return Err(format!("{key} is outside its bound").into());
        }
        Ok(value)
    };
    let page = if relation.is_some() {
        positive("page", 1, i64::MAX as usize)?
    } else {
        1
    };
    let limit = if relation.is_some() {
        positive("limit", 50, 200)?
    } else {
        CONNECTION_LIMIT + 1
    };
    let offset = (page - 1)
        .checked_mul(limit)
        .filter(|offset| *offset <= i64::MAX as usize)
        .ok_or("page offset overflow")?;
    let (target_file, lookup) = match query.split_once("::") {
        Some((file, name)) if validated.contains_file(file)? => (file, name),
        _ => ("", query),
    };
    let scope_name = scope
        .strip_prefix(&context.root)?
        .to_str()
        .ok_or("non-UTF8 candidate scope")?;
    let id_target: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM nodes WHERE id=?1)",
        [lookup],
        |row| row.get(0),
    )?;
    let live_targets = live
        .map(super::fuzzy::rich_targets)
        .filter(|targets| targets.iter().any(|matched| matched.syntax_key().is_some() || matched.graph_node_id().is_some()));
    if arguments.get("focus").is_some() && live_targets.is_none() {
        return Ok(None); // No exact source association: never substitute the question as a graph target.
    }
    let mut statement = connection.prepare("SELECT id,kind,name,qualified_name,file_path,start_line,end_line,start_column,end_column FROM nodes
        WHERE (?3 OR id=?1 OR name=?1 OR qualified_name=?1 OR replace(qualified_name,'::','.')=?5)
        AND (?6 OR kind IN ('function','method','interface','class','struct','trait','protocol','enum','union','type_alias','constant','variable','property','field'))
        AND (?2='' OR file_path=?2 OR substr(file_path,1,length(?2)+1)=?2||'/') AND (?4='' OR file_path=?4) AND (NOT ?7 OR id=?1)
        ORDER BY file_path,start_line,start_column,id")?;
    // Use the same Unicode-aware regex case semantics as live search, not
    // SQLite's ASCII-only NOCASE. Count every exact identity, projecting at most five.
    use grep_matcher::Matcher;
    let matcher = grep_regex::RegexMatcher::new(&format!(
        "{}^{}$",
        if sensitive { "" } else { "(?i)" },
        regex_syntax::escape(lookup)
    ))?;
    let qualified_matcher = grep_regex::RegexMatcher::new(&format!(
        "{}^{}$",
        if sensitive { "" } else { "(?i)" },
        regex_syntax::escape(&lookup.replace("::", "."))
    ))?;
    let mut targets = Vec::new();
    let mut total_targets = 0;
    let mut unassociated_targets = Vec::new();
    let mut unassociated_target_count = 0usize;
    for candidate in statement.query_map(
        rusqlite::params![
            lookup,
            scope_name,
            !sensitive || live_targets.is_some(),
            if live_targets.is_some() { "" } else { target_file },
            lookup.replace("::", "."),
            relation.is_some(),
            id_target && live_targets.is_none()
        ],
        node,
    )? {
        context.check()?;
        let candidate = candidate?;
        let name_matches = candidate.id == lookup
            || matcher.is_match(candidate.name.as_bytes())?
            || matcher.is_match(candidate.qualified.as_bytes())?
            || qualified_matcher.is_match(candidate.qualified.replace("::", ".").as_bytes())?;
        let selected = if let Some(live_targets) = &live_targets {
            // Discovery words need not occur in a declaration's name. Associate
            // only the already-selected live declarations, never rerank graph nodes.
            let path = context.root.join(&candidate.file);
            if !live_targets.iter().any(|matched| matched.path == path) {
                continue;
            }
            let syntax = validated.syntax_identity(&candidate)?;
            let selected = live_targets.iter().any(|matched| {
                matched.path == path && if let Some(source) = matched.syntax_key() {
                    syntax.as_ref().is_some_and(|graph|
                        (graph.bytes.start, graph.bytes.end, graph.syntax_kind.as_str()) == source)
                } else {
                    matched.graph_node_id() == Some(candidate.id.as_str())
                }
            });
            if !selected && name_matches {
                unassociated_target_count += 1;
                if unassociated_targets.len() < 200 {
                    unassociated_targets.push(json!({"node":candidate,"sourceAssociation":"unavailable: no exact association to the selected live source identity"}));
                }
            }
            selected
        } else {
            name_matches
        };
        if selected {
            total_targets += 1;
            if targets.len() < if relation.is_some() { 200 } else { 5 } {
                targets.push(candidate);
            }
        }
    }
    if let Some(relation) = relation.filter(|_| total_targets != 1) {
        for target in &targets {
            validated.content_for(target)?;
        }
        return Ok(Some(PreparedSearch {
            result: SearchResult {
                query: query.into(),
                scope: if indexed { scope.into() } else { context.root.clone() },
                matches: Vec::new(),
                sources,
                total_found: total_targets,
                definitions: total_targets,
                usages: 0,
                facet_totals: FacetTotals {
                    definitions: total_targets,
                    ..Default::default()
                },
            },
            lanes: LaneBundle::from_prepared_cards(Vec::new()),
            metadata: validated.metadata(json!({"status":if total_targets == 0 { "not_found" } else { "ambiguous" }, "relation":relation,
                "candidates":targets,"totalCandidates":total_targets,"omittedCandidates":total_targets-targets.len(),
                "connections":[],"page":page,"limit":limit,"totalConnections":0,"returnedConnections":0,"omittedConnections":0,"nextPage":null,
                "extractionDiagnostics":*validated.extraction_diagnostics.borrow(),"positionEncoding":{"lineBase":1,"columnBase":0,"columnUnit":"UTF-16","nodeEndExclusive":true}})),
        }));
    }
    // An eligible graph target without a source association stays explicit; it
    // cannot become an invented live identity or replace live selection.
    if targets.is_empty() {
        if !unassociated_targets.is_empty() {
            return Ok(Some(PreparedSearch {
                result: SearchResult {
                    query: query.into(),
                    scope: if indexed { scope.into() } else { context.root.clone() },
                    matches: Vec::new(),
                    sources,
                    total_found: 0,
                    definitions: 0,
                    usages: 0,
                    facet_totals: FacetTotals::default(),
                },
                lanes: LaneBundle::from_prepared_cards(Vec::new()),
                metadata: validated.metadata(json!({"status":"ok","sourceAssociation":"unavailable",
                    "capturedFiles":captured_files,"unassociatedTargets":unassociated_targets,"extractionDiagnostics":*validated.extraction_diagnostics.borrow(),
                    "unassociatedTargetCount":unassociated_target_count,"omittedUnassociatedTargets":unassociated_target_count.saturating_sub(unassociated_targets.len()),
                    "positionEncoding":{"lineBase":1,"columnBase":0,"columnUnit":"UTF-16","nodeEndExclusive":true}})),
            }));
        }
        return Ok(None);
    }
    let mut cards = Vec::new();
    let mut projected_members = 0;
    let mut projected_connections = 0;
    let mut projected_unresolved = 0;
    for target in &targets {
        let content_for = |node: &Node| validated.content_for(node);
        let (path, text) = content_for(target)?;
        let mut matched = validated.matched(target)?;
        if let Some(selected) = live.and_then(|live| live.matches.iter().find(|matched| matched.graph_node_id() == Some(target.id.as_str()))) {
            matched.source_association = selected.source_association.clone();
        }
        let has_declared_members = matches!(
            target.kind.as_str(),
            "interface"
                | "class"
                | "struct"
                | "trait"
                | "protocol"
                | "enum"
                | "union"
                | "type_alias"
        );
        let members = if has_declared_members && relation.is_none() {
            let mut statement = connection.prepare("SELECT DISTINCT n.id,n.kind,n.name,n.qualified_name,n.file_path,n.start_line,n.end_line,n.start_column,n.end_column
            FROM edges e JOIN nodes n ON n.id=e.target
            WHERE e.source=?1 AND e.kind='contains' AND n.kind IN ('function','method','property','field')
            ORDER BY n.file_path,n.start_line,n.start_column,n.id LIMIT 1001")?;
            let members = statement
                .query_map([&target.id], node)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            projected_members += members.len();
            if projected_members > CONNECTION_LIMIT {
                return Err("declared member bound exceeded".into());
            }
            for member in &members {
                content_for(member)?;
            }
            members
        } else {
            Vec::new()
        };
        let mut lanes = SymbolLanes::default();
        // Fields remain in the target's source-backed inventory; do not turn a
        // field initializer into a second, unbounded member-body allowance.
        for member in members
            .iter()
            .filter(|member| matches!(member.kind.as_str(), "function" | "method"))
        {
            lanes.member_definitions.push(validated.candidate(member)?);
        }
        lanes.connection_notes.push(match &validated.identity {
            AnalysisIdentity::Captured(_) => format!("Prepared connections cover {captured_files} captured files, not the whole project."),
            AnalysisIdentity::Indexed(_) => "Best-effort indexed relationships; matching current source verifies coordinates, not current bindings or absence. Continuation replays retained evidence only.".into(),
        });
        if has_declared_members {
            lanes.connection_notes.push("Captured member declarations may cross files; membership and heritage do not prove invocation, signature satisfaction or runtime dispatch.".into());
        }
        if matched.declaration.is_none() {
            lanes.connection_notes.push("Graph target has no exact source-declaration association; graph identity and original coordinates retained.".into());
        }
        let total_connections: usize = if relation.is_some() {
            usize::try_from(connection.query_row(
                &format!(
                    "SELECT count(*) FROM edges e WHERE {} AND {}",
                    incident_predicate(relation),
                    INCIDENT_FILTER
                ),
                [&target.id],
                |row| row.get::<_, i64>(0),
            )?)?
        } else {
            0
        };
        let mut evidence = Vec::new();
        let mut seen_edges = HashSet::new();
        let mut rendered_definitions = HashSet::new();
        let mut unresolved_calls = HashSet::new();
        let mut unresolved_evidence = Vec::new();
        for target in std::iter::once(target).chain(members.iter()) {
            let (_, text) = content_for(target)?;
            // Relation pages are selected before presentation deduplication.
            let edges = incident_edges(connection, &target.id, relation, limit, offset)?;
            if relation.is_none() && edges.len() > CONNECTION_LIMIT {
                return Err(
                    "G1 connection bound exceeded; no partial connection set rendered".into(),
                );
            }
            for mut edge in edges {
                context.check()?;
                if !seen_edges.insert(edge.id) {
                    continue;
                }
                projected_connections += 1;
                if relation.is_none() && projected_connections > CONNECTION_LIMIT {
                    return Err("combined connection bound exceeded".into());
                }
                let (opposite_path, opposite_text) = content_for(&edge.opposite)?;
                if indexed {
                    edge.provenance = edge.provenance.filter(|value| matches!(value.as_str(), "heuristic" | "resolution" | "extraction"));
                }
                let outgoing = match relation {
                    Some("callers") => false,
                    Some("callees") => true,
                    _ => edge.source == target.id,
                };
                let source = if outgoing { target } else { &edge.opposite };
                let destination = if outgoing { &edge.opposite } else { target };
                let source_text = if outgoing { &text } else { &opposite_text };
                let mut metadata: Value = match edge.metadata.as_deref() {
                    Some(raw) => serde_json::from_str(raw)?,
                    None => json!({}),
                };
                if !metadata.is_object() {
                    return Err("connection metadata must be an object".into());
                }
                if indexed {
                    // Normalize before notes or structured output can consume
                    // donor free text; retain only fixed classification meaning.
                    let mut safe = serde_json::Map::new();
                    for key in ["fnRef", "valueRef"] {
                        if metadata[key] == true { safe.insert(key.into(), json!(true)); }
                    }
                    if metadata["refKind"] == "function_ref" { safe.insert("refKind".into(), json!("function_ref")); }
                    if let Some(method @ ("fuzzy" | "framework")) = metadata["resolvedBy"].as_str() {
                        safe.insert("resolvedBy".into(), json!(method));
                    }
                    if metadata.get("synthesizedBy").is_some() {
                        safe.insert("synthesizedBy".into(), if metadata["synthesizedBy"] == "interface-impl" { json!("interface-impl") } else { json!(true) });
                    }
                    metadata = Value::Object(safe);
                }
                let function_reference = edge.kind == "references"
                    && (metadata["fnRef"] == true || metadata["refKind"] == "function_ref");
                let aggregate_value = edge.kind == "references" && metadata["valueRef"] == true;
                let call_relation = edge.kind == "calls" || function_reference;
                let method = metadata.get("resolvedBy").and_then(Value::as_str);
                let classification = if edge.provenance.as_deref() == Some("heuristic")
                    || metadata.get("synthesizedBy").is_some()
                {
                    "heuristic"
                } else if method == Some("fuzzy") {
                    "fuzzy-inference"
                } else if method == Some("framework") {
                    "framework-inference"
                } else if function_reference {
                    "function-reference"
                } else if aggregate_value {
                    "value-dependency"
                } else {
                    match edge.kind.as_str() {
                        "instantiates" => "construction",
                        "references" => "reference",
                        "imports" => "import",
                        "exports" => "export",
                        "extends" | "implements" | "overrides" => "heritage",
                        _ => "call",
                    }
                };
                let inferred = matches!(
                    classification,
                    "heuristic" | "fuzzy-inference" | "framework-inference"
                );
                let recursive = edge.source == edge.target;
                // Inference positions can describe a registration or synthesis origin.
                // Preserve them verbatim, but never certify them as ordinary callsites.
                let missing_position = edge.line.is_none() || edge.column.is_none();
                if !inferred && call_relation && missing_position {
                    return Err(
                        "call/function-reference connection has no complete source position".into(),
                    );
                }
                let ordinary_site = if !inferred && !missing_position {
                    let line = edge.line.ok_or("connection has no source line")?;
                    let column = edge.column.ok_or("connection has no source column")?;
                    let row = line
                        .checked_sub(1)
                        .and_then(|index| source_text.lines().nth(index as usize))
                        .ok_or("connection position is outside source")?;
                    if !valid_column(row, column, false)
                        || (source.kind != "file"
                            && ((line, column) < (source.start, source.start_column)
                                || (line, column) >= (source.end, source.end_column)))
                    {
                        return Err("connection position is outside its source node span".into());
                    }
                    Some((line, row.to_string()))
                } else {
                    None
                };
                if source.file.ends_with(".go")
                    && metadata.get("synthesizedBy").and_then(Value::as_str)
                        == Some("interface-impl")
                {
                    let note = "Go implementation inference uses method names; signature satisfaction and runtime dispatch are unverified.";
                    if !lanes
                        .connection_notes
                        .iter()
                        .any(|existing| existing == note)
                    {
                        lanes.connection_notes.push(note.into());
                    }
                }
                let source_declaration = validated.declaration(source)?;
                let destination_declaration = validated.declaration(destination)?;
                let precise_site = if inferred {
                    None
                } else {
                    validated.site(&edge, source)?
                };
                let site_identity = precise_site.as_ref().map(|site| json!({"startByte":site.expression.start,"endByte":site.expression.end,
                    "targetStartByte":site.target.start,"targetEndByte":site.target.end,"receiver":site.receiver,"construction":site.construction,
                    "owner":site.owner.as_ref().map(|owner| json!({"startByte":owner.bytes.start,"endByte":owner.bytes.end,"syntaxKind":owner.syntax_kind})),
                    "ownerName":site.owner_name,"ownerRange":site.owner_range}));
                let mut connection_evidence = json!({"edgeId":edge.id,"source":edge.source,"target":edge.target,
            "sourceNode":source,"targetNode":destination,"kind":edge.kind,
            "classification":classification,"line":edge.line,"column":edge.column,
            "positionSemantics":if inferred { "recorded synthesis/inference position; ordinary callsite unverified" }
                else if aggregate_value && ordinary_site.is_none() { "aggregate value dependency; occurrence positions unavailable" }
                else if ordinary_site.is_none() { "recorded relationship; occurrence positions unavailable" }
                else if edge.kind == "instantiates" { "recorded instantiation binding; constructor invocation unverified" }
                else if !call_relation { "recorded source position; not an invocation" }
                else { "source-node carrier start" },
            "metadata":metadata,"provenance":edge.provenance,"resolvedBy":method,"self":recursive,
            "sourceIdentity":source_identity(source_declaration.as_ref()),"targetIdentity":source_identity(destination_declaration.as_ref()),"site":site_identity});
                if indexed { connection_evidence.as_object_mut().unwrap().remove("metadata"); }
                evidence.push(connection_evidence);
                // The sidecar is not model-visible. Keep non-obvious binding and
                // inference distinctions here, but don't displace live code with one
                // opaque graph-ID/provenance dump for every ordinary connection.
                let site = match (edge.line, edge.column) {
                    (Some(line), Some(column)) => format!(
                        "{}:{line}, column {column} (zero-based UTF-16)",
                        source.file
                    ),
                    (Some(line), None) => format!("{}:{line}, column unavailable", source.file),
                    (None, Some(column)) => format!(
                        "{}: line unavailable, column {column} (zero-based UTF-16)",
                        source.file
                    ),
                    (None, None) => format!("{}: position unavailable", source.file),
                };
                let reference_name = metadata.get("refName").and_then(Value::as_str);
                if !call_relation {
                    let heading = match edge.kind.as_str() {
                        "instantiates" => {
                            "construction evidence — recorded targets, invocation unverified"
                        }
                        "references" => "references — not function calls",
                        "imports" => "imports — symbol binding or module dependency as recorded",
                        "exports" => "exports — recorded symbol bindings",
                        _ => "heritage — signature satisfaction and dispatch unverified",
                    };
                    let meaning = if inferred {
                        "inferred relation; source declaration is not an invocation"
                    } else if aggregate_value && ordinary_site.is_none() {
                        "aggregate value dependency; occurrence positions unavailable"
                    } else if ordinary_site.is_none() {
                        "recorded relationship; occurrence positions unavailable"
                    } else if edge.kind == "imports" && destination.kind == "file" {
                        "module dependency only; imported-symbol identity not established"
                    } else if edge.kind == "imports" && destination.kind == "import" {
                        "import-statement carrier; not an imported symbol"
                    } else if edge.kind == "instantiates" {
                        "recorded construction target; invocation and dispatch unverified"
                    } else if matches!(edge.kind.as_str(), "extends" | "implements" | "overrides") {
                        "declared relationship; signature satisfaction and dispatch unverified"
                    } else {
                        "recorded reference; not an invocation"
                    };
                    let source_path = validated.content_for(source)?.0;
                    let carrier = ordinary_site.as_ref().map(|(line, row)| CallerMatch {
                        path: source_path.clone(),
                        line: *line,
                        calling_function: precise_site.as_ref().map_or_else(
                            || {
                                if source.kind == "file" {
                                    "<top-level>".into()
                                } else {
                                    source.qualified.clone()
                                }
                            },
                            |site| site.owner_name.clone(),
                        ),
                        call_text: row.clone(),
                        caller_range: precise_site
                            .as_ref()
                            .and_then(|site| site.owner_range)
                            .or_else(|| {
                                (source.kind != "file").then_some((source.start, source.end))
                            }),
                        content: source_text.clone(),
                        site: precise_site.clone(),
                    });
                    let definition = if (outgoing || carrier.is_none())
                        && !matches!(edge.opposite.kind.as_str(), "file" | "import")
                    {
                        Some(validated.candidate(&edge.opposite)?)
                    } else {
                        None
                    };
                    lanes
                        .stored_connections
                        .push(super::lanes::StoredConnection {
                            kind: edge.kind.clone(),
                            heading,
                            note: format!(
                                "{classification}: {} -> {} ({}:{}, {}); {site}; {meaning}",
                                source.qualified,
                                destination.qualified,
                                destination.file,
                                destination.start,
                                destination.kind
                            ),
                            source: carrier,
                            definition,
                        });
                    continue;
                }
                if inferred {
                    lanes.connection_notes.push(format!(
                        "{}: {} -> {}; recorded {site}; ordinary callsite unverified",
                        classification.replace('-', " "),
                        source.qualified,
                        destination.qualified,
                    ));
                } else if recursive {
                    lanes.connection_notes.push(format!(
                        "self {classification}: {} at {site}; resolution: {}",
                        source.qualified,
                        method.unwrap_or("basis unavailable"),
                    ));
                } else if reference_name.is_some_and(|name| name != destination.name)
                    || destination.qualified != destination.name
                {
                    lanes.connection_notes.push(format!(
                "{classification} binding at {site}: {} -> {} ({}:{}, column {}); resolution: {}",
                reference_name.unwrap_or(&destination.name),
                destination.qualified,
                destination.file,
                destination.start,
                destination.start_column,
                method.unwrap_or("basis unavailable"),
            ));
                }
                if !outgoing && source.start == source.end && source.start_column > 0 {
                    lanes.connection_notes.push(format!(
                        "connection owner: {} at {}:{}, column {} (zero-based UTF-16)",
                        source.qualified, source.file, source.start, source.start_column,
                    ));
                }
                if recursive && relation.is_none() {
                    continue;
                } // Ranked live evidence owns self sites; directed trace still needs its selected source row.
                if outgoing && !inferred && edge.kind == "calls" {
                    if let Some(site) = precise_site.clone() {
                        let origin = if source_declaration.is_none() {
                            "graph-associated site; source declaration association unavailable"
                        } else if matched.declaration.as_ref().is_some_and(|declaration| {
                            site.owner.as_ref() == Some(&declaration.region().id)
                        }) {
                            "direct origin"
                        } else {
                            "nested source origin within graph projection; immediate owner retained"
                        };
                        lanes.connections.push(super::callees::CallConnection {
                            path: validated.content_for(source)?.0,
                            site,
                            origin,
                            candidates: vec![validated.candidate(destination)?],
                            basis: "prepared static target; runtime dispatch unverified",
                        });
                        continue;
                    }
                }
                if inferred || outgoing {
                    let definition_lane = if inferred {
                        "inference"
                    } else {
                        classification
                    };
                    if rendered_definitions.insert((definition_lane, edge.opposite.id.clone())) {
                        let definition = validated.candidate(&edge.opposite)?;
                        if inferred {
                            lanes.heuristic_definitions.push(definition);
                        } else if edge.kind == "references" {
                            lanes.referenced_functions.push(definition);
                        } else {
                            lanes.callees.push(definition);
                        }
                    }
                } else if let Some((line, call_text)) = ordinary_site {
                    let caller = CallerMatch {
                        path: opposite_path,
                        line,
                        calling_function: edge.opposite.qualified,
                        call_text,
                        caller_range: precise_site.as_ref().and_then(|site| site.owner_range).or(
                            Some((
                                edge.opposite.start,
                                edge.opposite
                                    .end
                                    .min(opposite_text.lines().count().try_into()?),
                            )),
                        ),
                        content: opposite_text,
                        site: precise_site,
                    };
                    if edge.kind == "references" {
                        lanes.function_references.push(caller);
                    } else {
                        lanes.callers.push(caller);
                    }
                }
            }
            let mut statement = connection.prepare("SELECT reference_kind,reference_name,status,line,col,candidates FROM unresolved_refs
        WHERE from_node_id=?1 AND (?2 OR reference_kind IN ('calls','function_ref')) ORDER BY line,col,id LIMIT 1001")?;
            let unresolved = statement
                .query_map(rusqlite::params![&target.id, relation.is_none()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, u32>(3)?,
                        row.get::<_, u32>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if unresolved.len() > CONNECTION_LIMIT {
                return Err("unresolved-reference bound exceeded".into());
            }
            for (kind, name, status, line, column, candidates) in unresolved {
                let status = if indexed && !matches!(status.as_str(), "pending" | "failed" | "ambiguous" | "resolved") { "unresolved".to_owned() } else { status };
                if kind == "function_ref" && relation != Some("callers") {
                    lanes.connection_notes.push(format!(
                "unresolved function reference {name:?}: status={status:?}; not a resolved call"
            ));
                } else if kind == "calls"
                    && relation != Some("callers")
                    && unresolved_calls.insert(name.clone())
                {
                    lanes.unresolved_callees.push(name.clone());
                }
                if !matches!(kind.as_str(), "calls" | "function_ref") && relation.is_none() {
                    lanes.connection_notes.push(format!("unresolved {kind} {name:?} at {}:{line}, column {column} (zero-based UTF-16); no target binding", target.file));
                }
                let mut unresolved = json!({"sourceNodeId":target.id,"filePath":target.file,"kind":kind,"name":name,"status":status,"line":line,"column":column});
                if !indexed {
                    unresolved["candidates"] = candidates.as_deref().map(serde_json::from_str::<Value>).transpose()?.unwrap_or(Value::Null);
                }
                unresolved_evidence.push(unresolved);
                projected_unresolved += 1;
                if projected_unresolved > CONNECTION_LIMIT {
                    return Err("combined unresolved-reference bound exceeded".into());
                }
            }
        }
        let comment_start = super::scope::leading_comment_start(
            &path,
            &text,
            (target.start, target.start_column),
            (target.end, target.end_column),
        );
        let mut bundle =
            LaneBundle::from_prepared(&matched, lanes, target.kind.clone(), comment_start);
        bundle.prepared_relation = relation.map(str::to_owned);
        let result = SearchResult {
            // The shared renderer selects by the live declaration's spelling;
            // graph qualification remains on target metadata, never the lane key.
            query: matched
                .def_name
                .clone()
                .unwrap_or_else(|| target.qualified.clone()),
            scope: if indexed { scope.into() } else { context.root.clone() },
            matches: vec![matched],
            sources: sources.clone(),
            total_found: 1,
            definitions: 1,
            usages: 0,
            facet_totals: FacetTotals {
                definitions: 1,
                ..FacetTotals::default()
            },
        };
        context.check()?;
        let returned_connections = evidence.len();
        cards.push(PreparedSearch {
        result,
        lanes: bundle,
        metadata: validated.metadata(json!({
        "status":"ok","relation":relation,"page":page,"limit":limit,"totalConnections":if relation.is_some() { total_connections } else { returned_connections },
        "returnedConnections":returned_connections,"omittedConnections":total_connections.saturating_sub(returned_connections),
        "nextPage":if relation.is_some() && offset.saturating_add(returned_connections) < total_connections { Some(page + 1) } else { None },
        "requestedScope":scope,"contextScope":context.root,
        "capturedFiles":captured_files,"targetId":target.id,"target":target,
        "positionEncoding":{"lineBase":1,"columnBase":0,"columnUnit":"UTF-16","nodeEndExclusive":true},
        "scope":"explicit captured files, not whole-project or runtime-dispatch proof","memberNodes":members,
        "relationshipScope":if relation.is_some() { "one graph identity; only the selected incoming or outgoing calls and marked function references" } else { "target and captured callable membership, including cross-file members; not runtime dispatch or signature satisfaction" },
        "connections":evidence,"unresolvedReferences":unresolved_evidence,
        "unresolvedReferenceScope":"outgoing unresolved sites owned by the selected graph target; not incoming-edge absence proof"})),
    });
    }
    if total_targets == 1 {
        let mut card = cards.pop().expect("one exact target was projected");
        card.metadata["unassociatedTargetCount"] = json!(unassociated_target_count);
        card.metadata["omittedUnassociatedTargets"] =
            json!(unassociated_target_count.saturating_sub(unassociated_targets.len()));
        card.metadata["extractionDiagnostics"] = json!(*validated.extraction_diagnostics.borrow());
        card.metadata["unassociatedTargets"] = json!(unassociated_targets);
        return Ok(Some(card));
    }
    let mut matches = Vec::new();
    let mut bundles = Vec::new();
    let mut metadata = Vec::new();
    for card in cards {
        matches.extend(card.result.matches);
        bundles.push(card.lanes);
        metadata.push(card.metadata);
    }
    Ok(Some(PreparedSearch {
        result: SearchResult {
            query: query.into(),
            scope: if indexed { scope.into() } else { context.root.clone() },
            matches,
            sources,
            total_found: total_targets,
            definitions: total_targets,
            usages: 0,
            facet_totals: FacetTotals {
                definitions: total_targets,
                ..FacetTotals::default()
            },
        },
        lanes: LaneBundle::from_prepared_cards(bundles),
        metadata: validated.metadata(json!({"capturedFiles":captured_files, "extractionDiagnostics":*validated.extraction_diagnostics.borrow(),
            "totalTargets":total_targets, "richTargets":metadata.len(), "omittedTargets":total_targets - metadata.len(),
            "unassociatedTargetCount":unassociated_target_count,"omittedUnassociatedTargets":unassociated_target_count.saturating_sub(unassociated_targets.len()),
            "targets":metadata, "unassociatedTargets":unassociated_targets, "scope":"exact captured identities; not runtime-dispatch or signature-satisfaction proof"})),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    mod projection;
    struct IndexedFixture {
        _directory: tempfile::TempDir,
        native: crate::dispatch::NativeSession,
        context: OperationContext,
        database: PathBuf,
        connection: Connection,
        arguments: Value,
    }

    impl IndexedFixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap().join("project");
            std::fs::create_dir(&root).unwrap();
            let database = directory.path().canonicalize().unwrap().join("graph.sqlite");
            let connection = Connection::open(&database).unwrap();
            connection.execute_batch("CREATE TABLE files(path TEXT PRIMARY KEY,content_hash TEXT,errors TEXT);
                CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,start_line INTEGER,end_line INTEGER,start_column INTEGER,end_column INTEGER);
                CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER,metadata TEXT,provenance TEXT);
                CREATE TABLE unresolved_refs(id INTEGER,from_node_id TEXT,reference_kind TEXT,reference_name TEXT,status TEXT,line INTEGER,col INTEGER,candidates TEXT,file_path TEXT NOT NULL DEFAULT '');").unwrap();
            for (file, name, text) in [
                ("target.ts", "Wanted", "function Wanted() { return 7; }\n"),
                ("caller.ts", "Caller", "function Caller() { return Wanted(); }\n"),
                ("unrelated.ts", "Unrelated", "function Unrelated() { return 1; }\n"),
            ] {
                std::fs::write(root.join(file), text).unwrap();
                connection.execute("INSERT INTO files VALUES (?1,?2,NULL)", rusqlite::params![file,format!("{:x}", Sha256::digest(text.as_bytes()))]).unwrap();
                connection.execute("INSERT INTO nodes VALUES (?1,'function',?1,?1,?2,1,1,0,?3)",
                    rusqlite::params![name,file,text.trim_end().encode_utf16().count() as u32]).unwrap();
            }
            connection.execute("INSERT INTO edges VALUES (1,'Caller','Wanted','calls',1,27,'{}','resolution')", []).unwrap();
            let native = crate::dispatch::NativeSession::new(&root, false).unwrap();
            let context = OperationContext::for_session(&native, crate::dispatch::ReadFormat::Plain, true);
            let arguments = indexed_arguments(&root, json!(["target.ts", "caller.ts", "unrelated.ts"]));
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&database, std::fs::Permissions::from_mode(0o600)).unwrap();
                std::fs::set_permissions(database.parent().unwrap(), std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            let fixture = Self { _directory:directory, native, context, database, connection, arguments };
            fixture.write_status(fixture.status());
            fixture
        }

        fn status(&self) -> Value {
            let root = indexed_path_identity(&self.context.root, false, true).unwrap();
            let directory = indexed_path_identity(self.database.parent().unwrap(), true, true).unwrap();
            let database = indexed_path_identity(&self.database, true, false).unwrap();
            json!({"format":"codeweave-pi.maintenance.1","kernelVersion":"0.1.0-codeweave-pi.5","state":"ready",
                "runId":"11111111-1111-4111-8111-111111111111","root":self.context.root,"rootDev":root.0,"rootIno":root.1,
                "directoryDev":directory.0,"directoryIno":directory.1,"databaseDev":database.0,"databaseIno":database.1,
                "policyDigest":self.arguments["corpusAdmission"]["policyDigest"],"corpusDigest":indexed_corpus_digest(&self.sources()).unwrap(),
                "counts":{"filesIndexed":3,"filesErrored":0}})
        }

        fn write_status(&self, status: Value) {
            use std::io::Write;
            let path = self.database.parent().unwrap().join("status-next.json");
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)] {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(&path).unwrap().write_all(&serde_json::to_vec(&status).unwrap()).unwrap();
            std::fs::rename(path, self.database.parent().unwrap().join("maintenance-status.json")).unwrap();
        }

        fn sources(&self) -> Arc<OperationSources> {
            Arc::new(OperationSources::from_arguments(&self.arguments, &self.context.root).unwrap())
        }

        fn ordinary_arguments(&self) -> Value {
            json!({"root":self.context.root,"scope":self.context.root,"query":"Wanted","kind":"symbol","expand":2,
                "retainRankedRender":true,"analysisDatabase":self.database,"analysisRevision":"codeweave-pi.maintenance.1",
                "corpusAdmission":self.arguments["corpusAdmission"],
                "analysisCorpusFiles":self.arguments["corpusAdmission"]["files"],
                "analysisPolicyDigest":self.arguments["corpusAdmission"]["policyDigest"]})
        }

        fn call(&self, arguments: &Value) -> std::result::Result<crate::output::ToolOutput, String> {
            crate::ops::tool_search_output(arguments, &self.native.cache, &self.native.session, &self.native.bloom, &self.context)
        }

        fn retry(&self, origin: &str) -> Value {
            let arguments = self.ordinary_arguments();
            let mut retry = json!({"renderRanked":origin,"rankedRenderAllowance":800});
            for key in ["root", "corpusAdmission", "analysisDatabase", "analysisRevision", "analysisCorpusFiles", "analysisPolicyDigest"] {
                retry[key] = arguments[key].clone();
            }
            retry
        }

        fn load(&self, sources: Arc<OperationSources>) -> Result<Option<PreparedSearch>> {
            load_indexed_run("Wanted", "", &self.arguments, &self.database, &self.context, sources)
        }
    }

    impl IndexedFixture {
        fn semantic_descriptor(&self) -> Value {
            json!({"format":"codeweave-pi.indexed-semantic.1", "runId":self.status()["runId"],
                "recipe":crate::semantic::recipe(), "dimensions":256, "status":"available", "reason":"complete",
                "examined":3,"unexamined":0,"represented":3,"missing":0,"unrepresented":0})
        }

        fn enable_semantics(&self) {
            self.connection.execute_batch("ALTER TABLE nodes ADD COLUMN semantic_input_digest TEXT;
                CREATE TABLE semantic_features(input_digest TEXT PRIMARY KEY,vector BLOB NOT NULL);
                CREATE TABLE project_metadata(key TEXT PRIMARY KEY,value TEXT);
                UPDATE nodes SET semantic_input_digest='shared';").unwrap();
            self.connection.execute("INSERT INTO semantic_features VALUES ('shared',?1)", [SemanticFixture::bytes()]).unwrap();
            self.set_semantics(self.semantic_descriptor());
        }

        fn set_semantics(&self, descriptor: Value) {
            self.connection.execute("INSERT OR REPLACE INTO project_metadata VALUES ('codeweave-pi.indexed-semantic.1',?1)", [descriptor.to_string()]).unwrap();
        }

        fn semantic_open(&self, sources: Arc<OperationSources>) -> Result<ValidatedAnalysis> {
            open_indexed("", &self.ordinary_arguments(), &self.database, &self.context, sources)
        }

        fn semantic_rank(&self, sources: Arc<OperationSources>) -> Result<(Vec<Match>, Value)> {
            rank_semantic(&self.semantic_open(sources)?, &SemanticFixture::vector(), &self.context.root, &self.context)
        }
    }

    #[test]
    fn indexed_semantic_vectors_keep_source_identity_scope_and_no_fabricated_generation() {
        let fixture = IndexedFixture::new();
        fixture.enable_semantics();
        let opposite = SemanticFixture::vector().iter().flat_map(|value| (-value).to_le_bytes()).collect::<Vec<_>>();
        fixture.connection.execute("INSERT INTO semantic_features VALUES ('opposite',?1)", [opposite]).unwrap();
        fixture.connection.execute("UPDATE nodes SET semantic_input_digest='opposite' WHERE id='Caller'", []).unwrap();
        let sources = fixture.sources();
        let (matches, metadata) = fixture.semantic_rank(sources.clone()).unwrap();
        assert_eq!(matches.len(), 3);
        assert_eq!(matches.last().unwrap().graph_node_id(), Some("Caller"), "stored-vector score, not row order");
        assert!(matches.iter().all(|matched| matched.syntax_key().is_some() && matched.graph_node_id().is_some() && !matched.exact));
        assert_eq!(metadata["complete"], true);
        assert_eq!(metadata["preparation"], fixture.semantic_descriptor());
        let publication = semantic_publication(&metadata).unwrap();
        for key in ["indexedRunId", "indexedStatusDigest", "policyDigest", "corpusDigest"] {
            assert_eq!(publication[key], fixture.load(sources.clone()).unwrap().unwrap().metadata[key]);
        }
        for key in ["generation", "captureDigest", "capturedFiles"] {
            assert!(metadata.get(key).is_none()); assert!(publication.get(key).is_none());
        }
        let (scoped, _) = rank_semantic(&fixture.semantic_open(fixture.sources()).unwrap(), &SemanticFixture::vector(),
            &fixture.context.root.join("target.ts"), &fixture.context).unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].graph_node_id(), Some("Wanted"));
    }

    #[test]
    fn indexed_semantic_missing_or_incompatible_objects_leave_structural_graph_usable() {
        let fixture = IndexedFixture::new();
        assert!(fixture.semantic_rank(fixture.sources()).is_err());
        assert!(fixture.load(fixture.sources()).unwrap().is_some());
        fixture.enable_semantics();
        fixture.connection.execute("DELETE FROM project_metadata", []).unwrap();
        assert!(fixture.semantic_rank(fixture.sources()).is_err());
        for (key, value) in [("format", json!("foreign")), ("runId", json!("22222222-2222-4222-8222-222222222222")),
            ("recipe", json!(null)), ("dimensions", json!(128)), ("status", json!("unavailable")),
            ("examined", json!(-1)), ("missing", json!(1)), ("reason", json!("unknown"))] {
            let mut descriptor = fixture.semantic_descriptor(); descriptor[key] = value;
            fixture.set_semantics(descriptor);
            assert!(fixture.semantic_rank(fixture.sources()).is_err(), "{key}");
            assert!(fixture.load(fixture.sources()).unwrap().is_some(), "structural {key}");
        }
        fixture.set_semantics(fixture.semantic_descriptor());
        fixture.connection.execute_batch("DROP TABLE semantic_features").unwrap();
        assert!(fixture.semantic_rank(fixture.sources()).is_err());
        assert!(fixture.load(fixture.sources()).unwrap().is_some());
    }

    #[test]
    fn indexed_semantic_schema_requires_nullable_text_binding_and_unique_typed_features() {
        for change in [
            "ALTER TABLE nodes DROP COLUMN semantic_input_digest",
            "ALTER TABLE nodes DROP COLUMN semantic_input_digest; ALTER TABLE nodes ADD COLUMN semantic_input_digest BLOB",
            "ALTER TABLE nodes DROP COLUMN semantic_input_digest; ALTER TABLE nodes ADD COLUMN semantic_input_digest TEXT NOT NULL DEFAULT ''",
            "DROP TABLE semantic_features; CREATE TABLE semantic_features(input_digest BLOB PRIMARY KEY,vector BLOB NOT NULL)",
            "DROP TABLE semantic_features; CREATE TABLE semantic_features(input_digest TEXT,vector BLOB NOT NULL)",
            "DROP TABLE semantic_features; CREATE TABLE semantic_features(input_digest TEXT UNIQUE,vector BLOB NOT NULL)",
            "DROP TABLE semantic_features; CREATE TABLE semantic_features(input_digest TEXT,vector BLOB NOT NULL,PRIMARY KEY(input_digest,vector))",
            "DROP TABLE semantic_features; CREATE TABLE semantic_features(input_digest TEXT PRIMARY KEY,vector TEXT NOT NULL)",
            "DROP TABLE semantic_features; CREATE TABLE semantic_features(input_digest TEXT PRIMARY KEY,vector BLOB)",
            "ALTER TABLE semantic_features ADD COLUMN extra TEXT",
        ] {
            let fixture = IndexedFixture::new(); fixture.enable_semantics();
            fixture.connection.execute_batch(change).unwrap();
            let sources = fixture.sources();
            let error = fixture.semantic_rank(sources.clone()).unwrap_err().to_string();
            assert!(error.contains("indexed semantic schema is missing or incompatible"), "{change}: {error}");
            assert!(sources.content_reads.lock().unwrap().is_empty(), "schema refusal precedes source reads");
            assert!(fixture.load(fixture.sources()).unwrap().is_some(), "structural graph remains usable: {change}");
        }
    }

    #[test]
    fn indexed_semantic_unavailable_coverage_is_retained_without_model_or_source_reads() {
        let fixture = IndexedFixture::new(); fixture.enable_semantics();
        for reason in ["budget", "model-unavailable", "native-unavailable"] {
            let mut descriptor = fixture.semantic_descriptor();
            descriptor["status"] = json!("unavailable"); descriptor["reason"] = json!(reason);
            descriptor["examined"] = json!(0); descriptor["unexamined"] = json!(3);
            descriptor["represented"] = json!(0); descriptor["unrepresented"] = json!(3);
            if reason == "native-unavailable" { descriptor["recipe"] = Value::Null; }
            fixture.set_semantics(descriptor.clone());
            let sources = fixture.sources();
            let (matches, metadata) = semantic_candidates("zxqv blorf", &fixture.ordinary_arguments(),
                &fixture.context.root, &fixture.context, sources.clone()).unwrap();
            assert!(matches.is_empty());
            assert_eq!(metadata["status"], "unavailable");
            assert_eq!(metadata["reason"], reason);
            assert_eq!(metadata["preparation"], descriptor);
            assert!(sources.content_reads.lock().unwrap().is_empty());
            assert_eq!(semantic_publication(&metadata).unwrap()["indexedRunId"], fixture.status()["runId"]);
            assert!(fixture.load(fixture.sources()).unwrap().is_some());
        }
    }

    #[test]
    fn indexed_semantic_checks_features_before_source_and_omits_only_stale_owners() {
        let fixture = IndexedFixture::new();
        fixture.enable_semantics();
        fixture.connection.execute("UPDATE nodes SET semantic_input_digest=NULL WHERE id='Unrelated'", []).unwrap();
        std::fs::remove_file(fixture.context.root.join("unrelated.ts")).unwrap();
        std::fs::write(fixture.context.root.join("target.ts"), "function Wanted() { return 8; }\n").unwrap();
        let sources = fixture.sources();
        let (matches, metadata) = fixture.semantic_rank(sources.clone()).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].graph_node_id(), Some("Caller"));
        assert_eq!(metadata["staleCandidates"], 1);
        assert_eq!(metadata["unrepresented"], 1);
        assert_eq!(metadata["status"], "partial");
        assert_eq!(metadata["complete"], false);
        assert!(!sources.content_reads.lock().unwrap().contains(&fixture.context.root.join("unrelated.ts")));
        fixture.connection.execute_batch("DROP TABLE files").unwrap();
        assert!(fixture.semantic_rank(fixture.sources()).is_err(), "storage integrity is not a stale omission");
    }

    #[test]
    fn indexed_semantic_source_and_candidate_bounds_disclose_unknown_tail() {
        let fixture = IndexedFixture::new();
        fixture.enable_semantics();
        std::fs::write(fixture.context.root.join("target.ts"), "x".repeat(CAPTURE_BYTES as usize + 1)).unwrap();
        let sources = fixture.sources();
        let (matches, metadata) = fixture.semantic_rank(sources.clone()).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(metadata["sourceCapped"], true);
        assert_eq!(metadata["complete"], false);
        assert_eq!(metadata["unexamined"], Value::Null);
        assert!(!sources.content_reads.lock().unwrap().contains(&fixture.context.root.join("target.ts")));
        fixture.connection.execute_batch("UPDATE nodes SET semantic_input_digest=NULL;
            WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<20000)
            INSERT INTO nodes SELECT 'extra'||n,kind,name,qualified_name,file_path,start_line,end_line,start_column,end_column,NULL FROM nodes,seq WHERE id='Wanted'").unwrap();
        let sources = fixture.sources();
        let (matches, metadata) = fixture.semantic_rank(sources.clone()).unwrap();
        assert!(matches.is_empty());
        assert_eq!(metadata["examined"], 20000);
        assert_eq!(metadata["capped"], true);
        assert_eq!(metadata["sourceCapped"], false);
        assert_eq!(metadata["unexamined"], Value::Null);
        assert!(sources.content_reads.lock().unwrap().is_empty());
    }

    #[test]
    fn indexed_semantic_preparation_partial_and_invalid_features_are_not_complete() {
        let fixture = IndexedFixture::new();
        fixture.enable_semantics();
        let mut descriptor = fixture.semantic_descriptor();
        descriptor["status"] = json!("partial"); descriptor["reason"] = json!("budget");
        descriptor["examined"] = json!(2); descriptor["unexamined"] = json!(1);
        descriptor["represented"] = json!(2); descriptor["unrepresented"] = json!(1);
        fixture.set_semantics(descriptor.clone());
        fixture.connection.execute("UPDATE nodes SET semantic_input_digest=NULL WHERE id='Unrelated'", []).unwrap();
        let (_, metadata) = fixture.semantic_rank(fixture.sources()).unwrap();
        assert_eq!(metadata["preparation"], descriptor);
        assert_eq!(metadata["complete"], false);
        fixture.connection.execute("UPDATE nodes SET semantic_input_digest='missing' WHERE id='Wanted'", []).unwrap();
        fixture.connection.execute("UPDATE semantic_features SET vector=X'00'", []).unwrap();
        let sources = fixture.sources();
        let (matches, metadata) = fixture.semantic_rank(sources.clone()).unwrap();
        assert!(matches.is_empty());
        assert_eq!(metadata["missingFeatures"], 1);
        assert_eq!(metadata["invalidFeatures"], 1);
        assert_eq!(metadata["unrepresented"], 1);
        assert!(sources.content_reads.lock().unwrap().is_empty());
    }

    #[test]
    fn indexed_semantic_status_and_admission_failures_are_not_stale_omissions() {
        for change in ["run", "status", "policy", "corpus"] {
            let fixture = IndexedFixture::new(); fixture.enable_semantics();
            let validated = fixture.semantic_open(fixture.sources()).unwrap();
            if change == "policy" {
                std::fs::write(fixture.context.root.join(".pi-navigation.json"), "{}").unwrap();
            } else {
                let mut status = fixture.status();
                match change {
                    "run" => status["runId"] = json!("22222222-2222-4222-8222-222222222222"),
                    "status" => status["state"] = json!("building"),
                    _ => status["corpusDigest"] = json!("b".repeat(64)),
                }
                fixture.write_status(status);
            }
            assert!(rank_semantic(&validated, &SemanticFixture::vector(), &fixture.context.root, &fixture.context).is_err(), "{change}");
        }
    }

    #[test]
    fn indexed_semantic_only_retention_pins_run_without_recollection() {
        let fixture = IndexedFixture::new(); fixture.enable_semantics();
        let sources = fixture.sources();
        let (matches, metadata) = fixture.semantic_rank(sources.clone()).unwrap();
        let mut lexical = super::super::fuzzy::search("zxqv blorf", &fixture.context.root, &[],
            crate::walk::Visibility::Project, sources, &fixture.context).unwrap();
        assert!(lexical.result.matches.is_empty());
        super::super::fuzzy::fuse_semantic(&mut lexical, matches);
        let publication = semantic_publication(&metadata).unwrap();
        assert_eq!(publication["connectionsStatus"], "unavailable");
        let mut arguments = fixture.ordinary_arguments();
        arguments["query"] = json!("zxqv blorf"); arguments["kind"] = json!("auto");
        let retained = super::super::continuation::RetainedRanked::new(fixture.context.root.clone(), &arguments,
            super::super::capture::Collection::Fuzzy { search:lexical, route:"behavior discovery", lanes:None },
            &json!({"query":"zxqv blorf", "visibility":"project", "analysis":publication})).unwrap();
        assert!(retained.descriptor()["analysis"].get("generation").is_none());
        let mut cursor = fixture.retry("private-test");
        cursor.as_object_mut().unwrap().remove("renderRanked"); cursor["cursor"] = json!("private-test");
        // SQL and model assets are deliberately unavailable on resume.
        fixture.connection.execute_batch("DROP TABLE semantic_features; DROP TABLE nodes; DROP TABLE project_metadata").unwrap();
        retained.validate(&cursor, &fixture.context).unwrap();
        let mut status = fixture.status(); status["runId"] = json!("22222222-2222-4222-8222-222222222222");
        fixture.write_status(status);
        assert!(retained.validate(&cursor, &fixture.context).unwrap_err().contains("indexed run changed"));
    }

    fn indexed_arguments(root: &Path, files: Value) -> Value {
        let policy = root.join(".pi-navigation.json");
        let digest = std::fs::read(&policy).ok().map(|bytes| format!("{:x}", Sha256::digest(bytes)));
        json!({"analysisRelation":"callers", "corpusAdmission":{"root":root,"files":files,
            "policyDigest":"a".repeat(64),"policyFiles":[{"path":policy,"digest":digest}]}})
    }

    #[test]
    fn indexed_public_cursor_continues_retained_source_with_fresh_admission() {
        let fixture = IndexedFixture::new();
        let mut source = "function Wanted() {\n".to_string();
        for index in 0..210 { source.push_str(&format!("  const step{index} = 'retained indexed source {index}';\n")); }
        source.push_str("  return 7;\n}\n");
        std::fs::write(fixture.context.root.join("target.ts"), &source).unwrap();
        fixture.connection.execute("UPDATE files SET content_hash=?1 WHERE path='target.ts'",
            [format!("{:x}", Sha256::digest(source.as_bytes()))]).unwrap();
        fixture.connection.execute("UPDATE nodes SET end_line=?1,end_column=1 WHERE id='Wanted'",
            [source.lines().count() as i64]).unwrap();
        let mut arguments = fixture.ordinary_arguments();
        arguments["rankedRenderAllowance"] = json!(800);
        let output = fixture.call(&arguments).unwrap();
        let id = output.structured["data"]["cursor"].as_str().expect("long selected source must retain a remainder");
        let mut next = fixture.retry(id);
        next.as_object_mut().unwrap().remove("renderRanked");
        next.as_object_mut().unwrap().remove("rankedRenderAllowance");
        next["cursor"] = json!(id);
        let searches = fixture.native.session.snapshot().searches;
        assert!(fixture.call(&json!({"cursor":id})).is_err(), "prepared cursor needs fresh admission");
        let page = fixture.call(&next).unwrap();
        assert_eq!(page.structured["data"]["analysis"]["indexedRunId"], fixture.status()["runId"]);
        assert_eq!(page.structured["data"]["scope"], json!(fixture.context.root));
        assert!(page.text.contains("Ranked continuation"));
        let replay = fixture.call(&next).unwrap();
        assert_eq!(page.structured, replay.structured);
        assert_eq!(page.text, replay.text);
        assert_eq!(fixture.native.session.snapshot().searches, searches);
        let mut status = fixture.status(); status["state"] = json!("failed"); fixture.write_status(status);
        assert!(fixture.call(&next).is_err(), "public cursor cannot outlive ready status");
    }

    #[test]
    fn indexed_ordinary_render_retains_identity_and_never_recollects_graph_rows() {
        let fixture = IndexedFixture::new();
        let arguments = fixture.ordinary_arguments();
        let output = fixture.call(&arguments).unwrap();
        let origin = output.ranked_render_cursor.as_ref().expect("ordinary indexed enrichment must support budget fitting");
        let analysis = &output.structured["data"]["analysis"];
        assert_eq!(analysis["indexedRunId"], fixture.status()["runId"]);
        assert_eq!(analysis["semanticStatus"], "unavailable");
        assert_eq!(analysis["continuationStatus"], "retained-evidence-only");
        assert!(analysis.get("generation").is_none() && analysis.get("captureDigest").is_none());
        assert!(output.text.contains("Prepared indexed run") && !output.text.contains("generation null"));
        assert!(output.text.contains("Continuation replays retained evidence only"));
        assert!(!output.text.contains("continuation unavailable"));
        assert!(!output.text.contains("Semantic retrieval unavailable"));
        let descriptor = fixture.native.session.cursor_owner_data(origin);
        assert_eq!(descriptor["rankedCursor"]["analysis"], json!({
            "indexedRunId":fixture.status()["runId"],"interpretationRevision":"codeweave-pi.maintenance.1",
            "policyDigest":fixture.status()["policyDigest"],"corpusDigest":fixture.status()["corpusDigest"]}));
        let searches = fixture.native.session.snapshot().searches;
        let retry = fixture.retry(origin);
        let before = fixture.call(&retry).unwrap();
        // A destructive fixture tripwire, not a supported producer operation:
        // continuation must use retained evidence, never reopen graph queries.
        fixture.connection.execute_batch("DROP TABLE edges; DROP TABLE nodes; DROP TABLE files; DROP TABLE unresolved_refs;").unwrap();
        let after = fixture.call(&retry).unwrap();
        assert_eq!(before.text, after.text);
        assert_eq!(before.structured, after.structured);
        assert_eq!(fixture.native.session.snapshot().searches, searches);
    }

    #[test]
    fn indexed_render_rejects_changed_failed_or_replaced_status_even_at_tiny_allowance() {
        for change in ["run", "failed", "building", "record", "replacement"] {
            let fixture = IndexedFixture::new();
            let output = fixture.call(&fixture.ordinary_arguments()).unwrap();
            let mut retry = fixture.retry(output.ranked_render_cursor.as_ref().unwrap());
            retry["rankedRenderAllowance"] = json!(1);
            let mut status = fixture.status();
            match change {
                "run" => status["runId"] = json!("22222222-2222-4222-8222-222222222222"),
                "failed" | "building" => status["state"] = json!(change),
                "record" => status["counts"]["filesIndexed"] = json!(2),
                _ => {}, // Identical bytes on a new inode are also a replacement.
            }
            fixture.write_status(status);
            let error = fixture.call(&retry).unwrap_err();
            assert!(error.contains("indexed"), "{change}: {error}");
        }
    }

    #[test]
    fn indexed_render_rejects_source_policy_and_current_census_drift() {
        for change in ["source", "policy", "census", "transport-census", "transport-policy"] {
            let fixture = IndexedFixture::new();
            let output = fixture.call(&fixture.ordinary_arguments()).unwrap();
            let mut retry = fixture.retry(output.ranked_render_cursor.as_ref().unwrap());
            match change {
                "source" => std::fs::write(fixture.context.root.join("caller.ts"), "function Caller() { return Missing(); }\n").unwrap(),
                "policy" => std::fs::write(fixture.context.root.join(".pi-navigation.json"), "{}").unwrap(),
                "census" => retry["corpusAdmission"]["files"] = json!(["target.ts", "caller.ts"]),
                "transport-census" => retry["analysisCorpusFiles"] = json!(["target.ts"]),
                _ => retry["analysisPolicyDigest"] = json!("b".repeat(64)),
            }
            assert!(fixture.call(&retry).is_err(), "accepted {change} drift");
        }
    }

    #[test]
    fn indexed_ordinary_loading_preserves_scope_case_and_live_owner_selection() {
        let mut fixture = IndexedFixture::new();
        let scope = fixture.context.root.join("nested");
        std::fs::create_dir(&scope).unwrap();
        let source = "function Wanted() { return 2; }\n";
        std::fs::write(scope.join("nested.ts"), source).unwrap();
        fixture.connection.execute("INSERT INTO files VALUES ('nested/nested.ts',?1,NULL)",
            [format!("{:x}", Sha256::digest(source.as_bytes()))]).unwrap();
        fixture.connection.execute("INSERT INTO nodes VALUES ('Nested','function','Wanted','Wanted','nested/nested.ts',1,1,0,?1)",
            [source.trim_end().encode_utf16().count() as i64]).unwrap();
        fixture.arguments["corpusAdmission"]["files"].as_array_mut().unwrap().push(json!("nested/nested.ts"));
        fixture.write_status(fixture.status());
        let arguments = fixture.ordinary_arguments();
        let scoped = load("wanted", false, "codeweave-pi.maintenance.1", &arguments, &scope, &fixture.database, &fixture.context, fixture.sources()).unwrap().unwrap();
        assert_eq!(scoped.metadata["targetId"], "Nested");
        assert_eq!(scoped.result.scope, scope);
        assert!(load("wanted", true, "codeweave-pi.maintenance.1", &arguments, &scope, &fixture.database, &fixture.context, fixture.sources()).unwrap().is_none());
        let aligned = load_for_live("Unrelated", true, "codeweave-pi.maintenance.1", &arguments, &fixture.context.root,
            &fixture.database, &fixture.context, fixture.sources(), &scoped.result).unwrap().unwrap();
        assert_eq!(aligned.metadata["targetId"], "Nested", "discovery words cannot replace live-selected owner");
        // Exercise the same scope and identity through ordinary dispatch + fitting.
        let mut ordinary = arguments.clone();
        ordinary["scope"] = json!(scope);
        ordinary["case"] = json!("insensitive");
        ordinary["query"] = json!("wanted");
        let output = fixture.call(&ordinary).unwrap();
        assert_eq!(output.structured["data"]["analysis"]["targetId"], "Nested");
        let mut live_arguments = ordinary.clone();
        for key in ["analysisDatabase", "analysisRevision", "analysisCorpusFiles", "analysisPolicyDigest"] {
            live_arguments.as_object_mut().unwrap().remove(key);
        }
        live_arguments["captureRanked"] = json!(true);
        let baseline = fixture.call(&live_arguments).unwrap();
        ordinary["resumeRanked"] = json!(baseline.search_capture.as_ref().unwrap());
        let searches = fixture.native.session.snapshot().searches;
        let enriched = fixture.call(&ordinary).unwrap();
        assert_eq!(enriched.structured["data"]["analysis"]["targetId"], "Nested");
        assert_eq!(fixture.native.session.snapshot().searches, searches, "handoff must not rediscover owners");
        let mut focused = arguments;
        focused["kind"] = json!("auto");
        focused["query"] = json!("Unrelated");
        focused["focus"] = json!({"target":format!("{}::Wanted", scope.join("nested.ts").display())});
        let output = fixture.call(&focused).unwrap();
        assert_eq!(output.structured["data"]["analysis"]["targetId"], "Nested");
    }

    #[test]
    fn indexed_revision_is_explicit_and_missing_semantics_and_graph_paging_stay_unavailable() {
        let fixture = IndexedFixture::new();
        let arguments = fixture.ordinary_arguments();
        assert!(load("Wanted", true, "legacy", &arguments, &fixture.context.root, &fixture.database, &fixture.context, fixture.sources()).is_err(),
            "legacy revision must not infer indexed identity from database shape");
        assert!(semantic_candidates("wanted", &arguments, &fixture.context.root, &fixture.context, fixture.sources()).is_err());
        let mut paging = arguments;
        paging["page"] = json!(2);
        assert!(fixture.call(&paging).unwrap_err().contains("graph paging"));
    }

    #[test]
    fn indexed_run_reuses_projection_without_capture_or_unselected_reads() {
        let fixture = IndexedFixture::new();
        // Stale unrelated source does not forbid selected evidence. Coverage
        // remains visible, but indexed diagnostic free text is never forwarded.
        std::fs::write(fixture.context.root.join("unrelated.ts"), "changed unrelated source").unwrap();
        fixture.connection.execute("UPDATE files SET errors=?1 WHERE path='target.ts'",
            [r#"[{"severity":"warning","message":"partial donor extraction","code":"donor-warning"}]"#]).unwrap();
        let sources = fixture.sources();
        let result = fixture.load(sources.clone()).unwrap().unwrap();
        assert_eq!(result.metadata["indexedRunId"], "11111111-1111-4111-8111-111111111111");
        assert_eq!(result.metadata["target"]["name"], "Wanted");
        assert_eq!(result.metadata["returnedConnections"], 1);
        assert!(result.result.matches[0].syntax_key().is_some(), "exact current source association");
        assert_eq!(result.metadata["connections"][0]["source"], "Caller");
        assert_eq!(result.metadata["connections"][0]["target"], "Wanted");
        assert!(!result.metadata["extractionDiagnostics"].as_array().unwrap().is_empty());
        for key in ["generation", "captureDigest", "capturedFiles", "nextPage"] {
            assert!(result.metadata.get(key).is_none(), "no fabricated {key}");
        }
        assert_eq!(result.metadata["semanticStatus"], "unavailable");
        assert_eq!(result.metadata["continuationStatus"], "retained-evidence-only");
        assert_eq!(result.metadata["interpretationRevision"], "codeweave-pi.maintenance.1");
        let reads = sources.content_reads.lock().unwrap();
        assert!(reads.contains(&fixture.context.root.join("target.ts")));
        assert!(reads.contains(&fixture.context.root.join("caller.ts")));
        assert!(!reads.contains(&fixture.context.root.join("unrelated.ts")));
    }

    #[test]
    fn indexed_run_refuses_changed_or_excluded_source_and_rechecks_cached_policy() {
        let mut fixture = IndexedFixture::new();
        let sources = fixture.sources();
        fixture.load(sources.clone()).unwrap().unwrap();
        std::fs::write(fixture.context.root.join("target.ts"), "function Wanted() { return 8; }\n").unwrap();
        assert!(fixture.load(fixture.sources()).err().unwrap().to_string().contains("indexed source changed"));
        assert!(fixture.load(sources.clone()).err().unwrap().to_string().contains("source changed"), "cached bytes are re-read before returning");
        std::fs::write(fixture.context.root.join("target.ts"), "function Wanted() { return 7; }\n").unwrap();
        fixture.arguments["corpusAdmission"]["files"] = json!(["target.ts"]);
        let restricted = fixture.sources();
        assert!(fixture.load(restricted.clone()).is_err());
        assert!(!restricted.content_reads.lock().unwrap().contains(&fixture.context.root.join("caller.ts")), "excluded contents never read");
        let before = sources.content_reads.lock().unwrap().clone();
        std::fs::write(fixture.context.root.join(".pi-navigation.json"), "{}").unwrap();
        assert!(fixture.load(sources.clone()).is_err());
        assert_eq!(*sources.content_reads.lock().unwrap(), before, "policy failure precedes cached evidence reuse");
    }

    #[test]
    fn indexed_run_cannot_enable_graph_paging_or_bypass_admission() {
        let mut fixture = IndexedFixture::new();
        assert!(fixture.load(Arc::default()).is_err());
        for (key, value) in [("cursor", json!("fake")), ("page", json!(2))] {
            fixture.arguments[key] = value;
            assert!(fixture.load(fixture.sources()).err().unwrap().to_string().contains("unavailable"));
            fixture.arguments.as_object_mut().unwrap().remove(key);
        }
        fixture.arguments["analysisModelDirectory"] = json!("unused");
        assert!(fixture.load(fixture.sources()).is_ok(), "model directory does not disable structural graph");
        let inside = fixture.context.root.join("inside.sqlite");
        std::fs::copy(&fixture.database, &inside).unwrap();
        assert!(load_indexed_run("Wanted", "run", &fixture.arguments, &inside, &fixture.context, fixture.sources())
            .err().unwrap().to_string().contains("outside source"));
    }

    #[test]
    fn indexed_status_refuses_missing_interrupted_foreign_and_incompatible_records() {
        let fixture = IndexedFixture::new();
        let path = fixture.database.parent().unwrap().join("maintenance-status.json");
        std::fs::remove_file(&path).unwrap();
        assert!(fixture.load(fixture.sources()).is_err());
        for (key, value) in [
            ("state", json!("building")), ("state", json!("failed")), ("format", json!("foreign")),
            ("kernelVersion", json!("future")), ("runId", json!("caller-label")),
            ("root", json!(fixture.database.parent().unwrap())), ("rootIno", json!(0)),
            ("directoryIno", json!(0)), ("databaseIno", json!(0)), ("databaseDev", Value::Null),
            ("policyDigest", json!("b".repeat(64))), ("corpusDigest", json!("b".repeat(64))),
            ("counts", json!({"private-symbol":1})), ("counts", json!({"filesIndexed":-1})),
        ] {
            let mut status = fixture.status();
            status[key] = value;
            fixture.write_status(status);
            assert!(fixture.load(fixture.sources()).is_err(), "must refuse {key}");
        }
        fixture.write_status(fixture.status());
        assert!(load_indexed_run("Wanted", "22222222-2222-4222-8222-222222222222", &fixture.arguments,
            &fixture.database, &fixture.context, fixture.sources()).is_err(), "caller cannot relabel provenance");
        fixture.load(fixture.sources()).unwrap().unwrap();
        std::fs::write(&path, vec![b' '; 16 * 1024 + 1]).unwrap();
        assert!(fixture.load(fixture.sources()).is_err());
        #[cfg(unix)] {
            use std::os::unix::fs::{symlink, PermissionsExt};
            fixture.write_status(fixture.status());
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(fixture.load(fixture.sources()).is_err());
            fixture.write_status(fixture.status());
            let other = path.with_file_name("other-status.json");
            std::fs::rename(&path, &other).unwrap();
            symlink(&other, &path).unwrap();
            assert!(fixture.load(fixture.sources()).is_err());
            std::fs::remove_file(&path).unwrap();
            std::fs::hard_link(&other, &path).unwrap();
            assert!(fixture.load(fixture.sources()).is_err());
        }
    }

    #[test]
    fn indexed_run_complete_intervening_run_invalidates_snapshot_and_cached_source() {
        let fixture = IndexedFixture::new();
        let sources = fixture.sources();
        let status = read_indexed_status(&fixture.database, &fixture.context.root, &sources).unwrap();
        let connection = open_read_snapshot(&fixture.database, &fixture.context).unwrap();
        validate_indexed_paths(&connection, &sources, &fixture.context).unwrap();
        let validated = ValidatedAnalysis { connection, identity: AnalysisIdentity::Indexed(IndexedRun {
            root: fixture.context.root.clone(), database: fixture.database.clone(), status, sources: sources.clone(),
        }), contents: RefCell::default(), extraction_diagnostics: RefCell::default(), source_facts: RefCell::default() };
        let target = validated.connection.query_row("SELECT id,kind,name,qualified_name,file_path,start_line,end_line,start_column,end_column FROM nodes WHERE id='Wanted'", [], node).unwrap();
        validated.content_for(&target).unwrap();
        project_graph("Wanted", true, &fixture.arguments, &fixture.context.root, &fixture.context, sources.clone(), None, &validated).unwrap().unwrap();
        let mut next = fixture.status();
        next["runId"] = json!("22222222-2222-4222-8222-222222222222");
        next["state"] = json!("building");
        fixture.write_status(next.clone());
        next["state"] = json!("ready");
        fixture.write_status(next);
        assert!(validated.validate_indexed_run().is_err(), "a whole intervening run cannot masquerade as unchanged readiness");
        assert!(validated.content_for(&target).is_err(), "cached source cannot bypass the pinned run");
        fixture.load(fixture.sources()).unwrap().unwrap();
    }

    #[test]
    fn indexed_listing_digest_is_set_ordered_utf8_nul_delimited_not_source_currency() {
        let mut fixture = IndexedFixture::new();
        let original = indexed_corpus_digest(&fixture.sources()).unwrap();
        let expected = format!("{:x}", Sha256::digest(b"caller.ts\0target.ts\0unrelated.ts\0"));
        assert_eq!(original, expected);
        fixture.arguments["corpusAdmission"]["files"] = json!(["unrelated.ts", "target.ts", "caller.ts"]);
        assert_eq!(original, indexed_corpus_digest(&fixture.sources()).unwrap());
        fixture.load(fixture.sources()).unwrap().unwrap();
        fixture.arguments["corpusAdmission"]["files"] = json!(["caller.ts", "target.ts", "unrelated.ts", "new.ts"]);
        let sources = fixture.sources();
        assert!(fixture.load(sources.clone()).err().unwrap().to_string().contains("listing changed"));
        assert!(sources.content_reads.lock().unwrap().is_empty());
    }

    #[test]
    fn indexed_snapshot_rejects_excluded_sixth_candidate_before_counts_or_reads() {
        let fixture = IndexedFixture::new();
        for index in 0..4 {
            fixture.connection.execute("INSERT INTO nodes SELECT ?1,kind,name,qualified_name,file_path,start_line,end_line,start_column,end_column FROM nodes WHERE id='Wanted'", [format!("extra-{index}")]).unwrap();
        }
        fixture.connection.execute("INSERT INTO nodes VALUES ('secret','function','Wanted','SECRET_QUALIFIED','zzz-excluded.ts',1,1,0,1)", []).unwrap();
        let mut args = fixture.arguments.clone();
        args.as_object_mut().unwrap().remove("analysisRelation");
        let sources = fixture.sources();
        let error = load_indexed_run("Wanted", "", &args, &fixture.database, &fixture.context, sources.clone()).err().unwrap().to_string();
        assert!(error.contains("ineligible paths"));
        assert!(!error.contains("SECRET") && !error.contains("excluded.ts"));
        assert!(sources.content_reads.lock().unwrap().is_empty());
    }

    #[test]
    fn indexed_snapshot_checks_file_ref_paths_and_dangling_owners() {
        let fixture = IndexedFixture::new();
        fixture.connection.execute("INSERT INTO files VALUES ('excluded.ts','unused',NULL)", []).unwrap();
        assert!(fixture.load(fixture.sources()).is_err());
        fixture.connection.execute("DELETE FROM files WHERE path='excluded.ts'", []).unwrap();
        fixture.connection.execute("INSERT INTO unresolved_refs VALUES (1,'Wanted','calls','Unknown','failed',1,0,NULL,'')", []).unwrap();
        fixture.load(fixture.sources()).unwrap().unwrap(); // Legitimate empty denormalized path uses its owner.
        fixture.connection.execute("UPDATE unresolved_refs SET file_path='excluded.ts'", []).unwrap();
        assert!(fixture.load(fixture.sources()).is_err());
        fixture.connection.execute("UPDATE unresolved_refs SET file_path='target.ts',from_node_id='missing'", []).unwrap();
        assert!(fixture.load(fixture.sources()).is_err());
        fixture.connection.execute("DELETE FROM unresolved_refs", []).unwrap();
        fixture.connection.execute("UPDATE edges SET target='missing'", []).unwrap();
        assert!(fixture.load(fixture.sources()).is_err());
    }

    #[test]
    fn indexed_output_withholds_opaque_payloads_and_metadata_derived_notes() {
        let mut fixture = IndexedFixture::new();
        fixture.arguments.as_object_mut().unwrap().remove("analysisRelation");
        fixture.connection.execute("UPDATE edges SET metadata=?1,provenance='SECRET_PROVENANCE'", [r#"{"refName":"SECRET_REFERENCE","resolvedBy":"SECRET_RESOLVER","extra":"SECRET_METADATA"}"#]).unwrap();
        fixture.connection.execute("UPDATE files SET errors='SECRET_DIAGNOSTIC' WHERE path='target.ts'", []).unwrap();
        fixture.connection.execute("INSERT INTO unresolved_refs VALUES (1,'Wanted','function_ref','Unknown','SECRET_STATUS',1,0,'SECRET_CANDIDATES','')", []).unwrap();
        let result = fixture.load(fixture.sources()).unwrap().unwrap();
        assert!(!result.metadata.to_string().contains("SECRET"));
        assert!(result.metadata["connections"][0].get("metadata").is_none());
        assert!(result.metadata["unresolvedReferences"][0].get("candidates").is_none());
        assert!(!format!("{:?}", result.lanes).contains("SECRET"), "rendered lanes cannot retain metadata-derived free text");
        assert_eq!(result.metadata["indexedRunCounts"]["filesIndexed"], 3.0);
    }

    /// Parent supplies a closed donor-maintained database and admitted fixture
    /// paths. No graph mutation or source mutation occurs in this integration.
    #[test]
    #[ignore = "requires DEEPFIELD_DONOR_PROBE_MANIFEST from the isolated donor maintainer"]
    fn indexed_run_external_donor_probe() {
        let manifest = std::env::var("DEEPFIELD_DONOR_PROBE_MANIFEST").expect("probe manifest path");
        let manifest: Value = serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
        let root = PathBuf::from(manifest["root"].as_str().unwrap());
        let database = PathBuf::from(manifest["database"].as_str().unwrap());
        assert_eq!(root.canonicalize().unwrap(), root);
        let mut arguments = indexed_arguments(&root, manifest["files"].clone());
        arguments["corpusAdmission"]["policyDigest"] = manifest["policyDigest"].clone();
        let native = crate::dispatch::NativeSession::new(&root, false).unwrap();
        let context = OperationContext::for_session(&native, crate::dispatch::ReadFormat::Plain, true);
        let sources = Arc::new(OperationSources::from_arguments(&arguments, &root).unwrap());
        let result = load_indexed_run(manifest["query"].as_str().unwrap(), manifest["runId"].as_str().unwrap(),
            &arguments, &database, &context, sources).unwrap().expect("indexed target");
        assert_eq!(result.metadata["status"], "ok", "{}", result.metadata);
        assert_eq!(result.metadata["indexedRunId"], manifest["runId"]);
        assert!(result.result.matches.iter().any(|matched| matched.syntax_key().is_some()), "current source identity must associate");
        let expected = &manifest["expectedRelationship"];
        assert!(result.metadata["connections"].as_array().unwrap().iter().any(|edge|
            edge["sourceNode"]["name"] == expected["sourceName"] && edge["targetNode"]["name"] == expected["targetName"] && edge["kind"] == expected["kind"]), "{}", result.metadata);
        assert!(result.metadata.get("captureDigest").is_none());
        assert_eq!(result.metadata["continuationStatus"], "unavailable");
        println!("{}", result.metadata);
    }
    use std::sync::atomic::AtomicBool;

    struct SemanticFixture {
        _directory: tempfile::TempDir,
        native: crate::dispatch::NativeSession,
        context: OperationContext,
        database: PathBuf,
        connection: Connection,
        sources: Arc<OperationSources>,
        arguments: Value,
    }

    impl SemanticFixture {
        fn new(files: &[(&str, &str, &str)]) -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap().join("project");
            std::fs::create_dir(&root).unwrap();
            let database = root.parent().unwrap().join("semantic.sqlite");
            let connection = Connection::open(&database).unwrap();
            connection.execute_batch("CREATE TABLE project_metadata(key TEXT,value TEXT);
                CREATE TABLE schema_versions(version INTEGER);
                CREATE TABLE nodes_fts(name TEXT);
                CREATE TABLE name_segment_vocab(name TEXT);
                CREATE TABLE files(path TEXT,content_hash TEXT,errors TEXT);
                CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,start_line INTEGER,end_line INTEGER,start_column INTEGER,end_column INTEGER,semantic_input_digest TEXT);
                CREATE TABLE semantic_features(input_digest TEXT PRIMARY KEY,vector BLOB);
                CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER,metadata TEXT,provenance TEXT);
                CREATE TABLE unresolved_refs(from_node_id TEXT,reference_kind TEXT,reference_name TEXT,status TEXT,line INTEGER,col INTEGER,candidates TEXT,id INTEGER);").unwrap();
            let mut manifest = Vec::new();
            let mut canonical = Vec::new();
            for &(file, language, text) in files {
                std::fs::create_dir_all(root.join(file).parent().unwrap()).unwrap();
                std::fs::write(root.join(file), text).unwrap();
                let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
                connection.execute("INSERT INTO files VALUES (?1,?2,NULL)", [file, &digest]).unwrap();
                manifest.push(json!({"path":file,"language":language,"digest":digest}));
                canonical.push(json!([file,language,digest]));
            }
            let metadata = json!({"root":root,"generation":1,"kernelVersion":"0.1.0-codeweave-pi.5",
                "interpretationRevision":"semantic-test","captureDigest":format!("{:x}",Sha256::digest(serde_json::to_vec(&canonical).unwrap())),
                "sources":manifest,"semantic":{"recipe":crate::semantic::recipe(),"dimensions":256}});
            connection.execute("INSERT INTO project_metadata VALUES ('codeweave-pi.g1',?1)", [metadata.to_string()]).unwrap();
            let arguments = json!({"analysisDatabase":database,"analysisRevision":"semantic-test",
                "analysisCorpusFiles":files.iter().map(|(file,_,_)| *file).collect::<Vec<_>>()});
            let native = crate::dispatch::NativeSession::new(&root, false).unwrap();
            let context = OperationContext::for_session(&native, crate::dispatch::ReadFormat::Plain, true);
            Self { _directory:directory, native, context, database, connection, sources:Arc::default(), arguments }
        }

        fn add(&self, id: &str, file: &str, name: &str, snippet: &str, input: Option<&str>, vector: Option<&[u8]>) {
            let text = std::fs::read_to_string(self.context.root.join(file)).unwrap();
            let start = text.find(snippet).unwrap();
            let end = start + snippet.len();
            let position = |byte: usize| (text[..byte].bytes().filter(|b| *b == b'\n').count() + 1,
                text[text[..byte].rfind('\n').map_or(0, |at| at + 1)..byte].encode_utf16().count());
            let (line, column) = position(start);
            let (end_line, end_column) = position(end);
            self.connection.execute("INSERT INTO nodes VALUES (?1,'function',?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![id,name,format!("Owner::{name}"),file,line as i64,end_line as i64,column as i64,end_column as i64,input]).unwrap();
            if let (Some(input), Some(vector)) = (input, vector) {
                self.connection.execute("INSERT OR IGNORE INTO semantic_features VALUES (?1,?2)", rusqlite::params![input,vector]).unwrap();
            }
        }

        fn validated(&self) -> ValidatedAnalysis {
            open_capture("semantic-test", &self.arguments, &self.database, &self.context, &self.sources).unwrap()
        }

        fn vector() -> Vec<f32> { let mut vector = vec![0.0; 256]; vector[0] = 1.0; vector }
        fn bytes() -> Vec<u8> { Self::vector().iter().flat_map(|value| value.to_le_bytes()).collect() }
    }

    #[test]
    fn prepared_initialized_store_reports_unpublished_without_accepting_incomplete_publications() {
        let fixture = SemanticFixture::new(&[]);
        // Exact initialization shape from analysis-project.mjs: no source manifest yet.
        let initialized = json!({"root":fixture.context.root,"generation":0,
            "kernelVersion":"0.1.0-codeweave-pi.5","interpretationRevision":"codeweave-pi.analysis.5"});
        let check = |metadata: &Value| {
            fixture.connection.execute("UPDATE project_metadata SET value=?1", [metadata.to_string()]).unwrap();
            open_capture("codeweave-pi.analysis.5", &fixture.arguments, &fixture.database, &fixture.context, &fixture.sources)
                .err().expect("initialization is not a prepared publication").to_string()
        };
        assert_eq!(check(&initialized), "project has not published a generation");
        for (key, value) in [("generation", json!(1)), ("generation", json!(null)),
            ("root", json!(fixture.context.root.join("foreign"))), ("kernelVersion", json!("foreign")),
            ("interpretationRevision", json!("foreign"))] {
            let mut invalid = initialized.clone(); invalid[key] = value;
            assert_ne!(check(&invalid), "project has not published a generation", "misclassified invalid {key}");
        }
        fixture.connection.execute_batch("DROP TABLE nodes_fts").unwrap();
        assert!(check(&initialized).contains("incomplete analysis schema"));
        let mut nonzero = initialized; nonzero["generation"] = json!(1);
        assert!(check(&nonzero).contains("incomplete analysis schema"));
    }

    #[test]
    fn prepared_capture_preserves_schema_generation_and_metadata_bounds() {
        let fixture = SemanticFixture::new(&[]);
        let raw: String = fixture.connection.query_row("SELECT value FROM project_metadata", [], |row| row.get(0)).unwrap();
        let original: Value = serde_json::from_str(&raw).unwrap();
        let check = || open_capture("semantic-test", &fixture.arguments, &fixture.database, &fixture.context, &fixture.sources);
        for table in ["schema_versions", "nodes", "edges", "files", "unresolved_refs", "nodes_fts", "name_segment_vocab"] {
            fixture.connection.execute_batch(&format!("ALTER TABLE {table} RENAME TO withheld_table")).unwrap();
            assert!(check().err().unwrap().to_string().contains(&format!("missing {table}")));
            fixture.connection.execute_batch(&format!("ALTER TABLE withheld_table RENAME TO {table}")).unwrap();
        }
        for (generation, accepted) in [(json!(0), false), (json!(-1), false), (json!(1.5), false),
            (json!(9_007_199_254_740_991_u64), true), (json!(9_007_199_254_740_992_u64), false)] {
            let mut metadata = original.clone(); metadata["generation"] = generation.clone();
            fixture.connection.execute("UPDATE project_metadata SET value=?1", [metadata.to_string()]).unwrap();
            assert_eq!(check().is_ok(), accepted, "generation {generation}");
        }
        for (length, accepted) in [(8_388_608, true), (8_388_609, false)] {
            let metadata = format!("{raw}{}", " ".repeat(length - raw.len()));
            fixture.connection.execute("UPDATE project_metadata SET value=?1", [metadata]).unwrap();
            assert_eq!(check().is_ok(), accepted, "metadata SQL length {length}");
        }
    }

    #[test]
    fn prepared_admission_pins_optional_publication_policy_before_refitting() {
        let text = "function Wanted() { return 7; }\n";
        let mut fixture = SemanticFixture::new(&[("target.ts", "typescript", text)]);
        fixture.add("wanted", "target.ts", "Wanted", text.trim(), None, None);
        let policy = fixture.context.root.join(".pi-navigation.json");
        std::fs::write(&policy, "{}").unwrap();
        let digest = "a".repeat(64);
        fixture.arguments["corpusAdmission"] = json!({"root":fixture.context.root,"files":["target.ts"],
            "policyDigest":digest,"policyFiles":[{"path":policy,"digest":format!("{:x}", Sha256::digest(b"{}"))}]});
        fixture.sources = Arc::new(OperationSources::from_arguments(&fixture.arguments, &fixture.context.root).unwrap());
        let raw: String = fixture.connection.query_row("SELECT value FROM project_metadata", [], |row| row.get(0)).unwrap();
        let original: Value = serde_json::from_str(&raw).unwrap();
        let call = |args: &Value| crate::ops::tool_search_output(args, &fixture.native.cache, &fixture.native.session, &fixture.native.bloom, &fixture.context);
        for stamped in [false, true] {
            let mut metadata = original.clone();
            if stamped { metadata["policyDigest"] = json!(digest); }
            fixture.connection.execute("UPDATE project_metadata SET value=?1", [metadata.to_string()]).unwrap();
            let mut args = fixture.arguments.clone();
            args["query"] = json!("Wanted"); args["kind"] = json!("symbol"); args["scope"] = json!(fixture.context.root);
            args["retainRankedRender"] = json!(true);
            let first = call(&args).unwrap();
            assert_eq!(first.structured["data"]["analysis"]["generation"], 1);
            assert_eq!(first.structured["data"]["analysis"]["policyDigest"], metadata["policyDigest"]);
            let origin = first.ranked_render_cursor.as_ref().unwrap();
            let retained = fixture.native.session.get_ranked_cursor(origin).unwrap();
            assert_eq!(retained.evidence.descriptor()["analysis"]["policyDigest"], metadata["policyDigest"]);
            let searches = fixture.native.session.snapshot().searches;
            let mut retry = fixture.arguments.clone(); retry["renderRanked"] = json!(origin);
            for allowance in [1, 1000] {
                retry["rankedRenderAllowance"] = json!(allowance);
                call(&retry).unwrap();
            }
            // Both publications are currently admitted. Only the frozen stamp
            // distinguishes them; generation and the source manifest stay fixed.
            if stamped { metadata.as_object_mut().unwrap().remove("policyDigest"); }
            else { metadata["policyDigest"] = json!(digest); }
            fixture.connection.execute("UPDATE project_metadata SET value=?1", [metadata.to_string()]).unwrap();
            for allowance in [1, 1000] {
                retry["rankedRenderAllowance"] = json!(allowance);
                assert!(call(&retry).err().unwrap().contains("publication changed"));
            }
            assert_eq!(fixture.native.session.snapshot().searches, searches);
            assert_eq!(retained.progress, super::super::continuation::Progress::default());
        }
        let mut metadata = original;
        metadata["policyDigest"] = json!("b".repeat(64));
        fixture.connection.execute("UPDATE project_metadata SET value=?1", [metadata.to_string()]).unwrap();
        assert!(open_capture("semantic-test", &fixture.arguments, &fixture.database, &fixture.context, &fixture.sources)
            .err().unwrap().to_string().contains("corpus policy version"));
    }

    #[test]
    fn semantic_omitted_twin_keeps_distinct_edges_on_one_syntax_card() {
        let text = "/*😀*/ fn persist() { left(); right(); }\nfn left() {}\nfn right() {}\n";
        let fixture = SemanticFixture::new(&[("main.rs","rust",text)]);
        fixture.add("a","main.rs","persist","fn persist() { left(); right(); }",Some("input"),Some(&SemanticFixture::bytes()));
        // The twin has no vector: it cannot enter the semantic result's collision check.
        fixture.add("b","main.rs","persist","fn persist() { left(); right(); }",None,None);
        fixture.add("left","main.rs","left","fn left() {}",None,None);
        fixture.add("right","main.rs","right","fn right() {}",None,None);
        for (id, source, target) in [(101,"a","left"),(102,"b","right")] {
            let column = text[..text.find(&format!("{target}();")).unwrap()].encode_utf16().count() as i64;
            fixture.connection.execute("INSERT INTO edges VALUES (?1,?2,?3,'calls',1,?4,'{}',NULL)",
                rusqlite::params![id,source,target,column]).unwrap();
        }
        let (semantic, _) = rank_semantic(&fixture.validated(), &SemanticFixture::vector(), &fixture.context.root, &fixture.context).unwrap();
        assert_eq!(semantic.len(), 1);
        let mut lexical = super::super::fuzzy::search("persist delivery", &fixture.context.root, &[], crate::walk::Visibility::Project, fixture.sources.clone(), &fixture.context).unwrap();
        super::super::fuzzy::fuse_semantic(&mut lexical, semantic);
        assert_eq!(lexical.result.matches.len(), 1);
        assert_eq!(lexical.result.matches[0].graph_node_id(), Some("a"));
        let load = |live: &SearchResult| load_for_live("persist delivery", false, "semantic-test", &fixture.arguments,
            &fixture.context.root, &fixture.database, &fixture.context, fixture.sources.clone(), live).unwrap().unwrap();
        let prepared = load(&lexical.result);
        let edges = |metadata: &Value| metadata["targets"].as_array()
            .map(|targets| targets.iter().collect::<Vec<_>>()).unwrap_or_else(|| vec![metadata]).into_iter()
            .flat_map(|target| target["connections"].as_array().unwrap())
            .map(|edge| edge["edgeId"].as_i64().unwrap()).collect::<std::collections::BTreeSet<_>>();
        assert_eq!(edges(&prepared.metadata), std::collections::BTreeSet::from([101,102]));
        let target = &lexical.result.matches[0];
        let mut lanes = LaneBundle::from_prepared(target, SymbolLanes::default(), "function".into(), None);
        lanes.enrich(prepared.lanes);
        let names = lanes.get(target).unwrap().connections.iter().flat_map(|connection| &connection.candidates)
            .map(|candidate| candidate.name.as_str()).collect::<HashSet<_>>();
        assert!(names.contains("Owner::left") && names.contains("Owner::right"), "both captured sites must reach the same source card: {names:?}");
        // Without an exact syntax association the graph ID remains an isolation boundary.
        lexical.result.matches[0].source_association.as_mut().unwrap().syntax = None;
        assert_eq!(edges(&load(&lexical.result).metadata), std::collections::BTreeSet::from([101]));
    }

    #[test]
    fn semantic_scope_counts_missing_invalid_and_excluded_inputs() {
        let text = "/*😀*/ fn persist() {} fn later() {} fn missing() {} fn invalid() {}\n#[cfg(test)]\nmod tests { fn hidden() {} }\n";
        let fixture = SemanticFixture::new(&[("src/main.rs","rust",text), ("elsewhere/other.rs","rust",text), ("src/ignored.test.rs","rust",text)]);
        let vector = SemanticFixture::bytes();
        fixture.add("good","src/main.rs","persist","fn persist() {}",Some("good"),Some(&vector));
        fixture.add("unrepresented","src/main.rs","later","fn later() {}",None,None);
        fixture.add("missing","src/main.rs","missing","fn missing() {}",Some("missing"),None);
        fixture.add("invalid","src/main.rs","invalid","fn invalid() {}",Some("invalid"),Some(&[0]));
        fixture.add("hidden","src/main.rs","hidden","fn hidden() {}",Some("good"),Some(&vector));
        fixture.add("outside","elsewhere/other.rs","persist","fn persist() {}",Some("good"),Some(&vector));
        fixture.add("test-file","src/ignored.test.rs","persist","fn persist() {}",Some("good"),Some(&vector));
        let (matches, metadata) = rank_semantic(&fixture.validated(), &SemanticFixture::vector(), &fixture.context.root.join("src"), &fixture.context).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].graph_node_id(), Some("good"));
        assert!(matches[0].syntax_key().is_some());
        assert!(!matches[0].exact);
        assert_eq!(metadata["examined"], 4);
        assert_eq!(metadata["unrepresented"], 1);
        assert_eq!(metadata["missingFeatures"], 1);
        assert_eq!(metadata["invalidFeatures"], 1);
        assert_eq!(metadata["excludedTestScopes"], 1);
        assert_eq!(metadata["complete"], false);
        assert_eq!(metadata["capped"], false);
    }

    #[test]
    fn semantic_recall_retains_more_than_the_compact_presentation_limit() {
        let text = (0..137).map(|i| format!("fn owner{i}() {{}}\n")).collect::<String>();
        let fixture = SemanticFixture::new(&[("main.rs","rust",&text)]);
        fixture.connection.execute_batch("BEGIN").unwrap();
        for i in 0..137 { fixture.add(&format!("owner{i}"),"main.rs",&format!("owner{i}"),&format!("fn owner{i}() {{}}"),Some("shared"),Some(&SemanticFixture::bytes())); }
        fixture.connection.execute_batch("COMMIT").unwrap();
        let (matches, metadata) = rank_semantic(&fixture.validated(), &SemanticFixture::vector(), &fixture.context.root, &fixture.context).unwrap();
        assert_eq!(matches.len(), 137);
        assert_eq!(matches.iter().filter_map(Match::syntax_key).collect::<HashSet<_>>().len(), 137);
        assert_eq!(metadata["returned"], 137);
        assert_eq!(metadata["complete"], true);
    }

    #[test]
    fn semantic_scan_cap_reports_unknown_tail_even_when_no_features_exist() {
        let fixture = SemanticFixture::new(&[("main.rs","rust","fn persist() {}\n")]);
        fixture.add("seed","main.rs","persist","fn persist() {}",None,None);
        fixture.connection.execute_batch("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<20000)
            INSERT INTO nodes SELECT 'extra'||n,kind,name,qualified_name,file_path,start_line,end_line,start_column,end_column,NULL FROM nodes,seq WHERE id='seed'").unwrap();
        let (matches, metadata) = rank_semantic(&fixture.validated(), &SemanticFixture::vector(), &fixture.context.root, &fixture.context).unwrap();
        assert!(matches.is_empty());
        assert_eq!(metadata["examined"], 20000);
        assert_eq!(metadata["unrepresented"], 20000);
        assert_eq!(metadata["capped"], true);
        assert_eq!(metadata["complete"], false);
    }

    #[test]
    fn semantic_rust_lexical_miss_keeps_graph_identity_and_connection_free_cursor_publication() {
        let mut fixture = SemanticFixture::new(&[("main.rs","rust","/*😀*/ fn persist() { sync(); }\n")]);
        fixture.add("persist-node","main.rs","persist","fn persist() { sync(); }",Some("input"),Some(&SemanticFixture::bytes()));
        let raw: String = fixture.connection.query_row("SELECT value FROM project_metadata", [], |row| row.get(0)).unwrap();
        let mut stamped: Value = serde_json::from_str(&raw).unwrap();
        stamped["policyDigest"] = json!("a".repeat(64));
        fixture.connection.execute("UPDATE project_metadata SET value=?1", [stamped.to_string()]).unwrap();
        fixture.arguments["analysisPolicyDigest"] = stamped["policyDigest"].clone();
        let (matches, metadata) = rank_semantic(&fixture.validated(), &SemanticFixture::vector(), &fixture.context.root, &fixture.context).unwrap();
        let live_args = json!({"query":"zxqv blorf","kind":"auto","scope":fixture.context.root,"expand":2,"captureRanked":true});
        let baseline = crate::ops::tool_search_output(&live_args, &fixture.native.cache, &fixture.native.session, &fixture.native.bloom, &fixture.context).unwrap();
        let captured = fixture.native.session.take_ranked_capture(baseline.search_capture.as_deref().expect("lexical-zero collection must be retained")).unwrap();
        let super::super::capture::Collection::Fuzzy { search:mut lexical, .. } = captured.collection else { panic!("behavior capture changed kind"); };
        assert!(lexical.result.matches.is_empty(), "this must exercise a genuine lexical miss");
        super::super::fuzzy::fuse_semantic(&mut lexical, matches);
        assert_eq!(lexical.result.matches.len(), 1);
        assert_eq!(lexical.result.matches[0].graph_node_id(), Some("persist-node"));
        let connected = load_for_live("zxqv blorf", false, "semantic-test", &fixture.arguments, &fixture.context.root, &fixture.database, &fixture.context, fixture.sources.clone(), &lexical.result).unwrap().unwrap();
        assert_eq!(connected.metadata["targetId"], "persist-node");
        let analysis = semantic_publication(&metadata).unwrap();
        assert_eq!(analysis["connectionsStatus"], "unavailable");
        let mut arguments = fixture.arguments.clone();
        arguments["query"] = json!("zxqv blorf");
        arguments["scope"] = json!(fixture.context.root);
        let data = json!({"query":"zxqv blorf","visibility":"project","analysis":analysis});
        let retained = super::super::continuation::RetainedRanked::new(fixture.context.root.clone(), &arguments,
            super::super::capture::Collection::Fuzzy { search:lexical, route:"behavior discovery", lanes:None }, &data).unwrap();
        assert_eq!(retained.descriptor()["analysis"]["generation"], 1);
        assert_eq!(analysis["policyDigest"], stamped["policyDigest"]);
        assert_eq!(retained.descriptor()["analysis"]["policyDigest"], stamped["policyDigest"]);
        let mut cursor = fixture.arguments.clone();
        cursor["cursor"] = json!("private-test");
        retained.validate(&cursor, &fixture.context).unwrap();
        let raw: String = fixture.connection.query_row("SELECT value FROM project_metadata", [], |row| row.get(0)).unwrap();
        let mut updated: Value = serde_json::from_str(&raw).unwrap();
        updated["generation"] = json!(2);
        fixture.connection.execute("UPDATE project_metadata SET value=?1", [updated.to_string()]).unwrap();
        assert!(retained.validate(&cursor, &fixture.context).unwrap_err().contains("publication changed"));
    }

    #[test]
    fn graph_source_association_preserves_same_row_and_callable_field_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("same.ts");
        let first = "Run() { Left(); unresolved(); }";
        let second = "Run() { return Right(); }";
        let text = Arc::new(format!("/*😀*/ class A {{ {first} }} class B {{ {second} }} class C {{ field = ((value: number) => Left()); made = new Models.Box(); }} function Left() {{}}"));
        std::fs::write(&path, text.as_bytes()).unwrap();
        let capture = ValidatedAnalysis {
            connection: Connection::open_in_memory().unwrap(),
            identity: AnalysisIdentity::Captured(Capture {
                root: directory.path().into(),
                generation: 1,
                kernel_version: String::new(),
                interpretation_revision: String::new(),
                capture_digest: String::new(),
                policy_digest: None,
                corpus: None,
                semantic: None,
                sources: Vec::new(),
            }),
            contents: RefCell::new(HashMap::from([("same.ts".into(), (path.clone(), text.clone()))])),
            extraction_diagnostics: RefCell::default(),
            source_facts: RefCell::default(),
        };
        let node = |id: &str, name: &str, range: std::ops::Range<usize>| Node {
            id: id.into(),
            kind: "method".into(),
            name: name.into(),
            qualified: id.into(),
            file: "same.ts".into(),
            start: 1,
            end: 1,
            start_column: text[..range.start].encode_utf16().count() as u32,
            end_column: text[..range.end].encode_utf16().count() as u32,
        };
        let left_start = text.find(first).unwrap();
        let right_start = text.find(second).unwrap();
        let left = node("A::Run", "Run", left_start..left_start + first.len());
        let right = node("B::Run", "Run", right_start..right_start + second.len());
        let left_match = capture.matched(&left).unwrap();
        let right_match = capture.matched(&right).unwrap();
        let declaration = left_match.declaration.as_ref().unwrap();
        assert_eq!(
            declaration.region().id.bytes,
            left_start..left_start + first.len()
        );
        assert_ne!(
            declaration.key(),
            right_match.declaration.as_ref().unwrap().key()
        );
        let live = declaration.to_match(&path, &text, 1, left_match.mtime);
        let lanes =
            LaneBundle::from_prepared(&left_match, SymbolLanes::default(), "method".into(), None);
        assert!(
            lanes.get(&live).is_some(),
            "graph qualification must not overwrite the live lane key"
        );
        assert!(lanes.get(&right_match).is_none());
        assert!(
            byte_at(&text, 1, 3).is_err(),
            "half of a surrogate pair is not a source boundary"
        );
        let wider = node("A::Run", "Run", 0..left_start + first.len());
        assert!(
            capture.declaration(&wider).unwrap().is_none(),
            "legal coordinates and a contained name are not an exact association"
        );
        let facts = capture.source_facts(&left).unwrap();
        let field = facts
            .declarations
            .iter()
            .find(|declaration| declaration.region().name.as_deref() == Some("field"))
            .unwrap();
        let field_node = node("C::field", "field", field.region().id.bytes.clone());
        assert_eq!(
            capture.declaration(&field_node).unwrap().unwrap().key(),
            field.key()
        );
        let site = text.find("Left();").unwrap();
        let edge = IncidentEdge {
            opposite: left.clone(),
            id: 1,
            source: left.id.clone(),
            target: "Left".into(),
            kind: "calls".into(),
            line: Some(1),
            column: Some(text[..site].encode_utf16().count() as u32),
            metadata: None,
            provenance: None,
        };
        let site = capture.site(&edge, &left).unwrap().unwrap();
        let new_start = text.find("new Models.Box()").unwrap();
        let construction = capture
            .site(
                &IncidentEdge {
                    kind: "instantiates".into(),
                    column: Some(text[..new_start].encode_utf16().count() as u32),
                    ..edge
                },
                &left,
            )
            .unwrap()
            .unwrap();
        assert!(construction.construction);
        assert_eq!(&text[construction.expression], "new Models.Box()");
        assert_eq!(&text[construction.target], "Models.Box");
        assert_eq!(construction.receiver.as_deref(), Some("Models"));
        assert_eq!(
            site.owner.as_ref().unwrap().bytes,
            declaration.region().id.bytes
        );
        let live_connection = super::super::callees::CallConnection {
            path: path.clone(),
            site: site.clone(),
            origin: "direct origin",
            candidates: Vec::new(),
            basis: "live candidate evidence; binding unverified",
        };
        let unresolved = super::super::callees::CallConnection {
            site: facts
                .sites
                .iter()
                .find(|site| site.name == "unresolved")
                .unwrap()
                .clone(),
            ..live_connection.clone()
        };
        let function_start = text.find("function Left()").unwrap();
        let mut function = node("Left", "Left", function_start..text.len());
        function.kind = "function".into();
        let captured_connection = super::super::callees::CallConnection {
            candidates: vec![capture.candidate(&function).unwrap()],
            basis: "prepared static target; runtime dispatch unverified",
            ..live_connection.clone()
        };
        let mut live_lanes = LaneBundle::from_prepared(
            &live,
            SymbolLanes {
                connections: vec![live_connection, unresolved],
                ..Default::default()
            },
            "method".into(),
            None,
        );
        let captured_lanes = LaneBundle::from_prepared(
            &left_match,
            SymbolLanes {
                connections: vec![captured_connection],
                ..Default::default()
            },
            "method".into(),
            None,
        );
        live_lanes.enrich(captured_lanes);
        let merged = &live_lanes.get(&live).unwrap().connections;
        assert_eq!(
            merged.len(),
            3,
            "same-site live alternatives and unmatched live sites must survive enrichment"
        );
        assert!(merged
            .iter()
            .any(|connection| connection.site.name == "unresolved"));
        assert!(merged.iter().any(|connection| connection
            .candidates
            .iter()
            .any(|candidate| candidate.name == "Left" && candidate.declaration.is_some())));
    }

    #[test]
    fn exact_file_capture_preserves_graph_owner_and_rejects_changed_config() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("project");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let files = [
            ("config.json", None, "{\"enabled\":true}\n"),
            ("nested/target.rs", Some("rust"), "pub fn Target() {}\nfn Decoy() { Target(); }\n"),
            ("target.rs", Some("rust"), "pub fn Target() { Target(); Helper(); let _ = Helper; } fn Helper() {}\nfn Caller() { let _ = \"😀\"; Target(); let _ = Target; }\nconst CALLBACK: fn() = Target;\n"),
            ("contract.ts", Some("typescript"), "// Contract\ninterface Contract {\n  Run(): void;\n}\nfunction Invoke(value: Contract) { value.Run(); }\n"),
            ("box.go", Some("go"), "package sample\ntype Box struct {}\n"),
            ("box_method.go", Some("go"), "package sample\nfunc (b *Box) Run(\n    value int,\n) int {\n    return value\n}\n"),
            ("z0.go", Some("go"), "package sample\n// Struct Target\ntype Target struct {}\n"),
            ("z1.ts", Some("typescript"), "// Class Target\nclass Target {}\n"),
            ("z2.rs", Some("rust"), "const Target: i32 = 1;\n"),
            ("z3.rs", Some("rust"), "fn Target() {}\n"),
        ];
        let database = directory
            .path()
            .canonicalize()
            .unwrap()
            .join("graph.sqlite");
        let connection = Connection::open(&database).unwrap();
        // Reader-contract fixture, not extraction or semantic-binding proof.
        connection.execute_batch("CREATE TABLE project_metadata(key TEXT,value TEXT);
            CREATE TABLE schema_versions(version INTEGER);
            CREATE TABLE nodes_fts(name TEXT);
            CREATE TABLE name_segment_vocab(name TEXT);
            CREATE TABLE files(path TEXT,content_hash TEXT,errors TEXT);
            CREATE TABLE nodes(id TEXT,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,start_line INTEGER,end_line INTEGER,start_column INTEGER,end_column INTEGER);
            CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER,metadata TEXT,provenance TEXT);
            CREATE TABLE unresolved_refs(from_node_id TEXT,reference_kind TEXT,reference_name TEXT,status TEXT,line INTEGER DEFAULT 1,col INTEGER DEFAULT 0,candidates TEXT,id INTEGER);
            INSERT INTO unresolved_refs(from_node_id,reference_kind,reference_name,status) VALUES ('target','calls','missingCall','failed'),('target','function_ref','missingCallback','pending');").unwrap();
        let lines = files[2].2.lines().collect::<Vec<_>>();
        let column = |line: &str, needle: &str| {
            line[..line.find(needle).unwrap()].encode_utf16().count() as u32
        };
        let target_end = column(lines[0], " fn Helper");
        let helper_start = column(lines[0], "fn Helper");
        let caller_end = lines[1].encode_utf16().count() as u32;
        for (id, kind, name, qualified, file, start, end, start_column, end_column) in [
            (
                "target",
                "function",
                "Target",
                "module::Target",
                "target.rs",
                1,
                1,
                0,
                target_end,
            ),
            (
                "helper",
                "function",
                "Helper",
                "module::Helper",
                "target.rs",
                1,
                1,
                helper_start,
                lines[0].len() as u32,
            ),
            (
                "caller",
                "function",
                "Caller",
                "module::Caller",
                "target.rs",
                2,
                2,
                0,
                caller_end,
            ),
            (
                "file",
                "file",
                "target.rs",
                "target.rs",
                "target.rs",
                1,
                4,
                0,
                0,
            ),
            (
                "other",
                "function",
                "Target",
                "Target",
                "nested/target.rs",
                1,
                1,
                0,
                18,
            ),
            (
                "decoy",
                "function",
                "Decoy",
                "Decoy",
                "nested/target.rs",
                2,
                2,
                0,
                24,
            ),
            (
                "contract",
                "interface",
                "Contract",
                "Contract",
                "contract.ts",
                2,
                4,
                0,
                1,
            ),
            (
                "contract_method",
                "method",
                "Run",
                "Contract::Run",
                "contract.ts",
                3,
                3,
                2,
                13,
            ),
            (
                "invoke",
                "function",
                "Invoke",
                "Invoke",
                "contract.ts",
                5,
                5,
                0,
                files[3].2.lines().nth(4).unwrap().encode_utf16().count() as u32,
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO nodes VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    rusqlite::params![
                        id,
                        kind,
                        name,
                        qualified,
                        file,
                        start,
                        end,
                        start_column,
                        end_column
                    ],
                )
                .unwrap();
        }
        let caller_site = column(lines[1], "Target();");
        let self_site = column(lines[0], "Target();");
        let helper_site = column(lines[0], "Helper();");
        for (id, from, to, kind, line, col, metadata, provenance) in [
            (
                1,
                "caller",
                "target",
                "calls",
                Some(2),
                Some(caller_site),
                json!({"resolvedBy":"import"}),
                None,
            ),
            (
                2,
                "decoy",
                "other",
                "calls",
                Some(2),
                Some(13),
                json!({}),
                None,
            ),
            (
                3,
                "target",
                "target",
                "calls",
                Some(1),
                Some(self_site),
                json!({"resolvedBy":"exact-match"}),
                None,
            ),
            (
                4,
                "target",
                "helper",
                "calls",
                Some(1),
                Some(helper_site),
                json!({"resolvedBy":"exact-match"}),
                None,
            ),
            (
                5,
                "caller",
                "target",
                "references",
                Some(2),
                Some(column(lines[1], "Target;")),
                json!({"fnRef":true,"resolvedBy":"function-ref"}),
                None,
            ),
            (
                6,
                "target",
                "helper",
                "references",
                Some(1),
                Some(column(lines[0], "Helper;")),
                json!({"refKind":"function_ref"}),
                None,
            ),
            (
                7,
                "file",
                "target",
                "references",
                Some(3),
                Some(column(lines[2], "Target;")),
                json!({"fnRef":true}),
                None,
            ),
            // Unmarked references must not be admitted or validated as callsites.
            (
                8,
                "caller",
                "target",
                "references",
                None,
                None,
                json!({}),
                None,
            ),
            (
                9,
                "caller",
                "target",
                "calls",
                Some(0),
                None,
                json!({"resolvedBy":"fuzzy"}),
                None,
            ),
            (
                10,
                "target",
                "helper",
                "calls",
                None,
                None,
                json!({"resolvedBy":"framework"}),
                None,
            ),
            (
                11,
                "target",
                "caller",
                "calls",
                Some(999),
                None,
                json!({}),
                Some("heuristic"),
            ),
            (
                12,
                "target",
                "helper",
                "calls",
                None,
                None,
                json!({"synthesizedBy":"fixture"}),
                None,
            ),
            (
                13,
                "contract",
                "contract_method",
                "contains",
                None,
                None,
                json!({}),
                None,
            ),
            (
                14,
                "invoke",
                "contract_method",
                "calls",
                Some(5),
                Some(column(files[3].2.lines().nth(4).unwrap(), "value.Run")),
                json!({"resolvedBy":"fixture"}),
                None,
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO edges VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    rusqlite::params![
                        id,
                        from,
                        to,
                        kind,
                        line,
                        col,
                        metadata.to_string(),
                        provenance
                    ],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO nodes VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    "box",
                    "struct",
                    "Box",
                    "Box",
                    "box.go",
                    2,
                    2,
                    0,
                    files[4].2.lines().nth(1).unwrap().encode_utf16().count() as u32
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO nodes VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    "box_run",
                    "method",
                    "Run",
                    "Box::Run",
                    "box_method.go",
                    2,
                    6,
                    0,
                    1
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO edges (id,source,target,kind) VALUES (15,'box','box_run','contains')",
                [],
            )
            .unwrap();
        for (index, kind, start) in [
            (6, "struct", 3),
            (7, "class", 2),
            (8, "constant", 1),
            (9, "function", 1),
        ] {
            connection
                .execute(
                    "INSERT INTO nodes VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    rusqlite::params![
                        format!("extra{index}"),
                        kind,
                        "Target",
                        "Target",
                        files[index].0,
                        start,
                        start,
                        0,
                        files[index]
                            .2
                            .lines()
                            .nth(start as usize - 1)
                            .unwrap()
                            .encode_utf16()
                            .count() as u32,
                    ],
                )
                .unwrap();
        }
        let mut manifest = Vec::new();
        let mut canonical = Vec::new();
        for (name, language, text) in files {
            std::fs::write(root.join(name), text).unwrap();
            let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
            manifest.push(json!({"path":name,"language":language,"digest":digest}));
            canonical.push(json!([name, language, digest]));
            if language.is_some() {
                connection
                    .execute(
                        "INSERT INTO files(path,content_hash) VALUES (?1,?2)",
                        [name, &digest],
                    )
                    .unwrap();
            }
        }
        let capture_digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&canonical).unwrap())
        );
        connection
            .execute(
                "INSERT INTO project_metadata VALUES ('codeweave-pi.g1',?1)",
                [json!({
                    "root":root,"generation":1,"kernelVersion":"0.1.0-codeweave-pi.5",
                    "interpretationRevision":"test-analysis",
                    "captureDigest":capture_digest,"sources":manifest,
                })
                .to_string()],
            )
            .unwrap();
        let context = OperationContext {
            root: root.clone(),
            deadline: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            confine_to_root: true,
            read_format: crate::dispatch::ReadFormat::Plain,
        };
        let trace = |query: &str, relation: &str, page: usize, limit: usize, scope: &Path| {
            crate::ops::tool_search_output(
                &json!({"root":root,"scope":scope,"query":query,"kind":"symbol","expand":2,
                    "analysisDatabase":database,"analysisRevision":"test-analysis","analysisRelation":relation,"page":page,"limit":limit}),
                &crate::cache::OutlineCache::new(), &crate::session::Session::new(),
                &Arc::new(crate::index::bloom::BloomFilterCache::new()), &context,
            ).unwrap()
        };
        for (relation, expected) in [
            ("callers", vec![1, 3, 5, 7, 9]),
            ("callees", vec![3, 4, 6, 10, 11, 12]),
        ] {
            let mut seen = std::collections::BTreeSet::new();
            for page in 1..=3 {
                let output = trace("target", relation, page, 2, &root);
                let analysis = &output.structured["data"]["analysis"];
                assert_eq!(analysis["status"], "ok");
                assert_eq!(analysis["targetId"], "target");
                assert_eq!(analysis["relation"], relation);
                assert_eq!(analysis["totalConnections"], expected.len());
                assert_eq!(analysis["generation"], 1);
                let edges = analysis["connections"].as_array().unwrap();
                assert_eq!(analysis["returnedConnections"], edges.len());
                assert_eq!(analysis["omittedConnections"], expected.len() - edges.len());
                for edge in edges {
                    assert_eq!(
                        edge[if relation == "callers" {
                            "target"
                        } else {
                            "source"
                        }],
                        "target"
                    );
                    assert!(seen.insert(edge["edgeId"].as_i64().unwrap()));
                }
                assert_eq!(
                    analysis["nextPage"],
                    if page == 3 {
                        Value::Null
                    } else {
                        json!(page + 1)
                    }
                );
                let rows = output.structured["data"]["sourceRows"].as_array().unwrap();
                let unique = rows
                    .iter()
                    .map(|row| (row["path"].to_string(), row["line"].to_string()))
                    .collect::<std::collections::HashSet<_>>();
                assert_eq!(rows.len(), unique.len(), "repeated certified source row");
            }
            assert_eq!(seen.into_iter().collect::<Vec<_>>(), expected);
            let beyond = trace("target", relation, 4, 2, &root);
            assert_eq!(
                beyond.structured["data"]["analysis"]["returnedConnections"],
                0
            );
            assert_eq!(
                beyond.structured["data"]["analysis"]["nextPage"],
                Value::Null
            );
        }
        let ambiguity = trace("Target", "callers", 1, 2, &root);
        assert_eq!(
            ambiguity.structured["data"]["analysis"]["status"],
            "ambiguous"
        );
        assert!(ambiguity.text.contains("target.rs::module::Target"));
        assert!(
            ambiguity.text.contains("target"),
            "an exact graph identity remains available when qualified names overlap"
        );
        assert_eq!(
            trace("Missing", "callers", 1, 2, &root).structured["data"]["analysis"]["status"],
            "not_found"
        );
        assert_eq!(
            trace("target", "callers", 1, 2, &root.join("nested")).structured["data"]["analysis"]
                ["status"],
            "not_found"
        );
        assert_eq!(
            trace("target.rs::module::Target", "callers", 1, 2, &root).structured["data"]
                ["analysis"]["targetId"],
            "target"
        );
        let interface = trace("contract", "callers", 1, 50, &root);
        assert_eq!(interface.structured["data"]["analysis"]["status"], "ok");
        assert_eq!(
            interface.structured["data"]["analysis"]["totalConnections"], 0,
            "member calls are not incident edges of the selected interface"
        );
        let prepared = load(
            "Target",
            true,
            "test-analysis",
            &json!({}),
            &root.join("target.rs"),
            &database,
            &context,
            Arc::default(),
        )
        .unwrap()
        .unwrap();
        assert!(load(
            "Missing",
            true,
            "test-analysis",
            &json!({}),
            &root,
            &database,
            &context,
            Arc::default()
        )
        .unwrap()
        .is_none());
        let ambiguous = load(
            "Target",
            true,
            "test-analysis",
            &json!({}),
            &root,
            &database,
            &context,
            Arc::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(ambiguous.result.total_found, 6);
        assert_eq!(ambiguous.lanes.prepared_cards.len(), 5);
        assert_eq!(ambiguous.metadata["omittedTargets"], 1);
        assert_eq!(ambiguous.metadata["targets"][2]["target"]["kind"], "struct");
        assert_eq!(ambiguous.metadata["targets"][3]["target"]["kind"], "class");
        assert_eq!(
            ambiguous.metadata["targets"][4]["target"]["kind"],
            "constant"
        );
        assert_eq!(ambiguous.metadata["targets"][0]["targetId"], "other");
        assert_eq!(ambiguous.metadata["targets"][1]["targetId"], "target");
        assert_eq!(
            ambiguous.lanes.prepared_cards[0]
                .get(&ambiguous.result.matches[0])
                .unwrap()
                .callers[0]
                .calling_function,
            "Decoy"
        );
        assert_eq!(
            ambiguous.lanes.prepared_cards[1]
                .get(&ambiguous.result.matches[1])
                .unwrap()
                .callers[0]
                .calling_function,
            "module::Caller"
        );
        assert!(ambiguous.metadata["targets"][1]["connections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| edge["source"] == "caller"));
        let card = super::super::format_fuzzy_result_typed(
            &ambiguous.result,
            &crate::cache::OutlineCache::new(),
            None,
            Some(&ambiguous.lanes),
        )
        .unwrap();
        assert!(
            card.text.contains("module::Caller") || card.text.contains("fn Caller()"),
            "{}",
            card.text
        );
        assert!(card.text.contains("Decoy"), "{}", card.text);
        assert!(
            card.text.contains("kind: struct")
                && card.text.contains("kind: class")
                && card.text.contains("kind: constant"),
            "{}",
            card.text
        );
        assert!(
            card.text.contains("// Struct Target") && card.text.contains("// Class Target"),
            "{}",
            card.text
        );
        assert!(
            !card
                .text
                .contains("additional exact captured identities omitted"),
            "only the graph metadata owner can distinguish omitted targets from live usages"
        );
        let output = crate::ops::tool_search_output(
            &json!({"root":root,"scope":root,"query":"Target","kind":"symbol","expand":2,"analysisDatabase":database,"analysisRevision":"test-analysis"}),
            &crate::cache::OutlineCache::new(), &crate::session::Session::new(),
            &Arc::new(crate::index::bloom::BloomFilterCache::new()), &context,
        ).unwrap();
        // The live contract, including unmatched-language classification, owns
        // discovery totals; enrichment must not replace it with graph allocation.
        let live = crate::ops::tool_search_output(
            &json!({"root":root,"scope":root,"query":"Target","kind":"symbol","expand":2}),
            &crate::cache::OutlineCache::new(),
            &crate::session::Session::new(),
            &Arc::new(crate::index::bloom::BloomFilterCache::new()),
            &context,
        )
        .unwrap();
        for field in ["definitions", "usages", "totalFound", "facetTotals"] {
            assert_eq!(
                output.structured["data"][field], live.structured["data"][field],
                "live {field} changed"
            );
        }
        assert_eq!(
            output.structured["completeness"]["total"],
            live.structured["completeness"]["total"]
        );
        assert_eq!(
            output.structured["completeness"]["returned"],
            output.structured["data"]["matches"]
                .as_array()
                .unwrap()
                .len()
        );
        assert_eq!(output.structured["completeness"]["complete"], false);
        assert_eq!(
            output.structured["completeness"]["omitted"]
                .as_u64()
                .unwrap(),
            output.structured["data"]["totalFound"].as_u64().unwrap()
                - output.structured["data"]["matches"]
                    .as_array()
                    .unwrap()
                    .len() as u64
        );
        assert!(!output.structured["diagnostics"]
            .to_string()
            .contains("total is unknown"));
        assert!(output.structured["data"]["analysis"]["unassociatedTargets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|target| target["node"]["id"] == "target"));
        // A missing source origin elsewhere in the captured corpus can hide an
        // incoming connection. Retain the target, but never report full coverage.
        let warning = json!([{"severity":"warning","code":"unrepresented_reference_origin","line":5,"column":0,"message":"Unrepresented source owner"}]);
        connection
            .execute(
                "UPDATE files SET errors=?1 WHERE path='contract.ts'",
                [warning.to_string()],
            )
            .unwrap();
        let partial_trace = trace("target", "callers", 1, 50, &root);
        assert_eq!(partial_trace.structured["data"]["analysis"]["status"], "ok");
        assert_eq!(
            partial_trace.structured["data"]["analysis"]["extractionDiagnostics"][0]["filePath"],
            "contract.ts"
        );
        assert_eq!(partial_trace.structured["completeness"]["complete"], false);
        let partial = crate::ops::tool_search_output(
            &json!({"root":root,"scope":root.join("target.rs"),"query":"Target","kind":"symbol","expand":2,"analysisDatabase":database,"analysisRevision":"test-analysis"}),
            &crate::cache::OutlineCache::new(), &crate::session::Session::new(),
            &Arc::new(crate::index::bloom::BloomFilterCache::new()), &context,
        ).unwrap();
        assert_eq!(partial.structured["completeness"]["complete"], false);
        assert_eq!(partial.structured["completeness"]["reason"], "error");
        assert!(partial
            .text
            .contains("Prepared connection coverage is partial"));
        assert_eq!(partial.structured["data"]["analysis"]["targetId"], "target");
        assert_eq!(
            partial.structured["data"]["analysis"]["extractionDiagnostics"][0]["filePath"],
            "contract.ts"
        );
        connection.execute("UPDATE files SET errors=?1 WHERE path='contract.ts'", [json!([{"severity":"error","code":"unrepresented_reference_origin","line":5,"column":0,"message":"Unexpected fatal diagnostic"}]).to_string()]).unwrap();
        assert!(load(
            "Target",
            true,
            "test-analysis",
            &json!({}),
            &root,
            &database,
            &context,
            Arc::default()
        )
        .is_err());
        connection
            .execute("UPDATE files SET errors=NULL WHERE path='contract.ts'", [])
            .unwrap();
        connection.execute_batch("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1005)
            INSERT INTO edges (id,source,target,kind,metadata,provenance) SELECT 100+n,'other','target','calls','{}','heuristic' FROM seq;").unwrap();
        let dense = trace("target", "callers", 21, 50, &root);
        assert_eq!(
            dense.structured["data"]["analysis"]["totalConnections"],
            1010
        );
        assert_eq!(
            dense.structured["data"]["analysis"]["returnedConnections"],
            10
        );
        assert_eq!(
            dense.structured["data"]["analysis"]["nextPage"],
            Value::Null
        );
        // Keep the existing separate ranked combined-allocation safeguard proof.
        connection
            .execute("DELETE FROM edges WHERE id>700", [])
            .unwrap();
        let bound = load(
            "Target",
            true,
            "test-analysis",
            &json!({}),
            &root,
            &database,
            &context,
            Arc::default(),
        )
        .err()
        .unwrap();
        assert!(
            bound.contains("combined connection bound exceeded"),
            "{bound}"
        );
        connection
            .execute("DELETE FROM edges WHERE id>100", [])
            .unwrap();
        let folded = load(
            "tArGeT",
            false,
            "test-analysis",
            &json!({}),
            &root.join("target.rs"),
            &database,
            &context,
            Arc::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(folded.metadata["targetId"], prepared.metadata["targetId"]);
        let target = &prepared.result.matches[0];
        assert_eq!(target.path, root.join("target.rs"));
        assert_eq!(prepared.result.query, "module::Target");
        assert_eq!(target.def_name.as_deref(), Some("module::Target"));
        let lanes = prepared.lanes.get(target).unwrap();
        assert_eq!(lanes.callers.len(), 1);
        assert_eq!(lanes.callers[0].calling_function, "module::Caller");
        assert_eq!(lanes.callers[0].call_text, lines[1]);
        assert_eq!(lanes.connections.len(), 1);
        assert_eq!(lanes.connections[0].candidates[0].name, "module::Helper");
        assert_eq!(lanes.function_references.len(), 2);
        assert_eq!(lanes.referenced_functions.len(), 1);
        assert_eq!(lanes.referenced_functions[0].name, "module::Helper");
        assert_eq!(lanes.heuristic_definitions.len(), 2);
        assert_eq!(lanes.unresolved_callees, vec!["missingCall"]);
        assert!(lanes
            .connection_notes
            .iter()
            .any(|note| note.contains("self call") && note.contains("exact-match")));
        assert!(lanes
            .connection_notes
            .iter()
            .any(|note| note.contains("missingCallback") && note.contains("pending")));
        assert!(lanes
            .connection_notes
            .iter()
            .any(|note| note.contains("module::Helper")
                && note.contains(&format!("column {helper_start}"))));
        assert!(lanes
            .connection_notes
            .iter()
            .any(|note| note.contains("fuzzy inference")
                && note.contains("target.rs:0, column unavailable")));
        assert_eq!(prepared.metadata["target"]["id"], "target");
        assert_eq!(
            prepared.metadata["target"]["qualifiedName"],
            "module::Target"
        );
        assert_eq!(prepared.metadata["target"]["endColumn"], target_end);
        let edges = prepared.metadata["connections"].as_array().unwrap();
        assert_eq!(edges.len(), 11); // The ordinary reference is separate from call evidence.
        assert!(!edges
            .iter()
            .any(|edge| edge["source"] == "decoy" || edge["target"] == "other"));
        assert_eq!(edges.iter().filter(|edge| edge["self"] == true).count(), 1);
        let by_id = |id| edges.iter().find(|edge| edge["edgeId"] == id).unwrap();
        assert_eq!(by_id(1)["column"], caller_site);
        assert_eq!(by_id(1)["sourceNode"]["endColumn"], caller_end);
        assert!(by_id(1)["metadata"].is_object());
        assert_eq!(by_id(4)["targetNode"]["startColumn"], helper_start);
        assert_eq!(by_id(5)["classification"], "function-reference");
        assert_eq!(by_id(6)["classification"], "function-reference");
        assert_eq!(by_id(7)["sourceNode"]["endLine"], 4);
        assert_eq!(by_id(8)["classification"], "reference");
        assert!(
            by_id(8)["line"].is_null()
                && by_id(8)["column"].is_null()
                && by_id(8)["site"].is_null()
        );
        assert!(by_id(8)["positionSemantics"]
            .as_str()
            .unwrap()
            .contains("unavailable"));
        for (id, classification) in [
            (9, "fuzzy-inference"),
            (10, "framework-inference"),
            (11, "heuristic"),
            (12, "heuristic"),
        ] {
            assert_eq!(by_id(id)["classification"], classification);
            assert!(lanes.connection_notes.iter().any(|note| note
                .starts_with(&format!("{}:", classification.replace('-', " ")))
                && note.contains("callsite unverified")));
            assert!(by_id(id)["positionSemantics"]
                .as_str()
                .unwrap()
                .contains("unverified"));
        }
        assert_eq!(by_id(11)["provenance"], "heuristic");
        let card = super::super::format_exact_ranked_card(
            &prepared.result,
            &crate::cache::OutlineCache::new(),
            None,
            Some(&prepared.lanes),
        )
        .unwrap();
        // The helper declaration shares a physical line with the target; both
        // call and function-value relationships must survive without copying it.
        for heading in [
            "call evidence —",
            "referenced function definitions — invocation not established:",
        ] {
            let section = card
                .text
                .split(heading)
                .nth(1)
                .unwrap()
                .split("\n\n")
                .next()
                .unwrap();
            assert!(
                section.contains("module::Helper [1]: source above"),
                "{}",
                card.text
            );
            assert!(
                !section.contains(lines[0]),
                "helper source repeated: {}",
                card.text
            );
        }
        assert!(card
            .source_rows
            .iter()
            .any(|row| row.path == root.join("target.rs")
                && row.line == 1
                && row.text == lines[0]));
        // Incoming and outgoing sites both use the SOURCE span, with UTF-16
        // boundaries (an astral character is two units, never a split position).
        let emoji_column = column(lines[1], "😀");
        for (id, line, col) in [
            (1, None, Some(caller_site)),
            (1, Some(2), None),
            (1, Some(0), Some(0)),
            (1, Some(1), Some(self_site)),
            (1, Some(2), Some(caller_end)),
            (1, Some(2), Some(emoji_column + 1)),
            (4, None, Some(helper_site)),
            (4, Some(1), None),
            (4, Some(0), Some(0)),
            (4, Some(2), Some(caller_site)),
            (4, Some(1), Some(helper_start)),
            (4, Some(1), Some(999)),
        ] {
            connection
                .execute(
                    "UPDATE edges SET line=?1,col=?2 WHERE id=?3",
                    rusqlite::params![line, col, id],
                )
                .unwrap();
            let error = load(
                "Target",
                true,
                "test-analysis",
                &json!({}),
                &root.join("target.rs"),
                &database,
                &context,
                Arc::default(),
            )
            .err()
            .unwrap();
            assert!(error.contains("connection"), "{error}");
            let (line, col) = if id == 1 {
                (2, caller_site)
            } else {
                (1, helper_site)
            };
            connection
                .execute(
                    "UPDATE edges SET line=?1,col=?2 WHERE id=?3",
                    rusqlite::params![line, col, id],
                )
                .unwrap();
        }
        connection
            .execute("UPDATE edges SET metadata='[]' WHERE id=1", [])
            .unwrap();
        let error = load(
            "Target",
            true,
            "test-analysis",
            &json!({}),
            &root.join("target.rs"),
            &database,
            &context,
            Arc::default(),
        )
        .err()
        .unwrap();
        assert!(error.contains("metadata must be an object"), "{error}");
        connection
            .execute("UPDATE edges SET metadata='{}' WHERE id=1", [])
            .unwrap();
        connection
            .execute("UPDATE nodes SET end_column=1 WHERE id='file'", [])
            .unwrap();
        let error = load(
            "Target",
            true,
            "test-analysis",
            &json!({}),
            &root.join("target.rs"),
            &database,
            &context,
            Arc::default(),
        )
        .err()
        .unwrap();
        assert!(error.contains("node span"), "{error}");
        connection
            .execute("UPDATE nodes SET end_column=0 WHERE id='file'", [])
            .unwrap();
        assert_eq!(prepared.lanes.prepared_kind.as_deref(), Some("function"));
        let contract = load(
            "Contract",
            true,
            "test-analysis",
            &json!({}),
            &root.join("contract.ts"),
            &database,
            &context,
            Arc::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(contract.metadata["memberNodes"][0]["id"], "contract_method");
        assert_eq!(
            contract.metadata["connections"][0]["target"],
            "contract_method"
        );
        assert_eq!(contract.metadata["connections"][0]["source"], "invoke");
        let card = super::super::format_exact_ranked_card(
            &contract.result,
            &crate::cache::OutlineCache::new(),
            None,
            Some(&contract.lanes),
        )
        .unwrap();
        assert!(
            card.text.contains("calls to declared methods"),
            "{}",
            card.text
        );
        for (index, line) in files[3].2.lines().enumerate() {
            assert!(
                card.source_rows
                    .iter()
                    .any(|row| row.line == index as u32 + 1 && row.text == line),
                "missing {line:?}"
            );
        }
        assert!(
            !card.text.contains("captured member definitions"),
            "fully visible same-file member must not be repeated: {}",
            card.text
        );
        let cross_file = load(
            "Box",
            true,
            "test-analysis",
            &json!({}),
            &root.join("box.go"),
            &database,
            &context,
            Arc::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(cross_file.metadata["target"]["kind"], "struct");
        assert_eq!(cross_file.metadata["memberNodes"][0]["id"], "box_run");
        assert_eq!(cross_file.metadata["memberNodes"][0]["startColumn"], 0);
        assert_eq!(cross_file.metadata["memberNodes"][0]["endColumn"], 1);
        assert!(
            cross_file.metadata["connections"]
                .as_array()
                .unwrap()
                .is_empty(),
            "contains is not an invocation"
        );
        let card = super::super::format_exact_ranked_card(
            &cross_file.result,
            &crate::cache::OutlineCache::new(),
            None,
            Some(&cross_file.lanes),
        )
        .unwrap();
        assert!(
            card.text
                .contains("captured member definitions — membership, not invocation"),
            "{}",
            card.text
        );
        assert!(card
            .text
            .contains("not prove invocation, signature satisfaction or runtime dispatch"));
        for line in 2..=4 {
            let expected = files[5].2.lines().nth(line - 1).unwrap();
            assert_eq!(
                card.source_rows
                    .iter()
                    .filter(|row| row.path == root.join("box_method.go")
                        && row.line == line as u32
                        && row.text == expected)
                    .count(),
                1,
                "complete member declaration line {line}: {}",
                card.text
            );
        }
        connection
            .execute("UPDATE nodes SET end_column=999 WHERE id='box_run'", [])
            .unwrap();
        assert!(load(
            "Box",
            true,
            "test-analysis",
            &json!({}),
            &root.join("box.go"),
            &database,
            &context,
            Arc::default()
        )
        .is_err());
        connection
            .execute(
                "UPDATE nodes SET end_column=1,file_path='not-captured.go' WHERE id='box_run'",
                [],
            )
            .unwrap();
        assert!(load(
            "Box",
            true,
            "test-analysis",
            &json!({}),
            &root.join("box.go"),
            &database,
            &context,
            Arc::default()
        )
        .is_err());
        connection
            .execute(
                "UPDATE nodes SET file_path='box_method.go' WHERE id='box_run'",
                [],
            )
            .unwrap();
        let incompatible = load(
            "Target",
            true,
            "different-analysis",
            &json!({}),
            &root.join("target.rs"),
            &database,
            &context,
            Arc::default(),
        )
        .err()
        .unwrap();
        assert!(
            incompatible.contains("candidate identity"),
            "{incompatible}"
        );
        for (census, accepted) in [
            (
                json!(files.iter().map(|file| file.0).collect::<Vec<_>>()),
                true,
            ),
            (json!(["target.rs"]), false),
        ] {
            let result = load(
                "Target",
                true,
                "test-analysis",
                &json!({"analysisCorpusFiles":census}),
                &root.join("target.rs"),
                &database,
                &context,
                Arc::default(),
            );
            assert_eq!(result.is_ok(), accepted, "an explicit capture must respect supplied current eligibility inside the transaction");
        }
        let original_metadata: String = connection
            .query_row("SELECT value FROM project_metadata", [], |row| row.get(0))
            .unwrap();
        let mut policy_metadata: Value = serde_json::from_str(&original_metadata).unwrap();
        let policy_digest = "a".repeat(64);
        policy_metadata["policyDigest"] = json!(policy_digest);
        connection
            .execute(
                "UPDATE project_metadata SET value=?1",
                [policy_metadata.to_string()],
            )
            .unwrap();
        for (expected, accepted) in [
            (None, false),
            (Some("wrong"), false),
            (Some(policy_digest.as_str()), true),
        ] {
            let mut arguments =
                json!({"analysisCorpusFiles":files.iter().map(|file| file.0).collect::<Vec<_>>()});
            if let Some(digest) = expected {
                arguments["analysisPolicyDigest"] = json!(digest);
            }
            let result = load(
                "Target",
                true,
                "test-analysis",
                &arguments,
                &root.join("target.rs"),
                &database,
                &context,
                Arc::default(),
            );
            assert_eq!(result.is_ok(), accepted);
            if let Err(error) = result {
                assert!(error.contains("corpus policy version"), "{error}");
            }
        }
        policy_metadata["corpus"] = json!("project-capture");
        connection
            .execute(
                "UPDATE project_metadata SET value=?1",
                [policy_metadata.to_string()],
            )
            .unwrap();
        let complete = json!(files.iter().map(|file| file.0).collect::<Vec<_>>());
        let mut added = complete.clone();
        added.as_array_mut().unwrap().push(json!("new-caller.rs"));
        for (census, accepted) in [
            (Value::Null, false),
            (complete, true),
            (added, false),
            (json!(["target.rs"]), false),
        ] {
            let arguments =
                json!({"analysisPolicyDigest":policy_digest,"analysisCorpusFiles":census});
            let result = load(
                "Target",
                true,
                "test-analysis",
                &arguments,
                &root.join("target.rs"),
                &database,
                &context,
                Arc::default(),
            );
            assert_eq!(result.is_ok(), accepted);
            if let Err(error) = result {
                assert!(error.contains("corpus"), "{error}");
            }
        }
        connection
            .execute("UPDATE project_metadata SET value=?1", [original_metadata])
            .unwrap();
        assert!(load(
            "Target",
            true,
            "test-analysis",
            &json!({"analysisPolicyDigest":policy_digest}),
            &root.join("target.rs"),
            &database,
            &context,
            Arc::default()
        )
        .err()
        .unwrap()
        .contains("corpus policy version"));
        std::fs::write(root.join("config.json"), "{\"enabled\":false}\n").unwrap();
        let error = load(
            "Target",
            true,
            "test-analysis",
            &json!({}),
            &root.join("target.rs"),
            &database,
            &context,
            Arc::default(),
        )
        .err()
        .unwrap();
        assert!(error.contains("captured source changed"), "{error}");
        let persisted: String = connection
            .query_row("SELECT value FROM project_metadata", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&persisted).unwrap()["generation"],
            1
        );
        let mut empty: Value = serde_json::from_str(&persisted).unwrap();
        empty["generation"] = json!(2);
        empty["sources"] = json!([]);
        empty["captureDigest"] = json!(format!("{:x}", Sha256::digest(b"[]")));
        empty["corpus"] = json!("project-capture");
        empty["policyDigest"] = json!(policy_digest);
        connection.execute_batch("DELETE FROM edges; DELETE FROM unresolved_refs; DELETE FROM nodes; DELETE FROM files;").unwrap();
        connection
            .execute("UPDATE project_metadata SET value=?1", [empty.to_string()])
            .unwrap();
        let empty = load("Missing", true, "test-analysis", &json!({"analysisRelation":"callers", "analysisPolicyDigest":policy_digest, "analysisCorpusFiles":[]}), &root, &database, &context, Arc::default()).unwrap().unwrap();
        assert_eq!(
            empty.metadata["status"], "not_found",
            "empty publication is valid evidence, not an unavailable store"
        );
    }
}
