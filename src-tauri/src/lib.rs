mod files;
mod git;
mod pty;
mod watch;

use std::{
    env, fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::SystemTime,
};

use base64::Engine;
use serde::Serialize;
use tauri::{Emitter, Manager, WebviewWindowBuilder};

/// Set once the user confirms quitting through the in-app dialog, so the
/// ExitRequested handler lets the app terminate.
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

const QUIT_MENU_ID: &str = "sogo-quit";

/// Quit entry point for our custom ⌘Q menu item: exit immediately when no
/// Claude session is running, otherwise surface the in-app confirm dialog.
fn request_quit(app: &tauri::AppHandle) {
    let has_sessions = app.state::<pty::PtyRegistry>().has_active_sessions();
    eprintln!("[sogo lifecycle] menu quit requested has_sessions={has_sessions}");
    if !has_sessions {
        QUIT_CONFIRMED.store(true, Ordering::SeqCst);
        app.exit(0);
        return;
    }

    let _ = app.emit("sogo://exit-requested", ());
    show_or_create_main_window(app, "quit-confirm");
}

fn show_or_create_main_window(app: &tauri::AppHandle, reason: &str) {
    if let Some(window) = app.get_webview_window("main") {
        eprintln!("[sogo lifecycle] showing existing main window reason={reason}");
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }

    eprintln!("[sogo lifecycle] main window missing; recreating reason={reason}");
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
    else {
        eprintln!("[sogo lifecycle] cannot recreate main window: config label main missing");
        return;
    };

    match WebviewWindowBuilder::from_config(app, config).and_then(|builder| builder.build()) {
        Ok(window) => {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        Err(error) => {
            eprintln!("[sogo lifecycle] failed to recreate main window: {error}");
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfig {
    supabase_url: Option<String>,
    supabase_anon_key: Option<String>,
    intellizen_local_access_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillSummary {
    name: String,
    description: Option<String>,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServerSummary {
    name: String,
    status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeInventory {
    skills: Vec<SkillSummary>,
    mcp_servers: Vec<McpServerSummary>,
}

#[tauri::command]
fn read_runtime_config() -> RuntimeConfig {
    load_dotenv_candidates();

    RuntimeConfig {
        supabase_url: env::var("SOGO_SUPABASE_URL")
            .or_else(|_| env::var("SUPABASE_URL"))
            .ok(),
        supabase_anon_key: env::var("SOGO_SUPABASE_ANON_KEY")
            .or_else(|_| env::var("SUPABASE_ANON_KEY"))
            .ok(),
        intellizen_local_access_key: env::var("SOGO_INTELLIZEN_LOCAL_ACCESS_KEY")
            .or_else(|_| env::var("INTELLIZEN_LOCAL_ACCESS_KEY"))
            .or_else(|_| env::var("VITE_INTELLIZEN_LOCAL_ACCESS_KEY"))
            .ok(),
    }
}

#[tauri::command]
fn read_claude_inventory() -> ClaudeInventory {
    let claude_home = home_dir().join(".claude");
    let user_config = home_dir().join(".claude.json");

    ClaudeInventory {
        skills: read_skills(&claude_home.join("skills")),
        mcp_servers: read_mcp_servers(&user_config),
    }
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|error| format!("Could not run open: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Finder could not reveal: {path}"))
    }
}

#[tauri::command]
fn open_path_in_default_app(path: String) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .arg(&path)
        .status()
        .map_err(|error| format!("Could not run open: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Default app could not open: {path}"))
    }
}

#[tauri::command]
fn default_session_cwd() -> Result<String, String> {
    let cwd = app_support_dir().join("Sessions").join("scratch");
    fs::create_dir_all(&cwd)
        .map_err(|error| format!("Failed to create scratch session directory: {error}"))?;

    Ok(cwd.to_string_lossy().to_string())
}

#[tauri::command]
fn save_pasted_image(data_base64: String, extension: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|error| format!("Invalid image data: {error}"))?;

    let ext = extension.trim().trim_start_matches('.');
    let ext = if ext.is_empty() || ext.len() > 8 {
        "png"
    } else {
        ext
    };

    let dir = app_support_dir().join("PastedImages");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create image directory: {error}"))?;

    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let file = dir.join(format!("paste-{stamp}.{ext}"));

    fs::write(&file, &bytes).map_err(|error| format!("Could not write image: {error}"))?;
    Ok(file.to_string_lossy().to_string())
}

fn load_dotenv_candidates() {
    if let Ok(cwd) = env::current_dir() {
        let _ = dotenvy::from_path(cwd.join(".env"));
        let _ = dotenvy::from_path(cwd.join("..").join(".env"));
    }

    let app_config = home_dir()
        .join("Library")
        .join("Application Support")
        .join("Sogo Desktop")
        .join("config.env");
    let _ = dotenvy::from_path(app_config);
}

pub(crate) fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub(crate) fn app_support_dir() -> PathBuf {
    home_dir()
        .join("Library")
        .join("Application Support")
        .join("Sogo Desktop")
}

fn read_skills(skills_dir: &PathBuf) -> Vec<SkillSummary> {
    let entries = match fs::read_dir(skills_dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    let mut skills: Vec<SkillSummary> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|file_type| file_type.is_dir())
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let skill_path = entry.path().join("SKILL.md");
            let fallback_name = entry.file_name().to_string_lossy().to_string();
            let content = fs::read_to_string(&skill_path).ok()?;
            let (name, description) = parse_skill_frontmatter(&content, &fallback_name);

            Some(SkillSummary {
                name,
                description,
                path: skill_path.to_string_lossy().to_string(),
            })
        })
        .collect();

    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    skills
}

