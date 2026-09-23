//! Navigation projection of the maintained TS/JS source facts, not an outliner
//! or resolver. Every match keeps its file-local identity and lexical ancestry.
use std::ops::Range;
use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

use crate::tsjs_source::{self as source, Facts, Kind, Region};
use crate::types::{Lang, Match, OutlineKind};

#[derive(Clone, Debug)]
pub(crate) struct Declaration {
    facts: Arc<Facts>,
    index: usize,
}

pub(crate) fn supports(lang: Lang) -> bool {
    matches!(lang, Lang::TypeScript | Lang::Tsx | Lang::JavaScript)
}

pub(crate) fn collect(root: tree_sitter::Node, content: &str) -> Vec<Declaration> {
    from_facts(Arc::new(source::collect(root, content)))
}

pub(crate) fn from_facts(facts: Arc<Facts>) -> Vec<Declaration> {
    (0..facts.regions.len())
        .filter(|&index| facts.regions[index].name.is_some())
        .map(|index| Declaration {
            facts: facts.clone(),
            index,
        })
        .collect()
}

impl Declaration {
    pub(crate) fn region(&self) -> &Region {
        &self.facts.regions[self.index]
    }

    pub(crate) fn facts(&self) -> &Facts {
        &self.facts
    }

    pub(crate) fn file_declarations(&self) -> Vec<Self> {
        from_facts(self.facts.clone())
    }

    pub(crate) fn key(&self) -> (usize, usize, &str) {
        let id = &self.region().id;
        (id.bytes.start, id.bytes.end, &id.syntax_kind)
    }

    pub(crate) fn partial_file(&self) -> bool {
        !self.facts.diagnostics.is_empty()
    }

    /// The binding and class must share the parser-owned immediate body, even
    /// through transparent wrappers; a class inside a call/array is not the value.
    pub(crate) fn class_region(&self) -> Option<&Region> {
        if self.region().kind == Kind::Class {
            Some(self.region())
        } else if self.region().kind == Kind::Binding {
            self.facts.regions.iter().find(|region| {
                region.kind == Kind::Class
                    && region.parent.as_ref() == Some(&self.region().id)
                    && region.body.is_some()
                    && region.body == self.region().body
            })
        } else {
            None
        }
    }

