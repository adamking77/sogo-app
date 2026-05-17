use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use base64::{engine::general_purpose, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    roots: Mutex<HashMap<String, PathBuf>>,
}

struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    resume_session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    session_id: String,
    cwd: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyDataEvent {
    session_id: String,
    data: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    session_id: String,
    code: Option<i32>,
}

#[tauri::command]
pub fn spawn_session(
    app: AppHandle,
    registry: State<'_, PtyRegistry>,
    request: SpawnRequest,
) -> Result<SessionInfo, String> {
    eprintln!(
        "[sogo timing] {} spawn_session start cwd={} resume={}",
        request.session_id,
        request.cwd,
        request.resume_session_id.as_deref().unwrap_or("none")
    );
    let started_at = std::time::Instant::now();
    let cwd = PathBuf::from(&request.cwd);
    if !cwd.is_dir() {
        return Err(format!("Working directory does not exist: {}", request.cwd));
    }
    let canonical_cwd = cwd
        .canonicalize()
        .map_err(|error| format!("Failed to resolve working directory: {error}"))?;

    let existing = registry
        .sessions
        .lock()
        .map_err(|_| "PTY registry lock poisoned".to_string())?
        .remove(&request.session_id);
    if let Some(session) = existing {
        shutdown_session(session, false);
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: request.rows.max(8),
            cols: request.cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to open PTY: {error}"))?;

    let claude_path = resolve_claude_binary();
    let mut command = CommandBuilder::new(claude_path);
    command.cwd(&canonical_cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    if let Some(resume_session_id) = request.resume_session_id.as_deref() {
        if !resume_session_id.trim().is_empty() {
            command.arg("--resume");
            command.arg(resume_session_id);
        }
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to spawn Claude Code: {error}"))?;
    eprintln!(
        "[sogo timing] {} claude spawned after {}ms",
        request.session_id,
        started_at.elapsed().as_millis()
    );
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to clone PTY reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to take PTY writer: {error}"))?;

    let session = Arc::new(PtySession {
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        master: Mutex::new(pair.master),
    });

    registry
        .sessions
        .lock()
        .map_err(|_| "PTY registry lock poisoned".to_string())?
        .insert(request.session_id.clone(), session);
    registry
        .roots
        .lock()
        .map_err(|_| "PTY roots lock poisoned".to_string())?
        .insert(request.session_id.clone(), canonical_cwd.clone());

    let event_session_id = request.session_id.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    emit_exit_and_cleanup(&app, &event_session_id);
                    break;
                }
                Ok(bytes_read) => {
                    let data = general_purpose::STANDARD.encode(&buffer[..bytes_read]);
                    let _ = app.emit(
                        "pty://data",
                        PtyDataEvent {
                            session_id: event_session_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => {
                    emit_exit_and_cleanup(&app, &event_session_id);
                    break;
                }
            }
        }
    });

    Ok(SessionInfo {
        session_id: request.session_id,
        cwd: canonical_cwd.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn write_to_session(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let session = get_session(&registry, &session_id)?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "PTY writer lock poisoned".to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Failed to write to PTY: {error}"))
}

#[tauri::command]
pub fn interrupt_session(
    registry: State<'_, PtyRegistry>,
    session_id: String,
) -> Result<(), String> {
    let session = get_session(&registry, &session_id)?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "PTY writer lock poisoned".to_string())?;
    writer
        .write_all(&[3])
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Failed to interrupt PTY: {error}"))
}

#[tauri::command]
pub fn resize_session(
    registry: State<'_, PtyRegistry>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = get_session(&registry, &session_id)?;
    let master = session
        .master
        .lock()
        .map_err(|_| "PTY master lock poisoned".to_string())?;
    master
        .resize(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to resize PTY: {error}"))
}

#[tauri::command]
pub fn close_session(registry: State<'_, PtyRegistry>, session_id: String) -> Result<(), String> {
    let session = registry
        .sessions
        .lock()
        .map_err(|_| "PTY registry lock poisoned".to_string())?
        .remove(&session_id);

    if let Some(session) = session {
        shutdown_session(session, true);
    }
    registry
        .roots
        .lock()
        .map_err(|_| "PTY roots lock poisoned".to_string())?
        .remove(&session_id);

    Ok(())
}

#[tauri::command]
pub fn session_active(
    registry: State<'_, PtyRegistry>,
    session_id: String,
) -> Result<bool, String> {
    let session = registry
        .sessions
        .lock()
        .map_err(|_| "PTY registry lock poisoned".to_string())?
        .get(&session_id)
        .cloned();

    let Some(session) = session else {
        return Ok(false);
    };

    let exited = {
        let mut child = session
            .child
            .lock()
            .map_err(|_| "PTY child lock poisoned".to_string())?;
        match child.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => return Err(format!("Failed to inspect PTY session: {error}")),
        }
    };

    if exited {
        registry
            .sessions
            .lock()
            .map_err(|_| "PTY registry lock poisoned".to_string())?
            .remove(&session_id);
        registry
            .roots
            .lock()
            .map_err(|_| "PTY roots lock poisoned".to_string())?
            .remove(&session_id);
    }

    Ok(!exited)
}

impl PtyRegistry {
    pub fn workspace_root(&self, session_id: &str) -> Result<PathBuf, String> {
        self.roots
            .lock()
            .map_err(|_| "PTY roots lock poisoned".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("No workspace root for tab {session_id}"))
    }
}

#[tauri::command]
pub fn latest_claude_session_id(
    cwd: String,
    since_unix_millis: Option<u64>,
) -> Result<Option<String>, String> {
    let project_dir = claude_project_dir(&cwd);
    let entries = match fs::read_dir(&project_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(None),
    };

    let mut newest: Option<(std::time::SystemTime, String)> = None;
    let recent_cutoff = since_unix_millis
        .map(|millis| std::time::UNIX_EPOCH + Duration::from_millis(millis))
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .checked_sub(Duration::from_secs(10 * 60))
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        });

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified < recent_cutoff {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };

        match &newest {
            Some((current_modified, _)) if *current_modified >= modified => {}
            _ => newest = Some((modified, stem.to_string())),
        }
    }

    Ok(newest.map(|(_, session_id)| session_id))
}

