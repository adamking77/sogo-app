import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";

import { isTauriRuntime } from "@/lib/runtime";
import { toastError, toastSuccess } from "@/stores/toastStore";
import type { FileEntry } from "@/types";

interface FilesPanelProps {
  sessionId: string;
  cwd: string;
  folderChosen: boolean;
  activePath?: string | null;
  /** Bumps when the workspace filesystem changes; refreshes loaded dirs. */
  fsRevision: number;
  /** Workspace-relative changed paths from git, for dirty markers. */
  changedPaths: Set<string>;
  onOpenFile: (path: string) => void;
}

type LoadedMap = Record<string, FileEntry[]>;
type LoadingSet = Set<string>;
type FileActionMenu = { x: number; y: number; entry: FileEntry; source: "context" | "hover" } | null;
const ACTION_MENU_WIDTH = 212;

export function FilesPanel({
  sessionId,
  cwd,
  folderChosen,
  activePath,
  fsRevision,
  changedPaths,
  onOpenFile,
}: FilesPanelProps) {
  const [loaded, setLoaded] = useState<LoadedMap>({});
  const [loading, setLoading] = useState<LoadingSet>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [actionMenu, setActionMenu] = useState<FileActionMenu>(null);
  const loadedRef = useRef(loaded);
  const hoverCloseTimerRef = useRef<number | null>(null);
  loadedRef.current = loaded;

  const loadDir = useCallback(async (path?: string) => {
    if (!isTauriRuntime()) return;
    const key = path ?? cwd;
    setLoading((prev) => new Set([...prev, key]));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const entries = await invoke<FileEntry[]>("list_directory", { sessionId, path });
      setLoaded((prev) => ({ ...prev, [key]: entries }));
      setError(null);
    } catch (err) {
      setError(formatFileError(err));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [cwd, sessionId]);

  useEffect(() => {
    if (!folderChosen || !cwd) return;
    setLoaded({});
    setExpanded(new Set());
    setError(null);
    void loadDir();
  }, [cwd, folderChosen, loadDir]);

  // Filesystem changed under us (usually Claude writing files): re-list every
  // directory we have loaded so the tree stays truthful.
  useEffect(() => {
    if (fsRevision === 0 || !folderChosen) return;
    for (const key of Object.keys(loadedRef.current)) {
      void loadDir(key === cwd ? undefined : key);
    }
  }, [fsRevision, folderChosen, cwd, loadDir]);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!loadedRef.current[path]) void loadDir(path);
        }
        return next;
      });
    },
    [loadDir],
  );

  const revealPath = useCallback(async (path: string) => {
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("reveal_in_finder", { path });
    } catch (err) {
      toastError(String(err));
    }
  }, []);

  const openExternal = useCallback(async (path: string) => {
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_path_in_default_app", { path });
    } catch (err) {
      toastError(String(err));
    }
  }, []);

  const copyPath = useCallback(async (path: string, variant: "absolute" | "relative") => {
    const text = variant === "relative" ? relativePath(cwd, path) : path;
    try {
      await navigator.clipboard?.writeText(text);
      toastSuccess(variant === "relative" ? "Copied relative path" : "Copied full path");
    } catch (err) {
      toastError(`Could not copy path: ${String(err)}`);
    }
  }, [cwd]);

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  const openActionMenu = useCallback((menu: NonNullable<FileActionMenu>) => {
    clearHoverCloseTimer();
    setActionMenu(menu);
  }, [clearHoverCloseTimer]);

  const scheduleHoverMenuClose = useCallback(() => {
    clearHoverCloseTimer();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      setActionMenu((current) => current?.source === "hover" ? null : current);
      hoverCloseTimerRef.current = null;
    }, 180);
  }, [clearHoverCloseTimer]);

  useEffect(() => {
    return () => clearHoverCloseTimer();
  }, [clearHoverCloseTimer]);

  useEffect(() => {
    if (!actionMenu) return;
    const close = () => {
      clearHoverCloseTimer();
      setActionMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [actionMenu, clearHoverCloseTimer]);

  if (!folderChosen) {
    return (
      <section className="flex min-h-0 flex-1 flex-col items-center justify-center bg-cc-surface p-6 text-center">
        <p className="text-xs text-cc-muted">Open a folder session to browse files.</p>
      </section>
    );
  }

  const rootName = cwd.split("/").filter(Boolean).pop() ?? cwd;
  const rootEntries = loaded[cwd];

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-cc-surface">
      <div className="flex h-10 shrink-0 items-center px-3">
        <h2 className="truncate text-sm font-semibold" title={cwd}>{rootName}</h2>
      </div>
      {error ? (
        <div className="m-3 rounded-md border border-red-400/20 bg-red-400/10 p-3 text-xs text-red-100">{error}</div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading.has(cwd) && !rootEntries ? (
          <div className="px-4 py-2 text-xs text-cc-muted">Loading...</div>
        ) : rootEntries ? (
          <TreeLevel
            entries={rootEntries}
            parentPath={cwd}
            depth={0}
            loaded={loaded}
            loading={loading}
            expanded={expanded}
            activePath={activePath}
            changedPaths={changedPaths}
            onToggle={toggle}
            onOpenFile={onOpenFile}
            onOpenExternal={openExternal}
            onRevealPath={revealPath}
            onCopyPath={copyPath}
            onOpenActionMenu={openActionMenu}
            onScheduleHoverMenuClose={scheduleHoverMenuClose}
          />
        ) : null}
      </div>
      {actionMenu ? (
        <FileActionsMenu
          entry={actionMenu.entry}
          cwd={cwd}
          x={actionMenu.x}
          y={actionMenu.y}
          source={actionMenu.source}
          onOpenFile={onOpenFile}
          onOpenExternal={openExternal}
          onRevealPath={revealPath}
          onCopyPath={copyPath}
          onClose={() => {
            clearHoverCloseTimer();
            setActionMenu(null);
          }}
          onKeepOpen={clearHoverCloseTimer}
          onScheduleClose={scheduleHoverMenuClose}
        />
      ) : null}
    </section>
  );
}

function formatFileError(error: unknown) {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message);
  }

  return String(error);
}

