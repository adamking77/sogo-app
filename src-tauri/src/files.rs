use std::{
    env, fs, io,
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

use serde::Serialize;
use tauri::State;

use crate::pty::PtyRegistry;

const MAX_TEXT_FILE_BYTES: u64 = 10 * 1024 * 1024;
const BINARY_SAMPLE_BYTES: usize = 8 * 1024;
pub(crate) const SKIP_DIRS: &[&str] = &[
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
    let roots = vault_roots()?;
    let target = resolve_existing_vault_path(&roots, &path)?;
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
    let roots = vault_roots()?;
    let target = resolve_write_vault_path(&roots, &path)?;
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
    // Rename replaces the inode; carry the original permissions (exec bit,
    // custom modes) over to the replacement file.
    if let Some(metadata) = &current_metadata {
        let _ = fs::set_permissions(&temp_path, metadata.permissions());
    }
    fs::rename(&temp_path, &target)
        .map_err(|error| file_error("writeFailed", format!("Could not replace file: {error}")))?;

    let metadata = fs::metadata(&target)
        .map_err(|error| file_error("notFound", format!("Could not stat saved file: {error}")))?;
    Ok(file_meta(&target, &metadata, true))
}

fn vault_roots() -> Result<Vec<PathBuf>, FileCommandError> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| file_error("noVault", "Could not resolve $HOME"))?;
    let candidates = [
        home.join("vault"),
        home.join("Library")
            .join("Mobile Documents")
            .join("iCloud~md~obsidian")
            .join("Documents")
            .join("Obsidian"),
    ];
    let roots: Vec<PathBuf> = candidates
        .into_iter()
        .filter_map(|candidate| candidate.canonicalize().ok())
        .collect();

    if roots.is_empty() {
        Err(file_error(
            "noVault",
            "No local GenZen OS document roots are available",
        ))
    } else {
        Ok(roots)
    }
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
    // Rename replaces the inode; carry the original permissions (exec bit,
    // custom modes) over to the replacement file.
    if let Some(metadata) = &current_metadata {
        let _ = fs::set_permissions(&temp_path, metadata.permissions());
    }
    fs::rename(&temp_path, &target)
        .map_err(|error| file_error("writeFailed", format!("Could not replace file: {error}")))?;

    let metadata = fs::metadata(&target)
        .map_err(|error| file_error("notFound", format!("Could not stat saved file: {error}")))?;
    Ok(file_meta(&target, &metadata, true))
}

#[tauri::command]
pub fn create_workspace_file(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    parent_path: String,
    name: String,
) -> Result<FileMeta, FileCommandError> {
    let root = workspace_root(&registry, &session_id)?;
    let parent = resolve_existing_path(&root, &parent_path)?;
    if !parent.is_dir() {
        return Err(file_error(
            "notDirectory",
            format!("Not a directory: {}", display_path(&parent)),
        ));
    }

    let target = child_path(&parent, &name)?;
    ensure_under_root(&root, &target)?;
    if target.exists() {
        return Err(file_error(
            "exists",
            "A file or folder already exists with that name",
        ));
    }

    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|error| file_error("writeFailed", format!("Could not create file: {error}")))?;

    let metadata = fs::metadata(&target)
        .map_err(|error| file_error("notFound", format!("Could not stat created file: {error}")))?;
    Ok(file_meta(&target, &metadata, true))
}

#[tauri::command]
pub fn create_workspace_directory(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    parent_path: String,
    name: String,
) -> Result<FileEntry, FileCommandError> {
    let root = workspace_root(&registry, &session_id)?;
    let parent = resolve_existing_path(&root, &parent_path)?;
    if !parent.is_dir() {
        return Err(file_error(
            "notDirectory",
            format!("Not a directory: {}", display_path(&parent)),
        ));
    }

    let target = child_path(&parent, &name)?;
    ensure_under_root(&root, &target)?;
    fs::create_dir(&target)
        .map_err(|error| file_error("writeFailed", format!("Could not create folder: {error}")))?;

    Ok(file_entry(&target, true)?)
}