fn get_session(
    registry: &State<'_, PtyRegistry>,
    session_id: &str,
) -> Result<Arc<PtySession>, String> {
    registry
        .sessions
        .lock()
        .map_err(|_| "PTY registry lock poisoned".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("No PTY session for tab {session_id}"))
}

fn shutdown_session(session: Arc<PtySession>, graceful: bool) {
    if graceful {
        if let Ok(mut writer) = session.writer.lock() {
            let _ = writer.write_all(b"/exit\r");
            let _ = writer.flush();
        }

        thread::sleep(Duration::from_secs(2));
    }

    if let Ok(mut child) = session.child.lock() {
        match child.try_wait() {
            Ok(Some(_)) => {}
            _ => {
                let _ = child.kill();
            }
        }
    }
}

fn emit_exit_and_cleanup(app: &AppHandle, session_id: &str) {
    let _ = app.emit(
        "pty://exit",
        PtyExitEvent {
            session_id: session_id.to_string(),
            code: None,
        },
    );

    {
        let registry = app.state::<PtyRegistry>();
        if let Ok(mut sessions) = registry.sessions.lock() {
            sessions.remove(session_id);
        };
        if let Ok(mut roots) = registry.roots.lock() {
            roots.remove(session_id);
        };
    }
}

fn resolve_claude_binary() -> String {
    if let Ok(path) = env::var("CLAUDE_PATH") {
        if !path.trim().is_empty() {
            return path;
        }
    }

    let home = env::var_os("HOME").map(PathBuf::from);
    let mut candidates = Vec::new();

    if let Some(home) = home {
        candidates.push(home.join(".local/bin/claude"));
    }

    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    candidates.push(PathBuf::from("/usr/bin/claude"));

    candidates
        .into_iter()
        .find(|path| is_executable_file(path))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "claude".to_string())
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };

    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        true
    }
}

fn claude_project_dir(cwd: &str) -> PathBuf {
    let encoded = cwd.replace('/', "-");
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".claude")
        .join("projects")
        .join(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::SystemTime};

    #[test]
    fn claude_project_dir_encodes_absolute_cwd() {
        let project_dir = claude_project_dir("/Users/adam/project one");

        assert!(project_dir.ends_with(PathBuf::from(".claude/projects/-Users-adam-project one")));
    }

    #[test]
    fn executable_detection_requires_file_and_execute_bit() {
        let root = unique_temp_dir("exec");
        let executable = root.join("claude");
        let plain = root.join("plain");
        fs::write(&executable, "#!/bin/sh\n").unwrap();
        fs::write(&plain, "not executable").unwrap();

        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&executable, permissions).unwrap();

            let mut plain_permissions = fs::metadata(&plain).unwrap().permissions();
            plain_permissions.set_mode(0o644);
            fs::set_permissions(&plain, plain_permissions).unwrap();
        }

        assert!(is_executable_file(&executable));
        assert!(!is_executable_file(&plain));
        assert!(!is_executable_file(&root));

        fs::remove_dir_all(root).unwrap();
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
