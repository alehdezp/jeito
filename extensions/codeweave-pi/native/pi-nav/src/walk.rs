use std::collections::HashSet;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime};

use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

use crate::types::estimate_tokens;

/// Built-in ignore floor for project scope (user law 2026-09-02): these
/// directory trees are pruned even without .gitignore entries. A custom
/// `.pi/navigation/ignore` allow entry (`!pattern`) can re-include them via
/// the rescue pass in `walk()`.
const BUILTIN_IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "vendor",
    "caches",
    ".runtime",
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum Visibility {
    #[default]
    Project,
    All,
}

impl Visibility {
    pub(crate) fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("project") {
            "project" => Ok(Self::Project),
            "all" => Ok(Self::All),
            other => Err(format!("visibility must be project or all; got {other:?}")),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EffectiveFilterPolicy {
    pub visibility: &'static str,
    pub source: &'static str,
    pub path: Option<PathBuf>,
    pub custom_override: bool,
    pub excluded: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EntryKind {
    File,
    Directory,
    Symlink,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WalkEntry {
    pub path: PathBuf,
    pub kind: EntryKind,
    pub size: u64,
    pub modified_ns: Option<u128>,
    pub token_estimate: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopReason {
    Deadline,
    Cancelled,
    CandidateCap,
    Error,
}

#[derive(Debug)]
pub(crate) struct WalkResult {
    pub entries: Vec<WalkEntry>,
    pub diagnostics: Vec<String>,
    pub complete: bool,
    pub reason: Option<StopReason>,
    pub visited: usize,
    pub policy: EffectiveFilterPolicy,
}

pub(crate) struct WalkOptions {
    pub visibility: Visibility,
    /// Explicit admitted corpus boundary for maintenance, never inferred from a query path.
    pub policy_root: Option<PathBuf>,
    pub min_depth: usize,
    pub max_depth: Option<usize>,
    pub patterns: Vec<String>,
    pub deadline: Option<Instant>,
    pub cancelled: Option<Arc<AtomicBool>>,
    pub candidate_cap: Option<usize>,
}

impl Default for WalkOptions {
    fn default() -> Self {
        Self {
            visibility: Visibility::Project,
            policy_root: None,
            min_depth: 0,
            max_depth: None,
            patterns: Vec::new(),
            deadline: None,
            cancelled: None,
            candidate_cap: None,
        }
    }
}

/// Private maintenance policy; section selection and `+` compatibility are TS-owned.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CorpusPolicy {
    pub version: u32,
    pub global_rules: Vec<String>,
    pub project_rules: Vec<String>,
    pub excluded_prefixes: Vec<String>,
}

struct CompiledCorpus {
    root: PathBuf,
    global: Gitignore,
    project: Gitignore,
    excluded: Vec<PathBuf>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CorpusPass {
    Main,
    GlobalRescue,
    ProjectRescue,
}

impl CompiledCorpus {
    fn compile(root: &Path, policy: &CorpusPolicy) -> Result<Self, String> {
        let values = policy
            .global_rules
            .iter()
            .chain(&policy.project_rules)
            .chain(&policy.excluded_prefixes);
        if policy.version != 1
            || values.clone().count() > 10_000
            || values.clone().map(|value| value.len()).sum::<usize>() > 1_048_576
            || values
                .clone()
                .any(|value| value.contains(['\0', '\n', '\r']))
        {
            return Err("invalid or oversized corpus policy".into());
        }
        let mut excluded = Vec::new();
        for prefix in &policy.excluded_prefixes {
            if prefix.is_empty()
                || prefix.contains(['\\', ':', '*', '?', '[', ']', '{', '}', '!'])
                || prefix
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
                || Path::new(prefix).is_absolute()
            {
                return Err(
                    "curated exclusions must be normalized relative directory prefixes".into(),
                );
            }
            excluded.push(root.join(prefix));
        }
        let compile = |rules: &[String]| -> Result<Gitignore, String> {
            let mut builder = GitignoreBuilder::new(root);
            for (index, rule) in rules.iter().enumerate() {
                builder
                    // `from` is provenance only in ignore 0.4.27; it does not
                    // change anchoring. Retain source order across ancestors.
                    .add_line(Some(PathBuf::from(index.to_string())), rule)
                    .map_err(|error| format!("invalid corpus rule: {error}"))?;
            }
            builder
                .build()
                .map_err(|error| format!("invalid corpus policy: {error}"))
        };
        Ok(Self {
            root: root.to_path_buf(),
            global: compile(&policy.global_rules)?,
            project: compile(&policy.project_rules)?,
            excluded,
        })
    }

    fn matched<'a>(
        &self,
        matcher: &'a Gitignore,
        path: &Path,
        is_dir: bool,
    ) -> ignore::Match<&'a ignore::gitignore::Glob> {
        let mut result = ignore::Match::None;
        let mut highest = None;
        for ancestor in path
            .ancestors()
            .take_while(|ancestor| *ancestor != self.root && ancestor.starts_with(&self.root))
        {
            let matched = matcher.matched(ancestor, ancestor != path || is_dir);
            let glob = match &matched {
                ignore::Match::None => continue,
                ignore::Match::Ignore(glob) | ignore::Match::Whitelist(glob) => glob,
            };
            let index = glob
                .from()
                .and_then(Path::to_str)
                .and_then(|value| value.parse::<usize>().ok())
                .expect("compiled corpus rule index");
            if highest.is_none_or(|previous| index > previous) {
                highest = Some(index);
                result = matched;
            }
        }
        result
    }

    fn allows(&self, path: &Path, is_dir: bool, pass: CorpusPass) -> bool {
        let project = self.matched(&self.project, path, is_dir);
        let global = self.matched(&self.global, path, is_dir);
        match pass {
            CorpusPass::ProjectRescue => project.is_whitelist(),
            CorpusPass::GlobalRescue => !project.is_ignore() && global.is_whitelist(),
            CorpusPass::Main => {
                if !project.is_none() {
                    return project.is_whitelist();
                }
                if !global.is_none() {
                    return global.is_whitelist();
                }
                !(is_dir
                    && path.file_name().is_some_and(|name| {
                        BUILTIN_IGNORED_DIRS.iter().any(|ignored| name == *ignored)
                    }))
            }
        }
    }
}

pub(crate) fn walk_corpus(
    scope: &Path,
    options: &WalkOptions,
    policy: &CorpusPolicy,
) -> Result<WalkResult, String> {
    let root = options
        .policy_root
        .as_deref()
        .ok_or("corpus walk requires an admitted root")?;
    if !root.is_absolute()
        || root.canonicalize().map_err(|error| error.to_string())? != root
        || scope != root
        || !root.is_dir()
        || options.visibility != Visibility::Project
    {
        return Err("corpus walk requires canonical whole-root project scope".into());
    }
    let compiled = Arc::new(CompiledCorpus::compile(root, policy)?);
    walk_inner(scope, options, Some((compiled, CorpusPass::Main)))
}

fn is_generated_navigation_path(path: &Path, root: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let components: Vec<_> = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect();
    components.windows(2).any(|pair| {
        pair[0] == ".pi"
            && (pair[1] == "navigation" || pair[1] == "crg" || pair[1].contains("index-backup-"))
    })
}

pub(crate) fn builder(scope: &Path, visibility: Visibility) -> WalkBuilder {
    builder_with_policy(scope, visibility, None, None)
        .map_or_else(|_| WalkBuilder::new(scope), |(builder, _, _)| builder)
}

fn project_root(scope: &Path) -> Option<PathBuf> {
    let mut current = scope.canonicalize().ok()?;
    if current.is_file() {
        current = current.parent()?.to_path_buf();
    }
    loop {
        if current.join(".git").exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

/// Custom navigation ignore config, layered over .gitignore (user law
/// 2026-09-02). Deniers stack on top of gitignore; `!` allow entries may
/// re-include paths ignored by .gitignore or the built-in blacklist.
struct CustomIgnore {
    /// Path of the custom ignore file (echoed in the effective policy).
    path: PathBuf,
    /// Full-file matcher with native gitignore semantics inside the file
    /// (last match wins; `!` cancels earlier deniers in this same file).
    matcher: Gitignore,
    /// `!`-stripped allow patterns.
    allow_patterns: Vec<String>,
}

fn custom_ignore(root: &Path) -> Result<Option<CustomIgnore>, String> {
    let path = root.join(".pi/navigation/ignore");
    if !path.is_file() {
        return Ok(None);
    }
    let mut builder = GitignoreBuilder::new(root);
    if let Some(error) = builder.add(&path) {
        return Err(format!(
            "invalid custom navigation ignore {}: {error}",
            path.display()
        ));
    }
    let matcher = builder.build().map_err(|error| {
        format!(
            "invalid custom navigation ignore {}: {error}",
            path.display()
        )
    })?;
    let contents = std::fs::read_to_string(&path).map_err(|error| {
        format!(
            "cannot read custom navigation ignore {}: {error}",
            path.display()
        )
    })?;
    let allow_patterns = contents
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            trimmed
                .strip_prefix('!')
                .map(|rest| rest.trim().to_string())
        })
        .filter(|pattern| !pattern.is_empty() && !pattern.starts_with('#'))
        .collect();
    Ok(Some(CustomIgnore {
        path,
        matcher,
        allow_patterns,
    }))
}

fn builder_with_policy(
    scope: &Path,
    visibility: Visibility,
    admitted_root: Option<&Path>,
    corpus: Option<&(Arc<CompiledCorpus>, CorpusPass)>,
) -> Result<(WalkBuilder, EffectiveFilterPolicy, Arc<AtomicUsize>), String> {
    let root = scope.canonicalize().unwrap_or_else(|_| scope.to_path_buf());
    if admitted_root.is_some_and(|boundary| !root.starts_with(boundary)) {
        return Err("walk scope is outside the admitted corpus".into());
    }
    let git_root = match admitted_root {
        Some(boundary) => boundary
            .join(".git")
            .exists()
            .then(|| boundary.to_path_buf()),
        None => project_root(&root),
    };
    let policy_root = admitted_root.or(git_root.as_deref()).unwrap_or(&root);
    let custom = if visibility == Visibility::Project && corpus.is_none() {
        custom_ignore(policy_root)?
    } else {
        None
    };
    let mut builder = WalkBuilder::new(scope);
    builder
        .follow_links(admitted_root.is_none())
        .same_file_system(true)
        .ignore(false)
        .hidden(false);
    // Layered ignore policy (user law 2026-09-02): .gitignore stays
    // respected by default in project scope; the custom config adds deniers
    // on top, and its `!` allow entries re-include paths ignored by
    // .gitignore or the built-in blacklist (rescue pass in walk()).
    match visibility {
        Visibility::Project => {
            builder
                .require_git(false)
                .git_ignore(true)
                .git_global(git_root.is_some())
                .git_exclude(git_root.is_some())
                .parents(admitted_root.is_none() && git_root.is_some());
        }
        Visibility::All => {
            builder
                .git_ignore(false)
                .git_global(false)
                .git_exclude(false)
                .parents(false);
        }
    }

    let excluded = Arc::new(AtomicUsize::new(0));
    let excluded_for_filter = Arc::clone(&excluded);
    let custom_matcher = custom.as_ref().map(|custom| custom.matcher.clone());
    let project_visibility = visibility == Visibility::Project;
    let safety_root = root.clone();
    let bounded_corpus = admitted_root.is_some();
    let corpus = corpus.cloned();
    builder.filter_entry(move |entry| {
        if (corpus.is_some() && entry.path() == safety_root)
            || (corpus.is_none()
                && entry
                    .path()
                    .canonicalize()
                    .is_ok_and(|path| path == safety_root))
        {
            return true;
        }
        if std::fs::symlink_metadata(entry.path())
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return corpus.is_none();
        }
        if entry
            .path()
            .canonicalize()
            .is_ok_and(|path| !path.starts_with(&safety_root))
        {
            excluded_for_filter.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        if is_generated_navigation_path(entry.path(), &safety_root) {
            excluded_for_filter.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let is_dir = entry.file_type().is_some_and(|kind| kind.is_dir());
        if bounded_corpus
            && is_dir
            && (entry.path().join(".git").exists()
                || entry.path().join(".pi-navigation.json").is_file())
        {
            excluded_for_filter.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        if is_dir && entry.file_name() == ".git" {
            excluded_for_filter.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        if let Some((policy, pass)) = &corpus {
            let hard = policy
                .excluded
                .iter()
                .any(|prefix| entry.path().starts_with(prefix));
            let allowed = !hard
                && ((is_dir && *pass != CorpusPass::Main)
                    || policy.allows(entry.path(), is_dir, *pass));
            if !allowed {
                excluded_for_filter.fetch_add(1, Ordering::Relaxed);
            }
            return allowed;
        }
        // Built-in blacklist floor: custom `!` allows re-include these
        // trees through the rescue pass, not here — pruning the directory
        // keeps the main walk cheap.
        if project_visibility
            && is_dir
            && BUILTIN_IGNORED_DIRS.contains(&entry.file_name().to_string_lossy().as_ref())
        {
            excluded_for_filter.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        if custom_matcher.as_ref().is_some_and(|matcher| {
            matcher
                .matched_path_or_any_parents(entry.path(), is_dir)
                .is_ignore()
        }) {
            excluded_for_filter.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        true
    });
    let policy = match (visibility, custom, git_root) {
        (Visibility::All, _, _) => EffectiveFilterPolicy {
            visibility: "all",
            source: "none",
            path: None,
            custom_override: false,
            excluded: 0,
        },
        (Visibility::Project, Some(custom), _) => EffectiveFilterPolicy {
            visibility: "project",
            source: "custom_navigation_ignore",
            path: Some(custom.path),
            custom_override: true,
            excluded: 0,
        },
        (Visibility::Project, None, Some(root)) => EffectiveFilterPolicy {
            visibility: "project",
            source: "gitignore",
            path: Some(root),
            custom_override: false,
            excluded: 0,
        },
        (Visibility::Project, None, None) => EffectiveFilterPolicy {
            visibility: "project",
            source: "none",
            path: None,
            custom_override: false,
            excluded: 0,
        },
    };
    Ok((builder, policy, excluded))
}

pub(crate) fn walk(scope: &Path, options: &WalkOptions) -> Result<WalkResult, String> {
    walk_inner(scope, options, None)
}

fn walk_inner(
    scope: &Path,
    options: &WalkOptions,
    corpus: Option<(Arc<CompiledCorpus>, CorpusPass)>,
) -> Result<WalkResult, String> {
    let canonical_scope = scope
        .canonicalize()
        .map_err(|error| format!("cannot resolve scope {}: {error}", scope.display()))?;
    let admitted_root = options
        .policy_root
        .as_ref()
        .map(|root| root.canonicalize())
        .transpose()
        .map_err(|error| format!("cannot resolve corpus root: {error}"))?;
    let (includes, excludes) = compile_patterns(&options.patterns)?;
    let (mut walker, mut policy, policy_excluded) = builder_with_policy(
        &canonical_scope,
        options.visibility,
        admitted_root.as_deref(),
        corpus.as_ref(),
    )?;
    walker.max_depth(options.max_depth);

    let mut result = WalkResult {
        entries: Vec::new(),
        diagnostics: Vec::new(),
        complete: true,
        reason: None,
        visited: 0,
        policy: policy.clone(),
    };

    if corpus.is_some() && options.candidate_cap == Some(0) {
        result.complete = false;
        result.reason = Some(StopReason::CandidateCap);
        result.policy.source = "code_corpus_policy";
        result.policy.custom_override = true;
        return Ok(result);
    }

    for item in walker.build() {
        if options
            .cancelled
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
        {
            result.complete = false;
            result.reason = Some(StopReason::Cancelled);
            break;
        }
        if options
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            result.complete = false;
            result.reason = Some(StopReason::Deadline);
            break;
        }
        let entry = match item {
            Ok(entry) => entry,
            Err(error) => {
                result.complete = false;
                result.reason.get_or_insert(StopReason::Error);
                result.diagnostics.push(error.to_string());
                continue;
            }
        };
        result.visited += 1;
        // The private corpus budget counts every successful walker yield,
        // including roots/directories and entries rejected by output patterns.
        // It does not count traversal work pruned inside ignore::Walk.
        if corpus.is_some()
            && options
                .candidate_cap
                .is_some_and(|cap| result.visited >= cap)
        {
            result.complete = false;
            result.reason = Some(StopReason::CandidateCap);
            break;
        }
        let depth = entry.depth();
        if depth < options.min_depth || depth == 0 {
            continue;
        }
        let path = entry.path();
        let relative = path.strip_prefix(&canonical_scope).unwrap_or(path);
        if !matches_patterns(relative, includes.as_ref(), excludes.as_ref()) {
            continue;
        }

        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) => {
                result.complete = false;
                result.reason.get_or_insert(StopReason::Error);
                result
                    .diagnostics
                    .push(format!("{}: {error}", relative.display()));
                continue;
            }
        };
        let kind = if metadata.file_type().is_symlink() {
            if let Ok(target) = path.canonicalize() {
                if !target.starts_with(&canonical_scope) {
                    result.diagnostics.push(format!(
                        "{}: symlink target escapes scope",
                        relative.display()
                    ));
                }
            }
            EntryKind::Symlink
        } else if metadata.is_dir() {
            EntryKind::Directory
        } else if metadata.is_file() {
            EntryKind::File
        } else {
            continue;
        };
        // Rescue directories stay traversable but are not themselves re-admitted
        // unless the originating layer's final rule includes them.
        if corpus.as_ref().is_some_and(|(policy, pass)| {
            *pass != CorpusPass::Main && !policy.allows(path, kind == EntryKind::Directory, *pass)
        }) {
            continue;
        }
        let size = if kind == EntryKind::File {
            metadata.len()
        } else {
            0
        };
        result.entries.push(WalkEntry {
            path: relative.to_path_buf(),
            kind,
            size,
            modified_ns: metadata.modified().ok().and_then(system_time_ns),
            token_estimate: if kind == EntryKind::File {
                estimate_tokens(size)
            } else {
                0
            },
        });
        if options
            .candidate_cap
            .is_some_and(|cap| result.entries.len() >= cap)
        {
            result.complete = false;
            result.reason = Some(StopReason::CandidateCap);
            break;
        }
    }

    if let Some((compiled, pass)) = &corpus {
        if *pass == CorpusPass::Main && result.complete {
            let (includes, excludes) = (includes.as_ref(), excludes.as_ref());
            for (next, matcher) in [
                (CorpusPass::GlobalRescue, &compiled.global),
                (CorpusPass::ProjectRescue, &compiled.project),
            ] {
                if matcher.num_whitelists() == 0 {
                    continue;
                }
                let remaining = options
                    .candidate_cap
                    .map(|cap| cap.saturating_sub(result.visited));
                if remaining == Some(0) {
                    result.complete = false;
                    result.reason = Some(StopReason::CandidateCap);
                    break;
                }
                // Global rescue keeps native Git filtering (including nested ignores).
                // Only project-local rescue may disable ordinary Git exclusions.
                let rescue = walk_inner(
                    &canonical_scope,
                    &WalkOptions {
                        visibility: if next == CorpusPass::GlobalRescue {
                            Visibility::Project
                        } else {
                            Visibility::All
                        },
                        policy_root: options.policy_root.clone(),
                        deadline: options.deadline,
                        cancelled: options.cancelled.clone(),
                        candidate_cap: remaining,
                        ..WalkOptions::default()
                    },
                    Some((Arc::clone(compiled), next)),
                )?;
                append_rescue(
                    &mut result,
                    rescue,
                    options,
                    &canonical_scope,
                    &canonical_scope,
                    None,
                    includes,
                    excludes,
                );
                if !result.complete {
                    break;
                }
            }
        }
        policy.source = "code_corpus_policy";
        policy.custom_override = true;
    } else if options.visibility == Visibility::Project {
        let repo_root = admitted_root
            .or_else(|| project_root(&canonical_scope))
            .unwrap_or_else(|| canonical_scope.clone());
        if let Some(custom) = custom_ignore(&repo_root)? {
            rescue_allowed_entries(
                &mut result,
                options,
                &canonical_scope,
                &repo_root,
                &custom,
                includes.as_ref(),
                excludes.as_ref(),
            )?;
        }
    }
    result
        .entries
        .sort_by(|left, right| left.path.cmp(&right.path));
    policy.excluded = policy_excluded.load(Ordering::Relaxed);
    result.policy = policy;
    Ok(result)
}

/// Applies custom `!` allow entries the walker's ignore stage cannot express:
/// re-include paths ignored by .gitignore or the built-in blacklist. Each
/// allow pattern runs one bounded pattern-walk from the repo root at `all`
/// visibility (safety exclusions remain), then rescued entries are filtered
/// by the custom deniers, the query's own pattern set, and the scope, and
/// deduped against the main result. The ignore crate's own primitives cannot
/// express this: whitelist overrides would ignore every non-matching file
/// (verified in ignore 0.4.33), and `add_ignore` has lowest precedence.
fn rescue_allowed_entries(
    result: &mut WalkResult,
    options: &WalkOptions,
    canonical_scope: &Path,
    repo_root: &Path,
    custom: &CustomIgnore,
    includes: Option<&GlobSet>,
    excludes: Option<&GlobSet>,
) -> Result<(), String> {
    let mut added = 0usize;
    for pattern in &custom.allow_patterns {
        let rescue = walk(
            repo_root,
            &WalkOptions {
                visibility: Visibility::All,
                policy_root: options.policy_root.clone(),
                patterns: vec![pattern.clone()],
                deadline: options.deadline,
                cancelled: options.cancelled.clone(),
                candidate_cap: options.candidate_cap,
                ..WalkOptions::default()
            },
        )?;
        added += append_rescue(
            result,
            rescue,
            options,
            canonical_scope,
            repo_root,
            Some(custom),
            includes,
            excludes,
        );
    }
    if added > 0 {
        result.diagnostics.push(format!(
            "custom allow re-included {added} path(s) from {}",
            custom.path.display()
        ));
    }
    Ok(())
}

fn append_rescue(
    result: &mut WalkResult,
    rescue: WalkResult,
    options: &WalkOptions,
    canonical_scope: &Path,
    repo_root: &Path,
    custom: Option<&CustomIgnore>,
    includes: Option<&GlobSet>,
    excludes: Option<&GlobSet>,
) -> usize {
    let mut seen: HashSet<PathBuf> = result
        .entries
        .iter()
        .map(|entry| entry.path.clone())
        .collect();
    let mut added = 0;
    if !rescue.complete && result.complete {
        result.complete = false;
        if result.reason.is_none() {
            result.reason = rescue.reason;
        }
    }
    if custom.is_none() {
        result.visited += rescue.visited;
        result.diagnostics.extend(rescue.diagnostics);
    }
    for entry in rescue.entries {
        let absolute = repo_root.join(&entry.path);
        if !absolute.starts_with(canonical_scope) {
            continue;
        }
        let relative = absolute
            .strip_prefix(canonical_scope)
            .unwrap_or(&absolute)
            .to_path_buf();
        if !seen.insert(relative.clone()) || !matches_patterns(&relative, includes, excludes) {
            continue;
        }
        if custom.is_some_and(|custom| {
            custom
                .matcher
                .matched_path_or_any_parents(&absolute, entry.kind == EntryKind::Directory)
                .is_ignore()
        }) {
            continue;
        }
        let depth = relative.components().count();
        if depth == 0
            || depth < options.min_depth
            || options.max_depth.is_some_and(|max| depth > max)
        {
            continue;
        }
        result.entries.push(WalkEntry {
            path: relative,
            ..entry
        });
        added += 1;
        if options
            .candidate_cap
            .is_some_and(|cap| result.entries.len() >= cap)
        {
            result.complete = false;
            result.reason.get_or_insert(StopReason::CandidateCap);
            break;
        }
    }
    added
}

pub(crate) fn compile_patterns(patterns: &[String]) -> Result<(Option<GlobSet>, Option<GlobSet>), String> {
    let mut includes = GlobSetBuilder::new();
    let mut excludes = GlobSetBuilder::new();
    let mut include_count = 0;
    let mut exclude_count = 0;
    for pattern in patterns {
        let (exclude, raw) = pattern
            .strip_prefix('!')
            .map_or((false, pattern.as_str()), |raw| (true, raw));
        let glob = Glob::new(raw).map_err(|error| format!("invalid glob {pattern:?}: {error}"))?;
        if exclude {
            excludes.add(glob);
            exclude_count += 1;
        } else {
            includes.add(glob);
            include_count += 1;
        }
    }
    Ok((
        (include_count > 0).then(|| includes.build().expect("validated include globs")),
        (exclude_count > 0).then(|| excludes.build().expect("validated exclude globs")),
    ))
}

pub(crate) fn matches_patterns(path: &Path, includes: Option<&GlobSet>, excludes: Option<&GlobSet>) -> bool {
    let name = path.file_name().unwrap_or_default();
    let included = includes.is_none_or(|set| set.is_match(path) || set.is_match(name));
    included && !excludes.is_some_and(|set| set.is_match(path) || set.is_match(name))
}

fn system_time_ns(time: SystemTime) -> Option<u128> {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_nanos())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use super::*;

    fn names(result: &WalkResult) -> Vec<String> {
        result
            .entries
            .iter()
            .map(|entry| entry.path.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn corpus_layers_preserve_precedence_git_and_hard_boundaries() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        for path in [
            "plain.ts",
            "denied.ts",
            "again.ts",
            "machine.ts",
            "nested/blocked.ts",
            "nested/local.ts",
            "target/global.ts",
            "target/local.ts",
            "hard/secret.ts",
            ".pi/navigation/secret.ts",
            "sub/secret.ts",
        ] {
            let path = root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        fs::write(root.join("nested/.gitignore"), "*.ts\n").unwrap();
        fs::write(root.join("sub/.pi-navigation.json"), "{}").unwrap();
        // The maintained corpus receives selected rules, not this legacy flat file.
        fs::write(root.join(".pi/navigation/ignore"), "plain.ts\n").unwrap();
        let strings = |values: &[&str]| values.iter().map(|value| value.to_string()).collect();
        let mut policy = CorpusPolicy {
            version: 1,
            global_rules: strings(&[
                "machine.ts",
                "!machine.ts",
                "!denied.ts",
                "!nested/*.ts",
                "!target/global.ts",
                "!hard/**",
            ]),
            project_rules: strings(&[
                "denied.ts",
                "again.ts",
                "!again.ts",
                "again.ts",
                "!nested/local.ts",
                "!target/local.ts",
                "!hard/**",
                "!.pi/navigation/**",
                "!sub/**",
                "!loop",
                "!loop/**",
            ]),
            excluded_prefixes: strings(&["hard"]),
        };
        let options = WalkOptions {
            policy_root: Some(root.clone()),
            ..WalkOptions::default()
        };
        let result = walk_corpus(&root, &options, &policy).unwrap();
        assert!(result.complete, "{:?}", result.diagnostics);
        let found = names(&result);
        for path in [
            "plain.ts",
            "machine.ts",
            "nested/local.ts",
            "target/global.ts",
            "target/local.ts",
        ] {
            assert!(
                found.contains(&path.to_string()),
                "missing {path}: {found:?}"
            );
        }
        for path in [
            "denied.ts",
            "again.ts",
            "nested/blocked.ts",
            "hard/secret.ts",
            ".pi/navigation/secret.ts",
            "sub/secret.ts",
            "loop",
        ] {
            assert!(
                !found.contains(&path.to_string()),
                "unexpected {path}: {found:?}"
            );
        }
        let budget = result.visited - 1;
        let bounded = walk_corpus(
            &root,
            &WalkOptions {
                policy_root: Some(root.clone()),
                candidate_cap: Some(budget),
                ..WalkOptions::default()
            },
            &policy,
        )
        .unwrap();
        assert!(
            !bounded.complete,
            "rescues must share one yielded-entry budget"
        );
        assert_eq!(bounded.reason, Some(StopReason::CandidateCap));
        assert!(bounded.visited <= budget);
        let filtered = walk_corpus(
            &root,
            &WalkOptions {
                policy_root: Some(root.clone()),
                candidate_cap: Some(2),
                patterns: strings(&["does-not-match"]),
                ..WalkOptions::default()
            },
            &policy,
        )
        .unwrap();
        assert!(
            !filtered.complete,
            "the budget is not a returned-entry limit"
        );
        assert!(filtered.entries.is_empty());
        fs::create_dir(root.join("parent")).unwrap();
        fs::write(root.join("parent/child.ts"), "x").unwrap();
        for global in [false, true] {
            for (rules, included) in [
                (["!parent/child.ts", "parent/"], false),
                (["parent/", "!parent/child.ts"], true),
            ] {
                let ordered = CorpusPolicy {
                    version: 1,
                    global_rules: if global { strings(&rules) } else { vec![] },
                    project_rules: if global { vec![] } else { strings(&rules) },
                    excluded_prefixes: vec![],
                };
                let found = walk_corpus(&root, &options, &ordered).unwrap();
                assert!(found.complete);
                assert_eq!(
                    names(&found).contains(&"parent/child.ts".into()),
                    included,
                    "global={global}, rules={rules:?}"
                );
            }
        }
        assert!(walk_corpus(&root.join("nested"), &options, &policy).is_err());
        assert!(walk_corpus(&root, &WalkOptions::default(), &policy).is_err());
        policy.version = 2;
        assert!(walk_corpus(&root, &options, &policy).is_err());
        policy.version = 1;
        for prefix in [
            "",
            ".",
            "..",
            "/hard",
            "hard/../plain.ts",
            "hard/**",
            "hard//child",
            "hard\\child",
        ] {
            policy.excluded_prefixes = strings(&[prefix]);
            assert!(
                walk_corpus(&root, &options, &policy).is_err(),
                "accepted {prefix:?}"
            );
        }
        policy.excluded_prefixes.clear();
        policy.global_rules = vec!["x".into(); 10_001];
        assert!(walk_corpus(&root, &options, &policy).is_err());
        policy.global_rules = vec!["x".repeat(1_048_577)];
        assert!(walk_corpus(&root, &options, &policy).is_err());
    }

    #[test]
    fn project_filters_git_ignored_entries_while_all_and_exact_scope_are_distinct() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".gitignore"), "ignored.txt\ntarget/\n").unwrap();
        fs::write(root.path().join("ignored.txt"), "ignored").unwrap();
        fs::write(root.path().join(".hidden"), "hidden").unwrap();
        fs::create_dir(root.path().join("target")).unwrap();
        fs::write(root.path().join("target/kept.txt"), "target").unwrap();

        let project = walk(root.path(), &WalkOptions::default()).unwrap();
        assert!(!names(&project).contains(&"ignored.txt".into()));
        assert!(names(&project).contains(&".hidden".into()));
        assert!(!names(&project).contains(&"target/kept.txt".into()));
        assert_eq!(project.policy.source, "gitignore");

        let all = walk(
            root.path(),
            &WalkOptions {
                visibility: Visibility::All,
                ..WalkOptions::default()
            },
        )
        .unwrap();
        assert!(names(&all).contains(&"ignored.txt".into()));
        assert!(names(&all).contains(&"target/kept.txt".into()));

        let explicit = walk(&root.path().join("target"), &WalkOptions::default()).unwrap();
        assert!(names(&explicit).contains(&"kept.txt".into()));
    }

    #[test]
    fn project_visibility_excludes_generated_navigation_state_but_explicit_scope_can_inspect_it() {
        let root = tempfile::tempdir().unwrap();
        for path in [
            ".pi/navigation/index/data.json",
            ".pi/crg/graph.db",
            ".pi/docs-index-backup-1/doc.json",
            "nested/project/.pi/navigation/index/doc.json",
            ".pi/extensions/kept.ts",
            ".pi/settings.json",
        ] {
            let path = root.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        }

        let project = walk(root.path(), &WalkOptions::default()).unwrap();
        let project_names = names(&project);
        assert!(!project_names
            .iter()
            .any(|path| path.starts_with(".pi/navigation")));
        assert!(!project_names.iter().any(|path| path.starts_with(".pi/crg")));
        assert!(!project_names
            .iter()
            .any(|path| path.starts_with(".pi/docs-index-backup-")));
        assert!(!project_names
            .iter()
            .any(|path| path.contains("/.pi/navigation/")));
        assert!(project_names.contains(&".pi/extensions/kept.ts".into()));
        assert!(project_names.contains(&".pi/settings.json".into()));

        let explicit = walk(&root.path().join(".pi/navigation"), &WalkOptions::default()).unwrap();
        assert!(names(&explicit).contains(&"index/data.json".into()));

        let all = walk(
            root.path(),
            &WalkOptions {
                visibility: Visibility::All,
                ..WalkOptions::default()
            },
        )
        .unwrap();
        assert!(!names(&all).contains(&".pi/navigation/index/data.json".into()));
    }

    #[test]
    fn candidate_cap_and_deadline_never_claim_totals() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a"), "a").unwrap();
        fs::write(root.path().join("b"), "b").unwrap();
        let capped = walk(
            root.path(),
            &WalkOptions {
                candidate_cap: Some(1),
                ..WalkOptions::default()
            },
        )
        .unwrap();
        assert!(!capped.complete);
        assert_eq!(capped.reason, Some(StopReason::CandidateCap));
        let deadline = walk(
            root.path(),
            &WalkOptions {
                deadline: Some(
                    Instant::now()
                        .checked_sub(Duration::from_millis(1))
                        .unwrap(),
                ),
                ..WalkOptions::default()
            },
        )
        .unwrap();
        assert!(!deadline.complete);
        assert_eq!(deadline.reason, Some(StopReason::Deadline));
        assert!(deadline.entries.is_empty());
    }

    #[test]
    fn patterns_depth_unicode_spaces_and_equal_mtime_paths_are_deterministic() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("nested space")).unwrap();
        fs::write(root.path().join("nested space/β"), "x").unwrap();
        fs::write(root.path().join("z.txt"), "z").unwrap();
        fs::write(root.path().join("a.txt"), "a").unwrap();
        let same_time =
            std::fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1));
        std::fs::File::options()
            .write(true)
            .open(root.path().join("a.txt"))
            .unwrap()
            .set_times(same_time)
            .unwrap();
        std::fs::File::options()
            .write(true)
            .open(root.path().join("z.txt"))
            .unwrap()
            .set_times(same_time)
            .unwrap();
        let result = walk(
            root.path(),
            &WalkOptions {
                min_depth: 1,
                max_depth: Some(2),
                patterns: vec!["*.txt".into()],
                ..WalkOptions::default()
            },
        )
        .unwrap();
        assert_eq!(names(&result), ["a.txt", "z.txt"]);
        assert_eq!(result.entries[0].modified_ns, result.entries[1].modified_ns);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_shown_and_escape_is_diagnostic() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(root.path().join("inside"), "x").unwrap();
        symlink(root.path().join("inside"), root.path().join("inside-link")).unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        fs::create_dir(root.path().join("inside-dir")).unwrap();
        fs::write(root.path().join("inside-dir/file"), "x").unwrap();
        symlink(root.path().join("inside-dir"), root.path().join("dir-link")).unwrap();
        symlink(root.path(), root.path().join("inside-dir/cycle")).unwrap();
        let result = walk(root.path(), &WalkOptions::default()).unwrap();
        assert!(result.entries.iter().any(
            |entry| entry.path == Path::new("inside-link") && entry.kind == EntryKind::Symlink
        ));
        assert!(names(&result).contains(&"dir-link/file".into()));
        assert!(result
            .diagnostics
            .iter()
            .any(|line| line.to_ascii_lowercase().contains("loop")));
        assert!(result
            .diagnostics
            .iter()
            .any(|line| line.contains("escapes scope")));
    }

    #[test]
    fn custom_navigation_ignore_layers_over_git_rules() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::create_dir_all(root.path().join(".pi/navigation")).unwrap();
        fs::write(root.path().join(".gitignore"), "git-only.txt\n").unwrap();
        fs::write(
            root.path().join(".pi/navigation/ignore"),
            "custom-only.txt\n",
        )
        .unwrap();
        fs::write(root.path().join("git-only.txt"), "git").unwrap();
        fs::write(root.path().join("custom-only.txt"), "custom").unwrap();
        fs::write(root.path().join("kept.txt"), "kept").unwrap();

        let result = walk(root.path(), &WalkOptions::default()).unwrap();
        let found = names(&result);
        assert!(
            !found.contains(&"git-only.txt".into()),
            "gitignore stays respected when a custom ignore file layers on top"
        );
        assert!(!found.contains(&"custom-only.txt".into()));
        assert!(found.contains(&"kept.txt".into()));
        assert_eq!(result.policy.source, "custom_navigation_ignore");
        assert!(result.policy.custom_override);
        assert!(result.policy.excluded >= 2);
    }

    #[test]
    fn custom_allow_re_includes_git_ignored_and_blacklisted_paths() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::create_dir_all(root.path().join(".pi/navigation")).unwrap();
        fs::create_dir(root.path().join("node_modules")).unwrap();
        fs::write(root.path().join(".gitignore"), "git-only.txt\n").unwrap();
        fs::write(
            root.path().join(".pi/navigation/ignore"),
            "custom-only.txt\n!git-only.txt\n!node_modules/**\n",
        )
        .unwrap();
        fs::write(root.path().join("git-only.txt"), "git").unwrap();
        fs::write(root.path().join("custom-only.txt"), "custom").unwrap();
        fs::write(root.path().join("node_modules/dep.js"), "dep").unwrap();
        fs::write(root.path().join("kept.txt"), "kept").unwrap();

        let result = walk(root.path(), &WalkOptions::default()).unwrap();
        let found = names(&result);
        assert!(!found.contains(&"custom-only.txt".into()));
        assert!(found.contains(&"kept.txt".into()));
        assert!(
            found.contains(&"git-only.txt".into()),
            "custom allow re-includes a gitignored path"
        );
        assert!(
            found.contains(&"node_modules/dep.js".into()),
            "custom allow re-includes a built-in blacklisted tree"
        );
        assert!(result
            .diagnostics
            .iter()
            .any(|line| line.contains("re-included")));
    }

    #[test]
    fn builtin_blacklist_prunes_known_build_and_dependency_dirs() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::create_dir(root.path().join("node_modules")).unwrap();
        fs::write(root.path().join("node_modules/dep.js"), "dep").unwrap();
        fs::write(root.path().join("kept.txt"), "kept").unwrap();

        let project = walk(root.path(), &WalkOptions::default()).unwrap();
        assert!(!names(&project).contains(&"node_modules/dep.js".into()));

        let all = walk(
            root.path(),
            &WalkOptions {
                visibility: Visibility::All,
                ..WalkOptions::default()
            },
        )
        .unwrap();
        assert!(
            names(&all).contains(&"node_modules/dep.js".into()),
            "all disables the configurable blacklist; safety exclusions remain"
        );
    }

    #[test]
    fn all_skips_git_internals_unless_git_is_explicit_scope_and_cancel_is_honest() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".git/config"), "config").unwrap();
        let all = walk(
            root.path(),
            &WalkOptions {
                visibility: Visibility::All,
                ..WalkOptions::default()
            },
        )
        .unwrap();
        assert!(!names(&all).contains(&".git/config".into()));
        let explicit = walk(
            &root.path().join(".git"),
            &WalkOptions {
                visibility: Visibility::All,
                ..WalkOptions::default()
            },
        )
        .unwrap();
        assert!(names(&explicit).contains(&"config".into()));
        let cancelled = Arc::new(AtomicBool::new(true));
        let result = walk(
            root.path(),
            &WalkOptions {
                cancelled: Some(cancelled),
                ..WalkOptions::default()
            },
        )
        .unwrap();
        assert_eq!(result.reason, Some(StopReason::Cancelled));
        assert!(result.entries.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn permission_failures_are_diagnostics_not_absence() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let denied = root.path().join("denied");
        fs::create_dir(&denied).unwrap();
        fs::write(denied.join("hidden"), "x").unwrap();
        fs::set_permissions(&denied, fs::Permissions::from_mode(0o000)).unwrap();
        let permissions_are_enforced = fs::read(denied.join("hidden")).is_err();
        let result = walk(root.path(), &WalkOptions::default()).unwrap();
        fs::set_permissions(&denied, fs::Permissions::from_mode(0o700)).unwrap();
        if !permissions_are_enforced {
            return;
        }
        assert!(!result.complete);
        assert_eq!(result.reason, Some(StopReason::Error));
        assert!(result
            .diagnostics
            .iter()
            .any(|line| line.contains("denied")));
    }
}
