import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Loader2, Pencil, RefreshCw, X } from "lucide-react";

import { isTauriRuntime } from "@/lib/runtime";
import type { GitChange } from "@/types";

interface DiffPaneProps {
  sessionId: string;
  change: GitChange;
  /** Bumps when the filesystem changes; triggers a re-fetch. */
  fsRevision: number;
  onClose: () => void;
  onOpenFile: (relativePath: string) => void;
  onDragMouseDown: (event: ReactMouseEvent) => void;
  onBeginResize: (event: ReactMouseEvent) => void;
}

type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export function DiffPane({
  sessionId,
  change,
  fsRevision,
  onClose,
  onOpenFile,
  onDragMouseDown,
  onBeginResize,
}: DiffPaneProps) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;

    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke<string>("git_diff_file", { sessionId, path: change.path, status: change.status })
        .then((contents) => {
          if (!cancelled) {
            setDiff(contents);
            setError(null);
          }
        })
        .catch((diffError) => {
          if (!cancelled) setError(String(diffError));
        });
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId, change.path, change.status, fsRevision]);

  const lines = useMemo(() => (diff ?? "").split("\n").map(classifyDiffLine), [diff]);
  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.kind === "add") added += 1;
      if (line.kind === "del") removed += 1;
    }
    return { added, removed };
  }, [lines]);

  const deleted = change.status.trim().startsWith("D");

  return (
    <aside className="file-editor-pane relative flex h-full w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-[22px] border border-cc-border bg-cc-background shadow-[-30px_18px_72px_-30px_rgba(0,0,0,0.6),-2px_0_8px_-3px_rgba(0,0,0,0.35)]">
      <div
        className="group/resize absolute inset-y-0 left-0 z-30 w-3 cursor-col-resize"
        onMouseDown={(event) => {
          event.stopPropagation();
          onBeginResize(event);
        }}
        title="Resize diff"
        aria-label="Resize diff"
      >
        <div className="mx-auto h-full w-[3px] rounded-full bg-cc-accent/0 transition-colors duration-150 group-hover/resize:bg-cc-accent/35" />
      </div>
      <div
        className="h-3 w-full shrink-0 cursor-grab"
        data-tauri-drag-region
        onMouseDown={onDragMouseDown}
      />
      <div
        className="flex h-10 shrink-0 items-center justify-between bg-cc-surface/60 px-3 text-xs text-cc-muted"
        data-tauri-drag-region
        onMouseDown={onDragMouseDown}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-cc-foreground">{basename(change.path)}</span>
          <span className="min-w-0 truncate font-mono text-[10.5px] text-cc-muted/60">{change.path}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-[10.5px]">
            <span className="text-emerald-400">+{stats.added}</span>
            {" "}
            <span className="text-red-400">−{stats.removed}</span>
          </span>
          {!deleted ? (
            <button
              className="flex h-6 w-6 items-center justify-center rounded text-cc-muted transition-colors duration-150 hover:bg-cc-surface-strong hover:text-cc-foreground"
              onClick={() => onOpenFile(change.path)}
              title="Open file in editor"
            >
              <Pencil size={13} />
            </button>
          ) : null}
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-cc-muted transition-colors duration-150 hover:bg-cc-surface-strong hover:text-cc-foreground"
            onClick={() => setDiff(null)}
            title="Refresh diff"
          >
            {diff === null && !error ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-cc-muted transition-colors duration-150 hover:bg-cc-surface-strong hover:text-cc-foreground"
            onClick={onClose}
            title="Close diff"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-3">
        {error ? (
          <div className="mx-4 rounded-md border border-red-400/20 bg-red-400/10 p-3 text-xs text-red-100">{error}</div>
        ) : diff === null ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-cc-muted">
            <Loader2 size={14} className="animate-spin" />
            Loading diff
          </div>
        ) : diff.trim() === "" ? (
          <div className="mx-4 rounded-md bg-cc-surface/60 p-3 text-xs text-cc-muted">
            No textual diff (binary file or identical content).
          </div>
        ) : (
          <pre className="min-w-full font-mono text-[12px] leading-[1.55]">
            {lines.map((line, index) => (
              <div key={index} className={`whitespace-pre px-4 ${diffLineClass(line.kind)}`}>
                {line.text || " "}
              </div>
            ))}
          </pre>
        )}
      </div>
    </aside>
  );
}

function classifyDiffLine(text: string): { kind: DiffLineKind; text: string } {
  if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ")
    || text.startsWith("new file") || text.startsWith("deleted file") || text.startsWith("similarity ")
    || text.startsWith("rename ") || text.startsWith("old mode") || text.startsWith("new mode")) {
    return { kind: "meta", text };
  }
  if (text.startsWith("@@")) return { kind: "hunk", text };
  if (text.startsWith("+")) return { kind: "add", text };
  if (text.startsWith("-")) return { kind: "del", text };
  return { kind: "context", text };
}

function diffLineClass(kind: DiffLineKind) {
  if (kind === "add") return "bg-emerald-400/10 text-emerald-100";
  if (kind === "del") return "bg-red-400/10 text-red-100/90";
  if (kind === "hunk") return "mt-2 text-cc-accent/90";
  if (kind === "meta") return "text-cc-muted/50";
  return "text-cc-muted";
}

function basename(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}
