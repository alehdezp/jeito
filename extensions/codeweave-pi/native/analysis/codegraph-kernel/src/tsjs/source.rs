//! Source facts shared by live TS/JS navigation and semantic extraction.
//!
//! This module classifies syntax, not resolved symbols. IDs are syntax extents
//! within the caller's captured file; graph IDs are associated at emission, not
//! reconstructed from names. A complete lexical walk and the filtered semantic
//! walk deliberately have different traversal policies.

use std::ops::Range;
use tree_sitter::Node;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Function,
    Method,
    Field,
    Class,
    Interface,
    Enum,
    TypeAlias,
    Namespace,
    VariableStatement,
    Binding,
    PropertySignature,
    MethodSignature,
    Object,
}

/// The factual classification owner. Callers may filter these categories for
/// a semantic projection, but must not supply a different lexical identity.
pub fn classify(kind: &str) -> Option<Kind> {
    Some(match kind {
        "function_declaration"
        | "generator_function_declaration"
        | "arrow_function"
        | "function_expression"
        | "generator_function" => Kind::Function,
        "method_definition" => Kind::Method,
        "public_field_definition" | "field_definition" => Kind::Field,
        "class_declaration" | "abstract_class_declaration" | "class" => Kind::Class,
        "interface_declaration" => Kind::Interface,
        "enum_declaration" => Kind::Enum,
        "type_alias_declaration" => Kind::TypeAlias,
        "internal_module" | "module" => Kind::Namespace,
        "lexical_declaration" | "variable_declaration" => Kind::VariableStatement,
        "variable_declarator" => Kind::Binding,
        "property_signature" => Kind::PropertySignature,
        "method_signature" | "abstract_method_signature" | "function_signature" => {
            Kind::MethodSignature
        }
        "object" => Kind::Object,
        _ => return None,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Identity {
    pub bytes: Range<usize>,
    pub syntax_kind: String,
}

pub fn identity(node: Node) -> Identity {
    Identity {
        bytes: node.byte_range(),
        syntax_kind: node.kind().to_owned(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Region {
    pub id: Identity,
    pub kind: Kind,
    /// None is a real anonymous lexical container, not the nearest named owner.
    pub name: Option<String>,
    pub parent: Option<Identity>,
    pub declaration: Range<usize>,
    pub signature: Range<usize>,
    /// Parsed implementation/container body. Without one, `signature` may be a whole value declaration.
    pub body: Option<Range<usize>>,
    pub comments: Vec<Range<usize>>,
    /// Includes damage in an enclosing non-program region. A healthy sibling
    /// beside a root-level ERROR remains usable.
    pub recovered: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    /// Syntax only: call_expression or new_expression, never a resolved target.
    pub syntax_kind: String,
    pub expression: Range<usize>,
    pub target: Option<Range<usize>>,
    pub owner: Option<Identity>,
    pub recovered: bool,
}

#[derive(Debug, Default)]
pub struct Facts {
    pub regions: Vec<Region>,
    pub references: Vec<Reference>,
    /// Exact ERROR/missing-token extents, including zero-width missing tokens.
    pub diagnostics: Vec<Range<usize>>,
}

/// Intrinsic source name; semantic overrides (for example a generated hook)
/// are a separate projection. No identifier-shaped descendant guessing here.
pub fn intrinsic_name<'a>(node: Node, source: &'a str) -> Option<&'a str> {
    node.child_by_field_name("name")
        .or_else(|| node.child_by_field_name("property"))
        .map(|name| &source[name.byte_range()])
}

/// The maintained arrow/ordinary-function binding projection shares a
/// declaration. Generators retain their separate binding and callable regions.
pub fn function_binding_name<'a>(node: Node, source: &'a str) -> Option<&'a str> {
    if !matches!(node.kind(), "arrow_function" | "function_expression")
        || intrinsic_name(node, source).is_some()
    {
        return None;
    }
    let parent = node.parent()?;
    if parent.kind() != "variable_declarator" {
        return None;
    }
    intrinsic_name(parent, source)
}

/// Preserve the maintained field/HOF body rule at one source owner. A wrapped
/// callback is not thereby a separately named/resolved method.
pub fn field_callable(node: Node) -> Option<Node> {
    if classify(node.kind()) != Some(Kind::Field) {
        return None;
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if matches!(child.kind(), "arrow_function" | "function_expression") {
            return Some(child);
        }
        if child.kind() == "call_expression" {
            if let Some(args) = child.child_by_field_name("arguments") {
                let mut args_cursor = args.walk();
                let callable = args
                    .named_children(&mut args_cursor)
                    .find(|arg| matches!(arg.kind(), "arrow_function" | "function_expression"));
                if let Some(callable) = callable {
                    return Some(callable);
                }
            }
        }
    }
    None
}

fn region_kind(node: Node, source: &str) -> Option<Kind> {
    // `class` names both the expression node and its unnamed keyword token.
    // Tokens remain available to recovery diagnostics, not declaration regions.
    if !node.is_named() {
        return None;
    }
    let kind = classify(node.kind())?;
    if kind == Kind::VariableStatement {
        return None;
    }
    if kind == Kind::Binding {
        if let Some(value) = node.child_by_field_name("value") {
            if function_binding_name(value, source).is_some() {
                return None;
            }
        }
    }
    Some(kind)
}

/// Nearest source declaration/container, independent of which graph rows exist.
/// Ordinary statement blocks do not invent declaration identities.
pub fn lexical_owner<'t>(node: Node<'t>, source: &str) -> Option<Node<'t>> {
    let mut parent = node.parent();
    while let Some(candidate) = parent {
        if region_kind(candidate, source).is_some() {
            return Some(candidate);
        }
        parent = candidate.parent();
    }
    None
}

