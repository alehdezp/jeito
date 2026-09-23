use std::collections::HashSet;
use std::path::{Path, PathBuf};

use streaming_iterator::StreamingIterator;

use crate::lang::outline::{get_outline_entries, outline_language};
use crate::types::{Lang, OutlineEntry};

/// A source-backed declaration candidate. Its existence does not prove a call binding.
#[derive(Debug, Clone)]
pub struct DeclarationCandidate {
    pub name: String,
    pub file: PathBuf,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: Option<String>,
    pub(crate) declaration: Option<super::declarations::Declaration>,
}

/// Call sites in a declaration candidate's body, not a resolved call chain.
#[derive(Debug)]
pub(crate) struct CandidateConnections {
    pub declaration: DeclarationCandidate,
    pub calls: Vec<CallConnection>,
    pub total_calls: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct CallConnection {
    pub path: PathBuf,
    pub site: super::callee_query::CallSite,
    pub origin: &'static str,
    pub candidates: Vec<DeclarationCandidate>,
    pub basis: &'static str,
}

fn source_candidate(
    declaration: super::declarations::Declaration,
    path: &Path,
    content: &str,
) -> DeclarationCandidate {
    let region = declaration.region();
    let (start_line, end_line) = super::declarations::lines_for(content, &region.declaration);
    DeclarationCandidate {
        name: region.name.clone().unwrap(),
        file: path.to_path_buf(),
        start_line,
        end_line,
        signature: Some(content[region.signature.clone()].to_string()),
        declaration: Some(declaration),
    }
}

/// Preserve expressions and immediate source owners before considering targets.
/// The retained names-only API below is a structural projection, never binding proof.
pub(crate) fn call_sites(
    root: tree_sitter::Node,
    language: &tree_sitter::Language,
    lang: Lang,
    content: &str,
) -> Vec<super::callee_query::CallSite> {
    let Some(query_text) = super::callee_query::callee_query_str(lang) else {
        return Vec::new();
    };
    let lines = content.lines().collect::<Vec<_>>();
    super::callee_query::with_callee_query(language, query_text, |query| {
        let (Some(name_index), Some(call_index)) = (
            query.capture_index_for_name("callee"),
            query.capture_index_for_name("call"),
        ) else {
            return Vec::new();
        };
        let mut cursor = tree_sitter::QueryCursor::new();
        let mut matches = cursor.matches(query, root, content.as_bytes());
        let mut sites = Vec::new();
        while let Some(matched) = matches.next() {
            let Some(call) = matched
                .captures
                .iter()
                .find(|capture| capture.index == call_index)
            else {
                continue;
            };
            for name in matched
                .captures
                .iter()
                .filter(|capture| capture.index == name_index)
            {
                let site = super::callee_query::CallSite::capture(
                    call.node, name.node, content, &lines, lang,
                );
                if lang != Lang::Elixir || !is_elixir_keyword(&site.name) {
                    sites.push(site);
                }
            }
        }
        sites.sort_by_key(|site| (site.expression.start, site.expression.end));
        sites.dedup_by(|left, right| {
            left.expression == right.expression && left.target == right.target
        });
        sites
    })
    .unwrap_or_default()
}

/// Source-container/receiver/import alternatives, not a second semantic resolver.
/// All candidates retain their source identity. Parameters, block bindings,
/// reassignment and runtime receiver dispatch are deliberately not inferred.
pub(crate) fn connections(
    path: &Path,
    content: &str,
    lang: Lang,
    range: Option<(u32, u32)>,
    selected: Option<&super::declarations::Declaration>,
    bloom: &crate::index::bloom::BloomFilterCache,
    sources: &super::OperationSources,
) -> Vec<CallConnection> {
    let Some(language) = outline_language(lang) else {
        return Vec::new();
    };
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&language).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(content, None) else {
        return Vec::new();
    };
    let local = if super::declarations::supports(lang) {
        selected.map_or_else(
            || super::declarations::collect(tree.root_node(), content),
            |declaration| declaration.file_declarations(),
        )
    } else {
        Vec::new()
    };
    let sites = call_sites(tree.root_node(), &language, lang, content)
        .into_iter()
        .filter(|site| {
            selected.map_or_else(
                || range.is_none_or(|(start, end)| site.line >= start && site.line <= end),
                |declaration| {
                    let span = &declaration.region().id.bytes;
                    span.start <= site.expression.start && site.expression.end <= span.end
                },
            )
        })
        .collect::<Vec<_>>();
    if sites.is_empty() {
        return Vec::new();
    }
    let imports = super::bindings::import_targets(tree.root_node(), content, path, sources);
    let mut imported = Vec::new();
    let mut paths = if sources.corpus_root().is_some() && super::declarations::supports(lang) {
        // Admitted TS/JS uses the source-aware binder alone. Mixing in the
        // protected read resolver adds untracked precedence probes and can
        // invalidate an otherwise fully retained semantic-selected target.
        Vec::new()
    } else {
        let paths = crate::read::imports::resolve_related_files_with_content(path, content);
        if paths.iter().any(|path| !imports.iter().any(|(_, _, tracked)| tracked == path))
            || !super::declarations::supports(lang) {
            sources.capture_unavailable("legacy import/package resolution inputs are not retained".into());
        }
        paths
    };
    paths.extend(imports.iter().map(|(_, _, path)| path.clone()));
    let names = sites
        .iter()
        .map(|site| site.name.clone())
        .chain(imports.iter().map(|(_, original, _)| original.clone()))
        .collect::<Vec<_>>();
    if !super::declarations::supports(lang) {
        // Legacy discovery supplies paths only. Re-read declarations from the
        // operation's retained image so their headers and source proof agree.
        paths.extend(
            structural_candidates_with_sources(&names, path, content, bloom, Some(sources))
                .into_iter()
                .map(|candidate| candidate.file),
        );
    }
    paths.sort();
    paths.dedup();
    let wanted_names = names.iter().map(String::as_str).collect();
    for imported_path in paths {
        if std::fs::metadata(&imported_path)
            .is_ok_and(|metadata| metadata.len() > super::bloom_walk::MAX_FILE_SIZE)
        {
            continue;
        }
        let Ok(imported_content) = sources.read_text(&imported_path) else {
            continue;
        };
        let crate::types::FileType::Code(imported_lang) =
            crate::lang::detect_file_type(&imported_path)
        else {
            continue;
        };
        collect_source_candidates(
            &imported_content,
            imported_lang,
            &imported_path,
            &wanted_names,
            &mut imported,
        );
    }
    sites
        .into_iter()
        .map(|site| {
            let origin = selected.map_or(
                "source-range origin; target ownership unverified",
                |declaration| {
                    if site.owner.as_ref() == Some(&declaration.region().id) {
                        "direct origin"
                    } else {
                        "nested origin; not a direct invocation by the selected declaration"
                    }
                },
            );
            let mut owners = Vec::new();
            let mut owner = site.owner.clone();
            while let Some(id) = owner {
                owners.push(Some(id.clone()));
                owner = local
                    .first()
                    .and_then(|declaration| {
                        declaration
                            .facts()
                            .regions
                            .iter()
                            .find(|region| region.id == id)
                    })
                    .and_then(|region| region.parent.clone());
            }
            owners.push(None);
            let same_name = local
                .iter()
                .filter(|declaration| {
                    declaration.region().name.as_deref() == Some(site.name.as_str())
                })
                .collect::<Vec<_>>();
            let mut basis = "source-container candidates; binding unverified";
            let candidates = if site.receiver.as_deref() == Some("this") {
                basis = "this receiver's containing-class candidates; runtime binding unverified";
                let class = local.first().and_then(|declaration| {
                    owners.iter().flatten().find(|id| {
                        declaration.facts().regions.iter().any(|region| {
                            &region.id == *id && region.kind == crate::tsjs_source::Kind::Class
                        })
                    })
                });
                same_name
                    .into_iter()
                    .filter(|declaration| {
                        class.is_some_and(|class| {
                            declaration.region().parent.as_ref() == Some(class)
                        })
                    })
                    .collect::<Vec<_>>()
            } else if site.receiver.is_some() {
                basis = "receiver type unresolved; same-name declaration alternatives";
                same_name
            } else {
                owners
                    .iter()
                    .find_map(|owner| {
                        let visible = same_name
                            .iter()
                            .copied()
                            .filter(|declaration| {
                                !matches!(
                                    declaration.region().kind,
                                    crate::tsjs_source::Kind::Method
                                        | crate::tsjs_source::Kind::Field
                                        | crate::tsjs_source::Kind::PropertySignature
                                ) && &declaration.region().parent == owner
                            })
                            .collect::<Vec<_>>();
                        (!visible.is_empty()).then_some(visible)
                    })
                    .unwrap_or_default()
            };
            let mut candidates = candidates
                .into_iter()
                .map(|declaration| source_candidate(declaration.clone(), path, content))
                .collect::<Vec<_>>();
            if (candidates.is_empty() || site.receiver.is_some())
                && site.receiver.as_deref() != Some("this")
            {
                if site.receiver.is_none() {
                    basis = "same/imported-name candidates; binding unverified";
                }
                let aliases = imports
                    .iter()
                    .filter(|(local, _, _)| local == &site.name && site.receiver.is_none())
                    .collect::<Vec<_>>();
                candidates.extend(
                    imported
                        .iter()
                        .filter(|candidate| {
                            if aliases.is_empty() {
                                candidate.name == site.name
                            } else {
                                aliases.iter().any(|(_, original, target)| {
                                    original == &candidate.name && target == &candidate.file
                                })
                            }
                        })
                        .cloned(),
                );
            }
            CallConnection {
                path: path.to_path_buf(),
                site,
                origin,
                candidates,
                basis,
            }
        })
        .collect()
}

