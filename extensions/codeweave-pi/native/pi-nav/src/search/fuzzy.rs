//! Deterministic behavior discovery over shared source facts (TS/JS) and legacy outlines.
//!
//! Names, declarations, syntax-bounded source and project Markdown participate
//! in the existing BM25F retrieval before rich-card selection. Enclosed source
//! can include nested scopes; it is not proof of semantic operation ownership.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use crate::dispatch::OperationContext;
use crate::types::{FacetTotals, FileType, Match, OutlineEntry, OutlineKind, SearchResult};

use super::OperationSources;

const MAX_CANDIDATES: usize = 20_000;
// Presentation only: the complete bounded collection remains available to selection.
pub(crate) const COMPACT_CANDIDATE_LIMIT: usize = 100;
const K1: f64 = 1.2;
const B: f64 = 0.75;

#[derive(Debug, Clone)]
pub(crate) struct FuzzySearch {
    pub(crate) result: SearchResult,
    pub(crate) focus: Option<serde_json::Value>,
    pub(crate) normalized_terms: Vec<String>,
    pub(crate) term_counts: Vec<(String, usize)>,
    pub(crate) nearest_fallback: bool,
    pub(crate) term_fallbacks: Vec<(String, String)>,
    pub(crate) complete: bool,
    /// Pre-fallback lexical ranks, aligned with definition matches until fusion.
    pub(crate) lexical_ranks: Vec<Option<usize>>,
    pub(crate) diagnostics: Vec<String>,
}

#[derive(Debug)]
struct Candidate {
    path: PathBuf,
    // Retrieval evidence is project-relative; host directory names cannot supply query terms.
    path_terms: Vec<String>,
    line: u32,
    end: u32,
    name: String,
    qualified_name: String,
    source_line: String,
    signature: String,
    doc: String,
    body: String,
    file_lines: u32,
    mtime: SystemTime,
    kind: Option<OutlineKind>,
    score: f64,
    fallback_terms: HashSet<String>,
    lexical_rank: Option<usize>,
    source_association: Option<crate::types::SourceAssociation>,
    declaration: Option<super::declarations::Declaration>,
}

impl Candidate {
    fn field_tokens(&self) -> [Vec<String>; 5] {
        [
            tokenize(&self.qualified_name),
            tokenize(&self.signature),
            tokenize(&self.doc),
            self.path_terms.clone(),
            tokenize(&self.body),
        ]
    }

    fn contains_term(&self, term: &str) -> bool {
        if self.fallback_terms.contains(term) {
            return true;
        }
        self.field_tokens()
            .iter()
            .flatten()
            .any(|token| token == term)
    }
}

pub(crate) fn normalize_terms(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut terms: Vec<_> = tokenize(query)
        .into_iter()
        .filter(|token| seen.insert(token.clone()))
        .collect();
    // Bare identifiers and explicit pipe terms are vocabulary, even when named `find` or `show`.
    // Never turn a nonempty query into an error by deleting every word.
    if query.split_whitespace().count() > 1 && !query.contains('|') {
        let content: Vec<_> = terms
            .iter()
            .filter(|term| !is_scaffolding(term))
            .cloned()
            .collect();
        if !content.is_empty() {
            terms = content;
        }
    }
    terms
}

fn is_scaffolding(token: &str) -> bool {
    matches!(
        token,
        "a" | "an"
            | "the"
            | "where"
            | "is"
            | "are"
            | "was"
            | "were"
            | "be"
            | "been"
            | "being"
            | "do"
            | "does"
            | "did"
            | "how"
            | "find"
            | "show"
            | "handled"
            | "handling"
            | "of"
            | "to"
            | "in"
            | "for"
            | "with"
            | "by"
    )
}

