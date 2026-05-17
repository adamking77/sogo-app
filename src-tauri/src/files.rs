use std::{
    env, fs,
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

use serde::Serialize;
use tauri::State;

use crate::pty::PtyRegistry;

const MAX_TEXT_FILE_BYTES: u64 = 10 * 1024 * 1024;
const BINARY_SAMPLE_BYTES: usize = 8 * 1024;
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    "dist",
    ".next",
    "__pycache__",
    ".turbo",
    ".cache",
    "build",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    path: String,
    size: u64,
    mtime_ms: Option<u128>,
    is_text: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    path: String,
    contents: String,
    meta: FileMeta,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCommandError {
    kind: String,
    message: String,
}

#[tauri::command]
pub fn list_directory(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    path: Option<String>,
) -> Result<Vec<FileEntry>, FileCommandError> {
    let root = workspace_root(&registry, &session_id)?;
    let dir = match path.as_deref().filter(|value| !value.trim().is_empty()) {
        Some(path) => resolve_existing_path(&root, path)?,
        None => root,
    };

    if !dir.is_dir() {
        return Err(file_error(
            "notDirectory",
            format!("Not a directory: {}", display_path(&dir)),
        ));
    }

    let mut entries: Vec<FileEntry> = fs::read_dir(&dir)
        .map_err(|error| file_error("readFailed", format!("Could not read directory: {error}")))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if SKIP_DIRS.contains(&name.as_str()) {
                return None;
            }

            let file_type = entry.file_type().ok()?;
            let path = entry.path().to_string_lossy().to_string();
            Some(FileEntry {
                name,
                path,
                is_dir: file_type.is_dir(),
            })
        })
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
pub fn read_text_file(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    path: String,
) -> Result<FileContent, FileCommandError> {
    let root = workspace_root(&registry, &session_id)?;
    let target = resolve_existing_path(&root, &path)?;
    let metadata = fs::metadata(&target)
        .map_err(|error| file_error("notFound", format!("Could not stat file: {error}")))?;

    if !metadata.is_file() {
        return Err(file_error(
            "notFile",
            format!("Not a file: {}", display_path(&target)),
        ));
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(file_error(
            "tooLarge",
            format!("File is too large to open: {} bytes", metadata.len()),
        ));
    }

    let bytes = fs::read(&target)
        .map_err(|error| file_error("readFailed", format!("Could not read file: {error}")))?;
    ensure_text_bytes(&bytes)?;
    let contents = String::from_utf8(bytes)
        .map_err(|_| file_error("invalidUtf8", "File is not valid UTF-8 text"))?;
    let meta = file_meta(&target, &metadata, true);

    Ok(FileContent {
        path: meta.path.clone(),
        contents,
        meta,
    })
}

#[tauri::command]
pub fn read_vault_file(path: String) -> Result<FileContent, FileCommandError> {
    let root = vault_root()?;
    let target = resolve_existing_path(&root, &path)?;
    let metadata = fs::metadata(&target)
        .map_err(|error| file_error("notFound", format!("Could not stat file: {error}")))?;

    if !metadata.is_file() {
        return Err(file_error(
            "notFile",
            format!("Not a file: {}", display_path(&target)),
        ));
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(file_error(
            "tooLarge",
            format!("File is too large to open: {} bytes", metadata.len()),
        ));
    }

    let bytes = fs::read(&target)
        .map_err(|error| file_error("readFailed", format!("Could not read file: {error}")))?;
    ensure_text_bytes(&bytes)?;
    let contents = String::from_utf8(bytes)
        .map_err(|_| file_error("invalidUtf8", "File is not valid UTF-8 text"))?;
    let meta = file_meta(&target, &metadata, true);

    Ok(FileContent {
        path: meta.path.clone(),
        contents,
        meta,
    })
}

