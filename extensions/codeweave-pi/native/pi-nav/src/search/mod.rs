mod alloc;
pub mod blast;
pub mod callees;
pub mod callers;
pub(crate) mod capture;
pub mod content;
pub(crate) mod continuation;
pub(crate) mod declarations;
pub mod deps;
pub mod facets;
pub mod fuzzy;
pub(crate) mod focus;
pub mod glob;
pub mod grok;
pub mod lanes;
pub mod matches;
pub(crate) mod prepared;
pub mod rank;
pub mod siblings;
pub mod strip;
pub mod symbol;
pub mod truncate;

pub(crate) mod bindings;
mod bloom_walk;
mod callee_query;
pub mod scope;

use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use crate::cache::OutlineCache;
use crate::error::TilthError;
use crate::format;
use crate::read;
use crate::session::Session;
use crate::types::{estimate_tokens, FileType, Match, SearchResult};

/// Keep an exact-file search's own source identity visible rather than stripping it to "".
pub(crate) fn rel(path: &Path, scope: &Path) -> String {
    if path == scope {
        return path.file_name().map_or_else(
            || path.display().to_string(),
            |name| name.to_string_lossy().into_owned(),
        );
    }
    crate::format::rel(path, scope)
}

/// Foreground search candidates. An explicit file is an identity, not a basename glob.
pub(crate) struct ScopedFiles {
    pub paths: Vec<PathBuf>,
    pub complete: bool,
    pub reason: Option<crate::walk::StopReason>,
    pub diagnostics: Vec<String>,
}

pub(crate) fn scoped_files(
    scope: &Path,
    options: &crate::walk::WalkOptions,
) -> Result<ScopedFiles, String> {
    if scope.is_file() {
        let reason = if options
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
        return Ok(ScopedFiles {
            paths: if reason.is_none() {
                vec![scope.to_path_buf()]
            } else {
                Vec::new()
            },
            complete: reason.is_none(),
            reason,
            diagnostics: Vec::new(),
        });
    }
    let walked = crate::walk::walk(scope, options)?;
    Ok(ScopedFiles {
        paths: walked
            .entries
            .into_iter()
            .filter(|entry| entry.kind == crate::walk::EntryKind::File)
            .map(|entry| scope.join(entry.path))
            .collect(),
        complete: walked.complete,
        reason: walked.reason,
        diagnostics: walked.diagnostics,
    })
}

/// A resolution decision can depend on an absent preferred file or a symlink
/// destination without ever reading its bytes. Keep these actual probes only.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SourceInputProbe {
    Missing,
    Present { canonical: PathBuf, file: bool, directory: bool },
}

impl SourceInputProbe {
    fn observe(path: &Path) -> std::io::Result<Self> {
        match fs::metadata(path) {
            Ok(metadata) => Ok(Self::Present {
                canonical: path.canonicalize()?, file: metadata.is_file(), directory: metadata.is_dir(),
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::Missing),
            Err(error) => Err(error),
        }
    }
}

#[derive(Debug, Default, Clone)]
struct SourceInputs {
    probes: HashMap<PathBuf, SourceInputProbe>,
    path_bytes: usize,
    unavailable: Option<String>,
}

#[cfg(test)]
mod ranked_corpus_tests {
    use super::*;
    use serde_json::json;

    fn admission(root: &Path, files: &[&str]) -> serde_json::Value {
        let policy = root.join(".pi-navigation.json");
        fs::write(&policy, "{}").unwrap();
        json!({"corpusAdmission":{"root":root,"files":files,"policyDigest":"a".repeat(64),
            "policyFiles":[{"path":policy,"digest":format!("{:x}", Sha256::digest(b"{}"))}]}})
    }

    fn context(root: &Path) -> crate::dispatch::OperationContext {
        crate::dispatch::OperationContext { root: root.to_path_buf(), deadline: None,
            cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)), confine_to_root: true,
            read_format: crate::dispatch::ReadFormat::Plain }
    }

    #[test]
    fn ranked_corpus_excludes_candidates_and_callers_before_content_reads() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        for directory in ["private", "independent", "sibling"] { fs::create_dir(root.join(directory)).unwrap(); }
        fs::write(root.join("target.ts"), "export function Wanted() { return 7; }\n").unwrap();
        fs::write(root.join("sibling/caller.ts"), "import { Wanted } from '../target'; export function Caller() { return Wanted(); }\n").unwrap();
        fs::write(root.join("private/caller.ts"), "export function PrivateCaller() { return Wanted(); }\n").unwrap();
        fs::write(root.join("independent/caller.ts"), "export function Wanted() { return 'independent'; }\n").unwrap();
        let args = admission(&root, &["target.ts", "sibling/caller.ts"]);
        let sources = Arc::new(OperationSources::from_arguments(&args, &root).unwrap());
        let context = context(&root);
        let result = fuzzy::search("where does Wanted get its return value", &root, &[], crate::walk::Visibility::Project, sources.clone(), &context).unwrap();
        assert!(!result.result.matches.iter().any(|item| item.path.starts_with(root.join("private")) || item.path.starts_with(root.join("independent"))));
        let scoped = fuzzy::search("Wanted", &root.join("target.ts"), &[], crate::walk::Visibility::Project, sources.clone(), &context).unwrap();
        let targets = scoped.result.matches.iter().collect::<Vec<_>>();
        let lanes = lanes::collect(&targets, &scoped.result, &crate::index::bloom::BloomFilterCache::new(), crate::walk::Visibility::Project, &[], &context).unwrap();
        assert!(targets.iter().any(|target| lanes.get(target).is_some_and(|lane| lane.callers.iter().any(|caller| caller.path == root.join("sibling/caller.ts")))));
        let reads = sources.content_reads.lock().unwrap();
        assert!(reads.contains(&root.join("target.ts")) && reads.contains(&root.join("sibling/caller.ts")));
        assert!(reads.iter().all(|path| sources.admits(path, false)), "{reads:?}");
    }

    #[test]
    fn ranked_corpus_refuses_import_neighbor_bloom_and_symlink_reads() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("private")).unwrap();
        let text = "package probe\nfunc Caller() int { return Secret() }\n";
        fs::write(root.join("caller.go"), text).unwrap();
        fs::write(root.join("hidden.go"), "package probe\nfunc Secret() int { return 42 }\n").unwrap();
        fs::write(root.join("private/helper.ts"), "export function Secret() { return 42; }\n").unwrap();
        let args = admission(&root, &["caller.go", "target.ts"]);
        let sources = OperationSources::from_arguments(&args, &root).unwrap();
        let bloom = crate::index::bloom::BloomFilterCache::new();
        let _ = callees::connections(&root.join("caller.go"), text, crate::types::Lang::Go, Some((2,2)), None, &bloom, &sources);
        let imported = "import { Secret } from './private/helper'; export function Wanted() { return Secret(); }\n";
        fs::write(root.join("target.ts"), imported).unwrap();
        let _ = callees::connections(&root.join("target.ts"), imported, crate::types::Lang::TypeScript, Some((1,1)), None, &bloom, &sources);
        assert!(bloom_walk::read_with_sources(&root.join("hidden.go"), ["Secret"], &bloom, 100_000, Some(&sources)).is_none());
        assert!(sources.content_reads.lock().unwrap().is_empty(), "excluded candidates must never reach a content read");
        #[cfg(unix)] {
            fs::remove_file(root.join("target.ts")).unwrap();
            std::os::unix::fs::symlink(root.join("private/helper.ts"), root.join("target.ts")).unwrap();
            assert!(sources.read_text(&root.join("target.ts")).is_err());
            assert!(sources.content_reads.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn ranked_corpus_rechecks_policy_before_capture_and_cursor_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("target.ts"), "export function Wanted() { return 7; }\n").unwrap();
        let mut args = admission(&root, &["target.ts"]);
        args["query"] = json!("Wanted"); args["kind"] = json!("fuzzy"); args["scope"] = json!(root);
        let sources = Arc::new(OperationSources::from_arguments(&args, &root).unwrap());
        let context = context(&root);
        let search = fuzzy::search("Wanted", &root, &[], crate::walk::Visibility::Project, sources.clone(), &context).unwrap();
        let collection = capture::Collection::Fuzzy { search, route: "behavior discovery", lanes: None };
        let capture = capture::RankedCapture::new(root.clone(), &args, collection.clone()).unwrap();
        let retained = continuation::RetainedRanked::new(root.clone(), &args, collection, &json!({"query":"Wanted","visibility":"project"})).unwrap();
        let count = sources.content_reads.lock().unwrap().len();
        fs::write(root.join(".pi-navigation.json"), "{\"scope\":{\"exclude\":[\"target.ts\"]}}").unwrap();
        assert!(capture.validate(&args, &context).unwrap_err().contains("policy changed"));
        assert!(retained.validate(&json!({"cursor":"test", "corpusAdmission":args["corpusAdmission"]}), &context).unwrap_err().contains("policy changed"));
        assert_eq!(sources.content_reads.lock().unwrap().len(), count);
        assert_eq!(retained.collection.result().sources.content_reads.lock().unwrap().len(), count);
    }
    #[test]
    fn ranked_corpus_import_precedence_uses_retained_binder_not_legacy_probes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        for directory in ["src", "lib", "private"] { fs::create_dir(root.join(directory)).unwrap(); }
        let caller = "import { Wanted as Pick } from '../lib/wanted.js';\nimport { Hidden } from '../private/hidden';\nexport function Caller() { return Pick() + Hidden(); }\n";
        fs::write(root.join("src/caller.ts"), caller).unwrap();
        fs::write(root.join("lib/wanted.js"), "export function Wanted() { return 1; }\n").unwrap();
        fs::write(root.join("lib/wanted.js.ts"), "export function Wanted() { return 99; }\n").unwrap();
        fs::write(root.join("private/hidden.ts"), "export function Hidden() { return 42; }\n").unwrap();
        let args = admission(&root, &["src/caller.ts", "lib/wanted.js", "lib/wanted.js.ts"]);
        let sources = OperationSources::from_arguments(&args, &root).unwrap();
        let path = root.join("src/caller.ts");
        let content = sources.read_text(&path).unwrap();
        let bloom = crate::index::bloom::BloomFilterCache::new();
        let calls = callees::connections(&path, &content, crate::types::Lang::TypeScript, None, None, &bloom, &sources);
        let selected = calls.iter().find(|call| call.site.name == "Pick").unwrap();
        assert_eq!(selected.candidates.len(), 1);
        assert_eq!(selected.candidates[0].file, root.join("lib/wanted.js"));
        assert!(calls.iter().find(|call| call.site.name == "Hidden").unwrap().candidates.is_empty());
        assert!(sources.capture_size().is_ok());
        sources.validate_retained(&context(&root)).unwrap();
        let reads = sources.content_reads.lock().unwrap().clone();
        assert!(!reads.contains(&root.join("lib/wanted.js.ts")));
        assert!(!reads.contains(&root.join("private/hidden.ts")));
        // A new higher-precedence source changes census admission, before any
        // old retained image may be reopened under that different membership.
        fs::write(root.join("lib/wanted.ts"), "export function Wanted() { return 2; }\n").unwrap();
        let mut changed = args.clone();
        changed["corpusAdmission"]["files"].as_array_mut().unwrap().push(json!("lib/wanted.ts"));
        assert!(sources.validate_admission(&changed, &root).is_err());
        assert_eq!(*sources.content_reads.lock().unwrap(), reads);
        // Ordinary callers still use their old resolver and remain honestly
        // non-retainable when its precedence probes are not tracked.
        let ordinary = OperationSources::default();
        callees::connections(&path, caller, crate::types::Lang::TypeScript, None, None, &bloom, &ordinary);
        assert!(ordinary.capture_size().unwrap_err().contains("legacy explicit-extension"));
    }

    #[test]
    fn ranked_corpus_sibling_import_connections_remain_capturable() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::create_dir(root.join("sibling")).unwrap();
        fs::write(root.join("src/target.ts"), "function Left() { return 1; }\nexport function Wanted() { return Left(); }\n").unwrap();
        let caller = "import { Wanted } from '../src/target';\nexport function Caller() { const first = Wanted(); return Wanted() + first; }\nexport function Outer() { function Inner() { return Wanted(); } return Inner(); }\n";
        fs::write(root.join("sibling/caller.ts"), caller).unwrap();
        let mut args = admission(&root, &["src/target.ts", "sibling/caller.ts"]);
        args["query"] = json!("Wanted"); args["kind"] = json!("auto"); args["scope"] = json!(root);
        let sources = Arc::new(OperationSources::from_arguments(&args, &root).unwrap());
        let context = context(&root);
        let search = fuzzy::search("Wanted", &root, &[], crate::walk::Visibility::Project, sources, &context).unwrap();
        let collection = capture::Collection::Fuzzy { search, route: "behavior discovery", lanes: None };
        let capture = capture::RankedCapture::new(root.clone(), &args, collection).unwrap();
        capture.validate(&args, &context).unwrap();
        // Resume adds this target's outgoing evidence after the initial capture,
        // as semantic selection does; it must not poison the retained baseline.
        let resumed = Arc::new(capture.collection.result().sources.fork());
        let path = root.join("sibling/caller.ts");
        let content = resumed.read_text(&path).unwrap();
        let calls = callees::connections(&path, &content, crate::types::Lang::TypeScript, Some((2, 2)), None, &crate::index::bloom::BloomFilterCache::new(), &resumed);
        assert_eq!(calls.len(), 2);
        assert!(calls.iter().all(|call| call.candidates.iter().any(|candidate| candidate.name == "Wanted" && candidate.file == root.join("src/target.ts"))));
        assert!(resumed.capture_size().is_ok(), "sibling/caller.ts::Caller invalidates capture: {:?}", resumed.capture_size());
        resumed.validate_retained(&context).unwrap();
        capture.validate(&args, &context).unwrap();
        let mut enriched = capture.collection.clone();
        enriched.result_mut().sources = resumed;
        let retained = continuation::RetainedRanked::new(root.clone(), &args, enriched, &json!({"query":"Wanted","visibility":"project"})).unwrap();
        let next = json!({"cursor":"test", "corpusAdmission":args["corpusAdmission"]});
        retained.validate(&next, &context).unwrap();
        fs::write(root.join("src/target.ts"), "export function Wanted() { return 2; }\n").unwrap();
        assert!(retained.validate(&next, &context).is_err(), "imported source drift must invalidate the enriched cursor");
    }

    #[test]
    fn ranked_corpus_rendering_uses_captured_text_for_scope_and_outline() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let code = root.join("source.ts");
        let document = root.join("guide.md");
        let before = format!("function Before() {{\n  needle();\n  needle();\n}}\n{}", "// padding to put this fixture above the outline threshold\n".repeat(50));
        fs::write(&code, &before).unwrap();
        fs::write(&document, "# Before docs\n\nneedle\n").unwrap();
        let sources = Arc::new(OperationSources::from_arguments(&admission(&root, &["source.ts", "guide.md"]), &root).unwrap());
        let result = content::search_with_sources("needle", &root, false, None, None, false, sources.clone(), Some(&context(&root))).unwrap();
        assert_eq!(result.matches.len(), 3);
        let reads = sources.content_reads.lock().unwrap().clone();

        // Even a populated shared cache must not substitute the later version.
        fs::write(&code, before.replace("Before", "After")).unwrap();
        fs::write(&document, "# After docs\n\nneedle\n").unwrap();
        let cache = OutlineCache::new();
        cache.get_or_parse(&code).unwrap();
        cache.get_or_compute(&code, fs::metadata(&code).unwrap().modified().unwrap(), || "[1-4] function After()".into());
        let code_matches = result.matches.iter().filter(|item| item.path == code).cloned().collect::<Vec<_>>();
        let bloom = crate::index::bloom::BloomFilterCache::new();
        for count in [1, 2] {
            let mut output = String::new();
            format_matches(&code_matches[..count], &root, &cache, None, &bloom, &sources,
                &mut 0, &mut HashSet::new(), &mut output, &mut Vec::new(), &mut Vec::new());
            assert!(output.contains("Before"), "{output}");
            assert!(!output.contains("After"), "{output}");
        }
        for matches in [&result.matches[..], &[]] {
            let overview = basename_file_outline("source", matches, &root, &sources).unwrap();
            assert!(overview.contains("Before"), "{overview}");
            assert!(!overview.contains("After"), "{overview}");
        }
        let mut output = String::new();
        append_ranked_references_with_progress(&mut output, &mut Vec::new(), &result, None, &cache,
            4_000, None, &mut continuation::Progress::default());
        assert!(output.contains("Before docs"), "{output}");
        assert!(!output.contains("After"), "{output}");
        assert_eq!(*sources.content_reads.lock().unwrap(), reads, "formatting must reuse the captured bytes");
        assert!(sources.validate_retained(&context(&root)).is_err(), "later source drift still refuses reuse");
    }

    #[test]
    fn ranked_corpus_render_decorations_refuse_excluded_sources() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let code = root.join("excluded.ts");
        let document = root.join("excluded.md");
        fs::write(&code, "function Hidden() {\n  hidden();\n}\n").unwrap();
        fs::write(&document, "# Hidden\n\nsecret\n").unwrap();
        let sources = OperationSources::from_arguments(&admission(&root, &[]), &root).unwrap();
        assert!(get_outline_str(&code, &sources).is_none());
        assert!(find_enclosing_outline_idx(&code, 2, &sources).is_none());
        assert!(outline_context_for_match(&code, 2, &sources).is_none());
        assert!(enclosing_scope_label(&code, 2, &sources).is_none());
        assert!(enclosing_scope_label(&document, 3, &sources).is_none());
        assert!(basename_file_outline("excluded", &[], &root, &sources).is_none());
        assert!(sources.content_reads.lock().unwrap().is_empty());
    }

    #[test]
    fn ranked_corpus_search_transport_and_proof_use_the_same_admission() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("private")).unwrap();
        fs::write(root.join("target.ts"), "export function Wanted() { return 7; }\n").unwrap();
        fs::write(root.join("private/hidden.ts"), "export function Wanted() { return 42; }\n").unwrap();
        let mut args = admission(&root, &["target.ts"]);
        args["query"] = json!("Wanted"); args["scope"] = json!(root); args["root"] = json!(root);
        let native = crate::dispatch::NativeSession::new(&root, false).unwrap();
        let context = context(&root);
        for (kind, query) in [("symbol", "Wanted"), ("auto", "where does Wanted get its return value")] {
            for glob in [json!(null), json!(["*.ts"])] {
                args["kind"] = json!(kind);
                args["query"] = json!(query);
                if glob.is_null() { args.as_object_mut().unwrap().remove("glob"); } else { args["glob"] = glob; }
                let output = crate::ops::tool_search_output(&args, &native.cache, &native.session, &native.bloom, &context).unwrap();
                assert!(output.text.contains("Wanted"));
                assert!(!output.text.contains("hidden.ts"));
                assert!(!output.structured.to_string().contains("hidden.ts"));
                assert!(output.source_snapshots.iter().all(|snapshot| !snapshot.canonical_path.contains("hidden.ts")));
            }
        }
        #[cfg(feature = "napi-addon")] {
            args["paths"] = json!(["target.ts", "private/hidden.ts"]);
            let output = crate::source_proof::prove(&args, &context).unwrap();
            assert_eq!(output.source_snapshots.len(), 1);
            assert!(output.source_snapshots[0].canonical_path.ends_with("target.ts"));
            assert_eq!(output.structured["data"]["files"][1]["status"], "rejected");
        }
    }
}

/// A query-local census from the existing corpus owner, independent of a database.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CorpusAdmission {
    root: PathBuf,
    files: std::collections::BTreeSet<PathBuf>,
    policy_digest: String,
    policy_files: Vec<PolicyInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct PolicyInput { path: PathBuf, digest: Option<String> }

impl CorpusAdmission {
    fn validate(&self) -> std::io::Result<()> { validate_policy_inputs(&self.policy_files) }
}

fn validate_policy_inputs(inputs: &[PolicyInput]) -> std::io::Result<()> {
        use std::io::Read;
        for input in inputs {
            let mut options = fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)] {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NONBLOCK);
            }
            let actual = match options.open(&input.path) {
                Ok(file) => {
                    if !file.metadata()?.is_file() { return Err(std::io::Error::other("corpus policy is not a regular file")); }
                    let mut bytes = Vec::new();
                    file.take(1_048_577).read_to_end(&mut bytes)?;
                    if bytes.len() > 1_048_576 { return Err(std::io::Error::other("corpus policy exceeds its bound")); }
                    Some(format!("{:x}", Sha256::digest(&bytes)))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error),
            };
            if actual != input.digest { return Err(std::io::Error::other("corpus policy changed; restart the ranked query")); }
        }
        Ok(())
    }

// Same no-follow, regular-file boundary as native evidence capture. Compare the
// opened handle to the path before reading, not just after consuming its bytes.
fn open_source(path: &Path) -> std::io::Result<fs::File> {
    if path.canonicalize()? != path { return Err(std::io::Error::other("corpus source path changed")); }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || path.canonicalize()? != path { return Err(std::io::Error::other("corpus source handle changed")); }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        let current = fs::metadata(path)?;
        if (metadata.dev(), metadata.ino()) != (current.dev(), current.ino()) { return Err(std::io::Error::other("corpus source was replaced")); }
    }
    Ok(file)
}

/// Current text retained only for one search operation. Workers, rendering,
/// and proof snapshots share this owner so each canonical file is read once.
#[derive(Debug, Default)]
pub(crate) struct OperationSources {
    admission: Option<Arc<CorpusAdmission>>,
    #[cfg(test)]
    content_reads: Mutex<Vec<PathBuf>>,
    files: Mutex<HashMap<PathBuf, Arc<String>>>,
    inputs: Mutex<SourceInputs>,
    reads: AtomicUsize,
    duplicate_paths: AtomicUsize,
    canonical_aliases: AtomicUsize,
}

impl OperationSources {
    pub(crate) fn from_arguments(args: &serde_json::Value, root: &Path) -> Result<Self, String> {
        let Some(value) = args.get("corpusAdmission") else { return Ok(Self::default()); };
        if value.to_string().len() > 8 * 1024 * 1024 { return Err("corpus admission exceeds 8 MiB".into()); }
        let admission: CorpusAdmission = serde_json::from_value(value.clone()).map_err(|_| "invalid corpus admission")?;
        let digest = |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
        if admission.root != root || !root.is_absolute() || root.canonicalize().ok().as_deref() != Some(root)
            || admission.files.len() > 100_000 || admission.policy_files.len() > 16 || admission.policy_files.is_empty()
            || !digest(&admission.policy_digest)
            || admission.files.iter().any(|file| file.as_os_str().is_empty() || file.is_absolute()
                || file.components().any(|part| !matches!(part, std::path::Component::Normal(_))))
            || admission.policy_files.iter().any(|input| !input.path.is_absolute() || input.digest.as_ref().is_some_and(|value| !digest(value))) {
            return Err("invalid corpus admission identity or bounds".into());
        }
        admission.validate().map_err(|error| error.to_string())?;
        Ok(Self { admission: Some(Arc::new(admission)), ..Self::default() })
    }

    pub(crate) fn validate_admission(&self, args: &serde_json::Value, root: &Path) -> Result<(), String> {
        let current = Self::from_arguments(args, root)?;
        if current.admission != self.admission { return Err("ranked corpus admission changed; restart the query".into()); }
        Ok(())
    }

    pub(crate) fn corpus_root(&self) -> Option<&Path> { self.admission.as_ref().map(|admission| admission.root.as_path()) }

    fn admits(&self, path: &Path, directories: bool) -> bool {
        self.admission.as_ref().is_none_or(|admission| path.strip_prefix(&admission.root).ok().is_some_and(|local|
            admission.files.contains(local) || directories && (local.as_os_str().is_empty() || admission.files.iter().any(|file| file.starts_with(local)))))
    }

    pub(crate) fn scoped_files(&self, scope: &Path, options: &crate::walk::WalkOptions) -> Result<ScopedFiles, String> {
        let Some(admission) = &self.admission else { return scoped_files(scope, options); };
        admission.validate().map_err(|error| error.to_string())?;
        if !scope.starts_with(&admission.root) { return Err("search scope is outside the admitted corpus".into()); }
        let (includes, excludes) = crate::walk::compile_patterns(&options.patterns)?;
        let exact = scope.is_file();
        let paths = admission.files.iter().map(|file| admission.root.join(file)).filter(|file|
            if exact { file == scope } else { file.strip_prefix(scope).is_ok_and(|relative|
                crate::walk::matches_patterns(relative, includes.as_ref(), excludes.as_ref())) }).collect();
        Ok(ScopedFiles { paths, complete: true, reason: None, diagnostics: Vec::new() })
    }

    pub(crate) fn walker(&self, scope: &Path, glob: Option<&str>) -> Result<ignore::WalkParallel, TilthError> {
        if self.admission.is_none() { return walker(scope, glob); }
        let options = crate::walk::WalkOptions { patterns: glob.filter(|value| !value.is_empty()).map(|value| vec![value.to_owned()]).unwrap_or_default(), ..Default::default() };
        let files = self.scoped_files(scope, &options).map_err(|reason| TilthError::InvalidQuery { query: scope.display().to_string(), reason })?.paths;
        // Feed admitted files to the existing walker. Disable directory descent
        // and secondary ignore matching: the census already owns those decisions.
        let mut builder = ignore::WalkBuilder::new(files.first().map_or(scope, PathBuf::as_path));
        builder.max_depth(Some(0)).follow_links(false).hidden(false).ignore(false)
            .git_ignore(false).git_global(false).git_exclude(false).parents(false);
        for file in files.iter().skip(1) { builder.add(file); }
        let allowed: HashSet<_> = files.into_iter().collect();
        builder.filter_entry(move |entry| allowed.contains(entry.path()));
        Ok(builder.build_parallel())
    }

    /// A continuation owns fixed input maps. Optional work may extend its own
    /// operation, but cannot mutate the baseline cursor's validation boundary.
    pub(crate) fn fork(&self) -> Self {
        let inputs = self.inputs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let files = self.files.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        Self {
            files: Mutex::new(files), inputs: Mutex::new(inputs),
            admission: self.admission.clone(),
            #[cfg(test)]
            content_reads: Mutex::new(self.content_reads.lock().unwrap().clone()),
            reads: AtomicUsize::new(self.reads.load(Ordering::Relaxed)),
            duplicate_paths: AtomicUsize::new(self.duplicate_paths.load(Ordering::Relaxed)),
            canonical_aliases: AtomicUsize::new(self.canonical_aliases.load(Ordering::Relaxed)),
        }
    }

    pub(crate) fn read_text(&self, path: &Path) -> std::io::Result<Arc<String>> {
        if let Some(admission) = &self.admission {
            admission.validate()?;
            if !self.admits(path, false) { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "source is outside the admitted corpus")); }
        }
        let canonical = path.canonicalize()?;
        if canonical != path {
            self.canonical_aliases.fetch_add(1, Ordering::Relaxed);
        }
        if self.admission.is_some() && canonical != path { return Err(std::io::Error::other("corpus source path changed")); }
        if let Some(text) = self
            .files
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&canonical)
            .cloned()
        {
            self.duplicate_paths.fetch_add(1, Ordering::Relaxed);
            return Ok(text);
        }

        let text = Arc::new(if self.admission.is_some() {
            use std::io::Read;
            let mut file = open_source(path)?;
            #[cfg(test)] self.content_reads.lock().unwrap().push(path.to_path_buf());
            let mut text = String::new();
            file.read_to_string(&mut text)?;
            text
        } else { fs::read_to_string(&canonical)? });
        let mut files = self
            .files
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(retained) = files.get(&canonical) {
            self.duplicate_paths.fetch_add(1, Ordering::Relaxed);
            return Ok(retained.clone());
        }
        self.reads.fetch_add(1, Ordering::Relaxed);
        files.insert(canonical, text.clone());
        Ok(text)
    }

    pub(crate) fn capture_unavailable(&self, reason: String) {
        self.inputs.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .unavailable.get_or_insert(reason);
    }

    fn input_probe(&self, path: &Path) -> std::io::Result<SourceInputProbe> {
        if !self.admits(path, true) { return Ok(SourceInputProbe::Missing); }
        let probe = SourceInputProbe::observe(path);
        let mut inputs = self.inputs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if inputs.unavailable.is_none() {
            match &probe {
                Err(error) => { inputs.unavailable = Some(format!("unverifiable source input {}: {error}", path.display())); }
                Ok(probe) => {
                    let bytes = path.as_os_str().len() + match probe {
                        SourceInputProbe::Missing => 0,
                        SourceInputProbe::Present { canonical, .. } => canonical.as_os_str().len(),
                    };
                    if let Some(previous) = inputs.probes.get(path) {
                        if previous != probe {
                            inputs.unavailable = Some(format!("source input changed during collection: {}", path.display()));
                        }
                    } else if inputs.probes.len() >= 4096 || inputs.path_bytes.saturating_add(bytes) > 8 * 1024 * 1024 {
                        inputs.unavailable = Some("source inputs exceed the 4096-probe or 8-MiB path bound".into());
                    } else {
                        inputs.path_bytes += bytes;
                        inputs.probes.insert(path.to_path_buf(), probe.clone());
                    }
                }
            }
        }
        probe
    }

    pub(crate) fn input_exists(&self, path: &Path) -> bool {
        matches!(self.input_probe(path), Ok(SourceInputProbe::Present { .. }))
    }

    pub(crate) fn input_is_file(&self, path: &Path) -> bool {
        matches!(self.input_probe(path), Ok(SourceInputProbe::Present { file: true, .. }))
    }

    pub(crate) fn input_canonicalize(&self, path: &Path) -> std::io::Result<PathBuf> {
        match self.input_probe(path)? {
            SourceInputProbe::Present { canonical, .. } => Ok(canonical),
            SourceInputProbe::Missing => Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
        }
    }

    pub(crate) fn read_input_text(&self, path: &Path) -> std::io::Result<Arc<String>> {
        let _ = self.input_probe(path);
        let text = self.read_text(path);
        if let Err(error) = &text {
            self.capture_unavailable(format!("unverifiable source input {}: {error}", path.display()));
        }
        let _ = self.input_probe(path);
        text
    }

    pub(crate) fn retained_text(&self, path: &Path) -> Option<Arc<String>> {
        let canonical = path.canonicalize().ok()?;
        if !self.admits(&canonical, false) || self.admission.as_ref().is_some_and(|admission| admission.validate().is_err()) { return None; }
        self.files
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&canonical)
            .cloned()
    }

    pub(crate) fn capture_size(&self) -> Result<(usize, usize), String> {
        let inputs = self.inputs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(reason) = &inputs.unavailable { return Err(reason.clone()); }
        let files = self.files.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok((files.len(), files.iter().fold(inputs.path_bytes, |bytes, (path, text)| {
            bytes.saturating_add(text.len()).saturating_add(path.as_os_str().len())
        })))
    }

    /// Independently re-read captured bytes; cache hits cannot establish freshness
    /// across native calls. This does not discover added files or refresh a corpus.
    pub(crate) fn validate_retained(&self, context: &crate::dispatch::OperationContext) -> Result<(), String> {
        use std::io::Read;
        context.check().map_err(|error| error.to_string())?;
        if let Some(admission) = &self.admission { admission.validate().map_err(|error| error.to_string())?; }
        {
            let inputs = self.inputs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(reason) = &inputs.unavailable { return Err(reason.clone()); }
            for (path, previous) in &inputs.probes {
                context.check().map_err(|error| error.to_string())?;
                if SourceInputProbe::observe(path).map_err(|error| error.to_string())? != *previous {
                    return Err(format!("ranked capture source input changed: {}", path.display()));
                }
            }
        }
        let files = self.files.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        for (path, text) in files.iter() {
            context.check().map_err(|error| error.to_string())?;
            if path.canonicalize().map_err(|error| error.to_string())? != *path {
                return Err(format!("ranked capture source path changed: {}", path.display()));
            }
            let mut current = Vec::new();
            let file = if self.admission.is_some() {
                let file = open_source(path).map_err(|error| error.to_string())?;
                #[cfg(test)] self.content_reads.lock().unwrap().push(path.clone());
                file
            } else { std::fs::File::open(path).map_err(|error| error.to_string())? };
            file
                .take(text.len() as u64 + 1).read_to_end(&mut current).map_err(|error| error.to_string())?;
            if current != text.as_bytes()
                || path.canonicalize().map_err(|error| error.to_string())? != *path {
                return Err(format!("ranked capture source changed: {}", path.display()));
            }
            context.check().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn counters(&self) -> (usize, usize, usize) {
        (
            self.reads.load(Ordering::Relaxed),
            self.duplicate_paths.load(Ordering::Relaxed),
            self.canonical_aliases.load(Ordering::Relaxed),
        )
    }
}

// Directories that are always skipped — build artifacts, dependencies, VCS internals.
// We skip these explicitly instead of relying on .gitignore so that locally-relevant
// gitignored files (docs/, configs, generated code) are still searchable.
pub(crate) const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".pycache",
    "vendor",
    ".next",
    ".nuxt",
    "coverage",
    ".cache",
    ".tox",
    ".venv",
    ".eggs",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    ".turbo",
    ".parcel-cache",
    ".svelte-kit",
    "out",
    ".output",
    ".vercel",
    ".netlify",
    ".gradle",
    ".idea",
    ".scala-build",
    ".bloop",
    ".metals",
    ".codanna",
    ".codescope",
    ".codedb-mcp",
    ".codesearch.db",
    ".fastembed_cache",
    ".pluck",
    ".rtfm",
    "graphify-out",
    ".tmp",
];

const EXPAND_FULL_FILE_THRESHOLD: u64 = 800;

/// Cap for inlined markdown section bodies in the default preview slot.
/// Long sections get a tail "… (N more lines — pass --expand to see the full
/// section)" so the user knows to expand for the rest.
const MARKDOWN_PREVIEW_MAX_LINES: usize = 40;

/// Build a parallel directory walker that searches ALL files except known junk directories.
/// Does NOT respect .gitignore — ensures gitignored but locally-relevant files are found.
/// When `glob` is Some, applies a file-pattern override (whitelist or negation).
pub(crate) fn walker(scope: &Path, glob: Option<&str>) -> Result<ignore::WalkParallel, TilthError> {
    let threads = std::env::var("PI_NAV_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or_else(|| {
            std::thread::available_parallelism().map_or(4, |n| (n.get() / 2).clamp(2, 6))
        });

    let mut builder = crate::walk::builder(scope, crate::walk::Visibility::Project);
    builder.threads(threads);

    if let Some(pattern) = glob {
        if !pattern.is_empty() {
            let mut overrides = ignore::overrides::OverrideBuilder::new(scope);
            overrides
                .add(pattern)
                .map_err(|e| TilthError::InvalidQuery {
                    query: pattern.to_string(),
                    reason: format!("invalid glob: {e}"),
                })?;
            builder.overrides(overrides.build().map_err(|e| TilthError::InvalidQuery {
                query: pattern.to_string(),
                reason: format!("invalid glob: {e}"),
            })?);
        }
    }

    Ok(builder.build_parallel())
}

/// Parse `/pattern/` regex syntax. Returns (pattern, `is_regex`).
fn parse_pattern(query: &str) -> (&str, bool) {
    if query.starts_with('/') && query.ends_with('/') && query.len() > 2 {
        (&query[1..query.len() - 1], true)
    } else {
        (query, false)
    }
}

/// Get `file_lines` estimate and mtime from metadata. One `stat()` per file.
pub(crate) fn file_metadata(path: &Path) -> (u32, SystemTime) {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let est_lines = (meta.len() / 40).max(1) as u32;
            (est_lines, mtime)
        }
        Err(_) => (0, SystemTime::UNIX_EPOCH),
    }
}

/// Dispatch search by query type.
pub fn search_symbol(
    query: &str,
    scope: &Path,
    cache: &OutlineCache,
    glob: Option<&str>,
) -> Result<String, TilthError> {
    let result = symbol::search(query, scope, None, glob, false)?;
    let bloom = crate::index::bloom::BloomFilterCache::new();
    format_search_result(&result, cache, None, &bloom, 0, None)
}

