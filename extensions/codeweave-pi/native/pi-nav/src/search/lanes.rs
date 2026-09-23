//! Source-checked relationship evidence for ranked symbol cards.
//!
//! Caller producers combine lexical same-name sites with supported aliases;
//! re-reading bytes proves the carrier, not its target binding (shadowing can
//! survive). Outgoing sites retain immediate source owners and declaration
//! alternatives; neither live syntax nor prepared provenance proves runtime dispatch.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use crate::dispatch::OperationContext;
use crate::types::{FileType, Match, SearchResult};
use crate::walk::{Visibility, WalkOptions};

use super::callees::DeclarationCandidate;
use super::callers::CallerMatch;

/// Non-call graph evidence. Some dependencies have no occurrence position;
/// retain that distinction instead of manufacturing a caller or callsite.
#[derive(Debug, Clone)]
pub(crate) struct StoredConnection {
    pub(crate) kind: String,
    pub(crate) heading: &'static str,
    pub(crate) note: String,
    pub(crate) source: Option<CallerMatch>,
    pub(crate) definition: Option<DeclarationCandidate>,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct SymbolLanes {
    pub(crate) callers: Vec<CallerMatch>,
    pub(crate) test_callers: usize,
    pub(crate) callees: Vec<DeclarationCandidate>,
    pub(crate) connections: Vec<super::callees::CallConnection>,
    pub(crate) function_references: Vec<CallerMatch>,
    pub(crate) referenced_functions: Vec<DeclarationCandidate>,
    pub(crate) heuristic_definitions: Vec<DeclarationCandidate>,
    /// Captured contains edges: declaration membership, never an invocation.
    pub(crate) member_definitions: Vec<DeclarationCandidate>,
    pub(crate) stored_connections: Vec<StoredConnection>,
    pub(crate) connection_notes: Vec<String>,
    /// Unresolved names retained by the prepared-capture compatibility carrier.
    /// Missing bindings are not evidence that a name is external to the project.
    pub(crate) unresolved_callees: Vec<String>,
}

pub(crate) type TargetKey = (
    PathBuf,
    Option<(usize, usize, String)>,
    Option<String>,
    Option<(u32, u32)>,
    Option<String>,
);

pub(crate) fn target_key(matched: &Match) -> TargetKey {
    let syntax = matched.syntax_key().map(|(start, end, kind)| (start, end, kind.to_string()));
    let graph = syntax.is_none().then(|| matched.graph_node_id().map(str::to_owned)).flatten();
    let legacy = syntax.is_none() && graph.is_none();
    (matched.path.clone(), syntax,
        legacy.then(|| matched.def_name.clone()).flatten(),
        legacy.then_some(matched.def_range).flatten(), graph)
}

#[derive(Debug, Default, Clone)]
pub(crate) struct LaneBundle {
    by_target: HashMap<TargetKey, SymbolLanes>,
    pub(crate) complete: bool,
    pub(crate) diagnostics: Vec<String>,
    /// Present only for the explicit prepared-capture reader; not a binding-confidence flag.
    pub(crate) prepared_kind: Option<String>,
    pub(crate) prepared_relation: Option<String>,
    pub(crate) focus_evidence: Option<Vec<String>>,
    pub(crate) prepared_comment_start: Option<u32>,
    /// One isolated bundle per exact card, in SearchResult match order. Keeping
    /// these separate preserves distinct graph owners even on the same source line.
    pub(crate) prepared_cards: Vec<LaneBundle>,
}

impl LaneBundle {
    pub(crate) fn from_prepared(
        matched: &Match,
        lanes: SymbolLanes,
        kind: String,
        comment_start: Option<u32>,
    ) -> Self {
        Self {
            by_target: HashMap::from([(target_key(matched), lanes)]),
            complete: true,
            diagnostics: Vec::new(),
            prepared_kind: Some(kind),
            prepared_relation: None,
            focus_evidence: None,
            prepared_comment_start: comment_start,
            prepared_cards: Vec::new(),
        }
    }
    pub(crate) fn from_prepared_cards(cards: Vec<LaneBundle>) -> Self {
        Self {
            prepared_cards: cards,
            complete: true,
            ..Self::default()
        }
    }
    /// Enrich only targets already selected by live source identity. Graph card
    /// allocation and name ordering must not replace live declaration discovery.
    pub(crate) fn enrich(&mut self, mut prepared: Self) {
        for card in prepared.prepared_cards.drain(..) {
            self.enrich(card);
        }
        for (key, mut evidence) in prepared.by_target {
            let Some(live) = self.by_target.get_mut(&key) else {
                continue;
            };
            let direct = std::mem::take(&mut live.callers)
                .into_iter()
                .map(|caller| (String::new(), caller))
                .collect();
            let captured = evidence
                .callers
                .drain(..)
                .map(|caller| (String::new(), caller))
                .collect();
            live.callers = super::callers::merge_caller_rows(direct, captured)
                .into_iter()
                .map(|(_, caller)| caller)
                .collect();
            // Source candidates and captured bindings have different strengths.
            // Keep both, including distinct graph edges sharing one exact site;
            // the common renderer shares source rows without claiming two calls.
            live.connections.extend(evidence.connections);
            live.callees.extend(evidence.callees);
            live.function_references
                .extend(evidence.function_references);
            live.referenced_functions
                .extend(evidence.referenced_functions);
            live.heuristic_definitions
                .extend(evidence.heuristic_definitions);
            live.member_definitions.extend(evidence.member_definitions);
            live.stored_connections.extend(evidence.stored_connections);
            live.connection_notes.extend(evidence.connection_notes);
            live.unresolved_callees.extend(evidence.unresolved_callees);
        }
    }
    pub(crate) fn get(&self, matched: &Match) -> Option<&SymbolLanes> {
        self.by_target.get(&target_key(matched))
    }
    pub(crate) fn group_keys(&self, matched: &Match) -> Vec<super::continuation::GroupKey> {
        let card = self.prepared_cards.iter().find(|card| card.get(matched).is_some()).unwrap_or(self);
        let Some(lanes) = card.get(matched) else { return Vec::new(); };
        let key = target_key(matched);
        [("callers", lanes.callers.len()), ("function_references", lanes.function_references.len()),
            ("connections", lanes.connections.len()), ("stored_connections", lanes.stored_connections.len()),
            ("callees", lanes.callees.len()), ("referenced_functions", lanes.referenced_functions.len()),
            ("heuristic_definitions", lanes.heuristic_definitions.len()), ("member_definitions", lanes.member_definitions.len()),
            ("unresolved_callees", lanes.unresolved_callees.len()), ("connection_notes", lanes.connection_notes.len())]
            .into_iter().flat_map(|(facet, count)| (0..count).map(move |index| (facet, index)))
            .map(|(facet, index)| super::continuation::GroupKey::Lane(key.clone(), facet, index)).collect()
    }