fn tokenize(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut previous_lower = false;
    for character in value.chars() {
        if character.is_alphanumeric() {
            if character.is_uppercase() && previous_lower && !current.is_empty() {
                tokens.push(current.to_ascii_lowercase());
                current.clear();
            }
            previous_lower = character.is_lowercase();
            current.extend(character.to_lowercase());
        } else {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            previous_lower = false;
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

// Ancestors must not win merely by containing every descendant's implementation.
// Keep the current region's source, subtracting separately searchable declarations.
fn owned_text(
    content: &str,
    range: std::ops::Range<usize>,
    mut children: Vec<std::ops::Range<usize>>,
) -> String {
    children.retain(|child| range.start <= child.start && child.end <= range.end);
    children.sort_by_key(|child| child.start);
    let mut text = String::new();
    let mut start = range.start;
    for child in children {
        if child.start >= start {
            text.push_str(&content[start..child.start]);
            text.push(' ');
        }
        start = start.max(child.end);
    }
    text.push_str(&content[start..range.end]);
    text
}

fn collect_ts_candidates(path: &Path, content: &str, tree: &tree_sitter::Tree, mtime: SystemTime,
    path_terms: &[String], spans: Option<&[std::ops::Range<usize>]>) -> Vec<Candidate> {
    let lines = content.lines().collect::<Vec<_>>();
    super::declarations::collect(tree.root_node(), content).into_iter()
        .filter(|declaration| spans.is_none_or(|spans| spans.contains(&declaration.region().id.bytes)))
        .map(|declaration| {
            let region = declaration.region();
            let (start, end) = super::declarations::lines_for(content, &region.declaration);
            let body = region.body.clone().map_or_else(String::new, |body| {
                let nested = declaration.facts().regions.iter()
                    .filter(|child| child.id != region.id && child.name.is_some())
                    .filter(|child| child.body.is_some() || matches!(child.kind,
                        crate::tsjs_source::Kind::Class | crate::tsjs_source::Kind::Interface | crate::tsjs_source::Kind::Namespace))
                    .map(|child| child.declaration.clone()).collect();
                owned_text(content, body, nested)
            });
            Candidate {
                path: path.to_path_buf(), path_terms: path_terms.to_vec(), line: start, end,
                name: region.name.clone().expect("named navigation candidate"), qualified_name: declaration.name_terms(),
                source_line: lines.get(start.saturating_sub(1) as usize).copied().unwrap_or_default().to_string(),
                signature: content[region.signature.clone()].to_string(),
                doc: region.comments.iter().map(|range| &content[range.clone()]).collect::<Vec<_>>().join("\n"),
                body, file_lines: lines.len() as u32, mtime, kind: Some(declaration.outline_kind()), score: 0.0,
                fallback_terms: HashSet::new(), lexical_rank: None, source_association: None, declaration: Some(declaration),
            }
        }).collect()
}

pub(crate) fn definition_name(node: tree_sitter::Node, lines: &[&str], lang: crate::types::Lang) -> Option<String> {
    use crate::lang::treesitter::{extract_definition_name, extract_elixir_definition_name, is_elixir_definition, DEFINITION_KINDS};
    if DEFINITION_KINDS.contains(&node.kind()) {
        extract_definition_name(node, lines)
    } else if lang == crate::types::Lang::Elixir && is_elixir_definition(node, lines) {
        extract_elixir_definition_name(node, lines)
    } else { None }
}

/// Exact parser extent only. Names and display rows never repair an association.
pub(crate) fn syntax_identity_at(root: tree_sitter::Node, content: &str, lang: crate::types::Lang,
    range: std::ops::Range<usize>) -> Option<crate::tsjs_source::Identity> {
    if range.is_empty() { return None; }
    let lines = content.lines().collect::<Vec<_>>();
    let mut node = root.descendant_for_byte_range(range.start, range.end - 1)?;
    let mut found = None;
    loop {
        if node.byte_range() == range && !node.has_error() && definition_name(node, &lines, lang).is_some() {
            if found.is_some() { return None; }
            found = Some(crate::tsjs_source::identity(node));
        }
        let Some(parent) = node.parent().filter(|parent| parent.byte_range() == range) else { break; };
        node = parent;
    }
    found
}

// Outline rows are display coordinates, not ownership boundaries. Associate
// them with a unique existing parser declaration before using implementation
// text. Refuse ambiguous same-name/same-row associations instead of borrowing
// a neighbour's body; the original name/signature candidate remains available.
fn outline_node<'tree>(
    entry: &OutlineEntry,
    nodes: &[(String, tree_sitter::Node<'tree>)],
) -> Option<tree_sitter::Node<'tree>> {
    let mut found = nodes.iter().filter(|(name, node)| {
        !node.has_error() && name == &entry.name
            && node.start_position().row as u32 + 1 == entry.start_line
            && node.end_position().row as u32 + 1 == entry.end_line
    });
    let node = found.next()?.1;
    found.next().is_none().then_some(node)
}
fn test_scope(entry: &OutlineEntry, lines: &[&str], inside: bool) -> bool {
    inside || matches!(entry.kind, OutlineKind::TestSuite | OutlineKind::TestCase)
        || (entry.kind == OutlineKind::Module && entry.name == "tests" && {
            let start = entry.start_line.saturating_sub(1) as usize;
            lines[start.saturating_sub(3)..start.min(lines.len())].iter().any(|line| line.contains("cfg(test)"))
        })
}

pub(crate) fn excluded_test_spans(root: tree_sitter::Node, content: &str, lang: crate::types::Lang) -> Vec<std::ops::Range<usize>> {
    let lines = content.lines().collect::<Vec<_>>();
    let entries = crate::lang::outline::walk_top_level(root, &lines, lang);
    let mut nodes = Vec::new();
    let mut pending = vec![root];
    while let Some(node) = pending.pop() {
        if let Some(name) = definition_name(node, &lines, lang) { nodes.push((name, node)); }
        let mut cursor = node.walk();
        pending.extend(node.named_children(&mut cursor));
    }
    fn visit(entries: &[OutlineEntry], nodes: &[(String, tree_sitter::Node)], lines: &[&str], inside: bool,
        excluded: &mut Vec<std::ops::Range<usize>>) {
        for entry in entries {
            let inside = test_scope(entry, lines, inside);
            if inside {
                if let Some(node) = outline_node(entry, nodes) { excluded.push(node.byte_range()); continue; }
            }
            visit(&entry.children, nodes, lines, inside, excluded);
        }
    }
    let mut excluded = Vec::new();
    visit(&entries, &nodes, &lines, false, &mut excluded);
    excluded
}

fn collect_outline(
    entries: &[OutlineEntry],
    parent: &str,
    path: &Path,
    lines: &[&str],
    content: &str,
    nodes: &[(String, tree_sitter::Node)],
    file_lines: u32,
    mtime: SystemTime,
    candidates: &mut Vec<Candidate>,
    inside_test_scope: bool,
    path_terms: &[String],
    missing_spans: &mut usize,
    selected_spans: Option<&[std::ops::Range<usize>]>,
    include_test_scopes: bool,
) {
    for entry in entries {
        let starts_test_scope = test_scope(entry, lines, inside_test_scope);
        let qualified_name = if parent.is_empty() {
            entry.name.clone()
        } else {
            format!("{parent}::{}", entry.name)
        };
        let selected = selected_spans.is_none_or(|spans| outline_node(entry, nodes).is_some_and(|node| spans.contains(&node.byte_range())));
        if selected && (include_test_scopes || !starts_test_scope) && entry.kind != OutlineKind::Import {
            let source_line = lines
                .get(entry.start_line.saturating_sub(1) as usize)
                .copied()
                .unwrap_or_default()
                .to_string();
            let node = outline_node(entry, nodes);
            let body = if let Some(node) = node {
                let children = entry
                    .children
                    .iter()
                    .filter_map(|child| outline_node(child, nodes))
                    .map(|child| child.byte_range())
                    .collect();
                let body = node.child_by_field_name("body").unwrap_or(node);
                owned_text(content, body.byte_range(), children)
            } else {
                *missing_spans += 1;
                String::new()
            };
            candidates.push(Candidate {
                path: path.to_path_buf(),
                path_terms: path_terms.to_vec(),
                line: entry.start_line,
                end: entry.end_line,
                name: entry.name.clone(),
                qualified_name: qualified_name.clone(),
                source_line,
                signature: entry.signature.clone().unwrap_or_default(),
                doc: entry.doc.clone().unwrap_or_default(),
                body,
                file_lines,
                mtime,
                kind: Some(entry.kind),
                score: 0.0,
                fallback_terms: HashSet::new(),
                lexical_rank: None,
                source_association: node.map(|node| crate::types::SourceAssociation {
                    syntax: Some(crate::tsjs_source::identity(node)), graph_node_id: None,
                }),
                declaration: None,
            });
        }
        collect_outline(
            &entry.children,
            &qualified_name,
            path,
            lines,
            content,
            nodes,
            file_lines,
            mtime,
            candidates,
            starts_test_scope,
            path_terms,
            missing_spans,
            selected_spans,
            include_test_scopes,
        );
    }
}

fn count(tokens: &[String], term: &str) -> usize {
    tokens.iter().filter(|token| token.as_str() == term).count()
}

fn bounded_f64(value: usize) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}

fn score_candidates(candidates: &mut [Candidate], terms: &[String]) -> Vec<(String, usize)> {
    let document_count = bounded_f64(candidates.len().max(1));
    let token_sets: Vec<_> = candidates.iter().map(Candidate::field_tokens).collect();
    // BM25F normalizes each field separately. Pooling body length with names
    // penalizes a useful long operation in favor of its trivial local bindings.
    // Keep the existing weights; source bodies have the same weight as prose.
    let weights = [4.0, 2.0, 1.0, 0.5, 1.0];
    let average_lengths: [f64; 5] = std::array::from_fn(|index| {
        bounded_f64(
            token_sets
                .iter()
                .map(|fields| fields[index].len())
                .sum::<usize>()
                .max(1),
        ) / document_count
    });
    let mut term_counts = Vec::new();

    for term in terms {
        let document_frequency = token_sets
            .iter()
            .filter(|fields| fields.iter().flatten().any(|token| token == term))
            .count();
        let code_frequency = candidates
            .iter()
            .zip(&token_sets)
            .filter(|(candidate, fields)| {
                candidate.kind.is_some() && fields.iter().flatten().any(|token| token == term)
            })
            .count();
        term_counts.push((term.clone(), code_frequency));
        let idf = (1.0
            + (document_count - bounded_f64(document_frequency) + 0.5)
                / (bounded_f64(document_frequency) + 0.5))
            .ln();
        for (candidate, fields) in candidates.iter_mut().zip(&token_sets) {
            let frequency = fields
                .iter()
                .enumerate()
                .map(|(index, tokens)| {
                    weights[index] * bounded_f64(count(tokens, term))
                        / (1.0 - B + B * bounded_f64(tokens.len()) / average_lengths[index])
                })
                .sum::<f64>();
            candidate.score += idf * frequency * (K1 + 1.0) / (frequency + K1);
        }
    }

    for candidate in candidates {
        let normalized_name = tokenize(&candidate.name);
        if terms.len() == 1 && normalized_name == terms {
            candidate.score += 12.0;
        }
        if !terms.is_empty() && terms.iter().all(|term| candidate.contains_term(term)) {
            candidate.score += 3.0;
        }
        if candidate.score > 0.0
            && matches!(
                candidate.kind,
                Some(
                    OutlineKind::Function
                        | OutlineKind::Class
                        | OutlineKind::Struct
                        | OutlineKind::Interface
                        | OutlineKind::Enum
                )
            )
        {
            candidate.score += 0.25;
        }
    }
    term_counts
}

fn edit_distance(left: &str, right: &str) -> usize {
    let mut previous: Vec<usize> = (0..=right.chars().count()).collect();
    for (left_index, left_character) in left.chars().enumerate() {
        let mut current = vec![left_index + 1];
        for (right_index, right_character) in right.chars().enumerate() {
            current.push(
                (current[right_index] + 1)
                    .min(previous[right_index + 1] + 1)
                    .min(previous[right_index] + usize::from(left_character != right_character)),
            );
        }
        previous = current;
    }
    previous.last().copied().unwrap_or(0)
}

fn nearest_mechanism(needle: &str, name: &str) -> Option<(u8, usize, &'static str)> {
    let distance = edit_distance(needle, name);
    if name == needle {
        Some((0, distance, "normalized-name"))
    } else if name.starts_with(needle) {
        Some((1, distance, "prefix"))
    } else if distance <= 2 {
        Some((2, distance, "edit-distance"))
    } else if name.contains(needle) || needle.contains(name) {
        Some((3, distance, "superstring"))
    } else {
        None
    }
}

fn apply_term_nearest(candidates: &mut [Candidate], term: &str) -> Option<String> {
    let best = candidates
        .iter()
        .enumerate()
        .filter_map(|(index, candidate)| {
            if candidate.kind.is_none() {
                return None;
            }
            let name = tokenize(&candidate.name).join("");
            nearest_mechanism(term, &name).map(|(priority, distance, mechanism)| {
                (
                    priority,
                    distance,
                    candidate.path.clone(),
                    candidate.line,
                    index,
                    mechanism,
                )
            })
        })
        .min_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then(left.1.cmp(&right.1))
                .then(left.2.cmp(&right.2))
                .then(left.3.cmp(&right.3))
        });
    let (_, distance, _, _, index, mechanism) = best?;
    let candidate = &mut candidates[index];
    candidate.score = candidate.score.max(0.01 / bounded_f64(distance + 1));
    candidate.fallback_terms.insert(term.to_string());
    Some(mechanism.to_string())
}

