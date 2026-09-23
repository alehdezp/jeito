use rayon::prelude::*;
use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::TilthError;
use crate::lang::detect_file_type;
use crate::lang::outline::outline_language;
use crate::types::FileType;

const MAX_MATCHES: usize = 10;
/// Max unique caller functions to trace for 2nd hop. Above this = wide fan-out, skip.
const IMPACT_FANOUT_THRESHOLD: usize = 10;
/// Max 2nd-hop results to display.
const IMPACT_MAX_RESULTS: usize = 15;
/// Stop the batch caller walk once we have this many raw matches. Generous headroom for dedup + ranking.
pub(crate) const BATCH_EARLY_QUIT: usize = 50;

/// Match-count cap when `--full` is set. Mirrors the symbol/content search caps.
const FULL_MAX_MATCHES: usize = 100;
/// Walker early-quit threshold when `--full` is set.
const FULL_BATCH_EARLY_QUIT: usize = FULL_MAX_MATCHES * 3;

/// A syntactic target-name or supported-alias candidate, not resolved target-binding proof.
#[derive(Debug, Clone)]
pub struct CallerMatch {
    pub path: PathBuf,
    pub line: u32,
    pub calling_function: String,
    pub call_text: String,
    /// Line range of the calling function (for expand).
    pub caller_range: Option<(u32, u32)>,
    /// File content, already read during `find_callers_batch` — avoids re-reading during expand.
    /// Shared across all call sites in the same file via reference counting.
    pub content: Arc<String>,
    pub site: Option<super::callee_query::CallSite>,
}

/// Merge scans by exact call expression, not the physical row. Legacy/prepared
/// carriers without spans retain every available owner/range/text distinction.
pub(crate) fn merge_caller_rows(
    direct: Vec<(String, CallerMatch)>,
    alias: Vec<(String, CallerMatch)>,
) -> Vec<(String, CallerMatch)> {
    let mut all = direct;
    all.extend(alias);
    // Alias rows carry canonicalized paths (binding cache keys) while lexical
    // rows carry walked paths; on macOS `/var` is `/private/var`, so the same
    // file can spell differently. Canonical paths join identical expression,
    // target and immediate-owner identities, not neighboring physical rows.
    let key = |m: &(String, CallerMatch)| {
        (
            m.1.path.canonicalize().unwrap_or_else(|_| m.1.path.clone()),
            m.1.line,
            m.0.clone(),
            m.1.site.as_ref().map(|site| {
                (
                    site.expression.start,
                    site.expression.end,
                    site.target.start,
                    site.target.end,
                    site.owner.as_ref().map(|owner| {
                        (
                            owner.bytes.start,
                            owner.bytes.end,
                            owner.syntax_kind.clone(),
                        )
                    }),
                )
            }),
            m.1.site.is_none().then(|| m.1.calling_function.clone()),
            m.1.site.is_none().then_some(m.1.caller_range),
            // Precise syntax already identifies the expression. Live scans trim
            // display text while indexed carriers keep indentation.
            m.1.site.is_none().then(|| m.1.call_text.clone()),
        )
    };
    all.sort_by_key(key);
    all.dedup_by(|a, b| key(a) == key(b));
    all
}

/// Scan `scope` for the literal `target` byte sequence. Used by the
/// single-symbol `search_callers_expanded` path to distinguish "typo,
/// doesn't exist" from "real symbol with no direct callers" (indirect
/// dispatch, dead code, framework registration, …) when the caller walk
/// returned zero matches. mmap is lazy, so the scan only pages in regions
/// that contain the needle prefix.
fn target_seen_in_scope(target: &str, scope: &Path, glob: Option<&str>) -> bool {
    let Ok(walker) = super::walker(scope, glob) else {
        return false;
    };
    let needle = target.as_bytes();
    let seen = AtomicBool::new(false);

    walker.run(|| {
        let seen = &seen;
        Box::new(move |entry| {
            if seen.load(Ordering::Relaxed) {
                return ignore::WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return ignore::WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                return ignore::WalkState::Continue;
            }
            let path = entry.path();
            let Ok(file) = std::fs::File::open(path) else {
                return ignore::WalkState::Continue;
            };
            let Ok(mmap) = (unsafe { memmap2::Mmap::map(&file) }) else {
                return ignore::WalkState::Continue;
            };
            if memchr::memmem::find(&mmap, needle).is_some() {
                seen.store(true, Ordering::Relaxed);
                return ignore::WalkState::Quit;
            }
            ignore::WalkState::Continue
        })
    });

    seen.load(Ordering::Relaxed)
}

