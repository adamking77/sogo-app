import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { SogoTab } from "@/types";

interface SessionState {
  tabs: SogoTab[];
  activeTabId?: string;
  addTab: (cwd: string, options?: { label?: string; folderChosen?: boolean }) => SogoTab;
  closeTab: (id: string) => void;
  setActiveTabId: (id?: string) => void;
  updateTab: (id: string, patch: Partial<SogoTab>) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      tabs: [],
      activeTabId: undefined,
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

          return {
            tabs: [...state.tabs, nextTab],
            activeTabId: nextTab.id,
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
      }),
    },
  ),
);
