export type SessionStatus = "idle" | "busy" | "awaiting-input" | "stopped" | "error";

export interface SogoTab {
  id: string;
  label: string;
  cwd: string;
  status: SessionStatus;
  claudeSessionId?: string;
  started?: boolean;
  folderChosen?: boolean;
}

export interface RuntimeConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
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
