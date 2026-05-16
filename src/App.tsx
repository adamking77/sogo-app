import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Database,
  EyeOff,
  Maximize2,
  Minus,
  Play,
  Pin,
  PinOff,
  Power,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";

import { Settings } from "@/components/Settings";
import { SkillsPanel } from "@/components/SkillsPanel";
import { TabStrip } from "@/components/TabStrip";
import { TerminalPane } from "@/components/TerminalPane";
import { VaultPanel } from "@/components/VaultPanel";
import { isTauriRuntime } from "@/lib/runtime";
import { useSessionStore } from "@/stores/sessionStore";
import { applyPalette, palettes, useThemeStore } from "@/stores/themeStore";
import type { SogoTab } from "@/types";

type ResizeEdge = "North" | "NorthEast" | "East" | "SouthEast" | "South" | "SouthWest" | "West" | "NorthWest";

const FONT_SIZE = {
  small: 12,
  medium: 14,
  large: 16,
} as const;

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
  const [activePanel, setActivePanel] = useState<"vault" | "claude" | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(() => localStorage.getItem("sogo.windowPinned") === "true");
  const { paletteName, fontSize } = useThemeStore();
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

  useEffect(() => {
    if (!tauriRuntime || !activePanel) return;
    void import("@tauri-apps/api/window")
      .then(async ({ LogicalSize, getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        const [size, scaleFactor] = await Promise.all([
          appWindow.innerSize(),
          appWindow.scaleFactor(),
        ]);
        const currentW = size.width / scaleFactor;
        const minNeeded = 680 + 8 + 336;
        if (currentW < minNeeded) {
          await appWindow.setSize(new LogicalSize(minNeeded + 80, Math.round(size.height / scaleFactor)));
        }
      })
      .catch(() => undefined);
  }, [activePanel, tauriRuntime]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [activeTabId, tabs],
  );

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
      if (tauriRuntime) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("close_session", { sessionId: id }).catch(() => undefined);
      }
      removeTab(id);
    },
    [removeTab, tauriRuntime],
  );

  const interruptActive = useCallback(() => {
    if (!activeTab || !tauriRuntime) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("interrupt_session", { sessionId: activeTab.id })).catch((error) => {
      setLastError(String(error));
      updateTab(activeTab.id, { status: "error" });
    });
  }, [activeTab, tauriRuntime, updateTab]);

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
          data: `Use the ${skillName} skill.\r`,
        }))
        .then(() => updateTab(activeTab.id, { status: "busy" }))
        .catch((error) => {
          setLastError(`Could not activate ${skillName}: ${String(error)}`);
          updateTab(activeTab.id, { status: "error" });
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

  const togglePanel = useCallback((panel: "vault" | "claude") => {
    setActivePanel((current) => (current === panel ? null : panel));
  }, []);

  const dragHandler = useDragHandler(tauriRuntime);

  return (
    <div className="flex h-full w-full gap-2 bg-transparent text-cc-foreground">
      <div
        className="relative flex h-full min-h-[540px] min-w-[680px] flex-1 flex-col overflow-hidden rounded-[22px] border border-cc-border bg-cc-background/95"
      >
        {/* Childless drag strip — transparent, cursor-only; data-tauri-drag-region fires reliably here because no interactive child intercepts mousedown */}
        <div
          className="h-2 w-full shrink-0 cursor-grab"
          data-tauri-drag-region
          onMouseDown={dragHandler}
        />
        <header
          className="flex h-10 shrink-0 items-center border-b border-cc-border bg-cc-surface/80"
          data-tauri-drag-region
          onMouseDown={dragHandler}
        >
          <div className="flex h-full w-20 shrink-0 items-center px-3">
            <div className="rounded-full border border-cc-border bg-cc-surface-strong/70 px-2 py-1 font-mono text-[11px] text-cc-muted">
              sogo
            </div>
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

          <div className="flex w-52 shrink-0 items-center justify-end gap-1 px-2">
            <button
              className={`flex h-7 w-7 items-center justify-center rounded hover:bg-cc-surface-strong ${
                activePanel === "vault" ? "text-cc-accent" : "text-cc-muted hover:text-cc-foreground"
              }`}
              onClick={() => togglePanel("vault")}
              title={activePanel === "vault" ? "Hide vault" : "Show vault"}
            >
              <Database size={14} />
            </button>
            <button
              className={`flex h-7 w-7 items-center justify-center rounded hover:bg-cc-surface-strong ${
                activePanel === "claude" ? "text-cc-accent" : "text-cc-muted hover:text-cc-foreground"
              }`}
              onClick={() => togglePanel("claude")}
              title={activePanel === "claude" ? "Hide Claude inventory" : "Show Claude inventory"}
            >
              <Wrench size={14} />
            </button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
              onClick={interruptActive}
              title="Interrupt"
              disabled={!activeTab}
            >
              <Power size={14} />
            </button>
            <button
              className={`flex h-7 w-7 items-center justify-center rounded hover:bg-cc-surface-strong ${
                pinned ? "text-cc-accent" : "text-cc-muted hover:text-cc-foreground"
              }`}
              onClick={() => setPinned((current) => !current)}
              title={pinned ? "Unpin window" : "Pin window on top"}
            >
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
              onClick={() => runWindowAction("hide")}
              title="Hide window"
            >
              <EyeOff size={14} />
            </button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
              onClick={() => runWindowAction("minimize")}
              title="Minimize"
            >
              <Minus size={14} />
            </button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
              onClick={() => runWindowAction("toggleMaximize")}
              title="Maximize"
            >
              <Maximize2 size={14} />
            </button>
          </div>
        </header>

        <main className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            {activeTab ? (
              <SessionBar
                tab={activeTab}
                onStart={() => startTab(activeTab.id)}
                onInterrupt={interruptActive}
                onClose={() => void closeTab(activeTab.id)}
              />
            ) : null}
            <div className="relative min-h-0 flex-1 bg-[color:var(--cc-background)]">
              {tabs.length === 0 ? (
                <EmptyState
                  runtimeReady={tauriRuntime}
                  onNewTab={newTab}
                  error={lastError}
                />
              ) : (
                tabs.map((tab) => (
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
                ))
              )}
            </div>
            {lastError ? (
              <div className="border-t border-cc-border bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {lastError}
              </div>
            ) : null}
            <Settings
              tabsCollapsed={tabsCollapsed}
              onToggleTabs={toggleTabs}
              onNewFolderSession={newFolderTab}
            />
          </section>
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
        />
      ) : null}
    </div>
  );
}

