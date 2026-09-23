//! Per-language tree-sitter queries for matching call expressions, with a
//! global compiled-`Query` cache. Used by the caller-direction walk
//! (`callers::find_callers_batch`) and the callee-direction extractor
//! (`callees::extract_callee_names`) — they share both the query strings
//! and the compiled-query cache.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use crate::types::Lang;

/// Return the tree-sitter query string for extracting callee names in the given language.
/// Each language has patterns targeting `@callee` captures on call-like expressions.
pub(crate) fn callee_query_str(lang: Lang) -> Option<&'static str> {
    match lang {
        Lang::Rust => Some(concat!(
            "(call_expression function: (identifier) @callee) @call\n",
            "(call_expression function: (field_expression field: (field_identifier) @callee)) @call\n",
            "(call_expression function: (scoped_identifier name: (identifier) @callee)) @call\n",
            "(macro_invocation macro: (identifier) @callee) @call\n",
        )),
        Lang::Go => Some(concat!(
            "(call_expression function: (identifier) @callee) @call\n",
            "(call_expression function: (selector_expression field: (field_identifier) @callee)) @call\n",
        )),
        Lang::Python => Some(concat!(
            "(call function: (identifier) @callee) @call\n",
            "(call function: (attribute attribute: (identifier) @callee)) @call\n",
        )),
        Lang::JavaScript | Lang::TypeScript | Lang::Tsx => Some(concat!(
            "(call_expression function: (identifier) @callee) @call\n",
            "(call_expression function: (member_expression property: (property_identifier) @callee)) @call\n",
        )),
        Lang::Java => Some(
            "(method_invocation name: (identifier) @callee) @call\n",
        ),
        Lang::Scala => Some(concat!(
            "(call_expression function: (identifier) @callee) @call\n",
            "(call_expression function: (field_expression field: (identifier) @callee)) @call\n",
            "(infix_expression operator: (identifier) @callee) @call\n",
        )),
        Lang::C | Lang::Cpp => Some(concat!(
            "(call_expression function: (identifier) @callee) @call\n",
            "(call_expression function: (field_expression field: (field_identifier) @callee)) @call\n",
        )),
        Lang::Ruby => Some(
            "(call method: (identifier) @callee) @call\n",
        ),
        Lang::Php => Some(concat!(
            "(function_call_expression function: (name) @callee) @call\n",
            "(function_call_expression function: (qualified_name) @callee) @call\n",
            "(function_call_expression function: (relative_name) @callee) @call\n",
            "(member_call_expression name: (name) @callee) @call\n",
            "(nullsafe_member_call_expression name: (name) @callee) @call\n",
            "(scoped_call_expression name: (name) @callee) @call\n",
        )),
        Lang::CSharp => Some(concat!(
            "(invocation_expression function: (identifier) @callee) @call\n",
            "(invocation_expression function: (member_access_expression name: (identifier) @callee)) @call\n",
        )),
        Lang::Swift => Some(concat!(
            "(call_expression (simple_identifier) @callee) @call\n",
            "(call_expression (navigation_expression suffix: (navigation_suffix suffix: (simple_identifier) @callee))) @call\n",
        )),
        Lang::Kotlin => Some(concat!(
            "(call_expression (identifier) @callee) @call\n",
            "(call_expression (navigation_expression (identifier) @callee .)) @call\n",
        )),
        Lang::Elixir => Some(concat!(
            "(call target: (identifier) @callee) @call\n",
            "(call target: (dot right: (identifier) @callee)) @call\n",
        )),
        Lang::Bash => Some("(command name: (command_name) @callee) @call\n"),
        _ => None,
    }
}

/// Operation-local syntax evidence. An absent owner is top-level; an absent
/// CallSite on a legacy/prepared carrier means precise site evidence is unavailable.
#[derive(Debug, Clone)]
pub struct CallSite {
    pub expression: std::ops::Range<usize>,
    pub construction: bool,
    pub target: std::ops::Range<usize>,
    pub name: String,
    pub receiver: Option<String>,
    pub line: u32,
    pub owner: Option<crate::tsjs_source::Identity>,
    pub owner_name: String,
    pub owner_range: Option<(u32, u32)>,
    pub owner_signature: Option<std::ops::Range<usize>>,
}

impl CallSite {
    pub(crate) fn capture(
        call: tree_sitter::Node,
        name: tree_sitter::Node,
        content: &str,
        lines: &[&str],
        lang: Lang,
    ) -> Self {
        let owner = if super::declarations::supports(lang) {
            crate::tsjs_source::reference_owner(call, content).map(|node| {
                let scope = super::scope::source_scope(node, content, true);
                (node, scope.name, (scope.start, scope.end))
            })
        } else {
            super::scope::walk_to_enclosing_callable(call, lines, lang, content)
        };
        let target = call.child_by_field_name("function").unwrap_or(name);
        Self {
            expression: call.byte_range(),
            construction: call.kind() == "new_expression",
            target: target.byte_range(),
            name: content[name.byte_range()].to_string(),
            receiver: target
                .child_by_field_name("object")
                .map(|node| content[node.byte_range()].to_string()),
            line: name.start_position().row as u32 + 1,
            owner: owner
                .as_ref()
                .map(|(node, _, _)| crate::tsjs_source::identity(*node)),
            owner_name: owner
                .as_ref()
                .map_or_else(|| "<top-level>".to_string(), |(_, name, _)| name.clone()),
            owner_signature: owner
                .as_ref()
                .filter(|_| super::declarations::supports(lang))
                .and_then(|(node, _, _)| crate::tsjs_source::describe(*node, content))
                .map(|region| region.signature),
            owner_range: owner.map(|(_, _, range)| range),
        }
    }

