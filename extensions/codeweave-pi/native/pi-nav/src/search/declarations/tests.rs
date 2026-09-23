use super::*;
use crate::cache::OutlineCache;
use crate::dispatch::{OperationContext, ReadFormat};
use crate::index::bloom::BloomFilterCache;
use crate::search::{fuzzy, symbol, OperationSources};
use crate::session::Session;
use serde_json::json;

const MIXED: &str = r#"/** Pipeline keeps commands local. */
export namespace Pipeline {
  /** Execute a command.
   * Preserve its complete input signature.
   */
  export function dispatch(
    input: string,
    attempts: number,
  ): string {
    const localArrow = (value: string): string => value;
    const localValue = 1;
    items.map(() => {
      function duplicate(value: string) { return value; }
      return duplicate(input);
    });
    return localArrow(input);
  }
  export function* batches() {
    function fromGenerator() { return 1; }
    yield fromGenerator();
  }
}
const emoji = '😀'; class First { repeat() { return 1; } } class Second { repeat() { return 2; } }
const Handler = class { member() { return 3; } };
export function duplicate() { return 'top'; }
const unfinished = (
"#;

fn fixture() -> (tempfile::TempDir, std::path::PathBuf, OperationContext) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let path = root.join("pipeline.ts");
    std::fs::write(&path, MIXED).unwrap();
    let context = OperationContext {
        root,
        deadline: None,
        cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        confine_to_root: false,
        read_format: ReadFormat::Plain,
    };
    (dir, path, context)
}

fn output(query: &str, kind: &str, context: &OperationContext) -> crate::output::ToolOutput {
    crate::ops::tool_search_output(
        &json!({"query": query, "kind": kind, "scope": context.root, "root": context.root, "budget": 12000}),
        &OutlineCache::new(), &Session::new(), &Arc::new(BloomFilterCache::new()), context,
    ).unwrap()
}

#[test]
fn fuzzy_tail_reuses_complete_child_signatures_not_partial_or_sibling_rows() {
    let (_dir, path, context) = fixture();
    // Affordable operation completion now reaches the ordinary 150-row target
    // boundary. Keep the partial-signature falsifier at that actual boundary.
    for padding in [144, 0] {
        let mut content = String::from("function Root() {\n");
        for index in 0..padding {
            content.push_str(&format!("  work({index});\n"));
        }
        content.push_str("  function Child(\n    a: number,\n    b: number,\n    c: number,\n    d: number,\n  ) {}\n}\nfunction KeepOne() {}\nfunction KeepTwo() {}\nfunction KeepThree() {}\nfunction First() {} function Sibling() {}\n");
        std::fs::write(&path, &content).unwrap();
        let mut found = fuzzy::search(
            "Root Child Keep First Sibling", &path, &[], crate::walk::Visibility::Project,
            Arc::new(OperationSources::default()), &context,
        ).unwrap().result;
        // Control the renderer's selected five; ranking is a separate contract.
        let order = ["Root", "KeepOne", "KeepTwo", "KeepThree", "First", "Child", "Sibling"];
        found.matches.retain(|matched| order.contains(&matched.def_name.as_deref().unwrap_or("")));
        found.matches.sort_by_key(|matched| order.iter().position(|name| Some(*name) == matched.def_name.as_deref()).unwrap());
        assert_eq!(found.matches.len(), order.len());
        let child = found.matches[5].declaration.as_ref().unwrap();
        let (start, end) = lines_for(&content, &child.region().signature);
        let rendered = crate::search::format_fuzzy_result_typed(&found, &OutlineCache::new(), None, None).unwrap();
        let child_rows = |line| rendered.source_rows.iter().any(|row| row.path == path && row.line == line);
        assert!(child_rows(start), "the parent must display the start of Child");
        assert_eq!(child_rows(end), padding == 0, "exercise a partly displayed multiline signature");
        assert_eq!(rendered.text.contains("\n- function Child —"), padding != 0, "only a complete displayed signature retires the tail entry");
        assert!(rendered.text.contains("\n- function Sibling —"), "sharing First's physical row is not parent identity");
        for row in rendered.source_rows {
            assert_eq!(row.text, content.lines().nth(row.line as usize - 1).unwrap());
        }
    }
}

#[test]
fn behavior_cards_keep_grouped_local_evidence_and_complete_affordable_operations() {
    let (_dir, path, context) = fixture();
    for padding in [75, 200] {
        let mut content = String::from("function Process(input: number) {\n");
        for index in 0..padding {
            content.push_str(&format!("  inspect(input, {index});\n"));
        }
        content.push_str("  const held = input < 0;\n  const status = held ? 'retry' : 'done';\n  if (held) { recover(input); }\n  return status;\n}\nfunction Other() { return 1; }\nfunction Footer() { return 2; }\nfunction Top() { return 3; }\n");
        std::fs::write(&path, &content).unwrap();
        let mut found = fuzzy::search("Process held status Other Footer Top", &path, &[],
            crate::walk::Visibility::Project, Arc::new(OperationSources::default()), &context).unwrap().result;
        let order = ["held", "status", "Other", "Footer", "Top", "Process"];
        found.matches.retain(|matched| order.contains(&matched.def_name.as_deref().unwrap_or("")));
        found.matches.sort_by_key(|matched| order.iter().position(|name|
            Some(*name) == matched.def_name.as_deref()).unwrap());
        assert_eq!(found.matches.len(), order.len());
        let rendered = crate::search::format_fuzzy_result_typed(&found, &OutlineCache::new(), None, None).unwrap();
        let shown = rendered.source_rows.iter().map(|row| row.line).collect::<std::collections::HashSet<_>>();
        assert_eq!(shown.len(), rendered.source_rows.len(), "source must not repeat across grouped identities");
        for matched in &found.matches {
            assert!(shown.contains(&matched.line), "selected source lost: {:?}", matched.def_name);
        }
        assert_eq!(rendered.text.matches("## Process —").count(), 1);
        assert!(!rendered.text.contains("## held —"));
        assert!(!rendered.text.contains("## status —"));
        if padding == 75 {
            assert!(content.lines().enumerate().all(|(index, _)| shown.contains(&(index as u32 + 1))),
                "an affordable operation must retain its conditions, recovery and returned result");
            assert!(rendered.source_rows.windows(2).all(|pair| pair[0].line < pair[1].line),
                "complete operation source stays in order; reserved local hits must not move before their inputs");
        } else {
            assert!(rendered.text.contains("remaining target"));
            assert!(rendered.source_rows.len() <= 150 + 3,
                "grouping cannot invent body allowance");
        }
        for row in rendered.source_rows {
            assert_eq!(row.text, content.lines().nth(row.line as usize - 1).unwrap());
        }
    }
}

