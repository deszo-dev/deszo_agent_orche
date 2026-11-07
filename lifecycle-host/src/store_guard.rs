//! Windows file guards and disposable SQLite copies used by the P6 maintenance preflight.
//! A guard holds each original database file with `FILE_SHARE_READ` only. SQLite is opened only
//! against the disposable copy because a live `readOnly` WAL connection is not physically inert.

use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoreFileEvidence {
    pub name: String,
    pub path: PathBuf,
    pub volume_serial: u32,
    pub file_index: u64,
    pub bytes: u64,
    pub last_write_time: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSnapshotEvidence {
    pub production_root: PathBuf,
    pub scratch_root: PathBuf,
    pub production_files: Vec<StoreFileEvidence>,
    pub copied_files: Vec<StoreFileEvidence>,
    pub snapshot_sha256: String,
}

#[derive(Debug)]
struct GuardedFile {
    name: String,
    path: PathBuf,
    file: File,
    initial: StoreFileEvidence,
}

/// Owns native no-write handles for the production Store while the caller runs B's scratch-only
/// preflight. Drop releases the guards. The returned evidence binds the input file set and copy.
#[derive(Debug)]
pub struct StoreSnapshotGuard {
    guards: Vec<GuardedFile>,
    evidence: StoreSnapshotEvidence,
}

impl StoreSnapshotGuard {
    pub fn evidence(&self) -> &StoreSnapshotEvidence {
        &self.evidence
    }

    /// Re-hashes the already guarded file handles and compares the path inventory before commit.
    pub fn verify_unchanged(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        {
        for guard in &mut self.guards {
            let current = evidence_from_handle(&mut guard.file, &guard.name, &guard.path)?;
            if current != guard.initial {
                return Err(format!("guarded production Store file changed: {}", guard.path.display()));
            }
        }
        let current_names = existing_names(&self.evidence.production_root)?;
        let initial_names = self.guards.iter().map(|guard| guard.name.clone()).collect::<Vec<_>>();
        if current_names != initial_names {
            return Err("the production Store sidecar file set changed during preflight".into());
        }
        for copied in &self.evidence.copied_files {
            let mut file = File::open(&copied.path).map_err(|error| error.to_string())?;
            let current = evidence_from_handle(&mut file, &copied.name, &copied.path)?;
            if current.bytes != copied.bytes || current.sha256 != copied.sha256 {
                return Err(format!("disposable preflight database changed: {}", copied.path.display()));
            }
        }
        Ok(())
        }
        #[cfg(not(windows))]
        { Err("native SQLite Store guards are implemented only on Windows".into()) }
    }
}

/// Stops at the first uncertain condition. A present rollback journal is conservatively refused.
/// The scratch directory must not already exist and is never copied back to the production profile.
pub fn guard_and_copy_store(store_path: &Path, scratch_root: &Path) -> Result<StoreSnapshotGuard, String> {
    #[cfg(windows)]
    {
        return guard_and_copy_store_windows(store_path, scratch_root);
    }
    #[cfg(not(windows))]
    {
        let _ = (store_path, scratch_root);
        Err("native SQLite Store guards are implemented only on Windows".into())
    }
}

#[cfg(windows)]
fn guard_and_copy_store_windows(store_path: &Path, scratch_root: &Path) -> Result<StoreSnapshotGuard, String> {
    use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
    use windows_sys::Win32::{
        Foundation::{GetLastError, INVALID_HANDLE_VALUE, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, GENERIC_READ},
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_SHARE_READ, OPEN_EXISTING,
        },
    };

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    fn open_guard(path: &Path) -> Result<File, u32> {
        let value = wide(path);
        let handle = unsafe {
            CreateFileW(value.as_ptr(), GENERIC_READ, FILE_SHARE_READ, std::ptr::null(), OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, std::ptr::null_mut())
        };
        if handle == INVALID_HANDLE_VALUE { return Err(unsafe { GetLastError() }); }
        Ok(unsafe { File::from_raw_handle(handle as _) })
    }

    if !store_path.is_absolute() { return Err("production Store path must be absolute".into()); }
    reject_reparse_ancestors(store_path)?;
    let store_path = fs::canonicalize(store_path).map_err(|e| format!("production Store path is unavailable: {e}"))?;
    if store_path.file_name().and_then(|v| v.to_str()) != Some("state.sqlite") {
        return Err("production Store must be the fixed state.sqlite file".into());
    }
    reject_reparse_ancestors(&store_path)?;
    let production_root = store_path.parent().ok_or("production Store has no parent")?.to_path_buf();
    let scratch_parent = scratch_root.parent().ok_or("preflight scratch path has no parent")?;
    if !scratch_parent.is_dir() || scratch_root.exists() {
        return Err("preflight scratch must be a new directory under an existing Host-owned parent".into());
    }
    reject_reparse_ancestors(scratch_parent)?;

    let names = ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "state.sqlite-journal"];
    let mut guards = Vec::new();
    for name in names {
        let path = production_root.join(name);
        let file = match open_guard(&path) {
            Ok(file) => file,
            Err(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) if name != "state.sqlite" => continue,
            Err(code) => return Err(format!("CreateFile Store guard refused {} with Win32 error {code}", path.display())),
        };
        let mut file = file;
        let initial = evidence_from_handle(&mut file, name, &path)?;
        guards.push(GuardedFile { name: name.into(), path, file, initial });
    }
    if guards.first().map(|guard| guard.name.as_str()) != Some("state.sqlite") {
        return Err("production Store main database guard is missing".into());
    }
    if guards.iter().any(|guard| guard.name == "state.sqlite-journal") {
        return Err("production Store has a rollback journal; preflight holds".into());
    }
    let initial_names = guards.iter().map(|guard| guard.name.clone()).collect::<Vec<_>>();
    let actual_names = existing_names(&production_root)?;
    if initial_names != actual_names {
        return Err("production Store sidecar file set changed while guards were acquired".into());
    }

    fs::create_dir(scratch_root).map_err(|e| format!("could not create disposable preflight scratch: {e}"))?;
    let mut copied_files = Vec::new();
    for name in ["state.sqlite", "state.sqlite-wal"] {
        let Some(guard) = guards.iter_mut().find(|guard| guard.name == name) else { continue; };
        guard.file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let destination = scratch_root.join(name);
        let mut output = OpenOptions::new().create_new(true).write(true).open(&destination).map_err(|e| e.to_string())?;
        std::io::copy(&mut guard.file, &mut output).map_err(|e| e.to_string())?;
        output.flush().map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        let mut readback = File::open(&destination).map_err(|e| e.to_string())?;
        let copy_evidence = evidence_from_handle(&mut readback, name, &destination)?;
        if copy_evidence.bytes != guard.initial.bytes || copy_evidence.sha256 != guard.initial.sha256 {
            return Err(format!("disposable Store copy failed byte verification: {name}"));
        }
        copied_files.push(copy_evidence);
    }
    if copied_files.is_empty() || copied_files[0].name != "state.sqlite" {
        return Err("disposable Store copy is incomplete".into());
    }
    for guard in &mut guards {
        let current = evidence_from_handle(&mut guard.file, &guard.name, &guard.path)?;
        if current != guard.initial { return Err(format!("production Store changed while copying: {}", guard.path.display())); }
    }
    if existing_names(&production_root)? != initial_names {
        return Err("production Store sidecar file set changed while copying".into());
    }
    let snapshot_sha256 = hash_snapshot(&copied_files);
    let evidence = StoreSnapshotEvidence { production_root, scratch_root: scratch_root.to_path_buf(), production_files: guards.iter().map(|guard| guard.initial.clone()).collect(),
        copied_files, snapshot_sha256 };
    Ok(StoreSnapshotGuard { guards, evidence })
}