    pub(crate) fn caption(&self, content: &str) -> String {
        let expression = &content[self.expression.clone()];
        let shown = if expression.len() <= 1000 {
            format!("{expression:?}")
        } else {
            "[expression exceeds per-line safeguard]".to_string()
        };
        let owner = match self.owner_name.as_str() {
            "<anonymous>" => "anonymous function",
            "<top-level>" => "top level",
            name => name,
        };
        let range = self.owner_range.map_or(String::new(), |(start, end)| {
            if start == end {
                format!(" [{start}]")
            } else {
                format!(" [{start}-{end}]")
            }
        });
        let row_start = content[..self.expression.start]
            .rfind('\n')
            .map_or(0, |index| index + 1);
        let column = content[row_start..self.expression.start].chars().count() + 1;
        format!(
            "{owner}{range}: {} {shown} at {}:{column}",
            if self.construction {
                "construction"
            } else {
                "call"
            },
            super::declarations::line_at(content, self.expression.start)
        )
    }
}

/// Global cache of compiled tree-sitter queries for callee extraction.
///
/// Keyed by `(symbol_count, field_count)` — a pair that uniquely identifies
/// each grammar in practice. We avoid keying by `Language::name()` because
/// older grammars (ABI < 15) do not register a name and would return `None`,
/// silently disabling the cache and callee extraction entirely.
///
/// `Query` is `Send + Sync` in tree-sitter 0.25, so a global `Mutex`-guarded
/// map is safe and avoids recompiling the same query on every call.
static QUERY_CACHE: LazyLock<Mutex<HashMap<(usize, usize), tree_sitter::Query>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Stable cache key for a tree-sitter language. Uses `(symbol_count,
/// field_count)` which is unique for every grammar shipped with tilth.
fn lang_cache_key(ts_lang: &tree_sitter::Language) -> (usize, usize) {
    (ts_lang.node_kind_count(), ts_lang.field_count())
}

/// Look up or compile the callee query for `ts_lang`, then invoke `f` with a
/// reference to the cached `Query`.  Returns `None` if compilation fails.
pub(crate) fn with_callee_query<R>(
    ts_lang: &tree_sitter::Language,
    query_str: &str,
    f: impl FnOnce(&tree_sitter::Query) -> R,
) -> Option<R> {
    let key = lang_cache_key(ts_lang);
    let mut cache = QUERY_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let std::collections::hash_map::Entry::Vacant(e) = cache.entry(key) {
        let query = tree_sitter::Query::new(ts_lang, query_str).ok()?;
        e.insert(query);
    }
    // Safety: we just inserted if absent, so the key is always present here.
    Some(f(cache.get(&key).expect("just inserted")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grammar_cache_keys_unique() {
        // Verify that (node_kind_count, field_count) is unique across all shipped grammars.
        // A collision would cause one language to serve another's cached query.
        let grammars: Vec<(&str, tree_sitter::Language)> = vec![
            ("rust", tree_sitter_rust::LANGUAGE.into()),
            (
                "typescript",
                tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            ),
            ("tsx", tree_sitter_typescript::LANGUAGE_TSX.into()),
            ("javascript", tree_sitter_javascript::LANGUAGE.into()),
            ("python", tree_sitter_python::LANGUAGE.into()),
            ("go", tree_sitter_go::LANGUAGE.into()),
            ("java", tree_sitter_java::LANGUAGE.into()),
            ("c", tree_sitter_c::LANGUAGE.into()),
            ("cpp", tree_sitter_cpp::LANGUAGE.into()),
            ("ruby", tree_sitter_ruby::LANGUAGE.into()),
            ("php", tree_sitter_php::LANGUAGE_PHP.into()),
            ("scala", tree_sitter_scala::LANGUAGE.into()),
            ("csharp", tree_sitter_c_sharp::LANGUAGE.into()),
            ("swift", tree_sitter_swift::LANGUAGE.into()),
            ("kotlin", tree_sitter_kotlin_ng::LANGUAGE.into()),
            ("elixir", tree_sitter_elixir::LANGUAGE.into()),
            ("bash", tree_sitter_bash::LANGUAGE.into()),
        ];
        let mut seen = std::collections::HashMap::new();
        for (name, lang) in &grammars {
            let key = lang_cache_key(lang);
            if let Some(prev) = seen.insert(key, name) {
                panic!("cache key collision: {prev} and {name} both produce {key:?}");
            }
        }
    }

    #[test]
    fn kotlin_callee_query_compiles() {
        let lang: tree_sitter::Language = tree_sitter_kotlin_ng::LANGUAGE.into();
        let query_str = callee_query_str(Lang::Kotlin).unwrap();
        tree_sitter::Query::new(&lang, query_str).expect("kotlin callee query should compile");
    }

    #[test]
    fn elixir_callee_query_compiles() {
        let lang: tree_sitter::Language = tree_sitter_elixir::LANGUAGE.into();
        let query_str = callee_query_str(Lang::Elixir).unwrap();
        tree_sitter::Query::new(&lang, query_str).expect("elixir callee query should compile");
    }

    #[test]
    fn bash_callee_query_compiles() {
        let lang: tree_sitter::Language = tree_sitter_bash::LANGUAGE.into();
        let query_str = callee_query_str(Lang::Bash).unwrap();
        tree_sitter::Query::new(&lang, query_str).expect("bash callee query should compile");
    }
}