function isChanged(absolutePath: string, changedPaths: Set<string>) {
  for (const relative of changedPaths) {
    if (absolutePath.endsWith(`/${relative}`)) return true;
  }
  return false;
}

function TreeLevel({
  entries,
  parentPath,
  depth,
  loaded,
  loading,
  expanded,
  activePath,
  changedPaths,
  onToggle,
  onOpenFile,
  onOpenExternal,
  onRevealPath,
  onCopyPath,
  onOpenActionMenu,
  onScheduleHoverMenuClose,
}: {
  entries: FileEntry[];
  parentPath: string;
  depth: number;
  loaded: LoadedMap;
  loading: LoadingSet;
  expanded: Set<string>;
  activePath?: string | null;
  changedPaths: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenExternal: (path: string) => void;
  onRevealPath: (path: string) => void;
  onCopyPath: (path: string, variant: "absolute" | "relative") => void;
  onOpenActionMenu: (menu: NonNullable<FileActionMenu>) => void;
  onScheduleHoverMenuClose: () => void;
}) {
  if (loading.has(parentPath) && entries.length === 0) {
    return (
      <div className="py-0.5 text-xs text-cc-muted" style={{ paddingLeft: 8 + depth * 14 }}>
        Loading...
      </div>
    );
  }

  return (
    <>
      {entries.map((entry) => (
        <TreeRow
          key={entry.path}
          entry={entry}
          depth={depth}
          loaded={loaded}
          loading={loading}
          expanded={expanded}
          activePath={activePath}
          changedPaths={changedPaths}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          onOpenExternal={onOpenExternal}
          onRevealPath={onRevealPath}
          onCopyPath={onCopyPath}
          onOpenActionMenu={onOpenActionMenu}
          onScheduleHoverMenuClose={onScheduleHoverMenuClose}
        />
      ))}
    </>
  );
}