fn parse_skill_frontmatter(content: &str, fallback_name: &str) -> (String, Option<String>) {
    if !content.starts_with("---") {
        return (fallback_name.to_string(), first_markdown_paragraph(content));
    }

    let mut name = None;
    let mut description = None;

    for line in content.lines().skip(1) {
        if line.trim() == "---" {
            break;
        }

        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim().trim_matches('"').to_string();
            match key.trim() {
                "name" => name = Some(value),
                "description" => description = Some(value),
                _ => {}
            }
        }
    }

    (
        name.unwrap_or_else(|| fallback_name.to_string()),
        description,
    )
}

fn first_markdown_paragraph(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(ToString::to_string)
}

fn read_mcp_servers(settings_path: &PathBuf) -> Vec<McpServerSummary> {
    let content = match fs::read_to_string(settings_path) {
        Ok(content) => content,
        Err(_) => return Vec::new(),
    };

    let settings: serde_json::Value = match serde_json::from_str(&content) {
        Ok(settings) => settings,
        Err(_) => return Vec::new(),
    };

    let Some(servers) = settings
        .get("mcpServers")
        .and_then(|value| value.as_object())
    else {
        return Vec::new();
    };

    let mut summaries: Vec<McpServerSummary> = servers
        .keys()
        .map(|name| McpServerSummary {
            name: name.to_string(),
            status: "configured".to_string(),
        })
        .collect();

    summaries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    summaries
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::PtyRegistry::default())
        .manage(watch::WatchRegistry::default())
        .setup(|app| {
            // Capturing the login shell environment takes a few hundred ms;
            // warm it before the first session spawn needs it.
            std::thread::spawn(|| {
                let _ = pty::login_shell_env();
            });
            watch::start_hook_events_watch(&app.handle().clone());
            app.set_menu(build_app_menu(app.handle())?)?;
            Ok(())
        })
        // A window close request (native menu, AppleScript, anything) must
        // never destroy the window — hide it instead. Quitting goes through
        // ExitRequested + confirm_quit below.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                eprintln!(
                    "[sogo lifecycle] CloseRequested window={} -> hide",
                    window.label()
                );
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .on_menu_event(|app, event| {
            if event.id() == QUIT_MENU_ID {
                eprintln!("[sogo lifecycle] custom quit menu event");
                request_quit(app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn_session,
            pty::write_to_session,
            pty::resize_session,
            pty::interrupt_session,
            pty::close_session,
            pty::session_active,
            pty::session_summary,
            default_session_cwd,
            save_pasted_image,
            read_runtime_config,
            read_claude_inventory,
            reveal_in_finder,
            open_path_in_default_app,
            confirm_quit,
            watch::enable_claude_hooks,
            watch::claude_hooks_status,
            git::git_changed_files,
            git::git_diff_file,
            files::list_directory,
            files::read_text_file,
            files::stat_file,
            files::write_text_file,
            files::read_vault_file,
            files::write_vault_file,
            files::list_files_recursive
        ])
        .build(tauri::generate_context!())
        .expect("error while building Sogo Desktop")
        .run(|app_handle, event| match event {
            // ⌘Q / last-window-close land here. With running Claude sessions,
            // block the exit and let the frontend show the quit confirm; the
            // confirm_quit command flips QUIT_CONFIRMED and exits for real.
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                eprintln!(
                    "[sogo lifecycle] ExitRequested code={:?} quit_confirmed={}",
                    code,
                    QUIT_CONFIRMED.load(Ordering::SeqCst)
                );
                if code.is_none() && !QUIT_CONFIRMED.load(Ordering::SeqCst) {
                    let has_sessions = app_handle.state::<pty::PtyRegistry>().has_active_sessions();
                    eprintln!("[sogo lifecycle] ExitRequested active_sessions={has_sessions}");
                    if has_sessions {
                        api.prevent_exit();
                        let _ = app_handle.emit("sogo://exit-requested", ());
                        show_or_create_main_window(app_handle, "exit-confirm");
                    }
                }
            }
            // Dock icon clicked while the window is hidden — bring it back.
            tauri::RunEvent::Reopen { .. } => {
                eprintln!("[sogo lifecycle] Reopen");
                show_or_create_main_window(app_handle, "dock-reopen");
            }
            _ => {}
        });
}

