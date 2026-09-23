//! Exact comment attachment shared by source navigation and docstring cleaning.
use tree_sitter::Node;

/// DOCSTRING_WRAPPER_TYPES (tree-sitter-helpers.ts).
fn is_wrapper(kind: &str) -> bool {
    matches!(
        kind,
        "export_statement"
            | "decorated_definition"
            | "lexical_declaration"
            | "variable_declaration"
            | "variable_declarator"
            | "ambient_declaration"
    )
}

fn is_comment(kind: &str) -> bool {
    matches!(
        kind,
        "comment" | "line_comment" | "block_comment" | "documentation_comment"
    )
}

/// Exact source regions underlying the existing cleaned-docstring projection.
pub fn preceding_comment_ranges(node: Node) -> Vec<std::ops::Range<usize>> {
    let mut anchor = node;
    while let Some(parent) = anchor.parent() {
        if !is_wrapper(parent.kind()) {
            break;
        }
        anchor = parent;
    }
    let mut comments = Vec::new();
    let mut sibling = anchor.prev_named_sibling();
    while let Some(node) = sibling {
        if !is_comment(node.kind()) {
            break;
        }
        comments.push(node.byte_range());
        sibling = node.prev_named_sibling();
    }
    comments.reverse();
    comments
}
