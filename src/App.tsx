import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import logoSvg from "@/assets/logo.svg";
import { FolderOpen, History, Play, X } from "lucide-react";

import { ChangesPanel } from "@/components/ChangesPanel";
import { CommandPalette, type PaletteCommand, type PaletteMode } from "@/components/CommandPalette";
import { DiffPane } from "@/components/DiffPane";
import { FileEditorPane } from "@/components/FileEditorPane";
import { FilesPanel } from "@/components/FilesPanel";
import { PillBar, statusDotClass, statusLabel, type PanelName } from "@/components/PillBar";
import { SkillsPanel } from "@/components/SkillsPanel";
import { TabStrip } from "@/components/TabStrip";
import { TerminalPane } from "@/components/TerminalPane";
import { ToastHost } from "@/components/ToastHost";
import { VaultPanel } from "@/components/VaultPanel";
import { notifyUser, setAttentionBadge } from "@/lib/notifications";
import { isTauriRuntime } from "@/lib/runtime";
import {
  FILE_EDITOR_DEFAULT_WIDTH,
  PANE_GAP,
  RIGHT_SIDEBAR_WIDTH,
  ResizeHandle,
  TERMINAL_EJECTED_DEFAULT_WIDTH,
  TERMINAL_EJECTED_MIN_WIDTH,
  TERMINAL_MIN_WIDTH_WITH_EDITOR,
  TERMINAL_MIN_WIDTH_SOLO,
  TERMINAL_ONLY_WINDOW_MIN_WIDTH,
  FILE_EDITOR_MIN_WIDTH,
  adjustWindowWidth,
  beginHorizontalPaneResize,
  clampEjectedTerminalWidth,
  clampFileEditorWidth,
  getWindowMinWidth,
  growWindowBy,
  readStoredNumber,
  toggleManualZoom,
  useDragHandler,
  useEjectedTerminalWestResizeHandler,
  useWindowResizeHandler,
  type FileEditorLayout,
} from "@/lib/windowGeometry";
import { useEditorStore } from "@/stores/editorStore";
import { useGitStore, changedPathSet } from "@/stores/gitStore";
import { useSessionStore } from "@/stores/sessionStore";
import { toastError, toastSuccess } from "@/stores/toastStore";
import { applyPalette, palettes, useThemeStore, useResolvedPalette, type PalettePreference } from "@/stores/themeStore";
import type { FsChangedPayload, GitChange, HookEventPayload, SogoTab } from "@/types";

const FONT_SIZE = {
  small: 12,
  medium: 14,
  large: 16,
} as const;

const COMPACT_MAX_WIDTH = 560;

