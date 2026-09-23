//! Enclosing-scope annotator: given a `(file, line)`, return the nearest
//! enclosing definition, qualified with its containing type or module.
//! Used by the search formatter to annotate usages with their containing
//! function/class/module, and internally by `callers::find_enclosing_function`
//! when reporting the calling-function context of a call site.

use sha2::{Digest, Sha256};
use std::path::Path;

use crate::cache::OutlineCache;
use crate::lang::treesitter::{
    extract_definition_name, extract_elixir_definition_name, is_elixir_definition,
    node_text_simple, DEFINITION_KINDS,
};

/// Type-like node kinds that can enclose a function definition.
const TYPE_KINDS: &[&str] = &[
    "class_declaration",
    "class_definition",
    "struct_item",
    "impl_item",
    "interface_declaration",
    "trait_item",
    "trait_declaration",
    "type_declaration",
    "enum_item",
    "enum_declaration",
    "module",
    "mod_item",
    "namespace_definition",
];

/// Resolved enclosing-definition context for a (file, line). Used by the
/// search formatter to annotate usages with their containing scope.
#[derive(Debug)]
pub struct EnclosingScope {
    /// Normalized kind label (e.g. `"function"`, `"class"`, `"struct"`).
    pub kind: &'static str,
    /// Identifier of the definition. Qualified with its enclosing type or
    /// module when one wraps it (e.g. `"Class.method"`, `"Module.func"`).
    pub name: String,
    /// Inclusive 1-based parser range of the enclosing definition.
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MixedScopes;

pub(crate) const MIXED_SCOPES: &str = "multiple scopes on this line; no single owner selected";

/// Display projection only; names and container eligibility remain source-owned.
pub(crate) fn source_scope(
    node: tree_sitter::Node,
    content: &str,
    qualified: bool,
) -> EnclosingScope {
    use crate::tsjs_source::{self as source, Kind};
    let kind = match source::classify(node.kind()) {
        Some(Kind::Function | Kind::Method | Kind::MethodSignature) => "function",
        Some(Kind::Class) => "class",
        Some(Kind::Interface) => "interface",
        Some(Kind::Namespace) => "module",
        Some(Kind::Enum) => "enum",
        Some(Kind::TypeAlias) => "type",
        Some(Kind::Field | Kind::PropertySignature) => "property",
        Some(Kind::Object) => "object",
        _ => "variable",
    };
    let name = source::intrinsic_name(node, content)
        .or_else(|| source::function_binding_name(node, content));
    let name = match name {
        Some(name) if qualified && kind == "function" => source::lexical_owner(node, content)
            .filter(|parent| {
                matches!(
                    source::classify(parent.kind()),
                    Some(Kind::Class | Kind::Namespace)
                )
            })
            .and_then(|parent| source::intrinsic_name(parent, content))
            .map_or_else(|| name.to_string(), |owner| format!("{owner}.{name}")),
        Some(name) => name.to_string(),
        None => "<anonymous>".to_string(),
    };
    EnclosingScope {
        kind,
        name,
        start: node.start_position().row as u32 + 1,
        end: node.end_position().row as u32 + 1,
    }
}

/// A receiving value does not replace its callable/type scope. The shared
/// binding projection also owns the prefix of `const local = () => ...`.
fn source_owner<'tree>(
    mut node: tree_sitter::Node<'tree>,
    content: &str,
) -> Option<tree_sitter::Node<'tree>> {
    use crate::tsjs_source::{self as source, Kind};
    let mut value = None;
    loop {
        if node.is_named() {
            match source::classify(node.kind()) {
                Some(
                    Kind::Function
                    | Kind::Method
                    | Kind::Class
                    | Kind::Interface
                    | Kind::Namespace
                    | Kind::Enum,
                ) => return Some(node),
                Some(Kind::Binding) => {
                    if let Some(callable) = node
                        .child_by_field_name("value")
                        .filter(|value| source::function_binding_name(*value, content).is_some())
                    {
                        return Some(callable);
                    }
                    value.get_or_insert(node);
                }
                Some(Kind::Field | Kind::TypeAlias) => {
                    value.get_or_insert(node);
                }
                _ => {}
            }
        }
        match node.parent() {
            Some(parent) => node = parent,
            None => return value,
        }
    }
}

fn source_context_on_row(
    root: tree_sitter::Node,
    row: usize,
    content: &str,
) -> Result<Option<EnclosingScope>, MixedScopes> {
    let point = tree_sitter::Point { row, column: 0 };
    let mut pending = vec![root];
    // None (top-level) is itself an observed owner, not "no observation yet".
    let mut named_owner = None;
    let mut punctuation_owner = None;
    let mut punctuation_mixed = false;
    while let Some(node) = pending.pop() {
        let end = node.end_position();
        if node.start_position().row > row
            || end.row < row
            || (end.row == row && end.column == 0)
            || node.start_byte() == node.end_byte()
        {
            continue;
        }
        if node.named_child_count() == 0 {
            let owner = source_owner(node, content);
            let prior = if node.is_named() {
                &mut named_owner
            } else {
                &mut punctuation_owner
            };
            if let Some(previous) = prior {
                let identity =
                    |owner: Option<tree_sitter::Node>| owner.map(crate::tsjs_source::identity);
                if identity(*previous) != identity(owner) {
                    if node.is_named() {
                        return Err(MixedScopes);
                    }
                    punctuation_mixed = true;
                }
            } else {
                *prior = Some(owner);
            }
            continue;
        }
        let mut cursor = node.walk();
        // Seek over earlier siblings; descend only through the requested row.
        if cursor.goto_first_child_for_point(point).is_some() {
            loop {
                let child = cursor.node();
                if child.start_position().row > row {
                    break;
                }
                pending.push(child);
                if !cursor.goto_next_sibling() {
                    break;
                }
            }
        }
    }
    // Keywords/delimiters do not turn a single declaration into mixed context.
    // On delimiter-only rows, their actual AST owners still distinguish scopes.
    let owner = match named_owner {
        Some(owner) => owner,
        None if punctuation_mixed => return Err(MixedScopes),
        None => punctuation_owner.flatten(),
    };
    Ok(owner.map(|owner| source_scope(owner, content, true)))
}