#[cfg(windows)]
fn evidence_from_handle(file: &mut File, name: &str, path: &Path) -> Result<StoreFileEvidence, String> {
    use sha2::Digest as _;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT},
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut info) } == 0 {
        return Err(format!("GetFileInformationByHandle failed for {}: {}", path.display(), std::io::Error::last_os_error()));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        return Err(format!("Store path is not a plain file: {}", path.display()));
    }
    let bytes = ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64;
    let file_index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    let last_write_time = ((info.ftLastWriteTime.dwHighDateTime as u64) << 32) | info.ftLastWriteTime.dwLowDateTime as u64;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut digest = sha2::Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    if bytes != file.metadata().map_err(|e| e.to_string())?.len() {
        return Err(format!("Store file length changed while hashing: {}", path.display()));
    }
    Ok(StoreFileEvidence { name: name.into(), path: path.to_path_buf(), volume_serial: info.dwVolumeSerialNumber,
        file_index, bytes, last_write_time, sha256: hex::encode(digest.finalize()) })
}

#[cfg(windows)]
fn existing_names(root: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for name in ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "state.sqlite-journal"] {
        match fs::symlink_metadata(root.join(name)) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() { return Err(format!("Store sidecar is a reparse point: {name}")); }
                names.push(name.to_string());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(names)
}

