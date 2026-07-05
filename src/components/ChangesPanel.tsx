import { useEffect } from "react";
import { GitBranch, RefreshCw } from "lucide-react";

import { useGitStore } from "@/stores/gitStore";
import type { GitChange } from "@/types";

interface ChangesPanelProps {
  sessionId: string;
  folderChosen: boolean;
  activeDiffPath?: string | null;
  onOpenDiff: (change: GitChange) => void;
}

const STATUS_LABEL: Record<string, string> = {
  "?": "new",
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflict",
};

export function ChangesPanel({ sessionId, folderChosen, activeDiffPath, onOpenDiff }: ChangesPanelProps) {
  const state = useGitStore((store) => store.bySession[sessionId]);
  const refresh = useGitStore((store) => store.refresh);

  useEffect(() => {
    if (sessionId && folderChosen) void refresh(sessionId);
  }, [sessionId, folderChosen, refresh]);

  if (!folderChosen) {
    return (
      <section className="flex min-h-0 flex-1 flex-col items-center justify-center bg-cc-surface p-6 text-center">
        <p className="text-xs text-cc-muted">Open a folder session to see git changes.</p>
      </section>
    );
  }

  const changes = state?.changes ?? [];

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-cc-surface">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <h2 className="text-sm font-semibold">Changes</h2>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] tabular-nums text-cc-muted">{changes.length}</span>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md text-cc-muted transition-colors duration-150 hover:bg-cc-surface-strong hover:text-cc-foreground"
            onClick={() => void refresh(sessionId)}
            title="Refresh changes"
          >
            <RefreshCw size={13} className={state?.loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {state && !state.isRepo ? (
          <div className="m-3 rounded-md bg-cc-background/40 p-3 text-xs leading-5 text-cc-muted">
            <GitBranch size={13} className="mb-1.5" />
            This folder is not a git repository.
          </div>
        ) : changes.length === 0 ? (
          <div className="m-3 rounded-md bg-cc-background/40 p-3 text-xs leading-5 text-cc-muted">
            {state?.loading ? "Checking working tree…" : "Working tree clean. Claude's edits will show up here."}
          </div>
        ) : (
          changes.map((change) => {
            const isActive = activeDiffPath === change.path;
            const statusChar = primaryStatusChar(change.status);

            return (
              <button
                key={`${change.status}:${change.path}`}
                className={`flex w-full items-center gap-2 px-3 py-[3px] text-left text-xs transition-colors duration-150 hover:bg-cc-surface-strong ${
                  isActive ? "bg-cc-surface-strong" : ""
                }`}
                onClick={() => onOpenDiff(change)}
                title={`${STATUS_LABEL[statusChar] ?? change.status} — ${change.path}`}
              >
                <span className={`w-3.5 shrink-0 text-center font-mono text-[10.5px] ${statusColor(statusChar)}`}>
                  {statusChar}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate ${isActive ? "text-cc-foreground" : "text-cc-muted"}`}
                  dir="rtl"
                >
                  <span style={{ direction: "ltr", unicodeBidi: "embed" }}>{change.path}</span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

function primaryStatusChar(status: string) {
  const trimmed = status.trim();
  if (!trimmed) return "M";
  return trimmed[0] === "?" ? "?" : trimmed[0];
}

function statusColor(statusChar: string) {
  if (statusChar === "?" || statusChar === "A") return "text-emerald-400";
  if (statusChar === "D") return "text-red-400";
  if (statusChar === "R" || statusChar === "C") return "text-sky-400";
  if (statusChar === "U") return "text-amber-300";
  return "text-amber-200/80";
}