/// Walk up the AST from `node` to the nearest definition, qualified with its
/// enclosing type/module if one wraps it. Returns the AST node so the caller
/// can read its kind, plus the rendered name and line range.
pub(crate) fn walk_to_enclosing_definition<'a>(
    node: tree_sitter::Node<'a>,
    lines: &[&str],
    lang: crate::types::Lang,
) -> Option<(tree_sitter::Node<'a>, String, (u32, u32))> {
    let mut current = Some(node);
    while let Some(n) = current {
        let def_name = if DEFINITION_KINDS.contains(&n.kind()) {
            extract_definition_name(n, lines)
        } else if lang == crate::types::Lang::Elixir && is_elixir_definition(n, lines) {
            extract_elixir_definition_name(n, lines)
        } else {
            None
        };

        if let Some(name) = def_name {
            let range = (
                n.start_position().row as u32 + 1,
                n.end_position().row as u32 + 1,
            );

            // Walk further up to find an enclosing type/module and qualify the name.
            // `defmodule` is a `call` node, not in TYPE_KINDS, so Elixir needs a
            // separate check to produce `Module.func`.
            let mut parent = n.parent();
            while let Some(p) = parent {
                if TYPE_KINDS.contains(&p.kind()) {
                    if let Some(type_name) = extract_definition_name(p, lines) {
                        return Some((n, format!("{type_name}.{name}"), range));
                    }
                }
                if lang == crate::types::Lang::Elixir && is_elixir_definition(p, lines) {
                    if let Some(type_name) = extract_elixir_definition_name(p, lines) {
                        return Some((n, format!("{type_name}.{name}"), range));
                    }
                }
                parent = p.parent();
            }

            return Some((n, name, range));
        }
        current = n.parent();
    }
    None
}

fn is_callable(node: tree_sitter::Node, lines: &[&str], lang: crate::types::Lang) -> bool {
    if super::declarations::supports(lang) {
        return matches!(
            crate::tsjs_source::classify(node.kind()),
            Some(
                crate::tsjs_source::Kind::Function
                    | crate::tsjs_source::Kind::Method
                    | crate::tsjs_source::Kind::MethodSignature
            )
        );
    }
    let node = if node.kind() == "decorated_definition" {
        node.child_by_field_name("definition").unwrap_or(node)
    } else {
        node
    };
    kind_label(node, lines, lang) == "function"
        || matches!(
            node.kind(),
            "arrow_function"
                | "function_expression"
                | "generator_function"
                | "generator_function_declaration"
                | "lambda"
                | "lambda_expression"
                | "closure_expression"
                | "func_literal"
        )
}

/// Calls belong to an enclosing callable, not the local variable receiving their result.
/// Keep anonymous callbacks distinct rather than attributing them to an outer function.
pub(crate) fn walk_to_enclosing_callable<'a>(
    node: tree_sitter::Node<'a>,
    lines: &[&str],
    lang: crate::types::Lang,
    content: &str,
) -> Option<(tree_sitter::Node<'a>, String, (u32, u32))> {
    let mut current = Some(node);
    while let Some(candidate) = current {
        if is_callable(candidate, lines, lang) {
            let name = if super::declarations::supports(lang) {
                // Use the captured bytes, not a reconstruction from lines: CRLF
                // and UTF-8 offsets belong to the same tree as the source facts.
                source_scope(candidate, content, true).name
            } else {
                extract_definition_name(candidate, lines)
                    .and_then(|_| {
                        walk_to_enclosing_definition(candidate, lines, lang)
                            .map(|(_, name, _)| name)
                    })
                    .unwrap_or_else(|| "<anonymous>".to_string())
            };
            return Some((
                candidate,
                name,
                (
                    candidate.start_position().row as u32 + 1,
                    candidate.end_position().row as u32 + 1,
                ),
            ));
        }
        current = candidate.parent();
    }
    None
}

/// Structural parents from the same captured source used for live caller rows.
/// This is source hierarchy, not additional call edges or target-binding proof.
pub(crate) fn enclosing_containers(path: &Path, content: &str, line: u32) -> Vec<EnclosingScope> {
    enclosing_containers_at(path, content, line, None)
}

pub(crate) fn enclosing_containers_at(
    path: &Path,
    content: &str,
    line: u32,
    byte: Option<usize>,
) -> Vec<EnclosingScope> {
    let crate::types::FileType::Code(lang) = crate::lang::detect_file_type(path) else {
        return Vec::new();
    };
    let Some(language) = crate::lang::outline::outline_language(lang) else {
        return Vec::new();
    };
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&language).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(content, None) else {
        return Vec::new();
    };
    enclosing_containers_in_tree(&tree, content, lang, line, byte)
}

/// Reuse the caller's parsed snapshot; hierarchy must not come from a later disk read.
pub(crate) fn enclosing_containers_in_tree(
    tree: &tree_sitter::Tree,
    content: &str,
    lang: crate::types::Lang,
    line: u32,
    byte: Option<usize>,
) -> Vec<EnclosingScope> {
    let lines = content.lines().collect::<Vec<_>>();
    let Some(source) = line.checked_sub(1).and_then(|row| lines.get(row as usize)) else {
        return Vec::new();
    };
    let point = tree_sitter::Point {
        row: (line - 1) as usize,
        column: source.len() - source.trim_start().len(),
    };
    let mut current = byte.map_or_else(
        || tree.root_node().descendant_for_point_range(point, point),
        |byte| tree.root_node().descendant_for_byte_range(byte, byte),
    );
    let mut scopes = Vec::new();
    while let Some(node) = current {
        if super::declarations::supports(lang) {
            use crate::tsjs_source::Kind;
            if node.is_named()
                && matches!(
                    crate::tsjs_source::classify(node.kind()),
                    Some(
                        Kind::Function
                            | Kind::Method
                            | Kind::MethodSignature
                            | Kind::Class
                            | Kind::Interface
                            | Kind::Namespace
                            | Kind::Enum
                    )
                )
            {
                scopes.push(source_scope(node, content, false));
            }
        } else if is_callable(node, &lines, lang) || TYPE_KINDS.contains(&node.kind()) {
            scopes.push(EnclosingScope {
                kind: kind_label(node, &lines, lang),
                name: extract_definition_name(node, &lines)
                    .unwrap_or_else(|| "<anonymous>".to_string()),
                start: node.start_position().row as u32 + 1,
                end: node.end_position().row as u32 + 1,
            });
        }
        current = node.parent();
    }
    scopes.reverse();
    scopes
}

