use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use super::file_metadata;

use crate::dispatch::OperationContext;
use crate::error::TilthError;
use crate::search::rank;
use crate::types::{FacetTotals, Match, SearchResult};
use grep_regex::RegexMatcher;
use grep_searcher::sinks::UTF8;
use grep_searcher::Searcher;

const MAX_MATCHES: usize = 10;
const EARLY_QUIT_THRESHOLD: usize = MAX_MATCHES * 3;
const FULL_MAX_MATCHES: usize = 100;
const FULL_EARLY_QUIT_THRESHOLD: usize = FULL_MAX_MATCHES * 3;
const MAX_SEARCH_FILE_SIZE: u64 = 500_000;

/// Content search using ripgrep crates. Literal by default, regex if `is_regex`.
pub fn search(
    pattern: &str,
    scope: &Path,
    is_regex: bool,
    context: Option<&Path>,
    glob: Option<&str>,
    full: bool,
) -> Result<SearchResult, TilthError> {
    search_with_sources(
        pattern,
        scope,
        is_regex,
        context,
        glob,
        full,
        Arc::new(super::OperationSources::default()),
        None,
    )
}

pub(crate) fn search_with_sources(
    pattern: &str,
    scope: &Path,
    is_regex: bool,
    context: Option<&Path>,
    glob: Option<&str>,
    full: bool,
    sources: Arc<super::OperationSources>,
    operation_context: Option<&OperationContext>,
) -> Result<SearchResult, TilthError> {
    let (max_matches, early_quit) = if full {
        (FULL_MAX_MATCHES, FULL_EARLY_QUIT_THRESHOLD)
    } else {
        (MAX_MATCHES, EARLY_QUIT_THRESHOLD)
    };
    let matcher = if is_regex {
        RegexMatcher::new(pattern)
    } else {
        RegexMatcher::new(&regex_syntax::escape(pattern))
    }
    .map_err(|e| TilthError::InvalidQuery {
        query: pattern.to_string(),
        reason: e.to_string(),
    })?;

    let matches: Mutex<Vec<Match>> = Mutex::new(Vec::new());
    // Relaxed is correct: walker.run() joins all threads before we read the final value.
    // Early-quit checks are approximate by design — one extra iteration is harmless.
    let total_found = AtomicUsize::new(0);

    let walker = sources.walker(scope, glob)?;

    walker.run(|| {
        let matcher = &matcher;
        let matches = &matches;
        let total_found = &total_found;
        let sources = sources.clone();

        Box::new(move |entry| {
            if operation_context.is_some_and(|context| context.check().is_err()) {
                return ignore::WalkState::Quit;
            }
            if total_found.load(Ordering::Relaxed) >= early_quit {
                return ignore::WalkState::Quit;
            }

            let Ok(entry) = entry else {
                return ignore::WalkState::Continue;
            };

            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                return ignore::WalkState::Continue;
            }

            let path = entry.path();

            // Skip files that look minified by filename — `.min.js`, `app-min.css`.
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(crate::lang::detection::is_minified_by_name)
            {
                return ignore::WalkState::Continue;
            }

            // Skip oversized files — tree-sitter and ripgrep shouldn't spend time on minified bundles
            let file_size = match std::fs::metadata(path) {
                Ok(meta) => {
                    if meta.len() > MAX_SEARCH_FILE_SIZE {
                        return ignore::WalkState::Continue;
                    }
                    meta.len()
                }
                Err(_) => 0,
            };

            // Read the file once. Use `search_slice` instead of `search_path`
            // so the minified-check (when triggered) and the actual search
            // share a single kernel read — no double I/O, no TOCTOU window
            // between the heuristic and the search.
            if operation_context.is_some_and(|context| context.check().is_err()) {
                return ignore::WalkState::Quit;
            }
            let Ok(content) = sources.read_text(path) else {
                return ignore::WalkState::Continue;
            };

            if operation_context.is_some_and(|context| context.check().is_err()) {
                return ignore::WalkState::Quit;
            }

            // Catch unmarked minified bundles in the 100KB–500KB range.
            if file_size >= crate::lang::detection::MINIFIED_CHECK_THRESHOLD
                && crate::lang::detection::is_minified_by_content(content.as_bytes())
            {
                return ignore::WalkState::Continue;
            }

            let (file_lines, mtime) = file_metadata(path);

            let mut file_matches = Vec::new();
            let mut searcher = Searcher::new();

            let _ = searcher.search_slice(
                matcher,
                content.as_bytes(),
                UTF8(|line_num, line| {
                    if operation_context.is_some_and(|context| context.check().is_err()) {
                        return Ok(false);
                    }
                    file_matches.push(Match {
                        path: path.to_path_buf(),
                        line: line_num as u32,
                        text: line.trim_end().to_string(),
                        is_definition: false,
                        exact: false,
                        file_lines,
                        mtime,
                        def_range: None,
                        def_name: None,
                        def_weight: 0,
                        source_association: None,
                        declaration: None,
                        impl_target: None,
                    });
                    Ok(true)
                }),
            );

            if operation_context.is_some_and(|context| context.check().is_err()) {
                return ignore::WalkState::Quit;
            }

            if !file_matches.is_empty() {
                total_found.fetch_add(file_matches.len(), Ordering::Relaxed);
                let mut all = matches
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                all.extend(file_matches);
            }

            if total_found.load(Ordering::Relaxed) >= early_quit {
                ignore::WalkState::Quit
            } else {
                ignore::WalkState::Continue
            }
        })
    });

    let total = total_found.load(Ordering::Relaxed);
    let mut all_matches = matches
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    rank::sort(&mut all_matches, pattern, scope, context);
    all_matches.truncate(max_matches);

    Ok(SearchResult {
        query: pattern.to_string(),
        scope: scope.to_path_buf(),
        matches: all_matches,
        sources,
        total_found: total,
        definitions: 0,
        usages: total,
        facet_totals: FacetTotals::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_ranked_content_search_reads_no_candidates() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("candidate.txt"), "needle\n").unwrap();
        let sources = Arc::new(super::super::OperationSources::default());
        let operation_context = OperationContext {
            root: project.path().canonicalize().unwrap(),
            deadline: None,
            cancelled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            confine_to_root: false,
            read_format: crate::dispatch::ReadFormat::Plain,
        };

        let result = search_with_sources(
            "needle",
            project.path(),
            false,
            None,
            None,
            false,
            sources.clone(),
            Some(&operation_context),
        )
        .unwrap();

        assert!(result.matches.is_empty());
        assert_eq!(
            sources.counters().0,
            0,
            "cancelled search must not read a candidate"
        );
    }
}
