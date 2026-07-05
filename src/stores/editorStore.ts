import { create } from "zustand";

import type { FileCommandError, FileContent, FileMeta } from "@/types";

export type EditorMode = "preview" | "edit";
export type EditorSource = "workspace" | "vault";

export interface EditorSessionState {
  activePath: string | null;
  loadedContent: string;
  buffer: string;
  loadedMtimeMs?: number;
  mode: EditorMode;
  loading: boolean;
  saving: boolean;
  error: string | null;
  conflict: boolean;
  focusWithin: boolean;
  closePrompt: boolean;
  windowVisible: boolean;
  meta?: FileMeta;
  source: EditorSource;
  vaultRelPath?: string;
}

interface EditorState {
  sessions: Record<string, EditorSessionState>;
  openFile: (
    sessionId: string,
    path: string,
    options?: { source?: EditorSource; preserveMode?: boolean },
  ) => Promise<void>;
  handleExternalChange: (sessionId: string, absolutePath: string) => void;
  setBuffer: (sessionId: string, contents: string) => void;
  setMode: (sessionId: string, mode: EditorMode) => void;
  save: (sessionId: string) => Promise<boolean>;
  close: (sessionId: string, options?: { force?: boolean }) => boolean;
  showWindow: (sessionId: string) => void;
  hideWindow: (sessionId: string) => void;
  toggleWindow: (sessionId: string) => void;
  revert: (sessionId: string) => void;
  setFocusWithin: (sessionId: string, focused: boolean) => void;
  setClosePrompt: (sessionId: string, closePrompt: boolean) => void;
  clearError: (sessionId: string) => void;
  isDirty: (sessionId: string) => boolean;
}

const EMPTY_SESSION: EditorSessionState = {
  activePath: null,
  loadedContent: "",
  buffer: "",
  mode: "preview",
  loading: false,
  saving: false,
  error: null,
  conflict: false,
  focusWithin: false,
  closePrompt: false,
  windowVisible: false,
  source: "workspace",
};