/// Widen a sampled window to complete boundary statements and their controlling
/// statements, stopping at callable/type ownership. This is syntax, not dataflow.
pub(crate) fn complete_statement_window(
    path: &Path,
    content: &str,
    start: u32,
    end: u32,
) -> (u32, u32) {
    let original = (start, end);
    let crate::types::FileType::Code(lang) = crate::lang::detect_file_type(path) else {
        return original;
    };
    let Some(language) = crate::lang::outline::outline_language(lang) else {
        return original;
    };
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&language).is_err() {
        return original;
    }
    let Some(tree) = parser.parse(content, None) else {
        return original;
    };
    let lines = content.lines().collect::<Vec<_>>();
    let boundary = |line: u32| -> Option<(u32, u32)> {
        let row = line.checked_sub(1)? as usize;
        let source = lines.get(row)?;
        if source.trim().is_empty() {
            return None;
        }
        let point = tree_sitter::Point {
            row,
            column: source.len() - source.trim_start().len(),
        };
        let mut current = tree.root_node().descendant_for_point_range(point, point);
        let mut enclosing = None;
        while let Some(node) = current {
            if is_callable(node, &lines, lang) || TYPE_KINDS.contains(&node.kind()) {
                break;
            }
            let kind = node.kind();
            if kind.ends_with("_statement")
                || kind.ends_with("_declaration")
                || kind == "assignment"
            {
                if node.has_error() {
                    break;
                }
                enclosing = Some((
                    node.start_position().row as u32 + 1,
                    node.end_position().row as u32 + 1,
                ));
            }
            current = node.parent();
        }
        enclosing
    };
    // Either boundary can belong to a statement beginning before the other.
    // Taking only the left start and right end can leave an orphan `else`.
    [boundary(start), boundary(end)].into_iter().flatten().fold(original,
        |(start, end), (left, right)| (start.min(left), end.max(right)))
}

/// A call in catch/finally depends on state established by the containing
/// operation. Its short window cannot stand in for that recovery operation.
/// Stop at the immediate callable: an outer handler does not own a callback.
pub(crate) fn call_in_recovery_clause(path: &Path, content: &str, line: u32, byte: Option<usize>) -> bool {
    let crate::types::FileType::Code(lang) = crate::lang::detect_file_type(path) else { return false; };
    let Some(language) = crate::lang::outline::outline_language(lang) else { return false; };
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&language).is_err() { return false; }
    let Some(tree) = parser.parse(content, None) else { return false; };
    let lines = content.lines().collect::<Vec<_>>();
    let Some(row) = line.checked_sub(1).map(|row| row as usize) else { return false; };
    let Some(source) = lines.get(row) else { return false; };
    let point = tree_sitter::Point { row, column: source.len() - source.trim_start().len() };
    let mut current = byte.map_or_else(
        || tree.root_node().descendant_for_point_range(point, point),
        |byte| tree.root_node().descendant_for_byte_range(byte, byte));
    while let Some(node) = current {
        if is_callable(node, &lines, lang) || TYPE_KINDS.contains(&node.kind()) { return false; }
        if matches!(node.kind(), "catch_clause" | "finally_clause" | "except_clause") {
            return !node.has_error();
        }
        current = node.parent();
    }
    false
}

/// Cached line context: mixed source owners are not top-level or verified absence.
/// Exact caller scans keep using their captured AST node, not this line query.
pub(crate) fn enclosing_definition_at(
    path: &Path,
    line: u32,
    cache: &OutlineCache,
) -> Result<Option<EnclosingScope>, MixedScopes> {
    let Some(parsed) = cache.get_or_parse(path) else {
        return Ok(None);
    };
    enclosing_definition_in_source(&parsed, line)
}

/// Line ownership from the same immutable parse that supplied matching bytes.
pub(crate) fn enclosing_definition_in_source(
    parsed: &crate::cache::ParsedFile,
    line: u32,
) -> Result<Option<EnclosingScope>, MixedScopes> {
    let Some(row) = line.checked_sub(1).map(|row| row as usize) else {
        return Ok(None);
    };
    if super::declarations::supports(parsed.lang) {
        return source_context_on_row(parsed.tree.root_node(), row, &parsed.content);
    }
    let lines: Vec<&str> = parsed.content.lines().collect();
    if row >= lines.len() {
        return Ok(None);
    }
    let point = tree_sitter::Point { row, column: 0 };
    let Some(target) = parsed
        .tree
        .root_node()
        .descendant_for_point_range(point, point)
    else {
        return Ok(None);
    };
    Ok(
        walk_to_enclosing_definition(target, &lines, parsed.lang).map(|(node, name, range)| {
            EnclosingScope {
                kind: kind_label(node, &lines, parsed.lang),
                name,
                start: range.0,
                end: range.1,
            }
        }),
    )
}

enum DeclarationBoundary {
    Signature(u32),
    WholeDefinition(u32),
}

/// Source-backed declaration boundary for ranked live rows, not a folded outline signature.
/// Unknown grammar/body shapes return the complete definition range rather than guess at braces
/// inside types or default arguments. Callers retain their existing whole-group output budget.
pub(crate) fn declaration_end_line(
    path: &Path,
    content: &str,
    start: u32,
    end: u32,
) -> Option<u32> {
    declaration_boundary(path, content, start, end).map(|boundary| match boundary {
        DeclarationBoundary::Signature(line) | DeclarationBoundary::WholeDefinition(line) => line,
    })
}