#[tauri::command]
pub fn write_vault_file(
    path: String,
    contents: String,
    expected_mtime_ms: Option<u128>,
) -> Result<FileMeta, FileCommandError> {
    let root = vault_root()?;
    let target = resolve_write_path(&root, &path)?;
    let current_metadata = fs::metadata(&target).ok();

    if let Some(metadata) = &current_metadata {
        if !metadata.is_file() {
            return Err(file_error(
                "notFile",
                format!("Not a file: {}", display_path(&target)),
            ));
        }

        let current_mtime = mtime_ms(metadata);
        if expected_mtime_ms.is_some() && current_mtime != expected_mtime_ms {
            return Err(file_error(
                "conflict",
                "File changed on disk since it was opened",
            ));
        }
    } else if expected_mtime_ms.is_some() {
        return Err(file_error("notFound", "File no longer exists on disk"));
    }

    let parent = target
        .parent()
        .ok_or_else(|| file_error("invalidPath", "File path has no parent directory"))?;
    let temp_path = parent.join(format!(
        ".{}.sogo-tmp-{}-{}",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));

    fs::write(&temp_path, contents.as_bytes()).map_err(|error| {
        file_error("writeFailed", format!("Could not write temp file: {error}"))
    })?;
    fs::rename(&temp_path, &target)
        .map_err(|error| file_error("writeFailed", format!("Could not replace file: {error}")))?;

    let metadata = fs::metadata(&target)
        .map_err(|error| file_error("notFound", format!("Could not stat saved file: {error}")))?;
    Ok(file_meta(&target, &metadata, true))
}

fn vault_root() -> Result<PathBuf, FileCommandError> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| file_error("noVault", "Could not resolve $HOME"))?;
    let candidate = home.join("vault");
    candidate
        .canonicalize()
        .map_err(|error| file_error("noVault", format!("Vault directory unavailable: {error}")))
}

#[tauri::command]
pub fn stat_file(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    path: String,
) -> Result<FileMeta, FileCommandError> {
    let root = workspace_root(&registry, &session_id)?;
    let target = resolve_existing_path(&root, &path)?;
    let metadata = fs::metadata(&target)
        .map_err(|error| file_error("notFound", format!("Could not stat file: {error}")))?;

    Ok(file_meta(&target, &metadata, metadata.is_file()))
}

#[tauri::command]
pub fn write_text_file(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    path: String,
    contents: String,
    expected_mtime_ms: Option<u128>,
) -> Result<FileMeta, FileCommandError> {
    let root = workspace_root(&registry, &session_id)?;
    let target = resolve_write_path(&root, &path)?;
    let current_metadata = fs::metadata(&target).ok();

    if let Some(metadata) = &current_metadata {
        if !metadata.is_file() {
            return Err(file_error(
                "notFile",
                format!("Not a file: {}", display_path(&target)),
            ));
        }

        let current_mtime = mtime_ms(metadata);
        if expected_mtime_ms.is_some() && current_mtime != expected_mtime_ms {
            return Err(file_error(
                "conflict",
                "File changed on disk since it was opened",
            ));
        }
    } else if expected_mtime_ms.is_some() {
        return Err(file_error("notFound", "File no longer exists on disk"));
    }

    let parent = target
        .parent()
        .ok_or_else(|| file_error("invalidPath", "File path has no parent directory"))?;
    let temp_path = parent.join(format!(
        ".{}.sogo-tmp-{}-{}",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));

    fs::write(&temp_path, contents.as_bytes()).map_err(|error| {
        file_error("writeFailed", format!("Could not write temp file: {error}"))
    })?;
    fs::rename(&temp_path, &target)
        .map_err(|error| file_error("writeFailed", format!("Could not replace file: {error}")))?;

    let metadata = fs::metadata(&target)
        .map_err(|error| file_error("notFound", format!("Could not stat saved file: {error}")))?;
    Ok(file_meta(&target, &metadata, true))
}

fn workspace_root(
    registry: &State<'_, PtyRegistry>,
    session_id: &str,
) -> Result<PathBuf, FileCommandError> {
    registry
        .workspace_root(session_id)
        .map_err(|message| file_error("sessionRootMissing", message))
}

