use std::path::PathBuf;
use std::time::SystemTime;

/// What kind of query the user issued.
#[derive(Debug)]
pub enum QueryType {
    FilePath(PathBuf),
    Glob(String),
    Symbol(String),
    /// Broad concept query — single lowercase word or multi-word phrase
    /// that likely refers to a feature/module/flow rather than an exact symbol.
    Concept(String),
    Content(String),
    /// Slash-wrapped regex: `/pattern/` → regex content search.
    Regex(String),
    /// Path-like query that didn't resolve — try symbol, then content.
    Fallthrough(String),
}

/// Programming language, carried through the type system so downstream
/// code never re-detects. Adding a language means adding an arm here
/// and the compiler tells you everywhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lang {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Go,
    Java,
    Scala,
    C,
    Cpp,
    Ruby,
    Php,
    Swift,
    Kotlin,
    CSharp,
    Elixir,
    Bash,
    Dockerfile,
    Make,
}

impl Lang {
    /// Returns `true` if the language uses `'` for lifetime ticks (`'a`,
    /// `'static`) rather than as a string/char delimiter.
    ///
    /// Lexers that scan `'` must disambiguate a lifetime from a single-quoted
    /// literal; only Rust needs the lifetime branch.
    pub(crate) fn has_lifetimes(self) -> bool {
        match self {
            Lang::Rust => true,
            Lang::TypeScript
            | Lang::Tsx
            | Lang::JavaScript
            | Lang::Python
            | Lang::Go
            | Lang::Java
            | Lang::Scala
            | Lang::C
            | Lang::Cpp
            | Lang::Ruby
            | Lang::Php
            | Lang::Swift
            | Lang::Kotlin
            | Lang::CSharp
            | Lang::Elixir
            | Lang::Bash
            | Lang::Dockerfile
            | Lang::Make => false,
        }
    }
}

/// File type as detected by extension. Determines outline strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileType {
    Code(Lang),
    Markdown,
    StructuredData,
    Tabular,
    Log,
    Other,
}

/// What the output contains — shown in the header bracket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewMode {
    Full,
    Outline,
    Signature,
    Keys,
    // Reserved/roadmap: planned head+tail view mode, not yet wired.
    #[allow(dead_code)]
    HeadTail,
    Empty,
    Generated,
    Minified,
    // Reserved/roadmap: binary file view variant, not yet wired.
    #[allow(dead_code)]
    Binary,
    // Reserved/roadmap: error view variant, not yet wired.
    #[allow(dead_code)]
    Error,
    Section,
    Stripped,
}

impl std::fmt::Display for ViewMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Full => write!(f, "full"),
            Self::Outline => write!(f, "outline"),
            Self::Signature => write!(f, "signature"),
            Self::Keys => write!(f, "keys"),
            Self::HeadTail => write!(f, "head+tail"),
            Self::Empty => write!(f, "empty"),
            Self::Generated => write!(f, "generated — skipped"),
            Self::Minified => write!(f, "minified — skipped"),
            Self::Binary => write!(f, "skipped"),
            Self::Error => write!(f, "error"),
            Self::Section => write!(f, "section"),
            Self::Stripped => write!(f, "stripped"),
        }
    }
}

/// Private association within one retained source/publication, not mutation authority.
#[derive(Debug, Clone)]
pub(crate) struct SourceAssociation {
    /// None explicitly preserves an unassociated/ambiguous graph candidate.
    pub syntax: Option<crate::tsjs_source::Identity>,
    pub graph_node_id: Option<String>,
}

/// A single search match, carrying enough context for ranking and display.
#[derive(Debug, Clone)]
pub struct Match {
    pub path: PathBuf,
    pub line: u32,
    pub text: String,
    pub is_definition: bool,
    pub exact: bool,
    pub file_lines: u32,
    pub mtime: SystemTime,
    /// Captured source identity/regions for migrated live navigation only.
    /// Never a graph identity or mutation authority; None preserves legacy keys.
    pub(crate) declaration: Option<crate::search::declarations::Declaration>,
    pub(crate) source_association: Option<SourceAssociation>,
    /// Line range of the enclosing definition node (for expand).
    /// Populated by tree-sitter for definitions; None for usages.
    pub def_range: Option<(u32, u32)>,
    /// The defined symbol name (populated from AST during definition detection).
    pub def_name: Option<String>,
    /// Semantic weight for definition kinds. 0 for usages.
    pub def_weight: u16,
    /// For impl/implements matches: the trait or interface being implemented.
    /// None for primary definitions and plain usages.
    pub impl_target: Option<String>,
}

impl Match {
    pub(crate) fn syntax_key(&self) -> Option<(usize, usize, &str)> {
        if let Some(association) = &self.source_association {
            return association.syntax.as_ref().map(|id| (id.bytes.start, id.bytes.end, id.syntax_kind.as_str()));
        }
        self.declaration.as_ref().map(|declaration| declaration.key())
    }

