//! Live Markdown structure and smart-outline rendering via tree-sitter-md.

use std::collections::HashMap;

use serde::Serialize;

use crate::lang::outline::{heading_level, heading_text, parse_markdown};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownSection {
    pub selector: String,
    pub title: String,
    pub level: u8,
    pub parent: Option<String>,
    pub children: Vec<String>,
    pub heading_start_byte: usize,
    pub heading_end_byte: usize,
    pub heading_start_line: u32,
    pub heading_end_line: u32,
    pub own_end_byte: usize,
    pub own_end_line: u32,
    pub subtree_end_byte: usize,
    pub subtree_end_line: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownStructure {
    pub total_lines: u32,
    pub code_block_count: u32,
    pub sections: Vec<MarkdownSection>,
}

#[derive(Clone, Debug)]
struct Heading {
    title: String,
    level: u8,
    start_byte: usize,
    end_byte: usize,
    start_line: u32,
    end_line: u32,
}

#[must_use]
pub fn structure(content: &str) -> Option<MarkdownStructure> {
    let tree = parse_markdown(content)?;
    let lines: Vec<&str> = content.lines().collect();
    let mut headings = Vec::new();
    let mut code_block_count = 0;
    collect_headings(
        tree.root_node(),
        &lines,
        &mut headings,
        &mut code_block_count,
    );
    headings.sort_by_key(|heading| heading.start_byte);
    headings.dedup_by_key(|heading| heading.start_byte);

    let total_lines = lines.len() as u32;
    let mut sections: Vec<MarkdownSection> = Vec::with_capacity(headings.len());
    let mut parents = Vec::with_capacity(headings.len());
    let mut stack: Vec<usize> = Vec::new();
    let mut used_slugs = HashMap::new();

    for (index, heading) in headings.iter().enumerate() {
        while stack
            .last()
            .is_some_and(|parent| headings[*parent].level >= heading.level)
        {
            stack.pop();
        }
        let parent_index = stack.last().copied();
        let parent_slug = parent_index.map_or("", |parent| {
            sections[parent].selector.split('#').next().unwrap_or("")
        });
        let leaf = slugify(&heading.title);
        let desired = if parent_slug.is_empty() {
            leaf
        } else {
            format!("{parent_slug}/{leaf}")
        };
        let slug_path = unique_slug(desired, &mut used_slugs);
        let selector = format!("{slug_path}#{}", heading.level);

        let own_end_index = index + 1;
        let own_end_byte = headings
            .get(own_end_index)
            .map_or(content.len(), |next| next.start_byte);
        let own_end_line = headings
            .get(own_end_index)
            .map_or(total_lines, |next| next.start_line.saturating_sub(1));
        let subtree_end = headings[index + 1..]
            .iter()
            .find(|next| next.level <= heading.level);
        let subtree_end_byte = subtree_end.map_or(content.len(), |next| next.start_byte);
        let subtree_end_line =
            subtree_end.map_or(total_lines, |next| next.start_line.saturating_sub(1));

        sections.push(MarkdownSection {
            selector,
            title: heading.title.clone(),
            level: heading.level,
            parent: None,
            children: Vec::new(),
            heading_start_byte: heading.start_byte,
            heading_end_byte: heading.end_byte,
            heading_start_line: heading.start_line,
            heading_end_line: heading.end_line,
            own_end_byte,
            own_end_line,
            subtree_end_byte,
            subtree_end_line,
        });
        parents.push(parent_index);
        stack.push(index);
    }

    for (index, parent_index) in parents.into_iter().enumerate() {
        if let Some(parent_index) = parent_index {
            let parent_selector = sections[parent_index].selector.clone();
            let child_selector = sections[index].selector.clone();
            sections[index].parent = Some(parent_selector);
            sections[parent_index].children.push(child_selector);
        }
    }

    Some(MarkdownStructure {
        total_lines,
        code_block_count,
        sections,
    })
}

#[must_use]
pub fn owner_at_byte(
    structure: &MarkdownStructure,
    byte_offset: usize,
) -> Option<&MarkdownSection> {
    structure
        .sections
        .iter()
        .filter(|section| {
            section.heading_start_byte <= byte_offset && byte_offset < section.subtree_end_byte
        })
        .max_by_key(|section| (section.level, section.heading_start_byte))
}

#[must_use]
pub fn section_by_selector<'a>(
    structure: &'a MarkdownStructure,
    selector: &str,
) -> Option<&'a MarkdownSection> {
    structure
        .sections
        .iter()
        .find(|section| section.selector == selector)
}

#[must_use]
pub fn outline(buf: &[u8], max_lines: usize) -> String {
    let Ok(content) = std::str::from_utf8(buf) else {
        return String::new();
    };
    let Some(structure) = structure(content) else {
        return String::new();
    };
    let mut entries = structure
        .sections
        .iter()
        .take(max_lines)
        .map(|section| {
            let indent = "  ".repeat(usize::from(section.level.saturating_sub(1)));
            let hashes = "#".repeat(usize::from(section.level));
            let title = if section.title.len() > 80 {
                format!("{}...", crate::types::truncate_str(&section.title, 77))
            } else {
                section.title.clone()
            };
            format!(
                "[{}-{}] {indent}{hashes} {title}",
                section.heading_start_line, section.subtree_end_line
            )
        })
        .collect::<Vec<_>>();
    if structure.code_block_count > 0 && entries.len() < max_lines {
        entries.push(format!("\n({} code blocks)", structure.code_block_count));
    }
    entries.join("\n")
}