/// Find all call sites of any symbol in `targets` across the codebase using a single walk.
/// Returns tuples of (`target_name`, match) so callers know which symbol was matched.
pub(crate) fn find_callers_batch(
    targets: &HashSet<String>,
    scope: &Path,
    bloom: &crate::index::bloom::BloomFilterCache,
    glob: Option<&str>,
    early_quit_threshold: usize,
) -> Result<Vec<(String, CallerMatch)>, TilthError> {
    let matches: Mutex<Vec<(String, CallerMatch)>> = Mutex::new(Vec::new());
    let found_count = AtomicUsize::new(0);

    let walker = super::walker(scope, glob)?;

    walker.run(|| {
        let matches = &matches;
        let found_count = &found_count;

        Box::new(move |entry| {
            // Early termination: enough callers found
            if found_count.load(Ordering::Relaxed) >= early_quit_threshold {
                return ignore::WalkState::Quit;
            }

            let Ok(entry) = entry else {
                return ignore::WalkState::Continue;
            };

            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                return ignore::WalkState::Continue;
            }

            let file_callers = scan_caller_file(entry.path(), targets, bloom);
            if !file_callers.is_empty() {
                found_count.fetch_add(file_callers.len(), Ordering::Relaxed);
                let mut all = matches
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                all.extend(file_callers);
            }

            ignore::WalkState::Continue
        })
    });

    Ok(matches
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner))
}

pub(crate) struct CallerBatchOutput {
    pub matches: Vec<(String, CallerMatch)>,
    pub complete: bool,
    pub reason: Option<crate::walk::StopReason>,
    pub diagnostics: Vec<String>,
}

pub(crate) fn find_callers_batch_with_options(
    targets: &HashSet<String>,
    scope: &Path,
    bloom: &crate::index::bloom::BloomFilterCache,
    options: &crate::walk::WalkOptions,
    early_quit_threshold: usize,
) -> Result<CallerBatchOutput, TilthError> {
    find_callers_batch_with_sources(targets, scope, bloom, options, early_quit_threshold, &super::OperationSources::default())
}

pub(crate) fn find_callers_batch_with_sources(
    targets: &HashSet<String>, scope: &Path, bloom: &crate::index::bloom::BloomFilterCache,
    options: &crate::walk::WalkOptions, early_quit_threshold: usize, sources: &super::OperationSources,
) -> Result<CallerBatchOutput, TilthError> {
    let report =
        sources.scoped_files(scope, options).map_err(|reason| TilthError::InvalidQuery {
            query: scope.display().to_string(),
            reason,
        })?;
    let files = report.paths;
    let matches = Mutex::new(Vec::new());
    let found = AtomicUsize::new(0);
    let processed = AtomicUsize::new(0);
    files.par_iter().for_each(|path| {
        if options
            .cancelled
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
            || options
                .deadline
                .is_some_and(|deadline| std::time::Instant::now() >= deadline)
        {
            return;
        }
        if found.load(Ordering::Relaxed) >= early_quit_threshold {
            return;
        }
        processed.fetch_add(1, Ordering::Relaxed);
        let file_matches = scan_caller_file_with_sources(path, targets, bloom, Some(sources));
        if !file_matches.is_empty() {
            found.fetch_add(file_matches.len(), Ordering::Relaxed);
            matches
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .extend(file_matches);
        }
    });
    let candidate_capped = processed.load(Ordering::Relaxed) < files.len();
    let context_reason = if options
        .cancelled
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::Relaxed))
    {
        Some(crate::walk::StopReason::Cancelled)
    } else if options
        .deadline
        .is_some_and(|deadline| std::time::Instant::now() >= deadline)
    {
        Some(crate::walk::StopReason::Deadline)
    } else {
        None
    };
    let reason = context_reason
        .or_else(|| candidate_capped.then_some(crate::walk::StopReason::CandidateCap))
        .or(report.reason);
    Ok(CallerBatchOutput {
        matches: matches
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        complete: report.complete && reason.is_none(),
        reason,
        diagnostics: report.diagnostics,
    })
}

