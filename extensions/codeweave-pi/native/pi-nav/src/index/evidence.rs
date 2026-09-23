//! A1's single SQLite owner. Preparation is explicit; query connections never create a store.
//! Whole-file buffers are temporary; declaration signatures/docs persist as syntax evidence, not resolved calls.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::cache::OutlineCache;
use crate::dispatch::{OperationContext, ReadFormat};
use crate::lang::{detect_file_type, outline::walk_top_level};
use crate::types::{FileType, OutlineEntry};
use crate::walk::{self, EntryKind, WalkOptions};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const APPLICATION_ID: i32 = 0x50494e41;
const SCHEMA_VERSION: i32 = 1;
const EXTRACTOR_VERSION: &str = "pi-nav-outline-1";
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// A parent-owned policy snapshot. Missing files are significant (creation invalidates the batch).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyFile {
    pub path: PathBuf,
    pub digest: Option<String>,
}

/// Private CLI job contract, not an additional public navigation mode.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateRequest {
    pub root: PathBuf,
    pub database: PathBuf,
    /// Safety census bound: all walked entries, not only source files.
    pub max_entries: usize,
    pub max_bytes: u64,
    pub timeout_ms: u64,
    pub policy_files: Vec<PolicyFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub root: String,
    pub generation: i64,
    pub corpus_digest: String,
    pub files: i64,
    pub symbols: i64,
    pub unavailable_files: i64,
    pub evidence: &'static str,
    /// Ephemeral, policy-filtered directories for Pi's watcher; never a second persisted manifest.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watch_directories: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct FileVersion {
    digest: Option<String>,
    state: String,
}

struct PreparedFile {
    version: FileVersion,
    // None means unchanged: retain the existing declarations, rather than delete/reinsert them.
    declarations: Option<Vec<OutlineEntry>>,
    parse_state: String,
}

struct Batch {
    files: BTreeMap<String, PreparedFile>,
    base_generation: i64,
}

/// Read committed status without creating a database or running reconciliation.
pub fn status(root: &Path, database: &Path) -> Result<Option<IndexStatus>> {
    if !database.try_exists()? {
        return Ok(None);
    }
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    validate_database(&connection)?;
    check_root(&connection, &root.canonicalize()?)?;
    read_status(&connection).map(Some)
}

/// One publication transaction. Parsing happens first; readers retain their prior committed view.
pub fn reconcile(request: &UpdateRequest, cancelled: Arc<AtomicBool>) -> Result<IndexStatus> {
    if !request.root.is_absolute()
        || !request.database.is_absolute()
        || request.max_entries == 0
        || request.max_bytes == 0
        || !(1..=1_200_000).contains(&request.timeout_ms)
        || request.policy_files.len() > 8
    {
        return Err("invalid native update request".into());
    }
    if !cfg!(unix) {
        return Err(
            "native maintenance is supported on the packaged macOS/Linux targets only".into(),
        );
    }
    let root = request.root.canonicalize()?;
    if !root.is_dir()
        || root.parent().is_none()
        || home::home_dir()
            .and_then(|home| home.canonicalize().ok())
            .is_some_and(|home| home.starts_with(&root))
        || std::env::temp_dir()
            .canonicalize()
            .is_ok_and(|temp| root == temp)
    {
        return Err("native maintenance requires a bounded project directory".into());
    }
    let context = OperationContext {
        root: root.clone(),
        deadline: Some(
            Instant::now()
                .checked_add(Duration::from_millis(request.timeout_ms))
                .ok_or("maintenance deadline is not representable")?,
        ),
        cancelled,
        confine_to_root: true,
        read_format: ReadFormat::Plain,
    };
    context.check().map_err(|error| error.to_string())?;
    verify_policy(&request.policy_files)?;
    let mut connection = open_writer(&root, &request.database)?;
    let batch = prepare(&connection, &root, request, &context)?;
    let directories = publish(&mut connection, &root, request, &context, &batch)?;
    let mut status = read_status(&connection)?;
    status.watch_directories = Some(directories);
    Ok(status)
}

