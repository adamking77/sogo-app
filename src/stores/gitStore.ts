import { create } from "zustand";

import { isTauriRuntime } from "@/lib/runtime";
import type { GitChange } from "@/types";

interface GitSessionState {
  changes: GitChange[];
  isRepo: boolean;
  loading: boolean;
}

interface GitState {
  bySession: Record<string, GitSessionState>;
  refresh: (sessionId: string) => Promise<void>;
}

const EMPTY: GitSessionState = { changes: [], isRepo: true, loading: false };

export const useGitStore = create<GitState>()((set, get) => ({
  bySession: {},

  refresh: async (sessionId) => {
    if (!isTauriRuntime() || !sessionId) return;
    const current = get().bySession[sessionId] ?? EMPTY;
    setSession(set, sessionId, { ...current, loading: true });

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const changes = await invoke<GitChange[]>("git_changed_files", { sessionId });
      setSession(set, sessionId, { changes, isRepo: true, loading: false });
    } catch (error) {
      const kind = typeof error === "object" && error && "kind" in error
        ? String((error as { kind?: unknown }).kind)
        : "unknown";
      setSession(set, sessionId, {
        changes: [],
        isRepo: kind !== "notRepo",
        loading: false,
      });
    }
  },
}));

function setSession(
  set: (updater: (state: GitState) => Pick<GitState, "bySession">) => void,
  sessionId: string,
  session: GitSessionState,
) {
  set((state) => ({
    bySession: {
      ...state.bySession,
      [sessionId]: session,
    },
  }));
}

/** Set of workspace-relative changed paths for quick suffix lookups. */
export function changedPathSet(state: GitSessionState | undefined): Set<string> {
  return new Set((state?.changes ?? []).map((change) => change.path));
}