/// Names-only projection of AST calls in physical rows. This intentionally loses
/// site, receiver and lexical origin; it must not be presented as resolved binding.
/// Site-aware consumers use `connections` instead.
pub fn extract_callee_names(
    content: &str,
    lang: Lang,
    def_range: Option<(u32, u32)>,
) -> Vec<String> {
    let Some(ts_lang) = outline_language(lang) else {
        return Vec::new();
    };

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&ts_lang).is_err() {
        return Vec::new();
    }

    let Some(tree) = parser.parse(content, None) else {
        return Vec::new();
    };

    let names = call_sites(tree.root_node(), &ts_lang, lang, content)
        .into_iter()
        .filter(|site| def_range.is_none_or(|(start, end)| site.line >= start && site.line <= end))
        .map(|site| site.name)
        .collect::<Vec<_>>();

    let mut names = names;
    names.sort();
    names.dedup();

    names
}

/// Keywords that should not appear as callee names in Elixir.
/// These are definition and import forms that are syntactically `call` nodes.
/// Superset of `ELIXIR_DEFINITION_TARGETS` (treesitter.rs) plus import keywords
/// (`use`, `import`, `alias`, `require`) and `defoverridable`.
fn is_elixir_keyword(name: &str) -> bool {
    matches!(
        name,
        "def"
            | "defp"
            | "defmodule"
            | "defmacro"
            | "defmacrop"
            | "defguard"
            | "defguardp"
            | "defdelegate"
            | "defstruct"
            | "defexception"
            | "defprotocol"
            | "defimpl"
            | "defoverridable"
            | "use"
            | "import"
            | "alias"
            | "require"
    )
}