    /// Complete class/member headers with their full source ranges. Values do
    /// not become headers merely because the source fact has no immediate body.
    /// Parse once for field value boundaries absent from the existing carrier.
    pub(crate) fn class_inventory(
        &self,
        content: &str,
        lang: Lang,
    ) -> Option<Vec<(Self, Range<usize>)>> {
        let class = self.class_region()?;
        let language = crate::lang::outline::outline_language(lang)?;
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language).ok()?;
        let tree = parser.parse(content, None)?;
        let mut headers = vec![(self.clone(), self.region().signature.clone())];
        for (index, member) in self.facts.regions.iter().enumerate().filter(|(_, region)| {
            region.parent.as_ref() == Some(&class.id)
                && matches!(
                    region.kind,
                    Kind::Method | Kind::MethodSignature | Kind::Field | Kind::PropertySignature
                )
        }) {
            let mut signature = member.signature.clone();
            if member.kind == Kind::Field && member.body.is_none() {
                let mut node = tree.root_node().descendant_for_byte_range(
                    member.id.bytes.start,
                    member.id.bytes.end.saturating_sub(1),
                )?;
                while source::identity(node) != member.id {
                    node = node.parent()?;
                }
                if let Some(value) = node.child_by_field_name("value") {
                    signature.end = signature.start
                        + content[signature.start..value.start_byte()]
                            .trim_end()
                            .len();
                }
            }
            headers.push((
                Self {
                    facts: self.facts.clone(),
                    index,
                },
                signature,
            ));
        }
        // An unclassified class member (for example a static block) must not
        // disappear behind a claim that this declaration inventory is complete.
        let mut class_node = tree.root_node().descendant_for_byte_range(
            class.id.bytes.start,
            class.id.bytes.end.saturating_sub(1),
        )?;
        while source::identity(class_node) != class.id {
            class_node = class_node.parent()?;
        }
        let body = class_node.child_by_field_name("body")?;
        let mut cursor = body.walk();
        for child in body
            .named_children(&mut cursor)
            .filter(|child| !child.is_extra())
        {
            let id = source::identity(child);
            if !headers
                .iter()
                .skip(1)
                .any(|(member, _)| member.region().id == id)
            {
                return None;
            }
        }
        Some(headers)
    }

    /// Existing session expansion keys have no column/span. They are usable
    /// only when this source declaration alone owns its start line.
    pub(crate) fn has_unique_start_line(&self, content: &str) -> bool {
        let start = line_at(content, self.region().declaration.start);
        !self.facts.regions.iter().any(|region| {
            region.id != self.region().id && line_at(content, region.declaration.start) == start
        })
    }

    pub(crate) fn siblings(&self) -> impl Iterator<Item = &Region> {
        self.facts.regions.iter().filter(|region| {
            region.id != self.region().id
                && region.parent == self.region().parent
                && region.name.is_some()
        })
    }

    pub(crate) fn ancestors(&self) -> Vec<&Region> {
        let mut ancestors = Vec::new();
        let mut parent = self.region().parent.as_ref();
        while let Some(id) = parent {
            let Some(region) = self.facts.regions.iter().find(|region| &region.id == id) else {
                break;
            };
            ancestors.push(region);
            parent = region.parent.as_ref();
        }
        ancestors.reverse();
        ancestors
    }

    /// An initializer container has its own header even when its declaration
    /// envelope also includes a long binding/type header. Keep both regions;
    /// let the renderer admit each complete header against the same allowance.
    pub(crate) fn hierarchy_signature(region: &Region) -> Range<usize> {
        if matches!(region.id.syntax_kind.as_str(), "class" | "object") {
            region.id.bytes.start..region.signature.end.max(region.id.bytes.start)
        } else {
            region.signature.clone()
        }
    }

    /// Name terms are retrieval fields, not a qualified semantic identity.
    /// Anonymous containers remain explicit in the separately rendered hierarchy.
    pub(crate) fn name_terms(&self) -> String {
        self.ancestors()
            .into_iter()
            .chain(std::iter::once(self.region()))
            .filter_map(|region| region.name.as_deref())
            .collect::<Vec<_>>()
            .join("::")
    }

    pub(crate) fn outline_kind(&self) -> OutlineKind {
        match self.region().kind {
            Kind::Function | Kind::Method | Kind::MethodSignature => OutlineKind::Function,
            Kind::Class => OutlineKind::Class,
            Kind::Interface => OutlineKind::Interface,
            Kind::Enum => OutlineKind::Enum,
            Kind::TypeAlias => OutlineKind::TypeAlias,
            Kind::Namespace => OutlineKind::Module,
            Kind::Field | Kind::PropertySignature => OutlineKind::Property,
            _ => OutlineKind::Variable,
        }
    }

    pub(crate) fn weight(&self) -> u16 {
        let region = self.region();
        let kind = match region.kind {
            Kind::Binding => "lexical_declaration",
            Kind::Function if region.id.syntax_kind == "arrow_function" => "lexical_declaration",
            Kind::Function if region.id.syntax_kind == "generator_function_declaration" => {
                "function_declaration"
            }
            Kind::Namespace => "namespace_definition",
            Kind::Field | Kind::PropertySignature => "property_declaration",
            _ => region.id.syntax_kind.as_str(),
        };
        crate::lang::treesitter::definition_weight(kind)
    }

    pub(crate) fn context_start(&self, content: &str) -> u32 {
        let region = self.region();
        line_at(
            content,
            region
                .comments
                .first()
                .map_or(region.declaration.start, |range| range.start),
        )
    }

    pub(crate) fn position(&self, content: &str) -> String {
        let byte = self.region().id.bytes.start;
        let row_start = content[..byte].rfind('\n').map_or(0, |index| index + 1);
        // Human-facing columns count Unicode scalar values; metadata owns bytes.
        format!(
            "{}:{}",
            line_at(content, byte),
            content[row_start..byte].chars().count() + 1
        )
    }

    pub(crate) fn to_match(
        &self,
        path: &Path,
        content: &str,
        file_lines: u32,
        mtime: SystemTime,
    ) -> Match {
        let range = lines_for(content, &self.region().declaration);
        Match {
            path: path.to_path_buf(),
            line: range.0,
            text: content
                .lines()
                .nth(range.0.saturating_sub(1) as usize)
                .unwrap_or_default()
                .to_string(),
            is_definition: true,
            exact: true,
            file_lines,
            mtime,
            def_range: Some(range),
            def_name: self.region().name.clone(),
            def_weight: self.weight(),
            impl_target: None,
            source_association: None,
            declaration: Some(self.clone()),
        }
    }
}

pub(crate) fn line_at(content: &str, byte: usize) -> u32 {
    content.as_bytes()[..byte]
        .iter()
        .filter(|&&byte| byte == b'\n')
        .count() as u32
        + 1
}

pub(crate) fn lines_for(content: &str, span: &Range<usize>) -> (u32, u32) {
    (
        line_at(content, span.start),
        line_at(content, span.end.saturating_sub(1).max(span.start)),
    )
}

pub(crate) fn label(region: &Region) -> String {
    let kind = match region.kind {
        Kind::Function => "function",
        Kind::Method => "method",
        Kind::Class => "class",
        Kind::Namespace => "namespace",
        Kind::Object => "object",
        Kind::Binding => "binding",
        Kind::Interface => "interface",
        Kind::Enum => "enum",
        Kind::TypeAlias => "type",
        Kind::Field | Kind::PropertySignature => "property",
        Kind::MethodSignature => "signature",
        Kind::VariableStatement => "declaration",
    };
    region.name.as_ref().map_or_else(
        || format!("anonymous {kind}"),
        |name| format!("{kind} {name}"),
    )
}

#[cfg(test)]
mod tests;
