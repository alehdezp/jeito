use super::{extract, extract_with_sources, source};
use crate::{buffers, langs, textutil};
use source::{Facts, Kind, Region};

const NESTED: &str = "/** outer docs */\nexport function outer(\n  input: string,\n): string {\n  /** inner docs */\n  function inner(\n    suffix: string,\n  ): string { return input + suffix; }\n  return inner('!');\n}\nfunction inner() { return 'other'; }\n";
const CALLBACK: &str = "export function outer() {\n  return items.map(() => {\n    function insideCallback() { return 1; }\n    return insideCallback();\n  });\n}\n";

fn facts(source: &str, language: &str) -> Facts {
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&langs::grammar_for(language).unwrap())
        .unwrap();
    let tree = parser.parse(source, None).unwrap();
    source::collect(tree.root_node(), source)
}

fn named<'a>(facts: &'a Facts, name: &str) -> &'a Region {
    let found: Vec<_> = facts
        .regions
        .iter()
        .filter(|r| r.name.as_deref() == Some(name))
        .collect();
    assert_eq!(
        found.len(),
        1,
        "expected exactly one {name}: {:?}",
        facts.regions
    );
    found[0]
}

fn word(row: &[u8], offset: usize) -> usize {
    u32::from_le_bytes(row[offset..offset + 4].try_into().unwrap()) as usize
}

fn string<'a>(row: &[u8], offset: usize, arena: &'a [u8]) -> Option<&'a str> {
    let start = word(row, offset);
    (start != u32::MAX as usize)
        .then(|| std::str::from_utf8(&arena[start..start + word(row, offset + 4)]).unwrap())
}