/// Only an actual parser header may receive the signature-only allowance.
/// Equality with the final source row is not uncertainty: an empty body can open there.
pub(crate) fn signature_end_line(path: &Path, content: &str, start: u32, end: u32) -> Option<u32> {
    match declaration_boundary(path, content, start, end)? {
        DeclarationBoundary::Signature(line) => Some(line),
        DeclarationBoundary::WholeDefinition(_) => None,
    }
}

fn declaration_boundary(
    path: &Path,
    content: &str,
    start: u32,
    end: u32,
) -> Option<DeclarationBoundary> {
    let crate::types::FileType::Code(lang) = crate::lang::detect_file_type(path) else {
        return None;
    };
    let language = crate::lang::outline::outline_language(lang)?;
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&language).ok()?;
    let tree = parser.parse(content, None)?;
    let lines: Vec<_> = content.lines().collect();
    let mut pending = vec![tree.root_node()];
    while let Some(node) = pending.pop() {
        let first = node.start_position().row as u32 + 1;
        let last = node.end_position().row as u32 + 1;
        if first > start || last < end {
            continue;
        }
        if first == start
            && last == end
            && (DEFINITION_KINDS.contains(&node.kind())
                || is_callable(node, &lines, lang)
                || (lang == crate::types::Lang::Go
                    && matches!(node.kind(), "type_spec" | "type_alias")))
        {
            let declaration = match node.kind() {
                "export_statement" => node.child_by_field_name("declaration").unwrap_or(node),
                "decorated_definition" => node.child_by_field_name("definition").unwrap_or(node),
                "lexical_declaration" | "variable_declaration" => {
                    let mut cursor = node.walk();
                    let value = node.named_children(&mut cursor).find_map(|child| {
                        child
                            .child_by_field_name("value")
                            .filter(|value| is_callable(*value, &lines, lang))
                    });
                    value.unwrap_or(node)
                }
                _ => node,
            };
            // Go wraps named types in type_declaration -> type_spec/type_alias
            // -> type. Struct bodies are field_declaration_list; interfaces
            // expose their opening brace directly (neither has a `body` field).
            if lang == crate::types::Lang::Go
                && matches!(
                    declaration.kind(),
                    "type_declaration" | "type_spec" | "type_alias"
                )
            {
                let spec = if declaration.kind() == "type_declaration" {
                    let mut cursor = declaration.walk();
                    let mut specs = declaration
                        .named_children(&mut cursor)
                        .filter(|child| matches!(child.kind(), "type_spec" | "type_alias"));
                    let first = specs.next()?;
                    // A grouped declaration has no single type heading.
                    if specs.next().is_some() {
                        return None;
                    }
                    first
                } else {
                    declaration
                };
                let typ = spec.child_by_field_name("type")?;
                let mut cursor = typ.walk();
                let opener = match typ.kind() {
                    "struct_type" => typ
                        .named_children(&mut cursor)
                        .find(|child| child.kind() == "field_declaration_list"),
                    "interface_type" => typ.children(&mut cursor).find(|child| child.kind() == "{"),
                    _ => None,
                };
                if let Some(opener) = opener {
                    return Some(DeclarationBoundary::Signature(
                        (opener.start_position().row as u32 + 1).clamp(start, end),
                    ));
                }
            }
            let Some(body) = declaration.child_by_field_name("body") else {
                return Some(
                    if is_callable(declaration, &lines, lang)
                        && declaration.child_by_field_name("parameters").is_some()
                    {
                        DeclarationBoundary::Signature(end)
                    } else {
                        DeclarationBoundary::WholeDefinition(end)
                    },
                );
            };
            let position = body.start_position();
            let prefix = lines.get(position.row)?.get(..position.column)?;
            // Brace-delimited bodies include their opener. Indented bodies (Python) begin at
            // their first statement: only include that row when the declaration shares it.
            let includes_row =
                !prefix.trim().is_empty() || content.get(body.start_byte()..)?.starts_with('{');
            return Some(DeclarationBoundary::Signature(
                (position.row as u32 + u32::from(includes_row)).clamp(start, end),
            ));
        }
        let mut cursor = node.walk();
        pending.extend(node.named_children(&mut cursor));
    }
    None
}

/// Leading source comments for an exact producer span. Columns are UTF-16, while
/// Tree-sitter uses bytes. This supplies display context, not another declaration resolver.
pub(crate) fn leading_comment_start(
    path: &Path,
    content: &str,
    start: (u32, u32),
    end: (u32, u32),
) -> Option<u32> {
    let crate::types::FileType::Code(lang) = crate::lang::detect_file_type(path) else {
        return None;
    };
    let language = crate::lang::outline::outline_language(lang)?;
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&language).ok()?;
    let tree = parser.parse(content, None)?;
    let lines: Vec<_> = content.lines().collect();
    let at = |point: tree_sitter::Point, expected: (u32, u32)| {
        point.row as u32 + 1 == expected.0
            && lines
                .get(point.row)
                .and_then(|line| line.get(..point.column))
                .is_some_and(|prefix| prefix.encode_utf16().count() == expected.1 as usize)
    };
    let mut pending = vec![tree.root_node()];
    while let Some(node) = pending.pop() {
        if node.start_position().row as u32 + 1 > start.0
            || (node.end_position().row as u32 + 1) < end.0
        {
            continue;
        }
        if node.parent().is_some()
            && at(node.start_position(), start)
            && at(node.end_position(), end)
        {
            let mut anchor = node;
            while let Some(parent) = anchor.parent() {
                let mut cursor = parent.walk();
                let wrapper = matches!(
                    parent.kind(),
                    "export_statement"
                        | "decorated_definition"
                        | "lexical_declaration"
                        | "variable_declaration"
                        | "variable_declarator"
                        | "ambient_declaration"
                ) || (lang == crate::types::Lang::Go
                    && parent.kind() == "type_declaration"
                    && !parent
                        .children(&mut cursor)
                        .any(|child| child.kind() == "("));
                if !wrapper {
                    break;
                }
                anchor = parent;
            }
            let mut boundary = anchor.start_byte();
            let mut first = None;
            let mut previous = anchor.prev_named_sibling();
            while let Some(comment) = previous {
                if !matches!(
                    comment.kind(),
                    "comment" | "line_comment" | "block_comment" | "documentation_comment"
                ) {
                    break;
                }
                let gap = content.get(comment.end_byte()..boundary)?;
                if !gap.trim().is_empty() || gap.bytes().filter(|byte| *byte == b'\n').count() > 1 {
                    break;
                }
                let raw = content.get(comment.byte_range())?;
                // Go trailing comments (including blocks) belong to the prior declaration.
                let line_comment = comment.kind() == "line_comment"
                    || raw.starts_with("//")
                    || raw.starts_with('#')
                    || raw.starts_with("--");
                if (line_comment || lang == crate::types::Lang::Go)
                    && comment.prev_named_sibling().is_some_and(|prior| {
                        prior.end_position().row == comment.start_position().row
                    })
                {
                    break;
                }
                first = Some(comment.start_position().row as u32 + 1);
                boundary = comment.start_byte();
                previous = comment.prev_named_sibling();
            }
            return first;
        }
        let mut cursor = node.walk();
        pending.extend(node.named_children(&mut cursor));
    }
    None
}