pub fn search_symbol_expanded(
    query: &str,
    scope: &Path,
    cache: &OutlineCache,
    session: &Session,
    bloom: &crate::index::bloom::BloomFilterCache,
    expand: usize,
    context: Option<&Path>,
    glob: Option<&str>,
    full: bool,
    budget: Option<u64>,
) -> Result<String, TilthError> {
    let result = symbol::search(query, scope, context, glob, full)?;
    format_search_result(&result, cache, Some(session), bloom, expand, budget)
}

pub fn search_multi_symbol_expanded(
    queries: &[&str],
    scope: &Path,
    cache: &OutlineCache,
    session: &Session,
    bloom: &crate::index::bloom::BloomFilterCache,
    expand: usize,
    context: Option<&Path>,
    glob: Option<&str>,
    full: bool,
    budget: Option<u64>,
) -> Result<String, TilthError> {
    // Shared expand budget: at least 1 slot per query, or explicit expand if higher.
    // expand=0 means no expansion at all.
    let mut expand_remaining = if expand == 0 {
        0
    } else {
        expand.max(queries.len())
    };
    let mut expanded_files = HashSet::new();
    let mut sections = Vec::with_capacity(queries.len());

    for query in queries {
        let result = symbol::search(query, scope, context, glob, full)?;
        let mut out = format::search_header(
            &result.query,
            &result.scope,
            result.matches.len(),
            result.definitions,
            result.usages,
        );
        let mut segments: Vec<(i64, usize, usize)> = Vec::new();
        let mut segment_rows = Vec::new();
        format_matches(
            &result.matches,
            &result.scope,
            cache,
            Some(session),
            bloom,
            &result.sources,
            &mut expand_remaining,
            &mut expanded_files,
            &mut out,
            &mut segments,
            &mut segment_rows,
        );
        if result.total_found > result.matches.len() {
            let omitted = result.total_found - result.matches.len();
            let _ = write!(
                out,
                "\n\n... and {omitted} more matches. Narrow with scope."
            );
        }
        // budget.unwrap_or(DEFAULT_BUDGET): keeps the no-budget path byte-
        // identical to before this fix (see format_search_result's own comment).
        let budget_tokens = crate::budget::clamp(budget.unwrap_or(crate::budget::DEFAULT_BUDGET));
        out = crate::search::alloc::fit_to_budget(&out, &segments, budget_tokens);
        sections.push(out);
    }

    Ok(sections.join("\n\n---\n"))
}

pub fn search_content(
    query: &str,
    scope: &Path,
    cache: &OutlineCache,
    glob: Option<&str>,
) -> Result<String, TilthError> {
    let (pattern, is_regex) = parse_pattern(query);
    let result = content::search(pattern, scope, is_regex, None, glob, false)?;
    let bloom = crate::index::bloom::BloomFilterCache::new();
    format_search_result(&result, cache, None, &bloom, 0, None)
}

pub fn search_regex(
    pattern: &str,
    scope: &Path,
    cache: &OutlineCache,
    glob: Option<&str>,
) -> Result<String, TilthError> {
    let result = content::search(pattern, scope, true, None, glob, false)?;
    let bloom = crate::index::bloom::BloomFilterCache::new();
    format_search_result(&result, cache, None, &bloom, 0, None)
}

pub fn search_content_expanded(
    query: &str,
    scope: &Path,
    cache: &OutlineCache,
    session: &Session,
    expand: usize,
    context: Option<&Path>,
    glob: Option<&str>,
    full: bool,
    budget: Option<u64>,
) -> Result<String, TilthError> {
    let (pattern, is_regex) = parse_pattern(query);
    let result = content::search(pattern, scope, is_regex, context, glob, full)?;
    let bloom = crate::index::bloom::BloomFilterCache::new();
    format_search_result(&result, cache, Some(session), &bloom, expand, budget)
}

/// Expanded regex search — takes raw pattern, no slash wrapping needed.
pub fn search_regex_expanded(
    pattern: &str,
    scope: &Path,
    cache: &OutlineCache,
    session: &Session,
    expand: usize,
    context: Option<&Path>,
    glob: Option<&str>,
    full: bool,
    budget: Option<u64>,
) -> Result<String, TilthError> {
    let result = content::search(pattern, scope, true, context, glob, full)?;
    let bloom = crate::index::bloom::BloomFilterCache::new();
    format_search_result(&result, cache, Some(session), &bloom, expand, budget)
}

/// Raw symbol search — returns structured result for programmatic inspection.
pub fn search_symbol_raw(
    query: &str,
    scope: &Path,
    glob: Option<&str>,
) -> Result<SearchResult, TilthError> {
    symbol::search(query, scope, None, glob, false)
}

/// Raw content search — returns structured result for programmatic inspection.
pub fn search_content_raw(
    query: &str,
    scope: &Path,
    glob: Option<&str>,
) -> Result<SearchResult, TilthError> {
    let (pattern, is_regex) = parse_pattern(query);
    content::search(pattern, scope, is_regex, None, glob, false)
}

/// Raw regex search — returns structured result for programmatic inspection.
pub fn search_regex_raw(
    pattern: &str,
    scope: &Path,
    glob: Option<&str>,
) -> Result<SearchResult, TilthError> {
    content::search(pattern, scope, true, None, glob, false)
}

/// Format a raw search result (symbol or content — both use the same pipeline).
pub fn format_raw_result(
    result: &SearchResult,
    cache: &OutlineCache,
) -> Result<String, TilthError> {
    let bloom = crate::index::bloom::BloomFilterCache::new();
    format_search_result(result, cache, None, &bloom, 0, None)
}

pub fn search_glob(pattern: &str, scope: &Path) -> Result<String, TilthError> {
    let result = glob::search(pattern, scope)?;
    format_glob_result(&result, scope)
}

/// Render the count for a facet section heading. Returns the bare displayed
/// count when nothing was hidden (`shown == total`), or `displayed/total`
/// when the cap dropped some entries — so a reader sees at a glance whether
/// the facet was truncated.
fn count_label(shown: usize, total: usize) -> String {
    if shown >= total {
        format!("{shown}")
    } else {
        format!("{shown}/{total}")
    }
}

/// Emit a per-facet hidden-count tail line after a truncated facet's entries.
/// Wording mirrors the linear-path global tail so a reader sees a single
/// consistent shape — only the noun changes per facet kind.
fn write_hidden_tail(out: &mut String, shown: usize, total: usize, kind: &str) {
    if shown < total {
        let hidden = total - shown;
        let _ = write!(out, "\n\n... and {hidden} more {kind}. Narrow with scope.");
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RenderedSourceRow {
    pub(crate) path: PathBuf,
    pub(crate) line: u32,
    pub(crate) text: String,
}

struct ExpandedMatch {
    code: String,
    content: String,
    source_rows: Vec<RenderedSourceRow>,
}

pub(crate) struct FormattedSearchResult {
    pub(crate) text: String,
    pub(crate) source_rows: Vec<RenderedSourceRow>,
    pub(crate) source_snapshots: Vec<crate::source_proof::SourceSnapshot>,
    pub(crate) omitted_relationship_evidence: usize,
    pub(crate) receipt: continuation::Progress,
}

fn required_source_lines(path: &Path, content: &str, regions: &[RankedRegion]) -> Vec<continuation::SourceLine> {
    content.lines().enumerate().filter_map(|(index, text)| {
        let line = index as u32 + 1;
        (!text.trim().is_empty() && regions.iter().any(|region| region.start <= line && line <= region.end))
            .then(|| (path.to_path_buf(), line))
    }).collect()
}

fn target_requirements(matched: &Match, content: &str, regions: &[RankedRegion]) -> Vec<continuation::SourceLine> {
    if let (Some(declaration), FileType::Code(lang)) = (&matched.declaration, crate::lang::detect_file_type(&matched.path)) {
        if let Some(headers) = declaration.class_inventory(content, lang) {
            let headers = headers.iter().map(|(_, span)| {
                let (start, end) = declarations::lines_for(content, span);
                RankedRegion { start, end }
            }).collect::<Vec<_>>();
            return required_source_lines(&matched.path, content, &headers);
        }
    }
    required_source_lines(&matched.path, content, regions)
}

fn remaining_target_regions(matched: &Match, content: &str, regions: &[RankedRegion], progress: Option<&continuation::Progress>) -> Vec<RankedRegion> {
    let Some(progress) = progress else { return regions.to_vec(); };
    let key = continuation::GroupKey::Target(lanes::target_key(matched));
    if !progress.rows.contains_key(&key) || matched.declaration.as_ref().is_some_and(|declaration| declaration.class_region().is_some()) {
        return regions.to_vec();
    }
    let signature = matched.declaration.as_ref().and_then(|declaration| {
        let region = declaration.region();
        (region.body.is_some() || matches!(region.kind, crate::tsjs_source::Kind::Function | crate::tsjs_source::Kind::Method | crate::tsjs_source::Kind::MethodSignature))
            .then(|| declarations::lines_for(content, &region.signature))
    }).or_else(|| matched.def_range.and_then(|(start, end)| scope::signature_end_line(&matched.path, content, start, end).map(|end| (start, end))))
        .unwrap_or((matched.line, matched.line));
    let mut lines = std::collections::BTreeSet::new();
    for region in regions {
        lines.extend((region.start..=region.end).filter(|line| (signature.0 <= *line && *line <= signature.1)
            || !progress.contains(&key, &matched.path, *line)));
    }
    let mut remaining: Vec<RankedRegion> = Vec::new();
    for line in lines {
        if let Some(last) = remaining.last_mut().filter(|last| last.end + 1 == line) { last.end = line; }
        else { remaining.push(RankedRegion { start: line, end: line }); }
    }
    remaining
}

/// Format match entries with optional expansion.
/// Groups consecutive usage matches in the same enclosing function to reduce token noise.
/// Shared expand state enables cross-query dedup in multi-symbol search.
fn format_matches(
    matches: &[Match],
    scope: &Path,
    cache: &OutlineCache,
    session: Option<&Session>,
    bloom: &crate::index::bloom::BloomFilterCache,
    sources: &OperationSources,
    expand_remaining: &mut usize,
    expanded_files: &mut HashSet<PathBuf>,
    out: &mut String,
    segments: &mut Vec<(i64, usize, usize)>,
    segment_rows: &mut Vec<Vec<RenderedSourceRow>>,
) {
    // Multi-file: one expand per unique file. Single-file: sequential per-match.
    // expanded_files may contain entries from prior queries (cross-query dedup).
    let multi_file = matches
        .first()
        .is_some_and(|first| matches.iter().any(|m| m.path != first.path));

    // Group consecutive non-definition matches by (path, enclosing_outline_idx).
    // Same-line source declarations share one allocation/source block, not identity.
    let groups = group_matches(matches, sources);

    for group in &groups {
        if group.len() == 1 || group[0].declaration.is_some() {
            let start = out.len();
            let mut rows = format_single_match_with_sources(
                group[0],
                scope,
                cache,
                session,
                sources,
                bloom,
                expand_remaining,
                expanded_files,
                multi_file,
                out,
            );
            for matched in group.iter().skip(1) {
                if let (Some(declaration), Ok(content)) =
                    (&matched.declaration, sources.read_text(&matched.path))
                {
                    let _ = write!(
                        out,
                        "\n\n### {}:{} [definition] {}\n",
                        rel(&matched.path, scope),
                        declaration.position(&content),
                        result_name(matched)
                    );
                    let allowance = RANKED_TARGET_NONBLANK_CAP.saturating_sub(
                        rows.iter()
                            .filter(|row| !row.text.trim().is_empty())
                            .count(),
                    );
                    let (start, end) =
                        declarations::lines_for(&content, &declaration.region().signature);
                    render_ranked_regions(
                        out,
                        &mut rows,
                        matched,
                        &content,
                        &[RankedRegion { start, end }],
                        None,
                        allowance,
                    );
                    if let FileType::Code(lang) = crate::lang::detect_file_type(&matched.path) {
                        append_match_connections(
                            matched, &content, lang, bloom, scope, out, sources,
                        );
                    }
                }
            }
            segments.push((i64::from(group[0].def_weight), start, out.len()));
            segment_rows.push(rows);
        } else {
            let start = out.len();
            format_grouped_usages(group, scope, sources, out);
            let value = group
                .iter()
                .map(|m| i64::from(m.def_weight))
                .max()
                .unwrap_or(0);
            segments.push((value, start, out.len()));
            segment_rows.push(Vec::new());
        }
    }
}

/// Group consecutive non-definition matches by (path, enclosing outline entry).
/// Definition dedup extends the legacy line/name/range key with source identity.
type DefKey<'a> = (
    &'a Path,
    u32,
    Option<(u32, u32)>,
    Option<&'a str>,
    Option<&'a str>,
    Option<(usize, usize, &'a str)>,
);

/// Returns a Vec of groups, where each group is a slice of matches.
/// Same-line source declarations share a source block but retain separate headings.
fn group_matches<'a>(matches: &'a [Match], sources: &OperationSources) -> Vec<Vec<&'a Match>> {
    let mut groups: Vec<Vec<&Match>> = Vec::new();
    let mut seen_defs: HashSet<DefKey<'_>> = HashSet::new();

    for m in matches {
        if m.is_definition || m.impl_target.is_some() {
            let key = (
                m.path.as_path(),
                m.line,
                m.def_range,
                m.def_name.as_deref(),
                m.impl_target.as_deref(),
                m.declaration.as_ref().map(|declaration| declaration.key()),
            );
            if !seen_defs.insert(key) {
                continue;
            }
        }
        // Only single-line source declarations share a definition group.
        if m.is_definition || m.impl_target.is_some() {
            // A physical line is one source-evidence unit, not one declaration.
            // Keep all identities/headings together so allocation cannot orphan
            // a later "source above" reference by removing its source block.
            if m.declaration.is_some() && m.def_range.is_some_and(|(start, end)| start == end) {
                if let Some(group) = groups.iter_mut().find(|group| {
                    let first = group[0];
                    first.declaration.is_some()
                        && first.path == m.path
                        && first.def_range == m.def_range
                }) {
                    group.push(m);
                    continue;
                }
            }
            groups.push(vec![m]);
            continue;
        }

        // For usages: try to merge with previous group if same (path, outline_idx)
        if let Some(last_group) = groups.last_mut() {
            let prev = last_group[0];
            // Only merge usages (previous must also be a usage in the same file)
            if !prev.is_definition
                && prev.impl_target.is_none()
                && prev.path == m.path
                && m.file_lines >= 50
            {
                let prev_idx = find_enclosing_outline_idx(&prev.path, prev.line, sources);
                let curr_idx = find_enclosing_outline_idx(&m.path, m.line, sources);
                if prev_idx.is_some() && prev_idx == curr_idx {
                    last_group.push(m);
                    continue;
                }
            }
        }
        groups.push(vec![m]);
    }
    groups
}

/// Format a group of usages collapsed into a single entry.
fn format_grouped_usages(group: &[&Match], scope: &Path, sources: &OperationSources, out: &mut String) {
    let first = group[0];
    let path_str = rel(&first.path, scope);

    // Build comma-separated line list, collapsing consecutive runs (e.g. 55,56,57 → 55-57)
    let lines: Vec<u32> = group.iter().map(|m| m.line).collect();
    let line_str = format_line_list(&lines);

    let scope_label = enclosing_scope_label(&first.path, first.line, sources);

    let _ = write!(out, "\n\n### {path_str}:{line_str} [{} usages", group.len());
    if let Some(ref label) = scope_label {
        let _ = write!(out, " in {label}");
    }
    out.push(']');

    // Show outline context once for the group
    if let Some(context) = outline_context_for_match(&first.path, first.line, sources) {
        out.push_str(&context);
    }
}

/// Format a comma-separated line list, collapsing consecutive runs.
/// e.g. [50, 55, 56, 57, 58, 63, 67] → "50,55-58,63,67"
fn format_line_list(lines: &[u32]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    let mut run_start = lines[0];
    let mut run_end = lines[0];
    for &line in &lines[1..] {
        if line == run_end + 1 {
            run_end = line;
        } else {
            if run_end > run_start + 1 {
                parts.push(format!("{run_start}-{run_end}"));
            } else if run_end > run_start {
                parts.push(format!("{run_start},{run_end}"));
            } else {
                parts.push(format!("{run_start}"));
            }
            run_start = line;
            run_end = line;
        }
    }
    if run_end > run_start + 1 {
        parts.push(format!("{run_start}-{run_end}"));
    } else if run_end > run_start {
        parts.push(format!("{run_start},{run_end}"));
    } else {
        parts.push(format!("{run_start}"));
    }
    parts.join(",")
}

/// The symbol to feed query-aware truncation when expanding a match's body.
///
/// For `impl`/`implements` matches the user searched for the trait or interface,
/// which is held in `impl_target` — `def_name` is the rendered label
/// (`"impl Trait for Type"` / `"Type implements Trait"`) and never appears
/// verbatim in the body, so boosting on it is a no-op. For plain definitions
/// `impl_target` is `None` and the searched token is the symbol name in
/// `def_name`. Preferring `impl_target` routes the real query into the boost for
/// both shapes.
fn boost_query(m: &Match) -> Option<&str> {
    m.impl_target.as_deref().or(m.def_name.as_deref())
}

#[cfg(test)]
fn format_single_match(
    m: &Match,
    scope: &Path,
    cache: &OutlineCache,
    session: Option<&Session>,
    bloom: &crate::index::bloom::BloomFilterCache,
    expand_remaining: &mut usize,
    expanded_files: &mut HashSet<PathBuf>,
    multi_file: bool,
    out: &mut String,
) -> Vec<RenderedSourceRow> {
    format_single_match_with_sources(
        m,
        scope,
        cache,
        session,
        &OperationSources::default(),
        bloom,
        expand_remaining,
        expanded_files,
        multi_file,
        out,
    )
}

fn format_single_match_with_sources(
    m: &Match,
    scope: &Path,
    _cache: &OutlineCache,
    session: Option<&Session>,
    sources: &OperationSources,
    bloom: &crate::index::bloom::BloomFilterCache,
    expand_remaining: &mut usize,
    expanded_files: &mut HashSet<PathBuf>,
    multi_file: bool,
    out: &mut String,
) -> Vec<RenderedSourceRow> {
    let mut visible_rows = Vec::new();
    let kind = if m.impl_target.is_some() {
        "impl"
    } else if m.is_definition {
        "definition"
    } else {
        "usage"
    };

    // For usages, append the enclosing function/section if we can recover one.
    // Definitions and impls already are the named scope.
    let scope_suffix = if m.is_definition || m.impl_target.is_some() {
        String::new()
    } else {
        enclosing_scope_label(&m.path, m.line, sources)
            .map(|s| format!(" in {s}"))
            .unwrap_or_default()
    };

    // Show line range for definitions with def_range, otherwise just the line
    if m.is_definition {
        if let Some((start, end)) = m.def_range {
            let _ = write!(
                out,
                "\n\n### {}:{}-{} [{kind}]",
                rel(&m.path, scope),
                start,
                end
            );
        } else {
            let _ = write!(out, "\n\n### {}:{} [{kind}]", rel(&m.path, scope), m.line);
        }
    } else {
        let _ = write!(
            out,
            "\n\n### {}:{} [{kind}{scope_suffix}]",
            rel(&m.path, scope),
            m.line
        );
    }

    if let Some(declaration) = &m.declaration {
        if let Ok(content) = sources.read_text(&m.path) {
            let _ = writeln!(
                out,
                " {} @{}\n",
                result_name(m),
                declaration.position(&content)
            );
            let expanded =
                *expand_remaining > 0 && !(multi_file && expanded_files.contains(&m.path));
            let end = if expanded {
                m.def_range.map_or(m.line, |range| range.1)
            } else {
                declarations::lines_for(&content, &declaration.region().signature).1
            };
            render_ranked_regions(
                out,
                &mut visible_rows,
                m,
                &content,
                &[RankedRegion {
                    start: declaration.context_start(&content),
                    end,
                }],
                None,
                RANKED_TARGET_NONBLANK_CAP,
            );
            if expanded {
                if let FileType::Code(lang) = crate::lang::detect_file_type(&m.path) {
                    append_match_connections(m, &content, lang, bloom, scope, out, sources);
                }
                *expand_remaining -= 1;
                expanded_files.insert(m.path.clone());
            }
            return visible_rows;
        }
    }
    // Markdown-heading defs (`def_weight == 30`): the heading text alone is
    // just the query, so the default preview slot would carry no information.
    // Inline the section body directly. Bypasses the --expand budget — this
    // is a fixed-cost preview, not the on-demand expand — and short-circuits
    // the rest of the function (no callees / siblings etc. apply to a
    // markdown section). On any read failure or empty body, fall through to
    // the existing outline / single-line preview branches.
    if m.is_definition && m.def_weight == 30 {
        if let Some((heading_line_1, section_end_1)) = m.def_range {
            if let Ok(content) = sources.read_text(&m.path) {
                let lines: Vec<&str> = content.lines().collect();
                // def_range is `(heading_line, section_end)` in 1-indexed
                // inclusive form (see `find_defs_markdown_buf`). The body
                // starts at the line *after* the heading. In 0-indexed
                // half-open form: `[heading_line_1 .. section_end_1)`.
                let body_start = heading_line_1 as usize;
                let body_end = (section_end_1 as usize).min(lines.len());
                if body_start < body_end {
                    let total_body_lines = body_end - body_start;
                    let take_n = total_body_lines.min(MARKDOWN_PREVIEW_MAX_LINES);
                    for (offset, line) in lines[body_start..body_start + take_n].iter().enumerate()
                    {
                        out.push_str(line);
                        out.push('\n');
                        visible_rows.push(RenderedSourceRow {
                            path: m.path.clone(),
                            line: heading_line_1 + 1 + offset as u32,
                            text: (*line).to_string(),
                        });
                    }
                    if total_body_lines > take_n {
                        let truncated = total_body_lines - take_n;
                        let _ = write!(
                            out,
                            "… ({truncated} more lines — pass --expand to see the full section)"
                        );
                    }
                    return visible_rows;
                }
            }
        }
    }

    // Check session dedup for definitions with def_range. The mtime
    // check ensures a post-edit search re-inlines the body rather than
    // pointing at stale line numbers.
    let current_mtime = std::fs::metadata(&m.path)
        .ok()
        .and_then(|md| md.modified().ok());
    let deduped = m.is_definition
        && m.def_range.is_some()
        && session
            .is_some_and(|s| current_mtime.is_some_and(|t| s.is_expanded(&m.path, m.line, t)));
    // expand_match always prints a range containing m.line (def_range starts
    // at m.line for definitions; the ±10 fallback for def_range: None / usages
    // trivially contains it), so the raw "-> [line] text" preview would
    // reprint m.text byte-for-byte inside the fence below. Only the
    // structural outline_context (neighboring entries' signatures, not the
    // matched line's own source) survives alongside an expansion.
    let fence_will_follow =
        *expand_remaining > 0 && !deduped && !(multi_file && expanded_files.contains(&m.path));

    // Skip outline for small files — the expanded code speaks for itself.
    if m.file_lines < 50 {
        if !fence_will_follow {
            let _ = write!(out, "\n-> [{}]   {}", m.line, m.text);
            visible_rows.push(RenderedSourceRow {
                path: m.path.clone(),
                line: m.line,
                text: m.text.clone(),
            });
        }
    } else if let Some(context) = outline_context_for_match(&m.path, m.line, sources) {
        out.push_str(&context);
    } else if !fence_will_follow {
        let _ = write!(out, "\n-> [{}]   {}", m.line, m.text);
        visible_rows.push(RenderedSourceRow {
            path: m.path.clone(),
            line: m.line,
            text: m.text.clone(),
        });
    }

    if *expand_remaining > 0 {
        if deduped {
            if let Some((start, end)) = m.def_range {
                let _ = write!(
                    out,
                    "\n\n[shown earlier] {}:{}-{} {}",
                    rel(&m.path, scope),
                    start,
                    end,
                    m.text
                );
            }
        } else {
            let skip = multi_file && expanded_files.contains(&m.path);
            if !skip {
                if let Some(expanded) = expand_match(m, scope, sources) {
                    let ExpandedMatch {
                        code,
                        content,
                        mut source_rows,
                    } = expanded;
                    if m.is_definition && m.def_range.is_some() {
                        if let (Some(s), Some(t)) = (session, current_mtime) {
                            s.record_expand(&m.path, m.line, t);
                        }
                    }

                    let file_type = crate::lang::detect_file_type(&m.path);
                    let mut skip_lines = strip::strip_noise(&content, &m.path, m.def_range);

                    if let Some((def_start, def_end)) = m.def_range {
                        if let crate::types::FileType::Code(_) = file_type {
                            if let Some(keep) = truncate::select_diverse_lines(
                                &content,
                                def_start,
                                def_end,
                                boost_query(m),
                            ) {
                                let keep_set: HashSet<u32> = keep.into_iter().collect();
                                for ln in def_start..=def_end {
                                    if !keep_set.contains(&ln) {
                                        skip_lines.insert(ln);
                                    }
                                }

                                // Record token savings: full def body vs kept lines.
                                // Measure raw line content (bytes + 1 for newline each),
                                // independent of any surrounding formatting.
                                if let Some(sess) = session {
                                    let body_lines: Vec<&str> = content
                                        .lines()
                                        .enumerate()
                                        .filter_map(|(i, l)| {
                                            let ln = (i as u32) + 1;
                                            if ln >= def_start && ln <= def_end {
                                                Some(l)
                                            } else {
                                                None
                                            }
                                        })
                                        .collect();
                                    let full_bytes: u64 =
                                        body_lines.iter().map(|l| l.len() as u64 + 1).sum();
                                    let kept_bytes: u64 = body_lines
                                        .iter()
                                        .enumerate()
                                        .filter_map(|(i, l)| {
                                            let ln = def_start + i as u32;
                                            if keep_set.contains(&ln) {
                                                Some(l.len() as u64 + 1)
                                            } else {
                                                None
                                            }
                                        })
                                        .sum();
                                    sess.record_savings(
                                        crate::types::estimate_tokens(full_bytes),
                                        crate::types::estimate_tokens(kept_bytes),
                                    );
                                }
                            }
                        }
                    }

                    let stripped_code = if skip_lines.is_empty() {
                        code
                    } else {
                        filter_code_lines(&code, &skip_lines)
                    };
                    if !skip_lines.is_empty() {
                        source_rows.retain(|row| !skip_lines.contains(&row.line));
                    }

                    out.push('\n');
                    out.push_str(&stripped_code);
                    visible_rows.extend(source_rows);

                    if m.is_definition && m.def_range.is_some() {
                        if let FileType::Code(lang) = file_type {
                            append_match_connections(m, &content, lang, bloom, scope, out, sources);
                        }
                    }

                    *expand_remaining -= 1;
                    expanded_files.insert(m.path.clone());
                }
            }
        }
    }
    visible_rows
}

// Keep the existing connection mechanism separate from declaration discovery.
fn append_match_connections(
    m: &Match,
    content: &str,
    lang: crate::types::Lang,
    bloom: &crate::index::bloom::BloomFilterCache,
    scope: &Path,
    out: &mut String,
    sources: &OperationSources,
) {
    let connections = callees::connections(
        &m.path,
        content,
        lang,
        m.def_range,
        m.declaration.as_ref(),
        bloom,
        sources,
    );
    let mut parents = Vec::new();
    let mut remaining = 8usize;
    for connection in connections.iter().take(8) {
        let _ = write!(
            out,
            "\n\n-- call evidence: {} --\n  {}\n  {}",
            connection.origin,
            connection.site.caption(content),
            connection.basis
        );
        for candidate in connection.candidates.iter().take(remaining) {
            let _ = write!(
                out,
                "\n  declaration candidate: {}  {}:{}-{}",
                candidate.name,
                rel(&candidate.file, scope),
                candidate.start_line,
                candidate.end_line
            );
            if let Some(declaration) = &candidate.declaration {
                let (start, end, _) = declaration.key();
                let _ = write!(out, " bytes {start}..{end}");
            }
            parents.push(candidate.clone());
        }
        let shown = connection.candidates.len().min(remaining);
        remaining -= shown;
        if shown < connection.candidates.len() {
            let _ = write!(
                out,
                "\n  {} declaration alternatives not shown",
                connection.candidates.len() - shown
            );
        } else if connection.candidates.is_empty() {
            out.push_str("\n  no declaration candidate established; binding coverage incomplete");
        }
    }
    if connections.len() > 8 {
        let _ = write!(out, "\n{} call sites not shown", connections.len() - 8);
    }
    let mut remaining = 15usize;
    if !parents.is_empty() {
        out.push_str("\nCandidate-body expansion is capped at 15 call sites; further bodies may be unexamined.");
    }
    for node in callees::candidate_connections(parents, bloom, sources, 15) {
        let Some(content) = sources.retained_text(&node.declaration.file) else {
            continue;
        };
        if node.calls.is_empty() {
            continue;
        }
        let _ = write!(
            out,
            "\n\n-- candidate body: {}  {}:{}-{}; not a resolved call chain --",
            node.declaration.name,
            rel(&node.declaration.file, scope),
            node.declaration.start_line,
            node.declaration.end_line
        );
        if node.calls.len() < node.total_calls {
            let _ = write!(
                out,
                "\n  {} of {} candidate-body call sites shown",
                node.calls.len(),
                node.total_calls
            );
        }
        for connection in &node.calls {
            let _ = write!(
                out,
                "\n  {}: {}\n    {}",
                connection.origin,
                connection.site.caption(&content),
                connection.basis
            );
            for candidate in connection.candidates.iter().take(remaining) {
                let _ = write!(
                    out,
                    "\n    declaration candidate: {}  {}:{}-{}",
                    candidate.name,
                    rel(&candidate.file, scope),
                    candidate.start_line,
                    candidate.end_line
                );
                if let Some(declaration) = &candidate.declaration {
                    let (start, end, _) = declaration.key();
                    let _ = write!(out, " bytes {start}..{end}");
                }
            }
            let shown = connection.candidates.len().min(remaining);
            remaining -= shown;
            if shown < connection.candidates.len() {
                let _ = write!(
                    out,
                    "\n    {} declaration alternatives not shown",
                    connection.candidates.len() - shown
                );
            }
            if connection.candidates.is_empty() {
                out.push_str(
                    "\n    no declaration candidate established; binding coverage incomplete",
                );
            }
        }
    }
    let Some(range) = m.def_range else { return };
    let references = siblings::extract_sibling_references(content, lang, range)
        .into_iter()
        .filter(|name| m.def_name.as_ref() != Some(name))
        .collect::<Vec<_>>();
    if references.is_empty() {
        return;
    }
    if let Some(declaration) = &m.declaration {
        let siblings = declaration
            .siblings()
            .filter(|region| {
                region
                    .name
                    .as_ref()
                    .is_some_and(|name| references.contains(name))
            })
            .collect::<Vec<_>>();
        if !siblings.is_empty() {
            out.push_str("\n\n-- siblings --");
        }
        for sibling in siblings {
            let (start, end) = declarations::lines_for(content, &sibling.declaration);
            let _ = write!(
                out,
                "\n  {}  {}:{}-{}  {}",
                sibling.name.as_deref().unwrap(),
                rel(&m.path, scope),
                start,
                end,
                &content[sibling.signature.clone()]
            );
        }
    } else {
        let entries = crate::lang::outline::get_outline_entries(content, lang);
        if let Some(parent) = siblings::find_parent_entry(&entries, m.line) {
            let resolved = siblings::resolve_siblings(&references, &parent.children);
            if !resolved.is_empty() {
                out.push_str("\n\n-- siblings --");
            }
            for sibling in resolved {
                let _ = write!(
                    out,
                    "\n  {}  {}:{}-{}  {}",
                    sibling.name,
                    rel(&m.path, scope),
                    sibling.start_line,
                    sibling.end_line,
                    sibling.signature
                );
            }
        }
    }
}

/// Format a symbol/content search result.
/// When an outline cache is available, wraps each match in the file's outline context.
/// When `expand > 0`, the top N matches inline actual code (def body or ±10 lines).
/// When there are >5 matches, groups them into facets for easier navigation.
/// Prefer source languages over their compiled equivalents.
/// Higher value = more likely to be the original source.
fn source_priority(path: &Path) -> u8 {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "ts" | "tsx" => 10,
        "rs" | "go" | "py" | "rb" | "java" | "kt" | "scala" | "swift" | "c" | "cpp" | "h"
        | "cs" | "php" => 9,
        "js" | "jsx" | "mjs" | "cjs" => 7,
        _ => 3,
    }
}

/// Find a basename-matching candidate among already-collected search matches.
fn find_basename_candidate(matches: &[Match], query_lower: &str) -> Option<PathBuf> {
    let mut candidate: Option<&Path> = None;
    let mut best_priority: u8 = 0;

    for m in matches {
        let Some(stem) = m.path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if stem.to_ascii_lowercase() != query_lower {
            continue;
        }
        let ext = m.path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let is_code = matches!(
            ext,
            "rs" | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "go"
                | "py"
                | "rb"
                | "java"
                | "c"
                | "cpp"
                | "h"
                | "cs"
                | "swift"
                | "kt"
                | "scala"
                | "php"
        );
        if !is_code {
            if candidate.is_none() {
                candidate = Some(&m.path);
            }
            continue;
        }
        let prio = source_priority(&m.path);
        if prio > best_priority {
            best_priority = prio;
            candidate = Some(&m.path);
        }
    }

    candidate.map(Path::to_path_buf)
}

/// Format a token count into a human-readable string (e.g. "~1.2k" or "~743").
pub(crate) fn format_token_count(tokens: u64) -> String {
    if tokens >= 1000 {
        format!("~{}.{}k", tokens / 1000, (tokens % 1000) / 100)
    } else {
        format!("~{tokens}")
    }
}

/// Fallback: lightweight directory walk to find a basename-matching file
/// when it didn't survive ranking/truncation in the match set.
fn find_basename_fallback(scope: &Path, query_lower: &str, sources: &OperationSources) -> Option<PathBuf> {
    if sources.corpus_root().is_some() {
        return sources.scoped_files(scope, &crate::walk::WalkOptions::default()).ok()?.paths.into_iter()
            .filter(|path| path.strip_prefix(scope).is_ok_and(|relative| relative.components().count() <= 6)
                && path.file_stem().and_then(|stem| stem.to_str()).is_some_and(|stem| stem.to_ascii_lowercase() == query_lower)
                && source_priority(path) > 0)
            .max_by_key(|path| source_priority(path));
    }
    let mut candidate: Option<PathBuf> = None;
    let mut best_priority: u8 = 0;

    let walker = ignore::WalkBuilder::new(scope)
        .follow_links(true)
        .same_file_system(true) // Stop at mount boundaries (NFS, external volumes).
        .hidden(true)
        .git_ignore(true)
        .max_depth(Some(6))
        .build();

    for entry in walker.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if stem.to_ascii_lowercase() != *query_lower {
            continue;
        }
        let prio = source_priority(path);
        if prio > best_priority {
            best_priority = prio;
            candidate = Some(path.to_path_buf());
        }
    }

    candidate
}

/// When a file's basename (without extension) matches the query exactly,
/// return a compact outline of that file. Helps concept queries like `cli`
/// surface the file `cli.ts` with structural context instead of scattered text matches.
///
/// Scans the already-collected search results first (fast path), falls back to
/// a lightweight directory walk when the basename file didn't survive truncation.
fn basename_file_outline(
    query: &str,
    matches: &[Match],
    scope: &Path,
    sources: &OperationSources,
) -> Option<String> {
    let query_lower = query.to_ascii_lowercase();

    // Only trigger for short single-word queries (concept/file-level intent)
    if query_lower.is_empty() || query.contains(' ') || query.contains("::") {
        return None;
    }

    // Find the best candidate among existing matches whose basename matches the query
    let matched_path = find_basename_candidate(matches, &query_lower)
        .or_else(|| find_basename_fallback(scope, &query_lower, sources))?;

    // Read file and generate outline
    let content = sources.read_text(&matched_path).ok()?;
    let file_type = crate::lang::detect_file_type(&matched_path);
    let outline = crate::read::outline::generate(
        &matched_path,
        file_type,
        &content,
        content.as_bytes(),
        false,
    );

    if outline.trim().is_empty() {
        return None;
    }

    let rel_path = rel(&matched_path, scope);
    let line_count = content.lines().count();
    Some(format!(
        "## File overview: {rel_path} ({line_count} lines)\n{outline}"
    ))
}