#[test]
fn default_exports_bind_exact_existing_local_declarations() {
    for language in ["typescript", "tsx", "javascript", "jsx"] {
        for body in [
            "export default class Product {}",
            "export default function Product() {}",
            "class Product {}\nexport default Product;",
            "class Product {}\nexport { Product as default };",
            "function Product() {}\nexport default Product;",
            "function Product() {}\nexport { Product as default };",
        ] {
            let source = format!("export class Base {{}}\n/* 🛰 */ {body}\n");
            let extracted = extract_with_sources("defaults.ts", &source, language).unwrap();
            let graph = &extracted.graph;
            let edges: Vec<_> = graph.edges.chunks(buffers::EDGE_ROW_SIZE)
                .filter(|edge| edge[8] == buffers::edge_kind_index("exports").unwrap()).collect();
            assert_eq!(edges.len(), 1, "{language}: {body}");
            let edge = edges[0];
            assert_eq!(word(edge, 0), 0, "the file owns the export");
            let target = word(edge, 4);
            let row = &graph.nodes[target * buffers::NODE_ROW_SIZE..(target + 1) * buffers::NODE_ROW_SIZE];
            assert_eq!(string(row, 20, &graph.arena), Some("Product"));
            assert_eq!(edge[9], 1, "tree-sitter provenance");
            assert_eq!(string(edge, 20, &graph.arena), Some(r#"{"exportedName":"default"}"#));
            let export = source.rfind("export").unwrap();
            let line = source[..export].bytes().filter(|b| *b == b'\n').count();
            assert_eq!(word(edge, 12), line + 1);
            assert_eq!(word(edge, 16), textutil::col16(&source, &textutil::line_starts(&source), line, export) as usize);
            let graph_id = string(row, 36, &graph.arena).unwrap();
            let association = extracted.associations.iter().find(|a| a.graph_id == graph_id).unwrap();
            let declaration = named(&facts(&source, language), "Product").id.clone();
            assert_eq!(association.source.as_ref(), Some(&declaration));
            // Adding binding facts creates no duplicate declaration or export node.
            assert_eq!(graph.nodes.len() / buffers::NODE_ROW_SIZE, 3);
        }
    }
}

#[test]
fn unsupported_or_ambiguous_defaults_do_not_guess_the_first_export() {
    for body in [
        "export class Base {}",
        "export class Base {}\nexport default makeProduct();",
        "export class Base {}\nexport default class {};",
        "export class Base {}\nexport default function() {};",
        "function outer() { class Product {} }\nexport default Product;",
        "if (true) { class Product {} }\nexport default Product;",
        "function Product() {}\nfunction Product() {}\nexport default Product;",
        "class Product {}\nexport default Product;\nexport default Product;",
        "import Product from './other';\nexport default Product;",
        "export { Product as default } from './other';",
        "class Product {}\nexport type { Product as default };",
        "class Product {}\nexport { type Product as default };",
        "export const text = 'export default Base';\nexport class Base {}",
    ] {
        let graph = extract("defaults.ts", body, "typescript").unwrap();
        assert!(graph.edges.chunks(buffers::EDGE_ROW_SIZE)
            .all(|edge| edge[8] != buffers::edge_kind_index("exports").unwrap()), "{body}");
    }
}

#[test]
fn default_binding_ignores_same_named_block_declarations() {
    let source = "class Product {}\nif (true) { class Product {} }\nexport default Product;";
    let graph = extract("defaults.ts", source, "typescript").unwrap();
    let edges: Vec<_> = graph.edges.chunks(buffers::EDGE_ROW_SIZE)
        .filter(|edge| edge[8] == buffers::edge_kind_index("exports").unwrap()).collect();
    assert_eq!(edges.len(), 1);
    let target = word(edges[0], 4);
    let row = &graph.nodes[target * buffers::NODE_ROW_SIZE..(target + 1) * buffers::NODE_ROW_SIZE];
    assert_eq!(word(row, 4), 1, "only the direct module declaration binds the default");
}

#[test]
fn construction_keeps_namespace_qualification_and_source_site() {
    let source = "import * as Models from './model';\nfunction build() { const emoji = '🛰'; return new Models.Product<string>(); }";
    let graph = extract("consumer.ts", source, "typescript").unwrap();
    let refs: Vec<_> = graph.refs.chunks(buffers::REF_ROW_SIZE)
        .filter(|row| row[4] == buffers::edge_kind_index("instantiates").unwrap()).collect();
    assert_eq!(refs.len(), 1);
    assert_eq!(string(refs[0], 16, &graph.arena), Some("Models.Product"));
    let start = source.find("new Models").unwrap();
    assert_eq!(word(refs[0], 8), 2);
    assert_eq!(word(refs[0], 12), textutil::col16(source, &textutil::line_starts(source), 1, start) as usize);
}

#[test]
fn nested_sibling_ids_complete_headers_and_comments_are_source_ranges() {
    for language in ["typescript", "tsx"] {
        let facts = facts(NESTED, language);
        assert!(facts.diagnostics.is_empty());
        let outer = named(&facts, "outer");
        let inners: Vec<_> = facts
            .regions
            .iter()
            .filter(|r| r.name.as_deref() == Some("inner"))
            .collect();
        assert_eq!(inners.len(), 2);
        assert_ne!(inners[0].id, inners[1].id);
        assert_eq!(inners[0].parent.as_ref(), Some(&outer.id));
        assert_eq!(inners[1].parent, None);
        assert_eq!(outer.id.bytes.start, NESTED.find("function outer").unwrap());
        assert_eq!(
            &NESTED[outer.signature.clone()],
            "export function outer(\n  input: string,\n): string"
        );
        assert_eq!(
            &NESTED[inners[0].signature.clone()],
            "function inner(\n    suffix: string,\n  ): string"
        );
        assert_eq!(&NESTED[outer.comments[0].clone()], "/** outer docs */");
        assert_eq!(&NESTED[inners[0].comments[0].clone()], "/** inner docs */");
        assert!(NESTED[outer.declaration.clone()].ends_with("return inner('!');\n}"));
        assert!(facts.regions.iter().all(|r| !r.recovered));
    }
}

#[test]
fn callback_is_the_immediate_source_parent_not_outer() {
    for language in ["typescript", "tsx", "javascript", "jsx"] {
        let facts = facts(CALLBACK, language);
        let outer = named(&facts, "outer");
        let inner = named(&facts, "insideCallback");
        let callback = facts
            .regions
            .iter()
            .find(|r| r.name.is_none() && r.kind == Kind::Function)
            .unwrap();
        assert_eq!(callback.parent.as_ref(), Some(&outer.id));
        assert_eq!(inner.parent.as_ref(), Some(&callback.id));
        assert_eq!(callback.id.bytes.start, CALLBACK.find("() =>").unwrap());
        let call = facts
            .references
            .iter()
            .find(|r| &CALLBACK[r.expression.clone()] == "insideCallback()")
            .unwrap();
        assert_eq!(call.owner.as_ref(), Some(&callback.id));
    }
    // Skipping an anonymous container in graph containment is legitimate.
    // Missing callback graph ownership must not discard truthful declarations.
    // Its call remains an exact diagnostic, not a false call from outer.
    let without_callback_call = CALLBACK.replace("return insideCallback();", "return 1;");
    let graph = extract("callback.ts", &without_callback_call, "typescript").unwrap();
    let names: Vec<_> = graph
        .nodes
        .chunks_exact(buffers::NODE_ROW_SIZE)
        .map(|row| string(row, 20, &graph.arena).unwrap())
        .collect();
    assert_eq!(names, ["callback.ts", "outer", "insideCallback"]);
    let graph = extract("callback.ts", CALLBACK, "typescript").unwrap();
    let names: Vec<_> = graph
        .nodes
        .chunks_exact(buffers::NODE_ROW_SIZE)
        .map(|row| string(row, 20, &graph.arena).unwrap())
        .collect();
    assert_eq!(names, ["callback.ts", "outer", "insideCallback"]);
    assert!(!graph
        .refs
        .chunks_exact(buffers::REF_ROW_SIZE)
        .any(|row| string(row, 16, &graph.arena) == Some("insideCallback")));
    let diagnostics = string(&graph.meta, 20, &graph.arena).unwrap();
    assert!(diagnostics.contains("\"code\":\"unrepresented_reference_origin\""));
    assert!(diagnostics.contains("\"line\":4,\"column\":11"));
    assert!(diagnostics.contains("\"severity\":\"warning\""));
}

#[test]
fn locals_and_namespace_survive_without_graph_nodes() {
    let source = "export namespace Box {\n  export function member() {\n    const localArrow = (x: string): string => x;\n    const localValue = 1;\n    return localArrow(String(localValue));\n  }\n}\n";
    let facts = facts(source, "typescript");
    let namespace = named(&facts, "Box");
    let member = named(&facts, "member");
    let arrow = named(&facts, "localArrow");
    let value = named(&facts, "localValue");
    assert_eq!(namespace.kind, Kind::Namespace);
    assert_eq!(namespace.parent, None);
    assert_eq!(member.parent.as_ref(), Some(&namespace.id));
    assert_eq!(arrow.parent.as_ref(), Some(&member.id));
    assert_eq!(value.parent.as_ref(), Some(&member.id));
    assert_eq!(arrow.kind, Kind::Function);
    assert_eq!(
        &source[arrow.signature.clone()],
        "const localArrow = (x: string): string =>"
    );
    assert_eq!(
        &source[arrow.declaration.clone()],
        "const localArrow = (x: string): string => x;"
    );
    assert_eq!(&source[value.declaration.clone()], "const localValue = 1;");
    let output = extract_with_sources("namespace.ts", source, "typescript").unwrap();
    let rows: Vec<_> = output
        .graph
        .nodes
        .chunks_exact(buffers::NODE_ROW_SIZE)
        .collect();
    assert_eq!(
        rows.len(),
        2,
        "namespace and locals are not new graph declarations"
    );
    assert_eq!(string(rows[1], 20, &output.graph.arena), Some("member"));
    assert_eq!(string(rows[1], 28, &output.graph.arena), Some("member"));
    assert_eq!(
        (
            word(rows[1], 4),
            word(rows[1], 12),
            word(rows[1], 8),
            word(rows[1], 16)
        ),
        (2, 9, 6, 3)
    );
    let member_id = crate::ids::node_id("namespace.ts", "function", "member", 2, 9);
    assert_eq!(
        string(rows[1], 36, &output.graph.arena),
        Some(member_id.as_str())
    );
    assert!(output
        .associations
        .iter()
        .any(|a| a.source.as_ref() == Some(&member.id) && a.graph_id == member_id));
    assert!(!output
        .associations
        .iter()
        .any(|a| a.source.as_ref() == Some(&namespace.id)));
    let edges: Vec<_> = output
        .graph
        .edges
        .chunks_exact(buffers::EDGE_ROW_SIZE)
        .collect();
    assert_eq!(edges.len(), 1);
    assert_eq!((word(edges[0], 0), word(edges[0], 4)), (0, 1));
    assert_eq!(edges[0][8], buffers::edge_kind_index("contains").unwrap());
    let refs: Vec<_> = output
        .graph
        .refs
        .chunks_exact(buffers::REF_ROW_SIZE)
        .collect();
    assert_eq!(refs.len(), 2);
    assert!(refs.iter().all(|row| word(row, 0) == 1));
}

#[test]
fn unicode_source_bytes_are_not_wire_utf16_columns() {
    let source = "const emoji = '😀'; class A { run() {} } class B { run() {} }\n";
    for language in ["javascript", "jsx"] {
        let facts = facts(source, language);
        let a = named(&facts, "A");
        let b = named(&facts, "B");
        let methods: Vec<_> = facts
            .regions
            .iter()
            .filter(|r| r.name.as_deref() == Some("run"))
            .collect();
        assert_eq!(methods.len(), 2);
        assert_ne!(methods[0].id, methods[1].id);
        assert_eq!(methods[0].parent.as_ref(), Some(&a.id));
        assert_eq!(methods[1].parent.as_ref(), Some(&b.id));
        let output = extract_with_sources("same-row.js", source, language).unwrap();
        let rows: Vec<_> = output
            .graph
            .nodes
            .chunks_exact(buffers::NODE_ROW_SIZE)
            .collect();
        let method_rows: Vec<_> = rows
            .iter()
            .filter(|row| string(row, 20, &output.graph.arena) == Some("run"))
            .collect();
        for (region, row) in methods.iter().zip(method_rows) {
            let utf16 = source[..region.id.bytes.start].encode_utf16().count();
            assert_eq!(word(row, 12), utf16);
            assert_eq!(region.id.bytes.start, utf16 + 2);
            let emitted_id = string(row, 36, &output.graph.arena).unwrap();
            assert!(output
                .associations
                .iter()
                .any(|a| a.source.as_ref() == Some(&region.id) && a.graph_id == emitted_id));
        }
    }
}

#[test]
fn partial_files_keep_healthy_declarations_but_cannot_publish_semantics() {
    let source = "function valid() { return 1; }\nconst unfinished = (\n";
    let facts = facts(source, "typescript");
    let valid = named(&facts, "valid");
    assert!(!valid.recovered);
    assert_eq!(
        &source[valid.declaration.clone()],
        "function valid() { return 1; }"
    );
    assert!(!facts.diagnostics.is_empty());
    assert!(facts
        .diagnostics
        .iter()
        .all(|r| r.start >= source.find("const unfinished").unwrap()));
    assert!(extract("partial.ts", source, "typescript")
        .err()
        .unwrap()
        .contains("clean parse"));
}

#[test]
fn valid_producer_names_positions_and_docs_retain_their_contract() {
    let output = extract_with_sources("witness.ts", NESTED, "typescript").unwrap();
    let rows: Vec<_> = output
        .graph
        .nodes
        .chunks_exact(buffers::NODE_ROW_SIZE)
        .collect();
    assert_eq!(rows.len(), 4);
    let expected = [
        ("outer", "outer", 2, 7),
        ("inner", "outer::inner", 6, 2),
        ("inner", "inner", 11, 0),
    ];
    for (row, (name, qualified, line, column)) in rows.iter().skip(1).zip(expected) {
        assert_eq!(string(row, 20, &output.graph.arena), Some(name));
        assert_eq!(string(row, 28, &output.graph.arena), Some(qualified));
        assert_eq!(word(row, 4), line);
        assert_eq!(word(row, 12), column);
    }
    assert_eq!(string(rows[1], 44, &output.graph.arena), Some("outer docs"));
    assert_eq!(
        string(rows[1], 52, &output.graph.arena),
        Some("(\n  input: string,\n): string")
    );
    assert_eq!(output.associations.len(), rows.len());
    assert_eq!(textutil::utf16_len("😀"), 2);
}

#[test]
fn existing_direct_callable_field_projection_remains_usable() {
    let source = "class Worker { run = () => { return flush(); }; }";
    let facts = facts(source, "typescript");
    let run = named(&facts, "run");
    assert_eq!(&source[run.signature.clone()], "run = () =>");
    let output = extract_with_sources("field.ts", source, "typescript").unwrap();
    let rows: Vec<_> = output
        .graph
        .nodes
        .chunks_exact(buffers::NODE_ROW_SIZE)
        .collect();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[2][0], buffers::node_kind_index("method").unwrap());
    assert_eq!(string(rows[2], 20, &output.graph.arena), Some("run"));
    let id = crate::ids::node_id("field.ts", "method", "run", 1, 15);
    assert_eq!(string(rows[2], 36, &output.graph.arena), Some(id.as_str()));
    let callable = facts
        .regions
        .iter()
        .find(|r| r.kind == Kind::Function)
        .unwrap();
    for source in [&run.id, &callable.id] {
        assert!(output
            .associations
            .iter()
            .any(|a| a.source.as_ref() == Some(source) && a.graph_id == id));
    }
    let refs: Vec<_> = output
        .graph
        .refs
        .chunks_exact(buffers::REF_ROW_SIZE)
        .collect();
    assert_eq!(refs.len(), 1);
    assert_eq!(word(refs[0], 0), 2);
    assert_eq!(string(refs[0], 16, &output.graph.arena), Some("flush"));
    assert_eq!(refs[0][4], buffers::edge_kind_index("calls").unwrap());
}

#[test]
fn generator_containers_own_nested_declarations_and_calls() {
    let cases = [
        (
            "function* outer() { function inner() {} inner(); }",
            Some("outer"),
            "generator_function_declaration",
            None,
        ),
        (
            "const bound = function* () { function inner() {} inner(); };",
            None,
            "generator_function",
            Some("bound"),
        ),
        (
            "const bound = function* named() { function inner() {} inner(); };",
            Some("named"),
            "generator_function",
            Some("bound"),
        ),
    ];
    for language in ["typescript", "tsx", "javascript", "jsx"] {
        for (text, name, syntax_kind, parent) in cases {
            let facts = facts(text, language);
            assert!(facts.diagnostics.is_empty(), "{language}: {text}");
            let generator = facts
                .regions
                .iter()
                .find(|r| r.id.syntax_kind == syntax_kind)
                .unwrap();
            assert_eq!(generator.name.as_deref(), name);
            assert_eq!(generator.kind, Kind::Function);
            assert_eq!(generator.id.bytes.start, text.find("function*").unwrap());
            assert_eq!(
                generator.parent.as_ref(),
                parent.map(|name| &named(&facts, name).id)
            );
            assert_eq!(named(&facts, "inner").parent.as_ref(), Some(&generator.id));
            let call = facts
                .references
                .iter()
                .find(|r| &text[r.expression.clone()] == "inner()")
                .unwrap();
            assert_eq!(call.owner.as_ref(), Some(&generator.id));
            if syntax_kind == "generator_function" {
                // Keep the existing constant and nested function rows, with an
                // explicit origin diagnostic instead of inventing a callable ID.
                let without_call = text.replace(" inner();", "");
                let graph = extract_with_sources("generator.ts", &without_call, language).unwrap();
                let rows: Vec<_> = graph
                    .graph
                    .nodes
                    .chunks_exact(buffers::NODE_ROW_SIZE)
                    .collect();
                assert_eq!(rows.len(), 3);
                assert_eq!(string(rows[1], 20, &graph.graph.arena), Some("bound"));
                assert_eq!(rows[1][0], buffers::node_kind_index("constant").unwrap());
                let id = crate::ids::node_id("generator.ts", "constant", "bound", 1, 6);
                assert_eq!(string(rows[1], 36, &graph.graph.arena), Some(id.as_str()));
                assert!(graph.associations.iter().any(|a| a.graph_id == id
                    && a.source
                        .as_ref()
                        .is_some_and(|s| s.syntax_kind == "variable_declarator")));
                assert_eq!(string(rows[2], 20, &graph.graph.arena), Some("inner"));
                let captured = extract("generator.ts", text, language).unwrap();
                assert_eq!(
                    captured.nodes.chunks_exact(buffers::NODE_ROW_SIZE).count(),
                    3
                );
                assert!(!captured
                    .refs
                    .chunks_exact(buffers::REF_ROW_SIZE)
                    .any(|row| string(row, 16, &captured.arena) == Some("inner")));
                assert!(string(&captured.meta, 20, &captured.arena)
                    .unwrap()
                    .contains("unrepresented_reference_origin"));
            } else {
                let graph = extract_with_sources("generator.ts", text, language).unwrap();
                let rows: Vec<_> = graph
                    .graph
                    .nodes
                    .chunks_exact(buffers::NODE_ROW_SIZE)
                    .collect();
                assert_eq!(rows.len(), 3);
                assert_eq!(string(rows[1], 20, &graph.graph.arena), Some("outer"));
                assert_eq!(string(rows[2], 20, &graph.graph.arena), Some("inner"));
                assert_eq!((word(rows[1], 4), word(rows[1], 12)), (1, 0));
                let id = crate::ids::node_id("generator.ts", "function", "outer", 1, 0);
                assert_eq!(string(rows[1], 36, &graph.graph.arena), Some(id.as_str()));
                assert!(graph
                    .associations
                    .iter()
                    .any(|a| a.source.as_ref() == Some(&generator.id) && a.graph_id == id));
                let refs: Vec<_> = graph
                    .graph
                    .refs
                    .chunks_exact(buffers::REF_ROW_SIZE)
                    .collect();
                assert_eq!(refs.len(), 1);
                assert_eq!(
                    word(refs[0], 0),
                    1,
                    "the generator is the direct call origin"
                );
            }
        }
    }
}

#[test]
fn class_expressions_are_source_containers_not_new_graph_classes() {
    let cases = [
        (
            "class Container { run() { return work(); } }",
            "class_declaration",
            Some("Container"),
        ),
        (
            "const Thing = class { run() { return work(); } };",
            "class",
            None,
        ),
        (
            "const Thing = class Inner { run() { return work(); } };",
            "class",
            Some("Inner"),
        ),
    ];
    for language in ["typescript", "tsx", "javascript", "jsx"] {
        for (text, syntax_kind, name) in cases {
            let facts = facts(text, language);
            assert!(facts.diagnostics.is_empty(), "{language}: {text}");
            assert_eq!(
                facts
                    .regions
                    .iter()
                    .filter(|r| r.kind == Kind::Class)
                    .count(),
                1,
                "the class keyword must not create a second class region"
            );
            let class = facts
                .regions
                .iter()
                .find(|r| r.kind == Kind::Class)
                .unwrap();
            assert_eq!(class.id.syntax_kind, syntax_kind);
            assert_eq!(class.name.as_deref(), name);
            assert_eq!(class.id.bytes.start, text.find("class").unwrap());
            if syntax_kind == "class" {
                assert_eq!(class.parent.as_ref(), Some(&named(&facts, "Thing").id));
            } else {
                assert_eq!(class.parent, None);
            }
            let method = named(&facts, "run");
            assert_eq!(method.parent.as_ref(), Some(&class.id));
            let call = facts
                .references
                .iter()
                .find(|r| &text[r.expression.clone()] == "work()")
                .unwrap();
            assert_eq!(call.owner.as_ref(), Some(&method.id));
            let output = extract_with_sources("class.ts", text, language).unwrap();
            let rows: Vec<_> = output
                .graph
                .nodes
                .chunks_exact(buffers::NODE_ROW_SIZE)
                .collect();
            assert_eq!(rows.len(), 3);
            assert_eq!(string(rows[2], 20, &output.graph.arena), Some("run"));
            let has_class = rows
                .iter()
                .any(|row| row[0] == buffers::node_kind_index("class").unwrap());
            assert_eq!(has_class, syntax_kind == "class_declaration");
            let associated_class = output
                .associations
                .iter()
                .any(|a| a.source.as_ref() == Some(&class.id));
            assert_eq!(associated_class, has_class);
            let method_id = string(rows[2], 36, &output.graph.arena).unwrap();
            assert!(output
                .associations
                .iter()
                .any(|a| a.source.as_ref() == Some(&method.id) && a.graph_id == method_id));
        }
    }
}

#[test]
fn omitted_callback_reference_does_not_hide_a_later_valid_reference() {
    let text = "function target() {}\nfunction outer() {\n  items.map(() => { const glyph = '😀'; sink(target); return new Box(); });\n  sink(target);\n}\n";
    for language in ["typescript", "tsx", "javascript", "jsx"] {
        let graph = extract("references.ts", text, language).unwrap();
        let outer = graph
            .nodes
            .chunks_exact(buffers::NODE_ROW_SIZE)
            .position(|row| string(row, 20, &graph.arena) == Some("outer"))
            .unwrap();
        let references: Vec<_> = graph
            .refs
            .chunks_exact(buffers::REF_ROW_SIZE)
            .filter(|row| {
                row[4] == buffers::FUNCTION_REF_CODE
                    && string(row, 16, &graph.arena) == Some("target")
            })
            .collect();
        assert_eq!(references.len(), 1);
        assert_eq!(
            (
                word(references[0], 0),
                word(references[0], 8),
                word(references[0], 12)
            ),
            (outer, 4, 7)
        );
        let line = text.lines().nth(2).unwrap();
        let column = line[..line.find("target").unwrap()].encode_utf16().count();
        let diagnostics = string(&graph.meta, 20, &graph.arena).unwrap();
        assert!(diagnostics.contains(&format!("\"line\":3,\"column\":{column}")));
        assert!(diagnostics.contains("Function reference omitted"));
        assert!(diagnostics.contains("Construction omitted"));
    }
}

#[test]
fn initializer_headers_follow_only_transparent_wrappers() {
    for language in ["typescript", "tsx", "javascript", "jsx"] {
        let mut cases = vec![
            ("{ value: 1 }", "{ value: 1 }"),
            ("(/* before */ { value: 1 } /* after */)", "{ value: 1 }"),
            ("class { value = 1; }", "{ value = 1; }"),
            ("(class { value = 1; })", "{ value = 1; }"),
            ("function () { return 1; }", "{ return 1; }"),
            ("(function () { return 1; })", "{ return 1; }"),
            ("function* () { yield 1; }", "{ yield 1; }"),
            ("() => { return 1; }", "{ return 1; }"),
            ("(() => { return 1; })", "{ return 1; }"),
        ];
        if matches!(language, "typescript" | "tsx") {
            cases.extend([
                (
                    "({ value: 1 } /* before type */ as { value: number })",
                    "{ value: 1 }",
                ),
                ("({ value: 1 } satisfies { value: number })", "{ value: 1 }"),
                ("({ value: 1 })!", "{ value: 1 }"),
                (
                    "((({ value: 1 }) as { value: number }) satisfies { value: number })!",
                    "{ value: 1 }",
                ),
                (
                    "(function<T>(value: T) { return value; })<number>",
                    "{ return value; }",
                ),
            ]);
        }
        if language == "typescript" {
            cases.push((
                "(<{ value: number }> /* after type */ ({ value: 1 }))!",
                "{ value: 1 }",
            ));
        }
        for (initializer, body) in cases {
            let text = format!("const Value = {initializer};\n");
            let facts = facts(&text, language);
            assert!(facts.diagnostics.is_empty(), "{language}: {text}");
            let value = named(&facts, "Value");
            let body_start = text.find(body).unwrap();
            assert_eq!(
                value.body,
                Some(body_start..body_start + body.len()),
                "{language}: {text}"
            );
            assert_eq!(
                &text[value.signature.clone()],
                text[..body_start].trim_end(),
                "{language}: {text}"
            );
            assert_eq!(&text[value.declaration.clone()], text.trim_end());
        }
    }
}

#[test]
fn compound_initializers_do_not_borrow_descendant_bodies() {
    for language in ["typescript", "tsx"] {
        for initializer in [
            "[0, { value: 1 }]",
            "[0, () => { return 1; }]",
            "collectValues(0, { value: 1 })",
            "collectValues(0, () => { return 1; })",
            "flag ? { value: 1 } : { value: 2 }",
            "flag && { value: 1 }",
            "({ value: 1 }).value",
            "(collectValues(0), { value: 1 })",
            "(collectValues({ value: 1 }) as unknown[])!",
            "([0, { value: 1 }] satisfies unknown[])",
            "new (class { value = 1; })()",
        ] {
            let text = format!("declare function collectValues(...values: unknown[]): unknown[];\ndeclare const flag: boolean;\nconst Value = {initializer};\n");
            let facts = facts(&text, language);
            assert!(facts.diagnostics.is_empty(), "{language}: {text}");
            let value = named(&facts, "Value");
            assert_eq!(value.body, None, "{language}: {text}");
            assert_eq!(value.signature, value.declaration, "{language}: {text}");
        }
    }
}

#[test]
fn callable_field_projection_does_not_invent_an_immediate_initializer_body() {
    let text = "function wrap<T>(value: T): T { return value; }\nclass Worker { run = wrap(() => { return 1; }); }\n";
    let facts = facts(text, "typescript");
    assert!(facts.diagnostics.is_empty());
    let run = named(&facts, "run");
    assert_eq!(run.body, None);
    assert_eq!(run.signature, run.declaration);

    // The semantic method projection still associates both source identities.
    let output = extract_with_sources("field.ts", text, "typescript").unwrap();
    let row = output
        .graph
        .nodes
        .chunks_exact(buffers::NODE_ROW_SIZE)
        .find(|row| string(row, 20, &output.graph.arena) == Some("run"))
        .unwrap();
    assert_eq!(row[0], buffers::node_kind_index("method").unwrap());
    let id = string(row, 36, &output.graph.arena).unwrap();
    let callable = facts
        .regions
        .iter()
        .find(|region| region.kind == Kind::Function && region.name.is_none())
        .unwrap();
    for source in [&run.id, &callable.id] {
        assert!(output
            .associations
            .iter()
            .any(|association| association.source.as_ref() == Some(source)
                && association.graph_id == id));
    }
}