/// A definition resolved by symbol name: its current def line, body span, and —
/// when the outline carries them — its signature and doc comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefinitionByName {
    pub kind: crate::types::OutlineKind,
    pub name: String,
    pub def_line: u32,
    pub body_start: u32,
    pub body_end: u32,
    pub signature: Option<String>,
    pub doc: Option<String>,
}

/// Outcome of a name-keyed symbol lookup, distinguishing "genuinely gone" from
/// "we cannot verify this file."
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SymbolLookup {
    /// Exactly one definition matched.
    Found(DefinitionByName),
    /// Several same-named definitions matched; `nearest` is the hint-line pick.
    /// Callers should surface the ambiguity rather than trust the pick blindly.
    Ambiguous {
        nearest: DefinitionByName,
        count: usize,
        candidates: Vec<DefinitionByName>,
    },
    /// The file could not be outlined (unsupported language / parse failure), so
    /// staleness cannot be determined. Callers must NOT treat this as stale —
    /// leave the graph's own information untouched.
    Unverified,
    /// The file was outlined successfully and the name is genuinely absent → stale.
    Absent,
}

/// Resolve a symbol by NAME to its current definition — the name-keyed companion
/// to [`enclosing_definition_at`] (which is line-keyed).
///
/// Reuses the cached parse plus the shared outline walker, so there is no new
/// tree-sitter logic. `hint_line` is only a soft disambiguator for same-name
/// symbols (nearest wins); ordinary line drift never breaks the lookup.
///
/// Crucially, "the name is absent" ([`SymbolLookup::Absent`], i.e. stale) is
/// reported ONLY when the file was actually outlined. If the file cannot be
/// outlined — unsupported language or parse failure — the result is
/// [`SymbolLookup::Unverified`], so callers never false-flag a live symbol in a
/// file pi-nav cannot read.
#[cfg(test)]
pub fn definition_by_name(
    path: &Path,
    name: &str,
    hint_line: Option<u32>,
    cache: &OutlineCache,
) -> SymbolLookup {
    definition_by_name_with_source(path, name, hint_line, cache).0
}

/// Resolve a symbol and return the digest of the exact source snapshot parsed.
/// Callers that render source use the digest to reject ranges from stale bytes.
pub fn definition_by_name_with_source(
    path: &Path,
    name: &str,
    hint_line: Option<u32>,
    cache: &OutlineCache,
) -> (SymbolLookup, Option<String>) {
    let Some(parsed) = cache.get_or_parse(path) else {
        return (SymbolLookup::Unverified, None);
    };
    let source_hash = format!("{:x}", Sha256::digest(parsed.content.as_bytes()));
    let lines: Vec<&str> = parsed.content.lines().collect();
    let entries =
        crate::lang::outline::walk_top_level(parsed.tree.root_node(), &lines, parsed.lang);
    (lookup_in_entries(&entries, name, hint_line), Some(source_hash))
}

pub(crate) fn lookup_in_entries(entries: &[crate::types::OutlineEntry], name: &str, hint_line: Option<u32>) -> SymbolLookup {
    if entries.is_empty() { return SymbolLookup::Unverified; }
    let mut candidates: Vec<&crate::types::OutlineEntry> = Vec::new();
    collect_by_name(&entries, name, &mut candidates);
    match candidates.len() {
        0 => SymbolLookup::Absent,
        1 => SymbolLookup::Found(to_definition(candidates[0])),
        _ => {
            let nearest = match hint_line {
                Some(hint) => candidates
                    .iter()
                    .min_by_key(|entry| (i64::from(entry.start_line) - i64::from(hint)).abs())
                    .copied()
                    .unwrap_or(candidates[0]),
                None => candidates[0],
            };
            SymbolLookup::Ambiguous {
                nearest: to_definition(nearest),
                count: candidates.len(),
                candidates: candidates
                    .iter()
                    .map(|entry| to_definition(entry))
                    .collect(),
            }
        }
    }
}

fn to_definition(entry: &crate::types::OutlineEntry) -> DefinitionByName {
    DefinitionByName {
        kind: entry.kind,
        name: entry.name.clone(),
        def_line: entry.start_line,
        body_start: entry.start_line,
        body_end: entry.end_line,
        signature: entry.signature.clone(),
        doc: entry.doc.clone(),
    }
}

fn collect_by_name<'a>(
    entries: &'a [crate::types::OutlineEntry],
    name: &str,
    out: &mut Vec<&'a crate::types::OutlineEntry>,
) {
    for entry in entries {
        if entry.name == name {
            out.push(entry);
        }
        collect_by_name(&entry.children, name, out);
    }
}

