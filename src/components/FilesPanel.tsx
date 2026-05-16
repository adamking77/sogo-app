import { useCallback, useEffect, useState } from "react";
import { ChevronRight, FileText, Folder } from "lucide-react";

import { isTauriRuntime } from "@/lib/runtime";
import type { FileEntry } from "@/types";

interface FilesPanelProps {
  cwd: string;
  folderChosen: boolean;
}

type LoadedMap = Record<string, FileEntry[]>;
type LoadingSet = Set<string>;

export function FilesPanel({ cwd, folderChosen }: FilesPanelProps) {
  const [loaded, setLoaded] = useState<LoadedMap>({});
  const [loading, setLoading] = useState<LoadingSet>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (path: string) => {
    if (!isTauriRuntime()) return;
    setLoading((prev) => new Set([...prev, path]));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const entries = await invoke<FileEntry[]>("list_directory", { path });
      setLoaded((prev) => ({ ...prev, [path]: entries }));
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (!folderChosen || !cwd) return;
    setLoaded({});
    setExpanded(new Set());
    setError(null);
    void loadDir(cwd);
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
      <div className="flex h-11 shrink-0 items-center border-b border-cc-border px-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{rootName}</h2>
          <div className="truncate text-[11px] text-cc-muted">{cwd}</div>
        </div>
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
            onToggle={toggle}
          />
        ) : null}
      </div>
    </section>
  );
}

function TreeLevel({
  entries,
  parentPath,
  depth,
  loaded,
  loading,
  expanded,
  onToggle,
}: {
  entries: FileEntry[];
  parentPath: string;
  depth: number;
  loaded: LoadedMap;
  loading: LoadingSet;
  expanded: Set<string>;
  onToggle: (path: string) => void;
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
          onToggle={onToggle}
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
  onToggle,
}: {
  entry: FileEntry;
  depth: number;
  loaded: LoadedMap;
  loading: LoadingSet;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  const isExpanded = expanded.has(entry.path);
  const children = loaded[entry.path];

  return (
    <div>
      <button
        className="flex w-full items-center gap-1 py-[3px] text-left text-xs transition-colors duration-150 hover:bg-cc-surface-strong"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => { if (entry.isDir) onToggle(entry.path); }}
        title={entry.path}
      >
        {entry.isDir ? (
          <ChevronRight
            size={12}
            className={`shrink-0 text-cc-muted transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {entry.isDir ? (
          <Folder size={13} className="shrink-0 text-cc-muted" />
        ) : (
          <FileText size={13} className="shrink-0 text-cc-muted/60" />
        )}
        <span className={`truncate pr-2 ${entry.isDir ? "text-cc-foreground" : "text-cc-muted"}`}>
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
          onToggle={onToggle}
        />
      ) : null}
    </div>
  );
}