fn apply_nearest_fallback(candidates: &mut [Candidate], terms: &[String]) -> bool {
    let needle = terms.join("");
    if needle.is_empty() {
        return false;
    }
    let mut found = false;
    for candidate in candidates {
        if candidate.kind.is_none() {
            continue;
        }
        let name = tokenize(&candidate.name).join("");
        if let Some((_, distance, _)) = nearest_mechanism(&needle, &name) {
            candidate.score = 1.0 / bounded_f64(distance + 1);
            candidate.fallback_terms.extend(terms.iter().cloned());
            found = true;
        }
    }
    found
}

fn candidate_key(candidate: &Candidate) -> (PathBuf, u32, String, Option<(usize, usize, String)>) {
    (
        candidate.path.clone(),
        candidate.line,
        candidate.name.clone(),
        candidate.declaration.as_ref().map(|d| {
            let (start, end, kind) = d.key();
            (start, end, kind.to_string())
        }),
    )
}

fn fair_order(
    mut candidates: Vec<Candidate>,
    terms: &[String],
    pipe_query: bool,
) -> Vec<Candidate> {
    candidates.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then(left.path.cmp(&right.path))
            .then(left.line.cmp(&right.line))
            .then(left.name.cmp(&right.name))
            .then_with(|| {
                left.declaration
                    .as_ref()
                    .map(|d| d.key())
                    .cmp(&right.declaration.as_ref().map(|d| d.key()))
            })
    });
    if !pipe_query || terms.len() < 2 {
        return candidates;
    }

    let mut selected = Vec::new();
    let mut selected_keys = HashSet::new();
    if !candidates.is_empty() {
        let first = candidates.remove(0);
        selected_keys.insert(candidate_key(&first));
        selected.push(first);
    }
    for term in terms {
        if selected.len() >= 5 {
            break;
        }
        if selected
            .iter()
            .any(|candidate| candidate.contains_term(term))
        {
            continue;
        }
        if let Some(index) = candidates.iter().position(|candidate| {
            candidate.contains_term(term) && !selected_keys.contains(&candidate_key(candidate))
        }) {
            let candidate = candidates.remove(index);
            selected_keys.insert(candidate_key(&candidate));
            selected.push(candidate);
        }
    }
    selected.extend(candidates);
    selected
}

/// Select existing rich slots, grouping only body-less bindings/properties local
/// to an already-discovered immediate callable parent. This is source grouping,
/// not a new relevance score, binding proof, or claim of delivered source.
pub(crate) fn rich_targets(result: &SearchResult) -> Vec<&Match> {
    let seeds = result.matches.iter()
        .filter(|matched| matched.is_definition)
        .take(5)
        .collect::<Vec<_>>();
    if result.query.contains('|') || result.query.split_whitespace().take(2).count() < 2 {
        return seeds;
    }
    let mut selected_parents = HashSet::new();
    let targets = seeds.into_iter().map(|seed| {
        let parent = seed.declaration.as_ref()
            .filter(|declaration| {
                matches!(declaration.region().kind,
                    crate::tsjs_source::Kind::Binding | crate::tsjs_source::Kind::PropertySignature)
                    && declaration.region().body.is_none()
            })
            .and_then(|declaration| {
                let parent_id = declaration.region().parent.as_ref()?;
                result.matches.iter().find(|candidate| {
                    candidate.is_definition && candidate.path == seed.path
                        && candidate.declaration.as_ref().is_some_and(|parent| {
                            parent.region().id == *parent_id
                                && matches!(parent.region().kind,
                                    crate::tsjs_source::Kind::Function | crate::tsjs_source::Kind::Method)
                        })
                })
            });
        if let Some(parent) = parent {
            selected_parents.insert((
                parent.path.as_path(),
                parent.declaration.as_ref().expect("source parent checked above").key(),
            ));
            parent
        } else {
            seed
        }
    }).collect::<Vec<_>>();
    // Only collapse identities selected as parents; unrelated seeds stay intact.
    let mut seen_parents = HashSet::new();
    targets.into_iter().filter(|target| {
        let Some(declaration) = &target.declaration else { return true; };
        let key = (target.path.as_path(), declaration.key());
        !selected_parents.contains(&key) || seen_parents.insert(key)
    }).collect()
}

pub(crate) fn search(
    query: &str, scope: &Path, globs: &[String], visibility: crate::walk::Visibility,
    sources: Arc<OperationSources>, context: &OperationContext,
) -> Result<FuzzySearch, String> {
    search_with_focus(query, scope, globs, visibility, sources, context, None)
}

