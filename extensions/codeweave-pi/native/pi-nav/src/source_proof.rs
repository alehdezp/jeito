#[cfg(feature = "napi-addon")]
use std::collections::HashMap;
use std::path::Path;
#[cfg(feature = "napi-addon")]
use std::path::PathBuf;

#[cfg(feature = "napi-addon")]
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[cfg(feature = "napi-addon")]
use crate::dispatch::{resolve_local_path, NativeError, OperationContext};
#[cfg(feature = "napi-addon")]
use crate::output::{IncompleteReason, ToolOutput};

const MAX_SOURCE_PROOF_FILES: usize = 32;
const MAX_SOURCE_PROOF_BYTES: u64 = 8 * 1024 * 1024;

#[cfg_attr(not(feature = "napi-addon"), allow(dead_code))]
#[derive(Debug, Clone)]
pub(crate) struct SourceSnapshot {
    pub(crate) canonical_path: String,
    pub(crate) text: String,
    pub(crate) raw_digest: String,
    pub(crate) line_ending: &'static str,
    pub(crate) bom: bool,
}

#[cfg(feature = "napi-addon")]
fn snapshot_canonical_file(canonical: &Path) -> Result<SourceSnapshot, String> {
    let metadata = std::fs::metadata(canonical).map_err(|error| {
        format!(
            "source proof metadata failed for {}: {error}",
            canonical.display()
        )
    })?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE_PROOF_BYTES {
        return Err(format!(
            "source proof file is not a bounded regular file: {}",
            canonical.display()
        ));
    }
    let bytes = std::fs::read(canonical).map_err(|error| {
        format!(
            "source proof read failed for {}: {error}",
            canonical.display()
        )
    })?;
    if bytes.contains(&0) {
        return Err(format!(
            "source proof refuses binary-looking file: {}",
            canonical.display()
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| format!("source proof requires UTF-8 text: {}", canonical.display()))?;
    Ok(snapshot_text(canonical, text))
}

pub(crate) fn snapshot_text(canonical_path: &Path, text: String) -> SourceSnapshot {
    let raw_digest = format!("{:X}", Sha256::digest(text.as_bytes()));
    let line_ending = if text.contains("\r\n") { "crlf" } else { "lf" };
    let bom = text.starts_with('\u{feff}');
    SourceSnapshot {
        canonical_path: canonical_path.to_string_lossy().into_owned(),
        text,
        raw_digest,
        line_ending,
        bom,
    }
}

/// Pack already-captured, deduplicated search sources without changing visible
/// evidence. Missing whole snapshots are certified separately by the coordinator.
/// Check both bounds before cloning text; never truncate a whole-file proof.
pub(crate) fn push_search_snapshot(
    snapshots: &mut Vec<SourceSnapshot>,
    canonical_path: &Path,
    text: &str,
) {
    if snapshots.len() >= MAX_SOURCE_PROOF_FILES || text.len() as u64 > MAX_SOURCE_PROOF_BYTES {
        return;
    }
    snapshots.push(snapshot_text(canonical_path, text.to_owned()));
}

#[cfg(feature = "napi-addon")]
pub(crate) fn prove(args: &Value, context: &OperationContext) -> Result<ToolOutput, NativeError> {
    context.check()?;
    let paths = args
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| NativeError::invalid_argument("source proof requires paths:string[]"))?;
    if paths.is_empty() || paths.len() > MAX_SOURCE_PROOF_FILES {
        return Err(NativeError::invalid_argument(
            "source proof paths must contain 1 to 32 files",
        ));
    }

    let sources = crate::search::OperationSources::from_arguments(args, &context.root).map_err(NativeError::Domain)?;
    let mut resolved = Vec::with_capacity(paths.len());
    for value in paths {
        context.check()?;
        let raw = value.as_str().ok_or_else(|| {
            NativeError::invalid_argument("source proof paths must contain strings")
        })?;
        resolved.push((raw, resolve_local_path(&context.root, raw)));
    }

    let mut by_canonical: HashMap<PathBuf, Result<SourceSnapshot, String>> = HashMap::new();
    let mut first_raw_by_canonical: HashMap<PathBuf, &str> = HashMap::new();
    let mut duplicate_paths = 0usize;
    let mut canonical_aliases = 0usize;
    for (raw, path) in &resolved {
        if let Ok(canonical) = path {
            context.check()?;
            if by_canonical.contains_key(canonical) {
                duplicate_paths += 1;
                if first_raw_by_canonical
                    .get(canonical)
                    .is_some_and(|first| *first != *raw)
                {
                    canonical_aliases += 1;
                }
            } else {
                first_raw_by_canonical.insert(canonical.clone(), raw);
                if args.get("corpusAdmission").is_some() {
                    let snapshot = std::fs::metadata(canonical).map_err(|error| error.to_string()).and_then(|metadata| {
                        if !metadata.is_file() || metadata.len() > MAX_SOURCE_PROOF_BYTES { return Err("source proof requires a bounded regular file".into()); }
                        sources.read_text(canonical).map_err(|error| error.to_string())
                    }).and_then(|text| {
                        if text.len() as u64 > MAX_SOURCE_PROOF_BYTES || text.contains('\0') { return Err("source proof requires bounded UTF-8 text".into()); }
                        Ok(snapshot_text(canonical, text.as_str().to_owned()))
                    });
                    by_canonical.insert(canonical.clone(), snapshot);
                    continue;
                }
                by_canonical.insert(canonical.clone(), snapshot_canonical_file(canonical));
            }
        }
    }

    let mut snapshots = Vec::new();
    let mut statuses = Vec::with_capacity(paths.len());
    for (raw, path) in resolved {
        match path.and_then(|canonical| {
            by_canonical
                .get(&canonical)
                .cloned()
                .unwrap_or_else(|| Err("source proof internal deduplication failure".into()))
                .map_err(NativeError::Domain)
        }) {
            Ok(snapshot) => {
                statuses.push(json!({ "path": raw, "status": "proven" }));
                if !snapshots.iter().any(|existing: &SourceSnapshot| {
                    existing.canonical_path == snapshot.canonical_path
                }) {
                    snapshots.push(snapshot);
                }
            }
            Err(error) => statuses.push(json!({
                "path": raw,
                "status": "rejected",
                "reason": error.to_string(),
            })),
        }
    }

    let proven_paths = statuses
        .iter()
        .filter(|status| status.get("status").and_then(Value::as_str) == Some("proven"))
        .count();
    let data = json!({
        "files": statuses,
        "instrumentation": {
            "hiddenExternalClaims": paths.len(),
            "currentReads": by_canonical.len(),
            "duplicatePaths": duplicate_paths,
            "canonicalAliases": canonical_aliases,
        }
    });
    let output = if proven_paths == paths.len() {
        ToolOutput::complete(
            "pi_nav_source_proof",
            String::new(),
            data,
            proven_paths,
            proven_paths,
        )
    } else {
        ToolOutput::incomplete(
            "pi_nav_source_proof",
            String::new(),
            data,
            proven_paths,
            IncompleteReason::Error,
            vec!["one or more source-proof files were rejected".into()],
        )
    };
    Ok(output.with_source_snapshots(snapshots))
}

#[cfg(all(test, feature = "napi-addon"))]
mod tests {
    use super::*;

    #[test]
    fn search_snapshot_packet_keeps_first_32_whole_sources() {
        let mut snapshots = Vec::new();
        for index in 0..35 {
            let path = PathBuf::from(format!("file-{index}.ts"));
            let text = format!("\u{feff}const value = 'é{index}';\r\n");
            push_search_snapshot(&mut snapshots, &path, &text);
            assert_eq!(snapshots.len(), (index + 1).min(32));
        }
        for (index, snapshot) in snapshots.iter().enumerate() {
            let path = PathBuf::from(format!("file-{index}.ts"));
            let text = format!("\u{feff}const value = 'é{index}';\r\n");
            let expected = snapshot_text(&path, text);
            assert_eq!(snapshot.canonical_path, expected.canonical_path);
            assert_eq!(snapshot.text, expected.text);
            assert_eq!(snapshot.raw_digest, expected.raw_digest);
            assert_eq!(snapshot.line_ending, expected.line_ending);
            assert_eq!(snapshot.bom, expected.bom);
        }
    }

    #[test]
    fn search_snapshot_packet_skips_oversized_utf8_without_consuming_a_slot() {
        let mut snapshots = Vec::new();
        let boundary = "é".repeat(MAX_SOURCE_PROOF_BYTES as usize / 2);
        let oversized = format!("{boundary}é");
        assert!(oversized.chars().count() < MAX_SOURCE_PROOF_BYTES as usize);
        push_search_snapshot(&mut snapshots, Path::new("oversized.ts"), &oversized);
        assert!(snapshots.is_empty());
        push_search_snapshot(&mut snapshots, Path::new("boundary.ts"), &boundary);
        assert_eq!(snapshots[0].text, boundary);
        assert_eq!(snapshots[0].text.len() as u64, MAX_SOURCE_PROOF_BYTES);
        push_search_snapshot(&mut snapshots, Path::new("oversized-again.ts"), &oversized);
        for index in 1..=32 {
            push_search_snapshot(&mut snapshots, Path::new(&format!("good-{index}.ts")), "valid\n");
        }
        assert_eq!(snapshots.len(), 32);
        assert_eq!(snapshots.last().unwrap().canonical_path, "good-31.ts");
        assert!(snapshots.iter().all(|snapshot| snapshot.text.len() as u64 <= MAX_SOURCE_PROOF_BYTES));
    }

    #[test]
    fn search_snapshot_packet_does_not_trim_matches_source_or_create_a_cursor() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        let expected_paths = (0..35).map(|index| format!("file-{index:02}.txt"))
            .collect::<std::collections::BTreeSet<_>>();
        for path in &expected_paths {
            std::fs::write(root.path().join(path), "needle\n").unwrap();
        }
        let native = crate::dispatch::NativeSession::new(root.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(
            &native, crate::dispatch::ReadFormat::Plain, true,
        );
        let output = crate::search::matches::execute(
            &json!({ "pattern": "needle", "syntax": "literal", "contextLines": 0 }),
            &native.cache, &native.session, &context,
        ).unwrap();
        assert_eq!(output.source_snapshots.len(), 32);
        assert_eq!(output.structured["completeness"]["complete"], true);
        assert!(output.structured["data"]["cursor"].is_null());
        let rows = output.structured["data"]["sourceRows"].as_array().unwrap();
        assert_eq!(rows.len(), 35);
        let delivered_paths = rows.iter().map(|row| {
            assert_eq!(row["line"], 1);
            assert_eq!(row["text"], "needle");
            row["path"].as_str().unwrap().to_string()
        }).collect::<std::collections::BTreeSet<_>>();
        assert_eq!(delivered_paths, expected_paths);
        for snapshot in &output.source_snapshots {
            assert_eq!(snapshot.text, "needle\n");
            let file = Path::new(&snapshot.canonical_path).file_name().unwrap().to_str().unwrap();
            assert!(expected_paths.contains(file));
            assert!(output.text.contains(file));
        }
    }

    #[test]
    fn hidden_proof_deduplicates_relative_absolute_and_symlink_aliases() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("proof.txt");
        std::fs::write(&path, "proof bytes\r\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&path, root.path().join("proof-link.txt")).unwrap();
        let native = crate::dispatch::NativeSession::new(root.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(
            &native,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        let paths = if cfg!(unix) {
            json!(["proof.txt", path, "proof-link.txt"])
        } else {
            json!(["proof.txt", path])
        };
        let output = prove(&json!({ "paths": paths }), &context).unwrap();
        assert_eq!(
            output.structured["data"]["instrumentation"]["currentReads"],
            1
        );
        assert_eq!(output.source_snapshots.len(), 1);
        assert!(output.structured["data"]["files"]
            .as_array()
            .is_some_and(|files| files.iter().all(|file| file["status"] == "proven")));
    }

    #[test]
    fn hidden_proof_preserves_independent_success_when_one_file_fails() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("good.txt"), "good\n").unwrap();
        std::fs::write(root.path().join("bad.bin"), b"bad\0bytes").unwrap();
        let native = crate::dispatch::NativeSession::new(root.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(
            &native,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        let output = prove(&json!({ "paths": ["good.txt", "bad.bin"] }), &context).unwrap();
        assert_eq!(output.source_snapshots.len(), 1);
        assert!(output.source_snapshots[0]
            .canonical_path
            .ends_with("good.txt"));
        assert_eq!(output.structured["data"]["files"][0]["status"], "proven");
        assert_eq!(output.structured["data"]["files"][1]["status"], "rejected");
    }

    #[test]
    fn raw_digest_vectors_preserve_exact_bytes_without_rust_edit_normalization() {
        let vectors: &[(&str, &str)] = &[
            ("empty", ""),
            ("bom-only", "\u{feff}"),
            ("lf", "a\nb\n"),
            ("crlf", "a\r\nb\r\n"),
            ("cr", "a\rb\r"),
            ("mixed", "a\r\nb\rc\n"),
            ("trailing-spaces", "a   \n"),
            ("trailing-tabs", "a\t\t\n"),
            ("final-newline", "a\n"),
            ("no-final-newline", "a"),
            ("non-ascii", "héllo 世界\n"),
        ];
        for (name, raw) in vectors {
            let snapshot = snapshot_text(Path::new(name), (*raw).to_string());
            assert_eq!(
                snapshot.raw_digest,
                format!("{:X}", Sha256::digest(raw.as_bytes())),
                "{name}"
            );
            assert_eq!(snapshot.text.as_bytes(), raw.as_bytes(), "{name}");
        }
    }

    #[test]
    fn source_proof_refuses_invalid_utf8_binary_and_oversized_files_independently() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("good.txt"), "good\n").unwrap();
        std::fs::write(root.path().join("invalid.txt"), [0x66, 0x80, 0x6f]).unwrap();
        std::fs::write(root.path().join("binary.txt"), b"a\0b").unwrap();
        let oversized = std::fs::File::create(root.path().join("oversized.txt")).unwrap();
        oversized.set_len(MAX_SOURCE_PROOF_BYTES + 1).unwrap();
        let native = crate::dispatch::NativeSession::new(root.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(
            &native,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        let output = prove(
            &json!({ "paths": ["good.txt", "invalid.txt", "binary.txt", "oversized.txt"] }),
            &context,
        )
        .unwrap();
        assert_eq!(output.source_snapshots.len(), 1);
        let files = output.structured["data"]["files"].as_array().unwrap();
        assert_eq!(
            files
                .iter()
                .filter(|file| file["status"] == "proven")
                .count(),
            1
        );
        assert_eq!(
            files
                .iter()
                .filter(|file| file["status"] == "rejected")
                .count(),
            3
        );
    }

    #[test]
    fn source_proof_honors_pre_cancel_and_deadline() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("good.txt"), "good\n").unwrap();
        let native = crate::dispatch::NativeSession::new(root.path(), false).unwrap();
        let cancelled = crate::dispatch::OperationContext::for_session(
            &native,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        cancelled
            .cancelled
            .store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(matches!(
            prove(&json!({ "paths": ["good.txt"] }), &cancelled),
            Err(NativeError::Cancelled)
        ));
        let mut expired = crate::dispatch::OperationContext::for_session(
            &native,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        expired.deadline = Some(std::time::Instant::now());
        assert!(matches!(
            prove(&json!({ "paths": ["good.txt"] }), &expired),
            Err(NativeError::Deadline)
        ));
    }

    #[test]
    fn source_proof_enforces_file_count_ceiling_before_io() {
        let root = tempfile::tempdir().unwrap();
        let native = crate::dispatch::NativeSession::new(root.path(), false).unwrap();
        let context = crate::dispatch::OperationContext::for_session(
            &native,
            crate::dispatch::ReadFormat::Plain,
            true,
        );
        let paths = (0..=MAX_SOURCE_PROOF_FILES)
            .map(|index| format!("missing-{index}.txt"))
            .collect::<Vec<_>>();
        assert!(matches!(
            prove(&json!({ "paths": paths }), &context),
            Err(NativeError::InvalidArgument(_))
        ));
    }
}
