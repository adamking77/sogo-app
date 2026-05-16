mod pty;

use std::{env, fs, path::PathBuf};

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    const SKIP: &[&str] = &[
        "node_modules", "target", ".git", "dist", ".next",
        "__pycache__", ".turbo", ".cache", "build",
    ];

    let mut entries: Vec<FileEntry> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if SKIP.contains(&name.as_str()) {
                return None;
            }
            let path = entry.path().to_string_lossy().to_string();
            let is_dir = entry.file_type().ok()?.is_dir();
            Some(FileEntry { name, path, is_dir })
        })
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfig {
    supabase_url: Option<String>,
    supabase_anon_key: Option<String>,
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
    }
}

#[tauri::command]
fn read_claude_inventory() -> ClaudeInventory {
    let claude_home = home_dir().join(".claude");

    ClaudeInventory {
        skills: read_skills(&claude_home.join("skills")),
        mcp_servers: read_mcp_servers(&claude_home.join("settings.json")),
    }
}

#[tauri::command]
fn default_session_cwd() -> Result<String, String> {
    let cwd = app_support_dir().join("Sessions").join("scratch");
    fs::create_dir_all(&cwd)
        .map_err(|error| format!("Failed to create scratch session directory: {error}"))?;

    Ok(cwd.to_string_lossy().to_string())
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

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn app_support_dir() -> PathBuf {
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
        .manage(pty::PtyRegistry::default())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_session,
            pty::write_to_session,
            pty::resize_session,
            pty::interrupt_session,
            pty::close_session,
            pty::session_active,
            pty::latest_claude_session_id,
            default_session_cwd,
            read_runtime_config,
            read_claude_inventory,
            list_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sogo Desktop");
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
