use std::collections::HashSet;
use std::path::{Path, PathBuf};

use globset::Glob;

use crate::error::TilthError;
use crate::types::estimate_tokens;
use crate::walk::{self, EntryKind, Visibility, WalkOptions};

const MAX_FILES: usize = 20;

pub struct GlobFileEntry {
    pub path: PathBuf,
    pub preview: Option<String>,
}

pub struct GlobResult {
    pub pattern: String,
    pub files: Vec<GlobFileEntry>,
    pub total_found: usize,
    pub available_extensions: Vec<String>,
}

pub fn search(pattern: &str, scope: &Path) -> Result<GlobResult, TilthError> {
    search_with_visibility(pattern, scope, Visibility::Project)
}

pub fn search_with_visibility(
    pattern: &str,
    scope: &Path,
    visibility: Visibility,
) -> Result<GlobResult, TilthError> {
    let matcher = Glob::new(pattern)
        .map_err(|error| TilthError::InvalidQuery {
            query: pattern.into(),
            reason: error.to_string(),
        })?
        .compile_matcher();
    let walked = walk::walk(
        scope,
        &WalkOptions {
            visibility,
            ..WalkOptions::default()
        },
    )
    .map_err(|reason| TilthError::InvalidQuery {
        query: pattern.into(),
        reason,
    })?;
    let mut files = Vec::new();
    let mut total_found = 0;
    let mut extensions = HashSet::new();
    for entry in walked.entries {
        if entry.kind != EntryKind::File {
            continue;
        }
        if let Some(extension) = entry.path.extension().and_then(|value| value.to_str()) {
            extensions.insert(extension.to_string());
        }
        let name = entry.path.file_name().unwrap_or_default();
        if matcher.is_match(name) || matcher.is_match(&entry.path) {
            total_found += 1;
            if files.len() < MAX_FILES {
                files.push(GlobFileEntry {
                    path: scope.join(&entry.path),
                    preview: Some(format!("~{} tokens", estimate_tokens(entry.size))),
                });
            }
        }
    }
    let available_extensions = if files.is_empty() {
        let mut values: Vec<_> = extensions.into_iter().collect();
        values.sort();
        values.truncate(10);
        values
    } else {
        Vec::new()
    };
    Ok(GlobResult {
        pattern: pattern.into(),
        files,
        total_found,
        available_extensions,
    })
}
