export type SessionStatus = "idle" | "busy" | "awaiting-input" | "stopped" | "error";

export interface SogoTab {
  id: string;
  label: string;
  cwd: string;
  status: SessionStatus;
  claudeSessionId?: string;
  started?: boolean;
  folderChosen?: boolean;
  /** True once the user has renamed the tab; blocks auto-titling. */
  customLabel?: boolean;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  claudeSessionId: string;
  resumed: boolean;
}

export interface RuntimeConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  intellizenLocalAccessKey?: string;
}

export interface SkillSummary {
  name: string;
  description?: string;
  path: string;
}

export interface McpServerSummary {
  name: string;
  status: string;
}

export interface ClaudeInventory {
  skills: SkillSummary[];
  mcpServers: McpServerSummary[];
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FileMeta {
  path: string;
  size: number;
  mtimeMs?: number;
  isText: boolean;
}

export interface FileContent {
  path: string;
  contents: string;
  meta: FileMeta;
}

export interface FileCommandError {
  kind: string;
  message: string;
}

export interface GitChange {
  status: string;
  path: string;
}

export interface FsChangedPayload {
  sessionId: string;
  paths: string[];
}

export interface HookEventPayload {
  sessionId: string;
  event: string;
  message?: string | null;
  cwd?: string | null;
}
