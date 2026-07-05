use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::watch;

const OUTPUT_COALESCE_WINDOW: Duration = Duration::from_millis(8);
const OUTPUT_COALESCE_MAX_BYTES: usize = 128 * 1024;

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
    /// Claude session ID from a previous run of this tab, when known.
    claude_session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    session_id: String,
    cwd: String,
    claude_session_id: String,
    resumed: bool,
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

/// Environment captured from an interactive login shell so PTY children see
/// the user's real PATH and exports even when the app is launched from Dock.
pub(crate) fn login_shell_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        match std::process::Command::new(&shell)
            .args(["-lc", "/usr/bin/env -0"])
            .output()
        {
            Ok(output) if output.status.success() => parse_env_output(&output.stdout),
            _ => HashMap::new(),
        }
    })
}

fn parse_env_output(bytes: &[u8]) -> HashMap<String, String> {
    String::from_utf8_lossy(bytes)
        .split('\0')
        .filter_map(|entry| {
            let (key, value) = entry.split_once('=')?;
            if key.is_empty() {
                return None;
            }
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

#[tauri::command]
pub fn spawn_session(
    app: AppHandle,
    registry: State<'_, PtyRegistry>,
    request: SpawnRequest,
) -> Result<SessionInfo, String> {
    let started_at = Instant::now();
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

    // Resolve which Claude session ID to use. A transcript (.jsonl) means we
    // can resume. An aux directory without a transcript means the ID is
    // already registered with Claude but has nothing to resume — reusing it
    // via --session-id makes Claude exit immediately, so mint a fresh ID.
    let requested_claude_id = request
        .claude_session_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| request.session_id.clone());
    let project_dir = claude_project_dir(&canonical_cwd.to_string_lossy());
    let (claude_session_id, resumed) = resolve_claude_session(&project_dir, &requested_claude_id);

    eprintln!(
        "[sogo timing] {} spawn_session start cwd={} claude_id={} resumed={}",
        request.session_id, request.cwd, claude_session_id, resumed
    );

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
    for (key, value) in login_shell_env() {
        command.env(key, value);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    if resumed {
        command.arg("--resume");
    } else {
        command.arg("--session-id");
    }
    command.arg(&claude_session_id);

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to spawn Claude Code: {error}"))?;
    eprintln!(
        "[sogo timing] {} claude spawned after {}ms resumed={}",
        request.session_id,
        started_at.elapsed().as_millis(),
        resumed
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

    let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>();

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(bytes_read) => {
                    if chunk_tx.send(buffer[..bytes_read].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
        // Sender drops here; the emitter thread sees Disconnected and cleans up.
    });

    let emitter_app = app.clone();
    let event_session_id = request.session_id.clone();
    thread::spawn(move || loop {
        let first = match chunk_rx.recv() {
            Ok(chunk) => chunk,
            Err(_) => {
                emit_exit_and_cleanup(&emitter_app, &event_session_id);
                break;
            }
        };

        let mut batch = first;
        let deadline = Instant::now() + OUTPUT_COALESCE_WINDOW;
        let mut disconnected = false;
        while batch.len() < OUTPUT_COALESCE_MAX_BYTES {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match chunk_rx.recv_timeout(deadline - now) {
                Ok(chunk) => batch.extend_from_slice(&chunk),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }

        let data = general_purpose::STANDARD.encode(&batch);
        let _ = emitter_app.emit(
            "pty://data",
            PtyDataEvent {
                session_id: event_session_id.clone(),
                data,
            },
        );

        if disconnected {
            emit_exit_and_cleanup(&emitter_app, &event_session_id);
            break;
        }
    });

    watch::start_workspace_watch(&app, &request.session_id, &canonical_cwd);

    Ok(SessionInfo {
        session_id: request.session_id.clone(),
        cwd: canonical_cwd.to_string_lossy().to_string(),
        claude_session_id,
        resumed,
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
pub fn close_session(
    app: AppHandle,
    registry: State<'_, PtyRegistry>,
    session_id: String,
) -> Result<(), String> {
    let session = registry
        .sessions
        .lock()
        .map_err(|_| "PTY registry lock poisoned".to_string())?
        .remove(&session_id);

    if let Some(session) = session {
        // Graceful shutdown sleeps; keep it off the command thread so closing
        // a tab never blocks the UI.
        thread::spawn(move || shutdown_session(session, true));
    }

    registry
        .roots
        .lock()
        .map_err(|_| "PTY roots lock poisoned".to_string())?
        .remove(&session_id);

    watch::stop_workspace_watch(&app, &session_id);

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
    /// True when any Claude session process is still tracked.
    pub fn has_active_sessions(&self) -> bool {
        self.sessions
            .lock()
            .map(|sessions| !sessions.is_empty())
            .unwrap_or(false)
    }

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
pub fn session_summary(cwd: String, session_id: String) -> Result<Option<String>, String> {
    let path = claude_project_dir(&cwd).join(format!("{session_id}.jsonl"));
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => return Ok(None),
    };

    let mut summary: Option<String> = None;
    let mut first_user_text: Option<String> = None;

    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match value.get("type").and_then(|kind| kind.as_str()) {
            Some("summary") => {
                if let Some(text) = value.get("summary").and_then(|text| text.as_str()) {
                    summary = Some(text.to_string());
                }
            }
            Some("user") if first_user_text.is_none() => {
                first_user_text = extract_user_text(&value);
            }
            _ => {}
        }
    }

    Ok(summary.or_else(|| first_user_text.map(|text| truncate_chars(&text, 60))))
}

fn extract_user_text(value: &serde_json::Value) -> Option<String> {
    let content = value.get("message")?.get("content")?;
    if let Some(text) = content.as_str() {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        return Some(trimmed.to_string());
    }

    for block in content.as_array()? {
        if block.get("type").and_then(|kind| kind.as_str()) == Some("text") {
            if let Some(text) = block.get("text").and_then(|text| text.as_str()) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    None
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max).collect();
    format!("{truncated}…")
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
            let _ = writer.write_all(&[3]);
            let _ = writer.flush();
        }
        thread::sleep(Duration::from_millis(200));
        if let Ok(mut writer) = session.writer.lock() {
            let _ = writer.write_all(&[3]);
            let _ = writer.flush();
        }
        thread::sleep(Duration::from_millis(300));
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

/// Decide which Claude session ID to launch with and whether to resume.
///
/// A transcript (`<id>.jsonl`) means the conversation is resumable. An aux
/// directory (`<id>/`) without a transcript means the ID is registered with
/// Claude but there is nothing to resume — reusing it via `--session-id`
/// makes Claude exit immediately, so mint a fresh ID instead.
fn resolve_claude_session(project_dir: &Path, requested: &str) -> (String, bool) {
    let transcript = project_dir.join(format!("{requested}.jsonl"));
    if transcript.is_file() {
        return (requested.to_string(), true);
    }
    if project_dir.join(requested).exists() {
        return (uuid::Uuid::new_v4().to_string(), false);
    }
    (requested.to_string(), false)
}

fn claude_project_dir(cwd: &str) -> PathBuf {
    // Claude Code encodes every non-alphanumeric character as '-' (slashes,
    // dots, AND spaces — e.g. "Application Support" → "Application-Support").
    let encoded: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
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

        assert!(project_dir.ends_with(PathBuf::from(".claude/projects/-Users-adam-project-one")));
    }

    #[test]
    fn resolve_claude_session_resumes_when_transcript_exists() {
        let dir = unique_temp_dir("resolve-resume");
        fs::write(dir.join("abc.jsonl"), "{}").unwrap();

        let (id, resumed) = resolve_claude_session(&dir, "abc");

        assert_eq!(id, "abc");
        assert!(resumed);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resolve_claude_session_mints_fresh_id_when_only_aux_dir_exists() {
        let dir = unique_temp_dir("resolve-burned");
        fs::create_dir_all(dir.join("abc")).unwrap();

        let (id, resumed) = resolve_claude_session(&dir, "abc");

        assert_ne!(id, "abc");
        assert!(!resumed);
        assert_eq!(id.len(), 36, "fresh id should be a uuid");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resolve_claude_session_keeps_id_when_unused() {
        let dir = unique_temp_dir("resolve-new");

        let (id, resumed) = resolve_claude_session(&dir, "abc");

        assert_eq!(id, "abc");
        assert!(!resumed);
        fs::remove_dir_all(dir).unwrap();
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

    #[test]
    fn parses_null_separated_login_shell_env() {
        let parsed = parse_env_output(b"PATH=/usr/bin:/bin\0HOME=/Users/adam\0EMPTY=\0=bad\0");

        assert_eq!(parsed.get("PATH"), Some(&"/usr/bin:/bin".to_string()));
        assert_eq!(parsed.get("HOME"), Some(&"/Users/adam".to_string()));
        assert_eq!(parsed.get("EMPTY"), Some(&String::new()));
        assert!(!parsed.contains_key(""));
    }

    #[test]
    fn extracts_user_text_from_string_and_blocks() {
        let string_message: serde_json::Value = serde_json::from_str(
            r#"{"type":"user","message":{"content":"  hello world  "}}"#,
        )
        .unwrap();
        assert_eq!(
            extract_user_text(&string_message),
            Some("hello world".to_string())
        );

        let block_message: serde_json::Value = serde_json::from_str(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"x"},{"type":"text","text":"from block"}]}}"#,
        )
        .unwrap();
        assert_eq!(
            extract_user_text(&block_message),
            Some("from block".to_string())
        );
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