/// Map a tree-sitter definition node to a short user-facing label. Every kind
/// we handle is enumerated here, so adding a new language grammar is "add the
/// node kind to this match" with no string heuristics elsewhere.
fn kind_label(node: tree_sitter::Node, lines: &[&str], lang: crate::types::Lang) -> &'static str {
    match node.kind() {
        "function_declaration"
        | "function_definition"
        | "function_item"
        | "method_definition"
        | "method_declaration"
        | "decorated_definition" => "function",
        "class_declaration" | "class_definition" => "class",
        "struct_item" => "struct",
        "interface_declaration" => "interface",
        "trait_declaration" | "trait_item" => "trait",
        "type_alias_declaration" | "type_item" | "type_declaration" => "type",
        "enum_item" | "enum_declaration" => "enum",
        "lexical_declaration" | "variable_declaration" => "variable",
        "const_item" | "const_declaration" => "const",
        "static_item" => "static",
        "property_declaration" => "property",
        "mod_item" | "namespace_definition" => "module",
        "object_declaration" => "object",
        "impl_item" => "impl",
        "export_statement" => "export",
        "call" if lang == crate::types::Lang::Elixir => elixir_kind_label(node, lines),
        _ => "definition",
    }
}

/// Elixir definitions are all `call` nodes; the keyword (`def`, `defmodule`,
/// …) lives in the call's `target` field. Map it to the same vocabulary
/// `kind_label` produces for other languages.
fn elixir_kind_label(node: tree_sitter::Node, lines: &[&str]) -> &'static str {
    let Some(target) = node.child_by_field_name("target") else {
        return "definition";
    };
    match node_text_simple(target, lines).as_str() {
        "defmodule" => "module",
        "defprotocol" => "protocol",
        "defimpl" => "impl",
        "def" | "defp" | "defmacro" | "defmacrop" | "defguard" | "defguardp" | "defdelegate" => {
            "function"
        }
        "defstruct" | "defexception" => "struct",
        _ => "definition",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn write(dir: &Path, name: &str, content: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn recovery_context_stops_at_callable_and_statement_windows_keep_control() {
        let source = "function run() {\n  const unrelated = 1;\n  try {\n    work();\n  } catch (error) {\n    report(error);\n  } finally {\n    if (pending) {\n      if (retryCount > 0) {\n        const delay = Math.min(\n          retryCount,\n          maximum\n        );\n        retry(delay);\n      } else {\n        schedule();\n      }\n    }\n    const callback = () => {\n      nested();\n    };\n  }\n}\nfunction sibling() { untouched(); }\n";
        let path = Path::new("recovery.ts");
        // Original window 11..17 used to become 10..17, losing both `if`s.
        assert_eq!(complete_statement_window(path, source, 11, 17), (3, 22));
        assert!(call_in_recovery_clause(path, source, 14, Some(source.find("retry(delay)").unwrap())));
        assert!(call_in_recovery_clause(path, source, 6, None));
        assert!(!call_in_recovery_clause(path, source, 4, None));
        assert!(!call_in_recovery_clause(path, source, 20, Some(source.find("nested()").unwrap())),
            "an outer finally must not turn a callback into its enclosing operation");
        assert!(!call_in_recovery_clause(path, source, 24, Some(source.find("untouched()").unwrap())));
        let ordinary = "function run() {\n  before();\n  if (condition) {\n    target();\n  } else {\n    alternate();\n  }\n  after();\n}\n";
        assert_eq!(complete_statement_window(path, ordinary, 4, 7), (3, 7));
        assert!(!call_in_recovery_clause(path, ordinary, 4, None));
    }

    #[test]
    fn source_containers_include_namespace_and_anonymous_class() {
        let source = "namespace N {\n  const Holder = class {\n    run() {\n      Wanted();\n    }\n  };\n}\n";
        let containers = enclosing_containers(Path::new("containers.ts"), source, 4);
        let labels = containers
            .iter()
            .map(|scope| (scope.kind, scope.name.as_str(), scope.start, scope.end))
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            vec![
                ("module", "N", 1, 7),
                ("class", "<anonymous>", 2, 6),
                ("function", "run", 3, 5)
            ]
        );
    }

    #[test]
    fn final_row_headers_are_distinct_from_unknown_whole_definition_fallback() {
        for source in ["fn run(\n    value: i32,\n) {}", "fn run(value: i32) {}"] {
            let end = source.lines().count() as u32;
            assert_eq!(
                signature_end_line(Path::new("a.rs"), source, 1, end),
                Some(end)
            );
        }
        let source = "const values = [\n  1, 2, 3,\n];";
        assert_eq!(
            declaration_end_line(Path::new("a.ts"), source, 1, 3),
            Some(3)
        );
        assert_eq!(signature_end_line(Path::new("a.ts"), source, 1, 3), None);
    }

    #[test]
    fn declaration_boundaries_preserve_types_defaults_and_multiline_parameters() {
        for (path, source, declaration_end) in [
            ("a.rs", "fn run<T>(\n    value: T,\n) -> T\nwhere T: Copy\n{\n    value\n}", 5),
            ("a.ts", "export function run(\n    value: { key: string } = { key: '}' },\n): { key: string } {\n    return value;\n}", 3),
            ("a.py", "@decorate\ndef run(\n    value: dict = {'key': '}'},\n) -> dict:\n    return value", 4),
            ("a.go", "type Worker struct {\n    Earlier int\n    Name string\n}", 1),
            ("a.go", "type Worker interface {\n    Earlier()\n    Run()\n}", 1),
            ("a.go", "type Worker[T interface {\n    ~string | ~int\n}] struct {\n    Name T\n}", 3),
            ("a.go", "type Worker /* heading\ncontinued */ interface {\n    Run()\n}", 2),
        ] {
            assert_eq!(declaration_end_line(Path::new(path), source, 1, source.lines().count() as u32), Some(declaration_end), "{path}");
        }
    }

    #[test]
    fn enclosing_at_rust_top_level_function() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.rs", "fn foo() {\n    let x = 1;\n}\n");
        let cache = OutlineCache::new();
        let scope = enclosing_definition_at(&p, 2, &cache).unwrap().unwrap();
        assert_eq!(scope.kind, "function");
        assert_eq!(scope.name, "foo");
    }

    #[test]
    fn enclosing_at_rust_method_inside_mod() {
        // mod_item has a name field; impl_item does not, so the qualifier path
        // exercised here is mod-name → method-name.
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.rs",
            "mod outer {\n    fn helper() {\n        let x = 1;\n    }\n}\n",
        );
        let cache = OutlineCache::new();
        let scope = enclosing_definition_at(&p, 3, &cache).unwrap().unwrap();
        assert_eq!(scope.kind, "function");
        assert_eq!(scope.name, "outer.helper");
    }

    #[test]
    fn enclosing_at_typescript_method_qualifies_with_class() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.ts",
            "class Foo {\n  bar() {\n    const x = 1;\n  }\n}\n",
        );
        let cache = OutlineCache::new();
        let scope = enclosing_definition_at(&p, 3, &cache).unwrap().unwrap();
        assert_eq!(scope.kind, "function");
        assert_eq!(scope.name, "Foo.bar");
    }

    #[test]
    fn enclosing_at_python_method_qualifies_with_class() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.py",
            "class Foo:\n    def bar(self):\n        x = 1\n",
        );
        let cache = OutlineCache::new();
        let scope = enclosing_definition_at(&p, 3, &cache).unwrap().unwrap();
        assert_eq!(scope.kind, "function");
        assert_eq!(scope.name, "Foo.bar");
    }

    #[test]
    fn enclosing_at_elixir_def_qualifies_with_module() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.ex",
            "defmodule Foo do\n  def bar do\n    :ok\n  end\nend\n",
        );
        let cache = OutlineCache::new();
        let scope = enclosing_definition_at(&p, 3, &cache).unwrap().unwrap();
        assert_eq!(scope.kind, "function");
        assert_eq!(scope.name, "Foo.bar");
    }

    #[test]
    fn enclosing_at_elixir_defmodule_kind_is_module() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.ex",
            "defmodule Foo do\n  @moduledoc \"hi\"\nend\n",
        );
        let cache = OutlineCache::new();
        let scope = enclosing_definition_at(&p, 2, &cache).unwrap().unwrap();
        assert_eq!(scope.kind, "module");
        assert_eq!(scope.name, "Foo");
    }

    #[test]
    fn enclosing_at_top_level_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.rs", "// just a comment\nfn foo() {}\n");
        let cache = OutlineCache::new();
        assert!(enclosing_definition_at(&p, 1, &cache).unwrap().is_none());
    }

    #[test]
    fn enclosing_at_zero_line_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.rs", "fn foo() {}\n");
        let cache = OutlineCache::new();
        assert!(enclosing_definition_at(&p, 0, &cache).unwrap().is_none());
    }

    #[test]
    fn enclosing_at_non_code_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.md", "# heading\n\nsome text\n");
        let cache = OutlineCache::new();
        assert!(enclosing_definition_at(&p, 3, &cache).unwrap().is_none());
    }

    #[test]
    fn enclosing_at_caches_parse_across_calls() {
        // Two calls into the same file should reuse the cached parse —
        // observable indirectly by mutating the file between calls without
        // touching mtime: the first parse wins, the second sees stale data
        // because the mtime didn't change. (Test only asserts the cache hit
        // path returns the first-parse result.)
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.rs", "fn foo() { let x = 1; }\n");
        let cache = OutlineCache::new();
        let a = enclosing_definition_at(&p, 1, &cache).unwrap().unwrap();
        let b = enclosing_definition_at(&p, 1, &cache).unwrap().unwrap();
        assert_eq!(a.name, b.name);
        assert_eq!(a.kind, b.kind);
    }

    #[test]
    fn enclosing_at_kind_labels_for_common_definition_kinds() {
        // One case per kind_label match arm beyond `function`/`module`,
        // so a regression that miscategorizes (e.g.) a Rust `struct` as
        // `definition` would surface here.
        let cases: &[(&str, &str, u32, &str, &str)] = &[
            ("a.rs", "struct Foo { x: u32 }\n", 1, "struct", "Foo"),
            ("b.rs", "enum Color { Red, Blue }\n", 1, "enum", "Color"),
            (
                "c.rs",
                "trait Greeter { fn hi(&self); }\n",
                1,
                "trait",
                "Greeter",
            ),
            (
                "d.ts",
                "interface Shape { area(): number; }\n",
                1,
                "interface",
                "Shape",
            ),
            ("e.ts", "class Widget { x = 1; }\n", 1, "class", "Widget"),
        ];
        let cache = OutlineCache::new();
        for (filename, content, line, kind, name) in cases {
            let tmp = tempfile::tempdir().unwrap();
            let p = write(tmp.path(), filename, content);
            let scope = enclosing_definition_at(&p, *line, &cache)
                .unwrap()
                .unwrap_or_else(|| panic!("no scope returned for {filename}"));
            assert_eq!(scope.kind, *kind, "kind mismatch for {filename}");
            assert_eq!(scope.name, *name, "name mismatch for {filename}");
        }
    }

    #[test]
    fn enclosing_at_rust_impl_block_does_not_qualify_with_type() {
        // tree-sitter-rust's `impl_item` exposes its type via a `type` field,
        // not via the `name`/`identifier`/`declarator` fields that
        // extract_definition_name probes. So methods inside `impl Foo {...}`
        // produce the bare function name, not `"Foo.bar"`. Pre-existing
        // behavior of find_enclosing_function — pinned here so a future
        // qualifier improvement is an intentional, visible change.
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.rs",
            "struct Foo;\nimpl Foo {\n    fn bar(&self) {\n        let x = 1;\n    }\n}\n",
        );
        let cache = OutlineCache::new();
        let scope = enclosing_definition_at(&p, 4, &cache).unwrap().unwrap();
        assert_eq!(scope.kind, "function");
        assert_eq!(scope.name, "bar");
    }

    #[test]
    fn definition_by_name_finds_top_level_function() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.rs", "fn foo() {\n    let x = 1;\n}\n");
        let cache = OutlineCache::new();
        let SymbolLookup::Found(found) = definition_by_name(&p, "foo", None, &cache) else {
            panic!("expected Found");
        };
        assert_eq!(found.name, "foo");
        assert_eq!(found.def_line, 1);
        assert_eq!(found.body_end, 3);
    }

    #[test]
    fn definition_by_name_tolerates_line_drift_via_name() {
        // The caller's hint line is stale (1) but the symbol now sits at line 4;
        // name-keyed lookup must still find it.
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.rs",
            "// moved\n// down\n// a bit\nfn foo() {\n    let x = 1;\n}\n",
        );
        let cache = OutlineCache::new();
        let SymbolLookup::Found(found) = definition_by_name(&p, "foo", Some(1), &cache) else {
            panic!("expected Found");
        };
        assert_eq!(found.def_line, 4, "found at current line, not stale hint");
    }

    #[test]
    fn definition_by_name_resolves_nested_method() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.rs",
            "struct Foo;\nimpl Foo {\n    fn bar(&self) {\n        let x = 1;\n    }\n}\n",
        );
        let cache = OutlineCache::new();
        let SymbolLookup::Found(found) = definition_by_name(&p, "bar", None, &cache) else {
            panic!("expected Found");
        };
        assert_eq!(found.name, "bar");
        assert_eq!(found.def_line, 3);
    }

    #[test]
    fn definition_by_name_is_ambiguous_for_same_name_and_picks_nearest() {
        // Two same-named functions → Ambiguous; the hint line selects the nearer.
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.rs",
            "fn dup() {\n}\n\n\n\n\nfn dup() {\n    let y = 2;\n}\n",
        );
        let cache = OutlineCache::new();
        let SymbolLookup::Ambiguous { nearest, count, .. } =
            definition_by_name(&p, "dup", Some(1), &cache)
        else {
            panic!("expected Ambiguous");
        };
        assert_eq!(count, 2);
        assert_eq!(nearest.def_line, 1, "hint near top selects top candidate");
        let SymbolLookup::Ambiguous { nearest, .. } =
            definition_by_name(&p, "dup", Some(8), &cache)
        else {
            panic!("expected Ambiguous");
        };
        assert_eq!(
            nearest.def_line, 7,
            "hint near bottom selects bottom candidate"
        );
    }

    #[test]
    fn definition_by_name_returns_absent_when_name_not_in_outline() {
        // File IS outlineable, name genuinely missing → Absent (stale), not Unverified.
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "a.rs", "fn bar() {}\n");
        let cache = OutlineCache::new();
        assert_eq!(
            definition_by_name(&p, "foo", None, &cache),
            SymbolLookup::Absent
        );
    }

    #[test]
    fn definition_by_name_captures_signature_and_doc() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(
            tmp.path(),
            "a.rs",
            "/// Adds two numbers.\nfn add(a: u32, b: u32) -> u32 {\n    a + b\n}\n",
        );
        let cache = OutlineCache::new();
        let SymbolLookup::Found(found) = definition_by_name(&p, "add", None, &cache) else {
            panic!("expected Found");
        };
        let sig = found.signature.expect("signature present");
        assert!(sig.contains("add"), "signature names the fn: {sig}");
        assert!(sig.contains("a: u32"), "signature carries params: {sig}");
        let doc = found.doc.expect("doc present");
        assert!(doc.contains("Adds two numbers"), "doc captured: {doc}");
    }

    #[test]
    fn comments_follow_exact_spans_and_go_declaration_structure() {
        let path = Path::new("contract.go");
        let source = "// Contract docs\ntype Contract interface {\n\t// Call docs\n\tCall()\n}\n";
        assert_eq!(leading_comment_start(path, source, (2, 5), (5, 1)), Some(1));
        assert_eq!(leading_comment_start(path, source, (4, 1), (4, 7)), Some(3));
        let grouped = "// Group docs\ntype (\n\t// One docs\n\tOne struct{} // One trailing\n\t// Two docs\n\tTwo struct{}\n)\n";
        assert_eq!(
            leading_comment_start(path, grouped, (4, 1), (4, 13)),
            Some(3)
        );
        assert_eq!(
            leading_comment_start(path, grouped, (6, 1), (6, 13)),
            Some(5)
        );
        let trailing_block =
            "package p\ntype (\n\tA struct{} /* A only */\n\tB interface { Call() }\n)\n";
        assert_eq!(
            leading_comment_start(path, trailing_block, (4, 1), (4, 23)),
            None
        );
        let own_block =
            "package p\ntype (\n\tA struct{}\n\t/* B docs */\n\tB interface { Call() }\n)\n";
        assert_eq!(
            leading_comment_start(path, own_block, (5, 1), (5, 23)),
            Some(4)
        );
        let source = "const emoji = '😀'; /** Work docs */\nexport function Work() {}\n";
        assert_eq!(
            leading_comment_start(Path::new("work.ts"), source, (2, 7), (2, 25)),
            Some(1)
        );
        assert_eq!(
            leading_comment_start(Path::new("work.ts"), source, (2, 8), (2, 25)),
            None
        );
        let same_line = "'😀'; /** docs */ function Work() {}";
        let byte_start = same_line.find("function").unwrap();
        let column = same_line[..byte_start].encode_utf16().count() as u32;
        assert_ne!(column as usize, byte_start);
        assert_eq!(
            leading_comment_start(
                Path::new("work.ts"),
                same_line,
                (1, column),
                (1, same_line.encode_utf16().count() as u32)
            ),
            Some(1)
        );
        assert_eq!(
            leading_comment_start(
                Path::new("work.ts"),
                same_line,
                (1, byte_start as u32),
                (1, same_line.len() as u32)
            ),
            None
        );
    }

    #[test]
    fn definition_by_name_returns_unverified_for_non_outlineable_file() {
        // A non-code file pi-nav cannot outline must be Unverified, never Absent —
        // so callers don't false-flag a live symbol as stale.
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), "notes.unknownext", "some plain text\n");
        let cache = OutlineCache::new();
        assert_eq!(
            definition_by_name(&p, "foo", None, &cache),
            SymbolLookup::Unverified
        );
    }
}