function SessionBar({
  tab,
  onStart,
  onInterrupt,
  onClose,
}: {
  tab: SogoTab;
  onStart: () => void;
  onInterrupt: () => void;
  onClose: () => void;
}) {
  const canStart = tab.status === "stopped" || tab.status === "error";

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-cc-border bg-cc-surface/80 px-3">
      <span className={`h-2 w-2 rounded-full ${statusDotClass(tab.status)}`} />
      <span className="text-xs font-medium text-cc-foreground">{statusLabel(tab.status)}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-cc-muted">{tab.cwd}</span>
      {tab.claudeSessionId ? (
        <span className="hidden max-w-44 truncate rounded border border-cc-border px-2 py-1 font-mono text-[10px] text-cc-muted md:inline">
          {tab.claudeSessionId}
        </span>
      ) : null}
      {canStart ? (
        <button
          className="flex h-7 items-center gap-1 rounded-md bg-cc-accent px-2 text-xs font-medium text-cc-background"
          onClick={onStart}
        >
          <Play size={13} />
          Start
        </button>
      ) : (
        <button
          className="flex h-7 items-center gap-1 rounded-md border border-cc-border px-2 text-xs text-cc-muted hover:text-cc-foreground"
          onClick={onInterrupt}
        >
          <Power size={13} />
          Interrupt
        </button>
      )}
      <button
        className="flex h-7 w-7 items-center justify-center rounded-md text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
        onClick={onClose}
        title="Close session"
      >
        <X size={14} />
      </button>
    </div>
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
}: {
  activePanel: "vault" | "claude";
  onPanelChange: (panel: "vault" | "claude" | null) => void;
  onClose: () => void;
  onActivateSkill: (skillName: string) => void;
  tauriRuntime: boolean;
}) {
  const dragHandler = useDragHandler(tauriRuntime);
  return (
    <aside className="relative hidden h-full w-[21rem] shrink-0 flex-col overflow-hidden rounded-[20px] border border-cc-border bg-cc-surface/95 min-[860px]:flex">
      <div
        className="h-2 w-full shrink-0 cursor-grab"
        data-tauri-drag-region
        onMouseDown={dragHandler}
      />
      <div
        className="flex h-10 shrink-0 items-center gap-1 border-b border-cc-border px-2"
        data-tauri-drag-region
        onMouseDown={dragHandler}
      >
        <button
          className={`flex h-8 flex-1 items-center justify-center gap-2 rounded-md text-xs ${
            activePanel === "vault"
              ? "bg-cc-surface-strong text-cc-foreground"
              : "text-cc-muted hover:bg-cc-surface-strong/70 hover:text-cc-foreground"
          }`}
          onClick={() => onPanelChange("vault")}
        >
          <Database size={14} />
          Vault
        </button>
        <button
          className={`flex h-8 flex-1 items-center justify-center gap-2 rounded-md text-xs ${
            activePanel === "claude"
              ? "bg-cc-surface-strong text-cc-foreground"
              : "text-cc-muted hover:bg-cc-surface-strong/70 hover:text-cc-foreground"
          }`}
          onClick={() => onPanelChange("claude")}
        >
          <Wrench size={14} />
          Claude
        </button>
      <button
        className="ml-1 flex h-8 w-8 items-center justify-center rounded-md text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
        onClick={onClose}
        title="Close panel"
      >
        <X size={14} />
      </button>
      </div>
      {activePanel === "vault" ? <VaultPanel /> : <SkillsPanel onActivateSkill={onActivateSkill} />}
      <ResizeHandle tauriRuntime={tauriRuntime} edge="SouthEast" />
    </aside>
  );
}

