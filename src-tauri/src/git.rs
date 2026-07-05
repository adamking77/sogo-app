use std::{path::Path, process::Command};

use serde::Serialize;
use tauri::State;

use crate::{
    files::{file_error, FileCommandError},
    pty::{login_shell_env, PtyRegistry},
};

const MAX_DIFF_BYTES: usize = 500 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    status: String,
    path: String,
}

fn git_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    if let Some(path) = login_shell_env().get("PATH") {
        command.env("PATH", path);
    }
    command.arg("-C").arg(root);
    command
}

#[tauri::command]
pub fn git_changed_files(
    registry: State<'_, PtyRegistry>,
    session_id: String,
) -> Result<Vec<GitChange>, FileCommandError> {
    let root = registry
        .workspace_root(&session_id)
        .map_err(|message| file_error("sessionRootMissing", message))?;

    let output = git_command(&root)
        .args(["status", "--porcelain", "-z", "-uall"])
        .output()
        .map_err(|error| file_error("gitUnavailable", format!("Could not run git: {error}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let kind = if output.status.code() == Some(128) {
            "notRepo"
        } else {
            "gitFailed"
        };
        return Err(file_error(
            kind,
            format!("git status failed: {}", stderr.trim()),
        ));
    }

    Ok(parse_porcelain_z(&output.stdout))
}

fn parse_porcelain_z(bytes: &[u8]) -> Vec<GitChange> {
    let text = String::from_utf8_lossy(bytes);
    let mut records = text.split('\0');
    let mut changes = Vec::new();

    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }

        let status = &record[..2];
        let path = &record[3..];

        // Rename/copy records carry the original path as an extra
        // NUL-separated field; consume it and report the new path.
        if status.contains('R') || status.contains('C') {
            let _original = records.next();
        }

        changes.push(GitChange {
            status: status.trim().to_string(),
            path: path.to_string(),
        });
    }

    changes
}

#[tauri::command]
pub fn git_diff_file(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    path: String,
    status: String,
) -> Result<String, String> {
    let root = registry.workspace_root(&session_id)?;

    let output = if status.starts_with('?') {
        // Untracked files: --no-index exits 1 when the files differ, which is
        // the expected success case here.
        git_command(&root)
            .args(["diff", "--no-color", "--no-index", "/dev/null"])
            .arg(&path)
            .output()
            .map_err(|error| format!("Could not run git: {error}"))?
    } else {
        let against_head = git_command(&root)
            .args(["diff", "HEAD", "--no-color", "--"])
            .arg(&path)
            .output()
            .map_err(|error| format!("Could not run git: {error}"))?;

        if against_head.status.success() || !against_head.stdout.is_empty() {
            against_head
        } else {
            // Unborn HEAD (fresh repo): fall back to the index diff.
            git_command(&root)
                .args(["diff", "--no-color", "--"])
                .arg(&path)
                .output()
                .map_err(|error| format!("Could not run git: {error}"))?
        }
    };

    let mut diff = String::from_utf8_lossy(&output.stdout).to_string();

    if diff.is_empty() && !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        if !stderr.is_empty() {
            return Err(format!("git diff failed: {stderr}"));
        }
    }

    if diff.len() > MAX_DIFF_BYTES {
        let mut cut = MAX_DIFF_BYTES;
        while !diff.is_char_boundary(cut) {
            cut -= 1;
        }
        diff.truncate(cut);
        diff.push_str("\n… diff truncated …");
    }

    Ok(diff)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_z_records() {
        let raw = b" M src/App.tsx\0?? notes/new.txt\0R  src/renamed.ts\0src/old.ts\0A  added.rs\0";

        let changes = parse_porcelain_z(raw);

        assert_eq!(
            changes,
            vec![
                GitChange {
                    status: "M".to_string(),
                    path: "src/App.tsx".to_string(),
                },
                GitChange {
                    status: "??".to_string(),
                    path: "notes/new.txt".to_string(),
                },
                GitChange {
                    status: "R".to_string(),
                    path: "src/renamed.ts".to_string(),
                },
                GitChange {
                    status: "A".to_string(),
                    path: "added.rs".to_string(),
                },
            ]
        );
    }

    #[test]
    fn parses_empty_porcelain_output() {
        assert!(parse_porcelain_z(b"").is_empty());
        assert!(parse_porcelain_z(b"\0").is_empty());
    }
}
