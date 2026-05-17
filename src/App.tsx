import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import logoSvg from "@/assets/logo.svg";
import {
  Check,
  Database,
  FileText,
  FolderOpen,
  FolderTree,
  Play,
  Pin,
  PinOff,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";

import { FilesPanel } from "@/components/FilesPanel";
import { FileEditorPane } from "@/components/FileEditorPane";
import { Settings } from "@/components/Settings";
import { SkillsPanel } from "@/components/SkillsPanel";
import { TabStrip } from "@/components/TabStrip";
import { TerminalPane } from "@/components/TerminalPane";
import { VaultPanel } from "@/components/VaultPanel";
import { isTauriRuntime } from "@/lib/runtime";
import { useEditorStore } from "@/stores/editorStore";
import { useSessionStore } from "@/stores/sessionStore";
import { applyPalette, palettes, useThemeStore } from "@/stores/themeStore";
import type { SogoTab } from "@/types";

type ResizeEdge = "North" | "NorthEast" | "East" | "SouthEast" | "South" | "SouthWest" | "West" | "NorthWest";

const TERMINAL_MIN_WIDTH = 420;
const FILE_EDITOR_MIN_WIDTH = 520;
const FILE_EDITOR_MAX_WIDTH = 960;
const FILE_EDITOR_DEFAULT_WIDTH = 720;
const PANE_GAP = 8;

const FONT_SIZE = {
  small: 12,
  medium: 14,
  large: 16,
} as const;

function readStoredNumber(key: string, fallback: number) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampFileEditorWidth(width: number, toolPanelOpen: boolean) {
  const toolPanelWidth = toolPanelOpen ? 336 : 0;
  const gapCount = toolPanelOpen ? 2 : 1;
  const maxAvailable = window.innerWidth - TERMINAL_MIN_WIDTH - toolPanelWidth - PANE_GAP * gapCount;
  const effectiveMin = Math.min(FILE_EDITOR_MIN_WIDTH, Math.max(220, maxAvailable));
  const effectiveMax = Math.max(effectiveMin, Math.min(FILE_EDITOR_MAX_WIDTH, maxAvailable));
  return Math.round(Math.min(Math.max(width, effectiveMin), effectiveMax));
}

function beginHorizontalPaneResize(
  event: ReactMouseEvent,
  startWidth: number,
  onResize: (width: number) => void,
  options: { invert?: boolean } = {},
) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  const onMove = (moveEvent: MouseEvent) => {
    const delta = options.invert ? startX - moveEvent.clientX : moveEvent.clientX - startX;
    onResize(startWidth + delta);
  };

  const onUp = () => {
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function App() {
  const {
    tabs,
    activeTabId,
    addTab,
    closeTab: removeTab,
    setActiveTabId,
    updateTab,
  } = useSessionStore();
  const idleTimersRef = useRef<Record<string, number>>({});
  const [tabsCollapsed, setTabsCollapsed] = useState(false);
  const [activePanel, setActivePanel] = useState<"vault" | "claude" | "files" | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(() => localStorage.getItem("sogo.windowPinned") === "true");
  const [fileEditorWidth, setFileEditorWidth] = useState(() => readStoredNumber("sogo.fileEditorWidth", FILE_EDITOR_DEFAULT_WIDTH));
  const { paletteName, fontSize } = useThemeStore();
  const editorSessions = useEditorStore((state) => state.sessions);
  const openFile = useEditorStore((state) => state.openFile);
  const saveEditor = useEditorStore((state) => state.save);
  const closeEditor = useEditorStore((state) => state.close);
  const toggleEditorWindow = useEditorStore((state) => state.toggleWindow);
  const palette = palettes[paletteName];
  const tauriRuntime = isTauriRuntime();

  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

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
      setLastError("Could not register Option+Space. Another app may own that shortcut.");
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
  const editorVisible = !!activeEditor?.activePath && activeEditor.windowVisible;
  const renderedFileEditorWidth = editorVisible
    ? clampFileEditorWidth(fileEditorWidth, !!activePanel)
    : fileEditorWidth;

  useEffect(() => {
    localStorage.setItem("sogo.fileEditorWidth", String(fileEditorWidth));
  }, [fileEditorWidth]);

  useEffect(() => {
    const fitWidths = () => {
      setFileEditorWidth((current) => clampFileEditorWidth(current, !!activePanel));
    };

    fitWidths();
    window.addEventListener("resize", fitWidths);
    return () => window.removeEventListener("resize", fitWidths);
  }, [activePanel, editorVisible]);

  const newTab = useCallback(async () => {
    setLastError(null);

    if (!tauriRuntime) {
      setLastError("Claude sessions require the Tauri desktop runtime. Run pnpm tauri dev.");
      return;
    }

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const cwd = await invoke<string>("default_session_cwd");
      addTab(cwd, { label: `Scratch ${tabs.length + 1}`, folderChosen: false });
    } catch (error) {
      setLastError(`Could not start a Claude session: ${String(error)}`);
    }
  }, [addTab, tabs.length, tauriRuntime]);

  const newFolderTab = useCallback(async () => {
    setLastError(null);

    if (!tauriRuntime) {
      setLastError("Folder-backed Claude sessions require the Tauri desktop runtime. Run pnpm tauri dev.");
      return;
    }

    try {
      const { open } = await import("@tauri-apps/plugin-dialog");

      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose a project folder",
      });

      if (!selected || Array.isArray(selected)) return;

      addTab(selected, { folderChosen: true });
    } catch (error) {
      setLastError(`Could not start a folder-scoped session: ${String(error)}`);
    }
  }, [addTab, tauriRuntime]);

  const closeTab = useCallback(
    async (id: string) => {
      const editorState = useEditorStore.getState();
      if (!editorState.close(id)) {
        setActiveTabId(id);
        return;
      }

      if (tauriRuntime) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("close_session", { sessionId: id }).catch(() => undefined);
      }
      removeTab(id);
    },
    [removeTab, setActiveTabId, tauriRuntime],
  );

  const openActiveFile = useCallback(
    (path: string) => {
      if (!activeTab) {
        setLastError("Start a Claude session before opening a file.");
        return;
      }

      void openFile(activeTab.id, path);
    },
    [activeTab, openFile],
  );

  const openVaultDocument = useCallback(
    (sourcePath: string) => {
      if (!activeTab) {
        setLastError("Start a session before opening a vault document.");
        return;
      }

      void openFile(activeTab.id, sourcePath, { source: "vault" });
    },
    [activeTab, openFile],
  );

  const activateSkill = useCallback(
    (skillName: string) => {
      if (!activeTab) {
        setLastError("Start a Claude session before activating a skill.");
        return;
      }

      if (!tauriRuntime) {
        setLastError("Skill activation requires the Tauri desktop runtime. Run pnpm tauri dev.");
        return;
      }

      if (activeTab.status === "stopped" || activeTab.status === "error" || !activeTab.started) {
        setLastError("Start the active Claude session before activating a skill.");
        return;
      }

      setLastError(null);
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("write_to_session", {
          sessionId: activeTab.id,
          data: `Use the ${skillName} skill. `,
        }))
        .catch((error) => {
          setLastError(`Could not insert ${skillName}: ${String(error)}`);
        });
    },
    [activeTab, tauriRuntime, updateTab],
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
      setLastError(error);
    },
    [updateTab],
  );

  const handleSessionId = useCallback(
    (tabId: string, claudeSessionId: string) => {
      updateTab(tabId, { claudeSessionId });
    },
    [updateTab],
  );

  const runWindowAction = useCallback(
    (action: "close" | "hide" | "minimize" | "toggleMaximize") => {
      if (!tauriRuntime) return;
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        if (action === "close") return appWindow.close();
        if (action === "hide") return appWindow.hide();
        if (action === "minimize") return appWindow.minimize();
        return appWindow.toggleMaximize();
      });
    },
    [tauriRuntime],
  );

  const toggleTabs = useCallback(() => {
    setTabsCollapsed((current) => !current);
  }, []);

  const startTab = useCallback(
    (id: string) => {
      setLastError(null);
      updateTab(id, { status: "busy", started: true });
    },
    [updateTab],
  );

  const togglePanel = useCallback((panel: "vault" | "claude" | "files") => {
    setActivePanel((current) => (current === panel ? null : panel));
  }, []);

  const toggleFileWindow = useCallback(() => {
    if (activeTab && activeEditor?.activePath) {
      toggleEditorWindow(activeTab.id);
      return;
    }

    togglePanel("files");
  }, [activeEditor?.activePath, activeTab, toggleEditorWindow, togglePanel]);

  const beginFileEditorResize = useCallback((event: ReactMouseEvent) => {
    beginHorizontalPaneResize(event, renderedFileEditorWidth, (nextWidth) => {
      setFileEditorWidth(clampFileEditorWidth(nextWidth, !!activePanel));
    }, { invert: true });
  }, [activePanel, renderedFileEditorWidth]);

  const prevPanelOpenRef = useRef<boolean>(!!activePanel);
  const prevEditorOpenRef = useRef<boolean>(editorVisible);

  useEffect(() => {
    if (!tauriRuntime) return;

    const prevPanel = prevPanelOpenRef.current;
    const prevEditor = prevEditorOpenRef.current;
    const panelOpened = !prevPanel && !!activePanel;
    const editorOpened = !prevEditor && editorVisible;
    const panelClosed = prevPanel && !activePanel;
    const editorClosed = prevEditor && !editorVisible;
    prevPanelOpenRef.current = !!activePanel;
    prevEditorOpenRef.current = editorVisible;

    if (!panelOpened && !editorOpened && !panelClosed && !editorClosed) return;

    void import("@tauri-apps/api/window")
      .then(async ({ LogicalPosition, LogicalSize, currentMonitor, getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        const [size, scaleFactor, position, monitor] = await Promise.all([
          appWindow.innerSize(),
          appWindow.scaleFactor(),
          appWindow.outerPosition(),
          currentMonitor(),
        ]);
        const currentW = size.width / scaleFactor;
        const currentH = size.height / scaleFactor;
        const currentX = position.x / scaleFactor;
        const workAreaW = monitor?.workArea?.size?.width
          ? monitor.workArea.size.width / scaleFactor
          : window.screen.availWidth;
        const workAreaX = monitor?.workArea?.position?.x
          ? monitor.workArea.position.x / scaleFactor
          : 0;

        let deltaW = 0;
        if (panelOpened) deltaW += 336 + PANE_GAP;
        if (panelClosed) deltaW -= 336 + PANE_GAP;
        if (editorOpened) deltaW += FILE_EDITOR_DEFAULT_WIDTH + PANE_GAP;
        if (editorClosed) deltaW -= renderedFileEditorWidth + PANE_GAP;

        if (deltaW === 0) return;

        const minW = 680;
        const maxW = workAreaW - 24;
        const nextW = Math.min(Math.max(currentW + deltaW, minW), maxW);

        if (Math.abs(nextW - currentW) < 8) return;

        await appWindow.setSize(new LogicalSize(Math.round(nextW), Math.round(currentH)));

        const maxX = workAreaX + workAreaW - nextW - 12;
        if (currentX > maxX) {
          await appWindow.setPosition(
            new LogicalPosition(Math.round(Math.max(workAreaX + 12, maxX)), Math.round(position.y / scaleFactor)),
          );
        }
      })
      .catch(() => undefined);
  }, [activePanel, editorVisible, renderedFileEditorWidth, tauriRuntime]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (activeTab && activeEditor?.focusWithin && activeEditor.activePath) {
        if (e.key === "s") {
          e.preventDefault();
          void saveEditor(activeTab.id);
          return;
        }
        if (e.key === "w") {
          e.preventDefault();
          closeEditor(activeTab.id);
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
        if (activeTab) void closeTab(activeTab.id);
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
  }, [newTab, closeTab, activeTab, activeEditor, tabs, setActiveTabId, saveEditor, closeEditor]);

  const dragHandler = useDragHandler(tauriRuntime);
  const mainShellMinWidth = editorVisible ? TERMINAL_MIN_WIDTH : activePanel ? TERMINAL_MIN_WIDTH : 680;

  return (
    <div className="flex h-full w-full gap-2 bg-transparent text-cc-foreground">
      <div
        className="relative flex h-full min-h-[540px] min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-cc-border bg-cc-background/95"
        style={{ minWidth: mainShellMinWidth }}
      >
        {/* Childless drag strip — transparent, cursor-only; data-tauri-drag-region fires reliably here because no interactive child intercepts mousedown */}
        <div
          className="h-2 w-full shrink-0 cursor-grab"
          data-tauri-drag-region
          onMouseDown={dragHandler}
        />
        <header
          className="flex h-10 shrink-0 items-center bg-cc-surface/80"
          data-tauri-drag-region
          onMouseDown={dragHandler}
        >
          <TrafficLights
            onClose={() => runWindowAction("close")}
            onMinimize={() => runWindowAction("minimize")}
            onZoom={() => runWindowAction("toggleMaximize")}
          />
          <div className="flex h-full shrink-0 items-center pl-1 pr-2">
            <img src={logoSvg} alt="Sogo" className="h-6 w-6 rounded-md" />
          </div>

          <div className="min-w-0 flex-1">
            <TabStrip
              tabs={tabs}
              activeTabId={activeTab?.id}
              collapsed={tabsCollapsed}
              onSelect={setActiveTabId}
              onNewTab={newTab}
              onClose={closeTab}
              onRename={(id, label) => updateTab(id, { label })}
            />
          </div>

          <div className="flex shrink-0 items-center gap-0.5 pl-2 pr-2">
            <ChromeButton
              active={activePanel === "vault"}
              onClick={() => togglePanel("vault")}
              title="Vault"
            >
              <Database size={13} />
            </ChromeButton>
            <ChromeButton
              active={activePanel === "claude"}
              onClick={() => togglePanel("claude")}
              title="Skills"
            >
              <Wrench size={13} />
            </ChromeButton>
            <ChromeButton
              active={activePanel === "files"}
              onClick={() => togglePanel("files")}
              title="Files"
            >
              <FolderTree size={13} />
            </ChromeButton>
            <ChromeButton
              active={editorVisible}
              dim={!editorVisible && !activeEditor?.activePath}
              onClick={toggleFileWindow}
              title={activeEditor?.activePath ? (editorVisible ? "Hide file" : "Show file") : "Open file"}
            >
              <FileText size={13} />
            </ChromeButton>

            <span className="w-2" aria-hidden />

            <ChromeButton
              active={pinned}
              onClick={() => setPinned((current) => !current)}
              title={pinned ? "Unpin" : "Pin on top"}
            >
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </ChromeButton>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 overflow-hidden">
          <section
            className="flex min-w-0 flex-1 flex-col"
            style={{ minWidth: editorVisible ? TERMINAL_MIN_WIDTH : 0 }}
          >
            {activeTab ? (
              <SessionBar
                tab={activeTab}
                onClose={() => void closeTab(activeTab.id)}
              />
            ) : null}
            <div className="relative min-h-0 flex-1 bg-[color:var(--cc-background)]">
              {lastError ? (
                <ErrorToast message={lastError} onDismiss={() => setLastError(null)} />
              ) : null}
              {tabs.length === 0 ? (
                <EmptyState
                  runtimeReady={tauriRuntime}
                  onNewTab={newTab}
                  onNewFolderTab={newFolderTab}
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
                    />
                  ))}
                </>
              )}
            </div>
            <Settings
              tabsCollapsed={tabsCollapsed}
              onToggleTabs={toggleTabs}
              onNewFolderSession={newFolderTab}
            />
          </section>
          {activeTab && editorVisible ? (
            <>
              <PaneDivider
                onMouseDown={beginFileEditorResize}
                onDoubleClick={() => setFileEditorWidth(FILE_EDITOR_DEFAULT_WIDTH)}
              />
              <div
                className="min-h-0 shrink-0 py-2 pr-2"
                style={{ width: renderedFileEditorWidth }}
              >
                <FileEditorPane
                  sessionId={activeTab.id}
                  cwd={activeTab.cwd}
                  onDragMouseDown={dragHandler}
                />
              </div>
            </>
          ) : null}
        </main>
        <ResizeHandle tauriRuntime={tauriRuntime} edge="North" />
        <ResizeHandle tauriRuntime={tauriRuntime} edge="NorthEast" />
        <ResizeHandle tauriRuntime={tauriRuntime} edge="East" />
        <ResizeHandle tauriRuntime={tauriRuntime} edge="SouthEast" />
        <ResizeHandle tauriRuntime={tauriRuntime} edge="South" />
        <ResizeHandle tauriRuntime={tauriRuntime} edge="SouthWest" />
        <ResizeHandle tauriRuntime={tauriRuntime} edge="West" />
        <ResizeHandle tauriRuntime={tauriRuntime} edge="NorthWest" />
      </div>

      {activePanel ? (
        <PanelWindow
          activePanel={activePanel}
          onPanelChange={setActivePanel}
          onClose={() => setActivePanel(null)}
          onActivateSkill={activateSkill}
          tauriRuntime={tauriRuntime}
          cwd={activeTab?.cwd ?? ""}
          sessionId={activeTab?.id ?? ""}
          folderChosen={activeTab?.folderChosen ?? false}
          activePath={activeEditor?.activePath}
          activeSource={activeEditor?.source}
          activeVaultRelPath={activeEditor?.vaultRelPath}
          onOpenFile={openActiveFile}
          onOpenVaultDocument={openVaultDocument}
        />
      ) : null}
    </div>
  );
}