/// Structural outline-name alternatives for languages without shared declarations.
fn collect_outline_candidates(
    entries: &[OutlineEntry],
    file_path: &Path,
    names: &HashSet<&str>,
    candidates: &mut Vec<DeclarationCandidate>,
) {
    for entry in entries {
        // Check top-level entry name
        if names.contains(entry.name.as_str()) {
            candidates.push(DeclarationCandidate {
                name: entry.name.clone(),
                file: file_path.to_path_buf(),
                start_line: entry.start_line,
                end_line: entry.end_line,
                signature: entry.signature.clone(),
                declaration: None,
            });
        }

        // Check children (methods in classes/impl blocks)
        for child in &entry.children {
            if names.contains(child.name.as_str()) {
                candidates.push(DeclarationCandidate {
                    name: child.name.clone(),
                    file: file_path.to_path_buf(),
                    start_line: child.start_line,
                    end_line: child.end_line,
                    signature: child.signature.clone(),
                    declaration: None,
                });
            }
        }
    }
}

/// Match source declaration names, not call bindings. Keep alternatives rather
/// than allowing the first outline spelling to consume a name.
pub fn structural_declaration_candidates(
    callee_names: &[String],
    source_path: &Path,
    source_content: &str,
    bloom: &crate::index::bloom::BloomFilterCache,
) -> Vec<DeclarationCandidate> {
    structural_candidates_with_sources(callee_names, source_path, source_content, bloom, None)
}