    pub(crate) fn graph_node_id(&self) -> Option<&str> {
        self.source_association.as_ref()?.graph_node_id.as_deref()
    }
}

/// Assembled search results before formatting.
#[derive(Debug, Clone)]
pub struct SearchResult {
    pub query: String,
    pub scope: PathBuf,
    pub matches: Vec<Match>,
    /// Operation-local current file text retained by search workers. This is
    /// reused for expansion and private proof snapshots and never serialized.
    pub(crate) sources: std::sync::Arc<crate::search::OperationSources>,
    pub total_found: usize,
    pub definitions: usize,
    pub usages: usize,
    /// Pre-cap subfacet counts. Computed in `symbol::search` by faceting the
    /// merged set before truncation; used by the renderer to print
    /// `displayed/total` headings and the per-facet hidden-count tail line.
    pub facet_totals: FacetTotals,
}

/// Pre-cap counts per subfacet. Defaults to all-zero for callers that don't
/// facet (`content::search`, `regex` paths) — the renderer renders a bare
/// count when displayed == total, so zero totals never surface a header.
#[derive(Debug, Default, Clone, Copy)]
pub struct FacetTotals {
    pub definitions: usize,
    pub implementations: usize,
    pub tests: usize,
    pub usages_local: usize,
    pub usages_cross: usize,
}

/// A single entry in a code outline.
#[derive(Debug)]
pub struct OutlineEntry {
    pub kind: OutlineKind,
    pub name: String,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: Option<String>,
    pub children: Vec<OutlineEntry>,
    pub doc: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OutlineKind {
    Import,
    Function,
    Class,
    Struct,
    Interface,
    TypeAlias,
    Enum,
    Constant,
    Variable,
    ImmutableVariable,
    Export,
    // Property is constructed in lang/outline.rs (property_declaration nodes).
    Property,
    Module,
    // Reserved/roadmap: no tree-sitter grammar currently emits TestSuite nodes.
    #[allow(dead_code)]
    TestSuite,
    // Reserved/roadmap: no tree-sitter grammar currently emits TestCase nodes.
    #[allow(dead_code)]
    TestCase,
}

impl OutlineKind {
    /// Terse display label shared by outline rendering and symbol-range output.
    #[must_use]
    pub fn as_label(self) -> &'static str {
        match self {
            OutlineKind::Import => "import",
            OutlineKind::Function => "fn",
            OutlineKind::Class => "class",
            OutlineKind::Struct => "struct",
            OutlineKind::Interface => "trait",
            OutlineKind::TypeAlias => "type",
            OutlineKind::Enum => "enum",
            OutlineKind::Constant => "const",
            OutlineKind::Variable | OutlineKind::ImmutableVariable => "var",
            OutlineKind::Export => "export",
            OutlineKind::Property => "property",
            OutlineKind::Module => "module",
            OutlineKind::TestSuite => "suite",
            OutlineKind::TestCase => "test",
        }
    }
}

/// Detect test files by component and basename conventions shared by search,
/// dependency, blast-radius, and outline projections.
pub(crate) fn is_test_file(path: &std::path::Path) -> bool {
    let has_test_directory = path.components().any(|component| {
        matches!(
            component.as_os_str().to_str(),
            Some("test" | "tests" | "__tests__")
        )
    });
    if has_test_directory {
        return true;
    }

    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or(lower.as_str());
    lower.contains(".test.")
        || lower.contains(".spec.")
        || stem.starts_with("test_")
        || stem.ends_with("_test")
        || stem.ends_with("-test")
}

#[cfg(test)]
mod test_path_tests {
    use super::is_test_file;
    use std::path::Path;

    #[test]
    fn common_test_paths_are_classified_without_substring_false_positives() {
        for path in [
            "tests/unit/config.py",
            "test/api/config.ts",
            "src/__tests__/config.ts",
            "src/config.test.ts",
            "src/config.spec.mjs",
            "src/test_config.py",
            "src/config_test.go",
            "src/config-test.js",
        ] {
            assert!(is_test_file(Path::new(path)), "expected test path: {path}");
        }
        for path in [
            "src/contest/parser.ts",
            "src/testing/config.ts",
            "src/testimony.py",
            "src/latest/config.ts",
        ] {
            assert!(
                !is_test_file(Path::new(path)),
                "unexpected test path: {path}"
            );
        }
    }
}

/// Tokens ≈ bytes / 4. Ceiling division, no float.
#[must_use]
pub fn estimate_tokens(byte_len: u64) -> u64 {
    byte_len.div_ceil(4)
}

/// UTF-8 safe string truncation. Never panics on multi-byte characters.
#[must_use]
pub fn truncate_str(s: &str, max: usize) -> &str {
    if s.len() <= max {
        s
    } else {
        &s[..s.floor_char_boundary(max)]
    }
}
