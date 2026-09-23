//! Current-source TypeScript/JavaScript alias and re-export binding tracer.
//!
//! Given one canonical owner (path + symbol) and a scope root, resolves direct
//! import aliases, chained named re-exports, and tsconfig `baseUrl`/`paths`
//! aliases, then scans resolved local names using the current pi-nav grammars.
//! Returns carrier path, 1-based line, enclosing owner/range, call text, and
//! shared current content. Cycles and known-module missing exports fail closed.
//! Deterministic order. No prepared store or second parser stack.
//!
//! Donors: RepoSkein deterministic resolver ladder (alias → re-export chase with
//! cycle/visited + hard-stop on missing export) and CRG `tsconfig_resolver.py`
//! `baseUrl`/`paths` wildcard semantics. Clean pi-nav implementation using
//! existing tree-sitter grammars, `callee_query`, `outline_language`, `walker`,
//! and `scope::walk_to_enclosing_callable`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::lang::outline::outline_language;
use crate::read::imports::normalize_path;
use crate::types::Lang;

// ---------- tsconfig ----------

#[derive(Debug, Clone, Default)]
struct TsconfigPaths {
    base_url: Option<PathBuf>,
    map: Vec<(String, Vec<String>)>,
    dir: PathBuf,
}

fn strip_jsonc_comments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    let mut in_str = false;
    let mut esc = false;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < bytes.len() {
            let n = bytes[i + 1] as char;
            if n == '/' {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            if n == '*' {
                i += 2;
                while i + 1 < bytes.len() {
                    if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    // trailing commas before } or ]
    let chars: Vec<char> = out.chars().collect();
    let mut cleaned = String::with_capacity(chars.len());
    for idx in 0..chars.len() {
        let ch = chars[idx];
        if ch == ',' {
            let mut j = idx + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                continue;
            }
        }
        cleaned.push(ch);
    }
    cleaned
}

fn load_tsconfig_for_file(file_path: &Path, sources: &super::OperationSources) -> Option<TsconfigPaths> {
    let mut dir = file_path.parent()?;
    loop {
        let cand = dir.join("tsconfig.json");
        if sources.input_exists(&cand) {
            if let Ok(text) = sources.read_input_text(&cand) {
                let stripped = strip_jsonc_comments(&text);
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stripped) {
                    let co = v.get("compilerOptions");
                    let base_url = co
                        .and_then(|c| c.get("baseUrl"))
                        .and_then(|b| b.as_str())
                        .map(|s| normalize_path(&dir.join(s)));
                    let mut map = Vec::new();
                    if let Some(paths) = co.and_then(|c| c.get("paths")).and_then(|p| p.as_object())
                    {
                        for (k, vv) in paths {
                            if let Some(arr) = vv.as_array() {
                                let targets: Vec<String> = arr
                                    .iter()
                                    .filter_map(|e| e.as_str().map(|s| s.to_string()))
                                    .collect();
                                if !targets.is_empty() {
                                    map.push((k.clone(), targets));
                                }
                            }
                        }
                    }
                    return Some(TsconfigPaths {
                        base_url,
                        map,
                        dir: dir.to_path_buf(),
                    });
                }
            }
            return None;
        }
        dir = dir.parent()?;
    }
}

fn match_pattern(pattern: &str, import_str: &str) -> Option<String> {
    if let Some(star) = pattern.find('*') {
        let prefix = &pattern[..star];
        let suffix = &pattern[star + 1..];
        if !import_str.starts_with(prefix) {
            return None;
        }
        if !suffix.is_empty() && !import_str.ends_with(suffix) {
            return None;
        }
        let end = import_str.len() - suffix.len();
        Some(import_str[prefix.len()..end].to_string())
    } else if pattern == import_str {
        Some(String::new())
    } else {
        None
    }
}

fn probe_ts_path(base: &Path, sources: &super::OperationSources) -> Option<PathBuf> {
    for ext in &[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] {
        let cand = PathBuf::from(format!("{}{ext}", base.display()));
        if sources.input_exists(&cand) && sources.input_is_file(&cand) {
            return Some(cand);
        }
    }
    if sources.input_exists(base) && sources.input_is_file(base) {
        return Some(base.to_path_buf());
    }
    for name in &[
        "index.ts",
        "index.tsx",
        "index.js",
        "index.jsx",
        "index.mjs",
        "index.cjs",
    ] {
        let cand = base.join(name);
        if sources.input_exists(&cand) {
            return Some(cand);
        }
    }
    None
}

fn resolve_tsconfig_alias(import_str: &str, file_path: &Path, sources: &super::OperationSources) -> Option<PathBuf> {
    let cfg = load_tsconfig_for_file(file_path, sources)?;
    if cfg.map.is_empty() {
        return None;
    }
    let base = cfg.base_url.clone().unwrap_or_else(|| cfg.dir.clone());
    for (pattern, targets) in &cfg.map {
        let Some(captured) = match_pattern(pattern, import_str) else {
            continue;
        };
        for target in targets {
            let expanded = if let Some(star) = target.find('*') {
                format!("{}{}{}", &target[..star], captured, &target[star + 1..])
            } else {
                target.clone()
            };
            let joined = normalize_path(&base.join(&expanded));
            if let Some(probed) = probe_ts_path(&joined, sources) {
                return Some(probed);
            }
            if sources.input_exists(&joined) && sources.input_is_file(&joined) {
                return Some(joined);
            }
        }
    }
    None
}

// ---------- import / re-export extraction ----------

#[derive(Debug, Clone)]
struct Binding {
    local: String,
    original: String,
    specifier: String,
    is_reexport: bool,
}

/// Existing parsed import/alias evidence, not a claim about a call's binding.
pub(crate) fn import_targets(
    root: tree_sitter::Node,
    content: &str,
    path: &Path,
    sources: &super::OperationSources,
) -> Vec<(String, String, PathBuf)> {
    collect_import_bindings(root, content.as_bytes())
        .into_iter()
        .inspect(|binding| {
            if sources.corpus_root().is_none() && !binding.is_reexport && [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
                .iter().any(|suffix| binding.specifier.ends_with(suffix)) {
                // The protected legacy import reader probes e.g. helper.js.ts
                // before helper.js; this binder strips the suffix instead.
                // Equal returned paths do not establish equal negative probes.
                sources.capture_unavailable("legacy explicit-extension import probes are not retained".into());
            }
        })
        .filter(|binding| !binding.is_reexport && binding.original != "*")
        .filter_map(|binding| {
            let target = resolve_specifier_to_path(path.parent()?, &binding.specifier, path, sources)?;
            Some((binding.local, binding.original, target))
        })
        .collect()
}

fn node_text(node: tree_sitter::Node, src: &[u8]) -> String {
    node.utf8_text(src).unwrap_or("").to_string()
}

fn collect_import_bindings(root: tree_sitter::Node, src: &[u8]) -> Vec<Binding> {
    let mut out = Vec::new();
    let mut cursor = root.walk();
    for child in root.named_children(&mut cursor) {
        match child.kind() {
            "import_statement" => {
                let Some(src_node) = child.child_by_field_name("source") else {
                    continue;
                };
                let spec = src_node
                    .named_child(0)
                    .map(|n| node_text(n, src))
                    .unwrap_or_default();
                let clause = child
                    .named_children(&mut child.walk())
                    .find(|n| n.kind() == "import_clause");
                if let Some(clause) = clause {
                    for (local, original) in clause_symbols(clause, src) {
                        out.push(Binding {
                            local,
                            original,
                            specifier: spec.clone(),
                            is_reexport: false,
                        });
                    }
                }
            }
            "export_statement" => {
                let Some(src_node) = child.child_by_field_name("source") else {
                    continue;
                };
                let spec = src_node
                    .named_child(0)
                    .map(|n| node_text(n, src))
                    .unwrap_or_default();
                let mut emitted = false;
                let mut cc = child.walk();
                for n in child.named_children(&mut cc) {
                    if n.kind() == "export_clause" {
                        for (local, original) in export_clause_symbols(n, src) {
                            out.push(Binding {
                                local,
                                original,
                                specifier: spec.clone(),
                                is_reexport: true,
                            });
                        }
                        emitted = true;
                    } else if n.kind() == "namespace_export" {
                        out.push(Binding {
                            local: String::new(),
                            original: "*".to_string(),
                            specifier: spec.clone(),
                            is_reexport: true,
                        });
                        emitted = true;
                    }
                }
                if !emitted {
                    let has_star = (0..child.child_count()).any(|i| {
                        child
                            .child(i as u32)
                            .map(|c| !c.is_named() && node_text(c, src) == "*")
                            .unwrap_or(false)
                    });
                    if has_star {
                        out.push(Binding {
                            local: String::new(),
                            original: "*".to_string(),
                            specifier: spec.clone(),
                            is_reexport: true,
                        });
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn clause_symbols(clause: tree_sitter::Node, src: &[u8]) -> Vec<(String, String)> {
    let mut v = Vec::new();
    let mut c = clause.walk();
    for child in clause.named_children(&mut c) {
        match child.kind() {
            "identifier" => {
                let s = node_text(child, src);
                v.push((s.clone(), s));
            }
            "named_imports" => {
                let mut nc = child.walk();
                for spec in child.named_children(&mut nc) {
                    if spec.kind() == "import_specifier" {
                        if let Some(name) = spec.child_by_field_name("name") {
                            let original = node_text(name, src);
                            let local = spec
                                .child_by_field_name("alias")
                                .map(|a| node_text(a, src))
                                .unwrap_or_else(|| original.clone());
                            v.push((local, original));
                        }
                    }
                }
            }
            "namespace_import" => {
                let mut nc = child.walk();
                for n in child.named_children(&mut nc) {
                    if n.kind() == "identifier" {
                        let s = node_text(n, src);
                        v.push((s.clone(), s));
                    }
                }
            }
            _ => {}
        }
    }
    v
}

fn export_clause_symbols(clause: tree_sitter::Node, src: &[u8]) -> Vec<(String, String)> {
    let mut v = Vec::new();
    let mut c = clause.walk();
    for spec in clause.named_children(&mut c) {
        if spec.kind() == "export_specifier" {
            if let Some(name) = spec.child_by_field_name("name") {
                let original = node_text(name, src);
                let local = spec
                    .child_by_field_name("alias")
                    .map(|a| node_text(a, src))
                    .unwrap_or_else(|| original.clone());
                v.push((local, original));
            }
        }
    }
    v
}

fn resolve_specifier_to_path(dir: &Path, specifier: &str, importer_path: &Path, sources: &super::OperationSources) -> Option<PathBuf> {
    let is_relative =
        specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with('/');
    if !is_relative {
        if let Some(p) = resolve_tsconfig_alias(specifier, importer_path, sources) {
            return Some(normalize_path(&p));
        }
        if specifier.starts_with('@') {
            return None;
        }
        if !specifier.contains('/') && !specifier.starts_with('.') {
            return None;
        }
    }
    // Admission keys are normalized project paths, not unresolved ../ spellings.
    // Normalize before the tracked probes, rather than only their returned path.
    let base = normalize_path(&dir.join(specifier));
    let stripped = {
        let s = base.display().to_string();
        let mut out = s;
        for ext in &[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] {
            if let Some(st) = out.strip_suffix(ext) {
                out = st.to_string();
                break;
            }
        }
        PathBuf::from(out)
    };
    for ext in &[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] {
        let cand = PathBuf::from(format!("{}{ext}", stripped.display()));
        if sources.input_exists(&cand) && sources.input_is_file(&cand) {
            return Some(normalize_path(&cand));
        }
    }
    if sources.input_exists(&stripped) && sources.input_is_file(&stripped) {
        return Some(normalize_path(&stripped));
    }
    for name in &[
        "index.ts",
        "index.tsx",
        "index.js",
        "index.jsx",
        "index.mjs",
        "index.cjs",
    ] {
        let cand = stripped.join(name);
        if sources.input_exists(&cand) {
            return Some(normalize_path(&cand));
        }
    }
    None
}

// ---------- carrier scan ----------

pub type AliasCaller = super::callers::CallerMatch;

fn find_callers_for_target(
    path: &Path,
    targets: &HashSet<String>,
    content: &str,
    lang: Lang,
) -> Vec<(String, AliasCaller)> {
    let Some(language) = outline_language(lang) else {
        return Vec::new();
    };
    super::callers::find_callers_treesitter_batch(path, targets, &language, content, lang)
}

// ---------- cache + chase ----------

fn build_binding_cache(scope: &Path, sources: &super::OperationSources) -> HashMap<PathBuf, Vec<Binding>> {
    let mut cache: HashMap<PathBuf, Vec<Binding>> = HashMap::new();
    let walker = match sources.walker(scope, None) {
        Ok(w) => w,
        Err(_) => return cache,
    };
    let m = Mutex::new(&mut cache);
    walker.run(|| {
        let m = &m;
        Box::new(move |entry| {
            let Ok(entry) = entry else {
                return ignore::WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                return ignore::WalkState::Continue;
            }
            let path = entry.path().to_path_buf();
            if crate::search::SKIP_DIRS
                .iter()
                .any(|d| path.components().any(|c| c.as_os_str() == *d))
            {
                return ignore::WalkState::Continue;
            }
            let ft = crate::lang::detect_file_type(&path);
            let crate::types::FileType::Code(lang) = ft else {
                return ignore::WalkState::Continue;
            };
            if !matches!(lang, Lang::TypeScript | Lang::Tsx | Lang::JavaScript) {
                return ignore::WalkState::Continue;
            }
            let Ok(content) = sources.read_input_text(&path) else {
                return ignore::WalkState::Continue;
            };
            if !content.contains("import") && !content.contains("export") {
                return ignore::WalkState::Continue;
            }
            let Some(ts_lang) = outline_language(lang) else {
                return ignore::WalkState::Continue;
            };
            let mut parser = tree_sitter::Parser::new();
            if parser.set_language(&ts_lang).is_err() {
                return ignore::WalkState::Continue;
            };
            let Some(tree) = parser.parse(content.as_str(), None) else {
                return ignore::WalkState::Continue;
            };
            let bindings = collect_import_bindings(tree.root_node(), content.as_bytes());
            if !bindings.is_empty() {
                let mut g = m.lock().unwrap();
                // Canonical cache keys: tempdirs and symlinked roots (e.g.
                // macOS `/var` → `/private/var`) otherwise split the same file
                // between walked importer paths and the caller's target path,
                // making the alias chase miss real carriers.
                g.insert(
                    normalize_path(&sources.input_canonicalize(&path).unwrap_or_else(|_| path.clone())),
                    bindings,
                );
            }
            ignore::WalkState::Continue
        })
    });
    cache
}

fn chase_to_target(
    cur_path: &Path,
    cur_sym: &str,
    target_path: &Path,
    target_sym: &str,
    cache: &HashMap<PathBuf, Vec<Binding>>,
    visited: &mut HashSet<(PathBuf, String)>,
    depth: usize,
    sources: &super::OperationSources,
) -> bool {
    const MAX: usize = 8;
    if depth > MAX {
        return false;
    }
    let norm_cur = normalize_path(cur_path);
    if norm_cur == normalize_path(target_path) && cur_sym == target_sym {
        return true;
    }
    let Some(bindings) = cache.get(&norm_cur) else {
        return false;
    };
    for b in bindings
        .iter()
        .filter(|b| b.is_reexport && b.local == cur_sym)
    {
        let key = (norm_cur.clone(), b.original.clone());
        if !visited.insert(key.clone()) {
            continue;
        }
        let Some(next_path) = resolve_specifier_to_path(
            cur_path.parent().unwrap_or(Path::new(".")),
            &b.specifier,
            cur_path,
            sources,
        ) else {
            continue;
        };
        if chase_to_target(
            &next_path,
            &b.original,
            target_path,
            target_sym,
            cache,
            visited,
            depth + 1,
            sources,
        ) {
            return true;
        }
    }
    false
}

fn alias_map(
    target_path: &Path,
    target_sym: &str,
    _scope: &Path,
    cache: &HashMap<PathBuf, Vec<Binding>>,
    sources: &super::OperationSources,
) -> HashMap<PathBuf, Vec<String>> {
    let mut map: HashMap<PathBuf, Vec<String>> = HashMap::new();
    let target_norm = normalize_path(target_path);
    for (file, bindings) in cache {
        for b in bindings.iter().filter(|b| !b.is_reexport) {
            let dir = file.parent().unwrap_or(Path::new("."));
            let Some(resolved) = resolve_specifier_to_path(dir, &b.specifier, file, sources) else {
                continue;
            };
            let mut visited = HashSet::new();
            visited.insert((normalize_path(&resolved), b.original.clone()));
            if chase_to_target(
                &resolved,
                &b.original,
                &target_norm,
                target_sym,
                cache,
                &mut visited,
                0,
                sources,
            ) {
                map.entry(file.clone()).or_default().push(b.local.clone());
            }
        }
    }
    map
}

/// Resolve alias callers for one target symbol. Thin wrapper over the
/// batched entry; see `find_alias_callers_batch`.
/// Kept as the focused single-symbol entry exercised by the binder tests;
/// production callers use the batched form.
#[cfg_attr(not(test), allow(dead_code))]
pub fn find_alias_callers(
    target_path: &Path,
    target_symbol: &str,
    scope: &Path,
) -> Vec<(String, AliasCaller)> {
    find_alias_callers_batch(target_path, std::slice::from_ref(&target_symbol), scope)
}

/// Resolve alias callers for several exported symbols of one target file.
///
/// Builds the import-binding cache once for the scope, then for each symbol
/// computes the alias map (direct imports + chained named re-exports +
/// tsconfig `baseUrl`/`paths`) and scans the resolved local names as call
/// carriers in the importing files. Carriers preserve current path, 1-based
/// line, enclosing owner/range, call text, and shared content. Output is
/// deterministic and deduplicated by the exact `(path, line, carrier)`
/// identity — never fuzzy. Unsupported forms (export-star, namespace/default,
/// CommonJS, package-self) produce no bindings and no inferred rows.
///
/// Returns empty when the target file is not TypeScript/TSX/JavaScript —
/// alias binding only speaks the TS/JS module system.
pub fn find_alias_callers_batch<S: AsRef<str>>(
    target_path: &Path,
    symbols: &[S],
    scope: &Path,
) -> Vec<(String, AliasCaller)> {
    find_alias_callers_batch_with_sources(target_path, symbols, scope, &super::OperationSources::default())
}

pub(crate) fn find_alias_callers_batch_with_sources<S: AsRef<str>>(
    target_path: &Path,
    symbols: &[S],
    scope: &Path,
    sources: &super::OperationSources,
) -> Vec<(String, AliasCaller)> {
    let ft = crate::lang::detect_file_type(target_path);
    let crate::types::FileType::Code(lang) = ft else {
        return Vec::new();
    };
    if !matches!(lang, Lang::TypeScript | Lang::Tsx | Lang::JavaScript) {
        return Vec::new();
    }
    if symbols.is_empty() {
        return Vec::new();
    }
    let cache = build_binding_cache(scope, sources);
    // Canonical target: cache keys are canonical (see build_binding_cache), so
    // the chase compares equal paths even under symlinked roots (macOS `/var`
    // → `/private/var`) where the caller's target and walked importer paths
    // would otherwise spell the same file differently.
    let target = sources.input_canonicalize(target_path)
        .unwrap_or_else(|_| target_path.to_path_buf());
    // One local-name set per importing file, so each file is read and parsed
    // exactly once even when several target symbols share an importer.
    let mut locals_by_file: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    for symbol in symbols {
        let amap = alias_map(&target, symbol.as_ref(), scope, &cache, sources);
        for (file, locals) in amap {
            locals_by_file.entry(file).or_default().extend(locals);
        }
    }
    let mut out = Vec::new();
    for (file, locals) in locals_by_file {
        let Ok(content) = sources.read_input_text(&file) else {
            continue;
        };
        let ft = crate::lang::detect_file_type(&file);
        let crate::types::FileType::Code(lang) = ft else {
            continue;
        };
        out.extend(find_callers_for_target(&file, &locals, &content, lang));
    }
    super::callers::merge_caller_rows(out, Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn write(p: &Path, content: &str) {
        if let Some(dir) = p.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    #[test]
    fn p1_three_alias_routes_resolve() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        write(
            &src.join("manifest.ts"),
            "export function loadManifest(raw: string) {\n  return JSON.parse(raw);\n}\n",
        );
        write(
            &src.join("direct.ts"),
            "import { loadManifest as localLoad } from './manifest';\nexport function directCaller(raw: string) {\n  return localLoad(raw);\n}\n",
        );
        write(
            &src.join("barrel-a.ts"),
            "export { loadManifest as parseManifest } from './manifest';\n",
        );
        write(
            &src.join("barrel-b.ts"),
            "export { parseManifest as readManifest } from './barrel-a';\n",
        );
        write(
            &src.join("reexport.ts"),
            "import { readManifest } from './barrel-b';\nexport function reexportCaller(raw: string) {\n  return readManifest(raw);\n}\n",
        );
        write(
            &src.join("path-alias.ts"),
            "import { loadManifest as configLoad } from '@/manifest';\nexport function pathAliasCaller(raw: string) {\n  return configLoad(raw);\n}\n",
        );
        write(
            &dir.path().join("tsconfig.json"),
            r#"{"compilerOptions":{"baseUrl":"./src","paths":{"@/*":["*"]}}}"#,
        );
        let target = src.join("manifest.ts");
        let hits = find_alias_callers(&target, "loadManifest", dir.path());
        let mut by_file: HashMap<String, Vec<AliasCaller>> = HashMap::new();
        // `ac.path` is canonicalized (see `build_binding_cache`) while
        // tempdir paths on macOS spell /var as /private/var; strip against the
        // canonicalized root so both spellings compare equal.
        let root = dir
            .path()
            .canonicalize()
            .unwrap_or_else(|_| dir.path().to_path_buf());
        for (_, ac) in hits {
            let key = ac
                .path
                .strip_prefix(&root)
                .unwrap_or(&ac.path)
                .display()
                .to_string();
            by_file.entry(key).or_default().push(ac);
        }
        assert!(
            by_file.contains_key("src/direct.ts"),
            "direct.ts missing: {:?}",
            by_file.keys().collect::<Vec<_>>()
        );
        assert!(
            by_file.contains_key("src/reexport.ts"),
            "reexport.ts missing: {:?}",
            by_file.keys().collect::<Vec<_>>()
        );
        assert!(
            by_file.contains_key("src/path-alias.ts"),
            "path-alias.ts missing: {:?}",
            by_file.keys().collect::<Vec<_>>()
        );
        let direct = &by_file["src/direct.ts"][0];
        assert_eq!(direct.calling_function, "directCaller");
        assert!(direct.line >= 2 && direct.line <= 4, "line {}", direct.line);
        assert!(
            direct.call_text.contains("localLoad"),
            "{}",
            direct.call_text
        );
        let re = &by_file["src/reexport.ts"][0];
        assert_eq!(re.calling_function, "reexportCaller");
        assert!(re.call_text.contains("readManifest"));
        let pa = &by_file["src/path-alias.ts"][0];
        assert_eq!(pa.calling_function, "pathAliasCaller");
        assert!(pa.call_text.contains("configLoad"));
    }

    #[test]
    fn reexport_cycle_terminates_and_chain_still_resolves() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        write(
            &src.join("manifest.ts"),
            "export function loadManifest(raw: string){return raw;}\n",
        );
        write(
            &src.join("barrel-a.ts"),
            "export { loadManifest as parseManifest } from './manifest';\nexport { cycleSym as parseManifest2 } from './barrel-b';\n",
        );
        write(
            &src.join("barrel-b.ts"),
            "export { parseManifest as cycleSym } from './barrel-a';\nexport { parseManifest as readManifest } from './barrel-a';\n",
        );
        write(
            &src.join("reexport.ts"),
            "import { readManifest } from './barrel-b';\nexport function reexportCaller(raw: string){ return readManifest(raw);}\n",
        );
        let target = src.join("manifest.ts");
        let hits = find_alias_callers(&target, "loadManifest", dir.path());
        assert!(!hits.is_empty(), "chain must still resolve despite cycle");
        assert!(hits.iter().any(|(_, ac)| ac.path.ends_with("reexport.ts")));
    }

    #[test]
    fn known_module_missing_export_does_not_fall_through_to_same_name() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        write(
            &src.join("manifest.ts"),
            "export function loadManifest(raw: string){return raw;}\n",
        );
        write(
            &src.join("other.ts"),
            "export function loadManifest(raw: string){return raw;}\n",
        );
        write(&src.join("barrel.ts"), "export const x = 1;\n");
        write(
            &src.join("consumer.ts"),
            "import { loadManifest } from './barrel';\nfunction loadManifest(raw: string){return raw;}\nexport function caller(raw: string){ return loadManifest(raw); }\n",
        );
        write(
            &src.join("good.ts"),
            "import { loadManifest as ok } from './manifest';\nexport function goodCaller(raw: string){ return ok(raw); }\n",
        );
        let target = src.join("manifest.ts");
        let hits = find_alias_callers(&target, "loadManifest", dir.path());
        assert!(
            !hits.iter().any(|(_, ac)| ac.path.ends_with("consumer.ts")),
            "must not fall through on missing export: {:?}",
            hits.iter()
                .map(|(_, ac)| ac.path.display().to_string())
                .collect::<Vec<_>>()
        );
        assert!(hits.iter().any(|(_, ac)| ac.path.ends_with("good.ts")));
    }

    #[test]
    fn carrier_fidelity_line_and_enclosing_owner_and_source_text() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        write(
            &src.join("manifest.ts"),
            "export function loadManifest(raw: string){return raw;}\n",
        );
        write(
            &src.join("direct.ts"),
            "import { loadManifest as localLoad } from './manifest';\nexport function directCaller(raw: string) {\n  return localLoad(raw);\n}\n",
        );
        let target = src.join("manifest.ts");
        let hits = find_alias_callers(&target, "loadManifest", dir.path());
        let (_, ac) = hits
            .iter()
            .find(|(_, ac)| ac.path.ends_with("direct.ts"))
            .expect("direct hit");
        assert_eq!(ac.calling_function, "directCaller");
        assert!(ac.caller_range.is_some());
        let (s, e) = ac.caller_range.unwrap();
        assert!(
            s <= ac.line && ac.line <= e,
            "range {s}-{e} line {}",
            ac.line
        );
        assert!(ac.content.contains("localLoad"));
        assert!(ac.call_text.contains("localLoad"));
    }

    #[test]
    fn mjs_cjs_detection_and_alias_call() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        write(
            &src.join("manifest.ts"),
            "export function loadManifest(raw: string){return raw;}\n",
        );
        write(
            &src.join("use-mjs.mjs"),
            "import { loadManifest as mjsLoad } from './manifest.js';\nexport function mjsCaller(raw){ return mjsLoad(raw); }\n",
        );
        let target = src.join("manifest.ts");
        let hits = find_alias_callers(&target, "loadManifest", dir.path());
        let has_mjs = hits
            .iter()
            .any(|(_, ac)| ac.path.extension().and_then(|e| e.to_str()) == Some("mjs"));
        assert!(
            has_mjs,
            "mjs alias call must be found; hits: {:?}",
            hits.iter()
                .map(|(_, ac)| ac.path.display().to_string())
                .collect::<Vec<_>>()
        );
        assert!(matches!(
            crate::lang::detect_file_type(Path::new("a.mjs")),
            crate::types::FileType::Code(Lang::JavaScript)
        ));
        assert!(matches!(
            crate::lang::detect_file_type(Path::new("a.cjs")),
            crate::types::FileType::Code(Lang::JavaScript)
        ));
    }
}