#[test]
fn exact_and_fuzzy_keep_source_owned_nested_declarations() {
    let (_dir, path, context) = fixture();
    for (name, parent_kind, parent_name) in [
        ("dispatch", "internal_module", Some("Pipeline")),
        ("localArrow", "function_declaration", Some("dispatch")),
        ("localValue", "function_declaration", Some("dispatch")),
        (
            "fromGenerator",
            "generator_function_declaration",
            Some("batches"),
        ),
        ("member", "class", None),
    ] {
        let exact = symbol::search(name, &path, None, None, true).unwrap();
        let fuzzy = fuzzy::search(
            name,
            &path,
            &[],
            crate::walk::Visibility::Project,
            Arc::new(OperationSources::default()),
            &context,
        )
        .unwrap();
        for result in [&exact, &fuzzy.result] {
            let matched = result
                .matches
                .iter()
                .find(|m| m.def_name.as_deref() == Some(name))
                .expect(name);
            let declaration = matched.declaration.as_ref().unwrap();
            let parents = declaration.ancestors();
            let parent = parents.last().unwrap();
            assert_eq!(parent.id.syntax_kind, parent_kind, "{name}");
            assert_eq!(parent.name.as_deref(), parent_name, "{name}");
            assert!(
                !declaration.region().recovered,
                "healthy declaration beside unfinished source"
            );
        }
    }
    let exact = symbol::search("duplicate", &path, None, None, true).unwrap();
    let defs: Vec<_> = exact.matches.iter().filter(|m| m.is_definition).collect();
    assert_eq!(defs.len(), 2);
    let mut expected = vec![
        MIXED.find("function duplicate(value").unwrap(),
        MIXED.find("function duplicate()").unwrap(),
    ];
    let mut actual = defs
        .iter()
        .map(|m| m.declaration.as_ref().unwrap().key().0)
        .collect::<Vec<_>>();
    expected.sort();
    actual.sort();
    assert_eq!(actual, expected);
    let nested = defs
        .iter()
        .find(|m| m.declaration.as_ref().unwrap().key().0 == expected[0])
        .unwrap();
    assert_eq!(
        nested
            .declaration
            .as_ref()
            .unwrap()
            .ancestors()
            .last()
            .unwrap()
            .name,
        None
    );
    assert_eq!(
        nested
            .declaration
            .as_ref()
            .unwrap()
            .region()
            .parent
            .as_ref()
            .unwrap()
            .syntax_kind,
        "arrow_function"
    );
}

