import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

import { isTauriRuntime } from "@/lib/runtime";
import type { FileEntry } from "@/types";

interface FilesPanelProps {
  sessionId: string;
  cwd: string;
  folderChosen: boolean;
  activePath?: string | null;
  onOpenFile: (path: string) => void;
}

type LoadedMap = Record<string, FileEntry[]>;
type LoadingSet = Set<string>;

export function FilesPanel({ sessionId, cwd, folderChosen, activePath, onOpenFile }: FilesPanelProps) {
  const [loaded, setLoaded] = useState<LoadedMap>({});
  const [loading, setLoading] = useState<LoadingSet>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

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

  const toggle = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!loaded[path]) void loadDir(path);
        }
        return next;
      });
    },
    [loaded, loadDir],
  );

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
      <div className="flex h-10 shrink-0 items-center border-b border-cc-border/40 px-3">
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
            onToggle={toggle}
            onOpenFile={onOpenFile}
          />
        ) : null}
      </div>
    </section>
  );
}

function formatFileError(error: unknown) {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message);
  }

  return String(error);
}

function TreeLevel({
  entries,
  parentPath,
  depth,
  loaded,
  loading,
  expanded,
  activePath,
  onToggle,
  onOpenFile,
}: {
  entries: FileEntry[];
  parentPath: string;
  depth: number;
  loaded: LoadedMap;
  loading: LoadingSet;
  expanded: Set<string>;
  activePath?: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
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
          onToggle={onToggle}
          onOpenFile={onOpenFile}
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
  onToggle,
  onOpenFile,
}: {
  entry: FileEntry;
  depth: number;
  loaded: LoadedMap;
  loading: LoadingSet;
  expanded: Set<string>;
  activePath?: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const isExpanded = expanded.has(entry.path);
  const children = loaded[entry.path];
  const isActive = !entry.isDir && activePath === entry.path;

  return (
    <div>
      <button
        className={`flex w-full items-center gap-1.5 py-[3px] text-left text-xs transition-colors duration-150 hover:bg-cc-surface-strong ${
          isActive ? "bg-cc-surface-strong" : ""
        }`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => { if (entry.isDir) onToggle(entry.path); else onOpenFile(entry.path); }}
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
        <span className={`truncate pr-2 ${isActive ? "text-cc-foreground" : entry.isDir ? "text-cc-foreground/90" : "text-cc-muted"}`}>
          {entry.name}
        </span>
      </button>
      {entry.isDir && isExpanded ? (
        <TreeLevel
          entries={children ?? []}
          parentPath={entry.path}
          depth={depth + 1}
          loaded={loaded}
          loading={loading}
          expanded={expanded}
          activePath={activePath}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      ) : null}
    </div>
  );
}