pub(crate) fn format_search_result(
    result: &SearchResult,
    cache: &OutlineCache,
    session: Option<&Session>,
    bloom: &crate::index::bloom::BloomFilterCache,
    expand: usize,
    budget: Option<u64>,
) -> Result<String, TilthError> {
    format_search_result_typed(result, cache, session, bloom, expand, budget)
        .map(|formatted| formatted.text)
}

const RANKED_TARGET_NONBLANK_CAP: usize = 150;
const RANKED_SOURCE_LINE_BYTES: usize = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RankedRegion {
    start: u32,
    end: u32,
}

fn append_live_hierarchy(
    out: &mut String,
    rows: &mut Vec<RenderedSourceRow>,
    matched: &Match,
    content: &str,
    allowance: &mut usize,
    reserved_lines: &HashSet<u32>,
) {
    let Some(declaration) = &matched.declaration else {
        return;
    };
    let ancestors = declaration.ancestors();
    if !ancestors.is_empty() {
        let lines = content.lines().collect::<Vec<_>>();
        let (target_start, target_end) =
            declarations::lines_for(content, &declaration.region().signature);
        let displayed = |line| {
            rows.iter()
                .any(|row| row.path == matched.path && row.line == line)
        };
        let nonblank = |line: u32| {
            lines
                .get(line.saturating_sub(1) as usize)
                .is_some_and(|source| !source.trim().is_empty())
        };
        let required = reserved_lines
            .iter()
            .filter(|&&line| !displayed(line) && nonblank(line))
            .count();
        let mut remaining = allowance.saturating_sub(required);
        let mut selected = Vec::new();
        let mut headers = BTreeMap::new();
        let mut omitted = Vec::new();
        // Reserve the target first, then admit whole headers nearest-first.
        // Labels always retain every lexical owner, including omitted headers.
        for ancestor in ancestors.iter().rev() {
            let span = declarations::Declaration::hierarchy_signature(ancestor);
            let (start, end) = declarations::lines_for(content, &span);
            let undisplayable = lines
                [start.saturating_sub(1) as usize..(end as usize).min(lines.len())]
                .iter()
                .any(|source| source.len() > RANKED_SOURCE_LINE_BYTES);
            let candidate = (start..=end)
                .filter(|line| {
                    !(*line >= target_start && *line <= target_end)
                        && !displayed(*line)
                        && !selected.contains(line)
                })
                .collect::<Vec<_>>();
            let cost = candidate.iter().filter(|&&line| nonblank(line)).count();
            if !undisplayable && cost <= remaining {
                remaining -= cost;
                *allowance -= cost;
                if candidate.contains(&start) {
                    headers.entry(start).or_insert(RankedRegion {
                        start,
                        end: declarations::lines_for(content, &ancestor.declaration).1,
                    });
                }
                selected.extend(candidate);
            } else {
                omitted.push((ancestor, start, end, undisplayable));
            }
        }
        let _ = writeln!(
            out,
            "enclosing source: {}",
            ancestors
                .iter()
                .map(|region| {
                    let label = declarations::label(region);
                    if omitted
                        .iter()
                        .any(|(ancestor, _, _, _)| ancestor.id == region.id)
                    {
                        let (start, end) = declarations::lines_for(content, &region.declaration);
                        format!("{label} [{start}-{end}]")
                    } else {
                        label
                    }
                })
                .collect::<Vec<_>>()
                .join(" > ")
        );
        selected.sort_unstable();
        for line in selected {
            if let Some(source) = lines.get(line.saturating_sub(1) as usize) {
                push_ranked_source_line(
                    out,
                    rows,
                    &matched.path,
                    line,
                    source,
                    headers.get(&line).copied(),
                );
            }
        }
        for (ancestor, start, end, undisplayable) in omitted.into_iter().rev() {
            if undisplayable {
                let span = declarations::Declaration::hierarchy_signature(ancestor);
                let _ = writeln!(out, "[{start}-{end}: enclosing {} signature undisplayable at the {RANKED_SOURCE_LINE_BYTES}-byte per-line safeguard; UTF-8 bytes {}..{}]", declarations::label(ancestor), span.start, span.end);
            } else {
                let _ = writeln!(out, "[{start}-{end}: enclosing {} header omitted at the existing target allowance; target signature takes priority]", declarations::label(ancestor));
            }
        }
    }
    if declaration.region().recovered {
        out.push_str(
            "Source region intersects parser recovery; structural details are uncertain.\n",
        );
    } else if declaration.partial_file() {
        out.push_str(
            "Partial syntax elsewhere in this file; this declaration is outside recovery.\n",
        );
    }
}

fn exact_primary_definition(result: &SearchResult) -> Option<&Match> {
    let mut definitions = result.matches.iter().filter(|matched| {
        matched.is_definition
            && matched.impl_target.is_none()
            && matched.exact
            && matched.def_name.as_deref() == Some(result.query.as_str())
    });
    let definition = definitions.next()?;
    if definitions.next().is_some() || result.facet_totals.definitions != 1 {
        return None;
    }
    Some(definition)
}

fn find_outline_entry<'a>(
    entries: &'a [crate::types::OutlineEntry],
    start: u32,
    end: u32,
    name: Option<&str>,
) -> Option<&'a crate::types::OutlineEntry> {
    for entry in entries {
        if entry.start_line == start
            && entry.end_line == end
            && name.is_none_or(|name| entry.name == name)
        {
            return Some(entry);
        }
        if let Some(found) = find_outline_entry(&entry.children, start, end, name) {
            return Some(found);
        }
    }
    None
}

fn rust_impl_targets_symbol(entry_name: &str, symbol: &str) -> bool {
    let Some(target) = entry_name.strip_prefix("impl ") else {
        return false;
    };
    let base = target
        .split('<')
        .next()
        .unwrap_or(target)
        .trim()
        .rsplit("::")
        .next()
        .unwrap_or(target);
    base == symbol
}

fn ranked_regions(
    matched: &Match,
    content: &str,
    lang: crate::types::Lang,
) -> (Vec<RankedRegion>, String) {
    let Some((start, end)) = matched.def_range else {
        return (Vec::new(), "definition".into());
    };
    if let Some(declaration) = &matched.declaration {
        return (
            vec![RankedRegion {
                start: declaration.context_start(content),
                end,
            }],
            declarations::label(declaration.region()),
        );
    }
    let entries = crate::lang::outline::get_outline_entries(content, lang);
    let primary = find_outline_entry(&entries, start, end, matched.def_name.as_deref());
    let mut regions = vec![RankedRegion { start, end }];
    let mut kind = primary.map_or_else(
        || "definition".into(),
        |entry| entry.kind.as_label().to_string(),
    );

    if lang == crate::types::Lang::Rust
        && primary.is_some_and(|entry| {
            matches!(
                entry.kind,
                crate::types::OutlineKind::Struct
                    | crate::types::OutlineKind::Class
                    | crate::types::OutlineKind::Enum
            )
        })
    {
        for entry in &entries {
            if entry.kind == crate::types::OutlineKind::Module
                && rust_impl_targets_symbol(&entry.name, &result_name(matched))
            {
                regions.push(RankedRegion {
                    start: entry.start_line,
                    end: entry.end_line,
                });
            }
        }
        regions.sort_by_key(|region| (region.start, region.end));
        regions.dedup();
        if regions.len() > 1 {
            kind.push_str(" + impl blocks");
        }
    }
    (regions, kind)
}

fn result_name(matched: &Match) -> String {
    matched
        .def_name
        .clone()
        .unwrap_or_else(|| matched.text.trim().to_string())
}

fn ranked_line_text(source: &str) -> (String, bool) {
    if source.len() <= RANKED_SOURCE_LINE_BYTES {
        return (source.to_string(), false);
    }
    (
        format!(
            "{}… [line clipped at 250-token safeguard]",
            crate::types::truncate_str(source, RANKED_SOURCE_LINE_BYTES)
        ),
        true,
    )
}

fn push_ranked_source_line(
    output: &mut String,
    rows: &mut Vec<RenderedSourceRow>,
    path: &Path,
    line_number: u32,
    source: &str,
    region: Option<RankedRegion>,
) {
    if rows
        .iter()
        .any(|row| row.path == path && row.line == line_number && row.text == source)
    {
        return;
    }
    let (display, clipped) = ranked_line_text(source);
    if let Some(region) = region.filter(|region| region.start < region.end) {
        let _ = writeln!(output, "[{}-{}]: {display}", region.start, region.end);
    } else {
        let _ = writeln!(output, "{line_number}: {display}");
    }
    if !clipped {
        rows.push(RenderedSourceRow {
            path: path.to_path_buf(),
            line: line_number,
            text: source.to_string(),
        });
    }
}

fn nonblank_count(lines: &[&str], region: RankedRegion) -> usize {
    let start = region.start.saturating_sub(1) as usize;
    let end = (region.end as usize).min(lines.len());
    lines[start..end]
        .iter()
        .filter(|line| !line.trim().is_empty())
        .count()
}

/// Return a complete-target expansion only after rendering. The caller records
/// it after page fitting; rendering a subsequently refused card is not delivery.
fn render_ranked_regions(output: &mut String, rows: &mut Vec<RenderedSourceRow>, matched: &Match,
    content: &str, regions: &[RankedRegion], session: Option<&Session>, nonblank_cap: usize) -> Option<std::time::SystemTime> {
    render_ranked_regions_with_progress(output, rows, matched, content, regions, session, nonblank_cap, None)
}

fn render_ranked_regions_with_progress(
    output: &mut String,
    rows: &mut Vec<RenderedSourceRow>,
    matched: &Match,
    content: &str,
    regions: &[RankedRegion],
    session: Option<&Session>,
    nonblank_cap: usize,
    progress: Option<&continuation::Progress>,
) -> Option<std::time::SystemTime> {
    // Preserve legacy collapse only where its line key cannot merge source identities.
    let session = session.filter(|_| {
        matched
            .declaration
            .as_ref()
            .is_none_or(|declaration| declaration.has_unique_start_line(content))
    });
    let lines: Vec<&str> = content.lines().collect();
    let signature = matched
        .declaration
        .as_ref()
        .filter(|declaration| {
            use crate::tsjs_source::Kind;
            let region = declaration.region();
            // A whole initializer/type value is not an oversized callable signature.
            region.body.is_some()
                || matches!(
                    region.kind,
                    Kind::Function | Kind::Method | Kind::MethodSignature
                )
        })
        .map(|declaration| {
            let (start, end) = declarations::lines_for(content, &declaration.region().signature);
            RankedRegion { start, end }
        })
        .or_else(|| {
            let (start, end) = matched
                .def_range
                .filter(|_| matched.is_definition && matched.declaration.is_none())?;
            let end = scope::signature_end_line(&matched.path, content, start, end)?;
            Some(RankedRegion { start, end })
        });
    // Only a full selected class card gets an inventory; compact declaration
    // snippets sharing this renderer must not expand into unrelated members.
    let mut inventory_unavailable = false;
    let inventory = matched.declaration.as_ref().and_then(|declaration| {
        let class = declaration.class_region()?;
        let full = declarations::lines_for(content, &class.declaration);
        if !regions
            .iter()
            .any(|region| region.start <= full.0 && region.end >= full.1)
        {
            return None;
        }
        let FileType::Code(lang) = crate::lang::detect_file_type(&matched.path) else {
            return None;
        };
        let headers = declaration.class_inventory(content, lang);
        inventory_unavailable = headers.is_none();
        headers.map(|headers| {
            headers
                .into_iter()
                .map(|(member, header)| {
                    let (start, end) = declarations::lines_for(content, &header);
                    let (full_start, full_end) =
                        declarations::lines_for(content, &member.region().declaration);
                    (
                        member,
                        RankedRegion { start, end },
                        RankedRegion {
                            start: full_start,
                            end: full_end,
                        },
                    )
                })
                .collect::<Vec<_>>()
        })
    });
    if inventory_unavailable {
        output.push_str("Class declaration inventory unavailable: some member boundaries are not represented; bounded structural source follows.\n");
    }
    let reserved_lines = if let Some(headers) = &inventory {
        headers
            .iter()
            .flat_map(|(_, header, _)| header.start..=header.end)
            .collect::<HashSet<_>>()
    } else {
        matched
            .declaration
            .as_ref()
            .map(|declaration| {
                let (start, end) =
                    declarations::lines_for(content, &declaration.region().signature);
                (start..=end).collect::<HashSet<_>>()
            })
            .unwrap_or_default()
    };
    let mut nonblank_cap = nonblank_cap;
    append_live_hierarchy(
        output,
        rows,
        matched,
        content,
        &mut nonblank_cap,
        &reserved_lines,
    );
    if let Some(signature) = signature {
        if lines
            [signature.start.saturating_sub(1) as usize..(signature.end as usize).min(lines.len())]
            .iter()
            .any(|source| source.len() > RANKED_SOURCE_LINE_BYTES)
        {
            let bytes = matched
                .declaration
                .as_ref()
                .map_or(String::new(), |declaration| {
                    let span = &declaration.region().signature;
                    format!("; UTF-8 bytes {}..{}", span.start, span.end)
                });
            let _ = writeln!(output, "[{}-{}: signature undisplayable at the {RANKED_SOURCE_LINE_BYTES}-byte per-line safeguard{bytes}; target body not expanded]", signature.start, signature.end);
            return None;
        }
        let required = nonblank_count(&lines, signature);
        if required > nonblank_cap {
            let _ = writeln!(output, "Signature-only exception: {required} nonblank signature lines retained; non-signature allowance unchanged.");
        }
    }
    let current_mtime = std::fs::metadata(&matched.path)
        .ok()
        .and_then(|metadata| metadata.modified().ok());
    let seen = session.is_some_and(|state| {
        current_mtime.is_some_and(|mtime| state.is_expanded(&matched.path, matched.line, mtime))
    });
    // Inventory governs first look, not a new native-session redisplay policy.
    if let Some(headers) = inventory.filter(|_| !seen) {
        let key = continuation::GroupKey::Target(lanes::target_key(matched));
        let delivered = |line| progress.is_some_and(|prior| prior.contains(&key, &matched.path, line));
        // A shared physical row may begin another multi-line member header.
        // Merge overlapping headers transitively so selecting one never clips its neighbor.
        let mut ordered = headers.iter().map(|(_, header, _)| *header).collect::<Vec<_>>();
        ordered.sort_by_key(|header| (header.start, header.end));
        let mut units: Vec<RankedRegion> = Vec::new();
        for header in ordered {
            if let Some(last) = units.last_mut().filter(|last| header.start <= last.end) {
                last.end = last.end.max(header.end);
            } else { units.push(header); }
        }
        let class_header = headers[0].1;
        let mut selected = (class_header.start..=class_header.end).collect::<HashSet<_>>();
        let mut remaining = nonblank_cap.saturating_sub(nonblank_count(&lines, class_header));
        let mut selected_member = false;
        for unit in units {
            if (unit.start..=unit.end).all(|line| delivered(line) || lines.get(line.saturating_sub(1) as usize).is_none_or(|text| text.trim().is_empty())) { continue; }
            let cost = (unit.start..=unit.end).filter(|line| !selected.contains(line)
                && lines.get(line.saturating_sub(1) as usize).is_some_and(|text| !text.trim().is_empty())).count();
            // Retain one complete pending header even below its row allowance,
            // just like a standalone signature; never turn the whole inventory into a floor.
            if cost > remaining && selected_member { break; }
            selected.extend(unit.start..=unit.end);
            remaining = remaining.saturating_sub(cost);
            selected_member |= headers.iter().skip(1).any(|(_, header, _)| header.start <= unit.end && unit.start <= header.end);
        }
        // Only an unpaged first look can spend spare rows on bodies. Otherwise
        // body filling could reintroduce part of a deferred/already delivered header.
        let mut optional = if progress.is_none() && reserved_lines.iter().all(|line| selected.contains(line)) { remaining } else { 0 };
        for region in regions {
            for line in region.start..=region.end {
                if selected.contains(&line) {
                    continue;
                }
                let Some(source) = lines.get(line.saturating_sub(1) as usize) else {
                    continue;
                };
                if optional > 0 {
                    selected.insert(line);
                    optional -= usize::from(!source.trim().is_empty());
                }
            }
        }
        let mut omitted = None;
        let mut complete = true;
        let mut undisplayable = false;
        // Refuse by member identity, then union physical rows. A safe row may
        // finish a refused member and also carry a neighboring declaration.
        let mut refused_rows = HashSet::new();
        let mut retained_member_rows = HashSet::new();
        for (index, (member, header, full)) in headers.iter().enumerate() {
            if (header.start..=header.end).any(|line| {
                lines
                    .get(line.saturating_sub(1) as usize)
                    .is_some_and(|source| source.len() > RANKED_SOURCE_LINE_BYTES)
            }) {
                refused_rows.extend(full.start..=full.end);
                let _ = writeln!(output, "[{}-{}: {} at {} undisplayable at the {RANKED_SOURCE_LINE_BYTES}-byte per-line safeguard]", full.start, full.end, declarations::label(member.region()), member.position(content));
                undisplayable = true;
            } else if index != 0 {
                retained_member_rows
                    .extend((full.start..=full.end).filter(|line| selected.contains(line)));
            }
        }
        selected.retain(|line| !refused_rows.contains(line) || retained_member_rows.contains(line));
        let compacted = regions
            .iter()
            .any(|region| (region.start..=region.end).any(|line| !selected.contains(&line)));
        if compacted {
            let _ = writeln!(
                output,
                "Class declaration inventory{}; body and context allowance unchanged.",
                if undisplayable { " incomplete" } else { "" }
            );
        }
        let omission_reason = if undisplayable {
            "omitted for budget or per-line safeguard"
        } else {
            "omitted for budget"
        };
        for region in regions {
            for line in region.start..=region.end {
                if !selected.contains(&line) {
                    omitted.get_or_insert(line);
                    complete = false;
                    continue;
                }
                if let Some(start) = omitted.take() {
                    let _ = writeln!(output, "[{start}-{}: {omission_reason}]", line - 1);
                }
                let Some(source) = lines.get(line.saturating_sub(1) as usize) else {
                    continue;
                };
                let header = headers
                    .iter()
                    .filter(|(member, header, full)| {
                        header.start == line
                            && (member.key() == matched.declaration.as_ref().unwrap().key()
                                || (full.start..=full.end).any(|line| !selected.contains(&line)))
                    })
                    .map(|(_, _, full)| *full)
                    .max_by_key(|full| full.end);
                push_ranked_source_line(output, rows, &matched.path, line, source, header);
            }
            if let Some(start) = omitted.take() {
                let _ = writeln!(output, "[{start}-{}: {omission_reason}]", region.end);
            }
        }
        let mut same_row = BTreeMap::<u32, Vec<&declarations::Declaration>>::new();
        for (member, header, full) in headers.iter().skip(1) {
            same_row.entry(header.start).or_default().push(member);
            if full.end != header.start {
                same_row.entry(full.end).or_default().push(member);
            }
        }
        for (line, members) in same_row.iter().filter(|(_, members)| members.len() > 1) {
            let _ = writeln!(
                output,
                "Shared source row {line}: {}",
                members
                    .iter()
                    .map(|member| format!(
                        "{} at {}",
                        member
                            .region()
                            .name
                            .as_deref()
                            .unwrap_or("anonymous member"),
                        member.position(content)
                    ))
                    .collect::<Vec<_>>()
                    .join("; ")
            );
        }
        return (complete && !undisplayable && !seen && session.is_some())
            .then_some(current_mtime)
            .flatten();
    }
    let union = regions.len() > 1;
    let mut nonblank_rendered = 0usize;
    let mut complete = true;

    for region in regions {
        let mut region = *region;
        if let Some(signature) = signature {
            let start = signature.start;
            let signature_end = signature.end;
            if region.start < start
                && region.end >= signature_end
                && nonblank_count(
                    &lines,
                    RankedRegion {
                        start: region.start,
                        end: signature_end,
                    },
                ) > nonblank_cap
            {
                let _ = writeln!(
                    output,
                    "[{}-{}: leading comments omitted at the existing card allowance]",
                    region.start,
                    start - 1
                );
                region.start = start;
            }
        }
        let start_index = region.start.saturating_sub(1) as usize;
        let end_index = (region.end as usize).min(lines.len());
        if start_index >= end_index {
            continue;
        }
        let region_nonblank = nonblank_count(&lines, region);
        if signature.is_none() && seen && region_nonblank > 10 && region.end > region.start + 1 {
            push_ranked_source_line(
                output,
                rows,
                &matched.path,
                region.start,
                lines[start_index],
                Some(region),
            );
            let _ = writeln!(
                output,
                "[{}-{}: omitted already read this session]",
                region.start + 1,
                region.end - 1
            );
            push_ranked_source_line(
                output,
                rows,
                &matched.path,
                region.end,
                lines[end_index - 1],
                None,
            );
            continue;
        }

        for (offset, source) in lines[start_index..end_index].iter().enumerate() {
            let line_number = region.start + offset as u32;
            if matched.declaration.is_some()
                && rows.iter().any(|row| {
                    row.path == matched.path && row.line == line_number && row.text == *source
                })
            {
                let _ = writeln!(output, "[{line_number}: source already displayed above]");
                continue;
            }
            let nonblank = !source.trim().is_empty();
            let signature_line =
                signature.is_some_and(|span| span.start <= line_number && line_number <= span.end);
            // A complete signature may cross the card limit, but still consumes
            // its ordinary allowance. Its overflow cannot buy body/context rows.
            if nonblank && nonblank_rendered >= nonblank_cap && !signature_line {
                let remaining = region.end.saturating_sub(line_number) + 1;
                let _ = writeln!(
                    output,
                    "[{line_number}-{}]: remaining target — {remaining} lines omitted at the {nonblank_cap}-line card limit",
                    region.end
                );
                complete = false;
                break;
            }
            if seen
                && signature.is_some_and(|span| line_number > span.end)
                && region_nonblank > 10
                && line_number < region.end
                && nonblank_rendered < nonblank_cap
            {
                let _ = writeln!(
                    output,
                    "[{line_number}-{}: omitted already read this session]",
                    region.end - 1
                );
                push_ranked_source_line(
                    output,
                    rows,
                    &matched.path,
                    region.end,
                    lines[end_index - 1],
                    None,
                );
                nonblank_rendered += usize::from(!lines[end_index - 1].trim().is_empty());
                break;
            }
            let header = if let Some(declaration) = &matched.declaration {
                let start = declarations::line_at(content, declaration.region().declaration.start);
                (line_number == start).then_some(RankedRegion {
                    start,
                    end: region.end,
                })
            } else {
                (union && offset == 0).then_some(region)
            };
            push_ranked_source_line(output, rows, &matched.path, line_number, source, header);
            nonblank_rendered += usize::from(nonblank);
        }
        if !complete {
            break;
        }
        if union {
            output.push('\n');
        }
    }

    (complete && !seen && session.is_some())
        .then_some(current_mtime)
        .flatten()
}

#[cfg(test)]
fn append_ranked_references(output: &mut String, rows: &mut Vec<RenderedSourceRow>, result: &SearchResult,
    primary: Option<&Match>, cache: &OutlineCache, budget: u64) -> usize {
    append_ranked_references_with_progress(output, rows, result, primary, cache, budget, None, &mut continuation::Progress::default())
}

fn append_ranked_references_with_progress(
    output: &mut String,
    rows: &mut Vec<RenderedSourceRow>,
    result: &SearchResult,
    primary: Option<&Match>,
    _cache: &OutlineCache,
    budget: u64,
    progress: Option<&continuation::Progress>,
    receipt: &mut continuation::Progress,
) -> usize {
    let mut by_path: BTreeMap<String, Vec<&Match>> = BTreeMap::new();
    let mut excluded_tests = HashSet::new();
    for reference in &result.matches {
        // Multi-card rendering already owns declarations. A single exact card
        // can also expose other matching declarations through this support lane.
        if primary.is_none() && reference.is_definition {
            continue;
        }
        if primary.is_some_and(|matched| !crate::types::is_test_file(&matched.path))
            && crate::types::is_test_file(&reference.path)
        {
            excluded_tests.insert(reference.path.clone());
            continue;
        }
        by_path
            .entry(rel(&reference.path, &result.scope))
            .or_default()
            .push(reference);
    }
    let support_start = output.len();
    let mut started = false;
    let mut omitted = 0;
    for (path, references) in &mut by_path {
        references.sort_by_key(|reference| reference.line);
        // These are physical source mentions, not the identity-bearing edge rows.
        references.dedup_by_key(|reference| reference.line);
        let mut path_started = false;
        let mut prior_scope = Ok(None);
        for reference in references {
            let key = continuation::GroupKey::Mention(reference.path.clone(), reference.line);
            if progress.is_some_and(|progress| progress.complete.contains(&key)) { continue; }
            // Reuse emitted source, but retain a mixed-owner disclosure even when
            // another declaration already displayed this physical row.
            let already_displayed = rows.iter().any(|row| {
                row.path == reference.path
                    && row.line == reference.line
                    && row.text == reference.text
            });
            if reference.text.len() > RANKED_SOURCE_LINE_BYTES {
                omitted += 1;
                continue;
            }
            let current_scope = match crate::lang::detect_file_type(&reference.path) {
                FileType::Code(_) => enclosing_definition_with_sources(
                    &reference.path,
                    reference.line,
                    &result.sources,
                )
                .map(|scope| {
                    scope.map(|scope| (scope.start, scope.end, scope.kind.to_string(), scope.name))
                }),
                FileType::Markdown => Ok(markdown_enclosing_scope(&reference.path, reference.line, &result.sources)
                    .map(|name| (0, 0, "section".into(), name))),
                _ => Ok(None),
            };
            if already_displayed && current_scope.is_ok() {
                if !reference.is_definition { receipt.record(key, &[(reference.path.clone(), reference.line)], rows, progress); }
                continue;
            }
            let mut block = String::new();
            let mut block_rows = rows.clone();
            let prior_rows = block_rows.len();
            if !already_displayed && (!path_started || current_scope != prior_scope) {
                if let Ok(Some((0, _, kind, name))) = &current_scope {
                    let _ = writeln!(block, "{kind} {name}");
                } else if let Ok(Some((start, end, _, _))) = &current_scope {
                    let Ok(content) = result.sources.read_text(&reference.path) else {
                        omitted += 1;
                        continue;
                    };
                    let source_lines = content.lines().collect::<Vec<_>>();
                    let signature_end =
                        scope::declaration_end_line(&reference.path, &content, *start, *end)
                            .unwrap_or(*start);
                    let Some(signature) =
                        source_lines.get(start.saturating_sub(1) as usize..signature_end as usize)
                    else {
                        omitted += 1;
                        continue;
                    };
                    if signature
                        .iter()
                        .any(|line| line.len() > RANKED_SOURCE_LINE_BYTES)
                    {
                        omitted += 1;
                        continue;
                    }
                    for (offset, source) in signature.iter().enumerate() {
                        let line = *start + offset as u32;
                        let region = (line == *start).then_some(RankedRegion {
                            start: *start,
                            end: *end,
                        });
                        push_ranked_source_line(
                            &mut block,
                            &mut block_rows,
                            &reference.path,
                            line,
                            source,
                            region,
                        );
                    }
                } else if current_scope.is_err() {
                    let _ = writeln!(block, "{}", scope::MIXED_SCOPES);
                } else {
                    let _ = writeln!(block, "top-level");
                }
            }
            if already_displayed {
                let _ = writeln!(
                    block,
                    "line {}: {}; source displayed above",
                    reference.line,
                    scope::MIXED_SCOPES
                );
            } else {
                push_ranked_source_line(
                    &mut block,
                    &mut block_rows,
                    &reference.path,
                    reference.line,
                    &reference.text,
                    None,
                );
            }
            let block = format!(
                "{}{}{}",
                if started {
                    ""
                } else if primary.is_some() {
                    "\nreferences:\n"
                } else {
                    "\n\nexact non-definition mentions (fallback):\n"
                },
                if path_started {
                    String::new()
                } else {
                    format!("  {path}:\n")
                },
                block
                    .lines()
                    .map(|line| format!("    {line}\n"))
                    .collect::<String>()
            );
            let remaining =
                budget.saturating_sub(estimate_tokens((output.len() - support_start) as u64));
            // Fit the declaration and mention together. A rejected block must
            // not seed coverage or suppress a later block's complete signature.
            if !alloc::select_within_budget(&[(0, estimate_tokens(block.len() as u64))], remaining)
                [0]
            {
                omitted += 1;
                continue;
            }
            output.push_str(&block);
            rows.extend(block_rows.into_iter().skip(prior_rows));
            if !reference.is_definition { receipt.record(key, &[(reference.path.clone(), reference.line)], rows, progress); }
            prior_scope = current_scope;
            path_started = true;
            started = true;
        }
    }
    if !excluded_tests.is_empty() {
        let _ = writeln!(
            output,
            "\ntests: {} matching file(s) excluded by default",
            excluded_tests.len()
        );
    }
    if omitted > 0 {
        let _ = writeln!(output, "\nreferences: {omitted} source mention/declaration block(s) omitted by the support budget or source-row safeguards");
    }
    omitted
}

fn enclosing_declaration_block(
    path: &Path,
    content: &str,
    start: u32,
    end: u32,
    covered: &[&RenderedSourceRow],
) -> (String, Vec<RenderedSourceRow>) {
    enclosing_declaration_block_at(path, content, start, end, covered, None)
}

fn enclosing_declaration_block_at(
    path: &Path,
    content: &str,
    start: u32,
    end: u32,
    covered: &[&RenderedSourceRow],
    byte: Option<usize>,
) -> (String, Vec<RenderedSourceRow>) {
    let lines: Vec<_> = content.lines().collect();
    let mut output = String::new();
    let mut rows: Vec<RenderedSourceRow> = Vec::new();
    for parent in scope::enclosing_containers_at(path, content, start, byte) {
        if parent.start > start || parent.end < end || (parent.start == start && parent.end == end)
        {
            continue;
        }
        let declaration_end = scope::declaration_end_line(path, content, parent.start, parent.end)
            .unwrap_or(parent.start);
        // Never emit later parent source before its nested target. A same-line
        // parent is already present in that target's complete physical row.
        for line in parent.start..=declaration_end.min(start.saturating_sub(1)) {
            let Some(source) = lines.get(line.saturating_sub(1) as usize) else {
                continue;
            };
            if covered
                .iter()
                .copied()
                .chain(rows.iter())
                .any(|prior| prior.path == path && prior.line == line && prior.text == *source)
            {
                continue;
            }
            let region = (line == parent.start).then_some(RankedRegion {
                start: parent.start,
                end: parent.end,
            });
            push_ranked_source_line(&mut output, &mut rows, path, line, source, region);
        }
    }
    (output, rows)
}

fn caller_requirements(caller: &crate::search::callers::CallerMatch) -> Vec<continuation::SourceLine> {
    // Completion owns the selected coherent context, not every line in an
    // enclosing function. A minimum record alone cannot earn this receipt.
    let (_, rows) = caller_lane_block(&[caller], None, false, &[]);
    let (start, end) = caller.caller_range.unwrap_or((caller.line, caller.line));
    if rows.is_empty()
        || scope::call_in_recovery_clause(
            &caller.path,
            &caller.content,
            caller.line,
            caller.site.as_ref().map(|site| site.expression.start),
        )
    {
        // A recovery/finalization owner's whole operation is the accepted
        // context. When that whole owner cannot fit its safeguards, the
        // withheld caption is not operation coverage, so the entire owner
        // range stays required: never degrade to signature/site because the
        // render came back empty.
        return required_source_lines(&caller.path, &caller.content, &[RankedRegion { start, end }]);
    }
    let signature_end = caller.site.as_ref().and_then(|site| site.owner_signature.as_ref())
        .map(|signature| declarations::lines_for(&caller.content, signature).1)
        .unwrap_or_else(|| scope::declaration_end_line(&caller.path, &caller.content, start, end).unwrap_or(end));
    // Undisplayable signature rows cannot disappear from completion requirements.
    let mut required = required_source_lines(&caller.path, &caller.content, &[RankedRegion { start, end: signature_end }]);
    required.extend(rows.into_iter().map(|row| (row.path, row.line)));
    required
}

fn callee_requirements(callee: &crate::search::callees::DeclarationCandidate, result: &SearchResult) -> Vec<continuation::SourceLine> {
    let Some(content) = result.sources.retained_text(&callee.file) else { return vec![(callee.file.clone(), callee.start_line)]; };
    let end = callee.declaration.as_ref().map_or_else(
        || scope::declaration_end_line(&callee.file, &content, callee.start_line, callee.end_line).unwrap_or(callee.end_line),
        |declaration| declarations::lines_for(&content, &declaration.region().signature).1);
    required_source_lines(&callee.file, &content, &[RankedRegion { start: callee.start_line, end }])
}

/// A recovery/finalization owner that cannot fit either per-line or whole-card
/// safeguards still exposes its identity/range, the precise reason and an
/// exact read selector, without claiming source authority for the body.
fn whole_recovery_withheld_caption(path: &Path, region: (u32, u32), reason: &str) -> String {
    let (start, end) = region;
    let location = if start == end {
        format!("{start}")
    } else {
        format!("{start}-{end}")
    };
    // Identity/range stays readable for the agent; the suggested read argument
    // is JSON-escaped so quote/backslash filenames cannot break the call.
    let selector = format!("{}:{location}", path.display());
    format!(
        "whole recovery context withheld: {}:{location} — {reason}. Exact source: read({{path: {}}})",
        path.display(),
        serde_json::to_string(&selector).expect("string rendering cannot fail")
    )
}

fn caller_lane_block(callers: &[&crate::search::callers::CallerMatch], session: Option<&Session>, whole: bool,
    covered: &[&RenderedSourceRow]) -> (String, Vec<RenderedSourceRow>) {
    let (text, rows, _) = caller_lane_block_progress(callers, session, whole, covered, false);
    (text, rows)
}