    /// Emphasis selects presentation priority for existing typed evidence. It
    /// never deletes unrequested categories and never reclassifies references
    /// as calls. The common renderer still owns source, hierarchy and compaction.
    pub(crate) fn focus(&mut self, categories: &[String]) {
        self.focus_evidence = Some(categories.to_vec());
        for card in &mut self.prepared_cards { card.focus(categories); }
    }

    /// True when this card carries a non-empty emphasis set.
    pub(crate) fn has_focus(&self) -> bool {
        self.focus_evidence.as_ref().is_some_and(|categories| !categories.is_empty())
    }

    /// True when the supplied emphasis set requests this category.
    pub(crate) fn emphasizes(&self, category: &str) -> bool {
        self.focus_evidence.as_ref().is_some_and(|categories| categories.iter().any(|entry| entry == category))
    }
}

/// Gather caller candidates and source-owned outgoing evidence for displayed declarations.
/// One caller walk serves the set. Duplicate names among selected cards cannot
/// be assigned to one owner; even a unique card does not prove project-wide
/// uniqueness or absence of lexical shadowing.
pub(crate) fn collect(
    targets: &[&Match],
    result: &SearchResult,
    bloom: &crate::index::bloom::BloomFilterCache,
    visibility: Visibility,
    globs: &[String],
    context: &OperationContext,
) -> Result<LaneBundle, String> {
    let mut bundle = LaneBundle {
        complete: true,
        ..LaneBundle::default()
    };
    let mut name_counts = HashMap::<String, usize>::new();
    for matched in targets {
        if let Some(name) = &matched.def_name {
            *name_counts.entry(name.clone()).or_default() += 1;
            bundle.by_target.entry(target_key(matched)).or_default();
        }
    }
    let unique_names = name_counts.keys().cloned().collect::<HashSet<_>>();

    let caller_scope = result.sources.corpus_root().unwrap_or(&result.scope);
    if !unique_names.is_empty() {
        let options = WalkOptions {
            visibility,
            policy_root: None,
            min_depth: 1,
            max_depth: None,
            patterns: globs.to_vec(),
            deadline: context.deadline,
            cancelled: Some(context.cancelled.clone()),
            candidate_cap: None,
        };
        let batch_quit = super::callers::BATCH_EARLY_QUIT.saturating_mul(unique_names.len().max(1));
        let batch = super::callers::find_callers_batch_with_sources(
            &unique_names,
            caller_scope,
            bloom,
            &options,
            batch_quit,
            &result.sources,
        )
        .map_err(|error| error.to_string())?;
        bundle.complete &= batch.complete;
        bundle.diagnostics.extend(batch.diagnostics);

        let mut alias_rows = Vec::new();
        if globs.is_empty() && visibility == Visibility::Project {
            for matched in targets {
                let Some(name) = matched.def_name.as_ref() else {
                    continue;
                };
                if !unique_names.contains(name) {
                    continue;
                }
                alias_rows.extend(
                    crate::search::bindings::find_alias_callers_batch_with_sources(
                        &matched.path,
                        std::slice::from_ref(name),
                        caller_scope,
                        &result.sources,
                    )
                    .into_iter()
                    .map(|(_, caller)| (name.clone(), CallerMatch::from(caller))),
                );
            }
        }

        for (name, caller) in super::callers::merge_caller_rows(batch.matches, alias_rows) {
            let Ok(current) = result.sources.read_text(&caller.path) else {
                bundle.complete = false;
                bundle.diagnostics.push(format!(
                    "{}: unavailable while verifying a caller lane",
                    caller.path.display()
                ));
                continue;
            };
            if current.as_str() != caller.content.as_str() {
                bundle.complete = false;
                bundle.diagnostics.push(format!(
                    "{}: changed during caller collection; stale lane omitted",
                    caller.path.display()
                ));
                continue;
            }
            for target in targets
                .iter()
                .filter(|matched| matched.def_name.as_deref() == Some(name.as_str()))
            {
                let lanes = bundle.by_target.entry(target_key(target)).or_default();
                if crate::types::is_test_file(&caller.path) {
                    lanes.test_callers += 1;
                } else {
                    lanes.callers.push(caller.clone());
                }
            }
        }
    }

    for matched in targets {
        if context.check().is_err() {
            bundle.complete = false;
            bundle
                .diagnostics
                .push("relationship lanes cancelled or exceeded their wall budget".into());
            break;
        }
        let Some(range) = matched.def_range else {
            continue;
        };
        let Ok(content) = result.sources.read_text(&matched.path) else {
            bundle.complete = false;
            bundle.diagnostics.push(format!(
                "{}: unavailable for callee extraction",
                matched.path.display()
            ));
            continue;
        };
        let FileType::Code(lang) = crate::lang::detect_file_type(&matched.path) else {
            continue;
        };
        let connections = super::callees::connections(
            &matched.path,
            &content,
            lang,
            Some(range),
            matched.declaration.as_ref(),
            bloom,
            &result.sources,
        );
        let lanes = bundle.by_target.entry(target_key(matched)).or_default();
        lanes.connections = connections;
        if matched
            .def_name
            .as_ref()
            .is_some_and(|name| name_counts[name] > 1)
        {
            lanes.connection_notes.push("Multiple declarations share this name; incoming sites are alternatives, not assigned bindings.".into());
        }
        lanes.callers.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then(left.line.cmp(&right.line))
                .then(left.calling_function.cmp(&right.calling_function))
        });
    }

    Ok(bundle)
}