function App() {
  const {
    tabs,
    activeTabId,
    recentFolders,
    addTab,
    closeTab: removeTab,
    setActiveTabId,
    updateTab,
    moveTab,
  } = useSessionStore();
  const idleTimersRef = useRef<Record<string, number>>({});
  const [tabsCollapsed, setTabsCollapsed] = useState(false);
  const [activePanel, setActivePanel] = useState<PanelName | null>(null);
  const [lastOpenedPanel, setLastOpenedPanel] = useState<PanelName>("files");
  const [pinned, setPinned] = useState(() => localStorage.getItem("sogo.windowPinned") === "true");
  const [fileEditorWidth, setFileEditorWidth] = useState(() => readStoredNumber("sogo.fileEditorWidth", FILE_EDITOR_DEFAULT_WIDTH));
  const [terminalPaneWidth, setTerminalPaneWidth] = useState(() => readStoredNumber("sogo.terminalPaneWidth", TERMINAL_EJECTED_DEFAULT_WIDTH));
  const [fileEditorLayout, setFileEditorLayout] = useState<FileEditorLayout>(() => (
    localStorage.getItem("sogo.fileEditorLayout") === "ejected" ? "ejected" : "overlay"
  ));
  const [palette_, setPalette] = useState<{ open: boolean; mode: PaletteMode }>({ open: false, mode: "all" });
  const [confirmingCloseTabId, setConfirmingCloseTabId] = useState<string | null>(null);
  const [quitConfirm, setQuitConfirm] = useState(false);
  const [diffByTab, setDiffByTab] = useState<Record<string, GitChange | undefined>>({});
  const [fsRevisionBySession, setFsRevisionBySession] = useState<Record<string, number>>({});
  const [windowFocused, setWindowFocused] = useState(true);
  const [innerWidth, setInnerWidth] = useState(window.innerWidth);
  const closeConfirmTimerRef = useRef<number | undefined>();
  const { fontSize, setPreference } = useThemeStore();
  const palette = useResolvedPalette();
  const editorSessions = useEditorStore((state) => state.sessions);
  const openFile = useEditorStore((state) => state.openFile);
  const saveEditor = useEditorStore((state) => state.save);
  const closeEditor = useEditorStore((state) => state.close);
  const hideEditorWindow = useEditorStore((state) => state.hideWindow);
  const showEditorWindow = useEditorStore((state) => state.showWindow);
  const setEditorMode = useEditorStore((state) => state.setMode);
  const gitBySession = useGitStore((state) => state.bySession);
  const tauriRuntime = isTauriRuntime();

  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

  useEffect(() => {
    const onResize = () => setInnerWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (!tauriRuntime) return;

    let cancelled = false;
    let registered = false;

    void Promise.all([
      import("@tauri-apps/api/window"),
      import("@tauri-apps/plugin-global-shortcut"),
    ]).then(async ([windowApi, shortcutApi]) => {
      if (cancelled) return;
      const appWindow = windowApi.getCurrentWindow();
      await shortcutApi.register("Alt+Space", async (event) => {
        if (event.state !== "Pressed") return;
        const visible = await appWindow.isVisible();
        if (visible) {
          await appWindow.hide();
        } else {
          await appWindow.show();
          await appWindow.setFocus();
        }
      });
      registered = true;
    }).catch(() => {
      toastError("Could not register Option+Space. Another app may own that shortcut.");
    });

    return () => {
      cancelled = true;
      if (registered) {
        void import("@tauri-apps/plugin-global-shortcut").then(({ unregister }) => {
          void unregister("Alt+Space").catch(() => undefined);
        });
      }
    };
  }, [tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime) return;

    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      void getCurrentWindow().setAlwaysOnTop(pinned);
    });
    localStorage.setItem("sogo.windowPinned", String(pinned));
  }, [pinned, tauriRuntime]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [activeTabId, tabs],
  );
  const activeEditor = activeTab ? editorSessions[activeTab.id] : undefined;
  const activeDiff = activeTab ? diffByTab[activeTab.id] : undefined;
  const editorFileVisible = !!activeEditor?.activePath && activeEditor.windowVisible && !activeDiff;
  const editorVisible = editorFileVisible || !!activeDiff;
  const compact = pinned && innerWidth < COMPACT_MAX_WIDTH;
  const ejectedEditorActive = editorVisible && fileEditorLayout === "ejected";
  const renderedTerminalPaneWidth = ejectedEditorActive
    ? clampEjectedTerminalWidth(terminalPaneWidth, !!activePanel)
    : terminalPaneWidth;
  const renderedFileEditorWidth = editorVisible
    ? clampFileEditorWidth(fileEditorWidth, !!activePanel, fileEditorLayout, renderedTerminalPaneWidth)
    : fileEditorWidth;
  const activeFsRevision = activeTab ? fsRevisionBySession[activeTab.id] ?? 0 : 0;
  const activeChangedPaths = useMemo(
    () => changedPathSet(activeTab ? gitBySession[activeTab.id] : undefined),
    [activeTab, gitBySession],
  );
  const stoppedTabs = useMemo(
    () => tabs.filter((tab) => tab.status === "stopped" && !tab.started),
    [tabs],
  );
  const sessionRunning = !!activeTab && !!activeTab.started
    && activeTab.status !== "stopped" && activeTab.status !== "error";

  useEffect(() => {
    localStorage.setItem("sogo.fileEditorWidth", String(fileEditorWidth));
  }, [fileEditorWidth]);

  useEffect(() => {
    localStorage.setItem("sogo.terminalPaneWidth", String(terminalPaneWidth));
  }, [terminalPaneWidth]);

  useEffect(() => {
    localStorage.setItem("sogo.fileEditorLayout", fileEditorLayout);
  }, [fileEditorLayout]);

  useEffect(() => {
    if (!editorVisible) return;

    const fitWidths = () => {
      if (fileEditorLayout === "ejected") {
        setTerminalPaneWidth((current) => clampEjectedTerminalWidth(current, !!activePanel));
        return;
      }

      setFileEditorWidth((current) => clampFileEditorWidth(current, !!activePanel, fileEditorLayout));
    };

    fitWidths();
    window.addEventListener("resize", fitWidths);
    return () => window.removeEventListener("resize", fitWidths);
  }, [activePanel, editorVisible, fileEditorLayout]);

  // Dock badge mirrors sessions waiting on the user.
  useEffect(() => {
    const attention = tabs.filter((tab) => tab.status === "awaiting-input").length;
    void setAttentionBadge(attention);
  }, [tabs]);

  const newTab = useCallback(async () => {
    if (!tauriRuntime) {
      toastError("Claude sessions require the Tauri desktop runtime. Run pnpm tauri dev.");
      return;
    }

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const cwd = await invoke<string>("default_session_cwd");
      addTab(cwd, { label: `Scratch ${tabs.length + 1}`, folderChosen: false });
    } catch (error) {
      toastError(`Could not start a Claude session: ${String(error)}`);
    }
  }, [addTab, tabs.length, tauriRuntime]);

  const newFolderTab = useCallback(async () => {
    if (!tauriRuntime) {
      toastError("Folder-backed Claude sessions require the Tauri desktop runtime. Run pnpm tauri dev.");
      return;
    }

    try {
      const { open } = await import("@tauri-apps/plugin-dialog");

      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose a project folder",
        defaultPath: recentFolders[0] ? parentDir(recentFolders[0]) : undefined,
      });

      if (!selected || Array.isArray(selected)) return;

      addTab(selected, { folderChosen: true });
    } catch (error) {
      toastError(`Could not start a folder-scoped session: ${String(error)}`);
    }
  }, [addTab, recentFolders, tauriRuntime]);

  const openRecentFolder = useCallback((folder: string) => {
    addTab(folder, { folderChosen: true });
  }, [addTab]);

  const closeTab = useCallback(
    async (id: string) => {
      const editorState = useEditorStore.getState();
      if (!editorState.close(id)) {
        setActiveTabId(id);
        return;
      }

      setDiffByTab((current) => ({ ...current, [id]: undefined }));
      if (tauriRuntime) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("close_session", { sessionId: id }).catch(() => undefined);
      }
      removeTab(id);
    },
    [removeTab, setActiveTabId, tauriRuntime],
  );

  const cancelCloseConfirm = useCallback(() => {
    window.clearTimeout(closeConfirmTimerRef.current);
    setConfirmingCloseTabId(null);
  }, []);

  const requestCloseTab = useCallback(
    (id: string) => {
      const tab = tabs.find((candidate) => candidate.id === id);
      if (!tab) return;
      const running = tab.started && (tab.status === "busy" || tab.status === "awaiting-input" || tab.status === "idle");

      if (running) {
        // Second request (e.g. ⌘W twice) confirms.
        if (confirmingCloseTabId === id) {
          cancelCloseConfirm();
          void closeTab(id);
          return;
        }
        setConfirmingCloseTabId(id);
        window.clearTimeout(closeConfirmTimerRef.current);
        closeConfirmTimerRef.current = window.setTimeout(() => setConfirmingCloseTabId(null), 3500);
      } else {
        void closeTab(id);
      }
    },
    [tabs, confirmingCloseTabId, cancelCloseConfirm, closeTab],
  );

  const confirmCloseTab = useCallback(() => {
    if (!confirmingCloseTabId) return;
    const id = confirmingCloseTabId;
    cancelCloseConfirm();
    void closeTab(id);
  }, [confirmingCloseTabId, cancelCloseConfirm, closeTab]);

  const closeOtherTabs = useCallback(
    (keepId: string) => {
      for (const tab of tabs) {
        if (tab.id !== keepId) void closeTab(tab.id);
      }
    },
    [tabs, closeTab],
  );

  const revealCwd = useCallback((tab: SogoTab) => {
    if (!tauriRuntime) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke("reveal_in_finder", { path: tab.cwd }).catch((error) => toastError(String(error)));
    });
  }, [tauriRuntime]);

  const copySessionId = useCallback((tab: SogoTab) => {
    const id = tab.claudeSessionId ?? tab.id;
    void navigator.clipboard?.writeText(id).then(() => toastSuccess("Copied Claude session ID"));
  }, []);

  const stopActiveTab = useCallback(() => {
    if (!activeTab || !tauriRuntime) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke("interrupt_session", { sessionId: activeTab.id }).catch((error) => toastError(String(error)));
    });
  }, [activeTab, tauriRuntime]);

  const resumeAll = useCallback(() => {
    for (const tab of stoppedTabs) {
      updateTab(tab.id, { started: true, status: "busy" });
    }
  }, [stoppedTabs, updateTab]);

  const prevPanelOpenRef = useRef<boolean>(!!activePanel);
  const hasGrownForEditorRef = useRef<boolean>(false);

  const growForEditor = useCallback(async () => {
    if (hasGrownForEditorRef.current) return;
    hasGrownForEditorRef.current = true;
    await growWindowBy(tauriRuntime, FILE_EDITOR_DEFAULT_WIDTH + PANE_GAP);
  }, [tauriRuntime]);

  const openActiveFile = useCallback(
    async (path: string) => {
      if (!activeTab) {
        toastError("Start a Claude session before opening a file.");
        return;
      }

      setDiffByTab((current) => ({ ...current, [activeTab.id]: undefined }));
      await openFile(activeTab.id, path);
      await growForEditor();
    },
    [activeTab, openFile, growForEditor],
  );

  const openVaultDocument = useCallback(
    async (sourcePath: string) => {
      if (!activeTab) {
        toastError("Start a session before opening a vault document.");
        return;
      }

      setDiffByTab((current) => ({ ...current, [activeTab.id]: undefined }));
      await openFile(activeTab.id, sourcePath, { source: "vault" });
      await growForEditor();
    },
    [activeTab, openFile, growForEditor],
  );

  const openDiff = useCallback(
    async (change: GitChange) => {
      if (!activeTab) return;
      setDiffByTab((current) => ({ ...current, [activeTab.id]: change }));
      await growForEditor();
    },
    [activeTab, growForEditor],
  );

  const closeDiff = useCallback(() => {
    if (!activeTab) return;
    setDiffByTab((current) => ({ ...current, [activeTab.id]: undefined }));
  }, [activeTab]);

  const activateSkill = useCallback(
    (skillName: string) => {
      if (!activeTab) {
        toastError("Start a Claude session before activating a skill.");
        return;
      }

      if (!tauriRuntime) {
        toastError("Skill activation requires the Tauri desktop runtime. Run pnpm tauri dev.");
        return;
      }

      if (activeTab.status === "stopped" || activeTab.status === "error" || !activeTab.started) {
        toastError("Start the active Claude session before activating a skill.");
        return;
      }

      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("write_to_session", {
          sessionId: activeTab.id,
          data: `Use the ${skillName} skill. `,
        }))
        .then(() => window.dispatchEvent(new Event("sogo:focus-terminal")))
        .catch((error) => {
          toastError(`Could not insert ${skillName}: ${String(error)}`);
        });
    },
    [activeTab, tauriRuntime],
  );

  const handleTerminalData = useCallback(
    (tabId: string, text: string) => {
      const status = inferStatusFromOutput(text);
      updateTab(tabId, { status });

      window.clearTimeout(idleTimersRef.current[tabId]);
      if (status === "busy") {
        idleTimersRef.current[tabId] = window.setTimeout(() => {
          updateTab(tabId, { status: "idle" });
        }, 1200);
      }
    },
    [updateTab],
  );

  const handleTerminalExit = useCallback(
    (tabId: string) => {
      window.clearTimeout(idleTimersRef.current[tabId]);
      updateTab(tabId, { status: "stopped", started: false });
    },
    [updateTab],
  );

  const handleTerminalError = useCallback(
    (tabId: string, error: string) => {
      window.clearTimeout(idleTimersRef.current[tabId]);
      updateTab(tabId, { status: "error", started: false });
      toastError(error);
    },
    [updateTab],
  );

  const handleSessionId = useCallback(
    (tabId: string, claudeSessionId: string) => {
      updateTab(tabId, { claudeSessionId });
    },
    [updateTab],
  );

  const notifyAttention = useCallback(
    (tab: SogoTab, message?: string | null) => {
      const backgrounded = !windowFocused || tab.id !== activeTab?.id;
      if (backgrounded) {
        void notifyUser(tab.label, message || "Claude needs your input");
      }
    },
    [windowFocused, activeTab],
  );

  const handleBell = useCallback(
    (tabId: string) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      window.clearTimeout(idleTimersRef.current[tabId]);
      updateTab(tabId, { status: "awaiting-input" });
      notifyAttention(tab);
    },
    [tabs, updateTab, notifyAttention],
  );

  // Claude Code hooks (Notification / Stop) — the reliable status source when
  // enabled. Session IDs match tab IDs because we assign them at spawn.
  useEffect(() => {
    if (!tauriRuntime) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      if (cancelled) return;
      unlisten = await listen<HookEventPayload>("hooks://event", (event) => {
        if (cancelled) return;
        const { sessionId, event: hookEvent, message } = event.payload;
        const state = useSessionStore.getState();
        const tab = state.tabs.find((candidate) => candidate.id === sessionId);
        if (!tab) return;

        if (hookEvent === "Notification") {
          window.clearTimeout(idleTimersRef.current[tab.id]);
          state.updateTab(tab.id, { status: "awaiting-input" });
          notifyAttention(tab, message);
        } else if (hookEvent === "Stop") {
          window.clearTimeout(idleTimersRef.current[tab.id]);
          state.updateTab(tab.id, { status: "idle" });
          const backgrounded = !document.hasFocus() || tab.id !== useSessionStore.getState().activeTabId;
          if (backgrounded) {
            void notifyUser(tab.label, "Claude finished");
          }
        }
      });
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [tauriRuntime, notifyAttention]);

  // Filesystem watcher: refresh file tree, git status, and the open editor
  // buffer when Claude (or anything else) writes to the workspace.
  useEffect(() => {
    if (!tauriRuntime) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      if (cancelled) return;
      unlisten = await listen<FsChangedPayload>("fs://changed", (event) => {
        if (cancelled) return;
        const { sessionId, paths } = event.payload;
        setFsRevisionBySession((current) => ({
          ...current,
          [sessionId]: (current[sessionId] ?? 0) + 1,
        }));
        void useGitStore.getState().refresh(sessionId);
        const editorState = useEditorStore.getState();
        for (const path of paths) {
          editorState.handleExternalChange(sessionId, path);
        }
      });
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [tauriRuntime]);

  // Quit confirm: intercept window close while sessions are running.
  const quitConfirmRef = useRef(false);
  useEffect(() => {
    if (!tauriRuntime) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      if (cancelled) return;
      unlisten = await getCurrentWindow().onCloseRequested((event) => {
        const running = useSessionStore.getState().tabs.some(
          (tab) => tab.started && tab.status !== "stopped" && tab.status !== "error",
        );
        if (running && !quitConfirmRef.current) {
          event.preventDefault();
          setQuitConfirm(true);
        }
      });
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [tauriRuntime]);

  const confirmQuit = useCallback(() => {
    quitConfirmRef.current = true;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      void getCurrentWindow().destroy();
    });
  }, []);

  // Auto-title scratch tabs from the Claude session summary once they go idle.
  const prevStatusesRef = useRef<Record<string, SogoTab["status"]>>({});
  useEffect(() => {
    if (!tauriRuntime) return;
    const previous = prevStatusesRef.current;

    for (const tab of tabs) {
      const was = previous[tab.id];
      previous[tab.id] = tab.status;
      if (tab.status !== "idle" || was === "idle" || was === undefined) continue;
      if (tab.folderChosen || tab.customLabel || !tab.started) continue;

      void import("@tauri-apps/api/core").then(({ invoke }) => {
        void invoke<string | null>("session_summary", { cwd: tab.cwd, sessionId: tab.id })
          .then((summary) => {
            if (!summary) return;
            const label = summary.length > 32 ? `${summary.slice(0, 31)}…` : summary;
            const current = useSessionStore.getState().tabs.find((candidate) => candidate.id === tab.id);
            if (current && !current.customLabel && current.label !== label) {
              updateTab(tab.id, { label });
            }
          })
          .catch(() => undefined);
      });
    }
  }, [tabs, tauriRuntime, updateTab]);

  const runWindowAction = useCallback(
    (action: "close" | "hide" | "minimize" | "zoom") => {
      if (!tauriRuntime) return;
      if (action === "zoom") {
        void toggleManualZoom(tauriRuntime);
        return;
      }
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        if (action === "close") return appWindow.close();
        if (action === "hide") return appWindow.hide();
        return appWindow.minimize();
      });
    },
    [tauriRuntime],
  );

  const toggleTabs = useCallback(() => {
    setTabsCollapsed((current) => !current);
  }, []);

  useEffect(() => {
    if (activePanel) setLastOpenedPanel(activePanel);
  }, [activePanel]);

  const togglePanel = useCallback((panel: PanelName) => {
    setActivePanel((current) => (current === panel ? null : panel));
  }, []);

  const toggleSidebar = useCallback(() => {
    togglePanel(activePanel ?? lastOpenedPanel);
  }, [activePanel, lastOpenedPanel, togglePanel]);

  const beginFileEditorResize = useCallback((event: React.MouseEvent) => {
    beginHorizontalPaneResize(event, renderedFileEditorWidth, (nextWidth) => {
      setFileEditorWidth(clampFileEditorWidth(nextWidth, !!activePanel, fileEditorLayout, renderedTerminalPaneWidth));
    }, { invert: true });
  }, [activePanel, fileEditorLayout, renderedFileEditorWidth, renderedTerminalPaneWidth]);

  // Ejected mode: terminal column is fixed-width, file-view column is flex-1.
  const beginTerminalDividerResize = useCallback((event: React.MouseEvent) => {
    beginHorizontalPaneResize(event, renderedTerminalPaneWidth, (nextWidth) => {
      setTerminalPaneWidth(clampEjectedTerminalWidth(nextWidth, !!activePanel));
    });
  }, [activePanel, renderedTerminalPaneWidth]);

  const toggleFileEditorLayout = useCallback(() => {
    setFileEditorLayout((current) => (current === "ejected" ? "overlay" : "ejected"));
  }, []);

  // Grow/shrink the window when the sidebar opens/closes.
  useEffect(() => {
    if (!tauriRuntime) return;

    const prevPanel = prevPanelOpenRef.current;
    const panelOpened = !prevPanel && !!activePanel;
    const panelClosed = prevPanel && !activePanel;
    prevPanelOpenRef.current = !!activePanel;

    if (!panelOpened && !panelClosed) return;

    const deltaW = panelOpened ? RIGHT_SIDEBAR_WIDTH + PANE_GAP : -(RIGHT_SIDEBAR_WIDTH + PANE_GAP);
    const minW = getWindowMinWidth(editorVisible, !!activePanel, fileEditorLayout);
    void adjustWindowWidth(tauriRuntime, deltaW, minW);
  }, [activePanel, editorVisible, fileEditorLayout, tauriRuntime]);

  const openPalette = useCallback((mode: PaletteMode = "all") => {
    setPalette({ open: true, mode });
  }, []);

  const closePalette = useCallback(() => {
    setPalette((current) => ({ ...current, open: false }));
    window.dispatchEvent(new Event("sogo:focus-terminal"));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;

      if (e.key === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setPalette((current) => (current.open ? { ...current, open: false } : { open: true, mode: "all" }));
        return;
      }
      if (e.key === "p" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openPalette("files");
        return;
      }

      if (activeTab && activeEditor?.focusWithin && activeEditor.activePath) {
        if (e.key === "s") {
          e.preventDefault();
          void saveEditor(activeTab.id);
          return;
        }
        if (e.key === "w") {
          e.preventDefault();
          if (closeEditor(activeTab.id)) {
            window.dispatchEvent(new Event("sogo:focus-terminal"));
          }
          return;
        }
      }

      if (e.key === "e" && activeTab && activeEditor?.activePath && activeEditor.windowVisible) {
        const isMarkdown = /\.(md|mdx|markdown)$/i.test(activeEditor.activePath);
        if (isMarkdown) {
          e.preventDefault();
          setEditorMode(activeTab.id, activeEditor.mode === "preview" ? "edit" : "preview");
          return;
        }
      }

      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        void newTab();
        return;
      }
      if (e.key === "w") {
        e.preventDefault();
        if (activeDiff) {
          closeDiff();
          return;
        }
        if (activeTab) requestCloseTab(activeTab.id);
        return;
      }
      const digit = parseInt(e.key, 10);
      if (digit >= 1 && digit <= 9 && tabs[digit - 1]) {
        e.preventDefault();
        setActiveTabId(tabs[digit - 1].id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    newTab,
    requestCloseTab,
    activeTab,
    activeEditor,
    activeDiff,
    closeDiff,
    tabs,
    setActiveTabId,
    saveEditor,
    closeEditor,
    setEditorMode,
    openPalette,
  ]);

  const dragHandler = useDragHandler(tauriRuntime);
  const terminalMinWidth = editorVisible ? TERMINAL_MIN_WIDTH_WITH_EDITOR : TERMINAL_MIN_WIDTH_SOLO;
  const windowMinWidth = getWindowMinWidth(editorVisible, !!activePanel, fileEditorLayout);
  const beginEjectedWestWindowResize = useEjectedTerminalWestResizeHandler(
    tauriRuntime,
    windowMinWidth,
    renderedTerminalPaneWidth,
    !!activePanel,
    setTerminalPaneWidth,
  );
  const beginEjectedEastWindowResize = useWindowResizeHandler(tauriRuntime, "East", windowMinWidth);
  const mainShellMinWidth = ejectedEditorActive
    ? TERMINAL_EJECTED_MIN_WIDTH
    : editorVisible
    ? TERMINAL_MIN_WIDTH_WITH_EDITOR + FILE_EDITOR_MIN_WIDTH + PANE_GAP
    : TERMINAL_ONLY_WINDOW_MIN_WIDTH;

  const editorChip = activeEditor?.activePath && !activeEditor.windowVisible
    ? {
        name: activeEditor.activePath.split("/").filter(Boolean).pop() ?? activeEditor.activePath,
        dirty: activeEditor.buffer !== activeEditor.loadedContent,
      }
    : null;

  const paletteExtraCommands = useMemo<PaletteCommand[]>(() => {
    const commands: PaletteCommand[] = [
      {
        id: "toggle-sidebar",
        label: activePanel ? "Hide sidebar" : "Show sidebar",
        keywords: "sidebar panel toggle files vault skills changes",
        icon: <FolderOpen size={13} />,
        run: toggleSidebar,
      },
      {
        id: "toggle-pin",
        label: pinned ? "Unpin window" : "Pin window on top",
        keywords: "pin float always on top",
        icon: <History size={13} />,
        run: () => setPinned((current) => !current),
      },
      {
        id: "toggle-tabs",
        label: tabsCollapsed ? "Show tab strip" : "Hide tab strip",
        keywords: "tabs strip collapse",
        icon: <History size={13} />,
        run: toggleTabs,
      },
      {
        id: "zoom",
        label: "Zoom window",
        keywords: "zoom maximize fill screen",
        icon: <History size={13} />,
        run: () => void toggleManualZoom(tauriRuntime),
      },
    ];

    if (stoppedTabs.length > 0) {
      commands.push({
        id: "resume-all",
        label: `Resume all sessions (${stoppedTabs.length})`,
        keywords: "resume restart sessions all",
        icon: <Play size={13} />,
        run: resumeAll,
      });
    }

    const themePrefs: PalettePreference[] = ["system", ...Object.keys(palettes) as PalettePreference[]];
    for (const pref of themePrefs) {
      commands.push({
        id: `theme-${pref}`,
        label: `Theme: ${pref === "system" ? "System" : palettes[pref as keyof typeof palettes].label}`,
        keywords: `theme palette appearance ${pref}`,
        icon: <History size={13} />,
        run: () => setPreference(pref),
      });
    }

    return commands;
  }, [activePanel, pinned, tabsCollapsed, stoppedTabs.length, tauriRuntime, toggleSidebar, toggleTabs, resumeAll, setPreference]);

  return (
    <div className="relative flex h-full w-full gap-2 bg-transparent text-cc-foreground">
      <div
        className={`relative flex h-full min-h-[540px] min-w-0 flex-col overflow-hidden rounded-[20px] border border-cc-border bg-cc-background/95 ${
          ejectedEditorActive ? "shrink-0 shadow-[-18px_18px_58px_-34px_rgba(0,0,0,0.72)]" : "flex-1"
        }`}
        style={{
          minWidth: mainShellMinWidth,
          width: ejectedEditorActive ? renderedTerminalPaneWidth : undefined,
          flex: ejectedEditorActive ? "0 0 auto" : undefined,
        }}
      >
        {/* Childless drag strip — transparent, cursor-only; data-tauri-drag-region fires reliably here because no interactive child intercepts mousedown */}
        <div
          className="h-2 w-full shrink-0 cursor-grab"
          data-tauri-drag-region
          onMouseDown={dragHandler}
          onDoubleClick={() => runWindowAction("zoom")}
        />
        <header
          className="flex h-10 shrink-0 items-center bg-cc-surface/80"
          data-tauri-drag-region
          onMouseDown={dragHandler}
          onDoubleClick={(event) => {
            if ((event.target as HTMLElement).closest("button, input, [role='tab']")) return;
            runWindowAction("zoom");
          }}
        >
          <TrafficLights
            focused={windowFocused}
            onClose={() => runWindowAction("close")}
            onMinimize={() => runWindowAction("minimize")}
            onZoom={() => runWindowAction("zoom")}
          />
          <div className="flex h-full shrink-0 items-center pl-1 pr-2">
            <img src={logoSvg} alt="Sogo" className="h-6 w-6 rounded-md" />
          </div>

          <div className="min-w-0 flex-1">
            {compact ? (
              activeTab ? (
                <div className="flex items-center gap-2 px-1 text-xs text-cc-muted">
                  <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(activeTab.status)}`} />
                  <span className="truncate">{activeTab.label}</span>
                </div>
              ) : null
            ) : (
              <TabStrip
                tabs={tabs}
                activeTabId={activeTab?.id}
                collapsed={tabsCollapsed}
                onSelect={setActiveTabId}
                onNewTab={newTab}
                onClose={requestCloseTab}
                onCloseOthers={closeOtherTabs}
                onRename={(id, label) => updateTab(id, { label, customLabel: true })}
                onMove={moveTab}
                onRevealCwd={revealCwd}
                onCopySessionId={copySessionId}
                onShowAllTabs={() => openPalette("all")}
              />
            )}
          </div>
        </header>

        <main className="flex min-h-0 flex-1 overflow-hidden">
          <section
            className="flex min-w-0 flex-1 flex-col"
            style={{ minWidth: editorVisible && !ejectedEditorActive ? terminalMinWidth : 0 }}
          >
            <div className="relative min-h-0 flex-1 bg-[color:var(--cc-background)]">
              {tabs.length === 0 ? (
                <EmptyState
                  runtimeReady={tauriRuntime}
                  recentFolders={recentFolders}
                  onNewTab={newTab}
                  onNewFolderTab={newFolderTab}
                  onOpenRecent={openRecentFolder}
                />
              ) : (
                <>
                  {tabs.map((tab) => (
                    <TerminalPane
                      key={tab.id}
                      tab={tab}
                      active={tab.id === activeTab?.id}
                      palette={palette}
                      fontSize={FONT_SIZE[fontSize]}
                      onData={handleTerminalData}
                      onExit={handleTerminalExit}
                      onError={handleTerminalError}
                      onStarted={(tabId) => updateTab(tabId, { started: true, status: "busy" })}
                      onSessionId={handleSessionId}
                      onBell={handleBell}
                      onOpenFile={(path) => void openActiveFile(path)}
                    />
                  ))}
                </>
              )}
            </div>
            {!compact ? (
              <PillBar
                tab={activeTab}
                activePanel={activePanel}
                pinned={pinned}
                tabsCollapsed={tabsCollapsed}
                stoppedCount={stoppedTabs.length}
                confirmingClose={!!activeTab && confirmingCloseTabId === activeTab.id}
                editorChip={editorChip}
                onRequestClose={() => activeTab && requestCloseTab(activeTab.id)}
                onConfirmClose={confirmCloseTab}
                onCancelClose={cancelCloseConfirm}
                onStop={stopActiveTab}
                onNewTab={() => void newTab()}
                onNewFolderTab={() => void newFolderTab()}
                onTogglePanel={togglePanel}
                onTogglePin={() => setPinned((current) => !current)}
                onToggleTabs={toggleTabs}
                onResumeAll={resumeAll}
                onShowEditor={() => {
                  if (!activeTab) return;
                  closeDiff();
                  showEditorWindow(activeTab.id);
                }}
                onOpenPalette={() => openPalette("all")}
              />
            ) : null}
          </section>
          {activeTab && editorVisible && !ejectedEditorActive ? (
            <div
              className="relative z-10 min-h-0 shrink-0 pr-2"
              style={{ width: renderedFileEditorWidth, marginLeft: -10 }}
              data-tauri-drag-region
              onMouseDown={dragHandler}
            >
              {activeDiff ? (
                <DiffPane
                  sessionId={activeTab.id}
                  change={activeDiff}
                  fsRevision={activeFsRevision}
                  onClose={closeDiff}
                  onOpenFile={(relativePath) => void openActiveFile(relativePath)}
                  onDragMouseDown={dragHandler}
                  onBeginResize={beginFileEditorResize}
                />
              ) : (
                <FileEditorPane
                  sessionId={activeTab.id}
                  cwd={activeTab.cwd}
                  layout={fileEditorLayout}
                  onDragMouseDown={dragHandler}
                  onBeginResize={beginFileEditorResize}
                  onResetWidth={() => setFileEditorWidth(FILE_EDITOR_DEFAULT_WIDTH)}
                  onToggleLayout={toggleFileEditorLayout}
                  onHide={() => hideEditorWindow(activeTab.id)}
                />
              )}
            </div>
          ) : null}
        </main>
        {ejectedEditorActive ? (
          <>
            {/* Terminal column — left (outer) edge and right (divider) edge. */}
            <div
              className="absolute inset-y-4 left-0 z-40 w-3 cursor-w-resize"
              onMouseDown={beginEjectedWestWindowResize}
              title="Resize window"
              aria-label="Resize window"
            />
            <div
              className="absolute inset-y-4 right-0 z-40 w-3 cursor-col-resize"
              onMouseDown={beginTerminalDividerResize}
              onDoubleClick={() => setTerminalPaneWidth(TERMINAL_EJECTED_DEFAULT_WIDTH)}
              title="Resize terminal column"
              aria-label="Resize terminal column"
            />
          </>
        ) : null}

        <ToastHost />

        <CommandPalette
          open={palette_.open}
          mode={palette_.mode}
          onClose={closePalette}
          tabs={tabs}
          activeTabId={activeTab?.id}
          recentFolders={recentFolders}
          sessionId={activeTab?.id}
          folderChosen={activeTab?.folderChosen ?? false}
          onSelectTab={setActiveTabId}
          onNewSession={() => void newTab()}
          onOpenFolderDialog={() => void newFolderTab()}
          onOpenRecentFolder={openRecentFolder}
          onOpenFile={(path) => void openActiveFile(path)}
          onActivateSkill={activateSkill}
          extraCommands={paletteExtraCommands}
        />

        {quitConfirm ? (
          <QuitConfirm
            runningCount={tabs.filter((tab) => tab.started && tab.status !== "stopped" && tab.status !== "error").length}
            onCancel={() => setQuitConfirm(false)}
            onQuit={confirmQuit}
          />
        ) : null}

        {compact && activeTab ? (
          <button
            className="absolute bottom-3 right-3 z-40 flex h-7 items-center gap-1.5 rounded-full border border-cc-border bg-cc-surface/90 px-2.5 text-[10.5px] text-cc-muted shadow-lg transition-colors hover:text-cc-foreground"
            onClick={() => openPalette("all")}
            title="Command palette (⌘K)"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(activeTab.status)}`} />
            {statusLabel(activeTab.status)}
          </button>
        ) : null}
      </div>

      {activeTab && editorVisible && ejectedEditorActive ? (
        <div
          className="relative z-10 h-full min-h-0 min-w-0 flex-1"
          style={{ minWidth: FILE_EDITOR_MIN_WIDTH }}
          data-tauri-drag-region
          onMouseDown={dragHandler}
        >
          {activeDiff ? (
            <DiffPane
              sessionId={activeTab.id}
              change={activeDiff}
              fsRevision={activeFsRevision}
              onClose={closeDiff}
              onOpenFile={(relativePath) => void openActiveFile(relativePath)}
              onDragMouseDown={dragHandler}
              onBeginResize={beginTerminalDividerResize}
            />
          ) : (
            <FileEditorPane
              sessionId={activeTab.id}
              cwd={activeTab.cwd}
              layout={fileEditorLayout}
              onDragMouseDown={dragHandler}
              onBeginResize={beginTerminalDividerResize}
              onResetWidth={() => setTerminalPaneWidth(TERMINAL_EJECTED_DEFAULT_WIDTH)}
              onToggleLayout={toggleFileEditorLayout}
              onHide={() => hideEditorWindow(activeTab.id)}
            />
          )}
          {/* File-view column — right (outer) edge; left edge handle is inside the pane. */}
          <div
            className="absolute inset-y-4 right-0 z-40 w-3 cursor-e-resize"
            onMouseDown={beginEjectedEastWindowResize}
            title="Resize window"
            aria-label="Resize window"
          />
        </div>
      ) : null}

      {activePanel && !compact ? (
        <PanelWindow
          activePanel={activePanel}
          onClose={() => setActivePanel(null)}
          tauriRuntime={tauriRuntime}
        >
          {activePanel === "vault" ? (
            <VaultPanel
              onOpenDocument={(sourcePath) => void openVaultDocument(sourcePath)}
              activePath={activeEditor?.source === "vault" ? activeEditor.vaultRelPath ?? activeEditor.activePath ?? null : null}
            />
          ) : activePanel === "skills" ? (
            <SkillsPanel sessionRunning={sessionRunning} onActivateSkill={activateSkill} />
          ) : activePanel === "changes" ? (
            <ChangesPanel
              sessionId={activeTab?.id ?? ""}
              folderChosen={activeTab?.folderChosen ?? false}
              activeDiffPath={activeDiff?.path}
              onOpenDiff={(change) => void openDiff(change)}
            />
          ) : (
            <FilesPanel
              sessionId={activeTab?.id ?? ""}
              cwd={activeTab?.cwd ?? ""}
              folderChosen={activeTab?.folderChosen ?? false}
              activePath={activeEditor?.source === "workspace" ? activeEditor?.activePath : null}
              fsRevision={activeFsRevision}
              changedPaths={activeChangedPaths}
              onOpenFile={(path) => void openActiveFile(path)}
            />
          )}
        </PanelWindow>
      ) : null}

      {/* Window-resize handles on the outer shell so they track the real window
          frame. In ejected mode the long left/right edges belong to the column
          handles, so West/East are dropped there — window width still resizes
          from the corners. */}
      <ResizeHandle tauriRuntime={tauriRuntime} edge="North" minWidth={windowMinWidth} />
      <ResizeHandle tauriRuntime={tauriRuntime} edge="NorthEast" minWidth={windowMinWidth} />
      {!ejectedEditorActive ? (
        <ResizeHandle tauriRuntime={tauriRuntime} edge="East" minWidth={windowMinWidth} />
      ) : null}
      <ResizeHandle tauriRuntime={tauriRuntime} edge="SouthEast" minWidth={windowMinWidth} />
      <ResizeHandle tauriRuntime={tauriRuntime} edge="South" minWidth={windowMinWidth} />
      <ResizeHandle tauriRuntime={tauriRuntime} edge="SouthWest" minWidth={windowMinWidth} />
      {!ejectedEditorActive ? (
        <ResizeHandle tauriRuntime={tauriRuntime} edge="West" minWidth={windowMinWidth} />
      ) : null}
      <ResizeHandle tauriRuntime={tauriRuntime} edge="NorthWest" minWidth={windowMinWidth} />
    </div>
  );
}