fn caller_lane_block_progress(
    callers: &[&crate::search::callers::CallerMatch],
    session: Option<&Session>,
    whole: bool,
    covered: &[&RenderedSourceRow],
    minimum: bool,
) -> (String, Vec<RenderedSourceRow>, bool) {
    let first = callers[0];
    // Recovery/finalization cannot be explained by the nearby call alone: the
    // same owner establishes its pending state, outcome and retry conditions.
    // Requirements call this renderer too, so an unfit operation stays pending.
    let recovery = callers.iter().any(|caller| scope::call_in_recovery_clause(
        &caller.path, &caller.content, caller.line, caller.site.as_ref().map(|site| site.expression.start)));
    let minimum = minimum && !recovery;
    let lines = first.content.lines().collect::<Vec<_>>();
    let caller_region = first.caller_range.unwrap_or((first.line, first.line));
    let mut region = caller_region;
    let parents = scope::enclosing_containers_at(
        &first.path,
        &first.content,
        first.line,
        first.site.as_ref().map(|site| site.expression.start),
    );
    // A callback's identity remains anonymous; its surrounding callable can supply context.
    if whole && first.calling_function == "<anonymous>" {
        if let Some(parent) = parents.iter().rev().find(|parent| {
            parent.kind == "function" && (parent.start < region.0 || parent.end > region.1)
        }) {
            region = (parent.start, parent.end);
        }
    }
    let whole = whole || recovery;
    let (start, end) = region;
    // Outer context is not a replacement identity. Annotate the callback's
    // existing physical row instead of emitting that source a second time.
    let callback_header = |line| {
        (caller_region != region && caller_region.0 != start && line == caller_region.0).then_some(
            RankedRegion {
                start: caller_region.0,
                end: caller_region.1,
            },
        )
    };
    let start_index = start.saturating_sub(1) as usize;
    let context_end = if !whole && first.calling_function == "<anonymous>" {
        scope::complete_statement_window(&first.path, &first.content, start, end).1
    } else {
        end
    };
    let end_index = (context_end as usize).min(lines.len());
    if start_index >= end_index {
        return (String::new(), Vec::new(), false);
    }
    let (mut output, parent_rows) = enclosing_declaration_block_at(
        &first.path,
        &first.content,
        start,
        end,
        covered,
        first.site.as_ref().map(|site| site.expression.start),
    );
    let mut rows = covered
        .iter()
        .map(|row| (**row).clone())
        .collect::<Vec<_>>();
    let prior = rows.len();
    rows.extend(parent_rows);
    let captions = callers
        .iter()
        .filter_map(|caller| {
            caller
                .site
                .as_ref()
                .map(|site| format!("{}\n", site.caption(&caller.content)))
        })
        .collect::<String>();
    let captions = if captions.is_empty()
        && (covered.iter().any(|row| {
            row.path == first.path && row.line == start && row.text == lines[start_index]
        }) || callers.iter().all(|caller| {
            covered.iter().any(|row| {
                row.path == caller.path && row.line == caller.line && row.text == caller.call_text
            })
        })) {
        let location = if start == end {
            start.to_string()
        } else {
            format!("{start}-{end}")
        };
        format!("{} [{location}]: source above\n", first.calling_function)
    } else {
        captions
    };
    if first.calling_function == "<anonymous>"
        && (caller_region.0 == caller_region.1
            || (caller_region != region && caller_region.0 == start))
    {
        let location = if caller_region.0 == caller_region.1 {
            caller_region.0.to_string()
        } else {
            format!("{}-{}", caller_region.0, caller_region.1)
        };
        let _ = writeln!(output, "<anonymous> [{location}]");
    }
    let signature_end = first
        .site
        .as_ref()
        .and_then(|site| site.owner_signature.as_ref())
        .filter(|_| caller_region == region)
        .map(|signature| declarations::lines_for(&first.content, signature).1)
        .unwrap_or_else(|| {
            scope::declaration_end_line(&first.path, &first.content, start, end).unwrap_or(end)
        });
    if lines[start_index..(signature_end as usize).min(lines.len())]
        .iter()
        .any(|line| line.len() > RANKED_SOURCE_LINE_BYTES)
    {
        if recovery {
            return (whole_recovery_withheld_caption(&first.path, region,
                &format!("owner signature exceeds the {RANKED_SOURCE_LINE_BYTES}-byte per-line safeguard")), Vec::new(), true);
        }
        let _ = writeln!(output, "{captions}[{start}-{signature_end}: signature undisplayable at the {RANKED_SOURCE_LINE_BYTES}-byte per-line safeguard; caller body not expanded]");
        return (output, rows.split_off(prior), false);
    }
    push_ranked_source_line(
        &mut output,
        &mut rows,
        &first.path,
        start,
        lines[start_index],
        Some(RankedRegion { start, end }),
    );
    for line in start + 1..=signature_end {
        if let Some(source) = lines.get(line.saturating_sub(1) as usize) {
            push_ranked_source_line(
                &mut output,
                &mut rows,
                &first.path,
                line,
                source,
                callback_header(line),
            );
        }
    }
    let current_mtime = std::fs::metadata(&first.path)
        .ok()
        .and_then(|metadata| metadata.modified().ok());
    let seen = !recovery && session.is_some_and(|state| {
        current_mtime.is_some_and(|mtime| state.is_expanded(&first.path, start, mtime))
    });
    let mut call_lines = callers.iter().map(|caller| caller.line).collect::<Vec<_>>();
    call_lines.sort_unstable();
    call_lines.dedup();
    if seen {
        if caller_region != region {
            let callback_signature_end = scope::declaration_end_line(
                &first.path,
                &first.content,
                caller_region.0,
                caller_region.1,
            )
            .unwrap_or(caller_region.0);
            call_lines.extend(caller_region.0..=callback_signature_end);
            call_lines.sort_unstable();
            call_lines.dedup();
        }
        for line in call_lines.into_iter().filter(|line| *line > signature_end) {
            let Some(source) = lines.get(line.saturating_sub(1) as usize) else {
                continue;
            };
            push_ranked_source_line(
                &mut output,
                &mut rows,
                &first.path,
                line,
                source,
                callback_header(line),
            );
        }
        output.push_str(&captions);
        return (output, rows.split_off(prior), false);
    }

    if minimum {
        // An ordinary connection can retain its declaration and complete live
        // expression before optional contextual expansion. Focus never uses this
        // form as a substitute for fresh coherent operation context.
        for caller in callers {
            let (first_line, last_line) = caller.site.as_ref().map_or((caller.line, caller.line),
                |site| declarations::lines_for(&caller.content, &site.expression));
            if lines.iter().enumerate().any(|(index, line)| (first_line..=last_line).contains(&(index as u32 + 1)) && line.len() > RANKED_SOURCE_LINE_BYTES) {
                return (String::new(), Vec::new(), false);
            }
            for line in first_line..=last_line {
                if line <= signature_end { continue; }
                if let Some(source) = lines.get(line.saturating_sub(1) as usize) {
                    push_ranked_source_line(&mut output, &mut rows, &first.path, line, source, callback_header(line));
                }
            }
        }
        output.push_str(&captions);
        return (output, rows.split_off(prior), false);
    }
    let nonblank = lines[start_index..end_index]
        .iter()
        .filter(|line| !line.trim().is_empty())
        .count();
    if whole || nonblank <= 15 {
        if lines[start_index..end_index].iter().any(|line| line.len() > RANKED_SOURCE_LINE_BYTES) {
            if recovery {
                return (whole_recovery_withheld_caption(&first.path, region,
                    &format!("one or more owner lines exceed the {RANKED_SOURCE_LINE_BYTES}-byte per-line safeguard")), Vec::new(), true);
            }
            return (String::new(), Vec::new(), false);
        }
        for (offset, source) in lines[signature_end as usize..end_index].iter().enumerate() {
            push_ranked_source_line(
                &mut output,
                &mut rows,
                &first.path,
                signature_end + offset as u32 + 1,
                source,
                callback_header(signature_end + offset as u32 + 1),
            );
            // A complete owner larger than any support page stays unavailable;
            // truncating it must not turn a recovery operation into a fragment.
            if whole && estimate_tokens(output.len() as u64) > FUZZY_CARD_HARD_TOKENS {
                if recovery {
                    return (whole_recovery_withheld_caption(&first.path, region,
                        &format!("whole owner exceeds the {FUZZY_CARD_HARD_TOKENS}-token whole-card safeguard")), Vec::new(), true);
                }
                return (String::new(), Vec::new(), false);
            }
        }
        output.push_str(&captions);
        return (output, rows.split_off(prior), false);
    }

    let mut windows = call_lines
        .into_iter()
        .map(|line| {
            (
                line.saturating_sub(3).max(signature_end + 1).max(start),
                (line + 3).min(end),
            )
        })
        .filter(|(window_start, window_end)| window_start <= window_end)
        .map(|(start, end)| {
            scope::complete_statement_window(&first.path, &first.content, start, end)
        })
        .collect::<Vec<_>>();
    windows.sort_unstable();
    let mut merged = Vec::<(u32, u32)>::new();
    for (window_start, window_end) in windows {
        if let Some((_, prior_end)) = merged.last_mut() {
            if window_start <= prior_end.saturating_add(3) {
                *prior_end = (*prior_end).max(window_end);
                continue;
            }
        }
        merged.push((window_start, window_end));
    }
    if merged.iter().any(|(start, end)| lines.iter().enumerate().any(|(index, line)| (*start..=*end).contains(&(index as u32 + 1)) && line.len() > RANKED_SOURCE_LINE_BYTES)) {
        return (String::new(), Vec::new(), false);
    }
    for (window_start, window_end) in merged {
        output.push('\n');
        for line in window_start..=window_end {
            let Some(source) = lines.get(line.saturating_sub(1) as usize) else {
                continue;
            };
            let region = (line == window_start).then_some(RankedRegion {
                start: window_start,
                end: window_end,
            });
            push_ranked_source_line(&mut output, &mut rows, &first.path, line, source, region);
        }
    }
    output.push_str(&captions);
    (output, rows.split_off(prior), false)
}

fn callee_lane_block(
    callee: &crate::search::callees::DeclarationCandidate,
    result: &SearchResult,
    covered: &[&RenderedSourceRow],
) -> Option<(String, Vec<RenderedSourceRow>)> {
    let content = result.sources.retained_text(&callee.file)?;
    let lines = content.lines().collect::<Vec<_>>();
    let start_index = callee.start_line.saturating_sub(1) as usize;
    let end_index = (callee.end_line as usize).min(lines.len());
    if start_index >= end_index {
        return None;
    }
    let signature_end = callee.declaration.as_ref().map_or_else(
        || {
            scope::declaration_end_line(&callee.file, &content, callee.start_line, callee.end_line)
                .unwrap_or(callee.end_line)
        },
        |declaration| declarations::lines_for(&content, &declaration.region().signature).1,
    );
    if lines[start_index..(signature_end as usize).min(lines.len())]
        .iter()
        .any(|line| line.len() > RANKED_SOURCE_LINE_BYTES)
    {
        return Some((format!("{} [{}-{}]: signature undisplayable at the {RANKED_SOURCE_LINE_BYTES}-byte per-line safeguard\n", callee.name, callee.start_line, callee.end_line), Vec::new()));
    }
    let (mut output, parent_rows) = enclosing_declaration_block_at(
        &callee.file,
        &content,
        callee.start_line,
        callee.end_line,
        covered,
        callee
            .declaration
            .as_ref()
            .map(|declaration| declaration.region().id.bytes.start),
    );
    let mut rows = covered
        .iter()
        .map(|row| (**row).clone())
        .collect::<Vec<_>>();
    let prior = rows.len();
    rows.extend(parent_rows);
    if let Some(declaration) = &callee.declaration {
        let already_displayed = (callee.start_line..=signature_end).all(|line| {
            rows.iter()
                .any(|row| row.path == callee.file && row.line == line)
        });
        if already_displayed || !declaration.has_unique_start_line(&content) {
            let _ = writeln!(
                output,
                "{} at {}: declaration candidate{}",
                declaration.name_terms(),
                declaration.position(&content),
                if already_displayed {
                    "; signature displayed above"
                } else {
                    ""
                }
            );
        }
    }
    for line in callee.start_line..=signature_end {
        let source = lines.get(line.saturating_sub(1) as usize)?;
        let region = (line == callee.start_line).then_some(RankedRegion {
            start: callee.start_line,
            end: callee.end_line,
        });
        push_ranked_source_line(&mut output, &mut rows, &callee.file, line, source, region);
    }
    if callee.declaration.is_none() {
        let location = if callee.start_line == callee.end_line {
            callee.start_line.to_string()
        } else {
            format!("{}-{}", callee.start_line, callee.end_line)
        };
        let state = if rows.len() == prior {
            "source above"
        } else {
            "declaration candidate"
        };
        let _ = writeln!(output, "{} [{location}]: {state}", callee.name);
    }
    Some((output, rows.split_off(prior)))
}

struct CallerExpansion<'a> {
    text_range: std::ops::Range<usize>,
    row_range: std::ops::Range<usize>,
    preview: String,
    callers: Vec<crate::search::callers::CallerMatch>,
    session: Option<&'a Session>,
    prefix: String,
}

