//! Exact source focus for ranked search. This is selection within the collected
//! scope, not a semantic binding resolver or a replacement query.
use std::path::{Path, PathBuf};
use serde_json::{json, Value};
use super::OperationSources;

#[derive(Debug, Clone)]
pub(crate) struct Focus {
    /// Original request spelling for a targeted focus; None for emphasis-only.
    pub(crate) target: Option<String>,
    /// Set only for an absolute `path::qualifiedName` target.
    pub(crate) path: Option<PathBuf>,
    /// Exact lookup name (`Name` or `Qualified.Name`) used by identity matching.
    pub(crate) name: String,
    /// Order-preserving deduplicated emphasis set. Empty means the ordinary
    /// connected answer; emphasis never deletes unrequested evidence.
    pub(crate) evidence: Vec<String>,
}

/// Emphasis categories are presentation priorities, not a weighting language.
const FOCUS_EVIDENCE: [&str; 5] = ["callers", "callees", "uses", "implementations", "documentation"];

fn evidence_category(value: &str) -> Result<&str, String> {
    FOCUS_EVIDENCE.iter().copied().find(|category| *category == value)
        .ok_or_else(|| "focus.evidence must be callers, callees, uses, implementations, or documentation".into())
}

impl Focus {
    /// A targeted focus selects one exact source owner; an emphasis-only focus
    /// keeps the ordinary connected candidates and selects no owner.
    pub(crate) fn has_target(&self) -> bool { self.target.is_some() }

    pub(crate) fn path_restriction(&self) -> Option<&Path> { self.path.as_deref() }

    pub(crate) fn parse(value: &Value, scope: &Path, sources: &OperationSources) -> Result<Self, String> {
        let object = value.as_object().ok_or("focus must be an object")?;
        if object.keys().any(|key| !matches!(key.as_str(), "target" | "evidence")) {
            return Err("focus accepts only target and evidence".into());
        }
        // Scalar evidence stays accepted for compatibility and normalizes to a
        // one-item list. The list is a set of requested priorities: supplied
        // order is preserved, duplicates are dropped, and no entry is inferred.
        let evidence = match object.get("evidence") {
            None => Vec::new(),
            Some(Value::String(value)) => vec![evidence_category(value)?.to_string()],
            Some(Value::Array(values)) => {
                if values.len() > 32 { return Err("focus.evidence accepts at most 32 entries".into()); }
                let mut evidence: Vec<String> = Vec::new();
                for value in values {
                    let category = value.as_str().ok_or("focus.evidence entries must be category names")?;
                    let category = evidence_category(category)?;
                    if !evidence.iter().any(|seen| seen == category) { evidence.push(category.to_string()); }
                }
                evidence
            }
            Some(_) => return Err("focus.evidence must be a category or a list of categories".into()),
        };
        let target = match object.get("target") {
            None | Some(Value::Null) => None,
            Some(Value::String(target)) if !target.is_empty() && target.len() <= 16_384 => Some(target.clone()),
            Some(_) => return Err("focus.target must be an absolute path::qualifiedName or a qualified name".into()),
        };
        let (path, name) = match target.as_deref() {
            None => (None, String::new()),
            Some(target) => {
                let (head, tail) = target.split_once("::").map_or((target, None), |(head, tail)| (head, Some(tail)));
                // A pathname spelling is absolute, or at least carries a path
                // separator or a filename dot. `Worker::flush` and
                // `crate::mod::Item` are qualified names, not relative paths, so
                // a colon spelling with a bare head selects by exact identity.
                let head_is_path = Path::new(head).is_absolute()
                    || head.contains('/') || head.contains('\\') || head.contains('.');
                match tail {
                    Some(tail) if !head_is_path => {
                        if tail.is_empty() || tail.contains('/') || tail.contains('\\') {
                            return Err("focus.target must be an absolute path::qualifiedName or a qualified name".into());
                        }
                        (None, target.to_string())
                    }
                    Some(_) => {
                        let (file, name) = target.split_once("::").filter(|(file, name)| !file.is_empty() && !name.is_empty())
                            .ok_or("focus.target must be an absolute path::qualifiedName or a qualified name")?;
                        let lexical = Path::new(file);
                        if !lexical.is_absolute() || lexical.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
                            return Err("focus target path must be absolute without parent traversal".into());
                        }
                        let path = match sources.input_canonicalize(lexical) {
                            Ok(path) => path,
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => lexical.to_path_buf(),
                            Err(error) => return Err(format!("focus target unavailable: {error}")),
                        };
                        if !(path == scope || scope.is_dir() && path.starts_with(scope)) {
                            return Err("focus target resolves outside the original requested scope".into());
                        }
                        (Some(path), name.to_string())
                    }
                    None => {
                        // No separator: a plain or dotted name. A path spelling
                        // without a symbol stays ambiguous input.
                        if head.contains('/') || head.contains('\\') {
                            return Err("focus.target without a symbol cannot be a path; use path::qualifiedName".into());
                        }
                        (None, target.to_string())
                    }
                }
            }
        };
        if path.is_none() && name.is_empty() && evidence.is_empty() {
            return Err("focus requires a target or at least one evidence category".into());
        }
        Ok(Self { target, path, name, evidence })
    }

    pub(crate) fn metadata(&self, mut alternatives: Vec<Value>, complete: bool) -> Value {
        let status = match alternatives.len() {
            0 if complete => "not_found",
            0 => "unavailable",
            1 if complete => "ok",
            1 => "unavailable",
            _ => "ambiguous",
        };
        let total = alternatives.len();
        alternatives.truncate(200);
        json!({"target":self.target,"evidence":self.evidence,"status":status,"alternatives":alternatives,
            "totalAlternatives":total,"omittedAlternatives":total.saturating_sub(200),
            "identityBasis":"exact source qualification; not semantic binding",
            "coverage":"original collected scope, filters and language coverage; no nearest-name rescue"})
    }

    /// Emphasis-only focus: no owner is selected and no alternatives exist.
    pub(crate) fn emphasis_metadata(&self, complete: bool) -> Value {
        json!({"target":Value::Null,"evidence":self.evidence,
            "status": if complete { "connected" } else { "unavailable" },
            "selectionBasis":"ordinary connected candidates; no exact owner selected",
            "coverage":"original collected scope, filters and language coverage; no nearest-name rescue"})
    }
}

/// Anonymous lexical containers cannot disappear from an address. A retrieval
/// field that drops them is not an exact qualified source identity.
pub(crate) fn declaration_name(declaration: &super::declarations::Declaration) -> Option<String> {
    declaration.ancestors().into_iter().chain(std::iter::once(declaration.region()))
        .map(|region| region.name.clone()).collect::<Option<Vec<_>>>()
        .map(|names| names.join("::"))
}

pub(crate) fn name_matches(requested: &str, qualified: &str) -> bool {
    requested == qualified || requested == qualified.replace("::", ".")
}

/// Exact identity for a name-only target: the qualified declaration name or the
/// declaration's own name. Never a lexical, prefix or nearest-name approximation,
/// so several owners stay visible as honest alternatives.
pub(crate) fn identity_matches(requested: &str, qualified: &str, plain: &str) -> bool {
    name_matches(requested, qualified)
        || (!requested.contains('.') && !requested.contains(':') && requested == plain)
}