function TrafficLights({
  focused,
  onClose,
  onMinimize,
  onZoom,
}: {
  focused: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onZoom: () => void;
}) {
  const handle = (action: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    action();
  };

  const lightClass = (color: string, text: string) =>
    `flex h-3 w-3 items-center justify-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.18)] transition-colors duration-200 hover:opacity-95 ${
      focused ? `${color} ${text}` : "bg-[#57534e]/50 text-transparent"
    }`;

  return (
    <div className="group/lights flex shrink-0 items-center gap-2 pl-3.5 pr-2">
      <button
        type="button"
        aria-label="Close window"
        title="Close"
        onClick={handle(onClose)}
        onMouseDown={(event) => event.stopPropagation()}
        className={lightClass("bg-[#ff5f57]", "text-[#4d0000]")}
      >
        <svg viewBox="0 0 8 8" width="6" height="6" className="opacity-0 transition-opacity group-hover/lights:opacity-100">
          <path d="M1.5 1.5 L6.5 6.5 M6.5 1.5 L1.5 6.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Minimize window"
        title="Minimize"
        onClick={handle(onMinimize)}
        onMouseDown={(event) => event.stopPropagation()}
        className={lightClass("bg-[#febc2e]", "text-[#5a3300]")}
      >
        <svg viewBox="0 0 8 8" width="6" height="6" className="opacity-0 transition-opacity group-hover/lights:opacity-100">
          <path d="M1.4 4 L6.6 4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Zoom window"
        title="Zoom"
        onClick={handle(onZoom)}
        onMouseDown={(event) => event.stopPropagation()}
        className={lightClass("bg-[#28c840]", "text-[#003800]")}
      >
        <svg viewBox="0 0 8 8" width="6" height="6" className="opacity-0 transition-opacity group-hover/lights:opacity-100">
          <path d="M2.2 2.2 L5.8 2.2 L5.8 5.8 Z M5.8 5.8 L2.2 5.8 L2.2 2.2 Z" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}

const PANEL_TITLES: Record<PanelName, string> = {
  files: "Files",
  changes: "Changes",
  vault: "Vault",
  skills: "Skills",
};

function PanelWindow({
  activePanel,
  onClose,
  tauriRuntime,
  children,
}: {
  activePanel: PanelName;
  onClose: () => void;
  tauriRuntime: boolean;
  children: ReactNode;
}) {
  const dragHandler = useDragHandler(tauriRuntime);

  return (
    <aside
      className="sogo-panel-in relative flex h-full shrink-0 flex-col overflow-hidden rounded-[20px] border border-cc-border bg-cc-surface/95"
      style={{
        width: RIGHT_SIDEBAR_WIDTH,
        minWidth: RIGHT_SIDEBAR_WIDTH,
        maxWidth: RIGHT_SIDEBAR_WIDTH,
      }}
    >
      <div
        className="h-2 w-full shrink-0 cursor-grab"
        data-tauri-drag-region
        onMouseDown={dragHandler}
      />
      <div
        className="flex h-8 shrink-0 items-center justify-between px-3"
        data-tauri-drag-region
        onMouseDown={dragHandler}
      >
        <span className="text-[10.5px] uppercase tracking-wide text-cc-muted/70">
          {PANEL_TITLES[activePanel]}
        </span>
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-cc-muted transition-colors duration-150 hover:bg-cc-surface-strong hover:text-cc-foreground"
          onClick={onClose}
          title="Close panel"
        >
          <X size={13} />
        </button>
      </div>
      {children}
    </aside>
  );
}

function QuitConfirm({
  runningCount,
  onCancel,
  onQuit,
}: {
  runningCount: number;
  onCancel: () => void;
  onQuit: () => void;
}) {
  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onMouseDown={onCancel} />
      <div className="sogo-pop relative w-80 rounded-2xl border border-cc-border bg-cc-surface p-5 shadow-2xl">
        <div className="text-sm font-medium text-cc-foreground">Quit Sogo?</div>
        <p className="mt-1.5 text-xs leading-5 text-cc-muted">
          {runningCount} running Claude session{runningCount === 1 ? "" : "s"} will stop. Sessions resume where they left off next time.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="h-7 rounded-full border border-cc-border px-3 text-xs text-cc-muted transition-colors hover:text-cc-foreground"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="h-7 rounded-full bg-red-500/15 px-3 text-xs text-red-300 transition-colors hover:bg-red-500/25"
            onClick={onQuit}
          >
            Quit
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  runtimeReady,
  recentFolders,
  onNewTab,
  onNewFolderTab,
  onOpenRecent,
}: {
  runtimeReady: boolean;
  recentFolders: string[];
  onNewTab: () => void;
  onNewFolderTab: () => void;
  onOpenRecent: (folder: string) => void;
}) {
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-cc-background">
      <div className="m-auto w-full max-w-md px-10 py-12">
        <div className="font-mono text-[11px] text-cc-muted/70">
          <span className="text-cc-accent">sogo</span>
          <span>$ </span>
          <span>new-session</span>
        </div>

        <h1 className="mt-5 text-[22px] leading-[1.2] tracking-tight text-cc-foreground">
          Ready when you are.
        </h1>
        <p className="mt-3 max-w-sm text-[13.5px] leading-[1.7] text-cc-muted">
          Sogo wraps Claude Code as a native macOS app. Start a scratch session or open a project folder.
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-2">
          <button
            className="flex h-8 items-center gap-1.5 rounded-full border border-cc-border bg-cc-surface-strong px-3.5 text-xs text-cc-foreground transition-colors hover:bg-cc-surface-strong/70"
            onClick={onNewTab}
          >
            <Play size={12} />
            New session
          </button>
          {runtimeReady ? (
            <button
              className="flex h-8 items-center gap-1.5 rounded-full border border-transparent px-3.5 text-xs text-cc-muted transition-colors hover:bg-cc-surface-strong/60 hover:text-cc-foreground"
              onClick={onNewFolderTab}
            >
              <FolderOpen size={12} />
              Open folder
            </button>
          ) : null}
        </div>

        {runtimeReady && recentFolders.length > 0 ? (
          <div className="mt-6">
            <div className="mb-2 text-[10px] uppercase tracking-wide text-cc-muted/60">Recent folders</div>
            <div className="flex flex-wrap gap-1.5">
              {recentFolders.slice(0, 5).map((folder) => (
                <button
                  key={folder}
                  className="flex h-7 max-w-full items-center gap-1.5 rounded-full border border-cc-border/70 px-2.5 font-mono text-[10.5px] text-cc-muted transition-colors hover:bg-cc-surface-strong/60 hover:text-cc-foreground"
                  onClick={() => onOpenRecent(folder)}
                  title={folder}
                >
                  <History size={10} />
                  <span className="truncate">{folder.split("/").filter(Boolean).pop()}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-12 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10.5px] text-cc-muted/50">
          <span><span className="text-cc-muted/80">⌘K</span> palette</span>
          <span className="text-cc-muted/20">·</span>
          <span><span className="text-cc-muted/80">⌘N</span> session</span>
          <span className="text-cc-muted/20">·</span>
          <span><span className="text-cc-muted/80">⌘W</span> close</span>
          <span className="text-cc-muted/20">·</span>
          <span><span className="text-cc-muted/80">⌥Space</span> hide / show</span>
          <span className="text-cc-muted/20">·</span>
          <span><span className="text-cc-muted/80">⌘1–9</span> switch tabs</span>
        </div>

        {!runtimeReady ? (
          <div className="mt-8 rounded-md border border-amber-400/20 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
            Claude sessions run in the Tauri app. Browser preview shows layout only.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default App;

function parentDir(path: string) {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : path;
}

function inferStatusFromOutput(text: string): SogoTab["status"] {
  const plainText = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ");
  if (/Enter\s+to\s+confirm|Esc\s+to\s+cancel|approval|permission|trust\s+this\s+folder/i.test(plainText)) {
    return "awaiting-input";
  }

  return "busy";
}