/// Spend only unreserved page space, after the other target/relationship evidence exists.
fn expand_reserved_callers(
    output: &mut String,
    rows: &mut Vec<RenderedSourceRow>,
    expansions: Vec<CallerExpansion<'_>>,
    budget: u64,
    exempt_bytes: usize,
) {
    let remaining = budget.saturating_sub(estimate_tokens(
        output.len().saturating_sub(exempt_bytes) as u64,
    ));
    let costs = expansions
        .iter()
        .map(|expansion| {
            (
                0,
                estimate_tokens(
                    expansion
                        .preview
                        .len()
                        .saturating_sub(expansion.text_range.len()) as u64,
                ),
            )
        })
        .collect::<Vec<_>>();
    let keep = alloc::select_within_budget(&costs, remaining);
    // Both source-row and text coordinates refer to the baseline, so replace backwards.
    for (expansion, retained) in expansions.into_iter().zip(keep).rev() {
        if !retained {
            continue;
        }
        let covered = rows
            .iter()
            .enumerate()
            .filter(|(index, _)| !expansion.row_range.contains(index))
            .map(|(_, row)| row)
            .collect::<Vec<_>>();
        let callers = expansion.callers.iter().collect::<Vec<_>>();
        let (text, expanded_rows) = caller_lane_block(&callers, expansion.session, false, &covered);
        if text.is_empty() {
            continue;
        }
        let expanded = format!(
            "{}{}",
            expansion.prefix,
            text.lines()
                .map(|line| format!("    {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        output.replace_range(expansion.text_range, &expanded);
        rows.splice(expansion.row_range, expanded_rows);
    }
}
/// Native lane stages. Emphasis reorders stages only: it never deletes a
/// category. Requested categories run first in the supplied category order so
/// an earlier stage cannot spend the lane budget ahead of a requested one;
/// remaining stages keep the canonical order and stay eligible afterwards.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LaneStage { Callers, CallEvidence, Heritage, ExcludedTests, Definitions, Unresolved, Notes }

fn lane_stage_plan(focus: Option<&[String]>) -> Vec<LaneStage> {
    const CANONICAL: [LaneStage; 7] = [LaneStage::Callers, LaneStage::CallEvidence, LaneStage::Heritage,
        LaneStage::ExcludedTests, LaneStage::Definitions, LaneStage::Unresolved, LaneStage::Notes];
    let mut plan: Vec<LaneStage> = Vec::with_capacity(CANONICAL.len());
    if let Some(categories) = focus {
        for category in categories {
            // `uses` is the ordinary connected set and `documentation` is
            // associated by the caller's bridge: neither owns a native stage.
            let owned: &[LaneStage] = match category.as_str() {
                "callers" => &[LaneStage::Callers],
                "callees" => &[LaneStage::CallEvidence, LaneStage::Definitions],
                "implementations" => &[LaneStage::Heritage],
                _ => &[],
            };
            for stage in owned {
                if !plan.contains(stage) { plan.push(*stage); }
            }
        }
    }
    for stage in CANONICAL {
        if !plan.contains(&stage) { plan.push(stage); }
    }
    plan
}

// Presentation state only: reuse a heading iff its evidence block is still the
// physical tail of this target's output. It never grants source/group credit.
struct CallEvidenceTail {
    target: lanes::TargetKey,
    output_end: usize,
    origin: &'static str,
    path: PathBuf,
    basis: &'static str,
}

fn append_ranked_lanes<'a>(
    output: &mut String,
    rows: &mut Vec<RenderedSourceRow>,
    result: &SearchResult,
    matched: &Match,
    bundle: &crate::search::lanes::LaneBundle,
    session: Option<&'a Session>,
    lane_budget: u64,
    progress: Option<&continuation::Progress>,
    receipt: &mut continuation::Progress,
) -> (Vec<CallerExpansion<'a>>, usize) {
    let start = output.len();
    let mut call_tail = None;
    // A recovery caption admitted once must not repeat in the breadth pass.
    let mut withheld_this_render = Vec::new();
    let (mut expansions, _) = append_ranked_lane_pass(output, rows, result, matched, bundle, session,
        lane_budget, progress, receipt, true, &mut call_tail, &mut withheld_this_render);
    let mut reserved = progress.cloned().unwrap_or_default();
    reserved.merge(receipt);
    let remaining = lane_budget.saturating_sub(estimate_tokens((output.len() - start) as u64));
    let (additional, omitted) = append_ranked_lane_pass(output, rows, result, matched, bundle, session,
        remaining, Some(&reserved), receipt, false, &mut call_tail, &mut withheld_this_render);
    expansions.extend(additional);
    (expansions, omitted)
}

/// First reserve one coherent pending group per facet; only then spend on
/// repetitive breadth. Both passes use the same source renderer and receipts.
fn append_ranked_lane_pass<'a>(
    output: &mut String,
    rows: &mut Vec<RenderedSourceRow>,
    result: &SearchResult,
    matched: &Match,
    bundle: &crate::search::lanes::LaneBundle,
    session: Option<&'a Session>,
    lane_budget: u64,
    progress: Option<&continuation::Progress>,
    receipt: &mut continuation::Progress,
    representative: bool,
    call_tail: &mut Option<CallEvidenceTail>,
    withheld_this_render: &mut Vec<continuation::GroupKey>,
) -> (Vec<CallerExpansion<'a>>, usize) {
    let Some(lanes) = bundle.get(matched) else {
        return (Vec::new(), 0);
    };
    let incoming_tail = call_tail.take().filter(|tail|
        tail.output_end == output.len() && tail.target == lanes::target_key(matched));
    let mut next_tail = None;
    let group_key = |facet: &'static str, index: usize| continuation::GroupKey::Lane(crate::search::lanes::target_key(matched), facet, index);
    let done = |key: &continuation::GroupKey| progress.is_some_and(|progress| progress.complete.contains(key));
    let mut lane_output = String::new();
    let mut lane_rows = Vec::new();
    let mut omitted = 0usize;
    let mut omitted_notes = 0usize;
    // Later caller expansions remain optional; the first pass admits coherent
    // context before additional carriers can consume its allowance.
    let mut expansions = Vec::new();
    for stage in lane_stage_plan(bundle.focus_evidence.as_deref()) {
        match stage {
        LaneStage::Callers => {
    if representative && lanes.callers.is_empty() && bundle.prepared_relation.is_none()
        && !(bundle.has_focus() && !bundle.emphasizes("callers")) {
        if bundle.complete {
            lane_output.push_str(if bundle.prepared_kind.is_some() {
                "callers: no additional call candidate in the prepared capture; indirect dispatch and other files are not established\n"
            } else if matched.def_name.is_some() && result.matches.iter()
                .filter(|candidate| candidate.is_definition && candidate.def_name == matched.def_name)
                .count() > 1 {
                "callers: this spelling has multiple live declarations; no source-associated caller established for this target\n"
            } else {
                "callers: no name/alias matches found in the searched scope; bindings and indirect calls are not fully resolved\n"
            });
        }
    }
    let caller_heading = if bundle.prepared_kind.as_deref() == Some("interface")
        && bundle.prepared_relation.is_none()
    {
        "interface uses and calls to declared methods — prepared static candidates; not runtime-dispatch proof:\n"
    } else if bundle.prepared_kind.is_some() {
        "callers — prepared static candidates; not runtime-dispatch proof:\n"
    } else {
        "callers — name/alias candidates; target binding unverified:\n"
    };
    for (facet, heading, carriers) in [
        ("callers", caller_heading, &lanes.callers),
        ("function_references", "function references — passed as a value, not an invocation:\n", &lanes.function_references),
    ] {
        if carriers.is_empty() {
            continue;
        }
        let mut by_path = BTreeMap::<
            PathBuf,
            BTreeMap<
                (u32, u32, String, Option<(usize, usize, String)>),
                Vec<&crate::search::callers::CallerMatch>,
            >,
        >::new();
        let all_carriers = carriers;
        for (index, caller) in carriers.iter().enumerate() {
            let key = group_key(facet, index);
            if done(&key) || withheld_this_render.contains(&key) { continue; }
            let (start, end) = caller.caller_range.unwrap_or((caller.line, caller.line));
            by_path
                .entry(caller.path.clone())
                .or_default()
                .entry((
                    start,
                    end,
                    caller.calling_function.clone(),
                    caller
                        .site
                        .as_ref()
                        .and_then(|site| site.owner.as_ref())
                        .map(|owner| {
                            (
                                owner.bytes.start,
                                owner.bytes.end,
                                owner.syntax_kind.clone(),
                            )
                        }),
                ))
                .or_default()
                .push(caller);
        }
        if by_path.is_empty() { continue; }
        lane_output.push_str(heading);
        let mut visited = false;
        for (path, carriers) in by_path {
            let mut path_started = false;
            for callers in carriers.values() {
                if representative && visited { continue; }
                let covered: Vec<_> = rows.iter().chain(lane_rows.iter()).collect();
                let coherent = representative || bundle.prepared_relation.is_some() || bundle.emphasizes("callers");
                let (carrier, carrier_rows, recovery_withheld) =
                    caller_lane_block_progress(callers, session, false, &covered, !coherent);
                if carrier.is_empty() { omitted += 1; continue; }
                let (full, _) = if !coherent { caller_lane_block(callers, session, false, &covered) } else { (String::new(), Vec::new()) };
                let prefix = if path_started {
                    "".to_string()
                } else {
                    format!("  {}:\n", rel(&path, &result.scope))
                };
                let block = format!(
                    "{prefix}{}",
                    carrier
                        .lines()
                        .map(|line| format!("    {line}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                );
                if estimate_tokens((lane_output.len() + block.len()) as u64) > lane_budget {
                    omitted += 1;
                    continue;
                }
                let requirements = callers.iter().map(|caller| caller_requirements(caller)).collect::<Vec<_>>();
                if coherent && !recovery_withheld && requirements.iter().flatten().any(|(path, line)|
                    !covered.iter().any(|row| &row.path == path && row.line == *line)
                        && !carrier_rows.iter().any(|row| &row.path == path && row.line == *line)) {
                    omitted += 1;
                    continue;
                }
                let full_block = format!(
                    "{prefix}{}",
                    full.lines()
                        .map(|line| format!("    {line}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                );
                if !full.is_empty() && full_block != block {
                    expansions.push(CallerExpansion {
                        text_range: lane_output.len()..lane_output.len() + block.len(),
                        row_range: lane_rows.len()..lane_rows.len() + carrier_rows.len(),
                        preview: full_block,
                        callers: callers.iter().map(|caller| (**caller).clone()).collect(),
                        session,
                        prefix: prefix.clone(),
                    });
                }
                // A withheld caption reserves nothing coherent; the pass keeps
                // looking for an affordable group instead of stopping at it.
                if !recovery_withheld { visited = true; }
                path_started = true;
                lane_output.push_str(&block);
                lane_output.push('\n');
                lane_rows.extend(carrier_rows);
                let rendered = rows.iter().chain(lane_rows.iter()).cloned().collect::<Vec<_>>();
                for (caller, required) in callers.iter().zip(&requirements) {
                    let index = all_carriers.iter().position(|candidate| std::ptr::eq(candidate, *caller)).expect("retained caller");
                    let key = group_key(facet, index);
                    receipt.record(key.clone(), required, &rendered, progress);
                    if recovery_withheld { withheld_this_render.push(key); }
                }
            }
        }
    }
        }
        LaneStage::CallEvidence => {
    let mut previous_origin = None;
    let mut previous_path = None;
    let mut previous_basis = None;
    // Try declaration-bearing connections first, in their existing order;
    // an unfit or unsupported candidate does not consume the reservation.
    let ordered = lanes.connections.iter().enumerate()
        .filter(|(_, connection)| representative && !connection.candidates.is_empty())
        .chain(lanes.connections.iter().enumerate()
            .filter(|(_, connection)| !representative || connection.candidates.is_empty()));
    let mut admitted = false;
    for (index, connection) in ordered {
        let key = group_key("connections", index);
        if done(&key) { continue; }
        if representative && admitted { break; }
        let Some(content) = result.sources.retained_text(&connection.path) else {
            omitted += 1;
            continue;
        };
        if !admitted {
            let shared = incoming_tail.as_ref().filter(|tail| lane_output.is_empty()
                && tail.origin == connection.origin && tail.path == connection.path
                && tail.basis == connection.basis);
            previous_origin = shared.map(|tail| tail.origin);
            previous_path = shared.map(|tail| &tail.path);
            previous_basis = shared.map(|tail| tail.basis);
        }
        let new_origin = previous_origin != Some(connection.origin);
        let mut block = if new_origin {
            format!("\ncall evidence — {}:\n", connection.origin)
        } else {
            String::new()
        };
        let mut block_path = &connection.path;
        let mut crossed_file = false;
        if new_origin || previous_path != Some(block_path) {
            let _ = writeln!(block, "  {}:", rel(block_path, &result.scope));
        }
        if new_origin || previous_path != Some(block_path) || previous_basis != Some(connection.basis) {
            let _ = writeln!(block, "    {}", connection.basis);
        }
        let unresolved = if connection.candidates.is_empty() {
            " — no declaration candidate established"
        } else {
            ""
        };
        let _ = writeln!(block, "    {}{unresolved}", connection.site.caption(&content));
        let mut block_rows = rows
            .iter()
            .chain(lane_rows.iter())
            .cloned()
            .collect::<Vec<_>>();
        let prior = block_rows.len();
        let lines = content.lines().collect::<Vec<_>>();
        let (start, end) = declarations::lines_for(&content, &connection.site.target);
        for line in start..=end {
            if let Some(source) = lines.get(line.saturating_sub(1) as usize) {
                push_ranked_source_line(
                    &mut block,
                    &mut block_rows,
                    &connection.path,
                    line,
                    source,
                    None,
                );
            }
        }
        for candidate in &connection.candidates {
            if let Some((definition, new_rows)) =
                callee_lane_block(candidate, result, &block_rows.iter().collect::<Vec<_>>())
            {
                if block_path != &candidate.file {
                    let _ = writeln!(block, "  {}:", rel(&candidate.file, &result.scope));
                    block_path = &candidate.file;
                    crossed_file = true;
                }
                let _ = writeln!(
                    block,
                    "{}",
                    definition
                        .lines()
                        .map(|line| format!("    {line}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                );
                block_rows.extend(new_rows);
            }
        }
        let mut required = required_source_lines(&connection.path, &content, &[RankedRegion { start, end }]);
        for candidate in &connection.candidates { required.extend(callee_requirements(candidate, result)); }
        if representative && required.iter().any(|(path, line)|
            !block_rows.iter().any(|row| &row.path == path && row.line == *line)) {
            omitted += 1;
            continue;
        }
        if estimate_tokens((lane_output.len() + block.len()) as u64) > lane_budget {
            omitted += 1;
        } else {
            admitted = true;
            previous_origin = (!crossed_file).then_some(connection.origin);
            previous_path = (!crossed_file).then_some(block_path);
            previous_basis = (!crossed_file).then_some(connection.basis);
            receipt.record(key, &required, &block_rows, progress);
            lane_output.push_str(&block);
            next_tail = (!crossed_file).then(|| CallEvidenceTail {
                target: lanes::target_key(matched),
                output_end: lane_output.trim_end_matches('\n').len(),
                origin: connection.origin, path: block_path.clone(), basis: connection.basis,
            });
            lane_rows.extend(block_rows.split_off(prior));
        }
    }
        }
        LaneStage::Heritage => {
    let mut stored_headings = HashSet::new();
    for (index, connection) in lanes.stored_connections.iter().enumerate() {
        let key = group_key("stored_connections", index);
        if done(&key) { continue; }
        if representative && stored_headings.contains(connection.heading) { continue; }
        let mut block = if stored_headings.contains(connection.heading) {
            String::new()
        } else {
            format!("\n{}:\n", connection.heading)
        };
        let _ = writeln!(block, "  {}", connection.note);
        let mut block_rows = rows
            .iter()
            .chain(lane_rows.iter())
            .cloned()
            .collect::<Vec<_>>();
        let prior = block_rows.len();
        if let Some(source) = &connection.source {
            let (body, new_rows) = caller_lane_block(&[source], session, false,
                &block_rows.iter().collect::<Vec<_>>());
            if !body.is_empty() {
                let _ = writeln!(
                    block,
                    "  {}:\n{}",
                    rel(&source.path, &result.scope),
                    body.lines()
                        .map(|line| format!("    {line}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                );
                block_rows.extend(new_rows);
            }
        }
        if let Some(definition) = &connection.definition {
            if let Some((body, new_rows)) =
                callee_lane_block(definition, result, &block_rows.iter().collect::<Vec<_>>())
            {
                let _ = writeln!(
                    block,
                    "  {}:\n{}",
                    rel(&definition.file, &result.scope),
                    body.lines()
                        .map(|line| format!("    {line}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                );
                block_rows.extend(new_rows);
            }
        }
        // Source, destination and the meaning of the relationship fit together.
        // Do not retain a binding annotation after dropping its source support.
        if estimate_tokens((lane_output.len() + block.len()) as u64) > lane_budget {
            omitted += 1;
        } else {
            let mut required = connection.source.as_ref().map(caller_requirements).unwrap_or_default();
            if let Some(definition) = &connection.definition { required.extend(callee_requirements(definition, result)); }
            receipt.record(key, &required, &block_rows, progress);
            stored_headings.insert(connection.heading);
            lane_output.push_str(&block);
            lane_rows.extend(block_rows.split_off(prior));
        }
    }
        }
        LaneStage::ExcludedTests => {
    if representative && lanes.test_callers > 0 {
        let _ = writeln!(
            lane_output,
            "tests: {} caller candidate(s) excluded by default",
            lanes.test_callers
        );
    }
        }
        LaneStage::Definitions => {

    let callee_heading = if bundle.prepared_kind.is_some() {
        "callees — prepared candidate definitions:\n"
    } else {
        "callees — definitions resolved in the same or imported code:\n"
    };
    for (facet, heading, definitions, membership) in [
        ("callees", callee_heading, &lanes.callees, false),
        ("referenced_functions", "referenced function definitions — invocation not established:\n", &lanes.referenced_functions, false),
        ("heuristic_definitions", "heuristic connections — neither calls nor implementation satisfaction proven:\n", &lanes.heuristic_definitions, false),
        ("member_definitions", "captured member definitions — membership, not invocation:\n", &lanes.member_definitions, true),
    ] {
        let original_definitions = definitions;
        if membership {
            for (index, definition) in definitions.iter().enumerate() {
                let required = callee_requirements(definition, result);
                let rendered = rows.iter().chain(lane_rows.iter()).cloned().collect::<Vec<_>>();
                if required.iter().all(|(path, line)| rendered.iter().any(|row| &row.path == path && row.line == *line)) {
                    receipt.record(group_key(facet, index), &required, &rendered, progress);
                }
            }
        }
        // Decide coverage after target compaction: physical containment alone
        // does not establish that the member declaration was actually displayed.
        let definitions: Vec<_> = definitions
            .iter()
            .filter(|callee| {
                let index = original_definitions.iter().position(|candidate| std::ptr::eq(candidate, *callee)).expect("retained definition");
                if done(&group_key(facet, index)) { return false; }
                !membership
                    || callee_lane_block(
                        callee,
                        result,
                        &rows.iter().chain(lane_rows.iter()).collect::<Vec<_>>(),
                    )
                    .is_some_and(|(_, declaration)| {
                        !declaration.iter().all(|candidate| {
                            rows.iter().chain(lane_rows.iter()).any(|prior| {
                                prior.path == candidate.path
                                    && prior.line == candidate.line
                                    && prior.text == candidate.text
                            })
                        })
                    })
            })
            .collect();
        if definitions.is_empty() {
            continue;
        }
        lane_output.push_str(heading);
        let mut by_path =
            BTreeMap::<PathBuf, Vec<&crate::search::callees::DeclarationCandidate>>::new();
        for callee in definitions {
            by_path.entry(callee.file.clone()).or_default().push(callee);
        }
        let mut visited = false;
        for (path, callees) in by_path {
            let mut path_started = false;
            for callee in callees {
                if representative && visited { continue; }
                let Some((mut definition, mut definition_rows)) = callee_lane_block(
                    callee,
                    result,
                    &rows.iter().chain(lane_rows.iter()).collect::<Vec<_>>(),
                ) else {
                    continue;
                };
                if !definition_rows.is_empty()
                    && definition_rows.iter().all(|candidate| {
                        rows.iter().chain(lane_rows.iter()).any(|prior| {
                            prior.path == candidate.path
                                && prior.line == candidate.line
                                && prior.text == candidate.text
                        })
                    })
                {
                    let location = if callee.start_line == callee.end_line {
                        callee.start_line.to_string()
                    } else {
                        format!("{}-{}", callee.start_line, callee.end_line)
                    };
                    definition = format!("{} [{location}]: source above\n", callee.name);
                    definition_rows.clear();
                }
                let prefix = if path_started {
                    "".to_string()
                } else {
                    format!("  {}:\n", rel(&path, &result.scope))
                };
                let block = format!(
                    "{prefix}{}",
                    definition
                        .lines()
                        .map(|line| format!("    {line}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                );
                if estimate_tokens((lane_output.len() + block.len()) as u64) > lane_budget {
                    omitted += 1;
                    continue;
                }
                let required = callee_requirements(callee, result);
                if representative && required.iter().any(|(path, line)|
                    !rows.iter().chain(lane_rows.iter()).chain(definition_rows.iter())
                        .any(|row| &row.path == path && row.line == *line)) {
                    omitted += 1;
                    continue;
                }
                visited = true;
                path_started = true;
                lane_output.push_str(&block);
                lane_output.push('\n');
                lane_rows.extend(definition_rows);
                let index = original_definitions.iter().position(|candidate| std::ptr::eq(candidate, callee)).expect("retained definition");
                receipt.record(group_key(facet, index), &required, &rows.iter().chain(lane_rows.iter()).cloned().collect::<Vec<_>>(), progress);
            }
        }
    }
        }
        LaneStage::Unresolved => {
    if representative { continue; }
    if !lanes.unresolved_callees.is_empty() {
        let label = if bundle.prepared_kind.is_some() {
            "unresolved call names in this capture"
        } else {
            "unresolved calls — no definition found in the same/imported code"
        };
        if progress.is_none() {
            let unresolved = format!("{label}: {}\n", lanes.unresolved_callees.join(", "));
            if estimate_tokens((lane_output.len() + unresolved.len()) as u64) <= lane_budget {
                lane_output.push_str(&unresolved);
                for index in 0..lanes.unresolved_callees.len() { receipt.record(group_key("unresolved_callees", index), &[], &[], None); }
            } else { omitted += lanes.unresolved_callees.len(); }
        } else { for (index, name) in lanes.unresolved_callees.iter().enumerate() {
            let key = group_key("unresolved_callees", index);
            if done(&key) { continue; }
            let unresolved = format!("{label}: {name}\n");
            if estimate_tokens((lane_output.len() + unresolved.len()) as u64) <= lane_budget {
                lane_output.push_str(&unresolved);
                receipt.record(key, &[], &[], progress);
            } else { omitted += 1; }
        } }
    }
        }
        LaneStage::Notes => {
    if representative { continue; }
    // Preserve source carriers before optional per-site annotations. Repeated
    // annotations add no information; graph identities remain in the sidecar.
    let mut seen_notes = HashSet::new();
    for (index, note) in lanes.connection_notes.iter().enumerate() {
        if done(&group_key("connection_notes", index)) { continue; }
        if !seen_notes.insert(note) {
            continue;
        }
        if estimate_tokens((lane_output.len() + note.len() + 1) as u64) <= lane_budget {
            lane_output.push_str(note);
            lane_output.push('\n');
            for (index, duplicate) in lanes.connection_notes.iter().enumerate().filter(|(_, candidate)| *candidate == note) {
                let _ = duplicate;
                receipt.record(group_key("connection_notes", index), &[], &[], progress);
            }
        } else {
            omitted_notes += 1;
        }
    }
    if omitted_notes > 0 {
        let _ = writeln!(lane_output, "… {omitted_notes} connection annotation(s) omitted at the lane boundary; binding/inference explanations are incomplete");
    }
        }
        }
    }
    if omitted > 0 && !representative {
        let _ = writeln!(
            lane_output,
            "… {omitted} relationship carrier(s) omitted at the 4,000-token lane boundary"
        );
    }
    if let Some(state) = session {
        for caller in &lanes.callers {
            if let Some((start, end)) = caller.caller_range {
                if (start..=end).all(|line| {
                    lane_rows
                        .iter()
                        .any(|row| row.path == caller.path && row.line == line)
                }) {
                    if let Ok(mtime) =
                        std::fs::metadata(&caller.path).and_then(|metadata| metadata.modified())
                    {
                        state.record_expand(&caller.path, start, mtime);
                    }
                }
            }
        }
    }
    while lane_output.ends_with('\n') {
        lane_output.pop();
    }
    if !lane_output.is_empty() {
        // Any subsequently emitted section/disclosure ends the shared context.
        *call_tail = next_tail.filter(|tail| tail.output_end == lane_output.len()).map(|mut tail| {
            tail.output_end = output.len() + 2 + lane_output.len();
            tail
        });
        output.push_str("\n\n");
        let text_offset = output.len();
        let row_offset = rows.len();
        for expansion in &mut expansions {
            expansion.text_range.start += text_offset;
            expansion.text_range.end += text_offset;
            expansion.row_range.start += row_offset;
            expansion.row_range.end += row_offset;
        }
        output.push_str(&lane_output);
        rows.extend(lane_rows);
    } else {
        *call_tail = incoming_tail;
    }
    (expansions, if representative { 0 } else { omitted + omitted_notes })
}

pub(crate) fn format_exact_ranked_card(
    result: &SearchResult,
    cache: &OutlineCache,
    session: Option<&Session>,
    lanes: Option<&crate::search::lanes::LaneBundle>,
) -> Option<FormattedSearchResult> {
    format_exact_ranked_card_with_allowance(result, cache, session, lanes, FUZZY_CARD_HARD_TOKENS)
}

pub(crate) fn format_exact_ranked_card_with_allowance(
    result: &SearchResult, cache: &OutlineCache, session: Option<&Session>,
    lanes: Option<&crate::search::lanes::LaneBundle>, allowance: u64,
) -> Option<FormattedSearchResult> {
    // A shared expansion key is not same-agent delivered-row coverage, especially
    // for newly added leading context. Prepared cards keep it live until that
    // delivery boundary is integrated; the public N-API already disables dedup.
    let session = session.filter(|_| !lanes.is_some_and(|bundle| bundle.prepared_kind.is_some()));
    let matched = exact_primary_definition(result)?;
    let content = result.sources.read_text(&matched.path).ok()?;
    let crate::types::FileType::Code(lang) = crate::lang::detect_file_type(&matched.path) else {
        return None;
    };
    let mut omitted_comments = None;
    let (mut regions, kind) =
        if let Some(kind) = lanes.and_then(|bundle| bundle.prepared_kind.as_ref()) {
            let (start, end) = matched.def_range?;
            let context_start = lanes
                .and_then(|bundle| bundle.prepared_comment_start)
                .unwrap_or(start);
            let lines: Vec<_> = content.lines().collect();
            let context = RankedRegion {
                start: context_start,
                end,
            };
            // Adding context must not evict the declaration or displace target code.
            let start = if context_start < start
                && nonblank_count(&lines, context) > RANKED_TARGET_NONBLANK_CAP
            {
                omitted_comments = Some((context_start, start - 1));
                start
            } else {
                context_start
            };
            (vec![RankedRegion { start, end }], kind.clone())
        } else {
            ranked_regions(matched, &content, lang)
        };
    if regions.is_empty() {
        return None;
    }
    let digest = format!("{:X}", Sha256::digest(content.as_bytes()));
    let mut output = format!(
        "# {} — {} #{} :{}\nkind: {kind}\n\n",
        result.query,
        rel(&matched.path, &result.scope),
        &digest[..8],
        matched
            .declaration
            .as_ref()
            .map_or_else(|| matched.line.to_string(), |d| d.position(&content))
    );
    if let Some(name) = matched.declaration.as_ref().and_then(focus::declaration_name) {
        let _ = writeln!(output, "Focus target: {}::{}\n", matched.path.display(), name.replace("::", "."));
    }
    if let Some((start, end)) = omitted_comments {
        if start == end {
            let _ = writeln!(output, "[{start}: omitted for budget]");
        } else {
            let _ = writeln!(output, "[{start}-{end}: omitted for budget]");
        }
    }
    let mut source_rows = Vec::new();
    let mut target_allowance = (RANKED_TARGET_NONBLANK_CAP as u64 * allowance / FUZZY_CARD_HARD_TOKENS).max(1) as usize;
    if lanes.is_some_and(|bundle| bundle.prepared_kind.is_some()) {
        let (start, end) = matched.def_range?;
        let (parents, parent_rows) =
            enclosing_declaration_block(&matched.path, &content, start, end, &[]);
        let parent_count = parent_rows
            .iter()
            .filter(|row| !row.text.trim().is_empty())
            .count();
        let signature_end =
            scope::declaration_end_line(&matched.path, &content, start, end).unwrap_or(start);
        let lines: Vec<_> = content.lines().collect();
        let required = nonblank_count(
            &lines,
            RankedRegion {
                start,
                end: signature_end,
            },
        );
        if parent_count + required <= target_allowance {
            target_allowance -= parent_count;
            output.push_str(&parents);
            source_rows.extend(parent_rows);
            if regions[0].start < start
                && nonblank_count(
                    &lines,
                    RankedRegion {
                        start: regions[0].start,
                        end: signature_end,
                    },
                ) > target_allowance
            {
                let _ = writeln!(
                    output,
                    "[{}-{}: leading context omitted for budget]",
                    regions[0].start,
                    start - 1
                );
                regions[0].start = start;
            }
        } else if !parent_rows.is_empty() {
            output.push_str("Enclosing declarations omitted at the existing target allowance; target declaration takes priority.\n");
        }
    }
    let expansion = render_ranked_regions(
        &mut output,
        &mut source_rows,
        matched,
        &content,
        &regions,
        session,
        target_allowance,
    );
    if let (Some(state), Some(mtime)) = (session, expansion) {
        state.record_expand(&matched.path, matched.line, mtime);
    }
    let mut receipt = continuation::Progress::default();
    receipt.record(continuation::GroupKey::Target(lanes::target_key(matched)), &target_requirements(matched, &content, &regions), &source_rows, None);
    let reference_allowance = allowance.saturating_sub(estimate_tokens(output.len() as u64));
    let mut omitted_relationship_evidence = append_ranked_references_with_progress(
        &mut output,
        &mut source_rows,
        result,
        Some(matched),
        cache,
        reference_allowance,
        None, &mut receipt,
    );
    if let Some(bundle) = lanes {
        let lane_budget = allowance.saturating_sub(estimate_tokens(output.len() as u64));
        let (expansions, omitted) = append_ranked_lanes(
            &mut output,
            &mut source_rows,
            result,
            matched,
            bundle,
            session,
            lane_budget,
            None, &mut receipt,
        );
        omitted_relationship_evidence += omitted;
        expand_reserved_callers(
            &mut output,
            &mut source_rows,
            expansions,
            allowance,
            0,
        );
    }
    while output.ends_with('\n') {
        output.pop();
    }
    let tokens = estimate_tokens(output.len() as u64);
    let _ = write!(output, "\n\n({} tokens)", format_token_count(tokens));

    receipt.finish(&source_rows, None);
    let mut snapshot_paths = HashSet::new();
    let mut source_snapshots = Vec::new();
    for row in &source_rows {
        let Ok(canonical) = row.path.canonicalize() else { continue; };
        if !snapshot_paths.insert(canonical.clone()) {
            continue;
        }
        if let Some(text) = result.sources.retained_text(&canonical) {
            crate::source_proof::push_search_snapshot(&mut source_snapshots, &canonical, &text);
        }
    }
    Some(FormattedSearchResult {
        text: output,
        source_rows,
        source_snapshots,
        omitted_relationship_evidence,
        receipt,
    })
}

const FUZZY_CARD_SOFT_TOKENS: u64 = 3_000;
const FUZZY_CARD_HARD_TOKENS: u64 = 4_000;

/// Use the same source-identity selection as live and prepared relationship
/// collection. Reserve every selected card before completing affordable
/// operations; low-ranked tails cannot displace their source or connections.
pub(crate) fn format_fuzzy_result_typed(
    result: &SearchResult,
    cache: &OutlineCache,
    session: Option<&Session>,
    lanes: Option<&crate::search::lanes::LaneBundle>,
) -> Option<FormattedSearchResult> {
    format_fuzzy_cards(result, cache, session, lanes, None, None, FUZZY_CARD_HARD_TOKENS)
}

pub(crate) fn format_ranked_with_allowance(result: &SearchResult, cache: &OutlineCache,
    lanes: Option<&crate::search::lanes::LaneBundle>, progress: Option<&continuation::Progress>, allowance: u64) -> Option<FormattedSearchResult> {
    format_fuzzy_cards(result, cache, None, lanes, None, progress, allowance)
}

// Allocation previews never mark source as expanded. If fuller operations fit,
// compose once more in source/card order rather than splice text against rows
// from later cards (which could otherwise turn "shown above" into "shown below").
fn format_fuzzy_cards(
    result: &SearchResult,
    cache: &OutlineCache,
    session: Option<&Session>,
    lanes: Option<&crate::search::lanes::LaneBundle>,
    expanded: Option<&[bool]>,
    progress: Option<&continuation::Progress>,
    allowance: u64,
) -> Option<FormattedSearchResult> {
    let definitions = result
        .matches
        .iter()
        .filter(|matched| matched.is_definition)
        .collect::<Vec<_>>();
    if result.matches.is_empty() {
        return None;
    }
    let targets = fuzzy::rich_targets(result);
    let top_count = targets.len();
    let weights = targets
        .iter()
        .map(|matched| if matched.exact { 2u64 } else { 1u64 })
        .collect::<Vec<_>>();
    let weight_total = weights.iter().sum::<u64>().max(1);
    let mut output = String::new();
    let mut source_rows = Vec::new();

    let mut receipt = continuation::Progress::default();
    let mut omitted_relationship_evidence = 0;
    let mut pending_lanes = Vec::new();
    let mut target_expansions = Vec::new();
    let mut retained_expansions = Vec::new();
    for (index, matched) in targets.iter().enumerate() {
        let content = result.sources.read_text(&matched.path).ok()?;
        let file_type = crate::lang::detect_file_type(&matched.path);
        let card_lanes = lanes
            .and_then(|bundle| {
                bundle
                    .prepared_cards
                    .iter()
                    .find(|card| card.get(matched).is_some())
            })
            .or(lanes)
            .filter(|bundle| bundle.get(matched).is_some());
        let markdown = matches!(file_type, FileType::Markdown)
            .then(|| crate::read::outline::markdown::structure(&content))
            .flatten();
        let section = markdown.as_ref().and_then(|structure| {
            structure
                .sections
                .iter()
                .find(|section| section.heading_start_line == matched.line)
        });
        let (mut regions, kind) = match file_type {
            FileType::Code(lang) => {
                if let Some(prepared) = card_lanes.filter(|bundle| bundle.prepared_kind.is_some()) {
                    let (start, end) = matched.def_range?;
                    (
                        vec![RankedRegion {
                            start: prepared.prepared_comment_start.unwrap_or(start),
                            end,
                        }],
                        prepared.prepared_kind.clone()?,
                    )
                } else {
                    ranked_regions(matched, &content, lang)
                }
            }
            FileType::Markdown => {
                let (start, end) = matched.def_range?;
                (
                    vec![RankedRegion { start, end }],
                    if section.is_some() {
                        "document section"
                    } else if markdown
                        .as_ref()
                        .is_some_and(|structure| !structure.sections.is_empty())
                    {
                        "document preamble"
                    } else {
                        "document"
                    }
                    .to_string(),
                )
            }
            _ => continue,
        };
        let required = target_requirements(matched, &content, &regions);
        regions = remaining_target_regions(matched, &content, &regions, progress);
        if regions.is_empty() {
            continue;
        }
        let digest = format!("{:X}", Sha256::digest(content.as_bytes()));
        if !output.is_empty() {
            output.push_str("\n\n");
        }
        let heading = if top_count == 1 { "#" } else { "##" };
        let _ = write!(
            output,
            "{heading} {} — {} #{} :{}\nkind: {kind}\n\n",
            result_name(matched),
            rel(&matched.path, &result.scope),
            &digest[..8],
            matched
                .declaration
                .as_ref()
                .map_or_else(|| matched.line.to_string(), |d| d.position(&content))
        );

        if let Some(name) = matched.declaration.as_ref().and_then(focus::declaration_name) {
            let _ = writeln!(output, "Focus target: {}::{}\n", matched.path.display(), name.replace("::", "."));
        }
        if let (Some(structure), Some(section)) = (markdown.as_ref(), section) {
            let mut hierarchy = Vec::new();
            let mut parent = section.parent.as_deref();
            while let Some(ancestor) = parent.and_then(|selector| {
                crate::read::outline::markdown::section_by_selector(structure, selector)
            }) {
                hierarchy.push(format!(
                    "{} [{}-{}]",
                    ancestor.title, ancestor.heading_start_line, ancestor.subtree_end_line
                ));
                parent = ancestor.parent.as_deref();
            }
            hierarchy.reverse();
            if !hierarchy.is_empty() {
                let _ = writeln!(output, "in {}\n", hierarchy.join(" > "));
            }
        }
        let mut nonblank_cap = if top_count == 1 {
            (RANKED_TARGET_NONBLANK_CAP as u64 * allowance / FUZZY_CARD_HARD_TOKENS).max(1) as usize
        } else {
            let lines = content.lines().collect::<Vec<_>>();
            let mut sampled_bytes = 0usize;
            let mut sampled_lines = 0usize;
            for region in &regions {
                let start = region.start.saturating_sub(1) as usize;
                let end = (region.end as usize).min(lines.len());
                for source in lines.get(start..end).into_iter().flatten() {
                    if source.trim().is_empty() || sampled_lines >= 50 {
                        continue;
                    }
                    sampled_bytes += source.len().min(RANKED_SOURCE_LINE_BYTES) + 8;
                    sampled_lines += 1;
                }
            }
            let average_tokens =
                estimate_tokens((sampled_bytes / sampled_lines.max(1)).max(4) as u64).max(1);
            let share = FUZZY_CARD_SOFT_TOKENS.min(allowance) * weights[index] / weight_total;
            (share / average_tokens).clamp(20, 50) as usize
        };
        if expanded.is_some_and(|selected| selected[index]) {
            nonblank_cap = RANKED_TARGET_NONBLANK_CAP;
        }
        if card_lanes.is_some_and(|bundle| bundle.prepared_kind.is_some()) {
            let (start, end) = matched.def_range?;
            let lines: Vec<_> = content.lines().collect();
            let signature_end =
                scope::declaration_end_line(&matched.path, &content, start, end).unwrap_or(start);
            let (parents, parent_rows) = enclosing_declaration_block(
                &matched.path,
                &content,
                start,
                end,
                &source_rows.iter().collect::<Vec<_>>(),
            );
            let parent_count = parent_rows
                .iter()
                .filter(|row| !row.text.trim().is_empty())
                .count();
            if parent_count
                + nonblank_count(
                    &lines,
                    RankedRegion {
                        start,
                        end: signature_end,
                    },
                )
                <= nonblank_cap
            {
                nonblank_cap -= parent_count;
                output.push_str(&parents);
                source_rows.extend(parent_rows);
            } else if !parent_rows.is_empty() {
                output.push_str("Enclosing declarations omitted at the existing target allowance; target declaration takes priority.\n");
            }
            if regions[0].start < start
                && nonblank_count(
                    &lines,
                    RankedRegion {
                        start: regions[0].start,
                        end: signature_end,
                    },
                ) > nonblank_cap
            {
                let _ = writeln!(
                    output,
                    "[{}-{}: leading context omitted for budget]",
                    regions[0].start,
                    start - 1
                );
                regions[0].start = start;
            }
        }
        // Grouped local declarations remain requested evidence, even when a
        // large enclosing operation cannot fit. Reserve their exact signatures
        // inside this card's allowance, not as extra independent target cards.
        let grouped = matched.declaration.as_ref().map(|owner| {
            definitions.iter().take(5).filter_map(|seed| {
                let declaration = seed.declaration.as_ref()?;
                (seed.path == matched.path
                    && matches!(declaration.region().kind,
                        crate::tsjs_source::Kind::Binding | crate::tsjs_source::Kind::PropertySignature)
                    && declaration.region().body.is_none()
                    && declaration.region().parent.as_ref() == Some(&owner.region().id)
                    && !targets.iter().any(|target| std::ptr::eq(*seed, *target)))
                    .then(|| declarations::lines_for(&content, &declaration.region().signature))
            }).map(|(start, end)| RankedRegion { start, end }).collect::<Vec<_>>()
        }).unwrap_or_default();
        let mut baseline_regions = Vec::new();
        if !grouped.is_empty() {
            let declaration = matched.declaration.as_ref()?;
            let (start, end) = declarations::lines_for(&content, &declaration.region().signature);
            baseline_regions.push(RankedRegion { start, end });
            baseline_regions.extend(grouped);
        }
        baseline_regions.extend_from_slice(&regions);
        let body_start = output.len();
        let body_rows_start = source_rows.len();
        let mut expansion = render_ranked_regions_with_progress(
            &mut output, &mut source_rows, matched, &content, &regions, session, nonblank_cap, progress,
        );
        if baseline_regions.len() > regions.len() && !baseline_regions[..baseline_regions.len() - regions.len()]
            .iter().all(|region| (region.start..=region.end).all(|line| {
                content.lines().nth(line.saturating_sub(1) as usize).is_some_and(|text| {
                    text.trim().is_empty() || source_rows.iter().any(|row| {
                        row.path == matched.path && row.line == line && row.text == text
                    })
                })
            }))
        {
            output.truncate(body_start);
            source_rows.truncate(body_rows_start);
            expansion = render_ranked_regions_with_progress(&mut output, &mut source_rows, matched, &content,
                &baseline_regions, session, nonblank_cap, progress);
        }
        if top_count > 1
            && matched
                .declaration
                .as_ref()
                .is_some_and(|declaration| declaration.class_region().is_some())
            && estimate_tokens(output.len() as u64) > allowance
        {
            output.truncate(body_start);
            source_rows.truncate(body_rows_start);
            let (start, end) = matched.def_range?;
            let _ = writeln!(output, "[{start}-{end}: class inventory omitted for budget; complete declarations do not fit the shared page]");
            omitted_relationship_evidence += 1;
            continue;
        }
        // A small card is an allocation baseline, not a reason to cut an
        // affordable operation before its return, failure or retry branches.
        // Previewing source is pure: record expansion only after it is retained.
        if expanded.is_none() && !result.query.contains('|') && result.query.split_whitespace().take(2).count() > 1
            && nonblank_cap < RANKED_TARGET_NONBLANK_CAP
            && matched.declaration.as_ref().is_some_and(|declaration| {
                matches!(declaration.region().kind,
                    crate::tsjs_source::Kind::Function | crate::tsjs_source::Kind::Method)
            })
        {
            let mut full = String::new();
            let mut full_rows = source_rows[..body_rows_start].to_vec();
            render_ranked_regions_with_progress(&mut full, &mut full_rows, matched, &content,
                &regions, session, RANKED_TARGET_NONBLANK_CAP, progress);
            if full_rows.len() > source_rows.len()
                && source_rows[body_rows_start..].iter().all(|row| full_rows.iter().any(|full| {
                    full.path == row.path && full.line == row.line && full.text == row.text
                }))
            {
                target_expansions.push((index,
                    estimate_tokens(full.len().saturating_sub(output.len() - body_start) as u64)));
            }
        }
        if let Some(mtime) = expansion {
            retained_expansions.push((matched.path.clone(), matched.line, mtime));
        }
        receipt.record(continuation::GroupKey::Target(lanes::target_key(matched)), &required, &source_rows, progress);
        if result.query.split_whitespace().take(2).count() > 1 && !result.query.contains('|') {
            for seed in result.matches.iter().filter(|seed| seed.is_definition).take(5) {
                let Some(declaration) = seed.declaration.as_ref() else { continue; };
                if seed.path != matched.path || declaration.region().body.is_some()
                    || !matches!(declaration.region().kind, crate::tsjs_source::Kind::Binding | crate::tsjs_source::Kind::PropertySignature)
                    || declaration.region().parent.as_ref().is_none_or(|parent| matched.declaration.as_ref().is_none_or(|owner| &owner.region().id != parent
                        || !matches!(owner.region().kind, crate::tsjs_source::Kind::Function | crate::tsjs_source::Kind::Method))) { continue; }
                let (start, end) = declarations::lines_for(&content, &declaration.region().id.bytes);
                receipt.record(continuation::GroupKey::Target(lanes::target_key(seed)), &required_source_lines(&seed.path, &content, &[RankedRegion { start, end }]), &source_rows, progress);
            }
        }
        if let Some(bundle) = card_lanes {
            let position = matched.declaration.as_ref().map_or_else(
                || matched.line.to_string(),
                |declaration| declaration.position(&content),
            );
            pending_lanes.push((*matched, bundle, position));
        }
    }

    let reference_budget =
        allowance.saturating_sub(estimate_tokens(output.len() as u64));
    omitted_relationship_evidence += append_ranked_references_with_progress(
        &mut output,
        &mut source_rows,
        result,
        None,
        cache,
        reference_budget,
        progress, &mut receipt,
    );
    // Preserve live occurrence evidence, then the connections that explain the
    // selected declarations. A weak discovery tail cannot spend their allowance.
    let mut caller_expansions = Vec::new();
    let mut call_tail = None;
    // Recovery captions stay pending; neither representative iteration repeats them.
    let mut withheld_this_render = Vec::new();
    for representative in [true, false] {
        let mut reserved = progress.cloned().unwrap_or_default();
        reserved.merge(&receipt);
        for &(matched, bundle, ref position) in &pending_lanes {
            let heading = format!(
                "\n\nconnections for {} — {}:{position}",
                result_name(matched),
                rel(&matched.path, &result.scope)
            );
            let lane_budget = allowance
                .saturating_sub(estimate_tokens((output.len() + heading.len()) as u64));
            let section_start = output.len();
            output.push_str(&heading);
            let body_start = output.len();
            let (expansions, omitted) = append_ranked_lane_pass(
                &mut output,
                &mut source_rows,
                result,
                matched,
                bundle,
                if representative && !target_expansions.is_empty() { None } else { session },
                lane_budget,
                Some(&reserved), &mut receipt, representative, &mut call_tail, &mut withheld_this_render,
            );
            if output.len() == body_start { output.truncate(section_start); }
            caller_expansions.extend(expansions);
            omitted_relationship_evidence += omitted;
        }
        if representative && !target_expansions.is_empty() {
            // Reserve connected context across cards before optional target depth.
            let costs = target_expansions.iter().map(|(_, cost)| (0, *cost)).collect::<Vec<_>>();
            let remaining = allowance.saturating_sub(estimate_tokens(output.len() as u64));
            let keep = alloc::select_within_budget(&costs, remaining);
            let mut selected = vec![false; targets.len()];
            for ((index, _), keep) in target_expansions.iter().zip(keep) { selected[*index] = keep; }
            if selected.iter().any(|keep| *keep) {
                return format_fuzzy_cards(result, cache, session, lanes, Some(&selected), progress, allowance);
            }
        }
    }
    if let Some(session) = session {
        for (path, line, mtime) in retained_expansions { session.record_expand(&path, line, mtime); }
    }
    expand_reserved_callers(
        &mut output,
        &mut source_rows,
        caller_expansions,
        allowance,
        0,
    );

    receipt.finish(&source_rows, progress);
    let mut tail_omitted = definitions.iter().skip(fuzzy::COMPACT_CANDIDATE_LIMIT)
        .filter(|matched| !targets.iter().any(|target| std::ptr::eq(**matched, *target))).count();
    for matched in definitions.iter().take(fuzzy::COMPACT_CANDIDATE_LIMIT).filter(|matched| {
        !targets.iter().any(|target| std::ptr::eq(**matched, *target))
    }) {
        let (display, clipped) = ranked_line_text(&matched.text);
        let already_shown = source_rows.iter().any(|row| {
            row.path == matched.path && row.line == matched.line && row.text == matched.text
        });
        let mut include_source = !clipped && !already_shown;
        let row = if let Some(declaration) = &matched.declaration {
            let content = result.sources.read_text(&matched.path).ok()?;
            // Do not repeat an owner's already displayed declaration inventory
            // as a second index. Keep independent identities and partially
            // displayed signatures; sharing a physical line is not ownership.
            let owner_shown = targets.iter().any(|target| {
                target.path == matched.path
                    && target.declaration.as_ref().is_some_and(|owner| {
                        declaration.region().parent.as_ref() == Some(&owner.region().id)
                    })
            });
            if owner_shown {
                let (start, end) =
                    declarations::lines_for(&content, &declaration.region().signature);
                let lines = content.lines().collect::<Vec<_>>();
                if (start..=end).all(|line| {
                    lines.get(line.saturating_sub(1) as usize).is_some_and(|text| {
                        text.trim().is_empty()
                            || source_rows.iter().any(|row| {
                                row.path == matched.path && row.line == line && row.text == *text
                            })
                    })
                }) {
                    continue;
                }
            }
            let parents = declaration
                .ancestors()
                .into_iter()
                .map(declarations::label)
                .collect::<Vec<_>>();
            let hierarchy = if parents.is_empty() {
                String::new()
            } else {
                format!(" in {}", parents.join(" > "))
            };
            let within_card = targets.iter().any(|target| {
                target.path == matched.path
                    && target
                        .def_range
                        .is_some_and(|(start, end)| start <= matched.line && matched.line <= end)
            });
            // Nested tail declarations must not duplicate or bypass the rich
            // card's allowance. Independent tail entries keep their live preview.
            let preview = if already_shown || within_card {
                include_source = false;
                if already_shown {
                    " [source displayed above]".to_string()
                } else {
                    " [source not expanded at the card allowance]".to_string()
                }
            } else {
                format!(": {display}")
            };
            format!(
                "\n- {} — {}:{}{hierarchy}{preview}",
                declarations::label(declaration.region()),
                rel(&matched.path, &result.scope),
                declaration.position(&content)
            )
        } else {
            let range = matched.def_range.map_or_else(
                || matched.line.to_string(),
                |(start, end)| {
                    if start == end {
                        start.to_string()
                    } else {
                        format!("{start}-{end}")
                    }
                },
            );
            let preview = if already_shown {
                format!("{} [source displayed above]", result_name(matched))
            } else {
                display
            };
            format!(
                "\n- {} [{}]: {preview}",
                rel(&matched.path, &result.scope),
                range
            )
        };
        if estimate_tokens((output.len() + row.len()) as u64) > allowance {
            tail_omitted += 1;
            continue;
        }
        if include_source {
            source_rows.push(RenderedSourceRow {
                path: matched.path.clone(),
                line: matched.line,
                text: matched.text.clone(),
            });
        }
        output.push_str(&row);
    }
    omitted_relationship_evidence += tail_omitted;
    if tail_omitted > 0 {
        let _ = write!(
            output,
            "\n… {tail_omitted} lower-ranked declaration(s) omitted at the 4,000-token page boundary"
        );
    }
    while output.ends_with('\n') {
        output.pop();
    }
    let tokens = estimate_tokens(output.len() as u64);
    let _ = write!(output, "\n\n({} tokens)", format_token_count(tokens));

    let mut snapshot_paths = HashSet::new();
    let mut source_snapshots = Vec::new();
    for row in &source_rows {
        let Ok(canonical) = row.path.canonicalize() else { continue; };
        if !snapshot_paths.insert(canonical.clone()) {
            continue;
        }
        if let Some(text) = result.sources.retained_text(&canonical) {
            crate::source_proof::push_search_snapshot(&mut source_snapshots, &canonical, &text);
        }
    }
    Some(FormattedSearchResult {
        text: output,
        source_rows,
        source_snapshots,
        omitted_relationship_evidence,
        receipt,
    })
}

pub(crate) fn format_search_result_with_lanes(
    result: &SearchResult,
    cache: &OutlineCache,
    session: Option<&Session>,
    bloom: &crate::index::bloom::BloomFilterCache,
    expand: usize,
    budget: Option<u64>,
    lanes: &crate::search::lanes::LaneBundle,
) -> Result<FormattedSearchResult, TilthError> {
    if !lanes.prepared_cards.is_empty() {
        return format_fuzzy_result_typed(result, cache, None, Some(lanes)).ok_or_else(|| {
            TilthError::InvalidQuery {
                query: result.query.clone(),
                reason: "prepared multi-target rendering unavailable; no lexical fallback used"
                    .into(),
            }
        });
    }
    if expand > 0 {
        if let Some(card) = format_exact_ranked_card(result, cache, session, Some(lanes)) {
            return Ok(card);
        }
    }
    if lanes.prepared_kind.is_some() {
        return Err(TilthError::InvalidQuery {
            query: result.query.clone(),
            reason: "prepared callable rendering unavailable; no lexical fallback used".into(),
        });
    }
    format_search_result_typed(result, cache, session, bloom, expand, budget)
}

pub(crate) fn format_search_result_typed(
    result: &SearchResult,
    cache: &OutlineCache,
    session: Option<&Session>,
    bloom: &crate::index::bloom::BloomFilterCache,
    expand: usize,
    budget: Option<u64>,
) -> Result<FormattedSearchResult, TilthError> {
    if expand > 0 {
        if let Some(card) = format_exact_ranked_card(result, cache, session, None) {
            return Ok(card);
        }
    }
    let header = format::search_header(
        &result.query,
        &result.scope,
        result.matches.len(),
        result.definitions,
        result.usages,
    );
    let mut out = header;
    let mut expand_remaining = expand;
    let mut expanded_files = HashSet::new();
    let mut segments: Vec<(i64, usize, usize)> = Vec::new();
    let mut segment_rows: Vec<Vec<RenderedSourceRow>> = Vec::new();

    // File-level retrieval: when a file basename matches the query exactly,
    // prepend a compact outline so the agent gets file-level context first.
    if let Some(file_outline) = basename_file_outline(
        &result.query,
        &result.matches,
        &result.scope,
        &result.sources,
    ) {
        let _ = write!(out, "\n\n{file_outline}");
    }

    // Apply faceting when there are many matches (>5)
    if result.matches.len() > 5 {
        let faceted = facets::facet_matches(result.matches.clone(), &result.scope);
        let totals = &result.facet_totals;

        // Format each non-empty facet with section headers. After a truncated
        // facet's entries, emit a per-facet hidden-count line (`write_hidden_tail`)
        // so the reader sees which facet got cut. The global tail used to live
        // at the end of `format_search_result`; on the facet path we suppress
        // it to avoid double-counting hidden matches across two surfaces.
        if !faceted.definitions.is_empty() {
            let _ = write!(
                out,
                "\n\n## Definitions ({})",
                count_label(faceted.definitions.len(), totals.definitions)
            );
            format_matches(
                &faceted.definitions,
                &result.scope,
                cache,
                session,
                bloom,
                &result.sources,
                &mut expand_remaining,
                &mut expanded_files,
                &mut out,
                &mut segments,
                &mut segment_rows,
            );
            write_hidden_tail(
                &mut out,
                faceted.definitions.len(),
                totals.definitions,
                "definitions",
            );
        }

        if !faceted.implementations.is_empty() {
            let _ = write!(
                out,
                "\n\n## Implementations ({})",
                count_label(faceted.implementations.len(), totals.implementations)
            );
            format_matches(
                &faceted.implementations,
                &result.scope,
                cache,
                session,
                bloom,
                &result.sources,
                &mut expand_remaining,
                &mut expanded_files,
                &mut out,
                &mut segments,
                &mut segment_rows,
            );
            write_hidden_tail(
                &mut out,
                faceted.implementations.len(),
                totals.implementations,
                "implementations",
            );
        }

        if !faceted.tests.is_empty() {
            let _ = write!(
                out,
                "\n\n## Tests ({})",
                count_label(faceted.tests.len(), totals.tests)
            );
            // Compact test format — one line per match, no expand budget consumed
            for m in &faceted.tests {
                let _ = write!(
                    out,
                    "\n  {}:{} — {}",
                    rel(&m.path, &result.scope),
                    m.line,
                    m.text.trim()
                );
            }
            write_hidden_tail(&mut out, faceted.tests.len(), totals.tests, "tests");
        }

        if !faceted.usages_local.is_empty() {
            let _ = write!(
                out,
                "\n\n## Usages — same package ({})",
                count_label(faceted.usages_local.len(), totals.usages_local)
            );
            format_matches(
                &faceted.usages_local,
                &result.scope,
                cache,
                session,
                bloom,
                &result.sources,
                &mut expand_remaining,
                &mut expanded_files,
                &mut out,
                &mut segments,
                &mut segment_rows,
            );
            write_hidden_tail(
                &mut out,
                faceted.usages_local.len(),
                totals.usages_local,
                "usages",
            );
        }

        if !faceted.usages_cross.is_empty() {
            let _ = write!(
                out,
                "\n\n## Usages — other ({})",
                count_label(faceted.usages_cross.len(), totals.usages_cross)
            );
            format_matches(
                &faceted.usages_cross,
                &result.scope,
                cache,
                session,
                bloom,
                &result.sources,
                &mut expand_remaining,
                &mut expanded_files,
                &mut out,
                &mut segments,
                &mut segment_rows,
            );
            write_hidden_tail(
                &mut out,
                faceted.usages_cross.len(),
                totals.usages_cross,
                "usages",
            );
        }
    } else {
        // Linear display for ≤5 matches
        format_matches(
            &result.matches,
            &result.scope,
            cache,
            session,
            bloom,
            &result.sources,
            &mut expand_remaining,
            &mut expanded_files,
            &mut out,
            &mut segments,
            &mut segment_rows,
        );

        // Global hidden-tail only on the linear path. The faceted path emits
        // a per-facet line for each truncated facet above; printing both
        // would double-count the same hidden matches.
        if result.total_found > result.matches.len() {
            let omitted = result.total_found - result.matches.len();
            let _ = write!(
                out,
                "\n\n... and {omitted} more matches. Narrow with scope."
            );
        }
    }

    // Apply value-based budget allocation before appending the token footer.
    // Under-budget: byte-identical. Over-budget: drops lowest-value match blocks.
    // budget.unwrap_or(DEFAULT_BUDGET) keeps the no-budget path byte-identical
    // to before this fix — DEFAULT_BUDGET remains the default, it is simply no
    // longer a hardcode that shadows a real caller-supplied budget.
    let budget_tokens = crate::budget::clamp(budget.unwrap_or(crate::budget::DEFAULT_BUDGET));
    let (fitted, kept) =
        crate::search::alloc::fit_to_budget_with_selection(&out, &segments, budget_tokens);
    out = fitted;
    let source_rows: Vec<RenderedSourceRow> = segment_rows
        .into_iter()
        .zip(kept)
        .filter(|(_, keep)| *keep)
        .flat_map(|(rows, _)| rows)
        .collect();
    let mut snapshot_paths = HashSet::new();
    let mut source_snapshots = Vec::new();
    for row in &source_rows {
        let Ok(canonical) = row.path.canonicalize() else { continue; };
        if !snapshot_paths.insert(canonical.clone()) {
            continue;
        }
        if let Some(text) = result.sources.retained_text(&canonical) {
            crate::source_proof::push_search_snapshot(&mut source_snapshots, &canonical, &text);
        }
    }

    let tokens = estimate_tokens(out.len() as u64);
    let token_str = format_token_count(tokens);
    let _ = write!(out, "\n\n({token_str} tokens)");

    Ok(FormattedSearchResult {
        text: out,
        source_rows,
        source_snapshots,
        omitted_relationship_evidence: 0,
        receipt: continuation::Progress::default(),
    })
}

/// Inline the actual code for a match while carrying the exact displayed source rows.
/// The raw content is returned so the caller can reuse it (e.g. for related-file hints)
/// without a redundant file read.
///
/// For definitions: use tree-sitter node range (`def_range`).
/// For usages: ±10 lines around the match.
fn expand_match(m: &Match, scope: &Path, sources: &OperationSources) -> Option<ExpandedMatch> {
    let content = sources.read_text(&m.path).ok()?;
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len() as u32;

    let (mut start, end) = if estimate_tokens(content.len() as u64) < EXPAND_FULL_FILE_THRESHOLD {
        (1, total)
    } else {
        let (s, e) = m
            .def_range
            .unwrap_or((m.line.saturating_sub(10), m.line.saturating_add(10)));
        (s.max(1), e.min(total))
    };

    // Skip leading import blocks in expanded definitions near top of file
    if m.is_definition && start <= 5 {
        let mut first_non_import = start;
        for i in start..=end {
            let idx = (i - 1) as usize;
            if idx >= lines.len() {
                break;
            }
            let trimmed = lines[idx].trim();
            let is_import = trimmed.starts_with("use ")
                || trimmed.starts_with("import ")
                || trimmed.starts_with("from ")
                || trimmed.starts_with("#include")
                || trimmed.starts_with("require(")
                || trimmed.starts_with("require ")
                || (trimmed.starts_with("const ") && trimmed.contains("= require("));

            if !is_import && !trimmed.is_empty() {
                first_non_import = i;
                break;
            }
        }
        // Guard: only skip if we found at least one non-import line
        if first_non_import > start && first_non_import <= end {
            start = first_non_import;
        }
    }

    let mut out = String::new();
    let mut source_rows = Vec::new();
    let _ = write!(out, "\n```{}:{}-{}", rel(&m.path, scope), start, end);

    // Track consecutive blank lines for collapsing
    let mut prev_blank = false;
    for i in start..=end {
        let idx = (i - 1) as usize;
        if idx < lines.len() {
            let line = lines[idx];
            let is_blank = line.trim().is_empty();

            // Skip consecutive blank lines (keep first, drop rest)
            if is_blank && prev_blank {
                continue;
            }

            let _ = write!(out, "\n{i:>4} | {line}");
            source_rows.push(RenderedSourceRow {
                path: m.path.clone(),
                line: i,
                text: line.to_string(),
            });
            prev_blank = is_blank;
        }
    }
    out.push_str("\n```");
    Some(ExpandedMatch {
        code: out,
        content: (*content).clone(),
        source_rows,
    })
}

/// Filter formatted code lines using a set of line numbers to skip.
/// Input is the fenced code block from `expand_match` (opening/closing fence lines
/// plus numbered content lines). Inserts gap markers for runs of >3 skipped lines.
fn filter_code_lines(code: &str, skip_lines: &HashSet<u32>) -> String {
    let mut kept: Vec<String> = Vec::new();
    let mut consecutive_skipped: u32 = 0;

    for segment in code.split('\n') {
        // Fence lines and the leading empty segment pass through unchanged
        if segment.starts_with("```") || segment.is_empty() {
            flush_gap_marker(&mut kept, &mut consecutive_skipped);
            kept.push(segment.to_owned());
            continue;
        }

        // Extract line number from formatted line: "  42 | content"
        let line_num = segment
            .find('|')
            .and_then(|pos| segment[..pos].trim().parse::<u32>().ok());

        if let Some(num) = line_num {
            if skip_lines.contains(&num) {
                consecutive_skipped += 1;
                continue;
            }
        }

        flush_gap_marker(&mut kept, &mut consecutive_skipped);
        kept.push(segment.to_owned());
    }

    kept.join("\n")
}

/// If >3 lines were skipped consecutively, push a gap marker and reset counter.
fn flush_gap_marker(kept: &mut Vec<String>, consecutive_skipped: &mut u32) {
    if *consecutive_skipped > 3 {
        kept.push(format!(
            "       ... ({} lines omitted)",
            *consecutive_skipped
        ));
    }
    *consecutive_skipped = 0;
}

// Decorations must use the collection's bytes, not a shared path/mtime cache.
// Parsing here also avoids seeding a live-read cache with an older capture.
fn enclosing_definition_with_sources(
    path: &Path,
    match_line: u32,
    sources: &OperationSources,
) -> Result<Option<scope::EnclosingScope>, scope::MixedScopes> {
    let FileType::Code(lang) = crate::lang::detect_file_type(path) else { return Ok(None); };
    let Ok(content) = sources.read_text(path) else { return Ok(None); };
    if content.len() > 500_000 { return Ok(None); }
    let Some(language) = crate::lang::outline::outline_language(lang) else { return Ok(None); };
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&language).is_err() { return Ok(None); }
    let Some(tree) = parser.parse(content.as_str(), None) else { return Ok(None); };
    scope::enclosing_definition_in_source(&crate::cache::ParsedFile { content, tree, lang }, match_line)
}

/// Outline decoration from the operation's admitted source image.
fn get_outline_str(path: &Path, sources: &OperationSources) -> Option<std::sync::Arc<str>> {
    let file_type = crate::lang::detect_file_type(path);
    if !matches!(file_type, FileType::Code(_)) {
        return None;
    }
    let content = sources.read_text(path).ok()?;
    if content.len() > 500_000 {
        return None;
    }
    Some(read::outline::generate(path, file_type, &content, content.as_bytes(), false).into())
}

/// Find the outline entry index that encloses the given line.
fn find_enclosing_outline_idx(
    path: &std::path::Path,
    match_line: u32,
    sources: &OperationSources,
) -> Option<usize> {
    // Mixed usages must not collapse into one legacy outline group: that path
    // otherwise suppresses their literal rows along with the rejected owner.
    if matches!(crate::lang::detect_file_type(path), FileType::Code(lang) if declarations::supports(lang))
        && enclosing_definition_with_sources(path, match_line, sources).is_err()
    {
        return None;
    }
    let outline_str = get_outline_str(path, sources)?;
    let outline_lines: Vec<&str> = outline_str.lines().collect();
    outline_lines.iter().position(|line| {
        extract_line_range(line).is_some_and(|(s, e)| match_line >= s && match_line <= e)
    })
}

/// Build outline context around a match — ±2 entries around the enclosing one.
fn outline_context_for_match(
    path: &std::path::Path,
    match_line: u32,
    sources: &OperationSources,
) -> Option<String> {
    if matches!(crate::lang::detect_file_type(path), FileType::Code(lang) if declarations::supports(lang))
        && enclosing_definition_with_sources(path, match_line, sources).is_err()
    {
        return None;
    }
    let outline_str = get_outline_str(path, sources)?;
    let outline_lines: Vec<&str> = outline_str.lines().collect();
    if outline_lines.is_empty() {
        return None;
    }

    let match_idx = outline_lines.iter().position(|line| {
        extract_line_range(line).is_some_and(|(s, e)| match_line >= s && match_line <= e)
    })?;

    let start = match_idx.saturating_sub(2);
    let end = (match_idx + 3).min(outline_lines.len());

    let mut context = String::new();
    for (i, line) in outline_lines.iter().enumerate().take(end).skip(start) {
        if i == match_idx {
            let _ = write!(context, "\n-> {line}");
        } else {
            let _ = write!(context, "\n  {line}");
        }
    }
    Some(context)
}

/// Annotate a usage match with its enclosing scope: `"function foo"` /
/// `"class Bar"` for code (via tree-sitter), `"§Heading"` for markdown
/// (via line walk). Returns `None` for top-level matches and unsupported
/// file types — the formatter renders those without an `in …` suffix.
fn enclosing_scope_label(
    path: &std::path::Path,
    match_line: u32,
    sources: &OperationSources,
) -> Option<String> {
    match crate::lang::detect_file_type(path) {
        FileType::Code(_) => match enclosing_definition_with_sources(path, match_line, sources) {
            Ok(Some(s)) => Some(format!("{} {}", s.kind, s.name)),
            Err(_) => Some(scope::MIXED_SCOPES.into()),
            Ok(None) => None,
        },
        FileType::Markdown => markdown_enclosing_scope(path, match_line, sources),
        _ => None,
    }
}

/// Find the deepest ATX-heading section that encloses `match_line`. Returns
/// the heading text prefixed with `§`. A `# foo` line inside a fenced or
/// indented code block is NOT a heading — the tree-sitter-md block grammar
/// owns that distinction, so we don't need our own fence pre-pass.
fn markdown_enclosing_scope(path: &Path, match_line: u32, sources: &OperationSources) -> Option<String> {
    if match_line == 0 {
        return None;
    }
    let content = sources.read_text(path).ok()?;
    let tree = crate::lang::outline::parse_markdown(&content)?;
    let lines: Vec<&str> = content.lines().collect();
    let mut best: Option<(tree_sitter::Node, u32)> = None;
    walk_md_for_enclosing(tree.root_node(), match_line, &mut best);
    let (heading, _) = best?;
    let text = crate::lang::outline::heading_text(heading, &lines);
    if text.is_empty() {
        return None;
    }
    let display: String = if text.chars().count() > 60 {
        let mut s: String = text.chars().take(57).collect();
        s.push_str("...");
        s
    } else {
        text
    };
    Some(format!("§{display}"))
}

fn walk_md_for_enclosing<'a>(
    node: tree_sitter::Node<'a>,
    match_line: u32,
    best: &mut Option<(tree_sitter::Node<'a>, u32)>,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() != "section" {
            continue;
        }
        let start = (child.start_position().row + 1) as u32;
        let end_excl = child.end_position();
        let end = if end_excl.column == 0 {
            end_excl.row as u32
        } else {
            (end_excl.row + 1) as u32
        };
        if match_line < start || match_line > end {
            continue;
        }
        // Section contains match_line. Record its heading if it has one,
        // then recurse to find a deeper section.
        let mut sec_cursor = child.walk();
        if let Some(heading) = child
            .children(&mut sec_cursor)
            .find(|c| c.kind() == "atx_heading")
        {
            // Update best to the *deepest* (largest start_line) match.
            match best {
                Some((_, prev_start)) if *prev_start >= start => {}
                _ => *best = Some((heading, start)),
            }
        }
        walk_md_for_enclosing(child, match_line, best);
    }
}

/// Extract (`start_line`, `end_line`) from an outline entry like "[20-115]" or "[16]".
fn extract_line_range(line: &str) -> Option<(u32, u32)> {
    let trimmed = line.trim();
    if !trimmed.starts_with('[') {
        return None;
    }
    let end = trimmed.find(']')?;
    let range_str = &trimmed[1..end];
    if let Some((a, b)) = range_str.split_once('-') {
        let start: u32 = a.trim().parse().ok()?;
        // Handle import ranges like "[1-]"
        let end: u32 = if b.trim().is_empty() {
            start
        } else {
            b.trim().parse().ok()?
        };
        Some((start, end))
    } else {
        let n: u32 = range_str.trim().parse().ok()?;
        Some((n, n))
    }
}

/// Format glob search results (file list with previews).
pub(crate) fn format_glob_result(
    result: &glob::GlobResult,
    scope: &Path,
) -> Result<String, TilthError> {
    let header = format!(
        "# Glob: \"{}\" in {} — {} files",
        result.pattern,
        scope.display(),
        result.files.len()
    );

    let mut out = header;
    for file in &result.files {
        let _ = write!(out, "\n  {}", rel(&file.path, scope));
        if let Some(ref preview) = file.preview {
            let _ = write!(out, "  ({preview})");
        }
    }

    if result.total_found > result.files.len() {
        let omitted = result.total_found - result.files.len();
        let _ = write!(out, "\n\n... and {omitted} more files. Narrow with scope.");
    }

    if result.files.is_empty() && !result.available_extensions.is_empty() {
        let _ = write!(
            out,
            "\n\nNo matches. Available extensions in scope: {}",
            result.available_extensions.join(", ")
        );
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Mutex;

    /// Collect all file paths from a walker into a sorted Vec.
    fn walk_paths(scope: &Path, glob: Option<&str>) -> Vec<PathBuf> {
        let w = walker(scope, glob).expect("walker failed");
        let paths: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
        w.run(|| {
            let paths = &paths;
            Box::new(move |entry| {
                if let Ok(e) = entry {
                    if e.file_type().is_some_and(|ft| ft.is_file()) {
                        paths.lock().unwrap().push(e.into_path());
                    }
                }
                ignore::WalkState::Continue
            })
        });
        let mut v = paths.into_inner().unwrap();
        v.sort();
        v
    }

    fn extensions(paths: &[PathBuf]) -> HashSet<String> {
        paths
            .iter()
            .filter_map(|p| p.extension())
            .map(|e| e.to_string_lossy().to_string())
            .collect()
    }

    // ── walker unit tests ──

    #[test]
    fn walker_none_returns_all_file_types() {
        let scope = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let all = walk_paths(&scope, None);
        let exts = extensions(&all);
        assert!(exts.contains("rs"), "expected .rs files, got {exts:?}");
        assert!(!all.is_empty());
    }

    #[test]
    fn walker_whitelist_filters_to_matching_extension() {
        let scope = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let filtered = walk_paths(&scope, Some("*.rs"));
        assert!(!filtered.is_empty(), "whitelist should find .rs files");
        for p in &filtered {
            assert_eq!(
                p.extension().and_then(|e| e.to_str()),
                Some("rs"),
                "non-.rs file leaked through whitelist: {}",
                p.display()
            );
        }
    }

    #[test]
    fn walker_negation_excludes_matching_extension() {
        let scope = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let without_rs = walk_paths(&scope, Some("!*.rs"));
        for p in &without_rs {
            assert_ne!(
                p.extension().and_then(|e| e.to_str()),
                Some("rs"),
                ".rs file leaked through negation: {}",
                p.display()
            );
        }
    }

    #[test]
    fn walker_empty_string_equals_none() {
        let scope = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let all = walk_paths(&scope, None);
        let empty = walk_paths(&scope, Some(""));
        assert_eq!(all.len(), empty.len(), "empty glob should behave like None");
    }

    #[test]
    fn walker_invalid_glob_returns_error() {
        let scope = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let result = walker(&scope, Some("[unclosed"));
        match result {
            Err(TilthError::InvalidQuery { query, reason }) => {
                assert_eq!(query, "[unclosed");
                assert!(
                    reason.contains("invalid glob"),
                    "reason should mention 'invalid glob': {reason}"
                );
            }
            Err(other) => panic!("expected InvalidQuery, got {other}"),
            Ok(_) => panic!("expected Err for invalid glob, got Ok"),
        }
    }

    #[test]
    fn walker_brace_expansion_matches_multiple_extensions() {
        let scope = Path::new(env!("CARGO_MANIFEST_DIR"));
        let filtered = walk_paths(scope, Some("*.{rs,toml}"));
        let exts = extensions(&filtered);
        assert!(
            exts.contains("rs"),
            "brace expansion should include .rs: {exts:?}"
        );
        assert!(
            exts.contains("toml"),
            "brace expansion should include .toml: {exts:?}"
        );
        for ext in &exts {
            assert!(
                ext == "rs" || ext == "toml",
                "unexpected extension leaked: {ext}"
            );
        }
    }

    #[test]
    fn walker_whitelist_fewer_than_unfiltered() {
        // Use project root (not src/) — project root has .toml, .md, .lock etc.
        // alongside .rs files, so *.rs is guaranteed to be a strict subset.
        let scope = Path::new(env!("CARGO_MANIFEST_DIR"));
        let all = walk_paths(scope, None);
        let rs_only = walk_paths(scope, Some("*.rs"));
        assert!(
            rs_only.len() < all.len(),
            "whitelist ({}) should find fewer files than unfiltered ({})",
            rs_only.len(),
            all.len()
        );
    }

    #[test]
    fn walker_path_pattern_restricts_directory() {
        let scope = Path::new(env!("CARGO_MANIFEST_DIR"));
        let filtered = walk_paths(scope, Some("src/**/*.rs"));
        assert!(!filtered.is_empty(), "path pattern should find files");
        let src_dir = scope.join("src");
        for p in &filtered {
            assert!(
                p.starts_with(&src_dir),
                "file outside src/ leaked: {}",
                p.display()
            );
        }
    }

    // ── end-to-end through search functions ──

    #[test]
    fn content_search_glob_restricts_results() {
        let scope = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let all =
            content::search("TilthError", &scope, false, None, None, false).expect("search failed");
        let rs_only = content::search("TilthError", &scope, false, None, Some("*.rs"), false)
            .expect("search with glob failed");
        let toml_only = content::search("TilthError", &scope, false, None, Some("*.toml"), false)
            .expect("search with toml glob failed");

        assert!(all.total_found > 0, "unfiltered should find TilthError");
        assert!(rs_only.total_found > 0, "*.rs should find TilthError");
        assert_eq!(
            toml_only.total_found, 0,
            "*.toml should not find TilthError in Rust source"
        );
        for m in &rs_only.matches {
            assert_eq!(
                m.path.extension().and_then(|e| e.to_str()),
                Some("rs"),
                "non-.rs match leaked: {}",
                m.path.display()
            );
        }
    }

    #[test]
    fn symbol_search_glob_restricts_results() {
        let scope = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let rs_result = symbol::search("walker", &scope, None, Some("*.rs"), false)
            .expect("symbol search failed");
        let toml_result = symbol::search("walker", &scope, None, Some("*.toml"), false)
            .expect("symbol search with toml failed");

        assert!(rs_result.total_found > 0, "*.rs should find 'walker'");
        assert_eq!(
            toml_result.total_found, 0,
            "*.toml should not find 'walker'"
        );
        for m in &rs_result.matches {
            assert_eq!(
                m.path.extension().and_then(|e| e.to_str()),
                Some("rs"),
                "non-.rs match in symbol search: {}",
                m.path.display()
            );
        }
    }

    #[test]
    fn callers_search_glob_restricts_results() {
        let scope = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let bloom = crate::index::bloom::BloomFilterCache::new();
        let single: std::collections::HashSet<String> =
            std::iter::once("walker".to_string()).collect();
        let rs_callers = callers::find_callers_batch(
            &single,
            &scope,
            &bloom,
            Some("*.rs"),
            callers::BATCH_EARLY_QUIT,
        )
        .expect("callers failed");
        let toml_callers = callers::find_callers_batch(
            &single,
            &scope,
            &bloom,
            Some("*.toml"),
            callers::BATCH_EARLY_QUIT,
        )
        .expect("callers toml failed");

        assert!(
            !rs_callers.is_empty(),
            "*.rs should find callers of 'walker'"
        );
        assert!(
            toml_callers.is_empty(),
            "*.toml should not find callers of 'walker'"
        );
        for (_, c) in &rs_callers {
            assert_eq!(
                c.path.extension().and_then(|e| e.to_str()),
                Some("rs"),
                "non-.rs caller leaked: {}",
                c.path.display()
            );
        }
    }

    #[test]
    fn walker_follows_symlinked_file() {
        let tmp = tempfile::tempdir().unwrap();
        let real_dir = tmp.path().join("real");
        std::fs::create_dir(&real_dir).unwrap();
        std::fs::write(real_dir.join("hello.rs"), "fn main() {}").unwrap();

        let link_dir = tmp.path().join("linked");
        std::fs::create_dir(&link_dir).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(real_dir.join("hello.rs"), link_dir.join("hello.rs")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(real_dir.join("hello.rs"), link_dir.join("hello.rs"))
            .unwrap();

        let paths = walk_paths(tmp.path(), None);
        let names: Vec<&str> = paths
            .iter()
            .filter_map(|p| p.file_name()?.to_str())
            .collect();
        // Should find hello.rs twice: once in real/, once via the symlink in linked/
        assert_eq!(
            names.iter().filter(|n| **n == "hello.rs").count(),
            2,
            "expected hello.rs from both real and symlinked dirs, got: {names:?}"
        );
    }

    #[test]
    fn walker_follows_symlinked_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let real_dir = tmp.path().join("real_pkg");
        std::fs::create_dir(&real_dir).unwrap();
        std::fs::write(real_dir.join("lib.rs"), "pub fn add() {}").unwrap();
        std::fs::write(real_dir.join("util.rs"), "pub fn helper() {}").unwrap();

        // Symlink the entire directory
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real_dir, tmp.path().join("deps_link")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&real_dir, tmp.path().join("deps_link")).unwrap();

        let paths = walk_paths(tmp.path(), None);
        let link_files: Vec<_> = paths
            .iter()
            .filter(|p| p.starts_with(tmp.path().join("deps_link")))
            .collect();
        assert_eq!(
            link_files.len(),
            2,
            "expected 2 files via symlinked directory, got: {link_files:?}"
        );
    }

    #[test]
    fn walker_survives_symlink_cycle() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("real.rs"), "fn main() {}").unwrap();

        // Create a symlink cycle: loop -> .
        #[cfg(unix)]
        std::os::unix::fs::symlink(tmp.path(), tmp.path().join("loop")).unwrap();

        // Should complete without hanging — ignore crate detects the cycle via inode tracking
        let paths = walk_paths(tmp.path(), None);
        let names: Vec<&str> = paths
            .iter()
            .filter_map(|p| p.file_name()?.to_str())
            .collect();
        assert!(
            names.contains(&"real.rs"),
            "should find real.rs despite cycle: {names:?}"
        );
    }

    #[test]
    fn content_search_finds_symbol_through_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let real_dir = tmp.path().join("real");
        std::fs::create_dir(&real_dir).unwrap();
        std::fs::write(
            real_dir.join("api.rs"),
            "pub fn unique_symlink_test_symbol() {}",
        )
        .unwrap();

        // Symlink the directory into the search scope
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real_dir, tmp.path().join("linked")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&real_dir, tmp.path().join("linked")).unwrap();

        let result = content::search(
            "unique_symlink_test_symbol",
            tmp.path(),
            false,
            None,
            None,
            false,
        )
        .unwrap();
        // Should find the symbol in both real/api.rs and linked/api.rs
        assert!(
            result.total_found >= 2,
            "expected symbol found via both real and symlinked paths, got {}",
            result.total_found
        );
    }

    // ── enclosing_scope_label / markdown tests ──

    #[test]
    fn scope_label_code_combines_kind_and_name() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.ts");
        std::fs::write(&p, "class Foo {\n  bar() {\n    const x = 1;\n  }\n}\n").unwrap();
        let label = enclosing_scope_label(&p, 3, &OperationSources::default()).unwrap();
        assert_eq!(label, "function Foo.bar");
    }

    #[test]
    fn scope_label_markdown_returns_section() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.md");
        std::fs::write(
            &p,
            "# Top\n\n## Cost Accounting\n\nsome text\n\nmore text\n",
        )
        .unwrap();
        let label = enclosing_scope_label(&p, 7, &OperationSources::default()).unwrap();
        assert_eq!(label, "§Cost Accounting");
    }

    #[test]
    fn markdown_scope_truncates_long_headings() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.md");
        let long = "x".repeat(80);
        std::fs::write(&p, format!("## {long}\n\nbody\n")).unwrap();
        let label = markdown_enclosing_scope(&p, 3, &OperationSources::default()).unwrap();
        // 60-char window means 57 chars + "..." (display starts after the "§").
        assert!(label.starts_with("§"));
        assert!(label.ends_with("..."));
        assert_eq!(label.chars().count(), 1 + 57 + 3);
    }

    #[test]
    fn markdown_scope_returns_none_before_first_heading() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.md");
        std::fs::write(&p, "preamble line one\npreamble line two\n").unwrap();
        assert!(markdown_enclosing_scope(&p, 2, &OperationSources::default()).is_none());
    }

    /// `#`-prefixed lines inside fenced code blocks are NOT headings, so they
    /// must not become the enclosing scope label of usages on adjacent lines.
    /// Pre-fix this returned `§...` derived from a Python comment inside the
    /// fence; post-fix the AST owns the distinction.
    #[test]
    fn markdown_scope_skips_hashes_inside_fenced_code() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.md");
        std::fs::write(
            &p,
            "## Outer\n\nbefore fence\n\n```python\n# fake heading\nx = 1\n```\n\nafter fence\n",
        )
        .unwrap();
        // Line 7 (`x = 1`) is inside the fence; the only real heading is `## Outer`.
        let label = markdown_enclosing_scope(&p, 7, &OperationSources::default()).unwrap();
        assert_eq!(label, "§Outer");
    }

    /// `CommonMark` §4.6.1 caps ATX headings at 6 leading `#`s. 7+ hashes is
    /// raw text, not a heading, and must not surface as the enclosing scope.
    /// Pre-AST migration the regex matched `#######` and produced a bogus
    /// `§# Fake Heading 7` label.
    #[test]
    fn markdown_scope_rejects_seven_hash_atx_heading() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.md");
        std::fs::write(
            &p,
            "## Real Heading\n\nbody line\n\n####### Fake Heading 7\n\ntrailing line\n",
        )
        .unwrap();
        // Line 5 is the 7-hash line; line 7 is the line after.
        // Both should resolve to the only real heading, "Real Heading".
        assert_eq!(
            markdown_enclosing_scope(&p, 5, &OperationSources::default()),
            Some("§Real Heading".to_string())
        );
        assert_eq!(
            markdown_enclosing_scope(&p, 7, &OperationSources::default()),
            Some("§Real Heading".to_string())
        );
    }

    /// `CommonMark` §4.6.1 requires whitespace after the leading `#`s. `##NoSpace`
    /// is paragraph text, not a heading. Pre-AST migration the regex accepted
    /// it and produced `§NoSpace`.
    #[test]
    fn markdown_scope_rejects_no_space_atx_heading() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.md");
        std::fs::write(&p, "## Real Heading\n\n##NoSpace\n\ntrailing line\n").unwrap();
        // Line 3 is the no-space candidate; both line 3 and line 5 must
        // resolve to the only real heading.
        assert_eq!(
            markdown_enclosing_scope(&p, 3, &OperationSources::default()),
            Some("§Real Heading".to_string())
        );
        assert_eq!(
            markdown_enclosing_scope(&p, 5, &OperationSources::default()),
            Some("§Real Heading".to_string())
        );
    }

    #[test]
    fn format_single_match_renders_usage_scope_suffix() {
        use crate::types::Match;

        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.ts");
        std::fs::write(&p, "class Foo {\n  bar() {\n    const x = 1;\n  }\n}\n").unwrap();

        let m = Match {
            path: p.clone(),
            line: 3,
            text: "    const x = 1;".to_string(),
            is_definition: false,
            exact: false,
            file_lines: 5,
            mtime: SystemTime::now(),
            def_range: None,
            def_name: None,
            def_weight: 0,
            source_association: None,
            declaration: None,
            impl_target: None,
        };
        let cache = OutlineCache::new();
        let bloom = crate::index::bloom::BloomFilterCache::new();
        let mut expand_remaining = 0usize;
        let mut expanded_files: HashSet<PathBuf> = HashSet::new();
        let mut out = String::new();

        format_single_match(
            &m,
            tmp.path(),
            &cache,
            None,
            &bloom,
            &mut expand_remaining,
            &mut expanded_files,
            false,
            &mut out,
        );

        assert!(
            out.contains("[usage in function Foo.bar]"),
            "expected scope suffix in output, got: {out}"
        );
    }

    #[test]
    fn format_single_match_does_not_duplicate_expanded_line() {
        use crate::types::Match;

        // Small file (<50 lines) with no doc comment above the definition —
        // the outline-context preview at line 627 prints `m.text` verbatim,
        // and expand_match's whole-file expansion (small files expand fully,
        // see EXPAND_FULL_FILE_THRESHOLD) includes that same source line
        // again in the fence right below it.
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("small.rs");
        let src = "pub struct Thing;\n\nimpl Thing {\n    pub fn exit_code(&self) -> i32 {\n        0\n    }\n}\n";
        std::fs::write(&p, src).unwrap();

        let m = Match {
            path: p.clone(),
            line: 4,
            text: "    pub fn exit_code(&self) -> i32 {".to_string(),
            is_definition: true,
            exact: true,
            file_lines: 7,
            mtime: SystemTime::now(),
            def_range: Some((4, 6)),
            def_name: Some("exit_code".to_string()),
            def_weight: 100,
            source_association: None,
            declaration: None,
            impl_target: None,
        };
        let cache = OutlineCache::new();
        let bloom = crate::index::bloom::BloomFilterCache::new();
        let mut expand_remaining = 1usize;
        let mut expanded_files: HashSet<PathBuf> = HashSet::new();
        let mut out = String::new();

        format_single_match(
            &m,
            tmp.path(),
            &cache,
            None,
            &bloom,
            &mut expand_remaining,
            &mut expanded_files,
            false,
            &mut out,
        );

        let needle = "pub fn exit_code(&self) -> i32 {";
        let occurrences = out.matches(needle).count();
        assert_eq!(
            occurrences, 1,
            "expanded line must appear exactly once, got {occurrences} in: {out}"
        );
    }

    #[test]
    fn boost_query_routes_impl_target_into_truncation() {
        use crate::types::Match;

        let base = Match {
            path: PathBuf::from("x.rs"),
            line: 1,
            text: String::new(),
            is_definition: true,
            exact: true,
            file_lines: 200,
            mtime: SystemTime::now(),
            def_range: Some((1, 200)),
            def_name: None,
            def_weight: 0,
            source_association: None,
            declaration: None,
            impl_target: None,
        };

        // Plain definition: the searched token is the symbol name in def_name.
        let plain = Match {
            def_name: Some("handle_request".to_string()),
            ..base.clone()
        };
        assert_eq!(boost_query(&plain), Some("handle_request"));

        // impl match: def_name is the rendered label ("impl Iterator for Counter")
        // which never appears in the body — the searched trait lives in
        // impl_target. Regression guard for the dead-boost bug where def_name was
        // passed and the boost matched nothing.
        let impl_match = Match {
            def_name: Some("impl Iterator for Counter".to_string()),
            impl_target: Some("Iterator".to_string()),
            ..base.clone()
        };
        assert_eq!(boost_query(&impl_match), Some("Iterator"));

        // No names: no boost.
        assert_eq!(boost_query(&base), None);
    }

    #[test]
    fn write_hidden_tail_emits_only_when_truncated() {
        let mut out = String::new();
        write_hidden_tail(&mut out, 3, 3, "definitions");
        assert!(out.is_empty(), "no truncation → no tail line, got {out:?}");

        let mut out = String::new();
        write_hidden_tail(&mut out, 10, 14, "definitions");
        assert_eq!(out, "\n\n... and 4 more definitions. Narrow with scope.");

        let mut out = String::new();
        write_hidden_tail(&mut out, 3, 27, "usages");
        assert_eq!(out, "\n\n... and 24 more usages. Narrow with scope.");
    }

    #[test]
    fn count_label_renders_displayed_over_total_only_when_truncated() {
        // No truncation — bare count.
        assert_eq!(count_label(3, 3), "3");
        // Defensive: shown > total (shouldn't happen in practice) — bare count.
        assert_eq!(count_label(4, 3), "4");
        // Truncated — displayed/total form.
        assert_eq!(count_label(10, 14), "10/14");
        // Zero / zero — still bare (no header is emitted at zero anyway).
        assert_eq!(count_label(0, 0), "0");
    }

    #[test]
    fn format_single_match_inlines_markdown_section_body() {
        use crate::types::Match;

        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("notes.md");
        std::fs::write(
            &p,
            "# Top\n\n## Session 50\n\nFirst paragraph.\n\nSecond line.\n\n## Other\n\nUnrelated.\n",
        )
        .unwrap();

        // Mimic the `Match` `find_defs_markdown_buf` would produce for a
        // markdown-heading def: weight 30, def_range covers the section span.
        let m = Match {
            path: p.clone(),
            line: 3, // `## Session 50`
            text: "## Session 50".to_string(),
            is_definition: true,
            exact: true,
            file_lines: 10,
            mtime: SystemTime::now(),
            def_range: Some((3, 7)), // heading line .. section_end (1-indexed inclusive)
            def_name: Some("Session 50".to_string()),
            def_weight: 30,
            source_association: None,
            declaration: None,
            impl_target: None,
        };
        let cache = OutlineCache::new();
        let bloom = crate::index::bloom::BloomFilterCache::new();
        let mut expand_remaining = 0usize;
        let mut expanded_files: HashSet<PathBuf> = HashSet::new();
        let mut out = String::new();

        format_single_match(
            &m,
            tmp.path(),
            &cache,
            None,
            &bloom,
            &mut expand_remaining,
            &mut expanded_files,
            false,
            &mut out,
        );

        assert!(
            out.contains("First paragraph."),
            "section body must be inlined, got: {out:?}"
        );
        assert!(
            out.contains("Second line."),
            "section body must include later body lines, got: {out:?}"
        );
        assert!(
            !out.contains("Unrelated."),
            "must stop at section_end, got: {out:?}"
        );
    }

    #[test]
    fn format_single_match_caps_long_markdown_section() {
        use crate::types::Match;

        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("long.md");
        // Heading on line 1, then 60 body lines.
        let mut content = String::from("## Big Section\n");
        for i in 0..60 {
            let _ = writeln!(content, "body line {i}");
        }
        std::fs::write(&p, &content).unwrap();

        let m = Match {
            path: p.clone(),
            line: 1,
            text: "## Big Section".to_string(),
            is_definition: true,
            exact: true,
            file_lines: 61,
            mtime: SystemTime::now(),
            def_range: Some((1, 61)),
            def_name: Some("Big Section".to_string()),
            def_weight: 30,
            source_association: None,
            declaration: None,
            impl_target: None,
        };
        let cache = OutlineCache::new();
        let bloom = crate::index::bloom::BloomFilterCache::new();
        let mut expand_remaining = 0usize;
        let mut expanded_files: HashSet<PathBuf> = HashSet::new();
        let mut out = String::new();

        format_single_match(
            &m,
            tmp.path(),
            &cache,
            None,
            &bloom,
            &mut expand_remaining,
            &mut expanded_files,
            false,
            &mut out,
        );

        // Cap is 40 lines; expect 60 - 40 = 20 truncated.
        assert!(
            out.contains("body line 0"),
            "first body line must appear, got: {out:?}"
        );
        assert!(
            out.contains("body line 39"),
            "last kept body line must appear, got: {out:?}"
        );
        assert!(
            !out.contains("body line 40"),
            "body line beyond cap must be trimmed, got: {out:?}"
        );
        assert!(
            out.contains("20 more lines"),
            "must signal truncated lines, got: {out:?}"
        );
        assert!(
            out.contains("--expand"),
            "tail must point to --expand for full section, got: {out:?}"
        );
    }

    /// 99c4a3d's docstring is explicit: the markdown-section preview is a
    /// fixed-cost short-circuit that bypasses the --expand budget. This pins
    /// that intent — passing a non-zero `expand_remaining` must NOT cause
    /// the renderer to skip the cap. Without this guard, a future refactor
    /// could "fix" the short-circuit by routing through expand and turn
    /// every markdown-heading match into a multi-hundred-line preview.
    #[test]
    fn format_single_match_markdown_cap_bypasses_expand_budget() {
        use crate::types::Match;

        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("long.md");
        let mut content = String::from("## Big Section\n");
        for i in 0..60 {
            let _ = writeln!(content, "body line {i}");
        }
        std::fs::write(&p, &content).unwrap();

        let m = Match {
            path: p.clone(),
            line: 1,
            text: "## Big Section".to_string(),
            is_definition: true,
            exact: true,
            file_lines: 61,
            mtime: SystemTime::now(),
            def_range: Some((1, 61)),
            def_name: Some("Big Section".to_string()),
            def_weight: 30,
            source_association: None,
            declaration: None,
            impl_target: None,
        };
        let cache = OutlineCache::new();
        let bloom = crate::index::bloom::BloomFilterCache::new();
        // Non-zero expand budget — should NOT change the cap behavior.
        let mut expand_remaining = 5usize;
        let mut expanded_files: HashSet<PathBuf> = HashSet::new();
        let mut out = String::new();

        format_single_match(
            &m,
            tmp.path(),
            &cache,
            None,
            &bloom,
            &mut expand_remaining,
            &mut expanded_files,
            false,
            &mut out,
        );

        // Body lines beyond the cap must still be trimmed.
        assert!(
            !out.contains("body line 40"),
            "cap must apply even with non-zero expand budget, got: {out:?}"
        );
        assert!(
            out.contains("20 more lines"),
            "tail must still report truncated lines, got: {out:?}"
        );
        // Budget must be untouched — short-circuit returns before consuming it.
        assert_eq!(
            expand_remaining, 5,
            "markdown short-circuit must not consume expand budget"
        );
    }

    /// Worst-case bound: with `MAX_MATCHES` = 10 markdown-heading defs each
    /// hitting the 40-line preview cap, total inlined preview content is at
    /// most 10 × 40 = 400 lines. This pins the bound by exercising the cap
    /// and asserting the truncation shape, so a future bump of either
    /// constant can't silently inflate worst-case output without updating
    /// the test.
    #[test]
    fn markdown_preview_cap_constant_unchanged() {
        // Pin both constants — if either changes, this assertion fails and
        // the test author has to consider the worst-case product (currently
        // 10 * 40 = 400 lines extra in default preview, on top of the
        // outline context per match).
        assert_eq!(
            MARKDOWN_PREVIEW_MAX_LINES, 40,
            "if you change MARKDOWN_PREVIEW_MAX_LINES, also re-evaluate the \
             MAX_MATCHES * MARKDOWN_PREVIEW_MAX_LINES worst-case bound \
             (currently 10 * 40 = 400 lines per search response)"
        );
    }

    #[test]
    fn format_grouped_usages_emits_h3_heading() {
        use crate::types::Match;

        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.ts");
        std::fs::write(
            &p,
            "function host() {\n  doThing();\n  doThing();\n  doThing();\n}\n",
        )
        .unwrap();

        let mk = |line: u32| Match {
            path: p.clone(),
            line,
            text: "  doThing();".to_string(),
            is_definition: false,
            exact: false,
            file_lines: 5,
            mtime: SystemTime::now(),
            def_range: None,
            def_name: None,
            def_weight: 0,
            source_association: None,
            declaration: None,
            impl_target: None,
        };
        let m1 = mk(2);
        let m2 = mk(3);
        let m3 = mk(4);
        let group: Vec<&Match> = vec![&m1, &m2, &m3];
        let mut out = String::new();
        format_grouped_usages(&group, tmp.path(), &OperationSources::default(), &mut out);

        assert!(
            out.starts_with("\n\n### "),
            "grouped-usage heading must be H3, got: {out:?}"
        );
        assert!(
            !out.starts_with("\n\n## "),
            "grouped-usage heading must not be H2, got: {out:?}"
        );
    }

    // Verify that format_matches records segment byte ranges correctly.
    // Each push must cover non-empty, non-overlapping ranges that index into `out`.
    #[test]
    fn format_matches_segments_record_correct_byte_ranges() {
        use crate::index::bloom::BloomFilterCache;
        use crate::types::Match;

        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.rs");
        std::fs::write(&p, "fn alpha() {}\nfn beta() {}\nfn gamma() {}\n").unwrap();

        let mk = |line: u32, weight: u16, name: &str| Match {
            path: p.clone(),
            line,
            text: format!("fn {name}()"),
            is_definition: true,
            exact: true,
            file_lines: 3,
            mtime: SystemTime::now(),
            def_range: Some((line, line)),
            def_name: Some(name.to_string()),
            def_weight: weight,
            source_association: None,
            declaration: None,
            impl_target: None,
        };

        let matches = vec![mk(1, 30, "alpha"), mk(2, 10, "beta"), mk(3, 50, "gamma")];
        let cache = OutlineCache::new();
        let bloom = BloomFilterCache::new();
        let mut out = String::from("HEADER");
        let mut segments: Vec<(i64, usize, usize)> = Vec::new();
        let mut segment_rows = Vec::new();
        let mut expand_remaining = 0usize;
        let mut expanded_files = HashSet::new();
        let sources = OperationSources::default();

        format_matches(
            &matches,
            tmp.path(),
            &cache,
            None,
            &bloom,
            &sources,
            &mut expand_remaining,
            &mut expanded_files,
            &mut out,
            &mut segments,
            &mut segment_rows,
        );

        // One segment per match (all singletons — definitions are never grouped).
        assert_eq!(segments.len(), 3, "expected one segment per match");

        // Values must match def_weight casts.
        assert_eq!(segments[0].0, 30i64);
        assert_eq!(segments[1].0, 10i64);
        assert_eq!(segments[2].0, 50i64);

        // Ranges must be valid, non-empty, and non-overlapping.
        let mut cursor = "HEADER".len();
        for (i, &(_, start, end)) in segments.iter().enumerate() {
            assert!(start >= cursor, "segment {i} start < cursor");
            assert!(end > start, "segment {i} is empty");
            assert!(end <= out.len(), "segment {i} end out of bounds");
            // Slice must not panic (validates char-boundary alignment).
            let _ = &out[start..end];
            cursor = end;
        }
    }

    // ── SAVINGS tests ───────────────────────────────────────────

    /// A search that expands a definition large enough to trigger
    /// `select_diverse_lines` (>= 80-line body) must record savings.
    /// A search whose body is short records nothing extra from truncation.
    #[test]
    fn search_truncation_records_savings() {
        use crate::session::Session;
        use crate::types::Match;

        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("big.rs");

        // Build a function body >= 80 lines so select_diverse_lines fires.
        let mut src = String::from("pub fn big_fn() {\n");
        for i in 0..85 {
            let _ = writeln!(src, "    let v{i} = {i};");
        }
        src.push_str("}\n");
        std::fs::write(&p, &src).unwrap();

        let total_lines = src.lines().count() as u32;
        let m = Match {
            path: p.clone(),
            line: 1,
            text: "pub fn big_fn() {".to_string(),
            is_definition: true,
            exact: true,
            file_lines: total_lines,
            mtime: std::time::SystemTime::now(),
            def_range: Some((1, total_lines)),
            def_name: Some("big_fn".to_string()),
            def_weight: 0,
            source_association: None,
            declaration: None,
            impl_target: None,
        };

        let cache = OutlineCache::new();
        let bloom = crate::index::bloom::BloomFilterCache::new();
        let session = Session::default();
        let mut expand_remaining = 5usize;
        let mut expanded_files: HashSet<PathBuf> = HashSet::new();
        let mut out = String::new();

        format_single_match(
            &m,
            tmp.path(),
            &cache,
            Some(&session),
            &bloom,
            &mut expand_remaining,
            &mut expanded_files,
            false,
            &mut out,
        );

        let (baseline, saved) = session.savings();
        assert!(
            baseline > 0,
            "truncation path must record a non-zero baseline, got baseline={baseline}"
        );
        assert!(
            saved > 0,
            "truncation must save tokens vs full body, got saved={saved}"
        );
    }

    /// A search on a small definition (body < 80 lines) goes through
    /// `expand_match` but never hits the truncation branch, so savings
    /// remain zero.
    #[test]
    fn search_no_truncation_records_no_savings() {
        use crate::session::Session;
        use crate::types::Match;

        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("small.rs");
        let src = "pub fn small_fn() {\n    let x = 1;\n    x\n}\n";
        std::fs::write(&p, src).unwrap();

        let m = Match {
            path: p.clone(),
            line: 1,
            text: "pub fn small_fn() {".to_string(),
            is_definition: true,
            exact: true,
            file_lines: 4,
            mtime: std::time::SystemTime::now(),
            def_range: Some((1, 4)),
            def_name: Some("small_fn".to_string()),
            def_weight: 0,
            source_association: None,
            declaration: None,
            impl_target: None,
        };

        let cache = OutlineCache::new();
        let bloom = crate::index::bloom::BloomFilterCache::new();
        let session = Session::default();
        let mut expand_remaining = 5usize;
        let mut expanded_files: HashSet<PathBuf> = HashSet::new();
        let mut out = String::new();

        format_single_match(
            &m,
            tmp.path(),
            &cache,
            Some(&session),
            &bloom,
            &mut expand_remaining,
            &mut expanded_files,
            false,
            &mut out,
        );

        let (baseline, saved) = session.savings();
        assert_eq!(baseline, 0, "no truncation => no savings recorded");
        assert_eq!(saved, 0, "no truncation => no savings recorded");
    }

    /// Regression proof for the ranked budget boundary: the exact matched
    /// declaration has its dedicated target budget, while references remain
    /// compact live evidence under the shared lane budget. A same-name usage
    /// file ranks strongly enough to ensure this is not an ordering accident.
    /// Neither domain may be positionally tail-cut.
    #[test]
    fn exact_ranked_target_budget_is_separate_from_reference_budget() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("definition.rs"),
            "pub fn budget_probe_target() {\n    let _ = 1;\n}\n",
        )
        .unwrap();
        // A same-name usage file makes the reference rank highly and gives it
        // a large enclosing function. The ranked card must still protect the
        // matched declaration rather than treating target and references as
        // interchangeable value blocks.
        let mut usage_body = String::from("fn calls_it() {\n    budget_probe_target();\n");
        for i in 0..60 {
            let _ = writeln!(usage_body, "    let filler_{i} = {i};");
        }
        usage_body.push_str("}\n");
        std::fs::write(tmp.path().join("budget_probe_target.rs"), &usage_body).unwrap();

        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = crate::index::bloom::BloomFilterCache::new();

        let out = search_symbol_expanded(
            "budget_probe_target",
            tmp.path(),
            &cache,
            &session,
            &bloom,
            2,
            None,
            None,
            false,
            Some(400),
        )
        .unwrap();

        assert!(
            out.contains("fn budget_probe_target"),
            "the exact matched declaration is outside the shared lane budget: {out}"
        );
        assert!(out.contains("references:"));
        assert!(
            out.contains("budget_probe_target();"),
            "the minimum live reference remains useful under pressure: {out}"
        );
        assert!(
            !out.contains("... truncated ("),
            "the ranked card must not be positionally tail-cut: {out}"
        );
    }

    /// Regression guard: omitting the budget (`None`) must produce byte-
    /// identical output to before this fix — `DEFAULT_BUDGET` remains the
    /// default, it is simply no longer a hardcode that shadows a real
    /// caller-supplied budget.
    #[test]
    fn search_symbol_expanded_no_budget_matches_default_budget_output() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("definition.rs"),
            "pub fn budget_probe_target() {\n    let _ = 1;\n}\n",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("budget_probe_target.rs"),
            "fn calls_it() {\n    budget_probe_target();\n}\n",
        )
        .unwrap();

        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = crate::index::bloom::BloomFilterCache::new();

        let with_none = search_symbol_expanded(
            "budget_probe_target",
            tmp.path(),
            &cache,
            &session,
            &bloom,
            2,
            None,
            None,
            false,
            None,
        )
        .unwrap();

        let session2 = Session::new();
        let with_explicit_default = search_symbol_expanded(
            "budget_probe_target",
            tmp.path(),
            &cache,
            &session2,
            &bloom,
            2,
            None,
            None,
            false,
            Some(crate::budget::DEFAULT_BUDGET),
        )
        .unwrap();

        assert_eq!(
            with_none, with_explicit_default,
            "omitting budget must be identical to explicitly passing DEFAULT_BUDGET"
        );
    }

    #[test]
    fn search_expansion_and_snapshots_reuse_the_worker_read() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("one.rs"),
            "fn one_read_target() {\n    one_read_target();\n}\n",
        )
        .unwrap();
        let result =
            content::search("one_read_target", root.path(), false, None, None, false).unwrap();
        let before = result.sources.counters();
        assert_eq!(before.0, 1);
        let cache = OutlineCache::new();
        let bloom = crate::index::bloom::BloomFilterCache::new();
        let formatted = format_search_result_typed(&result, &cache, None, &bloom, 1, None).unwrap();
        let after = result.sources.counters();
        assert_eq!(after.0, 1, "expansion must not reopen the matched file");
        assert!(
            after.1 >= 1,
            "expansion should reuse retained operation text"
        );
        assert_eq!(formatted.source_snapshots.len(), 1);
    }

    #[test]
    fn caller_context_keeps_callable_hierarchy_and_live_declarations() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runner.ts");
        let source = "function needle(value: number) { return value; }\nclass Runner {\n  run(\n    value: number,\n  ) {\n    // Keep the input and result visible.\n    const first = needle(value);\n    const callback = (next: number) => {\n      const second = needle(next);\n      return second;\n    };\n    return callback(first);\n  }\n}\nconst top = needle(0);\n";
        std::fs::write(&path, source).unwrap();
        let matches = callers::find_callers_batch(
            &HashSet::from(["needle".to_string()]),
            root.path(),
            &crate::index::bloom::BloomFilterCache::new(),
            None,
            100,
        )
        .unwrap();
        assert_eq!(matches.len(), 3);
        let caller = |line| {
            &matches
                .iter()
                .find(|(_, caller)| caller.line == line)
                .unwrap()
                .1
        };
        assert_eq!(caller(7).caller_range, Some((3, 13)));
        assert_eq!(caller(9).caller_range, Some((8, 11)));
        for line in [7, 9, 15] {
            let (text, rows) = caller_lane_block(&[caller(line)], None, false, &[]);
            if line != 15 {
                assert!(text.contains("[2-14]: class Runner {"), "{text}");
                assert!(text.contains("[3-13]:   run("), "{text}");
                assert!(text.contains("4:     value: number,"));
                assert!(text.contains("5:   ) {"));
            } else {
                assert!(text.starts_with("15: const top = needle(0);"), "{text}");
                assert!(!text.contains("[15-15]"));
            }
            if line == 7 {
                assert!(text.contains("12:     return callback(first);"));
            }
            if line == 9 {
                assert!(text.contains("[8-11]:     const callback"));
            }
            for row in rows {
                assert_eq!(
                    source.lines().nth(row.line as usize - 1),
                    Some(row.text.as_str())
                );
            }
        }
        let session = Session::new();
        session.record_expand(
            &path,
            3,
            std::fs::metadata(&path).unwrap().modified().unwrap(),
        );
        let (seen, _) = caller_lane_block(&[caller(7)], Some(&session), false, &[]);
        assert!(seen.contains("[2-14]: class Runner {"));
        assert!(seen.contains("7:     const first = needle(value);"));
        assert!(!seen.contains("return callback(first)"));
        session.record_expand(
            &path,
            8,
            std::fs::metadata(&path).unwrap().modified().unwrap(),
        );
        let (seen_callback, _) = caller_lane_block(&[caller(9)], Some(&session), false, &[]);
        assert!(seen_callback.contains("9:       const second = needle(next);"));
        assert!(!seen_callback.contains("return second"));
    }

    #[test]
    fn prepared_comments_remain_live_without_displacing_the_target() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("work.rs");
        for count in [2u32, 12, 160] {
            let source = format!(
                "{}fn Work() {{\n    let value = 1;\n}}\n",
                "// Context\n".repeat(count as usize)
            );
            std::fs::write(&path, &source).unwrap();
            let matched = Match {
                path: path.clone(),
                line: count + 1,
                text: "fn Work() {".into(),
                is_definition: true,
                exact: true,
                file_lines: count + 3,
                mtime: std::fs::metadata(&path).unwrap().modified().unwrap(),
                def_range: Some((count + 1, count + 3)),
                def_name: Some("Work".into()),
                def_weight: 100,
                source_association: None,
                declaration: None,
                impl_target: None,
            };
            let lanes = lanes::LaneBundle::from_prepared(
                &matched,
                Default::default(),
                "function".into(),
                Some(1),
            );
            let result = SearchResult {
                query: "Work".into(),
                scope: directory.path().into(),
                matches: vec![matched],
                sources: Default::default(),
                total_found: 1,
                definitions: 1,
                usages: 0,
                facet_totals: crate::types::FacetTotals {
                    definitions: 1,
                    ..Default::default()
                },
            };
            let session = Session::new();
            session.record_expand(
                &path,
                count + 1,
                std::fs::metadata(&path).unwrap().modified().unwrap(),
            );
            let card = format_exact_ranked_card(
                &result,
                &OutlineCache::new(),
                Some(&session),
                Some(&lanes),
            )
            .unwrap();
            assert!(card
                .source_rows
                .iter()
                .any(|row| row.line == count + 1 && row.text == "fn Work() {"));
            assert!(card.source_rows.len() <= RANKED_TARGET_NONBLANK_CAP);
            if count < 150 {
                assert!(card
                    .source_rows
                    .iter()
                    .any(|row| row.line == 1 && row.text == "// Context"));
            } else {
                assert!(card.text.contains("omitted for budget"));
            }
            assert!(!card.text.contains("already read"));
            for row in card.source_rows {
                assert_eq!(
                    source.lines().nth(row.line as usize - 1),
                    Some(row.text.as_str())
                );
            }
        }
    }

    #[test]
    fn go_nested_targets_render_only_ordered_parent_headings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker.go");
        for (source, start, kind, expected) in [
            ("package sample\ntype Worker struct {\n    Earlier int\n    Name string\n}\n", 4, "field", vec![2, 4]),
            ("package sample\ntype Worker interface {\n    Earlier()\n    Run()\n}\n", 4, "method", vec![2, 4]),
            ("package sample\ntype Worker[T interface {\n    ~string | ~int\n}] struct {\n    Earlier int\n    Name T\n}\n", 6, "field", vec![2, 3, 4, 6]),
        ] {
            std::fs::write(&path, source).unwrap();
            let matched = Match {
                path: path.clone(), line: start, text: source.lines().nth(start as usize - 1).unwrap().into(),
                is_definition: true, exact: true, file_lines: source.lines().count() as u32,
                mtime: std::fs::metadata(&path).unwrap().modified().unwrap(),
                source_association: None,
                declaration: None,
                def_range: Some((start, start)), def_name: Some("Worker member".into()), def_weight: 100, impl_target: None,
            };
            let bundle = lanes::LaneBundle::from_prepared(&matched, Default::default(), kind.into(), None);
            let result = SearchResult {
                query: "Worker member".into(), scope: directory.path().into(), matches: vec![matched], sources: Default::default(),
                total_found: 1, definitions: 1, usages: 0,
                facet_totals: crate::types::FacetTotals { definitions: 1, ..Default::default() },
            };
            let card = format_exact_ranked_card(&result, &OutlineCache::new(), None, Some(&bundle)).unwrap();
            assert_eq!(card.source_rows.iter().map(|row| row.line).collect::<Vec<_>>(), expected, "{}", card.text);
            assert!(!card.source_rows.iter().any(|row| row.text.trim() == "}" || row.text.contains("Earlier")), "{}", card.text);
            for row in &card.source_rows {
                assert_eq!(source.lines().nth(row.line as usize - 1), Some(row.text.as_str()));
            }
        }
    }

    #[test]
    fn prepared_field_and_method_keep_enclosing_signatures_without_duplicate_parents() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested.ts");
        let source = "function make(\n  seed: number,\n) {\n  class Box\n    extends Base {\n    field: number;\n    run(\n      value: number,\n    ) { return value; }\n  }\n}\n";
        std::fs::write(&path, source).unwrap();
        for (kind, start, end) in [("field", 6, 6), ("method", 7, 9)] {
            let matched = Match {
                path: path.clone(),
                line: start,
                text: source.lines().nth(start as usize - 1).unwrap().into(),
                is_definition: true,
                exact: true,
                file_lines: 11,
                mtime: std::fs::metadata(&path).unwrap().modified().unwrap(),
                def_range: Some((start, end)),
                def_name: Some(kind.into()),
                def_weight: 100,
                source_association: None,
                declaration: None,
                impl_target: None,
            };
            let bundle =
                lanes::LaneBundle::from_prepared(&matched, Default::default(), kind.into(), None);
            let result = SearchResult {
                query: kind.into(),
                scope: directory.path().into(),
                matches: vec![matched],
                sources: Default::default(),
                total_found: 1,
                definitions: 1,
                usages: 0,
                facet_totals: crate::types::FacetTotals {
                    definitions: 1,
                    ..Default::default()
                },
            };
            let card = format_exact_ranked_card(&result, &OutlineCache::new(), None, Some(&bundle))
                .unwrap();
            assert!(
                card.text.contains("[1-11]: function make("),
                "{}",
                card.text
            );
            assert!(card.text.contains("[4-10]:   class Box"), "{}", card.text);
            for line in (1..=5).chain(start..=end) {
                assert_eq!(
                    card.source_rows
                        .iter()
                        .filter(|row| row.line == line
                            && row.text == source.lines().nth(line as usize - 1).unwrap())
                        .count(),
                    1,
                    "line {line}: {}",
                    card.text
                );
            }
            let definition = callees::DeclarationCandidate {
                name: kind.into(),
                file: path.clone(),
                start_line: start,
                end_line: end,
                signature: None,
                declaration: None,
            };
            let (text, rows) = callee_lane_block(&definition, &result, &[]).unwrap();
            assert!(text.contains("[1-11]: function make("));
            assert!(text.contains("[4-10]:   class Box"));
            let coverage: Vec<_> = card.source_rows.iter().collect();
            let (_, remaining) = callee_lane_block(&definition, &result, &coverage).unwrap();
            assert!(remaining.iter().all(|row| row.line >= start));
            assert!(rows.len() <= RANKED_TARGET_NONBLANK_CAP);
        }
        let inline = "class Box { field: number; run() {} }\n";
        let (_, parents) = enclosing_declaration_block(&path, inline, 1, 1, &[]);
        assert!(
            parents.is_empty(),
            "same-line declaration row already carries its enclosing class"
        );
    }

    #[test]
    fn compacted_prepared_type_keeps_complete_member_declarations() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("box.ts");
        let fields: String = (0..200)
            .map(|index| format!("  field{index}: number;\n"))
            .collect();
        let source = format!("class Box {{\n{fields}  Run(\n    value: number,\n  ): number {{ return value; }}\n}}\n");
        std::fs::write(&path, &source).unwrap();
        let matched = Match {
            path: path.clone(),
            line: 1,
            text: "class Box {".into(),
            is_definition: true,
            exact: true,
            file_lines: 205,
            mtime: std::fs::metadata(&path).unwrap().modified().unwrap(),
            def_range: Some((1, 205)),
            def_name: Some("Box".into()),
            def_weight: 100,
            source_association: None,
            declaration: None,
            impl_target: None,
        };
        let bundle = lanes::LaneBundle::from_prepared(
            &matched,
            lanes::SymbolLanes {
                member_definitions: vec![callees::DeclarationCandidate {
                    name: "Box::Run".into(),
                    file: path.clone(),
                    start_line: 202,
                    end_line: 204,
                    signature: None,
                    declaration: None,
                }],
                ..Default::default()
            },
            "class".into(),
            None,
        );
        let result = SearchResult {
            query: "Box".into(),
            scope: directory.path().into(),
            matches: vec![matched],
            sources: Default::default(),
            total_found: 1,
            definitions: 1,
            usages: 0,
            facet_totals: crate::types::FacetTotals {
                definitions: 1,
                ..Default::default()
            },
        };
        let card =
            format_exact_ranked_card(&result, &OutlineCache::new(), None, Some(&bundle)).unwrap();
        assert!(card.text.contains("omitted at the 150-line card limit"));
        assert!(card
            .text
            .contains("captured member definitions — membership, not invocation"));
        for line in 202..=204 {
            assert_eq!(
                card.source_rows
                    .iter()
                    .filter(|row| row.path == path
                        && row.line == line
                        && source.lines().nth(line as usize - 1) == Some(row.text.as_str()))
                    .count(),
                1,
                "missing declaration line {line}: {}",
                card.text
            );
        }
    }

    #[test]
    fn class_inventory_paging_keeps_overlapping_header_rows_atomic() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shared.ts");
        let source = "class Shared {\n  a() {} b(\n    value: string\n  ): string { return value; } c(\n  ): number { return 1; }\n  d() {}\n}\n";
        std::fs::write(&path, source).unwrap();
        let result = symbol::search("Shared", directory.path(), None, None, false).unwrap();
        let matched = exact_primary_definition(&result).unwrap();
        let regions = [RankedRegion { start: 1, end: 7 }];
        let (mut text, mut rows) = (String::new(), Vec::new());
        render_ranked_regions_with_progress(&mut text, &mut rows, matched, source, &regions, None, 3, None);
        assert_eq!(rows.iter().map(|row| row.line).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5], "overlapping headers are one indivisible unit: {text}");
        let mut progress = continuation::Progress::default();
        progress.record(continuation::GroupKey::Target(lanes::target_key(matched)), &target_requirements(matched, source, &regions), &rows, None);
        text.clear(); rows.clear();
        render_ranked_regions_with_progress(&mut text, &mut rows, matched, source, &regions, None, 3, Some(&progress));
        assert_eq!(rows.iter().map(|row| row.line).collect::<Vec<_>>(), vec![1, 6], "next page must advance, not repeat prior member headers: {text}");
    }

    #[test]
    fn exact_ranked_typescript_class_is_one_live_region() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("card.ts"),
            "export class Card {\n  private value: number;\n  constructor(value: number) {\n    this.value = value;\n  }\n  refresh(next: number): void {\n    this.value = next;\n  }\n  render(): string {\n    return String(this.value);\n  }\n}\n\nexport function build(): Card {\n  return new Card(1);\n}\n",
        )
        .unwrap();
        let output = search_symbol_expanded(
            "Card",
            root.path(),
            &OutlineCache::new(),
            &Session::new(),
            &crate::index::bloom::BloomFilterCache::new(),
            2,
            None,
            None,
            false,
            Some(4_000),
        )
        .unwrap();
        assert!(output.starts_with("# Card — card.ts #"));
        assert!(output.contains("kind: class"));
        assert!(output.contains("[1-12]: export class Card {"));
        assert!(output.contains("12: }"));
        assert!(!output.contains(" | "));
        assert!(!output.contains("### card.ts"));
        assert!(output.contains("[14-16]: export function build(): Card {"));
        assert!(!output.contains("14: export function build"));
        assert!(!output.contains("[14-16]: function build\n"));
        assert!(output.contains("15:   return new Card(1);"));
    }

    #[test]
    fn caller_regions_keep_callback_chain_and_complete_boundary_statements() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pipeline.ts");
        let source = "function Needle(item: number) { return item; }\nfunction pipeline(items: number[]) {\n  const size = items.length;\n  const ordered = items.map(item => Needle(item))\n    .sort((a, b) => a - b);\n  const payload = {\n    ordered,\n    count: size,\n  };\n  return payload;\n}\n";
        std::fs::write(&path, source).unwrap();
        let matches = callers::find_callers_batch(
            &HashSet::from(["Needle".into()]),
            dir.path(),
            &crate::index::bloom::BloomFilterCache::new(),
            None,
            100,
        )
        .unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].1.caller_range, Some((4, 4)));
        let (compact, _) = caller_lane_block(&[&matches[0].1], None, false, &[]);
        assert!(compact.contains("[2-11]: function pipeline"));
        assert!(
            compact.contains("5:     .sort((a, b) => a - b);"),
            "{compact}"
        );
        let (whole, _) = caller_lane_block(&[&matches[0].1], None, true, &[]);
        assert!(whole.contains("3:   const size = items.length;"));
        assert!(whole.contains("10:   return payload;"));
        assert_eq!(
            scope::complete_statement_window(&path, source, 4, 6),
            (4, 9)
        );
        for (path, source) in [
            (
                "a.rs",
                "fn wrap() {\n    let values = [\n        1,\n        2,\n    ];\n}\n",
            ),
            (
                "a.py",
                "def wrap():\n    values = [\n        1,\n        2,\n    ]\n",
            ),
        ] {
            assert_eq!(
                scope::complete_statement_window(Path::new(path), source, 3, 3),
                (2, 5)
            );
        }
    }

    #[test]
    fn focused_retained_oversized_recovery_names_withheld_owner_without_credit() {
        use crate::dispatch::{dispatch_read_only, NativeSession, OperationContext, ReadFormat};
        for safeguard in ["whole-page", "source-line", "signature"] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            let path = root.join("watcher.ts");
            let parameters = if safeguard == "signature" {
                (0..100).map(|index| format!("parameter{index}: string")).collect::<Vec<_>>().join(", ")
            } else { String::new() };
            let padding = if safeguard == "source-line" {
                format!("    this.message = '{}';\n", "x".repeat(RANKED_SOURCE_LINE_BYTES))
            } else {
                "    this.pending += 1; // operation state established before finalization\n".repeat(if safeguard == "whole-page" { 360 } else { 8 })
            };
            let source = format!("class FileWatcher {{\n  private scheduleRetrySync(delayMs: number) {{\n    this.delay = delayMs;\n  }}\n  private flush({parameters}) {{\n    if (this.stopped) return;\n    try {{\n{padding}    }} finally {{\n      this.syncing = false;\n      this.scheduleRetrySync(5);\n    }}\n  }}\n  private steady() {{\n    this.scheduleRetrySync(1);\n    return this.ready;\n  }}\n  unrelated() {{ UNRELATED_SIBLING_SENTINEL(); }}\n}}\n");
            std::fs::write(&path, &source).unwrap();
            let input = source.lines().collect::<Vec<_>>();
            let start = input.iter().position(|line| line.contains("private flush(")).unwrap() as u32 + 1;
            let end = input.iter().position(|line| line.contains("private steady()")).unwrap() as u32;
            let native = NativeSession::new(&root, false).unwrap();
            let context = OperationContext::for_session(&native, ReadFormat::Plain, true);
            let args = serde_json::json!({"query":"FileWatcher.scheduleRetrySync", "kind":"symbol",
                "scope":root, "expand":2, "retainRankedRender":true,
                "focus":{"target":format!("{}::FileWatcher.scheduleRetrySync", path.display())}});
            let first = dispatch_read_only("pi_nav_search", &args, &native, &context).unwrap();
            let origin = first.ranked_render_cursor.as_ref().unwrap();
            let retained = native.session.get_ranked_cursor(origin).unwrap();
            assert!(!retained.evidence.frame.as_ref().unwrap().exact);
            let selected = retained.evidence.collection.result().matches.iter()
                .find(|matched| matched.is_definition).unwrap();
            let callers = &retained.evidence.collection.lanes().unwrap().get(selected).unwrap().callers;
            let (index, caller) = callers.iter().enumerate()
                .find(|(_, caller)| caller.caller_range == Some((start, end))).unwrap();
            let key = continuation::GroupKey::Lane(lanes::target_key(selected), "callers", index);
            let required = caller_requirements(caller);
            for line in start..=end {
                assert!(required.contains(&(path.clone(), line)), "{safeguard}: lost whole-owner obligation {line}");
            }
            let fitted = dispatch_read_only("pi_nav_search", &serde_json::json!({"renderRanked":origin,
                "rankedRenderAllowance":1200}), &native, &context).unwrap();
            for page in [&first, &fitted] {
                assert!(page.text.contains("whole recovery context withheld"), "{safeguard}: {}", page.text);
                assert!(page.text.contains(&format!("{}:{start}-{end}", path.display())), "{}", page.text);
                assert!(page.text.contains("read({path:"), "{}", page.text);
                assert!(page.text.contains("return this.ready;"), "usable sibling lost: {}", page.text);
                assert!(!page.text.contains("UNRELATED_SIBLING_SENTINEL"));
                let rows = page.structured["data"]["sourceRows"].as_array().unwrap();
                for row in rows {
                    let line = row["line"].as_u64().unwrap() as u32;
                    assert!(!(start..=end).contains(&line), "withheld body received source authority");
                    assert_eq!(row["text"], input[line as usize - 1]);
                }
                let cursor = page.structured["data"]["cursor"].as_str().unwrap();
                let pending = native.session.get_ranked_cursor(cursor).unwrap();
                assert!(!pending.progress.complete.contains(&key), "caption completed recovery group");
                let refused = dispatch_read_only("pi_nav_search", &serde_json::json!({"cursor":cursor}), &native, &context);
                assert!(refused.is_err(), "nonprogress must refuse, not return another public cursor");
                let private = dispatch_read_only("pi_nav_search", &serde_json::json!({"renderRanked":cursor}), &native, &context).unwrap();
                assert!(private.ranked_render_unavailable.is_some());
                assert!(private.structured["data"]["cursor"].is_null());
                assert_eq!(private.structured["data"]["sourceRows"], serde_json::json!([]));
            }
        }
    }

    #[test]
    fn withheld_recovery_caption_escapes_read_selector_for_odd_filenames() {
        // Identity/range stays human-readable; the read argument is rendered
        // with JSON string escaping so quotes/backslashes cannot break it.
        let caption = whole_recovery_withheld_caption(
            Path::new("/tmp/a\"b\\c.ts"),
            (7, 12),
            "whole owner exceeds the 4000-token whole-card safeguard",
        );
        assert!(
            caption.contains("whole recovery context withheld: /tmp/a\"b\\c.ts:7-12"),
            "{caption}"
        );
        assert!(
            caption.contains("Exact source: read({path: \"/tmp/a\\\"b\\\\c.ts:7-12\"})"),
            "{caption}"
        );
    }

    #[test]
    fn focused_retained_retry_operation_keeps_recovery_and_pending_requirements() {
        use crate::dispatch::{dispatch_read_only, NativeSession, OperationContext, ReadFormat};
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let path = root.join("watcher.ts");
        // FileWatcher retry witness: retain its guards, scoped input, both
        // failure paths and finalization. No indexed/prepared evidence is used.
        let source = r#"class FileWatcher {
  private scheduleRetrySync(delayMs: number): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush();
    }, delayMs);
  }
  private async flush(): Promise<void> {
    if (this.syncing || this.stopped) return;
    this.syncStartedMs = Date.now();
    this.syncing = true;
    const scoped =
      !this.needsFullScan && this.pendingFiles.size > 0 && this.pendingFiles.size <= SCOPED_SYNC_MAX_PENDING
        ? [...this.pendingFiles.keys()]
        : undefined;
    try {
      const result = await this.syncFn(scoped);
      if (!scoped) this.needsFullScan = false;
      this.lockRetryCount = 0;
      this.syncFailureRetryCount = 0;
      for (const [filePath, info] of this.pendingFiles) {
        if (info.lastSeenMs <= this.syncStartedMs) {
          this.pendingFiles.delete(filePath);
        }
      }
      this.onSyncComplete?.(result);
    } catch (err) {
      if (err instanceof LockUnavailableError) {
        this.lockRetryCount += 1;
        logDebug('Watch sync skipped: file lock unavailable', {
          pendingFiles: this.pendingFiles.size,
          retryCount: this.lockRetryCount,
        });
        if (this.lockRetryCount > MAX_LOCK_RETRIES) {
          this.degrade('CodeGraph file lock held past the retry budget', {
            pendingFiles: this.pendingFiles.size, retryCount: this.lockRetryCount
          });
        }
      } else {
        this.lockRetryCount = 0;
        this.syncFailureRetryCount += 1;
        const error = err instanceof Error ? err : new Error(String(err));
        logWarn('Watch sync failed', {
          error: error.message,
          retryCount: this.syncFailureRetryCount,
        });
        this.onSyncError?.(error);
        if (this.syncFailureRetryCount > MAX_SYNC_FAILURE_RETRIES) {
          this.degrade('CodeGraph auto-sync disabled after repeated failures', {
            error: error.message, retryCount: this.syncFailureRetryCount
          });
        }
      }
    } finally {
      this.syncing = false;
      if (this.pendingFiles.size > 0 && !this.stopped) {
        const retryCount = Math.max(this.lockRetryCount, this.syncFailureRetryCount);
        if (retryCount > 0) {
          const retryDelayMs = Math.min(
            this.debounceMs * 2 ** Math.max(0, retryCount - 1),
            MAX_RETRY_BACKOFF_MS
          );
          this.scheduleRetrySync(retryDelayMs);
        } else {
          this.scheduleSync();
        }
      }
    }
  }
  unrelated() { UNRELATED_SIBLING_SENTINEL(); }
}
"#;
        std::fs::write(&path, source).unwrap();
        let native = NativeSession::new(&root, false).unwrap();
        let context = OperationContext::for_session(&native, ReadFormat::Plain, true);
        let args = serde_json::json!({
            "query":"FileWatcher.scheduleRetrySync", "kind":"symbol", "case":"smart",
            "scope":root, "visibility":"project", "expand":2, "retainRankedRender":true,
            "focus":{"target":format!("{}::FileWatcher.scheduleRetrySync", path.display())}
        });
        let output = dispatch_read_only("pi_nav_search", &args, &native, &context).unwrap();
        assert!(!output.text.contains("UNRELATED_SIBLING_SENTINEL"), "{}", output.text);
        assert!(output.text.contains("signature displayed above"), "{}", output.text);
        let rows = output.structured["data"]["sourceRows"].as_array().unwrap();
        let input = source.lines().collect::<Vec<_>>();
        let start = input.iter().position(|line| line.contains("private async flush()")).unwrap();
        let end = input.iter().position(|line| line.contains("unrelated()")).unwrap();
        // The independently supplied operation, not renderer-derived expected
        // windows, defines the required guards/input/outcome/recovery evidence.
        for index in start..end {
            let line = (index + 1) as u64;
            assert!(rows.iter().any(|row| row["line"] == line && row["text"] == input[index]),
                "missing operation line {line}: {}\n{}", input[index], output.text);
            if index > start {
                assert!(output.text.contains(&format!("{line}: {}", input[index])), "missing displayed line {line}");
            }
        }
        let identities = rows.iter().map(|row| (row["path"].as_str().unwrap(), row["line"].as_u64().unwrap())).collect::<HashSet<_>>();
        assert_eq!(identities.len(), rows.len(), "source rows must not duplicate");
        for row in rows {
            assert_eq!(row["text"].as_str().unwrap(), input[row["line"].as_u64().unwrap() as usize - 1]);
        }
        assert_eq!(output.structured["data"]["remainingGroups"], 0);
        let origin = output.ranked_render_cursor.as_ref().unwrap();
        let retained = native.session.get_ranked_cursor(origin).unwrap();
        assert!(!retained.evidence.frame.as_ref().unwrap().exact, "focus must use the live fuzzy/focused route");
        assert!(retained.progress.complete.is_empty(), "private origin is not delivery credit");
        let refit = serde_json::json!({"renderRanked":origin, "rankedRenderAllowance":300});
        let pressured = dispatch_read_only("pi_nav_search", &refit, &native, &context).unwrap();
        assert!(!pressured.text.contains("const retryDelayMs"), "an unfit recovery operation must not become a tail window");
        assert!(pressured.structured["data"]["remainingGroups"].as_u64().unwrap() > 0);
        let cursor = pressured.structured["data"]["cursor"].as_str().unwrap();
        let pending = native.session.get_ranked_cursor(cursor).unwrap();
        assert!(!pending.progress.complete.iter().any(|key| matches!(key,
            continuation::GroupKey::Lane(_, "callers", _))), "signature/window is not recovery completion");
        let replay = dispatch_read_only("pi_nav_search", &refit, &native, &context).unwrap();
        assert_eq!(pressured.text, replay.text);
        assert_eq!(pressured.structured["data"]["sourceRows"], replay.structured["data"]["sourceRows"]);
        let resumed = dispatch_read_only("pi_nav_search", &serde_json::json!({"cursor":cursor}), &native, &context).unwrap();
        assert!(resumed.text.contains("if (this.syncing || this.stopped) return;"), "{}", resumed.text);
        assert_eq!(resumed.structured["data"]["remainingGroups"], 0);
        std::fs::write(&path, source.replace("this.syncing = true", "this.syncing = false")).unwrap();
        assert!(dispatch_read_only("pi_nav_search", &refit, &native, &context).is_err(), "changed source must invalidate private rendering");
    }

    #[test]
    fn connected_pressure_preserves_consequence_before_breadth_and_advances_retained_groups() {
        use crate::dispatch::{NativeSession, OperationContext, ReadFormat};
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::write(root.join("items.ts"), "export function recordRemoval(key) { return key; }\nexport function prune(records, now = Date.now()) {\n  for (const [key, entry] of records) {\n    if (entry.deadline < now) { records.delete(key); recordRemoval(key); }\n  }\n}\n").unwrap();
        let caller_path = root.join("lookup.ts");
        let mut caller_source = String::from("import { prune } from './items';\nexport function lookup(records, key) {\n  prune(records);\n  return records.get(key);\n}\n");
        for index in 0..80 { writeln!(caller_source, "export function additionalLookup{index}(records) {{ prune(records); }}").unwrap(); }
        std::fs::write(&caller_path, &caller_source).unwrap();
        std::fs::write(root.join("z.ts"), "export function sweep(records) { return records.size; }\nexport function consumer(records) {\n  const count = sweep(records);\n  return count + 1;\n}\n").unwrap();
        let mut result = symbol::search("prune", &root, None, None, false).unwrap();
        result.matches.retain(|matched| matched.is_definition);
        let target = exact_primary_definition(&result).unwrap().clone();
        let native = NativeSession::new(&root, false).unwrap();
        let context = OperationContext::for_session(&native, ReadFormat::Plain, true);
        let cache = OutlineCache::new();
        let mut bundle = lanes::collect(&[&target], &result, &native.bloom,
            crate::walk::Visibility::Project, &[], &context).unwrap();
        // Model the actual indexed/live seam, including the untrimmed row.
        // No producer/model proof is claimed by this renderer fixture.
        let indexed = callers::find_callers_treesitter_batch(&caller_path, &HashSet::from(["prune".into()]),
            &tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), &caller_source, crate::types::Lang::TypeScript)
            .into_iter().map(|(_, mut caller)| {
                caller.call_text = caller_source.lines().nth(caller.line as usize - 1).unwrap().into();
                caller
            }).collect();
        bundle.enrich(lanes::LaneBundle::from_prepared(&target, lanes::SymbolLanes {
            callers: indexed, ..Default::default()
        }, "function".into(), None));
        assert_eq!(bundle.get(&target).unwrap().callers.len(), 81);
        for mode in ["known", "discovery", "focus"] {
            let mut current = result.clone();
            let mut connected = bundle.clone();
            if mode == "discovery" {
                current.query = "expiration cleanup".into();
                let other = symbol::search("sweep", &root, None, None, false).unwrap();
                current.matches.push(exact_primary_definition(&other).unwrap().clone());
                let other_bundle = lanes::collect(&[current.matches.last().unwrap()], &current,
                    &native.bloom, crate::walk::Visibility::Project, &[], &context).unwrap();
                // Card bundles isolate each already-selected identity.
                connected = lanes::LaneBundle::from_prepared_cards(vec![connected, other_bundle]);
            }
            if mode == "focus" { connected.focus(&["callers".into(), "documentation".into()]); }
            for allowance in [1200, 2400] {
                let rendered = if mode == "known" {
                    format_exact_ranked_card_with_allowance(&current, &cache, None, Some(&connected), allowance)
                } else { format_ranked_with_allowance(&current, &cache, Some(&connected), None, allowance) }.unwrap();
                assert!(rendered.text.contains("entry.deadline < now"), "{mode}: {}", rendered.text);
                assert!(rendered.text.contains("return records.get(key)"), "{mode}: {}", rendered.text);
                assert!(rendered.text.contains("function recordRemoval"), "{mode}: {}", rendered.text);
                assert_eq!(rendered.text.matches("lookup [2-5]: call \"prune(records)\" at 3:3").count(), 1, "{}", rendered.text);
                if mode == "discovery" {
                    assert!(rendered.text.contains("function sweep"), "{}", rendered.text);
                    assert!(rendered.text.contains("return count + 1"), "{}", rendered.text);
                }
                let mut unique = HashSet::new();
                for row in &rendered.source_rows {
                    assert!(unique.insert((row.path.clone(), row.line)), "duplicate source row");
                    assert_eq!(std::fs::read_to_string(&row.path).unwrap().lines().nth(row.line as usize - 1), Some(row.text.as_str()));
                }
                let keys = bundle.group_keys(&target);
                assert!(keys.iter().any(|key| !rendered.receipt.complete.contains(key)), "pressure must leave retained groups");
                let last = bundle.get(&target).unwrap().callers.iter()
                    .position(|caller| caller.calling_function == "additionalLookup79").unwrap();
                let pending = continuation::GroupKey::Lane(lanes::target_key(&target), "callers", last);
                assert!(!rendered.receipt.complete.contains(&pending));
                assert!(!rendered.source_rows.iter().any(|row| row.path == caller_path && row.line == 85));
                let next = format_ranked_with_allowance(&current, &cache, Some(&connected), Some(&rendered.receipt), allowance).unwrap();
                assert!(next.receipt.complete.iter().any(|key| !rendered.receipt.complete.contains(key)), "retained page must advance: {}", next.text);
                assert!(!next.text.contains("lookup [2-5]: call"), "completed caller repeated: {}", next.text);
            }
        }
    }

    #[test]
    fn call_evidence_tail_only_shares_adjacent_unchanged_context() {
        use crate::dispatch::{NativeSession, OperationContext, ReadFormat};
        for change in ["none", "external-section", "later-section", "target", "file", "origin", "basis", "callee-file", "callee-file-then-same-file"] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            let path = root.join("calls.rs");
            let source = "pub fn CaptureValue(value: &mut Vec<String>) {\n    value.len();\n    value.clear();\n    sink(value);\n}\nfn sink(value: &mut Vec<String>) {}\n";
            std::fs::write(&path, source).unwrap();
            let result = symbol::search("CaptureValue", &path, None, None, false).unwrap();
            let target = exact_primary_definition(&result).unwrap();
            let native = NativeSession::new(&root, false).unwrap();
            let context = OperationContext::for_session(&native, ReadFormat::Plain, true);
            let live = lanes::collect(&[target], &result, &native.bloom,
                crate::walk::Visibility::Project, &[], &context).unwrap();
            let mut evidence = live.get(target).unwrap().clone();
            assert_eq!(evidence.connections.len(), 3);
            let other = root.join("other.rs");
            std::fs::write(&other, source).unwrap();
            result.sources.read_text(&other).unwrap();
            if change.starts_with("callee-file") {
                for candidate in evidence.connections.iter_mut().flat_map(|connection| &mut connection.candidates) {
                    candidate.file = other.clone();
                    candidate.declaration = None;
                }
            }
            if change == "later-section" {
                evidence.stored_connections.push(lanes::StoredConnection {
                    kind: "reference".into(), heading: "intervening section", note: "different context".into(),
                    source: None, definition: None,
                });
            }
            let bundle = lanes::LaneBundle::from_prepared(target, evidence.clone(), "function".into(), None);
            let (mut text, mut rows, mut receipt, mut tail) =
                (String::new(), Vec::new(), continuation::Progress::default(), None);
            append_ranked_lane_pass(&mut text, &mut rows, &result, target, &bundle, None,
                4000, None, &mut receipt, true, &mut tail, &mut Vec::new());
            assert!(text.contains("call \"sink(value)\""));
            assert!(!text.contains("call \"value.len()\""), "representative order changed");
            if change == "external-section" { text.push_str("\n\nintervening section: unrelated context\n"); }
            for connection in evidence.connections.iter_mut().filter(|connection| connection.candidates.is_empty()) {
                match change {
                    "file" | "callee-file-then-same-file" => connection.path = other.clone(),
                    "origin" => connection.origin = "other source origin; ownership unverified",
                    "basis" => connection.basis = "other candidate basis; binding unverified",
                    _ => {},
                }
            }
            let mut next_target = target.clone();
            if change == "target" { next_target.path = other.clone(); }
            let next = lanes::LaneBundle::from_prepared(&next_target, evidence, "function".into(), None);
            let prior = receipt.clone();
            append_ranked_lane_pass(&mut text, &mut rows, &result, &next_target, &next, None,
                4000, Some(&prior), &mut receipt, false, &mut tail, &mut Vec::new());
            assert_eq!(text.matches("call evidence —").count(), if change == "none" { 1 } else { 2 }, "{change}: {text}");
            assert!(text.contains("call \"value.len()\""), "{change}: {text}");
            assert!(text.contains("call \"value.clear()\""), "{change}: {text}");
            if change == "callee-file" {
                assert_eq!(text.matches(&format!("  {}:\n", rel(&path, &result.scope))).count(), 2, "{text}");
            }
            let identities = rows.iter().map(|row| (&row.path, row.line)).collect::<HashSet<_>>();
            assert_eq!(identities.len(), rows.len(), "{change}: duplicate source rows");
            for row in &rows { assert_eq!(row.text, source.lines().nth(row.line as usize - 1).unwrap()); }
            for index in 0..3 {
                assert!(receipt.complete.contains(&continuation::GroupKey::Lane(lanes::target_key(&next_target), "connections", index)), "{change}: lost group credit");
            }
        }
    }

    fn assert_representative_skips_unadmitted(facet: &'static str) {
        for failure in ["budget", "undisplayable", "missing-source"] {
            if facet == "callers" && failure == "missing-source" { continue; }
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            let target_path = root.join("target.ts");
            let bad_path = root.join("a.ts");
            let good_path = root.join("b.ts");
            let target_source = "export function Target() { Oversized(); Affordable(); }\n";
            let bad_source = if failure == "budget" {
                format!("export function Oversized(\n{}) {{\n  Target();\n  return 0;\n}}\n",
                    (0..100).map(|index| format!("  parameter{index}: string,\n")).collect::<String>())
            } else {
                format!("export function Oversized({}: string) {{\n  Target();\n  return 0;\n}}\n", "x".repeat(RANKED_SOURCE_LINE_BYTES + 1))
            };
            let good_source = "export function Affordable() {\n  Target();\n  return 42;\n}\n";
            for (path, source) in [(&target_path, target_source), (&bad_path, bad_source.as_str()), (&good_path, good_source)] {
                std::fs::write(path, source).unwrap();
            }
            let result = symbol::search("Target", &target_path, None, None, false).unwrap();
            let target = exact_primary_definition(&result).unwrap();
            result.sources.read_text(&good_path).unwrap();
            if failure != "missing-source" { result.sources.read_text(&bad_path).unwrap(); }
            let language = tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into();
            let candidate = |path: &Path, name: &str, content: &str| callees::DeclarationCandidate {
                file: path.into(), name: name.into(), start_line: 1,
                end_line: content.lines().count() as u32, signature: None, declaration: None,
            };
            let bad = candidate(&bad_path, "Oversized", &bad_source);
            let good = candidate(&good_path, "Affordable", good_source);
            let mut evidence = lanes::SymbolLanes::default();
            match facet {
                "callers" => {
                    for (path, source) in [(&bad_path, bad_source.as_str()), (&good_path, good_source)] {
                        evidence.callers.extend(callers::find_callers_treesitter_batch(path,
                            &HashSet::from(["Target".into()]), &language, source, crate::types::Lang::TypeScript)
                            .into_iter().map(|(_, caller)| caller));
                    }
                }
                "callees" => evidence.callees = vec![bad, good],
                "connections" => {
                    let calls = callers::find_callers_treesitter_batch(&target_path,
                        &HashSet::from(["Oversized".into(), "Affordable".into()]), &language,
                        target_source, crate::types::Lang::TypeScript);
                    for ((_, caller), candidate) in calls.into_iter().zip([bad, good]) {
                        evidence.connections.push(callees::CallConnection {
                            path: target_path.clone(), site: caller.site.unwrap(), origin: "direct origin",
                            candidates: vec![candidate], basis: "declaration candidate; binding unverified",
                        });
                    }
                }
                _ => unreachable!(),
            }
            let bundle = lanes::LaneBundle::from_prepared(target, evidence, "function".into(), None);
            let (mut text, mut rows, mut receipt) = (String::new(), Vec::new(), continuation::Progress::default());
            append_ranked_lane_pass(&mut text, &mut rows, &result, target, &bundle, None,
                300, None, &mut receipt, true, &mut None, &mut Vec::new());
            assert!(rows.iter().any(|row| row.path == good_path && row.line == 1), "{facet}/{failure}: {text}");
            if facet == "callers" { assert!(text.contains("return 42"), "{failure}: {text}"); }
            assert!(!receipt.complete.contains(&continuation::GroupKey::Lane(lanes::target_key(target), facet, 0)));
            assert!(receipt.complete.contains(&continuation::GroupKey::Lane(lanes::target_key(target), facet, 1)), "{facet}/{failure}: {text}");
        }
    }

    #[test]
    fn representative_skips_unadmitted_callers() { assert_representative_skips_unadmitted("callers"); }
    #[test]
    fn representative_skips_unadmitted_callees() { assert_representative_skips_unadmitted("callees"); }
    #[test]
    fn representative_skips_unadmitted_connections() { assert_representative_skips_unadmitted("connections"); }

    #[test]
    fn caller_expansion_reserves_other_connections_before_spending_spare_budget() {
        use crate::dispatch::ReadFormat;
        use crate::dispatch::{NativeSession, OperationContext};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("defs.ts"), "function helper(value: number) { return value; }\nfunction Target(value: number) { return helper(value); }\n").unwrap();
        let mut large = String::from("function Large() {\n");
        for index in 0..60 {
            writeln!(large, "  const padding{index} = '{}';", "x".repeat(60)).unwrap();
            if index == 30 {
                large.push_str("  const result = Target(padding30.length);\n");
            }
        }
        large.push_str("  return result;\n}\n");
        std::fs::write(root.join("a.ts"), &large).unwrap();
        std::fs::write(
            root.join("z.ts"),
            "function Small() {\n  return Target(1);\n}\n",
        )
        .unwrap();
        let result = symbol::search("Target", &root, None, None, false).unwrap();
        let target = exact_primary_definition(&result).unwrap();
        let native = NativeSession::new(&root, false).unwrap();
        let context = OperationContext::for_session(&native, ReadFormat::Plain, true);
        let bloom = crate::index::bloom::BloomFilterCache::new();
        let bundle = lanes::collect(
            &[target],
            &result,
            &bloom,
            crate::walk::Visibility::Project,
            &[],
            &context,
        )
        .unwrap();
        for budget in [500, 2500] {
            let mut text = String::new();
            let mut rows = Vec::new();
            let (expansions, _) =
                append_ranked_lanes(&mut text, &mut rows, &result, target, &bundle, None, budget, None, &mut continuation::Progress::default());
            expand_reserved_callers(&mut text, &mut rows, expansions, budget, 0);
            assert!(text.contains("function Small()"), "{text}");
            assert!(text.contains("function helper(value"), "{text}");
            assert!(
                text.contains("const result = Target(padding30.length)"),
                "{text}"
            );
            assert!(!text.contains("const padding0 ="), "spare space must not restore arbitrary body prefixes: {text}");
            if budget == 2500 { assert!(text.contains("const padding30 ="), "retain the call's nearby input context: {text}"); }
            assert!(estimate_tokens(text.len() as u64) <= budget);
            let mut identities = HashSet::new();
            for row in rows {
                assert!(
                    identities.insert((row.path.clone(), row.line)),
                    "duplicate source row"
                );
                let source = std::fs::read_to_string(row.path).unwrap();
                assert_eq!(
                    source.lines().nth(row.line as usize - 1),
                    Some(row.text.as_str())
                );
            }
        }
    }

    #[test]
    fn exact_ranked_rust_type_unions_inherent_and_trait_impl_regions() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("widget.rs"),
            "struct Widget {\n    value: i32,\n}\n\nimpl Widget {\n    fn new() -> Self {\n        Self { value: 1 }\n    }\n}\n\nimpl std::fmt::Display for Widget {\n    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {\n        write!(output, \"{}\", self.value)\n    }\n}\n\nfn build() {\n    let _ = Widget::new();\n}\n",
        )
        .unwrap();
        let output = search_symbol_expanded(
            "Widget",
            root.path(),
            &OutlineCache::new(),
            &Session::new(),
            &crate::index::bloom::BloomFilterCache::new(),
            2,
            None,
            None,
            false,
            Some(4_000),
        )
        .unwrap();
        assert!(output.contains("kind: struct + impl blocks"));
        assert!(output.contains("[1-3]: struct Widget {"));
        assert!(output.contains("[5-9]: impl Widget {"));
        assert!(output.contains("[11-15]: impl std::fmt::Display for Widget {"));
        assert!(output.contains("[17-19]: fn build() {"));
        assert!(!output.contains("17: fn build() {"));
        assert!(output.contains("18:     let _ = Widget::new();"));
    }

    #[test]
    fn exact_ranked_large_function_keeps_signature_and_names_remainder() {
        let root = tempfile::tempdir().unwrap();
        let mut source = String::from(
            "export function enormous(\n  first: number,\n  second: number,\n): number {\n",
        );
        for index in 0..160 {
            let _ = writeln!(source, "  const value{index} = first + second + {index};");
        }
        source.push_str("  return value159;\n}\n");
        std::fs::write(root.path().join("large.ts"), source).unwrap();
        let output = search_symbol_expanded(
            "enormous",
            root.path(),
            &OutlineCache::new(),
            &Session::new(),
            &crate::index::bloom::BloomFilterCache::new(),
            2,
            None,
            None,
            false,
            Some(4_000),
        )
        .unwrap();
        assert!(output.contains("[1-166]: export function enormous("));
        assert!(output.contains("2:   first: number,"));
        assert!(output.contains("3:   second: number,"));
        assert!(output.contains("4: ): number {"));
        assert!(output.contains("remaining target"));
        assert!(!output.contains("160:   const value155"));
    }

    #[test]
    fn exact_ranked_seen_region_collapses_interior_and_edit_invalidates() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("seen.ts");
        let source = "class Seen {\n  one = 1;\n  two = 2;\n  three = 3;\n  four = 4;\n  five = 5;\n  six = 6;\n  seven = 7;\n  eight = 8;\n  nine = 9;\n  ten = 10;\n}\n";
        std::fs::write(&path, source).unwrap();
        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = crate::index::bloom::BloomFilterCache::new();
        let first = search_symbol_expanded(
            "Seen",
            root.path(),
            &cache,
            &session,
            &bloom,
            2,
            None,
            None,
            false,
            Some(4_000),
        )
        .unwrap();
        assert!(first.contains("2:   one = 1;"));
        let second = search_symbol_expanded(
            "Seen",
            root.path(),
            &cache,
            &session,
            &bloom,
            2,
            None,
            None,
            false,
            Some(4_000),
        )
        .unwrap();
        assert!(second.contains("[1-12]: class Seen {"));
        assert!(second.contains("[2-11: omitted already read this session]"));
        assert!(second.contains("12: }"));

        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        let changed = source.replace("  one = 1;", "  one = 99;");
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(5));
            std::fs::write(&path, &changed).unwrap();
            if std::fs::metadata(&path).unwrap().modified().unwrap() != before {
                break;
            }
        }
        assert_ne!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            before
        );
        let third = search_symbol_expanded(
            "Seen",
            root.path(),
            &cache,
            &session,
            &bloom,
            2,
            None,
            None,
            false,
            Some(4_000),
        )
        .unwrap();
        assert!(third.contains("2:   one = 99;"));
        assert!(!third.contains("omitted already read this session"));
    }

    #[test]
    fn primary_signatures_without_source_carrier_keep_only_proven_headers() {
        let dir = tempfile::tempdir().unwrap();
        for (extension, keyword, typ) in [("rs", "fn", "u32"), ("ts", "function", "number")] {
            let path = dir.path().join(format!("primary.{extension}"));
            for cap in [150, 50] {
                let mut source = format!("{keyword} CompletePrimary(\n");
                for parameter in 0..cap + 1 {
                    source.push_str(&format!("    p{parameter}: {typ},\n"));
                }
                source.push_str(") {\n    let body = 0;\n}\n");
                std::fs::write(&path, &source).unwrap();
                let mut matched = symbol::search("CompletePrimary", &path, None, None, true)
                    .unwrap()
                    .matches
                    .into_iter()
                    .find(|matched| matched.is_definition)
                    .unwrap();
                // Prepared targets use this same rendering path without a source carrier.
                matched.declaration = None;
                let (start, end) = matched.def_range.unwrap();
                let session = Session::new();
                for seen in [false, true] {
                    if seen {
                        session.record_expand(
                            &path,
                            start,
                            std::fs::metadata(&path).unwrap().modified().unwrap(),
                        );
                    }
                    let (mut text, mut rows) = (String::new(), Vec::new());
                    render_ranked_regions(
                        &mut text,
                        &mut rows,
                        &matched,
                        &source,
                        &[RankedRegion { start, end }],
                        Some(&session),
                        cap,
                    );
                    assert_eq!(rows.len(), cap + 3, "{extension}, seen={seen}: {text}");
                    assert!(
                        !rows.iter().any(|row| row.text.contains("let body")),
                        "{text}"
                    );
                    for parameter in 0..cap + 1 {
                        assert!(
                            rows.iter()
                                .any(|row| row.text == format!("    p{parameter}: {typ},")),
                            "{text}"
                        );
                    }
                }
            }
        }
        let path = dir.path().join("guard.rs");
        for (name, source) in [
            (
                "Unshowable",
                format!(
                    "fn Unshowable({}: u8) {{\n    let body = 0;\n}}\n",
                    "parameter".repeat(140)
                ),
            ),
            (
                "BULK",
                format!("static BULK: [u8; 170] = [\n{}];\n", "    0,\n".repeat(170)),
            ),
        ] {
            std::fs::write(&path, &source).unwrap();
            let matched = symbol::search(name, &path, None, None, true)
                .unwrap()
                .matches
                .into_iter()
                .find(|matched| matched.is_definition)
                .unwrap();
            let (start, end) = matched.def_range.unwrap();
            let (mut text, mut rows) = (String::new(), Vec::new());
            render_ranked_regions(
                &mut text,
                &mut rows,
                &matched,
                &source,
                &[RankedRegion { start, end }],
                None,
                150,
            );
            if name == "BULK" {
                assert_eq!(
                    scope::declaration_end_line(&path, &source, start, end),
                    Some(end)
                );
                assert_eq!(
                    rows.len(),
                    150,
                    "unknown-shape fallback exempted an initializer: {text}"
                );
                assert!(!text.contains("Signature-only exception"));
            } else {
                assert!(text.contains("signature undisplayable"), "{text}");
                assert!(!text.contains("line clipped"));
                assert!(rows.is_empty());
            }
        }
    }

    #[test]
    fn caller_whole_context_retains_nested_callback_header() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("callback.ts");
        let source = "function Needle(item: number) { return item; }\nfunction outer(items: number[]) {\n  return items.map((\n    item: number,\n    index: number,\n  ) => {\n    const value = Needle(item);\n    return value;\n  });\n}\n";
        std::fs::write(&path, source).unwrap();
        let matches = callers::find_callers_batch(
            &HashSet::from(["Needle".into()]),
            &path,
            &crate::index::bloom::BloomFilterCache::new(),
            None,
            100,
        )
        .unwrap();
        let caller = &matches[0].1;
        assert_eq!(caller.caller_range, Some((3, 9)));
        let session = Session::new();
        for seen in [false, true] {
            if seen {
                session.record_expand(
                    &path,
                    2,
                    std::fs::metadata(&path).unwrap().modified().unwrap(),
                );
            }
            let (text, rows) = caller_lane_block(&[caller], Some(&session), true, &[]);
            assert!(text.contains("[2-10]: function outer"), "{text}");
            assert!(text.contains("[3-9]:   return items.map(("), "{text}");
            for line in 3..=7 {
                assert_eq!(
                    rows.iter().filter(|row| row.line == line).count(),
                    1,
                    "{text}"
                );
            }
            assert_eq!(
                rows.iter()
                    .map(|row| row.line)
                    .collect::<HashSet<_>>()
                    .len(),
                rows.len()
            );
        }
        // An expression-bodied callback can finish on its signature's last
        // physical row; redisplay must not drop the parameters in between.
        let source = "function Needle(item: number) { return item; }\nfunction outer(items: number[]) {\n  return items.map((\n    item: number,\n    index: number,\n  ) => Needle(item));\n}\n";
        std::fs::write(&path, source).unwrap();
        let matches = callers::find_callers_batch(
            &HashSet::from(["Needle".into()]),
            &path,
            &crate::index::bloom::BloomFilterCache::new(),
            None,
            100,
        )
        .unwrap();
        session.record_expand(
            &path,
            2,
            std::fs::metadata(&path).unwrap().modified().unwrap(),
        );
        let (text, rows) = caller_lane_block(&[&matches[0].1], Some(&session), true, &[]);
        assert!(text.contains("[3-6]:   return items.map(("), "{text}");
        for line in 3..=6 {
            assert_eq!(
                rows.iter().filter(|row| row.line == line).count(),
                1,
                "{text}"
            );
        }
        let source = "function Needle(item: number) { return item; }\nfunction outer() { return [1].map(item => Needle(item)); }\n";
        std::fs::write(&path, source).unwrap();
        let matches = callers::find_callers_batch(
            &HashSet::from(["Needle".into()]),
            &path,
            &crate::index::bloom::BloomFilterCache::new(),
            None,
            100,
        )
        .unwrap();
        let (text, rows) = caller_lane_block(&[&matches[0].1], None, true, &[]);
        assert!(text.contains("<anonymous> [2]"), "{text}");
        assert_eq!(rows.iter().filter(|row| row.line == 2).count(), 1);
    }

    #[test]
    fn prepared_cards_reserve_live_mentions_and_keep_shared_source_roles() {
        for multiple in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            let contract = root.join("contract.go");
            let use_path = root.join("use.go");
            std::fs::write(
                &contract,
                "package one\ntype RoundTripper interface {\n RoundTrip()\n}\n",
            )
            .unwrap();
            let uses = "package one\nfunc use(rt RoundTripper) { rt.RoundTrip() }\nfunc keep(\n rt RoundTripper,\n) RoundTripper {\n return rt\n}\n";
            std::fs::write(&use_path, uses).unwrap();
            if multiple {
                std::fs::create_dir(root.join("two")).unwrap();
                std::fs::write(
                    root.join("two/contract.go"),
                    "package two\ntype RoundTripper interface {\n RoundTrip()\n}\n",
                )
                .unwrap();
            }
            let mut result =
                content::search("RoundTripper", root, false, None, None, false).unwrap();
            for matched in &mut result.matches {
                matched.is_definition = false;
            }
            let mut targets = result
                .matches
                .iter()
                .filter(|matched| matched.path.file_name().unwrap() == "contract.go")
                .cloned()
                .collect::<Vec<_>>();
            targets.sort_by_key(|matched| matched.path.clone());
            let mut bundles = Vec::new();
            for target in &mut targets {
                target.is_definition = true;
                target.exact = true;
                target.def_name = Some("RoundTripper".into());
                target.def_range = Some((2, 4));
                target.def_weight = 100;
                let mut support = lanes::SymbolLanes::default();
                if target.path == contract {
                    support.callers.push(callers::CallerMatch {
                        path: use_path.clone(),
                        line: 2,
                        calling_function: "use".into(),
                        call_text: uses.lines().nth(1).unwrap().into(),
                        caller_range: Some((2, 2)),
                        content: result.sources.read_text(&use_path).unwrap(),
                        site: None,
                    });
                    support.connection_notes = (0..100)
                        .map(|index| {
                            format!("optional {index}: {}", "recorded uncertainty ".repeat(30))
                        })
                        .collect();
                }
                bundles.push(lanes::LaneBundle::from_prepared(
                    target,
                    support,
                    "interface".into(),
                    None,
                ));
            }
            result.definitions = targets.len();
            result.usages = result.matches.len();
            result.total_found = result.definitions + result.usages;
            result.facet_totals.definitions = result.definitions;
            targets.append(&mut result.matches);
            result.matches = targets;
            let bundle = if multiple {
                lanes::LaneBundle::from_prepared_cards(bundles)
            } else {
                bundles.pop().unwrap()
            };
            let cache = OutlineCache::new();
            let card = if multiple {
                format_fuzzy_result_typed(&result, &cache, None, Some(&bundle)).unwrap()
            } else {
                format_exact_ranked_card(&result, &cache, None, Some(&bundle)).unwrap()
            };
            // keep has no graph carrier: its exact live mentions and complete
            // multiline signature must survive both card shapes and dense notes.
            for line in 2..=5 {
                let source = uses.lines().nth(line as usize - 1).unwrap();
                assert_eq!(
                    card.source_rows
                        .iter()
                        .filter(|row| row.path == use_path
                            && row.line == line
                            && row.text == source)
                        .count(),
                    1,
                    "{}",
                    card.text
                );
                assert_eq!(
                    card.text
                        .lines()
                        .filter(|row| row.trim_end().ends_with(source))
                        .count(),
                    1,
                    "{}",
                    card.text
                );
            }
            assert!(
                card.text.contains("2: func use(rt RoundTripper)"),
                "{}",
                card.text
            );
            assert!(!card.text.contains("[2-2]:"), "{}", card.text);
            assert!(card.text.contains("use [2]: source above"), "{}", card.text);
            assert!(
                card.text.contains("not runtime-dispatch proof"),
                "{}",
                card.text
            );
            assert!(card.text.find("func keep(").unwrap() < card.text.find("optional 0:").unwrap());
            assert!(card.omitted_relationship_evidence > 0);
            assert!(!card
                .text
                .contains("additional exact captured identities omitted"));
            assert_eq!(
                card.source_rows
                    .iter()
                    .map(|row| (&row.path, row.line, &row.text))
                    .collect::<HashSet<_>>()
                    .len(),
                card.source_rows.len()
            );
        }
    }

    #[test]
    fn ranked_reference_blocks_use_emitted_rows_and_fit_complete_declarations() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("target.rs");
        let source = format!(
            "fn Wanted() {{\n{}    Wanted();\n}}\n",
            "    let filler = 1;\n".repeat(170)
        );
        std::fs::write(&path, &source).unwrap();
        let mut result = content::search("Wanted", &path, false, None, None, false).unwrap();
        let mut target = result
            .matches
            .iter()
            .find(|matched| matched.line == 1)
            .unwrap()
            .clone();
        target.is_definition = true;
        target.exact = true;
        target.def_name = Some("Wanted".into());
        target.def_range = Some((1, 173));
        target.def_weight = 100;
        for matched in &mut result.matches {
            matched.is_definition = false;
        }
        result.matches.insert(0, target.clone());
        result.definitions = 1;
        result.facet_totals.definitions = 1;
        let bundle =
            lanes::LaneBundle::from_prepared(&target, Default::default(), "function".into(), None);
        let card =
            format_exact_ranked_card(&result, &OutlineCache::new(), None, Some(&bundle)).unwrap();
        assert!(
            card.source_rows
                .iter()
                .any(|row| row.line == 172 && row.text == "    Wanted();"),
            "{}",
            card.text
        );
        assert!(
            !card
                .source_rows
                .iter()
                .any(|row| (151..172).contains(&row.line)),
            "a reference cannot mint body allowance"
        );
        assert_eq!(
            card.source_rows.iter().filter(|row| row.line == 1).count(),
            1
        );

        let path = directory.path().join("support.rs");
        let mut source = "fn wide(\n".to_string();
        for index in 0..40 {
            let _ = writeln!(source, "    parameter_{index}: usize,");
        }
        source.push_str(") {\n    Wanted();\n    Wanted();\n}\nfn small() { Wanted(); }\n");
        std::fs::write(&path, &source).unwrap();
        let result = content::search("Wanted", &path, false, None, None, false).unwrap();
        let mut output = String::new();
        let mut rows = Vec::new();
        let omitted = append_ranked_references(
            &mut output,
            &mut rows,
            &result,
            None,
            &OutlineCache::new(),
            100,
        );
        assert_eq!(omitted, 2, "{output}");
        assert!(output.contains("fn small() { Wanted(); }"), "{output}");
        assert!(
            !output.contains("fn wide(") && !output.contains("parameter_"),
            "a rejected signature must stay whole: {output}"
        );
        assert_eq!(
            rows.len(),
            1,
            "rejected blocks cannot seed emitted-row coverage"
        );
        let mut refused = String::new();
        assert_eq!(
            append_ranked_references(
                &mut refused,
                &mut Vec::new(),
                &result,
                None,
                &OutlineCache::new(),
                0,
            ),
            3
        );
        assert!(!refused.contains("fn small()"));
    }
}