export const useEditorStore = create<EditorState>()((set, get) => ({
  sessions: {},

  openFile: async (sessionId, path, options) => {
    const source: EditorSource = options?.source ?? "workspace";
    const previousMode = ensureSession(get, sessionId).mode;
    setSession(set, sessionId, {
      ...ensureSession(get, sessionId),
      activePath: path,
      loading: true,
      error: null,
      conflict: false,
      closePrompt: false,
      windowVisible: true,
      source,
      vaultRelPath: source === "vault" ? path : undefined,
    });

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const content = source === "vault"
        ? await invoke<FileContent>("read_vault_file", { path })
        : await invoke<FileContent>("read_text_file", { sessionId, path });
      const mode: EditorMode = options?.preserveMode
        ? previousMode
        : isMarkdownPath(content.path) ? "preview" : "edit";

      setSession(set, sessionId, {
        ...ensureSession(get, sessionId),
        activePath: content.path,
        loadedContent: content.contents,
        buffer: content.contents,
        loadedMtimeMs: content.meta.mtimeMs,
        meta: content.meta,
        mode,
        loading: false,
        saving: false,
        error: null,
        conflict: false,
        closePrompt: false,
        windowVisible: true,
        source,
        vaultRelPath: source === "vault" ? path : undefined,
      });
    } catch (error) {
      setSession(set, sessionId, {
        ...ensureSession(get, sessionId),
        activePath: path,
        loading: false,
        saving: false,
        error: formatFileError(error),
        windowVisible: true,
        source,
        vaultRelPath: source === "vault" ? path : undefined,
      });
    }
  },

  handleExternalChange: (sessionId, absolutePath) => {
    const session = ensureSession(get, sessionId);
    if (!session.activePath || session.loading || session.saving) return;
    if (session.activePath !== absolutePath) return;

    if (session.buffer !== session.loadedContent) {
      setSession(set, sessionId, {
        ...session,
        error: "File changed on disk while you were editing",
        conflict: true,
      });
      return;
    }

    void get().openFile(sessionId, session.activePath, {
      source: session.source,
      preserveMode: true,
    });
  },

  setBuffer: (sessionId, contents) => {
    setSession(set, sessionId, {
      ...ensureSession(get, sessionId),
      buffer: contents,
      conflict: false,
      error: null,
      closePrompt: false,
    });
  },

  setMode: (sessionId, mode) => {
    setSession(set, sessionId, {
      ...ensureSession(get, sessionId),
      mode,
    });
  },

  save: async (sessionId) => {
    const session = ensureSession(get, sessionId);
    if (!session.activePath || session.saving || session.buffer === session.loadedContent) {
      return true;
    }

    setSession(set, sessionId, {
      ...session,
      saving: true,
      error: null,
      conflict: false,
    });

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const meta = session.source === "vault"
        ? await invoke<FileMeta>("write_vault_file", {
            path: session.vaultRelPath ?? session.activePath,
            contents: session.buffer,
            expectedMtimeMs: session.loadedMtimeMs,
          })
        : await invoke<FileMeta>("write_text_file", {
            sessionId,
            path: session.activePath,
            contents: session.buffer,
            expectedMtimeMs: session.loadedMtimeMs,
          });

      setSession(set, sessionId, {
        ...ensureSession(get, sessionId),
        loadedContent: session.buffer,
        loadedMtimeMs: meta.mtimeMs,
        meta,
        saving: false,
        error: null,
        conflict: false,
        closePrompt: false,
      });
      return true;
    } catch (error) {
      const fileError = parseFileError(error);
      setSession(set, sessionId, {
        ...ensureSession(get, sessionId),
        saving: false,
        error: fileError.message,
        conflict: fileError.kind === "conflict",
      });
      return false;
    }
  },

  close: (sessionId, options) => {
    const session = ensureSession(get, sessionId);
    if (session.activePath && session.buffer !== session.loadedContent && !options?.force) {
      setSession(set, sessionId, { ...session, closePrompt: true });
      return false;
    }

    setSession(set, sessionId, {
      ...EMPTY_SESSION,
      focusWithin: session.focusWithin,
      windowVisible: false,
    });
    return true;
  },

  showWindow: (sessionId) => {
    const session = ensureSession(get, sessionId);
    if (!session.activePath) return;
    setSession(set, sessionId, {
      ...session,
      windowVisible: true,
    });
  },

  hideWindow: (sessionId) => {
    const session = ensureSession(get, sessionId);
    setSession(set, sessionId, {
      ...session,
      windowVisible: false,
      focusWithin: false,
      closePrompt: false,
    });
  },

  toggleWindow: (sessionId) => {
    const session = ensureSession(get, sessionId);
    if (!session.activePath) return;
    setSession(set, sessionId, {
      ...session,
      windowVisible: !session.windowVisible,
      focusWithin: session.windowVisible ? false : session.focusWithin,
      closePrompt: false,
    });
  },

  revert: (sessionId) => {
    const session = ensureSession(get, sessionId);
    setSession(set, sessionId, {
      ...session,
      buffer: session.loadedContent,
      error: null,
      conflict: false,
      closePrompt: false,
    });
  },

  setFocusWithin: (sessionId, focused) => {
    setSession(set, sessionId, {
      ...ensureSession(get, sessionId),
      focusWithin: focused,
    });
  },

  setClosePrompt: (sessionId, closePrompt) => {
    setSession(set, sessionId, {
      ...ensureSession(get, sessionId),
      closePrompt,
    });
  },

  clearError: (sessionId) => {
    setSession(set, sessionId, {
      ...ensureSession(get, sessionId),
      error: null,
      conflict: false,
    });
  },

  isDirty: (sessionId) => {
    const session = ensureSession(get, sessionId);
    return !!session.activePath && session.buffer !== session.loadedContent;
  },
}));

function ensureSession(get: () => EditorState, sessionId: string): EditorSessionState {
  return get().sessions[sessionId] ?? EMPTY_SESSION;
}

function setSession(
  set: (updater: (state: EditorState) => Pick<EditorState, "sessions">) => void,
  sessionId: string,
  session: EditorSessionState,
) {
  set((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: session,
    },
  }));
}

function isMarkdownPath(path: string) {
  return /\.(md|mdx|markdown)$/i.test(path);
}

function parseFileError(error: unknown): FileCommandError {
  if (typeof error === "object" && error && "kind" in error && "message" in error) {
    const typed = error as Partial<FileCommandError>;
    return {
      kind: String(typed.kind ?? "unknown"),
      message: String(typed.message ?? "File operation failed"),
    };
  }

  return {
    kind: "unknown",
    message: String(error),
  };
}

function formatFileError(error: unknown) {
  return parseFileError(error).message;
}