#[tauri::command]
pub fn import_paths_into_workspace(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    target_dir: String,
    source_paths: Vec<String>,
) -> Result<Vec<FileEntry>, FileCommandError> {
    if source_paths.is_empty() {
        return Ok(Vec::new());
    }

    let root = workspace_root(&registry, &session_id)?;
    let target = resolve_existing_path(&root, &target_dir)?;
    if !target.is_dir() {
        return Err(file_error(
            "notDirectory",
            format!("Not a directory: {}", display_path(&target)),
        ));
    }

    let mut imported = Vec::new();
    for source in source_paths {
        let source = PathBuf::from(source);
        let source_metadata = fs::symlink_metadata(&source).map_err(|error| {
            file_error(
                "notFound",
                format!(
                    "Could not read dropped path {}: {error}",
                    display_path(&source)
                ),
            )
        })?;
        if source_metadata.file_type().is_symlink() {
            return Err(file_error("unsupported", "Symlinks cannot be imported"));
        }

        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| file_error("invalidPath", "Imported path has no filename"))?;
        let destination = child_path(&target, name)?;
        ensure_under_root(&root, &destination)?;
        if destination.exists() {
            return Err(file_error(
                "exists",
                format!("{name} already exists in the target folder"),
            ));
        }
        if source_metadata.is_dir() {
            copy_dir_recursive(&source, &destination)?;
            imported.push(file_entry(&destination, true)?);
        } else if source_metadata.is_file() {
            fs::copy(&source, &destination).map_err(|error| {
                file_error("writeFailed", format!("Could not import file: {error}"))
            })?;
            imported.push(file_entry(&destination, false)?);
        } else {
            return Err(file_error(
                "unsupported",
                "Only files and folders can be imported",
            ));
        }
    }

    Ok(imported)
}

const MAX_RECURSIVE_ENTRIES: usize = 4000;

#[tauri::command]
pub fn list_files_recursive(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    max_entries: Option<u32>,
) -> Result<Vec<String>, FileCommandError> {
    let root = workspace_root(&registry, &session_id)?;
    let cap = max_entries
        .map(|value| value as usize)
        .unwrap_or(MAX_RECURSIVE_ENTRIES);

    let mut results = Vec::new();
    let mut stack = vec![root.clone()];

    while let Some(dir) = stack.pop() {
        if results.len() >= cap {
            break;
        }

        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.filter_map(Result::ok) {
            if results.len() >= cap {
                break;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_dir() {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(entry.path());
            } else if file_type.is_file() {
                if let Ok(relative) = entry.path().strip_prefix(&root) {
                    results.push(relative.to_string_lossy().to_string());
                }
            }
        }
    }

    results.sort();
    Ok(results)
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

fn child_path(parent: &Path, name: &str) -> Result<PathBuf, FileCommandError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(file_error("invalidPath", "Name cannot be empty"));
    }

    let candidate = Path::new(trimmed);
    if candidate.is_absolute()
        || candidate.components().count() != 1
        || candidate
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(file_error(
            "invalidPath",
            "Name must be a single file or folder name",
        ));
    }

    Ok(parent.join(candidate))
}

fn file_entry(path: &Path, is_dir: bool) -> Result<FileEntry, FileCommandError> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| file_error("invalidPath", "Path has no filename"))?
        .to_string();
    Ok(FileEntry {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir,
    })
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), FileCommandError> {
    fs::create_dir(destination)
        .map_err(|error| file_error("writeFailed", format!("Could not create folder: {error}")))?;

    for entry in fs::read_dir(source)
        .map_err(|error| file_error("readFailed", format!("Could not read folder: {error}")))?
    {
        let entry = entry.map_err(|error| {
            file_error(
                "readFailed",
                format!("Could not read folder entry: {error}"),
            )
        })?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            file_error(
                "readFailed",
                format!("Could not read imported item: {error}"),
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(file_error("unsupported", "Symlinks cannot be imported"));
        }

        let next_destination = destination.join(entry.file_name());
        if metadata.is_dir() {
            copy_dir_recursive(&entry.path(), &next_destination)?;
        } else if metadata.is_file() {
            fs::copy(entry.path(), &next_destination).map_err(|error| {
                file_error("writeFailed", format!("Could not import file: {error}"))
            })?;
        } else {
            return Err(file_error(
                "unsupported",
                "Only files and folders can be imported",
            ));
        }
    }

    let permissions = fs::metadata(source)
        .map(|metadata| metadata.permissions())
        .map_err(|error: io::Error| {
            file_error(
                "readFailed",
                format!("Could not read folder permissions: {error}"),
            )
        })?;
    let _ = fs::set_permissions(destination, permissions);
    Ok(())
}

