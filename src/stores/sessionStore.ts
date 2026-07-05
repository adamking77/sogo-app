import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { SogoTab } from "@/types";

const MAX_RECENT_FOLDERS = 8;

interface SessionState {
  tabs: SogoTab[];
  activeTabId?: string;
  recentFolders: string[];
  addTab: (cwd: string, options?: { label?: string; folderChosen?: boolean }) => SogoTab;
  closeTab: (id: string) => void;
  setActiveTabId: (id?: string) => void;
  updateTab: (id: string, patch: Partial<SogoTab>) => void;
  moveTab: (fromIndex: number, toIndex: number) => void;
  rememberFolder: (cwd: string) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      tabs: [],
      activeTabId: undefined,
      recentFolders: [],
      addTab: (cwd, options) => {
        const cwdParts = cwd.split("/").filter(Boolean);
        const fallbackLabel = options?.folderChosen === false
          ? `Session ${Date.now().toString().slice(-4)}`
          : cwdParts[cwdParts.length - 1] ?? cwd;
        const label = options?.label ?? fallbackLabel;
        let nextTab: SogoTab | undefined;

        set((state) => {
          nextTab = {
            id: crypto.randomUUID(),
            cwd,
            label,
            status: "busy",
            started: true,
            folderChosen: options?.folderChosen ?? true,
          };

          const recentFolders = nextTab.folderChosen
            ? pushRecent(state.recentFolders, cwd)
            : state.recentFolders;

          return {
            tabs: [...state.tabs, nextTab],
            activeTabId: nextTab.id,
            recentFolders,
          };
        });

        return nextTab!;
      },
      closeTab: (id) => {
        set((state) => {
          const tabs = state.tabs.filter((tab) => tab.id !== id);
          const activeTabId =
            state.activeTabId === id ? tabs[tabs.length - 1]?.id : state.activeTabId;

          return { tabs, activeTabId };
        });
      },
      setActiveTabId: (activeTabId) => set({ activeTabId }),
      updateTab: (id, patch) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
        }));
      },
      moveTab: (fromIndex, toIndex) => {
        set((state) => {
          if (
            fromIndex === toIndex
            || fromIndex < 0
            || toIndex < 0
            || fromIndex >= state.tabs.length
            || toIndex >= state.tabs.length
          ) {
            return {};
          }
          const tabs = [...state.tabs];
          const [moved] = tabs.splice(fromIndex, 1);
          tabs.splice(toIndex, 0, moved);
          return { tabs };
        });
      },
      rememberFolder: (cwd) => {
        set((state) => ({ recentFolders: pushRecent(state.recentFolders, cwd) }));
      },
    }),
    {
      name: "sogo.sessions",
      partialize: (state) => ({
        tabs: state.tabs.map((tab) => ({
          ...tab,
          status: "stopped" as const,
          started: false,
        })),
        activeTabId: state.activeTabId,
        recentFolders: state.recentFolders,
      }),
    },
  ),
);

function pushRecent(recentFolders: string[], cwd: string) {
  return [cwd, ...recentFolders.filter((folder) => folder !== cwd)].slice(0, MAX_RECENT_FOLDERS);
}