fn prepare(
    connection: &Connection,
    root: &Path,
    request: &UpdateRequest,
    context: &OperationContext,
) -> Result<Batch> {
    let base_generation = generation(connection)?;
    let old = existing_versions(connection)?;
    let extractor: String = connection.query_row(
        "SELECT extractor FROM metadata WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    let (paths, _) = corpus_paths(root, request, context)?;
    let mut files = BTreeMap::new();
    let mut bytes = 0;
    for path in paths {
        context.check().map_err(|error| error.to_string())?;
        let (version, content) = observe_file(root, &path, &mut bytes, request.max_bytes)?;
        let unchanged = extractor == EXTRACTOR_VERSION && old.get(&path) == Some(&version);
        let (declarations, parse_state) = if unchanged {
            (None, String::new())
        } else if let Some(content) = content {
            // Reuse the snapshot-backed parser; a per-file cache releases AST/source memory here.
            let cache = OutlineCache::new();
            match cache.get_or_parse_source(
                &root.join(&path),
                SystemTime::UNIX_EPOCH,
                Arc::new(content),
            ) {
                Some(parsed) => {
                    let lines: Vec<&str> = parsed.content.lines().collect();
                    let state = if parsed.tree.root_node().has_error() {
                        "partial_syntax"
                    } else {
                        "parsed"
                    };
                    (
                        Some(walk_top_level(parsed.tree.root_node(), &lines, parsed.lang)),
                        state.to_string(),
                    )
                }
                None => (Some(Vec::new()), "unsupported".to_string()),
            }
        } else {
            (Some(Vec::new()), version.state.clone())
        };
        files.insert(
            path,
            PreparedFile {
                version,
                declarations,
                parse_state,
            },
        );
    }
    Ok(Batch {
        files,
        base_generation,
    })
}

fn publish(
    connection: &mut Connection,
    root: &Path,
    request: &UpdateRequest,
    context: &OperationContext,
    batch: &Batch,
) -> Result<Vec<String>> {
    context.check().map_err(|error| error.to_string())?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if generation(&transaction)? != batch.base_generation {
        return Err("another updater published first; reconciliation must restart from the committed generation".into());
    }
    let existing = existing_versions(&transaction)?;
    for path in existing
        .keys()
        .filter(|path| !batch.files.contains_key(*path))
    {
        transaction.execute("DELETE FROM files WHERE path=?1", [path])?;
    }
    for (path, file) in &batch.files {
        context.check().map_err(|error| error.to_string())?;
        let Some(declarations) = &file.declarations else {
            continue;
        };
        transaction.execute("DELETE FROM files WHERE path=?1", [path])?;
        transaction.execute(
            "INSERT INTO files(path,digest,state,parse_state) VALUES(?1,?2,?3,?4)",
            params![
                path,
                file.version.digest,
                file.version.state,
                file.parse_state
            ],
        )?;
        insert_declarations(&transaction, path, declarations, None, "")?;
    }
    // Re-enumeration notices additions, removals and changed ignore membership. Content hashes,
    // not timestamps, reject same-size/same-mtime writes and stale extraction from another process.
    let (paths, directories) = corpus_paths(root, request, context)?;
    if paths.iter().ne(batch.files.keys()) {
        return Err(
            "corpus membership changed during preparation; prior generation retained".into(),
        );
    }
    let mut bytes = 0;
    for (path, prepared) in &batch.files {
        context.check().map_err(|error| error.to_string())?;
        let (current, _) = observe_file(root, path, &mut bytes, request.max_bytes)?;
        if current != prepared.version {
            return Err(format!(
                "source changed during preparation: {path}; prior generation retained"
            )
            .into());
        }
    }
    verify_policy(&request.policy_files)?;
    let versions: BTreeMap<_, _> = batch
        .files
        .iter()
        .map(|(path, file)| (path, &file.version))
        .collect();
    let digest = format!("{:X}", Sha256::digest(serde_json::to_vec(&versions)?));
    transaction.execute("UPDATE metadata SET generation=generation+1, corpus_digest=?1, extractor=?2 WHERE singleton=1", params![digest, EXTRACTOR_VERSION])?;
    context.check().map_err(|error| error.to_string())?;
    transaction.commit()?;
    Ok(directories)
}

fn corpus_paths(
    root: &Path,
    request: &UpdateRequest,
    context: &OperationContext,
) -> Result<(Vec<String>, Vec<String>)> {
    let walked = walk::walk(
        root,
        &WalkOptions {
            policy_root: Some(root.to_path_buf()),
            deadline: context.deadline,
            cancelled: Some(Arc::clone(&context.cancelled)),
            candidate_cap: Some(request.max_entries),
            ..WalkOptions::default()
        },
    )?;
    if !walked.complete {
        return Err(format!(
            "corpus census incomplete ({:?}); prior generation retained",
            walked.reason
        )
        .into());
    }
    let mut paths = Vec::new();
    let mut directories = vec![String::new()]; // The root watches additions, including new subdirectories.
    for entry in walked.entries {
        if entry.kind != EntryKind::Directory
            && (entry.kind != EntryKind::File
                || !matches!(detect_file_type(&entry.path), FileType::Code(_)))
        {
            continue;
        }
        let path = entry
            .path
            .to_str()
            .ok_or("non-UTF-8 source path cannot be indexed without changing its identity")?;
        let path = path.replace(std::path::MAIN_SEPARATOR, "/");
        if entry.kind == EntryKind::Directory {
            directories.push(path);
        } else {
            paths.push(path);
        }
    }
    paths.sort();
    paths.dedup();
    directories.sort();
    directories.dedup();
    Ok((paths, directories))
}

fn observe_file(
    root: &Path,
    path: &str,
    total_bytes: &mut u64,
    max_bytes: u64,
) -> Result<(FileVersion, Option<String>)> {
    let source = root.join(path);
    let canonical = source.canonicalize()?;
    if !canonical.starts_with(root) || canonical != source {
        return Err(format!("source identity changed or escaped the corpus: {path}").into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = match options.open(&source) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return Ok((
                FileVersion {
                    digest: None,
                    state: "unreadable".into(),
                },
                None,
            ))
        }
        Err(error) => return Err(error.into()),
    };
    if !file.metadata()?.is_file() {
        return Err("source is no longer a regular file".into());
    }
    if file.metadata()?.len() > MAX_FILE_BYTES {
        return Ok((
            FileVersion {
                digest: None,
                state: "oversized".into(),
            },
            None,
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("source grew past its bound while reading: {path}").into());
    }
    *total_bytes = total_bytes
        .checked_add(bytes.len() as u64)
        .ok_or("source byte count overflow")?;
    if *total_bytes > max_bytes {
        return Err("corpus byte budget exceeded; prior generation retained".into());
    }
    let digest = Some(format!("{:X}", Sha256::digest(&bytes)));
    if bytes.contains(&0) {
        return Ok((
            FileVersion {
                digest,
                state: "binary".into(),
            },
            None,
        ));
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok((
            FileVersion {
                digest,
                state: "text".into(),
            },
            Some(text),
        )),
        Err(_) => Ok((
            FileVersion {
                digest,
                state: "non_utf8".into(),
            },
            None,
        )),
    }
}

fn verify_policy(files: &[PolicyFile]) -> Result<()> {
    for policy in files {
        if !policy.path.is_absolute() {
            return Err("policy paths must be absolute".into());
        }
        let digest = match File::open(&policy.path) {
            Ok(file) => {
                if file.metadata()?.len() > 1_048_576 {
                    return Err("policy file exceeds the read bound".into());
                }
                let mut bytes = Vec::new();
                file.take(1_048_577).read_to_end(&mut bytes)?;
                if bytes.len() > 1_048_576 {
                    return Err("policy changed while reading".into());
                }
                Some(format!("{:X}", Sha256::digest(&bytes)))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if digest != policy.digest {
            return Err("maintenance policy changed; prior generation retained".into());
        }
    }
    Ok(())
}

fn open_writer(root: &Path, database: &Path) -> Result<Connection> {
    // SQLite documents a WAL-reset race through 3.51.2. A1 must not inherit a host SQLite.
    if rusqlite::version_number() < 3_051_003 {
        return Err("SQLite with the WAL-reset fix is required (3.51.3 or newer)".into());
    }
    let parent = database
        .parent()
        .ok_or("database needs an absolute parent directory")?;
    if database.starts_with(root) {
        return Err("the A1 cache must be outside the source project".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(parent)?;
    if parent.canonicalize()?.starts_with(root)
        || fs::symlink_metadata(parent)?.file_type().is_symlink()
    {
        return Err("cache location resolves into source or through a leaf symlink".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = fs::metadata(parent)?;
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err("A1 cache directory must be private and owned by the current user".into());
        }
    }
    let mut connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::from_secs(2))?;
    let application: i32 = connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    if application == 0 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let tables: i64 = transaction.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )?;
        let current: i32 = transaction.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        if current == 0 {
            if tables != 0 {
                return Err("refusing to adopt an unrelated SQLite database".into());
            }
            transaction.execute_batch(SCHEMA)?;
            transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
            transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            transaction.execute(
                "INSERT INTO metadata VALUES(1,?1,0,'',?2)",
                params![root.to_str().ok_or("non-UTF-8 root")?, EXTRACTOR_VERSION],
            )?;
        }
        transaction.commit()?;
    }
    validate_database(&connection)?;
    check_root(&connection, root)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    let mode: String = connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    if mode != "wal" {
        return Err("SQLite could not enable committed-reader WAL mode".into());
    }
    connection.pragma_update(None, "synchronous", "FULL")?;
    Ok(connection)
}

fn validate_database(connection: &Connection) -> Result<()> {
    let application: i32 = connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let schema: i32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if application != APPLICATION_ID || schema != SCHEMA_VERSION {
        return Err("unrecognized native evidence database; query will not repair it".into());
    }
    Ok(())
}

fn check_root(connection: &Connection, root: &Path) -> Result<()> {
    let stored: String =
        connection.query_row("SELECT root FROM metadata WHERE singleton=1", [], |row| {
            row.get(0)
        })?;
    if Path::new(&stored) != root {
        return Err("evidence database belongs to a different canonical project".into());
    }
    Ok(())
}

fn generation(connection: &Connection) -> Result<i64> {
    Ok(connection.query_row(
        "SELECT generation FROM metadata WHERE singleton=1",
        [],
        |row| row.get(0),
    )?)
}

fn existing_versions(connection: &Connection) -> Result<BTreeMap<String, FileVersion>> {
    let mut statement = connection.prepare("SELECT path,digest,state FROM files ORDER BY path")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get(0)?,
            FileVersion {
                digest: row.get(1)?,
                state: row.get(2)?,
            },
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn insert_declarations(
    connection: &Connection,
    file: &str,
    entries: &[OutlineEntry],
    parent: Option<i64>,
    prefix: &str,
) -> Result<()> {
    for entry in entries {
        let qualified = if prefix.is_empty() {
            entry.name.clone()
        } else {
            format!("{prefix}::{}", entry.name)
        };
        connection.execute("INSERT INTO symbols(file,parent,name,qualified,kind,start_line,end_line,signature,documentation) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![file, parent, entry.name, qualified, entry.kind.as_label(), entry.start_line, entry.end_line, entry.signature, entry.doc])?;
        insert_declarations(
            connection,
            file,
            &entry.children,
            Some(connection.last_insert_rowid()),
            &qualified,
        )?;
    }
    Ok(())
}

fn read_status(connection: &Connection) -> Result<IndexStatus> {
    Ok(connection.query_row("SELECT root,generation,corpus_digest,(SELECT count(*) FROM files),(SELECT count(*) FROM symbols),(SELECT count(*) FROM files WHERE parse_state != 'parsed') FROM metadata WHERE singleton=1", [], |row| Ok(IndexStatus {
        root: row.get(0)?, generation: row.get(1)?, corpus_digest: row.get(2)?, files: row.get(3)?, symbols: row.get(4)?, unavailable_files: row.get(5)?, evidence: "declarations; relationship resolution not yet available",
        watch_directories: None,
    }))?)
}

const SCHEMA: &str = "
CREATE TABLE metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1), root TEXT NOT NULL, generation INTEGER NOT NULL, corpus_digest TEXT NOT NULL, extractor TEXT NOT NULL);
CREATE TABLE files(path TEXT PRIMARY KEY, digest TEXT, state TEXT NOT NULL, parse_state TEXT NOT NULL);
CREATE TABLE symbols(id INTEGER PRIMARY KEY, file TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE, parent INTEGER REFERENCES symbols(id) ON DELETE CASCADE, name TEXT NOT NULL, qualified TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, signature TEXT, documentation TEXT);
CREATE INDEX symbols_file ON symbols(file);
CREATE INDEX symbols_name ON symbols(name);
CREATE VIRTUAL TABLE symbol_search USING fts5(name,qualified,signature,documentation,file UNINDEXED,content='symbols',content_rowid='id');
CREATE TRIGGER symbols_insert AFTER INSERT ON symbols BEGIN INSERT INTO symbol_search(rowid,name,qualified,signature,documentation,file) VALUES(new.id,new.name,new.qualified,new.signature,new.documentation,new.file); END;
CREATE TRIGGER symbols_delete AFTER DELETE ON symbols BEGIN INSERT INTO symbol_search(symbol_search,rowid,name,qualified,signature,documentation,file) VALUES('delete',old.id,old.name,old.qualified,old.signature,old.documentation,old.file); END;
";

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn fixture() -> (tempfile::TempDir, UpdateRequest) {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().canonicalize().unwrap();
        let root = base.join("project");
        fs::create_dir(&root).unwrap();
        let request = UpdateRequest {
            root,
            database: base.join("cache/evidence.sqlite"),
            max_entries: 1000,
            max_bytes: 1_000_000,
            timeout_ms: 30_000,
            policy_files: Vec::new(),
        };
        (directory, request)
    }

    fn context(root: &Path) -> OperationContext {
        OperationContext {
            root: root.to_path_buf(),
            deadline: Some(Instant::now() + Duration::from_secs(30)),
            cancelled: Arc::new(AtomicBool::new(false)),
            confine_to_root: true,
            read_format: ReadFormat::Plain,
        }
    }

    fn matches(connection: &Connection, query: &str) -> Vec<String> {
        connection
            .prepare("SELECT name FROM symbol_search WHERE symbol_search MATCH ?1 ORDER BY name")
            .unwrap()
            .query_map([query], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn reconciliation_replaces_changed_deleted_and_newly_admitted_evidence() {
        let (_directory, request) = fixture();
        assert!(status(&request.root, &request.database).unwrap().is_none());
        assert!(
            !request.database.parent().unwrap().exists(),
            "queries must not create cache directories"
        );
        let source = request.root.join("main.rs");
        fs::write(&source, "pub fn Alpha() {}\n").unwrap();
        fs::write(
            request.root.join("other.ts"),
            "export class Beta { run() {} }\n",
        )
        .unwrap();
        fs::write(request.root.join("hidden.rs"), "pub fn Hidden() {}\n").unwrap();
        fs::write(request.root.join(".gitignore"), "hidden.rs\n").unwrap();
        let first = reconcile(&request, Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!((first.generation, first.files), (1, 2));
        let reader =
            Connection::open_with_flags(&request.database, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        assert_eq!(matches(&reader, "Alpha"), ["Alpha"]);
        assert!(matches(&reader, "Hidden").is_empty());
        let old_time = fs::metadata(&source).unwrap().modified().unwrap();
        fs::write(&source, "pub fn Gamma() {}\n").unwrap();
        File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old_time))
            .unwrap();
        fs::remove_file(request.root.join("other.ts")).unwrap();
        fs::create_dir_all(request.root.join(".pi/navigation")).unwrap();
        fs::write(request.root.join(".pi/navigation/ignore"), "!hidden.rs\n").unwrap();
        let second = reconcile(&request, Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!((second.generation, second.files), (2, 2));
        assert!(
            matches(&reader, "Alpha OR Beta").is_empty(),
            "deleted declarations and FTS entries must retire together"
        );
        assert_eq!(matches(&reader, "Gamma OR Hidden"), ["Gamma", "Hidden"]);
    }

    #[test]
    fn readers_keep_one_committed_snapshot_and_drift_rolls_back_the_entire_batch() {
        let (_directory, mut request) = fixture();
        let source = request.root.join("main.rs");
        fs::write(&source, "pub fn Before() {}\n").unwrap();
        reconcile(&request, Arc::new(AtomicBool::new(false))).unwrap();
        let reader =
            Connection::open_with_flags(&request.database, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        reader.execute_batch("BEGIN").unwrap();
        assert_eq!(matches(&reader, "Before"), ["Before"]);
        fs::write(&source, "pub fn After() {}\n").unwrap();
        reconcile(&request, Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(generation(&reader).unwrap(), 1);
        assert_eq!(matches(&reader, "Before"), ["Before"]);
        assert!(matches(&reader, "After").is_empty());
        reader.execute_batch("COMMIT").unwrap();
        assert_eq!(generation(&reader).unwrap(), 2);
        assert_eq!(matches(&reader, "After"), ["After"]);

        let mut writer = open_writer(&request.root, &request.database).unwrap();
        let ctx = context(&request.root);
        let batch = prepare(&writer, &request.root, &request, &ctx).unwrap();
        fs::write(&source, "pub fn Racing() {}\n").unwrap();
        assert!(publish(&mut writer, &request.root, &request, &ctx, &batch)
            .unwrap_err()
            .to_string()
            .contains("source changed"));
        assert_eq!(generation(&reader).unwrap(), 2);
        assert_eq!(matches(&reader, "After"), ["After"]);

        request.policy_files.push(PolicyFile {
            path: request.root.join(".pi-navigation.json"),
            digest: None,
        });
        let batch = prepare(&writer, &request.root, &request, &ctx).unwrap();
        fs::write(&request.policy_files[0].path, "{}").unwrap();
        assert!(publish(&mut writer, &request.root, &request, &ctx, &batch)
            .unwrap_err()
            .to_string()
            .contains("policy changed"));
        assert_eq!(
            matches(&reader, "After"),
            ["After"],
            "no half-updated declarations survive a policy rejection"
        );
        request.policy_files[0].digest = Some(format!("{:X}", Sha256::digest(b"{}")));
        let batch = prepare(&writer, &request.root, &request, &ctx).unwrap();
        fs::write(&request.policy_files[0].path, "{\"disabled\":true}").unwrap();
        assert!(publish(&mut writer, &request.root, &request, &ctx, &batch).is_err());
        assert_eq!(generation(&reader).unwrap(), 2);
        request.policy_files.clear();
        let batch = prepare(&writer, &request.root, &request, &ctx).unwrap();
        reconcile(&request, Arc::new(AtomicBool::new(false))).unwrap();
        assert!(publish(&mut writer, &request.root, &request, &ctx, &batch)
            .unwrap_err()
            .to_string()
            .contains("another updater"));
        assert_eq!(matches(&reader, "Racing"), ["Racing"]);
    }

    #[test]
    fn cancellation_and_foreign_databases_do_not_authorize_writes() {
        let (_directory, request) = fixture();
        assert!(reconcile(&request, Arc::new(AtomicBool::new(true))).is_err());
        assert!(!request.database.exists());
        fs::write(request.root.join("main.rs"), "pub fn Kept() {}\n").unwrap();
        reconcile(&request, Arc::new(AtomicBool::new(false))).unwrap();
        let mut writer = open_writer(&request.root, &request.database).unwrap();
        let ctx = context(&request.root);
        let batch = prepare(&writer, &request.root, &request, &ctx).unwrap();
        ctx.cancelled.store(true, Ordering::Relaxed);
        assert!(publish(&mut writer, &request.root, &request, &ctx, &batch).is_err());
        assert_eq!(generation(&writer).unwrap(), 1);
        assert!(status(request.database.parent().unwrap(), &request.database).is_err());
        let foreign = request.database.with_file_name("unrelated.sqlite");
        let other = Connection::open(&foreign).unwrap();
        other
            .execute_batch(
                "CREATE TABLE important(value TEXT); INSERT INTO important VALUES('preserved')",
            )
            .unwrap();
        assert!(open_writer(&request.root, &foreign).is_err());
        assert_eq!(
            other
                .query_row("SELECT value FROM important", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "preserved"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                request.database.parent().unwrap(),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
            assert!(
                open_writer(&request.root, &request.database).is_err(),
                "a public cache directory cannot receive source evidence"
            );
        }
    }

    #[test]
    fn admitted_corpus_does_not_scan_parent_rules_nested_projects_or_symlink_targets() {
        let (_directory, request) = fixture();
        let parent = request.root.parent().unwrap();
        fs::create_dir(parent.join(".git")).unwrap();
        fs::create_dir_all(parent.join(".pi/navigation")).unwrap();
        fs::write(parent.join(".pi/navigation/ignore"), "**\n!**\n").unwrap();
        fs::write(request.root.join("main.rs"), "pub fn Kept() {}\n").unwrap();
        let nested = request.root.join("independent");
        fs::create_dir_all(nested.join(".git")).unwrap();
        fs::write(nested.join("other.rs"), "pub fn OtherProject() {}\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&nested, request.root.join("alias")).unwrap();
        let result = reconcile(&request, Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(result.files, 1);
        let reader = Connection::open(&request.database).unwrap();
        assert_eq!(matches(&reader, "Kept"), ["Kept"]);
        assert!(matches(&reader, "OtherProject").is_empty());
    }

    #[test]
    fn resource_limits_retain_prior_evidence_and_unavailable_files_are_not_absence() {
        let (_directory, mut request) = fixture();
        fs::write(request.root.join("main.rs"), "pub fn Kept() {}\n").unwrap();
        fs::write(request.root.join("binary.rs"), b"\0binary").unwrap();
        fs::write(request.root.join("encoding.rs"), [0xff, 0xfe]).unwrap();
        File::create(request.root.join("oversized.rs"))
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        let first = reconcile(&request, Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!((first.files, first.unavailable_files), (4, 3));
        let mut writer = open_writer(&request.root, &request.database).unwrap();
        let states: Vec<String> = writer
            .prepare("SELECT state FROM files WHERE state != 'text' ORDER BY state")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(states, ["binary", "non_utf8", "oversized"]);
        request.max_entries = 1;
        assert!(reconcile(&request, Arc::new(AtomicBool::new(false))).is_err());
        request.max_entries = 1000;
        request.max_bytes = 1;
        assert!(reconcile(&request, Arc::new(AtomicBool::new(false))).is_err());
        request.max_bytes = 1_000_000;
        let mut ctx = context(&request.root);
        let batch = prepare(&writer, &request.root, &request, &ctx).unwrap();
        ctx.deadline = Some(Instant::now());
        assert!(publish(&mut writer, &request.root, &request, &ctx, &batch).is_err());
        request.timeout_ms = u64::MAX;
        assert!(reconcile(&request, Arc::new(AtomicBool::new(false))).is_err());
        assert_eq!(generation(&writer).unwrap(), 1);
        assert_eq!(matches(&writer, "Kept"), ["Kept"]);
    }
}