fn structural_candidates_with_sources(
    callee_names: &[String], source_path: &Path, source_content: &str,
    bloom: &crate::index::bloom::BloomFilterCache, sources: Option<&super::OperationSources>,
) -> Vec<DeclarationCandidate> {
    if callee_names.is_empty() {
        return Vec::new();
    }

    let file_type = crate::lang::detect_file_type(source_path);
    let crate::types::FileType::Code(lang) = file_type else {
        return Vec::new();
    };

    let names: HashSet<&str> = callee_names.iter().map(String::as_str).collect();
    let mut candidates = Vec::new();

    collect_source_candidates(source_content, lang, source_path, &names, &mut candidates);

    // Imported-file alternatives remain visible even when a local name exists.
    let imported =
        crate::read::imports::resolve_related_files_with_content(source_path, source_content);

    for import_path in imported {
        // Reuse the bounded read and bloom prefilter for structural names.
        let Some((import_content, _mtime)) = super::bloom_walk::read_with_sources(
            &import_path,
            names.iter().copied(),
            bloom,
            super::bloom_walk::MAX_FILE_SIZE,
            sources,
        ) else {
            continue;
        };

        let import_type = crate::lang::detect_file_type(&import_path);
        let crate::types::FileType::Code(import_lang) = import_type else {
            continue;
        };

        collect_source_candidates(
            &import_content,
            import_lang,
            &import_path,
            &names,
            &mut candidates,
        );
    }

    // Go also shares declarations across same-directory package files.
    if lang == Lang::Go {
        collect_same_package_candidates(&names, &mut candidates, source_path, sources);
    }

    candidates
}

fn collect_source_candidates(
    content: &str,
    lang: Lang,
    path: &Path,
    names: &HashSet<&str>,
    candidates: &mut Vec<DeclarationCandidate>,
) {
    if super::declarations::supports(lang) {
        let Some(language) = outline_language(lang) else {
            return;
        };
        let mut parser = tree_sitter::Parser::new();
        if parser.set_language(&language).is_err() {
            return;
        }
        let Some(tree) = parser.parse(content, None) else {
            return;
        };
        candidates.extend(
            super::declarations::collect(tree.root_node(), content)
                .into_iter()
                .filter(|declaration| {
                    declaration
                        .region()
                        .name
                        .as_deref()
                        .is_some_and(|name| names.contains(name))
                })
                .map(|declaration| source_candidate(declaration, path, content)),
        );
    } else {
        collect_outline_candidates(&get_outline_entries(content, lang), path, names, candidates);
    }
}

/// Bounded Go same-package declaration alternatives. Build tags and call binding
/// are not inferred from a matching name in a neighboring file.
fn collect_same_package_candidates(
    names: &HashSet<&str>,
    candidates: &mut Vec<DeclarationCandidate>,
    source_path: &Path,
    sources: Option<&super::OperationSources>,
) {
    const MAX_FILES: usize = 20;
    const MAX_FILE_SIZE: u64 = 100_000; // 100KB

    let Some(dir) = source_path.parent() else {
        return;
    };

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    // Collect eligible .go files, sorted for deterministic order
    let mut go_files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| {
            let path = e.path();
            let name = e.file_name();
            let name_str = name.to_string_lossy();
            path != source_path
                && name_str.ends_with(".go")
                && !name_str.ends_with("_test.go")
                && e.metadata().is_ok_and(|m| m.len() <= MAX_FILE_SIZE)
        })
        .map(|e| e.path())
        .collect();

    go_files.sort();
    go_files.truncate(MAX_FILES);

    for go_path in go_files {
        let content = match sources {
            Some(sources) => sources.read_text(&go_path).map(|text| text.as_str().to_owned()),
            None => std::fs::read_to_string(&go_path),
        };
        let Ok(content) = content else {
            continue;
        };

        let outline = get_outline_entries(&content, Lang::Go);
        collect_outline_candidates(&outline, &go_path, names, candidates);
    }
}