fn scan_caller_file(
    path: &Path,
    targets: &HashSet<String>,
    bloom: &crate::index::bloom::BloomFilterCache,
) -> Vec<(String, CallerMatch)> {
    scan_caller_file_with_sources(path, targets, bloom, None)
}

fn scan_caller_file_with_sources(
    path: &Path, targets: &HashSet<String>, bloom: &crate::index::bloom::BloomFilterCache,
    sources: Option<&super::OperationSources>,
) -> Vec<(String, CallerMatch)> {
    let Some((content, _mtime)) = super::bloom_walk::read_with_sources(
        path,
        targets,
        bloom,
        super::bloom_walk::MAX_FILE_SIZE,
        sources,
    ) else {
        return Vec::new();
    };
    if !targets
        .iter()
        .any(|target| memchr::memmem::find(content.as_bytes(), target.as_bytes()).is_some())
    {
        return Vec::new();
    }
    let FileType::Code(language) = detect_file_type(path) else {
        return Vec::new();
    };
    let Some(tree_sitter_language) = outline_language(language) else {
        return Vec::new();
    };
    find_callers_treesitter_batch(path, targets, &tree_sitter_language, &content, language)
}

/// Tree-sitter call site detection for a set of target symbols.
/// Returns tuples of (`matched_target_name`, `CallerMatch`).
pub(crate) fn find_callers_treesitter_batch(
    path: &Path,
    targets: &HashSet<String>,
    ts_lang: &tree_sitter::Language,
    content: &str,
    lang: crate::types::Lang,
) -> Vec<(String, CallerMatch)> {
    if super::callee_query::callee_query_str(lang).is_none() {
        return Vec::new();
    }
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(ts_lang).is_err() {
        return Vec::new();
    }

    let Some(tree) = parser.parse(content, None) else {
        return Vec::new();
    };

    let lines = content.lines().collect::<Vec<_>>();
    let shared_content = Arc::new(content.to_string());
    super::callees::call_sites(tree.root_node(), ts_lang, lang, content)
        .into_iter()
        .filter(|site| targets.contains(&site.name))
        .map(|site| {
            (
                site.name.clone(),
                CallerMatch {
                    path: path.to_path_buf(),
                    line: site.line,
                    calling_function: site.owner_name.clone(),
                    call_text: lines
                        .get(site.line.saturating_sub(1) as usize)
                        .copied()
                        .unwrap_or(&site.name)
                        .trim()
                        .to_string(),
                    caller_range: site.owner_range,
                    content: Arc::clone(&shared_content),
                    site: Some(site),
                },
            )
        })
        .collect()
}

/// Format and rank caller search results with optional expand.
pub fn search_callers_expanded(
    target: &str,
    scope: &Path,
    bloom: &crate::index::bloom::BloomFilterCache,
    expand: usize,
    context: Option<&Path>,
    glob: Option<&str>,
    full: bool,
) -> Result<String, TilthError> {
    let (max_matches, batch_quit) = if full {
        (FULL_MAX_MATCHES, FULL_BATCH_EARLY_QUIT)
    } else {
        (MAX_MATCHES, BATCH_EARLY_QUIT)
    };
    let single: HashSet<String> = std::iter::once(target.to_string()).collect();
    let raw = find_callers_batch(&single, scope, bloom, glob, batch_quit)?;
    let callers: Vec<CallerMatch> = raw.into_iter().map(|(_, m)| m).collect();

    if callers.is_empty() {
        let target_seen = target_seen_in_scope(target, scope, glob);
        return Ok(no_callers_message(target, scope, target_seen, glob));
    }

    // Sort by relevance (context file first, then by proximity)
    let mut sorted_callers = callers;
    rank_callers(&mut sorted_callers, scope, context);

    let total = sorted_callers.len();

    // Collect unique caller names BEFORE truncation for accurate fan-out threshold
    let all_caller_names: HashSet<String> = sorted_callers
        .iter()
        .filter(|c| c.calling_function != "<top-level>")
        .map(|c| c.calling_function.clone())
        .collect();

    sorted_callers.truncate(max_matches);

    let mut output = String::new();
    write_caller_bucket(
        &mut output,
        target,
        scope,
        total,
        &sorted_callers,
        expand,
        &mut Vec::new(),
    );
    write_second_hop_impact(
        &mut output,
        &all_caller_names,
        &sorted_callers,
        scope,
        bloom,
        glob,
        None,
        batch_quit,
    );

    let tokens = crate::types::estimate_tokens(output.len() as u64);
    let _ = write!(
        output,
        "\n\n({} tokens)",
        crate::search::format_token_count(tokens)
    );
    Ok(output)
}