function SessionBar({
  tab,
  onClose,
}: {
  tab: SogoTab;
  onClose: () => void;
}) {
  const isActive = (tab.status === "busy" || tab.status === "awaiting-input") && tab.started;
  const [confirmingClose, setConfirmingClose] = useState(false);
  const closeTimerRef = useRef<number | undefined>();

  useEffect(() => () => {
    window.clearTimeout(closeTimerRef.current);
  }, []);

  const requestClose = () => {
    if (isActive) {
      setConfirmingClose(true);
      closeTimerRef.current = window.setTimeout(() => setConfirmingClose(false), 3500);
    } else {
      onClose();
    }
  };

  const confirmClose = () => {
    window.clearTimeout(closeTimerRef.current);
    setConfirmingClose(false);
    onClose();
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 bg-cc-surface/60 px-3">
      <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(tab.status)}`} />
      <span className="text-xs font-medium text-cc-foreground">{statusLabel(tab.status)}</span>
      <span
        className="min-w-0 flex-1 truncate text-xs text-cc-muted"
        title={tab.cwd}
        dir="rtl"
      >
        {compactPath(tab.cwd)}
      </span>
      {confirmingClose ? (
        <div className="flex items-center gap-1">
          <span className="text-xs text-cc-muted">Close session?</span>
          <button
            className="flex h-7 items-center gap-1 rounded-md bg-red-500/15 px-2 text-xs text-red-300 hover:bg-red-500/25"
            onClick={confirmClose}
          >
            <Check size={12} />
            Close
          </button>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md text-cc-muted hover:text-cc-foreground"
            onClick={() => { window.clearTimeout(closeTimerRef.current); setConfirmingClose(false); }}
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
          onClick={requestClose}
          title="Close session"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function compactPath(path: string) {
  if (!path) return "";
  const home = "/Users/";
  if (path.startsWith(home)) {
    const rest = path.slice(home.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx >= 0) {
      const after = rest.slice(slashIdx + 1);
      const parts = after.split("/").filter(Boolean);
      if (parts.length <= 2) return `~/${after}`;
      return `~/…/${parts.slice(-2).join("/")}`;
    }
    return `~/${rest}`;
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `/…/${parts.slice(-2).join("/")}`;
}

function TrafficLights({
  onClose,
  onMinimize,
  onZoom,
}: {
  onClose: () => void;
  onMinimize: () => void;
  onZoom: () => void;
}) {
  const handle = (action: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    action();
  };

  return (
    <div className="group/lights flex shrink-0 items-center gap-2 pl-3.5 pr-2">
      <button
        type="button"
        aria-label="Close window"
        title="Close"
        onClick={handle(onClose)}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex h-3 w-3 items-center justify-center rounded-full bg-[#ff5f57] text-[#4d0000] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.18)] transition-opacity hover:opacity-95"
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
        className="flex h-3 w-3 items-center justify-center rounded-full bg-[#febc2e] text-[#5a3300] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.18)] transition-opacity hover:opacity-95"
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
        className="flex h-3 w-3 items-center justify-center rounded-full bg-[#28c840] text-[#003800] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.18)] transition-opacity hover:opacity-95"
      >
        <svg viewBox="0 0 8 8" width="6" height="6" className="opacity-0 transition-opacity group-hover/lights:opacity-100">
          <path d="M2.2 2.2 L5.8 2.2 L5.8 5.8 Z M5.8 5.8 L2.2 5.8 L2.2 2.2 Z" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}

function ChromeButton({
  active,
  dim,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  dim?: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  const base = "flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150";
  const tone = active
    ? "bg-cc-surface-strong/60 text-cc-accent"
    : dim
      ? "text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
      : "text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground";
  return (
    <button className={`${base} ${tone}`} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

function statusDotClass(status: SogoTab["status"]) {
  if (status === "idle") return "bg-emerald-400";
  if (status === "busy") return "bg-sky-400";
  if (status === "awaiting-input") return "bg-amber-300";
  if (status === "error") return "bg-red-400";
  return "bg-cc-muted";
}

function statusLabel(status: SogoTab["status"]) {
  if (status === "awaiting-input") return "Awaiting input";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function PanelWindow({
  activePanel,
  onPanelChange,
  onClose,
  onActivateSkill,
  tauriRuntime,
  cwd,
  sessionId,
  folderChosen,
  activePath,
  activeSource,
  activeVaultRelPath,
  onOpenFile,
  onOpenVaultDocument,
}: {
  activePanel: "vault" | "claude" | "files";
  onPanelChange: (panel: "vault" | "claude" | "files" | null) => void;
  onClose: () => void;
  onActivateSkill: (skillName: string) => void;
  tauriRuntime: boolean;
  cwd: string;
  sessionId: string;
  folderChosen: boolean;
  activePath?: string | null;
  activeSource?: "workspace" | "vault";
  activeVaultRelPath?: string | null;
  onOpenFile: (path: string) => void;
  onOpenVaultDocument: (sourcePath: string) => void;
}) {
  const dragHandler = useDragHandler(tauriRuntime);

  const tabClass = (panel: "vault" | "claude" | "files") =>
    `flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs transition-colors duration-150 ${
      activePanel === panel
        ? "bg-cc-surface-strong text-cc-foreground"
        : "text-cc-muted hover:bg-cc-surface-strong/70 hover:text-cc-foreground"
    }`;

  return (
    <aside className="relative flex h-full w-[21rem] shrink-0 flex-col overflow-hidden rounded-[20px] border border-cc-border bg-cc-surface/95">
      <div
        className="h-2 w-full shrink-0 cursor-grab"
        data-tauri-drag-region
        onMouseDown={dragHandler}
      />
      <div
        className="flex h-10 shrink-0 items-center gap-1 border-b border-cc-border/40 px-2"
        data-tauri-drag-region
        onMouseDown={dragHandler}
      >
        <button className={tabClass("files")} onClick={() => onPanelChange("files")}>
          <FolderTree size={13} />
          Files
        </button>
        <button className={tabClass("vault")} onClick={() => onPanelChange("vault")}>
          <Database size={13} />
          Vault
        </button>
        <button className={tabClass("claude")} onClick={() => onPanelChange("claude")}>
          <Wrench size={13} />
          Skills
        </button>
        <button
          className="ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-cc-muted transition-colors duration-150 hover:bg-cc-surface-strong hover:text-cc-foreground"
          onClick={onClose}
          title="Close panel"
        >
          <X size={13} />
        </button>
      </div>
      {activePanel === "vault" ? (
        <VaultPanel
          onOpenDocument={onOpenVaultDocument}
          activePath={activeSource === "vault" ? activeVaultRelPath ?? activePath ?? null : null}
        />
      ) : activePanel === "claude" ? (
        <SkillsPanel onActivateSkill={onActivateSkill} />
      ) : (
        <FilesPanel
          sessionId={sessionId}
          cwd={cwd}
          folderChosen={folderChosen}
          activePath={activePath}
          onOpenFile={onOpenFile}
        />
      )}
    </aside>
  );
}

function PaneDivider({
  onMouseDown,
  onDoubleClick,
}: {
  onMouseDown: (event: ReactMouseEvent) => void;
  onDoubleClick: () => void;
}) {
  return (
    <button
      className="group relative h-full w-2 shrink-0 cursor-col-resize text-transparent"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      title="Resize file editor"
    >
      <span className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-200 group-hover:bg-cc-accent/50" />
    </button>
  );
}

function EmptyState({
  runtimeReady,
  onNewTab,
  onNewFolderTab,
}: {
  runtimeReady: boolean;
  onNewTab: () => void;
  onNewFolderTab: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-cc-background p-4">
      <div className="flex min-h-0 flex-1 flex-col rounded-md border border-cc-border bg-cc-surface/55 font-mono">
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-cc-border px-3 text-[11px] text-cc-muted">
          <div className="flex items-center gap-2">
            <SquareTerminal size={14} />
            <span>No session</span>
          </div>
          <span>ready</span>
        </div>

        <div className="flex flex-1 flex-col px-6 py-8">
          <div className="text-xs text-cc-muted">
            <span className="text-cc-accent">sogo</span>
            <span>$ </span>
            <span>new-session</span>
          </div>
          <p className="mt-2 max-w-sm text-xs leading-5 text-cc-muted/70">
            Claude Code in a desktop shell. Start a scratch session or open a project folder.
          </p>

          <div className="mt-6 flex items-center gap-2">
            <button
              className="flex h-9 items-center gap-2 rounded-md bg-cc-accent px-3 text-sm font-medium text-cc-background hover:opacity-90"
              onClick={onNewTab}
            >
              <Play size={14} />
              New session
            </button>
            {runtimeReady ? (
              <button
                className="flex h-9 items-center gap-2 rounded-md border border-cc-border px-3 text-sm text-cc-muted hover:border-cc-border/70 hover:text-cc-foreground"
                onClick={onNewFolderTab}
              >
                <FolderOpen size={14} />
                Open folder
              </button>
            ) : null}
          </div>

          <div className="mt-auto pt-10 flex items-center gap-3 text-[10px] text-cc-muted/40 font-mono">
            <span><span className="text-cc-muted/60">⌘N</span> session</span>
            <span className="text-cc-muted/20">·</span>
            <span><span className="text-cc-muted/60">⌘W</span> close</span>
            <span className="text-cc-muted/20">·</span>
            <span><span className="text-cc-muted/60">⌥Space</span> hide/show</span>
            <span className="text-cc-muted/20">·</span>
            <span><span className="text-cc-muted/60">⌘1–9</span> switch tabs</span>
          </div>
        </div>

        {!runtimeReady ? (
          <div className="mx-4 mb-4 rounded-md border border-amber-400/20 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
            Claude sessions run in the Tauri app. Browser preview shows layout only.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default App;

function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const timerRef = useRef<number | undefined>();

  useEffect(() => {
    timerRef.current = window.setTimeout(onDismiss, 6000);
    return () => window.clearTimeout(timerRef.current);
  }, [message, onDismiss]);

  return (
    <div className="absolute inset-x-3 top-3 z-40 flex items-center gap-2.5 rounded-md border border-cc-border bg-cc-surface px-3 py-2.5 text-xs">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
      <span className="min-w-0 flex-1 text-cc-foreground">{message}</span>
      <button
        className="shrink-0 text-cc-muted hover:text-cc-foreground"
        onClick={onDismiss}
      >
        <X size={11} />
      </button>
    </div>
  );
}

function useDragHandler(tauriRuntime: boolean) {
  return useCallback(
    (event: React.MouseEvent) => {
      if (!tauriRuntime || event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button, input, a, select")) return;
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        void getCurrentWindow().startDragging();
      });
    },
    [tauriRuntime],
  );
}

const CURSOR: Record<ResizeEdge, string> = {
  North:     "cursor-n-resize",
  NorthEast: "cursor-ne-resize",
  East:      "cursor-e-resize",
  SouthEast: "cursor-se-resize",
  South:     "cursor-s-resize",
  SouthWest: "cursor-sw-resize",
  West:      "cursor-w-resize",
  NorthWest: "cursor-nw-resize",
};

function ResizeHandle({ tauriRuntime, edge }: { tauriRuntime: boolean; edge: ResizeEdge }) {
  const handleMouseDown = useCallback(
    async (event: React.MouseEvent) => {
      if (!tauriRuntime) return;
      event.preventDefault();
      event.stopPropagation();

      const { getCurrentWindow, LogicalSize, LogicalPosition } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();

      const movesX = edge.includes("West");
      const movesY = edge.includes("North");

      const [size, scaleFactor, pos] = await Promise.all([
        appWindow.innerSize(),
        appWindow.scaleFactor(),
        movesX || movesY ? appWindow.outerPosition() : Promise.resolve(null),
      ]);

      const startW  = size.width / scaleFactor;
      const startH  = size.height / scaleFactor;
      const startWX = pos ? pos.x / scaleFactor : 0;
      const startWY = pos ? pos.y / scaleFactor : 0;
      const startX  = event.screenX;
      const startY  = event.screenY;

      let frame: number | null = null;
      let nextW = startW;
      let nextH = startH;
      let nextX = startWX;
      let nextY = startWY;

      const onMove = (e: MouseEvent) => {
        const dx = e.screenX - startX;
        const dy = e.screenY - startY;

        if (edge.includes("East"))  nextW = Math.max(840, startW + dx);
        if (edge.includes("West"))  { nextW = Math.max(840, startW - dx); nextX = startWX + dx; }
        if (edge.includes("South")) nextH = Math.max(540, startH + dy);
        if (edge.includes("North")) { nextH = Math.max(540, startH - dy); nextY = startWY + dy; }

        if (!frame) {
          frame = requestAnimationFrame(() => {
            const ops: Promise<void>[] = [
              appWindow.setSize(new LogicalSize(Math.round(nextW), Math.round(nextH))),
            ];
            if (movesX || movesY) {
              ops.push(appWindow.setPosition(new LogicalPosition(Math.round(nextX), Math.round(nextY))));
            }
            void Promise.all(ops);
            frame = null;
          });
        }
      };

      const onUp = () => {
        if (frame) cancelAnimationFrame(frame);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [tauriRuntime, edge],
  );

  const cursor = CURSOR[edge];

  // Corners
  if (edge === "NorthWest") return <div className={`absolute left-0 top-0 z-20 h-4 w-4 ${cursor}`} onMouseDown={handleMouseDown} />;
  if (edge === "NorthEast") return <div className={`absolute right-0 top-0 z-20 h-4 w-4 ${cursor}`} onMouseDown={handleMouseDown} />;
  if (edge === "SouthWest") return <div className={`absolute bottom-0 left-0 z-20 h-4 w-4 ${cursor}`} onMouseDown={handleMouseDown} />;
  if (edge === "SouthEast") {
    return (
      <div className={`group absolute bottom-2 right-2 z-20 p-2 ${cursor}`} onMouseDown={handleMouseDown}>
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-cc-muted opacity-20 transition-opacity duration-200 group-hover:opacity-70">
          <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" />
          <circle cx="5"   cy="8.5" r="1.1" fill="currentColor" />
          <circle cx="8.5" cy="5"   r="1.1" fill="currentColor" />
        </svg>
      </div>
    );
  }

  // Edges
  if (edge === "North") return <div className={`absolute inset-x-4 top-0 z-20 h-1.5 ${cursor}`} onMouseDown={handleMouseDown} />;
  if (edge === "South") return <div className={`absolute inset-x-0 bottom-0 h-1.5 ${cursor}`} onMouseDown={handleMouseDown} />;
  if (edge === "East")  return <div className={`absolute inset-y-0 right-0 w-1.5 ${cursor}`} onMouseDown={handleMouseDown} />;
  if (edge === "West")  return <div className={`absolute inset-y-0 left-0 w-1.5 ${cursor}`} onMouseDown={handleMouseDown} />;

  return null;
}

function inferStatusFromOutput(text: string): SogoTab["status"] {
  const plainText = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ");
  if (/Enter\s+to\s+confirm|Esc\s+to\s+cancel|approval|permission|trust\s+this\s+folder/i.test(plainText)) {
    return "awaiting-input";
  }

  return "busy";
}
