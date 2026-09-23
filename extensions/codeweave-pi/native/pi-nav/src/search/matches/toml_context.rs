//! Optional TOML context over the same raw snapshot that produced Matches.
use std::ops::Range;

use toml::de::{DeTable, DeValue};

use super::{MAX_RENDERED_LINE_BYTES, OwnerRegion, RawMatchedLine};

pub(super) struct TomlContext {
    line_starts: Vec<usize>,
    regions: Vec<(Range<usize>, OwnerRegion)>,
}

impl TomlContext {
    pub(super) fn parse(source: &str) -> Option<Self> {
        // Recovery can invent structure for malformed input; exact hits need no parser.
        let table = DeTable::parse(source).ok()?;
        let mut context = Self {
            line_starts: std::iter::once(0)
                .chain(source.match_indices('\n').map(|(offset, _)| offset + 1))
                .collect(),
            regions: Vec::new(),
        };
        context.table(table.get_ref(), "");
        Some(context)
    }

    fn table(&mut self, table: &DeTable<'_>, parent: &str) {
        for (key, value) in table.iter() {
            let key_span = key.span();
            let key: &str = key.get_ref().as_ref();
            let name = if !key.is_empty()
                && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            {
                if parent.is_empty() { key.into() } else { format!("{parent}.{key}") }
            } else {
                format!("{parent}[{}]", serde_json::to_string(key).expect("string serialization"))
            };
            // Both quoted keys and values have parser-owned byte coordinates.
            let span = key_span.start.min(value.span().start)..key_span.end.max(value.span().end);
            self.value(value.get_ref(), span, name);
        }
    }

    fn value(&mut self, value: &DeValue<'_>, span: Range<usize>, name: String) {
        // Long optional paths must not become an indivisible rendering obligation.
        if name.len() > MAX_RENDERED_LINE_BYTES || span.is_empty() {
            return;
        }
        self.regions.push((span.clone(), OwnerRegion {
            kind: "TOML key".into(),
            name: name.clone(),
            start: self.line_starts.partition_point(|start| *start <= span.start) as u32,
            end: self.line_starts.partition_point(|start| *start < span.end) as u32,
        }));
        match value {
            DeValue::Table(table) => self.table(table, &name),
            DeValue::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    self.value(item.get_ref(), item.span(), format!("{name}[{index}]"));
                }
            }
            _ => {}
        }
    }

    pub(super) fn owner(&self, row: &RawMatchedLine, source: &str) -> Option<OwnerRegion> {
        if row.text_clipped { return None; }
        let start = *self.line_starts.get(row.line.checked_sub(1)? as usize)?;
        let end = self.line_starts.get(row.line as usize).copied().unwrap_or(source.len());
        let text = source.get(start..end)?.trim_end_matches(['\r', '\n']);
        if text != row.text { return None; }
        let first = row.spans.iter().map(|span| span.start_byte).min()?;
        let last = row.spans.iter().map(|span| span.end_byte).max()?;
        if first > last || last > text.len() { return None; }
        // Multiple inline hits belong to their common container, not whichever
        // sibling happens to be visited last. Header spans are not table bodies.
        self.regions.iter().rev()
            .filter(|(span, _)| span.start <= start + first
                && start + first < span.end && start + last <= span.end)
            .min_by_key(|(span, _)| span.len())
            .map(|(_, owner)| owner.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::matches::MatchSpan;

    #[test]
    fn toml_context_refuses_clipped_or_different_rows_and_escapes_keys() {
        let source = "[auth]\n\"a\\u002eb\" = \"TOKEN\"\n";
        let context = TomlContext::parse(source).unwrap();
        let text = source.lines().nth(1).unwrap();
        let start = text.find("TOKEN").unwrap();
        let mut row = RawMatchedLine { line: 2, text: text.into(), text_clipped: false,
            spans: vec![MatchSpan { start_byte: start, end_byte: start + 5,
                start_column: start, end_column: start + 5 }] };
        let owner = context.owner(&row, source).unwrap();
        assert_eq!(owner.name, "auth[\"a.b\"]");
        assert_eq!((owner.start, owner.end), (2, 2));
        row.text_clipped = true;
        assert!(context.owner(&row, source).is_none());
        row.text_clipped = false;
        row.text.push(' ');
        assert!(context.owner(&row, source).is_none());
    }
}