#[test]
fn registered_same_line_identities_survive_merge_metadata_and_rendering() {
    let (_dir, path, context) = fixture();
    let expected = ["repeat() { return 1; }", "repeat() { return 2; }"].map(|snippet| {
        let start = MIXED.find(snippet).unwrap();
        (start, start + snippet.len())
    });
    let physical_line = MIXED
        .lines()
        .find(|line| line.contains("class First"))
        .unwrap();
    for kind in ["symbol", "auto"] {
        let out = output("repeat", kind, &context);
        assert_eq!(
            out.structured["data"]["kind"],
            if kind == "auto" { "fuzzy" } else { "symbol" }
        );
        let rows = out.structured["data"]["matches"].as_array().unwrap();
        let identities = rows
            .iter()
            .filter(|row| row["symbol"] == "repeat")
            .map(|row| {
                let id = &row["sourceIdentity"];
                assert_eq!(id["syntaxKind"], "method_definition");
                (
                    id["startByte"].as_u64().unwrap() as usize,
                    id["endByte"].as_u64().unwrap() as usize,
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(identities.len(), 2, "{kind}: {}", out.text);
        for identity in expected {
            assert!(identities.contains(&identity), "{kind}: {identities:?}");
        }
        assert!(out.text.contains("class First"));
        assert!(out.text.contains("class Second"));
        assert_eq!(
            out.text.matches(physical_line).count(),
            1,
            "shared physical source must not duplicate: {}",
            out.text
        );
    }
    assert!(symbol::single_definition_owner("repeat", &path)
        .unwrap()
        .is_none());
    let content = output("repeat", "content", &context);
    assert!(content.structured["data"]["matches"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row.get("sourceIdentity").is_none()));
}

#[test]
fn registered_cards_keep_complete_headers_comments_and_anonymous_hierarchy() {
    let (_dir, _path, context) = fixture();
    for kind in ["symbol", "auto"] {
        let out = output("dispatch", kind, &context);
        let rows = out.structured["data"]["sourceRows"].as_array().unwrap();
        for source in [
            "  /** Execute a command.",
            "   * Preserve its complete input signature.",
            "  export function dispatch(",
            "    input: string,",
            "    attempts: number,",
            "  ): string {",
        ] {
            assert!(
                rows.iter().any(|row| row["text"] == source),
                "missing full source row {source:?}: {}",
                out.text
            );
        }
        assert!(out.text.contains("namespace Pipeline"));
        assert!(out.text.contains("Partial syntax elsewhere"));
        let callback = output("duplicate", kind, &context);
        assert!(
            callback.text.contains("anonymous function"),
            "{}",
            callback.text
        );
        let class = output("member", kind, &context);
        assert!(class.text.contains("anonymous class"), "{}", class.text);
    }
}

#[test]
fn navigation_does_not_replace_protected_read_outline_policy() {
    let source = "export function outer() {\n  function inner() {}\n}\n";
    let before = crate::read::outline::code::outline(source, Lang::TypeScript, 100);
    assert!(before.contains("outer"));
    assert!(
        !before.contains("inner"),
        "protected shallow read expectation changed"
    );
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&crate::lang::outline::outline_language(Lang::TypeScript).unwrap())
        .unwrap();
    let tree = parser.parse(source, None).unwrap();
    assert!(collect(tree.root_node(), source)
        .iter()
        .any(|d| d.region().name.as_deref() == Some("inner")));
    assert_eq!(
        before,
        crate::read::outline::code::outline(source, Lang::TypeScript, 100)
    );
}

#[test]
fn declaration_projection_runs_in_each_existing_tsjs_grammar() {
    let (_dir, path, context) = fixture();
    let source = "export function outer() {\n  items.map(() => {\n    function inside() { return 1; }\n    const localArrow = (value) => value;\n  });\n}\n";
    for extension in ["ts", "tsx", "js", "jsx"] {
        let path = path.with_extension(extension);
        let source = if matches!(extension, "tsx" | "jsx") {
            format!("{source}const view = <Pane/>;\n")
        } else {
            source.to_string()
        };
        std::fs::write(&path, &source).unwrap();
        for query in ["inside", "localArrow"] {
            let exact = symbol::search(query, &path, None, None, true).unwrap();
            let fuzzy = fuzzy::search(
                query,
                &path,
                &[],
                crate::walk::Visibility::Project,
                Arc::new(OperationSources::default()),
                &context,
            )
            .unwrap();
            for result in [&exact, &fuzzy.result] {
                let declaration = result
                    .matches
                    .iter()
                    .find(|m| m.def_name.as_deref() == Some(query))
                    .unwrap()
                    .declaration
                    .as_ref()
                    .unwrap();
                assert!(!declaration.partial_file(), "{extension}");
                let parent = declaration.ancestors().last().copied().unwrap();
                assert_eq!(
                    parent.id.syntax_kind, "arrow_function",
                    "{extension}: {query}"
                );
                assert_eq!(parent.name, None);
                assert!(source[declaration.region().declaration.clone()].contains(query));
            }
        }
    }
}

#[test]
fn legacy_session_line_key_cannot_hide_another_same_line_declaration() {
    let (_dir, path, context) = fixture();
    let mut source = String::from("function outer() { function inner() {\n");
    for index in 0..12 {
        source.push_str(&format!("  const value{index} = {index};\n"));
    }
    source.push_str("} }\n");
    std::fs::write(&path, source).unwrap();
    let session = Session::new();
    session.record_expand(
        &path,
        1,
        std::fs::metadata(&path).unwrap().modified().unwrap(),
    );
    let text = crate::search::search_symbol_expanded(
        "inner",
        &context.root,
        &OutlineCache::new(),
        &session,
        &BloomFilterCache::new(),
        2,
        None,
        None,
        false,
        Some(4000),
    )
    .unwrap();
    assert!(text.contains("const value0 = 0;"));
    assert!(!text.contains("omitted already read this session"));
}

#[test]
fn initializer_ancestor_bodies_are_not_required_method_headers() {
    let (_dir, path, context) = fixture();
    for (prefix, field_end, close, hierarchy) in [
        ("const Holder = class {\n", ";", "};\n", "anonymous class"),
        ("const Holder = {\n", ",", "};\n", "anonymous object"),
        (
            "class Wrapper {\n  Holder = {\n",
            ",",
            "};\n}\n",
            "anonymous object",
        ),
        ("const Holder = wrap({\n", ",", "});\n", "anonymous object"),
    ] {
        let mut source = prefix.to_string();
        for index in 0..180 {
            source.push_str(&format!(
                "  ordinary{index} {} {index}{field_end}\n",
                if field_end == ";" { "=" } else { ":" }
            ));
        }
        source.push_str("  selectedMethod(\n    value: string,\n  ): string { return value; }\n");
        source.push_str(close);
        std::fs::write(&path, source).unwrap();
        for (query, kind) in [("selectedMethod", "symbol"), ("selectedmethod", "auto")] {
            let out = output(query, kind, &context);
            let rows = out.structured["data"]["sourceRows"].as_array().unwrap();
            assert!(out.text.contains(hierarchy), "{}", out.text);
            for expected in [
                "  selectedMethod(",
                "    value: string,",
                "  ): string { return value; }",
            ] {
                assert!(
                    rows.iter().any(|row| row["text"] == expected),
                    "missing selected declaration {expected:?}: {}",
                    out.text
                );
            }
            assert!(
                !rows
                    .iter()
                    .any(|row| row["text"].as_str().unwrap().contains("ordinary")),
                "ancestor body was presented as a declaration: {} source rows",
                rows.len()
            );
            assert!(
                rows.len() <= 150,
                "ancestor source bypassed the existing target allowance"
            );
        }
    }
}

#[test]
fn ancestor_headers_share_the_target_allowance_without_splitting_parameters() {
    let (_dir, path, context) = fixture();
    for parameters in [40, 180] {
        let mut source = String::from("export function enclosing(\n");
        for index in 0..parameters {
            source.push_str(&format!("  p{index}: string,\n"));
        }
        source.push_str(") {\n  const Holder = class {\n    selectedMethod(\n      value: { text: string } = {\n        text: 'default',\n      },\n      suffix: string = '',\n    ): string {\n");
        for index in 0..180 {
            source.push_str(&format!("      const step{index} = {index};\n"));
        }
        source.push_str("      return value.text + suffix;\n    }\n  };\n}\n");
        std::fs::write(&path, &source).unwrap();
        for (query, kind) in [("selectedMethod", "symbol"), ("selectedmethod", "auto")] {
            let out = output(query, kind, &context);
            let rows = out.structured["data"]["sourceRows"].as_array().unwrap();
            // Fuzzy's separately budgeted exact-mention fallback can repeat the
            // method's signature row; it must not add new ancestor/target lines.
            let shown_lines = rows
                .iter()
                .map(|row| row["line"].as_u64().unwrap())
                .collect::<std::collections::HashSet<_>>();
            assert_eq!(
                shown_lines.len(),
                150,
                "ancestors and target must share the existing allowance: {}",
                out.text
            );
            let owners = if parameters == 180 {
                format!(
                    "function enclosing [1-{}] > binding Holder > anonymous class",
                    source.lines().count()
                )
            } else {
                "function enclosing > binding Holder > anonymous class".into()
            };
            assert!(out.text.contains(&owners), "{}", out.text);
            for expected in [
                "  const Holder = class {",
                "    selectedMethod(",
                "      value: { text: string } = {",
                "        text: 'default',",
                "      },",
                "      suffix: string = '',",
                "    ): string {",
            ] {
                assert!(
                    rows.iter().any(|row| row["text"] == expected),
                    "missing complete selected signature {expected:?}"
                );
            }
            let parameter_rows = rows
                .iter()
                .filter(|row| row["text"].as_str().unwrap().starts_with("  p"))
                .count();
            assert_eq!(
                parameter_rows,
                if parameters == 40 { 40 } else { 0 },
                "ancestor parameters must be complete or explicitly omitted"
            );
            if parameters == 180 {
                assert!(out
                    .text
                    .contains("enclosing function enclosing header omitted"));
            }
            assert!(out.text.contains("remaining target"));
        }
    }
}

#[test]
fn long_binding_type_headers_do_not_hide_the_nearest_initializer_header() {
    let (_dir, path, context) = fixture();
    for type_lines in [10, 180] {
        let mut source = String::from("const Holder:\n");
        for index in 0..type_lines {
            source.push_str(&format!("  Type{index} &\n"));
        }
        source.push_str("  typeof Base\n= class extends Base {\n  selectedMethod(value: string): string { return value; }\n};\n");
        std::fs::write(&path, &source).unwrap();
        let result = symbol::search("selectedMethod", &path, None, None, true).unwrap();
        let declaration = result
            .matches
            .iter()
            .find_map(|matched| matched.declaration.as_ref())
            .unwrap();
        let binding = declaration
            .ancestors()
            .into_iter()
            .find(|region| region.kind == crate::tsjs_source::Kind::Binding)
            .unwrap();
        assert_eq!(
            &source[binding.signature.clone()],
            source.split(" {\n  selectedMethod").next().unwrap()
        );
        assert!(
            source[binding.declaration.clone()].contains("return value;"),
            "the initializer remains in the full declaration"
        );
        for (query, kind) in [("selectedMethod", "symbol"), ("selectedmethod", "auto")] {
            let out = output(query, kind, &context);
            let rows = out.structured["data"]["sourceRows"].as_array().unwrap();
            assert!(rows
                .iter()
                .any(|row| row["text"] == "= class extends Base {"));
            assert!(rows
                .iter()
                .any(|row| row["text"]
                    == "  selectedMethod(value: string): string { return value; }"));
            let owners = if type_lines == 180 {
                format!(
                    "binding Holder [1-{}] > anonymous class",
                    source.lines().count()
                )
            } else {
                "binding Holder > anonymous class".into()
            };
            assert!(out.text.contains(&owners), "{}", out.text);
            let shown_types = rows
                .iter()
                .filter(|row| row["text"].as_str().unwrap().starts_with("  Type"))
                .count();
            assert_eq!(shown_types, if type_lines == 10 { 10 } else { 0 });
            assert!(rows.len() <= 150);
            if type_lines == 180 {
                assert!(out.text.contains("enclosing binding Holder header omitted"));
            }
        }
    }
}

#[test]
fn signature_completion_never_mints_non_signature_allowance() {
    let (_dir, path, _context) = fixture();
    // These are the existing exact and competing-fuzzy card allowances.
    for cap in [150usize, 50] {
        for (parameters, blanks) in [(cap + 1, 0), (2, 180)] {
            let mut source = String::from("/** leading comment */\nexport function enormous(\n");
            source.push_str(&"\n".repeat(blanks));
            for index in 0..parameters {
                source.push_str(&format!("  p{index}: number,\n"));
            }
            source.push_str(") {\n");
            for index in 0..200 {
                source.push_str(&format!("  const body{index} = {index};\n"));
            }
            source.push_str("}\n");
            std::fs::write(&path, &source).unwrap();
            let result = symbol::search("enormous", &path, None, None, true).unwrap();
            let matched = &result.matches[0];
            let mut text = String::new();
            let mut rows = Vec::new();
            let (_, end) = matched.def_range.unwrap();
            crate::search::render_ranked_regions(
                &mut text,
                &mut rows,
                matched,
                &source,
                &[crate::search::RankedRegion { start: 1, end }],
                None,
                cap,
            );
            for index in 0..parameters {
                assert!(
                    rows.iter()
                        .any(|row| row.text == format!("  p{index}: number,")),
                    "missing parameter {index}: {text}"
                );
            }
            let body_rows = rows
                .iter()
                .filter(|row| row.text.contains("const body"))
                .count();
            assert_eq!(
                body_rows,
                cap.saturating_sub(parameters + 2 + 1),
                "blank lines or signature overflow inflated body allowance: {text}"
            );
            assert_eq!(
                rows.iter()
                    .filter(|row| !row.text.trim().is_empty())
                    .count(),
                cap.max(parameters + 2)
            );
            if parameters > cap {
                assert!(!rows.iter().any(|row| row.text.contains("leading comment")));
            }
        }
    }
}

#[test]
fn whole_value_declarations_do_not_receive_signature_allowance() {
    let (_dir, path, _context) = fixture();
    let array = format!("const Large = [\n{}];\n", "  1,\n".repeat(180));
    let fields = (0..180)
        .map(|index| format!("  field{index}: number;\n"))
        .collect::<String>();
    let shape = format!("type Large = {{\n{fields}}};\n");
    let mixed_array = format!(
        "const Large = [\n{}  {{ last: true }},\n];\n",
        "  1,\n".repeat(180)
    );
    let call_arguments = format!(
        "const collectValues = (...values: unknown[]) => values;\nconst Large = collectValues(\n{}  {{ last: true }},\n);\n",
        "  1,\n".repeat(180),
    );
    for source in [array, shape, mixed_array, call_arguments] {
        std::fs::write(&path, &source).unwrap();
        let result = symbol::search("Large", &path, None, None, true).unwrap();
        let matched = &result.matches[0];
        let (start, end) = matched.def_range.unwrap();
        for cap in [150, 50] {
            let mut text = String::new();
            let mut rows = Vec::new();
            crate::search::render_ranked_regions(
                &mut text,
                &mut rows,
                matched,
                &source,
                &[crate::search::RankedRegion { start, end }],
                None,
                cap,
            );
            assert_eq!(rows.len(), cap, "{text}");
            assert!(!text.contains("Signature-only exception"));
        }
    }
}

#[test]
fn seen_source_declarations_keep_all_signature_lines() {
    let (_dir, path, _context) = fixture();
    let mut source = String::from("function remembered(\n");
    for index in 0..12 {
        source.push_str(&format!("  p{index}: number,\n"));
    }
    source.push_str(") {\n  return p0;\n}\n");
    std::fs::write(&path, &source).unwrap();
    let result = symbol::search("remembered", &path, None, None, true).unwrap();
    let matched = &result.matches[0];
    let session = Session::new();
    session.record_expand(
        &path,
        matched.line,
        std::fs::metadata(&path).unwrap().modified().unwrap(),
    );
    let mut text = String::new();
    let mut rows = Vec::new();
    crate::search::render_ranked_regions(
        &mut text,
        &mut rows,
        matched,
        &source,
        &[crate::search::RankedRegion { start: 1, end: 16 }],
        Some(&session),
        150,
    );
    for index in 0..12 {
        assert!(
            rows.iter()
                .any(|row| row.text == format!("  p{index}: number,")),
            "{text}"
        );
    }
    assert!(text.contains("omitted already read this session"));
}

#[test]
fn undisplayable_signatures_are_explicit_not_clipped_or_shared_as_live_source() {
    let (_dir, path, context) = fixture();
    let parameter = "parameter".repeat(140);
    std::fs::write(
        &path,
        format!("class A {{ repeat({parameter}) {{}} }} class B {{ repeat() {{}} }}\n"),
    )
    .unwrap();
    for kind in ["symbol", "auto"] {
        let out = output("repeat", kind, &context);
        assert!(
            out.text.matches("signature undisplayable").count() >= 2,
            "{}",
            out.text
        );
        assert!(!out.text.contains("line clipped"));
        assert!(!out.text.contains("source shared"));
        assert!(out.structured["data"]["sourceRows"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            out.structured["data"]["matches"].as_array().unwrap().len(),
            2
        );
    }
    std::fs::write(&path, format!("function outer({parameter}) {{\n  function inner(value: string) {{ return value; }}\n}}\n")).unwrap();
    let out = output("inner", "symbol", &context);
    assert!(out.text.contains("signature undisplayable"), "{}", out.text);
    assert!(!out.text.contains("line clipped"));
    assert!(out.structured["data"]["sourceRows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["line"] == 2));
}

#[test]
fn usage_and_caller_context_agree_on_immediate_source_callables() {
    let (dir, _path, _context) = fixture();
    let source = "function outer() {\n  items.map(() => {\n    Wanted();\n  });\n  const local = () => {\n    Wanted();\n  };\n  function* nested() {\n    Wanted();\n  }\n}\n";
    for extension in ["ts", "tsx", "js", "jsx"] {
        let path = dir.path().join(format!("callable.{extension}"));
        // Retain original byte offsets, including CRLF and non-ASCII source.
        let source = format!("// 😀\r\n{}", source.replace('\n', "\r\n"));
        std::fs::write(&path, &source).unwrap();
        let cache = OutlineCache::new();
        let targets = ["Wanted".to_string()].into_iter().collect();
        let callers = crate::search::callers::find_callers_batch(
            &targets,
            &path,
            &BloomFilterCache::new(),
            None,
            50,
        )
        .unwrap();
        assert_eq!(callers.len(), 3);
        for (line, name, range) in [
            (4, "<anonymous>", (3, 5)),
            (7, "local", (6, 8)),
            (10, "nested", (9, 11)),
        ] {
            let scope = crate::search::scope::enclosing_definition_at(&path, line, &cache)
                .unwrap()
                .unwrap();
            assert_eq!(
                (scope.kind, scope.name.as_str(), scope.start, scope.end),
                ("function", name, range.0, range.1),
                "{extension}:{line}"
            );
            let caller = &callers
                .iter()
                .find(|(_, caller)| caller.line == line)
                .unwrap()
                .1;
            assert_eq!(
                (caller.calling_function.as_str(), caller.caller_range),
                (name, Some(range)),
                "{extension}:{line}"
            );
            assert_eq!(caller.content.as_str(), source);
        }
    }
}

#[test]
fn mixed_source_rows_keep_occurrences_and_precise_callers_without_selecting_an_owner() {
    let (_dir, path, context) = fixture();
    for (mixed, caller_names) in [
        (
            "function A(){Wanted();} function B(){Wanted();}",
            vec!["A", "B"],
        ),
        (
            "Wanted(); function A(){Wanted();}",
            vec!["<top-level>", "A"],
        ),
        (
            "function A(){Wanted();} function A(){Wanted();}",
            vec!["A", "A"],
        ),
    ] {
        let source =
            format!("function Wanted() {{}}\n{mixed}\nfunction unique() {{\n  Wanted();\n}}\n");
        std::fs::write(&path, &source).unwrap();
        let cache = OutlineCache::new();
        assert!(crate::search::scope::enclosing_definition_at(&path, 2, &cache).is_err());
        assert_eq!(
            crate::search::scope::enclosing_definition_at(&path, 4, &cache)
                .unwrap()
                .unwrap()
                .name,
            "unique"
        );
        let result = symbol::search("Wanted", &path, None, None, true).unwrap();
        let selected = result
            .matches
            .iter()
            .find(|matched| matched.is_definition)
            .unwrap();
        let (mut text, mut rows) = (String::new(), Vec::new());
        crate::search::append_ranked_references(
            &mut text,
            &mut rows,
            &result,
            Some(selected),
            &cache,
            crate::search::FUZZY_CARD_HARD_TOKENS,
        );
        assert!(text.contains(crate::search::scope::MIXED_SCOPES), "{text}");
        assert_eq!(rows.iter().filter(|row| row.line == 2).count(), 1);
        assert!(rows.iter().any(|row| row.line == 2 && row.text == mixed));
        let fuzzy = crate::search::format_fuzzy_result_typed(&result, &cache, None, None).unwrap();
        assert!(
            fuzzy.text.contains(crate::search::scope::MIXED_SCOPES),
            "{}",
            fuzzy.text
        );
        assert!(!fuzzy.text.contains("    top-level"));
        assert_eq!(
            crate::search::enclosing_scope_label(&path, 2, &result.sources).as_deref(),
            Some(crate::search::scope::MIXED_SCOPES)
        );
        assert!(crate::search::outline_context_for_match(&path, 2, &result.sources).is_none());
        assert!(crate::search::find_enclosing_outline_idx(&path, 2, &result.sources).is_none());
        let callers = crate::search::callers::find_callers_batch(
            &["Wanted".into()].into_iter().collect(),
            &path,
            &BloomFilterCache::new(),
            None,
            50,
        )
        .unwrap();
        let mut names = callers
            .iter()
            .filter(|(_, caller)| caller.line == 2)
            .map(|(_, caller)| caller.calling_function.as_str())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, caller_names);
        let op = crate::ops::tool_symbol_range_output(
            &json!({"path": path, "line": 2}),
            &cache,
            Some(&context.root),
        )
        .unwrap();
        assert_eq!(op.structured["data"]["verified"], false);
        assert!(op.text.contains(crate::search::scope::MIXED_SCOPES));
        let named = crate::ops::tool_symbol_range_output(
            &json!({"path": path, "name": "unique"}),
            &cache,
            Some(&context.root),
        )
        .unwrap();
        assert_eq!(named.structured["data"]["found"], true);
        assert_eq!(named.structured["data"]["verified"], true);
        let audit = crate::search::matches::execute(
            &json!({"pattern": "Wanted", "paths": [path], "syntax": "literal", "contextLines": 0}),
            &cache,
            &Session::new(),
            &context,
        )
        .unwrap();
        assert!(
            audit.text.contains(crate::search::scope::MIXED_SCOPES),
            "{}",
            audit.text
        );
        // The declaration, both same-row calls and the unique-owner call remain.
        assert!(audit.text.contains("4 occurrences"), "{}", audit.text);
    }
}

#[test]
fn live_composition_preserves_call_origins_and_source_candidates() {
    let (_dir, path, context) = fixture();
    let cases = [
        ("function left() { return 'left'; }\nfunction right() { return 'right'; }\nexport function first() { return left(); } export function second() { return right(); }\n", "first", "first", "left", 1, false),
        ("function storage() { return 'wrong global'; }\nexport function execute() {\n  function storage() { return 'correct local'; }\n  return storage();\n}\n", "execute", "execute", "storage", 3, false),
        ("function onlyInner() { return 42; }\nexport function idleOuter() {\n  function neverCalled() { return onlyInner(); }\n  return 1;\n}\n", "idleOuter", "neverCalled", "onlyInner", 1, true),
        ("class Decoy { flush() {} }\nclass Actual {\n  flush() {}\n  work() { this.flush(); }\n}\n", "work", "Actual.work", "flush", 3, false),
        ("export function run() {\n  const localArrow = () => 1;\n  return localArrow();\n}\n", "run", "run", "localArrow", 2, false),
        ("function Wanted() {}\nexport const localArrow = () => Wanted();\n", "localArrow", "localArrow", "Wanted", 1, false),
    ];
    for (source, name, owner, candidate, line, nested) in cases {
        std::fs::write(&path, source).unwrap();
        let result = symbol::search(name, &path, None, None, true).unwrap();
        let target = result
            .matches
            .iter()
            .find(|matched| matched.is_definition)
            .unwrap();
        let connections = crate::search::callees::connections(
            &path,
            source,
            Lang::TypeScript,
            target.def_range,
            target.declaration.as_ref(),
            &BloomFilterCache::new(),
            &result.sources,
        );
        assert_eq!(connections.len(), 1, "{name}: {connections:?}");
        let connection = &connections[0];
        assert_eq!(connection.site.owner_name, owner);
        assert_eq!(connection.origin.starts_with("nested"), nested);
        assert_eq!(connection.candidates.len(), 1, "{connection:?}");
        assert_eq!(
            (
                &*connection.candidates[0].name,
                connection.candidates[0].start_line
            ),
            (candidate, line)
        );
        assert!(connection.candidates[0].declaration.is_some());
        if name == "work" {
            assert_eq!(&source[connection.site.expression.clone()], "this.flush()");
            assert_eq!(connection.site.receiver.as_deref(), Some("this"));
        }
        for kind in ["symbol", "auto"] {
            let rendered = output(name, kind, &context);
            assert!(
                rendered.text.contains(connection.origin),
                "{}",
                rendered.text
            );
            assert!(
                !rendered.text.contains("callees — definitions resolved"),
                "{}",
                rendered.text
            );
            assert!(
                !rendered.text.contains("no definition found"),
                "{}",
                rendered.text
            );
            let mut unique = std::collections::HashSet::new();
            for row in rendered.structured["data"]["sourceRows"]
                .as_array()
                .unwrap()
            {
                let line = row["line"].as_u64().unwrap() as usize;
                assert!(
                    unique.insert((row["path"].as_str().unwrap(), line)),
                    "duplicate row: {}",
                    rendered.text
                );
                assert_eq!(row["text"], source.lines().nth(line - 1).unwrap());
                let occurrences = rendered
                    .text
                    .lines()
                    .filter(|rendered_line| {
                        let Some((prefix, text)) = rendered_line.trim_start().split_once(": ")
                        else {
                            return false;
                        };
                        let number = prefix
                            .strip_prefix('[')
                            .and_then(|range| range.split('-').next())
                            .unwrap_or(prefix)
                            .parse::<usize>()
                            .ok();
                        number == Some(line) && text == row["text"].as_str().unwrap()
                    })
                    .count();
                assert_eq!(occurrences, 1, "source must print once: {}", rendered.text);
            }
        }
    }
}

#[test]
fn call_evidence_groups_shared_context_without_losing_sites_or_uncertainty() {
    let (_dir, _, context) = fixture();
    let path = context.root.join("calls.rs");
    let source = "pub fn CaptureValue(value: &mut Vec<String>) {\n    value.len();\n    value.clear();\n    sink(value);\n}\nfn sink(value: &mut Vec<String>) {}\n";
    std::fs::write(&path, source).unwrap();
    let rendered = output("CaptureValue", "symbol", &context);
    let calls = rendered.text.split_once("call evidence —").unwrap().1;
    assert_eq!(calls.matches("  calls.rs:\n").count(), 1, "{calls}");
    assert_eq!(calls.matches("same/imported-name candidates; binding unverified").count(), 1, "{calls}");
    for expression in ["value.len()", "value.clear()", "sink(value)"] {
        assert!(calls.contains(&format!("call \"{expression}\"")), "{calls}");
    }
    assert_eq!(calls.matches("no declaration candidate established").count(), 2, "{calls}");
    assert!(calls.contains("fn sink(value: &mut Vec<String>) {}"), "{calls}");
    let mut unique = std::collections::HashSet::new();
    for row in rendered.structured["data"]["sourceRows"].as_array().unwrap() {
        let line = row["line"].as_u64().unwrap() as usize;
        assert!(unique.insert((row["path"].as_str().unwrap(), line)));
        assert_eq!(row["text"], source.lines().nth(line - 1).unwrap());
    }
}

#[test]
fn same_row_lanes_keep_distinct_targets_and_real_recursive_sites() {
    let (_dir, path, context) = fixture();
    let source = "function left() {}\nfunction right() {}\nclass First { repeat() { left(); } } class Second { repeat() { right(); } }\n";
    std::fs::write(&path, source).unwrap();
    let result = symbol::search("repeat", &path, None, None, true).unwrap();
    let targets = result
        .matches
        .iter()
        .filter(|matched| matched.is_definition)
        .collect::<Vec<_>>();
    assert_eq!(targets.len(), 2);
    let lanes = crate::search::lanes::collect(
        &targets,
        &result,
        &BloomFilterCache::new(),
        crate::walk::Visibility::Project,
        &[],
        &context,
    )
    .unwrap();
    let mut callees = targets
        .iter()
        .map(|target| {
            let connections = &lanes.get(target).unwrap().connections;
            assert_eq!(connections.len(), 1);
            (
                connections[0].site.owner_name.clone(),
                connections[0].candidates[0].name.clone(),
            )
        })
        .collect::<Vec<_>>();
    callees.sort();
    assert_eq!(
        callees,
        [
            ("First.repeat".into(), "left".into()),
            ("Second.repeat".into(), "right".into())
        ]
    );
    for kind in ["symbol", "auto"] {
        let rendered = output("repeat", kind, &context);
        assert_eq!(
            rendered
                .text
                .matches(source.lines().nth(2).unwrap())
                .count(),
            1,
            "{}",
            rendered.text
        );
    }

    let source = "export function Wanted() {} function Caller() { Wanted(); }\n";
    std::fs::write(&path, source).unwrap();
    let rendered = output("Wanted", "symbol", &context);
    assert!(
        rendered.text.contains("Caller [1]: call"),
        "{}",
        rendered.text
    );
    assert!(!rendered.text.contains("callers: no name/alias"));
    assert!(
        !rendered.text.contains("call evidence —"),
        "Wanted has no outgoing call: {}",
        rendered.text
    );
    assert_eq!(
        rendered.text.matches(source.trim_end()).count(),
        1,
        "{}",
        rendered.text
    );

    let source =
        "export function recur(n: number) { if (n > 1) { recur(n - 1); recur(n - 2); } }\n";
    std::fs::write(&path, source).unwrap();
    let raw = crate::search::callers::find_callers_batch(
        &std::collections::HashSet::from(["recur".into()]),
        &context.root,
        &BloomFilterCache::new(),
        None,
        50,
    )
    .unwrap();
    assert_eq!(raw.len(), 2);
    assert_ne!(
        raw[0].1.site.as_ref().unwrap().expression,
        raw[1].1.site.as_ref().unwrap().expression
    );
    assert_eq!(
        crate::search::callers::merge_caller_rows(raw.clone(), raw).len(),
        2
    );
    let rendered = output("recur", "symbol", &context);
    assert!(!rendered.text.contains("callers: no name/alias"));
    assert!(rendered.text.contains("call evidence — direct origin"));
    for expression in ["recur(n - 1)", "recur(n - 2)"] {
        let column = source.find(expression).unwrap() + 1;
        assert!(
            rendered
                .text
                .contains(&format!("{expression}\" at 1:{column}")),
            "{}",
            rendered.text
        );
    }
    assert_eq!(
        rendered.text.matches(source.trim_end()).count(),
        1,
        "{}",
        rendered.text
    );

    let result = symbol::search("recur", &path, None, None, true).unwrap();
    let target = result
        .matches
        .iter()
        .find(|matched| matched.is_definition)
        .unwrap();
    let first = crate::search::callees::connections(
        &path,
        source,
        Lang::TypeScript,
        target.def_range,
        target.declaration.as_ref(),
        &BloomFilterCache::new(),
        &result.sources,
    );
    let second = crate::search::callees::candidate_connections(
        first
            .into_iter()
            .flat_map(|connection| connection.candidates)
            .collect(),
        &BloomFilterCache::new(),
        &result.sources,
        15,
    );
    assert_eq!(second.len(), 1);
    assert_eq!(
        second[0].calls.len(),
        2,
        "second-hop recursion and distinct sites must survive"
    );
    for expand in [0, 1] {
        let text = crate::search::callers::search_callers_expanded(
            "recur",
            &context.root,
            &BloomFilterCache::new(),
            expand,
            None,
            None,
            false,
        )
        .unwrap();
        assert_eq!(
            text.matches(source.trim_end()).count(),
            1,
            "standalone caller source must also print once: {text}"
        );
        assert_eq!(text.matches("[caller: recur]").count(), 2);
        for expression in ["recur(n - 1)", "recur(n - 2)"] {
            let column = source.find(expression).unwrap() + 1;
            assert!(
                text.contains(&format!("{expression}\" at 1:{column}")),
                "{text}"
            );
        }
    }

    let source = "function Wanted() {} function Caller() { Wanted(); } function Entry() { Caller(); Caller(); }\n";
    std::fs::write(&path, source).unwrap();
    let text = crate::search::callers::search_callers_expanded(
        "Wanted",
        &context.root,
        &BloomFilterCache::new(),
        0,
        None,
        None,
        false,
    )
    .unwrap();
    assert_eq!(
        text.matches("Entry [1]: call \"Caller()\"").count(),
        2,
        "same-row second-hop sites must survive: {text}"
    );
    assert_eq!(text.matches(source.trim_end()).count(), 1);
    assert!(text.contains("2 additional second-hop call candidates"));
    assert!(!text.contains("functions affected"));
    let names = std::collections::HashSet::from(["Wanted".into(), "Caller".into()]);
    let raw = crate::search::callers::find_callers_batch(
        &names,
        &context.root,
        &BloomFilterCache::new(),
        None,
        50,
    )
    .unwrap();
    let batch = crate::search::callers::render_callers_batch(
        &["Wanted".into(), "Caller".into()],
        raw,
        &context.root,
        &BloomFilterCache::new(),
        1,
        None,
        None,
        None,
        10,
        50,
    );
    assert_eq!(batch.displayed.len(), 3);
    assert_eq!(
        batch.text.matches(source.trim_end()).count(),
        1,
        "source shared across caller target buckets must print once: {}",
        batch.text
    );

    let source = format!(
        "function decoy() {{}} function actual(\n  value: number,\n) {{\n{}  Wanted();\n}}\n",
        "  value += 1;\n".repeat(30)
    );
    std::fs::write(&path, &source).unwrap();
    let callers = crate::search::callers::find_callers_batch(
        &std::collections::HashSet::from(["Wanted".into()]),
        &context.root,
        &BloomFilterCache::new(),
        None,
        50,
    )
    .unwrap();
    assert_eq!(callers.len(), 1);
    let (text, _) = crate::search::caller_lane_block(&[&callers[0].1], None, false, &[]);
    assert!(
        text.contains("2:   value: number,\n3: ) {"),
        "same-row decoy must not replace the actual caller signature: {text}"
    );

    let imported = path.parent().unwrap().join("api.ts");
    std::fs::write(&imported, "export function request() {}\n").unwrap();
    let source = "import * as api from './api';\nfunction request() {}\nexport function execute() { api.request(); }\n";
    std::fs::write(&path, source).unwrap();
    let result = symbol::search("execute", &path, None, None, true).unwrap();
    let target = result
        .matches
        .iter()
        .find(|matched| matched.is_definition)
        .unwrap();
    let connections = crate::search::callees::connections(
        &path,
        source,
        Lang::TypeScript,
        target.def_range,
        target.declaration.as_ref(),
        &BloomFilterCache::new(),
        &result.sources,
    );
    assert_eq!(connections.len(), 1);
    assert_eq!(connections[0].site.receiver.as_deref(), Some("api"));
    assert_eq!(
        connections[0].candidates.len(),
        2,
        "unknown receiver keeps local and imported alternatives: {:?}",
        connections[0]
    );
    assert!(connections[0]
        .candidates
        .iter()
        .any(|candidate| candidate.file == imported));
    assert!(result.sources.retained_text(&imported).is_some());
}

#[test]
fn class_inventory_keeps_headers_without_extra_body_allowance() {
    let (_dir, path, context) = fixture();
    let verify_inventory = |source: &str, headers: Vec<Vec<usize>>| {
        let expected = headers.iter().flatten().copied().collect::<std::collections::HashSet<_>>();
        let cache = OutlineCache::new();
        let session = Session::new();
        let bloom = Arc::new(BloomFilterCache::new());
        let call = |args: serde_json::Value| crate::ops::tool_search_output(&args, &cache, &session, &bloom, &context).unwrap();
        let mut rendered = call(json!({"query":"Inventory", "kind":"symbol", "scope":context.root,
            "root":context.root, "budget":12000, "retainRankedRender":true}));
        let mut delivered = std::collections::HashSet::new();
        let mut cursors = std::collections::HashSet::new();
        for page in 0..10 {
            let rows = rendered.structured["data"]["sourceRows"].as_array().unwrap();
            let shown = rows.iter().map(|row| row["line"].as_u64().unwrap() as usize).collect::<std::collections::HashSet<_>>();
            assert_eq!(rows.len(), shown.len(), "duplicate physical row on page {page}");
            assert!(rows.iter().filter(|row| !row["text"].as_str().unwrap().trim().is_empty()).count() <= 150,
                "inventory paging cannot enlarge a page's nonblank allowance: {}", rendered.text);
            for header in &headers {
                if header.iter().any(|line| shown.contains(line)) {
                    assert!(header.iter().all(|line| shown.contains(line)), "split header {header:?} on page {page}: {}", rendered.text);
                }
            }
            for row in rows {
                assert_eq!(context.root.join(row["path"].as_str().unwrap()), path);
                let text = row["text"].as_str().unwrap();
                assert!(!text.contains("BODY_NOT_GRANTED") && !text.contains("987654321"),
                    "inventory must not grant multiline initializer/body rows: {}", rendered.text);
                assert_eq!(text, source.lines().nth(row["line"].as_u64().unwrap() as usize - 1).unwrap());
            }
            if source.starts_with("namespace A") {
                for name in ["namespace A", "namespace B", "namespace C"] {
                    assert!(rendered.text.contains(name), "lost enclosing identity {name}: {}", rendered.text);
                }
            }
            assert!(expected.intersection(&shown).any(|line| !delivered.contains(line)), "inventory stalled: {}", rendered.text);
            delivered.extend(shown);
            if expected.is_subset(&delivered) { break; }
            let cursor = rendered.structured["data"]["cursor"].as_str().expect("missing headers need a retained cursor").to_owned();
            assert!(cursors.insert(cursor.clone()), "cursor did not advance");
            rendered = call(json!({"cursor":cursor, "retainRankedRender":true}));
        }
        assert!(expected.is_subset(&delivered), "inventory retired before every expected header was delivered");
    };
    for prefix in [
        "export class Inventory {",
        "export const Inventory = class {",
        "export const Inventory = (class {",
    ] {
        let fields = (0..151)
            .map(|i| format!("  field{i}: number = {i};\n"))
            .collect::<String>();
        let close = if prefix.contains("(class") { ")" } else { "" };
        let source = format!("{prefix}\n  pending;\n{fields}  values: number[] = [\n{}  ];\n  work(\n    value: string,\n  ): string {{\n    return 'BODY_NOT_GRANTED';\n  }}\n  callback = (\n    value: number,\n  ): number => {{\n    return 987654321;\n  }};\n}}{close}\n", "    987654321,\n".repeat(180));
        std::fs::write(&path, &source).unwrap();
        // Expected spans come from this fixture's known declaration shapes, not
        // the renderer's inventory. A complete inventory may span multiple pages.
        let headers = source.lines().enumerate().filter_map(|(offset, line)| {
            let start = offset + 1;
            if line.contains("work(") || line.contains("callback = (") {
                Some((start..=start + 2).collect::<Vec<_>>())
            } else if line.contains("pending;") || line.contains("field") || line.contains("values:") {
                Some(vec![start])
            } else { None }
        }).collect();
        verify_inventory(&source, headers);
    }
    // Enclosing namespace identities and complete member headers survive without
    // increasing any page's allowance; ancestor context cannot retire late members.
    let fields = (0..148)
        .map(|i| format!("  field{i}: number;\n"))
        .collect::<String>();
    let source = format!("namespace A {{\nnamespace B {{\nnamespace C {{\nclass Inventory {{\n{fields}}}\n}}\n}}\n}}\n");
    std::fs::write(&path, &source).unwrap();
    verify_inventory(&source, (5..=152).map(|line| vec![line]).collect());
    let source = format!("class Inventory {{\n  work(\n    value: {},\n  ) {{\n    return 'UNDISPLAYABLE_MEMBER_BODY';\n  }}\n}}\n", "A".repeat(1_100));
    std::fs::write(&path, &source).unwrap();
    let rendered = output("Inventory", "symbol", &context);
    assert!(!rendered.text.contains("line clipped"), "{}", rendered.text);
    assert!(
        !rendered.text.contains("UNDISPLAYABLE_MEMBER_BODY"),
        "{}",
        rendered.text
    );
    assert!(rendered.text.contains("undisplayable"), "{}", rendered.text);

    std::fs::write(&path, "class Inventory { first() {} second() {} }\n").unwrap();
    let rendered = output("Inventory", "symbol", &context);
    assert!(
        rendered.text.contains("first at 1:19") && rendered.text.contains("second at 1:30"),
        "same-row members retain distinct source positions: {}",
        rendered.text
    );
    let source = format!(
        "class Inventory {{\n  bad(\n    value: {}\n  ) {{}} good() {{}}\n}}\n",
        "A".repeat(1_100)
    );
    std::fs::write(&path, &source).unwrap();
    let rendered = output("Inventory", "symbol", &context);
    assert!(
        rendered.text.contains("4:   ) {} good() {}"),
        "a refused member cannot remove a neighboring valid declaration: {}",
        rendered.text
    );
    assert!(rendered.text.contains("good at 4:8"), "{}", rendered.text);
    assert!(rendered.text.contains("undisplayable"), "{}", rendered.text);

    std::fs::write(&path, "class Inventory { static { initialize(); } }\n").unwrap();
    let rendered = output("Inventory", "symbol", &context);
    assert!(
        rendered
            .text
            .contains("Class declaration inventory unavailable"),
        "unsupported members cannot become a false complete inventory: {}",
        rendered.text
    );
}

#[test]
fn refused_competing_class_does_not_record_expansion() {
    let (_dir, path, context) = fixture();
    let parameters = (0..151)
        .map(|i| format!("  p{i}_{}: string,\n", "a".repeat(75)))
        .collect::<String>();
    let body = (0..12)
        .map(|i| format!("    const fill{i} = '{}';\n", "b".repeat(170)))
        .collect::<String>();
    let source = format!("function DenseFunction(\n{parameters}) {{}}\nclass DenseClass {{\n  work() {{\n{body}    return 'NOT_PREVIOUSLY_SHOWN';\n  }}\n}}\n");
    std::fs::write(&path, &source).unwrap();
    let mut result = fuzzy::search(
        "dense",
        &path,
        &[],
        crate::walk::Visibility::Project,
        Arc::new(OperationSources::default()),
        &context,
    )
    .unwrap()
    .result;
    result.matches.retain(|matched| {
        matches!(
            matched.def_name.as_deref(),
            Some("DenseFunction" | "DenseClass")
        )
    });
    result.matches.sort_by_key(|matched| matched.line);
    assert_eq!(result.matches.len(), 2);
    let class = result.matches[1].clone();
    let session = Session::new();
    let rendered = crate::search::format_fuzzy_result_typed(
        &result,
        &OutlineCache::new(),
        Some(&session),
        None,
    )
    .unwrap();
    assert!(
        rendered.text.contains("class inventory omitted for budget"),
        "{}",
        rendered.text
    );
    let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
    assert!(
        !session.is_expanded(&path, class.line, mtime),
        "withheld class cannot become already shown"
    );
    result.matches = vec![class];
    let shown = crate::search::format_fuzzy_result_typed(
        &result,
        &OutlineCache::new(),
        Some(&session),
        None,
    )
    .unwrap();
    assert!(
        shown.text.contains("NOT_PREVIOUSLY_SHOWN"),
        "{}",
        shown.text
    );
}