function EmptyState({
  runtimeReady,
  onNewTab,
  error,
}: {
  runtimeReady: boolean;
  onNewTab: () => void;
  error: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-cc-background p-4">
      <div className="flex min-h-0 flex-1 flex-col rounded-md border border-cc-border bg-cc-surface/55 font-mono">
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-cc-border px-3 text-[11px] text-cc-muted">
          <div className="flex items-center gap-2">
            <SquareTerminal size={14} />
            <span>No Claude session</span>
          </div>
          <span>ready</span>
        </div>
        <div className="flex flex-1 flex-col justify-center px-6 py-8">
          <div className="max-w-lg">
            <div className="text-xs leading-6 text-cc-muted">
              <div>
                <span className="text-cc-accent">sogo</span>
                <span className="text-cc-muted">$</span>
                <span> new-session</span>
              </div>
              <div>
                <span className="text-cc-muted">starts Claude Code in a lightweight scratch terminal</span>
              </div>
            </div>
            <button
              className="mt-5 flex h-9 items-center gap-2 rounded-md bg-cc-accent px-3 text-sm font-medium text-cc-background hover:opacity-90"
              onClick={onNewTab}
            >
              <Play size={15} />
              New session
            </button>
          </div>
        </div>
        {!runtimeReady ? (
          <div className="mx-4 mb-4 rounded-md border border-amber-400/20 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
            Claude sessions run in the Tauri app. Browser preview shows layout only.
          </div>
        ) : null}
        {error ? (
          <div className="mx-4 mb-4 rounded-md border border-red-400/20 bg-red-400/10 p-3 text-xs leading-5 text-red-100">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default App;

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
    // bottom-3 right-3: distance from 22px radius corner = √(10²+10²) = 14.1 < 22 → visible through overflow-hidden
    return (
      <div className={`absolute bottom-3 right-3 z-20 p-2 ${cursor} opacity-40 transition-opacity hover:opacity-90`} onMouseDown={handleMouseDown}>
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-cc-muted">
          <circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" />
          <circle cx="5"   cy="8.5" r="1.3" fill="currentColor" />
          <circle cx="8.5" cy="5"   r="1.3" fill="currentColor" />
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
