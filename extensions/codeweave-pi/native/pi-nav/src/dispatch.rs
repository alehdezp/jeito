use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use serde_json::{json, Value};

use crate::cache::OutlineCache;
use crate::index::bloom::BloomFilterCache;
use crate::ops;
use crate::output::ToolOutput;
use crate::session::Session;

pub(crate) const READ_ONLY_OPERATIONS: [&str; 12] = [
    "pi_nav_search",
    "pi_nav_files",
    "pi_nav_ls",
    "pi_nav_read",
    "pi_nav_diff",
    "pi_nav_deps",
    "pi_nav_grok",
    "pi_nav_map",
    "pi_nav_overview",
    "pi_nav_savings",
    "pi_nav_session",
    "pi_nav_symbol_range",
];

pub(crate) struct NativeSession {
    root: RwLock<PathBuf>,
    pub(crate) cache: OutlineCache,
    pub(crate) session: Session,
    pub(crate) bloom: Arc<BloomFilterCache>,
}

impl NativeSession {
    pub(crate) fn new(root: &Path, dedup_enabled: bool) -> Result<Self, NativeError> {
        let root = root
            .canonicalize()
            .map_err(|error| NativeError::io(&error))?;
        if !root.is_dir() {
            return Err(NativeError::invalid_argument("root must be a directory"));
        }
        crate::configure_thread_pools();
        Ok(Self {
            root: RwLock::new(root),
            cache: OutlineCache::new(),
            session: if dedup_enabled {
                Session::new()
            } else {
                Session::without_dedup()
            },
            bloom: Arc::new(BloomFilterCache::new()),
        })
    }

