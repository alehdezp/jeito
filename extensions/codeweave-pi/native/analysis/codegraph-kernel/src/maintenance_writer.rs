//! Private bootstrap capability for the short-lived maintenance child, not an
//! extraction operation. The caller validates its private store and creates the
//! lock file once. Never unlink/replace that file to reclaim a writer: the OS
//! releases ownership when the actual writer process exits, including SIGKILL.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::Path;
use std::sync::OnceLock;

use napi::{Error, Result};
use napi_derive::napi;

// One project/job per child. Deliberately no release method or GC-dependent
// lifetime: a parent crash must not free the lock while this child still writes.
static WRITER: OnceLock<File> = OnceLock::new();

#[napi(js_name = "acquireMaintenanceWriter", catch_unwind)]
pub fn acquire_maintenance_writer(lock_file: String) -> Result<bool> {
    if WRITER.get().is_some() {
        return Err(Error::from_reason(
            "Maintenance child already owns a writer lock",
        ));
    }
    let path = Path::new(&lock_file);
    if !path.is_absolute() || fs::canonicalize(path)? != path {
        return Err(Error::from_reason("Maintenance lock must be canonical"));
    }
    let before = fs::symlink_metadata(path)?;
    if !before.is_file() {
        return Err(Error::from_reason(
            "Maintenance lock must be a regular file",
        ));
    }
    // The private-store owner creates the file. This capability never creates,
    // truncates, renames or removes it, and never reads its contents.
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    let opened = file.metadata()?;
    let after = fs::symlink_metadata(path)?;
    if !opened.is_file() || !after.is_file() || fs::canonicalize(path)? != path {
        return Err(Error::from_reason("Maintenance lock changed while opening"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev()
            || before.ino() != opened.ino()
            || after.dev() != opened.dev()
            || after.ino() != opened.ino()
            || opened.nlink() != 1
            || opened.mode() & 0o077 != 0
        {
            return Err(Error::from_reason(
                "Maintenance lock identity or privacy changed",
            ));
        }
    }
    match file.try_lock() {
        Ok(()) => {
            WRITER
                .set(file)
                .map_err(|_| Error::from_reason("Maintenance child already owns a writer lock"))?;
            Ok(true)
        }
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(error)) => Err(Error::from_reason(format!(
            "Maintenance lock failed: {error}"
        ))),
    }
}