pub(crate) fn search_with_focus(
    query: &str,
    scope: &Path,
    globs: &[String],
    visibility: crate::walk::Visibility,
    sources: Arc<OperationSources>,
    context: &OperationContext,
    focus: Option<&super::focus::Focus>,
) -> Result<FuzzySearch, String> {
    search_candidates(query, scope, globs, visibility, sources, context, focus, false)
}

/// Explicit test-path discovery shares ranking but never changes ordinary Grep
/// exclusions or asserts that a path convention proves test coverage.
pub(crate) fn search_test_files(query: &str, scope: &Path, sources: Arc<OperationSources>,
    context: &OperationContext) -> Result<FuzzySearch, String> {
    search_candidates(query, scope, &[], crate::walk::Visibility::Project, sources, context, None, true)
}

fn search_candidates(query: &str, scope: &Path, globs: &[String], visibility: crate::walk::Visibility,
    sources: Arc<OperationSources>, context: &OperationContext, focus: Option<&super::focus::Focus>,
    test_files_only: bool) -> Result<FuzzySearch, String> {
    let normalized_terms = normalize_terms(query);
    if normalized_terms.is_empty() {
        return Err("behavior query has no content terms after normalization".into());
    }
    // A targeted focus selects one exact owner; an emphasis-only focus keeps the
    // ordinary connected candidates and selects nothing.
    let targeted = focus.is_some_and(|focus| focus.has_target());
    let walked = sources.scoped_files(
        scope,
        &crate::walk::WalkOptions {
            visibility,
            policy_root: None,
            min_depth: 0,
            max_depth: None,
            patterns: globs.to_vec(),
            deadline: context.deadline,
            cancelled: Some(context.cancelled.clone()),
            candidate_cap: None,
        },
    )?;
    let mut complete = walked.complete
        || focus.and_then(|focus| focus.path_restriction()).is_some_and(|path| walked.paths.iter().any(|candidate| candidate == path));
    let mut diagnostics = walked.diagnostics;
    let mut candidates = Vec::new();

    'files: for path in walked.paths.into_iter().filter(|path| focus
        .and_then(|focus| focus.path_restriction())
        .is_none_or(|restricted| *path == restricted)) {
        if context.check().is_err() {
            complete = false;
            diagnostics.push("behavior discovery cancelled or exceeded its wall budget".into());
            break;
        }
        let file_type = crate::lang::detect_file_type(&path);
        if !matches!(file_type, FileType::Code(_) | FileType::Markdown) {
            continue;
        }
        if test_files_only {
            if !matches!(file_type, FileType::Code(_)) || !path.strip_prefix(&context.root).ok().is_some_and(crate::types::is_test_file) { continue; }
        } else if !targeted && matches!(file_type, FileType::Code(_)) && crate::types::is_test_file(&path) {
            continue;
        }
        let Ok(content) = sources.read_text(&path) else {
            diagnostics.push(format!("{}: unreadable", path.display()));
            complete = false;
            continue;
        };
        let lines: Vec<&str> = content.lines().collect();
        let mtime = std::fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let relative_path = path
            .strip_prefix(&context.root)
            .or_else(|_| path.strip_prefix(scope))
            .ok()
            .filter(|relative| !relative.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new(path.file_name().unwrap_or_default()));
        let path_terms = tokenize(&relative_path.to_string_lossy());
        if matches!(file_type, FileType::Markdown) {
            let Some(structure) = crate::read::outline::markdown::structure(&content) else {
                complete = false;
                diagnostics.push(format!(
                    "{}: Markdown structure unavailable",
                    path.display()
                ));
                continue;
            };
            // Headings partition sections, not the whole document. The prefix
            // (or entire headerless file) is an independent source candidate.
            let prefix_end = structure
                .sections
                .first()
                .map_or(content.len(), |section| section.heading_start_byte);
            let prefix = &content[..prefix_end];
            if !prefix.trim().is_empty() {
                candidates.push(Candidate {
                    path: path.clone(),
                    path_terms: path_terms.clone(),
                    line: 1,
                    end: prefix.lines().count() as u32,
                    name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    qualified_name: String::new(),
                    source_line: lines.first().copied().unwrap_or_default().to_string(),
                    signature: String::new(),
                    doc: String::new(),
                    body: prefix.to_string(),
                    file_lines: lines.len() as u32,
                    mtime,
                    kind: None,
                    score: 0.0,
                    fallback_terms: HashSet::new(),
                    lexical_rank: None,
                    source_association: None,
                    declaration: None,
                });
            }
            for section in &structure.sections {
                let mut titles = vec![section.title.clone()];
                let mut parent = section.parent.as_deref();
                while let Some(ancestor) = parent.and_then(|selector| {
                    crate::read::outline::markdown::section_by_selector(&structure, selector)
                }) {
                    titles.push(ancestor.title.clone());
                    parent = ancestor.parent.as_deref();
                }
                titles.reverse();
                candidates.push(Candidate {
                    path: path.clone(),
                    path_terms: path_terms.clone(),
                    line: section.heading_start_line,
                    end: section.own_end_line,
                    name: section.title.clone(),
                    qualified_name: titles.join(" > "),
                    source_line: lines
                        .get(section.heading_start_line.saturating_sub(1) as usize)
                        .copied()
                        .unwrap_or_default()
                        .to_string(),
                    signature: content[section.heading_start_byte..section.heading_end_byte]
                        .to_string(),
                    doc: String::new(),
                    body: content[section.heading_end_byte..section.own_end_byte].to_string(),
                    file_lines: lines.len() as u32,
                    mtime,
                    kind: None,
                    score: 0.0,
                    fallback_terms: HashSet::new(),
                    lexical_rank: None,
                    source_association: None,
                    declaration: None,
                });
            }
        } else if let FileType::Code(lang) = file_type {
            if super::declarations::supports(lang) {
                let mut parser = tree_sitter::Parser::new();
                let grammar = crate::lang::outline::outline_language(lang).expect("TS/JS grammar");
                parser
                    .set_language(&grammar)
                    .map_err(|error| error.to_string())?;
                let Some(tree) = parser.parse(content.as_str(), None) else {
                    diagnostics.push(format!("{}: parser unavailable", path.display()));
                    complete = false;
                    continue;
                };
                if tree.root_node().has_error() {
                    if focus.and_then(|focus| focus.path_restriction()).is_some_and(|restricted| restricted == path) { complete = false; }
                    diagnostics.push(format!(
                        "{}: partial syntax; healthy source declarations retained",
                        path.display()
                    ));
                }
                candidates.extend(collect_ts_candidates(&path, &content, &tree, mtime, &path_terms, None));
            } else {
                let mut parser = tree_sitter::Parser::new();
                let tree = crate::lang::outline::outline_language(lang)
                    .and_then(|grammar| parser.set_language(&grammar).ok())
                    .and_then(|()| parser.parse(content.as_str(), None));
                let entries = tree.as_ref().map_or_else(
                    || crate::lang::outline::get_outline_entries(&content, lang),
                    |tree| crate::lang::outline::walk_top_level(tree.root_node(), &lines, lang),
                );
                let mut nodes = Vec::new();
                let mut pending = tree
                    .as_ref()
                    .map(|tree| tree.root_node())
                    .into_iter()
                    .collect::<Vec<_>>();
                while let Some(node) = pending.pop() {
                    if context.check().is_err() {
                        complete = false;
                        diagnostics.push(
                            "behavior discovery cancelled or exceeded its wall budget".into(),
                        );
                        break 'files;
                    }
                    let name = definition_name(node, &lines, lang);
                    if let Some(name) = name {
                        nodes.push((name, node));
                    }
                    let mut cursor = node.walk();
                    pending.extend(node.named_children(&mut cursor));
                }
                let mut missing_spans = 0;
                collect_outline(
                    &entries,
                    "",
                    &path,
                    &lines,
                    &content,
                    &nodes,
                    lines.len() as u32,
                    mtime,
                    &mut candidates,
                    false,
                    &path_terms,
                    &mut missing_spans,
                    None,
                    test_files_only,
                );
                if missing_spans > 0 {
                    complete = false;
                    diagnostics.push(format!("{}: implementation text unavailable for {missing_spans} outline declaration(s) without unique syntax spans; names and signatures retained", path.display()));
                }
            }
        }
        if let Some(focus) = focus.filter(|focus| focus.has_target()) {
            // Focus is an exact source filter, not post-cap rescue. Unrelated
            // files and declarations cannot consume its collection allowance.
            // A path-qualified target keeps the existing qualified identity; a
            // name-only target adds exact identity of the declared name so
            // several owners stay visible as honest alternatives.
            let restricted = focus.path_restriction().is_some();
            candidates.retain(|candidate| {
                let qualified = candidate.declaration.as_ref().and_then(super::focus::declaration_name)
                    .or_else(|| candidate.declaration.is_none().then(|| candidate.qualified_name.clone()));
                qualified.is_some_and(|qualified| if restricted {
                    super::focus::name_matches(&focus.name, &qualified)
                } else {
                    super::focus::identity_matches(&focus.name, &qualified, &candidate.name)
                })
            });
        }
        if candidates.len() >= MAX_CANDIDATES {
            candidates.truncate(MAX_CANDIDATES);
            complete = false;
            diagnostics.push(format!(
                "behavior discovery reached its {MAX_CANDIDATES}-candidate cap; total is unknown"
            ));
            break;
        }
    }

    let term_counts = score_candidates(&mut candidates, &normalized_terms);
    let mut lexical_order = (0..candidates.len()).filter(|&index| candidates[index].score > 0.0).collect::<Vec<_>>();
    lexical_order.sort_by(|&a, &b| candidates[b].score.total_cmp(&candidates[a].score));
    for (rank, index) in lexical_order.into_iter().enumerate() { candidates[index].lexical_rank = Some(rank + 1); }
    let has_lexical_results = candidates.iter().any(|candidate| candidate.score > 0.0);
    let nearest_fallback = if has_lexical_results || targeted {
        false
    } else {
        apply_nearest_fallback(&mut candidates, &normalized_terms)
    };
    let mut term_fallbacks = Vec::new();
    for (term, count) in &term_counts {
        if targeted {
            term_fallbacks.push((term.clone(), "original-question context; exact focus selection".into()));
        } else if *count > 0 {
            term_fallbacks.push((term.clone(), "code-candidates".into()));
        } else if nearest_fallback {
            let mechanism =
                apply_term_nearest(&mut candidates, term).unwrap_or_else(|| "unclassified".into());
            term_fallbacks.push((term.clone(), format!("nearest-symbol:{mechanism}")));
        } else if let Some(mechanism) = apply_term_nearest(&mut candidates, term) {
            term_fallbacks.push((term.clone(), format!("nearest-symbol:{mechanism}")));
        } else {
            term_fallbacks.push((term.clone(), "no-declaration".into()));
        }
    }
    let mut focus_metadata = None;
    let ordered = if let Some(focus) = focus.filter(|focus| focus.has_target()) {
        // Select from the very same bounded, filtered source collection before
        // lexical scores discard declarations unrelated to the question words.
        let selected = candidates;
        let alternatives = selected.iter().map(|candidate| {
            let identity = candidate.declaration.as_ref().map(|declaration| {
                let (start, end, kind) = declaration.key();
                serde_json::json!({"startByte":start,"endByte":end,"syntaxKind":kind})
            });
            serde_json::json!({"path":candidate.path,"name":candidate.name,
                "qualifiedName":candidate.qualified_name,"line":candidate.line,"endLine":candidate.end,
                "sourceIdentity":identity})
        }).collect();
        focus_metadata = Some(focus.metadata(alternatives, complete));
        selected
    } else {
        if let Some(focus) = focus {
            // Emphasis-only: keep the ordinary connected candidates and select
            // no owner; lexical scoring still orders them.
            focus_metadata = Some(focus.emphasis_metadata(complete));
        }
        let scored = candidates.into_iter().filter(|candidate| candidate.score > 0.0).collect();
        fair_order(scored, &normalized_terms, query.contains('|'))
    };
    let total_found = ordered.len();
    let lexical_ranks = ordered.iter().map(|candidate| candidate.lexical_rank).collect();
    let matches = ordered.into_iter()
        .map(|candidate| {
            let name_terms = tokenize(&candidate.name);
            let exact = targeted ||
                name_terms.len() == 1 && normalized_terms.iter().any(|term| term == &name_terms[0]);
            Match {
                path: candidate.path,
                line: candidate.line,
                text: candidate.source_line,
                is_definition: true,
                exact,
                file_lines: candidate.file_lines,
                mtime: candidate.mtime,
                def_range: Some((candidate.line, candidate.end)),
                def_name: Some(candidate.name),
                def_weight: (candidate.score * 100.0).clamp(1.0, f64::from(u16::MAX)) as u16,
                source_association: candidate.source_association,
                declaration: candidate.declaration,
                impl_target: None,
            }
        })
        .collect::<Vec<_>>();
    Ok(FuzzySearch {
        focus: focus_metadata,
        result: SearchResult {
            query: query.to_string(),
            scope: scope.to_path_buf(),
            matches,
            sources,
            total_found,
            definitions: total_found,
            usages: 0,
            facet_totals: FacetTotals {
                definitions: total_found,
                ..FacetTotals::default()
            },
        },
        normalized_terms,
        lexical_ranks,
        term_counts,
        nearest_fallback,
        term_fallbacks,
        complete,
        diagnostics,
    })
}