/// Render one target's caller bucket in the canonical shape shared by both
/// the single-target and multi-target callers search: a
/// `# Callers of "<target>" in <scope> — N call site(s)` header, then one
/// `## <path>:<line> [caller: <fn>]` block per call site (with an optional
/// expanded source excerpt). Multi-target search keeps the same identity/header
/// shape while sharing byte-equal source already printed in another bucket.
fn write_caller_bucket(
    output: &mut String,
    target: &str,
    scope: &Path,
    total: usize,
    sorted_callers: &[CallerMatch],
    expand: usize,
    covered: &mut Vec<super::RenderedSourceRow>,
) {
    let _ = writeln!(
        output,
        "# Callers of \"{}\" in {} — {} call site{}",
        target,
        scope.display(),
        total,
        if total == 1 { "" } else { "s" }
    );
    output.push_str("Evidence: bounded name/alias candidates; target bindings and indirect calls are not fully resolved.\n");

    for (i, caller) in sorted_callers.iter().enumerate() {
        // Header: file:line [caller: calling_function]
        let _ = writeln!(
            output,
            "\n## {}:{} [caller: {}]",
            super::rel(&caller.path, scope),
            caller.line,
            caller.calling_function
        );

        if let Some(site) = &caller.site {
            let _ = writeln!(output, "{}", site.caption(&caller.content));
        }
        let range = caller.caller_range.filter(|_| i < expand);
        let (start, end) = range.unwrap_or((caller.line, caller.line));
        let lines = caller.content.lines().collect::<Vec<_>>();
        let mut unseen = Vec::new();
        for line in start..=end {
            let Some(source) = lines.get(line.saturating_sub(1) as usize) else {
                continue;
            };
            if covered
                .iter()
                .any(|row| row.path == caller.path && row.line == line && row.text == *source)
            {
                continue;
            }
            covered.push(super::RenderedSourceRow {
                path: caller.path.clone(),
                line,
                text: (*source).to_string(),
            });
            unseen.push((line, *source));
        }
        if unseen.is_empty() {
            output.push_str("source above; site identity retained\n");
        } else if range.is_some() {
            output.push_str("\n```\n");
            for (line, source) in unseen {
                let prefix = if line == caller.line { "> " } else { "  " };
                let _ = writeln!(output, "{prefix}{line:4} | {source}");
            }
            output.push_str("```\n");
        } else {
            let _ = writeln!(output, "-> {}", caller.call_text);
        }
    }
}