fn collect_headings(
    node: tree_sitter::Node,
    lines: &[&str],
    headings: &mut Vec<Heading>,
    code_block_count: &mut u32,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "atx_heading" | "setext_heading" => {
                if let Some(level) = heading_level(child) {
                    let mut title = heading_text(child, lines);
                    if title.is_empty() && child.kind() == "setext_heading" {
                        let start = child.start_position().row;
                        let end = child.end_position().row.min(lines.len().saturating_sub(1));
                        title = lines[start..=end]
                            .iter()
                            .map(|line| line.trim())
                            .take_while(|line| {
                                !line.chars().all(|character| matches!(character, '=' | '-'))
                            })
                            .filter(|line| !line.is_empty())
                            .collect::<Vec<_>>()
                            .join(" ");
                    }
                    headings.push(Heading {
                        title,
                        level,
                        start_byte: child.start_byte(),
                        end_byte: child.end_byte(),
                        start_line: child.start_position().row as u32 + 1,
                        end_line: inclusive_end_line(child),
                    });
                }
            }
            "fenced_code_block" => *code_block_count += 1,
            _ => collect_headings(child, lines, headings, code_block_count),
        }
    }
}

fn inclusive_end_line(node: tree_sitter::Node) -> u32 {
    let end = node.end_position();
    if end.column == 0 {
        end.row as u32
    } else {
        end.row as u32 + 1
    }
}

fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in title.trim().to_lowercase().chars() {
        if character.is_alphanumeric() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            separator = false;
            slug.push(character);
        } else if character.is_whitespace() || matches!(character, '_' | '-') {
            separator = true;
        }
    }
    if slug.is_empty() {
        "section".to_string()
    } else {
        slug
    }
}

fn unique_slug(desired: String, used: &mut HashMap<String, u32>) -> String {
    let Some(current) = used.get(&desired).copied() else {
        used.insert(desired.clone(), 1);
        return desired;
    };
    let mut count = current + 1;
    used.insert(desired.clone(), count);
    loop {
        let candidate = format!("{desired}-{count}");
        if !used.contains_key(&candidate) {
            used.insert(candidate.clone(), 1);
            return candidate;
        }
        count += 1;
        used.insert(desired.clone(), count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_nested_ranges_and_ownership() {
        let input = "# A\ntext\n## B\nchild\n## C\nmore\n# D\nlast\n";
        let structure = structure(input).unwrap();
        assert_eq!(structure.sections.len(), 4);
        assert_eq!(structure.sections[0].selector, "a#1");
        assert_eq!(structure.sections[0].subtree_end_line, 6);
        assert_eq!(structure.sections[1].parent.as_deref(), Some("a#1"));
        assert_eq!(structure.sections[0].children, ["a/b#2", "a/c#2"]);
        let owner = owner_at_byte(&structure, input.find("child").unwrap()).unwrap();
        assert_eq!(owner.selector, "a/b#2");
        assert_eq!(
            outline(input.as_bytes(), 100).lines().next(),
            Some("[1-6] # A")
        );
    }

    #[test]
    fn includes_setext_and_ignores_fenced_fake_headings() {
        let input = "Top\n===\n\n```python\n# fake\n```\n\nReal child\n----------\nbody\n";
        let structure = structure(input).unwrap();
        assert_eq!(structure.code_block_count, 1);
        assert_eq!(structure.sections.len(), 2);
        assert_eq!(structure.sections[0].selector, "top#1");
        assert_eq!(structure.sections[1].selector, "top/real-child#2");
    }

    #[test]
    fn disambiguates_duplicate_hierarchical_slugs() {
        let structure = structure("# Root\n## Example\na\n## Example\nb\n").unwrap();
        assert_eq!(structure.sections[1].selector, "root/example#2");
        assert_eq!(structure.sections[2].selector, "root/example-2#2");
        assert!(section_by_selector(&structure, "root/example-2#2").is_some());
    }

    #[test]
    fn handles_unicode_and_crlf_byte_positions() {
        let input = "# Résumé\r\nαβγ\r\n## Niño\r\nanswer\r\n";
        let structure = structure(input).unwrap();
        let offset = input.find("answer").unwrap();
        let owner = owner_at_byte(&structure, offset).unwrap();
        assert_eq!(owner.selector, "résumé/niño#2");
        assert_eq!(owner.heading_start_line, 3);
    }

    #[test]
    fn empty_file_has_no_sections() {
        let structure = structure("").unwrap();
        assert!(structure.sections.is_empty());
        assert_eq!(structure.total_lines, 0);
        assert_eq!(outline(b"", 100), "");
    }
}