#[tauri::command]
fn confirm_quit(app: tauri::AppHandle) {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// The default Tauri menu binds ⌘W to a native "Close Window" item in two
/// submenus. When the webview doesn't consume ⌘W the accelerator closes the
/// real window. This menu is the default minus every close_window item (and
/// the File submenu that only held one); Edit keeps the clipboard bindings.
fn build_app_menu(handle: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};

    let pkg_info = handle.package_info();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        ..Default::default()
    };

    // PredefinedMenuItem::quit sends NSApp `terminate:`, which tao cannot
    // intercept (no applicationShouldTerminate handler) — it would bypass the
    // quit confirm entirely. Use a custom item routed through on_menu_event.
    let quit_item =
        tauri::menu::MenuItemBuilder::with_id(QUIT_MENU_ID, format!("Quit {}", pkg_info.name))
            .accelerator("CmdOrCtrl+Q")
            .build(handle)?;

    let app_menu = Submenu::with_items(
        handle,
        pkg_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(handle, None, Some(about_metadata))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &quit_item,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
        ],
    )?;

    Menu::with_items(handle, &[&app_menu, &edit_menu, &window_menu])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::SystemTime};

    #[test]
    fn parses_skill_frontmatter_name_and_description() {
        let content = r#"---
name: repo-guide
description: "Read repo conventions before editing."
---

# Ignored body
"#;

        let (name, description) = parse_skill_frontmatter(content, "fallback");

        assert_eq!(name, "repo-guide");
        assert_eq!(
            description,
            Some("Read repo conventions before editing.".to_string())
        );
    }

    #[test]
    fn reads_skills_and_mcp_servers_from_claude_inventory_files() {
        let root = unique_temp_dir("inventory");
        let skills_dir = root.join("skills");
        fs::create_dir_all(skills_dir.join("repo-guide")).unwrap();
        fs::write(
            skills_dir.join("repo-guide").join("SKILL.md"),
            "---\nname: repo-guide\ndescription: Repository rules.\n---\n",
        )
        .unwrap();
        fs::write(
            root.join("settings.json"),
            r#"{"mcpServers":{"github":{},"linear":{}}}"#,
        )
        .unwrap();

        let skills = read_skills(&skills_dir);
        let servers = read_mcp_servers(&root.join("settings.json"));

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "repo-guide");
        assert_eq!(skills[0].description, Some("Repository rules.".to_string()));
        assert_eq!(
            servers
                .iter()
                .map(|server| server.name.as_str())
                .collect::<Vec<_>>(),
            vec!["github", "linear"]
        );

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