pub(crate) struct RenderedCallerBatch {
    pub text: String,
    pub displayed: Vec<(String, CallerMatch)>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn render_callers_batch(
    ordered_targets: &[String],
    raw: Vec<(String, CallerMatch)>,
    scope: &Path,
    bloom: &crate::index::bloom::BloomFilterCache,
    expand: usize,
    context: Option<&Path>,
    glob: Option<&str>,
    walk_options: Option<&crate::walk::WalkOptions>,
    max_matches: usize,
    batch_quit: usize,
) -> RenderedCallerBatch {
    let mut by_target: std::collections::HashMap<String, Vec<CallerMatch>> =
        std::collections::HashMap::new();
    for (target, caller) in raw {
        by_target.entry(target).or_default().push(caller);
    }
    let mut text = String::new();
    let mut displayed = Vec::new();
    let mut covered = Vec::new();
    for target in ordered_targets {
        let mut callers = by_target.remove(target).unwrap_or_default();
        if callers.is_empty() {
            text.push_str(&no_callers_message(
                target,
                scope,
                target_seen_in_scope(target, scope, glob),
                glob,
            ));
            if ordered_targets.len() > 1 {
                text.push_str("\n\n");
            }
            continue;
        }
        rank_callers(&mut callers, scope, context);
        let total = callers.len();
        let all_caller_names: HashSet<String> = callers
            .iter()
            .filter(|caller| caller.calling_function != "<top-level>")
            .map(|caller| caller.calling_function.clone())
            .collect();
        callers.truncate(max_matches);
        write_caller_bucket(
            &mut text,
            target,
            scope,
            total,
            &callers,
            expand,
            &mut covered,
        );
        write_second_hop_impact(
            &mut text,
            &all_caller_names,
            &callers,
            scope,
            bloom,
            glob,
            walk_options,
            batch_quit,
        );
        displayed.extend(callers.into_iter().map(|caller| (target.clone(), caller)));
        if ordered_targets.len() > 1 {
            text.push('\n');
        }
    }
    if !(ordered_targets.len() == 1 && displayed.is_empty()) {
        let tokens = crate::types::estimate_tokens(text.len() as u64);
        let separator = if ordered_targets.len() == 1 {
            "\n\n"
        } else {
            "\n"
        };
        let _ = write!(
            text,
            "{separator}({} tokens)",
            crate::search::format_token_count(tokens)
        );
    }
    RenderedCallerBatch { text, displayed }
}

/// Adaptive 2nd-hop impact analysis, shared by single- and multi-target
/// callers search (extracted so multi-target reuses this exact block per
/// target bucket instead of re-implementing it — PR #138 review HIGH
/// finding: the multi-target path originally omitted this entirely).
///
/// `all_caller_names` must be the target's unique direct-caller names
/// collected BEFORE `sorted_callers` truncation, so the fan-out threshold
/// check reflects the true hop-1 breadth rather than the display-capped one.
fn write_second_hop_impact(
    output: &mut String,
    all_caller_names: &HashSet<String>,
    sorted_callers: &[CallerMatch],
    scope: &Path,
    bloom: &crate::index::bloom::BloomFilterCache,
    glob: Option<&str>,
    walk_options: Option<&crate::walk::WalkOptions>,
    batch_quit: usize,
) {
    if all_caller_names.is_empty() || all_caller_names.len() > IMPACT_FANOUT_THRESHOLD {
        return;
    }
    let hop2 = match walk_options {
        Some(options) => {
            find_callers_batch_with_options(all_caller_names, scope, bloom, options, batch_quit)
                .map(|result| result.matches)
        }
        None => find_callers_batch(all_caller_names, scope, bloom, glob, batch_quit),
    };
    let Ok(hop2) = hop2 else {
        return;
    };

    // Only an already displayed expression is redundant. Another site in the
    // same physical row or immediate owner is still useful second-hop evidence.
    let additional = merge_caller_rows(hop2, Vec::new())
        .into_iter()
        .filter(|(_, site)| {
            !sorted_callers.iter().any(|prior| {
                prior.path == site.path
                    && prior.call_text == site.call_text
                    && prior.calling_function == site.calling_function
                    && match (&prior.site, &site.site) {
                        (Some(prior), Some(site)) => {
                            prior.expression == site.expression
                                && prior.target == site.target
                                && prior.owner == site.owner
                        }
                        _ => prior.line == site.line && prior.caller_range == site.caller_range,
                    }
            })
        })
        .collect::<Vec<_>>();
    if additional.is_empty() {
        return;
    }
    output.push_str("\n-- caller candidates (2nd hop; name-only) --\n");
    for (via, caller) in additional.iter().take(IMPACT_MAX_RESULTS) {
        let _ = writeln!(
            output,
            "  {} {}:{} -> {}",
            caller.calling_function,
            super::rel(&caller.path, scope),
            caller.line,
            via
        );
        if let Some(site) = &caller.site {
            let _ = writeln!(output, "    {}", site.caption(&caller.content));
        }
    }
    if additional.len() > IMPACT_MAX_RESULTS {
        let _ = writeln!(
            output,
            "  ... and {} more sites",
            additional.len() - IMPACT_MAX_RESULTS
        );
    }
    let _ = writeln!(
        output,
        "\n{} first-hop owner names; {} additional second-hop call candidates; not a binding or change-impact proof.",
        all_caller_names.len(),
        additional.len()
    );
}

/// Build the user-facing message when callers search returns no hits.
/// Splits two cases that mean very different things to an agent:
/// `target_seen = true` means the symbol exists somewhere but has no direct
/// call sites — probable indirect dispatch, so we show a richer hint
/// listing the common indirection mechanisms. `target_seen = false` means
/// the literal name never appears in scope — most often a typo or wrong
/// scope, so we suppress the indirect-dispatch hint to avoid misleading
/// the agent.
fn no_callers_message(target: &str, scope: &Path, target_seen: bool, glob: Option<&str>) -> String {
    if !target_seen {
        return format!(
            "# Callers of \"{target}\" in {scope_disp} — no call sites found\n\n\
             No occurrence of \"{target}\" was found in scanned files. Skipped, unreadable or out-of-scope sources are not ruled out. \
             Check the spelling, or widen scope if you expected hits outside this directory.",
            scope_disp = scope.display()
        );
    }
    // Only mention glob-driven test exclusion when a glob was actually used.
    // Otherwise the line implies a filter that the caller didn't apply, which
    // would mislead an agent reasoning about what pi-nav searched.
    let glob_hint = if glob.is_some() {
        "\n  • test files (if `glob` excluded them)"
    } else {
        ""
    };
    format!(
        "# Callers of \"{target}\" in {scope_disp} — no direct call sites found\n\n\
         \"{target}\" appears in scanned source, but no syntactic call candidate was found. \
         This is not a binding or whole-project liveness proof; this symbol may still be reachable via:\n\
         \n  • interface / trait dispatch (Rust `dyn Trait`, Go interface, Java/Kotlin abstract method)\
         \n  • reflection or dynamic dispatch (`getattr`, `Method::invoke`, `eval`)\
         \n  • framework registration (HTTP routes, JSON-RPC, plugin systems, decorators)\
         \n  • function values stored in maps, structs, or passed as callbacks{glob_hint}\n\
         \nVerify with `pi_nav_search \"{target}\"` to see how it's referenced before assuming dead code.",
        scope_disp = scope.display()
    )
}

/// Simple ranking: context file first, then by path length (proximity heuristic).
fn rank_callers(callers: &mut [CallerMatch], scope: &Path, context: Option<&Path>) {
    callers.sort_by(|a, b| {
        // Context file wins
        if let Some(ctx) = context {
            match (a.path == ctx, b.path == ctx) {
                (true, false) => return std::cmp::Ordering::Less,
                (false, true) => return std::cmp::Ordering::Greater,
                _ => {}
            }
        }

        // Shorter paths (more similar to scope) rank higher
        let a_rel = a.path.strip_prefix(scope).unwrap_or(&a.path);
        let b_rel = b.path.strip_prefix(scope).unwrap_or(&b.path);
        a_rel
            .components()
            .count()
            .cmp(&b_rel.components().count())
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.line.cmp(&b.line))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precise_caller_merge_ignores_display_text_but_preserves_sites_and_owners() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("lookup.ts");
        let source = "function lookup(records) {\n  prune(records); prune(records);\n}\n";
        std::fs::write(&path, source).unwrap();
        let direct = find_callers_treesitter_batch(&path, &HashSet::from(["prune".into()]),
            &tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), source, crate::types::Lang::TypeScript);
        assert_eq!(direct.len(), 2);
        let mut indexed = direct.clone();
        for (_, caller) in &mut indexed { caller.call_text = "  prune(records); prune(records);".into(); }
        assert_eq!(merge_caller_rows(direct.clone(), indexed).len(), 2);
        let mut other_owner = direct[0].clone();
        other_owner.1.site.as_mut().unwrap().owner.as_mut().unwrap().bytes.start += 1;
        assert_eq!(merge_caller_rows(direct.clone(), vec![other_owner]).len(), 3);
        let mut unspanned = direct[0].clone();
        unspanned.1.site = None;
        let mut distinct = unspanned.clone();
        distinct.1.call_text.insert_str(0, "  ");
        assert_eq!(merge_caller_rows(vec![unspanned], vec![distinct]).len(), 2);
    }

