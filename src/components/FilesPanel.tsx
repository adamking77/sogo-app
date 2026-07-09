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
type FileContextMenu = { x: number; y: number; entry: FileEntry | null; targetDir: string } | null;
const ACTION_MENU_WIDTH = 224;

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
  const [contextMenu, setContextMenu] = useState<FileContextMenu>(null);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const loadedRef = useRef(loaded);
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

  const refreshDir = useCallback((path: string) => {
    void loadDir(path === cwd ? undefined : path);
  }, [cwd, loadDir]);

  const createFile = useCallback(async (parentPath: string) => {
    const name = window.prompt("New file name");
    if (!name?.trim()) return;
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const meta = await invoke<{ path: string }>("create_workspace_file", {
        sessionId,
        parentPath,
        name: name.trim(),
      });
      refreshDir(parentPath);
      toastSuccess(`Created ${name.trim()}`);
      onOpenFile(meta.path);
    } catch (err) {
      toastError(formatFileError(err));
    }
  }, [onOpenFile, refreshDir, sessionId]);

  const createFolder = useCallback(async (parentPath: string) => {
    const name = window.prompt("New folder name");
    if (!name?.trim()) return;
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("create_workspace_directory", {
        sessionId,
        parentPath,
        name: name.trim(),
      });
      setExpanded((prev) => new Set(prev).add(parentPath));
      refreshDir(parentPath);
      toastSuccess(`Created ${name.trim()}`);
    } catch (err) {
      toastError(formatFileError(err));
    }
  }, [refreshDir, sessionId]);

  const importPaths = useCallback(async (targetDir: string, sourcePaths: string[]) => {
    if (!isTauriRuntime() || sourcePaths.length === 0) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const imported = await invoke<FileEntry[]>("import_paths_into_workspace", {
        sessionId,
        targetDir,
        sourcePaths,
      });
      setExpanded((prev) => new Set(prev).add(targetDir));
      refreshDir(targetDir);
      toastSuccess(imported.length === 1 ? `Imported ${imported[0].name}` : `Imported ${imported.length} items`);
    } catch (err) {
      toastError(formatFileError(err));
    }
  }, [refreshDir, sessionId]);

  const importWithDialog = useCallback(async (targetDir: string, directory: boolean) => {
    if (!isTauriRuntime()) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory, multiple: true });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      await importPaths(targetDir, paths);
    } catch (err) {
      toastError(String(err));
    }
  }, [importPaths]);

  const resolveDropTarget = useCallback((physicalX: number, physicalY: number) => {
    const scale = window.devicePixelRatio || 1;
    const element = document.elementFromPoint(physicalX / scale, physicalY / scale);
    const panel = panelRef.current;
    if (!element || !panel?.contains(element)) return null;
    const target = (element as HTMLElement).closest<HTMLElement>("[data-sogo-drop-dir]");
    return target?.dataset.sogoDropDir ?? cwd;
  }, [cwd]);

  useEffect(() => {
    if (!folderChosen || !isTauriRuntime()) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/webview")
      .then(async ({ getCurrentWebview }) => {
        if (cancelled) return;
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (cancelled) return;
          if (event.payload.type === "leave") {
            setDropTargetDir(null);
            return;
          }
          if (event.payload.type !== "over" && event.payload.type !== "enter" && event.payload.type !== "drop") return;
          const targetDir = resolveDropTarget(event.payload.position.x, event.payload.position.y);
          setDropTargetDir(targetDir);
          if (event.payload.type === "drop") {
            setDropTargetDir(null);
            if (targetDir && event.payload.paths.length > 0) {
              void importPaths(targetDir, event.payload.paths);
            }
          }
        });
      })
      .catch((err) => toastError(String(err)));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [folderChosen, importPaths, resolveDropTarget]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  if (!folderChosen) {
    return (
      <section className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center">
        <p className="text-xs text-cc-muted">Open a folder session to browse files.</p>
      </section>
    );
  }

  const rootName = cwd.split("/").filter(Boolean).pop() ?? cwd;
  const rootEntries = loaded[cwd];

  return (
    <section
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col"
      data-sogo-files-panel="true"
      data-sogo-drop-dir={cwd}
    >
      <div
        className={`flex h-10 shrink-0 items-center px-3 transition-colors ${dropTargetDir === cwd ? "bg-cc-accent/10" : ""}`}
        data-sogo-drop-dir={cwd}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ x: event.clientX, y: event.clientY, entry: null, targetDir: cwd });
        }}
      >
        <h2 className="truncate text-sm font-semibold" title={cwd}>{rootName}</h2>
      </div>
      {error ? (
        <div className="m-3 rounded-md border border-red-400/20 bg-red-400/10 p-3 text-xs text-red-100">{error}</div>
      ) : null}
      <div
        className="min-h-0 flex-1 overflow-y-auto py-1"
        data-sogo-drop-dir={cwd}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest("[data-sogo-file-row]")) return;
          event.preventDefault();
          setContextMenu({ x: event.clientX, y: event.clientY, entry: null, targetDir: cwd });
        }}
      >
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
            dropTargetDir={dropTargetDir}
            onOpenContextMenu={setContextMenu}
          />
        ) : null}
      </div>
      {contextMenu ? (
        <FileActionsMenu
          entry={contextMenu.entry}
          targetDir={contextMenu.targetDir}
          cwd={cwd}
          x={contextMenu.x}
          y={contextMenu.y}
          onOpenFile={onOpenFile}
          onOpenExternal={openExternal}
          onRevealPath={revealPath}
          onCopyPath={copyPath}
          onCreateFile={createFile}
          onCreateFolder={createFolder}
          onImportFiles={(targetDir) => void importWithDialog(targetDir, false)}
          onImportFolder={(targetDir) => void importWithDialog(targetDir, true)}
          onClose={() => setContextMenu(null)}
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
  dropTargetDir,
  onOpenContextMenu,
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
  dropTargetDir: string | null;
  onOpenContextMenu: (menu: FileContextMenu) => void;
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
          parentPath={parentPath}
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
          dropTargetDir={dropTargetDir}
          onOpenContextMenu={onOpenContextMenu}
        />
      ))}
    </>
  );
}