/// Fuse independent rankings before rich-target selection. Semantic retrieval
/// covers the admitted graph, including owners with zero lexical score. It does
/// not change lexical term counts, nearest-name reasons, or occurrence records.
pub(crate) fn fuse_semantic(search: &mut FuzzySearch, mut semantic: Vec<Match>) {
    if semantic.is_empty() || search.focus.is_some() || search.result.query.contains('|') { return; }
    let key = |matched: &Match| matched.syntax_key().map(|(start, end, kind)|
        (matched.path.clone(), start, end, kind.to_string()));
    let mut semantic_counts = std::collections::HashMap::new();
    for matched in &semantic { if let Some(key) = key(matched) { *semantic_counts.entry(key).or_insert(0usize) += 1; } }
    let mut ambiguous = 0;
    for matched in &mut semantic {
        if key(matched).is_some_and(|key| semantic_counts[&key] > 1) {
            if let Some(association) = &mut matched.source_association { association.syntax = None; }
            ambiguous += 1;
        }
    }
    let mut candidates = Vec::new();
    let mut positions = std::collections::HashMap::<_, Vec<usize>>::new();
    let mut mentions = Vec::new();
    for (index, matched) in std::mem::take(&mut search.result.matches).into_iter().enumerate() {
        if !matched.is_definition { mentions.push(matched); continue; }
        if let Some(key) = key(&matched) { positions.entry(key).or_default().push(candidates.len()); }
        let score = search.lexical_ranks.get(index).copied().flatten()
            .map_or(0.0, |rank| 1.0 / (60.0 + bounded_f64(rank)));
        candidates.push((score, matched));
    }
    for (rank, mut matched) in semantic.into_iter().enumerate() {
        let score = 1.0 / (60.0 + bounded_f64(rank + 1));
        let position = key(&matched).and_then(|key| positions.get(&key)).filter(|positions| positions.len() == 1)
            .map(|positions| positions[0]);
        if let Some(index) = position {
            candidates[index].0 += score;
            candidates[index].1.source_association = matched.source_association.take();
        } else {
            matched.exact = false;
            candidates.push((score, matched));
        }
    }
    let named = |matched: &Match| matched.def_name.as_ref().is_some_and(|name|
        search.result.query.split_whitespace().any(|word| word == name));
    candidates.sort_by(|a, b| named(&b.1).cmp(&named(&a.1)).then(b.0.total_cmp(&a.0)));
    if ambiguous > 0 {
        search.complete = false;
        search.diagnostics.push(format!("{ambiguous} semantic graph candidates share syntax extents; retained separately without a fusion association"));
    }
    if candidates.len() > MAX_CANDIDATES {
        let omitted = candidates.len() - MAX_CANDIDATES;
        candidates.truncate(MAX_CANDIDATES);
        search.complete = false;
        search.diagnostics.push(format!("fused candidate cap omitted {omitted} candidates; they are not retained for continuation"));
    }
    search.result.matches = candidates.into_iter().map(|(_, matched)| matched).chain(mentions).collect();
    search.lexical_ranks.clear();
    search.result.definitions = search.result.matches.iter().filter(|matched| matched.is_definition).count();
    search.result.total_found = search.result.matches.len();
    search.result.facet_totals.definitions = search.result.definitions;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fusion_search(result: SearchResult, lexical_ranks: Vec<Option<usize>>) -> FuzzySearch {
        FuzzySearch { result, lexical_ranks, focus:None, normalized_terms:vec![], term_counts:vec![("question".into(),0)],
            nearest_fallback:false, term_fallbacks:vec![], complete:true, diagnostics:vec![] }
    }

    fn semantic_match(mut matched: Match, id: &str) -> Match {
        let syntax = matched.syntax_key().map(|(start,end,kind)| crate::tsjs_source::Identity {
            bytes:start..end, syntax_kind:kind.into(),
        });
        matched.source_association = Some(crate::types::SourceAssociation { syntax, graph_node_id:Some(id.into()) });
        matched.exact = false;
        matched
    }

    #[test]
    fn semantic_fusion_uses_rust_syntax_not_graph_display_qualification() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::write(root.join("main.rs"), "/*😀*/ fn persist() {} fn other() {}\n").unwrap();
        let native = crate::dispatch::NativeSession::new(&root, false).unwrap();
        let context = OperationContext::for_session(&native, crate::dispatch::ReadFormat::Plain, true);
        let mut lexical = search("persist", &root, &[], crate::walk::Visibility::Project, Arc::default(), &context).unwrap();
        assert_eq!(lexical.result.matches.len(), 1);
        assert!(lexical.result.matches[0].declaration.is_none());
        assert!(lexical.result.matches[0].syntax_key().is_some());
        let mut semantic = semantic_match(lexical.result.matches[0].clone(), "graph-persist");
        semantic.def_name = Some("Owner::persist".into());
        let before = lexical.term_counts.clone();
        fuse_semantic(&mut lexical, vec![semantic]);
        assert_eq!(lexical.result.matches.len(), 1);
        assert_eq!(lexical.result.matches[0].def_name.as_deref(), Some("persist"));
        assert!(lexical.result.matches[0].exact, "fusion must preserve a real lexical exact fact");
        assert_eq!(lexical.result.matches[0].graph_node_id(), Some("graph-persist"));
        assert_eq!(lexical.term_counts, before);
    }

    #[test]
    fn semantic_fusion_retains_ambiguous_and_unassociated_candidates_separately() {
        let mut result = parsed_result("function persist() {}\n");
        result.query = "durable requests".into();
        let first = semantic_match(result.matches[0].clone(), "first");
        let second = semantic_match(result.matches[0].clone(), "second");
        let mut search = fusion_search(result.clone(), vec![Some(1)]);
        fuse_semantic(&mut search, vec![first,second]);
        assert_eq!(search.result.matches.len(), 3);
        assert!(!search.complete);
        assert_eq!(search.result.matches.iter().map(super::super::lanes::target_key).collect::<HashSet<_>>().len(), 3);
        let mut unassociated = semantic_match(result.matches[0].clone(), "unassociated");
        unassociated.source_association.as_mut().unwrap().syntax = None;
        let mut search = fusion_search(result, vec![Some(1)]);
        fuse_semantic(&mut search, vec![unassociated]);
        assert_eq!(search.result.matches.len(), 2, "matching names and line ranges are not a merge proof");
    }

    #[test]
    fn semantic_fusion_does_not_award_nearest_fallback_a_lexical_vote_or_change_pipe_focus() {
        let mut result = parsed_result("function nearby() {} function actual() {}\n");
        result.query = "zxqv blorf".into();
        let semantic = semantic_match(result.matches.pop().unwrap(), "actual");
        let mut search = fusion_search(result.clone(), vec![None]);
        search.nearest_fallback = true;
        fuse_semantic(&mut search, vec![semantic.clone()]);
        assert_eq!(search.result.matches[0].graph_node_id(), Some("actual"));
        assert!(search.nearest_fallback);
        assert_eq!(search.term_counts, vec![("question".into(),0)]);
        for focused in [false,true] {
            let mut search = fusion_search(result.clone(), vec![None]);
            if focused { search.focus = Some(serde_json::json!({"status":"ok"})); }
            else { search.result.query = "nearby|actual".into(); }
            fuse_semantic(&mut search, vec![semantic.clone()]);
            assert_eq!(search.result.matches.len(), 1);
            assert_eq!(search.result.matches[0].def_name.as_deref(), Some("nearby"));
        }
    }

    #[test]
    fn semantic_syntax_association_refuses_widened_and_same_row_ambiguous_outline_spans() {
        let content = "/*😀*/ fn same() {} fn same() {}";
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&tree_sitter_rust::LANGUAGE.into()).unwrap();
        let tree = parser.parse(content, None).unwrap();
        let first = content.find("fn same").unwrap();
        let end = first + "fn same() {}".len();
        assert!(syntax_identity_at(tree.root_node(), content, crate::types::Lang::Rust, first..end).is_some());
        assert!(syntax_identity_at(tree.root_node(), content, crate::types::Lang::Rust, 0..end).is_none());
        let entries = crate::lang::outline::walk_top_level(tree.root_node(), &[content], crate::types::Lang::Rust);
        let mut cursor = tree.root_node().walk();
        let nodes = tree.root_node().named_children(&mut cursor).filter_map(|node| definition_name(node, &[content], crate::types::Lang::Rust).map(|name| (name,node))).collect::<Vec<_>>();
        assert_eq!(entries.len(), 2);
        assert!(outline_node(&entries[0], &nodes).is_none());
    }

    fn parsed_result(source: &str) -> SearchResult {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()).unwrap();
        let tree = parser.parse(source, None).unwrap();
        assert!(!tree.root_node().has_error());
        let matches = super::super::declarations::collect(tree.root_node(), source)
            .iter()
            .map(|declaration| declaration.to_match(
                Path::new("input.ts"), source, source.lines().count() as u32, SystemTime::UNIX_EPOCH,
            ))
            .collect::<Vec<_>>();
        SearchResult {
            query: "local value".into(),
            scope: PathBuf::from("."),
            total_found: matches.len(),
            definitions: matches.len(),
            usages: 0,
            facet_totals: FacetTotals { definitions: matches.len(), ..FacetTotals::default() },
            matches,
            sources: Arc::new(OperationSources::default()),
        }
    }

    #[test]
    fn rich_targets_group_existing_sixth_parent_without_backfill_or_match_mutation() {
        let mut result = parsed_result("function operation(input: { parameter: number }) { const first = 1; const second = 2; } function spareA() {} function spareB() {} function spareC() {} function filler() {}");
        let named = |name: &str| result.matches.iter()
            .find(|matched| matched.def_name.as_deref() == Some(name)).unwrap().clone();
        let ordered = ["first", "parameter", "spareA", "spareB", "spareC", "operation", "filler"]
            .map(named).to_vec();
        result.matches = ordered;
        // A real Markdown heading occupies an ordinary seed slot.
        let section = crate::read::outline::markdown::structure("# Guide\n").unwrap().sections.remove(0);
        result.matches[2].path = PathBuf::from("guide.md");
        result.matches[2].line = section.heading_start_line;
        result.matches[2].text = "# Guide".into();
        result.matches[2].def_name = Some(section.title);
        result.matches[2].def_range = Some((section.heading_start_line, section.own_end_line));
        result.matches[2].declaration = None;
        let before = result.matches.iter()
            .map(|matched| (matched.path.clone(), matched.def_name.clone(), matched.line)).collect::<Vec<_>>();
        let selected = rich_targets(&result);
        assert_eq!(selected.iter().map(|matched| matched.def_name.as_deref().unwrap()).collect::<Vec<_>>(),
            ["operation", "Guide", "spareB", "spareC"]);
        assert!(std::ptr::eq(selected[0], &result.matches[5]));
        assert_eq!(before, result.matches.iter()
            .map(|matched| (matched.path.clone(), matched.def_name.clone(), matched.line)).collect::<Vec<_>>());
        // Selecting the same parent directly as well must not repeat it.
        result.matches.swap(1, 5);
        assert_eq!(rich_targets(&result).len(), 4);
        // Usage rows do not consume any of the five definition slots.
        let mut usage = result.matches[0].clone();
        usage.is_definition = false;
        result.matches.insert(0, usage);
        assert_eq!(rich_targets(&result).iter().map(|matched| matched.def_name.as_deref().unwrap()).collect::<Vec<_>>(),
            ["operation", "Guide", "spareB", "spareC"]);
    }

    #[test]
    fn rich_targets_keep_same_name_same_line_bindings_in_distinct_methods() {
        let mut result = parsed_result("class Store { left() { const proof = 1; } right() { const proof = 2; } } function spareA() {} function spareB() {} function spareC() {}");
        let proofs = result.matches.iter()
            .filter(|matched| matched.def_name.as_deref() == Some("proof")).cloned().collect::<Vec<_>>();
        assert_eq!(proofs.len(), 2);
        assert_eq!(proofs[0].line, proofs[1].line);
        assert_ne!(proofs[0].declaration.as_ref().unwrap().region().parent,
            proofs[1].declaration.as_ref().unwrap().region().parent);
        let named = |name: &str| result.matches.iter()
            .find(|matched| matched.def_name.as_deref() == Some(name)).unwrap().clone();
        let mut ordered = proofs;
        ordered.extend(["spareA", "spareB", "spareC", "left", "right"].map(named));
        result.matches = ordered;
        assert_eq!(rich_targets(&result).iter().map(|matched| matched.def_name.as_deref().unwrap()).collect::<Vec<_>>(),
            ["left", "right", "spareA", "spareB", "spareC"]);
        // Identical parser spans in another file are not this binding's parent.
        result.matches[5].path = PathBuf::from("other.ts");
        assert!(std::ptr::eq(rich_targets(&result)[0], &result.matches[0]));
        result.matches[6].is_definition = false;
        assert!(std::ptr::eq(rich_targets(&result)[1], &result.matches[1]));
    }

    #[test]
    fn rich_targets_leave_nonlocal_unrepresented_and_non_phrase_seeds_alone() {
        let mut result = parsed_result("const moduleValue = 0; class Store { field = 0; method() { (() => { const hidden = 1; })(); } } function missing() { const absent = 1; } function host() { const container = { key: 1 }; }");
        let named = |name: &str| result.matches.iter()
            .find(|matched| matched.def_name.as_deref() == Some(name)).unwrap().clone();
        let ordered = ["moduleValue", "field", "hidden", "absent", "container", "Store", "method", "host"]
            .map(named).to_vec();
        result.matches = ordered;
        assert!(result.matches[4].declaration.as_ref().unwrap().region().body.is_some());
        let selected = rich_targets(&result);
        assert_eq!(selected.len(), 5);
        assert!(selected.iter().zip(&result.matches[..5])
            .all(|(actual, expected)| std::ptr::eq(*actual, expected)));
        let mut eligible = parsed_result("function operation() { const first = 1; const second = 2; }");
        eligible.matches.rotate_left(1);
        for query in ["first|second", "first | second", "first", " first "] {
            eligible.query = query.into();
            let selected = rich_targets(&eligible);
            assert_eq!(selected.len(), 3);
            assert!(selected.iter().zip(&eligible.matches)
                .all(|(actual, expected)| std::ptr::eq(*actual, expected)));
        }
        eligible.query = "first\tsecond".into();
        assert_eq!(rich_targets(&eligible).len(), 1);
    }

    #[test]
    fn normalization_removes_question_scaffolding_and_splits_identifiers() {
        assert_eq!(
            normalize_terms("where is token expiry handled"),
            vec!["token", "expiry"]
        );
        assert_eq!(
            normalize_terms("token|expiry|backoff"),
            vec!["token", "expiry", "backoff"]
        );
        assert_eq!(
            normalize_terms("scheduleTokenRenewal"),
            vec!["schedule", "token", "renewal"]
        );
        assert_eq!(normalize_terms("find"), ["find"]);
        assert_eq!(normalize_terms("findCache"), ["find", "cache"]);
        assert_eq!(normalize_terms("find|show"), ["find", "show"]);
        assert_eq!(normalize_terms("where is"), ["where", "is"]);
    }

    #[test]
    fn ranked_collection_retains_candidates_beyond_the_presentation_window() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let text = (0..137).map(|index| format!("function owner{index}() {{ return 'needle'; }}\n")).collect::<String>();
        std::fs::write(root.join("owners.ts"), &text).unwrap();
        let native = crate::dispatch::NativeSession::new(&root, false).unwrap();
        let context = OperationContext::for_session(&native, crate::dispatch::ReadFormat::Plain, true);
        let result = search("needle", &root, &[], crate::walk::Visibility::Project,
            Arc::new(OperationSources::default()), &context).unwrap();
        assert_eq!(result.result.matches.len(), 137);
        assert_eq!(result.result.total_found, 137);
        let candidates = result.result.matches.iter().collect::<Vec<_>>();
        let identities = candidates.iter().map(|matched| matched.declaration.as_ref().unwrap().key()).collect::<HashSet<_>>();
        assert_eq!(identities.len(), 137);
        for matched in candidates {
            assert_eq!(matched.text, text.lines().nth(matched.line as usize - 1).unwrap());
        }
    }

    #[test]
    fn edit_distance_is_bounded_and_deterministic() {
        assert_eq!(edit_distance("procesbatchlarge", "processbatchlarge"), 1);
        assert_eq!(edit_distance("cache", "cache"), 0);
        assert_eq!(edit_distance("cache", "token"), 5);
    }
}