    pub(crate) fn root(&self) -> PathBuf {
        self.root
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn set_root(&self, root: &Path) -> Result<(), NativeError> {
        let root = root
            .canonicalize()
            .map_err(|error| NativeError::io(&error))?;
        if !root.is_dir() {
            return Err(NativeError::invalid_argument("root must be a directory"));
        }
        *self
            .root
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = root;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReadFormat {
    Plain,
    Hashline,
}

#[derive(Clone)]
pub(crate) struct OperationContext {
    pub(crate) root: PathBuf,
    pub(crate) deadline: Option<Instant>,
    pub(crate) cancelled: Arc<AtomicBool>,
    pub(crate) confine_to_root: bool,
    pub(crate) read_format: ReadFormat,
}

impl OperationContext {
    pub(crate) fn for_session(
        session: &NativeSession,
        read_format: ReadFormat,
        confine_to_root: bool,
    ) -> Self {
        Self {
            root: session.root(),
            deadline: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            confine_to_root,
            read_format,
        }
    }

    pub(crate) fn check(&self) -> Result<(), NativeError> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(NativeError::Cancelled);
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(NativeError::Deadline);
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum NativeError {
    InvalidArgument(String),
    Cancelled,
    Deadline,
    Io(String),
    Domain(String),
    Panic(String),
    UnknownOperation(String),
}

impl NativeError {
    pub(crate) fn invalid_argument(message: impl Into<String>) -> Self {
        Self::InvalidArgument(message.into())
    }

    fn io(error: &std::io::Error) -> Self {
        Self::Io(error.to_string())
    }

    fn from_operation(error: String) -> Self {
        if error.starts_with("[pi-nav:cancelled]") {
            return Self::Cancelled;
        }
        if error.starts_with("[pi-nav:deadline]") {
            return Self::Deadline;
        }
        let lower = error.to_ascii_lowercase();
        if [
            "missing required",
            "must be",
            "must contain",
            "unknown ",
            "invalid ",
            "provide either",
            "limited to",
            "not allowed",
            "cannot be combined",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
        {
            Self::InvalidArgument(error)
        } else {
            Self::Domain(error)
        }
    }
}

impl std::fmt::Display for NativeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (kind, message) = match self {
            Self::InvalidArgument(message) => ("invalid_argument", message.as_str()),
            Self::Cancelled => ("cancelled", "operation cancelled"),
            Self::Deadline => ("deadline", "operation deadline exceeded"),
            Self::Io(message) => ("io", message.as_str()),
            Self::Domain(message) => ("domain", message.as_str()),
            Self::Panic(message) => ("panic", message.as_str()),
            Self::UnknownOperation(message) => ("unknown_operation", message.as_str()),
        };
        write!(formatter, "[pi-nav:{kind}] {message}")
    }
}

impl std::error::Error for NativeError {}

fn rooted_args(
    operation: &str,
    args: &Value,
    context: &OperationContext,
) -> Result<Value, NativeError> {
    let mut args = args
        .as_object()
        .cloned()
        .ok_or_else(|| NativeError::invalid_argument("arguments must be an object"))?;
    if context.confine_to_root && args.contains_key("root") {
        return Err(NativeError::invalid_argument(
            "caller-supplied root is not allowed",
        ));
    }
    if context.confine_to_root || !args.contains_key("root") {
        args.insert(
            "root".into(),
            Value::String(context.root.to_string_lossy().into_owned()),
        );
    }
    if !context.confine_to_root {
        return Ok(Value::Object(args));
    }

    let absolute_keys: &[&str] = match operation {
        "pi_nav_search" => &["scope", "context"],
        "pi_nav_files" | "pi_nav_grok" | "pi_nav_map" => &["scope"],
        "pi_nav_ls" | "pi_nav_deps" => &["path", "scope"],
        "pi_nav_read" | "pi_nav_symbol_range" => &["path"],
        "pi_nav_diff" => &["a", "b", "patch"],

        _ => &[],
    };
    for key in absolute_keys {
        if let Some(raw) = args.get(*key).and_then(Value::as_str) {
            let resolved = resolve_local_path(&context.root, raw)?;
            args.insert(
                (*key).into(),
                Value::String(resolved.to_string_lossy().into_owned()),
            );
        }
    }
    if operation == "pi_nav_diff" {
        if let Some(raw) = args.get("scope").and_then(Value::as_str) {
            let (path, symbol) = raw.split_once(':').map_or((raw, None), |(path, symbol)| {
                (path, (!symbol.is_empty()).then_some(symbol))
            });
            let resolved = resolve_local_path(&context.root, path)?;
            let relative = resolved.strip_prefix(&context.root).map_err(|error| {
                NativeError::Domain(format!("failed to relativize diff scope {raw}: {error}"))
            })?;
            let mut relative_scope = relative.to_string_lossy().replace('\\', "/");
            // The diff owner distinguishes a root directory from an empty file selector.
            if relative_scope.is_empty() { relative_scope.push('.'); }
            if let Some(symbol) = symbol {
                relative_scope.push(':');
                relative_scope.push_str(symbol);
            }
            args.insert("scope".into(), Value::String(relative_scope));
        }
    }
    let requested_paths = (operation == "pi_nav_search"
        && args.get("output").and_then(Value::as_str) == Some("matches"))
    .then(|| args.get("paths").cloned())
    .flatten();
    args.remove("requestedPaths");
    if let Some(paths) = args.get("paths").and_then(Value::as_array) {
        let resolved = paths
            .iter()
            .map(|path| {
                let raw = path
                    .as_str()
                    .ok_or_else(|| NativeError::invalid_argument("paths must contain strings"))?;
                resolve_local_path(&context.root, raw)
                    .map(|path| Value::String(path.to_string_lossy().into_owned()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        args.insert("paths".into(), Value::Array(resolved));
    } else if let Some(raw) = args.get("paths").and_then(Value::as_str) {
        let resolved = resolve_local_path(&context.root, raw)?;
        args.insert(
            "paths".into(),
            Value::String(resolved.to_string_lossy().into_owned()),
        );
    }
    if let Some(requested_paths) = requested_paths {
        args.insert("requestedPaths".into(), requested_paths);
    }
    if operation == "pi_nav_grok" {
        if let Some(target) = args.get("target").and_then(Value::as_str) {
            if let Some((path, line)) = grok_path_line(target) {
                let path = resolve_local_path(&context.root, path)?;
                args.insert(
                    "target".into(),
                    Value::String(format!("{}:{line}", path.to_string_lossy())),
                );
            }
        }
    }
    Ok(Value::Object(args))
}

fn grok_path_line(target: &str) -> Option<(&str, &str)> {
    let (path, line) = target.rsplit_once(':')?;
    (line.chars().all(|character| character.is_ascii_digit())
        && (path.contains('/') || path.contains('.') || path.contains('\\')))
    .then_some((path, line))
}

pub(crate) fn resolve_local_path(root: &Path, raw: &str) -> Result<PathBuf, NativeError> {
    use std::path::Component;

    let candidate = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        root.join(raw)
    };
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // Explicit parent traversal may leave the session root. At
                // the filesystem root, additional parents simply remain at
                // that root, matching ordinary absolute-path resolution.
                normalized.pop();
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(part) => normalized.push(part),
        }
    }

    let mut ancestor = normalized.as_path();
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or_else(|| {
            NativeError::InvalidArgument(format!("path has no existing ancestor: {raw}"))
        })?;
    }
    let suffix = normalized.strip_prefix(ancestor).map_err(|error| {
        NativeError::Domain(format!("failed to resolve confined path {raw}: {error}"))
    })?;
    let base = ancestor
        .canonicalize()
        .map_err(|error| NativeError::io(&error))?;
    let resolved = if suffix.as_os_str().is_empty() {
        base
    } else {
        base.join(suffix)
    };
    Ok(resolved)
}

pub(crate) fn dispatch_read_only(
    operation: &str,
    args: &Value,
    session: &NativeSession,
    context: &OperationContext,
) -> Result<ToolOutput, NativeError> {
    context.check()?;
    let args = rooted_args(operation, args, context)?;
    if !READ_ONLY_OPERATIONS.contains(&operation) {
        return Err(NativeError::UnknownOperation(operation.to_string()));
    }
    match operation {
        "pi_nav_read" => ops::tool_read_output(
            &args,
            &session.cache,
            &session.session,
            context.read_format == ReadFormat::Hashline,
            context,
        )
        .map_err(NativeError::from_operation),
        "pi_nav_search" => ops::tool_search_output(
            &args,
            &session.cache,
            &session.session,
            &session.bloom,
            context,
        )
        .map_err(NativeError::from_operation),
        "pi_nav_files" => {
            ops::tool_files_output(&args, Some(context)).map_err(NativeError::from_operation)
        }
        "pi_nav_deps" => {
            ops::tool_deps_output(&args, &session.bloom).map_err(NativeError::from_operation)
        }
        "pi_nav_grok" => ops::tool_grok_output(&args, &session.bloom, &session.session)
            .map_err(NativeError::from_operation),
        "pi_nav_diff" => {
            ops::tool_diff_output(&args, Some(context)).map_err(NativeError::from_operation)
        }
        "pi_nav_savings" => {
            ops::tool_savings_output(&args, &session.session).map_err(NativeError::from_operation)
        }
        "pi_nav_session" => {
            ops::tool_session_output(&args, &session.session).map_err(NativeError::from_operation)
        }
        "pi_nav_symbol_range" => {
            ops::tool_symbol_range_output(&args, &session.cache, Some(&context.root))
                .map_err(NativeError::from_operation)
        }
        "pi_nav_map" => {
            let scope = args
                .get("scope")
                .and_then(Value::as_str)
                .map_or_else(|| context.root.clone(), PathBuf::from);
            if !scope.is_dir() {
                return Err(NativeError::invalid_argument(format!(
                    "map scope is not a directory: {}",
                    scope.display()
                )));
            }
            let depth = args.get("depth").and_then(Value::as_u64).unwrap_or(3);
            if !(1..=8).contains(&depth) {
                return Err(NativeError::invalid_argument(
                    "map depth must be between 1 and 8",
                ));
            }
            let budget = crate::budget::clamp(
                args.get("budget")
                    .and_then(Value::as_u64)
                    .unwrap_or(crate::budget::DEFAULT_BUDGET),
            );
            let map = crate::map::generate_typed(
                &scope,
                depth as usize,
                Some(budget),
                &session.cache,
                Some(context),
            );
            let returned = map.entries.len();
            let data = json!({ "entries": map.entries });
            if map.complete {
                Ok(ToolOutput::bounded(
                    "pi_nav_map",
                    map.text,
                    data,
                    returned,
                    returned,
                    budget,
                ))
            } else {
                Ok(ToolOutput::incomplete(
                    "pi_nav_map",
                    map.text,
                    data,
                    returned,
                    map.reason
                        .map_or(crate::output::IncompleteReason::Error, Into::into),
                    map.diagnostics,
                ))
            }
        }
        "pi_nav_overview" => {
            let overview = crate::overview::fingerprint_typed(&context.root, Some(context));
            let data = serde_json::to_value(overview.data)
                .map_err(|error| NativeError::Domain(error.to_string()))?;
            Ok(ToolOutput::complete(
                "pi_nav_overview",
                overview.text,
                data,
                1,
                1,
            ))
        }
        "pi_nav_ls" => ops::tool_ls_output(&args, context).map_err(NativeError::from_operation),
        _ => Err(NativeError::UnknownOperation(operation.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_session_canonicalizes_root_and_disables_dedup_when_requested() {
        let root = tempfile::tempdir().expect("fixture");
        let session = NativeSession::new(root.path(), false).expect("native session");
        assert_eq!(
            session.root(),
            root.path().canonicalize().expect("canonical root")
        );
        assert!(!session.session.is_expanded(
            Path::new("x.rs"),
            1,
            std::time::SystemTime::UNIX_EPOCH
        ));
    }

    #[test]
    fn dispatch_rejects_caller_root_before_operation() {
        let root = tempfile::tempdir().expect("fixture");
        let session = NativeSession::new(root.path(), false).expect("native session");
        let context = OperationContext::for_session(&session, ReadFormat::Plain, true);
        let error = dispatch_read_only(
            "pi_nav_files",
            &serde_json::json!({"root": "/tmp"}),
            &session,
            &context,
        )
        .expect_err("caller root must be rejected");
        assert!(matches!(error, NativeError::InvalidArgument(_)));
    }

    #[test]
    fn path_dispatch_anchors_relative_paths_and_accepts_parent_targets() {
        let parent = tempfile::tempdir().expect("fixture");
        let root_path = parent.path().join("root");
        std::fs::create_dir(&root_path).expect("root");
        std::fs::write(parent.path().join("outside.rs"), "pub fn outside() {}\n").expect("outside");
        let session = NativeSession::new(&root_path, false).expect("native session");
        let context = OperationContext::for_session(&session, ReadFormat::Plain, true);
        let args = rooted_args(
            "pi_nav_read",
            &serde_json::json!({"path": "../outside.rs"}),
            &context,
        )
        .expect("parent target must resolve");
        assert_eq!(
            Path::new(args["path"].as_str().expect("path")),
            parent
                .path()
                .join("outside.rs")
                .canonicalize()
                .expect("canonical outside")
        );
        assert!(resolve_local_path(&session.root(), "missing/new.rs").is_ok());
    }

    #[test]
    fn path_arguments_are_operation_aware_for_every_shape() {
        let root = tempfile::tempdir().expect("fixture");
        std::fs::create_dir(root.path().join("src")).expect("src");
        std::fs::write(root.path().join("src/lib.rs"), "pub fn value() {}\n").expect("source");
        let session = NativeSession::new(root.path(), false).expect("native session");
        let context = OperationContext::for_session(&session, ReadFormat::Plain, true);
        let canonical_root = session.root();

        for operation in READ_ONLY_OPERATIONS {
            let args = rooted_args(operation, &serde_json::json!({}), &context)
                .expect("rooted empty arguments");
            assert_eq!(args["root"], canonical_root.to_string_lossy().as_ref());
            assert!(args.get("scope").is_none(), "{operation} synthesized scope");
        }

        let args = rooted_args(
            "pi_nav_diff",
            &serde_json::json!({
                "scope": "src/lib.rs:value",
                "a": "src/lib.rs",
                "b": "missing/right.rs",
                "patch": "missing/change.patch"
            }),
            &context,
        )
        .expect("confined diff arguments");
        assert_eq!(args["scope"], "src/lib.rs:value");
        for key in ["a", "b", "patch"] {
            assert!(Path::new(args[key].as_str().expect("string")).starts_with(&canonical_root));
        }
        for root_scope in [".", "./", canonical_root.to_str().expect("UTF-8 fixture root")] {
            let args = rooted_args("pi_nav_diff", &serde_json::json!({"scope": root_scope}), &context)
                .expect("root-scoped diff arguments");
            assert_eq!(args["scope"], ".", "root identity must not turn into an empty file selector");
        }

        let read = rooted_args(
            "pi_nav_read",
            &serde_json::json!({"path": "src/lib.rs", "paths": ["src/lib.rs", "missing/new.rs"]}),
            &context,
        )
        .expect("confined read arguments");
        assert!(Path::new(read["path"].as_str().expect("path")).starts_with(&canonical_root));
        assert!(read["paths"]
            .as_array()
            .expect("paths")
            .iter()
            .all(|path| Path::new(path.as_str().expect("path")).starts_with(&canonical_root)));

        let matches = rooted_args(
            "pi_nav_search",
            &serde_json::json!({
                "pattern": "needle",
                "output": "matches",
                "paths": ["src/lib.rs", "missing/new.rs"],
                "requestedPaths": ["spoofed.txt"]
            }),
            &context,
        )
        .expect("confined matches arguments");
        assert_eq!(
            matches["requestedPaths"],
            serde_json::json!(["src/lib.rs", "missing/new.rs"])
        );
        assert!(matches["paths"]
            .as_array()
            .expect("resolved paths")
            .iter()
            .all(|path| Path::new(path.as_str().expect("path")).starts_with(&canonical_root)));

        let grok = rooted_args(
            "pi_nav_grok",
            &serde_json::json!({"target": "src/lib.rs:1"}),
            &context,
        )
        .expect("grok target");
        assert_eq!(
            grok["target"].as_str().expect("target"),
            format!("{}:1", canonical_root.join("src/lib.rs").display())
        );
        let symbol = rooted_args(
            "pi_nav_grok",
            &serde_json::json!({"target": "Type::method"}),
            &context,
        )
        .expect("symbol target");
        assert_eq!(symbol["target"], "Type::method");

        let outside = tempfile::tempdir().expect("outside");
        let external = rooted_args(
            "pi_nav_map",
            &serde_json::json!({"scope": outside.path()}),
            &context,
        )
        .expect("absolute external scope");
        assert_eq!(
            Path::new(external["scope"].as_str().expect("scope")),
            outside.path().canonicalize().expect("canonical outside")
        );
    }

    #[test]
    fn native_error_keeps_the_locked_panic_kind() {
        assert_eq!(
            NativeError::Panic("boom".into()).to_string(),
            "[pi-nav:panic] boom"
        );
    }

    #[test]
    fn dispatch_typed_map_overview_errors_and_cancellation() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("lib.rs"), "pub fn value() {}\n").unwrap();
        let session = NativeSession::new(root.path(), false).unwrap();
        let context = OperationContext::for_session(&session, ReadFormat::Plain, true);
        let map = dispatch_read_only(
            "pi_nav_map",
            &serde_json::json!({ "depth": 2 }),
            &session,
            &context,
        )
        .unwrap();
        assert!(map.structured["data"]["entries"]
            .as_array()
            .is_some_and(|entries| entries.iter().any(|entry| entry["path"] == "lib.rs")));
        let overview = dispatch_read_only(
            "pi_nav_overview",
            &serde_json::json!({}),
            &session,
            &context,
        )
        .unwrap();
        assert!(overview.structured["data"]["fileCount"].as_u64().is_some());
        let invalid = dispatch_read_only(
            "pi_nav_ls",
            &serde_json::json!({ "sort": "random" }),
            &session,
            &context,
        )
        .unwrap_err();
        assert!(matches!(invalid, NativeError::InvalidArgument(_)));
        let unknown =
            dispatch_read_only("pi_nav_future", &serde_json::json!({}), &session, &context)
                .unwrap_err();
        assert!(matches!(unknown, NativeError::UnknownOperation(_)));

        let cancelled = OperationContext::for_session(&session, ReadFormat::Plain, true);
        cancelled.cancelled.store(true, Ordering::Relaxed);
        assert!(matches!(
            dispatch_read_only("pi_nav_files", &serde_json::json!({}), &session, &cancelled),
            Err(NativeError::Cancelled)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn session_root_alias_is_canonical_and_symlink_targets_are_accepted() {
        use std::os::unix::fs::symlink;
        let parent = tempfile::tempdir().unwrap();
        let real = parent.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let alias = parent.path().join("alias");
        symlink(&real, &alias).unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), real.join("escape")).unwrap();
        let session = NativeSession::new(&alias, false).unwrap();
        assert_eq!(session.root(), real.canonicalize().unwrap());
        let resolved = resolve_local_path(&session.root(), "escape/file.rs")
            .expect("symlinked external target");
        assert_eq!(
            resolved,
            outside.path().canonicalize().unwrap().join("file.rs")
        );
    }

    #[test]
    fn dispatcher_honors_session_dedup_modes() {
        use std::fmt::Write as _;
        let root = tempfile::tempdir().unwrap();
        let mut source = String::from("pub fn long_body() {\n");
        for index in 0..80 {
            let _ = writeln!(source, "    let value_{index} = {index};");
        }
        source.push_str("}\n");
        std::fs::write(root.path().join("lib.rs"), source).unwrap();
        let args = serde_json::json!({ "target": "long_body" });

        let dedup = NativeSession::new(root.path(), true).unwrap();
        let dedup_context = OperationContext::for_session(&dedup, ReadFormat::Plain, true);
        let first = dispatch_read_only("pi_nav_grok", &args, &dedup, &dedup_context).unwrap();
        let second = dispatch_read_only("pi_nav_grok", &args, &dedup, &dedup_context).unwrap();
        assert!(!first.text.contains("shown earlier"));
        assert!(second.text.contains("shown earlier"));

        let full = NativeSession::new(root.path(), false).unwrap();
        let full_context = OperationContext::for_session(&full, ReadFormat::Plain, true);
        let first = dispatch_read_only("pi_nav_grok", &args, &full, &full_context).unwrap();
        let second = dispatch_read_only("pi_nav_grok", &args, &full, &full_context).unwrap();
        assert_eq!(first.text, second.text);
        assert!(!second.text.contains("shown earlier"));
    }
}