function TreeRow({
  entry,
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
  dropTargetDir,
  onOpenContextMenu,
}: {
  entry: FileEntry;
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
  dropTargetDir: string | null;
  onOpenContextMenu: (menu: FileContextMenu) => void;
}) {
  const isExpanded = expanded.has(entry.path);
  const children = loaded[entry.path];
  const isActive = !entry.isDir && activePath === entry.path;
  const changed = !entry.isDir && changedPaths.size > 0 && isChanged(entry.path, changedPaths);
  const rowDropDir = entry.isDir ? entry.path : parentPath;
  const isDropTarget = dropTargetDir === rowDropDir;

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        className={`group/file-row flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-xs transition-colors duration-150 hover:bg-cc-surface-strong ${
          isDropTarget ? "bg-cc-accent/10" : isActive ? "bg-cc-surface-strong" : ""
        }`}
        style={{ paddingLeft: 10 + depth * 14 }}
        data-sogo-file-row="true"
        data-sogo-drop-dir={rowDropDir}
        onClick={() => { if (entry.isDir) onToggle(entry.path); else onOpenFile(entry.path); }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (entry.isDir) onToggle(entry.path);
          else onOpenFile(entry.path);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenContextMenu({ x: event.clientX, y: event.clientY, entry, targetDir: rowDropDir });
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
          dropTargetDir={dropTargetDir}
          onOpenContextMenu={onOpenContextMenu}
        />
      ) : null}
    </div>
  );
}

function FileActionsMenu({
  entry,
  targetDir,
  cwd,
  x,
  y,
  onOpenFile,
  onOpenExternal,
  onRevealPath,
  onCopyPath,
  onCreateFile,
  onCreateFolder,
  onImportFiles,
  onImportFolder,
  onClose,
}: {
  entry: FileEntry | null;
  targetDir: string;
  cwd: string;
  x: number;
  y: number;
  onOpenFile: (path: string) => void;
  onOpenExternal: (path: string) => void;
  onRevealPath: (path: string) => void;
  onCopyPath: (path: string, variant: "absolute" | "relative") => void;
  onCreateFile: (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
  onImportFiles: (targetDir: string) => void;
  onImportFolder: (targetDir: string) => void;
  onClose: () => void;
}) {
  const position = clampActionMenuPosition(x, y, entry);

  return createPortal(
    <div
      className="sogo-pop sogo-elevated-bg fixed z-[70] w-[224px] rounded-xl border border-cc-border p-1 shadow-2xl"
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {!entry || entry.isDir ? (
        <>
          <ContextItem
            label="New file"
            onClick={() => {
              onClose();
              onCreateFile(targetDir);
            }}
          />
          <ContextItem
            label="New folder"
            onClick={() => {
              onClose();
              onCreateFolder(targetDir);
            }}
          />
          <div className="mx-2 my-1 h-px bg-cc-border/60" />
          <ContextItem
            label="Import files..."
            onClick={() => {
              onClose();
              onImportFiles(targetDir);
            }}
          />
          <ContextItem
            label="Import folder..."
            onClick={() => {
              onClose();
              onImportFolder(targetDir);
            }}
          />
          <div className="mx-2 my-1 h-px bg-cc-border/60" />
        </>
      ) : null}
      {entry && !entry.isDir ? (
        <ContextItem
          label="Open in Sogo"
          onClick={() => {
            onClose();
            onOpenFile(entry.path);
          }}
        />
      ) : null}
      {entry ? (
        <>
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
        </>
      ) : null}
      <div className="truncate px-2.5 pb-1 pt-1.5 font-mono text-[10px] text-cc-muted/70" title={entry?.path ?? targetDir}>
        {relativePath(cwd, entry?.path ?? targetDir)}
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

function actionMenuHeight(entry: FileEntry | null) {
  if (!entry) return 198;
  return entry.isDir ? 328 : 174;
}

function clampActionMenuPosition(x: number, y: number, entry: FileEntry | null) {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - ACTION_MENU_WIDTH - margin);
  const maxY = Math.max(margin, window.innerHeight - actionMenuHeight(entry) - margin);

  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY),
  };
}