/// Single supplied file, using the same candidate fields as lexical discovery.
/// No walker/cache/metadata access: the path is only a language and input label.
pub(crate) fn project_semantic_inputs(path: &str, content: &str, owners: &[crate::semantic::InputOwner],
    context: &OperationContext) -> Result<Vec<serde_json::Value>, String> {
    use serde_json::json;
    let unavailable = |status: &str| owners.iter().map(|owner| json!({"id":owner.id,"status":status})).collect();
    let path_label = Path::new(path);
    let FileType::Code(lang) = crate::lang::detect_file_type(path_label) else { return Ok(unavailable("unsupported")); };
    let Some(grammar) = crate::lang::outline::outline_language(lang) else { return Ok(unavailable("unsupported")); };
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&grammar).map_err(|error| error.to_string())?;
    context.check().map_err(|error| error.to_string())?;
    let Some(tree) = parser.parse(content, None) else { return Ok(unavailable("unsupported")); };
    context.check().map_err(|error| error.to_string())?;
    if tree.root_node().has_error() { return Ok(unavailable("invalid_syntax")); }
    let spans = owners.iter().filter_map(|owner| owner.span(content)).collect::<Vec<_>>();
    let mut ambiguous_spans = Vec::new();
    let candidates = if super::declarations::supports(lang) {
        collect_ts_candidates(path_label, content, &tree, SystemTime::UNIX_EPOCH, &[], Some(&spans))
    } else {
        let lines = content.lines().collect::<Vec<_>>();
        let entries = crate::lang::outline::walk_top_level(tree.root_node(), &lines, lang);
        let mut pending = vec![tree.root_node()];
        let mut nodes = Vec::new();
        while let Some(node) = pending.pop() {
            context.check().map_err(|error| error.to_string())?;
            if let Some(name) = definition_name(node, &lines, lang) { nodes.push((name, node)); }
            let mut cursor = node.walk();
            pending.extend(node.named_children(&mut cursor));
        }
        for span in &spans {
            if let Some((name, node)) = nodes.iter().find(|(_, node)| node.byte_range() == *span) {
                if nodes.iter().filter(|(other_name, other)| other_name == name
                    && other.start_position().row == node.start_position().row
                    && other.end_position().row == node.end_position().row).take(2).count() > 1 {
                    ambiguous_spans.push(span.clone());
                }
            }
        }
        let mut candidates = Vec::new();
        collect_outline(&entries, "", path_label, &lines, content, &nodes, lines.len() as u32,
            SystemTime::UNIX_EPOCH, &mut candidates, false, &[], &mut 0, Some(&spans), false);
        candidates
    };
    let mut results = Vec::with_capacity(owners.len());
    for owner in owners {
        context.check().map_err(|error| error.to_string())?;
        let mut result = json!({"id":owner.id,"status":"unsupported"});
        let Some(span) = owner.span(content) else {
            result["status"] = json!("invalid_extent"); results.push(result); continue;
        };
        let identity = |candidate: &Candidate| candidate.declaration.as_ref().map(|d| d.region().id.clone())
            .or_else(|| candidate.source_association.as_ref().and_then(|a| a.syntax.clone()));
        let matching = candidates.iter().filter(|c| identity(c).is_some_and(|id| id.bytes == span)).collect::<Vec<_>>();
        if matching.len() > 1 || ambiguous_spans.contains(&span) { result["status"] = json!("ambiguous"); }
        else if let Some(candidate) = matching.first() {
            let syntax = identity(candidate).expect("selected exact syntax");
            let kind = semantic_source_kind(candidate, &tree, content);
            if kind == "unsupported" { result["status"] = json!("unsupported"); }
            else if kind != owner.kind { result["status"] = json!("kind_mismatch"); }
            else {
                let input = json!([crate::semantic::REPRESENTATION, path, candidate.qualified_name, kind,
                    candidate.signature, candidate.doc, candidate.body]).to_string();
                result["syntax"] = json!({"startByte":syntax.bytes.start,"endByte":syntax.bytes.end,"kind":syntax.syntax_kind});
                result["coverage"] = json!(if candidate.declaration.is_some() { "tsjs-source-owned" } else { "legacy-outline-owned" });
                if input.len() > crate::semantic::MAX_TEXT_BYTES { result["status"] = json!("oversized"); }
                else { result["status"] = json!("ok"); result["input"] = json!(input); }
            }
        }
        results.push(result);
    }
    Ok(results)
}