    #[test]
    fn no_callers_message_for_unseen_symbol_says_typo_or_scope() {
        let msg = no_callers_message("doesNotExist", Path::new("/repo"), false, None);
        assert!(msg.contains("was found in scanned files"));
        assert!(msg.contains("Skipped, unreadable or out-of-scope sources are not ruled out"));
        assert!(msg.contains("Check the spelling"));
        // Must NOT include the indirect-dispatch hint — that would mislead.
        assert!(!msg.contains("interface"));
        assert!(!msg.contains("reflection"));
    }

    #[test]
    fn no_callers_message_for_seen_symbol_lists_indirection_modes() {
        let msg = no_callers_message("Foo", Path::new("/repo"), true, None);
        assert!(msg.contains("appears in scanned source"));
        assert!(msg.contains("interface"));
        assert!(msg.contains("reflection"));
        assert!(msg.contains("framework registration"));
        assert!(msg.contains("Verify with `pi_nav_search"));
        // Must NOT pretend the symbol is missing — different signal than typo case.
        assert!(!msg.contains("does not appear"));
    }

    /// The "test files (if glob excluded them)" hint is only meaningful when
    /// the caller actually used a glob. Without a glob it would mislead an
    /// agent into thinking tilth filtered something it did not.
    #[test]
    fn no_callers_message_omits_glob_hint_when_no_glob() {
        let msg = no_callers_message("Foo", Path::new("/repo"), true, None);
        assert!(
            !msg.contains("test files"),
            "glob-driven hint must not appear when glob is None: {msg}"
        );
    }

