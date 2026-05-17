import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import type { SogoTab } from "@/types";

interface TabStripProps {
  tabs: SogoTab[];
  activeTabId?: string;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onNewTab: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, label: string) => void;
}

const statusClass: Record<SogoTab["status"], string> = {
  idle: "bg-emerald-400",
  busy: "bg-sky-400",
  "awaiting-input": "bg-amber-300",
  stopped: "bg-cc-muted",
  error: "bg-red-400",
};

export function TabStrip({ tabs, activeTabId, collapsed, onSelect, onNewTab, onClose, onRename }: TabStripProps) {
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editingTabId) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingTabId]);

  const beginRename = (tab: SogoTab) => {
    setEditingTabId(tab.id);
    setDraftLabel(tab.label);
  };

  const commitRename = () => {
    if (!editingTabId) return;
    const nextLabel = draftLabel.trim();
    if (nextLabel) {
      onRename(editingTabId, nextLabel);
    }
    setEditingTabId(null);
    setDraftLabel("");
  };

  const cancelRename = () => {
    setEditingTabId(null);
    setDraftLabel("");
  };

  if (collapsed) {
    return (
      <div className="flex h-8 items-center justify-between px-2">
        <button className="flex h-6 items-center gap-1 rounded-full px-2 text-xs text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground" onClick={onNewTab}>
          <Plus size={13} />
          New
        </button>
        <span className="text-xs text-cc-muted">{tabs.length} tabs</span>
      </div>
    );
  }

  return (
    <div className="flex h-10 items-center gap-1 px-2" data-tauri-drag-region>
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-3"
        style={{
          scrollbarWidth: "none",
          WebkitMaskImage: "linear-gradient(to right, black 0%, black calc(100% - 36px), transparent 100%)",
          maskImage: "linear-gradient(to right, black 0%, black calc(100% - 36px), transparent 100%)",
        }}
      >
        {tabs.map((tab) => {
          const editing = editingTabId === tab.id;

          return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={tab.id === activeTabId}
            className={`group flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-left text-xs transition ${
              tab.id === activeTabId
                ? "border-cc-border bg-cc-surface-strong text-cc-foreground"
                : "border-transparent text-cc-muted hover:bg-cc-surface-strong/60 hover:text-cc-foreground"
            }`}
            onClick={() => onSelect(tab.id)}
            onDoubleClick={() => beginRename(tab)}
            onKeyDown={(event) => {
              if (editing) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(tab.id);
              }
              if (event.key === "F2") {
                event.preventDefault();
                beginRename(tab);
              }
            }}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusClass[tab.status]}`} />
            {editing ? (
              <input
                ref={inputRef}
                className="h-5 min-w-0 flex-1 rounded bg-cc-background/60 px-1 text-xs text-cc-foreground outline-none ring-1 ring-cc-accent"
                value={draftLabel}
                onChange={(event) => setDraftLabel(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
                aria-label={`Rename ${tab.label}`}
              />
            ) : (
              <span className="min-w-0 truncate" title="Double-click to rename">{tab.label}</span>
            )}
            <button
              type="button"
              className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full opacity-30 transition-opacity hover:bg-cc-background/20 hover:opacity-100 group-hover:opacity-60"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
              aria-label={`Close ${tab.label}`}
            >
              <X size={13} />
            </button>
          </div>
          );
        })}
      </div>
      <button
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-cc-muted transition-colors duration-150 hover:bg-cc-surface-strong hover:text-cc-foreground"
        onClick={onNewTab}
        title="New session"
      >
        <Plus size={15} />
      </button>
    </div>
  );
}