fn semantic_source_kind(candidate: &Candidate, tree: &tree_sitter::Tree, content: &str) -> &'static str {
    use crate::tsjs_source::Kind;
    if let Some(declaration) = &candidate.declaration {
        return match declaration.region().kind {
            Kind::Function => "function", Kind::Method | Kind::MethodSignature => "method",
            Kind::Class => "class", Kind::Interface => "interface", Kind::Enum => "enum",
            Kind::TypeAlias => "type_alias", Kind::Namespace => "namespace",
            Kind::Field | Kind::PropertySignature => "property",
            Kind::Binding => {
                let identity = &declaration.region().id;
                let span = &identity.bytes;
                let mut node = tree.root_node().descendant_for_byte_range(span.start, span.end.saturating_sub(1));
                while node.is_some_and(|node| node.kind() != identity.syntax_kind || node.byte_range() != *span) {
                    node = node.and_then(|node| node.parent());
                }
                let constant = node.and_then(|node| node.parent()).and_then(|node| node.child(0))
                    .is_some_and(|token| token.utf8_text(content.as_bytes()).ok() == Some("const"));
                if constant { "constant" } else { "variable" }
            }
            _ => "unsupported",
        };
    }
    match candidate.kind {
        Some(OutlineKind::Function) => "function", Some(OutlineKind::Class) => "class",
        Some(OutlineKind::Struct) => "struct", Some(OutlineKind::Interface) => "interface",
        Some(OutlineKind::TypeAlias) => "type_alias", Some(OutlineKind::Enum) => "enum",
        Some(OutlineKind::Constant) => "constant", Some(OutlineKind::Variable | OutlineKind::ImmutableVariable) => "variable",
        Some(OutlineKind::Property) => "property", Some(OutlineKind::Module) => "module", _ => "unsupported",
    }
}
