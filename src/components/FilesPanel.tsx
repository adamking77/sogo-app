import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
type EditingState =
  | { mode: "create-file" | "create-folder"; parentPath: string }
  | { mode: "rename"; entry: FileEntry }
  | null;

const DRAG_THRESHOLD_PX = 6;

type DragGhost = { name: string; x: number; y: number } | null;

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
  const [editing, setEditing] = useState<EditingState>(null);
  const [filter, setFilter] = useState("");
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
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
    setEditing(null);
    setFilter("");
    setAllFiles(null);
    void loadDir();
  }, [cwd, folderChosen, loadDir]);

  // Filesystem changed under us (usually Claude writing files): re-list every
  // directory we have loaded so the tree stays truthful.
  useEffect(() => {
    if (fsRevision === 0 || !folderChosen) return;
    setAllFiles(null);
    for (const key of Object.keys(loadedRef.current)) {
      void loadDir(key === cwd ? undefined : key);
    }
  }, [fsRevision, folderChosen, cwd, loadDir]);

  // Filtering searches every workspace file, not just loaded dirs; fetch the
  // recursive listing lazily the first time a filter is typed.
  useEffect(() => {
    if (!filter.trim() || allFiles !== null || !isTauriRuntime()) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string[]>("list_files_recursive", { sessionId })
        .then(setAllFiles)
        .catch((err) => toastError(formatFileError(err)));
    });
  }, [filter, allFiles, sessionId]);

  const filteredFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query || !allFiles) return null;
    return allFiles.filter((path) => path.toLowerCase().includes(query)).slice(0, 200);
  }, [filter, allFiles]);

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

  const beginCreate = useCallback((parentPath: string, mode: "create-file" | "create-folder") => {
    setExpanded((prev) => new Set(prev).add(parentPath));
    if (parentPath !== cwd && !loadedRef.current[parentPath]) void loadDir(parentPath);
    setEditing({ mode, parentPath });
  }, [cwd, loadDir]);

  const beginRename = useCallback((entry: FileEntry) => {
    setEditing({ mode: "rename", entry });
  }, []);

  const commitEditing = useCallback(async (name: string) => {
    const current = editing;
    setEditing(null);
    const trimmed = name.trim();
    if (!current || !trimmed || !isTauriRuntime()) return;

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (current.mode === "rename") {
        if (trimmed === current.entry.name) return;
        await invoke<FileEntry>("rename_workspace_path", {
          sessionId,
          path: current.entry.path,
          newName: trimmed,
        });
        refreshDir(parentDir(current.entry.path));
        setAllFiles(null);
        toastSuccess(`Renamed to ${trimmed}`);
      } else if (current.mode === "create-file") {
        const meta = await invoke<{ path: string }>("create_workspace_file", {
          sessionId,
          parentPath: current.parentPath,
          name: trimmed,
        });
        refreshDir(current.parentPath);
        toastSuccess(`Created ${trimmed}`);
        onOpenFile(meta.path);
      } else if (current.mode === "create-folder") {
        await invoke("create_workspace_directory", {
          sessionId,
          parentPath: current.parentPath,
          name: trimmed,
        });
        refreshDir(current.parentPath);
        toastSuccess(`Created ${trimmed}`);
      }
    } catch (err) {
      toastError(formatFileError(err));
    }
  }, [editing, onOpenFile, refreshDir, sessionId]);

  const deletePath = useCallback(async (entry: FileEntry) => {
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_workspace_path", { sessionId, path: entry.path });
      refreshDir(parentDir(entry.path));
      setAllFiles(null);
      toastSuccess(`Moved ${entry.name} to Trash`);
    } catch (err) {
      toastError(formatFileError(err));
    }
  }, [refreshDir, sessionId]);

  const duplicatePath = useCallback(async (entry: FileEntry) => {
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const copy = await invoke<FileEntry>("duplicate_workspace_path", { sessionId, path: entry.path });
      refreshDir(parentDir(entry.path));
      setAllFiles(null);
      toastSuccess(`Duplicated as ${copy.name}`);
    } catch (err) {
      toastError(formatFileError(err));
    }
  }, [refreshDir, sessionId]);

  const movePath = useCallback(async (sourcePath: string, targetDir: string) => {
    if (!isTauriRuntime() || parentDir(sourcePath) === targetDir || sourcePath === targetDir) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const moved = await invoke<FileEntry>("move_workspace_path", { sessionId, sourcePath, targetDir });
      refreshDir(parentDir(sourcePath));
      setExpanded((prev) => new Set(prev).add(targetDir));
      refreshDir(targetDir);
      setAllFiles(null);
      toastSuccess(`Moved ${moved.name}`);
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
      setAllFiles(null);
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

  // Internal drag (tree row -> folder row / terminal). Pointer-based, not
  // HTML5 DnD: with Tauri's native drag-drop handler enabled (required for
  // OS file imports), WKWebView swallows in-page HTML5 drop events entirely.
  const [dragGhost, setDragGhost] = useState<DragGhost>(null);
  const dragStateRef = useRef<{
    path: string;
    name: string;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const handleRowPointerDown = useCallback((event: React.PointerEvent, entry: FileEntry) => {
    if (event.button !== 0) return;
    dragStateRef.current = {
      path: entry.path,
      name: entry.name,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };

    const onPointerMove = (move: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      if (!state.active) {
        if (Math.hypot(move.clientX - state.startX, move.clientY - state.startY) < DRAG_THRESHOLD_PX) {
          return;
        }
        state.active = true;
        document.body.style.userSelect = "none";
      }
      setDragGhost({ name: state.name, x: move.clientX, y: move.clientY });

      const element = document.elementFromPoint(move.clientX, move.clientY);
      const dirElement = panelRef.current?.contains(element)
        ? (element as HTMLElement | null)?.closest<HTMLElement>("[data-sogo-drop-dir]")
        : null;
      setDropTargetDir(dirElement?.dataset.sogoDropDir ?? null);
    };

    const onPointerUp = (up: PointerEvent) => {
      window.removeEventListener("pointermove", onPointerMove);
      const state = dragStateRef.current;
      dragStateRef.current = null;
      setDragGhost(null);
      setDropTargetDir(null);
      document.body.style.userSelect = "";
      if (!state?.active) return;

      // Swallow the click that follows this pointerup so the drop doesn't
      // also toggle/open the row it started on.
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);

      const element = document.elementFromPoint(up.clientX, up.clientY);
      const dirElement = panelRef.current?.contains(element)
        ? (element as HTMLElement | null)?.closest<HTMLElement>("[data-sogo-drop-dir]")
        : null;
      if (dirElement?.dataset.sogoDropDir) {
        void movePath(state.path, dirElement.dataset.sogoDropDir);
        return;
      }
      if ((element as HTMLElement | null)?.closest(".session-terminal-shell")) {
        window.dispatchEvent(
          new CustomEvent("sogo:insert-terminal-path", {
            detail: relativePath(cwd, state.path),
          }),
        );
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }, [cwd, movePath]);

  const handleRowClickCapture = useCallback((event: React.MouseEvent) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  // Roving arrow-key navigation over the rendered rows.
  const handleTreeKeyDown = useCallback((event: React.KeyboardEvent, entry: FileEntry | null) => {
    const keys = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    const rows = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>("[data-sogo-file-row]") ?? [],
    );
    const index = rows.indexOf(event.currentTarget as HTMLElement);
    if (index < 0) return;

    if (event.key === "ArrowDown") {
      rows[index + 1]?.focus();
    } else if (event.key === "ArrowUp") {
      rows[index - 1]?.focus();
    } else if (event.key === "ArrowRight") {
      if (entry?.isDir && !expanded.has(entry.path)) toggle(entry.path);
      else rows[index + 1]?.focus();
    } else if (event.key === "ArrowLeft") {
      if (entry?.isDir && expanded.has(entry.path)) {
        toggle(entry.path);
      } else if (entry) {
        const parent = parentDir(entry.path);
        rows.find((row) => row.dataset.sogoPath === parent)?.focus();
      }
    }
  }, [expanded, toggle]);

  if (!folderChosen) {
    return (
      <section className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center">
        <p className="text-xs text-cc-muted">Open a folder session to browse files.</p>
      </section>
    );
  }

  const rootName = cwd.split("/").filter(Boolean).pop() ?? cwd;
  const rootEntries = loaded[cwd];
  const filtering = !!filter.trim();

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
      <div className="px-2 pb-1">
        <input
          className="h-7 w-full rounded-md border border-cc-border bg-cc-background px-2 text-xs text-cc-foreground outline-none placeholder:text-cc-muted transition-colors duration-150 focus:border-cc-accent/40 focus:ring-1 focus:ring-cc-accent/30"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter files"
          aria-label="Filter files"
        />
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
        {filtering ? (
          <FilteredList
            cwd={cwd}
            files={filteredFiles}
            changedPaths={changedPaths}
            onOpenFile={onOpenFile}
          />
        ) : loading.has(cwd) && !rootEntries ? (
          <div className="px-4 py-2 text-xs text-cc-muted">Loading...</div>
        ) : rootEntries ? (
          <>
            {editing && editing.mode !== "rename" && editing.parentPath === cwd ? (
              <InlineNameInput
                depth={0}
                placeholder={editing.mode === "create-file" ? "New file name" : "New folder name"}
                onCommit={(name) => void commitEditing(name)}
                onCancel={() => setEditing(null)}
              />
            ) : null}
            <TreeLevel
              entries={rootEntries}
              parentPath={cwd}
              depth={0}
              cwd={cwd}
              loaded={loaded}
              loading={loading}
              expanded={expanded}
              activePath={activePath}
              changedPaths={changedPaths}
              editing={editing}
              onToggle={toggle}
              onOpenFile={onOpenFile}
              onOpenContextMenu={setContextMenu}
              onCommitEditing={(name) => void commitEditing(name)}
              onCancelEditing={() => setEditing(null)}
              onKeyNav={handleTreeKeyDown}
              onRowPointerDown={handleRowPointerDown}
              onRowClickCapture={handleRowClickCapture}
              dropTargetDir={dropTargetDir}
            />
          </>
        ) : null}
      </div>
      {dragGhost
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[200] rounded-md border border-cc-border bg-cc-surface px-2 py-1 text-xs text-cc-foreground shadow-lg"
              style={{ left: dragGhost.x + 12, top: dragGhost.y + 10 }}
            >
              {dragGhost.name}
            </div>,
            document.body,
          )
        : null}
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
          onCreateFile={(dir) => beginCreate(dir, "create-file")}
          onCreateFolder={(dir) => beginCreate(dir, "create-folder")}
          onImportFiles={(targetDir) => void importWithDialog(targetDir, false)}
          onImportFolder={(targetDir) => void importWithDialog(targetDir, true)}
          onRename={beginRename}
          onDuplicate={(entry) => void duplicatePath(entry)}
          onDelete={(entry) => void deletePath(entry)}
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

function parentDir(path: string) {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : path;
}

function isChanged(absolutePath: string, cwd: string, changedPaths: Set<string>) {
  return changedPaths.has(relativePath(cwd, absolutePath));
}

function dirHasChanges(absoluteDir: string, cwd: string, changedPaths: Set<string>) {
  const prefix = `${relativePath(cwd, absoluteDir)}/`;
  for (const relative of changedPaths) {
    if (relative.startsWith(prefix)) return true;
  }
  return false;
}

function FilteredList({
  cwd,
  files,
  changedPaths,
  onOpenFile,
}: {
  cwd: string;
  files: string[] | null;
  changedPaths: Set<string>;
  onOpenFile: (path: string) => void;
}) {
  if (!files) {
    return <div className="px-4 py-2 text-xs text-cc-muted">Searching...</div>;
  }
  if (files.length === 0) {
    return <div className="px-4 py-2 text-xs text-cc-muted">No matching files.</div>;
  }

  return (
    <>
      {files.map((relative) => {
        const name = relative.split("/").pop() ?? relative;
        const dir = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
        return (
          <div
            key={relative}
            role="button"
            tabIndex={0}
            className="flex w-full items-center gap-1.5 py-[3px] pl-3 pr-2 text-left text-xs transition-colors duration-150 hover:bg-cc-surface-strong"
            data-sogo-file-row="true"
            onClick={() => onOpenFile(`${cwd}/${relative}`)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onOpenFile(`${cwd}/${relative}`);
            }}
            title={relative}
          >
            <span className="min-w-0 truncate text-cc-foreground/90">{name}</span>
            {dir ? <span className="min-w-0 truncate text-[10px] text-cc-muted/70">{dir}</span> : null}
            {changedPaths.has(relative) ? (
              <span className="ml-auto mr-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300/80" title="Modified (git)" />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function InlineNameInput({
  depth,
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  depth: number;
  initial?: string;
  placeholder?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    if (initial) {
      const dot = initial.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }
  }, [initial]);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const value = inputRef.current?.value ?? "";
    if (commit && value.trim() && value.trim() !== initial) onCommit(value);
    else onCancel();
  };

  return (
    <div className="flex items-center py-[2px] pr-2" style={{ paddingLeft: 10 + depth * 14 + 18 }}>
      <input
        ref={inputRef}
        defaultValue={initial}
        placeholder={placeholder}
        className="h-6 w-full rounded border border-cc-accent/50 bg-cc-background px-1.5 text-xs text-cc-foreground outline-none ring-1 ring-cc-accent/30"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") finish(true);
          if (event.key === "Escape") finish(false);
        }}
        onBlur={() => finish(true)}
      />
    </div>
  );
}

interface TreeSharedProps {
  cwd: string;
  loaded: LoadedMap;
  loading: LoadingSet;
  expanded: Set<string>;
  activePath?: string | null;
  changedPaths: Set<string>;
  editing: EditingState;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenContextMenu: (menu: FileContextMenu) => void;
  onCommitEditing: (name: string) => void;
  onCancelEditing: () => void;
  onKeyNav: (event: React.KeyboardEvent, entry: FileEntry | null) => void;
  onRowPointerDown: (event: React.PointerEvent, entry: FileEntry) => void;
  onRowClickCapture: (event: React.MouseEvent) => void;
  dropTargetDir: string | null;
}

function TreeLevel({
  entries,
  parentPath,
  depth,
  ...shared
}: TreeSharedProps & {
  entries: FileEntry[];
  parentPath: string;
  depth: number;
}) {
  if (shared.loading.has(parentPath) && entries.length === 0) {
    return (
      <div className="py-0.5 text-xs text-cc-muted" style={{ paddingLeft: 8 + depth * 14 }}>
        Loading...
      </div>
    );
  }

  return (
    <>
      {entries.map((entry) => (
        <TreeRow key={entry.path} entry={entry} parentPath={parentPath} depth={depth} {...shared} />
      ))}
    </>
  );
}

function TreeRow({
  entry,
  parentPath,
  depth,
  ...shared
}: TreeSharedProps & {
  entry: FileEntry;
  parentPath: string;
  depth: number;
}) {
  const {
    cwd,
    loaded,
    expanded,
    activePath,
    changedPaths,
    editing,
    onToggle,
    onOpenFile,
    onOpenContextMenu,
    onCommitEditing,
    onCancelEditing,
    onKeyNav,
    onRowPointerDown,
    onRowClickCapture,
    dropTargetDir,
  } = shared;
  const isExpanded = expanded.has(entry.path);
  const children = loaded[entry.path];
  const isActive = !entry.isDir && activePath === entry.path;
  const changed = changedPaths.size > 0
    && (entry.isDir
      ? !isExpanded && dirHasChanges(entry.path, cwd, changedPaths)
      : isChanged(entry.path, cwd, changedPaths));
  const rowDropDir = entry.isDir ? entry.path : parentPath;
  const isDropTarget = dropTargetDir === rowDropDir;
  const isRenaming = editing?.mode === "rename" && editing.entry.path === entry.path;
  const creatingHere = editing && editing.mode !== "rename" && editing.parentPath === entry.path;

  return (
    <div>
      {isRenaming ? (
        <InlineNameInput
          depth={depth}
          initial={entry.name}
          onCommit={onCommitEditing}
          onCancel={onCancelEditing}
        />
      ) : (
        <div
          role="button"
          tabIndex={0}
          className={`group/file-row flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-xs transition-colors duration-150 hover:bg-cc-surface-strong ${
            isDropTarget ? "bg-cc-accent/10" : isActive ? "bg-cc-surface-strong" : ""
          }`}
          style={{ paddingLeft: 10 + depth * 14 }}
          data-sogo-file-row="true"
          data-sogo-path={entry.path}
          data-sogo-drop-dir={rowDropDir}
          onPointerDown={(event) => onRowPointerDown(event, entry)}
          onClickCapture={onRowClickCapture}
          onClick={() => { if (entry.isDir) onToggle(entry.path); else onOpenFile(entry.path); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (entry.isDir) onToggle(entry.path);
              else onOpenFile(entry.path);
              return;
            }
            onKeyNav(event, entry);
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
      )}
      {creatingHere && isExpanded ? (
        <InlineNameInput
          depth={depth + 1}
          placeholder={editing.mode === "create-file" ? "New file name" : "New folder name"}
          onCommit={onCommitEditing}
          onCancel={onCancelEditing}
        />
      ) : null}
      {entry.isDir && isExpanded ? (
        <TreeLevel entries={children ?? []} parentPath={entry.path} depth={depth + 1} {...shared} />
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
  onRename,
  onDuplicate,
  onDelete,
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
  onRename: (entry: FileEntry) => void;
  onDuplicate: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Measure the real rendered menu, then clamp into the viewport. Hardcoded
  // height tables rot every time an item is added.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    setPosition({
      x: Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - rect.width - margin)),
      y: Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - rect.height - margin)),
    });
  }, [x, y]);

  return createPortal(
    <div
      ref={menuRef}
      className="sogo-pop sogo-elevated-bg fixed z-[70] w-[224px] rounded-xl border border-cc-border p-1 shadow-2xl"
      style={{
        left: position?.x ?? x,
        top: position?.y ?? y,
        visibility: position ? "visible" : "hidden",
      }}
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
            label="Rename"
            onClick={() => {
              onClose();
              onRename(entry);
            }}
          />
          <ContextItem
            label="Duplicate"
            onClick={() => {
              onClose();
              onDuplicate(entry);
            }}
          />
          <ContextItem
            label={confirmingDelete ? "Confirm move to Trash" : "Move to Trash"}
            danger={confirmingDelete}
            onClick={() => {
              if (!confirmingDelete) {
                setConfirmingDelete(true);
                return;
              }
              onClose();
              onDelete(entry);
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
  danger,
  onClick,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors duration-100 ${
        danger
          ? "bg-red-400/10 text-red-300 hover:bg-red-400/20"
          : "text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
      }`}
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