function TreeRow({
  entry,
  depth,
  loaded,
  loading,
  expanded,
  activePath,
  changedPaths,
  onToggle,
  onOpenFile,
  onOpenExternal,
  onRevealPath,
  onCopyPath,
  onOpenActionMenu,
  onScheduleHoverMenuClose,
}: {
  entry: FileEntry;
  depth: number;
  loaded: LoadedMap;
  loading: LoadingSet;
  expanded: Set<string>;
  activePath?: string | null;
  changedPaths: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenExternal: (path: string) => void;
  onRevealPath: (path: string) => void;
  onCopyPath: (path: string, variant: "absolute" | "relative") => void;
  onOpenActionMenu: (menu: NonNullable<FileActionMenu>) => void;
  onScheduleHoverMenuClose: () => void;
}) {
  const isExpanded = expanded.has(entry.path);
  const children = loaded[entry.path];
  const isActive = !entry.isDir && activePath === entry.path;
  const changed = !entry.isDir && changedPaths.size > 0 && isChanged(entry.path, changedPaths);
  const openHoverMenu = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const height = actionMenuHeight(entry.isDir);
    const rightSideX = rect.right + 6;
    const x = rightSideX + ACTION_MENU_WIDTH < window.innerWidth
      ? rightSideX
      : Math.max(8, rect.left - ACTION_MENU_WIDTH - 6);
    const y = Math.min(Math.max(8, rect.top - 4), Math.max(8, window.innerHeight - height - 8));
    onOpenActionMenu({ x, y, entry, source: "hover" });
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        className={`flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-xs transition-colors duration-150 hover:bg-cc-surface-strong ${
          isActive ? "bg-cc-surface-strong" : ""
        }`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => { if (entry.isDir) onToggle(entry.path); else onOpenFile(entry.path); }}
        onMouseEnter={(event) => openHoverMenu(event.currentTarget)}
        onMouseLeave={onScheduleHoverMenuClose}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (entry.isDir) onToggle(entry.path);
          else onOpenFile(entry.path);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenActionMenu({ x: event.clientX, y: event.clientY, entry, source: "context" });
        }}
        title={entry.path}
      >
        {entry.isDir ? (
          <ChevronRight
            size={12}
            className={`shrink-0 text-cc-muted/70 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className={`min-w-0 truncate ${isActive ? "text-cc-foreground" : entry.isDir ? "text-cc-foreground/90" : "text-cc-muted"}`}>
          {entry.name}
        </span>
        {changed ? (
          <span className="mr-2 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300/80" title="Modified (git)" />
        ) : null}
      </div>
      {entry.isDir && isExpanded ? (
        <TreeLevel
          entries={children ?? []}
          parentPath={entry.path}
          depth={depth + 1}
          loaded={loaded}
          loading={loading}
          expanded={expanded}
          activePath={activePath}
          changedPaths={changedPaths}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          onOpenExternal={onOpenExternal}
          onRevealPath={onRevealPath}
          onCopyPath={onCopyPath}
          onOpenActionMenu={onOpenActionMenu}
          onScheduleHoverMenuClose={onScheduleHoverMenuClose}
        />
      ) : null}
    </div>
  );
}

function FileActionsMenu({
  entry,
  cwd,
  x,
  y,
  source,
  onOpenFile,
  onOpenExternal,
  onRevealPath,
  onCopyPath,
  onClose,
  onKeepOpen,
  onScheduleClose,
}: {
  entry: FileEntry;
  cwd: string;
  x: number;
  y: number;
  source: "context" | "hover";
  onOpenFile: (path: string) => void;
  onOpenExternal: (path: string) => void;
  onRevealPath: (path: string) => void;
  onCopyPath: (path: string, variant: "absolute" | "relative") => void;
  onClose: () => void;
  onKeepOpen: () => void;
  onScheduleClose: () => void;
}) {
  const position = clampActionMenuPosition(x, y, entry.isDir);

  return createPortal(
    <div
      className="sogo-pop fixed z-[70] w-[212px] rounded-xl border border-cc-border bg-cc-surface/95 p-1 shadow-2xl"
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseEnter={onKeepOpen}
      onMouseLeave={() => {
        if (source === "hover") onScheduleClose();
      }}
    >
      {!entry.isDir ? (
        <ContextItem
          label="Open in Sogo"
          onClick={() => {
            onClose();
            onOpenFile(entry.path);
          }}
        />
      ) : null}
      <ContextItem
        label={entry.isDir ? "Open in Finder" : "Open with default app"}
        onClick={() => {
          onClose();
          onOpenExternal(entry.path);
        }}
      />
      <ContextItem
        label="Reveal in Finder"
        onClick={() => {
          onClose();
          onRevealPath(entry.path);
        }}
      />
      <div className="mx-2 my-1 h-px bg-cc-border/60" />
      <ContextItem
        label="Copy relative path"
        onClick={() => {
          onClose();
          onCopyPath(entry.path, "relative");
        }}
      />
      <ContextItem
        label="Copy full path"
        onClick={() => {
          onClose();
          onCopyPath(entry.path, "absolute");
        }}
      />
      <div className="truncate px-2.5 pb-1 pt-1.5 font-mono text-[10px] text-cc-muted/70" title={entry.path}>
        {relativePath(cwd, entry.path)}
      </div>
    </div>,
    document.body,
  );
}

function ContextItem({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-xs text-cc-muted transition-colors duration-100 hover:bg-cc-surface-strong hover:text-cc-foreground"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function relativePath(cwd: string, path: string) {
  if (path === cwd) return ".";
  if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path;
}

function actionMenuHeight(isDir: boolean) {
  return isDir ? 142 : 174;
}

function clampActionMenuPosition(x: number, y: number, isDir: boolean) {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - ACTION_MENU_WIDTH - margin);
  const maxY = Math.max(margin, window.innerHeight - actionMenuHeight(isDir) - margin);

  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY),
  };
}