    #[test]
    fn no_callers_message_includes_glob_hint_when_glob_set() {
        let msg = no_callers_message("Foo", Path::new("/repo"), true, Some("*.rs"));
        assert!(
            msg.contains("test files"),
            "glob-driven hint should appear when glob is Some: {msg}"
        );
    }
    /// Regression test: when there are more than `MAX_MATCHES` (10) hop-1 call
    /// sites but still <= `IMPACT_FANOUT_THRESHOLD` unique owner names, the
    /// first-hop name count must remain pre-truncation. Name counts and sites
    /// are reported separately; neither proves how many functions are affected.
    ///
    /// Setup: 8 unique functions, each calling `target_fn` twice = 16 call
    /// sites. Truncation to `MAX_MATCHES=10` only keeps the first ~5 functions,
    /// dropping functions 6-8. The old code rebuilt the hop-1 set from
    /// `sorted_callers` AFTER truncation and undercounted. The fix uses
    /// `all_caller_names` (pre-truncation) which always holds 8.
    #[test]
    fn footer_count_uses_pre_truncation_caller_set() {
        let dir = tempfile::tempdir().unwrap();
        let bloom = crate::index::bloom::BloomFilterCache::new();

        // 8 files: each declares one function that calls `target_fn` twice.
        // Total: 16 call sites from 8 unique caller names.
        // One hop-2 file calls caller_a_0 so the 2nd-hop block fires.
        for i in 0..8usize {
            let content = format!(
                "fn target_fn() {{}}\
                \nfn caller_a_{i}() {{ target_fn(); target_fn(); }}\
                \n"
            );
            std::fs::write(dir.path().join(format!("f{i}.rs")), content).unwrap();
        }
        std::fs::write(
            dir.path().join("hop2.rs"),
            "fn hop2_fn() { caller_a_0(); }\n",
        )
        .unwrap();

        let result =
            search_callers_expanded("target_fn", dir.path(), &bloom, 0, None, None, false).unwrap();

        assert!(result.contains("8 first-hop owner names; 1 additional second-hop call candidates"),
            "counts must retain all eight pre-truncation owner names and the separate second-hop site: {result}");
        assert!(!result.contains("functions affected"));
    }
}