fn resolve_existing_path(root: &Path, requested: &str) -> Result<PathBuf, FileCommandError> {
    let candidate = joined_candidate(root, requested)?;
    let canonical = candidate
        .canonicalize()
        .map_err(|error| file_error("notFound", format!("Path does not exist: {error}")))?;
    ensure_under_root(root, &canonical)?;
    Ok(canonical)
}

fn resolve_write_path(root: &Path, requested: &str) -> Result<PathBuf, FileCommandError> {
    let candidate = joined_candidate(root, requested)?;
    if candidate.exists() {
        return resolve_existing_path(root, requested);
    }

    let parent = candidate
        .parent()
        .ok_or_else(|| file_error("invalidPath", "File path has no parent directory"))?
        .canonicalize()
        .map_err(|error| {
            file_error(
                "notFound",
                format!("Parent directory does not exist: {error}"),
            )
        })?;
    ensure_under_root(root, &parent)?;
    let file_name = candidate
        .file_name()
        .ok_or_else(|| file_error("invalidPath", "File path has no filename"))?;
    Ok(parent.join(file_name))
}

fn joined_candidate(root: &Path, requested: &str) -> Result<PathBuf, FileCommandError> {
    let requested_path = Path::new(requested);
    if requested_path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(file_error("outsideWorkspace", "Path cannot contain '..'"));
    }

    if requested_path.is_absolute() {
        Ok(requested_path.to_path_buf())
    } else {
        Ok(root.join(requested_path))
    }
}

fn ensure_under_root(root: &Path, target: &Path) -> Result<(), FileCommandError> {
    if target == root || target.starts_with(root) {
        Ok(())
    } else {
        Err(file_error(
            "outsideWorkspace",
            "Path is outside the session workspace",
        ))
    }
}

fn ensure_text_bytes(bytes: &[u8]) -> Result<(), FileCommandError> {
    if bytes
        .iter()
        .take(BINARY_SAMPLE_BYTES)
        .any(|byte| *byte == 0)
    {
        return Err(file_error(
            "binary",
            "Binary files cannot be opened in the text editor",
        ));
    }

    Ok(())
}

fn file_meta(path: &Path, metadata: &fs::Metadata, is_text: bool) -> FileMeta {
    FileMeta {
        path: path.to_string_lossy().to_string(),
        size: metadata.len(),
        mtime_ms: mtime_ms(metadata),
        is_text,
    }
}

fn mtime_ms(metadata: &fs::Metadata) -> Option<u128> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
}

fn file_error(kind: impl Into<String>, message: impl Into<String>) -> FileCommandError {
    FileCommandError {
        kind: kind.into(),
        message: message.into(),
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, time::SystemTime};

    #[test]
    fn resolves_relative_path_under_root() {
        let root = unique_temp_dir("file-root");
        let file = root.join("notes.md");
        fs::write(&file, "# Notes").unwrap();

        let resolved = resolve_existing_path(&root.canonicalize().unwrap(), "notes.md").unwrap();

        assert_eq!(resolved, file.canonicalize().unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_parent_traversal() {
        let root = unique_temp_dir("file-traversal");

        let error = resolve_existing_path(&root.canonicalize().unwrap(), "../outside").unwrap_err();

        assert_eq!(error.kind, "outsideWorkspace");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_symlink_escape() {
        let root = unique_temp_dir("file-symlink");
        let outside = unique_temp_dir("file-outside");
        fs::write(outside.join("secret.md"), "secret").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("secret.md"), root.join("link.md")).unwrap();
            let error =
                resolve_existing_path(&root.canonicalize().unwrap(), "link.md").unwrap_err();
            assert_eq!(error.kind, "outsideWorkspace");
        }

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn detects_binary_null_bytes() {
        let error = ensure_text_bytes(b"hello\0world").unwrap_err();

        assert_eq!(error.kind, "binary");
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!("sogo-{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
