use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::files::SKIP_DIRS;

const FLUSH_INTERVAL: Duration = Duration::from_millis(250);
const IDLE_TIMEOUT: Duration = Duration::from_secs(3600);
const HOOK_WATCH_KEY: &str = "__hook-events__";

#[derive(Default)]
pub struct WatchRegistry {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FsChangedEvent {
    session_id: String,
    paths: Vec<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct HookEvent {
    session_id: Option<String>,
    event: Option<String>,
    message: Option<String>,
    cwd: Option<String>,
}

pub fn hook_events_path() -> PathBuf {
    crate::app_support_dir().join("hook-events.jsonl")
}

/// Watch a session's workspace root and emit debounced `fs://changed` events.
/// Replaces any existing watcher for the session (the old one is dropped,
/// which disconnects its flusher thread).
pub fn start_workspace_watch(app: &AppHandle, session_id: &str, root: &Path) {
    let (tx, rx) = mpsc::channel::<PathBuf>();

    let mut watcher = match notify::recommended_watcher(
        move |result: Result<Event, notify::Error>| {
            let Ok(event) = result else { return };
            for path in event.paths {
                if should_skip_path(&path) {
                    continue;
                }
                if tx.send(path).is_err() {
                    return;
                }
            }
        },
    ) {
        Ok(watcher) => watcher,
        Err(error) => {
            eprintln!("[sogo watch] {session_id} failed to create watcher: {error}");
            return;
        }
    };

    if let Err(error) = watcher.watch(root, RecursiveMode::Recursive) {
        eprintln!(
            "[sogo watch] {session_id} failed to watch {}: {error}",
            root.display()
        );
        return;
    }

    let registry = app.state::<WatchRegistry>();
    if let Ok(mut watchers) = registry.watchers.lock() {
        watchers.insert(session_id.to_string(), watcher);
    }

    let flusher_app = app.clone();
    let event_session_id = session_id.to_string();
    thread::spawn(move || {
        let mut pending: HashSet<PathBuf> = HashSet::new();
        let mut deadline: Option<Instant> = None;

        loop {
            let timeout = match deadline {
                Some(at) => at.saturating_duration_since(Instant::now()),
                None => IDLE_TIMEOUT,
            };

            match rx.recv_timeout(timeout) {
                Ok(path) => {
                    pending.insert(path);
                    if deadline.is_none() {
                        deadline = Some(Instant::now() + FLUSH_INTERVAL);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    flush_pending(&flusher_app, &event_session_id, &mut pending);
                    deadline = None;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    flush_pending(&flusher_app, &event_session_id, &mut pending);
                    break;
                }
            }
        }
    });
}

pub fn stop_workspace_watch(app: &AppHandle, session_id: &str) {
    let registry = app.state::<WatchRegistry>();
    let removed = registry
        .watchers
        .lock()
        .ok()
        .and_then(|mut watchers| watchers.remove(session_id));
    drop(removed);
}

fn flush_pending(app: &AppHandle, session_id: &str, pending: &mut HashSet<PathBuf>) {
    if pending.is_empty() {
        return;
    }

    let paths: Vec<String> = pending
        .drain()
        .map(|path| path.to_string_lossy().to_string())
        .collect();

    let _ = app.emit(
        "fs://changed",
        FsChangedEvent {
            session_id: session_id.to_string(),
            paths,
        },
    );
}

fn should_skip_path(path: &Path) -> bool {
    let skipped_component = path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        SKIP_DIRS.contains(&name.as_ref())
    });
    if skipped_component {
        return true;
    }

    // Atomic-save temp files are named ".<name>.sogo-tmp-<pid>-<nanos>".
    path.file_name()
        .map(|name| name.to_string_lossy().contains(".sogo-tmp"))
        .unwrap_or(false)
}

/// Watch the Claude hooks event file and re-emit appended JSON lines as
/// `hooks://event`. Old content present at startup is skipped.
pub fn start_hook_events_watch(app: &AppHandle) {
    let events_path = hook_events_path();
    if let Some(parent) = events_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if !events_path.exists() {
        let _ = fs::write(&events_path, b"");
    }

    let Some(parent) = events_path.parent().map(Path::to_path_buf) else {
        return;
    };

    let offset = Arc::new(Mutex::new(
        fs::metadata(&events_path).map(|meta| meta.len()).unwrap_or(0),
    ));

    let callback_app = app.clone();
    let callback_path = events_path.clone();
    let callback_offset = Arc::clone(&offset);

    let mut watcher = match notify::recommended_watcher(
        move |result: Result<Event, notify::Error>| {
            let Ok(event) = result else { return };
            if !event.paths.iter().any(|path| path == &callback_path) {
                return;
            }
            drain_hook_events(&callback_app, &callback_path, &callback_offset);
        },
    ) {
        Ok(watcher) => watcher,
        Err(error) => {
            eprintln!("[sogo watch] failed to create hook events watcher: {error}");
            return;
        }
    };

    if let Err(error) = watcher.watch(&parent, RecursiveMode::NonRecursive) {
        eprintln!(
            "[sogo watch] failed to watch {}: {error}",
            parent.display()
        );
        return;
    }

    let registry = app.state::<WatchRegistry>();
    let replaced = registry
        .watchers
        .lock()
        .ok()
        .and_then(|mut watchers| watchers.insert(HOOK_WATCH_KEY.to_string(), watcher));
    drop(replaced);
}

fn drain_hook_events(app: &AppHandle, path: &Path, offset: &Mutex<u64>) {
    let Ok(mut guard) = offset.lock() else { return };
    let Ok(metadata) = fs::metadata(path) else { return };

    if metadata.len() < *guard {
        *guard = 0;
    }
    if metadata.len() == *guard {
        return;
    }

    let Ok(mut file) = fs::File::open(path) else { return };
    if file.seek(SeekFrom::Start(*guard)).is_err() {
        return;
    }

    let mut buffer = String::new();
    if file.read_to_string(&mut buffer).is_err() {
        return;
    }

    let mut consumed = 0_usize;
    for line in buffer.split_inclusive('\n') {
        if !line.ends_with('\n') {
            // Partial line still being written; pick it up on the next event.
            break;
        }
        consumed += line.len();

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(event) = parse_hook_event(trimmed) {
            let _ = app.emit("hooks://event", event);
        }
    }

    *guard += consumed as u64;
}

fn parse_hook_event(line: &str) -> Option<HookEvent> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;