fn resolve_existing_vault_path(
    roots: &[PathBuf],
    requested: &str,
) -> Result<PathBuf, FileCommandError> {
    if Path::new(requested).is_absolute() {
        let canonical = Path::new(requested)
            .canonicalize()
            .map_err(|error| file_error("notFound", format!("Path does not exist: {error}")))?;
        ensure_under_any_root(roots, &canonical)?;
        return Ok(canonical);
    }

    let mut last_error = None;
    for root in roots {
        match resolve_existing_path(root, requested) {
            Ok(path) => return Ok(path),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        file_error("noVault", "No local GenZen OS document roots are available")
    }))
}

fn resolve_write_vault_path(
    roots: &[PathBuf],
    requested: &str,
) -> Result<PathBuf, FileCommandError> {
    if Path::new(requested).is_absolute() {
        if Path::new(requested).exists() {
            return resolve_existing_vault_path(roots, requested);
        }

        let parent = Path::new(requested)
            .parent()
            .ok_or_else(|| file_error("invalidPath", "File path has no parent directory"))?
            .canonicalize()
            .map_err(|error| {
                file_error(
                    "notFound",
                    format!("Parent directory does not exist: {error}"),
                )
            })?;
        ensure_under_any_root(roots, &parent)?;
        let file_name = Path::new(requested)
            .file_name()
            .ok_or_else(|| file_error("invalidPath", "File path has no filename"))?;
        return Ok(parent.join(file_name));
    }

    let primary_root = roots
        .first()
        .ok_or_else(|| file_error("noVault", "No local GenZen OS document roots are available"))?;
    resolve_write_path(primary_root, requested)
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

fn ensure_under_any_root(roots: &[PathBuf], target: &Path) -> Result<(), FileCommandError> {
    if roots
        .iter()
        .any(|root| target == root || target.starts_with(root))
    {
        Ok(())
    } else {
        Err(file_error(
            "outsideWorkspace",
            "Path is outside the local GenZen OS document roots",
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

pub(crate) fn file_error(kind: impl Into<String>, message: impl Into<String>) -> FileCommandError {
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

    #[test]
    fn child_path_rejects_nested_or_traversal_names() {
        let root = unique_temp_dir("file-child-path");

        assert!(child_path(&root, "notes.md").unwrap().ends_with("notes.md"));
        assert_eq!(child_path(&root, "../secret.md").unwrap_err().kind, "invalidPath");
        assert_eq!(child_path(&root, "nested/file.md").unwrap_err().kind, "invalidPath");
        assert_eq!(child_path(&root, "").unwrap_err().kind, "invalidPath");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copy_dir_recursive_copies_nested_files() {
        let source = unique_temp_dir("file-import-source");
        let destination_root = unique_temp_dir("file-import-destination");
        let destination = destination_root.join("imported");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("nested").join("notes.md"), "# Notes").unwrap();

        copy_dir_recursive(&source, &destination).unwrap();

        assert_eq!(
            fs::read_to_string(destination.join("nested").join("notes.md")).unwrap(),
            "# Notes"
        );
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(destination_root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn copy_dir_recursive_rejects_symlinks() {
        let source = unique_temp_dir("file-import-symlink-source");
        let destination_root = unique_temp_dir("file-import-symlink-destination");
        let destination = destination_root.join("imported");
        fs::write(source.join("real.md"), "real").unwrap();
        std::os::unix::fs::symlink(source.join("real.md"), source.join("link.md")).unwrap();

        let error = copy_dir_recursive(&source, &destination).unwrap_err();

        assert_eq!(error.kind, "unsupported");
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(destination_root).unwrap();
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