#[cfg(windows)]
fn reject_reparse_ancestors(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT};
    for current in path.ancestors().filter(|value| !value.as_os_str().is_empty()) {
        let wide: Vec<u16> = current.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
        if attributes == u32::MAX { return Err(format!("could not inspect Store path {}: {}", current.display(), std::io::Error::last_os_error())); }
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err(format!("Store path crosses a reparse point: {}", current.display())); }
    }
    Ok(())
}

#[cfg(not(windows))]
fn reject_reparse_ancestors(_path: &Path) -> Result<(), String> { Ok(()) }

fn hash_snapshot(files: &[StoreFileEvidence]) -> String {
    use sha2::Digest;
    let bytes = serde_json::to_vec(files).expect("serializing fixed Store evidence is infallible");
    hex::encode(sha2::Sha256::digest(bytes))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("deszo-p6-g0-store-{}-{label}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("production")).unwrap();
        fs::create_dir_all(root.join("host")).unwrap();
        root
    }

    #[test]
    fn guarded_copy_is_exact_and_blocks_production_file_changes_until_release() {
        let root = fixture("guard");
        let store = root.join("production/state.sqlite");
        fs::write(&store, b"database-bytes").unwrap();
        fs::write(root.join("production/state.sqlite-wal"), b"wal-bytes").unwrap();
        fs::write(root.join("production/state.sqlite-shm"), b"transient-shm").unwrap();
        let scratch = root.join("host/preflight");
        let mut guard = guard_and_copy_store(&store, &scratch).unwrap();
        let evidence = guard.evidence().clone();
        assert_eq!(evidence.production_files.len(), 3);
        assert_eq!(evidence.copied_files.len(), 2);
        assert_eq!(fs::read(scratch.join("state.sqlite")).unwrap(), b"database-bytes");
        assert_eq!(fs::read(scratch.join("state.sqlite-wal")).unwrap(), b"wal-bytes");
        assert!(!scratch.join("state.sqlite-shm").exists());
        guard.verify_unchanged().unwrap();

        assert!(OpenOptions::new().write(true).open(&store).is_err(), "GENERIC_READ/FILE_SHARE_READ must refuse a write handle");
        assert!(fs::rename(&store, root.join("production/replaced.sqlite")).is_err(), "the guard must refuse replacement");
        assert!(fs::remove_file(&store).is_err(), "the guard must refuse deletion");

        drop(guard);
        let mut writable = OpenOptions::new().append(true).open(&store).unwrap();
        writable.write_all(b"-resumed").unwrap();
        drop(writable);
        assert!(fs::rename(&store, root.join("production/replaced.sqlite")).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn present_rollback_journal_fails_closed() {
        let root = fixture("journal");
        let store = root.join("production/state.sqlite");
        fs::write(&store, b"database-bytes").unwrap();
        fs::write(root.join("production/state.sqlite-journal"), b"possible-hot-journal").unwrap();
        let result = guard_and_copy_store(&store, &root.join("host/preflight"));
        assert!(result.unwrap_err().contains("rollback journal"));
        assert!(!root.join("host/preflight").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn production_sidecar_drift_is_detected_before_commit() {
        let root = fixture("drift");
        let store = root.join("production/state.sqlite");
        fs::write(&store, b"database-bytes").unwrap();
        let mut guard = guard_and_copy_store(&store, &root.join("host/preflight")).unwrap();
        fs::write(root.join("production/state.sqlite-journal"), b"unexpected").unwrap();
        assert!(guard.verify_unchanged().unwrap_err().contains("file set changed"));
        drop(guard);
        fs::remove_dir_all(root).unwrap();
    }
}