/// Values and object literals provide display context, not callable origins.
/// This remains syntactic attribution: it does not resolve a target or prove
/// that a call executes. Field initializers retain their field context.
pub fn reference_owner<'t>(node: Node<'t>, source: &str) -> Option<Node<'t>> {
    let mut owner = lexical_owner(node, source);
    while let Some(candidate) = owner {
        if !matches!(
            classify(candidate.kind()),
            Some(Kind::Binding | Kind::Object)
        ) {
            return Some(candidate);
        }
        owner = lexical_owner(candidate, source);
    }
    None
}

fn envelope(mut node: Node) -> Node {
    while let Some(parent) = node.parent() {
        if matches!(
            parent.kind(),
            "export_statement"
                | "ambient_declaration"
                | "lexical_declaration"
                | "variable_declaration"
                | "variable_declarator"
        ) {
            node = parent;
        } else {
            break;
        }
    }
    node
}

fn touches_recovery(mut node: Node) -> bool {
    loop {
        if node.kind() != "program" && node.has_error() {
            return true;
        }
        if node.is_error() || node.is_missing() {
            return true;
        }
        match node.parent() {
            Some(parent) if parent.kind() != "program" => node = parent,
            _ => return false,
        }
    }
}

/// An object literal is itself a body; other containers expose a body field.
/// Never search inside a callable's parameters once its own body is known.
fn signature_body(node: Node) -> Option<Node> {
    if node.kind() == "object" {
        Some(node)
    } else {
        node.child_by_field_name("body")
    }
}

/// Peel transparent syntax only: a body in an argument, array element, or
/// conditional branch cannot turn the preceding value into a declaration header.
fn initializer_body(mut node: Node) -> Option<Node> {
    loop {
        let expression_index = match node.kind() {
            // These grammar productions have no expression field. Assertions
            // put type_arguments first; the other wrappers put the value first.
            "type_assertion" => 1,
            "parenthesized_expression"
            | "as_expression"
            | "satisfies_expression"
            | "non_null_expression"
            | "instantiation_expression" => 0,
            _ => return signature_body(node),
        };
        let mut cursor = node.walk();
        let expression = node
            .named_children(&mut cursor)
            .filter(|child| !child.is_extra())
            .nth(expression_index)?;
        node = expression;
    }
}

pub fn describe(node: Node, source: &str) -> Option<Region> {
    let kind = region_kind(node, source)?;
    let declaration = envelope(node).byte_range();
    // Semantic callable-field/HOF projection is separate from an immediate
    // source header; a callback argument must not lend this region its body.
    let body = signature_body(node).or_else(|| {
        if matches!(kind, Kind::Binding | Kind::Field) {
            node.child_by_field_name("value").and_then(initializer_body)
        } else {
            None
        }
    });
    let header_end = body.map_or(declaration.end, |body| body.start_byte());
    let signature_end = declaration.start + source[declaration.start..header_end].trim_end().len();
    Some(Region {
        id: identity(node),
        kind,
        name: intrinsic_name(node, source)
            .or_else(|| function_binding_name(node, source))
            .map(str::to_owned),
        parent: lexical_owner(node, source).map(identity),
        declaration: declaration.clone(),
        signature: declaration.start..signature_end,
        body: body.map(|body| body.byte_range()),
        comments: crate::docstring::preceding_comment_ranges(node),
        recovered: touches_recovery(node),
    })
}

/// `root` must be parsed from precisely `source`. No filesystem access, graph,
/// or clean-file requirement. Parser selection/capture identity stays with the
/// caller. Iterative traversal retains arbitrarily nested declarations without
/// a separate depth cutoff or recursion on the Rust stack.
pub fn collect(root: Node, source: &str) -> Facts {
    let mut facts = Facts::default();
    let mut cursor = root.walk();
    loop {
        let node = cursor.node();
        if node.is_error() || node.is_missing() {
            facts.diagnostics.push(node.byte_range());
        }
        if let Some(region) = describe(node, source) {
            facts.regions.push(region);
        }
        if matches!(node.kind(), "call_expression" | "new_expression") {
            facts.references.push(Reference {
                syntax_kind: node.kind().to_owned(),
                expression: node.byte_range(),
                target: node
                    .child_by_field_name("function")
                    .or_else(|| node.child_by_field_name("constructor"))
                    .map(|target| target.byte_range()),
                owner: reference_owner(node, source).map(identity),
                recovered: touches_recovery(node),
            });
        }
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return facts;
            }
        }
    }
}