    Some(HookEvent {
        session_id: value
            .get("session_id")
            .and_then(|field| field.as_str())
            .map(String::from),
        event: value
            .get("hook_event_name")
            .and_then(|field| field.as_str())
            .map(String::from),
        message: value
            .get("message")
            .and_then(|field| field.as_str())
            .map(String::from),
        cwd: value
            .get("cwd")
            .and_then(|field| field.as_str())
            .map(String::from),
    })
}

#[tauri::command]
pub fn enable_claude_hooks() -> Result<bool, String> {
    let settings_path = crate::home_dir().join(".claude").join("settings.json");
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create ~/.claude: {error}"))?;
    }

    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|error| format!("Could not read settings.json: {error}"))?;
        if content.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&content)
                .map_err(|error| format!("settings.json is not valid JSON: {error}"))?
        }
    } else {
        serde_json::json!({})
    };

    let Some(root) = settings.as_object_mut() else {
        return Err("settings.json root is not a JSON object".to_string());
    };

    let command = format!("{{ cat; echo; }} >> '{}'", hook_events_path().display());

    let hooks = root
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    let Some(hooks) = hooks.as_object_mut() else {
        return Err("settings.json \"hooks\" is not a JSON object".to_string());
    };

    let mut changed = false;
    for event_name in ["Notification", "Stop"] {
        let entries = hooks
            .entry(event_name)
            .or_insert_with(|| serde_json::json!([]));
        let Some(entries) = entries.as_array_mut() else {
            return Err(format!(
                "settings.json hooks.{event_name} is not an array"
            ));
        };

        let already_registered = entries.iter().any(|entry| {
            entry
                .get("hooks")
                .and_then(|hooks| hooks.as_array())
                .map(|hooks| {
                    hooks.iter().any(|hook| {
                        hook.get("command")
                            .and_then(|command| command.as_str())
                            .map(|command| command.contains("hook-events.jsonl"))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        });

        if !already_registered {
            entries.push(serde_json::json!({
                "hooks": [{ "type": "command", "command": command }]
            }));
            changed = true;
        }
    }

    if changed {
        let pretty = serde_json::to_string_pretty(&settings)
            .map_err(|error| format!("Could not serialize settings.json: {error}"))?;
        fs::write(&settings_path, pretty + "\n")
            .map_err(|error| format!("Could not write settings.json: {error}"))?;
    }

    Ok(true)
}

#[tauri::command]
pub fn claude_hooks_status() -> bool {
    let settings_path = crate::home_dir().join(".claude").join("settings.json");
    fs::read_to_string(settings_path)
        .map(|content| content.contains("hook-events.jsonl"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hook_event_line_into_payload() {
        let event = parse_hook_event(
            r#"{"session_id":"abc-123","hook_event_name":"Notification","message":"Claude needs your permission","cwd":"/Users/adam/project","transcript_path":"/tmp/t.jsonl"}"#,
        )
        .expect("event should parse");

        assert_eq!(event.session_id.as_deref(), Some("abc-123"));
        assert_eq!(event.event.as_deref(), Some("Notification"));
        assert_eq!(
            event.message.as_deref(),
            Some("Claude needs your permission")
        );
        assert_eq!(event.cwd.as_deref(), Some("/Users/adam/project"));

        assert!(parse_hook_event("not json").is_none());

        let stop = parse_hook_event(r#"{"session_id":"abc","hook_event_name":"Stop"}"#).unwrap();
        assert_eq!(stop.message, None);
        assert_eq!(stop.event.as_deref(), Some("Stop"));
    }

    #[test]
    fn skips_ignored_paths() {
        assert!(should_skip_path(Path::new(
            "/repo/node_modules/pkg/index.js"
        )));
        assert!(should_skip_path(Path::new("/repo/.git/HEAD")));
        assert!(should_skip_path(Path::new(
            "/repo/.notes.md.sogo-tmp-123-456"
        )));
        assert!(!should_skip_path(Path::new("/repo/src/App.tsx")));
        assert!(!should_skip_path(Path::new("/repo/.claude/settings.json")));
    }
}