/// Expand candidate bodies once, to a fixed second hop. Preserve recursive and
/// repeated sites; no recursion or path/line cycle suppression is needed here.
pub(crate) fn candidate_connections(
    declarations: Vec<DeclarationCandidate>,
    bloom: &crate::index::bloom::BloomFilterCache,
    sources: &super::OperationSources,
    mut budget: usize,
) -> Vec<CandidateConnections> {
    let mut visited = HashSet::new();
    let mut result = Vec::new();
    for declaration in declarations {
        let identity = declaration.declaration.as_ref().map(|source| {
            let (start, end, kind) = source.key();
            (start, end, kind.to_string())
        });
        if !visited.insert((
            declaration.file.clone(),
            declaration.start_line,
            declaration.end_line,
            declaration.name.clone(),
            identity,
        )) {
            continue;
        }
        if budget == 0 {
            break;
        }
        let Ok(content) = sources.read_text(&declaration.file) else {
            continue;
        };
        let crate::types::FileType::Code(lang) = crate::lang::detect_file_type(&declaration.file)
        else {
            continue;
        };
        let mut calls = connections(
            &declaration.file,
            &content,
            lang,
            Some((declaration.start_line, declaration.end_line)),
            declaration.declaration.as_ref(),
            bloom,
            sources,
        );
        let total_calls = calls.len();
        calls.truncate(budget);
        budget -= calls.len();
        result.push(CandidateConnections {
            declaration,
            calls,
            total_calls,
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_kotlin_callee_names() {
        let kotlin = r#"fun example() {
    println("hello")
    val x = listOf(1, 2, 3)
    x.forEach { it.toString() }
}
"#;
        let names = extract_callee_names(kotlin, crate::types::Lang::Kotlin, None);

        assert!(
            names.contains(&"println".to_string()),
            "expected println, got: {names:?}"
        );
        assert!(
            names.contains(&"listOf".to_string()),
            "expected listOf, got: {names:?}"
        );
        assert!(
            names.contains(&"forEach".to_string()),
            "expected forEach, got: {names:?}"
        );
        assert!(
            names.contains(&"toString".to_string()),
            "expected toString, got: {names:?}"
        );
    }

    #[test]
    fn extract_php_callee_names() {
        let php = r"<?php
function run($svc): void {
    local_helper();
    Foo\Bar::staticCall();
    $svc->methodCall();
    $svc?->nullableCall();
}
";

        let names = extract_callee_names(php, Lang::Php, None);

        assert!(names.contains(&"local_helper".to_string()));
        assert!(names.contains(&"staticCall".to_string()));
        assert!(names.contains(&"methodCall".to_string()));
        assert!(names.contains(&"nullableCall".to_string()));
    }

    #[test]
    fn extract_elixir_callee_names() {
        let elixir = r#"defmodule Example do
  def run(conn) do
    result = query(conn, "SELECT 1")
    Enum.map(result, &to_string/1)
    IO.puts("done")
    local_func()
  end
end
"#;
        let names = extract_callee_names(elixir, Lang::Elixir, None);

        assert!(
            names.contains(&"query".to_string()),
            "expected query, got: {names:?}"
        );
        assert!(
            names.contains(&"map".to_string()),
            "expected map (from Enum.map), got: {names:?}"
        );
        assert!(
            names.contains(&"puts".to_string()),
            "expected puts (from IO.puts), got: {names:?}"
        );
        assert!(
            names.contains(&"local_func".to_string()),
            "expected local_func, got: {names:?}"
        );

        // Definition keywords must NOT appear as callees
        assert!(
            !names.contains(&"def".to_string()),
            "definition keyword 'def' should be filtered, got: {names:?}"
        );
        assert!(
            !names.contains(&"defmodule".to_string()),
            "definition keyword 'defmodule' should be filtered, got: {names:?}"
        );
    }

    #[test]
    fn extract_elixir_callee_names_pipes() {
        let elixir = r#"defmodule Pipes do
  def run(conn) do
    conn
    |> prepare("sql")
    |> execute()
    |> Enum.map(&transform/1)
  end
end
"#;
        let names = extract_callee_names(elixir, Lang::Elixir, None);

        // Pipe targets are regular call nodes — the callee query should find them
        assert!(
            names.contains(&"prepare".to_string()),
            "expected prepare from pipe, got: {names:?}"
        );
        assert!(
            names.contains(&"execute".to_string()),
            "expected execute from pipe, got: {names:?}"
        );
        assert!(
            names.contains(&"map".to_string()),
            "expected map from Enum.map pipe, got: {names:?}"
        );
    }
}
